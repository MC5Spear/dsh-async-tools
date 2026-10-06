/**
 * 两棵 DSH 安装树的包级差异对照器（R38 §37.1 差异盘点的工具形态，F158/F159 的复核入口）。
 *
 * 用法：node verify/diff-trees.mjs <pkg1> [pkg2 …]（`@deepseek-ai` 作用域下的包名）
 *
 * 对每个包：两树全文件递归对比（跳过包内 node_modules/.git），报告：
 * - 文件数 A/B、changed/added/removed 总数；
 * - 代码文件（js/mjs/cjs/ts/json/yml，非 .d.ts）的逐文件 `~`（变化，带字节长度）/
 *   `+`（新增）/ `-`（删除）清单（各截断至 60/40/20 条）。
 *
 * 树根经 `tools/_local-config.mjs` 从本机平面读（或环境变量 `DSAT_HOST_MODULES`）——
 * 写死本机绝对路径正是本仓"半翻锚"那类事故的来源。两档树任一没配置就打 SKIP 退出。
 * 非代码文件（map/README 等）计入计数但不占清单篇幅。
 */
import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { loadLocalPlaneOrSkip, LOCAL_DIR } from '../tools/_local-config.mjs';

const config = await loadLocalPlaneOrSkip('verify/diff-trees.mjs（两棵安装树的差异对照器）');
const A = config.evidenceTree['017'];
const B = config.evidenceTree['020'];
if (A === undefined || B === undefined) {
  console.error(`两档树都要有来源才能对照（017=${String(A)} 020=${String(B)}）。`);
  console.error(`在 ${LOCAL_DIR}/config.mjs 的 evidenceTree 里补齐，`
    + '或设环境变量 DSAT_HOST_MODULES / DSAT_EVIDENCE_TREE。');
  process.exit(2);
}

/** 解引用 junction/symlink 根（⑤ 轮 I-5）：传开发树的包目录（是 junction）也能真对比，
 *  而不是 readdir 直接穿透目标后把对比报成 files=0 的空结果。 */
function resolveRoot(p) {
  try { return realpathSync(p); } catch { return p; }
}

function walk(root, dir = '', out = []) {
  let entries;
  try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory() || e.isSymbolicLink()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(root, rel, out);
    } else out.push(rel);
  }
  return out;
}

const pkgs = process.argv.slice(2);
if (pkgs.length === 0) {
  console.error('用法：node verify/diff-trees.mjs <pkg1> [pkg2 …]（@deepseek-ai 下的包名）');
  process.exit(2);
}
for (const pkg of pkgs) {
  const aDir = resolveRoot(join(A, pkg)), bDir = resolveRoot(join(B, pkg));
  if (!existsSync(aDir) || !existsSync(bDir)) {
    console.log(`## ${pkg}: MISSING in ${!existsSync(aDir) ? '0.1.7' : '0.2.0'}（A=${aDir}）`);
    continue;
  }
  const aFiles = walk(aDir), bFiles = walk(bDir);
  const aSet = new Set(aFiles), bSet = new Set(bFiles);
  const added = bFiles.filter((f) => !aSet.has(f));
  const removed = aFiles.filter((f) => !bSet.has(f));
  const common = aFiles.filter((f) => bSet.has(f));
  const changed = [];
  for (const f of common) {
    let ab, bb;
    try { ab = readFileSync(join(aDir, f)); } catch { changed.push([f, 'READ_ERR_A']); continue; }
    try { bb = readFileSync(join(bDir, f)); } catch { changed.push([f, 'READ_ERR_B']); continue; }
    if (!ab.equals(bb)) changed.push([f, ab.length, bb.length]);
  }
  const hot = changed.filter(([f]) => /\.(js|cjs|mjs|ts|json|yml|yaml)$/i.test(f) && !f.endsWith('.d.ts'));
  console.log(`## ${pkg}: files A=${aFiles.length} B=${bFiles.length} changed=${changed.length} added=${added.length} removed=${removed.length}`);
  for (const [f, la, lb] of hot.slice(0, 60)) console.log(`  ~ ${f}${typeof la === 'number' ? ` (${la}->${lb})` : la ? ` (${la})` : ''}`);
  if (hot.length > 60) console.log(`  ... +${hot.length - 60} more changed code files`);
  const hotAdd = added.filter((f) => /\.(js|cjs|mjs|ts|json|yml|yaml)$/i.test(f) && !f.endsWith('.d.ts'));
  for (const f of hotAdd.slice(0, 40)) console.log(`  + ${f}`);
  if (hotAdd.length > 40) console.log(`  ... +${hotAdd.length - 40} more added code files`);
  for (const f of removed.filter((f) => /\.(js|cjs|mjs|ts|json|yml|yaml)$/i.test(f) && !f.endsWith('.d.ts')).slice(0, 20)) console.log(`  - ${f}`);
}
