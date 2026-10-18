/**
 * `async_workflow` 工具：作业化的子代理编排（设计 §3.5，需求 §2.4）。
 *
 * 包装宿主 `ctx.workflowEngine.start`：script/meta/args 参数集合与宿主 `workflow`
 * 工具同形（schema 子集——无 `run_in_background`：构造上永远后台）；
 * 注册字段逐字段与宿主后台形态 `startBackgroundRun` 保持一致，仅 kind 与
 * 调用方不同。执行形态与 `async_run` 同构（设计 §3.1）：
 *
 * 1. 无 agent 语境 → 拒绝（口径：恢复通道=有主作业的完成
 *    通知，降级无主注册会在 abort 情形下断裂——需求 §2.4）；
 * 2. 入口中止 → 诚实抛错；
 * 3. 服务在位：`ctx.get('workflowEngine')` 现读——**不加 inject**
 *    （服务缺席时工具仍注册；且引擎是 delegation 组内隔离服务，消费行必须
 *    落在组内，需求 §3.2）；
 * 4. 执行即注册：`ctx.jobs.start` 准入在前，引擎 run 在 `run(job)`
 *    内发起（不传 signal——abort 不接 `run.cancel`，取消走 job_kill）；
 * 5. 首次等待＝五信号竞速：与 `async_run` 同一份 `raceFirstWait`
 *    （结算/插话/abort/迟到作答/预算，任何信号只结束等待不杀 run）；
 * 6. 结算两用闭包暂存：注册表收**原始返回值串**（`jobs.read` 的取文会消费
 *    一次性 `resultDelivered`，dsh-jobs-local `:601-602`），直接结算路径用
 *    头部说明＋一次裁剪的显示文本（settleNow 不经 read）；
 *
 * 记录侧：宿主的 recorder/mirror 是闭包私有（未导出，
 * dsh-tool-workflow `:19/:83`），但输入侧共享——引擎事件走 cordis 根级事件
 * 总线（`emitWorkflowEvent` → `ctx.events.dispatch`，dsh-workflow `:68-77`），
 * 会话档案按 `tool-workflow/run-start|agent-start|agent-end|run-end` 四类型
 * append（GUI 运行视图按记录类型确定性回放，不区分写入者插件）。本模块
 * 自建同款订阅：输出环 mirror（四类事件 → `job.append` channel 'log'——
 * 观察者叙述，模型 `job_output` 不渲染）＋ recorder（`session.append` 同型
 * 同载荷；append 失败按宿主同款处置：`logger.warn` + 该 run 永久停录）。
 *
 * @module dsh-async-tools/workflow
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LOG_PREFIX, resolveYield } from './config.js';
import { buildToolText } from './descriptions.js';
import {
  admissionRefusalError, isTerminalStatus, raceFirstWait
} from './jobs.js';
import { escapeLogValue, truncate, yieldNote } from './output.js';
import { t } from './text.js';

/**
 * 本工具的作业 kind。不用宿主的 `'workflow'`：完成通知前缀
 * `(kind: label)` 与命令作业（`async-command`）区分得开，且不冒充宿主作业；
 * `async_wait_job` 清单查找不筛 kind。
 */
const WORKFLOW_JOB_KIND = 'async-workflow';

/**
 * 结算渲染（**直接结算路径的显示文本**）：头部说明走 `render.workflowCompleted`
 * 双语键（en 档与宿主 `renderResult` 逐字同形，锚 `:198-202`，同形模板串在 `:201`），返回值超长按
 * `output.truncate` **保首尾**裁剪并带双语省略量标注（需求 §2.2.3/§2.4——六四
 * 分段与 `async_wait_job` 读取路径同款，尾部内容不得因首截断永久丢失）。头部
 * 说明是状态提示，按需求 §2.2.3 不占 `maxChars` 内容预算。
 *
 * 入参是**原始序列化值**（非 value 对象）：同一份原始串还作为作业 `result`
 * 注册进注册表，后台读取在 `async_wait_job` 侧对「增量＋result」整体只裁一次；
 * 这里再裁一次的是直接结算的显示文本——两条路径各自一次，不叠加。
 *
 * @param {string} name - `meta.name`。
 * @param {number} agentsStarted - 引擎启动的子代理数。
 * @param {string} rendered - 返回值的原始 JSON 序列化文本。
 * @param {number} maxChars - 结果字符上限（`maxResultChars`）。
 * @param {string} lang - 语言档（`agentLang`）。
 * @returns {string} 渲染文本。
 */
function renderWorkflowResult(name, agentsStarted, rendered, maxChars, lang) {
  const cut = truncate(rendered, maxChars, lang);
  return t(lang, 'render.workflowCompleted', {
    name, count: agentsStarted, plural: agentsStarted === 1 ? '' : 's'
  }) + cut.text;
}

/**
 * 把引擎结算映射到宿主 `jobOutcomeOf` 同款作业结局（宿主 `:178-196`）。
 * `agentLang` 的语言档在结算时刻现读；完成支的 detail 与显示文本都走双语键。
 *
 * 返回 `{ outcome, display }` 两用形（需求 §2.2.3 一次有效内容预算）：
 * - `outcome` 注册进注册表——完成支的 `result` 是返回值的**原始 JSON 串**，
 *   后台读取（`async_wait_job` 的 outputOf）对「增量＋result」整体裁一次；
 * - `display` 供直接结算路径（settleNow）返回——头部说明＋裁剪一次的文本。
 * 在此先把 result 裁成结算文本会让后台读取再裁一次，预算被实施两次
 * （完成头丢失、省略量按裁后残串重算）——所以注册侧必须存原始 JSON。
 *
 * @param {object} result - 引擎 run 的结算（`stopReason` / `agentsStarted` /
 *   `value` / `error`）。
 * @param {string} name - `meta.name`（渲染文本用）。
 * @param {number} maxChars - 结果字符上限。
 * @param {string} lang - 语言档（结算时刻的 `agentLang`）。
 * @returns {{outcome: object, display: string|undefined}} 作业结局与直接路径显示文本。
 */
function jobOutcomeOf(result, name, maxChars, lang) {
  switch (result.stopReason) {
    case 'completed': {
      const rendered = JSON.stringify(result.value, null, 2);
      return {
        outcome: {
          status: 'completed',
          detail: t(lang, 'detail.workflowAgents', {
            count: result.agentsStarted, plural: result.agentsStarted === 1 ? '' : 's'
          }),
          result: rendered
        },
        display: renderWorkflowResult(name, result.agentsStarted, rendered, maxChars, lang)
      };
    }
    case 'cancelled':
      // detail 交给注册表的 kill-reason 合并（cancel 时转发的就是同一字符串）。
      return { outcome: { status: 'killed' }, display: undefined };
    case 'error':
      return { outcome: { status: 'failed', detail: result.error ?? 'unknown error' }, display: undefined };
    // v8 ignore start -- 防御：stopReason 是封闭联合，未来变体在这里炸出声。
    default:
      return {
        outcome: { status: 'failed', detail: `workflow run ended abnormally (${String(result.stopReason)})` },
        display: undefined
      };
    // v8 ignore stop
  }
}

/**
 * 自建宿主同款的输出环 mirror（设计 §3.5）：订阅引擎生命周期事件，把活动
 * run 的进度写进对应作业卡。事件载荷形如 `(info, …)`，`info.id` 是 runId
 * （dsh-tool-workflow `:21-35` 同款过滤）。全部走 `channel: 'log'`——观察者
 * 叙述，模型的 `job_output` 不渲染；GUI 侧经 log 通道拿全过程。
 *
 * @param {object} ctx - cordis 上下文（事件总线；监听随 ctx 生命周期卸载）。
 * @returns {{start: (runId: string, job: object) => void, stop: (runId: string) => void}}
 *   逐 run 的接入/摘除口。
 */
function createWorkflowRecordMirror(ctx) {
  const active = new Map();
  ctx.on('workflow/phase', (info, title) => {
    const job = active.get(info.id);
    if (job === undefined) return;
    job.updateProgress(title);
    job.append(`▸ ${title}\n`, { channel: 'log' });
  });
  ctx.on('workflow/log', (info, message) => {
    active.get(info.id)?.append(`${message}\n`, { channel: 'log' });
  });
  ctx.on('workflow/agent-start', (info, agent) => {
    active.get(info.id)?.append(`agent #${agent.seq} ${agent.label} started\n`, { channel: 'log' });
  });
  ctx.on('workflow/agent-end', (info, agent) => {
    active.get(info.id)?.append(`agent #${agent.seq} ${agent.outcome}\n`, { channel: 'log' });
  });
  return {
    start(runId, job) { active.set(runId, job); },
    stop(runId) { active.delete(runId); }
  };
}

/**
 * 自建宿主同款的持久会话档案 recorder（设计 §3.5）：把活动 run 的四类记录
 * append 进父会话，GUI 运行视图按记录类型回放。append 失败按宿主同款处置：
 * `logger.warn` + **该 run 永久停录**（`active.delete`，dsh-tool-workflow
 * `:87-94/:104/:113`）——不是静默。
 *
 * @param {object} ctx - cordis 上下文。
 * @returns {{start: (session: object, run: object) => void,
 *   finish: (runId: string, stopReason: string) => void,
 *   abandon: (runId: string) => void}} 持久记录器的三个入口：start 挂账开录、
 *   finish 落终态记录并销账、abandon 只销账不补记录（run 已无落点）。
 */
function createWorkflowRecorder(ctx) {
  const active = new Map();
  const append = (session, type, data) => {
    try {
      session.append(type, data);
      return true;
    } catch (error) {
      ctx.logger?.warn?.(
        `${LOG_PREFIX} disabled durable record after ${type} append failed: ${String(error)}`
      );
      return false;
    }
  };
  ctx.on('workflow/agent-start', (info, agent) => {
    const session = active.get(info.id);
    if (session === undefined) return;
    if (!append(session, 'tool-workflow/agent-start', {
      runId: info.id,
      seq: agent.seq,
      label: agent.label,
      ...(agent.phase === undefined ? {} : { phase: agent.phase }),
      childId: agent.childId
    })) active.delete(info.id);
  });
  ctx.on('workflow/agent-end', (info, agent) => {
    const session = active.get(info.id);
    if (session === undefined) return;
    if (!append(session, 'tool-workflow/agent-end', {
      runId: info.id,
      seq: agent.seq,
      outcome: agent.outcome
    })) active.delete(info.id);
  });
  return {
    start(session, run) {
      if (append(session, 'tool-workflow/run-start', {
        runId: run.id,
        name: run.meta.name
      })) active.set(run.id, session);
    },
    finish(runId, stopReason) {
      const session = active.get(runId);
      if (session !== undefined) {
        append(session, 'tool-workflow/run-end', { runId, stopReason });
      }
      active.delete(runId);
    },
    abandon(runId) {
      active.delete(runId);
    }
  };
}

/**
 * 构造 `async_workflow` 工具定义。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - 生效配置（活视图；`agentLang` / `maxResultChars` /
 *   预算数字均现读）。
 * @returns {object} ToolDefinition。
 */
export function createWorkflowTool(ctx, config) {
  // 记录侧订阅挂在工具注册的 ctx 上（cordis 监听随 ctx 生命周期卸载，
  // 宿主同款做法——apply 时一次性挂、不显式 dispose）。
  const mirror = createWorkflowRecordMirror(ctx);
  const recorder = createWorkflowRecorder(ctx);

  const rebuildText = (cfg) => buildToolText('async_workflow', cfg);
  const text = rebuildText(config);

  const tool = defineTool({
    name: 'async_workflow',
    description: text.description,
    parameters: text.parameters,
    // 并发安全声明（批次调度语义）：未声明＝exclusive 独占——一次编排的整个
    // 后台生命周期会把同批其他调用全部串行挡住。编排只注册作业、子代理额度
    // 由宿主引擎约束，无跨调用共享可变状态，声明 true 进并行池（与
    // async_run/两个等待/async_agent 同一口径）。
    isConcurrencySafe: () => true,
    output: {
      schema: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true, const: 'completed' },
            result: { type: 'string', required: true }
          }
        }, {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true, const: 'killed' },
            detail: { type: 'string' }
          }
        }, {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true, const: 'running' },
            job_id: { type: 'string', required: true },
            elapsed_ms: { type: 'number', required: true },
            note: { type: 'string', required: true }
          }
        }]
      },
      // 模型只看得见 `render` 的输出：completed 支的渲染文本已含
      // agent 计数、返回值与截断标记（宿主 renderResult 同形）。
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'running'
          ? value.note
          : value.status === 'killed'
            ? (value.detail === undefined ? '' : `${value.detail}\n`)
            : value.result
      }]
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `workflow: ${args.meta.name}`,
      rawInput: args.script
    }),
    presentResult: () => ({ card: 'generic' }),
    async execute(args, exec) {
      const lang = config.agentLang;
      // 无 agent 语境 → 拒绝（理由同 async_run：恢复通道=有主完成通知）。
      if (exec.agent?.id === undefined) {
        throw new Error(t(lang, 'error.noAgentWorkflow'));
      }
      const owner = exec.agent.id;
      // meta.name 是作业标签：宿主 `jobs.start` 对空串抛「invalid job label」
      // （不带 `limit: N`），准入拒绝会走 startRefusedPlain——原样可读、明说
      // 不是并发上限、不给杀作业出路（lib/jobs.js 的 admissionRefusalError 按
      // `limit:\s*(\d+)` 分流，只有触顶才套 job_kill 模板）。这里仍前置拦下、
      // 给自解释错误：把参数问题留在参数层，比让模型去读宿主的注册表报错
      // 更直接（需求 §2.1.3：错误自解释；零进程、启动前拒绝不变）。
      if (typeof args.meta.name !== 'string' || args.meta.name.trim() === '') {
        throw new Error(t(lang, 'error.workflowEmptyName'));
      }
      // 入口中止：作业未注册、run 未启动——抛错即诚实；宿主把中止的工具调用
      // 整体改写为 "Error: tool call aborted"（与 async_run 入口同款，模型
      // 看到的是宿主改写通道的同串）。
      if (exec.signal?.aborted) {
        throw new Error('tool call aborted');
      }
      // 服务在位：现读，缺席 → 可读错误（工具仍注册；
      // 引擎是组内隔离服务——缺席与组外行同形，需求 §3.2）。
      const engine = ctx.get('workflowEngine');
      if (engine === undefined) {
        throw new Error(t(lang, 'error.workflowEngineMissing'));
      }
      const yieldMs = resolveYield(args.yield_ms, config);
      // t0 取工具入口（本工具无审批环节，入口即注册）。
      const t0 = Date.now();

      // 结算闭包暂存：done 链先映射、注册表后置终态——终态
      // view/snapshot 到达时暂存必已就位（async_run 的 state() 同款不变量）。
      let settled;

      // ── 执行即注册（准入先于引擎启动，设计 §3.5）────────────────────
      //
      // 引擎同步抛（META_INVALID/SCRIPT_PARSE——对"不能开始的请求"）发生在
      // `run(job)` 内：先存引用再原样重抛，外层 start 的 catch 命中原引用 →
      // 原样抛（诚实工具错误：什么都没跑、无作业）；否则按准入拒绝包装
      // （触顶文案按需求 §2.2.1）——防脚本解析错误冒充"启动前被拒"。
      let engineError;
      let jobId;
      try {
        jobId = ctx.jobs.start({
          kind: WORKFLOW_JOB_KIND,
          // label=meta.name（宿主后台既有取值）。
          label: args.meta.name,
          owner,
          run: (job) => {
            // 描述进 progress 行（结算由宿主清除）。
            job.updateProgress(args.meta.description);
            try {
              // 引擎 run 在这里（准入之后）发起；**不传 signal**：
              // abort 不接 run.cancel，真取消走 job_kill（宿主后台同款）。
              const run = engine.start({
                script: args.script,
                meta: args.meta,
                ...(args.args === undefined ? {} : { args: args.args }),
                parent: exec.agent
              });
              mirror.start(run.id, job);
              // recordsRun：宿主只让**顶层调用**写持久记录（[0.2.1-rc.2]
              // dsh-tool-workflow/lib/index.js:393/:406，`exec.parent === void 0`
              // 是 PTC 子调度标记）——子调度不写档（与宿主判定保持一致）。
              if (exec.parent === undefined) recorder.start(exec.agent.session, run);
              return {
                cancel: (reason) => {
                  run.cancel(reason ?? 'async workflow job killed');
                },
                done: run.result.then(async (result) => {
                  try {
                    await run.dispose();
                  } catch (error) {
                    ctx.logger?.warn?.(
                      `${LOG_PREFIX} workflow run ${run.id} dispose failed: ${String(error)}`
                    );
                  }
                  mirror.stop(run.id);
                  // finish/abandon 同收进 recordsRun 的启用条件（[0.2.1-rc.2]
                  // dsh-tool-workflow/lib/index.js:237-252/:427-433 同条件——
                  // 子调度下三处都是空操作，条件与宿主保持同形，
                  // 防 active 语义演化时漂移）。
                  if (exec.parent === undefined) {
                    recorder.finish(run.id, result.stopReason);
                    recorder.abandon(run.id);
                  }
                  const mapped = jobOutcomeOf(result, args.meta.name, config.maxResultChars, config.agentLang);
                  settled = mapped;
                  // 注册表收原始值（outcome）；直接路径的显示文本在 display。
                  return mapped.outcome;
                })
              };
            } catch (error) {
              engineError = error;
              throw error;
            }
          }
        });
      } catch (error) {
        if (error === engineError) throw error;
        throw admissionRefusalError(ctx, owner, lang, error);
      }

      // ── 首次等待＝五信号竞速（与 async_run 同一份实现）─────────────────
      const { winner, snapshot } = await raceFirstWait(ctx, exec, jobId, yieldMs, owner, lang);

      const settleNow = (snap) => {
        // 防御闭合（与 async_run 同款不变量）：终态到达时 done 链必已映射。
        if (settled === undefined) {
          if (snap.status === 'killed') {
            return { status: 'killed', ...(snap.detail === undefined ? {} : { detail: snap.detail }) };
          }
          throw new Error(snap.detail ?? 'workflow run settled before the outcome arrived');
        }
        if (settled.outcome.status === 'completed') {
          return { status: 'completed', result: settled.display };
        }
        if (settled.outcome.status === 'killed') {
          // detail 交给注册表的 kill-reason 合并（jobOutcomeOf cancelled 支）。
          return { status: 'killed', ...(snap.detail === undefined ? {} : { detail: snap.detail }) };
        }
        // failed 支抛错（与宿主前台 stopReasonError 同向——作业已
        // failed、通知照发（等待若已撤销），恢复通道一致）。
        throw new Error(settled.outcome.detail ?? 'workflow run failed');
      };

      // 完成优先于打断（设计 §2.3）：wait 已带终态 view，或复查见终态 → 结算
      // 结果；预算内结算的等待是活 waiter → 不补发通知。
      if (winner.name === 'wait' && isTerminalStatus(winner.view?.status)) {
        return settleNow(winner.view);
      }
      if (winner.name !== 'wait' && snapshot !== null && isTerminalStatus(snapshot.status)) {
        return settleNow(snapshot);
      }

      // ── 句柄路径（插话 / 迟到作答 / abort / 预算到期）────────────────
      // abort 分支：宿主把工具结果整体改写为 "Error: tool call
      // aborted"——模型看不到这个返回值；但必须返回合法形状，且
      // **run 必须存活**：撤销后的 waiter 不算 awaited，结算时完成通知照发，
      // 那是 abort 后模型唯一的恢复通道。
      const elapsedMs = Math.max(0, Date.now() - t0);
      const mode = winner.name === 'interrupted'
        ? 'user'
        : winner.name === 'message' ? 'message'
        : winner.name === 'late-answer' ? 'late'
        // 取消与预算到期分别说明（需求 §2.1.2）：wait 的 reject 支是工具调用
        // 被取消——与 async_run 同口径，不冒称超出预算。
        : winner.name === 'waitRejected' ? 'cancelled'
        : 'budget';
      ctx.logger?.info?.(
        `${LOG_PREFIX} async_workflow yielded: job=${jobId} yieldMs=${yieldMs} reason=${winner.name} label=${escapeLogValue(args.meta.name)}`
      );
      return {
        status: 'running',
        job_id: jobId,
        elapsed_ms: elapsedMs,
        note: yieldNote({
          lang, jobId, yieldMs, maxWaitMs: config.maxWaitMs, defaultWaitMs: config.defaultWaitMs,
          elapsedMs, mode, summary: winner.summary
        })
      };
    }
  });
  tool.rebuildText = rebuildText;
  return tool;
}
