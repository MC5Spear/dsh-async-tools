/**
 * `async_run` 工具的单测（对应需求 §2.1.1、§2.2.1）。
 *
 * 两条最关键的断言：
 * - **执行即注册**：注册先于进程启动，短命令也注册——预算内结算的
 *   等待是活 waiter（awaited），宿主不补发完成通知；
 * - **首次等待＝五信号竞速**：结算/插话/abort/迟到作答/预算，任何
 *   信号只结束等待不终止命令；呈现层 label=命令原文、progress=描述。
 *
 * 后半部分是缺陷防御用例。
 *
 * **读用例名前先读这句**：靠测试替身构造真机上读不到状态（竞速微调、
 * 查询抛错一类）的用例验的是**分支逻辑**；"真机上会不会发生"由旁边的
 * 否定命题用例回答。两类混在一起会让整个缺陷处置被误当成"已经解决"。
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { hostTestFor, loadOfflineSafe } from './_host-gate.mjs';
import { validateJsonSchemaValue, checkedTool, fakeAgent, fakeCtx, fakeProc, freezeTimers, inboxPayload } from './_helpers.mjs';
import { LATE_ANSWER_EVENT } from '../lib/interrupts.js';
import { resolveConfig } from '../lib/config.js';

// 宿主链动态守卫（lib/jobs.js → dsh-tools/ask-takeover）：离线形态锚缺席时
// 本文件仍可加载，全部用例自跳过并打印理由（ci.yml offline 作业的契约）。
const jobsModule = await loadOfflineSafe('../lib/jobs.js');
const { createRunTool: buildRunTool } = jobsModule ?? {};
const hostTest = await hostTestFor('../lib/jobs.js');

/**
 * 被测工具一律经 `checkedTool` 包一层：**每条**用例的返回值都会被喂给宿主输出校验器
 * （只断言字段验不出 schema 违规——完成分支必须真的过 `output.schema` 才算数）。
 */
const createRunTool = (ctx, config) => checkedTool(buildRunTool(ctx, config));

/** 让定时器立即触发，便于测试让出分支。 */
function immediateTimers(ctx) {
  ctx.timer.timeout = (callback) => {
    const handle = setTimeout(callback, 0);
    return () => clearTimeout(handle);
  };
}

const config = resolveConfig({ toolName: 'async_run' });
const exec = { agent: fakeAgent(), signal: new AbortController().signal };

hostTest('async_run（R32-a/e）：预算内结束 → 完成分支照旧；作业注册过、活等待被结算释放（不补发通知）', async () => {
  const f = fakeCtx();
  const { proc } = fakeProc({ text: 'hello world', exitCode: 0, autoResolve: true });
  f.installShellExecute(() => Promise.resolve(proc));

  const tool = createRunTool(f.ctx, config);
  const result = await tool.execute({ command: 'echo hi', description: 'say hi' }, exec);

  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'hello world');
  assert.equal(result.exit_code, 0);
  assert.equal(result.truncated, false);
  assert.equal(f.startedSpecs.length, 1, '只应执行一次进程');
  // 执行即注册：短命令同样先注册（终态卡残留是用户裁定接受的可见性代价）。
  assert.equal(f.jobsFake.registeredSpecs.length, 1, 'R32-a：完成路径也注册作业（准入先于进程）');
  const jobId = f.jobsFake.views()[0].id;
  // 预算内结算的等待是活 waiter（awaited）→ 宿主不补发完成通知。
  assert.equal(f.jobsFake.wasAwaited(jobId), true,
    '结算必须释放活 waiter 并置 awaited——这是"预算内完成零通知"的判据所在');
});

hostTest('async_run：超出首次等待 → 返回作业编号，命令不被杀死', async () => {
  const f = fakeCtx();
  immediateTimers(f.ctx);
  const { proc, isKilled } = fakeProc({ text: 'partial output', exitCode: null, status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));

  const tool = createRunTool(f.ctx, config);
  const result = await tool.execute({ command: 'build', description: 'long build', yield_ms: 5 }, exec);

  assert.equal(result.status, 'running');
  assert.match(result.job_id, /^async-command-/);
  assert.match(result.note, /async_wait_job\(job_id="/);
  assert.match(result.note, /was NOT terminated/, '首次等待到期不杀命令（R22 英文口径）');
  assert.match(result.note, /is still running/, 'note 明说命令仍在运行（防误判终止后重跑）');
  assert.equal(isKilled(), false, '让出不得杀死命令 —— 这是与内置 pwsh 的根本区别');
  assert.equal(f.jobsFake.registeredSpecs.length, 1, '让出路径应注册一个作业');
  assert.equal(f.startedSpecs.length, 1, '不得重复执行进程');
});

hostTest('async_run（R32/R33）：注册字段——label=命令原文、progress=描述、owner=SessionId、准入先于进程、execute 带作业私有 signal', async () => {
  const f = fakeCtx();
  immediateTimers(f.ctx);
  const order = [];
  const { proc, settle } = fakeProc({ text: 'background output', exitCode: 0, status: 'running', autoResolve: false });
  const realStart = f.ctx.jobs.start.bind(f.ctx.jobs);
  f.ctx.jobs.start = (spec) => {
    order.push('admission');
    const id = realStart(spec);
    order.push('start-returned');
    return id;
  };
  f.installShellExecute((spec) => {
    order.push('execute');
    assert.notEqual(spec.signal, undefined, 'execute 必须带作业私有 signal（prep 窗口 kill 的载体）');
    return Promise.resolve(proc);
  });

  const tool = createRunTool(f.ctx, config);
  const pending = tool.execute({ command: 'build --flag with spaces', description: 'long build', yield_ms: 5 }, exec);
  await new Promise((r) => { setTimeout(r, 0); });
  const result = await pending;

  const spec = f.jobsFake.registeredSpecs[0];
  assert.equal(spec.kind, config.jobKind);
  // label 是命令原文（不截断、不换用 description； pwsh 先例）。
  assert.equal(spec.label, 'build --flag with spaces');
  // [0.2.1-rc.2]：owner 是 SessionId（agent.id）。
  assert.equal(spec.owner, exec.agent.id, '作业归属发起 agent 的 SessionId');
  // 通知截断口径：outputLimitBytes 必须还在（字节量纲）。
  assert.ok(Number.isSafeInteger(spec.outputLimitBytes) && spec.outputLimitBytes > 0,
    'outputLimitBytes 随迁——完成通知的截断口径不能静默变化');
  assert.equal(Array.isArray(spec.output), true, 'spec.output 必须是拉式源数组');
  assert.deepEqual(spec.output.map((source) => source.channel), ['stdout', 'stderr']);
  assert.equal(typeof spec.output[0].read, 'function', 'JobOutputSource 形状：read(fromByte)');
  // 核心次序：`run` 由注册表在 start 内**同步**回调（准入检查之后），
  // execute 在 run 内发起——所以 execute 必然晚于 admission（触顶/owner 检查
  // 在 `dsh-jobs-local:419` 先于 `:437` 的 run 调用），只是早于 start 返回点。
  assert.deepEqual(order.slice(0, 3), ['admission', 'execute', 'start-returned'],
    `进程只能在准入之后启动；实得 ${JSON.stringify(order)}`);
  // 描述进 progress 行（注册即可见）。
  assert.equal(f.jobsFake.views()[0].progress, 'long build', 'progress 行必须是 description');

  // 结算后：拉式源泵进环形缓冲（fake 注册表结算前最后 drain 一次，与真实契约一致）。
  settle({ exitCode: 0 });
  await new Promise((r) => { setTimeout(r, 0); });
  const views = f.jobsFake.views();
  assert.equal(views[0].status, 'completed', 'hooks.done 的 JobOutcome 耦合注册表结算');
  // 需求 2.2.3 两路径一致：正常退出不加标记（与前台 `exitStatusMarker` 同一条
  // 规则）——detail 里不得再出现退出码行。
  assert.doesNotMatch(views[0].detail ?? '', /exit code|退出码/,
    '正常退出的 detail 不得带退出码标记（前台同口径）');
  const chunks = f.jobsFake.chunksOf(result.job_id);
  assert.ok(chunks.some((chunk) => chunk.text === 'background output' && chunk.channel === 'stdout'),
    'observed.stdout 的内容必须进环形缓冲（async_wait_job 从这里取输出）');
});

hostTest('async_run（R32·prep 窗口）：拉式源在 proc 到位前被泵 → 空增量、游标不动、不误判丢失', async () => {
  const f = fakeCtx();
  immediateTimers(f.ctx);
  // execute 永不 resolve：整个让出窗口里 proc 都未到位。
  f.installShellExecute(() => new Promise(() => {}));
  const tool = createRunTool(f.ctx, config);

  const pending = tool.execute({ command: 'prep hang', description: 'hang prep', yield_ms: 5 }, exec);
  await new Promise((r) => { setTimeout(r, 0); });
  const result = await pending;

  assert.equal(result.status, 'running', '预算到期照常转句柄（prep 悬置：作业在跑预备）');
  const jobId = result.job_id;
  // 结算前泵一次：proc 未到位 → 空读（fake pump 里 text 为空不进 chunks、游标不动）。
  f.ctx.jobs.read(jobId, exec.agent.id);
  assert.deepEqual(f.jobsFake.chunksOf(jobId), [], '空读不得产生分块');
});

hostTest('async_run（0.2.1-rc.2）：请求显式 onExpiry:"none"——内置到期杀进程与本插件语义正面冲突', async () => {
  const f = fakeCtx();
  const { proc } = fakeProc({ text: 'ok' });
  const seen = [];
  f.installShellResolve((request) => { seen.push(request); return request; });
  f.installShellExecute(() => Promise.resolve(proc));

  await createRunTool(f.ctx, config).execute({ command: 'echo', description: 'echo' }, exec);
  assert.equal(seen[0].onExpiry, 'none', '缺省是 "kill"（到期杀进程树）——必须显式 none');
  assert.equal('timeoutMs' in seen[0], false, '"none" 下 timeoutMs 不装 timer，不传');
});

hostTest('async_run：killed 状态的进程映射为 killed 结局并带 signal', async () => {
  const f = fakeCtx();
  immediateTimers(f.ctx);
  const { proc, settle } = fakeProc({ text: '', status: 'killed', signal: 'SIGTERM', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));

  await createRunTool(f.ctx, config).execute({ command: 'x', description: 'x', yield_ms: 5 }, exec);
  settle();
  await new Promise((r) => { setTimeout(r, 0); });
  const view = f.jobsFake.views()[0];
  assert.equal(view.status, 'killed');
  assert.match(view.detail, /SIGTERM/);
});

hostTest('async_run：workdir 缺省取 ensure 返回的会话当前有效目录（不再直读会话头）', async () => {
  const f = fakeCtx();
  const { proc } = fakeProc({ text: 'ok' });
  const seen = [];
  f.installShellResolve((request) => { seen.push(request); return request; });
  f.installShellExecute(() => Promise.resolve(proc));

  await createRunTool(f.ctx, config).execute({ command: 'echo', description: 'echo' }, exec);
  assert.equal(f.ensureCalls.length, 1, '启动前恰调一次 ensure');
  assert.strictEqual(f.ensureCalls[0].agent, exec.agent, 'ensure 收到发起 agent');
  assert.strictEqual(f.ensureCalls[0].signal, exec.signal, 'ensure 收到 exec.signal（取消通道）');
  assert.equal(seen[0].workdir, 'D:\\work', '缺省取 ensure 返回的当前有效目录');
  assert.equal(seen[0].command, 'echo');
});

hostTest('async_run：会话内切目录后缺省与相对 workdir 用新目录，绝对路径原样（需求 §2.2.1）', async () => {
  const f = fakeCtx();
  const { proc } = fakeProc({ text: 'ok' });
  const seen = [];
  f.installShellResolve((request) => { seen.push(request); return request; });
  f.installShellExecute(() => Promise.resolve(proc));
  // 模拟会话切到新目录：ensure 返回 B，会话头仍是 A——直读 header.cwd 会错拿 A。
  f.setWorkingDir('D:\\elsewhere');

  await createRunTool(f.ctx, config).execute({ command: 'a', description: 'a' }, exec);
  assert.equal(seen[0].workdir, 'D:\\elsewhere', '缺省随 ensure 的新目录走，不吃会话头旧值');

  await createRunTool(f.ctx, config).execute({ command: 'b', description: 'b', workdir: 'sub\\x' }, exec);
  assert.equal(seen[1].workdir, resolve('D:\\elsewhere', 'sub\\x'), '相对 workdir 按 ensure 目录解析');

  await createRunTool(f.ctx, config).execute({ command: 'c', description: 'c', workdir: 'E:\\abs' }, exec);
  assert.equal(seen[2].workdir, 'E:\\abs', '绝对 workdir 不被改写');
});

hostTest('async_run：ensure 失败 → 按原因可读拒绝，零作业注册、零进程启动（需求 §2.2.1）', async () => {
  const f = fakeCtx();
  f.setWorkingDir(new Error('工作目录不可用：D:\\gone 已删除且恢复失败'));
  const tool = createRunTool(f.ctx, config);

  await assert.rejects(
    tool.execute({ command: 'echo', description: 'echo' }, exec),
    /工作目录不可用/,
    'ensure 的失败原因必须原样可见，不静默换目录执行'
  );
  assert.equal(f.jobsFake.registeredSpecs.length, 0, '零作业注册');
  assert.equal(f.startedSpecs.length, 0, '零进程启动');
});

hostTest('async_run：ensure 返回后已取消 → 按取消拒绝，注册与启动仍为零', async () => {
  const f = fakeCtx();
  const controller = new AbortController();
  const execX = { agent: fakeAgent(), signal: controller.signal };
  let release;
  const gate = new Promise((r) => { release = r; });
  f.ctx.workingDirectory.ensure = async () => { await gate; return 'D:\\work'; };
  const pending = createRunTool(f.ctx, config).execute({ command: 'echo', description: 'echo' }, execX);

  controller.abort();
  release();
  await assert.rejects(pending, /tool call aborted/);
  assert.equal(f.jobsFake.registeredSpecs.length, 0, '取消发生在准入前——零注册');
  assert.equal(f.startedSpecs.length, 0, '取消发生在启动前——零进程');
});

hostTest('async_run：执行器声明约束时必须随请求带上 sandboxPolicy（勘误）', async () => {
  const f = fakeCtx();
  const { proc } = fakeProc({ text: 'ok' });
  const seen = [];
  const policyCalls = [];
  f.installShellResolve((request) => { seen.push(request); return request; });
  f.installShellExecute(() => Promise.resolve(proc));
  // 必须在创建工具之前装好：闭包在 apply 期解析策略来源。
  f.ctx.shell.sandboxMode = 'workspace-write';
  f.ctx.get = (key) => (key === 'sandboxPolicy'
    ? {
      resolve: (request) => {
        policyCalls.push(request);
        return { mode: 'workspace-write' };
      }
    }
    : undefined);

  await createRunTool(f.ctx, config).execute({ command: 'echo', description: 'echo' }, exec);

  assert.equal(policyCalls.length, 1, '策略必须按每次调用解析一次');
  assert.ok(policyCalls[0].session !== undefined, '策略解析必须带上调用方会话');
  assert.equal(policyCalls[0].session, exec.agent.session, '带入的应是该 agent 的会话对象');
  assert.deepEqual(seen[0].sandboxPolicy, { mode: 'workspace-write' }, '求值结果必须放进 shell 请求');
});

hostTest('async_run：执行器声明约束但策略服务缺失 → fail-fast，不得静默无约束执行', async () => {
  const f = fakeCtx();
  const { proc } = fakeProc({ text: 'ok' });
  f.installShellExecute(() => Promise.resolve(proc));
  f.ctx.shell.sandboxMode = 'workspace-write';
  f.ctx.get = () => undefined;

  await assert.rejects(
    () => createRunTool(f.ctx, config).execute({ command: 'echo', description: 'echo' }, exec),
    /ctx\.sandboxPolicy is missing/
  );
  assert.equal(f.startedSpecs.length, 0, '策略缺失时不得执行进程');
});

hostTest('async_run：readOutput 的增量被累加，不是只取第一次（勘误）', async () => {
  const f = fakeCtx();
  const { proc } = fakeProc({ text: 'ABCDEFGHI', chunked: true });
  f.installShellExecute(() => Promise.resolve(proc));

  const result = await createRunTool(f.ctx, config).execute({ command: 'x', description: 'x' }, exec);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'ABCDEFGHI', '分块输出必须被完整累加');
});

hostTest('async_run：lossy 输出必须显式呈现，不得静默丢弃', async () => {
  const f = fakeCtx();
  immediateTimers(f.ctx);
  const { proc, settle } = fakeProc({ text: 'partial', lossy: true, status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));

  await createRunTool(f.ctx, config).execute({ command: 'x', description: 'x', yield_ms: 5 }, exec);
  // 结算：真实 shell 在结束时才吐出剩余增量，这里模拟同一时序。
  settle({ exitCode: 0 });
  await new Promise((r) => { setTimeout(r, 0); });
  const view = f.jobsFake.views()[0];
  assert.match(view.detail, /output partially dropped from memory/, 'lossy 必须出现在作业结局里');
});

hostTest('J-limit（R11）：outputLimitBytes 必须是**字节**预算，不能把字符数直接传进去', async () => {
  // 缺陷形态：`JobSpec.outputLimitBytes` 的量纲是字节，而配置项叫
  // `maxResultChars`（**字符**）。直接把字符数传进去，中文通知会被提前约 1/3 截断。
  //
  // 这条断言守的是**量纲**：传出去的数必须 ≥ 字符数（即已完成换算），
  // 且不能大到失去意义。只断言"等于 90000"会把实现钉死，所以断言区间。
  const f = fakeCtx();
  immediateTimers(f.ctx);
  const { proc } = fakeProc({ text: 'ok', status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));

  const tool = createRunTool(f.ctx, config);
  await tool.execute({ command: 'echo', description: 'echo', yield_ms: 5 }, exec);

  const spec = f.jobsFake.registeredSpecs[0];
  assert.ok(spec !== undefined, 'async_run 必须调 jobs.start');
  assert.equal(typeof spec.outputLimitBytes, 'number', 'outputLimitBytes 必须存在且是数');
  // **必须严格大于**字符预算。写成 `>=` 会被量纲错误蒙过去。
  assert.ok(
    spec.outputLimitBytes > config.maxResultChars,
    `必须换算成字节预算（严格大于字符数）：期望 > ${String(config.maxResultChars)}，实际 ${String(spec.outputLimitBytes)}`
  );
  assert.ok(
    spec.outputLimitBytes <= config.maxResultChars * 4,
    `换算后不应超过每字符 4 字节的理论上限，实际 ${String(spec.outputLimitBytes)}`
  );
});

hostTest('async_run：显式 workdir 优先于会话工作目录', async () => {
  const f = fakeCtx();
  const { proc } = fakeProc({ text: 'ok' });
  const seen = [];
  f.installShellResolve((request) => { seen.push(request); return request; });
  f.installShellExecute(() => Promise.resolve(proc));

  await createRunTool(f.ctx, config).execute({ command: 'echo', description: 'echo', workdir: 'D:\\other' }, exec);
  assert.equal(seen[0].workdir, 'D:\\other');
});

hostTest('async_run：输出超限时标记 truncated', async () => {
  const f = fakeCtx();
  const longText = 'x'.repeat(50000);
  const { proc } = fakeProc({ text: longText });
  f.installShellExecute(() => Promise.resolve(proc));

  const result = await createRunTool(f.ctx, resolveConfig({ toolName: 'async_run', maxResultChars: 100 }))
    .execute({ command: 'x', description: 'x' }, exec);
  assert.equal(result.truncated, true);
  assert.match(result.output, /output truncated/);
});

// ---------------------------------------------------------------------------
// 以下用例是缺陷防御组。
// ---------------------------------------------------------------------------

/**
 * 自造一个 lossy 句柄：`readOutput()` 的 spill 路径**可选**。
 * `fakeProc({ lossy: true })` 总是带路径，无法覆盖"丢了但没有落点"这一支，
 * 而那一支正是不能对着模型说假话的地方。
 * @param {object} [options] - `{ spillPath, autoResolve }`。
 * @returns {{ proc: object, settle: Function }} 句柄与结算探针。
 */
function lossyProc({ spillPath, autoResolve = true } = {}) {
  let reads = 0;
  let settled = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const fullText = 'partial';
  const proc = {
    status: 'running',
    exitCode: 0,
    signal: null,
    done,
    observed: {
      stdout: { readFrom: (from) => ({ text: fullText.slice(Math.max(0, from)), nextOffset: fullText.length, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
    },
    readOutput: () => {
      if (!settled) return { delta: '', lossy: true };
      reads += 1;
      if (reads > 1) return { delta: '', lossy: true };
      return {
        delta: 'partial',
        lossy: true,
        ...(spillPath === undefined ? {} : { stdoutSpillPath: spillPath })
      };
    }
  };
  const settle = (override) => {
    settled = true;
    proc.status = 'completed';
    if (override !== undefined) Object.assign(proc, override);
    resolveDone(proc);
  };
  if (autoResolve) queueMicrotask(() => settle());
  return { proc, settle };
}

hostTest('async_run：请求必须带 shellEnv.collect(exec) 的 dshEnv', async () => {
  const f = fakeCtx();
  const { proc } = fakeProc({ text: 'ok' });
  const seen = [];
  f.installShellResolve((request) => { seen.push(request); return request; });
  f.installShellExecute(() => Promise.resolve(proc));

  await createRunTool(f.ctx, config).execute({ command: 'echo $env:DSH_HOME', description: 'echo env' }, exec);

  assert.equal(f.shellEnvCalls.length, 1, '每次执行解析一次托管环境');
  assert.equal(f.shellEnvCalls[0], exec, 'collect 收到的必须是本次 exec');
  assert.equal(
    seen[0].dshEnv,
    f.shellEnvSnapshot,
    'dshEnv 必须是 collect(exec) 的返回值本身，不是另拼的同形对象'
  );
});

hostTest('async_run（R32-d）：插话与结算同拍 → 完成优先，返回结算结果而非句柄', async () => {
  // 让插话先赢竞速、结算紧随其后——撤销后的复查必须承接，返回结算结果
  // （防模型重复等待；与 wait 工具同口径）。次序：emit 同步 resolve 插话成员 →
  // 注册表与进程翻终态 → 竞速由插话定局 → 复查读到终态 → 走结算路径。
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const { proc, settle } = fakeProc({ text: 'already done', exitCode: 0, status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));
  const agent = exec.agent;
  const tool = createRunTool(f.ctx, config);

  const pending = tool.execute({ command: 'fast', description: 'fast', yield_ms: 600000 }, exec);
  await new Promise((r) => { setTimeout(r, 5); });
  const jobId = f.jobsFake.views()[0].id;
  f.emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: 'done?', target: 'next-step' }));
  settle({ exitCode: 0 });
  f.jobsFake.settleJob(jobId, { status: 'completed', detail: 'exit code: 0' });

  const result = await pending;
  assert.equal(result.status, 'completed', '终态复查胜过插话——不得返回句柄让模型重复等待');
  assert.equal(result.output, 'already done');
  // 先到扫描（§2.2）会读入口 inbox：模块级共享的 exec 不能跨用例滞留插话，
  // 否则后续用例的首次等待被上一条插话污染（迟到作答/预算到期用例依赖干净入口）。
  exec.agent.inbox.nextStep.splice(0);
});

hostTest('async_run：结算挂在 done.then 上 → start() 返回后同步读必然是 running（注册即终态读不到）', async () => {
  // 这条用例证明的是**否定命题**：注册复查窗口在同构实现上不存在。
  // `JobHooks.done: Promise<JobOutcome>`（[0.2.1-rc.2] dsh-jobs/lib/types/types.d.ts:146-158）
  // 决定了结算至少晚一个 microtask——即便生产者的 done 在 start 内就已 resolve。
  const store = new Map();
  const settled = [];
  function start(spec) {
    const hooks = spec.run({ id: 'probe-1', append() {}, updateProgress() {} });
    const id = 'probe-1';
    store.set(id, { id, status: 'running' });
    Promise.resolve(hooks.done).then((outcome) => {
      store.get(id).status = outcome.status;
      settled.push(id);
    });
    return id;
  }

  const id = start({
    kind: 'k',
    label: 'l',
    output: [],
    run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' }) })
  });

  assert.equal(store.get(id).status, 'running', 'start() 返回后**同步**读到的必然是 running');
  assert.deepEqual(settled, [], '结算还没发生：它挂在 .then 上，至少要等一个 microtask');

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.get(id).status, 'completed', 'microtask 之后才结算');
  assert.deepEqual(settled, [id]);
});

hostTest('async_run（R32-c-e）：预算到期 → 句柄 + 预算口径 note；不提前、不误报插话/迟到', async () => {
  const f = fakeCtx();
  immediateTimers(f.ctx);
  const { proc } = fakeProc({ text: '', status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));

  const result = await createRunTool(f.ctx, config)
    .execute({ command: 'build', description: 'long build', yield_ms: 5 }, exec);

  assert.equal(result.status, 'running');
  assert.match(result.note, /outlived the .* first wait/, '预算路径的开头仍是"超出首次等待"句');
  assert.doesNotMatch(result.note, /ended early: a user message arrived/, '不是插话路径，不得出现提前让出句');
  assert.doesNotMatch(result.note, /A late answer has arrived/, '不是迟到作答路径，不得出现 lateArrived 句');
});

hostTest('async_run：elapsed_ms 覆盖整个让出窗口，不能恒为 0', async () => {
  const f = fakeCtx();
  const fastConfig = resolveConfig({ toolName: 'async_run', minYieldMs: 20, defaultYieldMs: 40 });
  const { proc } = fakeProc({ text: '', status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));

  const result = await createRunTool(f.ctx, fastConfig)
    .execute({ command: 'build', description: 'long build', yield_ms: 40 }, exec);

  assert.equal(result.status, 'running');
  assert.ok(fastConfig.minYieldMs <= 40, '前提：本次首次等待没有被夹紧');
  assert.ok(result.elapsed_ms >= 40, `elapsed_ms 必须覆盖首次等待窗口，实际 ${result.elapsed_ms}`);
  assert.ok(result.elapsed_ms < 10000, `elapsed_ms 不该是别的量级，实际 ${result.elapsed_ms}`);
  assert.match(result.note, /outlived the 40 ms first wait/, 'note 里的等待数字必须取自生效配置');
  assert.match(result.note, new RegExp(`about ${String(result.elapsed_ms)} ms elapsed`), 'note 里的数字必须与 elapsed_ms 一致');
});

hostTest('async_run（总预算平上界）：首次等待路径全程不得超有效 yield_ms + 300ms', async () => {
  // 首次等待路径同口径（设计 §2.1／§8.2 总预算行）：全程上界＝有效
  // yield_ms＋300ms——首次等待之后的收尾（结算注册、note 组装）不得另行
  // 拖延；把 yield 处理挪成定值睡眠或附加等待的变异在此必红。
  const f = fakeCtx();
  const fastConfig = resolveConfig({ toolName: 'async_run', minYieldMs: 20, defaultYieldMs: 40 });
  const { proc } = fakeProc({ text: '', status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));

  const startedAt = Date.now();
  const result = await createRunTool(f.ctx, fastConfig)
    .execute({ command: 'build', description: 'long build', yield_ms: 40 }, exec);
  const took = Date.now() - startedAt;
  assert.equal(result.status, 'running');
  assert.ok(took <= 340, `总时长 ${String(took)} ms 不得超过有效 40ms + 300ms = 340ms`);
});

hostTest('async_run：lossy 且有落点 → note 与作业结局都给出 spill 路径', async () => {
  const f = fakeCtx();
  const first = lossyProc({ spillPath: 'C:\\spill\\stdout.txt' });
  f.installShellExecute(() => Promise.resolve(first.proc));

  const result = await createRunTool(f.ctx, config).execute({ command: 'x', description: 'x' }, exec);

  assert.equal(result.status, 'completed');
  assert.match(result.note, /full output is on disk/);
  assert.match(result.note, /stdout: C:\\spill\\stdout\.txt/, 'spill 路径是找回完整输出的唯一线索');

  // 让出分支：作业结局里同样要带路径（async_wait_job 的终态分支把 detail 原样交给模型）。
  const g = fakeCtx();
  immediateTimers(g.ctx);
  const second = lossyProc({ spillPath: 'C:\\spill\\stdout.txt', autoResolve: false });
  g.installShellExecute(() => Promise.resolve(second.proc));
  const yieldResult = await createRunTool(g.ctx, config)
    .execute({ command: 'x', description: 'x', yield_ms: 5 }, exec);
  assert.equal(yieldResult.status, 'running');
  second.settle({ exitCode: 0 });
  await new Promise((r) => { setTimeout(r, 0); });
  const view = g.jobsFake.views()[0];
  assert.match(view.detail, /output partially dropped from memory/);
  assert.match(view.detail, /full output at stdout: C:\\spill\\stdout\.txt/);
});

hostTest('async_run：lossy 但没有落点 → 必须明说没有落点，不得让模型以为磁盘上还有一份', async () => {
  // 完成分支
  const f = fakeCtx();
  f.installShellExecute(() => Promise.resolve(lossyProc().proc));

  const tool = createRunTool(f.ctx, config);
  const completed = await tool.execute({ command: 'x', description: 'x' }, exec);
  assert.equal(completed.status, 'completed');
  assert.match(completed.note, /no spill file was reported/, '没有落点必须说清楚');
  assert.doesNotMatch(completed.note, /full output is on disk/);

  // 而且**必须到达模型可见文本**——`value.note` 里有不等于模型看得见。
  const completedText = tool.output.render({ command: 'x' }, completed).map((part) => part.text).join('\n');
  assert.match(completedText, /no spill file was reported/, '没有落点必须出现在**模型可见文本**里');
  assert.doesNotMatch(completedText, /full output is on disk/, '模型可见文本里也不许声称磁盘上有');

  // 让出分支（作业结局）
  const g = fakeCtx();
  immediateTimers(g.ctx);
  const proc = lossyProc({ autoResolve: false });
  g.installShellExecute(() => Promise.resolve(proc.proc));
  await createRunTool(g.ctx, config).execute({ command: 'x', description: 'x', yield_ms: 5 }, exec);
  proc.settle({ exitCode: 0 });
  await new Promise((r) => { setTimeout(r, 0); });
  const view = g.jobsFake.views()[0];
  assert.match(view.detail, /no spill file reported/);
  assert.doesNotMatch(view.detail, /full output at/);
});

hostTest('async_run：相对 workdir 按会话工作目录解析；无 cwd 时原样透传', async () => {
  const f = fakeCtx();
  const { proc } = fakeProc({ text: 'ok' });
  const seen = [];
  f.installShellResolve((request) => { seen.push(request); return request; });
  f.installShellExecute(() => Promise.resolve(proc));

  const tool = createRunTool(f.ctx, config);
  // 会话 cwd 是 D:\work（见 fakeAgent）。
  await tool.execute({ command: 'echo', description: 'echo', workdir: 'src' }, exec);
  assert.equal(seen[0].workdir, resolve('D:\\work', 'src'), '相对路径必须挂到会话 cwd 下，而不是服务进程的 cwd');

  await tool.execute({ command: 'echo', description: 'echo', workdir: 'D:\\abs' }, exec);
  assert.equal(seen[1].workdir, 'D:\\abs', '绝对路径原样透传');

  // 有 agent 但会话没有 cwd（拿不到工作目录）时不得自己编一个：原样交给 shell.resolve 回退。
  // （agent 缺席会在入口被拒——无 cwd 的正向用例换成"有 agent、无 cwd"。）
  await tool.execute({ command: 'echo', description: 'echo', workdir: 'src' }, { agent: { id: 'sess-no-cwd' }, signal: exec.signal });
  assert.equal(seen[2].workdir, 'src');
});

hostTest('async_run（R32-a/设计 §3.1）：无 agent 语境 → 拒绝且零注册零进程', async () => {
  const f = fakeCtx();
  const { proc } = fakeProc({ text: 'never' });
  f.installShellExecute(() => Promise.resolve(proc));

  await assert.rejects(
    () => createRunTool(f.ctx, config).execute({ command: 'x', description: 'x' }, { signal: exec.signal }),
    (error) => {
      assert.match(error.message, /no agent context/, '说清拒绝的原因是缺 agent 语境');
      assert.match(error.message, /session whose preset provides a synchronous shell/,
        '给出可行动出路：换到提供同步 shell 的预设会话（本包预设不含内置 pwsh）');
      return true;
    }
  );
  assert.equal(f.jobsFake.registeredSpecs.length, 0, '不得降级注册无主作业（条件④：无主不发完成通知）');
  assert.equal(f.startedSpecs.length, 0, '进程不得启动');
});

hostTest('async_run：描述里写出生效的预算数字（锚②③④都接上了）', async () => {
  const tool = createRunTool(fakeCtx().ctx, resolveConfig({ toolName: 'async_run', defaultYieldMs: 15000, maxWaitMs: 120000 }));
  assert.match(tool.description, /15000 ms/, '首次等待必须来自生效配置');
  assert.match(tool.description, /120000 ms/, '等待上限必须来自生效配置（补缺口）');
  // `async_run` 是**唯一**该看到 yield_ms 与"转后台"的工具。
  assert.match(tool.description, /yield_ms/, 'async_run 必须告诉模型 yield_ms 参数');
  assert.match(tool.description, /job id \(job_id\)/, 'async_run 必须说清超时后转后台');
  // 首次等待的数字口径（默认值＋参数名＋范围）单点落在 digest.yield——刷新
  // 就地改数字的锚就是这一句（描述里不得另起一份重复的区间句）。
  assert.match(tool.description, /The first wait defaults to 15000 ms \(pass yield_ms, range \d+–\d+ ms\)/);
  assert.match(tool.description, /Per-call wait budgets must be passed explicitly, range \d+–120000 ms;/);
  assert.equal(typeof tool.parameters.properties.yield_ms, 'object', 'async_run 的 parameters 里必须有 yield_ms');
  // 并发安全声明：未声明＝exclusive 独占——让出窗口会把同批其他调用全部
  // 串行挡住，恰好废掉「让 Agent 继续其他工作」的本意（批次调度语义见
  // facts 登记簿）。五个工具必须同口径 true。宿主包装器对**参数不合法**的
  // 调用返回 false（dsh-tools :882-885），断言必须带合法参数调用。
  assert.equal(tool.isConcurrencySafe({ command: 'Get-Date', description: 'probe' }), true,
    'async_run 必须声明并发安全（否则同批调用被让出窗口串行）');
});

hostTest('async_run（R8·R32-a）：准入拒绝必须可读可行动——进程未启动、明说"没有进程在运行"', async () => {
  const f = fakeCtx();
  const { proc, settle } = fakeProc({ text: '', status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));
  // 复刻宿主的并发上限报错原文形态。
  f.ctx.jobs.start = () => {
    throw new Error('background job limit reached for this owner (limit: 10); use job_kill to stop an unneeded job, wait for it to finish, then retry');
  };

  let killed = false;
  proc.kill = () => { killed = true; };

  const tool = createRunTool(f.ctx, resolveConfig({ toolName: 'async_run', defaultYieldMs: 1, minYieldMs: 1 }));

  let raised;
  try {
    await tool.execute({ command: 'Start-Sleep 600', description: 'long build' }, exec);
  } catch (error) {
    raised = error;
  }
  settle();

  assert.ok(raised !== undefined, '准入失败必须让本次工具调用失败，不能假装拿到了句柄');
  // 四条都要满足：说得清失败的是启动、给出可行动作、明说**进程未启动**、
  // 并且列出**生效上限**（触顶拒绝的判据）。
  assert.match(raised.message, /refused before the process launched/, '必须说清失败发生在进程启动前');
  assert.match(raised.message, /nothing is running/, '必须明说没有进程在运行——准入在先，无东西可取消');
  assert.match(raised.message, /job_kill/, '必须给出可行动作');
  assert.match(raised.message, /current limit: 10/, '必须复述宿主给的生效上限数字');
  assert.equal(f.startedSpecs.length, 0, 'R32-a：准入在进程启动前——触顶时 execute 一次都不能被调用');
  assert.equal(killed, false, '没有进程，也就没有 kill 可言');
});

hostTest('async_run（R8/#13a）：上限报错必须列出**存活的**作业 id 与状态', async () => {
  const f = fakeCtx();
  const { proc, settle } = fakeProc({ text: '', status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));
  f.ctx.jobs.start = () => {
    throw new Error('background job limit reached for this owner (limit: 10); use job_kill to stop an unneeded job, wait for it to finish, then retry');
  };
  // 关键：这份清单里**终态的那条不许出现**——模型要 kill 的是还在跑的，不是已完成的。
  f.ctx.jobs.list = () => [
    { id: 'async-command-3', status: 'running', label: 'Sleep 60s' },
    { id: 'async-command-4', status: 'completed', label: 'echo done' },
    { id: 'async-command-5', status: 'failed', label: 'bad build' }
  ];

  let raised;
  try {
    await createRunTool(f.ctx, resolveConfig({ toolName: 'async_run', defaultYieldMs: 1, minYieldMs: 1 }))
      .execute({ command: 'Start-Sleep 600', description: 'long build' }, exec);
  } catch (error) {
    raised = error;
  }
  settle();

  assert.ok(raised !== undefined);
  assert.match(raised.message, /async-command-3/, '存活的作业必须出现在文案里');
  assert.match(raised.message, /running/, '应当带上状态，模型才知道该 kill 哪个');
  assert.doesNotMatch(raised.message, /async-command-4/, '已完成的不该混进"存活"清单');
  assert.doesNotMatch(raised.message, /async-command-5/, '已失败的不该混进"存活"清单');
});

hostTest('async_run（R8/#13a）：清单查询失败不得盖掉真正的原因', async () => {
  const f = fakeCtx();
  const { proc, settle } = fakeProc({ text: '', status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));
  f.ctx.jobs.start = () => { throw new Error('background job limit reached for this owner (limit: 10)'); };
  f.ctx.jobs.list = () => { throw new Error('jobs service exploded'); };

  let raised;
  try {
    await createRunTool(f.ctx, resolveConfig({ toolName: 'async_run', defaultYieldMs: 1, minYieldMs: 1 }))
      .execute({ command: 'Start-Sleep 600', description: 'long build' }, exec);
  } catch (error) {
    raised = error;
  }
  settle();

  // 抛出的必须是**启动被拒**这件事，而不是"列清单时炸了"。
  assert.ok(raised !== undefined);
  assert.match(raised.message, /refused before the process launched/, '真正的原因必须还在');
  assert.doesNotMatch(raised.message, /jobs service exploded/, '清单查询的异常不该出现在给模型的文案里');
  assert.match(raised.message, /No other live jobs were found/, '查不到时应如实说查不到');
});

hostTest('async_run（注册拒绝分流）：非触顶的注册拒绝不得套触顶模板——不引导 kill、不列存活清单', async () => {
  const f = fakeCtx();
  const { proc, settle } = fakeProc({ text: '', status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));
  // 宿主注册拒绝的**非容量**形态：预算换算/校验拒绝等，报错原文没有 `limit: N` 注记。
  f.ctx.jobs.start = () => {
    throw new Error('job registration failed: label exceeds the maximum length allowed by the host registry');
  };
  // 若实现误走触顶路径，listAliveJobs 会调 jobs.list——这里探针式记账，断言它没被碰。
  let listed = 0;
  f.ctx.jobs.list = () => { listed += 1; return []; };

  let raised;
  try {
    await createRunTool(f.ctx, resolveConfig({ toolName: 'async_run', defaultYieldMs: 1, minYieldMs: 1 }))
      .execute({ command: 'Start-Sleep 600', description: 'long build' }, exec);
  } catch (error) {
    raised = error;
  }
  settle();

  assert.ok(raised !== undefined, '注册失败必须让本次调用失败');
  // 分流判据：宿主原文可读在场（单行化后）＋ 明说不是并发上限 ＋ 原因原样。
  assert.match(raised.message, /refused before the process launched/, '仍要说清失败发生在进程启动前');
  assert.match(raised.message, /This is not a capacity limit; stopping other jobs will not help\./,
    '非触顶拒绝必须明说腾位无用——不让模型去找无关作业的麻烦');
  assert.match(raised.message, /label exceeds the maximum length/, '宿主的真实原因必须原样可读');
  // 不得出现触顶模板的三件套：kill 指引、生效上限复述、存活清单。
  assert.doesNotMatch(raised.message, /job_kill/, '非触顶拒绝不给 kill 指引（没有那种出路）');
  assert.doesNotMatch(raised.message, /current limit/i, '没有 limit: N 注记就不得复述上限');
  assert.doesNotMatch(raised.message, /async-command-\d/, '不该列存活作业清单');
  assert.equal(listed, 0, '非触顶路径根本不该去查存活清单（listAliveJobs 是触顶分支专属）');
});

hostTest('async_run（注册拒绝·操作者通道）：完整原文进 stderr 且单行化——多行宿主原文不得伪造日志行（§6.2/§6.3）', async () => {
  const f = fakeCtx();
  const { settle } = fakeProc({ text: '', status: 'running', autoResolve: false });
  f.installShellExecute(() => { throw new Error('shell must not be reached'); });
  // 宿主注册拒绝原文带换行（堆栈形态）：模型侧截断单行，操作者侧 stderr 必须
  // 吃到**完整**原文（不只是截断段）且不得因换行拆行。
  const rawLines = ['job registration failed: validation stack', '  at jobs.start (host.js:9:3)', '\tinner: label invalid'];
  f.ctx.jobs.start = () => { throw new Error(rawLines.join('\n')); };

  const stderrChunks = [];
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };
  let raised;
  try {
    await createRunTool(f.ctx, resolveConfig({ toolName: 'async_run', defaultYieldMs: 1, minYieldMs: 1 }))
      .execute({ command: 'Start-Sleep 600', description: 'long build' }, exec);
  } catch (error) {
    raised = error;
  } finally {
    process.stderr.write = realStderrWrite;
  }
  settle();

  assert.ok(raised !== undefined, '注册失败必须让本次调用失败');
  const captured = stderrChunks.join('');
  const lines = captured.split('\n');
  const notice = lines.find((line) => line.includes('注册拒绝') && line.includes('完整原文'));
  assert.ok(notice !== undefined, '完整原文必须有一条 stderr 操作者日志');
  assert.ok(notice.includes('validation stack') && notice.includes('inner: label invalid'),
    'stderr 行携带完整原文（含模型侧被截断的尾部内容）');
  assert.ok(lines.every((line) => !line.trimStart().startsWith('at jobs.start')),
    '换行被转义——宿主堆栈不得成为独立日志行');
});

// ---------------------------------------------------------------------------
// T7：把返回值喂给宿主自己的输出校验器。
// ---------------------------------------------------------------------------

hostTest('async_run（T7）：exitCode / signal 为 null 时完成分支仍必须通过 output.schema', async () => {
  const f = fakeCtx();
  // 进程结束时没有退出码（status 由 settle() 翻成 completed，exitCode 保持 null）。
  const { proc, settle } = fakeProc({ text: 'SHORT_OK', exitCode: null, status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));

  const pending = createRunTool(f.ctx, config)
    .execute({ command: 'Write-Output SHORT_OK', description: 'probe' }, exec);
  settle();
  const result = await pending;

  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'SHORT_OK');
  // 该 DSL 的 `type` 只接受**单个**类型串，写不出"number 或 null"；可空字段只能靠
  // "没值就不写这个键"。写成 `exit_code: proc.exitCode ?? null` 会让完成分支匹配 0 支。
  assert.equal('exit_code' in result, false, 'null 不是 number，不能写进 exit_code');
  assert.equal('signal' in result, false, 'null 不是 string，不能写进 signal');
  assert.equal(Object.hasOwn(result, 'note'), false);
});

hostTest('async_run（T7）：lossy + 无退出码同时出现时，完成分支仍然合法（note 与可选字段共存）', async () => {
  const f = fakeCtx();
  const lossy = lossyProc({ spillPath: 'C:\\spill\\stdout.txt' });
  lossy.proc.exitCode = null;
  f.installShellExecute(() => Promise.resolve(lossy.proc));

  const completed = await createRunTool(f.ctx, config)
    .execute({ command: 'x', description: 'x' }, exec);

  assert.equal(completed.status, 'completed');
  assert.equal('exit_code' in completed, false);
  assert.match(completed.note, /full output is on disk/, 'note 必须与"没有退出码"共存于同一个分支');
});

hostTest('async_run（T7）：校验器活性证明——`exit_code: null` 确实会被判违规', () => {
  const tool = buildRunTool(fakeCtx().ctx, config);
  const violations = validateJsonSchemaValue(
    tool.output.schema,
    { status: 'completed', exit_code: null, output: 'x', truncated: false },
    'value'
  );
  assert.ok(violations.length > 0, '若这里为空，说明上面那两条断言是恒真的');
  assert.match(
    violations.join('; '),
    /must match exactly one oneOf branch \(matched 0\)/,
    '错误文案必须与真机上报的一致'
  );
});

hostTest('J-render（R11 P1）：async_run 的完成分支必须把 note 渲染进模型可见文本', () => {
  // 缺陷形态：完成分支的 `render` 若只带
  // `value.output`，"输出被内存丢弃、完整输出在 <路径>"这句 `note` **永远到不了模型眼前**。
  //
  // 根因是**把"值里有"当成了"模型看得见"**：结构化 `value` 不进模型上下文。
  const tool = buildRunTool(fakeCtx().ctx, resolveConfig({ toolName: 'async_run' }));

  // ① 完成 + lossy：note 必须在渲染文本里（样例串用英文——模型侧口径）。
  // 截断标注改由 `truncate` 嵌进 `output` 正文（双语带省略量，真实路径由
  // 「输出超限时标记 truncated」与 output.test 锁定），render 层不追加。
  const lossyText = tool.output.render({ command: 'x' }, {
    status: 'completed',
    output: 'OUT',
    truncated: true,
    note: 'output partially dropped; full output at C:\\Temp\\spill\\async_run-1-stdout.log'
  }).map((part) => part.text).join('\n');
  assert.match(lossyText, /^OUT/, '输出本体要在最前面');
  assert.match(lossyText, /output partially dropped/, 'lossy 说明必须在模型可见文本里');
  assert.match(lossyText, /async_run-1-stdout\.log/, '落点路径必须在模型可见文本里');

  // ② 完成 + 无 note：不得凭空多出内容。
  const cleanText = tool.output.render({ command: 'x' }, {
    status: 'completed',
    output: 'OUT',
    truncated: false
  }).map((part) => part.text).join('\n');
  assert.equal(cleanText, 'OUT');

  // ③ 让出分支仍走 note（既有行为不变）。
  const yieldText = tool.output.render({ command: 'x' }, {
    status: 'running',
    job_id: 'j1',
    elapsed_ms: 2100,
    note: 'still running'
  }).map((part) => part.text).join('\n');
  assert.equal(yieldText, 'still running');
});

// ---------------------------------------------------------------------------
// 安全/健壮性/异常处理的缺陷防御判据。
// ---------------------------------------------------------------------------

hostTest('R29-e（判据 7·）：让出窗口内进程被信号终止且 done 照常 resolve → killed 结局带部分输出，且过 output schema', async () => {
  const f = fakeCtx();
  // done 在预算内 resolve（微任务先行，赢过 5ms 的让出定时器），但 status 是
  // 'killed'——被杀进程的 done 也是 resolve。无条件走 completed
  // 分支等于对模型说"正常完成"——那是缺陷形态。
  const { proc } = fakeProc({ text: 'partial output', exitCode: null, signal: 'SIGTERM', status: 'killed', autoResolve: true });
  f.installShellExecute(() => Promise.resolve(proc));
  const tool = createRunTool(f.ctx, config);

  // checkedTool：返回值先过宿主 output 校验器（三支 oneOf：completed/killed/running）。
  // 撤掉 schema 的 killed 支（或 killed 分支返回体超形）→ 本用例当场红（撤支必红）。
  const result = await tool.execute({ command: 'build', description: 'x', yield_ms: 5 }, exec);

  assert.equal(result.status, 'killed');
  assert.equal(result.output, 'partial output', 'killed 也要带让出窗口内已收到的字节（决定：已收到的字节照常交付）');
  assert.equal(result.truncated, false);
  assert.match(result.detail, /SIGTERM/, 'detail 必须注明致死信号');
  assert.equal(f.jobsFake.registeredSpecs.length, 1, 'R32-a：执行即注册——预算内 killed 同样注册过（终态卡残留已裁定接受）');

  // 渲染侧：killed 形态的模型可见文本 = detail 行（致死信号是头条）+ 输出本体。
  const killedText = tool.output.render({ command: 'build' }, result).map((part) => part.text).join('\n');
  assert.match(killedText, /^signal: SIGTERM/, 'killed 的头条是致死信号');
  assert.match(killedText, /^partial output$/m, '部分输出本体也要在模型可见文本里');
});

hostTest('R29-e（判据 7b·无文形态）：killed 且无任何输出 → 不带 output 键，渲染只剩 detail', async () => {
  // "没值就不写这个键"是 jobOutcome 对可空字段的口径：无文的 killed
  // 不得凭空多出 output:''（空串会让模型以为"确认读过、确实没有"，而事实是"没收到"）。
  const f = fakeCtx();
  const { proc } = fakeProc({ text: '', exitCode: null, signal: 'SIGKILL', status: 'killed', autoResolve: true });
  f.installShellExecute(() => Promise.resolve(proc));
  const tool = createRunTool(f.ctx, config);

  const result = await tool.execute({ command: 'build', description: 'x', yield_ms: 5 }, exec);
  assert.equal(result.status, 'killed');
  assert.equal('output' in result, false, '无文 killed 不得带 output 键');
  assert.equal('truncated' in result, false);
  assert.match(result.detail, /SIGKILL/);

  const killedText = tool.output.render({ command: 'build' }, result).map((part) => part.text).join('\n');
  assert.match(killedText, /^signal: SIGKILL/, '渲染只剩 detail 行');
});

hostTest('F-D：killed 无 signal／无丢失标记／无输出 → 渲染仍含两语终态状态行，不得为空串', () => {
  // 设计 §3.1（与需求 §2.2.2 终态可分辨的要求一致）：无细节形态的可见文本同样非空——
  // 空串会让模型把被杀当成「没有结果」，三形终态必须可分辨。
  const f = fakeCtx();
  const tool = createRunTool(f.ctx, config);

  const enText = tool.output.render({ command: 'x' }, { status: 'killed' }).map((p) => p.text).join('\n');
  assert.notEqual(enText, '', '无 signal、无丢失标记、无输出的 killed 不得渲染成空串');
  assert.match(enText, /\[job killed\]/, 'en 终态状态行回退在场');

  const zhTool = createRunTool(f.ctx, resolveConfig({ toolName: 'async_run', agentLang: 'zh' }));
  const zhText = zhTool.output.render({ command: 'x' }, { status: 'killed' }).map((p) => p.text).join('\n');
  assert.match(zhText, /\[作业已终止\]/, 'zh 终态状态行回退在场');

  // detail 缺席但有部分输出 → 状态行＋输出，两段都在（不能只剩裸输出认不出被杀）。
  const withOutput = tool.output.render({ command: 'x' }, { status: 'killed', output: 'partial' }).map((p) => p.text).join('\n');
  assert.match(withOutput, /\[job killed\]/);
  assert.match(withOutput, /^partial$/m);

  // detail 在场 → 维持既有形态：头条仍是 signal 细节，不叠加状态行。
  const withDetail = tool.output.render({ command: 'x' }, { status: 'killed', detail: 'signal: SIGTERM' }).map((p) => p.text).join('\n');
  assert.match(withDetail, /^signal: SIGTERM/);
  assert.doesNotMatch(withDetail, /\[job killed\]/);
});

hostTest('R29-c（判据 5·drain 读失败）：readOutput 抛错 → 结局必须带丢失标记，不得静默吞掉', async () => {
  const f = fakeCtx();
  // 自造句柄：readOutput 永远抛（模拟宿主输出通道在结算瞬间坏掉）。
  const throwReadProc = () => {
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const proc = {
      status: 'running', exitCode: 0, signal: null, done,
      observed: {
        stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
      },
      readOutput: () => { throw new Error('output channel broken'); },
      kill: () => {}
    };
    queueMicrotask(() => { proc.status = 'completed'; resolveDone(proc); });
    return proc;
  };
  f.installShellExecute(() => Promise.resolve(throwReadProc()));
  const tool = createRunTool(f.ctx, config);

  const result = await tool.execute({ command: 'x', description: 'x' }, exec);
  assert.equal(result.status, 'completed');
  assert.match(JSON.stringify(result), /was dropped/,
    'drainLossy 必须走 isLossy() 出口进模型可见的丢失标记（spillNone 文案）');
});

hostTest('R29-c（判据 5·守卫触顶）：readOutput 永不排空 → 10000 次后守卫让位，结局必须带丢失标记', async () => {
  const f = fakeCtx();
  // 极端输出量：drain 的 guard 上界（10000 次循环）触顶让位。触顶 = "还有字节
  // 没进结果"，与宿主环形丢弃同性质——不给标记就是静默截断。
  const endlessProc = () => {
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const proc = {
      status: 'running', exitCode: 0, signal: null, done,
      observed: {
        stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
      },
      readOutput: () => ({ delta: 'x', lossy: false }),
      kill: () => {}
    };
    queueMicrotask(() => { proc.status = 'completed'; resolveDone(proc); });
    return proc;
  };
  f.installShellExecute(() => Promise.resolve(endlessProc()));
  const tool = createRunTool(f.ctx, config);

  const result = await tool.execute({ command: 'x', description: 'x' }, exec);
  assert.equal(result.status, 'completed');
  // 守卫按**单次 drain** 让位（10000 分块）：done 钩子与前台结算各 drain 一次，
  // 这里只钉守卫确实让位（≥10000）且结局带丢失标记——不钉 drain 次数这种实现细节。
  assert.ok(result.output.length >= 10000, `守卫让位前必须已累计 ≥10000 个分块，实际 ${result.output.length}`);
  assert.match(JSON.stringify(result), /was dropped/, '守卫触顶必须置 drainLossy 并给模型可见标记');
});

hostTest('R29-f（判据 11·让出日志单行化）：label=命令原文（R33-a）带 CRLF/TAB → 必须转义，日志一行', async () => {
  const f = fakeCtx();
  immediateTimers(f.ctx);
  const { proc } = fakeProc({ text: 'bg', status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));
  const tool = createRunTool(f.ctx, config);

  await tool.execute({ command: 'line1\r\nline2\tend', description: 'd', yield_ms: 5 }, exec);

  const line = f.logs
    .filter(([level]) => level === 'info')
    .map(([, message]) => message)
    .find((message) => message.includes('label='));
  assert.ok(line !== undefined, '让出必须记操作者日志');
  assert.doesNotMatch(line, /[\r\n]/, 'escapeLogValue 必须把 CR/LF 转成字面 \\r\\n——日志注入收成单行');
  assert.match(line, /label=line1\\r\\nline2\\tend/, 'label= 现在是命令原文（R33-a），转义后的字面序列要在');
});

hostTest('R29-f（判据 11·注册失败单行化）：宿主原文多行超长 → 模型侧单行 + 500 截断 + 操作者日志留全文', async () => {
  const f = fakeCtx();
  immediateTimers(f.ctx);
  const { proc } = fakeProc({ text: 'bg', status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));
  // 614 字符、含 \n、\r\n\t：拍平后 612 → 模型侧截到 500 + (+112)。
  const rawDetail = `${'X'.repeat(250)}\n${'Y'.repeat(250)}\r\n\t${'Z'.repeat(110)}`;
  f.ctx.jobs.start = () => { throw new Error(rawDetail); };
  const tool = createRunTool(f.ctx, config);

  await assert.rejects(
    () => tool.execute({ command: 'build', description: 'x', yield_ms: 5 }, exec),
    (error) => {
      assert.doesNotMatch(error.message, /[\r\n]/, '模型侧错误必须单行');
      assert.ok(error.message.includes('(+112)'), `500 之后的余额要以 (+N) 注明；实得：${error.message.slice(-40)}`);
      return true;
    }
  );
  const full = f.logs
    .filter(([level]) => level === 'warn')
    .map(([, message]) => message)
    .find((message) => message.includes('full detail'));
  assert.ok(full !== undefined && full.includes(rawDetail),
    '完整原文（含换行）必须留在操作者日志——单行化只作用于模型侧，不丢线索');
});

// ---------------------------------------------------------------------------
// 首次等待的五信号竞速：结算/插话/abort/迟到作答/预算。
// 预算与结算路径已有上方用例；这里补插话、迟到、abort、prep 窗口 kill 与
// 通知计数的判据。预算路径由 yield_ms=600000 的大预算排除（fake
// jobs.wait 的超时走全局 setTimeout，freezeTimers 只冻结 ctx.timer——它冻结
// 不了这里的预算）。`pending` 若在毫秒级收敛，只能来自
// 注入的信号本身（单元层"微任务级联"判据）。
// ---------------------------------------------------------------------------

hostTest('async_run（R32-b·插话）：让出窗口内用户消息到达 → 秒回句柄 + 提前让出注记，命令零影响', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const { proc, isKilled } = fakeProc({ text: 'partial', status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));
  const agent = exec.agent;
  const tool = createRunTool(f.ctx, config);

  const pending = tool.execute({ command: 'build', description: 'long build', yield_ms: 600000 }, exec);
  await new Promise((r) => { setTimeout(r, 5); });
  f.emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: 'hold on', target: 'next-step' }));

  const result = await pending;
  assert.equal(result.status, 'running', '插话 → 转后台句柄（R32-c-b），不是 interrupted（那是 wait 工具的形状）');
  assert.match(result.note, /ended early: a user message arrived/, 'note 注明因用户到达提前让出');
  assert.match(result.note, /async_wait_job\(job_id="/, '恢复示例照带');
  assert.equal(isKilled(), false, '插话只结束等待，绝不终止命令');
  assert.equal(f.jobsFake.views()[0].status, 'running', '作业必须存活');
  // 竞速定局即撤销 → waiter 已摘 → 结算时不计 awaited。
  assert.equal(f.jobsFake.waitersOf(result.job_id), 0, '句柄返回后不得残留 waiter（否则通知被吞）');
  f.jobsFake.settleJob(result.job_id, { status: 'completed', detail: 'exit code: 0' });
  assert.equal(f.jobsFake.wasAwaited(result.job_id), false, '撤销后的结算 awaited=false → 完成通知照发（恢复通道）');
  // 同上：清掉本用例滞留的插话，别污染后续用例的先到扫描。
  exec.agent.inbox.nextStep.splice(0);
});

hostTest('async_run（R32-b·迟到作答）：让出窗口内迟到作答到达 → 句柄 + lateArrived（与 wait 工具同键）', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const { proc } = fakeProc({ text: 'partial', status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));
  const agent = exec.agent;
  const tool = createRunTool(f.ctx, config);

  const pending = tool.execute({ command: 'build', description: 'long build', yield_ms: 600000 }, exec);
  await new Promise((r) => { setTimeout(r, 5); });
  f.emit(LATE_ANSWER_EVENT, {
    agentId: agent.id, questionId: 'color', kind: 'answer', summary: 'Late answer for color: red'
  });

  const result = await pending;
  assert.equal(result.status, 'running');
  assert.match(result.note, /A late answer has arrived \(Late answer for color: red\)/, 'lateArrived 键 + summary（题号在册）');
  assert.match(result.note, /async_wait_job\(job_id="/, '句柄示例照带');
  assert.equal(f.jobsFake.waitersOf(result.job_id), 0, '同样撤销在先：不残留 waiter');
});

hostTest('async_run（R32-c·abort）：GUI 停止 → 句柄形状返回（宿主改写、模型不可见）、作业存活、结算通知可恢复', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const { proc, isKilled } = fakeProc({ text: 'partial', status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));
  const execAbort = new AbortController();
  const execLocal = { agent: exec.agent, signal: execAbort.signal };
  const tool = createRunTool(f.ctx, config);

  const pending = tool.execute({ command: 'build', description: 'long build', yield_ms: 600000 }, execLocal);
  await new Promise((r) => { setTimeout(r, 5); });
  execAbort.abort(new Error('tool call aborted'));

  const result = await pending;
  // 宿主会把整个结果改写为 "Error: tool call aborted"——模型看不到这个值；
  // 但返回值必须仍是合法形状（output schema 由 checkedTool 验证），且作业必须
  // 存活：撤销后的结算通知是 abort 后模型唯一的恢复通道。
  assert.equal(result.status, 'running', 'abort 分支按句柄口径返回（宿主整体改写，形状合法即可）');
  assert.equal(isKilled(), false, 'abort 绝不终止命令（R32-c：与 exec.signal 无关的作业私有通道才管 kill）');
  assert.equal(f.jobsFake.views()[0].status, 'running', '作业必须存活（不 kill、不 remove）');
  assert.equal(f.jobsFake.waitersOf(result.job_id), 0, 'wait 已被 abort 摘除');
  assert.match(result.note, /cancelled during the first wait/, 'F9：内部结果按取消口径给原因（不冒称超出预算）');
  assert.doesNotMatch(result.note, /outlived the /, 'F9：取消不得并入预算到期说明');
  f.jobsFake.settleJob(result.job_id, { status: 'completed', detail: 'exit code: 0' });
  assert.equal(f.jobsFake.wasAwaited(result.job_id), false, '结算通知照发——abort 的恢复通道');
});

hostTest('async_run（R32·prep 窗口 kill，S2）：execute 未 resolve 时 job_kill → 作业私有 signal 生效，归 killed', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  // execute 悬置（prep 窗口），只在作业私有 signal abort 时拒绝——pwsh processJob 的
  // spawn 前中止形态（dsh-tool-pwsh:100-126）。
  f.installShellExecute((spec) => new Promise((_, reject) => {
    spec.signal.addEventListener('abort', () => reject(new Error('spawn aborted before start')));
  }));
  const tool = createRunTool(f.ctx, config);

  const pending = tool.execute({ command: 'slow-prep', description: 'prep window', yield_ms: 600000 }, exec);
  await new Promise((r) => { setTimeout(r, 5); });
  const jobId = f.jobsFake.views()[0].id;
  assert.equal(f.jobsFake.killJob(jobId, 'test kill in prep window'), true, 'kill 必须经 hooks.cancel 到达');

  const result = await pending;
  assert.equal(result.status, 'killed', 'prep 窗口的 kill 不得丢请求：done 链按 aborted+无进程 归 killed');
  assert.equal('output' in result, false, '无进程无输出——killed 无文形态（不凭空多 output:""）');
  assert.match(result.detail, /spawn aborted before start/);
});

hostTest('async_run（prep 窗口）：prep 失败——execute 异步拒绝（非 kill）→ 作业按 failed 结算，原始错误原样重抛', async () => {
  // done 链把 execute 拒绝分类为 {status:'failed'} → 注册表按 failed 结算 →
  // 首次等待带回 failed view → settleNow 重抛闭包里的原始错误（与
  // 「准备失败直接抛」等价；作业侧终态卡在册，job_list 可见）。
  // 缺省 workdir 的准备失败无新信息：不加诊断、原样重抛（诊断只服务显式
  // workdir，见下方 prep 诊断用例组）。
  const f = fakeCtx();
  freezeTimers(f.ctx);
  f.installShellExecute(() => Promise.reject(new Error('spawn EPERM at process creation')));
  const tool = createRunTool(f.ctx, config);

  await assert.rejects(
    () => tool.execute({ command: 'bad-prep', description: 'prep fail', yield_ms: 600000 }, exec),
    (error) => {
      const text = error instanceof Error ? error.message : String(error);
      assert.ok(text.includes('spawn EPERM at process creation'), '原始错误不得被吞成别的形状');
      assert.ok(!text.includes('Requested workdir'), '缺省 workdir 不加诊断');
      return true;
    }
  );
  const views = f.jobsFake.views();
  assert.equal(views.length, 1, '执行即注册：prep 失败也留下作业记录');
  assert.equal(views[0].status, 'failed', '作业按 failed 结算（宿主 done→结算契约，通知侧同 killed 路）');
  assert.match(views[0].detail, /spawn EPERM/);
});

// ---------------------------------------------------------------------------
// 显式 workdir 的 shell 准备失败诊断（设计 §3.1）。反例形态：真机上显式
// workdir 指向不存在的目录时，模型只收到 spawn ENOENT 原文——没有请求
// 目录，也没有检查／改正出路。目录存在性核实走真实文件系统（失败时刻
// stat），不 mock 判定：可证实的才断言「目录不存在」。
// ---------------------------------------------------------------------------

hostTest('async_run（prep 诊断·目录不存在）：显式 workdir 指向不存在目录 → 五要素诊断＋「目录不存在」，原错独立拼接，重抛与注册表 detail 同一文本', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const base = await mkdtemp(join(tmpdir(), 'prep-diag-missing-'));
  try {
    f.setWorkingDir(base);
    f.installShellExecute(() => Promise.reject(new Error('spawn C:\\Program Files\\nodejs\\node.exe ENOENT')));
    const tool = createRunTool(f.ctx, config);

    let message = '';
    await assert.rejects(
      () => tool.execute(
        { command: 'probe-missing', description: 'prep diag', workdir: 'missing-dir', yield_ms: 600000 },
        exec
      ),
      (error) => { message = error instanceof Error ? error.message : String(error); return true; }
    );
    assert.ok(message.includes('Requested workdir: missing-dir'), '请求原值在场');
    assert.ok(message.includes(resolve(base, 'missing-dir')), '解析绝对路径在场');
    assert.ok(message.includes(base), '会话当前目录在场');
    assert.ok(message.includes('The resolved directory does not exist.'), '可证实的「目录不存在」结论');
    assert.ok(message.includes('Correct workdir and retry'), '修正重试出路在场');
    assert.ok(message.includes('spawn C:\\Program Files\\nodejs\\node.exe ENOENT'), '真实原错在场');
    assert.equal(
      message.split('spawn C:\\Program Files\\nodejs\\node.exe ENOENT').length - 1, 1,
      '原错原文恰出现一次、未被改写或重复拼接'
    );
    assert.ok(
      message.indexOf('node.exe ENOENT') > message.indexOf('Correct workdir and retry'),
      '原错独立拼接在诊断之后（不进占位模板）'
    );

    const views = f.jobsFake.views();
    assert.equal(views[0].status, 'failed', '终态保持 failed（诊断不改判）');
    assert.equal(views[0].detail, message, '后台 detail 与首次重抛同一文本（两路径一致，设计 §3.1）');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

hostTest('async_run（prep 诊断·目录存在）：目录实际在而失败另有原因 → 明示「目录存在、原因在别处」，不妄断目录缺失、不切目录', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const base = await mkdtemp(join(tmpdir(), 'prep-diag-exists-'));
  try {
    f.setWorkingDir(base);
    f.installShellExecute(() => Promise.reject(new Error('spawn EPERM at process creation')));
    const tool = createRunTool(f.ctx, config);

    let message = '';
    await assert.rejects(
      () => tool.execute(
        { command: 'probe-exists', description: 'prep diag', workdir: base, yield_ms: 600000 },
        exec
      ),
      (error) => { message = error instanceof Error ? error.message : String(error); return true; }
    );
    assert.ok(message.includes('The resolved directory exists'), '明示目录存在');
    assert.ok(!message.includes('does not exist'), '不把失败妄断为目录缺失');
    assert.ok(message.includes('spawn EPERM at process creation'), '真实原错保留');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

hostTest('async_run（prep 诊断·killed 排除）：prep 窗口被 kill → 仍按 killed 原样呈现，不套 workdir 诊断', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const base = await mkdtemp(join(tmpdir(), 'prep-diag-killed-'));
  try {
    f.setWorkingDir(base);
    f.installShellExecute((spec) => new Promise((_, reject) => {
      spec.signal.addEventListener('abort', () => reject(new Error('spawn aborted before start')));
    }));
    const tool = createRunTool(f.ctx, config);

    const pending = tool.execute(
      { command: 'slow-prep', description: 'prep window', workdir: 'missing-dir', yield_ms: 600000 },
      exec
    );
    await new Promise((r) => { setTimeout(r, 5); });
    const jobId = f.jobsFake.views()[0].id;
    f.jobsFake.killJob(jobId, 'test kill in prep window');

    const result = await pending;
    assert.equal(result.status, 'killed', '中止形态按 killed 归类（诊断不覆盖，设计 §3.1）');
    assert.match(result.detail, /spawn aborted before start/);
    assert.ok(!String(result.detail).includes('Requested workdir'), 'killed 形态不带诊断');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 核实的第四档（设计 §3.1）：workdir 指向**已存在的普通文件**——spawn 侧报
// ENOTDIR（把它当 cwd 用），stat 核实却成功且不是目录。旧实现只看 stat 成败，
// 会误报「目录存在、失败原因在别处」，把读者引去查命令本身。
// ---------------------------------------------------------------------------

hostTest('async_run（prep 诊断·不是目录）：workdir 指向已存在的普通文件 → 明示「路径已存在但不是目录」，不误导查别处', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const base = await mkdtemp(join(tmpdir(), 'prep-diag-notdir-'));
  try {
    f.setWorkingDir(base);
    const filePath = join(base, 'plain-file');
    await writeFile(filePath, 'x', 'utf8');
    f.installShellExecute(() => Promise.reject(new Error('spawn C:\\cwd\\plain-file ENOTDIR')));
    const tool = createRunTool(f.ctx, config);

    let message = '';
    await assert.rejects(
      () => tool.execute(
        { command: 'probe-notdir', description: 'prep diag', workdir: filePath, yield_ms: 600000 },
        exec
      ),
      (error) => { message = error instanceof Error ? error.message : String(error); return true; }
    );
    assert.ok(message.includes('The resolved path exists but is not a directory'), '第四档结论：路径已存在但不是目录');
    assert.ok(!message.includes('failure has another cause'), '不得再误报「原因在别处」');
    assert.ok(message.includes('spawn C:\\cwd\\plain-file ENOTDIR'), '真实原错保留');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// killed 触发形态（设计 §3.1）：宿主本地 shell 执行器的「进程未上报结局」契约
// ——spawn 失败时 execute 照常 resolve 出句柄、以 killed 结算（退出码与信号皆
// null）、整条观测 stderr 被替换为宿主注记。R7 的用例只覆盖 execute 拒绝形态；
// 本组用例钉住这一 killed 形态的核实诊断。检测信号＝「注记在输出中＋无退出码无信号」。
// ---------------------------------------------------------------------------

hostTest('async_run（prep 诊断·未上报结局）：killed＋注记＋显式 workdir → 附 stat 核实诊断，保留 killed 状态与原错，两出口同一文本', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const base = await mkdtemp(join(tmpdir(), 'prep-diag-note-'));
  try {
    f.setWorkingDir(base);
    const note = 'subprocess failed before reporting an outcome: Error: spawn C:\\Program Files\\nodejs\\node.exe ENOENT';
    const { proc, settle } = fakeProc({
      text: `[stderr]\n${note}`,
      spawnFailed: note,
      autoResolve: false
    });
    f.installShellExecute(() => Promise.resolve(proc));
    const tool = createRunTool(f.ctx, config);

    const pending = tool.execute(
      { command: 'probe-note', description: 'provider failure', workdir: 'missing-dir', yield_ms: 600000 },
      exec
    );
    settle({ status: 'killed', exitCode: null, signal: null });
    const result = await pending;

    assert.equal(result.status, 'killed', '终态保持 killed（诊断不改判）');
    assert.ok(result.detail.includes('Requested workdir: missing-dir'), '诊断要素：请求原值在场');
    assert.ok(result.detail.includes('The resolved directory does not exist.'), '诊断结论来自 stat 核实');
    assert.ok(result.detail.includes('Correct workdir and retry'), '修正重试出路在场');
    assert.ok(!result.detail.includes('subprocess failed before reporting an outcome'),
      '注记已在输出中——诊断不重复拼接原错');
    assert.ok(result.output.includes(note), '宿主注记（含原错）原样保留在输出中');
    // 两出口同一文本：注册表 detail（done 钩子路径）与首次等待返回的 detail 一致。
    const views = f.jobsFake.views();
    assert.equal(views[0].status, 'killed', '后台结算同样按 killed');
    assert.equal(views[0].detail, result.detail, '两条出口同一诊断文本（设计 §3.1）');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

hostTest('async_run（prep 诊断·未上报结局排除）：缺省 workdir 与带信号的真实 kill 都不套诊断', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const base = await mkdtemp(join(tmpdir(), 'prep-diag-note-x-'));
  try {
    f.setWorkingDir(base);
    const note = 'subprocess failed before reporting an outcome: Error: spawn node.exe ENOENT';
    const tool = createRunTool(f.ctx, config);

    // ① 缺省 workdir：无请求可核对（无新信息），不加诊断。
    const bare = fakeProc({ text: `[stderr]\n${note}`, spawnFailed: note, autoResolve: false });
    f.installShellExecute(() => Promise.resolve(bare.proc));
    const barePending = tool.execute(
      { command: 'probe-bare', description: 'provider failure bare', yield_ms: 600000 },
      exec
    );
    bare.settle({ status: 'killed', exitCode: null, signal: null });
    const bareResult = await barePending;
    assert.equal(bareResult.status, 'killed');
    assert.ok(!String(bareResult.detail).includes('Requested workdir'), '缺省 workdir 不加诊断');
    assert.ok(bareResult.output.includes(note), '注记原样保留');

    // ② 真实 kill（带信号）：注记前缀即便巧合在场，无码无信号的合取也不成立。
    const killed = fakeProc({ text: 'partial output before kill', autoResolve: false });
    f.installShellExecute(() => Promise.resolve(killed.proc));
    const killedPending = tool.execute(
      { command: 'probe-kill', description: 'real kill', workdir: 'missing-dir', yield_ms: 600000 },
      exec
    );
    killed.settle({ status: 'killed', exitCode: null, signal: 'SIGTERM' });
    const killedResult = await killedPending;
    assert.equal(killedResult.status, 'killed');
    assert.ok(!String(killedResult.detail).includes('Requested workdir'), '带信号的真实 kill 不套诊断');

    // ③ 注记在场但信号也在（宿主契约下不可达的合成形态）：「无退出码无信号」
    // 是检测信号的独立条件——变异删掉该项检查时，本反例必红。
    const noted = fakeProc({ text: `[stderr]\n${note}`, spawnFailed: note, autoResolve: false });
    f.installShellExecute(() => Promise.resolve(noted.proc));
    const notedPending = tool.execute(
      { command: 'probe-noted-signal', description: 'synthetic note plus signal', workdir: 'missing-dir', yield_ms: 600000 },
      exec
    );
    noted.settle({ status: 'killed', exitCode: null, signal: 'SIGKILL' });
    const notedResult = await notedPending;
    assert.equal(notedResult.status, 'killed');
    assert.ok(!String(notedResult.detail).includes('Requested workdir'), '注记在场但信号在场 ⇒ 合取不成立，不套诊断');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

hostTest('async_run（prep 诊断·未上报结局·不是目录）：killed 形态与拒绝形态同一四分结论', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const base = await mkdtemp(join(tmpdir(), 'prep-diag-note-notdir-'));
  try {
    f.setWorkingDir(base);
    const filePath = join(base, 'plain-file');
    await writeFile(filePath, 'x', 'utf8');
    const note = 'subprocess failed before reporting an outcome: Error: spawn C:\\cwd\\plain-file ENOTDIR';
    const { proc, settle } = fakeProc({
      text: `[stderr]\n${note}`,
      spawnFailed: note,
      autoResolve: false
    });
    f.installShellExecute(() => Promise.resolve(proc));
    const tool = createRunTool(f.ctx, config);

    const pending = tool.execute(
      { command: 'probe-note-notdir', description: 'provider failure notdir', workdir: filePath, yield_ms: 600000 },
      exec
    );
    settle({ status: 'killed', exitCode: null, signal: null });
    const result = await pending;
    assert.equal(result.status, 'killed');
    assert.ok(result.detail.includes('The resolved path exists but is not a directory'),
      'killed 形态同样给出第四档结论（两形态同一结论）');
    assert.ok(result.output.includes(note), '注记原样保留');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
