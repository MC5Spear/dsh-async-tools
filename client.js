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
// - 字段壳统一自绘（设计 §5.5）：19 个普通字段共用 `FieldShell`。官方
//   `SettingsValueField` 有每字段 `help` prop（自定义可访问名＋任意 JSX 展开
//   正文，官方子代理设置页在用），但帮助图标硬编码 `IconInfoOutlineRegular`
//   （带圈 i、size 12），无图标／样式配置，改不成需求 5.6 的带圈问号；枚举／
//   布尔字段官方没有字段壳，毫秒双段读数也放不进官方单段纯文本 `hint`——值
//   字段一并转入统一壳；第 20 个字段 `boundPresets`（预设功能绑定，需求 9.4）
//   不用壳——它是复选框块 `PresetBindingBlock`，渲染在表单末尾、走同一模型与
//   保存链。官方件继续在场：`SettingsForm`／`SettingsFormModel`／
//   `settingsNumberField`／`settingsTextField`（模型 spec）、
//   `P.Tag`／`P.IconQuestionOutlineRegular`（徽标与图标）。布尔开关自绘
//   （UI-SETTINGS-AX：官方 `P.Switch` 只收 checked/onChange/label/disabled/
//   title/className，摆不下 `id`／`aria-describedby`，做不了需求 §5.4 的
//   label `for`/控件 `id` 绑定与说明关联——见 §5.5 字段壳注）。
// - 模型的 scope = `ctx.configForms.get(ENTRY)` 的控制器（控制器就是官方
//   `SettingsFormScope`——`getSnapshot`/`subscribe`/`mutate`）。bundle 槽的 owner props
//   只有 `{view}`、没有 `form`，所以卡片自取控制器；模型在构造时订阅 scope，
//   组件经 `model.bind(...)` 的快照存储 + `useSyncExternalStore` 重渲染（bind 只调一次）。
// - 枚举字段（uiLang/agentLang/askUiSeat）与布尔字段（silentFailureGuard/
//   askTakeover/workflowProgressLog/fullCommandEcho——防线总开关、提问接管
//   与两个展示开关）：语义注册进模型（`enumFieldSpec`/`flagFieldSpec` 形状同
//   `SettingsFieldSpec`），控件本体分别是原生 select 与**自绘** role="switch"
//   按钮，壳与帮助由 `FieldShell` 统一承担（设计 §5.5 的两条强制条目：无覆盖
//   时下拉显示**生效值**；label `for`/控件 `id` 绑定 + `aria-describedby`/
//   `aria-invalid` 对四形态**全部成立**——UI-SETTINGS-AX 修正：官方
//   `P.Switch` 收不了 id 与 aria 关联，布尔开关自绘：`id` 供壳上 label `for`
//   绑定，`aria-label`＝可见标签、`aria-describedby`＝说明/错误/帮助行、
//   `aria-invalid` 标非法；度量与 token 逐项照官方 primitives 药丸＋滑块，
//   焦点环同源、键盘激活走原生 button 的 Enter/Space）。
// - 帮助（需求 5.5/5.6）：每个字段标签旁带圈问号按钮（官方
//   `IconQuestionOutlineRegular`），点击在字段下方展开 `help.<键>` 正文、再点收起；
//   开合只存 `FieldShell` 局部 state，不碰草稿/保存/mutate；缺键回退＝按钮/说明行
//   退场（`resolveCopy`）。20 字段的键组在场断言（标签/hint/help 三前缀两档齐全，
//   含 `boundPresets` 的三个同前缀键）由 test/two-planes.test.mjs 的 T18c 在场
//   断言循环守；两语界面词典（`DICTIONARIES.zh/en`）的键集一致性由同文件 T21
//   直接断言守——tools/check-model-text.mjs 的键集层只读 lib/text.js（模型词典，
//   扫描范围明确不含 client.js），不覆盖界面词典，别按它报漏检界面键集。
// - 毫秒字段的秒数读数（需求 §5.4）长在说明行里，
//   **与字段说明换行**（行首不带点——设置页读数行统一形态）：说明行 =
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

// 字段表：key 与宿主 Config 的 settings 子树字段一一对应（设计 §5.1：20 个
// 可编辑字段全在子树里，值投影展平在 `settings` 键下，经 makeSettingsScopeView
// 适配成官方模型的平铺寻址）；ms 字段的说明行带秒数读数。
// 顺序 = 设计 §5.3 六组组序（需求 5.5/5.7.4：适用预设 → 待答问题 → 命令与等待
// → 发送给 Agent 的内容 → 高级设置 → 语言）；与 `lib/config.js` 六个键组的对账
// 从「顺序拼接」改为「键集相等」（two-planes T19）。静默失败与两个展示开关字段
// 在列。
// `toolName` 不在表里（它在根的非 volatile 固定路径，不可用户写——写会被宿主拒绝
// `Config field "toolName" is not volatile`，`dsh-settings/lib/index.js:507`），
// 这正是「volatile 子树才可编辑」语义的正确表达。
var FIELDS = [
  // ── 适用预设组（boundPresets：多选名单，经 PresetBindingBlock，不走壳）──
  { key: "boundPresets", label: "boundPresets", ms: false, binding: true },
  // ── 待答问题组：面板开关与问题出现位置首屏可见；等待与加时在子组 ──
  { key: "askTakeover", label: "askTakeover", ms: false, flag: true },
  { key: "askUiSeat", label: "askUiSeat", ms: false, options: ["sidebar", "overlay"] },
  // 窗口毫秒带秒读数与上下界（10000–600000）；延长毫秒带秒读数与上下界
  //（1–2^31-1，设计 §4.2）；座位枚举 sidebar|overlay 只换呈现层，选项序
  //[sidebar, overlay] 与默认标记位（需求 §5.2/5.5：默认 sidebar）。
  { key: "askTimeoutMs", label: "askTimeoutMs", ms: true },
  { key: "askExtendMs", label: "askExtendMs", ms: true },
  // ── 命令与等待组：首次等待默认值与上下限同置、单次等待范围、仅用于示例的
  //    时长、备用状态检查间隔；四「—」字段（两组上下限）无字段级 hint/help ──
  { key: "defaultYieldMs", label: "defaultYieldMs", ms: true },
  { key: "minYieldMs", label: "minYieldMs", ms: true },
  { key: "maxYieldMs", label: "maxYieldMs", ms: true },
  { key: "minWaitMs", label: "minWaitMs", ms: true },
  { key: "maxWaitMs", label: "maxWaitMs", ms: true },
  { key: "defaultWaitMs", label: "defaultWaitMs", ms: true },
  { key: "pollIntervalMs", label: "pollIntervalMs", ms: true },
  // ── 发送给 Agent 的内容组 ──
  { key: "maxResultChars", label: "maxResultChars", ms: false },
  { key: "workflowProgressLog", label: "workflowProgressLog", ms: false, flag: true },
  { key: "fullCommandEcho", label: "fullCommandEcho", ms: false, flag: true },
  // ── 高级设置组 ──
  { key: "subagentProvider", label: "subagentProvider", ms: false },
  { key: "jobKind", label: "jobKind", ms: false },
  { key: "silentFailureGuard", label: "silentFailureGuard", ms: false, flag: true },
  // ── 语言组：两个语言开关（注册进模型的枚举 spec，控件本体是自绘 select）──
  { key: "uiLang", label: "uiLang", ms: false, options: ["auto", "zh", "en"] },
  { key: "agentLang", label: "agentLang", ms: false, options: ["en", "zh"] }
];
var FIELD_KEYS = FIELDS.map(function (field) { return field.key; });
var FIELD_BY_KEY = {};
for (var fieldIndex = 0; fieldIndex < FIELDS.length; fieldIndex += 1) {
  FIELD_BY_KEY[FIELDS[fieldIndex].key] = FIELDS[fieldIndex];
}
/** 语言开关的键：`uiLang` 管本卡片文案，`agentLang` 管面向模型的文案（需求 §5.3）。 */
var LANG_KEYS = ["uiLang", "agentLang"];

// 六组折叠结构（设计 §5.3）：组 id＝词典「group.组id」的键尾，也进 DOM id
//（section「plugin-config-group-组id」）；默认开合——适用预设/待答问题/语言展开，
// 命令与等待/发送给 Agent 的内容/高级设置收起；待答子组「等待与加时」收起。
var GROUPS = [
  { id: "presets", open: true, fields: ["boundPresets"] },
  { id: "ask", open: true, fields: ["askTakeover", "askUiSeat"],
    subgroup: { id: "askTimes", open: false, fields: ["askTimeoutMs", "askExtendMs"] } },
  { id: "budget", open: false,
    fields: ["defaultYieldMs", "minYieldMs", "maxYieldMs", "minWaitMs", "maxWaitMs", "defaultWaitMs", "pollIntervalMs"] },
  { id: "agentContent", open: false, fields: ["maxResultChars", "workflowProgressLog", "fullCommandEcho"] },
  { id: "advanced", open: false, fields: ["subagentProvider", "jobKind", "silentFailureGuard"] },
  { id: "lang", open: true, fields: ["uiLang", "agentLang"] }
];
/** 组级展开帮助的键序（设计 §5.6：仅 5.7.5 第二表有原文行的组；语言组无按钮）。 */
var GROUP_HELP_KEYS = {
  presets: ["groupHelp.presets.emptyList"],
  ask: ["groupHelp.ask.lateAnswer"],
  budget: ["groupHelp.budget.firstWaitExample", "groupHelp.budget.ranges"],
  agentContent: ["groupHelp.agentContent.chars", "groupHelp.agentContent.shared"],
  advanced: ["groupHelp.advanced.backend"]
};
/** budget 组内小节落位：共用说明行渲染在对应首字段之前（§5.3 组级常驻说明）。 */
var GROUP_HINT_BEFORE = {
  budget: { defaultYieldMs: "groupHint.budget.firstWait", minWaitMs: "groupHint.budget.singleWait" }
};
/** 字段 → 所在组（含子组成员）的索引。 */
var FIELD_GROUP_INDEX = {};
for (var groupIndex = 0; groupIndex < GROUPS.length; groupIndex += 1) {
  var groupDef = GROUPS[groupIndex];
  for (var memberIndex = 0; memberIndex < groupDef.fields.length; memberIndex += 1) {
    FIELD_GROUP_INDEX[groupDef.fields[memberIndex]] = { group: groupDef, subgroup: null };
  }
  if (groupDef.subgroup !== undefined) {
    for (var subIndex = 0; subIndex < groupDef.subgroup.fields.length; subIndex += 1) {
      FIELD_GROUP_INDEX[groupDef.subgroup.fields[subIndex]] = { group: groupDef, subgroup: groupDef.subgroup };
    }
  }
}
/** 卡片开合状态的键（六组 + 待答子组 + 「选择预设」入口）。 */
function initialOpenState() {
  var open = {};
  for (var i = 0; i < GROUPS.length; i += 1) open[GROUPS[i].id] = GROUPS[i].open;
  open.askTimes = false;
  open.presetsEntry = false;
  return open;
}

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
 * 链式比较的「候选不可知」哨兵（设计 §5.4 第三档）：清覆盖形态下 base 层
 * 值不可得（客户端投影缺席该层或该字段）——候选＝取消覆盖后按 5.1 优先级
 * 重取的组合层值或 schema 默认，客户端不可算。该侧跳过客户端比较，保存不
 * 因此禁用，终判在服务端。
 */
var CHAIN_UNKNOWN = { chainUnknown: true };

/**
 * 链式比较值（设计 §5.4 三档，UI-CLEAR-03）：**有效草稿 → 草稿值**（覆盖与
 * 生效值的任意组合都以草稿为准——只判一侧草稿会把"把上限改小"漏成可保存）；
 * **原始用户层含该字段键（userHas 位）→ 清覆盖候选＝base 层回退值**（清字段
 * 后按 5.1 优先级重取的组合层，即恢复默认将写入的真实值；base 不可得 →
 * `CHAIN_UNKNOWN` 交服务端终判）——判定**不经字段级 overridden 标志**：该
 * 标志是官方模型对「暂存后生效来源」的预演，暂存清除后即翻转为 false，而
 * 原始用户键仍在场（保存落定前 unset 未发生），据该位判「无覆盖」会回退旧
 * 生效快照比较（unset＝重新继承组合层，不是保留旧覆盖）。
 * **无用户键 → 生效值**（无草稿条目或空草稿均＝无改动）。非法草稿属单字段
 * 档（返回 null，该侧不参与链式比较——非法性由单字段校验报出、保存随之
 * 禁用，链式不叠加）。
 */
function chainNumber(state, key) {
  var entry = state.fields === undefined ? undefined : state.fields[key];
  var hasDraftText = entry !== undefined && typeof entry.text === "string"
    && entry.text.trim() !== "";
  if (hasDraftText) return draftNumber(state, key);
  if (state.userHas !== undefined && state.userHas[key] === true) {
    var baseValue = state.base === undefined ? undefined : state.base[key];
    return typeof baseValue === "number" && Number.isFinite(baseValue) ? baseValue : CHAIN_UNKNOWN;
  }
  var source = state.effective === undefined || state.effective === null ? {} : state.effective;
  var effective = source[key];
  return typeof effective === "number" && Number.isFinite(effective) ? effective : null;
}

/** 链式比较的参与判据（设计 §5.4）：null＝单字段档缺席；UNKNOWN＝候选不可知——两种都不参与比较。 */
function chainComparable(value) {
  return value !== null && value !== CHAIN_UNKNOWN;
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
    if (chainComparable(left) && chainComparable(right) && left > right) return true;
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
    if (chainComparable(left) && chainComparable(right) && left > right) return CHAIN_PAIRS[i][1];
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
 * 预设绑定字段的转换 spec（需求 9.4，照 enum/flag 的 spec 契约形状）：值＝
 * 预设 ID 数组，草稿文本＝数组的 JSON 串（`format` 物化、`parse` 校验回收）。
 *
 * - `format`：数组原样 JSON 串；非数组（含降级态 describe 出来的损坏原值）
 *   折回 `'[]'`——复选框块按空草稿渲染，损坏值不在草稿层爆开；
 * - `parse`：空文本判清除（恢复默认＝unset 只清用户覆盖；生效值按配置优先级
 *   重取——组合层仍配置时优先生效，组合层与用户覆盖都不在时才是 schema 默认
 *   两预设）；JSON
 *   解析后必须是**无重复的非空字符串数组**（与服务端 `resolveConfig` 同判据，
 *   需求 9.4.3 空数组合法＝解除全部绑定）；其余判非法（undefined → 官方非法
 *   通道 → 保存禁用）。复选框 UI 结构上不产生重复，这层校验防程序化写入口；
 * - 勾选操作走模型的 `edit(key, 新JSON串)`：块内解码当前草稿、切换成员、
 *   重新编码回写——暂存/差集/保存与其他字段同机制。
 *
 * @param {string} key - 字段键（boundPresets）。
 * @returns {object} `SettingsFieldSpec` 形状的 spec。
 */
function presetBindingFieldSpec(key) {
  return {
    field: key,
    format: function (value) {
      return JSON.stringify(Array.isArray(value) ? value : []);
    },
    parse: function (text) {
      var trimmed = text.trim();
      if (trimmed === "") return { kind: "clear" };
      var parsed;
      try { parsed = JSON.parse(trimmed); } catch (error) { return undefined; }
      if (!Array.isArray(parsed)) return undefined;
      var seen = {};
      for (var i = 0; i < parsed.length; i += 1) {
        var id = parsed[i];
        if (typeof id !== "string" || id.length === 0) return undefined;
        if (Object.prototype.hasOwnProperty.call(seen, id)) return undefined;
        seen[id] = true;
      }
      return { kind: "set", value: parsed };
    }
  };
}

/** 解码绑定字段的草稿文本为 ID 数组（非法/非数组 JSON 折回空数组——块内渲染
 * 用的宽容版；保存合法性由 spec.parse 的严格版把守）。
 * @param {string|undefined} text - 模型暂存文本。
 * @returns {string[]} 草稿名单。 */
function decodeBoundDraft(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  var parsed;
  try { parsed = JSON.parse(text); } catch (error) { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(function (id) { return typeof id === "string" && id.length > 0; });
}

/**
 * 模型装配：按 `FIELDS` 的字段形态逐项选 spec——数字字段与文本字段用官方
 * spec（`settingsNumberField`：毫秒预算 + `maxResultChars` + 提问接管两窗口；
 * `settingsTextField`：`jobKind`/`subagentProvider`）、枚举字段用本包
 * `enumFieldSpec`（两个语言开关 + 座位）、布尔字段用本包 `flagFieldSpec`
 * （静默失败防线、提问接管与两个展示开关共四个开关）、绑定字段用本包
 * `presetBindingFieldSpec`（预设功能绑定）。字段键集合与顺序必须与 `FIELDS`
 * 逐项相等（卡片装配断言钉住）；各类字段增减不维护本注释的计数——
 * 总数以 `FIELDS` 为单一来源。
 *
 * @returns {object[]} spec 列表（顺序 = FIELDS 顺序）。
 */
function makeSpecs() {
  var specs = [];
  for (var i = 0; i < FIELDS.length; i += 1) {
    var field = FIELDS[i];
    if (field.binding === true) specs.push(presetBindingFieldSpec(field.key));
    else if (field.flag === true) specs.push(flagFieldSpec(field.key));
    else if (field.options !== undefined) specs.push(enumFieldSpec(field.key, field.options));
    else if (isNumericField(field)) specs.push(boundedNumberSpec(field.key));
    else specs.push(P.settingsTextField(field.key));
  }
  return specs;
}

/**
 * 毫秒 → 秒数的数值文本（需求 §5.4）：`20000 → "20"`、`1500 → "1.5"`、
 * `250 → "0.25"`；整数秒无小数、非整数最多两位小数。**亚 10 毫秒的正数**与
 * 非有限正数返回空串（调用方按 `readout.subSecond`／占位处理）。
 * 单位与短句由词典提供（`readout.secondsUnit`／`readout.subSecond`，需求
 * 5.7.4 秒数读数行）——渲染层不再硬编码 `s`。
 * @param {number} ms - 毫秒值。
 * @returns {string} 秒数的数值文本；无法换算时空串。
 */
function secondsNumber(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 10) return "";
  var s = ms / 1000;
  var trimmed = Number.isInteger(s) ? s : Number(s.toFixed(2));
  return String(trimmed);
}

/**
 * 毫秒值 → 秒读数词（含单位/短句，词典键化）：正数 ≥10 ms → `{数值} 秒`／
 * `{数值} s`；亚 10 毫秒正数 → `小于 0.01 秒`／`Less than 0.01 s`；无法换算
 * （非有限正数）→ null（调用方按「未知／—」占位）。
 */
function secondsWord(t, ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 10) return t("readout.subSecond");
  return t("readout.secondsUnit").replace("{数值}", secondsNumber(ms));
}

/** 读数占位（空草稿/不可换算）：读数行统一用 `—`（字面量标点，不经词典）。 */
var READOUT_PLACEHOLDER = "—";

/**
 * 输入段读数（三姿态）：正数 → 秒读数词；空文本 → `—` 占位；
 * 非数字/非正数（`0`、负数、亚 10 毫秒外的不可换算文本）→ `—` 占位 + 非法
 * 标记。非法标记供字段外壳消费（输入段标红、另加非法原因行），常驻说明行与
 * 两段读数保留。
 * @param {Function} t - 文案函数（秒读数词的单位键化）。
 * @param {string} stagedText - 模型暂存文本。
 * @returns {{fill: string, invalid: boolean}} 输入段的值与非法标记。
 */
function draftReadout(t, stagedText) {
  var text = stagedText === undefined || stagedText === null ? "" : String(stagedText).trim();
  if (text === "") return { fill: READOUT_PLACEHOLDER, invalid: false };
  var word = secondsWord(t, Number(text));
  if (word === null) return { fill: READOUT_PLACEHOLDER, invalid: true };
  return { fill: word, invalid: false };
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
 * 字段说明（毫秒字段带两段秒读数，需求 §5.4/5.7.4）：说明行 =
 * 字段说明**换行**接 `生效：{值} · 待保存：{值}`（读数行统一形态：
 * 行首不带点、与字段说明分行；值只写秒文本——毫秒原值输入框里本来就有）。
 * - 生效段：生效值可核实 → 秒读数词；不可核实 → `readout.unknown`（未知）；
 * - 输入段取**模型当前的暂存文本**（未保存就随键入刷新——模型 `edit → publish`
 *   免费给了重渲染），三姿态见 `draftReadout`（空/非法 → `—` 字面量占位）；
 * - 两段恒显示（相等也不隐藏——"时而有时而无"会被读成坏了）；非毫秒字段无读数；
 * - **读数行独立于字段说明**（设计 §5.4）：`hint.<键>` 缺席（四「—」字段）时
 *   说明行退场、读数行仍在——返回不含说明文本的读数行数组，而不是 undefined；
 * - 只读态同样渲染（控件禁用，读数仍在）；
 * - 非毫秒字段的缺键回退（设计 §5.5）：`hint.<键>` 缺席/裸键名时整行退场。
 * @param {Function} t - 文案函数。
 * @param {{key: string, ms?: boolean}} field - 字段表项。
 * @param {number} effectiveMs - 生效毫秒值。
 * @param {string} stagedText - 模型当前的暂存文本（未暂存时 = 生效值的格式化）。
 * @returns {string|Array|undefined} 非毫秒字段 = 说明文本；毫秒字段 = 说明行的 children
 *   （`[说明, 换行, 生效段, " · ", 输入段]`，无说明时为读数行后四段）；缺键 = undefined。
 */
function composeHint(t, field, effectiveMs, stagedText) {
  var hint = resolveCopy(t, "hint." + field.key);
  if (field.ms !== true) return hint;
  var effectiveWord = secondsWord(t, effectiveMs);
  if (effectiveWord === null) effectiveWord = t("readout.unknown");
  var draft = draftReadout(t, stagedText);
  var readoutRow = [
    React.createElement("br", { key: "br" }),
    React.createElement("span", { key: "effective", className: "ats-sec-effective" },
      t("readout.current").replace("{值}", effectiveWord)),
    " · ",
    React.createElement("span", {
      key: "input",
      className: draft.invalid ? "ats-sec-input ats-sec-invalid" : "ats-sec-input"
    }, t("readout.unsaved").replace("{值}", draft.fill))
  ];
  if (hint === undefined) return readoutRow;
  return [hint].concat(readoutRow);
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
  // 自绘开关（UI-SETTINGS-AX／设计 §5.4/§5.5）：度量与 token 逐项照官方
  // primitives 的药丸＋滑块（36×20、padding 2、thumb 16、位移 16、0.12s）——
  // 关/开轨道 border-l3/brand-primary、关态滑块 switch-thumb、开态滑块
  // label-primary-foreground、禁用 opacity .5、focus-visible 外廓与官方同源
  //（--dsw-focus-ring-* 不是 alias 族，引用处带回退缺省值）。全部引用定义表内
  //（check-alias-tokens 把关）；corner-shape 是渐进增强，不支持时退回普通圆角。
  + ".ats-switch{box-sizing:border-box;position:relative;flex:0 0 auto;"
  + "align-self:flex-start;width:36px;height:20px;padding:2px;border:0;"
  + "border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);"
  + "cursor:pointer}"
  + ".ats-switch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}"
  + ".ats-switch:disabled{cursor:default;opacity:.5}"
  + ".ats-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid "
  + "var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));"
  + "outline-offset:2px}"
  + ".ats-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;"
  + "corner-shape:round;background:var(--dsw-alias-label-primary-foreground);"
  + "transition:transform .12s ease}"
  + ".ats-switch[aria-checked='false'] .ats-switch-thumb{"
  + "background:var(--dsw-alias-switch-thumb)}"
  + ".ats-switch[aria-checked='true'] .ats-switch-thumb{transform:translate(16px)}"
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
  // VIS-CONTRAST-01：常驻说明是 12px 普通文字，label-tertiary 在浅底实测
  // ≈3.7:1（<4.5）。升一档到 label-secondary（浅 #61666b≈5.8:1、深
  // #cfd3d6 对深底 ≈12:1，两主题达标）；禁用态控件仍用 tertiary——禁用
  // 豁免于文字对比（WCAG 1.4.3），且需与可读说明拉开层级。
  + "color:var(--dsw-alias-label-secondary)}"
  + ".ats-enum-message[aria-invalid='true']{color:var(--dsw-alias-state-error-primary)}"
  // 卸载风险提示块（设计 §5.4）：静态非交互文本，长在表单顶部、全部字段之前；
  // 醒目外壳（需求 §7.2「在设置页醒目提示」）：警示浅底 + 左侧色条 + 三角警示
  // 图标，全部走 warn 态 token（深浅主题均可读），与普通字段说明拉开视觉层级；
  // 宽度随表单列。VIS-CONTRAST-01：正文原用 warn-label，浅色档 amber-600 对
  // amber-100 实测 ≈2.6:1（<4.5）。宿主自身的警示通知先例
  //（dsh-client-ui-plugin-market 的 notice）即「warn-tertiary 底 + label-secondary
  // 正文 + warn-primary 图标」——正文改 label-secondary（浅 ≈5.4:1、深
  // ≈10:1，两主题达标）；左色条与三角图标维持 warn-primary 作冗余非文字线索
  //（警示语义由标题文字承载，图标不是必要图形，不受 3:1 约束；「不只靠颜色」
  // 由图标形状＋左色条＋标题文字三重线索满足）。
  + ".ats-uninstall-risk{display:flex;gap:8px;align-items:flex-start;margin:12px 0 0;"
  + "padding:10px 12px;border-left:3px solid var(--dsw-alias-state-warn-primary);"
  + "border-radius:8px;background:var(--dsw-alias-state-warn-tertiary);"
  + "font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}"
  + ".ats-uninstall-risk svg{flex:none;margin-top:1px}"
  // 预设绑定块（需求 9.4）：条目行 = 原生 checkbox + 宿主显示名称 + ID 小字
  //（等宽、辅助辨识同名项）＋状态注记；样式只引用已定义别名
  //（tools/check-alias-tokens.mjs 守护）。
  + ".ats-preset-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;"
  + "list-style:none}"
  + ".ats-preset-item{display:flex;align-items:center;gap:8px;min-width:0;"
  + "font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}"
  + ".ats-preset-item input[type='checkbox']{flex:none;margin:0}"
  + ".ats-preset-item label{display:inline-flex;align-items:center;gap:8px;"
  + "min-width:0;cursor:pointer}"
  + ".ats-preset-item label:has(input:disabled){cursor:default}"
  + ".ats-preset-id{font-family:ui-monospace,Consolas,monospace;font-size:11px;"
  + "line-height:1.5;color:var(--dsw-alias-label-tertiary);"
  + "overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
  + ".ats-preset-note{flex:none;font-size:12px;line-height:1.5;"
  + "color:var(--dsw-alias-label-tertiary)}"
  // 六组渐进披露（设计 §5.3）：组容器与组头折叠按钮——键盘可达的原生 button、
  // aria-expanded/aria-controls 指向体区；组级标记（group.unsaved／group.error）
  // 随标题并列；保存区在六组之后。只引用定义表内的别名 token。
  + ".ats-group{display:flex;flex-direction:column;gap:4px;padding:10px 0 2px}"
  + ".ats-group+.ats-group{border-top:.5px solid var(--dsw-alias-border-l2)}"
  + ".ats-group-head{display:flex;align-items:center;gap:8px}"
  + ".ats-group-toggle{border:none;background:none;padding:0;font:inherit;"
  + "font-size:13px;font-weight:500;line-height:1.5;"
  + "color:var(--dsw-alias-label-primary);cursor:pointer;display:inline-flex;"
  + "align-items:center;gap:8px}"
  + ".ats-group-toggle:focus-visible{outline:2px solid "
  + "var(--dsw-alias-state-business-primary);outline-offset:2px}"
  + ".ats-group-mark{font-size:12px;font-weight:400;line-height:1.5;"
  + "color:var(--dsw-alias-label-secondary)}"
  + ".ats-group-mark-error{color:var(--dsw-alias-state-error-primary)}"
  + ".ats-group-sub{padding:2px 0 2px 12px}"
  + ".ats-group-hint{margin:2px 0 0;font-size:12px;line-height:1.5;"
  + "color:var(--dsw-alias-label-secondary)}"
  + ".ats-save-area{display:flex;flex-direction:column;gap:4px;padding:12px 0 0;"
  + "border-top:.5px solid var(--dsw-alias-border-l2);margin-top:8px}"
  + ".ats-save-note{margin:0;font-size:12px;line-height:1.5;"
  + "color:var(--dsw-alias-label-secondary)}"
  + ".ats-save-warn{margin:0;font-size:12px;line-height:1.5;"
  + "color:var(--dsw-alias-state-error-primary)}"
  + ".ats-save-blocked{margin:0;font-size:12px;line-height:1.5;"
  + "color:var(--dsw-alias-label-secondary)}"
  + ".ats-save-go{align-self:flex-start}"

if (typeof document !== "undefined" && document.getElementById("dsh-async-tools-enum-style") === null) {
  var styleEl = document.createElement("style");
  styleEl.id = "dsh-async-tools-enum-style";
  styleEl.textContent = ENUM_CSS;
  document.head.appendChild(styleEl);
}

/**
 * 统一字段壳（设计 §5.5）：19 个字段共用——label 行（标签 + 带圈问号帮助按钮 +
 * 覆盖徽标）、控件本体、说明/错误行、展开区（仅展开时渲染）。控件本体四形态：
 * 布尔 = 自绘 role="switch" 按钮（UI-SETTINGS-AX：官方 P.Switch 不收
 * id/aria-describedby，关联自绘）；枚举 = 原生 select；数值 = input
 * （`inputMode="numeric"`）；文本 = input。度量逐项照官方 `fields.module.css`
 *（见 ENUM_CSS 头注；开关另照官方 primitives 药丸＋滑块）。
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
    // 布尔开关自绘（UI-SETTINGS-AX）：role="switch" 按钮 + `id`（壳上 label
    // `for` 绑定）+ `aria-label`（＝可见标签，冗余双保险——label 关联与
    // aria-label 同文不冲突）+ `aria-describedby`（说明/错误/帮助行，与
    // select/input 同一 described 清单）+ `aria-invalid`（非法草稿态）；
    // 键盘激活（Enter/Space）走原生 button 的默认 click。官方 P.Switch 收不了
    // 这些摆位，才改自绘（见文件头注与 ENUM_CSS 的样式来源注）。
    control = React.createElement("button", {
      type: "button",
      role: "switch",
      id: props.id,
      className: "ats-switch",
      "aria-checked": props.text === "true",
      "aria-label": props.label,
      "aria-invalid": props.invalid === true ? true : undefined,
      "aria-describedby": described === "" ? undefined : described,
      disabled: props.disabled,
      onClick: function () { props.onEdit(props.text === "true" ? "false" : "true"); }
    }, React.createElement("span", { className: "ats-switch-thumb" }));
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
  // 真实 React 靠它对 19 个同函数实例做「相同组件类型 + 相同 key → 复用局部 state」，
  // 草稿键入/保存/语言切换的重渲不丢帮助开合状态（设计 §5.5）。
  return React.createElement("div", { className: "ats-enum-field" },
    React.createElement("div", { className: "ats-enum-head" },
      React.createElement("div", { className: "ats-enum-labelGroup" },
        // 四形态统一 label `for`/控件 `id` 绑定（§5.4）：布尔开关也有 id——
        // 点击可见标签即聚焦/激活开关（label 关联对 labelable 的 button 生效）。
        React.createElement("label", { className: "ats-enum-label", htmlFor: props.id }, props.label),
        helpButton),
      props.overridden === true ? React.createElement("span", { className: "ats-enum-badges" },
        React.createElement(P.Tag, { tone: "neutral" }, props.overriddenLabel),
        React.createElement("button", {
          type: "button", className: "ats-enum-reset", disabled: props.disabled,
          onClick: props.onReset
        }, props.resetLabel)) : null),
    control,
    // 暂存了清除动作用的独立标记行（需求 5.7.4：与当前生效值分开——保存后才
    // 移除自定义值，保存前明说；数据源＝plan 投影的 unset 条目）。
    props.resetStaged === true ? React.createElement("p", {
      className: "ats-enum-message"
    }, props.resetStagedNote) : null,
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
 * （设计 §5.1：20 字段全部展平在 `settings` 键下）。
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
  var present = snapshot !== undefined && snapshot !== null;
  var state = {
    shell: model.shell(), uiLang: uiLangOf(snapshot), fields: {}, effective: {},
    userHas: {}, base: {}, planEntries: {}
  };
  // 暂存投影（设计 §5.3 组级标记与 §5.4 保存区清单的数据源——与字段行同源，
  // 不另建状态）：`model.plan()` 的条目按字段登记——带 op = 暂存的 set/unset
  //（组级「有未保存修改」），无 op = 单字段非法（组级「有设置需要修正」与
  // 保存区阻止清单的成员）。
  var plan = typeof model.plan === "function" ? model.plan() : [];
  for (var planIndex = 0; planIndex < plan.length; planIndex += 1) {
    state.planEntries[plan[planIndex].field] = plan[planIndex].op === undefined ? "invalid" : "staged";
  }
  var valueLayer = settingsLayerOf(present ? snapshot.value : undefined);
  var userLayer = settingsLayerOf(present ? snapshot.user : undefined);
  var baseLayer = settingsLayerOf(present ? snapshot.base : undefined);
  for (var i = 0; i < FIELDS.length; i += 1) {
    var field = FIELDS[i];
    state.fields[field.key] = model.field(field.key);
    // 清覆盖判定原料（UI-CLEAR-03，设计 §5.4）：`userHas`＝原始用户层的键
    // 存在性（保存落定前 unset 未发生，键在场即「本次保存将清除的覆盖」——
    // 不经字段级 overridden 标志，那是官方模型对暂存后来源的预演、暂存清除
    // 即翻转）；`base`＝base 层回退值（清字段后按 5.1 优先级重取的组合层，
    // 即恢复默认将写入的真实值；数值字段才有链式用途，非数值形态不收）。
    state.userHas[field.key] = Object.prototype.hasOwnProperty.call(userLayer, field.key);
    var baseValue = baseLayer[field.key];
    if (typeof baseValue === "number" && Number.isFinite(baseValue)) {
      state.base[field.key] = baseValue;
    }
    // 毫秒字段的生效值（说明行读数）＋绑定字段的生效名单（绑定块的生效值行）。
    if (field.ms === true || field.binding === true) {
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
  // 保存回执投影（设计 §5.4 保存区三态）：确认成功 = `model.save()` 落定且
  // 非失败（dirty 清空、failed 不在场）→ `saveArea.saved`（一次性，下一次编辑
  // 清除）；确认拒绝或写入失败 = 官方 `failed` 通道（SettingsForm 页脚的
  // saveFailed 行，本包不另画）；无可靠回执 = `save()` 本身抛错（官方模型把
  // 宿主异常折进 failed，抛错只来自模型自身之外）→ `saveArea.unconfirmed`。
  // 回执是独立小存储：不写表单模型、不触发草稿变更。
  var receipt = { kind: "none" };
  var receiptListeners = [];
  function publishReceipt() {
    for (var i = 0; i < receiptListeners.length; i += 1) receiptListeners[i]();
  }
  function clearReceipt() {
    if (receipt.kind === "none") return;
    receipt = { kind: "none" };
    publishReceipt();
  }
  var rawActions = model.actions();
  var actions = {
    edit: function (key, text) { clearReceipt(); rawActions.edit(key, text); },
    resetField: function (key) { clearReceipt(); rawActions.resetField(key); },
    discard: rawActions.discard === undefined ? undefined : function () {
      clearReceipt();
      rawActions.discard();
    },
    save: function () {
      // 返回落定链：官方按钮 `onClick` 透传返回值，调用方（含测试）可 await
      // 到保存进程收尾（saving 复位），回执投影同链产出。
      return Promise.resolve().then(function () { return model.save(); }).then(function () {
        var shell = model.shell();
        var next = !shell.dirty && !shell.failed ? "saved" : "none";
        if (receipt.kind !== next) {
          receipt = { kind: next };
          publishReceipt();
        }
      }, function () {
        receipt = { kind: "unconfirmed" };
        publishReceipt();
      });
    }
  };
  return {
    model: model,
    store: store,
    actions: actions,
    receiptStore: {
      getSnapshot: function () { return receipt; },
      subscribe: function (listener) {
        receiptListeners.push(listener);
        return function () {
          var index = receiptListeners.indexOf(listener);
          if (index !== -1) receiptListeners.splice(index, 1);
        };
      }
    },
    dispose: function () { model.dispose(); }
  };
}

/**
 * 预设目录模型（需求 9.4.2，独立于设置表单模型）：宿主预设列表的发现、状态与
 * 快照存储。`load()` 走宿主 `agentPresets.list` 远程调用（`{ok:true,
 * value:{presets:[…]}}`｜`{ok:false, error:{code, message}}`——宿主成例
 * `dsh-client-ui-agent-preset` 的 `readRoster` 同一契约）：
 * - `ok===true` → ready 态、items=`value.presets`（每项含 `{id,name?,
 *   description?,order?,broken?,isDefault}`，按宿主序；`broken` 在场时是
 *   **诊断字符串**——宿主 `diagnostic()` 的一行或多行装载失败原因，可用项
 *   缺省该键），
 * - `error.code==='gateway/invocation-unavailable'` → error 态·服务缺席文案；
 * - 其余 error → error 态·失败原因文案。**任何失败都不是空目录**（需求 9.4.2
 *   「读取失败不得显示为空列表」）——失败态下列表区退回已保存绑定（value 层）。
 * - 防重入：loading 中忽略并发 load（照宿主成例 `beginRosterRead`）。
 *
 * 通知重读纪律（设计 §10.1）：
 * - **在途期间的读取请求（通知触发）不并发另起**——置待重读标记，在途回执落定
 *   后自动补**恰一次**重读（重读由目录自身发起，计入 store 侧 `service.list`
 *   调用；补读期间再到的通知按同一标记机制叠加，仍不并发）。
 * - **回执双重校验（读取序列＋服务代际）**：每次读取携带发起时的序号与代际，
 *   落定回执序号非在册最新、或代际已进（attach 换代理／detach 撤代理）即
 *   stale 回执——**零写入**（items／error／status 一概不动，也不冲刷存储，
 *   不得把旧代理的回执冒充新代理的结果）。
 * - **attach 首读不被旧在途请求挡**：attach 即推进代际并即时发起新读——旧
 *   在途回执按代际失配自弃，新代理的首读不等待、不缺席。
 * - **在途 detach 的状态收尾**（§10.1，UI-CATALOG-02-A）：detach（服务撤下且
 *   无替代）推进代际后**即时收尾**——不等在途回执落定（回执永不来时等待只会
 *   让 loading 永久悬挂），已知撤下事实立刻把 loading 同步折进可重试错误态
 *   （unavailable 标记，与绑定块的服务缺席 error 态同口径）；在途回执按代际
 *   失配自弃、零写入；其后手动刷新在服务仍缺席时立即交回错误态、不再排补读
 *   （待补读标记的语义是「服务在场时的重读意图」，随 detach 作废）。
 * - 目录只读写自身快照，不触设置表单模型——重读/失败/重试/收尾期间未保存
 *   草稿原样保留。
 *
 * 服务代理经 `attach(service)` 注入（apply 的动态 inject 接线，见
 * `createPresetCatalog` 用法处注释），服务实现变化／fiber 退出时经 `detach()`
 * 清空引用；服务永不到场时，任何一次读取尝试（手动
 * 刷新或通知触发的 load）都进入可重试的 error 态（服务缺席文案），无人尝试
 * 则停在 idle 回退渲染——设置卡与其余字段不受影响，已存绑定仍可查看与取消。
 *
 * @returns {object} `{store, load, attach, detach}`——store 是快照存储
 *   （`{status:'idle'|'loading'|'ready'|'error', items:[], error:undefined}`）。
 */
function createPresetCatalog() {
  var listeners = [];
  // 初始态是 `idle`（尚未发起任何读取）——不是 `loading`：防重入守卫按
  // `loading` 判在途，初始若也记 `loading`，attach 触发的首读会被守卫吞掉，
  // 目录永远卡在装载中（T23 诊断钉住的反例）。idle 期间条目区按生效名单回退
  // 渲染、无状态行；首读发起后才进入真正的 loading。
  var snapshot = { status: "idle", items: [], error: undefined };
  var service = null;
  // 读取代际（attach/detach 推进）：旧代理上的在途回执按代际失配自弃。
  var generation = 0;
  // 读取序列（只增不减）：回执携带发起时的序号，落后于在册最新序号的回执
  // （同代内先发后至）同样自弃。
  var readSeq = 0;
  // 待重读标记（§10.1）：loading 期间到达的读取请求只置位一次，在途回执落定
  // 后自动补恰一次重读。语义＝「服务在场时的重读意图」——服务撤下（detach）
  // 后作废，不把补读排到无服务的将来。
  var pendingReread = false;
  function publish() {
    for (var i = 0; i < listeners.length; i += 1) listeners[i]();
  }
  /** 回执落定（§10.1）：stale 回执零写入；有效回执落写冲刷后消费待重读标记（恰一次补读）。 */
  function settleRead(seq, atGeneration, apply) {
    if (seq !== readSeq || atGeneration !== generation) return;
    apply();
    publish();
    if (pendingReread) {
      pendingReread = false;
      startRead();
    }
  }
  function startRead() {
    readSeq += 1;
    var seq = readSeq;
    var atGeneration = generation;
    snapshot = { status: "loading", items: [], error: undefined };
    publish();
    if (service === null || typeof service.list !== "function") {
      // 服务未注入（inject 回调未运行）＝按服务缺席处理：保持可重试的 error 态，
      // 不是空目录。
      settleRead(seq, atGeneration, function () {
        snapshot = { status: "error", items: [], error: undefined, unavailable: true };
      });
      return;
    }
    var settled = Promise.resolve().then(function () { return service.list(); }).then(function (result) {
      settleRead(seq, atGeneration, function () {
        if (result !== null && typeof result === "object" && result.ok === true
          && result.value !== null && typeof result.value === "object"
          && Array.isArray(result.value.presets)) {
          snapshot = { status: "ready", items: result.value.presets, error: undefined };
        } else if (result !== null && typeof result === "object" && result.ok !== true
          && result.error !== null && typeof result.error === "object") {
          var unavailable = result.error.code === "gateway/invocation-unavailable";
          snapshot = {
            status: "error", items: [],
            error: unavailable ? undefined : String(result.error.message ?? result.error.code),
            unavailable: unavailable
          };
        } else {
          snapshot = { status: "error", items: [], error: undefined, malformed: true };
        }
      });
    }, function (error) {
      settleRead(seq, atGeneration, function () {
        snapshot = {
          status: "error", items: [],
          error: String((error && error.message) || error)
        };
      });
    });
    settled.catch(function () { /* 落定链异常不写快照（快照只经回执双重校验路径落写） */ });
  }
  function load() {
    if (snapshot.status === "loading") {
      // 在途期间的读取请求（通知触发，§10.1）：不并发另起——置待重读标记，
      // 在途回执落定后自动补恰一次重读（防重入不吞通知）。
      pendingReread = true;
      return;
    }
    startRead();
  }
  return {
    store: {
      getSnapshot: function () { return snapshot; },
      subscribe: function (listener) {
        listeners.push(listener);
        return function () {
          var index = listeners.indexOf(listener);
          if (index !== -1) listeners.splice(index, 1);
        };
      }
    },
    load: load,
    attach: function (remoteService) {
      service = remoteService;
      // 代际推进＋即时首读（§10.1）：旧代理上的在途回执按代际失配自弃，首读
      // 不被旧在途请求的 loading 守卫挡（挡住＝新代理的首读缺席）。服务实现
      // 变化（fiber 重挂）重复 attach 同样成立；attach 自身就是一次新读，此前
      // 在途期间的待重读标记随之作废（意图已由本次首读满足，不双读）。
      generation += 1;
      pendingReread = false;
      startRead();
    },
    // 注入回调返回的清理函数调用（ACCEPT-CLIENT-INJECT-01 设计 §5.3）：
    // 清空目录持有的服务引用——服务实现变化（fiber 先拆旧 episode、清理跑后
    // 重跑回调）时目录不留陈旧代理；后续读取按服务缺席口径走可重试 error 态。
    // 代际同步推进：被撤代理上的在途回执零写入。
    detach: function () {
      service = null;
      generation += 1;
      // 在途的待重读意图作废（待补读标记＝服务在场时的重读意图，§10.1）：
      // 服务已撤下，标记不再有可服务的将来。
      pendingReread = false;
      // 即刻收尾（§10.1，UI-CATALOG-02-A）：detach 时服务已确定缺席，等待
      // 在途回执落定没有可等的证据——回执永不来时 loading 永久悬挂。已知
      // 撤下事实立即把 loading 同步折进可重试错误态（unavailable 标记，与
      // 绑定块的服务缺席 error 态同口径）；旧回执按代际失配零写入（回执迟到
      // 时快照已非 loading，双保险），新服务在后续 attach 场次到场时由其首读
      // 接管。收尾只写目录自身快照，不触设置表单模型（未保存草稿不受影响）。
      if (snapshot.status === "loading") {
        snapshot = { status: "error", items: [], error: undefined, unavailable: true };
        publish();
      }
    }
  };
}

/**
 * 渲染预设功能绑定块（需求 9.4.2／5.7.6，适用预设组体内的绑定控件；不经
 * FieldShell——复选框组不是单值控件）。结构（设计 §5.3）：
 * - 摘要行（组首恒在，入口收起时也在）：已保存范围（value 层事实）与勾选草稿
 *   分别表达（`preset.effectiveList`／`preset.noneBound`＋`preset.draftList`／
 *   `preset.draftNone`——未保存的勾选不冒充生效）；`{预设列表}` 用真实显示名
 *   优先、缺名用 ID，同名冲突时并附 ID（需求 5.7.6）。
 * - 头部：组标题语义（词典键 `boundPresets`，条目组经 `aria-labelledby` 指向
 *   它取得组名，RA-BIND-LABEL）＋带圈问号帮助（`help.boundPresets`）＋覆盖
 *   徽标／清除自定义值＋「刷新」（只重读目录，不碰草稿/保存/mutate）＋
 *   「选择预设」入口（`preset.chooseEntry`，aria-expanded/aria-controls 指向
 *   目录区——完整列表默认收起，不让长列表挤走其他首屏操作）；
 * - 目录区（仅入口展开时渲染）：状态行（loading／目录确空／失败＋重试／服务
 *   不可用；读取中或失败且无目录数据时另附「只显示已有选择与未保存的修改」）
 *   ＋条目行（目录项 = 原生 checkbox＋宿主显示名称＋ID 小字；`broken` 项已
 *   绑定可取消、未绑定禁选，诊断经「查看详情＋原因：{原因}」分句呈现（布尔
 *   true 无诊断可给时只显标记行）；已绑定但不在目录的 ID 保留条目、可取消；
 *   失败态退回已保存绑定）。
 * 草稿存于设置表单模型（JSON 串经 spec 往返），刷新期间未保存勾选原样。
 *
 * @param {object} props - `{state, actions, t, catalog, entryOpen, onToggleEntry}`。
 * @returns {object} React 元素。
 */
function PresetBindingBlock(props) {
  var state = props.state;
  var t = props.t;
  var catalogState = React.useSyncExternalStore(
    props.catalog.store.subscribe, props.catalog.store.getSnapshot);
  var fieldState = state.fields.boundPresets;
  var draft = decodeBoundDraft(fieldState.text);
  var effective = Array.isArray(state.effective.boundPresets)
    ? state.effective.boundPresets : [];
  var helpOpenState = React.useState(false);
  var helpOpen = helpOpenState[0];
  var setHelpOpen = helpOpenState[1];
  var id = "plugin-config-boundPresets";
  var messageId = id + "-message";
  var helpId = id + "-help";
  var listId = id + "-list";
  var titleId = id + "-title";
  var label = t("boundPresets");
  var help = resolveCopy(t, "help.boundPresets");
  var helpA11y = help === undefined ? undefined
    : t("help.a11yName").replace("{名称}", label);
  var hint = resolveCopy(t, "hint.boundPresets");
  var disabled = !state.shell.writable;
  var actions = props.actions;
  function toggle(idToToggle, checked) {
    var next = draft.filter(function (candidate) { return candidate !== idToToggle; });
    if (checked) next = next.concat([idToToggle]);
    actions.edit("boundPresets", JSON.stringify(next));
  }
  // 展示行集合（§10.1）：ready 态 = 目录项＋草稿里不在目录的已勾选 ID（保留
  // 条目）；loading/error 态 = 生效名单 ∪ 草稿已勾选（T-BIND-DRAFT）——ready
  // 期间新勾的预设不能因目录重读而消失：草稿内部虽未丢，藏在草稿文本里的
  // 条目等于不能操作（不可见＝不可取消）。absent 注记只在 error 态标注
  //（目录确实没读出来）；loading 态不声称「未在当前预设列表中发现」——目录
  // 回来前未知，注记只能是已证实的事实。
  var rows = [];
  var listed = {};
  var i;
  if (catalogState.status === "ready") {
    for (i = 0; i < catalogState.items.length; i += 1) {
      var item = catalogState.items[i];
      listed[item.id] = true;
      // RA-BIND-BROKEN：宿主 agentPresets.list 的 broken 是**诊断字符串**
      //（装载失败 = error.message；可用项缺省该键）。这里按 truthy 判异常：
      // 字符串诊断或布尔 true 都是"装载失败"，false/空串/缺省 = 正常；诊断
      // 原文经 preset.reasonLabel 的 {原因} 透传（需求 5.7.6 L727 两分句）。
      rows.push({ id: item.id, name: item.name, broken: item.broken ? item.broken : undefined, absent: false });
    }
    for (i = 0; i < draft.length; i += 1) {
      if (!listed[draft[i]]) rows.push({ id: draft[i], name: undefined, broken: undefined, absent: true });
    }
  } else {
    var markAbsent = catalogState.status === "error";
    var seen = {};
    for (i = 0; i < effective.length; i += 1) {
      rows.push({ id: effective[i], name: undefined, broken: undefined, absent: markAbsent });
      seen[effective[i]] = true;
    }
    for (i = 0; i < draft.length; i += 1) {
      if (!seen[draft[i]]) rows.push({ id: draft[i], name: undefined, broken: undefined, absent: markAbsent });
    }
  }
  var draftIndex = {};
  for (i = 0; i < draft.length; i += 1) draftIndex[draft[i]] = true;
  // {预设列表} 格式（需求 5.7.6）：真实显示名优先、缺名用 ID；同名冲突并附 ID。
  var nameCount = {};
  var rowsById = {};
  for (i = 0; i < rows.length; i += 1) {
    rowsById[rows[i].id] = rows[i];
    if (rows[i].name !== undefined) nameCount[rows[i].name] = (nameCount[rows[i].name] || 0) + 1;
  }
  function listWord(ids) {
    return ids.map(function (presetId) {
      var row = rowsById[presetId];
      if (row === undefined || row.name === undefined) return presetId;
      return nameCount[row.name] > 1 ? row.name + " (" + presetId + ")" : row.name;
    }).join(", ");
  }
  // 摘要行（组首恒在）：已保存范围与勾选草稿分别表达（§5.3）。
  var staged = state.planEntries.boundPresets !== undefined;
  var summaryLines = [];
  if (effective.length > 0) {
    summaryLines.push(t("preset.effectiveList").replace("{预设列表}", listWord(effective)));
  } else {
    summaryLines.push(t("preset.noneBound"));
  }
  if (staged) {
    summaryLines.push(Array.isArray(draft) && draft.length > 0
      ? t("preset.draftList").replace("{预设列表}", listWord(draft))
      : t("preset.draftNone"));
  }
  var summaryNodes = [];
  if (hint !== undefined) {
    summaryNodes.push(React.createElement("p", { key: "hint", id: messageId, className: "ats-enum-message" }, hint));
  }
  for (i = 0; i < summaryLines.length; i += 1) {
    summaryNodes.push(React.createElement("p", { key: "summary-" + i, className: "ats-enum-message" }, summaryLines[i]));
  }
  var noCatalogData = catalogState.status === "loading" || catalogState.status === "error";
  return React.createElement("div", { className: "ats-enum-field", key: "boundPresets" },
    React.createElement("div", { className: "ats-enum-head" },
      React.createElement("span", { className: "ats-enum-labelGroup" },
        React.createElement("span", { className: "ats-enum-label", id: titleId }, label),
        help === undefined ? null : React.createElement("button", {
          type: "button",
          className: "ats-help-button",
          "aria-label": helpA11y,
          "aria-expanded": helpOpen,
          "aria-controls": helpId,
          onClick: function () { setHelpOpen(!helpOpen); }
        }, React.createElement(P.IconQuestionOutlineRegular, { size: 14 }))),
      React.createElement("span", { className: "ats-enum-badges" },
        fieldState.overridden === true ? React.createElement(P.Tag, { tone: "neutral" }, t("overridden")) : null,
        fieldState.overridden === true ? React.createElement("button", {
          type: "button", className: "ats-enum-reset", disabled: disabled,
          onClick: function () { actions.resetField("boundPresets"); }
        }, t("reset")) : null),
      React.createElement("span", { className: "ats-enum-badges" },
        React.createElement("button", {
          type: "button", className: "ats-enum-reset",
          disabled: catalogState.status === "loading",
          onClick: function () { props.catalog.load(); }
        }, t("preset.refresh")),
        React.createElement("button", {
          type: "button", className: "ats-enum-reset", id: id + "-entry",
          "aria-expanded": props.entryOpen ? "true" : "false",
          "aria-controls": listId,
          onClick: props.onToggleEntry
        }, t("preset.chooseEntry")))),
    summaryNodes,
    props.entryOpen === true ? React.createElement("div", { id: listId },
      catalogState.status === "loading"
        ? React.createElement("p", { className: "ats-enum-message" }, t("preset.loading"))
        : catalogState.status === "ready" && rows.length === 0
        ? React.createElement("p", { className: "ats-enum-message" }, t("preset.empty"))
        : catalogState.status === "error"
        ? React.createElement("p", { className: "ats-enum-message", "aria-invalid": true },
          catalogState.unavailable === true || catalogState.malformed === true
            ? t("preset.unavailable")
            : t("preset.failed"),
          " ",
          React.createElement("button", {
            type: "button", className: "ats-enum-reset",
            onClick: function () { props.catalog.load(); }
          }, t("preset.retry")))
        : null,
      noCatalogData
        ? React.createElement("p", { className: "ats-enum-message" }, t("preset.partialOnly"))
        : null,
      rows.length > 0 ? React.createElement("ul", {
        // UI-SETTINGS-AX：组不只报可及名（labelledby＝标题），还要带上说明行
        //（describedby＝说明行——常驻说明在读屏上随组可达，需求 §5.4「常驻
        // 说明」对非字段控件同样成立）。
        className: "ats-preset-list", role: "group",
        "aria-labelledby": titleId, "aria-describedby": messageId
      }, rows.map(function (row) {
        var checked = draftIndex[row.id] === true;
        // RA-BIND-BROKEN：异常项（broken 为 truthy——宿主实测是诊断字符串）未绑定
        // 禁止新增勾选；已绑定允许取消（绑定只取消、不新增，不给装不上的预设开口）。
        var rowDisabled = disabled || (row.broken !== undefined && !checked);
        return React.createElement("li", { key: row.id, className: "ats-preset-item" },
          React.createElement("input", {
            type: "checkbox",
            id: id + "-" + row.id,
            checked: checked,
            disabled: rowDisabled,
            onChange: function (event) { toggle(row.id, event.target.checked); }
          }),
          React.createElement("label", { htmlFor: id + "-" + row.id },
            row.name !== undefined ? row.name : row.id,
            row.name !== undefined && row.name !== row.id
              ? React.createElement("span", { className: "ats-preset-id" }, row.id) : null),
          row.absent === true
            ? React.createElement("span", { className: "ats-preset-note" }, t("preset.absent"))
            : row.broken !== undefined
            ? React.createElement("span", { className: "ats-preset-note" },
              // 详情两分句（需求 5.7.6）：入口「查看详情」＋「原因：{原因}」
              //（诊断原文原样透传；布尔 true 无诊断可给时只显标记行）。
              typeof row.broken === "string" && row.broken !== ""
                ? t("preset.detailEntry") + " · " + t("preset.reasonLabel").replace("{原因}", row.broken)
                : t("preset.broken"))
            : null);
      })) : null) : null,
    helpOpen && help !== undefined ? React.createElement("div", {
      id: helpId,
      role: "region",
      "aria-label": helpA11y,
      className: "ats-help-region"
    }, String(help).split("\n\n").map(function (paragraph, index) {
      return React.createElement("p", { key: index }, paragraph);
    })) : null);
}

/** 毫秒单位词（需求 5.7.4：错误范围的边界值包含输入所用单位）——语言档从
 * 词典自身的秒单位词推导（含「秒」＝中文档），不另设词典键。 */
function msUnitWord(t) {
  return t("readout.secondsUnit").indexOf("秒") !== -1 ? "毫秒" : "ms";
}

/** 数值字段的边界插值：毫秒字段附单位词、`maxResultChars` 无量词。 */
function boundWithUnit(t, field, value) {
  if (field.ms === true) return String(value) + " " + msUnitWord(t);
  return String(value);
}

/** 字段行与保存区清单共用的冒号（跟随语言档，从读数键的标点推导）。 */
function labelColon(t) {
  return t("readout.current").indexOf("：") !== -1 ? "：" : ": ";
}

/** 名单错误三档（需求 5.7.4）：非列表／含空 ID／含重复 ID——按确认的原因
 * 分别用三项；空名单本身合法（不进此函数）。 */
function boundListReasonOf(t, text) {
  var parsed;
  try {
    parsed = JSON.parse(typeof text === "string" && text.trim() !== "" ? text : "null");
  } catch (error) { parsed = null; }
  if (!Array.isArray(parsed)) return t("boundList.notList");
  for (var i = 0; i < parsed.length; i += 1) {
    if (typeof parsed[i] !== "string" || parsed[i] === "") return t("boundList.emptyId");
  }
  var seen = {};
  for (var j = 0; j < parsed.length; j += 1) {
    if (seen[parsed[j]] === true) return t("boundList.duplicate");
    seen[parsed[j]] = true;
  }
  return t("boundList.notList");
}

/**
 * 字段的原因句（设计 §5.4 五档＋文本/名单两特档）：非整数（仅整数字段）、
 * 越上界、低于下界、链式违例（两侧字段名插值——需求 5.7.4 跨字段行）、
 * 官方"不是数字"；`jobKind` 写入空串特档；绑定名单按确认原因三档。字段行
 * 与保存区阻止清单共用本函数——行内原因句与字段行原因逐字一致。
 * @returns {string|undefined} 合法字段返回 undefined。
 */
function invalidLabelOf(state, field, t) {
  var fieldState = state.fields[field.key];
  var invalid = fieldState !== undefined && fieldState.invalid === true;
  if (field.binding === true) {
    return invalid ? boundListReasonOf(t, fieldState.text) : undefined;
  }
  if (field.key === "jobKind" && invalid
    && String(fieldState.text === undefined || fieldState.text === null ? "" : fieldState.text).trim() === "") {
    return t("invalidJobKindEmpty");
  }
  if (!isNumericField(field)) return invalid ? t("invalidNumber") : undefined;
  var draftNum = draftNumber(state, field.key);
  var notInteger = invalid && draftNum !== null
    && INTEGER_FIELDS[field.key] === true && !Number.isInteger(draftNum);
  // 非整数优先报整数性；越界/低于下界只在整数草稿上判定（避免同屏双报）。
  var outOfRange = !notInteger && invalid && draftNum !== null
    && draftNum > FIELD_MAX[field.key];
  var belowRange = !notInteger && invalid && draftNum !== null
    && FIELD_MIN[field.key] !== undefined && draftNum < FIELD_MIN[field.key];
  var pairHit = chainHitOf(state, field.key);
  if (notInteger) return t("invalidInteger");
  if (outOfRange) return t("invalidRange").replace("{最大值}", boundWithUnit(t, field, FIELD_MAX[field.key]));
  if (belowRange) return t("invalidBelow").replace("{最小值}", boundWithUnit(t, field, FIELD_MIN[field.key]));
  if (pairHit !== null) {
    return t("invalidPair." + field.key)
      .replace("{较小字段}", t(field.key))
      .replace("{较大字段}", t(pairHit));
  }
  return invalid ? t("invalidNumber") : undefined;
}

/** 字段是否带阻止保存的问题（单字段非法或链式违例）。 */
function fieldHasProblem(state, field) {
  var fieldState = state.fields[field.key];
  var pairHit = isNumericField(field) ? chainHitOf(state, field.key) : null;
  return (fieldState !== undefined && fieldState.invalid === true) || pairHit !== null;
}

/** 保存区阻止清单（设计 §5.3/§5.4）：按 FIELDS 序（＝组序）列出全部问题字段
 * ——每行 = 字段名 + 冒号 + 复用字段行原因键的原因句。 */
function blockedFieldsOf(state, t) {
  var blocked = [];
  for (var i = 0; i < FIELDS.length; i += 1) {
    if (!fieldHasProblem(state, FIELDS[i])) continue;
    blocked.push({ key: FIELDS[i].key, reason: invalidLabelOf(state, FIELDS[i], t) });
  }
  return blocked;
}

/** 组级标记（设计 §5.3）：暂存的 set/unset → group.unsaved；单字段非法或链式
 * 违例 → group.error；两标记可并存；数据源与字段行同源（plan 投影＋链式判定）。 */
function groupMarkersOf(state, group) {
  var keys = group.fields.concat(group.subgroup !== undefined ? group.subgroup.fields : []);
  var unsaved = false;
  var error = false;
  for (var i = 0; i < keys.length; i += 1) {
    var entry = state.planEntries[keys[i]];
    if (entry === "staged" || entry === "invalid") unsaved = true;
    if (entry === "invalid") error = true;
    var field = FIELD_BY_KEY[keys[i]];
    if (!error && field !== undefined && fieldHasProblem(state, field)) error = true;
  }
  return { unsaved: unsaved, error: error };
}

/**
 * 渲染单个**单值字段**（设计 §5.5：布尔/枚举/数值/文本四形态由 FieldShell 分流）。
 * `id = "plugin-config-" + key`；毫秒字段的说明行带秒读数（`composeHint`——四
 * 「—」字段无 hint、读数行独立在场）。帮助与说明走缺键回退（`resolveCopy`）。
 *
 * @param {object} state - `projectCardState` 的投影。
 * @param {object} actions - 卡片模型的动作（含保存回执包装）。
 * @param {Function} t - 文案函数。
 * @param {object} field - 字段表项。
 * @returns {object} 字段元素。
 */
function makeFieldNode(state, actions, t, field) {
  var fieldState = state.fields[field.key];
  var id = "plugin-config-" + field.key;
  var hint = composeHint(t, field, state.effective[field.key], fieldState.text);
  var label = t(field.label);
  var help = resolveCopy(t, "help." + field.key);
  var helpA11y = help === undefined ? undefined
    : t("help.a11yName").replace("{名称}", label);
  var invalidLabel = invalidLabelOf(state, field, t);
  var pairHit = isNumericField(field) ? chainHitOf(state, field.key) : null;
  return React.createElement(FieldShell, {
    key: field.key,
    fieldKey: field.key, id: id, label: label,
    hint: hint, help: help, helpA11y: helpA11y,
    overridden: fieldState.overridden, overriddenLabel: t("overridden"),
    resetLabel: t("reset"),
    resetStaged: state.planEntries[field.key] === "unset",
    resetStagedNote: t("resetStagedNote"),
    invalid: fieldState.invalid === true || pairHit !== null,
    invalidLabel: invalidLabel === undefined ? t("invalidNumber") : invalidLabel,
    flag: field.flag === true,
    numeric: isNumericField(field),
    options: field.options,
    optionLabel: field.options === undefined ? undefined
      : function (option) { return t("opt." + field.key + "." + option); },
    disabled: !state.shell.writable, text: fieldState.text,
    onEdit: function (text) { actions.edit(field.key, text); },
    onReset: function () { actions.resetField(field.key); }
  });
}

/** 组体字段行装配（设计 §5.3）：budget 组的共用说明行按 `GROUP_HINT_BEFORE`
 * 落位在对应首字段之前；绑定字段走 PresetBindingBlock，其余走 FieldShell。 */
function appendGroupFieldRows(nodes, keys, group, props) {
  var t = props.t;
  var hintBefore = GROUP_HINT_BEFORE[group.id];
  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i];
    if (hintBefore !== undefined && hintBefore[key] !== undefined) {
      nodes.push(React.createElement("p", {
        key: "group-hint-" + key, className: "ats-group-hint"
      }, t(hintBefore[key])));
    }
    var field = FIELD_BY_KEY[key];
    if (field.binding === true) {
      nodes.push(React.createElement(PresetBindingBlock, {
        key: key, state: props.state, actions: props.actions, t: t,
        catalog: props.catalog, entryOpen: props.entryOpen, onToggleEntry: props.onToggleEntry
      }));
    } else {
      nodes.push(makeFieldNode(props.state, props.actions, t, field));
    }
  }
}

/**
 * 卸载风险提示块（设计 §5.4／需求 5.7.4 两档条件化）：静态非交互文本，长在
 * 表单顶部、全部字段之前——用户改设置的入口在插件管理页，同一页面就是停用/
 * 移除本包的入口，风险提示放在操作现场。醒目外壳（警示浅底 + 左色条 + 三角
 * 图标，样式见 ENUM_CSS）与普通字段说明拉开层级（需求 §7.2「醒目提示」）。
 * 档位：目录 ready 且 DSH 当前默认预设确属本包两预设 → 明确风险档
 * （`uninstallRiskKnown`）；ready 且确认不属于 → **整块隐藏**；读取失败、
 * 加载中或服务缺席（不能可靠读取当前值）→ 简短未确认档
 * （`uninstallRiskUnconfirmed`）。不依赖插件已卸载后的任何组件（纯静态文案）。
 * @param {Function} t - 文案函数。
 * @param {object} catalogState - 预设目录快照（`{status, items}`）。
 * @returns {object|null} React 元素；确认不受影响时 null。
 */
function makeUninstallRiskNode(t, catalogState) {
  var copy;
  if (catalogState.status === "ready") {
    var hit = false;
    for (var i = 0; i < catalogState.items.length; i += 1) {
      var item = catalogState.items[i];
      if (item.isDefault === true
        && (item.id === "dsh-async" || item.id === "dsh-async-create")) hit = true;
    }
    if (!hit) return null;
    copy = t("uninstallRiskKnown");
  } else {
    copy = t("uninstallRiskUnconfirmed");
  }
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
    React.createElement("span", null, copy)
  );
}

/**
 * 组容器（设计 §5.3 六组渐进披露）：`section.ats-group`＋组头（折叠按钮
 * `aria-expanded`/`aria-controls` 指向体区，键盘可达的原生 button；组级
 * `group.unsaved`/`group.error` 标记随标题并列——收起后仍在、可并存）＋组级
 * 帮助按钮（五组设、语言组不设；开合是组件局部 state，不触草稿模型）。展开
 * 才渲染体区（收起组的字段控件不在 DOM）；待答子组「等待与加时」同款容器
 * 嵌在待答组体内。开合状态由卡片层持有（`props.open`/`props.onToggle`）——
 * 「转到第一个错误」可编程展开。
 *
 * @param {object} props - `{group, open, onToggle, state, actions, t, catalog,
 *   entryOpen, onToggleEntry, subOpen, onToggleSub}`。
 * @returns {object} React 元素。
 */
function GroupSection(props) {
  var group = props.group;
  var t = props.t;
  var state = props.state;
  var id = "plugin-config-group-" + group.id;
  var bodyId = id + "-body";
  var helpKeys = GROUP_HELP_KEYS[group.id];
  var helpOpenState = React.useState(false);
  var helpOpen = helpOpenState[0];
  var setHelpOpen = helpOpenState[1];
  var helpBodyId = id + "-help-body";
  var title = t("group." + group.id);
  var markers = groupMarkersOf(state, group);
  var head = React.createElement("div", { className: "ats-group-head" },
    React.createElement("button", {
      type: "button", id: id + "-toggle", className: "ats-group-toggle",
      "aria-expanded": props.open ? "true" : "false",
      "aria-controls": bodyId,
      onClick: function () { props.onToggle(group.id); }
    }, title,
      markers.unsaved === true
        ? React.createElement("span", { className: "ats-group-mark" }, t("group.unsaved")) : null,
      markers.error === true
        ? React.createElement("span", { className: "ats-group-mark ats-group-mark-error" }, t("group.error")) : null),
    helpKeys === undefined ? null : React.createElement("button", {
      type: "button", id: id + "-help", className: "ats-help-button",
      "aria-label": t("help.a11yName").replace("{名称}", title),
      "aria-expanded": helpOpen,
      "aria-controls": helpBodyId,
      onClick: function () { setHelpOpen(!helpOpen); }
    }, React.createElement(P.IconQuestionOutlineRegular, { size: 14 })));
  if (!props.open) {
    return React.createElement("section", { id: id, className: "ats-group", key: group.id }, head);
  }
  var body = [];
  if (group.subgroup !== undefined) {
    appendGroupFieldRows(body, group.fields, group, props);
    var sub = group.subgroup;
    var subId = "plugin-config-group-" + sub.id;
    var subNodes = [];
    appendGroupFieldRows(subNodes, sub.fields, sub, props);
    body.push(React.createElement("section", {
      key: subId, id: subId, className: "ats-group ats-group-sub"
    },
      React.createElement("div", { className: "ats-group-head" },
        React.createElement("button", {
          type: "button", id: subId + "-toggle", className: "ats-group-toggle",
          "aria-expanded": props.subOpen ? "true" : "false",
          "aria-controls": subId + "-body",
          onClick: props.onToggleSub
        }, t("group." + sub.id))),
      props.subOpen === true
        ? React.createElement("div", { id: subId + "-body", className: "ats-group-body" }, subNodes)
        : null));
  } else {
    appendGroupFieldRows(body, group.fields, group, props);
  }
  return React.createElement("section", { id: id, className: "ats-group", key: group.id }, head,
    React.createElement("div", { id: bodyId, className: "ats-group-body" }, body),
    helpOpen && helpKeys !== undefined ? React.createElement("div", {
      id: helpBodyId, role: "region",
      "aria-label": t("help.a11yName").replace("{名称}", title),
      className: "ats-help-region"
    }, helpKeys.map(function (key) {
      return String(resolveCopy(t, key)).split("\n\n").map(function (paragraph, index) {
        return React.createElement("p", { key: key + "-" + index }, paragraph);
      });
    })) : null);
}

/**
 * 保存区（设计 §5.4／需求 5.7.4 状态行，六组之后的独立区块）：
 * - 保存回执：确认成功 → `saveArea.saved`（一次性，下一次编辑清除）；
 *   无可靠回执 → `saveArea.unconfirmed`（确认拒绝/失败沿用官方页脚的
 *   saveFailed 行，这里不重复画）；
 * - 有未保存修改（暂存 set/unset 在场）→ 离页后果提示；无修改时隐藏；
 * - 存在阻止保存的错误 → `saveArea.fixFirst`＋阻止字段清单（每行 = 字段名 +
 *   冒号 + 与该字段字段行逐字一致的原因句，多行按组序＝FIELDS 序）＋
 *   「转到第一个错误」。
 *
 * @param {object} props - `{state, receipt, t, onGoToFirstError}`。
 * @returns {object|null} React 元素；全空态时 null。
 */
function SaveArea(props) {
  var t = props.t;
  var state = props.state;
  var nodes = [];
  if (props.receipt.kind === "saved") {
    nodes.push(React.createElement("p", { key: "saved", className: "ats-save-note" }, t("saveArea.saved")));
  }
  if (props.receipt.kind === "unconfirmed") {
    nodes.push(React.createElement("p", {
      key: "unconfirmed", className: "ats-save-note", "aria-invalid": true
    }, t("saveArea.unconfirmed")));
  }
  if (state.shell.dirty) {
    nodes.push(React.createElement("p", { key: "warn", className: "ats-save-warn" }, t("saveArea.unsavedWarning")));
  }
  var blocked = blockedFieldsOf(state, t);
  if (blocked.length > 0) {
    nodes.push(React.createElement("p", { key: "fix", className: "ats-save-warn" }, t("saveArea.fixFirst")));
    var colon = labelColon(t);
    for (var i = 0; i < blocked.length; i += 1) {
      nodes.push(React.createElement("p", {
        key: "blocked-" + blocked[i].key, className: "ats-save-blocked"
      }, t(blocked[i].key) + colon + blocked[i].reason));
    }
    nodes.push(React.createElement("button", {
      key: "go", type: "button", className: "ats-enum-reset ats-save-go",
      onClick: props.onGoToFirstError
    }, t("saveArea.goToFirstError")));
  }
  if (nodes.length === 0) return null;
  return React.createElement("div", { className: "ats-save-area", key: "save-area" }, nodes);
}

/**
 * 插件页卡片工厂：模型每挂载建一次、卸载时 `dispose`；重渲染走
 * `useSyncExternalStore(card.store.subscribe, card.store.getSnapshot)`。
 * `SettingsForm` 的 `onDiscard` 接模型包装的 `discard`——卸载丢弃草稿由它承担；
 * `onSave` 接包装 `save`（保存回执投影在 saveArea）。卡片结构（设计 §5.3）：
 * 卸载风险（两档条件化）→ 六组 GroupSection → 保存区；开合状态（六组＋待答
 * 子组＋「选择预设」入口）只存于本卡片组件的局部 state——开合、切语言、刷新、
 * 诊断定位零模型写入；收起再展开草稿原样（字段经 `key` 复用、草稿在模型里）。
 * 非页面视图只回设置区标题（`title`；`summary` 键已按设计 §5.6 删除）。
 * @param {object} ctx - 客户端上下文（`configForms` 由 inject 声明）。
 * @param {object} catalog - 预设目录模型（`createPresetCatalog` 产物）。
 * @returns {Function} 槽位组件。
 */
function makeBundleCard(ctx, catalog) {
  return function AsyncToolsBundleCard(props) {
    var modelRef = React.useRef(null);
    if (modelRef.current === null) modelRef.current = createCardModel(ctx);
    var card = modelRef.current;
    var state = React.useSyncExternalStore(card.store.subscribe, card.store.getSnapshot);
    var receipt = React.useSyncExternalStore(card.receiptStore.subscribe, card.receiptStore.getSnapshot);
    var catalogState = React.useSyncExternalStore(catalog.store.subscribe, catalog.store.getSnapshot);
    React.useEffect(function () {
      return function () {
        card.dispose();
        modelRef.current = null;
      };
    }, [card]);
    if (props.view !== "page") return props.t("title");
    var t = makeTranslator(state.uiLang, props.t);
    var openState = React.useState(initialOpenState);
    var open = openState[0];
    var setOpen = openState[1];
    function withOpen(patch) {
      setOpen(function (prev) {
        var next = {};
        for (var name in prev) {
          if (Object.prototype.hasOwnProperty.call(prev, name)) next[name] = prev[name];
        }
        for (var key in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
        }
        return next;
      });
    }
    function toggleOpen(key) {
      var flip = {};
      flip[key] = !(open[key] === true);
      withOpen(flip);
    }
    // 「转到第一个错误」（设计 §5.4）：按 FIELDS 序（＝组序）找首个问题字段，
    // 展开其所在组与子组（boundPresets 另展开「选择预设」入口），提交后聚焦控件。
    function goToFirstError() {
      var first = null;
      for (var i = 0; i < FIELDS.length && first === null; i += 1) {
        if (fieldHasProblem(state, FIELDS[i])) first = FIELDS[i].key;
      }
      if (first === null) return;
      var seat = FIELD_GROUP_INDEX[first];
      var patch = {};
      patch[seat.group.id] = true;
      if (seat.subgroup !== null) patch[seat.subgroup.id] = true;
      if (first === "boundPresets") patch.presetsEntry = true;
      withOpen(patch);
      window.setTimeout(function () {
        var el = typeof document !== "undefined"
          ? document.getElementById("plugin-config-" + first) : null;
        if (el !== null && el !== undefined) {
          if (typeof el.focus === "function") el.focus();
          if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
        }
      }, 0);
    }
    var children = [];
    var riskNode = makeUninstallRiskNode(t, catalogState);
    if (riskNode !== null) children.push(riskNode);
    for (var gi = 0; gi < GROUPS.length; gi += 1) {
      children.push(React.createElement(GroupSection, {
        key: GROUPS[gi].id,
        group: GROUPS[gi],
        open: open[GROUPS[gi].id] === true,
        onToggle: toggleOpen,
        state: state, actions: card.actions, t: t, catalog: catalog,
        entryOpen: open.presetsEntry === true,
        onToggleEntry: function () { toggleOpen("presetsEntry"); },
        subOpen: open.askTimes === true,
        onToggleSub: function () { toggleOpen("askTimes"); }
      }));
    }
    children.push(React.createElement(SaveArea, {
      key: "save-area", state: state, receipt: receipt, t: t,
      onGoToFirstError: goToFirstError
    }));
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
      onSave: card.actions.save,
      onDiscard: card.actions.discard
    }, children);
  };
}

/** 词典：字段键即标签键、`hint.<键>` 为字段说明、`opt.<键>.<选项>` 为枚举选项文案；
 *  zh 为主，en 对照（`ctx.locale.register`；两语言键集必须一致）。 */
var DICTIONARIES = {
  zh: {
    // ── 设置区与状态（需求 5.7.4 表逐行；title 改锚设置区标题行，summary 删除）──
    title: "异步工具设置",
    unavailable: "暂时无法读取设置。",
    readOnly: "此处只能查看设置。",
    save: "保存",
    saving: "正在保存…",
    saveFailed: "没有保存设置。修改仍保留在此页。",
    "saveArea.unsavedWarning": "离开此页会丢弃未保存的修改。",
    "saveArea.fixFirst": "请先修正这些设置。",
    "saveArea.goToFirstError": "转到第一个错误",
    "saveArea.saved": "设置已保存。",
    "saveArea.unconfirmed": "无法确认是否保存。修改仍在，请先查看生效值再决定是否重试。",
    "degraded.unsynced": "设置尚未同步。插件暂时使用备用值。",
    "degraded.startup": "已保存的设置有误。插件暂时使用出厂默认值。请修正标出的设置后保存。",
    "degraded.startupReadonly": "部分设置无效，插件暂时使用默认值。此处只能查看设置。",
    "degraded.runtimeRejected": "新设置无效，插件仍在使用上次生效的值。",
    // ── 六组组标题＋待答子组＋组级标记（5.7.4 分组标题/子组/标记行）──
    "group.presets": "适用预设",
    "group.ask": "待答问题",
    "group.askTimes": "等待与加时",
    "group.budget": "命令与等待",
    "group.agentContent": "发送给 Agent 的内容",
    "group.advanced": "高级设置",
    "group.lang": "语言",
    "group.unsaved": "有未保存修改",
    "group.error": "有设置需要修正",
    // ── 组级共用说明与展开帮助（5.7.5 第二表有原文行的八键；无原文行的组不设）──
    "groupHint.budget.firstWait": "启动后先等多久。单次请求短于下限或长于上限时，按相应边界取值。任务先完成就直接返回。",
    "groupHint.budget.singleWait": "任务启动后，每次最多等多久。上下限约束正时长请求；填 0 只检查当前状态和可用结果。",
    "groupHelp.budget.firstWaitExample": "例如，首次等待设为 20 秒。命令在 20 秒内完成，就直接拿到结果；没完成就先拿到作业编号，结果随后送达。插话或取消等待也可提前结束等待，后台任务继续运行。",
    "groupHelp.budget.ranges": "默认首次等待或示例时长须在各自的上下限内；子代理状态检查间隔不能超过单次等待上限。",
    "groupHelp.agentContent.chars": "超出上限时可能只收到首尾，或稍后再收到剩余内容。按结果提示找回；作业状态与必要诊断另计。这里按字符计数，不是 token 上限。",
    "groupHelp.agentContent.shared": "附加文字也占用结果字符上限。关闭工作流进度或原文，不会隐藏命令输出、最终结果或必要诊断。",
    "groupHelp.advanced.backend": "留空使用默认后端。所填服务必须已安装，并支持继续与子代理协作；否则创建时会说明原因。",
    "groupHelp.presets.emptyList": "取消全部勾选并保存后，这些功能将不再应用于任何预设。已启动的任务和已经出现在面板里的问题不受影响。",
    "groupHelp.ask.lateAnswer": "问题还在面板时，可以补答。找不到题目或面板提示未送达时，请到原会话直接回复。",
    "preset.chooseEntry": "选择预设",
    // ── 20 个字段名键（5.7.5 第一表「中文标签」列逐字）──
    boundPresets: "适用预设",
    askTakeover: "在待答面板处理提问",
    askUiSeat: "待答问题出现位置",
    askTimeoutMs: "Agent 等待回答的时长（毫秒）",
    askExtendMs: "每次加时（毫秒）",
    defaultYieldMs: "默认首次等待（毫秒）",
    minYieldMs: "首次等待下限（毫秒）",
    maxYieldMs: "首次等待上限（毫秒）",
    defaultWaitMs: "等待示例中的时长（毫秒）",
    minWaitMs: "单次等待下限（毫秒）",
    maxWaitMs: "单次等待上限（毫秒）",
    pollIntervalMs: "子代理状态检查间隔（毫秒）",
    maxResultChars: "结果字符上限",
    workflowProgressLog: "向 Agent 发送工作流进度",
    fullCommandEcho: "向 Agent 附上命令和脚本原文",
    subagentProvider: "子代理创建后端",
    jobKind: "命令作业类型标识",
    silentFailureGuard: "提醒检查没有输出的命令",
    uiLang: "插件界面语言",
    agentLang: "发给 Agent 的提示语言",
    // ── hint.<键>＝第一表「中文说明」列（16 个有原文行的字段；四「—」字段不设，
    //    其说明由组级键承担——残留即红）──
    "hint.boundPresets": "勾选后，使用该预设的会话会收到异步工具的使用指引。勾选不会安装工具，也不会打开待答面板或命令诊断。",
    "hint.askTakeover": "已选预设的主 Agent 提出普通问题时，在待答面板作答。关闭此项时，仍使用 DSH 的提问方式。",
    "hint.askUiSeat": "侧栏底部的按钮显示待答数量，点击后展开；右下角浮窗直接显示问题。",
    "hint.askTimeoutMs": "同批问题共享时限。到期后 Agent 可以继续，留在面板里的问题仍可作答。新时限用于后续提问。",
    "hint.askExtendMs": "点击「增加等待时间」时，给该会话中尚未到期的问题加时。",
    "hint.defaultYieldMs": "命令和工作流默认先等多久。到时没完成，就返回作业编号，任务在后台继续。",
    "hint.defaultWaitMs": "只改示例。每次调用 async_wait 仍须填写 wait_ms。",
    "hint.pollIntervalMs": "收不到子代理的状态更新时，按这个间隔再次检查。",
    "hint.maxResultChars": "限制同一次送给 Agent 的结果内容总量。多项结果共用上限；太长时会标明哪些内容被省略。",
    "hint.workflowProgressLog": "开启后，Agent 除结果外也收到阶段进度。界面里的原始记录仍可查看。",
    "hint.fullCommandEcho": "开启后，交付后台结果时可附上命令或脚本原文；原文和结果共用字符上限。",
    "hint.subagentProvider": "选择由哪项服务创建子代理。此处不选模型。",
    "hint.jobKind": "用于在作业列表和日志中识别命令作业。",
    "hint.silentFailureGuard": "在已选预设中，如果命令没有输出且有迹象表明它可能没运行，会提示 Agent 先检查。",
    "hint.uiLang": "用于本插件的设置、待答面板和其他由插件控制的界面文字。",
    "hint.agentLang": "用于发给 Agent 的工具说明、参数说明、错误和提示。",
    // ── help.<键>＝5.7.4 技术信息行句式（{键} 取本字段技术键；组级展开帮助由
    //    groupHelp.* 承担，字段级不再自拟长文）──
    "help.a11yName": "{名称}的说明",
    "help.boundPresets": "配置键：boundPresets",
    "help.askTakeover": "配置键：askTakeover",
    "help.askUiSeat": "配置键：askUiSeat",
    "help.askTimeoutMs": "配置键：askTimeoutMs",
    "help.askExtendMs": "配置键：askExtendMs",
    "help.defaultYieldMs": "配置键：defaultYieldMs",
    "help.defaultWaitMs": "配置键：defaultWaitMs",
    "help.pollIntervalMs": "配置键：pollIntervalMs",
    "help.maxResultChars": "配置键：maxResultChars",
    "help.workflowProgressLog": "配置键：workflowProgressLog",
    "help.fullCommandEcho": "配置键：fullCommandEcho",
    "help.subagentProvider": "配置键：subagentProvider",
    "help.jobKind": "配置键：jobKind",
    "help.silentFailureGuard": "配置键：silentFailureGuard",
    "help.uiLang": "配置键：uiLang",
    "help.agentLang": "配置键：agentLang",
    configKeyLine: "配置键：{键}",
    // ── 读数与徽标（5.7.4 读数/秒数/未知行；破折号「—」由渲染层直书不经词典）──
    "readout.current": "生效：{值}",
    "readout.unsaved": "待保存：{值}",
    "readout.unknown": "未知",
    "readout.subSecond": "小于 0.01 秒",
    "readout.secondsUnit": "{数值} 秒",
    overridden: "已自定义",
    reset: "清除自定义值",
    resetStagedNote: "保存后将移除自定义值",
    // ── 校验（5.7.4 原因档；{最大值}/{最小值} 含输入单位；链式两侧字段名）──
    invalidNumber: "请输入有效数字。",
    invalidInteger: "请输入正整数。",
    invalidRange: "不能大于 {最大值}。",
    invalidBelow: "不能小于 {最小值}。",
    "invalidPair.minYieldMs": "「{较小字段}」不能大于「{较大字段}」。",
    "invalidPair.defaultYieldMs": "「{较小字段}」不能大于「{较大字段}」。",
    "invalidPair.minWaitMs": "「{较小字段}」不能大于「{较大字段}」。",
    "invalidPair.defaultWaitMs": "「{较小字段}」不能大于「{较大字段}」。",
    "invalidPair.pollIntervalMs": "「{较小字段}」不能大于「{较大字段}」。",
    invalidJobKindEmpty: "命令作业的类型标识不能为空。",
    "boundList.notList": "此设置需要一份预设 ID 列表。",
    "boundList.emptyId": "预设 ID 不能为空。",
    "boundList.duplicate": "预设 ID 不能重复。",
    // ── 卸载风险两档（5.7.4；确认不受影响时整块隐藏，原单一键删除）──
    uninstallRiskKnown: "停用或卸载前，请先在 DSH 设置里更换默认预设，否则可能无法新建会话。",
    uninstallRiskUnconfirmed: "如果 DSH 默认预设来自此插件，请先在 DSH 设置里更换默认预设，再停用或卸载。",
    // ── 选项文案（5.7.5 选项表；语言自称不随当前界面改变）──
    "opt.uiLang.auto": "跟随 DSH",
    "opt.uiLang.zh": "中文",
    "opt.uiLang.en": "English",
    "opt.agentLang.en": "English（默认）",
    "opt.agentLang.zh": "中文",
    "opt.askUiSeat.sidebar": "侧栏底部（默认）",
    "opt.askUiSeat.overlay": "右下角浮窗",
    // ── 适用预设状态（5.7.6 表逐行；{预设列表} 用真实显示名、缺名用 ID）──
    "preset.effectiveList": "当前适用：{预设列表}",
    "preset.noneBound": "当前不应用于任何预设",
    "preset.draftList": "保存后适用：{预设列表}",
    "preset.draftNone": "保存后不应用于任何预设",
    "preset.loading": "正在读取预设…",
    "preset.empty": "没有可供选择的预设。",
    "preset.failed": "无法读取预设列表。",
    "preset.partialOnly": "当前只显示已有选择和未保存的修改。",
    "preset.unavailable": "预设列表服务暂不可用。",
    "preset.refresh": "刷新",
    "preset.retry": "重试",
    "preset.broken": "此预设未能加载。",
    "preset.absent": "当前列表中没有此预设。",
    "preset.detailEntry": "查看详情",
    "preset.reasonLabel": "原因：{原因}",
    // ── 待答面板（5.7.7 表逐行；en 单复数变体键 zh 同值注册保键集相等）──
    "ask.title": "待答问题",
    "ask.count": "{题数} 题待答",
    "ask.countOne": "{题数} 题待答",
    "ask.nonePending": "没有待答问题",
    "ask.lastRefreshCount": "上次刷新时有 {题数} 题待答。",
    "ask.lastRefreshCountOne": "上次刷新时有 {题数} 题待答。",
    "ask.lastRefreshNone": "上次刷新时没有待答问题。",
    "ask.loading": "正在读取问题…",
    "ask.countUnknown": "待答题数未知",
    "ask.refreshFailed": "暂时无法刷新待答问题。",
    "ask.autoRetry": "正在自动重试。",
    "ask.announceNew": "新增 {题数} 个待答问题",
    "ask.announceNewOne": "新增 {题数} 个待答问题",
    "ask.sessionLabel": "会话：{会话名}",
    "ask.sessionOrdinal": "会话 {会话编号}",
    "ask.jump": "打开会话",
    "ask.openSessionA11y": "打开会话：{会话}",
    "ask.windowLeft": "还剩 {时间}",
    "ask.deadline": "截止时间：{截止时间}",
    "ask.deadlineLastConfirmed": "上次确认的截止时间：{截止时间}",
    "ask.deadlineUnconfirmed": "截止时间未确认",
    "ask.panelUnavailable": "待答面板暂不可用。",
    "ask.panelUnavailableHint": "请到会话中查看提问。",
    "ask.expired": "等待已结束，仍可作答",
    "ask.extend": "增加等待时间",
    "ask.answer": "提交",
    "ask.ignore": "不答",
    "ask.submitting": "正在提交…",
    "ask.skipInProgress": "正在标记为不答…",
    "ask.customAnswer": "自定义回答",
    "ask.customPlaceholder": "输入回答",
    "ask.selectHint.one": "单选",
    "ask.selectHint.many": "多选",
    "ask.needSelect.one": "请选择一个选项，或填写自定义回答。",
    "ask.needSelect.many": "请选择一个或多个选项，或填写自定义回答。",
    "ask.customBlankInline": "请填写自定义回答，或取消选择这一项。",
    "ask.imeBlocked": "请先确认输入法候选文字，再提交。",
    "ask.notSubmitted": "回答未提交。",
    "ask.notSkipped": "没有标记为不答。",
    "ask.submitUnconfirmed": "无法确认回答是否送达。",
    "ask.skipUnconfirmed": "无法确认是否已标记为不答。",
    "ask.unconfirmedWaitRefresh": "请先等面板刷新，再决定是否重试。",
    "ask.undeliveredPanel": "回答未送达。",
    "ask.undeliveredSkip": "「不答」未送达。",
    "ask.retryInPanel": "可以在面板中重试。",
    "ask.replyOriginal": "也可以在原会话直接回复。",
    "ask.stateNoAnswerOriginal": "也可以在原会话说明不作答。",
    "ask.undeliveredFinal": "回答未送达，无法在面板里重试。",
    "ask.undeliveredSkipFinal": "「不答」未送达，无法在面板里重试。",
    "ask.gone": "这道题已无法在面板里处理。",
    "ask.goneHint": "如仍需回答，请在原会话回复。",
    "ask.deliveryUnconfirmed": "尚无法确认这次操作已送达。",
    "ask.deliveryUnconfirmedHint": "请先到原会话查看。",
    "ask.extendDenied": "未能增加等待时间。",
    "ask.extendDeniedHint": "请查看刷新后的剩余时间。",
    "ask.extendUnconfirmed": "无法确认是否已加时。",
    "ask.extendUnconfirmedHint": "请先等剩余时间刷新，避免重复加时。",
    "ask.noWaiting": "本会话没有还在等待回答的问题。",
    "ask.noWaitingHint": "仍可回答面板中已超时的问题。",
    "ask.rejectUnknownOption": "所选项不在题目中，请重新选择。",
    "ask.rejectSingleMultiple": "单选题只能选择一项。",
    "ask.rejectNothing": "请选择选项，或填写自定义回答。",
    "ask.dismissLost": "知道了"
  },
  en: {
    // ── Settings area and status (requirements 5.7.4, row by row) ──
    title: "Async tool settings",
    unavailable: "Settings are temporarily unavailable.",
    readOnly: "Settings are read-only here.",
    save: "Save",
    saving: "Saving…",
    saveFailed: "Settings weren’t saved. Your edits are still on this page.",
    "saveArea.unsavedWarning": "Leaving this page discards unsaved changes.",
    "saveArea.fixFirst": "Fix these settings before saving.",
    "saveArea.goToFirstError": "Go to first error",
    "saveArea.saved": "Settings saved.",
    "saveArea.unconfirmed": "Couldn’t confirm the save. Your edits are still here. Check the current values before trying again.",
    "degraded.unsynced": "Settings haven’t synced. The plugin is using fallback values for now.",
    "degraded.startup": "Saved settings are invalid. The plugin is using factory defaults for now. Fix the marked settings and save.",
    "degraded.startupReadonly": "Some settings are invalid, so the plugin is using defaults for now. Settings are read-only here.",
    "degraded.runtimeRejected": "The new settings are invalid. The plugin is still using the last valid values.",
    // ── Six group titles + ask subgroup + group markers (5.7.4) ──
    "group.presets": "Presets",
    "group.ask": "Pending questions",
    "group.askTimes": "Time limits and extensions",
    "group.budget": "Commands and waits",
    "group.agentContent": "What the agent receives",
    "group.advanced": "Advanced settings",
    "group.lang": "Language",
    "group.unsaved": "Unsaved changes",
    "group.error": "Settings need attention",
    // ── Group shared hints and expanded help (5.7.5 second table, verbatim) ──
    "groupHint.budget.firstWait": "How long to wait after starting. If a request falls outside the range, the nearer limit applies. If the work finishes sooner, the result returns right away.",
    "groupHint.budget.singleWait": "How long to wait on work that has already started. The range applies to positive durations. Use 0 to check the current status and available results without waiting.",
    "groupHelp.budget.firstWaitExample": "For example, with a 20-second first wait, a command that finishes in time returns its result right away. Otherwise, the job ID comes first and the result follows later. If you interrupt the conversation or cancel the wait, the job keeps running.",
    "groupHelp.budget.ranges": "Keep the default first wait and the example duration within their own ranges. The subagent check interval can’t exceed the maximum wait per call.",
    "groupHelp.agentContent.chars": "Results over the limit may show only the start and end, or arrive in parts. Use the directions shown with the result to recover what’s available. Job status and essential diagnostics are counted separately. This is a character limit, not a token limit.",
    "groupHelp.agentContent.shared": "Extra text also counts toward the result character limit. Turning off progress updates or original text does not hide command output, final results, or essential diagnostics.",
    "groupHelp.advanced.backend": "Leave blank to use the default backend. A custom backend must be available and support continuing a subagent session. If it can’t, the creation attempt explains why.",
    "groupHelp.presets.emptyList": "Clear all selections and save to apply these features to no presets. Running jobs and questions already in the panel are not affected.",
    "groupHelp.ask.lateAnswer": "You can answer later while the question is still in the panel. If it’s gone or the panel says the answer wasn’t delivered, reply in the original session.",
    "preset.chooseEntry": "Choose presets",
    // ── 20 field-name keys (5.7.5 first table, “English label” column verbatim) ──
    boundPresets: "Presets",
    askTakeover: "Handle questions in the pending panel",
    askUiSeat: "Where questions appear",
    askTimeoutMs: "Time to answer before the agent continues (ms)",
    askExtendMs: "Time added per extension (ms)",
    defaultYieldMs: "Default first wait (ms)",
    minYieldMs: "Minimum first wait (ms)",
    maxYieldMs: "Maximum first wait (ms)",
    defaultWaitMs: "Duration shown in wait examples (ms)",
    minWaitMs: "Minimum wait per call (ms)",
    maxWaitMs: "Maximum wait per call (ms)",
    pollIntervalMs: "Subagent status check interval (ms)",
    maxResultChars: "Result character limit",
    workflowProgressLog: "Send workflow progress to the agent",
    fullCommandEcho: "Attach the original command or script for the agent",
    subagentProvider: "Subagent backend",
    jobKind: "Command job type",
    silentFailureGuard: "Warn when a command may not have run",
    uiLang: "Plugin interface language",
    agentLang: "Language for agent instructions",
    // ── hint.键 = first table “English help” column (16 fields with rows;
    //    the four “—” fields get none — group keys carry it) ──
    "hint.boundPresets": "Sessions using a selected preset get guidance on using async tools. This doesn’t install tools or turn on the questions panel or command diagnostics.",
    "hint.askTakeover": "Answer ordinary questions from the main agent of a selected preset in the pending panel. When this setting is off, DSH handles questions as usual.",
    "hint.askUiSeat": "The sidebar button shows the pending count and opens the panel. The bottom-right panel shows questions directly.",
    "hint.askTimeoutMs": "Questions asked together share a deadline. When time is up, the agent can continue, and questions still in the panel can be answered later. Changes apply to new questions.",
    "hint.askExtendMs": "“Extend wait” adds this much time to questions in that session whose deadlines haven’t passed.",
    "hint.defaultYieldMs": "How long to wait when a command or workflow first starts. If it hasn’t finished when time is up, it keeps running in the background and the agent gets a job ID.",
    "hint.defaultWaitMs": "Changes the examples only. Each async_wait call still needs a wait_ms value.",
    "hint.pollIntervalMs": "If no status update arrives from a subagent, check again at this interval.",
    "hint.maxResultChars": "Limits how much result text is sent to the agent at once. Results delivered together share the limit, and shortened results show what was omitted.",
    "hint.workflowProgressLog": "Include progress updates in what the agent receives. Original records are still available in the interface.",
    "hint.fullCommandEcho": "Include the original command or script with background results. It shares the same character limit as the result text.",
    "hint.subagentProvider": "Choose the service that starts subagents. This does not select a model.",
    "hint.jobKind": "Identifies command jobs in job lists and logs.",
    "hint.silentFailureGuard": "For selected presets, tell the agent to check when a command has no output and may not have run.",
    "hint.uiLang": "Used for settings, the questions panel, and other text this plugin controls in the interface.",
    "hint.agentLang": "Used for tool descriptions, parameter help, errors, and guidance sent to the agent.",
    // ── help.键 = 5.7.4 config-key line（{键} 取该字段技术键）──
    "help.a11yName": "Help for {名称}",
    "help.boundPresets": "Config key: boundPresets",
    "help.askTakeover": "Config key: askTakeover",
    "help.askUiSeat": "Config key: askUiSeat",
    "help.askTimeoutMs": "Config key: askTimeoutMs",
    "help.askExtendMs": "Config key: askExtendMs",
    "help.defaultYieldMs": "Config key: defaultYieldMs",
    "help.defaultWaitMs": "Config key: defaultWaitMs",
    "help.pollIntervalMs": "Config key: pollIntervalMs",
    "help.maxResultChars": "Config key: maxResultChars",
    "help.workflowProgressLog": "Config key: workflowProgressLog",
    "help.fullCommandEcho": "Config key: fullCommandEcho",
    "help.subagentProvider": "Config key: subagentProvider",
    "help.jobKind": "Config key: jobKind",
    "help.silentFailureGuard": "Config key: silentFailureGuard",
    "help.uiLang": "Config key: uiLang",
    "help.agentLang": "Config key: agentLang",
    configKeyLine: "Config key: {键}",
    // ── Readouts and badges (5.7.4; the dash “—” is renderer-drawn) ──
    "readout.current": "Current: {值}",
    "readout.unsaved": "Unsaved: {值}",
    "readout.unknown": "Unknown",
    "readout.subSecond": "Less than 0.01 s",
    "readout.secondsUnit": "{数值} s",
    overridden: "Customized",
    reset: "Clear custom value",
    resetStagedNote: "Saving will remove the custom value",
    // ── Validation (5.7.4; bounds carry the input unit; chain is two-sided) ──
    invalidNumber: "Enter a valid number.",
    invalidInteger: "Enter a positive whole number.",
    invalidRange: "Enter no more than {最大值}.",
    invalidBelow: "Enter at least {最小值}.",
    "invalidPair.minYieldMs": "“{较小字段}” can’t be greater than “{较大字段}”.",
    "invalidPair.defaultYieldMs": "“{较小字段}” can’t be greater than “{较大字段}”.",
    "invalidPair.minWaitMs": "“{较小字段}” can’t be greater than “{较大字段}”.",
    "invalidPair.defaultWaitMs": "“{较小字段}” can’t be greater than “{较大字段}”.",
    "invalidPair.pollIntervalMs": "“{较小字段}” can’t be greater than “{较大字段}”.",
    invalidJobKindEmpty: "A saved command job type can’t be empty.",
    "boundList.notList": "This setting requires a list of preset IDs.",
    "boundList.emptyId": "A preset ID can’t be empty.",
    "boundList.duplicate": "Preset IDs can’t be repeated.",
    // ── Uninstall risk, two tiers (5.7.4; hidden when confirmed unaffected) ──
    uninstallRiskKnown: "Before disabling or uninstalling this plugin, change the default preset in DSH settings. Otherwise, new sessions may not open.",
    uninstallRiskUnconfirmed: "If your DSH default preset comes from this plugin, change it in DSH settings before disabling or uninstalling.",
    // ── Option copy (5.7.5 options table; language self-names never change) ──
    "opt.uiLang.auto": "Follow DSH",
    "opt.uiLang.zh": "中文",
    "opt.uiLang.en": "English",
    "opt.agentLang.en": "English (default)",
    "opt.agentLang.zh": "中文",
    "opt.askUiSeat.sidebar": "Sidebar footer (default)",
    "opt.askUiSeat.overlay": "Bottom-right panel",
    // ── Preset status (5.7.6, row by row) ──
    "preset.effectiveList": "Applies to: {预设列表}",
    "preset.noneBound": "No presets selected",
    "preset.draftList": "After saving: {预设列表}",
    "preset.draftNone": "After saving: no presets",
    "preset.loading": "Loading presets…",
    "preset.empty": "There are no presets to choose from.",
    "preset.failed": "Couldn’t load the preset list.",
    "preset.partialOnly": "Only saved selections and unsaved changes are shown.",
    "preset.unavailable": "The preset list service is unavailable.",
    "preset.refresh": "Refresh",
    "preset.retry": "Retry",
    "preset.broken": "This preset couldn’t load.",
    "preset.absent": "This preset isn’t in the current list.",
    "preset.detailEntry": "View details",
    "preset.reasonLabel": "Reason: {原因}",
    // ── Pending-questions panel (5.7.7, row by row; zh registers the en
    //    singular-variant keys with the zh plural value to keep key sets equal) ──
    "ask.title": "Pending questions",
    "ask.count": "{题数} questions pending",
    "ask.countOne": "1 question pending",
    "ask.nonePending": "No pending questions",
    "ask.lastRefreshCount": "Last refresh: {题数} questions pending.",
    "ask.lastRefreshCountOne": "Last refresh: 1 question pending.",
    "ask.lastRefreshNone": "No questions were pending at the last refresh.",
    "ask.loading": "Loading questions…",
    "ask.countUnknown": "Pending count unknown",
    "ask.refreshFailed": "Couldn’t refresh pending questions.",
    "ask.autoRetry": "Retrying automatically.",
    "ask.announceNew": "{题数} new questions",
    "ask.announceNewOne": "1 new question",
    "ask.sessionLabel": "Session: {会话名}",
    "ask.sessionOrdinal": "Session {会话编号}",
    "ask.jump": "Open session",
    "ask.openSessionA11y": "Open session: {会话}",
    "ask.windowLeft": "{时间} remaining",
    "ask.deadline": "Deadline: {截止时间}",
    "ask.deadlineLastConfirmed": "Last confirmed deadline: {截止时间}",
    "ask.deadlineUnconfirmed": "Deadline not confirmed",
    "ask.panelUnavailable": "The questions panel is unavailable.",
    "ask.panelUnavailableHint": "Check the conversation for questions.",
    "ask.expired": "The wait has ended. You can still answer.",
    "ask.extend": "Extend wait",
    "ask.answer": "Submit",
    "ask.ignore": "Skip",
    "ask.submitting": "Submitting…",
    "ask.skipInProgress": "Skipping…",
    "ask.customAnswer": "Custom answer",
    "ask.customPlaceholder": "Enter your answer",
    "ask.selectHint.one": "Choose one",
    "ask.selectHint.many": "Choose one or more",
    "ask.needSelect.one": "Choose one option or enter a custom answer.",
    "ask.needSelect.many": "Choose one or more options or enter a custom answer.",
    "ask.customBlankInline": "Enter a custom answer or deselect it.",
    "ask.imeBlocked": "Finish composing your text before submitting.",
    "ask.notSubmitted": "Answer wasn’t submitted.",
    "ask.notSkipped": "Question wasn’t skipped.",
    "ask.submitUnconfirmed": "Couldn’t confirm whether the answer was delivered.",
    "ask.skipUnconfirmed": "Couldn’t confirm whether the question was skipped.",
    "ask.unconfirmedWaitRefresh": "Wait for the panel to refresh before trying again.",
    "ask.undeliveredPanel": "The answer wasn’t delivered.",
    "ask.undeliveredSkip": "The skip wasn’t delivered.",
    "ask.retryInPanel": "You can try again in the panel.",
    "ask.replyOriginal": "You can also reply in the original session.",
    "ask.stateNoAnswerOriginal": "You can also tell the agent in the original session.",
    "ask.undeliveredFinal": "The answer wasn’t delivered and can’t be retried from the panel.",
    "ask.undeliveredSkipFinal": "The skip wasn’t delivered and can’t be retried from the panel.",
    "ask.gone": "This question is no longer available in the panel.",
    "ask.goneHint": "If you still need to answer, reply in the original session.",
    "ask.deliveryUnconfirmed": "Delivery hasn’t been confirmed.",
    "ask.deliveryUnconfirmedHint": "Check the original session first.",
    "ask.extendDenied": "No time was added.",
    "ask.extendDeniedHint": "Check the remaining time after the panel refreshes.",
    "ask.extendUnconfirmed": "Couldn’t confirm the extension.",
    "ask.extendUnconfirmedHint": "Wait for the remaining time to refresh before extending again.",
    "ask.noWaiting": "This session has no questions still waiting for an answer.",
    "ask.noWaitingHint": "You can still answer timed-out questions shown in the panel.",
    "ask.rejectUnknownOption": "The selected option isn’t available. Choose again.",
    "ask.rejectSingleMultiple": "Choose only one answer for this question.",
    "ask.rejectNothing": "Choose an option or enter a custom answer.",
    "ask.dismissLost": "Dismiss"
  }
};

// ── 提问接管的待答界面（需求 §4.2/设计 §4.3）────────────────────────────
//
// 通道：状态 = 轮询自有 typert remote 命名空间（1000 ms，模块 dispose 清除）；
// 作答/忽略/延长 = `answer`/`ignore`/`extend` 直调（载荷**裸传**，客户端按 wire 名
// 组装位置参数；answer 的 `selected` 为选项序号数组——RA-OPTION-IDENTITY，见
// AskItem 与 ASK_REMOTE 注释）；回执 `{ok,value|error}`（voice-input 同款判法）。
// 总开关关 → 模型停轮询、两座位渲染 null——零行为。
//
// 新题温和提醒（ASK-ANNOUNCE-01，需求 §4.2 新题提醒行）：状态读取的成功路径在
// 读取代数检查（弃置旧代与乱序旧回执）之后按复合键（batchId/questionId）算集合差识别新题，合并计数冻结成
// `state.announce`（语言取播报时刻的生效 uiLang，切换语言不重写已冻结文本；连续
// 同文按播报序号奇偶交替追加零宽空格）；播报走全界面唯一的视觉隐藏 live region
// （AskAnnouncer，挂 overlay 槽注册内、不设任何渲染门槛）。首查播报当时全部待答
// 数；读取失败不清已播集合；关闭清空。提醒是纯只读投影——不发 RPC、不改题目、
// 期限或答案状态。
//
// 组合期提交限制（ASK-IME-SUBMIT-01＋ASK-COMPOSITION-GESTURE，需求 §4.2.4 组合
// 期行）：输入法组合期间整题禁提交——平台层原生 disabled 拦住全部用户入口，
// submit 入口再复查当前组合位（承接程序化残余）与手势组合位（拦「组合期按下提交
// 按钮、失焦结束组合后同一手势抬起的 click」的迟到提交）；被拒动作当场终结、不
// 排队补发；组合结束按有效性恢复，等待新的明确提交。见 AskItem。

/** 轮询间隔（待答状态的轮询周期；1000 ms，与 host 侧 state() 的轮询预期一致）。 */
var ASK_STATE_POLL_MS = 1000;
/** 命名空间与服务键（设计 §4.3；与宿主 `lib/ask-takeover.js` 同串，对账锚点）。 */
var ASK_NAMESPACE = "async-tools-ask";
var ASK_SERVICE_KEY = "asyncToolsAsk";
// 服务端作答校验原因键 → 面板文案键的映射（需求 5.7.7 词典换血后客户端吸收
// 两处键名差）：服务端 `ask.rejectBlankCustom`（自定义空白）→ 客户端行内引导
// `ask.customBlankInline`；服务端 `ask.rejectSingleBoth`（单选同时选了选项与
// 自定义）→ 客户端 `ask.rejectSingleMultiple`（只选一个）。其余三键同名直映。
// 未知键保留回执原文，不把本包映射当作宿主原文。
var ASK_ANSWER_REJECTION_KEYS = {
  "ask.rejectUnknownOption": "ask.rejectUnknownOption",
  "ask.rejectSingleMultiple": "ask.rejectSingleMultiple",
  "ask.rejectBlankCustom": "ask.customBlankInline",
  "ask.rejectSingleBoth": "ask.rejectSingleMultiple",
  "ask.rejectNothing": "ask.rejectNothing"
};

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
 * answer 的 `submission.selected` 是选项序号数组（number[]，指向题目选项数组的
 * 下标；题目选项在服务端接管时冻结，序号即身份——RA-OPTION-IDENTITY），不是
 * 标签数组；state/ignore/extend 载荷不变。codec 双侧透传（invoke 期无 decode），
 * 序号合法性由服务端 validateAnswer 统一拒绝并可读。
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
 * 服务端停止计时）。状态回执统一经读取代数检查（设计 §4.3）：旧代（关闭／重开／卸载
 * 后到达）与乱序的较旧回执丢弃，较旧响应不回退新题目、计数与期限。
 *
 * 失败不静默（失败三分）：`callFailed` 分型旗标（null | 'submit' |
 * 'state' | 'extend' | 'answerRejected' | 'extendRejected'，面板顶按失败动作分键
 * 报错。RPC 拒绝（'submit'/'extend'，**没有确认**——执行与否未知，不断定
 * "未送达"，可重试）与宿主回执 `{ok:false}`（'answerRejected'/'extendRejected'，
 * **明确拒绝**——请求已送达、被拒，未执行可断定；作答档同时保存回执
 * error.message 与 details.reasonKey。message 保持 agentLang；面板按 uiLang
 * 翻译已知原因键，未知原因保留原文）分开报错；'extend' 两条路径
 * 都立即 poll() 复查真实期限（重试前先看刷新后的剩余时间——每次点击继续
 * 累加，不伪幂等）；
  * 宿主回执 `outcome:'gone'` 且带 `undelivered:true`（批次/题记录缺席——清扫、
  * 结清出列或交还，需求 §4.4）→ 'undelivered' 记入未送达名单（与 lostAnswers 同款逐条「知道了」消除、
   * 计入座位渲染条件——条目随轮询清空后报错仍在场，不随提交成功清除）；他处已落定的
  * 普通 gone 交轮询收敛（题目已有答案，不是未送达）；
 * 宿主回执 `outcome:'failed'`（迟到注入 followup/inject 抛错；服务端已把本题状态
 * 回滚为 open——题保持可再投、重交＝重新投递，设计 §4.3 ASK-LATE-FAILED-RETRY）
 * → 记入 `lostAnswers`（面板顶逐条列出报错——那一条答案这一次没有送达；面板不
 * 自动代用户重交，可修改后再交或到所属会话直接回复，需求 §4.4；与「提交后无
 * 确认」的 callFailed 档分开报）。竞态补醒失败（设计 §4.3）经 `state().lost` 名单随轮询并入——
 * 两个时点共用同一复合键去重与「知道了」消除（消除后服务端名单不回弹）。
 *
 * 新题温和提醒（ASK-ANNOUNCE-01）：成功读取在代数检查后按复合键 batchId/questionId
 * 算「本次回执 − 已播集合」的集合差；差集非空即合并计数生成一次 `state.announce`
 * （{text, seq}——text 在播报时刻按生效 uiLang 冻结，语言切换不重写已冻结文本），
 * 随后已播集合**裁剪到当前集合**（条目只出不进：batchId 每次接管唯一生成，同键不
 * 复现，裁剪有界；重开新批带新键照播）。首查（页面重载、重新开启、宿主恢复服务
 * 命名空间后的整体重挂）播报当时全部待答题数；读取失败不动已播集合、不播报（重
 * 连恢复后只播断线期间新增）；关闭清空已播集合并置 announce=null。倒计时走秒、
 * 同 items 重复轮询与 phase 变化都不触发播报（集合差为空 → announce 引用不变 →
 * DOM 文本不变，读屏只读变化）。
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
  // 新题已播集合与播报序号（ASK-ANNOUNCE-01）：复合键 batchId/questionId——与
  // lostAnswers/undelivered 的去重键、AskItem 的渲染键同一体系。集合只在成功读取
  // 的成功路径（代数检查通过后）变更：差集非空 → 播报并整体裁剪到当前集合（有界）；关闭 → 清空。
  var announcedKeys = new Set();
  var announceSeq = 0;
  var state = {
    enabled: false, seat: "sidebar", uiLang: "auto",
    serverNow: 0, fetchedAt: 0, items: [], callFailed: null, answerRejectReason: null, answerRejectReasonKey: null,
    // 最近一次成功读取的题目数（§4.3 面板标题三态）：null＝本会话尚无已证实
    // 计数（未知态）；成功读取记数值，读取失败后据此进旧缓存态。关闭清档时
    // 复位——重开从首查口径重新取证实。
    lastConfirmedCount: null,
    lostAnswers: [], undelivered: [], announce: null
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
      // 已证实计数随之清零（§4.3 标题三态）：关闭清档后重开从首查口径重新
      // 取证实——不把上个开启期的计数带入新生命周期冒充已证实。
      state.lastConfirmedCount = null;
      // 关闭同步清播报（ASK-ANNOUNCE-01）：已播集合清空、区域文本清空——不残留
      // 失效消息；重开按首查口径重新播报（开关往返的重复播报是显式操作的结果）。
      announcedKeys.clear();
      state.announce = null;
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

  /** 状态回执的代数检查（设计 §4.3）：旧代（关闭／重开／卸载后到达）与
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
    // 已证实计数（§4.3 标题三态）：成功读取记当前数——此后读取失败时标题进
    // 旧缓存态（上次读取已证实 {题数} 题），不再冒充当前值；确证零题同记 0。
    state.lastConfirmedCount = state.items.length;
    // 新题识别与播报（ASK-ANNOUNCE-01）：成功路径、代数检查后——旧代/乱序回执到
    // 不了这里，已播事实不被回退。差集非空才生成新 announce（同 items 重复轮询差
    // 集为空 → announce 引用不变 → DOM 文本不变，读屏只读变化）；文案只含数量、
    // 在播报时刻按生效 uiLang 冻结（首查=本生命周期首个成功读取，全部在场待答题
    // 合并成一条；读取失败路径在上方早退，不动已播集合）。
    var currentKeys = new Set(state.items.map(function (it) {
      return it.batchId + "/" + it.questionId;
    }));
    var newKeys = [];
    currentKeys.forEach(function (key) {
      if (!announcedKeys.has(key)) newKeys.push(key);
    });
    if (newKeys.length > 0) {
      announceSeq += 1;
      state.announce = {
        // 文案只含数量与题目来源会话、无操作指令；单数变体键（需求 5.7.7：
        // en 有 one 变体，zh 注册同值键保持键集相等）。语言取播报时刻的
        // 生效 uiLang（上方冻结说明）。
        text: askTranslator(state.uiLang, localeService)(
          newKeys.length === 1 ? "ask.announceNewOne" : "ask.announceNew")
          .replace("{题数}", String(newKeys.length)),
        seq: announceSeq
      };
    }
    // 已播集合裁剪到当前集合（有界）：一个复合键只能随批次接管产生（batchId 每次
    // 接管唯一生成），条目离开列表只因其落定、批次出列、清扫或交还——同键不会重
    // 现；能使旧键「复活」的旧回执已被代数检查挡在计算之前。
    announcedKeys = currentKeys;
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
      // 完成回调恰一次归还（§4.3 空回执安全处理）：多分支（含末端 catch）
      // 竞争时 busy 不双重释放；onDone 是 AskItem 的 busy 释放通道，不归还＝
      // 提交按钮永久禁用。
      var done = false;
      var finish = function (ok) {
        if (done) return;
        done = true;
        onDone(ok);
      };
      remote.answer({ batchId: item.batchId, questionId: item.questionId, selected: selected, custom: custom })
        .then(function (result) {
          // 回执不可读（undefined／null／非对象，含缺 ok/value 形状的其余形态）
          // ＝无有效确认（§4.3）：不能断定执行与否——不伪成功也不伪失败，
          // 不读空回执的字段（修前在失败分支读 result.error 抛 TypeError、
          // onDone 不归还）。与明确拒绝（ok:false，可断定未执行）分开报；
          // 不立即重试——以 state 轮询刷新为准，先等面板状态再决定。
          if (result === undefined || result === null || typeof result !== "object") {
            state.callFailed = 'submitUnconfirmed';
            notify();
            finish(false);
            poll();
            return;
          }
          // 成功只有两种回执；failed（迟到注入没送达）与记录缺席的 gone
          // （undelivered，需求 §4.4）都记可消除报错名单，普通 gone 交轮询收敛。
          if (result.ok !== true) {
            // 失败三分——ok:false 是宿主**明确拒绝**（请求已送达、被拒）：可断定
            // 未执行；与 RPC 拒绝（'submit'，执行与否未知）分开报，不混说"未送达"。
            // 回执 error 按 gateway 契约携带 {code,message,details}：message
            // 保留 agentLang 模型文案；同时保存 details.reasonKey，供面板按
            // uiLang 翻译本包已知原因。未知或无键的原因保留原串。
            state.callFailed = 'answerRejected';
            state.answerRejectReason = result.error !== undefined && result.error !== null
              && typeof result.error.message === "string" && result.error.message !== ""
              ? result.error.message : null;
            state.answerRejectReasonKey = result.error && result.error.details
              && typeof result.error.details.reasonKey === "string"
              ? result.error.details.reasonKey : null;
            notify();
            finish(false);
            return;
          }
          var outcome = result.value !== undefined && result.value !== null ? result.value.outcome : undefined;
          if (outcome !== "delivered" && outcome !== "late") {
            // 两种失败都进名单而非旗标：failed 形态题目回滚 open 待重投
            // （ASK-LATE-FAILED-RETRY，需求 §4.4）——条目仍留在面板；gone＋
            // undelivered 形态条目随下轮轮询清空。纯旗标会连面板一起消隐（座位
            // 渲染条件只认 items/名单），报错必须被人看到并手动消除。他处已落定的普通 gone 不记
            // 名——题目已有答案，交轮询收敛，不是未送达。
            if (outcome === "failed") recordLost(item);
            if (outcome === "gone" && result.value !== undefined && result.value !== null
              && result.value.undelivered === true) recordUndelivered(item);
            finish(false);
            return;
          }
          // 成功只清**本动作族**的旗标（'submit'/'answerRejected'/
          // 'submitUnconfirmed'）——延长族（'extend'/'extendRejected'）与读取档
          // （'state'）不受牵连；丢失/未送达名单是逐条事实记录，不随成功清除
          // （「知道了」手动消除）。
          if (state.callFailed === 'submit' || state.callFailed === 'answerRejected'
            || state.callFailed === 'submitUnconfirmed') {
            state.callFailed = null;
            state.answerRejectReason = null;
            state.answerRejectReasonKey = null;
          }
          finish(true);
          poll();
        }, function () {
          // RPC 拒绝＝没有确认（'submit'，可重试）——不确定结果不能断定"未送达"
          // （服务端可能已执行，只是响应丢失）。
          state.callFailed = 'submit';
          notify();
          finish(false);
        })
        // 动作链末端最终 catch（§4.3）：任何回调链异常（名单记录、通知等）都
        // 经它归还 busy 并显错——结果未知，按无有效确认口径报，提交按钮不因
        // 链上异常永久禁用。
        .catch(function () {
          state.callFailed = 'submitUnconfirmed';
          notify();
          finish(false);
        });
    },
    ignore: function (item, onDone) {
      if (remote === undefined) { onDone(false); return; }
      var done = false;
      var finish = function (ok) {
        if (done) return;
        done = true;
        onDone(ok);
      };
      remote.ignore({ batchId: item.batchId, questionId: item.questionId })
        .then(function (result) {
          // 与 answer 同判：回执不可读＝无有效确认（§4.3）——不读空回执字段、
          // 不伪成功也不伪失败，先等 state 轮询刷新再决定是否重试提交。
          if (result === undefined || result === null || typeof result !== "object") {
            state.callFailed = 'submitUnconfirmed';
            notify();
            finish(false);
            poll();
            return;
          }
          if (result.ok !== true) {
            // 与 answer 共用拒绝状态：同时更新原串与原因键，避免沿用上次作答的键。
            // 忽略路径现无自有拒绝生产者；未知或无键的 message 在面板原样显示。
            state.callFailed = 'answerRejected';
            state.answerRejectReason = result.error !== undefined && result.error !== null
              && typeof result.error.message === "string" && result.error.message !== ""
              ? result.error.message : null;
            state.answerRejectReasonKey = result.error && result.error.details
              && typeof result.error.details.reasonKey === "string"
              ? result.error.details.reasonKey : null;
            notify();
            finish(false);
            return;
          }
          var outcome = result.value !== undefined && result.value !== null ? result.value.outcome : undefined;
          if (outcome !== "delivered" && outcome !== "late") {
            if (outcome === "failed") recordLost(item);
            // 与作答同口径（需求 §4.4）：忽略提交命中记录缺席 → 未送达名单。
            if (outcome === "gone" && result.value !== undefined && result.value !== null
              && result.value.undelivered === true) recordUndelivered(item);
            finish(false);
            return;
          }
          // 与 answer 同族：成功清提交族旗标与拒绝原因；名单不随成功清除。
          if (state.callFailed === 'submit' || state.callFailed === 'answerRejected'
            || state.callFailed === 'submitUnconfirmed') {
            state.callFailed = null;
            state.answerRejectReason = null;
            state.answerRejectReasonKey = null;
          }
          finish(true);
          poll();
        }, function () {
          state.callFailed = 'submit';
          notify();
          finish(false);
        })
        .catch(function () {
          state.callFailed = 'submitUnconfirmed';
          notify();
          finish(false);
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

/** 待答面板的自有样式（只引用定义表内的别名 token，check-alias-tokens 把关）。
 *  视觉隐藏类 `.ats-ask-sr`（ASK-ANNOUNCE-01）只用几何裁剪，不引用任何颜色——
 *  T14 颜色守卫（test/two-planes.test.mjs）与别名 token 检查同判。
 *
 *  VIS-INPUT-01：字号与命中区按档分开处理——待答输入（textarea）默认 16px
 *  安全档（<16px 时 iOS Safari 聚焦会自动放大页面），仅细指针且可悬停环境降
 *  13px（媒体块置于基础规则之后）；交互控件 24px 辅助档，提交与不答同排
 *  44px 操作档（VIS-ACTION-TIER-01）。页面缩放不设限：本包不加 viewport 的
 *  maximum-scale/user-scalable 限制（禁缩放不是放大命中区的替代手段）。
 */
var ASK_CSS = ""
  // VIS-BADGE-01：面板宽度窄视口钳制（390px 侧栏形态下 340px 固定宽会横向溢出）。
  // sidebar 座位宽度钳制 calc(100vw - 76px)：侧栏收起列实测约 56px 且
  // overflow:hidden——仅右锚 16px 时 340px 固定宽在 390 视口左缘（x=34）落进
  // 列内、裁到列内图标右缘。右锚 16px＋本钳制在一切宽度下左缘 ≥60px（列 56
  // ＋4px 净空；410px 视口恰取 334px 宽、左缘 60），宽视口仍 340px 上限右锚
  // 原位（768 下左缘 412，与列横向分离）；overlay 座位维持两缘 16px 原位。
  + ".ats-ask-panel{position:fixed;right:16px;bottom:16px;z-index:10000;"
  + "width:min(340px,calc(100vw - 32px));"
  + "max-height:60vh;overflow:auto;box-sizing:border-box;padding:12px;"
  + "border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;"
  + "background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);"
  + "font-size:13px;line-height:1.5}"
  + ".ats-ask-title{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0 0 8px}"
  + ".ats-ask-group{border-top:.5px solid var(--dsw-alias-border-l2);padding:8px 0}"
  + ".ats-ask-grouphead{display:flex;align-items:center;gap:8px;"
  + "color:var(--dsw-alias-label-tertiary);font-size:12px}"
  + ".ats-ask-jump{margin-left:auto;background:none;border:none;cursor:pointer;"
  + "color:var(--dsw-alias-brand-primary);font-size:13px;padding:0;"
  + "min-height:24px;box-sizing:border-box}"
  + ".ats-ask-extend{background:none;border:.5px solid "
  + "var(--dsw-alias-border-l4);border-radius:8px;cursor:pointer;"
  + "color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;"
  + "padding:2px 8px;min-height:24px;box-sizing:border-box}"
  + ".ats-ask-q{padding:6px 0}"
  + ".ats-ask-text{margin:0 0 6px}"
  + ".ats-ask-opts{display:flex;flex-direction:column;gap:4px;margin-bottom:6px}"
  + ".ats-ask-opt{display:flex;align-items:flex-start;gap:8px;text-align:left;"
  + "border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:none;"
  + "color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;"
  + "padding:6px 8px;min-height:24px;box-sizing:border-box}"
  // VIS-HOVER-01：作答项（预设选项）真实指针悬停规则——背景亮起与选中态同
  // 色但选中另带 brand 描边（区分不靠唯一颜色）；触摸屏点按的瞬时悬停不残留
  // 语义（背景变化是提示不是状态）。
  + ".ats-ask-opt:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}"
  + ".ats-ask-opt[data-selected='true']{background:var(--dsw-alias-interactive-bg-hover);"
  + "border-color:var(--dsw-alias-brand-primary)}"
  + ".ats-ask-opt:focus-visible,.ats-ask-optctl:focus-visible,"
  + ".ats-ask-custom .ats-ask-input:focus-visible,"
  + ".ats-ask-submit:focus-visible,.ats-ask-skip:focus-visible,"
  + ".ats-ask-extend:focus-visible,.ats-ask-jump:focus-visible,"
  + ".ats-ask-dismiss:focus-visible"
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
  + ".ats-ask-custom{display:flex;flex-direction:column;align-items:stretch;gap:6px;"
  + "border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:none;"
  + "padding:6px 8px}"
  + ".ats-ask-custom[data-selected='true']{background:var(--dsw-alias-interactive-bg-hover);"
  + "border-color:var(--dsw-alias-brand-primary)}"
  + ".ats-ask-optctl{display:flex;align-items:flex-start;gap:8px;background:none;"
  + "border:none;cursor:pointer;font:inherit;font-size:13px;padding:0;"
  + "min-height:24px;box-sizing:border-box;color:var(--dsw-alias-label-primary)}"
  // VIS-HOVER-01：自定义作答开关的悬停可辨识（文字色加深；无背景壳可亮）。
  + ".ats-ask-optctl:hover{color:var(--dsw-alias-state-business-primary)}"
  // 上下布局（需求 §4.2.2）：第一行选择控件与标题，输入框独占该项可用内容
  // 宽度；多行编辑——初始可见至少三行（VIS-INPUT-01 两档字号下均成立：
  // 6em − padding 12 − 边框 1 ≥ 3 × 1.5 × 字号——13px 档 78−13=65 ≥ 58.5、
  // 16px 档 96−13=83 ≥ 72），长文本自动换行（pre-wrap），超出可见高度纵向滚动，可拖拽扩高。
  + ".ats-ask-custom .ats-ask-input{flex:none;width:100%;min-height:6em;"
  + "resize:vertical;overflow-y:auto;white-space:pre-wrap;word-break:break-word;"
  + "line-height:1.5;margin-bottom:0}"
  + ".ats-ask-reason{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:4px 0 0}"
  + ".ats-ask-selecthint{color:var(--dsw-alias-label-secondary);font-size:12px;margin:2px 0 0}"
  + ".ats-ask-submit:disabled{opacity:.5;cursor:not-allowed}"
  + ".ats-ask-input{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);"
  + "border-radius:8px;background:var(--dsw-alias-bg-layer-3);font:inherit;"
  // VIS-INPUT-01 两档机制（默认安全档）：基础档 16px——iOS Safari 对 <16px
  // 的聚焦输入自动放大页面；字号到 16px 即不触发（不得用禁用缩放替代这条）。
  // 仅「细指针且可悬停」的环境降 13px（与题干/选项标题同级）——媒体查询只
  // 保证指针与悬停组合、不保证设备形态，粗指针与不可判环境一律落基础档；
  // 媒体块必须置于本基础规则之后（层叠生效前提，T24 另有位置断言）。
  + "font-size:16px;padding:6px 8px;color:var(--dsw-alias-label-primary);margin-bottom:6px}"
  + "@media (pointer:fine) and (hover:hover){.ats-ask-input{font-size:13px}}"
  + ".ats-ask-row{display:flex;align-items:center;gap:8px}"
  + ".ats-ask-submit{border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;"
  + "background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-3);"
  // VIS-ACTION-TIER-01：44px 操作档（提交）——与「不答」同排同高；主次差
  // 异只走底色与描边。
  + "cursor:pointer;font:inherit;font-size:13px;padding:4px 12px;"
  + "min-height:44px;box-sizing:border-box}"
  // VIS-ACTION-TIER-01：44px 操作档（不答）——与提交同排同高，不以缩小提交
  // 点击区换取外观一致（同档抬升）；差异只走底色与描边。
  + ".ats-ask-skip{border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;"
  + "background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;"
  + "font:inherit;font-size:13px;padding:4px 12px;min-height:44px;box-sizing:border-box}"
  + ".ats-ask-left{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px}"
  + ".ats-ask-expired{color:var(--dsw-alias-state-error-primary);font-size:12px}"
  + ".ats-ask-failed{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:4px 0}"
  + ".ats-ask-dismiss{margin-left:8px;padding:0 8px;font-size:13px;"
  + "min-height:24px;box-sizing:border-box;"
  + "border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;"
  + "background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}"
  // sidebar 座位形态：徽标长在侧栏底栏的窄图标槽——面板上移让出底栏整行。
  // 390×844 实测底栏顶=视口底−88（徽标顶 756）；让位取 94px＝底栏 88＋净空
  // 6（泡已内联、四边含于徽标盒内，6px 为净空余量），两档宽度下面板与徽标
  // 盒零重叠。overlay 座位维持右下角原位（该形态无底栏徽标）。
  + ".ats-ask-panel--sidebar{bottom:94px;"
  + "width:min(340px,calc(100vw - 76px))}"
  // ── 侧栏徽标（窄图标列几何）──────────────────────────────────────────
  // 宿主窄侧栏图标列（.pI_x6G_sidebarCol）实测仅约 52px 且 overflow:hidden——
  // 徽标盒固定 50px ≤ 52px 列。宿主化形态（VIS-BADGE-01）：无边框透明底、与
  // 底栏控件同排等高 28px；图标与内联计数泡作为一组在固定盒内居中（图标 16
  // ＋间距 3＋泡：数字 12px、min-width 18、内边距 0 3px——按 UI 数字宽
  // 6.6–7.4px 验算 999 组宽最大 47.2px ≤ 50，零至三位计数完整；四位及以上
  // 为登记的极端退化形态，对称溢出固定盒、按列缘裁切）。
  + ".ats-ask-badge{display:inline-flex;align-items:center;justify-content:center;"
  + "gap:3px;width:50px;border:none;border-radius:8px;background:none;"
  + "color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;"
  + "font-size:12px;padding:0;min-height:28px;box-sizing:border-box}"
  // VIS-HOVER-01：真实指针悬停的可辨识态（与宿主卡片同款 interactive-bg-hover；
  // 键盘焦点另有 focus-visible 描边，不与悬停混用同一通道）。
  + ".ats-ask-badge:hover{background:var(--dsw-alias-interactive-bg-hover);"
  + "color:var(--dsw-alias-label-primary)}"
  + ".ats-ask-badge:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);"
  + "outline-offset:1px}"
  // 徽标图标（VIS-BADGE-01）：问号圆环——紧凑图标替代文字标签，宽度不再随
  // 语言膨胀；图形随按钮文字色（label-secondary，浅底 ≈5.8:1、深底 ≥7:1，
  // 必要图形对比达标），悬停/聚焦同步加深（继承 color）。
  + ".ats-ask-badge svg{flex:none;width:16px;height:16px}"
  // 计数泡（内联形态）：error 底＋白字维持警示语义；泡是徽标内联组成员
  // （flex:none），四边含于按钮盒内、不与图标相交。对比度：
  // 12px 数字是普通文字——出厂 error 令牌两主题都配白字不足（浅 red-600
  // #ec1313 白字 4.50 临界、深 red-400 #f25a5a 白字 3.29），组件级语义色
  // 加深底补足：浅色混黑 8%（实算 5.19:1）、深色令牌更亮需混黑 38%（实算
  // 7.20:1）；color-mix 用法与宿主 bVCLcG_arrow 同款，深色档选择器
  // body[data-ds-dark-theme] 与宿主 onboarding 同款；混黑/白字用
  // achromatic 关键字（black/white）而非十六进制字面量——颜色仍取主题令牌
  // 现值，不写死颜色、不覆盖宿主全局变量。
  + ".ats-ask-count{flex:none;min-width:18px;"
  + "height:18px;line-height:18px;text-align:center;padding:0 3px;"
  + "border-radius:999px;"
  + "background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 92%, black);"
  + "color:white;font-size:12px;font-weight:600}"
  + "body[data-ds-dark-theme] .ats-ask-count{"
  + "background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 62%, black)}"
  // 视觉隐藏的播报区域（ASK-ANNOUNCE-01）：几何裁剪隐藏（1px＋clip-path），
  // 读屏可得、视觉无感；无任何颜色引用。
  + ".ats-ask-sr{position:absolute;width:1px;height:1px;margin:-1px;"
  + "overflow:hidden;clip-path:inset(50%);white-space:nowrap}"

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
 *
 * 组合期提交限制（ASK-IME-SUBMIT-01＋ASK-COMPOSITION-GESTURE，需求 §4.2.4 组
 * 合期行）：输入法组合期间整题禁提交——平台层原生 disabled 拦住鼠标/触屏/键盘
 * 三入口（与既有 `!valid` 禁用同形态：不可聚焦、不派发 click/键激活）；`submit()`
 * 入口再复查两个组合位。composingRef（当前组合位）承接程序化点击（对 disabled
 * 元素直接 dispatchEvent/click() 的合成路径）与 compositionstart 到下一次渲染之
 * 间微窗口内的残余；gestureComposingRef（手势组合位）拦迟到提交——组合期按下
 * 提交按钮，按下使输入框失焦，blur 复位当前组合位、按钮重新可用后，同一手势抬
 * 起才派发 click。一次手势开始时的组合状态决定该次提交是否被拒，同一手势内的
 * blur/compositionend 不使其获准（组合状态在按钮 pointerdown 时抄录，时序先于
 * mousedown→blur；手势结束即清位，中断手势不留残留，见组件内手势组合位注释）。
 * 客户端不存在 Enter/快捷键提交路径（textarea 的 Enter 是换行），键盘面由「平台
 * 层拦截＋离开输入框即结束组合」结构性覆盖。被拒动作当场终结、不排队补发（无延
 * 迟提交队列或意图标记），保留草稿与已选项；compositionend 后按有效性恢复启用，
 * 等待一次新的明确提交。「不答」不受组合影响（仅既有 busy 拦截）；服务端校验零
 * 改动。
 */
function AskItem(props) {
  var item = props.item;
  var t = props.t;
  var ask = props.ask;
  var multi = item.multiSelect === true;
  // 选择状态（需求 §4.2.1）：预设项集合 + 自定义项独立选中位。单选（multiSelect
  // 缺省 false）点任一项是**替换**并清自定义选中；多选各自切换、互不清除——
  // 与原生 user-questions 的 choose() 同语义。预设项以题内选项序号为身份
  // （RA-OPTION-IDENTITY）：options 顺序由服务端接单冻结副本提供、跨轮询稳定
  // （item 以 batchId/questionId 挂键，刷新不重建组件），同标签不同说明的选项
  // 各自独立选中；提交载荷 selected 即序号数组（wire 契约见 ASK_REMOTE 注释）。
  var reducer = function (state, action) {
    if (action.type === "preset") {
      if (action.multiSelect === true) {
        var next = new Set(state.presets);
        if (next.has(action.index)) next.delete(action.index); else next.add(action.index);
        return { presets: next, custom: state.custom };
      }
      return { presets: new Set([action.index]), custom: false };
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
  // 输入法组合状态（ASK-IME-SUBMIT-01）：每题独立（每题一个 AskItem 实例）。
  // ref 供事件回调与 submit 复查读（组合位的置/复位不受渲染批影响），镜像 state
  // 供按钮/原因行/data-composing 渲染。compositionstart 同步置位（React 离散事件
  // 同步派发）；compositionend 与 onBlur 都复位且幂等共存——失焦即组合终结，
  // 个别引擎失焦不派发 compositionend 时提交限制不致卡死；compositionupdate 不
  // 单独建状态（中间文本经下方 onChange 进草稿，无需跟踪）。
  var composingRef = React.useRef(false);
  var composingPair = React.useState(false);
  var composing = composingPair[0];
  var setComposing = composingPair[1];
  function endComposition() {
    composingRef.current = false;
    setComposing(false);
  }
  // 手势组合位（ASK-COMPOSITION-GESTURE，需求 §4.2.4 组合期行）：提交按钮
  // pointerdown 时抄录当前组合位与**该手势的指针身份**——指针事件先于
  // mousedown→blur 到达，抄到的值代表「本次手势开始时是否处于组合期」。组合期
  // 按下按钮、按下使输入框失焦后，blur/compositionend 只复位当前组合位，同一
  // 手势抬起派发的 click 由 submit() 复查此位当场拒绝（保留草稿与已选项，不
  // 排队补发）。位在该**同一指针**的结束事件后清空：清位经 document 级
  // pointerup/pointercancel 捕获监听按 pointerId 匹配（多点触控时另一指针的
  // 抬起不得清掉仍按在按钮上的那次组合手势——否则该手势随后抬起派发的 click
  // 会在组合已结束后被误放行；鼠标恒为同一常量 pointerId，行为与单指针一致）
  // 加宏任务延迟：click 在 pointerup 之后同步派发，清位必须排在 click 之后
  // （setTimeout(0)）；监听器与未触发的清位定时器随组件卸载成对清理，不泄
  // 漏。抄录时同时撤销未触发的清位定时器——上一手势的清位不得抹掉新手势刚抄录
  // 的值（两次按下之间该定时器可能仍未运行）。被中断的手势（按下后拖离、无
  // click）不残留影响键盘提交——键盘激活按钮不产生指针事件，无从刷新此位。
  var gestureComposingRef = React.useRef(false);
  var gesturePointerIdRef = React.useRef(null);
  var gestureClearTimerRef = React.useRef(null);
  function recordGestureComposing(event) {
    if (gestureClearTimerRef.current !== null) {
      window.clearTimeout(gestureClearTimerRef.current);
      gestureClearTimerRef.current = null;
    }
    gestureComposingRef.current = composingRef.current;
    gesturePointerIdRef.current = event?.pointerId ?? null;
  }
  React.useEffect(function () {
    if (typeof document === "undefined") return; // 无 DOM 环境（无头测试）不挂监听
    function scheduleGestureClear(event) {
      // 只认同一指针的结束：他指针的 pointerup/pointercancel 不清仍按住的手势位。
      if ((event?.pointerId ?? null) !== gesturePointerIdRef.current) return;
      if (gestureClearTimerRef.current !== null) return;
      gestureClearTimerRef.current = window.setTimeout(function () {
        gestureClearTimerRef.current = null;
        gestureComposingRef.current = false;
        gesturePointerIdRef.current = null;
      }, 0);
    }
    document.addEventListener("pointerup", scheduleGestureClear, true);
    document.addEventListener("pointercancel", scheduleGestureClear, true);
    return function () {
      document.removeEventListener("pointerup", scheduleGestureClear, true);
      document.removeEventListener("pointercancel", scheduleGestureClear, true);
      if (gestureClearTimerRef.current !== null) {
        window.clearTimeout(gestureClearTimerRef.current);
        gestureClearTimerRef.current = null;
      }
    };
  }, []);
  // 本地走秒（需求 §4.3「倒计时继续运行」）：显示层每秒自跳一格，**不依赖轮询返回**——
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
  // 文案值（需求 5.7.7）：「还剩 {时间}」的值＝秒读数词（词典带单位）；期限
  // 时刻经悬停 title 提供（ask.deadline），按界面语言取本地时间文本。
  var leftSeconds = Math.ceil(leftMs / 1000);
  var leftText = leftMs > 0
    ? t("ask.windowLeft").replace("{时间}",
        t("readout.secondsUnit").replace("{数值}", String(leftSeconds)))
    : t("ask.expired");
  var deadlineWord = t("ask.deadline").replace("{截止时间}",
    new Date(item.expiresAt)
      .toLocaleTimeString(props.uiLang === "en" ? "en-US" : "zh-CN"));
  // 有效性（需求 §4.2.4）：无选中项不可提交；选中的自定义文本去首尾空白后为空
  // 同样不可提交——多选已选预设项也不能掩盖。空白检查只判有效性，不改写文本。
  var hasAnswer = selection.presets.size > 0 || selection.custom;
  var customBlank = selection.custom && draft.trim() === "";
  var valid = hasAnswer && !customBlank;
  function submit() {
    // 组合期复查（ASK-IME-SUBMIT-01＋ASK-COMPOSITION-GESTURE）：平台层 disabled
    // 拦住全部用户入口，这里再读两个 ref 承接残余——composingRef（当前组合位）
    // 覆盖组合仍在进行时的程序化点击：compositionstart 与下一次渲染之间微窗口内
    // 的点击、对 disabled 元素直接 dispatchEvent/click() 的合成路径（disabled 元
    // 素不收用户事件，程序分发仍可触达监听器）；gestureComposingRef（手势组合
    // 位）覆盖组合期开始的手势——按下使输入框失焦、当前组合位已复位后，同一手
    // 势的迟到 click 仍拒绝。被拒动作当场终结，保留草稿与选择，无补发队列。
    if (busyRef.current || composingRef.current || gestureComposingRef.current || !valid) return;
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
  // 题号进 DOM id 前先 encodeURIComponent（ASK-QUESTION-ID-AX）：宿主对题号无字符
  // 限制（含 HTML ASCII 空白 SPACE/TAB/LF/FF/CR，探针证实原串往返），空白直拼会使
  // aria-labelledby 按 IDREF 分词把 id 拆成多个不存在的引用——选项组失去可及名称。
  // 编码可逆，不同题号不碰撞（"a b"→a%20b、"a\tb"→a%09b）；不能用「空白统一替
  // 换成某字符」——那会让两个题号撞同一 DOM id、第二组挂错题干。
  var questionDomId = "ats-q-" + item.batchId + "-" + encodeURIComponent(item.questionId);
  var optionRole = multi ? "checkbox" : "radio";
  var customOn = function () { dispatch({ type: "customOn", multiSelect: multi }); };
  var options = item.options.map(function (option, index) {
    // 选项身份＝题内序号（RA-OPTION-IDENTITY）：key/选中判定/动作载荷都用序号
    // ——同标签不同说明的选项各自独立（React 重复 key 消除、aria-checked 逐钮
    // 独立）；可用名称靠选项体自含的说明文本区分（A10）。
    var on = selection.presets.has(index);
    return React.createElement("button", {
      key: "opt-" + index, type: "button", className: "ats-ask-opt",
      role: optionRole, "aria-checked": on ? "true" : "false",
      "data-selected": on ? "true" : "false", "data-multi": multi ? "true" : "false",
      onClick: function () { dispatch({ type: "preset", index: index, multiSelect: multi }); }
    },
      React.createElement("span", { className: "ats-ask-mark", "aria-hidden": "true" }),
      React.createElement("span", { className: "ats-ask-optbody" },
        React.createElement("span", { className: "ats-ask-optlabel" }, option.label),
        typeof option.description === "string" && option.description !== ""
          ? React.createElement("span", { className: "ats-ask-optdesc" }, option.description)
          : null));
  });
  // data-composing 是浏览器探针的组合态锚点（ASK-IME-SUBMIT-01）——探针据此断
  // 言组合期提交钮禁用与 compositionend 后复位，无需猜内部状态。
  return React.createElement("div", { className: "ats-ask-q", "data-composing": composing ? "true" : "false" },
    React.createElement("p", { className: "ats-ask-text", id: questionDomId }, item.question),
    // 单选／多选语境（需求 5.7.7）：就题关联、不替用户选择——组本身仍由题干
    // 命名（aria-labelledby），语境行是可见补充。
    React.createElement("p", { className: "ats-ask-selecthint" },
      t(multi ? "ask.selectHint.many" : "ask.selectHint.one")),
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
        // 多行编辑（需求 §4.2.2）：textarea 而非单行 input——Enter 插入换行、
        // 不触发提交（提交走下方按钮），输入法组合期的确认键由 textarea/IME
        // 默认行为消费、同样不提交；换行与正文原样交付（4.2.4）。点击输入框
        // 选中自定义项；键盘 Tab 聚焦不选中（只认点击与主动输入）。输入非空白
        // 文本同样选中（取消后的重新选中路径）。
        // 组合事件（ASK-IME-SUBMIT-01）：start 置位组合限制、end/blur 复位（幂等
        // 共见上方 composingRef 注释——复位只作用于当前组合位；组合期按下提交按
        // 钮的手势由手势组合位另行记下，end/blur 不让同一手势获准，见
        // recordGestureComposing 注释）；浏览器在 compositionend 与最终 input 事件
        // 的先后上各有差异——两个事件都到达、各司其职（草稿更新走 onChange，限
        // 制复位走 compositionend/onBlur），有效性是渲染时从 draft+selection 现算
        // 的派生值，无先后依赖。
        React.createElement("textarea", {
          className: "ats-ask-input", rows: 3, value: draft,
          placeholder: t("ask.customPlaceholder"), "aria-label": t("ask.customAnswer"),
          onClick: customOn,
          onCompositionStart: function () {
            composingRef.current = true;
            setComposing(true);
          },
          onCompositionEnd: endComposition,
          onBlur: endComposition,
          onChange: function (event) {
            var value = event.target.value;
            setDraft(value);
            if (value.trim() !== "") customOn();
          }
        }))),
    React.createElement("div", { className: "ats-ask-row" },
      React.createElement("button", {
        type: "button", className: "ats-ask-submit", onClick: submit,
        // 手势起点抄录（ASK-COMPOSITION-GESTURE）：pointerdown 先于 mousedown→
        // blur 到达，此处抄录手势开始时的组合状态供 submit() 复查（见上方手势组
        // 合位注释）；只记录、不 preventDefault——失焦照常发生。
        onPointerDown: recordGestureComposing,
        // 平台层拦截（ASK-IME-SUBMIT-01）：组合位与既有 !valid/busy 同为原生
        // disabled——鼠标/触屏/键盘三入口在平台层就不被接受。disabled 只反映当前
        // 组合位：手势中途失焦结束组合后按钮重新可用，同一手势的提交由 submit()
        // 复查手势组合位拒绝。
        disabled: !valid || busyRef.current || composing
      }, t(busyRef.current ? "ask.submitting" : "ask.answer")),
      React.createElement("button", {
        type: "button", className: "ats-ask-skip", onClick: skip
      }, t(busyRef.current ? "ask.skipInProgress" : "ask.ignore")),
      React.createElement("span", {
        className: item.phase === "expired" ? "ats-ask-left ats-ask-expired" : "ats-ask-left",
        title: deadlineWord
      }, leftText)),
    // 就近原因（ASK-IME-SUBMIT-01 扩展）：组合期优先于空白自定义/未选择——用户
    // 先完成输入，再谈有效性；「不答」入口不受组合影响（上方 skip 按钮无组合位）。
    // 原因行随当前组合位渲染：手势中途失焦结束组合后，组合中提示退场、按钮重新
    // 可用，但同一手势的提交仍被 submit() 的手势组合位拒绝——该拒绝不另设提示，
    // 草稿与选择原地保留，等待新的明确操作。
    // 文案（需求 5.7.7）：组合期＝ask.imeBlocked；空白自定义＝ask.customBlankInline
    //（行内引导）；未选择＝单选/多选两键 needSelect.one／needSelect.many。
    (composing || !valid) && !busyRef.current
      ? React.createElement("p", { className: "ats-ask-reason" },
          t(composing ? "ask.imeBlocked"
            : customBlank ? "ask.customBlankInline"
            : multi ? "ask.needSelect.many" : "ask.needSelect.one"))
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
  // 面板标题计数（需求 5.7.7）：读取中（首次读取未返回）→ ask.loading；本会话
  // 尚无已证实计数（首读失败）→ ask.countUnknown——不以空 items 生成的 0 冒充
  // 确证零题（失败与无题不可区分即失败不可发现）；读取失败但有上次成功计数 →
  // 按上次计数如实标注读取时点（lastRefresh 三键：0 题／1 题／{题数} 题）；
  // 读取成功 → 当前计数（nonePending／countOne／{题数}）。可见文本与
  // aria-label 用同一构造；失败说明由 .ats-ask-failed 专行承载，不拼进计数词。
  var titleCountWord;
  if (state.lastConfirmedCount === null) {
    titleCountWord = state.callFailed === "state"
      ? t("ask.countUnknown") : t("ask.loading");
  } else if (state.callFailed === "state") {
    titleCountWord = state.lastConfirmedCount === 0
      ? t("ask.lastRefreshNone")
      : state.lastConfirmedCount === 1
      ? t("ask.lastRefreshCountOne")
      : t("ask.lastRefreshCount").replace("{题数}", String(state.lastConfirmedCount));
  } else {
    titleCountWord = state.items.length === 0
      ? t("ask.nonePending")
      : state.items.length === 1
      ? t("ask.countOne")
      : t("ask.count").replace("{题数}", String(state.items.length));
  }
  // 作答拒绝的原因句：服务端键经映射表换客户端键（差两键，见
  // ASK_ANSWER_REJECTION_KEYS）；未知键或缺席时保留回执原文。
  var rejectCopyKey = state.answerRejectReasonKey !== null
    && Object.prototype.hasOwnProperty.call(ASK_ANSWER_REJECTION_KEYS, state.answerRejectReasonKey)
    ? ASK_ANSWER_REJECTION_KEYS[state.answerRejectReasonKey] : null;
  var nodes = [];
  groups.forEach(function (items, sessionId) {
    nodes.push(React.createElement("div", { key: sessionId, className: "ats-ask-group" },
      React.createElement("div", { className: "ats-ask-grouphead" },
        React.createElement("span", null,
          // 会话 id 一律以 "session-" 开头，裸 slice(0,8) 会让所有组头
          // 撞成同一个 "session session-"——无法区分（也会害探针点错组）。去前缀再截。
          t("ask.sessionOrdinal").replace("{会话编号}",
            String(sessionId).replace(/^session-/, "").slice(0, 8))),
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
          "aria-label": t("ask.openSessionA11y").replace("{会话}", sessionId),
          onClick: function () { ask.actions.jump(sessionId); }
        }, t("ask.jump"))),
      items.map(function (item) {
        return React.createElement(AskItem, {
          key: item.batchId + "/" + item.questionId, item: item, t: t, ask: ask,
          serverNow: state.serverNow, fetchedAt: state.fetchedAt, uiLang: state.uiLang
        });
      })));
  });
  return React.createElement("div", {
    className: props.panelClass === undefined ? "ats-ask-panel" : "ats-ask-panel " + props.panelClass
  },
    React.createElement("p", {
      className: "ats-ask-title",
      "aria-label": t("ask.title") + " · " + titleCountWord
    },
      t("ask.title") + " · " + titleCountWord),
    state.callFailed ? React.createElement("p", { className: "ats-ask-failed" },
      // 失败行按失败动作分键（需求 5.7.7 的失败族行）：明确拒绝（作答被宿主
      // 拒）＝未提交句＋原因句；状态读取失败＝刷新失败＋自动重试；延长请求
      // 未确认＝提示句＋等待指引；明确拒绝延长＝未加时＋刷新后核对剩余时间；
      // 提交未确认＝结果未知＋先等刷新再决定。原因键未知或缺席时保留回执
      // 原文（agentLang message），不把本包自有原因当作宿主原文。
      (state.callFailed === 'answerRejected'
        ? t("ask.notSubmitted") + (rejectCopyKey !== null
          ? " " + t(rejectCopyKey)
          : state.answerRejectReason ? " " + state.answerRejectReason : "")
        : state.callFailed === 'state'
        ? t("ask.refreshFailed") + " " + t("ask.autoRetry")
        : state.callFailed === 'extend'
        ? t("ask.extendUnconfirmed") + " " + t("ask.extendUnconfirmedHint")
        : state.callFailed === 'extendRejected'
        ? t("ask.extendDenied") + " " + t("ask.extendDeniedHint")
        // 无有效确认（§4.3 空回执）：结果未知——文案不把未知送达说成失败或
        // 成功，出路＝先等 state 轮询刷新再决定是否重试提交。
        : state.callFailed === 'submitUnconfirmed'
        ? t("ask.submitUnconfirmed") + " " + t("ask.unconfirmedWaitRefresh")
        : t("ask.notSubmitted") + " " + t("ask.unconfirmedWaitRefresh"))) : null,
    state.undelivered.map(function (und) {
      // 与 lostAnswers 同款逐条「知道了」——记录已不在，报错必须被人看到，看到后
      // 可收走（需求 §4.4：未送达可见，且出路写在文案：未送达且无法在面板重试，
      // 如仍需回答请在原会话回复）。
      return React.createElement("p", {
        key: "undelivered-" + und.batchId + "/" + und.questionId, className: "ats-ask-failed"
      },
        t("ask.undeliveredFinal") + " " + t("ask.goneHint") + " · " + und.question + " ",
        React.createElement("button", {
          type: "button", className: "ats-ask-dismiss",
          onClick: function () { ask.actions.dismissUndelivered(und.batchId, und.questionId); }
        }, t("ask.dismissLost")));
    }),
    state.lostAnswers.map(function (lost) {
      // 逐条「知道了」消除——报错必须被人看到，看到后可手动收走。丢失答案
      // 用未送达句＋面板重试指引（已到宿主、投递失败）：题目回滚 open，仍可
      // 作答，但不自动重试。用户在面板重新提交才会重新投递，也可打开所属会话
      // 直接回复；会话 id 在场时给跳转按钮，与组头「打开会话」同款动作（需求
      // §4.4）。
      return React.createElement("p", {
        key: "lost-" + lost.batchId + "/" + lost.questionId, className: "ats-ask-failed"
      },
        t("ask.undeliveredPanel") + " " + t("ask.retryInPanel") + " · " + lost.question + " ",
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
 * 生效语言档解析（座位翻译器与新题播报冻结共用的一小段，避免两处各写一套漂移）：
 * 显式 zh/en 直接用；auto 档经客户端 `ctx.locale` 读取侧解析宿主当前语言（渲染
 * 订阅 `getSnapshot().active`、一次性读 `getLocale()`——返回值是快照对象，只读不
 * 写）；解析不出或解析到 zh/en 之外（locale 服务缺席的旧装载环境/单测未注入同判）
 * 回退 en。
 *
 * @param {string} uiLang - 生效的语言开关值（auto/zh/en）。
 * @param {object} [locale] - `ctx.locale` 服务（可缺席）。
 * @returns {string} "zh" | "en"。
 */
function resolveAskLang(uiLang, locale) {
  if (uiLang === "zh" || uiLang === "en") return uiLang;
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
    if (active === "zh" || active === "en") return active;
  }
  return "en";
}

/**
 * 座位/面板的文案翻译：`uiLang` 的 auto 档经 resolveAskLang 解析宿主当前语言；
 * zh/en 走本包词典；两档之外回退 en 词典（「不得裸键名」护栏维持）。
 *
 * @param {string} uiLang - 生效的语言开关值（auto/zh/en）。
 * @param {object} [locale] - `ctx.locale` 服务（可缺席）。
 */
function askTranslator(uiLang, locale) {
  return makeTranslator(resolveAskLang(uiLang, locale), function (key) {
    return DICTIONARIES.en[key] !== undefined ? DICTIONARIES.en[key] : key;
  });
}

/**
 * 座位渲染条件的公共口径：计数 > 0、存在未消除的 lostAnswers 或未送达名单
 * （undelivered——记录缺席的提交）才显示。failed（expired 批迟到提交）题目
 * 回滚 open 留在面板、计数在场；undelivered 在记录缺席后条目随轮询清空、
 * 计数归零——条件若只看计数，gone＋undelivered 形态（单题批次最常见）的报错
 * 永不显示。未读失败不算「处理完」，消除后
 * 才回到消隐口径。新题播报（state.announce）不进本条件——播报区域常驻在场，
 * 不是面板显形条件。题目读取失败（`callFailed === 'state'`）同样显形（§4.3）：
 * 失败档的在场最小形态是徽标本体（图标、无计数泡，见 AskSidebarSeat），面板
 * 展开时失败说明常驻——读取失败与零题可区分，且轮询自动重试。
 */
function askHasFace(state) {
  return state.items.length > 0 || state.lostAnswers.length > 0 || state.undelivered.length > 0
    || state.callFailed === "state";
}

/**
 * 新题温和提醒的播报区域（ASK-ANNOUNCE-01，需求 §4.2 新题提醒行）：全待答界面
 * 唯一的视觉隐藏 live region——`role="status"`＋显式 `aria-live="polite"` /
 * `aria-atomic="true"`（role 隐含 polite 与 atomic，显式双写给探针一个确定断言
 * 面，也覆盖个别读屏对隐式语义支持不全的形态）。polite＝变更排入读屏队列、等
 * 当前语音结束再播（温和提醒、不打断朗读）；atomic＝文本替换时整条朗读。区域
 * 不设任何渲染门槛（不受 enabled/seat/askHasFace 约束，挂法见 wireAskSeats）：
 * overlay 常显、sidebar 展开、sidebar 收起（徽标态，面板不渲染）三形态都常驻，
 * 座位切换不卸载。区域不可聚焦、不调 focus()——播报前后焦点不动；文案只含数
 * 量，不读题干（题目内容仍由用户主动导航）。
 */
function AskAnnouncer(props) {
  var state = React.useSyncExternalStore(props.ask.store.subscribe, props.ask.store.getSnapshot);
  // sidebar 座位且面板未展开时样式同样就位（注入幂等）。
  injectAskStyles();
  var announce = state.announce;
  var text = announce === null || announce === undefined ? "" : announce.text;
  // 连续两次同文提醒（如两次各新增 1 题）DOM 不变则部分读屏不重播：按 seq 奇偶
  // 交替追加零宽空格——文本恒有差异、读屏不朗读该字符、视觉无感；不引入异步
  // 「清空再写」两段式（假窗测试环境不可调度，且时序依赖读屏实现）。
  if (announce !== null && announce !== undefined && announce.seq % 2 === 0) text += "\u200B";
  return React.createElement("span", {
    className: "ats-ask-sr",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true"
  }, text);
}

/** overlay 座位浮框（渲染条件见 askHasFace：题目与两类报错名单任一在场）。 */
function AskOverlaySeat(props) {
  var state = React.useSyncExternalStore(props.ask.store.subscribe, props.ask.store.getSnapshot);
  if (!state.enabled || state.seat !== "overlay" || !askHasFace(state)) return null;
  return React.createElement(AskList, { ask: props.ask });
}

/** sidebar 座位徽标（渲染条件见 askHasFace；徽标＝未处理数入口，点击展开题目）。
 * VIS-BADGE-01：宿主窄侧栏图标列仅约 52px——徽标为固定 50px 的无边框盒、
 * 与底栏控件同排等高 28px，问号圆环图标与内联计数泡在盒内居中（几何见
 * 样式段注释），完整名称走 `aria-label`（屏幕阅读器与无障碍树恒可得，
 * 不依赖悬停），面板标题行（.ats-ask-title）承载可见全名。`aria-expanded`
 * 同步开合态。题目读取失败档（§4.3）：计数泡不呈现（零题显示 0 会冒充已
 * 证实的零题；未送达/丢失名单非空时同样不呈现——失败档一律最小在场），
 * `aria-label` 改载失败说明、不虚构题目数，图标本体即失败入口；读取成功
 * 后回到计数形态。 */
function AskSidebarSeat(props) {
  var state = React.useSyncExternalStore(props.ask.store.subscribe, props.ask.store.getSnapshot);
  var openRef = React.useRef(false);
  var rerender = React.useState(0)[1];
  if (!state.enabled || state.seat !== "sidebar" || !askHasFace(state)) return null;
  injectAskStyles();
  var t = askTranslator(state.uiLang, props.ask.locale);
  var stateFailed = state.callFailed === "state";
  return React.createElement(React.Fragment, null,
    React.createElement("button", {
      type: "button", className: "ats-ask-badge",
      "aria-label": t("ask.title") + " · "
        + (stateFailed ? t("ask.refreshFailed") : t("ask.count").replace("{题数}", String(state.items.length))),
      "aria-expanded": openRef.current ? "true" : "false",
      onClick: function () { openRef.current = !openRef.current; rerender(function (n) { return n + 1; }); }
    },
      React.createElement("svg", {
        viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false"
      },
        React.createElement("circle", {
          cx: 8, cy: 8, r: 6.5, fill: "none",
          stroke: "currentColor", strokeWidth: 1.4
        }),
        React.createElement("text", {
          x: 8, y: 11.6, textAnchor: "middle",
          fontSize: 9.5, fontWeight: 600, fill: "currentColor"
        }, "?")),
      stateFailed
        ? null
        : React.createElement("span", { className: "ats-ask-count" }, String(state.items.length))),
    openRef.current
      ? React.createElement(AskList, { ask: props.ask, panelClass: "ats-ask-panel--sidebar" })
      : null);
}

var inject = ["slots", "locale", "configForms", "remote", "uiWorkspace"];
function apply(ctx) {
  ctx.effect(function () {
    return ctx.locale.register(NS, DICTIONARIES);
  }, "async-tools: dictionaries");
  // ── 预设功能绑定（需求 9.4.2）：目录模型 + 动态注入 + 变更通知 ────────────
  // inject 清单**不加** `remote.agentPresets`——把该服务声明为必需依赖（inject
  // 硬性等待）会让服务缺席的部署整卡不装。改为设置卡 whileServed 条件内
  // **动态注入**（与 ask 座位同一成例）：
  // 服务在场 → catalog.attach 触发首读；永不到场 → 停在 error 态（服务缺席
  // 文案＋重试），设置卡与其余字段不受影响，已存绑定仍可查看与取消。
  var presetCatalog = createPresetCatalog();
  ctx.effect(function () {
    return ctx.configForms.whileServed([ENTRY], function () {
      // fiber 生命周期（ACCEPT-CLIENT-INJECT-01 设计 §5.3）：`ctx.inject` 同步
      // 返回 fiber 本体——返回值即句柄，不经 `then` 解包（其 resolve 值不是
      // 清理函数）；退出清理＝`fiber.dispose()` 一次并置空（pending 也可
      // dispose，迟到完成由此覆盖），重服务/断连由 fiber 内部重估。注入回调
      // 自身返回清理函数：清空目录持有的服务引用，服务实现变化（fiber 先拆
      // 旧 episode、清理跑后重跑回调）时目录不留陈旧代理。
      var fiber = ctx.inject(["remote.agentPresets"], function (scope) {
        presetCatalog.attach(scope.remote.agentPresets);
        return function () { presetCatalog.detach(); };
      });
      return function () {
        if (fiber !== null && typeof fiber.dispose === "function") fiber.dispose();
        fiber = null;
      };
    });
  }, "async-tools: preset catalog service");
  // 变更通知（设计 §5.5，宿主成例 dsh-client-ui-agent-preset 的 settings
  // refresh）：宿主无专门的预设增删事件，可用通知 = `settings/document-updated`
  //（命名空间 `agent-preset-registry`——预设声明的增删改走设置文档）＋
  // `connection/reset`；纯内存态变化不被通知覆盖的缺口由绑定块的手动刷新按钮
  // 承接（需求 9.4.2「通过宿主可用的变更通知更新列表」按此口径满足）。
  ctx.effect(function () {
    var disposers = [
      ctx.remote.$on("settings/document-updated", function (ns) {
        if (ns !== "agent-preset-registry") return;
        presetCatalog.load();
      }),
      ctx.on("connection/reset", function () { presetCatalog.load(); })
    ];
    return function () {
      for (var i = 0; i < disposers.length; i += 1) disposers[i]();
    };
  }, "async-tools: preset catalog notices");

  // 宿主行在服务这个命名空间之前不注册卡片（部署无痕语义）。
  // keyed 槽：register options 必须带 `key`（缺 key 抛错）；bundle 槽的键 = **包名**。
  ctx.effect(function () {
    return ctx.configForms.whileServed([ENTRY], function () {
      return ctx.slots.inject("plugins.bundle.config", function () {
        return ctx.slots.register({
          name: "plugins.bundle.config",
          key: PACKAGE_NAME,
          locale: NS
        }, makeBundleCard(ctx, presetCatalog));
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
    // 播报区域挂在 overlay 槽注册内、与座位组件并列返回（ASK-ANNOUNCE-01）：
    // overlay 槽是全帧浮层槽、条目自定位，一个 1px 绝对定位元素不参与布局、
    // 无视觉副作用。区域**不设任何渲染门槛**——不受 state.seat/state.enabled/
    // askHasFace 约束：overlay 座位、sidebar 展开、sidebar 收起（徽标态，面板不
    // 渲染）三形态都常驻，座位切换（overlay↔sidebar）不卸载，切换瞬间到达的新
    // 题不丢提醒。座位接线先完成渲染，state() 的回执要跨一次 RPC 往返，首查播
    // 报预期晚于区域挂载；极端调度下若首查文本随挂载初值在场，部分读屏不读初
    // 始内容——AX-4 探针在真实实例上实测覆盖该时序。
    var disposeOverlay;
    try {
      disposeOverlay = ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          { name: "shell.overlay", id: "async-tools-ask", order: 900 },
          function () {
            return React.createElement(React.Fragment, null,
              React.createElement(AskAnnouncer, { ask: ask }),
              React.createElement(AskOverlaySeat, { ask: ask, ctx: ctx }));
          }
        );
      });
    } catch (error) {
      // 第一槽注入抛错时已建的 ask 模型（订阅＋轮询）无人收拾——先 dispose 再
      // 上抛：「不留半套」对「模型在、槽全无」的反向形态同样成立（需求 7.2）。
      ask.dispose();
      throw error;
    }
    var disposeSidebar;
    try {
      disposeSidebar = ctx.slots.inject("sidebar.footer.action", function () {
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
    } catch (error) {
      // 第二槽注册抛错时第一槽已滞留——先释放已装部分再上抛：座位接线要么
      // 整套装上、要么全不占（需求 7.2 生命周期不留半套）。
      disposeOverlay();
      ask.dispose();
      throw error;
    }
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
      // fiber 生命周期（同上方 preset catalog 的 ACCEPT-CLIENT-INJECT-01 口径，
      // SOL-REQ-02）：`ctx.inject` 同步返回 fiber 本体——句柄必须保存并在停用
      // 时 `dispose()`（pending 也可 dispose，迟到完成由 fiber 覆盖）；句柄
      // 丢弃会让每次启用都向宿主命名空间多挂一份注入接线。注入回调可重入
      // （服务实现变化时 fiber 先拆旧 episode、重跑回调）：重入先释放上一套
      // 座位接线再装新的——覆盖丢弃会同时滞留旧 ask 模型的轮询、设置订阅与
      // 槽注册（各自翻倍累积，需求 7.2 生命周期释放）。
      var inner = null;
      var fiber = null;
      var cancelled = false;
      // 顺序：$mount 先落（失败则 seats 不装）。单链 .catch 兼承两类失败：
      // $mount 拒绝与 onFulfilled 内的同步抛错（如 ctx.inject 抛错）——双参
      // .then 的 onRejected 只承接挂载自身拒绝，fulfillment 内抛错会落入无人
      // 处理的派生 Promise 拒绝，诊断行不打印（SOL-REQ-02 诊断可见性口径）。
      Promise.resolve(askMount).then(function () {
        if (cancelled) return;
        fiber = ctx.inject(["remote." + ASK_NAMESPACE], function (scope) {
          // 重入先拆旧（回调重跑前旧 episode 仍在册）；迟到激活（停用后回调
          // 才跑）立即回收，不留无人引用的活模型。
          if (inner !== null) { inner(); inner = null; }
          var wired = wireAskSeats(ctx, scope.remote[ASK_NAMESPACE]);
          if (cancelled) { wired(); return; }
          inner = wired;
        });
        if (fiber && typeof fiber.catch === "function") {
          fiber.catch(function (error) {
            (window.console && window.console.error) && window.console.error("[dsh-async-tools] ask seats inject failed", error);
          });
        }
      }).catch(function (error) {
        // 外层（$mount 失败 / inject 抛错）不得静默——待答界面消失必须有人在控制台看见。
        (window.console && window.console.error) && window.console.error("[dsh-async-tools] ask seats wiring failed", error);
      });
      return function () {
        cancelled = true;
        if (inner !== null) { inner(); inner = null; }
        if (fiber && typeof fiber.dispose === "function") fiber.dispose();
        fiber = null;
      };
    });
  }, "async-tools: ask takeover seats");
}

var name = PACKAGE_NAME;

module.exports = {
  name: name,
  inject: inject,
  apply: apply,
  secondsWord: secondsWord,
  secondsNumber: secondsNumber,
  draftReadout: draftReadout,
  composeHint: composeHint,
  makeBundleCard: makeBundleCard,
  makeTranslator: makeTranslator,
  uiLangOf: uiLangOf,
  enumFieldSpec: enumFieldSpec,
  flagFieldSpec: flagFieldSpec,
  presetBindingFieldSpec: presetBindingFieldSpec,
  decodeBoundDraft: decodeBoundDraft,
  makeSpecs: makeSpecs,
  FieldShell: FieldShell,
  resolveCopy: resolveCopy,
  createCardModel: createCardModel,
  makeSettingsScopeView: makeSettingsScopeView,
  settingsLayerOf: settingsLayerOf,
  createPresetCatalog: createPresetCatalog,
  PresetBindingBlock: PresetBindingBlock,
  createAskModel: createAskModel,
  /** 设计 §4.3 座位可见判据（含状态读取失败档，测试锚定用）。 */
  askHasFace: askHasFace,
  AskList: AskList,
  AskItem: AskItem,
  AskAnnouncer: AskAnnouncer,
  AskOverlaySeat: AskOverlaySeat,
  AskSidebarSeat: AskSidebarSeat,
  askTranslator: askTranslator,
  resolveAskLang: resolveAskLang,
  ASK_REMOTE: ASK_REMOTE,
  ASK_NAMESPACE: ASK_NAMESPACE,
  ASK_SERVICE_KEY: ASK_SERVICE_KEY,
  ASK_STATE_POLL_MS: ASK_STATE_POLL_MS,
  /** 待答面板样式表原文（VIS-INPUT-01/VIS-BADGE-01 的浏览器外判据：测试
   *  从这里分区解析两档字号/命中区档位/槽宽，钉住 24px 辅助档与 44px 操作档
   *  的档位处理与徽标窄列几何）。 */
  ASK_CSS: ASK_CSS,
  passthroughCodec: passthroughCodec,
  DICTIONARIES: DICTIONARIES,
  FIELDS: FIELDS,
  /** 六组折叠结构与组级帮助键序（设计 §5.3/§5.6；判据13 六组形态、组序、
   *  默认开合、帮助按钮五组的对账锚点）。 */
  GROUPS: GROUPS,
  GROUP_HELP_KEYS: GROUP_HELP_KEYS,
  /** 保存区阻止清单与字段行原因句（测试锚定用：两处原因句逐字一致）。 */
  blockedFieldsOf: blockedFieldsOf,
  invalidLabelOf: invalidLabelOf,
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
  /** 设计 §5.4 三档取值（测试锚定用）：CHAIN_UNKNOWN＝候选不可知哨兵（该侧跳过比较）。 */
  chainNumber: chainNumber,
  CHAIN_UNKNOWN: CHAIN_UNKNOWN,
  /** 设计 §5.4 参与判据（测试锚定用）：null＝单字段档缺席；UNKNOWN＝候选不可知。 */
  chainComparable: chainComparable,
  pairViolated: pairViolated,
  chainHitOf: chainHitOf,
  /** 卡片状态投影（测试锚定用，UI-CLEAR-03）：userHas＝原始用户层键存在性、base＝清覆盖回退值。 */
  projectCardState: projectCardState,
  LANG_KEYS: LANG_KEYS,
  ENTRY: ENTRY,
  PACKAGE_NAME: PACKAGE_NAME,
  SLOT_NAME: "plugins.bundle.config",
  SLOT_KEY: PACKAGE_NAME
};
return module.exports; } });
