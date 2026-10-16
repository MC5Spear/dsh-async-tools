/**
 * 语法检查：对 `lib/`、`test/`、`tools/` 下的每个源文件做一次语法解析，失败即非零退出。
 *
 * 用法：`node tools/check-syntax.mjs`（`npm run check`）。
 *
 * 为什么用 `node --check` 而不是 `import()`：
 * - `import()` 会**执行**模块——`test/*.test.mjs` 里的 `test()` 会真的注册并跑用例，
 *   等于把整套测试在检查脚本里再跑一遍，慢且副作用重叠；
 * - `node --check` 只解析、不执行，正是"语法解析"这件事本身。
 *
 * 它**不检查**导入能否解析（那是 `npm test` 与验收脚本的职责）：本脚本必须在
 * 没有宿主 `node_modules` 的机器上也能跑，而 `lib/*.js` 依赖 `@deepseek-ai/*`。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

/** 包根目录。 */
const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 需要检查的目录与扩展名。 */
const TARGETS = [
  ['lib', '.js'],
  ['test', '.mjs'],
  ['tools', '.mjs']
];

/**
 * 额外单文件。浏览器半边（设置卡片）住在包根的 `client.js`，
 * 不在 `lib/`/`test/`/`tools/` 任何一个目录下——漏检等于"这个文件从没被解析过"。
 * 保留这个机制：将来再加非这三个目录的交付文件时往这里补。
 */
const EXTRA_FILES = ['client.js'];

/**
 * CommonJS 文件：`node --check` 默认按 `.js` + 最近的 package.json（`"type": "module"`）
 * 当成 ESM 解析，而浏览器半边是 CJS 包裹（`window.__ModuleLoader__.load({factory: (require) => ...})`）。
 * 必须显式按 CJS 解析，否则它会被误报成语法错误。
 */
const CJS_FILES = new Set(['client.js']);

/**
 * 列出一个目录下所有匹配扩展名的文件（含子目录），返回相对包根的路径。
 * @param {string} dir - 目录名。
 * @param {string} extension - 扩展名。
 * @returns {string[]} 相对路径（`/` 分隔，便于打印与跨平台比较）。
 */
function collect(dir, extension) {
  return readdirSync(join(ROOT, dir), { recursive: true })
    .map((entry) => join(dir, String(entry)))
    .filter((path) => path.endsWith(extension))
    .map((path) => relative(ROOT, join(ROOT, path)).replaceAll('\\', '/'));
}

const files = [
  ...TARGETS.flatMap(([dir, extension]) => collect(dir, extension)),
  ...EXTRA_FILES
].sort();
const failures = [];

for (const file of files) {
  if (CJS_FILES.has(file)) {
    // client.js 为何不能走 `node --check`（按 ESM 误判、且不接受 `--input-type`）：见 CJS_FILES 的 JSDoc。
    try {
      // eslint-disable-next-line no-new-func -- 只解析，不调用。
      new Function(readFileSync(join(ROOT, file), 'utf8'));
      console.log(`OK    ${file}（CJS 解析）`);
    } catch (error) {
      failures.push({ file, output: error instanceof Error ? error.message : String(error) });
    }
    continue;
  }
  const result = spawnSync(process.execPath, ['--check', join(ROOT, file)], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures.push({ file, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() });
    continue;
  }
  console.log(`OK    ${file}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 个文件语法检查失败：`);
  for (const failure of failures) console.error(`\n--- ${failure.file} ---\n${failure.output}`);
  process.exitCode = 1;
} else {
  console.log(`\n${files.length} 个文件语法检查通过。`);
}
