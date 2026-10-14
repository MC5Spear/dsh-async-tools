/**
 * 静默失败陷阱的判定纯模块（需求 §6.3，设计 §6.2）。
 *
 * 只做判定，不进工具装配路径：`lib/jobs.js` 的两个结算出口（前台 `completedResult` /
 * 后台 `jobOutcome`）在开关开时调用这里，把 0 或 1 条 note 行拼进模型可见文案。
 *
 * 两条签名（需求 §6.3）：
 *
 * 1. **签名 1（条件式）**——四条件全部成立才出 note：捕获形启发式（无管道）+
 *    结算输出空白（纯空白算空）+ 受限执行且本次未提权 + 组合确有约束执行器。
 *    误发情形（纯 cmdlet `Get-ChildItem 2>&1` 空目录）按设计接受，
 *    由条件式措辞回退保护。
 * 2. **签名 2（直陈式）**——总开关 + 输出文本里**同对**出现两枚拒绝锚（EN 对或 ZH 对，
 *    单锚不触发）。语义是附加提示，不是第二套拒绝判定：不设捕获形/空白/受限/执行器之关卡。
 *
 * ZH 锚 `无法运行` / `拒绝访问` 是**判定常量**（未获实机语言环境验证的中文对，设计 §6.2
 * 注明未验证），与语言档无关——
 * 它们匹配的是**命令输出**，不是模型文案，所以住在本模块而非 `text.js`
 * （`tools/check-model-text.mjs` 源码层 ALLOWLIST 登记在案）。
 *
 * @module dsh-async-tools/silent-failure
 */
import { t } from './text.js';

/**
 * 签名 2 的锚对（EN 对为实测原文；ZH 对未获实机语言环境验证，设计先行收录）。
 * 大小写敏感；同对**两枚都出现**才算命中。
 */
export const DENIAL_ANCHOR_PAIRS = [
  ['failed to run', 'Access is denied'],
  ['无法运行', '拒绝访问']
];

/**
 * 签名 2：输出文本是否携带受限沙箱的可见拒绝签名（任一锚对两枚都在场）。
 * @param {string} text - 结算输出全文（`collector.text()`）。
 * @returns {boolean} 命中与否。
 */
export function hasDenialAnchors(text) {
  const haystack = typeof text === 'string' ? text : '';
  return DENIAL_ANCHOR_PAIRS.some(([a, b]) => haystack.includes(a) && haystack.includes(b));
}

/**
 * 签名 1 条件之一：命令文本是否带**捕获形**。
 *
 * 四模式任一命中即算，但整条命令**含管道则一票否决**（管道死法可见）：
 * - `2>&1`（显式首模式，实际被重定向模式包含，单列只是显式）；
 * - 子表达式捕获 `\$\(`；
 * - 变量赋值捕获（语句首锚定 `(^|[\r\n;])\s*\$Ident\s*=`，`if ($x -eq 1)` 不误中）；
 * - 输出重定向 `>`（一枚覆盖 `>` 与 `>>`）。
 *
 * 多语句命令按**命令文本整体**判（需求口径：任一语句命中即算）。
 * @param {string} command - 命令文本。
 * @returns {boolean} 是否捕获形（且无管道）。
 */
export function hasCaptureForm(command) {
  const text = typeof command === 'string' ? command : '';
  if (text.includes('|')) return false;
  if (text.includes('2>&1')) return true;
  if (/\$\(/.test(text)) return true;
  if (/(^|[\r\n;])\s*\$[A-Za-z_][A-Za-z0-9_]*\s*=/.test(text)) return true;
  if (/>/.test(text)) return true;
  return false;
}

/**
 * 静默失败 a 防线的判定总入口：产出 0 或 1 条 note 文案行。
 *
 * @param {object} p - 判定输入。
 * @param {object} [p.proc] - 结算的进程对象（`proc.sandbox` 只在约束执行器结算时打上，
 *   与 `sandboxMarkers` 同一盖章事实源；`denied: true` 表示沙箱标记已标记的拒绝结算）。
 * @param {{text: function(): string}} [p.collector] - 输出收集器（`text()` 取全文）。
 * @param {string} [p.command] - 命令文本（签名 1 用）。
 * @param {boolean} [p.escalated] - 本次是否走了获批提权（提权跑的死法归提权语境）。
 * @param {string[]} [p.escalationModes] - 本组合广告的提权目标（空 = 无约束执行器）。
 * @param {boolean} [p.guard] - 总开关现值（关 = 整条防线不存在）。
 * @param {string} [p.lang] - 语言档（`config.agentLang`；未知名由 `t` 回退 en）。
 * @returns {string[]} 0 或 1 条文案行。
 */
export function silentFailureNotes(p) {
  if (p.guard !== true) return [];

  // 签名 1：四条件缺一不可（需求 §6.3）。
  const proc = p.proc ?? {};
  const restrictedNotDenied = proc.sandbox !== undefined && proc.sandbox.denied !== true;
  const output = typeof p.collector?.text === 'function' ? p.collector.text() : '';
  const modes = Array.isArray(p.escalationModes) ? p.escalationModes : [];
  if (
    hasCaptureForm(p.command)
    && output.trim() === ''
    && restrictedNotDenied
    && p.escalated !== true
    && modes.length > 0
  ) {
    return [t(p.lang, 'note.silentCapture')];
  }

  // 签名 2：只有开关 + 锚两项检查（互斥于构造：签名 1 要求输出空白）。
  if (hasDenialAnchors(output)) {
    return [t(p.lang, 'note.silentDenied')];
  }
  return [];
}
