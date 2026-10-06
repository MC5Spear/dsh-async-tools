/**
 * `async_wait_job` 工具：有界的作业等待，可被用户插话打断（设计 §5；0.1.7 契约 §22.2/§22.3）。
 *
 * 地基是宿主 `jobs.wait` 的关键语义：`jobs.wait` **只中断等待、不取消作业**。
 * 因此"打断等待 ≠ 打断工作"（R2/R4）直接由 dsh 既有能力提供。
 * 0.1.7 的 wait 语义（源码亲读）：**超时是 resolve**（带回当时的 JobView，可能是
 * 非终态）、abort 仅 reject `"wait aborted"`——错误分支比 0.1.5 少一类，
 * 但多出"resolve 回的 view 仍是 running"的判定。
 *
 * @module dsh-async-tools/wait-job
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LOG_PREFIX, resolveWait } from './config.js';
import { buildToolText } from './descriptions.js';
import { watchLateAnswer, watchUserInterrupt } from './interrupts.js';
import { escapeLogValue, interruptedNote, truncate, waitAgainNote } from './output.js';
import { t } from './text.js';

/**
 * 终态集合。0.1.7 新增中间态 `'stopping'`（kill 已请求、进程未收口）——
 * 它**不是**终态：此时返回 running 句柄是对的，模型再等一次即可。
 */
const TERMINAL = new Set(['completed', 'killed', 'failed']);

/**
 * 读取作业快照，三分返回（R29-c，`childOf` 同款先例）：`null` = 清单里没有
 * （查无或不可见），`undefined` = 查询本身失败。caller 是 SessionId。
 *
 * 建在 `jobs.list()` 而不是 `jobs.get()` 上：`get` 对未知 id **一律 throw**
 * （`unknown job <id>`），查询失败与查无从错误面上无法区分；`list(caller)` 只返回
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
 * 读取作业输出（终态时幂等）。0.1.7 的 `jobs.read` 返回 `{chunks, lossy, result?, job}`
 *——chunks 是环形缓冲里的分块（含全部 channel），拼接即全量文本。
 * `lossy` 为真时给一行前缀标记——被丢的是"更早的字节"，spill 线索在 `detail` 里
 * （`lib/jobs.js` 的 `jobOutcome` 已把落点写进 detail）。
 * 读失败**不**静默成空串（R29-c）：给一行可见标注、正文为空——把空串当真实输出
 * 会让模型误判命令产出；标注即"该重查"的出路。
 */
function outputOf(ctx, jobId, caller, lang) {
  let read;
  try {
    read = ctx.jobs.read(jobId, caller);
  } catch {
    return t(lang, 'render.readFailed');
  }
  const chunks = Array.isArray(read?.chunks) ? read.chunks : [];
  const text = chunks.map((chunk) => (typeof chunk?.text === 'string' ? chunk.text : '')).join('');
  return read?.lossy === true
    ? `${t(lang, 'render.lossyPrefix')}\n${text}`
    : text;
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
          // 截断标记与文案随 `agentLang` 现读。
          : `${value.output}${value.truncated ? `\n${t(config.agentLang, 'render.truncated')}` : ''}`
            + (value.detail === undefined ? '' : `\n\n${value.detail}`)
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const lang = config.agentLang;
      // 0.1.7：jobs 的 caller 是 SessionId（`exec.agent?.id`）；
      // 插话监听要的仍是**完整 agent 句柄**（`agent.inbox.nextStep` 回查）——两个变量。
      const caller = exec.agent?.id;

      // R29-b：入口已中止 → 立即 interrupted（不进屏障、不武装预算、不发查询、
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
      const t0 = Date.now();

      // 屏障：先查一次，作业可能早已结束（消除"订阅前已结束"的竞态）。
      // 三分（R29-c）：`undefined`（查询失败）报**可重试**错误——并入 unknownJob
      // 会在宿主抖动时诱发副作用重跑；`null`（查无/不可见）才是 unknownJob。
      const barrier = snapshotOf(ctx, args.job_id, caller);
      if (barrier === undefined) {
        throw new Error(t(lang, 'error.queryFailed'));
      }
      if (barrier === null) {
        throw new Error(t(lang, 'error.unknownJob', { jobId: args.job_id }));
      }

      /** 把快照投影成终态结果。 */
      const settledResult = (snap) => {
        const cut = truncate(outputOf(ctx, args.job_id, caller, lang), config.maxResultChars);
        return {
          status: snap.status,
          job_id: args.job_id,
          output: cut.text,
          truncated: cut.truncated,
          ...(snap.detail === undefined ? {} : { detail: snap.detail })
        };
      };

      if (TERMINAL.has(barrier.status)) return settledResult(barrier);

      // 接线段整体入 try/finally（R29-a， 防御性）：`watchUserInterrupt`、
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
        // 插话信号必须被**标注名字**：竞速的其他分支都是 `{ name }` 形状，若直接
        // 拿它的 `{ kind }` 形状参与竞速，胜出者就是 `{ kind: 'interrupted' }`——
        // 既没有 `name`（落到 RUNNING 分支），也不是 `{ status }`（输出校验会失败）。
        interrupt = watchUserInterrupt(ctx, exec.agent);
        const interruptSignal = interrupt.promise.then(() => ({ name: 'interrupted' }));
        // R30-d 唤醒分支（R3 信号分类第四类）：本包迟到作答到达（插件事件 + 起始
        // 检查，watchLateAnswer）→ 提前返回运行句柄 + note——不打断、不误报
        // settled，控制权交还模型。
        lateWatch = watchLateAnswer(ctx, exec.agent);
        const lateSignal = lateWatch.promise.then((signal) => ({
          name: 'late-answer', summary: signal.summary
        }));
        // 两个控制器：`execAbort` 跟随工具自身的取消；`raceAbort` 在**竞速收敛后**
        // （`finally`，插话 / 预算到期 / 工具取消三条路径都会走到）撤销在途的
        // `jobs.wait`。撤销仍然必须：0.1.7 的 `settled` 事件带 `awaited` 旗标——
        // 被结算释放的活 waiter 算 awaited，tool-jobs 对 awaited 的结算**不再补发**
        // 完成通知（`dsh-jobs/lib/types/types.d.ts:193-202`、
        // `dsh-tool-jobs/lib/index.js:269`）。竞速收敛时本工具要么已把终态投影
        // 交还模型（此时留着 waiter 只会白吞一条本可免掉的通知），要么已放弃等待
        // （此时按规则"aborted before the settlement does not count"，通知照发，
        // 模型反而需要它）。abort 的 `uncount()` 语义 0.1.7 保留
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
        // 自带的 reject 能力接住（race 给每个成员同时挂 resolve 与 reject 两个
        // handler——但这不等于"race 消费了它"，R2 审查 N8）。
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

        // signal 只中断等待，不取消作业。传入的 timeoutMs 与本地 deadline 同值。
        const settled = ctx.jobs.wait(args.job_id, waitMs, caller, abortSignal)
          .then((snap) => ({ name: 'settled', snap }), () => ({ name: 'wait-aborted' }));

        const winner = await Promise.race([
          interruptSignal,
          lateSignal,
          settled,
          deadline,
          cancelled
        ]);
        const waitedMs = Date.now() - t0;

        if (winner.name === 'settled' && TERMINAL.has(winner.snap?.status)) {
          return settledResult(winner.snap);
        }

        // **到期双源合并规则**（§22.3）：本地 `deadline` 与 `jobs.wait` 的超时
        // resolve 是同一个预算的两条到时信号。`jobs.wait` 超时是**resolve 回当时的
        // JobView**（到期不报错），view 仍可能是 running——它等价于"这次没等到"。
        // 任何一条信号先到都走同一分支，终态判定**只认复查快照**（R29-c 起为
        // `jobs.list` 基的三分快照）。
        const timedOut = winner.name === 'settled' || winner.name === 'deadline';

        // 完成优先于打断（设计 §5.2）：终态复查，避免模型因插话而重复等待一个已完成的作业。
        // 复查的 `undefined`（查询失败）落 running——`waitAgainNote` 本身就是
        // "可再次 async_wait_job"的重试出路，下一次调用重查自愈（R29-c 边界）。
        const latest = snapshotOf(ctx, args.job_id, caller);

        if (latest !== undefined && latest !== null && TERMINAL.has(latest.status)) {
          const result = settledResult(latest);
          return winner.name === 'interrupted'
            ? { ...result, detail: t(lang, 'detail.userArrivedFinished') }
            : result;
        }

        if (winner.name === 'interrupted') {
          return {
            status: 'interrupted',
            job_id: args.job_id,
            waited_ms: waitedMs,
            note: interruptedNote({
              lang,
              subject: `job ${args.job_id}`,
              waitedMs,
              resume: `async_wait_job(job_id="${args.job_id}", wait_ms=...)`
            })
          };
        }

        // 唤醒交还（R30-d 第四类）：运行句柄 + 迟到作答 note（summary 含题号与
        // 作答摘要；通知正文按状态走 followup/inject 通道，在下一领取点进入
        // 上下文，§32.5）。保留 wait-again 提示。信号源是插件事件 + 等待起始
        // 检查（watchLateAnswer，用户裁定）。
        if (winner.name === 'late-answer') {
          return {
            status: 'running',
            job_id: args.job_id,
            waited_ms: waitedMs,
            note: `${t(lang, 'wait.lateArrived', { summary: winner.summary ?? '' })} ${waitAgainNote({ lang, jobId: args.job_id, waitedMs, maxWaitMs: config.maxWaitMs })}`
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
          note: waitAgainNote({ lang, jobId: args.job_id, waitedMs, maxWaitMs: config.maxWaitMs })
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
