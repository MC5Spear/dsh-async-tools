/**
 * `async_wait_job` 工具：有界的作业等待，可被可处理消息唤醒（设计 §2/§3.2；
 * 用户插话是唤醒集合的 user 类，notice/relay 类交回运行句柄）。
 *
 * 地基是宿主 `jobs.wait` 的关键语义：`jobs.wait` **只中断等待、不取消作业**。
 * 因此"打断等待 ≠ 打断工作"（需求 §2.2.1）直接由 dsh 既有支持提供。
 * 宿主现行 wait 语义（源码亲读）：**超时是 resolve**（带回当时的 JobView，可能是
 * 非终态）、abort 仅 reject `"wait aborted"`；判定上多出"resolve 回的 view
 * 仍是 running"一支。
 *
 * 单一总截止（设计 §2.1）：定时器在参数解析后立即武装一次，起点 t0；屏障、先到扫描、
 * 订阅与等待段全部发生在武装之后，中途不重置 t0。`jobs.wait` 与一切睡眠只取得
 * `deadline - now` 的剩余值。
 *
 * @module dsh-async-tools/wait-job
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LOG_PREFIX, resolveWait } from './config.js';
import { buildToolText } from './descriptions.js';
import { classifyWake, preexistingWakeMessage, unclaimedLateSources, watchLateAnswer, watchWakeSignal } from './interrupts.js';
import { escapeLogValue, interruptedNote, interruptedPreexistingNote, recheckFailedNote, truncate, waitAgainNote } from './output.js';
import { t } from './text.js';

/**
 * 终态集合。中间态 `'stopping'`（kill 已请求、进程未收尾）——
 * 它**不是**终态：此时返回 running 句柄是对的，模型再等一次即可。
 */
const TERMINAL = new Set(['completed', 'killed', 'failed']);

/**
 * 单调时钟（设计 §2.1 单一总截止的计时基）：t0、deadline、waited_ms 全走它，
 * 墙钟（Date.now）的回拨/跳变不得进入预算与读数（需求 §2.1.3 不冒充时长）。
 */
const monotonic = () => performance.now();

/**
 * 读取作业快照，三分返回（`childOf` 同款先例）：`null` = 清单里没有
 * （查无或不可见），`undefined` = 查询本身失败。caller 是 SessionId。
 *
 * 建在 `jobs.list()` 而不是 `jobs.get()` 上：`get` 对未知 id **一律 throw**
 * （`unknown job <id>`），查询失败与查无从错误形态上无法区分；`list(caller)` 只返回
 * caller 可见作业的视图（他 session 作业被滤掉——缺席与"不存在"对调用方等价，
 * 不泄漏存在性），缺席即 `null`，throw 即 `undefined`，一次查询天然三分。
 */
function snapshotOf(ctx, jobId, caller) {
  try {
    return ctx.jobs.list(caller).find((job) => job?.id === jobId) ?? null;
  } catch {
    return undefined;
  }
}

/**
 * 读取作业输出（消费式：增量按游标推进，最终 result 只随首次终态读取交付
 * 一次——第二次终态读取不保证拿到同文，需求 §2.2.3）。宿主 `jobs.read` 返回
 * `{chunks, lossy, result?, job}`
 *——chunks 是环形缓冲里的分块（含全部 channel），拼接即全量文本。
 * 最终 `result` 只随**首次终态读取**交付一次（注册表 `resultDelivered`，
 * dsh-jobs-local `:601-602`）——必须在这一次返回里并入模型可见文本，丢弃即永久
 * 丢失。合并次序与分隔规则与宿主 `job_output` 的消费读取（`readBody`，
 * dsh-tool-jobs `:215-222`）一致：增量在前、`result` 在后，中间仅在增量非空且
 * 不以换行结尾时补一个换行；增量文本的构造维持本包现行（全部 channel 拼接，
 * 不照搬宿主的 log 通道过滤与 `[stderr]` 单列）。
 * `lossy` 为真时给一行前缀标记——被丢的是"更早的字节"，spill 线索在 `detail` 里
 * （`lib/jobs.js` 的 `jobOutcome` 已把落点写进 detail）。
 * 裁剪次序（需求 §2.2.3：`maxResultChars` 限制保留的**内容**字符数，诊断提示
 * 另计）：先裁正文（截断标注由 `truncate` 嵌进正文、双语带省略量），lossy 前缀
 * 拼在裁剪结果之外——前缀不占内容预算。
 * 读失败**不**静默成空串（需求 §2.2.3）：给一行可见标注、正文为空——把空串当真实输出
 * 会让模型误判命令产出；标注即"该重查"的出路。此时注册表未消费一次性通道，
 * `result` 留待下一次成功的终态读取交付。
 */
function outputOf(ctx, jobId, caller, lang, maxChars, status) {
  // 终态状态行（需求 §2.2.2）：无输出、无详情的终态也必须能区分
  // completed/failed/killed；行在内容预算之外，与 lossy 前缀同列诊断提示。
  const statusLine = typeof status === 'string' && TERMINAL.has(status)
    ? `${t(lang, `render.jobStatus.${status}`)}\n`
    : '';
  let read;
  try {
    read = ctx.jobs.read(jobId, caller);
  } catch {
    return { text: `${statusLine}${t(lang, 'render.readFailed')}`, truncated: false, omitted: 0 };
  }
  const chunks = Array.isArray(read?.chunks) ? read.chunks : [];
  const delta = chunks.map((chunk) => (typeof chunk?.text === 'string' ? chunk.text : '')).join('');
  const text = read?.result === undefined
    ? delta
    : `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}${read.result}`;
  const cut = truncate(text, maxChars, lang);
  if (statusLine === '' && read?.lossy !== true) return cut;
  const lossyPrefix = read?.lossy === true ? `${t(lang, 'render.lossyPrefix')}\n` : '';
  return { ...cut, text: `${statusLine}${lossyPrefix}${cut.text}` };
}

/**
 * 构造 `async_wait_job` 工具定义。
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - 生效配置。
 * @returns {object} ToolDefinition。
 */
export function createWaitJobTool(ctx, config) {
  // 描述经 `buildToolText` 整段构建（构造处与刷新处同一份）。
  const rebuildText = (cfg) => buildToolText('async_wait_job', cfg);
  const text = rebuildText(config);
  const tool = defineTool({
    name: 'async_wait_job',
    description: text.description,
    parameters: text.parameters,
    output: {
      schema: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            job_id: { type: 'string', required: true },
            output: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
            detail: { type: 'string' }
          }
        }, {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            job_id: { type: 'string', required: true },
            waited_ms: { type: 'number', required: true },
            note: { type: 'string', required: true }
          }
        }]
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.output === undefined
          ? value.note
          // 终态分支把 `detail` 拼进模型可见文本（结构化 `value` 不进模型上下文）；
          // 截断标注由 `truncate` 直接嵌在 `output` 正文里（双语带省略量），
          // 这里不重复追加。
          : `${value.output}${value.detail === undefined ? '' : `\n\n${value.detail}`}`
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const lang = config.agentLang;
      // 宿主侧 jobs 的 caller 是 SessionId（`exec.agent?.id`）；
      // 插话监听要的仍是**完整 agent 句柄**（`agent.inbox.nextStep` 回查）——两个变量。
      const caller = exec.agent?.id;

      // 入口已中止 → 立即 interrupted（不进屏障、不武装预算、不发查询、
      // 不订阅）。AbortSignal 已中止后挂监听器永不触发，不短路的话这次调用
      // 会以 running 口径提前收场，还白发一次复查查询。
      if (exec.signal?.aborted) {
        return {
          status: 'interrupted',
          job_id: args.job_id,
          waited_ms: 0,
          note: interruptedNote({
            lang,
            subject: `job ${args.job_id}`,
            waitedMs: 0,
            resume: `async_wait_job(job_id="${args.job_id}", wait_ms=...)`
          })
        };
      }

      const waitMs = resolveWait(args.wait_ms, config);
      const t0 = monotonic();
      // 设计 §2.1 单一总截止：参数解析后立即武装一次，起点即 t0；屏障、先到扫描、
      // 订阅与等待段全部发生在武装之后，中途不重置 t0。计时走单调时钟（见 monotonic）。
      const deadlineAt = t0 + waitMs;
      const elapsed = () => Math.max(0, Math.round(monotonic() - t0));

      // 接线段整体入 try/finally（防御性）：`watchWakeSignal`、
      // `AbortSignal.any`、`ctx.jobs.wait` 任何一处同步抛，已创建的监听器、定时器
      // 与 abort 撤销也必须被处置——声明提前，finally 带空值护栏。
      let interrupt;
      let lateWatch = null;
      let timer;
      let execWired = false;
      const execAbort = new AbortController();
      const raceAbort = new AbortController();
      const onExecAbort = () => execAbort.abort(exec.signal?.reason);
      try {
        // 唤醒信号必须被**标注名字**：竞速的其他分支都是 `{ name }` 形状，若直接
        // 拿它的 `{ kind }` 形状参与竞速，胜出者既没有 `name`（落到 RUNNING 分支），
        // 也不是 `{ status }`（输出校验会失败）。`via` 区分 user（interrupted 口径）
        // 与 notice/relay（运行句柄＋唤醒原因口径，§2.2）。
        interrupt = watchWakeSignal(ctx, exec.agent);
        const wakeSignal = interrupt.promise.then((signal) => ({
          name: 'wake', via: signal.via, summary: signal.summary
        }));
        // 迟到作答唤醒分支（专门通道，设计 §2.2）：本包迟到作答到达（插件事件 + 起始
        // 检查，watchLateAnswer）→ 提前返回运行句柄 + note——不误报
        // settled，控制权交还模型。
        lateWatch = watchLateAnswer(ctx, exec.agent);
        const lateSignal = lateWatch.promise.then((signal) => ({
          name: 'late-answer', summary: signal.summary
        }));
        // 两个控制器：`execAbort` 跟随工具自身的取消；`raceAbort` 在**竞速收敛后**
        // （`finally`，唤醒 / 预算到期 / 工具取消三条路径都会走到）撤销在途的
        // `jobs.wait`。撤销仍然必须：宿主 `settled` 事件带 `awaited` 旗标——
        // 被结算释放的活 waiter 算 awaited，tool-jobs 对 awaited 的结算**不再补发**
        // 完成通知（`dsh-jobs/lib/types/types.d.ts:193-202`、
        // `dsh-tool-jobs/lib/index.js:269`）。竞速收敛时本工具要么已把终态投影
        // 交还模型（此时留着 waiter 只会白吞一条本可免掉的通知），要么已放弃等待
        // （此时按规则"aborted before the settlement does not count"，通知照发，
        // 模型反而需要它）。abort 的 `uncount()` 语义宿主保留
        // （`dsh-jobs-local/lib/index.js:632/:643`）。
        const abortSignal = AbortSignal.any([execAbort.signal, raceAbort.signal]);
        if (exec.signal !== undefined) {
          exec.signal.addEventListener('abort', onExecAbort, { once: true });
          execWired = true;
        }
        // 工具自身被取消时必须让**等待**立即结束：否则这个调用会一直挂到预算耗尽，
        // 而它已经没有人需要了。注意这里只终止等待，不碰作业。
        //
        // 这个 promise 只会 reject，而且不会变成未处理拒绝：接线到竞速之间没有
        // await（全同步），race 挂接前不存在可拒绝窗口；挂接后由 `Promise.race`
        // 自带的 reject 处理接住（race 给每个成员同时挂 resolve 与 reject 两个
        // handler——但这不等于"race 消费了它"，语义上仍是未处理拒绝）。
        const cancelled = new Promise((_resolve, reject) => {
          execAbort.signal.addEventListener(
            'abort',
            () => reject(execAbort.signal.reason ?? new Error('aborted')),
            { once: true }
          );
        });

        const deadline = new Promise((resolve) => {
          timer = ctx.timer.timeout(() => resolve({ name: 'deadline' }), waitMs);
        });

        // 屏障：先查一次，作业可能早已结束（消除"订阅前已结束"的竞态；设计 §2.1——
        // 屏障发生在武装之后，屏障耗时计入总预算）。三分：`undefined`
        // （查询失败）报**可重试**错误——并入 unknownJob 会在宿主抖动时诱发副作用
        // 重跑；`null`（查无/不可见）才是 unknownJob。
        const barrier = snapshotOf(ctx, args.job_id, caller);
        if (barrier === undefined) {
          throw new Error(t(lang, 'error.queryFailed'));
        }
        if (barrier === null) {
          throw new Error(t(lang, 'error.unknownJob', { jobId: args.job_id }));
        }

        /** 把快照投影成终态结果。 */
        const settledResult = (snap) => {
          const cut = outputOf(ctx, args.job_id, caller, lang, config.maxResultChars, snap.status);
          return {
            status: snap.status,
            job_id: args.job_id,
            output: cut.text,
            truncated: cut.truncated,
            ...(snap.detail === undefined ? {} : { detail: snap.detail })
          };
        };

        if (TERMINAL.has(barrier.status)) return settledResult(barrier);

        // 先到检查（设计 §2.2，订阅之后无空窗）：等待开始前已到达的可处理消息立即
        // 交回。优先级：user 插话 → interrupted（专列在前）；本包迟到作答
        // （专门分支）→ lateArrived；其余 notice/relay → 运行句柄＋唤醒原因。
        // 排在终态判定之后——先到消息与已终态作业并存时完成结果优先；排在
        // jobs.wait 接线之前——不创建 waiter（不吞完成通知）。
        const earlyWake = classifyWake(preexistingWakeMessage(exec.agent));
        if (earlyWake !== null && earlyWake.via === 'user') {
          const waitedMs = elapsed();
          return {
            status: 'interrupted',
            job_id: args.job_id,
            waited_ms: waitedMs,
            note: interruptedPreexistingNote({
              lang,
              subject: `job ${args.job_id}`,
              resume: `async_wait_job(job_id="${args.job_id}", wait_ms=...)`
            })
          };
        }
        let earlyLate = [];
        try {
          earlyLate = unclaimedLateSources(exec.agent);
        } catch { /* getter 抛错按无先到——宁可多等一轮（与 watchLateAnswer 同向） */ }
        if (earlyLate.length > 0) {
          const waitedMs = elapsed();
          return {
            status: 'running',
            job_id: args.job_id,
            waited_ms: waitedMs,
            note: `${t(lang, 'wait.lateArrived', { summary: earlyLate[0].summary })} ${waitAgainNote({ lang, jobId: args.job_id, waitedMs, maxWaitMs: config.maxWaitMs })}`
          };
        }
        if (earlyWake !== null) {
          const waitedMs = elapsed();
          return {
            status: 'running',
            job_id: args.job_id,
            waited_ms: waitedMs,
            note: `${t(lang, 'wait.wokeByMessage', { summary: earlyWake.summary })} ${waitAgainNote({ lang, jobId: args.job_id, waitedMs, maxWaitMs: config.maxWaitMs })}`
          };
        }

        // `jobs.wait` 只取得剩余预算（设计 §2.1）；剩余不正时不调用（deadline 已到，
        // 不把零传给要求正超时的宿主帮助函数）。signal 只中断等待，不取消作业。
        const remaining = deadlineAt - monotonic();
        const candidates = [wakeSignal, lateSignal, deadline, cancelled];
        if (remaining > 0) {
          const settled = ctx.jobs.wait(args.job_id, remaining, caller, abortSignal)
            .then((snap) => ({ name: 'settled', snap }), () => ({ name: 'wait-aborted' }));
          candidates.push(settled);
        }
        const winner = await Promise.race(candidates);
        const waitedMs = elapsed();

        if (winner.name === 'settled' && TERMINAL.has(winner.snap?.status)) {
          return settledResult(winner.snap);
        }

        // **到期双源合并规则**：本地 `deadline` 与 `jobs.wait` 的超时
        // resolve 是同一个预算的两条到时信号。`jobs.wait` 超时是**resolve 回当时的
        // JobView**（到期不报错），view 仍可能是 running——它等价于"这次没等到"。
        // 任何一条信号先到都走同一分支，终态判定**只认复查快照**
        // （`jobs.list` 基的三分快照）。
        const timedOut = winner.name === 'settled' || winner.name === 'deadline';

        // 完成优先于唤醒（设计 §2.1）：终态复查，避免模型因唤醒而重复等待一个已完成的作业。
        // 复查的 `undefined`（查询失败）与 `null`（作业已不在可见清单——如属主处置
        // 中途移除）都是**状态未证实**（需求 §2.2.2）：下面的 running 出口换未证实
        // 文案并给重试出路，不得宣称"作业仍在运行"——把宿主查询抖动或清单消失写成
        // 确定状态就是对模型撒谎。user 插话的 interrupted 出口不受影响（"不受影响"
        // 指打断不停止作业，不是状态断言）。
        const latest = snapshotOf(ctx, args.job_id, caller);
        const recheckFailed = latest === undefined || latest === null;
        const againNote = () => (recheckFailed
          ? recheckFailedNote({ lang, jobId: args.job_id, waitedMs, maxWaitMs: config.maxWaitMs })
          : waitAgainNote({ lang, jobId: args.job_id, waitedMs, maxWaitMs: config.maxWaitMs }));

        if (latest !== undefined && latest !== null && TERMINAL.has(latest.status)) {
          const result = settledResult(latest);
          // 用户插话与终态并存（需求 §2.2.2）：终态详情（退出原因、丢失标记、
          // spill 找回线索）是一次性事实，整体替换即丢失——唤醒说明以附加行
          // 表达，两者并存。
          if (winner.name === 'wake' && winner.via === 'user') {
            const coexist = t(lang, 'detail.userArrivedFinished');
            return {
              ...result,
              detail: result.detail === undefined ? coexist : `${result.detail}\n${coexist}`
            };
          }
          return result;
        }

        if (winner.name === 'wake') {
          return winner.via === 'user'
            ? {
              status: 'interrupted',
              job_id: args.job_id,
              waited_ms: waitedMs,
              note: interruptedNote({
                lang,
                subject: `job ${args.job_id}`,
                waitedMs,
                resume: `async_wait_job(job_id="${args.job_id}", wait_ms=...)`
              })
            }
            : {
              status: 'running',
              job_id: args.job_id,
              waited_ms: waitedMs,
              note: `${t(lang, 'wait.wokeByMessage', { summary: winner.summary ?? '' })} ${againNote()}`
            };
        }

        // 唤醒交还（专门通道）：运行句柄 + 迟到作答 note（summary 含题号与
        // 作答摘要；通知正文按状态走 followup/inject 通道，在下一领取点进入
        // 上下文，需求 §4.4）。保留 wait-again 提示。信号源是插件事件 + 等待起始
        // 检查（watchLateAnswer）。
        if (winner.name === 'late-answer') {
          return {
            status: 'running',
            job_id: args.job_id,
            waited_ms: waitedMs,
            note: `${t(lang, 'wait.lateArrived', { summary: winner.summary ?? '' })} ${againNote()}`
          };
        }

        ctx.logger?.info?.(
          `${LOG_PREFIX} async_wait_job timed out: job=${escapeLogValue(args.job_id)} waitedMs=${waitedMs} budget=${waitMs} `
          + `reason=${timedOut ? 'budget' : winner.name}`
        );

        return {
          status: 'running',
          job_id: args.job_id,
          waited_ms: waitedMs,
          note: againNote()
        };
      } finally {
        if (typeof timer === 'function') timer();
        // 竞速已定，撤销在途等待，把 waiter 让出来（理由见上面 raceAbort 的注释）。
        raceAbort.abort(new Error('async-tools: wait concluded'));
        interrupt?.dispose();
        lateWatch?.dispose();
        if (execWired) exec.signal.removeEventListener('abort', onExecAbort);
      }
    }
  });
  tool.rebuildText = rebuildText;
  return tool;
}
