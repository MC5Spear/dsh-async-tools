/**
 * 验证：**校验只有一套判据**。
 *
 * 防的缺陷形态：`Config` 的数值字段若没有下界约束，则
 * - 设置页放行 `-1` / `0` / 空串；
 * - 运行时 `resolveConfig` 才抛错，而那个错误被读取侧吞掉（`lib/settings.js` 的 catch），
 *   表现为"设置保存成功但工具行为没变"。
 *
 * 判据：**非法值必须在 schema 这一层被拒**（`Config` 就是设置页用的 schema），
 * 合法值必须通过。根形态是 `settings` 子树（设计 §5.1）：字段校验住进子树
 * 字段对象，跨字段不等式住进子树的 transform 回调（回调三形——武装态写入
 * 拒绝与运行中重载拦截；降级态仅放行与降级基线深度相等的重存；判据与
 * `assertCrossFieldOrder` 同源，探针对账）。
 *
 * 用法：node --import ./tools/_host-hooks.mjs tools/probe-config-validation.mjs
 */
import {
  Config, resolveConfig, assertCrossFieldOrder,
  setConfigValidationArmed, setConfigValidationDegraded,
  isConfigValidationArmed, resolveSettingsValue
} from '../lib/config.js';

const checks = [];
const record = (label, passed, detail) => {
  checks.push({ label, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`);
};

/** schema 是否拒绝这份输入（抛错即拒绝）。 */
function schemaRejects(patch) {
  try {
    Config({ ...patch });
    return false;
  } catch {
    return true;
  }
}

console.log('=== 非法值必须被 schema 拒绝（这就是设置页用的那份 schema）===');
const illegal = [
  ['jobKind 空串', { settings: { jobKind: '' } }],
  ['maxResultChars = 0', { settings: { maxResultChars: 0 } }],
  ['maxResultChars = -5', { settings: { maxResultChars: -5 } }],
  ['pollIntervalMs = -1', { settings: { pollIntervalMs: -1 } }],
  ['minYieldMs = 0', { settings: { minYieldMs: 0 } }],
  ['maxWaitMs = -1', { settings: { maxWaitMs: -1 } }],
  ['defaultWaitMs = 0', { settings: { defaultWaitMs: 0 } }],
  ['toolName 不在枚举里', { toolName: 'nope' }],
  ['uiLang 枚举外', { settings: { uiLang: 'fr' } }]
];
for (const [label, patch] of illegal) {
  record(label, schemaRejects(patch));
}

console.log('');
console.log('=== 合法值必须通过（别把正常路径一起挡掉）===');
const legal = [
  ['只给 toolName', { toolName: 'async_run' }],
  ['正常区间', { settings: { minWaitMs: 250, maxWaitMs: 600000 } }],
  ['极小但合法', { settings: { maxResultChars: 1, pollIntervalMs: 1 } }],
  ['空对象（全用默认值）', {}]
];
for (const [label, patch] of legal) {
  record(label, schemaRejects(patch) === false);
}

console.log('');
console.log('=== 跨字段不等式（武装态：transform 回调在 schema 层拒绝；判据与运行侧对账）===');
// 判据单一事实源在 lib/config.js（武装回调与 assertCrossFieldOrder 同源展开自
// ORDERED_PAIRS + DEFAULT_WITHIN_RANGE）；探针直测活路径：两侧用同一组非法值。
setConfigValidationArmed(true);
const crossIllegal = [
  ['minWaitMs > maxWaitMs', { minYieldMs: 1, maxYieldMs: 10, minWaitMs: 500, maxWaitMs: 100, defaultYieldMs: 5 }],
  ['defaultYieldMs 超出区间', { minYieldMs: 1, maxYieldMs: 10, minWaitMs: 1, maxWaitMs: 10, defaultYieldMs: 99 }],
  // `defaultWaitMs` 的同类约束不可漏查：漏了它，
  // `defaultWaitMs: 999999` 会被设置页放行、存盘，然后在某次 async_wait 调用里被夹紧，
  // 使用者看到的是"我设了但没效果"。
  ['defaultWaitMs 超出区间', { minYieldMs: 1, maxYieldMs: 10, minWaitMs: 1, maxWaitMs: 10, defaultYieldMs: 5, defaultWaitMs: 99 }],
  ['pollIntervalMs > maxWaitMs', { minYieldMs: 1, maxYieldMs: 10, minWaitMs: 1, maxWaitMs: 10, defaultYieldMs: 5, pollIntervalMs: 999 }]
];
for (const [label, value] of crossIllegal) {
  const schemaRejected = schemaRejects({ settings: { ...value } });
  let runtimeRejected = false;
  try { assertCrossFieldOrder(value); } catch { runtimeRejected = true; }
  record(`${label}（schema 与运行侧同判）`, schemaRejected && runtimeRejected,
    `schema=${schemaRejected}; runtime=${runtimeRejected}`);
}
record('拒绝原因可读（双侧字段名齐备）', (() => {
  try {
    Config({ settings: { defaultWaitMs: 1 } });
    return false;
  } catch (error) {
    return /cross-field violation/.test(error.message)
      && error.message.includes('defaultWaitMs=1')
      && error.message.includes('minWaitMs=250')
      && error.message.includes('maxWaitMs=600000');
  }
})());

console.log('');
console.log('=== 初始态对照（启动容错：同款非法值放行，运行侧第二道防线仍拒）===');
setConfigValidationArmed(false);
record('初始态放行非法值（settings 为 Ref）', (() => {
  const tolerated = Config({ settings: { defaultWaitMs: 1 } });
  return typeof tolerated?.settings?.get === 'function' && tolerated.settings.get().defaultWaitMs === 1;
})());
record('初始态下 resolveConfig 运行侧仍拒', (() => {
  try { resolveConfig({ settings: { defaultWaitMs: 1 } }); return false; } catch { return true; }
})());
setConfigValidationArmed(true);
record('武装开关状态位可读', isConfigValidationArmed() === true);

console.log('');
console.log('=== 降级基线（回调三形：基线等值放行，不同非法拒绝，不同合法放行）===');
const baseline = resolveSettingsValue({ settings: { defaultWaitMs: 1 } });
setConfigValidationDegraded(baseline);
record('降级态：基线等值再解析放行（行不死、修复入口在）', (() => {
  const tolerated = Config({ settings: { defaultWaitMs: 1 } });
  return typeof tolerated?.settings?.get === 'function' && tolerated.settings.get().defaultWaitMs === 1;
})());
record('降级态：与基线不同的非法值拒绝', (() => {
  try { Config({ settings: { defaultWaitMs: 2 } }); return false; } catch (e) { return /cross-field violation: defaultWaitMs=2/.test(e.message); }
})());
record('降级态：不同合法值放行（修复通道）', (() => {
  const fixed = Config({ settings: { defaultWaitMs: 30000 } });
  return typeof fixed?.settings?.get === 'function' && fixed.settings.get().defaultWaitMs === 30000;
})());
record('降级记作未武装', isConfigValidationArmed() === false);
setConfigValidationArmed(true);
record('合法修复后清基线再武装（原样重存不再放行）', (() => {
  try { Config({ settings: { defaultWaitMs: 1 } }); return false; } catch (e) { return /cross-field violation: defaultWaitMs=1/.test(e.message); }
})());
setConfigValidationArmed(false);

console.log('');
console.log('=== 默认值自身必须合法（否则装载就炸）===');
record('空配置能解析出完整默认值', (() => {
  try {
    const resolved = resolveConfig({ toolName: 'async_run' });
    return resolved.minWaitMs > 0 && resolved.maxWaitMs >= resolved.minWaitMs && resolved.jobKind.length > 0;
  } catch { return false; }
})());

console.log('');
const failed = checks.filter((check) => !check.passed);
console.log(`=== 总判定：${String(checks.length - failed.length)}/${String(checks.length)} 通过 ===`);
process.exit(failed.length === 0 ? 0 : 1);
