/**
 * 输出渲染与句柄文案（设计 §2.4；模型侧文案随 `agentLang` 双语切换，需求 §5.3）。
 *
 * 两条强制约束：
 * - 句柄文案必须携带 job_id、可复制的调用示例，以及**实际生效**的预算数字（需求 §2.2.1/§5.1）。
 * - 输出超限时保留头尾、标注省略量（需求 §2.2.3）。
 *
 * ## 语言口径（需求 §5.3）
 *
 * 本模块的返回值全部是模型侧文本（会被 `render()` 进工具结果）：文案一律取自
 * `lib/text.js` 的双语表，`lang` 由调用方传入（工具里现读 `config.agentLang`）；
 * **数字与调用示例的形状留在构建逻辑里**，控制流不因语言而变。
 * 缺省 `lang` 回 `'en'`（英文是默认档，需求 §5.2）。
 *
 * @module dsh-async-tools/output
 */
import { t } from './text.js';

/**
 * 操作者日志插值的单行化（需求 §6.2）：把 CR/LF/TAB 转成 `\r` `\n` `\t` 字面。
 *
 * 模型可控字符串（`args.description`、job_id、agent_id）拼进日志行时必须过这一道——
 * 否则一个带换行的参数就能伪造多行日志（把"看起来像系统输出"的内容插进操作者视野）。
 * 只动这三个控制字符：可见 Unicode 原样保留，日志可读性不降。
 *
 * @param {string} text - 待插值的原始字符串。
 * @returns {string} 单行化后的字符串。
 */
export function escapeLogValue(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/**
 * 裁剪输出：保留头尾并标注省略量。
 *
 * 标注行走 `render.truncated` 双语键（含省略量——需求 5.3：遗漏翻译不得静默显示
 * 另一语言，数字必须两档都在）。`lang` 缺省 `'en'`（英文是默认档）。
 */
export function truncate(text, maxChars, lang = 'en') {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (s.length <= maxChars) return { text: s, truncated: false, omitted: 0 };
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const omitted = s.length - maxChars;
  return {
    text: `${s.slice(0, head)}\n\n${t(lang, 'render.truncated', { omitted })}\n\n${s.slice(s.length - tail)}`,
    truncated: true,
    omitted
  };
}

/**
 * `async_run` 的首次等待到期返回的作业编号文案。必须能被模型直接照抄使用。
 * @param {object} p - 参数。
 * @param {string} [p.lang] - 语言档（缺省 `'en'`）。
 * @param {string} p.jobId - 已注册的作业 id。
 * @param {number} p.yieldMs - 本次生效的首次等待预算。
 * @param {number} p.maxWaitMs - 生效的等待上限。
 * @param {number} [p.defaultWaitMs] - 生效的**等待默认值**（示例里的 `wait_ms` 取它）。
 * @param {number} p.elapsedMs - 已运行时长。
 * @param {('budget'|'user'|'late'|'message'|'cancelled')} [p.mode] - 让出原因：预算到期（缺省，开宗明义
 *   「超出了预算」）/ 用户插话提前让出（注明因用户到达提前让出、命令
 *   不受影响）/ 迟到作答到达（与 wait 工具同键同口径）/ 可处理消息到达
 *   （设计 §2.2 唤醒集合的 notice/relay 类，不消费正文）/ 调用被取消
 *   （需求 §2.1.2：取消与预算到期分别说明，不冒称超出预算）。
 * @param {string} [p.summary] - `mode:'late'` 时的迟到作答摘要、`mode:'message'` 时的
 *   消息来源摘要（均可缺席——插值成空串）。
 * @returns {string} note 文本。
 */
export function yieldNote({ lang = 'en', jobId, yieldMs, maxWaitMs, defaultWaitMs = 30000, elapsedMs, mode = 'budget', summary }) {
  const opening = mode === 'user'
    ? t(lang, 'note.yield.earlyByUser', { elapsedMs })
    : mode === 'late'
      ? t(lang, 'wait.lateArrived', { summary })
      : mode === 'message'
        ? t(lang, 'wait.wokeByMessage', { summary })
        : mode === 'cancelled'
          ? t(lang, 'note.yield.cancelled', { yieldMs, elapsedMs })
          : t(lang, 'note.yield.running', { yieldMs, elapsedMs });
  return [
    opening,
    t(lang, 'note.yield.keepWorking'),
    // 示例里的 `wait_ms` 必须取**生效配置的默认值**，不能写死：参数可配置时，
    // 示例必须跟着配置走，否则模型照抄示例会拿到与设置打架的等待值（需求 §5.1）。
    `  async_wait_job(job_id="${jobId}", wait_ms=${String(defaultWaitMs)})`,
    t(lang, 'note.yield.cap', { maxWaitMs })
  ].join('\n');
}

/**
 * `async_wait_job` 超时后的提示。让模型知道"可以先去干别的"。
 * @param {object} p - 参数。
 * @param {string} [p.lang] - 语言档（缺省 `'en'`）。
 * @param {string} p.jobId - 作业 id。
 * @param {number} p.waitedMs - 本次实际等待时长。
 * @param {number} p.maxWaitMs - 生效的等待上限。
 * @returns {string} note 文本。
 */
export function waitAgainNote({ lang = 'en', jobId, waitedMs, maxWaitMs }) {
  return t(lang, 'note.waitAgain', { jobId, waitedMs, maxWaitMs });
}

/**
 * 用户插话打断等待时的提示。必须写明"工作没有被影响"（需求 §2.2.1）。
 *
 * "打断"只可能来自**插话（steer）**——它落 `next-step`，会在步骤边界
 * 被领取，与本工具结果**同批**进入模型的下一条输入。所以这里告诉模型
 * "插话就在你的下一条输入里"。
 * @param {object} p - 参数。
 * @param {string} [p.lang] - 语言档（缺省 `'en'`）。
 * @param {string} p.subject - 被打断的对象描述，例如 `job async-command-7`。
 * @param {number} p.waitedMs - 本次实际等待时长。
 * @param {string} p.resume - 恢复等待的建议调用。
 * @returns {string} note 文本。
 */
export function interruptedNote({ lang = 'en', subject, waitedMs, resume }) {
  return t(lang, 'note.interrupted', { subject, waitedMs, resume });
}

/**
 * 等待入口起始命中的提示：插话在等待开始前已到达，等待未开始。
 *
 * 与 `interruptedNote` 同形（subject 不受影响 + 重等提示），措辞区分到达
 * 时点（设计 §2.2：首等路径的先到消息同样立即交回）。没有 `waitedMs` 参数——这条路径的等待段从未
 * 进入：总截止虽在参数解析处武装过（单一总预算，设计 §2.1），起始命中在屏障/等待
 * 之前立即返回，`waited_ms` 只是解析段的墙钟噪声（毫秒级）。
 *
 * @param {object} p - 参数。
 * @param {string} [p.lang] - 语言档（缺省 `'en'`）。
 * @param {string} p.subject - 被打断的对象描述，例如 `job async-command-7`。
 * @param {string} p.resume - 恢复等待的建议调用。
 * @returns {string} note 文本。
 */
export function interruptedPreexistingNote({ lang = 'en', subject, resume }) {
  return t(lang, 'note.interruptedPreexisting', { subject, resume });
}

/**
 * `async_wait_agent` 结算时的提示：最终回答不在返回值里（设计 §3.4）。
 *
 * **措辞不许写"已结束"**：`settled` 的判定可能来自
 * 屏障读到"不再观察到它在运行"，那只表示观察证据，**不保证子代理真的结束了**。
 * 正确的口径是只陈述观察到什么，并告诉模型怎么拿到真正的结果。
 *
 * @param {object} p - 参数。
 * @param {string} [p.lang] - 语言档（缺省 `'en'`）。
 * @param {string} p.agentId - 子代理 id。
 * @returns {string} note 文本。
 */
export function settledNote({ lang = 'en', agentId }) {
  return t(lang, 'note.settled', { agentId });
}

/**
 * `async_wait_agent` 超时后的提示。必须与 job 版本分开：文案要指向 `async_wait_agent`，
 * 不能复用 job 的 `async_wait_job(job_id=…)`（会把模型引向一个不存在的调用）。
 * @param {object} p - 参数。
 * @param {string} [p.lang] - 语言档（缺省 `'en'`）。
 * @param {string} p.agentId - 子代理 id。
 * @param {number} p.waitedMs - 本次实际等待时长。
 * @param {number} p.maxWaitMs - 生效的等待上限。
 * @returns {string} note 文本。
 */
export function agentWaitAgainNote({ lang = 'en', agentId, waitedMs, maxWaitMs }) {
  return t(lang, 'note.agentWaitAgain', { agentId, waitedMs, maxWaitMs });
}

/**
 * 等待结束后**状态复查失败**时的提示（与 `waitAgainNote` 分开，需求 §2.2.2）。
 *
 * 这不是「仍在运行」的另一个说法：复查查询抛错时目标状态未证实，文案只陈述
 * 未证实并给重试出路——把未证实写成确定运行，就是在宿主出错时对模型撒谎。
 * @param {object} p - 参数。
 * @param {string} [p.lang] - 语言档（缺省 `'en'`）。
 * @param {string} p.jobId - 作业 id。
 * @param {number} p.waitedMs - 本次实际等待时长。
 * @param {number} p.maxWaitMs - 生效的等待上限。
 * @returns {string} note 文本。
 */
export function recheckFailedNote({ lang = 'en', jobId, waitedMs, maxWaitMs }) {
  return t(lang, 'note.recheckFailed', { jobId, waitedMs, maxWaitMs });
}

/**
 * `async_wait_agent` 状态复查失败时的提示（与 `agentWaitAgainNote` 分开，需求 §2.2.2）：
 * 只陈述"未能观察到、状态未证实"，不冒称仍在运行，指向 `async_wait_agent` 复查。
 * @param {object} p - 参数。
 * @param {string} [p.lang] - 语言档（缺省 `'en'`）。
 * @param {string} p.agentId - 子代理 id。
 * @param {number} p.waitedMs - 本次实际等待时长。
 * @param {number} p.maxWaitMs - 生效的等待上限。
 * @returns {string} note 文本。
 */
export function agentRecheckFailedNote({ lang = 'en', agentId, waitedMs, maxWaitMs }) {
  return t(lang, 'note.agentRecheckFailed', { agentId, waitedMs, maxWaitMs });
}

/**
 * 首次等待描述片段（`async_run` 的主描述专用，需求 §5.1）。
 *
 * 片段文案以**命令**为主体（超预算的命令转后台、按作业编号取回）。`async_workflow`
 * 同样有 `yield_ms` 与转后台行为，但它的描述用编排口径自行表述（`tool.workflow.p2`
 * 与 `param.workflow.yield_ms`）——两处数字同取生效配置，只是语境分开，不共用这段。
 *
 * @param {object} c - 生效配置（`agentLang` 现读取语言档）。
 * @returns {string} 描述片段。
 */
export function yieldDigest(c) {
  return t(c.agentLang, 'digest.yield', {
    defaultYieldMs: c.defaultYieldMs, minYieldMs: c.minYieldMs, maxYieldMs: c.maxYieldMs
  });
}

/**
 * 单次等待预算描述片段（供带等待语义的工具描述拼接：`async_run` / `async_wait_job` / `async_wait_agent` / `async_agent`）。
 *
 * 数字必须来自生效配置，且不允许通过配置关掉——
 * 数字**总是**来自生效配置。
 *
 * @param {object} c - 生效配置（`agentLang` 现读取语言档）。
 * @returns {string} 描述片段。
 */
export function waitDigest(c) {
  return t(c.agentLang, 'digest.wait', { minWaitMs: c.minWaitMs, maxWaitMs: c.maxWaitMs });
}
