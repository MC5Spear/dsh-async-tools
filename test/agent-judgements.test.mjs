/**
 * `verify/agent-judgements.mjs`的单测。
 *
 * 围绕判据健壮性立的用例（文件共 8 条 test；以下枚举前四件锚必绿类，另四件
 * 为名单外指路、继承互斥、汇总读数与查询适用性）：
 * 1. **requested note 必绿**：lib/text.js 真渲染的 requested 回执（en/zh）命中；
 * 2. **继承 note 必红**（能红证明）：同样含 `zai/glm-5.3` 路由串的继承回执
 *    **不得**命中 requested 判据——并以裸路由串匹配作负控：松匹配确实会
 *    命中它们，正是判据必须排除的假绿机制；
 * 3. **推理强度附注锚必绿**：`route.effortSuffix` 两档真渲染命中，且不误吞
 *    无附注的回执；
 * 4. **可读拒绝族锚必绿**：实时口径六种拒绝（开关关／名单外／服务缺席／
 *    读取失败／重读读取失败／重读名单撤销，需求 §2.3.2＋设计 §3.3 三分）的
 *    两档真渲染文案各自命中、互不误吞成功 note；名单外拒绝必须指路
 *    `async_list_subagent_models`。
 *
 * 夹具全部经 `t()` 从 `lib/text.js` 现渲染（不手抄句子）：lib 侧措辞漂移 →
 * 判据锚过期 → 这里先红，锚与词典不会静默分叉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requestedRouteNote, inheritedRouteNote, effortNote,
  selectionDisabledRejection, routeNotAllowedRejection, policyUnavailableRejection,
  policyReadFailedRejection, recheckReadFailedRejection, recheckFailedRejection, readablePolicyRejection,
  queryVerdictAllowed, queryVerdictDisabled,
  judgeAgentRouting
} from '../verify/agent-judgements.mjs';
import { t } from '../lib/text.js';
import { LOG_PREFIX } from '../lib/config.js';

// ── 夹具：lib 真渲染文案（note = note.agentStarted + 路由回执行，lib/agent.js 的拼法） ──
const started = (lang) => t(lang, 'note.agentStarted', { agentId: 'session-x', defaultWaitMs: 60000 });
const requestedEn = `${started('en')}${t('en', 'route.requested', { provider: 'zai', model: 'glm-5.3' })}`;
const requestedZh = `${started('zh')}${t('zh', 'route.requested', { provider: 'zai', model: 'glm-5.3' })}`;
const inheritedEn = `${started('en')}${t('en', 'route.inherited', { route: 'zai/glm-5.3' })}`;
const inheritedZh = `${started('zh')}${t('zh', 'route.inherited', { route: 'zai/glm-5.3' })}`;
const inheritsOnlyEn = `${started('en')}${t('en', 'route.inherits')}`;
const inheritsOnlyZh = `${started('zh')}${t('zh', 'route.inherits')}`;
const effortEn = `${requestedEn}${t('en', 'route.effortSuffix', { effort: 'high' })}`;
const effortZh = `${requestedZh}${t('zh', 'route.effortSuffix', { effort: 'high' })}`;
// 拒绝夹具：转录里的错误结果形状（lib/agent.js throw 的 Error 文本）。
const rejection = (lang, key, vars = {}) => `Error: ${LOG_PREFIX} ${t(lang, key, vars)}`;
const disabledEn = rejection('en', 'error.selectionDisabled');
const disabledZh = rejection('zh', 'error.selectionDisabled');
const notAllowedEn = rejection('en', 'error.routeNotAllowed', { provider: 'zai', model: 'glm-5.3' });
const notAllowedZh = rejection('zh', 'error.routeNotAllowed', { provider: 'zai', model: 'glm-5.3' });
const unavailableEn = rejection('en', 'error.policyUnavailable');
const unavailableZh = rejection('zh', 'error.policyUnavailable');
const readFailedEn = rejection('en', 'error.policyReadFailed', { reason: 'bad config' });
const readFailedZh = rejection('zh', 'error.policyReadFailed', { reason: 'bad config' });
const recheckReadEn = rejection('en', 'error.routeRecheckReadFailed', { reason: 'settings transport unavailable' });
const recheckReadZh = rejection('zh', 'error.routeRecheckReadFailed', { reason: 'settings transport unavailable' });
const recheckEn = rejection('en', 'error.routeRecheckFailed');
const recheckZh = rejection('zh', 'error.routeRecheckFailed');

test('requested note 必绿（en/zh 两档，lib 真渲染回执）', () => {
  assert.equal(requestedRouteNote(requestedEn, 'zai', 'glm-5.3'), true, `en 夹具：${requestedEn.slice(-80)}`);
  assert.equal(requestedRouteNote(requestedZh, 'zai', 'glm-5.3'), true, `zh 夹具：${requestedZh.slice(-80)}`);
});

test('能红证明：继承 note 必红（裸路由串匹配的假绿洞已排除）', () => {
  // 继承回执（同路由串）与笼统继承形态都必须不命中 requested 判据。
  for (const fixture of [inheritedEn, inheritedZh, inheritsOnlyEn, inheritsOnlyZh]) {
    assert.equal(requestedRouteNote(fixture, 'zai', 'glm-5.3'), false,
      `继承 note 不得命中 requested 判据：…${fixture.slice(-80)}`);
  }
  // 负控对照：裸路由串匹配（只看路由串是否出现）确实会命中继承 note——
  // 把继承回执误判成「requested 被接受」的假绿机制就是它，判据必须比它严。
  const legacyLoose = (text) => /zai/.test(text) && /glm-5\.3/.test(text);
  assert.equal(legacyLoose(inheritedEn), true, '对照前提失效：en 继承夹具应含路由串');
  assert.equal(legacyLoose(inheritedZh), true, '对照前提失效：zh 继承夹具应含路由串');
  assert.equal(legacyLoose(inheritsOnlyEn), false, '笼统继承形态本就不含路由串');
});

test('推理强度附注锚必绿（en/zh），且不误吞无附注回执', () => {
  assert.equal(effortNote(effortEn, 'high'), true, `en 夹具：${effortEn.slice(-60)}`);
  assert.equal(effortNote(effortZh, 'high'), true, `zh 夹具：${effortZh.slice(-60)}`);
  assert.equal(effortNote(effortEn, 'low'), false, '强度值不符不得命中');
  assert.equal(effortNote(requestedEn), false, '无附注的 requested 回执不得命中');
  assert.equal(effortNote(effortEn), true, '缺省只判有附注');
});

test('可读拒绝族锚必绿（en/zh 两档各自命中，互不误吞成功回执）', () => {
  for (const [fixture, predicate, label] of [
    [disabledEn, selectionDisabledRejection, 'selectionDisabled en'],
    [disabledZh, selectionDisabledRejection, 'selectionDisabled zh'],
    [notAllowedEn, (t) => routeNotAllowedRejection(t, 'zai', 'glm-5.3'), 'routeNotAllowed en'],
    [notAllowedZh, (t) => routeNotAllowedRejection(t, 'zai', 'glm-5.3'), 'routeNotAllowed zh'],
    [unavailableEn, policyUnavailableRejection, 'policyUnavailable en'],
    [unavailableZh, policyUnavailableRejection, 'policyUnavailable zh'],
    [readFailedEn, policyReadFailedRejection, 'policyReadFailed en'],
    [readFailedZh, policyReadFailedRejection, 'policyReadFailed zh'],
    [recheckReadEn, recheckReadFailedRejection, 'routeRecheckReadFailed en'],
    [recheckReadZh, recheckReadFailedRejection, 'routeRecheckReadFailed zh'],
    [recheckEn, recheckFailedRejection, 'routeRecheckFailed en'],
    [recheckZh, recheckFailedRejection, 'routeRecheckFailed zh']
  ]) {
    assert.equal(predicate(fixture), true, `${label}：${fixture}`);
  }
  // 成功回执与继承回执不是拒绝。
  assert.equal(readablePolicyRejection(requestedEn), false, 'requested 回执不是拒绝');
  assert.equal(readablePolicyRejection(inheritedZh), false, '继承回执不是拒绝');
  // 并集判据覆盖六族。
  for (const fixture of [disabledEn, notAllowedZh, unavailableEn, readFailedZh, recheckReadEn, recheckEn]) {
    assert.equal(readablePolicyRejection(fixture), true);
  }
  // 三分互斥：重读读取失败不得命中「名单撤销」锚，反之亦然（分键不粘连）。
  assert.equal(recheckFailedRejection(recheckReadEn), false, '读取失败文案不得命中撤销锚');
  assert.equal(recheckReadFailedRejection(recheckEn), false, '撤销文案不得命中读取失败锚');
});

test('名单外拒绝必须指路查询工具（需求 §2.3.1 末条）', () => {
  // 指路判据内建在 routeNotAllowedRejection；构造一个去掉指路句的残文作负控。
  const stripped = notAllowedEn.replace(/; call async_list_subagent_models.*$/, '');
  assert.notEqual(stripped, notAllowedEn, '负控前提：剥离必须真的改到文案');
  assert.equal(routeNotAllowedRejection(notAllowedEn), true, '完整文案命中');
  assert.equal(routeNotAllowedRejection(stripped), false, '去掉指路句后不得命中（判据锁指路）');
});

test('继承标记判据：继承/笼统继承命中，requested 回执不命中（两判据互斥）', () => {
  for (const fixture of [inheritedEn, inheritedZh, inheritsOnlyEn, inheritsOnlyZh]) {
    assert.equal(inheritedRouteNote(fixture), true, `应命中继承标记：…${fixture.slice(-80)}`);
  }
  assert.equal(inheritedRouteNote(requestedEn), false);
  assert.equal(inheritedRouteNote(requestedZh), false);
});

test('judgeAgentRouting 汇总：先拒、后免路由重试的实录形状判 not-ok 且两类读数并见', () => {
  // 名单外拒绝 + 免路由重试的继承回执：裸路由串匹配在这组结果上会绿——判据必须红。
  const verdict = judgeAgentRouting([notAllowedZh, inheritedZh], 'zai', 'glm-5.3');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.sawNotAllowed, true);
  assert.equal(verdict.sawInherited, true);
  assert.equal(verdict.sawRequested, false);
  assert.equal(verdict.count, 2);
  // 期望形状：requested 回执在场 → ok，拒绝读数如实保留。
  const restored = judgeAgentRouting([notAllowedEn, requestedEn], 'zai', 'glm-5.3');
  assert.equal(restored.ok, true);
  assert.equal(restored.sawRequested, true);
  assert.equal(restored.sawNotAllowed, true, '读数如实：拒绝在场就报在场（ok 由 requested 决定）');
});

test('查询工具适用性锚必绿（§2.3.4 双向差异；en/zh 真渲染，互不误吞）', () => {
  // 渲染形状复刻 lib/list-models.js 的 applicability 行（verdict + basis 拼句）。
  const applicabilityLine = (lang, verdictKey, basisKey, vars = {}) => t(lang, 'render.list.applicability', {
    target: 'async_agent',
    verdict: t(lang, verdictKey),
    basis: t(lang, basisKey, vars)
  });
  const allowedEn = applicabilityLine('en', 'list.verdict.allowed', 'list.basis.asyncCurrent', { count: 1 });
  const allowedZh = applicabilityLine('zh', 'list.verdict.allowed', 'list.basis.asyncCurrent', { count: 1 });
  const disabledEn = applicabilityLine('en', 'list.verdict.notAllowed', 'list.basis.asyncDisabled');
  const disabledZh = applicabilityLine('zh', 'list.verdict.notAllowed', 'list.basis.asyncDisabled');

  assert.equal(queryVerdictAllowed(allowedEn), true, `en 允许夹具：${allowedEn}`);
  assert.equal(queryVerdictAllowed(allowedZh), true, `zh 允许夹具：${allowedZh}`);
  assert.equal(queryVerdictDisabled(disabledEn), true, `en 不允许夹具：${disabledEn}`);
  assert.equal(queryVerdictDisabled(disabledZh), true, `zh 不允许夹具：${disabledZh}`);
  // 双向互斥：开状态的行不得命中关判据，反之亦然（同一行只会判一个方向）。
  assert.equal(queryVerdictDisabled(allowedEn), false, '允许行不得命中不允许判据');
  assert.equal(queryVerdictAllowed(disabledZh), false, '不允许行不得命中允许判据');
});
