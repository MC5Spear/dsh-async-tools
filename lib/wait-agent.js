/**
 * `async_wait_agent` 工具：有界的子代理等待，可被可处理消息唤醒（设计 §2/§3.4）。
 *
 * - 屏障：`listChildren()` 先查一次，消除"订阅前已结束"的竞态；
 * - 入口注册表三态（设计 §3.4）：目录命中后查 `agents.get(agentId)`——`idle` 立即
 *   返回停止态结果，`undefined` 与"目录行消失"同档提前返回，查询抛错状态未证实；
 * - 权威信号：`source.kind === "subagent-settled"` 的结算通知（自带关系证据，
 *   可独立结算）与 `agent/status` 转 idle（停止证据，须目录行先证合法子代理
 *   关系——同组合兄弟作用域的同 id 事件可被监听器收到，设计 §3.4 证据分级）；
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
import { agentRecheckFailedNote, agentWaitAgainNote, cancelledNote, cancelledPreexistingNote, escapeLogValue, interruptedNote, interruptedPreexistingNote, settledNote } from './output.js';
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
    // （`dsh-subagent/lib/types/index.d.ts:228` 与 `:245` 的返回类型不同）。
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
 * （`subagentCatalogEntries` 的 view：`@deepseek-ai/dsh-subagent/lib/index.js:774-785`，
 * 投影定义 `:787-803`；行类型 `SubagentCatalogEntry`：
 * `lib/types/projection-types.d.ts:8-23`）。带 `activity` 的是**另一条路径**
 * `listDescendants()` 的判别联合行：它按会话注册表现算驻留——
 * `sessions.get(entry.id)` 命中写 `"running"`、查无写 `"inactive"`
 * （`:2421`）。
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
 * @param {object} entry - 子代理列表行（catalog 行或判别联合行，两种形状都收）。
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
 * 诊断行写 `reason` 而不是丢弃（初衷是"别把诊断行当子代理"，
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
 * 先到消息关系定性窗口的固定响应上限（设计 §3.4）。
 *
 * 先到消息在定性分支里已被消费——先到的唤醒不解析 `interrupt.promise`，
 * 定性窗口就是这条消息的唯一出口；窗口若取整个 `pollIntervalMs`，合法的大
 * 轮询值（如 10000 ms，需求 §5.2 只约束 `pollIntervalMs ≤ maxWaitMs`）会把
 * 消息拖过设计 §8.1 的 5000 ms 真机响应窗。2000 ms 与轮询配置无关：给慢而
 * 健康的目录留至多四倍于默认间隔（500 ms）的定性机会，同时给响应窗留六成
 * 余量给宿主调度与观测开销。三条先到路径（user 插话／本包迟到作答／
 * notice-relay）统一适用。
 */
const EARLY_CLASSIFY_WINDOW_MS = 2000;

/**
 * 复查被总预算切断的哨兵值（`boundedChildOf` 的到期竞速分支）。与查询失败
 * （`undefined`）分开：前者是"预算用尽、没等到查询"，后者是"查询本身抛错"——
 * 收敛处按不同口径消费（需求 §2.1.1/§2.3.3）。
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

      // 取消口径出口（设计 §2.5）：取消不是消息到达，不用"消息已到"的
      // interrupted 文案；只作行为陈述（取消没有终止子代理的工作），不写
      // "仍在运行"状态断言——取消出口不做状态复查。
      const cancelledOutcome = (waitedMs) => ({
        status: 'interrupted',
        agent_id: agentId,
        waited_ms: waitedMs,
        note: cancelledNote({
          lang,
          subject: `subagent ${agentId}`,
          waitedMs,
          resume: `async_wait_agent(agent_id="${agentId}", wait_ms=...)`
        })
      });

      // 入口已中止的调用直接按取消口径交回——不订阅、不进屏障、不武装预算、
      // 不发任何查询。AbortSignal 已中止后挂监听器永不触发，不短路的话这条
      // 调用会等满预算才以 running 收场（对模型撒谎，还白占一次并发位）。
      if (exec.signal?.aborted) {
        return {
          status: 'interrupted',
          agent_id: agentId,
          waited_ms: 0,
          note: cancelledPreexistingNote({
            lang,
            subject: `subagent ${agentId}`,
            resume: `async_wait_agent(agent_id="${agentId}", wait_ms=...)`
          })
        };
      }

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
        interrupt = watchWakeSignal(ctx, agent, lang);
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
        // 取消拒绝归一为 `{ name: 'aborted' }` 标签（设计 §2.5 取消出口返回
        // 取消口径）：abort 是"这个调用没人要了"，
        // 交回合法形状由宿主整体改写模型可见结果；子代理不因此终止。归一前
        // 的 reject promise 在创建点同步挂接 `.then(…, …)` 双分支，不存在
        // 无 handler 窗口；归一后成员只有 resolve 路径。
        aborted = new Promise((_resolve, reject) => {
          abort.signal.addEventListener(
            'abort',
            () => reject(abort.signal.reason ?? new Error('aborted')),
            { once: true }
          );
        }).then(
          () => ({ name: 'aborted' }),
          () => ({ name: 'aborted' })
        );

        // 总截止定时器（设计 §2.1：参数解析后立即武装；cleanup 处置）。到期同时落
        // `deadlineCtl`——把截止信号传入此后一切在途目录查询（`listChildren` 支持
        // AbortSignal 取消，设计 §2.1"将调用取消和截止信号传入并与消息/到期竞速"）。
        // 定时器在 Promise 构造器**外**建立（设计 §2.1 初始化失败＝可控错误）：
        // `ctx.timer.timeout` 同步抛错由接线段 catch 撤销前序资源后上抛，
        // deadline promise 自身只 resolve、永不 reject。
        let onDeadline;
        deadline = new Promise((resolve) => { onDeadline = resolve; });
        deadlineTimer = ctx.timer.timeout(() => {
          deadlineCtl.abort(new Error('total budget exhausted'));
          onDeadline({ name: 'deadline' });
        }, waitMs);
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
      //
      // 在途查询**多路复用**（设计 §2.1"主循环内在途目录查询至多一路"）：轮询
      // 链的 tick 与收敛后的复查共享同一个在途 promise——tick 的查询还在途时
      // 发起的复查复用同一次调用，不叠加第二路 `listChildren`（收敛点的 finally
      // 已先撤轮询续排，在途 tick 完成后不再续排）。共享调用携带同一
      // probeSignal（工具取消 ∨ 总截止）；完成即让出槽位，下一次调用重新发起。
      let inflightChildQuery = null;
      const singleChildOf = () => {
        if (inflightChildQuery === null) {
          // 返回**原 promise 身份**（不加 .finally/.then 包装）：包装会多出一跳
          // 微任务，改变它与 deadline 竞速的时序（到期后复查会被 BUDGET_CUT
          // 抢先，`undefined` 的查询失败口径就再也观察不到）。槽位清理用旁挂
          // 的 then 对，不影响返回值本身的 settle 时机。
          const query = childOf(ctx, parentId, agentId, probeSignal);
          inflightChildQuery = query;
          query.then(
            (entry) => {
              // 关系证据（设计 §3.4）：目录行命中证明本主体有权等待该目标。
              // 本旁挂 then 在消费方 await 之前注册，行到达时先于消费方续体
              // 执行——消费方看到行之前，已登记的 idle 事件即被兑现，不等
              // 下一次轮询或事件重发。
              if (entry !== null && entry !== undefined) activity.proveRelation();
              if (inflightChildQuery === query) inflightChildQuery = null;
            },
            () => { if (inflightChildQuery === query) inflightChildQuery = null; }
          );
          return query;
        }
        return inflightChildQuery;
      };
      // 收敛后复查的有界包装（设计 §2.1 辅助查询全竞速）：与总截止、工具取消、
      // 新到信号（唤醒／迟到作答）同时竞速——宿主查询不理 signal 或挂起时，
      // 消息与取消的交回不被拖延。控制信号胜出按 BUDGET_CUT（没观察到）放行：
      // 活动重查的调用方随后重入竞速循环，由已解析的信号分支收敛；结算弱证据
      // 复查的调用方已持有收敛结果，机会性升级缺席即按原口径交回。
      const boundedChildOf = () => Promise.race([
        singleChildOf(),
        deadline.then(() => BUDGET_CUT),
        aborted.then(() => BUDGET_CUT, () => BUDGET_CUT),
        interrupt.promise.then(() => BUDGET_CUT),
        lateWatch.promise.then(() => BUDGET_CUT)
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
        const wake = classifyWake(preexistingWakeMessage(agent), lang);
        if (wake !== null && wake.via === 'user') return 'cut-user';
        let lateSources = [];
        try {
          lateSources = unclaimedLateSources(agent);
        } catch { /* getter 抛错按未命中——与入口检查同向 */ }
        if (lateSources.length > 0) return 'cut-late';
        if (wake !== null) return 'cut-wake';
        return null;
      };

      /**
       * 先到消息下的目标关系定性（设计 §3.4 合法关系优先）。
       *
       * 停止候选（注册表 `idle`／`absent`）不是停止证据：无关主体在注册表里
       * 的状态不构成本次等待的断言（需求 §2.3.3）——停止态与「最终回答将
       * 另行到达」类投递承诺，一律以父会话目录行证明的合法子代理关系为前提。
       * 现读注册表同步分档：`running`／`unknown` 不发起目录查询，直接按消息
       * 口径交回；读到 `idle`／`absent` 才发起关系定性查询（经在途多路复用
       * 通道，设计 §2.1 主循环内在途至多一路），与工具取消、等待中新到信号
       * （唤醒／迟到作答）、定性窗口 `min(pollIntervalMs, 剩余预算, 2000 ms)`、总截止
       * 同时竞速——宿主查询不理 signal 或挂起时，消息与取消仍及时交回（真机
       * 响应窗口按 §8.1），先到消息的交回不为定性查询等满剩余预算（需求
       * §2.1.2）。四档查询结果分开，不得互相冒充：
       * - 行对象——关系已证明：现读注册表复核，仍为 `idle`／`absent` 才交
       *   停止候选（`idle`＝状态转为 idle，`absent`＝无驻留）；复核翻成
       *   `running`／`unknown` 则回落消息口径。
       * - 查无该 id——单次查空不构成「从未存在」的断言（与屏障重试同一
       *   理由）：按存在性未定交回；查无断言与已知子代理清单由下一次调用的
       *   存在屏障交付。
       * - 查询失败——不是查无，也不是停止：同存在性未定口径。
       * - 窗口耗尽——按消息口径交回，关系未证明。
       * 弃用的定性查询由 `childOf` 内 catch（收进 `undefined`）与多路复用
       * 槽位的旁挂 then 承接，不遗留未处理拒绝；窗口定时器在任一出口撤销。
       */
      const classifyEarlyTarget = async () => {
        const st = agentStatusOf(ctx, agentId);
        if (st !== 'idle' && st !== 'absent') return { kind: 'message', registry: st };
        // 定性窗口三取小（设计 §3.4）：轮询间隔、剩余预算、2000 ms 固定响应
        // 上限——先到消息至多等待一个定性窗口，不为定性查询等满剩余预算。
        const windowMs = Math.min(config.pollIntervalMs, deadlineAt - monotonic(), EARLY_CLASSIFY_WINDOW_MS);
        if (windowMs <= 0) return { kind: 'message', registry: 'unproven' };
        // 基线排除（仅迟到作答类）：watchLateAnswer 带起始检查——先到的迟到
        // 作答会在订阅点自动解析 lateWatch.promise，不排除会在微任务里抢在
        // 目录查询之前出线（该消息已由本条早到路径承接）。唤醒类无此问题：
        // watchWakeSignal 没有起始检查，先到唤醒不解析 interrupt.promise——
        // 定性窗口内**新到**的唤醒（含 user 插话）照常竞速切断（设计 §2.1
        // 「辅助查询与可处理消息竞速」）。工具取消同理全程在竞速（入口已
        // 中止在接线前就被接走）。
        let baselineLate = false;
        try {
          baselineLate = unclaimedLateSources(agent).length > 0;
        } catch { /* getter 抛错按未命中 */ }
        let cancelWindow;
        const windowHit = new Promise((resolve) => {
          cancelWindow = ctx.timer.timeout(() => resolve('window'), windowMs);
        });
        // 查询胜负包装成标签对象；拒绝（abort 转发被宿主尊重时）也归入
        // 「查询失败」档，不当崩溃。
        const query = singleChildOf().then(
          (entry) => ({ kind: 'query', entry }),
          () => ({ kind: 'query', entry: undefined })
        );
        const racers = [
          query,
          windowHit,
          aborted.then(() => 'cancel', () => 'cancel'),
          deadline.then(() => 'deadline'),
          // 结算观察者独立成军：定性期间新到的结算通知须能胜出——完成优先
          // （设计 §2.2）。该 promise 由接线期订阅驱动，先到结算已在入口
          // 检查交回，不会误触。
          activity.settled.then(() => 'settle-signal'),
          interrupt.promise.then(() => 'wake')
        ];
        if (!baselineLate) racers.push(lateWatch.promise.then(() => 'late'));
        let winner;
        try {
          winner = await Promise.race(racers);
        } finally {
          cancelWindow();
        }
        if (winner === 'settle-signal') {
          // 新结算到达：按完成优先交站点复核（未领取结算通知在场 → settled）。
          return { kind: 'settle' };
        }
        if (winner === 'cancel' || winner === 'wake' || winner === 'late') {
          return { kind: winner };
        }
        // 窗口与总截止胜出同按「关系未证明」处理（窗口 ≤ 剩余预算，总截止
        // 只在竞速同拍时可见）；查询胜出以标签对象 `kind` 判别，不得与字符串
        // 标签混比。
        if (winner?.kind !== 'query') return { kind: 'message', registry: 'unproven' };
        const entry = winner.entry;
        if (entry !== null && entry !== undefined) {
          const recheck = agentStatusOf(ctx, agentId);
          if (recheck === 'idle' || recheck === 'absent') {
            return { kind: 'settled', via: recheck === 'idle' ? 'idle' : 'noResident' };
          }
          return { kind: 'message', registry: recheck };
        }
        return { kind: 'message', registry: 'unproven' };
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
        const earlyWake = classifyWake(preexistingWakeMessage(agent), lang);
        if (earlyWake !== null && earlyWake.via === 'user') {
          // 入口先到消息的合法关系定性（设计 §3.4）：插话处理不等存在性查询，
          // 但停止候选必须先证明关系——无关 idle 不是停止证据（需求 §2.3.3）。
          // 定性交停止候选时并存插话以消息前缀表达（完成优先于打断）；定性期
          // 新到信号先复核未领取结算通知（完成优先），插话仍按 interrupted
          // 交回——先到的 user 插话不被后到的 relay 降级。
          const cls = await classifyEarlyTarget();
          if (cls.kind === 'settled') {
            return {
              status: 'settled',
              agent_id: agentId,
              waited_ms: elapsed(),
              note: `${t(lang, 'wait.wokeByMessage', { summary: earlyWake.summary })} ${t(lang, cls.via === 'idle' ? 'via.idle' : 'via.noResident')}${settledNote({ lang, agentId })}`
            };
          }
          if (cls.kind === 'cancel') return cancelledOutcome(elapsed());
          if (cls.kind === 'wake' || cls.kind === 'late' || cls.kind === 'settle') {
            if (unclaimedSettlement(agent, agentId) !== null) {
              return {
                status: 'settled',
                agent_id: agentId,
                waited_ms: elapsed(),
                note: `${t(lang, 'via.noticePreexisting')}${settledNote({ lang, agentId })}`
              };
            }
          }
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
        // 入口检查的 late／wake 运行句柄同受未证实纪律（需求 §2.1.3）与停止优先
        // （设计 §3.4）约束：这两条路径不进存在屏障，停止候选由上面的关系定性
        // 裁定；未证/未定时运行状态只剩注册表现读——读到 running 才说「尚未
        // 结束」，其余一律未证实文案（含定性查无/失败/窗口耗尽后的复读、以及
        // 复读瞬间竞速翻成 idle／absent 的情形——「可能已停止」对两者都如实，
        // 且给重查出路；绝不返回 null 让模板渲染字面 "null"）。
        const entryWaitNote = () => (
          agentStatusOf(ctx, agentId) === 'running'
            ? agentWaitAgainNote({ lang, agentId, waitedMs: elapsed(), maxWaitMs: config.maxWaitMs })
            : agentRecheckFailedNote({ lang, agentId, waitedMs: elapsed(), maxWaitMs: config.maxWaitMs })
        );
        let earlyLate = [];
        try {
          earlyLate = unclaimedLateSources(agent);
        } catch { /* getter 抛错按无先到——宁可多等一轮（与 watchLateAnswer 同向） */ }
        if (earlyLate.length > 0) {
          // 合法关系定性（设计 §3.4，同 user 路径）：停止候选先证关系；未证/
          // 未定时按迟到作答口径交回——运行句柄文案按注册表现读分档。
          const cls = await classifyEarlyTarget();
          if (cls.kind === 'settled') {
            return {
              status: 'settled',
              agent_id: agentId,
              waited_ms: elapsed(),
              note: `${t(lang, 'wait.lateArrived', { summary: earlyLate[0].summary })} ${t(lang, cls.via === 'idle' ? 'via.idle' : 'via.noResident')}${settledNote({ lang, agentId })}`
            };
          }
          if (cls.kind === 'cancel') return cancelledOutcome(elapsed());
          if (cls.kind === 'wake' || cls.kind === 'late' || cls.kind === 'settle') {
            if (unclaimedSettlement(agent, agentId) !== null) {
              return {
                status: 'settled',
                agent_id: agentId,
                waited_ms: elapsed(),
                note: `${t(lang, 'via.noticePreexisting')}${settledNote({ lang, agentId })}`
              };
            }
          }
          return {
            status: 'running',
            agent_id: agentId,
            waited_ms: elapsed(),
            note: `${t(lang, 'wait.lateArrived', { summary: earlyLate[0].summary })} ${entryWaitNote()}`
          };
        }
        if (earlyWake !== null) {
          // 合法关系定性（设计 §3.4，同上）：notice/relay 先到消息同受约束。
          const cls = await classifyEarlyTarget();
          if (cls.kind === 'settled') {
            return {
              status: 'settled',
              agent_id: agentId,
              waited_ms: elapsed(),
              note: `${t(lang, 'wait.wokeByMessage', { summary: earlyWake.summary })} ${t(lang, cls.via === 'idle' ? 'via.idle' : 'via.noResident')}${settledNote({ lang, agentId })}`
            };
          }
          if (cls.kind === 'cancel') return cancelledOutcome(elapsed());
          if (cls.kind === 'wake' || cls.kind === 'late' || cls.kind === 'settle') {
            if (unclaimedSettlement(agent, agentId) !== null) {
              return {
                status: 'settled',
                agent_id: agentId,
                waited_ms: elapsed(),
                note: `${t(lang, 'via.noticePreexisting')}${settledNote({ lang, agentId })}`
              };
            }
          }
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
        // 不能等满剩余预算；④ 结算通知在屏障期到达时按完成优先直接交回（其
        // 自带关系证据）；idle 事件不切断屏障——关系未证时只登记在观察器里，
        // 查询在途/挂起、查无、查询失败期间一律登记不行动，取消、消息与截止
        // 照常按各自口径交回（设计 §3.4）。
        let known;
        let barrierCut = null;
        // 屏障期的结算观察者：结算通知自带关系证据（设计 §3.4），在屏障期到达
        // 即按完成优先切断，经 barrierExit 的未领取结算通知复核交回 settled。
        // idle 事件不解析本竞速成员（关系未证只登记，见 watchSubagentActivity），
        // 因此本成员胜出只可能是结算通知。
        const barrierSettledTagged = activity.settled.then(() => 'cut-settled');
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
            barrierSettledTagged,
            aborted.then(() => 'cut-abort', () => 'cut-abort')
          ]);
          if (typeof known === 'string') {
            barrierCut = known;
            known = undefined;
            break;
          }
          // 关系证据到位（设计 §3.4）：目录行确认 = 本主体有权等待该目标的证据，
          // 已登记的 idle 事件立即生效（proveRelation 兑现，不等下一次轮询或
          // 事件重发）；查无（null）与查询失败（undefined）都不构成关系证据，
          // 已登记的 idle 继续只登记。
          if (known !== null && known !== undefined) activity.proveRelation();
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
            barrierSettledTagged,
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
        // 交回：权威停止信号（完成优先）→ settled；取消 → 取消口径；结算通知 →
        // settled；user 插话 → interrupted；迟到作答与其余 notice/relay →
        // 运行句柄＋唤醒原因。cut-deadline 时状态未证实（屏障没确认过任何东西），
        // 用未证实文案，不宣称"尚未结束"（需求 §2.3.3）。
        const unverifiedOutcome = () => ({
          status: 'running',
          agent_id: agentId,
          waited_ms: elapsed(),
          note: agentRecheckFailedNote({ lang, agentId, waitedMs: elapsed(), maxWaitMs: config.maxWaitMs })
        });
        // 屏障期 user 插话与停止并存的说明：同一消息既触发切断又被列为插话时
        // （`pendingSignal` 优先级里结算高于插话，同拍投递取结算标签），
        // 并存的插话以附加行表达（与竞速收敛的 `interruptedDuringSettle` 同款）。
        const barrierUserHint = () => {
          try {
            const wake = classifyWake(preexistingWakeMessage(agent), lang);
            return wake !== null && wake.via === 'user' ? t(lang, 'note.agent.interruptedDuringSettle') : '';
          } catch {
            return '';
          }
        };
        const barrierExit = (cut) => {
          // 切断出口的交付次序（设计 §3.4）：取消与到期标签先交回各自出口
          // （用户动作与预算口径优先于重分类，这条路径上不再翻结算通知）；
          // 消息/迟到作答等其余标签下，若未领取的权威结算通知在场则按
          // settled 交回（结算通知自带关系证据，可独立生效）。idle 事件不走
          // 这条出口：关系未证的 idle 只登记在观察器里，屏障切断时按存在性
          // 未定交回，不套停止态、不承诺最终回答另行到达。
          if (cut === 'cut-abort') return cancelledOutcome(elapsed());
          if (cut === 'cut-deadline') return unverifiedOutcome();
          // 完成优先（设计 §2.2）：未领取的权威结算通知在场 → settled——适用于
          // 消息/迟到作答等其余切断标签（结算通知同时是 notice 唤醒源；取消与
          // 到期出口已在上方交回，不经此分支）。
          if (unclaimedSettlement(agent, agentId) !== null) {
            return {
              status: 'settled',
              agent_id: agentId,
              waited_ms: elapsed(),
              note: `${t(lang, 'via.noticePreexisting')}${barrierUserHint()}${settledNote({ lang, agentId })}`
            };
          }
          // 其余切断按扫描重分类（读取失败按未命中回退）：拿到 via/summary 再
          // 交回，与入口检查的分支同形。user 插话 → interrupted；notice/relay →
          // 运行句柄＋唤醒原因；迟到作答 → 运行句柄＋lateArrived。屏障未确认过
          // 目标存在，运行句柄一律带未证实口径，不宣称"尚未结束"（需求 §2.1.3）。
          let lateSources = [];
          try {
            lateSources = unclaimedLateSources(agent);
          } catch { /* getter 抛错按无先到 */ }
          const wake = classifyWake(preexistingWakeMessage(agent), lang);
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
          // 查询失败且预算已尽：状态未证实——不宣称"尚未结束"（需求 §2.3.3）。
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
          // 错误清单查询与工具取消、新到信号、总截止同时竞速（设计 §2.1 辅助
          // 查询全竞速；§2.1"到期后不无界 await 错误清单查询"）——清单只是
          // 可选诊断，不挡主结果也不挡控制信号：取消/新信号胜出走切断出口
          // （屏障已证明关系，idle／absent 复读与结算通知按停止态交回）；
          // 总截止胜出按已证主断言交回 not_found、清单按空放行；清单查询
          // 失败或被切断同样按空清单放行，不影响主断言。
          const listTag = Promise.resolve(knownChildren(ctx, parentId, lang, probeSignal)).then(
            (list) => ({ kind: 'list', list }),
            () => ({ kind: 'list', list: [] })
          );
          const listWinner = await Promise.race([
            listTag,
            aborted.then(() => 'cancel', () => 'cancel'),
            interrupt.promise.then(() => 'wake'),
            lateWatch.promise.then(() => 'late'),
            // 权威停止也在竞速之列（设计 §3.4：清单查询与权威停止竞速，停止
            // 先到按停止态交回、清单弃置）——观察器解析在此只可能是结算通知
            // （自带关系证据，经 barrierExit 的未领取通知复核承接）；idle 事件
            // 关系未证不解析，不进入本竞速。
            barrierSettledTagged,
            deadline.then(() => 'deadline')
          ]);
          if (listWinner === 'cancel') return barrierExit('cut-abort');
          if (listWinner === 'wake') return barrierExit('cut-wake');
          if (listWinner === 'late') return barrierExit('cut-late');
          if (listWinner === 'cut-settled') return barrierExit(listWinner);
          return {
            status: 'not_found',
            agent_id: agentId,
            known_children: listWinner === 'deadline' ? [] : listWinner.list
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
        // 屏障的目录行已证合法关系，注册表读数因此具备停止证据资格——
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
        // 命中即唤醒复查），再查目录行消失。轮询只在屏障确认目录行（关系证据）
        // 之后运行，注册表读数因此具备停止证据资格。查询失败不触发结束——注册表
        // 读取抛错与 `childOf` 的 `undefined` 同口径，只作"没观察到"。
        //
        // 串行纪律（设计 §2.1"在途查询逐次串行"）：用**自重排的 timeout 链**而不是
        // `interval`——`interval(async …)` 在回调耗时超过间隔时会叠加在途目录查询；
        // timeout 链保证上一轮查询结束后才排下一拍，慢查询自然
        // 拉长节奏而不叠加。首拍也等一个间隔（与 `interval` 的首个 tick 同时点）。
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
            // 发起前检查剩余预算（设计 §2.1「任何目录查询发起前检查剩余预算」）：
            // 到期后不再新发查询——已中止的 probeSignal 在宿主尊重 abort 时立即
            // 拒绝，不尊重时也会被多路复用槽位的旁挂清理承接，但「不发起」本身
            // 就是纪律；也是截止信号之外的第二道拦截。
            if (deadlineAt - monotonic() <= 0) return;
            const status = agentStatusOf(ctx, agentId);
            if (status === 'idle' || status === 'absent') {
              resolve({ name: 'polled' });
              return;
            }
            // 目录查询经 `singleChildOf` 多路复用（设计 §2.1 在途至多一路）：
            // 与收敛后复查共享同一在途调用。
            const entry = await singleChildOf();
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
        // 结果返回，不依赖微任务时序）；目录复查随后——两接口的返回性质不同：
        // `listChildren()` 的行**不带** `activity` 字段；带它的是
        // `listDescendants()` 的判别联合行（按会话注册表现算驻留——见 `childOf`
        // 头注）。在带字段的行上，读到非 running
        // 只支持"不再观察到它在运行"，不能升格成"它已结束"（设计 §3.4）；把"列表
        // 查询失败"（`undefined`）当成"已结束"同样会让工具对模型撒谎。
        // 复查与控制信号、总截止竞速（`boundedChildOf`）：到期/唤醒收敛后查询只拿
        // **剩余**预算，控制信号或到期先到按"没观察到"放行——到期后不得再无界等
        // 诊断（需求 §2.1.1）。
        // **消息收敛不查目录**（设计 §2.1"消息的处理不能等满剩余预算"）：无结算信号时，
        // 目录复查对 wake／late-answer 收敛只是机会性升级（恰好读到 inactive 才把
        // running 改报 settled）；跳过的代价由下一次等待的入口三态承接（注册表与
        // 目录都是当次观察，再调一次立即交回）。结算收敛仍复查（弱证据复核需要），
        // 到期收敛受预算竞速约束。
        const resident = agentStatusOf(ctx, agentId);
        const userWon = winner.name === 'wake' && winner.via === 'user';
        const cancelConverged = winner.name === 'aborted';
        const messageConverged = settledSignal === null && winner.name !== 'settled'
          && (winner.name === 'wake' || winner.name === 'late-answer');
        // **停止已证即跳过复查**（设计 §3.4 可靠停止证据立即交付）：权威结算信号
        // （非 settlement-text——正文回退仍需弱证据复核）、注册表 idle／absent、
        // 取消收敛三者都不再等目录复查——已证停止的交回不得被机会性查询拖延，
        // 取消的即时交回同理。复查结果三态单独留在 `recheckRaw`（查询失败
        // `undefined` / 预算切断 `BUDGET_CUT` / 行对象或 `null`）：
        // `inactiveVerdict` 只吃行形状，未观察到（失败与切断）都按"不活跃证据
        // 缺席"——但收敛文案要区分"证实仍在运行"与"状态未证实"（需求 §2.1.3）。
        const stopProven = (settledSignal !== null && settledSignal.via !== 'settlement-text')
          || resident === 'idle' || resident === 'absent' || cancelConverged;
        let recheckRaw = 'skipped';
        if (!messageConverged && !stopProven) {
          recheckRaw = await boundedChildOf();
        }
        const verdict = messageConverged || stopProven
          ? { inactive: false }
          : inactiveVerdict(recheckRaw, lang);

        // 收敛路径（消息唤醒／迟到作答）的运行句柄文案分两档（需求 §2.1.3）：这些
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
        // 完成优先于唤醒（设计 §2.2，与 `async_wait_job` 的同名规则一致）：目标
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
          // 并存插话说明（设计 §2.2 停止与插话并存）：结算信号与 user 插话
          // 同拍（竞速 tie-break）时停止事实优先交回，插话以附加行表达——
          // 与注册表/目录分支同款。
          const interruptedHint = userWon ? t(lang, 'note.agent.interruptedDuringSettle') : '';
          return settledOutcome(`${via}${interruptedHint}${label}`);
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

        // 取消收敛（设计 §2.5 取消口径）：工具调用自身被取消——不是消息到达、
        // 不是预算到期。交回取消口径（取消没有终止子代理——结束等待从不停止
        // 后台工作），复查已在 stopProven 里跳过；宿主对已中止调用会整体改写
        // 模型可见结果，这里的合法形状落给改写层与测试双通道（执行结果与宿主
        // 可见结果分开核实，设计 §8.1）。
        if (cancelConverged) {
          return cancelledOutcome(waitedMs);
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
        // 时**不得**宣称"尚未结束"（需求 §2.1.3），换未证实文案给重试出路。
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
