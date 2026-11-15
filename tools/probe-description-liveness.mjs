/**
 * 探针（已定论）：工具表对 `description` 是**注册时快照**还是**调用时读取**？
 *
 * 结论：注册接口把 description 当**值**传走（字符串快照）——就地改已注册对象
 * 的 description 对工具表无效，设置改动后要换描述必须**重新注册**。需求 §5.1
 * 的「预算数字跟着变」即按此结论走重注册路径（refreshToolDescriptions）。
 *
 * 边界（如实声明）：本探针用的是手写替身注册接口，只能证明「注册时把
 * description 当值传走」这一层；真实工具表由 dsh-tools 实现，真实宿主上的
 * 验证由 settings/language 类真机探针承担。
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
  console.log('结论：宿主**持有字符串快照** → 改 description 对已注册条目无效，必须重新注册。');
} else {
  console.log('结论：宿主**按引用读取** → 就地改 description 即可生效。');
}
console.log('（注意：本探针用的是手写替身，真实工具表由 dsh-tools 实现——'
  + '上面的结论只能证明"注册接口把 description 当值传走了"，不能替代真实宿主上的验证。）');
