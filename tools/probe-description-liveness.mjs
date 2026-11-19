/**
 * 探针（替身演示）：展示「注册时快照」与「按引用读取」两种工具表形态的可判读差异。
 *
 * 为什么要探：需求 §5.1 要求设置改动后工具描述里的预算数字跟着变。工具表在注册时
 * 把 description 当**值**抄走、还是持**对象引用**现读，决定「就地改对象上的
 * description」能否生效。两种形态的判读读数长什么样，先在手写替身上看清，再到
 * 真实 dsh-tools 工具表上核对——本探针不为该问题给出宿主结论。
 *
 * 本脚本的边界（如实）：这里用**手写替身**充当 tools 服务——替身自己的 register
 * 实现同时保存值副本与对象引用，输出的是两种形态各自的判读样例；「真实宿主是
 * 哪一种」不由本脚本回答（替身的结论由替身自己的写法决定，拿它当宿主结论是
 * 同义反复），须在真实 dsh-tools 工具表上另证。产品侧采用**就地刷新**：直接改写
 * 已注册工具对象上的 description／parameters 字段（lib/index.js 的
 * refreshToolDescriptions），不注销再重新注册——重新注册存在 `register()` 抛错后
 * 工具凭空消失的窗口，且当前宿主工具表按引用保存并在每次投影时现读字段。
 *
 * 用法：node --import ./tools/_host-hooks.mjs tools/probe-description-liveness.mjs
 */
import { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

const ctx = new Context();
const captured = [];

ctx.provide('tools', {
  register(definition) {
    // 记下**注册那一刻**宿主能看到的东西，以及它是否持有对象引用。
    captured.push({ at: captured.length, name: definition.name, description: definition.description, ref: definition });
    return () => {};
  }
});

const tool = defineTool({
  name: 'probe_tool',
  description: 'ORIGINAL_DESCRIPTION',
  parameters: { x: { type: 'string', required: true } },
  output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } } },
  execute() { return { ok: true }; }
});

ctx.tools.register(tool);
console.log(`注册后宿主记录到的描述: ${JSON.stringify(captured[0].description)}`);
console.log(`宿主记录的是同一个对象吗: ${captured[0].ref === tool}`);

// 就地改描述，再问宿主"它现在看到什么"。
tool.description = 'MUTATED_DESCRIPTION';
console.log('');
console.log('就地改对象后：');
console.log(`  宿主记录的字符串: ${JSON.stringify(captured[0].description)}`);
console.log(`  通过引用读到的值: ${JSON.stringify(captured[0].ref.description)}`);
console.log('');
if (captured[0].description === 'ORIGINAL_DESCRIPTION') {
  console.log('样例判读：值副本仍是原串（快照形态的判读样例）→ 若真实工具表也按注册时值副本保存，就地改 description 不会反映到已注册条目——产品不会因本替身的快照读数改用重新注册，真实宿主属哪种须在真实工具表上另证。');
} else {
  console.log('样例判读：值副本随引用变化（按引用读取形态的判读样例）→ 该形态下就地改 description 即可生效。');
}
console.log('（注意：本探针用的是手写替身，真实工具表由 dsh-tools 实现——上面的输出'
  + '是两种形态的判读样例，真实宿主属哪种须在真实工具表上另证。产品采用就地刷新'
  + '（直接改写已注册工具对象上的 description／parameters 字段），不从本替身的'
  + '快照读数推导宿主必须重新注册。）');
