/**
 * `tools/check-public-surface.mjs` 的判据测试。
 *
 * ## 这个检查器为什么需要自己的测试
 *
 * 它是**边界判据**：管的是"本机事实有没有漏进公开范围、公开文档有没有引用未公开内容"。
 * 这类判据的失效方式特别安静——漏报不会让任何别的测试变红，只会让本机路径在推上
 * GitHub 之后被所有人看见。所以每一条判据都要有一条**能失败**的用例钉住。
 *
 * 与 `verify/mutate-public-surface.mjs` 的分工：那边证明"改坏必红"（变异证明），
 * 这边钉住"什么该红、什么不该红"（判据语义）。两边都在**合成树**上跑，不碰真仓。
 *
 * ## 三条判据各自的红线
 *
 * - **结构**：`.gitignore` 必须有 `.local/`、不许有零散条目；非豁免源码不许写 `.local/`
 *   字面量；豁免名单的每条都要真的存在。
 * - **指纹**：全部进入公开范围的文件扫指纹表——**注释也算**（注释里的机器路径一样是泄漏）。
 * - **引用**：公开**文档**扫内部引用表（下沉语料名、事实编号、过程稿名、历史运行产物路径）。
 *   源码不算——代码注释里提一句"见某份登记簿"不影响读者读懂产品。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPublicSurface, PUBLIC_SURFACE_ALLOWLIST } from '../tools/check-public-surface.mjs';

/** 合成树里那份"干净"的 `.gitignore`（与真仓同形：只有那几条，外加 `.local/`）。 */
const CLEAN_IGNORE = ['# 本机侧的唯一例外目录', '.local/', '', 'node_modules/', '.vscode/', 'Thumbs.db', 'Desktop.ini', ''].join('\n');
/** 豁免文件在合成树里的占位内容：含 `.local/` 字面量，保证豁免"真的用得上"
 * （零命中守卫不误伤——名单条目在本趟扫描里都有影子命中）。 */
const ALLOWLIST_STUB = 'export const ALLOWLIST_STUB = ".local/";\n';
const CLEAN_SOURCE = 'export const answer = 42;\n';
const CLEAN_DOC = '# 合成文档\n\n这份文档不该引用任何未公开内容。\n';

/**
 * 铺一棵合成树。
 *
 * 豁免名单里的文件**从检查器 import**（不抄一份）：抄的那份迟早与它漂开，
 * 而漂开的后果是"名单该清"这条判据在每棵合成树上都红，测试从此没人信。
 *
 * @param {{ ignore?: string, source?: string, doc?: string, extra?: Record<string, string>,
 *   skipAllowlisted?: string }} [patch] - 各文件的覆盖内容。
 * @returns {{ root: string, cleanup: () => void }} 根目录与清理函数。
 */
function sandbox(patch = {}) {
  const root = mkdtempSync(join(tmpdir(), 'surface-'));
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  };
  for (const file of PUBLIC_SURFACE_ALLOWLIST.keys()) {
    if (file === patch.skipAllowlisted) continue;
    put(file, file === '.gitignore' ? '' : ALLOWLIST_STUB);
  }
  put('.gitignore', patch.ignore ?? CLEAN_IGNORE);
  put('lib/index.js', patch.source ?? CLEAN_SOURCE);
  put('docs/design.md', patch.doc ?? CLEAN_DOC);
  for (const [rel, text] of Object.entries(patch.extra ?? {})) put(rel, text);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * 跑一次合成树上的检查器，返回 `{ ok, findings, out }`。
 *
 * @param {object} patch - 同 `sandbox`。
 * @returns {{ ok: boolean, findings: object[], out: string, cleanup: () => void }} 读数与清理函数。
 */
function inspect(patch = {}) {
  const box = sandbox(patch);
  const result = checkPublicSurface(box.root, { quiet: true });
  return { ...result, cleanup: box.cleanup };
}

/** 断言：某一家族里出现了匹配期望理由的命中。 */
function assertCaught(patch, family, why, message) {
  const result = inspect(patch);
  try {
    const hit = result.findings.filter((f) => f.family === family && why.test(f.why));
    assert.ok(hit.length > 0,
      `${message}\n实际命中 ${String(result.findings.length)} 处：\n`
      + result.findings.slice(0, 6).map((f) => `  ${f.family} ${f.file}:${String(f.line)} ${f.why}`).join('\n'));
  } finally {
    result.cleanup();
  }
}

test('P1 干净合成树必须零命中（防恒真）', () => {
  const result = inspect();
  try {
    assert.deepEqual(result.findings, [], `干净树不该有任何命中：\n${result.out}`);
    assert.equal(result.code, 0);
  } finally {
    result.cleanup();
  }
});

test('P2 指纹：源码里的本机盘符路径必须报（转义、裸盘根两代盲区都在场）', () => {
  // 这条是回归钉子：只认单反斜杠的判据会让**可执行代码里的本机绝对路径**
  // 整类漏检（注释里是单反斜杠、字符串里是双反斜杠，两种形态都得抓）。
  assertCaught(
    { source: "export const P = 'D:\\\\P\\\\somewhere\\\\repo';\n" },
    '指纹', /开发盘路径/, '字符串里的本机盘符路径必须被认出来'
  );
  // 第二代盲区：盘根后不再跟分隔符——引号、标点或行尾紧随的
  // 裸形态也得抓，否则 `'D:\\P'` 这类夹具残留整类漏检。
  assertCaught(
    { source: "export const P = 'D:\\\\P';\n" },
    '指纹', /开发盘路径/, '裸盘根（引号紧随、无尾随分隔符）也必须被认出来'
  );
});

test('P3 指纹：注释里的本机路径同样要报（注释也是公开范围）', () => {
  assertCaught(
    { source: '// 开发时锚到这个目录：D:\\P\\somewhere\n' },
    '指纹', /开发盘路径/, '注释里的机器路径一样会泄露'
  );
  assertCaught(
    { source: '// 盘根就在这：D:\\P\n' },
    '指纹', /开发盘路径/, '行尾收尾的裸盘根一样会泄露'
  );
});

test('P4 指纹：实例端口与服务名必须报', () => {
  assertCaught({ doc: '# 文档\n\n连 127.0.0.1:38114。\n' }, '指纹', /验证实例端口/, '实例端口是机器事实');
  assertCaught({ source: 'export const s = "dsh-web";\n' }, '指纹', /NSSM/, '服务名是机器事实');
});

test('P5 指纹假阳性守卫：上游公开包名不得被当成服务名', () => {
  // `dsh-web` 按子串匹配会把上游的 `dsh-web-app` / `dsh-webhook` / `dsh-web-fetch-http`
  // 全判成"本机服务名"（实测误报形态，一次 30+ 条）。
  const result = inspect({
    source: "export const a = '@deepseek-ai/dsh-web-app';\nexport const b = '@deepseek-ai/dsh-webhook';\n"
  });
  try {
    assert.deepEqual(result.findings, [], `上游包名不是本机指纹：\n${result.out}`);
  } finally {
    result.cleanup();
  }
});

test('P6 引用：公开文档引用下沉语料或事实编号必须报', () => {
  assertCaught({ doc: '# 文档\n\n依据见 `docs/facts.md`。\n' }, '引用', /事实登记簿/, '指向已下沉的语料');
  assertCaught({ doc: '# 文档\n\n来自 F65。\n' }, '引用', /事实编号/, '事实编号读者解不开');
  assertCaught({ doc: '# 文档\n\n见 docs/impl-review-r9.md。\n' }, '引用', /过程稿/, '过程稿名不该出现在公开文档');
});

test('P7 引用：源码里的同形串**不**报（那一族只扫文档）', () => {
  // 口径差异是有意的：代码注释里提一句"见某份登记簿"不影响读者读懂产品，
  // 而公开文档里的一句就得能独立读懂。
  const result = inspect({ source: "// 依据见 docs/facts.md 的 F65\nexport const x = 1;\n" });
  try {
    assert.deepEqual(result.findings, [], `源码不该被「引用」那一族扫：\n${result.out}`);
  } finally {
    result.cleanup();
  }
});

test('P8 结构：`.gitignore` 缺 `.local/` 或多出零散条目都必须报', () => {
  assertCaught({ ignore: 'node_modules/\n' }, '结构', /缺 .*条目/, '缺 `.local/` 会让本机侧漏进版本库');
  assertCaught({ ignore: `${CLEAN_IGNORE}verify/_scratch/\n` }, '结构', /未登记的 ignore 条目/,
    '零散条目会让"这东西属于哪一层"变成靠记忆回答的事');
});

test('隔离工作树目录可排除，公开清单入口不受影响', () => {
  const result = inspect({ ignore: `${CLEAN_IGNORE}.worktrees/\n`, doc: '[已知问题](issues.md)\n', extra: { '.worktrees/sample/private.md': 'D:\\P\\synthetic' } });
  try { assert.deepEqual(result.findings, [], result.out); } finally { result.cleanup(); }
});

test('P9 结构：非豁免源码里的 `.local/` 字面量必须报', () => {
  assertCaught({ extra: { 'lib/paths.js': "export const dir = '.local/evidence';\n" } },
    '结构', /只许出现在配置加载器/, '本机事实只能经配置加载器取');
});

test('P10 结构：豁免名单指向盘上不存在的文件必须报', () => {
  assertCaught({ skipAllowlisted: 'tools/_local-config.mjs' },
    '结构', /名单该清/, '登记了不存在的文件说明名单烂了');
});

test('P11 本机侧整个被跳过（判定依据是 `.gitignore`，不是硬编码目录名）', () => {
  // 两件事一起验：① `.local/` 下的东西不进公开范围；② 跳过表是从 `.gitignore` 推导的
  // ——所以把 `.local/` 换成别的名字，那一棵同样被跳过。
  const result = inspect({
    extra: {
      'scratch-plane/leak.js': "export const P = 'D:\\\\P\\\\leak';\n",
      'fixtures/leak.js': "export const P = 'D:\\\\P\\\\leak';\n"
    },
    ignore: `${CLEAN_IGNORE}scratch-plane/\n`
  });
  try {
    const files = result.findings.map((f) => f.file);
    assert.ok(!files.includes('scratch-plane/leak.js'),
      `.gitignore 里登记过的目录必须被跳过，实际命中：${files.join('、')}`);
    assert.ok(files.includes('fixtures/leak.js'),
      '未被忽略的目录必须照常扫——未跟踪的新文件正是最容易带本机路径溜进来的东西');
  } finally {
    result.cleanup();
  }
});

test('P12 `scope` 只限定扫描范围，不改变判据', () => {
  // scope 是给迁移期分块作业用的：限定前缀后，前缀外的命中不再出现，前缀内的照旧。
  const box = sandbox({
    source: "export const P = 'D:\\\\P\\\\leak';\n",
    doc: '# 文档\n\n见 docs/facts.md。\n'
  });
  try {
    const all = checkPublicSurface(box.root, { quiet: true });
    assert.ok(all.findings.some((f) => f.file === 'lib/index.js'), '不传 scope 时两个文件都要扫');
    assert.ok(all.findings.some((f) => f.file === 'docs/design.md'), '不传 scope 时两个文件都要扫');

    const onlyDocs = checkPublicSurface(box.root, { quiet: true, scope: ['docs/'] });
    assert.ok(onlyDocs.findings.every((f) => f.file.startsWith('docs/')),
      `scope 之外的文件不该出现：${onlyDocs.findings.map((f) => f.file).join('、')}`);
    assert.ok(onlyDocs.findings.some((f) => f.family === '引用'), 'scope 之内的判据照旧生效');
  } finally {
    box.cleanup();
  }
});

test('P13 豁免零命中守卫：登记了却从未用上的豁免必须报', () => {
  // 名单守卫的第二条：条目存在、本趟也扫了，但三类判据一次都没触发——
  // 这样的豁免是名单烂了（保护早已不存在的形态），按红处理。
  const box = sandbox();
  try {
    writeFileSync(join(box.root, 'tools/_local-config.mjs'), 'export const CLEAN = true;\n', 'utf8');
    const result = checkPublicSurface(box.root, { quiet: true });
    assert.ok(result.findings.some((f) => f.file === 'tools/_local-config.mjs' && /零命中/.test(f.why)),
      '存在但零命中的豁免条目必须报红');
    // 对照：其余豁免仍有影子命中，不连带误伤。
    assert.ok(!result.findings.some((f) => f.file !== 'tools/_local-config.mjs' && /零命中/.test(f.why)),
      '有影子命中的豁免条目不得连带报零命中');
  } finally {
    box.cleanup();
  }
});

test('P14 指纹假阳性守卫：npm lock 里的官方包 `@deepseek-ai/dsh-web` 不算本机服务名', () => {
  // `npm install` 生成的 lock 会在包键、依赖值、`node_modules/` 路径与 registry URL 里
  // 引用这个**已发布的公开包**，按官方 scope 区分即可。文档里用 Windows 分隔符写同一段
  // 包路径也是同一回事——判据只问"包名是不是紧邻已知官方 scope 前缀"。
  const lock = [
    '{',
    '  "name": "dsh-async-tools",',
    '  "lockfileVersion": 3,',
    '  "packages": {',
    '    "": {',
    '      "dependencies": {',
    '        "@deepseek-ai/dsh-web": "^0.2.1-rc.2"',
    '      }',
    '    },',
    '    "node_modules/@deepseek-ai/dsh-web": {',
    '      "version": "0.2.1-rc.2",',
    '      "resolved": "https://registry.npmjs.org/@deepseek-ai/dsh-web/-/dsh-web-0.2.1-rc.2.tgz"',
    '    }',
    '  }',
    '}',
    ''
  ].join('\n');
  const result = inspect({
    extra: {
      'package-lock.json': lock,
      'docs/notes.md': '# 文档\n\n打包产物在 `node_modules\\@deepseek-ai\\dsh-web\\lib\\index.js`。\n'
    }
  });
  try {
    assert.deepEqual(result.findings, [], `官方包不是本机指纹：\n${result.out}`);
  } finally {
    result.cleanup();
  }
});

test('P15 指纹真阳性守卫：裸 `dsh-web` 与其他 scope 仍然红（豁免只认已知官方 scope）', () => {
  // 豁免的是"包名紧邻官方 scope 前缀"这一种上下文，不是整个 lock、不是所有 JSON，
  // 也不是所有同名串：裸依赖键、裸包目录、文档正文、别的 scope 都照旧红。
  assertCaught(
    { extra: { 'package-lock.json': '{\n  "dependencies": {\n    "dsh-web": "file:../dsh-web"\n  }\n}\n' } },
    '指纹', /NSSM/, '裸 `dsh-web` 依赖键（如 file: 指向本机服务目录）必须报'
  );
  assertCaught(
    { extra: { 'lib/paths.js': 'export const p = "node_modules/dsh-web/lib/index.js";\n' } },
    '指纹', /NSSM/, '裸包目录不是官方 scope 形态，必须报'
  );
  assertCaught(
    { doc: '# 文档\n\n本机服务 dsh-web 没起来时要先起它。\n' },
    '指纹', /NSSM/, '文档正文里的服务名一样是机器事实'
  );
  assertCaught(
    { extra: { 'lib/scoped.js': "export const a = '@acme/dsh-web';\n" } },
    '指纹', /NSSM/, '别的 scope 下的同名包不能借官方包的名义豁免'
  );
});

test('P16 同一行里官方包与裸 `dsh-web` 并存时，只豁免官方包那一次', () => {
  // 判据是**逐次**匹配：负向上下文只看紧邻前缀，同一行里的合法包名不能豁免裸服务名。
  const line = '  "deps": { "@deepseek-ai/dsh-web": "^0.2.1-rc.2", "dsh-web": "file:../dsh-web" },';
  const result = inspect({ extra: { 'package.json': `{\n${line}\n}\n` } });
  try {
    const hits = result.findings.filter((f) => f.file === 'package.json');
    assert.equal(hits.length, 1, `同一行里裸的那次必须报出来：\n${result.out}`);
    assert.match(hits[0].why, /NSSM/);
  } finally {
    result.cleanup();
  }
});

for (const rel of ['README.en.md', 'docs/user-reference.md', 'docs/user-reference.en.md', 'docs/documentation-principles.md']) {
  test(`P17 新增文档 ${rel} 进入递归公开范围检查`, (t) => {
    const clean = inspect({ extra: { [rel]: CLEAN_DOC } });
    t.after(clean.cleanup);
    assert.equal(clean.code, 0, clean.out);
    const dirty = inspect({ extra: { [rel]: '# sample\nSee docs/facts.md.\n' } });
    t.after(dirty.cleanup);
    assert.equal(dirty.code, 1);
    assert.ok(dirty.findings.some((finding) => finding.file === rel && finding.family === '引用'), dirty.out);
  });
}

test('P18 worktree 指针豁免：仅仓根单行 `gitdir:` 指针文件跳过，借名与子目录同名文件照扫', () => {
  // 三腿钉住豁免形态（开发树在 git 链接工作树上，仓根 `.git` 是指针文件而非
  // 目录——豁免必须**先过内容校验**，不能按名整文件排除）：
  // ① 仓根 `.git` 为合法单行指针 → 豁免，指针里的本机路径不进扫描；
  // ② 仓根 `.git` 内容不是指针（借名藏泄漏）→ 必须照扫并报指纹；
  // ③ 子目录里的 `.git` 文件（worktree 指针只会长在仓根）→ 不豁免。
  const legit = inspect({
    extra: { '.git': 'gitdir: D:/P/dsh-async-tools/.git/worktrees/ci-fix-021\n' }
  });
  try {
    assert.equal(legit.code, 0, `合法 worktree 指针必须整文件豁免：\n${legit.out}`);
  } finally {
    legit.cleanup();
  }
  assertCaught(
    { extra: { '.git': "export const P = 'D:\\\\P\\\\leak';\n" } },
    '指纹', /开发盘路径/, '借 `.git` 名藏的泄漏内容不得因文件名被整文件豁免'
  );
  assertCaught(
    { extra: { 'sub/.git': 'gitdir: D:/P/dsh-async-tools/.git/worktrees/ci-fix-021\n' } },
    '指纹', /开发盘路径/, '子目录同名文件不在豁免面（指针只长在仓根）——内容里的盘路径必须被扫到'
  );
});

test('P19 引用假阳性守卫：连字符稳定编号不是事实编号或交付索引引用', () => {
  // 公开问题清单用 `WAIT-F02`／`DOC-DELIVERY-COMMENTS` 这类**连字符稳定编号**做
  // 当前问题 ID——它们内部同样出现 `F`＋数字与 `DELIVERY` 字样。判据按完整词元
  // 豁免：全大写段、关键词不在首段的公开 ID 形状不报；独立形态照旧红
  // （正负样本细节见 P20）。
  const result = inspect({
    doc: '# 文档\n\n'
      + '| WAIT-F02 | 零等待的子代理目录查询悬置时未及时结束检查。 |\n'
      + '| DOC-DELIVERY-COMMENTS | 注释与实际载体不符。 |\n'
      + '| CORE-LEG-B-01 | 受控锚。 |\n'
      + 'WAIT-NOTE-ID-01 同为稳定编号。\n'
  });
  try {
    assert.deepEqual(result.findings, [], `连字符稳定编号不该被当成内部引用：\n${result.out}`);
  } finally {
    result.cleanup();
  }
  assertCaught(
    { doc: '# 文档\n\n修前红形态见 SF-01／F07／D1 行。独立 F07 仍是登记簿引用。\n' },
    '引用', /事实编号/, '独立形态的事实编号照旧必须报（精度修复不得吞掉真引用）'
  );
  assertCaught(
    { doc: '# 文档\n\n交付索引见 DELIVERY-INDEX。\n' },
    '引用', /交付索引/, '普通上下文里的交付索引名照旧必须报'
  );
});

test('P20 引用回归：伪上下文不得因前一个字符豁免（foo-F07、x-DELIVERY 一类）', () => {
  // 旧判据只看关键词的前一个字符（负向后顾 `[A-Z-]`），`foo-F07`、`见-F07`、
  // `archive-DELIVERY-INDEX.md`、`x-DELIVERY` 都会整类漏放。现在按完整词元判：
  // 只有全大写段、关键词不在首段的公开稳定 ID 豁免。每个非法串**独占**一棵
  // 合成树——不与别的裸引用混栽，红必须归因到它自己。
  assertCaught(
    { doc: '# 文档\n\n下见 foo-F07 的说明。\n' },
    '引用', /事实编号/, '小写前缀词元不是公开稳定 ID，事实编号照报'
  );
  assertCaught(
    { doc: '# 文档\n\n见-F07 是漏放形态。\n' },
    '引用', /事实编号/, 'CJK 截断出的 `-F07` 词元不是公开稳定 ID'
  );
  assertCaught(
    { doc: '# 文档\n\n归档见 archive-DELIVERY-INDEX.md。\n' },
    '引用', /交付索引/, '小写前缀的归档索引链接不是公开稳定 ID'
  );
  assertCaught(
    { doc: '# 文档\n\n下见 x-DELIVERY 的说明。\n' },
    '引用', /交付索引/, '单字符小写前缀不构成公开稳定 ID'
  );
  // 混行：同一行既有公开稳定 ID，也有真实内部引用——后者必须抓到，且前者
  // 不得连带误报（恰一处命中即两个方向都钉住）。
  const mixedFact = inspect({ doc: '# 文档\n\n| WAIT-F02 | 修复后仍见 F07 的引用。 |\n' });
  try {
    assert.equal(mixedFact.findings.length, 1, `公开 ID 不豁免同行的裸引用、也不连带误报：\n${mixedFact.out}`);
    assert.match(mixedFact.findings[0].why, /事实编号/);
  } finally {
    mixedFact.cleanup();
  }
  const mixedDelivery = inspect({ doc: '# 文档\n\n| DOC-DELIVERY-COMMENTS | 仍引用 DELIVERY-INDEX。 |\n' });
  try {
    assert.equal(mixedDelivery.findings.length, 1, `公开 ID 不豁免同行的裸索引名、也不连带误报：\n${mixedDelivery.out}`);
    assert.match(mixedDelivery.findings[0].why, /交付索引/);
  } finally {
    mixedDelivery.cleanup();
  }
});
