/**
 * `async_list_subagent_models` 的单元测试（需求 §2.3.4 路由查询，设计 §3.7）。
 *
 * 假件纪律：
 * - 假 `llm` 只实现 `listProviders` / `listModels` / `resolveModelInfo`，全部
 *   记录调用——「不创建代理、不发模型请求、不改任何设置」由这些探针的形状断言；
 * - 假 `ctx.tools` 实现 `schemas`（可见工具投影）＋`get`（身份段的对象同一性
 *   比对读口）；`async_agent` 的创建行配置经 `registerToolRow` 向工具行登记簿
 *   登记（入口 applyWith 同款），创建行 `subagentProvider` 与查询行配置分离——
 *   「按创建行判后端」的两行分离形态在这里可失败；
 * - 假 `subagents` 只实现 `getProvider`（async_agent 目标的后端段证据，设计
 *   §3.7）与拒绝性 `startActivation`（只读纪律探针）；
 * - 假 `subagentModelSelection`（现读口径）与假 `sessionProjections`（原生投影）
 *   分开配置——async_agent 与原生目标的两条口径差别用例直接对比；
 * - 假 `systemPrompt.assemble`（身份依据②的组稿桩）按当前原生行名渲染
 *   `tool:<名>` 段——段在场／缺席／抛错／服务缺席四种形态对应身份段的
 *   可证／遮蔽／读取失败（设计 §3.7 双依据）。
 */
import assert from 'node:assert/strict';
import { hostTestByProbe, hostTestFor, loadOfflineSafe } from './_host-gate.mjs';
import { resolveConfig } from '../lib/config.js';
import { makeConfigView } from '../lib/config-view.js';
import { registerToolRow } from '../lib/tool-rows.js';
import { checkedTool } from './_helpers.mjs';

const listModule = await loadOfflineSafe('../lib/list-models.js');
const { createListModelsTool } = listModule ?? {};
const hostTest = await hostTestFor('../lib/list-models.js');

/** 目录夹具：两个供应商、若干模型（同名条目跨 kind 故意并存——不合并判据）。 */
const PROVIDERS = [
  { id: 'zai', name: 'Z.ai' },
  { id: 'deepseek-official', name: 'DeepSeek' }
];
const MODELS = {
  'zai': [
    { provider: 'zai', id: 'glm-5.3', name: 'GLM 5.3', description: 'fast general model' },
    { provider: 'zai', id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }
  ],
  'deepseek-official': [
    { provider: 'deepseek-official', id: 'deepseek-flash', name: 'DeepSeek Flash' },
    { provider: 'deepseek-official', id: 'glm-5.3', name: 'Same Name Model' }
  ]
};
const ROUTES = [
  { provider: 'zai', model: 'glm-5.3' },
  { provider: 'deepseek-official', model: 'deepseek-flash' }
];

/**
 * 可见工具投影夹具：async_agent＋可选的原生创建工具行。`agentRouteParams`／
 * `agentEffortParam` 控制 async_agent 自己的参数形状（示例字段按目标可见形状
 * 判定的判据在这里可失败）；`nativeName` 可把原生行改成用户配置名（身份段判
 * 据的失败形态）。
 */
function toolSchemas({
  native = false, nativeName = 'subagent', nativeRouteParams = true, nativeEffortParam = false,
  agentRouteParams = true, agentEffortParam = false
} = {}) {
  const schemas = [{
    name: 'async_agent',
    description: 'delegation',
    parameters: {
      properties: {
        description: { type: 'string' },
        prompt: { type: 'string' },
        ...(agentRouteParams ? { provider: { type: 'string' }, model: { type: 'string' } } : {}),
        ...(agentEffortParam ? { reasoning_effort: { type: 'string' } } : {})
      }
    }
  }];
  if (native) {
    schemas.push({
      name: nativeName,
      description: 'native',
      parameters: {
        properties: {
          description: { type: 'string' },
          prompt: { type: 'string' },
          ...(nativeRouteParams ? { provider: { type: 'string' }, model: { type: 'string' } } : {}),
          ...(nativeEffortParam ? { reasoning_effort: { type: 'string' } } : {})
        }
      }
    });
  }
  // 干扰项：有 description 无 prompt 的工具不是创建工具候选。
  schemas.push({ name: 'async_run', description: 'shell', parameters: { properties: { command: { type: 'string' }, description: { type: 'string' } } } });
  return schemas;
}

/**
 * 构造查询环境。
 * @param {object} [options]
 * @param {'ok'|'absent'} [options.llmMode] llm 服务形态。
 * @param {object|'absent'|'throws'} [options.selection] subagentModelSelection
 *   形态：对象=恒定状态（缺省 enabled）；'absent'=服务缺席；'throws'=current() 抛错。
 * @param {'absent'|Array|'throw'|null} [options.projection] 原生会话投影形态：
 *   'absent'=键未注册语义（stateOf undefined）；数组=策略路由表；null=无记录；
 *   'throw'=读取抛错。
 * @param {object} [options.schemas] 可见工具投影（toolSchemas 的选项）。
 * @param {'ok'|'missing'|'no-options'|'no-continuable'|'throw'} [options.backend]
 *   后端注册表形态。
 * @param {'native'|'shadow'|'throws'|'absent'} [options.systemPrompt] 身份依据②
 *   的组稿形态（默认 'native'——非空段命中）。
 * @param {'en'|'zh'} [options.agentLang] 语言档。
 */
function listEnv({
  llmMode = 'ok', selection = { enabled: true, allowedModels: ROUTES }, projection = 'absent',
  schemas = {}, backend = 'ok', systemPrompt = 'native', agentLang = 'en',
  identity = 'ours', creationProvider = 'spawn', catalog = {},
  creationAgentPreset
} = {}) {
  const calls = { listProviders: 0, listModels: [], resolveModelInfo: [], current: 0, stateOf: 0, getProvider: 0, startActivation: 0, toolsGet: 0 };
  const failingProviders = new Set();
  // 目录覆盖（R6-F01 碰撞用例：provider/model 含斜杠的目录形状）——缺省用
  // 模块级常量夹具。
  const providers = catalog.providers ?? PROVIDERS;
  const models = catalog.models ?? MODELS;

  const llm = llmMode === 'absent' ? undefined : {
    listProviders() {
      calls.listProviders += 1;
      return providers.map((p) => ({ ...p }));
    },
    async listModels(provider) {
      calls.listModels.push(provider);
      if (failingProviders.has(provider)) throw new Error(`catalog down for ${provider}`);
      return (models[provider] ?? []).map((m) => ({ ...m }));
    },
    async resolveModelInfo(provider, model) {
      calls.resolveModelInfo.push({ provider, model });
      if (provider === 'zai' && model === 'missing-model') throw new Error('no such model');
      if (provider === 'zai' && model === 'unsupported-model') {
        throw Object.assign(new Error('pi-ai provider "zai" has no configured model "unsupported-model"'), { code: 'UNKNOWN_MODEL' });
      }
      if (provider === 'zai' && model === 'wrapped-model') {
        throw Object.assign(new Error('wrapped failure'), { cause: Object.assign(new Error('inner'), { code: 'UNKNOWN_MODEL' }) });
      }
      const base = models[provider]?.find((m) => m.id === model);
      return {
        provider, id: model, name: base?.name ?? model,
        description: base?.description,
        reasoning: provider === 'zai'
          ? { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' }
          : undefined
      };
    }
  };

  const selectionService = selection === 'absent' || selection === 'throws' ? undefined : {
    current() {
      calls.current += 1;
      if (selection === 'throws') throw new Error('enabled with empty allowed list');
      return selection;
    }
  };
  // 'throws' 形态需要服务在场但 current() 抛错——用一个抛错的替身补齐。
  const selectionThrows = selection === 'throws'
    ? { current() { calls.current += 1; throw new Error('enabled with empty allowed list'); } }
    : undefined;

  const subagentsService = {
    getProvider(name) {
      calls.getProvider += 1;
      // 名称感知的未注册形态：创建行配置指向的后端名不在注册表——两行分离
      // （创建行 subagentProvider ≠ 查询行默认）的失败判据用。
      if (name === 'no-such-backend') return undefined;
      if (backend === 'missing') return undefined;
      if (backend === 'throw') throw new Error('registry exploded');
      if (backend === 'no-options') return { name, capabilities: {} };
      if (backend === 'no-continuable') return { name, capabilities: { agentOptions: true } };
      if (backend === 'preset-inherits') {
        return {
          name, capabilities: { agentOptions: true, agentPreset: true },
          prepareContinuable() {}, inheritsParentContext: true
        };
      }
      if (backend === 'preset-ok') {
        return { name, capabilities: { agentOptions: true, agentPreset: true }, prepareContinuable() {} };
      }
      return { name, capabilities: { agentOptions: true }, prepareContinuable() {} };
    },
    async startActivation() {
      calls.startActivation += 1;
      throw new Error('[sentinel] query tool must not start activations');
    }
  };

  const projections = {
    stateOf(session, key) {
      calls.stateOf += 1;
      if (projection === 'throw') throw new Error('fold exploded');
      return projection === 'absent' || projection === null ? (projection === null ? null : undefined) : projection;
    }
  };

  // 身份依据②的组稿桩：'native'＝按当前原生行名渲染非空 `tool:<名>` 段
  // （对象同一性命中的形态）；'shadow'＝组稿没有该段（同名遮蔽／未装载／
  // 行配别名）；'throws'＝组稿抛错；'absent'＝systemPrompt 服务缺席。
  const systemPromptService = systemPrompt === 'absent' || systemPrompt === 'throws'
    ? (systemPrompt === 'throws'
      ? { async assemble() { throw new Error('assemble exploded'); } }
      : undefined)
    : {
      async assemble() {
        calls.assemble = (calls.assemble ?? 0) + 1;
        return {
          sections: systemPrompt === 'native'
            ? [{ name: `tool:${schemas.nativeName ?? 'subagent'}`, text: 'native subagent creation tool' }]
            : []
        };
      }
    };

  const EXEC_AGENT = { id: 'parent-1', session: { id: 'sess-1' } };

  // 身份段（设计 §3.7）：async_agent 的创建行配置视图与工具对象。`identity`
  // 控制 `tools.get` 读口形态：'ours'=返回登记在册的创建行工具（对象同一性
  // 命中）；'foreign'=同名外来登记（get 命中但对象不在登记簿）；'none'=get
  // 查无（与候选枚举矛盾）；'throws'=get 抛错；'no-get'=tools 服务无 get。
  const creationView = makeConfigView(() => resolveConfig({
    agentLang, subagentProvider: creationProvider,
    ...(creationAgentPreset === undefined ? {} : { agentPreset: creationAgentPreset })
  }));
  const asyncAgentTool = { name: 'async_agent', marker: 'creation-row' };
  registerToolRow(asyncAgentTool, creationView);

  const ctx = {
    get(name) {
      if (name === 'llm') return llm;
      if (name === 'subagentModelSelection') return selectionThrows ?? selectionService;
      if (name === 'systemPrompt') return systemPromptService;
      return undefined;
    },
    tools: {
      schemas() { return toolSchemas(schemas); },
      ...(identity === 'no-get' ? {} : {
        get(name) {
          calls.toolsGet += 1;
          if (identity === 'throws') throw new Error('identity exploded');
          if (identity === 'ours') return name === 'async_agent' ? asyncAgentTool : undefined;
          if (identity === 'foreign') return { name, foreign: true };
          return undefined;
        }
      })
    },
    sessionProjections: projections,
    subagents: subagentsService
  };

  const view = makeConfigView(() => resolveConfig({ agentLang }));

  return {
    ctx, view, calls, failingProviders, exec: { agent: EXEC_AGENT },
    /** 就地翻转选择服务状态（实时口径的可失败判据）。 */
    setSelection(state) { selection = state; },
    /** 就地换投影形态（原生目标口径）。 */
    setProjection(form) { projection = form; },
    /** 就地换后端注册表形态。 */
    setBackend(form) { backend = form; }
  };
}

hostTest('供应商浏览：默认第 1 页 20 条、稳定排序、页脚与下一页提示（§2.3.4）', async () => {
  const env = listEnv();
  const tool = checkedTool(createListModelsTool(env.ctx, env.view));

  const result = await tool.execute({}, env.exec);
  assert.equal(result.mode, 'providers');
  assert.equal(result.page, 1);
  assert.equal(result.page_size, 20);
  assert.equal(result.total, 2);
  assert.equal(result.has_next, false);
  assert.deepEqual(result.entries.map((e) => e.id), ['deepseek-official', 'zai'],
    '按供应商 ID 字典序稳定排序');
  assert.match(result.version, /^[0-9a-f]{12}$/, '版本令牌是 12 位十六进制摘要');
  // 数量口径（§2.3.4）：目标策略确认（名单含 zai/glm-5.3 与 deepseek-official/
  // deepseek-flash）→ 允许模型数＝名单中该供应商路由数（zai=1、
  // deepseek-official=1），内部清单不进回显。
  const byId = Object.fromEntries(result.entries.map((e) => [e.id, e]));
  assert.equal(byId.zai.count_kind, 'allowed');
  assert.equal(byId.zai.model_count, 1);
  assert.equal(byId['deepseek-official'].count_kind, 'allowed');
  assert.equal(byId['deepseek-official'].model_count, 1);
  assert.equal('catalog_model_ids' in byId.zai, false, '内部清单不进回显');
  // 渲染：模型唯一可见出口含页脚与适用性行。
  const text = tool.output.render({}, result)[0].text;
  assert.match(text, /Subagent LLM providers \(page 1, 2 total\):/);
  assert.match(text, /deepseek-official — DeepSeek \(1 allowed model/);
  assert.match(text, /zai — Z\.ai \(1 allowed model/);
  assert.match(text, /Target async_agent: explicit route selection allowed — current dsh model-selection settings: enabled, 2 allowed route\(s\)/);
});

hostTest('供应商数量口径：依据确认→允许计数（不因列举失败丢口径）；未确认或不允许→目录已知数／unknown（§2.3.4）', async () => {
  // ① 适用性未确认（服务缺席）：全部供应商标目录已知数。
  const envAbsent = listEnv({ selection: 'absent' });
  const toolAbsent = checkedTool(createListModelsTool(envAbsent.ctx, envAbsent.view));
  const unconfirmed = await toolAbsent.execute({}, envAbsent.exec);
  const byIdU = Object.fromEntries(unconfirmed.entries.map((e) => [e.id, e]));
  assert.equal(byIdU.zai.count_kind, 'catalog');
  assert.equal(byIdU.zai.model_count, 2, '目录已知数取目录全量（与名单无关）');
  assert.match(toolAbsent.output.render({}, unconfirmed)[0].text, /zai — Z\.ai \(2 model\(s\) in catalog\)/);

  // ② 开关关（not-allowed）：同拍标目录已知数（不能冒称允许模型数）。
  const envOff = listEnv({ selection: { enabled: false, allowedModels: ROUTES } });
  const toolOff = checkedTool(createListModelsTool(envOff.ctx, envOff.view));
  const off = await toolOff.execute({}, envOff.exec);
  const byIdO = Object.fromEntries(off.entries.map((e) => [e.id, e]));
  assert.equal(byIdO.zai.count_kind, 'catalog');

  // ③ 依据已确认＋列举失败：允许计数仍取名单（计数来源是已确认策略，与目录
  //    列举成败无关），完整性照标。
  const envFail = listEnv();
  envFail.failingProviders.add('zai');
  const toolFail = checkedTool(createListModelsTool(envFail.ctx, envFail.view));
  const partial = await toolFail.execute({}, envFail.exec);
  const byIdF = Object.fromEntries(partial.entries.map((e) => [e.id, e]));
  assert.equal(byIdF.zai.count_kind, 'allowed');
  assert.equal(byIdF.zai.model_count, 1, '允许计数＝名单中该供应商路由总数');
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.failed_providers, ['zai']);
  const partialText = toolFail.output.render({}, partial)[0].text;
  assert.match(partialText, /zai — Z\.ai \(1 allowed model/);
  assert.match(partialText, /incomplete: 1 provider listing\(s\) failed/);

  // ④ 依据未确认＋列举失败：unknown（不冒充零模型，也没有允许口径可报）。
  const envUnknown = listEnv({ selection: 'absent' });
  envUnknown.failingProviders.add('zai');
  const toolUnknown = checkedTool(createListModelsTool(envUnknown.ctx, envUnknown.view));
  const unknown = await toolUnknown.execute({}, envUnknown.exec);
  const byIdN = Object.fromEntries(unknown.entries.map((e) => [e.id, e]));
  assert.equal(byIdN.zai.count_kind, 'unknown');
  assert.equal(byIdN.zai.model_count, null);
  assert.match(toolUnknown.output.render({}, unknown)[0].text, /zai — Z\.ai \(model count unavailable \(listing failed\)\)/);
});

hostTest('分页：page_size 生效、越界缺令牌拒绝、令牌不匹配拒绝拼接、越过末页给空页出路（§2.3.4）', async () => {
  const env = listEnv();
  const tool = checkedTool(createListModelsTool(env.ctx, env.view));

  // ① page>1 缺令牌：可读拒绝。
  await assert.rejects(tool.execute({ page: 2 }, env.exec), /page 2 requires the version token/);
  // ② 令牌不匹配（伪造）：拒绝拼接。
  await assert.rejects(
    tool.execute({ page: 2, version: 'deadbeefdead' }, env.exec),
    /result version changed since the previous page|cannot be stitched/
  );
  // ③ 正常翻页：第 1 页 page_size=1 → next 带令牌 → 第 2 页带令牌成功。
  const page1 = await tool.execute({ page_size: 1 }, env.exec);
  assert.equal(page1.entries.length, 1);
  assert.equal(page1.has_next, true);
  assert.deepEqual(page1.next, { page: 2, page_size: 1, version: page1.version });
  const page2 = await tool.execute({ page_size: 1, page: 2, version: page1.version }, env.exec);
  assert.deepEqual(page2.entries.map((e) => e.id), ['zai']);
  assert.equal(page2.has_next, false);
  // ④ 越过末页：空页＋总数＋重查出路，不报错。
  const beyond = await tool.execute({ page_size: 1, page: 9, version: page1.version }, env.exec);
  assert.equal(beyond.beyond_end, true);
  assert.deepEqual(beyond.entries, []);
  assert.equal(beyond.total, 2);
  assert.match(tool.output.render({}, beyond)[0].text, /beyond the last page/);
  // ⑤ 边界校验：page 非正整数／page_size 越界。
  await assert.rejects(tool.execute({ page: 0 }, env.exec), /page must be a positive integer/);
  await assert.rejects(tool.execute({ page_size: 0 }, env.exec), /between 1 and 100/);
  await assert.rejects(tool.execute({ page_size: 101 }, env.exec), /between 1 and 100/);
  await assert.rejects(tool.execute({ page_size: 1.5 }, env.exec), /between 1 and 100/);
});

hostTest('版本令牌锚定目录条目全部返回内容字段：仅条目说明变化也使旧令牌失效（§2.3.4，设计 §3.7）', async () => {
  // 条目说明（description）随条目返回：说明变化改变第 2 页起的新页内容——
  // 目录摘要必须覆盖全部影响返回内容的字段，仅说明变化也要拒拼旧令牌。
  const models = {
    zai: [
      { provider: 'zai', id: 'glm-5.3', name: 'GLM 5.3', description: 'rev-1 wording' },
      { provider: 'zai', id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', description: 'stable wording' }
    ]
  };
  const env = listEnv({ catalog: { models } });
  const tool = checkedTool(createListModelsTool(env.ctx, env.view));

  const page1 = await tool.execute({ provider: 'zai', page_size: 1 }, env.exec);
  assert.equal(page1.entries[0].description, 'rev-1 wording');
  // 目录更新：只改**第 2 页**那个条目的说明（id、名称、条数、策略全不动）——
  // 第 1 页内容不变，但令牌输入集变了。
  models.zai[1].description = 'rev-2 wording';
  await assert.rejects(
    tool.execute({ provider: 'zai', page_size: 1, page: 2, version: page1.version }, env.exec),
    /cannot be stitched|version changed/
  );
  const fresh = await tool.execute({ provider: 'zai', page_size: 1 }, env.exec);
  assert.notEqual(fresh.version, page1.version, '仅条目说明变化也必须使令牌不同');
});

hostTest('版本令牌锚定决定性输入：名单翻转后旧令牌的翻页被拒（§2.3.4）', async () => {
  const env = listEnv();
  const tool = checkedTool(createListModelsTool(env.ctx, env.view));

  const page1 = await tool.execute({ page_size: 1 }, env.exec);
  // 决定性输入变化（策略内容翻转）：同一查询的版本令牌必须变——翻页被拒。
  env.setSelection({ enabled: false, allowedModels: ROUTES });
  await assert.rejects(
    tool.execute({ page_size: 1, page: 2, version: page1.version }, env.exec),
    /cannot be stitched|version changed/
  );
  // 第 1 页不带旧令牌重查：拿到新令牌。
  const fresh = await tool.execute({ page_size: 1 }, env.exec);
  assert.notEqual(fresh.version, page1.version, '策略内容参与版本令牌');
});

hostTest('版本令牌锚定策略实质：名单同条数换内容也换版本（§2.3.4）', async () => {
  const env = listEnv();
  const tool = checkedTool(createListModelsTool(env.ctx, env.view));

  const page1 = await tool.execute({ page_size: 1 }, env.exec);
  // 名单 [zai/glm-5.3, deepseek-official/deepseek-flash] → 换一条（条数不变、
  // 类别键不变、basis 文本条数不变）——仅记判断类别键的令牌不会变，策略实质
  // 参与的令牌必须变。
  env.setSelection({
    enabled: true,
    allowedModels: [
      { provider: 'zai', model: 'glm-5.3-flash' },
      { provider: 'deepseek-official', model: 'deepseek-flash' }
    ]
  });
  await assert.rejects(
    tool.execute({ page_size: 1, page: 2, version: page1.version }, env.exec),
    /cannot be stitched|version changed/,
    '名单内容替换（条数不变）必须使旧令牌失效'
  );
  const fresh = await tool.execute({ page_size: 1 }, env.exec);
  assert.notEqual(fresh.version, page1.version, '名单条目参与版本令牌（非仅类别键）');
});

hostTest('供应商内模型浏览与搜索：忽略大小写包含匹配 ID 与名称；纯空白等同未提供（§2.3.4）', async () => {
  const env = listEnv();
  const tool = checkedTool(createListModelsTool(env.ctx, env.view));

  // 浏览：zai 的模型全列、按 ID 字典序。
  const all = await tool.execute({ provider: 'zai' }, env.exec);
  assert.equal(all.mode, 'models');
  assert.deepEqual(all.entries.map((e) => e.id), ['glm-5.3', 'glm-5.3-flash']);
  assert.deepEqual(env.calls.listModels, ['zai'], '供应商内恰一次 listModels');
  // 元数据缺席不写键：undefined 值会让宿主 lossless JSON 快照整体拒绝。
  const withDesc = all.entries.find((e) => e.id === 'glm-5.3');
  const noDesc = all.entries.find((e) => e.id === 'glm-5.3-flash');
  assert.equal(withDesc.description, 'fast general model');
  assert.equal('description' in noDesc, false, '无元数据的模型条目不得带 description 键（undefined 值过不了宿主快照）');

  // 搜索（名称命中，忽略大小写）：flash 匹配名称。
  const byName = await tool.execute({ provider: 'zai', query: 'FLASH' }, env.exec);
  assert.deepEqual(byName.entries.map((e) => e.id), ['glm-5.3-flash']);
  // 搜索（ID 前缀命中）。
  const byId = await tool.execute({ provider: 'zai', query: 'glm-5.3' }, env.exec);
  assert.deepEqual(byId.entries.map((e) => e.id), ['glm-5.3', 'glm-5.3-flash']);
  // 纯空白：等同未提供（浏览全集）。
  const blank = await tool.execute({ provider: 'zai', query: '   ' }, env.exec);
  assert.equal(blank.total, 2);
  // 供应商命中＝整组随行（设计 §3.7 统一包含匹配）：查询词命中供应商 ID——
  // 即使没有模型名含 'zai'，该供应商条目整组保留。
  const byProviderId = await tool.execute({ provider: 'zai', query: 'zai' }, env.exec);
  assert.deepEqual(byProviderId.entries.map((e) => e.id), ['glm-5.3', 'glm-5.3-flash'],
    '供应商 ID 命中＝该供应商模型整组随行（供应商内搜索同样认供应商字段）');
  // 查询词命中供应商显示名称（忽略大小写）同判。
  const byProviderName = await tool.execute({ provider: 'zai', query: 'Z.AI' }, env.exec);
  assert.deepEqual(byProviderName.entries.map((e) => e.id), ['glm-5.3', 'glm-5.3-flash'],
    '供应商显示名称命中＝整组随行');
  // 统一不变式：指定供应商搜索的命中集＝跨供应商搜索中该供应商的命中集。
  const scoped = await tool.execute({ provider: 'zai', query: 'glm' }, env.exec);
  const cross = await tool.execute({ query: 'glm' }, env.exec);
  assert.deepEqual(scoped.entries.map((e) => `${e.provider}/${e.id}`),
    cross.entries.filter((e) => e.kind === 'model' && e.provider === 'zai').map((e) => `${e.provider}/${e.id}`),
    '供应商内搜索命中集与跨供应商搜索中该供应商的命中集一致');
  // 无命中（确证空目录）：空结果＋可读说明。
  const none = await tool.execute({ provider: 'zai', query: 'nothing' }, env.exec);
  assert.deepEqual(none.entries, []);
  assert.match(tool.output.render({}, none)[0].text, /no matches for "nothing"/);
});

hostTest('供应商不在目录：说明前置、条目照常渲染、空态专属承担（R5-F01，§2.3.4）', async () => {
  // 确无路由：如实说明没有已列模型，不报错、不冒充零模型计数。
  const env = listEnv();
  const tool = checkedTool(createListModelsTool(env.ctx, env.view));
  const result = await tool.execute({ provider: 'ghost' }, env.exec);
  assert.deepEqual(result.entries, []);
  assert.equal(result.unlisted_provider, 'ghost');
  assert.deepEqual(env.calls.listModels, [], '不在目录的供应商不触发 listModels');
  const textBare = tool.output.render({}, result)[0].text;
  assert.match(textBare, /"ghost" is not in the current catalog/);
  assert.doesNotMatch(textBare, /no advertised models for/,
    '空态由未列说明专属承担，不叠加通用空目录文案');

  // 有允许名单路由：说明行是**前置说明**——条目循环照常执行（准确 ID 渲染），
  // 不是只报说明不列条目。
  const envAllowed = listEnv({
    selection: { enabled: true, allowedModels: [{ provider: 'ghost', model: 'ghost-model' }] }
  });
  const toolAllowed = checkedTool(createListModelsTool(envAllowed.ctx, envAllowed.view));
  const allowed = await toolAllowed.execute({ provider: 'ghost' }, envAllowed.exec);
  assert.equal(allowed.unlisted_provider, 'ghost');
  assert.deepEqual(allowed.entries.map((e) => `${e.provider}/${e.id}`), ['ghost/ghost-model'],
    '未列供应商的允许名单条目必须进入结果（说明行不得替代条目渲染）');
  const textAllowed = toolAllowed.output.render({}, allowed)[0].text;
  assert.match(textAllowed, /entries below come from the confirmed allow list/);
  assert.match(textAllowed, /ghost\/ghost-model/);

  // 有路由但搜索无匹配：NoMatch 专属说明（路由仍在），不写通用「无匹配」叠加。
  const noMatch = await toolAllowed.execute({ provider: 'ghost', query: 'nothing' }, envAllowed.exec);
  assert.deepEqual(noMatch.entries, []);
  const textNoMatch = toolAllowed.output.render({}, noMatch)[0].text;
  assert.match(textNoMatch, /its allow-list routes are present but none match "nothing"/);
  assert.doesNotMatch(textNoMatch, /no matches for/, '未列供应商空态由专属键承担，不与通用无匹配叠加');
});

hostTest('跨供应商搜索：供应商条目与模型条目并存，同名条目不合并（§2.3.4）', async () => {
  const env = listEnv();
  const tool = checkedTool(createListModelsTool(env.ctx, env.view));

  // 'zai' 命中：供应商条目 + 两条模型（zai/glm-5.3、zai/glm-5.3-flash）。
  const byProvider = await tool.execute({ query: 'zai' }, env.exec);
  assert.equal(byProvider.mode, 'search');
  assert.deepEqual(byProvider.entries.map((e) => (e.kind === 'provider' ? `provider:${e.id}` : `model:${e.provider}/${e.id}`)),
    ['provider:zai', 'model:zai/glm-5.3', 'model:zai/glm-5.3-flash']);
  // 同名不合并：'glm-5.3' 命中两个供应商的同名模型（ID 包含匹配也带上
  // glm-5.3-flash）——三条都列，排序按供应商 ID、模型 ID 字典序。
  const sameName = await tool.execute({ query: 'glm-5.3' }, env.exec);
  assert.deepEqual(sameName.entries.map((e) => `${e.provider}/${e.id}`),
    ['deepseek-official/glm-5.3', 'zai/glm-5.3', 'zai/glm-5.3-flash'],
    '同名条目跨供应商都列（排序：供应商 ID、模型 ID 字典序）');
});

hostTest('准确模型详情：推理强度与默认值；model 缺 provider 拒绝；解析失败可读上抛（§2.3.4）', async () => {
  const env = listEnv();
  const tool = checkedTool(createListModelsTool(env.ctx, env.view));

  await assert.rejects(tool.execute({ model: 'glm-5.3' }, env.exec), /model requires provider/);

  const detail = await tool.execute({ provider: 'zai', model: 'glm-5.3' }, env.exec);
  assert.equal(detail.mode, 'model-detail');
  assert.equal(detail.total, 1);
  assert.equal(detail.verdict, 'allowed', '名单内路由的详情判定为允许');
  const info = detail.entries[0];
  assert.equal(info.id, 'glm-5.3');
  assert.deepEqual(info.efforts.map((e) => e.id), ['low', 'high']);
  assert.equal(info.default_effort, 'low');
  const text = tool.output.render({}, detail)[0].text;
  assert.match(text, /Model zai\/glm-5\.3:/);
  assert.match(text, /low \(default\) — Low/);
  assert.match(text, /high — High/);

  // 不做广告推理强度的模型：占位说明（deepseek-official 无 reasoning）。
  const bare = await tool.execute({ provider: 'deepseek-official', model: 'deepseek-flash' }, env.exec);
  assert.equal(bare.entries[0].efforts, undefined);
  assert.match(tool.output.render({}, bare)[0].text, /no advertised reasoning efforts/);
  // 详情模式同样：description 缺席不写键（resolveModelInfo 夹具对 deepseek 返回
  // undefined——undefined 值过不了宿主 lossless 快照）。
  assert.equal('description' in bare.entries[0], false, '详情条目无元数据时不得带 description 键');

  // 详情解析失败两档定性（设计 §3.7，按稳定错误 code 分类，不解析 message）：
  // 无稳定 code 的失败＝读取失败档（保留原始原因）。
  await assert.rejects(
    tool.execute({ provider: 'zai', model: 'missing-model' }, env.exec),
    /reading the details of model zai\/missing-model failed: no such model/
  );
  // 适配器以稳定 code UNKNOWN_MODEL 报告模型未配置＝不支持档（无原因后缀）。
  await assert.rejects(
    tool.execute({ provider: 'zai', model: 'unsupported-model' }, env.exec),
    /reports model zai\/unsupported-model as nonexistent or unsupported$/
  );
  // 包装错误（原始错误挂在 cause 上）沿 cause 链取 code，同判不支持档。
  await assert.rejects(
    tool.execute({ provider: 'zai', model: 'wrapped-model' }, env.exec),
    /reports model zai\/wrapped-model as nonexistent or unsupported$/
  );

  // 冲突拒绝（§2.3.4）：非空搜索词不能与准确详情同时请求；纯空白搜索词不冲突
  //（等同未提供）。provider+query 的供应商内搜索不受影响（见上一用例）。
  await assert.rejects(
    tool.execute({ provider: 'zai', model: 'glm-5.3', query: 'flash' }, env.exec),
    /cannot be combined with an exact model detail lookup/
  );
  const blankOk = await tool.execute({ provider: 'zai', model: 'glm-5.3', query: '   ' }, env.exec);
  assert.equal(blankOk.mode, 'model-detail', '纯空白搜索词等同未提供，不构成冲突');
});

hostTest('名单外路由的准确详情：判不允许并写明原因，详情仍完整返回、不生成示例（§2.3.4）', async () => {
  const env = listEnv();
  const tool = checkedTool(createListModelsTool(env.ctx, env.view));

  // 名单只有 zai/glm-5.3 与 deepseek-official/deepseek-flash——查 glm-5.3-flash
  // 的详情：目标允许但该路由未获准，判定按具体路由取档。
  const denied = await tool.execute({ provider: 'zai', model: 'glm-5.3-flash' }, env.exec);
  assert.equal(denied.verdict, 'not-allowed');
  assert.match(denied.basis, /zai\/glm-5\.3-flash is not in the confirmed allowed set for this target/);
  assert.equal(denied.example, undefined, '名单外路由不生成创建示例');
  // 详情仍完整返回（条目字段不缺）。
  const info = denied.entries[0];
  assert.equal(info.id, 'glm-5.3-flash');
  assert.equal(info.name, 'GLM 5.3 Flash');
  assert.deepEqual(info.efforts.map((e) => e.id), ['low', 'high']);
  const text = tool.output.render({}, denied)[0].text;
  assert.match(text, /Model zai\/glm-5\.3-flash:/);
  assert.match(text, /low \(default\) — Low/);
  assert.doesNotMatch(text, /Example arguments/, '渲染不得宣传名单外路由的创建调用');
});

hostTest('部分失败：供应商列举失败不记零模型——总数为已取得数（含名单派生条目）、标记不完整（§2.3.4）', async () => {
  const env = listEnv();
  env.failingProviders.add('zai');
  const tool = checkedTool(createListModelsTool(env.ctx, env.view));

  const result = await tool.execute({ query: 'glm-5.3' }, env.exec);
  assert.equal(result.complete, false);
  assert.deepEqual(result.failed_providers, ['zai']);
  // 总数 = 已取得数：deepseek-official 的同名条目 1 条＋zai 名单派生的
  // glm-5.3（已确认允许集合不因目录列举失败丢失）；失败部分不折成零。
  assert.deepEqual(result.entries.map((e) => `${e.provider}/${e.id}${e.source === 'allowed-list' ? '*' : ''}`),
    ['deepseek-official/glm-5.3', 'zai/glm-5.3*']);
  assert.equal(result.total, 2);
  assert.match(tool.output.render({}, result)[0].text, /incomplete: 1 provider listing\(s\) failed/);
});

hostTest('目标适用性——async_agent 策略段按现读设置：开／关／服务缺席／读取失败（§2.3.4）', async () => {
  // ① 开：允许＋条数依据。
  const envOn = listEnv();
  const on = await createListModelsTool(envOn.ctx, envOn.view).execute({}, envOn.exec);
  assert.equal(on.target, 'async_agent');
  assert.equal(on.verdict, 'allowed');
  assert.match(on.basis, /enabled, 2 allowed route\(s\)/);

  // ② 关：不允许选择＋出路说明（默认与继承不受影响）。
  const envOff = listEnv({ selection: { enabled: false, allowedModels: ROUTES } });
  const off = await createListModelsTool(envOff.ctx, envOff.view).execute({}, envOff.exec);
  assert.equal(off.verdict, 'not-allowed');
  assert.match(off.basis, /disabled in the current dsh model-selection settings/);

  // ③ 实时翻转：同一工具下一次调用即新读数（现读口径）。
  envOff.setSelection({ enabled: true, allowedModels: ROUTES });
  const flipped = await createListModelsTool(envOff.ctx, envOff.view).execute({}, envOff.exec);
  assert.equal(flipped.verdict, 'allowed', 'async_agent 口径跟现读设置走（无会话冻结）');

  // ④ 服务缺席／读取失败：适用性未确认并说明原因（不阻断目录查询本身）。
  const envAbsent = listEnv({ selection: 'absent' });
  const absent = await createListModelsTool(envAbsent.ctx, envAbsent.view).execute({}, envAbsent.exec);
  assert.equal(absent.verdict, 'unconfirmed');
  assert.match(absent.basis, /absent in this composition/);
  assert.equal(absent.total, 2, '服务缺席不阻断目录查询');

  const envThrows = listEnv({ selection: 'throws' });
  const threw = await createListModelsTool(envThrows.ctx, envThrows.view).execute({}, envThrows.exec);
  assert.equal(threw.verdict, 'unconfirmed');
  assert.match(threw.basis, /could not be read: enabled with empty allowed list/);
});

hostTest('目标适用性——async_agent 后端段：未注册／不支持 agentOptions／注册表抛错（§2.3.4）', async () => {
  // ① 未注册：已确认限制——不允许选择，不生成适用创建调用，目录照常返回。
  const envMissing = listEnv({ backend: 'missing' });
  const missing = await createListModelsTool(envMissing.ctx, envMissing.view).execute({ provider: 'zai' }, envMissing.exec);
  assert.equal(missing.verdict, 'not-allowed');
  assert.match(missing.basis, /"spawn" is not registered/);
  assert.equal(missing.example, undefined);
  assert.equal(missing.total, 2, '后端限制不阻断目录');
  assert.equal(missing.entries[0].selectable, undefined, '无已确认允许集合时不标可选项');

  // ② 注册在场但不声明 agentOptions：同判不允许（执行期同样会被拒绝）。
  const envNoOpts = listEnv({ backend: 'no-options' });
  const noOpts = await createListModelsTool(envNoOpts.ctx, envNoOpts.view).execute({ provider: 'zai' }, envNoOpts.exec);
  assert.equal(noOpts.verdict, 'not-allowed');
  assert.match(noOpts.basis, /does not support child model selection/);
  assert.equal(noOpts.example, undefined);

  // ③ 注册表读取抛错：适用性未确认并给原因，目录照常返回。
  const envThrow = listEnv({ backend: 'throw' });
  const threw = await createListModelsTool(envThrow.ctx, envThrow.view).execute({ provider: 'zai' }, envThrow.exec);
  assert.equal(threw.verdict, 'unconfirmed');
  assert.match(threw.basis, /registry could not be read: registry exploded/);
  assert.equal(threw.total, 2);

  // ④ 策略段已确认不允许（开关关）时先报策略段；后端段不参与该判定。
  const envOff = listEnv({ backend: 'missing', selection: { enabled: false, allowedModels: ROUTES } });
  const offFirst = await createListModelsTool(envOff.ctx, envOff.view).execute({ provider: 'zai' }, envOff.exec);
  assert.match(offFirst.basis, /disabled in the current dsh model-selection settings/);

  // ⑤ 声明 agentOptions 但缺 prepareContinuable：查询侧同判不允许（R3-F02
  //    反例——查询允许而后端在创建前拒绝可续支持，同配置出现「查询允许、
  //    创建拒绝」的矛盾组合）；两语言文案与示例生成条件同步。
  const envNoCont = listEnv({ backend: 'no-continuable' });
  const noCont = await createListModelsTool(envNoCont.ctx, envNoCont.view).execute({ provider: 'zai' }, envNoCont.exec);
  assert.equal(noCont.verdict, 'not-allowed');
  assert.match(noCont.basis, /"spawn" provides no continuable support/);
  assert.equal(noCont.example, undefined, '后端限制不生成适用示例');
  assert.equal(noCont.entries[0].selectable, undefined, '无已确认允许集合不标可选项');
  assert.equal(noCont.total, 2, '后端限制不阻断目录');
  const envNoContZh = listEnv({ backend: 'no-continuable', agentLang: 'zh' });
  const noContZh = await createListModelsTool(envNoContZh.ctx, envNoContZh.view).execute({ provider: 'zai' }, envNoContZh.exec);
  assert.match(noContZh.basis, /未提供可续支持（缺 prepareContinuable）/);
});

hostTest('目标适用性——创建行默认预设的后端条件：后端不支持独立预设时查询同判不允许（R6-F03，§2.3.4）', async () => {
  // 反例形态（主侧真实插件行对照）：后端可续且支持 agentOptions、不支持
  // agentPreset；创建行配置默认预设 → 创建在派生前按 presetNoBackend 拒绝、
  // 零派生，查询却仍判 allowed 并生成示例——同配置的矛盾组合。
  const envNoPreset = listEnv({ creationAgentPreset: 'custom-preset' });
  const denied = await createListModelsTool(envNoPreset.ctx, envNoPreset.view).execute({ provider: 'zai' }, envNoPreset.exec);
  assert.equal(denied.verdict, 'not-allowed');
  assert.match(denied.basis, /"spawn" does not support standalone presets/);
  assert.equal(denied.example, undefined, '后端限制不生成适用示例');
  assert.equal(denied.entries[0].selectable, undefined, '无已确认允许集合不标可选项');
  assert.equal(denied.total, 2, '限制不阻断目录查询');
  // 中文档文案同步。
  const envZh = listEnv({ creationAgentPreset: 'custom-preset', agentLang: 'zh' });
  const deniedZh = await createListModelsTool(envZh.ctx, envZh.view).execute({ provider: 'zai' }, envZh.exec);
  assert.match(deniedZh.basis, /不支持独立预设/);

  // 继承上下文后端：capabilities.agentPreset 在场但 inheritsParentContext
  // 同样不满足创建前置条件（宿主 assertProvider 同判据）。
  const envInherits = listEnv({ creationAgentPreset: 'custom-preset', backend: 'preset-inherits' });
  const inherited = await createListModelsTool(envInherits.ctx, envInherits.view).execute({ provider: 'zai' }, envInherits.exec);
  assert.equal(inherited.verdict, 'not-allowed');
  assert.match(inherited.basis, /does not support standalone presets/);

  // 后端支持独立预设：恢复允许（对照腿，条件判据不误伤）。
  const envOk = listEnv({ creationAgentPreset: 'custom-preset', backend: 'preset-ok' });
  const ok = await createListModelsTool(envOk.ctx, envOk.view).execute({ provider: 'zai' }, envOk.exec);
  assert.equal(ok.verdict, 'allowed', '后端满足预设条件时不受影响');

  // 创建行未配置默认预设（默认形态）：后端无预设能力也不再触发该条件
  //（既有各用例的 allowed 判定即此对照，这里显式钉一句）。
  const envNoRowPreset = listEnv({ backend: 'ok' });
  const plain = await createListModelsTool(envNoRowPreset.ctx, envNoRowPreset.view).execute({ provider: 'zai' }, envNoRowPreset.exec);
  assert.equal(plain.verdict, 'allowed');
});

hostTest('目标适用性——async_agent 后端段动态变化：同一工具实例两次查询间后端翻转，verdict 现读跟随（§2.3.4「动态变化」）', async () => {
  // R3-F02 判据的「动态变化」子项：判定输入是每次 execute 现读的注册表，
  // 不缓存到构造期——同一工具实例上后端从可续改为缺可续、再到缺席与抛错，
  // verdict 逐次跟随，无任何一次沿用上一读数。
  const env = listEnv({ backend: 'ok' });
  const tool = createListModelsTool(env.ctx, env.view);

  const ok = await tool.execute({ provider: 'zai' }, env.exec);
  assert.equal(ok.verdict, 'allowed', '可续后端在场 → 允许');

  env.setBackend('no-continuable');
  const flipped = await tool.execute({ provider: 'zai' }, env.exec);
  assert.equal(flipped.verdict, 'not-allowed', '同一实例改判不允许（读数不缓存）');
  assert.match(flipped.basis, /provides no continuable support/);
  assert.equal(flipped.example, undefined, '翻转后不生成适用示例');

  env.setBackend('missing');
  const missing = await tool.execute({ provider: 'zai' }, env.exec);
  assert.equal(missing.verdict, 'not-allowed');
  assert.match(missing.basis, /is not registered/);

  env.setBackend('throw');
  const threw = await tool.execute({ provider: 'zai' }, env.exec);
  assert.equal(threw.verdict, 'unconfirmed', '注册表读取抛错 → 未确认（不沿用上一允许读数）');

  env.setBackend('ok');
  const restored = await tool.execute({ provider: 'zai' }, env.exec);
  assert.equal(restored.verdict, 'allowed', '后端恢复 → 恢复允许');
});

hostTest('async_agent 身份段：登记簿对象同一性认领——外来同名／读口异常都不冒充本包（R5-F02，§2.3.4）', async () => {
  // 对照：本包创建行在册（默认 identity 'ours'）→ 三段齐备判允许。
  const envOurs = listEnv();
  const toolOurs = checkedTool(createListModelsTool(envOurs.ctx, envOurs.view));
  const ours = await toolOurs.execute({}, envOurs.exec);
  assert.equal(ours.verdict, 'allowed');
  assert.ok(envOurs.calls.toolsGet >= 1, '身份段经公开投影读口比对');

  // 同名外来登记（get 命中但对象不在工具行登记簿）：未确认——不读策略与
  // 后端、不生成示例，也不用本包默认配置冒充。
  const envForeign = listEnv({ identity: 'foreign' });
  const toolForeign = checkedTool(createListModelsTool(envForeign.ctx, envForeign.view));
  const foreign = await toolForeign.execute({}, envForeign.exec);
  assert.equal(foreign.verdict, 'unconfirmed');
  assert.match(foreign.basis, /not registered by this package/);
  assert.equal(envForeign.calls.current, 0, '身份未确认不得读策略段');
  assert.equal(envForeign.calls.getProvider, 0, '身份未确认不得读后端段');
  assert.equal(foreign.example, undefined, '身份未确认不生成创建示例');
  // 身份档进版本令牌：外来与本包的判定实质不同，同查询令牌必须不同。
  assert.notEqual(foreign.version, ours.version, '身份段判定实质参与版本令牌');

  // get 读口异常三形态：服务无 get／get 抛错／候选在册而 get 查无（两读口矛盾）。
  for (const [form, pattern] of [
    ['no-get', /exposes no get\(name, scope\)/],
    ['throws', /could not be read.*identity exploded/],
    ['none', /visible in schemas but tools\.get returned none/]
  ]) {
    const envX = listEnv({ identity: form });
    const toolX = checkedTool(createListModelsTool(envX.ctx, envX.view));
    const result = await toolX.execute({}, envX.exec);
    assert.equal(result.verdict, 'unconfirmed', `identity=${form} → 未确认`);
    assert.match(result.basis, pattern, `identity=${form} 的依据文案`);
    assert.equal(envX.calls.getProvider, 0, `identity=${form} 不得读后端段`);
  }
});

hostTest('async_agent 后端段读创建行配置：查询与创建两行分离时按创建行判定（R5-F02，§2.3.4）', async () => {
  // 创建行 subagentProvider 指向未注册后端 → 不允许——查询行自己的默认
  // （spawn，可用）不得冒充创建行的判定输入。
  const envSplit = listEnv({ creationProvider: 'no-such-backend' });
  const toolSplit = checkedTool(createListModelsTool(envSplit.ctx, envSplit.view));
  const split = await toolSplit.execute({}, envSplit.exec);
  assert.equal(split.verdict, 'not-allowed', '创建行后端未注册 → 不允许（不按查询行默认放行）');
  assert.match(split.basis, /"no-such-backend" is not registered/);
  assert.equal(split.example, undefined);

  // 对照：创建行后端为 spawn（默认）→ 允许。
  const envOk = listEnv({ creationProvider: 'spawn' });
  const toolOk = checkedTool(createListModelsTool(envOk.ctx, envOk.view));
  const ok = await toolOk.execute({}, envOk.exec);
  assert.equal(ok.verdict, 'allowed');
  assert.notEqual(ok.version, split.version, '创建行后端差异进入判定实质 → 令牌不同');
});

hostTest('目标适用性——原生工具三段证据链：参数／身份／策略，与 async_agent 现读口径互不改写（§2.3.4）', async () => {
  // ① 具名原生目标（出厂名）+ 路由参数在场 + 投影有记录 → 允许（投影条数依据）。
  const envA = listEnv({
    projection: [{ provider: 'zai', model: 'glm-5.3' }],
    schemas: { native: true }
  });
  const toolA = createListModelsTool(envA.ctx, envA.view);
  const a = await toolA.execute({ target_tool: 'subagent' }, envA.exec);
  assert.equal(a.target, 'subagent');
  assert.equal(a.verdict, 'allowed');
  assert.match(a.basis, /session model-selection projection: 1 route\(s\) recorded/);

  // ② 双向差异：全局开关关掉（async_agent 判不允许）而会话投影仍有记录
  //    （原生旧会话策略不被新名单改写）——两条口径同页如实呈现。
  envA.setSelection({ enabled: false, allowedModels: ROUTES });
  const both = await toolA.execute({ target_tool: 'subagent' }, envA.exec);
  assert.equal(both.verdict, 'allowed', '原生口径只看会话投影，不受全局开关影响');
  const ours = await toolA.execute({ target_tool: 'async_agent' }, envA.exec);
  assert.equal(ours.verdict, 'not-allowed', 'async_agent 口径只看现读设置');

  // ③ 投影无记录：不允许（组合时多半未启用模型选择设置）。
  const envB = listEnv({ projection: null, schemas: { native: true } });
  const b = await createListModelsTool(envB.ctx, envB.view).execute({ target_tool: 'subagent' }, envB.exec);
  assert.equal(b.verdict, 'not-allowed');
  assert.match(b.basis, /no model-selection policy recorded for this session/);

  // ④ 投影读取抛错：适用性未确认（不猜）。
  const envC = listEnv({ projection: 'throw', schemas: { native: true } });
  const c = await createListModelsTool(envC.ctx, envC.view).execute({ target_tool: 'subagent' }, envC.exec);
  assert.equal(c.verdict, 'unconfirmed');
  assert.match(c.basis, /could not be read: fold exploded/);

  // ⑤ 参数形状不含路由键：不允许（该会话不暴露路由选择）。
  const envD = listEnv({ projection: [{ provider: 'zai', model: 'glm-5.3' }], schemas: { native: true, nativeRouteParams: false } });
  const d = await createListModelsTool(envD.ctx, envD.view).execute({ target_tool: 'subagent' }, envD.exec);
  assert.equal(d.verdict, 'not-allowed');
  assert.match(d.basis, /does not expose route-selection parameters/);

  // ⑥ 身份段（双依据）：自定义名＋投影在场，但调用方作用域组稿没有该名的
  //    非空 `tool:<名>` 段（同名登记遮蔽／未装载／行配别名）——不冒充确认，
  //    未确认并给原因（R3-F05 反例：仅凭「同形＋投影」即认允许）。
  const envF = listEnv({
    projection: [{ provider: 'zai', model: 'glm-5.3' }],
    schemas: { native: true, nativeName: 'my_delegator' },
    systemPrompt: 'shadow'
  });
  const f = await createListModelsTool(envF.ctx, envF.view).execute(
    { provider: 'zai', target_tool: 'my_delegator' }, envF.exec
  );
  assert.equal(f.verdict, 'unconfirmed');
  assert.match(f.basis, /no non-empty "tool:<name>" section/);
  assert.equal(f.example, undefined, '身份不可证时不生成适用于该目标的创建调用');
  assert.equal(f.entries[0].selectable, undefined, '未确认不标可选项');

  // ⑥b 自定义名＋双依据齐备（组稿段命中该名）——原生行配置了 toolName 别名
  //    的形态同样可证身份（名称只作候选筛选，不作来源证明，也不作否证）。
  const envF2 = listEnv({
    projection: [{ provider: 'zai', model: 'glm-5.3' }],
    schemas: { native: true, nativeName: 'my_delegator' },
    systemPrompt: 'native'
  });
  const f2 = await createListModelsTool(envF2.ctx, envF2.view).execute(
    { target_tool: 'my_delegator' }, envF2.exec
  );
  assert.equal(f2.verdict, 'allowed', '别名形态按双证据可证');

  // ⑥c 身份依据②读取失败的两形态：systemPrompt 缺席／组稿抛错——未确认＋原因。
  const envF3 = listEnv({
    projection: [{ provider: 'zai', model: 'glm-5.3' }],
    schemas: { native: true },
    systemPrompt: 'absent'
  });
  const f3 = await createListModelsTool(envF3.ctx, envF3.view).execute({ target_tool: 'subagent' }, envF3.exec);
  assert.equal(f3.verdict, 'unconfirmed');
  assert.match(f3.basis, /systemPrompt service is unavailable/);
  const envF4 = listEnv({
    projection: [{ provider: 'zai', model: 'glm-5.3' }],
    schemas: { native: true },
    systemPrompt: 'throws'
  });
  const f4 = await createListModelsTool(envF4.ctx, envF4.view).execute({ target_tool: 'subagent' }, envF4.exec);
  assert.equal(f4.verdict, 'unconfirmed');
  assert.match(f4.basis, /could not be read to prove the target identity: assemble exploded/);

  // ⑦ 出厂名 subagent_fork 同样可证身份（基线两行）。
  const envFork = listEnv({
    projection: [{ provider: 'zai', model: 'glm-5.3' }],
    schemas: { native: true, nativeName: 'subagent_fork' }
  });
  const fork = await createListModelsTool(envFork.ctx, envFork.view).execute(
    { target_tool: 'subagent_fork' }, envFork.exec
  );
  assert.equal(fork.verdict, 'allowed', '出厂名 subagent_fork 的身份段可证');
});

hostTest('目标解析：省略时单候选采用、多候选不默认通用可用；具名不可见按不允许报告并照常返回目录（§2.3.4）', async () => {
  // ① 省略 + 单候选（async_agent）→ 采用。
  const envSingle = listEnv();
  const single = await createListModelsTool(envSingle.ctx, envSingle.view).execute({}, envSingle.exec);
  assert.equal(single.target, 'async_agent');

  // ② 省略 + 多候选（async_agent + 原生 subagent）→ 未确认并列出候选。
  const envMulti = listEnv({ schemas: { native: true } });
  const multi = await createListModelsTool(envMulti.ctx, envMulti.view).execute({}, envMulti.exec);
  assert.equal(multi.verdict, 'unconfirmed');
  assert.match(multi.basis, /several creation tools are visible \(async_agent, subagent\)/);

  // ③ 具名但不可见：不作为查询错误终止——按「不允许选择」报告限制并列出
  //    可见候选，目录照常返回，不生成适用于该目标的创建调用。
  const ghost = await createListModelsTool(envMulti.ctx, envMulti.view).execute({ target_tool: 'ghost-tool' }, envMulti.exec);
  assert.equal(ghost.verdict, 'not-allowed');
  assert.equal(ghost.target, 'ghost-tool');
  assert.match(ghost.basis, /"ghost-tool" is not a subagent-creation tool visible in this session/);
  assert.match(ghost.basis, /async_agent, subagent/);
  assert.equal(ghost.total, 2, '具名不可见不阻断目录查询');
  assert.equal(ghost.example, undefined);
});

hostTest('路由二元组身份：拼接串碰撞的 `(p/q,r)` 与 `(p,q/r)` 不得互相冒充（R6-F01，§2.3.4）', async () => {
  // 反例形态（验收探针复现）：允许 `(p/q,r)`；目录另有未允许的 `(p,q/r)`。
  // 拼接键 `${provider}/${model}` 会让两个二元组都变成 `p/q/r` ——查询把
  // 名单外的 `(p,q/r)` 标成可选并生成示例，而按准确二元组创建会被拒绝。
  const env = listEnv({
    catalog: {
      providers: [{ id: 'p', name: 'Plain P' }, { id: 'p/q', name: 'Nested PQ' }],
      models: {
        'p': [{ provider: 'p', id: 'q/r', name: 'Colliding Suffix' }],
        'p/q': [{ provider: 'p/q', id: 'r', name: 'Nested Real' }]
      }
    },
    selection: { enabled: true, allowedModels: [{ provider: 'p/q', model: 'r' }] }
  });
  const tool = createListModelsTool(env.ctx, env.view);

  // 供应商内浏览：`(p,q/r)` 是名单外二元组——不可选、无示例。
  const underP = await tool.execute({ provider: 'p' }, env.exec);
  assert.equal(underP.entries[0].selectable, false,
    '拼接串与允许键碰撞的条目不得误标可选（二元组逐字段比较）');
  assert.equal(underP.example, undefined, '名单外二元组不得生成创建示例');
  // 允许侧对照：`(p/q,r)` 照常可选＋示例。
  const underPQ = await tool.execute({ provider: 'p/q' }, env.exec);
  assert.equal(underPQ.entries[0].selectable, true);
  assert.equal(underPQ.example.model, 'r');

  // 详情模式同判：准确路由 `(p,q/r)` 判不允许、不生成示例；`(p/q,r)` 允许。
  const detailDenied = await tool.execute({ provider: 'p', model: 'q/r' }, env.exec);
  assert.equal(detailDenied.verdict, 'not-allowed');
  assert.match(detailDenied.basis, /p\/q\/r/);
  assert.equal(detailDenied.example, undefined);
  const detailAllowed = await tool.execute({ provider: 'p/q', model: 'r' }, env.exec);
  assert.equal(detailAllowed.verdict, 'allowed');
  assert.equal(detailAllowed.example.model, 'r');
});

hostTest('参数示例：目标允许且路由已获准才生成，取本页第一条可选条目（§2.3.4）', async () => {
  const env = listEnv();
  const tool = createListModelsTool(env.ctx, env.view);

  // async_agent 适用：供应商内浏览的示例＝本页第一条可选条目（glm-5.3 在
  // 名单、flash 不在）；列表模式未确认强度 → 不含 reasoning_effort。
  const list = await tool.execute({ provider: 'zai' }, env.exec);
  assert.deepEqual(Object.keys(list.example).sort(), ['description', 'model', 'prompt', 'provider']);
  assert.equal(list.example.model, 'glm-5.3');
  // 条目级可选项：名单内可选、名单外不可选（目录可见不冒充获准）。
  const byId = Object.fromEntries(list.entries.map((e) => [e.id, e]));
  assert.equal(byId['glm-5.3'].selectable, true);
  assert.equal(byId['glm-5.3-flash'].selectable, false);
  assert.match(tool.output.render({}, list)[0].text, /glm-5\.3-flash — GLM 5\.3 Flash \(not in the allow list\)/);
  assert.match(tool.output.render({}, list)[0].text, /Example arguments for async_agent: /);

  // 本页首条在名单外：示例改取本页第一条**可选**条目。
  env.setSelection({ enabled: true, allowedModels: [{ provider: 'zai', model: 'glm-5.3-flash' }] });
  const firstDenied = await tool.execute({ provider: 'zai' }, env.exec);
  assert.equal(firstDenied.entries[0].selectable, false);
  assert.equal(firstDenied.example.model, 'glm-5.3-flash', '示例路由必须已获准');

  // 本页没有任何可选条目：不生成示例。
  env.setSelection({ enabled: true, allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] });
  const noneSelectable = await tool.execute({ provider: 'zai' }, env.exec);
  assert.equal(noneSelectable.example, undefined, '本页无可选条目则不生成示例');

  // 详情模式且路由已获准：示例的强度值按**目标可见参数形状**判定——async_agent
  // 参数表没有 reasoning_effort 键时即使模型广告强度也不带该键（形状判据对
  // async_agent 与原生目标同一）；补上该键后才有。
  env.setSelection({ enabled: true, allowedModels: ROUTES });
  const detail = await tool.execute({ provider: 'zai', model: 'glm-5.3' }, env.exec);
  assert.equal(detail.example.reasoning_effort, undefined,
    'async_agent 参数表无 reasoning_effort 时示例不得带该键（按形状判定，非按目标名称）');
  const envEffort = listEnv({ schemas: { agentEffortParam: true } });
  const toolEffort = createListModelsTool(envEffort.ctx, envEffort.view);
  const detailEffort = await toolEffort.execute({ provider: 'zai', model: 'glm-5.3' }, envEffort.exec);
  assert.match(detailEffort.example.reasoning_effort, /one of: low, high/);

  // 目标不允许（开关关）：无示例。
  env.setSelection({ enabled: false, allowedModels: ROUTES });
  const off = await tool.execute({ provider: 'zai' }, env.exec);
  assert.equal(off.example, undefined);

  // 原生目标：reasoning_effort 按**参数形状**直查（§2.3.4「示例仅含目标实际
  // 接受的字段」）——投影在场判 allowed、模型广告强度，但目标参数表
  // 没有 reasoning_effort 键 → 示例不得带该键；补上该键后才有。
  const envNat = listEnv({
    projection: [{ provider: 'zai', model: 'glm-5.3' }],
    schemas: { native: true }
  });
  const toolNat = createListModelsTool(envNat.ctx, envNat.view);
  const natNoEffort = await toolNat.execute(
    { provider: 'zai', model: 'glm-5.3', target_tool: 'subagent' }, envNat.exec
  );
  assert.equal(natNoEffort.example.reasoning_effort, undefined,
    '目标参数表无 reasoning_effort 时示例不得带该键（形状直查，非路由推断）');
  const envNatE = listEnv({
    projection: [{ provider: 'zai', model: 'glm-5.3' }],
    schemas: { native: true, nativeEffortParam: true }
  });
  const toolNatE = createListModelsTool(envNatE.ctx, envNatE.view);
  const natEffort = await toolNatE.execute(
    { provider: 'zai', model: 'glm-5.3', target_tool: 'subagent' }, envNatE.exec
  );
  assert.match(natEffort.example.reasoning_effort, /one of: low, high/);
});

hostTest('未列允许路由并入：模型列表、搜索、允许计数与允许名单专属供应商（§2.3.4）', async () => {
  const env = listEnv({
    selection: {
      enabled: true,
      allowedModels: [
        ...ROUTES,
        { provider: 'zai', model: 'hidden' },
        { provider: 'solo', model: 'x1' },
        { provider: 'solo', model: 'x2' }
      ]
    }
  });
  const tool = checkedTool(createListModelsTool(env.ctx, env.view));

  // 供应商内模型列表：目录条目＋名单派生条目（按准确 ID 排序并入），名称不编造。
  const zai = await tool.execute({ provider: 'zai' }, env.exec);
  assert.deepEqual(zai.entries.map((e) => e.id), ['glm-5.3', 'glm-5.3-flash', 'hidden']);
  const hidden = zai.entries[2];
  assert.equal(hidden.source, 'allowed-list');
  assert.equal(hidden.selectable, true);
  assert.equal('name' in hidden, false, '无目录数据时只写准确 ID，不编造名称');
  assert.equal(zai.example.model, 'glm-5.3', '示例仍取本页第一条可选条目');
  assert.match(tool.output.render({}, zai)[0].text, /zai\/hidden \(allow-list route\)/);

  // 供应商浏览：允许计数含未列路由；只出现在允许名单的供应商同样成条目。
  const providers = await tool.execute({}, env.exec);
  const byId = Object.fromEntries(providers.entries.map((e) => [e.id, e]));
  assert.equal(byId.zai.count_kind, 'allowed');
  assert.equal(byId.zai.model_count, 2, 'zai 允许计数＝名单路由总数（glm-5.3＋hidden，含未列）');
  assert.equal(byId.solo.count_kind, 'allowed');
  assert.equal(byId.solo.model_count, 2);
  assert.equal(byId.solo.source, 'allowed-list');
  assert.equal('name' in byId.solo, false, '允许名单专属供应商不编造名称');
  assert.equal(providers.total, 3);
  assert.match(tool.output.render({}, providers)[0].text, /solo \(allow-list route\) \(2 allowed model/);

  // 跨供应商搜索：名单派生条目按模型 ID 命中（无显示名称参与匹配）。
  const byHidden = await tool.execute({ query: 'hidden' }, env.exec);
  assert.deepEqual(byHidden.entries.map((e) => `${e.provider}/${e.id}`), ['zai/hidden']);
  // 供应商命中（id 包含）：允许名单专属供应商整组随行。
  const bySolo = await tool.execute({ query: 'solo' }, env.exec);
  assert.deepEqual(bySolo.entries.map((e) => (e.kind === 'provider' ? `provider:${e.id}` : `model:${e.provider}/${e.id}`)),
    ['provider:solo', 'model:solo/x1', 'model:solo/x2']);

  // 供应商内搜索同样命中名单派生条目。
  const inProvider = await tool.execute({ provider: 'zai', query: 'hidden' }, env.exec);
  assert.deepEqual(inProvider.entries.map((e) => e.id), ['hidden']);

  // 不在目录、只在允许名单的供应商：模型浏览按名单条目列出并如实说明目录缺席。
  const soloModels = await tool.execute({ provider: 'solo' }, env.exec);
  assert.deepEqual(soloModels.entries.map((e) => e.id), ['x1', 'x2']);
  assert.equal(soloModels.unlisted_provider, 'solo');
  assert.equal(env.calls.listModels.includes('solo'), false, '允许名单专属供应商不触发 listModels');
  assert.match(tool.output.render({}, soloModels)[0].text,
    /"solo" is not in the current catalog; the entries below come from the confirmed allow list/);
  assert.equal(soloModels.example.model, 'x1', '并入条目可选，示例可用');

  // 未列供应商的供应商内搜索：并入候选集后按同一 `query` 规则匹配（R3-F01
  // 反例——派生条目整组豁免搜索词即为缺陷形态）。命中保留、无匹配给
  // 空结果页并说明「路由均在、无匹配」，不误写成「没有已列模型」。
  const soloHit = await tool.execute({ provider: 'solo', query: 'x1' }, env.exec);
  assert.deepEqual(soloHit.entries.map((e) => e.id), ['x1']);
  assert.equal(soloHit.total, 1);
  assert.equal(soloHit.unlisted_provider, 'solo');
  const soloMiss = await tool.execute({ provider: 'solo', query: 'zzz' }, env.exec);
  assert.deepEqual(soloMiss.entries, []);
  assert.equal(soloMiss.total, 0, '无匹配＝确证的空结果，不是读取失败');
  assert.equal(soloMiss.unlisted_provider, 'solo');
  assert.equal(soloMiss.unlisted_had_routes, true, '空态标注路由在场');
  assert.equal(soloMiss.example, undefined, '本页无可选条目不生成示例');
  assert.match(tool.output.render({}, soloMiss)[0].text,
    /"solo" is not in the current catalog; its allow-list routes are present but none match "zzz"/);
});

hostTest('续查参数：next 携带在场的全部筛选条件，直接执行可翻完全部页；页脚与结构化字段同源（§2.3.4）', async () => {
  const env = listEnv();
  const tool = checkedTool(createListModelsTool(env.ctx, env.view));

  // 跨供应商搜索＋显式目标＋每页 1 条：next 必须逐项携带在场的筛选。
  const page1 = await tool.execute({ query: 'glm-5.3', target_tool: 'async_agent', page_size: 1 }, env.exec);
  assert.equal(page1.has_next, true);
  assert.deepEqual(page1.next, {
    query: 'glm-5.3', target_tool: 'async_agent', page_size: 1, version: page1.version, page: 2
  });
  // 页脚提示与结构化字段同源：正文里的续查参数就是 next 对象本身。
  const text1 = tool.output.render({}, page1)[0].text;
  assert.ok(text1.includes(`next page: continue with ${JSON.stringify(page1.next)}`),
    '页脚续查提示与 next 对象同源');

  // 稳定目录下按 next 逐页执行翻完全部页（不重不漏）。
  const seen = [];
  let current = page1;
  let guard = 0;
  for (;;) {
    seen.push(...current.entries.map((e) => `${e.provider}/${e.id}`));
    if (current.has_next !== true) break;
    current = await tool.execute(current.next, env.exec);
    guard += 1;
    assert.ok(guard < 20, '翻页必须终止');
  }
  assert.deepEqual(seen,
    ['deepseek-official/glm-5.3', 'zai/glm-5.3', 'zai/glm-5.3-flash'],
    '按 next 逐页翻完全部页');

  // 供应商内浏览的 next 携带 provider（query/target_tool 不在场则不带）。
  const inProvider = await tool.execute({ provider: 'zai', page_size: 1 }, env.exec);
  assert.deepEqual(inProvider.next, { provider: 'zai', page_size: 1, version: inProvider.version, page: 2 });
  const page2 = await tool.execute(inProvider.next, env.exec);
  assert.deepEqual(page2.entries.map((e) => e.id), ['glm-5.3-flash']);
  assert.equal(page2.has_next, false, '2 条记录翻 2 页即止');
});

hostTest('空态区分：读取失败不写成空目录——供应商浏览、模型浏览、跨供应商搜索与供应商内搜索分别覆盖（§2.3.4）', async () => {
  // ① 供应商内浏览：listModels 抛错 → 读取失败口径（完整性标记与失败清单在册）。
  const envBrowse = listEnv({ selection: 'absent' });
  envBrowse.failingProviders.add('zai');
  const toolBrowse = checkedTool(createListModelsTool(envBrowse.ctx, envBrowse.view));
  const browse = await toolBrowse.execute({ provider: 'zai' }, envBrowse.exec);
  assert.equal(browse.complete, false);
  assert.deepEqual(browse.failed_providers, ['zai']);
  assert.deepEqual(browse.entries, []);
  const browseText = toolBrowse.output.render({}, browse)[0].text;
  assert.match(browseText, /listing failed for: zai/);
  assert.match(browseText, /read failure, not an empty catalog/);
  assert.doesNotMatch(browseText, /no advertised models/, '读取失败不得写成空目录断言');

  // ② 供应商内搜索：同样按读取失败口径（不写「无匹配」）。
  const envSearch = listEnv({ selection: 'absent' });
  envSearch.failingProviders.add('zai');
  const toolSearch = checkedTool(createListModelsTool(envSearch.ctx, envSearch.view));
  const inProvider = await toolSearch.execute({ provider: 'zai', query: 'glm' }, envSearch.exec);
  assert.equal(inProvider.complete, false);
  const inProviderText = toolSearch.output.render({}, inProvider)[0].text;
  assert.match(inProviderText, /listing failed for: zai/);
  assert.doesNotMatch(inProviderText, /no matches/, '读取失败不是确证无匹配');

  // ③ 跨供应商搜索：命中集全部落在失败供应商 → 读取失败口径。
  const envCross = listEnv({ selection: 'absent' });
  envCross.failingProviders.add('zai');
  const toolCross = checkedTool(createListModelsTool(envCross.ctx, envCross.view));
  const cross = await toolCross.execute({ query: 'GLM 5.3' }, envCross.exec);
  assert.deepEqual(cross.entries, []);
  assert.equal(cross.complete, false);
  const crossText = toolCross.output.render({}, cross)[0].text;
  assert.match(crossText, /listing failed for: zai/);
  assert.doesNotMatch(crossText, /no matches/);

  // ④ 供应商浏览：失败供应商保留条目（unknown 计数＋不完整标注），不是空态。
  const envProviders = listEnv({ selection: 'absent' });
  envProviders.failingProviders.add('zai');
  const toolProviders = checkedTool(createListModelsTool(envProviders.ctx, envProviders.view));
  const providers = await toolProviders.execute({}, envProviders.exec);
  const byId = Object.fromEntries(providers.entries.map((e) => [e.id, e]));
  assert.equal(byId.zai.count_kind, 'unknown');
  assert.equal(byId.zai.model_count, null);
  assert.equal(providers.complete, false);
  const providersText = toolProviders.output.render({}, providers)[0].text;
  assert.match(providersText, /model count unavailable \(listing failed\)/);
  assert.match(providersText, /incomplete: 1 provider listing\(s\) failed/);

  // ⑤ 名单派生条目不因列举失败丢失：已确认路由仍列出，完整性照标。
  const envMerged = listEnv();
  envMerged.failingProviders.add('zai');
  const toolMerged = checkedTool(createListModelsTool(envMerged.ctx, envMerged.view));
  const merged = await toolMerged.execute({ provider: 'zai' }, envMerged.exec);
  assert.deepEqual(merged.entries.map((e) => e.id), ['glm-5.3']);
  assert.equal(merged.entries[0].source, 'allowed-list');
  assert.equal(merged.complete, false);
  assert.equal(merged.example.model, 'glm-5.3', '并入条目可选，示例可用');
});

hostTest('两语言：zh 档的判定依据、条目标记与空态文案同步（§2.3.4）', async () => {
  const env = listEnv({ agentLang: 'zh' });
  const tool = checkedTool(createListModelsTool(env.ctx, env.view));

  // 名单外路由详情：zh 判定与渲染。
  const denied = await tool.execute({ provider: 'zai', model: 'glm-5.3-flash' }, env.exec);
  assert.equal(denied.verdict, 'not-allowed');
  assert.match(denied.basis, /不在该目标已确认的允许集合内/);
  assert.match(tool.output.render({}, denied)[0].text, /目标 async_agent：不允许选择/);

  // 列表条目标记与目标依据（zh）。
  const list = await tool.execute({ provider: 'zai' }, env.exec);
  assert.match(list.basis, /当前 dsh 模型选择设置：已开启，允许 2 条路由/);
  assert.match(tool.output.render({}, list)[0].text, /glm-5\.3-flash——GLM 5\.3 Flash（不在允许名单）/);

  // 名单派生条目标记（zh）。
  env.setSelection({ enabled: true, allowedModels: [{ provider: 'zai', model: 'hidden' }] });
  const mergedList = await tool.execute({ provider: 'zai' }, env.exec);
  assert.match(tool.output.render({}, mergedList)[0].text, /zai\/hidden（来自允许名单）/);

  // 空态读取失败（zh）与后端段（zh）。
  const envFail = listEnv({ agentLang: 'zh', selection: 'absent' });
  envFail.failingProviders.add('zai');
  const toolFail = checkedTool(createListModelsTool(envFail.ctx, envFail.view));
  const failed = await toolFail.execute({ provider: 'zai' }, envFail.exec);
  assert.match(toolFail.output.render({}, failed)[0].text, /读取失败，不是空目录/);
  assert.match(toolFail.output.render({}, failed)[0].text, /列举失败：zai/);

  const envBackend = listEnv({ agentLang: 'zh', backend: 'missing' });
  const backend = await createListModelsTool(envBackend.ctx, envBackend.view).execute({}, envBackend.exec);
  assert.match(backend.basis, /未注册，显式路由选择在执行期会被拒绝/);
});

hostTest('llm 服务缺席：整次查询可读失败，不伪造空目录（§2.3.4／§1.3）', async () => {
  const env = listEnv({ llmMode: 'absent' });
  const tool = createListModelsTool(env.ctx, env.view);
  await assert.rejects(tool.execute({}, env.exec), /llm service is unavailable.*catalog cannot be read/s);
});

hostTest('只读纪律：注册表查询允许，创建入口零触碰（需求 §6.2）', async () => {
  const env = listEnv();
  const tool = createListModelsTool(env.ctx, env.view);
  const result = await tool.execute({}, env.exec);
  assert.equal(result.total, 2);
  // 后端段是适用性判定的公开注册表只读查询（设计 §3.7），允许；
  // startActivation 是创建入口，查询工具不得触碰（替身在调用时抛哨错）。
  assert.ok(env.calls.getProvider >= 1, 'async_agent 目标需读注册表确认后端现状');
  assert.equal(env.calls.startActivation, 0, '查询工具不得创建任何代理');
});

hostTest('parameters 契约：七键全可选、无必填（查询不是创建）（§2.3.4）', () => {
  const env = listEnv();
  const tool = createListModelsTool(env.ctx, env.view);
  assert.equal(tool.parameters.required, undefined, '查询工具无必填参数');
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(),
    ['model', 'page', 'page_size', 'provider', 'query', 'target_tool', 'version']);
});

// ── R3-F05 回归：原生身份双依据链（真实 Cordis／ToolRuntime） ────────────────

const cordisModule = await loadOfflineSafe('@deepseek-ai/cordis');
const systemPromptModule = await loadOfflineSafe('@deepseek-ai/dsh-system-prompt');
const toolsHostModule = await loadOfflineSafe('@deepseek-ai/dsh-tools');
const realCordisTest = await hostTestByProbe(
  [listModule, cordisModule, systemPromptModule, toolsHostModule].some((m) => m === undefined)
);

realCordisTest('原生目标身份：同名遮蔽（投影在场＋组稿段空）判未确认，真实原生段非空判允许（R3-F05，真实 Cordis）', async () => {
  const { Context } = cordisModule;
  const { SystemPrompt } = systemPromptModule;
  const { ToolRuntime, defineTool } = toolsHostModule;

  const buildCtx = async () => {
    const ctx = new Context();
    ctx.provide('llm', llm);
    ctx.provide('sessionProjections', { stateOf: () => [{ provider: 'p', model: 'm' }] });
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    return ctx;
  };
  const llm = {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [{ id: 'm', name: 'M' }],
    resolveModelInfo: async (provider, id) => ({ provider, id, name: id })
  };

  // ① R3-F05 反例（真实 ToolRuntime）：无关工具以出厂名 `subagent` 注册
  //    （形状同形）＋会话投影在场——仅按名称即认 allowed 即为缺陷形态；双
  //    依据下组稿没有 `tool:subagent` 段（非原生插件不渲染）→ 未确认、无示例。
  const shadowCtx = await buildCtx();
  shadowCtx.tools.register(defineTool({
    name: 'subagent',
    description: 'An unrelated custom test tool, not dsh-tool-subagent.',
    parameters: {
      description: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
      provider: { type: 'string' },
      model: { type: 'string' }
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: () => 'CUSTOM TOOL ONLY'
  }));
  try {
    const shadow = await createListModelsTool(shadowCtx, makeConfigView(() => resolveConfig({ agentLang: 'en' })))
      .execute({ provider: 'p', model: 'm', target_tool: 'subagent' }, { agent: { id: 'parent', session: { id: 'parent' } } });
    assert.equal(shadow.verdict, 'unconfirmed', '同名遮蔽＋投影在场仍不得判允许（R3-F05 反例翻转）');
    assert.equal(shadow.example, undefined, '身份不可证不生成适用示例');
    assert.match(shadow.basis, /no non-empty "tool:<name>" section/);
  } finally {
    await shadowCtx.fiber.dispose();
  }

  // ② 正向：真实原生形态的同构替身——同名工具在场＋`tool:subagent` 段按
  //    对象同一性渲染非空（经 SystemPrompt.section 注册，模拟原生插件的段
  //    渲染）＋投影在场，双依据齐备 → allowed（真原生目标三段链不回归）。
  const nativeCtx = await buildCtx();
  nativeCtx.tools.register(defineTool({
    name: 'subagent',
    description: 'Native-like subagent creation tool (test double).',
    parameters: {
      description: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
      provider: { type: 'string' },
      model: { type: 'string' }
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: () => 'NATIVE DOUBLE'
  }));
  nativeCtx.systemPrompt.section({ name: 'tool:subagent', text: 'native subagent creation tool', order: 500 });
  try {
    const native = await createListModelsTool(nativeCtx, makeConfigView(() => resolveConfig({ agentLang: 'en' })))
      .execute({ provider: 'p', model: 'm', target_tool: 'subagent' }, { agent: { id: 'parent', session: { id: 'parent' } } });
    assert.equal(native.verdict, 'allowed', '双依据齐备（投影在场＋组稿段非空）的原生目标判允许');
    assert.equal(native.example.model, 'm', '允许目标生成适用示例');
  } finally {
    await nativeCtx.fiber.dispose();
  }
});
