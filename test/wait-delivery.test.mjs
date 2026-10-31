/**
 * 一次性交付在**真实注册表**上的回归（判据 1/2/3；需求 §2.2.3/9.3.1、设计 §2.4/§2.6）。
 *
 * 用真 Cordis ＋ 真 rc.2 `LocalJobRegistry`——注册表的一次性 `resultDelivered`、
 * 消费式游标、settled 截流都不是替身模拟的。受控点只有一个：workflow 引擎何时
 * 结算。断言的是正向行为：最终 JSON 必须出现在模型可见输出里，恰一次。
 *
 * 宿主包不可解析（离线环境/CI）时整文件跳过——跳过不是通过。
 */
import assert from 'node:assert/strict';
import { hostTestFor, loadOfflineSafe } from './_host-gate.mjs';
import { resolveConfig } from '../lib/config.js';
import { checkedTool, inboxPayload } from './_helpers.mjs';

// 宿主链动态守卫：lib/workflow.js、lib/wait.js（→ dsh-tools）与真注册表依赖
// （@deepseek-ai/cordis、@deepseek-ai/dsh-jobs-local——后者是宿主树内层包，不在本包
// peer 声明里）在离线形态都缺席，全部用例自跳过并打印理由（ci.yml offline 作业的
// 契约）。探测统一走 loadOfflineSafe：只认「@deepseek-ai/ 不可解析」这一种解析
// 事实，语法错或模块内部抛错原样红，不得被吞成跳过（防假跳过）。
const workflowModule = await loadOfflineSafe('../lib/workflow.js');
const waitModule = await loadOfflineSafe('../lib/wait.js');
const { createWorkflowTool } = workflowModule ?? {};
const { createWaitTool } = waitModule ?? {};
const cordisModule = await loadOfflineSafe('@deepseek-ai/cordis');
const jobsLocalModule = await loadOfflineSafe('@deepseek-ai/dsh-jobs-local');
const { Context } = cordisModule ?? {};
const { LocalJobRegistry } = jobsLocalModule ?? {};
const hostTest = await hostTestFor(
  '../lib/workflow.js', '../lib/wait.js', '@deepseek-ai/cordis', '@deepseek-ai/dsh-jobs-local'
);

/**
 * 组装被测环境：真 Context + 真 LocalJobRegistry + 受控引擎替身。
 * `finisher()` 让引擎以 completed 结算（value 带 `AT_FINAL_PAYLOAD` 标记）。
 */
async function buildRig(label, childRows = [], options = {}) {
  const base = new Context();
  const followups = [];
  const injections = [];
  const parent = {
    id: `at-r57-${label}-${Math.random().toString(36).slice(2, 8)}`,
    ctx: base,
    // session.header.cwd 不携带机器路径：本 rig 只用 workflow/wait 工具，无人消费 cwd
    //（盘符字面量在交付范围代码里受判据 12 管辖）。
    session: { append() {} },
    inbox: { nextStep: [], nextTurn: [] },
    // 完成消息通道记录（R58-c/d 的断言面：deliverIfNoWait 的 followup/inject 落点）。
    followup(message) { followups.push(message); },
    inject(message) { injections.push(message); }
  };
  base.provide('agents', {
    // parent 是本主体；其余 id 一律给 running 形状（子代理目标用例的注册表观察
    // 默认值——需要 absent/unknown 形态的用例自行绕过 provide 重新建 rig）。
    get: (id) => (id === parent.id ? parent : { id, status: 'running' })
  });
  // 子代理目录替身（形状行为用例）：childRows 由调用方给（catalog 行／判别联合行／
  // 诊断行三种形态都从这里进）。
  base.provide('subagents', { listChildren: async () => childRows, interrupt() {} });
  await base.plugin(LocalJobRegistry, {
    maxConcurrentJobsPerOwner: 10, retainBytes: 1048576, settledRetainBytes: 1048576, pumpPollMs: 10
  });
  const ctx = await new Promise((resolve) => {
    base.inject(['jobs', 'subagents'], async (c) => resolve(c));
  });
  const detach = ctx.jobs.attachController(`at-r57-${label}`);
  // 多 run 支持（R58-a「等 B 时 A 结算」）：runs 按创建序登记，finisher 不带参
  // = 结算**最新** run（旧用例的单 run 形态不变），带索引 = 结算指定 run。
  const runs = [];
  const engine = {
    start(spec) {
      let finishOne;
      const run = {
        id: `at-r57-run-${label}-${runs.length + 1}`,
        meta: spec.meta,
        result: new Promise((resolve) => { finishOne = resolve; }),
        // 取消必须让 result 结算：disposeAll 对 running 作业走 cancel → 等待
        // result——空壳 cancel 会让「作业仍 running 就 dispose」的用例（如先到
        // 插话判据）在 disposeAll 上挂死。
        cancel() { finishOne({ stopReason: 'cancelled', agentsStarted: 0, value: undefined }); },
        dispose: async () => {}
      };
      run._finish = finishOne;
      runs.push(run);
      return run;
    }
  };
  const adapter = {
    jobs: ctx.jobs,
    subagents: ctx.subagents,
    agents: ctx.agents,
    on: (...args) => ctx.on(...args),
    // `get(name)` 按服务名分派：workflowEngine → 受控引擎替身；agents → 真服务
    //（完成消息的 #agentFor 经注册表条目的 ctx 读 agents——错给引擎会让投递
    // 走「agent registry miss」回滚，R58-c 的完成消息断言面就空了）。
    get: (name) => (name === 'workflowEngine' ? engine : (name === 'agents' ? ctx.agents : undefined)),
    logger: { info() {}, warn() {} },
    timer: {
      timeout: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
      interval: (fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); }
    }
  };
  const config = resolveConfig({
    toolName: 'async_workflow', minYieldMs: 1, defaultYieldMs: 20, maxYieldMs: 1000,
    ...(options.maxResultChars === undefined ? {} : { maxResultChars: options.maxResultChars }),
    ...(options.workflowProgressLog === undefined ? {} : { workflowProgressLog: options.workflowProgressLog })
  });
  const workflow = checkedTool(createWorkflowTool(adapter, config));
  const waiter = checkedTool(createWaitTool(adapter, config));
  const exec = () => ({ agent: parent, signal: new AbortController().signal });
  return {
    ctx,
    parent,
    workflow,
    waiter,
    exec,
    followups,
    injections,
    finisher: (runIndex, value) => runs[runIndex === undefined ? runs.length - 1 : runIndex]
      ._finish({
        stopReason: 'completed', agentsStarted: 0,
        value: value === undefined ? { proof: 'AT_FINAL_PAYLOAD' } : value
      }),
    dispose: async () => { await ctx.jobs.disposeAll(); detach(); }
  };
}

const WF_ARGS = {
  script: 'return {proof:"AT_FINAL_PAYLOAD"}',
  meta: { name: 'at-r57-recovery', description: 'R57 final-result delivery regression' },
  yield_ms: 20
};

const waitArgs = (jobId) => ({ wait_ms: 500, targets: [{ kind: 'job', id: jobId }] });

hostTest('R57 真实注册表①：workflow 先让出，wait 覆盖结算 → 最终 JSON 在返回中出现恰一次', async () => {
  const rig = await buildRig('yield');
  try {
    const first = await rig.workflow.execute(WF_ARGS, rig.exec());
    assert.equal(first.status, 'running', '前置：20 ms 让出窗口内引擎悬置 → 句柄');
    assert.equal(rig.ctx.jobs.list(rig.parent.id)[0].status, 'running');

    const pending = rig.waiter.execute(waitArgs(first.job_id), rig.exec());
    rig.finisher();
    const recovered = await pending;

    assert.equal(recovered.status, 'completed');
    assert.ok(recovered.output.includes('AT_FINAL_PAYLOAD'),
      '最终 JSON 必须出现在模型可见输出里（一次消费通道被本次返回兑现）');
    assert.equal(recovered.output.split('AT_FINAL_PAYLOAD').length, 2,
      '恰一次：同一返回内不得重复拼接最终结果');
    assert.ok(Array.isArray(recovered.delivered) && recovered.delivered.length === 1,
      '交付批次携带本作业条目');
    assert.equal(recovered.delivered[0].job_id, first.job_id);

    // 恰一次：一次性通道已被上面的交付消费，后续读取不得重复。
    const rawNext = rig.ctx.jobs.read(first.job_id, rig.parent.id);
    assert.equal(rawNext.result, undefined, '注册表裸读不再有 result（一次性通道已消费）');
    const again = await rig.waiter.execute(waitArgs(first.job_id), rig.exec());
    assert.equal(again.status, 'completed');
    assert.equal(again.output, '', '交付后的再次读取不重复最终结果（游标已到尾、result 已交；缓冲已清）');
  } finally {
    await rig.dispose();
  }
});

hostTest('R57 真实注册表②：结算后无活等待窗口——正文经完成消息恰一次，wait 只回终态（不重复交付）', async () => {
  const rig = await buildRig('entry');
  try {
    const first = await rig.workflow.execute(WF_ARGS, rig.exec());
    assert.equal(first.status, 'running');
    rig.finisher();
    // 短轮询等结算（有界 2 s，5 ms 步进）：固定睡眠在负载高的环境可能抖红。
    const deadline = Date.now() + 2000;
    let settledView;
    while (Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      settledView = rig.ctx.jobs.list(rig.parent.id).find((j) => j.id === first.job_id);
      if (settledView?.status === 'completed') break;
    }
    assert.equal(settledView?.status, 'completed', '前置：作业在等待开始前已结算');
    // 无活等待窗口内保活链结算读取 → 完成消息投递（需求 9.3.2「没有活等待时也
    // 适用」）。正文此刻已由完成消息承载（恰一次）。
    const sends = [...rig.followups, ...rig.injections];
    assert.ok(sends.length >= 1 && sends.some((m) => m.content.some((p) => (p.text ?? '').includes('AT_FINAL_PAYLOAD'))),
      '完成消息携带最终 JSON（无活等待路径的直接交付）');

    // 再次 wait（入口已终态分支）：终态事实照常，正文不重复（同一最终结果在正常
    // 交付中只出现一次——claimedBy='message' 与 deliveredFact 双重阻断）。
    const recovered = await rig.waiter.execute(waitArgs(first.job_id), rig.exec());
    assert.equal(recovered.status, 'completed', '入口已终态分支返回终态事实');
    assert.ok(!recovered.output.includes('AT_FINAL_PAYLOAD'),
      'wait 不重复正文（旧形态「入口终态分支再交一次性 result」会造成同一正文两次进入模型上下文）');
  } finally {
    await rig.dispose();
  }
});

hostTest('R57 真实注册表③：无 result 的普通命令作业——增量文本行为不变', async () => {
  const rig = await buildRig('plain');
  try {
    const jobId = rig.ctx.jobs.start({
      kind: 'at-r57-cmd',
      label: 'plain command',
      owner: rig.parent.id,
      run(job) {
        job.append('hello from cmd\n');
        return { cancel() {}, done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }) };
      }
    });
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    assert.equal(rig.ctx.jobs.list(rig.parent.id).find((j) => j.id === jobId).status, 'completed');

    const first = await rig.waiter.execute(waitArgs(jobId), rig.exec());
    assert.equal(first.status, 'completed');
    assert.equal(first.output, 'hello from cmd\n', '无 result 的作业：输出＝chunks 增量，不多不少');
    assert.equal(first.truncated, false);

    const second = await rig.waiter.execute(waitArgs(jobId), rig.exec());
    assert.equal(second.output, '', '消费式游标：第二次读取无新增量');
  } finally {
    await rig.dispose();
  }
});

// ── 入口检查（R55 判据族在统一等待上的工具级回归；inbox 由 rig.parent 直接控制）──────
//
// 旧 wait-job/wait-agent 两份测试退役时，入口检查的工具级用例（先到消息的分流与
// 优先级）没有随迁——统一等待 lib/wait.js 的对应分支长期无测试。以下四例把它
// 钉回：判据 1（user 插话立即交回）、判据 5（作业终态优先于插话）、判据 2 负面
//（转达滞留按 message 出口，不冒充打断）、判据 3 负面（next-turn 排队不命中）。
// 消息形状复用 inboxPayload（test/_helpers.mjs）；「先到」的造法都是**等待开始前**
// 就把消息推进列表（与事件侧的等待中到达互补，那边由 interrupt.test 与 jobs.test 覆盖）。

hostTest('R55（判据 1·统一等待）：wait 开始时 next-step 已有 user 插话 → 立即 interrupted', async () => {
  const rig = await buildRig('pre1');
  try {
    const first = await rig.workflow.execute(WF_ARGS, rig.exec());
    assert.equal(first.status, 'running', '前置：作业在跑（等待期未结算）');
    inboxPayload({ agent: rig.parent, sourceKind: 'user', text: '先到的插话', target: 'next-step' });

    const started = Date.now();
    const outcome = await rig.waiter.execute(waitArgs(first.job_id), rig.exec());
    assert.equal(outcome.status, 'interrupted', '先到 user 插话必须立即按 interrupted 交回（不进等待竞速）');
    assert.ok(Date.now() - started < 400, `立即交回（远小于 wait_ms=500；实耗 ${String(Date.now() - started)} ms）`);
    assert.match(outcome.note, /Wait not started: a user message had already arrived/, 'note 按先到插话口径说明（未开始等待）');
    assert.equal(rig.ctx.jobs.list(rig.parent.id).find((j) => j.id === first.job_id).status, 'running',
      '打断只结束等待：作业不受影响');
  } finally {
    await rig.dispose();
  }
});

hostTest('R55（判据 5·作业侧）：作业已终态 + 先到 user 插话并存 → 完成结果（结束优先于打断）', async () => {
  const rig = await buildRig('pre5');
  try {
    const first = await rig.workflow.execute(WF_ARGS, rig.exec());
    assert.equal(first.status, 'running');
    rig.finisher();
    const deadline = Date.now() + 2000;
    let settledView;
    while (Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      settledView = rig.ctx.jobs.list(rig.parent.id).find((j) => j.id === first.job_id);
      if (settledView?.status === 'completed') break;
    }
    assert.equal(settledView?.status, 'completed', '前置：等待开始前作业已结算');
    inboxPayload({ agent: rig.parent, sourceKind: 'user', text: '同时滞留的插话', target: 'next-step' });

    const outcome = await rig.waiter.execute(waitArgs(first.job_id), rig.exec());
    assert.equal(outcome.status, 'completed', '终态检查在插话分流之前：完成优先（入口侧优先级）');
    // 正文经完成消息恰一次（结算后无活等待窗口，保活链先投）；wait 只回终态，
    // 不重复（同一最终结果只出现一次——9.3.2）。
    const sends = [...rig.followups, ...rig.injections];
    assert.ok(sends.some((m) => m.content.some((p) => (p.text ?? '').includes('AT_FINAL_PAYLOAD'))),
      '完成消息携带正文');
    assert.ok(!outcome.output.includes('AT_FINAL_PAYLOAD'), 'wait 不重复正文');
  } finally {
    await rig.dispose();
  }
});

hostTest('R55（判据 2·负面）：next-step 滞留的是转达消息 → message 出口，不冒充打断', async () => {
  const rig = await buildRig('pre2');
  try {
    inboxPayload({
      agent: rig.parent, sourceKind: 'agent-message', form: 'relay',
      summary: 'a relay arrived early', target: 'next-step'
    });
    // 无目标的等待（纯等待形态）：notice/relay 滞留按 message 出口交回。
    const outcome = await rig.waiter.execute({ wait_ms: 500 }, rig.exec());
    assert.equal(outcome.status, 'message', '转达滞留不打断——message 出口带 summary');
    assert.match(outcome.note, /a relay arrived early/, 'summary 透传到 note');
  } finally {
    await rig.dispose();
  }
});

hostTest('R55（判据 3·负面）：next-turn 的排队 user 消息不命中（排队不唤醒，R12 不回归）', async () => {
  const rig = await buildRig('pre3');
  try {
    inboxPayload({ agent: rig.parent, sourceKind: 'user', text: '排队中的消息', target: 'next-turn' });
    const outcome = await rig.waiter.execute({ wait_ms: 60 }, rig.exec());
    assert.notEqual(outcome.status, 'interrupted', '排队消息不打断（只有插话落点 next-step 参与）');
    assert.equal(outcome.status, 'budget', '无目标无信号的等待按预算到期交回');
  } finally {
    await rig.dispose();
  }
});

// R58-j（盲审 M-2）：零等待与正等待同款入口判定——无目标时先到的 notice/relay
// 按 message 出口交回，不得把消息信息吞进 zeroWaitNoTargets。
hostTest('R58-j：零等待交回已到达的可处理消息——message 出口（入口判定同一）', async () => {
  const rig = await buildRig('r58j');
  try {
    inboxPayload({
      agent: rig.parent, sourceKind: 'agent-message', form: 'relay',
      summary: 'a relay arrived before zero-wait', target: 'next-step'
    });
    const outcome = await rig.waiter.execute({ wait_ms: 0 }, rig.exec());
    assert.equal(outcome.status, 'message', '零等待也交回先到消息（需求 2.1.2 入口同一判定）');
    assert.match(outcome.note, /a relay arrived before zero-wait/, 'summary 透传到 note');
  } finally {
    await rig.dispose();
  }
});

// R58-k（盲审 N-3）：零等待同样扫先到迟到作答（与正等待入口同一判定）——
// source.kind=async-tools-late-answer 且 form=notice 的滞留消息按 message
// 出口交回，不得吞进 zeroWaitNoTargets。
hostTest('R58-k：零等待交回先到的迟到作答——message 出口（迟到作答入口同一）', async () => {
  const rig = await buildRig('r58k');
  try {
    inboxPayload({
      agent: rig.parent,
      sourceKind: 'async-tools-late-answer',
      form: 'notice',
      summary: 'Late answer for color: red',
      target: 'next-step'
    });
    const outcome = await rig.waiter.execute({ wait_ms: 0 }, rig.exec());
    assert.equal(outcome.status, 'message', '零等待交回先到迟到作答（不吞进零等待泛化文案）');
    assert.match(outcome.note, /Late answer for color: red/, '作答摘要透传到 note');
  } finally {
    await rig.dispose();
  }
});

// R58-o（验收遗留建议①）：合法混合多目标（job+agent ≥2 元素）的行为区分——
// 9.3.1「多目标任一满足即返回；返回时说明触发目标及其他目标的已知状态」。
// 此前仓库内 targets 用例全为单元素（design 8.2 的多目标声称靠验收探针现证），
// 本装置把三形态固化：终态触发+agent 附注、无满足交回+两目标附注、agent 转达
// 触发（changed 出口，3.2.4）+job 附注且不夹带正文。
hostTest('R58-o：混合多目标三形态——任一满足、无满足、agent 转达触发', async () => {
  // ── 形态 1：job 终态触发 + agent 目标 running 附注（零等待）。
  {
    const rig = await buildRig('r58o1', [{ id: 'agent-r58o1', label: '混合目标子代理', activity: 'running' }]);
    try {
      const { ledger } = await import('../lib/delivery.js');
      const jobA = await rig.workflow.execute(WF_ARGS, rig.exec());
      assert.equal(jobA.status, 'running', '前置：A 让出');
      const entryA = ledger.jobs.get(jobA.job_id);
      entryA.terminal = { status: 'completed' };
      entryA.buffer = 'MIX-A-FINAL';
      entryA.readyAt = ledger.now();
      const result = await rig.waiter.execute(
        { wait_ms: 0, targets: [{ kind: 'job', id: jobA.job_id }, { kind: 'agent', id: 'agent-r58o1' }] },
        rig.exec()
      );
      const trigger = result.outputs.find((item) => item.job_id === jobA.job_id);
      assert.ok(trigger !== undefined, '任一满足：触发目标作业以批次条目出现');
      assert.equal(trigger.text, 'MIX-A-FINAL', '触发目标正文随批交付');
      assert.equal(result.status, 'running', '零等待主出口：就绪即取（不空等）');
      const agentNote = (result.targets ?? []).find((t) => t.id === 'agent-r58o1');
      assert.ok(agentNote !== undefined, '混合数组中的 agent 目标出现在 targets 附注');
      assert.equal(agentNote.status, 'running', '其余目标附注已证 running 状态');
    } finally {
      await rig.dispose();
    }
  }
  // ── 形态 2：无任一满足（job 运行中 + agent running）→ 零等待按无目标条件
  // 交回，不误触、不空等，两目标状态齐全。
  {
    const rig = await buildRig('r58o2', [{ id: 'agent-r58o2', label: '混合目标子代理', activity: 'running' }]);
    try {
      const jobB = await rig.workflow.execute(WF_ARGS, rig.exec());
      assert.equal(jobB.status, 'running', '前置：B 让出后运行中');
      const result = await rig.waiter.execute(
        { wait_ms: 0, targets: [{ kind: 'job', id: jobB.job_id }, { kind: 'agent', id: 'agent-r58o2' }] },
        rig.exec()
      );
      assert.equal(result.status, 'running', '无任一满足：零等待按无目标条件交回');
      const jobNote = (result.targets ?? []).find((t) => t.id === jobB.job_id);
      const agentNote = (result.targets ?? []).find((t) => t.id === 'agent-r58o2');
      assert.ok(jobNote !== undefined && agentNote !== undefined, '两个目标的已证状态都附注');
      assert.equal(jobNote.status, 'running');
      assert.equal(agentNote.status, 'running');
    } finally {
      await rig.dispose();
    }
  }
  // ── 形态 3：agent 目标的转达消息触发（changed 出口，3.2.4/3.2.6）+ job 目标
  // 附注；返回不夹带消息正文（正文由子代理消息通道交付）。
  {
    const rig = await buildRig('r58o3', [{ id: 'agent-r58o3', label: '混合目标子代理', activity: 'running' }]);
    try {
      const jobB = await rig.workflow.execute(WF_ARGS, rig.exec());
      assert.equal(jobB.status, 'running', '前置：B 让出后运行中');
      rig.parent.inbox.nextStep.push({
        id: 'm-r58o-relay',
        source: { kind: 'agent-message', form: 'relay', senderSessionId: 'agent-r58o3' }
      });
      const result = await rig.waiter.execute(
        { wait_ms: 0, targets: [{ kind: 'job', id: jobB.job_id }, { kind: 'agent', id: 'agent-r58o3' }] },
        rig.exec()
      );
      assert.equal(result.status, 'changed', 'agent 目标转达触发混合等待（changed 出口）');
      assert.ok((result.outputs ?? []).length === 0, '返回不夹带消息正文');
      const jobNote = (result.targets ?? []).find((t) => t.id === jobB.job_id);
      assert.ok(jobNote !== undefined && jobNote.status === 'running', 'job 目标随返回附注 running 状态');
    } finally {
      await rig.dispose();
    }
  }
});

// R58-m（真机首测 P-2）：运行中作业零等待取增量——includeRunning 装配、只推进
// 游标不终结生命周期；终态后最终结果照常投递。真机缺陷形态：零等待返回称增量
// 已附、装配层把运行中条目整体滤除（collectBatch 候选只收终态）。
hostTest('R58-m：零等待增量装配——运行中条目进批、不置已交付事实、终态后照常投', async () => {
  const rig = await buildRig('r58m');
  try {
    const { ledger } = await import('../lib/delivery.js');
    const owner = rig.parent.id;
    const jobId = `r58m-job-${Math.random().toString(36).slice(2, 8)}`;
    ledger.noteJobStarted(rig.ctx, { agentLang: 'en', maxResultChars: 4096 }, jobId, owner);
    const entry = ledger.jobs.get(jobId);
    entry.terminal = null; // 运行中
    entry.buffer = 'INC-PART-1';
    // 默认（正等待语义）：运行中条目不装配。
    let batch = ledger.collectBatch(owner, { triggerJobIds: [jobId], lang: 'en' });
    assert.equal(batch.delivered.length, 0, '默认候选只收终态（正等待不带半截输出）');
    // includeRunning（零等待出口）：装配增量，不置认领/已交付事实。
    batch = ledger.collectBatch(owner, { triggerJobIds: [jobId], lang: 'en', includeRunning: true });
    assert.equal(batch.delivered.length, 1, 'includeRunning 装配运行中增量条目');
    assert.equal(batch.delivered[0].text, 'INC-PART-1');
    assert.equal(batch.delivered[0].terminal, null, '运行中条目 terminal 为空（出口层渲染 running）');
    assert.equal(entry.buffer, '', '已发增量不重发（游标推进）');
    assert.equal(entry.claimedBy, null, '不置认领（最终结果仍可投）');
    assert.equal(entry.deliveredFact, null, '不置已交付事实（终态后照常交付）');
    // 无新增量再取：不重复装配。
    batch = ledger.collectBatch(owner, { triggerJobIds: [jobId], lang: 'en', includeRunning: true });
    assert.equal(batch.delivered.length, 0, '无新增量不重复装配');
    // 终态后：最终结果（含剩余缓冲）照常经完成路径交付。
    entry.buffer = 'FINAL-PART';
    entry.terminal = { status: 'completed' };
    if (entry.readyAt === null) entry.readyAt = ledger.now();
    batch = ledger.collectBatch(owner, { triggerJobIds: [jobId], lang: 'en' });
    assert.equal(batch.delivered.length, 1, '终态后最终结果照常装配');
    assert.equal(batch.delivered[0].text, 'FINAL-PART');
    assert.equal(entry.deliveredFact?.via, 'wait');
    ledger.detachJob(jobId);
  } finally {
    await rig.dispose();
  }
});

// R58-n（复审 M-3/H-1/M-1 端到端）：零等待出口真跑 waiter.execute——运行中目标
// 的增量随返回携带（running 分键状态行），就绪的 lossy 作业随批带两态找回说明。
// checkedTool 全程过 schema：lossy 条目的 note 键未进 outputs schema 即红（真机
// 「宿主校验拒绝整个工具返回」的缺陷形态——离线装置此前缺席该形态）；render 文本
// 不拼 item.note 也红（说明不进模型可见文本的形态）。
hostTest('R58-n：零等待端到端——运行中增量出口投影 + lossy 批次 note（schema 与 render 双锚）', async () => {
  const rig = await buildRig('r58n');
  try {
    const { ledger } = await import('../lib/delivery.js');
    // 两个真 workflow 作业（registry 在册）：A 悬置让出=运行中目标；B 同款悬置，
    // 账面手填终态+lossy 事实（模拟结算读已发生的形态——批候选读账面，不走
    // 结算链，避免完成消息先认领把条目摘出批次）。
    const first = await rig.workflow.execute(WF_ARGS, rig.exec());
    assert.equal(first.status, 'running', '前置：A 让出');
    const second = await rig.workflow.execute({ ...WF_ARGS, meta: { name: 'at-r58n-lossy', description: 'R58-n lossy entry' } }, rig.exec());
    assert.equal(second.status, 'running', '前置：B 让出');
    const inc = ledger.jobs.get(first.job_id);
    inc.terminal = null;
    inc.buffer = 'INC-DELTA-BODY';
    const lossy = ledger.jobs.get(second.job_id);
    lossy.terminal = { status: 'completed' };
    lossy.buffer = '';
    lossy.lossy = true;
    lossy.spillPaths = ['at-r58n-spill.txt'];
    lossy.readyAt = ledger.now();
    const result = await rig.waiter.execute({ wait_ms: 0, targets: [{ kind: 'job', id: first.job_id }] }, rig.exec());
    // 出口投影：运行中目标 status='running'、增量正文在；lossy 条目带 note（schema
    // 未声明 note 即被 checkedTool 拒——H-1 锚）。
    const incEntry = result.outputs.find((item) => item.job_id === first.job_id);
    assert.ok(incEntry !== undefined, '运行中目标必须以批次条目出现（includeRunning 出口接线）');
    assert.match(incEntry.status_line, /is still running/, '运行中条目走 completionItemRunning 分键（不是 settled 措辞）');
    assert.equal(incEntry.text, 'INC-DELTA-BODY');
    assert.equal(result.delivered.find((item) => item.job_id === first.job_id)?.status, 'running');
    const lossyEntry = result.outputs.find((item) => item.job_id === second.job_id);
    assert.ok(lossyEntry !== undefined, '就绪 lossy 作业随批出现（9.3.2 不限于目标列表）');
    assert.match(lossyEntry.note ?? '', /spill/, 'lossy 条目 note 带落盘位置（两态找回说明）');
    // render 可见文本：增量正文与 lossy 说明都进模型可见面（M-1 锚）。
    const rendered = rig.waiter.output.render(undefined, result).map((part) => part.text).join('\n');
    assert.ok(rendered.includes('INC-DELTA-BODY'), '增量正文必须进 render 可见文本');
    assert.ok(rendered.includes('at-r58n-spill.txt'), 'lossy 找回说明必须进 render 可见文本');
  } finally {
    await rig.dispose();
  }
});

// R58-l（盲审 M-3 复审 FAIL 项）：预算外说明有界可测（需求 9.3.2「批次还须限制
// 条目数及预算外状态、标识和诊断说明的总量……有限且可测的规则」）——单条
// 说明 ≤200（clampNote 入界，宿主留存路径等无界字符串在此截断）；完成消息内
// 留存行合计 ≤2000（超限合并为一行计数汇总，正文不受限）。
hostTest('R58-l：说明两档上限——单条 200 截断、留存行合计 2000 汇总回退（9.3.2）', async () => {
  const rig = await buildRig('r58l');
  try {
    const { ledger, clampNote, MAX_NOTE_CHARS } = await import('../lib/delivery.js');
    // 单条入界：无界宿主字符串截断到 200（尾部省略号）。
    const longPath = 'S'.repeat(5000);
    const clamped = clampNote(`spill at ${longPath}`);
    assert.ok(clamped.length <= MAX_NOTE_CHARS, `单条说明 ≤200；实得 ${String(clamped.length)}`);
    assert.ok(clamped.endsWith('...'), '截断带尾部省略号');
    assert.ok(clamped.length > 100, '短于上限的原样保留（本条未到界也应尽量保留）');

    // 留存行合计：12 条 ×~200 字符 → 说明合计 >2000 → 汇总回退一行（正文不受限）。
    const owner = rig.parent.id; // 真主体：flush 按主体选通道
    const jobId = `r58l-job-${Math.random().toString(36).slice(2, 8)}`;
    ledger.noteJobStarted(rig.ctx, { agentLang: 'en', maxResultChars: 4096 }, jobId, owner);
    const entry = ledger.jobs.get(jobId);
    entry.terminal = { status: 'completed' };
    entry.buffer = 'BODY-TEXT';
    entry.spillPaths = Array.from({ length: 12 }, (_, i) => `P${i}-${'x'.repeat(180)}`);
    entry.lossy = true;
    const token = ledger.claimWait(owner);
    await ledger.releaseWait(token, owner);
    const sends = [...rig.followups, ...rig.injections];
    assert.ok(sends.length > 0, '前置：完成消息已投出');
    const text = sends[0].content.map((p) => p.text).join('');
    assert.ok(text.includes('BODY-TEXT'), '正文不受说明上限影响');
    const spillLineCount = (text.match(/P\d+-x+/g) ?? []).length;
    assert.ok(spillLineCount < 12, `留存行被合并（未逐条全列）；实列 ${String(spillLineCount)} 行`);
    assert.match(text, /more spill paths omitted|留存路径未列出/, '超限给一行计数汇总（汇总回退）');
    ledger.detachJob(jobId);
  } finally {
    await rig.dispose();
  }
});

hostTest('R55（判据 2b·子代理侧）：next-step 滞留目标子代理的未领取结算通知 → settled（结束优先于插话）', async () => {
  const rig = await buildRig('pre2b');
  try {
    const childId = `at-r57-child-${Math.random().toString(36).slice(2, 8)}`;
    // 目标子代理经 rig 的注册表默认登记为 running（附注读取用）；结算通知在
    // 等待开始前已滞留 next-step（source.senderSessionId 是权威关联证据）。
    inboxPayload({
      agent: rig.parent, sourceKind: 'subagent-settled', form: 'notice',
      summary: 'child finished', senderSessionId: childId, target: 'next-step'
    });
    inboxPayload({ agent: rig.parent, sourceKind: 'user', text: '同时滞留的插话', target: 'next-step' });

    const outcome = await rig.waiter.execute({ wait_ms: 500, targets: [{ kind: 'agent', id: childId }] }, rig.exec());
    assert.equal(outcome.status, 'settled', '未领取结算通知优先于一切唤醒（含先到插话）——入口侧优先级');
    assert.equal(outcome.agent_id, childId);
  } finally {
    await rig.dispose();
  }
});

// ── 子代理目录行形状（旧 wait-agent 测试的形状判据在统一等待上的迁移）──────────
//
// 行形状消费三态：0.1.7 catalog 行（无 kind）、判别联合行（kind:'child'）、诊断行
// （kind:'diagnostic'——不是可等待的子代理）。前两种是关系证据；诊断行必须排除出
// 存在屏障，但纠错清单里以带 reason 的形态如实列出。

hostTest('子代理目录行形状：无 kind 的 catalog 行与 kind:"child" 行都是关系证据（不报 unknown）', async () => {
  for (const [name, row] of [
    ['catalog 行（无 kind）', { id: 'shape-c1', label: '调研甲', activity: 'running' }],
    ['判别联合行（kind:"child"）', { id: 'shape-c2', kind: 'child', label: '调研乙', mode: 'running' }]
  ]) {
    const rig = await buildRig('shape', [row]);
    try {
      const outcome = await rig.waiter.execute(
        { wait_ms: 80, targets: [{ kind: 'agent', id: row.id }] }, rig.exec()
      );
      assert.equal(outcome.status, 'running', `${name}：存在屏障命中（注册表观察 running，预算到期交回 running）`);
      assert.deepEqual(outcome.targets, [{ kind: 'agent', id: row.id, status: 'running' }]);
    } finally {
      await rig.dispose();
    }
  }
});

hostTest('子代理目录行形状：诊断行不进存在屏障；纠错清单如实列出（带 reason）', async () => {
  const rig = await buildRig('shape-diag', [
    { id: 'shape-live', label: '调研丙', activity: 'running' },
    { id: 'shape-diag', kind: 'diagnostic', reason: 'registry unreadable' }
  ]);
  try {
    await assert.rejects(
      rig.waiter.execute({ wait_ms: 80, targets: [{ kind: 'agent', id: 'shape-diag' }] }, rig.exec()),
      (error) => {
        // 诊断行不是可等待的子代理：按查无报 unknown，纠错清单列出真实子代理，
        // 诊断行以带 reason 的形态出现（不冒充可等待目标）。
        const message = String(error?.message ?? error);
        return message.includes('shape-live') && message.includes('shape-diag')
          && message.includes('registry unreadable');
      },
      '诊断行必须被存在屏障排除，且纠错清单两种行形状都如实写出'
    );
  } finally {
    await rig.dispose();
  }
});

hostTest('分隔规则：增量与一次性 result 之间恰一个换行（已换行结尾不补、非换行结尾必补）', async () => {
  const rig = await buildRig('sep');
  try {
    const startWith = (text) => rig.ctx.jobs.start({
      kind: 'at-r57-sep',
      label: 'separator probe',
      owner: rig.parent.id,
      run(job) {
        job.append(text);
        return {
          cancel() {},
          done: Promise.resolve({ status: 'completed', detail: 'exit code: 0', result: '{"x":1}' })
        };
      }
    });
    const probe = async (text) => {
      const jobId = startWith(text);
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      assert.equal(rig.ctx.jobs.list(rig.parent.id).find((j) => j.id === jobId).status, 'completed');
      const outcome = await rig.waiter.execute(waitArgs(jobId), rig.exec());
      return outcome.output;
    };

    // 非换行结尾的增量：与 result 之间恰补一个换行。
    assert.equal(await probe('partial'), 'partial\n{"x":1}',
      '增量不以换行结尾时，与一次性 result 之间必须恰补一个换行');
    // 已以换行结尾的增量：不得再补第二个换行。
    assert.equal(await probe('partial\n'), 'partial\n{"x":1}',
      '增量已以换行结尾时，不得重复补换行（恰一个分隔）');
  } finally {
    await rig.dispose();
  }
});

// ---------------------------------------------------------------------------
// R58（实现审查轮新增判据——需求 9.3.1「有目标等待的 continue 路径」/9.3.2 完成
// 消息预算与重复交付/9.3.4 进度日志筛选）：审查实证过「竞速循环复用已 resolve
// 的一次性 Promise → 无限自旋 OOM」「完成消息绕过批次预算」「delivered 后被动
// 双投」三类缺陷形态；以下用例钉住修正后的行为。
// ---------------------------------------------------------------------------

hostTest('R58-a：等 B 时 A 结算——有目标等待保持到 B 的事件，A 的内容随批次交付（不自旋、不提前返回）', async () => {
  const rig = await buildRig('r58a');
  try {
    // 先起 B（runs[0]）、再起 A（runs[1]）：等待目标＝B，另一作业 A 在等待中结算。
    const b = await rig.workflow.execute(WF_ARGS, rig.exec());
    const a = await rig.workflow.execute(WF_ARGS, rig.exec());
    assert.equal(b.status, 'running');
    assert.equal(a.status, 'running');

    const pending = rig.waiter.execute(
      { wait_ms: 4000, targets: [{ kind: 'job', id: b.job_id }] }, rig.exec()
    );
    // A 结算（等待中另一路径 readSettled → 就绪事件）：就绪内容**不结束**有目标
    // 等待——旧缺陷形态＝就绪信号被 continue 复用 → 微任务自旋（宏任务饿死、
    // 堆耗尽）；修正后 continue 挂新世代，等待继续。
    rig.finisher(1);
    let concluded = false;
    pending.then(() => { concluded = true; }, () => { concluded = true; });
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    assert.equal(concluded, false, 'A 结算不得结束对 B 的等待（自旋/提前返回都是缺陷形态）');

    // B 结算才是出口：交付 B 的结果，A 的就绪内容随同批交付（批次条目带状态行）。
    rig.finisher(0);
    const outcome = await pending;
    assert.equal(outcome.status, 'completed', 'B 的终态是本等待的出口');
    assert.match(outcome.output ?? '', /AT_FINAL_PAYLOAD/, 'B 的最终 JSON 在返回正文');
    const aEntry = (outcome.outputs ?? []).find((item) => item.job_id === a.job_id);
    assert.ok(aEntry !== undefined, 'A 的就绪内容随批次交付（FIFO 并入同批）');
    assert.match(aEntry.status_line ?? '', /settled|已结算/,
      '批次条目带终态状态行（与完成消息同款——设计 2.4）');
    assert.match(aEntry.text ?? '', /AT_FINAL_PAYLOAD/, 'A 的正文在批次条目里');
  } finally {
    await rig.dispose();
  }
});

hostTest('R58-b：等待中非目标 notice 到达——继续等待，不提前交回（消息订阅目标过滤）', async () => {
  const rig = await buildRig('r58b');
  try {
    const started = await rig.workflow.execute(WF_ARGS, rig.exec());
    assert.equal(started.status, 'running');
    const pending = rig.waiter.execute(
      { wait_ms: 4000, targets: [{ kind: 'job', id: started.job_id }] }, rig.exec()
    );
    // 等待中到达的非目标 notice（sender 非目标子代理）：不产生唤醒（订阅层过滤），
    // 消息留在收件箱按宿主节奏领取。旧缺陷形态＝wake 胜出后 matched=undefined
    // → continue 复用已 resolve 的 wake → 自旋。
    rig.ctx.emit('agent/inbox/inserted', inboxPayload({
      agent: rig.parent,
      sourceKind: 'tool-jobs',
      form: 'notice',
      summary: 'some other job finished',
      senderSessionId: 'someone-else',
      target: 'next-step'
    }));
    let concluded = false;
    pending.then(() => { concluded = true; }, () => { concluded = true; });
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    assert.equal(concluded, false, '非目标 notice 不提前结束有目标等待（9.3.1 表 2 行）');

    rig.finisher();
    const outcome = await pending;
    assert.equal(outcome.status, 'completed', '作业终态才是出口');
  } finally {
    await rig.dispose();
  }
});

hostTest('R58-c：无活等待的完成消息走批次预算——截断+扣减，不按载体形态倍增（9.3.2）', async () => {
  const rig = await buildRig('r58c', [], { maxResultChars: 40 });
  try {
    // 长值作业让出（yield 到期）→ 无活等待；结算由保活链接管 → 完成消息路径。
    const args = {
      script: 'return "x".repeat(400)',
      meta: { name: 'r58c-budget', description: 'completion budget' },
      yield_ms: 20
    };
    const pending = rig.workflow.execute(args, rig.exec());
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    const handle = await pending;
    assert.equal(handle.status, 'running', '前置：让出（预算 40 内未结算）');
    // 400 字符最终值（JSON 序列化后远超预算 40）——完成消息必须截断。
    rig.finisher(undefined, 'x'.repeat(400));
    await new Promise((resolve) => { setTimeout(resolve, 80); });
    // 本 rig 的 parent 无 status 字段（读作 busy）→ 完成消息走 inject 通道；
    // followup 是 idle 通道（R58-d 同款断言面已覆盖空判）。两通道合并校验。
    const sends = [...rig.followups, ...rig.injections];
    assert.ok(sends.length === 1, `恰一条完成消息（实得 ${String(sends.length)} 条）`);
    const text = sends[0].content.map((part) => part.text).join('');
    // 完成消息正文不得超共享预算：旧缺陷形态＝完成消息不裁不扣（预算 100 实收
    // 550 字符——#takeShare 修正后与批次共用同一分配管线）。
    assert.ok(text.length <= 40 + 200,
      `完成消息长度 ${String(text.length)} 应受批次预算约束（预算 40 + 状态行/省略标记余量）`);
    assert.match(text, /truncated|省略/, '截断必须带省略标记（不静默丢弃）');
  } finally {
    await rig.dispose();
  }
});

hostTest('R58-d：首次等待直付后不再被动双投——armed 链按已交付事实短路（9.3.2「只出现一次」）', async () => {
  const rig = await buildRig('r58d');
  try {
    // 首等内完成 → settleNow 直接交付（'delivered'）；armed 链结算时 deliveredFact
    // 短路读取——旧缺陷形态＝#beat 消费 result 填 buffer → 完成消息再投原始 JSON
    //（触发条件＝完成晚于首次等待半窗，默认配置下常见）。
    const pending = rig.workflow.execute(WF_ARGS, rig.exec());
    rig.finisher();
    const direct = await pending;
    assert.equal(direct.status, 'completed', '前置：首等内直接交付');
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    assert.equal(rig.followups.length, 0,
      '已直付的最终结果不得再以完成消息投递（同一直付路径的被动双投是缺陷形态）');
    assert.equal(rig.injections.length, 0, 'inject 通道同样不得收到重复结果');
    // R58-i（盲审 M-5）：已交付作业再次作为目标等待——返回必须**说明**已交付
    //（note 键），不得让空 output 被误读成「完成且无输出」。
    const settledView = rig.ctx.jobs.list(rig.parent.id)
      .find((j) => j.status === 'completed' && j.kind === 'async-workflow');
    assert.notEqual(settledView, undefined, '前置：注册表里有已结算的编排作业');
    const again = await rig.waiter.execute(
      { wait_ms: 0, targets: [{ kind: 'job', id: settledView.id }] }, rig.exec()
    );
    const { ledger: dbgLedger } = await import('../lib/delivery.js');
    const dbgEntry = dbgLedger.jobs.get(settledView.id);
    assert.ok(dbgEntry !== undefined, '前置：账本登记在册');
    assert.equal(again.status, 'completed', '再次等待按终态返回');
    assert.ok(typeof again.note === 'string' && again.note.length > 0,
      '已交付事实以 note 说明（盲审 M-5）');
    assert.ok(/already finished|先前已交付|已交付/.test(again.note),
      `note 说明结果已在先前载体交付；实得 ${JSON.stringify(again.note)}`);
    assert.equal(again.output, '', '正文不重复出现（恰一次）');
  } finally {
    await rig.dispose();
  }
});

hostTest('R58-e：交付批回滚按真实装配退回缓冲（undoClaim 非空回滚）', async () => {
  const rig = await buildRig('r58e');
  try {
    const { ledger } = await import('../lib/delivery.js');
    const owner = `r58e-owner-${Math.random().toString(36).slice(2, 8)}`;
    const jobId = `r58e-job-${Math.random().toString(36).slice(2, 8)}`;
    ledger.noteJobStarted(rig.ctx, { agentLang: 'en', maxResultChars: 4096 }, jobId, owner);
    const entry = ledger.jobs.get(jobId);
    entry.terminal = { status: 'completed' };
    entry.buffer = 'PAYLOAD-TO-ROLLBACK';
    const { delivered } = ledger.collectBatch(owner, {});
    assert.equal(delivered.length, 1, '前置：装配了一条批次条目');
    assert.equal(entry.buffer, '', '装配即消费缓冲');
    // 回滚：正文退回缓冲、认领撤销（旧缺陷形态＝undoClaim(owner, []) 空回滚——
    // 注释宣称回滚而循环体不执行）。
    ledger.undoClaim(owner, delivered);
    assert.equal(entry.buffer, 'PAYLOAD-TO-ROLLBACK', '回滚退回正文');
    assert.equal(entry.claimedBy, null, '回滚撤销认领');
    // 截断条目按**装配前原文**回滚（盲审 M-1）：预算 20 装配出首尾保留的裁剪
    // 文本后，回滚必须退回整条原文——退回裁剪文本会让中段永久丢失（模型从未
    // 见过任何部分，读取游标又已推进）。独立 owner：共享批的剩余预算会让这
    // 条不截断，测不到目标形态。
    const owner2 = `r58e-owner2-${Math.random().toString(36).slice(2, 8)}`;
    const jobId2 = `r58e-job2-${Math.random().toString(36).slice(2, 8)}`;
    ledger.noteJobStarted(rig.ctx, { agentLang: 'en', maxResultChars: 20 }, jobId2, owner2);
    const entry2 = ledger.jobs.get(jobId2);
    entry2.terminal = { status: 'completed' };
    const original2 = `HEAD${'x'.repeat(80)}TAIL`;
    entry2.buffer = original2;
    const { delivered: delivered2 } = ledger.collectBatch(owner2, {});
    assert.equal(delivered2.length, 1, '前置：截断条目装配成功');
    assert.equal(entry2.buffer, '', '装配即消费缓冲');
    assert.ok(delivered2[0].text.length < original2.length, '前置：装配文本确实被裁剪（预算 20 < 原文 89）');
    assert.notEqual(delivered2[0].text, original2, '前置：装配文本不是原文（截断真实发生）');
    ledger.undoClaim(owner2, delivered2);
    assert.equal(entry2.buffer, original2,
      '截断条目回滚退回装配前原文（不是裁剪文本——中段不得丢失）');
    ledger.detachJob(jobId2);
    ledger.detachJob(jobId);
  } finally {
    await rig.dispose();
  }
});

hostTest('R58-f：workflowProgressLog 两向——默认滤 log 通道；开启后进度并入交付正文', async () => {
  const startJob = (rig) => rig.ctx.jobs.start({
    kind: 'r58f-cmd',
    label: 'log channel probe',
    owner: rig.parent.id,
    run(job) {
      job.append('stdout line\n');
      job.append('▸ Phase One\n', { channel: 'log' });
      return {
        cancel() {},
        done: Promise.resolve({ status: 'completed', detail: 'exit code: 0', result: '{"r":1}' })
      };
    }
  });
  const settle = async (rig, jobId) => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      if (rig.ctx.jobs.list(rig.parent.id).find((j) => j.id === jobId)?.status === 'completed') return;
    }
    throw new Error('job did not settle in 2s');
  };

  const closed = await buildRig('r58f-off');
  try {
    const id1 = startJob(closed);
    await settle(closed, id1);
    const off = await closed.waiter.execute(waitArgs(id1), closed.exec());
    assert.ok(off.output.includes('stdout line') && off.output.includes('"r":1'),
      '正常输出与一次性 result 照常交付');
    assert.ok(!off.output.includes('Phase One'),
      '默认（workflowProgressLog=false）：log 通道不进模型正文（与宿主 renderModelDelta 同判）');
  } finally {
    await closed.dispose();
  }

  const open = await buildRig('r58f-on', [], { workflowProgressLog: true });
  try {
    const id2 = startJob(open);
    await settle(open, id2);
    const on = await open.waiter.execute(waitArgs(id2), open.exec());
    assert.ok(on.output.includes('stdout line') && on.output.includes('"r":1'),
      '开启向同样保留正常输出与 result');
    assert.ok(on.output.includes('Phase One'),
      '开启（workflowProgressLog=true）：进度日志并入交付正文');
  } finally {
    await open.dispose();
  }
});

// R58-g（复审新-1）：批预算耗尽时让位复查不投截断空壳——正文保留、经领取出路
// 完整交付（9.3.2 防丢失：已消费未交付的内容不得因裁剪永久丢失）。缺陷形态
// ＝最后一个活等待注销的让位复查（releaseWait 先于 closeBatchIfIdle）沿用
// remaining=0 的未关批 → take=0 → 仅截断标注的空壳消息 + 缓冲清空 + 已交付
// 事实置位 → 正文无任何载体、再 wait 也读不到。
hostTest('R58-g：批预算耗尽——完成消息延后不丢正文，wait_ms=0 完整领取', async () => {
  const rig = await buildRig('r58g', [], { maxResultChars: 60 });
  try {
    const startJob = (kind, label, text) => rig.ctx.jobs.start({
      kind, label, owner: rig.parent.id,
      run(job) {
        job.append(text);
        return { cancel() {}, done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }) };
      }
    });
    // A 远超预算 60（先装配即占满本批）；B 50 字符（批内放不下、延后后应能完整
    // 装进下一批）。两者都已终态，同拍并行等待＝同一批次（设计 §2.6 领取窗口）。
    const idA = startJob('r58g-a', 'fills the batch', 'A'.repeat(300));
    const idB = startJob('r58g-b', 'deferred entry', 'B'.repeat(50));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    const [gotA, gotB] = await Promise.all([
      rig.waiter.execute(waitArgs(idA), rig.exec()),
      rig.waiter.execute(waitArgs(idB), rig.exec())
    ]);
    assert.equal(gotA.status, 'completed');
    assert.equal(gotB.status, 'completed');

    // 让位复查发生在批关闭前（releaseWait→closeBatchIfIdle 次序）：被延后条目
    // 走完成消息路径时不得出现「只含截断标注、无正文」的空壳（正文既不在消息
    // 也不在缓冲＝永久丢失形态）。
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    const sends = [...rig.followups, ...rig.injections];
    const hollow = sends.find((m) => {
      const text = m.content.map((p) => p.text).join('');
      return /truncated|省略/.test(text) && !/[AB]/.test(text.replace(/^[\s\S]{0,200}?(Background job|后台作业)[^\n]*\n?/, ''));
    });
    assert.equal(hollow, undefined, '不得投递只含截断标注的空壳完成消息（正文丢失形态）');
    const batchTextOf = (r) => (r.outputs ?? []).map((item) => item.text).join('');

    // 领取出路照抄有效：被延后作业的正文仍在。断言按「合并可观测性」——装配
    // 次序决定哪条进首批（A 触发先装配＝A 截断入批、B 延后；反向＝B 完整入批、
    // A 截断入批），但无论哪种时序，B 的完整正文（50 字符低于任何单批预算）必须
    // 整体出现在某个载体——等待返回、完成消息或领取——绝不允许只余截断标注。
    const pickupB = await rig.waiter.execute(
      { wait_ms: 0, targets: [{ kind: 'job', id: idB }] }, rig.exec()
    );
    const visible = [
      gotA.output ?? '', batchTextOf(gotA),
      gotB.output ?? '', batchTextOf(gotB),
      pickupB.output ?? '', batchTextOf(pickupB),
      ...sends.map((m) => m.content.map((p) => p.text).join(''))
    ].join('\n');
    assert.ok(visible.includes('B'.repeat(50)),
      `B 的完整正文必须在某个载体整体可见（不截断、不空壳、不丢失）；实得可见面 ${String(visible.length)} 字符`);
    // 且 B 不曾被标已交付后变空（无「deliveredFact 置位后正文蒸发」形态）：
    // 若 B 已在任何载体完整可见，再次零等待领取返回空是合法（已交付阻断），
    // 但不得出现「从没见过正文却已阻断」。
    if (!visible.includes('B'.repeat(50))) {
      const againB = await rig.waiter.execute(
        { wait_ms: 0, targets: [{ kind: 'job', id: idB }] }, rig.exec()
      );
      assert.ok((againB.output ?? '').includes('B') || batchTextOf(againB).includes('B'),
        'B 从未可见过——领取必须给出正文（永久丢失形态）');
    }
  } finally {
    await rig.dispose();
  }
});

// R58-h（盲审 H-1/N-1）：让位终局复查投**全部**就绪条目。单元装置直测
// releaseWait（复审 N-1：端到端形态里两等待在入口终态分支即返回、不经让位
// 复查，装置恒绿）——两 entry terminal+buffer 就绪、两次 claimWait 后逐个
// releaseWait：最后一次注销（activeWaits 归零）触发让位复查，**两条**就绪正文
// 都必须经完成消息投出（旧形态只投 Map 迭代序第一个，第二条滞留缓冲且再无
// 被动载体——违反 9.3.2「不要求专门再调用一次工具领取」）。空正文终态条目
//（N-2）同样有被动载体：投单行状态（不投空串）。
hostTest('R58-h：让位复查投全部就绪作业——两条正文+一条空正文状态行（不滞留缓冲）', async () => {
  const rig = await buildRig('r58h');
  try {
    const { ledger } = await import('../lib/delivery.js');
    const owner = rig.parent.id; // 真主体：flush 按主体选通道（followup/inject 记录器挂在它身上）
    const mk = (tag, text) => {
      const jobId = `r58h-${tag}-${Math.random().toString(36).slice(2, 8)}`;
      ledger.noteJobStarted(rig.ctx, { agentLang: 'en', maxResultChars: 4096 }, jobId, owner);
      const entry = ledger.jobs.get(jobId);
      entry.terminal = { status: 'completed' };
      entry.buffer = text;
      return jobId;
    };
    const idA = mk('a', 'ALPHA-PAYLOAD');
    const idB = mk('b', 'BETA-PAYLOAD');
    const idC = mk('c', ''); // 空正文终态（N-2）：状态行载体
    const token1 = ledger.claimWait(owner);
    const token2 = ledger.claimWait(owner);
    // 第一笔注销：仍有活等待——让位复查不触发（无投递）。
    await ledger.releaseWait(token1, owner);
    assert.equal(rig.followups.length + rig.injections.length, 0, '仍有一笔活等待时不投递');
    // 最后一笔注销：复查投全部就绪条目（A、B 正文 + C 状态行）。
    await ledger.releaseWait(token2, owner);
    const sends = [...rig.followups, ...rig.injections];
    const seen = sends.map((m) => m.content.map((p) => p.text).join('')).join('\n');
    assert.ok(seen.includes('ALPHA-PAYLOAD'), 'A 的正文经完成消息投出（不得只投第一个就绪作业）');
    assert.ok(seen.includes('BETA-PAYLOAD'), 'B 的正文经完成消息投出（旧形态滞留缓冲）');
    assert.ok(/r58h-c/.test(seen) && !/^\s*$/.test(seen),
      '空正文终态条目以状态行可见（N-2：不投空串消息）');
    for (const id of [idA, idB, idC]) {
      const entry = ledger.jobs.get(id);
      assert.equal(entry.claimedBy, 'message', `${id} 已认领`);
      ledger.detachJob(id);
    }
  } finally {
    await rig.dispose();
  }
});
