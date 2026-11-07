/**
 * 子代理目标适配的观察基准直测。
 *
 * `AgentTarget` 的入口检查（`entryCheck`）与跨调用登记（`noteReported`／
 * `clearBaseline`／`baseline`）此前只经 wait-delivery 的形状用例间接覆盖——
 * 本文件直接钉住四类分支：停止态首次确认／未报告翻转、已报告静止不重复、
 * 恢复运行报告一次、unknown 进等待。模块纯本地（无宿主链依赖），不需要
 * host gate。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentTarget, clearAgentBaselines } from '../lib/wait-agent-target.js';

/** 最小 ctx：注册表观察按状态表驱动（`get` 抛错＝unknown 形态）。 */
function ctxWith(statusById, { throws = false } = {}) {
  return {
    agents: {
      get: (id) => {
        if (throws) throw new Error('registry unreadable');
        const status = statusById[id];
        return status === undefined ? undefined : { id, status };
      }
    },
    subagents: { listChildren: async () => [] }
  };
}

/** 每用例独立主体（模块级登记按 owner×agentId 键控，避免用例间串扰）。 */
let seq = 0;
function target(statusById, options = {}) {
  seq += 1;
  return new AgentTarget({
    ctx: ctxWith(statusById, options),
    config: { agentLang: 'en' },
    agentId: 'child-a',
    owner: `wat-owner-${seq}`,
    t: () => ''
  });
}

test('入口检查：无登记＋查到静止＝首次确认，停止态立即返回一次', () => {
  const a = target({ 'child-a': 'idle' });
  assert.deepEqual(a.entryCheck(), { action: 'stop-once', observed: 'idle', reported: undefined },
    '无登记的 idle 是首次确认——stop-once（不空等、不冒称成功）');
  const b = target({ 'child-a': 'absent' });
  assert.equal(b.entryCheck().action, 'stop-once', '无驻留同档（不据此宣称终结）');
});

test('入口检查：登记为运行＋查到静止＝未报告翻转，停止态返回一次', () => {
  const a = target({ 'child-a': 'idle' });
  a.noteReported('running');
  const check = a.entryCheck();
  assert.equal(check.action, 'stop-once', 'running→idle 的翻转尚未向主体报告过');
  assert.equal(check.reported, 'running', '凭据带旧登记（说明停在状态转为 idle）');
});

test('入口检查：登记同态静止＝已报告静止，不重复交回，进入等待', () => {
  const a = target({ 'child-a': 'idle' });
  a.noteReported('idle');
  assert.equal(a.entryCheck().action, 'wait', '同一停止态不重复交回——等待新变化');
});

test('入口检查：登记为静止＋查到 running＝恢复运行，立即报告一次变化', () => {
  const a = target({ 'child-a': 'running' });
  a.noteReported('idle');
  const check = a.entryCheck();
  assert.equal(check.action, 'changed-once', '静止→运行是恢复，立即报告一次');
  assert.equal(check.reported, 'idle');
  const b = target({ 'child-a': 'running' });
  b.noteReported('absent');
  assert.equal(b.entryCheck().action, 'changed-once', '无驻留→运行同款恢复');
});

test('入口检查：登记为 running＋查到 running＝静态，进入等待；unknown 进等待', () => {
  const a = target({ 'child-a': 'running' });
  a.noteReported('running');
  assert.equal(a.entryCheck().action, 'wait', '持续运行且无新消息不构成变化');
  const broken = target({}, { throws: true });
  broken.noteReported('running');
  assert.equal(broken.entryCheck().action, 'wait', '注册表读错（unknown）不制造停止也不打断等待');
});

test('登记生命周期：翻转覆盖、查无清除、按主体×目标隔离', () => {
  const a = target({ 'child-a': 'idle' });
  assert.equal(a.baseline(), undefined, '初值无登记');
  a.noteReported('running');
  assert.equal(a.baseline(), 'running');
  a.noteReported('idle');
  assert.equal(a.baseline(), 'idle', '状态翻转即覆盖（只存最近状态）');
  a.clearBaseline();
  assert.equal(a.baseline(), undefined, '存在屏障确认查无时清除');

  // 隔离：同一目标 id 在另一主体下登记互不可见。
  const other = target({ 'child-a': 'idle' });
  other.noteReported('running');
  const fresh = target({ 'child-a': 'idle' });
  assert.equal(fresh.baseline(), undefined, '主体×目标复合键——他主体的登记不串扰');
});

test('RA-BASELINE-LIFECYCLE：全量清理覆盖不同主体的登记', () => {
  const a = target({ 'child-a': 'idle' });
  const b = target({ 'child-a': 'running' });
  a.noteReported('idle');
  b.noteReported('running');
  clearAgentBaselines();
  assert.equal(a.baseline(), undefined);
  assert.equal(b.baseline(), undefined);
});

test('RA-BASELINE-LIFECYCLE：长期静止比较不被无关写入清除——已报 idle 不重复交回', (t) => {
  // 原发现者假钟反例之一：已报 idle 八天后的无关写入不得把登记清掉——清除会使
  // 同一静止目标被当「首次确认」再交一次（重复停止说明）。清理只按确证生命周
  // 期（末行卸载／确认查无），不按龄清扫。
  clearAgentBaselines();
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const still = target({ 'child-a': 'idle' });
  still.noteReported('idle');
  assert.equal(still.entryCheck().action, 'wait', '已报告静止不重复交回');
  now += 8 * 24 * 60 * 60 * 1000;
  target({ 'other-child': 'running' }).noteReported('running');
  const check = still.entryCheck();
  assert.equal(check.action, 'wait', '八天后仍是已报告静止——不因无关写入退回首次确认');
  assert.equal(check.reported, 'idle', '基准仍在，凭据完整');
  clearAgentBaselines();
});

test('RA-BASELINE-LIFECYCLE：长期静止后的恢复变化不被吸收——changed-once 照报', (t) => {
  // 原发现者假钟反例之二：静止基准被清后，恢复 running 会被吸收成「无基准的
  // 静态」而漏报 changed-once。清理不按龄，比较语义跨任意间隔保持。
  clearAgentBaselines();
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const resumed = target({ 'child-a': 'running' });
  resumed.noteReported('idle');
  now += 8 * 24 * 60 * 60 * 1000;
  target({ 'other-child': 'running' }).noteReported('running');
  const check = resumed.entryCheck();
  assert.equal(check.action, 'changed-once', '静止→运行的恢复照报一次变化');
  assert.equal(check.reported, 'idle');
  clearAgentBaselines();
});
