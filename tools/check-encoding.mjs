/**
 * 编码体检的 CLI 外壳：遍历包内文件，调用 `_encoding-core.mjs` 的判据，输出并决定退出码。
 *
 * 判据本体（含三类损坏的定义、阈值、豁免标记、坑位说明）在
 * `tools/_encoding-core.mjs` 的头部注释里；本文件只负责"走文件 + 报结果 + 定退出码"。
 *
 * **CRLF 必须计入退出码**：只打印不失败，等于报了个没人会拦的警。
 *
 * 用法：node tools/check-encoding.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { inspectText } from './_encoding-core.mjs';
import { LOCAL_DIR } from './_local-config.mjs';

/**
 * 不扫的目录名。
 *
 * - `node_modules` / `.git`：不是本仓的东西。
 * - `LOCAL_DIR`（本机侧）：**运行期产物、语料、证据、临时工作区全在里面**。
 *   它是一整类东西的统一落点：CDP 的临时浏览器 profile（一次运行几百个文件）、
 *   探针的侦察草稿、隔离测试用的整个 DSH_HOME、部署前快照、下载来的调研物、
 *   探针输出（PowerShell 的 `Out-File` 天然带 CRLF，每跑一次就重写一次）。
 *   它们由工具或下载源生成、不回写源码，行尾是生成器说了算——CRLF 判据是给**源码**的
 *   （防编辑器把行尾改掉），套在这些东西上会变成"每次跑完探针必红一次"，
 *   而红的原因不是任何人的改错。一个必然常红的检查等于没有检查。
 *
 *   过程产物的落点统一归本机侧，跳过名单只列上面三个目录，不逐目录登记。
 */
const SKIP_DIRS = new Set(['node_modules', '.git', LOCAL_DIR]);

/**
 * 按**前缀**判过程产物目录，不是精确相等。
 *
 * 理由：过程产物目录一旦改名（例如 `_scratch` → `_scratch_REMOVED_日期`），
 * 精确相等的跳过名单**当场失效**——里面的上百个文件（旧检查器副本、旧文档快照）
 * 立刻被当成交付树的一部分参与本检查。检查器会被"改个名"绕过，而它自己不会报这件事。
 */
const isSkippedDir = (name) => SKIP_DIRS.has(name) || name.startsWith('_scratch');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isSkippedDir(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|json|yml|md|txt)$/.test(entry.name)) out.push(full);
  }
  return out;
}

let hardBroken = 0;
let doubleEncoded = 0;
let crlf = 0;
let excused = 0;

for (const file of walk('.')) {
  const label = relative('.', file).replaceAll('\\', '/');
  const verdict = inspectText(readFileSync(file, 'utf8'));
  excused += verdict.excused;

  if (verdict.hardBroken > 0) {
    hardBroken += 1;
    console.log(`HARD-BROKEN  ${label}  U+FFFD=${String(verdict.hardBroken)}`);
  }
  if (verdict.doubleEncoded) {
    doubleEncoded += 1;
    console.log(
      `DOUBLE-ENC   ${label}  常用字占比=${verdict.ratio.toFixed(2)}（汉字 ${String(verdict.han)} 个）`
      + '；若这是合法繁体/生僻字内容，在该文件里加一行含 ENCODING-OK 的说明即可豁免'
    );
  }
  if (verdict.crlf > 0) {
    crlf += 1;
    console.log(`CRLF         ${label}  CR=${String(verdict.crlf)}`);
  }
}

console.log('');
if (excused > 0) console.log(`（另有 ${String(excused)} 处 U+FFFD 带示例标记，按故意示例豁免）`);
const clean = hardBroken === 0 && doubleEncoded === 0 && crlf === 0;
console.log(
  clean
    ? '编码体检通过：无非法字节、无双重编码、无 CRLF。'
    : `编码体检失败：非法字节文件 ${String(hardBroken)}、双重编码文件 ${String(doubleEncoded)}、CRLF 文件 ${String(crlf)}。`
);
process.exit(clean ? 0 : 1);
