/**
 * 把"变异索引与现实一致"这条判据挂进 `npm test`。
 *
 * ## 为什么要有这个文件（而不是光留着 `tools/check-mutate-index.mjs`）
 *
 * 那个检查器挡的是 **README 那张变异表漂移**——它真的漂移过：列了三个当时已经删掉的
 * 脚本，接手的人按图索骥全落空（独立实现审查的 N3）。
 *
 * 但一个**没人跑**的检查器等于没写（本项目纪律第 11 条：静态检查器名单漏一项就是假绿）。
 * 所以这里把它挂进单测：`npm test` 会执行它，表一漂移就红。
 *
 * 判据是**退出码**，不是"输出里有 OK"——检查器把问题写在 stdout 里并 `exit 1`，
 * 只看文字会漏掉。这是本项目踩过的形态："输出看起来在报问题，退出码却说是好的"。
 *
 * ## 进程内调用（§26.4）
 *
 * 原来用 `execFileSync` 起子进程跑检查器——沙箱下 spawn EPERM，`error.status ?? 1`
 * 兜成退出 1、输出为空，整条测试变成**假红**。检查器因此改成了可导入函数
 * （`checkMutateIndex(root)`），这里直接调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('变异索引：README 的"变异脚本 ↔ 测试文件"表必须与盘上的文件一致', async () => {
  const { checkMutateIndex } = await import('../tools/check-mutate-index.mjs');
  const { code, out, onDiskCount } = checkMutateIndex(ROOT, { quiet: true });
  assert.equal(code, 0, `检查器报了不一致（退出码 ${String(code)}）：\n${out.trim()}`);
  // 正面断言：它确实**扫到了东西**。只断言退出码的话，一个"什么都没扫"的实现也全绿——
  // 那是本项目点名过的**空转检查器**形态。
  assert.ok(onDiskCount >= 2, `扫到的变异脚本数应 ≥ 2，实得 ${String(onDiskCount)}`);
});
