/**
 * `tools/check-public-surface.mjs` 的变异证明：三类判据都必须能被"改坏"打成红。
 *
 * ## 为什么在合成树上变异，而不是改真仓
 *
 * 检查器的判据是"这棵树里有没有本机事实"。要证明它能红，最直白的做法是往真仓里种一条
 * `D:\P\…`——但那正是**判据禁止的事**，而且真仓此刻可能正被别的会话用着。
 * 所以这里铺一棵**合成树**（`.gitignore` + 几个源文件 + 一份文档 + 豁免名单对应的占位文件），
 * 在它上面逐条变异。
 *
 * 合成树还带来一个好处：每条判据的"红"都能精确归因到它自己——真仓里一红往往是七八条
 * 判据同时命中，看不出是哪一条在起作用。
 *
 * ## 为什么进程内调用
 *
 * 本仓的既有教训：默认沙箱下**子进程管道捕获一律 EPERM**，靠 `spawnSync` 读检查器 stdout
 * 的变异脚本会稳定报出假红（`verify/mutate-facts-anchors.mjs` 就是这么被咬的）。
 * `checkPublicSurface(root, {quiet})` 是可导入函数，直接吃返回值里的 `findings`。
 *
 * 用法：`node verify/mutate-public-surface.mjs`
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPublicSurface, PUBLIC_SURFACE_ALLOWLIST } from '../tools/check-public-surface.mjs';

/**
 * 与检查器的豁免名单对齐：合成树里必须有这些文件，否则"名单该清"会让基线变红。
 *
 * **从检查器 import 而不是抄一份**——抄的那份迟早与它漂开，而漂开的后果是
 * 变异证明在一棵"永远差一个文件"的树上跑，基线恒红、谁也不再信它。
 */
const ALLOWLISTED_FILES = [...PUBLIC_SURFACE_ALLOWLIST.keys()];

/** 合成树里那份"干净"的 `.gitignore`。 */
const CLEAN_IGNORE = [
  '# 本机平面的唯一例外目录',
  '.local/',
  '',
  'node_modules/',
  '.vscode/',
  'Thumbs.db',
  'Desktop.ini',
  ''
].join('\n');

/** 一份干净的源码与一份干净的公开文档。 */
const CLEAN_SOURCE = 'export const answer = 42;\n';
const CLEAN_DOC = '# 合成文档\n\n这份文档不该引用任何未公开内容。\n';

/**
 * 铺一棵合成树。
 *
 * @param {{ ignore?: string, source?: string, doc?: string, extra?: Record<string, string>,
 *   skipAllowlisted?: string }} [patch]
 *   各文件的覆盖内容；`extra` 是额外落盘的文件（相对路径 → 内容）；
 *   `skipAllowlisted` 指定一个**不落盘**的豁免名单文件（用来制造"名单该清"）。
 * @returns {{ root: string, cleanup: () => void }} 根目录与清理函数。
 */
function sandbox(patch = {}) {
  const root = mkdtempSync(join(tmpdir(), 'surface-'));
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  };
  for (const file of ALLOWLISTED_FILES) {
    if (file === patch.skipAllowlisted) continue;
    put(file, '');
  }
  put('.gitignore', patch.ignore ?? CLEAN_IGNORE);
  put('lib/index.js', patch.source ?? CLEAN_SOURCE);
  put('docs/design.md', patch.doc ?? CLEAN_DOC);
  for (const [rel, text] of Object.entries(patch.extra ?? {})) put(rel, text);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 跑一次合成树上的检查器。 */
const run = (root) => checkPublicSurface(root, { quiet: true });

let uncaught = 0;

/**
 * 一条变异：改坏 → 必须出现指定家族、指定理由的命中。
 *
 * @param {{ name: string, family: string, why: RegExp, patch: object }} spec - 变异规格。
 */
function mutation({ name, family, why, patch }) {
  const box = sandbox(patch);
  try {
    const result = run(box.root);
    const hit = result.findings.filter((f) => f.family === family && why.test(f.why));
    const ok = hit.length > 0;
    if (!ok) uncaught += 1;
    console.log(`${ok ? 'CAUGHT  ' : 'UNCAUGHT'} ${name}`);
    console.log(`          命中 ${String(result.findings.length)} 处，其中「${family}」家族匹配期望理由 ${String(hit.length)} 处`);
    if (!ok) {
      console.log('          实际命中：');
      for (const f of result.findings.slice(0, 6)) {
        console.log(`            ${f.family} ${f.file}:${String(f.line)} ${f.why}`);
      }
    }
  } finally {
    box.cleanup();
  }
}

/**
 * 一条**负向**用例：这个形态**不该**被报出来。
 *
 * 假阳性与漏报一样致命——一个动不动就红的检查器会被绕过或被塞满豁免。
 * 本检查器第一版就误报过 30+ 条：`dsh-web` 按子串匹配，把上游公开包名
 * `dsh-web-app` / `dsh-webhook` 全当成了本机服务名。
 *
 * @param {{ name: string, patch: object }} spec - 用例规格。
 */
function negative({ name, patch }) {
  const box = sandbox(patch);
  try {
    const result = run(box.root);
    const ok = result.findings.length === 0;
    if (!ok) uncaught += 1;
    console.log(`${ok ? 'CLEAN   ' : 'FALSE-POSITIVE'} ${name}`);
    for (const f of result.findings.slice(0, 4)) {
      console.log(`            ${f.family} ${f.file}:${String(f.line)} ${f.why}`);
    }
  } finally {
    box.cleanup();
  }
}

// ── 基线：干净合成树必须零命中 ────────────────────────────────────────────────
{
  const box = sandbox();
  try {
    const result = run(box.root);
    const ok = result.findings.length === 0;
    if (!ok) uncaught += 1;
    console.log(`${ok ? 'BASELINE-GREEN' : 'BASELINE-RED  '} 干净合成树必须零命中（防恒真）`);
    for (const f of result.findings.slice(0, 6)) {
      console.log(`            ${f.family} ${f.file}:${String(f.line)} ${f.why}`);
    }
  } finally {
    box.cleanup();
  }
}

// ── M1–M2：本机指纹 ──────────────────────────────────────────────────────────
mutation({
  name: 'M1 源码里种下本机开发盘路径 → 必须报「指纹」',
  family: '指纹',
  why: /开发盘路径/,
  // ⚠️ 用**双反斜杠**写：JS 源码里的 Windows 路径是转义的，判据必须认这一个形态。
  // 第一版判据只认单反斜杠，于是"可执行代码里的本机绝对路径"整类漏检。
  patch: { source: "export const P = 'D:\\\\P\\\\somewhere\\\\repo';\n" }
});

mutation({
  name: 'M1-b 源码里种下裸盘根（转义形态、引号紧随）→ 必须报「指纹」',
  family: '指纹',
  why: /开发盘路径/,
  // 第二代盲区（发布前盲审抓到）：盘根后不再跟分隔符，旧判据的 `P[\\/]` 尾部
  // 要求让 `'D:\\P'`（引号收尾）整类漏检——公开面夹具里留过真残留。
  patch: { source: "export const P = 'D:\\\\P';\n" }
});

mutation({
  name: 'M1-c 注释里种下裸盘根（行尾收尾）→ 必须报「指纹」',
  family: '指纹',
  why: /开发盘路径/,
  patch: { source: '// 服务就装在 D:\\P\n' }
});

mutation({
  name: 'M2 文档里种下验证实例端口 → 必须报「指纹」',
  family: '指纹',
  why: /验证实例端口/,
  patch: { doc: '# 合成文档\n\n探针连的是 127.0.0.1:38114 那台。\n' }
});

negative({
  name: 'N1 上游公开包名 `dsh-web-app` / `dsh-webhook` 不得被误判成本机服务名',
  patch: { source: "export const a = '@deepseek-ai/dsh-web-app';\nexport const b = '@deepseek-ai/dsh-webhook';\n" }
});

negative({
  name: 'N2 `https://…` 不得被误判成本机盘符路径',
  patch: { source: "export const u = 'https://registry.npmjs.org/x';\n" }
});

negative({
  name: 'N4 兄弟仓公开仓的 URL 不得被误判成指纹（两仓互挂地址，名字指纹已除名）',
  patch: { doc: '# 合成文档\n\n样式照兄弟仓 approve-for-me（https://github.com/MC5Spear/dsh-approve-for-me）的做法。\n' }
});

// ── M3–M4：内部引用（只扫文档） ──────────────────────────────────────────────
mutation({
  name: 'M3 公开文档引用下沉语料 → 必须报「引用」',
  family: '引用',
  why: /事实登记簿/,
  patch: { doc: '# 合成文档\n\n依据见 `docs/facts.md`。\n' }
});

mutation({
  name: 'M4 公开文档引用事实编号 → 必须报「引用」',
  family: '引用',
  why: /事实编号/,
  patch: { doc: '# 合成文档\n\n这条结论来自 F65。\n' }
});

negative({
  name: 'N3 同一串引用形态出现在**源码**里不报「引用」（那一族只扫文档）',
  patch: { source: "export const note = '见 docs/facts.md 的 F65';\n" }
});

// ── M5–M8：结构 ──────────────────────────────────────────────────────────────
mutation({
  name: 'M5 `.gitignore` 缺 `.local/` → 必须报「结构」',
  family: '结构',
  why: /缺 .*条目/,
  patch: { ignore: 'node_modules/\n' }
});

mutation({
  name: 'M6 `.gitignore` 多出一条零散条目 → 必须报「结构」',
  family: '结构',
  why: /零散 ignore 条目/,
  patch: { ignore: `${CLEAN_IGNORE}some/scratch-dir/\n` }
});

mutation({
  name: 'M7 非豁免源码里写 `.local/` 字面量 → 必须报「结构」',
  family: '结构',
  why: /只许出现在配置加载器/,
  patch: { extra: { 'lib/paths.js': "export const dir = '.local/evidence';\n" } }
});

mutation({
  name: 'M8 豁免名单登记了盘上不存在的文件 → 必须报「结构」',
  family: '结构',
  why: /名单该清/,
  patch: { skipAllowlisted: 'tools/_local-config.mjs' }
});

console.log(`\n${uncaught === 0 ? '全部变异都被抓住（10/10 + 基线 + 4 条假阳性）' : `${String(uncaught)} 处没被抓住`}`);
process.exitCode = uncaught === 0 ? 0 : 1;
