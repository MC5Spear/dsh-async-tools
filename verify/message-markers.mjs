/**
 * 判据用的**文案标记**——逐字取自 `lib/`，单一来源。
 *
 * ## 为什么要有这个文件
 *
 * 三个端到端脚本（`async-e2e` / `interrupt-e2e` / `wait-agent-e2e`）都要判断
 * "工具返回里那句话说了什么"，而它们的做法是**各自抄一份正则**。抄三份就是三个漂移点：
 * 实测已经发生——`interrupt-e2e` 与 `async-e2e` 抄的是能匹配的那一版，
 * 而 `wait-agent-e2e` 我新写的标记**与实现不符**（写成 `仍在运行`，
 * 真实文案是 `仍在后台继续运行`），于是判据红，**而工具行为完全正确**。
 *
 * ⇒ 文案标记**集中在这里**，逐条注明出处行号。改实现的文案时，
 * 这里会跟着暴露（判据变红），而不是让三个脚本各自沉默地失配。
 *
 * ## 取用的纪律
 *
 * - 每条标记**逐字来自 `lib/`**，注释写明出处；不要凭印象写。
 * - 只用**肯定句**当证据。`未结束`、`仍不在运行` 这类否定句命中宽模式时
 *   会给出相反的结论——它们不是结局证据。
 * - `settled` **没有统一措辞**：走结算通知与走 activity 复查是两套文案，
 *   标记必须覆盖实现的**每一条出口**。
 *
 * @module dsh-async-tools/verify/_scratch/../message-markers
 */

/**
 * 插话文案：等待被打断，且**工作对象不受影响**。
 *
 * 出处 `lib/output.js` 的 `interruptedNote`：
 * `等待被打断：用户插话已送达，它会作为你的下一条输入出现（已等待 ${waitedMs} ms）。${subject}仍在后台继续运行，没有受到任何影响。…`
 *
 * ⚠️ `${subject}` 会让"仍在"前面隔一个词（`作业 async-command-6 ` / `子代理 <uuid> `），
 * 所以模式必须容忍中间有内容。
 */
export const WAIT_INTERRUPTED = /等待被打断/;
/** 插话文案里"对象未受影响"的那半句（`lib/output.js` 的 `interruptedNote`）。 */
export const SUBJECT_UNTOUCHED = /仍在后台继续运行[\s\S]{0,20}没有受到任何影响/;

/**
 * `async_wait_agent` 的**结局**标记——三选一即可（实测命中的是第三条）。
 *
 * | 标记 | 出处 |
 * |---|---|
 * | `已不在运行中` | `lib/output.js:89`（`settledNote`，两个渠道共用） |
 * | `已结束当前工作（状态转为空闲）` | `lib/wait-agent.js:326`（结算通知渠道） |
 * | `已有进展且当前不再处于运行态` | `lib/wait-agent.js:328`（activity 复查渠道） |
 */
export const CHILD_SETTLED = [
  /已不在运行中/,
  /已结束当前工作（状态转为空闲）/,
  /已有进展且当前不再处于运行态/
];

/**
 * `async_wait_job` 的**结局**标记：取回的是终态输出。
 *
 * 出处 `lib/wait-job.js` 的 `settledResult`——终态时返回 `status` + `output`；
 * 端到端里可观察的稳定特征是输出末尾的退出码那行（`lib/output.js` 拼的）。
 */
export const JOB_SETTLED = /exit code: \d+/;

/** 等待预算到期（非终态）的文案。出处 `lib/output.js:59`。 */
export const WAIT_AGAIN = /已在后台继续执行|仍在运行（未受影响）/;
