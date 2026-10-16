/**
 * 别名变量检查：`client.js` 里每个 `var(--dsw-alias-*)` 引用都必须落在
 * **定义表**内。
 *
 * ## 定义权威与取数方式
 *
 * 定义表不是抄进仓库的一份名单——那是会漂的第二份。
 * 本脚本每次运行都从 theme 包的运行时源**现场枚举**定义名（`dsh-client-ui-theme`
 * 运行时注入的名字全集；`--dsw-alias-label-error` / `-danger` / `-success` 都不在表里，
 * 官方 `.failed` 引用未定义的 `label-error` 落继承色是官方现行行为，本包不复制它的颜色
 * 引用）。
 *
 * 锚点目录解析与 `tools/_host-resolve.mjs` 同一套三候选链（`DSAT_HOST_MODULES`
 * 覆盖 → `DSH_HOME/profiles` → `%APPDATA%/npm`；表在别处展开，此处不重复抄）。
 * 找不到 theme 源时退出 2（宁可失败，不放假绿）。
 *
 * 用法：node tools/check-alias-tokens.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateModules } from './_host-resolve.mjs';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * theme 包运行时源的候选锚点目录（统一走 `_host-resolve.candidateModules`
 * ——`DSAT_HOST_MODULES` 覆盖 → `DSH_HOME/profiles` → `%APPDATA%/npm` 全局树，
 * 不写死本机路径）。
 */
const THEME_CANDIDATES = candidateModules(process.env.DSH_HOME ?? join(homedir(), '.dsh'));

/**
 * 枚举定义表。
 *
 * @returns {{dir: string, names: string[]}} 锚点目录与去重排序后的定义名。
 * @throws 找不到可读的 theme 源时抛错（调用方转退出码 2）。
 */
function definedNames() {
  for (const dir of THEME_CANDIDATES) {
    const themeClient = join(dir, '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js');
    if (!existsSync(themeClient)) continue;
    const text = readFileSync(themeClient, 'utf8');
    const names = [...new Set([...text.matchAll(/--dsw-alias-([a-z0-9-]+)\s*:/g)]
      .map((match) => match[1]))].sort();
    if (names.length === 0) continue;
    return { dir, names };
  }
  throw new Error('找不到可读的 dsh-client-ui-theme 运行时源（候选：'
    + THEME_CANDIDATES.join('；') + '）——定义表不可枚举，本检查器拒绝放行');
}

const { dir, names } = (() => {
  // 枚举失败 = 定义表不可判 → 本检查器**拒绝放行**（退出 2，
  // 与"检查完、有违规"的退出 1 区分）；报错里带上环境指引，而不是裸抛栈。
  try {
    return definedNames();
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    console.error('设 DSAT_HOST_MODULES 指向 0.2.0 线运行树的 node_modules（含 @deepseek-ai）后重试；机器路径不写进本文件。');
    process.exit(2);
  }
})();
const defined = new Set(names);

const files = ['client.js'];
const problems = [];
let references = 0;
for (const file of files) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  for (const match of text.matchAll(/var\(--dsw-alias-([a-z0-9-]+)\)/g)) {
    references += 1;
    if (!defined.has(match[1])) {
      problems.push(`${file}: var(--dsw-alias-${match[1]}) —— 不在定义表内（未定义的名字，计算值阶段失效、落继承色）`);
    }
  }
}

console.log(`定义表：${String(names.length)} 个名字，枚举自 ${join(dir, '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js')}`);
console.log(`引用：${String(references)} 处 var(--dsw-alias-*)（${files.join('、')}）`);
if (problems.length > 0) {
  for (const problem of problems) console.log(`BAD   ${problem}`);
  console.log(`\n${String(problems.length)} 处引用未定义。`);
  process.exit(1);
}
console.log('别名变量检查通过（全部引用都在定义表内）。');
