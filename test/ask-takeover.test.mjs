/**
 * 提问接管单测（需求 §4 提问接管与待答交互，判据 J1–J24 + E1–E8 + 变异）。
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
import { hostTestFor, loadOfflineSafe } from './_host-gate.mjs';

// 宿主链动态守卫：`lib/ask-takeover.js`（→ `@deepseek-ai/dsh-llm` /
// `@deepseek-ai/dsh-typert-protocol`）与 `lib/host.js`（→ ask-takeover.js）在
// 离线形态缺席——依赖它们的用例自跳过并打印理由（ci.yml offline 作业的契约）；
// 其余用例（纯文本判据、客户端模型装载）离线照常跑。
const askModule = await loadOfflineSafe('../lib/ask-takeover.js');
const hostModule = await loadOfflineSafe('../lib/host.js');
const { AskBatchRegistry, AskTakeoverService, shouldTakeover, readSessionPreset } = askModule ?? {};
const { isPresetBound } = await loadOfflineSafe('../lib/descriptions.js');
const { applyHostHalf } = hostModule ?? {};
const hostTest = await hostTestFor('../lib/ask-takeover.js', '../lib/host.js');

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

hostTest('readSessionPreset＋isPresetBound（F3 范围判定基件，PRESET-BIND-01）：三态读取路径 + 名单匹配 + 失效安全方向＝关', () => {
  // 与 shouldTakeover 判定②同一条读取路径（sessions.get → stateOf('agentPreset')），
  // 供 lib/jobs.js 的 guardPresetFor／组稿纪律复用——三处口径必须一致。
  const scope = (preset, session = { id: 's1' }) => ({
    sessions: { get: (id) => (id === 's1' ? session : undefined) },
    sessionProjections: { stateOf: () => preset }
  });
  assert.equal(readSessionPreset(scope('dsh-async'), 's1'), 'dsh-async', '读得会话实际预设 id');
  assert.equal(readSessionPreset(scope('standard'), 's1'), 'standard', '非本包预设照常读得（匹配交名单）');
  assert.equal(readSessionPreset(scope('dsh-async'), 's-other'), undefined, '会话查无 ⇒ undefined');
  assert.equal(readSessionPreset({}, 's1'), undefined, '服务缺席 ⇒ undefined（失效安全＝关）');
  assert.equal(
    readSessionPreset({ sessions: { get: () => { throw new Error('boom'); } }, sessionProjections: {} }, 's1'),
    undefined, '读取抛错 ⇒ undefined（不把异常泄给诊断路径）'
  );
  // 名单匹配（需求 9.4.1：按会话当前实际预设 ID 匹配）：缺席配置 → 默认两名单；
  // 显式名单决定归属；快照缺席回退默认（boundList 的缺席分支）。
  assert.equal(isPresetBound(undefined, 'dsh-async'), true, '快照缺席 → 默认名单含主预设');
  assert.equal(isPresetBound(undefined, 'rwkv'), false, '快照缺席 → 默认名单不含自建预设');
  assert.equal(isPresetBound({ boundPresets: ['rwkv'] }, 'rwkv'), true, '显式名单匹配自建预设');
  assert.equal(isPresetBound({ boundPresets: ['rwkv'] }, 'dsh-async'), false, '显式名单不再含内置主预设（未选预设天然隔离）');
  assert.equal(isPresetBound({ boundPresets: [] }, 'dsh-async'), false, '空名单＝解除全部绑定');
  assert.equal(isPresetBound({ boundPresets: [] }, 'rwkv'), false, '空名单对任何预设都不匹配');
  assert.equal(isPresetBound({ boundPresets: 'oops' }, 'dsh-async'), true, '非数组名单折回默认（快照在场恒为数组的回退形态）');
});

hostTest('P12（PRESET-BIND-01）：shouldTakeover 按名单匹配——无预设/读取失败不误匹配', () => {
  const agent = fakeAgent();
  // 名单内自建预设（rwkv）→ 接管；名单外预设 → 原生；null/抛错 → 原生（不误匹配）。
  assert.equal(shouldTakeover(
    makeRequest(agent, [Q('q1')]), fakeServices(agent, { preset: 'rwkv' }), { askTakeover: true, boundPresets: ['rwkv'] }
  ).takeover, true, '名单内自建预设 → 接管（无须行声明）');
  for (const preset of ['dsh-standard', 'code-review', null]) {
    assert.equal(shouldTakeover(
      makeRequest(agent, [Q('q1')]), fakeServices(agent, { preset }), { askTakeover: true, boundPresets: ['rwkv'] }
    ).takeover, false, `名单外预设 ${String(preset)} → 原生`);
  }
  assert.equal(shouldTakeover(
    makeRequest(agent, [Q('q1')]), fakeServices(agent, { presetThrows: true }), { askTakeover: true, boundPresets: ['rwkv'] }
  ).takeover, false, '投影读取抛错 → 原生（不猜）');
  // 名单移除内置预设后，内置预设会话交还原生（取消绑定的语义）。
  assert.equal(shouldTakeover(
    makeRequest(agent, [Q('q1')]), fakeServices(agent, { preset: 'dsh-async' }), { askTakeover: true, boundPresets: ['rwkv'] }
  ).takeover, false, '名单不含 dsh-async → 该预设会话走原生');
});

hostTest('P10（PRESET-BIND-01）：绑定名单与 askTakeover 开关正交——名单在、开关关仍零接管', () => {
  const agent = fakeAgent();
  // 名单含会话预设，但总开关关（判定①先于预设判定）→ 原生：名单只定范围，不代替开关。
  assert.equal(shouldTakeover(
    makeRequest(agent, [Q('q1')]), fakeServices(agent, { preset: 'rwkv' }), { askTakeover: false, boundPresets: ['rwkv'] }
  ).takeover, false, '开关关 → 原生（名单不越权开启）');
  assert.equal(shouldTakeover(
    makeRequest(agent, [Q('q1')]), fakeServices(agent, { preset: 'rwkv' }), { boundPresets: ['rwkv'] }
  ).takeover, false, '开关缺席（非字面 true）→ 原生');
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
    selected: [1], custom: '补充说明'
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
  registry.submitAnswer({ batchId: byQ.q1, questionId: 'q1', selected: [0] });
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

  registry.submitAnswer({ batchId: first.batchId, questionId: 'q1', selected: [0] });
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
    registry.submitAnswer({ batchId, questionId: 'q1', selected: [0] }),
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
    registry.submitAnswer({ batchId: items[0].batchId, questionId: 'q1', selected: [1] });
    timer.fire(0);
    const settled = await pending;
    const byId = Object.fromEntries(settled.answers.map((a) => [a.id, a]));
    assert.deepEqual(byId.q1, { id: 'q1', selected: ['选项二'], custom: undefined },
      `${agentLang}：已答题保留用户形状`);
    assert.deepEqual(byId.q2.selected, [], `${agentLang}：open 题 selected 必为空数组（不代答）`);
    assert.equal(byId.q2.id, 'q2', 'id 一一对应');
    assert.equal(byId.q2.custom, t(agentLang, 'ask.timeoutCustom', { seconds: 5 }),
      `${agentLang}：custom = 超时语义句（窗口 5000 ms → seconds=5，词典逐字）`);
    assert.ok(t(agentLang, 'ask.timeoutCustom', { seconds: 5 }).includes(agentLang === 'zh' ? '超过 24 小时' : 'more than 24 hours'),
      `${agentLang}：超时合成答案写明只清超时超过 24 小时的记录（惰性清扫条件，防再省略）`);
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
    selected: [0, 1], custom: '注意顺序'
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
  const expectedSummary = t('zh', 'ask.lateSummary', {
    qid: 'q1',
    answer: '选项一、选项二；自定义回答：注意顺序'
  });
  assert.equal(message.source.summary, expectedSummary, 'summary = 一句话作答摘要（词典模板，含题号；与正文同一组实际答案）');
  assert.equal(message.content[0].type, 'text');
  // 正文自含完整题目内容（用户裁定）：稳定 id / 题干全文 / 选项标签全集 /
  // multiSelect / 作答（已选预设项 + 自定义回答**并列**）/ 时延——逐字段断言，
  // 删任一字段必红；自定义是独立答案条目，不是预设答案的附加说明。
  const expectedAnswer = '选项一、选项二；' + t('zh', 'ask.lateCustomAnswer', { custom: '注意顺序' });
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
  assert.match(text, /\[迟到作答\]/, '锚句在场');
  for (const field of ['q1', '问题文本 q1', '选项一', '选项二', 'multiSelect=true', '注意顺序']) {
    assert.ok(text.includes(field), `自含字段在场：${field}`);
  }
  assert.match(text, /时延/, '时延字段在场（提问时间或时延——需求 §4.4 的时间信息）');
  // 唤醒事件已发（投递被宿主接受之后才发——设计 §4.4 投递次序先于唤醒判定；
  // 载荷细节 J22 专项）。
  assert.equal(emitted.length, 1, '事件恰一次');
  // 同一题二次提交 → gone，不重复注入：
  assert.equal(
    registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: [0] }),
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
  registry2.submitLate({ batchId: items2[0].batchId, questionId: 'q9', kind: 'answer', selected: [0, 1] });
  assert.match(agent2.injectCalls[0].content[0].text, /选项一, 选项二/, 'en 标签以逗号空格相接');
});

hostTest('J24（A10）：选项说明进通知正文——同标签异说明不丢差异；无说明选项不拼空', async () => {
  // 互异标签配不同操作/风险说明：只拼 label 会让「重建/重启」这类近似标签的
  // 真实区别消失（通知自含完整题目，不依赖旧工具调用记忆——用户裁定）。同标签
  // 异说明按联合唯一（产品 2026-11-07 改判）放行，通知保留两条说明不合并。
  const agent = fakeAgent();
  const { registry, timer } = makeRegistry({ agentLang: 'zh' });
  const q = Q('qd', {
    multiSelect: true,
    options: [
      { label: '执行', description: '立即运行，不可撤销' },
      { label: '执行', description: '先出计划，等待批准' },
      { label: '跳过' }
    ]
  });
  const pending = registry.take(makeRequest(agent, [q]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;
  const outcome = registry.submitLate({
    batchId: items[0].batchId, questionId: 'qd', kind: 'answer',
    selected: [0, 2]
  });
  assert.equal(outcome, 'late');
  const message = agent.injectCalls[0];
  const text = message.content[0].text;
  // 两条同标签的说明都在场（丢了任一条就无法区分用户选的是哪种「执行」）。
  assert.ok(text.includes('执行：立即运行，不可撤销'), '说明一在场（zh 冒号连接）');
  assert.ok(text.includes('执行：先出计划，等待批准'), '说明二在场——同标签异说明不合并');
  assert.ok(text.includes('跳过、') || text.includes('跳过\n'), '无说明选项照常拼入（不残留空说明连接符）');
  assert.doesNotMatch(text, /跳过：/, '无 description 的选项不拼「：」');
  assert.ok(text.includes('multiSelect=true'), '多选属性在场');
  // RA-OPTION-IDENTITY：selected=[0,2]（第一个「执行」＋「跳过」）；答案行用
  // 「标签＋说明」复合串逐字对照选项行——同标签差异不靠猜，与 summary 同一组。
  const expectedAnswer = '执行：立即运行，不可撤销、跳过';
  assert.ok(text.includes(expectedAnswer), '答案行复合串定位第一个「执行」（与选项行逐字对照）');
  assert.equal(message.source.summary, t('zh', 'ask.lateSummary', { qid: 'qd', answer: expectedAnswer }),
    'summary 与正文表达同一组实际答案（复合串）');
  assert.match(text, /时延/, '时间信息在场');

  // en 档：说明用 ": " 连接，选项间仍是 ", "。
  const agentEn = fakeAgent('s-en24');
  const { registry: regEn, timer: timEn } = makeRegistry({ agentLang: 'en' });
  const qEn = Q('qe', {
    options: [
      { label: 'Run', description: 'executes immediately' },
      { label: 'Skip' }
    ]
  });
  const pendingEn = regEn.take(makeRequest(agentEn, [qEn]), agentEn);
  const itemsEn = regEn.stateItems().items;
  timEn.fire(0);
  await pendingEn;
  regEn.submitLate({ batchId: itemsEn[0].batchId, questionId: 'qe', kind: 'answer', selected: [0] });
  const textEn = agentEn.injectCalls[0].content[0].text;
  assert.ok(textEn.includes('Run: executes immediately'), 'en 说明用冒号空格连接');
  assert.ok(textEn.includes('Skip,') || textEn.includes('Skip\n'), '无说明选项照常拼入');
  assert.doesNotMatch(textEn, /Skip:/, '无 description 不拼冒号');
});

hostTest('J11-b：空闲且无未领取的本包投递 → followup 恰一次（唤醒开回合，单条也立即）', async () => {
  const agent = fakeAgent('s-idle', { status: 'idle' });
  const { registry, timer } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;

  const outcome = registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: [0] });
  assert.equal(outcome, 'late');
  assert.equal(agent.followupCalls.length, 1, '空闲 → followup 恰一次（立即唤醒）');
  assert.equal(agent.injectCalls.length, 0, '空闲零 inject（不滞留到别人开回合）');
  assert.ok(agent.inbox.nextTurn.includes(agent.followupCalls[0]), '落点 next-turn（自开回合领取）');
  assert.equal(agent.status, 'running', 'followup 已开跑（假 agent 镜像 wakeDriver 同步分支）');
  // 同批第二题此时已"运行中"→ 并入该回合下一领取点（inject）：
  assert.equal(
    registry.submitLate({ batchId: items[0].batchId, questionId: 'q2', kind: 'answer', selected: [0] }),
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
    assert.equal(registry.submitLate({ batchId: items[0].batchId, questionId: qid, kind: 'answer', selected: [0] }), 'late');
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
  assert.equal(registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: [0] }), 'late');
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

hostTest('J12：迟到忽略 → 通知形正文 = ask.lateIgnore 模板；两通道同步抛错 → failed 且题回滚可再投', async () => {
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

  // inject 抛错（运行中通道，agent 引用失效的最坏形态）：审计 + 回滚为 open +
  // failed（ASK-LATE-FAILED-RETRY：未送达的题保持可再投，不伪装成「已有答案」）。
  const broken = fakeAgent('s-broken');
  broken.inject = () => { throw new Error('agent gone'); };
  const pending2 = registry.take(makeRequest(broken, [Q('q3')]), broken);
  // 批 1 的 q2 仍 open——stateItems 混着两批的题，必须按 questionId 寻址。
  const q3Item = registry.stateItems().items.find((item) => item.questionId === 'q3');
  timer.fire(1);
  await pending2;
  assert.equal(
    registry.submitLate({ batchId: q3Item.batchId, questionId: 'q3', kind: 'answer', selected: [0] }),
    'failed', 'inject 失败返回 failed（调用方可上屏重试语义——重试即重新投递，设计 §4.4）'
  );
  assert.ok(
    registry.stateItems().items.some((item) => item.questionId === 'q3'),
    'failed 后 q3 仍 open（回轮询列表——失败不等于出列）'
  );

  // followup 抛错（空闲通道）同样 failed：
  const broken2 = fakeAgent('s-broken2', { status: 'idle' });
  broken2.followup = () => { throw new Error('agent gone idle'); };
  const pending3 = registry.take(makeRequest(broken2, [Q('q4')]), broken2);
  const q4Item = registry.stateItems().items.find((item) => item.questionId === 'q4');
  timer.fire(2);
  await pending3;
  assert.equal(
    registry.submitLate({ batchId: q4Item.batchId, questionId: 'q4', kind: 'answer', selected: [0] }),
    'failed', 'followup 失败返回 failed（设计 §4.4：任一通道同步抛错）'
  );
  assert.ok(
    registry.stateItems().items.some((item) => item.questionId === 'q4'),
    'failed 后 q4 仍 open（两通道同一回滚口径）'
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
    batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: [0, 1]
  });
  assert.equal(outcome, 'late');
  const message = agent.injectCalls[0];
  assert.match(message.content[0].text, /\[迟到作答\]/, '注入语言跟随注入时刻活读（en 批 → zh 注入）');
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
    registryFb.submitLate({ batchId: fbItem.batchId, questionId: 'q7', kind: 'answer', selected: [0] }),
    'late', '活读抛错不丢注入（outcome=late）'
  );
  assert.match(agentFb.injectCalls[0].content[0].text, /\[迟到作答\]/,
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
  const payload = { batchId: 'ask-1-abc', questionId: 'q1', selected: [0], custom: '注' };
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
  const result = await service.answer({ batchId: items[0].batchId, questionId: 'q1', selected: [0] });
  assert.deepEqual(result, { outcome: 'delivered' }, '窗口内作答回执');
  const answers = await pending;
  assert.deepEqual(answers.answers[0].selected, ['选项一'], '服务接口进本批记录');
  const lateResult = await service.answer({ batchId: items[0].batchId, questionId: 'q1', selected: [0] });
  assert.deepEqual(lateResult, { outcome: 'gone', undelivered: true },
    '批次已结清出列 → gone＋undelivered（记录缺席口径，界面显示未送达）');
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

// ── 作答有效性校验（需求 §4.2.4：服务端按原题拒绝非法作答）──────────────────

hostTest('作答有效性校验——非法作答可见拒绝、不记已答、不投递；迟到路径同判', async () => {
  const fakeReflectCtx = { reflect: { provide() {} } };
  const agent = fakeAgent();
  const { registry, timer } = makeRegistry({ agentLang: 'zh' });
  const service = new AskTakeoverService(fakeReflectCtx, registry);
  const pending = registry.take(makeRequest(agent, [Q('q1', { multiSelect: true }), Q('q2')]), agent);
  const batchId = registry.stateItems().items[0].batchId;
  const openOf = () => registry.stateItems().items
    .filter((entry) => entry.batchId === batchId).map((entry) => entry.questionId).sort();

  // 窗口内非法形态（序号校验，RA-OPTION-IDENTITY）：未作答 / 空白自定义 /
  // 未知选项（旧 wire 字符串残留——真实标签的字符串同样不认、非整数、负下标、
  // 越界）/ 单选多项（含重复序号——按原始数组判）/ 单选预设+自定义。
  const bad = [
    { questionId: 'q2', selected: [], custom: undefined },
    { questionId: 'q2', selected: [], custom: '   ' },
    { questionId: 'q2', selected: ['不在选项里'], custom: undefined },
    { questionId: 'q2', selected: ['选项一'], custom: undefined },
    { questionId: 'q2', selected: [0.5], custom: undefined },
    { questionId: 'q2', selected: [-1], custom: undefined },
    { questionId: 'q2', selected: [9], custom: undefined },
    { questionId: 'q2', selected: [0, 1], custom: undefined },
    { questionId: 'q2', selected: [0, 0], custom: undefined },
    { questionId: 'q2', selected: [0], custom: '还要补充' }
  ];
  for (const submission of bad) {
    await assert.rejects(
      () => service.answer({ batchId, ...submission }),
      (error) => error.message.startsWith(t('zh', 'ask.answerRejectedError', { reason: '' })),
      `非法作答可见拒绝：${JSON.stringify(submission)}`);
  }
  assert.deepEqual(openOf(), ['q1', 'q2'], `${bad.length} 次拒绝全部不记已答（两题仍开放）`);
  assert.equal(agent.injectCalls.length + agent.followupCalls.length, 0, '拒绝路径零投递');

  // 合法多选组合放行：已选预设与自定义并列。
  const ok = await service.answer({ batchId, questionId: 'q1', selected: [0, 1], custom: '注意顺序' });
  assert.deepEqual(ok, { outcome: 'delivered' }, '合法组合：窗口内 delivered');
  assert.deepEqual(openOf(), ['q2'], 'q1 落定、q2 仍开放（批次未结清）');

  // gone 两口径（需求 §4.4）：q1 已落定而批次仍在 → 普通 gone（不带 undelivered，
  // 题目已有答案，界面交轮询收敛）。
  const decided = await service.answer({ batchId, questionId: 'q1', selected: [0] });
  assert.deepEqual(decided, { outcome: 'gone' }, '已落定题：普通 gone，不报未送达');

  // 迟到路径同样校验（§4.2.4 不因迟到放松）：到期后空白自定义 → 拒绝、不投递。
  timer.fire(0);
  await pending;
  await assert.rejects(
    () => service.answer({ batchId, questionId: 'q2', selected: [], custom: '  ' }),
    (error) => error.message.includes(t('zh', 'ask.rejectBlankCustom')),
    '迟到路径：空白自定义可见拒绝（原因可读、随 agentLang 两语）');
  assert.equal(agent.injectCalls.length, 0, '非法迟到作答零投递');
  assert.deepEqual(openOf(), ['q2'], '非法迟到作答不记已答（条目仍开放）');

  // 合法迟到单选（仅自定义）：late 投递，自定义是独立答案条目、无预设标签冒充。
  const late = await service.answer({ batchId, questionId: 'q2', selected: [], custom: '改主意了' });
  assert.deepEqual(late, { outcome: 'late' }, '合法迟到作答：late');
  assert.equal(agent.injectCalls.length, 1, '恰一次投递');
  const text = agent.injectCalls[0].content[0].text;
  assert.ok(text.includes('自定义回答：改主意了'), '迟到正文：自定义作独立答案条目');
  assert.ok(!text.includes('选项一；自定义回答'), '无已选预设时不出现预设标签');
  assert.ok(agent.injectCalls[0].source.summary.includes('自定义回答：改主意了'),
    'summary 与正文表达同一组实际答案');

  // 记录缺席（需求 §4.4）：两题落定、批次结清出列后再提交 → gone＋undelivered
  // （区分字段，outcome 枚举不变；界面据此显示未送达）。
  const missing = await service.answer({ batchId, questionId: 'q2', selected: [0] });
  assert.deepEqual(missing, { outcome: 'gone', undelivered: true }, '记录缺席：undelivered 区分字段');
  // 忽略提交同口径（需求 §4.4）：命中缺席批次 → 同 undelivered 区分。
  const missingIgnore = await service.ignore({ batchId, questionId: 'q2' });
  assert.deepEqual(missingIgnore, { outcome: 'gone', undelivered: true }, '忽略命中记录缺席：同口径 undelivered');
});

// ── RA-OPTION-IDENTITY：选项身份与答案表达（题内序号＋冻结副本＋干净判据）──────

hostTest('身份：selected 为题内序号——同标签异说明各自独立；answers 按冻结题映射表达串', async () => {
  // 同标签异说明（en，单选）：两个「Run」按序号各自可选、答案复合串互异。
  const agent = fakeAgent('s-ident');
  const { registry } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1', {
    options: [
      { label: 'Run', description: 'immediately' },
      { label: 'Run', description: 'after a plan' }
    ]
  })]), agent);
  const { items } = registry.stateItems();
  registry.submitAnswer({ batchId: items[0].batchId, questionId: 'q1', selected: [1] });
  const answers = await pending;
  assert.deepEqual(answers.answers[0].selected, ['Run: after a plan'],
    '窗口 answers：重复标签按「标签＋说明」复合串表达（选中的是第二个 Run）');

  // 两批同标签不同说明、同一序号 → answers 表达串互异（映射各自成立）；唯一
  // 标签题答案仍纯标签（无重复标签时与历史逐字节一致——正常题零回归）。
  const agentB = fakeAgent('s-ident2');
  const { registry: regB } = makeRegistry({ agentLang: 'zh' });
  const p1 = regB.take(makeRequest(agentB, [Q('q1', {
    options: [{ label: '执行', description: '先出计划，等待批准' }, { label: '执行', description: '立即执行' }]
  })]), agentB);
  const p2 = regB.take(makeRequest(agentB, [Q('q2', {
    options: [{ label: '执行', description: '先出计划，等待批准' }, { label: '跳过' }]
  })]), agentB);
  const its = regB.stateItems().items;
  regB.submitAnswer({ batchId: its[0].batchId, questionId: 'q1', selected: [0] });
  regB.submitAnswer({ batchId: its[1].batchId, questionId: 'q2', selected: [0] });
  const [a1, a2] = await Promise.all([p1, p2]);
  assert.deepEqual(a1.answers[0].selected, ['执行：先出计划，等待批准'],
    '批一 [0] → 复合串（同标签项）');
  assert.deepEqual(a2.answers[0].selected, ['执行'],
    '批二 [0] → 纯标签（「执行」在批二唯一——不同批次同序号可分辨）');

  // 冻结副本：接管后宿主侧改原载荷不改变映射基准（state 与表达都读接单抄录）。
  const agentC = fakeAgent('s-ident3');
  const { registry: regC, timer: timC } = makeRegistry({ agentLang: 'zh' });
  const req = makeRequest(agentC, [Q('q3', { options: [{ label: '甲' }, { label: '乙' }] })]);
  const pendingC = regC.take(req, agentC);
  req.questions[0].options.push({ label: '丙' });   // 原载荷事后追加
  req.questions[0].options[0] = { label: '掉包' };  // 原载荷事后改写
  const itemC = regC.stateItems().items[0];
  assert.equal(itemC.options.length, 2, 'state 读接单冻结副本（追加不进面板）');
  assert.equal(itemC.options[0].label, '甲', '改写不影响冻结副本（序号基准不漂移）');
  timC.fire(0);
  await pendingC;
  regC.submitLate({ batchId: itemC.batchId, questionId: 'q3', kind: 'answer', selected: [1] });
  assert.ok(agentC.injectCalls[0].content[0].text.includes('乙'),
    '迟到表达按冻结题映射（序号 [1]＝冻结副本的「乙」，不含「掉包/丙」）');
});

hostTest('序号规范化：多选重复/乱序序号首现去重后放行，answers 表达不重复', async () => {
  const agent = fakeAgent('s-norm');
  const { registry } = makeRegistry({ agentLang: 'zh' });
  const pending = registry.take(makeRequest(agent, [Q('q1', { multiSelect: true })]), agent);
  const item = registry.stateItems().items[0];
  registry.submitAnswer({ batchId: item.batchId, questionId: 'q1', selected: [1, 0, 1] });
  const answers = await pending;
  assert.deepEqual(answers.answers[0].selected, ['选项二', '选项一'],
    '首现顺序去重（不排序、不重复；重复序号不产生重复表达串）');
});

hostTest('表达干净判据：任一判据不满足 → 整题 #序号 回退（选项行带同款前缀）；干净题保持现状', async () => {
  // 全部为合法输入（接单不拒）——表达层判据见 ask-takeover.js 的干净判据注释：
  // 标签含任何结构分隔符（含 descSep）、说明含 join/并列/模板前缀/换行回车、
  // 重复标签复合串含模板前缀，任一命中即整题 ordinal。历史攻击（join 歧义、
  // 拼接 customMark、行重复、跨集合同文、前缀切分歧义 F7/F8）逐案在列。
  const attacks = [
    { lang: 'zh', options: [{ label: '甲、乙' }, { label: '甲' }], selected: [1], row: '#2 甲' },
    { lang: 'en', options: [{ label: 'Run' }, { label: 'Yes, do it' }], selected: [0], row: '#1 Run' },
    { lang: 'zh', options: [{ label: '乙' }, { label: '甲', description: '乙、继续' }], selected: [1], row: '#2 甲：乙、继续' },
    { lang: 'zh', options: [{ label: '甲', description: '先备份；再执行' }], selected: [0], row: '#1 甲：先备份；再执行' },
    { lang: 'zh', options: [{ label: '甲', description: '两行\n说明' }], selected: [0], row: '#1 甲：两行' },
    { lang: 'en', options: [{ label: 'Go' }, { label: 'Skip; all' }], selected: [1], row: '#2 Skip; all' },
    { lang: 'zh', options: [{ label: '自定义回答', description: '甲' }, { label: '自定义回答', description: '乙' }], selected: [0], row: '#1 自定义回答：甲' },
    { lang: 'en', options: [{ label: 'Run', description: 'custom answer: now' }], selected: [0], row: '#1 Run: custom answer: now' },
    { lang: 'zh', options: [{ label: '甲', description: '自定义回答：伪装' }], selected: [0], row: '#1 甲：自定义回答：伪装' },
    { lang: 'zh', options: [{ label: '执行：先备份' }, { label: '执行', description: '先备份' }], selected: [0], row: '#1 执行：先备份' },
    { lang: 'zh', options: [{ label: 'A', description: 'B' }, { label: 'A：B', description: 'C' }], selected: [1], row: '#2 A：B：C' },
    { lang: 'en', options: [{ label: 'A: B' }, { label: 'A', description: 'B: C' }], selected: [0], row: '#1 A: B' },
    { lang: 'zh', options: [{ label: '执：行' }, { label: '执', description: '行书' }], selected: [1], row: '#2 执：行书' },
    { lang: 'en', options: [{ label: 'run: backup' }, { label: 'run', description: 'backup plan' }], selected: [1], row: '#2 run: backup plan' }
  ];
  for (const [index, attack] of attacks.entries()) {
    const agent = fakeAgent(`s-ordinal-${index}`);
    const { registry, timer } = makeRegistry({ agentLang: attack.lang });
    const pending = registry.take(
      makeRequest(agent, [Q('q1', { multiSelect: true, options: attack.options })]), agent);
    const item = registry.stateItems().items[0];
    timer.fire(0);
    await pending;
    const outcome = registry.submitLate({
      batchId: item.batchId, questionId: 'q1', kind: 'answer', selected: attack.selected
    });
    assert.equal(outcome, 'late', `attack ${index}：late`);
    const text = agent.injectCalls[0].content[0].text;
    const ordinal = `#${attack.selected[0] + 1}`;
    assert.equal(agent.injectCalls[0].source.summary,
      t(attack.lang, 'ask.lateSummary', { qid: 'q1', answer: ordinal }),
      `attack ${index}：答案行＝纯序号（不含任何标签/说明内容，不同选择集必然互异）`);
    assert.ok(text.includes(attack.row), `attack ${index}：选项行带同款前缀（说明信息不丢）`);
  }

  // 正向对照：说明含 descSep（标签干净）、同标签一空一非空说明——判据放行，
  // 表达保持现状形状（首个 descSep 切分仍唯一还原标签；空说明退化纯标签）。
  const positives = [
    { lang: 'zh', options: [{ label: '执行', description: '风险：不可撤销' }], selected: [0], answer: '执行', row: '执行：风险：不可撤销' },
    { lang: 'en', options: [{ label: 'Proceed', description: 'risk: irreversible' }], selected: [0], answer: 'Proceed', row: 'Proceed: risk: irreversible' },
    { lang: 'zh', options: [{ label: '执行', description: '先备份' }, { label: '执行' }], selected: [1], answer: '执行', row: '执行：先备份' }
  ];
  for (const [index, positive] of positives.entries()) {
    const agent = fakeAgent(`s-content-${index}`);
    const { registry, timer } = makeRegistry({ agentLang: positive.lang });
    const pending = registry.take(
      makeRequest(agent, [Q('q1', { options: positive.options })]), agent);
    const item = registry.stateItems().items[0];
    timer.fire(0);
    await pending;
    const outcome = registry.submitLate({
      batchId: item.batchId, questionId: 'q1', kind: 'answer', selected: positive.selected
    });
    assert.equal(outcome, 'late', `positive ${index}：late`);
    const message = agent.injectCalls[0];
    assert.equal(message.source.summary,
      t(positive.lang, 'ask.lateSummary', { qid: 'q1', answer: positive.answer }),
      `positive ${index}：答案＝${positive.answer}（content 模式，无 #序号）`);
    assert.ok(message.content[0].text.includes(positive.row),
      `positive ${index}：选项行保持现状构造`);
    assert.ok(!message.content[0].text.includes(`#${positive.selected[0] + 1} `),
      `positive ${index}：无序号前缀（干净题零回归）`);
  }
});

// ── 接单入口校验（ASK-DUPLICATE-01 产品决定 + RA-ROBUSTNESS 契约外防御）──────

hostTest('接单入口拒绝——同标签同说明或均无说明整批拒绝并指明重复项；同标签异说明与跨题同标签放行', async () => {
  // ASK-DUPLICATE-01（产品 2026-11-07 改判：label＋description 联合唯一）：
  // 「标签＋说明」完全相同、或标签相同且均无说明的两条选项无法区分，接单即
  // 拒绝整次载荷并说明重复的是哪些（重复项带说明摘要）；同标签异说明放行
  // （通知语义见证 J24）；跨题同标签不跨题拒绝。
  const agent = fakeAgent();
  const dupNoDesc = Q('q1', { options: [{ label: '执行' }, { label: '执行' }, { label: '跳过' }] });
  const { registry, timer } = makeRegistry({ agentLang: 'zh' });
  await assert.rejects(
    registry.take(makeRequest(agent, [dupNoDesc]), agent),
    (error) => error instanceof Error
      && error.message.includes(t('zh', 'ask.rejectDuplicateOptionLabels', { qid: 'q1', labels: '执行' })),
    '同标签且均无说明 → 整批拒绝（重复项只写标签，zh 档词典逐字）'
  );
  assert.equal(registry.batches.size, 0, '拒绝发生在进注册表之前（零批次记录）');
  assert.equal(timer.armed.length, 0, '定时器零武装');
  // 同标签且说明相同 → 同判拒绝，重复项带说明摘要：
  await assert.rejects(
    registry.take(makeRequest(agent, [Q('q2', {
      options: [
        { label: '执行', description: '立即运行，不可撤销' },
        { label: '跳过' },
        { label: '执行', description: '立即运行，不可撤销' }
      ]
    })]), agent),
    (error) => error.message.includes(
      t('zh', 'ask.rejectDuplicateOptionLabels', { qid: 'q2', labels: '执行(立即运行，不可撤销)' })
    ),
    '同标签且说明相同 → 整批拒绝（重复项带说明摘要）'
  );
  // 任一题命中即整批拒绝（第二题重复同样拒）：
  await assert.rejects(
    registry.take(makeRequest(agent, [Q('ok1'), dupNoDesc]), agent),
    () => true,
    '多题载荷中任一题重复 → 整批拒绝'
  );
  // 同标签异说明 → 放行（联合唯一：说明区分真实差别；通知语义见证 J24）：
  const agentTwins = fakeAgent('s-twin-labels');
  const { registry: regTwins } = makeRegistry({ agentLang: 'en' });
  const pendingQ3 = regTwins.take(makeRequest(agentTwins, [Q('q3', {
    options: [
      { label: 'Run', description: 'immediately' },
      { label: 'Run', description: 'after a plan' },
      { label: 'Skip' }
    ]
  })]), agentTwins);
  assert.equal(regTwins.stateItems().items.length, 1, '同标签异说明放行（批次入列）');
  // 标签相同、一条有说明一条无说明：两条不同选项，同样放行：
  const pendingQ4 = regTwins.take(makeRequest(agentTwins, [Q('q4', {
    options: [{ label: 'Go' }, { label: 'Go', description: 'with backup' }]
  })]), agentTwins);
  assert.equal(regTwins.stateItems().items.length, 2, '同标签一有一无说明也放行（不同选项）');
  const twinItems = regTwins.stateItems().items;
  regTwins.submitAnswer({ batchId: twinItems[0].batchId, questionId: 'q3', selected: [0] });
  regTwins.submitAnswer({ batchId: twinItems[1].batchId, questionId: 'q4', selected: [0] });
  await Promise.all([pendingQ3, pendingQ4]);
  // en 档两语齐（均无说明的重复）：
  const agentEn = fakeAgent('s-dup-en');
  const { registry: regEn } = makeRegistry({ agentLang: 'en' });
  await assert.rejects(
    regEn.take(makeRequest(agentEn, [Q('q9', { options: [{ label: 'a' }, { label: 'b' }, { label: 'a' }] })]), agentEn),
    (error) => error.message.includes(t('en', 'ask.rejectDuplicateOptionLabels', { qid: 'q9', labels: 'a' })),
    'en 档拒绝文案 = 词典逐字'
  );
  // 跨题同标签不拒绝（唯一性只按题内判定）：
  const agentOk = fakeAgent('s-cross');
  const { registry: regOk } = makeRegistry({ agentLang: 'en' });
  const pending = regOk.take(makeRequest(agentOk, [
    Q('q1', { options: [{ label: '继续' }, { label: '停止' }] }),
    Q('q2', { options: [{ label: '继续' }, { label: '取消' }] })
  ]), agentOk);
  assert.equal(regOk.stateItems().items.length, 2, '跨题同标签不受影响（两题都入列）');
  const { items } = regOk.stateItems();
  regOk.submitAnswer({ batchId: items[0].batchId, questionId: 'q1', selected: [0] });
  regOk.submitAnswer({ batchId: items[0].batchId, questionId: 'q2', selected: [1] });
  const settled = await pending;
  assert.equal(settled.answers.length, 2, '合法路径齐答结清（不回归）');
});

hostTest('接单入口防御——契约外非数组 questions 可读拒绝而非 TypeError（RA-ROBUSTNESS）', async () => {
  const agent = fakeAgent();
  // 前置：判定序把非数组 questions 按「无题」放行（③ 强转空集不命中），接管
  // 可达——宿主契约恒数组、没有合法反例，防线只能在 take 的接单入口，纯防御。
  const { registry, timer } = makeRegistry({ agentLang: 'zh' });
  for (const bad of [undefined, 'oops', { 0: Q('q1') }]) {
    await assert.rejects(
      registry.take(makeRequest(agent, bad), agent),
      (error) => error instanceof Error
        && !(error instanceof TypeError)
        && error.message.includes(t('zh', 'ask.rejectQuestionsShape')),
      `契约外 questions=${JSON.stringify(bad) ?? 'undefined'} → 可读拒绝（非 TypeError）`
    );
  }
  assert.equal(registry.batches.size, 0, '零批次登记');
  assert.equal(timer.armed.length, 0, '定时器零武装');
  assert.equal(registry.seq, 0, '批次序号未消耗（拒绝在任何登记之前）');
});

hostTest('忽略入口题级缺席（ASK-IGNORE-MISSING）——批次在册而题号不在批内 → gone＋undelivered（与作答一致）；真实题号不回归', async () => {
  const fakeReflectCtx = { reflect: { provide() {} } };
  const agent = fakeAgent();
  const { registry, timer } = makeRegistry();
  const service = new AskTakeoverService(fakeReflectCtx, registry);
  const pending = registry.take(makeRequest(agent, [Q('q1'), Q('q2')]), agent);
  const { items } = registry.stateItems();
  const batchId = items[0].batchId;

  // 批次在册、题号不在批内：与作答入口 validateAnswer 的 'missing' 同口径，
  // 不把不明送达状态写成成功。
  assert.deepEqual(
    await service.ignore({ batchId, questionId: 'nope' }),
    { outcome: 'gone', undelivered: true },
    '批次在册而题号不在批内 → gone＋undelivered'
  );
  assert.deepEqual(
    await service.answer({ batchId, questionId: 'nope', selected: [0] }),
    { outcome: 'gone', undelivered: true },
    '作答入口同载荷同口径（既有行为对照）'
  );

  // 正常客户端从 state() 取真实题号：忽略照常 delivered；已落定题普通 gone。
  assert.deepEqual(
    await service.ignore({ batchId, questionId: 'q1' }),
    { outcome: 'delivered' },
    '真实题号忽略 → delivered（正常路径不回归）'
  );
  assert.deepEqual(
    await service.ignore({ batchId, questionId: 'q1' }),
    { outcome: 'gone' },
    '已落定题 → 普通 gone（不带 undelivered，交轮询收敛）'
  );

  // 批次缺席（清扫/结清出列/交还）保持既有未送达回执：
  assert.deepEqual(
    await service.ignore({ batchId: 'ask-9-none', questionId: 'q1' }),
    { outcome: 'gone', undelivered: true },
    '批次缺席 → undelivered（既有）'
  );

  // expired 批上：错误题号同样题级缺席；真实题号照常迟到注入。
  timer.fire(0);
  await pending;
  assert.deepEqual(
    await service.ignore({ batchId, questionId: 'nope' }),
    { outcome: 'gone', undelivered: true },
    'expired 批上错误题号 → undelivered（与作答一致，原实现只回普通 gone）'
  );
  assert.deepEqual(
    await service.ignore({ batchId, questionId: 'q2' }),
    { outcome: 'late' },
    'expired 批上真实题号 → 迟到注入不受影响'
  );
  assert.equal(agent.injectCalls.length, 1, '恰一次迟到投递');
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
  registry.submitAnswer({ batchId: items[0].batchId, questionId: 'q2', selected: [0] });
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
    model.actions.answer(item, [0], '注', (ok) => { doneFlag = ok; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(remoteCalls.answer.length, 1, 'answer 恰一次');
    assert.deepEqual(remoteCalls.answer[0], [{ batchId: 'ask-1-x', questionId: 'q1', selected: [0], custom: '注' }],
      '载荷裸传（位置参数 = 载荷本身，无 {submission:…} 包裹）');
    assert.equal(doneFlag, true, 'delivered → onDone(true)');

    // ④ 失败路径：outcome:'failed' → onDone(false) + lostAnswers 记名。
    answerResult = { ok: true, value: { outcome: 'failed' } };
    let doneFlag2 = null;
    model.actions.answer(item, [0], undefined, (ok) => { doneFlag2 = ok; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(doneFlag2, false, 'failed → onDone(false)（不冒充成功）');
    assert.deepEqual(model.store.getSnapshot().lostAnswers,
      [{ batchId: 'ask-1-x', questionId: 'q1', question: '题目', sessionId: 's1' }],
      '没送达的迟到答案记名进 lostAnswers（面板报错名单；携带所属会话 id 供「打开会话直接回复」的恢复入口）');
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
      [{ batchId: 'ask-2-y', questionId: 'q1', question: '题目', sessionId: 's1' }], '消除指定条');
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

test('J23（失败三分）：明确拒绝 ≠ 未收到确认；延长失败先复查真期限；读取恢复清错', async () => {
  const react = makeMiniReact();
  const intervals = [];
  const product = await loadClientProduct(react, {
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {}
  });
  const snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'overlay' }, user: {} };
  const scope = { getSnapshot: () => snap, subscribe: () => () => {}, mutate: async () => true };
  let stateResult = { ok: true, value: { serverNow: 10_000, items: [] } };
  let stateCalls = 0;
  let answerMode = 'ok';
  let ignoreMode = 'ok';
  let extendMode = 'ok';
  const remoteNs = {
    state: () => { stateCalls += 1; return Promise.resolve(stateResult); },
    answer: () => answerMode === 'reject'
      ? Promise.reject(new Error('response lost'))
      : answerMode === 'refuse' ? Promise.resolve({ ok: false })
      : answerMode === 'refuseReason' ? Promise.resolve({
        ok: false, error: { code: 'gateway/internal', message: '[async-tools] 作答被拒：未作答', details: {} }
      })
      : answerMode === 'goneMissing' ? Promise.resolve({ ok: true, value: { outcome: 'gone', undelivered: true } })
      : answerMode === 'goneDecided' ? Promise.resolve({ ok: true, value: { outcome: 'gone' } })
      : Promise.resolve({ ok: true, value: { outcome: 'delivered' } }),
    ignore: () => Promise.resolve(ignoreMode === 'goneMissing'
      ? { ok: true, value: { outcome: 'gone', undelivered: true } }
      : { ok: true, value: { outcome: 'delivered' } }),
    extend: () => extendMode === 'reject'
      ? Promise.reject(new Error('response lost'))
      : Promise.resolve(extendMode === 'refuse' ? { ok: false } : { ok: true, value: { extended: 1 } })
  };
  const ctx = { configForms: { get: () => scope }, uiWorkspace: { openSession() {} } };
  const model = product.createAskModel(ctx, remoteNs);
  stateResult = { ok: true, value: { serverNow: 10_000, items: [{
    batchId: 'ask-3-a', sessionId: 's1', questionId: 'q3', question: '题目',
    options: [{ label: 'a' }], multiSelect: false, receivedAt: 0, expiresAt: 20_000, phase: 'open'
  }] } };
  await intervals[0].fn();
  await Promise.resolve();
  await Promise.resolve();
  const item = model.store.getSnapshot().items[0];

  // ① RPC 拒绝（服务端可能已执行、只是响应丢失）→ 'submit'：不断定"未送达"。
  answerMode = 'reject';
  let done = null;
  model.actions.answer(item, ['a'], undefined, (ok) => { done = ok; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(model.store.getSnapshot().callFailed, 'submit', 'RPC 拒绝＝没有确认');

  // ② 宿主明确拒绝（ok:false，请求已送达）→ 'answerRejected'，与 ① 分开。
  answerMode = 'refuse';
  model.actions.answer(item, ['a'], undefined, (ok) => { done = ok; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(model.store.getSnapshot().callFailed, 'answerRejected', '明确拒绝有专属旗标');
  assert.equal(model.store.getSnapshot().answerRejectReason, null, '回执无 error 字段 → 不猜因（null）');

  // ③ 读取恢复：成功轮询刷新面板（真实状态收敛不确定态），动作旗标不闪没；
  //    下一次同动作成功才清除。
  answerMode = 'ok';
  await intervals[0].fn();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(model.store.getSnapshot().callFailed, 'answerRejected', '复查轮询不把动作旗标闪没（报错要能被看到）');
  model.actions.answer(item, ['a'], undefined, (ok) => { done = ok; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, true);
  assert.equal(model.store.getSnapshot().callFailed, null, '同动作成功后清除失败旗标');

  // ③b 跨动作不牵连：提交被明确拒绝（answerRejected 挂起）→ 无关的延长成功
  //     不得抹掉提交族报错；随后同动作成功才清除（旗标族分歧的回归锚）。
  answerMode = 'refuse';
  model.actions.answer(item, ['a'], undefined, (ok) => { done = ok; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(model.store.getSnapshot().callFailed, 'answerRejected', '前置：提交族报错在场');
  extendMode = 'ok';
  model.actions.extendSession('s1', () => {});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(model.store.getSnapshot().callFailed, 'answerRejected',
    '延长成功只清延长族——提交失败的重试提示不得被无关动作的成功抹掉');
  answerMode = 'ok';
  model.actions.answer(item, ['a'], undefined, (ok) => { done = ok; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, true);
  assert.equal(model.store.getSnapshot().callFailed, null, '同动作（提交族）成功后清除');

  // ③c gone 两口径（需求 §4.4）：他处已落定的普通 gone 不记名（题目已有答案，
  //     交轮询收敛）；记录缺席（undelivered:true）→ 未送达名单——可消除、轮询
  //     不清、成功不清（逐条事实，与 lostAnswers 同款）。
  answerMode = 'goneDecided';
  model.actions.answer(item, ['a'], undefined, (ok) => { done = ok; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(model.store.getSnapshot().undelivered.length, 0,
    '他处已落定的普通 gone 不报未送达（收敛交轮询，不记名）');
  answerMode = 'goneMissing';
  model.actions.answer(item, ['a'], undefined, (ok) => { done = ok; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, false);
  assert.deepEqual(model.store.getSnapshot().undelivered,
    [{ batchId: 'ask-3-a', questionId: 'q3', question: '题目' }],
    '记录缺席的 gone：未送达名单逐字记入（复合键）');
  // 轮询清空 items（记录不在，state() 不再列出）——未送达名单必须保留：
  // 座位渲染条件（askHasFace）计名单，报错不能随条目清空闪没（需求 §4.4 判据）。
  stateResult = { ok: true, value: { serverNow: 12_000, items: [], lost: [] } };
  await intervals[0].fn();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(model.store.getSnapshot().items.length, 0, '前置：轮询已清空条目');
  assert.equal(model.store.getSnapshot().undelivered.length, 1, '轮询不清未送达名单');
  // 成功不清名单（未读失败不算处理完）——只有「知道了」手动消除。
  answerMode = 'ok';
  model.actions.answer(item, ['a'], undefined, (ok) => { done = ok; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, true);
  assert.equal(model.store.getSnapshot().undelivered.length, 1, '提交成功不清未送达名单');
  model.actions.dismissUndelivered('ask-3-a', 'q3');
  assert.equal(model.store.getSnapshot().undelivered.length, 0, '「知道了」消除收走该条');

  // ③d 忽略提交同口径（需求 §4.4）：记录缺席的忽略 → 同一未送达名单；
  //     消除后再提交同题会重新记入（新尝试、新的未送达事实）。
  ignoreMode = 'goneMissing';
  model.actions.ignore(item, (ok) => { done = ok; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(model.store.getSnapshot().undelivered.length, 1, '忽略命中记录缺席：未送达名单（与作答同口径）');
  ignoreMode = 'ok';
  model.actions.ignore(item, (ok) => { done = ok; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, true);
  assert.equal(model.store.getSnapshot().undelivered.length, 1, '忽略成功同样不清名单');
  model.actions.dismissUndelivered('ask-3-a', 'q3');
  assert.equal(model.store.getSnapshot().undelivered.length, 0, '手动消除后归零');

  // ③e 拒绝原因透传：回执 error 是 gateway rpcFailure 对象（{code,message,
  //     details}，voice-input 同款读法）——message 携带服务端拒绝原因（随
  //     agentLang）→ answerRejectReason 原样展示；message 缺席 → null（不猜因）；
  //     成功清除。
  answerMode = 'refuseReason';
  model.actions.answer(item, ['a'], undefined, (ok) => { done = ok; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(model.store.getSnapshot().callFailed, 'answerRejected', '明确拒绝档旗标');
  assert.equal(model.store.getSnapshot().answerRejectReason, '[async-tools] 作答被拒：未作答',
    '回执 error 原因串透传（不预判原因）');
  answerMode = 'ok';
  model.actions.answer(item, ['a'], undefined, (ok) => { done = ok; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, true);
  assert.equal(model.store.getSnapshot().answerRejectReason, null, '成功清除拒绝原因串');
  assert.equal(model.store.getSnapshot().callFailed, null, '成功清除拒绝旗标');

  // ④ 延长三分：RPC 拒绝 → 'extend' 且立即 poll() 复查真期限（state 再被调）。
  const stateCallsBefore = stateCalls;
  extendMode = 'reject';
  model.actions.extendSession('s1', () => {});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(model.store.getSnapshot().callFailed, 'extend');
  assert.ok(stateCalls > stateCallsBefore, '延长失败路径必须补一次轮询（重试前核对真实期限）');

  // ⑤ 宿主明确拒绝延长（ok:false）→ 'extendRejected'，同样补轮询。
  await intervals[0].fn();
  await Promise.resolve();
  await Promise.resolve();
  const stateCallsBefore2 = stateCalls;
  extendMode = 'refuse';
  model.actions.extendSession('s1', () => {});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(model.store.getSnapshot().callFailed, 'extendRejected', '延长明确拒绝专属旗标');
  assert.ok(stateCalls > stateCallsBefore2, '明确拒绝后同样复查真期限');

  // ⑥ 重复操作语义保持：再次成功延长照常累加（不伪幂等）——回执 {extended:n} 透传。
  extendMode = 'ok';
  let extended = null;
  model.actions.extendSession('s1', (ok) => { extended = ok; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(extended, true, '重复点击仍真实请求（累计行为在服务端，客户端不拦截）');

  // ⑦ 中英文提示三分措辞：未确认档不得断定"未送达"；明确拒绝档说"没有生效"；
  //    延长未确认档提示"每次点击都会累加"（重试指引诚实）。
  const zh = product.DICTIONARIES.zh, en = product.DICTIONARIES.en;
  assert.match(zh['ask.callFailed'], /可能已送达，也可能没有/, 'zh 未确认档：不确定执行与否');
  assert.match(en['ask.callFailed'], /may or may not have arrived/, 'en 未确认档同');
  assert.doesNotMatch(zh['ask.callFailed'], /没有送达/, 'zh 未确认档不得断定未送达');
  assert.match(zh['ask.answerRejected'], /明确拒绝[\s\S]*没有生效/, 'zh 明确拒绝档：可断定未执行');
  assert.match(en['ask.answerRejected'], /explicitly refused[\s\S]*did not take effect/, 'en 明确拒绝档同');
  assert.doesNotMatch(zh['ask.answerRejected'], /内容无效|状态已变/, 'zh 明确拒绝档：静态文案不预判原因（原因由回执 error 透传）');
  assert.doesNotMatch(en['ask.answerRejected'], /invalid|state changed/, 'en 明确拒绝档同');
  assert.match(zh['ask.undelivered'], /未送达[\s\S]*未被接受/, 'zh 未送达档：直说未送达且不称已接受');
  assert.match(zh['ask.undelivered'], /在所属会话中直接回复/, 'zh 未送达档：带可行的下一步（需求 §5.7.2）');
  assert.match(en['ask.undelivered'], /Not delivered[\s\S]*not accepted/, 'en 未送达档同');
  assert.match(en['ask.undelivered'], /reply directly in the session/, 'en 未送达档：下一步同');
  assert.match(zh['ask.extendFailed'], /可能已生效，也可能没有/, 'zh 延长未确认：不确定执行与否');
  assert.match(zh['ask.extendFailed'], /每次点击都会累加/, 'zh 延长未确认：累加语义诚实（不伪幂等）');
  assert.match(en['ask.extendFailed'], /each click adds up/, 'en 同');
  assert.match(zh['ask.extendRejected'], /明确拒绝[\s\S]*没有生效/, 'zh 延长明确拒绝档');
  assert.match(en['ask.extendRejected'], /explicitly refused[\s\S]*did not take effect/, 'en 延长明确拒绝档');
  assert.match(zh['ask.extendRejected'], /面板自动刷新/, 'zh 延长明确拒绝档：带面板自刷新出路（三要素齐全）');
  assert.match(en['ask.extendRejected'], /refreshes automatically/, 'en 延长明确拒绝档：自刷新出路同');
  model.dispose();
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
  // （重新）开启即发起首查：remote 按 L1543 同款回 {ok:false}——callFailed
  // 不影响座位准入，也不覆盖手工塞的 items。
  const model = product.createAskModel(ctx, { state: async () => ({ ok: false }) });
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
  // 徽标＝紧凑图标＋计数（VIS-BADGE-01：底栏窄图标槽不再放文字标签）；完整
  // 名称走 aria-label（无障碍树恒可得，不依赖悬停），可见全名在面板标题行。
  const badgeButton = badgeNode.children.find((child) => child !== null && typeof child === 'object');
  assert.ok(String(badgeButton.props['aria-label']).includes(product.DICTIONARIES.en['ask.title']),
    '徽标 aria-label = 词典标题（auto 档回退 en）');
  const badgeIcon = badgeButton.children.find((child) => child?.type === 'svg');
  assert.ok(badgeIcon !== undefined && badgeIcon.props['aria-hidden'] === 'true',
    '紧凑图标在场且对辅助技术隐藏（名称由 aria-label 承载）');
  const badgeCount = badgeButton.children.find((child) => child?.props?.className === 'ats-ask-count');
  assert.ok(badgeCount !== undefined && String(badgeCount.children).includes('1'),
    '紧凑计数在场（1 条未处理）');
  assert.equal(badgeButton.props['aria-expanded'], 'false', '开合态经 aria-expanded 同步');
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
  assert.ok(String(zhBadgeButton.props['aria-label']).includes(product.DICTIONARIES.zh['ask.title']),
    '徽标 auto + 宿主 zh → zh 词典（侧栏座位翻译器传 ask.locale）');

  // ⑤  渲染条件：条目全部出列、只剩未消除的 lostAnswers → 两座位**仍渲染**
  // （报错必须被人看到；条件只看计数的话单题批次的报错名单永不显示）。
  snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'overlay' }, user: {} };
  scopeListener();
  const live = model.store.getSnapshot();
  live.items = [];
  live.lostAnswers = [{ batchId: 'b', questionId: 'q1', question: 'q', sessionId: 's-lost' }];
  const lostOnly = renderComp(() => product.AskOverlaySeat(seatProps));
  assert.ok(lostOnly !== null, '只剩 lostAnswers 时 overlay 座位不消隐');
  const lostPanel = renderComp(() => product.AskList({ ask: model }));
  const lostLine = lostPanel.children.find((child) => child?.props?.className === 'ats-ask-failed');
  assert.ok(lostLine !== undefined, '报错名单渲染在面板顶');
  // 恢复入口（需求 §4.4 失败提示的可行下一步）：所属会话 id 在场时报错行带
  // 「打开会话」按钮（题已出列，出路＝去所属会话直接回复）；缺席时不带。
  const jumpBtn = lostLine.children.find((child) => child?.props?.className === 'ats-ask-jump');
  assert.ok(jumpBtn !== undefined, '会话 id 在场的丢失条目带「打开会话」恢复按钮');
  assert.ok(typeof jumpBtn.props.onClick === 'function', 'jump 按钮 onClick 是函数');
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
  const noJumpPanel = renderComp(() => product.AskList({ ask: model }));
  const noJumpLine = noJumpPanel.children.find((child) => child?.props?.className === 'ats-ask-failed');
  assert.ok(noJumpLine.children.find((child) => child?.props?.className === 'ats-ask-jump') === undefined,
    '会话 id 缺席的丢失条目不带跳转按钮（无从跳转，不摆空入口）');
  // ⑤b 未送达名单计入同一渲染条件（需求 §4.4 判据）：记录缺席的提交后条目随
  //     轮询清空，只剩 undelivered 名单 → 座位仍渲染、条目在场、可消除、消除完消隐。
  //     （回归锚：纯旗标方案在此形态闪现即逝——变异 askHasFace 不计名单、或
  //     未送达渲染行丢失，此处必红。）
  snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'overlay' }, user: {} };
  scopeListener();
  const liveUnd = model.store.getSnapshot();
  liveUnd.items = [];
  liveUnd.lostAnswers = [];
  liveUnd.undelivered = [{ batchId: 'b', questionId: 'q9', question: 'q' }];
  assert.ok(renderComp(() => product.AskOverlaySeat(seatProps)) !== null,
    '只剩未送达名单时 overlay 座位不消隐（记录缺席后条目已清空的最常见形态）');
  const undPanel = renderComp(() => product.AskList({ ask: model }));
  const undLine = undPanel.children.find((child) => child?.props?.className === 'ats-ask-failed');
  assert.ok(undLine !== undefined, '未送达条渲染在面板顶（带题目标识）');
  const undDismiss = undLine.children.find((child) => child?.props?.className === 'ats-ask-dismiss');
  assert.ok(undDismiss !== undefined, '未送达条带「知道了」消除按钮（与报错名单同款）');
  undDismiss.props.onClick();
  assert.equal(model.store.getSnapshot().undelivered.length, 0, '点击消除收走该条');
  assert.equal(renderComp(() => product.AskOverlaySeat(seatProps)), null, '消除完 → 座位回到消隐口径');
  model.dispose();
});

test('AskItem 作答选择与提交（需求 §4.2.1–§4.2.4）——单选互斥、多选组合、草稿排除与两侧有效性', async () => {
  const react = makeMiniReact();
  const product = await loadClientProduct(react, { setInterval: () => 0, clearInterval: () => {} });
  const t = (key) => key;
  const submitted = [];
  const ask = {
    actions: {
      answer(item, selected, custom, onDone) {
        submitted.push({ selected, custom });
        if (typeof onDone === 'function') onDone();
      },
      ignore() {}, jump() {}, dismissLost() {}
    },
    store: null
  };
  const base = { batchId: 'b', sessionId: 's', question: 'q', receivedAt: 0,
    expiresAt: Date.now() + 60000, phase: 'open' };
  const opts = () => react.__lastTree.children.find((c) => c?.props?.className === 'ats-ask-opts').children;
  const optionStates = () => opts().filter((n) => n?.type === 'button' && n?.props?.role !== undefined)
    .map((n) => n.props['aria-checked'] === 'true');
  const customCtl = () => opts()[opts().length - 1].children[0];
  const customInput = () => opts()[opts().length - 1].children[1];
  const row = () => react.__lastTree.children.find((c) => c?.props?.className === 'ats-ask-row');
  const submitBtn = () => row().children[0];
  const reason = () => react.__lastTree.children.find((c) => c?.props?.className === 'ats-ask-reason');

  // ── 单选（multiSelect 缺省 false）────────────────────────────────────────
  const single = { ...base, questionId: 'q1', multiSelect: false,
    options: [{ label: 'a' }, { label: 'b' }] };
  react.render(() => product.AskItem({ item: single, t, ask, serverNow: 0, fetchedAt: 0 }));
  assert.deepEqual(optionStates(), [false, false], '初始无选择（不默认选推荐项）');
  assert.equal(submitBtn().props.disabled, true, '无选择禁用提交（就近说明在场）');
  assert.equal(reason()?.children[0], 'ask.needAnswer', '就近说明：需要选择答案');
  assert.notEqual(row().children[1].props.disabled, true, '忽略不受有效性限制（独立于作答）');
  opts()[0].props.onClick();
  assert.deepEqual(optionStates(), [true, false], '单选：点 a 只选 a');
  assert.equal(submitBtn().props.disabled, false, '有选择可提交');
  opts()[1].props.onClick();
  assert.deepEqual(optionStates(), [false, true], '单选：点 b **替换**为 b（回退成恒 toggle 时这里会是 [true,true]→红）');
  opts()[1].props.onClick();
  assert.deepEqual(optionStates(), [false, true], '单选：重复点 b 保持 b（替换语义，非 toggle）');

  // 单选与自定义互斥（§4.2.1）：输入文本选中自定义 → 预设弹回；草稿保留。
  customInput().props.onChange({ target: { value: '我的答案' } });
  assert.equal(customCtl().props['aria-checked'], 'true', '输入非空白文本选中自定义项');
  assert.deepEqual(optionStates(), [false, false], '单选：自定义与预设互斥（b 弹回）');
  assert.equal(customInput().props.value, '我的答案', '草稿随组件保存');
  customCtl().props.onClick();
  assert.equal(customCtl().props['aria-checked'], 'false', '选择控件取消自定义选择');
  assert.equal(customInput().props.value, '我的答案', '取消选择不清草稿');
  assert.equal(submitBtn().props.disabled, true, '回到无选择：禁用提交');
  customInput().props.onClick();
  assert.equal(customCtl().props['aria-checked'], 'true', '再次点击输入框重新选中');
  assert.equal(customInput().props.onFocus, undefined, '键盘焦点移动不改选择（无 onFocus 选择副作用）');

  // 清空已选自定义文本（§4.2.2）：保持选中、禁用提交、不恢复旧预设。
  customInput().props.onChange({ target: { value: '' } });
  assert.equal(customCtl().props['aria-checked'], 'true', '清空文本保持自定义选中');
  assert.deepEqual(optionStates(), [false, false], '不自动恢复预设选择');
  assert.equal(submitBtn().props.disabled, true, '选中的自定义空白：禁用提交');
  assert.equal(reason()?.children[0], 'ask.needCustom', '就近说明换档：自定义空白');
  // 多行输入（§4.2.2）：Enter 是换行、不是提交快捷键（提交走按钮）；输入法
  // 组合期确认不误提交由 textarea/IME 默认行为承担。无效状态下提交仍被禁。
  assert.equal(customInput().props.onKeyDown, undefined, 'Enter 不再绑定为提交快捷键（换行语义）');
  assert.equal(submitted.length, 0, '空白自定义：不可提交');
  // 填回文本：载荷只含自定义原文（空白检查不改写用户文本）。
  customInput().props.onChange({ target: { value: ' 前后空白 ' } });
  submitBtn().props.onClick();
  assert.deepEqual(submitted[submitted.length - 1], { selected: [], custom: ' 前后空白 ' },
    '按钮提交：自定义原文照发（未选中草稿不存在）');

  // 草稿排除（§4.2.2）：取消自定义、改选预设 a → 未选中草稿不进载荷。
  customCtl().props.onClick();
  opts()[0].props.onClick();
  submitBtn().props.onClick();
  assert.deepEqual(submitted[submitted.length - 1], { selected: [0], custom: undefined },
    '未选中的自定义草稿不进提交载荷');

  // ── 多选（multiSelect=true）─────────────────────────────────────────────
  const multi = { ...base, questionId: 'q2', multiSelect: true,
    options: [{ label: 'a' }, { label: 'b' }] };
  react.render(() => product.AskItem({ item: multi, t, ask, serverNow: 0, fetchedAt: 0 }));
  opts()[0].props.onClick();
  opts()[1].props.onClick();
  assert.deepEqual(optionStates(), [true, true], '多选：a、b 叠加');
  opts()[0].props.onClick();
  assert.deepEqual(optionStates(), [false, true], '多选：a 弹回、b 保留');
  // 多选空白自定义不被预设掩盖（§4.2.4）。
  customInput().props.onChange({ target: { value: 'x' } });
  assert.equal(customCtl().props['aria-checked'], 'true', '多选：自定义独立选中');
  assert.deepEqual(optionStates(), [false, true], '多选：自定义选中不清预设');
  customInput().props.onChange({ target: { value: ' ' } });
  assert.equal(submitBtn().props.disabled, true, '多选：空白自定义仍禁用提交（已选预设不能掩盖）');
  assert.equal(reason()?.children[0], 'ask.needCustom', '就近说明指向自定义空白');
  customInput().props.onChange({ target: { value: '又一条' } });
  assert.equal(submitBtn().props.disabled, false, '填回有效文本可提交');
  submitBtn().props.onClick();
  assert.deepEqual(submitted[submitted.length - 1], { selected: [1], custom: '又一条' },
    '多选组合载荷：已选预设与自定义并列');

  // ── 无预设项（§4.2.1：没有预设项时同样可自定义作答）────────────────────
  const free = { ...base, questionId: 'q3', multiSelect: false, options: [] };
  react.render(() => product.AskItem({ item: free, t, ask, serverNow: 0, fetchedAt: 0 }));
  assert.equal(opts().length, 1, '无预设项：只渲染自定义项');
  assert.equal(submitBtn().props.disabled, true, '初始无选择禁用提交');
  customInput().props.onClick();
  customInput().props.onChange({ target: { value: '自由作答' } });
  submitBtn().props.onClick();
  assert.deepEqual(submitted[submitted.length - 1], { selected: [], custom: '自由作答' },
    '无预设项：仅自定义作答');
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
  // 假 window：捕获 AskItem 挂的本地秒级定时器（1 s 间隔），与模型层轮询间隔无关。
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
      const row = react.__lastTree.children.find((child) => child?.props?.className === 'ats-ask-row');
      const span = row.children.find((child) => child?.props?.className === 'ats-ask-left');
      return String(span.children);
    };
    assert.match(leftSeconds(), /60 s/, '初始读数 60 s');
    // 「轮询挂起」模拟：之后**只有**本地秒级定时器驱动重渲（无任何 store notify / poll 返回）。
    const tick = localTicks.find((entry) => entry.ms === 1000);
    assert.ok(tick !== undefined, 'AskItem 挂本地秒级定时器（1000 ms）');
    fakeNow += 1000; tick.fn();
    assert.match(leftSeconds(), /59 s/, '+1 s：读数走秒（本地定时器驱动倒计时刷新）');
    fakeNow += 4000; tick.fn();
    assert.match(leftSeconds(), /55 s/, '+5 s 累计：继续走');
    // 出窗：读数翻「已超时」同样由本地定时器驱动（键名即 t 的回显）。
    fakeNow += 60000; tick.fn();
    assert.match(leftSeconds(), /ask\.expired/, '越过期限后本地定时器也能翻到超时态');
    // 卸载清理：重渲染同组件不重复挂定时器（run-once effect）；清理函数在位。
    const disposers = react.__lastTree; // 树本身不含 disposer——清理走 effect 槽
    assert.equal(localTicks.filter((entry) => entry.ms === 1000).length, 1, '本地秒级定时器只挂一次');
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
  // 预设目录服务的替身（apply 的动态 inject 会取 remote.agentPresets）：
  // 空目录即可——本用例只锚 seats 的 label 闭包。
  const fakeAgentPresets = { list: () => Promise.resolve({ ok: true, value: { presets: [] } }) };
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
    // 拿命名空间代理（自 mount 的 ns 不能直接读 ctx.remote[ns]）；预设目录
    // 服务（remote.agentPresets）经同一动态 inject 形态注入。
    inject: (list, fn) => fn({ remote: { 'async-tools-ask': askRemoteNs, agentPresets: fakeAgentPresets } }),
    locale: { register: () => () => {} },
    // $on/on 是目录变更通知的宿主接口（settings/document-updated、connection/reset）。
    remote: { $mount: () => Promise.resolve(() => {}), $on: () => () => {} },
    on: () => () => {},
    effect: (fn) => { const off = fn(); return () => off?.(); },
    uiWorkspace: { openSession() {} }
  };
  product.apply(ctx);
  // seats 在 $mount promise 的微任务之后才装（真机同款顺序）——冲两轮微任务。
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

hostTest('J22-①：作答/忽略投递接受后发本包事件恰一次，作答与忽略同形、载荷含 agent 标识与题号', async () => {
  const agent = fakeAgent('s-evt');
  const { registry, timer, emitted } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1'), Q('q2')]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: [0] });
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q2', kind: 'ignore' });
  assert.equal(emitted.length, 2, '每条到达恰一次事件');
  const [answerEvent, ignoreEvent] = emitted;
  assert.equal(answerEvent.name, LATE_ANSWER_EVENT, '事件名 = LATE_ANSWER_SOURCE 派生常量');
  assert.equal(answerEvent.payload.agentId, 's-evt', '载荷含 agent 标识');
  assert.equal(answerEvent.payload.questionId, 'q1', '载荷含题号');
  assert.equal(answerEvent.payload.kind, 'answer', '作答 kind');
  assert.equal(answerEvent.payload.summary, t('en', 'ask.lateSummary', { qid: 'q1', answer: '选项一' }), '载荷含摘要');
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
  r2.submitAnswer({ batchId: item2.batchId, questionId: 'q1', selected: [0] });
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
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: [0] });
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q2', kind: 'answer', selected: [0] });
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
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: [0] });
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
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: [0] });
  // 补醒时 agent 引用失效：followup 抛错。
  agent.followup = () => { throw new Error('agent gone before sweep'); };
  agent.finishTurn({ claim: false });
  await flush();
  assert.deepEqual(registry.stateItems().lost, [{
    batchId: items[0].batchId, questionId: 'q1', question: '问题文本 q1',
    sessionId: 's-sweepfail'
  }], '补醒失败 → lost 名单（含题目内容供面板报错；携带所属会话 id 供恢复入口）');
  assert.equal(registry.lateLedger.length, 0, '转 lost 后账本出清');
});

hostTest('J22-⑤：空闲通道（followup）不武装补醒；dispose 后不再补醒', async () => {
  const agent = fakeAgent('s-nosweep', { status: 'idle' });
  const { registry, timer } = makeRegistry({ agentLang: 'en' });
  const pending = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const { items } = registry.stateItems();
  timer.fire(0);
  await pending;
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: [0] });
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
  r2.submitLate({ batchId: items2[0].batchId, questionId: 'q1', kind: 'answer', selected: [0] });
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
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: [0] });
  // 作答先到、等待后开：watchLateAnswer 起始检查从 agent.inbox 命中滞留通知。
  const watcher = watchLateAnswer(ctx, agent);
  const signal = await watcher.promise;
  assert.equal(signal.kind, 'late-answer');
  assert.equal(signal.qid, 'q1', '起始检查透传题号（source.questionId）');
  assert.equal(signal.summary, t('en', 'ask.lateSummary', { qid: 'q1', answer: '选项一' }), 'summary 与投递同源');
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
  assert.equal(registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: [0] }), 'late');
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
  registry.submitLate({ batchId: items[0].batchId, questionId: 'q1', kind: 'answer', selected: [0] });
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
  registry.submitLate({ batchId: q2Item.batchId, questionId: 'q2', kind: 'answer', selected: [0] });
  agent.finishTurn({ claim: false });
  await flush();
  assert.equal(agent.followupCalls.length, 1, '恢复可读后重新武装：补醒提醒恰一条（两滞留条都还在账上）');
  const reminder = agent.followupCalls[0];
  assert.equal(reminder.source.form, 'reminder', '补醒条 form:reminder（不冒充答案）');
});

hostTest('J25（A-F08）：投递次序先于唤醒判定——投递抛错不制造到达事实，等待方按原预算继续；成功投递恰一次事件+账本在册+等待方唤醒', async () => {
  // 反例形态（sol core-probes「late delivery rejection still wakes an active
  // wait」）：合法超时题迟到提交、主体 inject 抛错、outcome=failed——旧次序先发
  // 事件，活动等待在数毫秒内被「答案已到」唤醒，收件箱却为空。等待方用真实的
  // watchLateAnswer（async_wait_* 的迟到唤醒信号源）模拟；注册表的 emit 同步
  // 转发进 fakeCtx 的 ctx.emit，事件侧与起始检查侧两路命中口径都真实可观察。
  const { ctx } = fakeCtx();
  const emitted = [];
  let clockNow = 1_000_000;
  const registry = new AskBatchRegistry({
    timer: fakeTimer(),
    readSnapshot: () => ({ askTakeover: true, askTimeoutMs: 5000, agentLang: 'en' }),
    emit: (name, payload) => { emitted.push({ name, payload }); ctx.emit(name, payload); },
    now: () => clockNow
  });

  // ── 反例组：运行中（走 inject）+ inject 同步抛错 ──
  const broken = fakeAgent('s-latefail'); // 默认 running → inject 通道
  const pendingBad = registry.take(makeRequest(broken, [Q('q1')]), broken);
  const badItem = registry.stateItems().items[0];
  clockNow += 5000;
  registry.timer.fire(0);
  await pendingBad;
  broken.inject = () => { throw new Error('agent gone'); };
  // 等待方先挂（收件箱为空——起始检查不命中），再迟到提交：
  const waiting = watchLateAnswer(ctx, broken);
  assert.equal(
    registry.submitLate({ batchId: badItem.batchId, questionId: 'q1', kind: 'answer', selected: [0] }),
    'failed', '投递抛错 → outcome=failed（既有回执路径）'
  );
  assert.equal(emitted.length, 0, '零 LATE_ANSWER_EVENT——宿主没收下，不制造到达事实');
  assert.equal(registry.lateLedger.length, 0, '待领账本零登记');
  assert.equal(registry.sweeps.size, 0, '空闲观察零武装');
  assert.equal(registry.stateItems().lost.length, 0, '投递失败不进 lost（那是补醒失败名单）');
  assert.equal(registry.batches.size, 1, 'failed 回滚为 open——题保持可再投、批次留驻（ASK-LATE-FAILED-RETRY，替代旧「仍出列」口径）');
  // 等待方不被「答案已到」打断：事件没发、收件箱为空（事件与起始检查两路都
  // 不命中），等待保持原预算继续、到期照常交回。已 resolve 的 promise 在微任务
  // 里先于 flush（宏任务）胜出——quiet ＝ 确实没醒（旧次序此处必得 woken）。
  const raceBad = await Promise.race([
    waiting.promise.then(() => 'woken'),
    flush().then(() => 'quiet')
  ]);
  assert.equal(raceBad, 'quiet', '等待方未被唤醒（收件箱为空的「答案已到」不出现）');
  waiting.dispose();

  // ── followup 通道（空闲）抛错同判：事件同样不发 ──
  const brokenIdle = fakeAgent('s-latefail-idle', { status: 'idle' });
  const pendingIdle = registry.take(makeRequest(brokenIdle, [Q('q2')]), brokenIdle);
  const idleItem = registry.stateItems().items.find((item) => item.questionId === 'q2');
  clockNow += 5000;
  registry.timer.fire(registry.timer.armed.length - 1);
  await pendingIdle;
  brokenIdle.followup = () => { throw new Error('agent gone idle'); };
  const waitingIdle = watchLateAnswer(ctx, brokenIdle);
  assert.equal(
    registry.submitLate({ batchId: idleItem.batchId, questionId: 'q2', kind: 'ignore' }),
    'failed', 'followup 抛错 → failed（两通道一个口径）'
  );
  assert.equal(emitted.length, 0, 'followup 失败同样零事件');
  assert.equal(
    (await Promise.race([waitingIdle.promise.then(() => 'woken'), flush().then(() => 'quiet')])),
    'quiet', '空闲通道失败同样不唤醒等待方'
  );
  waitingIdle.dispose();

  // ── 对照组：同批形状、inject 成功 → 事件恰一次、账本在册、等待方唤醒 ──
  const agent = fakeAgent('s-lateok');
  const pendingOk = registry.take(makeRequest(agent, [Q('q3')]), agent);
  const okItem = registry.stateItems().items.find((item) => item.questionId === 'q3');
  clockNow += 5000;
  registry.timer.fire(registry.timer.armed.length - 1);
  await pendingOk;
  const waitingOk = watchLateAnswer(ctx, agent);
  assert.equal(
    registry.submitLate({ batchId: okItem.batchId, questionId: 'q3', kind: 'answer', selected: [0] }),
    'late', '投递接受 → late'
  );
  assert.equal(emitted.length, 1, '事件恰一次');
  assert.equal(emitted[0].name, LATE_ANSWER_EVENT, '事件名 = 本包常量');
  assert.equal(emitted[0].payload.questionId, 'q3', '载荷含题号');
  assert.equal(registry.lateLedger.length, 1, '账本在册');
  assert.equal(registry.lateLedger[0].questionId, 'q3', '账本条目配对题号');
  const signal = await Promise.race([
    waitingOk.promise,
    flush().then(() => null)
  ]);
  assert.ok(signal !== null, '等待方被唤醒（投递接受后事件即达）');
  assert.equal(signal.qid, 'q3', '唤醒信号透传题号');
  waitingOk.dispose();

  // ── ASK-LATE-FAILED-RETRY（探针 M1 双故障形态回归）：q1 首投 failed（回执可
  // 能丢失——主体侧只看到题仍在列表）后，通道恢复、重试同一提交＝重新投递，
  // 不落进「已有答案」的无说明 gone。
  assert.ok(
    registry.stateItems().items.some((item) => item.questionId === 'q1'),
    'q1 投递失败后回滚为 open——仍在轮询列表（「从未投出」与「已投递」可区分）'
  );
  const healedDeliveries = [];
  broken.inject = (message) => { healedDeliveries.push(message); };
  assert.equal(
    registry.submitLate({ batchId: badItem.batchId, questionId: 'q1', kind: 'answer', selected: [0] }),
    'late', '通道恢复后重试同一提交 → 重新投递成功（不是 gone）'
  );
  assert.equal(healedDeliveries.length, 1, '重试真投递恰一次');
  assert.equal(
    emitted.filter((e) => e.name === LATE_ANSWER_EVENT && e.payload.questionId === 'q1').length, 1,
    '重试成功后 q1 事件恰一次'
  );
  assert.ok(
    !registry.stateItems().items.some((item) => item.questionId === 'q1'),
    '重试成功后 q1 正常出列'
  );
});

hostTest('J26（ASK-PENDING-IDENTITY）：待领账本按批次＋题号对账——同摘要不同批次领取其一后，账本只留未领取项', async () => {
  // 同批题号、同答案的两条迟到通知 summary 逐字相同：按字符串相等推定身份时，
  // 领取其一后收件箱仍留同串摘要，两条都判「未领取」——已领取项滞留账本，
  // 补醒与 lost 名单随之多算。对账必须按稳定批次标识＋题号逐条区分。
  const agent = fakeAgent('s-twins');
  const { registry, timer } = makeRegistry({ agentLang: 'en' });
  const pendingA = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const pendingB = registry.take(makeRequest(agent, [Q('q1')]), agent);
  const [a, b] = registry.stateItems().items;
  assert.notEqual(a.batchId, b.batchId, '前置：两批批次标识不同');
  timer.fire(0);
  await pendingA;
  timer.fire(1);
  await pendingB;
  assert.equal(registry.submitLate({ batchId: a.batchId, questionId: 'q1', kind: 'answer', selected: [0] }), 'late');
  assert.equal(registry.submitLate({ batchId: b.batchId, questionId: 'q1', kind: 'answer', selected: [0] }), 'late');
  const [msgA, msgB] = agent.injectCalls;
  assert.equal(msgA.source.summary, msgB.source.summary, '前置：两通知摘要逐字相同（字符串相等不可区分身份）');
  assert.equal(msgA.source.batchId, a.batchId, '通知 source 携带批次标识（甲）');
  assert.equal(msgB.source.batchId, b.batchId, '通知 source 携带批次标识（乙）');
  assert.equal(registry.lateLedger.length, 2, '两条都在待领账本');
  // 宿主只领取第一条（claim 移出收件箱）；第二条滞留（末步竞态形态）。
  agent.inbox.nextStep.splice(0, 1);
  agent.finishTurn({ claim: false });
  await flush();
  assert.equal(agent.followupCalls.length, 1, '滞留一条 → 补醒提醒恰一条');
  assert.equal(registry.lateLedger.length, 1, '账本剪除已领取条目（按批次＋题号对账）');
  assert.equal(registry.lateLedger[0].batchId, b.batchId, '保留的是未领取的那条（批次可逐条区分）');
  assert.deepEqual(registry.stateItems().lost, [], '补醒成功 → 无 lost 名单');

  // 正常领取（两情形之全部领取）：同摘要两批都被领走 → 账本清空、不补醒。
  const agent2 = fakeAgent('s-twins-both');
  const { registry: reg2, timer: tim2 } = makeRegistry({ agentLang: 'en' });
  const pA = reg2.take(makeRequest(agent2, [Q('q1')]), agent2);
  const pB = reg2.take(makeRequest(agent2, [Q('q1')]), agent2);
  const [iA, iB] = reg2.stateItems().items;
  tim2.fire(0);
  await pA;
  tim2.fire(1);
  await pB;
  assert.equal(reg2.submitLate({ batchId: iA.batchId, questionId: 'q1', kind: 'answer', selected: [0] }), 'late');
  assert.equal(reg2.submitLate({ batchId: iB.batchId, questionId: 'q1', kind: 'answer', selected: [0] }), 'late');
  assert.equal(agent2.injectCalls[0].source.summary, agent2.injectCalls[1].source.summary, '前置：摘要仍逐字相同');
  agent2.finishTurn(); // 正常收尾：先整批领取再转空闲
  await flush();
  assert.equal(agent2.followupCalls.length, 0, '全部已领取 → 不补醒');
  assert.equal(reg2.lateLedger.length, 0, '账本清空（两条都剪除）');
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
 * 时钟调度替身：armed 项记 `dueAt = now + ms`，`advance()` 按到期序（同一时刻按
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

  // 窗口耗尽后（真实形态：到期回调与点击同一时刻竞态）→ expired 相不可复活。
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
  assert.equal(rig.registry.submitAnswer({ batchId: batch2.batchId, questionId: 'q2', selected: [0] }), 'delivered');
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
    // 'reject' 哨兵模拟 RPC 拒绝（响应丢失——服务端可能已执行）。
    extend: (...args) => { extendCalls.push(args); return extendResult === 'reject'
      ? Promise.reject(new Error('response lost')) : Promise.resolve(extendResult); }
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

  // ③ 失败路径（失败三分）：回执 ok:false 是宿主**明确拒绝** →
  // callFailed='extendRejected'（面板顶按类别报错），不假报加时成功。
  extendResult = { ok: false };
  toggles[0].props.onClick();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(model.store.getSnapshot().callFailed, 'extendRejected', "明确拒绝 → callFailed='extendRejected'（与未确认档分开）");
  const panel2 = renderComp(() => product.AskList({ ask: model }));
  const failedLine = panel2.children.find((child) => child?.props?.className === 'ats-ask-failed');
  assert.ok(failedLine !== undefined, '失败文案渲染在面板顶');
  assert.equal(failedLine.children[0], product.DICTIONARIES.en['ask.extendRejected'], '明确拒绝用专属文案（不与其他失败混用）');

  // ④ 未确认路径：RPC 拒绝（响应丢失，执行与否未知）→ 'extend' 档。
  extendResult = 'reject';
  toggles[0].props.onClick();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(model.store.getSnapshot().callFailed, 'extend', "RPC 拒绝 → callFailed='extend'（未收到确认档）");

  model.dispose();
});

/** E 族快配：makeRegistry 不返回 take 便捷（与旧 K 族直呼 registry.take 同一形状）。 */
function registry_take(rig, agent, questionId) {
  return rig.registry.take(makeRequest(agent, [Q(questionId)]), agent);
}

// ---------------------------------------------------------------------------
// 状态读取代际（设计 §4.3）。反例形态（受控客户端实测）：A 先发、B 后发
// 先回，随后 A 的旧响应把新题目与期限回退；开关关闭后，在途回执仍把题目
// 写回隐藏状态。下列用例用手控 Promise 复现这些时序，验证代际判定——
// 较旧响应不回退已取得的新题目、计数与期限，旧代迟到回执零写入。
// ---------------------------------------------------------------------------

test('J40：状态读取代际——同代乱序：后发先回先应用，较旧回执不回退题目与期限', async () => {
  const react = makeMiniReact();
  const intervals = [];
  const product = await loadClientProduct(react, {
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {}
  });
  // 手控 remote：state 的回执由测试按任意次序兑现（乱序的装置形态）。
  const pending = [];
  const remoteNs = { state: () => new Promise((res) => { pending.push(res); }) };
  let snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'sidebar' }, user: {} };
  const scope = { getSnapshot: () => snap, subscribe: () => () => {}, mutate: async () => true };
  const ctx = { configForms: { get: () => scope }, uiWorkspace: { openSession() {} } };
  const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

  const model = product.createAskModel(ctx, remoteNs);
  await flush();
  assert.equal(pending.length, 1, '开启即发起首查（不等第一个轮询间隔）');

  // 定时轮询发起第二读（A=首查 seq1，B=seq2）；B 先回：serverNow=200、items=[]。
  await intervals[0].fn();
  await flush();
  assert.equal(pending.length, 2, '两读在途（重叠）');
  pending[1]({ ok: true, value: { serverNow: 200, items: [] } });
  await flush();
  let s = model.store.getSnapshot();
  assert.equal(s.serverNow, 200, '后发的新状态先应用');
  const fetchedAtB = s.fetchedAt;

  // A 后回：serverNow=100、items=[OLD] —— 较旧回执丢弃。
  pending[0]({ ok: true, value: { serverNow: 100, items: [{ batchId: 'OLD', questionId: 'q', sessionId: 's' }] } });
  await flush();
  s = model.store.getSnapshot();
  assert.equal(s.serverNow, 200, '较旧回执不回退 serverNow');
  assert.equal(s.items.length, 0, '已处理的问题不因过期响应重新出现');
  assert.equal(s.fetchedAt, fetchedAtB, 'fetchedAt 不回退');
  model.dispose();
});

test('J41：状态读取代际——关闭／重开／卸载：迟到成功与失败回执零写入，失败旗标不跨代', async () => {
  const react = makeMiniReact();
  const intervals = [];
  const product = await loadClientProduct(react, {
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {}
  });
  const pending = [];
  const remoteNs = { state: () => new Promise((res) => { pending.push(res); }) };
  const scopeListeners = [];
  let snap = { status: 'ready', value: {}, user: {} };
  const scope = {
    getSnapshot: () => snap,
    subscribe: (fn) => { scopeListeners.push(fn); return () => {}; },
    mutate: async () => true
  };
  const ctx = { configForms: { get: () => scope }, uiWorkspace: { openSession() {} } };
  const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  const setSnap = (value) => { snap = value; scopeListeners.forEach((fn) => fn()); };
  const ENABLED = { status: 'ready', value: { askTakeover: true, askUiSeat: 'sidebar' }, user: {} };
  const DISABLED = { status: 'ready', value: {}, user: {} };

  const model = product.createAskModel(ctx, remoteNs);
  await flush();
  assert.equal(pending.length, 0, '初始关：零读取');

  // ① 开启 → 首查 A 在途；关闭 → 代数推进、题目与 serverNow 清空。
  setSnap(ENABLED);
  await flush();
  assert.equal(pending.length, 1, '开启即首查');
  setSnap(DISABLED);
  await flush();
  let s = model.store.getSnapshot();
  assert.equal(s.enabled, false);
  assert.equal(s.items.length, 0, '关闭清题目');
  assert.equal(s.serverNow, 0, '关闭清 serverNow');

  // ② A 成功迟到（带题目、serverNow=300）——旧代回执丢弃。
  pending[0]({ ok: true, value: { serverNow: 300, items: [{ batchId: 'LATE', questionId: 'q2', sessionId: 's' }] } });
  await flush();
  s = model.store.getSnapshot();
  assert.equal(s.serverNow, 0, '关闭后的迟到成功回执零写入');
  assert.equal(s.items.length, 0, '题目不回填隐藏状态');

  // ③ 重开 → 新代首查 B；B 应用新状态（新生命周期不被旧代污染）。
  setSnap(ENABLED);
  await flush();
  assert.equal(pending.length, 2, '重开即首查');
  pending[1]({ ok: true, value: { serverNow: 400, items: [{ batchId: 'NEW', questionId: 'q3', sessionId: 's' }] } });
  await flush();
  s = model.store.getSnapshot();
  assert.equal(s.serverNow, 400, '新代正常应用');
  assert.equal(s.items[0]?.batchId, 'NEW', '新代题目在场');

  // ④ 失败迟到不跨代：开启期再发一读（C 在途），关闭后 C 失败返回——
  // 旧代失败不立 callFailed:'state'。
  await intervals[1].fn();
  await flush();
  assert.equal(pending.length, 3, '开启期第二读在途');
  setSnap(DISABLED);
  await flush();
  pending[2](undefined);
  await flush();
  s = model.store.getSnapshot();
  assert.equal(s.callFailed, null, "关闭后的迟到失败不立 callFailed='state'");

  // ⑤ 卸载：重开、首查 D 在途，dispose 后 D 成功返回——零写入。④ 的关闭
  // 已把 serverNow／items 清零，这里是「卸载后不得再被回执改写」的基线。
  setSnap(ENABLED);
  await flush();
  assert.equal(pending.length, 4, '重开即首查（dispose 前）');
  model.dispose();
  pending[3]({ ok: true, value: { serverNow: 500, items: [{ batchId: 'AFTER-DISPOSE', questionId: 'q4', sessionId: 's' }] } });
  await flush();
  s = model.store.getSnapshot();
  assert.equal(s.serverNow, 0, '卸载后的迟到成功回执零写入（保持关闭清零后的基线）');
  assert.equal(s.items.length, 0, '题目不被卸载后的回执改写');
  assert.equal(s.callFailed, null, '卸载后的回执不立失败旗标');
});

// ---------------------------------------------------------------------------
// 新题温和提醒（ASK-ANNOUNCE-01，设计 .local/design/a2/design-ask-ui.md §1/§4.1
// J1-J8）：复合键集合差的播报、代际配合、失败恢复、生命周期、两语冻结、
// AskAnnouncer 树形状与 wireAskSeats 接线。
// ---------------------------------------------------------------------------

test('J50：新题温和提醒——首查合并计数、增量、乱序/旧代、失败恢复、生命周期、两语冻结', async () => {
  const react = makeMiniReact();
  const intervals = [];
  const product = await loadClientProduct(react, {
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {}
  });
  const pending = [];
  const remoteNs = { state: () => new Promise((res) => { pending.push(res); }) };
  const scopeListeners = [];
  let snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'sidebar', uiLang: 'zh' }, user: {} };
  const scope = {
    getSnapshot: () => snap,
    subscribe: (fn) => { scopeListeners.push(fn); return () => {}; },
    mutate: async () => true
  };
  const ctx = { configForms: { get: () => scope }, uiWorkspace: { openSession() {} } };
  const flush = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };
  const setSnap = (value) => { snap = value; scopeListeners.forEach((fn) => fn()); };
  const it = (batchId, questionId) => ({
    batchId, questionId, sessionId: 's1', question: `题 ${questionId}`, options: [],
    multiSelect: false, receivedAt: 0, expiresAt: 20_000, phase: 'open'
  });
  const zhText = product.DICTIONARIES.zh['ask.announceNew'];
  const enText = product.DICTIONARIES.en['ask.announceNew'];

  const model = product.createAskModel(ctx, remoteNs);
  await flush();

  // J1 首查合并：3 题合成一条数量播报（zh 档）；同 items 再读 announce 引用不变。
  pending[0]({ ok: true, value: { serverNow: 10_000, items: [it('b1', 'q1'), it('b1', 'q2'), it('b1', 'q3')] } });
  await flush();
  let announce = model.store.getSnapshot().announce;
  assert.ok(announce !== null, '首查生成播报（重载/重开视角：在场待答都是新事实）');
  assert.equal(announce.text, zhText.replace('{n}', '3'), '3 题合并成一条（zh 词典值）');
  assert.equal(announce.seq, 1, '播报序号从 1 起');
  await intervals[0].fn();
  await flush();
  pending[1]({ ok: true, value: { serverNow: 10_500, items: [it('b1', 'q1'), it('b1', 'q2'), it('b1', 'q3')] } });
  await flush();
  assert.equal(model.store.getSnapshot().announce, announce, '同 items 重复轮询：announce 引用不变（DOM 文本不变，不重播）');

  // J2 增量：新 batchId 两题到达→只播增量 2，旧题不重播。
  await intervals[0].fn();
  await flush();
  pending[2]({ ok: true, value: { serverNow: 11_000, items: [it('b1', 'q1'), it('b2', 'q4'), it('b2', 'q5')] } });
  await flush();
  announce = model.store.getSnapshot().announce;
  assert.equal(announce.text, zhText.replace('{n}', '2'), '增量只计新键（2），已播旧题不重播');
  assert.equal(announce.seq, 2, '播报序号递增');

  // J3 乱序：同代较旧回执后到→代际检查丢弃，不产生播报、不把旧键漏进已播集合。
  await intervals[0].fn();
  await flush(); // pending[3]（seq 较旧）在途
  await intervals[0].fn();
  await flush(); // pending[4]（seq 较新）发出——后发先回，先兑现较新回执
  pending[4]({ ok: true, value: { serverNow: 12_000, items: [it('b1', 'q1'), it('b2', 'q4'), it('b2', 'q5')] } });
  await flush();
  const beforeStale = model.store.getSnapshot().announce;
  pending[3]({ ok: true, value: { serverNow: 11_500, items: [it('b0', 'q0'), it('b2', 'q4'), it('b2', 'q5')] } });
  await flush();
  assert.equal(model.store.getSnapshot().announce, beforeStale, '较旧回执被代际检查丢弃：无新播报');
  // 旧键 b0/q0 未被旧回执漏进已播集合——下一次合法读取仍会把它当新题播报。
  await intervals[0].fn();
  await flush();
  pending[5]({ ok: true, value: { serverNow: 12_500, items: [it('b0', 'q0'), it('b2', 'q4'), it('b2', 'q5')] } });
  await flush();
  assert.equal(model.store.getSnapshot().announce.text, zhText.replace('{n}', '1'), '旧键未被乱序回执吞掉（漏进已播集合会这里少播）');

  // J4 读失败恢复：失败夹在两次成功之间→已播集合保留，恢复读取只播新增。
  await intervals[0].fn();
  await flush();
  pending[6](undefined); // 读取失败：不播报、不动已播集合
  await flush();
  assert.equal(model.store.getSnapshot().callFailed, 'state', '读取失败立 state 旗标（重连窗口）');
  await intervals[0].fn();
  await flush();
  pending[7]({ ok: true, value: { serverNow: 13_000, items: [it('b0', 'q0'), it('b2', 'q4'), it('b2', 'q5'), it('b3', 'q6')] } });
  await flush();
  announce = model.store.getSnapshot().announce;
  assert.equal(announce.text, zhText.replace('{n}', '1'), '恢复后只播断线期间新增（b3/q6），断线前旧题不重播');

  // J6 两语与冻结：切 en 后已冻结 text 不重写；下一次新键才用新语言。
  setSnap({ status: 'ready', value: { askTakeover: true, askUiSeat: 'sidebar', uiLang: 'en' }, user: {} });
  const frozen = model.store.getSnapshot().announce;
  assert.equal(frozen.text, zhText.replace('{n}', '1'), '语言切换不重写已冻结文本（不触发旧消息重播）');
  await intervals[0].fn();
  await flush();
  pending[8]({ ok: true, value: { serverNow: 14_000, items: [it('b0', 'q0'), it('b2', 'q4'), it('b2', 'q5'), it('b3', 'q6'), it('b4', 'q7')] } });
  await flush();
  announce = model.store.getSnapshot().announce;
  assert.equal(announce.text, enText.replace('{n}', '1'), '新键播报用切换后的语言（en 词典值）');

  // J5 生命周期：关闭→announce 置空、已播集合清空；重开首查重新播报；旧代迟到回执不播。
  const openPending = pending.length;
  await intervals[0].fn();
  await flush(); // 旧代在途回执（关闭后到达）
  setSnap({ status: 'ready', value: { askTakeover: false }, user: {} });
  assert.equal(model.store.getSnapshot().announce, null, '关闭清空播报（区域文本不残留失效消息）');
  pending[openPending]({ ok: true, value: { serverNow: 15_000, items: [it('b9', 'q9')] } });
  await flush();
  assert.equal(model.store.getSnapshot().announce, null, '旧代迟到成功回执不产生播报（代际检查先拒）');
  setSnap({ status: 'ready', value: { askTakeover: true, askUiSeat: 'sidebar', uiLang: 'zh' }, user: {} });
  await flush();
  pending[openPending + 1]({ ok: true, value: { serverNow: 16_000, items: [it('b1', 'q1'), it('b2', 'q4')] } });
  await flush();
  announce = model.store.getSnapshot().announce;
  assert.equal(announce.text, zhText.replace('{n}', '2'), '重开首查按首查口径重新播报（已播集合已清空）');
  assert.ok(announce.seq > 4, '播报序号跨生命周期单调递增');
  model.dispose();
});

test('J51：AskAnnouncer 树形状——role=status＋polite＋atomic＋视觉隐藏类、零宽空格交替、无渲染门槛', async () => {
  const react = makeMiniReact();
  const product = await loadClientProduct(react, { setInterval: () => 0, clearInterval: () => {} });
  // 手工快照模型：Announcer 只读 store（subscribe/getSnapshot），不碰 actions。
  const makeModel = (announce) => ({
    store: {
      subscribe: () => () => {},
      getSnapshot: () => ({
        enabled: false, seat: 'sidebar', uiLang: 'auto', serverNow: 0, fetchedAt: 0,
        items: [], callFailed: null, answerRejectReason: null,
        lostAnswers: [], undelivered: [], announce
      })
    },
    locale: null
  });
  const spanOf = (model) => react.render(() => product.AskAnnouncer({ ask: model }));

  // 关态（enabled=false、无题目——askHasFace=false）仍渲染本体：区域不设门槛。
  const empty = spanOf(makeModel(null));
  assert.ok(empty !== null && empty.type === 'span', '关/无题态：播报区域仍在场（不设渲染门槛）');
  assert.equal(empty.props.className, 'ats-ask-sr', '视觉隐藏类在身');
  assert.equal(empty.props.role, 'status', 'role=status（隐含 polite/atomic）');
  assert.equal(empty.props['aria-live'], 'polite', '显式 polite（温和提醒：不打断当前朗读）');
  assert.equal(empty.props['aria-atomic'], 'true', '显式 atomic（整条朗读，不半句拼接）');
  assert.equal(String(empty.children), '', 'announce=null 时 children 为空');

  const a1 = spanOf(makeModel({ text: '待答问题新增 1 题', seq: 1 }));
  const a2 = spanOf(makeModel({ text: '待答问题新增 1 题', seq: 2 }));
  assert.equal(String(a1.children), '待答问题新增 1 题', 'text 进 children');
  assert.equal(String(a2.children), '待答问题新增 1 题\u200B', '连续同文按 seq 奇偶交替追加零宽空格（文本恒有差异）');
  assert.notEqual(String(a1.children), String(a2.children), '两次同文播报的 DOM 文本不同（部分读屏才重播）');
});

test('J52：wireAskSeats 接线——overlay 槽注册返回 Fragment[AskAnnouncer, AskOverlaySeat]，与座位态解耦', async () => {
  const react = makeMiniReact();
  const product = await loadClientProduct(react, { setInterval: () => 0, clearInterval: () => {} });
  let snap = { status: 'ready', value: { askTakeover: true, askUiSeat: 'sidebar' }, user: {} };
  const scopeListeners = [];
  const scope = {
    getSnapshot: () => snap,
    subscribe: (fn) => { scopeListeners.push(fn); return () => {}; },
    mutate: async () => true
  };
  const registrations = [];
  const askRemoteNs = { state: () => Promise.resolve({ ok: true, value: { serverNow: 0, items: [] } }) };
  const fakeAgentPresets = { list: () => Promise.resolve({ ok: true, value: { presets: [] } }) };
  const ctx = {
    configForms: {
      get: () => scope,
      whileServed: (entries, fn) => { const off = fn(); return () => off?.(); }
    },
    slots: {
      inject: (slot, factory) => { const off = factory(); return () => off?.(); },
      register: (meta, renderFn) => { registrations.push({ meta, renderFn }); return () => {}; }
    },
    inject: (list, fn) => fn({ remote: { 'async-tools-ask': askRemoteNs, agentPresets: fakeAgentPresets } }),
    locale: { register: () => () => {} },
    remote: { $mount: () => Promise.resolve(() => {}), $on: () => () => {} },
    on: () => () => {},
    effect: (fn) => { const off = fn(); return () => off?.(); },
    uiWorkspace: { openSession() {} }
  };
  product.apply(ctx);
  await Promise.resolve();
  await Promise.resolve();
  const overlayReg = registrations.find((reg) => reg.meta.name === 'shell.overlay' && reg.meta.id === 'async-tools-ask');
  assert.ok(overlayReg !== undefined, 'overlay 槽注册经 apply 生效');
  // sidebar 座位态（面板不渲染的收起形态）下取注册渲染函数：Fragment 首子即播报区域。
  const frag = overlayReg.renderFn();
  assert.equal(frag.type, react.Fragment, 'overlay 注册返回 Fragment');
  assert.equal(frag.children[0].type, product.AskAnnouncer, 'Fragment 首子＝AskAnnouncer（不设座位/收起门槛）');
  assert.equal(frag.children[1].type, product.AskOverlaySeat, 'Fragment 次子＝AskOverlaySeat（座位本体照旧）');
  // sidebar.footer.action 注册不受影响（label 闭包 + 座位本体）。
  const sidebarReg = registrations.find((reg) => reg.meta.name === 'sidebar.footer.action' && reg.meta.id === 'async-tools-ask');
  assert.ok(sidebarReg !== undefined && typeof sidebarReg.meta.label === 'function', 'sidebar 座位注册并存且 label 闭包不变');
  assert.equal(sidebarReg.renderFn().type, product.AskSidebarSeat, 'sidebar 注册仍渲染座位本体');
});

// ---------------------------------------------------------------------------
// 组合期提交限制（ASK-IME-SUBMIT-01，设计 .local/design/a2/design-ask-ui.md §2/§4.1
// J9-J16）：每题组合状态、平台层 disabled、submit 复查、compositionend/onBlur
// 复位与重校验、不答隔离、多题隔离、多选组合期（评审 M2）、blur 单独复位（M3）。
// ---------------------------------------------------------------------------

test('J53：组合期提交限制——置位/拦截/复查/复位/重校验/不答隔离/多选组合期/blur 复位', async () => {
  const react = makeMiniReact();
  const product = await loadClientProduct(react, { setInterval: () => 0, clearInterval: () => {} });
  const t = (key) => key;
  const submitted = [];
  const ignored = [];
  const ask = {
    actions: {
      answer(item, selected, custom, onDone) {
        submitted.push({ selected, custom });
        if (typeof onDone === 'function') onDone(true);
      },
      ignore(item, onDone) { ignored.push(item.questionId); if (typeof onDone === 'function') onDone(true); },
      jump() {}, dismissLost() {}
    },
    store: null
  };
  const base = { batchId: 'b', sessionId: 's', question: 'q', receivedAt: 0,
    expiresAt: Date.now() + 60000, phase: 'open' };
  const opts = () => react.__lastTree.children.find((c) => c?.props?.className === 'ats-ask-opts').children;
  const customInput = () => opts()[opts().length - 1].children[1];
  const row = () => react.__lastTree.children.find((c) => c?.props?.className === 'ats-ask-row');
  const submitBtn = () => row().children[0];
  const skipBtn = () => row().children[1];
  const reason = () => react.__lastTree.children.find((c) => c?.props?.className === 'ats-ask-reason');
  const root = () => react.__lastTree;

  // ── J9/J10/J11：单选自定义项的主线 ──────────────────────────────────────
  const single = { ...base, questionId: 'q1', multiSelect: false, options: [{ label: 'a' }] };
  react.render(() => product.AskItem({ item: single, t, ask, serverNow: 0, fetchedAt: 0 }));
  // 前置：自定义有效文本→可提交；组合开始→平台层禁用＋就近原因＋探针锚点。
  customInput().props.onChange({ target: { value: '拼音组合中' } });
  assert.equal(submitBtn().props.disabled, false, '前置：有效自定义可提交');
  customInput().props.onCompositionStart();
  assert.equal(submitBtn().props.disabled, true, '组合开始：平台层 disabled（鼠标/触屏/键盘三入口同拦）');
  assert.equal(reason()?.children[0], 'ask.composing', '就近原因=组合中（优先于有效性档）');
  assert.equal(root().props['data-composing'], 'true', 'data-composing=true（探针锚点）');
  // 组合中 onChange 输入非空白：自定义保持选中，仍禁用。
  customInput().props.onChange({ target: { value: '拼音组合中续' } });
  assert.equal(submitBtn().props.disabled, true, '组合中输入照进草稿，但提交仍禁用');
  // J10 复查：组合中直接调 submit 的 onClick（绕过 disabled 的合成点击）→零调用。
  submitBtn().props.onClick();
  assert.equal(submitted.length, 0, '组合中被拒动作当场终结（提交入口复查读 ref）');
  // J11 compositionend→按有效性恢复：有效（非空白自定义）→enabled、原因行退场。
  customInput().props.onCompositionEnd();
  assert.equal(submitBtn().props.disabled, false, '组合结束：有效性现算恢复启用');
  assert.equal(reason(), undefined, '有效态无就近原因');
  assert.equal(root().props['data-composing'], 'false', '组合结束复位探针锚点');
  // 组合结束后同一 onClick→恰一次（须再次明确动作；不自动补发被拒动作）。
  submitBtn().props.onClick();
  assert.equal(submitted.length, 1, '组合结束后显式提交成功一次');
  assert.deepEqual(submitted[0], { selected: [], custom: '拼音组合中续' }, '载荷＝组合确认后的草稿原文');
  // J11b 无效恢复档：组合结束后空白自定义→disabled＋needCustom；无选择→needAnswer。
  customInput().props.onChange({ target: { value: ' ' } });
  assert.equal(submitBtn().props.disabled, true, '组合结束后空白自定义：按有效性禁用');
  assert.equal(reason()?.children[0], 'ask.needCustom', '就近原因回到有效性档：自定义空白');
  customInput().props.onClick(); // 重新选中后清空
  customInput().props.onChange({ target: { value: '' } });
  react.render(() => product.AskItem({ item: single, t, ask, serverNow: 0, fetchedAt: 0 }));
  assert.equal(submitBtn().props.disabled, true, '新实例无选择：禁用');
  assert.equal(reason()?.children[0], 'ask.needAnswer', '就近原因：需要选择答案');

  // ── J12 不答隔离 ───────────────────────────────────────────────────────
  const skipCase = { ...base, questionId: 'q2', multiSelect: false, options: [{ label: 'a' }] };
  react.render(() => product.AskItem({ item: skipCase, t, ask, serverNow: 0, fetchedAt: 0 }));
  customInput().props.onChange({ target: { value: '组合中不答' } });
  customInput().props.onCompositionStart();
  assert.notEqual(skipBtn().props.disabled, true, '「不答」不受组合位置 disabled（仅既有 busy 拦截）');
  skipBtn().props.onClick();
  assert.deepEqual(ignored, ['q2'], '组合中可直接不答该题（提交限制不管忽略入口）');

  // ── J15 多选（预设＋自定义）组合期（评审 M2 补）────────────────────────
  const multi = { ...base, questionId: 'q3', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] };
  react.render(() => product.AskItem({ item: multi, t, ask, serverNow: 0, fetchedAt: 0 }));
  opts()[0].props.onClick(); // 已选预设 a
  customInput().props.onChange({ target: { value: '多选自定义' } });
  assert.equal(submitBtn().props.disabled, false, '前置：预设＋有效自定义可提交');
  customInput().props.onCompositionStart();
  assert.equal(submitBtn().props.disabled, true, '多选组合期：整题禁提交（disabled 是题级判定）');
  assert.equal(reason()?.children[0], 'ask.composing', '多选组合期就近原因');
  submitBtn().props.onClick();
  assert.equal(submitted.filter((s) => s.custom === '多选自定义').length, 0, '多选组合中被拒动作零调用');
  customInput().props.onCompositionEnd();
  assert.equal(submitBtn().props.disabled, false, '组合结束：「预设＋有效自定义」恢复可提交');
  submitBtn().props.onClick();
  assert.deepEqual(submitted[submitted.length - 1], { selected: [0], custom: '多选自定义' },
    '多选组合结束后提交：预设与自定义并列进载荷');

  // ── J16 blur 单独复位（评审 M3 补：历史引擎失焦不派发 compositionend）──
  const blurCase = { ...base, questionId: 'q4', multiSelect: false, options: [{ label: 'a' }] };
  react.render(() => product.AskItem({ item: blurCase, t, ask, serverNow: 0, fetchedAt: 0 }));
  customInput().props.onChange({ target: { value: '失焦复位' } });
  customInput().props.onCompositionStart();
  assert.equal(submitBtn().props.disabled, true, '前置：组合中禁用');
  customInput().props.onBlur(); // 只有 blur、没有 compositionend
  assert.equal(submitBtn().props.disabled, false, 'blur 同步复位组合位（提交限制不卡死）');
  assert.equal(root().props['data-composing'], 'false', 'blur 后探针锚点复位');
  const countAfterBlur = submitted.length;
  customInput().props.onCompositionEnd(); // 迟到的 compositionend：幂等复位、无补发
  assert.equal(submitted.length, countAfterBlur, '迟到 compositionend 不自动提交（无存储意图可补发）');
  assert.equal(submitBtn().props.disabled, false, '幂等复位不改变按有效性恢复的结果');

  // ── J13 多题隔离：A 组合不改 B 的提交可用性（两实例共用一次渲染会话）──
  const itemA = { ...base, questionId: 'qa', multiSelect: false, options: [{ label: 'a' }] };
  const itemB = { ...base, questionId: 'qb', multiSelect: false, options: [{ label: 'b' }] };
  react.render(() => [
    product.AskItem({ item: itemA, t, ask, serverNow: 0, fetchedAt: 0 }),
    product.AskItem({ item: itemB, t, ask, serverNow: 0, fetchedAt: 0 })
  ]);
  const treeOf = (i) => react.__lastTree[i];
  const inputOf = (i) => {
    const o = treeOf(i).children.find((c) => c?.props?.className === 'ats-ask-opts').children;
    return o[o.length - 1].children[1];
  };
  const submitOf = (i) => treeOf(i).children.find((c) => c?.props?.className === 'ats-ask-row').children[0];
  inputOf(0).props.onChange({ target: { value: 'A 组合' } });
  inputOf(1).props.onChange({ target: { value: 'B 有效' } });
  assert.equal(submitOf(1).props.disabled, false, '前置：两题各自有效');
  inputOf(0).props.onCompositionStart();
  assert.equal(submitOf(0).props.disabled, true, '题 A 组合中：A 禁用');
  assert.equal(submitOf(1).props.disabled, false, '题 B 不受题 A 组合影响（每题状态独立）');
  inputOf(1).props.onCompositionStart();
  assert.equal(submitOf(1).props.disabled, true, '题 B 自己的组合同样生效');
  inputOf(0).props.onCompositionEnd();
  assert.equal(submitOf(0).props.disabled, false, 'A 结束组合恢复，B 仍处自己的组合期');

  // ── J14 词典两语值 ─────────────────────────────────────────────────────
  const zh = product.DICTIONARIES.zh, en = product.DICTIONARIES.en;
  assert.match(zh['ask.composing'], /组词/, 'zh ask.composing 含组合语义');
  assert.doesNotMatch(zh['ask.composing'], /compos|ref|state/i, 'zh 不含内部术语');
  assert.match(en['ask.composing'], /composition/i, 'en ask.composing 含 composition 语义');
  assert.match(zh['ask.announceNew'], /新增 \{n\} 题/, 'zh ask.announceNew 数量句式（与 ask.count 同风格）');
  assert.match(en['ask.announceNew'], /\{n\} new/, 'en ask.announceNew 数量句式');
});

// ASK-UI-REJECTION-LANG：真实服务拒绝 → gateway 错误字段 → 客户端模型 → 面板。
// 传输替身遵循宿主 rpcFailure / rebuiltFailure 契约；JSON 往返避免误用 Error
// 未序列化的附加属性。原因来自真实 answer()，不由界面替身预设。
for (const [uiLang, agentLang] of [['zh', 'en'], ['en', 'zh']]) {
  hostTest(`ASK-UI-REJECTION-LANG：uiLang=${uiLang} / agentLang=${agentLang} 两条语言通道独立`, async () => {
    const { RemoteError, remoteErrorOf } = await import('@deepseek-ai/dsh-typert-protocol');
    const react = makeMiniReact();
    const product = await loadClientProduct(react, { setInterval: () => 0, clearInterval() {} });
    const { registry } = makeRegistry({ agentLang });
    const agent = fakeAgent();
    const pending = registry.take(makeRequest(agent, [Q('q-lang')]), agent);
    const service = new AskTakeoverService({ reflect: { provide() {} } }, registry);
    let receipt;
    const remote = {
      state: async () => ({ ok: true, value: await service.state() }),
      answer: async (submission) => {
        try {
          return { ok: true, value: await service.answer(submission) };
        } catch (error) {
          const failure = remoteErrorOf(error);
          assert.ok(failure, '真实 answer() 必须抛出可携带 details 的 RemoteError');
          const wire = JSON.parse(JSON.stringify({
            code: failure.code, message: failure.message, details: failure.details
          }));
          receipt = { ok: false, error: new RemoteError(wire.code, wire.message, wire.details) };
          return receipt;
        }
      }
    };
    const scope = {
      getSnapshot: () => ({ status: 'ready', value: { askTakeover: true, uiLang }, user: {} }),
      subscribe: () => () => {}
    };
    const model = product.createAskModel({ configForms: { get: () => scope }, uiWorkspace: {} }, remote);
    const banner = () => {
      const tree = react.render(() => product.AskList({ ask: model }));
      return tree.children.find((node) => node?.props?.className === 'ats-ask-failed')?.children.join('');
    };
    const submit = (item, selected, custom) => new Promise((resolve) => {
      model.actions.answer(item, selected, custom, resolve);
    });
    try {
      await flush();
      const item = model.store.getSnapshot().items[0];
      const cases = [
        ['ask.rejectUnknownOption', ['不存在的选项'], undefined],
        ['ask.rejectUnknownOption', [9], undefined],
        ['ask.rejectSingleMultiple', [0, 1], undefined],
        ['ask.rejectBlankCustom', [], '  '],
        ['ask.rejectSingleBoth', [0], '补充'],
        ['ask.rejectNothing', [], undefined]
      ];
      for (const [reasonKey, selected, custom] of cases) {
        assert.equal(await submit(item, selected, custom), false);
        assert.equal(receipt.error.code, 'async-tools/answer-rejected');
        assert.equal(receipt.error.details.reasonKey, reasonKey);
        assert.equal(receipt.error.message, t(agentLang, 'ask.answerRejectedError', { reason: t(agentLang, reasonKey) }),
          '同一回执的模型侧错误文案仍由 agentLang 管理');
        assert.equal(model.store.getSnapshot().answerRejectReasonKey, reasonKey);
        assert.equal(model.store.getSnapshot().answerRejectReason, receipt.error.message, '原串同时保留');
        assert.equal(product.DICTIONARIES[uiLang][reasonKey], t(uiLang, reasonKey), '两套词典语义一致');
        assert.equal(banner(), product.DICTIONARIES[uiLang]['ask.answerRejected'] + ' · ' + t(uiLang, reasonKey));
        assert.ok(!banner().includes(t(agentLang, reasonKey)), '界面不混入另一语言的原因句');
      }
      assert.equal(registry.stateItems().items.length, 1, '所有拒绝均不记已答');
      assert.equal(await submit(item, [0], undefined), true, '正常作答仍成功');
      assert.deepEqual((await pending).answers[0].selected, ['选项一']);
      assert.equal(model.store.getSnapshot().answerRejectReason, null);
      assert.equal(model.store.getSnapshot().answerRejectReasonKey, null, '成功清除原因键');
      assert.equal(banner(), undefined, '成功清除拒绝横幅');
    } finally {
      model.dispose();
      registry.disposeAll();
    }
  });
}

test('ASK-UI-REJECTION-LANG：无键或未知键保留原串，忽略拒绝不沿用旧原因键', async () => {
  const react = makeMiniReact();
  const product = await loadClientProduct(react, { setInterval: () => 0, clearInterval() {} });
  const item = { batchId: 'b', questionId: 'q', sessionId: 's', question: 'q', options: [] };
  let result = { ok: false, error: { message: 'unchanged diagnostic', details: {} } };
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: { askTakeover: true, uiLang: 'zh' }, user: {} }),
    subscribe: () => () => {}
  };
  const model = product.createAskModel({ configForms: { get: () => scope }, uiWorkspace: {} }, {
    state: async () => ({ ok: true, value: { serverNow: 0, items: [item] } }),
    answer: async () => result,
    ignore: async () => result
  });
  const banner = () => react.render(() => product.AskList({ ask: model })).children
    .find((node) => node?.props?.className === 'ats-ask-failed')?.children.join('');
  const submit = () => new Promise((resolve) => model.actions.answer(item, [], undefined, resolve));
  try {
    await flush();
    await submit();
    assert.equal(banner(), product.DICTIONARIES.zh['ask.answerRejected'] + ' · unchanged diagnostic');
    result.error.details.reasonKey = 'ask.futureReason';
    await submit();
    assert.equal(banner(), product.DICTIONARIES.zh['ask.answerRejected'] + ' · unchanged diagnostic');
    result.error.details.reasonKey = 'ask.rejectNothing';
    await submit();
    assert.ok(banner().includes(product.DICTIONARIES.zh['ask.rejectNothing']));
    result = { ok: false, error: { message: 'ignore diagnostic' } };
    await new Promise((resolve) => model.actions.ignore(item, resolve));
    assert.equal(model.store.getSnapshot().answerRejectReasonKey, null);
    assert.equal(banner(), product.DICTIONARIES.zh['ask.answerRejected'] + ' · ignore diagnostic');
  } finally {
    model.dispose();
  }
});

// ---------------------------------------------------------------------------
// 手势组合位（ASK-COMPOSITION-GESTURE，需求 §4.2.4 组合期行）：组合期按下提交按
// 钮 → 按下使输入框失焦 → blur 复位当前组合位、按钮重新可用 → 同一手势抬起才派
// 发 click——该 click 必须被当场拒绝（手势开始时的组合状态决定该次拒绝，blur/end
// 不让同一手势获准），草稿与已选项保留、不排队补发。残余清理：被中断的手势（按
// 下后拖离、无 click）经 document 级 pointerup/pointercancel 捕获监听＋宏任务清
// 位，不残留影响键盘 Enter 提交；键盘路径的 click（无指针按下）不查手势位。
// ---------------------------------------------------------------------------

test('J54：手势组合位——组合中开始的提交手势迟到 click 被拒；中断手势清位后键盘提交不受残留影响', async () => {
  const react = makeMiniReact();
  // 假 window 的宏任务队列：清位定时器进 Map、由测试按序放行——钉住「清位必须排
  // 在 click 之后」的次序（pointerup 已到、定时器未跑时的 click 仍被拒）。
  const pendingTimers = new Map();
  let timerSeq = 0;
  const product = await loadClientProduct(react, {
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: (fn) => { timerSeq += 1; pendingTimers.set(timerSeq, fn); return timerSeq; },
    clearTimeout: (id) => { pendingTimers.delete(id); }
  });
  // 假 document（裸 `document` 经 globalThis 动态解析，v3 用例同款）：捕获 AskItem
  // 挂的 document 级 pointerup/pointercancel 捕获监听。
  const docListeners = [];
  globalThis.document = {
    addEventListener: (event, fn, opts) => { docListeners.push({ event, fn, opts }); },
    removeEventListener: () => {},
    getElementById: () => null,
    createElement: () => ({ textContent: '' }),
    head: { appendChild() {} }
  };
  try {
    const t = (key) => key;
    const submitted = [];
    const ask = {
      actions: {
        answer(item, selected, custom, onDone) {
          submitted.push({ selected, custom });
          if (typeof onDone === 'function') onDone(true);
        },
        ignore() {}, jump() {}, dismissLost() {}
      },
      store: null
    };
    const base = { batchId: 'b', sessionId: 's', question: 'q', receivedAt: 0,
      expiresAt: Date.now() + 60000, phase: 'open' };
    const opts = () => react.__lastTree.children.find((c) => c?.props?.className === 'ats-ask-opts').children;
    const customInput = () => opts()[opts().length - 1].children[1];
    const row = () => react.__lastTree.children.find((c) => c?.props?.className === 'ats-ask-row');
    const submitBtn = () => row().children[0];
    const pointerUp = (event) => {
      for (const entry of docListeners.filter((l) => l.event === 'pointerup')) entry.fn(event);
    };
    const runTimeouts = () => {
      const fns = [...pendingTimers.values()];
      pendingTimers.clear();
      for (const fn of fns) fn();
    };

    // ── 1. 组合中按下提交按钮 → blur → compositionend → click：被拒，草稿与选择保留 ──
    const gesture = { ...base, questionId: 'q1', multiSelect: true, options: [{ label: 'a' }] };
    react.render(() => product.AskItem({ item: gesture, t, ask, serverNow: 0, fetchedAt: 0 }));
    // 挂载即注册 document 级捕获监听（中断手势的清位通道）。
    assert.ok(docListeners.some((l) => l.event === 'pointerup' && l.opts === true),
      'document 级 pointerup 捕获监听在挂载时注册（capture）');
    assert.ok(docListeners.some((l) => l.event === 'pointercancel' && l.opts === true),
      'pointercancel 捕获监听同注册（手势被取消也走清位）');
    opts()[0].props.onClick();                                      // 预设 a 已选
    customInput().props.onChange({ target: { value: '组合草稿' } }); // 多选：自定义与预设并存
    assert.equal(submitBtn().props.disabled, false, '前置：有效答案可提交');
    customInput().props.onCompositionStart();                       // 组合中
    submitBtn().props.onPointerDown();                              // 手势开始：抄录组合位（组合中）
    customInput().props.onBlur();                                   // 按下使输入框失焦：当前组合位复位
    customInput().props.onCompositionEnd();                         // 组合随后正式结束
    assert.equal(submitBtn().props.disabled, false, 'blur/end 后按钮按有效性重新可用（同一手势仍不得获准）');
    submitBtn().props.onClick();                                    // 同一手势抬起的 click
    assert.equal(submitted.length, 0, '组合中开始的手势：迟到 click 被当场拒绝，不排队补发');
    assert.equal(customInput().props.value, '组合草稿', '被拒后草稿保留');
    assert.equal(opts()[0].props['aria-checked'], 'true', '被拒后预设选择保留');
    assert.equal(submitBtn().props.disabled, false, '被拒后仍处可提交态（等待新的明确操作）');
    // 新手势（pointerdown 时非组合）→ click 正常提交。
    pointerUp();                                                    // 上一手势结束
    runTimeouts();
    submitBtn().props.onPointerDown();                              // 新手势：非组合中开始
    submitBtn().props.onClick();
    assert.equal(submitted.length, 1, '新手势（非组合中开始）的 click 正常提交');
    assert.deepEqual(submitted[0], { selected: [0], custom: '组合草稿' },
      '载荷＝被拒手势保留下的草稿与选择（新的明确操作才可提交）');

    // ── 2. 键盘路径：无指针按下时的 click（模拟 Enter 激活按钮）不受手势位影响 ──
    const keyboard = { ...base, questionId: 'q2', multiSelect: false, options: [{ label: 'a' }] };
    react.render(() => product.AskItem({ item: keyboard, t, ask, serverNow: 0, fetchedAt: 0 }));
    customInput().props.onChange({ target: { value: '键盘提交' } });
    customInput().props.onCompositionStart();
    customInput().props.onCompositionEnd();                         // 组合结束，全程无 pointerdown
    submitBtn().props.onClick();
    assert.equal(submitted.length, 2, '无指针手势的 click 不查手势位（实现若把「无手势记录」当拒绝形态，这里必红）');

    // ── 3. 被中断手势：pointerdown（组合中）→ 拖离无 click → 宏任务清位后键盘 click 可提交 ──
    const interrupted = { ...base, questionId: 'q3', multiSelect: false, options: [{ label: 'a' }] };
    react.render(() => product.AskItem({ item: interrupted, t, ask, serverNow: 0, fetchedAt: 0 }));
    customInput().props.onChange({ target: { value: '拖离草稿' } });
    customInput().props.onCompositionStart();
    submitBtn().props.onPointerDown();                              // 组合中按下
    customInput().props.onBlur();                                   // 按下即失焦（拖离不改这一步）
    pointerUp();                                                    // 拖离后抬起：无 click
    // 次序探针：click 在 pointerup 之后同步派发、清位定时器尚未运行——同一手势的
    // click 仍被拒（清位若提前到该手势 click 之前，这里必红）。
    submitBtn().props.onClick();
    assert.equal(submitted.length, 2, 'pointerup 已到、清位未跑：手势位在场，click 仍被拒');
    runTimeouts();                                                  // 宏任务清位
    submitBtn().props.onClick();                                    // 键盘 Enter 激活（无新手势）
    assert.equal(submitted.length, 3, '中断手势清位后：键盘 click 不被残留手势位挡住');
    assert.deepEqual(submitted[2], { selected: [], custom: '拖离草稿' }, '清位后的键盘提交照常送出草稿原文');

    // ── 3b. 多指针（返修追加）：组合手势仍按住时，另一指针的抬起不得清位 ──
    //   攻击形状：指针 7 组合中按下提交（位＝true）→ 他指针 9 抬起（若清位不限
    //   pointerId，位被误清）→ 指针 7 的组合已被失焦结束 → 指针 7 抬起派发
    //   click——修复后该 click 仍被拒；只有指针 7 自己的结束才清位。
    const multiPointer = { ...base, questionId: 'q4', multiSelect: true, options: [{ label: 'a' }] };
    react.render(() => product.AskItem({ item: multiPointer, t, ask, serverNow: 0, fetchedAt: 0 }));
    opts()[0].props.onClick();
    customInput().props.onChange({ target: { value: '两指草稿' } });
    customInput().props.onCompositionStart();
    submitBtn().props.onPointerDown({ pointerId: 7 });                // 组合手势：指针 7 按下
    customInput().props.onBlur();                                     // 失焦结束组合
    pointerUp({ pointerId: 9 });                                      // 他指针抬起：不得清位
    runTimeouts();
    submitBtn().props.onClick();                                      // 指针 7 抬起派发的 click
    assert.equal(submitted.filter((s) => s.custom === '两指草稿').length, 0,
      '他指针的 pointerup 不清仍按住的手势位——组合中开始的 click 仍被拒');
    pointerUp({ pointerId: 7 });                                      // 同一指针结束：清位
    runTimeouts();
    submitBtn().props.onClick();                                      // 清位后的键盘/新动作提交
    assert.equal(submitted.filter((s) => s.custom === '两指草稿').length, 1,
      '同一指针的 pointerup 清位后：后续提交恢复正常');

    // 泄漏看守（源级）：卸载清理必须成对摘除两类监听并撤销未触发的清位定时器。
    const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
    assert.match(source, /removeEventListener\("pointerup"/, '卸载清理摘除 pointerup 监听');
    assert.match(source, /removeEventListener\("pointercancel"/, '卸载清理摘除 pointercancel 监听');
    assert.match(source, /clearTimeout\(gestureClearTimerRef\.current\)/, '卸载清理撤销未触发的清位定时器');
  } finally {
    delete globalThis.document;
  }
});
