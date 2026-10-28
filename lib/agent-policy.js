/**
 * 宿主子代理模型选择策略的形状副本与读取助手（需求 §2.3.2／§2.3.4，设计 §3.3／§3.7）。
 *
 * ## 它是什么、不是什么
 *
 * 本模块只保留两样东西：
 *
 * 1. **投影定义的形状副本**（`policyProjectionDefinition`）：与宿主
 *    `subagentModelSelectionProjectionDefinition` 同键同版同形的 zod 副本，
 *    是解读原生会话投影（设计 §3.7 的目标适用性判断）与钉版看守
 *    （`verify/check-agent-policy.mjs`）的形状依据；
 * 2. **`policyOf`**：按宿主读取函数同构的语义读一个会话的策略现值。
 *
 * 派生路径（`async_agent`）不注册同键投影、不执行会话采样——
 * 每次调用的模型选择策略现读 `subagentModelSelection` 服务（需求 §2.3.2，
 * `lib/agent.js`）；本模块不承担派生采样职责。原生工具在自己的行装载期
 * 注册宿主侧 fold 并按会话冻结策略，两侧互不代劳。
 *
 * ## stateSchema 为什么是 zod
 *
 * 注册表的状态检查点（checkpoint，宿主的会话保存/恢复路径）直接调
 * `stateSchema.parse`——契约是 zod，不是
 * schemastery；且同键合并先到先得 def，schema 错库会污染全实例该键（standard 会话
 * 恢复同炸）。本模块 zod 逐字副本宿主投影定义
 * `subagentModelSelectionProjectionDefinition` 的 `stateSchema`
 * （dsh-tool-subagent `lib/index.js:259-274`）；`verify/check-agent-policy.mjs`
 * 按有限锚集逐行互锚（钉版看守，设计 §3.3——锚外漂移不红、不证明语义等价）。
 *
 * @module dsh-async-tools/lib/agent-policy
 */
import { z } from 'zod';

/** 与宿主同键（宿主投影定义 `dsh-tool-subagent` `:260`）。 */
export const POLICY_KEY = 'subagentModelSelectionPolicy';

/** 宿主现行 `stateVersion`（`:261`）；宿主升版 ⇒ 钉版看守先红（设计 §3.3）。 */
export const POLICY_STATE_VERSION = 1;

/** 持久事件类型（宿主 `:268`/`:292` fold 判定与追加同串）。 */
export const POLICY_EVENT = 'subagent/model-selection-policy';

/**
 * 路由表校验——宿主 `assertAllowedModelRoutes`（`:25-39`）同形副本：数组形 /
 * 非空串 / 无重复。**不含长度检查**（空数组放行；「≥1 条」由 fold 的空名单 throw
 * 与 settings `current()` 的坏配置 throw 承担——校验三处分列）。
 * @param {unknown} routes - 候选路由表。
 * @returns {void} 非法即抛。
 */
function assertRoutes(routes) {
  if (!Array.isArray(routes)) throw new Error('subagent model selection requires an array of routes');
  const seen = new Set();
  for (const candidate of routes) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
      || !('provider' in candidate) || typeof candidate.provider !== 'string'
      || !('model' in candidate) || typeof candidate.model !== 'string'
      || candidate.provider.length === 0 || candidate.model.length === 0) {
      throw new Error('subagent model selection requires non-empty provider and model ids');
    }
    const key = `${candidate.provider}\0${candidate.model}`;
    if (seen.has(key)) throw new Error(`subagent model selection repeats route "${candidate.provider}/${candidate.model}"`);
    seen.add(key);
  }
}

/**
 * 投影定义形状副本——宿主 `:259-274` 同形（钉版看守有限锚集互锚，设计 §3.3；
 * fold 返回值行与 provider/model 字段类型行另钉行号）。
 * fold 语义：init null；首条策略事件校验后返回路由表（先到先记）；后续事件不动。
 */
export const policyProjectionDefinition = {
  key: POLICY_KEY,
  stateVersion: POLICY_STATE_VERSION,
  stateSchema: z.array(z.object({
    provider: z.string().min(1),
    model: z.string().min(1)
  }).strict()).min(1).nullable(),
  init: () => null,
  apply(policy, event) {
    if (policy !== null || event.type !== POLICY_EVENT) return policy;
    const { allowedModels } = event.data;
    assertRoutes(allowedModels);
    if (allowedModels.length === 0) throw new Error(`${POLICY_EVENT} requires at least one route`);
    return allowedModels;
  }
};

/**
 * 读一个会话的策略现值——宿主读取函数 `:281-283` 同构：`stateOf` 的 init null 经
 * `?.map` 折成 undefined，实质判据「投影折出非 null 路由表」；返回**深拷贝**（宿主
 * 同款逐项展开，不交出活引用）。键未注册（本包预设组合不挂原生行时）宿主
 * `stateOf` 返回 undefined 不抛，同样折成 undefined。
 * @param {object} projections - 投影注册表服务。
 * @param {object} session - 目标会话。
 * @returns {Array<{provider: string, model: string}> | undefined}
 */
export function policyOf(projections, session) {
  return projections.stateOf(session, POLICY_KEY)?.map((route) => ({ ...route }));
}
