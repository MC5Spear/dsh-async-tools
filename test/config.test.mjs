/**
 * 配置、夹紧与边界的单测（对应 `docs/design.md` §2/§5.1，需求 §2 的"有界"约定
 * 与 §5.1 的跨字段拦截）。
 *
 * 分两段：
 * - 单元段（离线可跑）：根形态、双向解包、嵌套禁令、自续序列化、武装两态、
 *   两侧判据对账与既有夹紧/枚举/身份透传判据；
 * - 进程内段（宿主锚在场才跑）：真实 loader／config-editor／settings 链上的
 *   describe 投影、写入拒绝、行身份保护、两态启动与运行中非法重载（替身插件
 *   `test/_host-row-standin.mjs` 挂真实 `Config` 与真实接线）。
 *
 * 武装位是模块级状态（宿主行与工具行共用同一模块实例，设计 §5.1）：依赖容忍态
 * 的用例入口先复位，武装用例收尾复位——进程内整链测试同进程串行，不互相污染。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Config, TOOL_NAMES, clamp, resolveConfig, resolveWait, resolveYield,
  assertCrossFieldOrder, setConfigValidationArmed, isConfigValidationArmed,
  isOwnConfigCandidate
} from '../lib/config.js';
import { HOST_SKIP_REASON, loadOfflineSafe } from './_host-gate.mjs';

// ───────────────────────────── 单元段（离线可跑） ─────────────────────────────

test('clamp：缺省取默认值，越界被夹紧', () => {
  assert.equal(clamp(undefined, 20000, 1000, 600000), 20000);
  assert.equal(clamp(null, 20000, 1000, 600000), 20000);
  assert.equal(clamp(5, 20000, 1000, 600000), 1000, '低于下界应抬到下界');
  assert.equal(clamp(9e9, 20000, 1000, 600000), 600000, '高于上界应压到上界');
  assert.equal(clamp(30000, 20000, 1000, 600000), 30000);
});

test('isOwnConfigCandidate：waterfall 候选归属甄别（外来行不得进本包自检）', () => {
  // 甄别标记三形态：带 toolName 的候选须是本包五名之一；不带 toolName 的
  // 候选（宿主行全量 / volatile 部分补丁 / simplify 最小写回）须整体落在
  // settings 字段键集内。真实实例启动日志实证过外来行（subagent /
  // subagent_fork）流经本包监听的形态——甄别缺失时它们会制造假降级登记。
  for (const toolName of TOOL_NAMES) {
    assert.equal(isOwnConfigCandidate({ toolName }), true, `本包工具行候选：${toolName}`);
  }
  assert.equal(isOwnConfigCandidate({ toolName: 'subagent' }), false, '外来工具行（宿主 subagent）');
  assert.equal(isOwnConfigCandidate({ toolName: 'subagent', models: ['m'] }), false, '外来工具行带扩展键');
  assert.equal(isOwnConfigCandidate({ settings: { defaultWaitMs: 30000 } }), true, '宿主行全量（settings 子树全为本包键）');
  assert.equal(isOwnConfigCandidate({ settings: { defaultWaitMs: 1 } }), true, 'volatile 部分补丁（嵌套）');
  assert.equal(isOwnConfigCandidate({ defaultWaitMs: 1 }), true, 'volatile 部分补丁（平铺）');
  assert.equal(isOwnConfigCandidate({ settings: { defaultWaitMs: 1, foreignKey: true } }), false, 'settings 混入外来键');
  assert.equal(isOwnConfigCandidate({ defaultWaitMs: 1, host: '127.0.0.1' }), false, '平铺混入外来键（如 webserver 行）');
  assert.equal(isOwnConfigCandidate({ models: ['a'] }), false, '纯外来键行');
  assert.equal(isOwnConfigCandidate({}), false, '空候选不认领（无标记不猜测）');
  assert.equal(isOwnConfigCandidate(undefined), false, '缺席候选');
  assert.equal(isOwnConfigCandidate('not-an-object'), false, '非对象候选');
});

test('resolveConfig：默认值符合需求 §5 的约定', () => {
  setConfigValidationArmed(false);
  const c = resolveConfig({ toolName: 'async_run' });
  assert.equal(c.defaultYieldMs, 20000);
  assert.equal(c.defaultWaitMs, 30000);
  assert.equal(c.minWaitMs, 250);
  assert.equal(c.maxWaitMs, 600000);
  assert.equal(c.jobKind, 'async-command');
  assert.ok(Object.isFrozen(c), '生效配置应被冻结');
});

test('根形态：settings 子树是唯一的 volatile 节点，17 字段默认齐（设计 §5.1）', () => {
  setConfigValidationArmed(false);
  const empty = Config({});
  assert.equal(typeof empty?.settings?.get, 'function',
    'settings 固定路径产生一个 Ref（快照解包取该 Ref 再逐字段）');
  const settings = empty.settings.get();
  const expected = {
    defaultYieldMs: 20000, minYieldMs: 1000, maxYieldMs: 600000,
    defaultWaitMs: 30000, minWaitMs: 250, maxWaitMs: 600000, pollIntervalMs: 500,
    maxResultChars: 30000, jobKind: 'async-command', subagentProvider: 'spawn',
    uiLang: 'auto', agentLang: 'en', silentFailureGuard: false, askTakeover: false,
    askTimeoutMs: 60000, askExtendMs: 60000, askUiSeat: 'sidebar'
  };
  assert.deepEqual({ ...settings }, expected, '17 字段默认值一项不差');
});

test('双向输入形态：活根（settings 为 Ref）与平铺输入等价（设计 §5.1）', () => {
  setConfigValidationArmed(false);
  // 嵌套 Ref = loader 给 apply 第二参的活根形态；平铺 = 测试/直调便利形态
  // （等价于 settings 子树内容，normalize 抬身份、搬子树）。
  const viaRef = resolveConfig({ settings: { get: () => ({ minWaitMs: 700 }) } });
  assert.equal(viaRef.minWaitMs, 700);
  const viaNested = resolveConfig({ toolName: 'async_run', settings: { minWaitMs: 700 } });
  assert.equal(viaNested.minWaitMs, 700);
  assert.equal(viaNested.toolName, 'async_run');
  const viaFlat = resolveConfig({ toolName: 'async_run', minWaitMs: 700 });
  assert.equal(viaFlat.minWaitMs, 700, '平铺输入经 normalize 与嵌套输入同判');
  assert.equal(viaFlat.toolName, 'async_run', '平铺输入的身份字段抬回根');
  assert.equal('settings' in viaFlat, false, '输出保持平铺形状（消费者不变）');
  // 字段级假 Ref（旧直调形态）仍然可拆。
  assert.equal(resolveConfig({ silentFailureGuard: { get: () => true } }).silentFailureGuard, true);
});

test('resolveConfig：askUiSeat 默认 sidebar（需求 §5.2），显式两档原样保留', () => {
  setConfigValidationArmed(false);
  // 默认值翻成 sidebar 是需求 §5.2 的验收点：出厂徽标走侧边栏底栏、不占右下角。
  // 显式 overlay/sidebar 都必须原样通过——resolve 不是清洗器，用户显式选的值轮不到它改。
  assert.equal(resolveConfig({ toolName: 'async_agent' }).askUiSeat, 'sidebar',
    '缺省 = sidebar（默认座位的需求锚）');
  assert.equal(resolveConfig({ toolName: 'async_agent', askUiSeat: 'overlay' }).askUiSeat, 'overlay',
    '显式 overlay 保留');
  assert.equal(resolveConfig({ toolName: 'async_agent', askUiSeat: 'sidebar' }).askUiSeat, 'sidebar',
    '显式 sidebar 保留');
  assert.throws(() => resolveConfig({ toolName: 'async_agent', askUiSeat: 'corner' }),
    /askUiSeat|invalid|sidebar/i, '枚举外取值在 schema 层被拒（不静默回默认）');
});

test('Config 枚举字段在写入层拒绝枚举外值并给原因（需求 §5.1/§5.2）', () => {
  setConfigValidationArmed(false);
  // 设置网关（settings/update）按 schema 校验合并后的整份配置——枚举字段用
  // z.union 字面量集合，枚举外的值在**写入那一刻**被拒。报错带字段路径前缀。
  // 值校验落在 settings 子树（根平铺键会被 schema 静默丢弃，测不到判据）。
  assert.throws(() => Config({ settings: { uiLang: 'fr' } }), /uiLang.*(auto|zh|en)/is);
  assert.throws(() => Config({ settings: { agentLang: 'jp' } }), /agentLang.*(en|zh)/is);
  assert.throws(() => Config({ settings: { askUiSeat: 'corner' } }), /askUiSeat.*(sidebar|overlay)/is);
  // 合法值逐档原样通过（resolve 不是清洗器；volatile Ref 经 resolveConfig 拆包后读值）。
  for (const v of ['auto', 'zh', 'en']) assert.equal(resolveConfig({ uiLang: v }).uiLang, v);
  for (const v of ['en', 'zh']) assert.equal(resolveConfig({ agentLang: v }).agentLang, v);
  for (const v of ['sidebar', 'overlay']) assert.equal(resolveConfig({ askUiSeat: v }).askUiSeat, v);
});

test('resolveConfig：owningPreset 透传——无默认、非 volatile 的行身份字段（设计 §6.2）', () => {
  setConfigValidationArmed(false);
  // 行身份只在两份预设补丁的工具行上声明；resolve 不赋默认值（缺省 = 自定义行、
  // 无归属），有则原样透传（不校验枚举：归属判定交给 TAKEOVER_PRESETS 的 has）。
  assert.equal('owningPreset' in resolveConfig({ toolName: 'async_run' }), false,
    '缺省不带键（自定义行语义，不是字符串 undefined）');
  assert.equal(resolveConfig({ toolName: 'async_run', owningPreset: 'dsh-async' }).owningPreset, 'dsh-async');
  assert.equal(resolveConfig({ toolName: 'async_run', owningPreset: 'dsh-async-create' }).owningPreset, 'dsh-async-create');
  assert.equal(resolveConfig({ toolName: 'async_run', owningPreset: 'someone-elses' }).owningPreset, 'someone-elses',
    '枚举外字符串原样透传（has 判定在后）');
  assert.equal(resolveConfig({ owningPreset: 'dsh-async', settings: {} }).owningPreset, 'dsh-async',
    '嵌套输入的身份字段同样透传');
});

test('resolveConfig：非法配置 fail-fast', () => {
  setConfigValidationArmed(false);
  // 单值下界由 **schema** 拦（settings 子树字段的 `.min(1)`），错误消息来自
  // schemastery。这比"到 resolveConfig 才抛"更早、更清楚：设置页用的就是这份
  // schema，所以非法值在**保存那一刻**就被拒，而不是等到某次工具调用。
  assert.throws(() => resolveConfig({ toolName: 'async_run', minYieldMs: 0 }), /expected number >= 1/);
  assert.throws(() => resolveConfig({ toolName: 'async_run', maxWaitMs: -1 }), /expected number >= 1/);
  assert.throws(() => resolveConfig({ toolName: 'async_run', jobKind: '' }), /expected string/);
  // 跨字段约束：容忍态由 resolveConfig 的运行侧判据承接（武装态另测）。
  assert.throws(() => resolveConfig({ toolName: 'async_run', minYieldMs: 5000, maxYieldMs: 1000 }), /minYieldMs > maxYieldMs/);
  assert.throws(() => resolveConfig({ toolName: 'async_run', minWaitMs: 900, maxWaitMs: 800 }), /minWaitMs > maxWaitMs/);
  assert.throws(() => resolveConfig({ toolName: 'async_run', defaultYieldMs: 1 }), /must lie within/);
  assert.throws(() => resolveConfig({ toolName: 'async_run', defaultWaitMs: 1 }), /must lie within/);
  // 嵌套输入与平铺输入同一套判据。
  assert.throws(() => resolveConfig({ settings: { minWaitMs: 900, maxWaitMs: 800 } }), /minWaitMs > maxWaitMs/);
});

test('schemastery 嵌套禁令：volatile 子树内的字段再挂 volatile 在 resolve 期抛错（设计 §5.1 静态依据）', async () => {
  const { default: z } = await import('@deepseek-ai/schemastery');
  // 反面形态：字段逐个 volatile 且整体包 volatile——schemastery 校验
  // "volatile 字段要求无包围 volatile 的固定对象路径"，resolve 整棵根时即抛
  // （与输入数据无关）。这是 17 字段搬进 settings 子树、字段级摘掉 volatile
  // 标记的直接原因。
  const nested = z.object({
    settings: z.transform(
      z.object({ minWaitMs: z.number().default(250).volatile() }),
      (v) => v,
      true
    ).volatile().default({})
  });
  assert.throws(() => nested({}), /volatile fields require a fixed object path/);
});

test('自续序列化：transform callback 经两跳 schema 投影仍可校验（设计 §5.1）', async () => {
  const { default: z } = await import('@deepseek-ai/schemastery');
  setConfigValidationArmed(true);
  try {
    // 服务端近似客户端 decode：z(JSON.parse(JSON.stringify(Config))) 是第一跳，
    // 再序列化一次是第二跳（表单重建一跳、describe 输出一跳）。
    const hop1 = z(JSON.parse(JSON.stringify(Config)));
    assert.throws(() => hop1({ settings: { defaultWaitMs: 1 } }), /cross-field violation/,
      '第一跳后武装拒绝仍在');
    const hop2 = z(JSON.parse(JSON.stringify(hop1)));
    assert.throws(() => hop2({ settings: { defaultWaitMs: 1 } }), /cross-field violation/,
      '第二跳后 callback 仍存活（自续 toJSON 重建自己）');
    assert.equal(hop2({ settings: { defaultWaitMs: 30000 } }).settings.get().defaultWaitMs, 30000,
      '两跳后合法值照常通过');
    // 反例：不带自续 toJSON 的 callback——第一跳仍可校验（toString 缺省即源码文本），
    // 第二跳复活副本丢 callback，transform 抛 "callback is not a function"。
    // 这正是 callback 必须自续的原因。
    const plainNode = z.transform(
      z.object({ minWaitMs: z.number().default(250), maxWaitMs: z.number().default(600000) }),
      (v) => {
        if (v.minWaitMs > v.maxWaitMs) throw new Error('plain violation');
        return v;
      },
      true
    ).volatile().default({});
    const plainRoot = z.object({ settings: plainNode });
    const plain1 = z(JSON.parse(JSON.stringify(plainRoot)));
    assert.throws(() => plain1({ settings: { minWaitMs: 9, maxWaitMs: 1 } }), /plain violation/,
      '反例：无自续一跳仍可校验');
    const plain2 = z(JSON.parse(JSON.stringify(plain1)));
    assert.throws(() => plain2({ settings: { minWaitMs: 9, maxWaitMs: 1 } }), /callback is not a function/,
      '反例：无自续两跳后 callback 丢失');
  } finally {
    setConfigValidationArmed(false);
  }
});

test('武装态：五条链式不等式在 schema 层拒绝，消息双侧字段名齐备（设计 §5.1/§5.4）', () => {
  setConfigValidationArmed(true);
  try {
    assert.equal(isConfigValidationArmed(), true, '武装状态位可读');
    const cases = [
      [{ minYieldMs: 5000, maxYieldMs: 1000 }, /minYieldMs=5000 > maxYieldMs=1000/],
      [{ defaultYieldMs: 1, minYieldMs: 1000 }, /defaultYieldMs=1 outside \[minYieldMs=1000, maxYieldMs=600000\]/],
      [{ minWaitMs: 500, maxWaitMs: 100 }, /minWaitMs=500 > maxWaitMs=100/],
      [{ defaultWaitMs: 1 }, /defaultWaitMs=1 outside \[minWaitMs=250, maxWaitMs=600000\]/],
      [{ pollIntervalMs: 900, maxWaitMs: 100 }, /pollIntervalMs=900 > maxWaitMs=100/]
    ];
    for (const [value, pattern] of cases) {
      assert.throws(() => Config({ settings: { ...value } }), (error) => {
        assert.match(error.message, /^\[async-tools\] cross-field violation: /);
        assert.match(error.message, pattern);
        return true;
      }, `武装态必须拒绝 ${JSON.stringify(value)}`);
    }
    // 多条违例合并为一条消息（'; ' 连接；默认值自身会带出区间违例，中间项不逐字断言）。
    assert.throws(
      () => Config({ settings: { minYieldMs: 5000, maxYieldMs: 1000, minWaitMs: 500, maxWaitMs: 100 } }),
      /minYieldMs=5000 > maxYieldMs=1000[^\n]*;[^\n]*minWaitMs=500 > maxWaitMs=100/
    );
    // 容忍态对照：同款非法值放行（启动容错），运行侧第二道防线仍拒。
    setConfigValidationArmed(false);
    const tolerated = Config({ settings: { defaultWaitMs: 1 } });
    assert.equal(tolerated.settings.get().defaultWaitMs, 1, '容忍态原样放行非法值');
    assert.throws(() => resolveConfig({ settings: { defaultWaitMs: 1 } }), /must lie within/,
      '容忍态的运行侧判据（assertCrossFieldOrder）仍拒绝');
  } finally {
    setConfigValidationArmed(false);
  }
});

test('两侧判据对账：武装 callback 与 assertCrossFieldOrder 对同一组值同判（设计 §5.1）', () => {
  // callback 必须自包含（序列化链硬性约束），无法直接引用 ORDERED_PAIRS——
  // 一致性只能靠对账测试锁住：schema 层与运行侧对同一组值给出同一裁决。
  const cases = [
    { minYieldMs: 5000, maxYieldMs: 1000 },
    { defaultYieldMs: 99, minYieldMs: 1, maxYieldMs: 10 },
    { minWaitMs: 500, maxWaitMs: 100 },
    { defaultWaitMs: 99, minWaitMs: 1, maxWaitMs: 10 },
    { pollIntervalMs: 900, maxWaitMs: 100 },
    { minWaitMs: 250, maxWaitMs: 600000 },
    { defaultWaitMs: 30000, minWaitMs: 250, maxWaitMs: 600000 },
    { pollIntervalMs: 500, maxWaitMs: 600000 }
  ];
  setConfigValidationArmed(true);
  try {
    for (const value of cases) {
      let schemaRejected = false;
      let runtimeRejected = false;
      try { Config({ settings: { ...value } }); } catch { schemaRejected = true; }
      try { assertCrossFieldOrder(value); } catch { runtimeRejected = true; }
      assert.equal(schemaRejected, runtimeRejected,
        `两侧裁决必须一致：${JSON.stringify(value)}（schema=${schemaRejected}; runtime=${runtimeRejected}）`);
    }
  } finally {
    setConfigValidationArmed(false);
  }
});

test('resolveConfig：subagentProvider 空串/空白/缺省回默认（与 jobKind 有意不同）', () => {
  setConfigValidationArmed(false);
  // 决定：jobKind 空串**抛错**（作业身份不许含糊），subagentProvider 空白**回默认**——
  // 后端名是"下次调用才消费"的间接值，回退到 'spawn' 比把用户锁死在报错里更合适。
  // 这条用例守的正是这个决定：谁按"字符串字段一致性"把它改成抛错，这里必红。
  assert.equal(resolveConfig({ toolName: 'async_agent', subagentProvider: '' }).subagentProvider, 'spawn');
  assert.equal(resolveConfig({ toolName: 'async_agent', subagentProvider: '   ' }).subagentProvider, 'spawn',
    '纯空白 trim 后视为未设置');
  assert.equal(resolveConfig({ toolName: 'async_agent', subagentProvider: undefined }).subagentProvider, 'spawn');
  assert.equal(resolveConfig({ toolName: 'async_agent' }).subagentProvider, 'spawn', '缺省即默认后端');
  // 有效值只 trim，不改写。
  assert.equal(resolveConfig({ toolName: 'async_agent', subagentProvider: ' fork ' }).subagentProvider, 'fork',
    '首尾空白剥掉、名字本身原样保留（含空格的怪名也放行——执行期有可读错误承接）');
});

test('resolveWait：wait_ms 必填，缺失必须报错而不是静默取默认值', () => {
  setConfigValidationArmed(false);
  const c = resolveConfig({ toolName: 'async_run' });
  assert.throws(() => resolveWait(undefined, c), /required and bounded/);
  assert.throws(() => resolveWait(null, c), /required and bounded/);
  assert.equal(resolveWait(1000, c), 1000);
  assert.equal(resolveWait(1, c), c.minWaitMs, '低于下界抬起');
  assert.equal(resolveWait(9e9, c), c.maxWaitMs, '高于上界压下 —— 调用者不能超过我们的上限');
});

test('resolveWait（需求 §5.3）：错误文案随 agentLang 双语——中文档不得静默漏出英文', () => {
  setConfigValidationArmed(false);
  const c = resolveConfig({ toolName: 'async_run', agentLang: 'zh' });
  let message = '';
  try { resolveWait(undefined, c); } catch (error) { message = error.message; }
  assert.match(message, /[一-鿿]/, 'agentLang=zh 时模型可见错误必须含中文');
  assert.match(message, /wait_ms 必填且有界/, '按双语键 error.waitRequired 取中文档文案');
  const en = resolveConfig({ toolName: 'async_run' });
  let enMessage = '';
  try { resolveWait(undefined, en); } catch (error) { enMessage = error.message; }
  assert.match(enMessage, /wait_ms is required and bounded/, '英文档保持既有口径');
});

test('resolveYield：缺省取默认值，超出范围被夹紧', () => {
  setConfigValidationArmed(false);
  const c = resolveConfig({ toolName: 'async_run' });
  assert.equal(resolveYield(undefined, c), c.defaultYieldMs);
  assert.equal(resolveYield(999999999, c), c.maxYieldMs);
  assert.equal(resolveYield(1, c), c.minYieldMs);
});

test('Config schema 暴露 toolName 且只接受登记的全部工具名（五个）', () => {
  setConfigValidationArmed(false);
  // 遍历 `TOOL_NAMES` 而**不是手抄四个名字**：手抄清单在新增工具名时跟不上，
  // "从登记表里删掉一个工具名"这类变异就**抓不住**（手抄清单里那个名字照样能过 `Config()`）。
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
  setConfigValidationArmed(false);
  // `Config({})` 必须放行：宿主行（本包 `cordis.patch.yml` 插进宿主侧的那一行）
  // 合法地没有 `toolName`，入口按缺省分派宿主半边（不注册工具）。
  //
  // 防漏写的法子：
  // - **不得回填默认值**——`.default(x)` 会让宿主行静默变成"注册工具 x 的行"，
  //   工具泄漏进全局工具层（需求 §3.2），比漏写更糟；
  // - 缺省时入口分派到宿主半边，**一个工具都不注册**（`test/two-planes.test.mjs` 的
  //   T12 行为断言），"少写字段"仍然不等于"装上某个工具"。
  //
  // 这条判据要能**失败**：若有人把 default 加回去，`Config({}).toolName` 变成
  // `'async_run'` ⇒ 本用例红；若把 `.required()` 加回去，`Config({})` 抛错 ⇒ 同样红。
  const empty = Config({});
  assert.equal(empty.toolName, undefined, '缺省 toolName 必须保持缺省，不得回填默认值');
  assert.equal('toolName' in empty, false, '结果里干脆不该有这个键（宿主角色的行没有工具身份）');
  // 反向：显式给了就必须原样保留（证明上面那条不是"什么都吞"）。
  assert.equal(Config({ toolName: 'async_wait_agent' }).toolName, 'async_wait_agent');
});

test('resolveConfig：未知配置键不得进入生效配置——embedBudgetsInDescription 不被读取', () => {
  setConfigValidationArmed(false);
  const c = resolveConfig({ toolName: 'async_run' });
  assert.equal(
    'embedBudgetsInDescription' in c,
    false,
    '描述必须使用真实生效的预算数字（需求 §2.1.3），不允许通过配置去掉'
  );
});

// ───────────────────── 进程内段（真实 loader／settings 链） ─────────────────────

/**
 * 工作目录：`repo/.local/tmp/f04-chain`（gitignored；组合目录、profile、
 * 迷你 bundle 的落点）。组合里替身插件按相对路径指回 `test/`——loader 的
 * ModuleLoader 解析走本进程的 resolve 钩子与标准相对解析，插件内的
 * `../lib/*` 导入按插件自身位置解析回仓库。
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const WORK = join(HERE, '..', '.local', 'tmp', 'f04-chain');

const BASE_SETTINGS = {
  defaultYieldMs: 20000, minYieldMs: 1000, maxYieldMs: 600000,
  defaultWaitMs: 30000, minWaitMs: 250, maxWaitMs: 600000, pollIntervalMs: 500,
  maxResultChars: 30000, jobKind: 'async-command', subagentProvider: 'spawn',
  uiLang: 'auto', agentLang: 'en', silentFailureGuard: false, askTakeover: false,
  askTimeoutMs: 60000, askExtendMs: 60000, askUiSeat: 'sidebar'
};

/** 复刻真实 profile 布局：迷你 bundle 用 insert 补丁引入宿主行，否则 edit() 的组合校验会拒写。 */
function prepareProfile(dir, bundleTag, rowId, pluginSpec) {
  rmSync(dir, { recursive: true, force: true });
  const bundleDir = join(dir, 'node_modules', `f04-bundle-${bundleTag}`);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'f04-profile', dsh: { profile: { bundles: [`f04-bundle-${bundleTag}`] } } }, null, 2) + '\n');
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ name: `f04-bundle-${bundleTag}`, dsh: { bundle: { patch: ['./cordis.patch.yml'] } } }, null, 2) + '\n');
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), `- insert:\n  - id: ${rowId}\n    name: "${pluginSpec}"\n`);
}

function prepareDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{}\n');
}

async function bootComposition(profileDir, homeDir, compositionDir, compositionFile) {
  const { Context } = await import('@deepseek-ai/cordis');
  const Loader = (await import('@deepseek-ai/cordis-plugin-loader')).default;
  const ConfigEditor = (await import('@deepseek-ai/dsh-config-editor')).default;
  const SettingsForms = (await import('@deepseek-ai/dsh-settings')).default;
  const { mountRootInclude } = await import('@deepseek-ai/dsh-app-boot');
  const ctx = new Context();
  ctx.baseUrl = pathToFileURL(compositionDir).href + '/';
  ctx.provide('profileContext', {
    name: 'f04',
    home: homeDir,
    dir: profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'),
    installAnchor: join(profileDir, 'package.json'),
    overlays: [],
    telemetryDisabledEnv: ''
  });
  await ctx.plugin(Loader);
  await ctx.plugin(ConfigEditor);
  await ctx.plugin(SettingsForms);
  await mountRootInclude(ctx, join(compositionDir, compositionFile), [], undefined, 'f04');
  await ctx.get('loader')?.await();
  return ctx;
}

/** 客户端 decode 的服务端近似：用宿主 schemastery 重建 form JSON 并校验值。 */
async function clientValidate(formJson, value) {
  const { default: z } = await import('@deepseek-ai/schemastery');
  try {
    const rehydrated = z(formJson);
    rehydrated(value);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 进程内调用链句柄（懒装配：两条用例共用一次 boot）。 */
let chainPromise;

async function getChain() {
  if (chainPromise === undefined) {
    chainPromise = (async () => {
      const standin = await import('./_host-row-standin.mjs');
      const { readSnapshot, readDegraded, clearSnapshot, clearDegraded } = await import('../lib/settings.js');
      rmSync(WORK, { recursive: true, force: true });
      mkdirSync(WORK, { recursive: true });
      const compDir = join(WORK, 'comp');
      const pluginSpec = relative(compDir, join(HERE, '_host-row-standin.mjs')).split(sep).join('/');
      prepareProfile(join(WORK, 'profile'), 'host', 'f04-host', pluginSpec);
      prepareDir(compDir);
      writeFileSync(join(compDir, 'cordis.yml'), [
        '- id: f04-host',
        `  name: ${pluginSpec}`,
        '  config:',
        '    settings:',
        ...Object.entries(BASE_SETTINGS).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`)
      ].join('\n') + '\n');
      const ctx = await bootComposition(join(WORK, 'profile'), join(WORK, 'home'), compDir, 'cordis.yml');
      const loader = ctx.get('loader');
      const settings = ctx.get('settings');
      return {
        standin, ctx, loader, settings, readSnapshot, readDegraded, clearSnapshot, clearDegraded,
        entry: loader.resolve('include:f04-host'),
        ns: 'f04-host',
        liveSettings: () => loader.resolve('include:f04-host')?.fiber?.config?.settings?.get?.()
      };
    })();
  }
  return chainPromise;
}

test('进程内（真实链）：投影形态、写入拒绝与行身份字段保护（设计 §5.1/§8.2 配置页行）', async (t) => {
  const anchors = await Promise.all([
    loadOfflineSafe('@deepseek-ai/cordis'),
    loadOfflineSafe('@deepseek-ai/cordis-plugin-loader'),
    loadOfflineSafe('@deepseek-ai/dsh-config-editor'),
    loadOfflineSafe('@deepseek-ai/dsh-settings'),
    loadOfflineSafe('@deepseek-ai/dsh-app-boot')
  ]);
  if (anchors.some((m) => m === undefined)) {
    t.skip(HOST_SKIP_REASON);
    return;
  }
  const chain = await getChain();
  const { standin, settings, entry, ns, liveSettings } = chain;
  try {
    // ① 合法启动：apply 自检通过即武装。
    assert.equal(entry.fiber?.state, 2, '合法配置必须激活');
    assert.equal(isConfigValidationArmed(), true, '装配侧自检成功后模块处于武装态');
    const view = settings.describe().find((row) => row.ns === ns);
    assert.ok(view !== undefined, 'describe 必须含本 ns（宿主行卡片在场）');

    // ② form 投影：根 object 只有 settings 键；settings 为 transform、内层 17 键、无 volatile 残留。
    const { default: z } = await import('@deepseek-ai/schemastery');
    const rehydrated = z(view.schema);
    const settingsNode = rehydrated.dict?.settings;
    const innerKeys = Object.keys(settingsNode?.inner?.dict ?? {}).sort();
    assert.equal(rehydrated.type, 'object', 'form 根为普通对象');
    assert.equal(settingsNode?.type, 'transform', 'settings 子树是 transform 节点');
    assert.equal(innerKeys.length, 17, '内层 17 字段键齐');
    assert.equal(Object.keys(rehydrated.dict ?? {}).join(','), 'settings', '根只挂 settings（身份字段不进表单）');
    const volatileResidue = [];
    const walkNode = (node, path) => {
      if (node?.meta?.volatile !== undefined) volatileResidue.push(path);
      for (const [k, child] of Object.entries(node?.dict ?? {})) walkNode(child, `${path}.${k}`);
      if (node?.inner) walkNode(node.inner, `${path}()`);
      for (const child of node?.list ?? []) walkNode(child, path);
    };
    walkNode(rehydrated, '$');
    assert.deepEqual(volatileResidue, [], 'form 无 volatile 残留');

    // ③ 值投影：settings 键下 17 字段、无身份键；客户端 decode 近似可校验。
    const valueKeys = Object.keys(view.value ?? {});
    assert.deepEqual(valueKeys, ['settings'], '值投影只有 settings 一键');
    assert.equal(Object.keys(view.value?.settings ?? {}).length, 17, 'settings 下 17 字段齐');
    assert.equal('toolName' in (view.value ?? {}), false, '值投影不带身份键');
    const decode = await clientValidate(view.schema, view.value);
    assert.equal(decode.ok, true, `客户端 decode 近似必须通过：${decode.message ?? ''}`);

    // ④ 武装态跨字段非法保存拒于落盘前（patch 文件不动）。
    const before = existsSync(settings.documentPath) ? readFileSync(settings.documentPath, 'utf8') : null;
    await assert.rejects(
      () => settings.update(ns, { settings: { defaultWaitMs: 1 } }),
      (error) => /cross-field violation/.test(error.message) && /defaultWaitMs=1/.test(error.message) && /minWaitMs=250/.test(error.message),
      '武装态非法保存必须被拒且原因双侧字段名齐备'
    );
    const after = existsSync(settings.documentPath) ? readFileSync(settings.documentPath, 'utf8') : null;
    assert.equal(after, before, '拒绝时 patch 文件不动');

    // ⑤ 平铺形状写入被拒（嵌套形状契约：根平铺键不是 volatile 路径）。
    await assert.rejects(
      () => settings.update(ns, { defaultWaitMs: 40000 }),
      /not volatile/,
      '平铺形状写入必须被路径检查拒绝'
    );

    // ⑥ 行身份字段保护：update 携带身份字段 / mutate 路径写身份 → write 层拒绝、不重挂。
    const uidBefore = entry.fiber?.uid;
    const appliesBefore = standin.STATE.applies;
    await assert.rejects(
      () => settings.update(ns, { toolName: 'async_run', owningPreset: 'dsh-async' }),
      (error) => /toolName/.test(error.message) && /not volatile/.test(error.message),
      'RPC update 携带身份字段必须被拒'
    );
    await assert.rejects(
      () => settings.mutate(ns, [{ op: 'set', path: ['toolName'], value: 'async_run' }]),
      (error) => /toolName/.test(error.message) && /not volatile/.test(error.message),
      'mutate 路径写 toolName 必须被拒'
    );
    assert.equal(entry.fiber?.uid, uidBefore, '身份写入被拒不触发重挂（uid 不变）');
    assert.equal(entry.fiber?.state, 2, '身份写入被拒后行仍激活');
    assert.equal(standin.STATE.applies, appliesBefore, 'apply 未重跑');
    const afterIdentity = existsSync(settings.documentPath) ? readFileSync(settings.documentPath, 'utf8') : null;
    assert.equal(afterIdentity, before, '身份写入被拒未动 patch 文件');

    // ⑦ 文件层身份变更走普通重挂（行身份只能经 profile/补丁文件层变更）。
    await entry.update({ ...entry.options, config: { ...entry.options.config, toolName: 'async_run', owningPreset: 'dsh-async' } });
    await chain.loader.await();
    assert.equal(standin.STATE.applies, appliesBefore + 1, '文件层加 toolName 走重挂（apply 重新装配）');
    assert.equal(entry.fiber?.state, 2, '重挂后行激活（transform 不误拒身份变更）');
    assert.equal(entry.fiber?.config?.toolName, 'async_run', '新装配以新身份物化');
    const viewAfter = settings.describe().find((row) => row.ns === ns);
    assert.deepEqual(Object.keys(viewAfter?.value ?? {}), ['settings'], '重挂后值投影仍无身份键');
    // 摘掉身份，回到宿主角色（后续阶段沿用本行）。
    const restored = { ...entry.options.config };
    delete restored.toolName;
    delete restored.owningPreset;
    await entry.update({ ...entry.options, config: restored });
    await chain.loader.await();
    assert.equal(entry.fiber?.config?.toolName, undefined, '移除身份同样走重挂');

    // ⑧ 合法路径（嵌套形状）：单字段 update、mutate 增删、replace 整组。
    await settings.update(ns, { settings: { defaultWaitMs: 40000 } });
    assert.equal(liveSettings()?.defaultWaitMs, 40000, '合法单字段保存后活 Ref 更新');
    assert.equal(chain.readSnapshot().defaultWaitMs, 40000, '快照重播同步');
    await settings.mutate(ns, [
      { op: 'set', path: ['settings', 'defaultWaitMs'], value: 50000 }
    ]);
    assert.equal(liveSettings()?.defaultWaitMs, 50000, 'mutate set 嵌套路径生效');
    await settings.mutate(ns, [
      { op: 'unset', path: ['settings', 'defaultWaitMs'] }
    ]);
    assert.equal(liveSettings()?.defaultWaitMs, 30000, 'mutate unset 回退继承默认');
    await settings.replace(ns, { settings: { ...BASE_SETTINGS, defaultWaitMs: 35000 } });
    assert.equal(liveSettings()?.defaultWaitMs, 35000, 'replace 整组生效');
    const userView = settings.describe().find((row) => row.ns === ns);
    assert.equal(userView?.user?.settings?.defaultWaitMs, 35000, '用户层嵌套携带新值');
  } finally {
    // 只复位武装位：快照/降级登记留给下一条进程内用例（行还挂着，模块快照
    // 是活状态；末条用例收尾统一清）。
    setConfigValidationArmed(false);
  }
});

test('进程内（真实链）：两态启动与运行中非法重载（设计 §5.1）', async (t) => {
  const anchors = await Promise.all([
    loadOfflineSafe('@deepseek-ai/cordis'),
    loadOfflineSafe('@deepseek-ai/cordis-plugin-loader'),
    loadOfflineSafe('@deepseek-ai/dsh-config-editor'),
    loadOfflineSafe('@deepseek-ai/dsh-settings'),
    loadOfflineSafe('@deepseek-ai/dsh-app-boot')
  ]);
  if (anchors.some((m) => m === undefined)) {
    t.skip(HOST_SKIP_REASON);
    return;
  }
  const chain = await getChain();
  const { standin, settings, ns, liveSettings, loader, readSnapshot, readDegraded } = chain;
  const pluginSpec = relative(join(WORK, 'comp'), join(HERE, '_host-row-standin.mjs')).split(sep).join('/');
  try {
    // ① 运行中非法重载（武装态）：loader 的 resolve 拒绝——refs 不变、不派发
    //    volatile-update、raw 保留；internal/config waterfall 登记降级明细。
    setConfigValidationArmed(true);
    const entry = loader.resolve(`include:${ns}`);
    const appliesBefore = standin.STATE.applies;
    const snapshotBefore = readSnapshot()?.defaultWaitMs;
    assert.notEqual(snapshotBefore, undefined, '前置：快照在场（上一条用例的合法路径已播种）');
    await entry.update({
      ...entry.options,
      config: { ...entry.options.config, settings: { ...entry.options.config.settings, defaultWaitMs: 1 } }
    });
    assert.equal(liveSettings()?.defaultWaitMs, snapshotBefore, '活 Ref 保留旧值（refs 不变）');
    assert.equal(entry.fiber?.state, 2, 'fiber 存活且未重挂');
    assert.equal(standin.STATE.applies, appliesBefore, 'apply 未重跑');
    assert.equal(entry.options.config?.settings?.defaultWaitMs, 1, 'loader 保留非法 raw');
    assert.ok(/recent commit failed self-check/.test(String(readDegraded() ?? '')),
      `internal/config waterfall 必须登记「最近提交原始值自检失败」：${readDegraded()}`);

    // ② 下次合法提交自愈（降级明细清空、快照跟进）。宿主顺序事实：① 的
    //    entry.update 留下挂起重挂，直接再 entry.update 时 volatile-update 的
    //    派发可能落在重挂窗口里（旧接线已摘、新接线未上）——自愈断言改走
    //    settings RPC（经 edit() 的 reconcile 重挂 + 提交），顺序无关。
    await settings.update(ns, { settings: { defaultWaitMs: 30000 } });
    assert.equal(liveSettings()?.defaultWaitMs, 30000, '合法重载后活 Ref 更新');
    assert.equal(readDegraded(), undefined, '合法提交自愈（降级明细清空）');

    // ③ 容忍窗内的登记代价（设计 §5.1）：跨字段非法的 RPC 保存被放行落盘——
    //    refs 吃进非法值，快照保旧＋告警双登记（运行侧第二道防线），页面草稿
    //    校验仍拦；首次合法保存重新武装并自愈。
    //    顺序事实（宿主行为）：entry.update 之后的第一次 edit() 会经 reconcile
    //    重挂主行，apply 重新武装——先做一次合法保存消耗掉挂起重挂，再解除
    //    武装演示容忍窗，另在 loader.create 之前做（create 留下的组合变更同样
    //    会触发重挂）。
    await settings.update(ns, { settings: { defaultWaitMs: 30000 } });
    setConfigValidationArmed(false);
    await settings.update(ns, { settings: { defaultWaitMs: 1 } });
    assert.equal(entry.fiber?.state, 2, '容忍窗内非法保存不杀伤行');
    assert.equal(liveSettings()?.defaultWaitMs, 1, 'loader 就地提交放行：活 Ref 吃进非法值');
    assert.notEqual(readSnapshot()?.defaultWaitMs, 1, '快照保旧（volatile-update 监听 catch）');
    assert.ok(/must lie within|cross-field violation/.test(String(readDegraded() ?? '')),
      '保旧＋告警（降级登记在场）');
    await settings.update(ns, { settings: { defaultWaitMs: 30000 } });
    assert.equal(isConfigValidationArmed(), true, '首次合法保存重新武装');
    assert.equal(readDegraded(), undefined, '合法提交自愈（降级明细清空）');

    // ④ 启动遇非法持久值——容忍态（模拟新进程初态：武装位复位）。
    setConfigValidationArmed(false);
    await loader.create({ id: 'f04-host-t1', name: pluginSpec, config: { settings: { ...BASE_SETTINGS, defaultWaitMs: 1 } } }, 'include');
    await loader.await();
    const entryT1 = loader.resolve('include:f04-host-t1');
    assert.equal(entryT1.fiber?.state, 2, '容忍态下非法配置仍激活（修复入口不死）');
    assert.equal(standin.STATE.wirings.at(-1)?.degraded, true, '该行装配侧自检失败（降级接线）');
    const viewT1 = settings.describe().find((row) => row.ns === 'f04-host-t1');
    assert.ok(viewT1 !== undefined, 'describe 仍含该 ns（设置卡片在场）');
    assert.equal(viewT1?.value?.settings?.defaultWaitMs, 1, '值投影显示原始非法值');
    const decodeT1 = await clientValidate(viewT1.schema, viewT1.value);
    assert.equal(decodeT1.ok, true, `容忍态表单可渲染：${decodeT1.message ?? ''}`);

    // ⑤ 武装态对照：启动遇非法持久值 → 装配失败（FiberState.FAILED = 3），
    //    卡片消失——这是「写入拒绝是健康态保证」的另一面，登记在案的取舍。
    setConfigValidationArmed(true);
    await loader.create({ id: 'f04-host-t2', name: pluginSpec, config: { settings: { ...BASE_SETTINGS, defaultWaitMs: 1 } } }, 'include');
    await loader.await();
    const entryT2 = loader.resolve('include:f04-host-t2');
    assert.equal(entryT2.fiber?.state, 3,
      `武装态非法配置装配失败（state=${entryT2.fiber?.state}；宿主 FiberState 枚举 FAILED=3）`);
    assert.equal(settings.describe().find((row) => row.ns === 'f04-host-t2'), undefined,
      '武装态下卡片消失（describe 不含该 ns）');
    // 首次合法保存重新武装的通道由 ①↔② 对（解除→恢复）与本组 ③↔⑤ 对照共同覆盖。

    // ⑥ 归属甄别（真实实例形态回归）：waterfall 是全树级的——宿主自己的
    //    `subagent` 行同样流经本包监听。外来行携带的 `toolName` 过本包
    //    schema 必然失败，但那不是本包的降级事实：不得登记（否则启动即
    //    污染模型可见的描述警示段）。对照：①里本包候选的非法提交仍登记。
    const foreignSpec = relative(join(WORK, 'comp'), join(HERE, '_foreign-row-standin.mjs')).split(sep).join('/');
    setConfigValidationArmed(true);
    const degradeBeforeForeign = readDegraded();
    await loader.create({ id: 'f04-foreign', name: foreignSpec, config: { toolName: 'subagent', models: ['m1'] } }, 'include');
    await loader.await();
    const foreignEntry = loader.resolve('include:f04-foreign');
    assert.equal(foreignEntry?.fiber?.state, 2, '外来行照常激活（甄别不改写别家候选）');
    assert.equal(readDegraded(), degradeBeforeForeign,
      '外来行流经 waterfall 不得触发本包降级登记（甄别前此断言必红——真实实例启动日志实证过污染形态）');
  } finally {
    setConfigValidationArmed(false);
    chain.clearSnapshot();
    chain.clearDegraded();
  }
});
