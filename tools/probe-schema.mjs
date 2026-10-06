/**
 * schema 方言探针：在改正式实现前，验证 `defineTool` 接受哪一种 schema 形状。
 * 用法：`node --import ./tools/_host-hooks.mjs tools/probe-schema.mjs`
 *
 * 背景：dsh 的 `ParameterSchemaSpec` / `output.schema` 是**自有 DSL**（每个键自带
 * `required: true`，每个节点必须有 `type`），不是标准 JSON Schema 的 `required: []` 数组。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

/** 试编译一个定义，返回是否成功。 */
function tryDefine(label, definition) {
  try {
    defineTool(definition);
    console.log(`OK    ${label}`);
    return true;
  } catch (error) {
    console.log(`FAIL  ${label}\n      ${error.message}`);
    if (Array.isArray(error.violations)) for (const v of error.violations) console.log(`        - ${v}`);
    return false;
  }
}

const base = {
  name: 'probe_schema',
  description: 'x',
  output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'x' }] },
  execute: async () => 'x'
};

tryDefine('每个键自带 required:true 的 parameters', {
  ...base,
  parameters: {
    command: { type: 'string', required: true, description: 'x' },
    yield_ms: { type: 'number', description: 'y' }
  }
});

tryDefine('数字枚举 enum（无 required）', {
  ...base,
  parameters: { action: { type: 'string', required: true, enum: ['a', 'b'] } }
});

tryDefine('output.schema 用自有 DSL 对象', {
  ...base,
  parameters: { a: { type: 'string', required: true } },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', required: true },
        note: { type: 'string' }
      }
    },
    render: () => [{ type: 'text', text: 'x' }]
  }
});

tryDefine('output.schema 用 oneOf 联合', {
  ...base,
  parameters: { a: { type: 'string', required: true } },
  output: {
    schema: {
      oneOf: [
        { type: 'object', additionalProperties: false, properties: { status: { type: 'string', required: true, const: 'completed' }, output: { type: 'string', required: true } } },
        { type: 'object', additionalProperties: false, properties: { status: { type: 'string', required: true, const: 'running' }, job_id: { type: 'string', required: true } } }
      ]
    },
    render: () => [{ type: 'text', text: 'x' }]
  }
});

tryDefine('parameters 用 oneOf 联合（多工具实例的配置判别）', {
  ...base,
  parameters: { a: { type: 'string', oneOf: [{ type: 'string', const: 'a' }, { type: 'string', const: 'b' }] } }
});
