/**
 * 宿主接线冒烟测试（T3 + T6）。
 *
 * 为什么必须有这个文件：其余测试文件的 `ctx` 都是 `test/_helpers.mjs` 自己捏的替身，
 * **替身要什么有什么**，所以"`inject` 漏声明某个服务"这类缺陷在假件测试里永远绿。
 * 真实 cordis 上下文上，漏声明的服务访问会以 `cannot get property "<svc>"
 * without inject` 在插件树加载期暴露——例如 `timer` 只被 `async_wait` 消费
 * （`async_run` 的让出走宿主 `jobs.wait`、请求显式 `onExpiry: 'none'`，
 * 不经 `ctx.timer`），漏声明它时红的正是等待入口。
 *
 * 本文件做两件事，缺一不可：
 * 1. **静态扫描** `lib/` 下所有 `.js` 里的 `ctx.<服务>` 访问，断言它们是 `inject` 的子集
 *    —— 这条在漏声明时立刻变红，是 T6 的核心；
 * 2. 用**真 `@deepseek-ai/cordis`** 起最小 Context，注册假服务后挂载插件行，
 *    断言按 `config.toolName` 注册了工具、卸载后注销。
 *
 * 宿主包解析不到时（没有本地 `node_modules` 的离线环境）整个文件跳过——
 * 只吞「`@deepseek-ai/` 解析失败」这一种，语法错误、模块内部抛错、相对文件缺失
 * 一律让本文件红着，避免"跳过＝通过"的假绿。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HOST_SKIP_REASON, loadOfflineSafe } from './_host-gate.mjs';

/** `lib/` 目录的绝对路径。 */
const LIB_DIR = fileURLToPath(new URL('../lib/', import.meta.url));

/** cordis 的 `FiberState.ACTIVE`（`@deepseek-ai/cordis` 4.0.4，`lib/types/fiber.d.ts:67-74` 的 const enum，ACTIVE = 2）。 */
const ACTIVE = 2;

/** 加载宿主入口（守卫式动态 import，判据见 `_host-gate.mjs`）。 */
const loadHost = () => loadOfflineSafe('../lib/index.js');

/**
 * 动态加载真 cordis：静态 `import` 在离线环境会让**整个文件**加载失败，
 * 连 T6 的静态扫描都跑不成，所以这里退化成一个可判定的 `undefined`。
 * @returns {Promise<Function | undefined>} `Context` 构造函数。
 */
async function loadCordis() {
  try {
    const module = await import('@deepseek-ai/cordis');
    return module.Context;
  } catch (error) {
    const message = String(error?.message ?? error);
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && message.includes('@deepseek-ai/')) return undefined;
    throw error;
  }
}

/** 读出 `lib/` 下所有 `.js` 的源码（含子目录）。 */
function libSources() {
  const files = readdirSync(LIB_DIR, { recursive: true }).filter((entry) => String(entry).endsWith('.js'));
  return files.map((entry) => {
    const relative = String(entry).replaceAll('\\', '/');
    return { name: relative, text: readFileSync(new URL(relative, new URL('../lib/', import.meta.url)), 'utf8') };
  });
}

/**
 * 去掉注释与字符串字面量，只留代码。
 *
 * 必须去：错误文案里就写着 `ctx.sandboxPolicy`（`lib/jobs.js` 的 fail-fast 消息），
 * 不去掉的话静态扫描会把"文案里提到的一个服务名"当成真实访问，
 * 逼着人往 `inject` 里塞一个根本没用到的固定依赖。
 * @param {string} text - 源码。
 * @returns {string} 只剩代码的等价文本（长度与位置不保证一致，只用于匹配）。
 */
function stripNonCode(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    const next = text[index + 1];
    if (ch === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      const quote = ch;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue; }
        if (text[index] === quote) { index += 1; break; }
        index += 1;
      }
      out += ' ';
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/**
 * 从源码里抓出所有 `ctx.<标识符>` 访问。
 *
 * **先摘掉 `ctx.inject([...], (cb) => {…})` 的回调体**：回调里的 `ctx.settings` 是
 * 可选等待拿到的服务（等价于 `ctx.get`），不是"必须写进 inject"的强制访问。
 * 不摘的话，凡是用 `ctx.inject` 等可选服务的地方都会被误报成漏声明——
 * 而那个写法恰恰是既有插件的成例（`dsh-pwsh-local/lib/index.js:229`）。
 *
 * @param {string} text - 源码。
 * @returns {Set<string>} 标识符集合。
 */
function ctxMembers(text) {
  const found = new Set();
  const code = stripNonCode(text);
  // 把 inject 回调体的**参数名**收集起来，逐段剔除形如 `<param>.<name>` 的访问。
  const callbackParams = new Set();
  for (const match of code.matchAll(/\bctx\.inject\(\s*\[[^\]]*\]\s*,\s*\(?\s*([A-Za-z_$][\w$]*)/g)) {
    callbackParams.add(match[1]);
  }
  let scannable = code;
  for (const param of callbackParams) {
    scannable = scannable.replaceAll(`${param}.`, '\u0000.');
  }
  for (const match of scannable.matchAll(/\bctx\.([A-Za-z][A-Za-z0-9_]*)/g)) found.add(match[1]);
  for (const match of scannable.matchAll(/\u0000\.([A-Za-z][A-Za-z0-9_]*)/g)) found.add(`inject:${match[1]}`);
  // 上面刻意把 inject 回调里的访问记成 `inject:<name>`：它们**不该**被要求进静态 inject，
  // 但也不该被无声丢掉（否则改名这类错误就没人看得见）。
  for (const name of [...found]) {
    if (name.startsWith('inject:')) found.delete(name);
  }
  return found;
}

/**
 * 只去掉注释，**保留字符串字面量**。
 *
 * 与 `stripNonCode()` 的分工：那个把字符串也抹掉，适合扫 `ctx.<name>`（免得错误文案
 * 里的 `ctx.sandboxPolicy` 被当成真实访问）；但扫 `ctx.get('<name>')` 必须看见字面量本身，
 * 所以要另一把刀。
 *
 * 实现取向：扫描器宁可**漏报也不猜**——正则字面量里的 `//` 会让状态机提前进入注释态，
 * 那只会让它少看见几个名字，不会让它编出一个不存在的名字。反向的错（把注释里的
 * 名字当成真实访问）才是会逼人往 `inject` 里塞垃圾的那种错。
 * @param {string} text - 源码。
 * @returns {string} 去注释后的文本。
 */
function stripComments(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    const next = text[index + 1];
    if (ch === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      const quote = ch;
      out += ch;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') { out += text.slice(index, index + 2); index += 2; continue; }
        out += text[index];
        if (text[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/**
 * 从源码里抓出 `ctx.get('<字面量>')` 这种**第二种服务访问写法**。
 *
 * 为什么必须单独抓：只扫 `ctx.<name>` 会漏掉 `ctx.get('x')`。
 * 本包已经同时用了两种写法——`lib/jobs.js` 用 `ctx.get('sandboxPolicy')`（可选服务、
 * 允许缺席），其余服务用 `ctx.<name>`（固定依赖、写进 `inject`）。实测：往
 * `lib/jobs.js` 注入 `ctx.get('someHelper')` 后，只扫 `ctx.<name>` 的版本**给出
 * `missing=[]`**——"新增一个漏声明的服务访问"这条路径是敞开的。
 *
 * 只认**字符串字面量**参数：`ctx.get(variable)` 无法静态判定，不猜（扫描器对不确定的
 * 东西保持沉默，比猜错后逼人往 `inject` 里塞垃圾好）。
 *
 * @param {string} text - 源码。
 * @returns {Set<string>} 字面量服务名集合。
 */
function ctxGetLiterals(text) {
  const found = new Set();
  const code = stripComments(text);
  for (const match of code.matchAll(/\bctx\.get\(\s*(['"])([A-Za-z][A-Za-z0-9_]*)\1\s*\)/g)) found.add(match[2]);
  return found;
}

/**
 * `ctx.get()` 的合法目标白名单：**故意**用可选读取而不是固定依赖的服务。
 *
 * - `sandboxPolicy`：只在执行器声明了约束时才存在；取不到要 fail-fast 而不是让插件卡在等待态，
 *   所以它**不能**进 `inject`。
 *
 * - `approval`：`async_run` 单次提权时**问审批**的入口（`ctx.get('approval')`，
 *   见 `lib/jobs.js` 的 `approveRunEscalation`）。它与内置 `pwsh` / `bash` / `fs`
 *   完全同口径地**可选**：`dsh-tool-pwsh` 的 `inject` 也不含它。
 *   写进 `inject` 会让"没装审批服务的部署"整行不激活，把提权这个附加功能
 *   升级成插件不可用；而缺席的正确行为是**这一次提权请求以可读错误被拒**——
 *   `approveEscalation` 自己会抛 `requires approval, but no approval service is composed`，
 *   其余功能完全不受影响。
 *
 * - `workflowEngine`：`async_workflow` 工具的编排引擎（设计 §3.5 编排作业）。它是
 *   **delegation 组内隔离服务**：本包的组外行 `ctx.get` 恒 miss——把它写进
 *   `inject` 会让宿主行与创造预设行整行不激活。现读（execute 内 `ctx.get`）的
 *   正确行为是：引擎在位（dsh-async 两预设的 delegation 组）→ 编排可用；缺席
 *   （宿主行/无引擎部署）→ `error.workflowEngineMissing` 可读拒绝，工具仍注册。
 *
 * - `subagentModelSelection`：会话模型选择策略的 Host 单例设置服务
 *   （`@deepseek-ai/dsh-tool-subagent/model-selection-settings`，设计 §3.3）。
 *   实时口径（需求 §2.3.2）：`async_agent` 每次执行经 `current()` 现读
 *   `{enabled, allowedModels}`（启动前重读防撤回），`async_list_subagent_models`
 *   的目标适用性判断同读。缺席或读取失败只影响这两条路径（可读拒绝／未确认），
 *   工具照常注册——写进 `inject` 会让未挂 model-selection-settings 的部署
 *   整行不激活（六个工具陪葬）。
 *
 * - `llm`：LLM 目录与调用配置服务（预检 `resolveCallConfig`；查询工具的
 *   `listProviders`／`listModels`／`resolveModelInfo`，需求 §2.3.1/§2.3.4）。
 *   与上面的策略服务同理可选：缺席时显式路由请求以可读错误拒绝、查询工具
 *   以可读错误失败，纯继承委托与其余四个工具完全不受影响——写进 inject
 *   会把「没接 LLM 目录的组合」升级成整行不激活。
 *
 * - `sessions`：Session 注册表（ask-takeover 的预设归属判定惰性现读）。
 *   缺席只影响归属判定（按非本包预设处理），工具行为其余部分照常——
 *   写进 inject 同样会把缺席升级成整行不激活。
 *
 * （`settings` 与 `agentPresets` 不在此列：`lib/` 已无调用点。）
 *
 * 除这些以外的任何名字都说明作者要么该写进 `inject`、要么该解释为什么可选——两种情况都要求人来看一眼。
 */
const OPTIONAL_SERVICE_READS = new Set(['approval', 'sandboxPolicy', 'workflowEngine', 'subagentModelSelection', 'llm', 'sessions', 'systemPrompt']);

/** cordis 自带的上下文成员：不是服务，不需要（也不能）写进 `inject`。 */
const BUILTIN_CTX_MEMBERS = new Set(['effect', 'on', 'emit', 'get', 'logger', 'inject']);

/**
 * 构造最小 cordis 上下文：注册假服务，并记录工具注册。
 * @param {Function} Context - 真 cordis 的 `Context`。
 * @returns {object} 上下文与探针。
 */
function makeContext(Context) {
  const registered = [];
  const restrictCalls = [];
  const restrictDisposed = [];
  const ctx = new Context();
  ctx.provide('tools', {
    register(definition) {
      registered.push(definition);
      return () => {
        const index = registered.indexOf(definition);
        if (index >= 0) registered.splice(index, 1);
      };
    },
    // `restrict`（宿主 dsh-tools 的工具隐藏服务）记录器：断言 job_output 隐藏
    // 的调用参数与 disposer 接线（T19）——不是真隐藏，只验证本包的调用形态。
    restrict(policy) {
      restrictCalls.push(policy);
      return () => { restrictDisposed.push(policy); };
    }
  });
  ctx.provide('jobs', {
    start: () => 'async-command-1',
    get: () => ({ status: 'running' }),
    read: () => ({ text: '' }),
    wait: async () => ({ status: 'running' }),
    kill: () => 'requested'
  });
  ctx.provide('shell', {
    resolve: (request) => request,
    start: () => { throw new Error('接线测试不该启动进程'); }
  });
  ctx.provide('shellEnv', { collect: () => Object.freeze({ DSH_HOME: 'x' }) });
  ctx.provide('subagents', { listChildren: async () => [], interrupt: () => {}, getProvider: () => undefined });
  ctx.provide('timer', { timeout: () => () => {}, interval: () => () => {} });
  // 模型选择的第七服务：挂载级假件只需"无记录"初值形态（list-models 的原生
  // 目标口径读取它；async_agent 行不再注册投影——实时口径，设计 §3.3）。
  // 投影 fold 行为由 test/agent-policy.test.mjs 专测。
  ctx.provide('sessionProjections', { stateOf: () => null });
  // 第八服务：公开 Agent 注册表（wait-agent 三态判定消费；挂载级假件
  // 只需"查无驻留"形态）。
  ctx.provide('agents', { get: () => undefined });
  // 第九服务：会话当前有效目录（async_run 启动前 ensure；挂载级假件只需
  // 返回固定目录——目录解析行为由 test/jobs.test.mjs 专测）。
  ctx.provide('workingDirectory', { ensure: async () => 'D:\\work' });
  return { ctx, registered, restrictCalls, restrictDisposed };
}

/**
 * 等插件 fiber 进入 ACTIVE：cordis 的 `_reload()` 先 `await Promise.resolve()`
 * 才执行 `apply`（`@deepseek-ai/cordis` 4.0.4 `lib/index.js:1349-1358` 的
 * `_reload` 链），因此推有限的微任务轮次就够，
 * 不是靠时间蒙。超限直接断言失败，不会静默放过一个没跑起来的插件。
 * @param {object} fork - `ctx.plugin()` 的返回值。
 */
async function activate(fork) {
  for (let turn = 0; turn < 64 && fork.state !== ACTIVE; turn++) await Promise.resolve();
  assert.equal(fork.state, ACTIVE, '插件 fiber 未在有限个微任务内激活（apply 没跑？）');
}

const Context = await loadCordis();

test('T6：lib/ 里访问的每个 ctx.<服务> 都必须在 inject 里声明', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip(HOST_SKIP_REASON);
    return;
  }

  const declared = new Set(host.inject);
  // 单包两角色：`lib/index.js` 是**唯一入口**（inject 声明九个固定依赖），宿主角色由
  // 同一入口按"行配置有无 `toolName`"分派到 `lib/host.js`——不再存在"宿主入口
  // 声明为空数组"的旧形态。所以这里核对的就是这一个入口的声明，
  // "宿主角色不许把 settings 写成固定依赖"由 test/two-planes.test.mjs 的 T4 守。
  const entries = await Promise.all(['../lib/index.js', '../lib/host.js'].map(async (relative) => {
    try {
      return await import(relative);
    } catch {
      return undefined;
    }
  }));
  for (const entry of entries) {
    for (const name of entry?.inject ?? []) declared.add(name);
  }

  const needsInject = new Set();
  for (const source of libSources()) {
    for (const member of ctxMembers(source.text)) {
      if (!BUILTIN_CTX_MEMBERS.has(member)) needsInject.add(member);
    }
  }

  const missing = [...needsInject].filter((member) => !declared.has(member));
  assert.deepEqual(
    missing,
    [],
    `这些 ctx.<服务> 访问没写进 inject，真实 cordis 上下文会在加载期抛 `
    + `cannot get property "<name>" without inject —— 漏的是：${missing.join(', ')}`
  );
  // 反向：声明了却没人用，也该清掉（`inject` 是固定依赖，多一个就多一个等待条件）。
  const unused = [...declared].filter((member) => !needsInject.has(member));
  assert.deepEqual(unused, [], `inject 里声明了但 lib/ 从未使用：${unused.join(', ')}`);
});

test('T8：作废措辞"唯一途径"只许出现在标注其作废的上下文里', () => {
  // 需求 §2.1.3：`async_wait` 是本包规定的后台结果读取途径，但不能宣称它
  // 排除宿主的其他读取工具——"唯一途径"把规定途径夸大成排他断言。`lib/` 里若有
  // 注释把它当作**生效口径**引用，照注释改代码的人会把现行口径理解错。
  //
  // 判据：出现该措辞的那一行，**同段内**必须出现
  // "作废 / 勘误 / 旧措辞"之一——也就是"只允许引用作废历史"。
  const offenders = [];
  for (const source of libSources()) {
    source.text.split('\n').forEach((line, index) => {
      if (!line.includes('唯一途径')) return;
      if (/作废|勘误|旧措辞|旧表述/.test(line)) return;
      offenders.push(`${source.name}:${String(index + 1)}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    '这些行把已作废的"唯一途径"当成生效需求引用了：\n' + offenders.join('\n')
  );
});

test('T6b：`ctx.get("<字面量>")` 的第二种写法也要被看见（R3 审查点名的盲区）', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip(HOST_SKIP_REASON);
    return;
  }

  const declared = new Set(host.inject);
  const reads = new Set();
  for (const source of libSources()) {
    for (const name of ctxGetLiterals(source.text)) reads.add(name);
  }

  // 每个可选读取要么已声明（那就不该用 `ctx.get`）、要么在白名单里。
  const unexplained = [...reads].filter((name) => !declared.has(name) && !OPTIONAL_SERVICE_READS.has(name));
  assert.deepEqual(
    unexplained,
    [],
    `这些 ctx.get("<name>") 既不在 inject 里、也不在 OPTIONAL_SERVICE_READS 白名单里：`
    + `${unexplained.join(', ')}。要么改成硬依赖写进 inject，要么按设计说明它为什么必须可选。`
  );
  // 白名单本身不许腐烂：白名单里的名字必须真的还在被读，否则删掉它。
  const stale = [...OPTIONAL_SERVICE_READS].filter((name) => !reads.has(name));
  assert.deepEqual(stale, [], `OPTIONAL_SERVICE_READS 里的这些名字已不再被读取，请清掉：${stale.join(', ')}`);
});

test('T3：inject 恰为九项服务；apply 按 config.toolName 注册工具；卸载后注销', async (t) => {
  const host = await loadHost();
  if (host === undefined || Context === undefined) {
    t.skip(HOST_SKIP_REASON);
    return;
  }

  assert.deepEqual(
    host.inject,
    ['tools', 'jobs', 'shell', 'shellEnv', 'subagents', 'timer', 'sessionProjections', 'agents', 'workingDirectory'],
    'inject 是与宿主组合的唯一契约，多一个少一个都是加载期错误'
  );

  // 工具行分派判据——真 cordis 上下文里按名注册成功、卸载后注销。构造时不查
  // provider 注册表（描述里的名字取自配置），所以 makeContext 的假 subagents
  // 不需要 getProvider；查询行也不查 llm（按调用可选读取）。
  for (const toolName of ['async_run', 'async_wait', 'async_agent', 'async_list_subagent_models']) {
    const { ctx, registered } = makeContext(Context);
    const fork = ctx.plugin(
      { name: host.name, inject: host.inject, Config: host.Config, apply: host.apply },
      { toolName }
    );
    await activate(fork);

    assert.deepEqual(
      registered.map((definition) => definition.name),
      [toolName],
      `config.toolName=${toolName} 应当且只应当注册这一个工具`
    );
    assert.equal(typeof registered[0].execute, 'function');
    assert.equal(typeof registered[0].output?.render, 'function', '工具必须声明 output.render');

    await fork.dispose();
    assert.deepEqual(registered, [], 'ctx.effect 的 disposer 必须在 fiber 卸载时注销工具（R4 可逆性）');
  }
});

test('T19：job_output 隐藏——agent/created 挂 agent 作用域 restrict，查询行不挂；去重与回收（9.3.5）', async (t) => {
  const host = await loadHost();
  if (host === undefined || Context === undefined) {
    t.skip(HOST_SKIP_REASON);
    return;
  }
  // 四个交付类工具行（async_run/async_wait/async_agent/async_workflow）装载后监听
  // `agent/created`，在 **Agent 作用域**上调 agent.ctx.tools.restrict({deny:['job_output']})
  // ——真机首测暴露「行装载 ctx 上 restrict 必报 unknown global tool」（同层注册不进
  // 本层可限制名单，与行序无关），宿主语义要求挂在 Agent 继承面上（installJobOutputHide
  // 文档串）；查询行（async_list_subagent_models）不挂——9.3.5 末条「查询类工具不受影响」。
  const deliveryRows = ['async_run', 'async_wait', 'async_agent', 'async_workflow'];
  for (const toolName of [...deliveryRows, 'async_list_subagent_models']) {
    const { ctx } = makeContext(Context);
    const fork = ctx.plugin(
      { name: host.name, inject: host.inject, Config: host.Config, apply: host.apply },
      { toolName }
    );
    await activate(fork);
    // 假 Agent：agent.ctx.tools.restrict 与 agent.ctx.effect 都是 per-agent 记录器
    //（effect 记录器锚定句柄归属——挂行 ctx 则行卸载会连带摘在世 Agent 的隐藏，
    // 复审 L-1/N-B 的缺陷形态）。
    const agentRestrictCalls = [];
    const agentEffectDisposers = [];
    const fakeAgent = {
      id: `agent-${toolName}`,
      ctx: {
        tools: { restrict(policy) { agentRestrictCalls.push(policy); return () => {}; } },
        effect(fn) { agentEffectDisposers.push(fn); }
      }
    };
    ctx.emit('agent/created', { agent: fakeAgent });
    if (deliveryRows.includes(toolName)) {
      assert.deepEqual(
        agentRestrictCalls,
        [{ deny: ['job_output'] }],
        `${toolName} 行应在 agent/created 后对 agent.ctx 恰一次 restrict({deny:['job_output']})（装载期不再直接 restrict——真机 unknown-tool 失败形态即红）`
      );
      assert.equal(agentEffectDisposers.length, 1, '句柄必须挂 agent.ctx.effect（随 Agent 世代回收；挂行 ctx 则行单独卸载摘除在世 Agent 的隐藏——L-1）');
      // 同一 Agent 再次 created（多行监听/重复事件）：模块级去重，只挂一次。
      ctx.emit('agent/created', { agent: fakeAgent });
      assert.equal(agentRestrictCalls.length, 1, '同一 Agent 重复 created 不重复挂（WeakSet 去重）');
      // 故障形态：agent.ctx 缺席或 restrict 抛错——监听器不外抛（dsh-agent 对
      // created 监听器失败按 reject 处理，会阻断 Agent 创建）、降级 warn、不挡
      // 后续 Agent。
      const bare = { id: 'agent-bare' };
      ctx.emit('agent/created', { agent: bare });
      const throwing = { id: 'agent-throw', ctx: { tools: { restrict() { throw new Error('boom'); } } } };
      ctx.emit('agent/created', { agent: throwing });
      const afterFault = [];
      ctx.emit('agent/created', {
        agent: { id: 'agent-after-fault', ctx: { tools: { restrict(p) { afterFault.push(p); return () => {}; } } } }
      });
      assert.equal(afterFault.length, 1, '故障 Agent 不阻断后续 Agent 的隐藏登记（3.5.1 故障注入语义）');
    } else {
      assert.equal(agentRestrictCalls.length, 0, '查询行不挂隐藏（9.3.5：查询类工具不受影响）');
    }
    await fork.dispose();
    // 行卸载后监听器摘除：新 Agent 的 created 不再触发。
    const lateCalls = [];
    ctx.emit('agent/created', {
      agent: { id: 'agent-late', ctx: { tools: { restrict(p) { lateCalls.push(p); return () => {}; } } } }
    });
    assert.equal(lateCalls.length, 0, '行卸载后不再对新 Agent 挂隐藏（可逆性）');
  }
});

test('T3c：快照在场时行级委托键不丢——agent_preset 照常暴露（§2.3.1，P1 回归锁）', async (t) => {
  const host = await loadHost();
  const Context = await loadCordis();
  if (host === undefined || Context === undefined) {
    t.skip(HOST_SKIP_REASON);
    return;
  }
  const { attachSnapshotSource, readSnapshot, clearSnapshot } = await import('../lib/settings.js');
  clearSnapshot();

  // 宿主行在场的正常部署形态：先有快照（宿主行首播），再挂自定义 async_agent 行
  // （带行级委托键）。快照来自宿主行——合法地不含委托键；工具行取值入口必须
  // 从本行装载期值回填它们，否则 agent_preset 不暴露、委托配置整组失效。
  const hostCtx = { on: () => () => {}, logger: { warn: () => {} } };
  const wiring = attachSnapshotSource(hostCtx, { minWaitMs: 250, maxWaitMs: 600000, maxResultChars: 30000 });
  try {
    assert.notEqual(readSnapshot(), undefined, '前置：宿主行快照在场');
    const { ctx, registered } = makeContext(Context);
    const fork = ctx.plugin(
      { name: host.name, inject: host.inject, Config: host.Config, apply: host.apply },
      { toolName: 'async_agent', allowedAgentPresets: ['reviewer', 'writer'], agentPreset: 'writer' }
    );
    await activate(fork);

    // 可失败判据：快照分支若丢行级委托键，rowPresetChoices 为 undefined →
    // agent_preset 不进参数表（构造期 readCurrentPolicy 不涉——这由纯配置决定）。
    assert.ok('agent_preset' in registered[0].parameters.properties,
      '快照在场时配置了 allowedAgentPresets 的行仍必须暴露 agent_preset（行级委托键非 volatile，不跟随宿主行快照）');
    assert.match(registered[0].parameters.properties.agent_preset.description, /reviewer, writer/,
      '可选值列表取自行配置（不是快照、也不是默认值）');

    await fork.dispose();
    assert.deepEqual(registered, []);
  } finally {
    wiring.dispose();
    clearSnapshot();
  }
});

test('T12：设置快照链的三种故障姿态——首播降级、刷新保旧、卸载清空', async () => {
  // 调用链：宿主行 `attachSnapshotSource(ctx)` —— 首播快照 + 监听
  // `loader/volatile-update`。三种姿态各有判据：
  //
  // ① 首播失败 = **降级运行**（不再 fail-fast）：跨字段违例能被设置页保存路径持久化
  //    （dsh-settings 只做逐字段校验），行若抛错死掉，describe 只收激活行、设置卡片
  //    整个消失，用户失去应用内修复通道。判据：不抛 + 快照回退出厂默认 + warn 说明
  //    + degraded 置位；后续合法 volatile 提交必须能自愈（degraded 复位）。
  // ② 刷新失败 = 用户输入问题（跨字段违例）→ **保旧快照 + warn + stderr 说出来**
  //    （绝不打掉宿主行，也绝不静默——"保存成功但行为没变且零线索"是要避免的缺陷形态）；
  // ③ 宿主行卸载 → disposer 清空快照（需求 §7.2：插件效应完全跟随插件生命周期）。
  const { attachSnapshotSource, readSnapshot, clearSnapshot, readDegraded, clearDegraded } = await import('../lib/settings.js');
  clearSnapshot();
  clearDegraded();

  // ① 首播非法（持久化着 min > max）→ 降级而不是抛。
  //：stderr 通告行也必须有行为断言——只断言 warn 的话，删掉 notice 出口
  // 全量照样绿。在这里临时捕获 process.stderr（notice.js 的默认出口）。
  const stderrChunks = [];
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };
  const degradeEvents = [];
  // 监听器按事件名收（装配接线登记两类监听：volatile-update 与 internal/config，
  // 单变量会被后登记者顶掉）。驱动只回调 volatile-update（internal/config 是
  // loader 的 waterfall 事件，假件不经它）。
  const degradeListeners = new Map();
  const degradeCtx = {
    on: (name, cb) => { degradeListeners.set(name, cb); return () => { degradeListeners.delete(name); }; },
    logger: { warn: (message) => degradeEvents.push(message) }
  };
  const badLive = { minWaitMs: 999999, maxWaitMs: 250 };
  let degradedWiring;
  try {
    assert.doesNotThrow(() => { degradedWiring = attachSnapshotSource(degradeCtx, badLive); },
      '首播非法不许抛——行死了设置卡片就消失，用户没有应用内修复通道');
  } finally {
    process.stderr.write = realStderrWrite;
  }
  assert.equal(degradedWiring.seeded, true);
  assert.equal(degradedWiring.degraded, true, '降级状态必须可观察');
  assert.ok(/minWaitMs(=\d+)? > maxWaitMs(=\d+)?/.test(String(readDegraded())), '首播降级同样登记（模型可见侧；detail 带日志前缀原文；两态错误文本——裸名或带值——都必须命中）');
  assert.equal(readSnapshot().minWaitMs, 250, '降级快照 = 出厂默认（minWaitMs）');
  assert.equal(readSnapshot().maxResultChars, 30000, '降级快照 = 出厂默认（maxResultChars）');
  assert.ok(degradeEvents.some((message) => /宿主行配置自检失败/.test(String(message)) && /按出厂默认运行/.test(String(message))),
    '必须 warn 说明"忽略了什么、正在按什么运行"');
  assert.ok(stderrChunks.some((line) => line.includes('宿主行忽略持久化的非法设置') && /minWaitMs(=\d+)? > maxWaitMs(=\d+)?/.test(line)),
    'stderr 通告行必须真的写出去且带上违例明细（进程外唯一出口；两态错误文本都算命中）');

  // ①' 降级后的自愈：同一份活配置被改正（模拟用户在设置页把值改回合法再保存）。
  badLive.minWaitMs = 250;
  badLive.maxWaitMs = 600000;
  badLive.maxResultChars = 4321;
  degradeListeners.get('loader/volatile-update')();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(degradedWiring.degraded, false, '合法提交后降级状态必须复位');
  assert.equal(readDegraded(), undefined, '首播降级的登记随自愈清空');
  assert.equal(readSnapshot().maxResultChars, 4321, '自愈后快照来自重新物化（不是默认值）');
  degradedWiring.dispose();
  assert.equal(readSnapshot(), undefined);
  assert.equal(readDegraded(), undefined, '卸载清空降级登记（无跨装载残留）');
  assert.equal(degradeListeners.size, 0, '卸载撤销全部事件监听（volatile-update 与 internal/config）');

  // ② 正常首播 + 刷新失败保旧。liveConfig 就是 apply 第二参（= fiber.config）：
  //    每次重物化都从**这个对象**现读——cordis 没有 ctx.config 访问接口。
  const events = [];
  const logger = { warn: (message) => events.push(['warn', message]) };
  let liveConfig = { maxResultChars: 30000, minWaitMs: 250, maxWaitMs: 600000 };
  const listeners = new Map();
  const hostCtx = {
    on: (name, cb) => { listeners.set(name, cb); events.push(['subscribe', name]); return () => { listeners.delete(name); }; },
    logger
  };
  const wiring = attachSnapshotSource(hostCtx, liveConfig);
  assert.equal(wiring.seeded, true);
  assert.equal(readSnapshot().maxResultChars, 30000, '首播快照来自活配置对象的物化解析');

  // volatile 提交后 config 变坏 → 保旧快照 + warn（不打掉、不静默）。
  // 必须原地改字段：attachSnapshotSource 闭包捕获的是这个对象本身（真实调用链里
  // loader 也是对同一份 fiber.config 原地 `updateVolatile`，对象恒同一）。
  // 此时模块处于武装态（①' 的合法提交已再武装）：拒绝文案是 transform 回调的
  // `[async-tools] cross-field violation: minWaitMs=… > maxWaitMs=…`；初始态下则是
  // assertCrossFieldOrder 的 `minWaitMs > maxWaitMs`——两种错误文本都收。
  liveConfig.minWaitMs = 999999;
  liveConfig.maxWaitMs = 250;
  listeners.get('loader/volatile-update')();
  await Promise.resolve();
  assert.equal(readSnapshot().maxResultChars, 30000, '刷新失败必须保住旧快照');
  assert.ok(events.some(([kind, message]) => kind === 'warn' && /volatile 提交后配置自检失败/.test(String(message))),
    '必须 warn 说明是哪次提交没生效');
  assert.match(String(readDegraded()), /minWaitMs(=\d+)? > maxWaitMs(=\d+)?/,
    '刷新失败必须登记降级（模型可见侧随描述警示段出现；武装/容忍两态文案都认）');

  // 刷新成功路径：config 合法变更 → 快照整体替换。
  liveConfig.minWaitMs = 250;
  liveConfig.maxWaitMs = 600000;
  liveConfig.maxResultChars = 4321;
  listeners.get('loader/volatile-update')();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(readSnapshot().maxResultChars, 4321, '合法提交后快照必须更新');
  assert.equal(readDegraded(), undefined, '合法提交自愈——降级登记清空（警示段随刷新消失）');

  // ③ 卸载：disposer 清快照 + 撤监听（两类监听一并撤销）。
  wiring.dispose();
  assert.equal(readSnapshot(), undefined, '宿主行卸载必须清空快照（无跨装载残留）');
  assert.equal(listeners.size, 0, '事件监听必须一并撤销');
});

test('T12b：降级登记的模型可见侧——seedDegraded/readDegraded/clearDegraded + 描述警示段', async () => {
  // 需求 §5.1「运行中收到非法配置时保留上一合法值并告警」：stderr 告警只到
  // 操作者（设计 §6.3），模型侧的告警载体是**工具描述尾部的警示段**——构建时
  // 读 `readDegraded()`，有降级就拼段（en/zh 随 agentLang），自愈后消失
  // （行为差异而非"存在但空"）。
  const { seedDegraded, clearDegraded, readDegraded } = await import('../lib/settings.js');
  const { buildToolText } = await import('../lib/descriptions.js');
  const { resolveConfig } = await import('../lib/config.js');
  try {
    clearDegraded();
    const cleanConfig = resolveConfig({ toolName: 'async_run' });
    assert.equal(readDegraded(), undefined, '干净状态无降级');
    assert.ok(!buildToolText('async_run', cleanConfig).description.includes('Live config self-check failed'),
      '无降级时描述不得出现警示段');

    seedDegraded('minYieldMs > maxYieldMs');
    assert.equal(readDegraded(), 'minYieldMs > maxYieldMs', '登记原样可读');
    const enDesc = buildToolText('async_run', cleanConfig).description;
    assert.ok(enDesc.includes('Live config self-check failed') && enDesc.includes('minYieldMs > maxYieldMs'),
      '降级时 en 描述尾部必须带警示段与违例明细');
    // 回退来源两态并列（启动失败＝出厂默认值，运行中失败＝上一合法值）——
    // 缺任一半边即红，钉住警示段不回退为单一来源断言。
    assert.ok(enDesc.includes('factory defaults') && enDesc.includes('the last valid values'),
      'en 警示段两态来源并列：factory defaults ＋ the last valid values');
    for (const name of ['async_wait', 'async_agent', 'async_workflow', 'async_list_subagent_models']) {
      assert.ok(buildToolText(name, resolveConfig({ toolName: name })).description.includes('Live config self-check failed'),
        `${name} 的描述同样拼警示段（五个工具一律）`);
    }
    const zhConfig = resolveConfig({ toolName: 'async_run', agentLang: 'zh' });
    const zhDesc = buildToolText('async_run', zhConfig).description;
    assert.ok(zhDesc.includes('生效配置自检失败'),
      'zh 档警示段为中文');
    assert.ok(zhDesc.includes('出厂默认值') && zhDesc.includes('上一合法值'),
      'zh 警示段两态来源并列：出厂默认值 ＋ 上一合法值');

    clearDegraded();
    assert.ok(!buildToolText('async_run', cleanConfig).description.includes('Live config self-check failed'),
      '清空后警示段消失（自愈可见）');
  } finally {
    clearDegraded();
  }
});

test('T14：lib/ 的裸包 import 清单 ⊆ package.json 的 deps∪peers——漏声明即红', async () => {
  // 为什么需要：`@deepseek-ai/dsh-shell-env` 若被从 peerDependencies 删掉，
  // 依据句会写成"零服务消费"，而实际上 lib/jobs.js 一直在调 ctx.shellEnv.collect
  // （服务消费）。inject/服务访问是动态的，静态扫描管不到；但**直接 import** 是静态
  // 可判的——任何 lib/ 里 import 了却没进 deps∪peers 的包，代际核查就覆盖
  // 不到它。本断言守这一半；服务消费半边由 peer 依据表人工核（表内
  // 每行注明性质与行号）。
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {})
  ]);
  assert.ok(declared.has('@deepseek-ai/dsh-shell-env'),
    'T14 的回归锚：dsh-shell-env（ctx.shellEnv.collect 的提供包）必须在 peerDependencies');

  const imported = new Set();
  for (const name of readdirSync(LIB_DIR)) {
    if (!name.endsWith('.js')) continue;
    const source = readFileSync(`${LIB_DIR}${name}`, 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      // 只管裸包说明符：相对路径与 node: 内建不算。
      if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('/')) continue;
      const pkgName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      imported.add(pkgName);
    }
  }
  const undeclared = [...imported].filter((name) => !declared.has(name));
  assert.deepEqual(undeclared, [],
    `lib/ import 了未声明的包（R15 代际核查覆盖不到）：${undeclared.join(', ')}`);
});

test('T15（R38；R44 换钉）：九个 dsh* peer 共用同一支持集合——集合外宿主拒载；cordis/timer 随宿主树升窗；本包 version 随核心版本', async () => {
  // 为什么需要：peer 校验只看 @deepseek-ai/dsh 与 dsh-* 前缀，支持集合让
  // 「集合内任一宿主可装、集合外拒载」为本包工作。任一条漏改或写成不同集合，
  // 在集合外宿主上就是中间态（failed to import / skipping profile bundle）——
  // 本用例把「漏改」在仓库里就地打红，不用等真机。新增 rc 时先扩集合，本用例
  // 与支持集合一起红，强迫整表同步换代。version 断言：
  // 把「tag 已打而 version 漏改」拦在 tag 之前，不再只靠切换穿指读回退。
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  // 这里的期望串是**测试侧的需求固定副本**：按需求 §7.3 固定预期支持集合，用来发现
  // 包清单被悄悄改写（声明漂移）。测试期望作为需求副本，与包清单的 peer 原文并存是合理的；
  // 运行期判据（准入、junction、安装说明）一律从包清单取集合。集合变化时本用例变红，
  // 提示同步需求、版本与文档。
  const SUPPORT = '0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.1-rc.4 || 0.2.1-rc.5';
  const expected = {
    '@deepseek-ai/cordis': '~4.0.5',
    '@deepseek-ai/cordis-plugin-timer': '~1.1.7',
    '@deepseek-ai/dsh': SUPPORT,
    '@deepseek-ai/dsh-jobs': SUPPORT,
    '@deepseek-ai/dsh-llm': SUPPORT,
    '@deepseek-ai/dsh-sandbox': SUPPORT,
    '@deepseek-ai/dsh-shell': SUPPORT,
    '@deepseek-ai/dsh-shell-env': SUPPORT,
    '@deepseek-ai/dsh-subagent': SUPPORT,
    '@deepseek-ai/dsh-typert-protocol': SUPPORT,
    '@deepseek-ai/dsh-tools': SUPPORT
  };
  assert.deepEqual(pkg.peerDependencies, expected,
    `peerDependencies 必须与需求 §7.3 兼容基准逐键逐值一致（实际：${JSON.stringify(pkg.peerDependencies)}）`);
  assert.equal(pkg.engines?.dsh, undefined,
    '不得声明 engines.dsh——宿主在场时它会顶替九条 peer 单独裁决，支持集合因此失效');
  assert.equal(pkg.dependencies?.['@deepseek-ai/schemastery'], '~3.18.5',
    'schemastery 叶子依赖形态不变（~ 窗随宿主树）');
  assert.equal(pkg.version, '0.2.8+dsh.0.2.1-rc',
    '本包 version 必须按需求 §7.3.1 带构建元数据全标识（核心 0.2.8 + 兼容线 dsh.0.2.1-rc）——漏元数据会让用户失去兼容信息');
});


