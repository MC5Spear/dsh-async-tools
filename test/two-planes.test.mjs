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
import { HOST_SKIP_REASON, loadOfflineSafe } from './_host-gate.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const read = (relative) => readFileSync(resolve(ROOT, relative), 'utf8');

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
    /makeConfigView\(\(\) => \{\s*const snapshot = readSnapshot\(\);\s*return snapshot === undefined\s*\?\s*initial\s*: \{\s*\.\.\.snapshot,\s*owningPreset: initial\.owningPreset,\s*\.\.\.\(initial\.agentOptions === undefined \? \{\} : \{ agentOptions: initial\.agentOptions \}\),\s*\.\.\.\(initial\.agentPreset === undefined \? \{\} : \{ agentPreset: initial\.agentPreset \}\),\s*\.\.\.\(initial\.allowedAgentPresets === undefined \? \{\} : \{ allowedAgentPresets: initial\.allowedAgentPresets \}\)\s*\};\s*\}\)/,
    '工具行取值必须是"快照优先、缺快照回退本行默认值"的活视图；快照合并保留本行装载期的 owningPreset 与三个行级委托键（行身份与委托配置都非 volatile、不进宿主行快照，设计 §6.2／§3.3）——漏保留即宿主行在场时自定义行委托配置整组失效');
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
  assert.doesNotMatch(code, /from '\.\/(jobs|wait|wait-job-target|wait-agent-target|agent)\.js'/, '宿主入口不得引入任何工具的工厂');
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
  // 不可解析时跳过——jobs/wait 本身离线可跑，但本用例的核心判据
  // （refreshToolDescriptions 的行为）依赖宿主入口，跳过即丢判据，交给 test:inproc。
  const hostIndex = await loadOfflineSafe('../lib/index.js');
  if (hostIndex === undefined) { t.skip(HOST_SKIP_REASON); return; }
  // "源码里出现 makeConfigView"式文本匹配在把实现退化成构造时快照后
  // **仍然全绿**——它对行为一无所知，本判据必须断言行为。
  const { createRunTool } = await import('../lib/jobs.js');
  const { createWaitTool } = await import('../lib/wait.js');
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
    ['async_wait', createWaitTool(ctx, view), 'wait_ms']
  ]) {
    const topBefore = tool.description;

    current = { ...current, defaultYieldMs: 5000, maxYieldMs: 120000, defaultWaitMs: 7000, maxWaitMs: 130000 };
    refreshToolDescriptions(tool, view);

    assert.notEqual(tool.description, topBefore, `${name}：改设置后顶层描述必须变化（否则模型看到的是过期的上限）`);
    // 锚④：尾部摘要的等待区间（waitDigest 拼出，以 `;` 结尾）——四个等待语义
    // 工具共享同一句，是 wait 范围在描述里的**单点**（正文不再重复第二遍）。
    const topRange = /Per-call wait budgets must be passed explicitly, range (\d+)–(\d+) ms;/.exec(tool.description);
    assert.deepEqual([topRange?.[1], topRange?.[2]], ['250', '130000'], `${name}：尾部摘要的等待区间必须更新`);

    // ── 正文那处必须单独断言（各工具的正文形态不一样，断言不能一刀切）──────
    //
    // | 工具 | 正文里有 | 英文锚 |
    // |---|---|---|
    // | `async_run` | 只有首次等待区间 | `The first wait defaults to N ms (pass yield_ms, range N–M ms)` |
    // | `async_wait` / `async_agent` | 等待区间只在尾部摘要 | 已由锚④覆盖 |
    if (name === 'async_run') {
      const yieldBody = /The first wait defaults to (\d+) ms \(pass yield_ms, range (\d+)–(\d+) ms\)/.exec(tool.description);
      assert.deepEqual([yieldBody?.[1], yieldBody?.[2], yieldBody?.[3]], ['5000', '1000', '120000'],
        'async_run：正文里的**首次等待**数字必须更新成首次等待的值，不能写成单次等待');
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
    /const configView = makeConfigView\(\(\) => \{\s*const snapshot = readSnapshot\(\);\s*return snapshot === undefined\s*\?\s*initial\s*: \{\s*\.\.\.snapshot,\s*owningPreset: initial\.owningPreset,\s*\.\.\.\(initial\.agentOptions === undefined \? \{\} : \{ agentOptions: initial\.agentOptions \}\),\s*\.\.\.\(initial\.agentPreset === undefined \? \{\} : \{ agentPreset: initial\.agentPreset \}\),\s*\.\.\.\(initial\.allowedAgentPresets === undefined \? \{\} : \{ allowedAgentPresets: initial\.allowedAgentPresets \}\)\s*\};\s*\}\)/,
    '必须构造"快照优先、缺快照回退本行默认值"的活取值视图（owningPreset 与三个行级委托键恒取装载期值——设计 §6.2／§3.3）');
  assert.match(wiring, /factory\(ctx, configView\)/, '工厂必须拿到活视图，不能拿构造时的快照');
});

test('T3b（R10）：刷新描述不得抛，也不得悄悄注销工具', async (t) => {
  const hostIndex = await loadOfflineSafe('../lib/index.js');
  if (hostIndex === undefined) { t.skip(HOST_SKIP_REASON); return; }
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
  assert.match(client, /new P\.SettingsFormModel\(view, makeSpecs\(\)\)/,
    '控制器（经 settings 子树→平铺寻址的适配视图）必须交给官方 SettingsFormModel（R27：暂存/差集/保存语义不自绘）');
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
  // 修法是把约束放进 schema —— 它同时就是设置页逐字段校验用的那份 schema
  //（字段校验住进 settings 子树，设计 §5.1）。
  return import('../lib/config.js').then(({ Config }) => {
    // 值字段判据挂在 **settings 子树**上；身份字段（toolName）在根上单独测。
    // 子树基底带 `toolName`：否则宿主行缺省语义混进判据；恒真检查在最后
    //（"基底本身必须通过"——不通过则"必须被拒"那组没有区分力）。
    const rejectsSettings = (patch) => {
      try { Config({ toolName: 'async_run', settings: patch }); return false; } catch { return true; }
    };
    const rejectsRoot = (patch) => {
      try { Config(patch); return false; } catch { return true; }
    };
    for (const [label, patch] of [
      ['jobKind 空串', { jobKind: '' }],
      ['maxResultChars = 0', { maxResultChars: 0 }],
      ['maxResultChars 负数', { maxResultChars: -5 }],
      ['pollIntervalMs 负数', { pollIntervalMs: -1 }],
      ['minYieldMs = 0', { minYieldMs: 0 }],
      ['maxWaitMs 负数', { maxWaitMs: -1 }]
    ]) {
      assert.equal(rejectsSettings(patch), true, `${label} 必须被 schema 拒绝`);
    }
    assert.equal(rejectsRoot({ toolName: 'nope' }), true, 'toolName 不在枚举里必须被 schema 拒绝');
    // 反向：别把正常路径一起挡掉。
    for (const [label, patch] of [
      ['空子树（全默认）', {}],
      ['正常区间', { minWaitMs: 250, maxWaitMs: 600000 }],
      ['极小但合法', { maxResultChars: 1, pollIntervalMs: 1 }]
    ]) {
      assert.equal(rejectsSettings(patch), false, `${label} 必须通过`);
    }
    assert.equal(rejectsRoot({ toolName: 'async_run' }), false, '只给 toolName 必须通过');
    // 恒真检查：两个基底本身**必须通过**。
    assert.equal(rejectsSettings({}), false, 'settings 基底必须通过——否则上面的拒绝断言没有区分力');

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
  // 然后在某次 async_wait 调用里被夹紧——使用者看到的是"我设了但没效果"。
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
    t.skip(HOST_SKIP_REASON);
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
    // 第九服务：会话当前有效目录（挂载级假件返回固定目录即可）。
    workingDirectory: { ensure: async () => 'D:\\work' },
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
  assert.match(tool.description, /pass yield_ms, range 20000–600000 ms/, '快照缺席时描述用本行默认值');

  // ② 宿主侧（同一插件、行配置没有 toolName）：首播快照。settings 子树形态：
  //    20 个可编辑字段住在 `settings` 键下（设计 §5.1——新根形态；PRESET-BIND-01 后含 boundPresets）。
  const hostCtx = new Context();
  for (const [name, value] of Object.entries(services)) hostCtx.provide(name, value);
  const hostFork = await mount(
    hostCtx,
    { name: preset.name, inject: preset.inject, Config: preset.Config, apply: preset.apply },
    { settings: { maxWaitMs: 600000 } }
  );
  assert.equal(hostFork.state, 2, '宿主角色必须激活');
  assert.equal(registeredTools.size, 1,
    `宿主角色不得注册工具（实际有 ${[...registeredTools.keys()].join('、')}）`);
  assert.ok(readSnapshot() !== undefined, '宿主行装载必须首播快照');

  // ③ volatile 提交：照 loader `_commitVolatile` 的同款方式**原地**改 Ref
  //    （`updateVolatile(ref, createVolatile(newValue))`，`cosmokit/lib/index.js:149-151`），
  //    再在 **fiber 自己的 ctx** 上派发事件（loader 也是 `fiber.ctx.emit`，cordis 的
  //    事件向上冒泡，从根 ctx 派发到不了 fiber 的监听）——快照必须重播、描述必须就地刷新。
  assert.equal(typeof hostFork.config.settings?.get, 'function',
    'fiber.config 的 settings 子树必须是 Ref（Schema.resolve 包的 createVolatile）——不是的话就地提交链不成立');
  const before = tool.description;
  updateVolatile(hostFork.config.settings, createVolatile({
    ...hostFork.config.settings.get(),
    maxWaitMs: 130000,
    defaultYieldMs: 5000,
    // 出厂 minYieldMs=20000 会把 defaultYieldMs=5000 顶爆组合校验（快照重播
    // 拒绝、保旧值）——显式给出合法下限，测的仍是「提交→重播→描述刷新」链。
    minYieldMs: 1000
  }));
  hostFork.ctx.emit('loader/volatile-update');
  // 快照重播是同步的（先于 refresh-bus 的动态 import）；描述刷新要等微任务+宏任务。
  assert.equal(readSnapshot().maxWaitMs, 130000, '事件派发后快照必须同步重播');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.notEqual(tool.description, before,
    'volatile 提交后描述必须变化——否则通道是断的（行为活、描述死）');
  const range = /Per-call wait budgets must be passed explicitly, range (\d+)–(\d+) ms;/.exec(tool.description);
  assert.deepEqual([range?.[1], range?.[2]], ['20000', '130000'], '描述里的等待区间必须更新');
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

test('T13：静态 inject 九项服务；设置链不引入任何服务依赖', () => {
  // 唯一的静态 `inject` 在 `lib/index.js`（工具角色的九项固定依赖，宿主行共用；
  // `sessionProjections` 是模型选择的白名单读取，`workingDirectory` 是 async_run
  // 的会话当前有效目录）。
  // `settings` / `agentPresets` 不得出现在其中：写了就等于要求"这个部署必须有它们"，
  // 缺一个就让整行不激活 → 升级成 dsh 启动失败。设置快照链**不依赖任何
  // 服务**（宿主行的活配置经 apply 的第二参取得——cordis 没有 `ctx.config` 访问口，
  // volatile 提交监听挂在宿主行自己的 ctx 上），所以这两个名字没有
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
  // 运行时 `ctx.inject`：纪律段只等 systemPrompt（预设过滤两服务经
  // `ctx.get` 在 text 内**组稿期现读**——需求 §6.3：c 防线按目标会话实际预设
  // 过滤；不进等待名单，服务缺席 ⇒ 空串 ⇒ 段不出现，失效安全 = 关）与提问接线的
  // 三服务段（ask 批次登记要读会话/投影/子代理）。静态 inject 列表依旧不动、
  // 快照链依旧零服务依赖。除此之外的任何服务等待仍然禁止——`settings`/`agentPresets`
  // 那类"缺服务整行不激活"的等待形态没有回潮的理由。
  const hostCode = stripComments(read('lib/host.js'));
  const hostInjects = [...hostCode.matchAll(/ctx\.inject\(\s*(\[[^\]]*\])/g)].map((m) => m[1]);
  assert.deepEqual(hostInjects,
    ["['systemPrompt']", "['sessions', 'sessionProjections', 'agents']"],
    '宿主半边只允许 R28 纪律段与 R30 提问接线两个运行时注入；其余服务等待仍禁止（快照链零服务依赖）');
  // 宿主半边的 `ctx.get` 只服务于纪律段 text 的预设过滤（sessions/sessionProjections
  // 两服务的现读，各一处）——设置快照链（`attachSnapshotSource`）依旧零服务读取，
  // 其它任何服务探测都没有存在的理由。
  const hostGets = [...hostCode.matchAll(/ctx\.get\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(hostGets)].sort(), ['sessionProjections', 'sessions'],
    '宿主半边 ctx.get 只许读预设过滤两服务（组稿期现读，缺席=关）');
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

  // ③ 秒数换算行为（浏览器外可验证，词典键化后用 zh 词典当 t）：secondsNumber
  //    只出数值文本（整数秒不带小数、小数保留两位）；亚 10 ms 与无效值返回空串
  //    交上层占位。secondsWord 出完整秒读数词（单位/短句来自词典键
  //    readout.secondsUnit／readout.subSecond——需求 5.7.4 秒数读数行）。
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
  const zhT = (key) => product.DICTIONARIES.zh[key];
  assert.equal(typeof product.secondsNumber, 'function', 'secondsNumber 必须导出（浏览器外判据）');
  assert.equal(product.secondsNumber(20000), '20', '20000 ms → "20"');
  assert.equal(product.secondsNumber(1500), '1.5', '1500 ms → "1.5"');
  assert.equal(product.secondsNumber(250), '0.25', '250 ms → "0.25"');
  assert.equal(product.secondsNumber(4), '', '4 ms → 空（亚 10 ms 由 secondsWord 出短句）');
  assert.equal(product.secondsNumber(9), '', '9 ms → 空（亚 10 ms 上界内侧）');
  assert.equal(product.secondsNumber(10), '0.01', '10 ms → "0.01"（恰好可表示）');
  assert.equal(product.secondsNumber(999), '1', '999 ms → "1"（两位舍入进位，不带拖零）');
  assert.equal(product.secondsNumber(0), '', '0 不得显示读数（不是有效的时长）');
  assert.equal(product.secondsNumber(-5), '', '负数不得显示读数');
  assert.equal(product.secondsNumber('x'), '', '非数字不得显示读数');
  assert.equal(typeof product.secondsWord, 'function', 'secondsWord 必须导出（秒读数词判据）');
  assert.equal(product.secondsWord(zhT, 20000), '20 秒', '20000 ms → "20 秒"（单位来自词典）');
  assert.equal(product.secondsWord(zhT, 1500), '1.5 秒', '1500 ms → "1.5 秒"');
  assert.equal(product.secondsWord(zhT, 4), '小于 0.01 秒', '4 ms → 词典短句（亚 10 ms 正值）');
  assert.equal(product.secondsWord(zhT, 0), null, '0 → null（调用方按未知/占位处理）');
  assert.equal(product.secondsWord(zhT, -5), null, '负数 → null');

  // ③-b composeHint 行为（两段形状、换行、分隔符、秒读数词、空姿态）：
  //    t 直接用 zh 词典（键真、占位符真——readout.current/unsaved 带 {值} 占位，
  //    没有占位替换会让"值没填进去"漏过）。非毫秒字段无读数；两段相等也不隐藏；
  //    四「—」字段（hint 键缺席）读数行独立在场（设计 §5.4）；生效值不可核实
  //    → readout.unknown。
  assert.equal(typeof product.composeHint, 'function', 'composeHint 必须导出（读数拼接的浏览器外判据）');
  assert.equal(typeof product.draftReadout, 'function', 'draftReadout 必须导出（输入段姿态的浏览器外判据）');
  const msField = { key: 'defaultYieldMs', ms: true };
  const plainField = { key: 'jobKind' };
  const dashField = { key: 'minYieldMs', ms: true };
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
  assert.equal(product.composeHint(zhT, plainField, 20000, 'my-kind'),
    product.DICTIONARIES.zh['hint.jobKind'], '非毫秒字段不得有任何读数段');
  let shape = shapeOf(product.composeHint(zhT, msField, 20000, '20000'));
  assert.ok(shape.desc === product.DICTIONARIES.zh['hint.defaultYieldMs'] && shape.hasBr && shape.dot === ' · ',
    '毫秒字段的说明行 = 字段说明 + 换行 + 两段读数（行首不带点，与字段说明分行）');
  assert.equal(shape.eff, '生效：20 秒', '生效段 = readout.current 填秒读数词（无毫秒、无等号）');
  assert.equal(shape.input, '待保存：20 秒', '无草稿时输入段也在场（两段相等也不隐藏）');
  assert.ok(!shape.inClass.includes('ats-sec-invalid'), '合法草稿不得带非法标记');
  shape = shapeOf(product.composeHint(zhT, msField, 500, '04321'));
  assert.equal(shape.eff, '生效：0.5 秒');
  assert.equal(shape.input, '待保存：4.32 秒', '输入段取解析值的换算（04321 → 4.32 秒），未保存就反映键入');
  shape = shapeOf(product.composeHint(zhT, msField, 500, '4'));
  assert.equal(shape.eff, '生效：0.5 秒', '生效段不动');
  assert.equal(shape.input, '待保存：小于 0.01 秒', '逐位键入的中间态给亚 10 ms 读数（不得 0 秒、不得消失）');
  shape = shapeOf(product.composeHint(zhT, msField, 500, ''));
  assert.equal(shape.eff, '生效：0.5 秒', '空草稿：生效段仍在');
  assert.equal(shape.input, '待保存：—', '空文本 → 输入段 — 占位（不残留旧读数、不给秒数）');
  assert.ok(!shape.inClass.includes('ats-sec-invalid'), '空草稿不是非法（清除覆盖的意图），不得标红');
  shape = shapeOf(product.composeHint(zhT, msField, 500, '  '));
  assert.equal(shape.input, '待保存：—', '纯空白等同空文本（按 trim 后判空）');
  for (const bad of ['abc', '0', '-3']) {
    shape = shapeOf(product.composeHint(zhT, msField, 500, bad));
    assert.equal(shape.input, '待保存：—', `${bad} → 输入段 — 占位`);
    assert.ok(shape.inClass.includes('ats-sec-invalid'), `${bad} → 输入段带非法标记（颜色侧走 state-error）`);
    assert.equal(shape.eff, '生效：0.5 秒', `${bad} → 生效段仍在`);
  }
  shape = shapeOf(product.composeHint(zhT, msField, undefined, '20000'));
  assert.equal(shape.eff, '生效：未知', '生效值不可核实 → 词典 readout.unknown（未知）');
  // 四「—」字段：hint 键缺席 → 说明退场、读数行独立在场（首个成员是换行元素）。
  const dashRow = product.composeHint(zhT, dashField, 20000, '20000');
  assert.ok(Array.isArray(dashRow), '无 hint 的毫秒字段返回读数行数组（而非 undefined）');
  shape = shapeOf(dashRow);
  assert.ok(shape.hasBr, '读数行独立在场：换行元素是首成员');
  assert.equal(shape.eff, '生效：20 秒', '「—」字段的读数照常换算');
  assert.deepEqual(product.draftReadout(zhT, '4321'), { fill: '4.32 秒', invalid: false }, 'draftReadout：正数 → 秒读数词');
  assert.deepEqual(product.draftReadout(zhT, ''), { fill: '—', invalid: false }, 'draftReadout：空 → — 不标非法');
  assert.deepEqual(product.draftReadout(zhT, 'abc'), { fill: '—', invalid: true }, 'draftReadout：非数字 → — 标非法');
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
    remote: { $mount: function () { return Promise.resolve(function () {}); }, $on: function () { return function () {}; } },
    // connection/reset 是预设目录刷新通知的宿主接口（PRESET-BIND-01）。
    on: function () { return function () {}; },
    uiWorkspace: { openSession: function () {} },
    // ask 座位在 $mount 生效后经**动态** ctx.inject(['remote.async-tools-ask'])
    // 装配（自 mount 命名空间的取用口径——不能直接读 ctx.remote 下标）；注入即回调。
    // 预设目录服务（remote.agentPresets）经同一动态 inject 形态注入。
    inject: function (list, fn) {
      fn({ remote: { 'async-tools-ask': {}, agentPresets: { list: function () { return Promise.resolve({ ok: true, value: { presets: [] } }); } } } });
    },
    slots: {
      inject: function (slotName, load) { return load(); },
      register: function (options, Component) { registrations.push({ options: options, Component: Component }); }
    },
    effect: function (fn) { return fn(); }
  };
  product.apply(fakeCtx);
  // ask 座位在 $mount promise 的微任务之后注册（真机同款顺序）——冲两轮微任务再数。
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

// CL-INJECT（验收 ACCEPT-CLIENT-INJECT-01）：预设目录服务的动态注入按 fiber
// 生命周期管理——`ctx.inject` 同步返回 fiber（不因 `.then` 解包错认清理句柄），
// whileServed 退出清理调 `fiber.dispose()` **恰一次**，fiber 内部跑注入回调自身
// 返回的清理（清目录服务引用）；两轮服务周期（服务实现变化）各自独立装配，
// 重复清理幂等（fiber 句柄置空后不再 dispose）。
test('CL-INJECT：预设目录注入走 fiber 生命周期——dispose 恰一次、回调清理 detach、两轮服务周期', async () => {
  // 装置同 T16 的装载形态（window.__ModuleLoader__ 工厂 + React 原语替身）。
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const reactRecord = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: () => [undefined, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v })
  };
  const double = makePrimitivesDouble(reactRecord);
  const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
  let loaded;
  new Function('window', source)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactRecord : double));

  const fibers = [];        // 每次 agentPresets 注入产出的 fiber（按周期序）
  const servedLoads = [];   // whileServed 装载闭包（产品接线，可重跑＝服务周期重估）
  const servedCleanups = [];
  let attachRuns = 0;       // 注入回调执行次数（= 服务周期数）
  let detachRuns = 0;       // 回调清理（detach）执行次数
  let serviceId = 0;        // 每轮服务实现的标识（fiber 闭包捕获当轮）
  const registrations = [];
  const fakeCtx = {
    locale: { register: () => () => {} },
    configForms: {
      get: () => ({ getSnapshot: () => ({ status: 'ready', value: {}, user: {} }), subscribe: () => () => {}, mutate: async () => true }),
      // 真机同款：whileServed 条件内装配，返回退出清理；装载闭包记录在案
      //（产品接线原样可重跑＝第二服务周期）。
      whileServed: (ids, load) => {
        servedLoads.push(load);
        const off = load();
        servedCleanups.push(off);
        return off;
      }
    },
    remote: { $mount: () => Promise.resolve(() => {}), $on: () => () => {} },
    on: () => () => {},
    uiWorkspace: { openSession() {} },
    // 真机同款形态：ctx.inject 返回 fiber——宿主在 fiber 内跑回调，回调返回的
    // 清理函数挂到 fiber 生命周期（dispose 时执行）。ask 座位的动态注入
    //（remote.async-tools-ask）同走本口，返回最小 fiber 形状。
    inject: (list, fn) => {
      if (list[0] !== 'remote.agentPresets') {
        return { dispose() {} };
      }
      const currentService = { id: ++serviceId, list: () => Promise.resolve({ ok: true, value: { presets: [] } }) };
      let disposed = false;
      const cleanup = fn({ remote: { agentPresets: currentService } });
      attachRuns += 1;
      const fiber = {
        service: currentService,
        dispose: () => {
          if (disposed) throw new Error('fiber double-disposed');
          disposed = true;
          detachRuns += 1;
          cleanup();
        }
      };
      fibers.push(fiber);
      return fiber;
    },
    slots: { inject: (slot, load) => load(), register: (options, Component) => registrations.push({ options, Component }) },
    effect: (fn) => fn()
  };
  product.apply(fakeCtx);
  await Promise.resolve();
  await Promise.resolve();
  // 预设接线是 apply 里第一个 whileServed 装载（设置卡在其后）。
  assert.equal(attachRuns, 1, '首轮服务周期：注入回调执行一次');
  assert.equal(fibers.length, 1, '首轮：恰一个 fiber（同步返回本体）');
  assert.equal(fibers[0].service.id, 1, 'fiber 持当轮服务实现');

  // ① 退出清理（whileServed 条件失效）：产品清理调 fiber.dispose 恰一次，
  //    dispose 执行注入回调返回的清理（目录 detach）。
  servedCleanups[0]();
  assert.equal(detachRuns, 1, '① dispose 执行回调清理（目录 detach）恰一次');
  // ② 幂等：重复退出清理不再 dispose（产品清理把 fiber 句柄置空）。
  servedCleanups[0]();
  assert.equal(detachRuns, 1, '② 重复清理幂等（不再 dispose）');
  // ③ 第二轮服务周期（服务实现变化→whileServed 重跑同一装载闭包）：新 fiber、
  //    新当轮服务引用；退出同样 dispose 恰一次。
  const secondOff = servedLoads[0]();
  assert.equal(attachRuns, 2, '③ 第二轮注入回调执行');
  assert.equal(fibers.length, 2, '③ 第二轮新 fiber');
  assert.notEqual(fibers[1], fibers[0], '③ 新 fiber 本体');
  assert.equal(fibers[1].service.id, 2, '③ 第二轮闭包捕获新服务实现');
  secondOff();
  assert.equal(detachRuns, 2, '③ 第二轮退出 dispose 恰一次');
  secondOff();
  assert.equal(detachRuns, 2, '③ 第二轮重复清理同样幂等');
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
 * 而 19 个字段壳是**同一个组件函数的 19 个实例**（PRESET-BIND-01 后另有 1 个
 * 预设绑定块——独立组件，不与字段壳共用函数），只按函数分槽会让它们的
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
  // ——模型构造时就 subscribe（T9 ② 验过缺成员会抛错）。value/user 层给**全字段**
  // 嵌套形状（真机 describe 把 20 字段展平在 `settings` 键下——毫秒说明行的读数
  // 才有东西可换算；client.js 经 makeSettingsScopeView 适配官方模型的平铺寻址）。
  const DEFAULTS = {
    defaultYieldMs: 20000, minYieldMs: 20000, maxYieldMs: 600000,
    defaultWaitMs: 30000, minWaitMs: 20000, maxWaitMs: 600000,
    pollIntervalMs: 500, maxResultChars: 12000,
    jobKind: 'async-command', subagentProvider: '', uiLang: 'auto', agentLang: 'en',
    silentFailureGuard: false,
    askTakeover: false, askTimeoutMs: 60000, askExtendMs: 60000, askUiSeat: 'sidebar',
    boundPresets: ['dsh-async', 'dsh-async-create']
  };
  const snapshot = (revision, user, overrides) => ({
    status: 'ready',
    value: { settings: { ...DEFAULTS, ...overrides } },
    base: {},
    user: { settings: user },
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
    // $on/on 是预设目录刷新通知的宿主接口（PRESET-BIND-01）。
    remote: { $mount: () => Promise.resolve(() => {}), $on: () => () => {} },
    on: () => () => {},
    uiWorkspace: { openSession: () => {} },
    // ask 座位经 $mount 后的动态 ctx.inject 装配（注入即回调）；预设目录服务
    //（remote.agentPresets）同形态注入——目录里放两个预设供绑定块渲染。
    inject: (list, fn) => fn({ remote: {
      'async-tools-ask': {},
      agentPresets: { list: () => Promise.resolve({ ok: true, value: { presets: [
        { id: 'dsh-async' }, { id: 'dsh-async-create' }
      ] } }) }
    } }),
    slots: {
      inject: (slotName, load) => load(),
      register: (options, Component) => { registrations.push(Component); }
    },
    effect: (fn) => fn()
  });
  // ask 模型在 $mount promise 的微任务之后取控制器——冲两轮再数。
  await Promise.resolve();
  await Promise.resolve();
  const Card = registrations[0];
  // 测试词典约定：键 + '|'；读数/秒单位键带占位（实现用 replace 填值——没有占
  // 位的桩会让"值没填进去"漏过）。真机上 props.t 是宿主翻译函数，语义相同。
  const t = (key) => ({
    'readout.current': 'readout.current|{值}',
    'readout.unsaved': 'readout.unsaved|{值}',
    'readout.secondsUnit': '{数值} s',
    'readout.subSecond': '< 0.01 s'
  }[key] ?? `${key}|`);

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

  // ①-a 渲染本身：**props 里没有 `form`**（bundle 槽不传）。值必须来自控制器。
  //     先核六组渐进披露的**默认形态**（设计 §5.3）：三组展开（适用预设/待答问题/
  //     语言）、三组收起（命令与等待/发送给 Agent 的内容/高级设置）；收起组只渲染
  //     组头（体区与字段控件不在 DOM）；待答子组与「选择预设」入口默认收起。
  let tree = renderCard();
  // `configForms.get` 被调**两次**：ask 模型在 apply 期取一次（待答界面），
  // 卡片模型在挂载期取一次——两次都必须按 entry id（不是按包名）。
  assert.deepEqual(asked, ['async-tools-host', 'async-tools-host'], 'ask 模型与卡片都必须按 entry id 向 configForms 取控制器（不是按包名）');
  assert.equal(listeners.length, 2, '卡片模型与 ask 模型各订阅控制器恰好一次（bind 一次 + 订阅一次）');
  const groupSectionOf = (aTree, groupId) => findNode(aTree,
    (node) => node.type === 'section' && node.props.id === `plugin-config-group-${groupId}`);
  const groupToggleOf = (aTree, groupId) => findNode(aTree,
    (node) => node.type === 'button' && node.props.id === `plugin-config-group-${groupId}-toggle`);
  for (const groupId of ['presets', 'ask', 'budget', 'agentContent', 'advanced', 'lang']) {
    const section = groupSectionOf(tree, groupId);
    assert.ok(section !== undefined, `六组之一 ${groupId} 必须以 section 在场`);
    const body = findNode(section, (node) => node.type === 'div'
      && node.props.id === `plugin-config-group-${groupId}-body`);
    const toggle = groupToggleOf(tree, groupId);
    assert.ok(toggle !== undefined, `${groupId} 的组头折叠按钮必须在场`);
    assert.equal(toggle.props['aria-controls'], `plugin-config-group-${groupId}-body`,
      '折叠按钮 aria-controls 必须指向体区 id');
    const openExpected = groupId === 'presets' || groupId === 'ask' || groupId === 'lang';
    assert.equal(toggle.props['aria-expanded'], openExpected ? 'true' : 'false',
      `${groupId} 默认${openExpected ? '展开' : '收起'}（设计 §5.3 六组默认开合）`);
    assert.equal(body !== undefined, openExpected,
      `${groupId} ${openExpected ? '展开时体区必须渲染' : '收起时体区不渲染（渐进披露）'}`);
  }
  // 收起组的字段控件不在 DOM（渐进披露的硬证据）；展开组的控件在场。
  assert.ok(inputById(tree, 'plugin-config-defaultYieldMs') === undefined,
    '命令与等待组默认收起：defaultYieldMs 控件不在 DOM');
  assert.ok(inputById(tree, 'plugin-config-askTimeoutMs') === undefined,
    '待答子组「等待与加时」默认收起：askTimeoutMs 控件不在 DOM');
  assert.ok(findNode(tree, (node) => node.type === 'input' && node.props.id === 'plugin-config-boundPresets-list') === undefined,
    '「选择预设」入口默认收起：完整目录不在 DOM');
  assert.ok(inputById(tree, 'plugin-config-askUiSeat') !== undefined, '待答组展开：askUiSeat 控件在场');
  assert.ok(inputById(tree, 'plugin-config-uiLang') !== undefined, '语言组展开：uiLang 控件在场');
  // 组级标记默认不在场（无暂存/无错误）；组级帮助按钮五个组（语言组不设）。
  const groupMarks = collectByType(tree, 'span').filter((node) => node.props.className === 'ats-group-mark');
  assert.equal(groupMarks.length, 0, '无修改无错误：组级标记不得在场');
  const groupHelpButtons = collectByType(tree, 'button')
    .filter((node) => node.props.className === 'ats-help-button'
      && String(node.props['aria-controls'] ?? '').endsWith('-help-body'));
  assert.equal(groupHelpButtons.length, 5,
    '五个设组级帮助的组（presets/budget/agentContent/advanced/ask）帮助按钮随组头恒在——收起只藏体区不藏头；语言组无组级帮助（5.7.5）');
  assert.ok(!groupHelpButtons.some((node) => String(node.props['aria-controls'] ?? '').includes('group-lang')),
    '语言组不设组级帮助按钮');
  // 展开组的组级帮助按钮在场（ask 组）。
  const askGroupHelp = findNode(tree, (node) => node.type === 'button'
    && node.props.id === 'plugin-config-group-ask-help');
  assert.ok(askGroupHelp !== undefined, '待答组展开：组级帮助按钮在场（设计 §5.6 五组设帮助）');

  // ①-b 撑开全部组与子组/入口（六组结构的全部字段控件在场），再做清单核对。
  //     开合状态存在卡片组件的 shim 槽里（真 React 的 useState），点击组头按钮
  //     即真实开合路径——之后的字段交互全在展开树上进行。
  const toggleAllOpen = () => {
    for (const groupId of ['budget', 'agentContent', 'advanced', 'askTimes']) {
      const toggle = groupToggleOf(tree, groupId);
      if (toggle !== undefined && toggle.props['aria-expanded'] === 'false') toggle.props.onClick();
    }
    const entry = findNode(tree, (node) => node.type === 'button'
      && node.props.id === 'plugin-config-boundPresets-entry');
    if (entry !== undefined && entry.props['aria-expanded'] === 'false') entry.props.onClick();
    tree = renderCard();
  };
  toggleAllOpen();
  for (const groupId of ['budget', 'agentContent', 'advanced', 'askTimes']) {
    assert.equal(groupToggleOf(tree, groupId).props['aria-expanded'], 'true', `${groupId} 展开后 aria-expanded="true"`);
  }
  assert.ok(inputById(tree, 'plugin-config-defaultYieldMs') !== undefined, '展开后 defaultYieldMs 控件在场');
  assert.ok(findNode(tree, (node) => node.type === 'div' && node.props.id === 'plugin-config-boundPresets-list') !== undefined,
    '展开「选择预设」入口后目录区在场（div#boundPresets-list）');
  const inputs = collectByType(tree, 'input').filter((node) => node.props.type !== 'checkbox');
  const selects = collectByType(tree, 'select');
  // 12 个值字段（10 预算 + askTimeoutMs + askExtendMs）、3 个枚举下拉
  // （askUiSeat + 两语言）。预设绑定块的复选框（type=checkbox）不算值字段输入框。
  assert.equal(inputs.length, 12, '十二个值字段必须以官方 input 在场（10 预算 + R30 askTimeoutMs + askExtendMs）');
  assert.equal(selects.length, 3, '三个枚举字段必须以 select 在场（askUiSeat + 两语言；控件本体自绘，裁定 B）');
  // 四个布尔开关（提问接管 + 两个展示开关 + 静默失败防护）：控件本体是自绘
  // role="switch" 按钮（UI-SETTINGS-AX：官方 P.Switch 收不了 id/aria 关联），
  // 不进 input/select 的 id 清单——按无障碍属性（role/aria-label/aria-checked）
  // 钉在场；id/label-for/aria-describedby 由 ② 段的统一循环钉（不再豁免）。
  const switchButtons = collectByType(tree, 'button').filter((node) => node.props.role === 'switch');
  assert.equal(switchButtons.length, 4, '四个布尔开关必须以 role=switch 的按钮在场（askTakeover/workflowProgressLog/fullCommandEcho/silentFailureGuard）');
  const switchByLabel = (label) => switchButtons.find((node) => node.props['aria-label'] === label);
  assert.equal(switchByLabel('askTakeover|')?.props['aria-checked'], false,
    'R30 总开关默认关（零行为硬边界的界面证据）；无障碍名 = 可见标签');
  assert.equal(switchByLabel('workflowProgressLog|')?.props['aria-checked'], false,
    'workflowProgressLog 默认关（需求 9.3.4）；无障碍名 = 可见标签');
  assert.equal(switchByLabel('fullCommandEcho|')?.props['aria-checked'], false,
    'fullCommandEcho 默认关（需求 9.3.4）；无障碍名 = 可见标签');
  assert.equal(switchByLabel('silentFailureGuard|')?.props['aria-checked'], false,
    '默认关：无覆盖时开关显示生效姿态 false；无障碍名 = 可见标签');
  // 开关字段的说明行与值/枚举字段同形（p + id），文案走同一条 hint 通道——在此钉住，
  // 补足 ② 循环豁免后的结构覆盖。
  const flagMessage = findNode(tree, (node) =>
    node.type === 'p' && node.props.id === 'plugin-config-silentFailureGuard-message');
  assert.ok(flagMessage !== undefined, '开关字段必须有说明行（判据 2 的结构同形）');
  assert.ok(String(flagMessage.props.children).includes('hint.silentFailureGuard|'),
    '开关说明行必须带该字段的说明文案');
  const expectedKeys = product.FIELDS.map((field) => field.key);
  // DOM 收集是「全部 input 再全部 select」——分型别各自按 FIELDS 顺序核对，不拼
  // 交错序（六组结构的字段序 = FIELDS 序）。绑定字段（binding: true）以独立的
  // 预设绑定块渲染（复选组），不进 input/select 清单。
  const expectedInputKeys = product.FIELDS
    .filter((field) => field.options === undefined && field.flag !== true && field.binding !== true).map((field) => field.key);
  const expectedSelectKeys = product.FIELDS
    .filter((field) => field.options !== undefined).map((field) => field.key);
  assert.deepEqual(inputs.map((node) => node.props.id),
    expectedInputKeys.map((key) => `plugin-config-${key}`),
    '值字段身份必须按 id 逐项核对（判据 1，六组序＝FIELDS 顺序）');
  assert.deepEqual(selects.map((node) => node.props.id),
    expectedSelectKeys.map((key) => `plugin-config-${key}`),
    '枚举字段身份必须按 id 逐项核对（判据 1，六组序＝FIELDS 顺序）');
  assert.deepEqual(selects.map((node) => node.props.children.map((option) => option.props.value)),
    [['sidebar', 'overlay'], ['auto', 'zh', 'en'], ['en', 'zh']],
    '选项集就是契约（写错值宿主会 fail-fast；askUiSeat 选项序 [sidebar, overlay]——需求 §5.2/5.5，默认标记位在 sidebar）');
  assert.equal(inputById(tree, 'plugin-config-uiLang').props.value, 'auto',
    '无覆盖时下拉显示生效值（不是空选项——下拉为空等于丢掉当前生效值，硬条目①）');
  assert.equal(inputById(tree, 'plugin-config-askUiSeat').props.value, 'sidebar',
    'askUiSeat 无覆盖时下拉显示生效值 sidebar（需求 §5.2：默认值即 sidebar）');

  // ② label↔id 绑定 + 说明行（判据 2 的结构；0.5px 分隔线是计算样式，真机探针验）。
  // 布尔开关自绘后（UI-SETTINGS-AX）不再豁免：button[id] 也是控件本体，label
  // `for`/`aria-describedby` 判据与 select/input 同一条。绑定字段仍不进：预设
  // 绑定块有自己的头注/帮助/读数结构（P18/P19 单独钉），不复用字段壳的 for/id 契约。
  const controlById = (aTree, id) => findNode(aTree, (node) =>
    (node.type === 'input' || node.type === 'select'
      || (node.type === 'button' && node.props.role === 'switch')) && node.props.id === id);
  // 四「—」字段（5.7.5 第一表说明列为 —）：无字段级 hint/help——说明行退场但
  // 读数行独立在场（设计 §5.4），label/控件/describedby 结构同其余字段。
  const DASH_FIELD_KEYS = ['minYieldMs', 'maxYieldMs', 'minWaitMs', 'maxWaitMs'];
  for (const key of expectedKeys.filter((k) => k !== 'boundPresets')) {
    const control = controlById(tree, `plugin-config-${key}`);
    const label = findNode(tree, (node) =>
      node.type === 'label' && node.props.htmlFor === `plugin-config-${key}`);
    assert.ok(label !== undefined, `字段 ${key} 的 label 必须以 for=<id> 绑定控件`);
    const message = findNode(tree, (node) => node.type === 'p' && node.props.id === `plugin-config-${key}-message`);
    assert.ok(message !== undefined, `字段 ${key} 必须有说明/错误行（aria-describedby 的指向）`);
    if (DASH_FIELD_KEYS.includes(key)) {
      const children = Array.isArray(message.props.children) ? message.props.children : [message.props.children];
      assert.ok(children.some((child) => child !== null && typeof child === 'object' && child.type === 'br'),
        `「—」字段 ${key} 的说明行缺席、读数行独立在场（换行元素在首）`);
    } else {
      assert.ok(String(message.props.children).includes(`hint.${key}|`),
        `字段 ${key} 的说明行必须带该字段的说明文案`);
    }
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
    if (!DASH_FIELD_KEYS.includes(key)) {
      assert.ok(readout.desc.startsWith(`hint.${key}|`), `毫秒字段 ${key} 的说明行第一行必须是字段说明`);
    }
    assert.ok(readout.hasBr, `毫秒字段 ${key} 的读数必须与字段说明换行（行首不带点；「—」字段以换行开头）`);
    assert.match(String(readout.eff), /^readout\.current\|[\d.]+ s$/,
      `毫秒字段 ${key} 的生效段 = readout.current + 秒读数词（恒显示）`);
    assert.match(String(readout.input), /^readout\.unsaved\|[\d.]+ s$/,
      `毫秒字段 ${key} 无草稿时输入段也在场（两段相等也不隐藏）`);
  }
  const poll = () => readoutOf(tree, 'pollIntervalMs');
  assert.equal(poll().eff, 'readout.current|0.5 s', 'defaultYieldMs=20000 之外：生效段 = 生效值换算（500 → 0.5 s）');
  for (const key of ['maxResultChars', 'jobKind', 'uiLang']) {
    assert.equal(messageNode(tree, key).props.children, `hint.${key}|`,
      `非毫秒字段 ${key} 的说明行不得带任何读数段（连 children 都还是纯字符串）`);
  }

  // ②-b 输入段实时（判据 10 的核心）：**不保存**、只在输入框键入 → 输入段当场变；
  //     逐位键入的中间态（4）给亚 10 ms 读数；非法/非正数 → — 占位 + 非法标记
  //     （非法原因行另加、常驻说明与读数保留，见 ④）；清空 = — 占位。
  //     （真机对应探针：`verify/_visual/probe-r24-bundle-config.mjs` 的两段读数断言。）
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: '4' } });
  tree = renderCard();
  assert.equal(poll().eff, 'readout.current|0.5 s', '键入 4（未保存）：生效段不动');
  assert.equal(poll().input, 'readout.unsaved|< 0.01 s',
    '键入 4（未保存）：输入段当场 = 亚 10 ms 读数（不得 0 s），读数接的是草稿');
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: '04321' } });
  tree = renderCard();
  assert.equal(poll().input, 'readout.unsaved|4.32 s', '键入 04321：输入段显示解析值的换算（不是生效值）');
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: 'not-a-number' } });
  tree = renderCard();
  // 契约（需求 §5.4／§5.6）：非法原因行（-invalid）是**附加**，常驻说明行（-message）
  // 与双读数不被顶掉——非数字草稿的输入段给 — 占位并标红，生效段照常。
  const invalidLineOf = (aTree, key) => findNode(aTree,
    (node) => node.type === 'p' && node.props.id === `plugin-config-${key}-invalid`);
  assert.equal(String(invalidLineOf(tree, 'pollIntervalMs')?.props.children), 'invalidNumber|',
    '非数字 → 原因行（-invalid）= invalidNumber 档');
  assert.equal(poll().eff, 'readout.current|0.5 s', '非法态常驻行的生效段照常显示（不被原因行顶掉）');
  assert.equal(poll().input, 'readout.unsaved|—', '非法草稿的输入段给 — 占位（不给误导性秒数）');
  assert.ok(poll().inClass.includes('ats-sec-invalid'), '非法草稿的输入段标红');
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: '0' } });
  tree = renderCard();
  // FIELD_MIN 进 parse（§5.4 下界补齐）后：'0' 可解析但低于下界 1 → 官方非法通道
  // 的 belowRange 档走原因行（保存经 state.invalid 禁用），常驻读数同形保留。
  assert.equal(String(invalidLineOf(tree, 'pollIntervalMs')?.props.children), 'invalidBelow|',
    '0（可解析、低于下界 1）：belowRange 档走原因行（min 在 parse 里拦）');
  assert.equal(poll().eff, 'readout.current|0.5 s', '下界非法态常驻行的生效段照常显示');
  assert.equal(poll().input, 'readout.unsaved|—', '下界非法草稿的输入段同样给 — 占位');
  inputById(tree, 'plugin-config-pollIntervalMs').props.onChange({ target: { value: '' } });
  tree = renderCard();
  assert.equal(poll().input, 'readout.unsaved|—', '清空 → 输入段 — 占位');
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
  assert.deepEqual(mutateCalls[0].ops, [{ op: 'set', path: ['settings', 'jobKind'], value: 'my-kind' }],
    '保存必须只发用户真的改过的字段（模型只遍历被暂存的字段；路径带 settings 前缀＝嵌套形状线上契约）');
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
  assert.equal(poll().eff, 'readout.current|0.5 s',
    '非法态常驻说明行（-message）不得被原因行顶掉——生效段仍在（需求 §5.4 回归钉）');
  assert.equal(poll().input, 'readout.unsaved|—', '非法态常驻行的输入段照常给 — 占位');
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
  assert.deepEqual(lastCall.ops, [{ op: 'unset', path: ['settings', 'jobKind'] }],
    '保存把「恢复默认」做成 unset op（清除用户层覆盖；路径带 settings 前缀）');

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
  // 重新挂载＝全新组件实例：开合回到默认（presets/ask/lang 开，余组收）——
  // 草稿丢弃判据看的是**模型**，先把组重新撑开再验控件值。
  toggleAllOpen();
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
  assert.equal(ro.eff, 'readout.current|20 s',
    '只读态两段读数必须仍在位（判据 11：读数不随 writable 消失）');
  assert.equal(ro.input, 'readout.unsaved|20 s', '只读态输入段仍在位（= 生效值，无草稿可言）');
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
    defaultYieldMs: 20000, minYieldMs: 20000, maxYieldMs: 600000,
    defaultWaitMs: 30000, minWaitMs: 20000, maxWaitMs: 600000,
    pollIntervalMs: 500, maxResultChars: 12000,
    jobKind: 'async-command', subagentProvider: '', uiLang: 'zh', agentLang: 'en',
    silentFailureGuard: false,
    askTakeover: false, askTimeoutMs: 60000, askExtendMs: 60000, askUiSeat: 'sidebar',
    boundPresets: ['dsh-async', 'dsh-async-create']
  };
  const snapshot = (revision, user, overrides) => ({
    status: 'ready', value: { settings: { ...DEFAULTS, ...overrides } }, base: {},
    user: { settings: user }, revision, writable: true, mode: 'host'
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
    remote: { $mount: () => Promise.resolve(() => {}), $on: () => () => {} },
    on: () => () => {},
    uiWorkspace: { openSession: () => {} },
    inject: (list, fn) => fn({ remote: {
      'async-tools-ask': {},
      agentPresets: { list: () => Promise.resolve({ ok: true, value: { presets: [
        { id: 'dsh-async' }, { id: 'dsh-async-create' }
      ] } }) }
    } }),
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

  // ① 帮助按钮的在场形态（设计 §5.5/§5.6）：字段级问号按钮只在有 help.<键> 的
  //    16 个字段（四「—」字段不设）＋预设绑定块＝17 个；组级帮助按钮另设五个组
  //    （语言组不设）。先把六组全部撑开（收起组的字段不在 DOM——开合走真实
  //    组头按钮路径），再数。
  let tree = renderCard();
  const groupToggleOf = (aTree, groupId) => findNode(aTree,
    (node) => node.type === 'button' && node.props.id === `plugin-config-group-${groupId}-toggle`);
  for (const groupId of ['budget', 'agentContent', 'advanced', 'askTimes']) {
    const toggle = groupToggleOf(tree, groupId);
    if (toggle !== undefined && toggle.props['aria-expanded'] === 'false') toggle.props.onClick();
  }
  const presetEntry = findNode(tree, (node) => node.type === 'button'
    && node.props.id === 'plugin-config-boundPresets-entry');
  if (presetEntry !== undefined && presetEntry.props['aria-expanded'] === 'false') presetEntry.props.onClick();  tree = renderCard();
  const fieldHelpButtons = helpButtons(tree).filter((node) =>
    /^plugin-config-[a-zA-Z]+-help$/.test(String(node.props['aria-controls'] ?? '')));
  assert.equal(fieldHelpButtons.length, 16,
    '16 个可编辑项（15 个有 help 键的普通字段 + 绑定块 boundPresets）必须各有帮助按钮——四「—」字段不设（需求 5.7.5）');
  const groupHelpButtons = helpButtons(tree).filter((node) =>
    String(node.props['aria-controls'] ?? '').endsWith('-help-body'));
  assert.equal(groupHelpButtons.length, 5, '五个组设组级帮助按钮（语言组不设，设计 §5.6）');
  for (const button of [...fieldHelpButtons, ...groupHelpButtons]) {
    assert.equal(button.props.type, 'button', '帮助按钮必须 type=button（不提交表单）');
    assert.ok(typeof button.props['aria-controls'] === 'string'
      && (button.props['aria-controls'].endsWith('-help') || button.props['aria-controls'].endsWith('-help-body')),
      'aria-controls 必须指向帮助区 id');
    assert.equal(button.props['aria-expanded'], false, '初始收起');
    assert.ok(button.props['aria-label'].endsWith('的说明'),
      `可访问名必须来自 help.a11yName 模板（实得 ${String(button.props['aria-label'])}）`);
    assert.ok(findNode(button, (node) => node.type === 'svg'
      && node.props['data-icon'] === 'question-outline-regular') !== undefined,
      '按钮图标必须是替身的 IconQuestionOutlineRegular（带圈问号）');
  }
  assert.equal(helpButtonOf(tree, 'defaultYieldMs').props['aria-label'],
    '默认首次等待（毫秒）的说明', '可访问名必须含字段名称（help.a11yName 模板 {名称}的说明）');
  const askGroupHelpButton = groupHelpButtons.find((node) => node.props.id === 'plugin-config-group-ask-help');
  assert.equal(askGroupHelpButton?.props['aria-label'], '待答问题的说明',
    '组级帮助的可访问名 = 组标题显示名（group.ask）');

  // ② 点击展开 region#<id>-help（role=region、分段渲染），再点收起；开合只影响本字段
  //    （替身 hook 槽按组件＋元素 key 分槽——19 个同函数实例互踩时这条必红）。
  helpButtonOf(tree, 'defaultYieldMs').props.onClick();
  tree = renderCard();
  let region = regionOf(tree, 'defaultYieldMs');
  assert.ok(region !== undefined, '点击后必须渲染展开区 div#<id>-help');
  assert.equal(region.props.role, 'region', '展开区必须带 role=region');
  assert.equal(region.props['aria-label'], '默认首次等待（毫秒）的说明',
    '展开区 aria-label 与按钮可访问名同名');
  const paragraphs = (region.props.children || []).filter((child) => child.type === 'p');
  assert.equal(paragraphs.length, 1, `字段级帮助＝配置键行单段（5.7.4 技术信息行；实得 ${String(paragraphs.length)} 段）`);
  const helpText = textOf(region).join('');
  assert.equal(helpText, product.DICTIONARIES.zh['help.defaultYieldMs'],
    '字段级帮助正文必须逐字等于词典 help.<键>（配置键：defaultYieldMs）');
  assert.equal(helpButtonOf(tree, 'defaultYieldMs').props['aria-expanded'], true, '展开后 aria-expanded=true');
  assert.ok(regionOf(tree, 'askTimeoutMs') === undefined,
    '开合只影响本字段——同函数其他实例的帮助区不得跟着出现（组件＋key 分槽的红判据）');
  assert.ok(helpButtonOf(tree, 'minYieldMs') === undefined,
    '「—」字段不设帮助按钮（5.7.5 第一表说明列 — ⇒ 无 help.<键>）');
  assert.equal(helpButtonOf(tree, 'askTimeoutMs').props['aria-expanded'], false,
    '其他字段的按钮保持收起');

  // ②-b 组级帮助（设计 §5.6）：点击待答组帮助按钮 → 展开 region（组帮助键的
  //    段落逐字来自词典），收起不渲染；开合同样只影响本组（组件＋key 分槽）。
  findNode(tree, (node) => node.type === 'button' && node.props.id === 'plugin-config-group-ask-help')
    .props.onClick();
  tree = renderCard();
  let groupRegion = findNode(tree, (node) => node.type === 'div' && node.props.role === 'region'
    && node.props.id === 'plugin-config-group-ask-help-body');
  assert.ok(groupRegion !== undefined, '点击后必须渲染组级展开区 div#<组>-help-body');
  assert.equal(groupRegion.props['aria-label'], '待答问题的说明', '组级展开区 aria-label 与按钮可访问名同名');
  const groupHelpText = textOf(groupRegion).join('');
  assert.equal(groupHelpText, product.DICTIONARIES.zh['groupHelp.ask.lateAnswer'],
    '组级帮助正文逐字来自词典 groupHelp.<组>.<条目>（5.7.5 第二表原文）');
  assert.ok(findNode(tree, (node) => node.type === 'div' && node.props.role === 'region'
    && node.props.id === 'plugin-config-group-budget-help-body') === undefined,
    '开合只影响本组——他组的帮助区不得跟着出现');
  findNode(tree, (node) => node.type === 'button' && node.props.id === 'plugin-config-group-ask-help')
    .props.onClick();
  tree = renderCard();
  assert.ok(findNode(tree, (node) => node.type === 'div' && node.props.role === 'region'
    && node.props.id === 'plugin-config-group-ask-help-body') === undefined, '再点收起——组级展开区不渲染');

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
  assert.ok(textOf(invalidReason).join('').includes('请输入有效数字'),
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
  // 保存挂起相位：本测试的 mutate 故意永不落定（`new Promise(() => {})`——
  // 真机保存窗口短、抓拍不可靠，设计 §8.2），因此**不 await** 保存承诺（包装
  // save 会等到 mutate 落定才 resolve）；点击后推进数轮微任务让 saving=true
  // 落定进 shell，即可抓拍保存中态。
  findNode(tree, (node) => node.type === 'button'
    && textOf(node).join('') === '保存').props.onClick();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  tree = renderCard();
  assert.ok(textOf(tree).join('').includes('正在保存'), '前提：保存挂起时页脚在保存中态（5.7.4 saving＝正在保存…）');
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

test('T18i（R24·设计 §5.3/§5.4）：保存区清单与字段行逐字一致＋纯浏览动作零模型写入＋收起重开草稿保留', async () => {
  const { react, begin, flush, unmount } = makeReactShim();
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const double = makePrimitivesDouble(react);
  const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
  let loaded;
  new Function('window', source)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? react : double));
  const DEFAULTS = {
    defaultYieldMs: 20000, minYieldMs: 20000, maxYieldMs: 600000,
    defaultWaitMs: 30000, minWaitMs: 20000, maxWaitMs: 600000,
    pollIntervalMs: 500, maxResultChars: 12000,
    jobKind: 'async-command', subagentProvider: '', uiLang: 'auto', agentLang: 'en',
    silentFailureGuard: false,
    askTakeover: false, askTimeoutMs: 60000, askExtendMs: 60000, askUiSeat: 'sidebar',
    boundPresets: ['dsh-async', 'dsh-async-create']
  };
  const snapshot = (revision, overrides) => ({
    status: 'ready',
    value: { settings: { ...DEFAULTS, ...overrides } },
    base: {},
    user: { settings: {} },
    revision,
    writable: true,
    mode: 'host'
  });
  let current = snapshot(7, {});
  const listeners = [];
  const mutateCalls = [];
  const controller = {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener); if (at >= 0) listeners.splice(at, 1);
      };
    },
    mutate: async (ops, rev) => { mutateCalls.push({ ops, rev }); return true; }
  };
  const registrations = [];
  product.apply({
    locale: { register: () => () => {} },
    configForms: { whileServed: (ids, load) => load(), get: () => controller },
    remote: { $mount: () => Promise.resolve(() => {}), $on: () => () => {} },
    on: () => () => {},
    uiWorkspace: { openSession: () => {} },
    inject: (list, fn) => fn({ remote: {
      'async-tools-ask': {},
      agentPresets: { list: () => Promise.resolve({ ok: true, value: { presets: [
        { id: 'dsh-async' }, { id: 'dsh-async-create' }
      ] } }) }
    } }),
    slots: { inject: (slotName, load) => load(), register: (options, Component) => { registrations.push(Component); } },
    effect: (fn) => fn()
  });
  await Promise.resolve();
  await Promise.resolve();
  const Card = registrations[0];
  const t = (key) => ({
    'readout.current': 'readout.current|{值}',
    'readout.unsaved': 'readout.unsaved|{值}',
    'readout.secondsUnit': '{数值} s',
    'readout.subSecond': '< 0.01 s'
  }[key] ?? `${key}|`);
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
  const settle = () => new Promise((resolveTick) => { setTimeout(resolveTick, 0); });
  await settle(); // 预设目录首读落定
  const groupToggleOf = (aTree, groupId) => findNode(aTree,
    (node) => node.type === 'button' && node.props.id === `plugin-config-group-${groupId}-toggle`);

  // ① 撑开收起组，制造「一合法草稿＋一非法草稿」：defaultWaitMs=300（staged）、
  //    defaultYieldMs=abc（invalidNumber 档；jobKind 空串是合法 clear，不当非法用）。
  let tree = renderCard();
  for (const groupId of ['budget', 'advanced']) {
    groupToggleOf(tree, groupId).props.onClick();
  }
  tree = renderCard();
  findNode(tree, (node) => node.type === 'input'
    && node.props.id === 'plugin-config-defaultWaitMs').props.onChange({ target: { value: '300' } });
  tree = renderCard();
  findNode(tree, (node) => node.type === 'input'
    && node.props.id === 'plugin-config-defaultYieldMs').props.onChange({ target: { value: 'abc' } });
  tree = renderCard();
  // ② 保存区阻止清单行（§5.4）：「字段名＋冒号＋原因」与字段行自己的原因行
  //    **逐字一致**（同一 invalidLabelOf 单点产出——两处措辞漂移即红）。
  const fieldReason = findNode(tree, (node) => node.type === 'p'
    && node.props.id === 'plugin-config-defaultYieldMs-invalid');
  const blockedLine = findNode(tree, (node) => node.type === 'p'
    && node.props.className === 'ats-save-blocked');
  assert.ok(fieldReason !== undefined && blockedLine !== undefined, '字段原因行与保存区阻止行都在场');
  const fieldReasonText = textOf(fieldReason).join('');
  const blockedText = textOf(blockedLine).join('');
  assert.ok(blockedText.startsWith('defaultYieldMs|:'), '阻止行＝字段名＋冒号（labelColon 随读数键语言派生）');
  assert.ok(blockedText.endsWith(fieldReasonText),
    `阻止行原因段与字段行逐字一致（共用 invalidLabelOf；实得「${blockedText}」vs「${fieldReasonText}」）`);
  assert.ok(textOf(tree).join('').includes('saveArea.unsavedWarning|'), '有未保存修改 ⇒ 离页后果提示在场');
  // ③ 组级标记共存（§5.3）：budget 组同时带「未保存」与「需修正」两枚标记
  //    （合法草稿与非法草稿并存时两类标记互不吞并）。
  const budgetHead = findNode(tree, (node) => node.type === 'button'
    && node.props.id === 'plugin-config-group-budget-toggle');
  assert.ok(findNode(budgetHead, (node) => node.type === 'span'
    && textOf(node).join('') === 'group.unsaved|') !== undefined, 'budget 组：未保存标记在场');
  assert.ok(findNode(budgetHead, (node) => node.type === 'span'
    && textOf(node).join('') === 'group.error|') !== undefined, 'budget 组：需修正标记在场（与未保存标记共存）');
  // ④ 纯浏览动作零模型写入（设计 §5.3 开合/切语言/刷新目录都不碰模型）：
  //    收起再展开 budget、开合「选择预设」入口、目录刷新、语言档切换——
  //    mutate 全程零调用。
  groupToggleOf(tree, 'budget').props.onClick();
  tree = renderCard();
  assert.ok(findNode(tree, (node) => node.type === 'input'
    && node.props.id === 'plugin-config-defaultYieldMs') === undefined, '收起后组体区不渲染');
  groupToggleOf(tree, 'budget').props.onClick();
  tree = renderCard();
  // ⑤ 收起再展开：草稿原样（合法草稿在输入框、非法草稿与原因行仍在）。
  assert.equal(findNode(tree, (node) => node.type === 'input'
    && node.props.id === 'plugin-config-defaultYieldMs').props.value, 'abc', '收起重开：非法草稿保留');
  assert.equal(findNode(tree, (node) => node.type === 'input'
    && node.props.id === 'plugin-config-defaultWaitMs').props.value, '300', '收起重开：合法草稿保留');
  assert.ok(findNode(tree, (node) => node.type === 'p'
    && node.props.id === 'plugin-config-defaultYieldMs-invalid') !== undefined, '收起重开：原因行仍在');
  findNode(tree, (node) => node.type === 'button'
    && node.props.id === 'plugin-config-boundPresets-entry').props.onClick();
  tree = renderCard();
  findNode(tree, (node) => node.type === 'button'
    && node.props.id === 'plugin-config-boundPresets-entry').props.onClick();
  tree = renderCard();
  const refreshButton = findNode(tree, (node) => node.type === 'button'
    && textOf(node).join('') === 'preset.refresh|');
  refreshButton.props.onClick();
  await settle();
  tree = renderCard();
  current = snapshot(8, { uiLang: 'zh' });
  for (const listener of listeners) listener();
  tree = renderCard();
  assert.equal(mutateCalls.length, 0,
    '组开合/入口开合/目录刷新/语言切换全部零 mutate（开合态与目录是界面态，不是持久设置）');
  // ⑥ 草稿在收起-展开与语言切换后仍在（切换语言不清模型草稿）。
  assert.equal(findNode(tree, (node) => node.type === 'input'
    && node.props.id === 'plugin-config-defaultWaitMs').props.value, '300', '语言切换后草稿保留');
  unmount();
});

test('T23（PRESET-BIND-01·需求 9.4.2）：预设绑定块——目录四态/broken/缺席/刷新零副作用/保存 ops/无障碍', async () => {
  const { react, begin, flush, unmount } = makeReactShim();
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const double = makePrimitivesDouble(react);
  const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
  let loaded;
  new Function('window', source)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? react : double));

  const DEFAULTS = {
    defaultYieldMs: 20000, minYieldMs: 20000, maxYieldMs: 600000,
    defaultWaitMs: 30000, minWaitMs: 20000, maxWaitMs: 600000,
    pollIntervalMs: 500, maxResultChars: 12000,
    jobKind: 'async-command', subagentProvider: '', uiLang: 'auto', agentLang: 'en',
    silentFailureGuard: false,
    askTakeover: false, askTimeoutMs: 60000, askExtendMs: 60000, askUiSeat: 'sidebar',
    // 生效名单含一个目录里没有的 ID（ghost-absent——P18 缺席保留的道具）。
    boundPresets: ['dsh-async', 'dsh-async-create', 'ghost-absent']
  };
  const snapshot = (revision, user, overrides) => ({
    status: 'ready',
    value: { settings: { ...DEFAULTS, ...overrides } },
    base: {},
    user: { settings: user },
    revision,
    writable: true,
    mode: 'host'
  });
  let current = snapshot(7, {});
  const listeners = [];
  const mutateCalls = [];
  const controller = {
    getSnapshot: () => current,
    subscribe: (listener) => { listeners.push(listener); return () => {
      const at = listeners.indexOf(listener); if (at >= 0) listeners.splice(at, 1);
    }; },
    mutate: async (ops, rev) => { mutateCalls.push({ ops, rev }); return true; }
  };
  // 可控目录服务：每次 list() 一枚手动解开的 promise（loading 态可驻留）。
  const pendingLists = [];
  let listCalls = 0;
  const fakeAgentPresets = {
    list: () => {
      listCalls += 1;
      return new Promise((resolveList) => { pendingLists.push(resolveList); });
    }
  };
  const registrations = [];
  const noticeSubs = [];
  product.apply({
    locale: { register: () => () => {} },
    configForms: { whileServed: (ids, load) => load(), get: () => controller },
    remote: { $mount: () => Promise.resolve(() => {}), $on: (event, listener) => { noticeSubs.push({ event, listener }); return () => {}; } },
    on: (event, listener) => { noticeSubs.push({ event, listener }); return () => {}; },
    uiWorkspace: { openSession: () => {} },
    inject: (list, fn) => fn({ remote: { 'async-tools-ask': {}, agentPresets: fakeAgentPresets } }),
    slots: { inject: (slotName, load) => load(), register: (options, Component) => { registrations.push(Component); } },
    effect: (fn) => fn()
  });
  await Promise.resolve();
  await Promise.resolve();
  const Card = registrations[0];
  // 桩词典约定同 T18；带占位的键（reasonLabel 的 {原因}、effectiveList/draftList
  // 的 {预设列表}）单列——实现用 replace 填值，桩里没有占位会让"值没填进去"漏过。
  const t = (key) => ({
    'preset.reasonLabel': 'preset.reasonLabel|{原因}',
    'preset.effectiveList': 'preset.effectiveList|{预设列表}',
    'preset.draftList': 'preset.draftList|{预设列表}'
  }[key] ?? `${key}|`);

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
  // 宏任务一轮：排空全部在途微任务（then 链的跳数不固定，按轮数等不可靠）。
  const settle = () => new Promise((resolveTick) => { setTimeout(resolveTick, 0); });
  const replace = (next) => { current = next; for (const listener of listeners) listener(); };
  const buttonByLabel = (aTree, label) =>
    findNode(aTree, (node) => node.type === 'button' && textOf(node).join('') === label);
  const checkboxOf = (aTree, presetId) =>
    findNode(aTree, (node) => node.type === 'input' && node.props.type === 'checkbox'
      && node.props.id === `plugin-config-boundPresets-${presetId}`);
  const noteOf = (aTree, presetId) =>
    findNode(aTree, (node) => node.type === 'li' && node.props.key === presetId
      && findNode(node, (child) => child.type === 'input'
        && child.props.id === `plugin-config-boundPresets-${presetId}`) !== undefined);

  // ── P16·loading：apply 即装载，未解开的 promise ⇒ 装载中文案；刷新钮禁用。
  //    「选择预设」入口默认收起（设计 §5.3）：先点开入口（真实按钮路径），目录
  //    状态行与条目区才渲染；摘要行（生效范围）不依赖入口——收起时也在场。
  let tree = renderCard();
  const entryButton = () => findNode(tree, (node) => node.type === 'button'
    && node.props.id === 'plugin-config-boundPresets-entry');
  assert.equal(entryButton()?.props['aria-expanded'], 'false', '「选择预设」入口默认收起');
  assert.ok(textOf(tree).join('').includes('preset.effectiveList|dsh-async, dsh-async-create, ghost-absent'),
    '摘要行恒在（入口收起时也显示已保存范围；目录未就绪 ⇒ 缺名用 ID）');
  entryButton().props.onClick();
  tree = renderCard();
  assert.ok(textOf(tree).join('').includes('preset.loading|'), '目录装载中 ⇒ loading 文案在场');
  assert.ok(textOf(tree).join('').includes('preset.partialOnly|'),
    '读取中且无目录数据 ⇒ 「只显示已有选择和未保存的修改」说明在场（5.7.6）');
  assert.equal(buttonByLabel(tree, 'preset.refresh|').props.disabled, true, '装载中「刷新」禁用');

  // ── ready：四目录项 + 一个生效名单里的缺席 ID（P18）。broken 用**宿主真实
  //    形状**（RA-BIND-BROKEN）：agentPresets.list 的 broken 是诊断字符串。
  await settle(); // attach→load 的 list() 在微任务里入队
  pendingLists.shift()({ ok: true, value: { presets: [
    { id: 'dsh-async', name: '异步增强（演示）' },
    { id: 'dsh-async-create' },
    { id: 'rwkv-selfbuilt', name: 'RWKV 自建', broken: 'preset row missing required service: workflowEngine' },
    { id: 'third-ok' }
  ] } });
  await settle(); // then 链全部排空后目录状态落定
  tree = renderCard();
  const group = findNode(tree, (node) => node.type === 'ul' && node.props.role === 'group');
  assert.ok(group !== undefined, '条目区必须以 role=group 的列表在场（P22）');
  // RA-BIND-LABEL：组名 = 可见标题（aria-labelledby 指向真实标题元素）——
  // 不再留指向不存在控件的 label htmlFor，也不另立 aria-label 文案。
  assert.equal(group.props['aria-labelledby'], 'plugin-config-boundPresets-title',
    'group 经 aria-labelledby 指向块头标题（组标题语义，块头不再是"伪控件 label"）');
  const groupTitle = findNode(tree, (node) => node.type === 'span'
    && node.props.id === 'plugin-config-boundPresets-title');
  assert.ok(groupTitle !== undefined && textOf(groupTitle).join('').includes('boundPresets|'),
    '块头标题元素在场、带 id 且渲染词典标签');
  const strayBlockLabels = collectByType(tree, 'label')
    .filter((node) => node.props.htmlFor === 'plugin-config-boundPresets');
  assert.equal(strayBlockLabels.length, 0, '块头不得再有指向无控件 id 的 label htmlFor（各条目 label for 保留）');
  const checkboxes = collectByType(tree, 'input').filter((node) => node.props.type === 'checkbox');
  assert.equal(checkboxes.length, 5, '目录四项 + 缺席保留一项 ⇒ 5 个原生 checkbox');
  // P22：原生 checkbox（键盘 Tab/空格天然可操作）+ label for 绑定。
  for (const node of checkboxes) {
    assert.equal(node.props.type, 'checkbox', '条目控件必须是原生 checkbox');
    assert.ok(node.props.id.startsWith('plugin-config-boundPresets-'), 'checkbox id = 块 id + 预设 ID');
    const bound = findNode(tree, (labelNode) => labelNode.type === 'label'
      && labelNode.props.htmlFor === node.props.id);
    assert.ok(bound !== undefined, `checkbox ${String(node.props.id)} 必须有 label for 绑定`);
  }
  // 初稿＝生效名单（官方模型 format 种子）：三个已绑定全勾上。
  for (const id of ['dsh-async', 'dsh-async-create', 'ghost-absent']) {
    assert.equal(checkboxOf(tree, id).props.checked, true, `生效名单内的 ${id} 初始勾选`);
  }
  assert.equal(checkboxOf(tree, 'third-ok').props.checked, false, '目录内未绑定项初始不勾');
  // 宿主显示名称原样（不由本包翻译）；name≠id 时附 ID 小字。
  const dshAsyncLabel = findNode(tree, (node) => node.type === 'label'
    && node.props.htmlFor === 'plugin-config-boundPresets-dsh-async');
  assert.ok(textOf(dshAsyncLabel).join('').includes('异步增强（演示）'), '宿主预设显示名称原样渲染');
  assert.ok(findNode(dshAsyncLabel, (node) => node.type === 'span'
    && node.props.className === 'ats-preset-id') !== undefined, 'name≠id ⇒ ID 小字在场');

  // ── P17·broken（RA-BIND-BROKEN）：宿主真实形状是诊断字符串——truthy 即异常。
  //    未绑定的 broken 项禁选；注记 = 异常标记 + 诊断原因原文（{reason} 填值）。
  const brokenBox = checkboxOf(tree, 'rwkv-selfbuilt');
  assert.equal(brokenBox.props.disabled, true, 'broken（诊断字符串）且未绑定 ⇒ 禁选（不给勾一个装不上的预设）');
  const brokenNote = textOf(noteOf(tree, 'rwkv-selfbuilt')).join('');
  assert.ok(brokenNote.includes('preset.detailEntry| · preset.reasonLabel|preset row missing required service: workflowEngine'),
    '诊断字符串原样透传到注记（查看详情 + 原因：{原因} 两分句，5.7.6——不再是仅认布尔 true 的静默放行）');
  // ── P18·缺席：生效名单里、目录外 ⇒ 保留条目 + 注记 + 可取消。
  const ghostBox = checkboxOf(tree, 'ghost-absent');
  assert.ok(ghostBox !== undefined && ghostBox.props.checked === true, '缺席 ID 保留条目且维持勾选');
  assert.ok(textOf(noteOf(tree, 'ghost-absent')).join('').includes('preset.absent|'),
    '缺席条目带 preset.absent 注记');
  assert.notEqual(ghostBox.props.disabled, true, '缺席条目可取消（目录只发现，不锁死绑定）');

  // ── P19·刷新零副作用：点击只重读目录——mutate 零调用、勾选集合不变。
  const checkedBefore = checkboxes.filter((node) => node.props.checked).map((node) => node.props.id).sort();
  const listCallsBefore = listCalls;
  buttonByLabel(tree, 'preset.refresh|').props.onClick();
  await settle(); // load 的 list() 在微任务里入队
  assert.equal(listCalls, listCallsBefore + 1, '刷新只触发一次 list 重读');
  tree = renderCard();
  assert.ok(textOf(tree).join('').includes('preset.loading|'), '重读期间回到 loading 文案');
  pendingLists.shift()({ ok: true, value: { presets: [
    { id: 'dsh-async', name: '异步增强（演示）' },
    { id: 'dsh-async-create' },
    // 兼容形状（RA-BIND-BROKEN）：布尔 true 同样判异常——无诊断可附时只显标记。
    { id: 'rwkv-selfbuilt', name: 'RWKV 自建', broken: true },
    { id: 'third-ok' }
  ] } });
  await settle(); // 状态落定
  tree = renderCard();
  const checkedAfter = collectByType(tree, 'input').filter((node) => node.props.type === 'checkbox'
    && node.props.checked).map((node) => node.props.id).sort();
  assert.deepEqual(checkedAfter, checkedBefore, '刷新前后草稿勾选集合不变（刷新不碰草稿）');
  assert.equal(mutateCalls.length, 0, '刷新绝不能触发写（mutate 零调用）');
  // RA-BIND-BROKEN 第二形状：布尔 broken ⇒ 同样禁选；注记走 preset.broken
  //（无原因可附，不得出现 reasonLabel 键或 {原因} 残留）。
  assert.equal(checkboxOf(tree, 'rwkv-selfbuilt').props.disabled, true, '布尔 broken 未绑定 ⇒ 同样禁选');
  const brokenBoolNote = textOf(noteOf(tree, 'rwkv-selfbuilt')).join('');
  assert.ok(brokenBoolNote.includes('preset.broken|'),
    '布尔 broken ⇒ preset.broken 注记（异常标记仍在）');
  assert.ok(!brokenBoolNote.includes('preset.reasonLabel|') && !brokenBoolNote.includes('{原因}'),
    '布尔 broken 无诊断可附 ⇒ 不出现原因键或未替换的占位');

  // ── P20·保存 ops：数组整组写入；空数组合法；恢复默认＝unset。
  // ① 取消缺席项 + 勾选 third-ok ⇒ 保存发整组 set（草稿序：过滤＋追加）。
  //    摘要行在暂存后显示草稿名单（draftList 的 {预设列表}＝保存后将用的名单，
  //    真实显示名优先——目录就绪时用宿主名称，5.7.6）。
  checkboxOf(tree, 'ghost-absent').props.onChange({ target: { checked: false } });
  tree = renderCard();
  const summaryText = textOf(tree).join('');
  assert.ok(summaryText.includes('preset.effectiveList|异步增强（演示）, dsh-async-create, ghost-absent'),
    '目录就绪后摘要行用真实显示名（缺名用 ID：dsh-async ⇒ 宿主名称）');
  assert.ok(summaryText.includes('preset.draftList|异步增强（演示）, dsh-async-create'),
    '有勾选草稿 ⇒ 摘要另起一行「保存后适用」名单（未保存的勾选不冒充生效；名单＝取消缺席项后的草稿）');
  checkboxOf(tree, 'third-ok').props.onChange({ target: { checked: true } });
  tree = renderCard();
  await buttonByLabel(tree, 'save|').props.onClick();
  assert.equal(mutateCalls.length, 1, '保存恰一次 mutate');
  assert.deepEqual(mutateCalls[0].ops,
    [{ op: 'set', path: ['settings', 'boundPresets'], value: ['dsh-async', 'dsh-async-create', 'third-ok'] }],
    '绑定名单整组写入 settings.boundPresets（JSON 草稿 → 数组 op；缺席项随取消移除）');
  replace(snapshot(8, { boundPresets: ['dsh-async', 'dsh-async-create', 'third-ok'] },
    { boundPresets: ['dsh-async', 'dsh-async-create', 'third-ok'] }));
  tree = renderCard();
  // ② 全部取消 ⇒ 显式空数组合法保存（解除全部绑定，9.4.3）。
  for (const id of ['dsh-async', 'dsh-async-create', 'third-ok']) {
    checkboxOf(tree, id).props.onChange({ target: { checked: false } });
    tree = renderCard();
  }
  await buttonByLabel(tree, 'save|').props.onClick();
  assert.deepEqual(mutateCalls[1].ops,
    [{ op: 'set', path: ['settings', 'boundPresets'], value: [] }],
    '显式空数组是合法保存（= 解除全部绑定，不是 unset）');
  replace(snapshot(9, { boundPresets: ['rwkv-selfbuilt'] }, { boundPresets: ['rwkv-selfbuilt'] }));
  tree = renderCard();
  // ③ 覆盖徽标 + 恢复默认 ⇒ unset（回 schema 默认两预设）；broken 已绑定项可取消。
  const bindBadges = collectByType(tree, 'span').filter((node) => node.props['data-tone'] === 'neutral');
  assert.deepEqual(badges(bindBadges), ['overridden|'], 'user 层覆盖 ⇒ 绑定块显示官方 Tag 徽标');
  const rwkvBound = checkboxOf(tree, 'rwkv-selfbuilt');
  assert.equal(rwkvBound.props.checked, true, 'broken 已绑定 ⇒ 勾选显示');
  assert.notEqual(rwkvBound.props.disabled, true, 'broken 已绑定 ⇒ 可取消（P17 正面）');
  buttonByLabel(tree, 'reset|').props.onClick();
  tree = renderCard();
  await buttonByLabel(tree, 'save|').props.onClick();
  assert.deepEqual(mutateCalls[2].ops,
    [{ op: 'unset', path: ['settings', 'boundPresets'] }],
    '恢复默认 ⇒ unset op（清除用户层覆盖，回 schema 默认两预设）');

  // ── P16·empty：目录空（与失败区分）——有已存绑定 ⇒ 条目退回绑定（空≠失败、
  //    不显示为空列表）；绑定也为空 ⇒ preset.empty 文案、零条目。
  replace(snapshot(10, { boundPresets: ['dsh-async', 'dsh-async-create', 'rwkv-selfbuilt'] },
    { boundPresets: ['dsh-async', 'dsh-async-create', 'rwkv-selfbuilt'] }));
  tree = renderCard();
  buttonByLabel(tree, 'preset.refresh|').props.onClick();
  await settle();
  pendingLists.shift()({ ok: true, value: { presets: [] } });
  await settle();
  tree = renderCard();
  const fullTextEmpty = textOf(tree).join('');
  assert.ok(!fullTextEmpty.includes('preset.failed|') && !fullTextEmpty.includes('preset.loading|'),
    '目录空不是失败、也不是装载中（error≠empty 分形）');
  const emptyBoxes = collectByType(tree, 'input').filter((node) => node.props.type === 'checkbox');
  assert.deepEqual(emptyBoxes.map((node) => node.props.id).sort(),
    ['plugin-config-boundPresets-dsh-async', 'plugin-config-boundPresets-dsh-async-create', 'plugin-config-boundPresets-rwkv-selfbuilt'].sort(),
    '空目录态条目区 = 已存绑定（草稿种子；失败不显示为空列表）');
  // 绑定也为空 ⇒ 真正的空态文案 + 零条目。
  replace(snapshot(11, { boundPresets: [] }, { boundPresets: [] }));
  tree = renderCard();
  buttonByLabel(tree, 'preset.refresh|').props.onClick();
  await settle();
  pendingLists.shift()({ ok: true, value: { presets: [] } });
  await settle();
  tree = renderCard();
  assert.ok(textOf(tree).join('').includes('preset.empty|'), '目录空 ⇒ preset.empty 文案（不是失败文案）');
  assert.equal(collectByType(tree, 'input').filter((node) => node.props.type === 'checkbox').length, 0,
    '空目录 + 空绑定 ⇒ 零条目');

  // ── P16·error：list 拒绝 ⇒ 失败文案带原因 + 重试钮；条目区退回已存绑定。
  replace(snapshot(12, { boundPresets: ['dsh-async', 'dsh-async-create', 'rwkv-selfbuilt'] },
    { boundPresets: ['dsh-async', 'dsh-async-create', 'rwkv-selfbuilt'] }));
  tree = renderCard();
  buttonByLabel(tree, 'preset.refresh|').props.onClick();
  await settle();
  pendingLists.shift()({ ok: false, error: { code: 'registry/broken', message: 'boom' } });
  await settle();
  tree = renderCard();
  assert.ok(textOf(tree).join('').includes('preset.failed|'),
    '失败文案在场（5.7.6：无法读取预设列表——原因经异常条目的「原因：{原因}」句给，不拼进失败行）');
  assert.ok(textOf(tree).join('').includes('preset.partialOnly|'),
    '失败且无目录数据 ⇒ 只显示已有选择与未保存修改的说明在场');
  assert.ok(buttonByLabel(tree, 'preset.retry|') !== undefined, '失败态提供重试按钮');
  const errorBoxes = collectByType(tree, 'input').filter((node) => node.props.type === 'checkbox');
  assert.equal(errorBoxes.length, 3, '失败态条目区退回已保存绑定（value 层），不是空列表');
  assert.notEqual(errorBoxes[0].props.disabled, true, '失败态仍可取消已保存绑定');

  // ── P16·unavailable：gateway/invocation-unavailable ⇒ 专属文案（与一般失败区分）。
  buttonByLabel(tree, 'preset.refresh|').props.onClick();
  await settle();
  pendingLists.shift()({ ok: false, error: { code: 'gateway/invocation-unavailable', message: 'x' } });
  await settle();
  tree = renderCard();
  assert.ok(textOf(tree).join('').includes('preset.unavailable|'),
    '宿主网关不可用 ⇒ preset.unavailable 专属文案');
  // 通知接线在场（宿主无专门预设事件——文档更新/连接重置两通知，设计 §5.5）。
  const noticeEvents = noticeSubs.map((entry) => entry.event).sort();
  assert.deepEqual(noticeEvents, ['connection/reset', 'settings/document-updated'],
    '刷新通知 = settings/document-updated + connection/reset（两订阅在场）');
  unmount();
});

// ── T-BIND-DRAFT（2026-11-15 验收 F04／UI-02；设计 §10.1 绑定目录草稿可见）──
// 目录 loading／error 态的条目区＝生效名单 ∪ 草稿已勾选：ready 期间新勾的
// 预设在目录重读期间保持可见、可直接取消（草稿内部从未丢，但藏在草稿文本
// 里的条目等于不能操作——修前红＝loading/error 只画生效名单，新勾选条目
// 消失且无法取消）。loading 态不标 preset.absent（目录回来前未知）；error
// 态保留 absent 注记（目录确实没读出来）。
test('T-BIND-DRAFT（F04）：目录 loading／error 态条目区＝生效∪草稿——新勾选可见可取消；loading 不标缺席、error 保留注记', async () => {
  const { react, begin, flush, unmount } = makeReactShim();
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const double = makePrimitivesDouble(react);
  const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
  let loaded;
  new Function('window', source)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? react : double));

  const DEFAULTS = {
    defaultYieldMs: 20000, minYieldMs: 20000, maxYieldMs: 600000,
    defaultWaitMs: 30000, minWaitMs: 20000, maxWaitMs: 600000,
    pollIntervalMs: 500, maxResultChars: 12000,
    jobKind: 'async-command', subagentProvider: '', uiLang: 'auto', agentLang: 'en',
    silentFailureGuard: false, workflowProgressLog: false, fullCommandEcho: false,
    askTakeover: false, askTimeoutMs: 60000, askExtendMs: 60000, askUiSeat: 'sidebar',
    // 生效名单只有一项；目录里另有 third-ok 可勾（制造「草稿新勾、目录外无」形态）。
    boundPresets: ['dsh-async']
  };
  const snapshot = (revision, user, overrides) => ({
    status: 'ready',
    value: { settings: { ...DEFAULTS, ...overrides } },
    base: {},
    user: { settings: user },
    revision,
    writable: true,
    mode: 'host'
  });
  let current = snapshot(3, {});
  const listeners = [];
  const mutateCalls = [];
  const controller = {
    getSnapshot: () => current,
    subscribe: (listener) => { listeners.push(listener); return () => {
      const at = listeners.indexOf(listener); if (at >= 0) listeners.splice(at, 1);
    }; },
    mutate: async (ops, rev) => { mutateCalls.push({ ops, rev }); return true; }
  };
  const pendingLists = [];
  const fakeAgentPresets = {
    list: () => new Promise((resolveList) => { pendingLists.push(resolveList); })
  };
  const registrations = [];
  product.apply({
    locale: { register: () => () => {} },
    configForms: { whileServed: (ids, load) => load(), get: () => controller },
    remote: { $mount: () => Promise.resolve(() => {}), $on: () => () => {} },
    on: () => () => {},
    uiWorkspace: { openSession: () => {} },
    inject: (list, fn) => fn({ remote: { 'async-tools-ask': {}, agentPresets: fakeAgentPresets } }),
    slots: { inject: (slotName, load) => load(), register: (options, Component) => { registrations.push(Component); } },
    effect: (fn) => fn()
  });
  await Promise.resolve();
  await Promise.resolve();
  const Card = registrations[0];
  const t = (key) => ({
    'preset.reasonLabel': 'preset.reasonLabel|{原因}',
    'preset.effectiveList': 'preset.effectiveList|{预设列表}',
    'preset.draftList': 'preset.draftList|{预设列表}'
  }[key] ?? `${key}|`);
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
  const settle = () => new Promise((resolveTick) => { setTimeout(resolveTick, 0); });
  const buttonByLabel = (aTree, label) =>
    findNode(aTree, (node) => node.type === 'button' && textOf(node).join('') === label);
  const checkboxOf = (aTree, presetId) =>
    findNode(aTree, (node) => node.type === 'input' && node.props.type === 'checkbox'
      && node.props.id === `plugin-config-boundPresets-${presetId}`);
  const noteOf = (aTree, presetId) =>
    findNode(aTree, (node) => node.type === 'li' && node.props.key === presetId
      && findNode(node, (child) => child.type === 'input'
        && child.props.id === `plugin-config-boundPresets-${presetId}`) !== undefined);

  // ready：勾上 third-ok（草稿＝生效 dsh-async ∪ 新勾 third-ok）。「选择预设」
  // 入口默认收起——先点开（真实按钮路径），条目区才渲染。
  await settle();
  pendingLists.shift()({ ok: true, value: { presets: [
    { id: 'dsh-async', name: '异步增强（演示）' },
    { id: 'third-ok' }
  ] } });
  await settle();
  let tree = renderCard();
  findNode(tree, (node) => node.type === 'button'
    && node.props.id === 'plugin-config-boundPresets-entry').props.onClick();
  tree = renderCard();
  checkboxOf(tree, 'third-ok').props.onChange({ target: { checked: true } });
  tree = renderCard();
  assert.equal(checkboxOf(tree, 'third-ok').props.checked, true, '前置：ready 态勾上新预设（进草稿）');

  // loading（刷新重读、promise 未解）：草稿新勾的 third-ok 行仍在场、可取消；
  // 生效与草稿行都不标 preset.absent（目录回来前未知——loading 不声称
  // 「未在当前预设列表中发现」）。修前红＝非 ready 态只画生效名单，
  // third-ok 行消失。
  buttonByLabel(tree, 'preset.refresh|').props.onClick();
  await settle();
  tree = renderCard();
  const loadingThird = checkboxOf(tree, 'third-ok');
  assert.ok(loadingThird !== undefined && loadingThird.props.checked === true,
    'loading 态草稿新勾条目保持可见且维持勾选（修前红＝只画生效名单、行消失）');
  assert.notEqual(loadingThird.props.disabled, true, 'loading 态草稿条目可取消（不经保存即可撤回新勾）');
  assert.ok(!textOf(noteOf(tree, 'third-ok')).join('').includes('preset.absent|'),
    'loading 态不标缺席注记（目录未读出前不声称「未在列表中发现」）');
  assert.ok(!textOf(noteOf(tree, 'dsh-async')).join('').includes('preset.absent|'),
    'loading 态生效名单行同样不标缺席注记');

  // error（重读失败）：行集合仍是 生效∪草稿；error 态保留 absent 注记
  //（目录确实没读出来——与既有失败态注记口径一致）。
  pendingLists.shift()({ ok: false, error: { code: 'registry/broken', message: 'boom' } });
  await settle();
  tree = renderCard();
  const errorThird = checkboxOf(tree, 'third-ok');
  assert.ok(errorThird !== undefined && errorThird.props.checked === true,
    'error 态草稿新勾条目仍可见、维持勾选（可不经保存直接取消）');
  assert.ok(textOf(noteOf(tree, 'third-ok')).join('').includes('preset.absent|'),
    'error 态草稿条目带缺席注记（目录读失败——注记口径与生效行一致）');
  assert.ok(textOf(noteOf(tree, 'dsh-async')).join('').includes('preset.absent|'),
    'error 态生效名单行保留缺席注记（既有口径）');

  // 取消路径：error 态直接取消 third-ok —— 行随之消失（草稿移除、不在生效
  // 名单——「可直接取消」的完整判据）。
  errorThird.props.onChange({ target: { checked: false } });
  tree = renderCard();
  assert.equal(checkboxOf(tree, 'third-ok'), undefined,
    '取消后草稿条目行消失（新勾选不经保存即可完全撤回）');
  assert.ok(checkboxOf(tree, 'dsh-async') !== undefined, '生效名单行不受草稿取消影响');
  assert.equal(mutateCalls.length, 0, '全程零保存（可见性是渲染层修复，不是写操作）');
  unmount();
});

test('T24（VIS-INPUT-01/VIS-BADGE-01/VIS-ACTION-TIER-01，设计 §8.2.5）：待答面板两档字号、命中区档位与徽标几何', async () => {
  // 布局级判据：从样式表原文解析可计算尺寸（两档字号、命中区档位、槽宽、
  // 面板避让公式）。这不替代真机渲染测量——真实浏览器合成、触屏命中与
  // 非 Windows 布局的结论由视觉验收另行安排（设计 §8.2.5 末段）。
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const reactStub = {
    createElement: () => undefined, useState: () => [undefined, () => {}],
    useEffect: () => {}, useRef: (v) => ({ current: v })
  };
  const double = makePrimitivesDouble(reactStub);
  let loaded;
  new Function('window', readFileSync(resolve(ROOT, 'client.js'), 'utf8'))(
    { __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactStub : double));
  const css = product.ASK_CSS;
  assert.ok(typeof css === 'string' && css.length > 0, 'ASK_CSS 必须导出（浏览器外可判的样式原文）');

  // ── 分区解析（设计 §8.2.5）：先切 @media 块、条件串原样保留，块内块外
  // 各自成表——扁平全文匹配会被「后写覆盖」把媒体块降档吞进基础档读数，
  // 分区才能分别断言两档。规则按「选择器清单＋声明表」解析；选择器匹配按
  // 子串进行（复合选择器与逗号清单同样命中），不得收窄成精确全串匹配。
  const segments = [];
  {
    let cursor = 0;
    for (;;) {
      const at = css.indexOf('@media', cursor);
      if (at === -1) {
        segments.push({ media: null, start: cursor, end: css.length });
        break;
      }
      const open = css.indexOf('{', at);
      const condition = css.slice(at + '@media'.length, open).trim();
      let depth = 1;
      let end = open + 1;
      while (depth > 0 && end < css.length) {
        if (css[end] === '{') depth += 1;
        else if (css[end] === '}') depth -= 1;
        end += 1;
      }
      segments.push({ media: null, start: cursor, end: at });
      segments.push({ media: condition, start: open + 1, end: end - 1 });
      cursor = end;
    }
  }
  const allRules = [];
  for (const segment of segments) {
    const re = /([^{}]+)\{([^{}]*)\}/g;
    const text = css.slice(segment.start, segment.end);
    let match;
    while ((match = re.exec(text)) !== null) {
      const decls = {};
      for (const decl of match[2].split(';')) {
        const colon = decl.indexOf(':');
        if (colon > 0) decls[decl.slice(0, colon).trim()] = decl.slice(colon + 1).trim();
      }
      allRules.push({ media: segment.media, selector: match[1], decls, index: segment.start + match.index });
    }
  }
  /** 取某选择器（恰为该单选择器的规则）在指定分区（null=媒体块外）的声明表；同名后写覆盖先写。 */
  const rule = (selector, media = null) => {
    const found = {};
    for (const r of allRules) {
      if (r.media !== media || r.selector !== selector) continue;
      Object.assign(found, r.decls);
    }
    return found;
  };
  const px = (value) => Number.parseFloat(value);

  // ① VIS-INPUT-01 两档字号（默认安全档＋细指针可悬停降档）。
  const baseInput = rule('.ats-ask-input', null);
  assert.ok(px(baseInput['font-size']) >= 16,
    `基础档（媒体块外）待答输入字号必须 ≥16px（当前 ${String(baseInput['font-size'])}）——VIS-INPUT-01 默认安全档`);
  // 全表恰一个 @media 块、条件串逐字钉死（防更宽媒体查询绕开安全默认档）。
  const mediaSegments = segments.filter((s) => s.media !== null);
  assert.equal(mediaSegments.length, 1, 'ASK_CSS 恰一个 @media 块（两档机制不允许多媒体块绕档）');
  assert.equal(mediaSegments[0].media, '(pointer:fine) and (hover:hover)',
    `媒体块条件必须逐字为 (pointer:fine) and (hover:hover)（当前：${String(mediaSegments[0].media)}）`);
  const mediaInput = rule('.ats-ask-input', mediaSegments[0].media);
  assert.equal(mediaInput['font-size'], '13px',
    `降档分区（媒体块内）待答输入字号必须 =13px（当前 ${String(mediaInput['font-size'])}）`);
  // 媒体块位置断言：分区解析不查先后，另设断言——媒体块须晚于块外基础规则，
  // 置于其前则浏览器层叠不生效、运行时降档失效而静态断言仍绿。
  const mediaInputRule = allRules.find((r) => r.media !== null && r.selector === '.ats-ask-input');
  const baseInputRule = allRules.find((r) => r.media === null && r.selector === '.ats-ask-input');
  assert.ok(mediaInputRule !== undefined && baseInputRule !== undefined
    && mediaInputRule.index > baseInputRule.index,
    '媒体块在样式表中的位置必须晚于块外基础 .ats-ask-input 规则（层叠生效前提）');
  // 防绕档：两区之外不得再有作用于该输入的任何 font-size 声明——扫描范围
  // 含复合选择器（如 .ats-ask-custom .ats-ask-input，特异性更高会压过两档）；
  // 逗号清单拆分后按子串判断。
  const touchesInput = (selectorList) => selectorList.split(',')
    .some((item) => item.includes('.ats-ask-input'));
  const extra = allRules.filter((r) => touchesInput(r.selector)
    && Object.prototype.hasOwnProperty.call(r.decls, 'font-size')
    && !(r.media === null && r.selector === '.ats-ask-input')
    && !(r.media === mediaSegments[0].media && r.selector === '.ats-ask-input'));
  assert.equal(extra.length, 0,
    `除基础档与降档两处外不得再有待答输入的 font-size 声明（发现：${extra.map((r) => `${r.selector}@${r.media ?? '无媒体块'}`).join('；')}）`);

  // ② 24px 辅助档（不同排、不同档的辅助按钮维持 24；徽标与「不答」分别归
  //    ④/③ 专属档，不在本组）。
  for (const selector of ['.ats-ask-opt', '.ats-ask-optctl', '.ats-ask-extend', '.ats-ask-jump',
    '.ats-ask-dismiss']) {
    const box = rule(selector);
    assert.ok(Number.isFinite(px(box['min-height'])) && px(box['min-height']) >= 24,
      `${selector} 必须显式 min-height ≥24px（24px 辅助档）`);
    assert.equal(box['box-sizing'], 'border-box', `${selector} 命中区按外框计（border-box）`);
  }

  // ③ 44px 操作档：提交与不答同排同高——min-height 数值相等且 ≥44（不以缩
  //    小提交点击区换取外观一致，同档抬升；issues.md ASK-ACTION-SIZE 边界）。
  const submit = rule('.ats-ask-submit');
  const skip = rule('.ats-ask-skip');
  assert.ok(px(submit['min-height']) >= 44, '提交必须 min-height ≥44px（44px 操作档）');
  assert.equal(submit['box-sizing'], 'border-box', '提交 44px 量的是外框高度（border-box）');
  assert.ok(px(skip['min-height']) >= 44, '不答必须 min-height ≥44px（44px 操作档）');
  assert.equal(skip['box-sizing'], 'border-box', '不答 44px 量的是外框高度（border-box）');
  assert.equal(submit['min-height'], skip['min-height'], '提交与不答必须同档同高（min-height 数值相等）');

  // ④ 徽标（VIS-BADGE-01 宿主化形态）：固定 50px 盒（≤52px 窄列）、28px 与
  //    底栏同排等高、无边框、内联组居中；计数泡内联含于盒内（无绝对定位）。
  const badge = rule('.ats-ask-badge');
  assert.ok(badge.width !== undefined && px(badge.width) <= 52,
    `徽标盒宽必须为固定值 ≤52px（当前 ${String(badge.width)}）——超出即窄列内裁切`);
  assert.ok(px(badge['min-height']) >= 28, '徽标同排等高 min-height ≥28px（含计数泡在内的整钮即点击区）');
  assert.equal(badge.border, 'none', '徽标无外框（宿主底栏控件视觉语言）');
  assert.equal(badge['justify-content'], 'center', '内联组在固定盒内居中（防图标偏左回归——该形态可过其余断言与真机判据 A）');
  assert.equal(badge.padding, '0', '徽标盒内边距为 0（固定盒宽度语义）');
  assert.ok(Number.isFinite(px(badge.gap)) && px(badge.gap) === 3, '图标与计数泡间距 3px（999 组宽 ≤50 的验算前提）');
  const count = rule('.ats-ask-count');
  for (const absent of ['position', 'top', 'right', 'left', 'bottom']) {
    assert.equal(count[absent], undefined, `计数泡不得再有 ${absent} 声明（内联形态，防绝对定位回归）`);
  }
  assert.equal(count['font-size'], '12px', '计数数字 12px（与侧栏文字同级可辨）');
  assert.ok(px(count['min-width']) >= 18, '计数泡 min-width ≥18px');
  assert.equal(count.padding, '0 3px', '计数泡内边距 0 3px（999 组宽 ≤50 的验算前提）');
  assert.equal(rule('.ats-ask-badge svg').width, '16px', '徽标图标 16px');

  // ④′ 三行可见锚（VIS-INPUT-01）：自定义输入 min-height 以 em 计且 ≥5.5em
  //    （实现 6em：13px 档 78−13=65 ≥ 3×19.5=58.5、16px 档 96−13=83 ≥ 72）。
  const customInput = rule('.ats-ask-custom .ats-ask-input');
  const emMatch = String(customInput['min-height']).match(/^([\d.]+)em$/);
  assert.ok(emMatch !== null && Number.parseFloat(emMatch[1]) >= 5.5,
    `自定义输入 min-height 须为 em 单位且 ≥5.5em（当前 ${String(customInput['min-height'])}）`);

  // ⑤ 窄视口（约 360px 宽）面板避让：sidebar 座位宽度公式 min(340px, 100vw − 76px)
  //    + 右锚 16px ⇒ 面板左缘恒 ≥60px，躲开实测约 56px 的侧栏收起列（+4px 净空）。
  //    公式常数与避让边界都断言——改坏公式（如回到固定 340px）这里必红。
  const panel = rule('.ats-ask-panel');
  const sidebar = rule('.ats-ask-panel--sidebar');
  const widthMatch = sidebar.width.match(/^min\(340px,calc\(100vw - (\d+)px\)\)$/);
  assert.ok(widthMatch !== null, `sidebar 座位宽度公式必须是 min(340px, calc(100vw - Npx))（当前：${String(sidebar.width)}）`);
  const reserve = Number(widthMatch[1]);
  assert.equal(px(panel.right), 16, '面板右锚 16px（宽度公式避让的前提）');
  const viewport = 360;
  const panelWidth = Math.min(340, viewport - reserve);
  const leftEdge = viewport - px(panel.right) - panelWidth;
  assert.ok(leftEdge >= 56 + 4,
    `360px 视口下面板左缘必须 ≥60px（当前 ${String(leftEdge)}px）——不得滑进侧栏收起列`);

  // ⑥ 不禁止页面缩放：禁缩放（maximum-scale / user-scalable）不是放大命中区
  //    的替代手段——代码零残留（注释里说明这两词不算，clientCode() 去注释）。
  assert.doesNotMatch(clientCode(), /maximum-scale|user-scalable/,
    '代码不得出现 maximum-scale / user-scalable 限制（VIS-INPUT-01：页面缩放不设限）');
});

function badges(nodes) {
  return nodes.map((node) => textOf(node).join(''));
}

test('T18c（R24/R25·设计 §5.6）：界面文案对账——5.7.4–5.7.7 逐字夹具（双语）＋拆句复原＋删除键负向锚＋键集白名单', async () => {
  const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
  let loaded;
  new Function('window', source)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory(() => ({
    createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {}
  }));
  const DICT = product.DICTIONARIES;
  const { FIXTURE, DELETED_KEYS, JOINED_CELLS } = await import('./_settings-copy-fixture.mjs');

  // ① 逐字对账：夹具＝需求 5.7.4–5.7.7 表格的逐行转写（一词之差即红；改需求
  //    表必须同步改夹具）。四「—」字段的 hint/help 键在两档词典都不存在——
  //    键集白名单（③）一并钉住缺席。
  for (const [lang, fixture] of [['zh', FIXTURE.zh], ['en', FIXTURE.en]]) {
    for (const [key, value] of Object.entries(fixture)) {
      assert.equal(DICT[lang][key], value, `${lang} 档 ${key} 必须逐字等于需求表转写`);
    }
  }
  // ② 拆句复原：需求表中同格多句（「；」分句）的行，按键序拼接必须复原整格
  //    ——键拆分不得丢句、改句序或把分句符写进句内。
  for (const { lang, keys, sep, cell } of JOINED_CELLS) {
    assert.equal(keys.map((key) => DICT[lang][key]).join(sep ?? ''), cell,
      `${lang} 档 ${keys.join(' + ')} 拼接必须复原需求表整格`);
  }
  // ③ 键集白名单（两向）：词典键恰为夹具键集——表外私货键红、漏行键红
  //    （zh/en 键集互相相等由 T21 守；这里守「夹具＝需求表全集」）。
  assert.deepEqual(Object.keys(DICT.zh).sort(), Object.keys(FIXTURE.zh).sort(),
    'zh 词典键集必须恰等于夹具键集（需求表外新增键必须先入夹具）');
  assert.deepEqual(Object.keys(DICT.en).sort(), Object.keys(FIXTURE.en).sort(),
    'en 词典键集必须恰等于夹具键集');
  // ④ 删除键负向锚（设计 §5.6 删除类）：旧词典键零残留——含四「—」字段的
  //    hint/help 旧长文与 ask 面板旧失败族（键差由映射表吸收，见
  //    ASK_ANSWER_REJECTION_KEYS）。
  for (const key of DELETED_KEYS) {
    assert.ok(!(key in DICT.zh) && !(key in DICT.en),
      `设计 §5.6 删除类键 ${key} 不得残留于任一语言档`);
  }
  // ⑤ 术语不回潮锚：词典里不得再出现旧术语措辞（换血后由新键承接语义）。
  const zhAll = Object.values(DICT.zh).join('\n');
  const enAll = Object.values(DICT.en).join('\n');
  for (const stale of ['让出', '预算字段', '首等', 'job id', 'yield_ms']) {
    assert.ok(!zhAll.includes(stale), `zh 词典不得残留旧术语「${stale}」`);
  }
  for (const stale of ['job id', 'yield_ms', 'first-wait', 'Overridden', 'Effective:']) {
    assert.ok(!enAll.includes(stale), `en 词典不得残留旧术语「${stale}」`);
  }
  // ⑥ 模型侧术语锚（lib/text.js 不在本轮改面，只钉界面/模型两侧不串档）：
  //    模型侧 zh 的「作业编号」在场（服务端仍用），界面侧同词在场（hint 用）。
  const { TEXT } = await import('../lib/text.js');
  const zhModel = Object.values(TEXT.zh ?? {}).join('\n');
  assert.ok(zhModel.includes('作业编号') || Object.keys(TEXT).length === 0,
    '模型侧 zh 文案统一术语「作业编号」在场（lib/text.js 未随本轮改动）');
});
test('T22（R25）：改语言后刷新必须整段换文案——正文、尾部摘要与每个参数说明一起换', async (t) => {
  // 描述刷新是"整段重建"（不就地改数字），语言与数字走同一条路。
  // 这条钉两件事：①换语言真的换的是**整段**（只换数字不算）；②换语言不会把"数字跟着设置走"
  // 弄丢——zh 档下的区间同样必须更新。宿主侧判据见 `verify/probe-lang-independence.mjs`。
  const hostIndex = await loadOfflineSafe('../lib/index.js');
  if (hostIndex === undefined) { t.skip(HOST_SKIP_REASON); return; }
  const { createRunTool } = await import('../lib/jobs.js');
  const { refreshToolDescriptions } = hostIndex;
  let current = {
    toolName: 'async_run',
    uiLang: 'auto',
    agentLang: 'en',
    defaultYieldMs: 20000,
    minYieldMs: 20000,
    maxYieldMs: 600000,
    defaultWaitMs: 30000,
    minWaitMs: 20000,
    maxWaitMs: 600000,
    maxResultChars: 12000,
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
  assert.match(tool.description, /20000–120000 ms/, 'zh 档正文里的让出区间仍要跟着设置更新');
  assert.match(paramText(), /20000-120000/, 'zh 档参数说明里的区间仍要跟着设置更新');

  // 展示侧开关与模型侧无关：改 `uiLang` 不得动描述（互不牵连的单元侧最小证据）。
  const zhDescription = tool.description;
  current = { ...current, uiLang: 'en' };
  refreshToolDescriptions(tool, view);
  assert.equal(tool.description, zhDescription, '改 uiLang 不得影响模型侧描述');
});

test('T19（R21/R24/R25）：字段表单一来源——FIELDS 与 lib/config.js 键集相等＋六组结构', async () => {
  // 钉"字段集合"的**单一来源**：界面判据拿 `BUDGET_FIELD_KEYS` + `LANG_FIELD_KEYS` 去核对页面
  // （`judgeConfigForm` 的字段身份那一条），而页面渲染哪些字段、哪几个带读数由 `client.js` 的
  // `FIELDS` 决定。两侧漂移时，"字段缺项 / 读数挂错字段"永远抓不到——判据会与被测实现一起错。
  // 设计 §5.6：顺序不再与 lib 六组拼接对账（页面顺序由六组结构定义），改为**键集相等**。
  const { MS_FIELD_KEYS, BUDGET_FIELD_KEYS, LANG_FIELD_KEYS, FLAG_FIELD_KEYS, DISPLAY_FIELD_KEYS, ASK_FIELD_KEYS, PRESET_FIELD_KEYS } = await import('../lib/config.js');
  let loaded;
  new Function('window', clientCode())({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory(() => ({ createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {} }));

  const libKeys = [...BUDGET_FIELD_KEYS, ...LANG_FIELD_KEYS, ...FLAG_FIELD_KEYS, ...DISPLAY_FIELD_KEYS, ...ASK_FIELD_KEYS, ...PRESET_FIELD_KEYS];
  assert.deepEqual(product.FIELDS.map((field) => field.key).sort(), libKeys.slice().sort(),
    'client.js 的字段键集必须与 lib/config.js 六组键的并集相等（20 项，无缺无多）');
  assert.equal(product.FIELDS.length, 20, '字段恰 20 项（六组结构的全部可编辑字段）');
  assert.equal(new Set(product.FIELDS.map((field) => field.key)).size, 20, '字段键不得重复');
  assert.deepEqual(product.LANG_KEYS, [...LANG_FIELD_KEYS], 'client.js 的语言键表必须与 LANG_FIELD_KEYS 一致');

  // 六组结构（设计 §5.3）：组序＝分组标题行顺序；组成员无缺无重；默认开合三开三收；
  // 待答子组「等待与加时」默认收起；组级展开帮助只设在五个组、语言组不设（§5.6）。
  const groups = product.GROUPS;
  assert.deepEqual(groups.map((group) => group.id),
    ['presets', 'ask', 'budget', 'agentContent', 'advanced', 'lang'],
    '六组组序：适用预设 → 待答问题 → 命令与等待 → 发送给 Agent 的内容 → 高级设置 → 语言');
  const groupKeys = groups.flatMap((group) => group.fields.concat(group.subgroup ? group.subgroup.fields : []));
  assert.deepEqual(groupKeys.slice().sort(), libKeys.slice().sort(), '六组成员＝全部 20 字段，无缺无重');
  assert.deepEqual(product.GROUPS.find((group) => group.id === 'ask').subgroup.fields,
    ['askTimeoutMs', 'askExtendMs'], '待答子组「等待与加时」＝askTimeoutMs + askExtendMs');
  assert.deepEqual(groups.map((group) => group.open), [true, true, false, false, false, true],
    '默认开合：适用预设/待答问题/语言展开，命令与等待/发送给 Agent 的内容/高级设置收起');
  assert.equal(product.GROUPS.find((group) => group.id === 'ask').subgroup.open, false, '待答子组默认收起');
  assert.deepEqual(Object.keys(product.GROUP_HELP_KEYS).sort(),
    ['advanced', 'agentContent', 'ask', 'budget', 'presets'],
    '组级展开帮助只设在五个组（语言组不设，设计 §5.6）');

  const declared = [...clientCode().matchAll(/key: "([A-Za-z]+)", label: "[A-Za-z]+", ms: true/g)]
    .map((m) => m[1]);
  assert.deepEqual(declared.slice().sort(), [...MS_FIELD_KEYS].sort(),
    'client.js 里 `ms: true` 的字段必须与 MS_FIELD_KEYS 键集一致（呈现顺序由六组结构定义）');
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
  // 生产形态是 describe 的嵌套值层（settings 键下，设计 §5.1）；平铺输入是
  // settingsLayerOf 的防御回退（值层整体缺席的部署形态不抛错），一并钉住。
  assert.equal(product.uiLangOf({ user: { settings: { uiLang: 'en' } }, value: { settings: { uiLang: 'zh' } } }), 'en', '用户层优先（嵌套）');
  assert.equal(product.uiLangOf({ user: { settings: {} }, value: { settings: { uiLang: 'zh' } } }), 'zh', '其次实时解析值（嵌套）');
  assert.equal(product.uiLangOf({ user: { settings: {} }, value: { settings: {} } }), 'auto', '都没有 → auto（嵌套）');
  assert.equal(product.uiLangOf({ user: { settings: { uiLang: 'fr' } }, value: { settings: {} } }), 'auto', '未知取值 → auto（不猜）');
  assert.equal(product.uiLangOf({ user: { uiLang: 'en' }, value: { uiLang: 'zh' } }), 'en', '用户层优先（平铺回退）');
  assert.equal(product.uiLangOf({ user: {}, value: { uiLang: 'zh' } }), 'zh', '其次实时解析值（平铺回退）');
  assert.equal(product.uiLangOf({ user: {}, value: {} }), 'auto', '都没有 → auto（平铺回退）');
  assert.equal(product.uiLangOf({ user: { uiLang: 'fr' }, value: {} }), 'auto', '未知取值 → auto（平铺回退，不猜）');

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
    maxResultChars: 12000,
    defaultYieldMs: 20000,
    minYieldMs: 20000,
    maxYieldMs: 600000,
    defaultWaitMs: 30000,
    minWaitMs: 20000,
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
    // 两个展示开关出厂**默认关**（需求 9.3.4）：开启会改变模型上下文的展示面，
    // 默认不注入进度行与命令原文。
    workflowProgressLog: false,
    fullCommandEcho: false,
    askTimeoutMs: 60000,
    askExtendMs: 60000,
    askUiSeat: 'sidebar',
    // 预设绑定名单出厂默认 = 两内置预设（需求 9.4.3：默认即维持现行为——
    // 两内置预设天然在名单内，升级不改行为）。名单是冻结数组，逐项对。
    boundPresets: ['dsh-async', 'dsh-async-create']
  };
  for (const [key, want] of Object.entries(EXPECTED_DEFAULTS)) {
    if (key === 'boundPresets') {
      assert.deepEqual(resolved[key], want, '`boundPresets` 的默认值必须是两内置预设名单');
      continue;
    }
    assert.equal(resolved[key], want,
      `\`${key}\` 的默认值必须是 ${JSON.stringify(want)}——`
      + `改错它不会让任何行为报错，只会静默改变工具行为（复审 Z4：30000→99999 曾全绿逃逸）`);
  }
  assert.deepEqual(Object.keys(EXPECTED_DEFAULTS).sort(), Object.keys(resolved).filter((key) => key !== 'toolName').sort(),
    '期望值表必须覆盖**每一个**预算字段——漏掉一个就等于那个字段的默认值没人守');
});

test('T20（R25）：agentLang 双档——en 零 CJK、zh 换语言、参数集合不变、缺译抛错', async (tc) => {
  // 工具在两档下各构建一次；判据是**行为差异**（构建产物逐项对比），
  // 不是"源码里出现了某个词"。工厂里 jobs、wait、agent
  // 与 descriptions 都是宿主链模块（→ dsh-tools），离线形态缺席即跳过（交给 test:inproc）。
  const jobsModule = await loadOfflineSafe('../lib/jobs.js');
  const waitModule = await loadOfflineSafe('../lib/wait.js');
  const agentModule = await loadOfflineSafe('../lib/agent.js');
  const descriptionsModule = await loadOfflineSafe('../lib/descriptions.js');
  if (
    jobsModule === undefined || waitModule === undefined
    || agentModule === undefined || descriptionsModule === undefined
  ) {
    tc.skip(HOST_SKIP_REASON);
    return;
  }
  const { resolveConfig } = await import('../lib/config.js');
  const { createRunTool } = jobsModule;
  const { createWaitTool } = waitModule;
  const { createAgentTool } = agentModule;
  const { t } = await import('../lib/text.js');
  const { buildToolText } = descriptionsModule;

  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const ctx = { shell: { sandboxMode: 'workspace-write' } };
  const factories = {
    async_run: createRunTool,
    async_wait: createWaitTool,
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

  // ③ 显示层分档：非整数档优先于越界档，文案键 invalidInteger——原因句现由
  //    invalidLabelOf 单点产出（字段行与保存区清单共用，逐字一致）。
  const code = clientCode();
  assert.match(code, /if \(notInteger\) return t\("invalidInteger"\);/,
    '非整数草稿必须给出 invalidInteger 档的原因文案（invalidLabelOf 内）');
  assert.match(code, /INTEGER_FIELDS = \{ maxResultChars: true \}/, '整数字段表只登记 maxResultChars');

  // ④ 词典两档都带 invalidInteger 键（zh/en 键集一致由本文件 T21 的键集相等
  //    断言守，这里守内容）。
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
  // 字段键），而 FieldShell 全部消费点（非法原因行渲染、aria-invalid、
  // described 顺序）都是
  // 严格 `=== true` 门——旧形 `=== true || pairHit` 会把字符串原样传下去，违例
  // 时红框与原因文案全灭、只剩保存按钮变灰（需求 §5.4 字段原因不可达的失效形态）。
  assert.match(code, /invalid: fieldState\.invalid === true \|\| pairHit !== null/,
    'pollIntervalMs 字节必须叠加 pairHit 显示，且归一为布尔（字符串 pairHit 过不了 FieldShell 的严格 === true 门）');
  assert.match(code, /t\("invalidRange"\)/, '越上界要有带 {最大值} 的原因文案');
  // 配对违例文案按字段键动态拼（五对链式共用一条分档路径），两侧字段显示名经
  // 词典键插值（5.7.4 跨字段行：「{较小字段}」不能大于「{较大字段}」——键名
  // 不进界面；较大侧＝参照字段 pairHit 的标签键）。
  assert.match(code, /t\("invalidPair\." \+ field\.key\)/,
    '配对违例要有专用文案（按字段键拼 invalidPair.键）');
  assert.match(code, /\.replace\("\{较小字段\}", t\(field\.key\)\)\s*\n\s*\.replace\("\{较大字段\}", t\(pairHit\)\)/,
    '配对违例两侧插值＝当前字段名与参照字段名（invalidLabelOf 单点产出，字段行与保存区清单共用）');

  // 词典两语言键集成对（词典纪律：zh/en 键集一致由本文件 T21 的键集相等断言
  // 守，这里守新增键的内容）。
  assert.ok(product.DICTIONARIES.zh['invalidPair.pollIntervalMs'].length > 0, 'zh 配对文案在场');
  assert.ok(product.DICTIONARIES.en['invalidPair.pollIntervalMs'].length > 0, 'en 配对文案在场');
  assert.match(product.DICTIONARIES.zh.invalidRange, /\{最大值\}/, 'zh invalidRange 必须带 {最大值} 插位');
  assert.match(product.DICTIONARIES.en.invalidRange, /\{最大值\}/, 'en invalidRange 必须带 {最大值} 插位');
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

test('T23e（R29-d·判据 14·设计 §5.4／UI-CLEAR-03）：链式候选三档——有效草稿优先、清覆盖按 userHas 位取 base 回退值（base 不可得＝候选未知）、无改动走生效值；判定不经字段级 overridden 预演位（官方完整投影修前红：清 min 并调低 default 的合法保存被旧生效快照误拦）', async () => {
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const reactStub = { createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
  const double = makePrimitivesDouble(reactStub);
  let loaded;
  new Function('window', readFileSync(resolve(ROOT, 'client.js'), 'utf8'))({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactStub : double));

  const state = (fields, effective, userHas, base) => ({ fields, effective, userHas, base });
  // ① 有效草稿 → 草稿值：只判一侧草稿会把「把上限改小」漏成可保存——两侧任意
  //    组合都以草稿为准（覆盖与否不影响草稿优先）。
  assert.equal(product.chainNumber(
    state({ defaultWaitMs: { text: '40000' } }, { defaultWaitMs: 30000 }), 'defaultWaitMs'),
    40000, '草稿在场 ⇒ 候选＝草稿值');
  assert.equal(product.chainNumber(
    state({ defaultWaitMs: { text: ' 40000 ' } }, { defaultWaitMs: 30000 }), 'defaultWaitMs'),
    40000, '草稿首尾空白照常解析');
  // ② 无草稿条目 / 空草稿且原始用户层无键 → 生效值（无改动；userHas 缺席的
  //    旧形态投影同样走此档）。
  assert.equal(product.chainNumber(state({}, { defaultWaitMs: 30000 }), 'defaultWaitMs'),
    30000, '无草稿条目 ⇒ 候选＝生效值');
  assert.equal(product.chainNumber(
    state({ defaultWaitMs: { text: '   ' } }, { defaultWaitMs: 30000 }), 'defaultWaitMs'),
    30000, '空草稿且无覆盖 ⇒ 候选＝生效值');
  // ③ 清覆盖形态（userHas 位＝原始用户层键存在性）→ 候选＝base 层回退值
  //    （清字段后按 5.1 优先级重取的组合层＝恢复默认将写入的真实值）。不经
  //    字段级 overridden 标志：暂存清除后该预演位翻转 false，而用户键仍在场。
  assert.equal(product.chainNumber(
    state({ defaultWaitMs: { text: '', overridden: false } }, { defaultWaitMs: 900000 },
      { defaultWaitMs: true }, { defaultWaitMs: 30000 }), 'defaultWaitMs'),
    30000, 'userHas ∧ base 在场 ⇒ 候选＝base 回退值（不拿旧生效快照 900000 比较）');
  assert.equal(product.chainNumber(
    state({ maxWaitMs: { text: '', overridden: false } }, { maxWaitMs: 900000 },
      { maxWaitMs: true }, {}), 'maxWaitMs') === product.CHAIN_UNKNOWN, true,
    'userHas ∧ base 不可得 ⇒ 候选不可知哨兵（交服务端终判）');
  // ④ 非法草稿 → null（单字段档缺席：非法性由单字段校验报出，链式不叠加）。
  assert.equal(product.chainNumber(state({ defaultWaitMs: { text: 'abc' } }, {}), 'defaultWaitMs'),
    null, '非法草稿 ⇒ 链式候选缺席');
  assert.equal(product.chainComparable(null), false, 'null 不参与链式比较');
  assert.equal(product.chainComparable(product.CHAIN_UNKNOWN), false, 'UNKNOWN 不参与链式比较');
  // ⑤ UNKNOWN 侧跳过比较：保存不因此禁用（服务端终判）——两侧各验一次。
  assert.equal(product.pairViolated(state(
    { defaultWaitMs: { text: '' }, maxWaitMs: { text: '1' } },
    { defaultWaitMs: 900000, maxWaitMs: 600000 },
    { defaultWaitMs: true }, {})), false,
    '左值 UNKNOWN（userHas ∧ base 缺席）⇒ 跳过该链（不折算成违例）');
  assert.equal(product.pairViolated(state(
    { defaultWaitMs: { text: '9999999' }, maxWaitMs: { text: '' } },
    { defaultWaitMs: 30000, maxWaitMs: 600000 },
    { maxWaitMs: true }, {})), false,
    '右值 UNKNOWN ⇒ 跳过该链（候选不可知不折算成违例）');
  assert.equal(product.chainHitOf(state(
    { defaultWaitMs: { text: '' }, maxWaitMs: { text: '1' } },
    { defaultWaitMs: 900000 }, { defaultWaitMs: true }, {}), 'defaultWaitMs'), null,
    'UNKNOWN 侧不挂链式原因文案（单字段层无跨字段结论可给）');
  // ⑥ 有效比较照常：纯生效值对（两侧无改动）与双侧草稿对（改小上限的形态）。
  assert.equal(product.pairViolated(state({}, { defaultWaitMs: 700000, maxWaitMs: 600000 })), true,
    '纯生效值对违例照常判出（快照本身越界的可见性不因三档丢失）');
  assert.equal(product.pairViolated(state(
    { defaultWaitMs: { text: '500000' }, maxWaitMs: { text: '400000' } }, {})), true,
    '双侧草稿改到越界 ⇒ 违例（只判一侧草稿会漏「把上限改小」形态）');
  // ⑦ 官方完整投影下的清覆盖场景（UI-CLEAR-03 修前红，忠实适配器装置）：
  //    旧覆盖 minWaitMs=50000／defaultWaitMs=60000（user 层在场），本次保存
  //    清空 minWaitMs 草稿（edit 空串：plan 走 unset → 字段级 overridden 预演
  //    位翻转 false）并把 defaultWaitMs 调至 30000。恢复默认写入的真实值是
  //    base 层组合层（min 250）——合法组合。修前据 overridden 预演位判
  //    「无覆盖」、拿旧生效快照 50000 与草稿 30000 比较 ⇒ 误判违例、误禁合法
  //    保存（红）；修正后按 userHas 位取 base 回退值 250 比较 ⇒ 无违例。
  const scope = {
    getSnapshot: () => ({
      status: 'ready', writable: true, revision: 7,
      value: { minWaitMs: 50000, defaultWaitMs: 60000 },
      user: { minWaitMs: 50000, defaultWaitMs: 60000 },
      base: { minWaitMs: 250, defaultWaitMs: 30000 }
    }),
    subscribe: () => () => {},
    mutate: async () => true
  };
  // 装置：全部字段的 spec 经卡片层 boundedNumberSpec 造（投影只消费
  // format/parse 通道，非数值字段不被断言、仅要求 spec 在场）。
  const allSpecs = product.FIELDS.map((one) => product.boundedNumberSpec(one.key));
  const model = new double.SettingsFormModel(scope, allSpecs);
  const actions = model.actions();
  // 清除手势＝清空草稿（edit 空串）：text 为空、plan 走 unset。不用 resetField
  // ——它把草稿回填成 base 格式化值「250」，旧实现对回填形态同样走有效草稿
  // 优先、修前并不误拦（旧 pair=false），锚钉不住缺陷；空草稿＋预演位翻转
  // false 才是误拦形态（旧实现落回生效快照比较）。
  actions.edit('minWaitMs', '');
  actions.edit('defaultWaitMs', '30000');
  const fieldMin = model.field('minWaitMs');
  assert.equal(fieldMin.text, '', '前置：清除形态＝空草稿（空 text，plan 走 unset）');
  assert.equal(fieldMin.overridden, false,
    '前置：官方模型预演位已翻转（暂存清除 ⇒ overridden=false——据它判「无覆盖」即缺陷形态）');
  const projected = product.projectCardState(model, scope);
  assert.equal(projected.userHas.minWaitMs, true,
    '投影按原始用户层键存在性判覆盖（保存落定前 unset 未发生，键仍在场）');
  assert.equal(projected.base.minWaitMs, 250, 'base 回退值随投影在场');
  assert.equal(product.pairViolated(projected), false,
    '清 min（回退 250）∧ 调低 default（30000）的合法保存不被误拦（修前：空草稿落回生效 50000 与草稿 30000 比较 ⇒ 违例＝红）');
  assert.equal(product.chainHitOf(projected, 'minWaitMs'), null,
    '该链不挂左值原因文案（minWaitMs ≤ defaultWaitMs 成立）');
  assert.equal(model.shell().invalid, false,
    '表单计划全为合法 op（unset min＋set default）⇒ 保存不被单字段层误禁（链式误拦排除后无禁用来源）');
  // 同装置对照组：不清覆盖、只把 default 调到低于现行 min 时仍照常判出。
  const model2 = new double.SettingsFormModel(scope, allSpecs);
  model2.actions().edit('defaultWaitMs', '40000');
  assert.equal(product.pairViolated(product.projectCardState(model2, scope)), true,
    '未清覆盖时拿生效 min 50000 比较 ⇒ 50000 > 40000 违例照常（不因修正放松）');
});

// ── 预设目录模型（§10.1 CAT 系列）：通知触发的重读合并、stale 回执零写入、
// attach 首读不被旧在途挡。目录只读写自身快照——设置草稿存于表单模型，重读/
// 失败/重试期间原样保留（草稿锚在 T23 系列，本系列锚目录自身的不变量）。──

test('T-CAT-1（CAT-REREAD）：loading 期间到达的读取请求不并发另起——在途回执落定后自动补恰一次重读', async () => {
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const reactStub = { createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
  const double = makePrimitivesDouble(reactStub);
  let loaded;
  new Function('window', readFileSync(resolve(ROOT, 'client.js'), 'utf8'))({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactStub : double));

  const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });
  const catalog = product.createPresetCatalog();
  const gate = [];
  catalog.attach({ list: () => new Promise((resolve) => { gate.push(resolve); }) });
  assert.equal(catalog.store.getSnapshot().status, 'loading', 'attach 即首读（loading）');
  await flush(); // list 在微任务里被调（快照先入 loading，服务调用随后）
  assert.equal(gate.length, 1, '前置：首读恰一次 list 在途');
  // 在途期间通知触发两次 load：不并发另起（list 恰一次），只置待重读标记。
  catalog.load();
  catalog.load();
  assert.equal(gate.length, 1, '在途期间的读取请求不另起第二次 list（防重入）');
  // 首回执落定：ready 先行落写，随后**恰一次**补读自动发起（loading 再现）。
  gate[0]({ ok: true, value: { presets: [{ id: 'p-first' }] } });
  await flush();
  assert.equal(gate.length, 2, '在途回执落定后恰补一次重读（两次 load 合并不双读）');
  assert.equal(catalog.store.getSnapshot().status, 'loading', '补读在途（loading 再现，条目区等待新回执）');
  // 补读回执落定 → ready；此后无新请求 ⇒ 无更多读取（无自旋）。
  gate[1]({ ok: true, value: { presets: [{ id: 'p-second' }] } });
  await flush();
  await flush();
  const settled = catalog.store.getSnapshot();
  assert.equal(settled.status, 'ready', '补读落定 → ready');
  assert.deepEqual(settled.items, [{ id: 'p-second' }], '条目＝最新回执（非首回执残影）');
  assert.equal(gate.length, 2, '无新请求时不自旋重读');
});

test('T-CAT-2（CAT-STALE）：stale 回执零写入——attach 换代理/detach 撤代理后，旧代理上的在途回执不落写（items/error/status 一概不动）', async () => {
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const reactStub = { createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
  const double = makePrimitivesDouble(reactStub);
  let loaded;
  new Function('window', readFileSync(resolve(ROOT, 'client.js'), 'utf8'))({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactStub : double));

  const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });
  const catalog = product.createPresetCatalog();
  // 旧代理在途（回执将迟到）：attach 换代理 ⇒ 代际推进＋即时首读。
  let staleResolve;
  catalog.attach({ list: () => new Promise((resolve) => { staleResolve = resolve; }) });
  await flush(); // 旧代理的 list 进入在途
  catalog.attach({ list: () => Promise.resolve({ ok: true, value: { presets: [{ id: 'fresh' }] } }) });
  assert.equal(catalog.store.getSnapshot().status, 'loading', 'attach 首读即时发起（不被旧在途的 loading 挡）');
  await flush();
  const before = catalog.store.getSnapshot();
  assert.equal(before.status, 'ready', '新代理首读落定 → ready');
  // 旧代理回执迟到（携带旧代际）：零写入——不得把旧代理结果冒充新代理结果。
  staleResolve({ ok: true, value: { presets: [{ id: 'stale-gen' }] } });
  await flush();
  assert.deepStrictEqual(catalog.store.getSnapshot(), before,
    '旧代际回执零写入：items/status/error 一概不动（成功回执不冒充新代理结果）');
  // detach 撤代理：代际再进——被撤代理上的在途回执零写入（items 不落 ghost）；
  // detach 即刻把 loading 折进可重试错误态、不悬挂（UI-CATALOG-02-A；同步
  // 即刻的判据由 T-CAT-5 钉，修前仅推进世代、loading 悬挂）。
  let detachedResolve;
  catalog.attach({ list: () => new Promise((resolve) => { detachedResolve = resolve; }) });
  await flush(); // 让该读真正进入在途（list 已调）
  catalog.detach();
  detachedResolve({ ok: true, value: { presets: [{ id: 'ghost' }] } });
  await flush();
  const closed = catalog.store.getSnapshot();
  assert.equal(closed.status, 'error',
    '被撤代理的回执零写入（不伪落定为 ready），落定后收尾为可重试错误态——loading 不悬挂');
  assert.equal(closed.unavailable, true, '收尾态带 unavailable 标记（绑定块服务缺席同口径）');
  assert.deepEqual(closed.items, [], '旧回执零写入（items 一概不动，ghost 不落条目）');
});

test('T-CAT-3（CAT-ATTACH）：服务缺席走可重试 error 态；attach 即首读、attach 自身满足在途期间的待重读意图（不双读）', async () => {
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const reactStub = { createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
  const double = makePrimitivesDouble(reactStub);
  let loaded;
  new Function('window', readFileSync(resolve(ROOT, 'client.js'), 'utf8'))({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactStub : double));

  const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });
  const catalog = product.createPresetCatalog();
  assert.equal(catalog.store.getSnapshot().status, 'idle', '初始态 idle（非 loading——loading 会被防重入守卫吞掉 attach 首读）');
  // 服务未注入的读取尝试：可重试的服务缺席 error 态（不是空目录、不是静默）。
  catalog.load();
  const absent = catalog.store.getSnapshot();
  assert.equal(absent.status, 'error', '服务缺席 ⇒ error 态');
  assert.equal(absent.unavailable, true, '服务缺席带 unavailable 标记（可重试文案由渲染层给）');
  assert.deepEqual(absent.items, [], '缺席态条目为空（不冒充空目录成功态）');
  // 注入即首读：error 态不被守卫挡（守卫只挡 loading），重试路径成立。
  const gate = [];
  catalog.attach({ list: () => new Promise((resolve) => { gate.push(resolve); }) });
  assert.equal(catalog.store.getSnapshot().status, 'loading', 'attach 即时首读（error 态可重试）');
  await flush(); // list 在微任务里被调
  // 在途期间 load 置待重读标记；再次 attach（fiber 重挂形态）自身就是新读——
  // 标记随 attach 作废（意图已满足），落定后不双读。
  catalog.load();
  const gate2 = [];
  catalog.attach({ list: () => new Promise((resolve) => { gate2.push(resolve); }) });
  await flush(); // 新代理的 list 进入在途（旧代理的在途回执此后到达即 stale）
  gate[0]({ ok: true, value: { presets: [{ id: 'old-agent' }] } });
  await flush();
  assert.equal(catalog.store.getSnapshot().status, 'loading', '旧代理回执零写入（新读的 loading 不被打断）');
  assert.equal(gate2.length, 1, 'attach 后新代理恰一次 list');
  assert.equal(gate.length, 1, '旧代理无第二次 list（attach 满足待重读意图，不双读）');
  gate2[0]({ ok: true, value: { presets: [{ id: 'new-agent' }] } });
  await flush();
  const settled = catalog.store.getSnapshot();
  assert.equal(settled.status, 'ready', '新代理回执落定 → ready');
  assert.deepEqual(settled.items.map((one) => one.id), ['new-agent'], '条目＝新代理结果');
});

test('T-CAT-4（CAT-DETACH-CLOSE／UI-CATALOG-02-A）：在途 detach 的状态收尾——detach 即刻把 loading 折进可重试错误态、旧代际在途回执零写入；手动刷新服务缺席立即交回错误态、不排补读（待补读标记＝服务在场时的重读意图）；新服务到场 attach 首读照常（修前红：仅推进世代、loading 悬挂、刷新只排补读）', async () => {
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const reactStub = { createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
  const double = makePrimitivesDouble(reactStub);
  let loaded;
  new Function('window', readFileSync(resolve(ROOT, 'client.js'), 'utf8'))({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactStub : double));

  const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });
  const catalog = product.createPresetCatalog();
  const gate = [];
  catalog.attach({ list: () => new Promise((resolve) => { gate.push(resolve); }) });
  await flush();
  assert.equal(catalog.store.getSnapshot().status, 'loading', '前置：读取在途');
  assert.equal(gate.length, 1, '前置：恰一次 list 在途');
  // 在途期间一次通知触发的 load（置待重读标记）——detach 后该意图随服务
  // 撤下作废，不把补读排到无服务的将来。
  catalog.load();
  // 服务撤下且无替代（卸载／行停服务／断线不重连的注入清理形态）：已知
  // 撤下事实立即收尾（T-CAT-5 同判据）——loading 同步折进可重试错误态。
  catalog.detach();
  assert.equal(catalog.store.getSnapshot().status, 'error',
    'detach 即刻收尾为可重试错误态（修前仅推进世代、loading 悬挂＝红）');
  assert.equal(catalog.store.getSnapshot().unavailable, true, '与绑定块服务缺席 error 态同口径（unavailable 标记）');
  // 在途回执落定（携带旧代际）：零写入——不伪落定 ready、不回滚已收尾的
  // 错误态（收尾发生在 detach 时点，回执迟到只经代际失配自弃）。
  gate[0]({ ok: true, value: { presets: [{ id: 'ghost' }] } });
  await flush();
  const closed = catalog.store.getSnapshot();
  assert.equal(closed.status, 'error', '旧代际回执零写入（不覆盖已收尾的错误态）');
  assert.deepEqual(closed.items, [], '收尾不落旧回执条目（ghost 不入 items）');
  assert.equal(gate.length, 1, '收尾不发新读取（旧服务已撤，无 list 可调）');
  // 手动刷新（服务仍缺席）：立即交回错误态——不排补读（修前：loading 期间
  // 只置待重读标记、永无落定消费＝红）。
  catalog.load();
  const refreshed = catalog.store.getSnapshot();
  assert.equal(refreshed.status, 'error', '手动刷新服务缺席 ⇒ 立即错误态（不悬挂、不排队）');
  assert.equal(refreshed.unavailable, true, '刷新后的错误态同样可重试');
  assert.equal(gate.length, 1, '刷新不产生任何 list 调用（不把补读排到无服务的将来）');
  // 新服务到场：attach 首读照常——收尾态可重试、后续生命周期不受损伤。
  const gate2 = [];
  catalog.attach({ list: () => new Promise((resolve) => { gate2.push(resolve); }) });
  assert.equal(catalog.store.getSnapshot().status, 'loading', 'attach 即首读（error 态可重试）');
  await flush();
  assert.equal(gate2.length, 1, '新服务恰一次 list');
  gate2[0]({ ok: true, value: { presets: [{ id: 'back' }] } });
  await flush();
  const settled = catalog.store.getSnapshot();
  assert.equal(settled.status, 'ready', '新服务回执照常落定');
  assert.deepEqual(settled.items.map((one) => one.id), ['back'], '条目＝新服务结果');
  // 目录只读写自身快照（收尾/刷新不触表单模型）：结构上 store 不持模型引用，
  // 草稿不受影响由 T23 系列守，此处不重复装置。
});

test('T-CAT-5（CAT-DETACH-NOW）：detach 即刻收尾——撤下事实已知时同步折进可重试错误态，不等在途回执、不悬挂（修前红：loading 悬挂到回执落定，回执永不来＝永久 loading）', async () => {
  const { makePrimitivesDouble } = await import('./_primitives-double.mjs');
  const reactStub = { createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
  const double = makePrimitivesDouble(reactStub);
  let loaded;
  new Function('window', readFileSync(resolve(ROOT, 'client.js'), 'utf8'))({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const product = loaded.factory((name) => (name === 'react' ? reactStub : double));

  const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });
  const catalog = product.createPresetCatalog();
  const gate = [];
  catalog.attach({ list: () => new Promise((resolve) => { gate.push(resolve); }) });
  await flush();
  assert.equal(catalog.store.getSnapshot().status, 'loading', '前置：读取在途');
  // 撤下事实已知：detach 返回后**不 flush、不解回执**直接取快照——收尾必须
  // 已同步发生（等待在途回执落定的收尾没有可等的证据，回执永不来时 loading
  // 永久悬挂；修前红＝此处仍 loading）。
  catalog.detach();
  const closed = catalog.store.getSnapshot();
  assert.equal(closed.status, 'error', 'detach 返回时快照已收尾（同步收尾，不等在途回执）');
  assert.equal(closed.unavailable, true, '可重试错误态带 unavailable 标记（绑定块服务缺席同口径）');
  assert.deepEqual(closed.items, [], '条目为空（不冒充 ready）');
  assert.equal(gate.length, 1, '收尾不发新读取（旧服务已撤，无 list 可调）');
  // 在途回执永不来也不悬挂；迟到的旧代际回执零写入（不覆盖已收尾的错误态）。
  gate[0]({ ok: true, value: { presets: [{ id: 'ghost' }] } });
  await flush();
  const after = catalog.store.getSnapshot();
  assert.equal(after.status, 'error', '迟到回执零写入（错误态不被旧回执覆盖）');
  assert.deepEqual(after.items, [], 'ghost 不入 items');
});

test('T8b（R29-a·判据 15 附）：settings 的悬空动态 import 必须 .catch——快照已落，广播失败不得杀实例', () => {
  const code = stripComments(read('lib/settings.js'));
  assert.match(code, /import\('\.\/refresh-bus\.js'\)[\s\S]{0,160}\.catch\(/,
    'refresh-bus 动态 import 链上必须有 .catch（这条 promise 只可能 reject，无人接住 = 整实例退出）');
});

// ═════════════════════════════════════════════════════════════════════
// W-MIGRATE（MIGRATE-01）：0.2.5 平铺行 config 的迁移警告。
//
// 机制事实（丢失点归因与对照示例见 `CHANGELOG.md`「从 0.2.5 形态的行配置迁移」
// 节——公开仓档案，随版本保留；装载警告实现见 `lib/index.js` applyWith）：
// 平铺键经 schemastery object resolve 的 merge 透传与 cordis internal/config
// waterfall 原样到达 apply；本包 normalizeConfigInput 的 `settings` 缺省 `{}`
// 短路使预置值回落默认——静默。装载警告是**尽力提示非保证**（宿主改 strict
// 丢弃时入口 config 通道消失，警告缺席不证明正形）。
//
// 装置：真 cordis Context + 假九服务（index.test.mjs 的 makeContext 形态），
// 经真 `apply` 通道装载工具行；console.warn 收集警告（警告恰一行、键名在场）。
// 三个用例的平铺形态互不重叠（模块级去重 Set 是进程级单例，形态撞车会互相
// 吞警告）。
// ═════════════════════════════════════════════════════════════════════

/** cordis 的 `FiberState.ACTIVE`（`@deepseek-ai/cordis` 4.0.4，const enum，ACTIVE = 2）。 */
const ACTIVE = 2;

/**
 * 最小装载装置：真 Context、假九服务、真 `apply`（ctx.plugin → fiber 激活）。
 * 返回注册表探针与警告收集器（用完调 `restore()` 复原 console.warn）。
 */
async function makeApplyRig(t, rawConfig) {
  const hostIndex = await loadOfflineSafe('../lib/index.js');
  const cordis = await loadOfflineSafe('@deepseek-ai/cordis');
  if (hostIndex === undefined || cordis === undefined) {
    t.skip(HOST_SKIP_REASON);
    return undefined;
  }
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  const registered = [];
  const ctx = new cordis.Context();
  ctx.provide('tools', {
    register(definition) {
      registered.push(definition);
      return () => {
        const index = registered.indexOf(definition);
        if (index >= 0) registered.splice(index, 1);
      };
    }
  });
  ctx.provide('jobs', { start: () => 'async-command-1', get: () => ({ status: 'running' }), read: () => ({ text: '' }), wait: async () => ({ status: 'running' }), kill: () => 'requested' });
  ctx.provide('shell', { resolve: (request) => request, start: () => { throw new Error('迁移测试不该启动进程'); } });
  ctx.provide('shellEnv', { collect: () => Object.freeze({ DSH_HOME: 'x' }) });
  ctx.provide('subagents', { listChildren: async () => [], interrupt: () => {}, getProvider: () => undefined });
  ctx.provide('timer', { timeout: () => () => {}, interval: () => () => {} });
  ctx.provide('sessionProjections', { stateOf: () => null });
  ctx.provide('agents', { get: () => undefined });
  ctx.provide('workingDirectory', { ensure: async () => 'D:\\work' });
  const fork = ctx.plugin(
    { name: hostIndex.name, inject: hostIndex.inject, Config: hostIndex.Config, apply: hostIndex.apply },
    rawConfig
  );
  for (let turn = 0; turn < 64 && fork.state !== ACTIVE; turn += 1) await Promise.resolve();
  assert.equal(fork.state, ACTIVE, '插件 fiber 未在有限个微任务内激活（apply 没跑？）');
  return {
    registered,
    warnings,
    restore: async () => { console.warn = originalWarn; await fork.dispose(); }
  };
}

test('W-MIGRATE-A：0.2.5 平铺（toolName 行）→apply 触发一行 stderr 警告（键名在场）、行为不变', async (t) => {
  const rig = await makeApplyRig(t, { toolName: 'async_wait', agentLang: 'zh', defaultYieldMs: 30000 });
  if (rig === undefined) return;
  try {
    assert.deepEqual(rig.registered.map((definition) => definition.name), ['async_wait'],
      '行为不变：平铺行照常注册该工具（警告不抛错、不阻断装载）');
    const flat = rig.warnings.filter((line) => line.includes('flat settings keys'));
    assert.equal(flat.length, 1, '恰一行平铺迁移警告');
    assert.match(flat[0], /agentLang/, '警告列出误平铺键名（agentLang）');
    assert.match(flat[0], /defaultYieldMs/, '警告列出误平铺键名（defaultYieldMs）');
    assert.match(flat[0], /settings/, '警告指出正形（包进 settings 子树）');
  } finally {
    await rig.restore();
  }
});

test('W-MIGRATE-B：正形静默；嵌套＋根层混合→警告；未知根层键不误报', async (t) => {
  {
    const rig = await makeApplyRig(t, { toolName: 'async_wait', settings: { agentLang: 'zh' } });
    if (rig === undefined) return;
    try {
      assert.equal(rig.registered.length, 1, '正形照常注册');
      assert.equal(rig.warnings.filter((line) => line.includes('flat settings keys')).length, 0,
        '正形（设置在 settings 子树）零警告——误报会把所有正形用户推进迁移文档');
    } finally {
      await rig.restore();
    }
  }
  {
    // 嵌套＋根层混合：settings 在场不豁免根层平铺键（丢失点正是「settings 缺省
    // 短路＋根层残留」的组合形态）。
    const rig = await makeApplyRig(t, { toolName: 'async_wait', settings: { agentLang: 'zh' }, minWaitMs: 5000 });
    if (rig === undefined) return;
    try {
      const flat = rig.warnings.filter((line) => line.includes('flat settings keys'));
      assert.equal(flat.length, 1, '混合形态仍警告');
      assert.match(flat[0], /minWaitMs/, '警告列出根层残留键名');
    } finally {
      await rig.restore();
    }
  }
  {
    const rig = await makeApplyRig(t, { toolName: 'async_wait', someUnknownKey: 1 });
    if (rig === undefined) return;
    try {
      assert.equal(rig.warnings.filter((line) => line.includes('flat settings keys')).length, 0,
        '未知根层键不是设置字段名——不误报（判定源是 SETTING_FIELD_KEYS 交集，不是「任何根层键」）');
    } finally {
      await rig.restore();
    }
  }
});

test('W-MIGRATE-C：同形态重复装载→每进程至多一行（键序去重不刷屏）', async (t) => {
  const first = await makeApplyRig(t, { toolName: 'async_workflow', jobKind: 'x' });
  if (first === undefined) return;
  let totalFlat;
  try {
    assert.equal(first.warnings.filter((line) => line.includes('flat settings keys')).length, 1,
      '首次装载警告一行');
    totalFlat = first.warnings.filter((line) => line.includes('flat settings keys')).length;
  } finally {
    await first.restore();
  }
  const second = await makeApplyRig(t, { toolName: 'async_workflow', jobKind: 'x' });
  try {
    totalFlat += second.warnings.filter((line) => line.includes('flat settings keys')).length;
    assert.equal(totalFlat, 1, '同形态重复装载不再刷屏（「行身份＋有序键集」每进程去重一次）');
    assert.equal(second.registered.length, 1, '重复装载行为不变（注册照常）');
  } finally {
    await second.restore();
  }
});

test('W-MIGRATE-D：宿主行平铺（无 toolName 的 0.2.5 生产 patch 形态）→同样触发一行警告（盲测 F1 回归）', async (t) => {
  // 0.2.5 生产 patch 把平铺设置键写在宿主行（无 toolName）——CHANGELOG 迁移节的
  // 对照示例正是该形态。警告若只检工具行，照抄示例的部署升级后静默回落、零提示
  //（隔离实例盲测 F1 实跑复现）；本测锁死宿主行分支的检测。
  const rig = await makeApplyRig(t, { agentLang: 'zh' });
  if (rig === undefined) return;
  try {
    const flat = rig.warnings.filter((line) => line.includes('flat settings keys'));
    assert.equal(flat.length, 1, '宿主行平铺恰一行迁移警告（漏检形态＝0 警告，必红）');
    assert.match(flat[0], /agentLang/, '警告列出误平铺键名（agentLang）');
    assert.match(flat[0], /settings/, '警告指出正形（包进 settings 子树）');
  } finally {
    await rig.restore();
  }
});
