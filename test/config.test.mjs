/**
 * 配置、夹紧与边界的单测（对应 `docs/design.md` §3/§11.1，需求 R1/R2/R3 的"有界"）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, TOOL_NAMES, clamp, resolveConfig, resolveWait, resolveYield } from '../lib/config.js';

test('clamp：缺省取默认值，越界被夹紧', () => {
  assert.equal(clamp(undefined, 20000, 1000, 600000), 20000);
  assert.equal(clamp(null, 20000, 1000, 600000), 20000);
  assert.equal(clamp(5, 20000, 1000, 600000), 1000, '低于下界应抬到下界');
  assert.equal(clamp(9e9, 20000, 1000, 600000), 600000, '高于上界应压到上界');
  assert.equal(clamp(30000, 20000, 1000, 600000), 30000);
});

test('resolveConfig：默认值符合需求 §5 的约定', () => {
  const c = resolveConfig({ toolName: 'async_run' });
  assert.equal(c.defaultYieldMs, 20000);
  assert.equal(c.defaultWaitMs, 30000);
  assert.equal(c.minWaitMs, 250);
  assert.equal(c.maxWaitMs, 600000);
  assert.equal(c.jobKind, 'async-command');
  assert.ok(Object.isFrozen(c), '生效配置应被冻结');
});

test('resolveConfig：非法配置 fail-fast', () => {
  // 单值下界现在由 **schema** 拦（`Config` 的 `.min(1)`），错误消息来自 schemastery。
  // 这比"到 resolveConfig 才抛"更早、更清楚：设置页用的就是这份 schema，
  // 所以非法值在**保存那一刻**就被拒，而不是等到某次工具调用（R5 的 P1-3）。
  assert.throws(() => resolveConfig({ toolName: 'async_run', minYieldMs: 0 }), /expected number >= 1/);
  assert.throws(() => resolveConfig({ toolName: 'async_run', maxWaitMs: -1 }), /expected number >= 1/);
  assert.throws(() => resolveConfig({ toolName: 'async_run', jobKind: '' }), /expected string/);
  // 跨字段约束 schema 表达不了，仍由 resolveConfig 自己查。
  assert.throws(() => resolveConfig({ toolName: 'async_run', minYieldMs: 5000, maxYieldMs: 1000 }), /minYieldMs > maxYieldMs/);
  assert.throws(() => resolveConfig({ toolName: 'async_run', minWaitMs: 900, maxWaitMs: 800 }), /minWaitMs > maxWaitMs/);
  assert.throws(() => resolveConfig({ toolName: 'async_run', defaultYieldMs: 1 }), /must lie within/);
  assert.throws(() => resolveConfig({ toolName: 'async_run', defaultWaitMs: 1 }), /must lie within/);
});

test('resolveConfig：subagentProvider 空串/空白/缺省回默认（与 jobKind 有意不同）', () => {
  // D11 裁决：jobKind 空串**抛错**（作业身份不许含糊），subagentProvider 空白**回默认**——
  // 后端名是"下次调用才消费"的间接值，回退到 'spawn' 比把用户锁死在报错里更合适。
  // 这条用例守的正是这个裁决：谁按"字符串字段一致性"把它改成抛错，这里必红。
  assert.equal(resolveConfig({ toolName: 'async_agent', subagentProvider: '' }).subagentProvider, 'spawn');
  assert.equal(resolveConfig({ toolName: 'async_agent', subagentProvider: '   ' }).subagentProvider, 'spawn',
    '纯空白 trim 后视为未设置');
  assert.equal(resolveConfig({ toolName: 'async_agent', subagentProvider: undefined }).subagentProvider, 'spawn');
  assert.equal(resolveConfig({ toolName: 'async_agent' }).subagentProvider, 'spawn', '缺省即默认后端');
  // 有效值只 trim，不改写。
  assert.equal(resolveConfig({ toolName: 'async_agent', subagentProvider: ' fork ' }).subagentProvider, 'fork',
    '首尾空白剥掉、名字本身原样保留（含空格的怪名也放行——执行期有可读错误兜底）');
});

test('resolveWait：wait_ms 必填，缺失必须报错而不是静默取默认值', () => {
  const c = resolveConfig({ toolName: 'async_run' });
  assert.throws(() => resolveWait(undefined, c), /required and bounded/);
  assert.throws(() => resolveWait(null, c), /required and bounded/);
  assert.equal(resolveWait(1000, c), 1000);
  assert.equal(resolveWait(1, c), c.minWaitMs, '低于下界抬起');
  assert.equal(resolveWait(9e9, c), c.maxWaitMs, '高于上界压下 —— 调用者不能超过我们的上限');
});

test('resolveYield：缺省取默认值，超出范围被夹紧', () => {
  const c = resolveConfig({ toolName: 'async_run' });
  assert.equal(resolveYield(undefined, c), c.defaultYieldMs);
  assert.equal(resolveYield(999999999, c), c.maxYieldMs);
  assert.equal(resolveYield(1, c), c.minYieldMs);
});

test('Config schema 暴露 toolName 且只接受登记的全部工具名（五个）', () => {
  // ⚠️ 遍历 `TOOL_NAMES` 而**不是手抄四个名字**：这条判据原来手抄了四个，
  // 第五个（`async_workflow`）加进来时没跟上——于是"从登记表里删掉一个工具名"
  // 这个变异**抓不住**（手抄清单里那个名字照样能过 `Config()`）。
  // 名单漏一项就是假绿，所以清单只能有一个来源。个数断言是第二道锁：
  // 加工具时它逼你回来确认一次。
  for (const toolName of TOOL_NAMES) {
    assert.equal(Config({ toolName }).toolName, toolName);
  }
  assert.equal(TOOL_NAMES.length, 5,
    '工具名清单变了：同步这条断言、README 的取值列表与预设补丁的行数');
  assert.throws(() => Config({ toolName: 'nope' }), /async_run.*async_wait_job.*async_wait_agent.*async_agent/s, '错误文案必须列出可选值，便于排查');
});

test('toolName 缺省 = 宿主角色：不得抛错，也不得回填默认值（单包化）', () => {
  // 旧判据（GLM 复审 G1）：`Config({})` 必须抛错，防止漏写静默落到 `async_run`。
  // 单包化后**语义变了**：宿主行（本包 `cordis.patch.yml` 插进宿主平面的那一行）
  // 合法地没有 `toolName`，`Config({})` 必须放行，入口按缺省分派宿主半边（不注册工具）。
  //
  // G1 防的那件事没变，防法换了：
  // - **不得回填默认值**——`.default(x)` 会让宿主行静默变成"注册工具 x 的行"，
  //   工具泄漏进全局工具层（R4），比旧缺陷更糟；
  // - 缺省时入口分派到宿主半边，**一个工具都不注册**（`test/two-planes.test.mjs` 的
  //   T12 行为断言），"少写字段"仍然不等于"装上某个工具"。
  //
  // ⚠️ 这条判据要能**失败**：若有人把 default 加回去，`Config({}).toolName` 变成
  // `'async_run'` ⇒ 本用例红；若把 `.required()` 加回去，`Config({})` 抛错 ⇒ 同样红。
  const empty = Config({});
  assert.equal(empty.toolName, undefined, '缺省 toolName 必须保持缺省，不得回填默认值');
  assert.equal('toolName' in empty, false, '结果里干脆不该有这个键（宿主角色的行没有工具身份）');
  // 反向：显式给了就必须原样保留（证明上面那条不是"什么都吞"）。
  assert.equal(Config({ toolName: 'async_wait_agent' }).toolName, 'async_wait_agent');
});

test('resolveConfig：死配置 embedBudgetsInDescription 已被删除（N11）', () => {
  const c = resolveConfig({ toolName: 'async_run' });
  assert.equal(
    'embedBudgetsInDescription' in c,
    false,
    '它是关不掉的死开关：R5 是硬需求，描述里的预算数字不允许通过配置去掉'
  );
});
