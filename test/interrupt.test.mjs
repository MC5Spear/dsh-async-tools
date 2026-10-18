/**
 * 唤醒与活动信号的单测（对应 `docs/design.md` §2.2 消息集合和入口扫描、需求 §2.1.2）。
 *
 * 本文件的核心价值：把四条陷阱固化成回归测试——
 * **插件注入的通知 `role` 也是 `user`，所以唤醒判定只能用 `source.kind`/`source.form`；**
 * **queue 与 steer 两种落点都触发 `agent/inbox/inserted`，只有 next-step（插话位）唤醒（需求 §2.1.2）；**
 * **上下文形态（instructions/catalog/snapshot/recall）与无 form 的消息不因角色为 user 就唤醒；**
 * **本包迟到作答通知走专门分支，通用唤醒对它不重复命中（同一消息不产生两个竞争说明）。**
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { watchLateAnswer, watchSubagentActivity, watchWakeSignal, preexistingWakeMessage, classifyWake, wakesWait, unclaimedSettlement, LATE_ANSWER_EVENT, LATE_ANSWER_SOURCE } from '../lib/interrupts.js';
import { fakeAgent, fakeCtx, inboxPayload } from './_helpers.mjs';

const CHILD = 'child-42';

// ── 唤醒判定单元（设计 §2.2 规则 3 的单一事实源）────────────────────────────

test('wakesWait/classifyWake：user 插话命中 via=user，summary 缺席为空串', () => {
  assert.equal(wakesWait({ source: { kind: 'user' } }), true, 'user 插话命中');
  const wake = classifyWake({ id: 'm1', source: { kind: 'user' } });
  assert.deepEqual(wake, { kind: 'wake', via: 'user', messageId: 'm1', summary: '' });
});

test('wakesWait/classifyWake：form notice / relay 命中（结算通知与转达消息参与唤醒）', () => {
  assert.equal(wakesWait({ source: { kind: 'subagent-settled', form: 'notice' } }), true);
  assert.equal(wakesWait({ source: { kind: 'agent-message', form: 'relay' } }), true);
  const wake = classifyWake({ id: 'm2', source: { kind: 'subagent-settled', form: 'notice', summary: 'child done' } });
  assert.equal(wake.via, 'notice', 'via 取 form');
  assert.equal(wake.summary, 'child done', 'source.summary 透传');
});

test('classifyWake：summary 空档兜底——relay/notice 无摘要给最小描述，user 维持空串（盲测第二轮发现④）', () => {
  // "A processable message arrived ()" 的括号空置不满足需求 §2.1.3（结束
  // 原因清楚可见）；user 插话的 summary 不进任何渲染模板，维持既有空串契约。
  const relayEn = classifyWake({ id: 'm3', source: { kind: 'agent-message', form: 'relay' } }, 'en');
  assert.equal(relayEn.via, 'relay');
  assert.ok(relayEn.summary.length > 0 && /^[A-Za-z]/.test(relayEn.summary), `en 兜底为可读英文短语（实得 ${JSON.stringify(relayEn.summary)}）`);
  const relayZh = classifyWake({ id: 'm4', source: { kind: 'agent-message', form: 'relay' } }, 'zh');
  assert.ok(relayZh.summary.length > 0 && relayZh.summary !== relayEn.summary, 'zh 兜底为中文短语（两语言独立）');
  const noticeBlank = classifyWake({ id: 'm5', source: { kind: 'x', form: 'notice', summary: '   ' } }, 'en');
  assert.ok(noticeBlank.summary.length > 0, '纯空白 summary 视同缺席，同样兜底');
  const user = classifyWake({ id: 'm6', source: { kind: 'user' } }, 'en');
  assert.equal(user.summary, '', 'user 插话不兜底（维持既有契约）');
});

test('wakesWait：上下文形态不命中——kind 为 user 也不唤醒', () => {
  for (const form of ['instructions', 'catalog', 'snapshot', 'recall']) {
    assert.equal(wakesWait({ source: { kind: 'user', form } }), false, `form=${form} 是上下文，不唤醒`);
  }
});

test('wakesWait：无 form 的插件消息与本包迟到作答通知不命中（专门分支供应）', () => {
  assert.equal(wakesWait({ source: { kind: 'plugin' } }), false, '无 form 的工具结果上下文不唤醒');
  assert.equal(wakesWait({ source: { kind: LATE_ANSWER_SOURCE, form: 'notice' } }), false, '迟到作答走专门分支，通用判定不重复命中');
});

// ── watchWakeSignal（事件侧）────────────────────────────────────────────────

test('watchWakeSignal：user 插话落在 next-step → 唤醒 via=user', async () => {
  const { ctx, emit } = fakeCtx();
  const agent = fakeAgent();
  const watcher = watchWakeSignal(ctx, agent);

  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '停一下', target: 'next-step' }));
  const outcome = await watcher.promise;
  assert.equal(outcome.kind, 'wake');
  assert.equal(outcome.via, 'user');
  watcher.dispose();
});

test('watchWakeSignal：notice / relay 落在 next-step → 唤醒并带 via（§2.2 集合扩展）', async () => {
  const { ctx, emit } = fakeCtx();
  const agent = fakeAgent();
  const watcher = watchWakeSignal(ctx, agent);

  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: 'subagent-settled', form: 'notice', summary: 'child-9 finished',
    text: 'Background subagent child-9 finished.', target: 'next-step'
  }));
  const outcome = await watcher.promise;
  assert.equal(outcome.via, 'notice', '结算通知作为一次性通知唤醒（via=notice）');
  assert.equal(outcome.summary, 'child-9 finished');
  watcher.dispose();

  const watcher2 = watchWakeSignal(ctx, agent);
  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: 'agent-message', form: 'relay', text: 'Agent child-9 sent a message: progress', target: 'next-step'
  }));
  const outcome2 = await watcher2.promise;
  assert.equal(outcome2.via, 'relay', '代理转达唤醒（via=relay）');
  watcher2.dispose();
});

test('watchWakeSignal：上下文形态与无 form 消息即使落在 next-step 也不唤醒（×R12，M3 守卫）', async () => {
  // 真机上 deferContext 的上下文消息（工具结果等）恰恰 splice 进 **next-step**
  // （dsh-agent-loop:1154）。所以本用例的非命中消息**必须带 `target: 'next-step'`**——
  // 不带 target 的消息在假件里不落任何列表，测的只是"落点判定"，盖不住这条线
  // （详见 _helpers.mjs 的 inboxPayload 注释）。
  const { ctx, emit } = fakeCtx();
  const agent = fakeAgent();
  const watcher = watchWakeSignal(ctx, agent);

  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'plugin', text: 'tool result context', target: 'next-step' }));
  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', form: 'catalog', text: 'catalog snapshot', target: 'next-step' }));
  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', form: 'recall', text: 'recall context', target: 'next-step' }));
  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: LATE_ANSWER_SOURCE, form: 'notice', summary: 's', text: '[迟到应答]', target: 'next-step'
  }));

  const race = await Promise.race([
    watcher.promise.then(() => 'woken'),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 20))
  ]);
  assert.equal(race, 'still-waiting',
    '工具上下文/目录快照/召回/迟到作答都不得唤醒——专门分支与上下文排除是真机上承重的一线');

  // watcher 活性半句：真插话（user + next-step）仍必须唤醒，
  // 否则上面的"不唤醒"与"监听器坏了"无法区分。
  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '真插话', target: 'next-step' }));
  const outcome = await watcher.promise;
  assert.equal(outcome.via, 'user');
  watcher.dispose();
});

test('watchWakeSignal：排队消息（next-turn）不唤醒等待（R12）', async () => {
  const { ctx, emit } = fakeCtx();
  const agent = fakeAgent();
  const watcher = watchWakeSignal(ctx, agent);

  // queue 落点（next-turn）：它只在轮次边界投递，本轮内模型看不到，
  // 唤醒它只会产生"看得见通知、看不见内容"的悬空回合——必须不唤醒。
  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '排队消息', target: 'next-turn' }));
  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: 'subagent-settled', form: 'notice', text: 'settled', target: 'next-turn'
  }));
  const race = await Promise.race([
    watcher.promise.then(() => 'woken'),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 20))
  ]);
  assert.equal(race, 'still-waiting', '排队（queue）消息不得唤醒等待（R12）');

  // 同一个 watcher 仍然活着：随后一条真正的插话（next-step）必须能唤醒。
  // 没有这半句，上一条的"不唤醒"与"监听器坏了"无法区分。
  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '插话', target: 'next-step' }));
  const outcome = await watcher.promise;
  assert.equal(outcome.via, 'user');
  watcher.dispose();
});

test('watchWakeSignal：inbox 不可读时不唤醒（宁可不少等，不可错唤醒）', async () => {
  const { ctx, emit } = fakeCtx();
  // 仿"拿不到完整 Agent 句柄"的退化环境：没有 inbox 可查。
  const agent = { id: 'session-1', session: { header: { cwd: 'D:\\work' } } };
  const watcher = watchWakeSignal(ctx, agent);

  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '插话' }));
  const race = await Promise.race([
    watcher.promise.then(() => 'woken'),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 20))
  ]);
  assert.equal(race, 'still-waiting', 'inbox 不可读时按"不唤醒"处理（等待仍有界，不至于错唤醒）');
  watcher.dispose();
});

test('watchWakeSignal：只对目标 agent 的消息触发', async () => {
  const { ctx, emit } = fakeCtx();
  const agent = fakeAgent('parent-1');
  const other = fakeAgent('parent-2');
  const watcher = watchWakeSignal(ctx, agent);

  emit('agent/inbox/inserted', inboxPayload({ agent: other, sourceKind: 'user', text: '别人的消息' }));
  const race = await Promise.race([
    watcher.promise.then(() => 'woken'),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 20))
  ]);
  assert.equal(race, 'still-waiting');
  watcher.dispose();
});

test('watchWakeSignal：dispose 后监听器被移除', () => {
  const { ctx, count } = fakeCtx();
  const watcher = watchWakeSignal(ctx, fakeAgent());
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

// ── 迟到作答唤醒分支（第四类信号；插件事件 + 起始检查）──────────────────────

/** 判一个信号 promise 是否仍悬着（未 resolve）。 */
async function stillPending(promise) {
  return Promise.race([
    promise.then(() => false, () => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 20))
  ]);
}

/** 构造一条迟到作答到达事件的载荷（作答/忽略同形，需求 §4.4）。 */
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

test('watchLateAnswer：起始检查——作答先到、等待后开也立即命中（R30 通道轮，真机实测记录）', async () => {
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

test('watchLateAnswer：起始检查 inbox getter 抛错按空承接（不得把信号 promise 变 reject）', async () => {
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
  // 事件侧不受影响：后续到达照常唤醒。
  emit(LATE_ANSWER_EVENT, lateEventPayload({ agentId: agent.id, summary: '问题 color 的迟到作答：red' }));
  const signal = await watcher.promise;
  assert.equal(signal.summary, '问题 color 的迟到作答：red', '事件通道照常命中');
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

test('（R30-d 互斥联测，通道轮）迟到作答专门分支与通用唤醒分家——同一消息不产生两个竞争说明', async () => {
  const { ctx, emit } = fakeCtx();
  const agent = fakeAgent();
  const wake = watchWakeSignal(ctx, agent);
  const activity = watchSubagentActivity(ctx, agent, CHILD);
  const late = watchLateAnswer(ctx, agent);
  const pendings = {
    wake: wake.promise,
    settled: activity.settled,
    activity: activity.activity,
    late: late.promise
  };

  // ① 迟到作答到达（插件事件）：只有专门分支 resolve；同 kind 的宿主插入事件
  //    （即使有人伪造）对其他通道也只是无害噪声——通用唤醒对本包 kind 不命中。
  emit(LATE_ANSWER_EVENT, lateEventPayload({ agentId: agent.id }));
  assert.equal((await pendings.late).kind, 'late-answer');
  for (const key of ['wake', 'settled', 'activity']) {
    assert.ok(await stillPending(pendings[key]), `迟到作答事件不得触发 ${key}`);
  }
  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: LATE_ANSWER_SOURCE, form: 'notice', summary: 's', text: '[迟到应答]'
  }));
  for (const key of ['wake', 'settled', 'activity']) {
    assert.ok(await stillPending(pendings[key]), `本包 kind 的宿主插入事件不得触发 ${key}（互斥由载体分家保证）`);
  }

  // ② 用户插话：只有通用唤醒 resolve（via=user）。
  const late2 = watchLateAnswer(ctx, agent);
  emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '停', target: 'next-step' }));
  assert.equal((await pendings.wake).via, 'user');
  assert.ok(await stillPending(pendings.settled), '插话不得误报 settled');
  assert.ok(await stillPending(pendings.activity), '插话不得触发转达唤醒');
  assert.ok(await stillPending(late2.promise), '插话不得触发迟到唤醒分支');
  late2.dispose();

  // ③ 子代理结算通知：结算专门通道 resolve，通用唤醒同拍命中 via=notice——
  //    双通道并存是设计（§2.2：结算通知同时是唤醒集合成员），等待侧用优先级
  //    定胜负，不在信号层去重。（wake 通道在②已消费，此处新建一个验证。）
  const wake3 = watchWakeSignal(ctx, agent);
  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: 'subagent-settled', form: 'notice', senderSessionId: CHILD, text: 'finished', target: 'next-step'
  }));
  assert.equal((await pendings.settled).kind, 'settled');
  assert.equal((await wake3.promise).via, 'notice', '结算通知同时命中通用唤醒（双通道）');
  assert.ok(await stillPending(pendings.activity), '结算不得触发转达唤醒');
  wake3.dispose();

  // ④ 转达消息：转达通道 resolve，通用唤醒同拍命中 via=relay。
  const wake2 = watchWakeSignal(ctx, agent);
  emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: 'agent-message', form: 'relay', text: `Agent ${CHILD} sent a message`, target: 'next-step'
  }));
  assert.equal((await pendings.activity).kind, 'activity');
  assert.equal((await wake2.promise).via, 'relay', '转达消息同时命中通用唤醒（双通道）');

  wake.dispose();
  wake2.dispose();
  activity.dispose();
  late.dispose();
});

// ── 起始检查的读侧单元（设计 §2.2 入口扫描；工具级行为在各工具文件） ──

test('preexistingWakeMessage（R55）：nextStep 已有 user 插话 → 命中该消息（user 优先）', () => {
  const agent = fakeAgent();
  agent.inbox.nextStep.push(
    { id: 'm1', source: { kind: 'agent-message', form: 'relay' } },
    { id: 'm2', source: { kind: 'user' } }
  );
  const hit = preexistingWakeMessage(agent);
  assert.equal(hit?.id, 'm2', 'user 插话优先于 notice/relay——同列并存按插话口径交回');
});

test('preexistingWakeMessage（R55）：转达/结算通知在 next-step 命中（§2.2 集合扩展），迟到作答与上下文不命中', () => {
  const agent = fakeAgent();
  agent.inbox.nextStep.push(
    { id: 'm1', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: CHILD, summary: 'done' } },
    { id: 'm2', source: { kind: LATE_ANSWER_SOURCE, form: 'notice', summary: 's', questionId: 'q' } },
    { id: 'm3', source: { kind: 'user', form: 'catalog' } },
    { id: 'm4', source: { kind: 'plugin' } }
  );
  const hit = preexistingWakeMessage(agent);
  assert.equal(hit?.id, 'm1', '结算通知命中先到扫描（via=notice）；迟到作答/上下文/无 form 不命中');
  assert.equal(classifyWake(hit)?.via, 'notice');
});

test('preexistingWakeMessage（R55）：next-turn 的 user 排队消息不命中（排队不唤醒，R12 不回归）', () => {
  const agent = fakeAgent();
  agent.inbox.nextTurn.push({ id: 'm1', source: { kind: 'user' } });
  assert.equal(preexistingWakeMessage(agent), null, '只扫 nextStep——排队消息本轮内到不了模型手里');
});

test('preexistingWakeMessage（R55）：inbox 缺席或 getter 抛错按"无先到消息"（宁可多等，不可错唤醒）', () => {
  assert.equal(preexistingWakeMessage({ id: 'session-1' }), null, 'inbox 缺席不抛错、不命中');
  const agent = fakeAgent();
  Object.defineProperty(agent, 'inbox', {
    configurable: true,
    get() { throw new Error('projection registration is not active'); }
  });
  assert.equal(preexistingWakeMessage(agent), null, 'getter 抛错按空承接');
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

// ── 列表 getter 抛错的保守承接 ──
// inbox getter 抛错的保守路径上面的用例已盖；这里补**列表** getter（nextStep /
// nextTurn 读取本身抛错）——撤掉保守 try 后 getter 抛错会穿透，用例直接红。

test('preexistingWakeMessage（R56）：nextStep 列表 getter 抛错按"无先到消息"（不可读按无）', () => {
  const agent = fakeAgent();
  Object.defineProperty(agent.inbox, 'nextStep', {
    configurable: true,
    get() { throw new Error('unreadable nextStep'); }
  });
  assert.equal(preexistingWakeMessage(agent), null, '列表 getter 抛错按空承接——宁可多等，不可错唤醒');
});

test('unclaimedSettlement（R56）：nextStep / nextTurn 列表 getter 抛错按"无结算通知"（不升格）', () => {
  const agent = fakeAgent();
  Object.defineProperty(agent.inbox, 'nextTurn', {
    configurable: true,
    get() { throw new Error('unreadable nextTurn'); }
  });
  assert.equal(unclaimedSettlement(agent, CHILD), null, 'nextTurn getter 抛错按无结算通知（nextStep 正常读取也不升格）');
  const agent2 = fakeAgent();
  Object.defineProperty(agent2.inbox, 'nextStep', {
    configurable: true,
    get() { throw new Error('unreadable nextStep'); }
  });
  assert.equal(unclaimedSettlement(agent2, CHILD), null, 'nextStep getter 抛错同样按无结算通知');
});
