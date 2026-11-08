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
 * 5. 首次等待＝三成员竞速（9.3.1 收紧）：与 `async_run` 同一份 `raceFirstWait`
 *    （结算/预算到期/调用取消，任何信号只结束等待不杀 run；提前结束只有终态、
 *    user 插话、取消、到期——非目标消息与迟到作答不提前结束）；
 * 6. 结算两用闭包暂存：注册表收**原始返回值串**（`jobs.read` 的取文会消费
 *    一次性 `resultDelivered`，dsh-jobs-local `readJob` `:631-636`），直接结算路径用
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
import { clampNote, ledger, terminalFacts, projectBatchEntry } from './delivery.js';
import {
  admissionRefusalError, isTerminalStatus, raceFirstWait
} from './jobs.js';
import { escapeLogValue, truncate, omittedMiddle, yieldNote } from './output.js';
import { t } from './text.js';

/**
 * 本工具的作业 kind。不用宿主的 `'workflow'`：完成通知前缀
 * `(kind: label)` 与命令作业（`async-command`）区分得开，且不冒充宿主作业；
 * `async_wait` 的作业清单查找不筛 kind。
 */
const WORKFLOW_JOB_KIND = 'async-workflow';

/**
 * 结算渲染（**直接结算路径的显示文本基底**）：头部说明走 `render.workflowCompleted`
 * 双语键（en 档与宿主 `renderResult` 逐字同形，锚 `:198-202`，同形模板串在 `:201`），
 * 后接返回值的**原始 JSON**，不做裁剪。裁剪只发生在直付出口（settleNow 按本批
 * 剩余份额、头部说明另计 `output.truncate` 保首尾裁剪并带双语省略量标注，需求
 * §2.2.3/§2.4——六四分段与 `async_wait` 读取路径同款，尾部内容不得因首截断
 * 永久丢失）。
 *
 * 入参是**原始序列化值**（非 value 对象）：同一份原始串还作为作业 `result`
 * 注册进注册表，后台读取在 `async_wait` 侧对「增量＋result」整体只裁一次；
 * 直接结算的显示文本在直付出口裁一次——两条路径各自一次，不叠加。
 */

/**
 * 把引擎结算映射到宿主 `jobOutcomeOf` 同款作业结局（宿主 `:178-196`）。
 * `agentLang` 的语言档在结算时刻现读；完成支的 detail 与显示文本都走双语键。
 *
 * 返回 `{ outcome, display, bodyOffset }` 两用形（需求 §2.2.3 一次有效内容预算）：
 * - `outcome` 注册进注册表——完成支的 `result` 是返回值的**原始 JSON 串**，
 *   后台读取（`async_wait` 的读取路径）对「增量＋result」整体裁一次；
 * - `display` 供直接结算路径（settleNow）返回——头部说明＋**未裁剪**的原始
 *   JSON；`bodyOffset` 标出正文（原始 JSON）在 `display` 中的起始位置，供
 *   直付出口把头部说明排除在份额之外。裁剪只发生在直付出口（按本批剩余
 *   份额、头另计，见 settleNow）；在此先把 result 裁成结算文本会让直付出口
 *   再裁一次，预算被实施两次（完成头丢失、省略量按裁后残串重算）——注册侧
 *   存原始 JSON 同理。
 *
 * @param {object} result - 引擎 run 的结算（`stopReason` / `agentsStarted` /
 *   `value` / `error`）。
 * @param {string} name - `meta.name`（渲染文本用）。
 * @param {string} lang - 语言档（结算时刻的 `agentLang`）。
 * @returns {{outcome: object, display: string|undefined, bodyOffset?: number}} 作业结局与直接路径显示文本。
 */
function jobOutcomeOf(result, name, lang) {
  switch (result.stopReason) {
    case 'completed': {
      // 防御：守卫包装保证 completed 的根值已定义；引擎契约若漂移成
      // completed＋undefined，按需求 §2.4.1 判失败，不渲染成字面 undefined。
      if (result.value === undefined) {
        return {
          outcome: { status: 'failed', detail: t(lang, 'error.workflowRootUndefined') },
          display: undefined
        };
      }
      const rendered = JSON.stringify(result.value, null, 2);
      const head = t(lang, 'render.workflowCompleted', {
        name, count: result.agentsStarted, plural: result.agentsStarted === 1 ? '' : 's'
      });
      return {
        outcome: {
          status: 'completed',
          detail: t(lang, 'detail.workflowAgents', {
            count: result.agentsStarted, plural: result.agentsStarted === 1 ? '' : 's'
          }),
          result: rendered
        },
        display: head + rendered,
        bodyOffset: head.length
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
 * 根值守卫包装（需求 §2.4.1「以 return 返回可 JSON 序列化值；无法序列化使编排
 * 失败」）：宿主引擎对根 `undefined` 有例外——进程内物化器原样放行（dsh-workflow-ptc
 * `materializeFromRealm`），跨进程结果载体又把 `undefined` 折成 `null`，显式
 * `return null` 与漏写返回值在引擎侧不可区分。本包按较严要求在交给引擎前把脚本
 * 包一层：内层异步函数取原脚本的完成值（顶层 `await`／顶层 `return` 语义不变），
 * 根值为 `undefined`（含无 return）就地在脚本层抛错，编排按运行错误失败；合法
 * `null`、普通对象与嵌套值不受影响（嵌套 `undefined` 仍由引擎物化器拒绝）。
 * 抛错文案由调用方按当前语言档传入（`error.workflowRootGuard`，模型可见）。
 *
 * @param {string} script - 模型侧脚本原文。
 * @param {string} guardMessage - 根值 undefined 时的抛错文案（双语键 `error.workflowRootGuard`）。
 * @returns {string} 带根值守卫的脚本。
 */
function wrapScriptWithRootGuard(script, guardMessage) {
  return `const ${ROOT_GUARD_VAR} = await (async () => {\n${script}\n})();\n`
    + `if (${ROOT_GUARD_VAR} === undefined) {\n`
    + `  throw new Error(${JSON.stringify(guardMessage)});\n`
    + `}\n`
    + `return ${ROOT_GUARD_VAR};`;
}

/** 根值守卫的内部变量名（脚本作用域可见，取不可猜的长名避免与用户脚本冲突）。 */
const ROOT_GUARD_VAR = '__dshAsyncWorkflowRootValue';

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
 * 导出给测试：根值守卫包装本体（B-SOL-01）。不导出时守卫语义只能靠引擎替身间接
 * 观察，而「undefined 根抛错／null 与对象通过」的正反判据都要求直接求值包装产物。
 */
export { wrapScriptWithRootGuard };

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
    // async_run／async_wait／async_agent 同一口径）。
    isConcurrencySafe: () => true,
    output: {
      schema: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true, const: 'completed' },
            result: { type: 'string', required: true },
            // 首次等待直付被批次份额裁剪时携带（保首尾，省略量在 result 文本内
            // 标注；省略中段经账本缓冲保留，可续段领取——9.3.2）。
            truncated: { type: 'boolean' }
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
            note: { type: 'string', required: true },
            // 交付批次附注（设计 §2.6；让出出口携带同一领取窗口就绪内容）。
            // 条目字段与 async_wait 出口保持一致（RA-YIELD-FACTS）：终态
            // 结构化字段 exit_code（仅非零）/signal/detail（诊断首行＋省略
            // 计数）已知才有；outputs 的 status_line 含标记行与诊断首行，
            // note 为读取失败/lossy/原文未附三态说明。echo/echo_truncated/
            // echo_kind＝完整命令回显附上的原文（ECHO-WORKFLOW-01，附上才有
            // 键；echo_kind 供 render 取标签行）。
            delivered: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  job_id: { type: 'string' },
                  status: { type: 'string' },
                  chars: { type: 'number' },
                  truncated: { type: 'boolean' },
                  exit_code: { type: 'number' },
                  signal: { type: 'string' },
                  detail: { type: 'string' }
                }
              }
            },
            outputs: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  job_id: { type: 'string' },
                  status_line: { type: 'string' },
                  exit_code: { type: 'number' },
                  signal: { type: 'string' },
                  detail: { type: 'string' },
                  // 读取失败/lossy/原文未附条目的说明（9.3.2 与 ECHO-WORKFLOW-01），
                  // 与等待出口同款。
                  note: { type: 'string' },
                  // 完整命令回显原文（ECHO-WORKFLOW-01，附上才有键）。
                  echo: { type: 'string' },
                  echo_kind: { type: 'string' },
                  echo_truncated: { type: 'boolean' },
                  text: { type: 'string' }
                }
              }
            },
            deferred: { type: 'array', items: { type: 'string' } },
            note_deferred: { type: 'string' }
          }
        }]
      },
      // 模型只看得见 `render` 的输出：completed 支的渲染文本已含
      // agent 计数、返回值与截断标记（宿主 renderResult 同形）；killed 支
      // detail 缺席时补两语终态状态行（设计 §3.1：无详情形态可见文本非空，
      // 不得渲染成空串——与 async_run 的 killed 渲染同口径）。
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'running'
          ? value.note + (Array.isArray(value.outputs) && value.outputs.length > 0
            ? `\n${value.outputs.map((item) => `── ${item.job_id} ──\n${item.status_line}${item.echo === undefined ? '' : `\n${t(config.agentLang, item.echo_kind === 'script' ? 'delivery.echoLabel.script' : 'delivery.echoLabel.command')}\n${item.echo}`}${item.text === '' ? '' : `\n${item.text}`}${item.note === undefined ? '' : `\n${item.note}`}`).join('\n\n')}`
            : '')
          : value.status === 'killed'
            ? (value.detail === undefined ? t(config.agentLang, 'render.jobStatus.killed') : `${value.detail}\n`)
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
          // label=meta.name（宿主后台既有取值），与完整命令回显开关无关
          // （ECHO-WORKFLOW-01：编排注册名称保持紧凑标识，脚本原文不经任务
          // 列表复制——原文经批次类交付载体附上，见下方 noteJobStarted）。
          label: args.meta.name,
          owner,
          run: (job) => {
            // 描述进 progress 行（结算由宿主清除）。
            job.updateProgress(args.meta.description);
            try {
              // 引擎 run 在这里（准入之后）发起；**不传 signal**：
              // abort 不接 run.cancel，真取消走 job_kill（宿主后台同款）。
              const run = engine.start({
                // 根值守卫（需求 §2.4.1）：宿主引擎把根 undefined 物化为 null、
                // 与显式 return null 不可区分——交给引擎前包一层，undefined 根值
                // 就地抛错、编排按运行错误失败（见 wrapScriptWithRootGuard）。
                script: wrapScriptWithRootGuard(args.script, t(lang, 'error.workflowRootGuard')),
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
                  const mapped = jobOutcomeOf(result, args.meta.name, config.agentLang);
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

      // ── 交付账本接线（设计 §2.3/§2.6；与 async_run 同款）────────────────
      // echoText＝工作流脚本原文（ECHO-WORKFLOW-01：注册时点无条件入账，展示
      // 由批次 echoOn 在装配时定值——首次等待直付不附：同一次模型输入已含
      // 调用参数里的 script 原文）。
      ledger.noteJobStarted(ctx, config, jobId, owner, { echoText: args.script, echoKind: 'script' });
      const waitToken = ledger.claimWait(owner);

      // ── 首次等待＝三信号竞速（9.3.1 收紧；与 async_run 同一份实现）─────────
      // 武装零号窗口（设计 §2.3）：首次等待自身的 waiter 即保活链零号窗口。
      ledger.noteFirstWaitArmed(jobId, yieldMs);
      let winner;
      let snapshot;
      try {
        ({ winner, snapshot } = await raceFirstWait(ctx, exec, jobId, yieldMs, owner, lang));
      } catch (error) {
        // 竞速自身异常：按让出口径交接保活链后原样上抛。注销链自身的异常只记
        // 日志——不得覆盖原始错误上抛（与 directSettleGuarded 同纪律）。
        ledger.takeOverChain(jobId);
        try {
          await ledger.releaseWait(waitToken, owner);
          ledger.closeBatchIfIdle(owner);
        } catch (releaseError) {
          ctx.logger?.warn?.(`${LOG_PREFIX} wait release failed after first-wait race error (registration may linger): ${String(releaseError?.message ?? releaseError)}`);
        }
        throw error;
      }

      const settleNow = (snap, limit) => {
        // 防御闭合（与 async_run 同款不变量）：终态到达时 done 链必已映射。
        if (settled === undefined) {
          if (snap.status === 'killed') {
            return { status: 'killed', ...(snap.detail === undefined ? {} : { detail: snap.detail }) };
          }
          throw new Error(snap.detail ?? 'workflow run settled before the outcome arrived');
        }
        if (settled.outcome.status === 'completed') {
          // 先分配再构造（设计 §2.6）：直付正文按本批剩余份额裁剪；被裁剪的
          // 省略中段原文由调用方经 pendingTail 交账本缓冲保留（续段可再交付）。
          // 状态头部说明不占正文预算（需求 §2.2.3「裁剪说明及必要的状态、诊断
          // 提示另计」）：头部按结算映射标出的 bodyOffset（缺省 0）整段保留，
          // 裁剪只施于正文——份额全部留给正文、省略量按正文计算。不能对整串
          // 按「份额＋头长」裁剪：那会把头部额度放进结果尾部（正文超出份额），
          // 份额较小时还会把头部本身切坏。
          const display = typeof settled.display === 'string' ? settled.display : String(settled.display ?? '');
          const bodyOffset = Number.isInteger(settled.bodyOffset) ? settled.bodyOffset : 0;
          const header = display.slice(0, bodyOffset);
          const body = display.slice(bodyOffset);
          if (body.length > limit) {
            const cut = truncate(body, limit, config.agentLang);
            return { status: 'completed', result: header + cut.text, truncated: true, bodyChars: cut.text.length };
          }
          return { status: 'completed', result: display, bodyChars: body.length };
        }
        if (settled.outcome.status === 'killed') {
          // detail 交给注册表的 kill-reason 合并（jobOutcomeOf cancelled 支）。
          return { status: 'killed', ...(snap.detail === undefined ? {} : { detail: snap.detail }) };
        }
        // failed 支抛错（与宿主前台 stopReasonError 同向——作业已
        // failed、通知照发（等待若已撤销），恢复通道一致）。
        throw new Error(settled.outcome.detail ?? 'workflow run failed');
      };

      // 省略中段原文（pendingTail 用）：与 settleNow 同一口径——裁剪只施于
      // 正文（bodyOffset 之后），中段按正文份额之外的部分保留。
      const middleOf = (limit) => {
        if (settled === undefined) return '';
        const display = typeof settled.display === 'string' ? settled.display : String(settled.display ?? '');
        const bodyOffset = Number.isInteger(settled.bodyOffset) ? settled.bodyOffset : 0;
        return omittedMiddle(display.slice(bodyOffset), limit);
      };

      // 完成优先于打断（设计 §2.3）：wait 已带终态 view，或复查见终态 → 结算
      // 结果；预算内结算的等待是活 waiter → 不补发通知。账面按「首次等待自身
      // 交付」结案（显示文本在 settleNow 直构，不经账本读取——设计 §2.3）；次序
      // 与 async_run 同款：先取本批剩余份额（openFirstWaitShare——并行直付合计
      // 不超单份预算），再按份额构造直付文本，再按实际交付字符计费、让位复查
      // 与关批；被份额裁剪时省略中段经 pendingTail 交账本缓冲保留（9.3.2 裁剪
      // 恢复）。settleNow 抛错时账本未登记，未交付不阻断。
      const directSettle = async (view) => {
        const share = ledger.openFirstWaitShare(owner, config);
        try {
          const direct = await settleNow(view, share);
          // bodyChars 是内部计费口径（正文长度，RA-WORKFLOW-BODY-BUDGET）——从
          // 返回值里摘出，不进 output.schema 的工具结果（oneOf 不认额外键）。
          const bodyChars = Number.isInteger(direct.bodyChars) ? direct.bodyChars : undefined;
          delete direct.bodyChars;
          const tailText = direct.truncated === true ? middleOf(share) : '';
          return { direct, tailText, share, ...(bodyChars === undefined ? {} : { bodyChars }) };
        } catch (error) {
          // 构造抛错也要结账：预留不退会吞掉整份批预算（RESULT-02 异常出口）。
          ledger.settleFirstWaitShare(owner, config, share, 0);
          throw error;
        }
      };
      // 结算构造失败时同步注销本次等待登记（RA-FIRSTWAIT-LEAK，与 async_run
      // 同款）：残留活等待压住同主体后续完成消息；后台 run 不误杀，注销自身
      // 失败只记日志、原始错误优先上抛。
      const directSettleGuarded = async (view) => {
        try {
          return await directSettle(view);
        } catch (error) {
          try {
            await ledger.releaseWait(waitToken, owner);
            ledger.closeBatchIfIdle(owner);
          } catch (releaseError) {
            ctx.logger?.warn?.(
              `${LOG_PREFIX} first-wait release after settle failure also failed: ${String(releaseError?.message ?? releaseError)}`
            );
          }
          throw error;
        }
      };
      if (winner.name === 'wait' && isTerminalStatus(winner.view?.status)) {
        const { direct, tailText, share, bodyChars } = await directSettleGuarded(winner.view);
        // 内容计费只按正文（RA-WORKFLOW-BODY-BUDGET）：状态头部按需求 §2.2.3
        // 「必要状态／诊断提示另计」不占份额——bodyChars 是 bodyOffset 之后的
        // 实际正文长度（被裁剪时为裁剪后长度），与 openFirstWaitShare/settle
        // FirstWaitShare 的正文口径一致；paidText 仍登记完整直付文本（含头部），
        // 恢复副本照实交回本载体实际携带的内容。
        await ledger.noteFirstWaitEnded(jobId, 'delivered', winner.view, bodyChars ?? direct.result?.length ?? 0,
          { ...(tailText === '' ? {} : { pendingTail: tailText }), reservedShare: share,
            paidText: direct.result ?? '', signal: exec.signal });
        await ledger.releaseWait(waitToken, owner);
        ledger.closeBatchIfIdle(owner);
        return direct;
      }
      if (winner.name !== 'wait' && snapshot !== null && isTerminalStatus(snapshot.status)) {
        const { direct, tailText, share, bodyChars } = await directSettleGuarded(snapshot);
        await ledger.noteFirstWaitEnded(jobId, 'delivered', snapshot, bodyChars ?? direct.result?.length ?? 0,
          { ...(tailText === '' ? {} : { pendingTail: tailText }), reservedShare: share,
            paidText: direct.result ?? '', signal: exec.signal });
        await ledger.releaseWait(waitToken, owner);
        ledger.closeBatchIfIdle(owner);
        return direct;
      }
      // 让出：同步交接保活链（设计 §2.3）。
      ledger.takeOverChain(jobId);

      // ── 句柄路径（插话 / abort / 预算到期）──────────────────────────
      // abort 分支：宿主把工具结果整体改写为 "Error: tool call
      // aborted"——模型看不到这个返回值；但必须返回合法形状，且
      // **run 必须存活**：撤销后的 waiter 不算 awaited，宿主结算通知照发；
      // 同时上方 takeOverChain 已把保活链接管在册（设计 §2.3），正文经本包
      // 完成消息或后续等待返回交付，未确认内容另有恢复副本（§2.6）——abort
      // 后模型不缺恢复通道。
      // mode 只有 user/cancelled/budget 三档（9.3.1 收紧：非目标消息与迟到作答
      // 不提前结束首次等待——与 async_run 同口径）。
      const elapsedMs = Math.max(0, Date.now() - t0);
      const mode = winner.name === 'interrupted'
        ? 'user'
        // 取消与预算到期分别说明（需求 §2.1.2）：wait 的 reject 支是工具调用
        // 被取消——与 async_run 同口径，不冒称超出预算。
        : winner.name === 'waitRejected' ? 'cancelled'
        : 'budget';
      ctx.logger?.info?.(
        `${LOG_PREFIX} async_workflow yielded: job=${jobId} yieldMs=${yieldMs} reason=${winner.name} label=${escapeLogValue(args.meta.name)}`
      );
      // 让出出口附交付批次（设计 §2.6；与 async_run 同款）。`carrierSignal`＝本次
      // 调用的 exec.signal（RA-YIELD-CARRIER-SIGNAL）——捎带正文随本载体装配，
      // 回合收尾据它复检宿主取消改写，缺信号会误确认并删除恢复副本。后续步骤
      // 抛错时按真实装配回滚（与 async_wait 出口同款防线）。
      const batch = ledger.collectBatch(owner, { triggerJobIds: [], lang, carrierSignal: exec.signal });
      let lastCollected = batch.delivered;
      try {
        await ledger.releaseWait(waitToken, owner);
        ledger.closeBatchIfIdle(owner);
      } catch (error) {
        ledger.undoClaim(owner, lastCollected);
        lastCollected = [];
        throw error;
      }
      const deferredNote = batch.deferredNote === '' ? '' : `\n${batch.deferredNote}`;
      // 编排首次等待同受 §2.5 证据分级（设计 §3.5）：jobs.list 抛错或快照
      // 查无按未证实档给句柄与复查出路，不宣称仍在运行；共享模板的主体
      // 称谓取「工作流」，编排不得误称命令。
      return {
        status: 'running',
        job_id: jobId,
        elapsed_ms: elapsedMs,
        note: `${yieldNote({
          lang, jobId, yieldMs, maxWaitMs: config.maxWaitMs, defaultWaitMs: config.defaultWaitMs,
          elapsedMs, mode,
          unverified: snapshot === null,
          kind: 'workflow'
        })}${deferredNote}`,
        // 延后条目结构化随行（设计 3.2.6；与 async_run 让出同口径）。
        ...(batch.deferred.length > 0 ? {
          deferred: batch.deferred,
          note_deferred: batch.deferredNote
        } : {}),
        ...(batch.delivered.length > 0 ? {
          delivered: batch.delivered.map((item) => ({
            job_id: item.jobId,
            status: item.terminal.status,
            chars: item.chars,
            truncated: item.truncated,
            ...terminalFacts(item.terminal, lang)
          })),
          // 条目投影＝delivery.projectBatchEntry（RA-YIELD-FACTS，与 async_run
          // 让出、统一等待、完成消息同一套必要结局线索；不增加批次内容预算）。
          outputs: batch.delivered.map((item) => projectBatchEntry(item, lang))
        } : {})
      };
    }
  });
  tool.rebuildText = rebuildText;
  return tool;
}
