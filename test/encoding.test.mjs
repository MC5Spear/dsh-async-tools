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

/** 真实双重编码的一段样本（由 CP936 往返生成，汉字是"楠岃瘉瀹炰緥"这类）。 */
const DOUBLE_ENCODED_SAMPLE = '楠岃瘉瀹炰緥绔埌绔瘉鎹';
const DOUBLE_ENCODED_LONG = '杩欐槸涓€涓甯哥殑涓枃鎶€鏈枃妗ｆ钀斤紝鐢ㄦ潵浣滀负鍩虹嚎銆傚畠鍖呭惈鏍囩偣銆佽嫳鏂囧崟璇嶅 async_wait_job';

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
  const traditional = '這是一個正常的中文技術文檔段落，用來作為基準。它包含標點、英文單詞如 async_wait_job，以及一些數字 12345 和代碼。';
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
  // 正确处置是显式豁免，且豁免必须**写在文件里**（逐行标记，不是文件白名单）。
  const exempted = `<!-- ENCODING-OK: 合法生僻字样本 -->\n${rare}`;
  assert.equal(inspectText(exempted).doubleEncoded, false, 'ENCODING-OK 标记必须能豁免');
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

test('编码判据：正常中文与纯英文都不得被误报', () => {
  const normal = '这是一个正常的中文技术文档段落，用来作为基线。它包含标点、英文单词如 async_wait_job，以及一些数字 12345。';
  assert.equal(inspectText(normal).doubleEncoded, false);
  assert.ok(inspectText(normal).ratio > 0.85, '正常中文占比应显著高于阈值');
  assert.equal(inspectText('plain english only, no han characters here.').doubleEncoded, false);
});
