/**
 * 真机缺陷定位探针：把四个工具的**实际返回值**喂给宿主自己的输出校验器。
 *
 * 为什么需要它：整包单测全绿（当时的 69 条）而验证实例上 `async_run` 直接报
 * `tool "async_run" returned invalid output: "value" must match exactly one oneOf branch (matched 0)`。
 * 原因是单测只断言返回值的**字段**，从来没有用宿主校验器验过**输出 schema 本体**，
 * 而 `output.schema` 的校验只在运行时发生（`PKGS/dsh-tools/lib/index.js:3415-3418`）。
 * 这个坑现在已经用 `test/_helpers.mjs` 的 `assertOutputShape` / `checkedTool` 固化成单测，
 * 本探针保留作为"改 schema 之后先手工看一眼"的入口。
 *
 * 用法：`node --import ./tools/_host-hooks.mjs tools/probe-output-schema.mjs`；
 * 任一分支校验失败即非零退出。
 */
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { createAgentTool } from '../lib/agent.js';
import { createRunTool } from '../lib/jobs.js';
import { createWaitAgentTool } from '../lib/wait-agent.js';
import { createWaitJobTool } from '../lib/wait-job.js';
import { resolveConfig } from '../lib/config.js';

const config = resolveConfig({});

/** 失败计数（决定退出码）。 */
let failures = 0;

/**
 * 最小假进程：结算时才吐输出，句柄形状照抄 `dsh-pwsh-local` 的增量读契约。
 * @param {object} [options] - `{ text, exitCode, status, autoResolve, readOverride }`。
 * @returns {object} 句柄与结算探针。
 */
function fakeProc({ text = 'SHORT_OK\n', exitCode = 0, status = 'exited', autoResolve = true } = {}) {
  let emitted = false;
  let settled = autoResolve;
  let release;
  const proc = {
    status,
    exitCode,
    signal: null,
    done: new Promise((resolve) => { release = resolve; }),
    readOutput: () => {
      if (!settled) return { delta: '' };
      if (emitted) return { delta: '' };
      emitted = true;
      return { delta: text };
    },
    kill: () => {}
  };
  if (autoResolve) queueMicrotask(() => release(proc));
  return {
    proc,
    settle: () => { settled = true; release(proc); }
  };
}

/**
 * 造一个够用的假 ctx。
 * @param {object} proc - 假进程句柄。
 * @returns {object} 假上下文。
 */
function fakeCtx(proc) {
  return {
    jobs: {
      start: () => 'async-command-1',
      get: () => ({ status: 'running' }),
      read: () => ({ text: '' }),
      // `async_wait_job` 的未终态分支靠预算定时器收敛，这里给一个永不落定的等待即可
      // （真实语义：`jobs.wait` 到期以非终态快照正常解析，F6）。
      wait: () => new Promise(() => {})
    },
    shell: {
      sandboxMode: undefined,
      resolve: (request) => request,
      start: () => proc
    },
    shellEnv: { collect: () => ({ DSH_HOME: 'C:\\fake-dsh-home' }) },
    subagents: { listChildren: async () => [] },
    timer: {
      timeout: (callback, delay) => {
        const handle = setTimeout(callback, delay ?? 5);
        return () => clearTimeout(handle);
      },
      interval: (callback, delay) => {
        const handle = setInterval(callback, delay ?? 1000);
        return () => clearInterval(handle);
      }
    },
    on: () => () => {},
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
    effect: () => () => {}
  };
}

const exec = { agent: { id: 'session-probe', session: { header: { cwd: 'Q:\\nowhere' } } }, signal: undefined };

/**
 * 跑一个工具并把结果喂给校验器。
 * @param {string} label - 工具名。
 * @param {object} proc - 假进程句柄。
 * @param {object} args - 工具参数。
 * @returns {Promise<void>} 打印结果。
 */
async function probe(label, proc, args) {
  const factory = { async_run: createRunTool, async_wait_job: createWaitJobTool, async_wait_agent: createWaitAgentTool }[label];
  const built = factory(fakeCtx(proc), config);
  let value;
  try {
    value = await built.execute(args, exec);
  } catch (error) {
    failures += 1;
    console.log(`${label}: execute 抛错 → ${error.message}`);
    return;
  }
  // 注意：`validateJsonSchemaValue` 是**返回违规数组**，不是抛错（`dsh-tools:520-532`）。
  // 本探针若写成 try/catch，所有分支都会打印 OK——那正是它要抓的那类错误。
  // 抛 `ToolOutputError` 的是宿主那一层（`:2458` + `:3415-3418`）。
  const violations = validateJsonSchemaValue(built.output.schema, value);
  if (violations.length > 0) failures += 1;
  console.log(`${label}: ${violations.length === 0 ? 'OK' : `校验失败 → ${violations.join('; ')}`}`);
  console.log(`       实际返回值 = ${JSON.stringify(value)}`);
  // 把**声明的 schema 本体**也打出来：判定"是值形状不对"还是"schema 声明不对"，
  // 只能靠它。没打它之前连猜了三个错方向。
  console.log(`       声明 schema = ${JSON.stringify(built.output.schema)}`);
}

// 1) 短命令、正常退出码。
const ok = fakeProc();
await probe('async_run', ok.proc, { command: 'Write-Output SHORT_OK', description: 'probe' });

// 2) 关键对照：进程没给出退出码（exitCode 为 null）时，完成分支的 schema 还成立吗？
const nullExit = fakeProc({ exitCode: null });
await probe('async_run', nullExit.proc, { command: 'Write-Output SHORT_OK', description: 'probe-null-exit' });

// 3) lossy 输出会把 `note` 塞进完成分支——`additionalProperties: false` 里必须有这个键。
const lossy = fakeProc();
lossy.proc.readOutput = () => {
  if (lossy.proc.__emitted === true) return { delta: '', lossy: true };
  lossy.proc.__emitted = true;
  return { delta: '部分输出\n', lossy: true, stdoutSpillPath: 'C:\\spill\\stdout.txt' };
};
await probe('async_run', lossy.proc, { command: 'Write-Output x', description: 'probe-lossy' });

// 4) 让出分支（`status: "running"`）：命令永不结算。
const slow = fakeProc({ text: '', exitCode: null, status: 'running', autoResolve: false });
await probe('async_run', slow.proc, { command: 'Start-Sleep 1', description: 'probe-yield', yield_ms: 1000 });

// 5) `async_wait_job` 的两个分支：终态与未终态。
const jobCtx = fakeCtx(fakeProc().proc);
const waitJob = createWaitJobTool(jobCtx, config);
for (const [name, status] of [['completed', 'completed'], ['running', 'running']]) {
  jobCtx.jobs.get = () => ({ status });
  jobCtx.jobs.read = () => ({ text: 'job output' });
  const value = await waitJob.execute({ job_id: 'async-command-1', wait_ms: 250 }, exec);
  const violations = validateJsonSchemaValue(waitJob.output.schema, value);
  if (violations.length > 0) failures += 1;
  console.log(`async_wait_job(${name}): ${violations.length === 0 ? 'OK' : `校验失败 → ${violations.join('; ')}`}`);
}

// 6) `async_wait_agent` 的两个分支：屏障即终态（settled）与查不到（not_found）。
const agentCtx = fakeCtx(fakeProc().proc);
const waitAgent = createWaitAgentTool(agentCtx, config);
for (const [name, rows] of [
  ['settled', [{ kind: 'child', id: 'child-1', mode: 'continuable', label: 'x', activity: 'inactive', hasChildren: false }]],
  ['not_found', []]
]) {
  agentCtx.subagents.listChildren = async () => rows;
  const value = await waitAgent.execute({ agent_id: 'child-1', wait_ms: 1000 }, exec);
  const violations = validateJsonSchemaValue(waitAgent.output.schema, value);
  if (violations.length > 0) failures += 1;
  console.log(`async_wait_agent(${name}): ${violations.length === 0 ? 'OK' : `校验失败 → ${violations.join('; ')}`}`);
}

// 7) `async_agent` 的立返分支（§18.2）：替身 provider 走 startContinuable。
//    （fakeCtx 的 subagents 是共享对象——这里补上 async_agent 需要的两个成员。）
const spawnCtx = fakeCtx(fakeProc().proc);
spawnCtx.subagents.getProvider = (providerName) => ({ name: providerName, prepareContinuable() {} });
spawnCtx.subagents.startContinuable = async () => ({ childId: 'child-spawn-1' });
const agentTool = createAgentTool(spawnCtx, config);
{
  const value = await agentTool.execute({ description: 'probe', prompt: '报告。' }, exec);
  const violations = validateJsonSchemaValue(agentTool.output.schema, value);
  if (violations.length > 0) failures += 1;
  console.log(`async_agent(started): ${violations.length === 0 ? 'OK' : `校验失败 → ${violations.join('; ')}`}`);
}

console.log('');
if (failures > 0) {
  console.error(`${failures} 个分支的输出不符合自己声明的 output.schema。`);
  process.exitCode = 1;
} else {
  console.log('所有分支的输出都通过宿主校验器。');
}
