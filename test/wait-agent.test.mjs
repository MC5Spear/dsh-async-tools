/**
 * `async_wait_agent` 工具的单测（对应需求 §2.3 子代理派生与观察）。
 *
 * 覆盖四条强制约束：
 * - **打断判定只能用 `source.kind === 'user'`**（role 陷阱）；
 * - 结算通知用 `source.senderSessionId` 精确关联，正文匹配只是降级路径；
 * - `agent/status` 的 `idle` 是可达的提前返回通道（设计 §3.4：命中且非 running 即立即交回）；
 * - 屏障用"这个 id 在不在父会话的子代理目录里"判存在性，**两种行形状都认**：
 *   `listChildren()` 行没有 `kind`/`activity`，`kind: 'diagnostic'` 的判别联合
 *   是 `listDescendants()` 的形状。
 */
import { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { hostTestFor, loadOfflineSafe } from './_host-gate.mjs';
import { resolveConfig } from '../lib/config.js';
import { checkedTool, fakeAgent, fakeCtx, freezeTimers, guardedWaitAgentCtx, inboxPayload } from './_helpers.mjs';
import { LATE_ANSWER_EVENT } from '../lib/interrupts.js';

// 宿主链动态守卫（lib/wait-agent.js → dsh-tools/descriptions）：离线形态锚缺席时
// 本文件仍可加载，全部用例自跳过并打印理由（ci.yml offline 作业的契约）。
// afterEach 保留：它引用模块级 fixture（加载即在场），跳过的用例不推数据，清空幂等。
const waitAgentModule = await loadOfflineSafe('../lib/wait-agent.js');
const { createWaitAgentTool: buildWaitAgentTool } = waitAgentModule ?? {};
const hostTest = await hostTestFor('../lib/wait-agent.js');

/**
 * 被测工具一律经 `checkedTool` 包一层：**每条**用例的返回值都会被喂给宿主输出校验器
 * （`output.schema` 是运行时才校验的，只断言字段会漏掉真机上的 INVALID_TOOL_OUTPUT）。
 */
const createWaitAgentTool = (ctx, config) => checkedTool(buildWaitAgentTool(ctx, config));

const config = resolveConfig({ toolName: 'async_run' });
const agent = fakeAgent();
const exec = { agent, signal: new AbortController().signal };
const CHILD = 'child-42';

// 共享 fixture 的末位清理——起始检查开始读收件箱后，
// 失败用例经 inboxPayload / 起始检查用例推入的消息残留会级联污染后续用例的起始读
// （假红失真）。afterEach 清空两个待处理列表，让失败用例的红收敛到自身断言；
// 各用例尾部的显式清理行保留（幂等，保可读性）。
afterEach(() => {
  agent.inbox.nextStep.length = 0;
  agent.inbox.nextTurn.length = 0;
});

/**
 * 装一个**有状态**的子代理列表：`interrupt(id)` 会真的把子代理移出列表并记账。
 *
 * 为什么要状态：恒真断言的风险——探针若装在被测代码根本不碰的方法上
 * （如 `subagents.interrupt`），断言就永远绿。现在 `interrupt` 会真的
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
 * 一个"存在"的条目，**用真实行形状**：`listChildren()` 返回父会话
 * `subagentCatalog` 投影的条目 `{ id, createdAt, mode, label? }`——**没有 `kind`、
 * 没有 `activity`**。假件必须照真实形状造：带 `kind: 'child'` 的假件会把
 * "形状漂移"整段盖住（真机上屏障恒 not_found，单测却全绿）。
 *
 * @param {string} label - 派发时的标签。
 * @returns {object} catalog 行。
 */
function runningChild(label = 'worker') {
  return { id: CHILD, createdAt: 1, mode: 'continuable', label };
}

/**
 * 判别联合形状：带 `kind` 与 `activity`，那是 `listDescendants()` 的行
 * （`childRow()` 的产物），不是 `listChildren()` 的行。
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

hostTest('async_wait_agent：wait_ms 必填（等待必须有界）', async () => {
  const f = fakeCtx();
  installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, config);
  await assert.rejects(() => tool.execute({ agent_id: CHILD }, exec), /missing required property "wait_ms"/);
  await assert.rejects(() => tool.execute({ agent_id: CHILD, wait_ms: null }, exec), /"wait_ms" must be a number/);
});

hostTest('async_wait_agent：未知子代理 → not_found 并列出已知子代理', async () => {
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
// 真机目录行形状与假件不同——这两条用例按真实形状断言：
// `listChildren()` 返回父会话目录条目（无 `kind`）；屏障若只认判别联合
// （`kind === 'child'`），过滤后一行不剩、恒 not_found——那是缺陷形态。
// ---------------------------------------------------------------------------

hostTest('async_wait_agent（真机缺陷）：catalog 形状的行必须被认出来，不得误报 not_found', async () => {
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
  assert.equal(result.status, 'settled', 'catalog 行（无 kind）必须被屏障认出');
  assert.equal(result.agent_id, CHILD);
});

hostTest('async_wait_agent（真机缺陷）：派发瞬间行还没进目录 → 有界重试后认出，不得误报 not_found', async () => {
  const f = fakeCtx();
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 3 });
  const { calls, setRows } = installChildren(f, { children: [] });
  const tool = createWaitAgentTool(f.ctx, quick);
  // 第 5ms 起行对列表可见——目录投影刷新窗口的最小模拟。
  setTimeout(() => setRows([runningChild()]), 5);
  setTimeout(() => f.emit('agent/status', { agent: { id: CHILD }, status: 'idle' }), 40);

  const result = await tool.execute({ agent_id: CHILD, wait_ms: 60000 }, exec);
  assert.equal(result.status, 'settled', '行出现后屏障必须看到它（一次查空即 not_found 是缺陷形态）');
  assert.ok(calls.length >= 2, `屏障必须重试过（一次查空就报 not_found 正是被测缺陷）；实查 ${String(calls.length)} 次`);
});

hostTest('async_wait_agent（真机缺陷）：not_found 的纠错清单必须列出 catalog 行（不得恒空）', async () => {
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

hostTest('async_wait_agent（真机缺陷 反向）：id 真不存在 → 重试耗尽后仍报 not_found', async () => {
  const f = fakeCtx();
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 2 });
  const { calls } = installChildren(f, { children: [runningChild('alpha')] });
  const tool = createWaitAgentTool(f.ctx, quick);

  const result = await tool.execute({ agent_id: 'nope', wait_ms: 1000 }, exec);
  assert.equal(result.status, 'not_found', '重试不是无限等：耗尽后必须给出可纠错的 not_found');
  assert.match(result.known_children[0], /alpha/);
  assert.ok(calls.length >= 2, '确实重试过（否则这条用例没守住"有界"语义的反面）');
});

hostTest('async_wait_agent：结算通知（带 senderSessionId）→ settled', async () => {
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
  // 措辞纪律：**三条 settled 路径**的 note 都不许出现**无条件**的
  // "子代理 X 已结束"。settled 的 note 若对每个 id 都这么写，会与本条路径前半句的
  // "不再观察到它在运行"正面对冲。
  //
  // 断言要盯住**无条件断言**这一形态，而不是"完成"这类词：`agent/status` 那条路径的
  // "该子代理完成了当前工作（状态转为 idle）"是**有依据的观察**（收到了 idle 事件），
  // 把它也算违规就成了过宽断言，会红在一个合法的句子上。
  assert.doesNotMatch(result.note, new RegExp(`子代理 ${CHILD} 已结束`), '不许无条件断言"子代理已结束"');
});

hostTest('async_wait_agent：别个子代理的结算通知不得结束本次等待', async () => {
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
  // "完成了当前工作（状态转为 idle）"是**有依据的观察**（收到了 idle 事件），允许存在；
  // 不许存在的是无条件的"子代理 X 已结束"。
  assert.doesNotMatch(result.note, new RegExp(`子代理 ${CHILD} 已结束`), '不许无条件断言"子代理已结束"');
});

hostTest('async_wait_agent：agent/status 的 idle 是可达的提前返回通道', async () => {
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
  // 这条路径的"该子代理完成了当前工作（状态转为 idle）"是**有依据的观察**，允许存在；
  // 不许存在的是无条件的"子代理 X 已结束"。
  assert.doesNotMatch(result.note, new RegExp(`子代理 ${CHILD} 已结束`), '不许无条件断言"子代理已结束"');
});

hostTest('async_wait_agent：agent/status 的 running 不结算；别的 agent 的 idle 也不结算', async () => {
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

// ── 入口注册表三态（目录命中后查 `agents.get`，事件已错过就靠现读） ──

hostTest('async_wait_agent（入口三态）：注册表现读 idle → 立即 settled（不订阅不进竞速）', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild('entry-idle')] });
  f.ctx.agents = { get: (id) => (id === CHILD ? { status: 'idle' } : undefined) };
  const tool = createWaitAgentTool(f.ctx, config);

  const result = await tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  assert.equal(result.status, 'settled', '入口现读 idle → 已停止运行，立即交回');
  assert.match(result.note, /status turned idle/, 'via=idle（与事件通道同文案）');
  assert.match(result.note, /entry-idle/, 'label 透传');
  assert.ok(result.waited_ms < 50, '入口路径立即交回（毫秒级，不空等预算——屏障 await 本身有几毫秒）');
});

hostTest('async_wait_agent（入口三态）：注册表无驻留（absent）→ 立即 settled（noResident 文案）', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  // 目录行还在、注册表查无此人：与"目录行消失"同档的提前返回，不冒称终结。
  f.ctx.agents = { get: () => undefined };
  const tool = createWaitAgentTool(f.ctx, config);

  const result = await tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  assert.equal(result.status, 'settled');
  assert.match(result.note, /no longer resident in the agent registry/, 'via=noResident');
});

// ── 早到消息的关系定性（停止候选先证关系；查无与查询失败分开） ──

hostTest('async_wait_agent（早到消息·查无未定）：从未存在的 id + 先到 relay → 运行句柄＋未证实，查无断言留给下一次调用', async () => {
  // 真实形态：等待开始前收件箱里滞留一条转达消息（form=relay、无摘要），
  // 注册表查无此人（absent），目录里也从来没有这个 id。入口定性一次查空
  // 不构成「从未存在」的断言（与屏障重试同一理由：查无与查询失败分开，
  // 需求 §2.3.3）：先按存在性未定交回运行句柄＋未证实口径，不套停止态
  // 承诺也不报 not_found——查无断言与已知子代理清单由下一次调用的存在
  // 屏障交付（先到消息不得为屏障重试排队，设计 §2.2）。
  const f = fakeCtx();
  // pollIntervalMs 调小：定性窗口与屏障重试睡眠都按它计时（真机上窗口与
  // 重试间隔为配置值，测试里 2ms 保持快；目录替身微任务即返回，窗口不抢跑）。
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 2 });
  installChildren(f, { children: [] });
  f.ctx.agents = { get: () => undefined };
  agent.inbox.nextStep.push({ id: 'relay-1', source: { kind: 'agent-message', form: 'relay' } });
  const tool = createWaitAgentTool(f.ctx, quick);

  const result = await withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec));
  assert.equal(result.status, 'running', '单次查空 = 存在性未定 → 运行句柄＋未证实，不判 not_found');
  assert.match(result.note, /A processable message arrived \(/, '唤醒说明在场');
  assert.match(result.note, /unverified/, '未证实口径在场（重查出路）');
  assert.doesNotMatch(result.note, /no longer resident/, '不得套停止态文案（对不存在的 id 是永不兑现的承诺）');
  assert.doesNotMatch(result.note, /null/, '未证实档不得渲染字面 null');
  agent.inbox.nextStep.length = 0;

  // 第二次调用（收件箱已清）：存在屏障接管——重试耗尽后交付 not_found
  // 主断言与可选纠错清单。
  const second = await withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 1000 }, exec));
  assert.equal(second.status, 'not_found', '屏障重试耗尽 = 从未存在 → not_found（由屏障交付，不是入口定性）');
  assert.equal(second.agent_id, CHILD);
  assert.ok(Array.isArray(second.known_children), 'not_found 附已知子代理清单');
});

hostTest('async_wait_agent（早到消息·定性证关系）：目录行在 + 注册表查无 + 先到 relay → settled（noResident）', async () => {
  // 存在过但已不驻留：定性查目录有行、复核仍查无 → 维持停止态交回（不因
  // 定性误伤真目标）；同时锁 relay 无摘要的回退文案（括号不再空置，需求 §2.1.3）。
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  f.ctx.agents = { get: () => undefined };
  agent.inbox.nextStep.push({ id: 'relay-2', source: { kind: 'agent-message', form: 'relay', senderSessionId: CHILD } });
  const tool = createWaitAgentTool(f.ctx, config);

  const result = await withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec));
  assert.equal(result.status, 'settled', '目录有行 = 存在过 → noResident 停止态');
  assert.match(result.note, /no longer resident in the agent registry/, 'via=noResident');
  assert.doesNotMatch(result.note, /\(\)/, 'relay 无摘要时括号不得空置（回退文案在场）');
  assert.match(result.note, new RegExp(CHILD), '回退文案点名消息来源（senderSessionId）');
  agent.inbox.nextStep.length = 0;
});

hostTest('async_wait_agent（早到消息·定性失败）：目录查询失败 + absent + 先到 relay → 运行句柄＋未证实，不冒称查无', async () => {
  // 查询失败 ≠ 查无（需求 §2.3.3）：定性读不了目录时存在性未定，交运行句柄
  // 与未证实口径（不制造 not_found，也不制造停止态）。
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [], throws: true });
  f.ctx.agents = { get: () => undefined };
  agent.inbox.nextStep.push({ id: 'relay-3', source: { kind: 'agent-message', form: 'relay' } });
  const tool = createWaitAgentTool(f.ctx, config);

  const result = await withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec));
  assert.equal(result.status, 'running', '存在性未定 → 不判 not_found 也不判 settled');
  assert.match(result.note, /A processable message arrived \(/, '唤醒说明在场');
  assert.doesNotMatch(result.note, /no longer resident/, '不得套停止态文案');
  assert.doesNotMatch(result.note, /null/, '未证实档不得渲染字面 null（复读回退到未证实文案）');
  assert.match(result.note, /unverified/, '未证实口径在场（重查出路）');
  agent.inbox.nextStep.length = 0;
});

hostTest('async_wait_agent（早到消息·定性窗口）：目录查询挂起时窗口封顶，先到消息不等查询也不等预算', async () => {
  // 定性查询永悬（真实形态：宿主投影挂起）：定性窗口 min(pollIntervalMs,
  // 剩余预算) 到点按「关系未证明」交回（设计 §3.4／§2.1 辅助查询全竞速）——
  // 不恢复「仅与总截止竞速」的旧形态的话，本用例要等满 1000ms 预算才红。
  const f = fakeCtx();
  installChildren(f, { children: [runningChild()] });
  f.ctx.subagents.listChildren = () => new Promise(() => {});
  f.ctx.agents = { get: () => ({ status: 'idle' }) };
  agent.inbox.nextStep.push({ id: 'relay-w', source: { kind: 'agent-message', form: 'relay' } });
  const tool = createWaitAgentTool(f.ctx, resolveConfig({ toolName: 'async_run', pollIntervalMs: 120 }));
  const startedAt = Date.now();

  const result = await withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 1000 }, exec));
  const took = Date.now() - startedAt;
  assert.equal(result.status, 'running', '窗口耗尽 = 关系未证明 → 运行句柄＋未证实，不冒停止态');
  assert.match(result.note, /unverified/, '未证实口径在场');
  assert.doesNotMatch(result.note, /status turned idle/, '注册表 idle 只是停止候选——关系未证不得套停止态文案');
  assert.ok(took < 450, `定性窗口 120ms 封顶（实得 ${String(took)}ms，窗口 120ms＋300ms 容差＝420ms，取 450ms 冗余上界）`);
  agent.inbox.nextStep.length = 0;
});

hostTest('async_wait_agent（早到消息·固定响应上限）：合法高轮询值＋挂起目录查询，先到消息仍在 2000 ms 上限内按消息口径交回', async () => {
  // 反例形态（设计 §3.4／§8.2 总预算行）：pollIntervalMs=10000 合法（仅受
  // 与 maxWaitMs 配对约束），目录查询永久挂起，收件箱预存 user 插话——旧实现
  // 窗口＝min(轮询, 剩余预算)，消息要等满轮询间隔；三取小后被 2000 ms 固定
  // 响应上限封顶，为 §8.1 的 5000 ms 真机响应窗留六成余量。
  const f = fakeCtx();
  installChildren(f, { children: [runningChild()] });
  f.ctx.subagents.listChildren = () => new Promise(() => {});
  f.ctx.agents = { get: () => ({ status: 'idle' }) };
  agent.inbox.nextStep.push({ id: 'user-hi', source: { kind: 'user' } });
  const tool = createWaitAgentTool(f.ctx, resolveConfig({ toolName: 'async_run', pollIntervalMs: 10000, maxWaitMs: 600000 }));
  const startedAt = Date.now();

  const result = await withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 60000 }, exec), 2600);
  const took = Date.now() - startedAt;
  assert.equal(result.status, 'interrupted', '先到 user 插话按消息口径交回（关系未证明不套停止态）');
  assert.ok(took < 2600, `定性窗口被 2000 ms 固定上限封顶（实得 ${String(took)}ms，上限 2000ms＋300ms 容差＝2300ms，取 2600ms 冗余上界）`);
  agent.inbox.nextStep.length = 0;
});

hostTest('async_wait_agent（早到消息·定性窗口新插话）：挂起定性查询期间 user 插话到达 → 及时按消息口径交回', async () => {
  // 唤醒类竞速成员的护栏（设计 §2.1「辅助查询与可处理消息竞速」）：
  // watchWakeSignal 无起始检查，先到唤醒不解析唤醒 promise——定性窗口内
  // **新到**的 user 插话必须能切断挂起的定性查询。若唤醒成员被误排除
  // （比如把先到消息一律当已解析信号排除），本用例会等满定性窗口才红。
  const f = fakeCtx();
  installChildren(f, { children: [runningChild()] });
  f.ctx.subagents.listChildren = () => new Promise(() => {});
  f.ctx.agents = { get: () => ({ status: 'idle' }) };
  agent.inbox.nextStep.push({ id: 'relay-nw', source: { kind: 'agent-message', form: 'relay' } });
  const tool = createWaitAgentTool(f.ctx, resolveConfig({ toolName: 'async_run', pollIntervalMs: 1500 }));
  const startedAt = Date.now();

  const pending = withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 2000 }, exec));
  await new Promise((resolve) => setTimeout(resolve, 20));
  f.emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '先回来', target: 'next-step' }));
  const result = await pending;
  const took = Date.now() - startedAt;
  assert.equal(result.status, 'running', '定性未完成（查询挂起）→ 消息口径交回运行句柄＋未证实');
  assert.ok(took < 500, `新到插话切断定性（实得 ${String(took)}ms），不等窗口也不等挂起查询`);
  agent.inbox.nextStep.length = 0;
});

hostTest('async_wait_agent（早到消息·定性期结算先到）：先到 user 插话 + 挂起定性查询 + 结算通知中途到达 → settled（完成优先）', async () => {
  // 定性竞速里的新到信号先复核未领取结算通知（设计 §3.4：完成优先）——
  // 结算通知在定性查询挂起期间到达时按 settled 交回，不等查询也不等预算。
  const f = fakeCtx();
  installChildren(f, { children: [runningChild()] });
  f.ctx.subagents.listChildren = () => new Promise(() => {});
  f.ctx.agents = { get: () => ({ status: 'idle' }) };
  agent.inbox.nextStep.push({ id: 'steer-cls', source: { kind: 'user' } });
  const tool = createWaitAgentTool(f.ctx, resolveConfig({ toolName: 'async_run', pollIntervalMs: 1500 }));
  const startedAt = Date.now();

  const pending = withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 2000 }, exec));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // 事件驱动结算（订阅通道）＋投递账本同步（真实宿主两侧一致；假件只发
  // 事件不落 inbox，复核读的是账本）。
  const notice = settledNotice({ senderSessionId: CHILD });
  f.emit('agent/inbox/inserted', notice);
  agent.inbox.nextStep.push({ id: 'msg-settle-cls', ...notice.message });
  const result = await pending;
  const took = Date.now() - startedAt;
  assert.equal(result.status, 'settled', '定性期结算通知到达 → 完成优先，settled 交回');
  assert.match(result.note, /had already arrived before the wait started/, 'via.noticePreexisting（结算通知先于定性结论）');
  assert.ok(took < 500, `结算到达后及时交回（实得 ${String(took)}ms），不等挂起查询`);
  agent.inbox.nextStep.length = 0;
});

hostTest('async_wait_agent（早到消息·复核翻档）：定性查到行但注册表复核翻成 running → 回落消息口径', async () => {
  // 定性四档里的「复核」不是装饰：目录行在、入口读 idle、复核瞬间翻成
  // running（真实形态：目标恰好重启驱动）——停止候选作废，按消息口径交回，
  // 不把 idle 旧读当停止证据。
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  let registryCalls = 0;
  f.ctx.agents = { get: () => { registryCalls += 1; return registryCalls <= 1 ? { status: 'idle' } : { status: 'running' }; } };
  agent.inbox.nextStep.push({ id: 'relay-flip', source: { kind: 'agent-message', form: 'relay' } });
  const tool = createWaitAgentTool(f.ctx, config);

  const result = await withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec));
  assert.equal(result.status, 'running', '复核翻档 → 停止候选作废，回落消息口径（运行句柄）');
  assert.match(result.note, /A processable message arrived \(/, '唤醒说明在场');
  assert.doesNotMatch(result.note, /status turned idle|no longer resident/, '不得套任一停止态文案');
  agent.inbox.nextStep.length = 0;
});

hostTest('async_wait_agent（早到消息·迟到作答矩阵）：先到迟到作答 + 注册表 idle + 目录行在 → 定性证关系后 settled', async () => {
  // 早到迟到作答与 user／relay 同受合法关系约束（设计 §3.4 出口矩阵）：
  // 停止候选先证关系，证得后以 lateArrived 前缀交停止态。
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  f.ctx.agents = { get: (id) => (id === CHILD ? { status: 'idle' } : undefined) };
  agent.inbox.nextStep.push({
    id: 'late-1',
    source: { kind: 'async-tools-late-answer', form: 'notice', questionId: 'q-1' }
  });
  const tool = createWaitAgentTool(f.ctx, config);

  const result = await withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec));
  assert.equal(result.status, 'settled', '目录行 + 复核仍 idle = 关系已证 → settled');
  assert.match(result.note, /late answer/, 'lateArrived 前缀在场（并存消息以说明表达）');
  assert.match(result.note, /status turned idle/, 'via=idle（停止证据）');
  agent.inbox.nextStep.length = 0;
});

hostTest('async_wait_agent（屏障查无·清单竞速×取消）：not_found 的清单查询挂起时取消先到 → 取消口径，不等清单', async () => {
  // 屏障重试耗尽后的可选清单查询与工具取消同时竞速（设计 §2.1）：主断言
  // 已证但控制信号优先——不得为等清单把取消压到预算尽头。
  const f = fakeCtx();
  const { calls } = installChildren(f, { children: [] });
  const realList = f.ctx.subagents.listChildren.bind(f.ctx.subagents);
  f.ctx.subagents.listChildren = async (...a) => {
    if (calls.length >= 4) return new Promise(() => {}); // 第 5 路起＝清单查询，永悬
    return realList(...a);
  };
  f.ctx.agents = { get: () => ({ status: 'running' }) };
  const controller = new AbortController();
  const tool = createWaitAgentTool(f.ctx, resolveConfig({ toolName: 'async_run', pollIntervalMs: 2 }));
  const startedAt = Date.now();

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 2000 }, { agent, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 40));
  controller.abort(new Error('caller cancelled'));
  const result = await pending;
  const took = Date.now() - startedAt;
  assert.equal(result.status, 'interrupted', '取消胜出清单查询 → 取消口径（不是 not_found）');
  assert.ok(!('known_children' in result), '取消出口不带清单（没等到也不需要）');
  assert.ok(took < 400, `取消后及时交回（实得 ${String(took)}ms）——清单只与总截止竞速的旧形态会红`);
});

hostTest('async_wait_agent（屏障查无·清单竞速×插话）：not_found 的清单查询挂起时插话先到 → interrupted，不谎报查无', async () => {
  // 清单查询挂起期间 user 插话到达（设计 §2.1 辅助查询全竞速＋需求 §2.1.2）：
  // 已到消息的处理不等诊断清单——交回控制权给模型。
  const f = fakeCtx();
  const { calls } = installChildren(f, { children: [] });
  const realList = f.ctx.subagents.listChildren.bind(f.ctx.subagents);
  f.ctx.subagents.listChildren = async (...a) => {
    if (calls.length >= 4) return new Promise(() => {});
    return realList(...a);
  };
  f.ctx.agents = { get: () => ({ status: 'running' }) };
  const tool = createWaitAgentTool(f.ctx, resolveConfig({ toolName: 'async_run', pollIntervalMs: 2 }));
  const startedAt = Date.now();

  const pending = withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 2000 }, exec));
  await new Promise((resolve) => setTimeout(resolve, 40));
  f.emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '先回来', target: 'next-step' }));
  const result = await pending;
  const took = Date.now() - startedAt;
  assert.equal(result.status, 'interrupted', '插话胜出清单查询 → interrupted（不是 not_found）');
  assert.ok(took < 400, `插话后及时交回（实得 ${String(took)}ms）`);
});

hostTest('async_wait_agent（入口三态）：注册表查询抛错/服务缺席（unknown）→ 照常进入等待', async () => {
  const f = fakeCtx();
  // 不冻结：预算到期要真的到（unknown 只是不在入口提前返回，等待语义照旧）。
  installChildren(f, { children: [runningChild()] });
  // 服务在场但抛错：状态未证实——不制造 not-found 也不制造停止态。
  f.ctx.agents = { get: () => { throw new Error('registry unavailable'); } };
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 30 }, exec);
  const raced = await Promise.race([
    pending.then(() => 'returned'),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 10))
  ]);
  assert.equal(raced, 'still-waiting', 'unknown 不得在入口提前返回（宁可进等待）');
  const result = await pending;
  assert.equal(result.status, 'running', '预算到期照常 running');
});

hostTest('async_wait_agent（双通道·轮询侧）：等待中注册表转 idle（无任何事件）→ polled 通道唤醒 → settled via.idle', async () => {
  const f = fakeCtx();
  // 不冻结：轮询走真 interval（2ms 一拍），这是双通道的轮询侧本身。
  installChildren(f, { children: [runningChild('poll-me')] });
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 2 });
  // 轮询观察器：前两拍 running，第三拍 idle——事件通道全程静默（错过 idle 事件
  // 的真实形态：等待开始前状态已转，只有注册表现读能看到）。
  let ticks = 0;
  f.ctx.agents = { get: (id) => (id === CHILD ? { status: ++ticks < 3 ? 'running' : 'idle' } : undefined) };
  const tool = createWaitAgentTool(f.ctx, quick);

  const result = await tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  assert.equal(result.status, 'settled', '轮询通道观察到 idle → 复查确认 → settled');
  assert.match(result.note, /status turned idle/, 'via=idle（注册表复查，与事件通道同文案）');
  assert.ok(ticks >= 3, '轮询真的查了注册表（探针活性）');
});

hostTest('async_wait_agent（完成优先）：结算通知同拍双命中唤醒 → settled 直返，投影滞后窗口不误报 running', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  // 投影滞后形态：注册表与目录在整个窗口内恒读 running（通知已到、投影未更新）。
  // 竞速若把 wake 排在 settled 前，同拍双命中时 wake 先出线、复查层读到 running
  // → 误报 running 且 note 声称 still running（双重误报）——这是缺陷形态。完成优先：权威结算
  // 信号已到 ⇒ settled（设计 §2.1，与 async_wait_job 同名决定一致）。
  f.ctx.agents = { get: () => ({ status: 'running' }) };
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.emit('agent/inbox/inserted', settledNotice());

  const result = await pending;
  assert.equal(result.status, 'settled', '不被唤醒分支压制');
  assert.match(result.note, /settlement notice/, 'via=notice（信号来源注明）');
  assert.doesNotMatch(result.note, /still running/, '不得再声称"仍在运行"');
});

hostTest('async_wait_agent（串行轮询·幽灵链）：等待结束后在途 tick 不得续排新拍（R4 可逆性）', async () => {
  const f = fakeCtx();
  // 真 timer + 计数替身：记录每次 timeout 武装，dispose 真撤销——冻结模式看不见
  // 这条路径（替身 timeout 恒返回空 disposer）。
  let armed = 0;
  const realTimeout = f.ctx.timer.timeout.bind(f.ctx.timer);
  f.ctx.timer = {
    ...f.ctx.timer,
    timeout: (fn, ms) => { armed += 1; return realTimeout(fn, ms); }
  };
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 5 });
  installChildren(f, { children: [runningChild()] });
  f.ctx.agents = { get: () => ({ status: 'running' }) };
  // 第 1 次 listChildren 是存在性屏障（立即放行）；第 2 次是首个轮询拍的目录查询
  // ——把它挂起，构造「竞速由 deadline 收敛时恰有一拍在途」。
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const realList = f.ctx.subagents.listChildren.bind(f.ctx.subagents);
  f.ctx.subagents.listChildren = async (...a) => {
    calls += 1;
    if (calls === 2) await gate;
    return realList(...a);
  };
  const tool = createWaitAgentTool(f.ctx, quick);

  const result = await tool.execute({ agent_id: CHILD, wait_ms: 60 }, exec);
  assert.equal(result.status, 'running', '预算到期、目标仍在运行');
  const armedAtReturn = armed;
  release(); // 放行在途拍——无检查的续排会让链自续（每 5ms 一拍）
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  assert.equal(armed, armedAtReturn,
    `工具返回后不得再武装新的轮询拍（幽灵链；返回时 ${String(armedAtReturn)} 拍，80ms 后 ${String(armed)} 拍）`);
});

hostTest('async_wait_agent（有界查询·r3）：目录查询挂起不得超预算占用主体——到期收敛后复查也不等诊断', async () => {
  const f = fakeCtx();
  // 不冻结：deadline 要真的到。目录查询挂 600ms（远超 wait_ms=250）——屏障与
  // 复查各占一段等待时，极端情况总时长约 1200ms（600ms + 600ms）——上限判据覆盖。
  installChildren(f, { children: [runningChild()] });
  f.ctx.agents = { get: () => ({ status: 'running' }) };
  const realList = f.ctx.subagents.listChildren.bind(f.ctx.subagents);
  f.ctx.subagents.listChildren = async (...a) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return realList(...a);
  };
  const tool = createWaitAgentTool(f.ctx, config);

  const start = Date.now();
  const result = await tool.execute({ agent_id: CHILD, wait_ms: 250 }, exec);
  const took = Date.now() - start;
  assert.equal(result.status, 'running', '预算到期照常 running');
  assert.ok(took < 450, `挂起查询下总时长 ${String(took)}ms 必须贴住 250ms 预算（+调度容差），不得等诊断`);
});

hostTest('async_wait_agent（有界查询·r3）：唤醒收敛后复查只拿剩余预算——插话后不等挂起的目录查询', async () => {
  const f = fakeCtx();
  installChildren(f, { children: [runningChild()] });
  f.ctx.agents = { get: () => ({ status: 'running' }) };
  const realList = f.ctx.subagents.listChildren.bind(f.ctx.subagents);
  f.ctx.subagents.listChildren = async (...a) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return realList(...a);
  };
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 2000 }, exec);
  setTimeout(() => {
    f.emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '停一下', target: 'next-step' }));
  }, 120);
  const start = Date.now();
  const result = await pending;
  const took = Date.now() - start;
  assert.equal(result.status, 'interrupted', '插话路径照常打断');
  assert.ok(took < 500, `插话后交回 ${String(took)}ms——复查与剩余预算竞速，不得再等 600ms 挂起查询`);
});

hostTest('async_wait_agent（T2）：用户插话 → interrupted，子代理一次都没被碰过', async () => {
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
  assert.match(result.note, /Ending the wait did not stop subagent child-42/);
  assert.match(result.note, /async_wait_agent/);

  // 核心不变量：打断**等待**不得打断**子代理**。
  assert.deepEqual(state.interrupted, [], 'subagents.interrupt 一次都不能被调用');
  const rows = await f.ctx.subagents.listChildren(agent.id);
  assert.equal(rows.length, 1, '子代理必须还在列表里（仍在运行）');
  assert.equal(rows[0].id, CHILD);
  assert.ok(calls.length >= 1);

  // 探针活性证明：这套探针**确实**能记到打断。不证明这一点，
  // 上面的空数组与"探针坏了"无法区分（这是恒真断言的风险）。
  f.ctx.subagents.interrupt(CHILD);
  assert.deepEqual(state.interrupted, [CHILD]);
  assert.deepEqual(await f.ctx.subagents.listChildren(agent.id), []);
  agent.inbox.nextStep.length = 0; // 还原共享 fixture（等待入口会读它——设计 §2.2 入口扫描）
});

hostTest('async_wait_agent（R30-d 唤醒分支）：等待中迟到作答通知 → 运行句柄 + note，非 interrupted 非 settled', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // 迟到作答到达（插件事件——ask-takeover 宿主半边发布，载荷含
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

hostTest('async_wait_agent（R30 通道轮 起始检查）：作答先到、等待后开 → 立即运行句柄 + note（不空转预算）', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  // 待读登记非空：作答已投递未领取（滞留 next-step——这种等待会
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

hostTest('async_wait_agent（T2 反向对照）：工具自身被取消 → 取消口径交回，但子代理仍未被碰', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const { state } = installChildren(f, { children: [runningChild()] });
  const controller = new AbortController();
  const tool = createWaitAgentTool(f.ctx, config);
  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, { agent, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort(new Error('用户点了停止'));

  // 设计 §2.5 取消口径：取消收敛返回取消文案（合法形状——宿主对已中止调用
  // 会整体改写模型可见结果，这里钉的是执行结果侧），不再以竞速 reject 上抛。
  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.match(result.note, /The wait was cancelled/);
  assert.match(result.note, /the cancellation did not stop subagent child-42/);
  assert.deepEqual(state.interrupted, [], '取消工具调用也不等于取消子代理');
  assert.equal((await f.ctx.subagents.listChildren(agent.id)).length, 1);
});

/**
 * 只让**第一个** `timeout` 真正生效（那是等待预算的 deadline），其余冻结；
 * 同时冻结回退轮询 —— 该轮询的到期条件是"子代理从列表里消失"，
 * 在一个 listChildren 恒返回同一份数据的替身里它永远不会触发，
 * 但它的 interval 会让竞速难以预测（轮询若抢先到期，等待会被解成 running）。
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

hostTest('async_wait_agent：子代理转达消息不得被当作插话或结算', async () => {
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

hostTest('async_wait_agent：预算到期 → running 且提示可再次等待（注册表证实仍在运行）', async () => {
  const f = fakeCtx();
  firstTimerOnly(f.ctx);
  installChildren(f, { children: [runningChild()] });
  // 证实档的前提（设计 §1.3）：注册表现读 running 才允许说"尚未结束"——
  // 目录行不算数（R29-c 判据 6·注册表读不到用例锁同款用例的未证实档）。
  f.ctx.agents = { get: () => ({ status: 'running' }) };
  const tool = createWaitAgentTool(f.ctx, config);

  const result = await tool.execute({ agent_id: CHILD, wait_ms: 5000 }, exec);
  assert.equal(result.status, 'running');
  assert.equal(result.agent_id, CHILD);
  assert.match(result.note, /unaffected, still running/);
  assert.match(result.note, /has not finished yet/);
  assert.match(result.note, /async_wait_agent\(agent_id=/, '文案必须指向 async_wait_agent，不能复用 job 的 async_wait_job');
});

hostTest('async_wait_agent：子代理列表不可用 → 报错而不是假装结束', async () => {
  const f = fakeCtx();
  installChildren(f, { throws: true });
  const tool = createWaitAgentTool(f.ctx, config);
  await assert.rejects(
    () => tool.execute({ agent_id: CHILD, wait_ms: 1000 }, exec),
    /subagent listing unavailable/
  );
});

hostTest('async_wait_agent：工具自身被取消 → 立即结束等待（取消口径交回）', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  const controller = new AbortController();
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, { agent, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const tCancel = Date.now();
  controller.abort(new Error('用户点了停止'));

  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.match(result.note, /The wait was cancelled/);
  assert.ok(Date.now() - tCancel < 500, '取消必须立即交回，不等剩余预算或复查');
});

hostTest('async_wait_agent：结束时清理所有监听器（R4 可逆性）', async () => {
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
// 以下用例是缺陷防御组。
// ---------------------------------------------------------------------------

hostTest('async_wait_agent（形状带 activity 时）：屏障读出非运行态 → 立即 settled，不进等待', async () => {
  const f = fakeCtx();
  // 冻结截止与轮询：屏障若没生效，这个调用会永远挂着（不会假装通过）。
  freezeTimers(f.ctx);
  // 只有**判别联合**形状（`listDescendants()` 的行）才带 `activity`；
  // `listChildren()` 行不带，所以这条快速返回是真机上的功能缺口，不是主路径。
  installChildren(f, { children: [legacyChildRow('inactive')] });
  const tool = createWaitAgentTool(f.ctx, config);

  const outcome = await Promise.race([
    tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'still-waiting' }), 50))
  ]);

  assert.equal(outcome.status, 'settled', 'R3：不再观察到它在运行 → 立即结束等待');
  assert.equal(outcome.agent_id, CHILD);
  // 措辞决定（设计 §3.4）：`inactive` 只表示"这一行走了冷读"，**不是**
  // "它结束了"。所以说明必须停在"不再观察到它在运行"（英文口径：
  // "is no longer observed running"），不许替宿主下"已结束"（has finished）的结论。
  assert.match(outcome.note, /is no longer observed running/, '必须只声明观察到什么，不得断言"它已结束"');
  assert.doesNotMatch(outcome.note, /状态已不是运行态/, '不许再用"已不是运行态"这种像结论的说法');
  assert.match(outcome.note, /will arrive as a separate message/);
});

hostTest('async_wait_agent（形状带 activity 时）：等待期间列表变成非运行态 → 收敛时报 settled 而不是 running', async () => {
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

hostTest('async_wait_agent：查询失败（列表抛错）不得被当成已结束', async () => {
  const f = fakeCtx();
  // 屏障查询抛错 → 必须报错而不是假装结束（与"查不到条目"区分开）。
  installChildren(f, { throws: true });
  const tool = createWaitAgentTool(f.ctx, config);
  await assert.rejects(
    () => tool.execute({ agent_id: CHILD, wait_ms: 1000 }, exec),
    /subagent listing unavailable/
  );
});

hostTest('async_wait_agent：diagnostic 行不算子代理，但仍要写进纠错清单并带 reason', async () => {
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
  assert.doesNotMatch(result.known_children.join('\n'), /\?, \?/, '不得让模型看到 "?, ?" 这种占位（占位符等于把纠错信息抹掉）');
});

hostTest('async_wait_agent：目标被判为不可用（diagnostic 行）→ not_found，不得进入等待', async () => {
  const f = fakeCtx();
  // 不 freezeTimers：屏障重试睡用的是 ctx.timer（冻住会把重试睡死），需要真
  // 定时器。总截止在参数解析后即武装、先于屏障（设计 §2.1 单一总截止）；屏障
  // 判 not_found 提前返回时由 cleanup 撤销定时器——不是「deadline 没被武装」，
  // 武装与撤销都发生在本次调用内部。
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 2 });
  installChildren(f, { children: [{ kind: 'diagnostic', id: CHILD, reason: 'unavailable' }] });
  const tool = createWaitAgentTool(f.ctx, quick);

  const outcome = await Promise.race([
    tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'still-waiting' }), 200))
  ]);
  assert.equal(outcome.status, 'not_found');
});

hostTest('async_wait_agent：描述必须写清功能边界并带上生效的预算数字', () => {
  const f = fakeCtx();
  const tool = createWaitAgentTool(f.ctx, resolveConfig({ toolName: 'async_run', minWaitMs: 300, maxWaitMs: 120000 }));
  // 描述里的功能边界必须**与现行机制一致**：入口即查注册表现读与未领取的
  // 结算通知——已结束目标立即返回 settled，不等满预算；目录快照只证明存在性，
  // 确认真实状态的手段是结算通知或 list_agents。
  assert.match(tool.description, /subagent catalog shows which children exist/,
    '必须交代"列表快照只能证明存在性"这条功能边界');
  assert.match(tool.description, /returns status:"settled" immediately instead of waiting out the budget/,
    '必须交代入口检查对已结束目标立即交回，否则模型会无谓绕开本工具');
  assert.match(tool.description, /list_agents/, '必须给出确认真实状态的手段');
  assert.match(tool.description, /120000 ms/, '等待上限必须来自生效配置（补缺口）');
  // 覆盖口径句 + pollIntervalMs 现值插值（缺省 500 ms）。
  assert.match(tool.description, /budget bounds the total call time: the existence barrier \(up to 3 x 500 ms of retries\) plus the wait segment/,
    '覆盖口径句必须在描述里，且屏障重试上限随 pollIntervalMs 现值插值');
  // 反侧：不许再出现与设计 §3.4 入口检查矛盾的那句绝对化说法。
  assert.doesNotMatch(tool.description, /必然等满|always waits out the full/, '该绝对化说法与入口检查机制矛盾');
  // 段落拼接：多段 join('') 时**任何**一段忘了尾随空格，都会把两个句子粘成一个词
  // （`reach you.When`——该形态是段落拼接的典型接缝缺陷）。语言无关的通用断言：
  // 句号后紧跟大写字母 = 缺空格（本描述里没有合法的 `x.Y` 序列）。
  assert.doesNotMatch(tool.description, /\.[A-Z]/, '段与段之间必须留出分隔（句号后必须有空格）');
  // `settled` 的承诺口径（设计 §3.4）：**不得**写成"它已经结束了"。
  assert.match(tool.description, /no longer observed running/, 'settled 只能承诺"不再观察到它在运行"');
  // 反侧断言必须**能命中真实风险**：描述是英文串，用中文正则（`/它结束了/`）永远不命中
  // ——那是恒真断言。盯英文形态：
  // 把描述改成 "settled means it has finished" 必须变红。
  assert.doesNotMatch(tool.description, /settled means (that )?it has (already )?finished/i,
    'settled 不许承诺"它结束了"');
  // 并且参数表里确实没有 yield_ms —— 描述里当然也不该提。
  // JSON Schema 形状：参数在 `parameters.properties` 下。
  assert.equal(tool.parameters.properties.yield_ms, undefined, 'async_wait_agent 没有 yield_ms 参数');
  assert.doesNotMatch(tool.description, /yield_ms/, '描述提到了一个不存在的参数');
  assert.doesNotMatch(tool.description, /转入后台|返回 job_id|作业编号/, 'async_wait_agent 不会转后台，也不返回作业编号');
  assert.doesNotMatch(tool.description, /首次等待|让出预算/, '首次等待（让出预算）是 async_run 的概念');
});

hostTest('async_wait_agent（R8 第一条）：只走公共查询与公共事件，碰内部状态就红', async () => {
  // ## 这条判据要挡什么
  //
  // 需求 §2.3.3：`async_wait_agent` **不得读会话日志、内部状态或越界数据**，只能走
  // 宿主的公共查询（`ctx.subagents.listChildren`）与宿主的公共事件（`ctx.on`）。
  //
  // 静态侧由 `test/index.test.mjs` 的一条**静态**断言承担（扫 `ctx.<x>` 是否在
  // `inject` 里）：它挡"忘了声明 inject"，但**挡不住"用了已声明服务上的非公共属性"**
  // —— 只要 `subagents` 声明了，静态扫描就放行。
  //
  // 本用例把它**行为化**：`guardedWaitAgentCtx()` 把 ctx 包成 Proxy，
  // **只有明确列出的属性可读**，读别的立刻抛错并记下名字。于是"碰了内部状态"
  // 不再是靠读代码发现，而是用例当场变红**并指出碰的是哪个属性**。
  const g = guardedWaitAgentCtx();
  freezeTimers(g.ctx);
  // 行用真实形状（catalog 条目：无 `kind`）——假件按另一种形状造，正是
  // 真机缺陷（屏障恒 not_found）在单测里不可见的盲区。
  g.children.push({ id: CHILD, createdAt: 1, mode: 'continuable', label: 'child work' });
  const tool = createWaitAgentTool(g.ctx, resolveConfig({ toolName: 'async_run', minWaitMs: 250, maxWaitMs: 120000 }));
  const agent = fakeAgent();

  // 跑完一次**正常路径**：屏障读到子代理还在 ⇒ 进入等待 ⇒ 发一条公共事件结束它。
  const pending = tool.execute({ agent_id: CHILD, wait_ms: 5000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // 结算通知走的是宿主的公共事件通道；`senderSessionId` 精确关联。
  //
  // 必须用 `settledNotice()`（真实形状：`source.kind === 'subagent-settled'` 且带
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
    `必须通过宿主的公共查询读子代理列表；实得接触点：${g.touched.join('、')}`);
  assert.ok(g.touched.includes('on'),
    `必须通过宿主的公共事件订阅；实得接触点：${g.touched.join('、')}`);
});

// ---------------------------------------------------------------------------
// 安全/健壮性/异常处理的缺陷防御判据。
// ---------------------------------------------------------------------------

/**
 * 进程级 unhandledRejection 探针的核心断言集。
 *
 * 宿主 `installFailLoud` 语义下，一条无人接住的 reject 就是整实例退出。
 * 测试里用 `process.on('unhandledRejection')` 复刻同一道关卡——取消归一
 * （wait-agent.js 在创建点同步挂接的双分支 `.then(onOk, onErr)`，把 reject
 * 归一成标签）撤掉后，本探针非空，用例当场红。
 *
 * @returns {{take: Function, off: Function}} 探针：`take()` 读累计数组，`off()` 摘除。
 */
function unhandledProbe() {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  return { take: () => seen, off: () => process.off('unhandledRejection', onUnhandled) };
}

hostTest('R29-a（判据 1·屏障窗口）：工具取消落在竞速组装之前——屏障及时交回 interrupted，取消归一承接不外泄', async () => {
  const f = fakeCtx();
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 2 });
  // 列表恒空 → 屏障按 pollIntervalMs 有界重试 → abort 落在"第一个 await childOf
  // 之后"的窗口里（窗口长达 3×pollIntervalMs，正是取消归一的靶区）。
  const { calls } = installChildren(f, { children: [] });
  const controller = new AbortController();
  const tool = createWaitAgentTool(f.ctx, quick);
  const probe = unhandledProbe();

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 1000 }, { agent, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 3)); // 进入第一个屏障重睡
  controller.abort(new Error('tool cancelled')); // 窗口内取消：aborted 此刻 reject
  const result = await pending; // 屏障睡眠与取消竞速 → 及时 interrupted（需求 §2.1.2）
  await new Promise((resolve) => setTimeout(resolve, 30)); // 微任务排空：若有未接住的 reject 必已上报

  assert.equal(result.status, 'interrupted', '屏障期取消必须及时结束等待，不得跑满重试/预算');
  assert.ok(calls.length >= 1);
  assert.equal(probe.take().length, 0,
    '取消归一（wait-agent.js 创建点同步挂接的双分支 .then(onOk, onErr)）必须承接窗口期 reject——撤掉它，本断言必红（整实例退出）');
  probe.off();
});

hostTest('R29-a（判据 1·屏障睡眠）：用户插话在重试睡眠中到达 → 及时 interrupted，不等满重试', async () => {
  const f = fakeCtx();
  // 列表恒空 → 屏障进重试睡眠；pollIntervalMs 大（真实部署形态）——睡眠必须
  // 与唤醒信号竞速，否则一条 20ms 到达的插话要等 3×pollIntervalMs 跑满后
  // 以 not_found 谎报收场（需求 §2.1.2：消息的处理不能等满剩余预算）。
  installChildren(f, { children: [] });
  f.ctx.agents = { get: () => ({ status: 'running' }) };
  const tool = createWaitAgentTool(f.ctx, resolveConfig({ toolName: 'async_run', pollIntervalMs: 1500 }));
  const startedAt = Date.now();

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 2000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 20));
  f.emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '先回来', target: 'next-step' }));
  const result = await pending;
  const took = Date.now() - startedAt;

  assert.equal(result.status, 'interrupted', '插话必须结束屏障等待并以 interrupted 交回，不得谎报 not_found');
  assert.ok(took < 1000, `插话后必须及时交回（实得 ${String(took)}ms），不得等满重试或预算`);
});

hostTest('R29-a（判据 1·屏障查询期）：取消落在在途查询上 → 及时 interrupted，不等查询也不等预算', async () => {
  const f = fakeCtx();
  // 目录查询永悬（真实形态：宿主投影挂起）——取消必须与查询竞速胜出；
  // 忽略 signal 的宿主实现同样被时间界封住（需求 §2.1.1 准备查询阶段及时交回）。
  installChildren(f, { children: [] });
  f.ctx.subagents.listChildren = () => new Promise(() => {});
  f.ctx.agents = { get: () => ({ status: 'running' }) };
  const controller = new AbortController();
  const tool = createWaitAgentTool(f.ctx, resolveConfig({ toolName: 'async_run', pollIntervalMs: 1500 }));
  const startedAt = Date.now();

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 1200 }, { agent, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(new Error('caller cancelled'));
  const result = await pending;
  const took = Date.now() - startedAt;

  assert.equal(result.status, 'interrupted', '在途查询期的取消必须立即结束等待，不得等满预算');
  assert.ok(took < 500, `取消后必须及时交回（实得 ${String(took)}ms）`);
});

hostTest('R29-a（判据 1·屏障 not_found 复核）：重试耗尽的最后一轮查询赢得竞速 → 已到插话仍须交回', async () => {
  const f = fakeCtx();
  // 微任务次序陷阱：最后一轮快速查询稳定压过已解析的唤醒信号——not_found
  // 出口前必须同步复核，已到消息不得被重试耗尽吞掉（需求 §2.1.2）。
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: 2 });
  installChildren(f, { children: [] });
  f.ctx.agents = { get: () => ({ status: 'running' }) };
  const tool = createWaitAgentTool(f.ctx, quick);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 1000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 3));
  f.emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: '改主意了', target: 'next-step' }));
  await new Promise((resolve) => setTimeout(resolve, 3));
  const result = await pending;

  assert.equal(result.status, 'interrupted', '消息已在收件箱时 not_found 不得胜出——存在性未定，交回控制给模型');
});

hostTest('R29-c（判据 6·复查失败）：到期收敛后复查查询抛错 → 状态未证实文案，不宣称"尚未结束"', async () => {
  const f = fakeCtx();
  // 屏障首查即中（目标在场）→ 等待；到期收敛后的复查查询抛错——注册表仍
  // 可读（running）但目录复查失败：状态未证实，note 不得再写"尚未结束
  // （仍在运行）"（需求 §2.2.2：无法证实时不得宣称确定状态）。
  installChildren(f, { children: [runningChild()] });
  f.ctx.agents = { get: () => ({ status: 'running' }) };
  const realList = f.ctx.subagents.listChildren.bind(f.ctx.subagents);
  let callsCount = 0;
  f.ctx.subagents.listChildren = async (...a) => {
    callsCount += 1;
    if (callsCount >= 2) throw new Error('listing blew up at recheck');
    return realList(...a);
  };
  const tool = createWaitAgentTool(f.ctx, resolveConfig({ toolName: 'async_run', minWaitMs: 250 }));

  const result = await tool.execute({ agent_id: CHILD, wait_ms: 250 }, exec);

  assert.equal(result.status, 'running');
  assert.match(result.note, /unverified/i, '复查失败必须明说状态未证实');
  assert.doesNotMatch(result.note, /not finished yet \(unaffected, still running\)|尚未结束/,
    '复查失败时不得宣称"尚未结束（仍在运行）"');
  assert.match(result.note, /async_wait_agent\(agent_id="child-42"/, '重试出路必须指向 async_wait_agent');
});

hostTest('R29-c（判据 6·注册表读不到）：到期收敛且目录行在场 → 未证实文案，目录行不算运行证据', async () => {
  const f = fakeCtx();
  // 目录行恒在场（stale 投影），注册表 agents.get 恒抛错：到期回退档不得以
  // 目录行为据宣称"尚未结束（仍在运行）"（设计 §1.3——目录条目只证明会话
  // 存在过，注册表驻留才证明当前有驱动；需求 §2.2.2——无法证实不宣称）。
  installChildren(f, { children: [runningChild()] });
  f.ctx.agents = { get: () => { throw new Error('registry blew up'); } };
  const tool = createWaitAgentTool(f.ctx, resolveConfig({ toolName: 'async_run', minWaitMs: 250 }));

  const result = await tool.execute({ agent_id: CHILD, wait_ms: 250 }, exec);

  assert.equal(result.status, 'running');
  assert.match(result.note, /unverified/i, '注册表读不到必须明说状态未证实');
  assert.doesNotMatch(result.note, /not finished yet|尚未结束/, '目录行在场也不得宣称"尚未结束（仍在运行）"');
  assert.match(result.note, /async_wait_agent\(agent_id="child-42"/, '重试出路必须指向 async_wait_agent');
});

hostTest('F2：接线段中途抛错 → 已建立的订阅全部撤销后原样上抛（初始化撤销，需求 §6.2）', async () => {
  const f = fakeCtx();
  installChildren(f, { children: [runningChild()] });
  // 在第 4 路（agent/status）订阅上同步炸：此前 wake（inbox）、迟到作答、
  // activity 的第一路（inbox）都已建立——回退必须逐一撤销，不留悬挂订阅。
  const realOn = f.ctx.on.bind(f.ctx);
  f.ctx.on = (name, listener) => {
    if (name === 'agent/status') throw new Error('status subscription broke');
    return realOn(name, listener);
  };
  const tool = createWaitAgentTool(f.ctx, config);

  await assert.rejects(
    tool.execute({ agent_id: CHILD, wait_ms: 30000 }, exec),
    /status subscription broke/,
    '接线失败按原样上抛（诚实错误，不冒充业务结局）'
  );

  f.ctx.on = realOn;
  assert.equal((f.listeners.get('agent/inbox/inserted') ?? []).length, 0, '唤醒订阅已撤销');
  assert.equal((f.listeners.get(LATE_ANSWER_EVENT) ?? []).length, 0, '迟到作答订阅已撤销');
  assert.equal((f.listeners.get('agent/status') ?? []).length, 0, '子代理状态订阅已撤销');
  // 前提自证：本用例的 ctx.on 包装确实挡下了 agent/status——防"探针没装上恒绿"。
  let blocked = false;
  try { realOn('agent/status', () => {}); } catch { blocked = true; }
  assert.equal(blocked, false, '探针还原后 ctx.on 可用（包装只在被测调用期间生效）');
});

hostTest('R29-a（判据 1·竞速期）：取消收敛交回取消口径，且不得 unhandledRejection', async () => {  const f = fakeCtx();
  installChildren(f, { children: [runningChild()] });
  const controller = new AbortController();
  const tool = createWaitAgentTool(f.ctx, config);
  const probe = unhandledProbe();

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 60000 }, { agent, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 3)); // 屏障已过，竞速已组装
  controller.abort(new Error('tool cancelled')); // aborted 拒绝归一为标签收敛（设计 §2.5）
  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.match(result.note, /The wait was cancelled/);
  assert.match(result.note, /cancellation did not stop subagent child-42/);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(probe.take().length, 0, '取消拒绝在创建点即被归一链消费，不得外泄');
  probe.off();
});

hostTest('R29-b（判据 2·入口中止）：调用进来时 signal 已 aborted → 直接 interrupted，不订阅不查询不武装', async () => {
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
  assert.match(result.note, /The call was cancelled before the wait began/, '取消口径（设计 §2.5）：不与消息到达口径混用');
  assert.match(result.note, /async_wait_agent\(agent_id="child-42", wait_ms=\.\.\.\)/, '可复制的恢复调用');
  assert.equal(calls.length, 0, 'listChildren 一次都不能被调用（不订阅、不查询、不武装）');
});

hostTest('R29-c（判据 6·正文回退是弱证据）：命中后复查仍在运行 → running，不得误报 settled', async () => {
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

hostTest('R29-c（判据 6·正文回退 + 复查确认）：命中且复查已不在列表 → settled，注明走的是正文回退', async () => {
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

hostTest('R29-d（判据 9a·等待段半边）：子代理在场时全程 ≈ 有效 waitMs，不得超总时长上界', async () => {
  // 本用例锁**等待段**半边：子代理在场 → 屏障首查即中（barrierSleep 零调用，
  // 屏障段恒为零）→ 全程 = 等待段。屏障段的可达红判据在 9b
  // （在场路径屏障根本不睡，屏障加重只在重试路径可红）。
  // 夹紧口径：请求 60ms 低于 minWaitMs 默认 250 → 有效预算是 250（resolveWait
  // 夹紧，9c 同口径）——断言按有效值计，不写 60（写请求值会把夹紧路径的
  // 预算漂移吞掉：夹紧被拆掉时 waited_ms 只等 60ms 也照样过 `>= 50`）。
  const poll = 20;
  const waitMs = 60;
  const effectiveWaitMs = 250;
  const f = fakeCtx();
  const quick = resolveConfig({ toolName: 'async_run', pollIntervalMs: poll });
  installChildren(f, { children: [runningChild()] });
  const tool = createWaitAgentTool(f.ctx, quick);

  const startedAt = Date.now();
  const result = await tool.execute({ agent_id: CHILD, wait_ms: waitMs }, exec);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.status, 'running');
  assert.ok(result.waited_ms >= effectiveWaitMs - 10, `等待段要用满**有效**预算 250ms（实得 ${String(result.waited_ms)} ms）`);
  // 总时长上界＝有效 wait_ms＋300ms 容差（设计 §2.1：不追加轮询间隔或重试
  // 时长——屏障睡与轮询拍都计入总预算，预算口径是平上界）。
  const bound = effectiveWaitMs + 300;
  assert.ok(elapsed <= bound,
    `总时长 ${String(elapsed)} ms 不得超过有效 250ms + 300ms = ${String(bound)} ms`);
});

hostTest('R29-d（判据 9b·屏障段半边）：重试睡眠计入总预算的平上界——等待侧加重必红', async () => {
  // 目录投影刷新窗口的最小模拟：子代理行第一个 poll 之后才出现 → 屏障
  // 恰好睡一次重试一次。总截止在参数解析后即武装（设计 §2.1 单一总截止，
  // 起点 t0）——屏障睡与等待段共享同一份预算：全程 ≈ 有效 waitMs（请求 60ms
  // 被夹紧到 minWaitMs 默认 250），不是「屏障段＋等待段」两段相加。
  // 红锚归因（受控变异实证）：本用例锁「屏障睡计入总时长」的平上界——
  // 拉伸屏障睡（+2000ms）由 not_found 重试族与早到消息族用例抓住（睡与
  // 四类信号竞速）；睡眠竞速成员在 not_found 族用例（R29-a 判据 1·屏障
  // 睡眠）以「睡眠中的取消/插话及时交回」形态被直接钉住；「两段相加」
  // 形态的假时钟红锚在同族假时钟用例。注：睡眠竞速数组里的总截止成员在
  // min(pollIntervalMs, 剩余) 封顶下不单独产生可观测反例（睡眠本身不越剩余
  // 预算），属结构性冗余防线。
  const poll = 20;
  const waitMs = 60;
  const effectiveWaitMs = 250;
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
  // 总时长上界＝有效 wait_ms＋300ms（平上界：屏障睡占的是同一份预算，不叠加；
  // 假时钟口径下改轮询间隔或重试次数不得延长总预算——此处用真时钟锁同一判据）。
  const bound = effectiveWaitMs + 300;
  assert.ok(elapsed <= bound,
    `总时长 ${String(elapsed)} ms 不得超过有效 250ms + 300ms = ${String(bound)} ms——等待侧加重（含睡眠不计入总预算的形态）时此处必红`);
});

hostTest('R29-d（判据 9c·夹紧口径）：wait_ms 低于 minWaitMs 时上界按有效值计（60 → 250 → 550）', async () => {
  // 夹紧感知上界（设计 §2.1 时间判据）：请求 60ms 被夹紧到 minWaitMs=250，
  // 总时长上界是**有效** wait_ms＋300ms（550ms），不是请求值＋300ms——
  // 上界写请求值会让夹紧路径的预算漂移被吞掉。
  const f = fakeCtx();
  installChildren(f, { children: [runningChild()] });
  f.ctx.agents = { get: () => ({ status: 'running' }) };
  const tool = createWaitAgentTool(f.ctx, resolveConfig({ toolName: 'async_run', minWaitMs: 250 }));

  const startedAt = Date.now();
  const result = await tool.execute({ agent_id: CHILD, wait_ms: 60 }, exec);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.status, 'running');
  assert.ok(result.waited_ms >= 240, `有效预算是夹紧后的 250ms（实得 ${String(result.waited_ms)} ms）`);
  assert.ok(elapsed <= 550, `总时长 ${String(elapsed)} ms 不得超过有效 250ms + 300ms = 550ms`);
});

// ── 起始检查（设计 §2.2 消息集合和入口扫描的工具级落点） ──

/** 挂起护栏：起始检查被拆掉（纯事件驱动回潮）时用例必须红得快，不是挂死套件。 */
const HANG_MARKER = { status: '__test-hang__' };
function withHangGuard(pending, thresholdMs = 250) {
  return Promise.race([
    pending,
    new Promise((resolve) => { setTimeout(() => resolve(HANG_MARKER), thresholdMs); })
  ]);
}

hostTest('R55（判据 1）：等待开始时 next-step 已有 user 插话 → 立即 interrupted，不订阅不进屏障', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const { state, calls } = installChildren(f, { children: [runningChild()] });
  // 先到插话：等待开始前已落 next-step（事件早已发过，纯事件驱动实现收不到）。
  agent.inbox.nextStep.push({ id: 'steer-1', source: { kind: 'user' } });
  const tool = createWaitAgentTool(f.ctx, config);

  const result = await withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec));
  assert.notEqual(result.status, '__test-hang__', '起始检查必须立即返回——纯事件驱动回潮（挂到预算耗尽）本身就是红');
  assert.equal(result.status, 'interrupted');
  // 总截止定时器在参数解析处武装（含本次），waited_ms 是墙钟噪声而非
  // 预算消耗——不变量是"立即返回"（毫秒级）。
  assert.ok(result.waited_ms < 25, `起始命中必须立即返回（实得 ${String(result.waited_ms)} ms）`);
  assert.match(result.note, /Wait not started: a user message had already arrived/, 'note 按起始命中措辞（到达时点在等待开始前）');
  assert.match(result.note, /Ending the wait did not stop subagent child-42/);
  assert.match(result.note, /async_wait_agent/);

  // 停点断言：不订阅、不进存在屏障。
  assert.equal(f.count('agent/inbox/inserted'), 0, '起始命中路径不得挂任何 inbox 监听器');
  assert.equal(calls.length, 0, '起始命中路径不得进存在屏障（listChildren 零调用）');
  assert.deepEqual(state.interrupted, [], '打断等待 ≠ 打断子代理');
  agent.inbox.nextStep.length = 0; // 还原共享 fixture
});

hostTest('R55（判据 2·负面对照一）：next-step 滞留的是转达/迟到作答 → 不打断，迟到作答照旧唤醒', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  agent.inbox.nextStep.push(
    { id: 'relay-1', source: { kind: 'agent-message', form: 'relay' } },
    { id: 'late-1', source: { kind: 'async-tools-late-answer', form: 'notice', summary: 'Late answer for color: red', questionId: 'color' } }
  );
  const tool = createWaitAgentTool(f.ctx, config);

  const result = await tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  assert.equal(result.status, 'running', '两类非 user 消息都不命中打断——迟到作答专门分支先于通用 notice/relay 扫描交还');
  assert.match(result.note, /A late answer has arrived/, '迟到作答照旧走其唤醒分支（R30-d 不回归）');
  agent.inbox.nextStep.length = 0; // 还原共享 fixture
});

hostTest('R55（判据 2·注册表读不到）：入口唤醒收敛时 agents.get 抛错 → 未证实文案，不宣称"尚未结束"', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  // 入口滞留转达消息（relay——非 user，走运行句柄交回）；注册表 agents.get 抛错：
  // 入口路径没有目录证据，运行状态没有可证实来源，note 不得写"尚未结束（仍在
  // 运行）"（需求 §2.2.2——无法证实时不得把状态写成确定事实）。
  f.ctx.agents = { get: () => { throw new Error('registry blew up'); } };
  agent.inbox.nextStep.push({ id: 'relay-1', source: { kind: 'agent-message', form: 'relay' } });
  const tool = createWaitAgentTool(f.ctx, config);

  const result = await withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec));
  assert.notEqual(result.status, '__test-hang__', '入口命中必须立即返回');
  assert.equal(result.status, 'running', '唤醒照常交回运行句柄——只是口径改为未证实');
  assert.match(result.note, /unverified/i, '注册表读不到必须明说状态未证实');
  assert.doesNotMatch(result.note, /not finished yet|尚未结束/, '不得宣称"尚未结束（仍在运行）"');
  agent.inbox.nextStep.length = 0; // 还原共享 fixture
});

hostTest('R55（判据 2b·入口优先级）：next-step 滞留目标结算通知 → 结束优先于一切唤醒（含迟到作答）', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  agent.inbox.nextStep.push(
    { id: 'settle-1', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: CHILD } },
    { id: 'late-1', source: { kind: 'async-tools-late-answer', form: 'notice', summary: 'Late answer for color: red', questionId: 'color' } }
  );
  const tool = createWaitAgentTool(f.ctx, config);

  const result = await withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec));
  assert.notEqual(result.status, '__test-hang__', '入口优先级判定必须立即返回');
  assert.equal(result.status, 'settled', '未领取的目标结算通知是入口权威证据（§2.2 终止证据压过唤醒）');
  assert.match(result.note, /had already arrived before the wait started/, 'via 走 noticePreexisting 措辞');
  agent.inbox.nextStep.length = 0; // 还原共享 fixture
});

hostTest('R55（判据 3·负面对照二）：next-turn 排队 user 消息、next-step 干净 → 不打断（R12 不回归）', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installChildren(f, { children: [runningChild()] });
  agent.inbox.nextTurn.push({ id: 'queued-1', source: { kind: 'user' } });
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // 等待已照常武装：发结算通知事件驱动到 settled 结局——排队消息全程不得打断。
  f.emit('agent/inbox/inserted', settledNotice());
  const result = await pending;
  assert.equal(result.status, 'settled', '排队消息不打断；等待由结算通道正常收场');
  agent.inbox.nextTurn.length = 0; // 还原共享 fixture
});

hostTest('R55（判据 5）：先到插话与未领取结算通知并存 → settled（结束优先于打断，入口侧）', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const { calls } = installChildren(f, { children: [runningChild()] });
  agent.inbox.nextStep.push(
    { id: 'steer-1', source: { kind: 'user' } },
    { id: 'settle-1', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: CHILD } }
  );
  const tool = createWaitAgentTool(f.ctx, config);

  const result = await withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec));
  assert.notEqual(result.status, '__test-hang__');
  assert.equal(result.status, 'settled', '权威结算通知可证已结束 → settled，不让插话压过结束（口径同竞速收敛复查）');
  // 总截止在参数解析处武装（含本次），入口早退的 waited_ms 是墙钟噪声——
  // 不变量是"立即返回"（毫秒级），不是严格 0。
  assert.ok(result.waited_ms < 25, `入口早退必须立即返回（实得 ${String(result.waited_ms)} ms）`);
  assert.match(result.note, /had already arrived before the wait started/, 'note 标明通知先于等待到达（via.noticePreexisting）');
  assert.match(result.note, /separate message/, 'settledNote 既有文案保留（最终回答不在本返回值）');
  assert.equal(calls.length, 0, '并存决定也走入口早退——不进存在屏障');
  agent.inbox.nextStep.length = 0; // 还原共享 fixture
});

hostTest('R55（判据 5b·注册表侧并存）：先到 user 插话 + 注册表现读 idle → 定性证关系后 settled 并存插话说明', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const { calls } = installChildren(f, { children: [runningChild()] });
  // 先到 user 插话 + 注册表读 idle：idle 只是停止候选——必须先经目录定性证明
  // 合法子代理关系（设计 §3.4 无关目标不得套停止态），目录行在且复核仍 idle
  // 才按停止态交回；插话以并存说明表达，不吞也不翻案成 interrupted。
  f.ctx.agents = { get: (id) => (id === CHILD ? { status: 'idle' } : undefined) };
  agent.inbox.nextStep.push({ id: 'steer-1', source: { kind: 'user' } });
  const tool = createWaitAgentTool(f.ctx, config);

  const result = await withHangGuard(tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec));
  assert.notEqual(result.status, '__test-hang__', '定性竞速必须立即返回');
  assert.equal(result.status, 'settled', '目录行 + 复核仍 idle = 关系已证 → settled（不按插话走 interrupted）');
  assert.ok(result.waited_ms < 25, `入口定性毫秒级交回（实得 ${String(result.waited_ms)} ms）`);
  // note 三段：插话到达说明（wait.wokeByMessage，含"本次等待没有终止目标的工作"）
  // + via.idle + settledNote。
  assert.match(result.note, /A processable message arrived/, '先到的插话以并存说明在场（wokeByMessage）');
  assert.match(result.note, /This wait did not stop the target/, '并存说明是行为陈述（不断言插话终止了什么）');
  assert.match(result.note, /status turned idle/, 'via=idle（注册表现读的停止证据）');
  assert.ok(calls.length >= 1, 'idle 停止候选经过了目录定性查询（不再无证据直返）');
  agent.inbox.nextStep.length = 0; // 还原共享 fixture
});

hostTest('R55（判据 5b·屏障期 idle 信号）：存在性未证时 agent/status 转 idle → settled（信号对象不被切断标签压没）', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  // 目录恒空：屏障查不到行（存在性未定），重试睡眠中 emit idle——旧的
  // 字符串标签形态会把来源压成 'cut-settled' 再落重分类（not_found 谎报），
  // 对象保存形态必须立即按停止态交回。
  const { calls } = installChildren(f, { children: [] });
  const tool = createWaitAgentTool(f.ctx, config);

  const pending = tool.execute({ agent_id: CHILD, wait_ms: 600000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 3)); // 进入屏障重试睡眠
  f.emit('agent/status', { agent: { id: CHILD }, status: 'idle' });

  const result = await withHangGuard(pending);
  assert.notEqual(result.status, '__test-hang__', '屏障期 idle 信号必须及时结束等待');
  assert.notEqual(result.status, 'not_found', '权威 idle 已到场就不得报 not_found（存在性未证不是否定证据）');
  assert.equal(result.status, 'settled', 'via=agent-status-idle 是当次权威观察 → settled');
  assert.match(result.note, /status turned idle/, 'via.idle 文案（与事件/轮询通道同款）');
  assert.ok(calls.length >= 1, `确实进过屏障（实查 ${String(calls.length)} 次 listChildren）`);
});
