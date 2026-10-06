/**
 * `async_wait_agent` 工具：有界的子代理等待，可被用户插话打断（设计 §6）。
 *
 * `subagents` 服务没有等待方法，因此本工具用"**状态屏障 + 结算事件**"实现：
 * - 屏障：`listChildren()` 先查一次，消除"订阅前已结束"的竞态；
 * - 权威信号：`source.kind === "subagent-settled"` 的结算通知；
 * - 唤醒信号：`source.kind === "agent-message"` 的转达消息，只用来提前重查状态；
 * - 兜底：定时轮询状态（`inactive` 无法区分"已完成"与"暂时空闲"，故只作兜底）。
 *
 * **打断判定只用 `source.kind === 'user'`**（陷阱：插件通知的 role 也是 user）。
 *
 * @module dsh-async-tools/wait-agent
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LOG_PREFIX, resolveWait } from './config.js';
import { buildToolText } from './descriptions.js';
import { watchLateAnswer, watchSubagentActivity, watchUserInterrupt } from './interrupts.js';
import { agentWaitAgainNote, escapeLogValue, interruptedNote, settledNote } from './output.js';
import { t } from './text.js';

/**
 * 查一次子代理列表，返回匹配条目（找不到返回 `null`，查询失败返回 `undefined`）。
 * 第四参透传 `AbortSignal`（R29-f， 签名/ 现状）：等待被取消时在途查询随请求
 * 一起中止——`listChildren` 的拒绝被下面的 catch 收进 `undefined`（查询失败口径），
 * 不新增路径。
 */
async function childOf(ctx, parentId, agentId, signal) {
  try {
    const entries = await ctx.subagents.listChildren(parentId, signal);
    if (!Array.isArray(entries)) return undefined;
    // 行形状随 dsh 版本变过：0.1.7 的 `listChildren()` 返回父会话 `subagentCatalog`
    // 投影的条目 `{ id, createdAt, mode, label? }`——**没有 `kind` 字段**；带
    // `kind: 'child' | 'diagnostic'` 的判别联合是 `listDescendants()` 的输出
    // （`dsh-subagent/lib/types/index.d.ts:218` 与 `:234` 的返回类型不同）。
    // 因此判据是"`id` 相等且不是诊断行"，两种形状都命中：
    // 旧口径要求 `kind === 'child'` 会在 0.1.7 上把所有行都滤掉，屏障恒 not_found
    // （真机实测：`async_wait_agent` 对一个刚派发的子代理报
    // `unknown subagent … Known children:` 空清单）。
    // 诊断行（`kind: 'diagnostic'`）仍必须排除（R2 审查 N7）：它表示"这条子会话的投影
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
 * ⚠️ **本函数不作"已结束"的断言**（R3 审查 R3-1 的裁决，口径 A）。
 *
 * ## `activity` 到底在哪一行上
 *
 * `activity` **不在** `listChildren()` 的返回行里：0.1.7 的 `listChildren()` 返回父会话
 * `subagentCatalog` 投影的条目 `{ id, createdAt, mode, label? }`
 * （`@deepseek-ai/dsh-subagent/lib/index.js:2091-2093`、
 * `lib/types/projection-types.d.ts:8-20`）。带 `activity` 的是**另一条路径**
 * `listDescendants()` 的判别联合行：`childRow()`（`:2297`）在**有活 reader** 时写死
 * `"running"`（`:2190`），**走冷读**时写死 `"inactive"`（`:2261`）。
 * 所以 `activity` 分支只在行形状确实带该字段时（旧版 dsh、或换用 `listDescendants`）
 * 才可能命中；0.1.7 上它不命中，判定退化为"条目不在列表里"。
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
 * 两种行形状都要能写：0.1.7 的 catalog 行有 `mode`、没有 `activity`；
 * 判别联合（`listDescendants()`）行相反。诊断行写 `reason`——那是给模型的
 * 可纠错信息（`unavailable` = 暂时读不到，`corrupt` = 这条投影坏了）。
 *
 * @param {object} entry - `listChildren()` 的一行。
 * @param {string} lang - 模型面语言（`en` / `zh`）。
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
 * **不按 `kind` 过滤**：0.1.7 的 catalog 行没有 `kind` 字段，按
 * `kind === 'child'` 过滤会让清单恒空——真机上的报错因此长成
 * `Known children:` 后面什么都没有，模型拿不到任何可纠错信息。
 * 诊断行不再丢弃，改写 `reason`（R2 审查 N7 的初衷是"别把诊断行当子代理"，
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
 * 父会话，父会话有活 reader，正常即时可见）。**不是**等冷读暖机——那条推断在 0.1.7 上
 * 不成立：本版 `listChildren()` 只读父会话的 catalog 投影，不冷读任何子会话。
 * not_found 是"这个 id 不存在"的断言，一次查空不足以证明它——按 `pollIntervalMs`
 * 有界重试后再下结论。真不存在的 id 只多花几秒；误报 not_found 会把模型引向重新派发。
 */
const BARRIER_ATTEMPTS = 4;

/**
 * 用宿主定时器睡一段（屏障重试的间隔；走 `ctx.timer` 是为了让测试可控）。
 * @param {object} ctx - cordis 上下文。
 * @param {number} ms - 间隔。
 * @returns {Promise<void>} 睡眠结束。
 */
function barrierSleep(ctx, ms) {
  return new Promise((resolve) => {
    ctx.timer.timeout(() => resolve(), ms);
  });
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

      // R29-b：入口已中止的调用直接回 interrupted——不订阅、不进屏障、不武装预算、
      // 不发任何查询。AbortSignal 已中止后挂监听器永不触发，不短路的话这条
      // 调用会等满预算才以 running 收场（对模型撒谎，还白占一次并发位）。
      if (exec.signal?.aborted) return interruptedOutcome(0);

      const waitMs = resolveWait(args.wait_ms, config);
      const t0 = Date.now();

      // ★ 先订阅、后屏障：结算通知与状态转换**只发生一次**，若先查状态再订阅，
      //   子代理恰好在两者之间结束就会白等满整个预算（设计 §6.2 的竞态）。
      const interrupt = watchUserInterrupt(ctx, agent);
      // 竞速的每个分支都必须是 `{ name }` 形状，否则胜出者会缺少 `name` 而落到兜底分支。
      const interruptSignal = interrupt.promise.then(() => ({ name: 'interrupted' }));
      // R30-d 唤醒分支（R3 信号分类第四类）：本包迟到作答到达（插件事件 + 起始
      // 检查，watchLateAnswer）→ 提前返回运行句柄 + note——不打断（kind ≠ 'user'）、
      // 不误报 settled，控制权交还模型去消费通知（等待期间到达的作答不空转预算）。
      const lateWatch = watchLateAnswer(ctx, agent);
      const lateSignal = lateWatch.promise.then((signal) => ({
        name: 'late-answer', summary: signal.summary
      }));
      const activity = watchSubagentActivity(ctx, agent, agentId);

      const abort = new AbortController();
      const onExecAbort = () => abort.abort(exec.signal?.reason);
      if (exec.signal !== undefined) {
        exec.signal.addEventListener('abort', onExecAbort, { once: true });
      }
      const aborted = new Promise((_resolve, reject) => {
        abort.signal.addEventListener(
          'abort',
          () => reject(abort.signal.reason ?? new Error('aborted')),
          { once: true }
        );
      });
      // 这个 promise 只可能 reject。三层防线保证它不会变成未处理拒绝（R29-a）：
      // ① 入口短路让"进 execute 时就已中止"的调用根本走不到这里；
      // ② 创建点同步挂的 no-op catch 兜住**屏障窗口**——reject 可能发生在第一个
      //    `await childOf` 之后、竞速候选组装（下面 `candidates`）之前，期间长达
      //    3×pollIntervalMs，宿主 installFailLoud 语义下无人接住的 reject 就是
      //    整实例退出；no-op 分支只标记"已处理"，不影响竞速稍后读到它；
      // ③ 竞速挂接后由 `Promise.race` 自带的 reject 能力接住——race 给每个成员
      //    同时挂 resolve 与 reject 两个 handler，但这不等于"race 消费了它"，
      //    换成手写 `await` 循环会立刻丢掉这条性质（R2 审查 N8）。
      aborted.catch(() => {});

      const cleanup = () => {
        interrupt.dispose();
        lateWatch.dispose();
        activity.dispose();
        if (exec.signal !== undefined) exec.signal.removeEventListener('abort', onExecAbort);
      };

      try {
        // 屏障：确认这个子代理确实存在（`activity` 字段不能用来判断"是否结束"， 勘误）。
        // 查空不立即定罪：先按 pollIntervalMs 有界重试（见 BARRIER_ATTEMPTS 的依据），
        // 派发瞬间的目录投影刷新窗口内的行会在重试中出现；`undefined`（查询失败）
        // 仍立即抛错，不重试。
        let known;
        for (let attempt = 1; ; attempt++) {
          known = await childOf(ctx, parentId, agentId, exec.signal);
          if (known !== null || attempt >= BARRIER_ATTEMPTS) break;
          await barrierSleep(ctx, config.pollIntervalMs);
        }
        if (known === undefined) {
          throw new Error(t(lang, 'error.listingUnavailable'));
        }
        if (known === null) {
          return {
            status: 'not_found',
            agent_id: agentId,
            known_children: await knownChildren(ctx, parentId, lang, exec.signal)
          };
        }
        const label = typeof known.label === 'string' ? ` (${known.label})` : '';

        const settledOutcome = (detail) => ({
          status: 'settled',
          agent_id: agentId,
          waited_ms: Date.now() - t0,
          note: `${detail}${settledNote({ lang, agentId })}`
        });

        // ★ 屏障即终态（R2 审查 N3）：屏障原本只判"存在性"，于是对一个**在开始等待
        //   之前就已经结束**的子代理，三条结束通道（结算通知 / `agent/status` 转 idle /
        //   转达消息）都已经发生过、不会再来，工具只能等满 wait_ms 返回 running。
        //   这违反 R3"子代理已结束（或已非运行态）→ 立即返回已结束"。
        //   所以屏障处顺带判一次"可证不活跃就立即返回 settled"。
        //   注意判据是 `inactiveVerdict`：`activity === "running"` 什么也证明不了，
        //   所以这一条只能救"列表明确读出不活跃"的子代理，救不了仍读作 running 的已结算子代理
        //   ——那部分能力缺口写进了工具描述。
        const barrierVerdict = inactiveVerdict(known, lang);
        if (barrierVerdict.inactive) {
          return settledOutcome(`${barrierVerdict.detail}${label}`);
        }

        const settled = activity.settled.then((signal) => ({
          name: 'settled',
          via: signal.via
        }));
        // 竞速的**每个**分支都必须是 `{ name }` 形状：`watchSubagentActivity` 的
        // 原始信号是 `{ kind }` 形状，直接参与竞速会因缺少 `name` 而落到兜底分支
        // （这是 async_wait_job 同类 bug 的复制，单测已锁定）。
        const relay = activity.activity.then(() => ({ name: 'activity' }));

        // 兜底轮询：状态事件是主通道，轮询只兜"事件通道意外失聪"。
        // 只认 `null`（条目确实不在列表里）：`undefined` 是查询失败，
        // 与 `inactiveVerdict` 的口径保持一致，不能拿它当结束。
        let pollTimer;
        const polled = new Promise((resolve) => {
          pollTimer = ctx.timer.interval(async () => {
            const entry = await childOf(ctx, parentId, agentId, exec.signal);
            if (entry === null) resolve({ name: 'polled' });
          }, config.pollIntervalMs);
        });

        let timer;
        const deadline = new Promise((resolve) => {
          timer = ctx.timer.timeout(() => resolve({ name: 'deadline' }), waitMs);
        });

        let winner;
        try {
          // 循环竞速：`activity`（子代理转达消息）只表示"有进展，请重查状态"，
          // **不是结束信号**。若它胜出而子代理仍在运行，必须继续等剩余的通道，
          // 而不是把这次等待当成结束。
          //
          // 每个分支都解析为**自带 `name` 的对象**，因此胜出者就是解析值本身——
          // `Promise.race` 返回的是解析值而不是 promise 对象，用身份比较
          // （`promise === raced`）永远匹配不上，会静默落到兜底分支。
          let candidates = [
            ['interrupted', interruptSignal],
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
            const latestForActivity = await childOf(ctx, parentId, agentId, exec.signal);
            // 转达消息只表示"有进展"，重查后仍读不到"不活跃"的证据就继续等其余通道。
            if (inactiveVerdict(latestForActivity, lang).inactive) {
              winner = { name: 'settled', via: 'activity-recheck' };
              break;
            }
            candidates = candidates.filter(([name]) => name !== 'activity');
            if (candidates.length === 0) break;
          }
        } finally {
          if (typeof timer === 'function') timer();
          if (typeof pollTimer === 'function') pollTimer();
        }

        const waitedMs = Date.now() - t0;

        // 竞速收敛后的复查：只作"事后确认"，**不能**当作屏障使用（N3 的屏障在更上面）。
        //
        // `activity` 的语义是"这个 session 记录现在还在内存里"，不是"这个子代理在运行"：
        // `listChildren()` 对**活着的内存语料**一律写死 `"running"`
        // （`dsh-subagent/lib/index.js:2165`），对需要冷读的行才写别的值
        // （`:2236`/`:2263`）。所以读到非 running 的值**只能支持"不再观察到它在运行"**，
        // 不能升格成"它已结束"（R3-1 口径 A）；而 `activity === "running"` 什么也证明不了。
        //
        // 用 `inactiveVerdict` 判定：把"列表查询失败"（`undefined`）当成"已结束"
        // 会让工具在宿主出错时对模型撒谎。
        const verdict = inactiveVerdict(await childOf(ctx, parentId, agentId, exec.signal), lang);

        // R29-c：结算分支分两档。`senderSessionId` 精确关联的 notice、`agent/status`
        // 转 idle、活动复查是**权威信号**，直返 settled——投影滞后会把"已结束"误读
        // 成 running，复查反而撒谎。**正文回退**匹配（`via: 'settlement-text'`，
        // 老版本兼容路径）是弱证据：命中后必须复查到"不再观察到运行"才返回 settled，
        // 否则落 running（下一次等待仍走事件通道）——误报 settled 比多等一轮贵。
        if (winner.name === 'settled' && (winner.via !== 'settlement-text' || verdict.inactive)) {
          const via = winner.via === 'agent-status-idle'
            ? t(lang, 'via.idle')
            : winner.via === 'activity-recheck'
              ? t(lang, 'via.recheck')
              : winner.via === 'settlement-text'
                ? t(lang, 'via.textFallback')
                : t(lang, 'via.notice');
          return settledOutcome(`${via}${label}`);
        }

        // 结束优先于打断/超时（与 `async_wait_job` 的"完成优先"同一条裁决）：竞速收敛后
        // 复查发现它已经不活跃，就报 settled，而不是让模型为一个已经结束的子代理
        // 再等一轮（N3 描述的那种假阴性）。复查同时承担兜底轮询的职责——判定的
        // 正是"条目消失"。
        if (verdict.inactive) {
          const interruptedHint = winner.name === 'interrupted' ? t(lang, 'note.agent.interruptedDuringSettle') : '';
          return settledOutcome(`${verdict.detail}${interruptedHint}${label}`);
        }

        if (winner.name === 'interrupted') {
          return interruptedOutcome(waitedMs);
        }

        // 唤醒交还（R30-d 第四类）：运行句柄 + 迟到作答 note（含 summary——题号与
        // 作答摘要在内；通知正文按状态走 followup/inject 通道，在下一领取点进入
        // 上下文，§32.5）。保留 wait-again 提示，模型可选择继续等或先消费通知。
        // 信号源是插件事件 + 等待起始检查（watchLateAnswer，用户裁定）——
        // 作答先到、等待后开也能立即命中。
        if (winner.name === 'late-answer') {
          return {
            status: 'running',
            agent_id: agentId,
            waited_ms: waitedMs,
            note: `${t(lang, 'wait.lateArrived', { summary: winner.summary ?? '' })} ${agentWaitAgainNote({ lang, agentId, waitedMs, maxWaitMs: config.maxWaitMs })}`
          };
        }

        // 兜底分支：预算到期或等待被撤销。文案必须说"子代理仍在运行，可再次
        // async_wait_agent"——早期实现错误地复用了 job 的文案（`async_wait_job(job_id=…)`），
        // 会把模型引向一个不存在的调用。
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
          note: agentWaitAgainNote({ lang, agentId, waitedMs, maxWaitMs: config.maxWaitMs })
        };
      } finally {
        cleanup();
      }
    }
  });
  tool.rebuildText = rebuildText;
  return tool;
}
