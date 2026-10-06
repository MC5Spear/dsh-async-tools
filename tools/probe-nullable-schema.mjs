/**
 * schema 方言探针 2：找出 dsh 自有 DSL 里"可空数字/可空字符串"的正确写法。
 *
 * 背景（真机实测）：`async_run` 的完成分支返回
 * `{status:'completed', exit_code:0, signal:null, output, truncated:false}`，
 * 宿主校验器直接判 `"value" must match exactly one oneOf branch (matched 0)`——
 * 也就是说这一支**从来没能通过校验**，任何没让出的 `async_run` 调用都会变成
 * `tool "async_run" returned invalid output`。整包单测全绿也照样漏，因为单测只断言字段、
 * 没有用宿主校验器验过 schema 本体。
 *
 * 嫌疑点：`exit_code` 与 `signal` 声明成 `{ type: 'number' }` / `{ type: 'string' }`，
 * 而 `signal` 的实际值是 `null`、`exit_code` 在进程未给码时也可能是 `null`。
 * 未知的是**该 DSL 允许哪一种可空写法**——这里逐个试。
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

// 1) 现状：裸 number / 裸 string
trySchema('现状 exit_code={number} signal={string}', COMPLETED({ type: 'number' }, { type: 'string' }), [
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

// 4) 可空写法 C：可选 + 缺省（字段干脆不出现）
trySchema('可选（无 required，值为 undefined 时不出现）', COMPLETED({ type: 'number' }, { type: 'string' }), [
  { name: 'exit=0', value: withExit({ exit_code: 0 }) },
  { name: 'exit 缺省', value: { status: 'completed', output: 'x', truncated: false, signal: null } },
  { name: 'signal 缺省', value: { status: 'completed', output: 'x', truncated: false, exit_code: 0 } }
]);

// 5) note 是否会破坏 additionalProperties:false
trySchema('带 note 的完成分支（note 已声明）', COMPLETED({ oneOf: [{ type: 'number' }, { type: 'null' }] }, { oneOf: [{ type: 'string' }, { type: 'null' }] }, 'with-note'), [
  { name: '无 note', value: withExit({ exit_code: 0 }) },
  { name: '有 note', value: withExit({ exit_code: 0, note: 'n' }) }
]);
