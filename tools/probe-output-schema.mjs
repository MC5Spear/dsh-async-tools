/**
 * 缺陷定位探针：把各工具的**实际返回值**喂给宿主自己的输出校验器。
 *
 * 为什么需要它：单测断言返回值的**字段**，宿主校验器验的是 `output.schema`
 * 本体，而 schema 校验只在运行时发生（`@deepseek-ai/dsh-tools/lib/index.js:3543`）
 * ——包内单测可能全绿，验证实例上仍报
 * `tool "async_run" returned invalid output: "value" must match exactly one oneOf branch (matched 0)`。
 * 常规防线在 `test/_helpers.mjs` 的 `assertOutputShape` / `checkedTool`（单测内建）；
 * 本探针是改 schema 之后的手工复核入口（单测绿≠宿主校验器绿）。
 *
 * 假件复用 `test/_helpers.mjs`（契约级替身：行为完整的假作业注册表 + `shell.execute`
 * 安装口 + `fakeProc`）——探针与单测共用同一套替身，契约再漂移会让单测先红，
 * 探针不会独自陈旧。
 *
 * 用法：`node --import ./tools/_host-hooks.mjs tools/probe-output-schema.mjs`；
 * 任一分支校验失败即非零退出。
 */
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { fakeCtx, fakeProc } from '../test/_helpers.mjs';
import { createAgentTool } from '../lib/agent.js';
import { createRunTool } from '../lib/jobs.js';
import { createWaitTool } from '../lib/wait.js';
import { resolveConfig } from '../lib/config.js';

const config = resolveConfig({});

/** 失败计数（决定退出码）。 */
let failures = 0;

const exec = { agent: { id: 'session-probe', session: { header: { cwd: 'Q:\\nowhere' }, requestHeader: () => ({}) }, requestHeader: () => ({}) }, signal: undefined };

/**
 * 跑一个工具并把结果喂给校验器。
 * @param {string} label - 工具名（打印用）。
 * @param {object} tool - `defineTool()` 的返回值。
 * @param {object} args - execute 参数。
 * @returns {Promise<void>} 打印结果。
 */
async function probe(label, tool, args) {
  let value;
  try {
    value = await tool.execute(args, exec);
  } catch (error) {
    failures += 1;
    console.log(`${label}: execute 抛错 → ${error.message}`);
    return;
  }
  // 注意：`validateJsonSchemaValue` 是**返回违规数组**，不是抛错（`dsh-tools:520-532`）。
  // 本探针若写成 try/catch，所有分支都会打印 OK——那正是它要抓的那类错误。
  // 抛 `ToolOutputError` 的是宿主那一层（`:3543`）。
  const violations = validateJsonSchemaValue(tool.output.schema, value);
  if (violations.length > 0) failures += 1;
  console.log(`${label}: ${violations.length === 0 ? 'OK' : `校验失败 → ${violations.join('; ')}`}`);
  if (violations.length > 0) {
    console.log(`       实际返回值 = ${JSON.stringify(value)}`);
    // 把**声明的 schema 本体**也打出来：判定"是值形状不对"还是"schema 声明不对"，
    // 只能靠它。
    console.log(`       声明 schema = ${JSON.stringify(tool.output.schema)}`);
  }
}

// 1) 短命令、正常退出码。
{
  const f = fakeCtx();
  f.installShellExecute(async () => fakeProc({ text: 'SHORT_OK\n', status: 'completed' }).proc);
  await probe('async_run(completed)', createRunTool(f.ctx, config),
    { command: 'Write-Output SHORT_OK', description: 'probe' });
}

// 2) 关键对照：进程没给出退出码（exitCode 为 null）时，完成分支的 schema 还成立吗？
{
  const f = fakeCtx();
  f.installShellExecute(async () => fakeProc({ text: 'SHORT_OK\n', exitCode: null, status: 'completed' }).proc);
  await probe('async_run(null-exit)', createRunTool(f.ctx, config),
    { command: 'Write-Output SHORT_OK', description: 'probe-null-exit' });
}

// 3) lossy 输出会把 `note` 塞进完成分支——`additionalProperties: false` 里必须有这个键。
{
  const f = fakeCtx();
  f.installShellExecute(async () => fakeProc({ text: '部分输出\n', status: 'completed', lossy: true }).proc);
  await probe('async_run(lossy)', createRunTool(f.ctx, config),
    { command: 'Write-Output x', description: 'probe-lossy' });
}

// 4) 让出分支（`status: "running"`）：命令永不结算。
{
  const f = fakeCtx();
  f.installShellExecute(async () => fakeProc({ text: '', status: 'running', autoResolve: false }).proc);
  await probe('async_run(running)', createRunTool(f.ctx, config),
    { command: 'Start-Sleep 1', description: 'probe-yield', yield_ms: 20 });
}

// 5) `async_wait`（作业目标）的两个分支：终态与未终态。
//    终态分支用假注册表造一个已结算作业（`settleJob` 是测试驱动结算的正式入口）。
{
  const f = fakeCtx();
  const wait = createWaitTool(f.ctx, config);
  {
    const id = f.jobsFake.service.start({
      kind: 'async-command', label: 'probe-wait', owner: exec.agent.id,
      run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed', result: 'job output' }) })
    });
    f.jobsFake.settleJob(id, { status: 'completed', result: 'job output' });
    await probe(`async_wait(job ${id})`, wait, { targets: [{ kind: 'job', id }], wait_ms: 100 });
  }
  {
    const id = f.jobsFake.service.start({
      kind: 'async-command', label: 'probe-wait-running', owner: exec.agent.id,
      run: () => ({ cancel: () => {}, done: new Promise(() => {}) })
    });
    await probe(`async_wait(job ${id}, running)`, wait, { targets: [{ kind: 'job', id }], wait_ms: 20 });
  }
}

// 6) `async_wait`（子代理目标）的两个分支：屏障即终态（settled）与查不到。
//    查无**抛可读错误**（error.unknownAgent 带纠错清单）——那是设计行为，不是
//    schema 违规：这里断言抛错消息形态，而不是喂校验器。
{
  const f = fakeCtx();
  const wait = createWaitTool(f.ctx, config);
  f.ctx.subagents.listChildren = async () => [
    { kind: 'child', id: 'child-1', mode: 'continuable', label: 'x', activity: 'inactive', hasChildren: false }
  ];
  await probe('async_wait(agent settled)', wait, { targets: [{ kind: 'agent', id: 'child-1' }], wait_ms: 50 });
  f.ctx.subagents.listChildren = async () => [];
  let notFoundError;
  try {
    await wait.execute({ targets: [{ kind: 'agent', id: 'child-1' }], wait_ms: 50 }, exec);
  } catch (error) {
    notFoundError = error;
  }
  if (notFoundError === undefined || !/unknown subagent/.test(String(notFoundError?.message ?? notFoundError))) {
    failures += 1;
    console.log('async_wait(agent not_found): 未按设计抛 unknown subagent 可读错误');
  } else {
    console.log('async_wait(agent not_found): OK（可读错误，含纠错清单）');
  }
}

// 7) `async_agent` 的立返分支：替身 provider 走 startActivation（result 永不落定）。
{
  const f = fakeCtx();
  f.ctx.subagents.getProvider = (providerName) => ({ name: providerName, prepareContinuable() {} });
  f.ctx.subagents.startActivation = async () => ({
    childId: 'child-spawn-1',
    result: new Promise(() => {}),
    dispose: () => Promise.resolve()
  });
  await probe('async_agent(started)', createAgentTool(f.ctx, config),
    { description: 'probe', prompt: '报告。' });
}

console.log('');
if (failures > 0) {
  console.error(`${failures} 个分支的输出不符合自己声明的 output.schema。`);
  process.exitCode = 1;
} else {
  console.log('全部分支的输出都符合自己声明的 output.schema。');
}
