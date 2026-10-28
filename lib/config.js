/**
 * 配置 schema、默认值与夹紧函数。
 *
 * 设计依据：需求 §5.1/§5.2 与设计 §5.1。数字体系遵循需求 §5.2，不得自创。
 * ## 三处形态要点
 *
 * 1. **根形态：settings 子树**。`Config` 根是普通对象，只挂三类成员：行级
 *    非配置字段——行身份字段 `toolName`、`owningPreset` 与三个委托行级键
 *    `agentOptions`、`agentPreset`、`allowedAgentPresets`（需求 §2.3.1，非
 *    volatile 固定路径）——以及 `settings` 子树（`z.transform(17 字段)
 *    .default({})`）。17 个可编辑字段全部住在子树里，字段自身不逐个挂
 *    volatile 标记——schemastery 禁止 volatile 嵌套，volatile 节点之内的字段
 *    再挂 volatile 会在 resolve 期抛错。设置表单来自
 *    **entry Config 的 volatile 子树**（`dsh-settings` 的 `volatileForm` 暴露
 *    整棵 settings 子树），且 `configEditor.entries()` 只收根 include 树的条目
 *    （`dsh-config-editor/lib/index.js:30-35`）——预设子树的工具行**不产生
 *    表单**。
 * 2. **行身份字段保护（设计 §5.1）**。身份字段留在根对象的非 volatile 路径：
 *    设置网关把 volatile 子树内的一切路径视为可就地编辑（`isVolatilePath`），
 *    身份字段若进子树，`settings/update` 就能改写行身份并触发重挂；放在固定
 *    路径上，`mutate` 的逐路径预检与 `update`/`replace` 的合并结果校验都会
 *    对身份字段抛 `Config field "toolName" is not volatile`。该保护不依赖武装
 *    状态。
 * 3. **volatile 双向解包**。schemastery 的 `Schema.resolve` 对 volatile 节点
 *    **总是**把结果包进 `createVolatile` Ref（`schemastery/lib/index.mjs:265-273`），
 *    而 `resolve` 又**不解包**输入侧的 Ref（`isVolatile` 只在 `simplify` 里用，
 *    `:178`）。新形态下 Ref 只有一个（`settings` 固定路径），`resolveConfig`
 *    仍然两头拆：入口拆 loader 给的 `settings` 子树 Ref，`Config()` 调用后再拆
 *    输出侧的同一个 Ref。
 *
 * @module dsh-async-tools/config
 */
import z from '@deepseek-ai/schemastery';
import { FIELD_MAX, FIELD_MIN, ORDERED_PAIRS } from './budget-limits.js';
import { t } from './text.js';

/** 作业种类（运行时未强制约束，自定义 kind 实测可用）。 */
export const DEFAULT_JOB_KIND = 'async-command';

/** `async_agent` 的默认子代理后端（真实注册名，附证：spawn-in-process 的默认名）。 */
export const DEFAULT_SUBAGENT_PROVIDER = 'spawn';

/** 插件自有日志前缀；审计落点 stderr（设计 §6.3）。 */
export const LOG_PREFIX = '[async-tools]';

/** 本包可注册的六个工具名（第四个是 async_agent，第五个是 async_workflow——
 *  delegation 组内行，需求 §2.4；第六个是路由查询 async_list_subagent_models，
 *  顶层只读行，需求 §2.3.4）。 */
export const TOOL_NAMES = Object.freeze([
  'async_run', 'async_wait_job', 'async_wait_agent', 'async_agent', 'async_workflow', 'async_list_subagent_models'
]);

/** 工具名字面量 schema。 */
export const ToolNameSchema = z.union(TOOL_NAMES);

/**
 * 解包一个 volatile Ref（cosmokit `createVolatile` 产物：冻结的 `{get, [write]}`，
 * `cosmokit/lib/index.js:102-110`）。鸭子判定 `.get`：本模块的字段值是数字/字符串，
 * 不会天然带 `get`，误判空间为零。
 * @param {unknown} value - Ref 或普通值。
 * @returns {unknown} 普通值。
 */
function unwrapVolatile(value) {
  return typeof value?.get === 'function' ? value.get() : value;
}

/**
 * 把 loader 交给插件的活配置物化成普通值对象（入口侧解包，设计 §5.1）。
 *
 * 活根配置只有 `settings` 一个 Ref（子树整体）：整键拆包。平铺输入（测试与
 * 直调便利形态，等价于 settings 子树内容）走字段级拆包——单字段假 Ref
 * （cosmokit `createVolatile` 形状）在这条路径上仍然合法。
 * @param {object|undefined} raw - 行配置（settings 可能是子树 Ref）。
 * @returns {object} 全普通值的配置对象。
 */
export function materializeConfig(raw) {
  const plain = { ...(raw ?? {}) };
  if ('settings' in plain) {
    plain.settings = unwrapVolatile(plain.settings);
    return plain;
  }
  for (const key of SETTING_FIELD_KEYS) {
    if (key in plain) plain[key] = unwrapVolatile(plain[key]);
  }
  return plain;
}

const ROW_IDENTITY_KEYS = ['toolName', 'owningPreset', 'agentOptions', 'agentPreset', 'allowedAgentPresets'];

/**
 * 把物化后的输入归一成 `Config` 的根形态：有 `settings` 键的（活根配置、
 * 组合文件）原样透传；平铺输入把行身份与委托行级键抬回根、其余字段整体
 * 搬进 `settings` 子树（未知键由内层 `z.object` 丢弃）。
 * @param {object} plain - 物化后的普通值输入。
 * @returns {object} 根形态输入（`{toolName?, owningPreset?, agentOptions?, agentPreset?, allowedAgentPresets?, settings}`）。
 */
function normalizeConfigInput(plain) {
  if (plain.settings !== undefined) return plain;
  const input = {};
  for (const key of ROW_IDENTITY_KEYS) {
    if (plain[key] !== undefined) input[key] = plain[key];
  }
  const settings = { ...plain };
  for (const key of ROW_IDENTITY_KEYS) delete settings[key];
  input.settings = settings;
  return input;
}

/**
 * 预算与运行参数字段表（`toolName` 之外的全部）。
 *
 * ## 字段住在 settings 子树（设计 §5.1）
 *
 * 字段级不挂 volatile 标记——子树节点整体 volatile（见 `SETTINGS_NODE`）；
 * 设置页提交时走 loader 的**就地提交**（fiber 不重启），
 * 只向本 fiber 派发 `'loader/volatile-update'`
 * （`cordis-plugin-loader/lib/index.js:393-425`）。宿主行据此刷新模块级活快照
 * （`lib/settings.js`）。`toolName` **刻意不在子树里**：它是行级选择（这一行
 * 注册哪个工具），改它本来就该换一行配置，不该热改（行身份字段保护见模块头）。
 */
const BUDGET_FIELDS = {
  /**
   * `async_run` 的首次等待默认值（需求 §5.2：20000，理由见文档）。
   *
   * 这里的 `.min(FIELD_MIN.*)` **不是装饰**：设置表单按 schema 逐字段校验用户输入
   * （宿主 SettingsForms），把约束放在 schema 层，拒绝就发生在**保存那一刻**。
   * `.max(FIELD_MAX.*)` 同理（需求 §5.2）：`setTimeout` 延迟越过 2^31-1 会被置 1ms
   * 立即触发，上界必须在 schema 层拦住，不能只靠卡片层校验。下界的单一来源
   * 同在 `lib/budget-limits.js`（设计 §5.4 FIELD_MIN 表；毫秒字段 1、`askTimeoutMs`
   * 10000），客户端内联同值由 T23c 对账。
   */
  defaultYieldMs: z.number().min(FIELD_MIN.defaultYieldMs).max(FIELD_MAX.defaultYieldMs).default(20000),
  minYieldMs: z.number().min(FIELD_MIN.minYieldMs).max(FIELD_MAX.minYieldMs).default(1000),
  maxYieldMs: z.number().min(FIELD_MIN.maxYieldMs).max(FIELD_MAX.maxYieldMs).default(600000),

  /** `async_wait_job` / `async_wait_agent` 的默认与边界。 */
  defaultWaitMs: z.number().min(FIELD_MIN.defaultWaitMs).max(FIELD_MAX.defaultWaitMs).default(30000),
  minWaitMs: z.number().min(FIELD_MIN.minWaitMs).max(FIELD_MAX.minWaitMs).default(250),
  maxWaitMs: z.number().min(FIELD_MIN.maxWaitMs).max(FIELD_MAX.maxWaitMs).default(600000),

  /** `async_wait_agent` 的备用状态轮询间隔（需求 §5.2；受 maxWaitMs 配对约束）。 */
  pollIntervalMs: z.number().min(FIELD_MIN.pollIntervalMs).max(FIELD_MAX.pollIntervalMs).default(500),

  /**
   * 单次返回给模型的输出**字符**上限。
   *
   * 单位是字符（`String#length`），**不是字节**。`dsh-tool-jobs` 的
   * `TextRetainer(maxBytes)` 是另一层（作业注册表内部的通知文案预算），两者不同层：
   * 这个值是模型可见的截断长度，按字符算才对得上"模型看到多少"。
   * 保持字符口径（需求 §5.2：按 `String.length` 计量），不得改成字节。
   * `.step(1)`：**正整数**（需求 §5.2）——注册时按 `maxResultChars × 3` 换算
   * 环形缓冲的 `outputLimitBytes`，宿主要求它是正安全整数；小数配置在
   * schema 层就拒绝（设置表单与 `resolveConfig` 同走这条校验），不是运行时
   * 再夹紧。`.max(FIELD_MAX.maxResultChars)`：与三倍换算联动，
   * 1000000 字符 → 环形缓冲上界 3MB/作业。
   */
  maxResultChars: z.number().step(1).min(FIELD_MIN.maxResultChars).max(FIELD_MAX.maxResultChars).default(30000),

  /**
   * 作业种类名。非空：空串会让作业在注册表里没有可辨识的 kind，
   * 出问题时 `job_list` / 日志里都认不出它。
   */
  jobKind: z.string().min(1).default(DEFAULT_JOB_KIND),

  /**
   * `async_agent` 的子代理后端名（需求 §2.3.1）。**空串回默认 `'spawn'`**——
   * 与 `jobKind` 空串抛错的策略**有意不同**：jobKind 是
   * 标识符键（拼进注册表的 kind，坏值静默错位，故抛）；provider 名无效只能在
   * **执行时**对着注册表报可读错误（注册表在宿主侧且可变，schema 里枚举会过期），
   * 空串回默认让"没配"等价"用 spawn"。schema 层因此**不设** `.min(1)`。
   */
  subagentProvider: z.string().default(DEFAULT_SUBAGENT_PROVIDER)
};

/**
 * 语言字段表（需求 §5.3）：与预算字段**分开**的一组 settings 子树字段。
 *
 * `uiLang` 属展示侧（`client.js` 的词典选择，`"auto"` 跟随宿主语言）；
 * `agentLang` 管 Agent 侧（六个工具的模型可见文案）。
 *
 * 值域用 `z.union` 字面量集合（需求 §5.2 的枚举表）：**不带 `.loose()`**——
 * 设置网关按 schema 逐字段校验写入，枚举外的值（如 `uiLang: 'fr'`）必须在
 * 写入那一刻被拒绝并给原因（需求 §5.1「非法新输入拒绝并给原因」）；加了
 * loose 会静默收敛，写入方看到的是"成功但值变了"，正是要拦的形态。代价：
 * 手改 profile 落进的枚举外垃圾值会让整份 `Config()` 解析失败（loader 行级
 * 报错、可见可修）——这与布尔开关把类型检查放进 transform 回调的取舍不同
 * （见 `FLAG_FIELDS`）：语言值错档会让界面或模型文案静默指错语言，没有
 * 安全默认可降级运行，宁可行级报错；布尔开关有合法默认（两开关默认关），
 * 启动损坏值走降级保住修复入口。`resolveConfig` 的值域检查
 * 保留为运行侧第二级防线（`!!js` 表达式等经 loader 求值后才到那里）。
 */
const LANG_FIELDS = {
  uiLang: z.union(['auto', 'zh', 'en']).default('auto'),
  agentLang: z.union(['en', 'zh']).default('en')
};

/**
 * 开关字段表（需求 §6.3）：静默失败三防线的**唯一**总开关，默认关。
 *
 * 住在 settings 子树：与预算/语言字段同一条就地提交链（设计 §5.1）——设置卡保存后不重启，
 * 三处消费点（a 结果 note / b 描述警示段 / c 常驻纪律段）都按各自时点的
 * 活快照现读（后台作业在结算时刻读，设计 §6.2）。默认关：
 * 三防线必须能用行为差异证明"关 = 不存在"。
 */
const FLAG_FIELDS = {
  /**
   * 静默失败陷阱三防线总开关。
   *
   * schema 是 `any` 透传＋`.default(false)`：候选原值（含非布尔）原样送到
   * transform 回调，由写入判据组做类型检查（设计 §5.1）。类型检查不放
   * 字段 schema、也不挂 `.loose()`：`z.boolean()` 会在装配 resolve 的字段层
   * 抛错，启动时已损坏的持久布尔值直接杀死行、设置卡片消失，到不了 apply
   * 自检的降级通道；loose 则把非布尔静默收敛成默认，写入方看到「成功但
   * 值变了」。`any` 透传让候选活着走到回调——运行中新非法提交在写入判据组
   * 拒绝，启动损坏值在 apply 自检（同源判据）降级为合法默认运行。
   */
  silentFailureGuard: z.any().default(false),

  /**
   * 提问接管总开关（需求 §4.1，默认关 = 零行为变化）。
   *
   * 与 `silentFailureGuard` 同款 `any` 透传：类型检查在 transform 回调与
   * apply 自检（同源判据，见 `armedSettingsCallback`）。消费点在
   * `lib/ask-takeover.js` 的判定序——每次提问**请求时刻活读**快照
   * （不是构造快照，需求 §5.1），首问后翻开关立即生效。
   */
  askTakeover: z.any().default(false)
};

/**
 * 提问接管参数字段表（需求 §4.1/§4.3 与 §5.2 的默认值）。
 *
 * `askTimeoutMs` 的界 `[10000, 600000]`：下界 10 s 防"秒级窗口形同虚设"，上界 10 min
 * 与等待字段的量级同值（`FIELD_MAX.askTimeoutMs`，进定时器路径的毫秒字段都封上界——
 * 需求 §5.2）；`askExtendMs` 的界 `[1, 2^31-1]`：延长追加时长，下界 1 毫秒不为零
 * （零/负延长形同未点，语义交给"无在窗批返回 0"），上界与到期分段的单段上限同值；
 * `askUiSeat` 的值域与语言字段同款 `z.union` 字面量（需求 §5.2：`sidebar` /
 * `overlay`）——枚举外值在写入网关就被拒绝（需求 §5.1），`resolveConfig` 的
 * 检查保留为运行侧第二级防线。
 */
const ASK_FIELDS = {
  askTimeoutMs: z.number().min(FIELD_MIN.askTimeoutMs).max(FIELD_MAX.askTimeoutMs).default(60000),
  askExtendMs: z.number().min(FIELD_MIN.askExtendMs).max(FIELD_MAX.askExtendMs).default(60000),
  askUiSeat: z.union(['sidebar', 'overlay']).default('sidebar')
};

/**
 * 把 transform 回调造成**自续序列化**（设计 §5.1）。
 *
 * schemastery 以 `callback.toJSON()`（缺省 = `toString()`）序列化 transform
 * 回调、对端用 `new Function` 复活。schema 投影要经两跳序列化（表单重建一跳、
 * describe 输出一跳），`new Function` 复活出的副本不带 `toJSON`——第二跳会把
 * callback 整个丢掉（JSON 序列化函数属性得 undefined），客户端校验随之失败。
 * 解法是让 `toJSON` 重建「内层函数源 + `toJSON` 自身源」拼成的自重建表达式，
 * 复活出的副本自带 `toJSON`，任意多跳不断链。
 * @param {Function} build - 无参构造函数，返回一个**自包含**（不引用闭包）的回调。
 * @returns {Function} 带 `toJSON` 的回调。
 */
function makeSelfSustaining(build) {
  const f = build();
  f.toJSON = function () {
    return '(function(){ var f = ' + f.toString() + '; f.toJSON = ' + f.toJSON.toString() + '; return f; })()';
  };
  return f;
}

/**
 * 容忍态回调（初始态，设计 §5.1 回调三形）：原样放行。启动容错靠它——装配
 * 自检完成前，非法持久值能让行装配成功、设置卡片在场（修复入口不死）。
 * 该窗口不可写：`dsh-config-editor` 的 `edit` 要求行在场且激活（装配未完成
 * 时设置写入不可达）。
 */
const tolerantSettingsCallback = makeSelfSustaining(() => function tolerantSettings(value) {
  return value;
});

/**
 * 武装态回调：写入判据组＝五条链式不等式（设计 §5.4，判据与 `assertCrossFieldOrder`
 * 同源——ORDERED_PAIRS 三对加 DEFAULT_WITHIN_RANGE 两区间展开后的五式）
 * ＋两个布尔开关字段的类型检查（`FLAG_FIELDS` 的 any 透传把候选原值送到这里）。
 * 写入拒绝（`settings/update`/`replace`/`mutate` 经 `configEditor.edit`
 * 落盘前 resolve 完整下一值）与运行中非法重载拦截（loader `_commitVolatile`
 * 的 resolve）都靠它。函数体必须自包含（不得引用闭包/导入——序列化链的硬性
 * 约束，见 `makeSelfSustaining`）；与 `assertCrossFieldOrder`、`resolveConfig`
 * 布尔检查的一致性由 `test/config.test.mjs` 用同一组非法值多侧对账。
 * 类型检查放在回调而不放字段 schema：启动损坏值要活着走到 apply 自检降级
 * （见 `FLAG_FIELDS`），运行中的新非法提交才在这里拒绝——启动保守处理与
 * 新输入校验分离是需求 §5.1 的要求。
 */
const armedSettingsCallback = makeSelfSustaining(() => function crossFieldCheck(v) {
  const bad = [];
  if (v.minYieldMs > v.maxYieldMs) bad.push(`minYieldMs=${v.minYieldMs} > maxYieldMs=${v.maxYieldMs}`);
  if (v.defaultYieldMs < v.minYieldMs || v.defaultYieldMs > v.maxYieldMs) bad.push(`defaultYieldMs=${v.defaultYieldMs} outside [minYieldMs=${v.minYieldMs}, maxYieldMs=${v.maxYieldMs}]`);
  if (v.minWaitMs > v.maxWaitMs) bad.push(`minWaitMs=${v.minWaitMs} > maxWaitMs=${v.maxWaitMs}`);
  if (v.defaultWaitMs < v.minWaitMs || v.defaultWaitMs > v.maxWaitMs) bad.push(`defaultWaitMs=${v.defaultWaitMs} outside [minWaitMs=${v.minWaitMs}, maxWaitMs=${v.maxWaitMs}]`);
  if (v.pollIntervalMs > v.maxWaitMs) bad.push(`pollIntervalMs=${v.pollIntervalMs} > maxWaitMs=${v.maxWaitMs}`);
  if (bad.length > 0) throw new Error('[async-tools] cross-field violation: ' + bad.join('; '));
  const flagBad = [];
  for (const key of ['silentFailureGuard', 'askTakeover']) {
    if (typeof v[key] !== 'boolean') {
      let shown;
      try { shown = JSON.stringify(v[key]); } catch (e) { shown = String(v[key]); }
      if (shown === undefined) shown = String(v[key]);
      flagBad.push(`${key} must be a boolean, got ${typeof v[key]} ${shown}`);
    }
  }
  if (flagBad.length > 0) throw new Error('[async-tools] type violation: ' + flagBad.join('; '));
  return v;
});

/**
 * settings 子树节点：volatile 挂在固定路径 `['settings']`，transform 承担
 * 写入期拒绝（设计 §5.1）。`transform(inner, callback, true)` 的第三参让
 * resolve 只取 `callback(result)`（preserve 语义）。
 */
const SETTINGS_NODE = z.transform(
  z.object({ ...BUDGET_FIELDS, ...LANG_FIELDS, ...FLAG_FIELDS, ...ASK_FIELDS }),
  tolerantSettingsCallback,
  true
).volatile().default({});

/**
 * 唯一的行配置 schema：根为普通对象，只挂行身份字段与 `settings` 子树
 * （设计 §5.1 结构形态）。
 *
 * `toolName` 只属于**行配置**，不属于设置表单：它在根的非 volatile 固定路径，
 * `volatileForm` 不暴露它（`dsh-settings/lib/index.js:118-131`），设置页永远
 * 看不到也改不了它。
 */
export const Config = z.object({
  /**
   * 本插件实例注册哪一个工具；**缺省 = 宿主角色**。
   * 一个包被引用多次、各自注册一个工具，是 shipped 预设里 `tool-subagent` 的成例。
   *
   * - 行配置里**有** `toolName` → 工具角色（预设顶层的五行加 delegation 组内一行，各注册一个工具）；
   * - 行配置里**没有** `toolName` → 宿主角色（`cordis.patch.yml` 插在宿主侧的
   *   那一行：播报设置快照 + 监听 volatile 提交，**不注册任何工具**）。
   *
   * 因此这里**不能 `.required()` 也不能 `.default()`**：
   * - `.required()` 会让宿主行（合法地没有 `toolName`）在组合加载那一刻抛错；
   * - `.default(x)` 会让宿主行静默变成"注册工具 x 的行"——宿主侧的工具会进
   *   **全局工具层**（需求 §3.2 禁止），那正是最危险的静默泄漏。
   */
  toolName: ToolNameSchema,

  /**
   * 行身份归属（设计 §6.2（机制）／需求 §6.3（范围））：本行由哪份预设补丁装载——只有本包两份
   * 预设补丁里的工具行携带（`dsh-async` / `dsh-async-create`），是装载期
   * 一次性事实。
   *
   * 用途：描述警示（`lib/descriptions.js`）的在场由两个条件共同决定——本行
   * 声明的归属值是**候选条件**；`lib/jobs.js` 执行入口核得「会话实际预设与
   * 行声明值一致」的运行时证据（按行登记进 `descriptions.js`）是**必要条件**。
   * 静态描述读不到会话上下文，本字段是它唯一可用的行级输入；单凭复制声明
   * 到自建行拿不到该行的核得证据，警示不出现。与 `toolName` 同款纪律：
   * **不能 `.required()` 也不能 `.default()`**——自定义行合法地没有归属，
   * 缺省它才让防护描述不出现。声明值本身**不开启防护**：运行时防护
   * （`lib/jobs.js` 的 `guardActiveFor`）另核对会话实际预设与行声明全等，
   * 自建行抄上本包声明值也对不上会话实际预设，防护保持关闭（失效安全
   * 方向＝关）。身份字段与 toolName 一起留在根的非 volatile 路径（行身份
   * 字段保护，设计 §5.1）。
   */
  owningPreset: z.string(),

  /**
   * 三个委托行级键（需求 §2.3.1「保留按 dsh 配置子代理默认选项及可选预设的方式」；
   * 与宿主 `dsh-tool-subagent` 行的 `agentOptions`／`agentPreset`／`allowedAgentPresets`
   * 同名同形，设计 §3.3）。与 `toolName`／`owningPreset` 同层：行级一次性事实，
   * 非 volatile、不进设置表单。本包两份预设的工具行不配置这三个键；自定义行
   * 可按原生同形的键配置（`agent_preset` 参数仅在配置了 `allowedAgentPresets`
   * 且后端支持时暴露）。
   *
   * - `agentOptions`：子代理默认选项（路由类默认触发创建前预检，语义见 agent.js）；
   * - `agentPreset`：缺省预设；允许集合在场时必须包含于允许集合；
   * - `allowedAgentPresets`：允许集合、非重复、**在场时至少一项**——声明与
   *   原生同形（`z.array(z.string().min(1)).min(1).default(void 0)`）：
   *   `.default(void 0)` 让缺席键解析为 undefined 而不是物化成 `[]`，
   *   因此 `.min(1)` 只拦显式空数组、不拦未配置的行；schema 层即原生
   *   同形拒绝（装载 resolve、config-editor 落盘前 resolve、客户端草稿
   *   校验都吃这层）。原料层的可读拒绝（本包词典文案）在 internal/config
   *   waterfall（`lib/settings.js` 监听；cordis `Fiber._resolveConfig`
   *   每次 resolve 先流经它）——两层先后守护同一判据。
   *
   * schemastery 物化怪癖（与声明形态绑定）：**没有** `.default(void 0)` 的
   * 缺席 array 才会被物化成 `[]`（裸加 `.min(1)` 会把所有未配置该键的行
   * 拦死在装配解析，不能那样写）；本键声明带 `.default(void 0)` 后缺席
   * 解析为 undefined、显式空数组被 `.min(1)` 拒绝——长度判据由 schema 层
   * 独占，代码层不做长度检查。「无键的 agentOptions」折回「未配置」不变（object 无此
   * 声明形态）；其余校验（非重复、默认预设 ∈ 允许集合）在代码层做。
   */
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
  }),
  agentPreset: z.string().min(1),
  allowedAgentPresets: z.array(z.string().min(1)).min(1).default(void 0),

  settings: SETTINGS_NODE
});

/**
 * 预算字段的键，**按声明顺序**。导出它是为了让界面判据能按身份核对：
 * 设置表单要求全部字段逐项在场可写（需求 §5.4），判据得能说出"哪一项缺了"，
 * 而不是只数个数（`verify/r24-judgements.mjs` 与 `verify/_visual/probe-r24-bundle-config.mjs` 读它）。
 */
const BUDGET_FIELD_KEYS = Object.keys(BUDGET_FIELDS);
export { BUDGET_FIELD_KEYS };

/** 语言字段的键，**按声明顺序**。 */
const LANG_FIELD_KEYS = Object.keys(LANG_FIELDS);
export { LANG_FIELD_KEYS };

/** 开关字段的键，**按声明顺序**（FLAG 组含总开关与静默失败开关）。 */
const FLAG_FIELD_KEYS = Object.keys(FLAG_FIELDS);
export { FLAG_FIELD_KEYS };

/** 提问接管参数字段的键，**按声明顺序**。界面判据的完整键集 = 预算 + 语言 +
 * 开关 + 提问接管**四组之和**，共 17 枚——总数与组数只在这里说一次，各组注释
 * 不再重复累加公式（重复公式一多，加组时总有几处忘改）。 */
const ASK_FIELD_KEYS = Object.keys(ASK_FIELDS);
export { ASK_FIELD_KEYS };

/** settings 子树的全部字段键（四组拼接，**按声明顺序**）。 */
const SETTING_FIELD_KEYS = [...BUDGET_FIELD_KEYS, ...LANG_FIELD_KEYS, ...FLAG_FIELD_KEYS, ...ASK_FIELD_KEYS];
export { SETTING_FIELD_KEYS };

/**
 * 降级态回调（设计 §5.1 回调三形＋降级基线）：与**降级基线**深度相等的输入
 * 原样放行——基线＝降级时刻自检失败的那份已解析 `settings` 值（布尔开关的
 * 非法候选原值也在内：any 透传字段经 `resolveSettingsValue` 原样进基线，
 * 等值重放才对得上）。回调只见解析值，无法区分 loader 对未变化持久值的
 * 再解析与用户原样重存同一值——放行不改变持久状态（该值已在盘上），行与
 * 设置卡片活着、修复入口不死；与基线不同的新值一律照常执行同一组判据
 * （五条不等式＋布尔类型检查，非法即拒——降级期间**不会**放行新的非法值
 * 落盘）。基线以 JSON 字面量嵌入函数源码：自包含＋自续
 * 序列化（见 `makeSelfSustaining`），不引用闭包或模块状态——活 schema 节点
 * 的回调对象是基线的唯一载体（宿主行与工具行共用同一模块实例时全局一致，
 * 客户端复活副本携带同一基线是共享序列化链的既定后果）。
 * @param {object} baseline - 降级时刻自检失败的已解析 settings 值（17 键普通值）。
 * @returns {Function} 带自续 `toJSON` 的降级态回调。
 */
export function degradedSettingsCallback(baseline) {
  const baselineSource = JSON.stringify(baseline ?? null);
  const keysSource = JSON.stringify(SETTING_FIELD_KEYS);
  // Function 构造的源码模板是**一段 JS 源码**、不是面向模型的文案：整体一块
  // 模板字面量（模型文案检查器按此登记豁免），写入判据组（五条链式不等式＋
  // 布尔类型检查）与 armedSettingsCallback 同源（config 测试用同一组非法值
  // 两形同值对账——判据与拒绝文案单侧漂移都会红）。
  return makeSelfSustaining(() => Function('v', `"use strict";
const BASELINE = ${baselineSource};
const KEYS = ${keysSource};
const sameAsBaseline = v !== null && typeof v === 'object'
  && Object.keys(v).length === KEYS.length
  && KEYS.every((key) => key in v && v[key] === BASELINE[key]);
if (sameAsBaseline) return v;
const bad = [];
if (v.minYieldMs > v.maxYieldMs) bad.push(\`minYieldMs=\${v.minYieldMs} > maxYieldMs=\${v.maxYieldMs}\`);
if (v.defaultYieldMs < v.minYieldMs || v.defaultYieldMs > v.maxYieldMs) bad.push(\`defaultYieldMs=\${v.defaultYieldMs} outside [minYieldMs=\${v.minYieldMs}, maxYieldMs=\${v.maxYieldMs}]\`);
if (v.minWaitMs > v.maxWaitMs) bad.push(\`minWaitMs=\${v.minWaitMs} > maxWaitMs=\${v.maxWaitMs}\`);
if (v.defaultWaitMs < v.minWaitMs || v.defaultWaitMs > v.maxWaitMs) bad.push(\`defaultWaitMs=\${v.defaultWaitMs} outside [minWaitMs=\${v.minWaitMs}, maxWaitMs=\${v.maxWaitMs}]\`);
if (v.pollIntervalMs > v.maxWaitMs) bad.push(\`pollIntervalMs=\${v.pollIntervalMs} > maxWaitMs=\${v.maxWaitMs}\`);
if (bad.length > 0) throw new Error('[async-tools] cross-field violation: ' + bad.join('; '));
const flagBad = [];
for (const key of ['silentFailureGuard', 'askTakeover']) {
  if (typeof v[key] !== 'boolean') {
    let shown;
    try { shown = JSON.stringify(v[key]); } catch (e) { shown = String(v[key]); }
    if (shown === undefined) shown = String(v[key]);
    flagBad.push(\`\${key} must be a boolean, got \${typeof v[key]} \${shown}\`);
  }
}
if (flagBad.length > 0) throw new Error('[async-tools] type violation: ' + flagBad.join('; '));
return v;`));
}

/**
 * 判一份 `internal/config` waterfall 候选是否本包的行（宿主行与工具行）。
 * waterfall 是全树级的：宿主自己的行（如 `subagent`／`subagent_fork`）与
 * 其他插件的行同样流经本监听——识别标记：带 `toolName` 的候选必须是本包
 * 六个工具名之一；不带 `toolName` 的候选（宿主行全量、volatile 部分补丁、
 * simplify 最小写回）必须整体落在 settings 子树字段键集内。非本包候选
 * 原样放行，不进自检（foreign 配置过本包 schema 只会制造假降级登记）。
 * @param {unknown} config - waterfall 载荷。
 * @returns {boolean}
 */
export function isOwnConfigCandidate(config) {
  if (!config || typeof config !== 'object') return false;
  if (config.toolName !== undefined) return TOOL_NAMES.includes(config.toolName);
  const keysOf = (obj) => Object.keys(obj);
  if (config.settings !== undefined) {
    if (!config.settings || typeof config.settings !== 'object') return false;
    return keysOf(config.settings).every((key) => SETTING_FIELD_KEYS.includes(key));
  }
  const flat = keysOf(config);
  return flat.length > 0 && flat.every((key) => SETTING_FIELD_KEYS.includes(key));
}

/**
 * 当前武装状态（设计 §5.1 回调三形）。模块级：宿主行与工具行共用同一份
 * `lib/config.js` 模块实例，回调形态全局一致。初始容忍——启动容错要求
 * 「首播自检通过才武装」，装载即武装会让非法持久值的行直接装配失败；自检
 * 失败走降级（`setConfigValidationDegraded`，携带基线），降级同样记作未武装。
 */
let validationArmed = false;

/**
 * 切换 settings 子树校验回调的武装状态（`lib/settings.js` 的装配侧自检消费）。
 *
 * 换实现而不是换标志位：callback 必须自包含（序列化链硬性约束，见
 * `makeSelfSustaining`），不能引用模块级变量；各形各自是一份自续函数，
 * 切换 = 就地换活 schema 子树节点的 `callback`。切换会改变 schema 序列化，
 * describe revision 侧的表现属真机待验证子项（设计 §8.2 配置页面行）。
 * @param {boolean} armed - `true` 武装（写入拒绝/重载拦截），`false` 容忍（初始态）。
 * @returns {void}
 */
export function setConfigValidationArmed(armed) {
  validationArmed = armed === true;
  SETTINGS_NODE.callback = validationArmed ? armedSettingsCallback : tolerantSettingsCallback;
}

/**
 * 切到**降级态**回调（设计 §5.1 回调三形＋降级基线）：携带降级基线——与基线
 * 深度相等的输入放行，其余照常校验。基线以 JSON 字面量嵌进自续回调源码，
 * 活 schema 节点的回调对象是基线的唯一载体；`setConfigValidationArmed(true)`
 * （合法修复后）换回无基线的武装回调即清基线、重新武装。
 * @param {object} baseline - 降级时刻自检失败的已解析 settings 值（17 键普通值）。
 * @returns {void}
 */
export function setConfigValidationDegraded(baseline) {
  validationArmed = false;
  SETTINGS_NODE.callback = degradedSettingsCallback(baseline);
}

/**
 * 读当前武装状态（测试与探针消费；生产行为只由 resolve 结果体现）。
 * @returns {boolean} 武装为 `true`，容忍为 `false`。
 */
export function isConfigValidationArmed() {
  return validationArmed;
}

/**
 * 带秒数读数的字段（需求 §5.4）：全部毫秒口径字段，**按声明顺序**。
 *
 * 导出它是为了让界面判据能按身份核对读数**长在哪些字段上**——只数读数个数答不出
 * "读数挂错了字段"（`verify/r24-judgements.mjs` 的 `judgeConfigForm` 用它核对
 * 每个带读数的输入框身份，探针 `verify/_visual/probe-r24-bundle-config.mjs` 读页面）。
 */
const MS_FIELD_KEYS = [
  'defaultYieldMs',
  'minYieldMs',
  'maxYieldMs',
  'defaultWaitMs',
  'minWaitMs',
  'maxWaitMs',
  'pollIntervalMs',
  'askTimeoutMs',
  'askExtendMs'
];
export { MS_FIELD_KEYS };

/** `resolveConfig` 输出里要过正数断言的数字键。 */
const POSITIVE_KEYS = [
  'defaultYieldMs', 'minYieldMs', 'maxYieldMs',
  'defaultWaitMs', 'minWaitMs', 'maxWaitMs',
  'pollIntervalMs', 'maxResultChars', 'askTimeoutMs', 'askExtendMs'
];

/** 正有限数的断言。 */
function assertPositive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${LOG_PREFIX} ${label} must be a positive finite number, got ${JSON.stringify(value)}`);
  }
}

/**
 * 布尔开关候选的值渲染（类型检查错误文案）。回调形（武装／降级）因自包含
 * 约束内联同款逻辑，两侧输出必须逐字一致——由 config 测试的两形对账锁定。
 * `JSON.stringify` 对 Symbol 与 undefined 返回 undefined、对 BigInt 抛 TypeError
 * （这些形态不经设置链到达，仅为直调形态防住）——抛错与 undefined 两种都退 `String()`。
 * @param {unknown} value - 候选原值。
 * @returns {string} 展示文本。
 */
function renderFlagCandidate(value) {
  let shown;
  try { shown = JSON.stringify(value); } catch { shown = String(value); }
  return shown === undefined ? String(value) : shown;
}

/**
 * 把请求值夹紧到 `[min, max]`；缺省时取 `def`。
 * 纯函数，单测覆盖（设计 §8.2 核心矩阵）。
 * @param {number|undefined} requested - 调用者请求值。
 * @param {number} def - 缺省值。
 * @param {number} min - 下界。
 * @param {number} max - 上界。
 * @returns {number} 夹紧后的值。
 */
export function clamp(value, def, min, max) {
  const raw = value === undefined || value === null ? def : value;
  return Math.min(Math.max(raw, min), max);
}

/**
 * 必须保持 `min <= max` 的字段对（跨字段约束）。单一事实源在
 * `lib/budget-limits.js`（含 `pollIntervalMs <= maxWaitMs`；设置卡片的
 * 草稿校验与对账测试消费同一份）。
 */

/** 必须落在一个区间内的"默认值"字段：`[默认值键, 下限键, 上限键]`，三个都要查。 */
const DEFAULT_WITHIN_RANGE = [
  ['defaultYieldMs', 'minYieldMs', 'maxYieldMs'],
  ['defaultWaitMs', 'minWaitMs', 'maxWaitMs']
];

/**
 * 校验配置的跨字段约束（`resolveConfig` 的组成部分，独立导出给探针直测）。
 *
 * 判据收敛为单一事实源：本函数既被 `resolveConfig` 调用，也可被
 * 探针直接调用，两处永远同一份判据。
 *
 * @param {object} c - 已解析的普通值配置（Ref 已拆）。
 * @throws {Error} 约束不满足时抛出（英文文案：会进 stderr 通告与降级说明）。
 */
export function assertCrossFieldOrder(c) {
  for (const [minKey, maxKey] of ORDERED_PAIRS) {
    if (c[minKey] > c[maxKey]) throw new Error(`${LOG_PREFIX} ${minKey} > ${maxKey}`);
  }
  for (const [defaultKey, minKey, maxKey] of DEFAULT_WITHIN_RANGE) {
    if (c[defaultKey] < c[minKey] || c[defaultKey] > c[maxKey]) {
      throw new Error(`${LOG_PREFIX} ${defaultKey} must lie within [${minKey}, ${maxKey}]`);
    }
  }
}

/** 语言字段的合法取值域（需求 §5.3）。 */
const UI_LANG_VALUES = new Set(['auto', 'zh', 'en']);
const AGENT_LANG_VALUES = new Set(['en', 'zh']);

/** 待答座位枚举的合法取值域（需求 §5.2）。 */
const ASK_UI_SEAT_VALUES = new Set(['overlay', 'sidebar']);

/**
 * 解析并自检配置。违例直接抛（fail-fast，设计 §5.1）。
 *
 * 双向解包（见模块头）：入口 `materializeConfig` 拆输入侧的 `settings` 子树
 * Ref、`normalizeConfigInput` 把平铺输入归一成根形态，`Config()` 之后拆输出
 * 侧的同一个 Ref——`Schema.resolve` 对 volatile 节点必然包 Ref
 * （`schemastery/lib/index.mjs:265-273`），不拆的话下面的跨字段比较会比
 * Ref 对象而不是数字。逐字段与跨字段校验保留为运行时第二道防线（判据与
 * schema 层 transform 回调同源，设计 §5.1）。
 * @param {object} raw - cordis 传入的配置（`settings` 可能是子树 Ref；平铺
 *   输入等价于 settings 子树内容）。
 * @returns {object} 冻结后的生效配置（全普通值、平铺形状）。
 */
export function resolveConfig(raw) {
  const resolved = Config(normalizeConfigInput(materializeConfig(raw)));
  const settings = unwrapVolatile(resolved.settings);
  const c = {};
  for (const key of SETTING_FIELD_KEYS) c[key] = settings[key];
  if (resolved.toolName !== undefined) c.toolName = resolved.toolName;
  // 行身份归属与 toolName 同款搬运（非 volatile 的行身份字段，设计 §6.2）。
  if (resolved.owningPreset !== undefined) c.owningPreset = resolved.owningPreset;
  // 委托行级键搬运，约束按本包实际口径（需求 §2.3.1，设计 §3.3）：允许集合
  // 不重复；agentPreset 含于允许集合的校验仅在允许集合在场时执行。
  // 物化怪癖折回：无键的 agentOptions＝未配置（不携带、父继承交宿主侧）。
  // allowedAgentPresets 的声明（`.min(1).default(void 0)`，见 Config 注释）
  // 使解析结果要么缺席（undefined）要么非空——显式空数组与空串元素在
  // schema 层即被原生同形拒绝。原料层的可读拒绝（词典文案）在
  // `lib/settings.js` 的 internal/config 监听（设计 §5.1）。
  if (resolved.agentOptions !== undefined && Object.keys(resolved.agentOptions).length > 0) {
    c.agentOptions = resolved.agentOptions;
  }
  if (resolved.allowedAgentPresets !== undefined) {
    const presets = resolved.allowedAgentPresets;
    if (new Set(presets).size !== presets.length) {
      throw new Error(`${LOG_PREFIX} allowedAgentPresets contains duplicate preset ids`);
    }
    c.allowedAgentPresets = presets;
    if (resolved.agentPreset !== undefined && !presets.includes(resolved.agentPreset)) {
      throw new Error(`${LOG_PREFIX} agentPreset must be included in allowedAgentPresets`);
    }
  }
  if (resolved.agentPreset !== undefined) c.agentPreset = resolved.agentPreset;
  for (const key of POSITIVE_KEYS) assertPositive(c[key], key);
  assertCrossFieldOrder(c);
  // 布尔开关类型检查（apply 自检通道＝`snapshotFromConfig`→本函数；判据与
  // transform 回调同源）：启动时已损坏的持久布尔值在这里抛错 → 装配侧走既有
  // 降级（合法默认运行、describe 显示原始非法值、修复入口不死），而不是被
  // 字段 schema 拦死在装配 resolve。文案与回调形逐字一致（对账测试锁定）。
  for (const key of FLAG_FIELD_KEYS) {
    if (typeof c[key] !== 'boolean') {
      throw new Error(`${LOG_PREFIX} type violation: ${key} must be a boolean, got ${typeof c[key]} ${renderFlagCandidate(c[key])}`);
    }
  }
  // 开关归一（需求 §5.1）保留为降级快照的最后防线：上方类型检查已保证走到
  // 这里的只有布尔，归一只收尾冻结输出形状（三处消费点仍写 `=== true`，
  // 布尔三值不外漏）；非法输入的拒绝职责在写入判据组与自检，不在归一。
  c.silentFailureGuard = c.silentFailureGuard === true;
  // 提问接管开关同款归一（需求 §4.1）：默认关。
  c.askTakeover = c.askTakeover === true;
  // 座位枚举值域（需求 §5.2：overlay | sidebar，fail-fast 与语言字段同款）。
  if (!ASK_UI_SEAT_VALUES.has(c.askUiSeat)) {
    throw new Error(`${LOG_PREFIX} askUiSeat must be "overlay" or "sidebar", got ${JSON.stringify(c.askUiSeat)}`);
  }
  // 语言字段值域校验（英文文案：会经 execute 路径到达模型）。
  if (!UI_LANG_VALUES.has(c.uiLang)) {
    throw new Error(`${LOG_PREFIX} uiLang must be one of "auto" | "zh" | "en", got ${JSON.stringify(c.uiLang)}`);
  }
  if (!AGENT_LANG_VALUES.has(c.agentLang)) {
    throw new Error(`${LOG_PREFIX} agentLang must be "en" or "zh", got ${JSON.stringify(c.agentLang)}`);
  }
  if (typeof c.jobKind !== 'string' || c.jobKind.length === 0) {
    throw new Error(`${LOG_PREFIX} jobKind must be a non-empty string`);
  }
  // subagentProvider：trim 后为空 → 回默认（与 jobKind 的"抛"有意不同，见字段注释）。
  const providerName = typeof c.subagentProvider === 'string' ? c.subagentProvider.trim() : '';
  c.subagentProvider = providerName === '' ? DEFAULT_SUBAGENT_PROVIDER : providerName;
  return Object.freeze(c);
}

/**
 * 解析 settings 子树的已解析值，**不做跨字段自检**（设计 §5.1 降级基线的取值
 * 通道）：降级基线＝降级时刻自检失败的那份已解析 `settings` 值——schema 解析
 * 有确定性（同一 raw 再解析给回调同一输入），基线比较因此落在已解析值上，
 * loader 的 simplify 最小形状写回不产生假差异。
 *
 * 跨字段违例的值过 `resolveConfig` 会抛错，这里要在不抛的前提下拿到同一份
 * 已解析值：临时换容忍回调 → `Config()` → 还原回调（三步同批同步完成，宿主
 * 的 resolve 不在这段内发生）。逐字段值域（schema 层 `.min`／`.max`）违例仍会
 * 抛——那种值本来就到不了降级路径（行装配直接失败，回调三形都救不了）；
 * 布尔开关字段是 any 透传，候选原值（含非布尔）完整进入基线——降级态的
 * 等值重放比较因此对非法布尔同样成立。
 * @param {object} raw - cordis 传入的配置（`settings` 可能是子树 Ref）。
 * @returns {object} 17 键普通值的已解析 settings 子树。
 */
export function resolveSettingsValue(raw) {
  const savedCallback = SETTINGS_NODE.callback;
  SETTINGS_NODE.callback = tolerantSettingsCallback;
  try {
    const resolved = Config(normalizeConfigInput(materializeConfig(raw)));
    const settings = unwrapVolatile(resolved.settings);
    const out = {};
    for (const key of SETTING_FIELD_KEYS) out[key] = settings[key];
    return out;
  } finally {
    SETTINGS_NODE.callback = savedCallback;
  }
}

/**
 * 夹紧 `async_run` 的首次等待预算。
 * @param {number|undefined} requested - 模型传入的 yield_ms。
 * @param {object} c - 生效配置。
 * @returns {number} 预算毫秒数。
 */
export function resolveYield(requested, c) {
  return clamp(requested, c.defaultYieldMs, c.minYieldMs, c.maxYieldMs);
}

/**
 * 夹紧单次等待预算。`async_wait_job` / `async_wait_agent` 的 `wait_ms` 是必填参数（需求 §2.1.1），
 * 因此缺省时抛错而非静默取默认值——"忘了填"必须被模型看见。错误文案经 execute
 * 路径到达模型，按 `agentLang` 取双语表（需求 §5.3：中文档不得静默漏出英文）。
 * @param {number|undefined} requested - 模型传入的 wait_ms。
 * @param {object} c - 生效配置。
 * @returns {number} 预算毫秒数。
 */
export function resolveWait(requested, c) {
  if (requested === undefined || requested === null) {
    throw new Error(t(c.agentLang, 'error.waitRequired', {
      minWaitMs: c.minWaitMs, maxWaitMs: c.maxWaitMs
    }));
  }
  return clamp(requested, c.defaultWaitMs, c.minWaitMs, c.maxWaitMs);
}
