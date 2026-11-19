/**
 * 宿主契约分派层锚（设计 §7.4.7 HC-1..HC-5、HC-9）。
 *
 * 分工：HC-6（预设形态装载）在 preset 侧；HC-7 的准入本体在 host-compat 测试，
 * CI 文本腿在 test/ci-workflow.test.mjs；HC-8（wait_agent 隐藏）在
 * test/index.test.mjs 的 T19 邻近（同一 agent/created 装置形态）。
 *
 * ## 形态纪律（§7.4.1）
 *
 * 形态记忆是 `lib/host-contract.js` 的**进程级单例**：`node --test
 * --test-isolation=none` 下全部测试文件同进程共享。本文件加载即 pin 基线
 * 'nested'，形态分档用例经 withForm 在用例内 pin、finally 复原回基线——不
 * 串扰后续文件（与 agent.test.mjs 的文件级 pin 同一基线）。
 *
 * ## 红证明方式
 *
 * 分派层与参数面已随 lib 侧实现交付，锚按设计期望写死；每条锚配「注入错误
 * 实现／篡改输入必红」的对照腿（错误形状的 spec 直接喂 rc.2+ 入口、无 depth
 * 行混入、失败记忆不被恢复解析冲掉等）——锚对错误实现有分辨力；lib 侧实现
 * 与设计的偏差如实红出，由主线处理（本文件不改 lib）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostTestFor, loadOfflineSafe } from './_host-gate.mjs';
import {
  compareVersions,
  listDirectChildren,
  resolveHostSubagentVersion,
  startActivation as dispatchActivation,
  subagentContract
} from '../lib/host-contract.js';
import { checkedTool, pinSubagentForm } from './_helpers.mjs';
import { AgentTarget } from '../lib/wait-agent-target.js';
import { agentConditionalKeys, buildToolText } from '../lib/descriptions.js';
import { TEXT, t } from '../lib/text.js';
import { resolveConfig } from '../lib/config.js';
import { makeConfigView } from '../lib/config-view.js';

// 宿主链动态守卫：lib/agent.js（→ dsh-tools/dsh-subagent）与 lib/wait.js
//（→ dsh-tools）在离线形态缺席——依赖它们的用例自跳过并打印理由
//（ci.yml offline 作业的契约）；纯本地锚（host-contract／descriptions／text）
// 不受守卫影响，离线照常跑。
const agentModule = await loadOfflineSafe('../lib/agent.js');
const waitModule = await loadOfflineSafe('../lib/wait.js');
const { createAgentTool } = agentModule ?? {};
const { createWaitTool } = waitModule ?? {};
const agentHostTest = await hostTestFor('../lib/agent.js');
const waitHostTest = await hostTestFor('../lib/wait.js');

/** 文件级形态基线：与 agent.test.mjs 同一 rc.1 嵌套形态。 */
const FORM_BASELINE = 'nested';

// 加载即 pin 基线：后续文件的绿读数不依赖本文件的用例是否全部执行。
pinSubagentForm(FORM_BASELINE);

/**
 * 形态分档用例的统一包膜：pin 指定形态、finally 复原基线。
 * @param {'nested'|'flat'|'unknown'} form - 目标形态。
 * @param {() => any} fn - 用例体。
 */
async function withForm(form, fn) {
  pinSubagentForm(form);
  try {
    return await fn();
  } finally {
    pinSubagentForm(FORM_BASELINE);
  }
}

/** withForm 的同步版（纯本地锚用）。 */
function withFormSync(form, fn) {
  pinSubagentForm(form);
  try {
    return fn();
  } finally {
    pinSubagentForm(FORM_BASELINE);
  }
}

// ── HC-1：形态判定 ────────────────────────────────────────────────────────

test('HC-1 形态判定：subagentContract 三 fixture 分档＋失败记忆＋resolveHostSubagentVersion 失败形态', () => {
  withFormSync('nested', () => {
    assert.equal(subagentContract(), 'nested', 'rc.1 fixture（0.2.2-rc.1 < 边界 0.2.2-rc.2）判嵌套形态');
  });
  withFormSync('flat', () => {
    assert.equal(subagentContract(), 'flat', 'rc.2 fixture（0.2.2-rc.2 ≥ 边界）判扁平形态');
  });
  withFormSync('unknown', () => {
    assert.equal(subagentContract(), undefined, '条目注入失败（空串＝解析失败）→ 形态 undefined（不猜形态）');
    // 失败同样记忆（§7.4.1：模块实例内求值一次并记忆，含失败）：失败后即使解析
    // 恢复可用也不重读——对照腿，防止实现把 undefined 当「未求值」每次重试。
    // 注：subagentContract 的参数是**已解析条目**（与 JSDoc 的函数签名不符，
    // 以实现为准），此处直接传 rc.2 fixture 条目仍不得覆盖失败记忆。
    assert.equal(
      subagentContract(new URL('./_contract-forms/rc2/index.js', import.meta.url).href),
      undefined,
      '失败记忆不被后续可用解析冲掉（宿主版本在插件进程生命周期内不可变）'
    );
  });
  // resolveHostSubagentVersion 的失败形态（非字符串／空串条目 → undefined）。
  assert.equal(resolveHostSubagentVersion(42), undefined, '非字符串条目按解析失败处理');
  assert.equal(resolveHostSubagentVersion(''), undefined, '空串条目按解析失败处理');
});

test('HC-1 比较器边界：semver 预发布序以 0.2.2-rc.2 为界，乱串 NaN', () => {
  // 分派边界的两侧与等值（形态判定的直接输入）。
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2-rc.2'), -1);
  assert.equal(compareVersions('0.2.2-rc.3', '0.2.2-rc.2'), 1);
  assert.equal(compareVersions('0.2.2-rc.2', '0.2.2-rc.2'), 0);
  // 无预发布大于有预发布：正式 0.2.2 按序高于任何 rc（不是按字符串前缀）。
  assert.equal(compareVersions('0.2.2', '0.2.2-rc.9'), 1);
  // 数值三元组先于预发布比较（对照腿：先比预发布串的比较器在此必红）。
  assert.equal(compareVersions('0.2.1', '0.2.2-rc.1'), -1);
  // 预发布标识符数值段按数值比较（对照腿：字典序比较器会判 rc.9 > rc.10）。
  assert.equal(compareVersions('0.2.2-rc.9', '0.2.2-rc.10'), -1);
  // 乱串／undefined → NaN（调用方按解析失败处理，不冒充任何一侧）。
  for (const bad of ['garbage', undefined, '', '0.2.x']) {
    assert.ok(Number.isNaN(compareVersions(bad, '0.2.2-rc.2')), `乱串 ${JSON.stringify(bad)} 判 NaN`);
    assert.ok(Number.isNaN(compareVersions('0.2.2-rc.1', bad)), `对侧乱串 ${JSON.stringify(bad)} 同判 NaN`);
  }
});

test('HC-1 失败形态（等待侧）：形态 unknown 时目录查询归一为查询失败——childEntry undefined、knownChildren 空清单', async () => {
  await withForm('unknown', async () => {
    const ctx = { subagents: { listChildren: async () => [{ id: 'x' }], listDescendants: async () => [{ id: 'x', depth: 1 }] } };
    const target = new AgentTarget({ ctx, config: { agentLang: 'en' }, agentId: 'x', owner: 'o', t });
    assert.equal(await target.childEntry(), undefined, '形态 unknown → 查询失败（undefined），不猜形态选边');
    assert.deepEqual(await target.knownChildren(t), [], '清单查询同口径：失败按空清单放行，不冒充查无');
  });
});

agentHostTest('HC-1 失败形态（创建侧）：形态 unknown 时 async_agent 以 error.hostContractUnknown 拒绝且零派生', async () => {
  await withForm('unknown', async () => {
    const env = contractEnv();
    await assert.rejects(
      env.tool().execute({ description: 'd', prompt: 'p' }, EXEC),
      (error) => String(error?.message ?? error).includes(t('en', 'error.hostContractUnknown')),
      '形态未知按专用词典键明确拒绝（不猜形态、不返回句柄）'
    );
    assert.deepEqual(env.startCalls, [], '零派生：startActivation 未被调用');
  });
  // 对照腿：同装置在形态已知（基线 nested）下正常派生——证明拒绝出自形态判定，
  // 不是装置自身的故障。
  const env = contractEnv();
  const result = await env.tool().execute({ description: 'd', prompt: 'p' }, EXEC);
  assert.equal(result.status, 'started');
  assert.equal(env.startCalls.length, 1, '对照：形态已知同调用正常派生');
});

// ── HC-2：创建分派 ────────────────────────────────────────────────────────

/** 分派层的形态无关部件（§7.4.2：request 含全部任务字段）。 */
const HC2_PARTS = {
  provider: 'spawn',
  label: '标签甲',
  signal: undefined,
  delivery: 'parent',
  request: {
    prompt: [{ type: 'text', text: '任务书' }],
    parent: { id: 'session-parent-1' },
    cwd: 'workspace-a',
    agentPreset: 'reviewer',
    agentOptions: { provider: 'zai', model: 'glm-5.3' },
    maxDepth: 2
  }
};

/** 最小宿主回执。 */
const hcActivation = (childId) => ({
  childId,
  result: Promise.resolve({ stopReason: 'completed' }),
  dispose() { throw new Error('[test sentinel] dispose must never be called'); }
});

test('HC-2 创建分派：嵌套 spec.request 形状／扁平顶层形状；两形态产物都不触发宿主 spec.parent.id 读取的 TypeError', async () => {
  await withForm('nested', async () => {
    const specs = [];
    const ctx = { subagents: { startActivation: async (spec) => { specs.push(spec); return hcActivation('child-n1'); } } };
    const activation = await dispatchActivation(ctx, HC2_PARTS);
    assert.equal(activation.childId, 'child-n1', '宿主回执原样返回');
    const spec = specs[0];
    assert.equal(spec.provider, 'spawn');
    assert.equal(spec.label, '标签甲');
    assert.equal(spec.delivery, 'parent');
    // 任务字段全部在 request 内。
    for (const key of ['prompt', 'parent', 'cwd', 'agentPreset', 'agentOptions', 'maxDepth']) {
      assert.equal(spec.request[key], HC2_PARTS.request[key], `嵌套形态：${key} 在 request 内`);
    }
    assert.equal('prompt' in spec, false, '嵌套形态顶层无 prompt');
    assert.equal('parent' in spec, false, '嵌套形态顶层无 parent');
    assert.equal('name' in spec, false, 'rc.1 spec 无 name 键');
    assert.deepEqual(Object.keys(spec).sort(), ['delivery', 'label', 'provider', 'request', 'signal']);
    // 对照腿：嵌套形状直接喂「先读 spec.parent.id」的 rc.2+ 宿主入口必抛
    // TypeError——按 §7.4 事实清单这是同步抛、不是静默忽略；分派产物在扁平
    // 形态下必须消灭该形状（见下腿）。
    const rc2Entry = (s) => s.parent.id;
    assert.throws(() => rc2Entry(spec), TypeError, '嵌套残键喂 rc.2+ 入口同步抛 TypeError（对照腿）');
  });
  await withForm('flat', async () => {
    const specs = [];
    const ctx = { subagents: { startActivation: async (spec) => { specs.push(spec); return hcActivation('child-f1'); } } };
    await dispatchActivation(ctx, HC2_PARTS);
    const spec = specs[0];
    // 任务字段逐个置于顶层。
    for (const key of ['prompt', 'parent', 'cwd', 'agentPreset', 'agentOptions', 'maxDepth']) {
      assert.equal(spec[key], HC2_PARTS.request[key], `扁平形态：${key} 提升到顶层`);
    }
    assert.equal('request' in spec, false, 'request 键不出现（rc.2+ 入口读 spec.parent.id）');
    assert.equal(spec.provider, 'spawn');
    assert.equal(spec.label, '标签甲');
    assert.equal(spec.delivery, 'parent');
    // 模拟 rc.2+ 宿主入口先读 spec.parent.id：扁平产物不抛（两形态产物都不
    // 触发 TypeError 的扁平腿；嵌套腿的必红对照见上）。
    const rc2Entry = (s) => s.parent.id;
    assert.doesNotThrow(() => rc2Entry(spec));
    assert.equal(rc2Entry(spec), 'session-parent-1');
    assert.deepEqual(
      Object.keys(spec).sort(),
      ['agentOptions', 'agentPreset', 'cwd', 'delivery', 'label', 'maxDepth', 'parent', 'prompt', 'provider', 'signal']
    );
    // name 省缺不携带；合法携带。
    await dispatchActivation(ctx, HC2_PARTS);
    assert.equal('name' in specs[1], false, 'name 省缺不传（宿主分配 agent-N）');
    await dispatchActivation(ctx, { ...HC2_PARTS, name: 'worker-a' });
    assert.equal(specs[2].name, 'worker-a', '合法 name 经分派层携带');
  });
  // 形态未知是防御层抛错（async_agent 在更早处按词典键拒绝——HC-1 已锚）。
  await withForm('unknown', async () => {
    assert.throws(
      () => dispatchActivation({ subagents: { startActivation: async () => hcActivation('child-u1') } }, HC2_PARTS),
      /form unknown/,
      '形态未知时分派层不猜形态（防御层抛错）'
    );
  });
});

// ── HC-3：直接子过滤 ──────────────────────────────────────────────────────

/** rc.2+ 宿主形态的后代行集：depth1／depth2 混合＋depth1 诊断行。 */
const HC3_ROWS = [
  { id: 'hc3-child-a', label: '直接子A', activity: 'running', depth: 1, parentId: 'hc3-owner' },
  { id: 'hc3-child-b', label: '直接子B', activity: 'idle', depth: 1, parentId: 'hc3-owner' },
  { id: 'hc3-grandchild', label: 'hc3-deep-label', activity: 'running', depth: 2, parentId: 'hc3-child-a' },
  { kind: 'diagnostic', id: 'hc3-dir-unreadable', reason: 'unavailable', depth: 1, parentId: 'hc3-owner' }
];

test('HC-3 直接子过滤（AgentTarget.childEntry 腿）：只见 depth===1（诊断行保形），更深层零泄漏', async () => {
  await withForm('flat', async () => {
    const ctx = {
      subagents: {
        // 嵌套键在扁平 pin 下不得被触达（分派层按形态取键）。
        listChildren() { throw new Error('nested key must not be used under flat pin'); },
        async listDescendants(owner) {
          assert.equal(owner, 'hc3-owner', 'listDescendants 收到 root＝主体');
          return HC3_ROWS;
        }
      },
      agents: { get: (id) => ({ id, status: 'running' }) }
    };
    const target = (id) => new AgentTarget({ ctx, config: { agentLang: 'en' }, agentId: id, owner: 'hc3-owner', t });
    // 直接 listDirectChildren：depth1 行（含诊断行）保留、depth2 丢弃。
    const direct = await listDirectChildren(ctx, 'hc3-owner');
    assert.deepEqual(direct.map((row) => row.id), ['hc3-child-a', 'hc3-child-b', 'hc3-dir-unreadable']);
    // childEntry：depth1 命中；depth2 查无（不取得关系证明）；诊断行不算命中（§7.4.2 裁定）。
    assert.equal((await target('hc3-child-a').childEntry()).id, 'hc3-child-a');
    assert.equal(await target('hc3-grandchild').childEntry(), null, '更深层行零泄漏：按查无（null）交回');
    assert.equal(await target('hc3-dir-unreadable').childEntry(), null, '诊断行不算命中');
    // knownChildren 清单：depth1 行＋诊断行 reason 保形；depth2 行零泄漏。
    const lines = await target('hc3-child-a').knownChildren(t);
    assert.equal(lines.length, 3, '清单恰三个 depth===1 行');
    assert.ok(lines.some((line) => line.includes('hc3-child-a')), '直接子行进清单');
    assert.ok(
      lines.some((line) => line.includes('hc3-dir-unreadable') && line.includes('unavailable')),
      '第一层诊断行以 reason 保形进纠错清单'
    );
    assert.ok(!lines.some((line) => line.includes('hc3-deep-label')), '更深层行不进纠错清单');
    // 对照腿（变异红探测器）：无 depth 的行（listChildren 形状混入）全部丢弃——
    // 过滤要求 depth===1 本身，不做「默认当直接子」的宽松回退；恒等映射必红。
    const bareCtx = {
      subagents: {
        async listDescendants() {
          return [
            { id: 'hc3-bare', label: '无 depth 行', activity: 'running' },
            { id: 'hc3-kept', label: '有 depth 行', activity: 'running', depth: 1 }
          ];
        }
      }
    };
    const kept = await listDirectChildren(bareCtx, 'hc3-owner');
    assert.deepEqual(kept.map((row) => row.id), ['hc3-kept'], '缺 depth 的行零放行（对照腿：过滤不是恒等映射）');
  });
});

/**
 * HC-3 wait 腿的最小装置：真 createWaitTool + 双键替身（扁平 pin 下只提供
 * listDescendants；挂起原语冻结为零等待确定性）。
 * @param {object[]} rows - listDescendants 行集。
 */
function hcWaitRig(rows) {
  const parent = { id: 'hc3-owner', session: { append() {} }, inbox: { nextStep: [], nextTurn: [] } };
  const adapter = {
    jobs: {
      list: () => [],
      get: () => undefined,
      read: async () => ({ chunks: [] }),
      wait: async () => ({ status: 'running' })
    },
    subagents: {
      listChildren() { throw new Error('nested key must not be used under flat pin'); },
      async listDescendants() { return rows; }
    },
    agents: { get: (id) => (id === parent.id ? parent : { id, status: 'running' }) },
    on: () => () => {},
    get: () => undefined,
    logger: { info() {}, warn() {} },
    timer: { timeout: () => () => {}, interval: () => () => {} }
  };
  const config = resolveConfig({ toolName: 'async_wait', minWaitMs: 1 });
  const waiter = checkedTool(createWaitTool(adapter, config));
  return { waiter, exec: () => ({ agent: parent, signal: new AbortController().signal }) };
}

waitHostTest('HC-3 直接子过滤（wait 零等待共享路径腿）：depth2 目标按查无拒绝，清单零深层泄漏', async () => {
  await withForm('flat', async () => {
    const rig = hcWaitRig(HC3_ROWS);
    let caught;
    try {
      await rig.waiter.execute(
        { wait_ms: 0, targets: [{ kind: 'agent', id: 'hc3-grandchild' }] },
        rig.exec()
      );
    } catch (error) {
      caught = error;
    }
    const text = String(caught?.message ?? caught);
    assert.ok(caught !== undefined, '深层目标不取得等待资格——按查无出口可读拒绝');
    assert.ok(text.includes('hc3-grandchild'), '错误点名目标');
    // 渲染链断言：清单只见 depth1 行＋诊断行 reason，深层行标签零泄漏。
    assert.ok(text.includes('hc3-child-a'), '清单含直接子行');
    assert.ok(text.includes('hc3-dir-unreadable (diagnostic: unavailable)'), '诊断行按 list.diagnostic 渲染 reason');
    assert.ok(!text.includes('hc3-deep-label'), '更深层行不进清单（零泄漏）');
  });
});

// ── HC-4／HC-5 的 execute 级装置（agent.test.mjs 的 agentEnv 同族紧凑版） ──

/** 白名单基线：父路由与显式路由都在名单内。 */
const HC_ROUTES = [
  { provider: 'zai', model: 'glm-5.3' },
  { provider: 'deepseek-official', model: 'deepseek-flash' }
];

/** 父代理（HC-5 父继承腿：父路由带 reasoningEffort）。 */
const EXEC = {
  agent: {
    id: 'session-parent-1',
    options: {},
    session: {
      requestHeader() {
        return { config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } };
      }
    }
  }
};

/**
 * 构造 async_agent 的 execute 级测试环境（与 agent.test.mjs 的 agentEnv 同族，
 * 只保留 HC 锚走到的成员）。
 * @param {object} [options]
 * @param {object} [options.rowConfig] 行级委托键（agentOptions——HC-5 的行配置路由腿）。
 * @param {object} [options.selection] 模型选择服务状态（默认 enabled＋HC_ROUTES）。
 * @param {string} [options.startActivationImpl] 'duplicate'＝宿主在 startActivation
 *   入口抛 DUPLICATE_AGENT_NAME（派生前拒绝）。
 * @param {string|undefined} [options.activationName] 宿主回执的 name（undefined＝无名链形态）。
 */
function contractEnv({ rowConfig, selection = { enabled: true, allowedModels: HC_ROUTES }, startActivationImpl, activationName } = {}) {
  const registry = {
    spawn: { name: 'spawn', prepareContinuable() {}, capabilities: { agentOptions: true, agentPreset: true } }
  };
  const getProviderQueries = [];
  /** 每次 startActivation 调用（无论成败）——「零派生」断言的计数面。 */
  const startCalls = [];
  /** 成功建立的回执对应 spec（抛错形态不进——宿主拒绝即子代理未建起）。 */
  const activations = [];
  const preflightCalls = [];
  const selectionReads = [];

  const subagents = {
    getProvider(name) {
      getProviderQueries.push(name);
      return Object.prototype.hasOwnProperty.call(registry, name) ? registry[name] : undefined;
    },
    resolveMaxDepth() { return undefined; },
    async startActivation(spec) {
      startCalls.push(spec);
      if (startActivationImpl === 'duplicate' || startActivationImpl === 'duplicate-legacy-name') {
        const error = new Error('name "worker-a" conflicts with an in-flight reservation');
        // 真机形状（rc.2 实例验证 2026-11-18 实证）：宿主 SubagentError 恒
        // name='SubagentError'、身份码在 .code；legacy 腿钉 error.name 后备容错。
        if (startActivationImpl === 'duplicate') {
          error.name = 'SubagentError';
          error.code = 'DUPLICATE_AGENT_NAME';
        } else {
          error.name = 'DUPLICATE_AGENT_NAME';
        }
        throw error;
      }
      if (startActivationImpl === 'invalid-code') {
        const error = new Error('agent name may only contain lowercase letters, digits and hyphens');
        error.name = 'SubagentError';
        error.code = 'INVALID_AGENT_NAME';
        throw error;
      }
      const activation = {
        childId: `child-${startCalls.length}`,
        ...(activationName === undefined ? {} : { name: activationName }),
        result: Promise.resolve({ stopReason: 'completed' }),
        dispose() { throw new Error('[test sentinel] dispose must never be called'); }
      };
      activations.push(spec);
      return activation;
    }
  };

  const llm = {
    async resolveCallConfig(config, signal) {
      preflightCalls.push({ config, signal });
      return { config, signal };
    }
  };
  const selectionService = {
    current() {
      selectionReads.push(selectionReads.length);
      return selection;
    }
  };

  const ctx = {
    subagents,
    get(name) {
      if (name === 'subagentModelSelection') return selectionService;
      if (name === 'llm') return llm;
      return undefined;
    },
    timer: { timeout: () => () => {}, interval: () => () => {} },
    on: () => () => {}
  };
  const view = makeConfigView(() => resolveConfig(rowConfig ?? {}));

  return {
    ctx,
    view,
    getProviderQueries,
    startCalls,
    activations,
    preflightCalls,
    selectionReads,
    /** 形态分档下构造被测工具（构造读形态——必须在 withForm 内调用）。 */
    tool: () => checkedTool(createAgentTool(ctx, view))
  };
}

// ── HC-4：name ────────────────────────────────────────────────────────────

agentHostTest('HC-4 name：扁平参数面暴露、spec 传递、回执地址行（含无名链回退）；嵌套拒绝', async () => {
  await withForm('flat', async () => {
    const envKeys = contractEnv();
    assert.ok('name' in envKeys.tool().parameters.properties, '扁平形态参数表含 name（条件键重算）');
    assert.equal(envKeys.tool().parameters.properties.name.description, t('en', 'param.agent.name'), '参数说明取新键 param.agent.name');
    assert.ok(
      agentConditionalKeys(envKeys.ctx, resolveConfig({})).declaredArguments.includes('name'),
      'declaredArguments（未知键校验集合）同重算含 name'
    );
    // 合法 name → spec 顶层携带（经 execute 全链路）；回执地址行取宿主确认名
    //（宿主回执带 name＝名称链确认）。
    const env = contractEnv({ activationName: 'worker-a' });
    const tool = env.tool();
    const result = await tool.execute({ description: 'd', prompt: 'p', name: 'worker-a' }, EXEC);
    assert.equal(env.activations[0].name, 'worker-a', 'spec 顶层携带合法 name');
    assert.equal(result.agent_id, 'child-1', 'agent_id 恒为稳定 childId（不把名称塞进 ID 字段）');
    assert.ok(
      result.note.includes(t('en', 'note.agentAddress', { address: 'worker-a' })),
      '地址行附宿主确认的 activation.name（send_message/interrupt_agent 用地址，async_wait 仍用 agent_id）'
    );
    // 无名链回退：宿主回执无 name → 地址行回退 childId（需求 §2.3.1 接受回退）。
    const envFallback = contractEnv();
    const fallback = await envFallback.tool().execute({ description: 'd', prompt: 'p' }, EXEC);
    assert.ok(
      fallback.note.includes(t('en', 'note.agentAddress', { address: 'child-1' })),
      '无名链回退：地址行取 childId'
    );
    assert.equal('name' in envFallback.activations[0], false, 'name 省缺不携带（宿主分配 agent-N）');
  });
  await withForm('nested', async () => {
    const env = contractEnv();
    const tool = env.tool();
    assert.equal('name' in tool.parameters.properties, false, '嵌套形态参数表无 name');
    const result = await tool.execute({ description: 'd', prompt: 'p' }, EXEC);
    assert.ok(!result.note.includes('Subagent address:'), '嵌套形态回执与现状逐字一致——无地址行');
    // 拒绝腿用独立装置：零派生断言不被上面的成功调用污染。
    const envReject = contractEnv();
    await assert.rejects(
      envReject.tool().execute({ description: 'd', prompt: 'p', name: 'worker-a' }, EXEC),
      /unsupported argument\(s\): name/,
      'rc.1 收到 name 走未知键拒绝（条件暴露＋自报未知键是唯一可靠拒绝层）'
    );
    assert.deepEqual(envReject.startCalls, [], '嵌套形态 name 零派生');
  });
});

agentHostTest('HC-4 name：非法名（大写／数字开头／33 长／连字符开头）与 lead 本地拒绝 error.nameInvalid、零派生', async () => {
  await withForm('flat', async () => {
    for (const bad of ['Worker', '1worker', `a${'b'.repeat(32)}`, '-worker', 'lead']) {
      const env = contractEnv();
      await assert.rejects(
        env.tool().execute({ description: 'd', prompt: 'p', name: bad }, EXEC),
        (error) => String(error?.message ?? error).includes(t('en', 'error.nameInvalid')),
        `非法名 ${JSON.stringify(bad)} 按本地语法预校验拒绝`
      );
      assert.equal(env.startCalls.length, 0, `非法名 ${JSON.stringify(bad)} 零派生（先于宿主给出可读错误）`);
    }
    // 边界内合法值（32 字符下界/上界邻近）照常派生——对照腿，防止校验过紧。
    const envOk = contractEnv();
    await envOk.tool().execute({ description: 'd', prompt: 'p', name: 'ab' }, EXEC);
    assert.equal(envOk.startCalls.length, 1, '合法短名照常派生（对照腿）');
  });
});

agentHostTest('HC-4 name：宿主 DUPLICATE_AGENT_NAME → error.nameRejected 透传原因、零派生', async () => {
  await withForm('flat', async () => {
    // 主腿＝真机形状（SubagentError＋code 身份码）；legacy 腿＝error.name 形态后备容错。
    for (const impl of ['duplicate', 'duplicate-legacy-name']) {
      const env = contractEnv({ startActivationImpl: impl });
      const reasonPrefix = TEXT.en['error.nameRejected'].replace('{reason}', '').trim();
      await assert.rejects(
        env.tool().execute({ description: 'd', prompt: 'p', name: 'worker-a' }, EXEC),
        (error) => {
          const text = String(error?.message ?? error);
          return text.includes(reasonPrefix) && text.includes('in-flight reservation');
        },
        `宿主拒绝（${impl}）按 nameRejected 包裹透传真实原因（单行化），不擅自改名不重试`
      );
      assert.equal(env.startCalls.length, 1, '宿主在 startActivation 入口拒绝（调用发生）');
      assert.deepEqual(env.activations, [], '零派生：替身抛错即未返回回执，子代理未建起');
    }
  });
});

agentHostTest('HC-4 name：宿主 INVALID_AGENT_NAME（code 形态）同样按 nameRejected 包裹、零派生', async () => {
  await withForm('flat', async () => {
    const env = contractEnv({ startActivationImpl: 'invalid-code' });
    const reasonPrefix = TEXT.en['error.nameRejected'].replace('{reason}', '').trim();
    await assert.rejects(
      env.tool().execute({ description: 'd', prompt: 'p', name: 'worker-a' }, EXEC),
      (error) => {
        const text = String(error?.message ?? error);
        return text.includes(reasonPrefix) && text.includes('lowercase letters');
      },
      '宿主侧 INVALID 身份码与 DUPLICATE 同径包裹（本地预校验先行的对照面——宿主拒绝仍可读）'
    );
    assert.equal(env.startCalls.length, 1, '宿主在 startActivation 入口拒绝（调用发生）');
    assert.deepEqual(env.activations, [], '零派生');
  });
});

// ── HC-5：reasoning_effort 成对 ────────────────────────────────────────────

agentHostTest('HC-5 成对（校验层）：扁平单独 effort 拒绝 error.effortRequiresRoute（行配置路由不 rescue）；嵌套单独 effort 合法', async () => {
  await withForm('flat', async () => {
    const env = contractEnv();
    await assert.rejects(
      env.tool().execute({ description: 'd', prompt: 'p', reasoning_effort: 'high' }, EXEC),
      (error) => String(error?.message ?? error).includes(t('en', 'error.effortRequiresRoute')),
      '扁平形态显式 reasoning_effort 必须同时提供 provider＋model'
    );
    assert.deepEqual(env.startCalls, [], '零派生');
    // 行配置路由在场不 rescue（宿主校验同口径：只看 args 层）。
    const envRow = contractEnv({ rowConfig: { agentOptions: { provider: 'zai', model: 'glm-5.3' } } });
    await assert.rejects(
      envRow.tool().execute({ description: 'd', prompt: 'p', reasoning_effort: 'high' }, EXEC),
      (error) => String(error?.message ?? error).includes(t('en', 'error.effortRequiresRoute')),
      '行配置携带的路由不 rescue 显式强度（supply both or omit all three）'
    );
    assert.deepEqual(envRow.startCalls, [], '零派生保持');
  });
  await withForm('nested', async () => {
    const env = contractEnv();
    const result = await env.tool().execute({ description: 'd', prompt: 'p', reasoning_effort: 'high' }, EXEC);
    assert.equal(env.activations.length, 1, '嵌套形态单独指定合法（rc.1 维持）');
    assert.deepEqual(env.activations[0].request.agentOptions, { reasoningEffort: 'high' }, '携带集＝仅强度');
    assert.ok(result.note.includes(t('en', 'route.effortSuffix', { effort: 'high' })), '回执按请求档标注强度');
  });
});

agentHostTest('HC-5 成对（合并/预检/回执层）：扁平显式路由省缺强度→不携带不补父不标继承；args 全省略两形态标父继承', async () => {
  // ① 扁平：显式 provider+model（与父同值）省缺强度 → 携带集无 reasoningEffort、
  // 预检不补父强度、回执不标父继承（路由未变也不沿用父/配置强度）。
  await withForm('flat', async () => {
    const env = contractEnv();
    const result = await env.tool().execute(
      { description: 'd', prompt: 'p', provider: 'deepseek-official', model: 'deepseek-flash' },
      EXEC
    );
    // 扁平形态任务字段在 spec 顶层（HC-2 已锚形状）。
    assert.equal('reasoningEffort' in env.activations[0].agentOptions, false, '携带集无配置/父强度（交给宿主按所选模型默认）');
    assert.equal('reasoningEffort' in env.preflightCalls[0].config, false, '预检不补父强度');
    assert.ok(!result.note.includes(', inherited)'), '回执不标父继承（显式路由即关继承，含与父同值）');
  });
  // ② args 全省略且无行配置/后端默认 → 两形态都标父继承（父强度 high）；
  // 无任何层贡献时不携带 agentOptions（嵌套在 request 内、扁平在顶层）。
  for (const form of ['flat', 'nested']) {
    await withForm(form, async () => {
      const env = contractEnv();
      const result = await env.tool().execute({ description: 'd', prompt: 'p' }, EXEC);
      assert.equal('agentOptions' in env.activations[0], false, `${form} 形态：无任何层贡献时不携带 agentOptions（扁平看顶层、嵌套看 request——两者都不得有）`);
      if (form === 'nested') {
        assert.equal('agentOptions' in env.activations[0].request, false, '嵌套形态 request 内同样无 agentOptions');
      }
      assert.ok(
        result.note.includes(t('en', 'route.effortInherited', { effort: 'high' })),
        `${form} 形态：args 全省略标父继承`
      );
    });
  }
});

agentHostTest('HC-5 成对（args 层边缘）：行配置路由恰＝父路由＋配置无强度→标父继承；行配置路由与父不同→不标（用所选模型默认）', async () => {
  // 边缘甲：行配置路由恰等于父路由、配置无强度、args 全省略——扁平按父继承预检
  //（宿主与本包同形；§7.4.3 预检条），回执标父继承。
  await withForm('flat', async () => {
    const envSame = contractEnv({ rowConfig: { agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' } } });
    const same = await envSame.tool().execute({ description: 'd', prompt: 'p' }, EXEC);
    assert.ok(
      same.note.includes(t('en', 'route.effortInherited', { effort: 'high' })),
      '行配置路由恰＝父路由：标父继承（args 层同形判定的边缘）'
    );
    assert.equal(envSame.preflightCalls[0].config.reasoningEffort, 'high', '预检按父强度代入（开关开且路由未变）');
  });
  // 边缘乙：行配置路由与父不同——父强度被换路由挡下，回执不标父继承（用所选
  // 模型默认）。嵌套同形态对照（现行口径：routeChanged 挡下）。
  for (const form of ['nested', 'flat']) {
    await withForm(form, async () => {
      const envDiff = contractEnv({ rowConfig: { agentOptions: { provider: 'zai', model: 'glm-5.3' } } });
      const diff = await envDiff.tool().execute({ description: 'd', prompt: 'p' }, EXEC);
      assert.ok(
        !diff.note.includes(t('en', 'route.effortInherited', { effort: 'high' })),
        `${form} 形态：行配置路由与父不同不标父继承（用所选模型默认）`
      );
    });
  }
});

// ── HC-9：文案与描述分派 ──────────────────────────────────────────────────

test('HC-9 文案分派：targets id 选键（id／idFlat）、agent 参数表 name 在／缺、构建产物与词典两语零 wait_agent、新键两语在场', () => {
  const enConfig = resolveConfig({ toolName: 'async_wait' });
  const zhConfig = resolveConfig({ toolName: 'async_wait', agentLang: 'zh' });
  const agentKeys = (ctx) => agentConditionalKeys(ctx, resolveConfig({}));

  withFormSync('nested', () => {
    const waitEn = buildToolText('async_wait', enConfig);
    assert.equal(
      waitEn.parameters.targets.items.properties.id.description,
      t('en', 'param.wait.targets.id'),
      '嵌套形态 id 说明取原键（list_agents shows ids 口径）'
    );
    assert.equal(
      buildToolText('async_wait', zhConfig).parameters.targets.items.properties.id.description,
      t('zh', 'param.wait.targets.id'),
      'zh 档同键'
    );
    assert.equal('name' in buildToolText('async_agent', enConfig).parameters, false, '嵌套形态 agent 参数表无 name');
    assert.ok(!agentKeys({ subagents: { getProvider: () => undefined } }).declaredArguments.includes('name'), 'declaredArguments 不含 name');
  });
  withFormSync('flat', () => {
    const waitEn = buildToolText('async_wait', enConfig);
    assert.equal(
      waitEn.parameters.targets.items.properties.id.description,
      t('en', 'param.wait.targets.idFlat'),
      '扁平形态 id 说明取 idFlat 键（list_agents 显示名称口径句）'
    );
    assert.ok(waitEn.parameters.targets.items.properties.id.description.includes('list_agents'), 'idFlat 含 list_agents 名称口径句');
    assert.equal(
      buildToolText('async_wait', zhConfig).parameters.targets.items.properties.id.description,
      t('zh', 'param.wait.targets.idFlat'),
      'zh 档同键'
    );
    const agentParams = buildToolText('async_agent', enConfig).parameters;
    assert.ok('name' in agentParams, '扁平形态 agent 参数表含 name');
    assert.equal(agentParams.name.description, t('en', 'param.agent.name'), '参数说明取新键');
    assert.ok(agentKeys({ subagents: { getProvider: () => undefined } }).declaredArguments.includes('name'), 'declaredArguments 含 name');
  });

  // 两语词典键值零 wait_agent 字样（§7.4.4：wait_agent 零指路——值串层判据，
  // 注释不在词典值内）。
  for (const lang of ['en', 'zh']) {
    for (const [key, value] of Object.entries(TEXT[lang])) {
      assert.equal(typeof value, 'string', `TEXT.${lang}[${key}] 是字符串`);
      assert.ok(!value.includes('wait_agent'), `TEXT.${lang}[${key}] 值含 wait_agent 字样（零指路纪律）`);
    }
  }
  // 构建产物（描述＋全部参数说明）两语×两形态零 wait_agent——词典判据之外的
  // 组装层防线。
  for (const config of [enConfig, zhConfig]) {
    for (const form of ['nested', 'flat']) {
      withFormSync(form, () => {
        for (const name of ['async_wait', 'async_agent']) {
          const built = buildToolText(name, config);
          const texts = [built.description, ...Object.values(built.parameters).map((spec) => String(spec?.description ?? ''))];
          for (const text of texts) {
            assert.ok(!text.includes('wait_agent'), `${name}（${config.agentLang}/${form}）构建产物含 wait_agent`);
          }
        }
      });
    }
  }
  // 新键两语在场（check-model-text 键数为动态对账，无固定登记数——此处锁键本体）。
  for (const key of [
    'param.agent.name', 'error.nameInvalid', 'error.nameRejected', 'error.effortRequiresRoute',
    'error.hostContractUnknown', 'note.agentAddress', 'param.wait.targets.idFlat'
  ]) {
    assert.ok(typeof TEXT.en[key] === 'string' && TEXT.en[key].length > 0, `en 缺新键 ${key}`);
    assert.ok(typeof TEXT.zh[key] === 'string' && TEXT.zh[key].length > 0, `zh 缺新键 ${key}`);
  }
});
