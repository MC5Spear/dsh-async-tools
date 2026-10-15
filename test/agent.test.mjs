/**
 * `async_agent` 的单元测试（需求 §2.3 子代理派生与 §3.1 预设 persona 的机制半边）。
 *
 * 假件纪律：
 * - 假 `subagents` 只实现被测代码真正调用的 `getProvider` / `startContinuable`；
 * - **前台 `start` 是哨兵**：记录调用并抛可读错误——变异 M1 把
 *   `startContinuable` 换成 `start` 时，红因一目了然而不是泛型 TypeError；
 * - **零等待原语记录器**：`timer`/`on` 只记录不干活——"立返"由
 *   `execute` 全程零调用来证明，形状断言证明不了"没等"；
 * - **假 `sessionProjections`**（模型选择）：只实现 `stateOf`，形态可配——
 *   routes 数组（有 policy）/ null（投影初值）/ 'throw'（投影读取抛错）。父路由经
 *   `parentAgentOptionsForDelegation`（真函数）读 `agent.session.requestHeader()`
 *   ——与 driver 的 `resolveChildAgentOptions` 同一数据源，假件按宿主形态造。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { createAgentTool } from '../lib/agent.js';
import { resolveConfig } from '../lib/config.js';
import { makeConfigView } from '../lib/config-view.js';
import { checkedTool } from './_helpers.mjs';

/**
 * 加载宿主入口（refreshToolDescriptions 所在的 `lib/index.js` 会拉进
 * `lib/ask-takeover.js` → `@deepseek-ai/dsh-llm`，本地 node_modules 没有）；
 * 只吞宿主包解析失败——其余错误原样抛，避免"跳过＝通过"的假绿。
 * @returns {Promise<object | undefined>} 模块；宿主包不可解析时为 `undefined`。
 */
async function loadHost() {
  try {
    return await import('../lib/index.js');
  } catch (error) {
    const message = String(error?.message ?? error);
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && message.includes('@deepseek-ai/')) return undefined;
    throw error;
  }
}

const host = await loadHost();
const { refreshToolDescriptions } = host ?? {};

/**
 * 构造测试环境：假 subagents 服务 + 假 sessionProjections + 零等待原语记录器。
 *
 * @param {object} [options]
 * @param {Record<string, object>} [options.providers] 注册表（默认 spawn/fork 都支持 continuable）。
 * @param {Array<{provider: string, model: string}> | null | 'throw'} [options.policy]
 *   `subagentModelSelectionPolicy` 投影形态：数组=白名单；null=有 reducer 无记录
 *   （"无 policy"；键未注册时宿主 stateOf 返回 undefined 不抛，同被实现折叠）；
 *   'throw'=投影读取抛错（如折叠异常，按"无 policy"承接）。
 * @returns {object} 环境与探针。
 */
function agentEnv({ providers, policy = null } = {}) {
  const registry = providers ?? {
    spawn: { name: 'spawn', prepareContinuable() {}, capabilities: { agentOptions: true } },
    fork: { name: 'fork', prepareContinuable() {}, capabilities: { agentOptions: true } }
  };
  const getProviderQueries = [];
  const continuables = [];
  /** 前台哨兵：宿主工具的非 continuable 回退路径（本插件不走，只经 startContinuable——设计 §3.3）。 */
  const foregroundStarts = [];
  const timerUses = [];
  const onUses = [];

  const subagents = {
    getProvider(name) {
      getProviderQueries.push(name);
      return Object.prototype.hasOwnProperty.call(registry, name) ? registry[name] : undefined;
    },
    async startContinuable(call) {
      continuables.push(call);
      return { childId: `child-${continuables.length}` };
    },
    // 哨兵：**调用**即记录并抛（访问本体会返回这个函数，不访问实现就测不到）。
    start(_provider, _request) {
      foregroundStarts.push({ provider: _provider, request: _request });
      throw new Error('[test sentinel] ctx.subagents.start was called — async_agent must delegate via startContinuable only');
    }
  };

  const stateOfCalls = [];
  const sessionProjections = {
    stateOf(session, key) {
      stateOfCalls.push({ session, key });
      if (policy === 'throw') throw new Error('[test] projection read throws');
      return policy;
    }
  };

  const ctx = {
    subagents,
    sessionProjections,
    timer: {
      timeout(...args) { timerUses.push(['timeout', ...args]); return () => {}; },
      interval(...args) { timerUses.push(['interval', ...args]); return () => {}; }
    },
    on(...args) { onUses.push(args); return () => {}; }
  };

  let current = resolveConfig({});
  const view = makeConfigView(() => current);

  return {
    ctx,
    view,
    getProviderQueries,
    continuables,
    foregroundStarts,
    timerUses,
    onUses,
    stateOfCalls,
    /** 模拟设置改写：换掉"当前生效配置"（视图按次现取）。 */
    setConfig(raw) { current = resolveConfig(raw); },
    getConfig() { return current; }
  };
}

/** 父路由假件：宿主形态——`agent.session.requestHeader()?.config` 优先（同一数据源），
 *  `options` 恒在（真函数解构它；requestHeader 有 config 时被覆盖性忽略）。 */
const EXEC_AGENT = {
  id: 'session-parent-1',
  options: {},
  session: {
    requestHeader() {
      return { config: { provider: 'deepseek-official', model: 'deepseek-flash' } };
    }
  }
};
const EXEC = { agent: EXEC_AGENT };
/** 白名单形态：`zai/glm-5.3` 在白名单、父路由不在。 */
const POLICY = [{ provider: 'zai', model: 'glm-5.3' }];

test('async_agent：立返 started + agent_id，note 含可复制的等待调用与生效数字（R13/R5）', async () => {
  const env = agentEnv();
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  const result = await tool.execute({ description: '调研甲', prompt: '完成调研并报告三个要点。' }, EXEC);

  assert.equal(result.status, 'started');
  assert.equal(result.agent_id, 'child-1');
  // note 里的数字现读现取（默认 defaultWaitMs=30000）；改设置后必须跟着变（下一条用例）。
  assert.match(result.note, /async_wait_agent\(agent_id="child-1", wait_ms=30000\)/,
    'note 必须给出可复制的下一步调用，数字取自生效配置');
  assert.match(result.note, /arrives as its own message in the conversation/);
  // 模型只看得见 render——agent_id 必须出现在 render 文本里。
  const rendered = tool.output.render({}, result);
  assert.match(rendered[0].text, /child-1/, 'render 文本必须含 agent_id（模型可见层）');
});

test('async_agent：note 示例数字随 defaultWaitMs 设置变化（现读现取，R5）', async () => {
  const env = agentEnv();
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  env.setConfig({ defaultWaitMs: 1234 });
  const result = await tool.execute({ description: '调研乙', prompt: '报告。' }, EXEC);
  assert.match(result.note, /wait_ms=1234/);
});

test('async_agent：startContinuable 恰一次，request 逐字段对齐宿主契约且不含透传键（R13）', async () => {
  const env = agentEnv();
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  await tool.execute({ description: '标签甲', prompt: '任务书。' }, EXEC);

  assert.equal(env.continuables.length, 1, '恰调用一次');
  const call = env.continuables[0];
  assert.equal(call.provider, 'spawn');
  assert.equal(call.label, '标签甲');
  assert.equal(call.request.label, '标签甲');
  assert.deepEqual(call.request.prompt, [{ type: 'text', text: '任务书。' }]);
  assert.equal(call.request.parent, EXEC_AGENT, 'parent 必须是 exec.agent（:491）');
  // 参数集合=结构保证：request 的键集恰好是 label/prompt/parent——透传键一概不得出现。
  assert.deepEqual(Object.keys(call.request).sort(), ['label', 'parent', 'prompt']);
});

test('async_agent：传入白名单命中的 provider+model → request.agentOptions 恰两键，note 报告 requested 路由（R13）', async () => {
  const env = agentEnv({ policy: POLICY });
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  const result = await tool.execute(
    { description: '审查文档', prompt: '完成审查并报告要点。', provider: 'zai', model: 'glm-5.3' },
    EXEC
  );

  // 通道：requested 经 request.agentOptions 交给 driver 合并（继承/覆盖都在宿主侧）。
  assert.equal(env.continuables.length, 1);
  assert.deepEqual(env.continuables[0].request.agentOptions, { provider: 'zai', model: 'glm-5.3' });
  assert.match(result.note, /Child LLM route: zai\/glm-5\.3 \(requested\)\./, 'note 必须回执实际请求的路由');
  // 白名单读取：对本会话的 policy 投影，键名逐字正确（stateOf 的第一参是
  // agent.session——宿主投影 API 以 session 为键）。
  assert.equal(env.stateOfCalls.length, 1);
  assert.equal(env.stateOfCalls[0].session, EXEC_AGENT.session);
  assert.equal(env.stateOfCalls[0].key, 'subagentModelSelectionPolicy');
});

test('async_agent：未传模型 → request 不带 agentOptions 键，note 报告继承的父路由（R13）', async () => {
  const env = agentEnv({ policy: POLICY });
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  const result = await tool.execute({ description: '调研甲', prompt: '任务。' }, EXEC);

  assert.equal('agentOptions' in env.continuables[0].request, false,
    '未选择路由时 request 必须不带 agentOptions 键（driver 走父继承）');
  // 父路由现读：与 driver 的 resolveChildAgentOptions 同一数据源（requestHeader().config）。
  assert.match(result.note, /Child LLM route: deepseek-official\/deepseek-flash \(inherited from this agent\)\./);
  // 纯继承不进 policy（宿主语义）：投影零读取。
  assert.deepEqual(env.stateOfCalls, [], '未选择路由时不得读白名单投影（纯继承不进 policy）');
});

test('async_agent：未声明键显式报错并零派生——零容忍的对冲（R13）', async () => {
  for (const extra of [
    { run_in_background: true },
    { reasoning_effort: 'high' },
    { persona: 'reviewer' },
    { foo: 'bar', another: 1 }
  ]) {
    const env = agentEnv({ policy: POLICY });
    const tool = createAgentTool(env.ctx, env.view);
    const args = { description: 'x', prompt: 'y', ...extra };
    const promise = tool.execute(args, EXEC);
    // 错误要点名实际键名、枚举支持键（D8：两个半句都锁——删掉"supported"枚举半句
    // 会把模型引向宿主 subagent 工具参数集合的错误猜测）。
    await assert.rejects(
      promise,
      new RegExp(`unsupported argument\\(s\\): ${Object.keys(extra).join(', ').replace(/[.()*+?^${}|[\]\\]/g, '\\$&')}`)
    );
    await assert.rejects(
      tool.execute(args, EXEC),
      /supported: description, prompt, provider, model/
    );
    assert.deepEqual(env.continuables, [], '报错路径不得派生');
  }
});

test('async_agent：指定路由但 provider 未声明 agentOptions 能力 → 当场报错且零派生（零容忍）', async () => {
  // 假件形状与宿主注册表保持一致：后端对象带 capabilities 字典；spawn-in-process 声明
  // agentOptions: true，这里造一个不声明的。
  const env = agentEnv({
    providers: { legacy: { name: 'legacy', prepareContinuable() {}, capabilities: {} } },
    policy: POLICY
  });
  env.setConfig({ subagentProvider: 'legacy' });
  const tool = createAgentTool(env.ctx, env.view);

  await assert.rejects(
    tool.execute(
      { description: 'x', prompt: 'y', provider: 'zai', model: 'glm-5.3' },
      EXEC
    ),
    /"legacy" does not honor agentOptions.*requested route would be silently ignored/
  );
  assert.deepEqual(env.continuables, [], '功能不达标不得派生');

  // 同一 provider 不指定路由时不受影响（功能预检只约束显式选择）。
  const pass = await tool.execute({ description: 'x', prompt: 'y' }, EXEC);
  assert.equal(pass.status, 'started');
});

test('async_agent：provider 与 model 必须成对且非空（宿主同款文案，R13）', async () => {
  // 只传其一（两个方向都要红）。
  for (const partial of [{ provider: 'zai' }, { model: 'glm-5.3' }]) {
    const env = agentEnv({ policy: POLICY });
    const tool = createAgentTool(env.ctx, env.view);
    await assert.rejects(
      tool.execute({ description: 'x', prompt: 'y', ...partial }, EXEC),
      /`provider` and `model` must be supplied together/
    );
    assert.deepEqual(env.continuables, []);
  }
  // 空串（DSL 的 type:'string' 不挡空串，执行层必须挡）。
  for (const blank of [{ provider: '', model: 'glm-5.3' }, { provider: 'zai', model: '' }]) {
    const env = agentEnv({ policy: POLICY });
    const tool = createAgentTool(env.ctx, env.view);
    await assert.rejects(
      tool.execute({ description: 'x', prompt: 'y', ...blank }, EXEC),
      /must be non-empty/
    );
    assert.deepEqual(env.continuables, []);
  }
});

test('async_agent：白名单外的路由被拒且零派生（宿主同款文案，R13）', async () => {
  const env = agentEnv({ policy: POLICY });
  const tool = createAgentTool(env.ctx, env.view);
  await assert.rejects(
    tool.execute({ description: 'x', prompt: 'y', provider: 'zai', model: 'glm-4.9' }, EXEC),
    /child LLM route "zai\/glm-4\.9" is not allowed for this Session/
  );
  assert.deepEqual(env.continuables, [], '越界路由不得派生');
});

test('async_agent：无 policy 的会话拒绝指定模型——null 与读取抛错两种形态（R13）', async () => {
  // ① 投影状态为 null（reducer 在但没 record）：宿主在此形态下不暴露模型参数，
  //    本工具参数集合常开，用运行时拒绝与同一管控规则保持一致。键未注册时宿主 stateOf
  //    返回 undefined（不抛），与 null 同被折叠为"无 policy"，同一断言覆盖。
  const envNull = agentEnv({ policy: null });
  const toolNull = createAgentTool(envNull.ctx, envNull.view);
  await assert.rejects(
    toolNull.execute({ description: 'x', prompt: 'y', provider: 'zai', model: 'glm-5.3' }, EXEC),
    /child model selection is not available for this session \(no model-selection policy\)/
  );
  assert.deepEqual(envNull.continuables, []);

  // ② 投影读取抛错（如投影折叠异常）：异常被承接，同样按"无 policy"拒绝。
  const envThrow = agentEnv({ policy: 'throw' });
  const toolThrow = createAgentTool(envThrow.ctx, envThrow.view);
  await assert.rejects(
    toolThrow.execute({ description: 'x', prompt: 'y', provider: 'zai', model: 'glm-5.3' }, EXEC),
    /child model selection is not available for this session/
  );
  assert.deepEqual(envThrow.continuables, []);
});

test('async_agent（R29-f·判据 10）：投影返回非数组对象 → 按"无 policy"拒绝，不得当数组遍历', async () => {
  // 形状防御：routes 期望数组（口径）。实现若直接 `.map`/`.find` 一个对象，
  // 会 TypeError 或静默走错分支——守卫把它折叠成与 null 相同的"无 policy"拒绝。
  const env = agentEnv({ policy: { 'provider-a': { model: 'x' } } });
  const tool = createAgentTool(env.ctx, env.view);
  await assert.rejects(
    tool.execute({ description: 'x', prompt: 'y', provider: 'zai', model: 'glm-5.3' }, EXEC),
    /child model selection is not available for this session \(no model-selection policy\)/
  );
  assert.deepEqual(env.continuables, [], '不得派发任何子代理');
});

test('async_agent：零前台（哨兵不动）+ 零等待原语（timer/on 零调用）——"立返"的可失败判据（R13）', async () => {
  const env = agentEnv();
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  await tool.execute({ description: '丙', prompt: '任务。' }, EXEC);

  assert.deepEqual(env.foregroundStarts, [], '不得走前台 start（宿主的非 continuable 回退路径）');
  // 实现约束"不注册任何定时器、监听器、作业"：删掉这层保护（实现里加个定时器）
  // 会让这里变红。
  assert.deepEqual(env.timerUses, [], 'async_agent 不得使用任何定时器（不等待就没有打断问题）');
  assert.deepEqual(env.onUses, [], 'async_agent 不得注册任何监听器（等待交给 async_wait_agent）');
});

test('async_agent：三种错误态互相可区分，且一个子代理都不派生（R13）', async () => {
  // ① agent-less 驱动（与单次提权用例同款纪律）。
  const envA = agentEnv();
  const toolA = createAgentTool(envA.ctx, envA.view);
  await assert.rejects(
    toolA.execute({ description: 'x', prompt: 'y' }, { agent: undefined }),
    /requires an initiator agent/
  );
  assert.deepEqual(envA.continuables, [], '报错路径不得派生');

  // ② provider 未注册（设置里写了个不存在的名字）。
  const envB = agentEnv();
  const toolB = createAgentTool(envB.ctx, envB.view);
  envB.setConfig({ subagentProvider: 'nope' });
  await assert.rejects(
    toolB.execute({ description: 'x', prompt: 'y' }, EXEC),
    /subagent provider "nope" is not registered.*'subagentProvider'/
  );
  assert.deepEqual(envB.continuables, []);

  // ③ provider 不支持 continuable 后台（缺 prepareContinuable，插件级预检 :380）。
  const envC = agentEnv({ providers: { codex: { name: 'codex' } } });
  const toolC = createAgentTool(envC.ctx, envC.view);
  envC.setConfig({ subagentProvider: 'codex' });
  await assert.rejects(
    toolC.execute({ description: 'x', prompt: 'y' }, EXEC),
    /"codex" does not support background delegation \(missing prepareContinuable\)/
  );
  assert.deepEqual(envC.continuables, []);
});

test('async_agent：subagentProvider 设置改名后 getProvider 的查询对象跟着变（行为差异，R10）', async () => {
  const env = agentEnv();
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  await tool.execute({ description: '甲', prompt: '任务。' }, EXEC);
  assert.equal(env.getProviderQueries.at(-1), 'spawn');

  env.setConfig({ subagentProvider: 'fork' });
  await tool.execute({ description: '乙', prompt: '任务。' }, EXEC);
  assert.equal(env.getProviderQueries.at(-1), 'fork', '行为必须跟设置走，不停留在组合行默认');
});

test('async_agent：描述里的 provider 名随设置改名就地刷新（第五条改写规则）', async (t) => {
  if (host === undefined) { t.skip('宿主包不可解析（离线环境），本用例跳过'); return; }
  const env = agentEnv();
  const tool = createAgentTool(env.ctx, env.view);

  // 构造时的描述写的是当时的名字。
  assert.match(tool.description, /currently: spawn/);
  // 设置改名 → refreshToolDescriptions 就地改写（行为活、描述也活）。
  env.setConfig({ subagentProvider: 'fork' });
  refreshToolDescriptions(tool, env.view);
  assert.match(tool.description, /currently: fork/);
  assert.doesNotMatch(tool.description, /currently: spawn/, '旧名字必须被改写掉，不能两处并存');
});

test('async_agent：provider 名是自由文本时，连续 refresh 描述不累积不展开', (t) => {
  if (host === undefined) { t.skip('宿主包不可解析（离线环境），本用例跳过'); return; }
  // subagentProvider 是设置页的自由文本（仅 trim，无字符集校验）——刷新规则必须
  // 在怪名下仍然成立：①锚吃到 `)` 句界（`[^)]+`：窄锚会在带空格名下越刷越长，
  // 排除 `.` 的锚会让 `node.dev`/`claude-3.7` 这类版本号形态逐次累积、纯点号名空转）；
  // ②函数替换器（字符串替换器会把 `$&` 展开成匹配文本）。去掉任何一条本用例必红。
  const env = agentEnv();
  for (const weird of ['my provider', 'node.dev', 'claude-3.7', '..']) {
    env.setConfig({ subagentProvider: weird });
    const tool = createAgentTool(env.ctx, env.view);
    const first = tool.description;
    // 纯子串断言（名字里的正则元字符不掺和）：构造期描述必须含 `currently: <名字>)`。
    assert.ok(first.includes(`currently: ${weird})`),
      `构造期描述必须含完整名字 ${JSON.stringify(weird)}`);
    refreshToolDescriptions(tool, env.view);
    refreshToolDescriptions(tool, env.view);
    assert.equal(tool.description, first,
      `${JSON.stringify(weird)} 连续两次刷新后描述必须与首次一字不差（不累积尾缀）`);
  }

  // 纯点号名不得让规则空转：改名后描述必须跟着走。
  env.setConfig({ subagentProvider: '..' });
  const tool = createAgentTool(env.ctx, env.view);
  env.setConfig({ subagentProvider: 'fork' });
  refreshToolDescriptions(tool, env.view);
  assert.match(tool.description, /currently: fork\)/, '纯点号名之后改名，描述必须刷新');

  // `$&`/`$1` 这类序列在函数替换器下按字面保留（字符串替换器会把它们展开成匹配文本）。
  env.setConfig({ subagentProvider: 'a$&b' });
  refreshToolDescriptions(tool, env.view);
  assert.match(tool.description, /currently: a\$&b\)/, '$ 序列按字面保留（不做替换串展开）');
});

test('async_agent：缺 prompt 在宿主同款参数校验器下被拒', () => {
  const env = agentEnv();
  const tool = createAgentTool(env.ctx, env.view);

  // 宿主执行层对模型参数用的正是这份编译后的 parameters schema（dsh-tools
  // defineTool 内部的 validate 即 `validateJsonSchemaValue(parameters, args)`，
  // lib/index.js:848 同款）——单测直调同一入口，断言"必填"真的被执行层消费。
  const missing = validateJsonSchemaValue(tool.parameters, { description: '只有描述' }, '');
  assert.ok(missing.length > 0, '缺 prompt 必须产生违规');
  assert.match(missing.join('; '), /prompt/, '违规文案必须点名 prompt');
  assert.deepEqual(
    validateJsonSchemaValue(tool.parameters, { description: 'd', prompt: 'p' }, ''),
    [],
    '两键齐全必须通过'
  );
});

test('async_agent：parameters 契约——两键必填、provider/model 可选、没有 run_in_background（R13 的结构保证）', () => {
  const env = agentEnv();
  const tool = createAgentTool(env.ctx, env.view);

  // `defineTool` 把 DSL 参数转换并固化成 JSON Schema（required 数组由宿主执行层
  // 用于调用期校验）——这里锚定"只有 description/prompt 必填；provider/model 可选"。
  assert.deepEqual([...tool.parameters.required].sort(), ['description', 'prompt']);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(),
    ['description', 'model', 'prompt', 'provider'],
    '参数集合恰四键——run_in_background 一概不暴露（后台不是模型的选择），'
      + '成对/非空/白名单三条纪律由执行层强制（需求 §2.3.2、设计 §3.3）');
});
