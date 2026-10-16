/**
 * `async_run` 的完成分支必须把**退出状态**给模型看。
 *
 * ## 这条判据挡的缺口
 *
 * 真机转录可证："value 里有 exit_code，但 `output.render` 只发 output，
 * **模型看不到** `exit code: 0`。"
 *
 * 它是对的，而且比"少一行字"严重：**模型只看得见 `render` 的输出**
 * （`dsh-agent-loop` 用它的结果构造模型消息，结构化 `value` 不进上下文）。
 * 所以补这条之前，模型拿到 `async_run` 的文本后**无从判断命令成功还是失败**，
 * 而内置 `pwsh` 同等情形下会给出 `[exit code: 1]`——两个工具的"可读性"不一致。
 *
 * 判据直接调 `tool.output.render`（不是读 `value`），因为**只有 render 的输出到得了模型**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunTool as buildRunTool } from '../lib/jobs.js';
import { resolveConfig } from '../lib/config.js';
import { checkedTool, fakeAgent, fakeCtx, fakeProc } from './_helpers.mjs';

const config = resolveConfig({ toolName: 'async_run' });
const exec = { agent: fakeAgent(), signal: new AbortController().signal };

/**
 * 跑一次 `async_run` 并取回**模型可见文本**（`render` 的输出）。
 *
 * @param {object} procOptions - 传给 `fakeProc` 的选项。
 * @returns {Promise<{value: object, rendered: string}>} 结构化值与渲染文本。
 */
async function runAndRender(procOptions) {
  const f = fakeCtx();
  const { proc, settle } = fakeProc({ text: 'OUT', status: 'running', autoResolve: false, ...procOptions });
  f.installShellExecute(() => Promise.resolve(proc));
  const tool = checkedTool(buildRunTool(f.ctx, config));
  const pending = tool.execute({ command: 'x', description: 'x' }, exec);
  settle();
  const value = await pending;
  // `render` 返回 `[{type:'text', text}]`；模型看到的就是那个 text。
  const rendered = tool.output.render({}, value).map((part) => part.text ?? '').join('');
  return { value, rendered };
}

test('R11：非零退出必须在模型可见文本里给出 `[exit code: N]`', async () => {
  const { value, rendered } = await runAndRender({ exitCode: 1 });
  assert.equal(value.exit_code, 1, '结构化值里本来就有退出码');
  assert.match(rendered, /\[exit code: 1\]/,
    '模型只看得见 render 的输出——不写进 render，退出码等于没给');
});

test('R11：干净退出（0、无信号）**不产生**退出码标记（与内置一致，不制造噪声）', async () => {
  const { rendered } = await runAndRender({ exitCode: 0 });
  assert.doesNotMatch(rendered, /\[exit code:/, '成功不该有标记——内置 pwsh 也是这个口径');
});

test('R11：信号杀死必须给出 `[killed by signal: X]`', async () => {
  const { rendered } = await runAndRender({ exitCode: 1, signal: 'SIGTERM' });
  assert.match(rendered, /\[killed by signal: SIGTERM\]/,
    '被信号杀死与"自己返回非零"是两回事，模型要分得清');
});

test('R11：退出码标记与沙箱标记**同时**出现时各占一行、都不丢', async () => {
  const f = fakeCtx();
  const { proc, settle } = fakeProc({ text: 'OUT', exitCode: 1, status: 'running', autoResolve: false });
  proc.sandbox = { mode: 'workspace-write', denied: true };
  f.installShellExecute(() => Promise.resolve(proc));
  // `ctx.get` 与 `sandboxMode` 都必须**在建工具之前**装好：
  // 构造期就要读 `ctx.shell.sandboxMode` 来决定声明不声明提权字段；
  // 而 execute 里要 `ctx.get('sandboxPolicy')`。装晚了会得到
  // `TypeError: ctx.get is not a function`（度量口径陷阱）。
  f.ctx.shell.sandboxMode = 'workspace-write';
  f.ctx.get = (key) => (key === 'sandboxPolicy'
    ? { resolve: () => ({ mode: 'workspace-write' }) }
    : undefined);
  const tool = checkedTool(buildRunTool(f.ctx, config));
  const pending = tool.execute({ command: 'x', description: 'x' }, exec);
  settle();
  const value = await pending;
  const rendered = tool.output.render({}, value).map((part) => part.text ?? '').join('');

  assert.match(rendered, /\[exit code: 1\]/, '退出码不能因为沙箱标记而丢');
  assert.match(rendered, /\[sandbox: file access denied under workspace-write mode\]/, '沙箱标记不能丢');
  assert.match(rendered, /\[sandbox: escalation available/, '同轮提示不能丢');
});
