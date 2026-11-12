/**
 * `lib/agent-policy.js` 单测（变异腿 M1–M7/M10/M13 各有对应腿——删掉被测保护
 * 该测必红；`verify/mutate-agent-policy.mjs` 打检查器侧）。
 *
 * 实时口径（需求 §2.3.2）后本模块只剩两样被测物：投影定义的**形状副本**
 * （与宿主同形的 fold＋zod stateSchema——它是解读原生会话投影与逐行互锚检查的
 * 形状依据）与 **`policyOf`**（init null 折 undefined 的读取语义）。采样链已
 * 随派生路径改现读 `subagentModelSelection` 服务而删除——相关用例改住在
 * `test/agent.test.mjs`（服务假件）。
 *
 * 夹具纪律：**不读宿主树**（逐行互锚检查 `verify/check-agent-policy.mjs` 管树锚；
 * 单测只测本包逻辑）。迷你投影注册表按「事件列表惰性 fold」实现——与真注册表
 * 同款读时补折语义。
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
  policyStateOf,
  policyProjectionDefinition
} from '../lib/agent-policy.js';

const ROUTES = [
  { provider: 'zai', model: 'glm-5.3' },
  { provider: 'deepseek-official', model: 'deepseek-flash' }
];

/** 迷你投影注册表：`stateOf` 现读现折会话事件列表（读时补折，宿主同语义）。 */
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

/** 会话替身：事件列表即可（policyOf 只走 stateOf 读路径）。 */
function makeSession({ events = [] } = {}) {
  return { __events: events };
}

test('常量与宿主同串同值（逐行互锚检查的值锚被单测再钉一层）', () => {
  assert.equal(POLICY_KEY, 'subagentModelSelectionPolicy');
  assert.equal(POLICY_STATE_VERSION, 1);
  assert.equal(POLICY_EVENT, 'subagent/model-selection-policy');
  assert.equal(policyProjectionDefinition.key, POLICY_KEY);
  assert.equal(policyProjectionDefinition.stateVersion, POLICY_STATE_VERSION);
});

test('fold：首条策略事件折出路由表（深副本语义），先到先记', () => {
  const first = policyProjectionDefinition.apply(
    policyProjectionDefinition.init({}, 0),
    { type: POLICY_EVENT, data: { allowedModels: ROUTES } }
  );
  assert.deepEqual(first, ROUTES);
  // 先到先记：后续策略事件与无关事件都不改写。
  const second = policyProjectionDefinition.apply(first, {
    type: POLICY_EVENT,
    data: { allowedModels: [{ provider: 'x', model: 'y' }] }
  });
  assert.deepEqual(second, ROUTES);
  const third = policyProjectionDefinition.apply(first, { type: 'session/other', data: {} });
  assert.deepEqual(third, ROUTES);
});

test('fold 校验（assertRoutes 形状副本）：非数组／字段缺失／空串／重复路由必抛', () => {
  const state = policyProjectionDefinition.init({}, 0);
  for (const bad of [
    undefined, 'routes', {},
    [{ provider: 'zai' }],
    [{ provider: '', model: 'm' }],
    [{ provider: 'zai', model: '' }],
    [{ provider: 'zai', model: 'a' }, { provider: 'zai', model: 'a' }]
  ]) {
    assert.throws(
      () => policyProjectionDefinition.apply(state, { type: POLICY_EVENT, data: { allowedModels: bad } }),
      { name: 'Error' },
      `非法路由表必须抛：${JSON.stringify(bad)}`
    );
  }
});

test('fold 空名单 throw（≥1 条约束在 fold，不在 assertRoutes——宿主同款三处分列）', () => {
  assert.throws(
    () => policyProjectionDefinition.apply(
      policyProjectionDefinition.init({}, 0),
      { type: POLICY_EVENT, data: { allowedModels: [] } }
    ),
    /requires at least one route/
  );
});

test('stateSchema 是 zod 且形状互锁（checkpoint 契约：.parse 可用、空数组不过、null 可过）', () => {
  const schema = policyProjectionDefinition.stateSchema;
  assert.equal(typeof schema.parse, 'function', '契约是 .parse（zod），不是 schemastery');
  assert.deepEqual(schema.parse(ROUTES), ROUTES);
  assert.equal(schema.parse(null), null);
  assert.throws(() => schema.parse([]), '空数组被 .min(1) 拒');
  assert.throws(() => schema.parse([{ provider: 'zai', model: 'm', extra: 1 }]), 'strict 拒未知键');
});

test('policyOf：init null／键缺席折 undefined；读到路由表给深拷贝', () => {
  const projections = fakeProjections();
  // 空会话：init null → undefined。
  assert.equal(policyOf(projections, makeSession()), undefined);
  // 键未注册（宿主 stateOf 对未注册键返回 undefined）→ 同折 undefined。
  assert.equal(policyOf({ stateOf: () => undefined }, makeSession()), undefined);
  // 有记录：返回逐项深拷贝。
  const session = makeSession({ events: [{ type: POLICY_EVENT, data: { allowedModels: ROUTES } }] });
  const routes = policyOf(projections, session);
  assert.deepEqual(routes, ROUTES);
  routes[0].provider = 'mutated';
  assert.equal(policyOf(projections, session)[0].provider, 'zai', '深拷贝：外改不回写投影状态');
});

test('policyStateOf：三态不折叠——键未注册 undefined／已注册无名单 null／有名单深拷贝', () => {
  // 键未注册：宿主 stateOf 返回 undefined，原样交回（身份依据①不成立的判据）。
  assert.equal(policyStateOf({ stateOf: () => undefined }, makeSession()), undefined);
  const projections = fakeProjections();
  // 已注册、无会话名单（init 默认形态）：null 不折成 undefined——与键未注册
  // 分开，是「组合活跃但会话未启用模型选择」与「原生插件不在组合」的区别。
  assert.equal(policyStateOf(projections, makeSession()), null);
  // 有名单：逐项深拷贝交回。
  const session = makeSession({ events: [{ type: POLICY_EVENT, data: { allowedModels: ROUTES } }] });
  const state = policyStateOf(projections, session);
  assert.deepEqual(state, ROUTES);
  state[0].provider = 'mutated';
  assert.equal(policyStateOf(projections, session)[0].provider, 'zai', '深拷贝：外改不回写投影状态');
});
