/**
 * `tools/check-model-text.mjs` 第 3 层（硬编码文案层）的变异证明。
 *
 * 那一层挡的是"中文档下硬编码英文句子"这一类退化：
 * 既不触发 CJK 判据，也不在 `t()` 的键集里。这里用合成源码证明判据本身能红。
 *
 * 用法：node verify/mutate-model-text.mjs
 */
import { scanProseLiterals } from '../tools/check-model-text.mjs';

const results = [];
/**
 * 跑一条变异。
 *
 * @param {string} name - 变异名。
 * @param {boolean} expectHit - 期望是否命中。
 * @param {string} source - 合成源码。
 * @param {object} [opts] - 允许片段与操作者一侧行标记。
 */
function mutation(name, expectHit, source, opts = {}) {
  const hits = scanProseLiterals(source, opts.allowNeedles ?? [], opts.operatorMarkers ?? []);
  const ok = (hits.length > 0) === expectHit;
  results.push(ok);
  console.log(`${ok ? 'CAUGHT  ' : 'UNCAUGHT'} ${name}`);
  console.log(`          命中=${String(hits.length)}${hits.length === 0 ? '' : ` 首条=${JSON.stringify(hits[0].text.slice(0, 60))} 行=${String(hits[0].line)}`}`);
}

// 真实形态：三元表达式里带一句英文提示（不在 note/detail 行上，行内也没有 logger 标记）。
mutation('M1 三元表达式里的硬编码英文提示必须命中', true,
  `const hint = winner === 'interrupted' ? ' (a user message arrived during the wait)' : '';`);

mutation('M2 专门的文案表文件不该由本层负责（调用方排除 text.js）——表内字面量在这里仍会命中，'
  + '所以排除必须发生在调用方', true,
  `export const TEXT = { en: { 'note.x': 'a plain english hint' } };`);

mutation('M3 操作者一侧：logger 行上的英文说明不命中', false,
  `logger.debug('[async-tools] yielded to background job', { jobId });`,
  { operatorMarkers: ['logger.'] });

mutation('M4 操作者一侧：diag/stderr 行上的英文说明不命中', false,
  `diag('the wait concluded');\nprocess.stderr.write('host row not mounted\\n');`,
  { operatorMarkers: ['diag(', 'process.stderr'] });

mutation('M5 工具名/事件名这类标识符不算句子', false,
  `defineTool({ name: 'async_run' });\nctx.on('loader/volatile-update', handler);`);

mutation('M6 定长标记（宿主同款英文）由允许清单放行', false,
  `const marker = '[output truncated: 42 chars omitted]';`,
  { allowNeedles: ['[output truncated'] });

mutation('M7 换行/缩进拼接串不算文案', false,
  `const joined = '\\n' + '\\n  ' + value;`);

mutation('M8 模板串里的英文句子（未进表）必须命中', true,
  "return `${entry.id} (a diagnostic entry was reported)`;");

mutation('M8b 已知边界：半句 + 插值的碎片不命中（规则刻意不收，靠运行时层与审查兜）', false,
  "return `${entry.id} (diagnostic: ${reason})`;");

mutation('M9 注释里的英文句子不命中（先剥注释再扫）', false,
  `// a comment that looks like a sentence\nconst x = 1;`);

// 豁免走白名单/宿主副本豁免类路线时的「改锚必红」证明——覆盖是 needle 精确的
// includes 匹配，宿主逐字同形串被改一字（锚漂移）即失去豁免、重新命中。
mutation('M10 宿主副本豁免类改锚必红：串被改字（needle 不再覆盖）时必须重新命中', true,
  `function assertRoutes(routes) {\n`
  + `  if (!Array.isArray(routes)) throw new Error('subagent model selection requires a array of routes');\n`
  + `}`,
  { allowNeedles: ['subagent model selection requires an array of routes'] });

const uncaught = results.filter((ok) => !ok).length;
console.log(`\n${uncaught === 0 ? `全部变异都被抓住（${String(results.length)}/${String(results.length)}）` : `${String(uncaught)} 处没被抓住`}`);
process.exitCode = uncaught === 0 ? 0 : 1;
