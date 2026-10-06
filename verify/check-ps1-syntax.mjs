/**
 * 静态判据：`verify/` 下的 PowerShell 脚本必须**通过语法解析**（用正确的方式解析）。
 *
 * ## 为什么不能用 `Parser::ParseFile`
 *
 * 第一版判据用 `[Parser]::ParseFile($path, ...)`，得到两个"坏文件"：
 * `probe-service-signal.ps1` 报 **50** 个错误、`probe-service-signal-disposer.ps1` 报 **8** 个。
 * 追下去发现：
 *
 * - 前者的 50 个错误是**我自己造成的**——我用脚本清理注释里的反引号时，
 *   顺手把文件的 **UTF-8 BOM 删掉了**（`U+FEFF` 被当成可删字符）。该文件自己的注释就写着：
 *   *"Windows PowerShell 5.1 的 Get-Content -Raw 会按 ANSI(CP936) 解码"*——
 *   去掉 BOM 之后解析器正是按 cp936 读它，中文全乱，语法随之崩。
 * - 后者的 8 个错误是**解析方法的假象**：那个文件**没有 BOM**，
 *   `ParseFile` 同样按 ANSI 读，于是报错；改用 `ParseInput`（文本由 Node 以 UTF-8 读入后
 *   经 stdin 传入）得到的是 **0 个错误**。
 *
 * ⇒ **判据必须把"读文件"和"解析文本"分开**：由 Node 用 UTF-8 读，再让 PowerShell 解析文本。
 * 否则判据会随文件的 BOM 有无而给出完全不同的结论——而 BOM 的取舍是**另一个**问题。
 *
 * ## 顺带一个真事实（值得单独记）
 *
 * `verify/` 下的 `.ps1` 里，**`probe-service-signal.ps1` 有 BOM、`probe-service-signal-disposer.ps1` 没有**。
 * 前者被 PowerShell 正确读取（因为 BOM 指明 UTF-8），后者的中文注释在 PS 5.1 里会乱码。
 * 后者之所以还能跑，是因为它的**代码部分**恰好没有依赖中文串做判定。
 * 这一条登记为待办，不在本判据里自动修（改 BOM 会动到 git diff 与字节）。
 *
 * 用法：node verify/check-ps1-syntax.mjs
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERIFY = dirname(fileURLToPath(import.meta.url));
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

/**
 * 用一个**单独的 PowerShell 进程**解析文本。
 *
 * ## 为什么是"临时文件 + `ParseFile`"，而不是"stdin + `ParseInput`"
 *
 * 原来的写法是把文本经 **stdin** 喂给 `powershell -Command`，脚本里
 * `[Console]::In.ReadToEnd()` 读它。那个口径在本机**对中文文件一律误报**：
 * Windows PowerShell 5.1 按**控制台输入代码页**（本机 CP936）解码 stdin 字节，
 * 而 Node 写进去的是 **UTF-8** 字节 ⇒ 每个中文字符都乱掉，乱出来的字符会吃掉引号，
 * 于是报成 `Missing closing '}' in statement block` 之类的**假语法错**。
 *
 * 实测（同一批文件、同一台机器）：
 *   - 全 ASCII 的对照脚本 → stdin 口径**通过**；
 *   - 含中文的 4 个脚本 → stdin 口径报 27/49/5/3 个错；
 *   - 同一文件 `ParseFile` 直接读 → **0 错**；同一进程内 `ParseInput($src)` → **0 错**。
 * 即"错"只出现在 stdin 这一条传输路上。
 *
 * 所以改成：Node 把**解码后的文本**写成带 UTF-8 BOM 的临时文件，交给 `ParseFile`。
 * 这样"由 Node 负责解码"（本判据的初衷）与"PS 负责解析"两件事都保住，
 * 而 BOM 让 PS 明确知道那是 UTF-8。临时文件建在系统临时目录，**不落进包内**。
 *
 * @param {string} text - 源码文本（已由 Node 按 UTF-8 解码）。
 * @returns {{ count: number, firstLine: number, message: string }} 解析结果。
 */
function parseText(text) {
  const dir = mkdtempSync(join(tmpdir(), 'ps1syntax-'));
  const file = join(dir, 'probe.ps1');
  try {
    // 显式写 BOM：PS 5.1 见到 BOM 才按 UTF-8 读。
    writeFileSync(file, `\uFEFF${text}`, 'utf8');
    const script = `$e=$null; `
      + `[System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$e) | Out-Null; `
      + `if ($e -and $e.Count -gt 0) { "" + $e.Count + "|" + $e[0].Extent.StartLineNumber + "|" + ($e[0].Message -replace "[\\r\\n]+"," ") } else { "0|0|ok" }`;
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', stdio: 'pipe' }).trim();
    const parts = out.split('|');
    return { count: Number(parts[0]), firstLine: Number(parts[1]), message: parts.slice(2).join('|') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const files = walk(VERIFY).filter((file) => statSync(file).isFile());
const problems = [];
const bomless = [];

for (const file of files) {
  const bytes = readFileSync(file);
  const hasBom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
  // 一律按 UTF-8 读，**并剥掉开头的 BOM**。
  //
  // ⚠️ 必须剥。同文件三口径实测（`verify/_scratch/ps1-three-ways.ps1`）：
  //     ParseFile                    → 0 错（直接读文件）
  //     ParseInput(Get-Content -Raw) → 0 错（PS 自己读，会剥 BOM）
  //     ParseInput(UTF8.GetString)   → 1 错 ← **纯 UTF-8 解码，BOM 留成 U+FEFF 字符**
  //   `[System.IO.File]::ReadAllText` 与 `Encoding.UTF8.GetString` **不剥 BOM**
  //   （前者只在 `detectEncodingFromByteOrderMarks` 为真时才剥），所以那个 U+FEFF
  //   落在 `param(` 前面，PowerShell 解析器就报 "The assignment expression is not valid"。
  //
  //   本文件此处曾写着"BOM 存在时 Node 会保留为 U+FEFF 字符，**解析器不在意**"——
  //   **那句话是错的**，于是带 BOM 的脚本一律被误报成语法坏。教训：
  //   "我以为解析器不在意"这种判断必须有对照实验，不能靠印象。
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (!hasBom) bomless.push(relative(VERIFY, file));

  const result = parseText(text);
  if (result.count > 0) {
    problems.push(`${relative(VERIFY, file)}  ${String(result.count)} 个语法错误，首错 line ${String(result.firstLine)}：${result.message}`);
  }
}

console.log(`扫了 ${String(files.length)} 个 PowerShell 脚本（文本由 Node 以 UTF-8 读入，写成带 BOM 的临时文件后交给 ParseFile）。`);
if (bomless.length > 0) {
  console.log(`无 BOM 的 ${String(bomless.length)} 个：${bomless.join(', ')}`);
  console.log('  ⚠️ 无 BOM 时，Windows PowerShell 5.1 会按 ANSI(CP936) 读这些文件；');
  console.log('     中文注释会乱码。本判据不受影响（它由 Node 解码），但**运行时**会受影响。');
}
console.log('');

if (problems.length === 0) {
  console.log('所有脚本都通过语法解析。');
  process.exit(0);
}
for (const problem of problems) console.log(`FAIL  ${problem}`);
process.exit(1);
