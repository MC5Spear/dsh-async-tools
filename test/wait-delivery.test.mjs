/**
 * 一次性交付在**真实注册表**上的回归（判据 1/2/3；需求 §2.2.3/9.3.1、设计 §2.4/§2.6）。
 *
 * 用真 Cordis ＋ 真 rc.2 `LocalJobRegistry`——注册表的一次性 `resultDelivered`、
 * 消费式游标、settled 截流都不是替身模拟的。受控点只有一个：workflow 引擎何时
 * 结算。断言的是正向行为：最终 JSON 必须出现在模型可见输出里，恰一次。
 *
 * L 系列（文件尾）是 REL-LIFECYCLE-01 的行级清扫回归：L1（查询行卸载不清他行
 * 账目）与 L8（挂监听失败行不因他行卸载被整体释放）是受控反例——修前行卸载
 * effect 调 `disposeAll`，两例必红；L9 在装载中途抛错的各时点断言行登记收支。
 *
 * 宿主包不可解析（离线环境/CI）时整文件跳过——跳过不是通过。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { hostTestFor, loadOfflineSafe } from './_host-gate.mjs';
import { resolveConfig } from '../lib/config.js';
import { LATE_ANSWER_EVENT } from '../lib/interrupts.js';
import { t } from '../lib/text.js';
import { resetAgentBaselines } from '../lib/wait-agent-target.js';
import { checkedTool, inboxPayload } from './_helpers.mjs';

// delivery.js 静态依赖 @deepseek-ai/dsh-llm（宿主链）——离线守卫禁止测试文件
// 静态闭包触达宿主链，与 workflow/wait 同走 loadOfflineSafe 动态装载。
const deliveryModule = await loadOfflineSafe('../lib/delivery.js');
const { ledger, resetDeliveryLedger } = deliveryModule ?? {};

// 宿主链动态守卫：lib/workflow.js、lib/wait.js（→ dsh-tools）与真注册表依赖
// （@deepseek-ai/cordis、@deepseek-ai/dsh-jobs-local——后者是宿主树内层包，不在本包
// peer 声明里）在离线形态都缺席，全部用例自跳过并打印理由（ci.yml offline 作业的
// 契约）。探测统一走 loadOfflineSafe：只认「@deepseek-ai/ 不可解析」这一种解析
// 事实，语法错或模块内部抛错原样红，不得被吞成跳过（防假跳过）。
const workflowModule = await loadOfflineSafe('../lib/workflow.js');
const waitModule = await loadOfflineSafe('../lib/wait.js');
const indexModule = await loadOfflineSafe('../lib/index.js');
// T7 真实通道用：lib/jobs.js → dsh-tools（defineTool）。同样走动态守卫装载。
const jobsModule = await loadOfflineSafe('../lib/jobs.js');
const { createWorkflowTool } = workflowModule ?? {};
const { createWaitTool, WAIT_SPIN_LIMIT } = waitModule ?? {};
const { apply: applyRow } = indexModule ?? {};
const { createRunTool: buildRunTool } = jobsModule ?? {};
const cordisModule = await loadOfflineSafe('@deepseek-ai/cordis');
const jobsLocalModule = await loadOfflineSafe('@deepseek-ai/dsh-jobs-local');
const { Context } = cordisModule ?? {};
const { LocalJobRegistry } = jobsLocalModule ?? {};
const hostTest = await hostTestFor(
  '../lib/workflow.js', '../lib/wait.js', '../lib/index.js', '../lib/jobs.js',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-jobs-local'
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
    // parent 是本主体；其余 id 默认给 running 形状（子代理目标用例的注册表观察
    // 默认值——需要 absent/idle/unknown 形态的用例经 options.agentsGet 覆盖）。
    get: (id) => (id === parent.id
      ? parent
      : (options.agentsGet === undefined ? { id, status: 'running' } : options.agentsGet(id)))
  });
  // 子代理目录替身（形状行为用例）：childRows 由调用方给（catalog 行／判别联合行／
  // 诊断行三种形态都从这里进）；options.listChildren 可整替（挂起/抛错/竞速用例）。
  base.provide('subagents', {
    listChildren: options.listChildren === undefined ? async () => childRows : options.listChildren,
    interrupt() {}
  });
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
    // options.jobsList／options.jobsRead＝受控外来行与受控读取（账本不在册、
    // jobs.list／jobs.read 可见的宿主注册表形——W-OBSERVE-H 的「外来作业静默
    // 结算」与 T5 的终态事实行）；其余服务与 dispose 仍走真注册表。
    jobs: (options.jobsList === undefined && options.jobsRead === undefined)
      ? ctx.jobs
      : {
          ...ctx.jobs,
          ...(options.jobsList === undefined ? {} : { list: options.jobsList }),
          ...(options.jobsRead === undefined ? {} : { read: options.jobsRead })
        },
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
    // 装置显式下限（合法显式设置原样保留）：用例用真定时器的小额 wait_ms
    //（60–500 ms）测预算到期，不吃出厂下限 20000 的夹紧。
    minWaitMs: 1,
    ...(options.maxResultChars === undefined ? {} : { maxResultChars: options.maxResultChars }),
    ...(options.workflowProgressLog === undefined ? {} : { workflowProgressLog: options.workflowProgressLog }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs })
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
    // 无目标挂起资格（9.3.1 工作前提）：放一个运行中后台作业——没有可等待
    // 工作时入口按 no-work 立即交回，测不到「预算到期不被排队消息打断」。
    const running = await rig.workflow.execute(WF_ARGS, rig.exec());
    assert.equal(running.status, 'running', '前置：同主体运行中作业提供挂起资格');
    inboxPayload({ agent: rig.parent, sourceKind: 'user', text: '排队中的消息', target: 'next-turn' });
    const outcome = await rig.waiter.execute({ wait_ms: 60 }, rig.exec());
    assert.notEqual(outcome.status, 'interrupted', '排队消息不打断（只有插话落点 next-step 参与）');
    assert.equal(outcome.status, 'budget', '无目标无信号的等待按预算到期交回');
  } finally {
    await rig.dispose();
  }
});

// R58-j：零等待与正等待同款入口判定——无目标时先到的 notice/relay
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

// R58-k：零等待同样扫先到迟到作答（与正等待入口同一判定）——
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
      // 零等待主出口无单触发字段——各条目正文随批携带（excludeJobId 只在终态
      // 出口使用，那里正文改由 output 字段携带、批次条目只留状态行）。
      assert.equal(trigger.text, 'MIX-A-FINAL', '触发目标正文随批交付');
      assert.match(trigger.status_line, /completed/, '触发目标状态行随批可见');
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

// R58-m：运行中作业零等待取增量——includeRunning 装配、只推进
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

// R58-n：零等待出口真跑 waiter.execute——运行中目标
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

// R58-l：预算外说明有界可测（需求 9.3.2「批次还须限制
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
  // r13 结算交付前的注册表复核（W-GATE-E）后，入口通知的 settled 交付要求注册表现读非运行；
  // 本判据测的是入口侧优先级（结束优先于插话），装置补静止读数、断言不变。
  const rig = await buildRig('pre2b', [], { agentsGet: (id) => ({ id, status: 'idle' }) });
  try {
    const childId = `at-r57-child-${Math.random().toString(36).slice(2, 8)}`;
    // 结算通知在等待开始前已滞留 next-step（source.senderSessionId 是权威关联证据）。
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
    // R58-i：已交付作业再次作为目标等待——返回必须**说明**已交付
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
      '已交付事实以 note 说明');
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
    // 截断条目按**装配前原文**回滚：预算 20 装配出首尾保留的裁剪
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
    // WAIT-RECOVER-01（9.3.2 裁剪恢复）：截断装配不清空缓冲——省略中段按装配
    // 前原文保留（partial 事实），续段可再进批；回滚仍退回完整原文。
    assert.ok(entry2.buffer !== '' && entry2.buffer.length < original2.length,
      '截断装配保留省略中段（缓冲非空、小于原文）');
    assert.equal(entry2.deliveredFact?.partial, true, '截断装配置 partial 已交付事实');
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
    // 装进下一批）。两者都已终态，同一领取窗口并行等待＝同一批次（设计 §2.6）。
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

// R58-h：让位终局复查投**全部**就绪条目。单元装置直测
// releaseWait——两 entry terminal+buffer 就绪、两次 claimWait 后逐个
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
      // 认领生命周期（REL-RECOVER-02）：宿主接受点（followup 正常返回＝整队
      // 已接受）释放认领——修前断言 claimedBy 停留 'message' 至下一轮询周期，
      // 窗口内其他载体只见状态行、partial 续段不可恢复。
      assert.equal(entry.claimedBy, null, `${id} 认领已在宿主接受点释放`);
      assert.notEqual(entry.deliveredFact, null, `${id} 已交付事实保持（阻断重复交付）`);
      ledger.detachJob(id);
    }
  } finally {
    await rig.dispose();
  }
});

// ── WAIT-EMPTY/WAIT-TIME/WAIT-AGENT-02/WAIT-READ/READY/SHARE 补测（B3）────────────
//
// 独立盲审登记的受控缺口：no-work/unconfirmed 出口、资格与诊断清单的竞速
//（挂起/取消切断）、已报告静止目标的资格与轮询周期、读取失败可重试、入口
// 汇集、并行直付份额、有目标等待不以迟到作答结束、混合目标校验顺序。
// 装置沿用真注册表；小额 wait_ms 走真定时器（装置显式 minWaitMs=1）。

hostTest('W-EMPTY-A：无目标且无运行中工作 → no-work 立即返回，不挂起等未来消息', async () => {
  const rig = await buildRig('no-work', []);
  try {
    const result = await rig.waiter.execute({ wait_ms: 250 }, rig.exec());
    assert.equal(result.status, 'no-work', '无可等待工作：未挂起立即交回');
    assert.ok(result.waited_ms < 250, '立即返回（不等满预算——挂起等未来消息是旧缺陷形态）');
    assert.match(result.note, /未确认存在可等待工作|No wait-worthy work/, '出口说明与两语键一致');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-EMPTY-B：资格清单查询失败 → unconfirmed，不假装无工作', async () => {
  const rig = await buildRig('unconfirmed', [], {
    listChildren: async () => { throw new Error('catalog down'); }
  });
  try {
    const result = await rig.waiter.execute({ wait_ms: 250 }, rig.exec());
    assert.equal(result.status, 'unconfirmed', '无法证实＝未证实档，不是 no-work');
    assert.match(result.note, /无法确认|could not be confirmed/, '未证实档给复查出路');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-EMPTY-C：有运行中子代理 → 无目标等待真实挂起至预算到期', async () => {
  const rig = await buildRig('has-work', [{ id: 'at-child-live' }]);
  try {
    const result = await rig.waiter.execute({ wait_ms: 220 }, rig.exec());
    assert.equal(result.status, 'budget', '有可等待工作：挂起到预算，不被资格门截断');
    assert.ok(result.waited_ms >= 180, '真实等待（提前交回即资格门误伤）');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-TIME-A：资格清单悬置 → 与总截止竞速，周期内交回 unconfirmed（不无界阻塞）', async () => {
  const rig = await buildRig('hang-list', [], {
    listChildren: () => new Promise(() => {})
  });
  try {
    const started = Date.now();
    const result = await rig.waiter.execute({ wait_ms: 300 }, rig.exec());
    const wall = Date.now() - started;
    assert.equal(result.status, 'unconfirmed', '清单挂起：按未证实档交回，不是无界挂死');
    assert.ok(wall < 1500, '受预算约束返回（WAIT-TIME-01 同缺陷类在新路径不复发）');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-TIME-B：资格清单悬置期间取消 → cancelled 出口及时切断', async () => {
  const rig = await buildRig('hang-cancel', [], {
    listChildren: () => new Promise(() => {})
  });
  try {
    const controller = new AbortController();
    const pending = rig.waiter.execute({ wait_ms: 5000 }, { agent: rig.parent, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('tool call aborted')), 150);
    const result = await pending;
    assert.equal(result.status, 'cancelled', '取消切断悬置清单（资格检查不吞取消）');
    assert.ok(result.waited_ms < 2000, '及时交回');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-TIME-C：目标屏障悬置 → 周期内交回 unconfirmed，不无界阻塞入口校验', async () => {
  const rig = await buildRig('hang-barrier', [], {
    listChildren: () => new Promise(() => {})
  });
  try {
    const started = Date.now();
    const result = await rig.waiter.execute(
      { wait_ms: 300, targets: [{ kind: 'agent', id: 'at-child-ghost-live' }] }, rig.exec()
    );
    const wall = Date.now() - started;
    assert.equal(result.status, 'unconfirmed', '屏障挂起：未证实档交回');
    assert.ok(wall < 1500, '受预算约束（入口校验不被悬置查询卡死）');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-SETTLED-A：已报告静止目标再次等待 → 立即返回「维持静止」，不挂起', async () => {
  const rig = await buildRig('quiet', [{ id: 'at-child-quiet' }], {
    agentsGet: (id) => ({ id, status: 'idle' })
  });
  try {
    const target = { kind: 'agent', id: 'at-child-quiet' };
    const first = await rig.waiter.execute({ wait_ms: 400, targets: [target] }, rig.exec());
    assert.equal(first.status, 'settled', '首次观察静止：停止态返回一次（stop-once）');
    const started = Date.now();
    const again = await rig.waiter.execute({ wait_ms: 400, targets: [target] }, rig.exec());
    const wall = Date.now() - started;
    assert.equal(again.status, 'settled', '维持静止目标不取得挂起资格（WAIT-AGENT-02）');
    assert.ok(wall < 300, '立即返回（挂起等翻转是缺陷形态）');
    assert.match(again.note, /维持上次报告的停止态|remain settled as last reported/,
      '说明目标维持已确认静止');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-SETTLED-B：静止子代理＋运行中作业的混合等待 → 轮询周期不截断，作业结算交回', async () => {
  const rig = await buildRig('mix', [{ id: 'at-child-quiet2' }], {
    agentsGet: (id) => ({ id, status: 'idle' }),
    pollIntervalMs: 80
  });
  try {
    // 建立静止基准（首次 stop-once），此后轮询周期看到的静止是「维持」。
    const target = { kind: 'agent', id: 'at-child-quiet2' };
    await rig.waiter.execute({ wait_ms: 100, targets: [target] }, rig.exec());
    const wf = await rig.workflow.execute(WF_ARGS, rig.exec());
    assert.equal(wf.status, 'running');
    const pending = rig.waiter.execute(
      { wait_ms: 4000, targets: [target, { kind: 'job', id: wf.job_id }] }, rig.exec()
    );
    // 静止周期（~80ms×多个周期）之后作业才结算：旧缺陷会在首个静止周期交回 settled。
    setTimeout(() => rig.finisher(), 500);
    const result = await pending;
    assert.equal(result.status, 'completed', '等待以作业终态交回，不被静止轮询周期截断');
    assert.ok(result.output.includes('AT_FINAL_PAYLOAD'), '作业正文随终态交付');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-READ-A：宿主读取失败 → 失败态可见可重试，正文恰一次交付', async () => {
  const rig = await buildRig('read-fail');
  try {
    const jobId = rig.ctx.jobs.start({
      kind: 'at-r57-cmd', label: 'read fail probe', owner: rig.parent.id,
      run(job) {
        job.append('RECOVERABLE-PAYLOAD\n');
        return { cancel() {}, done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }) };
      }
    });
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    // 装置内点状故障：终态后的首次读取抛错（readFailed 置位、不置交付事实）。
    const realRead = rig.ctx.jobs.read.bind(rig.ctx.jobs);
    let failNext = true;
    rig.ctx.jobs.read = (...args) => {
      if (failNext) throw new Error('registry read exploded');
      return realRead(...args);
    };
    const failed = await rig.waiter.execute(waitArgs(jobId), rig.exec());
    assert.equal(failed.status, 'completed', '终态事实照常返回');
    assert.match(failed.output, /读取失败|read failed/i, '读取失败≠空输出：失败标记与重试出路在场');
    assert.ok(!failed.output.includes('RECOVERABLE-PAYLOAD'), '失败当次不交付正文');
    // 故障排除后重试：正文恰好交付一次。
    failNext = false;
    const recovered = await rig.waiter.execute(waitArgs(jobId), rig.exec());
    assert.ok(recovered.output.includes('RECOVERABLE-PAYLOAD'), '失败未置交付事实：正文可重试取得');
    const third = await rig.waiter.execute(waitArgs(jobId), rig.exec());
    assert.equal(third.output, '', '重试后不重复（恰一次）');
    rig.ctx.jobs.read = realRead;
  } finally {
    await rig.dispose();
  }
});

hostTest('W-READY-A：入口已就绪的续段 → 无目标等待不挂起，直接汇集交付（readyCollect）', async () => {
  const rig = await buildRig('ready', [], { maxResultChars: 40 });
  try {
    const jobId = rig.ctx.jobs.start({
      kind: 'at-r57-cmd', label: 'long body', owner: rig.parent.id,
      run(job) {
        job.append(`HEAD-9-CHARS${'y'.repeat(160)}TAIL-10\n`);
        return { cancel() {}, done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }) };
      }
    });
    const first = await rig.waiter.execute(waitArgs(jobId), rig.exec());
    assert.equal(first.status, 'completed');
    assert.equal(first.truncated, true, '前置：首访按 40 份额截断（partial 事实，中段留缓冲）');
    // 无目标正等待：入口汇集就绪续段，不进入资格门挂起。
    const started = Date.now();
    const again = await rig.waiter.execute({ wait_ms: 300 }, rig.exec());
    const wall = Date.now() - started;
    assert.equal(again.status, 'message', '就绪内容优先于挂起（WAIT-READY-01）');
    assert.ok(again.outputs.some((item) => item.job_id === jobId && item.text.length > 0),
      '续段条目随批交回');
    assert.ok(again.output === '' || again.output === undefined, '无目标出口正文只在批次条目里');
    assert.ok(wall < 250, '立即交付，不等满预算');
    assert.match(again.note, /已汇集就绪|collected at the wait entry/, '汇集说明在场');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-SHARE-A：两个并行直付共享同一份批次预算——后到者只取剩余份额', async () => {
  const rig = await buildRig('share', [], { maxResultChars: 400 });
  try {
    const args = (name) => ({
      script: 'return {proof:"AT_FINAL_PAYLOAD"}',
      meta: { name, description: 'parallel direct share' },
      yield_ms: 200
    });
    const first = rig.workflow.execute(args('share-a'), rig.exec());
    const second = rig.workflow.execute(args('share-b'), rig.exec());
    // 结算落在让出窗口内：两次首次等待都走直接结算（先到先拿份额）。
    rig.finisher(0, { blob: `A-${'a'.repeat(300)}` });
    rig.finisher(1, { blob: `B-${'b'.repeat(300)}` });
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.status, 'completed');
    assert.equal(r2.status, 'completed');
    const bodyOf = (result, marker) => {
      const index = result.indexOf(marker);
      return index === -1 ? 0 : result.length - index;
    };
    const b1 = bodyOf(r1.result, 'A-');
    const b2 = bodyOf(r2.result, 'B-');
    // 先到者预留整份份额拿满正文；后到者在预留窗口内份额为零——整条延后
    //（正文进缓冲，续段可领取），同「剩余为零整条延后」同款语义。
    const fullCount = [b1, b2].filter((b) => b >= 300).length;
    assert.equal(fullCount, 1, '恰一个直付拿满正文（先分配再构造，共享同一份预算）');
    assert.ok(b1 + b2 <= 460, '两次直付合计不超过一份生效预算（标注行容差内）');
    const starved = b1 === 0 ? r1 : r2;
    assert.equal(starved.truncated, true, '份额耗尽的后到直付如实标注截断（正文延后）');
    // 被延后正文经 wait_ms=0 续段领取恢复（partial 事实，9.3.2 裁剪恢复）。
    const ids = rig.ctx.jobs.list(rig.parent.id).map((row) => row.id);
    const { ledger } = await import('../lib/delivery.js');
    const resumes = [];
    for (const id of ids) {
      resumes.push(await rig.waiter.execute({ wait_ms: 0, targets: [{ kind: 'job', id }] }, rig.exec()));
    }
    // 后到者正文不因份额耗尽丢失：账本缓冲有续段，或已由另一载体（完成消息）
    // 投出——两载体合计仍不超一份预算。
    const messageBodies = [...rig.followups, ...rig.injections]
      .map((m) => m.content.map((p) => p.text ?? '').join('')).join('\n');
    const resumedBodies = resumes.map((r) => `${r.output ?? ''}${JSON.stringify(r.outputs ?? [])}`).join('\n');
    const ledgerBodies = ids.map((id) => ledger.jobs.get(id)?.buffer ?? '').join('');
    assert.ok(
      messageBodies.includes('a'.repeat(5)) || messageBodies.includes('b'.repeat(5))
      || resumedBodies.includes('a'.repeat(5)) || resumedBodies.includes('b'.repeat(5))
      || ledgerBodies.includes('a'.repeat(5)) || ledgerBodies.includes('b'.repeat(5)),
      '被延后的正文经完成消息载体、续段领取或账本缓冲之一可恢复（不永久丢失）'
    );
  } finally {
    await rig.dispose();
  }
});

hostTest('W-WAKE-A：有目标等待不以迟到作答提前结束（作答留宿主收件箱）', async () => {
  const rig = await buildRig('late-target', [{ id: 'at-child-live3' }]);
  try {
    const wf = await rig.workflow.execute(WF_ARGS, rig.exec());
    assert.equal(wf.status, 'running');
    const pending = rig.waiter.execute(
      { wait_ms: 400, targets: [{ kind: 'job', id: wf.job_id }] }, rig.exec()
    );
    // 等待开始后经真实插件事件投递迟到作答（ask-takeover 通道；无目标等待
    // 才可被它唤醒——9.3.1）。直接改 inbox 数组既不触发事件也不进扫描，
    // 起不到激励作用（盲审计正）。
    setTimeout(() => {
      rig.ctx.emit(LATE_ANSWER_EVENT, {
        agentId: rig.parent.id, questionId: 'late-q', kind: 'answer', summary: 'late answer arrived'
      });
    }, 60);
    const result = await pending;
    assert.equal(result.status, 'running', '迟到作答不结束有目标等待：预算到期按目标仍在运行交回（被唤醒即失败）');
    assert.ok(result.waited_ms >= 350, '真实等到预算（被迟到作答唤醒即失败）');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-MIX-A：终态作业＋查无子代理的混合目标 → 全部资格校验先于终态读取（拒绝）', async () => {
  const rig = await buildRig('mix-order', []);
  try {
    const wf = await rig.workflow.execute(WF_ARGS, rig.exec());
    rig.finisher();
    const deadline = Date.now() + 2000;
    let settledView;
    while (Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      settledView = rig.ctx.jobs.list(rig.parent.id).find((j) => j.id === wf.job_id);
      if (settledView?.status === 'completed') break;
    }
    assert.equal(settledView?.status, 'completed', '前置：作业已终态');
    await assert.rejects(
      rig.waiter.execute(
        { wait_ms: 300, targets: [{ kind: 'job', id: wf.job_id }, { kind: 'agent', id: 'at-child-nope' }] },
        rig.exec()
      ),
      (error) => /at-child-nope|not found|查无|unknown/i.test(String(error?.message ?? error)),
      '混合目标：查无子代理在校验遍拒绝，终态作业不被先行读取交付（校验先于返回）'
    );
  } finally {
    await rig.dispose();
  }
});

// ═════════════════════════════════════════════════════════════════════
// WAIT-OBSERVE-01／WAIT-SETTLE-GATE-01／W-SPIN（r13 四项修正的受控装置）。
//
// 装置纪律：激励一律走真实通道——子代理状态经注册表替身的真实读取路径
// （`agents.get`，`agentStatusOf` 现读），停止信号经真实 `agent/status` 事件与
// 真实 inbox 投递（`ctx.emit`），作业结算经真 `LocalJobRegistry`；断言锚经
// `t('en', key)` 取运行时文案（变体断言：只断 status 的恒真断言无效）。
// ═════════════════════════════════════════════════════════════════════
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

hostTest('W-OBSERVE-A：无目标挂起中子代理静默转 idle（无消息无通知）→周期复查 ≤pollIntervalMs+容差内按 no-work 交回、note=workConcluded、未耗尽预算', async () => {
  resetAgentBaselines();
  let childStatus = 'running';
  const rig = await buildRig('obs-a', [{ id: 'at-obs-child' }], {
    agentsGet: (id) => ({ id, status: childStatus })
  });
  try {
    const started = Date.now();
    const pending = rig.waiter.execute({ wait_ms: 2000 }, rig.exec());
    await sleep(150);              // 入口资格检查完成、挂起开始（首个周期 500 ms 未到）
    childStatus = 'idle';          // 子代理静默转 idle：无消息、无通知
    const outcome = await pending;
    const wall = Date.now() - started;
    assert.equal(outcome.status, 'no-work', '复查确认无工作：及时交回（耗尽预算是旧缺陷形态）');
    assert.ok(wall < 1600, `复查在周期内交回（pollIntervalMs=500＋容差；实耗 ${String(wall)} ms）`);
    assert.ok(outcome.waited_ms < 2000, 'waited_ms 为全程实际时长且未耗尽预算');
    assert.ok(outcome.note.includes(t('en', 'wait.workConcluded')), 'note 用 workConcluded 新键');
    assert.ok(!outcome.note.includes(t('en', 'wait.noWork')), '不是入口 no-work 键（两键不得混用）');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-OBSERVE-B：复查节奏对齐 pollIntervalMs（间隔调大后时延随之）；全程上界仍 有效wait_ms+300ms', async () => {
  resetAgentBaselines();
  const runOnce = async (label, pollIntervalMs) => {
    let childStatus = 'running';
    const rig = await buildRig(label, [{ id: `${label}-child` }], {
      pollIntervalMs,
      agentsGet: (id) => ({ id, status: childStatus })
    });
    try {
      const started = Date.now();
      const pending = rig.waiter.execute({ wait_ms: 3000 }, rig.exec());
      await sleep(120);
      childStatus = 'idle';
      const outcome = await pending;
      return { wall: Date.now() - started, outcome };
    } finally {
      await rig.dispose();
    }
  };
  const fast = await runOnce('obs-b-fast', 100);
  const slow = await runOnce('obs-b-slow', 700);
  assert.equal(fast.outcome.status, 'no-work', '快周期：复查交回');
  assert.equal(slow.outcome.status, 'no-work', '慢周期：复查交回');
  assert.ok(fast.wall < 450, `快周期（100 ms）应近周期交回（实耗 ${String(fast.wall)} ms）`);
  assert.ok(slow.wall >= 600, `慢周期（700 ms）交回不早于首个周期（实耗 ${String(slow.wall)} ms）——节奏对齐 pollIntervalMs`);
  assert.ok(slow.wall <= 3300, '全程上界仍为有效 wait_ms＋300 ms');
});

hostTest('W-OBSERVE-C：复查周期在途时插话/取消先到→各自既有出口及时交回（竞速切断，不拖到周期结束）', async () => {
  resetAgentBaselines();
  const makeGateRig = async (label) => {
    let calls = 0;
    const gates = [];
    const rig = await buildRig(label, [{ id: `${label}-child` }], {
      pollIntervalMs: 300,
      // 首次调用＝入口资格检查（返回在册）；后续＝复查周期（挂起不答：宿主慢目录形态）。
      listChildren: () => new Promise((resolve) => {
        calls += 1;
        if (calls === 1) return resolve([{ id: `${label}-child` }]);
        gates.push(resolve);
      })
    });
    return { rig, gates };
  };
  {
    const { rig, gates } = await makeGateRig('obs-c-wake');
    try {
      const started = Date.now();
      const pending = rig.waiter.execute({ wait_ms: 5000 }, rig.exec());
      await sleep(450);            // 首个周期 300 ms 已发起、复查查询在途
      rig.ctx.emit('agent/inbox/inserted', inboxPayload({
        agent: rig.parent, sourceKind: 'user', text: 'steer during recheck', target: 'next-step'
      }));
      const outcome = await pending;
      assert.equal(outcome.status, 'interrupted', '复查在途的插话按 interrupted 及时交回');
      assert.ok(Date.now() - started < 2000, '及时（不被在途查询拖住）');
    } finally {
      for (const release of gates) release([]);
      await rig.dispose();
    }
  }
  {
    const { rig, gates } = await makeGateRig('obs-c-cancel');
    try {
      const controller = new AbortController();
      const started = Date.now();
      const pending = rig.waiter.execute(
        { wait_ms: 5000 },
        { agent: rig.parent, signal: controller.signal }
      );
      await sleep(450);
      controller.abort(new Error('tool call aborted'));
      const outcome = await pending;
      assert.equal(outcome.status, 'cancelled', '复查在途的取消按 cancelled 及时交回');
      assert.ok(Date.now() - started < 2000, '及时');
    } finally {
      for (const release of gates) release([]);
      await rig.dispose();
    }
  }
});

hostTest('W-OBSERVE-D：复查周期内 listChildren 挂起→不判无工作、续等不交回；恢复应答后照常按 no-work 交回', async () => {
  resetAgentBaselines();
  let calls = 0;
  const gates = [];
  const rig = await buildRig('obs-d', [{ id: 'at-obs-d-child' }], {
    pollIntervalMs: 250,
    listChildren: () => new Promise((resolve) => {
      calls += 1;
      if (calls === 1) return resolve([{ id: 'at-obs-d-child' }]);
      gates.push(resolve);
    })
  });
  try {
    const started = Date.now();
    let concluded = false;
    const pending = rig.waiter.execute({ wait_ms: 5000 }, rig.exec());
    pending.then(() => { concluded = true; }, () => { concluded = true; });
    await sleep(1200);             // 首个周期 250 ms 发起、查询挂起至今
    assert.equal(concluded, false, '查询挂起＝未证实：续等不交回（把挂起当无工作是缺陷形态）');
    assert.ok(gates.length >= 1, '复查周期确实发起过查询');
    for (const release of gates) release([]);   // 宿主目录恢复应答：清单空＝无运行中子代理
    const outcome = await pending;
    const wall = Date.now() - started;
    assert.equal(outcome.status, 'no-work', '恢复应答后照常交回（在途周期跳过防线不永久卡死）');
    assert.ok(wall < 1200 + 2500, `恢复后在周期内交回（实耗 ${String(wall)} ms）`);
  } finally {
    await rig.dispose();
  }
});

hostTest('W-OBSERVE-E：账本在册作业运行期间——挂起窗口 listChildren 调用数=0（复查周期账本短路，零目录查询）', async () => {
  resetAgentBaselines();
  let listCalls = 0;
  const rig = await buildRig('obs-e', [{ id: 'at-obs-e-child' }], {
    pollIntervalMs: 100,
    listChildren: async () => { listCalls += 1; return [{ id: 'at-obs-e-child' }]; }
  });
  try {
    const wf = await rig.workflow.execute(WF_ARGS, rig.exec());
    assert.equal(wf.status, 'running', '前置：账本在册的运行中作业提供挂起资格');
    const outcome = await rig.waiter.execute({ wait_ms: 1200 }, rig.exec());
    assert.equal(outcome.status, 'budget', '作业仍在跑：挂起到预算（复查周期全部短路续等）');
    assert.equal(listCalls, 0, '账本在册非终态作业使入口检查与每周期复查都同步短路——零目录查询');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-OBSERVE-F：复查确认资格消失时账本就绪内容随 no-work 出口顺带交付（delivered 在场）', async () => {
  resetAgentBaselines();
  let calls = 0;
  const gates = [];
  const rig = await buildRig('obs-f', [{ id: 'at-obs-f-child' }], {
    pollIntervalMs: 300,
    listChildren: () => new Promise((resolve) => {
      calls += 1;
      if (calls === 1) return resolve([{ id: 'at-obs-f-child' }]);
      gates.push(resolve);
    })
  });
  try {
    // 子代理清单提供挂起资格；首个周期（300 ms）复查查询挂起（gate 在途——主循环
    // 此刻不在竞速里，就绪事件不抢先出口）；在途窗口内经真 workflow 起作业并
    // 结算，账本缓冲就绪后再放行 gate：复查确认无工作 → no-work 出口的批次
    // 顺带携带就绪内容（§2.6 随批顺带交付）。
    const pending = rig.waiter.execute({ wait_ms: 4000 }, rig.exec());
    await sleep(450);
    assert.ok(gates.length >= 1, '前置：复查周期查询已发起且在途');
    const wf = await rig.workflow.execute(WF_ARGS, rig.exec());
    assert.equal(wf.status, 'running', '前置：作业让出为 running');
    rig.finisher();                // 结算 → 保活链读取 → 账本缓冲就绪
    const { ledger } = await import('../lib/delivery.js');
    const readyDeadline = Date.now() + 2000;
    while (Date.now() < readyDeadline) {
      const entry = ledger.jobs.get(wf.job_id);
      if (entry?.terminal !== null && entry?.terminal !== undefined) break;
      await sleep(10);
    }
    assert.notEqual(ledger.jobs.get(wf.job_id)?.terminal ?? null, null, '前置：账本条目已终态（就绪内容在册）');
    for (const release of gates) release([]);   // 复查查询应答：无运行中子代理
    const outcome = await pending;
    assert.equal(outcome.status, 'no-work', '复查确认无工作交回');
    assert.ok((outcome.delivered ?? []).some((row) => row.job_id === wf.job_id),
      '账本就绪内容随 no-work 出口顺带交付（delivered 在场）');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-OBSERVE-G：复查交回不写跨调用基准——再指定该子代理等待得 via.idle 首次确认（非 targetsSettled 维持静止）', async () => {
  resetAgentBaselines();
  let childStatus = 'running';
  const rig = await buildRig('obs-g', [{ id: 'at-obs-g-child' }], {
    pollIntervalMs: 250,
    agentsGet: (id) => ({ id, status: childStatus })
  });
  try {
    const pending = rig.waiter.execute({ wait_ms: 2000 }, rig.exec());
    await sleep(120);
    childStatus = 'idle';          // 静默转 idle：复查经注册表现读观察到静止
    const first = await pending;
    assert.equal(first.status, 'no-work', '前置：无目标复查按 no-work 交回');
    // 周期复查是只读观察、不写 3.2.4 的跨调用登记：随后指定该子代理的等待仍按
    // 「首次确认」交回停止态一次（via.idle 文案）——若复查写了基准，这里会变成
    // 维持静止文案（本断言必红）。
    const second = await rig.waiter.execute(
      { wait_ms: 500, targets: [{ kind: 'agent', id: 'at-obs-g-child' }] },
      rig.exec()
    );
    assert.equal(second.status, 'settled');
    assert.ok(second.note.includes(t('en', 'via.idle')), 'via.idle 首次确认文案在场');
    assert.ok(!second.note.includes(t('en', 'wait.targetsSettled', { ids: 'at-obs-g-child' })), '不得是 targetsSettled 维持静止文案（写基准的形态必红）');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-OBSERVE-H：jobs.list 短路路径后复查不卡死——外来行静默转终态→下一周期 no-work 交回（不耗尽预算）', async () => {
  resetAgentBaselines();
  // 外来（账本不在册）作业在 jobs.list 有 running 行：首个周期复查走第二级同步短路
  //（listChildren 从未发起）。行随后静默转终态＋子代理静默转 idle——复查应在
  // 下一周期确认无工作按 no-work 交回。修复前形态：短路路径不清周期跳过标志，
  // recheckQueryInFlight 永久卡 true，后续复查全部跳过、等待退化到预算到期
  //（盲审实跑复现在案——本断言对旧代码必红）。
  let externalRows = [{ id: 'ext-job-h', status: 'running' }];
  let childStatus = 'running';
  const rig = await buildRig('obs-h', [], {
    pollIntervalMs: 100,
    jobsList: () => externalRows,
    agentsGet: (id) => ({ id, status: childStatus })
  });
  try {
    const started = Date.now();
    const pending = rig.waiter.execute({ wait_ms: 1500 }, rig.exec());
    await sleep(250);               // 首个周期（100 ms 查询周期）已走 jobs.list 短路
    externalRows = [];              // 外来行静默转终态（不经账本、无就绪事件）
    childStatus = 'idle';           // 子代理同步静默转 idle（无消息无通知）
    const outcome = await pending;
    const wall = Date.now() - started;
    assert.equal(outcome.status, 'no-work', '短路后复查继续工作：确认无工作及时交回（卡死形态＝budget，必红）');
    assert.ok(wall < 900, `下一周期即交回、未耗尽预算（pollIntervalMs=100；实耗 ${String(wall)} ms；卡死形态 ≈1500 ms 必红）`);
    assert.ok(outcome.note.includes(t('en', 'wait.workConcluded')), 'note 用 workConcluded 键');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-GATE-A：停止胜出（agent/status 转 idle）＋注册表现读 idle→按现行交付 settled＋跨调用基准写 idle', async () => {
  resetAgentBaselines();
  let childStatus = 'running';
  const rig = await buildRig('gate-a', [{ id: 'at-gate-a-child' }], {
    pollIntervalMs: 200,
    agentsGet: (id) => ({ id, status: childStatus })
  });
  try {
    const pending = rig.waiter.execute(
      { wait_ms: 3000, targets: [{ kind: 'agent', id: 'at-gate-a-child' }] },
      rig.exec()
    );
    await sleep(120);              // 入口屏障与挂起完成
    childStatus = 'idle';          // 注册表静止与 idle 事件同一时刻到达（复核现读即非运行）
    rig.ctx.emit('agent/status', { agent: { id: 'at-gate-a-child' }, status: 'idle' });
    const outcome = await pending;
    assert.equal(outcome.status, 'settled', '非运行读数：停止胜出按现行交付 settled（门放行）');
    assert.ok(outcome.note.includes(t('en', 'note.settled', { agentId: 'at-gate-a-child' })), '现行 settledNote 文案（W-GATE-A 钉现行保持）');
    // 基准写 idle：同目标再次等待 → 全部维持已确认静止 → 立即 targetsSettled 返回。
    const again = await rig.waiter.execute(
      { wait_ms: 3000, targets: [{ kind: 'agent', id: 'at-gate-a-child' }] },
      rig.exec()
    );
    assert.equal(again.status, 'settled');
    assert.ok(again.note.includes(t('en', 'wait.targetsSettled', { ids: 'at-gate-a-child' })), '跨调用基准已写 idle（再等待按维持静止交回）');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-GATE-B：停止胜出＋现读 running→不报 settled、不写登记；一个周期内转 idle→翻转出口 settled、note 注明结算通知已见；等待不因通知提前结束', async () => {
  resetAgentBaselines();
  let childStatus = 'running';
  const rig = await buildRig('gate-b', [{ id: 'at-gate-b-child' }], {
    pollIntervalMs: 200,
    agentsGet: (id) => ({ id, status: childStatus })
  });
  try {
    let concluded = false;
    const pending = rig.waiter.execute(
      { wait_ms: 4000, targets: [{ kind: 'agent', id: 'at-gate-b-child' }] },
      rig.exec()
    );
    pending.then(() => { concluded = true; }, () => { concluded = true; });
    await sleep(120);
    // 停止信号到达但注册表现读仍 running（投影滞后形态）：门拦下——不交付、
    // 不写登记、标记续等。
    rig.ctx.emit('agent/status', { agent: { id: 'at-gate-b-child' }, status: 'idle' });
    await sleep(150);
    assert.equal(concluded, false, '注册表仍观察到运行：不报 settled（通知本身不结束等待）');
    childStatus = 'idle';          // ≤一个周期内注册表翻转
    const outcome = await pending;
    assert.equal(outcome.status, 'settled', '翻转出口交付 settled（via.idle 首次确认）');
    assert.ok(outcome.note.includes(t('en', 'via.idle')), '翻转出口的 via.idle 文案');
    assert.ok(outcome.note.includes(t('en', 'via.settleNoticeSeen')), 'note 前缀注明结算通知已见（标记兑现）');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-GATE-C：门后目标维持运行→到期按 running 交回＋目标已证状态＋settleNoticePending 说明（不误报静止）', async () => {
  resetAgentBaselines();
  const rig = await buildRig('gate-c', [{ id: 'at-gate-c-child' }], {
    pollIntervalMs: 200,
    agentsGet: (id) => ({ id, status: 'running' })
  });
  try {
    const pending = rig.waiter.execute(
      { wait_ms: 700, targets: [{ kind: 'agent', id: 'at-gate-c-child' }] },
      rig.exec()
    );
    await sleep(120);
    rig.ctx.emit('agent/status', { agent: { id: 'at-gate-c-child' }, status: 'idle' });
    const outcome = await pending;
    assert.equal(outcome.status, 'running', '静止未证实：到期按运行口径交回（不交 settled）');
    assert.ok((outcome.targets ?? []).some((row) => row.id === 'at-gate-c-child' && row.status === 'running'),
      '目标已证状态附 running');
    assert.ok(outcome.note.includes(t('en', 'wait.settleNoticePending', { ids: 'at-gate-c-child' })), '到期附 settleNoticePending 说明（通知已见、静止未证实）');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-GATE-D：注册表读取抛错（unknown）→不制造 settled；到期未证实档＋标记说明', async () => {
  resetAgentBaselines();
  const rig = await buildRig('gate-d', [{ id: 'at-gate-d-child' }], {
    pollIntervalMs: 200,
    agentsGet: () => { throw new Error('registry down'); }
  });
  try {
    const pending = rig.waiter.execute(
      { wait_ms: 700, targets: [{ kind: 'agent', id: 'at-gate-d-child' }] },
      rig.exec()
    );
    await sleep(120);
    rig.ctx.emit('agent/status', { agent: { id: 'at-gate-d-child' }, status: 'idle' });
    const outcome = await pending;
    assert.equal(outcome.status, 'running', '读取失败不制造停止：到期按有目标口径交回');
    assert.ok((outcome.targets ?? []).some((row) => row.id === 'at-gate-d-child' && row.status === 'unknown'),
      '目标已证状态为 unknown（未证实档）');
    assert.ok(outcome.note.includes(t('en', 'wait.settleNoticePending', { ids: 'at-gate-d-child' })), '标记说明在场');
  } finally {
    await rig.dispose();
  }
});

hostTest('W-GATE-E：入口未领取结算通知同门现读——running→changed＋settleNoticeArrived；idle→现行 settled', async () => {
  resetAgentBaselines();
  const seedNotice = (rig) => rig.parent.inbox.nextStep.push(
    inboxPayload({
      agent: rig.parent, sourceKind: 'subagent-settled', form: 'notice',
      summary: 'child settled', senderSessionId: 'at-gate-e-child', target: 'next-step'
    })
  );
  {
    const rig = await buildRig('gate-e-run', [{ id: 'at-gate-e-child' }], {
      agentsGet: (id) => ({ id, status: 'running' })
    });
    try {
      seedNotice(rig);
      const outcome = await rig.waiter.execute(
        { wait_ms: 600, targets: [{ kind: 'agent', id: 'at-gate-e-child' }] },
        rig.exec()
      );
      assert.equal(outcome.status, 'changed', '通知已到、静止未证实：按变化交回（不作停止断言）');
      assert.ok(outcome.note.includes(t('en', 'wait.settleNoticeArrived')), 'settleNoticeArrived 文案在场');
    } finally {
      await rig.dispose();
    }
  }
  {
    const rig = await buildRig('gate-e-idle', [{ id: 'at-gate-e-child' }], {
      agentsGet: (id) => ({ id, status: 'idle' })
    });
    try {
      seedNotice(rig);
      const outcome = await rig.waiter.execute(
        { wait_ms: 600, targets: [{ kind: 'agent', id: 'at-gate-e-child' }] },
        rig.exec()
      );
      assert.equal(outcome.status, 'settled', '非运行读数：入口通知按现行 settled 交付');
      assert.ok(outcome.note.includes(t('en', 'via.noticePreexisting')), '现行 via.noticePreexisting 文案');
    } finally {
      await rig.dispose();
    }
  }
});

hostTest('W-GATE-F：同目标重复未证实复核事件不提前按到期交回（wall≈预算，自旋防线不触发）', async () => {
  resetAgentBaselines();
  const rig = await buildRig('gate-f', [{ id: 'at-gate-f-child' }], {
    pollIntervalMs: 250,
    agentsGet: (id) => ({ id, status: 'running' })
  });
  try {
    const started = Date.now();
    const pending = rig.waiter.execute(
      { wait_ms: 1500, targets: [{ kind: 'agent', id: 'at-gate-f-child' }] },
      rig.exec()
    );
    await sleep(120);
    // 变异注释（W-GATE-F）：复核未证实分支若不重建观察器（直接 continue），已 resolve
    // 的一次性 settled promise 会被下一轮竞速再次胜出——每轮微任务复用、自旋
    // 计数暴涨，在本预算内提前按到期口径交回（wall 断言必红）。
    for (let i = 0; i < 25; i += 1) {
      rig.ctx.emit('agent/status', { agent: { id: 'at-gate-f-child' }, status: 'idle' });
      await sleep(20);
    }
    const outcome = await pending;
    const wall = Date.now() - started;
    assert.equal(outcome.status, 'running', '重复未证实事件不误报停止：到期口径交回');
    assert.ok(wall >= 1350, `不提前交回（wall≈预算 1500；实耗 ${String(wall)} ms）——重建观察器防自旋`);
  } finally {
    await rig.dispose();
  }
});

hostTest('W-SPIN-A：MAX_SPINS 可测锚——注入小上限后超过上限次数的定时周期续排不提前交回（定时周期胜者不计入计数）', async () => {
  resetAgentBaselines();
  const original = WAIT_SPIN_LIMIT.value;
  WAIT_SPIN_LIMIT.value = 3;
  try {
    const rig = await buildRig('spin-a', [{ id: 'at-spin-a-child' }], {
      pollIntervalMs: 50,
      agentsGet: (id) => ({ id, status: 'running' })
    });
    try {
      const started = Date.now();
      // 变异注释（W-SPIN-A）：若定时周期胜者仍计入 spins（旧计数形态——备用轮询周期
      // 曾无条件计入），第 4 个周期（约 200 ms）即触发防线、提前按到期口径交回，
      // wall 断言（≥570 ms）必红。
      const outcome = await rig.waiter.execute(
        { wait_ms: 600, targets: [{ kind: 'agent', id: 'at-spin-a-child' }] },
        rig.exec()
      );
      const wall = Date.now() - started;
      assert.equal(outcome.status, 'running', '到期口径交回（防线未触发）');
      assert.ok(wall >= 570, `12 个周期（600/50）远超注入上限 3 仍不提前交回（实耗 ${String(wall)} ms）`);
    } finally {
      await rig.dispose();
    }
  } finally {
    WAIT_SPIN_LIMIT.value = original;
  }
});

// ═══ REL-LIFECYCLE-01：行级归属的账本回收（设计 r14 §2）═══
//
// 测试纪律（本批头注）：L1/L8 是受控反例——先在未修代码上证明红（行卸载
// effect 对每行调 disposeAll），修后绿；激励直接落在被测单元（账本 API 与
// applyWith 装载链），替身只替换装载边界（ctx.on/ctx.tools.register/ctx.effect）。
// 条目内字段（buffer/terminal/deliveredFact）经公开 API 无法到达的形态直接
// 构造在条目上——被测的是 disposeRow 的账目归属，不是字段构造路径。

hostTest('L1 查询行卸载不清其他行的交付账目（REL-LIFECYCLE-01 受控反例）', () => {
  resetDeliveryLedger();
  const queryCtx = { label: 'query-row' };
  const runCtx = { label: 'run-row' };
  ledger.registerRow(queryCtx);
  ledger.registerRow(runCtx);
  ledger.noteJobStarted(runCtx, {}, 'job-l1', 'owner-l1');
  ledger.noteFirstWaitArmed('job-l1', 1000);
  const chain = ledger.jobs.get('job-l1').chain;
  // 修前形态：行卸载调 disposeAll——记录 1→0、链被撤（本例红）。
  ledger.disposeRow(queryCtx);
  assert.equal(ledger.jobs.size, 1, '查询行不创建条目，其卸载不得清他行作业');
  assert.ok(ledger.jobs.has('job-l1'), '生产者行的作业记录仍在');
  assert.ok(chain !== null && !chain.signal.signal.aborted, '他行作业的保活链在册未撤');
  assert.equal(ledger.rowsCount(), 1, '生产者行仍在册（查询行已出册）');
});

hostTest('L2 生产者行卸载只清本行条目：他行三种形态逐字段原样', () => {
  resetDeliveryLedger();
  const ctxA = { label: 'row-a' };
  const ctxB = { label: 'row-b' };
  ledger.registerRow(ctxA);
  ledger.registerRow(ctxB);
  // B 形态一：活动作业＋已武装保活链。
  ledger.noteJobStarted(ctxB, {}, 'job-b1', 'sub-b');
  ledger.noteFirstWaitArmed('job-b1', 2000);
  const b1 = ledger.jobs.get('job-b1');
  // B 形态二：已结算未交付缓冲（截断＋留存路径）。
  ledger.noteJobStarted(ctxB, {}, 'job-b2', 'sub-b');
  const b2 = ledger.jobs.get('job-b2');
  b2.buffer = '正文前段……后段';
  b2.lossy = true;
  b2.spillPaths = ['/tmp/at-spill.txt'];
  b2.terminal = { status: 'completed', exitCode: 0, signal: null, detail: null };
  b2.readyAt = 12345;
  // B 形态三：partial 交付事实＋仍在缓冲的省略中段。
  ledger.noteJobStarted(ctxB, {}, 'job-b3', 'sub-b');
  const b3 = ledger.jobs.get('job-b3');
  b3.buffer = '省略中段原文';
  b3.deliveredFact = { via: 'message', partial: true };
  // A 作业（活动＋武装链）——卸载 A 应撤它的链、删它的条目。
  ledger.noteJobStarted(ctxA, {}, 'job-a1', 'sub-a');
  ledger.noteFirstWaitArmed('job-a1', 2000);
  const a1Chain = ledger.jobs.get('job-a1').chain;
  ledger.disposeRow(ctxA);
  assert.ok(!ledger.jobs.has('job-a1'), 'A 的条目消失');
  assert.ok(a1Chain.signal.signal.aborted, 'A 的保活链撤销（abort 信号置位）');
  assert.ok(ledger.jobs.has('job-b1') && ledger.jobs.get('job-b1') === b1, 'B1 条目原对象保留');
  assert.ok(b1.chain !== null && !b1.chain.signal.signal.aborted, 'B1 保活链未被误撤');
  assert.ok(ledger.jobs.has('job-b2') && ledger.jobs.get('job-b2') === b2, 'B2 条目原对象保留');
  assert.equal(b2.buffer, '正文前段……后段', 'B2 未交付缓冲原样');
  assert.equal(b2.lossy, true, 'B2 截断标记原样');
  assert.deepEqual(b2.spillPaths, ['/tmp/at-spill.txt'], 'B2 留存路径原样');
  assert.deepEqual(b2.terminal, { status: 'completed', exitCode: 0, signal: null, detail: null }, 'B2 终态事实原样');
  assert.equal(b2.readyAt, 12345, 'B2 就绪时刻原样');
  assert.ok(ledger.jobs.has('job-b3') && ledger.jobs.get('job-b3') === b3, 'B3 条目原对象保留');
  assert.equal(b3.buffer, '省略中段原文', 'B3 省略中段仍在缓冲');
  assert.deepEqual(b3.deliveredFact, { via: 'message', partial: true }, 'B3 partial 交付事实原样');
  assert.equal(ledger.rowsCount(), 1, '仅 B 在册');
});

hostTest('L3 跨预设形态：两个预设行的条目按行隔离', () => {
  resetDeliveryLedger();
  const ctxP1 = { label: 'preset-async-row' };
  const ctxP2 = { label: 'preset-async-create-row' };
  ledger.registerRow(ctxP1);
  ledger.registerRow(ctxP2);
  ledger.noteJobStarted(ctxP1, { owningPreset: 'dsh-async' }, 'job-p1', 'sub-x');
  ledger.noteFirstWaitArmed('job-p1', 2000);
  ledger.noteJobStarted(ctxP2, { owningPreset: 'dsh-async-create' }, 'job-p2', 'sub-x');
  ledger.jobs.get('job-p2').buffer = 'p2 未交付缓冲';
  ledger.disposeRow(ctxP1);
  assert.ok(!ledger.jobs.has('job-p1'), '预设 A 行条目清');
  assert.ok(ledger.jobs.has('job-p2'), '预设 B 行条目保留');
  assert.equal(ledger.jobs.get('job-p2').buffer, 'p2 未交付缓冲', '预设 B 行缓冲保留');
  assert.equal(ledger.rowsCount(), 1, '预设 B 行仍在册');
});

hostTest('L4 全部行卸载后账本全空（对齐原 disposeAll 行为）', () => {
  resetDeliveryLedger();
  const ctxA = { on: () => () => {} };
  const ctxB = { on: () => () => {} };
  const ctxQ = {};
  ledger.registerRow(ctxA);
  ledger.registerRow(ctxB);
  ledger.registerRow(ctxQ);
  ledger.attachClaimedListener(ctxA);
  ledger.attachClaimedListener(ctxB);
  ledger.noteJobStarted(ctxA, {}, 'job-a', 'sub-a');
  ledger.noteJobStarted(ctxB, {}, 'job-b', 'sub-b');
  ledger.claimWait('sub-a');
  // 镜像 index.js 卸载次序：先撤本行 claimed 监听，再行级清扫。
  for (const ctx of [ctxA, ctxB, ctxQ]) {
    ledger.claimedDisposers.get(ctx)?.();
    ledger.disposeRow(ctx);
  }
  assert.equal(ledger.jobs.size, 0, '作业全空');
  assert.equal(ledger.subjects.size, 0, '主体全空');
  assert.equal(ledger.claimedDisposers.size, 0, 'claimed 监听全撤');
  assert.equal(ledger.rowsCount(), 0, '在册行集合全空');
});

hostTest('L5 末行判定：只剩查询行在册时卸载之触发整体释放', () => {
  resetDeliveryLedger();
  const runCtx = {};
  const queryCtx = {};
  ledger.registerRow(runCtx);
  ledger.registerRow(queryCtx);
  ledger.noteJobStarted(runCtx, {}, 'job-l5', 'sub-l5');
  ledger.disposeRow(runCtx);
  // 生产者行先卸：作业已清，但查询行仍在册——不整体释放（subjects 可能残留）。
  ledger.claimWait('sub-l5');
  assert.ok(ledger.subjects.size > 0, '查询行在册时不整体释放（主体记录保留）');
  ledger.disposeRow(queryCtx);
  assert.equal(ledger.rowsCount(), 0, '末行出册');
  assert.equal(ledger.subjects.size, 0, '末行卸载触发整体释放（主体清空）');
  assert.equal(ledger.jobs.size, 0, '整体释放后作业为空');
});

hostTest('L7 行卸载撤本行作业保活链：abort 信号置位', () => {
  resetDeliveryLedger();
  const ctx = {};
  ledger.registerRow(ctx);
  ledger.noteJobStarted(ctx, {}, 'job-l7', 'sub-l7');
  ledger.noteFirstWaitArmed('job-l7', 1000);
  const chain = ledger.jobs.get('job-l7').chain;
  ledger.disposeRow(ctx);
  assert.ok(chain.signal.signal.aborted, 'detachJob 撤链＝abort 置位（宿主在册 waiter 抑制解除）');
  assert.equal(ledger.jobs.size, 0, '条目删除');
});

hostTest('L8 挂监听失败的行不因他行卸载被整体释放（M2 反例）', () => {
  resetDeliveryLedger();
  // Rf：attachClaimedListener 内 ctx.on 抛错 → 返回空函数、不占 claimedDisposers
  // 键，但 registerRow 已登记、其作业与缓存在册。
  const rfCtx = {
    on: (event) => {
      if (event === 'agent/inbox/claimed') throw new Error('rf ctx.on refused');
      return () => {};
    }
  };
  const rfDispose = ledger.attachClaimedListener(rfCtx);
  assert.equal(typeof rfDispose, 'function', '失败形态返回可调用空函数');
  assert.equal(ledger.claimedDisposers.size, 0, '挂失败的行不占 claimedDisposers 键');
  ledger.registerRow(rfCtx);
  ledger.noteJobStarted(rfCtx, {}, 'job-rf', 'sub-rf');
  ledger.jobs.get('job-rf').buffer = 'rf 未交付缓冲';
  // R2：正常行（在册、有作业、有 claimed 监听）。
  const r2Ctx = { on: () => () => {} };
  ledger.attachClaimedListener(r2Ctx);
  ledger.registerRow(r2Ctx);
  ledger.noteJobStarted(r2Ctx, {}, 'job-r2', 'sub-r2');
  // 卸载 R2（镜像 index.js 次序）：若末行判定按 claimedDisposers 推断，此刻
  // 键数为 0 会误触发整体释放、删掉 Rf 的在册作业（本例红）。
  ledger.claimedDisposers.get(r2Ctx)?.();
  ledger.disposeRow(r2Ctx);
  assert.ok(ledger.jobs.has('job-rf'), '挂监听失败行的作业保留');
  assert.equal(ledger.jobs.get('job-rf').buffer, 'rf 未交付缓冲', '挂监听失败行的缓冲保留');
  assert.equal(ledger.rowsCount(), 1, '仅 Rf 在册');
  // 最后卸载 Rf：真正的末行，整体释放。
  ledger.disposeRow(rfCtx);
  assert.equal(ledger.rowsCount(), 0, '末行出册');
  assert.equal(ledger.jobs.size, 0, '整体释放');
});

/**
 * 装载边界替身：只替换 ctx.on / ctx.tools.register / ctx.effect 三个装载点。
 * `refuseEvents` 让指定事件的 ctx.on 抛错（选定装载中途抛错的时点）；
 * `refuseRegister` 让工具注册抛错。`state` 记录注册/撤销/事件/卸载体收支。
 */
function rowRig(options = {}) {
  const state = { registered: [], unregistered: [], effectDisposers: [], onCalls: [] };
  const ctx = {
    effect(fn) { state.effectDisposers.push(fn()); },
    on(event, listener) {
      if (options.refuseEvents?.includes(event)) throw new Error(`rowRig ctx.on refused ${event}`);
      const entry = { event, off: false };
      state.onCalls.push(entry);
      return () => { entry.off = true; };
    },
    tools: {
      register(tool) {
        if (options.refuseRegister === true) throw new Error('rowRig tools.register refused');
        state.registered.push(tool.name);
        return () => { state.unregistered.push(tool.name); };
      }
    },
    logger: { info() {}, warn() {} }
  };
  return { ctx, state };
}

/** 依 cordis 卸载语义执行全部已注册 effect 的卸载体。 */
const runRowDisposers = (state) => { for (const dispose of state.effectDisposers) dispose(); };

hostTest('L9 装载中途抛错：行注销恒执行、已就位处置器执行、未就位跳过（三时点）', async () => {
  // 时点一（早期）：未知 toolName——五个清理项全未就位，仅撤行登记。schema 的
  // toolName 枚举在 resolveConfig 内先拒（ValidationError，`applyWith` 的未知
  // 名检查是同判据的纵深防线）；本时点考察的是「抛错后卸载体的收支」，两种
  // 抛错文案都属早期形。
  resetDeliveryLedger();
  const rig1 = rowRig();
  assert.throws(() => applyRow(rig1.ctx, { toolName: 'async_nope' }), /toolName/, '未知 toolName 抛错');
  assert.equal(ledger.rowsCount(), 1, '抛错后行仍在册（cordis 卸载前）');
  runRowDisposers(rig1.state);
  assert.equal(ledger.rowsCount(), 0, '卸载体执行后行出册（在册集合无泄漏）');
  assert.equal(rig1.state.registered.length, 0, '早期形零工具注册');
  assert.equal(rig1.state.onCalls.length, 0, '早期形零监听（五清理项全跳过）');
  assert.equal(ledger.claimedDisposers.size, 0, 'claimed 无残留');

  // 时点一（早期，另一形）：resolveConfig 跨字段违例抛错——同档断言。
  resetDeliveryLedger();
  const rig1b = rowRig();
  assert.throws(() => applyRow(rig1b.ctx, {
    toolName: 'async_run', settings: { minYieldMs: 30000, maxYieldMs: 25000 }
  }), /minYieldMs(?:=\d+)? > maxYieldMs/, '跨字段违例在 resolveConfig 抛错（容忍自检回调与 assertCrossFieldOrder 两种文案）');
  runRowDisposers(rig1b.state);
  assert.equal(ledger.rowsCount(), 0, '行出册无泄漏');
  assert.equal(rig1b.state.onCalls.length, 0, 'resolveConfig 形同样零监听');

  // 时点二（工具注册点抛错；设计「工厂调用形」的替身实现——工厂构造对替身
  // 无可注入抛错点，注册点是首个可达的同档时点：hide 监听已赋值、零工具注册）。
  resetDeliveryLedger();
  const rig2 = rowRig({ refuseRegister: true });
  assert.throws(() => applyRow(rig2.ctx, { toolName: 'async_run' }), /rowRig tools.register refused/, '工具注册抛错');
  runRowDisposers(rig2.state);
  assert.equal(ledger.rowsCount(), 0, '行出册无泄漏');
  assert.equal(rig2.state.registered.length, 0, '零工具注册');
  const hide2 = rig2.state.onCalls.find((entry) => entry.event === 'agent/created');
  assert.ok(hide2 !== undefined && hide2.off === true, '已就位的 job_output 隐藏监听照常撤销');
  assert.ok(rig2.state.onCalls.every((entry) => entry.event !== 'agent/inbox/claimed'),
    'claimed 监听未就位（不误撤）');
  assert.equal(ledger.claimedDisposers.size, 0, 'claimed 无残留');

  // 时点三（tools.register 之后的接线步抛错：provider 事件监听拒绝）——最多
  // 处置器就位的形：工具注销、两类监听撤销、行出册、重装载回 1。
  resetDeliveryLedger();
  const rig3 = rowRig({ refuseEvents: ['subagent/provider-added'] });
  assert.throws(
    () => applyRow(rig3.ctx, { toolName: 'async_run' }),
    /rowRig ctx.on refused subagent\/provider-added/,
    '装载尾段抛错'
  );
  runRowDisposers(rig3.state);
  assert.equal(ledger.rowsCount(), 0, '行出册无泄漏');
  assert.deepEqual(rig3.state.unregistered, ['async_run'], '已注册工具被注销');
  assert.ok(rig3.state.onCalls.filter((entry) => entry.off).length
    === rig3.state.onCalls.length, '全部已挂监听被撤销');
  assert.equal(ledger.claimedDisposers.size, 0, 'claimed 无残留');
  const rig3b = rowRig();
  applyRow(rig3b.ctx, { toolName: 'async_run' });
  assert.equal(ledger.rowsCount(), 1, '同 toolName 再次装载成功（在册数回 1）');
  runRowDisposers(rig3b.state);
  assert.equal(ledger.rowsCount(), 0, '收尾：替身行出册');
});

// ═══ REL-SEND-01：部分投递失败的精确回滚边界（设计 r14 §3）═══
//
// S1 是受控反例：修前 #flushPendingSends 的 catch 对整个 queue 回滚（含宿主
// 已接受的条目）——第二次 inject 抛错后两项正文都重现。驱动走公开链路：
// claimWait 压住活等待 → readSettled 逐项就绪（不投）→ releaseWait 让位复查
// 逐条 deferFlush 装配后**单次冲刷**（多元素队列的成例路径，delivery.js 的
// releaseWait）。替身只替换装载边界：agents 注册表（可抛错的 inject/followup）
// 与 jobs 读取（list/read 形状与宿主契约一致）。

/**
 * S 系列装置：一个主体的假 Agent（busy→逐条 inject；idle→单条 followup）＋
 * 受控 jobs 读取。`injectFailsAt`＝第 N 次 inject 抛错（0＝永不）；
 * `followupThrows`＝followup 抛错；`agentsGet` 可整替（注册表缺失形）。
 */
function sRig({ injectFailsAt = 0, followupThrows = false, agentsGet, budget = 4000, lang = 'en', status = 'running' } = {}) {
  resetDeliveryLedger();
  const calls = { inject: [], followup: [] };
  const OWNER = 'at-s-owner';
  const agent = {
    id: OWNER,
    status,
    inject(message) {
      calls.inject.push(message);
      if (calls.inject.length === injectFailsAt) {
        throw new Error(`inject #${String(calls.inject.length)} refused`);
      }
    },
    followup(message) {
      calls.followup.push(message);
      if (followupThrows) throw new Error('followup refused');
    }
  };
  const reads = new Map();
  const config = Object.freeze({ maxResultChars: budget, agentLang: lang });
  // T 系列：登记行可携带终态事实（killed/退出码/信号/诊断）与读取回执附注
  //（lossy／留存路径）——readSettled 的终态自证分支从 list 行取事实。
  const rowFacts = new Map();
  const ctx = {
    emit() {},
    get: (name) => (name === 'agents'
      ? { get: (id) => (agentsGet !== undefined ? agentsGet(id) : (id === OWNER ? agent : undefined)) }
      : undefined),
    jobs: {
      list: () => [...reads.keys()].map((id) => ({
        id,
        status: 'completed',
        exitCode: 0,
        ...(rowFacts.get(id) ?? {})
      })),
      read: async (jobId) => reads.get(jobId)
    }
  };
  ledger.registerRow(ctx);
  /** 登记一个已就绪（终态＋增量已读）的作业；facts 并入注册表行，readExtras 并入读取回执。 */
  const readyJob = async (jobId, text, facts, readExtras) => {
    reads.set(jobId, { chunks: [{ channel: 'stdout', text }], ...(readExtras ?? {}) });
    if (facts !== undefined) rowFacts.set(jobId, facts);
    ledger.noteJobStarted(ctx, config, jobId, OWNER);
    await ledger.readSettled(jobId);
  };
  return { agent, calls, OWNER, config, ctx, reads, readyJob };
}

/** 装置产出的消息正文（inject/followup 的 content 拼接）。 */
const textOf = (message) => message.content.map((part) => part.text).join('');

hostTest('S1 部分失败只回滚失败项：已接受项不重现（REL-SEND-01 受控反例）', async () => {
  const rig = sRig({ injectFailsAt: 2 });
  const token = ledger.claimWait(rig.OWNER);
  await rig.readyJob('job-s1a', 'BODY-S1-A');
  await rig.readyJob('job-s1b', 'BODY-S1-B');
  await ledger.releaseWait(token, rig.OWNER);
  // 两次 inject 尝试：第一项被宿主接受，第二项抛错。
  assert.equal(rig.calls.inject.length, 2, 'inject 恰尝试两次（第一项成功、第二项抛错）');
  const firstTexts = rig.calls.inject.map(textOf);
  assert.ok(firstTexts[0].includes('BODY-S1-A'), '第一项正文已投递');
  assert.equal(firstTexts.filter((text) => text.includes('BODY-S1-A')).length, 1,
    '第一项恰投递一次（重复交付计数 1）');
  // 修前形态：catch 对整队回滚——两项都退回缓冲，随后重现（本例红）。
  const a = ledger.jobs.get('job-s1a');
  const b = ledger.jobs.get('job-s1b');
  assert.ok(a.deliveredFact !== null, '已接受项保持交付事实（不回滚）');
  assert.equal(a.buffer, '', '已接受项缓冲为空');
  assert.ok(b.deliveredFact === null && b.claimedBy === null, '失败项认领撤销');
  assert.ok(String(b.buffer).includes('BODY-S1-B'), '失败项正文退回缓冲');
});

hostTest('S2 失败项为截断条目：回滚按装配前原文退缓冲（中段不丢）', async () => {
  // 批预算 25：第一项 9 字符整体装入（余 16），第二项 316 字符被裁剪为
  // 首尾保留（truncated，original＝316 字符装配前原文）。第二项 inject 失败。
  const long = `HEAD-${'m'.repeat(300)}-TAIL`;
  const rig = sRig({ injectFailsAt: 2, budget: 25 });
  const token = ledger.claimWait(rig.OWNER);
  await rig.readyJob('job-s2a', 'BODY-S2-A');
  await rig.readyJob('job-s2b', long);
  await ledger.releaseWait(token, rig.OWNER);
  assert.equal(rig.calls.inject.length, 2, '前置：恰两次 inject 尝试');
  const a = ledger.jobs.get('job-s2a');
  const b = ledger.jobs.get('job-s2b');
  assert.ok(a.deliveredFact !== null, '第一项（整体装入）保持交付');
  assert.ok(b.deliveredFact === null && b.claimedBy === null, '截断的失败项认领撤销');
  assert.equal(b.buffer, long, '失败项按装配前原文整体退回缓冲（省略中段不丢）');
  // 投出的截断文本确属首尾形（而非误投原文或空投）。
  const sentB = textOf(rig.calls.inject[1]);
  assert.ok(sentB.includes('HEAD-') && sentB.includes('-TAIL'), '截断条目首尾都在');
  assert.ok(!sentB.includes('m'.repeat(50)), '截断条目中段确实被省略');
});

hostTest('S3 失败项重试：换不抛错的通道后只补投失败项，已投项不再出现', async () => {
  const rig = sRig({ injectFailsAt: 2 });
  const token = ledger.claimWait(rig.OWNER);
  await rig.readyJob('job-s3a', 'BODY-S3-A');
  await rig.readyJob('job-s3b', 'BODY-S3-B');
  await ledger.releaseWait(token, rig.OWNER);
  assert.equal(rig.calls.inject.length, 2, '前置：第二项失败');
  // 换通道重试：不再抛错（injectFailsAt 已耗过）。
  const token2 = ledger.claimWait(rig.OWNER);
  await ledger.releaseWait(token2, rig.OWNER);
  const all = rig.calls.inject.map(textOf);
  assert.equal(all.filter((text) => text.includes('BODY-S3-A')).length, 1, '第一项不再出现（恰一次）');
  // calls 记录的是「尝试」：BODY-S3-B 共两次＝一次失败尝试＋一次成功补投；
  // 成功补投是最后一次调用（此前失败项已退缓冲、此处才置交付事实）。
  assert.equal(all.filter((text) => text.includes('BODY-S3-B')).length, 2,
    '第二项：一次失败尝试＋一次成功补投（不更多）');
  assert.ok(all.at(-1).includes('BODY-S3-B'), '最后一次 inject 是失败项的成功补投');
  const b = ledger.jobs.get('job-s3b');
  assert.ok(b.deliveredFact !== null, '失败项重试后置交付事实');
  assert.equal(b.buffer, '', '补投后缓冲清空');
});

hostTest('S4 失败位置扫描：首/中/末项失败三形只回滚失败项及其后', async () => {
  for (const failsAt of [1, 2, 3]) {
    const rig = sRig({ injectFailsAt: failsAt });
    const token = ledger.claimWait(rig.OWNER);
    await rig.readyJob('job-s4a', 'BODY-S4-A');
    await rig.readyJob('job-s4b', 'BODY-S4-B');
    await rig.readyJob('job-s4c', 'BODY-S4-C');
    await ledger.releaseWait(token, rig.OWNER);
    const delivered = ['job-s4a', 'job-s4b', 'job-s4c']
      .filter((id) => ledger.jobs.get(id).deliveredFact !== null);
    // 队列按 Map 迭代序＝a,b,c：第 k 项失败 ⇒ 前 k-1 项交付、其余回滚。
    const expected = failsAt === 1 ? [] : failsAt === 2 ? ['job-s4a'] : ['job-s4a', 'job-s4b'];
    assert.deepEqual(delivered.sort(), expected, `inject 第 ${String(failsAt)} 项失败：仅其前保持交付`);
    assert.equal(rig.calls.inject.length, failsAt, `恰尝试到失败项（第 ${String(failsAt)} 次）`);
  }
});

hostTest('S5 空闲路径原子不变：合并 followup 抛错整队回滚', async () => {
  const rig = sRig({ followupThrows: true });
  rig.agent.status = 'idle';
  const token = ledger.claimWait(rig.OWNER);
  await rig.readyJob('job-s5a', 'BODY-S5-A');
  await rig.readyJob('job-s5b', 'BODY-S5-B');
  await ledger.releaseWait(token, rig.OWNER);
  assert.equal(rig.calls.followup.length, 1, '单条合并 followup（空闲路径）');
  for (const id of ['job-s5a', 'job-s5b']) {
    const entry = ledger.jobs.get(id);
    assert.ok(entry.deliveredFact === null && entry.claimedBy === null, `${id} 认领撤销`);
    assert.notEqual(entry.buffer, '', `${id} 正文退回缓冲（整队回滚语义不变）`);
  }
});

hostTest('S6 并发冲刷互不波及：A 队失败回滚不碰 B 队已投项', async () => {
  // 两个主体各自独立冲刷：A 的第二项 inject 抛错，B 全部成功。
  const rigA = sRig({ injectFailsAt: 2 });
  const tokenA = ledger.claimWait(rigA.OWNER);
  await rigA.readyJob('job-s6a1', 'BODY-S6-A1');
  await rigA.readyJob('job-s6a2', 'BODY-S6-A2');
  const OWNER_B = 'at-s-owner-b';
  const agentB = {
    id: OWNER_B,
    status: 'running',
    inject(message) { this.calls.push(message); },
    calls: []
  };
  // B 主体：独立 ctx（agents 只认 B 的注册表项）。
  const readsB = new Map();
  const ctxB = {
    emit() {},
    get: (name) => (name === 'agents' ? { get: (id) => (id === OWNER_B ? agentB : undefined) } : undefined),
    jobs: {
      list: () => [...readsB.keys()].map((id) => ({ id, status: 'completed', exitCode: 0 })),
      read: async (jobId) => readsB.get(jobId)
    }
  };
  ledger.registerRow(ctxB);
  const tokenB = ledger.claimWait(OWNER_B);
  const readyB = async (jobId, text) => {
    readsB.set(jobId, { chunks: [{ channel: 'stdout', text }] });
    ledger.noteJobStarted(ctxB, rigA.config, jobId, OWNER_B);
    await ledger.readSettled(jobId);
  };
  await readyB('job-s6b1', 'BODY-S6-B1');
  await readyB('job-s6b2', 'BODY-S6-B2');
  // 「同一领取窗口」两冲刷：先后触发（取队列到投递间无 await 交错面，见设计 §3.4）。
  await ledger.releaseWait(tokenA, rigA.OWNER);
  await ledger.releaseWait(tokenB, OWNER_B);
  assert.equal(agentB.calls.length, 2, 'B 队两项全部投递成功');
  for (const id of ['job-s6b1', 'job-s6b2']) {
    assert.ok(ledger.jobs.get(id).deliveredFact !== null, `${id}（B 队）交付事实保持`);
  }
  assert.ok(ledger.jobs.get('job-s6a1').deliveredFact !== null, 'A 队第一项保持交付');
  assert.ok(ledger.jobs.get('job-s6a2').deliveredFact === null, 'A 队失败项按预期回滚');
});

hostTest('S7 注册表缺失分支回归：整队回滚行为不变', async () => {
  const rig = sRig({ agentsGet: () => undefined });
  const token = ledger.claimWait(rig.OWNER);
  await rig.readyJob('job-s7a', 'BODY-S7-A');
  await rig.readyJob('job-s7b', 'BODY-S7-B');
  await ledger.releaseWait(token, rig.OWNER);
  assert.equal(rig.calls.inject.length, 0, '注册表缺失：零通道调用');
  for (const id of ['job-s7a', 'job-s7b']) {
    const entry = ledger.jobs.get(id);
    assert.ok(entry.deliveredFact === null, `${id} 整队回滚（registry miss 语义不变）`);
    assert.notEqual(entry.buffer, '', `${id} 正文退回缓冲`);
  }
});

// ═══ r15 验收缺陷：认领生命周期／读取失败注记／条目上限（受控回归）═══
//
// REC 系列（lib/delivery.js 的 ledger 级回归，REL-RECOVER-02／REL-READ-02／
// REL-SEND-02／REL-BATCH-02）：全部走 sRig 的受控通道（busy＝逐条 inject），
// 等待出口的批语义经 claimWait/releaseWait/closeBatchIfIdle 显式驱动——
// closeBatchIfIdle 即「等待返回全部提交后的关批判定」，关批后恢复全额批预算。

hostTest('REC-A：完成消息载体 partial——认领在接受点释放，关批后续段整条领取、不重发首尾、不重读宿主（REL-RECOVER-02）', async () => {
  const rig = sRig({ budget: 8 });
  const { truncate, omittedMiddle } = await import('../lib/output.js');
  const readCalls = [];
  const realRead = rig.ctx.jobs.read;
  rig.ctx.jobs.read = async (jobId) => { readCalls.push(jobId); return realRead(jobId); };
  // 结算读取成功且无活等待 ⇒ readSettled 内即走完成消息路径（预算 8 < 正文 12
  // ⇒ 截断交付：首尾保留，中段留缓冲）。
  await rig.readyJob('job-rec-a', 'ABCDEFGHIJKL');
  assert.equal(rig.calls.inject.length, 1, '完成消息恰一条（忙通道逐条 inject）');
  const first = textOf(rig.calls.inject[0]);
  assert.match(first, /job-rec-a/, '状态行在场');
  const entry = ledger.jobs.get('job-rec-a');
  // 认领生命周期（REL-RECOVER-02）：宿主接受点（inject 正常返回）释放认领——
  // 修前认领滞留，窗口内其他载体只见状态行、续段无法恢复。
  assert.equal(entry.claimedBy, null, '认领在宿主接受点已释放');
  assert.equal(entry.deliveredFact.partial, true, '截断交付置 partial 事实');
  const expectedMiddle = omittedMiddle('ABCDEFGHIJKL', 8);
  assert.equal(entry.buffer, expectedMiddle, '省略中段按原文留缓冲');
  assert.ok(truncate('ABCDEFGHIJKL', 8, 'en').text !== 'ABCDEFGHIJKL', '前置：份额确实截断');
  // 等待出口关批 → 零等待领取续段（full 预算）：只交付中段，不重发首尾。
  ledger.closeBatchIfIdle(rig.OWNER);
  const { delivered } = ledger.collectBatch(rig.OWNER, {});
  assert.equal(delivered.length, 1, 'partial 续段条目进批（事实的 partial 例外）');
  assert.equal(delivered[0].text, expectedMiddle, '续段＝省略中段原文');
  assert.equal(delivered[0].truncated, false, '关批后恢复全额预算：续段完整交付');
  assert.equal(entry.buffer, '', '续段交付清空缓冲');
  assert.equal(entry.deliveredFact.partial, undefined, '完全交付覆盖事实');
  // 宿主一次性 result 只消费一次（读取计数锚定——续段恢复不重读宿主）。
  assert.equal(readCalls.filter((id) => id === 'job-rec-a').length, 1,
    '宿主 jobs.read 对该作业只调用一次（一次性 result 单次消费）');
  const again = ledger.collectBatch(rig.OWNER, {});
  assert.equal(again.delivered.length, 0, '完全交付后不再有条目（不重复交付）');
});

hostTest('REC-B：完成消息回滚保缓冲与追加增量——凭据四字段（original/remainder）使装配后增量不丢（REL-RECOVER-02）', async () => {
  const rig = sRig({ budget: 8 });
  // readSettled 即投首条截断完成消息（partial 形态前置）。
  await rig.readyJob('job-rec-b', 'HEAD' + 'm'.repeat(24) + 'TAIL');
  const entry = ledger.jobs.get('job-rec-b');
  assert.equal(rig.calls.inject.length, 1, '截断完成消息已投（前置）');
  assert.ok(entry.buffer.length > 0, '中段留缓冲（前置：partial 形态）');
  // 关批后再次装配（模拟下一等待出口领取），随后模拟通道失败回滚：
  // 装配后缓冲＝remainder；再追加增量（模拟 readIncremental/保活链新读）后回滚，
  // 凭据必须恢复「装配前原文＋追加增量」——修前凭据丢弃 remainder，回滚退成
  // 「空 original ＋ tail」，装配份额（中段原文）永久丢失。
  ledger.closeBatchIfIdle(rig.OWNER);
  const { delivered } = ledger.collectBatch(rig.OWNER, {});
  assert.equal(delivered.length, 1, '续段装配成功（前置）');
  entry.buffer += 'APPENDED-INCREMENT';
  ledger.undoClaim(rig.OWNER, delivered);
  const expected = (delivered[0].original ?? '') + 'APPENDED-INCREMENT';
  assert.equal(entry.buffer, expected,
    '回滚退回装配前原文＋装配后追加增量（original/remainder 凭据）');
  assert.equal(entry.claimedBy, null, '回滚撤销认领');
  assert.equal(entry.deliveredFact, null, '回滚清事实（正文可重投）');
});

hostTest('REC-C：空正文条目注入失败回滚——凭据不带 original，缓冲保持、事实清除、可重投（REL-SEND-02）', async () => {
  const rig = sRig({ injectFailsAt: 1 });
  // readSettled 即投：空正文状态行消息，inject 失败 ⇒ 回滚。
  await rig.readyJob('job-rec-c', '');
  const entry = ledger.jobs.get('job-rec-c');
  assert.equal(rig.calls.inject.length, 1, '注入尝试恰一次（失败）');
  assert.equal(entry.buffer, '', '空正文回滚后缓冲仍为空（不误造正文）');
  assert.equal(entry.claimedBy, null, '回滚撤销认领');
  assert.equal(entry.deliveredFact, null, '回滚清事实——空输出作业的结局不得被误记已交付');
  // 通道修复后（failOnce 已消耗）：让位终局复查触发重投——状态行可见。
  const token = ledger.claimWait(rig.OWNER);
  await ledger.releaseWait(token, rig.OWNER);
  assert.equal(rig.calls.inject.length, 2, '重投：空正文状态行一条');
  assert.match(textOf(rig.calls.inject[1]), /job-rec-c/, '空正文条目重投在场');
  assert.match(textOf(rig.calls.inject[1]), /0 chars|0 字符/, '状态行零字符形态');
  // 新作业结算 ⇒ 独立完成消息（正文路径不受回滚残留影响）。
  await rig.readyJob('job-rec-c2', 'BODY-AFTER-FIX');
  assert.equal(rig.calls.inject.length, 3, '新作业正文独立投递');
  assert.match(textOf(rig.calls.inject[2]), /BODY-AFTER-FIX/, '新作业正文交付');
});

hostTest('REC-D：条目上限对空正文条目同样生效——12 条空输出作业一批至多 10 条，余者延后说明＋下一批补投（REL-BATCH-02）', async () => {
  const rig = sRig({ budget: 4000 });
  const token = ledger.claimWait(rig.OWNER);
  for (let i = 1; i <= 12; i += 1) {
    await rig.readyJob(`job-rec-d${String(i).padStart(2, '0')}`, '');
  }
  await ledger.releaseWait(token, rig.OWNER);
  // 修前形态：条目上限只对非空正文生效 ⇒ 12 条空正文状态行一次全发。修后：
  // 10 条状态行进批，第 11/12 条不认领、不投注记本体，各投一条延后说明。
  assert.equal(rig.calls.inject.length, 12,
    `10 条状态行 + 2 条延后说明（实得 ${String(rig.calls.inject.length)}）`);
  const batchTexts = rig.calls.inject.slice(0, 10).map(textOf);
  assert.ok(batchTexts.every((text) => /0 chars/.test(text)), '前 10 条都是状态行（零字符形态）');
  assert.ok(!batchTexts.some((text) => /job-rec-d1[12]/.test(text)), '第 11/12 条不在本批');
  for (const text of rig.calls.inject.slice(10).map(textOf)) {
    assert.match(text, /did not fit the current delivery batch|没有排进当前交付批次/, '延后说明形态');
    assert.match(text, /wait_ms=0/, '延后说明给领取出路');
  }
  // 关批 → 下一轮窗口补投剩余两条状态行。
  ledger.closeBatchIfIdle(rig.OWNER);
  const token2 = ledger.claimWait(rig.OWNER);
  await ledger.releaseWait(token2, rig.OWNER);
  assert.equal(rig.calls.inject.length, 14, '下一批补投剩余两条状态行');
  assert.match(textOf(rig.calls.inject[12]), /job-rec-d11/, '第 11 条补投在场');
  assert.match(textOf(rig.calls.inject[13]), /job-rec-d12/, '第 12 条补投在场');
});

hostTest('REC-E：字符预算耗尽但条目未满——空正文条目仍按状态行交付，不因预算延后（REL-BATCH-02 反向）', async () => {
  const rig = sRig({ budget: 8 });
  const token = ledger.claimWait(rig.OWNER);
  await rig.readyJob('job-rec-e1', 'XXXXXXXX'); // 恰耗尽预算（8/8）
  await rig.readyJob('job-rec-e2', ''); // 空正文：预算为零也不延后
  await ledger.releaseWait(token, rig.OWNER);
  assert.equal(rig.calls.inject.length, 2,
    '两条都投：预算只约束非空正文（修前把空正文也按预算延后）');
  assert.match(textOf(rig.calls.inject[0]), /XXXXXXXX/, '非空正文消耗预算');
  assert.match(textOf(rig.calls.inject[1]), /job-rec-e2/, '空正文以状态行同窗交付');
});

hostTest('REC-F：无活等待的读取失败——注记三要素（真实结局＋失败标记＋重试出路）经完成消息可见，不置已交付事实（REL-READ-02）', async () => {
  const rig = sRig({ injectFailsAt: 0 });
  ledger.noteJobStarted(rig.ctx, rig.config, 'job-rec-f', rig.OWNER);
  const entry = ledger.jobs.get('job-rec-f');
  entry.terminal = { status: 'completed' };
  // 读取持续失败：readSettled 捕获 → readFailed 定论 → #deliverIfNoWait 注记。
  const realRead = rig.ctx.jobs.read;
  rig.ctx.jobs.read = async () => { throw new Error('registry read exploded'); };
  await ledger.readSettled('job-rec-f');
  assert.equal(entry.readFailed, true, '读取失败定论置位');
  assert.equal(rig.calls.inject.length, 1, '注记恰一条（完成消息通道）');
  const notice = textOf(rig.calls.inject[0]);
  // 三要素：真实结局（状态行）＋读取失败标记＋重试出路（V1：走完整渲染管线，
  // 修前只有单行标记）。
  assert.match(notice, /job-rec-f/, '真实结局在场（终态状态行）');
  assert.match(notice, /\[read failed\]|\[读取失败\]/, '读取失败标记在场');
  assert.match(notice, /Retry async_wait|请重试 async_wait/, '重试出路在场');
  assert.equal(entry.deliveredFact, null, '注记不置已交付事实（重试成功后正文仍可首次交付）');
  assert.equal(entry.claimedBy, null, '注记接受后认领释放');
  assert.equal(entry.readFailedNoted, true, '一次性占位置位（跨载体）');
  // 让位复查不重复通知：同一次失败的占位在后续扫描中被抑制。
  const token = ledger.claimWait(rig.OWNER);
  await ledger.releaseWait(token, rig.OWNER);
  assert.equal(rig.calls.inject.length, 1, '同一次失败不重复通知（readFailedNoted 一次性）');
  // 读取恢复：正文经完成消息首次交付，注记不重发。
  rig.reads.set('job-rec-f', { chunks: [{ channel: 'stdout', text: 'RECOVERED-BODY' }] });
  rig.ctx.jobs.read = realRead;
  await ledger.readSettled('job-rec-f');
  assert.equal(entry.readFailed, false, '成功读取清失败态');
  assert.equal(rig.calls.inject.length, 2, '恢复后的正文交付恰一条');
  assert.ok(textOf(rig.calls.inject[1]).includes('RECOVERED-BODY'), '正文在场');
  assert.ok(!/\[read failed\]|\[读取失败\]/.test(textOf(rig.calls.inject[1])), '正文交付不带失败标记');
});

hostTest('REC-G：读取失败再失败——新失败定论清占位恢复通知（每次失败至多一条，不跨载体堆积）', async () => {
  const rig = sRig({});
  ledger.noteJobStarted(rig.ctx, rig.config, 'job-rec-g', rig.OWNER);
  const entry = ledger.jobs.get('job-rec-g');
  entry.terminal = { status: 'completed' };
  rig.ctx.jobs.read = async () => { throw new Error('read fail 1'); };
  await ledger.readSettled('job-rec-g');
  assert.equal(rig.calls.inject.length, 1, '第一次失败通知一条');
  // 第二次尝试仍失败：失败定论清占位 → 新通知（按次一次性，不按条目一次性）。
  await ledger.readSettled('job-rec-g');
  assert.equal(rig.calls.inject.length, 2, '新失败定论 ⇒ 新通知（占位在新定论时清除）');
  // 第三次同样失败：仍按次一条。
  await ledger.readSettled('job-rec-g');
  assert.equal(rig.calls.inject.length, 3, '第三次失败 ⇒ 第三条通知');
});

hostTest('REC-H：满批后到达的读取失败结算——注记按条目上限延后（不认领、不清占位），下一批投递', async () => {
  const rig = sRig({ budget: 4000 });
  const token = ledger.claimWait(rig.OWNER);
  for (let i = 1; i <= 10; i += 1) {
    await rig.readyJob(`job-rec-h${String(i).padStart(2, '0')}`, `BODY-H-${String(i)}`);
  }
  // 第 11 个：读取失败的结算——releaseWait 扫描构造时条目已达上限 ⇒ 延后说明。
  ledger.noteJobStarted(rig.ctx, rig.config, 'job-rec-h11', rig.OWNER);
  const entry = ledger.jobs.get('job-rec-h11');
  entry.terminal = { status: 'killed' };
  rig.ctx.jobs.read = async (jobId) => (jobId === 'job-rec-h11'
    ? Promise.reject(new Error('read fail'))
    : rig.reads.get(jobId));
  await ledger.readSettled('job-rec-h11');
  await ledger.releaseWait(token, rig.OWNER);
  // 10 条正文 + 1 条延后说明（不是注记本体——注记按条目上限延后）。
  assert.equal(rig.calls.inject.length, 11,
    `10 条正文 + 1 条延后说明（实得 ${String(rig.calls.inject.length)}）`);
  const last = textOf(rig.calls.inject[10]);
  assert.match(last, /job-rec-h11/, '延后说明点名作业');
  assert.match(last, /wait_ms=0/, '延后说明给领取出路');
  assert.ok(!/\[read failed\]|\[读取失败\]/.test(last), '失败注记本体不在本批（I2：只投延后说明）');
  assert.equal(entry.claimedBy, null, '延后不认领');
  assert.equal(entry.readFailedNoted, false, '延后不清占位（下一批照常通知）');
  // 关批 → 下一窗口：注记本体投递（三要素）。
  ledger.closeBatchIfIdle(rig.OWNER);
  const token2 = ledger.claimWait(rig.OWNER);
  await ledger.releaseWait(token2, rig.OWNER);
  assert.equal(rig.calls.inject.length, 12, '注记本体在下一批投递');
  const notice = textOf(rig.calls.inject[11]);
  assert.match(notice, /\[read failed\]|\[读取失败\]/, '失败标记在场');
  assert.match(notice, /killed/, '真实结局（killed 状态行）在场');
  assert.equal(entry.readFailedNoted, true, '投递后占位置位');
});

hostTest('REC-I：注记与正文完成消息同队列部分失败——注记回滚清占位可重投，已接受正文事实保持', async () => {
  const rig = sRig({ injectFailsAt: 2 });
  const token = ledger.claimWait(rig.OWNER);
  await rig.readyJob('job-rec-i1', 'BODY-I-ACCEPTED');
  // 第二条：读取失败的注记（busy 逐条 inject 的第 2 条失败 ⇒ 注记回滚）。
  ledger.noteJobStarted(rig.ctx, rig.config, 'job-rec-i2', rig.OWNER);
  const entry = ledger.jobs.get('job-rec-i2');
  entry.terminal = { status: 'completed' };
  rig.ctx.jobs.read = async (jobId) => (jobId === 'job-rec-i2'
    ? Promise.reject(new Error('read fail'))
    : rig.reads.get(jobId));
  await ledger.readSettled('job-rec-i2');
  await ledger.releaseWait(token, rig.OWNER);
  assert.equal(rig.calls.inject.length, 2, '第 1 条正文接受、第 2 条（注记）失败');
  const firstEntry = ledger.jobs.get('job-rec-i1');
  assert.equal(firstEntry.claimedBy, null, '已接受正文认领释放');
  assert.notEqual(firstEntry.deliveredFact, null, '已接受正文事实保持（不重现）');
  assert.equal(entry.claimedBy, null, '注记回滚撤销认领');
  assert.equal(entry.readFailedNoted, false, '注记回滚清占位（通知没送达，允许重投）');
  assert.equal(entry.deliveredFact, null, '注记条目不置事实');
  // 重投：注记本体送达。
  const token2 = ledger.claimWait(rig.OWNER);
  await ledger.releaseWait(token2, rig.OWNER);
  assert.equal(rig.calls.inject.length, 3, '注记重投恰一条');
  assert.match(textOf(rig.calls.inject[2]), /\[read failed\]|\[读取失败\]/, '注记三要素重投在场');
  assert.equal(entry.readFailedNoted, true, '送达后占位置位');
});

hostTest('REC-K：完成消息载体回滚凭据四字段——装配后增量经原路保留（V2 防退化锚，修前红）', async () => {
  // 预算 8 < 正文 32 ⇒ 完成消息按截断形态装配（text≠original）——删凭据的
  // original 走「text 拼接」分支会把截断文本混进缓冲（红），删 remainder 丢
  // 装配后增量（红）：两字段同时受锚。
  const rig = sRig({ budget: 8 });
  const original = 'HEAD' + 'm'.repeat(24) + 'TAIL';
  const token = ledger.claimWait(rig.OWNER);
  await rig.readyJob('job-rec-k', original); // 活等待在场：readSettled 不投
  const entry = ledger.jobs.get('job-rec-k');
  assert.equal(entry.buffer, original, '前置：装配前原文在缓冲');
  // 装配与回滚之间落入增量（模拟保活链/结算读取新到块）：通道抛错前追加——
  // 完成消息路径的凭据映射若丢 original/remainder（修前形态），回滚退成
  // 「截断文本拼接」或丢掉装配后增量，宿主一次性 result 已消费、正文永久缺损。
  const realInject = rig.agent.inject;
  rig.agent.inject = () => {
    entry.buffer += 'INC-AFTER-ASSEMBLY';
    throw new Error('channel refused');
  };
  await ledger.releaseWait(token, rig.OWNER); // 构造（claim＋takeShare 截断）→ flush → inject 抛错 → 回滚
  rig.agent.inject = realInject;
  const expected = original + 'INC-AFTER-ASSEMBLY';
  assert.equal(entry.buffer, expected,
    '回滚＝装配前原文＋装配后增量（完成消息载体凭据带 original/remainder）');
  assert.equal(entry.claimedBy, null, '回滚撤销认领');
  assert.equal(entry.deliveredFact, null, '回滚清事实（正文可重投）');
  assert.equal(rig.calls.inject.length, 0, '通道未送达（前置：记录器只在真通道上计数）');
  // 关批 → 下一批装配见到完整缓冲（凭据链完整性经装配的 original 再现）。
  ledger.closeBatchIfIdle(rig.OWNER);
  const { delivered } = ledger.collectBatch(rig.OWNER, {});
  assert.equal(delivered.length, 1, '重装配进批');
  assert.equal(delivered[0].original, expected, '下一批凭据的 original＝原文＋增量（缓冲未损）');
  assert.equal(delivered[0].truncated, true, '预算 8 仍截断（前置：本批未整条交清）');
});

hostTest('REC-L：读取失败注记回滚保非空缓冲——凭据不带 original（B1 防复发锚，修前红）', async () => {
  const rig = sRig({ injectFailsAt: 1 });
  const token = ledger.claimWait(rig.OWNER);
  ledger.noteJobStarted(rig.ctx, rig.config, 'job-rec-l', rig.OWNER);
  const entry = ledger.jobs.get('job-rec-l');
  // 形态：首等待 partial（中段留缓冲）后终态读取失败——readFailed 与非空缓冲并存。
  entry.terminal = { status: 'completed' };
  entry.buffer = 'MIDDLE-REMAINDER-XXXX';
  entry.readFailed = true;
  entry.deliveredFact = { via: 'wait', partial: true };
  await ledger.releaseWait(token, rig.OWNER);
  assert.equal(rig.calls.inject.length, 1, '注记投递尝试恰一次（失败）');
  assert.equal(entry.buffer, 'MIDDLE-REMAINDER-XXXX',
    '注记回滚保非空缓冲（凭据不带 original——修前空 original 分支会清空中段）');
  assert.equal(entry.readFailedNoted, false, '回滚清占位（未送达可重投）');
  assert.equal(entry.claimedBy, null, '回滚撤销认领');
  ledger.closeBatchIfIdle(rig.OWNER);
  const token2 = ledger.claimWait(rig.OWNER);
  await ledger.releaseWait(token2, rig.OWNER);
  assert.equal(rig.calls.inject.length, 2, '注记重投送达');
  assert.match(textOf(rig.calls.inject[1]), /\[read failed\]|\[读取失败\]/, '注记三要素在场');
  assert.equal(entry.buffer, 'MIDDLE-REMAINDER-XXXX', '注记送达不动缓冲（正文仍待成功读取后交付）');
});

hostTest('REC-M：闲通道 followup 失败——注记与正文整队回滚，缓冲与占位恢复（REC-L 的闲通道形）', async () => {
  const rig = sRig({ followupThrows: true, status: 'idle' });
  const token = ledger.claimWait(rig.OWNER);
  await rig.readyJob('job-rec-m1', 'BODY-M-IDLE');
  ledger.noteJobStarted(rig.ctx, rig.config, 'job-rec-m2', rig.OWNER);
  const entry = ledger.jobs.get('job-rec-m2');
  entry.terminal = { status: 'completed' };
  entry.buffer = 'MIDDLE-M-REMAINDER';
  entry.readFailed = true;
  entry.deliveredFact = { via: 'wait', partial: true };
  await ledger.releaseWait(token, rig.OWNER);
  // 空闲路径单次合并 followup、无部分接受：抛错＝整队回滚（正文退回、注记清占位）。
  assert.equal(rig.calls.followup.length, 1, '合并 followup 恰尝试一次（失败）');
  const body = ledger.jobs.get('job-rec-m1');
  assert.equal(body.buffer, 'BODY-M-IDLE', '正文整队回滚退回缓冲');
  assert.equal(body.claimedBy, null, '正文认领回滚');
  assert.equal(entry.buffer, 'MIDDLE-M-REMAINDER', '读取失败条目缓冲原样保留');
  assert.equal(entry.readFailedNoted, false, '注记占位回滚（允许重投）');
  assert.equal(entry.claimedBy, null, '注记认领回滚');
  // 通道修复后同窗口重投：合并一条送达。
  rig.agent.followup = (message) => { rig.calls.followup.push(message); };
  ledger.closeBatchIfIdle(rig.OWNER);
  const token2 = ledger.claimWait(rig.OWNER);
  await ledger.releaseWait(token2, rig.OWNER);
  assert.equal(rig.calls.followup.length, 2, '重投合并一条 followup');
  const resent = textOf(rig.calls.followup[1]);
  assert.ok(resent.includes('BODY-M-IDLE'), '正文随重投送达');
  assert.match(resent, /\[read failed\]|\[读取失败\]/, '注记随重投送达');
});

hostTest('REC-N：非零退出码的读取失败注记——真实结局携带退出码行（三要素齐全）', async () => {
  const rig = sRig({});
  ledger.noteJobStarted(rig.ctx, rig.config, 'job-rec-n', rig.OWNER);
  const entry = ledger.jobs.get('job-rec-n');
  entry.terminal = { status: 'completed', exitCode: 1, detail: 'exit code: 1' };
  rig.ctx.jobs.read = async () => { throw new Error('read fail'); };
  await ledger.readSettled('job-rec-n');
  assert.equal(rig.calls.inject.length, 1, '注记恰一条');
  const notice = textOf(rig.calls.inject[0]);
  assert.match(notice, /job-rec-n/, '状态行在场');
  assert.match(notice, /exit code: 1|退出码：? ?1|non-zero|非零/, '非零退出码可见（终态细节走完整渲染管线）');
  assert.match(notice, /\[read failed\]|\[读取失败\]/, '读取失败标记在场');
  assert.match(notice, /Retry async_wait|请重试 async_wait/, '重试出路在场');
});

hostTest('REC-O：让位终局复查投 partial 续段——中段经完成消息第三载体恢复（REL-RECOVER-02）', async () => {
  const rig = sRig({ budget: 8 });
  const { omittedMiddle } = await import('../lib/output.js');
  await rig.readyJob('job-rec-o', 'ABCDEFGHIJKL'); // readSettled 即投截断首条
  const entry = ledger.jobs.get('job-rec-o');
  assert.equal(entry.deliveredFact.partial, true, '前置：partial 形态（首尾已付、中段留缓冲）');
  const middle = omittedMiddle('ABCDEFGHIJKL', 8);
  // 让位终局复查（无活等待后的被动投递）是 partial 续段的第三载体——认领已随
  // 宿主接受点释放，复查按 partial 例外投中段，不重发首尾。首条消息的批次在
  // 无活等待时按关批判定关闭（下一批恢复全额预算）。
  ledger.closeBatchIfIdle(rig.OWNER);
  const token = ledger.claimWait(rig.OWNER);
  await ledger.releaseWait(token, rig.OWNER);
  assert.equal(rig.calls.inject.length, 2, '续段经完成消息恢复（让位复查载体）');
  const second = textOf(rig.calls.inject[1]);
  assert.ok(second.includes(middle), '中段原文在场');
  assert.ok(!second.includes('ABC'), '不重发首段（已交付首尾阻断）');
  assert.equal(entry.buffer, '', '续段投出后缓冲清空');
  assert.equal(entry.deliveredFact.partial, undefined, '完全交付覆盖事实');
});

hostTest('REC-P：partial 后读取再失败——注记只报待领取份额，不声称「约 0 字符已附带」（读取失败形态的 trigger 不算附带）', async () => {  const rig = await buildRig('rec-p', [], { maxResultChars: 40 });
  try {
    const { ledger: led } = await import('../lib/delivery.js');
    const jobId = rig.ctx.jobs.start({
      kind: 'at-r57-cmd', label: 'partial then read fail', owner: rig.parent.id,
      run(job) {
        job.append(`HEAD-9-CHARS${'y'.repeat(160)}TAIL-10\n`);
        return { cancel() {}, done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }) };
      }
    });
    // 首访截断（partial 事实，中段留缓冲）。
    const first = await rig.waiter.execute(waitArgs(jobId), rig.exec());
    assert.equal(first.truncated, true, '前置：首访截断');
    const entry = led.jobs.get(jobId);
    assert.equal(entry.deliveredFact.partial, true, '前置：partial 事实');
    // 复合边界：保活链增量读取失败置 readFailed（账本级定论）——再访时该条
    // 目以「状态行＋重试出路」进批（正文 ''、chars 0），不得拼 partialDelivered。
    entry.readFailed = true;
    const second = await rig.waiter.execute(waitArgs(jobId), rig.exec());
    assert.equal(second.status, 'completed');
    // 该形态批条目只带状态行与重试出路（正文 ''、chars 0）——出口 output 为空、
    // 由注记解释；核心断言：不得拼 partialDelivered。
    const note = second.note ?? '';
    assert.ok(!/attached with this batch/.test(note),
      '读取失败形态的 trigger 不算「已附带」——不得声称约 0 字符已随批附带');
    assert.match(note, /were not attached this time|本次未随附/,
      '仍为 partial ⇒ 只报待领取份额（partialPending）');
  } finally {
    await rig.dispose();
  }
});

hostTest('REC-Q：空输出作业首等不误报 alreadyDelivered——第二分支准入＝装配前已有交付事实（状态行 0 chars 即正确解释）', async () => {
  const rig = await buildRig('rec-q', [], { maxResultChars: 40 });
  try {
    const jobId = rig.ctx.jobs.start({
      kind: 'at-r57-cmd', label: 'empty output', owner: rig.parent.id,
      run(job) {
        job.append(''); // 空输出结算（touch/mkdir 类命令的形态）
        return { cancel() {}, done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }) };
      }
    });
    // 首次等待（入口终态分支）：本次装配自置 {via:'wait'}——不得把它当
    // 「先前已交付」误报 alreadyDelivered（修前该形态无注记；放宽分支后曾误报，
    // factBefore 门控后恢复）。零等待同口径。
    const first = await rig.waiter.execute(waitArgs(jobId), rig.exec());
    assert.equal(first.status, 'completed');
    const note1 = first.note ?? '';
    assert.ok(!/delivered earlier|先前已交付/.test(note1),
      '空输出首达不声称「结果此前已交付、空输出非无产出」——状态行 0 chars 即正确解释');
    // 复等（装配前事实在场）：空输出此时才由 alreadyDelivered 解释（R58 判据）。
    const second = await rig.waiter.execute(waitArgs(jobId), rig.exec());
    assert.equal(second.status, 'completed');
    assert.match(second.note ?? '', /delivered earlier|先前已交付/,
      '复等空输出＝解释空 output（防误读为「完成且无输出」）');
  } finally {
    await rig.dispose();
  }
});

hostTest('REC-J：等待出口注记两分——续段附带给 partialDelivered（trigger.chars 口径），再截断并陈 partialPending；无续段不谎称（REL-RECOVER-02）', async () => {
  const rig = await buildRig('rec-j', [], { maxResultChars: 40 });
  try {
    const { ledger: led } = await import('../lib/delivery.js');
    const jobId = rig.ctx.jobs.start({
      kind: 'at-r57-cmd', label: 'partial notes', owner: rig.parent.id,
      run(job) {
        job.append(`HEAD-9-CHARS${'y'.repeat(160)}TAIL-10\n`);
        return { cancel() {}, done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }) };
      }
    });
    // 首访：装配 40 份额截断（partial 事实，中段留缓冲）——首次交付不产生
    // partial 注记（factBefore 为空，无「已附带续段」可陈述）。
    const first = await rig.waiter.execute(waitArgs(jobId), rig.exec());
    assert.equal(first.status, 'completed');
    assert.equal(first.truncated, true, '前置：首访截断（partial 形态）');
    assert.ok(first.note === undefined || !/attached with this batch/.test(first.note),
      '首次交付不声称续段已附带');
    const entry = led.jobs.get(jobId);
    assert.equal(entry.deliveredFact.partial, true, '前置：partial 事实');
    // 续访：trigger 携带续段（预算 40 < 缓冲 144 ⇒ 再截断）——双事实并陈：
    // 已附带份额（partialDelivered，chars＝装配条目份额＝output 长度）＋待领取
    // 份额（partialPending，chars＝剩余缓冲长度）。
    const second = await rig.waiter.execute(waitArgs(jobId), rig.exec());
    assert.equal(second.status, 'completed');
    assert.ok(second.output.length > 0, '续段正文随 output 附带');
    assert.match(second.note ?? '', /attached with this batch/, '已附带份额注记在场（partialDelivered）');
    assert.ok(second.note.includes(`about ${String(second.output.length)} chars`),
      `chars 口径＝本批装配份额（${String(second.output.length)}）：partialDelivered 的数值与 output 一致`);
    assert.match(second.note ?? '', /about \d+ chars of the omitted middle were not attached this time/,
      '待领取份额并陈（partialPending）——只报其一即谎报');
    assert.ok(!second.output.includes('HEAD-9-CHARS'), '续段不重发首访已付正文');
    // 末段：续访直到整条装下（每次 40 份额）——最后一访只陈述附带份额
    //（无剩余 ⇒ 不再有 partialPending）；随后事实完全 ⇒ alreadyDelivered。
    let latest = second;
    for (let i = 0; i < 6 && latest.truncated === true; i += 1) {
      latest = await rig.waiter.execute(waitArgs(jobId), rig.exec());
      assert.equal(latest.status, 'completed', '续访按终态返回');
      assert.match(latest.note ?? '', /attached with this batch/, '附带份额注记在场');
      if (latest.truncated === true) {
        assert.match(latest.note ?? '', /were not attached this time/, '仍有剩余 ⇒ 并陈待领取份额');
      }
    }
    assert.equal(latest.truncated, false, '末访完整交付（循环收敛）');
    assert.ok(!/were not attached this time/.test(latest.note ?? ''), '无剩余 ⇒ 不再有 partialPending');
    const fourth = await rig.waiter.execute(waitArgs(jobId), rig.exec());
    assert.match(fourth.note ?? '', /already finished|先前已交付/, '完全已交付 ⇒ alreadyDelivered 解释空输出');
    assert.equal(fourth.output, '', '正文不重复出现');
  } finally {
    await rig.dispose();
  }
});


// ═══ REL-TERMINAL-01：终态细节进完成消息与等待返回（设计 r14 §4）═══
//
// T1 是受控反例：修前完成消息只渲染 {jobId, status, chars}——killed＋信号＋
// 非零退出码＋诊断在两条路径上都只有 killed 一个词。修后行序（§4.2）：
// 状态行→正文→结局标记行（与前台 jobs.js exitStatusMarker 同判据：信号优先、
// 其次非零退出码、成功无标记）→诊断行（首行必要、第二行可降级＋省略计数）
// →lossy／留存行。
//
// 设计 T1 矩阵行写「断言含 143」；规范节 §4.2 的标记判据是信号优先（与前台
// 逐字一致），信号在场时不另投退出码行——按规范节实现，退出码可见性由本组
// T1 的无信号退出码断言与 T5 结构化字段覆盖。

hostTest('T1 受控反例两语：killed＋SIGTERM＋非零退出码＋唯一诊断文本全部可见（修前红）', async () => {
  for (const lang of ['en', 'zh']) {
    const rig = sRig({ lang });
    const token = ledger.claimWait(rig.OWNER);
    await rig.readyJob('job-t1', 'T1-BODY', {
      status: 'killed', exitCode: 143, signal: 'SIGTERM', detail: 'UNIQUE-DIAG-7f3a'
    });
    await rig.readyJob('job-t1b', 'T1-BODY-B', { status: 'completed', exitCode: 7, detail: 'DIAG-EXIT-7' });
    await ledger.releaseWait(token, rig.OWNER);
    assert.equal(rig.calls.inject.length, 2, `${lang}：两条完成消息（忙路径逐条）`);
    const killed = textOf(rig.calls.inject[0]);
    // 信号优先（§4.2 与 jobs.js:304-310 同判据）：killed＋信号→信号标记行，
    // 不再叠加退出码行（与前台逐字一致；143 与信号是同一次终止的两个读数）。
    assert.ok(killed.includes('SIGTERM'), `${lang}：信号标记在场`);
    assert.ok(killed.includes('UNIQUE-DIAG-7f3a'), `${lang}：唯一诊断文本在场（修前只有 killed）`);
    assert.ok(!killed.includes('143'), `${lang}：信号在场不另投退出码行（前台同口径）`);
    // 无信号的非零退出码：退出码标记行必须可见（真实结局不因载体丢失）。
    const exited = textOf(rig.calls.inject[1]);
    assert.ok(exited.includes('7'), `${lang}：非零退出码可见`);
    assert.ok(exited.includes('DIAG-EXIT-7'), `${lang}：completed 条目的诊断行在场`);
  }
});

hostTest('T2 零退出成功条目：无标记行（不添噪声），诊断仍随事实渲染', async () => {
  const rig = sRig({ lang: 'en' });
  const token = ledger.claimWait(rig.OWNER);
  await rig.readyJob('job-t2', 'T2-BODY', { status: 'completed', exitCode: 0 });
  await ledger.releaseWait(token, rig.OWNER);
  const text = textOf(rig.calls.inject[0]);
  assert.ok(!text.includes('exit code'), '零退出：无退出码标记行（成功由无失败标记表达）');
  assert.ok(!text.includes('signal'), '无信号：无信号标记行');
  assert.ok(text.includes('T2-BODY') && text.includes('completed'), '状态与正文照常');
});

hostTest('T3 killed＋信号＋退出码＋诊断：标记行与诊断首行都在，正文与标记不重复渲染', async () => {
  const rig = sRig({ lang: 'zh' });
  const token = ledger.claimWait(rig.OWNER);
  await rig.readyJob('job-t3', 'T3-BODY-唯一正文', {
    status: 'killed', exitCode: 137, signal: 'SIGKILL', detail: 'T3-DIAG-唯一诊断'
  });
  await ledger.releaseWait(token, rig.OWNER);
  const text = textOf(rig.calls.inject[0]);
  assert.equal(text.split('T3-BODY-唯一正文').length - 1, 1, '正文恰一次');
  assert.equal(text.split('SIGKILL').length - 1, 1, '标记行恰一次（不与正文重复）');
  assert.equal(text.split('T3-DIAG-唯一诊断').length - 1, 1, '诊断首行恰一次');
});

hostTest('T4 极端多行诊断（40 行）：状态/标记/诊断首行仍在，仅 2 行诊断＋省略计数', async () => {
  const rig = sRig({ lang: 'en' });
  const detail = Array.from({ length: 40 }, (_, i) => `DIAG-LINE-${String(i + 1).padStart(2, '0')}`).join('\n');
  const token = ledger.claimWait(rig.OWNER);
  await rig.readyJob('job-t4', '', { status: 'killed', exitCode: 143, signal: 'SIGTERM', detail });
  await ledger.releaseWait(token, rig.OWNER);
  const text = textOf(rig.calls.inject[0]);
  assert.ok(text.includes('SIGTERM'), '标记行在（预算压力下不丢）');
  assert.ok(text.includes('DIAG-LINE-01'), '诊断首行在（必要结局，永不丢）');
  assert.ok(text.includes('DIAG-LINE-02'), '诊断第二行在（预算内可降级但未超限）');
  assert.ok(!text.includes('DIAG-LINE-03'), '第三行起省略');
  assert.ok(text.includes('38 more diagnostic lines'), '省略行数如实计数（40−2）');
});

hostTest('T5 等待返回结构化字段：已知才有、未知则无键；status_line 追加行与完成消息同词', async () => {
  const rig = await buildRig('t5', [], {
    jobsList: () => [
      { id: 'ext-t5', status: 'killed', exitCode: 143, signal: 'SIGTERM', detail: 'T5-DIAG-A\nT5-DIAG-B\nT5-DIAG-C' },
      { id: 'ext-t5b', status: 'completed', exitCode: 0 }
    ],
    jobsRead: async (jobId) => ({ chunks: [{ channel: 'stdout', text: `BODY-${String(jobId)}` }] })
  });
  try {
    // 零退出条目先行：单独零等待 ext-t5b（两目标同一领取窗口会先触发 killed 目标、
    // 另一目标不保证入批——分两次各自触发，断言面各自完整）。
    const okOutcome = await rig.waiter.execute(
      { wait_ms: 0, targets: [{ kind: 'job', id: 'ext-t5b' }] }, rig.exec()
    );
    assert.equal(okOutcome.status, 'completed', '前置：零退出目标已终态，零等待即完成');
    const okRow = okOutcome.delivered.find((row) => row.job_id === 'ext-t5b');
    assert.ok(okRow !== undefined, '零退出条目在批');
    assert.ok(!('exit_code' in okRow) && !('signal' in okRow) && !('detail' in okRow),
      '零退出完成条目：三个新字段全部无键（没值就不写这个键）');
    const okOut = okOutcome.outputs.find((row) => row.job_id === 'ext-t5b');
    assert.ok(okOut.status_line !== undefined && !okOut.status_line.includes('\n'),
      '零退出条目 status_line 仍单行（无追加行）');

    const outcome = await rig.waiter.execute(
      { wait_ms: 0, targets: [{ kind: 'job', id: 'ext-t5' }] }, rig.exec()
    );
    // 等待出口状态＝触发目标的终态（这里触发目标 ext-t5 是 killed）。
    assert.equal(outcome.status, 'killed', '前置：killed 目标已终态，零等待即完成');
    const killed = outcome.delivered.find((row) => row.job_id === 'ext-t5');
    assert.equal(killed.exit_code, 143, 'killed 条目 exit_code 已知非零→携带');
    assert.equal(killed.signal, 'SIGTERM', 'killed 条目 signal 已知→携带');
    assert.ok(killed.detail.includes('T5-DIAG-A'), 'detail 首行在场');
    assert.ok(killed.detail.includes('2 more diagnostic lines'), '多行 detail 尾接省略计数');
    const killedOut = outcome.outputs.find((row) => row.job_id === 'ext-t5');
    assert.ok(killedOut.status_line.includes('[killed by signal: SIGTERM]'), 'status_line 追加标记行（与完成消息同词）');
    assert.ok(killedOut.status_line.includes('T5-DIAG-A'), 'status_line 追加诊断首行');
    assert.equal(killedOut.exit_code, 143, 'outputs 条目同带结构化字段');
  } finally {
    await rig.dispose();
  }
});

hostTest('T6 上界推导三层：单条目必要 ≤460、单批必要 ≤4600（10 条目）、可降级单条目渲染内 ≤2000', async () => {
  // （a）单条目必要行：状态行（≤200）＋标记行（<60）＋诊断首行（≤200）≤460。
  {
    const rig = sRig({ lang: 'en' });
    const longDiag = `D-${'x'.repeat(196)}`;
    const token = ledger.claimWait(rig.OWNER);
    await rig.readyJob('job-t6a', '', { status: 'completed', exitCode: 9, detail: longDiag });
    await ledger.releaseWait(token, rig.OWNER);
    const lines = textOf(rig.calls.inject[0]).split('\n');
    const necessary = lines[0].length + lines[1].length + lines[2].length;
    assert.ok(necessary <= 460, `单条目必要行合计 ${String(necessary)} ≤ 460`);
  }
  // （b）单批必要行：10 条目合并一条 followup，必要行合计 ≤4600（条目上限 10
  // × 单条目 460；断言不含可降级行——本例每条目只有必要行，超出部分仅换行
  // 与段间分隔）。
  {
    const rig = sRig({ lang: 'en' });
    rig.agent.status = 'idle';
    const token = ledger.claimWait(rig.OWNER);
    for (let i = 0; i < 10; i += 1) {
      await rig.readyJob(`job-t6b-${String(i).padStart(2, '0')}`, '', {
        status: 'completed', exitCode: 3, detail: `DIAG-${String(i)}`
      });
    }
    await ledger.releaseWait(token, rig.OWNER);
    assert.equal(rig.calls.followup.length, 1, '空闲路径合并为一条 followup');
    const text = textOf(rig.calls.followup[0]);
    assert.equal(text.split('[exit code: 3]').length - 1, 10, '10 条目逐条有标记行');
    // 必要行＝全部行（本例无正文、无 lossy／留存、诊断恰一行、无省略计数）；
    // 分隔符余量：条目内 2×10 换行＋条目间 '\n\n' 9 处。
    assert.ok(text.length <= 4600 + 2 * 10 + 9,
      `10 条目必要行＋分隔合计 ${String(text.length)} ≤ 4600+分隔余量`);
  }
  // （c）可降级说明（lossy／留存行）：单条目渲染内合计 ≤2000（MAX_NOTES_TOTAL
  // 的实际粒度是单条目渲染，非整条物理消息——设计 §4.4-3）。
  {
    const rig = sRig({ lang: 'en' });
    const spillPaths = Array.from({ length: 40 }, (_, i) => `/spill/${'p'.repeat(140)}-${String(i)}`);
    const token = ledger.claimWait(rig.OWNER);
    await rig.readyJob('job-t6c', 'BODY-T6C', { status: 'completed', exitCode: 1, detail: 'DIAG-T6C' },
      { lossy: true, job: { output: { spillPaths } } });
    await ledger.releaseWait(token, rig.OWNER);
    const text = textOf(rig.calls.inject[0]);
    assert.ok(text.includes('DIAG-T6C') && text.includes('[exit code: 1]'), '必要结局行不被留存行挤掉');
    assert.ok(text.length <= 460 + 2000 + 120,
      `单条目渲染合计（必要＋可降级＋分隔）${String(text.length)} ≤ 460+2000+分隔余量`);
  }
});

/**
 * T7 真实通道装置：真 Context＋真 LocalJobRegistry＋真实 `createRunTool`
 * （lib/jobs.js 产品代码），shell.execute 用真实 node 子进程（spawn）实现——
 * 进程句柄形状与宿主 shell 契约一致（状态/退出码/信号/done/增量读/kill），
 * 只有「命令文本→脚本」的路由是受控的（命令字符串照常进作业元数据）。
 */
async function t7Rig() {
  resetDeliveryLedger();
  const base = new Context();
  const injections = [];
  const parent = {
    id: 'at-t7-owner',
    ctx: base,
    session: { append() {} },
    inbox: { nextStep: [], nextTurn: [] },
    inject(message) { injections.push(message); }
  };
  base.provide('agents', { get: (id) => (id === parent.id ? parent : undefined) });
  await base.plugin(LocalJobRegistry, {
    maxConcurrentJobsPerOwner: 10, retainBytes: 1048576, settledRetainBytes: 1048576, pumpPollMs: 10
  });
  const ctx = await new Promise((resolve) => {
    base.inject(['jobs'], async (c) => resolve(c));
  });
  const detach = ctx.jobs.attachController('at-t7');
  /** 当前脚本（受控路由：execute 忽略命令文本、按本变量起真实 node 进程）。 */
  let script = '';
  const adapter = {
    jobs: ctx.jobs,
    agents: ctx.agents,
    on: (...args) => ctx.on(...args),
    get: (name) => (name === 'agents' ? ctx.agents : undefined),
    // 会话当前有效目录（jobs.js 在审批后、注册前 ensure）：受控返回固定目录，
    // 不触盘（本装置的进程启动不经 spec.workdir）。
    workingDirectory: { ensure: async () => '/at-t7-work' },
    logger: { info() {}, warn() {} },
    timer: {
      timeout: (fn, ms) => { const h = setTimeout(fn, ms); return () => clearTimeout(h); },
      interval: (fn, ms) => { const h = setInterval(fn, ms); return () => clearInterval(h); }
    },
    shell: {
      sandboxMode: undefined,
      resolve: (request) => ({ ...request }),
      execute: () => {
        const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let killRequested = false;
        child.stdout.on('data', (chunk) => { out += String(chunk); });
        let emitted = 0;
        const proc = {
          status: 'running',
          exitCode: null,
          signal: null,
          done: new Promise((resolve) => {
            child.on('close', (code, signal) => {
              // Windows 上 kill() 终止的子进程 close 事件给 code=1、signal=null
              //（信号是 POSIX 语义）。宿主 shell 层对主动 kill 报告信号名——本装置
              // 按同一契约仿真：killRequested 时报告 SIGTERM/killed/无退出码。
              const killedByRequest = killRequested && signal === null;
              proc.exitCode = killedByRequest ? null : code;
              proc.signal = killedByRequest ? 'SIGTERM' : signal;
              proc.status = proc.signal !== null ? 'killed' : 'completed';
              resolve(proc);
            });
            child.on('error', () => {
              proc.status = 'failed';
              resolve(proc);
            });
          }),
          observed: {
            stdout: { readFrom: (from) => ({ text: out.slice(Math.max(0, from)), nextOffset: out.length, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
          },
          readOutput: () => {
            const delta = emitted === 0 ? out : '';
            emitted += 1;
            return { delta, lossy: false };
          },
          kill: () => { killRequested = true; child.kill('SIGTERM'); }
        };
        return Promise.resolve(proc);
      }
    },
    shellEnv: { collect: () => '' }
  };
  const config = resolveConfig({
    toolName: 'async_run', minYieldMs: 1, defaultYieldMs: 20, maxYieldMs: 1000
  });
  const runTool = checkedTool(buildRunTool(adapter, config));
  return {
    ctx, detach, injections, parent, runTool,
    exec: () => ({ agent: parent, signal: new AbortController().signal }),
    setScript: (code) => { script = code; },
    dispose: async () => { await ctx.jobs.disposeAll(); detach(); }
  };
}

hostTest('T7 真实通道：后台 node 退出 3 与 kill 终止的完成消息带真实退出码/信号（双锚）', async () => {
  const rig = await t7Rig();
  try {
    // 退出 3：150 ms 后退出，超出 20 ms 首次预算 → 转后台；轮询真注册表至终态。
    rig.setScript('setTimeout(function(){process.exit(3)},150)');
    const handle = await rig.runTool.execute(
      { command: 'node exit-3', description: 'exit 3 after 150ms', yield_ms: 20 }, rig.exec()
    );
    assert.equal(handle.status, 'running', '前置：预算内未结算，转后台（真实进程仍在跑）');
    let row = null;
    for (let i = 0; i < 100 && row === null; i += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      const found = rig.ctx.jobs.list(rig.parent.id).find((candidate) => candidate?.id === handle.job_id);
      if (found !== undefined && ['completed', 'killed', 'failed'].includes(found.status)) row = found;
    }
    assert.ok(row !== null, '5 秒内轮询到终态（不等保活链 60 秒周期）');
    await ledger.readSettled(handle.job_id);
    assert.equal(rig.injections.length, 1, '无活等待→完成消息恰一条（忙路径 inject）');
    const text = textOf(rig.injections[0]);
    // 真实 dsh-jobs 的 JobView 不带 exitCode/signal 独立字段（终态缘由在
    // detail 文本：`exit code: 3`）——真实通道上退出码经诊断行可见；结构化
    // 字段与方括号标记行由携带结构化终态事实的行触发（T5 的受控行）。
    assert.ok(text.includes('exit code: 3'), '真实退出码 3 在完成消息（经诊断行，真实通道端到端）');

    // kill 终止：真注册表 kill 入口 → 子进程终止 → killed＋信号/缘由在消息。
    rig.setScript('setTimeout(function(){},8000)');
    const second = await rig.runTool.execute(
      { command: 'node long-run', description: 'long run for kill', yield_ms: 20 }, rig.exec()
    );
    assert.equal(second.status, 'running', '前置：长作业转后台');
    rig.ctx.jobs.kill(second.job_id, rig.parent.id, 'test-kill');
    let killedRow = null;
    for (let i = 0; i < 100 && killedRow === null; i += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      const found = rig.ctx.jobs.list(rig.parent.id).find((candidate) => candidate?.id === second.job_id);
      if (found !== undefined && ['completed', 'killed', 'failed'].includes(found.status)) killedRow = found;
    }
    assert.ok(killedRow !== null, 'kill 后 5 秒内到终态');
    await ledger.readSettled(second.job_id);
    const killText = textOf(rig.injections[1]);
    assert.ok(killText.includes('SIGTERM') || killText.includes('信号'), '真实终止信号在完成消息');
    assert.ok(killText.includes('killed') || killText.includes('已终止'), 'killed 状态可见');
    assert.ok(killText.includes('test-kill'), 'kill 缘由（killReason 并入 detail）可见');
  } finally {
    await rig.dispose();
  }
});
