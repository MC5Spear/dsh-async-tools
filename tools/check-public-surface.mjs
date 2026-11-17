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
 *   字面在代码里的豁免位置以 `PUBLIC_SURFACE_ALLOWLIST` 为准（配置加载器、形状示例、
 *   变异脚本、本检查器自身与两个单测）。
 * - **本机指纹零命中**：全部进入公开范围的文件逐个扫指纹表（每条带理由）。
 * - **内部引用零命中**：公开文档（`.md`）扫内部引用表——下沉的语料文件名、事实编号、
 *   过程稿名、历史运行产物路径。
 *
 * ## 为什么不用 `git ls-files`
 *
 * 两条理由，都不是洁癖：
 *
 * 1. **沙箱**：默认沙箱下子进程管道捕获一律 EPERM
 *    （`verify/README.md`「优先默认权限执行；纯函数判断尽量进程内复用」要点）。`git ls-files` 要么起子进程
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
 * 本机材料位于 `.local/`，隔离的源码工作树位于 `.worktrees/`；两者均不随产品分发。
 * 其余条目限定为依赖和编辑器产物，避免遗漏新目录的公开范围判断。
 */
const GITIGNORE_ALLOWED = new Set([`${LOCAL_DIR}/`, '.worktrees/', 'node_modules/', '.vscode/', 'Thumbs.db', 'Desktop.ini']);

/** 本机指纹表：每条都带"为什么它不该出现在公开范围"。 */
const FINGERPRINTS = [
  // 分隔符要用 `[\\/]+`（一个或多个）而不是 `[\\/]`：**JS 源码里的 Windows 路径是转义的**，
  // 写成 `'D:\\P\\dsh-x'` 时源文本里是 `D:\\P\\dsh-x`——两个反斜杠。只认单个分隔符会让
  // "可执行代码里的本机绝对路径"整类**漏检**（注释里是单反斜杠、字符串里是双反斜杠，
  // 两种形态都得抓）。
  // 盘根目录名之后也不能只认分隔符：裸写盘根（后随标点、引号或行尾；转义形态
  // `'D:\\P'` 引号紧随）会整类漏检。
  // 尾随断言改成「分隔符、非词字符或行尾」任一即中；词字符紧随（`C:\Program
  // Files` 的 `Pr`）不算，避免把浏览器安装路径误伤成本机盘根。
  { pattern: /[A-Z]:[\\/]+P(?=\W|$)/i, why: '本机开发盘路径（D:\\P\\… 与裸 D:\\P 都算）' },
  { pattern: /[A-Z]:[\\/]+Users[\\/]+user\b/i, why: '本机用户目录（含用户名）' },
  { pattern: /\b38114\b/, why: '本机验证实例端口' },
  { pattern: /\b38200\b/, why: '本机开发实例端口' },
  { pattern: /\b38192\b|\b38193\b|\b38194\b|\b38195\b/, why: '本机一次性探针实例端口' },
  // 服务名要**整体**匹配：`dsh-web-app` / `dsh-webhook` / `dsh-web-fetch-http` 是上游
  // 公开包名，按子串匹配会把它们误判成本机指纹（一次能误报 30+ 条）。
  // 判据是"它是不是这台机器的服务名"，所以边界必须挡住 `-` 与词字符。
  //
  // 官方 scope 下的同名包（`@deepseek-ai/dsh-web`）同样是**已发布的公开包**：`npm install`
  // 生成的 `package-lock.json` 会在包键、依赖值、`node_modules/` 路径与 registry URL 里
  // 引用它，按官方 scope 区分即可。只排除"紧邻已知官方 scope 前缀"这一种上下文——裸
  // `dsh-web`、其他 scope 下的同名包、本机服务目录路径照旧按红处理。
  {
    pattern: /(?<![\w-])(?<!@deepseek-ai[\/\\])dsh-web(?![\w-])/,
    why: '本机 NSSM 服务名（整体匹配；`dsh-web-app` 等上游包名与 `@deepseek-ai/dsh-web` 官方包不算）'
  },
  { pattern: /(?<![\w-])dsh-service(?![\w-])/, why: '本机服务家目录名' },
  { pattern: /DESKTOP-[A-Z0-9]{4,}/i, why: '本机机器名前缀' }
];

/**
 * 连字符词元的字符集（ASCII 字母/数字/连字符）。CJK 等其他字符截断词元，
 * 所以 `见-F07` 的词元是 `-F07`，天然不是公开稳定 ID 形状。
 */
const TOKEN_CHAR = /[A-Za-z0-9-]/;

/** 公开稳定 ID 的词元形状：每段 ≥2 位大写字母数字（`WAIT-F02`、`DOC-DELIVERY-COMMENTS`）。 */
const PUBLIC_ID_TOKEN = /^(?:[A-Z0-9]{2,})(?:-[A-Z0-9]{2,})*$/;

/**
 * 取 `index` 所在的完整连字符词元（向左右扩张到非词元字符为止）。
 *
 * @param {string} line - 所在行。
 * @param {number} index - 关键词起始下标。
 * @returns {{ token: string, offsetInToken: number }} 词元全文与关键词在词元内的偏移。
 */
function tokenAround(line, index) {
  let start = index;
  while (start > 0 && TOKEN_CHAR.test(line[start - 1])) start -= 1;
  let end = index;
  while (end < line.length && TOKEN_CHAR.test(line[end])) end += 1;
  return { token: line.slice(start, end), offsetInToken: index - start };
}

/**
 * 一次关键词命中是否落在公开稳定 ID 的**非首段**（`WAIT-F02` 的 `F02`、
 * `DOC-DELIVERY-COMMENTS` 的 `DELIVERY`）：词元整体符合公开 ID 形状，且关键词
 * 之前在同一词元内已有完整前段。满足才豁免。
 *
 * @param {string} line - 所在行。
 * @param {number} index - 关键词起始下标。
 * @returns {boolean} 豁免才 `true`。
 */
function insidePublicId(line, index) {
  const { token, offsetInToken } = tokenAround(line, index);
  if (!PUBLIC_ID_TOKEN.test(token)) return false;
  const prefix = token.slice(0, offsetInToken);
  return prefix.endsWith('-') && PUBLIC_ID_TOKEN.test(prefix.slice(0, -1));
}

/**
 * 数一行里的内部引用命中次数：`keywordRe` 逐次匹配，只统计**词元段边界**上的
 * 命中（段首，或前一个字符不是大写字母/数字——`UTF8` 里的 `F8` 不是事实编号
 * 形态），再豁免落在公开稳定 ID 词元非首段的那次。
 *
 * @param {string} line - 所在行。
 * @param {RegExp} keywordRe - 带 `g` 旗标的关键词正则。
 * @returns {number} 该行应报红的命中数。
 */
function countRefHits(line, keywordRe) {
  let count = 0;
  for (const match of line.matchAll(keywordRe)) {
    const i = match.index;
    const prev = i > 0 ? line[i - 1] : '';
    // 只统计词元段边界上的命中：段首（含词元首字符）或前字符不是大写字母/数字。
    if (i !== 0 && prev !== '-' && /[A-Z0-9]/.test(prev)) continue;
    if (insidePublicId(line, i)) continue;
    count += 1;
  }
  return count;
}

/** 内部引用表：只扫公开文档（`.md`）。`pattern` 行级正则与 `count` 词元级判定二选一。 */
const INTERNAL_REFS = [
  { pattern: /facts\.md/, why: '事实登记簿（已下沉 .local/docs/）' },
  // 事实编号按**完整词元**判：`WAIT-F02` 这类公开稳定 ID（全大写段、编号不在
  // 首段）里的 `F02` 豁免；`foo-F02`、`见-F07`、裸 `F65` 都不是公开 ID 形状，
  // 照旧红。混行里公开 ID 与真引用各自独立判定，前者不豁免后者。
  { count: (line) => countRefHits(line, /F\d{1,3}(?!\d)/g), why: '事实编号引用（登记簿不下沉则读者解不开）' },
  // 同理：`DOC-DELIVERY-COMMENTS` 是公开问题清单的稳定编号，不是已下沉的交付
  // 索引名。`DELIVERY-INDEX`、`x-DELIVERY`、`archive-DELIVERY-INDEX.md` 都不是
  // 公开 ID 形状，照旧红。
  { count: (line) => countRefHits(line, /DELIVERY/g), why: '交付索引（已下沉）' },
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
 * 仓根 `.git` 文件形态（git 链接工作树的指针文件）是否**确为**单行 `gitdir:` 指针：
 * 可读、恰一行、以 `gitdir: ` 开头。只有过了这层内容校验才豁免——同名但内容
 * 不是指针的文件（例如借 `.git` 名藏真实泄漏）必须照常进入扫描。
 *
 * @param {string} path - 候选文件路径。
 * @returns {boolean} 是合法 worktree 指针才 `true`。
 */
function isWorktreePointer(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  return /^gitdir: [^\r\n]+\r?\n?$/.test(text);
}

/**
 * 遍历仓库，收集参与判据的文件。
 *
 * @param {string} root - 仓根。
 * @param {Set<string>} skip - 目录跳过表（只对**目录**生效）。
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
        // 目录跳过表不豁免文件。唯一例外：仓根 `.git` 为**文件**时是 git 链接
        // 工作树（worktree）的指针（真 clone 的 `.git` 目录已在上面按目录跳过），
        // 先过内容校验（恰一行、`gitdir: ` 开头）才豁免——版本库元数据不是
        // 内容，混进指纹扫描会把本机盘路径误报成公开面泄漏（0.2.2 开发树在
        // 链接工作树上）；其余任何同名/同形文件照常逐行扫描。
        if (dir === root && entry.name === '.git' && isWorktreePointer(join(dir, entry.name))) continue;
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
          '未登记的 ignore 条目：核实它是本机材料、隔离工作树、依赖还是产品文件');
      }
    }
  }

  // ── 逐文件扫 ──────────────────────────────────────────────────────────────
  /** 本趟真正扫过的豁免文件 → 影子命中数（名单守卫的零命中判据用）。 */
  const exemptHits = new Map();
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

    // 豁免文件照跑判据，但只记**影子计数**（不红）：名单守卫要求每条豁免
    // 真的用得上——登记了却零命中的豁免是名单烂了，循环结束后按红处理。
    let shadowHits = 0;
    for (let i = 0; i < textLines.length; i += 1) {
      const line = textLines[i];
      for (const rule of FINGERPRINTS) {
        if (!rule.pattern.test(line)) continue;
        if (exempt) shadowHits += 1;
        else note(file, '指纹', i + 1, line, rule.why);
      }
      if (isDoc) {
        for (const rule of INTERNAL_REFS) {
          const hits = rule.count === undefined ? (rule.pattern.test(line) ? 1 : 0) : rule.count(line);
          if (hits === 0) continue;
          if (exempt) shadowHits += hits;
          else note(file, '引用', i + 1, line, rule.why);
        }
      }
    }

    // `.local/` 字面量：哪些文件可以写，以 `PUBLIC_SURFACE_ALLOWLIST` 为准。
    //
    // 只查**代码本体**（剥掉注释）：注释里解释"配置落在哪个目录"是在讲机制，
    // 不是在读本机事实。不剥的话，每个想告诉读者配置在哪的模块都得进豁免名单——
    // 那名单会迅速变成"所有提到了机制的文件"，判据也就废了。
    //
    // 豁免文件的影子计数对**原文**（含注释）取 `.local/`：豁免名单里有的条目
    // 恰恰是因为注释里的教学/机制文本要写这个字面量（如形状示例文件）。
    if (!isDoc && (exempt ? text : stripComments(text)).includes(`${LOCAL_DIR}/`)) {
      if (exempt) shadowHits += 1;
      else {
        const stripped = stripComments(text).split('\n');
        const lineNo = stripped.findIndex((l) => l.includes(`${LOCAL_DIR}/`)) + 1;
        note(file, '结构', lineNo, stripped[lineNo - 1] ?? '',
          '`.local/` 字面量在**代码里**只许出现在配置加载器、形状示例、变异脚本、本检查器自身与两个单测'
          + '——豁免全集以 `PUBLIC_SURFACE_ALLOWLIST` 为准，'
          + `其余脚本一律经 \`tools/_local-config.mjs\` 取本机事实（要写路径就用它导出的 \`LOCAL_DIR\` 拼）`);
      }
    }
    if (exempt) exemptHits.set(file, shadowHits);
  }

  // 豁免名单自身的两条守卫：条目要在盘上，且**真的用得上**（零命中 = 名单烂了）。
  // 只查本趟真正扫过的文件（`exemptHits` 有键）：scope 分块作业与二进制跳过
  // 不在扫过的集合里，不因没扫而误判零命中。
  for (const [file, why] of PUBLIC_SURFACE_ALLOWLIST) {
    if (!existsSync(join(root, file))) {
      note(file, '结构', 0, '', `豁免名单里有它但盘上不存在（名单该清）：${why}`);
      continue;
    }
    if (exemptHits.has(file) && exemptHits.get(file) === 0) {
      note(file, '结构', 0, '', `豁免名单里有它但零命中（豁免没被用上，名单该清）：${why}`);
    }
  }

  // ── 输出 ──────────────────────────────────────────────────────────────────
  const byFamily = { 结构: [], 指纹: [], 引用: [] };
  for (const finding of findings) byFamily[finding.family].push(finding);

  for (const family of ['结构', '指纹', '引用']) {
    const list = byFamily[family];
    say(`${list.length === 0 ? 'OK  ' : 'FAIL'} ${family.padEnd(4)} ${String(list.length).padStart(4)} 处`);
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
