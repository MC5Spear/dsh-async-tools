/**
 * 现行文档里引用的**具体文件路径**与 `npm run <脚本>` 必须真实存在。
 *
 * ## 为什么要有这条判据
 *
 * 交付树一旦收缩（删除一次性脚本、过程目录），公开文档若还在指它们——
 * 接手的人按图索骥全落空，悬空引用成片出现。
 *
 * `npm run <脚本>` 是同一类失效：`package.json` 里删掉了脚本项，
 * 而 `README.md` 与 `docs/design.md` 还在让人跑它们。一个"文档引用必须存在"的检查器
 * 能挡住这件事**每一个回合**，而不是等人工清点。
 *
 * ## 口径（三条，都要，否则会误报成灾）
 *
 * 1. **只查具体文件**：含通配符（`*`）、占位（`<...>`）、或本身就是目录名的引用跳过。
 * 2. **先归一化绝对路径**：文档里可能整段抄了某个绝对路径。不把仓根前缀剥掉，
 *    就会从中间切出 `tools/verify/x.mjs` 这种**假路径**（度量口径陷阱）。
 * 3. **只查现行文档**：历史档案记录当时的状态，指针本来就可能失效，不查。
 *
 * 豁免要**有名有姓**：见 `EXEMPT`，每条带理由。**空名单是健康状态**——公开范围文档
 * 本来就不该指向仓库外的文件；写不出来的路径，处置是改指向或删掉，不是加豁免。
 *
 * 用法：node tools/check-doc-paths.mjs
 *
 * ## 双入口形态
 *
 * `checkDocPaths(root)` 可导入（测试进程内调用，避免沙箱下 spawn EPERM 的假红）；
 * CLI 入口只在直接执行时生效。与 `tools/validate-preset.mjs` 同款分工。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 文档清单，与 `tools/check-docs.mjs` 的 `DOCUMENTS` 责任表**现行子集**同集——
 * 档案（CHANGELOG）零路径判据：历史档案记录当时的状态，指针本来就可能失效
 * （口径 #3「只查现行文档」的唯一例外来源就是它，干脆不进清单）。 */
const CURRENT = [
  'README.md',
  'README.en.md',
  'docs/user-reference.md',
  'docs/user-reference.en.md',
  'docs/documentation-principles.md',
  'docs/requirements.md',
  'docs/design.md',
  'verify/README.md',
  'CONTRIBUTING.md'
];

/** 本仓的顶层目录：只认这些开头的引用，避免把别处的路径算进来。 */
const KNOWN_TOP = ['verify', 'docs', 'tools', 'lib', 'test', 'presets'];

/**
 * 豁免：文档里确实写了、但**本仓内不该存在**的路径。每条必须带理由。
 *
 * 这不是"绕开检查"的口子：加一条之前先问"这个指针是不是该删/该改"。
 *
 * **现在是空的，而且空是健康状态**：公开范围文档按定义只能指向仓内文件——所有
 * "服务家的某个文件""部署现场的文件"一类指针都随本机侧一起离开了公开范围
 * （它们的去处是需求稿/设计稿里的**直述事实**，不是路径）。
 * 若将来确实需要一条，按 `{ why: string, status: 'ok' | 'skip' }` 的形状写——
 * `why` 是为什么这个指针不该存在，`status` 标**现在有没有被引用**
 * （没被引用的条目留着是给下一位写文档的人用的，但必须看得出来它当前是静默的）。
 */
const EXEMPT = new Map();

/** 明显不是"文件引用"的形态：通配、占位、纯目录、以及文档自身的相对写法。 */
const notAFilePath = (raw) => (
  raw.includes('*')
  || raw.includes('<')
  || raw.includes('…')
  || raw.endsWith('/')
);

// 匹配绝对路径（`D:\...` / `C:/...`），并保留两侧边界。
//
// 扩展名交替里**长的一定要排在前面**：写成 `js|json` 会把 `package.json` 截成
// `package.js`，于是检查器报一条根本不存在的悬空指针（度量口径陷阱）。
//
// 盘符前必须挡住词字符（`(?<![\w])`）：README 顶部的 CI badge 是
// `https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg`，
// 它**结尾带 `.yml`**、而 `https:` 的 `s:` 恰好长得像盘符。URL 必须带协议头，
// 方案名后面必然还是方案字符；真正的盘符前面只可能是行首/空白/引号/反引号
// 这类边界，绝不会是字母。按这个不变式挡。
const ABS_RE = /(?<![\w])[A-Za-z]:[\\/][^\s`'"()|,，。；;：:]+?\.(?:json|yaml|mjs|ps1|yml|js|md|png|txt|log)/g;

// 仓内**相对路径**（`verify/x.mjs`、`docs/y.md`）——文档里两种写法都有。
// 绝对路径与相对路径是同一类失效（`verify/mutate-doc-paths.mjs` 的 M1 守这条）。
// 相对写法同样会让读者按图索骥扑空，必须一起查。
const REL_RE = new RegExp(
  `(?<![\\w./\\\\-])((?:${KNOWN_TOP.join('|')})[\\\\/][^\\s\`'"()|,，。；;：:]*?\\.(?:json|yaml|mjs|ps1|yml|js|md|png|txt|log))`,
  'g'
);

// Markdown 链接按文档目录解析；尖括号与普通形式都参与检查。`REL_RE` 的负向后顾
// 把 `/` 前导路径排除，这种主流链接写法必须单列一趟——否则文档作者把引用改成
// 链接形态就整片脱离检查（本仓 design.md 的文件链接全部是这一形态）。
// 目标按文档所在目录解析（`../` 相对文档、不是相对仓根），锚点段（`#L24`）
// 剥离后查存在性；扩展名过滤与 EXEMPT 沿用同一套口径。
const MD_LINK_RE = /\]\((?:<([^<>]+)>|([^\s()]+))\)/g;

/** 链接目标是否落在要查的文件扩展名集合里（与 ABS_RE/REL_RE 的扩展名集一致）。 */
const hasKnownExtension = (raw) => /\.(?:json|yaml|mjs|ps1|yml|js|md|png|txt|log)$/i.test(raw);

/**
 * 跑一遍文档路径检查。
 *
 * @param {string} root - 仓库根。
 * @param {{quiet?: boolean}} [options] - `quiet:true` 时不向 stdout 打印（测试用）。
 * @returns {{ok: boolean, code: number, out: string, checked: number}} `checked` = 扫到的仓内引用数。
 */
export function checkDocPaths(root = MODULE_ROOT, { quiet = false } = {}) {
  const lines = [];
  const say = (line) => {
    lines.push(line);
    if (!quiet) console.log(line);
  };

  /** `package.json` 里真实存在的 npm 脚本（`npm run <脚本>` 的判据来源）。 */
  const NPM_SCRIPTS = new Set(
    Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {})
  );

  const problems = [];
  let checked = 0;
  let scriptsChecked = 0;
  let exempted = 0;

  for (const rel of CURRENT) {
    const file = join(root, rel);
    if (!existsSync(file)) { problems.push(`${rel}：现行文档本身不存在`); continue; }
    const text = readFileSync(file, 'utf8');

    for (const match of text.matchAll(ABS_RE)) {
      const raw = match[0].replace(/\\/g, '/').replace(/[.,;:]+$/, '');
      if (notAFilePath(raw)) continue;

      // 归一化：绝对路径 → 仓内相对路径；只认本仓的绝对路径。
      const lower = raw.toLowerCase();
      const rootPrefix = root.replace(/\\/g, '/').toLowerCase();
      let candidate = raw;
      if (lower.startsWith(`${rootPrefix}/`)) {
        candidate = raw.slice(rootPrefix.length + 1);
      } else if (/^[a-z]:\//i.test(raw)) {
        // 绝对路径但不在本仓：只认豁免名单，否则报出来（可能是笔误或已迁走的目录）。
        if (EXEMPT.has(raw)) { exempted += 1; continue; }
        problems.push(`${rel} → ${raw}（绝对路径，既不在本仓、也不在豁免名单里）`);
        continue;
      }
      if (notAFilePath(candidate)) continue;
      const top = candidate.split('/')[0];
      if (!KNOWN_TOP.includes(top)) continue;

      checked += 1;
      if (existsSync(join(root, candidate))) continue;
      if (EXEMPT.has(raw)) { exempted += 1; continue; }
      problems.push(`${rel} → ${candidate}`);
    }

    // ── 仓内相对路径（`verify/x.mjs`）─────────────────────────────────────────
    for (const match of text.matchAll(REL_RE)) {
      const raw = match[1].replace(/\\/g, '/').replace(/[.,;:]+$/, '');
      if (notAFilePath(raw)) continue;
      // 形如 `verify/` 的纯目录引用（没有文件名）由 `notAFilePath` 与正则一起挡掉。
      checked += 1;
      if (existsSync(join(root, raw))) continue;
      if (EXEMPT.has(raw)) { exempted += 1; continue; }
      problems.push(`${rel} → ${raw}`);
    }

    // ── markdown 链接（`[文字](<目标>)`）─────────────────────────────────────
    for (const match of text.matchAll(MD_LINK_RE)) {
      const target = (match[1] ?? match[2]).replace(/\\/g, '/').split('#')[0].replace(/[.,;:]+$/, '');
      if (target.length === 0 || notAFilePath(target) || !hasKnownExtension(target)) continue;
      if (/^[a-z]+:\/\//i.test(target)) continue; // 外链（https:// 等）不是仓内文件
      const resolved = resolve(dirname(file), target);
      // `resolve()` 归一：调用方传入的 root 可能带尾分隔符（变异脚本经
      // `fileURLToPath(new URL('..'))` 推根就会带），直接拼 `${root}/` 会把
      // 仓内目标误判成「仓外」。
      const rootNorm = resolve(root).replace(/\\/g, '/');
      const resolvedNorm = resolved.replace(/\\/g, '/');
      checked += 1;
      if (existsSync(resolved)) continue;
      if (EXEMPT.has(target)) { exempted += 1; continue; }
      // 解析后仍在仓外的绝对目标与 ABS_RE 同款处置：报出来，不静默。
      problems.push(
        resolvedNorm.startsWith(`${rootNorm}/`)
          ? `${rel} → ${target}（链接目标不存在）`
          : `${rel} → ${target}（链接目标在本仓之外）`
      );
    }

    // ── npm 脚本（`npm run <脚本>`）───────────────────────────────────────────
    //
    // 与路径同一类失效：脚本删了、文档还在让人跑它。探针类脚本被清理时
    // README 与 design.md 里的对应指引就会悬空。
    //
    // 字符类**必须含 `-`**：脚本名常用连字符（`test:offline`、`final-acceptance`）。
    // 写成 `[a-z0-9:]*` 会把 `check:docs-typo-…` 截成 `check:docs`
    // （存在 ⇒ 通过），**带连字符的名字整个漏检**——变异一跑就露馅了。
    for (const match of text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
      scriptsChecked += 1;
      if (NPM_SCRIPTS.has(match[1])) continue;
      problems.push(`${rel} → npm run ${match[1]}（package.json 里没有这个脚本）`);
    }
  }

  say(`现行文档里的仓内文件引用：检查 ${String(checked)} 处，豁免命中 ${String(exempted)} 处（名单共 ${String(EXEMPT.size)} 条）。`);
  say(`现行文档里的 npm 脚本引用：检查 ${String(scriptsChecked)} 处（package.json 共 ${String(NPM_SCRIPTS.size)} 个脚本）。`);
  say('豁免名单（每条标注现在有没有被引用）：');
  for (const [path, entry] of EXEMPT) {
    say(`  ${path}`);
    say(`      ${entry.why}`);
    say(`      —— ${entry.status}`);
  }
  say('');

  let ok;
  if (problems.length > 0) {
    say(`**${String(problems.length)} 处悬空指针**（读者按图索骥会扑空）：`);
    for (const p of problems) say(`  ${p}`);
    say('');
    say('处置：改指向新落点，或删掉这个指针——**不要**把它加进豁免名单来消音。');
    ok = false;
  } else if (checked === 0) {
    // 「一处都没扫到」和「扫过且都对」是两件事。不区分的话，正则被改坏会让它永远绿，
    // 而绿得毫无信息量——**空转检查器**形态。
    say('**一处引用都没扫到**——要么现行文档里真的没有路径引用（几乎不可能），');
    say('要么提取规则坏了。这一条按失败处理，别把它读成"检查通过"。');
    ok = false;
  } else {
    say('现行文档里引用的本仓文件全部存在。');
    ok = true;
  }
  return { ok, code: ok ? 0 : 1, out: lines.join('\n'), checked };
}

// CLI 入口：只在直接执行时生效。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(checkDocPaths(MODULE_ROOT).code);
}
