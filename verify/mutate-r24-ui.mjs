/**
 * R24 界面判据的变异证明（r22 交接清单 P3）。
 *
 * 被测判据在 `verify/r24-judgements.mjs`（纯函数），取数分别由
 * `verify/acceptance-017.mjs r24-ui`（注入表 + 下发字节）与
 * `verify/_visual/probe-r24-bundle-config.mjs`（插件页 DOM + 保存往返）负责。
 *
 * 变异原则与 `verify/mutate-facts-anchors.mjs` 相同：**每一条判据都要能被改坏打成红**，
 * 任何一条没红就报 UNCAUGHT 并退出 1（不设 SKIP）。
 *
 * 字段清单**从代码取**（`lib/config.js` 的 `BUDGET_FIELD_KEYS`），不在本文件里抄一份——
 * 抄一份就会漂移（本文件曾经手写 10 个键、第 10 个写成 `agentBackend`，而代码里是
 * `subagentProvider`，那一组"身份"变异因此一直作用在假清单上）。
 *
 * 用法：node verify/mutate-r24-ui.mjs
 */
import { judgeDeliveredBytes, judgeConfigForm, judgePlacement, judgeReadoutFollows, judgeRoundTrip } from './r24-judgements.mjs';
import { BUDGET_FIELD_KEYS, LANG_FIELD_KEYS, FLAG_FIELD_KEYS, ASK_FIELD_KEYS, MS_FIELD_KEYS } from '../lib/config.js';

const results = [];
/**
 * 跑一条变异。
 *
 * @param {string} name - 变异名。
 * @param {boolean} expectRed - 期望判据结论。
 * @param {() => { ok: boolean, detail: string }} run - 跑一次判据。
 */
function mutation(name, expectRed, run) {
  const verdict = run();
  const ok = verdict.ok === !expectRed;
  results.push(ok);
  console.log(`${ok ? 'CAUGHT  ' : 'UNCAUGHT'} ${name}`);
  console.log(`          判据成立=${String(verdict.ok)}（期望 ${expectRed ? '不成立' : '成立'}）${verdict.detail}`);
}

// ── 第一段：注入表取回的下发字节 ──────────────────────────────────────────
const goodBytes = '<script>class AsyncToolsBundleCard{}; slots.register({name:"plugins.bundle.config",key:"dsh-async-tools"})</script>';

mutation('M1 基线：新实现的字节必须判成立', false, () => judgeDeliveredBytes(200, goodBytes));
mutation('M2 退回组件行槽（plugins.row.config）必须判不成立', true, () => judgeDeliveredBytes(200,
  '<script>class AsyncToolsBundleCard{}; slots.register({name:"plugins.row.config"})</script>'));
mutation('M3 卡片类名不在（没投递本包）必须判不成立', true, () => judgeDeliveredBytes(200,
  '<script>slots.register({name:"plugins.bundle.config"})</script>'));
mutation('M4 取数失败（非 200）必须判不成立', true, () => judgeDeliveredBytes(404, goodBytes));
mutation('M5 挂回官方槽 plugins.item 必须判不成立', true, () => judgeDeliveredBytes(200,
  '<script>class AsyncToolsBundleCard{}; slots.register({name:"plugins.item"})</script>'));

// ── 第二段：插件页的设置区 DOM 读数（含放置） ─────────────────────────────
// ⚠️ 四组**全要**。这里曾经只取 BUDGET + LANG（12 个），于是 R28 的 `silentFailureGuard`
// 与 R30 的三个提问接管字段从未进过这一段的变异面——变的是"判据少看四个字段"，
// 而它照样全绿。键集的单一来源是 `lib/config.js`，别在这里另立一份。
const KEYS = [...BUDGET_FIELD_KEYS, ...LANG_FIELD_KEYS, ...FLAG_FIELD_KEYS, ...ASK_FIELD_KEYS];
const MS_KEYS = [...MS_FIELD_KEYS];
const goodForm = {
  count: KEYS.length,
  keys: [...KEYS],
  writable: KEYS.map(() => true),
  readouts: MS_KEYS.map(() => '生效：1 s'),
  readoutFields: [...MS_KEYS],
  failed: false
};

mutation(`M6 基线：${String(KEYS.length)} 字段（身份一致）+ 全部可写 + 读数长在 ${String(MS_KEYS.length)} 个毫秒字段上必须判成立`, false,
  () => judgeConfigForm(goodForm, KEYS, MS_KEYS));
mutation(`M7 少一个字段（${String(KEYS.length - 1)} 个）必须判不成立`, true, () => judgeConfigForm({ ...goodForm, count: KEYS.length - 1 }, KEYS, MS_KEYS));
mutation('M8 秒数读数缺失必须判不成立', true, () => judgeConfigForm({ ...goodForm, readouts: [] }, KEYS, MS_KEYS));
mutation('M9 页脚出现失败文案必须判不成立', true,
  () => judgeConfigForm({ ...goodForm, failed: true }, KEYS, MS_KEYS));
mutation('M10 字段数够但身份不对（某个键缺席、另一个键顶替）必须判不成立', true,
  () => judgeConfigForm({ ...goodForm, keys: [...KEYS.slice(0, KEYS.length - 1), 'defaultYieldSeconds'] }, KEYS, MS_KEYS));
mutation('M11 字段都在、但有一项不可写（disabled）必须判不成立', true,
  () => judgeConfigForm({ ...goodForm, writable: KEYS.map((_, i) => i !== 3) }, KEYS, MS_KEYS));
mutation('M12 代码侧新增字段而页面没跟上（期望多一个键）必须判不成立', true,
  () => judgeConfigForm(goodForm, [...KEYS, 'newBudgetMs'], MS_KEYS));
// 读数**身份**（impl-review-r23 N3）：数量对但挂在错的字段上，旧判据（只数个数）会放过去。
mutation('M25 读数数量对、但有一个挂在非毫秒字段上（读数身份错位）必须判不成立', true,
  () => judgeConfigForm({ ...goodForm, readoutFields: [...MS_KEYS.slice(0, MS_KEYS.length - 1), 'jobKind'] }, KEYS, MS_KEYS));
mutation(`M26 少一个毫秒字段的读数（${String(MS_KEYS.length - 1)} 个）必须判不成立`, true,
  () => judgeConfigForm({ ...goodForm, readoutFields: MS_KEYS.slice(0, MS_KEYS.length - 1) }, KEYS, MS_KEYS));

// ── 第二段后半：放置读数（设置必须在插件页上、在组件行之前） ───────────────
const goodPlacement = {
  pageKind: 'bundle',
  sectionPresent: true,
  fieldCount: KEYS.length,
  rowsAfterSection: true,
  rowConfigureControls: 0
};

mutation('M13 基线：设置区在插件页、字段齐、组件行在后必须判成立', false,
  () => judgePlacement(goodPlacement, KEYS));
mutation('M14 落在组件行子页（pageKind=row）必须判不成立', true,
  () => judgePlacement({ ...goodPlacement, pageKind: 'row' }, KEYS));
mutation('M15 插件页上没有设置区（退回组件行槽的形态）必须判不成立', true,
  () => judgePlacement({ ...goodPlacement, sectionPresent: false, fieldCount: 0 }, KEYS));
mutation('M16 设置区排在组件行之后（位置不对）必须判不成立', true,
  () => judgePlacement({ ...goodPlacement, rowsAfterSection: false }, KEYS));
mutation('M17 组件行里还留着 configure 控件（两个入口/没迁干净）必须判不成立', true,
  () => judgePlacement({ ...goodPlacement, rowConfigureControls: 1 }, KEYS));
mutation('M18 字段数不足（少渲染一项）必须判不成立', true,
  () => judgePlacement({ ...goodPlacement, fieldCount: KEYS.length - 1 }, KEYS));

// ── 第三段：保存往返的落盘读数（R27 语义：字段回填生效值 + 落盘命中；成功不弹文案）──
const patch = '- id: async-tools-host\n  name: dsh-async-tools\n  config:\n    pollIntervalMs: 4321\n';

mutation('M19 基线：字段回填生效值且落盘命中必须判成立', false,
  () => judgeRoundTrip('4321', false, patch, 'pollIntervalMs', '4321'));
mutation('M20 字段没回到生效值（写入没被接受/草稿没清）必须判不成立', true,
  () => judgeRoundTrip('500', false, patch, 'pollIntervalMs', '4321'));
mutation('M21 页脚出现失败文案（哪怕落盘有覆盖）必须判不成立', true,
  () => judgeRoundTrip('4321', true, patch, 'pollIntervalMs', '4321'));
mutation('M21b 落盘没有该覆盖（页面看着回了值、盘上没有）必须判不成立', true,
  () => judgeRoundTrip('4321', false, '- id: async-tools-host\n', 'pollIntervalMs', '4321'));

// ── 第四段：两段读数各自跟着变（R27 增补：生效段随保存、输入段随键入——判据 10）──
// 段形状（2026-09-26 用户裁定后）= `<标签>：<秒文本>`，秒文本三种形状（N s / < 0.01 s / —）。
const seg = (label, seconds) => `${label}：${seconds}`;
mutation('M22 基线：保存后生效段换新值换算、输入段等于当前草稿换算必须判成立', false,
  () => judgeReadoutFollows(
    { effective: seg('生效', '0.5 s'), input: seg('输入', '4.32 s') },
    { effective: seg('生效', '4.32 s'), input: seg('输入', '4.32 s') },
    { effective: seg('生效', '4.32 s'), input: seg('输入', '4.32 s') }));
mutation('M23 生效段停在旧值（卡片没订阅控制器 ⇒ 快照换新后不重渲染）必须判不成立', true,
  () => judgeReadoutFollows(
    { effective: seg('生效', '0.5 s'), input: seg('输入', '4.32 s') },
    { effective: seg('生效', '0.5 s'), input: seg('输入', '4.32 s') },
    { effective: seg('生效', '4.32 s'), input: seg('输入', '4.32 s') }));
mutation('M24 生效段变了但换算不对（写死/算错）必须判不成立', true,
  () => judgeReadoutFollows(
    { effective: seg('生效', '0.5 s'), input: seg('输入', '4.32 s') },
    { effective: seg('生效', '4 s'), input: seg('输入', '4.32 s') },
    { effective: seg('生效', '4.32 s'), input: seg('输入', '4.32 s') }));
mutation('M27 输入段接了生效值（不跟当前草稿——判据 10 的核心退化，§29.4 ⑧ 的镜像）必须判不成立', true,
  () => judgeReadoutFollows(
    { effective: seg('生效', '0.5 s'), input: seg('输入', '4.32 s') },
    { effective: seg('生效', '4.32 s'), input: seg('输入', '4.32 s') },
    { effective: seg('生效', '4.32 s'), input: seg('输入', '0.6 s') }));
mutation('M28 键入个位数（4）：输入段必须按亚 10 ms 形状命中（< 0.01 s，不得 0 s）必须判成立', false,
  () => judgeReadoutFollows(
    { effective: seg('生效', '0.5 s'), input: seg('输入', '0.5 s') },
    { effective: seg('生效', '0.5 s'), input: seg('输入', '< 0.01 s') },
    { effective: seg('生效', '0.5 s'), input: seg('输入', '< 0.01 s') }));
mutation('M28b 键入 4 却显示 0 s（正数读成零——R27 增补禁的形状）必须判不成立', true,
  () => judgeReadoutFollows(
    { effective: seg('生效', '0.5 s'), input: seg('输入', '0.5 s') },
    { effective: seg('生效', '0.5 s'), input: seg('输入', '0 s') },
    { effective: seg('生效', '0.5 s'), input: seg('输入', '< 0.01 s') }));

const uncaught = results.filter((ok) => !ok).length;
console.log(`\n${uncaught === 0 ? `全部变异都被抓住（${String(results.length)}/${String(results.length)}）` : `${String(uncaught)} 处没被抓住`}`);
process.exitCode = uncaught === 0 ? 0 : 1;
