/**
 * `async_workflow` 工具的单测（对应设计 §3.5 编排作业）。
 *
 * 断言骨架（单元层）：
 * - **执行即注册**：准入先于引擎启动；label=meta.name、kind=
 *   'async-workflow'、owner=会话 id；meta.description 进 progress 行；
 * - **引擎同步抛不冒充准入拒绝**：run() 内的同步错误按原样重抛（诚实工具错误：
 *   什么都没跑），宿主 start 的准入错误才包装成可读拒绝；
 * - **首次等待＝五信号竞速**：结算/插话/迟到作答/abort/预算——任何信号
 *   只结束等待，run.cancel 只属于 job_kill（abort 不接）；
 * - **宿主保真**：renderWorkflowResult 文本、jobOutcomeOf 三支、
 *   mirror 的 log 通道事件、recorder 的四类会话记录、append 失败永久停录。
 *
 * 引擎与注册表都是测试替身（`_helpers.mjs` 的 fakeCtx/fake jobs）；引擎替身只
 * 实现本插件真正调用到的成员（start → {id, meta, result, cancel, dispose}）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowTool as buildWorkflowTool } from '../lib/workflow.js';
import { createWaitJobTool as buildWaitJobTool } from '../lib/wait-job.js';
import { resolveConfig } from '../lib/config.js';
import { LATE_ANSWER_EVENT } from '../lib/interrupts.js';
import { checkedTool, fakeAgent, fakeCtx, freezeTimers, inboxPayload } from './_helpers.mjs';

const createWorkflowTool = (ctx, config) => checkedTool(buildWorkflowTool(ctx, config));
const createWaitJobTool = (ctx, config) => checkedTool(buildWaitJobTool(ctx, config));

/**
 * 引擎替身：`start(spec)` 返回 run（result 悬置到测试调 `_resolve`）。探针：
 * `calls`（start 的 spec 序列）、`runs`（各 run）、每个 run 的
 * `cancelCalls`/`lastCancelReason`/`disposeCalls`。
 * 保真点：`cancel(reason)` 让 `result` 以 `stopReason:'cancelled'` 结算
 * （宿主引擎契约——否则 done 链永远悬置，kill 路径测不出来）。
 */
function fakeEngine() {
  const calls = [];
  const runs = [];
  const engine = {
    calls,
    runs,
    start(spec) {
      calls.push(spec);
      const run = {
        id: `wf-run-${calls.length}`,
        meta: spec.meta,
        cancelCalls: 0,
        lastCancelReason: undefined,
        disposeCalls: 0,
        cancel(reason) {
          run.cancelCalls += 1;
          run.lastCancelReason = reason;
          run._resolve({ stopReason: 'cancelled', agentsStarted: 0 });
        },
        dispose() { run.disposeCalls += 1; return Promise.resolve(); }
      };
      run.result = new Promise((resolve) => { run._resolve = resolve; });
      runs.push(run);
      return run;
    }
  };
  return { engine, calls, runs };
}

/** 组装一次被测环境：假 ctx + 引擎替身 + 会话 append 探针。 */
function rig(configOverrides = {}) {
  const f = fakeCtx();
  const { engine, calls, runs } = fakeEngine();
  f.ctx.get = (key) => (key === 'workflowEngine' ? engine : undefined);
  const agent = fakeAgent();
  const appends = [];
  agent.session.append = (type, data) => { appends.push([type, data]); };
  const config = resolveConfig({ toolName: 'async_workflow', ...configOverrides });
  const tool = createWorkflowTool(f.ctx, config);
  return { f, engine, calls, runs, agent, appends, config, tool };
}

const BASE_ARGS = {
  script: 'return 1;',
  meta: { name: 'wf-demo', description: 'demo workflow for tests' },
  yield_ms: 600000
};

test('async_workflow（R34-a/b/g）：预算内完成 → 宿主同形结算文本；注册字段与呈现层齐全', async () => {
  const { f, runs, agent, appends, tool } = rig();
  const exec = { agent, signal: new AbortController().signal };
  const pending = tool.execute(BASE_ARGS, exec);
  // 预算内完成：run.result 在让出窗口里 resolve（五信号竞速的 wait 支带终态）。
  runs[0]._resolve({ stopReason: 'completed', agentsStarted: 2, value: { ok: true } });
  const result = await pending;

  assert.equal(result.status, 'completed');
  assert.equal(
    result.result,
    'workflow "wf-demo" completed (2 agents).\nReturn value:\n{\n  "ok": true\n}',
    '结算文本与宿主 renderResult 逐字同形（:204-209）'
  );
  // 执行即注册——准入字段。
  assert.equal(f.jobsFake.registeredSpecs.length, 1, '执行即注册（哪怕预算内就结算）');
  const spec = f.jobsFake.registeredSpecs[0];
  assert.equal(spec.kind, 'async-workflow');
  assert.equal(spec.label, 'wf-demo', 'R34-g：label=meta.name');
  assert.equal(spec.owner, agent.id);
  // meta.description 进 progress 行。
  assert.equal(f.jobsFake.views()[0].progress, 'demo workflow for tests');
  // 预算内结算的等待是活 waiter → 宿主不补发完成通知。
  assert.equal(f.jobsFake.wasAwaited(spec === null ? '' : f.jobsFake.views()[0].id), true,
    '预算内结算 → awaited=true → 不补发通知');
  // recorder：run-start + run-end 两条会话记录（stopReason 在册）。
  assert.deepEqual(appends[0], ['tool-workflow/run-start', { runId: 'wf-run-1', name: 'wf-demo' }]);
  assert.deepEqual(appends[appends.length - 1], ['tool-workflow/run-end', { runId: 'wf-run-1', stopReason: 'completed' }]);
  // dispose 在 done 链先于 finish（宿主次序）。
  assert.equal(runs[0].disposeCalls, 1, 'done 链先 dispose 引擎 run');
  // 呈现层：generic 卡 + 标题 wf 名 + rawInput=script。
  const card = tool.presentCall(BASE_ARGS);
  assert.equal(card.card, 'generic');
  assert.equal(card.title, 'workflow: wf-demo');
  assert.equal(card.rawInput, 'return 1;');
});

test('async_workflow（R34-b）：准入先于引擎启动（注册表 start 在 engine.start 之前）', async () => {
  const { f, engine, runs, agent, tool } = rig();
  const order = [];
  const originalStart = f.ctx.jobs.start.bind(f.ctx.jobs);
  f.ctx.jobs.start = (spec) => {
    order.push('admission');
    return originalStart(spec);
  };
  engine.start = new Proxy(engine.start, {
    apply(target, thisArg, args) {
      order.push('engine');
      return Reflect.apply(target, thisArg, args);
    }
  });
  const exec = { agent, signal: new AbortController().signal };
  const pending = tool.execute(BASE_ARGS, exec);
  runs[0]._resolve({ stopReason: 'completed', agentsStarted: 0, value: null });
  await pending;
  assert.deepEqual(order, ['admission', 'engine'], '引擎只许在准入之后启动（R34-b）');
});

test('async_workflow（R34-b）：引擎同步抛 → 原样重抛（不冒充准入拒绝、不包装）', async () => {
  const f = fakeCtx();
  const { engine } = fakeEngine();
  let engineCalls = 0;
  f.ctx.get = () => {
    engineCalls += 1;
    return {
      start() { throw new Error('script failed to parse: unexpected token }'); }
    };
  };
  const agent = fakeAgent();
  agent.session.append = () => {};
  const tool = createWorkflowTool(f.ctx, resolveConfig({ toolName: 'async_workflow' }));
  // 并发安全声明：未声明＝exclusive 独占（批次调度语义见 facts 登记簿）——
  // 一次编排的后台生命周期会把同批其他调用全部串行挡住。五工具同口径 true。
  // 宿主包装器对参数不合法的调用返回 false（dsh-tools :882-885），须带合法参数。
  assert.equal(tool.isConcurrencySafe(BASE_ARGS), true, 'async_workflow 必须声明并发安全');
  await assert.rejects(
    () => tool.execute(BASE_ARGS, { agent, signal: new AbortController().signal }),
    // 恰为原文（逐字相等）：包装成 startRefused 文案的变异在此必红——包装文案
    // 嵌入宿主原文后不再逐字相等（负向红条件）。
    (error) => error.message === 'script failed to parse: unexpected token }',
    '引擎的同步错误必须原样到达模型侧（诚实：什么都没跑；非 startRefused 文案）'
  );
  assert.equal(engineCalls, 1, '服务现读恰好一次');
});

test('async_workflow（R34-b/R8）：宿主注册表拒绝 → 可读的启动前拒绝文案；引擎零调用', async () => {
  const { f, engine, agent, tool } = rig();
  f.ctx.jobs.start = () => { throw new Error('owner limit: 10 concurrent jobs reached'); };
  await assert.rejects(
    () => tool.execute(BASE_ARGS, { agent, signal: new AbortController().signal }),
    (error) => /refused before the process launched/.test(error.message)
      && /owner limit: 10/.test(error.message),
    '准入拒绝必须带宿主原文与行动出路（R8/R29-f），不是裸甩'
  );
  assert.equal(engine.calls.length, 0, '引擎不得启动（没有可取消的 run）');
  assert.equal(f.jobsFake.registeredSpecs.length, 0);
});

test('async_workflow（R34-a）：无 agent 语境 → 拒绝且零注册零引擎', async () => {
  const { f, engine, tool } = rig();
  await assert.rejects(
    () => tool.execute(BASE_ARGS, { signal: new AbortController().signal }),
    /async_workflow must be called from a model turn/,
    '无 agent 语境拒绝（设计 §3.1，与 async_run 同理）'
  );
  assert.equal(f.jobsFake.registeredSpecs.length, 0);
  assert.equal(engine.calls.length, 0);
});

test('async_workflow（R34-a/需求 §3.2）：workflowEngine 缺席 → 可读错误；工具仍注册', async () => {
  const f = fakeCtx();
  f.ctx.get = () => undefined; // 组外行/无引擎部署的恒 miss 形态（需求 §3.2：可读拒绝）
  const agent = fakeAgent();
  agent.session.append = () => {};
  const tool = createWorkflowTool(f.ctx, resolveConfig({ toolName: 'async_workflow' }));
  await assert.rejects(
    () => tool.execute(BASE_ARGS, { agent, signal: new AbortController().signal }),
    /workflowEngine service is not available/,
    '引擎缺席必须可读（装载侧指引），不是 undefined 崩溃'
  );
  assert.equal(f.jobsFake.registeredSpecs.length, 0);
});

test('async_workflow（盲测 F4/需求 §2.1.3）：空 meta.name → 自解释前置错误；零注册零引擎', async () => {
  // 宿主 jobs.start 对空 label 抛「invalid job label」——若不在插件侧先拦，
  // 这句参数校验错误会被准入拒绝包装带上"存活的作业…用 job_kill"的触顶出路，
  // 误导模型去杀无关作业。前置校验必须先于注册（变异：删前置校验 → 本测红）。
  const { f, engine, agent, tool } = rig();
  for (const badName of ['', '   ']) {
    await assert.rejects(
      () => tool.execute(
        { ...BASE_ARGS, meta: { ...BASE_ARGS.meta, name: badName } },
        { agent, signal: new AbortController().signal }
      ),
      (error) => /meta\.name must be a non-empty string/.test(error.message)
        && !/job_kill|存活的作业/.test(error.message),
      '空 name 必须给自解释错误，不得复用准入触顶模板'
    );
  }
  assert.equal(f.jobsFake.registeredSpecs.length, 0, '零注册（启动前拒绝）');
  assert.equal(engine.calls.length, 0, '引擎不得启动');
});

test('async_workflow（R34-c·killed）：job_kill → run.cancel 一次；返回 killed 形状', async () => {
  const { f, runs, agent, tool } = rig();
  freezeTimers(f.ctx);
  const exec = { agent, signal: new AbortController().signal };
  const pending = tool.execute(BASE_ARGS, exec);
  await new Promise((r) => { setTimeout(r, 5); });
  const jobId = f.jobsFake.views()[0].id;
  // kill-reason 合并是注册表行为（真实 dsh-jobs-local 把理由并进 detail）——替身
  // 侧由 settleJob 先占结算模拟同一快照形状。
  f.jobsFake.killJob(jobId, 'user killed via job_kill');
  f.jobsFake.settleJob(jobId, { status: 'killed', detail: 'user killed via job_kill' });
  const result = await pending;

  assert.equal(result.status, 'killed', 'kill 路径按 killed 形状返回');
  assert.match(result.detail, /user killed via job_kill/, 'kill 理由来自注册表合并');
  assert.equal(runs[0].cancelCalls, 1, '取消只经注册表 hooks.cancel → run.cancel，恰一次');
  assert.equal(runs[0].lastCancelReason, 'user killed via job_kill');
  // cancel 后引擎 run.result 以 cancelled 结算 → done 链 dispose 过引擎。
  assert.equal(runs[0].disposeCalls, 1, 'cancelled 结算同样走 dispose（宿主次序）');
});

test('async_workflow（R34-c·插话）：让出窗口内用户消息 → 句柄 + 提前让出注记；run 存活', async () => {
  const { f, runs, agent, tool } = rig();
  freezeTimers(f.ctx);
  const exec = { agent, signal: new AbortController().signal };
  const pending = tool.execute(BASE_ARGS, exec);
  await new Promise((r) => { setTimeout(r, 5); });
  f.emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: 'hold on', target: 'next-step' }));

  const result = await pending;
  assert.equal(result.status, 'running', '插话 → 转后台句柄（恢复通道 = 完成通知）');
  assert.match(result.note, /ended early: a user message arrived/);
  assert.match(result.note, /async_wait_job\(job_id="/, '恢复示例照带');
  // elapsed 双向域：下界 = 触发前的 5 ms 等待（t0 必须在引擎启动
  // 之前的 execute 入口），上界 = 首次等待预算（这条路不是预算到期退出的）。
  assert.ok(result.elapsed_ms >= 5, `t0 取点在 execute 入口（实得 ${String(result.elapsed_ms)}）`);
  assert.ok(result.elapsed_ms < 600000, '插话先于预算到期返回');
  assert.equal(runs[0].cancelCalls, 0, '插话只结束等待，绝不取消 run（同款）');
  assert.equal(f.jobsFake.views()[0].status, 'running', '作业存活');
  assert.equal(f.jobsFake.waitersOf(result.job_id), 0, '竞速定局即撤销 waiter');
  runs[0]._resolve({ stopReason: 'completed', agentsStarted: 1, value: 1 });
  f.jobsFake.settleJob(result.job_id, { status: 'completed', detail: '1 agent' });
  assert.equal(f.jobsFake.wasAwaited(result.job_id), false, '撤销后的结算 → 完成通知照发');
});

test('async_workflow（R34-c·迟到作答）：让出窗口内迟到作答 → 句柄 + lateArrived 键', async () => {
  const { f, agent, tool } = rig();
  freezeTimers(f.ctx);
  const exec = { agent, signal: new AbortController().signal };
  const pending = tool.execute(BASE_ARGS, exec);
  await new Promise((r) => { setTimeout(r, 5); });
  f.emit(LATE_ANSWER_EVENT, { agentId: agent.id, questionId: 'color', kind: 'answer', summary: 'Late answer for color: red' });

  const result = await pending;
  assert.equal(result.status, 'running');
  assert.match(result.note, /A late answer has arrived \(Late answer for color: red\)/, '与 wait 工具同键（需求 §4.4）');
  assert.ok(result.elapsed_ms >= 5, `t0 取点在 execute 入口（实得 ${String(result.elapsed_ms)}）`);
  assert.ok(result.elapsed_ms < 600000, '迟到先于预算到期返回');
  assert.equal(f.jobsFake.waitersOf(result.job_id), 0);
});

test('async_workflow（R34-c·abort）：GUI 停止 → 句柄形状、run 存活、cancel 零调用', async () => {
  const { f, runs, agent, tool } = rig();
  freezeTimers(f.ctx);
  const controller = new AbortController();
  const exec = { agent, signal: controller.signal };
  const pending = tool.execute(BASE_ARGS, exec);
  await new Promise((r) => { setTimeout(r, 5); });
  controller.abort(new Error('tool call aborted'));

  const result = await pending;
  assert.equal(result.status, 'running', 'abort 分支按句柄口径（宿主整体改写，形状合法即可）');
  assert.ok(result.elapsed_ms >= 5, `t0 取点在 execute 入口（实得 ${String(result.elapsed_ms)}）`);
  assert.ok(result.elapsed_ms < 600000, 'abort 先于预算到期返回');
  assert.equal(runs[0].cancelCalls, 0, 'abort 不接 run.cancel（R34-e：真取消走 job_kill）');
  assert.equal(f.jobsFake.views()[0].status, 'running', '作业必须存活');
  assert.equal(f.jobsFake.waitersOf(result.job_id), 0, 'wait 已被 abort 摘除');
});

test('async_workflow（R34-c·预算）：yield 到期 → 句柄 + 预算口径 note；引擎零扰动', async () => {
  // minYieldMs:5 让 yield_ms:5 真生效（默认 1000 会把它夹紧——复查 N-2：
  // 下界必须锚生效窗口，否则「没等满」的变异不红）。
  const { f, runs, agent, tool } = rig({ minYieldMs: 5 });
  freezeTimers(f.ctx);
  const exec = { agent, signal: new AbortController().signal };
  const pending = tool.execute({ ...BASE_ARGS, yield_ms: 5 }, exec);
  const result = await pending;

  assert.equal(result.status, 'running', '首次等待到期 → 作业编号（默认首次等待 20 s 的同款语义）');
  assert.match(result.note, /first wait/, 'note 说明按首次等待到期让出');
  assert.match(result.note, /async_wait_job\(job_id="/);
  // 与 async_run 的 elapsed 口径同款：elapsed 覆盖整个**生效**首次等待窗口（t0 挪到
  // 等待开始之后、或没等满 5 ms 的变异在此必红）。
  assert.ok(result.elapsed_ms >= 5, `elapsed 覆盖生效首次等待窗口（实得 ${String(result.elapsed_ms)}）`);
  assert.equal(runs[0].cancelCalls, 0, '预算让出绝不取消 run');
  assert.equal(f.jobsFake.views()[0].status, 'running');
  assert.equal(f.jobsFake.waitersOf(result.job_id), 0, '预算路同撤 waiter（四路同款，I-5）');
});

test('async_workflow（R34-d·mirror）：引擎生命周期事件 → 作业卡 log 通道与 progress', async () => {
  const { f, runs, agent, tool } = rig();
  const exec = { agent, signal: new AbortController().signal };
  const pending = tool.execute(BASE_ARGS, exec);
  await new Promise((r) => { setTimeout(r, 5); });
  const runId = runs[0].id;
  const jobId = f.jobsFake.views()[0].id;

  f.emit('workflow/phase', { id: runId }, 'Phase One');
  f.emit('workflow/log', { id: runId }, 'planning fan-out');
  f.emit('workflow/agent-start', { id: runId }, { seq: 1, label: 'auditor', phase: 'audit', childId: 'child-1' });
  f.emit('workflow/agent-end', { id: runId }, { seq: 1, outcome: 'final answer delivered' });
  // 别的 run 的事件不得串卡（info.id 过滤，宿主 :21-35 同款）。
  f.emit('workflow/phase', { id: 'wf-run-999' }, 'unrelated');

  runs[0]._resolve({ stopReason: 'completed', agentsStarted: 1, value: 'done' });
  await pending;

  assert.equal(f.jobsFake.views()[0].progress, 'Phase One', 'phase → updateProgress');
  const read = f.ctx.jobs.read(jobId, agent.id);
  const logText = read.chunks.filter((c) => c.channel === 'log').map((c) => c.text).join('');
  assert.match(logText, /▸ Phase One\n/, 'phase → log 通道追加（宿主 :25-27 同形）');
  assert.match(logText, /planning fan-out\n/);
  assert.match(logText, /agent #1 auditor started\n/, 'agent-start 文本（宿主 :29-31 同形）');
  assert.match(logText, /agent #1 final answer delivered\n/);
  assert.ok(!logText.includes('unrelated'), '他 run 的事件不得写进本作业卡');
  // mirror.stop 的结算后防御：结算后再发事件，不得再进卡。
  f.emit('workflow/log', { id: runId }, 'post-settle leak');
  f.emit('workflow/phase', { id: runId }, 'Post-Settle Phase');
  const read2 = f.ctx.jobs.read(jobId, agent.id);
  const logText2 = read2.chunks.filter((c) => c.channel === 'log').map((c) => c.text).join('');
  assert.ok(!logText2.includes('post-settle leak'), 'mirror.stop 后事件不进 log 通道');
  assert.equal(f.jobsFake.views()[0].progress, 'Phase One', 'mirror.stop 后 progress 不再更新');
});

test('async_workflow（R34-d·recorder）：四类会话记录在册（run-start/agent-start/agent-end/run-end）', async () => {
  const { f, runs, agent, appends, tool } = rig();
  const exec = { agent, signal: new AbortController().signal };
  const pending = tool.execute(BASE_ARGS, exec);
  await new Promise((r) => { setTimeout(r, 5); });
  const runId = runs[0].id;

  f.emit('workflow/agent-start', { id: runId }, { seq: 1, label: 'auditor', phase: 'audit', childId: 'child-1' });
  f.emit('workflow/agent-end', { id: runId }, { seq: 1, outcome: 'final answer delivered' });
  runs[0]._resolve({ stopReason: 'completed', agentsStarted: 1, value: 'done' });
  await pending;

  assert.deepEqual(appends, [
    ['tool-workflow/run-start', { runId, name: 'wf-demo' }],
    ['tool-workflow/agent-start', { runId, seq: 1, label: 'auditor', phase: 'audit', childId: 'child-1' }],
    ['tool-workflow/agent-end', { runId, seq: 1, outcome: 'final answer delivered' }],
    ['tool-workflow/run-end', { runId, stopReason: 'completed' }]
  ], '四类记录的载荷与宿主 recorder :83-124 同形');
  // 结算后防御的落档半边：finish+abandon 之后事件不再
  // 进会话档案（漏停录的变异在此必红）。
  f.emit('workflow/agent-end', { id: runId }, { seq: 2, outcome: 'post-settle record' });
  assert.equal(appends.length, 4, '结算后 recorder 不再写任何记录');
});

test('async_workflow（R34-d/recordsRun）：PTC 子调度调用不写持久记录（宿主 :242/:395 同判定）', async () => {
  const { f, runs, agent, appends, tool } = rig();
  // exec.parent 是 PTC transport 的子调度标记——宿主只让顶层调用写档
  // （README:88「记录只由顶层调用产生」），与宿主同判定。
  const exec = { agent, signal: new AbortController().signal, parent: {} };
  const pending = tool.execute(BASE_ARGS, exec);
  await new Promise((r) => { setTimeout(r, 5); });
  runs[0]._resolve({ stopReason: 'completed', agentsStarted: 1, value: 1 });
  await pending;
  assert.equal(appends.length, 0, '子调度不写持久记录（run-start 也不写）');
});

test('async_workflow（R34-d·recorder 失败路径）：append 抛错 → warn + 该 run 永久停录', async () => {
  const f = fakeCtx();
  const { engine, runs } = fakeEngine();
  f.ctx.get = () => engine;
  const agent = fakeAgent();
  const appends = [];
  agent.session.append = (type) => {
    appends.push(type);
    if (type === 'tool-workflow/agent-start') throw new Error('session sealed');
  };
  const tool = createWorkflowTool(f.ctx, resolveConfig({ toolName: 'async_workflow' }));
  const exec = { agent, signal: new AbortController().signal };
  const pending = tool.execute(BASE_ARGS, exec);
  await new Promise((r) => { setTimeout(r, 5); });
  const runId = runs[0].id;

  f.emit('workflow/agent-start', { id: runId }, { seq: 1, label: 'a', childId: 'c' });
  f.emit('workflow/agent-end', { id: runId }, { seq: 1, outcome: 'ok' }); // 已停录：不得再 append
  runs[0]._resolve({ stopReason: 'completed', agentsStarted: 1, value: 1 });
  await pending;

  assert.deepEqual(appends, ['tool-workflow/run-start', 'tool-workflow/agent-start'],
    '第一次 agent-start 失败后，同 run 的后续记录全部停录（宿主 :87-94 永久停录）');
  assert.ok(f.logs.some(([level, text]) => level === 'warn' && /disabled durable record/.test(text)),
    '停录必须 warn（不是静默）');
});

test('async_workflow（R34-g）：超长返回值截断——保首尾、标省略量（与读取路径同款）', async () => {
  const { f, runs, agent, tool } = rig({ maxResultChars: 40 });
  agent.session.append = () => {};
  const exec = { agent, signal: new AbortController().signal };
  const pending = tool.execute(BASE_ARGS, exec);
  runs[0]._resolve({ stopReason: 'completed', agentsStarted: 1, value: { blob: 'x'.repeat(200) } });
  const result = await pending;
  assert.equal(result.result.slice(0, 20), 'workflow "wf-demo" c', '头部说明与正文开头必须保留');
  assert.match(result.result, /\[output truncated: 176 chars omitted\]/, '省略量标注必须在场（双语键 render.truncated）');
  assert.ok(result.result.endsWith('"\n}'), 'JSON 尾部必须保留——尾部内容不得因首截断永久丢失（需求 §2.2.3）');
});

test('async_workflow（R34-g·zh）：完成渲染与截断标注随 agentLang 切换', async () => {
  const { f, runs, agent, tool } = rig({ maxResultChars: 40, agentLang: 'zh' });
  agent.session.append = () => {};
  const exec = { agent, signal: new AbortController().signal };
  const pending = tool.execute(BASE_ARGS, exec);
  runs[0]._resolve({ stopReason: 'completed', agentsStarted: 2, value: { blob: 'x'.repeat(200) } });
  const result = await pending;
  assert.match(result.result, /workflow「wf-demo」已完成（2 个子代理）。/, '中文档头部说明必须为中文（需求 §5.3）');
  assert.match(result.result, /\[输出已截断：省略 176 字符\]/, '截断标注必须随语言档切换');
  assert.ok(result.result.endsWith('"\n}'), '中文档同样保首尾');
});

// ---------------------------------------------------------------------------
// F8/F9（需求 §2.2.3/§2.1.2）：注册表收原始 JSON（后台读取整体只裁一次，
// 预算不被实施两次）；取消与预算到期分别说明。
// ---------------------------------------------------------------------------

test('async_workflow（F8）：注册表收原始 JSON，一次内容预算不被实施两次', async () => {
  const { f, runs, agent, tool } = rig({ maxResultChars: 5 });
  agent.session.append = () => {};
  const exec = { agent, signal: new AbortController().signal };
  const pending = tool.execute(BASE_ARGS, exec);
  // 26 字符串值 → JSON 序列化恰 28 字符；预算 5 → 省略量按原始内容计＝23。
  runs[0]._resolve({ stopReason: 'completed', agentsStarted: 1, value: 'x'.repeat(26) });
  const result = await pending;

  // 直接结算路径：完成头（状态提示另计）＋对原始 JSON 的单次裁剪。
  assert.match(result.result, /\[output truncated: 23 chars omitted\]/,
    '直接结算的省略量按原始 JSON 计算（28−5=23）');

  // 注册表：outcome 存**原始序列化值**——由后台首次终态读取的省略量反推：
  // 23＝28−5 只在原始整串上成立；若注册表存「完成头＋已裁文本」，省略量会按
  // 那份更长文本重算（旧缺陷形态）。
  const views = f.jobsFake.views();
  const jobId = views[0].id;
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  const waiter = createWaitJobTool(f.ctx, resolveConfig({ toolName: 'async_wait_job', maxResultChars: 5 }));
  const again = await waiter.execute({ job_id: jobId, wait_ms: 30000 }, exec);
  assert.equal(again.status, 'completed');
  assert.equal(again.truncated, true, '原始 28 字符对预算 5 必须置 truncated');
  assert.match(again.output, /\[output truncated: 23 chars omitted\]/,
    '后台读取对「增量＋result」整体只裁一次——省略量不因前置裁剪膨胀（需求 §2.2.3）');
  assert.ok(!again.output.includes('Return value:'), '完成头不进后台读取路径（它在直接结算路径渲染）');

  // 一次性通道已消费：后续裸读无 result。
  const rawNext = f.jobsFake.service.read(jobId, agent.id);
  assert.equal(rawNext.result, undefined, '注册表裸读不再有 result（一次性通道已被首次终态读取消费）');
});

test('async_workflow（F9）：取消与预算到期分别说明——abort 的 note 不冒称超出预算', async () => {
  const { f, agent, tool } = rig();
  freezeTimers(f.ctx);
  const controller = new AbortController();
  const exec = { agent, signal: controller.signal };
  const pending = tool.execute(BASE_ARGS, exec);
  await new Promise((r) => { setTimeout(r, 5); });
  controller.abort(new Error('tool call aborted'));

  const result = await pending;
  assert.equal(result.status, 'running');
  assert.match(result.note, /cancelled during the first wait/, '内部结果按取消口径给原因（需求 §2.1.2）');
  assert.doesNotMatch(result.note, /outlived the /, '不得把取消冒称超出预算');
  assert.match(result.note, /was not terminated by the cancellation/, '取消没有终止命令的口径保留（行为陈述，不作运行断言）');
});
