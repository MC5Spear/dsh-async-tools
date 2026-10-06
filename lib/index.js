/**
 * dsh-async-tools — 插件入口（**单包两角色**，0.1.7 形态）。
 *
 * 一个包、一个默认入口，按行配置里 `toolName` 是否出现分派：
 *
 * - **工具角色**（`toolName` 存在，预设子树四行）：解析配置、按 `toolName` 构造四个
 *   工具之一、注册进工具表。全部逻辑在 `lib/` 的纯模块里。
 * - **宿主角色**（`toolName` 缺省，本包 `cordis.patch.yml` 的宿主行）：
 *   `lib/host.js` 的 `applyHostHalf`——播报设置快照 + 监听 volatile 提交，
 *   **不注册任何工具**（R4：宿主平面的工具会进全局工具层）。
 *
 * 四个工具的关键语义（`docs/design.md`）：
 * - `async_run`：让出预算到期**不杀死命令**，转后台并返回 job_id（R1）。
 * - `async_wait_job`：有界等待，可被用户**插话**（steer）打断，打断不影响作业（R2/R12）；
 *   排队（queue）消息不打断（R12）。
 * - `async_wait_agent`：有界等待子代理，可被用户**插话**（steer）打断，不影响子代理
 *   （R3/R12）；排队（queue）消息不打断（R12）。
 * - `async_agent`：永远后台的子代理派生，立返 agent_id，不等待不轮询（R13，§18）。
 *
 * @module dsh-async-tools
 */
import { LOG_PREFIX, resolveConfig } from './config.js';
import { buildToolText } from './descriptions.js';
import { createAgentTool } from './agent.js';
import { wirePolicyRow } from './agent-policy.js';
import { makeConfigView } from './config-view.js';
import { applyHostHalf } from './host.js';
import { createRunTool } from './jobs.js';
import { createWorkflowTool } from './workflow.js';
import { emitLifecycleNotice } from './notice.js';
import { onSettingsChanged } from './refresh-bus.js';
import { readSnapshot } from './settings.js';
import { createWaitAgentTool } from './wait-agent.js';
import { createWaitJobTool } from './wait-job.js';

/** cordis 插件名；预设的四条工具行与本包 `cordis.patch.yml` 的宿主行都以 `dsh-async-tools` 引用。 */
export const name = 'dsh-async-tools';

/**
 * 工具角色的七个服务都是硬依赖（**同一个 `inject` 也作用在宿主行上**——见下）：
 * - `tools`：注册工具表的入口（`ctx.tools.register`），少了它 apply 直接抛
 *   `cannot get property "tools" without inject`，整个插件树加载失败；
 * - `jobs`：`async_run` 转后台、`async_wait_job` 屏障（0.1.7 服务面）；
 * - `shell`：真正执行命令（0.1.7：`resolve` + `execute`，§22.1）；
 * - `shellEnv`：把宿主托管的 `DSH_*` 变量交给子进程（服务名 0.1.7 不变，
 *   `dsh-shell-env/lib/index.js:49` `super(ctx, "shellEnv")`）；
 * - `subagents`：`async_wait_agent` / `async_agent` 的注册表；
 * - `timer`：`async_wait_job` / `async_wait_agent` 的截止与轮询定时器走
 *   `ctx.timer.timeout(cb, ms)` 与 `ctx.timer.interval`。**`async_run` 不走它**——它的让出
 *   窗口走宿主的 `jobs.wait`，且请求显式 `onExpiry: 'none'`（§22.1），正是不让宿主的到期
 *   去杀进程。所以漏声明 `timer` 时，红的是那两个等待工具，`async_run` 反而看不出来。
 *
 * `timer` 是验证实例真机端到端补上的：假件测试里的
 * `ctx.timer` 是测试替身自己造的，所以 `inject` 漏了它也能全绿；只有真实 cordis
 * 上下文才会抛 `cannot get property "timer" without inject`。**这类缺口只有真机
 * 跑一遍才会暴露**，单测再全也替代不了——这是本插件最贵的一条教训。
 *
 * 单包化之后 `inject` 是**静态模块级**的，宿主行与工具行走同一份声明。这七个服务
 * 全部由宿主组合在**宿主平面**提供，所以宿主行注入它们只是"多拿不用"，不会进入等待。
 * 任一缺席时本插件进入等待而不是启动（0.1.7 宿主行已无任何可选服务接线——设置快照
 * 不依赖服务，见 `lib/host.js`）。
 *
 * `sessionProjections` 是 R13 模型选择加的：`async_agent` 读本会话的
 * `subagentModelSelectionPolicy` 投影做路由白名单校验（reducer 由宿主 `tool-subagent`
 * 行注册，插件只读，异常时按"无 policy"拒绝指定模型——保守方向）。
 */
export const inject = ['tools', 'jobs', 'shell', 'shellEnv', 'subagents', 'timer', 'sessionProjections'];

/**
 * 插件入口：按 `toolName` 是否出现分派角色。
 *
 * **工具角色**——配置是"活"的：工具每次 `execute` 都现读**模块级快照**
 * （宿主行播报的生效配置），快照缺席时退回本行默认值（§21.2）。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} rawConfig - cordis 配置（即组合行的 config）。
 */
export function apply(ctx, rawConfig) {
  // 宿主角色：宿主行没有 `toolName`（本包 `cordis.patch.yml` 的行连 `config:` 键都没有）。
  // ⚠️ 因此**给宿主行写 `toolName` 会把它变成工具行**——那会把工具塞进全局工具层（R4），
  // `test/two-planes.test.mjs` 的 T5 反向锁死了 patch 里不得出现 `toolName`。
  if (rawConfig?.toolName === undefined || rawConfig?.toolName === null) {
    applyHostHalf(ctx, rawConfig);
    return;
  }
  applyWith(ctx, rawConfig);
}

/**
 * 工具角色的装载主体。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} rawConfig - 组合行配置。
 */
function applyWith(ctx, rawConfig) {
  const initial = resolveConfig(rawConfig);
  const factory = {
    async_run: createRunTool,
    async_wait_job: createWaitJobTool,
    async_wait_agent: createWaitAgentTool,
    async_agent: createAgentTool,
    async_workflow: createWorkflowTool
  }[initial.toolName];

  if (factory === undefined) {
    throw new Error(`${LOG_PREFIX} unknown toolName ${JSON.stringify(initial.toolName)}`);
  }

  // 取值入口：宿主行播报的快照优先；缺席（宿主行未装载 / 不在同一模块实例）退回
  // 本行默认值。快照是**读时现取**的，volatile 提交后下一次 execute 就用新值。
  const configView = makeConfigView(() => readSnapshot() ?? initial);

  const tool = factory(ctx, configView);
  const disposeTool = ctx.tools.register(tool);

  // R40（§38）：async_agent 行装载期接线会话模型选择策略——注册投影 fold +
  // 组合作用域监听 agent/created 采样（裁决 R40-1；settings 缺席只跳过采样接线，
  // fold 照注册——读取面基础设施）。本包 `lib/agent.js` 的路由校验步零改动。
  if (initial.toolName === 'async_agent') wirePolicyRow(ctx);

  // ⚠️ **快照缺席必须说出来，不能静默退回本行默认值。**
  //
  // 0.1.5 的对应教训（验证实例真机）：设置页能改、读回是新值、落了盘，
  // **但工具行为一点不变**——取值入口没被换掉。静默早退从外面完全看不出哪一环断了。
  // 0.1.7 的缺席面收窄为"宿主行不在或模块实例断链"，报出来是部署期线索，不是噪声。
  //
  // 落点用 stderr（`lib/notice.js`；cordis logger 只进内存环形缓冲）。
  if (readSnapshot() === undefined) {
    emitLifecycleNotice(
      `${LOG_PREFIX} 设置快照缺席：工具 "${initial.toolName}" 使用本行默认值`
      + '（宿主行未装载或与工具行不在同一模块实例；设置页改动不影响本行）'
    );
  }

  // 描述刷新：volatile 提交 → 宿主行 fiber 收 `loader/volatile-update` → refresh-bus
  // 广播 → 这里就地改写描述（`defineTool` 构造时把描述求值成字符串，不会自己变）。
  const offBus = onSettingsChanged(() => { refreshToolDescriptions(tool, configView); });

  ctx.effect(() => () => {
    offBus();
    disposeTool();
  }, `${LOG_PREFIX} unregister ${initial.toolName}`);

  ctx.logger?.info?.(
    `${LOG_PREFIX} registered tool "${initial.toolName}" `
    + `(yield ${initial.defaultYieldMs}ms, wait ${initial.minWaitMs}-${initial.maxWaitMs}ms)`
  );
}

/**
 * 就地刷新工具描述：用构建器**整段重建**主描述，并把每个参数说明写回
 * `tool.parameters.properties[k].description`（§27.3）。
 *
 * ## 为什么必须"就地改"而不是"注销再重新注册"
 *
 * 工具表**按引用**保存工具对象（`dsh-scope/lib/index.js:11` "Values are borrowed"），
 * 而每次把工具投影给模型时都会现读它的字段（`schemaOf`：
 * `dsh-tools/lib/index.js:2934-2943`）。因此**改对象上的字段**就能生效。
 *
 * 另一条路（先注销、再重新注册同一个工具）有个致命窗口：`register()` 若抛错，
 * 工具就处在"已注销但没重新注册"的状态，会凭空消失。就地改没有窗口。
 *
 * ## 两处都要改
 *
 * `tool.description` 是模型看到的主描述；`tool.parameters` 是 `defineTool` 由参数说明
 * **转换并固化**出来的 JSON Schema，那里的说明文字不会自己更新，必须一并改写。
 * 只写回**已存在**的参数键：`async_run` 的提权两键按构造时的条件广告决定在不在，
 * 刷新不增删参数面。
 *
 * 构造处与刷新处调**同一个构建器**（`tool.rebuildText`，由各 `create*Tool` 登记；
 * 缺席时按工具名兜底），数字、provider 名与语言都跟着同一次构建走。
 *
 * @param {object} tool - 已注册的工具定义（按引用保存在工具表里）。
 * @param {object} config - 活取值视图。
 */
function refreshToolDescriptions(tool, config) {
  if (typeof tool.name !== 'string') return;
  const build = typeof tool.rebuildText === 'function'
    ? tool.rebuildText
    : (cfg) => buildToolText(tool.name, cfg);
  const text = build(config);
  if (typeof text.description === 'string') tool.description = text.description;

  const properties = tool.parameters?.properties;
  if (properties === undefined) return;
  for (const [key, spec] of Object.entries(text.parameters)) {
    if (properties[key] !== undefined && typeof spec?.description === 'string') {
      properties[key].description = spec.description;
    }
  }
}

export { Config } from './config.js';

/**
 * 导出给测试：就地刷新工具描述（整段重建，数字与语言都跟着生效配置走）。
 *
 * 不导出的话，"改设置 → 描述跟着变"这条链只能靠间接证据（观察 `ctx.plugin` 的接线）验证，
 * 而实现审查 R5 的 P1-1 正是"测试只是文本匹配、把实现退化成快照后全绿"。
 */
export { refreshToolDescriptions };
