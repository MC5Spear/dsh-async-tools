/**
 * 静态判据：**带 BOM 的 PowerShell 脚本必须保住 BOM**。
 *
 * ## 为什么（现行因果）
 *
 * Windows PowerShell 5.1 对无 BOM 的文件按 ANSI(CP936) 解码，多字节序列会把
 * 引号吃掉——`Parser::ParseFile` 从 0 个错误变成几十个，且首条错误报在与
 * 真正改动相距很远的行上，完全看不出因果。
 *
 * ## 判据
 *
 * 对每个 `.ps1`：如果它在 **git HEAD 里带 BOM**，那么工作区版本也必须带 BOM。
 * （反向不查：无 BOM 的文件不强制加——那是另一个决定，见 `check-ps1-syntax.mjs` 的提示。）
 *
 * 没有 git 可比时（新文件），只报告状态、不判定。
 *
 * 用法：node verify/check-ps1-bom.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERIFY = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(VERIFY);
const SKIP_DIRS = new Set(['_tmp', '_scratch', '_lab', 'backup', 'node_modules', 'shots', 'logs']);
// 按前缀判过程产物目录：改名成 `_scratch_REMOVED_*` 后精确相等会失效。
const isSkippedDir = (name) => SKIP_DIRS.has(name) || name.startsWith('_scratch');

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isSkippedDir(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ps1|psm1)$/.test(entry.name)) out.push(full);
  }
  return out;
};

/** 读文件头三个字节判断 BOM。 */
const hasBom = (bytes) => bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;

/**
 * 取 git HEAD 里同一个文件的字节，判断它是否带 BOM。
 *
 * @param {string} relPath - 相对仓库根、用正斜杠分隔的路径。
 * @returns {boolean|null} 带 BOM 返回 true；不带返回 false；不在 HEAD 里返回 null。
 */
function headHasBom(relPath) {
  try {
    const out = execFileSync('git', ['show', `HEAD:${relPath}`], { cwd: REPO, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
    return hasBom(out);
  } catch {
    return null;
  }
}

const problems = [];
let scanned = 0;
let checked = 0;
let withBom = 0;
let withoutBom = 0;

for (const file of walk(VERIFY)) {
  if (!statSync(file).isFile()) continue;
  scanned += 1;
  const rel = relative(REPO, file).replace(/\\/g, '/');
  const nowBom = hasBom(readFileSync(file));
  if (nowBom) withBom += 1; else withoutBom += 1;

  const headBom = headHasBom(rel);
  if (headBom === null) continue; // 新文件：不判定
  checked += 1;
  if (headBom && !nowBom) {
    problems.push(
      `${rel}  **丢了 BOM** —— HEAD 里有、工作区没有。`
      + `PS 5.1 会把无 BOM 的 UTF-8 按 ANSI(CP936) 读，中文乱码后语法崩`
      + `（实测：ParseFile 从 0 个错误变成几十个，且首错报在几百行之外）。`
    );
  }
}

console.log(`扫了 ${String(scanned)} 个 PowerShell 脚本：带 BOM ${String(withBom)} 个、无 BOM ${String(withoutBom)} 个。`);
console.log(`其中 ${String(checked)} 个在 git HEAD 里有对应版本，逐个核对了 BOM 是否保住。`);
// headHasBom 全部返回 null 时打一行警示：区分「真都是新文件」与「git 输出读不到」。
if (scanned > 0 && checked === 0) {
  let gitWorks = false;
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, stdio: ['ignore', 'ignore', 'ignore'] });
    gitWorks = true;
  } catch { /* git 不可用或当前目录不在仓库里 */ }
  console.log(gitWorks
    ? '警示：所有脚本都不在 git HEAD 里（新文件），只报告状态、不判定。'
    : '警示：git 输出读不到（git 不可用或不在仓库里），无法与 HEAD 比对，本检查退化为只报告状态。');
}
console.log('');

if (problems.length === 0) {
  console.log('没有"HEAD 里有 BOM、工作区丢了"的情况。');
  process.exit(0);
}
for (const problem of problems) console.log(`FAIL  ${problem}`);
process.exit(1);
