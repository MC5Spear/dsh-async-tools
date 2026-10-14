/**
 * 一次性交付在**真实注册表**上的回归（判据 1/2/3；需求 §2.2.3、设计 §2.4）。
 *
 * 与 `test/wait-job.test.mjs` 的分工：那边是替身单元（分隔/裁剪/lossy/读失败的
 * 精确文本断言），这边用真 Cordis ＋ 真 rc.2 `LocalJobRegistry`——注册表的一次性
 * `resultDelivered`、消费式游标、settled 截流都不是替身模拟的。受控点只有一个：
 * workflow 引擎何时结算（与外部保留的独立探针同构，但断言的是正向
 * 行为：最终 JSON 必须出现在模型可见输出里，恰一次）。
 *
 * 宿主包不可解析（离线环境/CI）时整文件跳过——跳过不是通过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowTool } from '../lib/workflow.js';
import { createWaitJobTool } from '../lib/wait-job.js';
import { resolveConfig } from '../lib/config.js';
import { checkedTool } from './_helpers.mjs';

let Context;
let LocalJobRegistry;
try {
  ({ Context } = await import('@deepseek-ai/cordis'));
  ({ LocalJobRegistry } = await import('@deepseek-ai/dsh-jobs-local'));
} catch {
  Context = undefined;
}
const defineTest = Context === undefined
  ? (name, _fn) => test(name, (t) => { t.skip('宿主包不可解析（离线环境），本用例跳过'); })
  : (name, fn) => test(name, fn);

/**
 * 组装被测环境：真 Context + 真 LocalJobRegistry + 受控引擎替身。
 * `finisher()` 让引擎以 completed 结算（value 带 `AT_FINAL_PAYLOAD` 标记）。
 */
async function buildRig(label) {
  const base = new Context();
  const parent = {
    id: `at-r57-${label}-${Math.random().toString(36).slice(2, 8)}`,
    ctx: base,
    // session.header.cwd 不携带机器路径：本 rig 只用 workflow/wait 工具，无人消费 cwd
    //（盘符字面量在交付范围代码里受判据 12 管辖）。
    session: { append() {} },
    inbox: { nextStep: [], nextTurn: [] }
  };
  base.provide('agents', { get: (id) => (id === parent.id ? parent : undefined) });
  await base.plugin(LocalJobRegistry, {
    maxConcurrentJobsPerOwner: 10, retainBytes: 1048576, settledRetainBytes: 1048576, pumpPollMs: 10
  });
  const ctx = await new Promise((resolve) => {
    base.inject(['jobs'], async (c) => resolve(c));
  });
  const detach = ctx.jobs.attachController(`at-r57-${label}`);
  let finish;
  const engine = {
    start(spec) {
      return {
        id: `at-r57-run-${label}`,
        meta: spec.meta,
        result: new Promise((resolve) => { finish = resolve; }),
        cancel() {},
        dispose: async () => {}
      };
    }
  };
  const adapter = {
    jobs: ctx.jobs,
    on: (...args) => ctx.on(...args),
    get: () => engine,
    logger: { info() {}, warn() {} },
    timer: {
      timeout: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
      interval: (fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); }
    }
  };
  const config = resolveConfig({ toolName: 'async_workflow', minYieldMs: 1, defaultYieldMs: 20, maxYieldMs: 1000 });
  const workflow = checkedTool(createWorkflowTool(adapter, config));
  const waiter = checkedTool(createWaitJobTool(adapter, config));
  const exec = () => ({ agent: parent, signal: new AbortController().signal });
  return {
    ctx,
    parent,
    workflow,
    waiter,
    exec,
    finisher: () => finish({ stopReason: 'completed', agentsStarted: 0, value: { proof: 'AT_FINAL_PAYLOAD' } }),
    dispose: async () => { await ctx.jobs.disposeAll(); detach(); }
  };
}

const WF_ARGS = {
  script: 'return {proof:"AT_FINAL_PAYLOAD"}',
  meta: { name: 'at-r57-recovery', description: 'R57 final-result delivery regression' },
  yield_ms: 20
};

defineTest('R57 真实注册表①：workflow 先让出，wait 覆盖结算 → 最终 JSON 在返回中出现恰一次', async () => {
  const rig = await buildRig('yield');
  try {
    const first = await rig.workflow.execute(WF_ARGS, rig.exec());
    assert.equal(first.status, 'running', '前置：20 ms 让出窗口内引擎悬置 → 句柄');
    assert.equal(rig.ctx.jobs.list(rig.parent.id)[0].status, 'running');

    const pending = rig.waiter.execute({ job_id: first.job_id, wait_ms: 500 }, rig.exec());
    rig.finisher();
    const recovered = await pending;

    assert.equal(recovered.status, 'completed');
    assert.ok(recovered.output.includes('AT_FINAL_PAYLOAD'),
      '最终 JSON 必须出现在模型可见输出里（一次消费通道被本次返回兑现）');
    assert.equal(recovered.output.split('AT_FINAL_PAYLOAD').length, 2,
      '恰一次：同一返回内不得重复拼接最终结果');
    assert.ok(recovered.output.includes('workflow "at-r57-recovery" completed'),
      '结算文本为宿主同形渲染（含 workflow 名与 agent 计数行）');

    // 恰一次：一次性通道已被上面的交付消费，后续读取不得重复。
    const rawNext = rig.ctx.jobs.read(first.job_id, rig.parent.id);
    assert.equal(rawNext.result, undefined, '注册表裸读不再有 result（一次性通道已消费）');
    const again = await rig.waiter.execute({ job_id: first.job_id, wait_ms: 500 }, rig.exec());
    assert.equal(again.status, 'completed');
    assert.equal(again.output, '', '交付后的再次读取不重复最终结果（游标已到尾、result 已交）');
  } finally {
    await rig.dispose();
  }
});

defineTest('R57 真实注册表②：workflow 已结算后再 wait → 最终 JSON 仍可见（入口已终态分支）', async () => {
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

    const recovered = await rig.waiter.execute({ job_id: first.job_id, wait_ms: 500 }, rig.exec());
    assert.equal(recovered.status, 'completed');
    assert.ok(recovered.output.includes('AT_FINAL_PAYLOAD'),
      '入口已终态分支同样交付一次性 result——屏障命中路径不丢');
  } finally {
    await rig.dispose();
  }
});

defineTest('R57 真实注册表③：无 result 的普通命令作业——增量文本行为不变', async () => {
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

    const first = await rig.waiter.execute({ job_id: jobId, wait_ms: 500 }, rig.exec());
    assert.equal(first.status, 'completed');
    assert.equal(first.output, 'hello from cmd\n', '无 result 的作业：输出＝chunks 增量，不多不少');
    assert.equal(first.truncated, false);

    const second = await rig.waiter.execute({ job_id: jobId, wait_ms: 500 }, rig.exec());
    assert.equal(second.output, '', '消费式游标：第二次读取无新增量（行为不变）');
  } finally {
    await rig.dispose();
  }
});
