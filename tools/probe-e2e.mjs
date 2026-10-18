/**
 * 宿主接线自检（进程内起真 cordis Context 的冒烟检查）。
 *
 * ## 这不是端到端证据
 *
 * 本脚本**不启动任何进程、不连任何 dsh 实例、不碰验证实例**。它做三件事：
 * 1. 真 `@deepseek-ai/cordis` 起最小 Context，注册**替身**服务，把工具行插件
 *    （`config.toolName` = async_run / async_wait_job / async_wait_agent / async_agent）
 *    各挂一次并卸载；
 * 2. 断言各行各自注册了正确的工具名、描述里有生效的预算数字、`output.schema` 形状合法；
 * 3. 用替身 shell / jobs / subagents 走一遍四个工具的**返回值形状**。
 *
 * 真正的端到端（短命令 / 长命令让出 / 插话打断等待 / 子代理等待 / 预设隔离 /
 * native 呈现）必须在**验证实例**上由真实会话执行并留证——脚本自检替代不了它：
 * 替身检查器的真实盲区在服务**行为**差异：例如替身 timer 的 setTimeout 语义与宿主不同，静态判据全绿也测不出来。
 *
 * 用法：以本文件为参数、`--import ./tools/_host-hooks.mjs` 起 node 直接执行；全通过退出码 0。
 */
import { Context } from '@deepseek-ai/cordis';
import { apply, Config, inject, name } from '../lib/index.js';

/** cordis 的 `FiberState.ACTIVE`（`@deepseek-ai/cordis` 4.0.4，`lib/types/fiber.d.ts:67-74` 的 const enum，ACTIVE = 2）。 */
const ACTIVE = 2;

/** 收集到的失败项。 */
const failures = [];

/**
 * 一条检查：回调返回 false 或抛错即记为失败。
 * **必须 await 回调**——回调写成 `async` 时若不等它，异常会逃出 try 块，
 * 这条检查就变成了恒真。
 * @param {string} label - 检查名。
 * @param {Function} check - 检查体（可为 async）。
 * @returns {Promise<void>} 记录完结果即返回。
 */
async function verify(label, check) {
  try {
    const ok = await check();
    if (ok === false) throw new Error('断言为 false');
    console.log(`OK    ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error?.message ?? error}`);
    console.log(`FAIL  ${label}: ${error?.message ?? error}`);
  }
}

/**
 * 等插件 fiber 进入 ACTIVE（cordis 的 `_reload()` 先 `await Promise.resolve()`
 * 才执行 apply，见 `@deepseek-ai/cordis` 4.0.4 `lib/index.js:1349-1358` 的
 * `_reload` 链）。
 * @param {object} fork - `ctx.plugin()` 的返回值。
 * @returns {Promise<number>} 最终状态。
 */
async function activation(fork) {
  for (let turn = 0; turn < 64 && fork.state !== ACTIVE; turn++) await Promise.resolve();
  return fork.state;
}

/**
 * 造一个"立即结束"的替身进程句柄——**不启动任何真实进程**。
 * @param {object} options - `{ text, exitCode }`。
 * @returns {object} 句柄。
 */
function stubProcess({ text = 'hello from stub', exitCode = 0 } = {}) {
  let emitted = false;
  return {
    status: 'exited',
    exitCode,
    signal: null,
    done: Promise.resolve(),
    readOutput: () => {
      if (emitted) return { delta: '', lossy: false };
      emitted = true;
      return { delta: text, lossy: false };
    },
    kill: () => {}
  };
}

/**
 * 造一个最小上下文：全部服务都是替身，并记录工具注册与 shell 请求。
 * @returns {object} 环境探针。
 */
function makeContext() {
  const registered = [];
  const jobs = {
    started: [],
    status: 'running',
    start(spec) {
      this.started.push(spec);
      return `${spec.kind}-1`;
    },
    get(id) { return { id, status: this.status }; },
    read() { return { text: 'stub job output' }; },
    kill() { return 'requested'; },
    wait: async () => ({ status: 'running' })
  };
  const shell = {
    lastResolved: undefined,
    resolve(request) {
      this.lastResolved = { ...request, resolved: true };
      return this.lastResolved;
    },
    start: () => stubProcess()
  };
  const ctx = new Context();
  ctx.provide('tools', {
    register(definition) {
      registered.push(definition);
      return () => {
        const index = registered.indexOf(definition);
        if (index >= 0) registered.splice(index, 1);
      };
    }
  });
  ctx.provide('jobs', jobs);
  ctx.provide('shell', shell);
  ctx.provide('shellEnv', {
    collect: () => Object.freeze({ DSH_HOME: 'C:\\fake-dsh-home', DSH_SHELL: '1' })
  });
  // async_run 启动前经 ensure 取会话当前有效目录（固定依赖之一，设计 §3.1）。
  ctx.provide('workingDirectory', {
    ensure: async () => 'D:\\probe-work'
  });
  ctx.provide('subagents', {
    listChildren: async () => [
      { kind: 'child', id: 'child-probe', mode: 'continuable', label: 'probe', activity: 'inactive', hasChildren: false }
    ],
    interrupt: () => 'requested',
    // async_agent 的执行侧：替身 provider 支持 continuable；result 永不落定
    // （观察通道只承接不等待），dispose 哨兵在（本包不得调用）。
    getProvider: (providerName) => ({ name: providerName, prepareContinuable() {} }),
    startActivation: async () => ({
      childId: 'child-probe-spawned',
      result: new Promise(() => {}),
      dispose: () => Promise.resolve()
    })
  });
  ctx.provide('timer', {
    // 保留延迟语义的真实定时器：让出竞速的胜者必须由"命令是否已结束"决定。
    timeout: (callback, delay) => {
      const handle = setTimeout(callback, delay ?? 5);
      return () => clearTimeout(handle);
    },
    interval: () => () => {}
  });
  return { ctx, registered, jobs, shell };
}

/**
 * 挂一行插件。
 * @param {object} env - `makeContext()` 的返回值。
 * @param {string} toolName - 本次注册的工具名。
 * @param {object} [config] - 额外的行配置（如收紧首次等待预算，免得探针真等 1 秒）。
 * @returns {Promise<object>} 挂载环境与 fork。
 */
async function mount(env, toolName, config = {}) {
  const fork = env.ctx.plugin({ name, inject, Config, apply }, { toolName, ...config });
  const state = await activation(fork);
  return { fork, state };
}

/** 一个最小的 exec：只带一个会话 cwd，不碰任何真实服务。 */
function stubExec() {
  return {
    agent: { id: 'probe-session', session: { header: { cwd: 'Q:\\nowhere' } } },
    signal: new AbortController().signal
  };
}

await verify('inject 恰好是八个服务', () => {
  const expected = ['tools', 'jobs', 'shell', 'shellEnv', 'subagents', 'timer', 'sessionProjections', 'agents'];
  const missing = expected.filter((service) => !inject.includes(service));
  if (missing.length > 0 || inject.length !== expected.length) {
    throw new Error(`实际 inject=${JSON.stringify(inject)}，缺 ${missing.join(', ') || '(无)'}`);
  }
  return true;
});

// --- 逐行挂载：注册名 / schema 形状 / 描述数字 ---------------------------------
for (const toolName of ['async_run', 'async_wait_job', 'async_wait_agent', 'async_agent']) {
  const env = makeContext();
  const { fork, state } = await mount(env, toolName);

  await verify(`挂载 ${toolName}：fiber ACTIVE 且只注册了这一个工具`, () => {
    if (state !== ACTIVE) throw new Error(`fiber 状态 ${state}`);
    const names = env.registered.map((definition) => definition.name);
    if (names.length !== 1 || names[0] !== toolName) throw new Error(`注册的工具是 ${JSON.stringify(names)}`);
    return true;
  });

  // 三个等待/运行工具的 schema 是一层 oneOf 联合；async_agent 立返单形态，
  // 是带 additionalProperties:false 的平对象（宿主 schema 形状）。
  await verify(`${toolName}：output.schema 形状与工具形态匹配，且声明了 render`, () => {
    const tool = env.registered[0];
    if (typeof tool.output?.render !== 'function') throw new Error('缺少 output.render');
    if (toolName === 'async_agent') {
      const schema = tool.output.schema;
      if (schema?.type !== 'object' || schema?.additionalProperties !== false) {
        throw new Error('async_agent 应为平对象 schema（additionalProperties:false）');
      }
    } else {
      const branches = tool.output.schema?.oneOf;
      if (!Array.isArray(branches) || branches.length < 2) throw new Error('output.schema 不是一层 oneOf 联合');
    }
    return true;
  });

  await verify(`${toolName}：描述里带生效的预算数字`, () => {
    const tool = env.registered[0];
    if (!/\d+ ms/.test(tool.description)) throw new Error('描述里没有任何毫秒数字');
    return true;
  });

  await fork.dispose();
}

// --- 卸载：disposer 必须注销工具 -------------------------------------------------
await verify('卸载后工具被注销（可逆卸载）', async () => {
  const env = makeContext();
  const { fork } = await mount(env, 'async_run');
  if (env.registered.length !== 1) throw new Error('挂载后没有注册');
  await fork.dispose();
  if (env.registered.length !== 0) throw new Error('卸载后仍残留注册');
  return true;
});

// --- 四个工具的返回值形状（全部走替身，不启动进程） ------------------------------
await verify('async_run：首次等待内结束 → completed + output，且请求带 dshEnv 与 workdir', async () => {
  const env = makeContext();
  const { fork } = await mount(env, 'async_run');
  const result = await env.registered[0].execute(
    { command: 'Write-Output hi', description: 'probe short command' },
    stubExec()
  );
  if (result.status !== 'completed') throw new Error(`status=${result.status}`);
  if (result.output !== 'hello from stub') throw new Error(`output=${JSON.stringify(result.output)}`);
  const seen = env.shell.lastResolved;
  if (seen === undefined) throw new Error('没有记录到 shell.resolve 的请求');
  if (typeof seen.dshEnv !== 'object' || seen.dshEnv === null) throw new Error('请求里没有 dshEnv');
  if (seen.workdir !== 'Q:\\nowhere') throw new Error(`workdir=${JSON.stringify(seen.workdir)}`);
  await fork.dispose();
  return true;
});

await verify('async_run：超出首次等待 → running + job_id + 可照抄的 async_wait_job 示例', async () => {
  const env = makeContext();
  // 让命令永远不结束 → 走让出分支；替身 timer 立刻回调，让竞速确定性收敛。
  env.shell.start = () => ({
    status: 'running',
    exitCode: null,
    signal: null,
    done: new Promise(() => {}),
    readOutput: () => ({ delta: '', lossy: false }),
    kill: () => {}
  });
  const { fork } = await mount(env, 'async_run', { minYieldMs: 20, defaultYieldMs: 40 });
  const result = await env.registered[0].execute(
    { command: 'Start-Sleep 60', description: 'probe long command', yield_ms: 40 },
    stubExec()
  );
  if (result.status !== 'running') throw new Error(`status=${result.status}`);
  if (typeof result.job_id !== 'string' || result.job_id.length === 0) throw new Error('缺少 job_id');
  if (!result.note.includes(`async_wait_job(job_id="${result.job_id}"`)) throw new Error('note 里没有可照抄的 async_wait_job 调用');
  if (env.jobs.started.length !== 1) throw new Error('没有注册作业');
  await fork.dispose();
  return true;
});

await verify('async_wait_job：作业已终态 → completed + output', async () => {
  const env = makeContext();
  const { fork } = await mount(env, 'async_wait_job');
  env.jobs.status = 'completed';
  const result = await env.registered[0].execute({ job_id: 'async-command-1', wait_ms: 1000 }, stubExec());
  if (result.status !== 'completed') throw new Error(`status=${result.status}`);
  if (typeof result.output !== 'string') throw new Error('缺少 output');
  await fork.dispose();
  return true;
});

await verify('async_wait_agent：列表读出非运行态 → settled（屏障即终态——列表读取这道屏障读出非运行态，即按终态处理）', async () => {
  const env = makeContext();
  const { fork } = await mount(env, 'async_wait_agent');
  const result = await env.registered[0].execute({ agent_id: 'child-probe', wait_ms: 1000 }, stubExec());
  if (result.status !== 'settled') throw new Error(`status=${result.status}`);
  if (!result.note.includes('不在本返回值中')) throw new Error('note 没说清最终回答不在返回值里');
  await fork.dispose();
  return true;
});

await verify('async_agent：替身 provider 派生 → started + agent_id + 可照抄的 async_wait_agent 示例', async () => {
  const env = makeContext();
  const { fork } = await mount(env, 'async_agent');
  const result = await env.registered[0].execute(
    { description: 'probe delegation', prompt: '完成一个小任务并报告。' },
    stubExec()
  );
  if (result.status !== 'started') throw new Error(`status=${result.status}`);
  if (result.agent_id !== 'child-probe-spawned') throw new Error(`agent_id=${JSON.stringify(result.agent_id)}`);
  if (!result.note.includes(`async_wait_agent(agent_id="${result.agent_id}"`)) {
    throw new Error('note 里没有可照抄的 async_wait_agent 调用');
  }
  await fork.dispose();
  return true;
});

// --- 报告 ---------------------------------------------------------------------
console.log('');
if (failures.length > 0) {
  console.error(`接线自检失败 ${failures.length} 项：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('\n注意：这只是宿主接线自检，端到端证据必须在验证实例上取。');
  process.exitCode = 1;
} else {
  console.log('宿主接线自检全部通过。');
  console.log('提醒：这不是端到端证据——真实的让出/等待/打断行为必须在验证实例上由真实会话验证。');
}
