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
    put(file, '');
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
  assertCaught({ ignore: `${CLEAN_IGNORE}verify/_scratch/\n` }, '结构', /零散 ignore 条目/,
    '零散条目会让"这东西属于哪一层"变成靠记忆回答的事');
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
