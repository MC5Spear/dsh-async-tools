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
 * 插话文案：等待被打断，且**工作对象不受影响**。
 *
 * 出处 `lib/text.js` 的 `note.interrupted`（两语逐字，zh :257 / en :104）：
 * `等待被打断：一条用户消息已到达，将出现在你的下一条输入里（已等待 {waitedMs} ms）。{subject} 仍在后台运行，完全不受影响。…`
 * `Wait interrupted: a user message has arrived and will appear in your next input (waited {waitedMs} ms). {subject} is still running in the background and is completely unaffected. …`
 *
 * 标记必须两语都认：agentLang 是设置项（需求 §5.3 两个独立语言开关），判据不能只在一种
 * 语言下成立。单语标记红的是语言，不是被测对象。
 */
export const WAIT_INTERRUPTED = /等待被打断|Wait interrupted/;
/**
 * 插话文案里"对象未受影响"的那半句（同上出处，两语逐字）。
 * ⚠️ `${subject}` 在"仍在后台运行"**之前**；该半句自身两语都连续，模式里的小间隙
 * 只是容错（英文「 and is 」、中文「，」）。
 */
export const SUBJECT_UNTOUCHED = /仍在后台运行[，\s]{0,3}完全不受影响|is still running in the background[\s\S]{0,12}completely unaffected/;

/**
 * `async_wait_agent` 的**结局**标记——三选一即可，两语都要认（agentLang 是设置项，
 * 与 `WAIT_INTERRUPTED` 同一条纪律：单语标记红的是语言，不是被测对象）。
 *
 * | 标记 | 出处（zh / en 同键） |
 * |---|---|
 * | `已不在运行中` / `is no longer observed running` | `lib/text.js` 的 `note.settled`（`settledNote`，两个渠道共用） |
 * | `已结束当前工作（状态转为空闲）` / `finished its current work (status turned idle)` | `lib/text.js` 的 `via.idle`（结算通知渠道） |
 * | `已有进展且当前不再处于运行态` / `made progress and is currently no longer in a running state` | `lib/text.js` 的 `via.recheck`（activity 复查渠道） |
 */
export const CHILD_SETTLED = [
  /已不在运行中|is no longer observed running/,
  /已结束当前工作（状态转为空闲）|finished its current work \(status turned idle\)/,
  /已有进展且当前不再处于运行态|made progress and is currently no longer in a running state/
];

/**
 * `async_wait_job` 的**结局**标记：取回的是终态输出。
 *
 * 出处 `lib/wait-job.js` 的 `settledResult`——终态时返回 `status` + `output`；
 * 端到端里可观察的稳定特征是输出末尾的退出码那行（`lib/output.js` 拼的）。
 */
export const JOB_SETTLED = /exit code: \d+/;

/** 等待预算到期（非终态）的文案。出处 `lib/text.js` 的 `note.waitAgain`
 *  （两语逐字，zh :255 / en :102）。 */
export const WAIT_AGAIN = /仍在运行（不受影响）|is still running \(unaffected\)/;

/**
 * `async_run` 超预算**让出句柄**的文案。出处 `lib/text.js` 的 `note.yield.running`
 * （两语逐字，zh :251 / en :98）。判据要认的半句：「命令/The command 仍在运行」。
 */
export const YIELD_RUNNING = /命令仍在运行|command is still running/;
