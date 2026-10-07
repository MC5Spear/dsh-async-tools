/**
 * 输出渲染与句柄文案（设计 §8、§4.3；R25：模型面文案随 `agentLang` 双语切换）。
 *
 * 两条硬约束：
 * - 句柄文案必须携带 job_id、可复制的调用示例，以及**实际生效**的预算数字（R1/R5）。
 * - 输出超限时保留头尾、标注省略量（R8）。
 *
 * ## 语言口径（§27.2）
 *
 * 本模块的返回值全部是模型面（会被 `render()` 进工具结果）：文案一律取自
 * `lib/text.js` 的双语表，`lang` 由调用方传入（工具里现读 `config.agentLang`）；
 * **数字与调用示例的形状留在构建逻辑里**，控制流不因语言而变。
 * 缺省 `lang` 回 `'en'`（英文是默认档，R22/R25）。
 *
 * @module dsh-async-tools/output
 */
import { t } from './text.js';

/**
 * 操作者日志插值的单行化（R29-f）：把 CR/LF/TAB 转成 `\r` `\n` `\t` 字面。
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

/** 裁剪输出：保留头尾并标注省略量。 */
export function truncate(text, maxChars) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (s.length <= maxChars) return { text: s, truncated: false, omitted: 0 };
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const omitted = s.length - maxChars;
  return {
    text: `${s.slice(0, head)}\n\n[output truncated: ${omitted} chars omitted]\n\n${s.slice(s.length - tail)}`,
    truncated: true,
    omitted
  };
}

/**
 * `async_run` 的让出句柄文案。必须能被模型直接照抄使用。
 * @param {object} p - 参数。
 * @param {string} [p.lang] - 语言档（缺省 `'en'`）。
 * @param {string} p.jobId - 已注册的作业 id。
 * @param {number} p.yieldMs - 本次生效的让出预算。
 * @param {number} p.maxWaitMs - 生效的等待上限。
 * @param {number} [p.defaultWaitMs] - 生效的**等待默认值**（示例里的 `wait_ms` 取它）。
 * @param {number} p.elapsedMs - 已运行时长。
 * @param {('budget'|'user'|'late')} [p.mode] - 让出原因：预算到期（缺省，开宗明义
 *   「超出了预算」）/ 用户插话提前让出（R32-c-b，注明因用户到达提前让出、命令
 *   不受影响）/ 迟到作答到达（R32-c-d，与 wait 工具同键同口径）。
 * @param {string} [p.summary] - `mode:'late'` 时的迟到作答摘要（题面）。
 * @returns {string} note 文本。
 */
export function yieldNote({ lang = 'en', jobId, yieldMs, maxWaitMs, defaultWaitMs = 30000, elapsedMs, mode = 'budget', summary }) {
  const opening = mode === 'user'
    ? t(lang, 'note.yield.earlyByUser', { elapsedMs })
    : mode === 'late'
      ? t(lang, 'wait.lateArrived', { summary })
      : t(lang, 'note.yield.running', { yieldMs, elapsedMs });
  return [
    opening,
    t(lang, 'note.yield.keepWorking'),
    // ⚠️ 示例里的 `wait_ms` 必须取**生效配置的默认值**，不能写死：参数可配置时，
    // 示例必须跟着配置走，否则模型照抄示例会拿到与设置打架的等待值（R1）。
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
 * 用户插话打断等待时的提示。必须写明"工作没有被影响"（R4）。
 *
 * R12 之后"打断"只可能来自**插话（steer）**——它落 `next-step`，会在步骤边界
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
 * 等待入口起始命中（R55）的提示：插话在等待开始前已到达，等待未开始。
 *
 * 与 `interruptedNote` 同形（subject 不受影响 + 重等提示），措辞区分到达
 * 时点（设计 §42.1 R55-D）。没有 `waitedMs` 参数——这条路径的等待从未
 * 武装，返回体里的 `waited_ms` 恒为 0。
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
 * `async_wait_agent` 结算时的提示：最终回答不在返回值里（设计 §6.3）。
 *
 * ⚠️ **措辞受 R3-1 口径 A 约束，不许写"已结束"**：`settled` 的判定可能来自
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
 * 让出预算描述片段（**只给 `async_run`**，R5）。
 *
 * `yield_ms` 是 `async_run` 独有的参数，其余工具的 `parameters` 里没有它，
 * 它们也不会"转后台"——共用这段等于告诉模型一个不存在的参数（R4 审查 #1）。
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
 * 等待预算描述片段（四个工具共用：`async_run` / `async_wait_job` / `async_wait_agent` / `async_agent`）。
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
