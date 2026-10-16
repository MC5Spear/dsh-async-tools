/**
 * 事实依据可解析性检查器：事实登记簿里每条"依据"引到的源码位置必须真的存在。
 *
 * ## 判据（每条引用单独判）
 *
 * 1. **文件在**：`<前缀><包>/<相对路径>` 在对应安装树里能找到；
 * 2. **行号在范围内**：`:<行号>` 不超过该文件的行数（越界即判红——版本漂移最常见的表现）；
 * 3. **区间合法**：`:A-B` 形态要求 A ≤ B 且 B 在范围内；
 * 4. **四字段齐**：每个 `## F…` 条目里"现行值 / 依据 / 核销日期 / 更新入口"各恰好一处。
 *
 * 三类前缀：`[0.2.0]` → `'020'` 树、`[0.1.7]` → `'017'` 树、`PKGS/` 与未标前缀 → `'015'` 树。
 *
 * ## 登记簿与树根都不在代码里
 *
 * 登记簿不由本公开仓跟踪，检查时读取本机材料目录（`<LOCAL_DIR>/docs/`），三棵安装树经
 * `tools/_local-config.mjs` 从 `.local/config.mjs`（或环境变量）读。两样都可以缺：
 *
 * - 登记簿目录整个不在（CI、外部 clone）→ 打一行 `SKIP` 放过；
 * - 某一档树没配置 → 该档的引用**逐条**记为 `TREE-ABSENT` 并在末尾汇总，
 *   不计入硬错误（缺配置不是"引用坏了"）。
 *
 * ## 为什么要导出 `analyzeFacts`
 *
 * `verify/mutate-facts-anchors.mjs` 要用变异证明这个检查器**能红**。
 * **沙箱禁止管道捕获子进程输出**（EPERM → status 为 null），靠 `spawnSync` 捕获
 * stdout 的形态在默认沙箱下必成假红。分析逻辑以纯函数导出、直接吃文本，
 * 变异脚本不起子进程，默认沙箱下即可运行。
 *
 * 用法：`node verify/check-facts-anchors.mjs [--facts <路径>] [--tree020 <路径>] [--tree017 <路径>] [--tree015 <路径>]`
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_DIR, loadLocalPlaneOrSkip } from '../tools/_local-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const COMMON_DIRS = new Set(['lib', 'types', 'presets', 'src', 'dist', 'node_modules']);
const CITATION = /(?:\[0\.1\.7\]\s*|\[0\.2\.0\]\s*|PKGS\/)?((?:@[^/\s]+\/)?[A-Za-z0-9._-]+)\/([\w./-]+?\.(?:js|mjs|cjs|ts|d\.ts|yml|yaml|json)):(\d+)(?:-(\d+))?/g;
const FIELDS = ['现行值', '依据', '核销日期', '更新入口'];

/**
 * 分析一份事实登记簿文本。
 *
 * @param {string} text - 登记簿全文。
 * @param {{ tree020?: string, tree017?: string, tree015?: string, repoRoot?: string }} [options]
 *   三棵安装树与本仓根。**树可以是 `undefined`**：那一档的引用逐条记为 `TREE-ABSENT`
 *   并计入 `treeAbsent`，不算硬错误——缺配置与"引用坏了"是两件事，不能混。
 * @returns {{ citations: number, ok: number, viaRepoFallback: number, treeAbsent: number,
 *   hardErrors: number, fieldProblems: number, entryCount: number, report: string[] }}
 *   读数与逐行报告。
 */
export function analyzeFacts(text, options = {}) {
  const TREE_020 = options.tree020;
  const TREE_017 = options.tree017;
  const TREE_015 = options.tree015;
  const repoRoot = options.repoRoot ?? ROOT;
  const lines = text.split('\n');
  const report = [];

  /** 一条引用：包名 / 相对路径 / 行号或行号区间 / 用哪棵树 / 出现在哪一行 / 属于哪个 F 条目。 */
  const citations = [];
  // 按**条目**（`## F…` 到下一个标题）解析：树与前缀包名都是条目级约定——
  // `[0.1.7]` 常在"依据"里写一次（可能在引用之后），包名也常只在首次出现时写全。
  const blocks = [];
  let block = null;
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^## (F\d+)/.exec(lines[i]);
    if (heading !== null) {
      block = { entry: heading[1], lines: [] };
      blocks.push(block);
    } else if (block !== null) {
      block.lines.push({ text: lines[i], number: i + 1 });
    }
  }
  for (const current of blocks) {
    const joined = current.lines.map((l) => l.text).join('\n');
    const entryTree = /\[0\.2\.0\]/.test(joined) ? '020' : (/\[0\.1\.7\]/.test(joined) ? '017' : '015');
    const packages = [...joined.matchAll(/(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+\/(?=[\w./-]+?\.(?:js|mjs|cjs|ts|d\.ts|yml|yaml|json):\d)/g)]
      .map((m) => m[0].slice(0, -1))
      .filter((name) => !COMMON_DIRS.has(name));
    let lastPackage = '';
    for (const line of current.lines) {
      for (const match of line.text.matchAll(CITATION)) {
        const explicit020 = /\[0\.2\.0\]/.test(match[0]);
        const explicit017 = /\[0\.1\.7\]/.test(match[0]);
        const explicit015 = /PKGS\//.test(match[0]);
        const bare = COMMON_DIRS.has(match[1]);
        if (!bare) lastPackage = match[1];
        const pkg = bare ? (lastPackage !== '' ? lastPackage : (packages[0] ?? match[1])) : match[1];
        citations.push({
          entry: current.entry,
          line: line.number,
          pkg,
          rel: bare ? `${match[1]}/${match[2]}` : match[2],
          from: Number(match[3]),
          to: match[4] === undefined ? Number(match[3]) : Number(match[4]),
          tree: explicit020 ? '020' : (explicit015 ? '015' : (explicit017 ? '017' : entryTree))
        });
      }
    }
  }

  let bad = 0;
  let ok = 0;
  let viaRepoFallback = 0;
  let treeAbsent = 0;
  const treeCache = new Map();
  /**
   * 解析一条引用：按"安装树 → 树根父目录（带包名）→ 本仓（带包名前缀）→ 本仓
   * （裸相对路径）"的顺序取第一个存在的文件。
   *
   * 为什么要有本仓回退：事实条目里既有安装树的引用，也有本包自己的文件引用
   * （形如 `lib/jobs.js:458-468`），两者写法一样、只能靠"文件在不在"分辨。
   */
  function resolve(citation) {
    const treeRoot = citation.tree === '017' ? TREE_017 : (citation.tree === '020' ? TREE_020 : TREE_015);
    if (treeRoot === undefined) return { absent: true };
    const roots = [
      join(treeRoot, citation.pkg, citation.rel),
      join(dirname(treeRoot), citation.pkg, citation.rel),
      join(repoRoot, citation.pkg, citation.rel),
      join(repoRoot, citation.rel)
    ];
    for (let i = 0; i < roots.length; i += 1) {
      const full = roots[i];
      if (treeCache.has(full)) {
        const cached = treeCache.get(full);
        if (cached !== null) return { full, count: cached, fallback: i > 0 };
        continue;
      }
      if (!existsSync(full) || !statSync(full).isFile()) {
        treeCache.set(full, null);
        continue;
      }
      const count = readFileSync(full, 'utf8').split('\n').length;
      treeCache.set(full, count);
      return { full, count, fallback: i > 0 };
    }
    return null;
  }

  for (const citation of citations) {
    const found = resolve(citation);
    const label = `F${citation.entry.replace('F', '')} :${citation.line} [${citation.tree}] ${citation.pkg}/${citation.rel}:${citation.from}${citation.to === citation.from ? '' : `-${citation.to}`}`;
    if (found === null) {
      report.push(`  MISSING ${label}`);
      bad += 1;
    } else if (found.absent) {
      // 这一档树没配置：**不是**引用坏了，是这台机器没登记树的位置。逐条列出、
      // 末尾汇总，让"跳过了多少"可见——静默跳过正是本仓点名过的假绿形态。
      report.push(`  TREE-ABSENT ${label}（${citation.tree} 档安装树无来源）`);
      treeAbsent += 1;
    } else if (citation.from > citation.to || citation.to > found.count) {
      report.push(`  OUT-OF-RANGE ${label}（${found.full} 共 ${found.count} 行）`);
      bad += 1;
    } else {
      if (found.fallback) {
        viaRepoFallback += 1;
        // 回退到本仓意味着"包名那一段没能在安装树里找到"——可能是本包自己的文件（正常），
        // 也可能是包名写错了（被回退掩盖）。逐条打出来，供人肉眼分辨。
        report.push(`  REPO-FALLBACK ${label} → ${found.full}`);
      }
      ok += 1;
    }
  }

  // 四字段完整性：每个 `## F…` 条目里四个字段各恰好一处。
  // 注意条目之外的**图例行**（顶部"每条按四字段登记：**现行值 / …**"）不计——它不在任何条目里。
  const entries = [];
  let currentEntry = null;
  for (const line of lines) {
    const heading = /^## (F\d+)/.exec(line);
    if (heading !== null) {
      currentEntry = { id: heading[1], counts: Object.fromEntries(FIELDS.map((f) => [f, 0])) };
      entries.push(currentEntry);
      continue;
    }
    if (currentEntry === null) continue;
    for (const field of FIELDS) if (line.includes(`**${field}`)) currentEntry.counts[field] += 1;
  }
  let fieldProblems = 0;
  for (const entry of entries) {
    const off = FIELDS.filter((f) => entry.counts[f] !== 1);
    if (off.length === 0) continue;
    fieldProblems += 1;
    report.push(`  FIELDS ${entry.id}：` + off.map((f) => `${f}=${String(entry.counts[f])}`).join('、'));
  }

  return {
    citations: citations.length,
    ok,
    viaRepoFallback,
    treeAbsent,
    hardErrors: bad + fieldProblems,
    fieldProblems,
    entryCount: entries.length,
    report
  };
}

// ── 命令行入口（只有直接运行时才执行）─────────────────────────────────────
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  function argOf(name, fallback) {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
  }

  const config = await loadLocalPlaneOrSkip('verify/check-facts-anchors.mjs（事实依据可解析性）');
  // 显式给了 `--facts` 就必须在（那是调用者的错）；没给就从本机侧的登记簿目录取，
  // 取不到按文档化跳过——CI 与外部 clone 上本来就没有登记簿。
  const factsArg = argOf('--facts', undefined);
  const FACTS = factsArg ?? join(config.root, LOCAL_DIR, 'docs', 'facts.md');
  if (!existsSync(FACTS)) {
    if (factsArg !== undefined) {
      console.error(`--facts 指的文件不存在：${FACTS}`);
      process.exit(2);
    }
    console.log(`SKIP verify/check-facts-anchors.mjs：本机侧的登记簿不在（${LOCAL_DIR}/docs/facts.md）`);
    console.log('     事实依据判据只对开发机上的登记簿有意义；CI 与外部 clone 上没有它，按跳过处理（不是失败）。');
    process.exit(0);
  }

  const TREE_020 = argOf('--tree020', config.evidenceTree['020']);
  const TREE_017 = argOf('--tree017', config.evidenceTree['017']);
  const TREE_015 = argOf('--tree015', config.evidenceTree['015']);

  console.log(`事实依据可解析性：${FACTS}`);
  console.log(`  0.2.0 树：${TREE_020 ?? '（无来源，该档跳过）'}`);
  console.log(`  0.1.7 树：${TREE_017 ?? '（无来源，该档跳过）'}`);
  console.log(`  0.1.5 树：${TREE_015 ?? '（无来源，该档跳过）'}`);
  const result = analyzeFacts(readFileSync(FACTS, 'utf8'), {
    tree020: TREE_020, tree017: TREE_017, tree015: TREE_015
  });
  for (const line of result.report) console.log(line);
  console.log(`\n引用 ${result.citations} 处：可解析 ${result.ok}（其中经本仓回退 ${result.viaRepoFallback}）、`
    + `树缺席跳过 ${result.treeAbsent}、硬错误 ${result.hardErrors}。`);
  console.log(`条目 ${result.entryCount} 条：四字段齐全 ${result.entryCount - result.fieldProblems}、不齐 ${result.fieldProblems}。`);
  console.log('注意：本检查器不判语义——行号在范围内不等于那行就是被引构造。');
  process.exitCode = result.hardErrors === 0 ? 0 : 1;
}
