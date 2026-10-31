/**
 * `tools/check-docs.mjs` 的判据测试。
 *
 * 为什么需要这个文件：这个脚本的失效形态**不是"漏了某个名字"**，而是"打印了却不失败"：
 *   - 白名单默认放行 → 新建一份带「勘误」的现行文档被静默放过、退出 0；
 *   - `bad` 把已登记档案排除 → 给档案加未闭合围栏只打印 WARN、退出 0；
 *   - 角色豁免静默化 → 档案里的历史叙述词既不计数也不留痕，"查过"与"没查"不可分辨。
 * 三种形态都是"输出看起来在报问题（或什么都不报），退出码却说是好的"。**光靠人读
 * 输出发现不了**，必须有一条能失败的断言——本文件里的 C1–C11 就是那几条。
 *
 * 做法：在包外的一次性副本上跑检查函数。不复制整包（那要几秒），
 * 只把它的输入铺到一个临时目录里：公开范围 `docs/`、根下 `README.md`、
 * 责任表里 `docs/` 外的登记文档（见 `CURRENT_OUTSIDE_DOCS`——沙箱必须覆盖
 * 责任表全集），以及本机侧语料目录——检查只读这些相对路径，所以沙箱是
 * 前后一致的。
 *
 * ## 进程内调用
 *
 * 用 `execFileSync` 起子进程跑脚本在沙箱下不可行：spawn EPERM，`error.status ?? 1`
 * 兜成退出 1、输出为空，C1–C4 会全部**假红**（与被检查的文档无关）。脚本因此是
 * 可导入函数（`checkDocs(root)`，CLI 入口只在直接执行时生效），`runChecker` 直接调用它。
 *
 * ## 可选本机材料输入
 *
 * 语料（过程稿、事实登记簿、交付索引）不由本公开仓跟踪。
 * `<LOCAL_DIR>/docs/` 是"可以整个不在"的检查输入，本文件的沙箱
 * 把它铺出来，C7/C8 专门盯它缺席与为空两种形态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LOCAL_DIR } from '../tools/_local-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = 'tools/check-docs.mjs';

/**
 * 现行文档清单——**必须与 `tools/check-docs.mjs` 的 `DOCUMENTS` 责任表一致**
 * （本文件按现行/档案分组列路径，只是排版差异）。
 *
 * 这里写第二份而不是 import 脚本的常量：脚本的 CLI 入口会 `process.exit`，
 * 静态导入有顺带执行整场检查的风险（函数形态只在调用时跑，但双份清单的漂移风险
 * 本来就是 C5 要盯的）。重复一份的代价是可能漂移，所以 C5 顺便断言这些文件都存在。
 */
// 过程性文档（问题清单）同属公开范围 docs/ 的现行文件——收尾整份删除时同步撤
// 本名单与 tools/check-docs.mjs 责任表里的登记行（C5 与未分类对账两侧都盯着）。
const CURRENT_DOCS = ['requirements.md', 'design.md', 'user-reference.md', 'user-reference.en.md', 'documentation-principles.md', 'issue-list.md'];

/**
 * `docs/` **之外**的登记文档，同样必须与脚本的责任表一致（脚本里 CHANGELOG 是
 * archive 角色、另两份是 current——但三份都是检查输入，沙箱缺一不可）。
 *
 * 除 `verify/README.md`（验证目录的唯一脚本清单）外，还有两份社区文件——
 * 发布历史与参与方式。它们不在 `docs/` 下，所以脚本的"未分类/幽灵"对账
 * 不覆盖它们——**但沙箱必须把它们也铺进去**，否则脚本会在沙箱里报"登记文档本身不存在"，
 * 而那条失败与代码无关。
 */
const CURRENT_OUTSIDE_DOCS = ['README.en.md', 'verify/README.md', 'CHANGELOG.md', 'CONTRIBUTING.md'];

/** 沙箱语料里铺的两份合成档案（**不**取真实语料——那是本机侧的数据，且会随轮次改名）。 */
const SAMPLE_CORPUS = {
  'impl-review-sample.md': '# 合成审查稿\n\n围栏配对：\n\n```text\nok\n```\n',
  'research-sample.md': '# 合成调研稿\n\n围栏配对：\n\n```text\nok\n```\n'
};

/**
 * 铺一个临时沙箱（检查的全部输入），返回根目录与清理函数；`runChecker` 进程内调用检查函数。
 *
 * @param {{ corpus?: boolean }} [options] - `corpus:false` 时不铺语料目录（模拟 CI 与外部 clone）。
 */
async function sandbox({ corpus = true } = {}) {
  const { checkDocs } = await import('../tools/check-docs.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'checkdocs-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(join(ROOT, 'docs'), join(dir, 'docs'), { recursive: true });
  cpSync(join(ROOT, 'README.md'), join(dir, 'README.md'));
  for (const rel of CURRENT_OUTSIDE_DOCS) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(dir, rel));
  }
  if (corpus) {
    const corpusDir = join(dir, LOCAL_DIR, 'docs');
    mkdirSync(corpusDir, { recursive: true });
    for (const [name, text] of Object.entries(SAMPLE_CORPUS)) writeFileSync(join(corpusDir, name), text, 'utf8');
  }
  return {
    dir,
    corpusDir: join(dir, LOCAL_DIR, 'docs'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    // 方法名是**跑一次检查器**，与"异步工具"无关——不要叫 `async_run()`：
    // 那个名字在本仓里专指工具，混用会让人以为这里测的是插件功能。
    runChecker() {
      const { code, out } = checkDocs(dir, { quiet: true });
      return { code, out };
    }
  };
}

test('C1 check-docs：干净时退出 0（四态之③：正常文档全绿）', async (t) => {
  const box = await sandbox();
  t.after(box.cleanup);
  const { code, out } = box.runChecker();
  assert.equal(code, 0, `干净的树必须退出 0，实际输出：${out.slice(-300)}`);
  assert.match(out, /现行 10 份/);
  assert.match(out, /档案 1 份/);
});

test('C2 check-docs：未分类的新文档必须让它退出 1（白名单默认放行的假绿）', async (t) => {
  const box = await sandbox();
  t.after(box.cleanup);
  // 场景：新建一份带「勘误」的现行文档——若被当档案静默放过、退出 0，即白名单默认放行的假绿。
  writeFileSync(join(box.dir, 'docs', 'PROBE.md'), '# 探针\n\n这是一处勘误。\n', 'utf8');
  const { code, out } = box.runChecker();
  assert.equal(code, 1, `未分类的新文档必须让检查失败，实际退出 ${String(code)}`);
  assert.match(out, /未分类/, `输出必须点名"未分类"，实际：${out.slice(-300)}`);
});

test('C3 check-docs：语料的结构问题也必须让它退出 1（档案豁免的假绿）', async (t) => {
  const box = await sandbox();
  t.after(box.cleanup);
  // 场景：给一份**档案**加未闭合围栏。若把档案排除在 `bad` 之外，就会打印 WARN 却退出 0
  // ——"打印了却不失败"。现在语料是就地清点的，所以这条判据对每一份语料都成立。
  const archive = join(box.corpusDir, 'impl-review-sample.md');
  const before = readFileSync(archive, 'utf8');
  const fencesBefore = (before.match(/^```/gm) ?? []).length;
  assert.equal(fencesBefore % 2, 0, '前置：合成档案原本围栏配对');
  appendFileSync(archive, '```\n', 'utf8');

  const { code, out } = box.runChecker();
  assert.equal(code, 1, `语料的围栏不配对必须让检查失败，实际退出 ${String(code)}`);
  assert.match(out, /围栏/, `输出必须点名围栏问题，实际：${out.slice(-300)}`);
  assert.match(out, /impl-review-sample\.md/, '输出必须点名是哪一份语料');
});

test('C7 check-docs：语料目录整个不在时必须仍然退出 0（CI 与外部 clone 的正常形态）', async (t) => {
  const box = await sandbox({ corpus: false });
  t.after(box.cleanup);
  assert.ok(!existsSync(box.corpusDir), '前置：沙箱里没有语料目录');
  const { code, out } = box.runChecker();
  assert.equal(code, 0, `语料缺席不是失败，实际退出 ${String(code)}：${out.slice(-300)}`);
  // 但**必须留痕**：静默跳过与"查过了"在输出上要能分辨。
  assert.match(out, /SKIP\s+语料/, `缺席必须打一行 SKIP，实际：${out.slice(-300)}`);
});

test('C8 check-docs：语料目录在但一份 .md 都没有时必须退出 1（空转检查器）', async (t) => {
  const box = await sandbox({ corpus: false });
  t.after(box.cleanup);
  mkdirSync(box.corpusDir, { recursive: true });
  const { code, out } = box.runChecker();
  assert.equal(code, 1, `空语料目录必须失败，实际退出 ${String(code)}：${out.slice(-300)}`);
  assert.match(out, /一个 \.md 都没有/, `输出必须说明是空语料，实际：${out.slice(-300)}`);
});

test('C5 check-docs：只准读那几个相对路径（新增输入必须同步改本文件的 sandbox）', async (t) => {
  const box = await sandbox();
  t.after(box.cleanup);
  // 真正的盲区不是"测旧版脚本"（每次都现拷），而是**输入契约没写下来**——
  // `sandbox()` 只铺固定几样，脚本一旦多读一份文件，沙箱里就读不到，
  // 于是要么假红、要么那条判据在沙箱里失去意义，而**没有人会被提醒**。
  // 这条断言就是那个提醒：脚本读的字面量路径必须只有 `'docs'`。
  const source = readFileSync(join(ROOT, SCRIPT), 'utf8');
  const literalReads = [...source.matchAll(/(?:readFileSync|readdirSync|existsSync)\(([^)]*)\)/g)]
    .map((match) => match[1].trim())
    // `file` / `name` 是循环变量（值来自 DOCUMENTS 责任表 / 语料清点结果），不是新输入。
    .filter((argument) => argument !== 'file' && argument !== 'name' && argument !== 'abs');
  const suspicious = literalReads.filter((argument) => argument.startsWith("'") && argument !== "'docs'");
  assert.deepEqual(suspicious, [],
    `脚本开始读新的字面量路径了（${suspicious.join('、')}）：`
    + '请同步更新 test/check-docs.test.mjs 的 sandbox()，否则沙箱里读不到这份文件');

  // 名单里的每一份都必须真的在盘上，否则"扫一份不存在的文件"等于没扫。
  const docs = readdirSync(join(ROOT, 'docs')).filter((name) => name.endsWith('.md'));
  for (const name of CURRENT_DOCS) {
    assert.ok(docs.includes(name), `docs/${name} 必须在盘上（脚本的现行名单里有它）`);
  }
  assert.ok(existsSync(join(ROOT, 'README.md')), 'README.md 必须在盘上（脚本的现行名单里有它）');
  // 未登记的新文档必须失败，新增输入须同步责任表和夹具。
  assert.equal(docs.length, CURRENT_DOCS.length,
    `公开范围 docs/ 只应剩 ${String(CURRENT_DOCS.length)} 份现行文档，实际 ${String(docs.length)} 份：${docs.join('、')}`);
  void box;
});

test('C6 现行文档、测试与工具里引用的探针必须都在盘上（档案豁免）', () => {
  // 盲区形态：只扫子集（现行文档 + 两个测试文件）会漏掉 `tools/` 下的探针自己，
  // 引用了不存在的探针却不自知。
  //
  // 口径：**现行范围**（README、现行文档、test/、tools/）里引用的 `tools/probe-*.mjs`
  // 必须在盘上——引用了不存在的探针，读者按图索骥会扑空。
  // **档案豁免**：审查/修正/审计/端到端记录写的是**当时**的状态，那时的探针可能已经删了，
  // 改它们等于篡改历史。
  //
  // 注意这里读的是**仓库本身**，不是沙箱：沙箱只铺了公开文档，而本判据要覆盖 test/ 与 tools/。
  const files = [
    'README.md',
    ...CURRENT_DOCS.map((name) => join('docs', name)),
    // `docs/` 之外的现行文档也在扫描范围内（`verify/README.md` 现在没有 `tools/probe-*`
    // 引用，但登记了不扫会在下次有人加进去时静默漏掉）。
    ...CURRENT_OUTSIDE_DOCS,
    ...readdirSync(join(ROOT, 'test')).filter((n) => n.endsWith('.mjs')).map((n) => join('test', n)),
    ...readdirSync(join(ROOT, 'tools')).filter((n) => n.endsWith('.mjs')).map((n) => join('tools', n))
  ];

  const missing = [];
  for (const relative of files) {
    const text = readFileSync(join(ROOT, relative), 'utf8');
    // 只认**本包相对写法** `tools/probe-*.mjs`——它才是"读者会在本仓里找"的那种引用。
    // 负向后顾排除前面还有路径分隔符或盘符的情形：写全绝对路径指的是**别的仓**里的文件。
    for (const match of text.matchAll(/(?<![\w\\/:.])tools\/(probe-[a-z0-9-]+\.mjs)/g)) {
      if (!existsSync(join(ROOT, 'tools', match[1]))) missing.push(`${relative} → ${match[1]}`);
    }
  }
  assert.deepEqual(missing, [],
    `现行范围里引用了不存在的探针（读者按图索骥会扑空）：\n  ${missing.join('\n  ')}`);
});

test('C4 check-docs：名单里的文件在盘上不存在时必须报出来', async (t) => {
  const box = await sandbox();
  t.after(box.cleanup);
  // 名单与现实漂了 → 检查会静默失去作用（扫一份不存在的文件，等于没扫）。
  const victim = join(box.dir, 'docs', 'design.md');
  assert.ok(existsSync(victim), '前置：该文件在现行名单里');
  rmSync(victim);

  const { code, out } = box.runChecker();
  assert.equal(code, 1, '名单指向不存在的文件时必须失败');
  assert.match(out, /在盘上不存在/, `输出必须说明名单与现实漂了，实际：${out.slice(-300)}`);
});

test('C9 check-docs：档案里的历史叙述词合法（四态之①：计数留痕、退出 0）', async (t) => {
  const box = await sandbox();
  t.after(box.cleanup);
  // 场景：CHANGELOG（责任表 role=archive）的条目里出现历史叙述词。按文件责任，
  // 档案记过去是它的本分——不算失败；但必须**计数留痕**，否则"查过"与"没查"
  // 在输出上不可分辨（静默跳过形态）。
  appendFileSync(
    join(box.dir, 'CHANGELOG.md'),
    '\n## [0.0.0-test] — 档案判据夹具\n\n这是一处勘误；先前版本原写如此，曾经另有写法。\n',
    'utf8'
  );
  const { code, out } = box.runChecker();
  assert.equal(code, 0, `档案里的历史叙述词必须合法（退出 0），实际退出 ${String(code)}：${out.slice(-300)}`);
  assert.match(out, /OK\s+档案\s+CHANGELOG\.md/, `输出必须按档案角色标记 CHANGELOG，实际：${out.slice(-300)}`);
  assert.match(out, /历史叙述词 [1-9]\d* 处、退役机制名 \d+ 处（档案合法，留痕）/, `档案命中必须计数留痕，实际：${out.slice(-300)}`);
});

test('C9b check-docs：档案里的退役机制名合法（责任豁免的第二类，与四态之①同口径留痕）', async (t) => {
  const box = await sandbox();
  t.after(box.cleanup);
  // 场景：CHANGELOG（role=archive）的旧条目里出现退役机制名。旧条目记录当时
  // 的状态，退役名在条目里本来就是"当时的现役名"——不算失败，但必须**计数
  // 留痕**（与历史叙述词同一套留痕口径，设计 §8.3）。
  appendFileSync(
    join(box.dir, 'CHANGELOG.md'),
    '\n## [0.0.0-test] — 档案判据夹具（退役名）\n\n当时的 waiters 计数与 reported 事件名已按新宿主改代。\n',
    'utf8'
  );
  const { code, out } = box.runChecker();
  assert.equal(code, 0, `档案里的退役机制名必须合法（退出 0），实际退出 ${String(code)}：${out.slice(-300)}`);
  assert.match(out, /历史叙述词 \d+ 处、退役机制名 [1-9]\d* 处（档案合法，留痕）/, `退役名命中必须计数留痕，实际：${out.slice(-300)}`);
});

test('C10 check-docs：现行文档里的历史叙述词仍然必红（四态之②：责任豁免不外溢）', async (t) => {
  const box = await sandbox();
  t.after(box.cleanup);
  // 场景：现行文档（CONTRIBUTING.md）里出现历史叙述词——责任模型只豁免档案，
  // 现行档"清零"口径不变；若角色建模把现行档也放过，这条就是那个反例。
  appendFileSync(join(box.dir, 'CONTRIBUTING.md'), '\n这是一处勘误。\n', 'utf8');
  const { code, out } = box.runChecker();
  assert.equal(code, 1, `现行文档的历史叙述词必须失败，实际退出 ${String(code)}：${out.slice(-300)}`);
  assert.match(out, /WARN\s+现行\s+CONTRIBUTING\.md/, `输出必须按现行角色点名 CONTRIBUTING，实际：${out.slice(-300)}`);
  assert.match(out, /历史叙述词 1 处（现行文档应清零）/, `输出必须报历史叙述词命中，实际：${out.slice(-300)}`);
});

test('C10b check-docs：现行文档里的退役机制名仍然必红（退役判据的现行侧反例）', async (t) => {
  const box = await sandbox();
  t.after(box.cleanup);
  // 场景：现行文档（CONTRIBUTING.md）里出现退役机制名——档案豁免不外溢到
  // 现行档；退役名在现行文档里按名单判红（这是该判据在本测试里唯一能失败
  // 的用例形态，补上脚本输入契约要求的"每条判据至少一条会失败的用例"）。
  appendFileSync(join(box.dir, 'CONTRIBUTING.md'), '\n等待方计数见 waiters 列表。\n', 'utf8');
  const { code, out } = box.runChecker();
  assert.equal(code, 1, `现行文档的退役机制名必须失败，实际退出 ${String(code)}：${out.slice(-300)}`);
  assert.match(out, /已退役机制名 1 处（waiters）/u, `输出必须报退役机制名命中，实际：${out.slice(-300)}`);
});

test('C11 check-docs：档案的围栏损坏仍然必红（四态之④：结构性判据不随角色豁免）', async (t) => {
  const box = await sandbox();
  t.after(box.cleanup);
  // 场景：给档案（CHANGELOG）加未闭合围栏。档案豁免的只有历史叙述词与退役
  // 机制名两类；围栏配对是结构性判据，坏围栏让任何读者都读不了，照红。
  appendFileSync(join(box.dir, 'CHANGELOG.md'), '\n```\n', 'utf8');
  const { code, out } = box.runChecker();
  assert.equal(code, 1, `档案的围栏不配对必须失败，实际退出 ${String(code)}：${out.slice(-300)}`);
  assert.match(out, /WARN\s+档案\s+CHANGELOG\.md/, `输出必须点名档案文件，实际：${out.slice(-300)}`);
  assert.match(out, /代码围栏 \d+ 个（不配对）/, `输出必须点名围栏问题，实际：${out.slice(-300)}`);
});


const ORDINARY_MECHANISM_WORD_CASES = [
  ["标题后裸数组","# Synthetic current document\n\n\n[\"reported\"]"],
  ["段落后裸数组","A normal paragraph ends here\n\n[\"waiters\"]"],
  ["JSON消息值数组","```json\n{\"messages\": [\"reported\"]}\n```"],
  ["JSON等待词值数组","```json\n{\"messages\": [\"waiters\"]}\n```"],
  ["普通裸数组","[\"reported\"]"],
  ["普通注释技术词宾语","```js\n// Residents reported property damage.\n// The user reported field errors.\n```"],
  ["普通字符串技术词宾语","```js\nconsole.log(\"The user reported key details.\");\n```"],
  ["JS数组普通字符串", '```js\nconst messages = ["reported"];\n```'],
  ["报告字段错误正文","The user reported field errors."],
  ["报告字段错误注释","```js\n// The user reported field errors.\n```"],
  ["报告字段错误字符串","```js\nconsole.log(\"The user reported field errors.\");\n```"],
  ["报告财产损害正文","Residents reported property damage."],
  ["报告财产损害注释","```js\n// Residents reported property damage.\n```"],
  ["报告财产损害字符串","```js\nconsole.log(\"Residents reported property damage.\");\n```"],
  ["报告关键细节正文","The user reported key details about the failure."],
  ["报告关键细节JS注释","```js\n// The user reported key details about the failure.\n```"],
  ["报告关键细节JS字符串","```js\nconsole.log(\"The user reported key details about the failure.\");\n```"],
  ["服务员列菜品正文","The waiters list the available dishes."],
  ["服务员列菜品JS注释","```js\n// The waiters list the available dishes.\n```"],
  ["服务员列菜品JS字符串","```js\nconsole.log(\"The waiters list the available dishes.\");\n```"],
  ["JS块注释普通英语","```js\n/* The user reported key details. */\n```"],
  ["普通报告冒号","The user reported: the file was missing."],
  ["注释普通报告冒号","```js\n// The user reported: the file was missing.\n```"],
  ["字符串普通报告冒号","```json\n{\"message\": \"The user reported: the file was missing.\"}\n```"],
  ["禁令中的 reported 形容词","Do not use reported paths as proof."],
  ["禁令中的 reported 换行形容词","Do not use reported\npaths as proof."],
  ["代码字符串普通 reported path", '```powershell\nWrite-Output "reported path"\n```'],
  ["JSON 消息普通 reported", '```json\n{"message": "The user reported an error"}\n```'],
  ["代码注释普通 reported", '```js\n// The user reported an error.\n```'],
  [
    "普通英语 reported path",
    "A reported path also does not prove that the file is complete."
  ],
  [
    "普通英语用户报告错误",
    "The user reported an error. Check the log before retrying."
  ],
  [
    "普通英语自然分段",
    "A reported\npath can be checked later.\n\nThe user\nreported an error in the command."
  ],
  [
    "普通英语 waiters 人员",
    "The restaurant waiters reported an error in the order."
  ],
  [
    "普通标识子串",
    "ordinarywaiters and unreported are example words."
  ]
];
const RETIRED_IDENTIFIER_CASES = [
  ["同一行真实state属性","Read state[\"reported\"] before returning."],
  ["JS合法跨行属性","```js\nconst value = state\n  [\"reported\"];\n```"],
  ["原reported字段技术断言","The reported field records completion."],
  ["原waiters机制技术断言","The waiters mechanism tracks pending calls."],
  ["原跨行reported事件用途","Use the reported\nevent to track completion."],
  ["非JS接收者方括号属性","Read state[\"reported\"] before returning."],
  ["JSON真实对象键","```json\n{\"reported\": true}\n```"],
  ["JS注释明确字段命名","```js\n// The field named reported records completion.\n```"],
  ["JS注释用途禁令","```js\n// Do not use waiters for completion tracking.\n```"],
  ["JS块注释明确字段命名","```js\n/* The field called reported records completion. */\n```"],
  ["JS块注释用途禁令","```js\n/* Do not use waiters for completion tracking. */\n```"],
  ["JS注释原字段断言","```js\n// The reported field records completion.\n```"],
  ["技术机制其他谓词","The reported mechanism stores delivery state."],
  ["技术事件其他用途","Use the waiters event for completion tracking."],
  ["JS解构绑定","```js\nconst { reported } = event;\n```"],
  ["JS对象简写","```js\nconst state = { reported };\n```"],
  ["JS逗号声明","```js\nlet active = true, waiters;\n```"],
  ["JS引号对象键","```js\nconst state = { \"reported\": true };\n```"],
  ["JS引号属性","```js\nconst value = event[\"reported\"];\n```"],
  ["明确命名key","The key named reported records completion."],
  ["明确命名list","The list called waiters tracks pending calls."],
  ["reported 用途禁令","Do not use reported for completion tracking."],
  ["waiters 中文用途禁令","禁止使用 waiters 来记录等待者。"],
  ["reported 后置退役谓语","reported is deprecated."],
  ["waiters 后置退役谓语","waiters is retired for completion tracking."],
  ["reported 多行对象键","```json\n{\n  \"reported\": true\n}\n```"],
  ["waiters 后续对象成员键","{ active: true, waiters: [] }"],
  [
    "行内 reported 标识",
    "`reported`"
  ],
  [
    "行内 waiters 标识",
    "`waiters`"
  ],
  [
    "属性 reported",
    "Read event.reported before returning."
  ],
  [
    "可选链 waiters",
    "Read job?.waiters before returning."
  ],
  [
    "方括号 reported 属性",
    "Read event[\"reported\"] before returning."
  ],
  [
    "reported 对象键",
    "{ \"reported\": true }"
  ],
  [
    "waiters 对象键",
    "{ waiters: [] }"
  ],
  [
    "reported 字段称谓",
    "The field called reported records completion."
  ],
  [
    "reported 前置字段称谓",
    "The field named reported records completion."
  ],
  [
    "waiters 机制称谓",
    "The mechanism named waiters tracks pending calls."
  ],
  [
    "跨行 reported 事件名",
    "Use the event named\nreported to track completion."
  ],
  [
    "中文 reported 机制",
    "使用 reported 机制处理结果。"
  ],
  [
    "reported 英文禁令",
    "Do not use reported."
  ],
  [
    "waiters 中文禁令",
    "禁止使用 waiters。"
  ],
  [
    "reported 代码围栏",
    "```js\nconst reported = true;\n```"
  ],
  [
    "waiters 代码围栏",
    "```js\nconst waiters = [];\n```"
  ]
];

for (const [name, body] of [...ORDINARY_MECHANISM_WORD_CASES, ...RETIRED_IDENTIFIER_CASES]) {
  const rejected = RETIRED_IDENTIFIER_CASES.some(([label]) => label === name);
  test(`C12 check-docs：${name}${rejected ? '必须失败' : '必须通过'}`, async (t) => {
    const box = await sandbox({ corpus: false });
    t.after(box.cleanup);
    const baseline = box.runChecker();
    assert.equal(baseline.code, 0, `变异前基线必须通过：${baseline.out}`);
    const target = join(box.dir, 'docs', 'user-reference.en.md');
    const before = readFileSync(target, 'utf8');
    appendFileSync(target, `\n\n${body}\n`, 'utf8');
    assert.equal(readFileSync(target, 'utf8'), `${before}\n\n${body}\n`, '夹具必须实际写入目标正文');
    const result = box.runChecker();
    assert.equal(result.code, rejected ? 1 : 0, result.out);
    if (rejected) {
      assert.match(result.out, /WARN\s+现行\s+docs\/user-reference\.en\.md/);
      assert.match(result.out, /已退役机制名 1 处/);
    }
  });
}
