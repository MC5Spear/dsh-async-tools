/** 使用合成树核查索引双向一致性，避免覆盖维护者的未提交正文。 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMutateIndex } from '../tools/check-mutate-index.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'mutate-index-proof-'));
try {
  for (const dir of ['verify', 'test']) cpSync(join(ROOT, dir), join(root, dir), { recursive: true });
  const target = join(root, 'verify/README.md');
  const original = readFileSync(target, 'utf8');
  const row = original.split('\n').find(line => /^\|\s*`?verify\/mutate-[\w-]+\.mjs`?\s*\|/.test(line));
  if (!row) throw new Error('实现变异索引缺少有效表行');
  const baseline = checkMutateIndex(root, { quiet: true });
  if (!baseline.ok) throw new Error(`基线未通过：${baseline.out}`);
  console.log('BASELINE  实现变异索引正常');
  const mutations = [
    ['幽灵脚本', original.replace(row, `${row}\n| verify/mutate-ghost.mjs | test/agent.test.mjs | 合成反例 |`)],
    ['漏登', original.replace(row, '')],
    ['幽灵测试', original.replace(row, row.replace(/test\/[^`| ]+\.test\.mjs/, 'test/ghost.test.mjs'))],
    ['格式错误', original.replace(row, row.replace(/test\/[^`| ]+\.test\.mjs/, 'invalid'))],
    ['重复登记', original.replace(row, `${row}\n${row}`)]
  ];
  let ok = true;
  for (const [name, text] of mutations) {
    writeFileSync(target, text, 'utf8');
    const caught = !checkMutateIndex(root, { quiet: true }).ok;
    console.log(`${caught ? 'CAUGHT' : 'MISSED'}  ${name}`);
    ok = caught && ok;
  }
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
