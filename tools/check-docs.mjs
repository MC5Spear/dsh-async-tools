/**
 * 文档结构快检：现行文档的历史叙述词归零、公开范围 `docs/` 无未分类文档、语料围栏配对。
 *
 * 用法：node tools/check-docs.mjs
 *
 * ## 为什么"未分类的文件"必须告警
 *
 * 若这里是一份**现行文档白名单**：白名单里的查历史叙述词，不在名单里的当档案。
 * 那样**新加一份现行文档会被静默放过**——新建一份带"勘误"的文档，退出码 0、
 * 无任何提示。白名单的问题不是"漏了某个名字"，而是"默认放行"这个姿态本身：
 * 它要求写检查的人**预先想到**每一份未来会出现的文档。
 *
 * 现在反过来：公开范围 `docs/` 下每个 `.md` 都必须在 `FILES` 里显式登记，
 * 否则报未分类。加一份新文档时会被要求做一次明确判断，收益是**没有默认放行**。
 *
 * ## 输入契约（改这个脚本时必须一起改 `test/check-docs.test.mjs`）
 *
 * 本脚本读取责任表登记的全部文档、公开范围 `docs/` 的目录项、
 * 本机侧的语料目录（`<LOCAL_DIR>/docs/`，**可以整个不在**），以及自身的常量表。
 * 它的测试把这些铺到临时沙箱里**进程内**跑，所以：
 *
 * - 新增任何**输入**（再读一份文档、读一个配置）都必须同步改 `test/check-docs.test.mjs`
 *   的 `sandbox()`，否则沙箱里读不到、测试要么假红要么失去意义；
 * - 新增任何**判据**都要在 `test/check-docs.test.mjs` 里有一条能失败的用例——
 *   "打印了却不失败"是本脚本要防的两类自败形态之一（白名单默认放行、豁免排除告警项）。
 *
 * ## 两类检查输入
 *
 * 公开范围 `docs/` 按责任表登记需求、设计、用户参考与文档原则。
 * 审查、修正、审计、调研与事实材料**不进入本公开仓**；本机的 `<LOCAL_DIR>/docs/`
 * 是可选检查输入。本脚本因此分两段：
 *
 * - **公开段**：`docs/` 下每份 `.md` 必须显式登记为现行，多一份就红。
 * - **语料段**：语料目录**在**时就地清点、逐份查围栏配对；**整个不在**（CI、外部 clone）
 *   时打一行 `SKIP` 放过——那是这一类判据的正常缺席形态，不是失败，但必须留痕。
 *
 * ## 为什么语料段是"就地清点"而不是"对一份登记名单"
 *
 * 若对语料维护一份档案登记名单，它有两个毛病，都不是审美问题：
 *
 * 1. **它是过程元数据，却长在公开范围上**——文件名里的轮次编号会把一个内部过程暴露给
 *    每一个读者，而读者既不需要它、也无法核实它。
 * 2. **名单本身会把不该公开的字符串带出来**：语料文件可能按本机端口等指纹命名，
 *    于是"公开代码零本机指纹"这条判据会被一份**登记表**破坏——而登记表本来
 *    只是为了让检查器知道该扫哪些文件。
 *
 * 语料是**本机侧的数据**，它的清点就该**就地做**：目录里有什么就查什么。代价是失去
 * "登记了却在盘上找不到"这条判据——但那条判据本来就是本机备份该管的事，不是公开范围的事。
 *
 * ## 双入口形态
 *
 * `checkDocs(root)` 是可导入函数（测试进程内调用，避免沙箱下 spawn EPERM 的假红）；
 * CLI 入口只在直接执行时生效（`import.meta.url === pathToFileURL(process.argv[1])`），
 * 负责 `process.exit`。与 `tools/validate-preset.mjs` 同款分工。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LOCAL_DIR } from './_local-config.mjs';

/**
 * 文档责任表（设计 §8.3 按文件责任适用判据）：每份公开文档登记 `{file, role}`。
 *
 * - `current`：现行规范文档，承载"现在是什么"——历史叙述词与退役机制名清零。
 * - `archive`：历史档案，职责就是记录过去——历史叙述词与退役机制名在其条目内
 *   合法（档案记录的是当时的状态，退役名在旧条目里本来就是"当时的现役名"），
 *   两类命中都按份计数写进输出留痕（不是静默跳过，也不进退出码）；围栏配对等
 *   结构性判据仍按现行口径红。
 */
const DOCUMENTS = [
  { file: 'README.md', role: 'current' },
  { file: 'README.en.md', role: 'current' },
  { file: 'docs/user-reference.md', role: 'current' },
  { file: 'docs/user-reference.en.md', role: 'current' },
  { file: 'docs/documentation-principles.md', role: 'current' },
  { file: 'docs/requirements.md', role: 'current' },
  { file: 'docs/design.md', role: 'current' },
  // 验证目录的唯一脚本清单（`README.md` 明确指向它）。它**不在 `docs/` 下**，所以不受
  // "未分类/幽灵"对账管辖，也就没有任何判据盯着它的漂移（工具计数、清理承诺与目录
  // 现实脱节这类问题不会自动红）。登记为现行文档，与 `README.md` 同规则。
  { file: 'verify/README.md', role: 'current' },
  // 社区文件同样在这里登记：CONTRIBUTING 是参与方式的现行说明；CHANGELOG 是发布
  // 历史（档案）——历史叙述词在其条目内合法，围栏配对仍严格。
  { file: 'CHANGELOG.md', role: 'archive' },
  { file: 'CONTRIBUTING.md', role: 'current' }
];

/** 角色输出标签。 */
const ROLE_LABEL = { current: '现行', archive: '档案' };

/** 责任表里的全部文件（不分角色——未分类/幽灵对账与铺盘覆盖每一份）。 */
const FILES = DOCUMENTS.map((doc) => doc.file);

/** 历史叙述词：现行文档不该有这些。 */
const HISTORICAL_WORDS = /勘误|原写|先前版本|已作废|曾经|以前是|此前误/g;

/**
 * 退役名只按技术标识识别，避免把普通英语的动词或形容词当成机制名。
 * 代码标识、属性/键语法与紧邻的字段/机制称谓都是证据；禁令不豁免技术名称。
 * 档案仍按同一判据计数，由文件角色决定是否告警。
 */
function retiredDescription(before, after) {
  // 英语邻接本身不足以命名；技术称谓还须承担记录/跟踪等谓词，或明确说明用途。
  const technicalAssertion = /^['"”’]?\s+(?:field|property|flag|event|counter|mechanism|list)\s+(?:(?:records?|tracks?|stores?|counts?|signals?|marks?)\b|(?:to\s+(?:record|track|store|count|signal|mark)|for\s+(?:completion|delivery|tracking|waiting))\b)/i.test(after);
    return technicalAssertion
      || /\b(?:key|list)\s+(?:named|called)\s+['"“‘]?$/i.test(before)
      || /(?:\b(?:field|property|flag|event|counter|mechanism)\s+(?:named|called)\s+['"“‘]?|(?:字段|属性|键|标志|事件|计数|机制|列表)(?:名|名称)?[为是：:\s]*['"“‘]?)$/i.test(before)
      || /^['"”’]?\s*(?:字段|属性|键|标志|事件|计数|机制|列表)/.test(after)
      || (/(?:\b(?:do not use|never use|deprecated|retired)|禁止(?:使用)?|禁用|退役)\s*['"“‘]?$/i.test(before)
        && /^['"”’]?(?:\s*[.。;；!！]|\s*$|\s+(?:for|to)\b|\s*(?:来|用于|用来))/.test(after))
      || /^['"”’]?\s+(?:is|has been)\s+(?:deprecated|retired|obsolete)\b/i.test(after)
      || /^['"”’]?\s*(?:已退役|已废弃|已弃用)/.test(after);
}

function retiredMechanisms(text) {
  // JS 围栏中的名称按词法标识识别，字符串和注释里的普通英语不提供标识证据。
  const js = [...text.matchAll(/^[ \t]*\x60{3}(?:js|javascript|mjs|cjs)\s*\n([\s\S]*?)^[ \t]*\x60{3}/gm)].map((block) => {
    const start = block.index + block[0].indexOf('\n') + 1;
    const source = block[1];
    const quotedKeys = new Set();
    const comments = [];
    const masked = source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\x60(?:\\[\s\S]|[^\x60\\])*\x60/g, (token, offset) => {
      if (token.startsWith('//') || token.startsWith('/*')) {
        comments.push({ start: start + offset, end: start + offset + token.length, text: token });
      }
      // 引号内只有对象成员键和方括号属性是技术名称，message 等值字符串不是。
      if (/^['"](?:reported|waiters)['"]$/.test(token)
        && ((/[{,]\s*$/.test(source.slice(0, offset)) && /^\s*:/.test(source.slice(offset + token.length)))
          || /[\w$)\]]\s*(?:\?\.)?\[\s*$/.test(source.slice(0, offset)) && /^\s*\]/.test(source.slice(offset + token.length)))) {
        quotedKeys.add(start + offset + 1);
      }
      return token.replace(/[^\n]/g, ' ');
    });
    return { start, end: start + source.length, masked, quotedKeys, comments };
  });
  const code = [...text.matchAll(/(`{1,2})(reported|waiters)\1/g)]
    .map((m) => [m.index, m.index + m[0].length]);
  return [...text.matchAll(/\b(?:reported|waiters)\b/g)].filter((m) => {
    const block = js.find(({ start, end }) => start <= m.index && m.index < end);
    if (block) {
      const comment = block.comments.find(({ start, end }) => start <= m.index && m.index < end);
      if (comment) {
        const offset = m.index - comment.start;
        return retiredDescription(comment.text.slice(0, offset), comment.text.slice(offset + m[0].length));
      }
      return block.quotedKeys.has(m.index)
        || /^(?:reported|waiters)\b/.test(block.masked.slice(m.index - block.start));
    }
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    return code.some(([start, end]) => start <= m.index && m.index < end)
      || /\b(?:const|let|var|function|class)\s+$/.test(before)
      || /[\w$)\]]\s*\??\.\s*$/.test(before)
      // Markdown 段落不是代码接收者；正文属性访问只接受同一行横向空白。
      || (/[\w$)\]][ \t]*(?:\?\.)?\[[ \t]*['"]$/.test(before) && /^['"][ \t]*\]/.test(after))
      || /^\s*=(?!=)/.test(after)
      // 冒号只有与对象成员起点或独占行键配对时才是键证据，报告动词也能接冒号。
      || (/(?:[{,]\s*|(?:^|\n)[ \t]*)['"]?$/.test(before) && /^['"]?\s*:/.test(after))
      || retiredDescription(before, after);
  }).map((m) => m[0]);
}

const countFences = (text) => (text.match(/^```/gm) ?? []).length;

/**
 * 跑一遍文档结构检查。
 *
 * @param {string} root - 仓库根（`README.md` 与 `docs/` 的所在地）。
 * @param {{quiet?: boolean}} [options] - `quiet:true` 时不向 stdout 打印（测试用）。
 * @returns {{ok: boolean, code: number, out: string, corpusPresent: boolean, corpusCount: number}}
 *   `ok` = 无任何告警；`out` 为完整输出。
 */
export function checkDocs(root = process.cwd(), { quiet = false } = {}) {
  const lines = [];
  const say = (line) => {
    lines.push(line);
    if (!quiet) console.log(line);
  };

  const problemsByFile = new Map();
  const problem = (file, text) => {
    const list = problemsByFile.get(file) ?? [];
    list.push(text);
    problemsByFile.set(file, list);
  };

  /** 公开范围 `docs/` 下所有 `.md`，与完整责任表对账。 */
  let onDisk;
  try {
    onDisk = readdirSync(join(root, 'docs'))
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => `docs/${entry}`)
      .sort();
  } catch {
    onDisk = [];
  }

  // `docs/` 之外登记的文档（根下两语 README/CHANGELOG/CONTRIBUTING 与 `verify/README.md`，
  // 见 FILES 表）不参与"未分类/幽灵"对账：
  // 那两条判据的对象是"`docs/` 下每份 .md 都要有归属"。
  const OUTSIDE_DOCS = new Set(FILES.filter((file) => !file.startsWith('docs/')));
  const unclassified = onDisk.filter((file) => !FILES.includes(file));
  const phantom = FILES.filter((file) => !onDisk.includes(file) && !OUTSIDE_DOCS.has(file));

  for (const file of unclassified) {
    problem(file, '未分类：公开范围 `docs/` 下每份 Markdown 必须在 DOCUMENTS 责任表登记；'
      + '请先确认文档职责，再登记现行文档或档案');
  }
  for (const file of phantom) {
    problem(file, '名单里的这份现行文档在盘上不存在——名单与现实漂移了，检查会静默失去作用');
  }

  // ── 登记文档：围栏配对（全角色）+ 历史叙述词与退役机制名（按责任）──────
  const archiveHits = new Map();
  const retiredHits = new Map();
  for (const { file, role } of DOCUMENTS) {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch (error) {
      problem(file, `读不到（登记文档必须存在）：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const fences = countFences(text);
    if (fences % 2 !== 0) problem(file, `代码围栏 ${String(fences)} 个（不配对）`);
    const hits = [...text.matchAll(HISTORICAL_WORDS)].length;
    if (role === 'archive') {
      // 档案：历史叙述词合法——不进 problemsByFile（不影响退出码），按份计数留痕。
      archiveHits.set(file, hits);
    } else if (hits > 0) {
      problem(file, `历史叙述词 ${String(hits)} 处（现行文档应清零）`);
    }
    const retired = retiredMechanisms(text);
    if (role === 'archive') {
      // 档案：退役机制名同样合法（旧条目记录当时的状态），按份计数留痕。
      retiredHits.set(file, retired.length);
    } else if (retired.length > 0) {
      problem(file, `已退役机制名 ${String(retired.length)} 处（${[...new Set(retired)].join('、')}）——`
        + '现行文档应清零；档案豁免的只有历史叙述词与退役机制名');
    }
  }

  // ── 语料：就地清点 + 只查围栏配对 ─────────────────────────────────────────
  //
  // 语料不由本公开仓跟踪。它整个不在（CI、外部 clone）时本段
  // **文档化跳过**：那不是失败，但必须留痕——静默跳过与"查过了"在输出上必须能分辨。
  const corpusRoot = join(root, LOCAL_DIR, 'docs');
  const corpusPresent = existsSync(corpusRoot);
  let corpus = [];
  if (corpusPresent) {
    corpus = readdirSync(corpusRoot).filter((name) => name.endsWith('.md')).sort();
    // 「一份都没扫到」与「扫过且都对」是两件事：语料目录在却说里面没有 .md，
    // 多半是铺错了位置。按失败处理，别把它读成"检查通过"（空转检查器形态）。
    if (corpus.length === 0) {
      problem(`${LOCAL_DIR}/docs`, '语料目录存在但里面一个 .md 都没有——'
        + '要么是铺错了位置，要么是语料丢了；两种情况都不该按"检查通过"读');
    }
    for (const name of corpus) {
      const fences = countFences(readFileSync(join(corpusRoot, name), 'utf8'));
      if (fences % 2 !== 0) problem(name, `代码围栏 ${String(fences)} 个（不配对）`);
    }
  }

  // 关于"悬空小节引用"：**本检查不做**。文档里的 `§N` 大量是**跨文档引用**
  // （例如事实登记簿的 `§3.2` 指端到端记录文档的小节），要判它必须知道
  // "这个 § 指的是哪份文档"，而写法里没有这个信息。强行去做会生成几十条噪声，
  // 把真问题淹掉——这类"看起来更严、实际更吵"的检查比不做更糟。

  // ── 输出 ──────────────────────────────────────────────────────────────────
  for (const { file, role } of DOCUMENTS) {
    const list = problemsByFile.get(file);
    const tag = ROLE_LABEL[role];
    if (list === undefined) {
      const trace = role === 'archive'
        ? `  历史叙述词 ${String(archiveHits.get(file) ?? 0)} 处、退役机制名 ${String(retiredHits.get(file) ?? 0)} 处（档案合法，留痕）`
        : '';
      say(`OK    ${tag}  ${file.padEnd(28)} ${String(readFileSync(join(root, file)).length).padStart(6)}B${trace}`);
    } else {
      say(`WARN  ${tag}  ${file}`);
      for (const item of list) say(`            ${item}`);
    }
  }
  const corpusProblemFiles = corpus.filter((name) => problemsByFile.has(name));
  if (corpusPresent) {
    say(`OK    语料  ${String(corpus.length)} 份就地清点`
      + `${corpusProblemFiles.length === 0 ? '（围栏全部配对）' : `（${String(corpusProblemFiles.length)} 份有问题，见下）`}`);
  } else {
    say(`SKIP  语料  语料目录不在（${LOCAL_DIR}/docs）——CI 与外部 clone 的正常形态，本段文档化跳过`);
  }
  for (const file of unclassified) {
    say(`WARN  未分类  ${file}`);
    for (const item of problemsByFile.get(file)) say(`            ${item}`);
  }

  // **收尾**：任何还没打印出来的告警都要在这里打出来。
  //
  // 这条不是洁癖：上面每一段都只打印"它自己认得的那几个 key"，而 `problem()` 允许
  // 挂在任意 key 上（例如语料目录本身）。漏打印的后果是**检查失败却不说为什么**——
  // 与"打印了却不失败"是同一枚硬币的两面，都让人只能靠猜。变异与单测都够不着这种
  // 形态，只能靠结构上不留缝：凡进了 `problemsByFile` 的，最后一定要被念出来。
  const printed = new Set([...FILES, ...corpusProblemFiles, ...unclassified]);
  const rest = [...problemsByFile.keys()].filter((key) => !printed.has(key));
  for (const key of rest) {
    say(`WARN  其他  ${key}`);
    for (const item of problemsByFile.get(key)) say(`            ${item}`);
  }
  for (const name of corpusProblemFiles) {
    say(`WARN  语料  ${name}`);
    for (const item of problemsByFile.get(name)) say(`            ${item}`);
  }

  // **任何**一项问题都算失败——包括语料的围栏不配对。
  //
  // 档案（role=archive）按文件责任豁免的**只有历史叙述词与退役机制名两类**：
  // 豁免以角色建模、以命中计数留痕（见输出里的档案行），不是"打印 WARN 却退出 0"
  // 那种把告警从退出码里摘除的形态。围栏配对等结构性判据对档案同样算失败——
  // 档案记得再旧，结构坏了读者照样读不了。
  const bad = problemsByFile.size;
  const currentCount = DOCUMENTS.filter((doc) => doc.role === 'current').length;
  const archiveDocs = DOCUMENTS.filter((doc) => doc.role === 'archive');
  const archiveHitTotal = archiveDocs.reduce((sum, doc) => sum + (archiveHits.get(doc.file) ?? 0), 0);
  const retiredHitTotal = archiveDocs.reduce((sum, doc) => sum + (retiredHits.get(doc.file) ?? 0), 0);
  say('');
  say(bad === 0
    ? `文档结构检查通过（现行 ${String(currentCount)} 份历史叙述词与退役机制名归零；`
      + `档案 ${String(archiveDocs.length)} 份历史叙述词 ${String(archiveHitTotal)} 处、退役机制名 ${String(retiredHitTotal)} 处留痕；`
      + `公开范围 \`docs/\` 无未分类文档；语料${corpusPresent ? ` ${String(corpus.length)} 份围栏配对` : '缺席（跳过）'}）。`
    : `${String(bad)} 份文档有告警。`);
  return { ok: bad === 0, code: bad === 0 ? 0 : 1, out: lines.join('\n'), corpusPresent, corpusCount: corpus.length };
}

// CLI 入口：只在直接执行时生效（测试以 `checkDocs(root)` 导入，不触发）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(checkDocs(process.cwd()).code);
}
