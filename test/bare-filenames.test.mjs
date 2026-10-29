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
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('文档路径：现行文档里的裸文件名引用必须能在盘上找到同名文件', async () => {
  const { checkBareFilenames } = await import('../tools/check-bare-filenames.mjs');
  const { code, out, scanned } = checkBareFilenames(ROOT, { quiet: true });
  assert.equal(code, 0, `检查器报了悬空的光文件名（退出码 ${String(code)}）：\n${out.trim()}`);
  assert.ok(scanned !== null && scanned >= 30,
    `扫到的光文件名引用应 ≥ 30（已登记文档里有大量这种写法），实得 ${String(scanned)}——这个下界挡的是"提取规则被改坏"`);
});

for (const rel of ['README.en.md', 'docs/user-reference.md', 'docs/user-reference.en.md', 'docs/documentation-principles.md']) {
  test(`裸文件名：新增输入 ${rel} 不能漏扫`, async (t) => {
    const { checkBareFilenames } = await import('../tools/check-bare-filenames.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'bare-input-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const file of ['README.md', 'README.en.md', 'docs/requirements.md', 'docs/design.md',
      'docs/user-reference.md', 'docs/user-reference.en.md', 'docs/documentation-principles.md',
      'verify/README.md', 'CONTRIBUTING.md', 'CHANGELOG.md']) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), '', 'utf8');
    }
    writeFileSync(join(dir, rel), '`package.json`\n', 'utf8');
    writeFileSync(join(dir, 'package.json'), '{}', 'utf8');
    assert.equal(checkBareFilenames(dir, { quiet: true }).code, 0);
    writeFileSync(join(dir, rel), '`missing-user-input.mjs`\n', 'utf8');
    const dirty = checkBareFilenames(dir, { quiet: true });
    assert.equal(dirty.code, 1);
    assert.ok(dirty.out.includes(`${rel}:1 → missing-user-input.mjs`), dirty.out);
  });
}
