/**
 * `async_wait_agent` 工具：有界的子代理等待，可被可处理消息唤醒（设计 §2/§3.4）。
 *
 * - 屏障：`listChildren()` 先查一次，消除"订阅前已结束"的竞态；
 * - 入口注册表三态（设计 §3.4）：目录命中后查 `agents.get(agentId)`——`idle` 立即
 *   返回停止态结果，`undefined` 与"目录行消失"同档提前返回，查询抛错状态未证实；
 * - 权威信号：`source.kind === "subagent-settled"` 的结算通知与 `agent/status`
 *   转 idle；
 * - 唤醒信号：可处理消息（设计 §2.2 集合；`agent-message` 转达只用来提前重查状态）；
 * - 备用：定时轮询（注册表状态 + 目录行，设计 §3.4 双通道的轮询侧）。
 *
 * 单一总截止（设计 §2.1）：定时器在参数解析后立即武装；屏障重试睡眠取
 * `min(pollIntervalMs, deadline - now)`，剩余不正时按到期返回。屏障期间
 * 到达的用户消息、结算通知、迟到作答与调用取消都立即结束屏障（睡眠与
 * 信号竞速，每轮竞速前同步先查信号——需求 §2.1.2 的处理不等满剩余预算）。
 *
 * @module dsh-async-tools/wait-agent
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LOG_PREFIX, resolveWait } from './config.js';
import { buildToolText } from './descriptions.js';
import { classifyWake, preexistingWakeMessage, unclaimedLateSources, unclaimedSettlement, watchLateAnswer, watchSubagentActivity, watchWakeSignal } from './interrupts.js';
import { agentRecheckFailedNote, agentWaitAgainNote, escapeLogValue, interruptedNote, interruptedPreexistingNote, settledNote } from './output.js';
import { t } from './text.js';

/**
 * 查一次子代理列表，返回匹配条目（找不到返回 `null`，查询失败返回 `undefined`）。
 * 第四参透传 `AbortSignal`（签名现状）：等待被取消时在途查询随请求
 * 一起中止——`listChildren` 的拒绝被下面的 catch 收进 `undefined`（查询失败口径），
 * 不新增路径。
 */
async function childOf(ctx, parentId, agentId, signal) {
  try {
    const entries = await ctx.subagents.listChildren(parentId, signal);
    if (!Array.isArray(entries)) return undefined;
    // 行形状按查询入口分两种：`listChildren()` 返回父会话 `subagentCatalog`
    // 投影的条目 `{ id, createdAt, mode, label? }`——**没有 `kind` 字段**；带
    // `kind: 'child' | 'diagnostic'` 的判别联合是 `listDescendants()` 的输出
    // （`dsh-subagent/lib/types/index.d.ts:218` 与 `:234` 的返回类型不同）。
    // 因此判据是"`id` 相等且不是诊断行"，两种形状都命中；若按
    // `kind === 'child'` 过滤，`listChildren` 的行会全部被滤掉，屏障恒 not_found。
    // 诊断行（`kind: 'diagnostic'`）必须排除：它表示"这条子会话的投影
    // 读不出来"，没有 `label`，也**不是一个可用的子代理**；把它当正常子代理会让
    // `async_wait_agent` 进等待，而不是给出可纠错的 not_found。
    return entries.find((entry) => entry?.id === agentId && entry?.kind !== 'diagnostic') ?? null;
  } catch {
    return undefined;
  }
}

/**
 * 判定"还能不能继续观察到这个子代理在运行"。
 *
 * **本函数不作"已结束"的断言**（证据只支撑"不再观察到运行"，设计 §3.4）。
 *
 * ## `activity` 到底在哪一行上
 *
 * `activity` **不在** `listChildren()` 的返回行里：`listChildren()` 返回父会话
 * `subagentCatalog` 投影的条目 `{ id, createdAt, mode, label? }`
 * （`@deepseek-ai/dsh-subagent/lib/index.js:2072-2083`、
 * `lib/types/projection-types.d.ts:8-20`）。带 `activity` 的是**另一条路径**
 * `listDescendants()` 的判别联合行：`childRow()`（`:2297`）在**有活 reader** 时写死
 * `"running"`（`:2190`），**走冷读**时写死 `"inactive"`（`:2261`）。
 * 所以 `activity` 分支只在行形状确实带该字段时（换用 `listDescendants`）
 * 才可能命中；`listChildren` 路径上它不命中，判定退化为"条目不在列表里"。
 *
 * 无论哪种形状，非 `running` 的含义都只是"**不再观察到它在运行**"，
 * **不是**"这个子代理结束了"：`running` 只表示"这一行有活的投影"，
 * 一个已结算但仍驻留的可续子代理照样读作 `running`。
 *
 * 因此这些证据只用来**提前结束等待**，说明停留在"不再观察到它在运行"，
 * 而不是"它已结束"。真正权威的结束信号仍是结算通知与 `agent/status` 转 idle。
 *
 * **`undefined`（列表查询失败）与 `null` 必须分开**：查询失败什么也证明不了，
 * 把它当成"结束"就是工具在宿主出错时对模型撒谎。
 *
 * @param {object|null|undefined} entry - `childOf()` 的返回值。
 * @returns {{ inactive: boolean, detail: string }} 判定与可读说明。
 */
function inactiveVerdict(entry, lang = 'en') {
  if (entry === undefined) return { inactive: false, detail: '' };
  if (entry === null) {
    return { inactive: true, detail: t(lang, 'verdict.goneFromList') };
  }
  const activity = entry.activity;
  if (typeof activity === 'string' && activity !== 'running') {
    return {
      inactive: true,
      // 措辞必须停在"观察到什么"，不能替宿主下"它结束了"的结论。
      detail: t(lang, 'verdict.notRunning', { activity })
    };
  }
  return { inactive: false, detail: '' };
}

/**
 * 把一行子代理写成纠错清单里的一项。
 *
 * 两种行形状都要能写：catalog 行有 `mode`、没有 `activity`；
 * 判别联合（`listDescendants()`）行相反。诊断行写 `reason`——那是给模型的
 * 可纠错信息（`unavailable` = 暂时读不到，`corrupt` = 这条投影坏了）。
 *
 * @param {object} entry - `listChildren()` 的一行。
 * @param {string} lang - 模型侧语言（`en` / `zh`）。
 * @returns {string} 形如 `"<id> (label, mode=continuable)"`。
 */
function describeEntry(entry, lang) {
  if (entry?.kind === 'diagnostic') {
    return t(lang, 'list.diagnostic', {
      id: String(entry.id),
      reason: typeof entry.reason === 'string' ? entry.reason : '?'
    });
  }
  const label = typeof entry?.label === 'string' ? entry.label : '?';
  const state = typeof entry?.activity === 'string'
    ? entry.activity
    : (typeof entry?.mode === 'string' ? `mode=${entry.mode}` : '?');
  return `${entry?.id} (${label}, ${state})`;
}

/**
 * 列出已知子代理，供 not_found 时纠错。
 *
 * **不按 `kind` 过滤**：`listChildren()` 的 catalog 行没有 `kind` 字段，按
 * `kind === 'child'` 过滤会让清单恒空——报错长成
 * `Known children:` 后面什么都没有，模型拿不到任何可纠错信息。
 * 诊断行不再丢弃，改写 `reason`（初衷是"别把诊断行当子代理"，
 * 不是"别告诉模型"）。
 */
async function knownChildren(ctx, parentId, lang, signal) {
  try {
    const entries = await ctx.subagents.listChildren(parentId, signal);
    if (!Array.isArray(entries)) return [];
    return entries.map((entry) => describeEntry(entry, lang));
  } catch {
    return [];
  }
}

/**
 * 存在屏障的有界重试次数（1 次立即查询 + 3 次重试）。
 *
 * 重试容忍的是"子代理刚派发那一刻"的目录投影刷新窗口（目录事件由加载器在派发时追加到
 * 父会话，父会话有活 reader，正常即时可见）。**不是**等冷读暖机——那条推断
 * 不成立：`listChildren()` 只读父会话的 catalog 投影，不冷读任何子会话。
 * not_found 是"这个 id 不存在"的断言，一次查空不足以证明它——按 `pollIntervalMs`
 * 有界重试后再下结论。真不存在的 id 只多花几秒；误报 not_found 会把模型引向重新派发。
 */
const BARRIER_ATTEMPTS = 4;

/**
 * 复查被总预算切断的哨兵值（`boundedChildOf` 的到期竞速分支）。与查询失败
 * （`undefined`）分开：前者是"预算用尽、没等到查询"，后者是"查询本身抛错"——
 * 收敛处按不同口径消费（需求 §2.1.1/§2.2.2）。
 */
const BUDGET_CUT = Symbol('async-tools: budget-cut');

/**
 * 单调时钟（设计 §2.1 单一总截止的计时基）：t0、deadline、waited_ms 全走它，
 * 墙钟（Date.now）的回拨/跳变不得进入预算与读数（需求 §2.1.3 不冒充时长）。
 */
const monotonic = () => performance.now();

/**
 * 用宿主定时器睡一段（屏障重试的间隔；走 `ctx.timer` 是为了让测试可控）。
 * 返回可撤销的睡眠：调用方把 `promise` 与唤醒/取消/到期信号竞速，信号先到
 * 就 `cancel()` 撤拍——睡眠不得让消息和取消的处理等满剩余预算（需求 §2.1.2）。
 * @param {object} ctx - cordis 上下文。
 * @param {number} ms - 间隔。
 * @returns {{promise: Promise<'slept'>, cancel: Function}} 睡眠与撤销句柄。
 */
function barrierSleep(ctx, ms) {
  let cancel;
  const promise = new Promise((resolve) => {
    cancel = ctx.timer.timeout(() => resolve('slept'), ms);
  });
  return { promise, cancel };
}

/**
 * 查公开 Agent 注册表的当前运行状态（设计 §3.4，`agents.get(id)`）。
 *
 * 四态：`'running'`（驻留且驱动在运行）｜`'idle'`（驻留但当前无驱动）｜
 * `'absent'`（注册表无驻留——与目录行消失同档：不再观察到它在运行，不据此
 * 宣称终结）｜`'unknown'`（查询抛错或服务缺席——状态未证实，不制造 not-found
 * 也不制造停止态）。目录条目只证明会话存在过，注册表驻留才证明当前有驱动；
 * 两者分开消费。`agents` 是固定依赖（`lib/index.js` 的 inject），缺席只发生在
 * 测试替身里——按未证实处理，轮询退回目录行通道。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {string} agentId - 被等待的子代理 id。
 * @returns {'running'|'idle'|'absent'|'unknown'} 注册表观察结果。
 */
function agentStatusOf(ctx, agentId) {
  if (ctx?.agents === undefined || ctx?.agents === null) return 'unknown';
  try {
    const found = ctx.agents.get(agentId);
    if (found === undefined || found === null) return 'absent';
    return found.status === 'running' ? 'running' : 'idle';
  } catch {
    return 'unknown';
  }
}

/**
 * 构造 `async_wait_agent` 工具定义。
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - 生效配置。
 * @returns {object} ToolDefinition。
 */
export function createWaitAgentTool(ctx, config) {
  // 描述经 `buildToolText` 整段构建（构造处与刷新处同一份）。
  const rebuildText = (cfg) => buildToolText('async_wait_agent', cfg);
  const text = rebuildText(config);
  const tool = defineTool({
    name: 'async_wait_agent',
    description: text.description,
    parameters: text.parameters,
    output: {
      schema: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            agent_id: { type: 'string', required: true },
            waited_ms: { type: 'number', required: true },
            note: { type: 'string', required: true }
          }
        }, {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true, const: 'not_found' },
            agent_id: { type: 'string', required: true },
            known_children: { type: 'array', required: true, items: { type: 'string' } }
          }
        }]
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'not_found'
          ? t(config.agentLang, 'render.notFound', { agentId: value.agent_id, children: value.known_children.join('\n') })
          : value.note
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const lang = config.agentLang;
      const agent = exec.agent;
      const parentId = agent?.id;
      const agentId = args.agent_id;

      const interruptedOutcome = (waitedMs) => ({
        status: 'interrupted',
        agent_id: agentId,
        waited_ms: waitedMs,
        note: interruptedNote({
          lang,
          subject: `subagent ${agentId}`,
          waitedMs,
          resume: `async_wait_agent(agent_id="${agentId}", wait_ms=...)`
        })
      });

      // 入口已中止的调用直接回 interrupted——不订阅、不进屏障、不武装预算、
      // 不发任何查询。AbortSignal 已中止后挂监听器永不触发，不短路的话这条
      // 调用会等满预算才以 running 收场（对模型撒谎，还白占一次并发位）。
      if (exec.signal?.aborted) return interruptedOutcome(0);

      const waitMs = resolveWait(args.wait_ms, config);
      const t0 = monotonic();
      // 设计 §2.1 单一总截止：参数解析后立即武装一次，起点即 t0；起始扫描、存在屏障、
      // 等待段全部发生在武装之后，中途不重置 t0。计时走单调时钟（见 monotonic）。
      const deadlineAt = t0 + waitMs;
      const elapsed = () => Math.max(0, Math.round(monotonic() - t0));

      // 先订阅、后扫描与屏障（设计 §2.1/§2.2）：结算通知与状态转换**只发生一次**，
      //   若先查状态再订阅，子代理恰好在两者之间结束就会白等满整个预算；
      //   订阅与先到扫描之间没有空窗（同步段）。
      // 接线段整体入 try/catch（与 `async_wait_job` 的接线纪律同款）：任一资源
      // 建立步同步抛错时，此前已建立的订阅/监听/定时器必须先撤销再抛（需求
      // §6.2 初始化撤销）——主流程的 finally 管不到接线段。声明提前，回退带
      // 空值护栏。
      let interrupt = null;
      let wakeSignal;
      let lateWatch = null;
      let lateSignal;
      let activity = null;
      let abort = null;
      let deadlineCtl = null;
      let execWired = false;
      let onExecAbort = null;
      let deadlineTimer;
      let aborted;
      let deadline;
      try {
        interrupt = watchWakeSignal(ctx, agent);
        // 竞速的每个分支都必须是 `{ name }` 形状，否则胜出者会缺少 `name` 而落到回退分支。
        // `via` 区分 user（interrupted 口径）与 notice/relay（运行句柄＋唤醒原因，设计 §2.2）。
        wakeSignal = interrupt.promise.then((signal) => ({
          name: 'wake', via: signal.via, summary: signal.summary
        }));
        // 专门通道：本包迟到作答到达（插件事件 + 起始检查，watchLateAnswer）→
        // 提前返回运行句柄 + note——不误报 settled，控制权交还模型去消费通知
        // （等待期间到达的作答不空转预算）。
        lateWatch = watchLateAnswer(ctx, agent);
        lateSignal = lateWatch.promise.then((signal) => ({
          name: 'late-answer', summary: signal.summary
        }));
        activity = watchSubagentActivity(ctx, agent, agentId);

        abort = new AbortController();
        deadlineCtl = new AbortController();
        // 工具取消同时落两个控制器：`abort` 驱动竞速的 aborted 分支（工具取消口径），
        // `deadlineCtl` 只服务**在途查询的取消**——把取消传给还没返回的宿主查询，
        // 让"交回控制权"不必等查询自然完成（需求 §2.1.1：准备查询阶段同样及时交回）。
        onExecAbort = () => {
          deadlineCtl.abort(exec.signal?.reason);
          abort.abort(exec.signal?.reason);
        };
        if (exec.signal !== undefined) {
          exec.signal.addEventListener('abort', onExecAbort, { once: true });
          execWired = true;
        }
        aborted = new Promise((_resolve, reject) => {
          abort.signal.addEventListener(
            'abort',
            () => reject(abort.signal.reason ?? new Error('aborted')),
            { once: true }
          );
        });
        // 这个 promise 只可能 reject。三层防线保证它不会变成未处理拒绝：
        // ① 入口短路让"进 execute 时就已中止"的调用根本走不到这里；
        // ② 创建点同步挂的 no-op catch 承接**屏障窗口**——reject 可能发生在第一个
        //    `await childOf` 之后、竞速候选组装（下面 `candidates`）之前，期间长达
        //    3×pollIntervalMs，宿主 installFailLoud 语义下无人接住的 reject 就是
        //    整实例退出；no-op 分支只标记"已处理"，不影响竞速稍后读到它；
        // ③ 竞速挂接后由 `Promise.race` 自带的 reject 处理接住——race 给每个成员
        //    同时挂 resolve 与 reject 两个 handler，但这不等于"race 消费了它"，
        //    换成手写 `await` 循环会立刻丢掉这条性质。
        aborted.catch(() => {});

        // 总截止定时器（设计 §2.1：参数解析后立即武装；cleanup 处置）。到期同时落
        // `deadlineCtl`——把截止信号传入此后一切在途目录查询（`listChildren` 支持
        // AbortSignal 取消，设计 §2.1"将调用取消和截止信号传入并与消息/到期竞速"）。
        deadline = new Promise((resolve) => {
          deadlineTimer = ctx.timer.timeout(() => {
            deadlineCtl.abort(new Error('total budget exhausted'));
            resolve({ name: 'deadline' });
          }, waitMs);
        });
      } catch (error) {
        // 初始化撤销（需求 §6.2）：撤销已建立的资源后原样上抛——无泄漏的插件
        // 订阅、无残留监听与定时器，作业本就未注册。
        interrupt?.dispose();
        lateWatch?.dispose();
        activity?.dispose();
        if (execWired) exec.signal.removeEventListener('abort', onExecAbort);
        if (typeof deadlineTimer === 'function') deadlineTimer();
        throw error;
      }

      const cleanup = () => {
        interrupt.dispose();
        lateWatch.dispose();
        activity.dispose();
        if (exec.signal !== undefined) exec.signal.removeEventListener('abort', onExecAbort);
        if (typeof deadlineTimer === 'function') deadlineTimer();
      };
      // 查询用合并信号：工具取消 ∨ 总截止。到期后再发起的查询拿到已中止的信号，
      // 宿主良好时立即拒绝、`childOf` 收进 `undefined`（查询失败口径）。
      const probeSignals = [exec.signal, deadlineCtl.signal].filter((s) => s !== undefined);
      const probeSignal = probeSignals.length === 0 ? undefined
        : probeSignals.length === 1 ? probeSignals[0]
          : typeof AbortSignal.any === 'function' ? AbortSignal.any(probeSignals)
            : probeSignals[0];
      // **不依赖宿主是否尊重信号**的双保险：任何主流程 `await` 的目录查询都与
      // 总截止竞速——到期先到就把这次查询当"没观察到"（BUDGET_CUT）放行，交回
      // 控制权不等查询自然完成（需求 §2.1"到期后不无界 await 复查或错误清单
      // 查询"）。宿主忽略信号时这条竞速仍封住时间界。切断（BUDGET_CUT）与查询
      // 失败（undefined）在收敛处分开消费：前者是预算口径，后者不得冒充观察结果。
      const boundedChildOf = () => Promise.race([
        childOf(ctx, parentId, agentId, probeSignal),
        deadline.then(() => BUDGET_CUT)
      ]);

      /**
       * 屏障期的同步信号预检（需求 §2.1.2）：取消、先到结算通知、可处理消息、
       * 迟到作答按入口检查同款优先级返回切断标签；读取失败按未命中（宁可多等，
       * 不可错打断）。存在屏障的每轮竞速前与 not_found 出口前都先过这道——
       * 微任务次序（快速目录查询压过已解析的唤醒信号）不得决定"已到信号能否
       * 被看见"。
       */
      const pendingSignal = () => {
        if (abort.signal.aborted) return 'cut-abort';
        if (unclaimedSettlement(agent, agentId) !== null) return 'cut-settled';
        const wake = classifyWake(preexistingWakeMessage(agent));
        if (wake !== null && wake.via === 'user') return 'cut-user';
        let lateSources = [];
        try {
          lateSources = unclaimedLateSources(agent);
        } catch { /* getter 抛错按未命中——与入口检查同向 */ }
        if (lateSources.length > 0) return 'cut-late';
        if (wake !== null) return 'cut-wake';
        return null;
      };

      try {
        // 起始检查（设计 §2.2，订阅之后无空窗）：等待开始前已到达的信号立即交回。
        // 优先级：未领取的权威结算通知（unclaimedSettlement——结束优先于一切
        // 唤醒，比列表复查强：已结算仍驻留的子代理列表读作 running）→ user
        // 插话 interrupted → 本包迟到作答（专门分支）lateArrived → 其余
        // notice/relay 运行句柄＋唤醒原因。不进存在屏障——先到消息不得为
        // 屏障重试排队。
        if (unclaimedSettlement(agent, agentId) !== null) {
          return {
            status: 'settled',
            agent_id: agentId,
            waited_ms: elapsed(),
            note: `${t(lang, 'via.noticePreexisting')}${settledNote({ lang, agentId })}`
          };
        }
        const earlyWake = classifyWake(preexistingWakeMessage(agent));
        if (earlyWake !== null && earlyWake.via === 'user') {
          return {
            status: 'interrupted',
            agent_id: agentId,
            waited_ms: elapsed(),
            note: interruptedPreexistingNote({
              lang,
              subject: `subagent ${agentId}`,
              resume: `async_wait_agent(agent_id="${agentId}", wait_ms=...)`
            })
          };
        }
        // 入口检查的 late／wake 运行句柄同受未证实纪律（需求 §2.2.2）约束：这两条
        // 路径不进存在屏障、没有目录证据，运行状态只剩注册表现读——读到才说
        // 「尚未结束」，读不到（unknown）换未证实文案给重试出路。
        const entryWaitNote = () => (agentStatusOf(ctx, agentId) === 'unknown'
          ? agentRecheckFailedNote({ lang, agentId, waitedMs: elapsed(), maxWaitMs: config.maxWaitMs })
          : agentWaitAgainNote({ lang, agentId, waitedMs: elapsed(), maxWaitMs: config.maxWaitMs }));
        let earlyLate = [];
        try {
          earlyLate = unclaimedLateSources(agent);
        } catch { /* getter 抛错按无先到——宁可多等一轮（与 watchLateAnswer 同向） */ }
        if (earlyLate.length > 0) {
          return {
            status: 'running',
            agent_id: agentId,
            waited_ms: elapsed(),
            note: `${t(lang, 'wait.lateArrived', { summary: earlyLate[0].summary })} ${entryWaitNote()}`
          };
        }
        if (earlyWake !== null) {
          return {
            status: 'running',
            agent_id: agentId,
            waited_ms: elapsed(),
            note: `${t(lang, 'wait.wokeByMessage', { summary: earlyWake.summary })} ${entryWaitNote()}`
          };
        }

        // 屏障：确认这个子代理确实存在（`activity` 字段不能用来判断"是否结束"）。
        // 查空不立即定罪：先有界重试（见 BARRIER_ATTEMPTS 的依据），派发瞬间的
        // 目录投影刷新窗口内的行会在重试中出现；`undefined`（查询失败）仍立即
        // 抛错，不重试。设计 §2.1：重试睡眠取 `min(pollIntervalMs, deadline - now)`，
        // 剩余不正时按到期返回——屏障段计入总预算，不重取全额。
        //
        // 信号纪律（需求 §2.1.2，屏障段不豁免）：① 每轮竞速前先 `pendingSignal()`
        // 同步预检——目录查询是同步投影读、一个微任务就结算，已解析的唤醒信号
        // 在 `Promise.race` 里稳定输给它（构造序挂回调），不同步预检就会把"已到
        // 的消息/取消"一直压到循环尽头、以 not_found 谎报收场；② 竞速成员含
        // `aborted`（mapped：rejection 归一成标签）——取消在查询在途时也能立即
        // 切断；③ 重试睡眠与四类信号竞速，信号先到即撤拍——消息和取消的处理
        // 不能等满剩余预算；④ `activity.settled` 同入竞速——结算通知在屏障期
        // 到达时按完成优先直接交回。
        let known;
        let barrierCut = null;
        for (let attempt = 1; ; attempt++) {
          barrierCut = pendingSignal();
          if (barrierCut !== null) {
            known = undefined;
            break;
          }
          if (deadlineAt - monotonic() <= 0) {
            barrierCut = 'cut-deadline';
            known = undefined;
            break;
          }
          known = await Promise.race([
            childOf(ctx, parentId, agentId, probeSignal),
            deadline.then(() => 'cut-deadline'),
            interrupt.promise.then(() => 'cut-wake'),
            lateWatch.promise.then(() => 'cut-late'),
            activity.settled.then(() => 'cut-settled'),
            aborted.then(() => 'cut-abort', () => 'cut-abort')
          ]);
          if (typeof known === 'string') {
            barrierCut = known;
            known = undefined;
            break;
          }
          if (known !== null || attempt >= BARRIER_ATTEMPTS) break;
          const remaining = deadlineAt - monotonic();
          if (remaining <= 0) {
            barrierCut = 'cut-deadline';
            break;
          }
          const nap = barrierSleep(ctx, Math.min(config.pollIntervalMs, remaining));
          const early = await Promise.race([
            nap.promise,
            interrupt.promise.then(() => 'cut-wake'),
            lateWatch.promise.then(() => 'cut-late'),
            activity.settled.then(() => 'cut-settled'),
            aborted.then(() => 'cut-abort', () => 'cut-abort'),
            deadline.then(() => 'cut-deadline')
          ]);
          if (early !== 'slept') {
            nap.cancel();
            barrierCut = early;
            known = undefined;
            break;
          }
        }
        // 屏障切断的出口（存在性未定）：切断不得报 listingUnavailable（那是查询
        // 失败的口径）也不得报 not_found（存在性未证伪）——按入口检查同款优先级
        // 交回：取消 → interrupted；结算通知（完成优先）→ settled；user 插话 →
        // interrupted；迟到作答与其余 notice/relay → 运行句柄＋唤醒原因。
        // cut-deadline 时状态未证实（屏障没确认过任何东西），用未证实文案，
        // 不宣称"尚未结束"（需求 §2.2.2）。
        const unverifiedOutcome = () => ({
          status: 'running',
          agent_id: agentId,
          waited_ms: elapsed(),
          note: agentRecheckFailedNote({ lang, agentId, waitedMs: elapsed(), maxWaitMs: config.maxWaitMs })
        });
        const barrierExit = (cut) => {
          if (cut === 'cut-abort') return interruptedOutcome(elapsed());
          if (cut === 'cut-deadline') return unverifiedOutcome();
          // 完成优先（设计 §2.2）：未领取的权威结算通知在场 → settled——无论
          // 切断标签来自哪条信号（结算通知同时是 notice 唤醒源）。
          if (unclaimedSettlement(agent, agentId) !== null) {
            return {
              status: 'settled',
              agent_id: agentId,
              waited_ms: elapsed(),
              note: `${t(lang, 'via.noticePreexisting')}${settledNote({ lang, agentId })}`
            };
          }
          // 其余切断按扫描重分类（读取失败按未命中回退）：拿到 via/summary 再
          // 交回，与入口检查的分支同形。user 插话 → interrupted；notice/relay →
          // 运行句柄＋唤醒原因；迟到作答 → 运行句柄＋lateArrived。屏障未确认过
          // 目标存在，运行句柄一律带未证实口径，不宣称"尚未结束"（需求 §2.2.2）。
          let lateSources = [];
          try {
            lateSources = unclaimedLateSources(agent);
          } catch { /* getter 抛错按无先到 */ }
          const wake = classifyWake(preexistingWakeMessage(agent));
          const waited = elapsed();
          const unverifiedNote = agentRecheckFailedNote({
            lang, agentId, waitedMs: waited, maxWaitMs: config.maxWaitMs
          });
          if (wake !== null && wake.via === 'user') {
            return {
              status: 'interrupted',
              agent_id: agentId,
              waited_ms: waited,
              note: interruptedPreexistingNote({
                lang,
                subject: `subagent ${agentId}`,
                resume: `async_wait_agent(agent_id="${agentId}", wait_ms=...)`
              })
            };
          }
          if (wake !== null) {
            return {
              status: 'running',
              agent_id: agentId,
              waited_ms: waited,
              note: `${t(lang, 'wait.wokeByMessage', { summary: wake.summary })} ${unverifiedNote}`
            };
          }
          if (lateSources.length > 0) {
            return {
              status: 'running',
              agent_id: agentId,
              waited_ms: waited,
              note: `${t(lang, 'wait.lateArrived', { summary: lateSources[0].summary })} ${unverifiedNote}`
            };
          }
          // 信号 promise 已解析但同步扫描读不到（getter 抛错被承接的窗口）：
          // 状态未证实，用未证实文案交回，不冒充观察结果。
          return unverifiedOutcome();
        };
        if (barrierCut !== null) {
          return barrierExit(barrierCut);
        }
        if (known === undefined && deadlineAt - monotonic() <= 0) {
          // 查询失败且预算已尽：状态未证实——不宣称"尚未结束"（需求 §2.2.2）。
          return unverifiedOutcome();
        }
        if (known === undefined) {
          throw new Error(t(lang, 'error.listingUnavailable'));
        }
        if (known === null) {
          // not_found 出口前的最后复核（需求 §2.1.2）：最后一轮查询赢得竞速时，
          // 消息/取消可能已被压在后面——重试耗尽不等于可以无视已到信号；
          // 命中即按切断出口同款交回，不把已到消息谎报成 not_found。
          const lastSignal = pendingSignal();
          if (lastSignal !== null) {
            return barrierExit(lastSignal);
          }
          return {
            status: 'not_found',
            agent_id: agentId,
            // 错误清单查询同样与总截止竞速（设计 §2.1"到期后不无界 await 错误清单查询"），
            // 到期先到按空清单放行——not_found 的主断言已由重试确认，清单只是纠错线索。
            known_children: await Promise.race([
              knownChildren(ctx, parentId, lang, probeSignal),
              deadline.then(() => [])
            ])
          };
        }
        const label = typeof known?.label === 'string' ? ` (${known.label})` : '';

        const settledOutcome = (detail) => ({
          status: 'settled',
          agent_id: agentId,
          waited_ms: elapsed(),
          note: `${detail}${settledNote({ lang, agentId })}`
        });

        // 入口注册表三态（设计 §3.4，目录命中之后查 `agents.get(agentId)`）：
        // `idle` → 目标当前无驱动，立即返回停止态结果（说明停在"状态转为 idle"，
        // 不空等、不冒称成功）；`absent` → 注册表无驻留，与目录行消失同档提前
        // 返回（不据此宣称终结）；`unknown`（查询抛错/服务缺席）→ 状态未证实，
        // 不制造 not-found 也不制造停止态，进等待。这一条补上"已停止目标入口
        // 直接交回"——事件通道（结算通知/状态转换）在等待开始前已发生过、
        // 不会再来，注册表现读是入口唯一的当次观察。
        const entryStatus = agentStatusOf(ctx, agentId);
        if (entryStatus === 'idle') {
          return settledOutcome(`${t(lang, 'via.idle')}${label}`);
        }
        if (entryStatus === 'absent') {
          return settledOutcome(`${t(lang, 'via.noResident')}${label}`);
        }

        // 屏障即终态（判别联合行形状防线）：列表明确读出不活跃（`activity`
        //   非 running 的判别联合行）就立即返回 settled。`activity === "running"`
        //   什么也证明不了——那部分由上面的注册表三态与等待通道承担。
        const barrierVerdict = inactiveVerdict(known, lang);
        if (barrierVerdict.inactive) {
          return settledOutcome(`${barrierVerdict.detail}${label}`);
        }

        // `settledSignal` 在映射的 then 里置位：目标结算通知同时是 notice 唤醒源，
        // 同一次投递里 wake 与 settled 双命中时竞速 tie-break 可能让 wake 先出线——
        // 出线后仍要能看到"权威结算信号其实已经到了"（置位发生在竞速续体之前：
        // 该 then 的注册早于 Promise.race 的内部 then）。完成优先的依据见下方
        // 竞速收敛后的分支。
        let settledSignal = null;
        const settled = activity.settled.then((signal) => {
          settledSignal = signal;
          return {
            name: 'settled',
            via: signal.via
          };
        });
        // 竞速的**每个**分支都必须是 `{ name }` 形状：`watchSubagentActivity` 的
        // 原始信号是 `{ kind }` 形状，直接参与竞速会因缺少 `name` 而落到回退分支。
        const relay = activity.activity.then(() => ({ name: 'activity' }));

        // 备用轮询（设计 §3.4 双通道的轮询侧）：每 tick 先查注册表状态（idle/absent
        // 命中即唤醒复查），再查目录行消失。查询失败不触发结束——注册表读取
        // 抛错与 `childOf` 的 `undefined` 同口径，只作"没观察到"。
        //
        // 串行纪律（设计 §2.1"在途查询逐次串行"）：用**自重排的 timeout 链**而不是
        // `interval`——`interval(async …)` 在回调耗时超过间隔时会叠加在途目录查询；
        // timeout 链保证上一轮查询结束后才排下一拍，慢查询自然
        // 拉长节奏而不叠加。首拍也等一个间隔（与 `interval` 的首个 tick 同拍相）。
        //
        // 幽灵链检查：tick 是 async（`await childOf` 是挂起点）——竞速由别的通道
        // 收敛、finally 撤拍之后，仍可能有一拍 tick 在途；它完成后续排的新拍必须
        // 被 `pollStopped` 旗标拦下，否则链自续到子代理结束，退出路径的资源纪律
        // （设计 §2.1）被破坏。aborted 同护：在途查询拒绝
        // 后 `childOf` 返回 `undefined`（≠ null），照样走到续排行——旗标先于
        // 一切续排判断。
        let pollStopped = false;
        let pollTimer;
        const polled = new Promise((resolve) => {
          const tick = async () => {
            if (pollStopped) return;
            const status = agentStatusOf(ctx, agentId);
            if (status === 'idle' || status === 'absent') {
              resolve({ name: 'polled' });
              return;
            }
            const entry = await childOf(ctx, parentId, agentId, probeSignal);
            if (pollStopped) return;
            if (entry === null) {
              resolve({ name: 'polled' });
              return;
            }
            pollTimer = ctx.timer.timeout(tick, config.pollIntervalMs);
          };
          pollTimer = ctx.timer.timeout(tick, config.pollIntervalMs);
        });

        let winner;
        try {
          // 循环竞速：`activity`（子代理转达消息）只表示"有进展，请重查状态"，
          // **不是结束信号**。若它胜出而子代理仍在运行，必须继续等剩余的通道，
          // 而不是把这次等待当成结束。
          //
          // 每个分支都解析为**自带 `name` 的对象**，因此胜出者就是解析值本身——
          // `Promise.race` 返回的是解析值而不是 promise 对象，用身份比较
          // （`promise === raced`）永远匹配不上，会静默落到回退分支。
          let candidates = [
            ['wake', wakeSignal],
            ['settled', settled],
            ['activity', relay],
            ['late-answer', lateSignal],
            ['polled', polled],
            ['deadline', deadline],
            ['aborted', aborted]
          ];
          for (;;) {
            const raced = await Promise.race(candidates.map(([, promise]) => promise));
            winner = raced && typeof raced.name === 'string' ? raced : { name: 'unknown' };
            if (winner.name !== 'activity') break;
            // 转达重查与总截止竞速：到期先到按"没观察到"放行，循环下一轮必然由
            // 已解析的 deadline 分支收敛——不占预算等查询。
            const latestForActivity = await boundedChildOf();
            // 转达消息只表示"有进展"，重查后仍读不到"不活跃"的证据就继续等其余通道。
            if (inactiveVerdict(latestForActivity, lang).inactive) {
              winner = { name: 'settled', via: 'activity-recheck' };
              break;
            }
            candidates = candidates.filter(([name]) => name !== 'activity');
            if (candidates.length === 0) break;
          }
        } finally {
          // 先置旗再撤拍：在途 tick 的续排检查先关上，然后撤销当前排定的那拍——
          // 反过来（先撤后置旗）会放进「撤拍后、置旗前」在途续排的幽灵链。
          pollStopped = true;
          if (typeof pollTimer === 'function') pollTimer();
        }

        const waitedMs = elapsed();

        // 竞速收敛后的复查：只作"事后确认"，**不能**当作屏障使用（屏障在更上面）。
        //
        // 注册表状态先行（设计 §3.4：唤醒胜出后复查 `agents.get`，已停止运行按目标
        // 结果返回，不依赖微任务时序）；目录复查随后——`listChildren()` 对
        // **活着的内存语料**一律写死 `"running"`，读到非 running 的值只能支持
        // "不再观察到它在运行"，不能升格成"它已结束"（设计 §3.4）；把"列表
        // 查询失败"（`undefined`）当成"已结束"同样会让工具对模型撒谎。
        // 复查与总截止竞速（`boundedChildOf`）：到期/唤醒收敛后查询只拿**剩余**
        // 预算，到期先到按"没观察到"放行——到期后不得再无界等诊断（需求 §2.1.1）。
        // **消息收敛不查目录**（设计 §2.1"消息的处理不能等满剩余预算"）：无结算信号时，
        // 目录复查对 wake／late-answer 收敛只是机会性升级（恰好读到 inactive 才把
        // running 改报 settled）；跳过的代价由下一次等待的入口三态承接（注册表与
        // 目录都是当次观察，再调一次立即交回）。结算收敛仍复查（弱证据复核需要），
        // 到期收敛受预算竞速约束。
        const resident = agentStatusOf(ctx, agentId);
        const userWon = winner.name === 'wake' && winner.via === 'user';
        const messageConverged = settledSignal === null && winner.name !== 'settled'
          && (winner.name === 'wake' || winner.name === 'late-answer');
        // 复查结果三态单独留在 `recheckRaw`（查询失败 `undefined` / 预算切断
        // `BUDGET_CUT` / 行对象或 `null`）：`inactiveVerdict` 只吃行形状，
        // 未观察到（失败与切断）都按"不活跃证据缺席"——但收敛文案要区分
        // "证实仍在运行"与"状态未证实"（需求 §2.2.2）。
        let recheckRaw = 'skipped';
        if (!messageConverged) {
          recheckRaw = await boundedChildOf();
        }
        const verdict = messageConverged
          ? { inactive: false }
          : inactiveVerdict(recheckRaw, lang);

        // 收敛路径（消息唤醒／迟到作答）的运行句柄文案分两档（需求 §2.2.2）：这些
        // 路径不做目录复查（见上），运行状态的证据只剩注册表现读——读到 running
        // 才证实「尚未结束」；读不到（unknown）时不得宣称，换未证实文案给重试出路。
        const convergedWaitNote = () => (resident === 'unknown'
          ? agentRecheckFailedNote({ lang, agentId, waitedMs, maxWaitMs: config.maxWaitMs })
          : agentWaitAgainNote({ lang, agentId, waitedMs, maxWaitMs: config.maxWaitMs }));

        // 结算分支分两档。`senderSessionId` 精确关联的 notice、`agent/status`
        // 转 idle、活动复查是**权威信号**，直返 settled——投影滞后会把"已结束"误读
        // 成 running，复查反而撒谎。**正文回退**匹配（`via: 'settlement-text'`，
        // 宿主旧投递形态的兼容路径）是弱证据：命中后必须复查到"不再观察到运行"才返回 settled，
        // 否则落 running（下一次等待仍走事件通道）——误报 settled 比多等一轮贵。
        //
        // 完成优先于唤醒（设计 §2.1，与 `async_wait_job` 的同名规则一致）：目标
        // 结算通知同时是 notice 唤醒源，同一次投递双命中时 wake 可能先出线——只要
        // `settledSignal` 已置位就按 settled 处理（via 取信号自身的），不让下面的
        // 注册表/目录复查在投影滞后窗口把"已结束"读回 running。
        const settledVia = settledSignal === null ? winner.via : settledSignal.via;
        if ((winner.name === 'settled' || settledSignal !== null)
          && (settledVia !== 'settlement-text' || verdict.inactive)) {
          const via = settledVia === 'agent-status-idle'
            ? t(lang, 'via.idle')
            : settledVia === 'activity-recheck'
              ? t(lang, 'via.recheck')
              : settledVia === 'settlement-text'
                ? t(lang, 'via.textFallback')
                : t(lang, 'via.notice');
          return settledOutcome(`${via}${label}`);
        }

        // 注册表复查（设计 §3.4）：idle（当前无驱动）或 absent（注册表无驻留——与
        // 目录行消失同档）→ 已停止运行按目标结果返回。结束优先于打断/超时
        // （与 `async_wait_job` 的"完成优先"同一条规则）。
        if (resident === 'idle' || resident === 'absent') {
          const via = resident === 'idle' ? t(lang, 'via.idle') : t(lang, 'via.noResident');
          const interruptedHint = userWon ? t(lang, 'note.agent.interruptedDuringSettle') : '';
          return settledOutcome(`${via}${interruptedHint}${label}`);
        }

        if (verdict.inactive) {
          const interruptedHint = userWon ? t(lang, 'note.agent.interruptedDuringSettle') : '';
          return settledOutcome(`${verdict.detail}${interruptedHint}${label}`);
        }

        if (userWon) {
          return interruptedOutcome(waitedMs);
        }

        // 唤醒交还（设计 §2.2 notice/relay 类）：运行句柄＋唤醒原因（不替宿主消费
        // 通知正文），保留 wait-again 提示。
        if (winner.name === 'wake') {
          return {
            status: 'running',
            agent_id: agentId,
            waited_ms: waitedMs,
            note: `${t(lang, 'wait.wokeByMessage', { summary: winner.summary ?? '' })} ${convergedWaitNote()}`
          };
        }

        // 唤醒交还（专门通道）：运行句柄 + 迟到作答 note（含 summary——题号与
        // 作答摘要在内；通知正文按状态走 followup/inject 通道，在下一领取点进入
        // 上下文，需求 §4.4）。保留 wait-again 提示，模型可选择继续等或先消费通知。
        // 信号源是插件事件 + 等待起始检查（watchLateAnswer）——
        // 作答先到、等待后开也能立即命中。
        if (winner.name === 'late-answer') {
          return {
            status: 'running',
            agent_id: agentId,
            waited_ms: waitedMs,
            note: `${t(lang, 'wait.lateArrived', { summary: winner.summary ?? '' })} ${convergedWaitNote()}`
          };
        }

        // 回退分支：预算到期或等待被撤销。文案分两档——复查查询成功**且**注册表
        // 现读证实仍活跃（running）时说"尚未结束，可再次 async_wait_agent"；
        // 复查查询失败，或注册表读不到当前状态（unknown——目录行在场也不算数：
        // 目录条目只证明会话存在过，注册表驻留才证明当前有驱动，设计 §1.3）
        // 时**不得**宣称"尚未结束"（需求 §2.2.2），换未证实文案给重试出路。
        // 两档都不得复用 job 的文案（`async_wait_job(job_id=…)`）。
        const unverifiedState = !messageConverged && (
          recheckRaw === undefined
          || resident === 'unknown'
        );
        if (winner.name === 'unknown') {
          ctx.logger?.warn?.(
            `${LOG_PREFIX} async_wait_agent: unrecognized race winner; returning "running" defensively `
            + `(agent=${escapeLogValue(agentId)} waitedMs=${waitedMs})`
          );
        }
        return {
          status: 'running',
          agent_id: agentId,
          waited_ms: waitedMs,
          note: unverifiedState
            ? agentRecheckFailedNote({ lang, agentId, waitedMs, maxWaitMs: config.maxWaitMs })
            : agentWaitAgainNote({ lang, agentId, waitedMs, maxWaitMs: config.maxWaitMs })
        };
      } finally {
        cleanup();
      }
    }
  });
  tool.rebuildText = rebuildText;
  return tool;
}
