/**
 * 两层分工的锁（需求 §3.2 可见性与隔离、§5.1 设置来源与生效）。
 *
 * 这一组用例防的是**架构退化**：三条约束都是"写错了也能跑、但会在别人机器上炸"的类型，
 * 靠人工复查守不住，必须有能失败的断言。
 *
 * | 用例 | 锁住的约束 | 违反后的真实后果 |
 * | --- | --- | --- |
 * | T1 | 设置快照链：宿主行播报、工具行读快照（无 installSection / settings.get） | 多行注册撞名；或设置改了工具永远不知道 |
 * | T2 | 宿主半边不注册任何工具 | 工具进入全局工具层，出现在每个预设里 |
 * | T3 | 工具读取用的是"调用时取值"的视图（`readSnapshot() ?? initial`） | 改设置不生效（构造时快照），需求 §5.1 落空 |
 * | T10 | volatile 提交事件 → 快照 → refresh-bus → 描述 就地刷新，整链贯通 | 行为活、描述死（模型看到过期数字） |
 *
 * ## 现行判据口径
 *
 * - 设置侧**没有** `installSection`、没有 `settings.get(ns)` 服务接口：宿主行
 *   `attachSnapshotSource(ctx)` 首播快照 + 监听 `loader/volatile-update`；
 *   工具行 `readSnapshot() ?? initial`。卡片挂在 `plugins.bundle.config` keyed 槽
 *   （`client.js`，静态判据见 T5/T16；设计 §5.3）。
 * - 预设补丁判据见 `test/preset.test.mjs` 与 `tools/validate-preset.mjs`（以文件头声明为准）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (relative) => readFileSync(resolve(ROOT, relative), 'utf8');

/**
 * 离线安全加载：只吞 `@deepseek-ai/` 包解析失败（本地 node_modules 没有
 * `dsh-llm`/`cosmokit` 等传递依赖时），其余错误原样抛——语法错误、模块内部
 * 抛错不得被伪装成"离线环境"的跳过。
 * @template T
 * @param {string} specifier 动态 import 说明符。
 * @returns {Promise<T | undefined>} 模块；宿主包不可解析时为 `undefined`。
 */
async function loadOfflineSafe(specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && message.includes('@deepseek-ai/')) return undefined;
    throw error;
  }
}

/** 去掉行注释与块注释，保留其余文本（含字符串字面量）。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** client.js 去注释后的代码（T14/T16 只扫代码，注释里必然引用颜色值）。 */
function clientCode() {
  return read('client.js').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
}

test('T1：设置快照链——宿主行播报、工具行读快照、任何地方都没有 installSection', () => {
  // ① 旧注册机制（installSection / settings.get）在整个 lib/ 不得复活：
  //    设置 describe 自动遍历活动条目的 volatile 字段，宿主侧零注册
  //    （`dsh-settings/lib/index.js:413-451`）；再写 installSection 会在
  //    不存在的服务接口上调用，且多行注册撞 `already registered`。
  for (const file of ['lib/index.js', 'lib/settings.js', 'lib/config-view.js', 'lib/host.js']) {
    const code = stripComments(read(file));
    assert.doesNotMatch(code, /installSection/, `${file} 出现了 installSection（现行设置链不走该注册机制）`);
    assert.doesNotMatch(code, /settings\.get\(/, `${file} 出现了 settings.get（服务接口没有这个方法）`);
  }

  // ② 宿主半边必须接的就是快照链：`attachSnapshotSource`（首播 + volatile 监听）。
  const hostCode = stripComments(read('lib/host.js'));
  assert.match(hostCode, /attachSnapshotSource\(ctx, liveConfig\)/, 'lib/host.js 必须把 apply 第二参（活配置）交给 attachSnapshotSource——否则快照永远缺席');

  // ③ 快照模块的四个入口（seed/read/clear + 接线）——工具行的取值入口点名 readSnapshot。
  const entryCode = stripComments(read('lib/index.js'));
  assert.match(entryCode,
    /makeConfigView\(\(\) => \{\s*const snapshot = readSnapshot\(\);\s*return snapshot === undefined\s*\?\s*initial\s*: \{ \.\.\.snapshot, owningPreset: initial\.owningPreset \};\s*\}\)/,
    '工具行取值必须是"快照优先、缺快照回退本行默认值"的活视图，且快照合并保留本行装载期的 owningPreset（行身份非 volatile，设计 §6.2）');
});

test('T2（R6）：宿主入口不注册任何工具', () => {
  const code = stripComments(read('lib/host.js'));
  assert.doesNotMatch(
    code,
    /tools\.register|ctx\.tools/,
    // 措辞要准：**"可见"不等于"每个预设都会用"**——每个预设都有自己的工具列表，
    // 使用者可以取舍。被禁的是"**不经选择地默认塞给所有预设**"，差别在**同意**，不在功能取舍。
    'lib/host.js 不得接触工具表：宿主侧注册的工具会进全局工具层，于是**每个预设都默认带上它们**，不需要也无法拒绝'
  );
  // 宿主入口也不该把工具的工厂 import 进来——import 了迟早会被用上。
  // （这条正则必须覆盖 agent.js——光改注释不改正则，
  // 宿主半边悄悄引入第四个工厂会全绿放行。）
  assert.doesNotMatch(code, /from '\.\/(jobs|wait-job|wait-agent|agent)\.js'/, '宿主入口不得引入任何工具的工厂');
});

test('T2b（R6）：单包两角色——默认入口按 toolName 分派，./host 子路径入口不得复活', () => {
  const pkg = JSON.parse(read('package.json'));
  const main = pkg.exports['.'].default;
  assert.ok(typeof main === 'string' && main.length > 0, '默认入口必须存在');
  // 浏览器半边挂在平名主包上（./client 子路径导出是 dsh.client 的取件口，不是行名）。
  assert.equal(pkg.exports['./client'], './client.js', '必须导出 ./client 指向包根的 client.js');
  assert.notEqual(main, pkg.exports['./client'], '宿主半边与浏览器半边不能是同一个文件');
  // ./host 入口不得出现：行名带子路径进不了客户端模块图，
  // 而宿主角色由默认入口分派，`./host` 入口只剩误导。
  assert.equal(pkg.exports['./host'], undefined,
    '`./host` 子路径入口不得出现：宿主角色已由默认入口按 toolName 分派，'
    + '留着它只会让人以为还有第二个入口');
  // 分派前提：入口源码里必须真的按 toolName 分叉（删掉分派等于宿主行去注册工具）。
  const code = stripComments(read('lib/index.js'));
  assert.match(code, /rawConfig\?\.toolName === undefined/, '入口必须按 toolName 缺省分派宿主角色');
  assert.match(code, /applyHostHalf\(ctx, rawConfig\)/, '宿主角色必须分派到 lib/host.js 的 applyHostHalf');
});

test('T3：改设置后模型看到的数字真的跟着变（行为差异，不是文本匹配；英文锚）', async (t) => {
  // 宿主入口（lib/index.js → ask-takeover.js → @deepseek-ai/dsh-llm）在离线环境
  // 不可解析时跳过——jobs/wait-job/wait-agent 本身离线可跑，但本用例的核心判据
  // （refreshToolDescriptions 的行为）依赖宿主入口，跳过即丢判据，交给 test:inproc。
  const hostIndex = await loadOfflineSafe('../lib/index.js');
  if (hostIndex === undefined) { t.skip('宿主包不可解析（离线环境），本用例跳过'); return; }
  // "源码里出现 makeConfigView"式文本匹配在把实现退化成构造时快照后
  // **仍然全绿**——它对行为一无所知，本判据必须断言行为。
  const { createRunTool } = await import('../lib/jobs.js');
  const { createWaitJobTool } = await import('../lib/wait-job.js');
  const { createWaitAgentTool } = await import('../lib/wait-agent.js');
  const { refreshToolDescriptions } = hostIndex;

  let current = {
    toolName: 'async_run',
    agentLang: 'en',
    defaultYieldMs: 20000,
    minYieldMs: 1000,
    maxYieldMs: 600000,
    defaultWaitMs: 30000,
    minWaitMs: 250,
    maxWaitMs: 600000,
    maxResultChars: 30000,
    jobKind: 'async-command',
    pollIntervalMs: 500
  };
  const view = new Proxy({}, { get: (_target, key) => current[key] });
  const ctx = { logger: { info() {}, warn() {}, debug() {} }, get: () => undefined };

  for (const [name, tool, param] of [
    ['async_run', createRunTool(ctx, view), 'yield_ms'],
    ['async_wait_job', createWaitJobTool(ctx, view), 'wait_ms'],
    ['async_wait_agent', createWaitAgentTool(ctx, view), 'wait_ms']
  ]) {
    const topBefore = tool.description;

    current = { ...current, defaultYieldMs: 5000, maxYieldMs: 120000, defaultWaitMs: 7000, maxWaitMs: 130000 };
    refreshToolDescriptions(tool, view);

    assert.notEqual(tool.description, topBefore, `${name}：改设置后顶层描述必须变化（否则模型看到的是过期的上限）`);
    // 锚④：尾部摘要的等待区间（waitDigest 拼出，以 `;` 结尾）。
    const topRange = /Per-call wait budgets must be passed explicitly, range (\d+)–(\d+) ms;/.exec(tool.description);
    assert.deepEqual([topRange?.[1], topRange?.[2]], ['250', '130000'], `${name}：尾部摘要的等待区间必须更新`);

    // ── **正文那处**必须单独断言（现行判据必须单列）──────────────────
    //
    // 模型实际读到的是**正文**——各工具的正文形态不一样，断言不能一刀切：
    //
    // | 工具 | 正文里有 | 英文锚 |
    // |---|---|---|
    // | `async_wait_job` / `async_wait_agent` | 等待区间 | 锚① `wait_ms is required, range N–M ms` |
    // | `async_run` | **只有首次等待区间** | 锚② `First wait bounded to N–M ms` |
    // | `async_agent` | 都没有 | 只在尾部摘要有等待区间（⑤ 是 provider 名） |
    if (name === 'async_run') {
      const yieldBody = /First wait bounded to (\d+)–(\d+) ms/.exec(tool.description);
      assert.deepEqual([yieldBody?.[1], yieldBody?.[2]], ['1000', '120000'],
        'async_run：正文里的**首次等待**区间必须更新成首次等待的值，不能写成单次等待');
    } else {
      const bodyRange = /wait_ms is required, range (\d+)–(\d+) ms/.exec(tool.description);
      assert.deepEqual([bodyRange?.[1], bodyRange?.[2]], ['250', '130000'],
        `${name}：**正文**里的等待区间必须更新（模型读的是这一处，不是尾部摘要）`);
    }

    // 参数说明由 `defineTool` 固化，必须一并刷新。
    const paramText = String(tool.parameters.properties[param].description);
    const range = /\((\d+)-(\d+)\)/.exec(paramText);
    const expected = name === 'async_run' ? ['1000', '120000'] : ['250', '130000'];
    assert.deepEqual([range?.[1], range?.[2]], expected, `${name}：参数描述的区间必须更新`);
    if (name === 'async_run') assert.match(paramText, /Defaults to 5000\b/, 'async_run：参数描述的默认值必须更新');

    // 复位，免得几条用例互相影响。
    current = { ...current, defaultYieldMs: 20000, maxYieldMs: 600000, defaultWaitMs: 30000, maxWaitMs: 600000 };
  }

  // 上一条只验"刷新函数做了什么"。**接线**必须单独锁：`lib/index.js` 必须把**活视图**
  // 交给工厂。变异 M3（把 `configView` 换成 `initial`）会在行为测试里逃过——因为它直接
  // 调工厂、绕过了接线，而工厂拿到的 Proxy 与快照在那条路径上读到相同的初始值。
  const wiring = stripComments(read('lib/index.js'));
  assert.match(wiring,
    /const configView = makeConfigView\(\(\) => \{\s*const snapshot = readSnapshot\(\);\s*return snapshot === undefined\s*\?\s*initial\s*: \{ \.\.\.snapshot, owningPreset: initial\.owningPreset \};\s*\}\)/,
    '必须构造"快照优先、缺快照回退本行默认值"的活取值视图（owningPreset 恒取装载期值）');
  assert.match(wiring, /factory\(ctx, configView\)/, '工厂必须拿到活视图，不能拿构造时的快照');
});

test('T3b（R10）：刷新描述不得抛，也不得悄悄注销工具', async (t) => {
  const hostIndex = await loadOfflineSafe('../lib/index.js');
  if (hostIndex === undefined) { t.skip('宿主包不可解析（离线环境），本用例跳过'); return; }
  const { refreshToolDescriptions } = hostIndex;
  const view = new Proxy({}, { get: () => undefined });
  // 形状异常的工具对象不该让刷新路径炸掉（`parameters` 可能是空对象）。
  assert.doesNotThrow(() => refreshToolDescriptions({ description: 'x', parameters: {} }, view));
  assert.doesNotThrow(() => refreshToolDescriptions({ description: 'x' }, view));
  // 就地刷新**不碰工具表**：源码里不得出现"先注销再注册"那条有窗口的路径。
  const code = stripComments(read('lib/index.js'));
  assert.doesNotMatch(code, /disposeTool\(\);\s*\n\s*register\(\);/,
    '不得用"先注销再注册"刷新描述——register 抛错会让工具凭空消失');
  assert.match(code, /refreshToolDescriptions\(tool, configView\)/, 'onSettingsChanged 回调里必须调用就地刷新');
});

test('T5：单包两形态正确——bundle 补丁数组、宿主行不带 toolName、卡片挂 plugins.bundle.config keyed 槽', () => {
  const pkg = JSON.parse(read('package.json'));

  // ① 包名必须是**平名**：`dsh-client-modules` 只把平名包纳入客户端模块图
  // （`dsh-client-modules/lib/index.js:132-138`、`:683`、`:779`）。
  assert.equal(pkg.name, 'dsh-async-tools', '包名必须是平名（不含 `/`）');
  assert.ok(!pkg.name.includes('/'), '包名含 `/` 会被 dsh-client-modules 静默跳过');

  // ② bundle 声明（**数组**，宿主行补丁 + 两份预设补丁；第三项为
  //    异步创造模式补丁）。
  //    进了 `dsh.profile.bundles` 却没有 `dsh.bundle` 的话，`dsh-app-boot` 会
  //    **直接启动失败**（不是静默）。
  const patches = pkg.dsh?.bundle?.patch;
  assert.ok(Array.isArray(patches), `dsh.bundle.patch 必须是数组（三份补丁），实得 ${typeof patches}`);
  assert.deepEqual(patches,
    ['./cordis.patch.yml', './presets/dsh-async.patch.yml', './presets/dsh-async-create.patch.yml'],
    '补丁清单必须是 [宿主行补丁, dsh-async 预设补丁, dsh-async-create 预设补丁] 三份');
  for (const patch of patches) {
    assert.ok(existsSync(resolve(ROOT, patch.replace('./', ''))), `${patch} 必须真实存在`);
    // files 里列的可能是精确路径，也可能是覆盖它的目录（`presets`）——两者都算交付。
    const covered = pkg.files.some((entry) => entry === patch.replace('./', '')
      || patch.replace('./', '').startsWith(`${entry}/`));
    assert.ok(covered, `files 必须包含 ${patch}（直接或经目录）`);
  }

  // ③ 浏览器半边：platform、注入表、取件口、文件、files 五件套。
  assert.equal(pkg.dsh?.client?.platform, 'web', '必须声明 dsh.client.platform = web');
  assert.ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0,
    '必须声明 dsh.client.inject（卡片依赖的客户端模块）');
  assert.equal(pkg.exports?.['./client'], './client.js', '必须导出 ./client 指向包根 client.js');
  assert.ok(existsSync(resolve(ROOT, 'client.js')), 'client.js 必须真实存在');
  assert.ok(pkg.files.includes('client.js'), 'files 必须包含 client.js');

  // ④ 宿主行**只有一行**、平名、**不得带 `toolName`**——带了就会把这一行变成
  // 工具行，宿主侧的工具进全局工具层（需求 §3.2）。注释里的字样不算（先剥掉 YAML 注释行再查）。
  const patchCode = read('cordis.patch.yml')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const insertCount = (patchCode.match(/-\s*id:/g) ?? []).length;
  assert.equal(insertCount, 1, `宿主 patch 必须只插一行，实际 ${String(insertCount)} 行`);
  assert.match(patchCode, /id:\s*async-tools-host/, '宿主行 id 必须是 async-tools-host');
  assert.match(patchCode, /name:\s*dsh-async-tools\s*$/m, '宿主行名必须是平名 dsh-async-tools');
  assert.doesNotMatch(patchCode, /toolName/, '宿主行不得带 toolName——带了就变成工具行，工具会泄漏进全局工具层（R4）');

  // ⑤ 卡片挂插件管理页的 **`plugins.bundle.config`** keyed 槽（设计 §5.3）：
  //    槽键 = **包名**（被配置的那个 bundle），宿主把它渲染在**插件页的描述与组件行之间**
  //    ——设置就在插件页上。键写错时页面不报错、只是永远不渲染；`plugins.item` 按契约
  //    留给官方伴随包，`plugins.row.config` 是另一条落点（会把设置埋进组件行子页，本包不用）。
  const client = clientCode();
  assert.match(client, /var ENTRY = "async-tools-host"/, 'client.js 必须有字面量 ENTRY 常量');
  assert.match(client, /name: "plugins\.bundle\.config"/, 'client.js 必须注册到 plugins.bundle.config keyed 槽');
  assert.match(client, /key: PACKAGE_NAME,/, 'bundle 槽的键必须是被配置的包名（keyed 槽缺 key 抛错）');
  assert.doesNotMatch(client, /name: "plugins\.row\.config"/, 'R24：不得退回组件行子页落点（plugins.row.config）');
  assert.doesNotMatch(client, /name: "plugins\.item"/, 'R24：不得挂 plugins.item（该槽按契约留给官方伴随包）');
  assert.match(client, /var PACKAGE_NAME = "dsh-async-tools"/, '包名常量必须是平名 dsh-async-tools');
  assert.match(client, /whileServed\(\[ENTRY\]/, '注册必须包在 whileServed 守卫里（宿主行没装载就不注册，部署无痕）');
  // bundle 槽**不传** `form`：表单必须由卡片从控制器自取，读 `props.form` 会渲染空卡。
  // 表单本体是官方 `SettingsFormModel`（scope = 控制器），重渲染走模型的快照存储 +
  // `useSyncExternalStore`——订阅责任从卡片手写 effect 移到模型构造里。
  assert.match(client, /ctx\.configForms\.get\(ENTRY\)/, '表单必须由卡片自取控制器');
  assert.match(client, /new P\.SettingsFormModel\(scope, makeSpecs\(\)\)/,
    '控制器必须交给官方 SettingsFormModel（R27：暂存/差集/保存语义不自绘）');
  assert.match(client, /useSyncExternalStore\(card\.store\.subscribe, card\.store\.getSnapshot\)/,
    '卡片必须订阅模型的快照存储（bind 的 store）重渲染——不订阅就停在旧值');
});

test('T6（R10）：浏览器半边不引入会被打包器执行不到的 ESM 语法', () => {
  const client = read('client.js');
  // 它是 `window.__ModuleLoader__.load({factory: (require) => ...})` 的 CJS 包裹，
  // 顶层用 `import`/`export` 会让整块加载失败，而失败发生在浏览器里、本机测试看不见。
  const body = client.slice(0, client.indexOf('factory:'));
  assert.doesNotMatch(body, /^\s*(import|export)\s/m, '浏览器半边顶层不得使用 ESM 语法');
  assert.match(client, /React\.createElement/, '必须用 React.createElement（无 JSX 转译）');
  // JSX 判据**不能要求标签在行首**：若写成 `/^\s*<[A-Z][A-Za-z]*[\s/>]/m`，
  // 而退化成 JSX 的代码通常是嵌在表达式里的（`return <div ...>,`），行首匹配抓不到它。
  // 判据取"整份文件里不出现 JSX 形态的标签"（变异 M9 证明它能失败）。
  assert.doesNotMatch(client, /<[A-Za-z][A-Za-z0-9]*(\s[^<>]*)?\/?>/, '不得出现 JSX 标签');
});

test('T7（R10）：校验只有一套判据 —— 非法值必须在 schema 层被拒', () => {
  // 缺陷形态：`Config` 的数值字段若没有下界约束，则
  // ① 设置页放行 `-1` / `0` / 空串；② 运行时 `resolveConfig` 才抛错并被吞掉。
  // 修法是把约束放进 schema —— 它同时就是设置页逐字段校验用的那份 schema。
  return import('../lib/config.js').then(({ Config }) => {
    // **每个 patch 都必须带上 `toolName`**，否则 `toolName` 的 `.required()` 会让
    // **每一条**都抛错——于是本用例变成恒真：它测的就成了"缺字段会被拒"，
    // 而不是"这一条约束会被拒"。"判据因为别的原因也成立"的坑会让用例恒真。
    //
    // 反向那组同样要带：没有 `toolName` 的回退语义，缺省即宿主角色。
    const BASE = { toolName: 'async_run' };
    const rejects = (patch) => {
      try { Config({ ...BASE, ...patch }); return false; } catch { return true; }
    };
    for (const [label, patch] of [
      ['jobKind 空串', { jobKind: '' }],
      ['maxResultChars = 0', { maxResultChars: 0 }],
      ['maxResultChars 负数', { maxResultChars: -5 }],
      ['pollIntervalMs 负数', { pollIntervalMs: -1 }],
      ['minYieldMs = 0', { minYieldMs: 0 }],
      ['maxWaitMs 负数', { maxWaitMs: -1 }],
      ['toolName 不在枚举里', { toolName: 'nope' }]
    ]) {
      assert.equal(rejects(patch), true, `${label} 必须被 schema 拒绝`);
    }
    // 反向：别把正常路径一起挡掉。
    for (const [label, patch] of [
      ['只给 toolName', { toolName: 'async_run' }],
      ['正常区间', { minWaitMs: 250, maxWaitMs: 600000 }],
      ['极小但合法', { maxResultChars: 1, pollIntervalMs: 1 }]
    ]) {
      assert.equal(rejects(patch), false, `${label} 必须通过`);
    }
    // 恒真检查：基底本身**必须通过**。若不通过，上面那组"必须被拒"就是白测的。
    assert.equal(rejects({}), false, 'BASIC 配置（含 toolName）必须通过——否则上面的拒绝断言没有区分力');

    // 宿主行没有 toolName，`Config` 必须放行（角色分派的前提），
    // 且**不得回填默认值**——默认值会让宿主行静默变成工具行，把工具泄漏进全局工具层（需求 §3.2）。
    const empty = Config({});
    assert.equal(empty.toolName, undefined,
      '缺省 toolName 必须保持缺省（= 宿主角色），不得回填任何默认值');
  });
});

test('T7b（R10）：跨字段约束必须覆盖**每一个**默认值字段（活路径直测）', async () => {
  // 缺陷形态：只查 `defaultYieldMs` 落在区间内，
  // 漏了 `defaultWaitMs`。后果是设置页放行 `defaultWaitMs: 999999`、存进设置文档，
  // 然后在某次 async_wait_job 调用里被夹紧——使用者看到的是"我设了但没效果"。
  // 本用例直测**活路径** resolveConfig（跨字段判据内联在 resolveConfig 里）——
  // 连同 assertCrossFieldOrder 的导出集（探针直测入口）一起钉住单一事实源。
  const { resolveConfig, assertCrossFieldOrder } = await import('../lib/config.js');
  const base = {
    defaultYieldMs: 5,
    minYieldMs: 1,
    maxYieldMs: 10,
    defaultWaitMs: 5,
    minWaitMs: 1,
    maxWaitMs: 10,
    // pollIntervalMs 受 maxWaitMs 配对约束——基准必须显式给值
    // （缺省会回默认 500，撞上本基准的 maxWaitMs: 10）。
    pollIntervalMs: 5
  };
  assert.doesNotThrow(() => resolveConfig({ ...base }), '合法的基准配置必须通过 resolveConfig');
  assert.doesNotThrow(() => assertCrossFieldOrder(base), '同一份判据（导出接口）对合法配置必须通过');

  const rejects = (patch, label) => {
    assert.throws(() => resolveConfig({ ...base, ...patch }), Error, `${label} 必须被拒`);
  };
  rejects({ minYieldMs: 9, maxYieldMs: 1 }, 'minYieldMs > maxYieldMs');
  rejects({ minWaitMs: 9, maxWaitMs: 1 }, 'minWaitMs > maxWaitMs');
  rejects({ pollIntervalMs: 9, maxWaitMs: 8 }, 'pollIntervalMs > maxWaitMs（R29-d 配对）');
  rejects({ defaultYieldMs: 99 }, 'defaultYieldMs 超出让出区间');
  rejects({ defaultYieldMs: 0.5 }, 'defaultYieldMs 低于让出下限');
  rejects({ defaultWaitMs: 99 }, 'defaultWaitMs 超出等待区间');
  rejects({ defaultWaitMs: 0.5 }, 'defaultWaitMs 低于等待下限');
});

test('T8：volatile 提交失败必须**响亮**，不能静默退回', () => {
  const code = stripComments(read('lib/settings.js'));
  // 快照缺席（宿主行未装载）可以安静退回（工具行有 stderr 通告）；但"提交后自检失败"
  // 必须 warn + stderr 说明——否则用户看到"保存成功"而行为停在旧值（缺陷形态）。
  assert.match(code, /volatile 提交后配置自检失败/, '刷新失败必须 warn 说明是哪次提交没生效');
  assert.match(code, /volatile 提交未生效/, '还必须有 stderr 审计行（emitLifecycleNotice）');
  const warnCount = (code.match(/logger\?\.warn\?\./g) ?? []).length;
  assert.ok(warnCount >= 1, 'lib/settings.js 里必须至少有一条 warn（非法值路径）');
});

test('T9：保存语义由官方模型承担——布尔为假即失败且草稿保留；恢复默认只暂存', async () => {
  // 宿主缺陷形态：`mutate()` 在 `!response.ok` 时
  // 只恢复读然后返回布尔假，**不抛错**——自绘的 try/catch 永远不进 catch，用户看到
  // 成功提示而写入已被拒绝。保存语义整体交给官方 `SettingsFormModel`：
  // 布尔为假 → `failed` 并**保留草稿**；成功 → 清草稿、由活 section 值回填。
  // 这里在沙箱里加载 CJS 包裹（primitives 用忠实替身），对**本包装配出来的模型**做行为验证。
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const reactStub = { createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
  const double = makePrimitivesDouble(reactStub);
  const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
  let loaded;
  new Function('window', source)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactStub : double));
  assert.ok(product !== undefined, 'factory 必须产出模块');

  // ① 装配断言：specs 的字段键集合与 FIELDS 逐项相等——漏一个字段即红。
  const specs = product.makeSpecs();
  assert.deepEqual(specs.map((spec) => spec.field), product.FIELDS.map((field) => field.key),
    'specs 的字段键集合必须与 FIELDS 逐项相等（顺序也一致——保存的 op 顺序随之确定）');

  // ② 假 scope 必须给**完整** SettingsFormScope：模型构造时就 `scope.subscribe(...)`，
  //    缺 `subscribe` 必须当场抛错（"假件不许宽容"的一处落点）。
  const brokenScope = { getSnapshot: () => ({}), mutate: async () => true };
  assert.throws(() => new double.SettingsFormModel(brokenScope, []),
    /subscribe is not a function/,
    'scope 缺 subscribe 必须在构造时抛错——模型靠它订阅快照替换');

  const snapshot = (revision, user, value) => ({
    status: 'ready',
    value: value ?? { jobKind: 'async-command', uiLang: 'auto' },
    base: {},
    user,
    revision,
    writable: true,
    mode: 'host'
  });
  const mutateCalls = [];
  const makeScope = (snap) => ({
    getSnapshot: () => snap,
    subscribe: () => () => {},
    mutate: async (ops, rev) => { mutateCalls.push({ ops, rev }); return mutateResult; }
  });
  let mutateResult = true;
  let scope = makeScope(snapshot(7, {}));
  const model = new double.SettingsFormModel(scope, product.makeSpecs());
  const store = model.bind(() => ({ shell: model.shell(), jobKind: model.field('jobKind') }));
  const actions = model.actions();

  // ③ 改一个字段 → 保存（宿主接受）：mutate 恰一次、带读取时的 revision、成功后草稿清空。
  //    官方 `actions().save` 是按钮接线的即发即弃形态（不返回 Promise）；可等待的
  //    驱动走同一底层 `model.save()`（actions.save 调的就是它）。
  actions.edit('jobKind', 'my-kind');
  await model.save();
  assert.equal(mutateCalls.length, 1, '有改动时 mutate 必须恰一次（判据 8）');
  assert.deepEqual(mutateCalls[0].ops, [{ op: 'set', path: ['jobKind'], value: 'my-kind' }],
    '保存必须把改动做成 set op 交给宿主');
  assert.equal(mutateCalls[0].rev, 7, '写入必须带暂存开始时的 revision（revision 栅栏）');
  assert.equal(store.getSnapshot().shell.dirty, false, '成功后草稿清空 ⇒ 不再 dirty');

  // ④ 无改动再保存：不得再发写（空暂存在模型里直接返回，判据 8 的"无改动时不多发"）。
  await model.save();
  assert.equal(mutateCalls.length, 1, '无改动时不得多发 mutate（模型对空 plan 直接返回）');

  // ⑤ 失败路径（判据 6）：宿主拒绝（mutate 回 false）→ failed 且草稿仍在。
  mutateResult = false;
  actions.edit('jobKind', 'rejected-kind');
  await model.save();
  const failedState = store.getSnapshot();
  assert.equal(mutateCalls.length, 2, '失败的保存也是一次 mutate（本用例的驱动必须真的走到保存路径）');
  assert.equal(failedState.shell.failed, true, '布尔为假必须落 failed（不抛错、不静默）');
  assert.equal(failedState.jobKind.text, 'rejected-kind', '失败的保存必须保留草稿（使用者改得动而不是重打）');
  assert.equal(failedState.shell.dirty, true, '草稿仍在 ⇒ 仍 dirty');
  mutateResult = true;

  // ⑥ 恢复默认只暂存（判据 3）：点「恢复默认」不发写；保存时才发 unset。
  scope = makeScope(snapshot(8, { jobKind: 'old-kind' }));
  const model2 = new double.SettingsFormModel(scope, product.makeSpecs());
  const store2 = model2.bind(() => ({ shell: model2.shell(), jobKind: model2.field('jobKind') }));
  const actions2 = model2.actions();
  const beforeReset = mutateCalls.length;
  assert.equal(store2.getSnapshot().jobKind.overridden, true,
    'user 层在场的字段必须带覆盖徽标（在场即覆盖，与值无关）');
  actions2.resetField('jobKind');
  assert.equal(mutateCalls.length, beforeReset, '恢复默认不得直接发写（只暂存——判据 3 的保存前半）');
  assert.equal(store2.getSnapshot().jobKind.text, '',
    '恢复默认的暂存文本 = 复合层基准的格式化（这里 base 缺省 ⇒ 空串）');
  assert.equal(store2.getSnapshot().jobKind.overridden, false,
    '徽标预演保存结果：暂存的是清除 ⇒ 不再显示覆盖');
  await model2.save();
  const lastCall = mutateCalls[mutateCalls.length - 1];
  assert.deepEqual(lastCall.ops, [{ op: 'unset', path: ['jobKind'] }],
    '保存把"恢复默认"做成 unset op（清除用户层覆盖）');
  model.dispose();
  model2.dispose();
});

test('T9b：成功回填生效值、失败保留草稿；卸载丢弃草稿', async () => {
  // 判据是**行为**口径：成功 ⇒ 草稿清空、字段由活 section 值回填（宿主静默丢写的
  // 可见后果就是"字段回到生效值"，谎报成功没有藏身处）；失败 ⇒ 草稿保留；卸载 ⇒ 丢弃。
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const reactStub = { createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
  const double = makePrimitivesDouble(reactStub);
  const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
  let loaded;
  new Function('window', source)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactStub : double));

  let snap = { status: 'ready', value: { jobKind: 'old' }, base: {}, user: {}, revision: 3, writable: true };
  const mutateCalls = [];
  let mutateOk = true;
  const scope = {
    getSnapshot: () => snap,
    subscribe: () => () => {},
    mutate: async (ops, rev) => { mutateCalls.push({ ops, rev }); return mutateOk; }
  };
  const model = new double.SettingsFormModel(scope, product.makeSpecs());
  const store = model.bind(() => ({ shell: model.shell(), jobKind: model.field('jobKind') }));
  const actions = model.actions();

  // ① 成功路径：保存被接受、宿主写进新值（快照换新）⇒ 字段回到生效值、不再 dirty。
  actions.edit('jobKind', 'new');
  await actions.save();
  snap = { status: 'ready', value: { jobKind: 'new' }, base: {}, user: { jobKind: 'new' }, revision: 4, writable: true };
  model.publish();
  const after = store.getSnapshot();
  assert.equal(after.jobKind.text, 'new', '成功后字段由活 section 值回填（回到生效值）');
  assert.equal(after.shell.dirty, false, '成功后草稿清空');

  // ② 失败路径：草稿保留（T9 ⑤ 的口径在"回填生效值"对照下再钉一次）。
  mutateOk = false;
  actions.edit('jobKind', 'draft-kept');
  await actions.save();
  assert.equal(store.getSnapshot().jobKind.text, 'draft-kept', '失败的保存必须保留草稿');
  mutateOk = true;

  // ③ 卸载丢弃（判据 9 的模型侧）：SettingsForm 卸载时调 onDiscard（接线在卡片），
  //    模型的 discard 清空暂存 ⇒ 字段回到生效值。真机的"离开页面再回来"由端到端验证。
  actions.edit('jobKind', 'to-be-discarded');
  assert.equal(store.getSnapshot().shell.dirty, true, '丢弃前必须有暂存（本用例的驱动必须真的改过）');
  actions.discard();
  const discarded = store.getSnapshot();
  assert.equal(discarded.jobKind.text, 'new', '丢弃后字段回到生效值（暂存清空、由 section 回填）');
  assert.equal(discarded.shell.dirty, false, '丢弃后不再 dirty');
  model.dispose();
});

test('T10：宿主侧的 volatile 提交必须真的到达预设工具的描述', async (t) => {
  // 缺陷形态：就地刷新函数没问题，但**触发通道不存在**。
  // 通道是：设置表单提交 → loader 就地提交 fiber config → 向宿主行 fiber 派发
  // `loader/volatile-update` → 快照重播 + refresh-bus 广播 → 工具行就地刷新描述。
  //
  // 这条用例走**真实 cordis 调用链**：两个层各自装载（工具行带 toolName、宿主行不带），
  // 然后在宿主行上下文上真实派发 volatile-update，断言描述变了。
  // cordis（经 cosmokit 传递依赖）与宿主入口任一不可解析（离线环境）即跳过。
  const cordisModule = await loadOfflineSafe('@deepseek-ai/cordis');
  const cosmokitModule = await loadOfflineSafe('@deepseek-ai/cosmokit');
  const preset = await loadOfflineSafe('../lib/index.js');
  if (cordisModule === undefined || cosmokitModule === undefined || preset === undefined) {
    t.skip('宿主包不可解析（离线环境），本用例跳过');
    return;
  }
  const bus = await import('../lib/refresh-bus.js');
  const { readSnapshot, clearSnapshot } = await import('../lib/settings.js');
  const { Context } = cordisModule;
  const { createVolatile, updateVolatile } = cosmokitModule;
  clearSnapshot();

  const registeredTools = new Map();
  const services = {
    tools: { register: (definition) => { registeredTools.set(definition.name, definition); return () => registeredTools.delete(definition.name); } },
    jobs: { list: () => [], get: () => undefined, start: () => 'j', wait: async () => ({}), read: () => ({ chunks: [] }) },
    shell: { resolve: (resource) => resource, async execute() { throw new Error('unused'); } },
    shellEnv: { collect: () => Object.freeze({}) },
    subagents: { listChildren: async () => [] },
    timer: { timeout: () => () => {}, interval: () => () => {} },
    // 模型选择的第七服务：挂载级假件只需"无 policy"初值形态。
    sessionProjections: { stateOf: () => null },
    // 第八服务：公开 Agent 注册表（挂载级假件只需"查无驻留"形态）。
    agents: { get: () => undefined },
    logger: { info() {}, warn() {}, debug() {} }
  };

  const mount = async (ctx, plugin, config) => {
    const fork = ctx.plugin(plugin, config);
    for (let turn = 0; turn < 64 && fork.state !== 2; turn += 1) await Promise.resolve();
    return fork;
  };

  // ① 预设层（工具行）：快照缺席是合法状态——工具退本行默认值（stderr 通告）。
  const presetCtx = new Context();
  for (const [name, value] of Object.entries(services)) presetCtx.provide(name, value);
  const presetFork = await mount(
    presetCtx,
    { name: preset.name, inject: preset.inject, Config: preset.Config, apply: preset.apply },
    { toolName: 'async_run' }
  );
  assert.equal(presetFork.state, 2, '预设层必须激活');
  const tool = registeredTools.get('async_run');
  assert.ok(tool !== undefined, '工具必须注册');
  assert.ok(bus.listenerCount() >= 1, '预设层装载后登记表里必须有刷新回调');
  assert.match(tool.description, /First wait bounded to 1000–600000 ms/, '快照缺席时描述用本行默认值');

  // ② 宿主侧（同一插件、行配置没有 toolName）：首播快照。
  const hostCtx = new Context();
  for (const [name, value] of Object.entries(services)) hostCtx.provide(name, value);
  const hostFork = await mount(
    hostCtx,
    { name: preset.name, inject: preset.inject, Config: preset.Config, apply: preset.apply },
    { toolName: undefined, maxWaitMs: 600000 }
  );
  assert.equal(hostFork.state, 2, '宿主角色必须激活');
  assert.equal(registeredTools.size, 1,
    `宿主角色不得注册工具（实际有 ${[...registeredTools.keys()].join('、')}）`);
  assert.ok(readSnapshot() !== undefined, '宿主行装载必须首播快照');

  // ③ volatile 提交：照 loader `_commitVolatile` 的同款方式**原地**改 Ref
  //    （`updateVolatile(ref, createVolatile(newValue))`，`cosmokit/lib/index.js:149-151`），
  //    再在 **fiber 自己的 ctx** 上派发事件（loader 也是 `fiber.ctx.emit`，cordis 的
  //    事件向上冒泡，从根 ctx 派发到不了 fiber 的监听）——快照必须重播、描述必须就地刷新。
  assert.equal(typeof hostFork.config.maxWaitMs?.get, 'function',
    'fiber.config 的 volatile 字段必须是 Ref（Schema.resolve 包的 createVolatile）——不是的话就地提交链不成立');
  const before = tool.description;
  updateVolatile(hostFork.config.maxWaitMs, createVolatile(130000));
  updateVolatile(hostFork.config.defaultYieldMs, createVolatile(5000));
  hostFork.ctx.emit('loader/volatile-update');
  // 快照重播是同步的（先于 refresh-bus 的动态 import）；描述刷新要等微任务+宏任务。
  assert.equal(readSnapshot().maxWaitMs, 130000, '事件派发后快照必须同步重播');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.notEqual(tool.description, before,
    'volatile 提交后描述必须变化——否则通道是断的（行为活、描述死）');
  const range = /Per-call wait budgets must be passed explicitly, range (\d+)–(\d+) ms;/.exec(tool.description);
  assert.deepEqual([range?.[1], range?.[2]], ['250', '130000'], '描述里的等待区间必须更新');
  assert.match(String(tool.parameters.properties.yield_ms.description), /Defaults to 5000/,
    '参数说明也必须更新');

  // ④ 一个回调抛错不得让整条通知停摆，也不得冒泡进宿主上下文。
  const offBad = bus.onSettingsChanged(() => { throw new Error('故意失败'); });
  assert.doesNotThrow(() => hostFork.ctx.emit('loader/volatile-update'), '通知不得冒泡');
  offBad();

  // ⑤ 卸载：宿主行卸载清快照（需求 §7.2 生命周期释放），工具行卸载注销刷新回调。
  const beforeUnload = bus.listenerCount();
  await presetFork.dispose();
  assert.ok(bus.listenerCount() < beforeUnload, '工具行卸载后必须注销回调');
  await hostFork.dispose();
  assert.equal(readSnapshot(), undefined, '宿主行卸载必须清空快照（R17：效应跟随生命周期）');
  clearSnapshot();
});

test('T11（R6）：包清单事实必须自洽', () => {
  // 两条都是"静默不报错"的类型，所以必须显式断言：
  //
  // ① `files` / `exports` 里的幽灵条目：`npm pack` 会静默忽略不存在的路径，于是
  //    "清单里每个文件都存在"这条验收永远不成立却看不出来。
  // ② 不得依赖宿主包 dsh-async-tools-host——任何依赖引用都等于"装不上还挂着名"。
  const mainPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

  for (const file of mainPkg.files ?? []) {
    // `presets` 与 `lib` 是目录，同样要求存在。
    assert.ok(existsSync(resolve(ROOT, file)), `files 里的 ${file} 不存在——npm pack 会静默忽略它，这条验收就成了空话`);
  }
  for (const [sub, target] of Object.entries(mainPkg.exports ?? {})) {
    const rel = typeof target === 'string' ? target : target?.default;
    if (typeof rel !== 'string') continue;
    assert.ok(existsSync(resolve(ROOT, rel.replace(/^\.\//, ''))),
      `exports["${sub}"] 指到的 ${rel} 不存在——客户端模块图按它取件，静默失效`);
  }

  assert.equal(mainPkg.dependencies?.['dsh-async-tools-host'], undefined,
    '不得依赖宿主包 dsh-async-tools-host');
  assert.equal(mainPkg.peerDependencies?.['dsh-async-tools-host'], undefined,
    '同上：peerDependencies 也不得依赖 dsh-async-tools-host');
});

test('T13：静态 inject 八服务；设置链不引入任何服务依赖', () => {
  // 唯一的静态 `inject` 在 `lib/index.js`（工具角色的八个固定依赖，宿主行共用；
  // `sessionProjections` 是模型选择的白名单读取）。
  // `settings` / `agentPresets` 不得出现在其中：写了就等于要求"这个部署必须有它们"，
  // 缺一个就让整行不激活 → 升级成 dsh 启动失败。设置快照链**不依赖任何
  // 服务**（宿主行读自己的 ctx.config、监听 loader 事件），所以这两个名字没有
  // 存在的理由。
  const code = stripComments(read('lib/index.js'));
  const injectMatch = code.match(/export const inject\s*=\s*(\[[^\]]*\])/);
  assert.ok(injectMatch !== null, '入口必须显式声明 inject');
  const declared = JSON.parse(injectMatch[1].replace(/'/g, '"'));
  for (const name of ['settings', 'agentPresets']) {
    assert.ok(
      !declared.includes(name),
      `静态 inject 不得包含 ${name}：缺该服务的部署会让整行不激活，升级成 dsh 启动失败`
    );
  }
  // 宿主半边没有 `ctx.get`（设置快照不查服务）、也不等任何服务；有
  // 运行时 `ctx.inject`：纪律段的 systemPrompt+预设过滤三服务段（需求 §6.3：c 防线按
  // 目标会话实际预设过滤，与提问接管判定同一条读取路径）与提问接线的三服务段
  // （ask 批次登记要读会话/投影/子代理）。静态 inject 列表依旧不动、快照链
  // 依旧零服务依赖。除此之外的任何服务等待仍然禁止——`settings`/`agentPresets`
  // 那类"缺服务整行不激活"的等待形态没有回潮的理由。
  const hostCode = stripComments(read('lib/host.js'));
  const hostInjects = [...hostCode.matchAll(/ctx\.inject\(\s*(\[[^\]]*\])/g)].map((m) => m[1]);
  assert.deepEqual(hostInjects,
    ["['systemPrompt', 'sessions', 'sessionProjections']", "['sessions', 'sessionProjections', 'agents']"],
    '宿主半边只允许 R28 纪律段（含预设过滤）与 R30 提问接线两个运行时注入；其余服务等待仍禁止（快照链零服务依赖）');
  assert.doesNotMatch(hostCode, /ctx\.get\(/, '宿主半边不得 ctx.get 探测服务');
});

test('T14（R10）：卡片样式必须走主题变量，不得写死颜色', () => {
  const code = clientCode();
  // ## 这条判据守什么
  //
  // 颜色若**写死**成浅色主题的取值，深色主题下渲染出来是页面中央一块
  // **白底黑框**的输入区，与周围完全脱节——而**单元测试、真机验收全都不会红**。
  //
  // 宿主自己的 `fields.module.css` **唯一的固定色是 `#0000`（透明）**，
  // 其余全走 CSS 变量。所以正确做法不是"再挑一组好看的固定色"，而是用同一批变量。
  assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/, '卡片不得写死颜色（要跟随深浅主题，用 --dsw-alias-* 变量）');
  assert.doesNotMatch(code, /\brgba?\(/, '卡片不得写死颜色（同上）');
  // 正面：确实是靠主题变量在取色，且取的是宿主那一套。
  assert.match(code, /var\(--dsw-alias-bg-layer-3\)/, '输入框底色要取宿主的层次底色变量');
  assert.match(code, /var\(--dsw-alias-label-primary\)/, '主文字要取宿主的主文字变量');
  assert.match(code, /var\(--dsw-alias-border-l4\)/, '输入框边框要取宿主的边框变量');
});

test('T16：plugins.bundle.config keyed 槽契约 + 毫秒换算秒读数', async () => {
  // 卡片壳（标题/图标/面包屑/折叠）由宿主画，本组件只出 summary/page 两个视图；
  // 折叠语义由宿主提供，视觉探针在真机上验。
  const code = clientCode();

  // ① 视图分派：`page` 渲染表单（bundle 槽只请求这一个视图），其余视图给一句话回退。
  assert.match(code, /props\.view !== "page"/, '必须按 view 分派：page 出表单、其余出 summary 一句话');
  // loading/unavailable/只读三种态都由官方 `SettingsForm` 渲染：
  // `!state.available` → `labels.unavailable`，`!state.writable` → `labels.readOnly`。
  // 行为侧在 T18 里用 loading 快照验（渲染出 unavailable 文案而不是白屏）。
  assert.match(code, /unavailable: t\("unavailable"\)/, '不可用态文案必须交给官方框架渲染（labels.unavailable）');
  assert.match(code, /readOnly: t\("readOnly"\)/, '只读态文案必须交给官方框架渲染（labels.readOnly）');
  // ② 两段读数的**行为侧**在 T18 与 ③-b 里判（按 ` · ` 切段、随键入实时、
  //    亚 10 ms、空姿态）；这里只保留接线锚——说明行由 `composeHint` 单点拼出
  //    （它拿得到生效值与暂存文本两个输入，缺一个输入段就无从谈起）。
  assert.match(code, /var hint = composeHint\(t, field, state\.effective\[field\.key\], fieldState\.text\);/,
    '说明行必须由 composeHint 以（生效值, 暂存文本）两输入拼出——输入段才有数据源');

  // ③ formatSeconds 行为（浏览器外可验证）：整数秒不带小数，小数保留两位，亚 10 ms
  //    显示 `< 0.01 s`（值只写秒文本——毫秒原值输入框里
  //    本来就有；正数不得读成 0 s——逐位键入时不给"读数归零"的错觉）。
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const made16 = [];
  const reactRecord = {
    createElement: (type, props, ...children) => {
      const element = { type, props: props ?? {}, children };
      made16.push(element);
      return element;
    },
    useState: () => [undefined, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v })
  };
  const double = makePrimitivesDouble(reactRecord);
  const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
  let loaded;
  new Function('window', source)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactRecord : double));
  assert.equal(typeof product.formatSeconds, 'function', 'formatSeconds 必须导出（浏览器外判据）');
  assert.equal(product.formatSeconds(20000), '20 s', '20000 ms → "20 s"');
  assert.equal(product.formatSeconds(1500), '1.5 s', '1500 ms → "1.5 s"');
  assert.equal(product.formatSeconds(250), '0.25 s', '250 ms → "0.25 s"');
  assert.equal(product.formatSeconds(4), '< 0.01 s', '4 ms → "< 0.01 s"（亚 10 ms 不得读成 0）');
  assert.equal(product.formatSeconds(9), '< 0.01 s', '9 ms → "< 0.01 s"（亚 10 ms 上界内侧）');
  assert.equal(product.formatSeconds(10), '0.01 s', '10 ms → "0.01 s"（恰好可表示，不带 < 号）');
  assert.equal(product.formatSeconds(999), '1 s', '999 ms → "1 s"（两位舍入进位，不带拖零）');
  assert.equal(product.formatSeconds(0), '', '0 不得显示读数（不是有效的时长）');
  assert.equal(product.formatSeconds(-5), '', '负数不得显示读数');
  assert.equal(product.formatSeconds('x'), '', '非数字不得显示读数');

  // ③-b composeHint 行为（两段形状、换行、分隔符、秒文本值、空姿态）：
  //    测试词典 `t` 的约定：键 + '|'；读数键带 `{v}` 占位（实现用 replace 填值——
  //    没有占位的桩会让"值没填进去"漏过）。非毫秒字段无读数；两段相等也不隐藏。
  assert.equal(typeof product.composeHint, 'function', 'composeHint 必须导出（读数拼接的浏览器外判据）');
  assert.equal(typeof product.draftReadout, 'function', 'draftReadout 必须导出（输入段姿态的浏览器外判据）');
  const tt = (key) => (key === 'readout.effective' || key === 'readout.input' ? `${key}|{v}` : `${key}|`);
  const msField = { key: 'defaultYieldMs', ms: true };
  const plainField = { key: 'jobKind' };
  /** 说明行 children → {desc, hasBr, eff, effClass, input, inClass}（结构读数，非字符串比对）。 */
  const shapeOf = (children) => {
    const list = Array.isArray(children) ? children : [children];
    const spans = list.filter((child) => child !== null && typeof child === 'object' && child.type === 'span');
    // 本用例的 createElement 替身把 children 放在元素顶层（T18 的 shim 放进 props——两处读法兼容）。
    const kidsOf = (node) => node.children ?? node.props.children;
    const textOf = (span) => {
      const kids = kidsOf(span);
      return Array.isArray(kids) ? kids.join('') : String(kids);
    };
    return {
      desc: String(list[0]),
      hasBr: list.some((child) => child !== null && typeof child === 'object' && child.type === 'br'),
      dot: list[3],
      eff: spans[0] === undefined ? undefined : textOf(spans[0]),
      effClass: spans[0] === undefined ? '' : String(spans[0].props.className),
      input: spans[1] === undefined ? undefined : textOf(spans[1]),
      inClass: spans[1] === undefined ? '' : String(spans[1].props.className)
    };
  };
  assert.equal(product.composeHint(tt, plainField, 20000, 'my-kind'),
    'hint.jobKind|', '非毫秒字段不得有任何读数段');
  let shape = shapeOf(product.composeHint(tt, msField, 20000, '20000'));
  assert.ok(shape.desc === 'hint.defaultYieldMs|' && shape.hasBr && shape.dot === ' · ',
    '毫秒字段的说明行 = 字段说明 + 换行 + 两段读数（行首不带点，与字段说明分行）');
  assert.equal(shape.eff, 'readout.effective|20 s', '生效段 = 标签 + 秒文本（无毫秒、无等号）');
  assert.equal(shape.input, 'readout.input|20 s', '无草稿时输入段也在场（两段相等也不隐藏）');
  assert.ok(!shape.inClass.includes('ats-sec-invalid'), '合法草稿不得带非法标记');
  shape = shapeOf(product.composeHint(tt, msField, 500, '04321'));
  assert.equal(shape.eff, 'readout.effective|0.5 s');
  assert.equal(shape.input, 'readout.input|4.32 s', '输入段取解析值的换算（04321 → 4.32 s），未保存就反映键入');
  shape = shapeOf(product.composeHint(tt, msField, 500, '4'));
  assert.equal(shape.eff, 'readout.effective|0.5 s', '生效段不动');
  assert.equal(shape.input, 'readout.input|< 0.01 s', '逐位键入的中间态给亚 10 ms 读数（不得 0 s、不得消失）');
  shape = shapeOf(product.composeHint(tt, msField, 500, ''));
  assert.equal(shape.eff, 'readout.effective|0.5 s', '空草稿：生效段仍在');
  assert.equal(shape.input, 'readout.input|—', '空文本 → 输入段 — 占位（不残留旧读数、不给秒数）');
  assert.ok(!shape.inClass.includes('ats-sec-invalid'), '空草稿不是非法（清除覆盖的意图），不得标红');
  shape = shapeOf(product.composeHint(tt, msField, 500, '  '));
  assert.equal(shape.input, 'readout.input|—', '纯空白等同空文本（按 trim 后判空）');
  for (const bad of ['abc', '0', '-3']) {
    shape = shapeOf(product.composeHint(tt, msField, 500, bad));
    assert.equal(shape.input, 'readout.input|—', `${bad} → 输入段 — 占位`);
    assert.ok(shape.inClass.includes('ats-sec-invalid'), `${bad} → 输入段带非法标记（颜色侧走 state-error）`);
    assert.equal(shape.eff, 'readout.effective|0.5 s', `${bad} → 生效段仍在`);
  }
  assert.deepEqual(product.draftReadout('4321'), { fill: '4.32 s', invalid: false }, 'draftReadout：正数 → 秒文本');
  assert.deepEqual(product.draftReadout(''), { fill: '—', invalid: false }, 'draftReadout：空 → — 不标非法');
  assert.deepEqual(product.draftReadout('abc'), { fill: '—', invalid: true }, 'draftReadout：非数字 → — 标非法');
  assert.equal(product.ENTRY, 'async-tools-host', 'ENTRY 导出必须等于宿主行 id（三同串）');

  // ④ 槽位注册的**运行期**判据：静态 grep 只能证明"源码里出现过某个词"，
  //    证明不了"注册真的发生、键真的等于包名、绑定的是本包词典"。这一条同时就是
  //    可推翻对照：删掉卡片注册 → registrations 为空；改错槽键 → 键比对变红。
  const registrations = [];
  const fakeCtx = {
    locale: { register: function () { return function () {}; } },
    configForms: {
      whileServed: function (ids, load) { return load(); },
      get: function () {
        return { getSnapshot: () => ({ status: 'ready', value: {}, user: {} }), subscribe: () => () => {}, mutate: async () => true };
      }
    },
    // ask 接线的两个 effect 需要 remote（$mount 挂命名空间）与 uiWorkspace（跳转动作）。
    remote: { $mount: function () { return Promise.resolve(function () {}); } },
    uiWorkspace: { openSession: function () {} },
    // ask 座位在 $mount 生效后经**动态** ctx.inject(['remote.async-tools-ask'])
    // 装配（自 mount 命名空间的取用口径——不能直接读 ctx.remote 下标）；注入即回调。
    inject: function (list, fn) { fn({ remote: { 'async-tools-ask': {} } }); },
    slots: {
      inject: function (slotName, load) { return load(); },
      register: function (options, Component) { registrations.push({ options: options, Component: Component }); }
    },
    effect: function (fn) { return fn(); }
  };
  product.apply(fakeCtx);
  // ask 座位在 $mount promise 的微任务之后注册（真机同款顺序）——冲两拍微任务再数。
  await Promise.resolve();
  await Promise.resolve();
  // apply() 注册**三**个座位：设置卡 + ask overlay + ask sidebar（后两个默认关——
  // 计数 0 时组件渲染 null，注册本身在场是零行为口径的一部分：渲染 null = 无行为）。
  assert.equal(registrations.length, 3, 'apply() 注册一张设置卡 + 两个 ask 座位');
  const registered = registrations[0].options;
  assert.equal(registered.name, 'plugins.bundle.config', '槽位名必须是 plugins.bundle.config（bundle 页槽）');
  assert.equal(registered.key, 'dsh-async-tools', 'bundle 槽的键必须是被配置的包名');
  assert.equal(registered.key, product.PACKAGE_NAME, '槽键必须等于包名常量（不是 `<包名>#<行 id>`）');
  assert.equal(product.SLOT_NAME, 'plugins.bundle.config', 'SLOT_NAME 导出必须与注册的槽一致');
  assert.equal(registered.locale, 'settings.async-tools', '卡片必须绑本插件的词典命名空间');
  assert.equal(typeof registrations[0].Component, 'function', '注册的必须是卡片组件');
  assert.equal(registrations[1].options.name, 'shell.overlay', 'ask overlay 座位 = shell.overlay（/G2：ui-layout 声明）');
  assert.equal(registrations[1].options.id, 'async-tools-ask', 'ask overlay 座位 id 固定');
  assert.equal(registrations[2].options.name, 'sidebar.footer.action', 'ask sidebar 座位 = sidebar.footer.action');
  assert.equal(typeof registrations[1].Component, 'function', 'overlay 座位注册的是组件');
  assert.equal(typeof registrations[2].Component, 'function', 'sidebar 座位注册的是组件');
});

/**
 * 最小 React 替身：实现卡片与表单组件用到的 `createElement` / `useState` / `useEffect`
 * / `useRef` / `useSyncExternalStore`（`useSyncExternalStore` 订阅模型的快照存储，
 * `useRef` 承载卡片模型句柄与官方表单的卸载丢弃）。
 *
 * 为什么需要它：`page` 视图的值来自 `ctx.configForms.get(ns)` 的控制器（bundle 槽**不传**
 * `form`），静态断言最多只能说"源码里没有 `props.form` 这个词"，说不出"用控制器
 * 渲染真的出全部字段、保存真的走 mutate"。而组件真去读 `props.form` 时不抛错——
 * 它只是渲染出一张空卡，本机测试若不渲染就看不见。
 *
 * **hook 存储按组件函数＋元素 key 分槽**：卡片组件自己也有 hook（模型句柄、订阅、
 * 卸载清理），与表单组件共用一个游标会互相踩（两个组件的 `hooks[0]` 互相覆盖）；
 * 而 17 个字段壳是**同一个组件函数的 17 个实例**，只按函数分槽会让它们的
 * `helpOpen` 互踩（点一个字段的开全部字段的）——真实 React 按「组件类型＋元素
 * key」复用 fiber 局部状态，替身照抄这条语义（`begin(component, key)`；无 key
 * 的组件归入 `''` 槽）。
 *
 * `useSyncExternalStore(subscribe, getSnapshot)`：订阅一次（存 disposer），快照由监听器
 * 就地刷新——重渲染由测试显式驱动（renderCard 再调一次组件函数）。
 *
 * @returns {{react: object, begin: Function, flush: Function, unmount: Function}} 替身与驱动。
 */
function makeReactShim() {
  // 外层 = 组件函数 → 内层 = 元素 key → hook 槽数组（同一函数的多个实例各拿各的
  // 局部状态；无 key 的组件归入 `''` 槽——单实例组件本来就不互踩）。
  const stores = new Map();
  let current = null;
  let store = [];
  let cursor = 0;
  let queued = [];
  return {
    react: {
      createElement(type, props, ...children) {
        const merged = Object.assign({}, props ?? {});
        if (children.length === 1) merged.children = children[0];
        else if (children.length > 1) merged.children = children;
        return { type, props: merged };
      },
      useState(initial) {
        const index = cursor;
        cursor += 1;
        // 捕获**本次渲染所属组件**的 hook 槽：setter 在渲染之后才被调用（事件、effect、
        // 订阅回调），那时 `store` 早已指向另一个组件——不捕获就会把状态写进别人的槽
        // （真实 React 的 setter 绑定它自己那个 fiber，这里照抄这条语义）。
        const own = store;
        if (!(index in own)) own[index] = typeof initial === 'function' ? initial() : initial;
        return [own[index], (next) => {
          own[index] = typeof next === 'function' ? next(own[index]) : next;
        }];
      },
      useEffect(effect, deps) {
        const index = cursor;
        cursor += 1;
        const own = store;
        const previous = own[index];
        // 照抄 React 的 deps 语义：传了 deps 且与上次浅相等就跳过。没有这条，"每次渲染都重新订阅"
        // 这类泄漏在替身里完全不可见。
        if (Array.isArray(deps) && previous !== undefined && Array.isArray(previous.deps)
          && previous.deps.length === deps.length
          && previous.deps.every((value, i) => Object.is(value, deps[i]))) {
          return;
        }
        own[index] = { deps: Array.isArray(deps) ? [...deps] : undefined, cleanup: previous?.cleanup };
        queued.push(() => {
          if (typeof own[index].cleanup === 'function') own[index].cleanup();
          const cleanup = effect();
          own[index].cleanup = typeof cleanup === 'function' ? cleanup : undefined;
        });
      },
      useRef(initial) {
        const index = cursor;
        cursor += 1;
        const own = store;
        if (!(index in own)) own[index] = { current: typeof initial === 'function' ? initial() : initial };
        return own[index];
      },
      useSyncExternalStore(subscribe, getSnapshot) {
        const index = cursor;
        cursor += 1;
        const own = store;
        if (!(index in own)) {
          own[index] = { snapshot: getSnapshot(), disposer: undefined };
          own[index].disposer = subscribe(() => { own[index].snapshot = getSnapshot(); });
        }
        return own[index].snapshot;
      }
    },
    begin(component, key) {
      cursor = 0;
      queued = [];
      current = component;
      if (!stores.has(component)) stores.set(component, new Map());
      const byKey = stores.get(component);
      const slotKey = String(key ?? '');
      if (!byKey.has(slotKey)) byKey.set(slotKey, []);
      store = byKey.get(slotKey);
    },
    flush() { const run = queued; queued = []; for (const effect of run) effect(); },
    // 卸载：跑**所有**已挂载组件（含同函数多实例）的 effect cleanup（含官方表单的
    // 卸载丢弃）并解订阅，销毁 hook 状态——下一次 begin 同名组件等于一次全新挂载
    // （真 React 的卸载语义）。
    unmount() {
      for (const byKey of stores.values()) {
        for (const slots of byKey.values()) {
          for (const slot of slots) {
            if (slot && typeof slot.cleanup === 'function') slot.cleanup();
            if (slot && typeof slot.disposer === 'function') slot.disposer();
          }
        }
      }
      stores.clear();
      store = [];
    }
  };
}

/** 深度优先找第一个满足判据的节点。 */
function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (predicate(node)) return node;
  return findNode(node.props?.children, predicate);
}

/** 收集树里所有 `input` 节点。 */
function collectInputs(node, out = []) {
  return collectByType(node, 'input', out);
}

/** 收集树里所有指定类型的节点（`input` / `select` / `button` …）。 */
function collectByType(node, type, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectByType(child, type, out);
    return out;
  }
  if (node.type === type) out.push(node);
  collectByType(node.props?.children, type, out);
  return out;
}

/** 把树里的文本拼成一个串（断言通告文案用）。 */
function textOf(node, out = []) {
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  textOf(node.props?.children, out);
  return out;
}

test('T18（R24/R27）：官方表单形态——字段集合/说明行/准入控制/失败态/恢复默认/卸载丢弃', async () => {
  const { react, begin, flush, unmount } = makeReactShim();
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const double = makePrimitivesDouble(react);
  const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
  let loaded;
  new Function('window', source)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? react : double));

  // 控制器替身：真实形态是 `ctx.configForms.get(<entryId>)` 返回的 `ConfigFormController`
  // （`getSnapshot` / `subscribe` / `mutate`）。假件必须给**完整** SettingsFormScope
  // ——模型构造时就 subscribe（T9 ② 验过缺成员会抛错）。value 层给**全字段**（真机的
  // schema-resolved section 总是全字段——毫秒说明行的读数才有东西可换算）。
  const DEFAULTS = {
    defaultYieldMs: 20000, minYieldMs: 1000, maxYieldMs: 600000,
    defaultWaitMs: 30000, minWaitMs: 250, maxWaitMs: 600000,
    pollIntervalMs: 500, maxResultChars: 30000,
    jobKind: 'async-command', subagentProvider: '', uiLang: 'auto', agentLang: 'en',
    silentFailureGuard: false,
    askTakeover: false, askTimeoutMs: 60000, askExtendMs: 60000, askUiSeat: 'sidebar'
  };
  const snapshot = (revision, user, overrides) => ({
    status: 'ready',
    value: { ...DEFAULTS, ...overrides },
    base: {},
    user,
    revision,
    writable: true,
    mode: 'host'
  });
  let current = snapshot(7, {});
  const listeners = [];
  const mutateCalls = [];
  let mutateOk = true;
  const controller = {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    mutate: async (ops, rev) => { mutateCalls.push({ ops, rev }); return mutateOk; }
  };
  const asked = [];
  const registrations = [];
  product.apply({
    locale: { register: () => () => {} },
    configForms: {
      whileServed: (ids, load) => load(),
      get: (id) => { asked.push(id); return controller; }
    },
    // ask 接线需要 remote（$mount）与 uiWorkspace（跳转动作，惰性调用）。
    remote: { $mount: () => Promise.resolve(() => {}) },
    uiWorkspace: { openSession: () => {} },
    // ask 座位经 $mount 后的动态 ctx.inject 装配（注入即回调）。
    inject: (list, fn) => fn({ remote: { 'async-tools-ask': {} } }),
    slots: {
      inject: (slotName, load) => load(),
      register: (options, Component) => { registrations.push(Component); }
    },
    effect: (fn) => fn()
  });
  // ask 模型在 $mount promise 的微任务之后取控制器——冲两拍再数。
  await Promise.resolve();
  await Promise.resolve();
  const Card = registrations[0];
  // 测试词典约定：键 + '|'；读数键带 `{v}` 占位（实现用 replace 填值——没有占位的桩
  // 会让"值没填进去"漏过）。真机上 props.t 是宿主翻译函数，语义相同。
  const t = (key) => (key === 'readout.effective' || key === 'readout.input' ? `${key}|{v}` : `${key}|`);

  // 全树展开：卡片 → 官方 SettingsForm → 全部字段组件（值字段/枚举字段/开关/徽标）都是
  // 函数组件，逐个展开（每个组件调 begin 切自己的 hook 槽、调 flush 跑它排的 effect）。
  const expand = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === 'function') {
      const component = node.type;
      begin(component, node.props?.key);
      const rendered = component(node.props ?? {});
      flush();
      return expand(rendered);
    }
    const children = node.props?.children;
    if (children !== undefined) {
      const expanded = expand(children);
      if (expanded !== children) return { ...node, props: { ...node.props, children: expanded } };
    }
    return node;
  };
  const renderCard = () => expand({ type: Card, props: { view: 'page', t } });
  /** 换新快照并触发控制器的订阅者（真机上由控制器的 store 派发，模型据此重投影）。 */
  const replace = (next) => { current = next; for (const listener of listeners) listener(); };
  const buttonByLabel = (tree, label) =>
    findNode(tree, (node) => node.type === 'button' && textOf(node).join('') === label);
  const inputById = (tree, id) =>
    findNode(tree, (node) => (node.type === 'input' || node.type === 'select') && node.props.id === id);

  // ① 渲染本身：**props 里没有 `form`**（bundle 槽不传）。值必须来自控制器。
  //    判据 1：四组全部字段逐项在场，id = `plugin-config-<键>`。
  let tree = renderCard();
  // `configForms.get` 被调**两次**：ask 模型在 apply 期取一次（待答界面），
  // 卡片模型在挂载期取一次——两次都必须按 entry id（不是按包名）。
  assert.deepEqual(asked, ['async-tools-host', 'async-tools-host'], 'ask 模型与卡片都必须按 entry id 向 configForms 取控制器（不是按包名）');
  assert.equal(listeners.length, 2, '卡片模型与 ask 模型各订阅控制器恰好一次（bind 一次 + 订阅一次）');
  const inputs = collectByType(tree, 'input');
  const selects = collectByType(tree, 'select');
  // 12 个值字段（10 预算 + askTimeoutMs + askExtendMs）、3 个枚举下拉
  // （两语言 + askUiSeat）。
  assert.equal(inputs.length, 12, '十二个值字段必须以官方 input 在场（10 预算 + R30 askTimeoutMs + askExtendMs）');
  assert.equal(selects.length, 3, '三个枚举字段必须以 select 在场（两语言 + R30 askUiSeat；控件本体自绘，裁决 B）');
  // 两个布尔开关（静默失败防护 + 提问接管）：控件本体是官方 Switch（可见标签长在壳上），
  // 不进 input/select 的 id 清单——按无障碍属性（role/aria-label/aria-checked）钉在场。
  const switchButtons = collectByType(tree, 'button').filter((node) => node.props.role === 'switch');
  assert.equal(switchButtons.length, 2, 'silentFailureGuard 与 askTakeover 必须以 role=switch 的按钮在场');
  assert.equal(switchButtons[0].props['aria-label'], 'silentFailureGuard|',
    '开关的无障碍名 = 可见标签（桩词典约定键 + \'|\'）');
  assert.equal(switchButtons[0].props['aria-checked'], false, '默认关：无覆盖时开关显示生效姿态 false');
  assert.equal(switchButtons[1].props['aria-label'], 'askTakeover|',
    'R30 总开关同形：无障碍名 = 可见标签');
  assert.equal(switchButtons[1].props['aria-checked'], false, 'R30 总开关默认关（零行为硬边界的界面证据）');
  // 开关字段的说明行与值/枚举字段同形（p + id），文案走同一条 hint 通道——在此钉住，
  // 补足 ② 循环豁免后的结构覆盖。
  const flagMessage = findNode(tree, (node) =>
    node.type === 'p' && node.props.id === 'plugin-config-silentFailureGuard-message');
  assert.ok(flagMessage !== undefined, '开关字段必须有说明行（判据 2 的结构同形）');
  assert.ok(String(flagMessage.props.children).includes('hint.silentFailureGuard|'),
    '开关说明行必须带该字段的说明文案');
  const expectedKeys = product.FIELDS.map((field) => field.key);
  // askTimeoutMs（input）排在语言枚举（select）之后，DOM 收集是「全部 input
  // 再全部 select」——分型别各自按 FIELDS 顺序核对，不拼交错序。
  const expectedInputKeys = product.FIELDS
    .filter((field) => field.options === undefined && field.flag !== true).map((field) => field.key);
  const expectedSelectKeys = product.FIELDS
    .filter((field) => field.options !== undefined).map((field) => field.key);
  assert.deepEqual(inputs.map((node) => node.props.id),
    expectedInputKeys.map((key) => `plugin-config-${key}`),
    '值字段身份必须按 id 逐项核对（判据 1，FIELDS 顺序）');
  assert.deepEqual(selects.map((node) => node.props.id),
    expectedSelectKeys.map((key) => `plugin-config-${key}`),
    '枚举字段身份必须按 id 逐项核对（判据 1，FIELDS 顺序）');
  assert.deepEqual(selects.map((node) => node.props.children.map((option) => option.props.value)),
    [['auto', 'zh', 'en'], ['en', 'zh'], ['sidebar', 'overlay']], '选项集就是契约（写错值宿主会 fail-fast；askUiSeat 选项序 [sidebar, overlay]——需求 §5.2/5.5，默认标记位在 sidebar）');
  assert.equal(inputById(tree, 'plugin-config-uiLang').props.value, 'auto',
    '无覆盖时下拉显示生效值（不是空选项——下拉为空等于丢掉当前生效值，硬条目①）');
  assert.equal(inputById(tree, 'plugin-config-askUiSeat').props.value, 'sidebar',
    'askUiSeat 无覆盖时下拉显示生效值 sidebar（需求 §5.2：默认值即 sidebar）');

  // ② label↔id 绑定 + 说明行（判据 2 的结构；0.5px 分隔线是计算样式，真机探针验）。
  // 布尔开关不进此循环：可见标签是壳上的 div + Switch 的 aria-label（偏离 ③；client.js
  // FlagField 头注——Switch 不收 id/aria-* 摆位，for 绑定与 aria-describedby 不适用），
  // 其说明行由上面 ① 段的 flagMessage 断言单独钉住。
  for (const key of expectedKeys.filter((k) => k !== 'silentFailureGuard' && k !== 'askTakeover')) {
    const control = inputById(tree, `plugin-config-${key}`);
    const label = findNode(tree, (node) =>
      node.type === 'label' && node.props.htmlFor === `plugin-config-${key}`);
    assert.ok(label !== undefined, `字段 ${key} 的 label 必须以 for=<id> 绑定控件`);
    const message = findNode(tree, (node) => node.type === 'p' && node.props.id === `plugin-config-${key}-message`);
    assert.ok(message !== undefined, `字段 ${key} 必须有说明/错误行（aria-describedby 的指向）`);
    assert.ok(String(message.props.children).includes(`hint.${key}|`),
      `字段 ${key} 的说明行必须带该字段的说明文案`);
    assert.equal(control.props['aria-describedby'], `plugin-config-${key}-message`,
      `字段 ${key} 的控件必须以 aria-describedby 指向说明行（同形硬条目②）`);
  }
  // 毫秒字段的说明行带**两段**读数（决定 D / 判据 10 / 用户决定）：字段说明
  // **换行**接 `生效：{v} · 输入：{v}`——行首不带点、值只写秒文本（毫秒原值输入框里
  // 本来就有）。结构读数（不是字符串拼比对）：desc / 换行 / 两段 span 的文本与类名。
  const messageNode = (aTree, key) => findNode(aTree,
    (node) => node.type === 'p' && node.props.id === `plugin-config-${key}-message`);
  const readoutOf = (aTree, key) => {
    const message = messageNode(aTree, key);
    const children = Array.isArray(message.props.children) ? message.props.children : [message.props.children];
    const spans = children.filter((child) => child !== null && typeof child === 'object' && child.type === 'span');
    const textOf = (span) => Array.isArray(span.props.children) ? span.props.children.join('') : String(span.props.children);
    return {
      line: children.map((child) => (child !== null && typeof child === 'object'
        ? (child.type === 'br' ? '\n' : textOf(child))
        : String(child ?? ''))).join(''),
      desc: String(children[0]),
      hasBr: children.some((child) => child !== null && typeof child === 'object' && child.type === 'br'),
      eff: spans[0] === undefined ? undefined : textOf(spans[0]),
      input: spans[1] === undefined ? undefined : textOf(spans[1]),
      inClass: spans[1] === undefined ? '' : String(spans[1].props.className)
    };
  };
  const msKeys = product.FIELDS.filter((field) => field.ms).map((field) => field.key);
  for (const key of msKeys) {
    const readout = readoutOf(tree, key);
    assert.ok(readout.desc.startsWith(`hint.${key}|`), `毫秒字段 ${key} 的说明行第一行必须是字段说明`);
    assert.ok(readout.hasBr, `毫秒字段 ${key} 的读数必须与字段说明换行（行首不带点）`);
    assert.match(String(readout.eff), /^readout\.effective\|[\d.]+ s$/,
      `毫秒字段 ${key} 的生效段 = 标签 + 秒文本（恒显示）`);
    assert.match(String(readout.input), /^readout\.input\|[\d.]+ s$/,
      `毫秒字段 ${key} 无草稿时输入段也在场（两段相等也不隐藏）`);
  }
  const poll = () => readoutOf(tree, 'pollIntervalMs');
  assert.equal(poll().eff, 'readout.effective|0.5 s', 'defaultYieldMs=20000 之外：生效段 = 生效值换算（500 → 0.5 s）');
  for (const key of ['maxResultChars', 'jobKind', 'uiLang']) {
    assert.equal(messageNode(tree, key).props.children, `hint.${key}|`,
      `非毫秒字段 ${key} 的说明行不得带任何读数段（连 children 都还是纯字符串）`);
  }

  // ②-b 输入段实时（判据 10 的核心）：**不保存**、只在输入框键入 → 输入段当场变；
  //     逐位键入的中间态（4）给亚 10 ms 读数；非法/非正数 → — 占位 + 非法标记
  //     （说明行仍显示时；数字字段的非法态整行换成 invalidLabel 见 ④）；清空 = — 占位。
  //     （真机对应探针：`verify/_visual/probe-r24-bundle-config.mjs` 的两段读数断言。）
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: '4' } });
  tree = renderCard();
  assert.equal(poll().eff, 'readout.effective|0.5 s', '键入 4（未保存）：生效段不动');
  assert.equal(poll().input, 'readout.input|< 0.01 s',
    '键入 4（未保存）：输入段当场 = 亚 10 ms 读数（不得 0 s），读数接的是草稿');
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: '04321' } });
  tree = renderCard();
  assert.equal(poll().input, 'readout.input|4.32 s', '键入 04321：输入段显示解析值的换算（不是生效值）');
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: 'not-a-number' } });
  tree = renderCard();
  // 契约（需求 §5.4／§5.6）：非法原因行（-invalid）是**附加**，常驻说明行（-message）
  // 与双读数不被顶掉——非数字草稿的输入段给 — 占位并标红，生效段照常。
  const invalidLineOf = (aTree, key) => findNode(aTree,
    (node) => node.type === 'p' && node.props.id === `plugin-config-${key}-invalid`);
  assert.equal(String(invalidLineOf(tree, 'pollIntervalMs')?.props.children), 'invalidNumber|',
    '非数字 → 原因行（-invalid）= invalidNumber 档');
  assert.equal(poll().eff, 'readout.effective|0.5 s', '非法态常驻行的生效段照常显示（不被原因行顶掉）');
  assert.equal(poll().input, 'readout.input|—', '非法草稿的输入段给 — 占位（不给误导性秒数）');
  assert.ok(poll().inClass.includes('ats-sec-invalid'), '非法草稿的输入段标红');
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: '0' } });
  tree = renderCard();
  // FIELD_MIN 进 parse（§5.4 下界补齐）后：'0' 可解析但低于下界 1 → 官方非法通道
  // 的 belowRange 档走原因行（保存经 state.invalid 禁用），常驻读数同形保留。
  assert.equal(String(invalidLineOf(tree, 'pollIntervalMs')?.props.children), 'invalidBelow|',
    '0（可解析、低于下界 1）：belowRange 档走原因行（min 在 parse 里拦）');
  assert.equal(poll().eff, 'readout.effective|0.5 s', '下界非法态常驻行的生效段照常显示');
  assert.equal(poll().input, 'readout.input|—', '下界非法草稿的输入段同样给 — 占位');
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: '' } });
  tree = renderCard();
  assert.equal(poll().input, 'readout.input|—', '清空 → 输入段 — 占位');
  assert.ok(!poll().inClass.includes('ats-sec-invalid'), '清空不是非法（清除覆盖的意图），不得标红');
  assert.ok(invalidLineOf(tree, 'pollIntervalMs') === undefined, '回到合法态：原因行退场');
  // 收尾：改回生效值（stage 清掉非法态与草稿），后续用例从干净状态出发。
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: '500' } });
  tree = renderCard();

  // ③ 保存按钮启用条件与往返（判据 5/8）：无改动 ⇒ 保存禁用；改动 ⇒ 恰一次 mutate。
  assert.equal(buttonByLabel(tree, 'save|').props.disabled, true, '无改动时保存必须禁用（!dirty）');
  inputById(tree, 'plugin-config-jobKind').props.onChange({ target: { value: 'my-kind' } });
  tree = renderCard();
  assert.equal(buttonByLabel(tree, 'save|').props.disabled, false, '有改动时保存可用');
  await buttonByLabel(tree, 'save|').props.onClick();
  assert.equal(mutateCalls.length, 1, '保存必须恰一次 mutate（判据 8）');
  assert.deepEqual(mutateCalls[0].ops, [{ op: 'set', path: ['jobKind'], value: 'my-kind' }],
    '保存必须只发用户真的改过的字段（模型只遍历被暂存的字段）');
  assert.equal(mutateCalls[0].rev, 7, '写入必须带暂存开始时的 revision（revision 栅栏）');
  // 成功：快照换新（宿主写进新值）⇒ 字段回到生效值、按钮重新禁用（成功不弹文案）。
  replace(snapshot(8, { jobKind: 'my-kind' }, { jobKind: 'my-kind' }));
  tree = renderCard();
  assert.equal(inputById(tree, 'plugin-config-jobKind').props.value, 'my-kind',
    '成功后字段由活 section 值回填（回到生效值——谎报成功没有藏身处）');
  assert.equal(buttonByLabel(tree, 'save|').props.disabled, true, '成功后草稿清空 ⇒ 无改动禁用');

  // ④ 非法草稿（判据 4）：数字字段填非数字 → 保存禁用 + aria-invalid + 错误文案。
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: 'not-a-number' } });
  tree = renderCard();
  const badInput = inputById(tree, 'plugin-config-pollIntervalMs');
  assert.equal(buttonByLabel(tree, 'save|').props.disabled, true, '非法草稿必须挡下保存（!invalid）');
  assert.equal(badInput.props['aria-invalid'], true, '非法草稿的控件必须带 aria-invalid');
  assert.match(String(findNode(tree, (node) => node.type === 'p' && node.props.id === 'plugin-config-pollIntervalMs-invalid').props.children),
    /invalidNumber\|/, '非法原因行（-invalid）必须给出原因文案');
  assert.equal(poll().eff, 'readout.effective|0.5 s',
    '非法态常驻说明行（-message）不得被原因行顶掉——生效段仍在（需求 §5.4 回归钉）');
  assert.equal(poll().input, 'readout.input|—', '非法态常驻行的输入段照常给 — 占位');
  assert.equal(badInput.props['aria-describedby'],
    'plugin-config-pollIntervalMs-invalid plugin-config-pollIntervalMs-message',
    '非法态 aria-describedby 先指原因行、仍并指常驻说明行');
  // 丢弃非法草稿（改回合法值）恢复可用。
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: '4321' } });
  tree = renderCard();
  assert.equal(buttonByLabel(tree, 'save|').props.disabled, false, '草稿回到合法值后保存必须恢复可用');

  // ⑤ 失败路径（判据 6）：宿主拒绝（mutate 回 false）→ 页脚失败文案 + 草稿保留。
  mutateOk = false;
  await buttonByLabel(tree, 'save|').props.onClick();
  tree = renderCard();
  assert.equal(mutateCalls.length, 2, '失败的保存也是一次 mutate（驱动必须真的走到保存路径）');
  assert.ok(textOf(tree).join('').includes('saveFailed|'), '页脚必须出现官方失败文案（.failed 行）');
  assert.equal(inputById(tree, 'plugin-config-pollIntervalMs').props.value, '4321',
    '失败的保存必须保留草稿（使用者改得动而不是重打）');
  // 草稿回到合法的新值再保存（宿主这次接受）：失败文案必须退场。
  mutateOk = true;
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: '600' } });
  tree = renderCard();
  assert.ok(!textOf(tree).join('').includes('saveFailed|'), '新的暂存必须清掉 failed 态（stage 清 failed）');
  await buttonByLabel(tree, 'save|').props.onClick();
  assert.equal(mutateCalls.length, 3, '第三次保存也是恰一次 mutate');
  replace(snapshot(9, { pollIntervalMs: 600 }, { pollIntervalMs: 600, jobKind: 'my-kind' }));
  tree = renderCard();
  assert.ok(!textOf(tree).join('').includes('saveFailed|'), '成功路径不得再显示失败文案');
  assert.equal(inputById(tree, 'plugin-config-pollIntervalMs').props.value, '600',
    '成功后字段由活 section 值回填');

  // ⑥ 覆盖徽标与「恢复默认」（判据 3）：user 层在场 ⇒ Tag + 恢复按钮；点击只暂存。
  //    本相位的 user 层只有 jobKind 一个键，所以"全树恰一枚徽标/恰一个恢复按钮"
  //    就是按身份定位（多一枚就是别的字段冒出了覆盖态）。
  replace(snapshot(10, { jobKind: 'external-kind' }, { pollIntervalMs: 600, jobKind: 'external-kind' }));
  tree = renderCard();
  const jobKindField = findNode(tree, (node) => node.type === 'label' && node.props.htmlFor === 'plugin-config-jobKind');
  assert.ok(jobKindField !== undefined, 'jobKind 的 label 必须仍以 for=<id> 绑定（覆盖态不破坏结构）');
  const badges = collectByType(tree, 'span').filter((node) => node.props['data-tone'] === 'neutral');
  assert.deepEqual(badges.map((node) => textOf(node).join('')), ['overridden|'],
    '覆盖态必须显示官方 Tag 徽标（tone=neutral；且 user 层只有 jobKind ⇒ 恰一枚）');
  const resetButtons = collectByType(tree, 'button').filter((node) => textOf(node).join('') === 'reset|');
  assert.equal(resetButtons.length, 1, '覆盖态必须有且只有 jobKind 的「恢复默认」按钮');
  const resetButton = resetButtons[0];
  const beforeReset = mutateCalls.length;
  resetButton.props.onClick();
  tree = renderCard();
  assert.equal(mutateCalls.length, beforeReset, '恢复默认只暂存，不得直接发写（判据 3 保存前半）');
  await buttonByLabel(tree, 'save|').props.onClick();
  const lastCall = mutateCalls[mutateCalls.length - 1];
  assert.deepEqual(lastCall.ops, [{ op: 'unset', path: ['jobKind'] }],
    '保存把「恢复默认」做成 unset op（清除用户层覆盖）');

  // ⑦ 卸载丢弃（判据 9）：① 接线侧——SettingsForm 收到的 onDiscard 必须真的是模型的
  //    discard（清得掉暂存；换成 noop 这条就红）；② 观察侧——改字段不保存 → 卸载 →
  //    重新挂载后字段回到生效值、不再 dirty。
  replace(snapshot(11, { pollIntervalMs: 600 }, { pollIntervalMs: 600, jobKind: 'settled' }));
  tree = renderCard();
  inputById(tree, 'plugin-config-jobKind').props.onChange({ target: { value: 'unsaved-draft' } });
  tree = renderCard();
  assert.equal(buttonByLabel(tree, 'save|').props.disabled, false, '丢弃前必须有暂存（驱动必须真的改过）');
  // 只展开卡片一层，拿 SettingsForm 元素上的 onDiscard（官方表单卸载时调的就是它）。
  begin(Card);
  const formElement = Card({ view: 'page', t });
  flush();
  const onDiscard = formElement.props.onDiscard;
  assert.equal(typeof onDiscard, 'function', 'SettingsForm 必须接到 onDiscard（卸载丢弃的接线）');
  onDiscard();
  tree = renderCard();
  assert.equal(inputById(tree, 'plugin-config-jobKind').props.value, 'settled',
    '接线的 onDiscard 必须真的清得掉暂存（noop 接线这条就红）');
  assert.equal(buttonByLabel(tree, 'save|').props.disabled, true, '丢弃后无改动');
  // 观察侧：再次暂存 → 整树卸载 → 重新挂载。
  inputById(tree, 'plugin-config-jobKind').props.onChange({ target: { value: 'left-behind' } });
  tree = renderCard();
  assert.equal(buttonByLabel(tree, 'save|').props.disabled, false, '卸载前必须有暂存');
  unmount();
  tree = renderCard();
  assert.equal(inputById(tree, 'plugin-config-jobKind').props.value, 'settled',
    '卸载（离开页面）必须丢弃草稿——字段回到生效值，不保存就不留痕');
  assert.equal(buttonByLabel(tree, 'save|').props.disabled, true, '重新挂载后无改动');

  // ⑦-b 只读态（判据 11）：部署只读 → 控件禁用、只读提示在场，**两段读数仍在位**
  //     （读数不是控件，禁用它没有理由；隐藏会让"值是多少"在只读部署里不可见）。
  replace(snapshot(12, {}, { pollIntervalMs: 600 }));
  const savedSnapshot = current;
  current = { ...savedSnapshot, writable: false };
  for (const listener of listeners) listener();
  tree = renderCard();
  assert.ok(inputById(tree, 'plugin-config-jobKind').props.disabled === true
    || inputById(tree, 'plugin-config-jobKind').props.readOnly === true,
    '只读部署下控件必须禁用');
  assert.ok(textOf(tree).join('').includes('readOnly|'), '只读态必须显示官方只读提示（labels.readOnly）');
  const ro = readoutOf(tree, 'defaultYieldMs');
  assert.equal(ro.eff, 'readout.effective|20 s',
    '只读态两段读数必须仍在位（判据 11：读数不随 writable 消失）');
  assert.equal(ro.input, 'readout.input|20 s', '只读态输入段仍在位（= 生效值，无草稿可言）');
  assert.ok(ro.hasBr, '只读态读数仍与字段说明换行');
  current = savedSnapshot;
  for (const listener of listeners) listener();
  tree = renderCard();

  // ⑧ 订阅纪律：挂载时恰好两个 scope 订阅（卡片 + ask 模型），卸载解掉、重挂
  //    再建（不累积）。
  assert.equal(listeners.length, 2,
    '订阅必须只建立一次（卡片与 ask 各一）——每次渲染都重订阅会在真机上累积监听器（泄漏）');
});

test('T18h（R24/R27·设计 §5.5）：字段帮助——问号按钮、开合、无副作用、三态可读、缺键回退', async () => {
  const { react, begin, flush, unmount } = makeReactShim();
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const double = makePrimitivesDouble(react);
  const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
  let loaded;
  new Function('window', source)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? react : double));

  const DEFAULTS = {
    defaultYieldMs: 20000, minYieldMs: 1000, maxYieldMs: 600000,
    defaultWaitMs: 30000, minWaitMs: 250, maxWaitMs: 600000,
    pollIntervalMs: 500, maxResultChars: 30000,
    jobKind: 'async-command', subagentProvider: '', uiLang: 'zh', agentLang: 'en',
    silentFailureGuard: false,
    askTakeover: false, askTimeoutMs: 60000, askExtendMs: 60000, askUiSeat: 'sidebar'
  };
  const snapshot = (revision, user, overrides) => ({
    status: 'ready', value: { ...DEFAULTS, ...overrides }, base: {}, user,
    revision, writable: true, mode: 'host'
  });
  let current = snapshot(7, {});
  let mutateOk = () => new Promise(() => {});
  const listeners = [];
  const mutateCalls = [];
  const controller = {
    getSnapshot: () => current,
    subscribe: (listener) => { listeners.push(listener); return () => {
      const at = listeners.indexOf(listener); if (at >= 0) listeners.splice(at, 1);
    }; },
    mutate: async (ops, rev) => { mutateCalls.push({ ops, rev }); return mutateOk(); }
  };
  const registrations = [];
  product.apply({
    locale: { register: () => () => {} },
    configForms: { whileServed: (ids, load) => load(), get: () => controller },
    remote: { $mount: () => Promise.resolve(() => {}) },
    uiWorkspace: { openSession: () => {} },
    inject: (list, fn) => fn({ remote: { 'async-tools-ask': {} } }),
    slots: { inject: (slotName, load) => load(), register: (options, Component) => { registrations.push(Component); } },
    effect: (fn) => fn()
  });
  await Promise.resolve();
  await Promise.resolve();
  const Card = registrations[0];
  // 真词典（zh）：帮助可访问名、展开正文、说明行全部走产品词典，不落桩词典。
  const t = product.makeTranslator('zh', (key) => key);

  const expand = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === 'function') {
      const component = node.type;
      begin(component, node.props?.key);
      const rendered = component(node.props ?? {});
      flush();
      return expand(rendered);
    }
    const children = node.props?.children;
    if (children !== undefined) {
      const expanded = expand(children);
      if (expanded !== children) return { ...node, props: { ...node.props, children: expanded } };
    }
    return node;
  };
  const renderCard = () => expand({ type: Card, props: { view: 'page', t } });
  const replace = (next) => { current = next; for (const listener of listeners) listener(); };
  const helpButtons = (tree) => collectByType(tree, 'button')
    .filter((node) => node.props.className === 'ats-help-button');
  const regionOf = (tree, key) =>
    findNode(tree, (node) => node.type === 'div' && node.props.role === 'region'
      && node.props.id === `plugin-config-${key}-help`);
  const helpButtonOf = (tree, key) =>
    findNode(tree, (node) => node.type === 'button' && node.props.className === 'ats-help-button'
      && node.props['aria-controls'] === `plugin-config-${key}-help`);

  // ① 17 个字段各有问号按钮（type=button、aria-controls 指向 <id>-help、
  //    aria-label 含字段名称——help.a11yName 模板）。
  let tree = renderCard();
  const buttons = helpButtons(tree);
  assert.equal(buttons.length, 17, '17 个字段必须各有一个帮助按钮（需求 §5.5）');
  for (const button of buttons) {
    assert.equal(button.props.type, 'button', '帮助按钮必须 type=button（不提交表单）');
    assert.ok(typeof button.props['aria-controls'] === 'string'
      && button.props['aria-controls'].endsWith('-help'), 'aria-controls 必须指向帮助区 id');
    assert.equal(button.props['aria-expanded'], false, '初始收起');
    assert.ok(button.props['aria-label'].endsWith(' 的说明'),
      `可访问名必须来自 help.a11yName 模板（实得 ${String(button.props['aria-label'])}）`);
    assert.ok(findNode(button, (node) => node.type === 'svg'
      && node.props['data-icon'] === 'question-outline-regular') !== undefined,
      '按钮图标必须是替身的 IconQuestionOutlineRegular（带圈问号）');
  }
  assert.equal(helpButtonOf(tree, 'defaultYieldMs').props['aria-label'],
    '默认首次等待时长（毫秒） 的说明', '可访问名必须含字段名称（需求 §5.6）');

  // ② 点击展开 region#<id>-help（role=region、分段渲染），再点收起；开合只影响本字段
  //    （替身 hook 槽按组件＋元素 key 分槽——17 个同函数实例互踩时这条必红）。
  helpButtonOf(tree, 'defaultYieldMs').props.onClick();
  tree = renderCard();
  let region = regionOf(tree, 'defaultYieldMs');
  assert.ok(region !== undefined, '点击后必须渲染展开区 div#<id>-help');
  assert.equal(region.props.role, 'region', '展开区必须带 role=region');
  assert.equal(region.props['aria-label'], '默认首次等待时长（毫秒） 的说明',
    '展开区 aria-label 与按钮可访问名同名');
  const paragraphs = (region.props.children || []).filter((child) => child.type === 'p');
  assert.ok(paragraphs.length >= 3, `正文按 \\n\\n 分段渲染（实得 ${String(paragraphs.length)} 段）`);
  const helpText = textOf(region).join('');
  assert.ok(helpText.startsWith('配置键：defaultYieldMs'), '首段必须是技术标识行（设计 §5.6）');
  assert.ok(helpText.includes('直接取得结果') && helpText.includes('先取得作业编号'),
    '首次等待示例必须区分「直接取得结果」与「先取得作业编号」（需求 §5.5 末段）');
  assert.ok(helpText.includes('演示值，非当前生效值'), '示例必须标注「演示值，非当前生效值」');
  assert.equal(helpButtonOf(tree, 'defaultYieldMs').props['aria-expanded'], true, '展开后 aria-expanded=true');
  assert.ok(regionOf(tree, 'minYieldMs') === undefined,
    '开合只影响本字段——同函数其他实例的帮助区不得跟着出现（组件＋key 分槽的红判据）');
  assert.equal(helpButtonOf(tree, 'minYieldMs').props['aria-expanded'], false,
    '其他字段的按钮保持收起');

  // ③ aria-describedby：展开时并入帮助区 id（官方控件同形），收起时只有说明行。
  const yieldInput = findNode(tree, (node) => node.type === 'input'
    && node.props.id === 'plugin-config-defaultYieldMs');
  assert.equal(yieldInput.props['aria-describedby'],
    'plugin-config-defaultYieldMs-message plugin-config-defaultYieldMs-help',
    '展开时 aria-describedby = 说明行 id + 帮助区 id（空格连接）');
  helpButtonOf(tree, 'defaultYieldMs').props.onClick();
  tree = renderCard();
  assert.ok(regionOf(tree, 'defaultYieldMs') === undefined, '再点收起——展开区节点不渲染');
  assert.equal(findNode(tree, (node) => node.type === 'input'
    && node.props.id === 'plugin-config-defaultYieldMs').props['aria-describedby'],
    'plugin-config-defaultYieldMs-message', '收起时 aria-describedby 回到只有说明行 id');

  // ④ 开合无副作用（需求 §5.6）：模型零写（mutate/edit 落不到盘上）、草稿文本、
  //    读数与 dirty/invalid 状态不变。
  const dirtyBefore = findNode(tree, (node) => node.type === 'button'
    && textOf(node).join('') === '保存')?.props.disabled;
  helpButtonOf(tree, 'askTimeoutMs').props.onClick();
  tree = renderCard();
  helpButtonOf(tree, 'askTimeoutMs').props.onClick();
  tree = renderCard();
  assert.equal(mutateCalls.length, 0, '开合帮助绝不能触发写（mutate 零调用）');
  assert.equal(findNode(tree, (node) => node.type === 'button'
    && textOf(node).join('') === '保存')?.props.disabled, dirtyBefore,
    '开合不得改变 dirty/invalid（保存按钮启用状态不变）');

  // ⑤ 三态可读（需求 §5.6）：只读、非法草稿、保存中——按钮可用、说明与错误仍在。
  //    只读：
  replace({ ...snapshot(8, {}), writable: false });
  tree = renderCard();
  const roInput = findNode(tree, (node) => node.type === 'input'
    && node.props.id === 'plugin-config-defaultYieldMs');
  assert.equal(roInput.props.disabled, true, '只读态控件禁用');
  const roButton = helpButtonOf(tree, 'defaultYieldMs');
  assert.notEqual(roButton.props.disabled, true, '只读态帮助按钮从不设 disabled');
  roButton.props.onClick();
  tree = renderCard();
  assert.ok(regionOf(tree, 'defaultYieldMs') !== undefined, '只读态帮助照常可开');
  assert.ok(findNode(tree, (node) => node.type === 'p'
    && node.props.id === 'plugin-config-defaultYieldMs-message') !== undefined,
    '只读态说明行（含读数）仍在');
  //    非法草稿：
  replace(snapshot(9, {}));
  tree = renderCard();
  findNode(tree, (node) => node.type === 'input'
    && node.props.id === 'plugin-config-defaultYieldMs').props.onChange({ target: { value: 'abc' } });
  tree = renderCard();
  const invalidMessage = findNode(tree, (node) => node.type === 'p'
    && node.props.id === 'plugin-config-defaultYieldMs-message');
  assert.ok(invalidMessage !== undefined, '非法草稿时常驻说明行仍在（不被原因行顶掉）');
  const invalidReason = findNode(tree, (node) => node.type === 'p'
    && node.props.id === 'plugin-config-defaultYieldMs-invalid');
  assert.ok(textOf(invalidReason).join('').includes('不是该字段可接受'),
    '原因行（-invalid）显示非法原因而不是消失（需求 §5.4 口径：两行并存）');
  const invalidButton = helpButtonOf(tree, 'defaultYieldMs');
  assert.notEqual(invalidButton.props.disabled, true, '非法草稿态帮助按钮可用');
  // 相位净位：上一阶段（只读）可能已把同一字段的开合态留在 true——先收再开，
  // 断言才是「非法草稿态下开得了」而不是「上阶段开过」。
  if (invalidButton.props['aria-expanded'] === true) {
    invalidButton.props.onClick();
    tree = renderCard();
  }
  helpButtonOf(tree, 'defaultYieldMs').props.onClick();
  tree = renderCard();
  assert.ok(regionOf(tree, 'defaultYieldMs') !== undefined, '非法草稿态帮助照常可开');
  //    保存中（saving=true 进程内断言——真机保存窗口短、抓拍不可靠，设计 §8.2）：
  //    相位净位：把上一阶段的非法草稿改回合法值（官方 save 对含非法项的 plan 直接
  //    早退，saving 不会置位——那正是保存禁用的因果链，别在本相位挡路）。
  replace(snapshot(9, {}));
  tree = renderCard();
  findNode(tree, (node) => node.type === 'input'
    && node.props.id === 'plugin-config-defaultYieldMs').props.onChange({ target: { value: '20000' } });
  tree = renderCard();
  findNode(tree, (node) => node.type === 'input'
    && node.props.id === 'plugin-config-jobKind').props.onChange({ target: { value: 'draft-kind' } });
  tree = renderCard();
  await findNode(tree, (node) => node.type === 'button'
    && textOf(node).join('') === '保存').props.onClick();
  tree = renderCard();
  assert.ok(textOf(tree).join('').includes('保存中'), '前提：保存挂起时页脚在保存中态');
  const savingMessage = findNode(tree, (node) => node.type === 'p'
    && node.props.id === 'plugin-config-jobKind-message');
  assert.ok(savingMessage !== undefined, '保存中说明行仍在（三态可读）');
  const savingButton = helpButtonOf(tree, 'jobKind');
  assert.notEqual(savingButton.props.disabled, true, '保存中帮助按钮可用');
  savingButton.props.onClick();
  tree = renderCard();
  assert.ok(regionOf(tree, 'jobKind') !== undefined, '保存中帮助照常可开合');

  // ⑥ 缺键回退（设计 §5.5）：help.<键> 缺席 → 按钮退场；hint.<键> 缺席 → 说明行
  //    （含毫秒读数）整体退场。缺键模拟走 uiLang=auto 的宿主翻译函数路径（zh/en 档
  //    词典优先，包不住宿主 t；auto 档 translator 就是宿主 t 本身）——宿主对缺失键
  //    返回键名本身（裸键名），resolveCopy 按缺席处理。
  const baseT = (key) => product.DICTIONARIES.zh[key] ?? key;
  const tMissingHelp = (key) => (key === 'help.jobKind' ? key : baseT(key));
  const tMissingHint = (key) => (key === 'hint.jobKind' ? key : baseT(key));
  replace(snapshot(11, {}, { uiLang: 'auto' }));
  tree = expand({ type: Card, props: { view: 'page', t: tMissingHelp } });
  assert.ok(helpButtonOf(tree, 'jobKind') === undefined,
    'help.<键> 缺席（裸键名）→ 不渲染帮助按钮，不开空区域');
  assert.ok(helpButtonOf(tree, 'defaultYieldMs') !== undefined, '其余字段不受缺键影响');
  tree = expand({ type: Card, props: { view: 'page', t: tMissingHint } });
  assert.ok(findNode(tree, (node) => node.type === 'p'
    && node.props.id === 'plugin-config-jobKind-message') === undefined,
    'hint.<键> 缺席 → 说明行退场，不渲染空段');

  // ⑦ 座位默认与显式保留（需求 §5.2/设计 §4.3）：无覆盖显示 sidebar；显式 overlay
  //    保留（value 层是宿主的合成生效层，user 层是覆盖徽标的事实源——两层都给）。
  replace(snapshot(12, { askUiSeat: 'overlay' }, { askUiSeat: 'overlay', uiLang: 'zh' }));
  tree = renderCard();
  assert.equal(findNode(tree, (node) => node.type === 'select'
    && node.props.id === 'plugin-config-askUiSeat').props.value, 'overlay',
    '显式 overlay 保留原值（不被清洗回默认）');
  unmount();
});

test('T18c（R24/R25·设计 §5.6）：设置文案对账——字段名/hint/help 三层夹具 + opt 组 + 负向锚 + 术语锚', async () => {
  const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
  let loaded;
  new Function('window', source)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory(() => ({
    createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {}
  }));
  const DICT = product.DICTIONARIES;
  const { TEXT } = await import('../lib/text.js');

  // ① 字段名锚 = 需求 §5.5 表中文字段名逐字（毫秒字段附（毫秒）后缀）。
  const NAMES_ZH = {
    defaultYieldMs: '默认首次等待时长', minYieldMs: '首次等待时长下限', maxYieldMs: '首次等待时长上限',
    defaultWaitMs: '等待示例时长', minWaitMs: '单次等待时长下限', maxWaitMs: '单次等待时长上限',
    pollIntervalMs: '子代理状态检查间隔', maxResultChars: '结果内容字符上限',
    jobKind: '命令作业类型标识', subagentProvider: '子代理创建后端',
    uiLang: '插件界面语言', agentLang: 'Agent 文案语言',
    silentFailureGuard: '命令静默失败提示', askTakeover: '在待答面板处理提问',
    askTimeoutMs: '首次提问等待时长', askExtendMs: '每次增加的等待时长',
    askUiSeat: '待答问题显示方式'
  };
  const MS_KEYS = new Set(['defaultYieldMs', 'minYieldMs', 'maxYieldMs', 'defaultWaitMs',
    'minWaitMs', 'maxWaitMs', 'pollIntervalMs', 'askTimeoutMs', 'askExtendMs']);
  for (const [key, name] of Object.entries(NAMES_ZH)) {
    const expected = MS_KEYS.has(key) ? `${name}（毫秒）` : name;
    assert.equal(DICT.zh[key], expected, `zh 字段名必须逐字对齐需求 §5.5 表：${key}`);
  }

  // ② hint 锚第一层 = 词典全文对账（夹具入库，改写即红；权威文本＝client.js
  //    词典与本夹具的对账，设计 §5.6 只登记要点与子串，不另维护全文）。
  const HINTS_ZH = {
    defaultYieldMs: 'async_run 与 async_workflow 未指定 yield_ms 时使用的首次等待时长；指定时按本次请求与上下限取值。到时仍未完成就结束本次等待、返回作业编号（job_id），后台任务继续运行。',
    minYieldMs: '限制本次 yield_ms 的有效值；请求低于此值时按下限取值。不是后台任务的最长运行时间。',
    maxYieldMs: '限制本次 yield_ms 的有效值；请求高于此值时按上限取值。不是后台任务的最长运行时间。',
    defaultWaitMs: '返回提示里等待调用示例使用的时长；示例只作演示，不等于实际调用的生效等待。wait_ms 仍必填，省略时报错；此值不是省略参数后的备用值。',
    minWaitMs: '适用于两个等待工具的 wait_ms；请求低于此值时按下限取值。到时结束本次等待，不停止后台任务。',
    maxWaitMs: '适用于两个等待工具的 wait_ms；请求高于此值时按上限取值。到时结束本次等待，不停止后台任务。',
    pollIntervalMs: 'async_wait_agent 备用检查子代理是否仍在运行的间隔。不是待答面板刷新间隔，也不是子代理运行时限。',
    maxResultChars: '单次返回保留的结果内容字符上限（正整数），超出时保留首尾并说明截断；状态与提示另计。',
    jobKind: '注册命令作业用的类型名称，便于在作业列表与日志中识别；不决定命令执行方式。',
    subagentProvider: 'async_agent 创建子代理使用的后端服务；不是选择大语言模型或模型服务商。',
    uiLang: '控制本包设置表单、字段帮助与待答界面文案；跟随宿主语言或显式中英文，不改宿主全局语言。',
    agentLang: '控制本包工具描述、参数说明、提示、错误与执行规则文案；不翻译命令、问题或用户输入，不改变行为。',
    silentFailureGuard: '“静默失败”指命令可能未执行、却没有明显报错。开关只给条件式提醒，不保证检出或自动修复；仅本包两预设生效，默认关。',
    askTakeover: '开启后由待答面板处理本包两预设根 Agent 的普通提问，关闭时保持宿主原生提问流程；到期如实告知未答、不替用户选答案。不接管权限审批或计划评审。',
    askTimeoutMs: '从接收一批提问起计时的初始窗口，同批多题共享期限。到期如实说明未答、不替用户选答案；已答内容保留、之后仍可补答。新值不重置进行中的批次。',
    askExtendMs: '待答面板“增加等待时间”每点击一次给该会话未到期批次增加的时长；已到期批次不重新等待。',
    askUiSeat: '侧边栏底栏徽标显示未处理数、点击展开；右下角浮窗直接显示问题。切换显示方式不改变接管开关。'
  };
  for (const [key, text] of Object.entries(HINTS_ZH)) {
    assert.equal(DICT.zh[`hint.${key}`], text, `zh 常驻短说明必须与夹具全文一致（权威＝词典＋夹具对账）：${key}`);
    assert.notEqual(DICT.en[`hint.${key}`], undefined, `en 常驻短说明必须在场：${key}`);
  }

  // ③ hint 锚第二层 = 常驻要点子串逐字段在场（防全文改写时要点缩水；设计 §5.6 清单，
  //    en 档为对译短语随本夹具定义）。
  const POINTS_ZH = {
    defaultYieldMs: ['作业编号', '继续运行', '上下限'],
    minYieldMs: ['下限', '最长运行时间'], maxYieldMs: ['上限', '最长运行时间'],
    defaultWaitMs: ['示例', '报错', '备用值'],
    minWaitMs: ['下限', '不停止'], maxWaitMs: ['上限', '不停止'],
    pollIntervalMs: ['备用', '刷新间隔'], maxResultChars: ['正整数', '截断', '另计'],
    jobKind: ['注册', '不决定'], subagentProvider: ['后端', '大语言模型'],
    uiLang: ['设置表单', '宿主全局语言'], agentLang: ['工具描述', '不翻译'],
    silentFailureGuard: ['静默失败', '条件式', '两预设'],
    askTakeover: ['到期', '权限审批'], askTimeoutMs: ['共享', '不替用户选答案', '补答'],
    askExtendMs: ['未到期', '不重新等待'], askUiSeat: ['徽标', '浮窗', '接管']
  };
  const POINTS_EN = {
    defaultYieldMs: ['job id', 'keeps running', 'bounds'],
    minYieldMs: ['lower bound', 'maximum run time'], maxYieldMs: ['upper bound', 'maximum run time'],
    defaultWaitMs: ['example', 'errors', 'fallback'],
    minWaitMs: ['lower bound', 'without stopping'], maxWaitMs: ['upper bound', 'without stopping'],
    pollIntervalMs: ['backup', 'refresh interval'], maxResultChars: ['positive integer', 'truncation note', 'counted separately'],
    jobKind: ['register', 'does not decide'], subagentProvider: ['Backend', 'large language model'],
    uiLang: ['settings form', 'global language'], agentLang: ['tool descriptions', 'does not translate'],
    silentFailureGuard: ['Silent failure', 'conditional', 'two presets'],
    askTakeover: ['expiry', 'approvals'], askTimeoutMs: ['share the deadline', 'never picks answers', 'answered later'],
    askExtendMs: ['unexpired', 'do not wait again'], askUiSeat: ['badge', 'overlay', 'takeover switch']
  };
  for (const [key, points] of Object.entries(POINTS_ZH)) {
    for (const point of points) {
      assert.ok(DICT.zh[`hint.${key}`].includes(point), `zh 常驻要点子串在场：${key} ⊇ ${point}`);
      assert.ok(DICT.en[`hint.${key}`].includes(POINTS_EN[key][points.indexOf(point)]),
        `en 对译短语在场：${key} ⊇ ${POINTS_EN[key][points.indexOf(point)]}`);
    }
  }

  // ④ help 展开区正锚（设计 §5.6 每字段 1–2 个不可省短语，两档各断言；
  //    en 为同义对译短语随本夹具定义）。
  const HELP_ANCHORS_ZH = {
    defaultYieldMs: ['等待时长不限制任务寿命', '作业编号'],
    minYieldMs: ['提前结束', '上下限'], maxYieldMs: ['提前结束', '上下限'],
    defaultWaitMs: ['仅为示例', '必填'],
    minWaitMs: ['一份预算'], maxWaitMs: ['一份预算'],
    pollIntervalMs: ['轮询', '配对'], maxResultChars: ['正整数', '截断', '另计'],
    jobKind: ['空值非法'], subagentProvider: ['不是选择大语言模型', '可读拒绝'],
    uiLang: ['跟随宿主语言', '独立'], agentLang: ['跟随宿主语言', '独立'],
    silentFailureGuard: ['三处', '条件式'], askTakeover: ['普通提问', '迟到'],
    askTimeoutMs: ['共享', '可补答'], askExtendMs: ['新批次不继承'], askUiSeat: ['消隐']
  };
  const HELP_ANCHORS_EN = {
    defaultYieldMs: ['does not limit the task', 'job id'],
    minYieldMs: ['end the first wait early', 'clamping'], maxYieldMs: ['end the first wait early', 'clamping'],
    defaultWaitMs: ['only an example', 'required'],
    minWaitMs: ['One budget covers'], maxWaitMs: ['One budget covers'],
    pollIntervalMs: ['polling', 'pairing'], maxResultChars: ['positive integer', 'truncation', 'counted separately'],
    jobKind: ['empty value is invalid'], subagentProvider: ['not choosing a large language model', 'rejected readably'],
    uiLang: ['follows the host language', 'independent'], agentLang: ['follows the host language', 'independent'],
    silentFailureGuard: ['three defenses', 'conditional'], askTakeover: ['plain questions', 'Late answers'],
    askTimeoutMs: ['share the deadline', 'Still-answerable'], askExtendMs: ['do not inherit the extension'],
    askUiSeat: ['hides once everything is handled']
  };
  for (const [key, anchors] of Object.entries(HELP_ANCHORS_ZH)) {
    for (const anchor of anchors) {
      assert.ok(DICT.zh[`help.${key}`].includes(anchor), `zh 展开区正锚在场：help.${key} ⊇ ${anchor}`);
    }
    for (const anchor of HELP_ANCHORS_EN[key]) {
      assert.ok(DICT.en[`help.${key}`].includes(anchor), `en 展开区正锚在场：help.${key} ⊇ ${anchor}`);
    }
  }

  // ⑤ opt 组对账：askUiSeat 选项命名与需求 §5.5 逐字一致且默认标记位在 sidebar；
  //    agentLang.en 带（默认）标记位；uiLang 三选项在场。
  assert.equal(DICT.zh['opt.askUiSeat.sidebar'], '侧边栏底栏徽标（默认）', '默认标记位在 sidebar（需求 §5.2）');
  assert.equal(DICT.zh['opt.askUiSeat.overlay'], '右下角浮窗', 'overlay 选项名与需求 §5.5 逐字一致、无默认标记');
  assert.equal(DICT.en['opt.askUiSeat.sidebar'], 'Sidebar footer badge (default)');
  assert.equal(DICT.en['opt.askUiSeat.overlay'], 'Bottom-right overlay');
  assert.ok(DICT.zh['opt.agentLang.en'].includes('（默认）'), 'opt.agentLang.en 必须带（默认）标记位');
  assert.ok(DICT.en['opt.agentLang.en'].includes('(default)'), 'en 档同标记位');
  assert.deepEqual([DICT.zh['opt.uiLang.auto'], DICT.zh['opt.uiLang.zh'], DICT.zh['opt.uiLang.en']],
    ['跟随界面语言', '中文', 'English'], 'uiLang 三选项齐备');

  // ⑥ 负向锚（两档各查）：defaultWaitMs 相关键不得以肯定句式自述为备用值——
  //    zh“备用值”/en“fallback”只允许出现在否定表述中；askTimeoutMs 常驻含不代答。
  for (const lang of ['zh', 'en']) {
    for (const key of ['defaultWaitMs', 'hint.defaultWaitMs', 'help.defaultWaitMs']) {
      const text = String(DICT[lang][key]);
      const marker = lang === 'zh' ? '备用值' : 'fallback';
      const negation = lang === 'zh' ? /(不是|不等于|并非|≠)[^。；]*?备用值/ : /not a fallback/;
      const hits = text.split(marker).length - 1;
      const negated = (lang === 'zh' ? /不是省略参数后的备用值/g : /not a fallback for an omitted parameter/g);
      assert.ok(hits === 0 || (negation.test(text) && hits <= 2),
        `${lang} 档 ${key} 的「${marker}」只许出现在否定表述中（实得 ${String(hits)} 处）`);
      assert.ok(hits === 0 || (text.match(negated) ?? []).length === hits,
        `${lang} 档 ${key} 的每处「${marker}」都必须落在否定句式里`);
    }
  }
  assert.ok(DICT.zh['hint.askTimeoutMs'].includes('不替用户选答案'),
    'askTimeoutMs 常驻必须含「不替用户选答案」（需求 §5.5）');
  assert.ok(DICT.en['hint.askTimeoutMs'].includes('never picks answers for the user'),
    'en 档同义负向锚');

  // ⑦ T21 在场断言扩展：17 字段的字段名键、hint.<键>、help.<键> 两档全必须在场
  //    （删任一键即红——本循环逐键断言）。
  for (const key of Object.keys(NAMES_ZH)) {
    for (const lang of ['zh', 'en']) {
      for (const prefix of ['', 'hint.', 'help.']) {
        const full = `${prefix}${key}`;
        const value = DICT[lang][full];
        assert.ok(typeof value === 'string' && value.length > 0 && value !== full,
          `${lang} 档词典键 ${full} 必须在场且非裸键名（设计 §5.5 在场判据）`);
      }
    }
  }

  // ⑧ 设置与模型文案统一术语锚（设计 §5.6 术语表·§8.2 语言与防护行）：
  //    zh 档「作业编号」「首次等待」在场；「让出预算」「job_id 句柄」在词典与
  //    lib/text.js 零残留。
  const zhModel = Object.values(TEXT.zh).join('\n');
  assert.ok(zhModel.includes('作业编号'), '模型文案 zh 档必须出现统一术语「作业编号」');
  assert.ok(zhModel.includes('首次等待'), '模型文案 zh 档必须出现统一术语「首次等待」');
  for (const [label, corpus] of [['词典 zh', Object.values(DICT.zh).join('\n')],
    ['词典 en', Object.values(DICT.en).join('\n')], ['text.js zh', zhModel]]) {
    assert.ok(!corpus.includes('让出预算'), `${label} 不得残留旧术语「让出预算」`);
    assert.ok(!corpus.includes('job_id 句柄'), `${label} 不得残留旧术语「job_id 句柄」`);
  }
  const enModel = Object.values(TEXT.en).join('\n');
  assert.ok(enModel.includes('first wait'), '模型文案 en 档必须出现 first wait');
  assert.ok(enModel.includes('keeps running in the background'), 'en 档统一句式在场');
});

test('T22（R25）：改语言后刷新必须整段换文案——正文、尾部摘要与每个参数说明一起换', async (t) => {
  // 描述刷新是"整段重建"（不就地改数字），语言与数字走同一条路。
  // 这条钉两件事：①换语言真的换的是**整段**（只换数字不算）；②换语言不会把"数字跟着设置走"
  // 弄丢——zh 档下的区间同样必须更新。宿主侧判据见 `verify/probe-lang-independence.mjs`。
  const hostIndex = await loadOfflineSafe('../lib/index.js');
  if (hostIndex === undefined) { t.skip('宿主包不可解析（离线环境），本用例跳过'); return; }
  const { createRunTool } = await import('../lib/jobs.js');
  const { refreshToolDescriptions } = hostIndex;
  let current = {
    toolName: 'async_run',
    uiLang: 'auto',
    agentLang: 'en',
    defaultYieldMs: 20000,
    minYieldMs: 1000,
    maxYieldMs: 600000,
    defaultWaitMs: 30000,
    minWaitMs: 250,
    maxWaitMs: 600000,
    maxResultChars: 30000,
    jobKind: 'async-command',
    pollIntervalMs: 500
  };
  const view = new Proxy({}, { get: (_target, key) => current[key] });
  const ctx = { logger: { info() {}, warn() {}, debug() {} }, get: () => undefined };
  const tool = createRunTool(ctx, view);
  const CJK = /[\u4e00-\u9fff]/;
  const paramText = () => String(tool.parameters.properties.yield_ms.description);

  const enDescription = tool.description;
  assert.doesNotMatch(enDescription, CJK, 'en 档正文不许有 CJK');
  assert.doesNotMatch(paramText(), CJK, 'en 档参数说明不许有 CJK');

  current = { ...current, agentLang: 'zh' };
  refreshToolDescriptions(tool, view);
  assert.notEqual(tool.description, enDescription, '刷新必须换掉整段文案（只换数字不算换语言）');
  assert.match(tool.description, CJK, 'zh 档正文必须含中文');
  assert.match(paramText(), CJK, 'zh 档参数说明必须一起换（参数集合不能留在英文）');

  // 数字链不能因为换语言断掉：zh 档下正文与参数说明的区间都要跟着快照更新。
  current = { ...current, maxYieldMs: 120000 };
  refreshToolDescriptions(tool, view);
  assert.match(tool.description, /1000–120000 ms/, 'zh 档正文里的让出区间仍要跟着设置更新');
  assert.match(paramText(), /1000-120000/, 'zh 档参数说明里的区间仍要跟着设置更新');

  // 展示侧开关与模型侧无关：改 `uiLang` 不得动描述（互不牵连的单元侧最小证据）。
  const zhDescription = tool.description;
  current = { ...current, uiLang: 'en' };
  refreshToolDescriptions(tool, view);
  assert.equal(tool.description, zhDescription, '改 uiLang 不得影响模型侧描述');
});

test('T19（R21/R24/R25）：字段表单一来源——client.js 的 FIELDS 与 lib/config.js 逐项一致', async () => {
  // 两条钉的是"字段集合"的**单一来源**：界面判据拿 `BUDGET_FIELD_KEYS` + `LANG_FIELD_KEYS` 去核对页面
  // （`judgeConfigForm` 的字段身份那一条），而页面渲染哪些字段、哪几个带读数由 `client.js` 的
  // `FIELDS` 决定。两侧漂移时，"字段缺项 / 读数挂错字段"永远抓不到——判据会与被测实现一起错。
  const { MS_FIELD_KEYS, BUDGET_FIELD_KEYS, LANG_FIELD_KEYS, FLAG_FIELD_KEYS, ASK_FIELD_KEYS } = await import('../lib/config.js');
  let loaded;
  new Function('window', clientCode())({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory(() => ({ createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {} }));

  assert.deepEqual(product.FIELDS.map((field) => field.key),
    [...BUDGET_FIELD_KEYS, ...LANG_FIELD_KEYS, ...FLAG_FIELD_KEYS, ...ASK_FIELD_KEYS],
    'client.js 的字段顺序必须是 预算字段 + 语言字段 + 开关字段 + 提问字段（ask 组四个字段全部可编辑）');
  assert.deepEqual(product.LANG_KEYS, [...LANG_FIELD_KEYS], 'client.js 的语言键表必须与 LANG_FIELD_KEYS 一致');

  const declared = [...clientCode().matchAll(/key: "([A-Za-z]+)", label: "[A-Za-z]+", ms: true/g)]
    .map((m) => m[1]);
  assert.deepEqual(declared, [...MS_FIELD_KEYS],
    'client.js 里 `ms: true` 的字段必须与 MS_FIELD_KEYS 逐项一致（顺序也要一致）');
  assert.ok(MS_FIELD_KEYS.length > 0 && MS_FIELD_KEYS.length < BUDGET_FIELD_KEYS.length,
    '毫秒字段必须是非空真子集：等于全集时"读数挂错字段"这条判据恒真');
});

test('T21（R25）：展示范围语言开关——auto 跟随宿主、zh/en 用本包词典、缺键回退宿主', () => {
  let loaded;
  new Function('window', clientCode())({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory(() => ({ createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {} }));

  // 宿主翻译函数充当"auto"档与缺键回退：真机上它就是槽位传进来的 `props.t`。
  const host = (key) => `host:${key}`;
  assert.equal(product.makeTranslator('auto', host)('save'), 'host:save', 'auto 档必须用宿主 locale');
  assert.equal(product.makeTranslator('zh', host)('save'), '保存', 'zh 档必须用本包中文词典');
  assert.equal(product.makeTranslator('en', host)('save'), 'Save', 'en 档必须用本包英文词典');
  assert.equal(product.makeTranslator('zh', host)('不存在的键'), 'host:不存在的键',
    '缺键必须回退宿主 t（漏加词条不该渲染成空白）');

  // 两个开关各自的取值范围：选项集就是契约（写错一个值 → 宿主 fail-fast，见 lib/config.js）。
  const byKey = Object.fromEntries(product.FIELDS.map((field) => [field.key, field]));
  assert.deepEqual(byKey.uiLang.options, ['auto', 'zh', 'en'], 'uiLang 的选项集');
  assert.deepEqual(byKey.agentLang.options, ['en', 'zh'], 'agentLang 的选项集（模型侧只有两档）');

  // 生效值的判定：用户层优先，其次实时值，未知值当 auto（不把脏值当语言用）。
  assert.equal(product.uiLangOf({ user: { uiLang: 'en' }, value: { uiLang: 'zh' } }), 'en', '用户层优先');
  assert.equal(product.uiLangOf({ user: {}, value: { uiLang: 'zh' } }), 'zh', '其次实时解析值');
  assert.equal(product.uiLangOf({ user: {}, value: {} }), 'auto', '都没有 → auto');
  assert.equal(product.uiLangOf({ user: { uiLang: 'fr' }, value: {} }), 'auto', '未知取值 → auto（不猜）');

  // 两档词典的键集必须相等：少一个键就是少一句界面文案（与模型侧表的同一条纪律）。
  assert.deepEqual(Object.keys(product.DICTIONARIES.zh).sort(), Object.keys(product.DICTIONARIES.en).sort(),
    'zh/en 词典键集必须相等');
});

test('T17（R10·复审 Z4）：预算默认值本身也要钉住——改错一个只会静默改变工具行为', async () => {
  // 改错一个默认值的后果是静默的行为改变：默认首次等待、轮询间隔、
  // 输出上限全变了，而"跑一遍测试"什么也不说。
  //
  // 判据取**期望值表**而不是"断言非空"：非空对 `999` 与 `500` 一样成立。
  const { resolveConfig } = await import('../lib/config.js');
  const resolved = resolveConfig({ toolName: 'async_run' });
  const EXPECTED_DEFAULTS = {
    maxResultChars: 30000,
    defaultYieldMs: 20000,
    minYieldMs: 1000,
    maxYieldMs: 600000,
    defaultWaitMs: 30000,
    minWaitMs: 250,
    maxWaitMs: 600000,
    pollIntervalMs: 500,
    jobKind: 'async-command',
    // async_agent 的子代理后端默认值（加字段必须
    // 同步往期望表加行，不是把字段挪出解析范围消红）。
    subagentProvider: 'spawn',
    // 两个语言字段的出厂默认值（uiLang 跟随宿主；agentLang 英文为默认档）。
    uiLang: 'auto',
    agentLang: 'en',
    // 静默失败防线开关出厂**默认关**——默认值翻成 true 等于未经用户
    // 同意就给所有会话注入纪律段（判据 13 的缺省方向在这里钉死）。
    silentFailureGuard: false,
    // 提问接管四件出厂默认——总开关**默认关**（关时零行为是硬性边界）；
    // 窗口 60000 ms；延长步长 60000 ms；座位 sidebar（需求 §5.2：默认标记位在
    // 「侧边栏底栏徽标」）。默认值翻成 true 等于未经用户同意就劫持提问通道。
    askTakeover: false,
    askTimeoutMs: 60000,
    askExtendMs: 60000,
    askUiSeat: 'sidebar'
  };
  for (const [key, want] of Object.entries(EXPECTED_DEFAULTS)) {
    assert.equal(resolved[key], want,
      `\`${key}\` 的默认值必须是 ${JSON.stringify(want)}——`
      + `改错它不会让任何行为报错，只会静默改变工具行为（复审 Z4：30000→99999 曾全绿逃逸）`);
  }
  assert.deepEqual(Object.keys(EXPECTED_DEFAULTS).sort(), Object.keys(resolved).filter((key) => key !== 'toolName').sort(),
    '期望值表必须覆盖**每一个**预算字段——漏掉一个就等于那个字段的默认值没人守');
});

test('T20（R25）：agentLang 双档——en 零 CJK、zh 换语言、参数集合不变、缺译抛错', async () => {
  // 四个工具在两档下各构建一次；判据是**行为差异**（构建产物逐项对比），
  // 不是"源码里出现了某个词"。
  const { resolveConfig } = await import('../lib/config.js');
  const { createRunTool } = await import('../lib/jobs.js');
  const { createWaitJobTool } = await import('../lib/wait-job.js');
  const { createWaitAgentTool } = await import('../lib/wait-agent.js');
  const { createAgentTool } = await import('../lib/agent.js');
  const { t } = await import('../lib/text.js');
  const { buildToolText } = await import('../lib/descriptions.js');

  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const ctx = { shell: { sandboxMode: 'workspace-write' } };
  const factories = {
    async_run: createRunTool,
    async_wait_job: createWaitJobTool,
    async_wait_agent: createWaitAgentTool,
    async_agent: createAgentTool
  };
  const tools = {};
  for (const agentLang of ['en', 'zh']) {
    tools[agentLang] = {};
    for (const [name, factory] of Object.entries(factories)) {
      tools[agentLang][name] = factory(ctx, resolveConfig({ toolName: name, agentLang }));
    }
  }

  for (const [name, tool] of Object.entries(tools.en)) {
    // ① en 档：主描述与全部参数说明零 CJK。
    assert.doesNotMatch(tool.description, CJK, `${name} 的 en 主描述必须零 CJK`);
    for (const [param, spec] of Object.entries(tool.parameters.properties)) {
      assert.doesNotMatch(String(spec.description), CJK, `${name}.${param} 的 en 参数说明必须零 CJK`);
    }
    // ② zh 档：主描述含 CJK 且与 en 不同（语言开关真的换到了描述）。
    const zhTool = tools.zh[name];
    assert.match(zhTool.description, CJK, `${name} 的 zh 主描述必须含中文`);
    assert.notEqual(zhTool.description, tool.description, `${name} 两档主描述必须不同`);
    // ③ 语言只换文案，不改参数集合：两档的参数键集合相同。
    assert.deepEqual(
      Object.keys(zhTool.parameters.properties).sort(),
      Object.keys(tool.parameters.properties).sort(),
      `${name} 两档的参数键集合必须相同（语言不改参数集合）`
    );
  }

  // ④ 未知键必须抛错：静默返回空串会让缺译看不见。
  assert.throws(() => t('zh', 'no.such.key'), /missing text key/,
    't() 对未知键必须抛错——缺译要当场红，不能静默空串');
  // 构建器同样吃这条纪律（未知工具名是同类缺陷）。
  assert.throws(() => buildToolText('not_a_tool', { agentLang: 'en' }), /unknown tool name/);
});

// ---------------------------------------------------------------------------
// 安全/健壮性/异常处理的缺陷防御判据：上界拒绝与
// 卡片层拒绝 + 内联常量对账 + settings 悬空 import 防线。
// ---------------------------------------------------------------------------

test('T7c（R29-d·判据 8）：预算上界越界必须被 resolveConfig 拒绝，且报错带上界数字', async () => {
  const { resolveConfig } = await import('../lib/config.js');
  const base = {
    defaultYieldMs: 5, minYieldMs: 1, maxYieldMs: 10,
    defaultWaitMs: 5, minWaitMs: 1, maxWaitMs: 10, pollIntervalMs: 5
  };
  // 宿主 setTimeout 对 >2^31-1 的定值按 1ms 立即触发——毫秒字段必须挡住
  // 2^31 这个量级。撤掉 .max 咬合 → 本用例整组红。
  const overLimit = [
    ['defaultYieldMs', 2 ** 31],
    ['maxYieldMs', 2 ** 31],
    ['defaultWaitMs', 2 ** 31],
    ['maxWaitMs', 2 ** 31],
    ['pollIntervalMs', 2 ** 31],
    ['maxResultChars', 1000001]
  ];
  for (const [key, value] of overLimit) {
    assert.throws(
      () => resolveConfig({ ...base, [key]: value }),
      (error) => /2147483647|1000000/.test(error.message),
      `${key}=${String(value)} 必须被拒，且报错要带上界数字（schemastery .max 的可读错）`
    );
  }
  // 边界内侧必须放行（上界本身合法）。
  assert.doesNotThrow(() => resolveConfig({ ...base, maxWaitMs: 2147483647, pollIntervalMs: 2147483647, defaultWaitMs: 10, minWaitMs: 1 }));
});

test('T23（R29-d·判据 14）：卡片层单字段上界——boundedNumberSpec 走官方 parse 通道拒绝', async () => {
  // 挂法关键：宿主 SettingsForm 的保存禁用**只认** spec.parse 聚合出的
  // `state.invalid`（字段 props 的 invalid 是纯显示层，不回流 shell）。所以单字段
  // 上界必须包在 spec.parse 里返回 undefined——撤掉包裹（改回 settingsNumberField
  // 裸用）→ 下面的 undefined 断言红。
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const reactStub = { createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
  const double = makePrimitivesDouble(reactStub);
  let loaded;
  new Function('window', readFileSync(resolve(ROOT, 'client.js'), 'utf8'))({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactStub : double));

  const spec = Object.fromEntries(product.makeSpecs().map((entry) => [entry.field, entry]));

  // 越上界：parse 返回 undefined（官方非法通道 → plan.invalid → 保存按钮禁用）。
  assert.equal(spec.maxWaitMs.parse('2147483648'), undefined, '2147483648 越上界 → parse undefined');
  assert.equal(spec.pollIntervalMs.parse('2147483648'), undefined, 'pollIntervalMs 同上界');
  assert.equal(spec.maxResultChars.parse('1000001'), undefined, 'maxResultChars 上界 1000000');
  // 上界内侧与既有语义不得被包裹改变。
  assert.deepEqual(spec.maxWaitMs.parse('600000'), { kind: 'set', value: 600000 }, '内侧值照常 set');
  assert.deepEqual(spec.maxWaitMs.parse(' 600000 '), { kind: 'set', value: 600000 }, '两侧空白照常 trim');
  assert.deepEqual(spec.maxWaitMs.parse(''), { kind: 'clear' }, '空草稿照常 clear');
  assert.equal(spec.maxWaitMs.parse('abc'), undefined, '非数字仍非法（官方语义）');
  assert.equal(spec.maxWaitMs.format(600000), '600000', 'format 原样透传');
});

test('T23d（正整数体系）：maxResultChars 非整数草稿 parse 拒绝＋invalidInteger 档＋服务端整数校验', async () => {
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const reactStub = { createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
  const double = makePrimitivesDouble(reactStub);
  let loaded;
  new Function('window', readFileSync(resolve(ROOT, 'client.js'), 'utf8'))({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactStub : double));

  const spec = Object.fromEntries(product.makeSpecs().map((entry) => [entry.field, entry]));

  // ① parse 层：非整数草稿 → undefined（官方非法通道 → 保存禁用）。
  assert.equal(spec.maxResultChars.parse('30000.7'), undefined, 'maxResultChars 小数草稿必须被拒（正整数，需求 §5.2）');
  assert.equal(spec.maxResultChars.parse('0.5'), undefined, '小于 1 的小数同样被拒');
  assert.deepEqual(spec.maxResultChars.parse('30000'), { kind: 'set', value: 30000 }, '整数字面值照常 set');
  assert.deepEqual(spec.maxResultChars.parse('30000.0'), { kind: 'set', value: 30000 }, '整数值的小数写法（.0）数值上是整数，照常 set');
  // ② 整数档只作用于 maxResultChars：毫秒预算字段的小数草稿不受整数档影响
  //    （各自仍走上下界校验；300.5 在 250..600000 内侧 → set）。
  assert.deepEqual(spec.maxWaitMs.parse('300.5'), { kind: 'set', value: 300.5 }, '毫秒字段无整数约束（需求只对 maxResultChars 要求正整数）');

  // ③ 显示层分档：非整数档优先于越界档，文案键 invalidInteger。
  const code = clientCode();
  assert.match(code, /notInteger\s*\? t\("invalidInteger"\)/, '非整数草稿必须给出 invalidInteger 档的原因文案');
  assert.match(code, /INTEGER_FIELDS = \{ maxResultChars: true \}/, '整数字段表只登记 maxResultChars');

  // ④ 词典两档都带 invalidInteger 键（zh/en 键集一致由 T21 守，这里守内容）。
  assert.ok(product.DICTIONARIES.zh.invalidInteger.length > 0, 'zh invalidInteger 在场');
  assert.ok(product.DICTIONARIES.en.invalidInteger.length > 0, 'en invalidInteger 在场');
  assert.match(product.DICTIONARIES.zh.invalidInteger, /整数/, 'zh 文案必须说"整数"');

  // ⑤ 服务端第二层：lib/config.js 的 maxResultChars 带 .step(1)（schemastery 的
  //    整数校验——设置页与 resolveConfig 同走这条），运行时 resolveConfig 对
  //    小数 fail-fast。
  const configCode = readFileSync(resolve(ROOT, 'lib/config.js'), 'utf8');
  assert.match(configCode, /maxResultChars: z\.number\(\)\.step\(1\)/, '服务端 schema 必须带 .step(1) 整数校验');
  const { resolveConfig } = await import('../lib/config.js');
  assert.throws(
    () => resolveConfig({ toolName: 'async_run', maxResultChars: 30000.7 }),
    'resolveConfig 必须拒绝小数 maxResultChars（fail-fast，不夹紧）'
  );
  assert.equal(resolveConfig({ toolName: 'async_run', maxResultChars: 12345 }).maxResultChars, 12345, '整数照常通过');
});

test('T23b（R29-d·判据 14）：卡片层跨字段配对——pollIntervalMs 草稿 > maxWaitMs 草稿', async () => {
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const reactStub = { createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
  const double = makePrimitivesDouble(reactStub);
  let loaded;
  new Function('window', readFileSync(resolve(ROOT, 'client.js'), 'utf8'))({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactStub : double));

  const fields = (poll, max) => ({
    fields: { pollIntervalMs: { text: poll }, maxWaitMs: { text: max } }
  });
  assert.equal(product.pairViolated(fields('600000', '500000')), true, 'poll > max → 违例');
  assert.equal(product.pairViolated(fields('500000', '500000')), false, '相等不违例');
  assert.equal(product.pairViolated(fields('', '500000')), false, '一侧空草稿不参与比较');
  assert.equal(product.pairViolated(fields('abc', '500000')), false, '非数字草稿不参与比较');
  assert.equal(product.pairViolated({ fields: {} }), false, '字段缺席不炸');

  // 壳层叠加挂法：配对违例必须叠加进传给 SettingsForm 的 state.invalid，
  // 而不是包 save——这是宿主保存禁用唯一认的因果链。静态钉住（撤掉叠加 → 红）。
  const code = clientCode();
  assert.match(code, /state: \{ \.\.\.state\.shell, invalid: state\.shell\.invalid === true \|\| pairViolated\(state\) \}/,
    'makeBundleCard 必须把配对违例叠加进 SettingsForm 的 state.invalid');
  // 字段显示层：pollIntervalMs 的非法原因文案（invalidRange/invalidPair 分档）。
  // `pairHit !== null` 必须显式归布尔：chainHitOf 命中时返回的是**字符串**（参照
  // 字段键），而 FieldShell 全部消费点（消息替换、aria-invalid、hasMessage）都是
  // 严格 `=== true` 门——旧形 `=== true || pairHit` 会把字符串原样传下去，违例
  // 时红框与原因文案全灭、只剩保存按钮变灰（需求 §5.4 字段原因不可达的失效形态）。
  assert.match(code, /invalid: fieldState\.invalid === true \|\| pairHit !== null/,
    'pollIntervalMs 字节必须叠加 pairHit 显示，且归一为布尔（字符串 pairHit 过不了 FieldShell 的严格 === true 门）');
  assert.match(code, /t\("invalidRange"\)/, '越上界要有带 {max} 的原因文案');
  // 配对违例文案按字段键动态拼（五对链式共用一条分档路径），{ref} 显示层经词典
  // 换参照字段的中文名称（设计 §5.6 统一术语——键名不进界面）。
  // （源码里 { 与 } 都被转义——`/\{ref\}/g`——钉子按真实文本转义。）
  assert.match(code, /t\("invalidPair\." \+ field\.key\)\.replace\(\/\\{ref\\}\/g, t\(pairHit\)\)/,
    '配对违例要有专用文案（按字段键拼 invalidPair.<键> 并把 {ref} 换成参照字段名）');

  // 词典两语言键集成对（词典纪律：zh/en 键集一致由 T21 守，这里守新增键的内容）。
  assert.ok(product.DICTIONARIES.zh['invalidPair.pollIntervalMs'].length > 0, 'zh 配对文案在场');
  assert.ok(product.DICTIONARIES.en['invalidPair.pollIntervalMs'].length > 0, 'en 配对文案在场');
  assert.match(product.DICTIONARIES.zh.invalidRange, /\{max\}/, 'zh invalidRange 必须带 {max} 插位');
  assert.match(product.DICTIONARIES.en.invalidRange, /\{max\}/, 'en invalidRange 必须带 {max} 插位');
});

test('T23c（R29-d）：client 内联上界与 lib/budget-limits.js 逐条比对——只改一处必红', async () => {
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const reactStub = { createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
  const double = makePrimitivesDouble(reactStub);
  let loaded;
  new Function('window', readFileSync(resolve(ROOT, 'client.js'), 'utf8'))({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactStub : double));
  const limits = await import('../lib/budget-limits.js');

  // 客户端模块图只投递平名包，client.js 引不到 lib/ 文件——上界只能内联同值。
  // 这条对账断言钉住"内联的一份"与"权威的一份"相等，漂移当场红。
  assert.equal(product.MS_FIELD_LIMIT, limits.MS_FIELD_LIMIT, 'MS_FIELD_LIMIT 两处同值');
  assert.equal(product.RESULT_CHARS_LIMIT, limits.RESULT_CHARS_LIMIT, 'RESULT_CHARS_LIMIT 两处同值');
  assert.deepEqual(product.FIELD_MAX, limits.FIELD_MAX, 'FIELD_MAX 逐键同值');
  // 提问窗口上界三处同值（lib 权威 + client 内联 + 词汇常量；下界 10000 由
  // FIELD_MIN 单侧持有——宿主 schema 与 client 解析侧各查一次，T-ask 系列验行为）。
  assert.equal(product.FIELD_MAX.askTimeoutMs, limits.ASK_TIMEOUT_LIMIT, 'askTimeoutMs 上界 = ASK_TIMEOUT_LIMIT（600000）');
  assert.equal(product.ASK_TIMEOUT_LIMIT, limits.ASK_TIMEOUT_LIMIT, 'client 的 ASK_TIMEOUT_LIMIT 常量同值');
  assert.equal(product.FIELD_MIN.askTimeoutMs, 10000, 'client 下界 10000（与宿主 schema min 同值）');
  assert.equal(product.ASK_EXTEND_LIMIT, limits.ASK_EXTEND_LIMIT, 'client 的 ASK_EXTEND_LIMIT 常量同值');
  assert.deepEqual(product.FIELD_MIN, limits.FIELD_MIN, 'FIELD_MIN 逐键同值（含 askTimeoutMs=10000、askExtendMs=1 与九个 1）');
  assert.deepEqual(limits.ORDERED_PAIRS.map((pair) => pair.join('=')), ['minYieldMs=maxYieldMs', 'minWaitMs=maxWaitMs', 'pollIntervalMs=maxWaitMs'],
    '配对表内容钉住（增删配对必须连本断言一起改）');
  // §5.4 链式不等式五对（CHAIN_INEQUALITIES 的客户端内联同值对账——只改一处必红）。
  assert.deepEqual(product.CHAIN_PAIRS, limits.CHAIN_INEQUALITIES, '五对链式不等式两处逐对同值');
  assert.deepEqual(product.CHAIN_PAIRS.map((pair) => pair.join('≤')), [
    'minYieldMs≤defaultYieldMs', 'defaultYieldMs≤maxYieldMs', 'minWaitMs≤defaultWaitMs',
    'defaultWaitMs≤maxWaitMs', 'pollIntervalMs≤maxWaitMs'
  ], '链式键集钉住（增删链对必须连本断言一起改）');
  // client 的 pairViolated 消费全部五对链（宿主 resolveConfig 在保存期守同组不等式；
  // 卡片层单字段解析通道做不了跨字段，两层各守一半）。
  assert.match(clientCode(), /var CHAIN_PAIRS = \[[\s\S]*?pollIntervalMs[\s\S]*?maxWaitMs/, '链式判定常量在场（以 CHAIN_PAIRS 为唯一键源）');
});

test('T8b（R29-a·判据 15 附）：settings 的悬空动态 import 必须 .catch——快照已落，广播失败不得杀实例', () => {
  const code = stripComments(read('lib/settings.js'));
  assert.match(code, /import\('\.\/refresh-bus\.js'\)[\s\S]{0,160}\.catch\(/,
    'refresh-bus 动态 import 链上必须有 .catch（这条 promise 只可能 reject，无人接住 = 整实例退出）');
});
