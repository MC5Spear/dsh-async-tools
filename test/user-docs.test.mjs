/** 在独占副本变更正文关联字段，避免正确值在别处出现造成假通过。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkUserDocs, USER_DOCUMENTS } from '../tools/check-user-docs.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'user-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['lib', 'presets', 'tools', 'test', 'verify', ...USER_DOCUMENTS, 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'docs/requirements.md', 'docs/design.md']) {
    try { mkdirSync(dirname(join(root, path)), { recursive: true }); cpSync(join(ROOT, path), join(root, path), { recursive: true }); }
    catch (error) { if (path !== 'THIRD_PARTY_NOTICES.md' || error.code !== 'ENOENT') throw error; }
  }
  return { root, run: options => checkUserDocs(root, { quiet: true, ...options }), edit(file, fn) { const path = join(root, file); writeFileSync(path, fn(readFileSync(path, 'utf8'))); } };
}
test('用户资料：本线真实基线', () => {
  const result = checkUserDocs(ROOT, { quiet: true });
  assert.equal(result.code, 0, result.out);
});
const cases = [
  ['仅英文默认值写错但其它位置保留正确值', box => box.edit('docs/user-reference.en.md', text => text.replace(/^(\|\s*`?defaultYieldMs`?\s*\|[^|]+\|)\s*`?20000`?\s*\|/m, '$1 20001 |'))],
  ['仅中文版本错误', box => box.edit('README.md', text => text.replaceAll(JSON.parse(readFileSync(join(box.root, 'package.json'))).version, '0.0.0-invalid'))],
  ['操作宿主错误但正确子串仍在插件版本', box => box.edit('docs/user-reference.en.md', text => {
    const peer = JSON.parse(readFileSync(join(box.root, 'package.json'))).peerDependencies['@deepseek-ai/dsh'];
    assert.ok(text.includes(peer));
    const changed = text.replace(/^(\| Exact dsh host version \|) [^|]+\|/m, '$1 `0.2.1-rc.9` |');
    assert.notEqual(changed, text, '必须实际改动操作身份行');
    assert.ok(changed.includes(peer), '正确宿主仍作为插件版本子串出现');
    return changed;
  })],
  ['操作插件错误而附录保留正确值', box => box.edit('docs/user-reference.en.md', text => {
    const version = JSON.parse(readFileSync(join(box.root, 'package.json'))).version;
    const changed = text.replace(/^(\| Plugin version \|) [^|]+\|/m, '$1 `0.0.0` |');
    assert.notEqual(changed, text, '必须实际改动操作身份行');
    return changed + `\nAdditional version text: ${version}\n`;
  })],
  ['重复身份表不能掩盖错误声明', box => box.edit('README.en.md', text => `${text}\n| Plugin version | \u00600.0.0\u0060 |\n`)],
  ['删除英文卸载风险', box => box.edit('docs/user-reference.en.md', text => text.replaceAll('agent-preset/not-found', 'missing-preset'))],
  ['删除语言切换', box => box.edit('README.en.md', text => text.replaceAll('](<README.md>)', '](<missing.md>)').replaceAll('](README.md)', '](missing.md)'))],
  ['首页恢复维护变异表', box => box.edit('README.md', text => `${text}\n| verify/mutate-agent.mjs | test/agent.test.mjs | 维护 |\n`)],
  ['files遗漏原则', box => box.edit('package.json', text => { const p = JSON.parse(text); p.files = p.files.filter(file => file !== 'docs/documentation-principles.md'); return JSON.stringify(p); })],
  ['新坏链接', box => box.edit('docs/user-reference.en.md', text => `${text}\n[missing](<missing.md>)\n`)],
  ['混入不存在工具', box => box.edit('docs/user-reference.en.md', text => `${text}\n### async_nonexistent\n`)],
  ['参数正文表漏必需预算行', box => box.edit('docs/user-reference.en.md', text => text.replace(/^\|\s*`wait_ms`\s*\|.*\n/gm, ''))],
  ['设置范围错写而其它行保留正确边界', box => box.edit('docs/user-reference.en.md', text => text.replace(/^(\|\s*`defaultYieldMs`\s*\|[^\n]+)$/m, row => row.replace('2147483647', '2147483646')))]
];
for (const [name, mutate] of cases) test(`用户资料有效反例：${name}`, t => {
  const box = sandbox(t);
  assert.equal(box.run().code, 0, '变异前基线通过');
  mutate(box);
  const result = box.run();
  assert.equal(result.code, 1, result.out);
});
test('用户资料：等义措辞和正常附加说明不冻结散文', t => {
  const box = sandbox(t);
  box.edit('docs/user-reference.en.md', text => text.replace('the host', 'the dsh host').replace('The host', 'The dsh host').replace('Component | Current applicable version', 'Component | Applicable release') + '\nUse a bounded wait when the result becomes necessary.\n');
  const result = box.run();
  assert.equal(result.code, 0, result.out);
});
for (const tool of ['async_wait_job', 'async_wait_agent']) {
  for (const [name, change] of [
    ['改为可选', row => { row[2] = 'Optional'; }],
    ['伪造默认值', row => { row[3] = '30000'; }],
    ['类型错误', row => { row[1] = 'boolean'; }]
  ]) test(`等待预算关联反例：${tool} ${name}`, t => {
    const box = sandbox(t);
    assert.equal(box.run().code, 0);
    box.edit('docs/user-reference.en.md', text => {
      const heading = new RegExp(`^#{2,5}\\s+(?:\\d+(?:\\.\\d+)*[.)]?\\s+)?\u0060?${tool}\u0060?\\s*$`, 'm');
      const start = text.search(heading);
      assert.ok(start >= 0);
      const section = text.slice(start).split(/\n(?=#{2,5}\s)/)[0];
      const changed = section.replace(/^\|\s*`wait_ms`\s*\|.*$/m, line => {
        const cells = line.split('|').slice(1, -1).map(value => value.trim());
        if (cells.length === 4 && /required; no default/i.test(cells[2])) {
          cells[2] = 'Required';
          cells[3] = `No default; ${cells[3]}`;
        }
        change(cells);
        return `| ${cells.join(' | ')} |`;
      });
      assert.notEqual(changed, section);
      return text.slice(0, start) + text.slice(start).replace(section, changed);
    });
    const result = box.run();
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, new RegExp(`${tool} wait_ms`));
  });
}
test('等待预算等义表述：mandatory与no default value', t => {
  const box = sandbox(t);
  box.edit('docs/user-reference.en.md', text => text.replace(/^\|\s*`wait_ms`\s*\|.*$/gm, line => {
    const cells = line.split('|').slice(1, -1).map(value => value.trim());
    cells[2] = 'Mandatory';
    cells[3] = cells.length >= 5 ? 'No default value' : 'No default value; explicit budget required';
    return `| ${cells.join(' | ')} |`;
  }));
  const result = box.run();
  assert.equal(result.code, 0, result.out);
});
test('等待预算等义四列：必填与无默认合并条件列', t => {
  const box = sandbox(t);
  box.edit('docs/user-reference.en.md', text => text.replace(/^\|\s*`wait_ms`\s*\|.*$/gm, '| `wait_ms` | number | Required; no default | Explicit budget clamped to configured limits |'));
  assert.equal(box.run().code, 0);
});
for (const [label, condition, constraint] of [['可选但无默认', 'Optional; no default', 'Explicit budget'], ['必填但有默认', 'Required', '30000']]) test(`等待预算四列反例：${label}`, t => {
  const box = sandbox(t);
  box.edit('docs/user-reference.en.md', text => text.replace(/^\|\s*`wait_ms`\s*\|.*$/gm, `| \u0060wait_ms\u0060 | number | ${condition} | ${constraint} |`));
  assert.equal(box.run().code, 1);
});
test('用户资料：分发清单漏英文参考', t => {
  const box = sandbox(t);
  const files = JSON.parse(readFileSync(join(box.root, 'package.json'))).files.filter(file => file !== 'docs/user-reference.en.md');
  assert.equal(box.run({ packageFiles: files }).code, 1);
});
