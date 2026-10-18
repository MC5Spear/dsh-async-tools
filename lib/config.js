/**
 * 配置 schema、默认值与夹紧函数。
 *
 * 设计依据：需求 §5.1/§5.2 与设计 §5.1。数字体系遵循需求 §5.2，不得自创。
 * ## 两处形态要点
 *
 * 1. **单一 `Config`**。设置表单来自
 *    **entry Config 的 volatile 字段**（`dsh-settings` 的 `volatileForm` 只暴露
 *    `.volatile()` 字段），且 `configEditor.entries()` 只收根 include 树的条目
 *    （`dsh-config-editor/lib/index.js:30-35`）——预设子树的工具行**不产生
 *    表单**。
 * 2. **volatile 双向解包**。schemastery 的 `Schema.resolve` 对 volatile 字段
 *    **总是**把结果包进 `createVolatile` Ref（`schemastery/lib/index.mjs:265-273`），
 *    而 `resolve` 又**不解包**输入侧的 Ref（`isVolatile` 只在 `simplify` 里用，
 *    `:178`）。于是 `resolveConfig` 必须两头拆：
 *    - 入口先把 loader 给的 `ctx.config`（volatile 字段是活 Ref）拆成普通值，
 *      否则内层 `z.number()` 收到对象直接抛 "expected number"；
 *    - `Config()` 调用后再拆一次，输出的预算字段才会是普通数字。
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

/** 本包可注册的五个工具名（第四个是 async_agent，需求 §2.3；第五个是
 *  async_workflow——delegation 组内行，需求 §2.4）。 */
export const TOOL_NAMES = Object.freeze(['async_run', 'async_wait_job', 'async_wait_agent', 'async_agent', 'async_workflow']);

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
 * 把 loader 交给插件的 `ctx.config` 物化成普通值对象（入口侧解包，设计 §5.1）。
 *
 * 只拆**已知键**：未知键按 schemastery 语义原样透传，不猜。
 * @param {object|undefined} raw - 行配置（volatile 字段可能是 Ref）。
 * @returns {object} 全普通值的配置对象。
 */
export function materializeConfig(raw) {
  const plain = { ...(raw ?? {}) };
  for (const key of Object.keys(BUDGET_FIELDS)) {
    if (key in plain) plain[key] = unwrapVolatile(plain[key]);
  }
  for (const key of Object.keys(LANG_FIELDS)) {
    if (key in plain) plain[key] = unwrapVolatile(plain[key]);
  }
  for (const key of Object.keys(FLAG_FIELDS)) {
    if (key in plain) plain[key] = unwrapVolatile(plain[key]);
  }
  for (const key of Object.keys(ASK_FIELDS)) {
    if (key in plain) plain[key] = unwrapVolatile(plain[key]);
  }
  return plain;
}

/**
 * 预算与运行参数字段表（`toolName` 之外的全部）。
 *
 * ## 每个字段都 `.volatile()`（设计 §5.1）
 *
 * volatile 字段经设置页提交时走 loader 的**就地提交**（fiber 不重启），只向本 fiber
 * 派发 `'loader/volatile-update'`（`cordis-plugin-loader/lib/index.js:393-425`）。
 * 宿主行据此刷新模块级活快照（`lib/settings.js`）。`toolName` **刻意不加**：
 * 它是行级选择（这一行注册哪个工具），改它本来就该换一行配置，不该热改。
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
  defaultYieldMs: z.number().min(FIELD_MIN.defaultYieldMs).max(FIELD_MAX.defaultYieldMs).default(20000).volatile(),
  minYieldMs: z.number().min(FIELD_MIN.minYieldMs).max(FIELD_MAX.minYieldMs).default(1000).volatile(),
  maxYieldMs: z.number().min(FIELD_MIN.maxYieldMs).max(FIELD_MAX.maxYieldMs).default(600000).volatile(),

  /** `async_wait_job` / `async_wait_agent` 的默认与边界。 */
  defaultWaitMs: z.number().min(FIELD_MIN.defaultWaitMs).max(FIELD_MAX.defaultWaitMs).default(30000).volatile(),
  minWaitMs: z.number().min(FIELD_MIN.minWaitMs).max(FIELD_MAX.minWaitMs).default(250).volatile(),
  maxWaitMs: z.number().min(FIELD_MIN.maxWaitMs).max(FIELD_MAX.maxWaitMs).default(600000).volatile(),

  /** `async_wait_agent` 的备用状态轮询间隔（需求 §5.2；受 maxWaitMs 配对约束）。 */
  pollIntervalMs: z.number().min(FIELD_MIN.pollIntervalMs).max(FIELD_MAX.pollIntervalMs).default(500).volatile(),

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
  maxResultChars: z.number().step(1).min(FIELD_MIN.maxResultChars).max(FIELD_MAX.maxResultChars).default(30000).volatile(),

  /**
   * 作业种类名。非空：空串会让作业在注册表里没有可辨识的 kind，
   * 出问题时 `job_list` / 日志里都认不出它。
   */
  jobKind: z.string().min(1).default(DEFAULT_JOB_KIND).volatile(),

  /**
   * `async_agent` 的子代理后端名（需求 §2.3.1）。**空串回默认 `'spawn'`**——
   * 与 `jobKind` 空串抛错的策略**有意不同**：jobKind 是
   * 标识符键（拼进注册表的 kind，坏值静默错位，故抛）；provider 名无效只能在
   * **执行时**对着注册表报可读错误（注册表在宿主侧且可变，schema 里枚举会过期），
   * 空串回默认让"没配"等价"用 spawn"。schema 层因此**不设** `.min(1)`。
   */
  subagentProvider: z.string().default(DEFAULT_SUBAGENT_PROVIDER).volatile()
};

/**
 * 语言字段表（需求 §5.3）：与预算字段**分开**的一组 volatile 字段。
 *
 * `uiLang` 属展示侧（`client.js` 的词典选择，`"auto"` 跟随宿主语言）；
 * `agentLang` 管 Agent 侧（五个工具的模型可见文案）。
 *
 * 值域用 `z.union` 字面量集合（需求 §5.2 的枚举表）：**不带 `.loose()`**——
 * 设置网关按 schema 逐字段校验写入，枚举外的值（如 `uiLang: 'fr'`）必须在
 * 写入那一刻被拒绝并给原因（需求 §5.1「非法新输入拒绝并给原因」）；加了
 * loose 会静默收敛，写入方看到的是"成功但值变了"，正是要拦的形态。代价：
 * 手改 profile 落进的枚举外垃圾值会让整份 `Config()` 解析失败（loader 行级
 * 报错、可见可修）——这与布尔开关用 `.loose()` 收敛的取舍不同：垃圾布尔
 * 收敛到"关"是失效安全方向，而垃圾语言值没有安全的收敛目标（静默回落
 * 会让"我明明选了中文"变成无法诊断的错觉）。`resolveConfig` 的值域检查
 * 保留为运行侧第二级防线（`!!js` 表达式等经 loader 求值后才到那里）。
 */
const LANG_FIELDS = {
  uiLang: z.union(['auto', 'zh', 'en']).default('auto').volatile(),
  agentLang: z.union(['en', 'zh']).default('en').volatile()
};

/**
 * 开关字段表（需求 §6.3）：静默失败三防线的**唯一**总开关，默认关。
 *
 * volatile：与预算/语言字段同一条就地提交链（设计 §5.1）——设置卡保存后不重启，
 * 三处消费点（a 结果 note / b 描述警示段 / c 常驻纪律段）都按各自时点的
 * 活快照现读（后台作业在结算时刻读，设计 §6.2）。默认关：
 * 三防线必须能用行为差异证明"关 = 不存在"。
 */
const FLAG_FIELDS = {
  /**
   * 静默失败陷阱三防线总开关。
   *
   * `.loose()`（落盘垃圾值一律收敛到关，需求 §5.1）：schemastery 的 boolean 校验器
   * 对非布尔**抛 ValidationError**——不加 loose，手改 profile 写进来的垃圾值会让整个
   * `Config()` 解析失败（预算/语言字段一起陪葬），而不是"收敛到关"。loose 的语义恰好
   * 是"校验失败 → 静默取 default"（`@deepseek-ai/schemastery` resolve 的 catch 分支），
   * 失效安全方向与默认一致；`resolveConfig` 末端的 `=== true` 归一仍是最后一级收尾。
   */
  silentFailureGuard: z.boolean().default(false).loose().volatile(),

  /**
   * 提问接管总开关（需求 §4.1，默认关 = 零行为变化）。
   *
   * 与 `silentFailureGuard` 同款 `.loose()` + `=== true` 归一：落盘垃圾值收敛到关，
   * 失效安全方向与默认一致。消费点在 `lib/ask-takeover.js` 的判定序——每次提问
   * **请求时刻活读**快照（不是构造快照，需求 §5.1），首问后翻开关立即生效。
   */
  askTakeover: z.boolean().default(false).loose().volatile()
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
  askTimeoutMs: z.number().min(FIELD_MIN.askTimeoutMs).max(FIELD_MAX.askTimeoutMs).default(60000).volatile(),
  askExtendMs: z.number().min(FIELD_MIN.askExtendMs).max(FIELD_MAX.askExtendMs).default(60000).volatile(),
  askUiSeat: z.union(['sidebar', 'overlay']).default('sidebar').volatile()
};

/**
 * 唯一的行配置 schema。
 *
 * `toolName` 只属于**行配置**，不属于设置表单：它不是 volatile，`volatileForm`
 * 不暴露它（`dsh-settings/lib/index.js:118-131`），设置页永远看不到也改不了它。
 */
export const Config = z.object({
  /**
   * 本插件实例注册哪一个工具；**缺省 = 宿主角色**。
   * 一个包被引用多次、各自注册一个工具，是 shipped 预设里 `tool-subagent` 的成例。
   *
   * - 行配置里**有** `toolName` → 工具角色（预设顶层的四行加 delegation 组内一行，各注册一个工具）；
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
   * 用途：描述警示（`lib/descriptions.js`）按行配置**归属声明**判定——静态
   * 描述读不到会话上下文，只能靠这个非会话字段。与 `toolName` 同款纪律：
   * **不能 `.required()` 也不能 `.default()`**——自定义行合法地没有归属，
   * 缺省它才让防护描述不出现；刻意抄上归属声明的自定义行 = 显式选择加入。
   * 不属 volatile：设置表单不暴露，volatile 提交改不了行身份。
   */
  owningPreset: z.string(),

  ...BUDGET_FIELDS,

  ...LANG_FIELDS,

  ...FLAG_FIELDS,

  ...ASK_FIELDS
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
 * 双向解包（见模块头）：入口 `materializeConfig` 拆输入 Ref，
 * `Config()` 之后拆输出 Ref——`Schema.resolve` 对 volatile 字段必然包 Ref
 * （`schemastery/lib/index.mjs:265-273`），不拆的话下面的跨字段比较会比
 * Ref 对象而不是数字。
 * @param {object} raw - cordis 传入的配置（volatile 字段可能是 Ref）。
 * @returns {object} 冻结后的生效配置（全普通值）。
 */
export function resolveConfig(raw) {
  const resolved = Config(materializeConfig(raw));
  const c = {};
  for (const key of Object.keys(BUDGET_FIELDS)) c[key] = unwrapVolatile(resolved[key]);
  for (const key of Object.keys(LANG_FIELDS)) c[key] = unwrapVolatile(resolved[key]);
  for (const key of Object.keys(FLAG_FIELDS)) c[key] = unwrapVolatile(resolved[key]);
  for (const key of Object.keys(ASK_FIELDS)) c[key] = unwrapVolatile(resolved[key]);
  if (resolved.toolName !== undefined) c.toolName = resolved.toolName;
  // 行身份归属与 toolName 同款搬运（非 volatile 的行身份字段，设计 §6.2）。
  if (resolved.owningPreset !== undefined) c.owningPreset = resolved.owningPreset;
  for (const key of POSITIVE_KEYS) assertPositive(c[key], key);
  assertCrossFieldOrder(c);
  // 开关归一（需求 §5.1）：只有字面 true 才算开——垃圾值/缺省一律关。
  // 三处消费点都写 `=== true`，这里归一是为了冻结输出形状稳定（布尔三值不外漏）。
  c.silentFailureGuard = c.silentFailureGuard === true;
  // 提问接管开关同款归一（需求 §4.1）：默认关，垃圾值收敛到关。
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
