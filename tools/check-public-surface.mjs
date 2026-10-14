/**
 * 公开范围边界检查器。
 *
 * ## 它挡什么
 *
 * 本公开范围包括产品代码、测试与工具、需求稿与设计稿、verify 脚本；
 * 本机材料（`.local/`）不由本公开仓跟踪。两类错误会破坏这个边界：
 *
 * 1. **本机事实漏进公开范围**——机器路径、实例端口、服务名、用户名。它们不会让任何测试
 *    变红，只会在推上 GitHub 之后把开发机的样子泄露出去。
 * 2. **公开文档引用未公开内容**——读者点开需求稿，里面写着"见 `docs/facts.md` F65"，
 *    而 `facts.md` 不在仓库里。文档于是**不可读**，这是自包含原则要挡的。
 *
 * 一次性的人工清查不会在下一次提交时继续生效。本检查器把判据固化成常驻的，
 * 进 `npm run check` 与 CI——加一行代码、改一句文档，它当场红。
 *
 * ## 三类判据
 *
 * - **结构**：`.gitignore` 必须有 `.local/` 条目；非注释条目**只能**是本表登记的这几条
 *   （规则 1「单一例外目录」：新文件诞生即定归属，不再新增零散 ignore 条目）；`.local/` 这个
 *   字面只许出现在配置加载器、它的形状示例、以及本检查器自己的变异脚本里。
 * - **本机指纹零命中**：全部进入公开范围的文件逐个扫指纹表（每条带理由）。
 * - **内部引用零命中**：公开文档（`.md`）扫内部引用表——下沉的语料文件名、事实编号、
 *   过程稿名、历史运行产物路径。
 *
 * ## 为什么不用 `git ls-files`
 *
 * 两条理由，都不是洁癖：
 *
 * 1. **沙箱**：默认沙箱下子进程管道捕获一律 EPERM
 *    （`verify/README.md`「判据必须在默认权限下可跑」一节）。`git ls-files` 要么起子进程
 *    捕获输出（判据的红绿只反映权限），要么把输出写进临时文件（多一个可失败环节）。
 * 2. **遍历跳过表可以从 `.gitignore` 自己推导**——前提是 `.gitignore` 真的只有那几条。
 *    于是"遍历范围"与"忽略规则"不可能各说各话，而这条前提本身就是结构判据的一部分。
 *
 * 代价是**未被忽略的未跟踪文件也会被扫**。这是**有意的**：一个还没 `git add` 的新文件
 * 正是最可能带着本机路径溜进公开范围的东西；等它被跟踪才拦，已经晚了一步。
 *
 * ## 双入口形态
 *
 * `checkPublicSurface(root, {quiet})` 是可导入函数（测试与变异脚本进程内调用，不起子进程）；
 * CLI 入口只在直接执行时生效。与 `tools/check-docs.mjs` / `tools/validate-preset.mjs` 同款分工。
 *
 * 用法：`node tools/check-public-surface.mjs [--list]`
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 本机侧的目录名。 */
const LOCAL_DIR = '.local';

/**
 * `.gitignore` 允许出现的**非注释条目全集**。
 *
 * 规则 1「单一例外目录」的机械落点：本仓对本机内容只有 `.local/` 一条，外加运行期必需的
 * `node_modules/` 与编辑器产物。多出一条就红——零散 ignore 条目会让"这东西属于哪一层"
 * 变成一件要靠记忆回答的事。
 */
const GITIGNORE_ALLOWED = new Set([`${LOCAL_DIR}/`, 'node_modules/', '.vscode/', 'Thumbs.db', 'Desktop.ini']);

/** 本机指纹表：每条都带"为什么它不该出现在公开范围"。 */
const FINGERPRINTS = [
  // ⚠️ 分隔符要用 `[\\/]+`（一个或多个）而不是 `[\\/]`：**JS 源码里的 Windows 路径是转义的**，
  // 写成 `'D:\\P\\dsh-x'` 时源文本里是 `D:\\P\\dsh-x`——两个反斜杠。只认单个分隔符会让
  // "可执行代码里的本机绝对路径"整类**漏检**（注释里是单反斜杠、字符串里是双反斜杠，
  // 两种形态都得抓）。
  // ⚠️ 盘根目录名之后也不能只认分隔符：裸写盘根（后随标点、引号或行尾；转义形态
  // `'D:\\P'` 引号紧随）会整类漏检。
  // 尾随断言改成「分隔符、非词字符或行尾」任一即中；词字符紧随（`C:\Program
  // Files` 的 `Pr`）不算，避免把浏览器安装路径误伤成本机盘根。
  { pattern: /[A-Z]:[\\/]+P(?=\W|$)/i, why: '本机开发盘路径（D:\\P\\… 与裸 D:\\P 都算）' },
  { pattern: /[A-Z]:[\\/]+Users[\\/]+user\b/i, why: '本机用户目录（含用户名）' },
  { pattern: /\b38114\b/, why: '本机验证实例端口' },
  { pattern: /\b38200\b/, why: '本机开发实例端口' },
  { pattern: /\b38192\b|\b38193\b|\b38194\b|\b38195\b/, why: '本机一次性探针实例端口' },
  // ⚠️ 服务名要**整体**匹配：`dsh-web-app` / `dsh-webhook` / `dsh-web-fetch-http` 是上游
  // 公开包名，按子串匹配会把它们误判成本机指纹（一次能误报 30+ 条）。
  // 判据是"它是不是这台机器的服务名"，所以边界必须挡住 `-` 与词字符。
  { pattern: /(?<![\w-])dsh-web(?![\w-])/, why: '本机 NSSM 服务名（整体匹配；dsh-web-app 等上游包名不算）' },
  { pattern: /(?<![\w-])dsh-service(?![\w-])/, why: '本机服务家目录名' },
  { pattern: /DESKTOP-[A-Z0-9]{4,}/i, why: '本机机器名前缀' }
];

/** 内部引用表：只扫公开文档（`.md`）。 */
const INTERNAL_REFS = [
  { pattern: /facts\.md/, why: '事实登记簿（已下沉 .local/docs/）' },
  { pattern: /\bF\d{1,3}\b/, why: '事实编号引用（登记簿不下沉则读者解不开）' },
  { pattern: /DELIVERY/, why: '交付索引（已下沉）' },
  {
    pattern: /(impl-review|design-review|impl-corrections|doc-audit|requirements-review|research-r\d)/,
    why: '过程稿文件名（审查/修正/审计/调研稿，已下沉）'
  },
  { pattern: /e2e-\d{5}/, why: '过程稿文件名（内含实例端口，双重违规）' },
  { pattern: /INCIDENT/, why: '事故记录（已下沉）' },
  { pattern: /verify[\\/](logs|shots)/, why: '历史运行产物路径（证据已下沉 .local/evidence/）' }
];

/**
 * 豁免名单：**文件 → 理由**。每条都必须真的存在，且必须真的用得上
 * （登记了却零命中的豁免是名单烂了，按红处理——同 `tools/check-mutate-index.mjs` 的口径）。
 *
 * **导出**是给测试与变异证明用的：它们要在一棵合成树上复现"干净的树"，
 * 就得知道该铺哪些文件；让它们各自抄一份名单，迟早会与这里漂开。
 */
export const PUBLIC_SURFACE_ALLOWLIST = new Map([
  ['.gitignore', '结构判据**要求**它含 `.local/` 条目——本条是那一行的落点，不是漏网'],
  ['tools/check-public-surface.mjs', '本检查器自身：指纹表与引用表的模式字面量就长在这里'],
  ['verify/mutate-public-surface.mjs', '本检查器的变异证明：必须种下指纹与内部引用才能证明它会红'],
  ['tools/_local-config.mjs', '配置加载器：`.local/` 字面量是它的输入契约'],
  ['tools/local-config.example.mjs', '配置形状示例：教读者把真件放在 `.local/config.mjs`'],
  ['test/public-surface.test.mjs', '本检查器的单测：合成语料里带指纹与内部引用'],
  ['test/tools-paths.test.mjs', '判据要写出"什么算盘符字面量"，被禁形态本身必须举出来']
]);

/** 文档扩展名（内部引用判据只扫这些）。 */
const DOC_EXTENSIONS = new Set(['.md', '.markdown']);

/** 永远不进公开范围遍历的目录（`.git` 是版本库元数据，不是内容）。 */
const ALWAYS_SKIP = new Set(['.git']);

/**
 * 去掉块注释与行注释。
 *
 * 两个判据要用它：① `.local/` 字面量只管**代码**——注释里写"配置在某某目录下"
 * 是在解释机制，不是在读本机事实；② 盘符字面量的口径同理（见 `test/tools-paths.test.mjs`）。
 *
 * 局限（如实声明）：行注释的规则是"`//` 到行尾"，因此**字符串里的 `//`**（URL）
 * 会把它后面的内容一起切掉。对本检查器要判的东西没有影响（被切掉的只会是同一行
 * 的后半段），但它不是通用的 JS 词法器——别拿它当解析器用。
 *
 * @param {string} text - 源码全文。
 * @returns {string} 去掉注释后的文本（行数不变，便于按行定位）。
 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '');
}

/**
 * 从 `.gitignore` 推导遍历跳过表。
 *
 * 只有以 `/` 结尾或没有扩展名的条目才当目录跳过——判据与 `.gitignore` 自己的语义一致。
 *
 * @param {string} ignoreText - `.gitignore` 全文。
 * @returns {Set<string>} 目录名集合（相对仓根的第一段）。
 */
function skipDirsFrom(ignoreText) {
  const skip = new Set(ALWAYS_SKIP);
  for (const raw of ignoreText.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('!')) continue;
    const name = line.replace(/\/$/, '');
    if (name.includes('/') || name.includes('*')) continue;
    if (line.endsWith('/') || extname(name) === '') skip.add(name);
  }
  return skip;
}

/**
 * 遍历仓库，收集参与判据的文件。
 *
 * @param {string} root - 仓根。
 * @param {Set<string>} skip - 目录跳过表。
 * @returns {string[]} 相对仓根的路径（`/` 分隔），按字典序。
 */
function walk(root, skip) {
  /** @type {string[]} */
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        visit(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(relative(root, join(dir, entry.name)).split(sep).join('/'));
      }
    }
  };
  visit(root);
  return out.sort();
}

/**
 * 跑一遍公开范围边界检查。
 *
 * @param {string} [root] - 仓根。
 * @param {{ quiet?: boolean, scope?: string[] }} [options] - `quiet:true` 时不向 stdout 打印（测试用）；
 *   `scope` 是路径前缀白名单（只查这些前缀下的文件）——**给迁移期分块作业用**，
 *   CI 与 `npm run check` 一律不传（默认全扫）。空数组等于不查，故用 `undefined` 表示全扫。
 * @returns {{ ok: boolean, code: number, out: string, scanned: number, binarySkipped: number,
 *   findings: Array<{ file: string, family: string, line: number, text: string, why: string }> }}
 *   `findings` = 逐条命中（变异脚本与单测直接吃它，不必解析输出文本）。
 */
export function checkPublicSurface(root = MODULE_ROOT, { quiet = false, scope } = {}) {
  const lines = [];
  const say = (line) => {
    lines.push(line);
    if (!quiet) console.log(line);
  };
  /** @type {Array<{ file: string, family: string, line: number, text: string, why: string }>} */
  const findings = [];
  const note = (file, family, line, text, why) => {
    findings.push({ file, family, line, text: text.trim().slice(0, 160), why });
  };

  // ── 结构判据 ──────────────────────────────────────────────────────────────
  const ignorePath = join(root, '.gitignore');
  let ignoreText = '';
  if (!existsSync(ignorePath)) {
    note('.gitignore', '结构', 0, '', '`.gitignore` 不存在——两个层无从区分');
  } else {
    ignoreText = readFileSync(ignorePath, 'utf8');
    const entries = ignoreText.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    if (!entries.includes(`${LOCAL_DIR}/`)) {
      note('.gitignore', '结构', 0, '', `缺 \`${LOCAL_DIR}/\` 条目——本机侧会漏进版本库`);
    }
    for (const entry of entries) {
      if (!GITIGNORE_ALLOWED.has(entry)) {
        note('.gitignore', '结构', 0, entry,
          '零散 ignore 条目：本机内容一律归 `.local/`，不再为单个目录开口子（规则 1「一扇门」）');
      }
    }
  }

  // ── 逐文件扫 ──────────────────────────────────────────────────────────────
  const skip = skipDirsFrom(ignoreText);
  const files = walk(root, skip)
    .filter((file) => scope === undefined || scope.some((prefix) => file.startsWith(prefix)));
  let binarySkipped = 0;

  for (const file of files) {
    const abs = join(root, file);
    let text;
    try {
      const stat = statSync(abs);
      if (stat.size > 4 * 1024 * 1024) { binarySkipped += 1; continue; }
      text = readFileSync(abs, 'utf8');
    } catch {
      binarySkipped += 1;
      continue;
    }
    // NUL 字节 = 二进制（截图、字体、归档）。二进制里可能嵌着可见文本，
    // 但本仓公开范围不该有二进制，真有的话由结构判据另行处理。
    if (text.includes('\u0000')) { binarySkipped += 1; continue; }

    const exempt = PUBLIC_SURFACE_ALLOWLIST.has(file);
    const textLines = text.split('\n');
    const isDoc = DOC_EXTENSIONS.has(extname(file).toLowerCase());

    for (let i = 0; i < textLines.length; i += 1) {
      const line = textLines[i];
      if (exempt) break; // 豁免文件整个跳过两类内容判据
      for (const rule of FINGERPRINTS) {
        if (rule.pattern.test(line)) note(file, '指纹', i + 1, line, rule.why);
      }
      if (isDoc) {
        for (const rule of INTERNAL_REFS) {
          if (rule.pattern.test(line)) note(file, '引用', i + 1, line, rule.why);
        }
      }
    }

    // `.local/` 字面量：只有配置加载器与它的示例/证明可以写。
    //
    // ⚠️ 只查**代码本体**（剥掉注释）：注释里解释"配置落在哪个目录"是在讲机制，
    // 不是在读本机事实。不剥的话，每个想告诉读者配置在哪的模块都得进豁免名单——
    // 那名单会迅速变成"所有提到了机制的文件"，判据也就废了。
    if (!exempt && !isDoc && stripComments(text).includes(`${LOCAL_DIR}/`)) {
      const stripped = stripComments(text).split('\n');
      const lineNo = stripped.findIndex((l) => l.includes(`${LOCAL_DIR}/`)) + 1;
      note(file, '结构', lineNo, stripped[lineNo - 1] ?? '',
        '`.local/` 字面量在**代码里**只许出现在配置加载器、其形状示例与本检查器的变异证明里——'
        + `其余脚本一律经 \`tools/_local-config.mjs\` 取本机事实（要写路径就用它导出的 \`LOCAL_DIR\` 拼）`);
    }
  }

  // 豁免名单自身的两条守卫：条目要在盘上，且**真的用得上**（零命中 = 名单烂了）。
  for (const [file, why] of PUBLIC_SURFACE_ALLOWLIST) {
    if (!existsSync(join(root, file))) {
      note(file, '结构', 0, '', `豁免名单里有它但盘上不存在（名单该清）：${why}`);
    }
  }

  // ── 输出 ──────────────────────────────────────────────────────────────────
  const byFamily = { 结构: [], 指纹: [], 引用: [] };
  for (const finding of findings) byFamily[finding.family].push(finding);

  for (const family of ['结构', '指纹', '引用']) {
    const list = byFamily[family];
    say(`${list.length === 0 ? 'OK  ' : 'WARN'} ${family.padEnd(4)} ${String(list.length).padStart(4)} 处`);
    for (const finding of list.slice(0, 60)) {
      say(`       ${finding.file}:${String(finding.line)}  ${finding.why}`);
      if (finding.text.length > 0) say(`         | ${finding.text}`);
    }
    if (list.length > 60) say(`       …另有 ${String(list.length - 60)} 处（同上表，未逐条展开）`);
  }
  say('');
  say(`扫过 ${String(files.length)} 个文件（跳过二进制/超大 ${String(binarySkipped)} 个）；`
    + `豁免 ${String(PUBLIC_SURFACE_ALLOWLIST.size)} 个文件（逐条带理由）。`);
  say(findings.length === 0
    ? '公开范围边界检查通过：结构合规、指纹零命中、内部引用零命中。'
    : `公开范围边界检查不通过：${String(findings.length)} 处命中。`);

  return {
    ok: findings.length === 0,
    code: findings.length === 0 ? 0 : 1,
    out: lines.join('\n'),
    scanned: files.length,
    binarySkipped,
    findings
  };
}

// CLI 入口：只在直接执行时生效（测试以 `checkPublicSurface(root)` 导入，不触发）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `--list`：不打印人类可读报告，只把命中逐条打成一列 TSV（便于机器消费与计数）。
  const wantList = process.argv.includes('--list');
  const scope = process.argv
    .map((arg, i) => (arg === '--scope' ? process.argv[i + 1] : undefined))
    .filter((value) => typeof value === 'string' && value.length > 0);
  const result = checkPublicSurface(MODULE_ROOT, { quiet: wantList, scope: scope.length === 0 ? undefined : scope });
  if (wantList) {
    for (const finding of result.findings) {
      console.log(`${finding.family}\t${finding.file}:${String(finding.line)}\t${finding.why}\t${finding.text}`);
    }
  }
  process.exit(result.code);
}
