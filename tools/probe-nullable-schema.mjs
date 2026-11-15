/**
 * schema 方言探针 2（已定论）：dsh 自有 DSL 里「可空数字/可空字符串」的写法。
 *
 * 结论（现行产品采用）：`async_run` 的完成分支对 `exit_code`／`signal` 取
 * **可选＋缺省**——字段声明为单类型、不进 required，值不是该类型时整个键
 * 不出现（lib/jobs.js 完成分支：`exit_code`／`signal` 只在真的是该类型时
 * 才出现）。裸 type 收 `null` 会过不了宿主校验；type 数组与节点级 oneOf
 * 的接受情况由本探针逐项打印，供方言对照。
 *
 * 为什么单测挡不住：包内单测只断言字段，从不用宿主校验器验 schema 本体——
 * 写错的可空声明会让那一支直接 `tool "async_run" returned invalid output`。
 * 本探针用 `assertSupportedJsonSchema`＋`validateJsonSchemaValue` 补上这一层。
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
