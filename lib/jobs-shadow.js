/**
 * `tool:jobs` 提示遮蔽段的宿主前缀与组装（RA-HIDDEN-READER-PROMPT / AGENT-LANG-01）。
 *
 * 遮蔽段全文 = 宿主原句前缀 ＋ 本包收集句，两段的文案来源不同（需求 §5.3
 * 「混合来源逐段区分」）：
 * - **前缀**：宿主 dsh-tool-jobs 全局 `tool:jobs` 段的前两句，**逐字同形副本**
 *   （node_modules/@deepseek-ai/dsh-tool-jobs/lib/index.js），恒为宿主语言
 *   （英文）、不随 `agentLang`。逐字保留义务由 T20b 双互锚看守：宿主源判据
 *   （前缀两句在宿主源码逐字在场——宿主改措辞即红）＋组稿文本判据（组装结果
 *   含前缀逐字子串，en/zh 两档都在场——组装时静默丢段或 zh 侧译掉前缀即红）。
 *   宿主改版后须人工同步本常量与词典 en 档收集句，再让测试转绿。
 * - **收集句**：本包改写文案，进词典 `discipline.jobsCollect`（en/zh 两档），
 *   随 `agentLang` 切换——zh 档遮蔽段因此是「英文前缀＋中文收集句」的混合段。
 *
 * ## 为什么前缀不进词典（决策记录）
 *
 * 否决「zh 档整译前缀」：漂移守卫需要宿主原文的**逐字**副本作互锚，译文没有
 * 逐字形态，锚无从谈起；需求 §5.3 只豁免「宿主原封不动的提示原文」，整译后的
 * 前缀不再是宿主原文，逐字保留义务随之失效。
 *
 * 否决「前缀＋收集句合并成单词典键」（zh 值＝英文前缀拼中文收集句）：该形态
 * 能过表层全部判据（zh 含中文、键集相等、en 零 CJK），但会把宿主文本埋进词典
 * 值里，失去独立副本的归类管理——检查器的「宿主逐字同形副本类」豁免
 * （agent-policy.js 先例）按「宿主侧同串同现＋互锚检查锚定于宿主源」判定，
 * 合并键两头都不满足。需求 §5.3 明文允许混合来源逐段区分，分段存放即该语义。
 *
 * ## 空串禁忌（为什么回退方向是「退英文」，不是「退空串」）
 *
 * 同名 scoped 段对全局段的遮蔽在 dsh-system-prompt 的 **merge 层**生效
 * （scoped 同名条目胜出，全局文本随之出局），空串过滤发生在其后的**渲染层**
 * （`renderPrompt` 丢弃空文本段）。所以遮蔽段若返回空串，净效果是 `tool:jobs`
 * 指引整体消失，而不是回退到宿主原文——这与纪律段「失败返回空串＝缺席＝正确
 * 退场」（设计 3.5.3）的语义不同：纪律段是全局自注册段，遮蔽段的存在意义就是
 * 覆盖全局同名段。因此任何求值失败都退向**非空**文本：先退英文档整句，词典
 * 彻底损坏（表层必红的状态）时退仅前缀，绝不返回空串。
 *
 * ## 多行无快照的边缘（登记在案，不作工程处理）
 *
 * 四个交付类行都挂 `agent/created` 监听，首个收到的行为某 Agent 注册遮蔽
 * （模块级 WeakSet 去重），语言取该行配置视图的 `agentLang`。快照在场（宿主行
 * 装载，正常部署）时各行 `agentLang` 一致；仅当快照缺席**且**多行在行配置里
 * 写了不同 `settings.agentLang` 时，生效语言随首装行。该形态下设置页本就未接线
 * （lib/index.js 快照缺席诊断的既有边界），风险登记于此。
 *
 * @module dsh-async-tools/jobs-shadow
 */
import { t } from './text.js';

/**
 * 宿主 `tool:jobs` 段的前两句（含结尾空格，第三句收集指路由本包改写）。
 * 逐字复制义务与守卫见模块文档；改一字即与宿主漂移、T20b 必红。
 */
export const JOBS_SHADOW_HOST_PREFIX = 'Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job\'s work. ';

/**
 * 组装遮蔽段全文：宿主前缀 ＋ 收集句（按 `agentLang` 取档）。
 *
 * 两级失败回退（任何路径都不返回空串，理由见模块文档「空串禁忌」）：
 * 首取抛错（缺键——未知名已经 `t()` 回退 'en'，仍抛即词典键被删）退英文档
 * 整句；英文档也抛（词典损坏）退仅前缀。后两级都是退化形态，正常路径由
 * 检查器表层与运行时层守着不出现。
 *
 * @param {string} agentLang - 语言档（生效配置的 `agentLang`）。
 * @returns {string} 遮蔽段全文（恒非空）。
 */
export function jobsShadowText(agentLang) {
  try {
    return JOBS_SHADOW_HOST_PREFIX + t(agentLang, 'discipline.jobsCollect');
  } catch { /* 缺键：退英文档整句（见函数文档） */ }
  try {
    return JOBS_SHADOW_HOST_PREFIX + t('en', 'discipline.jobsCollect');
  } catch { /* 词典损坏：退仅前缀（恒非空） */ }
  return JOBS_SHADOW_HOST_PREFIX;
}
