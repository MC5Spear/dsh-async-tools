/**
 * agent 阶段**路由判据**的纯函数（判据本体与取数分离——
 * `verify/r24-judgements.mjs` 的同一成例：真机探针只取数，判据在这里，可被单测
 * 与变异证明能红）。
 *
 * ## 背景：判据假绿的形态
 *
 * 裸路由串匹配（`/zai/.test(t) && /glm-5\.3/.test(t)`）会让**继承 note 同样命中**：
 * 名单不允许该路由时，带 provider/model 的调用被 `lib/agent.js` 按当前 dsh 模型
 * 选择设置可读拒绝（需求 §2.3.2 实时口径）。此时真绿只能来自模型不经路由重试
 * 而继承父路由时产生的 note（含同一路由串 + inherited 标记）——判据读数取决于
 * 模型是否恰好重试，不可复现。
 *
 * ## 锚点来源（en/zh 两档同收；lib 措辞漂移由单测夹具先行变红）
 *
 * - requested 标记：`lib/text.js` `route.requested`
 *   （en `Child LLM route: {p}/{m} (requested).` / zh `子代理 LLM 路由：{p}/{m}（按请求）。`）
 * - inherited 标记：`route.inherited` / `route.inherits`
 *   （en `(inherited from this agent)` / `inherits parent route`；zh `（继承自本代理）` / `继承父路由`）
 * - 推理强度附注：`route.effortSuffix`
 *   （en `(reasoning effort: {effort})` / zh `（推理强度：{effort}）`）
 * - 可读拒绝族（实时口径，需求 §2.3.2；各自独立判据，不合并）：
 *   `error.selectionDisabled`（开关关）、`error.routeNotAllowed`（不在名单，含
 *   async_list_subagent_models 指路）、`error.policyUnavailable`（服务缺席）、
 *   `error.policyReadFailed`（读取失败）、`error.routeRecheckReadFailed`（启动前
 *   重读读取失败）、`error.routeRecheckFailed`（启动前重读名单撤销）。
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
 * note 是否带**推理强度附注**（`reasoning_effort` 生效回执，需求 §2.3.1）。
 * @param {string} text - 工具结果文本。
 * @param {string} [effort] - 期望的强度 id；缺省只判有附注。
 * @returns {boolean} 判据成立与否。
 */
export function effortNote(text, effort) {
  const value = effort === undefined ? '[^)）]+' : escapeRegExp(effort);
  return new RegExp(`\\(reasoning effort: ${value}\\)`).test(text)
    || new RegExp(`（推理强度：${value}）`).test(text);
}

/** 以下六个判据共享同一形态：**当前 dsh 模型选择设置下的可读拒绝**（§2.3.2）。 */

/**
 * 工具错误是否为「显式选择被关」（`error.selectionDisabled` 文案锚）。
 * @param {string} text - 工具结果文本。
 * @returns {boolean}
 */
export function selectionDisabledRejection(text) {
  return /explicit child model selection is currently disabled in the dsh model-selection settings/.test(text)
    || /dsh 模型选择设置当前未开启显式子模型选择/.test(text);
}

/**
 * 工具错误是否为「路由不在当前名单」（`error.routeNotAllowed` 文案锚；拒绝文案
 * 必须指路 `async_list_subagent_models`——需求 §2.3.1 末条）。
 * @param {string} text - 工具结果文本。
 * @param {string} [provider] - 期望被拒的 provider id（缺省任意）。
 * @param {string} [model] - 期望被拒的 model id（缺省任意）。
 * @returns {boolean}
 */
export function routeNotAllowedRejection(text, provider, model) {
  const route = provider === undefined || model === undefined
    ? '[^"]+'
    : `${escapeRegExp(provider)}/${escapeRegExp(model)}`;
  const withRoute = new RegExp(`route "${route}" is not allowed by the current model-selection settings`).test(text)
    || new RegExp(`路由 "${route}" 不在当前模型选择设置允许的名单内`).test(text);
  const pointsToQuery = text.includes('async_list_subagent_models');
  return withRoute && pointsToQuery;
}

/**
 * 工具错误是否为「服务缺席」（`error.policyUnavailable` 文案锚）。
 * @param {string} text - 工具结果文本。
 * @returns {boolean}
 */
export function policyUnavailableRejection(text) {
  return /the host composition does not provide the subagentModelSelection service/.test(text)
    || /宿主组合未提供 subagentModelSelection 服务/.test(text);
}

/**
 * 工具错误是否为「设置读取失败」（`error.policyReadFailed` 文案锚）。
 * @param {string} text - 工具结果文本。
 * @returns {boolean}
 */
export function policyReadFailedRejection(text) {
  return /the model-selection settings could not be read/.test(text)
    || /模型选择设置读取失败/.test(text);
}

/**
 * 工具错误是否为「启动前重读读取失败」（`error.routeRecheckReadFailed` 文案锚；
 * 读取失败≠设置已变化——文案须带原错并给重试出路）。
 * @param {string} text - 工具结果文本。
 * @returns {boolean}
 */
export function recheckReadFailedRejection(text) {
  return /re-reading the model-selection settings right before the start failed/.test(text)
    || /启动前重读模型选择设置失败/.test(text);
}

/**
 * 工具错误是否为「启动前重读名单撤销」（`error.routeRecheckFailed` 文案锚；
 * 唯一「设置已变化」场景，须指路查询工具复核）。
 * @param {string} text - 工具结果文本。
 * @returns {boolean}
 */
export function recheckFailedRejection(text) {
  return /allowed list re-read immediately before the start no longer contains the selected route/.test(text)
    || /启动前重读的允许名单已不含所选路由/.test(text);
}

/**
 * 工具错误是否为实时口径下任一种**可读拒绝**（六个判据的并集；诊断汇总用，
 * 精确归因用各自判据）。
 * @param {string} text - 工具结果文本。
 * @returns {boolean}
 */
export function readablePolicyRejection(text) {
  return selectionDisabledRejection(text) || routeNotAllowedRejection(text)
    || policyUnavailableRejection(text) || policyReadFailedRejection(text)
    || recheckReadFailedRejection(text) || recheckFailedRejection(text);
}

/** 查询工具（async_list_subagent_models）适用性行的判据（§2.3.4 双向差异）。 */

/**
 * 查询结果是否判 async_agent 目标**允许显式选择**（verdict allowed ＋
 * `list.basis.asyncCurrent` 现读口径：开关开）。
 * @param {string} text - 工具结果文本。
 * @returns {boolean}
 */
export function queryVerdictAllowed(text) {
  return (text.includes('explicit route selection allowed')
      && text.includes('current dsh model-selection settings: enabled'))
    || (text.includes('允许选择') && text.includes('当前 dsh 模型选择设置：已开启'));
}

/**
 * 查询结果是否判 async_agent 目标**不允许显式选择**（verdict NOT allowed ＋
 * `list.basis.asyncDisabled` 现读口径：开关关）。
 * @param {string} text - 工具结果文本。
 * @returns {boolean}
 */
export function queryVerdictDisabled(text) {
  return (text.includes('NOT allowed') || text.includes('不允许选择'))
    && (text.includes('model selection is disabled in the current dsh model-selection settings')
      || text.includes('当前 dsh 模型选择设置未开启'));
}

/**
 * agent 阶段路由判据的汇总读数（acceptance-017 `phaseAgent` 消费）。
 *
 * @param {string[]} results - 会话转录里的工具结果文本序列。
 * @param {string} provider - 期望的 provider id。
 * @param {string} model - 期望的 model id。
 * @returns {{ ok: boolean, sawRequested: boolean, sawInherited: boolean, sawDisabled: boolean,
 *   sawNotAllowed: boolean, sawUnavailable: boolean, sawReadFailed: boolean, sawRecheckRead: boolean,
 *   sawRecheck: boolean, count: number, detail: string }} 判据结论与可复核读数。
 */
export function judgeAgentRouting(results, provider = 'zai', model = 'glm-5.3') {
  const items = Array.isArray(results) ? results : [];
  const sawRequested = items.some((r) => requestedRouteNote(r, provider, model));
  const sawInherited = items.some((r) => inheritedRouteNote(r));
  const sawDisabled = items.some((r) => selectionDisabledRejection(r));
  const sawNotAllowed = items.some((r) => routeNotAllowedRejection(r));
  const sawUnavailable = items.some((r) => policyUnavailableRejection(r));
  const sawReadFailed = items.some((r) => policyReadFailedRejection(r));
  const sawRecheckRead = items.some((r) => recheckReadFailedRejection(r));
  const sawRecheck = items.some((r) => recheckFailedRejection(r));
  return {
    ok: sawRequested,
    sawRequested,
    sawInherited,
    sawDisabled,
    sawNotAllowed,
    sawUnavailable,
    sawReadFailed,
    sawRecheckRead,
    sawRecheck,
    count: items.length,
    detail: `结果条数=${String(items.length)} requested标记=${String(sawRequested)} `
      + `继承标记=${String(sawInherited)} 开关关拒绝=${String(sawDisabled)} `
      + `名单外拒绝=${String(sawNotAllowed)} 服务缺席拒绝=${String(sawUnavailable)} `
      + `读取失败拒绝=${String(sawReadFailed)} 重读读取失败拒绝=${String(sawRecheckRead)} `
      + `重读撤销拒绝=${String(sawRecheck)}`
  };
}
