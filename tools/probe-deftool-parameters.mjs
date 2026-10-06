/**
 * 探针：`defineTool` 对 `parameters` 的**取值器**做了什么？
 *
 * 背景：三处工具工厂把 `parameters.<name>` 与 `description` 改成了取值器，以便
 * "改设置后模型看到的描述立刻更新"（`dsh-tools` 按引用存 definition、投影时现读字段）。
 * 主描述已验证生效；但 `tool.parameters.yield_ms` 读到 `undefined`——
 * 需要先弄清 `defineTool` 是否原样保留参数对象，再决定怎么改。
 *
 * 用法：node --import ./tools/_host-hooks.mjs tools/probe-deftool-parameters.mjs
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

/** `defineTool` 要求 `output` 带 `schema` 与 `render`，否则在 :840 抛。 */
const output = {
  schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
  render: () => []
};

const plain = defineTool({
  name: 'p_plain',
  description: 'x',
  parameters: { a: { type: 'string', required: true } },
  output,
  execute() { return { ok: true }; }
});

const withGetter = defineTool({
  name: 'p_getter',
  description: 'x',
  parameters: {
    a: { type: 'string', required: true },
    get b() { return { type: 'number', required: true }; }
  },
  output,
  execute() { return { ok: true }; }
});

console.log('--- 普通对象 ---');
console.log(`parameters 存在      : ${plain.parameters !== undefined}`);
console.log(`keys                 : ${JSON.stringify(Object.keys(plain.parameters ?? {}))}`);
console.log(`a 存在               : ${plain.parameters?.a !== undefined}`);
console.log(`a.description        : ${String(plain.parameters?.a?.description)}`);
console.log(`a.required           : ${String(plain.parameters?.a?.required)}`);

console.log('');
console.log('--- 带取值器 ---');
console.log(`parameters 存在      : ${withGetter.parameters !== undefined}`);
console.log(`keys                 : ${JSON.stringify(Object.keys(withGetter.parameters ?? {}))}`);
console.log(`b 存在               : ${withGetter.parameters?.b !== undefined}`);
console.log(`b.required           : ${String(withGetter.parameters?.b?.required)}`);

console.log('');
console.log('--- 原始参数的描述从哪来 ---');
// 真实工厂里参数的 `description` 是字符串；这里看 defineTool 是否把它搬去了别处。
const withDescription = defineTool({
  name: 'p_desc',
  description: 'x',
  parameters: { a: { type: 'string', required: true, description: 'THE-DESC' } },
  output,
  execute() { return { ok: true }; }
});
const dumped = JSON.stringify(withDescription.parameters);
console.log(`JSON 里有 THE-DESC   : ${dumped.includes('THE-DESC')}`);
console.log(`JSON 片段            : ${dumped.slice(0, 200)}`);
