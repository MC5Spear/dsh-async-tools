/**
 * 判据用的**文案标记**——逐字取自 `lib/`，单一来源。
 *
 * ## 为什么要有这个文件
 *
 * 多个真机脚本（`async-e2e` / `final-acceptance` / `probe-agent-e2e` /
 * `probe-queue-delivery` / `probe-queue-baseline`）都要判断"工具返回里那句话
 * 说了什么"。若各自抄一份正则，就是多个漂移点：标记与实现文案脱节时判据红，
 * **而工具行为完全正确**。
 *
 * ⇒ 文案标记**集中在这里**，逐条注明出处行号。改实现的文案时，
 * 这里会跟着暴露（判据变红），而不是让各脚本各自沉默地失配。
 *
 * ## 取用的纪律
 *
 * - 每条标记**逐字来自 `lib/`**，注释写明出处；不要凭印象写。
 * - 只用**肯定句**当证据。`未结束`、`仍不在运行` 这类否定句命中宽模式时
 *   会给出相反的结论——它们不是结局证据。
 * - `settled` **没有统一措辞**：走结算通知与走 activity 复查是两套文案，
 *   标记必须覆盖实现的**每一条出口**。
 *
 * @module dsh-async-tools/verify/message-markers
 */

/**
 * 插话文案：等待被打断，且**结束等待没有终止工作对象**。
 *
 * 出处 `lib/text.js` 的 `note.interrupted`（两语逐字；键名即锚，插行不漂）：
 * `等待被打断：一条用户消息已到达，将出现在你的下一条输入里（已等待 {waitedMs} ms）。结束等待没有终止 {subject} 的工作。…`
 * `Wait interrupted: a user message has arrived and will appear in your next input (waited {waitedMs} ms). Ending the wait did not stop {subject}. …`
 *
 * 标记必须两语都认：agentLang 是设置项（需求 §5.3 两个独立语言开关），判据不能只在一种
 * 语言下成立。单语标记红的是语言，不是被测对象。
 */
export const WAIT_INTERRUPTED = /等待被打断|Wait interrupted/;
/**
 * 插话文案里"结束等待没有终止工作对象"的那半句（同上出处，两语逐字）。
 * 行为陈述口径：只断言"结束等待"这个动作没有终止工作对象——等待被打断这一
 * 事件本身证明不了运行状态，故不匹配"仍在后台运行"类措辞。
 */
export const SUBJECT_UNTOUCHED = /结束等待没有终止[\s\S]{0,60}的工作|Ending the wait did not stop/;

/**
 * `async_wait_agent` 的**结局**标记——三选一即可，两语都要认（agentLang 是设置项，
 * 与 `WAIT_INTERRUPTED` 同一条纪律：单语标记红的是语言，不是被测对象）。
 *
 * | 标记 | 出处（zh / en 同键） |
 * |---|---|
 * | `不再被观察到在运行` / `is no longer observed running` | `lib/text.js` 的 `note.settled`（`settledNote`，两个渠道共用） |
 * | `完成了当前工作（状态转为 idle）` / `finished its current work (status turned idle)` | `lib/text.js` 的 `via.idle`（结算通知渠道） |
 * | `有进展，当前不处于运行态` / `made progress and is currently no longer in a running state` | `lib/text.js` 的 `via.recheck`（activity 复查渠道） |
 */
export const CHILD_SETTLED = [
  /不再被观察到在运行|is no longer observed running/,
  /完成了当前工作（状态转为 idle）|finished its current work \(status turned idle\)/,
  /有进展，当前不处于运行态|made progress and is currently no longer in a running state/
];

/**
 * `async_wait_job` 的**结局**标记：取回的是终态输出。
 *
 * 出处 `lib/wait-job.js` 的 `settledResult`——终态时在输出正文前拼一行终态状态行
 * （文案键 `render.jobStatus.<completed|failed|killed>` 在 `lib/text.js`，两语都有），
 * 这是三种终态**都出现**的稳定特征。输出末尾的退出码行（`lib/jobs.js` 的
 * `exitStatusMarker`/`exitLine`，文案键 `render.exitCode`/`detail.exitCode`）只标记
 * 非零退出的完成——成功零退出不带该行（与内置 pwsh 同口径），killed／failed 也
 * 不要求它；不能把退出码行当通用终态判据。
 */
export const JOB_SETTLED = /\[job (?:completed|failed|killed)\]|\[作业(?:已完成|失败|已终止)\]/;

/** 等待预算到期（非终态）的文案。出处 `lib/text.js` 的 `note.waitAgain`（两语逐字；键名即锚）。 */
export const WAIT_AGAIN = /仍在运行（不受影响）|is still running \(unaffected\)/;

/**
 * `async_run` 超预算**让出句柄**的文案。出处 `lib/text.js` 的 `note.yield.running`
 * （两语逐字；键名即锚）。判据要认的半句：「命令/The command 仍在运行」。
 */
export const YIELD_RUNNING = /命令仍在运行|command is still running/;

/**
 * 让出句柄句尾「没有被终止」半句。出处同上键（两语逐字；grep 全词典核实该短语
 * 仅此一键）——`lib/final-acceptance` 的句尾联用判据从这里取。
 */
export const NOT_TERMINATED = /没有被终止|was NOT terminated/;

/**
 * 首次等待被用户消息**提前结束**的注记。出处 `lib/text.js` 的
 * `note.yield.earlyByUser`／`note.yield.userUnverified`（两键共享首句，两语逐字）：
 * `The first wait ended early: a user message arrived…`／
 * `首次等待提前结束：有用户消息到达…`。探针 handle 形状判据用它。
 */
export const YIELD_EARLY_BY_USER = /The first wait ended early: a user message arrived|首次等待提前结束：有用户消息到达/;

/**
 * `async_workflow` 预算内结算的渲染头两半。出处 `lib/text.js` 的
 * `render.workflowCompleted`（两语逐字；en 复数占位 `{plural}` 渲染后由
 * `agents?` 双形态覆盖）：`workflow "…" completed (N agents).`／
 * `workflow「…」已完成（N 个子代理）。`＋`Return value:`／`返回值：`。
 */
export const WORKFLOW_COMPLETED = /workflow "[^"]+" completed \(\d+ agents?\)|workflow「[^」]+」已完成（\d+ 个子代理）/;
export const WORKFLOW_RETURN = /Return value:|返回值：/;

/**
 * 触顶准入拒绝的锚短语。出处 `lib/text.js` 的 `error.startRefused`／
 * `error.startRefusedPlain`（两键共含该短语，两语逐字；锚不含占位）。
 */
export const START_REFUSED = /refused before the process launched|进程启动前被拒绝/;

/**
 * `async_workflow` 使用条件的门槛短语。出处 `lib/text.js` 的
 * `tool.workflow.p2`（两语逐字；锚不含 `{defaultYieldMs}` 占位）。
 */
export const WORKFLOW_P2_PHRASE = /large multi-agent orchestration|大规模多代理编排/;

/**
 * `async_wait_agent` 被**用户消息唤醒**的文案。出处 `lib/text.js` 的
 * `wait.wokeByMessage`（两语逐字）。
 */
export const WAIT_WOKE_BY_MESSAGE = /A processable message arrived|一条可处理消息已到/;

/**
 * 迟到作答到达的句首子句。出处 `lib/text.js` 的 `wait.lateArrived`（两语逐字，
 * 单键）；迟到注入摘要取 `ask.lateSummary`（两语逐字，单键——锚取其共现短语）。
 */
export const LATE_ANSWER_ARRIVED = /A late answer has arrived|迟到作答已到/;
export const LATE_ANSWER_SUMMARY = /Late answer for|的迟到作答/;

/**
 * 信号终止终态的句干。出处 `lib/text.js` 的 `render.killedBySignal`
 * （两语逐字；方括号与 `{signal}` 占位在锚外）。
 */
export const KILLED_BY_SIGNAL = /killed by signal|被信号终止/;

// ── 宿主渲染锚（宿主文本，不随本包语言开关本地化）──────────────────────────

/**
 * `job_list` 工具结果里**目标作业仍在运行**的渲染行。宿主出处：列表 formatter
 * `` `${id} [${kind}] ${status} — ${label}` ``（dsh-tool-jobs）；作业编号由
 * dsh-jobs-local 生成（`${kind}-`＋16 位十六进制 UUID 片段，**不透明字符串**，
 * 锚不得假定数字编号）。行首锚＋渲染列分隔符 ` — ` 双边界：`label` 巧含
 * ` [async-command] running — ` 子串的非 running 行不会命中；`m` 标志支持多行
 * 工具结果文本中段匹配。`[async-command]` 类型标识的前提＝探针起跑把设置写回
 * 出厂默认（`jobKind: 'async-command'`）。
 */
export const JOB_LIST_RUNNING = /^\S+ \[async-command\] running — /m;

/**
 * 宿主**完成通知**的两半（恒英文，agentLang 不影响宿主文本）。宿主出处
 * dsh-tool-jobs：`` `background job ${job.id} (${job.kind}: ${label}) finished [status: …]` ``。
 * `HOST_JOB_FINISHED` 匹配**未截断**形态的宿主通知：`finished` 在宿主模板中
 * 对一切状态都在场（状态差异在 `[status: …]` 内）；compact/recovery 截断形态
 * 不含该词，omitted 形态只保留 detail 头部（`finished` 可能已被截去）。该锚
 * 不区分作业结局状态，按状态细分判据属独立评估。
 */
export const HOST_JOB_NOTICE = /\bbackground job \S+/;
export const HOST_JOB_FINISHED = /finished/;
