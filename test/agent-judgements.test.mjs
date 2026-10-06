/**
 * `verify/agent-judgements.mjs`的单测。
 *
 * 三件按 N1「测试覆盖」立的面：
 * 1. **requested note 必绿**：lib/text.js 真渲染的 requested 回执（en/zh）命中；
 * 2. **继承 note 必红**（能红证明）：同样含 `zai/glm-5.3` 路由串的继承回执
 *    **不得**命中 requested 判据——并对照证死旧判据（裸路由串匹配）
 *    确实会命中它们，即被关掉的假绿机制；
 * 3. **拒绝错误锚必绿**：`error.noPolicy` 的两档真渲染文案命中，且不误吞成功 note。
 *
 * 夹具全部经 `t()` 从 `lib/text.js` 现渲染（不手抄句子）：lib 侧措辞漂移 →
 * 判据锚过期 → 这里先红，锚与词典不会静默分叉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestedRouteNote, inheritedRouteNote, noPolicyRejection, judgeAgentRouting } from '../verify/agent-judgements.mjs';
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
// 拒绝夹具：转录里的错误结果形状（lib/agent.js throw 的 Error 文本）。
const noPolicyEn = `Error: ${LOG_PREFIX} ${t('en', 'error.noPolicy')}`;
const noPolicyZh = `Error: ${LOG_PREFIX} ${t('zh', 'error.noPolicy')}`;

test('requested note 必绿（en/zh 两档，lib 真渲染回执）', () => {
  assert.equal(requestedRouteNote(requestedEn, 'zai', 'glm-5.3'), true, `en 夹具：${requestedEn.slice(-80)}`);
  assert.equal(requestedRouteNote(requestedZh, 'zai', 'glm-5.3'), true, `zh 夹具：${requestedZh.slice(-80)}`);
});

test('能红证明：继承 note 必红——旧判据的假绿洞已关', () => {
  // 继承回执（同路由串）与笼统继承形态都必须不命中 requested 判据。
  for (const fixture of [inheritedEn, inheritedZh, inheritsOnlyEn, inheritsOnlyZh]) {
    assert.equal(requestedRouteNote(fixture, 'zai', 'glm-5.3'), false,
      `继承 note 不得命中 requested 判据：…${fixture.slice(-80)}`);
  }
  // 对照：此前的旧判据（acceptance-017 相位内的裸路由串匹配）确实命中继承 note
  // ——这就是「requested 被接受」曾被误判为真的机制，在档防回归。
  const legacyLoose = (text) => /zai/.test(text) && /glm-5\.3/.test(text);
  assert.equal(legacyLoose(inheritedEn), true, '对照前提失效：en 继承夹具应含路由串');
  assert.equal(legacyLoose(inheritedZh), true, '对照前提失效：zh 继承夹具应含路由串');
  assert.equal(legacyLoose(inheritsOnlyEn), false, '笼统继承形态本就不含路由串');
});

test('无 policy 拒绝锚必绿（en/zh），且不误吞成功回执', () => {
  assert.equal(noPolicyRejection(noPolicyEn), true, `en 夹具：${noPolicyEn}`);
  assert.equal(noPolicyRejection(noPolicyZh), true, `zh 夹具：${noPolicyZh}`);
  assert.equal(noPolicyRejection(requestedEn), false, 'requested 回执不是拒绝');
  assert.equal(noPolicyRejection(requestedZh), false, 'requested 回执不是拒绝');
  assert.equal(noPolicyRejection(inheritedEn), false, '继承回执不是拒绝');
});

test('继承标记判据：继承/笼统继承命中，requested 回执不命中（两判据互斥）', () => {
  for (const fixture of [inheritedEn, inheritedZh, inheritsOnlyEn, inheritsOnlyZh]) {
    assert.equal(inheritedRouteNote(fixture), true, `应命中继承标记：…${fixture.slice(-80)}`);
  }
  assert.equal(inheritedRouteNote(requestedEn), false);
  assert.equal(inheritedRouteNote(requestedZh), false);
});

test('judgeAgentRouting 汇总：R38 实录形状（先拒、后免路由重试）判 not-ok 且三读数并见', () => {
  // verify/logs/acc017-agent.json（0e3fa73 版）的实录形状：
  // results[0] = noPolicy 拒绝错误，results[1] = 免路由重试的继承回执。
  const verdict = judgeAgentRouting([noPolicyZh, inheritedZh], 'zai', 'glm-5.3');
  assert.equal(verdict.ok, false, '旧判据在这组结果上会绿——新判据必须红');
  assert.equal(verdict.sawNoPolicy, true);
  assert.equal(verdict.sawInherited, true);
  assert.equal(verdict.sawRequested, false);
  assert.equal(verdict.count, 2);
  // R40 落地后的期望形状：requested 回执在场 → ok，拒绝锚缺席。
  const restored = judgeAgentRouting([noPolicyEn, requestedEn], 'zai', 'glm-5.3');
  assert.equal(restored.ok, true);
  assert.equal(restored.sawRequested, true);
  assert.equal(restored.sawNoPolicy, true, '读数如实：拒绝在场就报在场（ok 由 requested 决定）');
});
