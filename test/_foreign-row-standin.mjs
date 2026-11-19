/**
 * 进程内调用链的外来行替身（`test/config.test.mjs` 消费）。
 *
 * 模拟宿主自身的工具行（如 `subagent`）：带自己的 `toolName` 字段与无关的
 * config 键，Config schema 是**外来**的（不是本包的 Config）。供
 * `internal/config` waterfall 的归属甄别断言使用——外来行的候选流经本包
 * 监听时不得进本包自检（假降级会污染模型可见的描述警示段）。
 */
import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  toolName: z.string(),
  models: z.array(z.string()),
  // N-CFG-01 真实链 ⑦ 腿：外来行携带 `{settings: {...}}` 形状的候选（键集与
  // 本包设置子树碰撞的嵌套行形态）——schema 放行任意 settings 子树，让候选
  // 流经本包 internal/config 监听（判「不进本包自检」的正是归属甄别）。
  settings: z.any()
});

export const name = 'dsh-async-tools-f04-foreign-standin';

export const STATE = { applies: 0 };

export function apply() {
  STATE.applies += 1;
}
