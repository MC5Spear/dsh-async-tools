/**
 * 在独占合成树中验证路径、维护命令和相对链接的失败判据。
 * M2 的命令来源是 CONTRIBUTING.md；首页不承担维护命令清单。
 * 用法：node verify/mutate-doc-paths.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkDocPaths } from '../tools/check-doc-paths.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCUMENTS = ['README.md', 'README.en.md', 'docs/requirements.md', 'docs/design.md',
  'docs/user-reference.md', 'docs/user-reference.en.md', 'docs/documentation-principles.md',
  'verify/README.md', 'CONTRIBUTING.md'];
const SCRIPT_FROM = 'npm run check:docs';
const SCRIPT_TO = 'npm run check:docs-typo-does-not-exist';
const contributing = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (!contributing.includes(SCRIPT_FROM) || manifest.scripts?.['check:docs'] === undefined) {
  throw new Error('M2 的真实维护命令不存在：先核 CONTRIBUTING.md 与 package.json，不跳过变异');
}

const root = mkdtempSync(join(tmpdir(), 'mutate-docpaths-'));
const put = (file, text) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text, 'utf8');
};
try {
  for (const file of DOCUMENTS) put(file, '# 合成文档\n');
  put('package.json', JSON.stringify({ scripts: manifest.scripts }));
  put('CONTRIBUTING.md', `# 维护\n\n${SCRIPT_FROM}\n\n[参考](<docs/user-reference.md>)\n`);
  const baseline = checkDocPaths(root, { quiet: true });
  if (baseline.code !== 0) throw new Error(`合成树基线失败：\n${baseline.out}`);
  const mutations = [
    { name: 'M1 仓内文件路径', file: 'CONTRIBUTING.md',
      text: '`verify/this-file-does-not-exist-mutation-probe.mjs`\n' },
    { name: 'M2 维护命令完整脚本名', file: 'CONTRIBUTING.md', text: SCRIPT_TO },
    { name: 'M3 按文档目录解析链接', file: 'docs/user-reference.md',
      text: '[missing](<../lib/no-such-file-mutation-probe.js>)\n' }
  ];
  let ok = true;
  for (const mutation of mutations) {
    const before = readFileSync(join(root, mutation.file), 'utf8');
    try {
      put(mutation.file, mutation.name.startsWith('M2')
        ? before.replace(SCRIPT_FROM, mutation.text) : `${before}\n${mutation.text}`);
      const result = checkDocPaths(root, { quiet: true });
      const caught = result.code !== 0 && result.out.includes(`${mutation.file} →`);
      console.log(`${caught ? 'CAUGHT' : 'MISSED'} ${mutation.name}`);
      ok = caught && ok;
    } finally {
      put(mutation.file, before);
    }
    if (checkDocPaths(root, { quiet: true }).code !== 0) throw new Error('合成树复位后基线失败');
  }
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
