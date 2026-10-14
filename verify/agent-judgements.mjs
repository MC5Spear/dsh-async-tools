/**
 * agent 相位**路由判据**的纯函数（判据本体与取数分离——
 * `verify/r24-judgements.mjs` 的同一成例：真机探针只取数，判据在这里，可被单测
 * 与变异证明能红）。
 *
 * ## 背景：判据假绿的形态
 *
 * 裸路由串匹配（`/zai/.test(t) && /glm-5\.3/.test(t)`）会让**继承 note 同样命中**：
 * 宿主 tool-subagent 行禁用的会话结构性无模型选择策略，带 provider/model 的调用
 * 被 `lib/agent.js` 按设计保守拒绝（`error.noPolicy`）；此时真绿只能来自模型
 * **免路由重试**的继承句柄 note（含同一路由串 + inherited 标记）——判据读数
 * 取决于模型是否恰好重试，不可复现。
 *
 * ## 锚点来源（en/zh 两档同收；lib 措辞漂移由单测夹具先行变红）
 *
 * - requested 标记：`lib/text.js` `route.requested`
 *   （en `Child LLM route: {p}/{m} (requested).` / zh `子代理 LLM 路由：{p}/{m}（按请求）。`）
 * - inherited 标记：`route.inherited` / `route.inherits`
 *   （en `(inherited from this agent)` / `inherits parent route`；zh `（继承自本代理）` / `继承父路由`）
 * - 无 policy 拒绝：`error.noPolicy`
 *   （en `child model selection is not available for this session (no model-selection policy)`
 *   / zh `本会话的子代理模型选择不可用（没有模型选择策略）`）
 *
 * @module verify/agent-judgements
 */

/** 正则元字符转义（provider/model 是外部串，判据不能假设它们是纯标识符）。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * note 是否报告**指定路由被接受**：路由串后必须紧跟 requested 标记
 * （en ` (requested)` / zh `（按请求）`）。
 *
 * 继承 note（同路由串 + inherited 标记）**必须不命中**；
 * 「继承 note 必红」由 `test/agent-judgements.test.mjs` 用 lib 真渲染文案钉住。
 *
 * @param {string} text - 工具结果文本（acceptance-017 `parseEvents` 的 results 项）。
 * @param {string} provider - 期望的 provider id。
 * @param {string} model - 期望的 model id。
 * @returns {boolean} 判据成立与否。
 */
export function requestedRouteNote(text, provider = 'zai', model = 'glm-5.3') {
  const route = `${escapeRegExp(provider)}/${escapeRegExp(model)}`;
  return new RegExp(`${route} \\(requested\\)`).test(text)
    || new RegExp(`${route}（按请求）`).test(text);
}

/**
 * note 是否报告**继承路由**（含「读不出具体值、笼统继承」形态）。
 * 诊断用途：解释 requested 判据红时会话里到底发生了什么。
 *
 * @param {string} text - 工具结果文本。
 * @returns {boolean} 判据成立与否。
 */
export function inheritedRouteNote(text) {
  return /\(inherited from this agent\)/.test(text)
    || /（继承自本代理）/.test(text)
    || /route: inherits parent route/.test(text)
    || /路由：继承父路由/.test(text);
}

/**
 * 工具错误是否为「无 policy 会话的**可读拒绝**」（`error.noPolicy` 文案锚）。
 *
 * 这是宿主 tool-subagent 行禁用的会话（→ 无模型选择策略 → `lib/agent.js`
 * 保守拒绝）下的正向命题。
 *
 * @param {string} text - 工具结果文本。
 * @returns {boolean} 判据成立与否。
 */
export function noPolicyRejection(text) {
  return /child model selection is not available for this session \(no model-selection policy\)/.test(text)
    || /本会话的子代理模型选择不可用（没有模型选择策略）/.test(text);
}

/**
 * agent 相位路由判据的汇总读数（acceptance-017 `phaseAgent` 消费）。
 *
 * @param {string[]} results - 会话转录里的工具结果文本序列。
 * @param {string} provider - 期望的 provider id。
 * @param {string} model - 期望的 model id。
 * @returns {{ ok: boolean, sawRequested: boolean, sawInherited: boolean, sawNoPolicy: boolean,
 *   count: number, detail: string }} 判据结论与可复核读数。
 */
export function judgeAgentRouting(results, provider = 'zai', model = 'glm-5.3') {
  const items = Array.isArray(results) ? results : [];
  const sawRequested = items.some((r) => requestedRouteNote(r, provider, model));
  const sawInherited = items.some((r) => inheritedRouteNote(r));
  const sawNoPolicy = items.some((r) => noPolicyRejection(r));
  return {
    ok: sawRequested,
    sawRequested,
    sawInherited,
    sawNoPolicy,
    count: items.length,
    detail: `结果条数=${String(items.length)} requested标记=${String(sawRequested)} `
      + `继承标记=${String(sawInherited)} noPolicy拒绝=${String(sawNoPolicy)}`
  };
}
