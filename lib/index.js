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
 * 六个工具的关键语义（`docs/design.md`）：
 * - `async_run`：首次等待到期**不杀死命令**，转后台并返回作业编号 job_id（需求 §2.2.1）。
 * - `async_wait_job`：有界等待，可被用户**插话**（steer）打断，打断不影响作业
 *   （需求 §2.1.2）；排队（queue）消息不打断。
 * - `async_wait_agent`：有界等待子代理，可被用户**插话**（steer）打断，不影响子代理
 *   （需求 §2.1.2）；排队（queue）消息不打断。
 * - `async_agent`：永远后台的子代理派生，立返 agent_id，不等待不轮询（需求 §2.3.1）；
 *   模型选择策略**每次调用现读** dsh 设置（需求 §2.3.2）。
 * - `async_workflow`：后台编排作业，首次等待与结果取回同前两者口径（需求 §2.4）。
 * - `async_list_subagent_models`：只读路由查询——分页／搜索／准确模型详情＋
 *   目标创建工具适用性判断（需求 §2.3.4）。
 *
 * @module dsh-async-tools
 */
import { LOG_PREFIX, resolveConfig } from './config.js';
import { buildToolText } from './descriptions.js';
import { createAgentTool } from './agent.js';
import { createListModelsTool } from './list-models.js';
import { makeConfigView } from './config-view.js';
import { applyHostHalf } from './host.js';
import { createRunTool } from './jobs.js';
import { createWorkflowTool } from './workflow.js';
import { emitLifecycleNotice } from './notice.js';
import { onSettingsChanged } from './refresh-bus.js';
import { readSnapshot } from './settings.js';
import { registerToolRow } from './tool-rows.js';
import { createWaitAgentTool } from './wait-agent.js';
import { createWaitJobTool } from './wait-job.js';

/** cordis 插件名；预设的六条工具行与本包 `cordis.patch.yml` 的宿主行都以 `dsh-async-tools` 引用。 */
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
 *   `ctx.timer.timeout(cb, ms)`——轮询是**自重排的 timeout 链**（上一轮查询
 *   结束才排下一拍，见 `lib/wait-agent.js` 的串行纪律说明），不消费
 *   `ctx.timer.interval`。**`async_run` 不走 timer**——它的让出窗口走宿主的
 *   `jobs.wait`，且请求显式 `onExpiry: 'none'`（设计 §3.1），正是不让宿主的到期
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
 * `inject` 是**静态模块级**的：宿主行与工具行走同一份声明，这九项服务对宿主行同样
 * 是固定依赖（设置快照本身不消费服务，但静态声明不因此豁免宿主行，见
 * `cordis.patch.yml`）。任一缺席时本插件进入等待而不是启动。宿主半边的可选接线是
 * `lib/host.js` 的运行时 inject：`systemPrompt`（纪律段与预设执行纪律 section）与
 * `sessions` / `sessionProjections` / `agents`（提问接管）——运行时接线条件不满足时
 * 仅该子 scope 不激活，插件入口仍须先满足上面九项固定依赖。
 *
 * `sessionProjections` 服务于模型选择策略的**只读**消费：`async_list_subagent_models`
 * 读原生会话投影给目标适用性判断提供间接证据（`lib/list-models.js`；fold 由宿主
 * 原生行自行注册，本插件不注册同键投影、不做会话采样——需求 §2.3.2 实时口径，
 * 设计 §3.3）。
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
    async_workflow: createWorkflowTool,
    async_list_subagent_models: createListModelsTool
  }[initial.toolName];

  if (factory === undefined) {
    throw new Error(`${LOG_PREFIX} unknown toolName ${JSON.stringify(initial.toolName)}`);
  }

  // 取值入口：宿主行播报的快照优先；缺席（宿主行未装载 / 不在同一模块实例）退回
  // 本行默认值。快照是**读时现取**的，volatile 提交后下一次 execute 就用新值。
  // 行身份字段不跟随快照（设计 §6.2）：快照来自宿主行（合法地没有归属声明），
  // `owningPreset` 永远取本行装载期值——描述警示与结果诊断的归属判定读它。
  // 行级委托键（agentOptions/agentPreset/allowedAgentPresets，需求 §2.3.1）与
  // 行身份字段同层——非 volatile、不进设置表单，快照里同样没有：一律取本行
  // 装载期值，否则宿主行在场的正常部署会把自定义行的委托配置整组丢掉。
  const configView = makeConfigView(() => {
    const snapshot = readSnapshot();
    return snapshot === undefined
      ? initial
      : {
        ...snapshot,
        owningPreset: initial.owningPreset,
        ...(initial.agentOptions === undefined ? {} : { agentOptions: initial.agentOptions }),
        ...(initial.agentPreset === undefined ? {} : { agentPreset: initial.agentPreset }),
        ...(initial.allowedAgentPresets === undefined ? {} : { allowedAgentPresets: initial.allowedAgentPresets })
      };
  });

  const tool = factory(ctx, configView);
  const disposeTool = ctx.tools.register(tool);
  // 行登记（设计 §3.7 身份段）：工具对象 → 本行配置视图。查询工具经
  // `tools.get(name, scope)` 取可见定义后按对象同一性比对，命中即证实该
  // 名下可见的工具正是本包创建行注册的那个，并取**创建行**配置判定目标
  // 后端（WeakMap 弱引用：行卸载对象不可达即消失，无须随 dispose 清理）。
  registerToolRow(tool, configView);

  // 模型选择策略不在此接线：async_agent 每次调用现读 `subagentModelSelection`
  // 服务（实时口径，需求 §2.3.2）；查询工具按需读会话投影。本行不注册投影
  // fold、不监听 agent/created 采样（设计 §3.3）。

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

  // 后端事件触发的同一重算（设计 §5.2 第三类触发源）：宿主子代理后端注册
  // `subagent/provider-added`、注销 `subagent/provider-removed`——替换按宿主
  // 实现成对发布（注销＋重注册各发一事件，无单独替换事件），新增载荷携带
  // 后端现值。事件到达即触发与设置刷新同一函数，就地更新模型侧 schema、
  // 条件键说明与任务书两语形态；后端注册、替换、移除及能力增减
  // （`agentPreset` 支持等）不等待下一次设置变化或先经一次创建调用。同一
  // 后端对象内部的能力或继承方式变化不经事件表达（宿主不广播对象内变化，
  // 只能经重注册传播）——execute 入口的现算仍是正确性锚（事件丢失时投影
  // 滞后到下一触发点，校验与请求不受旧投影影响）。
  const offProviderEvents = typeof ctx.on === 'function'
    ? [
      ctx.on('subagent/provider-added', () => { refreshToolDescriptions(tool, configView); }),
      ctx.on('subagent/provider-removed', () => { refreshToolDescriptions(tool, configView); })
    ]
    : [];

  ctx.effect(() => () => {
    for (const off of offProviderEvents) off();
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
 * `dsh-tools/lib/index.js:3135-3145`）。因此**改对象上的字段**就能生效。
 *
 * 另一条路（先注销、再重新注册同一个工具）有个致命窗口：`register()` 若抛错，
 * 工具就处在"已注销但没重新注册"的状态，会凭空消失。就地改没有窗口。
 *
 * ## 两处都要改
 *
 * `tool.description` 是模型看到的主描述；`tool.parameters` 是 `defineTool` 由参数说明
 * **转换并固化**出来的 JSON Schema，那里的说明文字不会自己更新，必须一并改写。
 *
 * 条件键增删（设计 §5.2）：登记在 `tool.conditionalParameterKeys` 上的键（目前
 * 只有 `async_agent` 的 `agent_preset`）按重算结果对借用 schema **原地增删**——
 * 后端注册、替换或移除随任意一次刷新生效，不等待下一次设置变化；条件键都不是
 * 必填项，`required` 数组不参与增删。未登记的工具不增删参数集合（如
 * `async_run` 的提权两键按构造时条件声明）。
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
  const conditional = Array.isArray(tool.conditionalParameterKeys) ? tool.conditionalParameterKeys : [];
  // 先删：重算结果不再暴露的条件键从借用 schema 移除（后端撤回支持即消失）。
  for (const key of conditional) {
    if (text.parameters[key] === undefined) delete properties[key];
  }
  for (const [key, spec] of Object.entries(text.parameters)) {
    if (properties[key] === undefined) {
      // 后增：重算结果新暴露的条件键整个写入（说明与类型一并，与构造同形）；
      // 非条件键不新增（其余工具的参数集合按构造时条件声明）。
      if (conditional.includes(key)) properties[key] = spec;
      continue;
    }
    if (typeof spec?.description === 'string') {
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
