/**
 * 插话与活动信号的单测（对应 `docs/design.md` §7、需求 R12）。
 *
 * 本文件的核心价值：把两条陷阱固化成回归测试——
 * **插件注入的通知 `role` 也是 `user`，所以插话判定只能用 `source.kind`；**
 * **queue 与 steer 两种落点都触发 `agent/inbox/inserted`，只有 next-step（插话）打断（R12）。**
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { watchLateAnswer, watchSubagentActivity, watchUserInterrupt, preexistingSteering, unclaimedSettlement, LATE_ANSWER_EVENT, LATE_ANSWER_SOURCE } from '../lib/interrupts.js';
import { fakeAgent, fakeCtx, inboxPayload } from './_helpers.mjs';

const CHILD = 'child-42';

test('watchUserInterrupt：只认 source.kind === "user" 且落在 next-step（插话）', async () => {
  const { ctx, emit } = fakeCtx();
  const agent = fakeAgent();
  const watcher = watchUserInterrupt(ctx, agent);

  // 插件注入的消息：role 是 user，但 kind 不是 —— 必须被忽略。
  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'subagent-settled', form: 'notice', text: 'child-1 finished' }));
  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'agent-message', form: 'relay', text: 'Agent child-1 sent a message' }));
  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'plugin', text: 'notice' }));

  const race = await Promise.race([
    watcher.promise.then(() => 'interrupted'),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 20))
  ]);
  assert.equal(race, 'still-waiting', '插件通知和转达消息不得被当作用户插话');

  // steer 落点（next-step）：打断（R12 的正向路径）。
  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '停一下', target: 'next-step' }));
  const outcome = await watcher.promise;
  assert.equal(outcome.kind, 'interrupted');
  watcher.dispose();
});

test('watchUserInterrupt：排队消息（next-turn）不打断等待（R12）', async () => {
  const { ctx, emit } = fakeCtx();
  const agent = fakeAgent();
  const watcher = watchUserInterrupt(ctx, agent);

  // queue 落点（next-turn）：它只在轮次边界投递，本轮内模型看不到，
  // 打断它只会产生"看得见通知、看不见内容"的悬空回合——必须不打断。
  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '排队消息', target: 'next-turn' }));
  const race = await Promise.race([
    watcher.promise.then(() => 'interrupted'),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 20))
  ]);
  assert.equal(race, 'still-waiting', '排队（queue）消息不得打断等待（R12）');

  // 同一个 watcher 仍然活着：随后一条真正的插话（next-step）必须能打断。
  // 没有这半句，上一条的"不打断"与"监听器坏了"无法区分。
  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '插话', target: 'next-step' }));
  const outcome = await watcher.promise;
  assert.equal(outcome.kind, 'interrupted');
  watcher.dispose();
});

test('watchUserInterrupt：inbox 不可读时不打断（宁可不少等，不可错打断）', async () => {
  const { ctx, emit } = fakeCtx();
  // 仿"拿不到完整 Agent 句柄"的退化环境：没有 inbox 可查。
  const agent = { id: 'session-1', session: { header: { cwd: 'D:\\work' } } };
  const watcher = watchUserInterrupt(ctx, agent);

  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '插话' }));
  const race = await Promise.race([
    watcher.promise.then(() => 'interrupted'),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 20))
  ]);
  assert.equal(race, 'still-waiting', 'inbox 不可读时按"不是插话"处理（等待仍有界，不至于错打断）');
  watcher.dispose();
});

test('watchUserInterrupt：非 user 的消息即使落在 next-step 也不打断（×R12，M3 守卫）', async () => {
  // 缺陷形态：R12 收窄后，`source.kind !== 'user'` 的过滤
  // 看起来"被 isSteering 顺带覆盖"——但真机上 deferContext 的上下文消息（工具结果、
  // **subagent-settled 结算通知**）恰恰 splice 进 **next-step**（dsh-agent-loop:1118）。
  // 删掉 kind 过滤 ⇒ 这些消息全部通过 isSteering ⇒ async_wait_agent 被自己的
  // 结算通知打断、每次工具结果上下文都打断等待。
  //
  // 所以本用例的非 user 消息**必须带 `target: 'next-step'`**——不带 target 的消息
  // 在假件里不落任何列表，测的只是"落点判定"，盖不住这条线（详见 _helpers.mjs
  // 的 inboxPayload 注释）。
  const { ctx, emit } = fakeCtx();
  const agent = fakeAgent();
  const watcher = watchUserInterrupt(ctx, agent);

  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: 'subagent-settled', form: 'notice',
    text: 'Background subagent child-9 finished.', target: 'next-step'
  }));
  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: 'agent-message', form: 'relay',
    text: 'Agent child-9 sent a message: progress', target: 'next-step'
  }));
  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: 'plugin', text: 'tool result context', target: 'next-step'
  }));

  const race = await Promise.race([
    watcher.promise.then(() => 'interrupted'),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 20))
  ]);
  assert.equal(race, 'still-waiting',
    '非 user 的 next-step 消息（结算通知/转达/工具上下文）不得打断——kind 过滤是真机上承重的一线');

  // watcher 活性半句：真插话（user + next-step）仍必须打断，
  // 否则上面的"不打断"与"监听器坏了"无法区分。
  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '真插话', target: 'next-step' }));
  const outcome = await watcher.promise;
  assert.equal(outcome.kind, 'interrupted');
  watcher.dispose();
});

test('watchUserInterrupt：只对目标 agent 的消息触发', async () => {
  const { ctx, emit } = fakeCtx();
  const agent = fakeAgent('parent-1');
  const other = fakeAgent('parent-2');
  const watcher = watchUserInterrupt(ctx, agent);

  emit('agent/inbox/inserted', inboxPayload({ agent: other, sourceKind: 'user', text: '别人的消息' }));
  const race = await Promise.race([
    watcher.promise.then(() => 'interrupted'),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 20))
  ]);
  assert.equal(race, 'still-waiting');
  watcher.dispose();
});

test('watchUserInterrupt：dispose 后监听器被移除', () => {
  const { ctx, count } = fakeCtx();
  const watcher = watchUserInterrupt(ctx, fakeAgent());
  assert.equal(count('agent/inbox/inserted'), 1);
  watcher.dispose();
  assert.equal(count('agent/inbox/inserted'), 0, 'disposer 必须真的摘掉监听器（R4 可逆性）');
});

test('watchSubagentActivity：结算通知只在文本含目标 id 时结算', async () => {
  const { ctx, emit } = fakeCtx();
  const agent = fakeAgent();
  const watcher = watchSubagentActivity(ctx, agent, CHILD);

  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: 'subagent-settled', form: 'notice', text: 'Background subagent other-child finished.'
  }));
  const race = await Promise.race([
    watcher.settled.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 20))
  ]);
  assert.equal(race, 'still-waiting', '别的子代理的结算通知不得结束本次等待');

  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: 'subagent-settled', form: 'notice',
    text: `Background subagent ${CHILD} finished and will do no further work unless you send it more. Its closing message: done`
  }));
  const outcome = await watcher.settled;
  assert.equal(outcome.kind, 'settled');
  watcher.dispose();
});

test('watchSubagentActivity：agent-message 只作为唤醒信号，不作为结束信号', async () => {
  const { ctx, emit } = fakeCtx();
  const agent = fakeAgent();
  const watcher = watchSubagentActivity(ctx, agent, CHILD);

  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: 'agent-message', form: 'relay', text: `Agent ${CHILD} sent a message:  progress`
  }));

  const activity = await watcher.activity;
  assert.equal(activity.kind, 'activity');

  const race = await Promise.race([
    watcher.settled.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 20))
  ]);
  assert.equal(race, 'still-waiting', '转达消息不是结束信号');
  watcher.dispose();
});

test('watchSubagentActivity：dispose 摘掉监听器；唤醒信号只发一次', async () => {
  const { ctx, emit, count } = fakeCtx();
  const agent = fakeAgent();
  const watcher = watchSubagentActivity(ctx, agent, CHILD);

  for (let i = 0; i < 3; i++) {
    emit('agent/inbox/inserted', inboxPayload({
      agent, sourceKind: 'agent-message', form: 'relay', text: `Agent ${CHILD} sent a message:  ${i}`
    }));
  }
  const first = await watcher.activity;
  assert.equal(first.kind, 'activity');

  watcher.dispose();
  assert.equal(count('agent/inbox/inserted'), 0);
});

// ── R30-d 唤醒分支（第四类信号，§32.5；通道轮：插件事件 + 起始检查）──────────

/** 判一个信号 promise 是否仍悬着（未 resolve）。 */
async function stillPending(promise) {
  return Promise.race([
    promise.then(() => false, () => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 20))
  ]);
}

/** 构造一条迟到作答到达事件的载荷（作答/忽略同形，§32.5）。 */
function lateEventPayload({ agentId = 'session-1', questionId = 'color', kind = 'answer', summary = '问题 color 的迟到作答：red' } = {}) {
  return { agentId, questionId, kind, summary };
}

test('watchLateAnswer：插件事件唤醒——agentId 过滤 + summary/qid 透传（R30 通道轮）', async () => {
  const { ctx, emit, listeners } = fakeCtx();
  const agent = fakeAgent();
  const watcher = watchLateAnswer(ctx, agent);

  // 别的 agent 的作答事件一概不触发。
  emit(LATE_ANSWER_EVENT, lateEventPayload({ agentId: 'session-other' }));
  // 同名前缀的宿主事件也不触发（载体是插件事件，不再是 agent/inbox/inserted）。
  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: LATE_ANSWER_SOURCE, form: 'notice',
    summary: 's', text: '[迟到应答] …'
  }));
  assert.ok(await stillPending(watcher.promise), '别人的作答/宿主插入事件不得触发唤醒分支');

  emit(LATE_ANSWER_EVENT, lateEventPayload({ agentId: agent.id, summary: '问题 color 的迟到作答：red' }));
  const signal = await watcher.promise;
  assert.equal(signal.kind, 'late-answer');
  assert.equal(signal.summary, '问题 color 的迟到作答：red', 'summary 透传（唤醒 note 据此指明题号）');
  assert.equal(signal.qid, 'color', 'qid 透传（事件载荷的题号）');
  watcher.dispose();
  assert.equal(listeners.get(LATE_ANSWER_EVENT)?.length ?? 0, 0, 'dispose 摘除插件事件监听');
});

test('watchLateAnswer：起始检查——作答先到、等待后开也立即命中（R30 通道轮，真机实录）', async () => {
  const { ctx } = fakeCtx();
  // 待读登记非空：收件箱里有已投递未领取的本包通知（next-step 滞留或 next-turn 排队）。
  const agent = fakeAgent();
  agent.inbox.nextStep.push({ source: { kind: LATE_ANSWER_SOURCE, form: 'notice', summary: '问题 color 的迟到作答：red', questionId: 'color' } });
  const watcher = watchLateAnswer(ctx, agent);
  const signal = await watcher.promise; // 同步命中——无需任何事件
  assert.equal(signal.kind, 'late-answer');
  assert.equal(signal.summary, '问题 color 的迟到作答：red', '起始检查从待读登记取 summary');
  assert.equal(signal.qid, 'color', '起始检查透传题号');
  watcher.dispose();
});

test('watchLateAnswer：起始检查只认 form:notice——补醒催领条（form:reminder）不算答案（R30 通道轮）', async () => {
  const { ctx } = fakeCtx();
  const agent = fakeAgent();
  agent.inbox.nextTurn.push({ source: { kind: LATE_ANSWER_SOURCE, form: 'reminder', summary: '迟到作答领取提醒' } });
  const watcher = watchLateAnswer(ctx, agent);
  assert.ok(await stillPending(watcher.promise), '催领条不得被误读成待读作答');
  watcher.dispose();
});

test('watchLateAnswer：起始检查 inbox 缺席按空处理（宁可多等一轮，不可错唤醒）', async () => {
  const { ctx } = fakeCtx();
  const watcher = watchLateAnswer(ctx, { id: 'session-1' }); // 无 inbox 的 agent 形态
  assert.ok(await stillPending(watcher.promise), 'inbox 缺席不得抛错也不得命中');
  watcher.dispose();
});

test('watchLateAnswer：起始检查 inbox getter 抛错按空兜住（不得把信号 promise 变 reject）', async () => {
  const { ctx, emit } = fakeCtx();
  const agent = fakeAgent();
  Object.defineProperty(agent, 'inbox', {
    configurable: true,
    get() { throw new Error('projection registration is not active'); }
  });
  // 起始检查在 Promise executor 里同步执行：抛错穿透会让 promise reject、
  // 等待侧无人接 → unhandledRejection →  整实例退出。
  let watcher;
  let rejected = false;
  try {
    watcher = watchLateAnswer(ctx, agent);
  } catch {
    rejected = true;
  }
  assert.ok(!rejected, '构造不得同步抛错');
  assert.ok(await stillPending(watcher.promise), 'getter 抛错按空（宁可多等一轮）');
  // 事件面不受影响：后续到达照常唤醒。
  emit(LATE_ANSWER_EVENT, lateEventPayload({ agentId: agent.id, summary: '问题 color 的迟到作答：red' }));
  const signal = await watcher.promise;
  assert.equal(signal.summary, '问题 color 的迟到作答：red', '事件面照常命中');
  watcher.dispose();
});

test('watchLateAnswer：起始检查只认本包 notice——结算通知/前缀撞车 kind/催领条混入都不命中', async () => {
  const { ctx } = fakeCtx();
  const agent = fakeAgent();
  // 混入三类干扰：子代理结算通知（同 form 不同 kind）、前缀撞车 kind、催领条。
  agent.inbox.nextStep.push(
    { source: { kind: 'subagent-settled', form: 'notice', summary: '子代理已结算' } },
    { source: { kind: 'async-tools-late-answe', form: 'notice', summary: '前缀撞车' } },
    { source: { kind: LATE_ANSWER_SOURCE, form: 'reminder', summary: '迟到作答领取提醒' } }
  );
  const watcher = watchLateAnswer(ctx, agent);
  assert.ok(await stillPending(watcher.promise), '精确 === 判定：三类干扰都不算待读作答');
  watcher.dispose();
});

test('（R30-d 互斥联测，通道轮）四类信号各认各的载体与 kind——任一消息只落一类，绝不串台', async () => {
  const { ctx, emit } = fakeCtx();
  const agent = fakeAgent();
  const interrupt = watchUserInterrupt(ctx, agent);
  const activity = watchSubagentActivity(ctx, agent, CHILD);
  const late = watchLateAnswer(ctx, agent);
  const pendings = {
    interrupt: interrupt.promise,
    settled: activity.settled,
    activity: activity.activity,
    late: late.promise
  };

  // ① 迟到作答到达（插件事件）：只有唤醒分支 resolve；同 kind 的宿主插入事件
  //    （即使有人伪造）对其他三类也只是无害噪声。
  emit(LATE_ANSWER_EVENT, lateEventPayload({ agentId: agent.id }));
  assert.equal((await pendings.late).kind, 'late-answer');
  for (const key of ['interrupt', 'settled', 'activity']) {
    assert.ok(await stillPending(pendings[key]), `迟到作答事件不得触发 ${key}`);
  }
  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: LATE_ANSWER_SOURCE, form: 'notice', summary: 's', text: '[迟到应答]'
  }));
  for (const key of ['interrupt', 'settled', 'activity']) {
    assert.ok(await stillPending(pendings[key]), `本包 kind 的宿主插入事件不得触发 ${key}（互斥由载体分家保证）`);
  }

  // ② 用户插话：只有打断 resolve（late 已 resolve——重建一个验证插话不触 late）。
  const late2 = watchLateAnswer(ctx, agent);
  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '停', target: 'next-step' }));
  assert.equal((await pendings.interrupt).kind, 'interrupted');
  assert.ok(await stillPending(pendings.settled), '插话不得误报 settled');
  assert.ok(await stillPending(pendings.activity), '插话不得触发转达唤醒');
  assert.ok(await stillPending(late2.promise), '插话不得触发迟到唤醒分支');
  late2.dispose();

  // ③ 子代理结算：只有 settled resolve。
  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: 'subagent-settled', form: 'notice', senderSessionId: CHILD, text: 'finished'
  }));
  assert.equal((await pendings.settled).kind, 'settled');
  assert.ok(await stillPending(pendings.activity), '结算不得触发转达唤醒');

  // ④ 转达消息：只有 activity resolve。
  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: 'agent-message', form: 'relay', text: `Agent ${CHILD} sent a message`
  }));
  assert.equal((await pendings.activity).kind, 'activity');

  interrupt.dispose();
  activity.dispose();
  late.dispose();
});

// ── R55 起始检查的读侧单元（设计 §42.2 判定单元行；工具级行为在各工具文件） ──

test('preexistingSteering（R55）：nextStep 已有 user 插话 → 命中该消息', () => {
  const agent = fakeAgent();
  agent.inbox.nextStep.push(
    { id: 'm1', source: { kind: 'agent-message', form: 'relay' } },
    { id: 'm2', source: { kind: 'user' } }
  );
  const hit = preexistingSteering(agent);
  assert.equal(hit?.id, 'm2', '只认 source.kind === "user" 的那条');
});

test('preexistingSteering（R55）：转达/结算/迟到作答在 next-step 也不命中（判定与 R12 同源）', () => {
  const agent = fakeAgent();
  agent.inbox.nextStep.push(
    { id: 'm1', source: { kind: 'agent-message', form: 'relay' } },
    { id: 'm2', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: CHILD } },
    { id: 'm3', source: { kind: LATE_ANSWER_SOURCE, form: 'notice', summary: 's', questionId: 'q' } }
  );
  assert.equal(preexistingSteering(agent), null, '三类非 user 消息都不是先到插话');
});

test('preexistingSteering（R55）：next-turn 的 user 排队消息不命中（排队不打断，R12 不回归）', () => {
  const agent = fakeAgent();
  agent.inbox.nextTurn.push({ id: 'm1', source: { kind: 'user' } });
  assert.equal(preexistingSteering(agent), null, '只扫 nextStep——排队消息本轮内到不了模型手里');
});

test('preexistingSteering（R55）：inbox 缺席或 getter 抛错按"无先到插话"（宁可多等，不可错打断）', () => {
  assert.equal(preexistingSteering({ id: 'session-1' }), null, 'inbox 缺席不抛错、不命中');
  const agent = fakeAgent();
  Object.defineProperty(agent, 'inbox', {
    configurable: true,
    get() { throw new Error('projection registration is not active'); }
  });
  assert.equal(preexistingSteering(agent), null, 'getter 抛错按空兜住');
});

test('unclaimedSettlement（R55）：senderSessionId 精确命中——两个待处理列表都算未领取账本', () => {
  const agent = fakeAgent();
  agent.inbox.nextStep.push({ id: 's1', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: CHILD } });
  assert.equal(unclaimedSettlement(agent, CHILD)?.id, 's1', 'next-step 在列命中');
  const agent2 = fakeAgent();
  agent2.inbox.nextTurn.push({ id: 's2', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: CHILD } });
  assert.equal(unclaimedSettlement(agent2, CHILD)?.id, 's2', 'next-turn 在列同样命中（双列表口径）');
});

test('unclaimedSettlement（R55）：他人通知、无 senderSessionId 弱形态、inbox 缺席/抛错都不命中（不升格）', () => {
  const agent = fakeAgent();
  agent.inbox.nextStep.push(
    { id: 'o1', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'someone-else' } },
    { id: 'o2', source: { kind: 'subagent-settled', form: 'notice' } }
  );
  assert.equal(unclaimedSettlement(agent, CHILD), null, '他人 senderSessionId 与无该字段的弱形态一律不命中（正文回退不在入口做）');
  assert.equal(unclaimedSettlement({ id: 'session-1' }, CHILD), null, 'inbox 缺席按无结算通知');
  const agent2 = fakeAgent();
  Object.defineProperty(agent2, 'inbox', {
    configurable: true,
    get() { throw new Error('projection registration is not active'); }
  });
  assert.equal(unclaimedSettlement(agent2, CHILD), null, 'getter 抛错按无结算通知（不升格，按插话打断返回）');
});
