/**
 * schema 方言探针 2（方言探索与复现入口）：探 dsh 自有 DSL 里"可空数字/可空
 * 字符串"各写法在宿主校验器下的判读差异。
 *
 * 背景：`async_run` 完成分支的原始进程事实里 `signal` 可能是 `null`、
 * `exit_code` 在进程未给码时也可能是 `null`；若无条件按
 * `{status:'completed', exit_code:0, signal:null, output, truncated:false}` 形态
 * 写值，宿主校验器对声明与值不符的可空形态会判
 * `"value" must match exactly one oneOf branch (matched 0)`——那一支就**通不过校验**，
 * 调用会变成 `tool "async_run" returned invalid output`。
 *
 * 嫌疑点：`exit_code` 与 `signal` 声明成 `{ type: 'number' }` / `{ type: 'string' }`
 * 时，`signal` 的实际值 `null`、`exit_code` 在进程未给码时的 `null` 都过不了该声明。
 * 该 DSL 允许哪种可空写法，由本探针逐个试、宿主校验器现判。
 *
 * 现行防线与现行写法：产品现行口径是"没值就不写这个键"（lib/jobs.js 的
 * completedResult——DSL 属性默认可选，只有 `required: true` 必须出现），即下方
 * 第 4 组形态；第 1 组是**坏形状反例**（裸类型声明＋值带 null——历史坑的复现
 * 样例），不是现行写法。常规防线在 test/_helpers.mjs：assertOutputShape／
 * checkedTool 把每条用例的 execute 返回值都过一遍当前宿主校验器，可空声明写坏
 * 会当场红；本脚本保留为方言探索与复现入口，不是唯一把关者。
 *
 * 用法：node --import ./tools/_host-hooks.mjs tools/probe-nullable-schema.mjs
 */
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

/** 试一种 schema 对一组值，打印每种值是否通过。 */
function trySchema(label, schema, samples) {
  let supported = true;
  let why = '';
  try {
    assertSupportedJsonSchema(schema);
  } catch (error) {
    supported = false;
    why = error.message;
  }
  if (!supported) {
    console.log(`FAIL  ${label}\n      assertSupportedJsonSchema: ${why}`);
    return;
  }
  const results = samples.map(({ name, value }) => {
    const violations = validateJsonSchemaValue(schema, value);
    return `${name}=${violations.length === 0 ? 'OK' : 'NO(' + violations[0] + ')'}`;
  });
  console.log(`OK    ${label}\n      ${results.join('  ')}`);
}

const COMPLETED = (exitCodeSchema, signalSchema, extraKey) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, const: 'completed' },
    exit_code: exitCodeSchema,
    signal: signalSchema,
    output: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    ...(extraKey === undefined ? {} : { note: { type: 'string' } })
  }
});

const withExit = (extra) => ({ status: 'completed', output: 'x', truncated: false, signal: null, ...extra });
const withSignal = (extra) => ({ status: 'completed', output: 'x', truncated: false, exit_code: 0, ...extra });

// 1) 反例（坏形状）：裸 number / 裸 string，而值带 null——历史坑的复现样例，
//    不是现行写法；exit=null / signal=null 两读数在本组应判 NO。
trySchema('反例（坏形状）：裸 number/string 声明＋值带 null', COMPLETED({ type: 'number' }, { type: 'string' }), [
  { name: 'exit=0', value: withExit({ exit_code: 0 }) },
  { name: 'exit=null', value: withExit({ exit_code: null }) },
  { name: 'signal=null', value: withSignal({ signal: null }) }
]);

// 2) 可空写法 A：type 数组
trySchema('type: ["number","null"]', COMPLETED({ type: ['number', 'null'] }, { type: ['string', 'null'] }), [
  { name: 'exit=0', value: withExit({ exit_code: 0 }) },
  { name: 'exit=null', value: withExit({ exit_code: null }) },
  { name: 'signal=null', value: withSignal({ signal: null }) }
]);

// 3) 可空写法 B：节点级 oneOf
trySchema('oneOf [{number},{null}]', COMPLETED(
  { oneOf: [{ type: 'number' }, { type: 'null' }] },
  { oneOf: [{ type: 'string' }, { type: 'null' }] }
), [
  { name: 'exit=0', value: withExit({ exit_code: 0 }) },
  { name: 'exit=null', value: withExit({ exit_code: null }) },
  { name: 'signal=null', value: withSignal({ signal: null }) }
]);

// 4) 可空写法 C：可选 + 缺省（字段干脆不出现）——产品现行口径（"没值就不写
//    这个键"，lib/jobs.js 的 completedResult）落在这一组。
trySchema('可选（无 required，值为 undefined 时不出现）＝产品现行写法', COMPLETED({ type: 'number' }, { type: 'string' }), [
  { name: 'exit=0', value: withExit({ exit_code: 0 }) },
  { name: 'exit 缺省', value: { status: 'completed', output: 'x', truncated: false, signal: null } },
  { name: 'signal 缺省', value: { status: 'completed', output: 'x', truncated: false, exit_code: 0 } }
]);

// 5) note 是否会破坏 additionalProperties:false
trySchema('带 note 的完成分支（note 已声明）', COMPLETED({ oneOf: [{ type: 'number' }, { type: 'null' }] }, { oneOf: [{ type: 'string' }, { type: 'null' }] }, 'with-note'), [
  { name: '无 note', value: withExit({ exit_code: 0 }) },
  { name: '有 note', value: withExit({ exit_code: 0, note: 'n' }) }
]);
