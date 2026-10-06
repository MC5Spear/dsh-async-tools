/**
 * 编码判据实验台：用**真实 CP936 双重编码样本**量判据，决定阈值。
 *
 * 样本由本机 CP936 样本生成脚本（.NET 的 CP936）生成
 * （Node 没有内置 CP936 解码器；用 latin1 模拟出来的"乱码"不含汉字，调参无意义）。
 *
 * 用法：node tools/bench-encoding.mjs <样本目录>
 *
 * 样本目录**必须显式给**：样本是拿本机 .NET 的 CP936 现生成的临时物，没有可移植的
 * 默认落点；从前这里写死过一个本机路径，那是把"我的机器"当成了所有人都有的东西。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspectText, COMMON_CHARS } from './_encoding-core.mjs';

if (process.argv[2] === undefined) {
  console.error('用法：node tools/bench-encoding.mjs <样本目录>');
  process.exit(2);
}
const sampleDir = process.argv[2];

/** 期望：文件名以 double- 开头的才是双重编码。 */
function expectedDouble(name) {
  return name.startsWith('double-');
}

let mismatches = 0;
console.log(`字表大小=${String(COMMON_CHARS.size)}`);
console.log('');
console.log('=== 真实 CP936 样本 ===');
for (const name of readdirSync(sampleDir).sort()) {
  const text = readFileSync(join(sampleDir, name), 'utf8');
  const v = inspectText(text);
  const want = expectedDouble(name);
  const got = v.doubleEncoded;
  const ok = want === got;
  if (!ok) mismatches += 1;
  console.log(
    `${ok ? 'OK    ' : 'WRONG '} ${name.padEnd(20)} 汉字=${String(v.han).padStart(4)} `
    + `占比=${v.ratio.toFixed(3)} CR=${String(v.crlf)} 判=${got ? 'DOUBLE-ENC' : 'pass'} 应为=${want ? 'DOUBLE-ENC' : 'pass'}`
  );
}

console.log('');
console.log('=== 内联样本（合法但低占比 / 边界）===');
//
// 注意 `合法生僻字` 的期望是 **DOUBLE-ENC**（会被报），这不是判据的缺陷：
// 纯生僻字内容与双重编码在"没有高频字"这一点上**不可区分**——判据能看的就是字符分布。
// 正确处置是**显式豁免**（下一行的 `生僻字 + ENCODING-OK`），而不是让判据去猜。
// 猜的代价是漏报真实损坏，那正是这个工具存在的理由。
const INLINE = [
  ['合法繁体', '這是一個正常的中文技術文檔段落，用來作為基準。它包含標點、英文單詞如 async_wait_job，以及一些數字 12345 和代碼。', false],
  ['合法生僻字（无法与损坏区分，应报）', '龘靐齉爩鱻麤龗灪龖厵爨癵籱饢驫鲡鸜麣纞虋讟钃麷鞻韽韾顟顠饙饔饕饗饛饜饞饟饠', true],
  ['生僻字 + ENCODING-OK（正确处置）', '<!-- ENCODING-OK: 合法生僻字样本 -->\n龘靐齉爩鱻麤龗灪龖厵爨癵籱饢驫鲡鸜麣纞虋讟', false],
  ['繁体 + ENCODING-OK', '<!-- ENCODING-OK: 合法繁体样本 -->\n這是一個正常的中文技術文檔段落，用來作為基準。', false],
  ['纯英文', 'plain english only, no han characters here.', false],
  ['极短合法中文', '验证实例', false],
  ['CRLF 内容', 'line one\r\nline two\r\n', false]
];
for (const [label, text, want] of INLINE) {
  const v = inspectText(text);
  const ok = v.doubleEncoded === want;
  if (!ok) mismatches += 1;
  console.log(
    `${ok ? 'OK    ' : 'WRONG '} ${label.padEnd(20)} 汉字=${String(v.han).padStart(4)} `
    + `占比=${v.ratio.toFixed(3)} CR=${String(v.crlf)} 判=${v.doubleEncoded ? 'DOUBLE-ENC' : 'pass'} 应为=${want ? 'DOUBLE-ENC' : 'pass'}`
  );
}

console.log('');
console.log(mismatches === 0 ? '判据与预期完全一致。' : `有 ${String(mismatches)} 项不符。`);
process.exit(mismatches === 0 ? 0 : 1);
