/** 索引反例使用独占合成树，避免改写正在维护的文档。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { checkMutateIndex } from '../tools/check-mutate-index.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'mutate-index-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['verify', 'test']) cpSync(join(ROOT, dir), join(root, dir), { recursive: true });
  const target = join(root, 'verify/README.md');
  const text = readFileSync(target, 'utf8');
  const row = text.split('\n').find(line => /^\|\s*`?verify\/mutate-agent\.mjs`?\s*\|/.test(line));
  assert.ok(row, '基线必须包含后台派生变异索引');
  return { root, target, text, row, run: () => checkMutateIndex(root, { quiet: true }) };
}
test('变异索引：正常真实基线', () => {
  const result = checkMutateIndex(ROOT, { quiet: true });
  assert.equal(result.code, 0, result.out);
  assert.ok(result.onDiskCount >= 2);
});
for (const [name, mutate] of [
  ['幽灵脚本', box => writeFileSync(box.target, box.text.replace(box.row, `${box.row}\n| verify/mutate-ghost.mjs | test/agent.test.mjs | 合成反例 |`))],
  ['漏登', box => writeFileSync(box.target, box.text.replace(box.row, ''))],
  ['幽灵测试', box => writeFileSync(box.target, box.text.replace(box.row, box.row.replace('test/agent.test.mjs', 'test/ghost.test.mjs')))],
  ['格式错误', box => writeFileSync(box.target, box.text.replace(box.row, box.row.replace('test/agent.test.mjs', 'agent')))],
  ['重复登记', box => writeFileSync(box.target, box.text.replace(box.row, `${box.row}\n${box.row}`))],
  ['存在但错指测试', box => writeFileSync(box.target, box.text.replace(box.row, box.row.replace('test/agent.test.mjs', 'test/wait-job.test.mjs')))],
  ['索引之外的表不能补漏登', box => writeFileSync(box.target, `${box.text.replace(box.row, '')}\n## 其他说明\n${box.row}\n`)]
]) test(`变异索引反例：${name}`, t => {
  const box = sandbox(t);
  assert.equal(box.run().code, 0, '反例前基线必须通过');
  mutate(box);
  const result = box.run();
  assert.equal(result.code, 1, result.out);
});
