/**
 * 宿主接线自检（进程内起真 cordis Context 的冒烟检查）。
 *
 * ## 这不是端到端证据
 *
 * 本脚本**不启动任何进程、不连任何 dsh 实例、不碰验证实例**。它做四件事：
 * 1. 断言入口的 inject 与九项固定服务逐项一致（严格比长度，多一项少一项都红）；
 * 2. 真 `@deepseek-ai/cordis` 起最小 Context，注册**替身**服务，把六个工具行
 *    （`config.toolName` = async_run / async_wait_job / async_wait_agent /
 *    async_agent / async_workflow / async_list_subagent_models）各挂载一次：
 *    fiber 进入 ACTIVE、只注册本工具、描述断言生效预算数字（路由查询行除外——
 *    它没有预算字段）、output.schema 形状合法；卸载后工具注销；
 * 3. 用替身 shell / jobs / subagents / agents 走一遍四个核心工具的**返回值形状**
 *    （async_run 完成与让出、async_wait_job 终态读取、async_wait_agent 停止态
 *    两语、async_agent 立返 started）；
 * 4. workdir 断言核 workingDirectory.ensure 的返回值——会话头里的 cwd 是对照
 *    假值：目录取自 ensure（会话当前有效目录），不取会话头。
 *
 * 不在本脚本范围：async_workflow 的引擎执行路径与 async_list_subagent_models
 * 的 llm／策略读取路径（workflow 由 test/workflow.test.mjs（单元）与
 * verify/probe-r34-async-workflow.mjs（真机）覆盖；list-models 由
 * test/list-models.test.mjs（单元）覆盖，真机判据并入
 * verify/acceptance-017.mjs 的 agent 相位，无专项探针脚本）。
 *
 * 真正的端到端（短命令 / 长命令让出 / 插话打断等待 / 子代理等待 / 预设隔离 /
 * native 呈现）必须在**验证实例**上由真实会话执行并留证——脚本自检替代不了它：
 * 替身检查器的真实盲区在服务**行为**差异：例如替身 timer 的 setTimeout 语义与
 * 宿主不同，静态判据全绿也测不出来。
 *
 * 用法：在仓库根执行 `node --import ./tools/_host-hooks.mjs tools/probe-e2e.mjs`
 * （或 `pnpm run probe:e2e`——同款 scripts 入口；
 * `_host-hooks.mjs` 把本机 hostModules 桥接成模块解析契约，探针对
 * `@deepseek-ai/cordis` 等宿主包的解析依赖它）；全通过退出码 0。挂载时 stderr
 * 逐行打印「设置快照缺席」通告——探针环境没有宿主行，这是预期的部署期线索，
 * 不是失败；失败只看退出码与 FAIL 行。
 */
import { Context } from '@deepseek-ai/cordis';
import { apply, Config, inject, name } from '../lib/index.js';

/** cordis 的 `FiberState.ACTIVE`（`@deepseek-ai/cordis` 4.0.5，`lib/types/fiber.d.ts:67-74` 的 const enum，ACTIVE = 2）。 */
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
 * 才执行 apply，见 `@deepseek-ai/cordis` 4.0.5 `lib/index.js:1349-1358` 的
 * `_reload` 链）。
 * @param {object} fork - `ctx.plugin()` 的返回值。
 * @returns {Promise<number>} 最终状态。
 */
async function activation(fork) {
  for (let turn = 0; turn < 64 && fork.state !== ACTIVE; turn++) await Promise.resolve();
  return fork.state;
}

/** 最小 exec：不碰任何真实服务。会话头的 cwd 是对照假值——workdir 断言核
 * workingDirectory.ensure 的返回值，若接线退回读会话头，断言变红。
 * requestHeader 是 async_agent 路由回执的读取点（dsh-subagent 的
 * parentAgentOptionsForDelegation 直读 parent.session.requestHeader()，
 * 缺席会同步抛错）；返回 undefined = 无请求头配置，回执走「继承父路由」档。 */
function stubExec() {
  return {
    agent: {
      id: 'probe-session',
      options: {},
      session: { header: { cwd: 'Q:\\nowhere' }, requestHeader: () => undefined }
    },
    signal: new AbortController().signal
  };
}

/** 非消费偏移读的空增量（lazyRead 的 observed 通道，`lib/jobs.js`）。 */
const observedStub = () => ({
  stdout: { readFrom: (from) => ({ text: '', nextOffset: from, lossy: false }) },
  stderr: { readFrom: (from) => ({ text: '', nextOffset: from, lossy: false }) }
});

/** 「立即结束」的替身进程句柄——不启动任何真实进程。
 * 消费点：readOutput 增量读（createCollector）、status/exitCode/signal
 * （jobOutcome 与 settleNow 的结算判定）、done、kill、observed（lazyRead）。 */
function stubProcess({ text = 'hello from stub', exitCode = 0 } = {}) {
  let emitted = false;
  return {
    status: 'completed',
    exitCode,
    signal: null,
    done: Promise.resolve(),
    readOutput: () => {
      if (emitted) return { delta: '', lossy: false };
      emitted = true;
      return { delta: text, lossy: false };
    },
    kill: () => {},
    observed: observedStub()
  };
}

/** shell 替身：resolve 记录请求，execute 返回进程句柄的 Promise
 * （生产者直挂 `procPromise.then`，同步返回值不可用）。 */
function makeShell() {
  return {
    lastResolved: undefined,
    lastExecuted: undefined,
    resolve(request) {
      this.lastResolved = { ...request, resolved: true };
      return this.lastResolved;
    },
    execute(spec) {
      this.lastExecuted = spec;
      return Promise.resolve(stubProcess());
    }
  };
}

/**
 * jobs 迷你注册表（语义按宿主 `dsh-jobs-local` 先例）：start 同步回调
 * `spec.run(handle)`、done 结算定终态；list 出视图、read 双通道、wait 四参。
 * `entries`（Map）与 `progress`（updateProgress 收到的行）是断言的证据出口。
 * @returns {object} 注册表替身。
 */
function makeJobs() {
  const entries = new Map();
  const progress = [];
  let seq = 0;
  const viewOf = (entry) => ({ id: entry.id, status: entry.status, label: entry.label });
  const wake = (entry) => { for (const r of entry.resolvers.splice(0)) r(); };
  return {
    entries,
    progress,
    start(spec) {
      seq += 1;
      const id = `${spec.kind}-${seq}`;
      const entry = { id, status: 'running', label: spec.label, detail: undefined,
        hooks: undefined, resolvers: [] };
      // 宿主先例：准入后同步调 spec.run(handle)（dsh-jobs-local L439），
      // handle 带 updateProgress；本包生产者在 run 内启动进程。
      entry.hooks = spec.run({
        id,
        updateProgress: (line) => { entry.progress = line; progress.push(line); }
      });
      entries.set(id, entry);
      // done 结算：resolve 的 outcome 定终态；reject 按宿主同款转 failed。
      Promise.resolve(entry.hooks.done).then(
        (outcome) => { entry.status = outcome.status; entry.detail = outcome.detail; wake(entry); },
        (error) => { entry.status = 'failed'; entry.detail = String(error); wake(entry); }
      );
      return id;
    },
    list(caller) { return [...entries.values()].map(viewOf); },
    read(id, caller) {
      // chunks 与 result 两通道都在场：wait_job 的合并次序断言同时核两条通道；
      // result 字面与终态用例的断言子串逐字一致，不隔其他词。
      return { chunks: [{ text: 'stub job output' }], lossy: false,
        result: 'stub job result', job: { id, status: 'completed', output: { spillPaths: [] } } };
    },
    // 宿主语义（dsh-jobs-local waitJob）：终态立即回视图；超时 resolve 当前
    // 视图；abort 拒绝 'wait aborted'。四参签名，无 onExpiry——到期纪律在
    // shell.execute 的 spec 上，不在 jobs.wait。
    wait(id, timeoutMs, caller, signal) {
      return new Promise((resolve, reject) => {
        const entry = entries.get(id);
        if (entry === undefined) { reject(new Error(`unknown job ${id}`)); return; }
        if (['completed', 'killed', 'failed'].includes(entry.status)) { resolve(viewOf(entry)); return; }
        if (signal?.aborted) { reject(new Error('wait aborted')); return; }
        let done = false;
        const finish = (fn) => { if (done) return; done = true; clearTimeout(t);
          signal?.removeEventListener?.('abort', onAbort); fn(); };
        const t = setTimeout(() => finish(() => resolve(viewOf(entry))), Math.max(0, timeoutMs));
        const onAbort = () => finish(() => reject(new Error('wait aborted')));
        signal?.addEventListener?.('abort', onAbort, { once: true });
        entry.resolvers.push(() => finish(() => resolve(viewOf(entry))));
      });
    },
    get(id, caller) { const e = entries.get(id); if (e === undefined) throw new Error(`unknown job ${id}`); return viewOf(e); },
    kill(id, caller) { const e = entries.get(id); if (e !== undefined && e.hooks) e.hooks.cancel('probe'); return 'requested'; },
    // 预置终态条目：wait_job 用例不创建作业，不经 start，直接以已完成条目应答。
    seedCompleted(id, label = 'probe job') {
      entries.set(id, { id, status: 'completed', label, detail: undefined, hooks: undefined, resolvers: [] });
    }
  };
}

/**
 * 造一个最小上下文：九项固定服务全部提供替身，并记录工具注册。
 * @returns {object} 环境探针。
 */
function makeContext() {
  const registered = [];
  const jobs = makeJobs();
  const shell = makeShell();
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
  // 宿主托管的 DSH_* 变量随请求下发（值进 dshEnv 断言）。
  ctx.provide('shellEnv', {
    collect: () => Object.freeze({ DSH_HOME: 'C:\\fake-dsh-home', DSH_SHELL: '1' })
  });
  // async_run 启动前经 ensure 取会话当前有效目录（workdir 断言的期望值）。
  ctx.provide('workingDirectory', {
    ensure: async () => 'D:\\probe-work'
  });
  ctx.provide('subagents', {
    // catalog 行不带 kind/activity：childOf 的判据是「id 相等且非 diagnostic」。
    listChildren: async () => [
      { id: 'child-probe', createdAt: 0, mode: 'continuable', label: 'probe' }
    ],
    // interrupt 保留以覆盖完整公开接口（与 jobs.get/kill 同理），探针四流程不消费。
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
  // 探针路径不消费投影（silentFailureGuard 默认关）；提供它是 inject 完整性——
  // fiber 启动条件，缺了挂载用例全红。
  ctx.provide('sessionProjections', { stateOf: () => undefined });
  // wait_agent 的入口注册表三态消费：读 .status 只认 running/idle，undefined 即 absent；
  // idle 命中 settled 出口。
  ctx.provide('agents', {
    get: (id) => (id === 'child-probe' ? { status: 'idle' } : undefined)
  });
  ctx.provide('timer', {
    // wait_job / wait_agent 在入口武装 deadline 时调用 timeout（探针用例不等
    // 真实到期，回调不触发）；interval 无消费点，提供它保接口完整。
    timeout: (callback, delay) => {
      const handle = setTimeout(callback, delay ?? 5);
      return () => clearTimeout(handle);
    },
    interval: () => () => {}
  });
  return { ctx, registered, jobs, shell };
}

/**
 * 挂一行插件。设置字段住 `settings` 子树（行配置的真实形态）：cordis 会给
 * 行配置补默认形状（含空的 `settings:{}`），平铺的设置键会被它遮蔽——
 * `resolveConfig` 见到 `settings` 键就按根形态解析，顶层未知键直接丢弃。
 * @param {object} env - `makeContext()` 的返回值。
 * @param {string} toolName - 本次注册的工具名。
 * @param {object} [config] - 额外的行配置（如收紧首次等待预算，免得探针真等 1 秒）。
 * @returns {Promise<object>} fork 与其 fiber 状态（`{fork, state}`）。
 */
async function mount(env, toolName, config = {}) {
  const fork = env.ctx.plugin({ name, inject, Config, apply }, { toolName, ...config });
  const state = await activation(fork);
  return { fork, state };
}

await verify('inject 恰好是九项服务', () => {
  const expected = ['tools', 'jobs', 'shell', 'shellEnv', 'subagents', 'timer', 'sessionProjections', 'agents', 'workingDirectory'];
  const missing = expected.filter((service) => !inject.includes(service));
  if (missing.length > 0 || inject.length !== expected.length) {
    throw new Error(`实际 inject=${JSON.stringify(inject)}，缺 ${missing.join(', ') || '(无)'}`);
  }
  return true;
});

// --- 逐行挂载：注册名 / schema 形状 / 描述数字 ---------------------------------
for (const toolName of ['async_run', 'async_wait_job', 'async_wait_agent', 'async_agent', 'async_workflow', 'async_list_subagent_models']) {
  const env = makeContext();
  const { fork, state } = await mount(env, toolName);

  await verify(`挂载 ${toolName}：fiber ACTIVE 且只注册了这一个工具`, () => {
    if (state !== ACTIVE) throw new Error(`fiber 状态 ${state}`);
    const names = env.registered.map((definition) => definition.name);
    if (names.length !== 1 || names[0] !== toolName) throw new Error(`注册的工具是 ${JSON.stringify(names)}`);
    return true;
  });

  // schema 两档：async_agent 与 async_list_subagent_models 立返单形态，是带
  // additionalProperties:false 的平对象（宿主 schema 形状）；其余四行是
  // 一层 oneOf 联合（等待/运行工具的返回值形态集合）。
  await verify(`${toolName}：output.schema 形状与工具形态匹配，且声明了 render`, () => {
    const tool = env.registered[0];
    if (typeof tool.output?.render !== 'function') throw new Error('缺少 output.render');
    if (toolName === 'async_agent' || toolName === 'async_list_subagent_models') {
      const schema = tool.output.schema;
      if (schema?.type !== 'object' || schema?.additionalProperties !== false) {
        throw new Error(`${toolName} 应为平对象 schema（additionalProperties:false）`);
      }
    } else {
      const branches = tool.output.schema?.oneOf;
      if (!Array.isArray(branches) || branches.length < 2) throw new Error('output.schema 不是一层 oneOf 联合');
    }
    return true;
  });

  // async_list_subagent_models 豁免描述数字断言：它的描述只有分页数字，
  // 没有预算字段。
  if (toolName !== 'async_list_subagent_models') {
    await verify(`${toolName}：描述里带生效的预算数字`, () => {
      const tool = env.registered[0];
      if (!/\d+ ms/.test(tool.description)) throw new Error('描述里没有任何毫秒数字');
      return true;
    });
  }

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

// --- 四个核心工具的返回值形状（全部走替身，不启动进程） ------------------------------
await verify('async_run：首次等待内结束 → completed + output，请求带 dshEnv、command、onExpiry 与会话当前有效目录', async () => {
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
  if (seen.command !== 'Write-Output hi') throw new Error(`command=${JSON.stringify(seen.command)}`);
  if (typeof seen.dshEnv !== 'object' || seen.dshEnv === null) throw new Error('请求里没有 dshEnv');
  if (seen.dshEnv.DSH_HOME !== 'C:\\fake-dsh-home') throw new Error(`dshEnv.DSH_HOME=${JSON.stringify(seen.dshEnv?.DSH_HOME)}`);
  // workdir 取 ensure 的返回值（会话当前有效目录），不取会话头里的对照假值。
  if (seen.workdir !== 'D:\\probe-work') throw new Error(`workdir=${JSON.stringify(seen.workdir)}`);
  // onExpiry:'none' 是「首次等待到期不杀命令」的接线证据（需求 §2.2.1）。
  if (seen.onExpiry !== 'none') throw new Error(`onExpiry=${JSON.stringify(seen.onExpiry)}`);
  await fork.dispose();
  return true;
});

await verify('async_run：超出首次等待 → running + job_id + 可照抄的 async_wait_job 示例', async () => {
  const env = makeContext();
  // 让命令永远不结束 → 走让出分支；jobs.wait 替身按真 setTimeout 超时回 running
  // 视图，竞速确定性收敛（async_run 不走 ctx.timer——让出窗口走宿主 jobs.wait，
  // 见 lib/index.js 模块头）。
  env.shell.execute = () => Promise.resolve({
    status: 'running',
    exitCode: null,
    signal: null,
    done: new Promise(() => {}),
    readOutput: () => ({ delta: '', lossy: false }),
    kill: () => {},
    observed: observedStub()
  });
  const { fork } = await mount(env, 'async_run', { settings: { minYieldMs: 20, defaultYieldMs: 40 } });
  const result = await env.registered[0].execute(
    { command: 'Start-Sleep 60', description: 'probe long command', yield_ms: 40 },
    stubExec()
  );
  if (result.status !== 'running') throw new Error(`status=${result.status}`);
  if (typeof result.job_id !== 'string' || result.job_id.length === 0) throw new Error('缺少 job_id');
  if (!result.note.includes(`async_wait_job(job_id="${result.job_id}"`)) throw new Error('note 里没有可照抄的 async_wait_job 调用');
  if (env.jobs.entries.size !== 1) throw new Error('没有注册作业');
  // run(job) 同步回调且 progress 行写 description（注册时点即任务面板可见）。
  if (!env.jobs.progress.includes('probe long command')) throw new Error('progress 行没有写 description');
  if (typeof result.elapsed_ms !== 'number' || result.elapsed_ms < 0) throw new Error(`elapsed_ms=${JSON.stringify(result.elapsed_ms)}`);
  await fork.dispose();
  return true;
});

await verify('async_wait_job：作业已终态 → completed + output（chunks 与 result 两通道合并）', async () => {
  const env = makeContext();
  const { fork } = await mount(env, 'async_wait_job');
  // wait_job 不创建作业：预置终态条目（不经 start），read 按该 id 应答。
  env.jobs.seedCompleted('async-command-1');
  const result = await env.registered[0].execute({ job_id: 'async-command-1', wait_ms: 1000 }, stubExec());
  if (result.status !== 'completed') throw new Error(`status=${result.status}`);
  if (result.job_id !== 'async-command-1') throw new Error(`job_id=${JSON.stringify(result.job_id)}`);
  if (!result.output.includes('stub job output')) throw new Error('output 缺 chunks 通道文本');
  if (!result.output.includes('stub job result')) throw new Error('output 缺 result 通道文本');
  await fork.dispose();
  return true;
});

await verify('async_wait_agent：注册表读出 idle → settled（观察证据口径——最终回答作为独立消息到达，不在本返回值中）', async () => {
  const env = makeContext();
  const { fork } = await mount(env, 'async_wait_agent');
  const result = await env.registered[0].execute({ agent_id: 'child-probe', wait_ms: 1000 }, stubExec());
  if (result.status !== 'settled') throw new Error(`status=${result.status}`);
  if (!result.note.includes('no longer observed running')) throw new Error('note 缺少「不再被观察到在运行」的英文事实句');
  if (!result.note.includes('it is not part of this return value')) throw new Error('note 没说清最终回答不在返回值里');
  await fork.dispose();
  return true;
});

await verify('async_wait_agent（zh 档）：注册表读出 idle → settled，note 为中文', async () => {
  const env = makeContext();
  const { fork } = await mount(env, 'async_wait_agent', { settings: { agentLang: 'zh' } });
  const result = await env.registered[0].execute({ agent_id: 'child-probe', wait_ms: 1000 }, stubExec());
  if (result.status !== 'settled') throw new Error(`status=${result.status}`);
  if (!result.note.includes('不再被观察到在运行')) throw new Error('note 缺少「不再被观察到在运行」');
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
