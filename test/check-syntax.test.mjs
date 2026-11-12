/**
 * `tools/check-syntax.mjs` 的目录覆盖守卫（UI-PROBE-021 的可失败保护）。
 *
 * verify/（含 `_visual/` 探针）不进 `npm test` 与 `npm pack`，但会被直接执行；
 * 语法检查的 TARGETS 一旦丢掉该目录，探针语法坏掉不会红（曾在公开探针上
 * 发生、三道检查全漏）。本文件锁死 TARGETS 覆盖 verify/ 且盘上确有可扫的
 * 验证脚本；TARGETS 回退或 verify/ 清空都会让这里的断言失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TARGETS, EXTRA_FILES } from '../tools/check-syntax.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 递归数出某目录下某扩展名的文件数（目录缺席返回 0）。 */
function countFiles(dir, extension) {
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: false });
  } catch {
    return 0;
  }
  return entries.filter((entry) => String(entry).endsWith(extension)).length;
}

test('S1 check-syntax：TARGETS 必须覆盖 verify/（探针不进测试与打包，语法检查在这里覆盖探针脚本）', () => {
  const hasVerify = TARGETS.some(([dir, extension]) => dir === 'verify' && extension === '.mjs');
  assert.equal(hasVerify, true, `TARGETS 必须含 ['verify', '.mjs']，实际：${JSON.stringify(TARGETS)}`);
  // 「登记了目录」不等于「有东西可扫」——verify/ 清空时 collect 返回空集、
  // 检查器静默少一批文件，这里按盘上实际脚本数核对下界（空转检查器形态）。
  const verifyCount = countFiles('verify', '.mjs');
  assert.ok(verifyCount >= 5, `verify/ 下应有至少 5 个 .mjs 脚本（实际 ${String(verifyCount)}）——目录被清空或挪走时本守卫必须红`);
});

test('S2 check-syntax：EXTRA_FILES 必须保留包根 client.js（目录外交付文件）', () => {
  assert.ok(EXTRA_FILES.includes('client.js'), `EXTRA_FILES 必须含 client.js，实际：${JSON.stringify(EXTRA_FILES)}`);
});
