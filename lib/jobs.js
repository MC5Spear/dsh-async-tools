/**
 * `async_run` 工具：执行即注册 + 可打断的首次等待（需求 §2.2.1，设计 §3.1）。
 *
 * 执行形态（设计 §3.1）：提权审批 → 注册表准入（触顶时**进程未启动**，按需求
 * §2.2.1 给可读文案与出路）→ `run(job)` 内才启动进程（pwsh starter 先例）→ 首次等待＝五信号
 * 竞速（结算/插话/abort/迟到作答/预算，任何信号只结束等待不终止命令）。
 * 呈现（需求 §2.2.4）：`label`=命令原文、`progress` 行=描述、注册时点即任务面板可见。
 *
 * 宿主 API 要点：
 * - workingDirectory：审批之后、准入之前 `await ensure(exec.agent, exec.signal)`
 *   取会话**当前**有效目录（存在性检查与目录失效恢复由宿主侧承担，设计 §3.1），
 *   再按缺省→该目录、相对→以该目录为基、绝对→原样三分解析；ensure 失败或
 *   其后被取消都发生在零注册零启动之时，抛错即诚实拒绝；
 * - shell：`resolve` 保留、`await execute(spec)`，`onExpiry: 'none'` 显式声明
 *   （缺省是 `'kill'`，会让内置到期逻辑杀进程——与需求 §2.2.1「不设置后台命令的
 *   绝对寿命时限」冲突）；execute 另收
 *   **作业私有** signal（prep 窗口 kill）——不是 `exec.signal`
 *   （工具 abort 不得终止命令，需求 §2.2.1）；
 * - jobs：`JobSpec` 形状（`owner` 是 SessionId 且必有；输出经 `output` 拉式源
 *   进环形缓冲，`readOutput` 钩子不在该路径上）；
 * - 通知语义（设计 §2.3）：预算内结算的等待是活 waiter（awaited）→ 不补发；
 *   等待被撤销（uncount）→ 结算时完成通知照发（abort 后模型唯一的恢复通道）。
 *
 * @module dsh-async-tools/jobs
 */
import { isAbsolute, resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  ESCALATION_TARGETS, approveEscalation, escalationHintMarker,
  sandboxDenialMarker, validateEscalationArgs
} from '@deepseek-ai/dsh-sandbox';
import { LOG_PREFIX, resolveYield } from './config.js';
import { buildToolText } from './descriptions.js';
import { classifyWake, preexistingWakeMessage, unclaimedLateSources, watchLateAnswer, watchWakeSignal } from './interrupts.js';
import { inOwnPreset } from './ask-takeover.js';
import { escapeLogValue, truncate, yieldNote } from './output.js';
import { silentFailureNotes } from './silent-failure.js';
import { t } from './text.js';

/** startRefused 详情进模型侧的单行截断上限（需求 §6.2；完整原文进操作者日志）。 */
const REGISTER_DETAIL_LIMIT = 500;

/**
 * 严格加宽梯（宿主 `dsh-sandbox/lib/index.js:30-33` 的 `WIDER_MODES` 同表；
 * 除锚定宿主源码行号外，这里保留符号名以承接对它的引用）。需求 §6.1 要求非严格加宽
 * 一律在进程启动前可读拒绝；宿主助手对**同级**免审批直接放行（`:101` 早退），
 * 与本包口径不同——因此同级判定在本包委托宿主之前先做，不依赖宿主助手的差异行为。
 */
const WIDER_MODES = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access']
};

/**
 * 防护总开关的现值（需求 §6.3 作用域）：开关开**且**调用主体属于本包两预设
 * 之一才产生结果诊断。运行时范围判定与纪律组稿/接管判定同一条读取路径
 * （`lib/ask-takeover.js` 的 `inOwnPreset`：`sessions.get` → `stateOf('agentPreset')`）；
 * 服务缺席或读取失败一律视为不在范围（失效安全方向＝不产生诊断）。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - 生效配置（活视图）。
 * @param {string} subjectId - 调用主体（agent id；后台结算路径传作业 owner）。
 * @returns {boolean} 防护是否生效。
 */
function guardActiveFor(ctx, config, subjectId) {
  if (config.silentFailureGuard !== true) return false;
  return inOwnPreset({
    sessions: ctx.get('sessions'),
    sessionProjections: ctx.sessionProjections
  }, subjectId);
}

/**
 * 用宿主给出的会话当前有效目录解析本次 workdir（与内置 pwsh 同一规则：
 * 缺省→会话目录、相对→按其解析、绝对→原样）。
 *
 * `cwd` 来自 `workingDirectory.ensure`（设计 §3.1），不是会话头里的初始目录：
 * 会话内切目录后 ensure 返回新目录，投影直读做不到这一点，也不是有效性检查。
 *
 * @param {string | undefined} modelWorkdir - 模型传入的 workdir（可缺省）。
 * @param {string | undefined} cwd - 宿主 ensure 返回的会话当前有效目录。
 * @returns {string | undefined} 本次传给 shell.resolve 的 workdir。
 */
function resolveWorkdir(modelWorkdir, cwd) {
  if (modelWorkdir === undefined) return cwd;
  if (cwd !== undefined && !isAbsolute(modelWorkdir)) return resolve(cwd, modelWorkdir);
  return modelWorkdir;
}

/**
 * 增量累加器：`proc.readOutput()` 返回的是 `{ delta, lossy, stdoutSpillPath, stderrSpillPath }`
 * 形状的**增量**读（`ShellProcessRead` 形状，`types.d.ts:161-170`），
 * 不是字符串。累加得到的全量用于**完成分支**的输出与沙箱/落盘标记。
 *
 * 作业侧的输出不走这个累加器——`JobSpec.output` 挂的是
 * `proc.observed` 的非消费偏移读（互不抢字节，`dsh-shell/lib/types/types.d.ts:197-203`），
 * 注册表按自己的节奏泵进环形缓冲。累加器只服务"本次调用内完成"的路径。
 *
 * `lossy` 必须显式呈现：dsh 会在内存里丢弃超限输出并给出 spill 路径，
 * 静默丢弃字节比丢失全部输出更具误导性。**spill 路径也必须留住**——
 * 只说"输出被丢了"而不给出磁盘落点，模型没有任何办法把它找回来。
 */
function createCollector(proc) {
  let text = '';
  let lossy = false;
  // drain 自身的两类静默截断也置丢失旗标——读异常（`readOutput` 抛）与
  // 守卫触顶（`guard` 上界，极端输出量下循环让位）。它们与宿主的 `read.lossy`
  // 同性质（"更早/更多的字节没能进结果"），结算时必须给模型可见的丢失标记，
  // 出口走既有的 `isLossy()`（`jobOutcome` / `completedResult` 的 lossy 拼接自动吃到）。
  let drainLossy = false;
  let stdoutSpillPath;
  let stderrSpillPath;
  return {
    /**
     * 抽干当前可读的增量：反复读直到某次不再产出新内容。
     * 单次读只拿一个分块，只读一次会丢输出。
     */
    drain() {
      for (let guard = 0; guard < 10000; guard++) {
        let read;
        try {
          read = proc.readOutput?.();
        } catch {
          drainLossy = true;
          return;
        }
        if (read === undefined || read === null) return;
        if (typeof read === 'object') {
          if (typeof read.stdoutSpillPath === 'string' && read.stdoutSpillPath.length > 0) {
            stdoutSpillPath = read.stdoutSpillPath;
          }
          if (typeof read.stderrSpillPath === 'string' && read.stderrSpillPath.length > 0) {
            stderrSpillPath = read.stderrSpillPath;
          }
        }
        const delta = typeof read.delta === 'string' ? read.delta : typeof read === 'string' ? read : '';
        if (read.lossy === true) lossy = true;
        if (delta.length === 0) return;
        text += delta;
      }
      // 守卫触顶：还有可读字节但本轮让位（防止单次调用吞掉整个事件循环）。
      drainLossy = true;
    },
    /** 当前已累加的全量文本。 */
    text: () => text,
    /** 是否发生过内存丢弃（宿主环形丢弃或本侧 drain 截断）。 */
    isLossy: () => lossy || drainLossy,
    /** 已见过的输出落盘路径（没有则为空对象）。 */
    spill: () => ({
      ...(stdoutSpillPath === undefined ? {} : { stdoutSpillPath }),
      ...(stderrSpillPath === undefined ? {} : { stderrSpillPath })
    })
  };
}

/**
 * spill 提示句：区分"丢了但有落点"和"丢了且没有落点"。
 * 没有落点时**必须**说清楚，不能让模型以为磁盘上一定还有一份。
 * 文案取自双语表（`config.agentLang`）。
 */
function spillNote(collector, lang) {
  const paths = spillPaths(collector);
  if (paths.length === 0) {
    return t(lang, 'render.spillNone');
  }
  return t(lang, 'render.spillDisk', { paths: paths.join('; ') });
}

/**
 * UTF-8 里一个字符最多占几个字节。
 *
 * 用来把"字符预算"换算成 `JobSpec.outputLimitBytes` 期望的"字节预算"（该字段名与用法都是字节，
 * `dsh-jobs/lib/types/types.d.ts:130-134`）。取 3 而不是理论最大值 4：4 字节只出现在
 * 增广平面（astral plane；emoji 等），而 3 字节覆盖了 BMP 全部汉字——实际输出里最常见的宽字符情形。
 * 方向上也安全：给宽只是少截一点通知文本，给窄会把通知腰斩。
 */
const BYTES_PER_WORST_CHAR = 3;

/** 落点列表（`stdout: <路径>` / `stderr: <路径>`），没有则为空数组。 */
function spillPaths(collector) {
  const spill = collector.spill();
  return [
    spill.stdoutSpillPath === undefined ? undefined : `stdout: ${spill.stdoutSpillPath}`,
    spill.stderrSpillPath === undefined ? undefined : `stderr: ${spill.stderrSpillPath}`
  ].filter((line) => line !== undefined);
}

/**
 * 沙箱事实的标记行：拒绝时产出**拒绝标记**，并在组合声明了提权字段时
 * 追加**同轮提示**。
 *
 * ## 为什么必须有这个（需求 §6.1）
 *
 * 缺少时，`async_run` 的结果里**既没有沙箱标记、也没有提权提示**，而内置 `pwsh` 同等
 * 情形下两者都有。后果不是"少一行字"：模型看不到任何可自纠的线索，于是会
 * 换着法子瞎试（重跑、加管道、改 `2>&1`），而真正该做的是**原样重试一次并带上提权参数**。
 *
 * 提示只在 `escalationModes` 非空时给出——没有沙箱执行器时没有可提权的目标，
 * 提示会把人引向一条走不通的路（与 `pwsh` 同口径，`dsh-tool-pwsh:72`）。
 *
 * @param {object} proc - shell 句柄（`sandbox` 是"受约束进程结算后才盖章"的事实）。
 * @param {string[]} escalationModes - 本组合声明的提权目标。
 * @returns {string[]} 标记行（可能为空）。
 */
function sandboxMarkers(proc, escalationModes) {
  const sandbox = proc?.sandbox;
  if (sandbox?.denied !== true) return [];
  const markers = [sandboxDenialMarker(sandbox.mode)];
  if (escalationModes.length > 0) markers.push(escalationHintMarker('command'));
  return markers;
}

/**
 * 把 shell 句柄投影成完成结果。
 *
 * @param {object} silent - 静默失败防线（需求 §6.3）的判定输入：`command`（命令文本）、`escalated`
 *   （本次是否走获批提权）、`guard`（开关现值）。缺省 = 防线不存在（关）。
 */
function completedResult(proc, collector, maxResultChars, escalationModes = [], lang = 'en', silent = {}) {
  const cut = truncate(collector.text(), maxResultChars, lang);
  // 沙箱标记与落盘提示都写进 `note`——模型只看得见 `render` 的输出，
  // 结构化 `value` 不进模型上下文。
  //
  // **没有内容时不能写 `note: ''`**：本文件对可空字段的口径是"没值就不写这个键"
  // （`exit_code` / `signal` 同上）。静默失败 note 同守此口径（需求 §6.3）：拼在
  // spill 标记与沙箱标记**之后**（与沙箱标记同位），空数组拼入 = 键不出现。
  const notes = [
    spillNoteIfLossy(collector, lang),
    ...sandboxMarkers(proc, escalationModes),
    ...silentFailureNotes({
      proc, collector,
      command: silent.command,
      escalated: silent.escalated,
      escalationModes,
      guard: silent.guard,
      lang
    })
  ]
    .filter((line) => line !== '');
  return {
    status: 'completed',
    // `exit_code` 与 `signal` 只在**真的是该类型**时才出现。
    //
    // `output.schema` 的 DSL 里 `type` 只接受**单个**类型串，写不出"可空"：
    // 若无条件写 `exit_code: proc.exitCode ?? null` 与 `signal: proc.signal ?? null`，
    // 而两者声明成 `{type:'number'}` / `{type:'string'}`，完成分支会**永远匹配 0 支**，
    // 宿主抛
    //   tool "async_run" returned invalid output: "value" must match exactly one oneOf branch (matched 0)
    // 也就是**任何没让出的 `async_run` 调用都会直接失败**。
    // 修法是"没值就不写这个键"——该 DSL 里属性
    // 默认可选，只有 `required: true` 的必须出现（设计 §3.1：返回结构保持可校验）。
    ...(typeof proc.exitCode === 'number' ? { exit_code: proc.exitCode } : {}),
    ...(typeof proc.signal === 'string' ? { signal: proc.signal } : {}),
    output: cut.text,
    truncated: cut.truncated,
    ...(notes.length === 0 ? {} : { note: notes.join('\n') })
  };
}

/** 内存丢弃时的落盘提示；没丢就没有这一行。 */
function spillNoteIfLossy(collector, lang) {
  return collector.isLossy() ? spillNote(collector, lang) : '';
}

/**
 * 完成分支要追加的**退出状态标记**，与内置 `pwsh` / `bash` 同一口径。
 *
 * | 情形 | 标记 |
 * |---|---|
 * | 干净退出（0、无信号） | **不产生标记**（与内置一致：成功不该有噪声） |
 * | 非零退出 | `[exit code: N]` |
 * | 信号杀死 | `[killed by signal: X]` |
 *
 * ## 为什么必须在这里产出（而不是只放在结构化 `value` 里）
 *
 * **模型只看得见 `output.render` 的输出**：`dsh-tools` 的 `createSuccessResult`
 * 用它的结果构造模型消息（`dsh-tools/lib/index.js:3540-3571`，render 调用 :3548，
 * `value` 与 `content` 分离），结构化 `value` 不进模型上下文。
 * 完成分支若只发 `output`，模型拿到一段文本、**无从判断命令是成功还是失败**——
 * 而内置 `pwsh` 同等情形下会给出 `[exit code: 1]`。真实结局必须产在 render 文本里
 * （需求 §2.2.3：非零退出和信号终止在模型可见文本中给出真实标记）。
 *
 * @param {object} value - 完成分支的结构化返回值。
 * @returns {string} 标记行（没有则空串）。
 */
function exitStatusMarker(value, lang) {
  if (typeof value.signal === 'string') return t(lang, 'render.killedBySignal', { signal: value.signal });
  if (typeof value.exit_code === 'number' && value.exit_code !== 0) {
    return t(lang, 'render.exitCode', { code: value.exit_code });
  }
  return '';
}

/**
 * 把 shell 句柄投影成作业结局（`JobHooks.done` 的解析值，宿主 `JobOutcome` 形状）。
 *
 * @param {object} silent - 静默失败防线判定输入（`command` / `escalated` / `guard`）。
 *   `guard` 由调用方（`startForegroundJob` 的 done 钩子）在**结算时刻**现读——
 *   开关语义是"下一次生效"，结算读 = 与下一次调用同批；`lang` 则冻结于注册时刻
 *   （两者的时点差是有意选择，设计 §6.2）。
 * @param {number} [maxResultChars] - killed 分支携带部分输出时的截断上限
 *   （缺省 30000 与配置默认一致，正式调用两处都显式传活配置）。
 */
function jobOutcome(proc, collector, escalationModes = [], lang = 'en', silent = {}, maxResultChars = 30000) {
  if (proc.status === 'killed') {
    // killed 分支与 completed 同款的两件事——丢失标记（drain 读失败/守卫
    // 触顶/宿主环形丢弃，旗标出口在这）与**部分输出**（让出窗口
    // 内已收到的字节进 `output`，与前台 completed 路径的信息量等齐；已注册路径
    // 完整输出仍走 `async_wait_job` 的 `jobs.read` 路径）。output schema 的 killed
    // 支因此可选携带 output/truncated。
    const paths = spillPaths(collector);
    const lossy = collector.isLossy()
      ? ` (${t(lang, 'detail.lossy')}${paths.length === 0 ? t(lang, 'detail.lossyNone') : t(lang, 'detail.lossyAt', { paths: paths.join('; ') })})`
      : '';
    const detail = [
      ...(proc.signal ? [t(lang, 'detail.signal', { signal: proc.signal })] : []),
      ...(lossy === '' ? [] : [lossy.trim()])
    ].join('');
    const raw = collector.text();
    // 有文才带 output/truncated——"没值就不写这个键"是本文件对可空字段的口径。
    const cut = raw.length === 0 ? undefined : truncate(raw, maxResultChars, lang);
    return {
      status: 'killed',
      ...(detail === '' ? {} : { detail }),
      ...(cut === undefined ? {} : { output: cut.text, truncated: cut.truncated })
    };
  }
  // 作业结局里也要给落点：`async_wait_job` 的终态分支把 `detail` 原样交给模型，
  // 只说"输出被丢了"而不给路径，等于让模型丢掉找回输出的唯一线索。
  const paths = spillPaths(collector);
  const lossy = collector.isLossy()
    ? ` (${t(lang, 'detail.lossy')}${paths.length === 0 ? t(lang, 'detail.lossyNone') : t(lang, 'detail.lossyAt', { paths: paths.join('; ') })})`
    : '';
  // 沙箱标记也要跟着作业结局走：让出之后的命令**同样**可能被沙箱拒绝，
  // 而那时模型是通过 `async_wait_job` 读到结果的（需求 §6.1）。
  const markers = sandboxMarkers(proc, escalationModes);
  // 静默失败 note 行拼在 detail 尾部（与前台出口同位语义，需求 §6.3）。
  const silentLines = silentFailureNotes({
    proc, collector,
    command: silent.command,
    escalated: silent.escalated,
    escalationModes,
    guard: silent.guard,
    lang
  });
  // 退出码标记与前台同一条规则（`exitStatusMarker`，需求 §2.2.3「首次返回和后台
  // 取回两条路径一致」）：正常退出不加标记（成功由"无失败标记"表达，与内置
  // pwsh 同口径）；非零退出才给真实标记。lossy 括注拼在退出码行尾（无退出码
  // 行时单独成行——它以 " (" 开头，本就是行尾追加形）。
  const exitMarker = typeof proc.exitCode === 'number' && proc.exitCode !== 0
    ? t(lang, 'detail.exitCode', { code: proc.exitCode })
    : '';
  const exitLine = `${exitMarker}${lossy}`;
  return {
    status: 'completed',
    detail: [...(exitLine === '' ? [] : [exitLine]), ...markers, ...silentLines].join('\n')
  };
}

/**
 * **执行即注册**（设计 §3.1）：准入通过后才启动进程的注册（宿主
 * `JobSpec` 形态）。宿主先做准入（`dsh-jobs-local/lib/index.js:419` 触顶 throw
 * 在 `:437` `spec.run(handle)` 之前），再同步回调 `run(job)`；进程在
 * `run` 内、准入之后才发起——与内置 `pwsh` 的 starter 先例一致。
 *
 * ## 形态要点
 *
 * 1. **`label` 是命令原文**（不截断，界面自行视觉截断——需求 §2.2.4）；
 *    **`progress` 行写 `description`**（`run(job)` 内一次写入，
 *    结算由宿主清除）——注册时点即任务面板可见（需求 §2.2.1）。
 * 2. **`owner` 是 SessionId**且**必有**——无 agent 语境在工具入口就被
 *    拒绝（无主作业不发完成通知，恢复通道断裂——需求 §2.2.1）。
 * 3. **输出走 `output` 拉式源，惰性取 `proc`**：注册先于进程启动，注册表泵
 *    可能先于 `execute` resolve——`proc` 未到位时读返回空增量
 *    （`nextOffset = from`，游标不动），注册表按自身节拍再泵。
 *    `proc` 到位后直读 `proc.observed`。
 * 4. **作业私有的 prep 窗口 cancel**：`execute` 收
 *    `controller.signal`（**不是** `exec.signal`——工具 abort 不得终止命令，
 *    需求 §2.2.1）；`cancel` 先 `controller.abort` 再 `proc?.kill()`，execute 未
 *    resolve 时 spawn 前中止（pwsh `processJob` 先例，
 *    `dsh-tool-pwsh/lib/index.js:100-126`）；done 链把「aborted 且 proc 未
 *    到位」归类为 `killed`——job_kill / owner teardown 在 prep 窗口不丢请求。
 * 5. **结算通知语义**（设计 §2.3）：`done` 由注册表耦合结算；预算内结算的
 *    等待是活 waiter（awaited）→ 不补发；等待被撤销（uncount）→ 结算时照发。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} p - 参数。
 * @param {object} p.config - 生效配置（jobKind / maxResultChars / agentLang / silentFailureGuard）。
 * @param {string} p.owner - 调用会话的 SessionId（必有）。
 * @param {string} p.command - 命令文本（label 原文 + 静默失败防线判定输入）。
 * @param {string} p.description - 命令描述（progress 行）。
 * @param {object} p.spec - `ctx.shell.resolve` 的产物（本函数在其上并入私有 signal）。
 * @param {string[]} [p.escalationModes] - 本组合声明的提权目标（沙箱拒绝时给不给同轮提示）。
 * @param {boolean} [p.escalated] - 本次是否走获批提权（提权跑的死法归提权语境）。
 * @returns {{ jobId: string, state: () => { proc?: object, procError?: unknown, collector?: object } }}
 *   作业 id 与进程槽位的惰性读取口（首次等待各分支要用）。
 * @throws {Error} 准入拒绝（触顶等）→ 可读可行动的 `error.startRefused`
 *   （此时**进程未启动**——没有可取消的东西，文案不得再说"命令在跑"）。
 */
export function startForegroundJob(ctx, {
  config, owner, command, description, spec, escalationModes = [], escalated
}) {
  const lang = config.agentLang;
  let proc;
  let procError;
  let collector;
  const controller = new AbortController();
  /** `proc` 未到位时的空增量读（游标不动，注册表下轮再泵）。 */
  const lazyRead = (channel, from) => {
    const observed = proc?.observed?.[channel];
    return observed === undefined
      ? { text: '', nextOffset: from, lossy: false }
      : observed.readFrom(from);
  };
  let jobId;
  try {
    jobId = ctx.jobs.start({
      kind: config.jobKind,
      // label=命令原文（内置 pwsh 先例 `label: args.command`）。
      label: command,
      owner,
      // 字段名里的量纲是**字节**，而配置预算是**字符**（`maxResultChars`）。
      // 换算取 `× 3`（BMP 汉字在 UTF-8 里上限 3 字节；4 字节只出现在增广平面，
      // 按罕见情形接受通知可能略早截断——取 3 而不是理论最大值 4 的理由见
      // `BYTES_PER_WORST_CHAR` 的说明）。这个字段只影响**通知文本**的截断，
      // 给窄会让模型拿到被腰斩的通知。宿主要求该值为正安全整数——
      // `maxResultChars` 的 schema 层 `.step(1)`＋`.min(1)` 已保证正整数（需求 §5.2），
      // 此处不再重复校验。
      outputLimitBytes: config.maxResultChars * BYTES_PER_WORST_CHAR,
      // 输出拉式源（惰性取 proc，理由见函数头第 3 条）。
      output: [
        { channel: 'stdout', read: (from) => lazyRead('stdout', from) },
        { channel: 'stderr', read: (from) => lazyRead('stderr', from) }
      ],
      run: (job) => {
        // 描述进 progress 行（活动期可见，结算由宿主清除）。
        job.updateProgress(description);
        // 进程在这里（准入之后）才发起；作业私有 signal 承载 prep 窗口的 kill。
        const procPromise = ctx.shell.execute({ ...spec, signal: controller.signal });
        // 槽位赋值走独立链（done 链不能承担"槽位尚未赋值"的竞态）。
        procPromise.then(
          (p) => { proc = p; collector = createCollector(p); },
          (error) => { procError = error; }
        );
        return {
          cancel: (reason) => {
            // 幂等（pwsh `processJob` 同款）：二次 cancel 直接返回。
            if (controller.signal.aborted) return;
            controller.abort(reason);
            try { proc?.kill(); } catch { /* 已退出 */ }
          },
          // `done` 不搬运输出（注册表自己 drain 拉式源）；这里 drain 一次累加器
          // 只为让 `jobOutcome` 的 lossy/spill 标记吃到进程咽气前的最后一批增量。
          // `proc.done` 宿主侧**从不 reject**；execute 的拒绝按 prep 窗口规则分类。
          // guard 在**结算时刻**现读 `config.silentFailureGuard`（config 是活视图）。
          done: procPromise.then(
            (p) => Promise.resolve(p.done).then(() => {
              collector.drain();
              return jobOutcome(p, collector, escalationModes, lang, {
                command,
                escalated,
                // 后台结算路径的防护作用域（需求 §6.3）：主体＝作业 owner。
                guard: guardActiveFor(ctx, config, owner)
              }, config.maxResultChars);
            }),
            (error) => {
              // prep 窗口被 kill：spawn 前中止 → killed（pwsh `:118-122` 同款）；
              // 其余预备失败 → 抛给注册表转 failed（首次等待侧经 `procError`
              // 原样重抛——设计 §3.1：shell 准备错误与并发拒绝区分）。
              if (controller.signal.aborted && proc === undefined) {
                return {
                  status: 'killed',
                  detail: error instanceof Error ? error.message : String(error)
                };
              }
              throw error;
            }
          )
        };
      }
    });
  } catch (error) {
    // 准入失败必须**可读、可行动**（需求 §2.2.1：说明生效上限、存活作业和出路），
    // 而不是甩宿主原文。
    // 此刻**进程未启动**——没有可取消的命令，文案按"启动前被拒"口径。
    throw admissionRefusalError(ctx, owner, lang, error);
  }
  return { jobId, state: () => ({ proc, procError, collector }) };
}

/**
 * 准入拒绝的可读错误：宿主原文单行化 + 500 截断进模型侧（需求 §6.2），
 * 完整原文进操作者日志。**按实际原因区分**（设计 §3.1）：触顶（宿主容量
 * 报错带 `limit: N` 注记）才给触顶文案——上限、存活作业清单与 kill/等待
 * 出路；其余注册错误（预算换算、宿主校验拒绝等）原样可读上抛，不套触顶
 * 模板——否则模型会按"腾位"指引去 kill 无关作业，而真正的原因并没有
 * 那种出路。
 * @param {object} ctx - cordis 上下文。
 * @param {unknown} owner - 作业 owner（SessionId）。
 * @param {string} lang - 语言档。
 * @param {unknown} error - `ctx.jobs.start` 抛出的错误。
 * @returns {Error} 模型侧错误。
 */
export function admissionRefusalError(ctx, owner, lang, error) {
  const rawDetail = error instanceof Error ? error.message : String(error);
  // 宿主原文可能带换行与超长堆栈——单行化 + 截断后再进模型侧（需求 §6.2）。
  const flat = rawDetail.replace(/[\r\n\t]+/g, ' ');
  const detail = flat.length > REGISTER_DETAIL_LIMIT
    ? `${flat.slice(0, REGISTER_DETAIL_LIMIT)} (+${flat.length - REGISTER_DETAIL_LIMIT})`
    : flat;
  ctx.logger?.warn?.(`${LOG_PREFIX} start refused before launch (full detail): ${rawDetail}`);
  const limitMatch = /limit:\s*(\d+)/.exec(rawDetail);
  if (limitMatch === null) {
    return new Error(t(lang, 'error.startRefusedPlain', { detail }));
  }
  const alive = listAliveJobs(ctx, owner);
  const limitNote = t(lang, 'error.currentLimit', { limit: limitMatch[1] });
  const aliveNote = alive.length === 0
    ? t(lang, 'error.noLiveJobs')
    : t(lang, 'error.liveJobs', { jobs: alive.join('; ') });
  return new Error(t(lang, 'error.startRefused', { limitNote, detail, aliveNote }));
}

/** 作业是否已经处于终态（`stopping` 是中间态，不算终态——设计 §2.4）。 */
export function isTerminalStatus(status) {
  return status === 'completed' || status === 'killed' || status === 'failed';
}

/**
 * 首次等待（让出窗口）＝五信号竞速（设计 §2.1/§2.2；与 `async_workflow` 共用本实现）。
 *
 * `ctx.jobs.wait` 一个调用承载三个成员：结算（终态 view resolve）、预算到期
 * （running view resolve）、工具 abort（reject "wait aborted"）；
 * 可处理消息唤醒（§2.2 集合；user 插话与 notice/relay，含先到扫描）与迟到作答
 * （专门通道，含起始检查）作为竞速成员并入——与 `async_wait_job` 同款组合。
 * 任何信号只结束等待，不终止命令/编排。`yield_ms` 从等待段开始即武装（§2.1）。
 *
 * 先订阅、后扫描（§2.2）：订阅与先到扫描之间没有空窗；先到消息命中时不创建
 * `jobs.wait` waiter（不吞完成通知）。
 *
 * 竞速定局后的两个动作（顺序即语义）：
 * 1. **撤销在先**：raceAbort 一次显式 abort——只摘 waiter，不碰作业。
 *    settle 胜出时这一发是无副作用的冗余 abort；撤销前 settle → 复查见终态走结算路径
 *    （awaited=true，与模型实收结果一致，不补发通知，设计 §2.3）；撤销后
 *    settle → waiter 已摘 → 通知照发（与句柄路径一致，abort 后模型唯一的
 *    恢复通道）。
 * 2. **完成优先复查**：撤销后读一次快照（jobs.list 三分），
 *    终态即走结算路径——防模型重复等待，与 wait 工具同一口径。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} exec - 工具执行上下文（signal / agent）。
 * @param {string} jobId - 作业 id。
 * @param {number} yieldMs - 首次等待预算（毫秒）。
 * @param {string} owner - 作业 owner（SessionId）。
 * @returns {Promise<{winner: object, snapshot: object|null}>} 竞速胜者
 *   （`wait` / `waitRejected` / `interrupted` / `message` / `late-answer`）
 *   与复查快照（查询失败按不可证处理：null，走句柄路径，通知不丢）。
 */
export async function raceFirstWait(ctx, exec, jobId, yieldMs, owner) {
  const raceAbort = new AbortController();
  const onExecAbort = () => raceAbort.abort(exec.signal?.reason);
  let interrupt = null;
  let lateWatch = null;
  let execWired = false;
  try {
    interrupt = watchWakeSignal(ctx, exec.agent);
    const wakeSignal = interrupt.promise.then((signal) => (
      signal.via === 'user'
        ? { name: 'interrupted' }
        : { name: 'message', summary: signal.summary }
    ));
    lateWatch = watchLateAnswer(ctx, exec.agent);
    const lateSignal = lateWatch.promise.then((signal) => ({
      name: 'late-answer', summary: signal.summary
    }));
    if (exec.signal !== undefined) {
      exec.signal.addEventListener('abort', onExecAbort, { once: true });
      execWired = true;
      // 已中止的信号挂监听永不触发。入口关卡到这里的窗口压成零：
      // 挂上监听后立即补一次显式触发（审批未决期间到达的 abort 不能只靠审批服务
      // 尊重 signal）。
      if (exec.signal.aborted) onExecAbort();
    }
    // 先到检查（设计 §2.2，订阅之后）：等待开始前已到达的信号立即交回——不创建
    // waiter（不吞完成通知）。优先级：user 插话 → interrupted；本包迟到作答
    // （专门分支）→ late-answer；其余 notice/relay → message（运行句柄＋
    // 唤醒原因口径）。
    const earlyWake = classifyWake(preexistingWakeMessage(exec.agent));
    let earlyLate = [];
    try {
      earlyLate = unclaimedLateSources(exec.agent);
    } catch { /* getter 抛错按无先到——宁可多等一轮（与 watchLateAnswer 同向） */ }
    let winner;
    if (earlyWake !== null && earlyWake.via === 'user') {
      winner = { name: 'interrupted' };
    } else if (earlyLate.length > 0) {
      winner = { name: 'late-answer', summary: earlyLate[0].summary };
    } else if (earlyWake !== null) {
      winner = { name: 'message', summary: earlyWake.summary };
    } else {
      // wait 的第四参是 raceAbort（exec.abort 已转发进它）——竞速定局后
      // 撤销它即可摘掉 waiter（只传 exec.signal 的话插话/迟到
      // 胜出时无从 uncount，完成通知会被吞）。
      const waitMember = Promise.resolve(
        ctx.jobs.wait(jobId, yieldMs, owner, raceAbort.signal)
      ).then(
        (view) => ({ name: 'wait', view }),
        (error) => ({ name: 'waitRejected', error })
      );
      winner = await Promise.race([waitMember, wakeSignal, lateSignal]);
    }

    // 撤销在先——竞速定局后的第一个动作（见函数头 1）。
    raceAbort.abort(new Error('async-tools: yield race concluded'));

    // 完成优先复查（见函数头 2）。
    let snapshot = null;
    try {
      snapshot = ctx.jobs.list(owner).find((job) => job?.id === jobId) ?? null;
    } catch { /* 查询失败按不可证处理：走句柄路径，通知不丢 */ }
    return { winner, snapshot };
  } finally {
    interrupt?.dispose();
    lateWatch?.dispose();
    if (execWired) exec.signal.removeEventListener('abort', onExecAbort);
  }
}

/**
 * 列出该 owner 当前**存活**（非终态）的作业，供准入拒绝的错误文案使用。
 *
 * 只读、失败即返回空数组：`ctx.jobs.list()` 抛错时**不能**让"生成错误文案"再抛一个错，
 * 那会把真正的原因（注册失败）盖掉，模型看到的就成了另一个不相干的故障。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {unknown} owner - 作业 owner（SessionId）。
 * @returns {string[]} 形如 `async-command-3 (running, "Sleep 60s")` 的描述。
 */
function listAliveJobs(ctx, owner) {
  try {
    const snapshots = ctx.jobs.list(owner);
    if (!Array.isArray(snapshots)) return [];
    return snapshots
      .filter((snapshot) => !isTerminalStatus(snapshot?.status))
      .map((snapshot) => {
        const label = typeof snapshot.label === 'string' && snapshot.label !== '' ? `, "${snapshot.label}"` : '';
        return `${String(snapshot?.id)} (${String(snapshot?.status)}${label})`;
      });
  } catch {
    return [];
  }
}

/**
 * 构造 `async_run` 工具定义。
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - 生效配置。
 * @returns {object} ToolDefinition。
 */
export function createRunTool(ctx, config) {
  // 提权目标：**只有挂载的执行器确实约束时**才非空。
  //
  // `ctx.shell.sandboxMode === undefined` 表示执行器不沙箱化，此时没有任何东西可提权，
  // 声明 `sandbox_permissions` 只会给模型一个永远失败的杠杆。与内置 `pwsh` 同口径。
  //
  // 对 `ctx.shell` 缺失要**容忍**：`shell` 在 `inject` 里，真实宿主上 apply 时必然
  // 已经就位；但测试替身可能先建工具、再补 `sandboxMode`。描述构建与执行期
  // 都走**现读**这一份，所以"某一刻读不到"只影响声明的保守程度，不影响提权能否走通。
  /** 现读的提权目标：参数表（含描述重建）与审批守卫都用它。 */
  const liveEscalationModes = () => (ctx.shell?.sandboxMode === undefined ? [] : ESCALATION_TARGETS);

  /**
   * 经 `ctx.approval` 解析一次提权请求——**在任何东西执行之前**。
   *
   * 本工具只提供两样东西：组合守卫（没有沙箱执行器时不声明这两个键，但 schema 校验
   * 只查声明过的键，所以**未声明的 `sandbox_permissions` 仍能到达 execute**——
   * 这里必须再挡一次）与审批配料。严格加宽、审批通道解析、结局映射这三步
   * 全部委托给共用的 {@link approveEscalation}，与内置 `pwsh` 逐字一致
   * （`EscalationApproval` 收 `agent: A | undefined`，agent 缺席
   * fail-closed，`dsh-sandbox/lib/types/escalation.d.ts:97-108`）。
   *
   * @param {string} mode - 请求的沙箱模式。
   * @param {string} justification - 一句话说明。
   * @param {object} exec - 工具执行上下文。
   * @param {object} standingPolicy - 本次调用当前的策略。
   * @returns {Promise<string>} 获批的模式。
   */
  const approveRunEscalation = (mode, justification, exec, standingPolicy) => {
    if (liveEscalationModes().length === 0) {
      throw new Error(t(config.agentLang, 'error.escalationUnavailable'));
    }
    // 非严格加宽：启动前可读拒绝（需求 §6.1）——同级不是加宽请求；更窄或
    // 不在加宽梯上的目标同样拒绝（宿主对这类目标也在启动前抛，本包先挡
    // 是为给出本包口径的双语可读文案；两类都零注册、零启动）。
    if (mode === standingPolicy.mode) {
      throw new Error(t(config.agentLang, 'error.escalationSameLevel', { mode }));
    }
    if (!(WIDER_MODES[standingPolicy.mode] ?? []).includes(mode)) {
      throw new Error(t(config.agentLang, 'error.escalationNotWider', {
        requested: mode, effective: standingPolicy.mode
      }));
    }
    return approveEscalation({
      requestedMode: mode,
      justification,
      effectiveMode: standingPolicy.mode,
      subject: 'command'
    }, {
      approver: ctx.get('approval'),
      agent: exec.agent,
      callId: exec.callId,
      toolName: 'async_run',
      signal: exec.signal
    });
  };

  // 描述经 `buildToolText` 整段构建（构造处与刷新处同一份）；`rebuildText` 供
  // `lib/index.js` 的 `refreshToolDescriptions` 在设置变更时重建——提权声明的
  // 条件分支在这里现读执行器状态。
  const rebuildText = (cfg) => buildToolText('async_run', cfg, { escalationModes: liveEscalationModes() });
  const text = rebuildText(config);

  const tool = defineTool({
    name: 'async_run',
    description: text.description,
    parameters: text.parameters,
    // 并发安全声明（批次调度语义）：未声明的工具是 exclusive 独占屏障——同批
    // 其他调用会被本工具的整个让出窗口（默认 20 s）串行挡住，恰好废掉「让
    // Agent 继续其他工作」的存在意义。本工具每次调用只注册独立作业、无跨调用
    // 共享可变状态，显式声明 true 进并行池（与三个等待工具同一口径）。
    isConcurrencySafe: () => true,
    output: {
      schema: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true, const: 'completed' },
            exit_code: { type: 'number' },
            signal: { type: 'string' },
            output: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
            note: { type: 'string' }
          }
        }, {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true, const: 'killed' },
            detail: { type: 'string' },
            output: { type: 'string' },
            truncated: { type: 'boolean' }
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
      // 模型只看得见 `render` 的输出（结构化 `value` 不进模型上下文）：
      // 退出状态标记与 `note` 都必须拼进可见文本。截断标注由 `truncate` 直接
      // 嵌在 `output` 正文里（双语带省略量），这里不再重复追加。
      // 语言档现读 `config.agentLang`（活视图，设置变更后下一次调用即换语言）。
      // killed 第三支（让出窗口内信号致死）——可见文本 =
      // detail（signal 细节 + 丢失标记）+ 有文时的部分输出，
      // 拼装次序与 completed 支同款。
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'running'
          ? value.note
          : value.status === 'killed'
            ? `${value.detail === undefined ? '' : `${value.detail}\n`}${value.output ?? ''}`
            : `${value.output ?? ''}`
              + (() => { const m = exitStatusMarker(value, config.agentLang); return m === '' ? '' : `\n${m}`; })()
              + (value.note === undefined ? '' : `\n\n${value.note}`)
      }]
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: args.command,
      description: args.description,
      ...(args.workdir === undefined ? {} : { cwd: args.workdir })
    }),
    async execute(args, exec) {
      const lang = config.agentLang;
      // 无 agent 语境 → 拒绝（不降级注册无主作业——
      // 无主不发完成通知，恢复通道恰在 abort 情形断裂；
      // 诚实拒绝 + 指明内置 pwsh 可用，需求 §2.2.1）。
      if (exec.agent?.id === undefined) {
        throw new Error(t(lang, 'error.noAgentRun'));
      }
      const owner = exec.agent.id;
      // 入口中止：作业未注册、进程未启动——什么都没发生，
      // 抛错即诚实；宿主把结果整体改写为 "Error: tool call aborted"。
      // 已中止的信号挂监听永不触发，不短路会空跑一次等待。
      if (exec.signal?.aborted) {
        throw new Error('tool call aborted');
      }
      const yieldMs = resolveYield(args.yield_ms, config);

      // 沙箱策略：只要执行器声明了约束，就必须随请求一起给出策略。
      // 取不到策略服务时与内置 pwsh 一致地 fail-fast，而不是静默地无约束执行。
      // `ctx.shell?.`——与 liveEscalationModes 的同款护栏（服务缺席时不应在这里 TypeError）。
      const sandboxMode = ctx.shell?.sandboxMode;
      let sandboxPolicy;
      if (sandboxMode !== undefined) {
        const policy = ctx.get('sandboxPolicy');
        if (policy === undefined) {
          throw new Error(t(lang, 'error.sandboxPolicyMissing'));
        }
        sandboxPolicy = policy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
      }

      // ── 单次提权（需求 §6.1）：**先问审批，再启动进程** ────────────────────
      //
      // 顺序是本条的全部要点。只做"读策略、服从策略"时，拿到的永远是会话当前
      // 模式（受限会话里就是 workspace-write），任何需要启动外部程序的命令都在
      // **进程创建层**被拒，且结果里没有任何可自纠的线索。
      //
      // `validateEscalationArgs` 在这里**无条件**调用（与 `pwsh` 一致）：它管的是
      // "两个键必须成对、justification 必须非空"这类 schema 表达不了的约束，
      // 未声明的键同样要挡。成对且非空时才真的去问审批。
      validateEscalationArgs(args.sandbox_permissions, args.justification);
      const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
        ? await approveRunEscalation(args.sandbox_permissions, args.justification, exec, sandboxPolicy)
        : undefined;
      // 审批返回后复查取消（需求 §6.1）：审批服务可能不尊重 signal——停止之后
      // 才返回 allowed-once 时，注册与启动必须仍为零，按取消原因拒绝（入口
      // 关卡的同一口径；此刻进程未启动，抛错即诚实）。
      if (exec.signal?.aborted) {
        throw new Error('tool call aborted');
      }
      // ── 会话当前有效目录（需求 §2.2.1、设计 §3.1）────────────────────────
      //
      // 先 `ensure` 再解析：宿主 working-directory 服务做存在性检查与目录失效
      // 恢复，返回会话**当前**有效目录——会话内切目录后这里是新目录，不是会话
      // 头里的初始目录；投影直读不是等价替代。位置在审批之后（与内置 pwsh 同
      // 次序）：ensure 自身的取消与失败都发生在零作业注册、零进程启动之时，
      // 抛错即诚实拒绝，绝不静默改在其他目录执行。
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      if (exec.signal?.aborted) {
        throw new Error('tool call aborted');
      }
      const workdir = resolveWorkdir(args.workdir, cwd);
      // 获批的模式只作用于**这一次调用**（`approveEscalation` 返回 `allowed-once`）。
      const policy = approvedMode === undefined ? sandboxPolicy : { ...sandboxPolicy, mode: approvedMode };

      // 已运行计时的原点＝注册（审批评审期间进程尚不存在——从入口计时会把
      // 评审时长冒充命令运行时长灌进「已运行约」注记；
      // 设计 §3.1：运行计时从批准后的启动阶段取得，不将审批计成命令已运行时长）。
      const t0 = Date.now();

      const spec = ctx.shell.resolve({
        command: args.command,
        ...(workdir === undefined ? {} : { workdir }),
        // 宿主托管的 `DSH_*` 变量必须显式随请求下发：执行器会先剔除环境里的全部
        // `DSH_*` 再合并这份快照，不传就等于把 DSH_HOME / DSH_SESSION_ID /
        // DSH_WEB_URL 从子进程里抹掉，与内置 pwsh 的语义不一致。
        dshEnv: ctx.shellEnv.collect(exec),
        ...(policy === undefined ? {} : { sandboxPolicy: policy }),
        // **显式 `onExpiry: 'none'`**（设计 §3.1）。缺省是 `'kill'`——内置到期
        // 逻辑会在 deadline 杀进程，与"首次等待到期不杀命令"（需求 §2.2.1）正面冲突。`'none'`
        // 下"the resolved timeoutMs arms no timer"（`dsh-shell/lib/types/types.d.ts:100-103`），
        // 等待结束与超时完全由本插件的竞速与显式 job_kill 承担。
        onExpiry: 'none'
        // 注意：不传 timeoutMs（`'none'` 下它不装 timer，只是回显）；也不传 `signal` ——
        // 工具调用的 abort **不得**杀死命令：让出后命令要活在后台
        // （"the handle stays valid after the caller stops waiting"，index.d.ts:28-30）。
      });

      // ── 执行即注册（准入先于进程启动，设计 §3.1）────────────────────────
      //
      // 注册在 execute 之前：宿主先准入（触顶时进程**尚未启动**，按需求 §2.2.1
      // 的可读文案处理），`run(job)` 回调里才发起进程（pwsh starter 先例）。owner 必有——
      // 入口已拒无 agent 语境（恢复通道=有主完成通知）。
      const started = startForegroundJob(ctx, {
        config,
        owner,
        command: args.command,
        description: args.description,
        spec,
        escalationModes: liveEscalationModes(),
        escalated: approvedMode !== undefined
      });
      const { jobId } = started;

      // ── 首次等待（让出窗口）＝五信号竞速
      // （与 `async_workflow` 同一份实现——行为由既有五信号用例看守）。
      const { winner, snapshot } = await raceFirstWait(ctx, exec, jobId, yieldMs, owner);

      const { proc, procError, collector } = started.state();
      const settleNow = (snap) => {
          // prep 失败（execute 拒绝且非 kill）：原样重抛原始错误
          // （设计 §3.1：shell 准备错误与并发拒绝区分）。
          if (proc === undefined) {
            if (snap.status === 'failed') throw (procError ?? new Error(snap.detail ?? 'preparation failed'));
            // prep 窗口被 kill（prep 窗口规则归类为 killed）：无进程无输出，killed 无文形态。
            if (snap.status === 'killed') {
              return { status: 'killed', ...(snap.detail === undefined ? {} : { detail: snap.detail }) };
            }
            // 防御闭合：done 只在 procPromise 链内结算，终态
            // completed 到达这里时 proc 必已赋值——若未来形态破坏该不变量，宁可
            // 炸出诊断也不静默返回没有输出的 completed。
            if (snap.status === 'completed') {
              throw new Error('registry settled completed before the process handle arrived');
            }
          }
          collector.drain();
          // 先判 killed——让出窗口内信号致死时 `proc.status` 是
          // `'killed'` 而 `done` 照常 resolve。
          if (proc.status === 'killed') {
            return jobOutcome(proc, collector, liveEscalationModes(), lang, {
              command: args.command,
              escalated: approvedMode !== undefined,
              guard: guardActiveFor(ctx, config, owner)
            }, config.maxResultChars);
          }
          // 静默失败防线（需求 §6.3）：`command` / `escalated` 传判定输入；`guard`
          // 现读活视图＋调用主体预设（作用域判定见 guardActiveFor）。
          return completedResult(proc, collector, config.maxResultChars, liveEscalationModes(), lang, {
            command: args.command,
            escalated: approvedMode !== undefined,
            guard: guardActiveFor(ctx, config, owner)
          });
        };

        // 完成优先于打断：wait 已带终态 view，或复查见终态 → 结算结果。
        if (winner.name === 'wait' && isTerminalStatus(winner.view?.status)) {
          return settleNow(winner.view);
        }
        if (winner.name !== 'wait' && snapshot !== null && isTerminalStatus(snapshot.status)) {
          return settleNow(snapshot);
        }

        // ── 句柄路径（插话 / 迟到作答 / abort / 预算到期）────────────────
        // 计时从 t0 起——t0 在准入**批准后、注册前**取值（见上方 `t0` 赋值处
        // 的说明：已运行计时的原点＝注册，从工具入口计时会把审批时长冒充
        // 命令运行时长），shell 解析与等待段都在其后；读数基是单一总预算
        // （设计 §2.1）。
        const elapsedMs = Math.max(0, Date.now() - t0);
        // abort 分支：宿主会把工具结果整体改写为 "Error: tool call
        // aborted"——模型看不到这个返回值；但必须返回合法形状，且
        // **作业必须存活**（不 kill、不 remove）：撤销后的 waiter 不算 awaited，
        // 结算时完成通知照发，那是 abort 后模型唯一的恢复通道。
        const mode = winner.name === 'interrupted'
          ? 'user'
          : winner.name === 'message' ? 'message'
          : winner.name === 'late-answer' ? 'late'
          // 取消与预算到期分别说明（需求 §2.1.2）：wait 的 reject 支是工具调用
          // 被取消，不是超出预算——内部结果按取消口径给原因。
          : winner.name === 'waitRejected' ? 'cancelled'
          : 'budget';
        ctx.logger?.info?.(
          `${LOG_PREFIX} async_run yielded: job=${jobId} yieldMs=${yieldMs} reason=${winner.name} label=${escapeLogValue(args.command)}`
        );
        return {
          status: 'running',
          job_id: jobId,
          elapsed_ms: elapsedMs,
          // `defaultWaitMs` 必须一起传：示例里的 `wait_ms` 取它，
          // 否则示例会与实际设置打架（见 `lib/output.js` `yieldNote` 的注释）。
          // `unverified`（设计 §2.5 证据分级）：复查快照缺席（查询失败或清单
          // 查无）时换未证实档文案——无当次快照支撑就不写「仍在运行」断言。
          note: yieldNote({
            lang, jobId, yieldMs, maxWaitMs: config.maxWaitMs, defaultWaitMs: config.defaultWaitMs,
            elapsedMs, mode, summary: winner.summary, unverified: snapshot === null
          })
        };
    }
  });
  tool.rebuildText = rebuildText;
  return tool;
}
