/**
 * `async_list_subagent_models` 工具：只读路由查询（需求 §2.3.4，设计 §3.7）。
 *
 * ## 职责与边界
 *
 * - 列出或搜索当前会话可见的子代理 LLM 供应商／模型：供应商分页、供应商内
 *   模型分页、跨供应商及供应商内搜索、`provider`＋`model` 准确模型详情；
 * - 适用性判定分两级（设计 §3.7）：目标级三档（允许选择／不允许选择／适用性
 *   未确认）说明目标工具整体是否接受显式路由选择；条目级逐模型标注可选项——
 *   目标级「允许选择」时条目按是否属于已确认允许集合标可选／不可选，其余
 *   两档不标可选性、只报目录事实。`async_agent` 按身份（工具行登记簿
 *   对象同一性）／策略现读／创建行后端注册表确认三段判定；原生工具按
 *   身份／参数／策略三段证据链判定；两条口径的差别（全局名单变化只影响
 *   async_agent、不动原生旧会话策略）由各自依据如实呈现，不合并；
 * - 已确认允许集合中目录未列出的路由按准确 ID 并入供应商浏览、模型列表、
 *   搜索结果与「允许」计数；并入条目只带准确 ID 与来源标记，名称与元数据
 *   不编造；
 * - 目录访问全部委托 `llm` 公开接口（`listProviders`／`listModels`／
 *   `resolveModelInfo`）；不创建代理、不发起模型推理请求、不改配置或路由
 *   （需求 §6.2）；`llm` 缺席按可读失败返回，不伪造空目录。
 *
 * ## 分页、续查与版本令牌（设计 §3.7）
 *
 * 先筛选再分页；同版本内按供应商 ID、模型 ID 字典序稳定排序。`next` 返回
 * 可直接复用的完整续查参数（在场的 provider／query／target_tool 逐项＋
 * page_size＋版本令牌＋下一页 page），正文页脚提示与它同源。版本令牌是对
 * 本次查询全部决定性输入（规范化筛选参数、可见目标身份、影响结果的策略
 * 内容、目录内容与完整性标记）计算的不透明摘要：名单派生条目由已计入
 * 令牌的策略内容决定，不新增令牌输入。翻页回传令牌，`page > 1` 缺令牌
 * 可读拒绝；令牌不匹配说明策略或目录已变化，拒绝拼接并提示重新查询。
 * 页号越过末页返回空页＋总数＋重查出路，不报错也不改读首页。部分供应商
 * 列举失败不记零模型：总数为已取得数、标记不完整并列出失败供应商；正文
 * 空态区分「读取失败（附失败供应商与重试出路）」与「确证空目录／无匹配」。
 *
 * ## 目标识别与证据分级（设计 §3.7）
 *
 * 可识别创建工具按可见工具的模型侧 schema 形状识别：参数表同时具备字符串型
 * `description` 与 `prompt` 者为候选，再排除本包查询与等待工具自身。形状只把
 * 工具列为候选，不证明其身份与策略归属：`async_agent` 与原生工具走各自的
 * 证据链（见 judgeApplicability）。省略目标且仅有一个候选时采用它；多个或
 * 没有时按未确认报告；具名但不可见的目标按「不允许选择」报告限制并照常
 * 返回目录。
 *
 * @module dsh-async-tools/list-models
 */
import { createHash } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LOG_PREFIX } from './config.js';
import { policyOf } from './agent-policy.js';
import { buildToolText } from './descriptions.js';
import { rowConfigOf } from './tool-rows.js';
import { t } from './text.js';

/** 分页默认与边界（需求 §2.3.4）。 */
const DEFAULT_PAGE_SIZE = 20;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 100;

/** 形状识别的显式排除名单（本包等待与查询工具；设计 §3.7 的保守排除）。 */
const SHAPE_EXCLUDE = new Set(['async_list_subagent_models', 'async_wait_job', 'async_wait_agent']);

/**
 * 参数校验与归一（非法值经词典错误可读拒绝；搜索词去空白、纯空白等同未提供）。
 * @param {object} args - 模型侧参数。
 * @param {string} lang - 语言档。
 * @returns {{provider?: string, model?: string, query?: string, targetTool?: string,
 *            page: number, pageSize: number, version?: string}} 归一后的查询输入。
 */
function normalizeQueryArgs(args, lang) {
  if (args.provider !== undefined) {
    if (typeof args.provider !== 'string' || args.provider.length === 0) {
      throw new Error(`${LOG_PREFIX} ${t(lang, 'error.list.providerEmpty')}`);
    }
  }
  if (args.model !== undefined && args.provider === undefined) {
    throw new Error(`${LOG_PREFIX} ${t(lang, 'error.list.modelNeedsProvider')}`);
  }
  if (args.model !== undefined && (typeof args.model !== 'string' || args.model.length === 0)) {
    throw new Error(`${LOG_PREFIX} ${t(lang, 'error.list.modelEmpty')}`);
  }
  const query = typeof args.query === 'string' && args.query.trim() !== '' ? args.query.trim() : undefined;
  // 需求 §2.3.4：准确模型详情与非空搜索词不能同时请求——冲突可读拒绝
  //（provider+query 的供应商内搜索合法，不受影响）。
  if (args.model !== undefined && query !== undefined) {
    throw new Error(`${LOG_PREFIX} ${t(lang, 'error.list.queryDetailConflict')}`);
  }
  if (args.target_tool !== undefined && (typeof args.target_tool !== 'string' || args.target_tool.length === 0)) {
    throw new Error(`${LOG_PREFIX} ${t(lang, 'error.list.targetEmpty')}`);
  }
  let page = 1;
  if (args.page !== undefined) {
    if (typeof args.page !== 'number' || !Number.isInteger(args.page) || args.page < 1) {
      throw new Error(`${LOG_PREFIX} ${t(lang, 'error.list.page')}`);
    }
    page = args.page;
  }
  let pageSize = DEFAULT_PAGE_SIZE;
  if (args.page_size !== undefined) {
    if (typeof args.page_size !== 'number' || !Number.isInteger(args.page_size)
      || args.page_size < MIN_PAGE_SIZE || args.page_size > MAX_PAGE_SIZE) {
      throw new Error(`${LOG_PREFIX} ${t(lang, 'error.list.pageSize')}`);
    }
    pageSize = args.page_size;
  }
  const version = typeof args.version === 'string' && args.version.length > 0 ? args.version : undefined;
  if (page > 1 && version === undefined) {
    throw new Error(`${LOG_PREFIX} ${t(lang, 'error.list.versionRequired', { page })}`);
  }
  return {
    provider: args.provider,
    model: args.model,
    query,
    targetTool: args.target_tool,
    page,
    pageSize,
    version
  };
}

/**
 * 一个可见工具是否「可识别创建工具」：参数表同时具备字符串型 `description` 与
 * `prompt`，且不在排除名单（设计 §3.7 识别判据）。
 * @param {object} schema - `tools.schemas()` 的一条模型侧投影。
 * @returns {boolean}
 */
function isCreationToolShape(schema) {
  if (SHAPE_EXCLUDE.has(schema.name)) return false;
  const properties = schema.parameters?.properties;
  if (properties === undefined || typeof properties !== 'object') return false;
  // 严格判据（设计 §3.7）：两个参数都**声明为字符串型**——只看键存在会把
  // 恰好带同名键的非创建工具误认成创建工具。
  return properties.description?.type === 'string' && properties.prompt?.type === 'string';
}

/**
 * 枚举当前作用域可见的创建工具候选（含本包 `async_agent` 与原生工具及用户
 * 配置名）。目录条目只证明会话存在过，不证明可见性——可见性以工具投影为准。
 * @param {object} ctx - cordis 上下文。
 * @param {object|undefined} scope - 查看作用域（调用 agent；缺省为全局视图）。
 * @returns {Array<{name: string, hasRouteParams: boolean, hasEffortParam: boolean}>} 按名称排序。
 */
function listCreationToolCandidates(ctx, scope) {
  const schemas = ctx.tools.schemas(scope);
  const candidates = [];
  for (const schema of schemas) {
    if (!isCreationToolShape(schema)) continue;
    const properties = schema.parameters?.properties;
    candidates.push({
      name: schema.name,
      // 路由与强度参数按形状直查并要求字符串型（§2.3.4「示例仅含目标实际接受
      // 的字段」）：原生行的 provider/model/reasoning_effort 由其行
      // modelSelectionSettings 控制暴露，形状兼作该配置启用的可见证据；只看
      // 键存在会误认恰好带同名键的非创建工具，也不从路由参数推断强度键。
      hasRouteParams: properties.provider?.type === 'string' && properties.model?.type === 'string',
      hasEffortParam: properties.reasoning_effort?.type === 'string'
    });
  }
  candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return candidates;
}

/**
 * 解析目标创建工具。省略目标时仅有一个候选才采用，多个或没有都不默认为
 * 通用可用（设计 §3.7 保守解析）。具名但不可见不是查询错误：结果按
 * 「不允许选择」报告该限制并照常返回目录（judgeApplicability 的
 * targetNotVisible 档），不生成适用于该目标的创建调用。
 * @param {object} ctx - cordis 上下文。
 * @param {object|undefined} scope - 查看作用域。
 * @param {string|undefined} named - `target_tool` 参数。
 * @returns {{name: string|undefined, resolved: boolean, namedMissing?: boolean,
 *   candidates: Array<object>}}
 */
function resolveTarget(ctx, scope, named) {
  const candidates = listCreationToolCandidates(ctx, scope);
  if (named !== undefined) {
    const hit = candidates.find((candidate) => candidate.name === named);
    if (hit === undefined) {
      return { name: named, resolved: false, namedMissing: true, candidates };
    }
    return { name: named, resolved: true, candidates };
  }
  if (candidates.length === 1) {
    return { name: candidates[0].name, resolved: true, candidates };
  }
  return { name: undefined, resolved: false, candidates };
}

/**
 * 投影路由表归一为准确字符串对（身份与策略两段共用）。
 * @param {Array<{provider: unknown, model: unknown}>} routes - 投影读出的路由表。
 * @returns {Array<{provider: string, model: string}>}
 */
function normalizeRoutes(routes) {
  return routes.map((route) => ({ provider: String(route.provider), model: String(route.model) }));
}

/**
 * 判别详情解析失败是否携带「模型不受支持」的稳定 code（设计 §3.7 两档定性
 * 的「不支持」档）：`UNKNOWN_MODEL`（解析路径现有实例＝pi-ai 适配器对未配置
 * 模型的报告）与 `UNSUPPORTED_` 前缀的后续同类 code；沿 cause 链有界下探
 * （远程/包装错误可能把原始错误挂在 cause 上）。code 是宿主错误类的稳定
 * 路由通道（HarnessError 契约：按 code 路由、不解析 message），此处同判。
 * @param {unknown} error - `resolveModelInfo` 抛出的错误。
 * @returns {boolean} 命中不支持类 code 时为 true。
 */
function unsupportedModelCode(error) {
  let current = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const code = current.code;
    if (code === 'UNKNOWN_MODEL' || (typeof code === 'string' && code.startsWith('UNSUPPORTED_'))) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * 目标适用性判断（需求 §2.3.4，设计 §3.7）——目标级三档，证据分级按目标
 * 类型走两条链：
 *
 * - `async_agent` 三段（设计 §3.7）：**身份段**经公开工具投影 `tools.get`
 *   取该名可见定义，与工具行登记簿按对象同一性比对——查无该行记录（同名
 *   外来登记、被遮蔽或不在同一模块实例）→未确认，不读策略与后端、不生成
 *   示例；`get` 缺席／抛错／与候选枚举矛盾→未确认；**策略段**现读
 *   `subagentModelSelection`（缺席／读取失败不可证→未确认；关闭是已确认
 *   限制→不允许）；**后端段**按**创建行**配置视图现读的 `subagentProvider`
 *   经 `subagents.getProvider` 查注册表——未注册、不声明
 *   `capabilities.agentOptions` 或缺 `prepareContinuable` 可续支持是已确认
 *   限制（显式路由选择在执行期同样会被拒绝，与设计 §3.3 的派生前可读拒绝
 *   同判）→不允许；注册表读取抛错→未确认。三段齐备才有「允许选择」。
 * - 原生工具三段：**参数段**可见形状含字符串型 provider/model（不含→不允许，
 *   该会话不暴露路由选择）；**身份段**双依据——①所在会话的
 *   `subagentModelSelectionPolicy` 投影在场（仅原生插件注册写入⇒原生插件
 *   在该会话组合活跃）＋②调用方作用域组稿中 `tool:<目标名>` 段非空（宿主
 *   对象同一性渲染：可见定义恰是原生注册的那个才带文本；自定义名同样
 *   按双依据判别，不因名称获默认确认，也不用形状＋投影冒充确认）；
 *   **策略段**同一投影读取成功且状态非空（读取抛错→未确认；为空→不允许，
 *   该会话未启用原生模型选择）。三段齐备才有「允许选择」，逐路由按投影
 *   路由表判定。身份依据②经 `systemPrompt.assemble` 按调用方作用域现读，
 *   每次判定至多一次、不跨调用缓存；服务缺席或组稿抛错按读取失败→未确认。
 *
 * 双向策略差异如实区分：dsh 原生旧会话策略不是实时配置，全局名单新增／撤销
 * 与旧会话投影允许集互不冒充。
 *
 * 返回值附两份机器可判读的策略实质（设计 §3.7：版本令牌与「允许模型数」
 * 都要消费**影响结果的策略内容**，仅判类别键不够）：
 * - `policyContent`：进入版本令牌的决定性输入（名单条目、开关、失败标记——
 *   名单 [A,B]→[A,C] 这类同条数替换也必须变版本）。后端名不进令牌：后端
 *   换名而能力不变时结果内容不变，令牌不应失效；
 * - `routes`：verdict=allowed 时的已确认允许集合（async=现读名单；原生=
 *   投影路由表），条目级可选项、未列路由并入与「允许」计数都由它派生；
 *   其余形态为 undefined。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object|undefined} scope - 查看作用域。
 * @param {object} target - `resolveTarget` 的结果。
 * @param {string} lang - 语言档。
 * @returns {Promise<{target: string, verdict: 'allowed'|'not-allowed'|'unconfirmed', basis: string,
 *   basisKey: string, policyContent: object, routes: Array<{provider: string, model: string}>|undefined}>}
 */
async function judgeApplicability(ctx, scope, target, lang) {
  if (target.namedMissing === true) {
    // 具名但不可见：已确认的限制（该名称不在本作用域的创建工具候选中），
    // 不是查询错误——目录照常返回，不生成适用于该目标的创建调用。
    const names = target.candidates.map((candidate) => candidate.name).join(', ') || '(none)';
    return {
      target: target.name,
      verdict: 'not-allowed',
      basis: t(lang, 'list.basis.targetNotVisible', { tool: target.name, candidates: names }),
      basisKey: 'targetNotVisible',
      policyContent: { namedMissing: target.name, candidates: target.candidates.map((candidate) => candidate.name).sort() }
    };
  }
  if (!target.resolved) {
    const names = target.candidates.map((candidate) => candidate.name).join(', ');
    const basisKey = target.candidates.length === 0 ? 'list.basis.noneCandidates' : 'list.basis.multiCandidates';
    return {
      target: '(unresolved)',
      verdict: 'unconfirmed',
      basis: t(lang, basisKey, { candidates: names }),
      basisKey,
      policyContent: { candidates: target.candidates.map((candidate) => candidate.name).sort() }
    };
  }
  if (target.name === 'async_agent') {
    // 身份段（设计 §3.7）：目标名只作候选筛选，不作身份证明。经公开工具
    // 投影取调用方作用域该名可见的定义，与工具行登记簿（lib/tool-rows.js，
    // 入口在每行注册成功后登记）按对象同一性比对；未命中＝同名外来登记或
    // 被遮蔽（含原生行以 toolName 配置注册的形态）或查询行与创建行不在
    // 同一模块实例——统一按未确认报告，不读策略与后端、不生成示例，也
    // 不用本包默认配置冒充该工具。
    if (typeof ctx.tools?.get !== 'function') {
      return {
        target: target.name,
        verdict: 'unconfirmed',
        basis: t(lang, 'list.basis.asyncIdentityUnreadable', { reason: t(lang, 'list.reason.toolsGetUnavailable') }),
        basisKey: 'asyncIdentityUnreadable',
        policyContent: { identityUnreadable: 'toolsGetUnavailable' }
      };
    }
    let visible;
    try {
      visible = ctx.tools.get(target.name, scope);
    } catch (error) {
      return {
        target: target.name,
        verdict: 'unconfirmed',
        basis: t(lang, 'list.basis.asyncIdentityUnreadable', { reason: String(error?.message ?? error) }),
        basisKey: 'asyncIdentityUnreadable',
        policyContent: { identityReadFailed: String(error?.message ?? error) }
      };
    }
    if (visible === undefined) {
      // 候选枚举（schemas）在册而 get 查无——公开投影两读口矛盾，按读取
      // 失败处理，不猜测哪一侧为准。
      return {
        target: target.name,
        verdict: 'unconfirmed',
        basis: t(lang, 'list.basis.asyncIdentityUnreadable', { reason: t(lang, 'list.reason.schemasGetMismatch') }),
        basisKey: 'asyncIdentityUnreadable',
        policyContent: { identityReadFailed: 'schemas-visible-but-get-none' }
      };
    }
    const rowConfig = rowConfigOf(visible);
    if (rowConfig === undefined) {
      return {
        target: target.name,
        verdict: 'unconfirmed',
        basis: t(lang, 'list.basis.asyncForeignName'),
        basisKey: 'asyncForeignName',
        policyContent: { foreignRegistration: target.name }
      };
    }
    // 策略段：现读 dsh 模型选择设置（与创建侧同一全局来源，需求 §2.3.2）。
    const settings = ctx.get('subagentModelSelection');
    if (settings === undefined) {
      return {
        target: target.name, verdict: 'unconfirmed',
        basis: t(lang, 'list.basis.asyncNoService'), basisKey: 'asyncNoService',
        policyContent: { serviceAbsent: true }
      };
    }
    let current;
    try {
      current = settings.current();
    } catch (error) {
      return {
        target: target.name,
        verdict: 'unconfirmed',
        basis: t(lang, 'list.basis.asyncReadFailed', { reason: String(error?.message ?? error) }),
        basisKey: 'asyncReadFailed',
        policyContent: { readFailed: String(error?.message ?? error) }
      };
    }
    const allowedModels = Array.isArray(current.allowedModels)
      ? current.allowedModels.map((route) => ({ provider: String(route.provider), model: String(route.model) }))
      : [];
    if (current.enabled !== true) {
      return {
        target: target.name,
        verdict: 'not-allowed',
        basis: t(lang, 'list.basis.asyncDisabled'),
        basisKey: 'asyncDisabled',
        // disabled 时名单同样是决定性输入（开回后名单即生效口径）。
        policyContent: { enabled: false, allowedModels }
      };
    }
    // 后端段：注册表确认（设计 §3.7——与 §3.3 派生前可读拒绝同判）。取值
    // 来源是身份段取出的**创建行**配置视图（§3.2 允许查询与创建分别挂载、
    // 行配置各异）：查询与创建对同一稳定组合不得给出「查询允许、创建拒绝」
    // 的矛盾判定，后端现状按创建行核对，不用查询行自己的配置冒充。
    if (typeof ctx.subagents?.getProvider !== 'function') {
      return {
        target: target.name,
        verdict: 'unconfirmed',
        basis: t(lang, 'list.basis.asyncNoRegistry'), basisKey: 'asyncNoRegistry',
        policyContent: { enabled: true, allowedModels, registryAbsent: true }
      };
    }
    const providerName = rowConfig.subagentProvider;
    let provider;
    try {
      provider = ctx.subagents.getProvider(providerName);
    } catch (error) {
      return {
        target: target.name,
        verdict: 'unconfirmed',
        basis: t(lang, 'list.basis.asyncBackendFailed', { reason: String(error?.message ?? error) }),
        basisKey: 'asyncBackendFailed',
        policyContent: { enabled: true, allowedModels, registryReadFailed: String(error?.message ?? error) }
      };
    }
    if (provider === undefined) {
      return {
        target: target.name,
        verdict: 'not-allowed',
        basis: t(lang, 'list.basis.asyncBackendMissing', { provider: providerName }),
        basisKey: 'asyncBackendMissing',
        policyContent: { enabled: true, allowedModels, backendMissing: providerName }
      };
    }
    if (provider.capabilities?.agentOptions !== true) {
      return {
        target: target.name,
        verdict: 'not-allowed',
        basis: t(lang, 'list.basis.asyncBackendNoOptions', { provider: providerName }),
        basisKey: 'asyncBackendNoOptions',
        policyContent: { enabled: true, allowedModels, backendNoAgentOptions: providerName }
      };
    }
    // 可续核对（设计 §3.7——查询与创建同一组后端前置条件）：创建侧派生前
    // 要求 prepareContinuable（§3.3），查询侧同判——否则同配置会出现
    // 「查询允许、创建拒绝」的矛盾组合。
    if (typeof provider.prepareContinuable !== 'function') {
      return {
        target: target.name,
        verdict: 'not-allowed',
        basis: t(lang, 'list.basis.asyncBackendNotContinuable', { provider: providerName }),
        basisKey: 'asyncBackendNotContinuable',
        policyContent: { enabled: true, allowedModels, backendNotContinuable: providerName }
      };
    }
    // 创建行默认预设的后端条件（创建侧步 8 同判据：宿主 SubagentPresetSelection
    // .assertProvider——capabilities.agentPreset 且非 inheritsParentContext）。
    // 创建行配置了 agentPreset 默认而后端不支持独立预设时，创建在派生前按
    // presetNoBackend 可读拒绝、零派生（§3.3）——查询侧同判，避免
    // 「查询允许并生成示例、创建拒绝」的矛盾组合。
    if (rowConfig.agentPreset !== undefined
      && (provider.capabilities?.agentPreset !== true || provider.inheritsParentContext === true)) {
      return {
        target: target.name,
        verdict: 'not-allowed',
        basis: t(lang, 'list.basis.asyncBackendNoPreset', { provider: providerName }),
        basisKey: 'asyncBackendNoPreset',
        policyContent: {
          enabled: true, allowedModels,
          backendNoAgentPreset: providerName, rowDefaultPreset: rowConfig.agentPreset
        }
      };
    }
    return {
      target: target.name,
      verdict: 'allowed',
      basis: t(lang, 'list.basis.asyncCurrent', { count: allowedModels.length }),
      basisKey: 'asyncCurrent',
      policyContent: { enabled: true, allowedModels },
      routes: allowedModels
    };
  }
  // 原生创建工具：三段证据链（参数→身份→策略，设计 §3.7）。目标名与形状
  // 只作候选筛选（resolveTarget），不作注册来源证明——工具定义对象不携带
  // 来源标记，公开工具投影只返回定义本身，作用域内自有层登记可遮蔽继承层
  // 同名工具，原生工具名本身又可由行 toolName 配置，名称与形状都无法证明
  // 目标由原生插件提供；身份与归属的证明落在下面的双依据上。
  const candidate = target.candidates.find((item) => item.name === target.name);
  // 参数段：可见形状不含路由键是已确认限制。
  if (candidate?.hasRouteParams !== true) {
    return {
      target: target.name, verdict: 'not-allowed',
      basis: t(lang, 'list.basis.noRouteParams'), basisKey: 'noRouteParams',
      policyContent: { routeParamsVisible: false }
    };
  }
  // 身份依据①兼策略段载体：所在会话的原生模型选择投影。该投影仅由原生插件
  // 注册写入——在场即证明原生插件在该会话组合中活跃；状态为空说明该会话
  // 未启用原生模型选择（无论可见定义是谁，显式路由都不被接受），按已确认
  // 限制报「不允许选择」；读取抛错按未确认给原因。
  if (scope === undefined) {
    return {
      target: target.name,
      verdict: 'unconfirmed',
      basis: t(lang, 'list.basis.nativeNoAgent'),
      basisKey: 'nativeNoAgent',
      policyContent: { noCallingAgent: true }
    };
  }
  let routes;
  try {
    routes = policyOf(ctx.sessionProjections, scope.session);
  } catch (error) {
    return {
      target: target.name,
      verdict: 'unconfirmed',
      basis: t(lang, 'list.basis.nativeProjectionFailed', { reason: String(error?.message ?? error) }),
      basisKey: 'nativeProjectionFailed',
      policyContent: { projectionReadFailed: String(error?.message ?? error) }
    };
  }
  if (routes === undefined) {
    return {
      target: target.name, verdict: 'not-allowed',
      basis: t(lang, 'list.basis.nativeNoProjection'), basisKey: 'nativeNoProjection',
      policyContent: { noProjection: true }
    };
  }
  // 身份依据②：调用方作用域组稿中的 `tool:<目标名>` 段非空。原生插件按对象
  // 同一性渲染该段（宿主惯用判别 `tools.get(tool.name, scope) === tool`——
  // 该原生插件的定义恰为该作用域该名可见的那个才带文本），段缺失或为空
  // 即说明可见定义不是原生注册的那个（未装载、行配置了别名或被同名登记
  // 遮蔽）。经 `systemPrompt.assemble` 按调用方作用域现读——公开接口无单段
  // 按作用域读取的通道，整稿组稿是唯一公开读法；每次目标判定至多一次、不
  // 跨调用缓存。服务缺席或组稿抛错按读取失败⇒未确认＋原因。
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt === undefined) {
    return {
      target: target.name,
      verdict: 'unconfirmed',
      basis: t(lang, 'list.basis.nativeAssembleFailed', { reason: t(lang, 'list.reason.systemPromptUnavailable') }),
      basisKey: 'nativeAssembleFailed',
      policyContent: { routes: normalizeRoutes(routes), assembleFailed: 'systemPromptUnavailable' }
    };
  }
  let sections;
  try {
    const assembly = await systemPrompt.assemble({ agent: scope, scope });
    sections = assembly?.sections;
  } catch (error) {
    return {
      target: target.name,
      verdict: 'unconfirmed',
      basis: t(lang, 'list.basis.nativeAssembleFailed', { reason: String(error?.message ?? error) }),
      basisKey: 'nativeAssembleFailed',
      policyContent: { routes: normalizeRoutes(routes), assembleFailed: String(error?.message ?? error) }
    };
  }
  const section = Array.isArray(sections)
    ? sections.find((item) => item?.name === `tool:${target.name}`)
    : undefined;
  const sectionText = typeof section?.text === 'string' ? section.text : '';
  if (section === undefined || sectionText.trim() === '') {
    return {
      target: target.name,
      verdict: 'unconfirmed',
      basis: t(lang, 'list.basis.nativeSectionEmpty'),
      basisKey: 'nativeSectionEmpty',
      policyContent: { routes: normalizeRoutes(routes), identitySectionEmpty: target.name }
    };
  }
  // 双依据齐备（①投影在场＋②组稿段非空）⇒ 身份成立；策略段按投影路由表
  // 逐路由判定，三段齐备才有「允许选择」。
  const normalized = normalizeRoutes(routes);
  return {
    target: target.name,
    verdict: 'allowed',
    basis: t(lang, 'list.basis.nativeProjection', { count: normalized.length }),
    basisKey: 'nativeProjection',
    policyContent: { routes: normalized },
    routes: normalized
  };
}

/**
 * 生成一个模型条目的创建参数示例（设计 §3.7）：仅当目标级「允许选择」且示例
 * 所用路由属于已确认允许集合时生成——路由可选由调用方判定后传入；示例只含
 * 目标实际接受的字段——`provider`／`model` 仅在该名可见参数表声明时进入
 * 示例，`reasoning_effort` 同判，不以 `async_agent` 名称特权绕过形状核对
 * （§2.3.4「示例仅含目标实际接受的字段」）；搜索词、分页参数、目标参数和
 * 本包专有字段不混入；推理强度仅在目标参数含 `reasoning_effort` 且已确认
 * 该模型支持时提供。占位串经词典双语（§5.3）。
 * @param {object} target - 解析后的目标。
 * @param {object} applicability - 适用性判断结果。
 * @param {{provider: string, id: string}} route - 条目对应的路由。
 * @param {Array<{id: string}>|undefined} efforts - 已确认的推理强度（详情模式）。
 * @param {string} lang - 语言档。
 * @returns {object|undefined} 示例参数对象；无已确认目标依据时不生成。
 */
function exampleArguments(target, applicability, route, efforts, lang) {
  if (!target.resolved || applicability.verdict !== 'allowed') return undefined;
  const candidate = target.candidates.find((item) => item.name === target.name);
  const example = { description: t(lang, 'param.list.exampleDescription'), prompt: t(lang, 'param.list.examplePrompt') };
  // 字段集以目标可见 schema 形状为准（hasRouteParams／hasEffortParam——
  // resolveTarget 的候选直查）：形状不含的键不进示例，无论目标名是什么。
  if (candidate?.hasRouteParams === true) {
    example.provider = route.provider;
    example.model = route.id;
  }
  const effortIds = efforts === undefined ? [] : efforts.map((effort) => effort.id);
  if (candidate?.hasEffortParam === true && effortIds.length > 0) {
    example.reasoning_effort = t(lang, 'param.list.exampleEffort', { efforts: effortIds.join(', ') });
  }
  return example;
}

/**
 * 已确认允许集合按供应商分组（未列路由并入、「允许」计数与条目级可选项的
 * 共同上游）。
 * @param {Array<{provider: string, model: string}>} routes - 已确认允许集合。
 * @returns {Map<string, Set<string>>} 供应商 ID → 模型 ID 集合。
 */
function routesByProvider(routes) {
  const map = new Map();
  for (const route of routes) {
    const set = map.get(route.provider) ?? new Set();
    set.add(route.model);
    map.set(route.provider, set);
  }
  return map;
}

/**
 * 允许名单派生的模型条目：只带准确 ID 与来源标记——目录未列出时没有名称与
 * 元数据可写，不编造（设计 §3.7）。
 * @param {string} providerId - 供应商准确 ID。
 * @param {Set<string>} routeIds - 该供应商的名单模型 ID。
 * @returns {Array<{kind: 'model', provider: string, id: string, source: 'allowed-list'}>}
 */
function allowedListEntries(providerId, routeIds) {
  return [...routeIds].map((modelId) => ({ kind: 'model', provider: providerId, id: modelId, source: 'allowed-list' }));
}

/**
 * 名单路由减去目录已列 ID——并入只补目录未列出的，不与目录条目重复。
 * @param {Set<string>} routeIds - 名单模型 ID。
 * @param {Array<{id: string}>} models - 目录已列模型。
 * @returns {Set<string>} 目录未列出的名单模型 ID。
 */
function minusListed(routeIds, models) {
  const listed = new Set(models.map((model) => model.id));
  return new Set([...routeIds].filter((id) => !listed.has(id)));
}

/**
 * 读目录并按模式组装条目（先并入允许名单派生条目、再筛选，后由调用方分页；
 * 部分供应商失败不记零模型——已确认允许集合中的路由不因目录列举失败而
 * 丢失）。
 * @param {object} llm - `llm` 服务。
 * @param {object} q - 归一后的查询输入。
 * @param {Array<{provider: string, model: string}>|undefined} allowed - 已确认
 *   允许集合；目标级非「允许选择」时为 undefined，不并入任何条目。
 * @returns {Promise<{mode: string, entries: Array<object>, failed: string[]}>}
 */
async function readCatalog(llm, q, allowed) {
  const failed = [];
  const allowedMap = allowed === undefined ? undefined : routesByProvider(allowed);
  if (q.provider !== undefined && q.model !== undefined) {
    // 详情模式：resolveModelInfo 独立于目录咨询表，失败原样可读上抛。
    const info = await llm.resolveModelInfo(q.provider, q.model);
    return { mode: 'model-detail', entries: [info], failed };
  }
  let providers;
  try {
    providers = llm.listProviders();
  } catch (error) {
    const failure = new Error(String(error?.message ?? error));
    failure.catalogFailure = true;
    throw failure;
  }
  if (q.provider === undefined && q.query === undefined) {
    // 供应商浏览：逐供应商数模型（需求 §2.3.4「对应模型数量」——确认目标策略后
    // 标允许模型数，未确认标目录已知数）。readCatalog 先带目录侧计数与内部清单
    // （catalog_model_ids），execute 按适用性判定定稿 model_count/count_kind 后
    // 再把内部清单从回显里删掉；列举失败的供应商如实标 unknown（不冒充零）。
    // 只出现在允许名单、目录完全未列的供应商同样成条目（仅准确 ID）。
    const entries = [];
    const inCatalog = new Set(providers.map((provider) => provider.id));
    for (const provider of providers) {
      let models;
      try {
        models = await llm.listModels(provider.id);
      } catch {
        failed.push(provider.id);
        entries.push({ kind: 'provider', ...provider, model_count: null, count_kind: 'unknown' });
        continue;
      }
      entries.push({
        kind: 'provider', ...provider,
        model_count: models.length, count_kind: 'catalog',
        catalog_model_ids: models.map((model) => model.id)
      });
    }
    if (allowedMap !== undefined) {
      for (const [providerId, routeIds] of allowedMap) {
        if (inCatalog.has(providerId)) continue;
        entries.push({
          kind: 'provider', id: providerId, source: 'allowed-list',
          model_count: routeIds.size, count_kind: 'catalog'
        });
      }
    }
    return { mode: 'providers', entries, failed };
  }
  if (q.provider === undefined) {
    // 跨供应商搜索：供应商按 id／名称命中列为供应商条目，其模型**整组随行**
    // （供应商命中＝浏览该供应商）；未命中的供应商只列命中搜索词的模型；
    // 名单派生路由先并入候选集、再按同一规则匹配（无显示名称，仅模型 ID 与
    // 供应商命中参与）；同名条目不合并（不同供应商的同名模型分列）。
    const needle = q.query.toLowerCase();
    const entries = [];
    const inCatalog = new Set(providers.map((provider) => provider.id));
    for (const provider of providers) {
      const providerMatched = provider.id.toLowerCase().includes(needle)
        || provider.name.toLowerCase().includes(needle);
      if (providerMatched) {
        entries.push({ kind: 'provider', ...provider });
      }
      let models;
      try {
        models = await llm.listModels(provider.id);
      } catch {
        failed.push(provider.id);
        models = [];
      }
      const listed = models.map((model) => ({
        kind: 'model', provider: provider.id, id: model.id, name: model.name,
        ...(model.description === undefined ? {} : { description: model.description })
      }));
      const routeIds = allowedMap?.get(provider.id);
      const merged = routeIds === undefined ? [] : allowedListEntries(provider.id, minusListed(routeIds, models));
      for (const entry of [...listed, ...merged]) {
        if (providerMatched
          || entry.id.toLowerCase().includes(needle)
          || (entry.name !== undefined && entry.name.toLowerCase().includes(needle))) {
          entries.push(entry);
        }
      }
    }
    if (allowedMap !== undefined) {
      for (const [providerId, routeIds] of allowedMap) {
        if (inCatalog.has(providerId)) continue;
        const providerMatched = providerId.toLowerCase().includes(needle);
        if (providerMatched) {
          entries.push({ kind: 'provider', id: providerId, source: 'allowed-list' });
        }
        for (const entry of allowedListEntries(providerId, routeIds)) {
          if (providerMatched || entry.id.toLowerCase().includes(needle)) {
            entries.push(entry);
          }
        }
      }
    }
    return { mode: 'search', entries, failed };
  }
  // 供应商内：浏览或搜索其模型；供应商不在目录中时如实说明（不冒充零模型），
  // 已确认允许集合中该供应商的路由仍按准确 ID 列出。
  const catalogHit = providers.some((provider) => provider.id === q.provider);
  const routeIds = allowedMap?.get(q.provider);
  if (!catalogHit) {
    // 名单派生条目并入候选集后按同一 `query` 规则匹配（设计 §3.7 统一流水线：
    // 允许名单派生条目过同一过滤，无匹配返回空结果页——不因来源不同豁免搜索词）。
    let entries = routeIds === undefined ? [] : allowedListEntries(q.provider, routeIds);
    if (q.query !== undefined) {
      // 未列供应商没有显示名称，命中只按其准确 ID 判定（设计 §3.7 统一包含
      // 匹配）；命中时其全部允许名单路由整组随行。
      const needle = q.query.toLowerCase();
      if (!q.provider.toLowerCase().includes(needle)) {
        entries = entries.filter((entry) => entry.id.toLowerCase().includes(needle));
      }
    }
    return {
      mode: 'models', entries, failed, unlisted: q.provider,
      // 内部标记：该未列供应商有允许名单路由（execute 据此带上
      // unlisted_had_routes，渲染区分「确无已列模型」与「有路由但无匹配」）。
      ...(routeIds !== undefined && routeIds.size > 0 ? { unlistedRoutes: true } : {})
    };
  }
  let models;
  try {
    models = await llm.listModels(q.provider);
  } catch {
    failed.push(q.provider);
    models = [];
  }
  const listed = models.map((model) => ({
    kind: 'model', provider: q.provider, id: model.id, name: model.name,
    ...(model.description === undefined ? {} : { description: model.description })
  }));
  // description 缺席时不写键：undefined 值过不了宿主 lossless JSON 快照。
  const merged = routeIds === undefined ? [] : allowedListEntries(q.provider, minusListed(routeIds, models));
  let entries = [...listed, ...merged];
  if (q.query !== undefined) {
    // 统一包含匹配（设计 §3.7）：供应商命中＝其 ID 或显示名称包含搜索词，
    // 该供应商的模型条目整组随行——与跨供应商搜索同语义，指定 provider
    // 不取消供应商字段匹配；未命中时按模型 ID／显示名称逐条过滤（并入的
    // 名单派生条目无名称，按模型 ID 匹配）。
    const needle = q.query.toLowerCase();
    const providerMeta = providers.find((provider) => provider.id === q.provider);
    const providerMatched = providerMeta !== undefined
      && (providerMeta.id.toLowerCase().includes(needle)
        || providerMeta.name.toLowerCase().includes(needle));
    if (!providerMatched) {
      entries = entries.filter((entry) => entry.id.toLowerCase().includes(needle)
        || (entry.name !== undefined && entry.name.toLowerCase().includes(needle)));
    }
  }
  return { mode: 'models', entries, failed };
}

/**
 * 稳定排序：供应商 ID、类别（供应商条目先于其模型条目）、模型 ID 字典序
 * （设计 §3.7——同版本内不重复不漏项的前提）。
 * @param {Array<object>} entries - 待排序条目。
 * @returns {Array<object>} 排序后的新数组。
 */
function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const providerA = a.provider ?? a.id;
    const providerB = b.provider ?? b.id;
    if (providerA !== providerB) return providerA < providerB ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === 'provider' ? -1 : 1;
    const idA = a.id ?? '';
    const idB = b.id ?? '';
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });
}

/**
 * 版本令牌：对本次查询全部决定性输入计算不透明摘要（设计 §3.7）——规范化
 * 筛选参数、可见目标身份、影响结果的策略**内容**（现读设置的开关与名单条目、
 * 会话投影的路由表，或失败标记——名单 [A,B]→[A,C] 的同条数替换也必须变版本，
 * 仅记判断类别键不够）与目录内容（含**全部影响返回内容的条目字段**：显示名称
 * 与条目说明——名称变化影响搜索命中，说明变化改变第 2 页起的新页内容，仅说明
 * 变化也必须使旧令牌失效）及完整性标记。名单派生条目由已计入令牌的策略内容
 * 决定，不新增令牌输入。口径边界：详情模式（model-detail）单条返回、不产
 * 续页指针，每次响应都是对模型信息的全新读取，不存在新旧页拼接通道——
 * 只在详情渲染出现的 efforts／default_effort 因此不进页内容元组（它们
 * 不出现在任何可续页模式的条目构造里）。
 * @param {object} q - 归一后的查询输入。
 * @param {object} target - 目标解析结果。
 * @param {object} applicability - 适用性判断（policyContent 参与令牌）。
 * @param {Array<object>} entries - 排序后的全部条目。
 * @param {string[]} failed - 列举失败的供应商。
 * @returns {string} 12 位十六进制摘要。
 */
function versionToken(q, target, applicability, entries, failed) {
  const digest = createHash('sha256');
  const payload = {
    // 摘要载荷自带版本号，随输入集变化递增：升级使旧令牌失效属预期行为，
    // 续页一律按既有 versionStale 出口拒拼并指引重查（设计 §3.7）。号位由
    // 本包按输入集结构的演进自行递增，不是宿主协议字段。
    v: 3,
    inputs: {
      provider: q.provider ?? null,
      model: q.model ?? null,
      query: q.query ?? null,
      target_tool: q.targetTool ?? null,
      page_size: q.pageSize
    },
    targets: target.candidates.map((candidate) => `${candidate.name}:${candidate.hasRouteParams ? 1 : 0}`),
    resolvedTarget: target.resolved ? target.name : null,
    policy: {
      key: applicability.basisKey,
      content: applicability.policyContent ?? null
    },
    // providers 模式的页内容含每供应商计数与口径（需求 §2.3.4）——目录或策略
    // 变化引起的计数变化同样要变版本，不把新旧口径的页拼在一起；目录侧的
    // 模型 ID 清单也进令牌（它是允许模型数与搜索命中的共同上游）。条目说明
    // 与名称同属返回内容字段，一并计入元组；详情模式独有字段不进元组的
    // 口径见函数头（无续页指针，响应即全新读取）。
    catalog: entries.map((entry) => [
      entry.kind, entry.provider ?? entry.id, entry.id ?? '', entry.name ?? '',
      entry.description ?? null,
      entry.count_kind ?? '', entry.model_count ?? null, entry.catalog_model_ids ?? null
    ]),
    failed: [...failed].sort()
  };
  digest.update(JSON.stringify(payload));
  return digest.digest('hex').slice(0, 12);
}

/**
 * 渲染查询结果为双语可见文本（render 是模型唯一可见出口；所需输入全部来自
 * 输出对象本身——筛选条件回显字段 provider/query 与输出同形，页脚续查提示
 * 由结构化 next 字段现场序列化，两处同源）。
 * @param {string} lang - 语言档。
 * @param {object} result - 输出对象（与 output.schema 同形）。
 * @returns {string}
 */
function renderListResult(lang, result) {
  const lines = [];
  const partialNote = result.complete === true
    ? ''
    : t(lang, 'render.list.partialNote', { failed: (result.failed_providers ?? []).length });
  if (result.mode === 'model-detail') {
    const info = result.entries[0];
    lines.push(t(lang, 'render.list.detailHeader', { provider: info.provider, model: info.id }));
    // name 缺席时回落到 id（宿主 normalizeModelInfo 契约上保证非空 name，这里
    // 只是渲染侧的回退——缺席时显示字面 "undefined" 或空段都不如实）。
    lines.push(t(lang, 'render.list.modelLine', { provider: info.provider, model: info.id, name: info.name ?? info.id })
      + (info.description === undefined ? '' : ` — ${info.description}`));
    lines.push(t(lang, 'render.list.effortsHeader'));
    if (info.efforts === undefined || info.efforts.length === 0) {
      lines.push(t(lang, 'render.list.noEfforts'));
    } else {
      for (const effort of info.efforts) {
        lines.push(t(lang, 'render.list.effortLine', {
          id: effort.id,
          name: effort.name,
          defaultMark: info.default_effort === effort.id ? t(lang, 'render.list.defaultEffort') : ''
        }));
      }
    }
  } else {
    const headerKey = result.mode === 'providers'
      ? 'render.list.providersHeader'
      : result.mode === 'models'
        ? 'render.list.modelsHeader'
        : 'render.list.searchHeader';
    const headerVars = {
      page: result.page, total: result.total, partialNote,
      ...(result.mode === 'models' ? { provider: result.provider } : {}),
      ...(result.mode === 'search' ? { query: result.query ?? '' } : {})
    };
    lines.push(t(lang, headerKey, headerVars));
    if (result.beyond_end === true) {
      lines.push(t(lang, 'render.list.beyondEnd', { page: result.page, lastPage: Math.max(1, Math.ceil(result.total / result.page_size)), total: result.total }));
    } else {
      // 未列供应商的来源说明是**前置说明**（设计 §3.7）：不与本页条目渲染
      // 互斥——说明行之下照常逐条渲染本页条目（准确 ID、来源与可选性标记）；
      // 条目为零时才渲染空态，且未列供应商的空态由专属说明承担——有允许
      // 名单路由而搜索无匹配用 NoMatch（路由仍在，换搜索词可取），确无路由
      // 用「不在目录且无已列模型」，不叠加通用空目录文案。
      if (result.unlisted_provider !== undefined && result.entries.length > 0) {
        lines.push(t(lang, 'render.list.unlistedProviderAllowed', { provider: result.unlisted_provider, query: result.query ?? '' }));
      }
      if (result.entries.length === 0) {
        if (result.unlisted_provider !== undefined) {
          const unlistedKey = result.query !== undefined && result.unlisted_had_routes === true
            ? 'render.list.unlistedProviderNoMatch'
            : 'render.list.unlistedProvider';
          lines.push(t(lang, unlistedKey, { provider: result.unlisted_provider, query: result.query ?? '' }));
        } else if (result.complete === false) {
          // 空态区分（设计 §3.7）：失败供应商在册＝读取失败口径（附失败者与重试
          // 出路），不写空目录断言、不把失败折算为零模型；列举成功且零命中才是
          // 确证的空目录／无匹配。
          lines.push(t(lang, 'render.list.readFailed', { failed: (result.failed_providers ?? []).join(', ') }));
        } else {
          const emptyKey = result.query !== undefined
            ? 'render.list.noMatches'
            : result.mode === 'providers' ? 'render.list.emptyProviders' : 'render.list.emptyModels';
          lines.push(t(lang, emptyKey, { provider: result.provider, query: result.query ?? '' }));
        }
      } else {
        for (const entry of result.entries) {
          if (entry.kind === 'provider') {
            // 数量段只在 providers 浏览模式出现（搜索模式的供应商条目不带计数）。
            const countKey = entry.count_kind === 'allowed'
              ? 'render.list.countAllowed'
              : entry.count_kind === 'catalog' ? 'render.list.countCatalog' : 'render.list.countUnknown';
            const countNote = entry.count_kind === undefined
              ? ''
              : lang === 'zh'
                ? `（${t(lang, countKey, { count: entry.model_count ?? 0 })}）`
                : ` (${t(lang, countKey, { count: entry.model_count ?? 0 })})`;
            const base = entry.name === undefined
              ? entry.id
              : t(lang, 'render.list.providerLine', { provider: entry.id, name: entry.name });
            const mark = entry.source === 'allowed-list' ? t(lang, 'render.list.allowedListMark') : '';
            lines.push(base + mark + countNote);
          } else {
            // 名称缺席（名单派生条目）只显示准确 ID，不编造显示名。
            const base = entry.name === undefined
              ? `${entry.provider}/${entry.id}`
              : t(lang, 'render.list.modelLine', { provider: entry.provider, model: entry.id, name: entry.name });
            const mark = entry.source === 'allowed-list'
              ? t(lang, 'render.list.allowedListMark')
              : entry.selectable === false ? t(lang, 'render.list.notInAllowList') : '';
            lines.push(base + mark + (entry.description === undefined ? '' : ` — ${entry.description}`));
          }
        }
      }
    }
    if (result.beyond_end !== true) {
      const lastPage = Math.max(1, Math.ceil(result.total / result.page_size));
      // 页脚续查提示与结构化 next 字段同源：正文里的参数就是 next 对象本身。
      const nextHint = result.has_next === true && result.next !== undefined
        ? t(lang, 'render.list.nextHint', { next: JSON.stringify(result.next) })
        : '';
      lines.push(t(lang, 'render.list.pageFooter', {
        page: result.page, lastPage, total: result.total, partialNote, nextHint
      }));
    }
  }
  lines.push(t(lang, 'render.list.applicability', {
    target: result.target,
    verdict: result.verdict === 'allowed'
      ? t(lang, 'list.verdict.allowed')
      : result.verdict === 'not-allowed'
        ? t(lang, 'list.verdict.notAllowed')
        : t(lang, 'list.verdict.unconfirmed'),
    basis: result.basis
  }));
  if (result.example !== undefined) {
    lines.push(t(lang, 'render.list.example', { target: result.target, example: JSON.stringify(result.example) }));
  }
  return lines.join('\n');
}

/**
 * 构造 `async_list_subagent_models` 工具定义。
 * @param {object} ctx - cordis 上下文（`llm`／`subagentModelSelection` 按调用
 *   可选读取；`tools.get` 供身份段比对；`subagents` 为后端段的注册表只读
 *   查询——后端取值读工具行登记簿登记的**创建行**配置视图）。
 * @param {object} config - 生效配置视图（`agentLang` 现读）。
 * @returns {object} ToolDefinition。
 */
export function createListModelsTool(ctx, config) {
  const text = buildToolText('async_list_subagent_models', config);
  const tool = defineTool({
    name: 'async_list_subagent_models',
    description: text.description,
    parameters: text.parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          entries: { type: 'array', required: true },
          total: { type: 'number', required: true },
          page: { type: 'number' },
          page_size: { type: 'number' },
          provider: { type: 'string' },
          query: { type: 'string' },
          has_next: { type: 'boolean' },
          beyond_end: { type: 'boolean' },
          version: { type: 'string', required: true },
          complete: { type: 'boolean', required: true },
          failed_providers: { type: 'array' },
          target: { type: 'string', required: true },
          verdict: { type: 'string', required: true },
          basis: { type: 'string', required: true },
          example: { type: 'object', additionalProperties: true },
          unlisted_provider: { type: 'string' },
          unlisted_had_routes: { type: 'boolean' },
          next: {
            type: 'object',
            additionalProperties: false,
            properties: {
              page: { type: 'number' },
              page_size: { type: 'number' },
              version: { type: 'string' },
              provider: { type: 'string' },
              query: { type: 'string' },
              target_tool: { type: 'string' }
            }
          }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderListResult(config.agentLang, value)
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const lang = config.agentLang;
      const q = normalizeQueryArgs(args, lang);
      const llm = ctx.get('llm');
      if (llm === undefined) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.list.llmUnavailable')}`);
      }
      const scope = exec.agent ?? undefined;
      const target = resolveTarget(ctx, scope, q.targetTool);
      const applicability = await judgeApplicability(ctx, scope, target, lang);
      // 已确认允许集合：条目级可选项、未列路由并入、允许计数与示例的共同上游；
      // 目标级非「允许选择」时没有已确认集合，一律不并入、不标可选。
      const allowedRoutes = applicability.verdict === 'allowed' && Array.isArray(applicability.routes)
        ? applicability.routes
        : undefined;

      let catalog;
      try {
        catalog = await readCatalog(llm, q, allowedRoutes);
      } catch (error) {
        if (q.provider !== undefined && q.model !== undefined) {
          // 详情失败两档定性（设计 §3.7）：按失败的**稳定公开 code** 分类
          // （HarnessError／LlmError 契约按 code 路由，不解析 message 文本）。
          // `UNKNOWN_MODEL`（解析路径现有实例＝pi-ai 适配器对未配置模型的
          // 报告）及后续同类表示「模型不受支持」的 code 归「不支持」；其余
          // code（网络类失败、INVALID_MODEL_INFO 元数据契约违例）与无稳定
          // code 的失败一律归「读取失败」并保留原始原因，不编造定性（§5.7）。
          if (unsupportedModelCode(error)) {
            throw new Error(`${LOG_PREFIX} ${t(lang, 'error.list.detailUnsupported', {
              provider: q.provider, model: q.model
            })}`);
          }
          throw new Error(`${LOG_PREFIX} ${t(lang, 'error.list.detailFailed', {
            provider: q.provider, model: q.model, reason: String(error?.message ?? error)
          })}`);
        }
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.list.providersFailed', { reason: String(error?.message ?? error) })}`);
      }
      const sorted = sortEntries(catalog.entries);
      // 条目级可选项（设计 §3.7）：目标级「允许选择」时逐模型标注——名单内
      // 可选、名单外不可选，目录可见不冒充获准；其余两档不标，只报目录事实。
      // 名单比对按 provider/model 二元组逐字段进行（routesByProvider 的分组
      // 索引；本常量服务本次 execute 的**判定**三处消费——条目标记、详情
      // 判定、供应商计数。readCatalog 内部为并入「只出现在允许名单的供应
      // 商」另建一份同构索引，那是目录并入用途，与本判定常量无关）：
      // 拼接串键会让 `(p/q,r)` 与 `(p,q/r)` 碰撞成同键，把名单外
      // 路由误标可选。
      const allowedByProvider = allowedRoutes === undefined ? undefined : routesByProvider(allowedRoutes);
      if (allowedByProvider !== undefined) {
        for (const entry of sorted) {
          if (entry.kind !== 'model') continue;
          entry.selectable = allowedByProvider.get(entry.provider)?.has(entry.id) === true;
        }
      }
      const token = versionToken(q, target, applicability, sorted, catalog.failed);
      if (q.page > 1 && q.version !== token) {
        throw new Error(`${LOG_PREFIX} ${t(lang, 'error.list.versionStale')}`);
      }

      // 详情模式单条返回，不走分页；其余模式先筛选后分页，页号越过末页给空页
      // ＋总数＋重查出路（不报错、不改读首页）。
      let verdict = applicability.verdict;
      let basis = applicability.basis;
      let pageResult;
      let example;
      if (catalog.mode === 'model-detail') {
        const info = sorted[0];
        const efforts = Array.isArray(info.reasoning?.efforts) ? info.reasoning.efforts : [];
        const entry = {
          kind: 'model-detail', provider: info.provider, id: info.id, name: info.name,
          ...(info.description === undefined ? {} : { description: info.description }),
          ...(efforts.length === 0 ? {} : { efforts: efforts.map((effort) => ({ id: effort.id, name: effort.name })) }),
          ...(info.reasoning?.defaultEffort === undefined ? {} : { default_effort: info.reasoning.defaultEffort })
        };
        // 准确详情的判定按该具体路由取档（设计 §3.7）：目标已确认允许而路由
        // 不在集合内→「不允许选择」并写明路由未获准；详情仍完整返回。比对按
        // 二元组逐字段（与条目级同一索引——拼接串会碰撞）。
        let routeAllowed = false;
        if (allowedByProvider !== undefined) {
          routeAllowed = allowedByProvider.get(info.provider)?.has(info.id) === true;
          if (routeAllowed !== true) {
            verdict = 'not-allowed';
            basis = t(lang, 'list.basis.routeNotAllowed', { provider: info.provider, model: info.id });
          }
        }
        example = routeAllowed === true
          ? exampleArguments(target, applicability, { provider: info.provider, id: info.id }, efforts, lang)
          : undefined;
        pageResult = { mode: 'model-detail', entries: [entry], total: 1 };
      } else {
        const total = sorted.length;
        const start = (q.page - 1) * q.pageSize;
        const beyond = start >= total && total > 0;
        const slice = beyond ? [] : sorted.slice(start, start + q.pageSize);
        const hasNext = start + q.pageSize < total;
        // 示例取本页第一条可选条目（设计 §3.7：本页无可选条目则不生成）。
        if ((catalog.mode === 'models' || catalog.mode === 'search') && slice.length > 0) {
          const firstSelectable = slice.find((item) => item.kind === 'model' && item.selectable === true);
          if (firstSelectable !== undefined) {
            example = exampleArguments(target, applicability,
              { provider: firstSelectable.provider, id: firstSelectable.id }, undefined, lang);
          }
        }
        // 续查参数（设计 §3.7）：在场的筛选逐项携带＋page_size＋版本令牌＋下一页
        // page，直接作为下一次调用的参数即可续查；正文页脚提示与它同源。
        const next = hasNext
          ? {
            ...(q.provider === undefined ? {} : { provider: q.provider }),
            ...(q.query === undefined ? {} : { query: q.query }),
            ...(q.targetTool === undefined ? {} : { target_tool: q.targetTool }),
            page_size: q.pageSize,
            version: token,
            page: q.page + 1
          }
          : undefined;
        pageResult = {
          mode: catalog.mode,
          entries: slice,
          total,
          page: q.page,
          page_size: q.pageSize,
          has_next: hasNext,
          ...(beyond ? { beyond_end: true } : {}),
          ...(next === undefined ? {} : { next })
        };
        if (catalog.mode === 'providers') {
          // 计数口径定稿（需求 §2.3.4）：目标依据已确认→「允许」计数＝名单中该
          // 供应商路由总数（目录列出与未列出一并计入，含只出现在允许名单的
          // 供应商；列举失败不影响该口径——计数来源是已确认策略）；依据未确认
          // 或「不允许选择」→保持目录已知数／unknown（没有已确认集合可供计数）。
          // 内部清单（catalog_model_ids）只服务于版本令牌，不进回显。
          if (allowedByProvider !== undefined) {
            for (const entry of slice) {
              if (entry.kind !== 'provider') continue;
              entry.model_count = allowedByProvider.get(entry.id)?.size ?? 0;
              entry.count_kind = 'allowed';
              delete entry.catalog_model_ids;
            }
          } else {
            for (const entry of slice) {
              if (entry.kind !== 'provider') continue;
              delete entry.catalog_model_ids;
            }
          }
        }
      }

      return {
        ...pageResult,
        version: token,
        complete: catalog.failed.length === 0,
        ...(catalog.failed.length === 0 ? {} : { failed_providers: catalog.failed }),
        target: applicability.target,
        verdict,
        basis,
        // 筛选条件与示例回显（需求 §2.3.4：结果回显目标与筛选条件；示例仅在
        // 目标级允许且路由已获准时出现）。
        ...(q.provider === undefined ? {} : { provider: q.provider }),
        ...(q.query === undefined ? {} : { query: q.query }),
        ...(example === undefined ? {} : { example }),
        ...(catalog.unlisted === undefined ? {} : { unlisted_provider: catalog.unlisted }),
        ...(catalog.unlistedRoutes === true ? { unlisted_had_routes: true } : {})
      };
    }
  });
  tool.rebuildText = (cfg) => buildToolText('async_list_subagent_models', cfg);
  return tool;
}
