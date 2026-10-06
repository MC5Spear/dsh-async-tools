/**
 * `async_wait_agent` 工具的单测（对应 `docs/design.md` §6，需求 R3/R4）。
 *
 * 覆盖四条硬约束：
 * - **打断判定只能用 `source.kind === 'user'`**（role 陷阱）；
 * - 结算通知用 `source.senderSessionId` 精确关联，正文匹配只是降级路径；
 * - `agent/status` 的 `idle` 是可达的提前返回通道（实测）；
 * - 屏障用"这个 id 在不在父会话的子代理目录里"判存在性，**两种行形状都认**：
 *   0.1.7 的 `listChildren()` 行没有 `kind`/`activity`，`kind: 'diagnostic'` 的判别联合
 *   是 `listDescendants()` 的形状。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWaitAgentTool as buildWaitAgentTool } from '../lib/wait-agent.js';
import { resolveConfig } from '../lib/config.js';
import { checkedTool, fakeAgent, fakeCtx, freezeTimers, guardedWaitAgentCtx, inboxPayload } from './_helpers.mjs';
import { LATE_ANSWER_EVENT } from '../lib/interrupts.js';

/**
 * 被测工具一律经 `checkedTool` 包一层：**每条**用例的返回值都会被喂给宿主输出校验器
 * （`output.schema` 是运行时才校验的，只断言字段会漏掉真机上的 INVALID_TOOL_OUTPUT）。
 */
const createWaitAgentTool = (ctx, config) => checkedTool(buildWaitAgentTool(ctx, config));

const config = resolveConfig({ toolName: 'async_run' });
const agent = fakeAgent();
const exec = { agent, signal: new AbortController().signal };
const CHILD = 'child-42';

/**
 * 装一个**有状态**的子代理列表：`interrupt(id)` 会真的把子代理移出列表并记账。
 *
 * 为什么要状态：R2 审查 §3.2 第 4 点点名过一条恒真断言——旧探针装在
 * `subagents.interrupt` 上，但被测代码根本不碰这个方法。现在 `interrupt` 会真的
 * 改变 `listChildren()` 的结果，于是"打断等待 ≠ 打断子代理"可以断言在
 * "它还查得到、interrupt 一次都没被调用"上；测试末尾再手工调用一次 `interrupt`，
 * 证明这套探针确实能记到（否则 0 与"探针坏了"无法区分）。
 *
 * @param {object} f - fakeCtx 探针。
 * @param {object} options - `{ children, throws }`。
 * @returns {{ calls: string[], state: object, setRows: Function }} 探针。
 */
function installChildren(f, { children = [], throws = false } = {}) {
  const calls = [];
  const state = { interrupted: [] };
  let rows = [...children];
  f.ctx.subagents = {
    async listChildren(parentId) {
      calls.push(parentId);
      if (throws) throw new Error('listing unavailable');
      return rows.map((row) => ({ ...row }));
    },
    interrupt(id) {
      state.interrupted.push(id);
      rows = rows.filter((row) => row.id !== id);
      return 'requested';
    }
  };
  return { calls, state, setRows: (next) => { rows = [...next]; } };
}

/**
 * 一个"存在"的条目，**用 0.1.7 的真实行形状**：`listChildren()` 返回父会话
 * `subagentCatalog` 投影的条目 `{ id, createdAt, mode, label? }`——**没有 `kind`、
 * 没有 `activity`**。假件必须照真实形状造：本包曾经用带 `kind: 'child'` 的假件
 * 把"形状漂移"整段盖住（真机上屏障恒 not_found，单测却全绿）。
 *
 * @param {string} label - 派发时的标签。
 * @returns {object} catalog 行。
 */
function runningChild(label = 'worker') {
  return { id: CHILD, createdAt: 1, mode: 'continuable', label };
}

/**
 * 旧形状（判别联合）：带 `kind` 与 `activity`，那是 `listDescendants()` 的行
 * （`childRow()` 的产物），不是 0.1.7 `listChildren()` 的行。
 * 仅用于锁"形状带 activity 时那条快速返回仍成立"的兼容判据。
 *
 * @param {string} activity - `running` | `inactive`。
 * @returns {object} 判别联合行。
 */
function legacyChildRow(activity) {
  return { kind: 'child', id: CHILD, mode: 'continuable', label: 'legacy-worker', activity, hasChildren: false };
}

/** 结算通知 payload（真实形状：source 带 senderSessionId）。
 *  `senderSessionId: null` = 构造**不带该键**的老版本通知（正文回退路径的靶子）。 */
function settledNotice({ senderSessionId = CHILD, text = `Background subagent ${CHILD} finished.` } = {}) {
  return {
    agent,
    message: {
      id: 'msg-settled',
      role: 'user',
      content: [{ type: 'text', text }],
      source: senderSessionId === null
        ? { kind: 'subagent-settled', form: 'notice' }
        : { kind: 'subagent-settled', form: 'notice', senderSessionId }
    }
  };
}

test('async_wait_agent：wait_ms 必填（等待必须有界）', async () => {
  const f = fakeCtx();
  installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, config);
  await assert.rejects(() => tool.execute({ agent_id: CHILD }, exec), /missing required property "wait_ms"/);
  await assert.rejects(() => tool.execute({ agent_id: CHILD, wait_ms: null }, exec), /"wait_ms" must be a number/);
});

test('async_wait_agent：未知子代理 → not_found 并列出已知子代理', async () => {
  const f = fakeCtx();
  // pollIntervalMs 调小：not_found 前的有界屏障重试按它睡（真机上 500ms × 3 次没问题，
  // 测试里 2ms 保持快）。
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 2 });
  installChildren(f, { children: [runningChild('alpha'), { id: 'other-1', createdAt: 2, mode: 'continuable', label: 'beta' }] });
  const tool = createWaitAgentTool(f.ctx, quick);

  const result = await tool.execute({ agent_id: 'nope', wait_ms: 1000 }, exec);
  assert.equal(result.status, 'not_found');
  assert.equal(result.agent_id, 'nope');
  assert.equal(result.known_children.length, 2);
  assert.match(result.known_children[0], /alpha/);
});

// ---------------------------------------------------------------------------
// 真机缺陷（§26.3.7⑥）：`async_wait_agent` 对一个刚派发的子代理
// 报 `unknown subagent "<id>". Known children:` 空清单。根因是**行形状漂移**：
// 本包按判别联合（`kind === 'child'`）消费 `listChildren()`，而 0.1.7 的
// `listChildren()` 返回父会话目录条目（无 `kind`），过滤后一行不剩——屏障恒 not_found，
// 假件却一直用旧形状，所以单测全绿。下面两条用例改用真实形状。
// ---------------------------------------------------------------------------

test('async_wait_agent（真机缺陷）：catalog 形状的行必须被认出来，不得误报 not_found', async () => {
  const f = fakeCtx();
  // 不冻结定时器：缺陷形态下屏障会按 pollIntervalMs 重试，冻住会把重试睡死——
  // 那样变异只表现为"挂住"，看不出是哪条断言在守。用真定时器 + 显式竞速上限。
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 2 });
  installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, quick);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 60000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 10));
  f.emit('agent/status', { agent: { id: CHILD }, status: 'idle' });

  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ status: 'still-waiting' }), 3000))
  ]);
  assert.equal(result.status, 'settled', 'catalog 行（无 kind）必须被屏障认出，修前这里是 not_found');
  assert.equal(result.agent_id, CHILD);
});

test('async_wait_agent（真机缺陷）：派发瞬间行还没进目录 → 有界重试后认出，不得误报 not_found', async () => {
  const f = fakeCtx();
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 3 });
  const { calls, setRows } = installChildren(f, { children: [] });
  const tool = createWaitAgentTool(f.ctx, quick);
  // 第 5ms 起行对列表可见——目录投影刷新窗口的最小模拟。
  setTimeout(() => setRows([runningChild()]), 5);
  setTimeout(() => f.emit('agent/status', { agent: { id: CHILD }, status: 'idle' }), 40);

  const result = await tool.execute({ agent_id: CHILD, wait_ms: 60000 }, exec);
  assert.equal(result.status, 'settled', '行出现后屏障必须看到它（修前：一次查空即 not_found）');
  assert.ok(calls.length >= 2, `屏障必须重试过（一次查空就报 not_found 正是被测缺陷）；实查 ${String(calls.length)} 次`);
});

test('async_wait_agent（真机缺陷）：not_found 的纠错清单必须列出 catalog 行（不得恒空）', async () => {
  const f = fakeCtx();
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 2 });
  installChildren(f, { children: [runningChild('alpha'), { id: 'other-1', createdAt: 2, mode: 'one-shot', label: 'beta' }] });
  const tool = createWaitAgentTool(f.ctx, quick);

  const result = await tool.execute({ agent_id: 'nope', wait_ms: 1000 }, exec);
  assert.equal(result.status, 'not_found');
  assert.equal(result.known_children.length, 2, 'catalog 行没有 kind 字段，按 kind 过滤会让清单恒空（真机现象）');
  assert.match(result.known_children[0], /alpha/);
  assert.match(result.known_children[0], /mode=continuable/, 'catalog 行要把 mode 写出来（它没有 activity）');
});

test('async_wait_agent（真机缺陷 反向）：id 真不存在 → 重试耗尽后仍报 not_found', async () => {
  const f = fakeCtx();
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 2 });
  const { calls } = installChildren(f, { children: [runningChild('alpha')] });
  const tool = createWaitAgentTool(f.ctx, quick);

  const result = await tool.execute({ agent_id: 'nope', wait_ms: 1000 }, exec);
  assert.equal(result.status, 'not_found', '重试不是无限等：耗尽后必须给出可纠错的 not_found');
  assert.match(result.known_children[0], /alpha/);
  assert.ok(calls.length >= 2, '确实重试过（否则这条用例没守住"有界"语义的反面）');
});

test('async_wait_agent：结算通知（带 senderSessionId）→ settled', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.emit('agent/inbox/inserted', settledNotice());

  const result = await pending;
  assert.equal(result.status, 'settled');
  assert.equal(result.agent_id, CHILD);
  assert.match(result.note, /A settlement notice for this subagent was received/);
  assert.match(result.note, /will arrive as a separate message in the conversation/, '必须告知最终回答不在返回值里');
  // R3-1 口径 A（R4 审查 #2）：**三条 settled 路径**的 note 都不许出现**无条件**的
  // "子代理 X 已结束"。settled 的 note 若对每个 id 都这么写，会与本条路径前半句的
  // "不再观察到它在运行"正面对冲。
  //
  // 断言要盯住**无条件断言**这一形态，而不是"已结束"这三个字：`agent/status` 那条路径的
  // "该子代理已结束当前工作（状态转为空闲）"是**有依据的观察**（收到了 idle 事件），
  // 把它也算违规就成了过宽断言，会红在一个合法的句子上。
  assert.doesNotMatch(result.note, new RegExp(`子代理 ${CHILD} 已结束`), '不许无条件断言"子代理已结束"');
});

test('async_wait_agent：别个子代理的结算通知不得结束本次等待', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.emit('agent/inbox/inserted', settledNotice({ senderSessionId: 'someone-else' }));

  const raced = await Promise.race([
    pending.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 30))
  ]);
  assert.equal(raced, 'still-waiting', 'senderSessionId 不匹配时不得结算');

  // 收尾：投递正确的结算通知，避免留下悬挂的等待。
  f.emit('agent/inbox/inserted', settledNotice());
  const result = await pending;
  assert.equal(result.status, 'settled');
  // "已结束当前工作（状态转为空闲）"是**有依据的观察**（收到了 idle 事件），允许存在；
  // 不许存在的是无条件的"子代理 X 已结束"（口径 A）。
  assert.doesNotMatch(result.note, new RegExp(`子代理 ${CHILD} 已结束`), '不许无条件断言"子代理已结束"');
});

test('async_wait_agent：agent/status 的 idle 是可达的提前返回通道', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.emit('agent/status', { agent: { id: CHILD }, status: 'idle' });

  const result = await pending;
  assert.equal(result.status, 'settled');
  assert.match(result.note, /status turned idle/, '必须注明信号来源，便于模型理解语义差异');
  // 这条路径的"该子代理已结束当前工作（状态转为空闲）"是**有依据的观察**，允许存在；
  // 不许存在的是无条件的"子代理 X 已结束"（口径 A / R4 审查 #2）。
  assert.doesNotMatch(result.note, new RegExp(`子代理 ${CHILD} 已结束`), '不许无条件断言"子代理已结束"');
});

test('async_wait_agent：agent/status 的 running 不结算；别的 agent 的 idle 也不结算', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.emit('agent/status', { agent: { id: CHILD }, status: 'running' });
  f.emit('agent/status', { agent: { id: 'another-child' }, status: 'idle' });

  const raced = await Promise.race([
    pending.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 30))
  ]);
  assert.equal(raced, 'still-waiting');

  f.emit('agent/status', { agent: { id: CHILD }, status: 'idle' });
  assert.equal((await pending).status, 'settled');
});

test('async_wait_agent（T2）：用户插话 → interrupted，子代理一次都没被碰过', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const { state, calls } = installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '停一下', target: 'next-step' }));

  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.match(result.note, /Wait interrupted: a user message has arrived/);
  assert.match(result.note, /is still running in the background and is completely unaffected/);
  assert.match(result.note, /async_wait_agent/);

  // ★ R4 的核心不变量：打断**等待**不得打断**子代理**。
  assert.deepEqual(state.interrupted, [], 'subagents.interrupt 一次都不能被调用');
  const rows = await f.ctx.subagents.listChildren(agent.id);
  assert.equal(rows.length, 1, '子代理必须还在列表里（仍在运行）');
  assert.equal(rows[0].id, CHILD);
  assert.ok(calls.length >= 1);

  // 探针活性证明：这套探针**确实**能记到打断。不证明这一点，
  // 上面的空数组与"探针坏了"无法区分（这正是旧断言恒真的原因）。
  f.ctx.subagents.interrupt(CHILD);
  assert.deepEqual(state.interrupted, [CHILD]);
  assert.deepEqual(await f.ctx.subagents.listChildren(agent.id), []);
});

test('async_wait_agent（R30-d 唤醒分支）：等待中迟到作答通知 → 运行句柄 + note，非 interrupted 非 settled', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // 迟到作答到达（R30 通道轮：插件事件——ask-takeover 宿主半边发布，载荷含
  // agent 标识与题号；作答与忽略同形）。
  f.emit(LATE_ANSWER_EVENT, {
    agentId: agent.id, questionId: 'color', kind: 'answer', summary: 'Late answer for color: red'
  });

  const result = await pending;
  assert.equal(result.status, 'running', '唤醒交还：运行句柄——不报 interrupted、不误报 settled');
  assert.notEqual(result.status, 'interrupted');
  assert.match(result.note, /A late answer has arrived/, 'note 指明作答已到（wait.lateArrived 模板）');
  assert.match(result.note, /color/, 'note 带 summary（题号在册）');
  assert.match(result.note, /async_wait_agent/, '保留 wait-again 提示（模型可继续等或先消费通知）');
  // 通知到达不打断子代理（唤醒交还，不是打断）：列表未动。
  const rows = await f.ctx.subagents.listChildren(agent.id);
  assert.equal(rows.length, 1, '子代理仍在列表里（唤醒 ≠ 打断 ≠ 结束）');
});

test('async_wait_agent（R30 通道轮 起始检查）：作答先到、等待后开 → 立即运行句柄 + note（不空转预算）', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  // 待读登记非空：作答已投递未领取（滞留 next-step——真机实录里这种等待
  // 干等到预算耗尽；起始检查堵这个空窗）。
  agent.inbox.nextStep.push({
    source: { kind: 'async-tools-late-answer', form: 'notice', summary: 'Late answer for color: red', questionId: 'color' }
  });
  const tool = createWaitAgentTool(f.ctx, config);

  const result = await tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  assert.equal(result.status, 'running', '起始即命中：运行句柄，不空转等待预算');
  assert.match(result.note, /A late answer has arrived/, 'note 指明作答已到');
  assert.match(result.note, /color/, 'note 带 summary（题号在册）');
  agent.inbox.nextStep.length = 0; // 还原共享 fixture
});

test('async_wait_agent（T2 反向对照）：工具自身被取消 → 结束等待，但子代理仍未被碰', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const { state } = installChildren(f, { children: [runningChild()] });
  const controller = new AbortController();
  const tool = createWaitAgentTool(f.ctx, config);
  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, { agent, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort(new Error('用户点了停止'));

  await assert.rejects(() => pending, /用户点了停止/);
  assert.deepEqual(state.interrupted, [], '取消工具调用也不等于取消子代理');
  assert.equal((await f.ctx.subagents.listChildren(agent.id)).length, 1);
});

/**
 * 只让**第一个** `timeout` 真正生效（那是等待预算的 deadline），其余冻结；
 * 同时冻结兜底轮询 —— 该轮询的到期条件是"子代理从列表里消失"，
 * 在一个 listChildren 恒返回同一份数据的替身里它永远不会触发，
 * 但它的 interval 会让竞速难以预测（早期版本正是被它抢先解成 running）。
 * @param {object} ctx - 假上下文。
 */
function firstTimerOnly(ctx) {
  let used = false;
  ctx.timer.timeout = (callback) => {
    if (used) return () => {};
    used = true;
    const handle = setTimeout(callback, 5);
    return () => clearTimeout(handle);
  };
  ctx.timer.interval = () => () => {};
}

test('async_wait_agent：子代理转达消息不得被当作插话或结算', async () => {
  const f = fakeCtx();
  // 本用例只关心"转达消息是否结算"，所以把截止与轮询都冻住：
  // 唯一能让竞速结束的通道只剩 settled / activity / interrupt。
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // role 是 user，但 kind 是 agent-message —— 只是唤醒信号。
  f.emit('agent/inbox/inserted', inboxPayload({
    agent, sourceKind: 'agent-message', form: 'relay', text: `Agent ${CHILD} sent a message:  progress`
  }));

  const raced = await Promise.race([
    pending.then((r) => r.status),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 40))
  ]);
  assert.equal(raced, 'still-waiting', '转达消息不是结束信号，也不是插话');

  f.emit('agent/status', { agent: { id: CHILD }, status: 'idle' });
  assert.equal((await pending).status, 'settled');
});

test('async_wait_agent：预算到期 → running 且提示可再次等待', async () => {
  const f = fakeCtx();
  firstTimerOnly(f.ctx);
  installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, config);

  const result = await tool.execute({ agent_id: CHILD, wait_ms: 5000 }, exec);
  assert.equal(result.status, 'running');
  assert.equal(result.agent_id, CHILD);
  assert.match(result.note, /unaffected, still running/);
  assert.match(result.note, /has not finished yet/);
  assert.match(result.note, /async_wait_agent\(agent_id=/, '文案必须指向 async_wait_agent，不能复用 job 的 async_wait_job');
});

test('async_wait_agent：子代理列表不可用 → 报错而不是假装结束', async () => {
  const f = fakeCtx();
  installChildren(f, { throws: true });
  const tool = createWaitAgentTool(f.ctx, config);
  await assert.rejects(
    () => tool.execute({ agent_id: CHILD, wait_ms: 1000 }, exec),
    /subagent listing unavailable/
  );
});

test('async_wait_agent：工具自身被取消 → 立即结束等待', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  const controller = new AbortController();
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, { agent, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort(new Error('用户点了停止'));

  await assert.rejects(() => pending, /用户点了停止/);
});

test('async_wait_agent：结束时清理所有监听器（R4 可逆性）', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.emit('agent/status', { agent: { id: CHILD }, status: 'idle' });
  await pending;

  assert.equal(f.count('agent/inbox/inserted'), 0, 'inbox 监听器必须被摘掉');
  assert.equal(f.count('agent/status'), 0, '状态监听器必须被摘掉');
});

// ---------------------------------------------------------------------------
// 以下用例锁 R2 审查的 N3 / N7 / N11。
// ---------------------------------------------------------------------------

test('async_wait_agent（N3，形状带 activity 时）：屏障读出非运行态 → 立即 settled，不进等待', async () => {
  const f = fakeCtx();
  // 冻结截止与轮询：屏障若没生效，这个调用会永远挂着（不会假装通过）。
  freezeTimers(f.ctx);
  // 只有**判别联合**形状（`listDescendants()` 的行）才带 `activity`；0.1.7 的
  // `listChildren()` 行不带，所以这条快速返回是真机上的能力缺口，不是主路径。
  installChildren(f, { children: [legacyChildRow('inactive')] });
  const tool = createWaitAgentTool(f.ctx, config);

  const outcome = await Promise.race([
    tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'still-waiting' }), 50))
  ]);

  assert.equal(outcome.status, 'settled', 'R3：不再观察到它在运行 → 立即结束等待');
  assert.equal(outcome.agent_id, CHILD);
  // 措辞裁决（R3 审查 R3-1，口径 A）：`inactive` 只表示"这一行走了冷读"，**不是**
  // "它结束了"。所以说明必须停在"不再观察到它在运行"（英文口径：
  // "is no longer observed running"），不许替宿主下"已结束"（has finished）的结论。
  assert.match(outcome.note, /is no longer observed running/, '必须只声明观察到什么，不得断言"它已结束"');
  assert.doesNotMatch(outcome.note, /状态已不是运行态/, '不许再用"已不是运行态"这种像结论的说法');
  assert.match(outcome.note, /will arrive as a separate message/);
});

test('async_wait_agent（N3，形状带 activity 时）：等待期间列表变成非运行态 → 收敛时报 settled 而不是 running', async () => {
  const f = fakeCtx();
  firstTimerOnly(f.ctx);
  const { setRows } = installChildren(f, { children: [legacyChildRow('running')] });
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 5000 }, exec);
  // 预算到期（firstTimerOnly 的 5ms）之前，把列表改成"已非运行态"。
  setRows([legacyChildRow('inactive')]);
  const result = await pending;

  assert.equal(result.status, 'settled', '复查不再观察到它在运行时，不能对模型报"仍在运行"');
  assert.match(result.note, /is no longer observed running/);
});

test('async_wait_agent（N3）：查询失败（列表抛错）不得被当成已结束', async () => {
  const f = fakeCtx();
  // 屏障查询抛错 → 必须报错而不是假装结束（与"查不到条目"区分开）。
  installChildren(f, { throws: true });
  const tool = createWaitAgentTool(f.ctx, config);
  await assert.rejects(
    () => tool.execute({ agent_id: CHILD, wait_ms: 1000 }, exec),
    /subagent listing unavailable/
  );
});

test('async_wait_agent（N7）：diagnostic 行不算子代理，但仍要写进纠错清单并带 reason', async () => {
  const f = fakeCtx();
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 2 });
  installChildren(f, {
    children: [
      runningChild('worker'),
      { kind: 'diagnostic', id: 'broken-1', reason: 'corrupt' },
      { kind: 'diagnostic', id: 'broken-2', reason: 'unavailable' }
    ]
  });
  const tool = createWaitAgentTool(f.ctx, quick);

  const result = await tool.execute({ agent_id: 'nope', wait_ms: 1000 }, exec);
  assert.equal(result.status, 'not_found');
  // 诊断行**不是**可等待的子代理（下一条用例锁这点），但把它从纠错清单里删掉是错的：
  // 模型需要知道"这个 id 读不出来、原因是 unavailable/corrupt"，而不是看到空清单。
  assert.equal(result.known_children.length, 3);
  assert.match(result.known_children[0], /worker/);
  assert.match(result.known_children[1], /broken-1 \(diagnostic: corrupt\)/);
  assert.match(result.known_children[2], /broken-2 \(diagnostic: unavailable\)/);
  assert.doesNotMatch(result.known_children.join('\n'), /\?, \?/, '不得让模型看到 "?, ?" 这种占位（R2 审查 N7 的初衷）');
});

test('async_wait_agent（N7）：目标被判为不可用（diagnostic 行）→ not_found，不得进入等待', async () => {
  const f = fakeCtx();
  // 不再 freezeTimers：屏障重试需要真的定时器（冻住会把重试睡死）；
  // not_found 从屏障直接返回，deadline 根本不会被武装。
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 2 });
  installChildren(f, { children: [{ kind: 'diagnostic', id: CHILD, reason: 'unavailable' }] });
  const tool = createWaitAgentTool(f.ctx, quick);

  const outcome = await Promise.race([
    tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'still-waiting' }), 200))
  ]);
  assert.equal(outcome.status, 'not_found');
});

test('async_wait_agent（N3/N11）：描述必须写清能力边界并带上生效的预算数字', () => {
  const f = fakeCtx();
  const tool = createWaitAgentTool(f.ctx, resolveConfig({ toolName: 'async_run', minWaitMs: 300, maxWaitMs: 120000 }));
  // 描述里的能力边界必须**与实测一致**，不能更宽也不能更窄。
  //
  // 真机实测否决"开始等待前已结束就必然等满预算"的说法（那套结论
  // 由 `activity` 支撑）；0.1.7 的目录条目没有 `activity`，能证明的只有存在性，
  // 所以描述改成"结算通知已在对话里 + 本工具分辨不出来 + 只能等满预算"。
  assert.match(tool.description, /the subagent catalog only shows which children exist/,
    '必须交代"列表快照只能证明存在性"这条能力边界');
  assert.match(tool.description, /only wait out wait_ms/, '也必须交代屏障看不出来时的退路，否则模型会以为永远即时');
  assert.match(tool.description, /list_agents/, '必须给出确认真实状态的手段');
  assert.match(tool.description, /120000 ms/, '等待上限必须来自生效配置（补缺口）');
  // R29-d（N4）：覆盖口径句 + pollIntervalMs 现值插值（缺省 500 ms）。
  assert.match(tool.description, /budget bounds the total call time: the existence barrier \(up to 3 x 500 ms of retries\) plus the wait segment/,
    '覆盖口径句必须在描述里，且屏障重试上限随 pollIntervalMs 现值插值');
  // 反面：不许再出现被实测推翻的那句绝对化说法。
  assert.doesNotMatch(tool.description, /必然等满|always waits out the full/, '该绝对化说法已被真机实测推翻');
  // 段落拼接：多段 join('') 时**任何**一段忘了尾随空格，都会把两个句子粘成一个词
  // （`reach you.When`——英文化期间真实出现过的接缝缺陷）。语言无关的通用断言：
  // 句号后紧跟大写字母 = 缺空格（本描述里没有合法的 `x.Y` 序列）。
  assert.doesNotMatch(tool.description, /\.[A-Z]/, '段与段之间必须留出分隔（句号后必须有空格）');
  // `settled` 的承诺口径（R3 审查 R3-1 裁决，口径 A）：**不得**写成"它已经结束了"。
  assert.match(tool.description, /no longer observed running/, 'settled 只能承诺"不再观察到它在运行"');
  // 反面断言必须**能命中真实风险**：描述是英文串，用中文正则（`/它结束了/`）永远不命中
  // ——那是恒真断言（R4 审查 #5 的同一类毛病）。盯英文形态：
  // 把描述改成 "settled means it has finished" 必须变红。
  assert.doesNotMatch(tool.description, /settled means (that )?it has (already )?finished/i,
    'settled 不许承诺"它结束了"');
  // 并且参数表里确实没有 yield_ms —— 描述里当然也不该提。
  // JSON Schema 形状：参数在 `parameters.properties` 下。
  assert.equal(tool.parameters.properties.yield_ms, undefined, 'async_wait_agent 没有 yield_ms 参数');
  assert.doesNotMatch(tool.description, /yield_ms/, '描述提到了一个不存在的参数（R4 审查 #1）');
  assert.doesNotMatch(tool.description, /转入后台|返回 job_id/, 'async_wait_agent 不会转后台，也不返回 job_id');
  assert.doesNotMatch(tool.description, /让出预算/, '让出预算是 async_run 的概念');
});

test('async_wait_agent（R8 第一条）：只走公共查询与公共事件，碰内部状态就红', async () => {
  // ## 这条判据要挡什么
  //
  // R8 第一条：`async_wait_agent` **不得读会话日志、内部状态或越界数据**，只能走
  // 宿主的公共查询（`ctx.subagents.listChildren`）与宿主的公共事件（`ctx.on`）。
  //
  // 当时守这条的只有 `test/index.test.mjs` 里一条**静态**断言（扫 `ctx.<x>` 是否在
  // `inject` 里）。那条能挡"忘了声明 inject"，但**挡不住"用了已声明服务上的非公共属性"**
  // —— 只要 `subagents` 声明了，静态扫描就放行。
  //
  // 本用例把它**行为化**：`guardedWaitAgentCtx()` 把 ctx 包成 Proxy，
  // **只有明确列出的属性可读**，读别的立刻抛错并记下名字。于是"碰了内部状态"
  // 不再是靠读代码发现，而是用例当场变红**并指出碰的是哪个属性**。
  const g = guardedWaitAgentCtx();
  freezeTimers(g.ctx);
  // 行用 0.1.7 的真实形状（catalog 条目：无 `kind`）——假件照旧形状造，正是
  // 真机缺陷（屏障恒 not_found）当初逃过单测的原因。
  g.children.push({ id: CHILD, createdAt: 1, mode: 'continuable', label: 'child work' });
  const tool = createWaitAgentTool(g.ctx, resolveConfig({ toolName: 'async_run', minWaitMs: 250, maxWaitMs: 120000 }));
  const agent = fakeAgent();

  // 跑完一次**正常路径**：屏障读到子代理还在 ⇒ 进入等待 ⇒ 我们发一条公共事件结束它。
  const pending = tool.execute({ agent_id: CHILD, wait_ms: 5000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // 结算通知走的是宿主的公共事件通道；`senderSessionId` 精确关联。
  //
  // ⚠️ 必须用 `settledNotice()`（真实形状：`source.kind === 'subagent-settled'` 且带
  // `senderSessionId`）。若误用 `inboxPayload({ sourceKind: 'subagent-settled' })`，
  // 那个帮助函数的 `source.kind` **是 `'plugin'`**（`sourceKind` 是另一个字段）
  // ⇒ 判据函数收不到结算信号 ⇒ 等待永不收敛 ⇒ 用例挂到 600 秒超时。
  // **超时不是"慢"，是"信号发错了形状"。**
  g.emit('agent/inbox/inserted', settledNotice());
  const result = await pending;

  assert.equal(result.status, 'settled', '公共事件通道必须能把等待收敛到 settled');
  assert.deepEqual(g.denied, [],
    `不得读取放行清单之外的任何 ctx 属性；实得违规：${g.denied.join('、')}`);
  // 正向：它**确实**用了公共查询与公共事件——否则"没违规"可能是因为它什么都没做。
  assert.ok(g.touched.includes('subagents.listChildren'),
    `必须通过宿主的公共查询读子代理列表；实得接触面：${g.touched.join('、')}`);
  assert.ok(g.touched.includes('on'),
    `必须通过宿主的公共事件订阅；实得接触面：${g.touched.join('、')}`);
});

// ---------------------------------------------------------------------------
// R29（安全/健壮性/异常处理）新增判据：设计 §31.9 判据 1、2、6、9。
// ---------------------------------------------------------------------------

/**
 * 进程级 unhandledRejection 探针：R29-a 的核心断言面。
 *
 * 宿主 `installFailLoud` 语义下，一条无人接住的 reject 就是整实例退出。
 * 测试里用 `process.on('unhandledRejection')` 复刻同一道闸——no-op catch 撤掉后，
 * 本探针非空，用例当场红。
 *
 * @returns {{take: Function, off: Function}} 探针：`take()` 读累计数组，`off()` 摘除。
 */
function unhandledProbe() {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  return { take: () => seen, off: () => process.off('unhandledRejection', onUnhandled) };
}

test('R29-a（判据 1·屏障窗口）：工具取消落在竞速组装之前——no-op catch 必须兜住，不得 unhandledRejection', async () => {
  const f = fakeCtx();
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 2 });
  // 列表恒空 → 屏障按 pollIntervalMs 有界重试 → abort 落在"第一个 await childOf
  // 之后、竞速组装之前"的窗口里（窗口长达 3×pollIntervalMs，正是 no-op catch 的靶区）。
  const { calls } = installChildren(f, { children: [] });
  const controller = new AbortController();
  const tool = createWaitAgentTool(f.ctx, quick);
  const probe = unhandledProbe();

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 1000 }, { agent, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 3)); // 进入第一个屏障重睡
  controller.abort(new Error('tool cancelled')); // ★ 窗口内取消：aborted 此刻 reject，无人竞速
  const result = await pending; // 屏障跑满重试 → not_found（aborted 不打断屏障）
  await new Promise((resolve) => setTimeout(resolve, 30)); // 微任务排空：若有未接住的 reject 必已上报

  assert.equal(result.status, 'not_found', '窗口内取消不打断屏障（屏障不知道 abort），按有界重试收敛');
  assert.ok(calls.length >= 1);
  assert.equal(probe.take().length, 0,
    'no-op catch（wait-agent.js `aborted.catch(() => {})`）必须兜住窗口期 reject——撤掉它，本断言必红（整实例退出）');
  probe.off();
});

test('R29-a（判据 1·竞速期）：取消后竞速以 aborted 拒绝退出，同样不得 unhandledRejection', async () => {
  const f = fakeCtx();
  installChildren(f, { children: [runningChild()] });
  const controller = new AbortController();
  const tool = createWaitAgentTool(f.ctx, config);
  const probe = unhandledProbe();

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 60000 }, { agent, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 3)); // 屏障已过，竞速已组装
  controller.abort(new Error('tool cancelled')); // aborted reject → Promise.race 跟着 reject
  await assert.rejects(() => pending, /tool cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(probe.take().length, 0, '竞速期 reject 由 Promise.race 接住，不得外泄');
  probe.off();
});

test('R29-b（判据 2·入口中止）：调用进来时 signal 已 aborted → 直接 interrupted，不订阅不查询不武装', async () => {
  const f = fakeCtx();
  const { calls } = installChildren(f, { children: [runningChild()] });
  const controller = new AbortController();
  controller.abort(new Error('pre-cancelled'));
  const tool = createWaitAgentTool(f.ctx, config);

  // 对已中止的 signal 挂监听器永不触发——不短路的话这条调用会等满预算
  // 才以 running 收场（对模型撒谎，还白占一次并发位）。
  const result = await tool.execute({ agent_id: CHILD, wait_ms: 30000 }, { agent, signal: controller.signal });

  assert.equal(result.status, 'interrupted');
  assert.equal(result.waited_ms, 0, '一次都没等');
  assert.match(result.note, /async_wait_agent\(agent_id="child-42", wait_ms=\.\.\.\)/, '可复制的恢复调用');
  assert.equal(calls.length, 0, 'listChildren 一次都不能被调用（不订阅、不查询、不武装）');
});

test('R29-c（判据 6·正文回退是弱证据）：命中后复查仍在运行 → running，不得误报 settled', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  // 老版本兼容路径：结算通知**不带** senderSessionId（interrupts.js 的回退条件
  // 是该字段缺席——带着一个对不上的值属于精确关联失败，整条通知被忽略），
  // 只能按正文匹配。子代理行还在目录里（catalog 行无 activity）：
  // 弱证据 + 查无"不再运行"的证据 → 落 running（下一次等待仍走事件通道）。
  installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 60000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.emit('agent/inbox/inserted', settledNotice({ senderSessionId: null }));

  const result = await pending;
  assert.equal(result.status, 'running', '正文匹配 + 复查仍在列表 → 不得报 settled（误报 settled 比多等一轮贵）');
  assert.match(result.note, /async_wait_agent\(agent_id="child-42", wait_ms=\.\.\.\)/, 'running 分支必须给出可复制的再等调用');
});

test('R29-c（判据 6·正文回退 + 复查确认）：命中且复查已不在列表 → settled，注明走的是正文回退', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const { setRows } = installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 60000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // 结算先行（行已从目录消失），通知不带 senderSessionId → 只能靠正文匹配 + 复查确认。
  setRows([]);
  f.emit('agent/inbox/inserted', settledNotice({ senderSessionId: null }));

  const result = await pending;
  assert.equal(result.status, 'settled', '正文匹配 + 复查确已不在列表 → settled');
  assert.match(result.note, /message text/, '必须注明走的是正文回退通道（via.textFallback）');
});

test('R29-d（判据 9a·等待段半边）：子代理在场时全程 ≈ waitMs，不得超总时长上界', async () => {
  // 本用例锁**等待段**半边：子代理在场 → 屏障首查即中（barrierSleep 零调用，
  // 屏障段恒为零）→ 全程 = 等待段。屏障段的可达红判据在 9b（实现审查 N2：
  // 旧版用例宣称"屏障加重必红"不实——在场路径屏障根本不睡）。
  const poll = 20;
  const waitMs = 60;
  const tolerance = 300;
  const f = fakeCtx();
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: poll });
  installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, quick);

  const startedAt = Date.now();
  const result = await tool.execute({ agent_id: CHILD, wait_ms: waitMs }, exec);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.status, 'running');
  assert.ok(result.waited_ms >= waitMs - 10, `等待段要用满预算（实得 ${String(result.waited_ms)} ms）`);
  const bound = waitMs + 3 * poll + tolerance;
  assert.ok(elapsed <= bound,
    `总时长 ${String(elapsed)} ms 不得超过 waitMs + 3×pollIntervalMs + 容差 = ${String(bound)} ms`);
});

test('R29-d（判据 9b·屏障段半边）：重试路径下屏障睡也计入总时长，屏障加重必红', async () => {
  // 目录投影刷新窗口的最小模拟：子代理行第一个 poll 之后才出现 → 屏障
  // 恰好睡一次重试一次。全程 = 屏障段（1×poll）+ 等待段（waitMs）。
  // 变异"屏障睡定值远超 pollIntervalMs"（如 +2000ms）会让本用例击穿上界——
  // 这是判据 9 对屏障段的可达红锚（实现审查 N2 补）。
  const poll = 20;
  const waitMs = 60;
  const tolerance = 300;
  const f = fakeCtx();
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: poll });
  const { setRows } = installChildren(f, { children: [] });
  setTimeout(() => setRows([runningChild()]), poll);
  const tool = createWaitAgentTool(f.ctx, quick);

  const startedAt = Date.now();
  const result = await tool.execute({ agent_id: CHILD, wait_ms: waitMs }, exec);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.status, 'running');
  assert.ok(elapsed >= poll - 5, `屏障段确实睡过（实得 ${String(elapsed)} ms，应 ≥ 1×poll）`);
  const bound = waitMs + 3 * poll + tolerance;
  assert.ok(elapsed <= bound,
    `总时长 ${String(elapsed)} ms 不得超过 waitMs + 3×pollIntervalMs + 容差 = ${String(bound)} ms——屏障睡加重（如 +2000ms）时此处必红`);
});
