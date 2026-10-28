/**
 * `async_agent` 工具：永远后台的子代理派生，立返 agent_id（需求 §2.3.1/§2.3.2，设计 §3.3）。
 *
 * ## 这个工具的形状就是它的纪律
 *
 * - **没有 `run_in_background` 参数**——后台不是模型的选择，是工具的形状；
 *   一次前台委托独占整个工具批次，这正是本插件要消灭的空转形态。
 * - **不注册任何定时器、监听器、作业**：不等待就没有打断问题
 *   （消息唤醒规则不适用于本工具），等待交给 `async_wait_agent`。
 * - 公开参数与目标版本 dsh 原生子代理创建工具同形（需求 §2.3.1 公共参数兼容）：
 *   `description`＋`prompt` 必填；`cwd` 可选；`provider`＋`model` 可选成对；
 *   `reasoning_effort` 可选非空、可单独指定；`agent_preset` 仅行配置了可选预设
 *   集合且后端支持时暴露，按允许集合校验。**未声明键一律显式报错**——开放
 *   schema 会静默吞掉多余键，这是它的对策。`persona`／`toolFilter`／`maxDepth`
 *   仍不透传——全功能委托入口仍是宿主的 `subagent` 工具，本工具是「一两个委托
 *   用 async_agent、大规模编排才用 workflow」这条纪律（需求 §2.4）的机制半边，
 *   不是替代品。
 *
 * ## 模型选择策略实时读取（需求 §2.3.2）
 *
 * 每次调用经 `subagentModelSelection` 服务 `current()` 现读 dsh 的模型选择开关
 * 与允许名单（volatile，读即当前值）：开关关闭→显式路由/推理强度被拒；服务
 * 缺席或 `current()` 抛错→按真实原因可读拒绝；纯默认/继承派生不读策略不受
 * 名单变化影响；一次调用内合并与校验共用同一份读取快照，预检通过后、启动前
 * 重读确认所选路由仍在名单内（撤回即拒绝，不换模型不重试）。本行**不**注册
 * 同键投影、**不**做会话采样（设计 §3.3——原生工具的会话冻结策略与这里的
 * 实时名单是两条口径，互不改写）。
 *
 * ## 路由合并与预检（需求 §2.3.1，与目标原生工具同语义）
 *
 * 合并顺序：显式请求覆盖「后端 `agentRouteDefaults` ⊕ 工具行配置 `agentOptions`」
 * 构成的配置默认；父路由值只补缺项（宿主派生侧完成）；换路由未指定推理强度
 * 时不沿用旧路由的值（`reasoningEffort` 在运行时即普通字符串——宿主的
 * `ReasoningEffortId` 只是 TS 品牌类型，运行时恒等）。显式请求或配置了路由类
 * 默认时，创建前经 `llm.resolveCallConfig` 预检有效路由，预检后复查后端未变、
 * 调用未取消。可更换路由解决的拒绝（名单外、预检、重读撤回）保留真实原因并
 * 提示 `async_list_subagent_models`（目标工具条件 `target_tool="async_agent"`，
 * 需求 §2.3.1 末条）；回执行按实际携带的 agentOptions 逐值标注来源（显式请求/
 * 工具配置默认/后端默认/父继承四档，读不到具体值时如实说明）。
 *
 * ## 派生只走公共契约的正规入口
 *
 * `ctx.subagents.startActivation({ provider, label, request, signal, delivery })` →
 * `{ childId, messageId?, result, dispose }`（宿主 `SubagentActivationSpec`／
 * `SubagentActivation` 契约，dsh-subagent）。`delivery: 'parent'`：最终回答经宿主
 * 通知交付父会话，本包不转投 `caller`、不补发答案。非 continuable provider 的
 * 外部单次执行路径**不走**：本工具只接受带 `prepareContinuable` 的可续后端，
 * `childId` 直接就是 `async_wait_agent` 的等待对象，没有 job↔child 对照要维护
 * （设计 §3.3 取舍）。
 *
 * ## 启动回执之后的所有权纪律（设计 §3.3）
 *
 * - 调用只 await「启动被宿主接受」，不 await `activation.result`——立返即纪律；
 * - `result` 是观察通道：正常结算不在工具结果里复述答案；非 `completed` 结局与
 *   基础设施拒绝经 stderr 诊断出口播报（附准确 child id），两类落点都承接，
 *   不产生进程级未处理拒绝，也不伪装成创建失败或已通知父会话；
 * - `dispose()` 不在本包调用之列：自然结算由宿主释放，显式停止走宿主管理入口；
 *   发布后本包不持有、不缓存 activation 句柄。
 *
 * @module dsh-async-tools/agent
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent';
import { LOG_PREFIX } from './config.js';
import { agentConditionalKeys, buildToolText } from './descriptions.js';
import { emitLifecycleNotice } from './notice.js';
import { escapeLogValue } from './output.js';
import { t } from './text.js';

/** 宿主原文进模型侧的单行化截断上限（需求 §6.2；完整原文进操作者日志）。 */
const MODEL_REASON_LIMIT = 500;

/**
 * 宿主原文按 6.3 口径单行化并截断（CR/LF/TAB 折成空格，超长加省略计数）。
 * @param {unknown} error - `llm.resolveCallConfig` 抛出的拒绝。
 * @returns {string} 模型侧可读的单行原因。
 */
function singleLineReason(error) {
  const flat = String(error?.message ?? error).replace(/[\r\n\t]+/g, ' ').trim();
  return flat.length > MODEL_REASON_LIMIT
    ? `${flat.slice(0, MODEL_REASON_LIMIT)} (+${flat.length - MODEL_REASON_LIMIT})`
    : flat;
}

/**
 * 显式请求是否涉及任一子模型值（宿主 `hasDelegationModelRequest` 同形：
 * provider／model／reasoning_effort 任一在场即命中——纯继承不进策略）。
 * @param {object} request - 模型侧参数。
 * @returns {boolean}
 */
function hasModelRequest(request) {
  return request.provider !== undefined || request.model !== undefined || request.reasoning_effort !== undefined;
}

/**
 * 工具行配置是否声明了路由类默认（宿主 `hasConfiguredLlmSelection` 同形）——
 * 决定是否把后端路由默认折进携带值并触发创建前预检。
 * @param {object|undefined} agentOptions - 行配置 `agentOptions`。
 * @returns {boolean}
 */
function hasConfiguredLlmSelection(agentOptions) {
  return agentOptions?.provider !== undefined || agentOptions?.model !== undefined
    || agentOptions?.reasoningEffort !== undefined;
}

/**
 * 路由合并——宿主 `requestedAgentOptions` 同语义副本（需求 §2.3.1，设计 §3.3）：
 * 显式请求覆盖配置默认；provider/model 成对覆盖；换路由且未指定推理强度时
 * 丢弃配置默认中的旧值（`configuredWithoutReasoning`），由所选模型默认值接管；
 * 无任何显式请求时原样返回配置默认（可能为 undefined ⇒ 不携带该键）。
 * 成对/非空校验由调用方先行完成；`enabled` 在实时口径下恒真（禁用已在读策略
 * 阶段拒绝），保留形参以与宿主语义逐字一致。
 * @param {object} parentOptions - 父代理当前路由值（基线参与 routeChanged 判定）。
 * @param {object|undefined} configured - 配置默认（行配置，或行配置⊕后端路由默认）。
 * @param {object} request - 模型侧参数。
 * @returns {object|undefined} 携带的 agentOptions；无任何层贡献则 undefined。
 */
function requestedAgentOptions(parentOptions, configured, request) {
  if (!hasModelRequest(request)) return configured;
  const baselineProvider = configured?.provider ?? parentOptions.provider;
  const baselineModel = configured?.model ?? parentOptions.model;
  const routeChanged = request.provider !== undefined
    && (request.provider !== baselineProvider || request.model !== baselineModel);
  const { reasoningEffort: _configuredEffort, ...configuredWithoutReasoning } = configured ?? {};
  return {
    ...routeChanged && request.reasoning_effort === undefined ? configuredWithoutReasoning : configured,
    ...request.provider === undefined ? {} : { provider: request.provider, model: request.model },
    ...request.reasoning_effort === undefined ? {} : { reasoningEffort: request.reasoning_effort }
  };
}

/**
 * 现读一份模型选择策略快照（需求 §2.3.2）。服务缺席与 `current()` 抛错
 * （启用空名单、非法或重复路由等坏配置）都按真实原因转成可读词典错误。
 * @param {object} ctx - cordis 上下文。
 * @param {string} lang - 语言档。
 * @returns {{enabled: boolean, allowedModels: Array<{provider: string, model: string}>}}
 * @throws {Error} 服务缺席或读取失败。
 */
function readCurrentPolicy(ctx, lang) {
  const settings = ctx.get('subagentModelSelection');
  if (settings === undefined) {
    throw new Error(`${LOG_PREFIX} ${t(lang, 'error.policyUnavailable')}`);
  }
  try {
    return settings.current();
  } catch (error) {
    // 包装错误挂原始异常（rawReason）：启动前重读（步 12）诊断①要转述真实原错，
    // 不能把这里的包装文案当原错重复转述（需求 §5.7.2 只陈述已证实的原因）。
    const wrapped = new Error(`${LOG_PREFIX} ${t(lang, 'error.policyReadFailed', { reason: String(error?.message ?? error) })}`);
    wrapped.rawReason = error;
    throw wrapped;
  }
}

/**
 * 构造 `async_agent` 工具定义。
 * @param {object} ctx - cordis 上下文（`ctx.subagents` 公共接口；`subagentModelSelection`／`llm` 按调用可选读取）。
 * @param {object} config - 生效配置视图（`subagentProvider`/`defaultWaitMs`/委托行级键现读现取）。
 * @returns {object} ToolDefinition。
 */
export function createAgentTool(ctx, config) {
  // 描述经 `buildToolText` 整段构建（构造处与刷新处同一份）；provider 名片段、
  // 条件键与上下文可见性经 `agentConditionalKeys` 现算（设计 §5.2：构造、刷新、
  // execute 校验共用同一重算函数——后端注册、替换或移除随任意重算点生效，
  // 不等待下一次设置变化）。行级委托键（`lib/config.js` 根形态）设置快照不含、
  // 装载后不变，重算中该分量稳定；后端分量随 `getProvider` 现读。
  const rebuildText = (cfg) => {
    const keys = agentConditionalKeys(ctx, cfg);
    return buildToolText('async_agent', cfg, {
      presetChoices: keys.presetChoices,
      presetSupported: keys.presetExposed,
      inheritsParentContext: keys.inheritsParentContext
    });
  };
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

      // 步 2：未声明键显式报错——静默吞键的对策（参数根对象是隐式开放对象，宿主层不挡）。
      // 校验集合经同一重算函数现算（设计 §5.2：与模型侧 schema、描述、实际请求
      // 四处同步）；顺手把借用 schema 的条件键就地同步到重算结果——后端变化随
      // 本调用生效，宿主下一次投影即见（刷新侧 `refreshToolDescriptions` 同款）。
      const keyState = agentConditionalKeys(ctx, config);
      syncConditionalParameterKey(tool, keyState, () => rebuildText(config));
      const declaredArguments = keyState.declaredArguments;
      const unknown = Object.keys(args).filter((key) => !declaredArguments.includes(key));
      if (unknown.length > 0) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.unsupportedArgs', {
          keys: unknown.join(', '),
          supported: declaredArguments.join(', ')
        })}`);
      }

      // 步 3：成对与非空（宿主 tool-subagent 同款判据；reasoning_effort 同列）。
      if ((args.provider === undefined) !== (args.model === undefined)) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.pairTogether')}`);
      }
      if (args.provider !== undefined && args.provider.length === 0) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.providerNonEmpty')}`);
      }
      if (args.model !== undefined && args.model.length === 0) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.modelNonEmpty')}`);
      }
      if (args.reasoning_effort !== undefined && args.reasoning_effort.length === 0) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.effortNonEmpty')}`);
      }
      const selectsModel = hasModelRequest(args);

      // 步 4：agent_preset 解析（行配置允许集合；缺省用行配置默认或继承父预设）。
      // presetChoices 与步 2 的校验集合同一重算——显式选择到达这里时集合必含
      // agent_preset，缺席分支是集合计算与校验间意外漂移的防御闭合。
      let effectivePreset;
      if (args.agent_preset !== undefined) {
        const presetChoices = keyState.presetChoices;
        if (presetChoices === undefined) {
          throw new Error(`${LOG_PREFIX} ${t(lang, 'error.presetNotConfigured')}`);
        }
        if (!presetChoices.includes(args.agent_preset)) {
          throw new Error(`${LOG_PREFIX} ${t(lang, 'error.presetNotAllowed', { choices: presetChoices.join(', ') })}`);
        }
        effectivePreset = args.agent_preset;
      } else if (config.agentPreset !== undefined) {
        effectivePreset = config.agentPreset;
      }

      // 步 5：模型选择策略现读（仅显式请求；纯默认/继承不读策略不受名单变化
      // 影响——需求 §2.3.2）。同一份快照供合并后校验，不重复读取。
      let policy;
      if (selectsModel) {
        policy = readCurrentPolicy(ctx, lang);
        if (policy.enabled !== true) {
          throw new Error(`${LOG_PREFIX} ${t(lang, 'error.selectionDisabled')}`);
        }
      }

      // 步 6：provider 名来自生效配置（设置可改，读取走活视图——需求 §5.1）。
      const providerName = config.subagentProvider;
      const provider = ctx.subagents.getProvider(providerName);
      if (provider === undefined) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.providerNotRegistered', { provider: providerName })}`);
      }

      // 步 7：可续后端要求 provider 有 prepareContinuable——宿主 startActivation 以
      // 该方法在场性选择本地执行（SubagentProvider 契约：方法缺席走外部单次执行，
      // 子级不接受后续消息）。本工具只承诺可续后端（设计 §3.3），预检放在派生前。
      if (provider.prepareContinuable === undefined) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.noContinuable', { provider: providerName })}`);
      }

      // 步 8：预设的后端条件（宿主 SubagentPresetSelection.assertProvider 同判据：
      // capabilities.agentPreset 且非 inheritsParentContext）——配置了默认预设或
      // 显式选择时都要求后端支持，派生前可读失败（设计 §3.3）。
      if (effectivePreset !== undefined
        && (provider.capabilities?.agentPreset !== true || provider.inheritsParentContext === true)) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.presetNoBackend', { provider: providerName })}`);
      }

      // 步 9：路由合并（宿主 requestedAgentOptions 同语义）。携带判据＝任一层
      // 贡献任一键（路由类与非路由类同样参与，如仅 maxTokens 的行配置）；
      // 预检触发与后端默认折并条件与宿主 requiresRoutePreflight 同形：显式
      // 请求或行配置了路由类默认时，配置默认 =
      // 后端 agentRouteDefaults ⊕ 行配置 agentOptions；否则配置默认就是行配置
      // 值（可能为 undefined ⇒ 不携带 agentOptions，父路由继承交宿主派生侧）。
      const rowAgentOptions = config.agentOptions;
      const requiresPreflight = selectsModel || hasConfiguredLlmSelection(rowAgentOptions);
      const configuredBase = requiresPreflight && provider.agentRouteDefaults !== undefined
        ? { ...provider.agentRouteDefaults, ...rowAgentOptions }
        : rowAgentOptions;
      const parentOptions = parentAgentOptionsForDelegation(agent);
      const mergedOptions = requestedAgentOptions(parentOptions, configuredBase, args);

      // 步 9b：携带 agentOptions 需要后端声明支持（宿主服务层同款要求；
      // 不声明支持的后端对 agentOptions 的处置无从约定，宁可当场报错）。
      if (mergedOptions !== undefined && provider.capabilities?.agentOptions !== true) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.noAgentOptions', { provider: providerName })}`);
      }

      // 步 10：名单校验（宿主 assertAllowedModelSelection 同语义，策略换成实时
      // 快照）：显式请求的最终有效路由必须落在当前允许名单内——推理强度单独
      // 指定时按「配置默认⊕父值」补出的有效路由校验。可换路由解决的拒绝在
      // 文案里指路 async_list_subagent_models（需求 §2.3.1 末条）。
      if (selectsModel) {
        const provider_ = mergedOptions?.provider ?? parentOptions.provider;
        const model_ = mergedOptions?.model ?? parentOptions.model;
        if (provider_ === undefined || model_ === undefined) {
          throw new Error(`${LOG_PREFIX} ${t(lang, 'error.noEffectiveRoute')}`);
        }
        if (!policy.allowedModels.some((route) => route.provider === provider_ && route.model === model_)) {
          throw new Error(`${LOG_PREFIX} ${t(lang, 'error.routeNotAllowed', { provider: provider_, model: model_ })}`);
        }
      }

      // 步 11：创建前预检（宿主 preflightChildLlmRoute 同语义）：经
      // llm.resolveCallConfig 让 LLM 运行时校验有效路由与推理强度；推理强度的
      // 父继承仅在后端无路由默认且有效路由未变时参与（宿主同款）。
      if (requiresPreflight) {
        const llm = ctx.get('llm');
        if (llm === undefined) {
          throw new Error(`${LOG_PREFIX} ${t(lang, 'error.llmUnavailable')}`);
        }
        const provider_ = mergedOptions?.provider ?? parentOptions.provider;
        const model_ = mergedOptions?.model ?? parentOptions.model;
        if (provider_ === undefined || model_ === undefined) {
          throw new Error(`${LOG_PREFIX} ${t(lang, 'error.noEffectiveRoute')}`);
        }
        const routeChanged = provider_ !== parentOptions.provider || model_ !== parentOptions.model;
        const inheritEffort = provider.agentRouteDefaults === undefined && !routeChanged;
        const reasoningEffort = mergedOptions?.reasoningEffort
          ?? (inheritEffort ? parentOptions.reasoningEffort : undefined);
        try {
          await llm.resolveCallConfig({
            provider: provider_,
            model: model_,
            ...reasoningEffort === undefined ? {} : { reasoningEffort }
          }, exec.signal);
        } catch (error) {
          // 预检拒绝＝可换路由解决的拒绝（设计 §3.3）：保留真实原因——宿主原文
          // 按 6.3 口径单行化截断进模型侧，完整原因进操作者日志；按 agentLang
          // 补查询指引并保留目标工具条件。发生在创建前：零派生、不返回 child id。
          // 路由标识（provider_/model_）可源自配置与模型可控参数（§6.2 日志
          // 注入防线），与原因同口径经 escapeLogValue 单行化——不转义则模型
          // 可控换行能在操作者日志里伪造出行。
          emitLifecycleNotice(
            `${LOG_PREFIX} 子代理路由预检拒绝（${escapeLogValue(String(provider_))}/${escapeLogValue(String(model_))}）：${escapeLogValue(String(error?.message ?? error))}`
          );
          throw new Error(`${LOG_PREFIX} ${t(lang, 'error.preflightRejected', { reason: singleLineReason(error) })}`);
        }
        // 预检是 await：期间后端可能被替换——宿主同款复查后未变才继续。
        if (ctx.subagents.getProvider(providerName) !== provider) {
          throw new Error(`${LOG_PREFIX} ${t(lang, 'error.providerChanged', { provider: providerName })}`);
        }
      }
      exec.signal?.throwIfAborted();

      // 步 12：启动前重读名单（需求 §2.3.2）：预检让出的窗口里名单可能被撤回，
      // 与步 5 不是同一份快照。三类结局各自分键诊断（设计 §3.3）：读取失败保留
      // 真实原错并给查询／重试出路；开关关闭复用 selectionDisabled；名单撤销才
      // 用撤销口径。三者都零派生：不换模型、不重试、不返回 child id。
      if (selectsModel) {
        let recheck;
        try {
          recheck = readCurrentPolicy(ctx, lang);
        } catch (error) {
          // 诊断①读取失败：只陈述已证实的原因——读取失败≠设置已变化。原错按
          // 6.3 口径单行化截断进模型侧，完整原错进操作者日志（与预检拒绝先例
          // 同通道）；给查询与重试出路。readCurrentPolicy 的服务缺席分支抛出
          // 的错误自带本包前缀（无 rawReason），嵌入 {reason} 前剥一层，避免
          // 双前缀。
          const raw = error?.rawReason ?? error;
          const rawText = String(raw?.message ?? raw);
          const reasonSource = rawText.startsWith(`${LOG_PREFIX} `)
            ? rawText.slice(LOG_PREFIX.length + 1)
            : rawText;
          const reason = singleLineReason(reasonSource);
          const route = `${mergedOptions?.provider ?? parentOptions.provider}/${mergedOptions?.model ?? parentOptions.model}`;
          emitLifecycleNotice(
            `${LOG_PREFIX} 子代理启动前重读模型选择设置失败（${escapeLogValue(providerName)}，有效路由 ${escapeLogValue(route)}）：${escapeLogValue(String(raw?.message ?? raw))}`
          );
          throw new Error(`${LOG_PREFIX} ${t(lang, 'error.routeRecheckReadFailed', { reason })}`);
        }
        if (recheck.enabled !== true) {
          // 诊断②开关关闭：预检后被关掉，与步 5 的拒绝同口径（selectionDisabled）。
          throw new Error(`${LOG_PREFIX} ${t(lang, 'error.selectionDisabled')}`);
        }
        const provider_ = mergedOptions?.provider ?? parentOptions.provider;
        const model_ = mergedOptions?.model ?? parentOptions.model;
        if (!recheck.allowedModels.some((route) => route.provider === provider_ && route.model === model_)) {
          // 诊断③名单撤销：唯一「设置已变化」场景，指路查询工具复核。
          throw new Error(`${LOG_PREFIX} ${t(lang, 'error.routeRecheckFailed')}`);
        }
      }

      // 步 13：request 形状逐字段与类型契约保持一致
      // （SubagentActivationSpec.request = Omit<SubagentStartRequest,'label'|
      // 'signal'>）。展示名 `label`、创建 signal 与投递策略 `delivery` 都是 spec
      // 的**顶层**字段；`cwd` 缺省继承父当前有效目录、相对路径由宿主按该目录
      // 解析（本包只透传）；`agentOptions` 仅在任一层贡献时携带；宿主 request
      // 另有 `outputSchema`／`maxDepth` 可选字段，公开参数集合不因此扩展。
      const request = {
        prompt: [{ type: 'text', text: args.prompt }],
        parent: agent
      };
      if (args.cwd !== undefined) request.cwd = args.cwd;
      if (effectivePreset !== undefined) request.agentPreset = effectivePreset;
      if (mergedOptions !== undefined) request.agentOptions = mergedOptions;
      const activation = await ctx.subagents.startActivation({
        provider: providerName,
        label: args.description,
        request,
        signal: exec.signal,
        delivery: 'parent'
      });
      // 回执到手立即登记 result 观察（成功与拒绝两分支都承接），再取 child id
      // 返回——execute 全程不 await result，这就是「立返不被结算拖住」的实现形状。
      observeActivationResult(activation);
      const { childId } = activation;

      // 步 14：唯一出口。note 里的数字现读现取（预算纪律，需求 §5.1）；末两行
      // 是实际生效路由与推理强度的回执——按创建请求实际携带的 agentOptions 逐
      // 值标注来源（设计 §3.3 四档：显式请求 / 工具配置默认（行 agentOptions）/
      // 后端默认（agentRouteDefaults；并存时行配置覆盖）/ 父继承。行配置只给
      // 单侧或行配置与后端默认各供一侧时，provider 与 model 两部分**各自**标注
      // 来源——有效值以携带值优先、携带缺该侧时由宿主派生侧按父值补
      // （resolveChildAgentOptions＝父值⊕请求覆盖，不应用后端路由默认）。
      // 读不到具体值时如实说明，不编造；回执条目不重述策略状态，只写实际
      // 生效值与来源）。
      const routeLine = routeReceiptLine(lang, {
        args, mergedOptions, rowAgentOptions, provider, requiresPreflight, parentOptions, agent
      });
      const effortSuffix = effortReceiptSuffix(lang, args, {
        mergedOptions, rowAgentOptions, provider, parentOptions
      });
      return {
        status: 'started',
        agent_id: childId,
        note: t(lang, 'note.agentStarted', { agentId: childId, defaultWaitMs: config.defaultWaitMs })
          + routeLine + effortSuffix
      };
    }
  });
  tool.rebuildText = rebuildText;
  // 刷新侧条件键增删的白名单（设计 §5.2：只有 async_agent 的 agent_preset 随
  // 重算增删；其余工具的参数集合按构造时条件声明，刷新不增删）。
  tool.conditionalParameterKeys = ['agent_preset'];
  return tool;
}

/**
 * 推理强度回执的来源四档（设计 §3.3）：显式请求 → 携带的配置默认（行
 * `agentOptions` 与后端 `agentRouteDefaults` 区分，行配置覆盖后者）→ 父继承
 * （仅当有效路由未变且后端无路由默认，与步 11 预检的继承判据同一形状）。
 * 无从判定时返回空串——不编造附注。
 * @param {string} lang - 语言档。
 * @param {object} args - 模型侧参数。
 * @param {object} parts - execute 作用域内的合并产物。
 * @param {object|undefined} parts.mergedOptions - 实际携带的 agentOptions。
 * @param {object|undefined} parts.rowAgentOptions - 行配置 agentOptions。
 * @param {object} parts.provider - 当前后端对象。
 * @param {object} parts.parentOptions - 父代理当前路由值。
 * @returns {string} 附注串（可为空）。
 */
function effortReceiptSuffix(lang, args, { mergedOptions, rowAgentOptions, provider, parentOptions }) {
  if (args.reasoning_effort !== undefined) {
    return t(lang, 'route.effortSuffix', { effort: args.reasoning_effort });
  }
  if (mergedOptions?.reasoningEffort !== undefined) {
    return rowAgentOptions?.reasoningEffort !== undefined
      ? t(lang, 'route.effortConfigured', { effort: mergedOptions.reasoningEffort })
      : t(lang, 'route.effortBackend', { effort: mergedOptions.reasoningEffort });
  }
  const effectiveProvider = mergedOptions?.provider ?? parentOptions.provider;
  const effectiveModel = mergedOptions?.model ?? parentOptions.model;
  const routeUnchanged = effectiveProvider === parentOptions.provider && effectiveModel === parentOptions.model;
  return provider.agentRouteDefaults === undefined && routeUnchanged && parentOptions.reasoningEffort !== undefined
    ? t(lang, 'route.effortInherited', { effort: parentOptions.reasoningEffort })
    : '';
}

/**
 * 借用 schema 的条件键就地同步（设计 §5.2）：重算的在场性与 `properties` 不一致
 * 时增删 `agent_preset`——宿主投影每次现读工具字段，就地改写即对下一次投影生效，
 * 后端注册、替换或移除不等待下一次设置变化。仅在差异时重建文本（零差异零开销）。
 * @param {object} tool - 已注册的工具定义（借用对象）。
 * @param {object} keyState - `agentConditionalKeys` 的重算结果。
 * @param {(cfg: object) => object} build - 文本重建入口（`rebuildText`）。
 * @returns {void}
 */
function syncConditionalParameterKey(tool, keyState, build) {
  const properties = tool.parameters?.properties;
  if (properties === undefined) return;
  const present = properties.agent_preset !== undefined;
  if (present === keyState.presetExposed) return;
  if (!keyState.presetExposed) {
    delete properties.agent_preset;
    return;
  }
  const spec = build().parameters.agent_preset;
  if (spec !== undefined) properties.agent_preset = spec;
}

/**
 * 为 activation.result 登记观察处理（设计 §3.3「result 只是观察通道」的落点）。
 *
 * - 正常结算（`stopReason: 'completed'`）静默：答案经宿主 `delivery:'parent'` 通知
 *   进入父会话，本包不在工具结果里复述、不重复投递；
 * - 非 completed 结局（aborted／error／max-tokens／refusal 等后端可扩展变体）与
 *   基础设施拒绝（capture 失败时 result 拒绝）经 stderr 诊断出口播报，附准确
 *   child id——不伪装成创建失败、成功结算或已通知父会话，也不让拒绝落成进程级
 *   未处理异常（需求 §2.3.1「不遗留未承接的异步拒绝」）；
 * - 观察器自身的异常同样被安全网接住：诊断路径失效不允许反过来打掉插件或进程，
 *   也不建立任何 result 缓存。
 *
 * @param {object} activation - startActivation 的回执（含 `childId` 与 `result`）。
 * @returns {void}
 */
function observeActivationResult(activation) {
  activation.result.then(
    (settled) => {
      if (settled?.stopReason !== undefined && settled.stopReason !== 'completed') {
        const diagnostic = typeof settled.diagnostic === 'string' && settled.diagnostic.length > 0
          ? ` diagnostic: ${escapeLogValue(settled.diagnostic)}`
          : '';
        emitLifecycleNotice(
          `${LOG_PREFIX} 子代理 ${activation.childId} 以非完成结局收场（stopReason=${settled.stopReason}）${diagnostic}；最终回答是否送达以宿主通知为准`
        );
      }
    },
    (error) => {
      emitLifecycleNotice(
        `${LOG_PREFIX} 子代理 ${activation.childId} 结果通道拒绝（基础设施故障）：${escapeLogValue(String(error))}`
      );
    }
  ).catch(() => {
    // 观察处理器自身抛错只能吞掉——emitLifecycleNotice 已自带不抛保证，这里再接住
    // escapeLogValue 等理论上的意外，绝不让诊断路径变成新的故障源。
  });
}

/**
 * 路由回执条目（设计 §3.3）：按实际生效路由逐部分标注来源。显式请求整行
 * 「按请求」；未携带 agentOptions 时实际生效即父继承（宿主派生侧只做父值
 * ⊕请求覆盖，不应用后端路由默认），整行走继承行；携带形态下 provider 与
 * model 各自判源——行配置给出的一侧写行配置来源，另一侧按实际来源标注
 * （后端默认或父继承，父路由与派生侧同一数据源），两侧来源不同时分写
 * （混合路由），读不到具体值时如实说明，不编造。
 * @param {string} lang - 语言档。
 * @param {object} parts - execute 作用域内的合并产物与输入。
 * @param {object} parts.args - 模型侧参数。
 * @param {object|undefined} parts.mergedOptions - 实际携带的 agentOptions。
 * @param {object|undefined} parts.rowAgentOptions - 行配置 agentOptions。
 * @param {object} parts.provider - 当前后端对象。
 * @param {boolean} parts.requiresPreflight - 携带条件（后端默认只在真时折进）。
 * @param {object} parts.parentOptions - 父代理当前路由值。
 * @param {object} parts.agent - 发起派生的父 Agent。
 * @returns {string} note 的路由行。
 */
function routeReceiptLine(lang, { args, mergedOptions, rowAgentOptions, provider, requiresPreflight, parentOptions, agent }) {
  if (args.provider !== undefined) {
    return t(lang, 'route.requested', { provider: args.provider, model: args.model });
  }
  if (mergedOptions === undefined) {
    return inheritedRouteLine(lang, agent);
  }
  // 携带形态的有效路由：携带值优先，携带缺该侧时宿主按父值补。后端默认只在
  // requiresPreflight（真携带窗口）折入——「未携带＋后端有 agentRouteDefaults＋
  // 父有值」的形态宿主实际继承父值，回执整行走继承行不写后端默认（保守方向：
  // 不为未参与合并的默认值标注来源；推理强度附注同一口径）。
  const effectiveProvider = mergedOptions.provider ?? parentOptions.provider;
  const effectiveModel = mergedOptions.model ?? parentOptions.model;
  const sourceOf = (part) => {
    if (rowAgentOptions?.[part] !== undefined) return 'configured';
    if (requiresPreflight && provider.agentRouteDefaults?.[part] !== undefined) return 'backendDefault';
    return 'inherited';
  };
  const providerSource = sourceOf('provider');
  const modelSource = sourceOf('model');
  if (providerSource === modelSource) {
    // 两侧同源（同来自行配置或同来自后端默认）：整行单源。两侧同为继承的
    // 携带形态（如只携带推理强度）整行走继承行，与父值补齐的语义一致。
    if (providerSource === 'configured') {
      return t(lang, 'route.configured', { provider: effectiveProvider, model: effectiveModel });
    }
    if (providerSource === 'backendDefault') {
      return t(lang, 'route.backendDefault', { provider: effectiveProvider, model: effectiveModel });
    }
    return inheritedRouteLine(lang, agent);
  }
  // 混合路由：provider 与 model 分写来源；读不到具体值的一侧如实说明。
  const partText = (value, source) => (value === undefined
    ? t(lang, 'route.partMissing')
    : `${value}${lang === 'zh' ? '' : ' '}${t(lang, `route.source.${source}`)}`);
  return t(lang, 'route.mixed', {
    providerPart: partText(effectiveProvider, providerSource),
    modelPart: partText(effectiveModel, modelSource)
  });
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
