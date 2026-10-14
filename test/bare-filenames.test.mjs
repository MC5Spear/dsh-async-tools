/**
 * 把"裸文件名引用必须找得到"挂进 `npm test`。
 *
 * 挡的形态：文档写 `` `verify-r9-fixes.mjs` ``（**光名字**、无路径前缀），而那个文件
 * 已被删除——`tools/check-doc-paths.mjs` 只认带前缀的写法，于是这类指针**静默通过**。
 *
 * 判据是**退出码**，并且断言"它确实扫到了东西"：只断言退出码的话，一个什么都没扫到的
 * 实现也会全绿（本项目点名过的**空转检查器**形态）。
 *
 * ## 进程内调用
 *
 * 用 `execFileSync` 起子进程跑检查器在沙箱下不可行：spawn EPERM，`error.status ?? 1`
 * 兜成退出 1、输出为空，整条测试变成**假红**（与被检查的文档无关）。检查器因此
 * 是可导入函数（`checkBareFilenames(root)`），这里直接调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('文档路径：现行文档里的裸文件名引用必须能在盘上找到同名文件', async () => {
  const { checkBareFilenames } = await import('../tools/check-bare-filenames.mjs');
  const { code, out, scanned } = checkBareFilenames(ROOT, { quiet: true });
  assert.equal(code, 0, `检查器报了悬空的光文件名（退出码 ${String(code)}）：\n${out.trim()}`);
  assert.ok(scanned !== null && scanned >= 30,
    `扫到的光文件名引用应 ≥ 30（现行 5 份文档里有大量这种写法），实得 ${String(scanned)}——这个下界挡的是"提取规则被改坏"`);
});
