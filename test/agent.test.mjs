/**
 * `async_agent` 的单元测试（需求 §2.3 子代理派生与 §3.1 预设 persona 的机制半边；
 * §2.3.1 公共参数兼容、§2.3.2 模型选择实时口径）。
 *
 * 假件纪律：
 * - 假 `subagents` 只实现被测代码真正调用的 `getProvider` / `startActivation`；
 * - **前台 `start` 是哨兵**：记录调用并抛可读错误——实现改走前台路径时，
 *   红因一目了然而不是泛型 TypeError；
 * - **回执形状与宿主 `SubagentActivation` 一致**：`{ childId, result, dispose }`；
 *   `result` 默认**永不落定**——execute 能带着它返回，本身就是"立返不 await
 *   result"的行为证明；测试按需经 `settleActivation` 落定两个分支；
 *   `dispose` 是哨兵：记录并抛可读错误（本包任何路径都不得调用它，设计 §3.3）；
 * - **零等待原语记录器**：`timer`/`on` 只记录不干活——"立返"由
 *   `execute` 全程零调用来证明，形状断言证明不了"没等"；
 * - **假 `subagentModelSelection` 服务**（§2.3.2 实时口径）：`.current()` 可配
 *   （enabled／allowedModels／抛错／逐次脚本），每次读取计数——「现读、重读」
 *   都有可失败判据；服务缺席形态覆盖 §2.3.2 的可读拒绝；
 * - **假 `llm` 服务**（创建前预检）：`resolveCallConfig` 记录参数，可配抛错；
 * - 父路由经 `parentAgentOptionsForDelegation`（真函数）读
 *   `agent.session.requestHeader()`——与 driver 的 `resolveChildAgentOptions`
 *   同一数据源，假件按宿主形态造。
 */
import assert from 'node:assert/strict';
import { hostTestByProbe, hostTestFor, loadOfflineSafe } from './_host-gate.mjs';
import { resolveConfig } from '../lib/config.js';
import { makeConfigView } from '../lib/config-view.js';
import { validateJsonSchemaValue, checkedTool } from './_helpers.mjs';

// 宿主链动态守卫：`lib/agent.js`（→ dsh-tools / dsh-subagent）与 `lib/index.js`
// （refreshToolDescriptions 所在，经 ask-takeover → dsh-llm 拉进宿主包）在离线
// 形态缺席——全部用例自跳过并打印理由（ci.yml offline 作业的契约）。
const agentModule = await loadOfflineSafe('../lib/agent.js');
const hostModule = await loadOfflineSafe('../lib/index.js');
const { createAgentTool } = agentModule ?? {};
const { refreshToolDescriptions } = hostModule ?? {};
const hostTest = await hostTestFor('../lib/agent.js', '../lib/index.js');

/** 白名单基线：`zai/glm-5.3` 与父路由 `deepseek-official/deepseek-flash` 都在。 */
const ROUTES = [
  { provider: 'zai', model: 'glm-5.3' },
  { provider: 'deepseek-official', model: 'deepseek-flash' }
];

/**
 * 构造测试环境：假 subagents 服务 + 假模型选择服务 + 假 llm + 零等待原语记录器。
 *
 * @param {object} [options]
 * @param {Record<string, object>} [options.providers] 注册表（默认 spawn/fork 都支持
 *   continuable＋agentOptions；spawn 额外声明 agentPreset 能力）。
 * @param {object|'absent'|'throws'|Array} [options.selection] 模型选择服务形态：
 *   对象=恒定状态；'absent'=服务缺席；'throws'=current() 抛错；数组=逐次脚本
 *   （首读／重读逐项消费，耗尽后重复末项——开关中途翻转的可失败判据）。
 * @param {object} [options.rowConfig] 行级委托键（agentOptions/agentPreset/
 *   allowedAgentPresets——自定义行形态，需求 §2.3.1）。
 * @param {string} [options.llmMode] 'ok'（默认）｜'absent'｜'reject'。
 * @returns {object} 环境与探针。
 */
function agentEnv({ providers, selection = { enabled: true, allowedModels: ROUTES }, rowConfig, llmMode = 'ok' } = {}) {
  const registry = providers ?? {
    spawn: {
      name: 'spawn',
      prepareContinuable() {},
      capabilities: { agentOptions: true, agentPreset: true }
    },
    fork: { name: 'fork', prepareContinuable() {}, capabilities: { agentOptions: true } }
  };
  const getProviderQueries = [];
  const activations = [];
  /** 每次派生的 result 落定器（resolve/reject），测试按需驱动观察通道两分支。 */
  const settlers = [];
  /** dispose 哨兵记录：本包任何路径不得调用（设计 §3.3）。 */
  const disposeCalls = [];
  /** 前台哨兵：宿主公开接口没有前台 `start`——实现若走它，当场可读地红。 */
  const foregroundStarts = [];
  const timerUses = [];
  const onUses = [];

  const subagents = {
    getProvider(name) {
      getProviderQueries.push(name);
      return Object.prototype.hasOwnProperty.call(registry, name) ? registry[name] : undefined;
    },
    async startActivation(call) {
      activations.push(call);
      let resolve;
      let reject;
      const result = new Promise((res, rej) => { resolve = res; reject = rej; });
      settlers.push({ resolve, reject });
      return {
        childId: `child-${activations.length}`,
        result,
        dispose() {
          disposeCalls.push(activations.length);
          throw new Error('[test sentinel] activation.dispose was called — async_agent must never dispose (host owns the activation lifecycle)');
        }
      };
    },
    // 哨兵：**调用**即记录并抛（访问本体会返回这个函数，不访问实现就测不到）。
    start(_provider, _request) {
      foregroundStarts.push({ provider: _provider, request: _request });
      throw new Error('[test sentinel] ctx.subagents.start was called — async_agent must delegate via startActivation only');
    }
  };

  // 假模型选择服务（§2.3.2）：读取计数＋逐次脚本。
  const selectionReads = [];
  const script = Array.isArray(selection) ? [...selection] : null;
  const selectionService = selection === 'absent' ? undefined : {
    current() {
      selectionReads.push(selectionReads.length);
      if (selection === 'throws') throw new Error('enabled with empty allowed list');
      if (script !== null) {
        const item = script[Math.min(selectionReads.length - 1, script.length - 1)];
        if (item instanceof Error) throw item;
        return item;
      }
      return selection;
    }
  };

  // 假 llm 服务（创建前预检）：记录调用，可配抛错。
  const preflightCalls = [];
  const llm = llmMode === 'absent' ? undefined : {
    async resolveCallConfig(config, signal) {
      preflightCalls.push({ config, signal });
      if (llmMode === 'reject') throw new Error('unknown reasoning effort "absurd"');
      return { config, signal };
    }
  };

  const ctx = {
    subagents,
    sessionProjections: { stateOf() { return null; } },
    get(name) {
      if (name === 'subagentModelSelection') return selectionService;
      if (name === 'llm') return llm;
      return undefined;
    },
    timer: {
      timeout(...args) { timerUses.push(['timeout', ...args]); return () => {}; },
      interval(...args) { timerUses.push(['interval', ...args]); return () => {}; }
    },
    on(...args) { onUses.push(args); return () => {}; }
  };

  let rawConfig = rowConfig ?? {};
  let current = resolveConfig(rawConfig);
  const view = makeConfigView(() => current);

  return {
    ctx,
    view,
    getProviderQueries,
    activations,
    settlers,
    disposeCalls,
    foregroundStarts,
    timerUses,
    onUses,
    selectionReads,
    preflightCalls,
    registry,
    /** 落定第 i 次（默认最近一次）派生的 result——驱动观察通道的两个分支。 */
    settleActivation(index) { return settlers.at(index ?? -1); },
    /** 模拟设置改写：与既有配置**合并**（行级一次性键不随设置快照丢失），视图按次现取。 */
    setConfig(raw) { rawConfig = { ...rawConfig, ...raw }; current = resolveConfig(rawConfig); },
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

hostTest('async_agent：立返 started + agent_id，note 含可复制的等待调用与生效数字（R13/R5）', async () => {
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

hostTest('async_agent：note 示例数字随 defaultWaitMs 设置变化（现读现取，R5）', async () => {
  const env = agentEnv();
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  env.setConfig({ defaultWaitMs: 1234 });
  const result = await tool.execute({ description: '调研乙', prompt: '报告。' }, EXEC);
  assert.match(result.note, /wait_ms=1234/);
});

hostTest('async_agent：startActivation 恰一次，spec 逐字段与宿主契约一致且不含透传键（R13）', async () => {
  const env = agentEnv();
  const tool = checkedTool(createAgentTool(env.ctx, env.view));
  const exec = { agent: EXEC_AGENT, signal: new AbortController().signal };

  await tool.execute({ description: '标签甲', prompt: '任务书。' }, exec);

  assert.equal(env.activations.length, 1, '恰调用一次');
  const call = env.activations[0];
  assert.equal(call.provider, 'spawn');
  assert.equal(call.label, '标签甲', '展示名走 startActivation 顶层 label');
  assert.equal(call.delivery, 'parent', '投递策略固定 parent：答案经宿主通知进入父会话');
  assert.equal(call.signal, exec.signal, '创建 signal 传 exec.signal（只管发布前取消）');
  assert.deepEqual(call.request.prompt, [{ type: 'text', text: '任务书。' }]);
  assert.equal(call.request.parent, EXEC_AGENT, 'parent 必须是 exec.agent（宿主校验注册表同一活 Agent）');
  // 参数集合=结构保证：无任何路由／预设请求时 request 的键集恰 prompt/parent；
  // spec 顶层恰五键（label/delivery/signal 是顶层字段，不进 request）。
  assert.deepEqual(Object.keys(call.request).sort(), ['parent', 'prompt']);
  assert.deepEqual(Object.keys(call).sort(), ['delivery', 'label', 'provider', 'request', 'signal']);
});

hostTest('async_agent：名单命中的 provider+model → 现读策略＋预检＋启动前重读，agentOptions 恰两键（§2.3.2）', async () => {
  const env = agentEnv();
  const tool = checkedTool(createAgentTool(env.ctx, env.view));
  const exec = { agent: EXEC_AGENT, signal: new AbortController().signal };

  const result = await tool.execute(
    { description: '审查文档', prompt: '完成审查并报告要点。', provider: 'zai', model: 'glm-5.3' },
    exec
  );

  // 通道：requested 经 request.agentOptions 交给 driver 合并（继承/覆盖都在宿主侧）。
  assert.equal(env.activations.length, 1);
  assert.deepEqual(env.activations[0].request.agentOptions, { provider: 'zai', model: 'glm-5.3' });
  assert.match(result.note, /Child LLM route: zai\/glm-5\.3 \(requested\)\./, 'note 必须回执实际请求的路由');
  // 实时口径：current() 至少两次（合并前读一份＋启动前重读一份）。
  assert.ok(env.selectionReads.length >= 2,
    `策略必须现读＋启动前重读（实读 ${String(env.selectionReads.length)} 次）`);
  // 创建前预检：llm.resolveCallConfig 收到有效路由与创建 signal。
  assert.equal(env.preflightCalls.length, 1, '预检恰一次');
  assert.deepEqual(env.preflightCalls[0].config, { provider: 'zai', model: 'glm-5.3' });
  assert.equal(env.preflightCalls[0].signal, exec.signal);
});

hostTest('async_agent：名单中途撤回（重读）→ routeRecheckFailed 撤销口径可读拒绝且零派生（§2.3.2、设计 §3.3 诊断③）', async () => {
  // 脚本：首读 enabled＋名单含 zai/glm-5.3；重读时名单已撤走该路由。
  const env = agentEnv({
    selection: [
      { enabled: true, allowedModels: [{ provider: 'zai', model: 'glm-5.3' }] },
      { enabled: true, allowedModels: [{ provider: 'x', model: 'y' }] }
    ]
  });
  const tool = createAgentTool(env.ctx, env.view);

  await assert.rejects(
    tool.execute({ description: 'x', prompt: 'y', provider: 'zai', model: 'glm-5.3' }, EXEC),
    /allowed list re-read immediately before the start no longer contains the selected route|async_list_subagent_models/
  );
  assert.deepEqual(env.activations, [], '重读撤回不得派生');
});

hostTest('async_agent：开关中途关闭（重读）→ selectionDisabled 可读拒绝且零派生（§2.3.2、设计 §3.3 诊断②）', async () => {
  const env = agentEnv({
    selection: [
      { enabled: true, allowedModels: ROUTES },
      { enabled: false, allowedModels: ROUTES }
    ]
  });
  const tool = createAgentTool(env.ctx, env.view);

  await assert.rejects(
    tool.execute({ description: 'x', prompt: 'y', provider: 'zai', model: 'glm-5.3' }, EXEC),
    /explicit child model selection is currently disabled|omit provider/
  );
  assert.deepEqual(env.activations, [], '开关关闭不得派生');
});

hostTest('async_agent：重读读取失败 → routeRecheckReadFailed 带原错的可读拒绝且零派生（设计 §3.3 诊断①）', async () => {
  // 脚本：首读正常；重读抛传输错误——读取失败≠设置已变化，文案须带真实原错
  // 并保留重试/查询出路，不得误报名单撤销（routeRecheckFailed）。
  const env = agentEnv({
    selection: [
      { enabled: true, allowedModels: [{ provider: 'zai', model: 'glm-5.3' }] },
      new Error('settings transport unavailable')
    ]
  });
  const tool = createAgentTool(env.ctx, env.view);

  let caught;
  try {
    await tool.execute({ description: 'x', prompt: 'y', provider: 'zai', model: 'glm-5.3' }, EXEC);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, '必须以可读错误拒绝');
  assert.match(String(caught?.message), /re-reading the model-selection settings right before the start failed: settings transport unavailable/);
  assert.match(String(caught?.message), /no subagent was started — retry the call, or re-check the current routes with async_list_subagent_models/,
    '出路半句（重试＋查询工具）必须随行');
  assert.deepEqual(env.activations, [], '重读读取失败不得派生');
});

hostTest('async_agent：重读读取失败的完整原错进操作者日志——模型侧截断、stderr 不截断（§6.3）', async () => {
  // 原错长于模型侧 500 字符上限：stderr 通告必须带全文（单行化、不截断），
  // 模型侧只吃截断段。两侧口径的分离在此落锚——实现若把 stderr 也回退到
  // 截断段，本用例必红。
  const tail = 'x'.repeat(600);
  const env = agentEnv({
    selection: [
      { enabled: true, allowedModels: [{ provider: 'zai', model: 'glm-5.3' }] },
      new Error(`settings transport unavailable - ${tail}`)
    ]
  });
  const tool = createAgentTool(env.ctx, env.view);
  const captured = await captureStderr(async () => {
    let caught;
    try {
      await tool.execute({ description: 'x', prompt: 'y', provider: 'zai', model: 'glm-5.3' }, EXEC);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error, '必须可读拒绝');
    assert.ok(!caught.message.includes(tail), '模型侧只吃截断段（600 字符尾不得整段在场）');
  });
  const lines = captured.split('\n');
  const notice = lines.find((line) => line.includes('子代理启动前重读模型选择设置失败'));
  assert.ok(notice !== undefined, '重读读取失败必须有一行操作者日志');
  assert.ok(notice.includes(tail), 'stderr 通告携带未截断的完整原错（600 字符尾整段在场）');
  assert.deepEqual(env.activations, [], '零派生保持');
});

hostTest('async_agent：未传模型 → request 不带 agentOptions 键，note 报告继承的父路由；策略零读取（§2.3.2）', async () => {
  const env = agentEnv();
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  const result = await tool.execute({ description: '调研甲', prompt: '任务。' }, EXEC);

  assert.equal('agentOptions' in env.activations[0].request, false,
    '未选择路由时 request 必须不带 agentOptions 键（driver 走父继承）');
  // 父路由现读：与 driver 的 resolveChildAgentOptions 同一数据源（requestHeader().config）。
  assert.match(result.note, /Child LLM route: deepseek-official\/deepseek-flash \(inherited from this agent\)\./);
  // 纯默认/继承不读策略（§2.3.2）：名单变化不影响这条路径。
  assert.deepEqual(env.selectionReads, [], '未选择路由时不得读模型选择设置（纯继承不进策略）');
  assert.deepEqual(env.preflightCalls, [], '无路由请求且无路由类配置默认时不预检');
});

hostTest('async_agent：未声明键显式报错并零派生——零容忍的对冲（R13）；基础键集含 cwd/reasoning_effort', async () => {
  for (const extra of [
    { run_in_background: true },
    { persona: 'reviewer' },
    { max_depth: 2 },
    { foo: 'bar', another: 1 }
  ]) {
    const env = agentEnv();
    const tool = createAgentTool(env.ctx, env.view);
    const args = { description: 'x', prompt: 'y', ...extra };
    const promise = tool.execute(args, EXEC);
    // 错误要点名实际键名、枚举支持键（两个半句都锁——删掉"supported"枚举半句
    // 会把模型引向宿主 subagent 工具参数集合的错误猜测）。
    await assert.rejects(
      promise,
      new RegExp(`unsupported argument\\(s\\): ${Object.keys(extra).join(', ').replace(/[.()*+?^${}|[\]\\]/g, '\\$&')}`)
    );
    await assert.rejects(
      tool.execute(args, EXEC),
      /supported: description, prompt, cwd, provider, model, reasoning_effort/
    );
    assert.deepEqual(env.activations, [], '报错路径不得派生');
  }
});

hostTest('async_agent：agent_preset 在未配置允许集合的行上属未声明键（需求 §2.3.1 条件参数）', async () => {
  const env = agentEnv();
  const tool = createAgentTool(env.ctx, env.view);
  await assert.rejects(
    tool.execute({ description: 'x', prompt: 'y', agent_preset: 'reviewer' }, EXEC),
    /unsupported argument\(s\): agent_preset/
  );
  assert.deepEqual(env.activations, []);
  // 本包两份预设的工具行不配置这些键：参数表面不得出现 agent_preset。
  assert.equal('agent_preset' in tool.parameters.properties, false, '未配置行不得暴露 agent_preset');
});

hostTest('async_agent：配置了允许集合的行——agent_preset 暴露、校验、透传与缺省默认（§2.3.1）', async () => {
  const env = agentEnv({
    rowConfig: { allowedAgentPresets: ['reviewer', 'writer'], agentPreset: 'writer' }
  });
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  // ① 参数暴露（spawn 声明 agentPreset 能力）＋文案列出可选值。
  assert.ok(tool.parameters.properties.agent_preset, '配置行必须暴露 agent_preset');
  assert.match(tool.parameters.properties.agent_preset.description, /reviewer, writer/);

  // ② 显式选择在允许集合内：透传到 request.agentPreset。
  await tool.execute({ description: '甲', prompt: '任务。', agent_preset: 'reviewer' }, EXEC);
  assert.equal(env.activations[0].request.agentPreset, 'reviewer');

  // ③ 缺省用行配置默认（与宿主同款：config.agentPreset 也是携带值）。
  await tool.execute({ description: '乙', prompt: '任务。' }, EXEC);
  assert.equal(env.activations[1].request.agentPreset, 'writer');

  // ④ 集合外的值：可读拒绝且零派生。
  await assert.rejects(
    tool.execute({ description: '丙', prompt: '任务。', agent_preset: 'nope' }, EXEC),
    /agent_preset must be one of: reviewer, writer/
  );
  assert.equal(env.activations.length, 2, '越界预设不得派生');
});

hostTest('async_agent：后端不支持独立预设 → 参数 schema 与校验集合同步收窄；行配置默认仍按能力可读拒绝（§2.3.2 四处同步）', async () => {
  const env = agentEnv({
    rowConfig: { allowedAgentPresets: ['reviewer'] }
  });
  // 后端名在建工具前就指向 fork：构建期即知不支持 → 不暴露 agent_preset。
  env.setConfig({ subagentProvider: 'fork' });
  const tool = createAgentTool(env.ctx, env.view);
  assert.equal('agent_preset' in tool.parameters.properties, false,
    '构建时已知后端不支持 → 不暴露 agent_preset');

  // 校验集合与暴露的参数键同步重算（设计 §5.2）：后端不支持时 agent_preset 是
  // 未声明键——显式传入报 unsupported argument，静默吞键没有窗口。
  await assert.rejects(
    tool.execute({ description: 'x', prompt: 'y', agent_preset: 'reviewer' }, EXEC),
    /unsupported argument\(s\): agent_preset/
  );
  assert.deepEqual(env.activations, [], '未声明键路径不得派生');

  // 行配置默认预设（无显式参数）走能力拒绝：fork 未声明 agentPreset 能力，
  // presetNoBackend 在派生前可读拒绝（设计 §3.3 的错误类经默认路径保留）。
  const envDefault = agentEnv({
    rowConfig: { allowedAgentPresets: ['reviewer'], agentPreset: 'reviewer' }
  });
  envDefault.setConfig({ subagentProvider: 'fork' });
  await assert.rejects(
    createAgentTool(envDefault.ctx, envDefault.view).execute({ description: 'x', prompt: 'y' }, EXEC),
    /"fork" does not support independent agent preset selection/
  );
  assert.deepEqual(envDefault.activations, [], '后端不支持不得派生');
});

hostTest('async_agent：cwd 透传（缺省不带键），不影响其余通道（§2.3.1）', async () => {
  const env = agentEnv();
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  await tool.execute({ description: '甲', prompt: '任务。', cwd: '/build/sub' }, EXEC);
  assert.equal(env.activations[0].request.cwd, '/build/sub', 'cwd 原样透传（解析在宿主）');

  await tool.execute({ description: '乙', prompt: '任务。' }, EXEC);
  assert.equal('cwd' in env.activations[1].request, false, '缺省不带 cwd 键（继承父当前有效目录）');
});

hostTest('async_agent：reasoning_effort 可单独指定——按有效路由校验、附注回执、预检带强度（§2.3.1）', async () => {
  const env = agentEnv();
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  const result = await tool.execute({ description: '甲', prompt: '任务。', reasoning_effort: 'high' }, EXEC);

  // 有效路由 = 配置默认⊕父值 = 父路由（在名单内）→ 通过；agentOptions 恰强度一键。
  assert.deepEqual(env.activations[0].request.agentOptions, { reasoningEffort: 'high' });
  assert.match(result.note, /\(reasoning effort: high\)/, 'note 必须回执推理强度');
  assert.deepEqual(env.preflightCalls[0].config,
    { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    '预检按最终有效路由＋强度（父继承参与：无路由默认且未换路由）');
  // 策略现读：effort-only 请求也是显式请求（宿主 assertAllowedModelSelection 同口径）。
  assert.ok(env.selectionReads.length >= 2);
});

hostTest('async_agent：reasoning_effort 的有效路由不在名单 → 可读拒绝（effort-only 也查名单）', async () => {
  // 名单只含 zai/glm-5.3；父路由 deepseek-official 不在。
  const env = agentEnv({
    selection: { enabled: true, allowedModels: [{ provider: 'zai', model: 'glm-5.3' }] }
  });
  const tool = createAgentTool(env.ctx, env.view);

  await assert.rejects(
    tool.execute({ description: 'x', prompt: 'y', reasoning_effort: 'high' }, EXEC),
    /route "deepseek-official\/deepseek-flash" is not allowed by the current model-selection settings/
  );
  assert.deepEqual(env.activations, [], '名单外有效路由不得派生');
});

hostTest('async_agent：reasoning_effort 空串拒绝（与 provider/model 同款非空纪律）', async () => {
  const env = agentEnv();
  const tool = createAgentTool(env.ctx, env.view);
  await assert.rejects(
    tool.execute({ description: 'x', prompt: 'y', reasoning_effort: '' }, EXEC),
    /reasoning_effort` must be non-empty/
  );
  assert.deepEqual(env.activations, []);
});

hostTest('async_agent：路由合并——行配置默认在无请求时携带；同路由保留配置强度；换路由丢配置强度（§2.3.1）', async () => {
  // 行配置了路由类默认（触发携带与预检；宿主 requiresRoutePreflight 同形）。
  const env = agentEnv({
    rowConfig: { agentOptions: { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'low' } }
  });
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  // ① 无显式请求：配置默认原样携带。
  const first = await tool.execute({ description: '甲', prompt: '任务。' }, EXEC);
  assert.deepEqual(env.activations[0].request.agentOptions,
    { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'low' },
    '无请求时携带行配置默认（不携带则父继承交宿主派生侧）');
  assert.equal(env.preflightCalls.length, 1, '路由类配置默认也触发创建前预检');
  // 回执行按携带值逐值标注来源（A-F05）：路由与强度都来自行配置 → 工具配置
  // 默认档，不谎称继承父路由。
  assert.match(first.note, /Child LLM route: zai\/glm-5\.3 \(tool-configured default\)\./);
  assert.match(first.note, /\(reasoning effort: low, tool-configured default\)/);
  // 配置默认路由按名单校验吗？——不：显式请求才查名单（宿主同口径）。
  assert.deepEqual(env.selectionReads, [], '无显式请求不读模型选择设置');

  // ② 同路由请求不带强度：配置强度保留（显式请求档回执）。
  const second = await tool.execute({ description: '乙', prompt: '任务。', provider: 'zai', model: 'glm-5.3' }, EXEC);
  assert.deepEqual(env.activations[1].request.agentOptions,
    { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'low' },
    '同路由换模型值相同 → 配置强度保留');
  assert.match(second.note, /Child LLM route: zai\/glm-5\.3 \(requested\)\./);
  assert.match(second.note, /\(reasoning effort: low, tool-configured default\)/);

  // ③ 换路由不带强度：配置强度丢弃（换路由未指定 → 不沿用旧路由强度）。
  await tool.execute(
    { description: '丙', prompt: '任务。', provider: 'deepseek-official', model: 'deepseek-flash' },
    EXEC
  );
  assert.deepEqual(env.activations[2].request.agentOptions,
    { provider: 'deepseek-official', model: 'deepseek-flash' },
    '换路由且未指定强度 → 配置默认的强度不携带');
});

hostTest('async_agent：非路由类配置默认（仅 maxTokens）参与携带但不触发预检（requiresRoutePreflight 同形）', async () => {
  const env = agentEnv({ rowConfig: { agentOptions: { maxTokens: 4096 } } });
  const tool = createAgentTool(env.ctx, env.view);

  await tool.execute({ description: '甲', prompt: '任务。' }, EXEC);
  assert.deepEqual(env.activations[0].request.agentOptions, { maxTokens: 4096 },
    '配置的非路由默认仍携带（它是行配置 agentOptions）');
  assert.deepEqual(env.preflightCalls, [], '仅 maxTokens 不触发路由预检');
});

hostTest('async_agent：后端路由默认参与合并——无请求时默认⊕行配置为携带值（§2.3.1）', async () => {
  const env = agentEnv({
    providers: {
      spawn: {
        name: 'spawn',
        prepareContinuable() {},
        capabilities: { agentOptions: true },
        agentRouteDefaults: { provider: 'zai', model: 'glm-5.3' }
      }
    },
    rowConfig: { agentOptions: { reasoningEffort: 'low' } }
  });
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  const result = await tool.execute({ description: '甲', prompt: '任务。' }, EXEC);
  // 行配置无路由键 → 不触发预检、不折后端默认（宿主 requiresRoutePreflight 同形）；
  // 这里行配置带 reasoningEffort（路由类）→ 触发：默认路由 ⊕ 行配置强度。
  assert.deepEqual(env.activations[0].request.agentOptions,
    { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'low' });
  assert.equal(env.preflightCalls.length, 1);
  // 回执来源分档（A-F05）：路由无行配置键 → 后端默认档；强度有行配置键 →
  // 工具配置默认档——两者并存时行配置覆盖，各归其位。
  assert.match(result.note, /Child LLM route: zai\/glm-5\.3 \(backend route default\)\./);
  assert.match(result.note, /\(reasoning effort: low, tool-configured default\)/);
});

hostTest('async_agent：指定路由但 provider 未声明 agentOptions 能力 → 当场报错且零派生（零容忍）', async () => {
  // 假件形状与宿主注册表保持一致：后端对象带 capabilities 字典；这里造一个不声明的。
  const env = agentEnv({
    providers: { legacy: { name: 'legacy', prepareContinuable() {}, capabilities: {} } }
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
  assert.deepEqual(env.activations, [], '功能不达标不得派生');

  // 同一 provider 不指定路由且无路由类配置默认时不受影响（携带值不存在）。
  const pass = await tool.execute({ description: 'x', prompt: 'y' }, EXEC);
  assert.equal(pass.status, 'started');
});

hostTest('async_agent：provider 与 model 必须成对且非空（宿主同款文案，R13）', async () => {
  // 只传其一（两个方向都要红）。
  for (const partial of [{ provider: 'zai' }, { model: 'glm-5.3' }]) {
    const env = agentEnv();
    const tool = createAgentTool(env.ctx, env.view);
    await assert.rejects(
      tool.execute({ description: 'x', prompt: 'y', ...partial }, EXEC),
      /`provider` and `model` must be supplied together/
    );
    assert.deepEqual(env.activations, []);
  }
  // 空串（DSL 的 type:'string' 不挡空串，执行层必须挡）。
  for (const blank of [{ provider: '', model: 'glm-5.3' }, { provider: 'zai', model: '' }]) {
    const env = agentEnv();
    const tool = createAgentTool(env.ctx, env.view);
    await assert.rejects(
      tool.execute({ description: 'x', prompt: 'y', ...blank }, EXEC),
      /must be non-empty/
    );
    assert.deepEqual(env.activations, []);
  }
});

hostTest('async_agent：名单外的路由被拒且零派生——文案指路 async_list_subagent_models 并保留目标工具条件（§2.3.1 末条）', async () => {
  const env = agentEnv({
    selection: { enabled: true, allowedModels: [{ provider: 'zai', model: 'glm-5.3' }] }
  });
  const tool = createAgentTool(env.ctx, env.view);
  await assert.rejects(
    tool.execute({ description: 'x', prompt: 'y', provider: 'zai', model: 'glm-4.9' }, EXEC),
    (error) => /is not allowed by the current model-selection settings/.test(error.message)
      && error.message.includes('async_list_subagent_models')
      && error.message.includes('target_tool="async_agent"')
  );
  assert.deepEqual(env.activations, [], '越界路由不得派生');
});

hostTest('async_agent：实时口径的四种拒绝形态互可区分且零派生（§2.3.2）', async () => {
  const route = { description: 'x', prompt: 'y', provider: 'zai', model: 'glm-5.3' };

  // ① 开关关闭：显式选择被拒，文案给默认/继承出路。
  const envOff = agentEnv({ selection: { enabled: false, allowedModels: ROUTES } });
  await assert.rejects(
    createAgentTool(envOff.ctx, envOff.view).execute(route, EXEC),
    /explicit child model selection is currently disabled.*omit provider, model, and reasoning_effort/s
  );
  assert.deepEqual(envOff.activations, []);

  // ② 服务缺席（宿主组合未提供 subagentModelSelection）。
  const envAbsent = agentEnv({ selection: 'absent' });
  await assert.rejects(
    createAgentTool(envAbsent.ctx, envAbsent.view).execute(route, EXEC),
    /does not provide the subagentModelSelection service/
  );
  assert.deepEqual(envAbsent.activations, []);

  // ③ current() 抛错（启用空名单等坏配置）：拒绝带真实原因。
  const envThrows = agentEnv({ selection: 'throws' });
  await assert.rejects(
    createAgentTool(envThrows.ctx, envThrows.view).execute(route, EXEC),
    /settings could not be read.*enabled with empty allowed list/s
  );
  assert.deepEqual(envThrows.activations, []);

  // ④ 开关实时生效：同一名单服务先关后开——同一环境、同一工具实例，关时拒绝、
  // 开时放行（不重载、不重建）。selection 数组＝逐次脚本：第一次调用在首读即
  // 拒绝（恰消费第 1 项）；第二次调用首读取第 2 项（开）、启动前重读耗尽后
  // 重复末项（仍开）→ 恰一次派生。
  const envFlip = agentEnv({ selection: [
    { enabled: false, allowedModels: ROUTES },
    { enabled: true, allowedModels: ROUTES }
  ] });
  const flipTool = createAgentTool(envFlip.ctx, envFlip.view);
  await assert.rejects(flipTool.execute(route, EXEC), /currently disabled/);
  assert.equal(envFlip.selectionReads.length, 1, '关态拒绝发生在首读，只消费一次策略读取');
  assert.deepEqual(envFlip.activations, [], '关态不得派生');
  const ok = await flipTool.execute(route, EXEC);
  assert.equal(ok.status, 'started', '开关开启后同一工具下一次调用即可用（同一环境、同一工具实例）');
  assert.equal(envFlip.activations.length, 1, '开态放行恰好派生一次');
  assert.ok(envFlip.selectionReads.length >= 3, '第二次调用现读＋启动前重读（实时读，无会话冻结）');
});

hostTest('async_agent：预检拒绝保留单行化原因＋查询指引（含目标工具条件），完整原因进 stderr（A-F07）', async () => {
  const env = agentEnv({ llmMode: 'reject' });
  // 覆盖拒绝原文：多行宿主原文验证单行化（需求 §6.2——模型侧不进 CR/LF/TAB）。
  env.ctx.get('llm').resolveCallConfig = async () => {
    throw new Error('unsupported model zz\n  at resolveCallConfig (llm/runtime.js:12:3)\n\tdetail: no such route');
  };
  const tool = createAgentTool(env.ctx, env.view);
  await assert.rejects(
    tool.execute({ description: 'x', prompt: 'y', provider: 'zai', model: 'glm-5.3' }, EXEC),
    (error) => error.message.includes('unsupported model zz')
      && error.message.includes('selected child LLM route was rejected before creation')
      && !/[\r\n\t]/.test(error.message)
      && error.message.includes('call async_list_subagent_models (target_tool="async_agent")')
  );
  assert.deepEqual(env.activations, [], '预检失败不得派生（零派生、不返回 child id）');
});

hostTest('async_agent：预检拒绝的操作者日志把路由标识单行化——模型可控换行不得伪造日志行（R5-F04，§6.2）', async () => {
  // 路由标识经参数进入（模型可控值）：注入换行后的 provider/model 若裸插值，
  // 操作者日志里会出现一条「看起来是系统写的」伪造行。名单先放行该路由，
  // 让失败恰好落在预检日志站点。
  const injected = { provider: 'za\ni', model: 'glm-5.3\n[FAKE] forged operator-log line' };
  const env = agentEnv({
    llmMode: 'reject',
    selection: { enabled: true, allowedModels: [injected] }
  });
  const tool = createAgentTool(env.ctx, env.view);
  const captured = await captureStderr(async () => {
    await assert.rejects(
      tool.execute({ description: 'x', prompt: 'y', provider: injected.provider, model: injected.model }, EXEC),
      (error) => error.message.includes('selected child LLM route was rejected before creation')
        && !/[\r\n\t]/.test(error.message)
    );
  });
  const lines = captured.split('\n');
  const notice = lines.find((line) => line.includes('路由预检拒绝'));
  assert.ok(notice !== undefined, '预检拒绝必须有一行操作者日志');
  assert.ok(notice.includes('[FAKE]'), '路由标识转义后原文仍在同一行内可读（单行化不丢信息）');
  assert.ok(lines.every((line) => !line.trimStart().startsWith('[FAKE]')),
    '换行被转义——模型可控的伪造独立日志行不得出现');
});

hostTest('async_agent：llm 服务缺席时显式路由 → 可读拒绝（不静默跳过预检）（§2.3.1）', async () => {
  const env = agentEnv({ llmMode: 'absent' });
  const tool = createAgentTool(env.ctx, env.view);
  await assert.rejects(
    tool.execute({ description: 'x', prompt: 'y', provider: 'zai', model: 'glm-5.3' }, EXEC),
    /llm service is unavailable/
  );
  assert.deepEqual(env.activations, []);
  // 无路由请求时不需要 llm：照常派生（预检条件与宿主 requiresRoutePreflight 同形）。
  const pass = await tool.execute({ description: '甲', prompt: '任务。' }, EXEC);
  assert.equal(pass.status, 'started');
});

hostTest('async_agent：预检窗口内后端被替换 → providerChanged 可读拒绝且零派生（宿主同款复查）', async () => {
  const env = agentEnv();
  // 预检 awaited 期间换注册表：resolveCallConfig 的假件里替换 spawn 定义。
  const realResolve = env.ctx.get('llm').resolveCallConfig;
  env.ctx.get('llm').resolveCallConfig = async (config, signal) => {
    env.registry.spawn = { name: 'spawn', prepareContinuable() {}, capabilities: { agentOptions: true, agentPreset: true }, replaced: true };
    return realResolve(config, signal);
  };
  const tool = createAgentTool(env.ctx, env.view);

  await assert.rejects(
    tool.execute({ description: 'x', prompt: 'y', provider: 'zai', model: 'glm-5.3' }, EXEC),
    /provider "spawn" changed while resolving/
  );
  assert.deepEqual(env.activations, [], '后端替换后不得按旧引用派生');
});

hostTest('async_agent：零前台（哨兵不动）+ 零等待原语（timer/on 零调用）——"立返"的可失败判据（R13）', async () => {
  const env = agentEnv();
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  await tool.execute({ description: '丙', prompt: '任务。' }, EXEC);

  assert.deepEqual(env.foregroundStarts, [], '不得走前台 start（宿主的非 continuable 回退路径）');
  // 实现约束"不注册任何定时器、监听器、作业"：删掉这层保护（实现里加个定时器）
  // 会让这里变红。
  assert.deepEqual(env.timerUses, [], 'async_agent 不得使用任何定时器（不等待就没有打断问题）');
  assert.deepEqual(env.onUses, [], 'async_agent 不得注册任何监听器（等待交给 async_wait_agent）');
});

hostTest('async_agent：三种基础错误态互相可区分，且一个子代理都不派生（R13）', async () => {
  // ① agent-less 驱动（与单次提权用例同款纪律）。
  const envA = agentEnv();
  const toolA = createAgentTool(envA.ctx, envA.view);
  await assert.rejects(
    toolA.execute({ description: 'x', prompt: 'y' }, { agent: undefined }),
    /requires an initiator agent/
  );
  assert.deepEqual(envA.activations, [], '报错路径不得派生');

  // ② provider 未注册（设置里写了个不存在的名字）。
  const envB = agentEnv();
  const toolB = createAgentTool(envB.ctx, envB.view);
  envB.setConfig({ subagentProvider: 'nope' });
  await assert.rejects(
    toolB.execute({ description: 'x', prompt: 'y' }, EXEC),
    /subagent provider "nope" is not registered.*'subagentProvider'/
  );
  assert.deepEqual(envB.activations, []);

  // ③ provider 不支持 continuable 后台（缺 prepareContinuable——宿主以该方法
  //    在场性选择本地执行，本包预检在派生前）。
  const envC = agentEnv({ providers: { codex: { name: 'codex' } } });
  const toolC = createAgentTool(envC.ctx, envC.view);
  envC.setConfig({ subagentProvider: 'codex' });
  await assert.rejects(
    toolC.execute({ description: 'x', prompt: 'y' }, EXEC),
    /"codex" does not support background delegation \(missing prepareContinuable\)/
  );
  assert.deepEqual(envC.activations, []);
});

hostTest('async_agent：subagentProvider 设置改名后 getProvider 的查询对象跟着变（行为差异，R10）', async () => {
  const env = agentEnv();
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  await tool.execute({ description: '甲', prompt: '任务。' }, EXEC);
  assert.equal(env.getProviderQueries.at(-1), 'spawn');

  env.setConfig({ subagentProvider: 'fork' });
  await tool.execute({ description: '乙', prompt: '任务。' }, EXEC);
  assert.equal(env.getProviderQueries.at(-1), 'fork', '行为必须跟设置走，不停留在组合行默认');
});

hostTest('async_agent：描述里的 provider 名随设置改名就地刷新（第五条改写规则）', async () => {
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

hostTest('async_agent：provider 名是自由文本时，连续 refresh 描述不累积不展开', () => {
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

hostTest('async_agent：缺 prompt 在宿主同款参数校验器下被拒', () => {
  const env = agentEnv();
  const tool = createAgentTool(env.ctx, env.view);

  // 宿主执行层对模型参数用的正是这份编译后的 parameters schema（dsh-tools
  // defineTool 内部的 validate 即 `validateJsonSchemaValue(parameters, args)`）——
  // 单测直调同一入口，断言"必填"真的被执行层消费。
  const missing = validateJsonSchemaValue(tool.parameters, { description: '只有描述' }, '');
  assert.ok(missing.length > 0, '缺 prompt 必须产生违规');
  assert.match(missing.join('; '), /prompt/, '违规文案必须点名 prompt');
  assert.deepEqual(
    validateJsonSchemaValue(tool.parameters, { description: 'd', prompt: 'p' }, ''),
    [],
    '两键齐全必须通过'
  );
});

hostTest('async_agent：parameters 契约——两键必填、公共参数集合同形、没有 run_in_background（R13 的结构保证）', () => {
  const env = agentEnv();
  const tool = createAgentTool(env.ctx, env.view);

  // `defineTool` 把 DSL 参数转换并固化成 JSON Schema（required 数组由宿主执行层
  // 用于调用期校验）——这里锚定"只有 description/prompt 必填；其余可选"。
  assert.deepEqual([...tool.parameters.required].sort(), ['description', 'prompt']);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(),
    ['cwd', 'description', 'model', 'prompt', 'provider', 'reasoning_effort'],
    '参数集合与原生创建工具同形（§2.3.1）——run_in_background 一概不暴露'
      + '（后台不是模型的选择）；agent_preset 按行配置条件暴露（本用例未配置）。');
});

/** 捕获 stderr 一段窗口内的输出（notice 出口的默认落点），用完恢复。 */
async function captureStderr(action) {
  const original = process.stderr.write;
  const chunks = [];
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    await action();
    // 观察处理器在 result 落定后的微任务里运行——让出一个宏任务再收网。
    await new Promise((r) => { setImmediate(r); });
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}

hostTest('async_agent：result 观察通道——completed 静默，非完成结局与拒绝走 stderr 且附 child id（设计 §3.3）', async () => {
  const env = agentEnv();
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  // ① 正常结算：不产生任何 stderr 行（答案交付归宿主通知，本包不复述）。
  const first = await tool.execute({ description: '甲', prompt: '任务。' }, EXEC);
  const quiet = await captureStderr(() => env.settleActivation().resolve({ stopReason: 'completed', output: [] }));
  assert.equal(quiet, '', 'completed 结算不得产生诊断行');
  assert.equal(env.disposeCalls.length, 0, '结算后也不得调用 dispose（宿主自然释放）');

  // ② 非完成结局：stderr 一行，含准确 child id、stopReason 与 diagnostic。
  await tool.execute({ description: '乙', prompt: '任务。' }, EXEC);
  const abnormal = await captureStderr(() => env.settleActivation().resolve({
    stopReason: 'error',
    output: [],
    diagnostic: 'transport reset'
  }));
  assert.match(abnormal, /child-2/, '诊断必须附准确 child id');
  assert.match(abnormal, /stopReason=error/, '诊断必须点名非完成结局');
  assert.match(abnormal, /transport reset/, 'provider 诊断文本保留');

  // ③ 基础设施拒绝（capture 失败）：stderr 一行，含 child id 与拒绝事实。
  await tool.execute({ description: '丙', prompt: '任务。' }, EXEC);
  const rejected = await captureStderr(() => env.settleActivation().reject(new Error('capture failed: EPIPE')));
  assert.match(rejected, /child-3/, '拒绝诊断必须附准确 child id');
  assert.match(rejected, /capture failed: EPIPE/, '拒绝原文保留');

  // 三个 activation 都已落定，dispose 全程零调用（设计 §3.3：本包从不 dispose）。
  assert.equal(env.disposeCalls.length, 0, '任何路径都不得调用 dispose');
  assert.equal(first.status, 'started');
});

hostTest('async_agent：result 永不落定时 execute 照常立返（不 await result 的行为证明）', async () => {
  const env = agentEnv();
  const tool = checkedTool(createAgentTool(env.ctx, env.view));

  // 假件 result 默认永不落定：execute 若 await 了 result，本用例会超时挂死——
  // 这就是「调用只等启动被接受」的可失败判据（与零 timer/on 用例互补）。
  const result = await tool.execute({ description: '挂起', prompt: '任务。' }, EXEC);
  assert.equal(result.status, 'started');
  assert.equal(result.agent_id, 'child-1');
  assert.deepEqual(env.disposeCalls, []);
});

// ── A-F05 回归：回执行按携带值逐值标注来源（四档，zh 档同锁） ──────────────

hostTest('async_agent：行配置路由＋省略模型 → 回执写工具配置默认，不谎称继承父路由（A-F05 反例）', async () => {
  // 反例形态（sol probes 第六组）：父路由 deepseek-official/deepseek-flash、
  // 行级 agentOptions 指定 zai/glm-5.3、调用省略模型——请求正确携带配置值，
  // note 必须如实标注来源（写成 inherited from this agent 即为谎报）。
  const env = agentEnv({
    rowConfig: { agentOptions: { provider: 'zai', model: 'glm-5.3' } }
  });
  const tool = createAgentTool(env.ctx, env.view);

  const result = await tool.execute({ description: '调研', prompt: '任务。' }, EXEC);
  assert.equal(result.status, 'started');
  assert.deepEqual(env.activations[0].request.agentOptions, { provider: 'zai', model: 'glm-5.3' });
  assert.match(result.note, /Child LLM route: zai\/glm-5\.3 \(tool-configured default\)\./,
    '携带值来自行配置 → 工具配置默认档');
  assert.doesNotMatch(result.note, /inherited from this agent/,
    '配置默认在场时不得谎称父继承');
});

hostTest('async_agent：行配置单侧给出的混合路由——provider 与 model 分写来源（R3-F03）', async () => {
  // 反例形态：行级 agentOptions 只配 provider（省略 model）——请求只携带
  // {provider}，宿主合并出混合路由（provider=行配置、model=父继承）。整条写
  // 「继承父路由」的回执会谎称 provider 也来自父继承。
  const envPartial = agentEnv({ rowConfig: { agentOptions: { provider: 'zai' } } });
  const toolPartial = createAgentTool(envPartial.ctx, envPartial.view);
  const partial = await toolPartial.execute({ description: '甲', prompt: '任务。' }, EXEC);
  assert.deepEqual(envPartial.activations[0].request.agentOptions, { provider: 'zai' },
    '部分携带：行配置只给 provider 时携带恰该键');
  assert.match(partial.note,
    /Child LLM route: provider zai \(tool-configured default\); model deepseek-flash \(inherited from this agent\)\./,
    '混合路由按 provider／model 分写来源，有效 model 取父值（宿主合并结果）');
  assert.doesNotMatch(partial.note, /inherits parent route/, '不得整条谎称继承');

  // 行配置与后端默认各供一侧：provider=行配置（覆盖）、model=后端默认补齐。
  const envMixed = agentEnv({
    providers: {
      spawn: {
        name: 'spawn',
        prepareContinuable() {},
        capabilities: { agentOptions: true },
        agentRouteDefaults: { model: 'glm-5.3' }
      }
    },
    rowConfig: { agentOptions: { provider: 'zai' } }
  });
  const mixed = await createAgentTool(envMixed.ctx, envMixed.view)
    .execute({ description: '乙', prompt: '任务。' }, EXEC);
  assert.deepEqual(envMixed.activations[0].request.agentOptions, { provider: 'zai', model: 'glm-5.3' });
  assert.match(mixed.note,
    /Child LLM route: provider zai \(tool-configured default\); model glm-5\.3 \(backend route default\)\./,
    '后端默认补的一侧按后端默认标注，不冒称工具配置默认');

  // zh 档混合行文案同步。
  const envZh = agentEnv({ rowConfig: { agentOptions: { provider: 'zai' } } });
  envZh.setConfig({ agentLang: 'zh' });
  const zh = await createAgentTool(envZh.ctx, envZh.view)
    .execute({ description: '丙', prompt: '任务。' }, EXEC);
  assert.match(zh.note,
    /子代理 LLM 路由：供应商 zai（工具配置默认）；模型 deepseek-flash（继承自本代理）。/);
});

hostTest('async_agent：推理强度回执四档——显式/工具配置/后端/父继承各归其位（A-F05，en+zh）', async () => {
  // 父路由带强度（宿主 requestHeader 形态）：父继承档的判定输入。
  const execWithEffort = {
    agent: {
      id: 'session-parent-effort',
      options: {},
      session: {
        requestHeader() {
          return { config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'medium' } };
        }
      }
    }
  };

  // ① 父继承档：无显式、无配置默认、后端无路由默认、有效路由未变 → 继承
  //    父强度并标注 inherited（spawn 假件无 agentRouteDefaults）。
  const envInherit = agentEnv();
  const inheritResult = await createAgentTool(envInherit.ctx, envInherit.view)
    .execute({ description: '甲', prompt: '任务。' }, execWithEffort);
  assert.match(inheritResult.note, /Child LLM route: deepseek-official\/deepseek-flash \(inherited from this agent\)\./);
  assert.match(inheritResult.note, /\(reasoning effort: medium, inherited\)/,
    '有效路由未变且后端无路由默认 → 强度按父继承标注');

  // ② 后端默认档：agentRouteDefaults 带强度、行配置无路由键但有路由类触发
  //    （宿主同款：行配置 reasoningEffort 触发携带）——行配置覆盖强度后是
  //    配置档；改用行配置 maxTokens 触发不了携带，这里直接验证后端强度经
  //    覆盖判定：行配置只配 provider（覆盖路由）时强度来自后端默认。
  const envBackend = agentEnv({
    providers: {
      spawn: {
        name: 'spawn',
        prepareContinuable() {},
        capabilities: { agentOptions: true },
        agentRouteDefaults: { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'low' }
      }
    },
    rowConfig: { agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' } }
  });
  const backendResult = await createAgentTool(envBackend.ctx, envBackend.view)
    .execute({ description: '乙', prompt: '任务。' }, execWithEffort);
  assert.match(backendResult.note, /Child LLM route: deepseek-official\/deepseek-flash \(tool-configured default\)\./);
  assert.match(backendResult.note, /\(reasoning effort: low, backend default\)/,
    '强度来自 agentRouteDefaults 且行配置未覆盖 → 后端默认档');

  // ③ zh 档四档文案：显式请求档 + 工具配置默认档（zh 锚）。
  const envZh = agentEnv({ rowConfig: { agentOptions: { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'low' } } });
  envZh.setConfig({ agentLang: 'zh' });
  const zhResult = await createAgentTool(envZh.ctx, envZh.view)
    .execute({ description: '丙', prompt: '任务。' }, execWithEffort);
  assert.match(zhResult.note, /子代理 LLM 路由：zai\/glm-5\.3（工具配置默认）。/);
  assert.match(zhResult.note, /（推理强度：low，工具配置默认）/);
});

// ── A-F06 回归：条件参数随刷新增删；继承上下文的两套文案 ────────────────────

hostTest('async_agent：agent_preset 随后端能力变化就地增删——刷新与 execute 两个重算点（A-F06 反例一）', async () => {
  // 后端从无 capabilities.agentPreset 起步（spawn 假件不声明该能力）。
  const env = agentEnv({
    rowConfig: { allowedAgentPresets: ['reviewer'] },
    providers: {
      spawn: { name: 'spawn', prepareContinuable() {}, capabilities: { agentOptions: true } }
    }
  });
  const tool = createAgentTool(env.ctx, env.view);
  assert.equal('agent_preset' in tool.parameters.properties, false,
    '构造时后端不支持 → 不暴露（反例前状态）');

  // 后端注册成支持：刷新（重算点一）→ 借用 schema 原地新增条件键，不等设置变化。
  env.registry.spawn.capabilities = { agentOptions: true, agentPreset: true };
  refreshToolDescriptions(tool, env.view);
  assert.ok(tool.parameters.properties.agent_preset, '后端换成支持 + 刷新 → schema 出现 agent_preset');
  assert.match(tool.parameters.properties.agent_preset.description, /reviewer/,
    '新增键的说明取自行配置允许集合');

  // 反向移除：刷新 → 键从借用 schema 消失。
  env.registry.spawn.capabilities = { agentOptions: true };
  refreshToolDescriptions(tool, env.view);
  assert.equal('agent_preset' in tool.parameters.properties, false,
    '后端撤回支持 + 刷新 → agent_preset 消失');

  // execute 侧重算点（重算点二）：后端再次换成支持后，一次普通调用就地补键
  // （后端变化不等待下一次设置变化即生效——宿主下一次投影即见）。
  env.registry.spawn.capabilities = { agentOptions: true, agentPreset: true };
  await tool.execute({ description: '甲', prompt: '任务。' }, EXEC);
  assert.ok(tool.parameters.properties.agent_preset,
    '后端换成支持 + execute → 借用 schema 就地补上条件键');
});

hostTest('async_agent：继承上下文后端（fork）的描述与 prompt 说明如实写继承，spawn 保留自包含（A-F06 反例二）', () => {
  // fork 假件声明 inheritsParentContext：描述与 prompt 参数说明切换继承档。
  const envFork = agentEnv({
    providers: {
      fork: { name: 'fork', prepareContinuable() {}, capabilities: { agentOptions: true }, inheritsParentContext: true }
    }
  });
  envFork.setConfig({ subagentProvider: 'fork' });
  const forkTool = createAgentTool(envFork.ctx, envFork.view);
  assert.match(forkTool.description, /inherits the parent conversation context/,
    'fork 描述如实说明继承父对话上下文');
  assert.doesNotMatch(forkTool.description, /does not see this conversation/,
    '继承型后端不得写"看不到本对话"');
  assert.match(forkTool.parameters.properties.prompt.description,
    /inherits this conversation/,
    'fork 的 prompt 参数说明按继承语义生成');
  assert.doesNotMatch(forkTool.parameters.properties.prompt.description, /cannot see this conversation/);

  // zh 档同锁。
  envFork.setConfig({ agentLang: 'zh' });
  const forkZh = createAgentTool(envFork.ctx, envFork.view);
  assert.match(forkZh.description, /继承父对话上下文/);
  assert.doesNotMatch(forkZh.description, /看不到本对话/);
  assert.match(forkZh.parameters.properties.prompt.description, /继承本对话的上下文/);

  // 对照：spawn（非继承）保留自包含要求。
  const envSpawn = agentEnv();
  const spawnTool = createAgentTool(envSpawn.ctx, envSpawn.view);
  assert.match(spawnTool.description, /does not see this conversation/);
  assert.match(spawnTool.parameters.properties.prompt.description, /cannot see this conversation/);
});

// ── R3-F04 回归：宿主后端事件驱动模型侧刷新（真实 Cordis／ToolRuntime） ──────

const cordisModule = await loadOfflineSafe('@deepseek-ai/cordis');
const systemPromptModule = await loadOfflineSafe('@deepseek-ai/dsh-system-prompt');
const toolsHostModule = await loadOfflineSafe('@deepseek-ai/dsh-tools');
const realCordisTest = await hostTestByProbe(
  [agentModule, hostModule, cordisModule, systemPromptModule, toolsHostModule].some((m) => m === undefined)
);

realCordisTest('async_agent：宿主 subagent/provider-added／removed 事件后模型侧 schema 与任务书文案即时同步（R3-F04，真实 Cordis）', async () => {
  const { Context } = cordisModule;
  const { SystemPrompt } = systemPromptModule;
  const { ToolRuntime } = toolsHostModule;
  const { fakeCtx } = await import('./_helpers.mjs');

  const f = fakeCtx();
  const ctx = new Context();
  // 后端替身：能力与继承方式在测试中就地改写（宿主侧只经重注册广播——
  // 事件载荷带后端现值，与 registerProvider 的 emit 形态一致）。
  let current = {
    name: 'probe-backend', inheritsParentContext: false,
    capabilities: { agentPreset: false, agentOptions: true }, prepareContinuable() {}
  };
  ctx.provide('subagents', { getProvider: () => current });
  for (const key of ['jobs', 'shell', 'shellEnv', 'timer', 'sessionProjections', 'workingDirectory']) {
    ctx.provide(key, f.ctx[key]);
  }
  ctx.provide('agents', { get() {} });
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(hostModule, {
    toolName: 'async_agent', allowedAgentPresets: ['standard'],
    settings: { subagentProvider: 'probe-backend' }
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const snap = () => {
    const schema = ctx.tools.schemas().find((entry) => entry.name === 'async_agent');
    return {
      presetKey: schema?.parameters?.properties?.agent_preset !== undefined,
      promptDesc: schema?.parameters?.properties?.prompt?.description,
      description: schema?.description
    };
  };

  try {
    const initial = snap();
    assert.equal(initial.presetKey, false, '后端不声明 agentPreset 能力时 agent_preset 不暴露');

    // 能力增：provider-added 事件（载荷＝后端现值）→ 条件键即时出现，
    // 不等待设置变化、不先经一次创建调用。
    current = { ...current, capabilities: { agentPreset: true, agentOptions: true } };
    ctx.emit('subagent/provider-added', current);
    await tick();
    const afterCapability = snap();
    assert.equal(afterCapability.presetKey, true, 'provider-added 后 agent_preset 即时暴露（R3-F04 反例翻转）');

    // 继承方式变化按宿主语义＝注销＋重注册成对事件；任务书两语形态随之刷新。
    const beforeInherit = snap();
    current = { ...current, inheritsParentContext: true };
    ctx.emit('subagent/provider-removed', 'probe-backend');
    ctx.emit('subagent/provider-added', current);
    await tick();
    const afterInherit = snap();
    assert.notEqual(afterInherit.promptDesc, beforeInherit.promptDesc,
      'provider-removed＋added 成对事件后任务书文案按继承语义刷新（R3-F04 反例翻转）');
    assert.match(afterInherit.promptDesc, /inherits this conversation/);

    // 移除：provider-removed 事件 → 条件键即时收回。
    current = { ...current, capabilities: { agentOptions: true } };
    ctx.emit('subagent/provider-removed', 'probe-backend');
    await tick();
    assert.equal(snap().presetKey, false, 'provider-removed 后 agent_preset 即时收回');
  } finally {
    await ctx.fiber.dispose();
  }

  // zh 档事件刷新：语言档经 configView 现读，事件路径与设置路径共用同一刷新
  // 函数——中文行的任务书文案须随事件就地切到中文继承形态（若事件路径丢失
  // 语言处理固定 en，本腿红）。
  const zhCtx = new Context();
  let zhBackend = {
    name: 'probe-backend-zh', inheritsParentContext: false,
    capabilities: { agentOptions: true }, prepareContinuable() {}
  };
  zhCtx.provide('subagents', { getProvider: () => zhBackend });
  for (const key of ['jobs', 'shell', 'shellEnv', 'timer', 'sessionProjections', 'workingDirectory']) {
    zhCtx.provide(key, f.ctx[key]);
  }
  zhCtx.provide('agents', { get() {} });
  await zhCtx.plugin(SystemPrompt);
  await zhCtx.plugin(ToolRuntime);
  const zhProduct = await zhCtx.plugin(hostModule, {
    toolName: 'async_agent',
    settings: { subagentProvider: 'probe-backend-zh', agentLang: 'zh' }
  });
  const zhSnap = () => zhCtx.tools.schemas().find((entry) => entry.name === 'async_agent')
    ?.parameters?.properties?.prompt?.description;
  try {
    assert.match(zhSnap(), /看不到本对话/, 'zh 行初始任务书按自包含中文形态');
    zhBackend = { ...zhBackend, inheritsParentContext: true };
    zhCtx.emit('subagent/provider-added', zhBackend);
    await tick();
    assert.match(zhSnap(), /继承本对话的上下文/,
      'zh 行经 provider-added 事件后任务书切中文继承形态（事件路径不丢语言档）');
    assert.doesNotMatch(zhSnap(), /inherits this conversation/, '不得回落英文形态');

    // off() 取消效果：行卸载后订阅必须退订——改后端再发事件，描述不得再变
    //（若清理失效、订阅仍活，描述会翻回自包含形态，本断言红）。
    const settledDesc = zhSnap();
    await zhProduct.dispose();
    zhBackend = { ...zhBackend, inheritsParentContext: false };
    zhCtx.emit('subagent/provider-added', zhBackend);
    await tick();
    assert.equal(zhSnap() ?? settledDesc, settledDesc,
      '行卸载后事件订阅已退订——描述不再随事件刷新（off() 生效）');
  } finally {
    await zhCtx.fiber.dispose();
  }
});
