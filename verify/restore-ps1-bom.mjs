/**
 * 还原工具：把 git HEAD 里带 BOM 的 `.ps1` 的 BOM 补回工作区。
 *
 * ## 为什么需要这个工具（而不是"记得手动补"）
 *
 * `edit` 工具**每次写文件都会丢掉 UTF-8 BOM**。丢了 BOM 之后：
 * - `pwsh`（PowerShell 7，默认 UTF-8）跑**正常**；
 * - `powershell`（Windows PowerShell 5.1）把它按 cp936 读，中文全乱，
 *   报一堆"Missing closing '}'"，而**首条错误与真正的问题无关**。
 *
 * 检测在 `check-ps1-bom.mjs`，修复在这里；手工补依赖记忆，不可靠。
 * 所以这里做成可重复运行的工具，并在需要时紧跟 `edit` 之后跑一次。
 *
 * Git 错误分类：只有**确知** HEAD 里没有该对象（git 的明确诊断）才跳过；
 * Git 二进制缺席、权限失败或其他 Git 错误单独报错可见（非零退出）——
 * 把「工具没跑成」吞成「HEAD 无 BOM」会在缺 BOM 时误报成功。
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

/** 读文件头三字节判断 BOM。 */
const hasBom = (bytes) => bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;

/**
 * 取 git HEAD 里同一文件是否带 BOM。
 *
 * 错误分类（VERIFY-BOM-ERROR-CLASSIFICATION）：**只有确知 HEAD 里没有该对象**
 * 才返回 null（跳过补 BOM）。Git 二进制缺席、权限失败或其他 Git 错误**单独报错
 * 可见**——把「工具没跑成」吞成「HEAD 无对象」会在缺 BOM 时误报成功。
 *
 * @param {string} relPath - 相对仓库根、正斜杠分隔的路径。
 * @returns {boolean|null} 带 BOM 为 true；不带为 false；确知不在 HEAD 里为 null。
 * @throws {Error} Git 缺席、spawn 失败或 HEAD 之外的 Git 错误（错误里带 git 的
 *   stderr 摘要）。
 */
function headHasBom(relPath) {
  let error;
  let stdout;
  try {
    stdout = execFileSync('git', ['show', `HEAD:${relPath}`], { cwd: REPO, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  } catch (thrown) {
    error = thrown;
  }
  if (error === undefined) return hasBom(stdout);

  // 形态一：HEAD 里确实没有该对象（git exit 128 + 明确的「does not exist」诊断）。
  // 只有这个形态能当「无对象」——其余一律上抛。
  const stderr = `${error.stderr ?? ''}`;
  if (error.status === 128 && /does not exist in .?HEAD.|exists on disk, but not in HEAD/i.test(stderr)) {
    return null;
  }
  // 形态二：找不到 git 可执行（PATH 没有 git）。
  if (error.code === 'ENOENT') {
    throw new Error(`找不到 git 可执行文件（ENOENT）——无法判定 HEAD 是否带 BOM，本工具不猜测；`
      + `此前形态会把这吞成「HEAD 无对象」静默跳过。cwd=${REPO}`);
  }
  // 形态三：spawn 被拒（权限／沙箱）与其他 Git 错误（不是仓库、对象库损坏等）。
  throw new Error(`git show HEAD:${relPath} 失败（${String(error.code ?? `exit ${String(error.status ?? '?')}`)}）：${stderr.trim().slice(0, 200)}`
    + '——无法判定 HEAD 是否带 BOM，本条不跳过、不冒充成功。');
}

const restored = [];
const missing = [];
const gitErrors = [];

for (const file of walk(VERIFY)) {
  if (!statSync(file).isFile()) continue;
  const rel = relative(REPO, file).replace(/\\/g, '/');
  const bytes = readFileSync(file);
  if (hasBom(bytes)) continue;
  let inHead;
  try {
    inHead = headHasBom(rel);
  } catch (error) {
    // Git 失败单独记账：不跳过、不当作「HEAD 无 BOM」——汇总后非零退出。
    gitErrors.push({ rel, error: String(error?.message ?? error) });
    continue;
  }
  if (inHead !== true) continue; // 确知 HEAD 无 BOM／无该对象 ⇒ 不该补
  missing.push(rel);
  if (CHECK_ONLY) continue;
  writeFileSync(file, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), bytes]));
  restored.push(rel);
}

if (gitErrors.length > 0) {
  console.error(`${String(gitErrors.length)} 个文件无法核对 HEAD（Git 失败——不跳过、不冒充成功）：`);
  for (const e of gitErrors) console.error(`  GIT-FAIL  ${e.rel}  ${e.error.slice(0, 180)}`);
  process.exit(1);
}

if (missing.length === 0) {
  console.log('所有"HEAD 里带 BOM"的 .ps1 都保住了 BOM。');
  process.exit(0);
}

if (CHECK_ONLY) {
  console.log(`${String(missing.length)} 个文件**丢了 BOM**（HEAD 里有）：`);
  for (const rel of missing) console.log(`  FAIL  ${rel}`);
  console.log('');
  console.log('跑 `node verify/restore-ps1-bom.mjs` 补回，或 `node verify/check-ps1-bom.mjs`。');
  process.exit(1);
}

console.log(`已补回 ${String(restored.length)} 个文件的 BOM：`);
for (const rel of restored) console.log(`  FIXED  ${rel}`);
console.log('');
console.log('丢了 BOM 的后果：pwsh(PS7) 仍正常，powershell(PS5.1) 按 cp936 读，');
console.log('中文全乱、报一堆与真正问题无关的 "Missing closing \'}\'"。');
