/**
 * 把"现行文档引用的本仓文件必须存在"挂进 `npm test`。
 *
 * 挡的形态：删掉验证脚本或目录之后，`README.md` / `docs/*.md` 还在指它
 * （悬空指针的实测形态）。
 *
 * 判据是**退出码**，并且额外断言"它确实扫到了东西"：只断言退出码的话，
 * 一个什么都没扫到的实现也会全绿（本项目点名过的**空转检查器**形态）。
 *
 * ## 进程内调用
 *
 * 用 `execFileSync` 起子进程跑检查器在沙箱下不可行：spawn EPERM，`error.status ?? 1`
 * 兜成退出 1、输出为空，整条测试变成**假红**。检查器因此是可导入函数
 * （`checkDocPaths(root)`），这里直接调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('文档路径：现行文档引用的本仓文件必须都在盘上', async () => {
  const { checkDocPaths } = await import('../tools/check-doc-paths.mjs');
  const { code, out, checked } = checkDocPaths(ROOT, { quiet: true });
  assert.equal(code, 0, `检查器报了悬空指针（退出码 ${String(code)}）：\n${out.trim()}`);
  // 正面断言：它必须**真的扫到了东西**，而且数量有下界。只断言退出码的话，
  // 一个"什么都没扫到"的实现也会全绿——这正是检查器自己会以失败退出的那种空转形态，
  // 但测试侧也要挡住（`checked >= 50` 的下界：宽松正则对"检查 0 处"仍为 true）。
  assert.ok(checked >= 50,
    `扫到的引用数应 ≥ 50（现行文档里有大量路径），实得 ${String(checked)}——这个下界挡的是"提取规则被改坏"`);
});

/**
 * 铺一个只含检查输入的临时沙箱：README + 它引用的真实文件 + 检查器要读的 package.json。
 *
 * 判据是双向的：badge 形态的 https URL（结尾 `.yml`）**不得**被当成绝对路径（假阳性），
 * 真正的 `X:\…` 绝对路径**必须**仍然被报（同一条正则的两个方向，改坏任一头这里就红）。
 */
test('文档路径：https URL 里的伪盘符不是绝对路径（badge 假阳性守卫），真盘符照报', async () => {
  const { checkDocPaths } = await import('../tools/check-doc-paths.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'docpaths-'));
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    mkdirSync(join(dir, 'verify'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"node --test"}}', 'utf8');
    writeFileSync(join(dir, 'docs', 'real.md'), '# 真实文件\n', 'utf8');
    // 其余现行文档铺成空壳：检查器要求它们**存在**（缺了按红处理），
    // 但不能抄真件——真件里的几百条引用在沙箱里全是悬空指针，与本测试无关。
    // CHANGELOG 不在清单里（档案零路径判据）——它的存在性既不被要求也不被消费，
    // 由下方形态 3 的反例单独锁定。
    for (const stub of ['docs/requirements.md', 'docs/design.md', 'verify/README.md',
      'CONTRIBUTING.md']) {
      writeFileSync(join(dir, ...stub.split('/')), '', 'utf8');
    }

    // 形态 1：README 顶部的 CI badge——URL 结尾 `.yml`，`https:` 的 `s:` 形似盘符。
    writeFileSync(join(dir, 'README.md'),
      '# synth\n\n'
      + '[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)]'
      + '(https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)\n\n'
      + 'See `docs/real.md`.\n', 'utf8');
    const clean = checkDocPaths(dir, { quiet: true });
    assert.equal(clean.code, 0, `badge URL 被误判成绝对路径（假阳性回来了）：\n${clean.out.trim()}`);
    assert.ok(clean.checked >= 1, '沙箱里至少要扫到那条真实引用（docs/real.md），否则判据空转');

    // 形态 2：真盘符 + 不存在的文件——同一条 ABS_RE 的另一头必须还活着。
    writeFileSync(join(dir, 'README.md'),
      '# synth\n\nSee `docs/real.md` and `D:\\no-such\\thing.yml`.\n', 'utf8');
    const dirty = checkDocPaths(dir, { quiet: true });
    assert.notEqual(dirty.code, 0, '真盘符绝对路径漏报——守卫把真阳性一起杀了');
    assert.ok(dirty.out.includes('绝对路径'), '应按"绝对路径不在本仓"口径报出');

    // 形态 3：档案零路径判据——CHANGELOG（role='archive'）不在检查清单里，
    // 它里面的悬空仓内引用**不得**被报。若有人把档案加回清单（或清单与
    // DOCUMENTS 现行子集的同集关系被改坏），这里立刻红。
    writeFileSync(join(dir, 'README.md'), '# synth\n\nSee `docs/real.md`.\n', 'utf8');
    writeFileSync(join(dir, 'CHANGELOG.md'),
      '# synth archive\n\nSee `verify/no-such-probe.mjs` and `D:\\archive\\dangling.yml`.\n', 'utf8');
    const archive = checkDocPaths(dir, { quiet: true });
    assert.equal(archive.code, 0, `档案（CHANGELOG）的引用被当成了现行文档判据（档案零路径判据破了）：\n${archive.out.trim()}`);
    assert.ok(!archive.out.includes('no-such-probe'), '档案里的悬空仓内引用不得进退出码');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
