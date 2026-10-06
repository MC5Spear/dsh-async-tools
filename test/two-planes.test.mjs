/**
 * 两平面分工的锁（R6 / R9 / R10；0.1.7 形态）。
 *
 * 这一组用例防的是**架构退化**：三条约束都是"写错了也能跑、但会在别人机器上炸"的类型，
 * 靠人工复查守不住，必须有能失败的断言。
 *
 * | 用例 | 锁住的约束 | 违反后的真实后果 |
 * | --- | --- | --- |
 * | T1 | 设置快照链：宿主行播报、工具行读快照（0.1.7 无 installSection / settings.get） | 多行注册撞名；或设置改了工具永远不知道 |
 * | T2 | 宿主半边不注册任何工具 | 工具进入全局工具层，出现在每个预设里 |
 * | T3 | 工具读取用的是"调用时取值"的视图（`readSnapshot() ?? initial`） | 改设置不生效（构造时快照），R10 落空 |
 * | T10 | volatile 提交事件 → 快照 → refresh-bus → 描述 就地刷新，整链贯通 | 行为活、描述死（模型看到过期数字） |
 *
 * ## 0.1.7 与 0.1.5 的判据差异（§21）
 *
 * - 设置侧**没有** `installSection`、没有 `settings.get(ns)` 服务面：宿主行
 *   `attachSnapshotSource(ctx)` 首播快照 + 监听 `loader/volatile-update`；
 *   工具行 `readSnapshot() ?? initial`。卡片挂在插件页 `plugins.item` 槽位
 *   （`client.js`，静态判据见 T5/T16）。
 * - 预设生命周期（0.1.5 的 installSection/landing 探针）已随 §20.3 退场，
 *   对应用例删除；预设补丁的六项判据在 `test/preset.test.mjs`。
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

test('T1（R10·0.1.7）：设置快照链——宿主行播报、工具行读快照、任何地方都没有 installSection', () => {
  // ① 0.1.5 的注册面（installSection / settings.get）在整个 lib/ 不得复活：
  //    0.1.7 的设置 describe 自动遍历活动条目的 volatile 字段，宿主侧零注册
  //    （`dsh-settings/lib/index.js:413-451`）；再写 installSection 会在
  //    不存在的服务面上调用，且多行注册撞 `already registered`。
  for (const file of ['lib/index.js', 'lib/settings.js', 'lib/config-view.js', 'lib/host.js']) {
    const code = stripComments(read(file));
    assert.doesNotMatch(code, /installSection/, `${file} 出现了 installSection（0.1.5 机制，已随 0.1.7 退场）`);
    assert.doesNotMatch(code, /settings\.get\(/, `${file} 出现了 settings.get（0.1.7 服务面没有这个方法）`);
  }

  // ② 宿主半边必须接的就是快照链：`attachSnapshotSource`（首播 + volatile 监听）。
  const hostCode = stripComments(read('lib/host.js'));
  assert.match(hostCode, /attachSnapshotSource\(ctx, liveConfig\)/, 'lib/host.js 必须把 apply 第二参（活配置）交给 attachSnapshotSource——否则快照永远缺席');

  // ③ 快照模块的四个面（seed/read/clear + 接线）——工具行的取值入口点名 readSnapshot。
  const entryCode = stripComments(read('lib/index.js'));
  assert.match(entryCode, /makeConfigView\(\(\) => readSnapshot\(\) \?\? initial\)/,
    '工具行取值必须是"快照优先、本行默认值兜底"的活视图');
});

test('T2（R6）：宿主入口不注册任何工具', () => {
  const code = stripComments(read('lib/host.js'));
  assert.doesNotMatch(
    code,
    /tools\.register|ctx\.tools/,
    // ⚠️ 措辞要准：**"可见"不等于"每个预设都会用"**——每个预设都有自己的工具列表，
    // 使用者可以取舍。被禁的是"**不经选择地默认塞给所有预设**"，差别在**同意**，不在能力。
    'lib/host.js 不得接触工具表：宿主平面注册的工具会进全局工具层，于是**每个预设都默认带上它们**，不需要也无法拒绝'
  );
  // 宿主入口也不该把工具的工厂 import 进来——import 了迟早会被用上。
  // （审查 R16-N2 清点时发现：这条正则漏了 agent.js——光改注释不改正则，
  // 宿主半边悄悄引入第四个工厂会全绿放行。）
  assert.doesNotMatch(code, /from '\.\/(jobs|wait-job|wait-agent|agent)\.js'/, '宿主入口不得引入任何工具的工厂');
});

test('T2b（R6）：单包两角色——默认入口按 toolName 分派，退役的 ./host 子路径入口不得复活', () => {
  const pkg = JSON.parse(read('package.json'));
  const main = pkg.exports['.'].default;
  assert.ok(typeof main === 'string' && main.length > 0, '默认入口必须存在');
  // 浏览器半边挂在平名主包上（./client 子路径导出是 dsh.client 的取件口，不是行名）。
  assert.equal(pkg.exports['./client'], './client.js', '必须导出 ./client 指向包根的 client.js');
  assert.notEqual(main, pkg.exports['./client'], '宿主半边与浏览器半边不能是同一个文件');
  // 退役入口不得复活：行名带子路径进不了客户端模块图（那是旧宿主包必须平名的原因），
  // 而单包化后宿主角色由默认入口分派，`./host` 入口只剩误导。
  assert.equal(pkg.exports['./host'], undefined,
    '不得恢复 `./host` 子路径入口：宿主角色已由默认入口按 toolName 分派，'
    + '留着它只会让人以为还有第二个入口');
  // 分派前提：入口源码里必须真的按 toolName 分叉（删掉分派等于宿主行去注册工具）。
  const code = stripComments(read('lib/index.js'));
  assert.match(code, /rawConfig\?\.toolName === undefined/, '入口必须按 toolName 缺省分派宿主角色');
  assert.match(code, /applyHostHalf\(ctx, rawConfig\)/, '宿主角色必须分派到 lib/host.js 的 applyHostHalf');
});

test('T3（R10）：改设置后模型看到的数字真的跟着变（行为差异，不是文本匹配；0.1.7 英文锚）', async (t) => {
  // 宿主入口（lib/index.js → ask-takeover.js → @deepseek-ai/dsh-llm）在离线环境
  // 不可解析时跳过——jobs/wait-job/wait-agent 本身离线可跑，但本用例的核心判据
  // （refreshToolDescriptions 的行为）依赖宿主入口，跳过即丢判据，交给 test:inproc。
  const hostIndex = await loadOfflineSafe('../lib/index.js');
  if (hostIndex === undefined) { t.skip('宿主包不可解析（离线环境），本用例跳过'); return; }
  // 这条替换掉了原来的"源码里出现 makeConfigView"式断言：实现审查 R5 的 P1-1 指出，
  // 那种文本匹配在把实现退化成构造时快照后**仍然全绿**——它对行为一无所知。
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
    // 锚④（§24.2）：尾部摘要的等待区间（waitDigest 拼出，以 `;` 结尾）。
    const topRange = /Wait budgets must be passed explicitly, range (\d+)–(\d+) ms;/.exec(tool.description);
    assert.deepEqual([topRange?.[1], topRange?.[2]], ['250', '130000'], `${name}：尾部摘要的等待区间必须更新`);

    // ── **正文那处**必须单独断言（漏掉它换来过一次真机缺陷）──────────────────
    //
    // 模型实际读到的是**正文**——各工具的正文形态不一样，断言不能一刀切：
    //
    // | 工具 | 正文里有 | 英文锚 |
    // |---|---|---|
    // | `async_wait_job` / `async_wait_agent` | 等待区间 | 锚① `wait_ms is required, range N–M ms` |
    // | `async_run` | **只有让出区间** | 锚② `Yield budget bounded to N–M ms` |
    // | `async_agent` | 都没有 | 只在尾部摘要有等待区间（⑤ 是 provider 名） |
    if (name === 'async_run') {
      const yieldBody = /Yield budget bounded to (\d+)–(\d+) ms/.exec(tool.description);
      assert.deepEqual([yieldBody?.[1], yieldBody?.[2]], ['1000', '120000'],
        'async_run：正文里的**让出**区间必须更新成让出预算的值，不能写成等待预算');
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
  // 交给工厂。变异 M3（把 `configView` 换成 `initial`）在行为测试里逃逸过——因为它直接
  // 调工厂、绕过了接线，而工厂拿到的 Proxy 与快照在那条路径上读到相同的初始值。
  const wiring = stripComments(read('lib/index.js'));
  assert.match(wiring, /const configView = makeConfigView\(\(\) => readSnapshot\(\) \?\? initial\)/,
    '必须构造"快照优先、本行默认值兜底"的活取值视图');
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
  // 就地刷新**不碰工具表**：源码里不该再出现"先注销再注册"那条有窗口的路径。
  const code = stripComments(read('lib/index.js'));
  assert.doesNotMatch(code, /disposeTool\(\);\s*\n\s*register\(\);/,
    '不得用"先注销再注册"刷新描述——register 抛错会让工具凭空消失');
  assert.match(code, /refreshToolDescriptions\(tool, configView\)/, 'onSettingsChanged 回调里必须调用就地刷新');
});

test('T5（R10/R6/R24·0.1.7）：单包两形态正确——bundle 补丁数组、宿主行不带 toolName、卡片挂 plugins.bundle.config keyed 槽', () => {
  const pkg = JSON.parse(read('package.json'));

  // ① 包名必须是**平名**：`dsh-client-modules` 只把平名包纳入客户端模块图
  // （`dsh-client-modules/lib/index.js:132-138`、`:683`、`:779`）。
  assert.equal(pkg.name, 'dsh-async-tools', '包名必须是平名（不含 `/`）');
  assert.ok(!pkg.name.includes('/'), '包名含 `/` 会被 dsh-client-modules 静默跳过');

  // ② bundle 声明（0.1.7：**数组**，宿主行补丁 + 两份预设补丁；R26 起第三项为
  //    异步创造模式补丁）。
  //    进了 `dsh.profile.bundles` 却没有 `dsh.bundle` 的话，`dsh-app-boot` 会
  //    **直接启动失败**（不是静默）。
  const patches = pkg.dsh?.bundle?.patch;
  assert.ok(Array.isArray(patches), `dsh.bundle.patch 必须是数组（0.1.7 三份补丁），实得 ${typeof patches}`);
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
  // 工具行，宿主平面的工具进全局工具层（R4）。注释里的字样不算（先剥掉 YAML 注释行再查）。
  const patchCode = read('cordis.patch.yml')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const insertCount = (patchCode.match(/-\s*id:/g) ?? []).length;
  assert.equal(insertCount, 1, `宿主 patch 必须只插一行，实际 ${String(insertCount)} 行`);
  assert.match(patchCode, /id:\s*async-tools-host/, '宿主行 id 必须是 async-tools-host');
  assert.match(patchCode, /name:\s*dsh-async-tools\s*$/m, '宿主行名必须是平名 dsh-async-tools');
  assert.doesNotMatch(patchCode, /toolName/, '宿主行不得带 toolName——带了就变成工具行，工具会泄漏进全局工具层（R4）');

  // ⑤ 卡片挂插件管理页的 **`plugins.bundle.config`** keyed 槽（R24 / §7.1-D13）：
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
  // R27 起表单本体是官方 `SettingsFormModel`（scope = 控制器），重渲染走模型的快照店 +
  // `useSyncExternalStore`——订阅责任从卡片手写 effect 移到模型构造里。
  assert.match(client, /ctx\.configForms\.get\(ENTRY\)/, '表单必须由卡片自取控制器');
  assert.match(client, /new P\.SettingsFormModel\(scope, makeSpecs\(\)\)/,
    '控制器必须交给官方 SettingsFormModel（R27：暂存/差集/保存语义不自绘）');
  assert.match(client, /useSyncExternalStore\(card\.store\.subscribe, card\.store\.getSnapshot\)/,
    '卡片必须订阅模型的快照店（bind 的 store）重渲染——不订阅就停在旧值');
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
  // 改为"整份文件里不出现 JSX 形态的标签"，用变异 M9 验证过它真能失败。
  assert.doesNotMatch(client, /<[A-Za-z][A-Za-z0-9]*(\s[^<>]*)?\/?>/, '不得出现 JSX 标签');
});

test('T7（R10）：校验只有一套判据 —— 非法值必须在 schema 层被拒', () => {
  // 缺陷形态（实现审查 R5 的 P1-3）：`Config` 的数值字段曾没有下界约束，于是
  // ① 设置页放行 `-1` / `0` / 空串；② 运行时 `resolveConfig` 才抛错并被吞掉。
  // 修法是把约束放进 schema —— 它同时就是设置页逐字段校验用的那份 schema。
  return import('../lib/config.js').then(({ Config }) => {
    // ⚠️ **每个 patch 都必须带上 `toolName`**，否则 `toolName` 的 `.required()` 会让
    // **每一条**都抛错——于是本用例变成恒真：它测的就成了"缺字段会被拒"，
    // 而不是"这一条约束会被拒"。这类"判据因为别的原因也成立"的坑本项目踩过多次。
    //
    // 反向那组同样要带：原来靠 `toolName` 的 `.default('async_run')` 兜着，现在没有兜底了。
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

    // 单包化：宿主行没有 toolName，`Config` 必须放行（角色分派的前提），
    // 且**不得回填默认值**——默认值会让宿主行静默变成工具行，把工具泄漏进全局工具层（R4）。
    const empty = Config({});
    assert.equal(empty.toolName, undefined,
      '缺省 toolName 必须保持缺省（= 宿主角色），不得回填任何默认值');
  });
});

test('T7b（R10）：跨字段约束必须覆盖**每一个**默认值字段（活路径直测）', async () => {
  // 缺陷形态（实现审查 R6 的 P1-3 残余）：只查了 `defaultYieldMs` 落在区间内，
  // 漏了 `defaultWaitMs`。后果是设置页放行 `defaultWaitMs: 999999`、存进设置文档，
  // 然后在某次 async_wait_job 调用里被夹紧——使用者看到的是"我设了但没效果"。
  //：0.1.5 的独立模块 lib/validate-config.js 是无调用点的死代码（resolveConfig
  // 自己内联了判据），本用例改为直测**活路径** resolveConfig——连同 assertCrossFieldOrder
  // 的导出面（探针直测入口）一起钉住单一事实源。
  const { resolveConfig, assertCrossFieldOrder } = await import('../lib/config.js');
  const base = {
    defaultYieldMs: 5,
    minYieldMs: 1,
    maxYieldMs: 10,
    defaultWaitMs: 5,
    minWaitMs: 1,
    maxWaitMs: 10,
    // R29-d：pollIntervalMs 受 maxWaitMs 配对约束——基准必须显式给值
    // （缺省会回默认 500，撞上本基准的 maxWaitMs: 10）。
    pollIntervalMs: 5
  };
  assert.doesNotThrow(() => resolveConfig({ ...base }), '合法的基准配置必须通过 resolveConfig');
  assert.doesNotThrow(() => assertCrossFieldOrder(base), '同一份判据（导出面）对合法配置必须通过');

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

test('T8（R10·0.1.7）：volatile 提交失败必须**响亮**，不能静默退回', () => {
  const code = stripComments(read('lib/settings.js'));
  // 快照缺席（宿主行未装载）可以安静退回（工具行有 stderr 通告）；但"提交后自检失败"
  // 必须 warn + stderr 说明——否则用户看到"保存成功"而行为停在旧值（0.1.5 修掉的缺陷形态）。
  assert.match(code, /volatile 提交后配置自检失败/, '刷新失败必须 warn 说明是哪次提交没生效');
  assert.match(code, /volatile 提交未生效/, '还必须有 stderr 审计行（emitLifecycleNotice）');
  const warnCount = (code.match(/logger\?\.warn\?\./g) ?? []).length;
  assert.ok(warnCount >= 1, 'lib/settings.js 里必须至少有一条 warn（非法值路径）');
});

test('T9（R10/R27·0.1.7）：保存语义由官方模型承担——布尔为假即失败且草稿保留；恢复默认只暂存', async () => {
  // 0.1.5/0.1.6 的缺陷形态（实现审查 R5 的 P1-2）：宿主 `mutate()` 在 `!response.ok` 时
  // 只恢复读然后返回布尔假，**不抛错**——卡片自绘的 try/catch 永远不进 catch，用户看到
  // 成功提示而写入已被拒绝。R27 起保存语义整体交给官方 `SettingsFormModel`（裁决 C）：
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

  // ① 装配断言（§29.4）：specs 的字段键集合与 FIELDS 逐项相等——漏一个字段即红。
  const specs = product.makeSpecs();
  assert.deepEqual(specs.map((spec) => spec.field), product.FIELDS.map((field) => field.key),
    'specs 的字段键集合必须与 FIELDS 逐项相等（顺序也一致——保存的 op 顺序随之确定）');

  // ② 假 scope 必须给**完整** SettingsFormScope：模型构造时就 `scope.subscribe(...)`，
  //    缺 `subscribe` 必须当场抛错（"假件不许宽容"的一处落点，§29.4 接线）。
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
  //    ⚠️ 官方 `actions().save` 是按钮接线的即发即弃形态（不返回 Promise）；可等待的
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

test('T9b（R10/R27·0.1.7）：成功回填生效值、失败保留草稿；卸载丢弃草稿', async () => {
  // 旧判据（"先拒绝分支再清草稿/宣告成功"的源码顺序）随自绘保存流一起退场（裁决 C/E）。
  // 新口径是**行为**判据：成功 ⇒ 草稿清空、字段由活 section 值回填（宿主静默丢写的
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

  // ③ 卸载丢弃（判据 9 的模型面）：SettingsForm 卸载时调 onDiscard（接线在卡片），
  //    模型的 discard 清空暂存 ⇒ 字段回到生效值。真机的"离开页面再回来"由 e2e 验。
  actions.edit('jobKind', 'to-be-discarded');
  assert.equal(store.getSnapshot().shell.dirty, true, '丢弃前必须有暂存（本用例的驱动必须真的改过）');
  actions.discard();
  const discarded = store.getSnapshot();
  assert.equal(discarded.jobKind.text, 'new', '丢弃后字段回到生效值（暂存清空、由 section 回填）');
  assert.equal(discarded.shell.dirty, false, '丢弃后不再 dirty');
  model.dispose();
});

test('T10（R10·0.1.7）：宿主平面的 volatile 提交必须真的到达预设工具的描述', async (t) => {
  // 缺陷形态（实现审查 R6 对 P1-1 的复核）：就地刷新函数没问题，但**触发通道不存在**。
  // 0.1.7 的通道是：设置表单提交 → loader 就地提交 fiber config → 向宿主行 fiber 派发
  // `loader/volatile-update` → 快照重播 + refresh-bus 广播 → 工具行就地刷新描述。
  //
  // 这条用例走**真实 cordis 链路**：两个平面各自装载（工具行带 toolName、宿主行不带），
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
    // R13 模型选择的第七服务：挂载级假件只需"无 policy"初值形态。
    sessionProjections: { stateOf: () => null },
    logger: { info() {}, warn() {}, debug() {} }
  };

  const mount = async (ctx, plugin, config) => {
    const fork = ctx.plugin(plugin, config);
    for (let turn = 0; turn < 64 && fork.state !== 2; turn += 1) await Promise.resolve();
    return fork;
  };

  // ① 预设平面（工具行）：快照缺席是合法状态——工具退本行默认值（stderr 通告）。
  const presetCtx = new Context();
  for (const [name, value] of Object.entries(services)) presetCtx.provide(name, value);
  const presetFork = await mount(
    presetCtx,
    { name: preset.name, inject: preset.inject, Config: preset.Config, apply: preset.apply },
    { toolName: 'async_run' }
  );
  assert.equal(presetFork.state, 2, '预设平面必须激活');
  const tool = registeredTools.get('async_run');
  assert.ok(tool !== undefined, '工具必须注册');
  assert.ok(bus.listenerCount() >= 1, '预设平面装载后登记表里必须有刷新回调');
  assert.match(tool.description, /Yield budget bounded to 1000–600000 ms/, '快照缺席时描述用本行默认值');

  // ② 宿主平面（同一插件、行配置没有 toolName）：首播快照。
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
    'fiber.config 的 volatile 字段必须是 Ref（Schema.resolve 包的 createVolatile）——不是的话就地提交链路不成立');
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
  const range = /Wait budgets must be passed explicitly, range (\d+)–(\d+) ms;/.exec(tool.description);
  assert.deepEqual([range?.[1], range?.[2]], ['250', '130000'], '描述里的等待区间必须更新');
  assert.match(String(tool.parameters.properties.yield_ms.description), /Defaults to 5000/,
    '参数说明也必须更新');

  // ④ 一个回调抛错不得让整条通知停摆，也不得冒泡进宿主上下文。
  const offBad = bus.onSettingsChanged(() => { throw new Error('故意失败'); });
  assert.doesNotThrow(() => hostFork.ctx.emit('loader/volatile-update'), '通知不得冒泡');
  offBad();

  // ⑤ 卸载：宿主行卸载清快照（R17），工具行卸载注销刷新回调。
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
  // ② 单包化后不得残留对已删除宿主包的任何依赖引用——残留等于"装不上还挂着名"。
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
    '不得依赖已删除的宿主包 dsh-async-tools-host');
  assert.equal(mainPkg.peerDependencies?.['dsh-async-tools-host'], undefined,
    '同上：peerDependencies 也不得残留');
});

test('T13（R6·0.1.7）：静态 inject 七服务；设置链不引入任何服务依赖', () => {
  // 唯一的静态 `inject` 在 `lib/index.js`（工具角色的七个硬依赖，宿主行共用；
  // `sessionProjections` 是 R13 模型选择的白名单读取）。
  // `settings` / `agentPresets` 不得出现在其中：写了就等于要求"这个部署必须有它们"，
  // 缺一个就让整行不激活 → 升级成 dsh 启动失败。0.1.7 的设置快照链**不依赖任何
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
  // 0.1.7 的宿主半边没有 `ctx.get`（设置快照不查服务）、也不等任何服务；R28 起有
  // 运行时 `ctx.inject`：纪律段的 `systemPrompt`（§30.3 c 防线）与 R30 提问接线的
  // 三服务段（§32.2：ask 批次登记要读会话/投影/子代理）。静态 inject 列表依旧不动、
  // 快照链依旧零服务依赖。除此之外的任何服务等待仍然禁止——`settings`/`agentPresets`
  // 那类"缺服务整行不激活"的等待形态没有回潮的理由。
  const hostCode = stripComments(read('lib/host.js'));
  const hostInjects = [...hostCode.matchAll(/ctx\.inject\(\s*(\[[^\]]*\])/g)].map((m) => m[1]);
  assert.deepEqual(hostInjects, ["['systemPrompt']", "['sessions', 'sessionProjections', 'agents']"],
    '宿主半边只允许 R28 纪律段与 R30 提问接线两个运行时注入；其余服务等待仍禁止（快照链零服务依赖）');
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

test('T16（R21/R24·0.1.7）：plugins.bundle.config keyed 槽契约 + 毫秒换算秒读数', async () => {
  // 0.1.7 的卡片壳（标题/图标/面包屑/折叠）由宿主画，本组件只出 summary/page 两个视图；
  // 0.1.5 的"自绘折叠壳"判据随形态一起退场——折叠语义由宿主提供，视觉探针在真机上验。
  const code = clientCode();

  // ① 视图分派：`page` 渲染表单（bundle 槽只请求这一个视图），其余视图给一句话兜底。
  assert.match(code, /props\.view !== "page"/, '必须按 view 分派：page 出表单、其余出 summary 一句话');
  // loading/unavailable/只读三种态都由官方 `SettingsForm` 渲染（裁决 A/E）：
  // `!state.available` → `labels.unavailable`，`!state.writable` → `labels.readOnly`。
  // 行为面在 T18 里用 loading 快照验（渲染出 unavailable 文案而不是白屏）。
  assert.match(code, /unavailable: t\("unavailable"\)/, '不可用态文案必须交给官方框架渲染（labels.unavailable）');
  assert.match(code, /readOnly: t\("readOnly"\)/, '只读态文案必须交给官方框架渲染（labels.readOnly）');
  // ② R21/R27：两段读数的**行为面**在 T18 与 ③-b 里判（按 ` · ` 切段、随键入实时、
  //    亚 10 ms、空姿态）；这里只保留接线锚——说明行由 `composeHint` 单点拼出
  //    （它拿得到生效值与暂存文本两个输入，缺一个输入段就无从谈起）。
  assert.match(code, /var hint = composeHint\(t, field, state\.effective\[field\.key\], fieldState\.text\);/,
    '说明行必须由 composeHint 以（生效值, 暂存文本）两输入拼出——输入段才有数据源');

  // ③ formatSeconds 行为（浏览器外可验证）：整数秒不带小数，小数保留两位，亚 10 ms
  //    显示 `< 0.01 s`（R27 + 用户裁定：值只写秒文本——毫秒原值输入框里
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

  // ③-b composeHint 行为（两段形状、换行、分隔符、秒文本值、空姿态——§29.4 单测项）：
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
    assert.ok(shape.inClass.includes('ats-sec-invalid'), `${bad} → 输入段带非法标记（颜色面走 state-error）`);
    assert.equal(shape.eff, 'readout.effective|0.5 s', `${bad} → 生效段仍在`);
  }
  assert.deepEqual(product.draftReadout('4321'), { fill: '4.32 s', invalid: false }, 'draftReadout：正数 → 秒文本');
  assert.deepEqual(product.draftReadout(''), { fill: '—', invalid: false }, 'draftReadout：空 → — 不标非法');
  assert.deepEqual(product.draftReadout('abc'), { fill: '—', invalid: true }, 'draftReadout：非数字 → — 标非法');
  assert.equal(product.ENTRY, 'async-tools-host', 'ENTRY 导出必须等于宿主行 id（三同串）');

  // ④ 槽位注册的**运行期**判据（R24）：静态 grep 只能证明"源码里出现过某个词"，
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
    // R30：ask 接线的两个 effect 需要 remote（$mount 挂命名空间）与 uiWorkspace（跳转动作）。
    remote: { $mount: function () { return Promise.resolve(function () {}); } },
    uiWorkspace: { openSession: function () {} },
    // R30 真机轮：ask 座位在 $mount 落地后经**动态** ctx.inject(['remote.async-tools-ask'])
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
  // R30 起 apply() 注册**三**个座位：设置卡 + ask overlay + ask sidebar（后两个默认关——
  // 计数 0 时组件渲染 null，注册本身在场是 R30 零行为口径的一部分：渲染 null = 无行为）。
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
 * / `useRef` / `useSyncExternalStore`（R27 起 `useSyncExternalStore` 订阅模型的快照店，
 * `useRef` 承载卡片模型句柄与官方表单的卸载丢弃）。
 *
 * 为什么需要它：`page` 视图的值来自 `ctx.configForms.get(ns)` 的控制器（bundle 槽**不传**
 * `form`），静态断言最多只能说"源码里没有 `props.form` 这个词"，说不出"用控制器
 * 渲染真的出全部字段、保存真的走 mutate"。而组件真去读 `props.form` 时不抛错——
 * 它只是渲染出一张空卡，本机测试若不渲染就看不见。
 *
 * **hook 存储按组件函数分槽**：卡片组件自己也有 hook（模型句柄、订阅、卸载清理），
 * 与表单组件共用一个游标会互相踩（两个组件的 `hooks[0]` 互相覆盖）。
 *
 * `useSyncExternalStore(subscribe, getSnapshot)`：订阅一次（存 disposer），快照由监听器
 * 就地刷新——重渲染由测试显式驱动（renderCard 再调一次组件函数）。
 *
 * @returns {{react: object, begin: Function, flush: Function, unmount: Function}} 替身与驱动。
 */
function makeReactShim() {
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
        // ⚠️ 捕获**本次渲染所属组件**的 hook 槽：setter 在渲染之后才被调用（事件、effect、
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
        // 这类泄漏在替身里完全不可见（`` N4）。
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
    begin(component) {
      cursor = 0;
      queued = [];
      current = component;
      if (!stores.has(component)) stores.set(component, []);
      store = stores.get(component);
    },
    flush() { const run = queued; queued = []; for (const effect of run) effect(); },
    // 卸载：跑**所有**已挂载组件的 effect cleanup（含官方表单的卸载丢弃）并解订阅，
    // 销毁 hook 状态——下一次 begin 同名组件等于一次全新挂载（真 React 的卸载语义）。
    unmount() {
      for (const slots of stores.values()) {
        for (const slot of slots) {
          if (slot && typeof slot.cleanup === 'function') slot.cleanup();
          if (slot && typeof slot.disposer === 'function') slot.disposer();
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

test('T18（R24/R27）：官方表单形态——字段面/说明行/门控/失败态/恢复默认/卸载丢弃', async () => {
  const { react, begin, flush, unmount } = makeReactShim();
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const double = makePrimitivesDouble(react);
  const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
  let loaded;
  new Function('window', source)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? react : double));

  // 控制器替身：真实面是 `ctx.configForms.get(<entryId>)` 返回的 `ConfigFormController`
  // （`getSnapshot` / `subscribe` / `mutate`）。假件必须给**完整** SettingsFormScope
  // ——模型构造时就 subscribe（T9 ② 验过缺面会抛错）。value 层给**全字段**（真机的
  // schema-resolved section 总是全字段——毫秒说明行的读数才有东西可换算）。
  const DEFAULTS = {
    defaultYieldMs: 20000, minYieldMs: 1000, maxYieldMs: 600000,
    defaultWaitMs: 30000, minWaitMs: 250, maxWaitMs: 600000,
    pollIntervalMs: 500, maxResultChars: 30000,
    jobKind: 'async-command', subagentProvider: '', uiLang: 'auto', agentLang: 'en',
    silentFailureGuard: false,
    askTakeover: false, askTimeoutMs: 60000, askUiSeat: 'overlay'
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
    // R30：ask 接线需要 remote（$mount）与 uiWorkspace（跳转动作，惰性调用）。
    remote: { $mount: () => Promise.resolve(() => {}) },
    uiWorkspace: { openSession: () => {} },
    // R30 真机轮：ask 座位经 $mount 后的动态 ctx.inject 装配（注入即回调）。
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
      begin(component);
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
  //    判据 1（§29.3）：四组全部字段逐项在场，id = `plugin-config-<键>`。
  let tree = renderCard();
  // R30 起 `configForms.get` 被调**两次**：ask 模型在 apply 期取一次（待答界面），
  // 卡片模型在挂载期取一次——两次都必须按 entry id（不是按包名）。
  assert.deepEqual(asked, ['async-tools-host', 'async-tools-host'], 'ask 模型与卡片都必须按 entry id 向 configForms 取控制器（不是按包名）');
  assert.equal(listeners.length, 2, '卡片模型与 ask 模型各订阅控制器恰好一次（bind 一次 + 订阅一次）');
  const inputs = collectByType(tree, 'input');
  const selects = collectByType(tree, 'select');
  // R30 起：11 个值字段（10 预算 + askTimeoutMs）、3 个枚举下拉（两语言 + askUiSeat）。
  assert.equal(inputs.length, 11, '十一个值字段必须以官方 input 在场（10 预算 + R30 askTimeoutMs）');
  assert.equal(selects.length, 3, '三个枚举字段必须以 select 在场（两语言 + R30 askUiSeat；控件本体自绘，裁决 B）');
  // R28/R30 的两个布尔开关：控件本体是官方 Switch（偏离 ③，可见标签长在壳上），
  // 不进 input/select 的 id 清单——按无障碍面（role/aria-label/aria-checked）钉在场。
  const switchButtons = collectByType(tree, 'button').filter((node) => node.props.role === 'switch');
  assert.equal(switchButtons.length, 2, 'silentFailureGuard 与 askTakeover 必须以 role=switch 的按钮在场');
  assert.equal(switchButtons[0].props['aria-label'], 'silentFailureGuard|',
    '开关的无障碍名 = 可见标签（桩词典约定键 + \'|\'）');
  assert.equal(switchButtons[0].props['aria-checked'], false, '默认关：无覆盖时开关显示生效姿态 false');
  assert.equal(switchButtons[1].props['aria-label'], 'askTakeover|',
    'R30 总开关同形：无障碍名 = 可见标签');
  assert.equal(switchButtons[1].props['aria-checked'], false, 'R30 总开关默认关（零行为硬边界的界面面）');
  // 开关字段的说明行与值/枚举字段同形（p + id），文案走同一条 hint 通道——在此钉住，
  // 补足 ② 循环豁免后的结构面覆盖。
  const flagMessage = findNode(tree, (node) =>
    node.type === 'p' && node.props.id === 'plugin-config-silentFailureGuard-message');
  assert.ok(flagMessage !== undefined, '开关字段必须有说明行（判据 2 的结构面同形）');
  assert.ok(String(flagMessage.props.children).includes('hint.silentFailureGuard|'),
    '开关说明行必须带该字段的说明文案');
  const expectedKeys = product.FIELDS.map((field) => field.key);
  // R30 的 askTimeoutMs（input）排在语言枚举（select）之后，DOM 收集是「全部 input
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
    [['auto', 'zh', 'en'], ['en', 'zh'], ['overlay', 'sidebar']], '选项集就是契约（写错值宿主会 fail-fast；R30 座位枚举殿后）');
  assert.equal(inputById(tree, 'plugin-config-uiLang').props.value, 'auto',
    '无覆盖时下拉显示生效值（不是空选项—— N2 的缺陷形态，硬条目①）');

  // ② label↔id 绑定 + 说明行（判据 2 的结构面；0.5px 分隔线是计算样式，真机探针验）。
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
  // 毫秒字段的说明行带**两段**读数（裁决 D / 判据 10 / 用户裁定）：字段说明
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
  assert.equal(poll().line, 'invalidNumber|',
    '非数字 → 字段非法态接管说明行（官方字段把 hint 换成原因文案——整行没有秒数，不给误导性读数）');
  assert.equal(poll().eff, undefined, '非法态说明行不得残留任何读数段');
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: '0' } });
  tree = renderCard();
  assert.equal(poll().eff, 'readout.effective|0.5 s', '0（可解析、非正数、不触发 parse 非法）：生效段仍在');
  assert.equal(poll().input, 'readout.input|—', '0 → 输入段 — 占位（不残留旧读数、不给秒数）');
  assert.ok(poll().inClass.includes('ats-sec-invalid'), '0 → 输入段带非法标记（与空姿态可区分）');
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: '' } });
  tree = renderCard();
  assert.equal(poll().input, 'readout.input|—', '清空 → 输入段 — 占位');
  assert.ok(!poll().inClass.includes('ats-sec-invalid'), '清空不是非法（清除覆盖的意图），不得标红');
  // 收尾：改回生效值（stage 清掉非法态与草稿），后续用例从干净状态出发。
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: '500' } });
  tree = renderCard();

  // ③ 保存门控与往返（判据 5/8）：无改动 ⇒ 保存禁用；改动 ⇒ 恰一次 mutate。
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
  assert.match(String(findNode(tree, (node) => node.type === 'p' && node.props.id === 'plugin-config-pollIntervalMs-message').props.children),
    /invalidNumber\|/, '说明行必须切换为非法原因文案');
  assert.equal(badInput.props['aria-describedby'], 'plugin-config-pollIntervalMs-message',
    '非法态的 aria-describedby 仍指向同一说明行');
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

  // ⑦ 卸载丢弃（判据 9）：① 接线面——SettingsForm 收到的 onDiscard 必须真的是模型的
  //    discard（清得掉暂存；换成 noop 这条就红）；② 观察面——改字段不保存 → 卸载 →
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
  // 观察面：再次暂存 → 整树卸载 → 重新挂载。
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

  // ⑧ 订阅纪律：挂载时恰好两个 scope 订阅（卡片 + R30 ask 模型），卸载解掉、重挂
  //    再建（不累积）。
  assert.equal(listeners.length, 2,
    '订阅必须只建立一次（卡片与 ask 各一）——每次渲染都重订阅会在真机上累积监听器（泄漏）');
});

test('T22（R25）：改语言后刷新必须整段换文案——正文、尾部摘要与每个参数说明一起换', async (t) => {
  // 描述刷新从"锚点就地改数字"改成"整段重建"（design §27.3）之后，语言与数字走同一条路。
  // 这条钉两件事：①换语言真的换的是**整段**（只换数字不算）；②换语言不会把"数字跟着设置走"
  // （R5）弄丢——zh 档下的区间同样必须更新。真机判据见 `verify/probe-lang-independence.mjs`。
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
  assert.match(paramText(), CJK, 'zh 档参数说明必须一起换（参数面不能留在英文）');

  // 数字链不能因为换语言断掉：zh 档下正文与参数说明的区间都要跟着快照更新。
  current = { ...current, maxYieldMs: 120000 };
  refreshToolDescriptions(tool, view);
  assert.match(tool.description, /1000–120000 ms/, 'zh 档正文里的让出区间仍要跟着设置更新');
  assert.match(paramText(), /1000-120000/, 'zh 档参数说明里的区间仍要跟着设置更新');

  // 展示面开关与模型面无关：改 `uiLang` 不得动描述（互不牵连的单元侧最小证据）。
  const zhDescription = tool.description;
  current = { ...current, uiLang: 'en' };
  refreshToolDescriptions(tool, view);
  assert.equal(tool.description, zhDescription, '改 uiLang 不得影响模型面描述');
});

test('T19（R21/R24/R25）：字段表单一来源——client.js 的 FIELDS 与 lib/config.js 逐项一致', async () => {
  // 两条钉的是"字段面"的**单一来源**：界面判据拿 `BUDGET_FIELD_KEYS` + `LANG_FIELD_KEYS` 去核对页面
  // （`judgeConfigForm` 的字段身份那一条），而页面渲染哪些字段、哪几个带读数由 `client.js` 的
  // `FIELDS` 决定。两侧漂移时，"字段缺项 / 读数挂错字段"永远抓不到——判据会与被测实现一起错。
  const { MS_FIELD_KEYS, BUDGET_FIELD_KEYS, LANG_FIELD_KEYS, FLAG_FIELD_KEYS, ASK_FIELD_KEYS } = await import('../lib/config.js');
  let loaded;
  new Function('window', clientCode())({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory(() => ({ createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {} }));

  assert.deepEqual(product.FIELDS.map((field) => field.key),
    [...BUDGET_FIELD_KEYS, ...LANG_FIELD_KEYS, ...FLAG_FIELD_KEYS, ...ASK_FIELD_KEYS],
    'client.js 的字段顺序必须是 预算字段 + 语言字段 + 开关字段 + 提问字段（R30 把可编辑字段从 13 个扩到 16 个）');
  assert.deepEqual(product.LANG_KEYS, [...LANG_FIELD_KEYS], 'client.js 的语言键表必须与 LANG_FIELD_KEYS 一致');

  const declared = [...clientCode().matchAll(/key: "([A-Za-z]+)", label: "[A-Za-z]+", ms: true/g)]
    .map((m) => m[1]);
  assert.deepEqual(declared, [...MS_FIELD_KEYS],
    'client.js 里 `ms: true` 的字段必须与 MS_FIELD_KEYS 逐项一致（顺序也要一致）');
  assert.ok(MS_FIELD_KEYS.length > 0 && MS_FIELD_KEYS.length < BUDGET_FIELD_KEYS.length,
    '毫秒字段必须是非空真子集：等于全集时"读数挂错字段"这条判据恒真');
});

test('T21（R25）：展示面语言开关——auto 跟随宿主、zh/en 用本包词典、缺键回退宿主', () => {
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

  // 两个开关各自的取值面：选项集就是契约（写错一个值 → 宿主 fail-fast，见 lib/config.js）。
  const byKey = Object.fromEntries(product.FIELDS.map((field) => [field.key, field]));
  assert.deepEqual(byKey.uiLang.options, ['auto', 'zh', 'en'], 'uiLang 的选项面');
  assert.deepEqual(byKey.agentLang.options, ['en', 'zh'], 'agentLang 的选项面（模型面只有两档）');

  // 生效值的判定：用户层优先，其次实时值，未知值当 auto（不把脏值当语言用）。
  assert.equal(product.uiLangOf({ user: { uiLang: 'en' }, value: { uiLang: 'zh' } }), 'en', '用户层优先');
  assert.equal(product.uiLangOf({ user: {}, value: { uiLang: 'zh' } }), 'zh', '其次实时解析值');
  assert.equal(product.uiLangOf({ user: {}, value: {} }), 'auto', '都没有 → auto');
  assert.equal(product.uiLangOf({ user: { uiLang: 'fr' }, value: {} }), 'auto', '未知取值 → auto（不猜）');

  // 两档词典的键集必须相等：少一个键就是少一句界面文案（与模型面表的同一条纪律）。
  assert.deepEqual(Object.keys(product.DICTIONARIES.zh).sort(), Object.keys(product.DICTIONARIES.en).sort(),
    'zh/en 词典键集必须相等');
});

test('T17（R10·复审 Z4）：预算默认值本身也要钉住——改错一个只会静默改变工具行为', async () => {
  // 复审 Z4 实测：把 `maxResultChars` 30000→99999、`pollIntervalMs` 500→999，
  // **当时的离线口径全绿逃逸**。后果是静默的行为改变：默认让出预算、轮询间隔、
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
    // §18.3（R13）：async_agent 的子代理后端默认值（审查 D3——加字段必须
    // 同步往期望表加行，不是把字段挪出解析面消红）。
    subagentProvider: 'spawn',
    // §27.1（R25）：两个语言字段的出厂默认值（uiLang 跟随宿主；agentLang 英文为默认档）。
    uiLang: 'auto',
    agentLang: 'en',
    // §30.3（R28）：静默失败防线开关出厂**默认关**——默认值翻成 true 等于未经用户
    // 同意就给所有会话注入纪律段（判据 13 的缺省方向在这里钉死）。
    silentFailureGuard: false,
    // §32.1（R30）：提问接管三件出厂默认——总开关**默认关**（关时零行为是硬边界）；
    // 窗口 60000 ms；座位 overlay。默认值翻成 true 等于未经用户同意就劫持提问通道。
    askTakeover: false,
    askTimeoutMs: 60000,
    askUiSeat: 'overlay'
  };
  for (const [key, want] of Object.entries(EXPECTED_DEFAULTS)) {
    assert.equal(resolved[key], want,
      `\`${key}\` 的默认值必须是 ${JSON.stringify(want)}——`
      + `改错它不会让任何行为报错，只会静默改变工具行为（复审 Z4：30000→99999 曾全绿逃逸）`);
  }
  assert.deepEqual(Object.keys(EXPECTED_DEFAULTS).sort(), Object.keys(resolved).filter((key) => key !== 'toolName').sort(),
    '期望值表必须覆盖**每一个**预算字段——漏掉一个就等于那个字段的默认值没人守');
});

test('T20（R25）：agentLang 双档——en 零 CJK、zh 换语言、参数面不变、缺译抛错', async () => {
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
    // ③ 语言只换文案，不改参数面：两档的参数键集合相同。
    assert.deepEqual(
      Object.keys(zhTool.parameters.properties).sort(),
      Object.keys(tool.parameters.properties).sort(),
      `${name} 两档的参数键集合必须相同（语言不改参数面）`
    );
  }

  // ④ 未知键必须抛错：静默返回空串会让缺译看不见（§27.2）。
  assert.throws(() => t('zh', 'no.such.key'), /missing text key/,
    't() 对未知键必须抛错——缺译要当场红，不能静默空串');
  // 构建器同样吃这条纪律（未知工具名是同类缺陷）。
  assert.throws(() => buildToolText('not_a_tool', { agentLang: 'en' }), /unknown tool name/);
});

// ---------------------------------------------------------------------------
// R29（安全/健壮性/异常处理）新增判据：设计 §31.9 判据 8（上界拒绝）与
// 判据 14（卡片层拒绝，复审 N1 挂法）+ 内联常量对账 + settings 悬空 import 防线。
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
  // 复审 N1 的挂法：宿主 SettingsForm 的保存禁用**只认** spec.parse 聚合出的
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

  // 壳层叠加挂法（复审 N1）：配对违例必须叠加进传给 SettingsForm 的 state.invalid，
  // 而不是包 save——这是宿主保存禁用唯一认的因果链。静态钉住（撤掉叠加 → 红）。
  const code = clientCode();
  assert.match(code, /state: \{ \.\.\.state\.shell, invalid: state\.shell\.invalid === true \|\| pairViolated\(state\) \}/,
    'makeBundleCard 必须把配对违例叠加进 SettingsForm 的 state.invalid');
  // 字段显示层：pollIntervalMs 的非法原因文案（invalidRange/invalidPair 分档）。
  assert.match(code, /invalid: fieldState\.invalid === true \|\| pairHit/, 'pollIntervalMs 字节必须叠加 pairHit 显示');
  assert.match(code, /t\("invalidRange"\)/, '越上界要有带 {max} 的原因文案');
  assert.match(code, /t\("invalidPair\.pollIntervalMs"\)/, '配对违例要有专用文案');

  // 词典两语言键集成对（R25 纪律：zh/en 键集一致由 T21 守，这里守新增键的内容面）。
  assert.ok(product.DICTIONARIES.zh['invalidPair.pollIntervalMs'].length > 0, 'zh 配对文案在场');
  assert.ok(product.DICTIONARIES.en['invalidPair.pollIntervalMs'].length > 0, 'en 配对文案在场');
  assert.match(product.DICTIONARIES.zh.invalidRange, /\{max\}/, 'zh invalidRange 必须带 {max} 插位');
  assert.match(product.DICTIONARIES.en.invalidRange, /\{max\}/, 'en invalidRange 必须带 {max} 插位');
});

test('T23c（R29-d）：client 内联上界与 lib/budget-limits.js 对账——只改一处必红', async () => {
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const reactStub = { createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
  const double = makePrimitivesDouble(reactStub);
  let loaded;
  new Function('window', readFileSync(resolve(ROOT, 'client.js'), 'utf8'))({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactStub : double));
  const limits = await import('../lib/budget-limits.js');

  // N2：客户端模块图只投递平名包，client.js 引不到 lib/ 文件——上界只能内联同值。
  // 这条对账断言钉住"内联的一份"与"权威的一份"相等，漂移当场红。
  assert.equal(product.MS_FIELD_LIMIT, limits.MS_FIELD_LIMIT, 'MS_FIELD_LIMIT 两处同值');
  assert.equal(product.RESULT_CHARS_LIMIT, limits.RESULT_CHARS_LIMIT, 'RESULT_CHARS_LIMIT 两处同值');
  assert.deepEqual(product.FIELD_MAX, limits.FIELD_MAX, 'FIELD_MAX 逐键同值');
  // R30：提问窗口上界三面同值（lib 权威 + client 内联 + 词汇常量；下界 10000 由
  // FIELD_MIN 单侧持有——宿主 schema 与 client 解析面各查一次，T-ask 系列验行为）。
  assert.equal(product.FIELD_MAX.askTimeoutMs, limits.ASK_TIMEOUT_LIMIT, 'askTimeoutMs 上界 = ASK_TIMEOUT_LIMIT（600000）');
  assert.equal(product.ASK_TIMEOUT_LIMIT, limits.ASK_TIMEOUT_LIMIT, 'client 的 ASK_TIMEOUT_LIMIT 常量同值');
  assert.equal(product.FIELD_MIN.askTimeoutMs, 10000, 'client 下界 10000（与宿主 schema min 同值）');
  assert.deepEqual(limits.ORDERED_PAIRS.map((pair) => pair.join('=')), ['minYieldMs=maxYieldMs', 'minWaitMs=maxWaitMs', 'pollIntervalMs=maxWaitMs'],
    '配对表内容钉住（增删配对必须连本断言一起改）');
  // client 的 pairViolated 只消费 pollIntervalMs/maxWaitMs 这一对（其余两对由
  // resolveConfig 在宿主侧守——单字段解析通道做不了跨字段，这是 N1 的分工）。
  assert.match(clientCode(), /pairViolated\(state\)[\s\S]*?pollIntervalMs[\s\S]*?maxWaitMs/, '配对判定的键必须钉在 pollIntervalMs/maxWaitMs');
});

test('T8b（R29-a·判据 15 附）：settings 的悬空动态 import 必须 .catch——快照已落，广播失败不得杀实例', () => {
  const code = stripComments(read('lib/settings.js'));
  assert.match(code, /import\('\.\/refresh-bus\.js'\)[\s\S]{0,160}\.catch\(/,
    'refresh-bus 动态 import 链上必须有 .catch（这条 promise 只可能 reject，无人接住 = 整实例退出）');
});
