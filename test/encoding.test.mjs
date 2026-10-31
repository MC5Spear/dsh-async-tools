/**
 * 编码体检判据的测试（断言 A–D 四族：双重编码两形态、繁体误报豁免、CRLF 上报、字表规模）。
 *
 * 为什么这些用例必须存在：`tools/check-encoding.mjs` 是**验证手段本身**。只查
 * `U+FFFD` 抓不住双重编码（字节完全合法、`U+FFFD` 计数为 0）。
 * 一个报"全部正常"的扫描器，必须能回答"它能失败吗"。
 *
 * 样本来源：本机 CP936 样本生成脚本（.NET 的 **CP936**）生成真实双重编码文本
 * （Node 没有内置 CP936 解码器；用 latin1 模拟出来的"乱码"不含汉字，调参无意义）。
 * 这里把生成结果的**判据形状**复现为内联断言，不依赖那份外部样本目录是否存在。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectText, assertBaseline, COMMON_CHARS } from '../tools/_encoding-core.mjs';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { LOCAL_DIR } from '../tools/_local-config.mjs';

/** 真实双重编码的一段样本（由 CP936 往返生成，汉字是"楠岃瘉瀹炰緥"这类）。 */
const DOUBLE_ENCODED_SAMPLE = '楠岃瘉瀹炰緥绔埌绔瘉鎹';
const DOUBLE_ENCODED_LONG = '杩欐槸涓€涓甯哥殑涓枃鎶€鏈枃妗ｆ钀斤紝鐢ㄦ潵浣滀负鍩虹嚎銆傚畠鍖呭惈鏍囩偣銆佽嫳鏂囧崟璇嶅 async_wait';

test('编码判据（#7 断言 A）：短的双重编码文件必须被判 DOUBLE-ENC', () => {
  const verdict = inspectText(DOUBLE_ENCODED_SAMPLE);
  assert.ok(verdict.han > 0, '样本本身必须含汉字（否则测的是别的东西）');
  // 样本只有 11 个汉字——门槛若按汉字绝对数（han >= 50）设，短文件会被整个跳过（漏报）。
  assert.ok(verdict.han < 50, `样本汉字数应小于 50（短文件不得被跳过），实际 ${String(verdict.han)}`);
  assert.equal(verdict.doubleEncoded, true, `短双重编码被漏报了：占比=${verdict.ratio.toFixed(3)}`);
});

test('编码判据（#7 断言 A2）：长的双重编码文件同样必须被判 DOUBLE-ENC', () => {
  assert.equal(inspectText(DOUBLE_ENCODED_LONG).doubleEncoded, true);
});

test('编码判据（#7 断言 B）：合法繁体不得被误报', () => {
  const traditional = '這是一個正常的中文技術文檔段落，用來作為基準。它包含標點、英文單詞如 async_wait，以及一些數字 12345 和代碼。';
  const verdict = inspectText(traditional);
  // 繁体占比天然比简体低（实测 0.675），但仍在安全带内，不该报。
  assert.equal(verdict.doubleEncoded, false, `合法繁体被误报：占比=${verdict.ratio.toFixed(3)}`);
  assert.ok(verdict.ratio > 0.6, '繁体占比应高于阈值（这条断言把阈值钉住，防止有人调到会误报的值）');
});

test('编码判据（#7 断言 B2）：合法低占比内容可以用 ENCODING-OK 显式豁免', () => {
  const rare = '龘靐齉爩鱻麤龗灪龖厵爨癵籱饢驫鲡鸜麣纞虋讟钃麷鞻韽韾顟顠饙饔饕饗饛饜饞饟饠';
  // 纯生僻字与双重编码在"没有高频字"上**不可区分**（判据能看的就是字符分布），
  // 所以它默认会被报。这是刻意的：猜的代价是漏报真实损坏。
  assert.equal(inspectText(rare).doubleEncoded, true, '生僻字内容默认会被报（不可区分）');
  // 正确处置是显式豁免。豁免是**文件级**的（占比判据是全文统计量，行级豁免
  // 无判定力），与 U+FFFD 的行级示例豁免不同粒度——见 _encoding-core.mjs 头注。
  const exempted = `<!-- ENCODING-OK: 合法生僻字样本 -->\n${rare}`;
  assert.equal(inspectText(exempted).doubleEncoded, false, 'ENCODING-OK 标记必须能豁免');
});

test('编码判据（D02 豁免边界）：标记豁免占比判定，不豁免 U+FFFD/CRLF——四形态分列', () => {
  // ① 同行替换字符：U+FFFD 带示例标记（同粒度=行）→ 该行豁免。
  assert.equal(inspectText('示例 ENCODING-EXAMPLE：\uFFFD 损坏长什么样').hardBroken, 0, '行级示例豁免只免当行');
  // ② ENCODING-OK 在别的行、U+FFFD 在另一行：文件级豁免**管不到** U+FFFD 检查。
  assert.equal(
    inspectText('<!-- ENCODING-OK: 合法生僻字样本 -->\n别处混入的\uFFFD').hardBroken, 1,
    'ENCODING-OK 不豁免非法字节检查（两类判据照常全量生效）'
  );
  // ③ 合法文本：无标记、占比正常 → 全绿（不因标记机制误伤）。
  const legit = inspectText('这是一段正常中文正文，包含常用字与 async_wait 等标识。');
  assert.equal(legit.doubleEncoded, false);
  assert.equal(legit.hardBroken, 0);
  // ④ 损坏文本：真双重编码 + 恰好带 ENCODING-OK 行 → 占比通道被豁免（这是
  //    头注已声明的风险），但 U+FFFD 若在场仍会拦——占比通道的漏过不等于全绿。
  const doubleEncWithMarker = `<!-- ENCODING-OK -->\n${'澶嶆牳娓呭崟'.repeat(20)}`;
  assert.equal(inspectText(doubleEncWithMarker).doubleEncoded, false, '占比通道按文件级约定豁免（人工确认语义）');
  assert.equal(
    inspectText(`<!-- ENCODING-OK -->\n${'澶嶆牳娓呭崟'.repeat(20)}\n\uFFFD`).hardBroken, 1,
    '同文件混入非法字节仍被拦——豁免范围没有扩大到其他判据'
  );
});

test('编码判据（#7 断言 C）：CRLF 必须被报出来（而不只是打印）', () => {
  const verdict = inspectText('line one\r\nline two\r\n');
  assert.equal(verdict.crlf, 2, 'CR 计数必须被回报，CLI 才能把它计入退出码');
});

test('编码判据（#7 断言 D）：字表规模与声明一致', () => {
  // 声明的规模与字表实际大小脱节时没有任何东西会变红——这里把两者钉在一起。
  assert.doesNotThrow(() => { assertBaseline(); }, '字表规模与声明不符');
  assert.equal(COMMON_CHARS.size, 1171, '字表规模变了就要同步改 DECLARED_COMMON_COUNT');
});

test('编码判据：U+FFFD 只有带示例标记的行才豁免', () => {
  // 不带标记 → 算违规。
  assert.equal(inspectText('正常一行\n坏了一行 \uFFFD\n').hardBroken, 1);
  // 带标记 → 豁免，且被单独计数（不能悄悄吞掉）。
  const exempted = inspectText('示例（ENCODING-EXAMPLE）：\uFFFD 就是损坏的样子\n');
  assert.equal(exempted.hardBroken, 0);
  assert.equal(exempted.excused, 1);
});

// 复用 CLI 的递归逻辑，以合成文件系统输入验证扫描范围，不启动子进程。
function scanEncoding(root) {
  const source = readFileSync(new URL('../tools/check-encoding.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '');
  const lines = [];
  let code;
  runInNewContext(source, {
    readFileSync: (file, ...args) => readFileSync(join(root, file), ...args),
    readdirSync: (dir, ...args) => readdirSync(join(root, dir), ...args),
    join, relative, inspectText, LOCAL_DIR,
    console: { log: (...args) => lines.push(args.join(' ')) },
    process: { exit: (value) => { code = value; } }
  });
  return { code, out: lines.join('\n') };
}

for (const rel of ['README.en.md', 'docs/user-reference.md', 'docs/user-reference.en.md', 'docs/documentation-principles.md']) {
  test(`编码扫描：新增文档 ${rel} 不能漏扫`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'encoding-input-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), '# Normal 文档\n', 'utf8');
    assert.equal(scanEncoding(dir).code, 0);
    for (const [sample, label] of [['broken \uFFFD\n', 'HARD-BROKEN'], ['line\r\n', 'CRLF']]) {
      writeFileSync(join(dir, rel), sample, 'utf8');
      const dirty = scanEncoding(dir);
      assert.equal(dirty.code, 1);
      assert.ok(dirty.out.includes(`${label}`) && dirty.out.includes(rel), dirty.out);
    }
  });
}

test('编码判据：正常中文与纯英文都不得被误报', () => {
  const normal = '这是一个正常的中文技术文档段落，用来作为基线。它包含标点、英文单词如 async_wait，以及一些数字 12345。';
  assert.equal(inspectText(normal).doubleEncoded, false);
  assert.ok(inspectText(normal).ratio > 0.85, '正常中文占比应显著高于阈值');
  assert.equal(inspectText('plain english only, no han characters here.').doubleEncoded, false);
});
