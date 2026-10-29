/**
 * 现行文档里的**裸文件名引用**必须能在盘上找到同名文件。
 *
 * ## 为什么单独一条（这是路径检查器的盲区）
 *
 * `tools/check-doc-paths.mjs` 只认**带路径前缀**的写法（`verify/x.mjs`）或**绝对路径**。
 * 而文档里大量写的是**光名字**——`` `some-probe.mjs` ``、`` `some-driver.mjs` ``、
 * `` `some-report.md` ``。删掉那些文件之后，这些指针**静默通过**检查器：
 * 证据指针指向不存在的文件，而检查器看不见它。
 *
 * 同口径全仓扫一遍，悬空的裸文件名都能被数出来。
 *
 * ## 口径
 *
 * 对每个光名字，**全仓递归**找同名文件（跳过**过程产物与本机侧目录**——全集见
 * `SKIP_DIRS`：`node_modules`、`.git`、`_scratch`、`_tmp`、`logs`、`shots`、
 * `backup`、`_lab`、`LOCAL_DIR`；它们不算交付树，指到那儿等于指不到）。
 *
 * **只按文件名比**，不要求唯一：文档写 `` `package.json` `` 时说的是"这一类清单文件"，
 * 不特指某一个。要求唯一会制造大量假阳性。
 *
 * 用法：node tools/check-bare-filenames.mjs
 *
 * ## 双入口形态
 *
 * `checkBareFilenames(root)` 可导入（测试进程内调用，避免沙箱下 spawn EPERM 的假红）；
 * CLI 入口只在直接执行时生效。与 `tools/validate-preset.mjs` 同款分工。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCAL_DIR } from './_local-config.mjs';

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 额外的搜索根（**默认为空**）。
 *
 * 不写死本机搜索根，两条理由：
 *
 * 1. 本机路径（哪个盘、哪个目录名）是**本机事实**，公开范围不许有；
 * 2. 事实登记簿已下沉到本机侧，公开文档按自包含原则**不该再指向别的仓**。
 *
 * 机制留着（`--extra-root <路径>`，可重复），但**用之前先问**："公开文档真的会提到
 * 那个包的文件吗？"答不上来就别加——搜索根不是豁免，文件找不到时照样报。
 */
const DEFAULT_EXTRA_ROOTS = [];

/** 文档清单与责任表同集；裸文件名判据包含档案。 */
const CURRENT = [
  'README.md',
  'README.en.md',
  'docs/user-reference.md',
  'docs/user-reference.en.md',
  'docs/documentation-principles.md',
  'docs/requirements.md',
  'docs/design.md',
  'verify/README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md'
];

/**
 * 过程产物与**本机侧**的目录名：指到那里等于指不到，所以收集文件名时跳过。
 *
 * `LOCAL_DIR` 必须跳过，而且理由比"噪声"硬：本判据问的是"这个名字在**交付树**里
 * 有没有同名文件"。本机侧里确实存着同名副本（旧快照、旧探针），
 * 拿它当"找到了"会把一条悬空指针读成绿的。
 */
const SKIP_DIRS = new Set(['node_modules', '.git', '_scratch', '_tmp', 'logs', 'shots', 'backup', '_lab', LOCAL_DIR]);

/**
 * 按**前缀**判过程产物目录，不是精确相等。
 *
 * 理由：过程产物目录一旦改名（例如 `_scratch` → `_scratch_REMOVED_日期`），
 * 精确相等的跳过名单当场失效，里面的上百个文件（旧检查器副本与旧文档快照）
 * 立刻被算进"交付树的文件名"。**改名就能绕过检查器**，而检查器自己不会报这件事。
 */
const isSkippedDir = (name) => SKIP_DIRS.has(name) || name.startsWith('_scratch');

/**
 * 递归收集一个目录树下所有文件名。
 *
 * @param {string} dir - 起点。
 * @param {Set<string>} out - 收集容器。
 */
function collect(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (isSkippedDir(entry.name)) continue;
      collect(join(dir, entry.name), out);
      continue;
    }
    out.add(entry.name);
  }
}

/** 行内代码里的光文件名：前面不是路径分隔符、点、连字符或词字符。 */
const BARE_RE = /(?<![\w/.\\-])`([a-z][\w.-]*\.(?:mjs|js|md|json|ps1|yml|png))`/g;

/**
 * 跑一遍裸文件名检查。
 *
 * @param {string} root - 仓库根。
 * @param {{quiet?: boolean, extraRoots?: string[]}} [options] - `quiet:true` 时不向 stdout 打印（测试用）；
 *   `extraRoots` 是额外的搜索根（缺省为空，见 `DEFAULT_EXTRA_ROOTS`）。
 * @returns {{ok: boolean, code: number, out: string, scanned: number}} `scanned` = 扫到的光名字引用数。
 */
export function checkBareFilenames(root = MODULE_ROOT, { quiet = false, extraRoots = DEFAULT_EXTRA_ROOTS } = {}) {
  const lines = [];
  const say = (line) => {
    lines.push(line);
    if (!quiet) console.log(line);
  };

  const onDisk = new Set();
  collect(root, onDisk);
  for (const extra of extraRoots) collect(extra, onDisk);

  let total = 0;
  const missing = [];
  for (const rel of CURRENT) {
    const text = readFileSync(join(root, rel), 'utf8');
    text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(BARE_RE)) {
        total += 1;
        if (!onDisk.has(match[1])) missing.push(`${rel}:${String(index + 1)} → ${match[1]}`);
      }
    });
  }

  const scopeNote = extraRoots.length > 0 ? '含兄弟包、排除过程产物' : '排除过程产物';
  say(`盘上（${scopeNote}）文件名 ${String(onDisk.size)} 个；现行文档里的光文件名引用 ${String(total)} 处。`);
  say('');

  let ok;
  if (missing.length > 0) {
    say(`**${String(missing.length)} 处悬空**（读者按图索骥会扑空）：`);
    for (const m of missing) say(`  ${m}`);
    say('');
    say('处置：指向真实落点（带上路径前缀），或删掉这个指针——不要写进豁免来消音。');
    ok = false;
  } else if (total === 0) {
    // 与 `check-doc-paths` 同一条纪律：「一处都没扫到」和「扫过且都对」是两件事。
    say('**一处光文件名引用都没扫到**——要么文档里真的没有（几乎不可能），要么提取规则坏了。按失败处理。');
    ok = false;
  } else {
    say('现行文档里的光文件名引用都能在盘上找到同名文件。');
    ok = true;
  }
  return { ok, code: ok ? 0 : 1, out: lines.join('\n'), scanned: total };
}

// CLI 入口：只在直接执行时生效。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const extraRoots = process.argv
    .map((arg, i) => (arg === '--extra-root' ? process.argv[i + 1] : undefined))
    .filter((value) => typeof value === 'string' && value.length > 0);
  process.exit(checkBareFilenames(MODULE_ROOT, {
    extraRoots: extraRoots.length === 0 ? DEFAULT_EXTRA_ROOTS : extraRoots
  }).code);
}
