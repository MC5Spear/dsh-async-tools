/**
 * `lib/agent-policy.js` 单测（R40 §38.4；D1/D3/D4/D5/D6/D8 各有
 * 对应腿——删掉被测保护该测必红）。
 *
 * 夹具纪律：**不读宿主树**（钉版看守 `verify/check-agent-policy.mjs` 管树锚；单测
 * 只测本包逻辑）。迷你投影注册表按「事件列表惰性 fold」实现——与真注册表同款
 * 读时补折语义（D6：setup 窗口事件不 re-emit，`stateOf` 现读才能看到）。
 *
 * @module dsh-async-tools/test/agent-policy
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY_EVENT,
  POLICY_KEY,
  POLICY_STATE_VERSION,
  policyOf,
  policyProjectionDefinition,
  sampleAndRecord,
  wirePolicyRow
} from '../lib/agent-policy.js';

const ROUTES = [
  { provider: 'zai', model: 'glm-5.3' },
  { provider: 'deepseek-official', model: 'deepseek-flash' }
];

/** 迷你投影注册表：`stateOf` 现读现折会话事件列表（读时补折，D6 同语义）。 */
function fakeProjections() {
  return {
    stateOf(session, key) {
      if (key !== POLICY_KEY) return undefined;
      let state = policyProjectionDefinition.init(session.header, 0);
      for (const event of session.__events) state = policyProjectionDefinition.apply(state, event);
      return state;
    }
  };
}

/** 会话替身：append 记进事件列表（下一次 stateOf 就能折到——幂等可见性）。 */
function makeSession({
  origin = 'user',
  parentSession,
  firstLiveSeq = 0,
  eventAt0,
  events = []
} = {}) {
  return {
    header: { origin, parentSession },
    firstLiveSeq,
    eventAt: (seq) => (seq === 0 ? eventAt0 : undefined),
    append(type, data) {
      events.push({ type, data });
    },
    __events: events
  };
}

/** settings 替身：`.current()` → `{enabled, allowedModels}`。 */
function makeSettings({ enabled = true, allowedModels = ROUTES, currentThrows = false } = {}) {
  return {
    current() {
      if (currentThrows) throw new Error('enabled subagent model selection requires at least one allowed model');
      return { enabled, allowedModels };
    }
  };
}

test('常量与宿主同键同版同事件串（钉版看守的静态面对应物）', () => {
  assert.equal(POLICY_KEY, 'subagentModelSelectionPolicy');
  assert.equal(POLICY_STATE_VERSION, 1);
  assert.equal(POLICY_EVENT, 'subagent/model-selection-policy');
  assert.equal(policyProjectionDefinition.key, POLICY_KEY);
  assert.equal(policyProjectionDefinition.stateVersion, POLICY_STATE_VERSION);
});

test('fold：init null；首条策略事件折出路由表（先到先记）；后续策略事件与无关事件不动', () => {
  const init = policyProjectionDefinition.init({}, 0);
  assert.equal(init, null);
  const first = policyProjectionDefinition.apply(null, { type: POLICY_EVENT, data: { allowedModels: ROUTES } });
  assert.deepEqual(first, ROUTES);
  const second = policyProjectionDefinition.apply(first, {
    type: POLICY_EVENT,
    data: { allowedModels: [{ provider: 'other', model: 'other-model' }] }
  });
  assert.deepEqual(second, ROUTES, '已有策略时后续事件原样返回（幂等由 fold 结构保证）');
  const unrelated = policyProjectionDefinition.apply(null, { type: 'session/end-seed', data: {} });
  assert.equal(unrelated, null);
});

test('fold 校验三形态（非数组/空串/重复）→ 抛；空数组 → 「at least one route」抛（D8 三处分列）', () => {
  assert.throws(() => policyProjectionDefinition.apply(null, { type: POLICY_EVENT, data: { allowedModels: 'nope' } }),
    /requires an array of routes/);
  assert.throws(() => policyProjectionDefinition.apply(null, {
    type: POLICY_EVENT,
    data: { allowedModels: [{ provider: '', model: 'm' }] }
  }), /non-empty provider and model ids/);
  assert.throws(() => policyProjectionDefinition.apply(null, {
    type: POLICY_EVENT,
    data: { allowedModels: [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }] }
  }), /repeats route/);
  assert.throws(() => policyProjectionDefinition.apply(null, { type: POLICY_EVENT, data: { allowedModels: [] } }),
    /requires at least one route/,
    '空数组过 assert（不查长度）但被 fold 的空名单 throw 拦下——D8');
});

test('stateSchema 是 zod：有 parse；合法路由表/null 通过；空串、多余键、空数组被拒（D1）', () => {
  const schema = policyProjectionDefinition.stateSchema;
  assert.equal(typeof schema.parse, 'function', 'schemastery 没有 .parse——换库该断言必红');
  assert.deepEqual(schema.parse(ROUTES), ROUTES);
  assert.equal(schema.parse(null), null);
  assert.throws(() => schema.parse([{ provider: '', model: 'm' }]));
  assert.throws(() => schema.parse([{ provider: 'p', model: 'm', extra: 1 }]), undefined,
    'strict：多余键必须被拒（宿主 :202-205 同形）');
  assert.throws(() => schema.parse([]), undefined, 'min(1)：空路由表必须被拒');
});

test('policyOf：init null 折成 undefined；路由表返回深拷贝（D3 同构包装）', () => {
  const projections = fakeProjections();
  assert.equal(policyOf(projections, makeSession()), undefined, '无策略会话 → undefined（不是 null）');
  const withPolicy = makeSession({ events: [{ type: POLICY_EVENT, data: { allowedModels: ROUTES } }] });
  const read = policyOf(projections, withPolicy);
  assert.deepEqual(read, ROUTES);
  read[0].provider = 'mutated';
  assert.equal(withPolicy.__events[0].data.allowedModels[0].provider, 'zai', '返回值是拷贝，改它不污染事件');
});

test('采样③：fresh 顶层 + 白名单开 → 追加一条持久事件；连调两次仅一条（D3/D6 幂等）', () => {
  const projections = fakeProjections();
  const session = makeSession();
  const result = sampleAndRecord({ projections, settings: makeSettings(), sessions: { get: () => undefined } }, session);
  assert.deepEqual(result, { appended: true, routes: ROUTES });
  assert.equal(session.__events.length, 1);
  assert.equal(session.__events[0].type, POLICY_EVENT);
  assert.deepEqual(session.__events[0].data, { allowedModels: ROUTES });
  const again = sampleAndRecord({ projections, settings: makeSettings(), sessions: { get: () => undefined } }, session);
  assert.equal(again.appended, false, '幂等判据走 stateOf 现读——判据写错（=== undefined 对 null）该测必红');
  assert.equal(session.__events.length, 1);
});

test('采样③：白名单关（enabled=false）→ 不追加', () => {
  const projections = fakeProjections();
  const session = makeSession();
  const result = sampleAndRecord({ projections, settings: makeSettings({ enabled: false }), sessions: {} }, session);
  assert.deepEqual(result, { appended: false, routes: undefined });
  assert.equal(session.__events.length, 0);
});

test('采样②：origin=subagent 且父有策略 → 继承追加父路由', () => {
  const projections = fakeProjections();
  const parent = makeSession({ events: [{ type: POLICY_EVENT, data: { allowedModels: ROUTES } }] });
  const child = makeSession({ origin: 'subagent', parentSession: 'parent-1' });
  const result = sampleAndRecord({
    projections,
    settings: makeSettings({ allowedModels: [{ provider: 'other', model: 'x' }] }),
    sessions: { get: (id) => (id === 'parent-1' ? parent : undefined) }
  }, child);
  assert.equal(result.appended, true);
  assert.deepEqual(result.routes, ROUTES, '继承父策略，不是全局白名单');
});

test('采样②：origin=subagent 父查无 → 不追加且不落 ③（else-if 同形，D4）', () => {
  const projections = fakeProjections();
  const orphanChild = makeSession({ origin: 'subagent', parentSession: 'gone' });
  const result = sampleAndRecord({
    projections,
    settings: makeSettings(),
    sessions: { get: () => undefined }
  }, orphanChild);
  assert.deepEqual(result, { appended: false, routes: undefined },
    '父不在注册表：宿主同形不采——?? 链写法会错误落入 fresh 全局采样，该测必红');
  assert.equal(orphanChild.__events.length, 0);
});

test('采样②边缘：origin=subagent 且 header.parentSession 缺失 → 本包保守不采（对宿主三元的登记偏差）', () => {
  const projections = fakeProjections();
  const malformedChild = makeSession({ origin: 'subagent', parentSession: undefined });
  const result = sampleAndRecord({
    projections,
    settings: makeSettings(),
    sessions: { get: () => ({ header: {}, firstLiveSeq: 0, eventAt: () => undefined, append: () => {}, __events: [] }) }
  }, malformedChild);
  assert.deepEqual(result, { appended: false, routes: undefined },
    '宿主三元结构（:592-598）会让无父 id 的 subagent-origin 会话落入 fresh 全局采样；'
    + '本包按 origin 命中②、父缺即跳过——更保守（无 policy 拒绝方向），§38.2 表脚注登记');
  assert.equal(malformedChild.__events.length, 0);
});

test('采样②：sessions 服务缺席 → 跳过继承分支不抛（D5）；顶层采样不受影响照常追加', () => {
  const projections = fakeProjections();
  const child = makeSession({ origin: 'subagent', parentSession: 'p' });
  const noSessions = sampleAndRecord({ projections, settings: makeSettings() }, child);
  assert.equal(noSessions.appended, false, 'sessions 缺席只影响继承分支');
  const top = makeSession();
  const topResult = sampleAndRecord({ projections, settings: makeSettings() }, top);
  assert.equal(topResult.appended, true, '顶层 fresh 采样不读 sessions——宿主 :598-601 同形');
});

test('恢复会话不采样：firstLiveSeq>0 与 end-seed 打头两形态', () => {
  const projections = fakeProjections();
  const restored = makeSession({ firstLiveSeq: 5 });
  assert.equal(sampleAndRecord({ projections, settings: makeSettings(), sessions: {} }, restored).appended, false);
  const forked = makeSession({ firstLiveSeq: 0, eventAt0: { type: 'session/end-seed' } });
  assert.equal(sampleAndRecord({ projections, settings: makeSettings(), sessions: {} }, forked).appended, false);
  assert.equal(forked.__events.length, 0);
});

test('current() 抛错（enabled+空名单坏配置）→ 原样上抛 = 创建拒绝（裁决 R40-2 同宿主）', () => {
  const projections = fakeProjections();
  assert.throws(
    () => sampleAndRecord({ projections, settings: makeSettings({ currentThrows: true }), sessions: {} }, makeSession()),
    /requires at least one allowed model/
  );
});

test('wirePolicyRow：settings 缺席 → fold 照注册、不接采样监听、通告恰一次（有意偏差，R40-2）', () => {
  const registered = [];
  const listeners = {};
  const notices = [];
  const ctx = {
    sessionProjections: { register: (def) => registered.push(def) },
    get: (name) => (name === 'subagentModelSelection' ? undefined : { get: () => undefined }),
    on: (name, fn) => { listeners[name] = fn; return () => {}; }
  };
  const wired = wirePolicyRow(ctx, (line) => notices.push(line));
  assert.equal(wired.sampling, false);
  assert.equal(registered.length, 1, '投影 fold 无条件注册（读取面基础设施）');
  assert.equal(registered[0].key, POLICY_KEY);
  assert.equal(listeners['agent/created'], undefined, 'settings 缺席不接采样');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /模型选择设置服务缺席/);
});

test('wirePolicyRow：settings 在场 → 接监听；sessions 缺席只通告不阻拦；监听可端到端采样', () => {
  const registered = [];
  const listeners = {};
  const notices = [];
  const projections = fakeProjections();
  const settings = makeSettings();
  const ctx = {
    sessionProjections: { register: (def) => registered.push(def), stateOf: projections.stateOf },
    get: (name) => (name === 'subagentModelSelection' ? settings : undefined),
    on: (name, fn) => { listeners[name] = fn; return () => {}; }
  };
  const wired = wirePolicyRow(ctx, (line) => notices.push(line));
  assert.equal(wired.sampling, true);
  assert.equal(registered.length, 1);
  assert.equal(notices.length, 1, 'sessions 缺席通告一次（咨询性）');
  assert.match(notices[0], /Session 注册表缺席/);
  const session = makeSession();
  listeners['agent/created']({ agent: { session } });
  assert.equal(session.__events.length, 1, '监听端到端：新会话被采样并追加持久事件');
  assert.equal(session.__events[0].type, POLICY_EVENT);
});
