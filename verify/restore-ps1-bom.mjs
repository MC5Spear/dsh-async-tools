/**
 * 还原工具：把 git HEAD 里带 BOM 的 `.ps1` 的 BOM 补回工作区。
 *
 * ## 为什么需要这个工具（而不是"记得手动补"）
 *
 * 本文件所在目录的 `edit` 工具**每次写文件都会丢掉 UTF-8 BOM**。
 * 而 `probe-service-signal.ps1` 的 BOM **是必需的**——文件自己的注释就写着：
 * *"读这些文件必须显式 -Encoding UTF8：驱动是 Node 写的、不带 BOM，
 * Windows PowerShell 5.1 的 Get-Content -Raw 会按 ANSI(CP936) 解码"*。
 *
 * 实测的后果（本会话踩了 **4 次**）：丢了 BOM 之后
 * - `pwsh`（PowerShell 7，默认 UTF-8）跑**正常**；
 * - `powershell`（Windows PowerShell 5.1）把它按 cp936 读，中文全乱，
 *   报一堆"Missing closing '}'"，而**首条错误与真正的问题无关**。
 *
 * 更麻烦的是：`check-ps1-bom.mjs` 只能**检测**，不能**修复**；
 * 而"检测到之后手工补"依赖我记得——这正是本项目反复失败的形态。
 * 所以这里做成可重复运行的工具，并在需要时紧跟 `edit` 之后跑一次。
 *
 * 用法：
 *   node verify/restore-ps1-bom.mjs           只补，报告改了几个
 *   node verify/restore-ps1-bom.mjs --check   只查，不写；有缺失就以非零退出
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERIFY = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(VERIFY);
const CHECK_ONLY = process.argv.includes('--check');
const SKIP_DIRS = new Set(['_tmp', '_scratch', '_lab', 'backup', 'node_modules', 'shots', 'logs']);
// 按前缀判过程产物目录：改名成 `_scratch_REMOVED_*` 后精确相等会失效（2026-09-18 实测）。
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

/** 读文件头三字节判断 BOM。 */
const hasBom = (bytes) => bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;

/**
 * 取 git HEAD 里同一文件是否带 BOM。
 *
 * @param {string} relPath - 相对仓库根、正斜杠分隔的路径。
 * @returns {boolean|null} 带 BOM 为 true；不带为 false；不在 HEAD 里为 null。
 */
function headHasBom(relPath) {
  try {
    const out = execFileSync('git', ['show', `HEAD:${relPath}`], { cwd: REPO, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
    return hasBom(out);
  } catch {
    return null;
  }
}

const restored = [];
const missing = [];

for (const file of walk(VERIFY)) {
  if (!statSync(file).isFile()) continue;
  const rel = relative(REPO, file).replace(/\\/g, '/');
  const bytes = readFileSync(file);
  if (hasBom(bytes)) continue;
  if (headHasBom(rel) !== true) continue; // HEAD 里也没有 BOM ⇒ 不该补
  missing.push(rel);
  if (CHECK_ONLY) continue;
  writeFileSync(file, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), bytes]));
  restored.push(rel);
}

if (missing.length === 0) {
  console.log('所有"HEAD 里带 BOM"的 .ps1 都保住了 BOM。');
  process.exit(0);
}

if (CHECK_ONLY) {
  console.log(`${String(missing.length)} 个文件**丢了 BOM**（HEAD 里有）：`);
  for (const rel of missing) console.log(`  FAIL  ${rel}`);
  console.log('');
  console.log('跑 `node verify/restore-ps1-bom.mjs` 补回，或 `npm run check` 里的 check:ps1-bom。');
  process.exit(1);
}

console.log(`已补回 ${String(restored.length)} 个文件的 BOM：`);
for (const rel of restored) console.log(`  FIXED  ${rel}`);
console.log('');
console.log('丢了 BOM 的后果（本会话踩过 4 次）：pwsh(PS7) 仍正常，powershell(PS5.1) 按 cp936 读，');
console.log('中文全乱、报一堆与真正问题无关的 "Missing closing \'}\'"。');
