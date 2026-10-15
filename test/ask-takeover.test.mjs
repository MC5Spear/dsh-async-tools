/**
 * 提问接管单测（需求 §4 提问接管与待答交互，判据 J1–J20 + 变异）。
 *
 * ## 这条需求修的是什么
 *
 * 根 Agent 发 `ask_user_question` 时，人不在浏览器前 ⇒ 问题悬空到会话超时。需求 §4
 * 让本包两预设的提问在开关打开时浮上全局待答界面：窗口内作答原样回流、窗口耗尽
 * 放行（合成空选答案，不代答）、迟到作答以**通知形**（自声明 `source.kind` +
 * `form:'notice'` + `summary`，正文自含完整题目内容）经 `agent.followup()` 注入
 * （需求 §4.4）。总开关默认关——关时判定①恒不满足，零行为变化。
 *
 * ## 判据 → 各挡什么（J 编号与需求 §4 逐条对应）
 *
 * | 判据 | 挡的缺陷形态 |
 * |---|---|
 * | J1 开关关 → next()、注册表空 | 默认关被架空 ⇒ 未同意就劫持提问通道 |
 * | J2–J5 四条件缺一 → next()；agents 缺席仍接管 | 边界漏风 ⇒ 计划评审/标准预设也被接管 |
 * | J6 窗口内作答逐字段回流 | answers 形状漂移 ⇒ ask() 解析失败静默饿死 |
 * | J7 超时合成（en/zh） | 忘合成/代答 ⇒ 模型卡死或谎报用户选择 |
 * | J8 等待中 abort 形状 | ASK_ABORTED 被合成答案盖过 ⇒ 中止语义丢失 |
 * | J9 超时后 abort 无操作 | 监听器泄漏 ⇒ 悬空抛错或重复注入 |
 * | J10 齐答撤定时器、无双结 | 双结 ⇒ 两个 resolve 竞速，answers 互相覆盖 |
 * | J11 迟到作答 followup 恰一次、通知形、正文自含题目内容 | steer/inject 通道/重复注入/题目内容缺字段 ⇒ 插话判定误命中、死信、压缩后模型失忆 |
 * | J12 迟到忽略模板（自含题目内容） | 模板漂移 ⇒ 注入正文与词典脱钩 |
 * | J13 窗口内忽略 windowSkip | 忽略不回流 ⇒ 模型看不见「选择不答」 |
 * | J14 state() 形状与递减 | 轮询数据形状漂移 ⇒ 客户端白屏 |
 * | J15 wire 对账 + 单层包裹 | 双重包裹 ⇒ 宿主收到 `{submission:{submission}}` |
 * | J16 座位只换呈现层 | 座位枚举漏进宿主管线 ⇒ J16 违约 |
 * | J17 卸载交还 next()；已结批不再交还 | 卸载吞批次/晚调 next ⇒ 悬死或幻影原生卡 |
 * | J18 客户端模型：准入控制/轮询/裸传/失败路径 | 包裹漂移、failed 静默 ⇒ 迟到答案无声丢失 |
 * | J19 座位渲染条件 + lostAnswers 计入 | 关/空/错座不消隐，报错名单永不显示 |
 * | J20 expired 批 TTL | 无限留列 ⇒ 内存与徽标双重无界 |
 * | J21 待答界面语言三档（auto 跟宿主） | auto 死写 en ⇒ 「恒英文」死角复发 |
 * | 单选替换 chips | 回退恒 toggle ⇒ 单选题可多选 |
 * | 注册 label 活词典 | label 硬编码 ⇒ 换语言不翻 |
 *
 * 替身约定：`fakeTimer` 记录武装/撤销（J10 断言撤销）；`fakeAgent.steer/followup/inject`
 * 三通道计数（J11 断言只有 followup 被调）；signal 用真 `AbortController`（事件语义与
 * 宿主一致，J8/J9 不自造中止形状）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LATE_ANSWER_EVENT, LATE_ANSWER_SOURCE, USER_MESSAGE_SOURCE, watchLateAnswer, watchWakeSignal } from '../lib/interrupts.js';
import { resolveConfig } from '../lib/config.js';
import { seedSnapshot, clearSnapshot } from '../lib/settings.js';
import { t } from '../lib/text.js';
import { fakeCtx } from './_helpers.mjs';

/**
 * 离线安全加载：`lib/ask-takeover.js`（→ `@deepseek-ai/dsh-llm` /
 * `@deepseek-ai/dsh-typert-protocol`）与 `lib/host.js`（→ ask-takeover.js）
 * 在没有宿主包解析路径的环境下不可加载。只吞 `@deepseek-ai/` 解析失败，
 * 其余错误原样抛——语法错误、模块内部抛错不得被伪装成"离线环境"的跳过。
 * @returns {Promise<object | undefined>} 模块；宿主包不可解析时为 `undefined`。
 */
async function loadOfflineSafe(specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && message.includes('@deepseek-ai/')) return undefined;
    throw error;
  }
}

const askModule = await loadOfflineSafe('../lib/ask-takeover.js');
const hostModule = await loadOfflineSafe('../lib/host.js');
const { AskBatchRegistry, AskTakeoverService, shouldTakeover, inOwnPreset } = askModule ?? {};
const { applyHostHalf } = hostModule ?? {};

/** 宿主链不可解析（离线环境）时整组跳过；可用时与 `test` 完全同形（断言不放宽）。 */
const hostTest = (askModule === undefined || hostModule === undefined)
  ? (name, _fn) => test(name, (t) => { t.skip('宿主包不可解析（离线环境），本用例跳过'); })
  : (name, fn) => test(name, fn);

const ROOT = resolve(import.meta.dirname, '..');

// ── 替身 ───────────────────────────────────────────────────────────────────

/** 假 timer：记录每次武装与撤销（J10 的"定时器已撤"证据就是 `cancelled`）。 */
function fakeTimer() {
  const armed = [];
  return {
    timeout(fn, ms) {
      const entry = { fn, ms, cancelled: false };
      armed.push(entry);
      return () => { entry.cancelled = true; };
    },
    armed,
    /** 触发 armed 下标 index 处的定时器（默认 0；不跳过已撤销项——调用方按武装
     *  次序自己拿对下标，散见 J/K 各用例；K6 等处不经本方法、按 armed 项 .fn()
     *  直发）。 */
    fire(index = 0) {
      const entry = armed[index];
      assert.ok(entry !== undefined, '定时器必须已武装');
      entry.fn();
    }
  };
}

/** 假根 Agent：完整驱动侧——status（默认 running：接管时发问方
 * 本就在回合里）+ 收件箱两列表 + followup/inject/steer 三通道各记各的 + whenIdle
 * 空闲观察。followup 立即开跑（status → running）。finishTurn 按
 * 真机闩序重演：回合收尾**先**领取（claim）滞留件、**再**转 idle 释放 whenIdle
 * 等待者（dsh-agent-loop 870-875 do-while 的驱动边界顺序）——所以补醒观察醒来
 * 时正常路径下滞留件已被顺走；`claim:false` 才是末步竞态形态（滞留给观察发现）。 */
function fakeAgent(id = 'session-abc123def0', { status = 'running' } = {}) {
  const agent = {
    id,
    status,
    inbox: { nextTurn: [], nextStep: [] },
    steerCalls: [],
    followupCalls: [],
    injectCalls: [],
    idleWaiters: new Set()
  };
  agent.steer = (message) => { agent.steerCalls.push(message); agent.inbox.nextStep.push(message); };
  agent.followup = (message) => {
    agent.followupCalls.push(message);
    agent.inbox.nextTurn.push(message);
    if (agent.status === 'idle') agent.status = 'running';
  };
  agent.inject = (message) => { agent.injectCalls.push(message); agent.inbox.nextStep.push(message); };
  agent.whenIdle = () => {
    if (agent.status === 'idle') return Promise.resolve();
    return new Promise((resolve) => { agent.idleWaiters.add(resolve); });
  };
  /** 模拟宿主领取（claim）：整批取走 next-step，可选连取一条 next-turn。
   * `claim:false` = 末步竞态形态：回合收尾**没有**再领取一次（消息滞留）。 */
  agent.claimStep = ({ withTurn = false } = {}) => {
    const claimed = agent.inbox.nextStep.splice(0, agent.inbox.nextStep.length);
    if (withTurn && agent.inbox.nextTurn.length > 0) claimed.push(agent.inbox.nextTurn.shift());
    return claimed;
  };
  /** 回合边界：默认先领取再转 idle（正常收尾）；`claim:false` 模拟末步竞态滞留。 */
  agent.finishTurn = ({ claim = true } = {}) => {
    if (claim) agent.claimStep({ withTurn: true });
    agent.status = 'idle';
    for (const waiter of [...agent.idleWaiters]) waiter();
    agent.idleWaiters.clear();
  };
  return agent;
}

/** 微任务冲刷：补醒观察的 whenIdle 续段在微任务里跑完。 */
const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/** 三服务替身（判定②④的取数来源；preset/roots/抛错全可配）。 */
function fakeServices(agent, {
  preset = 'dsh-async', roots = null, presetThrows = false, rootThrows = false
} = {}) {
  return {
    sessions: { get: (id) => (id === agent.id ? { id } : undefined) },
    sessionProjections: { stateOf: (session, key) => {
      if (presetThrows) throw new Error('projection boom');
      return session.id === agent.id && key === 'agentPreset' ? preset : undefined;
    } },
    agents: roots === null ? undefined : { roots: () => {
      if (rootThrows) throw new Error('roots boom');
      return roots;
    } }
  };
}

/** 单题请求形状（questions + agent + signal）。 */
function makeRequest(agent, questions, extra = {}) {
  return { questions, agent, ...extra };
}
const Q = (id, extra = {}) => ({
  id,
  question: `问题文本 ${id}`,
  options: [{ label: '选项一' }, { label: '选项二' }],
  ...extra
});

/** 注册表快配：假 timer + 可变快照（默认窗口 5000 ms、en 档）；clock 可注入——
 * 固定时钟会让时延恒 0、判据无区分度。
 * `#onExpiry` 有真期限复验（需求 §4.3：未到 expiresAt 的触发只重挂不结清）——
 * 冻结在 1_000_000 的裸假钟会让到期回调永远判「未到」。默认 timer 因此带
 * **自走钟**：`fire()` 把假钟推到该次武装的到期时刻，旧 J 族（纯 fire 驱动
 * 到期）零迁移；显式注入 clock 的用例（E 族/K13 后继）不受影响。
 * emit 默认记进 `emitted` 数组（J22 事件判据）。 */
function makeRegistry({ timeoutMs = 5000, agentLang = 'en', timer, clock } = {}) {
  let snapshot = { askTakeover: true, askTimeoutMs: timeoutMs, agentLang };
  const emitted = [];
  // `#onExpiry` 有真期限复验（需求 §4.3：未到 expiresAt 的触发只重挂不结清）——冻结在
  // 1_000_000 的裸假钟会让到期回调永远判「未到」。默认（未注入 timer）时给假
  // timer 配**自走钟**：fire() 把假钟推到该次武装的到期时刻，旧 J 族（纯 fire
  // 驱动到期）零迁移。注入 timer 的用例（E8 的调度钟）自带 dueAt 语义——包装
  // 层不得覆写其 entry.dueAt（否则把到期点改到过去，advance 陷入同步重挂环）。
  let fakeNow = 1_000_000;
  const effective = timer ?? (() => {
    const base = fakeTimer();
    return {
      armed: base.armed,
      timeout(fn, ms) {
        const disposer = base.timeout(fn, ms);
        const entry = base.armed[base.armed.length - 1];
        if (entry !== undefined) entry.dueAt = fakeNow + ms;
        return disposer;
      },
      fire(index = 0) {
        const entry = base.armed[index];
        if (entry?.dueAt !== undefined) fakeNow = Math.max(fakeNow, entry.dueAt);
        return base.fire(index);
      }
    };
  })();
  const registry = new AskBatchRegistry({
    timer: effective,
    readSnapshot: () => snapshot,
    emit: (name, payload) => { emitted.push({ name, payload }); },
    now: clock ?? (() => fakeNow)
  });
  return {
    registry,
    timer: registry.timer,
    emitted,
    setSnapshot: (next) => { snapshot = next; }
  };
}

/**
 * 挂真实宿主接线（`lib/host.js` 的 ask 子 scope），取回 waterfall 监听器本体。
 * J1–J5/J16 走这里——判定的 next() 语义只有在真实监听器里才是可观察行为。
 * services 透传进注入的子 scope（J16 判定②要读到预设；J1 在条件①短路，不需要）。
 */
function mountListener({ timer, clock, config, services }) {
  const f = fakeCtx();
  // 时钟挂在 timer 服务上（host 半边从 timer.now 可选读取——不新增 ctx 面）。
  if (clock !== undefined) timer.now = clock;
  f.ctx.timer = timer;
  const injectFns = new Map();
  f.ctx.inject = (list, fn) => { injectFns.set(list.join(','), fn); };
  f.ctx.effect = () => () => {};
  // 注意：ask 配置必须走 applyHostHalf 的**第二参**——attachSnapshotSource 会用它
  // 重播种模块快照（先 seedSnapshot 会被这次覆盖成 toolName-only 的默认关档）。
  applyHostHalf(f.ctx, resolveConfig(config));
  const askInject = injectFns.get('sessions,sessionProjections,agents');
  assert.ok(typeof askInject === 'function', 'ask 三服务子 scope 必须注册');
  let captured = null;
  askInject({
    ...(services ?? {}),
    on: (event, listener, opts) => { captured = { event, listener, opts }; }
  });
  assert.ok(captured !== null, '子 scope 里必须挂 user-questions/request 监听');
  return captured;
}

// ── 判定序（J1–J5，经真实接线观察 next() 语义）────────────────────────────

hostTest('inOwnPreset（F3 范围判定底座）：三态读取路径 + 失效安全方向＝关', () => {
  // 与 shouldTakeover 判定②同一条读取路径（sessions.get → stateOf('agentPreset')），
  // 供 lib/jobs.js 的结果诊断范围判定复用——两处口径必须一致。
  const scope = (preset, session = { id: 's1' }) => ({
    sessions: { get: (id) => (id === 's1' ? session : undefined) },
    sessionProjections: { stateOf: () => preset }
  });
  assert.equal(inOwnPreset(scope('dsh-async'), 's1'), true, '本包主预设 ⇒ 归属');
  assert.equal(inOwnPreset(scope('dsh-async-create'), 's1'), true, 'create 预设同样归属');
  assert.equal(inOwnPreset(scope('standard'), 's1'), false, '其他预设 ⇒ 不归属');
  assert.equal(inOwnPreset(scope('dsh-async'), 's-other'), false, '会话查无 ⇒ 不归属');
  assert.equal(inOwnPreset({}, 's1'), false, '服务缺席 ⇒ 不归属（失效安全＝关）');
  assert.equal(
    inOwnPreset({ sessions: { get: () => { throw new Error('boom'); } }, sessionProjections: {} }, 's1'),
    false, '读取抛错 ⇒ 不归属（不把异常泄给诊断路径）'
  );
});

hostTest('J1：总开关关 → next() 被调、零接管（默认关 = 零行为的接线侧证据）', () => {
  try {
    const timer = fakeTimer();
    const { listener, opts } = mountListener({
      timer, config: { toolName: 'async_run', askTakeover: false }
    });    assert.deepEqual(opts, { prepend: true }, '监听必须 prepend 抢在原生转发器之前');
    const agent = fakeAgent();
    let nextArg = null;
    const next = () => { nextArg = 'called'; return 'native-result'; };
    const request = makeRequest(agent, [Q('q1')]);
    const result = listener(request, next);
    assert.equal(nextArg, 'called', '开关关 ⇒ 交还原生链');
    assert.equal(result, 'native-result', '返回值 = next() 的返回值（不吞不改）');
    assert.equal(timer.armed.length, 0, '定时器零武装——注册表零批次');
  } finally {
    clearSnapshot();
  }
});

hostTest('J2–J5：四条件逐一缺一 → 原生；agents 缺席仍接管（三态第三态）', () => {
  const agent = fakeAgent();
  // ② 无 agent：
  assert.equal(shouldTakeover({ questions: [Q('q1')] }, fakeServices(agent), { askTakeover: true }).takeover, false,
    '无 agent 的编程式请求 → 原生');
  // ③ plan-review intent：
  assert.equal(shouldTakeover(
    makeRequest(agent, [Q('q1', { intent: { kind: 'plan-review' } })]),
    fakeServices(agent), { askTakeover: true }
  ).takeover, false, '计划评审批次 → 原生（R30 边界）');
  // ② 非本包预设（null = 投影缺席；undefined 会被解构默认值吃掉）：
  for (const preset of ['dsh-standard', 'code-review', null]) {
    assert.equal(shouldTakeover(
      makeRequest(agent, [Q('q1')]), fakeServices(agent, { preset }), { askTakeover: true }
    ).takeover, false, `预设 ${String(preset)} → 原生`);
  }
  // ② 预设读取抛错 → 保守原生：
  assert.equal(shouldTakeover(
    makeRequest(agent, [Q('q1')]), fakeServices(agent, { presetThrows: true }), { askTakeover: true }
  ).takeover, false, '投影读取抛错 → 原生（不猜）');
  // ④ 非根：
  assert.equal(shouldTakeover(
    makeRequest(agent, [Q('q1')]), fakeServices(agent, { roots: [fakeAgent('other')] }), { askTakeover: true }
  ).takeover, false, '不在根表 → 原生');
  // ④ roots 读取抛错 → 保守原生：
  assert.equal(shouldTakeover(
    makeRequest(agent, [Q('q1')]), fakeServices(agent, { roots: [agent], rootThrows: true }), { askTakeover: true }
  ).takeover, false, '根复验抛错 → 原生');
  // ④ agents 服务缺席 → 冗余防线缺席不挡接管：
  const absentAgents = fakeServices(agent, { roots: null });
  assert.equal(absentAgents.agents, undefined, '替身侧：agents 服务缺席');
  assert.equal(shouldTakeover(makeRequest(agent, [Q('q1')]), absentAgents, { askTakeover: true }).takeover, true,
    'agents 缺席 + 其余条件全过 → 接管');
  // 全过（含根）→ 接管并带 agent：
  const verdict = shouldTakeover(
    makeRequest(agent, [Q('q1')]), fakeServices(agent, { roots: [agent] }), { askTakeover: true }
  );
  assert.equal(verdict.takeover, true, '四条件全过 → 接管');
  assert.equal(verdict.agent, agent, '接管判定携带 agent（迟注通道要用）');
  // 本包两预设字符串逐字（同串判据）：
  for (const preset of ['dsh-async', 'dsh-async-create']) {
    assert.equal(shouldTakeover(
      makeRequest(agent, [Q('q1')]), fakeServices(agent, { preset }), { askTakeover: true }
    ).takeover, true, `预设 ${preset} → 接管`);
  }
});

// ── 窗口内路径（J6/J10/J13/J14）────────────────────────────────────────────

hostTest('J6：窗口内作答 → answers 逐字段原样回流（selected/custom 逐字）', async () => {
  const agent = fakeAgent();
  const { registry } = makeRegistry();
  const pending = registry.take(makeRequest(agent, [Q('q1')]), agent, () => ({ late: true }));
  const state = registry.stateItems();
  assert.equal(state.items.length, 1, '接管即入列');
  const delivered = registry.submitAnswer({
    batchId: state.items[0].batchId, questionId: 'q1',
    selected: ['选项二'], custom: '补充说明'
  });
  assert.equal(delivered, 'delivered');
  const answers = await pending;
  assert.deepEqual(answers, {
    answers: [{ id: 'q1', selected: ['选项二'], custom: '补充说明' }]
  }, ' 形状：id/selected/custom 逐字段原样');
  assert.equal(registry.batches.size, 0, '齐答出列');
});

hostTest('J10：多题齐答提前结清 → 定时器撤销、混合形状、无双结', async () => {
  const agent = fakeAgent();
  const { registry, timer } = makeRegistry();
  const pending = registry.take(makeRequest(agent, [Q('q1'), Q('q2')]), agent);
  const { items } = registry.stateItems();
  const byQ = Object.fromEntries(items.map((item) => [item.questionId, item.batchId]));
  registry.submitAnswer({ batchId: byQ.q1, questionId: 'q1', selected: ['选项一'] });
  // J13：窗口内忽略 → windowSkip 文案进 answers（本批第二题）。
  registry.submitIgnore({ batchId: byQ.q2, questionId: 'q2' });
  assert.equal(timer.armed.length, 1, '接管武装恰一个定时器');
  assert.equal(timer.armed[0].cancelled, true, '齐答结清在同一同步段撤销定时器（防双结）');
  const answers = await pending;
  assert.deepEqual(answers, {
    answers: [
      { id: 'q1', selected: ['选项一'], custom: undefined },
      { id: 'q2', selected: [], custom: t('en', 'ask.windowSkip') }
    ]
  }, '混合真实作答 + 窗口内跳过形状（J6 + J13 同批钉住）');
  assert.equal(registry.batches.size, 0, '结清出列');
  timer.fire(0); // 已撤销的定时器被外部误触发也不得双结——resolve 幂等由 settled 护栏保证。
  assert.equal(registry.batches.size, 0, '误触发无副作用（批次已不在）');
});

hostTest('J14：state() 载荷形状 + 作答递减 + 清零出列 + expired 批留列', async () => {
  const agent = fakeAgent();
  const { registry, timer } = makeRegistry();
  registry.take(makeRequest(agent, [Q('q1', { multiSelect: true }), Q('q2')]), agent);
  let state = registry.stateItems();
  assert.equal(state.items.length, 2, '两题各一条');
  const first = state.items[0];
  assert.deepEqual(
    ['batchId', 'sessionId', 'questionId', 'question', 'options', 'multiSelect', 'receivedAt', 'expiresAt', 'phase'],
    Object.keys(first)
  , '载荷字段集合 = 批记录投影（设计 §4.1；无 paused 键）');
  assert.equal(first.sessionId, agent.id, 'sessionId = agent.id（分组与跳转键）');
  assert.equal(first.question, '问题文本 q1');
  assert.deepEqual(first.options, [{ label: '选项一' }, { label: '选项二' }]);
  assert.equal(first.multiSelect, true, 'multiSelect 透传（客户端 chips 语义要用）');
  assert.equal(state.items[1].multiSelect, false, '缺省 multiSelect 归一为 false');
  assert.equal(first.receivedAt, 1_000_000, 'receivedAt = 接管时刻（假钟锚定）');
  assert.equal(first.expiresAt, 1_005_000, 'expiresAt = receivedAt + 窗口（5000 ms 配置）');
  assert.equal(first.phase, 'open');
  assert.equal(typeof state.serverNow, 'number', 'serverNow 在场（客户端时差校准）');

  registry.submitAnswer({ batchId: first.batchId, questionId: 'q1', selected: ['选项一'] });
  state = registry.stateItems();
  assert.equal(state.items.length, 1, '作答即递减（open 题才上屏）');
  assert.equal(state.items[0].questionId, 'q2');

  timer.fire(0); // 超时放行（q2 open ⇒ expired 留列）
  await Promise.resolve();
  state = registry.stateItems();
  assert.equal(state.items.length, 1, 'expired 批的 open 题仍上屏（迟到作答入口）');
  assert.equal(state.items[0].phase, 'expired', 'phase 转 expired');
});

hostTest('F4：到期后回调未及的提交必须复查真期限——按 gone 走迟到路径，不翻案', async () => {
  // 竞态窗口：真钟已越过 expiresAt、到期回调尚未 fire（timer 排队/宿主繁忙）。
  // 提交入口若只看批 phase（还是 open），会把过期提交当 delivered、用迟到答案
  // 翻案一个已该超时放行的批——提交前必须复查 now >= expiresAt（需求 §4.3）。
  const agent = fakeAgent('s-f4');
  let clockNow = 1_000_000;
  const { registry } = makeRegistry({ clock: () => clockNow });
  const pending = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const { items } = registry.stateItems();
  const batchId = items[0].batchId;
  assert.equal(items[0].expiresAt, 1_005_000, '前置：到期点 = 1_000_000 + 5000 窗口');

  clockNow = 1_005_001; // 真钟越过窗口；到期回调全程不 fire（竞态窗口敞开）
  assert.equal(
    registry.submitAnswer({ batchId, questionId: 'q1', selected: ['选项一'] }),
    'gone',
    '过期批的提交按 gone 退回——不得冒充 delivered 用迟到答案翻案'
  );
  assert.equal(
    registry.submitIgnore({ batchId, questionId: 'q1' }),
    'gone',
    '忽略入口同样复查真期限（两条提交路径一个口径）'
  );

  const settled = await pending;
  assert.ok(Array.isArray(settled.answers), '批经 expire 结清（幂等——两次提交只结一次）');
  assert.deepEqual(
    settled.answers.map((a) => [a.id, a.selected]),
    [['q1', []]],
    '超时合成不代答（selected 空），不是被迟到提交改写'
  );
  const state = registry.stateItems();
  assert.equal(state.items[0].phase, 'expired', '批相转 expired——迟到作答入口仍可见');
});

// ── 超时与中止（J7/J8/J9）──────────────────────────────────────────────────

hostTest('J7：超时 → 合成 answers 逐字段（en/zh 两档；不代答）', async () => {
  for (const agentLang of ['en', 'zh']) {
    const agent = fakeAgent();
    const { registry, timer } = makeRegistry({ agentLang });
    const pending = registry.take(makeRequest(agent, [Q('q1'), Q('q2')]), agent);
    const { items } = registry.stateItems();
    // 窗口内答掉 q1：超时合成必须保留用户形状、只对 open 题合成。
    registry.submitAnswer({ batchId: items[0].batchId, questionId: 'q1', selected: ['选项二'] });
    timer.fire(0);
    const settled = await pending;
    const byId = Object.fromEntries(settled.answers.map((a) => [a.id, a]));
    assert.deepEqual(byId.q1, { id: 'q1', selected: ['选项二'], custom: undefined },
      `${agentLang}：已答题保留用户形状`);
    assert.deepEqual(byId.q2.selected, [], `${agentLang}：open 题 selected 必为空数组（不代答）`);
    assert.equal(byId.q2.id, 'q2', 'id 一一对应');
    assert.equal(byId.q2.custom, t(agentLang, 'ask.timeoutCustom', { seconds: 5 }),
      `${agentLang}：custom = 超时语义句（窗口 5000 ms → seconds=5，词典逐字）`);
  }
});

hostTest('J8：等待中 abort → ASK_ABORTED 形状拒绝，合成答案不出现', async () => {
  const agent = fakeAgent();
  const { registry, timer } = makeRegistry();
  const controller = new AbortController();
  const pending = registry.take(makeRequest(agent, [Q('q1')], { signal: controller.signal }), agent);
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'UserQuestionError');
    assert.equal(error.code, 'ASK_ABORTED');
    assert.equal(error.message, 'ask_user_question was aborted before the user answered');
    return true;
  }, '拒绝形状 = ASK_ABORTED 还原锚（restoreUserQuestionError 逐字消费）');
  assert.equal(timer.armed[0].cancelled, true, '中止路径撤销定时器');
  assert.equal(registry.batches.size, 0, '中止出列');
  // 入口即中止（接管时 signal 已 aborted）同形状：
  const controller2 = new AbortController();
  controller2.abort();
  const pending2 = registry.take(makeRequest(fakeAgent('s2'), [Q('q1')], { signal: controller2.signal }), agent);
  await assert.rejects(pending2, (error) => error.code === 'ASK_ABORTED', '入口中止同形状');
});

hostTest('J9：超时后 abort → 无操作（监听器已摘的证据）', async () => {
  const agent = fakeAgent();
  const { registry, timer } = makeRegistry();
  const controller = new AbortController();
  const pending = registry.take(makeRequest(agent, [Q('q1')], { signal: controller.signal }), agent);
  timer.fire(0);
  const settled = await pending;
  assert.equal(settled.answers.length, 1, '超时已放行');
  // 超时后 abort：finishAbort 若仍挂着会把已 resolve 的批次再 reject（不可达路径）——
  // 可观察结果是「不抛、不注入、批次仍留列供迟到作答」。
  controller.abort();
  assert.equal(registry.batches.size, 1, 'expired 批仍留列（迟到作答入口未被中止冲掉）');
  assert.equal(agent.steerCalls.length, 0, '零注入');
});

// ── 迟到作答（J11/J12：按状态选通道，用户裁定）──────────────────

hostTest('J11-a：运行中投递 → inject 恰一次、通知形（自声明 kind + form/summary/questionId）、正文自含题目内容', async () => {
  const agent = fakeAgent(); // 默认 running（接管时发问方在回合里；超时放行后仍在收尾）
  const { registry, timer, emitted } = makeRegistry({ agentLang: 'zh' });
  const pending = registry.take(makeRequest(agent, [Q('q1', { multiSelect: true })]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  const settled = await pending;
  assert.equal(settled.answers[0].selected.length, 0, '超时已放行（合成空选）');

  const outcome = registry.submitLate({
    batchId: items[0].batchId, questionId: 'q1', kind: 'answer',
    selected: ['选项一', '选项二'], custom: '注意顺序'
  });
  assert.equal(outcome, 'late');
  // 方法名断言（可失败判据，通道选择）：运行中 → inject——折入下一领取点，
  // 同窗口多条由宿主整批领取；followup 会在运行中开新回合（串行多回合，
  // 实测病灶），steer 会伪装用户插话（插话判定命中）。
  assert.equal(agent.injectCalls.length, 1, '运行中 → inject 恰一次');
  assert.equal(agent.followupCalls.length, 0, '运行中 → followup 零调用（不串行开新回合）');
  assert.equal(agent.steerCalls.length, 0, 'steer 零调用（通知形不走插话通道）');
  assert.ok(agent.inbox.nextStep.includes(agent.injectCalls[0]), '落点 next-step（下一领取点整批领取）');
  const message = agent.injectCalls[0];
  // kind 断言 + 互斥：自声明串，≠ 'user'——改回 'user' 时这条与 wait 侧互斥联测都红。
  assert.equal(message.source.kind, LATE_ANSWER_SOURCE,
    'source.kind = 本包自声明串（与 interrupts.js 同源导入）');
  assert.notEqual(message.source.kind, USER_MESSAGE_SOURCE, '与用户插话判定字面互斥（R12 不命中）');
  assert.equal(message.source.form, 'notice', 'form=notice（通知形）');
  assert.equal(message.source.questionId, 'q1', 'questionId 进 source（待读登记配对与唤醒题号）');
  const expectedSummary = t('zh', 'ask.lateSummary', { qid: 'q1', answer: '选项一、选项二' });
  assert.equal(message.source.summary, expectedSummary, 'summary = 一句话作答摘要（词典模板，含题号）');
  assert.equal(message.content[0].type, 'text');
  // 正文自含完整题目内容（用户裁定）：稳定 id / 题干全文 / 选项标签全集 /
  // multiSelect / 作答（标签 + custom）/ 时延——逐字段断言，删任一字段必红。
  const expectedAnswer = '选项一、选项二' + t('zh', 'ask.lateCustomSuffix', { custom: '注意顺序' });
  const expectedText = t('zh', 'ask.lateAnswer', {
    qid: 'q1',
    question: '问题文本 q1',
    options: '选项一、选项二',
    multiSelect: 'true',
    answer: expectedAnswer,
    // 自走钟：fire(0) 把假钟推到到期时刻（receivedAt+5000）——时延即窗口长度。
    delay: 5
  });
  assert.equal(message.content[0].text, expectedText, '正文 = 词典模板逐字（自含题目内容全字段）');
  const text = message.content[0].text;
  assert.match(text, /\[迟到应答\]/, '锚句在场');
  for (const field of ['q1', '问题文本 q1', '选项一', '选项二', 'multiSelect=true', '注意顺序']) {
    assert.ok(text.includes(field), `自含字段在场：${field}`);
  }
  assert.match(text, /时延/, '时延字段在场（提问时间或时延——需求 §4.4 的时间信息）');
  // 唤醒事件已发（需求 §4.4 到达即刻，先于投递；载荷细节 J22 专项）。
  assert.equal(emitted.length, 1, '事件恰一次');
  // 同一题二次提交 → gone，不重复注入：
  assert.equal(
    registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: ['选项一'] }),
    'gone'
  );
  assert.equal(agent.injectCalls.length, 1, '同一题二次提交 → gone，不重复注入');

  // en 批的分隔符：
  const agent2 = fakeAgent('s-en');
  const { registry: registry2, timer: timer2 } = makeRegistry({ agentLang: 'en' });
  const pending2 = registry2.take(makeRequest(agent2, [Q('q9')]), agent2);
  const items2 = registry2.stateItems().items;
  timer2.fire(0);
  await pending2;
  registry2.submitLate({ batchId: items2[0].batchId, questionId: 'q9', kind: 'answer', selected: ['a', 'b'] });
  assert.match(agent2.injectCalls[0].content[0].text, /a, b/, 'en 标签以逗号空格相接');
});

hostTest('J11-b：空闲且无未领取的本包投递 → followup 恰一次（唤醒开回合，单条也立即）', async () => {
  const agent = fakeAgent('s-idle', { status: 'idle' });
  const { registry, timer } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;

  const outcome = registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: ['x'] });
  assert.equal(outcome, 'late');
  assert.equal(agent.followupCalls.length, 1, '空闲 → followup 恰一次（立即唤醒）');
  assert.equal(agent.injectCalls.length, 0, '空闲零 inject（不滞留到别人开回合）');
  assert.ok(agent.inbox.nextTurn.includes(agent.followupCalls[0]), '落点 next-turn（自开回合领取）');
  assert.equal(agent.status, 'running', 'followup 已开跑（假 agent 镜像 wakeDriver 同步分支）');
  // 同批第二题此时已"运行中"→ 并入该回合下一领取点（inject）：
  assert.equal(
    registry.submitLate({ batchId: items[0].batchId, questionId: 'q2', kind: 'answer', selected: ['y'] }),
    'gone', '（单题批出列即删——gone）'
  );
});

hostTest('J11-c：同窗口多条（运行中）→ 全部 inject 同落 next-step，一个领取点整批领走', async () => {
  const agent = fakeAgent('s-batch'); // running
  const { registry, timer } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1'), Q('q2'), Q('q3')]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;
  for (const qid of ['q3', 'q1', 'q2']) { // 乱序到达
    assert.equal(registry.submitLate({ batchId: items[0].batchId, questionId: qid, kind: 'answer', selected: ['x'] }), 'late');
  }
  assert.equal(agent.injectCalls.length, 3, '三条全 inject');
  assert.equal(agent.followupCalls.length, 0, '零 followup（不串行开三个回合）');
  assert.equal(agent.inbox.nextStep.length, 3, '三条同落 next-step 列表');
  const claimed = agent.claimStep({ withTurn: false }); // 一个领取点：整批
  assert.equal(claimed.length, 3, '单个领取点整批领取三条（插件不建队列——批次是宿主语义）');
});

hostTest('J11-d：空闲但自家 followup 尚未开跑（收件箱有未领取的本包通知）→ 后到者改走 inject，由闩住回合顺走、不补醒', async () => {
  const agent = fakeAgent('s-latch', { status: 'idle' });
  // 构造空窗口：一条本包通知已 followup（落 next-turn）但回合尚未开跑（wake 被
  // maintenance 闩住——宿主 856 行语义；假 agent 直接按未开跑形态摆）。
  agent.inbox.nextTurn.push({ source: { kind: LATE_ANSWER_SOURCE, form: 'notice', summary: 's-older', questionId: 'q0' } });
  const { registry, timer } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;
  assert.equal(registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: ['x'] }), 'late');
  assert.equal(agent.injectCalls.length, 1, '空窗口后到者 → inject（由闩住的那个回合首次领取顺走）');
  assert.equal(agent.followupCalls.length, 0, '不再叠加 followup（不设去抖定时，设计 §4.4）');
  // 真机语义：闩住的回合结束时**先**整批领取滞留件、再结算
  // whenIdle 的等待者——所以本观察醒来时滞留件已被顺走，**不会**补醒提醒。
  // 假 agent 没有这层"领取先于结算"的闩，用 finishTurn 显式重演：领取滞留件
  // → 转空闲（释放 whenIdle）→ flush 观察续跑。
  agent.finishTurn({ claim: true });
  await flush();
  assert.equal(agent.followupCalls.length, 0,
    '闩住回合顺走滞留件后转空闲：补醒观察对账为空，不补提醒（真机 870-875 do-while 语义）');
});

hostTest('J12：迟到忽略 → 通知形正文 = ask.lateIgnore 模板；两通道同步抛错 → failed 仍出列', async () => {
  const agent = fakeAgent();
  const { registry, timer } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1'), Q('q2')]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;
  const outcome = registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'ignore' });
  assert.equal(outcome, 'late');
  const message = agent.injectCalls[0];
  assert.equal(message.source.form, 'notice', '忽略路径同是通知形');
  assert.equal(message.source.summary, t('en', 'ask.lateIgnoreSummary', { qid: 'q1' }),
    '忽略路径 summary 在册（一句话跳过摘要）');
  assert.equal(message.content[0].text, t('en', 'ask.lateIgnore', {
    qid: 'q1', question: '问题文本 q1', options: '选项一, 选项二', multiSelect: 'false', delay: 5
  }), '迟到忽略正文 = 词典模板逐字（自含题目内容：id/题干/选项/multiSelect/时延——自走钟下时延=窗口 5 s）');

  // inject 抛错（运行中通道，agent 引用失效的最坏形态）：审计 + 仍出列 + failed。
  const broken = fakeAgent('s-broken');
  broken.inject = () => { throw new Error('agent gone'); };
  const pending2 = registry.take(makeRequest(broken, [Q('q3')]), broken);
  // 批 1 的 q2 仍 open——stateItems 混着两批的题，必须按 questionId 寻址。
  const q3Item = registry.stateItems().items.find((item) => item.questionId === 'q3');
  timer.fire(1);
  await pending2;
  assert.equal(
    registry.submitLate({ batchId: q3Item.batchId, questionId: 'q3', kind: 'answer', selected: ['x'] }),
    'failed', 'inject 失败返回 failed（调用方可上屏重试语义——本批无重试通道，设计 §4.4）'
  );

  // followup 抛错（空闲通道）同样 failed：
  const broken2 = fakeAgent('s-broken2', { status: 'idle' });
  broken2.followup = () => { throw new Error('agent gone idle'); };
  const pending3 = registry.take(makeRequest(broken2, [Q('q4')]), broken2);
  const q4Item = registry.stateItems().items.find((item) => item.questionId === 'q4');
  timer.fire(2);
  await pending3;
  assert.equal(
    registry.submitLate({ batchId: q4Item.batchId, questionId: 'q4', kind: 'answer', selected: ['x'] }),
    'failed', 'followup 失败返回 failed（设计 §4.4：任一通道同步抛错）'
  );
});

hostTest('注入时刻活读 agentLang + 时延非零（假钟前进 37 s）', async () => {
  const agent = fakeAgent('s-live-lang');
  let now = 1_000_000;
  // 接管时 en 档；注入前活快照翻 zh + 时钟前进 37 s。
  const { registry, timer, setSnapshot } = makeRegistry({ agentLang: 'en', clock: () => now });
  const pending = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const { items } = registry.stateItems();
  // #onExpiry 有真期限复验（需求 §4.3）：假钟必须走到到期点再触发（真机上定时器
  // 延迟就是走表；测试里由时钟显式步进）。
  now += 5000;
  timer.fire(0);
  await pending;
  now += 37_000;
  setSnapshot({ askTakeover: true, askTimeoutMs: 5000, agentLang: 'zh' });

  const outcome = registry.submitLate({
    batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: ['选项一', '选项二']
  });
  assert.equal(outcome, 'late');
  const message = agent.injectCalls[0];
  assert.match(message.content[0].text, /\[迟到应答\]/, '注入语言跟随注入时刻活读（en 批 → zh 注入）');
  assert.match(message.content[0].text, /选项一、选项二/, 'zh 档分隔符（顿号）');
  assert.match(message.content[0].text, /时延：提问后 42 秒/, '时延 = 注入时刻 − receivedAt（窗口 5 s + 迟到 37 s）');
  assert.match(message.source.summary, /问题 q1 的迟到作答/, 'summary 同档（活读语言）');

  //  活读**回退分支**——readSnapshot 抛错（配置读取故障）时以批次档
  // 注入、不丢消息（outcome 仍 late）。
  const agentFb = fakeAgent('s-lang-fallback');
  let snapshotBroken = false;
  let fbNow = 1_000_000;
  const registryFb = new AskBatchRegistry({
    timer: fakeTimer(),
    readSnapshot: () => {
      if (snapshotBroken) throw new Error('settings unavailable');
      return { askTakeover: true, askTimeoutMs: 5000, agentLang: 'zh' };
    },
    now: () => fbNow
  });
  const pendingFb = registryFb.take(makeRequest(agentFb, [Q('q7')]), agentFb);
  const fbItem = registryFb.stateItems().items[0];
  fbNow += 5000; // 拨表到到期点（真期限复验 §4.2）
  registryFb.timer.fire(0);
  await pendingFb;
  snapshotBroken = true;
  assert.equal(
    registryFb.submitLate({ batchId: fbItem.batchId, questionId: 'q7', kind: 'answer', selected: ['选项一'] }),
    'late', '活读抛错不丢注入（outcome=late）'
  );
  assert.match(agentFb.injectCalls[0].content[0].text, /\[迟到应答\]/,
    '回退批次档（zh）注入——配置侧故障不改变注入语言');
});

// ── 服务接口与 wire 对账（J15）───────────────────────────────────────────────

hostTest('J15：wire 核对——参数名/描述符/单层包裹三项', async () => {
  // ① 服务方法参数名 = submission（Function.prototype.toString 防重构漂移）。
  assert.match(AskTakeoverService.prototype.state.toString(), /\bstate\(\)\s*{/, 'state 零参');
  assert.match(AskTakeoverService.prototype.answer.toString(), /\banswer\(submission\)\s*{/, 'answer(submission)');
  assert.match(AskTakeoverService.prototype.ignore.toString(), /\bignore\(submission\)\s*{/, 'ignore(submission)');
  assert.match(AskTakeoverService.prototype.extend.toString(), /\bextend\(submission\)\s*{/, 'extend(submission)');

  // ② 客户端 ASK_REMOTE 描述符：wire 名与方法集逐字镜像。
  let loaded;
  const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
  new Function('window', source)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react'
    ? { createElement: () => null, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useReducer: () => [new Set(), () => {}], useSyncExternalStore: () => null }
    : {}));
  assert.equal(product.ASK_NAMESPACE, 'async-tools-ask', '命名空间三同串之一');
  const methods = Object.fromEntries(product.ASK_REMOTE.descriptors.map((descriptor) => [descriptor.method, descriptor]));
  assert.deepEqual(Object.keys(methods).sort(), ['answer', 'extend', 'ignore', 'state'], '四方法描述符齐（state/answer/ignore/extend）');
  for (const [method, descriptor] of Object.entries(methods)) {
    assert.equal(descriptor.namespace, 'async-tools-ask', `${method} 命名空间同串`);
    assert.equal(descriptor.service, 'asyncToolsAsk', `${method} 服务键同串`);
    assert.equal(descriptor.invocation.kind, 'direct', `${method} 直调`);
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.name, 'submission', `${method} 参数名 = 服务方法形参名`);
      assert.equal(parameter.wire, 'submission', `${method} wire 名 = 参数名（裸传通道）`);
    }
  }
  assert.deepEqual(methods.state.parameters, [], 'state 零参');
  // ②-b：typert-registry 的 validateCodec 要求 strict codec 的
  // create 是**函数工厂**——对象形或缺席，$mount 当场炸
  // "strict codec has no create() factory"，整个待答界面消失。
  for (const [method, descriptor] of Object.entries(methods)) {
    const codecs = [...descriptor.parameters.map((p) => p.codec), descriptor.result];
    for (const codec of codecs) {
      assert.equal(codec.mode, 'strict', `${method} codec strict`);
      assert.ok(typeof codec.typeSymbol === 'string' && codec.typeSymbol.length > 0,
        `${method} typeSymbol 非空`);
      assert.equal(typeof codec.create, 'function',
        `${method} create 必须是函数工厂（真机实测：对象形/缺席会炸 $mount）`);
    }
  }

  // ③ 假 RPC 单层包裹：prepareInvocation 按 wire 把位置参数组装成 {submission: 载荷}——
  //    宿主收到的就是载荷本身。
  const payload = { batchId: 'ask-1-abc', questionId: 'q1', selected: ['选项一'], custom: '注' };
  const positional = [payload];
  const invocation = Object.fromEntries(
    methods.answer.parameters.map((parameter, index) => [parameter.wire, positional[index]])
  );
  assert.deepEqual(invocation, { submission: payload }, '单层包裹：宿主收到 submission=载荷，不是 {submission:{submission}}');

  // ④ 服务接口行为：answer 窗口内 delivered / gone→迟到；ignore 同理（载荷经服务方法进注册表）。
  const fakeReflectCtx = { reflect: { provide() {} } };
  const agent = fakeAgent();
  const { registry, timer } = makeRegistry();
  const service = new AskTakeoverService(fakeReflectCtx, registry);
  // 双构造幂等（伪 context 标记路径走官方 mark()：同名同形幂等早退）。
  new AskTakeoverService(fakeReflectCtx, registry);
  const pending = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const { items } = registry.stateItems();
  const result = await service.answer({ batchId: items[0].batchId, questionId: 'q1', selected: ['选项一'] });
  assert.deepEqual(result, { outcome: 'delivered' }, '窗口内作答回执');
  const answers = await pending;
  assert.deepEqual(answers.answers[0].selected, ['选项一'], '服务接口进本批记录');
  const lateResult = await service.answer({ batchId: items[0].batchId, questionId: 'q1', selected: ['x'] });
  assert.deepEqual(lateResult, { outcome: 'gone' }, '批次已结 → gone（无迟到通道可走）');
  // 迟到通道经 ignore 走一遍：
  const pending2 = registry.take(makeRequest(agent, [Q('q5')]), agent);
  const items2 = registry.stateItems().items;
  timer.fire(1);
  await pending2;
  const lateIgnore = await service.ignore({ batchId: items2[0].batchId, questionId: 'q5' });
  assert.deepEqual(lateIgnore, { outcome: 'late' }, '超时后 ignore → 迟到注入（通知形，通道按状态）');
  assert.equal(agent.injectCalls.length, 1, '迟到忽略恰一次 inject（运行中默认档）');
  const state = await service.state();
  assert.equal(state.items.length, 0, '清零出列（迟到注入后批次删尽）');
});

// ── 座位与快照活性（J16 + 变异：开关活读）─────────────────────────────────

hostTest('J16：座位枚举只换呈现层——真实接线两座位取值下接管路径逐字一致', async () => {
  for (const askUiSeat of ['overlay', 'sidebar']) {
    try {
      const timer = fakeTimer();
      let now = 1_000_000;
      const agent = fakeAgent();
      // 座位进快照（变异「座位枚举漏进宿主管线」——例如实现写成
      // `if (snap.askUiSeat !== 'overlay') return next()` ——在此必红）。
      const { listener } = mountListener({
        timer, clock: () => now,
        config: { toolName: 'async_run', askTakeover: true, askUiSeat, askTimeoutMs: 30000 },
        services: fakeServices(agent, { roots: null })
      });
      let nextCalls = 0;
      const result = listener(makeRequest(agent, [Q('q1')]), () => { nextCalls += 1; return 'n'; });
      assert.equal(nextCalls, 0, `askUiSeat=${askUiSeat}：座位不影响接管判定`);
      assert.ok(result instanceof Promise, `askUiSeat=${askUiSeat}：接管照常发生`);
      // 用注入的假 timer 触发超时结清（接管路径的宿主半边走完整链）。
      // #onExpiry 真期限复验（需求 §4.3）：先拨表到到期点再触发。
      now += 30000;
      timer.fire(0);
      const settled = await result;
      assert.deepEqual(settled.answers[0].selected, [], `askUiSeat=${askUiSeat}：超时合成形状一致`);
    } finally {
      clearSnapshot();
    }
  }
});

hostTest('变异（可失败）：开关与窗口都是活快照——首问后翻转，次问吃到新值（真实接线）', async () => {
  try {
    const timer = fakeTimer();
    let now = 1_000_000;
    const agent = fakeAgent();
    const services = fakeServices(agent, { roots: null });
    const { listener } = mountListener({
      timer, clock: () => now,
      config: { toolName: 'async_run', askTakeover: true, askTimeoutMs: 30000 }, services
    });
    // 首问：开 → 接管（timer 武装 + 超时结清）。
    let nextCalls = 0;
    const first = listener(makeRequest(agent, [Q('q1')]), () => { nextCalls += 1; return 'n'; });
    assert.equal(nextCalls, 0, '开：首问被接管');
    assert.equal(timer.armed.length, 1, '接管武装定时器');
    now += 30000; // 真期限复验：拨表到到期点再触发
    timer.fire(0);
    const settledFirst = await first;
    assert.equal(settledFirst.answers.length, 1, '首问按快照 A 的窗口合成结清');
    // 翻转：关。次问必须吃到新快照（构造快照会让次问仍被接管——快照行为差异判据）。
    seedSnapshot(resolveConfig({ toolName: 'async_run', askTakeover: false, askTimeoutMs: 30000 }));
    const second = listener(makeRequest(agent, [Q('q2')]), () => { nextCalls += 1; return 'native'; });
    assert.equal(nextCalls, 1, '关：次问交还原生链（判定读到的是翻转后的活快照）');
    assert.equal(second, 'native', '返回值 = next() 原样');
    assert.equal(timer.armed.length, 1, '次问零武装');
    // 再翻：窗口 15000 → 第三问的定时器口径 = 新值。
    seedSnapshot(resolveConfig({ toolName: 'async_run', askTakeover: true, askTimeoutMs: 15000 }));
    const third = listener(makeRequest(agent, [Q('q3')]), () => { nextCalls += 1; return 'n'; });
    assert.equal(timer.armed.length, 2, '再开：第三问接管');
    assert.equal(timer.armed[1].ms, 15000, '窗口读翻转后的新值（活读，不是构造快照）');
    now += 15000; // 拨表到第三问到期点
    timer.fire(1);
    await third;
  } finally {
    clearSnapshot();
  }
});

// ── 卸载（J17）─────────────────────────────────────────────────────────────

hostTest('J17：卸载交还——disposeAll → 未结批 next()、已结/expired 批不再 next', async () => {
  const agent = fakeAgent();
  const { registry, timer } = makeRegistry();
  const nativeA = { native: 'a' };
  const nextA = () => Promise.resolve(nativeA);
  let nextCallsA = 0;
  const pendingA = registry.take(makeRequest(agent, [Q('q1')]), agent, () => { nextCallsA += 1; return nextA(); });
  // 一个 expired 批（超时已放行——它的 next 已不该再被调）。
  const expiredNext = fakeAgent('s-exp');
  let expiredNextCalls = 0;
  const pendingExp = registry.take(
    makeRequest(expiredNext, [Q('q9')]), expiredNext,
    () => { expiredNextCalls += 1; return { native: 'exp' }; }
  );
  timer.fire(1);
  await pendingExp;
  assert.equal(expiredNextCalls, 0, '超时放行不是 next 路径（expired 批已结）');
  const pendingB = registry.take(makeRequest(fakeAgent('s2'), [Q('q2')]), fakeAgent('s2'), () => ({ native: 'b' }));
  assert.equal(timer.armed.length, 3, '三批各武装一个定时器');
  registry.disposeAll();
  assert.equal(timer.armed.every((entry) => entry.cancelled), true, '卸载撤尽定时器');
  assert.equal(registry.batches.size, 0, '注册表清空');
  //  的可失败路径：expired 批的 next 在卸载时**不得**被晚调（cordis waterfall 闭包
  // 无护栏，晚调会重入原生转发器 → 幻影问题卡）。
  assert.equal(expiredNextCalls, 0, 'expired 批卸载时不得再调 next()（晚调用无护栏）');
  assert.equal(nextCallsA, 1, '未结批恰好交还一次');
  // resolve(next()) 的 thenable 收养：原生转发器的等待成为本 Promise 的等待。
  assert.deepEqual(await pendingA, nativeA, '交还后原生结果原样回流');
  assert.deepEqual(await pendingB, { native: 'b' }, '同批次多批逐批交还');
  // next 抛错的最坏形态：按中止形状拒绝，不悬空。
  const pendingC = registry.take(makeRequest(fakeAgent('s3'), [Q('q3')]), fakeAgent('s3'), () => { throw new Error('native gone'); });
  registry.disposeAll();
  await assert.rejects(pendingC, (error) => error.code === 'ASK_ABORTED', 'next 抛错 → 中止形状拒绝');
  // 无 next 的异常形态同样不悬空：
  const pendingD = registry.take(makeRequest(fakeAgent('s4'), [Q('q4')]), fakeAgent('s4'));
  registry.disposeAll();
  await assert.rejects(pendingD, (error) => error.code === 'ASK_ABORTED', '缺 next → 中止形状拒绝');
});

// ── expired 批寿命（J20）──────────────────────────────────────────

hostTest('J20：expired 批 TTL——超龄清扫、龄内保留', async () => {
  let clock = 1_000_000;
  const agent = fakeAgent();
  const { registry, timer } = makeRegistry({});
  registry.now = () => clock; // 可变假钟：接管后拨表模拟 25 h 过去
  const pendingOld = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const oldBatchId = registry.stateItems().items[0].batchId;
  clock += 5000; // 真期限复验（§4.2）：拨表到到期点再触发
  timer.fire(0);
  await pendingOld;
  assert.equal(registry.batches.size, 1, 'expired 批留列');
  clock += 25 * 60 * 60 * 1000; // 25 h > 24 h TTL
  const pendingNew = registry.take(makeRequest(fakeAgent('s-new'), [Q('q2')]), fakeAgent('s-new'));
  assert.equal(registry.batches.size, 1, '新批次接管时超龄 expired 批被清扫（只剩新批）');
  assert.equal(registry.batches.has(oldBatchId), false, '被清的就是那一个超龄批');
  const items = registry.stateItems().items;
  registry.submitAnswer({ batchId: items[0].batchId, questionId: 'q2', selected: ['x'] });
  await pendingNew;
  assert.equal(registry.batches.size, 0, '新批齐答出列');
  // 龄内（< 24 h）不受影响：放一个 expired 批，2 h 后再接管，清扫不得动它。
  const pending3 = registry.take(makeRequest(fakeAgent('s-new3'), [Q('q4')]), fakeAgent('s-new3'));
  clock += 5000; // 拨表到 q4 批到期点
  registry.timer.fire(registry.timer.armed.length - 1);
  await pending3;
  assert.equal(registry.batches.size, 1, 'expired 批在场');
  clock += 2 * 60 * 60 * 1000; // 2 h < TTL
  registry.take(makeRequest(fakeAgent('s-new4'), [Q('q5')]), fakeAgent('s-new4'));
  assert.equal(registry.batches.size, 2, '龄内 expired 批不被清扫（迟到窗口有效）');
});

// ── 客户端模型与座位（J18/J19）────────────────

/** 装载 client.js 产物（CJS 包裹成例）；windowExtras 并进引导对象——eval 包裹的
 * `window` 形参就是模块闭包里的 window，假窗必须从这里进去（globalThis 不生效）。 */
async function loadClientProduct(reactStub, windowExtras = {}) {
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const double = makePrimitivesDouble(reactStub);
  const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
  let loaded;
  new Function('window', source)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } }, ...windowExtras });
  return loaded.factory((name) => (name === 'react' ? reactStub : double));
}

/**
 * 迷你 React shim：组件函数直调，hook 状态存组件闭包。`useReducer` 是**真**实现
 * （dispatch 归约后自动重渲染当前组件——单选替换判据要靠它驱动 chips 点击）；
 * `useSyncExternalStore` 订阅一次后每次读最新快照（单组件单树，无协调器）。
 */
function makeMiniReact() {
  let hooks = [];
  let cursor = 0;
  let current = null;
  function begin() { cursor = 0; }
  function runCurrent() {
    if (current === null) throw new Error('shim：没有当前组件');
    begin();
    react.__lastTree = current();
    return react.__lastTree;
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => {
      const slot = cursor; cursor += 1;
      hooks[slot] = hooks[slot] ?? initial;
      return [hooks[slot], (value) => {
        hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value;
        if (current !== null) runCurrent();
      }];
    },
    useReducer: (reducer, initial) => {
      const slot = cursor; cursor += 1;
      if (hooks[slot] === undefined) hooks[slot] = initial;
      return [hooks[slot], (action) => {
        hooks[slot] = reducer(hooks[slot], action);
        if (current !== null) runCurrent();
      }];
    },
    useRef: (initial) => {
      const slot = cursor; cursor += 1;
      hooks[slot] = hooks[slot] ?? { current: initial };
      return hooks[slot];
    },
    useEffect: (effect) => {
      // run-once 语义（本项目组件的 effect 全部空依赖）：首次执行并存清理函数；
      // 重渲染不重跑。
      const slot = cursor; cursor += 1;
      if (hooks[slot] === undefined) hooks[slot] = { disposer: effect() };
    },
    useSyncExternalStore: (subscribe, getSnapshot) => {
      const slot = cursor; cursor += 1;
      if (hooks[slot] === undefined) hooks[slot] = { dispose: subscribe(() => {}) };
      return getSnapshot();
    },
    Fragment: Symbol.for('react.fragment'),
    /** 渲染一个组件函数（props 闭包进 current；dispatch/重渲染都重跑它）。 */
    render(fn) {
      current = fn;
      hooks = [];
      begin();
      react.__lastTree = current();
      return react.__lastTree;
    },
    __begin: begin
  };
  return react;
}

test('J18：客户端模型行为——准入控制/轮询/裸传/失败路径（经 createAskModel 产品路径）', async () => {
  const react = makeMiniReact();
  // 假 window（node 无 DOM）：轮询间隔与清除走这里（并进 eval 引导对象——见装载器头注）。
  const intervals = [];
  const product = await loadClientProduct(react, {
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {}
  });
  try {
    // 可变设置快照 + 可变 remote 记录器。
    let snap = { status: 'ready', value: {}, user: {} };
    const scope = {
      getSnapshot: () => snap,
      subscribe: () => () => {},
      mutate: async () => true
    };
    const remoteCalls = { state: [], answer: [], ignore: [] };
    let stateResult = { ok: true, value: { serverNow: 10_000, items: [] } };
    let answerResult = { ok: true, value: { outcome: 'delivered' } };
    const remoteNs = {
      state: (...args) => { remoteCalls.state.push(args); return Promise.resolve(stateResult); },
      answer: (...args) => { remoteCalls.answer.push(args); return Promise.resolve(answerResult); },
      ignore: (...args) => { remoteCalls.ignore.push(args); return Promise.resolve({ ok: true, value: { outcome: 'delivered' } }); }
    };
    const ctx = { configForms: { get: () => scope }, uiWorkspace: { openSession() {} } };

    // ① 开关关：零轮询。
    let model = product.createAskModel(ctx, remoteNs);
    assert.equal(intervals.length, 0, '关：间隔零武装（零行为）');
    model.dispose();

    // ② 开：间隔武装 + state() 零参调用（构造期即有一次首询）。
    snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'overlay' }, user: {} };
    model = product.createAskModel(ctx, remoteNs);
    assert.equal(intervals.length, 1, '开：轮询间隔武装');
    assert.equal(intervals[0].ms, product.ASK_STATE_POLL_MS, '间隔 = ASK_STATE_POLL_MS（1000）');
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(remoteCalls.state.length >= 1, 'state() 已被调用（构造期首询或间隔触发）');
    for (const args of remoteCalls.state) {
      assert.deepEqual(args, [], 'state() 每次调用都零参（wire 面）');
    }
    await intervals[0].fn();
    await Promise.resolve();
    await Promise.resolve();

    // ③ answer 裸传。
    stateResult = { ok: true, value: { serverNow: 10_000, items: [{
      batchId: 'ask-1-x', sessionId: 's1', questionId: 'q1', question: '题目',
      options: [{ label: 'a' }], multiSelect: false, receivedAt: 0, expiresAt: 20_000, phase: 'open'
    }] } };
    await intervals[0].fn();
    const item = model.store.getSnapshot().items[0];
    assert.equal(item.questionId, 'q1', '轮询结果进快照');
    let doneFlag = null;
    model.actions.answer(item, ['a'], '注', (ok) => { doneFlag = ok; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(remoteCalls.answer.length, 1, 'answer 恰一次');
    assert.deepEqual(remoteCalls.answer[0], [{ batchId: 'ask-1-x', questionId: 'q1', selected: ['a'], custom: '注' }],
      '载荷裸传（位置参数 = 载荷本身，无 {submission:…} 包裹）');
    assert.equal(doneFlag, true, 'delivered → onDone(true)');

    // ④ 失败路径：outcome:'failed' → onDone(false) + lostAnswers 记名。
    answerResult = { ok: true, value: { outcome: 'failed' } };
    let doneFlag2 = null;
    model.actions.answer(item, ['a'], undefined, (ok) => { doneFlag2 = ok; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(doneFlag2, false, 'failed → onDone(false)（不冒充成功）');
    assert.deepEqual(model.store.getSnapshot().lostAnswers,
      [{ batchId: 'ask-1-x', questionId: 'q1', question: '题目' }],
      '没送达的迟到答案记名进 lostAnswers（面板报错名单）');
    // 复合键去重——同 questionId 不同批次的两条丢失**都**要记（单 questionId
    // 键会吞第二条）。
    const item2 = { ...item, batchId: 'ask-2-y' };
    model.actions.answer(item2, ['a'], undefined, () => {});
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(model.store.getSnapshot().lostAnswers.length, 2, '跨批次同 questionId 不吞（复合键）');
    // 同一条重复 failed 不重复记：
    model.actions.answer(item, ['a'], undefined, () => {});
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(model.store.getSnapshot().lostAnswers.length, 2, '同复合键去重');
    // 消除动作：dismissLost 逐条收走（「知道了」）。
    model.actions.dismissLost('ask-1-x', 'q1');
    assert.deepEqual(model.store.getSnapshot().lostAnswers,
      [{ batchId: 'ask-2-y', questionId: 'q1', question: '题目' }], '消除指定条');
    model.actions.dismissLost('ask-2-y', 'q1');
    assert.equal(model.store.getSnapshot().lostAnswers.length, 0, '消除后面板回到消隐口径');
    // RPC ok:false → onDone(false)，不进 lostAnswers（传输失败可重试）。
    answerResult = { ok: false, error: { code: 'x' } };
    let doneFlag3 = null;
    model.actions.answer(item, ['a'], undefined, (ok) => { doneFlag3 = ok; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(doneFlag3, false, 'RPC 失败 → onDone(false)');
    assert.equal(model.store.getSnapshot().lostAnswers.length, 0, 'RPC 失败不记 lost（可重试路径）');

    // ⑥ 迟到作答通道（需求 §4.4）：竞态补醒失败名单经 state().lost 随轮询并入——与本地
    // 记名同键去重；「知道了」消除后同名单不回弹。
    stateResult = {
      ok: true, value: { serverNow: 20_000, items: [], lost: [{ batchId: 'ask-9-z', questionId: 'q7', question: '题 7' }] }
    };
    await intervals[0].fn();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(model.store.getSnapshot().lostAnswers,
      [{ batchId: 'ask-9-z', questionId: 'q7', question: '题 7' }],
      '服务端 lost 名单随轮询并入面板报错（补醒失败可被人看到）');
    await intervals[0].fn();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(model.store.getSnapshot().lostAnswers.length, 1, '同名单重复轮询不重复记');
    model.actions.dismissLost('ask-9-z', 'q7');
    await intervals[0].fn();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(model.store.getSnapshot().lostAnswers.length, 0, '消除后同名单不回弹（已消除集挡住）');
    model.dispose();
  } finally {
    // 假窗并进 eval 引导对象，无需还原 globalThis。
  }
});

test('J19：座位渲染门——关/计数 0/座位不匹配三态渲染 null，匹配态出本体', async () => {
  const react = makeMiniReact();
  const product = await loadClientProduct(react, { setInterval: () => 0, clearInterval: () => {} });
  // 文档缺席（headless 守卫已内建）；window 也缺席——模型在「关」态不碰两者。
  // scope.subscribe 存下监听器：翻快照后手动触发（模拟设置变更通知）。
  let snap = { status: 'ready', value: {}, user: {} };
  let scopeListener = null;
  const scope = {
    getSnapshot: () => snap,
    subscribe: (fn) => { scopeListener = fn; return () => {}; },
    mutate: async () => true
  };
  const ctx = { configForms: { get: () => scope }, remote: {}, uiWorkspace: { openSession() {} } };
  const model = product.createAskModel(ctx, {});
  const seatProps = { ask: model, ctx };
  const renderComp = (fn) => react.render(fn);

  // ① 关 → 两座位 null。
  assert.equal(renderComp(() => product.AskOverlaySeat(seatProps)), null, '关 + overlay 座位 → null');
  assert.equal(renderComp(() => product.AskSidebarSeat(seatProps)), null, '关 + sidebar 座位 → null');

  // ② 开 + overlay + 计数 0 → null（消隐语义）。
  snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'overlay' }, user: {} };
  scopeListener();
  assert.equal(renderComp(() => product.AskOverlaySeat(seatProps)), null, '开 + overlay + 计数 0 → null');

  // ③ 开 + overlay + 计数 > 0 → 面板本体（树根 className=ats-ask-panel）。
  model.store.getSnapshot().items = [{ batchId: 'b', sessionId: 's1', questionId: 'q1', question: 'q', options: [], multiSelect: false, receivedAt: 0, expiresAt: 1, phase: 'open' }];
  const overlayNode = renderComp(() => product.AskOverlaySeat(seatProps));
  assert.ok(overlayNode !== null && overlayNode.props !== undefined, 'overlay 匹配态渲染本体');
  // AskOverlaySeat 返回 AskList 元素；AskList 是组件——展开一层取面板 div。
  assert.equal(overlayNode.type, product.AskList, 'overlay 座位渲染共享 AskList');
  const panelNode = renderComp(() => product.AskList({ ask: model }));
  assert.equal(panelNode.props.className, 'ats-ask-panel', 'AskList 树根 = 浮框面板');
  // 面板标题：auto 档（默认）按 en 词典回退——缺词典键时不得裸键名直出。
  assert.ok(String(panelNode.children[0].children).includes(product.DICTIONARIES.en['ask.title']),
    '标题走词典（auto 档回退 en，不裸键名）');
  // ④ 座位不匹配：overlay 态下 sidebar 座位 null，反之亦然。
  assert.equal(renderComp(() => product.AskSidebarSeat(seatProps)), null, 'overlay 态下 sidebar 座位 → null');
  snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'sidebar' }, user: {} };
  scopeListener();
  assert.equal(renderComp(() => product.AskOverlaySeat(seatProps)), null, 'sidebar 态下 overlay 座位 → null');
  const badgeNode = renderComp(() => product.AskSidebarSeat(seatProps));
  assert.ok(badgeNode !== null, 'sidebar 匹配态渲染本体（徽标）');
  // 徽标文案走词典（ask.title），不是硬编码英文。
  const badgeButton = badgeNode.children.find((child) => child !== null && typeof child === 'object');
  assert.ok(String(badgeButton.children[0]).includes(product.DICTIONARIES.en['ask.title']),
    '徽标文本 = 词典标题（auto 档回退 en）');
  // 徽标 auto 档跟宿主语言：locale 服务在场（宿主 zh）时徽标读 zh 词典——侧栏座位
  // 的翻译器必须传 ask.locale（与面板标题、重渲染取值两处同款；漏传会恒英文）。
  const zhLocale = { getSnapshot: () => ({ active: 'zh', revision: 1 }), getLocale: () => ({ active: 'zh', revision: 1 }), subscribe(fn) { return () => {}; } };
  // 独立 scope：测试 scope 的 subscribe 只存一个监听器，共用会把上面模型的监听顶掉。
  // configForms.get() 返回的是 store（getSnapshot/subscribe/mutable 形状），不是快照本身。
  const zhSnap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'sidebar' }, user: {} };
  const zhScope = { getSnapshot: () => zhSnap, subscribe(fn) { return () => {}; }, mutate: async () => true };
  const zhCtx = { configForms: { get: () => zhScope }, remote: {}, uiWorkspace: { openSession() {} }, locale: zhLocale };
  // enabled 快照下创建会发首帧 poll——remote（createAskModel 第二参）回 {ok:false}：callFailed 不影响座位准入，也不覆盖手工 items。
  const zhModel = product.createAskModel(zhCtx, { state: async () => ({ ok: false }) });
  zhModel.store.getSnapshot().items = [{ batchId: 'b2', sessionId: 's2', questionId: 'q2', question: 'q', options: [], multiSelect: false, receivedAt: 0, expiresAt: 1, phase: 'open' }];
  const zhBadge = renderComp(() => product.AskSidebarSeat({ ask: zhModel, ctx: zhCtx }));
  const zhBadgeButton = zhBadge.children.find((child) => child !== null && typeof child === 'object');
  assert.ok(String(zhBadgeButton.children[0]).includes(product.DICTIONARIES.zh['ask.title']),
    '徽标 auto + 宿主 zh → zh 词典（侧栏座位翻译器传 ask.locale）');

  // ⑤  渲染条件：条目全部出列、只剩未消除的 lostAnswers → 两座位**仍渲染**
  // （报错必须被人看到；条件只看计数的话单题批次的报错名单永不显示）。
  snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'overlay' }, user: {} };
  scopeListener();
  const live = model.store.getSnapshot();
  live.items = [];
  live.lostAnswers = [{ batchId: 'b', questionId: 'q1', question: 'q' }];
  const lostOnly = renderComp(() => product.AskOverlaySeat(seatProps));
  assert.ok(lostOnly !== null, '只剩 lostAnswers 时 overlay 座位不消隐');
  const lostPanel = renderComp(() => product.AskList({ ask: model }));
  const lostLine = lostPanel.children.find((child) => child?.props?.className === 'ats-ask-failed');
  assert.ok(lostLine !== undefined, '报错名单渲染在面板顶');
  const dismissBtn = lostLine.children.find((child) => child?.props?.className === 'ats-ask-dismiss');
  assert.ok(dismissBtn !== undefined, '每条报错带「知道了」消除按钮');
  dismissBtn.props.onClick();
  assert.equal(model.store.getSnapshot().lostAnswers.length, 0, '点击消除收走该条');
  assert.equal(renderComp(() => product.AskOverlaySeat(seatProps)), null, '消除完 → 座位回到消隐口径');
  // sidebar 座位同一条件：
  snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'sidebar' }, user: {} };
  scopeListener();
  model.store.getSnapshot().lostAnswers = [{ batchId: 'b', questionId: 'q2', question: 'q' }];
  assert.ok(renderComp(() => product.AskSidebarSeat(seatProps)) !== null, 'sidebar 座位同门（lostAnswers 计入）');
  model.dispose();
});

test('AskItem 单选替换语义——multiSelect=false 点第二个 chip 是替换不是叠加', async () => {
  const react = makeMiniReact();
  const product = await loadClientProduct(react, { setInterval: () => 0, clearInterval: () => {} });
  const t = (key) => key;
  const ask = { actions: { answer() {}, ignore() {}, jump() {}, dismissLost() {} }, store: null };
  const pressed = () => react.__lastTree.children[1].children
    .map((chip) => chip.props['aria-pressed'] === 'true');

  // 单选（multiSelect 缺省 false）：a → b 应替换（false→true 翻转、a 弹回）。
  const single = { batchId: 'b', sessionId: 's', questionId: 'q1', question: 'q', multiSelect: false,
    options: [{ label: 'a' }, { label: 'b' }], receivedAt: 0, expiresAt: Date.now() + 60000, phase: 'open' };
  react.render(() => product.AskItem({ item: single, t, ask, serverNow: 0, fetchedAt: 0 }));
  const singleChips = () => react.__lastTree.children[1].children;
  singleChips()[0].props.onClick();
  assert.deepEqual(pressed(), [true, false], '单选：点 a 只选 a');
  singleChips()[1].props.onClick();
  assert.deepEqual(pressed(), [false, true], '单选：点 b **替换**为 b（回退成恒 toggle 时这里会是 [true,true]→红）');
  singleChips()[1].props.onClick();
  assert.deepEqual(pressed(), [false, true], '单选：重复点 b 保持 b（替换语义，非 toggle）');

  // 多选（multiSelect=true）：a、b 可叠加、可各自弹回。
  const multi = { ...single, multiSelect: true };
  react.render(() => product.AskItem({ item: multi, t, ask, serverNow: 0, fetchedAt: 0 }));
  const multiChips = () => react.__lastTree.children[1].children;
  multiChips()[0].props.onClick();
  multiChips()[1].props.onClick();
  assert.deepEqual(pressed(), [true, true], '多选：a、b 叠加');
  multiChips()[0].props.onClick();
  assert.deepEqual(pressed(), [false, true], '多选：a 弹回、b 保留');
});

test('恢复可见即刻本地重算——同步 notify 先于 poll 往返，重新聚焦不闪旧值（v3）', async () => {
  const react = makeMiniReact();
  const product = await loadClientProduct(react, { setInterval: () => 0, clearInterval: () => {} });
  const snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'overlay' }, user: {} };
  const scope = { getSnapshot: () => snap, subscribe: () => () => {}, mutate: async () => true };
  let stateCalls = 0;
  // state() 永不 resolve：模拟宿主忙（v2/v3 实测轮询往返可达数十秒）。
  const remoteNs = { state: () => { stateCalls += 1; return new Promise(() => {}); }, answer() {}, ignore() {} };
  const visibilityListeners = [];
  const fakeDocument = {
    visibilityState: 'visible',
    addEventListener: (event, fn) => { if (event === 'visibilitychange') visibilityListeners.push(fn); },
    removeEventListener: () => {},
    getElementById: () => null,
    createElement: () => ({ textContent: '' }),
    head: { appendChild() {} }
  };
  globalThis.document = fakeDocument;
  try {
    const model = product.createAskModel(
      { configForms: { get: () => scope }, uiWorkspace: { openSession() {} } },
      remoteNs
    );
    assert.ok(visibilityListeners.length >= 1, '可见性监听已挂（headless 守卫在真 DOM 缺席时不挂，这里给了假 DOM）');
    let notified = 0;
    model.store.subscribe(() => { notified += 1; });
    const stateCallsBefore = stateCalls;
    visibilityListeners[visibilityListeners.length - 1]();
    // 同步断言（不 await）：notify 必须在 poll 的往返之前就把订阅者叫醒——
    // 倒计时文本按 Date.now() 现算，首帧即当前剩余。
    assert.ok(notified >= 1, '恢复可见触发同步 notify（本地重算不等 RPC 往返）');
    assert.ok(stateCalls > stateCallsBefore, '同时发起补询 poll（服务端期限仍权威）');
    model.dispose();
    assert.ok(true, 'dispose 清理可见性监听不炸');
  } finally {
    delete globalThis.document;
  }
});

test('AskItem 本地走秒——轮询挂起时读数照走，不冻结在最后一次成功轮询的值（V2-1）', async () => {  const react = makeMiniReact();
  // 假 window：捕获 AskItem 挂的本地秒拍（1 s 间隔），与模型层轮询间隔无关。
  const localTicks = [];
  const clearIntervalSeen = [];
  const product = await loadClientProduct(react, {
    setInterval: (fn, ms) => { localTicks.push({ fn, ms }); return localTicks.length; },
    clearInterval: (id) => { clearIntervalSeen.push(id); }
  });
  const t = (key) => (key === 'ask.windowLeft' ? '{s}' : key);
  const ask = { actions: { answer() {}, ignore() {}, jump() {}, dismissLost() {} }, store: null };

  // 伪钟：倒计时文本按 Date.now() 现算，用可拨的钟避免真实等待与秒界抖动。
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    const item = { batchId: 'b', sessionId: 's', questionId: 'q1', question: 'q', options: [],
      multiSelect: false, receivedAt: 0, expiresAt: fakeNow + 60000, phase: 'open' };
    react.render(() => product.AskItem({ item, t, ask, serverNow: 0, fetchedAt: 0 }));
    const leftSeconds = () => {
      const row = react.__lastTree.children[react.__lastTree.children.length - 1];
      const span = row.children.find((child) => child?.props?.className === 'ats-ask-left');
      return String(span.children);
    };
    assert.match(leftSeconds(), /60 s/, '初始读数 60 s');
    // 「轮询挂起」模拟：之后**只有**本地秒拍驱动重渲（无任何 store notify / poll 返回）。
    const tick = localTicks.find((entry) => entry.ms === 1000);
    assert.ok(tick !== undefined, 'AskItem 挂本地秒拍（1000 ms）');
    fakeNow += 1000; tick.fn();
    assert.match(leftSeconds(), /59 s/, '+1 s：读数走秒（旧代码无本地拍，这里冻结在 60）');
    fakeNow += 4000; tick.fn();
    assert.match(leftSeconds(), /55 s/, '+5 s 累计：继续走');
    // 出窗：读数翻「已超时」同样由本地拍驱动（键名即 t 的回显）。
    fakeNow += 60000; tick.fn();
    assert.match(leftSeconds(), /ask\.expired/, '越过期限后本地拍也能翻到超时态');
    // 卸载清理：重渲染同组件不重复挂拍（run-once effect）；清理函数在位。
    const disposers = react.__lastTree; // 树本身不含 disposer——清理走 effect 槽
    assert.equal(localTicks.filter((entry) => entry.ms === 1000).length, 1, '本地秒拍只挂一次');
    void disposers;
  } finally {
    Date.now = realNow;
  }
});

test('sidebar 注册 label 闭包——经 apply 产品路径，随快照语言翻词典', async () => {
  const react = makeMiniReact();
  const product = await loadClientProduct(react, { setInterval: () => 0, clearInterval: () => {} });
  // 可变快照：语言翻 zh/en 两档；开关开 + 座位 sidebar。
  let snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'sidebar' }, user: {} };
  let scopeListener = null;
  const scope = {
    getSnapshot: () => snap,
    subscribe: (fn) => { scopeListener = fn; return () => {}; },
    mutate: async () => true
  };
  const registrations = [];
  const askRemoteNs = { state: () => Promise.resolve({ ok: true, value: { serverNow: 0, items: [] } }) };
  const ctx = {
    configForms: {
      get: () => scope,
      whileServed: (entries, fn) => { const off = fn(); return () => off?.(); }
    },
    slots: {
      inject: (slot, factory) => { const off = factory(); return () => off?.(); },
      register: (meta, renderFn) => { registrations.push({ meta, renderFn }); return () => {}; }
    },
    // 真机同款路径：seats 经**动态** ctx.inject(['remote.async-tools-ask'])
    // 拿命名空间代理（自 mount 的 ns 不能直接读 ctx.remote[ns]）。
    inject: (list, fn) => fn({ remote: { 'async-tools-ask': askRemoteNs } }),
    locale: { register: () => () => {} },
    remote: { $mount: () => Promise.resolve(() => {}) },
    effect: (fn) => { const off = fn(); return () => off?.(); },
    uiWorkspace: { openSession() {} }
  };
  product.apply(ctx);
  // seats 在 $mount promise 的微任务之后才装（真机同款顺序）——冲两拍微任务。
  await Promise.resolve();
  await Promise.resolve();
  const sidebarReg = registrations.find((reg) => reg.meta.name === 'sidebar.footer.action' && reg.meta.id === 'async-tools-ask');
  assert.ok(sidebarReg !== undefined, 'sidebar 座位注册经 apply 生效');
  assert.equal(typeof sidebarReg.meta.label, 'function', 'label 是函数（宿主重读接口）');
  // 快照语言缺省（auto，无 uiLang 键）→ 回退 en 词典档。
  assert.equal(sidebarReg.meta.label(), product.DICTIONARIES.en['ask.title'], 'label() 走词典（缺省档）');
  // 翻 zh → 待答问题；翻 en → Pending questions（闭包读的是**活快照**）。
  snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'sidebar', uiLang: 'zh' }, user: {} };
  scopeListener();
  assert.equal(sidebarReg.meta.label(), product.DICTIONARIES.zh['ask.title'], 'label() 随活快照翻 zh');
  snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'sidebar', uiLang: 'en' }, user: {} };
  scopeListener();
  assert.equal(sidebarReg.meta.label(), product.DICTIONARIES.en['ask.title'], 'label() 随活快照翻 en');
  // overlay 座位同批注册（order 900）——顺带锚一下不误删。
  const overlayReg = registrations.find((reg) => reg.meta.name === 'shell.overlay' && reg.meta.id === 'async-tools-ask');
  assert.ok(overlayReg !== undefined && overlayReg.meta.order === 900, 'overlay 座位注册并存');
});

// ── J21：待答界面语言三档（读取范围）─────────────────────────

test('J21：语言三档——auto 经 ctx.locale 跟宿主语言，zh/en 钉住本包词典；locale 推送驱动重渲', async () => {
  const react = makeMiniReact();
  const product = await loadClientProduct(react, { setInterval: () => 0, clearInterval: () => {} });

  /** 假 locale 服务（LocaleRuntime 读取接口形状：getSnapshot 渲染订阅、
   * getLocale 一次性读——返回值是快照对象；subscribe 靠 revision 推送）。 */
  function makeLocale(initial) {
    let active = initial;
    const listeners = new Set();
    return {
      getSnapshot: () => ({ active, revision: 1 }),
      getLocale: () => ({ active, revision: 1 }),
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      setActive(next) { active = next; listeners.forEach((fn) => fn()); }
    };
  }

  // ① askTranslator 三档直查（产品侧）：auto 跟宿主、zh/en 钉住、locale 缺席回退 en。
  const zhTitle = product.DICTIONARIES.zh['ask.title'];
  const enTitle = product.DICTIONARIES.en['ask.title'];
  assert.equal(product.askTranslator('auto', makeLocale('zh'))('ask.title'), zhTitle,
    'auto + 宿主 zh → zh 词典（修正点：恒英文死角消除）');
  assert.equal(product.askTranslator('auto', makeLocale('en'))('ask.title'), enTitle,
    'auto + 宿主 en → en 词典');
  assert.equal(product.askTranslator('auto', null)('ask.title'), enTitle,
    'locale 服务缺席（旧装载环境/单测未注入）→ 回退 en，不抛错');
  assert.equal(product.askTranslator('zh', makeLocale('en'))('ask.title'), zhTitle, 'zh 档钉住（不跟宿主）');
  assert.equal(product.askTranslator('en', makeLocale('zh'))('ask.title'), enTitle, 'en 档钉住');
  // 降级读取路径：getSnapshot 缺席、只有 getLocale（一次性读）时 auto 仍取宿主语言。
  assert.equal(product.askTranslator('auto', { getLocale: () => ({ active: 'zh' }) })('ask.title'), zhTitle,
    'getLocale 一次性读取也生效（返回快照对象，读 active）');

  // ② 模型侧：createAskModel 持 ctx.locale 引用；宿主语言切换（revision 推送）→
  // store notify → AskList 以新语言重渲（useSyncExternalStore 的重渲入口）。
  let snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'overlay' }, user: {} };
  let scopeListener = null;
  const scope = {
    getSnapshot: () => snap,
    subscribe: (fn) => { scopeListener = fn; return () => {}; },
    mutate: async () => true
  };
  const locale = makeLocale('zh');
  const askRemote = { state: () => Promise.resolve({ ok: true, value: { serverNow: 0, items: [] } }) };
  const ctx = {
    configForms: { get: () => scope }, remote: askRemote,
    uiWorkspace: { openSession() {} }, locale
  };
  const model = product.createAskModel(ctx, askRemote);
  assert.equal(model.locale, locale, '模型持有 locale 读取侧引用（AskList 的 t 从这里解析 auto 档）');
  model.store.getSnapshot().items = [{
    batchId: 'b', sessionId: 's1', questionId: 'q1', question: 'q', options: [],
    multiSelect: false, receivedAt: 0, expiresAt: 1, phase: 'open'
  }];
  const before = model.store.getSnapshot();
  let panelNode = react.render(() => product.AskList({ ask: model }));
  assert.ok(String(panelNode.children[0].children).includes(zhTitle), '宿主 zh：auto 档面板中文');

  locale.setActive('en');
  assert.notEqual(model.store.getSnapshot(), before, 'locale revision 推送驱动 store notify（重渲入口被点火）');
  panelNode = react.render(() => product.AskList({ ask: model }));
  assert.ok(String(panelNode.children[0].children).includes(enTitle), '宿主切 en：auto 档面板整段跟随');

  // ③ 三档边界：uiLang=zh 钉住——宿主语言再切也不动（设置卡语义，非 auto 档不跟）。
  snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'overlay', uiLang: 'zh' }, user: {} };
  scopeListener();
  locale.setActive('en');
  panelNode = react.render(() => product.AskList({ ask: model }));
  assert.ok(String(panelNode.children[0].children).includes(zhTitle), 'zh 档不被宿主语言搬动（钉住语义）');
  model.dispose();
});

// ── J22：唤醒事件 + 末步竞态补醒 + 起始检查对账（迟到作答通道，需求 §4.4）──────

hostTest('J22-①：作答/忽略到达即刻发本包事件恰一次，作答与忽略同形、载荷含 agent 标识与题号', async () => {
  const agent = fakeAgent('s-evt');
  const { registry, timer, emitted } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1'), Q('q2')]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: ['x'] });
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q2', kind: 'ignore' });
  assert.equal(emitted.length, 2, '每条到达恰一次事件');
  const [answerEvent, ignoreEvent] = emitted;
  assert.equal(answerEvent.name, LATE_ANSWER_EVENT, '事件名 = LATE_ANSWER_SOURCE 派生常量');
  assert.equal(answerEvent.payload.agentId, 's-evt', '载荷含 agent 标识');
  assert.equal(answerEvent.payload.questionId, 'q1', '载荷含题号');
  assert.equal(answerEvent.payload.kind, 'answer', '作答 kind');
  assert.equal(answerEvent.payload.summary, t('en', 'ask.lateSummary', { qid: 'q1', answer: 'x' }), '载荷含摘要');
  assert.deepEqual(
    Object.keys(ignoreEvent.payload).sort(),
    Object.keys(answerEvent.payload).sort(),
    '忽略与作答同形（同键集）'
  );
  assert.equal(ignoreEvent.payload.kind, 'ignore', '忽略 kind');
  // 窗口内作答不发事件（无迟到投递，无需唤醒）：
  const agent2 = fakeAgent('s-evt2');
  const { registry: r2, emitted: emitted2 } = makeRegistry({ agentLang: 'en' });
  const pending2 = r2.take(makeRequest(agent2, [Q('q1')]), agent2);
  const item2 = r2.stateItems().items[0];
  r2.submitAnswer({ batchId: item2.batchId, questionId: 'q1', selected: ['y'] });
  await pending2;
  assert.equal(emitted2.length, 0, '窗口内作答零事件（直达工具结果，无迟到通道）');
});

hostTest('J22-②：末步竞态防护——inject 后回合收尾再无领取点，空闲观察发现滞留 → 补一条极小提醒恰一次', async () => {
  const agent = fakeAgent('s-race');
  const { registry, timer } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1'), Q('q2')]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: ['x'] });
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q2', kind: 'answer', selected: ['y'] });
  assert.equal(agent.followupCalls.length, 0, '投递时零补醒（还在回合里）');
  // 末步竞态：回合的最后一次领取已过 → 两通知滞留 next-step，回合收尾转 idle。
  agent.finishTurn({ claim: false }); // 模拟回合结束（不再有领取点）
  await flush();
  assert.equal(agent.followupCalls.length, 1, '空闲观察发现滞留 → 补一条 followup 恰一次');
  const reminder = agent.followupCalls[0];
  assert.equal(reminder.source.kind, LATE_ANSWER_SOURCE, '提醒仍是本包 kind');
  assert.equal(reminder.source.form, 'reminder', 'form=reminder（催领条，不是答案）');
  assert.equal(reminder.source.summary, t('en', 'ask.lateReminderSummary'), '提醒摘要');
  assert.equal(reminder.content[0].text, t('en', 'ask.lateReminder'), '极小提醒正文 = 词典模板');
  assert.ok(!reminder.content[0].text.includes('q1') && !reminder.content[0].text.includes('问题文本'),
    '不含作答正文/题目内容（不重复投递）');
  // 恰一次：两个滞留件也只补一条（新回合首个领取点整批顺走全部）。
  await flush();
  assert.equal(agent.followupCalls.length, 1, '不重复补醒');
});

hostTest('J22-③：滞留件已被领取 → 空闲观察不补醒（账本懒剪除）', async () => {
  const agent = fakeAgent('s-claimed');
  const { registry, timer } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: ['x'] });
  // 正常路径：下一领取点把 next-step 整批领走，回合收尾转 idle。
  agent.finishTurn();
  await flush();
  assert.equal(agent.followupCalls.length, 0, '已领取 → 无滞留 → 不补醒');
  assert.equal(registry.lateLedger.length, 0, '账本随领取懒剪除');
  assert.deepEqual(registry.stateItems().lost, [], '无 lost');
});

hostTest('J22-④：补醒失败 → 滞留条目转 lost 名单（复合键去重、上限 20），经 state() 供界面报错', async () => {
  const agent = fakeAgent('s-sweepfail');
  const { registry, timer } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: ['x'] });
  // 补醒时 agent 引用失效：followup 抛错。
  agent.followup = () => { throw new Error('agent gone before sweep'); };
  agent.finishTurn({ claim: false });
  await flush();
  assert.deepEqual(registry.stateItems().lost, [{
    batchId: items[0].batchId, questionId: 'q1', question: '问题文本 q1'
  }], '补醒失败 → lost 名单（含题目内容供面板报错）');
  assert.equal(registry.lateLedger.length, 0, '转 lost 后账本出清');
});

hostTest('J22-⑤：空闲通道（followup）不武装补醒；dispose 后不再补醒', async () => {
  const agent = fakeAgent('s-nosweep', { status: 'idle' });
  const { registry, timer } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: ['x'] });
  assert.equal(agent.followupCalls.length, 1, '空闲 → followup 自开回合');
  // 该回合开跑后立刻结束（无其他滞留）→ 不应有第二条 followup。
  agent.finishTurn();
  await flush();
  assert.equal(agent.followupCalls.length, 1, 'followup 通道不武装补醒（自开回合即领取）');

  // dispose 面：inject 滞留后卸载 → 不再补醒。
  const agent2 = fakeAgent('s-dispose');
  const { registry: r2, timer: t2 } = makeRegistry({ agentLang: 'en' });
  const pending2 = r2.take(makeRequest(agent2, [Q('q1')]), agent2);
  const items2 = r2.stateItems().items;
  t2.fire(0);
  await pending2;
  r2.submitLate({ batchId: items2[0].batchId, questionId: 'q1', kind: 'answer', selected: ['x'] });
  r2.disposeAll();
  agent2.finishTurn();
  await flush();
  assert.equal(agent2.followupCalls.length, 0, '卸载后不再补醒（观察随 fiber 消失）');
});

hostTest('J22-⑥：投递核对——注册表投递后，等待方的起始检查立即命中（同包两侧）', async () => {
  const { ctx } = fakeCtx();
  const agent = fakeAgent('s-bridge');
  const { registry, timer } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: ['x'] });
  // 作答先到、等待后开：watchLateAnswer 起始检查从 agent.inbox 命中滞留通知。
  const watcher = watchLateAnswer(ctx, agent);
  const signal = await watcher.promise;
  assert.equal(signal.kind, 'late-answer');
  assert.equal(signal.qid, 'q1', '起始检查透传题号（source.questionId）');
  assert.equal(signal.summary, t('en', 'ask.lateSummary', { qid: 'q1', answer: 'x' }), 'summary 与投递同源');
  watcher.dispose();
});

hostTest('J22-⑦：投递侧 inbox 不可读（getter 抛错）→ 按「有未领取」保守走 inject', async () => {
  const agent = fakeAgent('s-deadinbox', { status: 'idle' });
  const { registry, timer } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;
  // 空闲但 inbox getter 抛错（projection 注销的设计内错误，dsh-agent-loop
  // `current()`）。保守方向：宁走 inject——死 agent 的投递错落 'failed' 回执，
  // 不错走 followup 在运行中开新回合。假件 inject 覆写成只记录，是为**隔离
  // 通道选择这一步**；真机上 inject() 首行就经 send→mutate 读同一投影，同根因
  // 会直接抛错 → 收敛 'failed' 回执（J12 已钉该情形）。
  agent.inject = (message) => { agent.injectCalls.push(message); };
  const realInbox = agent.inbox;
  Object.defineProperty(agent, 'inbox', {
    configurable: true,
    get() { throw new Error('projection registration is not active'); }
  });
  assert.equal(registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: ['x'] }), 'late');
  assert.equal(agent.injectCalls.length, 1, 'inbox 不可读 → inject（保守方向）');
  assert.equal(agent.followupCalls.length, 0, '不开 followup（不可读不等于无未领取）');
  Object.defineProperty(agent, 'inbox', { configurable: true, value: realInbox });
});

hostTest('J22-⑧：补醒观察期 inbox 不可读 → 观察失败防护（不炸、账本保留、恢复后仍能补醒）', async () => {
  const agent = fakeAgent('s-sweepblind');
  const { registry, timer } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: ['x'] });
  assert.equal(agent.injectCalls.length, 1, '运行中 → inject + 武装观察');
  // 观察在途时 inbox getter 抛错（projection 注销形态）。旧病灶：observe 的
  // 账本读裸奔在 try 外 → reject 被 void 丢弃 → unhandledRejection，
  // 整实例退出。现在：audit + 放弃本观察，账本条目保留。
  const realInbox = agent.inbox;
  Object.defineProperty(agent, 'inbox', {
    configurable: true,
    get() { throw new Error('projection registration is not active'); }
  });
  agent.finishTurn({ claim: false }); // 末步竞态形态：滞留 + 转空闲
  await flush();
  assert.equal(agent.followupCalls.length, 0, '观察对账读失败 → 不补醒也不炸（audit 落审计）');
  assert.equal(registry.stateItems().lost.length, 0, '读失败不是投递失败 → 不进 lost');
  // 账本条目保留（未按已领取剪除）：恢复可读后下一批投递重新武装 → 补醒成功。
  Object.defineProperty(agent, 'inbox', { configurable: true, value: realInbox });
  const pending2 = registry.take(makeRequest(agent, [Q('q2')]), agent);
  timer.fire(1);
  await pending2;
  const q2Item = registry.stateItems().items.find((item) => item.questionId === 'q2');
  registry.submitLate({ batchId: q2Item.batchId, questionId: 'q2', kind: 'answer', selected: ['y'] });
  agent.finishTurn({ claim: false });
  await flush();
  assert.equal(agent.followupCalls.length, 1, '恢复可读后重新武装：补醒提醒恰一条（两滞留条都还在账上）');
  const reminder = agent.followupCalls[0];
  assert.equal(reminder.source.form, 'reminder', '补醒条 form:reminder（不冒充答案）');
});

// ═══════════════════ 延长等待（需求 §4.3，判据 E1–E8）═════════════════════
//
// 延长等待语义：无组级暂停/恢复，用户点「增加等待时间」把在窗批的
// 到期点向后推（快照现读 askExtendMs），定时器按新剩余重挂（分段封顶 2^31-1），
// 提前触发读真钟哑火重挂。判据 → 各挡什么：
//
// | 判据 | 挡的缺陷形式 |
// |---|---|
// | E1 批过滤与到期点（open 且 now<expiresAt 才延） | 已结/expired 批被复活 ⇒ 合成答案迟到翻案 |
// | E2 重挂定时器（撤旧挂新，ms=新剩余；分段封顶） | 元数据延了定时器没延 ⇒ 加时是假的 |
// | E3 提前触发哑火（真钟未到 → 重挂不结清） | 早触发把在窗批放行 ⇒ 加时无效 |
// | E4 服务接口 extend（单层包裹 {extended:n}） | 载荷/参数名漂移 ⇒ 宿主收双包裹 |
// | E5 跨会话隔离 | 会话 A 的加时平移会话 B 的批次 |
// | E6 出窗批返 0（不复活；新批照常全额计时） | 过窗加时 ⇒ 悬死批或新批继承错窗口 |
// | E7 客户端组头按钮（extend 裸传 + 失败面板顶报错 + 成功立即轮询） | 双动作按钮回潮、失败静默、期限显示滞后 |
// | E8 时钟调度边界（到期前不结、恰一次合成、重复投递哑火；extend 后按新剩余） | 武装 delay 与 expiresAt 脱钩 ⇒ 元数据正确行为错误 |

/**  中止形状断言（plain object，非 Error——按 code 判）。 */
const isAskAborted = (error) => error?.name === 'UserQuestionError' && error?.code === 'ASK_ABORTED';

/** 快配注入时钟（剩余与平移判据要有可推进的钟）。 */
function makeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; return now; } };
}

/**
 * 时钟调度替身：armed 项记 `dueAt = now + ms`，`advance()` 按到期序（同拍按
 * 武装序）触发**未撤销**项——「到期前不结、到期恰一次合成」两边界判据靠它
 * 可失败：把 take/extend 的武装 delay 改错（缩短/重置全窗口）而保留
 * expiresAt 元数据时，手动 fire 推不红，按到期序推进才红。`fakeTimer` +
 * 手动 `fire()` 一族照旧使用；本族也保留 `fire()`（直发路径防御），
 * 两族互不干扰。
 */
function makeScheduledClock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const armed = [];
  const clock = {
    now: () => now,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = armed
          .filter((e) => !e.cancelled && !e.fired && e.dueAt <= target)
          .sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq)[0];
        if (due === undefined) break;
        now = due.dueAt; // 回调内 extend 读到的是触发时刻的钟
        due.fired = true;
        due.fn();
      }
      now = target;
      return now;
    }
  };
  const timer = {
    timeout(fn, ms) {
      const entry = { fn, ms, dueAt: now + ms, cancelled: false, fired: false, seq: seq++ };
      armed.push(entry);
      return () => { entry.cancelled = true; };
    },
    armed,
    fire(index = 0) {
      const entry = armed[index];
      assert.ok(entry !== undefined, '定时器必须已武装');
      entry.fired = true;
      entry.fn();
    }
  };
  return { clock, timer };
}

hostTest('E1：extend 只作用于 open 且在窗的批——到期点 += 点击时刻快照的 askExtendMs，计数回执', async () => {
  const clock = makeClock();
  const rig = makeRegistry({ timeoutMs: 5000, clock: clock.now });
  rig.setSnapshot({ askTakeover: true, askTimeoutMs: 5000, askExtendMs: 7000, agentLang: 'en' });
  const agent = fakeAgent();
  const pending = registry_take(rig, agent, 'q1');
  const batch = [...rig.registry.batches.values()][0];

  clock.advance(2000); // 烧掉 2 s，剩 3 s
  assert.equal(rig.registry.extend(agent.id), 1, '在窗 open 批恰一条被延长');
  assert.equal(batch.expiresAt, 1_012_000, '到期点 = 原到期点(1_005_000) + askExtendMs(7000)——点击时刻现读快照');
  const item = rig.registry.stateItems().items[0];
  assert.equal(item.expiresAt, batch.expiresAt, 'state() 反映新到期点（客户端倒计时经 serverNow 校准）');

  // 快照切换步长：加时是活读，不是首问快照。
  rig.setSnapshot({ askTakeover: true, askTimeoutMs: 5000, askExtendMs: 3000, agentLang: 'en' });
  assert.equal(rig.registry.extend(agent.id), 1, '第二次延长仍命中（幂等叠加）');
  assert.equal(batch.expiresAt, 1_015_000, '第二次按新步长叠加（1_012_000 + 3000）');

  rig.registry.disposeAll();
  await assert.rejects(pending, isAskAborted);
});

hostTest('E2：extend 撤旧定时器并按新剩余重挂——剩余越过 2^31-1 时分段封顶', async () => {
  const clock = makeClock();
  const rig = makeRegistry({ timeoutMs: 5000, clock: clock.now });
  rig.setSnapshot({ askTakeover: true, askTimeoutMs: 5000, askExtendMs: 7000, agentLang: 'en' });
  const agent = fakeAgent();
  const pending = registry_take(rig, agent, 'q1');

  clock.advance(1000);
  const armedBefore = rig.timer.armed.length;
  assert.equal(rig.registry.extend(agent.id), 1);
  assert.equal(rig.timer.armed[0].cancelled, true, '延长必须撤旧 timer（cancelTimer）');
  const rearmed = rig.timer.armed[rig.timer.armed.length - 1];
  assert.equal(armedBefore + 1, rig.timer.armed.length, '恰挂一个新 timer');
  assert.equal(rearmed.ms, 5000 - 1000 + 7000, '新 timer.ms = 新到期点 - now（新剩余，非全窗口）');

  // 分段武装：askExtendMs 巨大 → 剩余越过 2^31-1，单次武装必须封顶（setTimeout
  // 越界会被置 1ms 立即触发——分段由到期回调的真钟校验接力，E3 守哑火重挂）。
  rig.setSnapshot({ askTakeover: true, askTimeoutMs: 5000, askExtendMs: 4_000_000_000, agentLang: 'en' });
  rig.registry.extend(agent.id);
  const segmented = rig.timer.armed[rig.timer.armed.length - 1];
  assert.equal(segmented.ms, 2147483647, '剩余 > 2^31-1 时单段武装封顶 2147483647');

  rig.registry.disposeAll();
  await assert.rejects(pending, isAskAborted);
});

hostTest('E3：到期回调提前触发（真钟未到）→ 哑火重挂，不结清在窗批', async () => {
  const clock = makeClock();
  const rig = makeRegistry({ timeoutMs: 5000, clock: clock.now });
  rig.setSnapshot({ askTakeover: true, askTimeoutMs: 5000, askExtendMs: 7000, agentLang: 'en' });
  const agent = fakeAgent();
  const pending = registry_take(rig, agent, 'q1');
  const batch = [...rig.registry.batches.values()][0];

  clock.advance(1000);
  rig.registry.extend(agent.id);
  // 真实形态：定时器早触发（宿主钟与到期回调的竞态窗口、或分段接力边界）。
  const armedCount = rig.timer.armed.length;
  rig.timer.fire(armedCount - 1);
  assert.equal(batch.phase, 'open', '真钟未到不得结清（#onExpiry 读 now vs expiresAt）');
  assert.equal(rig.timer.armed.length, armedCount + 1, '早触发重挂一段（继续守剩余）');
  const rearmed = rig.timer.armed[rig.timer.armed.length - 1];
  assert.equal(rearmed.ms, 5000 - 1000 + 7000, '重挂 ms = 剩余（相对触发时刻）');

  // 走到新到期点 → 正常合成放行（延长后的窗口真实生效）。
  clock.advance(5000 - 1000 + 7000);
  rig.timer.fire(rig.timer.armed.length - 1);
  const answers = await pending;
  assert.equal(answers.answers[0].selected.length, 0, '延长后按新到期点恰一次合成');
  assert.equal(batch.phase, 'expired');
});

hostTest('E4：服务接口 extend——submission.sessionId 裸传、回执 {extended:n} 单层包裹', async () => {
  const clock = makeClock();
  const rig = makeRegistry({ timeoutMs: 5000, clock: clock.now });
  rig.setSnapshot({ askTakeover: true, askTimeoutMs: 5000, askExtendMs: 7000, agentLang: 'en' });
  const fakeReflectCtx = { reflect: { provide() {} } };
  const service = new AskTakeoverService(fakeReflectCtx, rig.registry);
  const agent = fakeAgent('session-e4');
  const pending = registry_take(rig, agent, 'q1');

  // extend 是查询形回执（不是 outcome 形）：宿主只关心延长了多少条。
  assert.deepEqual(await service.extend({ sessionId: agent.id }), { extended: 1 });
  // 无匹配批 → extended:0 仍是成功回执（不是错误——窗口外点击是合法现场）。
  assert.deepEqual(await service.extend({ sessionId: 'no-such-session' }), { extended: 0 });
  assert.deepEqual(await service.extend(undefined), { extended: 0 }, 'submission 缺席按零延长（防御）');

  rig.registry.disposeAll();
  await assert.rejects(pending, isAskAborted);
});

hostTest('E5：跨会话隔离——A 加时不动 B 的到期点与定时器', async () => {
  const clock = makeClock();
  const rig = makeRegistry({ timeoutMs: 5000, clock: clock.now });
  rig.setSnapshot({ askTakeover: true, askTimeoutMs: 5000, askExtendMs: 7000, agentLang: 'en' });
  const agentA = fakeAgent('session-extA');
  const agentB = fakeAgent('session-extB');
  const pendingA = registry_take(rig, agentA, 'qa');
  const pendingB = registry_take(rig, agentB, 'qb');
  const batchB = [...rig.registry.batches.values()].find((b) => b.sessionId === agentB.id);
  const bExpiresAt = batchB.expiresAt;
  const bTimer = rig.timer.armed[1]; // B 的原装 timer（武装序第二）

  assert.equal(rig.registry.extend(agentA.id), 1, '只延长 A 的批');
  assert.equal(batchB.expiresAt, bExpiresAt, 'B 的到期点不动');
  assert.equal(bTimer.cancelled, false, 'B 的 timer 未被撤（撤的只是 A 的）');

  // B 按原窗口到期合成（A 的加时不推迟 B）。A 的原装 timer 在 B 之前武装且
  // 已被撤销——真钟 1_005_000 时误触发它只会哑火重挂（E3 口径），不影响 B。
  clock.advance(5000);
  rig.timer.fire(1);
  const answersB = await pendingB;
  assert.equal(answersB.answers[0].selected.length, 0, 'B 按原窗口放行');
  rig.registry.disposeAll();
  await assert.rejects(pendingA, isAskAborted);
});

hostTest('E6：出窗批 extend 返 0（不复活）；随后新批照常全额计时', async () => {
  const clock = makeClock();
  const rig = makeRegistry({ timeoutMs: 5000, clock: clock.now });
  rig.setSnapshot({ askTakeover: true, askTimeoutMs: 5000, askExtendMs: 7000, agentLang: 'en' });
  const agent = fakeAgent();
  const pending = registry_take(rig, agent, 'q1');
  const batch = [...rig.registry.batches.values()][0];

  // 窗口耗尽后（真实形态：到期回调与点击同拍竞态）→ expired 相不可复活。
  clock.advance(6000);
  rig.timer.fire(0);
  await Promise.resolve();
  assert.equal(batch.phase, 'expired');
  assert.equal(rig.registry.extend(agent.id), 0, '出窗批零延长（now < expiresAt 过滤）');
  assert.equal(batch.expiresAt, 1_000_000 + 5000, '到期点不被出窗点击平移');
  await pending;

  // 新批照常全额计时（无残留状态）。
  const armedBefore = rig.timer.armed.length;
  const pending2 = registry_take(rig, agent, 'q2');
  const batch2 = [...rig.registry.batches.values()].find((b) => b.questions.has('q2'));
  assert.equal(rig.timer.armed[rig.timer.armed.length - 1].ms, 5000, '新批 timer.ms=全额窗口');
  assert.equal(batch2.phase, 'open');
  assert.equal(rig.timer.armed.length, armedBefore + 1);
  assert.equal(rig.registry.submitAnswer({ batchId: batch2.batchId, questionId: 'q2', selected: ['选项一'] }), 'delivered');
  await pending2;
});

hostTest('E8：时钟调度边界——到期前不结、恰一次合成、重复投递哑火；extend 后按新剩余到期', async () => {
  const { clock, timer } = makeScheduledClock();
  const rig = makeRegistry({ timeoutMs: 5000, timer, clock: clock.now });
  rig.setSnapshot({ askTakeover: true, askTimeoutMs: 5000, askExtendMs: 3000, agentLang: 'en' });
  const agent = fakeAgent('session-e8');
  let settles = 0;
  const track = (pending) => { pending.then(() => { settles += 1; }, () => { settles += 1; }); return pending; };

  // (a) 新批：timer.ms=全额 + 到期边界（武装 delay 缩短而 expiresAt 元数据
  // 照旧时，advance(4999) 已结 ⇒ 红）。
  const pending1 = track(registry_take(rig, agent, 'q1'));
  const batch1 = [...rig.registry.batches.values()].find((b) => b.questions.has('q1'));
  assert.equal(timer.armed[0].ms, 5000, '新批 timer.ms=5000（全额窗口）');
  clock.advance(4999);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settles, 0, '到期前不结（4999/5000 仍 open）');
  assert.equal(batch1.phase, 'open', '批 1 仍 open');
  clock.advance(1);
  const answers1 = await pending1;
  assert.equal(answers1.answers[0].selected.length, 0, '到期恰一次合成（空答）');
  assert.equal(batch1.phase, 'expired', '批 1 转 expired');
  clock.advance(60_000);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settles, 1, '恰一次兑现（Promise 最终结算观察）');

  // (b) 延长剩余：烧 2 s 加时 3 s → 重挂 ms=6000（非全窗口 5000——重置成
  // 全窗口的变异在 ms 断言与到期双边界必红）；到期点 = 原到期点 + 3000。
  // （(a) 已把钟推到 1_065_000；q2 于此刻接管，原到期点 = 1_070_000。）
  const pending2 = track(registry_take(rig, agent, 'q2'));
  const batch2 = [...rig.registry.batches.values()].find((b) => b.questions.has('q2'));
  clock.advance(2000);
  assert.equal(rig.registry.extend(agent.id), 1);
  const rearmed = timer.armed[timer.armed.length - 1];
  assert.equal(rearmed.ms, 6000, '延长重挂 ms=新剩余 6000（非全窗口 5000）');
  assert.equal(batch2.expiresAt, 1_070_000 + 3000, '到期点=原到期点+3000');
  clock.advance(5999);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settles, 1, '延长后到期前不结（5999/6000 仍 open）');
  assert.equal(batch2.phase, 'open', '批 2 仍 open');
  clock.advance(1);
  const answers2 = await pending2;
  assert.equal(answers2.answers[0].selected.length, 0, '延长后按新剩余到期恰一次合成');
  assert.equal(batch2.phase, 'expired', '批 2 转 expired');
  clock.advance(60_000);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settles, 2, '全程恰两次兑现（两批各一次——Promise 结算观察；防双结护栏在 (c)）');

  // (c) 防双结护栏：到期后主动重复投递同一到期回调（模拟误挂双回调），
  // `batch.resolve` 包计数作可见副作用——Promise.then 天生单结算，不能当
  // 「恰一次」的证据。已结防御必须吞掉第二次 expire。
  const pending3 = registry_take(rig, agent, 'q3');
  const batch3 = [...rig.registry.batches.values()].find((b) => b.questions.has('q3'));
  let resolveCalls = 0;
  const realResolve = batch3.resolve;
  assert.equal(typeof realResolve, 'function', '批上有 resolve 可包计数');
  batch3.resolve = (value) => { resolveCalls += 1; return realResolve(value); };
  const entry3 = timer.armed[timer.armed.length - 1];
  clock.advance(4999);
  assert.equal(resolveCalls, 0, '到期前零 resolve');
  clock.advance(1);
  assert.equal(resolveCalls, 1, '到期恰一次 resolve（包计数——非 Promise 天生单结算）');
  assert.equal(batch3.phase, 'expired', '批 3 转 expired');
  entry3.fn(); // 重复投递同一回调（已 fired 项直发——不经过调度器的去重）
  assert.equal(resolveCalls, 1, '重复投递被已结防御吞掉');
  assert.equal(batch3.phase, 'expired', '重复投递不改批相');
  const answers3 = await pending3;
  assert.equal(answers3.answers[0].selected.length, 0, '批 3 空答合成（兑现观察）');
});

test('E7：客户端组头延长按钮——extend 裸传 {sessionId}、失败面板顶报错、成功立即轮询', async () => {
  const react = makeMiniReact();
  const product = await loadClientProduct(react, {
    setInterval: () => 0,
    clearInterval: () => {}
  });
  // J19 同款骨架：关门构造（跳过构造期首询）→ 开门注入 → 直接渲染 AskList。
  let snap = { status: 'ready', value: {}, user: {} };
  let scopeListener = null;
  const scope = {
    getSnapshot: () => snap,
    subscribe: (fn) => { scopeListener = fn; return () => {}; },
    mutate: async () => true
  };
  const extendCalls = [];
  const stateCalls = [];
  let extendResult = { ok: true, value: { extended: 1 } };
  const remoteNs = {
    state: (...args) => { stateCalls.push(args); return Promise.resolve({ ok: true, value: { serverNow: 10_000, items: [] } }); },
    extend: (...args) => { extendCalls.push(args); return Promise.resolve(extendResult); }
  };
  const ctx = { configForms: { get: () => scope }, remote: {}, uiWorkspace: { openSession() {} } };
  const model = product.createAskModel(ctx, remoteNs);
  snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'overlay' }, user: {} };
  scopeListener();
  const live = model.store.getSnapshot();
  live.items = [
    { batchId: 'B1', sessionId: 's-ext', questionId: 'q1', question: '题目', options: [], multiSelect: false, receivedAt: 0, expiresAt: 90_000, phase: 'open' }
  ];
  const renderComp = (fn) => react.render(fn);

  // ① 组头恰一个「增加等待时间」按钮（类名 + aria-label；暂停/恢复按钮不回潮）。
  const panel = renderComp(() => product.AskList({ ask: model }));
  const group = panel.children.find((child) => child?.props?.className === 'ats-ask-group');
  assert.ok(group !== undefined, '分组渲染在场');
  const head = group.children.find((child) => child?.props?.className === 'ats-ask-grouphead');
  assert.ok(head !== undefined, '组头在场');
  const toggles = head.children.filter((child) => child?.props?.className === 'ats-ask-extend'
    || child?.props?.className === 'ats-ask-pause' || child?.props?.className === 'ats-ask-resume');
  assert.equal(toggles.length, 1, '组头恰一个动作按钮');
  assert.equal(toggles[0].props.className, 'ats-ask-extend', '动作按钮是延长（暂停/恢复已随需求移除）');
  assert.equal(toggles[0].props['aria-label'], product.DICTIONARIES.en['ask.extend'], 'aria-label 同步延长语义（无障碍侧）');

  // ② 点击 → remote.extend({sessionId}) 裸传（位置参数 = 载荷本身）+ 成功立即轮询。
  const stateCallsBefore = stateCalls.length;
  toggles[0].props.onClick();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(extendCalls, [[{ sessionId: 's-ext' }]], 'extend 载荷裸传（组键 sessionId）');
  assert.ok(stateCalls.length > stateCallsBefore, '成功 → 立即补一次轮询（新期限经 serverNow 校准显示）');
  assert.equal(model.store.getSnapshot().callFailed, null, '成功清回无失败态（null，不残留类别旗标）');

  // ③ 失败路径：回执 ok:false → callFailed='extend'（面板顶按类别报错），不假报加时成功。
  extendResult = { ok: false };
  toggles[0].props.onClick();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(model.store.getSnapshot().callFailed, 'extend', "失败 → callFailed='extend'（面板顶报错按类别）");
  const panel2 = renderComp(() => product.AskList({ ask: model }));
  const failedLine = panel2.children.find((child) => child?.props?.className === 'ats-ask-failed');
  assert.ok(failedLine !== undefined, '失败文案渲染在面板顶');
  assert.equal(failedLine.children[0], product.DICTIONARIES.en['ask.extendFailed'], '延长失败用专门文案（不与轮询失败混用）');

  model.dispose();
});

/** E 族快配：makeRegistry 不返回 take 便捷（与旧 K 族直呼 registry.take 同一形状）。 */
function registry_take(rig, agent, questionId) {
  return rig.registry.take(makeRequest(agent, [Q(questionId)]), agent);
}
