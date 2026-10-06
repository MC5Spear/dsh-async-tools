window.__ModuleLoader__.load({ id: "dsh-async-tools", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
// 异步工具的设置卡片（浏览器半边，0.1.7 形态；R27 起表单本体改用官方共享控件）。
//
// ## 形态要点（§21、§26.3.5、§29；槽位归属见裁决 §7.1-D13）
//
// - 注册进插件管理页的 **`plugins.bundle.config`** keyed 槽，槽键 = **包名**
//   = `dsh-async-tools`；宿主把它渲染在插件页的描述与组件行之间。
//   `view:"page"` 渲染表单本体；卡片壳（标题/图标/面包屑/折叠）由宿主画。
// - 表单**由官方控件组装**（§29.1 裁决 A）：`SettingsForm` 出框架（只读/不可用通告、
//   页脚唯一的保存按钮及其门控、卸载丢弃草稿），`SettingsValueField` 出值字段，
//   暂存/差集/保存全部由 `SettingsFormModel` 承担（裁决 C）——本包不再自绘草稿、
//   差集与写后回读。primitives 在冻结平台模块表里，直接 `require` 即可，
//   `dsh.client.external` 一条都不用加。
// - 模型的 scope = `ctx.configForms.get(ENTRY)` 的控制器（控制器面就是官方
//   `SettingsFormScope`——`getSnapshot`/`subscribe`/`mutate`）。bundle 槽的 owner props
//   只有 `{view}`、没有 `form`，所以卡片自取控制器；模型在构造时订阅 scope，
//   组件经 `model.bind(...)` 的快照店 + `useSyncExternalStore` 重渲染（裁决 §29.2 手术 7）。
// - 枚举字段（uiLang/agentLang）：官方导出面没有枚举控件，但语义仍注册进模型
//   （本包的 `enumFieldSpec` 形状同 `SettingsFieldSpec`），自绘的只有 select 控件本体，
//   字段壳/徽标/说明行照官方值字段同形（裁决 B、§29.2 手术 5 的两条硬条目：无覆盖时
//   下拉显示**生效值**；label `for`/控件 `id` 绑定 + `aria-describedby`/`aria-invalid`）。
// - 布尔字段（silentFailureGuard，R28）：同样"语义注册 + 壳自绘"——`flagFieldSpec`
//   形状同上，`FlagField` 壳复用 `.ats-enum-*` 类名（不新增自有 CSS），控件本体是
//   官方原语 `P.Switch`（可见标签在壳上，`Switch.label` 只作无障碍名；偏离清单第 ③ 项）。
// - 毫秒字段的秒数读数（R21/R27 + 用户裁定）长在官方说明行里，
//   **与字段说明换行**（行首不带点，样式照同机参考插件的读数行）：说明行 =
//   字段说明 + 换行 + 「生效：S s」+「 · 」+「输入：T s」。值**只写秒文本**
//   （`600 s` / `0.5 s` / 亚 10 ms 的 `< 0.01 s` / 空草稿的 `—`）——毫秒原值输入框里
//   本来就有；生效段恒显示，输入段未保存就随键入刷新，非数字/非正数时整行随官方
//   说明行换成 invalidLabel（`composeHint` 单点承担）。
// - 保存语义（裁决 C/E）：一个「保存」按钮，`!dirty || invalid || saving` 时禁用，
//   保存中显示「保存中…」；模型 `save()` 一次 `mutate(ops, baseline.revision)`，
//   布尔为假即 `failed` 并保留草稿，失败文案由官方页脚渲染；离开页面 = 卸载 =
//   丢弃草稿。成功不弹文案；字段由活 section 值回填，谎报成功没有藏身处。
//
// ## 形态约束（沿袭）
//
// - 本文件是 `window.__ModuleLoader__.load({ id, factory })` 的 **CJS 包裹**，顶层不得
//   出现 ESM 语法；UI 全部 `React.createElement`，无 JSX（浏览器侧没有转译器）。
// - 自有样式（枚举字段壳与 select 本体）只引用 `--dsw-alias-*` 里**被定义**的名字
//   （定义表 = theme 包运行时 90 个名字；`tools/check-alias-tokens.mjs` 守这条），
//   错误色一律 `--dsw-alias-state-error-primary`。失败文案的颜色跟随官方 `.failed`
//   （它引用的 `label-error` 未定义、落继承色是官方现行行为，本包不复制其颜色引用）。
var React = require("react");
var P = require("@deepseek-ai/dsh-client-ui-primitives");

/** 本插件的宿主行 id = 设置命名空间 = 槽键的行 id 段（三者必须同串）。 */
var ENTRY = "async-tools-host";
/** 包名（**平名**——客户端模块图只投递平名包）；槽键 = 包名。 */
var PACKAGE_NAME = "dsh-async-tools";
/** 词典命名空间（本插件自有）。 */
var NS = "settings.async-tools";

// 字段表：key 与宿主 Config 的 volatile 字段一一对应；ms 字段的说明行带秒数读数。
// 顺序 = `lib/config.js` 的 `BUDGET_FIELD_KEYS` 之后接 `LANG_FIELD_KEYS`，末尾接
// `FLAG_FIELD_KEYS`（R28；T19 逐项核对 + R28 增补）。
// ⚠️ `toolName` 不在表里（它不是 volatile，不可用户写——写会被宿主拒绝
// `Config field "toolName" is not volatile`，`dsh-settings/lib/index.js:507`），
// 这正是 0.1.7"volatile 才可编辑"语义的正确表达。
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
  // 两个语言开关（R25）：注册进模型的枚举 spec，控件本体是自绘 select（裁决 B）。
  { key: "uiLang", label: "uiLang", ms: false, options: ["auto", "zh", "en"] },
  { key: "agentLang", label: "agentLang", ms: false, options: ["en", "zh"] },
  // R28 静默失败防线总开关：volatile 布尔（默认 false = 三防线全不存在）。
  // 壳照 EnumField 同形（偏离清单第 ③ 项），控件本体是官方原语 Switch。
  { key: "silentFailureGuard", label: "silentFailureGuard", ms: false, flag: true },
  // R30 提问接管三字段（§32.1，裁决 R30-A）：总开关默认关 = 零行为；窗口毫秒
  // 带秒读数与上下界（10000–600000）；座位枚举 overlay|sidebar 只换呈现层。
  { key: "askTakeover", label: "askTakeover", ms: false, flag: true },
  { key: "askTimeoutMs", label: "askTimeoutMs", ms: true },
  { key: "askUiSeat", label: "askUiSeat", ms: false, options: ["overlay", "sidebar"] }
];
var FIELD_KEYS = FIELDS.map(function (field) { return field.key; });
/** 语言开关的键（R25）：`uiLang` 管本卡片文案，`agentLang` 管模型面文案。 */
var LANG_KEYS = ["uiLang", "agentLang"];

/** 数字字段 = `MS_FIELD_KEYS` 的毫秒字段 + `maxResultChars`（`numeric` 只提示键盘，合法性由 spec 定）。 */
function isNumericField(field) {
  return field.ms === true || field.key === "maxResultChars";
}

/**
 * R29-d（Q4 卡片层，挂法按该轮修复裁决 N1）：与 `lib/budget-limits.js`
 * 同组的上界/配对常量——客户端模块图只投递平名包（见文件头形态约束），**引不到
 * lib/ 下的文件**，只能内联同值；`test/two-planes.test.mjs`（T23c）的对账断言钉住
 * 两处相等，只改一处必红。
 */
var MS_FIELD_LIMIT = 2147483647;
var RESULT_CHARS_LIMIT = 1000000;
/** R30：`askTimeoutMs` 的界（§32.1；下界 10 s / 上界 10 min，与宿主 schema 同值）。 */
var ASK_TIMEOUT_LIMIT = 600000;
var FIELD_MAX = {
  defaultYieldMs: MS_FIELD_LIMIT,
  minYieldMs: MS_FIELD_LIMIT,
  maxYieldMs: MS_FIELD_LIMIT,
  defaultWaitMs: MS_FIELD_LIMIT,
  minWaitMs: MS_FIELD_LIMIT,
  maxWaitMs: MS_FIELD_LIMIT,
  pollIntervalMs: MS_FIELD_LIMIT,
  maxResultChars: RESULT_CHARS_LIMIT,
  askTimeoutMs: ASK_TIMEOUT_LIMIT
};
/** 卡片层下界（R30：只有 askTimeoutMs 有非平凡下界 10000；T23c 对账含上界）。 */
var FIELD_MIN = {
  askTimeoutMs: 10000
};

/**
 * 数值字段的越界 spec（R29-d）：包装官方 `settingsNumberField`——官方 parse 只验
 * 有限性，上界在这里补。parse 返回 `undefined` 走**官方非法通道**
 * （plan 聚合 → `state.invalid` → 保存按钮禁用），这是宿主 SettingsForm 唯一认的
 * 因果链（复审 N1：字段 props 的 `invalid` 只进显示层，不回流 shell）。
 */
function boundedNumberSpec(key) {
  var base = P.settingsNumberField(key);
  var max = FIELD_MAX[key];
  var min = FIELD_MIN[key];
  return {
    field: key,
    format: base.format,
    parse: function (text) {
      var parsed = base.parse(text);
      if (parsed !== undefined && parsed.kind === "set"
        && typeof parsed.value === "number") {
        if (parsed.value > max) return undefined;
        if (min !== undefined && parsed.value < min) return undefined;
      }
      return parsed;
    }
  };
}

/** 草稿数字（两字段都在场才判配对；空/非法草稿返回 null，不参与比较）。 */
function draftNumber(state, key) {
  var entry = state.fields[key];
  var text = entry !== undefined && typeof entry.text === "string" ? entry.text.trim() : "";
  if (text === "") return null;
  var parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 跨字段配对违例（R29-d：`pollIntervalMs` 草稿 > `maxWaitMs` 草稿）。parse 通道
 * 做不了跨字段（单字段解析时看不见别的字段）——判在壳层：`makeBundleCard` 把
 * 违例叠加进传给 `SettingsForm` 的 `state.invalid`（保存按钮随之禁用，草稿不外发），
 * 同时在 `pollIntervalMs` 字节显示层给原因文案。
 */
function pairViolated(state) {
  var poll = draftNumber(state, "pollIntervalMs");
  var max = draftNumber(state, "maxWaitMs");
  return poll !== null && max !== null && poll > max;
}

/**
 * 枚举字段的转换 spec（裁决 B）：形状同官方 `SettingsFieldSpec`
 * （`form-model.d.ts:65-76`），语义不自绘——暂存、覆盖态与校验仍走模型。
 *
 * `format` 把生效值原样作为草稿文本（无覆盖时快照的 `value` 层就是生效值 ⇒ 下拉显示
 * 生效值而不是空选项，N2 的缺陷形态）；`parse` 把空草稿判清除、
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
 * 布尔字段的转换 spec（R28，偏离 ③）：形状与语义同 `enumFieldSpec`，只是值域是
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
 * 模型装配：8 个数字字段（官方 `settingsNumberField`）+ 2 个文本字段
 * （官方 `settingsTextField`）+ 2 个枚举字段（本包 `enumFieldSpec`）+ 1 个布尔
 * 字段（本包 `flagFieldSpec`，R28）。字段键集合必须与 `FIELDS` 逐项相等
 * （§29.4 的装配断言）。
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
 * 毫秒 → 秒读数（R21）：`20000 → "20 s"`、`1500 → "1.5 s"`、`250 → "0.25 s"`；
 * **亚 10 毫秒的正数显示 `< 0.01 s`**（R27 增补：正数不得读成 `0 s`，也不留空——
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
 * 输入段读数（裁决 D 定则 4 的三姿态）：正数 → 秒文本；空文本 → `—` 占位；
 * 非数字/非正数（`0`、负数）→ `—` 占位 + 非法标记。最后一种姿态下官方说明行整体
 * 换成 invalidLabel，标记只在说明行仍显示的路径上有意义，作为防御保留。
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
 * 字段说明（毫秒字段带两段秒读数，R21/R27 + 用户裁定）：说明行 =
 * 字段说明**换行**接 `生效：{v} · 输入：{v}`（样式照同机参考插件的读数行：
 * 行首不带点、与字段说明分行；值只写秒文本——毫秒原值输入框里本来就有）。
 * - 生效段恒显示（值 = 生效值 user ?? 组合 ?? 默认）；
 * - 输入段取**模型当前的暂存文本**（未保存就随键入刷新——模型 `edit → publish` 免费给了
 *   重渲染），三姿态见 `draftReadout`；
 * - 两段恒显示（相等也不隐藏——"时而有时而无"会被读成坏了）；非毫秒字段无读数；
 * - 只读态同样渲染（判据 11：控件禁用，读数仍在）；
 * - 不拆独立段落（官方 `.field + .field` 的分隔链会被打散）、不新增自有 CSS——官方
 *   `.hint` 与参考包读数行的度量一致（12px / label-tertiary）。
 * @param {Function} t - 文案函数。
 * @param {{key: string, ms?: boolean}} field - 字段表项。
 * @param {number} effectiveMs - 生效毫秒值。
 * @param {string} stagedText - 模型当前的暂存文本（未暂存时 = 生效值的格式化）。
 * @returns {string|Array} 非毫秒字段 = 说明文本；毫秒字段 = 说明行的 children
 *   （`[说明, 换行, 生效段, " · ", 输入段]`）。
 */
function composeHint(t, field, effectiveMs, stagedText) {
  var hint = t("hint." + field.key);
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

// 枚举字段的样式（唯一一处自有样式）：壳与 select 本体的度量逐项照官方
// `fields.module.css`（34px / 13px / 8px 圆角 / bg-layer-3 / .5px border-l4 / focus
// brand-primary / 禁用 label-tertiary / 非法 state-error-primary），select 的修饰照
// `dsh-client-ui-settings-models` 的成例（appearance:none + 右侧 chevron +
// padding-right:32px）。只引用定义表内的 token。
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
  + ".ats-enum-select{height:34px;padding:0 12px;padding-right:32px;"
  + "border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;"
  + "background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;"
  + "color:var(--dsw-alias-label-primary);appearance:none;"
  + "background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' "
  + "width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' "
  + "stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E"
  + "%3C/svg%3E\");background-position:right 12px center;background-repeat:no-repeat;"
  + "background-size:12px 12px}"
  + ".ats-enum-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}"
  + ".ats-enum-select:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}"
  + ".ats-enum-select[aria-invalid='true']{border-color:var(--dsw-alias-state-error-primary)}"
  + ".ats-enum-message{margin:0;font-size:12px;line-height:1.5;"
  + "color:var(--dsw-alias-label-tertiary)}"
  + ".ats-enum-message[aria-invalid='true']{color:var(--dsw-alias-state-error-primary)}";

if (typeof document !== "undefined" && document.getElementById("dsh-async-tools-enum-style") === null) {
  var styleEl = document.createElement("style");
  styleEl.id = "dsh-async-tools-enum-style";
  styleEl.textContent = ENUM_CSS;
  document.head.appendChild(styleEl);
}

/**
 * 枚举字段（自绘的只有控件本体，裁决 B）：结构照官方 `SettingsValueField`——
 * 字段列（label 行 + 覆盖徽标 + 整行控件 + 说明/错误行），控件是原生 select 元素。
 *
 * 两条硬条目（§29.2 手术 5）：① 无覆盖时下拉显示**生效值**——`text` 未暂存时来自
 * 模型对 `format(sectionValue)` 的取值，而快照 `value` 层就是生效值；② label 的 `for`
 * 与控件的 `id` 绑定、说明/错误经 `aria-describedby` 关联、非法态带 `aria-invalid`
 * （与官方值字段同形）。
 *
 * @param {object} props - 字段文案与状态（形状对齐官方值字段）+ `options`/`optionLabel`。
 * @returns {object} React 元素。
 */
function EnumField(props) {
  var messageId = props.id + "-message";
  var hasMessage = props.invalid === true || Boolean(props.hint);
  return React.createElement("div", { className: "ats-enum-field", key: props.fieldKey },
    React.createElement("div", { className: "ats-enum-head" },
      React.createElement("div", { className: "ats-enum-labelGroup" },
        React.createElement("label", { className: "ats-enum-label", htmlFor: props.id }, props.label)),
      props.overridden === true ? React.createElement("span", { className: "ats-enum-badges" },
        React.createElement(P.Tag, { tone: "neutral" }, props.overriddenLabel),
        React.createElement("button", {
          type: "button", className: "ats-enum-reset", disabled: props.disabled,
          onClick: props.onReset
        }, props.resetLabel)) : null),
    React.createElement("select", {
      id: props.id,
      className: "ats-enum-select",
      "aria-invalid": props.invalid === true ? true : undefined,
      "aria-describedby": hasMessage ? messageId : undefined,
      value: props.text,
      disabled: props.disabled,
      onChange: function (event) { props.onEdit(event.target.value); }
    }, props.options.map(function (option) {
      return React.createElement("option", { key: option, value: option },
        props.optionLabel(option));
    })),
    hasMessage ? React.createElement("p", {
      id: messageId,
      className: "ats-enum-message",
      "aria-invalid": props.invalid === true ? true : undefined
    }, props.invalid === true ? props.invalidLabel : props.hint) : null);
}

/**
 * 布尔字段（R28，偏离 ③）：壳照 `EnumField` 同形（label 行 + 覆盖徽标 + 控件 +
 * 说明行，复用同一组 `.ats-enum-*` 类名，**不新增自有 CSS**），控件本体是官方原语
 * `P.Switch`（`checked`/`onChange`/`label`/`disabled`/`title`/`className`）。
 *
 * 可访问性分工（照 settings-subagent 的模型 toggle 行成例）：**可见标签长在壳上**，
 * `Switch` 的 `label` prop 传同一标签串——它只落到 `aria-label`（primitives 的
 * `Switch` 不渲染可见文本），是开关的无障碍名。`Switch` 不收 `id`/`aria-*` 摆位，
 * 所以枚举字段那组 `htmlFor`/`aria-describedby` 绑定在这里不适用；说明行仍渲染
 * （视觉提示不变），`invalid` 分支是防御性的（`"true"`/`"false"` 之外无草稿文本）。
 *
 * @param {object} props - 字段文案与状态（形状对齐 `EnumField`，去掉 options 面）。
 * @returns {object} React 元素。
 */
function FlagField(props) {
  var messageId = props.id + "-message";
  var hasMessage = props.invalid === true || Boolean(props.hint);
  return React.createElement("div", { className: "ats-enum-field", key: props.fieldKey },
    React.createElement("div", { className: "ats-enum-head" },
      React.createElement("div", { className: "ats-enum-labelGroup" },
        React.createElement("div", { className: "ats-enum-label" }, props.label)),
      props.overridden === true ? React.createElement("span", { className: "ats-enum-badges" },
        React.createElement(P.Tag, { tone: "neutral" }, props.overriddenLabel),
        React.createElement("button", {
          type: "button", className: "ats-enum-reset", disabled: props.disabled,
          onClick: props.onReset
        }, props.resetLabel)) : null),
    React.createElement(P.Switch, {
      checked: props.text === "true",
      label: props.label,
      disabled: props.disabled,
      onChange: function (next) { props.onEdit(next ? "true" : "false"); }
    }),
    hasMessage ? React.createElement("p", {
      id: messageId,
      className: "ats-enum-message",
      "aria-invalid": props.invalid === true ? true : undefined
    }, props.invalid === true ? props.invalidLabel : props.hint) : null);
}

/**
 * 生效的 `uiLang`（R25）：用户层在场就用它，否则用实时解析值，再否则 `"auto"`。
 * @param {object|undefined} snapshot - 控制器快照。
 * @returns {string} `"auto" | "zh" | "en"`。
 */
function uiLangOf(snapshot) {
  var user = snapshot !== undefined && snapshot !== null && snapshot.user ? snapshot.user : {};
  var value = snapshot !== undefined && snapshot !== null && snapshot.value ? snapshot.value : {};
  var lang = user.uiLang !== undefined ? user.uiLang : value.uiLang;
  return lang === "zh" || lang === "en" ? lang : "auto";
}

/**
 * 选文案函数（R25）：`"auto"` 用宿主 locale 的 `props.t`（现行行为）；`"zh"` / `"en"` 用本包
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
  for (var i = 0; i < FIELDS.length; i += 1) {
    var field = FIELDS[i];
    state.fields[field.key] = model.field(field.key);
    if (field.ms === true) {
      state.effective[field.key] = snapshot.value === undefined || snapshot.value === null
        ? undefined
        : snapshot.value[field.key];
    }
  }
  return state;
}

/**
 * 建卡片模型：控制器交给官方 `SettingsFormModel`，`bind` 只调一次（§29.2 手术 7），
 * 返回 `{model, store, dispose}`——`dispose` 解除模型对 scope 的订阅（手术 8）。
 *
 * @param {object} ctx - 客户端上下文（`configForms` 由 inject 声明）。
 * @returns {object} 卡片模型句柄。
 */
function createCardModel(ctx) {
  var scope = ctx.configForms.get(ENTRY);
  var model = new P.SettingsFormModel(scope, makeSpecs());
  var store = model.bind(function () { return projectCardState(model, scope); });
  return {
    model: model,
    store: store,
    dispose: function () { model.dispose(); }
  };
}

/**
 * 渲染 `FIELDS` 里的全部字段（四组现取）：值字段用官方 `SettingsValueField`，
 * 枚举字段用本包 `EnumField`，布尔字段用本包 `FlagField`（官方 Switch 控件本体）；
 * `id = "plugin-config-" + key`；毫秒字段的说明行带秒数读数。
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
    if (field.flag === true) {
      return React.createElement(FlagField, {
        fieldKey: field.key, id: id, label: t(field.label), hint: hint,
        overridden: fieldState.overridden, overriddenLabel: t("overridden"),
        resetLabel: t("reset"), invalid: fieldState.invalid, invalidLabel: t("invalidNumber"),
        disabled: !state.shell.writable, text: fieldState.text,
        onEdit: function (text) { actions.edit(field.key, text); },
        onReset: function () { actions.resetField(field.key); }
      });
    }
    if (field.options !== undefined) {
      return React.createElement(EnumField, {
        fieldKey: field.key, id: id, label: t(field.label), hint: hint,
        overridden: fieldState.overridden, overriddenLabel: t("overridden"),
        resetLabel: t("reset"), invalid: fieldState.invalid, invalidLabel: t("invalidNumber"),
        disabled: !state.shell.writable, text: fieldState.text,
        options: field.options,
        optionLabel: function (option) { return t("opt." + field.key + "." + option); },
        onEdit: function (text) { actions.edit(field.key, text); },
        onReset: function () { actions.resetField(field.key); }
      });
    }
    // R29-d：数值字段的非法原因分三档——越上界（spec parse 判非法后的可读版）、
    // 配对违例（壳层判，pollIntervalMs 字段显示）、官方"不是数字"。
    var outOfRange = false;
    var belowRange = false;
    var pairHit = false;
    if (isNumericField(field)) {
      var draftNum = draftNumber(state, field.key);
      outOfRange = fieldState.invalid === true && draftNum !== null && draftNum > FIELD_MAX[field.key];
      belowRange = fieldState.invalid === true && draftNum !== null
        && FIELD_MIN[field.key] !== undefined && draftNum < FIELD_MIN[field.key];
      if (field.key === "pollIntervalMs") pairHit = pairViolated(state);
    }
    var invalidLabel = outOfRange
      ? t("invalidRange").replace("{max}", String(FIELD_MAX[field.key]))
      : belowRange ? t("invalidBelow").replace("{min}", String(FIELD_MIN[field.key]))
      : pairHit ? t("invalidPair.pollIntervalMs") : t("invalidNumber");
    return React.createElement(P.SettingsValueField, {
      key: field.key, id: id, label: t(field.label), hint: hint,
      overridden: fieldState.overridden, overriddenLabel: t("overridden"),
      resetLabel: t("reset"), invalid: fieldState.invalid === true || pairHit,
      invalidLabel: invalidLabel,
      numeric: isNumericField(field), disabled: !state.shell.writable,
      text: fieldState.text,
      onEdit: function (text) { actions.edit(field.key, text); },
      onReset: function () { actions.resetField(field.key); }
    });
  });
}

/**
 * 插件页卡片工厂：模型每挂载建一次、卸载时 `dispose`（手术 8）；重渲染走
 * `useSyncExternalStore(card.store.subscribe, card.store.getSnapshot)`（手术 7）。
 * `SettingsForm` 的 `onDiscard` 接模型的 `discard`——卸载丢弃草稿由它承担（判据 9）。
 * @param ctx - 客户端上下文（`configForms` 由 inject 声明）。
 * @returns 槽位组件。
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
      // R29-d（复审 N1 挂法）：跨字段配对违例叠加在传给 SettingsForm 的
      // `state.invalid` 上——宿主保存禁用只认这条链（`blocked = !dirty ||
      // state.invalid || saving`）；不包 save（save 仍是官方模型的动作）。
      state: { ...state.shell, invalid: state.shell.invalid === true || pairViolated(state) },
      onSave: actions.save,
      onDiscard: actions.discard
    }, makeFieldNodes(state, card.model, t));
  };
}

/** 词典：字段键即标签键、`hint.<键>` 为字段说明、`opt.<键>.<选项>` 为枚举选项文案；
 *  zh 为主，en 对照（`ctx.locale.register`；两语言键集必须一致，R25）。 */
var DICTIONARIES = {
  zh: {
    title: "异步工具",
    summary: "async_run / async_wait_job / async_wait_agent 的预算与后端",
    unavailable: "设置命名空间尚未服务：宿主行未加载，或设置服务不可用。",
    readOnly: "当前部署只读：设置不可修改。",
    save: "保存",
    saving: "保存中…",
    saveFailed: "保存没有生效：宿主拒绝了本次写入，草稿已保留，可调整后再试。",
    overridden: "已覆盖",
    reset: "恢复默认",
    invalidNumber: "这个值不是该字段可接受的输入",
    invalidRange: "超出该字段的上界（≤ {max}）",
    invalidBelow: "低于该字段的下界（≥ {min}）",
    "invalidPair.pollIntervalMs": "轮询间隔不能大于等待预算上限（maxWaitMs）——请调小本值或调大 maxWaitMs",
    defaultYieldMs: "默认让出预算（毫秒）",
    minYieldMs: "让出预算下限（毫秒）",
    maxYieldMs: "让出预算上限（毫秒）",
    defaultWaitMs: "默认等待预算（毫秒）",
    minWaitMs: "等待预算下限（毫秒）",
    maxWaitMs: "等待预算上限（毫秒）",
    pollIntervalMs: "兜底轮询间隔（毫秒）",
    maxResultChars: "输出字符上限",
    jobKind: "后台作业 kind（jobKind）",
    subagentProvider: "子代理后端（async_agent）",
    uiLang: "设置表单语言（uiLang）",
    agentLang: "模型面文案语言（agentLang）",
    silentFailureGuard: "静默失败防线（silentFailureGuard）",
    askTakeover: "提问接管（askTakeover）",
    askTimeoutMs: "提问等待窗口（毫秒）",
    askUiSeat: "待答界面座位（askUiSeat）",
    "hint.defaultYieldMs": "async_run 不带预算时的让出毫秒数。",
    "hint.minYieldMs": "让出预算的下界。",
    "hint.maxYieldMs": "让出预算的上界。",
    "hint.defaultWaitMs": "两个等待工具不带预算时的等待毫秒数。",
    "hint.minWaitMs": "等待预算的下界。",
    "hint.maxWaitMs": "等待预算的上界。",
    "hint.pollIntervalMs": "事件等待的兜底轮询间隔。",
    "hint.maxResultChars": "工具输出超出该字符数会被截断。",
    "hint.jobKind": "后台作业的 kind 标签。",
    "hint.subagentProvider": "async_agent 派发子代理的后端。",
    "hint.uiLang": "本卡片文案的语言。",
    "hint.agentLang": "模型面文案（工具描述等）的语言。",
    "hint.silentFailureGuard": "开启后注入执行纪律段与静默失败警示，关闭则三防线全部消失（默认关）。",
    "hint.askTakeover": "开启后接管本包两预设的 ask_user_question：在浏览器待答界面作答，窗口耗尽自动放行（默认关 = 原生行为）。",
    "hint.askTimeoutMs": "提问的等待窗口；耗尽后放行并给模型合成空选答案，迟到作答以通知注入送达。",
    "hint.askUiSeat": "待答界面长在哪里：overlay = 右下角浮框；sidebar = 侧栏底栏徽标。",
    "opt.askUiSeat.overlay": "右下角浮框（默认）",
    "opt.askUiSeat.sidebar": "侧栏底栏徽标",
    "ask.title": "待答问题",
    "ask.count": "{n} 题待答",
    "ask.answer": "提交",
    "ask.ignore": "不答",
    "ask.customPlaceholder": "补充说明（可选）",
    "ask.jump": "打开会话",
    "ask.expired": "已超时，仍可作答",
    "ask.submitting": "提交中…",
    "ask.callFailed": "提交没有送达（宿主侧失败），请重试。",
    "ask.dismissLost": "知道了",
    "ask.windowLeft": "剩 {s}",
    "ask.paused": "已暂停",
    "ask.pause": "暂停计时",
    "ask.resume": "恢复计时",
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
    summary: "Budgets and backends for async_run / async_wait_job / async_wait_agent",
    unavailable: "The settings namespace is not served: the host row is not loaded, or the settings service is unavailable.",
    readOnly: "This deployment stores settings read-only: they cannot be changed here.",
    save: "Save",
    saving: "Saving…",
    saveFailed: "The save did not land: the host refused this write; the drafts are kept for another try.",
    overridden: "Overridden",
    reset: "Reset",
    invalidNumber: "This text is not a value the field accepts",
    invalidRange: "This value exceeds the field's upper bound (≤ {max})",
    invalidBelow: "This value is below the field's lower bound (≥ {min})",
    "invalidPair.pollIntervalMs": "The poll interval must not exceed the wait budget upper bound (maxWaitMs) — lower this value or raise maxWaitMs",
    defaultYieldMs: "Default yield budget (ms)",
    minYieldMs: "Yield budget lower bound (ms)",
    maxYieldMs: "Yield budget upper bound (ms)",
    defaultWaitMs: "Default wait budget (ms)",
    minWaitMs: "Wait budget lower bound (ms)",
    maxWaitMs: "Wait budget upper bound (ms)",
    pollIntervalMs: "Fallback poll interval (ms)",
    maxResultChars: "Output character cap",
    jobKind: "Background job kind (jobKind)",
    subagentProvider: "Subagent provider (async_agent)",
    uiLang: "Settings form language (uiLang)",
    agentLang: "Model-facing text language (agentLang)",
    silentFailureGuard: "Silent-failure defenses (silentFailureGuard)",
    askTakeover: "Question takeover (askTakeover)",
    askTimeoutMs: "Question wait window (ms)",
    askUiSeat: "Pending-answer seat (askUiSeat)",
    "hint.defaultYieldMs": "Milliseconds async_run yields when no budget is given.",
    "hint.minYieldMs": "Lower bound of yield budgets.",
    "hint.maxYieldMs": "Upper bound of yield budgets.",
    "hint.defaultWaitMs": "Milliseconds the wait tools use when no budget is given.",
    "hint.minWaitMs": "Lower bound of wait budgets.",
    "hint.maxWaitMs": "Upper bound of wait budgets.",
    "hint.pollIntervalMs": "Fallback polling interval of the event wait.",
    "hint.maxResultChars": "Tool output beyond this many characters is truncated.",
    "hint.jobKind": "Kind label of background jobs.",
    "hint.subagentProvider": "Backend async_agent dispatches subagents through.",
    "hint.uiLang": "Language of this card's copy.",
    "hint.agentLang": "Language of model-facing text (tool descriptions and such).",
    "hint.silentFailureGuard": "When on, adds the execution-discipline block and silent-failure warnings; when off, all three defenses are absent (off by default).",
    "hint.askTakeover": "When on, takes over ask_user_question in this package's two presets: answer in the browser pending UI; a spent window releases the turn (off by default = native behavior).",
    "hint.askTimeoutMs": "Wait window per question; when it runs out the turn is released with synthesized empty answers, and late answers arrive as a notice injection.",
    "hint.askUiSeat": "Where the pending UI lives: overlay = bottom-right floating panel; sidebar = sidebar footer badge.",
    "opt.askUiSeat.overlay": "Bottom-right overlay (default)",
    "opt.askUiSeat.sidebar": "Sidebar footer badge",
    "ask.title": "Pending questions",
    "ask.count": "{n} pending",
    "ask.answer": "Submit",
    "ask.ignore": "Skip",
    "ask.customPlaceholder": "Additional note (optional)",
    "ask.jump": "Open session",
    "ask.expired": "Timed out; still answerable",
    "ask.submitting": "Submitting…",
    "ask.callFailed": "The submission did not reach the host; please retry.",
    "ask.dismissLost": "Dismiss",
    "ask.windowLeft": "{s} left",
    "ask.paused": "Paused",
    "ask.pause": "Pause timer",
    "ask.resume": "Resume timer",
    "readout.effective": "Effective: {v}",
    "readout.input": "Input: {v}",
    "opt.uiLang.auto": "Follow interface language",
    "opt.uiLang.zh": "中文",
    "opt.uiLang.en": "English",
    "opt.agentLang.en": "English (default)",
    "opt.agentLang.zh": "中文"
  }
};

// ── R30 提问接管的待答界面（§32.4/§32.6）────────────────────────────────
//
// 通道：状态 = 轮询自有 typert remote 命名空间（1000 ms，模块 dispose 清除）；
// 作答/忽略 = `answer`/`ignore` 直调（载荷**裸传**，客户端按 wire 名组装
// 位置参数）；回执 `{ok,value|error}`（voice-input 同款判法）。总开关关 → 模型停轮询、
// 两座位渲染 null——零行为。

/** 轮询间隔（裁决 R30-E；requirements §5 登记 ASK_STATE_POLL_MS）。 */
var ASK_STATE_POLL_MS = 1000;
/** 命名空间与服务键（§32.6；与宿主 `lib/ask-takeover.js` 同串，J-15 对账）。 */
var ASK_NAMESPACE = "async-tools-ask";
var ASK_SERVICE_KEY = "asyncToolsAsk";

/**
 * 透传 strict codec（手写形态）。真机实测教训：`$mount` 会走
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
 * **参数名**逐字一致（`submission`）——J-15 双断言：参数名对齐 + 假 RPC 载荷单层包裹。
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
      id: "dsh-async-tools#async-tools-ask/pause",
      service: ASK_SERVICE_KEY, namespace: ASK_NAMESPACE, method: "pause",
      invocation: { kind: "direct" },
      parameters: [{ name: "submission", wire: "submission", source: "json", codec: passthroughCodec("dsh-async-tools#ask-submission") }],
      result: passthroughCodec("dsh-async-tools#async-tools-ask/pause:result"),
      sourceLocation: { file: "lib/ask-takeover.js" }
    },
    {
      id: "dsh-async-tools#async-tools-ask/resume",
      service: ASK_SERVICE_KEY, namespace: ASK_NAMESPACE, method: "resume",
      invocation: { kind: "direct" },
      parameters: [{ name: "submission", wire: "submission", source: "json", codec: passthroughCodec("dsh-async-tools#ask-submission") }],
      result: passthroughCodec("dsh-async-tools#async-tools-ask/resume:result"),
      sourceLocation: { file: "lib/ask-takeover.js" }
    }
  ]
};

/**
 * 待答模型：订阅设置 scope 读 `askTakeover`/`askUiSeat`/`uiLang`（生效值 = 用户层
 * ?? 组合层 ?? 默认），开关开时轮询 `state()`。`visibilitychange → visible` 与每次
 * answer/ignore 动作后立即补一次轮询；后台标签页由浏览器节流，不做可见性门控
 * （§32.4：晚到总比停了好）。
 *
 * 失败面不静默：RPC 回执 `{ok:false}` → `callFailed` 旗标（面板顶报错，
 * 可重试）；宿主回执 `outcome:'failed'`（迟到注入 followup/inject 抛错、条目已
 * 出列）→ 记入 `lostAnswers`（面板顶列名报错——那一条用户的答案没有送达，且
 * 无重试通道 §32.5）。竞态补醒失败（§32.6）经 `state().lost` 名单随轮询并入——
 * 两个时点共用同一复合键去重与「知道了」消除（消除后服务端名单不回弹）。
 *
 * @param {object} ctx - 客户端上下文（configForms/uiWorkspace 由 inject 声明）。
 * @param {object} remote - ask 命名空间代理（`ctx.inject(['remote.async-tools-ask'])`
 *   拿到的——自 mount 的命名空间**不能**直接读 `ctx.remote[ns]`，运行时要求先 inject，
 *   否则 "cannot get property without inject" 每秒炸一次轮询——真机实测教训）。
 * @returns {{store: object, actions: object, dispose: Function}} 快照店 + 动作 + 处置。
 */
function createAskModel(ctx, remote) {
  var scope = ctx.configForms.get(ENTRY);
  var listeners = new Set();
  var timer = null;
  var seq = 0;
  var state = {
    enabled: false, seat: "overlay", uiLang: "auto",
    serverNow: 0, fetchedAt: 0, items: [], callFailed: false, lostAnswers: []
  };

  function notify() {
    seq += 1;
    state = { ...state }; // 引用稳定到下一次变更（useSyncExternalStore 的口径）
    listeners.forEach(function (listener) { listener(); });
  }

  /** 没送达的迟到答案记进面板（复合键 batchId/questionId——模型自命名
   * 的 questionId 跨批次会撞，单 questionId 会吞掉第二条丢失）。名单计入座位
   * 渲染门——条目出列后面板不消失，报错必须被人看到并手动消除。 */
  function recordLost(item) {
    var key = item.batchId + "/" + item.questionId;
    if (state.lostAnswers.some(function (lost) { return lost.batchId + "/" + lost.questionId === key; })) return;
    state.lostAnswers = [...state.lostAnswers.slice(-19), {
      batchId: item.batchId, questionId: item.questionId, question: item.question
    }];
    notify();
  }

  /** §32.6：竞态补醒失败名单（state().lost，服务端内存账）随每次轮询并入本地
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
        batchId: lost.batchId, questionId: lost.questionId, question: lost.question
      }];
      changed = true;
    });
    if (changed) notify();
  }

  function readConfig() {
    var snap = scope.getSnapshot();
    var user = snap && snap.user ? snap.user : {};
    var value = snap && snap.value ? snap.value : {};
    var takeover = user.askTakeover !== undefined ? user.askTakeover : value.askTakeover;
    var seat = user.askUiSeat !== undefined ? user.askUiSeat : value.askUiSeat;
    return {
      enabled: takeover === true,
      seat: seat === "sidebar" ? "sidebar" : "overlay",
      uiLang: uiLangOf(snap)
    };
  }

  function applyConfig(config) {
    state.enabled = config.enabled;
    state.seat = config.seat;
    state.uiLang = config.uiLang;
    if (config.enabled && timer === null) {
      timer = window.setInterval(poll, ASK_STATE_POLL_MS);
    } else if (!config.enabled && timer !== null) {
      window.clearInterval(timer);
      timer = null;
      state.items = [];
      state.serverNow = 0;
    }
  }

  function poll() {
    if (remote === undefined) return;
    remote.state().then(function (result) {
      if (!result || result.ok !== true) {
        state.callFailed = true;
        notify();
        return;
      }
      state.callFailed = false;
      state.serverNow = result.value.serverNow;
      state.fetchedAt = Date.now();
      state.items = result.value.items;
      absorbServerLost(result.value.lost);
      notify();
    }, function () {
      state.callFailed = true;
      notify();
    });
  }

  function onVisibility() {
    if (document.visibilityState === "visible" && state.enabled) poll();
  }

  var unsubscribe = scope.subscribe(function () { applyConfig(readConfig()); notify(); });
  applyConfig(readConfig());
  if (state.enabled) poll();
  // R30-c 修正：auto 档跟随宿主语言——订阅 locale 读取面（revision 推进
  // 驱动重渲：语言切换与词典注册都会推）。只读不写（不调 setLocale）。
  var localeService = ctx.locale !== undefined && ctx.locale !== null
    && typeof ctx.locale.subscribe === "function"
    ? ctx.locale
    : null;
  var unsubscribeLocale = localeService === null
    ? null
    : localeService.subscribe(function () { notify(); });
  // headless 守卫：无 DOM 的装载环境（单测/SSR）不挂可见性监听（轮询门控仍由开关承担）。
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  var actions = {
    answer: function (item, selected, custom, onDone) {
      if (remote === undefined) { onDone(false); return; }
      remote.answer({ batchId: item.batchId, questionId: item.questionId, selected: selected, custom: custom })
        .then(function (result) {
          // 成功只有两种回执；failed（迟到注入没送达）记名报错，gone 交给轮询收敛。
          if (result === undefined || result === null || result.ok !== true) { onDone(false); return; }
          var outcome = result.value !== undefined && result.value !== null ? result.value.outcome : undefined;
          if (outcome !== "delivered" && outcome !== "late") {
            if (outcome === "failed") recordLost(item);
            onDone(false);
            return;
          }
          onDone(true);
          poll();
        }, function () { onDone(false); });
    },
    ignore: function (item, onDone) {
      if (remote === undefined) { onDone(false); return; }
      remote.ignore({ batchId: item.batchId, questionId: item.questionId })
        .then(function (result) {
          if (result === undefined || result === null || result.ok !== true) { onDone(false); return; }
          var outcome = result.value !== undefined && result.value !== null ? result.value.outcome : undefined;
          if (outcome !== "delivered" && outcome !== "late") {
            if (outcome === "failed") recordLost(item);
            onDone(false);
            return;
          }
          onDone(true);
          poll();
        }, function () { onDone(false); });
    },
    jump: function (sessionId) {
      ctx.uiWorkspace.openSession(sessionId);
    },
    /** R36-c：会话级暂停/恢复——回执 {outcome:'paused'|'resumed'}；成功后立即补一次
     * 轮询（items 的 paused 标记与冻结的 expiresAt 来自服务端，本地不猜）。 */
    pauseSession: function (sessionId, onDone) {
      if (remote === undefined) { if (onDone) onDone(false); return; }
      remote.pause({ sessionId: sessionId }).then(function (result) {
        var ok = result !== undefined && result !== null && result.ok === true;
        if (ok) poll();
        if (onDone) onDone(ok);
      }, function () { if (onDone) onDone(false); });
    },
    resumeSession: function (sessionId, onDone) {
      if (remote === undefined) { if (onDone) onDone(false); return; }
      remote.resume({ sessionId: sessionId }).then(function (result) {
        var ok = result !== undefined && result !== null && result.ok === true;
        if (ok) poll();
        if (onDone) onDone(ok);
      }, function () { if (onDone) onDone(false); });
    },
    /** 报错名单手动消除（「知道了」）——未读失败不算「处理完」，消除后面板
     * 回到「计数 0 消隐」口径。§32.6：服务端 lost 名单里的同键条目也一并挡住
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
  + ".ats-ask-pause,.ats-ask-resume{background:none;border:.5px solid "
  + "var(--dsw-alias-border-l4);border-radius:8px;cursor:pointer;"
  + "color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:2px 8px}"
  + ".ats-ask-q{padding:6px 0}"
  + ".ats-ask-text{margin:0 0 6px}"
  + ".ats-ask-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}"
  + ".ats-ask-chip{border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;"
  + "background:none;color:var(--dsw-alias-label-primary);cursor:pointer;"
  + "font:inherit;font-size:12px;padding:3px 10px}"
  + ".ats-ask-chip[aria-pressed='true']{border-color:var(--dsw-alias-brand-primary);"
  + "color:var(--dsw-alias-brand-primary)}"
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
 * 单题组件：选项 chips（多选 toggle；无 options 的题只渲染自定义输入）、补充输入、
 * 提交/忽略、剩余秒数（`expiresAt` 按宿主 `serverNow` 校准时差后本地走秒，仅显示用）。
 */
function AskItem(props) {
  var item = props.item;
  var t = props.t;
  var ask = props.ask;
  // multiSelect=false（缺省）时点第二个 chip 是**替换**，不是叠加——与原生
  // user-questions 的 choose() 同语义；multiSelect=true 才是 toggle。
  var reducer = function (set, action) {
    if (action.multiSelect === true) {
      var next = new Set(set);
      if (next.has(action.label)) next.delete(action.label); else next.add(action.label);
      return next;
    }
    return new Set([action.label]);
  };
  var pair = React.useReducer(reducer, new Set());
  var selected = pair[0];
  var dispatch = pair[1];
  var customRef = React.useRef(null);
  var busyRef = React.useRef(false);
  var rerender = React.useState(0)[1];
  var skew = props.serverNow === 0 ? 0 : props.serverNow - props.fetchedAt;
  // R36：暂停项冻结倒计时并示「已暂停」——不做 serverNow 折算（expiresAt 是暂停
  // 时刻冻结的到期点，恢复平移后才恢复推进）。
  var leftMs = item.paused === true ? Infinity : item.expiresAt - (Date.now() + skew);
  var leftText = item.paused === true
    ? t("ask.paused")
    : leftMs > 0
      ? t("ask.windowLeft").replace("{s}", Math.ceil(leftMs / 1000) + " s")
      : t("ask.expired");
  function submit() {
    if (busyRef.current) return;
    busyRef.current = true;
    rerender(function (n) { return n + 1; });
    ask.actions.answer(
      item,
      [...selected],
      customRef.current !== null && customRef.current.value !== "" ? customRef.current.value : undefined,
      function () { busyRef.current = false; rerender(function (n) { return n + 1; }); }
    );
  }
  function skip() {
    if (busyRef.current) return;
    busyRef.current = true;
    rerender(function (n) { return n + 1; });
    ask.actions.ignore(item, function () { busyRef.current = false; rerender(function (n) { return n + 1; }); });
  }
  var chips = item.options.map(function (option) {
    return React.createElement("button", {
      key: option.label, type: "button", className: "ats-ask-chip",
      "aria-pressed": selected.has(option.label) ? "true" : "false",
      onClick: function () { dispatch({ label: option.label, multiSelect: item.multiSelect === true }); }
    }, option.label);
  });
  return React.createElement("div", { className: "ats-ask-q" },
    React.createElement("p", { className: "ats-ask-text" }, item.question),
    chips.length > 0 ? React.createElement("div", { className: "ats-ask-chips" }, chips) : null,
    React.createElement("input", {
      ref: customRef, className: "ats-ask-input", type: "text",
      placeholder: t("ask.customPlaceholder")
    }),
    React.createElement("div", { className: "ats-ask-row" },
      React.createElement("button", { type: "button", className: "ats-ask-submit", onClick: submit },
        t(busyRef.current ? "ask.submitting" : "ask.answer")),
      React.createElement("button", { type: "button", className: "ats-ask-skip", onClick: skip }, t("ask.ignore")),
      React.createElement("span", {
        className: item.phase === "expired" ? "ats-ask-left ats-ask-expired" : "ats-ask-left"
      }, leftText)
    )
  );
}

/**
 * 共享待答列表（§32.4）：按会话分组（组头 = 会话 id 短式 + 跳转按钮），组内逐题
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
    // R36：组级暂停态取组内条目的一致标记（服务端按会话置位/清除）。
    var groupPaused = items.some(function (item) { return item.paused === true; });
    nodes.push(React.createElement("div", { key: sessionId, className: "ats-ask-group" },
      React.createElement("div", { className: "ats-ask-grouphead" },
        React.createElement("span", null,
          // 真机实测教训：会话 id 一律以 "session-" 开头，裸 slice(0,8) 让所有组头
          // 撞成同一个 "session session-"——无法区分（也害探针点错组）。去前缀再截。
          "session " + String(sessionId).replace(/^session-/, "").slice(0, 8)),
        React.createElement("button", {
          type: "button",
          className: groupPaused ? "ats-ask-resume" : "ats-ask-pause",
          "aria-label": t(groupPaused ? "ask.resume" : "ask.pause"),
          title: t(groupPaused ? "ask.resume" : "ask.pause"),
          onClick: function () {
            if (groupPaused) ask.actions.resumeSession(sessionId);
            else ask.actions.pauseSession(sessionId);
          }
        }, t(groupPaused ? "ask.resume" : "ask.pause")),
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
    state.callFailed ? React.createElement("p", { className: "ats-ask-failed" }, t("ask.callFailed")) : null,
    state.lostAnswers.map(function (lost) {
      // 逐条「知道了」消除——报错必须被人看到，看到后可手动收走。
      return React.createElement("p", {
        key: "lost-" + lost.batchId + "/" + lost.questionId, className: "ats-ask-failed"
      },
        t("ask.callFailed") + " · " + lost.question + " ",
        React.createElement("button", {
          type: "button", className: "ats-ask-dismiss",
          onClick: function () { ask.actions.dismissLost(lost.batchId, lost.questionId); }
        }, t("ask.dismissLost")));
    }),
    nodes);
}

/**
 * 座位/面板的文案翻译（R30-c 修正）：`uiLang` 的 auto 档经客户端
 * `ctx.locale` 读取面解析宿主当前语言（渲染订阅 `getSnapshot().active`、一次性读
 * `getLocale()`——返回值是快照对象，只读不写）；zh/en 走本包词典；两档之外回退
 * en 词典（「不得裸键名」护栏维持）。locale 服务缺席（旧装载环境/单测
 * 未注入）时 auto 档回退 en——与修正前行为一致，不抛错。
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
 * 座位渲染门的公共口径：计数 > 0 **或** 存在未消除的 lostAnswers 才有脸。
 * failed 只发生在 expired 批迟到提交，该题随即出列——门若只看计数，单题批次（最常见
 * 形态）的报错名单永不显示。未读失败不算「处理完」，消除后才回到消隐口径。
 */
function askHasFace(state) {
  return state.items.length > 0 || state.lostAnswers.length > 0;
}

/** overlay 座位（默认）：开关开 + 座位 overlay + 有脸（见 askHasFace）才渲染浮框。 */
function AskOverlaySeat(props) {
  var state = React.useSyncExternalStore(props.ask.store.subscribe, props.ask.store.getSnapshot);
  if (!state.enabled || state.seat !== "overlay" || !askHasFace(state)) return null;
  return React.createElement(AskList, { ask: props.ask });
}

/** sidebar 座位：开关开 + 座位 sidebar + 有脸（见 askHasFace）渲染自绘徽标按钮。 */
function AskSidebarSeat(props) {
  var state = React.useSyncExternalStore(props.ask.store.subscribe, props.ask.store.getSnapshot);
  var openRef = React.useRef(false);
  var rerender = React.useState(0)[1];
  if (!state.enabled || state.seat !== "sidebar" || !askHasFace(state)) return null;
  injectAskStyles();
  var t = askTranslator(state.uiLang);
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

  // ── R30 提问接管（§32.4）：remote 命名空间挂载 + 待答模型 + 两座位 ──────────
  // $mount 纯客户端：只装本地命名空间与描述符，不向宿主登记 strict
  // 定义，宿主侧 SRC 回退照常认领 `AskTakeoverService`。挂载失败只丢待答界面，
  // 不拖垮设置卡（catch 后 stderr 一行，模块照常装载）。
  // 真机实测教训（②两连红的根因）：自 mount 的命名空间**不能**直接读
  // `ctx.remote[ns]`——运行时按 inject 清单放行属性访问（"cannot get property
  // without inject"），voice-input 的成例是 `$mount` 完成后**动态**
  // `ctx.inject(['remote.' + 命名空间], …)` 拿命名空间代理。
  var askMount = ctx.remote.$mount(ASK_REMOTE);
  askMount.catch(function (error) {
    (window.console && window.console.error) && window.console.error("[dsh-async-tools] ask remote mount failed", error);
  });
  // 模块卸载时撤下命名空间（R4 可逆；seats 的处置在 seats 自己的 effect 里）。
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

  // 待答模型与座位都在 whileServed 门内：宿主行不服务这个命名空间时整套消失
  // （部署无痕语义与设置卡同款）。两座位**同时注册**、各自按 `askUiSeat` 与计数
  // 决定渲染 null 还是本体——座位切换是纯呈现层（J16：宿主管道路径不随座位变）。
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
  EnumField: EnumField,
  FlagField: FlagField,
  createCardModel: createCardModel,
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
  /** R29-d 对账面：与 `lib/budget-limits.js` 同值（test/two-planes.test.mjs T23c 断言相等）。 */
  MS_FIELD_LIMIT: MS_FIELD_LIMIT,
  RESULT_CHARS_LIMIT: RESULT_CHARS_LIMIT,
  ASK_TIMEOUT_LIMIT: ASK_TIMEOUT_LIMIT,
  FIELD_MAX: FIELD_MAX,
  FIELD_MIN: FIELD_MIN,
  boundedNumberSpec: boundedNumberSpec,
  pairViolated: pairViolated,
  LANG_KEYS: LANG_KEYS,
  ENTRY: ENTRY,
  PACKAGE_NAME: PACKAGE_NAME,
  SLOT_NAME: "plugins.bundle.config",
  SLOT_KEY: PACKAGE_NAME
};
return module.exports; } });
