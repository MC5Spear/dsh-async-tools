/**
 * 入口接管形态下的会话模型选择策略（需求 §2.3.2，设计 §3.3）。
 *
 * ## 它是什么
 *
 * 两预设不挂宿主 `tool-subagent` 行，这些预设的会话**没有采样方**——
 * 模型选择策略（投影键 `subagentModelSelectionPolicy`）永远无持久事件，`async_agent`
 * 的指定路由被保守拒绝（`error.noPolicy`）。本模块在 **`async_agent` 工具行
 * 装载期**补上宿主 standing 行的采样角色：
 *
 * 1. **注册投影 fold**（与宿主 `subagentModelSelectionProjectionDefinition` 同键
 *    同版同形——同键注册共享计数，先到先得 def；插件侧注册是注册表公开语义）；
 * 2. **组合作用域监听 `agent/created`**（作用域过滤分发，只收本组合的 agent），
 *    对每个新会话复刻宿主采样链（else-if 同形）：投影现值 → 父会话继承 →
 *    fresh 顶层读全局白名单 `current()`；得到路由表即**幂等**追加持久事件
 *    `subagent/model-selection-policy`。
 *
 * ## 与宿主的等价与两处登记在案的偏差（设计 §3.3 等价表）
 *
 * - **settings 服务缺席**：宿主是装载期 throw（`:586-587`）；本包是预设行，装载
 *   throw 会拖垮同组合的其余四行工具——降级为 stderr 通告 + 只跳过采样接线
 *   （投影 fold 照注册，读取侧基础设施）。**有意偏差**。
 * - **sessions 服务缺席**：只影响父继承分支（跳过，通告一次）；顶层采样不读它，
 *   照常工作——宿主同场景顶层本来就不读 sessions（`:598-601`）。
 * - **`current()` 抛错**（全局坏配置 enabled+空名单）：与宿主同姿态——同步监听
 *   抛错 ⇒ `agent/created` 串行链失败 ⇒ 会话创建拒绝。响亮失败，不静默。
 *
 * ## 两个必须同形的细节
 *
 * - **幂等判据**走 `policyOf`（`stateOf(...)?.map` 把 init null 折成 undefined——
 *   与宿主包装 `:221-223` 同构）。setup 窗口内追加的策略事件**不 re-emit
 *   `session/event`**，事件驱动的 eager drive 收不到——第二个采样方与重入
 *   的本包都靠 `stateOf` 读时惰性补折看到新值。
 * - **采样链是 else-if**：`origin === 'subagent'` 命中即短路，父查无/父无策略 ⇒
 *   不追加，**不落** fresh 全局采样（宿主 `:592-601` 同形）。
 *
 * ## stateSchema 为什么是 zod
 *
 * 注册表 checkpoint/restore 路径直接调 `stateSchema.parse`——契约是 zod，不是
 * schemastery；且同键合并先到先得 def，schema 错库会污染全实例该键（standard 会话
 * 恢复同炸）。本模块 zod 逐字副本宿主 `:202-205`；`verify/check-agent-policy.mjs`
 * 整段互锚（钉版看守，设计 §3.3）。
 *
 * @module dsh-async-tools/lib/agent-policy
 */
import { z } from 'zod';
import { LOG_PREFIX } from './config.js';
import { emitLifecycleNotice } from './notice.js';

/** 与宿主同键（同键同版共享计数；宿主 `dsh-tool-subagent` `:200`）。 */
export const POLICY_KEY = 'subagentModelSelectionPolicy';

/** 宿主现行 `stateVersion`（`:201`）；宿主升版 ⇒ 钉版看守先红（设计 §3.3）。 */
export const POLICY_STATE_VERSION = 1;

/** 持久事件类型（宿主 `:208`/`:232` 追加与 fold 判定同串）。 */
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
 * 投影定义——宿主 `:199-214` 同形副本（钉版看守整段互锚，设计 §3.3）。
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
 * 读一个会话的策略现值——宿主包装 `:221-223` 同构：`stateOf` 的 init null 经
 * `?.map` 折成 undefined，实质判据「投影折出非 null 路由表」；返回**深拷贝**（宿主
 * 同款逐项展开，不交出活引用）。
 * @param {object} projections - 投影注册表服务。
 * @param {object} session - 目标会话。
 * @returns {Array<{provider: string, model: string}> | undefined}
 */
export function policyOf(projections, session) {
  return projections.stateOf(session, POLICY_KEY)?.map((route) => ({ ...route }));
}

/**
 * 采样并追加策略（宿主 `selectForSession` + `recordSubagentModelSelection` 的复刻）——同步、不抛业务错误（`current()` 抛错原样上抛 = 创建拒绝，响亮失败）。
 *
 * @param {object} services - `{ projections, settings, sessions? }`：`settings` 是
 *   Host 单例 `subagentModelSelection`（`.current()` → `{enabled, allowedModels}`，
 *   volatile）；`sessions` 缺席只跳过父继承分支。
 * @param {object} session - 新建的会话（`header`/`firstLiveSeq`/`eventAt`/`append`）。
 * @returns {{appended: boolean, routes: Array<{provider: string, model: string}> | undefined}}
 */
export function sampleAndRecord(services, session) {
  // 幂等判据 = stateOf 现读非 undefined（setup 窗口事件不 re-emit，靠读时补折）。
  const existing = policyOf(services.projections, session);
  if (existing !== undefined) return { appended: false, routes: existing };

  let routes;
  if (session.header.origin === 'subagent') {
    // ② 命中即短路（else-if 同形）：父查无 / 父无策略 ⇒ 不追加，不落 ③。
    const parent = services.sessions === undefined
      ? undefined
      : services.sessions.get(session.header.parentSession);
    routes = parent === undefined ? undefined : policyOf(services.projections, parent);
  } else if (session.firstLiveSeq === 0 && session.eventAt(0)?.type !== 'session/end-seed') {
    // ③ 仅 fresh 顶层：恢复会话（firstLiveSeq>0 或 end-seed 打头）不采样——已记录
    // 策略的由 ① 命中，无记录的保持禁用。eventAt 调用与宿主 `:589`
    // 逐字同形（弃用名单上的宿主现行读法，钉版看守锚住宿主源）。
    const current = services.settings.current();
    routes = current.enabled ? current.allowedModels : undefined;
  }

  if (routes === undefined) return { appended: false, routes: undefined };
  session.append(POLICY_EVENT, { allowedModels: routes.map((route) => ({ ...route })) });
  return { appended: true, routes };
}

/**
 * `async_agent` 工具行装载期接线（`lib/index.js` `applyWith` 的
 * `toolName === 'async_agent'` 分支调用）。
 *
 * @param {object} ctx - 行的 cordis 上下文（组合作用域；`agent/created` 监听天然
 *   过滤到本组合）。
 * @param {(line: string) => void} [sink] - stderr 出口注入（测试用；默认 `process.stderr`）。
 * @returns {{sampling: boolean}} `sampling=false` = settings 缺席、只注册了 fold。
 */
export function wirePolicyRow(ctx, sink) {
  // fold 无条件注册（读取侧基础设施；宿主行 `:375` 同款无条件）。
  ctx.sessionProjections.register(policyProjectionDefinition);

  const settings = ctx.get('subagentModelSelection');
  if (settings === undefined) {
    // 有意偏差：宿主是装载 throw；预设行 throw 会拖垮整组合。
    emitLifecycleNotice(
      `${LOG_PREFIX} 模型选择设置服务缺席：async_agent 行不接线会话策略采样`
      + '（宿主组合未含 model-selection-settings；指定路由将按无 policy 拒绝）',
      sink
    );
    return { sampling: false };
  }
  if (ctx.get('sessions') === undefined) {
    emitLifecycleNotice(
      `${LOG_PREFIX} Session 注册表缺席：子会话的策略继承分支将被跳过`
      + '（顶层新会话采样不受影响）',
      sink
    );
  }

  ctx.on('agent/created', ({ agent }) => {
    // 同步监听（零 await），不打乱宿主的串行创建链；sessions 每次现取（宿主 `:594`
    // 同款惰性）。
    sampleAndRecord(
      { projections: ctx.sessionProjections, settings, sessions: ctx.get('sessions') },
      agent.session
    );
  });
  return { sampling: true };
}
