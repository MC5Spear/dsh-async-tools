/**
 * 验证 P1-3：**校验只有一套判据**。
 *
 * 缺陷形态（实现审查 R5）：`Config` 的数值字段没有下界约束，于是
 * - 设置页放行 `-1` / `0` / 空串；
 * - 运行时 `resolveConfig` 才抛错，而那个错误被读取侧吞掉（`lib/settings.js` 的 catch），
 *   表现为"设置保存成功但工具行为没变"。
 *
 * 判据：**非法值必须在 schema 这一层被拒**（`Config` 就是设置页用的 schema），
 * 合法值必须通过。
 *
 * 用法：node --import ./tools/_host-hooks.mjs tools/probe-config-validation.mjs
 */
import { Config, resolveConfig } from '../lib/config.js';

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
  ['jobKind 空串', { jobKind: '' }],
  ['maxResultChars = 0', { maxResultChars: 0 }],
  ['maxResultChars = -5', { maxResultChars: -5 }],
  ['pollIntervalMs = -1', { pollIntervalMs: -1 }],
  ['minYieldMs = 0', { minYieldMs: 0 }],
  ['maxWaitMs = -1', { maxWaitMs: -1 }],
  ['defaultWaitMs = 0', { defaultWaitMs: 0 }],
  ['toolName 不在枚举里', { toolName: 'nope' }]
];
for (const [label, patch] of illegal) {
  record(label, schemaRejects(patch));
}

console.log('');
console.log('=== 合法值必须通过（别把正常路径一起挡掉）===');
const legal = [
  ['只给 toolName', { toolName: 'async_run' }],
  ['正常区间', { minWaitMs: 250, maxWaitMs: 600000 }],
  ['极小但合法', { maxResultChars: 1, pollIntervalMs: 1 }],
  ['空对象（全用默认值）', {}]
];
for (const [label, patch] of legal) {
  record(label, schemaRejects(patch) === false);
}

console.log('');
console.log('=== 跨字段约束（schema 表达不了，由 resolveConfig 的判据兜）===');
// r19-N5：判据已收敛进 lib/config.js（assertCrossFieldOrder，单一事实源），
// 探针直测活路径的导出面。
const { assertCrossFieldOrder } = await import('../lib/config.js');
const crossIllegal = [
  ['minWaitMs > maxWaitMs', { minYieldMs: 1, maxYieldMs: 10, minWaitMs: 500, maxWaitMs: 100, defaultYieldMs: 5 }],
  ['defaultYieldMs 超出区间', { minYieldMs: 1, maxYieldMs: 10, minWaitMs: 1, maxWaitMs: 10, defaultYieldMs: 99 }],
  // `defaultWaitMs` 的同类约束曾漏查（实现审查 R6 的 P1-3 残余）：漏了它，
  // `defaultWaitMs: 999999` 会被设置页放行、存盘，然后在某次 async_wait_job 调用里被夹紧，
  // 使用者看到的是"我设了但没效果"。
  ['defaultWaitMs 超出区间', { minYieldMs: 1, maxYieldMs: 10, minWaitMs: 1, maxWaitMs: 10, defaultYieldMs: 5, defaultWaitMs: 99 }]
];
for (const [label, value] of crossIllegal) {
  let rejected = false;
  try { assertCrossFieldOrder(value); } catch { rejected = true; }
  record(label, rejected);
}

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
