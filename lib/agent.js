/**
 * `async_agent` 工具：永远后台的子代理派生，立返 agent_id（需求 §2.3.1，设计 §3.3）。
 *
 * ## 这个工具的形状就是它的纪律
 *
 * - **没有 `run_in_background` 参数**——后台不是模型的选择，是工具的形状；
 *   一次前台委托独占整个工具批次，这正是本插件要消灭的空转形态。
 * - **不注册任何定时器、监听器、作业**：不等待就没有打断问题
 *   （消息唤醒规则不适用于本工具），等待交给 `async_wait_agent`。
 * - 参数为 `description` + `prompt` + 可选的 `provider`+`model`（成对，模型路由，
 *   经 `request.agentOptions` 生效）；**未声明键一律显式报错**——开放 schema
 *   会静默吞掉多余键，这是它的对冲。`reasoning_effort`/`persona`/
 *   `toolFilter`/`maxDepth` 仍不透传——全功能委托入口仍是宿主的 `subagent` 工具，
 *   本工具是「一两个委托用 async_agent、大规模编排才用 workflow」这条纪律
 *   （需求 §2.4）的机制半边，不是替代品。
 *
 * ## 派生只走公共契约的正规入口
 *
 * `ctx.subagents.startContinuable({ provider, label, request, signal })` → `{ childId }`
 * （与宿主 `dsh-tool-subagent` 的后台 continuable 路径同一形状）。宿主给非
 * continuable provider 的 `jobs.start({kind:'subagent'})` 备用路径**不走**：`childId`
 * 直接就是 `async_wait_agent` 的等待对象，没有 job↔child 对照要维护（设计 §3.3 取舍）。
 *
 * @module dsh-async-tools/agent
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent';
import { LOG_PREFIX } from './config.js';
import { buildToolText } from './descriptions.js';
import { t } from './text.js';

/** 参数声明集合（未声明键的对照基准；与 parameters 的键一一对应）。 */
const DECLARED_ARGUMENTS = ['description', 'prompt', 'provider', 'model'];

/**
 * 构造 `async_agent` 工具定义。
 * @param {object} ctx - cordis 上下文（`ctx.subagents` 公共接口 + `ctx.sessionProjections` 白名单投影）。
 * @param {object} config - 生效配置视图（`subagentProvider`/`defaultWaitMs` 现读现取）。
 * @returns {object} ToolDefinition。
 */
export function createAgentTool(ctx, config) {
  // 描述经 `buildToolText` 整段构建（构造处与刷新处同一份）；provider 名片段
  // 的数字/名字随设置就地重建（`refreshToolDescriptions`）。
  const rebuildText = (cfg) => buildToolText('async_agent', cfg);
  const text = rebuildText(config);
  const tool = defineTool({
    name: 'async_agent',
    description: text.description,
    parameters: text.parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          agent_id: { type: 'string', required: true },
          note: { type: 'string', required: true }
        }
      },
      // 模型只看得见 render 的输出——agent_id 必须出现在这里；语言档现读。
      render: (_args, value) => [{
        type: 'text',
        text: t(config.agentLang, 'render.agentStarted', { agentId: value.agent_id }) + value.note
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const lang = config.agentLang;
      // 步 1：agent-less 驱动直接拒绝（同款纪律：不派生、错误可读，需求 §2.3.1）。
      const agent = exec.agent;
      if (agent === undefined || agent === null) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.requiresAgent')}`);
      }

      // 步 2：未声明键显式报错——静默吞键的对冲（参数根对象是隐式开放对象，宿主层不挡）。
      const unknown = Object.keys(args).filter((key) => !DECLARED_ARGUMENTS.includes(key));
      if (unknown.length > 0) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.unsupportedArgs', {
          keys: unknown.join(', '),
          supported: DECLARED_ARGUMENTS.join(', ')
        })}`);
      }

      // 步 3：成对与非空（宿主 tool-subagent 同款文案，便于并读）。
      if ((args.provider === undefined) !== (args.model === undefined)) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.pairTogether')}`);
      }
      const selectsRoute = args.provider !== undefined;
      if (selectsRoute && args.provider.length === 0) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.providerNonEmpty')}`);
      }
      if (selectsRoute && args.model.length === 0) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.modelNonEmpty')}`);
      }

      // 步 4：模型路由校验（仅显式选择；纯继承不进 policy——宿主同款语义）。
      if (selectsRoute) {
        // reducer 由宿主 tool-subagent 行注册；读不到值——投影初值 null、
        // 键未注册（宿主 stateOf 对未注册键返回 undefined 而不抛）、读取抛错（服务
        // 缺席、折叠异常）——一律按"无 policy"处理，try/catch 兜住。保守方向，宁可拒绝。
        // 读到的值还要先验 `Array.isArray`——对象型/字符串型 state 注入会在
        // `.some` 上 TypeError 崩栈，同样按"无 policy"走词典错误。
        let routes;
        try {
          const state = ctx.sessionProjections?.stateOf(agent.session, 'subagentModelSelectionPolicy');
          routes = state === null || state === undefined ? undefined : state;
        } catch {
          routes = undefined;
        }
        if (routes === undefined || !Array.isArray(routes)) {
          throw new Error(`${LOG_PREFIX} ${t(lang, 'error.noPolicy')}`);
        }
        if (!routes.some((route) => route.provider === args.provider && route.model === args.model)) {
          throw new Error(`${LOG_PREFIX} ${t(lang, 'error.routeNotAllowed', { provider: args.provider, model: args.model })}`);
        }
      }

      // 步 5：provider 名来自生效配置（设置可改，读取走活视图——需求 §5.1）。
      const providerName = config.subagentProvider;
      const provider = ctx.subagents.getProvider(providerName);
      if (provider === undefined) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.providerNotRegistered', { provider: providerName })}`);
      }

      // 步 6：continuable 后台要求 provider 有 prepareContinuable（宿主 `:380` 的插件级预检）。
      if (provider.prepareContinuable === undefined) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.noContinuable', { provider: providerName })}`);
      }

      // 步 6b：指定路由时 provider 必须声明 agentOptions 支持（宿主 spawn/fork 都声明）
      // ——不声明支持的后端对 agentOptions 的处置无从约定，宁可当场报错，
      // 不给"传参不生效"留漏洞（静默失败零容忍的延伸）。
      if (selectsRoute && provider.capabilities?.agentOptions !== true) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.noAgentOptions', { provider: providerName })}`);
      }

      // 步 7：request 形状逐字段对齐宿主契约（宿主 `:509-520`）；传入模型路由时追加
      // agentOptions——恰 provider/model 两键（换路由清 effort 由 driver 的
      // resolveChildAgentOptions 按宿主语义处理）；未传时不带该键 ⇒ driver 走父路由继承。
      const request = {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }],
        parent: agent
      };
      if (selectsRoute) {
        request.agentOptions = { provider: args.provider, model: args.model };
      }
      const { childId } = await ctx.subagents.startContinuable({
        provider: providerName,
        label: args.description,
        request,
        signal: exec.signal
      });

      // 步 8：唯一出口。note 里的数字现读现取（预算纪律，需求 §5.1）；末行是实际生效路由的回执。
      const routeLine = selectsRoute
        ? t(lang, 'route.requested', { provider: args.provider, model: args.model })
        : inheritedRouteLine(lang, agent);
      return {
        status: 'started',
        agent_id: childId,
        note: t(lang, 'note.agentStarted', { agentId: childId, defaultWaitMs: config.defaultWaitMs }) + routeLine
      };
    }
  });
  tool.rebuildText = rebuildText;
  return tool;
}

/**
 * 未指定路由时的回执行：现读父路由（`parentAgentOptionsForDelegation` 与 driver 的
 * `resolveChildAgentOptions` 同一数据源——`session.requestHeader()?.config` 优先，回退
 * `agent.options`）；读不出具体值时不编造，写"继承父路由"。
 * @param {string} lang - 语言档。
 * @param {object} agent - 发起派生的父 Agent。
 * @returns {string} note 的末行。
 */
function inheritedRouteLine(lang, agent) {
  let inherited;
  try {
    const parentOptions = parentAgentOptionsForDelegation(agent);
    if (parentOptions.provider !== undefined && parentOptions.model !== undefined) {
      inherited = `${parentOptions.provider}/${parentOptions.model}`;
    }
  } catch {
    inherited = undefined;
  }
  return inherited === undefined
    ? t(lang, 'route.inherits')
    : t(lang, 'route.inherited', { route: inherited });
}
