window.__ModuleLoader__.load({ id: "dsh-async-tools", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
// 异步工具的设置卡片（浏览器半边，设计 §5.1/§5.3；表单本体用官方共享控件）。
//
// ## 形态要点（设计 §5.1/§5.3，需求 §5.4）
//
// - 注册进插件管理页的 **`plugins.bundle.config`** keyed 槽，槽键 = **包名**
//   = `dsh-async-tools`；宿主把它渲染在插件页的描述与组件行之间。
//   `view:"page"` 渲染表单本体；卡片壳（标题/图标/面包屑/折叠）由宿主画。
// - 表单**由官方控件组装**：`SettingsForm` 出框架（只读/不可用通告、
//   页脚唯一的保存按钮及其启用条件、卸载丢弃草稿），暂存/差集/保存全部由
//   `SettingsFormModel` 承担——本包不自绘草稿、差集与写后回读。primitives 在
//   冻结平台模块表里，直接 `require` 即可，`dsh.client.external` 一条都不用加。
// - 字段壳统一自绘（设计 §5.5）：17 个字段共用 `FieldShell`——官方
//   `SettingsValueField` 的帮助图标固定带圈 i、标签行没有注入开口（需求 5.6 要
//   带圈问号），所以值字段也转入统一壳；官方件继续在场：`SettingsForm`／
//   `SettingsFormModel`／`settingsNumberField`／`settingsTextField`（模型 spec）、
//   `P.Switch`／`P.Tag`／`P.IconQuestionOutlineRegular`（控件本体与图标）。
// - 模型的 scope = `ctx.configForms.get(ENTRY)` 的控制器（控制器就是官方
//   `SettingsFormScope`——`getSnapshot`/`subscribe`/`mutate`）。bundle 槽的 owner props
//   只有 `{view}`、没有 `form`，所以卡片自取控制器；模型在构造时订阅 scope，
//   组件经 `model.bind(...)` 的快照存储 + `useSyncExternalStore` 重渲染（bind 只调一次）。
// - 枚举字段（uiLang/agentLang/askUiSeat）与布尔字段（silentFailureGuard/
//   askTakeover）：语义注册进模型（`enumFieldSpec`/`flagFieldSpec` 形状同
//   `SettingsFieldSpec`），控件本体分别是原生 select 与官方 `P.Switch`，壳与帮助
//   由 `FieldShell` 统一承担（设计 §5.5 的两条强制条目：无覆盖时下拉显示**生效值**；
//   label `for`/控件 `id` 绑定 + `aria-describedby`/`aria-invalid`；布尔开关的
//   可见标签在壳上，`Switch.label` 只作无障碍名）。
// - 帮助（需求 5.5/5.6）：每个字段标签旁带圈问号按钮（官方
//   `IconQuestionOutlineRegular`），点击在字段下方展开 `help.<键>` 正文、再点收起；
//   开合只存 `FieldShell` 局部 state，不碰草稿/保存/mutate；缺键回退＝按钮/说明行
//   退场（`resolveCopy`），T21 在场断言守 17×3 键组两档齐全。
// - 毫秒字段的秒数读数（需求 §5.4）长在说明行里，
//   **与字段说明换行**（行首不带点，样式照同机参考插件的读数行）：说明行 =
//   字段说明 + 换行 + 「生效：S s」+「 · 」+「输入：T s」。值**只写秒文本**
//   （`600 s` / `0.5 s` / 亚 10 ms 的 `< 0.01 s` / 空草稿的 `—`；整数秒无小数、
//   非整数最多两位）——毫秒原值输入框里本来就有；生效段恒显示，输入段未保存就
//   随键入刷新，非数字/非正数时输入段标非法类、由字段外壳另加非法原因行
//   （`composeHint` 单点承担读数与非法判定；常驻说明与两段读数保留）。
// - 保存语义：一个「保存」按钮，`!dirty || invalid || saving` 时禁用，
//   保存中显示「保存中…」；模型 `save()` 一次 `mutate(ops, baseline.revision)`，
//   布尔为假即 `failed` 并保留草稿，失败文案由官方页脚渲染；离开页面 = 卸载 =
//   丢弃草稿。成功不弹文案；字段由活 section 值回填，谎报成功没有藏身处。
//
// ## 形态约束
//
// - 本文件是 `window.__ModuleLoader__.load({ id, factory })` 的 **CJS 包裹**，顶层不得
//   出现 ESM 语法；UI 全部 `React.createElement`，无 JSX（浏览器侧没有转译器）。
// - 自有样式（统一字段壳、select/input 本体与帮助按钮）只引用 `--dsw-alias-*`
//   里**被定义**的名字（定义表 = theme 包运行时；`tools/check-alias-tokens.mjs`
//   守这条），错误色一律 `--dsw-alias-state-error-primary`。失败文案的颜色跟随
//   官方 `.failed`（它引用的 `label-error` 未定义、落继承色是官方现行行为，
//   本包不复制其颜色引用）。
var React = require("react");
var P = require("@deepseek-ai/dsh-client-ui-primitives");

/** 本插件的宿主行 id = 设置命名空间 = async-tools-host。若将来注册
 *  plugins.row.config，其键形 <包名>#<行 id> 的行 id 段须与此同串。 */
var ENTRY = "async-tools-host";
/** 包名（**平名**——客户端模块图只投递平名包）；槽键 = 包名。 */
var PACKAGE_NAME = "dsh-async-tools";
/** 词典命名空间（本插件自有）。 */
var NS = "settings.async-tools";

// 字段表：key 与宿主 Config 的 settings 子树字段一一对应（设计 §5.1：19 个
// 可编辑字段全在子树里，值投影展平在 `settings` 键下，经 makeSettingsScopeView
// 适配成官方模型的平铺寻址）；ms 字段的说明行带秒数读数。
// 顺序 = `lib/config.js` 五组键的拼接：BUDGET_FIELD_KEYS → LANG_FIELD_KEYS →
// FLAG_FIELD_KEYS → DISPLAY_FIELD_KEYS → ASK_FIELD_KEYS（提问接管组殿后；与
// test/two-planes.test.mjs T19 的键集对账，静默失败与两个展示开关字段在列）。
// `toolName` 不在表里（它在根的非 volatile 固定路径，不可用户写——写会被宿主拒绝
// `Config field "toolName" is not volatile`，`dsh-settings/lib/index.js:507`），
// 这正是「volatile 子树才可编辑」语义的正确表达。
var FIELDS = [
  { key: "defaultYieldMs", label: "defaultYieldMs", ms: true },
  { key: "minYieldMs", label: "minYieldMs", ms: true },
  { key: "maxYieldMs", label: "maxYieldMs", ms: true },
  { key: "defaultWaitMs", label: "defaultWaitMs", ms: true },
  { key: "minWaitMs", label: "minWaitMs", ms: true },
  { key: "maxWaitMs", label: "maxWaitMs", ms: true },
  { key: "pollIntervalMs", label: "pollIntervalMs", ms: true },
  { key: "maxResultChars", label: "maxResultChars", ms: false },
  { key: "jobKind", label: "jobKind", ms: false },
  { key: "subagentProvider", label: "subagentProvider", ms: false },
  // 两个语言开关：注册进模型的枚举 spec，控件本体是自绘 select。
  { key: "uiLang", label: "uiLang", ms: false, options: ["auto", "zh", "en"] },
  { key: "agentLang", label: "agentLang", ms: false, options: ["en", "zh"] },
  // 静默失败防线总开关：volatile 布尔（默认 false = 三防线全不存在）。
  // 壳照统一 FieldShell，控件本体是官方原生 Switch。
  { key: "silentFailureGuard", label: "silentFailureGuard", ms: false, flag: true },
  // 提问接管四字段（需求 §5.2/设计 §4.2）：总开关默认关 = 零行为；窗口毫秒带秒读数
  // 与上下界（10000–600000）；延长毫秒带秒读数与上下界（1–2^31-1，设计 §4.2）；
  // 座位枚举 sidebar|overlay 只换呈现层，选项序 [sidebar, overlay] 与默认标记位
  // （需求 §5.2/5.5：默认 sidebar）。
  { key: "askTakeover", label: "askTakeover", ms: false, flag: true },
  // 两个展示开关（需求 9.3.4）：默认 false = 编排结果滤除各阶段进度行、
  // 命令作业列表只回显进度说明；开启保留/回显完整内容。
  { key: "workflowProgressLog", label: "workflowProgressLog", ms: false, flag: true },
  { key: "fullCommandEcho", label: "fullCommandEcho", ms: false, flag: true },
  { key: "askTimeoutMs", label: "askTimeoutMs", ms: true },
  { key: "askExtendMs", label: "askExtendMs", ms: true },
  { key: "askUiSeat", label: "askUiSeat", ms: false, options: ["sidebar", "overlay"] }
];
var FIELD_KEYS = FIELDS.map(function (field) { return field.key; });
/** 语言开关的键：`uiLang` 管本卡片文案，`agentLang` 管面向模型的文案（需求 §5.3）。 */
var LANG_KEYS = ["uiLang", "agentLang"];

/** 数字字段 = `MS_FIELD_KEYS` 的毫秒字段 + `maxResultChars`（`numeric` 只提示键盘，合法性由 spec 定）。 */
function isNumericField(field) {
  return field.ms === true || field.key === "maxResultChars";
}

/**
 * 卡片层的预算上界常量（需求 §5.2）：与 `lib/budget-limits.js`
 * 同组的上界/配对常量——客户端模块图只投递平名包（见文件头形态约束），**引不到
 * lib/ 下的文件**，只能内联同值；`test/two-planes.test.mjs`（T23c）的对账断言钉住
 * 两处相等，只改一处必红。
 */
var MS_FIELD_LIMIT = 2147483647;
var RESULT_CHARS_LIMIT = 1000000;
/** `askTimeoutMs` 的界（需求 §5.2：下界 10 s / 上界 10 min，与宿主 schema 同值）。 */
var ASK_TIMEOUT_LIMIT = 600000;
/** 设计 §4.2：`askExtendMs` 的上界（与服务端到期分段的单段上限同值）。 */
var ASK_EXTEND_LIMIT = 2147483647;
var FIELD_MAX = {
  defaultYieldMs: MS_FIELD_LIMIT,
  minYieldMs: MS_FIELD_LIMIT,
  maxYieldMs: MS_FIELD_LIMIT,
  defaultWaitMs: MS_FIELD_LIMIT,
  minWaitMs: MS_FIELD_LIMIT,
  maxWaitMs: MS_FIELD_LIMIT,
  pollIntervalMs: MS_FIELD_LIMIT,
  maxResultChars: RESULT_CHARS_LIMIT,
  askTimeoutMs: ASK_TIMEOUT_LIMIT,
  askExtendMs: ASK_EXTEND_LIMIT
};
/** 卡片层下界（设计 §5.4：全部数值字段的下界表——毫秒预算字段与 `maxResultChars`
 * 为 1，`askTimeoutMs` 为 10000；T23c 对账含上界）。 */
var FIELD_MIN = {
  defaultYieldMs: 1,
  minYieldMs: 1,
  maxYieldMs: 1,
  defaultWaitMs: 1,
  minWaitMs: 1,
  maxWaitMs: 1,
  pollIntervalMs: 1,
  maxResultChars: 1,
  askTimeoutMs: 10000,
  askExtendMs: 1
};

/**
 * 数值字段的越界 spec：包装官方 `settingsNumberField`——官方 parse 只验
 * 有限性，上界在这里补。parse 返回 `undefined` 走**官方非法通道**
 * （plan 聚合 → `state.invalid` → 保存按钮禁用），这是宿主 SettingsForm 唯一认的
 * 因果链（字段 props 的 `invalid` 只进显示层，不回流 shell）。
 */
var INTEGER_FIELDS = { maxResultChars: true };
function boundedNumberSpec(key) {
  var base = P.settingsNumberField(key);
  var max = FIELD_MAX[key];
  var min = FIELD_MIN[key];
  var intOnly = INTEGER_FIELDS[key] === true;
  return {
    field: key,
    format: base.format,
    parse: function (text) {
      var parsed = base.parse(text);
      if (parsed !== undefined && parsed.kind === "set"
        && typeof parsed.value === "number") {
        // 整数字段（maxResultChars——字符数按 String.length 计量，必须是正整数，
        // 需求 §5.2）：小数草稿同样按非法处理，走官方非法通道（保存禁用）；
        // 服务端 schema 的 `.step(1)` 是同一约束的第二层。
        if (intOnly && !Number.isInteger(parsed.value)) return undefined;
        if (parsed.value > max) return undefined;
        if (min !== undefined && parsed.value < min) return undefined;
      }
      return parsed;
    }
  };
}

/** 草稿数字（两字段都在场才判配对；空/非法草稿返回 null，不参与比较）。 */
function draftNumber(state, key) {
  var entry = state.fields === undefined ? undefined : state.fields[key];
  var text = entry !== undefined && typeof entry.text === "string" ? entry.text.trim() : "";
  if (text === "") return null;
  var parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 跨字段链式不等式（设计 §5.4）：与 `lib/budget-limits.js` 的 `CHAIN_INEQUALITIES`
 * 同组常量——客户端模块图只投递平名包（见文件头形态约束），引不到 lib/ 下的
 * 文件，只能内联同值；`test/two-planes.test.mjs`（T23c）的对账断言钉住两处
 * 相等。每对 `[leftKey, rightKey]` 要求 `left <= right`；链式键按左值字段扩展。
 */
var CHAIN_PAIRS = [
  ["minYieldMs", "defaultYieldMs"],
  ["defaultYieldMs", "maxYieldMs"],
  ["minWaitMs", "defaultWaitMs"],
  ["defaultWaitMs", "maxWaitMs"],
  ["pollIntervalMs", "maxWaitMs"]
];

/**
 * 链式比较值（设计 §5.4）：**草稿优先，无草稿用生效值**——覆盖草稿与生效值的任意
 * 组合（只判一侧草稿会把"把上限改小"漏成可保存）。空/非法草稿且无生效值 →
 * null，该侧不参与比较。
 */
function chainNumber(state, key) {
  var draft = draftNumber(state, key);
  if (draft !== null) return draft;
  var source = state.effective === undefined || state.effective === null ? {} : state.effective;
  var effective = source[key];
  return typeof effective === "number" && Number.isFinite(effective) ? effective : null;
}

/**
 * 跨字段链式违例（设计 §5.4）。parse 通道做不了跨字段（单字段解析时看不见别的字段）
 * ——判在壳层：`makeBundleCard` 把违例叠加进传给 `SettingsForm` 的
 * `state.invalid`（保存按钮随之禁用，草稿不外发），同时在不等式**左值**字段
 * 的显示层给原因文案（文案指明参照字段）。
 */
function pairViolated(state) {
  for (var i = 0; i < CHAIN_PAIRS.length; i += 1) {
    var left = chainNumber(state, CHAIN_PAIRS[i][0]);
    var right = chainNumber(state, CHAIN_PAIRS[i][1]);
    if (left !== null && right !== null && left > right) return true;
  }
  return false;
}

/** 该字段作为左值命中的链式违例（设计 §5.4）：命中返回右值键（参照字段），未命中
 * 返回 null——原因文案挂左值字段，`{ref}` 占位替换为参照字段名。 */
function chainHitOf(state, key) {
  for (var i = 0; i < CHAIN_PAIRS.length; i += 1) {
    if (CHAIN_PAIRS[i][0] !== key) continue;
    var left = chainNumber(state, key);
    var right = chainNumber(state, CHAIN_PAIRS[i][1]);
    if (left !== null && right !== null && left > right) return CHAIN_PAIRS[i][1];
  }
  return null;
}

/**
 * 枚举字段的转换 spec：形状同官方 `SettingsFieldSpec`
 * （`form-model.d.ts:65-76`），语义不自绘——暂存、覆盖态与校验仍走模型。
 *
 * `format` 把生效值原样作为草稿文本（无覆盖时快照的 `value` 层就是生效值 ⇒ 下拉显示
 * 生效值而不是空选项——空态即缺陷形态）；`parse` 把空草稿判清除、
 * 命中选项判写值、其余判非法（非法草稿阻止保存而不是被丢弃）。
 *
 * @param {string} key - 字段键。
 * @param {string[]} options - 枚举选项（与宿主 Config 的枚举一致）。
 * @returns {object} `SettingsFieldSpec` 形状的 spec。
 */
function enumFieldSpec(key, options) {
  return {
    field: key,
    format: function (value) {
      return typeof value === "string" && options.indexOf(value) !== -1 ? value : "";
    },
    parse: function (text) {
      var trimmed = text.trim();
      if (trimmed === "") return { kind: "clear" };
      return options.indexOf(trimmed) !== -1 ? { kind: "set", value: trimmed } : undefined;
    }
  };
}

/**
 * 布尔字段的转换 spec：形状与语义同 `enumFieldSpec`，只是值域是
 * `"true" | "false"` 两态映射到 volatile 布尔。
 *
 * `format`：生效值 `true` → `"true"`，其余（false/undefined/非布尔）→ `"false"`
 * ——无覆盖时快照的 `value` 层就是生效值，开关的"无值"语义与"关"相同（默认 false），
 * 下拉/开关显示生效姿态而不是空态。`parse`：`"true"`/`"false"` 判写值（显式写
 * false 也是用户覆盖 → 徽标亮），空草稿判清除（回到组合/默认层），其余判非法。
 *
 * @param {string} key - 字段键。
 * @returns {object} `SettingsFieldSpec` 形状的 spec。
 */
function flagFieldSpec(key) {
  return {
    field: key,
    format: function (value) {
      return value === true ? "true" : "false";
    },
    parse: function (text) {
      var trimmed = text.trim();
      if (trimmed === "true") return { kind: "set", value: true };
      if (trimmed === "false") return { kind: "set", value: false };
      if (trimmed === "") return { kind: "clear" };
      return undefined;
    }
  };
}

/**
 * 模型装配：10 个数字字段（官方 `settingsNumberField`——七个毫秒预算 +
 * `maxResultChars` + 提问接管两字段）+ 2 个文本字段（官方 `settingsTextField`）+
 * 3 个枚举字段（本包 `enumFieldSpec`——两个语言开关 + 座位）+ 2 个布尔字段
 * （本包 `flagFieldSpec`——静默失败防线总开关 + 提问接管总开关），合计 17 个
 * 字段。字段键集合必须与 `FIELDS` 逐项相等（卡片装配断言钉住）。
 *
 * @returns {object[]} spec 列表（顺序 = FIELDS 顺序）。
 */
function makeSpecs() {
  var specs = [];
  for (var i = 0; i < FIELDS.length; i += 1) {
    var field = FIELDS[i];
    if (field.flag === true) specs.push(flagFieldSpec(field.key));
    else if (field.options !== undefined) specs.push(enumFieldSpec(field.key, field.options));
    else if (isNumericField(field)) specs.push(boundedNumberSpec(field.key));
    else specs.push(P.settingsTextField(field.key));
  }
  return specs;
}

/**
 * 毫秒 → 秒读数（需求 §5.4）：`20000 → "20 s"`、`1500 → "1.5 s"`、`250 → "0.25 s"`；
 * **亚 10 毫秒的正数显示 `< 0.01 s`**（正数不得读成 `0 s`，也不留空——
 * 逐位键入时不给"读数消失"的错觉）。非有限正数返回空串（调用方决定占位）。
 * @param {number} ms - 毫秒值。
 * @returns {string} 形如 "20 s" / "< 0.01 s" 的读数；无法换算时空串。
 */
function formatSeconds(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 10) return "< 0.01 s";
  var s = ms / 1000;
  var trimmed = Number.isInteger(s) ? s : Number(s.toFixed(2));
  return String(trimmed) + " s";
}

/** 读数占位（空草稿/不可换算）：照同机参考插件的读数行用 `—`。 */
var READOUT_PLACEHOLDER = "—";

/**
 * 输入段读数（三姿态）：正数 → 秒文本；空文本 → `—` 占位；
 * 非数字/非正数（`0`、负数）→ `—` 占位 + 非法标记。非法标记供字段外壳消费
 * （输入段标红、另加非法原因行），常驻说明行与两段读数保留。
 * @param {string} stagedText - 模型暂存文本。
 * @returns {{fill: string, invalid: boolean}} 输入段的值与非法标记。
 */
function draftReadout(stagedText) {
  var text = stagedText === undefined || stagedText === null ? "" : String(stagedText).trim();
  if (text === "") return { fill: READOUT_PLACEHOLDER, invalid: false };
  var seconds = formatSeconds(Number(text));
  if (seconds === "") return { fill: READOUT_PLACEHOLDER, invalid: true };
  return { fill: seconds, invalid: false };
}

/**
 * 文案缺键回退（设计 §5.5）：取值 undefined/空串/等于键名本身（裸键名——宿主
 * 翻译函数对缺失键返回键名）都按缺席处理，返回 undefined。调用方（`composeHint`、
 * `makeFieldNodes` 的帮助正文）据此让说明行/帮助按钮退场，不渲染空段或空区域。
 * @param {Function} t - 文案函数。
 * @param {string} key - 词典键。
 * @returns {string|undefined} 在场文案或 undefined。
 */
function resolveCopy(t, key) {
  var value = t(key);
  if (value === undefined || value === null || value === "" || value === key) return undefined;
  return value;
}

/**
 * 字段说明（毫秒字段带两段秒读数，需求 §5.4）：说明行 =
 * 字段说明**换行**接 `生效：{v} · 输入：{v}`（样式照同机参考插件的读数行：
 * 行首不带点、与字段说明分行；值只写秒文本——毫秒原值输入框里本来就有）。
 * - 生效段恒显示（值 = 生效值 user ?? 组合 ?? 默认）；
 * - 输入段取**模型当前的暂存文本**（未保存就随键入刷新——模型 `edit → publish` 免费给了
 *   重渲染），三姿态见 `draftReadout`；
 * - 两段恒显示（相等也不隐藏——"时而有时而无"会被读成坏了）；非毫秒字段无读数；
 * - 只读态同样渲染（控件禁用，读数仍在）；
 * - 缺键回退（设计 §5.5）：`hint.<键>` 缺席/裸键名时整行退场（含读数），返回 undefined。
 * @param {Function} t - 文案函数。
 * @param {{key: string, ms?: boolean}} field - 字段表项。
 * @param {number} effectiveMs - 生效毫秒值。
 * @param {string} stagedText - 模型当前的暂存文本（未暂存时 = 生效值的格式化）。
 * @returns {string|Array|undefined} 非毫秒字段 = 说明文本；毫秒字段 = 说明行的 children
 *   （`[说明, 换行, 生效段, " · ", 输入段]`）；缺键 = undefined。
 */
function composeHint(t, field, effectiveMs, stagedText) {
  var hint = resolveCopy(t, "hint." + field.key);
  if (hint === undefined) return undefined;
  if (field.ms !== true) return hint;
  var effectiveFill = formatSeconds(effectiveMs);
  var draft = draftReadout(stagedText);
  return [
    hint,
    React.createElement("br", { key: "br" }),
    React.createElement("span", { key: "effective", className: "ats-sec-effective" },
      t("readout.effective").replace("{v}", effectiveFill === "" ? READOUT_PLACEHOLDER : effectiveFill)),
    " · ",
    React.createElement("span", {
      key: "input",
      className: draft.invalid ? "ats-sec-input ats-sec-invalid" : "ats-sec-input"
    }, t("readout.input").replace("{v}", draft.fill))
  ];
}

// 字段壳与自绘控件样式：度量逐项照官方 `fields.module.css`（34px / 13px / 12px 圆角 /
// .5px border-l4 / 禁用 label-tertiary / 非法 state-error-primary / 焦点
// state-business-primary——设计 §5.5 控件焦点与输入件同源），select 的修饰照
// `dsh-client-ui-settings-models` 的成例（appearance:none + 右侧 chevron +
// padding-right:32px）。帮助按钮（设计 §5.5）：24×24 常态可发现（0.5px 轮廓 +
// label-secondary 图标），hover/展开背景用 `interactive-bg-hover`（深浅两主题各有
// 计算值；不用 `bg-layer-*` 族——1/2/3 浅色与底色同值，官方所引 bg-layer-4 在
// 主题定义表中未定义），focus-visible 外廓 2px 与输入件同源。只引用定义表内的
// token（check-alias-tokens 把关）。唯一例外：select 下拉箭头的 SVG data-URI
// 内嵌固定色 %2381858C——data URI 内无法引用 CSS 变量，是本样式块唯一写死色的例外。
var ENUM_CSS = ""
  + ".ats-enum-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}"
  + ".ats-enum-field:not(:first-child){border-top:.5px solid var(--dsw-alias-border-l2)}"
  + ".ats-enum-head{display:flex;align-items:center;gap:8px}"
  + ".ats-enum-labelGroup{display:flex;align-items:center;gap:4px;flex:1;min-width:0}"
  + ".ats-enum-label{flex:0 1 auto;font-size:13px;font-weight:500;line-height:1.5;"
  + "color:var(--dsw-alias-label-primary)}"
  + ".ats-enum-badges{display:inline-flex;align-items:center;gap:8px}"
  + ".ats-enum-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;"
  + "line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}"
  + ".ats-enum-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}"
  + ".ats-enum-reset:disabled{cursor:default}"
  + ".ats-enum-select,.ats-value-input{height:34px;padding:0 12px;"
  + "border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;"
  + "background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;"
  + "color:var(--dsw-alias-label-primary)}"
  + ".ats-enum-select{appearance:none;padding-right:32px;"
  + "background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' "
  + "width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' "
  + "stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E"
  + "%3C/svg%3E\");background-position:right 12px center;background-repeat:no-repeat;"
  + "background-size:12px 12px}"
  + ".ats-enum-select:focus-visible,.ats-value-input:focus-visible{outline:none;"
  + "border-color:var(--dsw-alias-state-business-primary)}"
  + ".ats-enum-select:disabled,.ats-value-input:disabled{color:var(--dsw-alias-label-tertiary);"
  + "cursor:default}"
  + ".ats-enum-select[aria-invalid='true'],.ats-value-input[aria-invalid='true']{"
  + "border-color:var(--dsw-alias-state-error-primary)}"
  + ".ats-help-button{flex:none;display:inline-flex;align-items:center;justify-content:center;"
  + "width:24px;height:24px;padding:0;border:.5px solid var(--dsw-alias-border-l4);"
  + "border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);"
  + "cursor:pointer}"
  + ".ats-help-button:hover:not(:disabled),"
  + ".ats-help-button[aria-expanded='true']:not(:disabled){"
  + "background:var(--dsw-alias-interactive-bg-hover);"
  + "color:var(--dsw-alias-label-primary)}"
  + ".ats-help-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);"
  + "outline-offset:1px}"
  + ".ats-help-region{margin:0;font-size:12px;line-height:1.6;"
  + "color:var(--dsw-alias-label-secondary)}"
  + ".ats-help-region p:not(:last-child){margin:0 0 8px}"
  + ".ats-enum-message{margin:0;font-size:12px;line-height:1.5;"
  + "color:var(--dsw-alias-label-tertiary)}"
  + ".ats-enum-message[aria-invalid='true']{color:var(--dsw-alias-state-error-primary)}"
  // 卸载风险提示块（设计 §5.4）：静态非交互文本，长在表单顶部、全部字段之前；
  // 醒目外壳（需求 §7.2「在设置页醒目提示」）：警示浅底 + 左侧色条 + 三角警示
  // 图标，全部走 warn 态 token（深浅主题均可读），与普通字段说明拉开视觉层级；
  // 宽度随表单列。
  + ".ats-uninstall-risk{display:flex;gap:8px;align-items:flex-start;margin:12px 0 0;"
  + "padding:10px 12px;border-left:3px solid var(--dsw-alias-state-warn-primary);"
  + "border-radius:8px;background:var(--dsw-alias-state-warn-tertiary);"
  + "font-size:12px;line-height:1.5;color:var(--dsw-alias-state-warn-label)}"
  + ".ats-uninstall-risk svg{flex:none;margin-top:1px}"

if (typeof document !== "undefined" && document.getElementById("dsh-async-tools-enum-style") === null) {
  var styleEl = document.createElement("style");
  styleEl.id = "dsh-async-tools-enum-style";
  styleEl.textContent = ENUM_CSS;
  document.head.appendChild(styleEl);
}

/**
 * 统一字段壳（设计 §5.5）：17 个字段共用——label 行（标签 + 带圈问号帮助按钮 +
 * 覆盖徽标）、控件本体、说明/错误行、展开区（仅展开时渲染）。控件本体四形态：
 * 布尔 = 官方 `P.Switch`；枚举 = 原生 select；数值 = input（`inputMode="numeric"`）；
 * 文本 = input。度量逐项照官方 `fields.module.css`（见 ENUM_CSS 头注）。
 *
 * 帮助开合是**组件局部 state**（设计 §5.5 状态隔离）：`useState(false)`，按钮
 * `type="button"`、onClick 只调 `setHelpOpen`——不触碰草稿模型、不动保存、不调
 * mutate。重渲按组件类型 + key 复用，开合状态在草稿键入/保存/语言切换时保留。
 *
 * 缺键回退（设计 §5.5）：`help` 缺席（undefined/空/裸键名）不渲染帮助按钮；
 * `hint` 缺席时说明行（含毫秒读数）整体退场，不渲染空段——宁可少按钮不开空区域。
 *
 * @param {object} props - 字段文案与状态 + 控件形态（`flag`/`options`/`numeric`）。
 * @returns {object} React 元素。
 */
function FieldShell(props) {
  var helpOpenState = React.useState(false);
  var helpOpen = helpOpenState[0];
  var setHelpOpen = helpOpenState[1];
  var messageId = props.id + "-message";
  var invalidId = props.id + "-invalid";
  var helpId = props.id + "-help";
  // 消息区两行并存：非法原因行（红、aria-invalid、独立 id）
  // 是**附加**，不顶掉常驻说明与「生效／输入」读数——§5.4「非法值另给字段原因」
  // 的「另给」＋§5.6「常驻短说明」同时成立，而不是二选一替换。常驻行沿用
  // `-message` id，正常态的 aria-describedby 契约不变；非法态两行都在、
  // described 先指错误行。
  var helpButton = props.help === undefined ? null : React.createElement("button", {
    type: "button",
    className: "ats-help-button",
    "aria-label": props.helpA11y,
    "aria-expanded": helpOpen,
    "aria-controls": helpId,
    onClick: function () { setHelpOpen(!helpOpen); }
  }, React.createElement(P.IconQuestionOutlineRegular, { size: 14 }));
  var described = [
    props.invalid === true ? invalidId : null,
    props.hint !== undefined ? messageId : null,
    helpOpen ? helpId : null
  ].filter(function (part) { return part !== null; }).join(" ");
  var control;
  if (props.flag === true) {
    control = React.createElement(P.Switch, {
      checked: props.text === "true",
      label: props.label,
      disabled: props.disabled,
      onChange: function (next) { props.onEdit(next ? "true" : "false"); }
    });
  } else if (props.options !== undefined) {
    control = React.createElement("select", {
      id: props.id,
      className: "ats-enum-select",
      "aria-invalid": props.invalid === true ? true : undefined,
      "aria-describedby": described === "" ? undefined : described,
      value: props.text,
      disabled: props.disabled,
      onChange: function (event) { props.onEdit(event.target.value); }
    }, props.options.map(function (option) {
      return React.createElement("option", { key: option, value: option },
        props.optionLabel(option));
    }));
  } else {
    control = React.createElement("input", {
      id: props.id,
      className: "ats-value-input",
      inputMode: props.numeric === true ? "numeric" : undefined,
      "aria-invalid": props.invalid === true ? true : undefined,
      "aria-describedby": described === "" ? undefined : described,
      value: props.text,
      disabled: props.disabled,
      onChange: function (event) { props.onEdit(event.target.value); }
    });
  }
  // 元素 key 在父级 createElement 上（makeFieldNodes 传 `key: field.key`）——
  // 真实 React 靠它对 17 个同函数实例做「相同组件类型 + 相同 key → 复用局部 state」，
  // 草稿键入/保存/语言切换的重渲不丢帮助开合状态（设计 §5.5）。
  return React.createElement("div", { className: "ats-enum-field" },
    React.createElement("div", { className: "ats-enum-head" },
      React.createElement("div", { className: "ats-enum-labelGroup" },
        props.flag === true
          ? React.createElement("div", { className: "ats-enum-label" }, props.label)
          : React.createElement("label", { className: "ats-enum-label", htmlFor: props.id }, props.label),
        helpButton),
      props.overridden === true ? React.createElement("span", { className: "ats-enum-badges" },
        React.createElement(P.Tag, { tone: "neutral" }, props.overriddenLabel),
        React.createElement("button", {
          type: "button", className: "ats-enum-reset", disabled: props.disabled,
          onClick: props.onReset
        }, props.resetLabel)) : null),
    control,
    props.invalid === true ? React.createElement("p", {
      id: invalidId,
      className: "ats-enum-message",
      "aria-invalid": true
    }, props.invalidLabel) : null,
    props.hint !== undefined ? React.createElement("p", {
      id: messageId,
      className: "ats-enum-message"
    }, props.hint) : null,
    helpOpen && props.help !== undefined ? React.createElement("div", {
      id: helpId,
      role: "region",
      "aria-label": props.helpA11y,
      className: "ats-help-region"
    }, String(props.help).split("\n\n").map(function (paragraph, index) {
      return React.createElement("p", { key: index }, paragraph);
    })) : null);
}

/**
 * 从 describe 快照的值层（value/user/base）里取 settings 子树的内容
 * （设计 §5.1：17 字段全部展平在 `settings` 键下）。
 *
 * 防御回退：`settings` 键缺席时把该层本身当字段层用（快照值层整体缺席的
 * 部署形态不因此抛错，座位/语言回退默认值——同 `readConfig` 的口径）。
 * @param {object|undefined} layer - describe 快照的某一值层。
 * @returns {object} 该层的 settings 字段内容（缺席为空对象）。
 */
function settingsLayerOf(layer) {
  if (layer === undefined || layer === null) return {};
  if (layer.settings !== undefined && layer.settings !== null) return layer.settings;
  return layer;
}

/**
 * 生效的 `uiLang`：用户层在场就用它，否则用实时解析值，再否则 `"auto"`。
 * @param {object|undefined} snapshot - 控制器快照。
 * @returns {string} `"auto" | "zh" | "en"`。
 */
function uiLangOf(snapshot) {
  var user = settingsLayerOf(snapshot !== undefined && snapshot !== null ? snapshot.user : undefined);
  var value = settingsLayerOf(snapshot !== undefined && snapshot !== null ? snapshot.value : undefined);
  var lang = user.uiLang !== undefined ? user.uiLang : value.uiLang;
  return lang === "zh" || lang === "en" ? lang : "auto";
}

/**
 * 选文案函数（需求 §5.3）：`"auto"` 用宿主 locale 的 `props.t`（现行行为）；`"zh"` / `"en"` 用本包
 * 自己的词典——宿主语言是**全局**偏好，本包不得调 `locale.setLocale`，只能自己选表。
 * 缺键回退宿主 `t`，这样新词条漏加也不会渲染成空白。
 * @param {string} uiLang - 生效的语言开关值。
 * @param {Function} hostT - 槽位传入的宿主翻译函数。
 * @returns {Function} `(key) => string`。
 */
function makeTranslator(uiLang, hostT) {
  if (uiLang !== "zh" && uiLang !== "en") return hostT;
  var dict = DICTIONARIES[uiLang];
  return function (key) {
    return dict[key] !== undefined ? dict[key] : hostT(key);
  };
}

/**
 * 卡片状态投影：模型外壳（dirty/invalid/saving/failed/available/writable）+ 逐字段状态
 * （草稿文本/覆盖徽标/非法）+ 毫秒字段的生效值（说明行读数用）+ 生效 `uiLang`（选词典用）。
 * 官方成例（`dsh-client-ui-settings-web-search` 的 `projection()`）就是把 shell 与逐字段
 * 状态放进同一次 `bind`。
 *
 * @param {object} model - `SettingsFormModel` 实例。
 * @param {object} scope - 控制器（`ctx.configForms.get(ENTRY)`）。
 * @returns {object} 投影状态（引用稳定到下一次 publish）。
 */
function projectCardState(model, scope) {
  var snapshot = scope.getSnapshot();
  var state = { shell: model.shell(), uiLang: uiLangOf(snapshot), fields: {}, effective: {} };
  var valueLayer = settingsLayerOf(snapshot !== undefined && snapshot !== null ? snapshot.value : undefined);
  for (var i = 0; i < FIELDS.length; i += 1) {
    var field = FIELDS[i];
    state.fields[field.key] = model.field(field.key);
    if (field.ms === true) {
      state.effective[field.key] = valueLayer[field.key];
    }
  }
  return state;
}

/**
 * 官方 `SettingsFormModel` 的字段寻址是**根平铺**（`value?.[field]`、
 * `path:[field]`，冻结平台模块表的建资产实证）；本包的行 Config 是
 * `settings` 子树形态（设计 §5.1），值投影在 `settings` 键下。适配层把
 * 控制器包装成官方模型看得懂的形状：`value`/`base`/`user` 三层经
 * `settingsLayerOf` 展平，`mutate` 的 op 路径整体加 `settings` 前缀——
 * UI 结构语义不变，只有线上的寻址形状换轨。
 *
 * @param {object} scope - 控制器（`ctx.configForms.get(ENTRY)`）。
 * @returns {object} 官方模型可用的同接口控制器视图。
 */
function makeSettingsScopeView(scope) {
  function flatSnapshot() {
    var snap = scope.getSnapshot();
    if (snap === undefined || snap === null) return snap;
    var flat = {};
    for (var key in snap) {
      if (!Object.prototype.hasOwnProperty.call(snap, key)) continue;
      flat[key] = (key === "value" || key === "base" || key === "user")
        ? settingsLayerOf(snap[key])
        : snap[key];
    }
    return flat;
  }
  return {
    getSnapshot: flatSnapshot,
    subscribe: function (listener) { return scope.subscribe(listener); },
    mutate: function (ops, revision) {
      var prefixed = (ops || []).map(function (op) {
        var next = { op: op.op, path: ["settings"].concat(op.path || []) };
        // unset 不携带 value 键（官方 plan 的 op 形状按动作分档，适配层不改形状）。
        if (op.value !== undefined) next.value = op.value;
        return next;
      });
      return scope.mutate(prefixed, revision);
    }
  };
}

/**
 * 建卡片模型：控制器先经 `makeSettingsScopeView` 适配（嵌套根 → 官方模型的
 * 平铺寻址），再交给官方 `SettingsFormModel`，`bind` 只调一次，
 * 返回 `{model, store, dispose}`——`dispose` 解除模型对 scope 的订阅。
 *
 * @param {object} ctx - 客户端上下文（`configForms` 由 inject 声明）。
 * @returns {object} 卡片模型句柄。
 */
function createCardModel(ctx) {
  var scope = ctx.configForms.get(ENTRY);
  var view = makeSettingsScopeView(scope);
  var model = new P.SettingsFormModel(view, makeSpecs());
  var store = model.bind(function () { return projectCardState(model, scope); });
  return {
    model: model,
    store: store,
    dispose: function () { model.dispose(); }
  };
}

/**
 * 渲染 `FIELDS` 里的全部字段（设计 §5.5：17 个字段统一走 `FieldShell`——
 * 布尔/枚举/数值/文本四形态由壳分流）；`id = "plugin-config-" + key`；毫秒字段的
 * 说明行带秒数读数。帮助与说明走缺键回退（`resolveCopy`）：缺席/裸键名时
 * 按钮/说明行退场。
 *
 * @param {object} state - `projectCardState` 的投影。
 * @param {object} model - 模型实例（动作从这里取）。
 * @param {Function} t - 文案函数。
 * @returns {object[]} 字段元素数组（顺序 = FIELDS）。
 */
function makeFieldNodes(state, model, t) {
  var actions = model.actions();
  return FIELDS.map(function (field) {
    var fieldState = state.fields[field.key];
    var id = "plugin-config-" + field.key;
    var hint = composeHint(t, field, state.effective[field.key], fieldState.text);
    var label = t(field.label);
    var help = resolveCopy(t, "help." + field.key);
    var helpA11y = help === undefined ? undefined
      : t("help.a11yName").replace("{field}", label);
    // 设计 §5.4：数值字段的非法原因分五档——非整数（仅整数字段，如
    // `maxResultChars` 的小数草稿）、越上界（spec parse 判非法后的可读版）、
    // 低于下界、链式违例（壳层判，不等式左值字段显示、文案指明参照字段）、
    // 官方"不是数字"。`invalidPair` 的 `{ref}` 显示层经词典换参照字段的中文名称。
    var notInteger = false;
    var outOfRange = false;
    var belowRange = false;
    var pairHit = null;
    if (isNumericField(field)) {
      var draftNum = draftNumber(state, field.key);
      notInteger = fieldState.invalid === true && draftNum !== null
        && INTEGER_FIELDS[field.key] === true && !Number.isInteger(draftNum);
      // 非整数优先报整数性；越界/低于下界只在整数草稿上判定（避免同屏双报）。
      outOfRange = !notInteger && fieldState.invalid === true && draftNum !== null
        && draftNum > FIELD_MAX[field.key];
      belowRange = !notInteger && fieldState.invalid === true && draftNum !== null
        && FIELD_MIN[field.key] !== undefined && draftNum < FIELD_MIN[field.key];
      pairHit = chainHitOf(state, field.key);
    }
    var invalidLabel = notInteger
      ? t("invalidInteger")
      : outOfRange
      ? t("invalidRange").replace("{max}", String(FIELD_MAX[field.key]))
      : belowRange ? t("invalidBelow").replace("{min}", String(FIELD_MIN[field.key]))
      : pairHit !== null
        ? t("invalidPair." + field.key).replace(/\{ref\}/g, t(pairHit))
        : t("invalidNumber");
    return React.createElement(FieldShell, {
      key: field.key,
      fieldKey: field.key, id: id, label: label,
      hint: hint, help: help, helpA11y: helpA11y,
      overridden: fieldState.overridden, overriddenLabel: t("overridden"),
      resetLabel: t("reset"), invalid: fieldState.invalid === true || pairHit !== null,
      invalidLabel: invalidLabel,
      flag: field.flag === true,
      numeric: isNumericField(field),
      options: field.options,
      optionLabel: field.options === undefined ? undefined
        : function (option) { return t("opt." + field.key + "." + option); },
      disabled: !state.shell.writable, text: fieldState.text,
      onEdit: function (text) { actions.edit(field.key, text); },
      onReset: function () { actions.resetField(field.key); }
    });
  });
}

/**
 * 卸载风险提示块（设计 §5.4）：静态非交互文本，长在表单顶部、全部字段之前——
 * 用户改设置的入口在插件管理页，同一页面就是停用/移除本包的入口，风险提示
 * 放在操作现场。醒目外壳（警示浅底 + 左色条 + 三角图标，样式见 ENUM_CSS）
 * 与普通字段说明拉开层级（需求 §7.2「醒目提示」）。内容与 README 卸载指引
 * 同一口径（设置页给结论与动作，README 给步骤）。不依赖插件已卸载后的任何
 * 组件（纯静态文案）。
 * @param {Function} t - 文案函数。
 * @returns {object} React 元素。
 */
function makeUninstallRiskNode(t) {
  return React.createElement(
    "p",
    { className: "ats-uninstall-risk", key: "uninstall-risk" },
    React.createElement(
      "svg",
      {
        width: "14", height: "14", viewBox: "0 0 14 14", fill: "none",
        "aria-hidden": "true", focusable: "false"
      },
      React.createElement("path", {
        d: "M7 1.8L12.6 11.6H1.4L7 1.8Z",
        stroke: "var(--dsw-alias-state-warn-primary)", strokeWidth: "1.4",
        strokeLinejoin: "round"
      }),
      React.createElement("path", {
        d: "M7 5.4V7.8",
        stroke: "var(--dsw-alias-state-warn-primary)", strokeWidth: "1.4",
        strokeLinecap: "round"
      }),
      React.createElement("path", {
        d: "M7 9.6V9.7",
        stroke: "var(--dsw-alias-state-warn-primary)", strokeWidth: "1.4",
        strokeLinecap: "round"
      })
    ),
    React.createElement("span", null, t("uninstallRisk"))
  );
}

/**
 * 插件页卡片工厂：模型每挂载建一次、卸载时 `dispose`；重渲染走
 * `useSyncExternalStore(card.store.subscribe, card.store.getSnapshot)`。
 * `SettingsForm` 的 `onDiscard` 接模型的 `discard`——卸载丢弃草稿由它承担。
 * @param {object} ctx - 客户端上下文（`configForms` 由 inject 声明）。
 * @returns {Function} 槽位组件。
 */
function makeBundleCard(ctx) {
  return function AsyncToolsBundleCard(props) {
    var modelRef = React.useRef(null);
    if (modelRef.current === null) modelRef.current = createCardModel(ctx);
    var card = modelRef.current;
    var state = React.useSyncExternalStore(card.store.subscribe, card.store.getSnapshot);
    React.useEffect(function () {
      return function () {
        card.dispose();
        modelRef.current = null;
      };
    }, [card]);
    if (props.view !== "page") return props.t("summary");
    var t = makeTranslator(state.uiLang, props.t);
    var actions = card.model.actions();
    return React.createElement(P.SettingsForm, {
      labels: {
        unavailable: t("unavailable"),
        readOnly: t("readOnly"),
        saveFailed: t("saveFailed"),
        save: t("save"),
        saving: t("saving")
      },
      // 跨字段链式违例叠加在传给 SettingsForm 的
      // `state.invalid` 上——宿主保存禁用只认这条链（`blocked = !dirty ||
      // state.invalid || saving`）；不包 save（save 仍是官方模型的动作）。
      state: { ...state.shell, invalid: state.shell.invalid === true || pairViolated(state) },
      onSave: actions.save,
      onDiscard: actions.discard
    }, [makeUninstallRiskNode(t)].concat(makeFieldNodes(state, card.model, t)));
  };
}

/** 词典：字段键即标签键、`hint.<键>` 为字段说明、`opt.<键>.<选项>` 为枚举选项文案；
 *  zh 为主，en 对照（`ctx.locale.register`；两语言键集必须一致）。 */
var DICTIONARIES = {
  zh: {
    title: "异步工具",
    summary: "async_run / async_wait / async_agent 的预算与后端",
    unavailable: "设置命名空间尚未服务：宿主行未加载，或设置服务不可用。",
    readOnly: "当前部署只读：设置不可修改。",
    save: "保存",
    saving: "保存中…",
    saveFailed: "保存没有生效：宿主拒绝了本次写入，草稿已保留，可调整后再试。",
    overridden: "已覆盖",
    reset: "恢复默认",
    invalidNumber: "这个值不是该字段可接受的输入",
    invalidInteger: "这个值必须是整数（正整数）",
    invalidRange: "超出该字段的上界（≤ {max}）",
    invalidBelow: "低于该字段的下界（≥ {min}）",
    "invalidPair.minYieldMs": "本值不能大于 {ref}——请调小本值或调大 {ref}",
    "invalidPair.defaultYieldMs": "本值不能大于 {ref}——请调小本值或调大 {ref}",
    "invalidPair.minWaitMs": "本值不能大于 {ref}——请调小本值或调大 {ref}",
    "invalidPair.defaultWaitMs": "本值不能大于 {ref}——请调小本值或调大 {ref}",
    "invalidPair.pollIntervalMs": "本值不能大于 {ref}——请调小本值或调大 {ref}",
    uninstallRisk: "卸载风险：默认预设指向本包预设（dsh-async / dsh-async-create）时，停用或移除本包会让新建会话报 agent-preset/not-found，宿主不会自动清除该选择。卸载前先在宿主设置把默认预设切换到可用预设；已移除后，在宿主设置的默认预设入口清空该选择或改选可用预设。",
    defaultYieldMs: "默认首次等待时长（毫秒）",
    minYieldMs: "首次等待时长下限（毫秒）",
    maxYieldMs: "首次等待时长上限（毫秒）",
    defaultWaitMs: "等待示例时长（毫秒）",
    minWaitMs: "单次等待时长下限（毫秒）",
    maxWaitMs: "单次等待时长上限（毫秒）",
    pollIntervalMs: "子代理状态检查间隔（毫秒）",
    maxResultChars: "结果内容字符上限",
    jobKind: "命令作业类型标识",
    subagentProvider: "子代理创建后端",
    uiLang: "插件界面语言",
    agentLang: "Agent 文案语言",
    silentFailureGuard: "命令静默失败提示",
    workflowProgressLog: "编排进度行保留",
    fullCommandEcho: "作业列表回显完整命令",
    askTakeover: "在待答面板处理提问",
    askTimeoutMs: "首次提问等待时长（毫秒）",
    askExtendMs: "每次增加的等待时长（毫秒）",
    askUiSeat: "待答问题显示方式",
    "hint.defaultYieldMs": "async_run 与 async_workflow 未指定 yield_ms 时使用的首次等待时长；指定时按本次请求与上下限取值。到时仍未完成就结束本次等待、返回作业编号（job_id），后台任务继续运行。",
    "hint.minYieldMs": "限制本次 yield_ms 的有效值；请求低于此值时按下限取值。到时结束本次等待，后台任务继续运行。",
    "hint.maxYieldMs": "限制本次 yield_ms 的有效值；请求高于此值时按上限取值。到时结束本次等待，后台任务继续运行。",
    "hint.defaultWaitMs": "返回提示里等待调用示例使用的时长；示例只作演示，不等于实际调用的生效等待。实际调用等待入口时须显式填写 wait_ms，省略时报错。",
    "hint.minWaitMs": "适用于等待入口的 wait_ms；请求低于此值时按下限取值。到时结束本次等待，后台任务继续运行。",
    "hint.maxWaitMs": "适用于等待入口的 wait_ms；请求高于此值时按上限取值。到时结束本次等待，后台任务继续运行。",
    "hint.pollIntervalMs": "async_wait 的子代理目标定期检查运行状态的间隔，用作变化事件未到达时的备用判断。",
    "hint.maxResultChars": "单次返回保留的结果内容字符上限（正整数），超出时保留首尾并说明截断；状态与提示另计。",
    "hint.jobKind": "注册命令作业用的类型名称，便于在作业列表与日志中识别。",
    "hint.subagentProvider": "async_agent 创建子代理使用的后端服务。",
    "hint.uiLang": "控制本包设置表单、字段帮助与待答界面的语言；跟随宿主语言或显式选择中文／英文。",
    "hint.agentLang": "控制本包工具描述、参数说明、提示、错误与执行纪律文案的语言。",
    "hint.silentFailureGuard": "“静默失败”指命令可能未执行、却没有明显报错。开启后，出现这种情况时给出诊断提醒和检查建议；仅本包两预设生效，默认关。",
    "hint.workflowProgressLog": "默认关：编排结果滤除各阶段进度行，只保留结论。开启后保留进度行，结果正文相应变长。",
    "hint.fullCommandEcho": "默认关：命令作业在作业列表里显示进度说明。开启后回显完整命令原文。",
    "hint.askTakeover": "开启后由待答面板处理本包两预设根 Agent 的普通提问，关闭时使用宿主原生流程；到期后 Agent 继续处理任务，用户仍可稍后作答。",
    "hint.askTimeoutMs": "从接收一批提问起计时的初始窗口，同批多题共享期限。到期保留已答内容，Agent 继续处理任务，用户仍可稍后作答；新值用于后续批次。",
    "hint.askExtendMs": "待答面板“增加等待时间”每点击一次，给该会话当时仍在等待的批次各追加的时长。",
    "hint.askUiSeat": "侧边栏底栏徽标显示未处理数，点击展开；右下角浮窗直接显示问题。",
    "help.a11yName": "{field} 的说明",
    "help.defaultYieldMs": "配置键：defaultYieldMs（数值，毫秒）。\n\n首次等待机制：async_run 与 async_workflow 用首次等待限制本次调用的占用时长——到时仍未完成就结束本次等待、返回作业编号（job_id），后台任务继续运行，Agent 可以继续其他工作；消息和取消可提前结束等待。\n\n时长示例（演示值，非当前生效值）：设 20000 毫秒——短命令在首次等待内完成，直接取得结果；长命令到时先取得作业编号，结算时结果正文直接附在等待返回或完成消息里。\n\n取值限制：默认值必须在首次等待时长的上下限内（minYieldMs ≤ defaultYieldMs ≤ maxYieldMs）。",
    "help.minYieldMs": "配置键：minYieldMs（数值，毫秒）。\n\n本次 yield_ms 低于此下限时按下限取值；消息和取消仍可提前结束首次等待。与 defaultYieldMs、maxYieldMs 共同构成首次等待时长的上下限；本次取值越界时按对应边界取值。",
    "help.maxYieldMs": "配置键：maxYieldMs（数值，毫秒）。\n\n本次 yield_ms 高于此上限时按上限取值；消息和取消仍可提前结束首次等待。与 minYieldMs、defaultYieldMs 共同构成首次等待时长的上下限；本次取值越界时按对应边界取值。",
    "help.defaultWaitMs": "配置键：defaultWaitMs（数值，毫秒）。\n\nwait_ms 是必填参数：等待入口的每次调用都要显式给出，缺省报错。返回提示里给出的 wait_ms 取值随本设置显示，仅为示例。示例与 minWaitMs、maxWaitMs 的区间配对。",
    "help.minWaitMs": "配置键：minWaitMs（数值，毫秒）。\n\n一份预算覆盖本次调用的入口检查、查询、重试与等待；到时交回控制权、作业句柄仍有效，再次调用即可继续读。消息到达可提前结束本次等待。",
    "help.maxWaitMs": "配置键：maxWaitMs（数值，毫秒）。\n\n一份预算覆盖本次调用的入口检查、查询、重试与等待；到时交回控制权、作业句柄仍有效，再次调用即可继续读。消息到达可提前结束本次等待。",
    "help.pollIntervalMs": "配置键：pollIntervalMs（数值，毫秒）。\n\nasync_wait 的子代理目标以变化事件为主、轮询为备用的双通道检查是否仍在运行；本间隔是备用轮询的节奏，受 pollIntervalMs ≤ maxWaitMs 配对约束。",
    "help.maxResultChars": "配置键：maxResultChars（数值，字符）。\n\n按 String.length 计量，必须是正整数，小数草稿在保存时被拒；超出时保留首尾并说明省略量与截断；状态与提示另计。",
    "help.jobKind": "配置键：jobKind（文本）。\n\n注册命令作业时使用的类型名称，用于作业列表与日志的辨识；输入空串会被拒绝。",
    "help.subagentProvider": "配置键：subagentProvider（文本）。\n\nasync_agent 创建子代理使用的后端服务，默认 spawn；输入去掉首尾空白后为空时按默认值保存，填了不存在的后端时在调用时可读拒绝。需要指定模型时，在 async_agent 调用参数中用 provider 与 model 指定。",
    "help.uiLang": "配置键：uiLang（枚举：auto / zh / en）。\n\n界面文案与 Agent 文案是两个独立开关：本开关只影响界面文案，Agent 文案语言由 agentLang 设置；auto 档跟随宿主语言。",
    "help.agentLang": "配置键：agentLang（枚举：en / zh）。\n\n控制模型可见文案（工具描述、参数说明、提示、错误与执行纪律）；界面文案语言由 uiLang 单独设置，两者互不影响。",
    "help.silentFailureGuard": "配置键：silentFailureGuard（布尔）。\n\n开启后，命令可能未执行且缺少明显报错的特定条件下，诊断提醒和检查建议出现在返回提示、命令描述与执行纪律三处。",
    "help.workflowProgressLog": "配置键：workflowProgressLog（布尔）。\n\n默认关：编排作业的结果正文先滤除各阶段进度行，再进入内容预算。开启后保留进度行——长编排的结果更长，可能更早触发截断。",
    "help.fullCommandEcho": "配置键：fullCommandEcho（布尔）。\n\n默认关：命令作业在作业列表里以进度说明作为标签。开启后以完整命令原文作为标签，便于核对哪条命令对应哪个作业。",
    "help.askTakeover": "配置键：askTakeover（布尔）。\n\n迟到作答经通知送达；24 小时只是惰性清扫阈值——仅当下一个提问批次被接管时队列才做一次清扫，没有新批时记录可保留更久、仍可补答；被清扫、所属 Agent 无法接收或投递失败的记录不会送达。未送达时，直接出路是到题目所属会话直接回复。",
    "help.askTimeoutMs": "配置键：askTimeoutMs（数值，毫秒）。\n\n从接收一批提问起计时，同批多题共享期限；到期时未答的题按超时处理，Agent 继续处理任务。面板在到期后仍接受作答；迟到作答若所属会话本轮已结束，会直接回复到该会话，不进队列。",
    "help.askExtendMs": "配置键：askExtendMs（数值，毫秒）。\n\n待答面板“增加等待时间”每点击一次，给该会话当时未到期的批次各增加此时长，在原截止点上叠加；新批次按自己的初始期限计时。",
    "help.askUiSeat": "配置键：askUiSeat（枚举：sidebar / overlay）。\n\n两种显示方式复用同一套题目交互，切换显示方式不改提问、计时或答案交付；徽标计数在全部处理后消隐。",
    "opt.askUiSeat.sidebar": "侧边栏底栏徽标（默认）",
    "opt.askUiSeat.overlay": "右下角浮窗",
    "ask.title": "待答问题",
    "ask.count": "{n} 题待答",
    "ask.answer": "提交",
    "ask.ignore": "不答",
    "ask.customAnswer": "自定义回答",
    "ask.customPlaceholder": "输入自定义回答",
    "ask.needAnswer": "请选择一项答案或填写自定义回答",
    "ask.needCustom": "自定义回答为空：填写内容或改选其他答案",
    "ask.jump": "打开会话",
    "ask.expired": "已超时，仍可作答",
    "ask.submitting": "提交中…",
    // 面板顶报错按失败动作分键（需求 §4.4 的失败三分）：①明确拒绝（RPC 已达
    // 宿主、宿主回 ok:false——可断定未执行）②未收到确认（RPC 拒绝——执行与否
    // 未知，不得断定"未送达"）③状态读取失败（轮询自动重试）；丢失答案无自动
    // 重试通道，允许手动消除。
    "ask.callFailed": "提交后没有收到宿主确认——可能已送达，也可能没有；稍候面板自动刷新，若仍显示未作答可再提交一次。",
    "ask.answerRejected": "宿主明确拒绝：本次提交没有生效",
    "ask.undelivered": "未送达：题目记录已不在（超过保留期或批次已结束），本次提交未被接受；如仍需作答，请在所属会话中直接回复。",
    "ask.stateFailed": "待答状态读取失败；面板会自动重试。",
    "ask.extendFailed": "延长请求没有收到宿主确认——可能已生效，也可能没有；按面板刷新后的剩余时间决定是否再点（每次点击都会累加）。",
    "ask.extendRejected": "宿主已收到延长请求但明确拒绝——本次加时没有生效；稍候面板自动刷新。",
    "ask.lostAnswer": "作答已提交但未能送达 Agent（投递失败，不会自动重试）；如仍需作答，请打开所属会话直接回复。",
    "ask.dismissLost": "知道了",
    "ask.windowLeft": "剩 {s}",
    "ask.extend": "增加等待时间",
    "readout.effective": "生效：{v}",
    "readout.input": "输入：{v}",
    "opt.uiLang.auto": "跟随界面语言",
    "opt.uiLang.zh": "中文",
    "opt.uiLang.en": "English",
    "opt.agentLang.en": "English（默认）",
    "opt.agentLang.zh": "中文"
  },
  en: {
    title: "Async tools",
    summary: "Budgets and backends for async_run / async_wait / async_agent",
    unavailable: "The settings namespace is not served: the host row is not loaded, or the settings service is unavailable.",
    readOnly: "This deployment stores settings read-only: they cannot be changed here.",
    save: "Save",
    saving: "Saving…",
    saveFailed: "The save did not land: the host refused this write; the drafts are kept for another try.",
    overridden: "Overridden",
    reset: "Reset",
    invalidNumber: "This text is not a value the field accepts",
    invalidInteger: "This value must be a whole number (a positive integer)",
    invalidRange: "This value exceeds the field's upper bound (≤ {max})",
    invalidBelow: "This value is below the field's lower bound (≥ {min})",
    "invalidPair.minYieldMs": "This value must not exceed {ref} — lower this value or raise {ref}",
    "invalidPair.defaultYieldMs": "This value must not exceed {ref} — lower this value or raise {ref}",
    "invalidPair.minWaitMs": "This value must not exceed {ref} — lower this value or raise {ref}",
    "invalidPair.defaultWaitMs": "This value must not exceed {ref} — lower this value or raise {ref}",
    "invalidPair.pollIntervalMs": "This value must not exceed {ref} — lower this value or raise {ref}",
    uninstallRisk: "Uninstall risk: while the default preset points to this package's presets (dsh-async / dsh-async-create), disabling or removing this package makes new sessions fail with agent-preset/not-found; the host does not clear that choice automatically. Switch the default preset to an available one in host settings before uninstalling; after removal, clear that choice or select an available preset in the host's default-preset setting.",
    defaultYieldMs: "Default first-wait duration (ms)",
    minYieldMs: "First-wait lower bound (ms)",
    maxYieldMs: "First-wait upper bound (ms)",
    defaultWaitMs: "Example wait duration (ms)",
    minWaitMs: "Per-call wait lower bound (ms)",
    maxWaitMs: "Per-call wait upper bound (ms)",
    pollIntervalMs: "Subagent status check interval (ms)",
    maxResultChars: "Result content character cap",
    jobKind: "Command job kind label",
    subagentProvider: "Subagent creation backend",
    uiLang: "Plugin interface language",
    agentLang: "Agent-facing text language",
    silentFailureGuard: "Command silent-failure hint",
    workflowProgressLog: "Keep orchestration progress lines",
    fullCommandEcho: "Echo full command in job lists",
    askTakeover: "Answer questions in the pending panel",
    askTimeoutMs: "Initial question wait duration (ms)",
    askExtendMs: "Wait time added per click (ms)",
    askUiSeat: "Pending-question display placement",
    "hint.defaultYieldMs": "First-wait duration used by async_run and async_workflow when yield_ms is not given; when given, this request and the bounds decide. If the work is still running when it ends, this wait ends and returns the job id (job_id); the background task keeps running.",
    "hint.minYieldMs": "Clamps the effective value of this yield_ms; requests below it use the lower bound. When the wait ends, the background task keeps running.",
    "hint.maxYieldMs": "Clamps the effective value of this yield_ms; requests above it use the upper bound. When the wait ends, the background task keeps running.",
    "hint.defaultWaitMs": "Duration used by the wait-call example in return notes; the example is a demo and does not equal the effective wait of an actual call. Actual calls of the wait entry must give wait_ms explicitly, and omitting it errors.",
    "hint.minWaitMs": "Applies to wait_ms on the wait entry; requests below it use the lower bound. When the wait ends, the background task keeps running.",
    "hint.maxWaitMs": "Applies to wait_ms on the wait entry; requests above it use the upper bound. When the wait ends, the background task keeps running.",
    "hint.pollIntervalMs": "Interval for async_wait's subagent targets to periodically check the running state — the backup judgment when the change event has not arrived.",
    "hint.maxResultChars": "Character cap (a positive integer) for the result content kept per return; beyond it the head and tail are kept with a truncation note; status and notices are counted separately.",
    "hint.jobKind": "Type name used to register command jobs, for identification in job lists and logs.",
    "hint.subagentProvider": "Backend service async_agent uses to create subagents.",
    "hint.uiLang": "Controls the language of this package's settings form, field help, and pending panel; follows the host language or an explicit Chinese/English choice.",
    "hint.agentLang": "Controls the language of this package's tool descriptions, parameter notes, notices, errors, and execution discipline.",
    "hint.silentFailureGuard": "\"Silent failure\" means a command may not have run, yet no error is visible. When on, such cases get a diagnostic reminder and checking advice; it applies only to this package's two presets and is off by default.",
    "hint.workflowProgressLog": "Off by default: orchestration results filter out per-phase progress lines and keep conclusions only. When on, progress lines are kept, making result bodies longer.",
    "hint.fullCommandEcho": "Off by default: command jobs show the progress description in job lists. When on, the full command text is echoed.",
    "hint.askTakeover": "When on, the pending panel handles plain questions from this package's two presets' root agents; when off, the host's native flow is used. After expiry the Agent continues the task, and the user can still answer later.",
    "hint.askTimeoutMs": "Initial window counted from receiving a batch of questions; all questions in a batch share the deadline. On expiry, answered content is kept, the Agent continues the task, and the user can still answer later; a new value applies to later batches.",
    "hint.askExtendMs": "Wait time each \"Extend wait\" click in the pending panel adds to each batch of that session still waiting at that moment.",
    "hint.askUiSeat": "The sidebar footer badge shows the open count and expands on click; the bottom-right overlay shows the questions directly.",
    "help.a11yName": "Help for \"{field}\"",
    "help.defaultYieldMs": "Config key: defaultYieldMs (number, ms).\n\nFirst-wait mechanism: async_run and async_workflow use the first wait to bound this call's occupancy — when it ends with work still running, the wait ends and returns the job id (job_id); the background task keeps running and the Agent can continue other work; messages and cancellation can end the wait early.\n\nDuration example (demo value, not the current effective value): with 20000 ms — a short command finishes inside the first wait and you get the result directly; a long command returns the job id first, and when it settles the result body is delivered directly with a wait return or a completion message.\n\nValue bounds: the default must sit within the first-wait bounds (minYieldMs ≤ defaultYieldMs ≤ maxYieldMs).",
    "help.minYieldMs": "Config key: minYieldMs (number, ms).\n\nA yield_ms below this lower bound is clamped to it; messages and cancellation can still end the first wait early. Forms the first-wait bounds together with defaultYieldMs and maxYieldMs; an out-of-range request uses the corresponding bound.",
    "help.maxYieldMs": "Config key: maxYieldMs (number, ms).\n\nA yield_ms above this upper bound is clamped to it; messages and cancellation can still end the first wait early. Forms the first-wait bounds together with minYieldMs and defaultYieldMs; an out-of-range request uses the corresponding bound.",
    "help.defaultWaitMs": "Config key: defaultWaitMs (number, ms).\n\nwait_ms is required: every call of the wait entry must give it explicitly, and omitting it errors. The wait_ms value shown in return notes follows this setting and is only an example. The example pairs with the minWaitMs/maxWaitMs range.",
    "help.minWaitMs": "Config key: minWaitMs (number, ms).\n\nOne budget covers this call's entry checks, lookups, retries, and the wait; when it ends, control returns with the job handle still valid, and calling again continues reading. An arriving message can end the wait early.",
    "help.maxWaitMs": "Config key: maxWaitMs (number, ms).\n\nOne budget covers this call's entry checks, lookups, retries, and the wait; when it ends, control returns with the job handle still valid, and calling again continues reading. An arriving message can end the wait early.",
    "help.pollIntervalMs": "Config key: pollIntervalMs (number, ms).\n\nasync_wait's subagent targets check whether the target is still running on two channels — change events first, polling as the backup; this interval sets the backup polling cadence and is bound by the pollIntervalMs ≤ maxWaitMs pairing.",
    "help.maxResultChars": "Config key: maxResultChars (number, characters).\n\nMeasured by String.length; it must be a positive integer, and non-integer drafts are rejected at save. Beyond the cap the head and tail are kept and the omission and truncation are stated; status and notices are counted separately.",
    "help.jobKind": "Config key: jobKind (text).\n\nType name used when registering command jobs, for identification in job lists and logs; an empty value is invalid.",
    "help.subagentProvider": "Config key: subagentProvider (text).\n\nBackend service async_agent uses to create subagents, spawn by default; an empty value after trimming falls back to the default, and an unknown backend is rejected readably at call time. To specify a model, use the provider and model parameters of the async_agent call.",
    "help.uiLang": "Config key: uiLang (enum: auto / zh / en).\n\nInterface copy and Agent-facing copy are two independent switches: this one only affects interface copy, and agentLang sets the Agent-facing language; the auto mode follows the host language.",
    "help.agentLang": "Config key: agentLang (enum: en / zh).\n\nControls model-visible copy (tool descriptions, parameter notes, notices, errors, and execution discipline); interface copy is set by uiLang separately, and the two do not affect each other.",
    "help.silentFailureGuard": "Config key: silentFailureGuard (boolean).\n\nWhen on, in the specific cases where a command may not have run with no visible error, the diagnostic reminders and checking advice appear in three places: return notes, command descriptions, and execution discipline.",
    "help.workflowProgressLog": "Config key: workflowProgressLog (boolean).\n\nOff by default: orchestration job result bodies filter out per-phase progress lines before entering the content budget. When on, progress lines are kept — long orchestrations produce longer results and may hit truncation earlier.",
    "help.fullCommandEcho": "Config key: fullCommandEcho (boolean).\n\nOff by default: command jobs use the progress description as their job-list label. When on, the full command text is used as the label, making it easier to match jobs to commands.",
    "help.askTakeover": "Config key: askTakeover (boolean).\n\nLate answers are delivered as notices; 24 hours is only a lazy sweep threshold — the queue is swept just once when the next question batch is taken over, and with no new batch the records can live longer and can still be answered; a swept record, an agent that can no longer receive it, or a failed delivery will not arrive. When a record will not arrive, the direct fallback is to reply directly in the session that question belongs to.",
    "help.askTimeoutMs": "Config key: askTimeoutMs (number, ms).\n\nCounted from receiving a batch of questions; all questions in a batch share the deadline; unanswered questions are treated as timed out and the Agent continues the task. The panel keeps accepting answers after expiry; when the owning session's turn has already ended, a late answer is replied directly into that session instead of entering the queue.",
    "help.askExtendMs": "Config key: askExtendMs (number, ms).\n\nEach \"Extend wait\" click in the pending panel adds this duration to each batch of that session not yet expired at that moment, stacked on the original deadline; new batches run on their own initial deadlines.",
    "help.askUiSeat": "Config key: askUiSeat (enum: sidebar / overlay).\n\nBoth seats share the same question interaction — switching the display does not change questioning, timing, or answer delivery; the badge hides once everything is handled.",
    "opt.askUiSeat.sidebar": "Sidebar footer badge (default)",
    "opt.askUiSeat.overlay": "Bottom-right overlay",
    "ask.title": "Pending questions",
    "ask.count": "{n} pending",
    "ask.answer": "Submit",
    "ask.ignore": "Skip",
    "ask.customAnswer": "Custom answer",
    "ask.customPlaceholder": "Type a custom answer",
    "ask.needAnswer": "Choose an option or type a custom answer to submit",
    "ask.needCustom": "The custom answer is empty: fill it in or choose another answer",
    "ask.jump": "Open session",
    "ask.expired": "Timed out; still answerable",
    "ask.submitting": "Submitting…",
    // 面板顶报错按失败动作分键（需求 §4.4 的失败三分）：①明确拒绝（RPC 已达
    // 宿主、宿主回 ok:false——可断定未执行）②未收到确认（RPC 拒绝——执行与否
    // 未知，不得断定"未送达"）③状态读取失败（轮询自动重试）；丢失答案无自动
    // 重试通道。（与 zh 词典区同款说明：文案本身是英文界面文本，注释是中文。）
    "ask.callFailed": "No confirmation was received from the host after submitting — it may or may not have arrived; the panel refreshes automatically, and if it still shows unanswered, you can submit again.",
    "ask.answerRejected": "The host explicitly refused this submission — it did not take effect",
    "ask.undelivered": "Not delivered: the question record is gone (past its retention or the batch has ended), so this submission was not accepted; if you still want to answer, reply directly in the session.",
    "ask.stateFailed": "Failed to fetch the pending-questions state; the panel retries automatically.",
    "ask.extendFailed": "No confirmation was received for the extend request — it may or may not have taken effect; decide whether to click again based on the remaining time shown after the panel refreshes (each click adds up).",
    "ask.extendRejected": "The host received the extend request but explicitly refused it — this extension did not take effect; the panel refreshes automatically shortly.",
    "ask.lostAnswer": "The answer was submitted but could not be delivered to the agent (delivery failed; it will not be retried automatically); to answer again, open the session and reply there directly.",
    "ask.dismissLost": "Dismiss",
    "ask.windowLeft": "{s} left",
    "ask.extend": "Extend wait",
    "readout.effective": "Effective: {v}",
    "readout.input": "Input: {v}",
    "opt.uiLang.auto": "Follow interface language",
    "opt.uiLang.zh": "中文",
    "opt.uiLang.en": "English",
    "opt.agentLang.en": "English (default)",
    "opt.agentLang.zh": "中文"
  }
};

// ── 提问接管的待答界面（需求 §4.2/设计 §4.3）────────────────────────────
//
// 通道：状态 = 轮询自有 typert remote 命名空间（1000 ms，模块 dispose 清除）；
// 作答/忽略/延长 = `answer`/`ignore`/`extend` 直调（载荷**裸传**，客户端按 wire 名
// 组装位置参数）；回执 `{ok,value|error}`（voice-input 同款判法）。总开关关 → 模型停
// 轮询、两座位渲染 null——零行为。

/** 轮询间隔（待答状态的轮询节拍；1000 ms，与 host 侧 state() 的轮询预期一致）。 */
var ASK_STATE_POLL_MS = 1000;
/** 命名空间与服务键（设计 §4.3；与宿主 `lib/ask-takeover.js` 同串，对账锚点）。 */
var ASK_NAMESPACE = "async-tools-ask";
var ASK_SERVICE_KEY = "asyncToolsAsk";

/**
 * 透传 strict codec（手写形态）。`$mount` 会走
 * typert-registry 的 `validateCodec`——strict codec 的 `create` 必须是**函数工厂**
 * （对象形或缺席都会被 "strict codec has no create() factory" 炸掉）；调用期
 * decode 可缺席（api-gateway client 的口径：无 decode = 透传）。工厂返回一个
 * 诚实的透传 schema（parse/safeParse 原样返回）供 registry 反射物化。
 */
function passthroughCodec(typeSymbol) {
  return {
    mode: "strict",
    typeSymbol: typeSymbol,
    create: function () {
      return {
        parse: function (value) { return value; },
        safeParse: function (value) { return { success: true, data: value }; }
      };
    }
  };
}

/**
 * 手写 strict descriptors（voice-input 同款形态）。`wire` 与宿主服务方法的
 * **参数名**逐字一致（`submission`）——双断言：参数名一致 + 假 RPC 载荷单层包裹。
 */
var ASK_REMOTE = {
  package: PACKAGE_NAME,
  descriptors: [
    {
      id: "dsh-async-tools#async-tools-ask/state",
      service: ASK_SERVICE_KEY, namespace: ASK_NAMESPACE, method: "state",
      invocation: { kind: "direct" }, parameters: [],
      result: passthroughCodec("dsh-async-tools#async-tools-ask/state:result"),
      sourceLocation: { file: "lib/ask-takeover.js" }
    },
    {
      id: "dsh-async-tools#async-tools-ask/answer",
      service: ASK_SERVICE_KEY, namespace: ASK_NAMESPACE, method: "answer",
      invocation: { kind: "direct" },
      parameters: [{ name: "submission", wire: "submission", source: "json", codec: passthroughCodec("dsh-async-tools#ask-submission") }],
      result: passthroughCodec("dsh-async-tools#async-tools-ask/answer:result"),
      sourceLocation: { file: "lib/ask-takeover.js" }
    },
    {
      id: "dsh-async-tools#async-tools-ask/ignore",
      service: ASK_SERVICE_KEY, namespace: ASK_NAMESPACE, method: "ignore",
      invocation: { kind: "direct" },
      parameters: [{ name: "submission", wire: "submission", source: "json", codec: passthroughCodec("dsh-async-tools#ask-submission") }],
      result: passthroughCodec("dsh-async-tools#async-tools-ask/ignore:result"),
      sourceLocation: { file: "lib/ask-takeover.js" }
    },
    {
      id: "dsh-async-tools#async-tools-ask/extend",
      service: ASK_SERVICE_KEY, namespace: ASK_NAMESPACE, method: "extend",
      invocation: { kind: "direct" },
      parameters: [{ name: "submission", wire: "submission", source: "json", codec: passthroughCodec("dsh-async-tools#ask-submission") }],
      result: passthroughCodec("dsh-async-tools#async-tools-ask/extend:result"),
      sourceLocation: { file: "lib/ask-takeover.js" }
    }
  ]
};

/**
 * 待答模型：订阅设置 scope 读 `askTakeover`/`askUiSeat`/`uiLang`（生效值 = 用户层
 * ?? 组合层 ?? 默认），（重新）开启即发起首查并按间隔轮询 `state()`。`visibilitychange
 * → visible` 与每次 answer/ignore 动作后立即补一次轮询；后台标签页由浏览器节流，轮询
 * 不以可见性为前提（设计 §4.3：页面恢复可见及每次提交后立即刷新；后台页节流不当作
 * 服务端停止计时）。状态回执统一经读取代际闸门（设计 §4.3）：旧代（关闭／重开／卸载
 * 后到达）与乱序的较旧回执丢弃，较旧响应不回退新题目、计数与期限。
 *
 * 失败不静默（失败三分）：`callFailed` 分型旗标（null | 'submit' |
 * 'state' | 'extend' | 'answerRejected' | 'extendRejected'，面板顶按失败动作分键
 * 报错。RPC 拒绝（'submit'/'extend'，**没有确认**——执行与否未知，不断定
 * "未送达"，可重试）与宿主回执 `{ok:false}`（'answerRejected'/'extendRejected'，
 * **明确拒绝**——请求已送达、被拒，未执行可断定；作答档随附回执 error 的 message（gateway rpcFailure 对象契约，voice-input 同款读法）存
  * `answerRejectReason`——服务端拒绝原因随 agentLang 透传展示，不预判原因）分开报错；'extend' 两条路径
 * 都立即 poll() 复查真实期限（重试前先看刷新后的剩余时间——每次点击继续
 * 累加，不伪幂等）；
  * 宿主回执 `outcome:'gone'` 且带 `undelivered:true`（批次/题记录缺席——清扫、
  * 结清出列或交还，需求 §4.4）→ 'undelivered' 记入未送达名单（与 lostAnswers 同款逐条「知道了」消除、
   * 计入座位渲染条件——条目随轮询清空后报错仍在场，不随提交成功清除）；他处已落定的
  * 普通 gone 交轮询收敛（题目已有答案，不是未送达）；
 * 宿主回执 `outcome:'failed'`（迟到注入 followup/inject 抛错、条目已
 * 出列）→ 记入 `lostAnswers`（面板顶逐条列出报错——那一条用户的答案没有送达，且
 * 无重试通道，需求 §4.4）。竞态补醒失败（设计 §4.3）经 `state().lost` 名单随轮询并入——
 * 两个时点共用同一复合键去重与「知道了」消除（消除后服务端名单不回弹）。
 *
 * @param {object} ctx - 客户端上下文（configForms/uiWorkspace 由 inject 声明）。
 * @param {object} remote - ask 命名空间代理（`ctx.inject(['remote.async-tools-ask'])`
 *   拿到的——自 mount 的命名空间**不能**直接读 `ctx.remote[ns]`，运行时要求先 inject，
 *   否则 "cannot get property without inject" 每秒炸一次轮询）。
 * @returns {{store: object, actions: object, dispose: Function}} 快照存储 + 动作 + 处置。
 */
function createAskModel(ctx, remote) {
  var scope = ctx.configForms.get(ENTRY);
  var listeners = new Set();
  var timer = null;
  var seq = 0;
  // 状态读取代际（设计 §4.3）：读取序号每次发起单调递增；生命周期代在
  // 关闭、重新开启、卸载时推进。回执只有在代数与当前一致、且序号大于已
  // 应用最高序号时才写回——旧代迟到回执与同代乱序的较旧回执一律丢弃，
  // 较旧响应不回退已取得的新题目、计数与期限。
  var lifecycle = 0;
  var readSeq = 0;
  var appliedReadSeq = 0;
  var state = {
    enabled: false, seat: "sidebar", uiLang: "auto",
    serverNow: 0, fetchedAt: 0, items: [], callFailed: null, answerRejectReason: null,
    lostAnswers: [], undelivered: []
  };

  function notify() {
    seq += 1;
    state = { ...state }; // 引用稳定到下一次变更（useSyncExternalStore 的口径）
    listeners.forEach(function (listener) { listener(); });
  }

  /** 没送达的迟到答案记进面板（复合键 batchId/questionId——模型自命名
   * 的 questionId 跨批次会撞，单 questionId 会吞掉第二条丢失）。名单计入座位
   * 渲染条件——条目出列后面板不消失，报错必须被人看到并手动消除。 */
  function recordLost(item) {
    var key = item.batchId + "/" + item.questionId;
    if (state.lostAnswers.some(function (lost) { return lost.batchId + "/" + lost.questionId === key; })) return;
    state.lostAnswers = [...state.lostAnswers.slice(-19), {
      batchId: item.batchId, questionId: item.questionId, question: item.question,
      ...(typeof item.sessionId === "string" ? { sessionId: item.sessionId } : {})
    }];
    notify();
  }

  /** 记录缺席的提交（需求 §4.4：清扫/结清出列/交还）记进面板未送达名单——与
   * lostAnswers 同款复合键去重与「知道了」消除；名单计入座位渲染条件，条目随
   * 下轮轮询清空（记录不在，state() 不再列出）后面板不消失，报错不能闪现即逝。
   * 记录已不在、无可重试通道，出路写在文案（在所属会话中直接回复）。 */
  function recordUndelivered(item) {
    var key = item.batchId + "/" + item.questionId;
    if (state.undelivered.some(function (und) { return und.batchId + "/" + und.questionId === key; })) return;
    state.undelivered = [...state.undelivered.slice(-19), {
      batchId: item.batchId, questionId: item.questionId, question: item.question
    }];
    notify();
  }

  /** 设计 §4.3：竞态补醒失败名单（state().lost，服务端内存账）随每次轮询并入本地
   * lostAnswers——复合键去重、被用户「知道了」消除过的键不回弹（服务端名单有
   * 上限自愈，这里的已消除集只挡重复打扰）。 */
  var dismissedLost = new Set();
  function absorbServerLost(list) {
    var changed = false;
    (Array.isArray(list) ? list : []).forEach(function (lost) {
      if (!lost || typeof lost.batchId !== "string" || typeof lost.questionId !== "string") return;
      var key = lost.batchId + "/" + lost.questionId;
      if (dismissedLost.has(key)) return;
      if (state.lostAnswers.some(function (item) { return item.batchId + "/" + item.questionId === key; })) return;
      state.lostAnswers = [...state.lostAnswers.slice(-19), {
        batchId: lost.batchId, questionId: lost.questionId, question: lost.question,
        ...(typeof lost.sessionId === "string" ? { sessionId: lost.sessionId } : {})
      }];
      changed = true;
    });
    if (changed) notify();
  }

  function readConfig() {
    var snap = scope.getSnapshot();
    var user = settingsLayerOf(snap && snap.user);
    var value = settingsLayerOf(snap && snap.value);
    var takeover = user.askTakeover !== undefined ? user.askTakeover : value.askTakeover;
    var seat = user.askUiSeat !== undefined ? user.askUiSeat : value.askUiSeat;
    return {
      enabled: takeover === true,
      seat: seat === "overlay" ? "overlay" : "sidebar",
      uiLang: uiLangOf(snap)
    };
  }

  function applyConfig(config) {
    state.enabled = config.enabled;
    state.seat = config.seat;
    state.uiLang = config.uiLang;
    if (config.enabled && timer === null) {
      // 重新开启推进代数并立即首查（设计 §4.3）：上个开启期的在途回执作废，
      // 新生命周期从当次状态起算，不等到第一个轮询间隔。
      lifecycle += 1;
      timer = window.setInterval(poll, ASK_STATE_POLL_MS);
      poll();
    } else if (!config.enabled && timer !== null) {
      // 关闭推进代数：清定时器与题目，此后到达的在途成功／失败回执都属
      // 旧代，不再写回隐藏状态。
      lifecycle += 1;
      window.clearInterval(timer);
      timer = null;
      state.items = [];
      state.serverNow = 0;
    }
  }

  function poll() {
    if (remote === undefined) return;
    var seq = ++readSeq;
    var life = lifecycle;
    remote.state().then(function (result) {
      applyRead(seq, life, result);
    }, function () {
      applyRead(seq, life, undefined);
    });
  }

  /** 状态回执的代际闸门（设计 §4.3）：旧代（关闭／重开／卸载后到达）与
   * 同代内乱序的较旧回执直接丢弃——成功不写 items／serverNow，失败也不
   * 立 callFailed:'state'（迟到失败同样不得污染新生命周期）；动作类旗标
   * 与丢失／未送达名单不在此路径，不受影响。 */
  function applyRead(seq, life, result) {
    if (life !== lifecycle || seq <= appliedReadSeq) return;
    appliedReadSeq = seq;
    if (!result || result.ok !== true) {
      // 读取失败＝'state'（下一轮轮询自动重试，文案不冒充提交失败）。
      state.callFailed = 'state';
      notify();
      return;
    }
    // 读取成功只清**自己**的失败档（'state'）——动作类旗标（'submit'/
    // 'answerRejected'/'extend'/'extendRejected'）保留到下一次同动作成功：
    // 失败处理器里的复查轮询会立即回来，无条件清会把刚立起的报错闪没。
    if (state.callFailed === 'state') state.callFailed = null;
    state.serverNow = result.value.serverNow;
    state.fetchedAt = Date.now();
    state.items = result.value.items;
    absorbServerLost(result.value.lost);
    notify();
  }

  function onVisibility() {
    if (document.visibilityState !== "visible" || !state.enabled) return;
    // 恢复可见即刻**本地**重算（需求 §4.2「展示真实期限和剩余时间」）：倒计时文本按
    // `Date.now() + skew` 现算，同步 `notify()` 让首帧就是当前剩余——不等 `poll()`
    // 的往返（宿主忙时往返可达秒级，旧值会闪现）。隐藏期间浏览器会挂起/节流页面
    // 定时器（平台行为，页面不可见时无观察者）；恢复可见的这条本地重算保证读数
    // 永远从当前时刻起算，不存在累积漂移或旧值滞留。
    notify();
    poll();
  }

  var unsubscribe = scope.subscribe(function () { applyConfig(readConfig()); notify(); });
  applyConfig(readConfig());
  // auto 档跟随宿主语言——订阅 locale 读取侧（revision 推进
  // 驱动重渲：语言切换与词典注册都会推）。只读不写（不调 setLocale）。
  var localeService = ctx.locale !== undefined && ctx.locale !== null
    && typeof ctx.locale.subscribe === "function"
    ? ctx.locale
    : null;
  var unsubscribeLocale = localeService === null
    ? null
    : localeService.subscribe(function () { notify(); });
  // headless 守卫：无 DOM 的装载环境（单测/SSR）不挂可见性监听（轮询启用仍由开关承担）。
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  var actions = {
    answer: function (item, selected, custom, onDone) {
      if (remote === undefined) { onDone(false); return; }
      remote.answer({ batchId: item.batchId, questionId: item.questionId, selected: selected, custom: custom })
        .then(function (result) {
          // 成功只有两种回执；failed（迟到注入没送达）与记录缺席的 gone
          // （undelivered，需求 §4.4）都记可消除报错名单，普通 gone 交轮询收敛。
          if (result === undefined || result === null || result.ok !== true) {
            // 失败三分——ok:false 是宿主**明确拒绝**（请求已送达、被拒）：可断定
            // 未执行；与 RPC 拒绝（'submit'，执行与否未知）分开报，不混说"未送达"。
            // 回执 error 是对象（gateway rpcFailure 契约：{code,message,details}，
            // 同一调用链的 voice-input 同款读法）——message 携带服务端拒绝原因（随
            // agentLang），透传展示，不猜因。
            state.callFailed = 'answerRejected';
            state.answerRejectReason = result.error !== undefined && result.error !== null
              && typeof result.error.message === "string" && result.error.message !== ""
              ? result.error.message : null;
            notify();
            onDone(false);
            return;
          }
          var outcome = result.value !== undefined && result.value !== null ? result.value.outcome : undefined;
          if (outcome !== "delivered" && outcome !== "late") {
            // 两种失败都进名单而非旗标：该题条目随下轮轮询出列/清空，纯旗标会连
            // 面板一起消隐（座位渲染条件只认 items/名单）。他处已落定的普通 gone 不记
            // 名——题目已有答案，交轮询收敛，不是未送达。
            if (outcome === "failed") recordLost(item);
            if (outcome === "gone" && result.value !== undefined && result.value !== null
              && result.value.undelivered === true) recordUndelivered(item);
            onDone(false);
            return;
          }
          // 成功只清**本动作族**的旗标（'submit'/'answerRejected'）——延长族
          // （'extend'/'extendRejected'）与读取档（'state'）不受牵连；丢失/未送达
          // 名单是逐条事实记录，不随成功清除（「知道了」手动消除）。
          if (state.callFailed === 'submit' || state.callFailed === 'answerRejected') {
            state.callFailed = null;
            state.answerRejectReason = null;
          }
          onDone(true);
          poll();
        }, function () {
          // RPC 拒绝＝没有确认（'submit'，可重试）——不确定结果不能断定"未送达"
          // （服务端可能已执行，只是响应丢失）。
          state.callFailed = 'submit';
          notify();
          onDone(false);
        });
    },
    ignore: function (item, onDone) {
      if (remote === undefined) { onDone(false); return; }
      remote.ignore({ batchId: item.batchId, questionId: item.questionId })
        .then(function (result) {
          if (result === undefined || result === null || result.ok !== true) {
            // 与 answer 同一分法：明确拒绝（已送达、被拒）≠ 未收到确认；error 对象
            // 的 message 同款透传（忽略路径现无服务端拒绝生产者，结构同款）。
            state.callFailed = 'answerRejected';
            state.answerRejectReason = result.error !== undefined && result.error !== null
              && typeof result.error.message === "string" && result.error.message !== ""
              ? result.error.message : null;
            notify();
            onDone(false);
            return;
          }
          var outcome = result.value !== undefined && result.value !== null ? result.value.outcome : undefined;
          if (outcome !== "delivered" && outcome !== "late") {
            if (outcome === "failed") recordLost(item);
            // 与作答同口径（需求 §4.4）：忽略提交命中记录缺席 → 未送达名单。
            if (outcome === "gone" && result.value !== undefined && result.value !== null
              && result.value.undelivered === true) recordUndelivered(item);
            onDone(false);
            return;
          }
          // 与 answer 同族：成功清提交族旗标与拒绝原因；名单不随成功清除。
          if (state.callFailed === 'submit' || state.callFailed === 'answerRejected') {
            state.callFailed = null;
            state.answerRejectReason = null;
          }
          onDone(true);
          poll();
        }, function () {
          state.callFailed = 'submit';
          notify();
          onDone(false);
        });
    },
    jump: function (sessionId) {
      ctx.uiWorkspace.openSession(sessionId);
    },
    /** 需求 §4.3：组级延长——回执 {extended:n}；成功后立即补一次轮询（新期限经
     * serverNow 校准显示，本地不猜）。失败按失败三分：明确拒绝（'extendRejected'）
     * ≠ 未收到确认（'extend'——可能已生效）。两条失败路径都立即 poll() 复查
     * 真实期限——用户据刷新后的剩余时间决定是否再点（每次点击继续累加，不伪幂等）。 */
    extendSession: function (sessionId, onDone) {
      if (remote === undefined) { if (onDone) onDone(false); return; }
      remote.extend({ sessionId: sessionId }).then(function (result) {
        var ok = result !== undefined && result !== null && result.ok === true;
        if (ok) {
          // 成功只清**本动作族**（'extend'/'extendRejected'）——提交族旗标
          // （'submit'/'answerRejected'）与读取档（'state'）不受牵连。
          if (state.callFailed === 'extend' || state.callFailed === 'extendRejected') state.callFailed = null;
          poll();
        } else {
          state.callFailed = 'extendRejected';
          notify();
          // 拒绝后也复查真期限：面板剩余时间可能与宿主不一致（批已出窗等）。
          poll();
        }
        if (onDone) onDone(ok);
      }, function () {
        state.callFailed = 'extend';
        notify();
        // 无确认也可能已生效——先 poll 复查真期限，再由用户决定是否重试。
        poll();
        if (onDone) onDone(false);
      });
    },
    /** 报错名单手动消除（「知道了」）——未读失败不算「处理完」，消除后面板
     * 回到「计数 0 消隐」口径。设计 §4.3：服务端 lost 名单里的同键条目也一并挡住
     * （已消除集），轮询不再回弹。 */
    dismissLost: function (batchId, questionId) {
      var key = batchId + "/" + questionId;
      dismissedLost.add(key);
      var next = state.lostAnswers.filter(function (lost) {
        return lost.batchId + "/" + lost.questionId !== key;
      });
      if (next.length === state.lostAnswers.length) return;
      state.lostAnswers = next;
      notify();
    },
    /** 未送达名单手动消除（「知道了」）——与报错名单同口径：未读不算「处理完」，
     * 消除后面板回到消隐口径。名单是客户端记录（服务端无此账，与 lostAnswers
     * 的服务端回弹挡不同源），再次提交同一题会重新记入（新尝试、新的未送达事实）。 */
    dismissUndelivered: function (batchId, questionId) {
      var key = batchId + "/" + questionId;
      var next = state.undelivered.filter(function (und) {
        return und.batchId + "/" + und.questionId !== key;
      });
      if (next.length === state.undelivered.length) return;
      state.undelivered = next;
      notify();
    }
  };

  return {
    store: {
      subscribe: function (listener) {
        listeners.add(listener);
        return function () { listeners.delete(listener); };
      },
      getSnapshot: function () { return state; }
    },
    actions: actions,
    locale: localeService,
    dispose: function () {
      // 卸载推进代数：卸载前在途的状态回执（成功或失败）零写入；卸载后
      // 监听已清、界面不再消费快照。
      lifecycle += 1;
      if (timer !== null) window.clearInterval(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      if (unsubscribeLocale !== null) unsubscribeLocale();
      unsubscribe();
      listeners.clear();
    }
  };
}

/** 待答面板的自有样式（只引用定义表内的别名 token，check-alias-tokens 把关）。 */
var ASK_CSS = ""
  + ".ats-ask-panel{position:fixed;right:16px;bottom:16px;z-index:10000;width:340px;"
  + "max-height:60vh;overflow:auto;box-sizing:border-box;padding:12px;"
  + "border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;"
  + "background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);"
  + "font-size:13px;line-height:1.5}"
  + ".ats-ask-title{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0 0 8px}"
  + ".ats-ask-group{border-top:.5px solid var(--dsw-alias-border-l2);padding:8px 0}"
  + ".ats-ask-grouphead{display:flex;align-items:center;gap:8px;"
  + "color:var(--dsw-alias-label-tertiary);font-size:12px}"
  + ".ats-ask-jump{margin-left:auto;background:none;border:none;cursor:pointer;"
  + "color:var(--dsw-alias-brand-primary);font-size:12px;padding:0}"
  + ".ats-ask-extend{background:none;border:.5px solid "
  + "var(--dsw-alias-border-l4);border-radius:8px;cursor:pointer;"
  + "color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:2px 8px}"
  + ".ats-ask-q{padding:6px 0}"
  + ".ats-ask-text{margin:0 0 6px}"
  + ".ats-ask-opts{display:flex;flex-direction:column;gap:4px;margin-bottom:6px}"
  + ".ats-ask-opt{display:flex;align-items:flex-start;gap:8px;text-align:left;"
  + "border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:none;"
  + "color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px;"
  + "padding:6px 8px}"
  + ".ats-ask-opt[data-selected='true']{background:var(--dsw-alias-interactive-bg-hover);"
  + "border-color:var(--dsw-alias-brand-primary)}"
  + ".ats-ask-opt:focus-visible,.ats-ask-optctl:focus-visible,"
  + ".ats-ask-custom .ats-ask-input:focus-visible"
  + "{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}"
  + ".ats-ask-mark{flex:none;width:14px;height:14px;margin-top:2px;box-sizing:border-box;"
  + "border:1.5px solid var(--dsw-alias-label-secondary);border-radius:50%}"
  + ".ats-ask-opt[data-multi='true'] .ats-ask-mark,"
  + ".ats-ask-custom[data-multi='true'] .ats-ask-mark{border-radius:4px}"
  + ".ats-ask-opt[data-selected='true'] .ats-ask-mark,"
  + ".ats-ask-custom[data-selected='true'] .ats-ask-mark"
  + "{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);"
  + "box-shadow:inset 0 0 0 2.5px var(--dsw-alias-bg-layer-3)}"
  + ".ats-ask-optbody{display:flex;flex-direction:column;gap:2px;min-width:0}"
  + ".ats-ask-optlabel{color:var(--dsw-alias-label-primary)}"
  + ".ats-ask-optdesc{color:var(--dsw-alias-label-tertiary);font-size:12px}"
  + ".ats-ask-custom{display:flex;align-items:flex-start;gap:8px;"
  + "border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:none;"
  + "padding:6px 8px}"
  + ".ats-ask-custom[data-selected='true']{background:var(--dsw-alias-interactive-bg-hover);"
  + "border-color:var(--dsw-alias-brand-primary)}"
  + ".ats-ask-optctl{display:flex;align-items:flex-start;gap:8px;background:none;"
  + "border:none;cursor:pointer;font:inherit;font-size:12px;padding:0;"
  + "color:var(--dsw-alias-label-primary)}"
  + ".ats-ask-custom .ats-ask-input{flex:1;min-width:0;margin-bottom:0}"
  + ".ats-ask-reason{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:4px 0 0}"
  + ".ats-ask-submit:disabled{opacity:.5;cursor:not-allowed}"
  + ".ats-ask-input{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);"
  + "border-radius:8px;background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:12px;"
  + "padding:6px 8px;color:var(--dsw-alias-label-primary);margin-bottom:6px}"
  + ".ats-ask-row{display:flex;align-items:center;gap:8px}"
  + ".ats-ask-submit{border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;"
  + "background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-3);"
  + "cursor:pointer;font:inherit;font-size:12px;padding:4px 12px}"
  + ".ats-ask-skip{border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;"
  + "background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;"
  + "font:inherit;font-size:12px;padding:4px 12px}"
  + ".ats-ask-left{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px}"
  + ".ats-ask-expired{color:var(--dsw-alias-state-error-primary);font-size:12px}"
  + ".ats-ask-failed{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:4px 0}"
  + ".ats-ask-dismiss{margin-left:8px;padding:0 8px;font-size:12px;"
  + "border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;"
  + "background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}"
  + ".ats-ask-badge{position:relative;border:.5px solid var(--dsw-alias-border-l4);"
  + "border-radius:8px;background:none;color:var(--dsw-alias-label-primary);"
  + "cursor:pointer;font:inherit;font-size:12px;padding:4px 10px}"
  + ".ats-ask-count{display:inline-block;min-width:16px;text-align:center;"
  + "border-radius:999px;background:var(--dsw-alias-state-error-primary);"
  + "color:var(--dsw-alias-bg-layer-3);font-size:11px;padding:1px 5px;margin-left:6px}";

/** 样式注入（一次；id 防重；headless 守卫——无 DOM 环境不碰 document）。 */
function injectAskStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById("ats-ask-styles") !== null) return;
  var element = document.createElement("style");
  element.id = "ats-ask-styles";
  element.textContent = ASK_CSS;
  document.head.appendChild(element);
}

/**
 * 单题组件（需求 §4.2.1–4.2.4）：预设选项与「自定义回答」并列作答，各自独立选中；
 * 单选互斥、多选可组合，未选中的自定义草稿不进提交；无有效答案时禁用提交并就近
 * 说明原因。剩余秒数（`expiresAt` 按宿主 `serverNow` 校准时差后本地走秒，仅显示用）。
 */
function AskItem(props) {
  var item = props.item;
  var t = props.t;
  var ask = props.ask;
  var multi = item.multiSelect === true;
  // 选择状态（需求 §4.2.1）：预设项集合 + 自定义项独立选中位。单选（multiSelect
  // 缺省 false）点任一项是**替换**并清自定义选中；多选各自切换、互不清除——
  // 与原生 user-questions 的 choose() 同语义。
  var reducer = function (state, action) {
    if (action.type === "preset") {
      if (action.multiSelect === true) {
        var next = new Set(state.presets);
        if (next.has(action.label)) next.delete(action.label); else next.add(action.label);
        return { presets: next, custom: state.custom };
      }
      return { presets: new Set([action.label]), custom: false };
    }
    if (action.type === "customOn") {
      return action.multiSelect === true
        ? { presets: state.presets, custom: true }
        : { presets: new Set(), custom: true };
    }
    if (action.type === "customOff") return { presets: state.presets, custom: false };
    return state;
  };
  var pair = React.useReducer(reducer, { presets: new Set(), custom: false });
  var selection = pair[0];
  var dispatch = pair[1];
  // 自定义草稿（需求 §4.2.2）：文本随组件保存——取消选择不清空草稿，未选中的
  // 草稿不参与提交；再次点击输入框或输入非空白文本时重新选中。
  var draftPair = React.useState("");
  var draft = draftPair[0];
  var setDraft = draftPair[1];
  var busyRef = React.useRef(false);
  var rerender = React.useState(0)[1];
  // 本地走秒（需求 §4.3「倒计时继续运行」）：显示层每秒自跳一拍，**不依赖轮询返回**——
  // 轮询挂起（宿主忙、RPC 排队）时读数照走，不再冻结在最后一次成功轮询的值上；
  // 服务端期限仍是权威，`skew` 校准在每轮成功轮询后自校。后台标签的浏览器
  // 节流只降低刷新密度，不破坏正确性（文本每次重渲都按 Date.now() 现算）。
  React.useEffect(function () {
    var ticker = window.setInterval(function () {
      rerender(function (n) { return n + 1; });
    }, 1000);
    return function () { window.clearInterval(ticker); };
  }, []);
  var skew = props.serverNow === 0 ? 0 : props.serverNow - props.fetchedAt;
  // 倒计时仅显示用（需求 §4.3）：服务端期限为权威，本地按 serverNow 校准的钟走秒。
  var leftMs = item.expiresAt - (Date.now() + skew);
  var leftText = leftMs > 0
    ? t("ask.windowLeft").replace("{s}", Math.ceil(leftMs / 1000) + " s")
    : t("ask.expired");
  // 有效性（需求 §4.2.4）：无选中项不可提交；选中的自定义文本去首尾空白后为空
  // 同样不可提交——多选已选预设项也不能掩盖。空白检查只判有效性，不改写文本。
  var hasAnswer = selection.presets.size > 0 || selection.custom;
  var customBlank = selection.custom && draft.trim() === "";
  var valid = hasAnswer && !customBlank;
  function submit() {
    if (busyRef.current || !valid) return;
    busyRef.current = true;
    rerender(function (n) { return n + 1; });
    // 载荷只含当前选中的预设项与选中且有效的自定义原文（需求 §4.2.4）。
    ask.actions.answer(
      item,
      [...selection.presets],
      selection.custom ? draft : undefined,
      function () { busyRef.current = false; rerender(function (n) { return n + 1; }); }
    );
  }
  function skip() {
    if (busyRef.current) return;
    busyRef.current = true;
    rerender(function (n) { return n + 1; });
    ask.actions.ignore(item, function () { busyRef.current = false; rerender(function (n) { return n + 1; }); });
  }
  var questionDomId = "ats-q-" + item.batchId + "-" + item.questionId;
  var optionRole = multi ? "checkbox" : "radio";
  var customOn = function () { dispatch({ type: "customOn", multiSelect: multi }); };
  var options = item.options.map(function (option) {
    var on = selection.presets.has(option.label);
    return React.createElement("button", {
      key: option.label, type: "button", className: "ats-ask-opt",
      role: optionRole, "aria-checked": on ? "true" : "false",
      "data-selected": on ? "true" : "false", "data-multi": multi ? "true" : "false",
      onClick: function () { dispatch({ type: "preset", label: option.label, multiSelect: multi }); }
    },
      React.createElement("span", { className: "ats-ask-mark", "aria-hidden": "true" }),
      React.createElement("span", { className: "ats-ask-optbody" },
        React.createElement("span", { className: "ats-ask-optlabel" }, option.label),
        typeof option.description === "string" && option.description !== ""
          ? React.createElement("span", { className: "ats-ask-optdesc" }, option.description)
          : null));
  });
  return React.createElement("div", { className: "ats-ask-q" },
    React.createElement("p", { className: "ats-ask-text", id: questionDomId }, item.question),
    React.createElement("div", {
      className: "ats-ask-opts", role: multi ? "group" : "radiogroup",
      "aria-labelledby": questionDomId
    },
      options,
      React.createElement("div", {
        key: "custom", className: "ats-ask-custom",
        "data-selected": selection.custom ? "true" : "false",
        "data-multi": multi ? "true" : "false"
      },
        React.createElement("button", {
          type: "button", className: "ats-ask-optctl", role: optionRole,
          "aria-checked": selection.custom ? "true" : "false",
          "aria-label": t("ask.customAnswer"),
          onClick: function () {
            dispatch({ type: selection.custom ? "customOff" : "customOn", multiSelect: multi });
          }
        },
          React.createElement("span", { className: "ats-ask-mark", "aria-hidden": "true" }),
          React.createElement("span", { className: "ats-ask-optlabel" }, t("ask.customAnswer"))),
        React.createElement("input", {
          className: "ats-ask-input", type: "text", value: draft,
          placeholder: t("ask.customPlaceholder"), "aria-label": t("ask.customAnswer"),
          // 点击输入框选中自定义项；键盘 Tab 聚焦不选中（需求 §4.2.2 只认点击
          // 与主动输入）。输入非空白文本同样选中（取消后的重新选中路径）。
          onClick: customOn,
          onChange: function (event) {
            var value = event.target.value;
            setDraft(value);
            if (value.trim() !== "") customOn();
          },
          onKeyDown: function (event) {
            if (event.key === "Enter") { event.preventDefault(); submit(); }
          }
        }))),
    React.createElement("div", { className: "ats-ask-row" },
      React.createElement("button", {
        type: "button", className: "ats-ask-submit", onClick: submit,
        disabled: !valid || busyRef.current
      }, t(busyRef.current ? "ask.submitting" : "ask.answer")),
      React.createElement("button", { type: "button", className: "ats-ask-skip", onClick: skip }, t("ask.ignore")),
      React.createElement("span", {
        className: item.phase === "expired" ? "ats-ask-left ats-ask-expired" : "ats-ask-left"
      }, leftText)),
    !valid && !busyRef.current
      ? React.createElement("p", { className: "ats-ask-reason" },
          t(customBlank ? "ask.needCustom" : "ask.needAnswer"))
      : null);
}

/**
 * 共享待答列表（需求 §4.2）：按会话分组（组头 = 会话 id 短式 + 跳转按钮），组内逐题
 * `AskItem`；`callFailed` 时顶部报错文案（不静默）。
 */
function AskList(props) {
  var ask = props.ask;
  var state = React.useSyncExternalStore(ask.store.subscribe, ask.store.getSnapshot);
  var t = askTranslator(state.uiLang, ask.locale);
  injectAskStyles();
  var groups = new Map();
  for (var i = 0; i < state.items.length; i += 1) {
    var item = state.items[i];
    if (!groups.has(item.sessionId)) groups.set(item.sessionId, []);
    groups.get(item.sessionId).push(item);
  }
  var nodes = [];
  groups.forEach(function (items, sessionId) {
    nodes.push(React.createElement("div", { key: sessionId, className: "ats-ask-group" },
      React.createElement("div", { className: "ats-ask-grouphead" },
        React.createElement("span", null,
          // 会话 id 一律以 "session-" 开头，裸 slice(0,8) 会让所有组头
          // 撞成同一个 "session session-"——无法区分（也会害探针点错组）。去前缀再截。
          "session " + String(sessionId).replace(/^session-/, "").slice(0, 8)),
        // 需求 §4.3：组头「增加等待时间」与既有组头动作并列——点击只发本组 sessionId，
        // 作用该组当下在窗的批次（服务端按 askExtendMs 追加，本地不猜期限）。
        React.createElement("button", {
          type: "button",
          className: "ats-ask-extend",
          "aria-label": t("ask.extend"),
          title: t("ask.extend"),
          onClick: function () { ask.actions.extendSession(sessionId); }
        }, t("ask.extend")),
        React.createElement("button", {
          type: "button", className: "ats-ask-jump",
          onClick: function () { ask.actions.jump(sessionId); }
        }, t("ask.jump"))),
      items.map(function (item) {
        return React.createElement(AskItem, {
          key: item.batchId + "/" + item.questionId, item: item, t: t, ask: ask,
          serverNow: state.serverNow, fetchedAt: state.fetchedAt
        });
      })));
  });
  return React.createElement("div", { className: "ats-ask-panel" },
    React.createElement("p", { className: "ats-ask-title" },
      t("ask.title") + " · " + t("ask.count").replace("{n}", String(state.items.length))),
    state.callFailed ? React.createElement("p", { className: "ats-ask-failed" },
      (state.callFailed === 'answerRejected'
        // 明确拒绝档：基础句＋回执携带的服务端原因串（随 agentLang 透传，不猜因）。
        ? t("ask.answerRejected") + (state.answerRejectReason ? " · " + state.answerRejectReason : "")
        : t(state.callFailed === 'state'
          ? "ask.stateFailed"
          : state.callFailed === 'extend' ? "ask.extendFailed"
          : state.callFailed === 'extendRejected' ? "ask.extendRejected"
          : "ask.callFailed"))) : null,
    state.undelivered.map(function (und) {
      // 与 lostAnswers 同款逐条「知道了」——记录已不在，报错必须被人看到，看到后
      // 可收走（需求 §4.4：未送达可见，且出路写在文案）。
      return React.createElement("p", {
        key: "undelivered-" + und.batchId + "/" + und.questionId, className: "ats-ask-failed"
      },
        t("ask.undelivered") + " · " + und.question + " ",
        React.createElement("button", {
          type: "button", className: "ats-ask-dismiss",
          onClick: function () { ask.actions.dismissUndelivered(und.batchId, und.questionId); }
        }, t("ask.dismissLost")));
    }),
    state.lostAnswers.map(function (lost) {
      // 逐条「知道了」消除——报错必须被人看到，看到后可手动收走。丢失答案
      // 用专属键（已到宿主、投递失败——不冒称未到宿主，也不建议无出路的重试）；
      // 恢复动作＝打开所属会话直接回复（需求 §4.4 失败提示的可行下一步，
      // 会话 id 在场时给跳转按钮，与组头「打开会话」同款动作）。
      return React.createElement("p", {
        key: "lost-" + lost.batchId + "/" + lost.questionId, className: "ats-ask-failed"
      },
        t("ask.lostAnswer") + " · " + lost.question + " ",
        typeof lost.sessionId === "string" ? React.createElement("button", {
          type: "button", className: "ats-ask-jump",
          onClick: function () { ask.actions.jump(lost.sessionId); }
        }, t("ask.jump")) : null,
        React.createElement("button", {
          type: "button", className: "ats-ask-dismiss",
          onClick: function () { ask.actions.dismissLost(lost.batchId, lost.questionId); }
        }, t("ask.dismissLost")));
    }),
    nodes);
}

/**
 * 座位/面板的文案翻译：`uiLang` 的 auto 档经客户端
 * `ctx.locale` 读取侧解析宿主当前语言（渲染订阅 `getSnapshot().active`、一次性读
 * `getLocale()`——返回值是快照对象，只读不写）；zh/en 走本包词典；两档之外回退
 * en 词典（「不得裸键名」护栏维持）。locale 服务缺席（旧装载环境/单测
 * 未注入）时 auto 档回退 en，不抛错。
 *
 * @param {string} uiLang - 生效的语言开关值（auto/zh/en）。
 * @param {object} [locale] - `ctx.locale` 服务（可缺席）。
 */
function askTranslator(uiLang, locale) {
  var hostLang = "auto";
  if (locale !== undefined && locale !== null) {
    var active;
    if (typeof locale.getSnapshot === "function") {
      var snapshot = locale.getSnapshot();
      if (snapshot !== undefined && snapshot !== null) active = snapshot.active;
    }
    if ((active === undefined || active === null) && typeof locale.getLocale === "function") {
      var current = locale.getLocale();
      if (current !== undefined && current !== null) active = current.active;
    }
    hostLang = active;
  }
  var lang = uiLang === "zh" || uiLang === "en" ? uiLang : hostLang;
  return makeTranslator(lang, function (key) {
    return DICTIONARIES.en[key] !== undefined ? DICTIONARIES.en[key] : key;
  });
}

/**
 * 座位渲染条件的公共口径：计数 > 0、存在未消除的 lostAnswers 或未送达名单
 * （undelivered——记录缺席的提交）才显示。failed 只发生在 expired 批迟到提交、
 * undelivered 只发生在记录缺席之后——两种形态该题条目随即不再列出，条件若只看
 * 计数，单题批次（最常见形态）的报错永不显示。未读失败不算「处理完」，消除后
 * 才回到消隐口径。
 */
function askHasFace(state) {
  return state.items.length > 0 || state.lostAnswers.length > 0 || state.undelivered.length > 0;
}

/** overlay 座位浮框（渲染条件见 askHasFace：题目与两类报错名单任一在场）。 */
function AskOverlaySeat(props) {
  var state = React.useSyncExternalStore(props.ask.store.subscribe, props.ask.store.getSnapshot);
  if (!state.enabled || state.seat !== "overlay" || !askHasFace(state)) return null;
  return React.createElement(AskList, { ask: props.ask });
}

/** sidebar 座位徽标（渲染条件见 askHasFace；徽标＝未处理数入口，点击展开题目）。 */
function AskSidebarSeat(props) {
  var state = React.useSyncExternalStore(props.ask.store.subscribe, props.ask.store.getSnapshot);
  var openRef = React.useRef(false);
  var rerender = React.useState(0)[1];
  if (!state.enabled || state.seat !== "sidebar" || !askHasFace(state)) return null;
  injectAskStyles();
  var t = askTranslator(state.uiLang, props.ask.locale);
  return React.createElement(React.Fragment, null,
    React.createElement("button", {
      type: "button", className: "ats-ask-badge",
      "aria-label": t("ask.title") + " · " + t("ask.count").replace("{n}", String(state.items.length)),
      onClick: function () { openRef.current = !openRef.current; rerender(function (n) { return n + 1; }); }
    }, t("ask.title"), React.createElement("span", { className: "ats-ask-count" }, String(state.items.length))),
    openRef.current ? React.createElement(AskList, { ask: props.ask }) : null);
}

var inject = ["slots", "locale", "configForms", "remote", "uiWorkspace"];
function apply(ctx) {
  ctx.effect(function () {
    return ctx.locale.register(NS, DICTIONARIES);
  }, "async-tools: dictionaries");
  // 宿主行在服务这个命名空间之前不注册卡片（部署无痕语义）。
  // keyed 槽：register options 必须带 `key`（缺 key 抛错）；bundle 槽的键 = **包名**。
  ctx.effect(function () {
    return ctx.configForms.whileServed([ENTRY], function () {
      return ctx.slots.inject("plugins.bundle.config", function () {
        return ctx.slots.register({
          name: "plugins.bundle.config",
          key: PACKAGE_NAME,
          locale: NS
        }, makeBundleCard(ctx));
      });
    });
  }, "async-tools: plugins.bundle.config section");

  // ── 提问接管（需求 §4.2）：remote 命名空间挂载 + 待答模型 + 两座位 ──────────
  // $mount 纯客户端：只装本地命名空间与描述符，不向宿主登记 strict
  // 定义，宿主侧 SRC 回退照常认领 `AskTakeoverService`。挂载失败只丢待答界面，
  // 不拖垮设置卡（catch 后 stderr 一行，模块照常装载）。
  // 自 mount 的命名空间**不能**直接读
  // `ctx.remote[ns]`——运行时按 inject 清单放行属性访问（"cannot get property
  // without inject"），voice-input 的成例是 `$mount` 完成后**动态**
  // `ctx.inject(['remote.' + 命名空间], …)` 拿命名空间代理。
  var askMount = ctx.remote.$mount(ASK_REMOTE);
  askMount.catch(function (error) {
    (window.console && window.console.error) && window.console.error("[dsh-async-tools] ask remote mount failed", error);
  });
  // 模块卸载时撤下命名空间（可逆卸载，需求 §7.2；seats 的处置在 seats 自己的 effect 里）。
  ctx.effect(function () {
    return function () {
      askMount.then(function (dispose) { dispose(); }, function () {});
    };
  }, "async-tools: ask remote namespace");

  /**
   * 座位 + 模型装配（拿到命名空间代理之后才可调用）。
   * @param {object} ctx - 客户端上下文。
   * @param {object} remoteNs - `remote.async-tools-ask` 命名空间代理。
   * @returns {Function} 处置器（座位注销 + 模型 dispose）。
   */
  function wireAskSeats(ctx, remoteNs) {
    var ask = createAskModel(ctx, remoteNs);
    var disposeOverlay = ctx.slots.inject("shell.overlay", function () {
      return ctx.slots.register(
        { name: "shell.overlay", id: "async-tools-ask", order: 900 },
        function () { return React.createElement(AskOverlaySeat, { ask: ask, ctx: ctx }); }
      );
    });
    var disposeSidebar = ctx.slots.inject("sidebar.footer.action", function () {
      return ctx.slots.register(
        {
          name: "sidebar.footer.action", id: "async-tools-ask",
          // label 走本包词典（读模型快照的当前语言；宿主在 locale 变更时
          // 重读 label——resolveSlotLabel 接受函数）。
          label: function () {
            return askTranslator(ask.store.getSnapshot().uiLang, ask.locale)("ask.title");
          }
        },
        function () { return React.createElement(AskSidebarSeat, { ask: ask, ctx: ctx }); }
      );
    });
    return function () {
      disposeSidebar();
      disposeOverlay();
      ask.dispose();
    };
  }

  // 待答模型与座位都在 whileServed 条件内：宿主行不服务这个命名空间时整套消失
  // （部署无痕语义与设置卡同款）。两座位**同时注册**、各自按 `askUiSeat` 与计数
  // 决定渲染 null 还是本体——座位切换是纯呈现层（宿主管道路径不随座位变）。
  ctx.effect(function () {
    return ctx.configForms.whileServed([ENTRY], function () {
      var inner = null;
      var cancelled = false;
      // 顺序：$mount 先落（失败则 seats 不装，stderr 已由 askMount.catch 记）。
      Promise.resolve(askMount).then(function () {
        if (cancelled) return;
        var ui = ctx.inject(["remote." + ASK_NAMESPACE], function (scope) {
          inner = wireAskSeats(ctx, scope.remote[ASK_NAMESPACE]);
        });
        if (ui && typeof ui.catch === "function") {
          ui.catch(function (error) {
            (window.console && window.console.error) && window.console.error("[dsh-async-tools] ask seats inject failed", error);
          });
        }
        if (ui && typeof ui.then === "function") {
          ui.then(function () {
            if (cancelled && inner !== null) { inner(); inner = null; }
          }, function () {});
        }
      }, function (error) {
        // 外层（$mount 失败 / inject 抛错）不得静默——待答界面消失必须有人在控制台看见。
        (window.console && window.console.error) && window.console.error("[dsh-async-tools] ask seats wiring failed", error);
      });
      return function () {
        cancelled = true;
        if (inner !== null) { inner(); inner = null; }
      };
    });
  }, "async-tools: ask takeover seats");
}

var name = PACKAGE_NAME;

module.exports = {
  name: name,
  inject: inject,
  apply: apply,
  formatSeconds: formatSeconds,
  draftReadout: draftReadout,
  composeHint: composeHint,
  makeBundleCard: makeBundleCard,
  makeTranslator: makeTranslator,
  uiLangOf: uiLangOf,
  enumFieldSpec: enumFieldSpec,
  flagFieldSpec: flagFieldSpec,
  makeSpecs: makeSpecs,
  FieldShell: FieldShell,
  resolveCopy: resolveCopy,
  createCardModel: createCardModel,
  makeSettingsScopeView: makeSettingsScopeView,
  settingsLayerOf: settingsLayerOf,
  createAskModel: createAskModel,
  AskList: AskList,
  AskItem: AskItem,
  AskOverlaySeat: AskOverlaySeat,
  AskSidebarSeat: AskSidebarSeat,
  askTranslator: askTranslator,
  ASK_REMOTE: ASK_REMOTE,
  ASK_NAMESPACE: ASK_NAMESPACE,
  ASK_SERVICE_KEY: ASK_SERVICE_KEY,
  ASK_STATE_POLL_MS: ASK_STATE_POLL_MS,
  passthroughCodec: passthroughCodec,
  DICTIONARIES: DICTIONARIES,
  FIELDS: FIELDS,
  /** 对账项：与 `lib/budget-limits.js` 同值（test/two-planes.test.mjs T23c 断言相等）。 */
  MS_FIELD_LIMIT: MS_FIELD_LIMIT,
  RESULT_CHARS_LIMIT: RESULT_CHARS_LIMIT,
  ASK_TIMEOUT_LIMIT: ASK_TIMEOUT_LIMIT,
  ASK_EXTEND_LIMIT: ASK_EXTEND_LIMIT,
  FIELD_MAX: FIELD_MAX,
  FIELD_MIN: FIELD_MIN,
  /** 设计 §5.4 对账项：与 `lib/budget-limits.js` 的 CHAIN_INEQUALITIES 同组（T23c 断言相等）。 */
  CHAIN_PAIRS: CHAIN_PAIRS,
  boundedNumberSpec: boundedNumberSpec,
  pairViolated: pairViolated,
  chainHitOf: chainHitOf,
  LANG_KEYS: LANG_KEYS,
  ENTRY: ENTRY,
  PACKAGE_NAME: PACKAGE_NAME,
  SLOT_NAME: "plugins.bundle.config",
  SLOT_KEY: PACKAGE_NAME
};
return module.exports; } });
