/**
 * dsh-async-tools — 插件入口（**单包两角色**，设计 §1.1）。
 *
 * 一个包、一个默认入口，按行配置里 `toolName` 是否出现分派：
 *
 * - **工具角色**（`toolName` 存在，预设子树的工具行与 delegation 组内行）：解析配置、
 *   按 `toolName` 构造对应工具、注册进工具表。全部逻辑在 `lib/` 的纯模块里。
 * - **宿主角色**（`toolName` 缺省，本包 `cordis.patch.yml` 的宿主行）：
 *   `lib/host.js` 的 `applyHostHalf`——播报设置快照 + 监听 volatile 提交，
 *   **不注册任何工具**（需求 §3.2：宿主侧的工具会进全局工具层）。
 *
 * 五个工具的关键语义（`docs/design.md`）：
 * - `async_run`：首次等待到期**不杀死命令**，转后台并返回作业编号 job_id（需求 §2.2.1）。
 * - `async_wait_job`：有界等待，可被用户**插话**（steer）打断，打断不影响作业
 *   （需求 §2.1.2）；排队（queue）消息不打断。
 * - `async_wait_agent`：有界等待子代理，可被用户**插话**（steer）打断，不影响子代理
 *   （需求 §2.1.2）；排队（queue）消息不打断。
 * - `async_agent`：永远后台的子代理派生，立返 agent_id，不等待不轮询（需求 §2.3.1）。
 * - `async_workflow`：后台编排作业，首次等待与结果取回同前两者口径（需求 §2.4）。
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

/** cordis 插件名；预设的五条工具行与本包 `cordis.patch.yml` 的宿主行都以 `dsh-async-tools` 引用。 */
export const name = 'dsh-async-tools';

/**
 * 工具角色的九项服务都是固定依赖（**同一个 `inject` 也作用在宿主行上**——见下）：
 * - `tools`：注册工具表的入口（`ctx.tools.register`），少了它 apply 直接抛
 *   `cannot get property "tools" without inject`，整个插件树加载失败；
 * - `jobs`：`async_run` 转后台、`async_wait_job` 屏障、`async_workflow` 的编排
 *   作业注册（宿主作业服务——三个工具各自以不同方式消费同一服务）；
 * - `shell`：真正执行命令（`resolve` + `execute`，设计 §3.1）；
 * - `shellEnv`：把宿主托管的 `DSH_*` 变量交给子进程（服务名不变，
 *   `dsh-shell-env/lib/index.js:49` `super(ctx, "shellEnv")`）；
 * - `subagents`：`async_wait_agent` / `async_agent` 的注册表；
 * - `timer`：`async_wait_job` / `async_wait_agent` 的截止与轮询定时器走
 *   `ctx.timer.timeout(cb, ms)` 与 `ctx.timer.interval`。**`async_run` 不走它**——它的让出
 *   窗口走宿主的 `jobs.wait`，且请求显式 `onExpiry: 'none'`（设计 §3.1），正是不让宿主的到期
 *   去杀进程。所以漏声明 `timer` 时，红的是那两个等待工具，`async_run` 反而看不出来；
 * - `agents`：公开 Agent 注册表，`async_wait_agent` 的运行状态判定消费
 *   （`get(id)` 返回驻留 Agent 或 `undefined`，`status` 只取 running/idle）。
 *   派生（`startActivation`）要求 parent 是注册表中的同一活 Agent 对象，列为
 *   固定依赖不缩小可部署范围。
 * - `workingDirectory`：`async_run` 启动前取得会话**当前**有效目录（`ensure`
 *   做存在性检查与目录失效恢复，设计 §3.1）。注意它不是会话头初始目录的直读：
 *   会话内切目录后等待新目录的是这个服务；漏声明它，红的只有 `async_run`，
 *   且只在真实 cordis 上下文（假件里 `ctx.workingDirectory` 是测试自己造的）。
 *
 * `timer` 的声明有个盲区要知道：假件测试里的
 * `ctx.timer` 是测试替身自己造的，所以 `inject` 漏了它也能全绿；只有真实 cordis
 * 上下文才会抛 `cannot get property "timer" without inject`。**这类缺口只有真实
 * 宿主端到端跑一遍才会暴露**，单测再全也替代不了。
 *
 * `inject` 是**静态模块级**的，宿主行与工具行走同一份声明。这九项服务
 * 全部由宿主组合在**宿主侧**提供，所以宿主行注入它们只是"多拿不用"，不会进入等待。
 * 任一缺席时本插件进入等待而不是启动（宿主行已无任何可选服务接线——设置快照
 * 不依赖服务，见 `lib/host.js`）。
 *
 * `sessionProjections` 服务于模型选择策略，本插件对它**既注册又读取**：
 * `async_agent` 行装载期由 `wirePolicyRow` 无条件注册自己的投影 fold（行组合
 * 作用域，`agent-policy.js:161`）；读取侧 `async_agent` 每次调用现读本会话的
 * `subagentModelSelectionPolicy` 投影做路由白名单校验（宿主 `tool-subagent`
 * 行另行注册宿主侧同款 fold，两边互不代劳）。读取异常按"无 policy"拒绝指定
 * 模型——保守方向。
 */
export const inject = ['tools', 'jobs', 'shell', 'shellEnv', 'subagents', 'timer', 'sessionProjections', 'agents', 'workingDirectory'];

/**
 * 插件入口：按 `toolName` 是否出现分派角色。
 *
 * **工具角色**——配置是"活"的：工具每次 `execute` 都现读**模块级快照**
 * （宿主行播报的生效配置），快照缺席时退回本行默认值（设计 §5.1）。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} rawConfig - cordis 配置（即组合行的 config）。
 */
export function apply(ctx, rawConfig) {
  // 宿主角色：宿主行没有 `toolName`（本包 `cordis.patch.yml` 的行连 `config:` 键都没有）。
  // 因此**给宿主行写 `toolName` 会把它变成工具行**——那会把工具塞进全局工具层（需求 §3.2），
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
  // 行身份字段不跟随快照（设计 §6.2）：快照来自宿主行（合法地没有归属声明），
  // `owningPreset` 永远取本行装载期值——描述警示与结果诊断的归属判定读它。
  const configView = makeConfigView(() => {
    const snapshot = readSnapshot();
    return snapshot === undefined
      ? initial
      : { ...snapshot, owningPreset: initial.owningPreset };
  });

  const tool = factory(ctx, configView);
  const disposeTool = ctx.tools.register(tool);

  // async_agent 行装载期接线会话模型选择策略——注册投影 fold +
  // 组合作用域监听 agent/created 采样（settings 缺席只跳过采样接线，
  // fold 照注册——读取侧基础设施）。本包 `lib/agent.js` 的路由校验步零改动。
  if (initial.toolName === 'async_agent') wirePolicyRow(ctx);

  // **快照缺席必须说出来，不能静默退回本行默认值。**
  //
  // 静默早退的失败形态：设置页能改、读回是新值、落了盘，
  // **但工具行为一点不变**——取值入口没被换掉。静默早退从外面完全看不出哪一环断了。
  // 缺席的现实范围是"宿主行不在或模块实例断链"，报出来是部署期线索，不是噪声。
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
 * `tool.parameters.properties[k].description`（需求 §5.1）。
 *
 * ## 为什么必须"就地改"而不是"注销再重新注册"
 *
 * 工具表**按引用**保存工具对象（`dsh-scope/lib/index.js:11` "Values are borrowed"），
 * 而每次把工具投影给模型时都会现读它的字段（`schemaOf`：
 * `dsh-tools/lib/index.js:3039-3049`）。因此**改对象上的字段**就能生效。
 *
 * 另一条路（先注销、再重新注册同一个工具）有个致命窗口：`register()` 若抛错，
 * 工具就处在"已注销但没重新注册"的状态，会凭空消失。就地改没有窗口。
 *
 * ## 两处都要改
 *
 * `tool.description` 是模型看到的主描述；`tool.parameters` 是 `defineTool` 由参数说明
 * **转换并固化**出来的 JSON Schema，那里的说明文字不会自己更新，必须一并改写。
 * 只写回**已存在**的参数键：`async_run` 的提权两键按构造时的条件声明决定在不在，
 * 刷新不增删参数集合。
 *
 * 构造处与刷新处调**同一个构建器**（`tool.rebuildText`，由各 `create*Tool` 登记；
 * 缺席时按工具名回退），数字、provider 名与语言都跟着同一次构建走。
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
 * 而间接证据正是"测试只是文本匹配、把实现退化成快照后全绿"的盲区。
 */
export { refreshToolDescriptions };
