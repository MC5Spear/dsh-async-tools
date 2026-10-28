/**
 * 探针：`defineTool` 对 `parameters` 的**取值器**做了什么？
 *
 * 核对 `defineTool` 是否把转换结果存成稳定属性（定义时转换一次，每次访问
 * 同一对象、不随访问重建），以及参数的 `description` 被搬到哪里。描述的就地
 * 刷新（`lib/index.js` 的 refreshToolDescriptions）按
 * `parameters.properties[key].description` 改写，前提正是这份稳定属性——
 * 本探针把这条前提打成可复核的输出。
 *
 * 用法：node --import ./tools/_host-hooks.mjs tools/probe-deftool-parameters.mjs
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

/** `defineTool` 要求 `output.schema` 在场（缺席在入口抛）；`render` 缺席在
 * 宿主首次渲染时才暴露——这里两样都带全。 */
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

console.log('');
console.log('--- 转换结果是否稳定存储 ---');
// 就地刷新改写的是 properties[key].description——前提是 defineTool 把转换结果
// 存成稳定属性：两次访问拿到同一对象，而不是按访问重建。
console.log(`两次访问同一对象     : ${plain.parameters === plain.parameters}`);
