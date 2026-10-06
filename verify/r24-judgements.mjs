/**
 * R24 界面判据的**纯函数**部分（判据本体与取数分离，便于用变异证明它们能红）。
 *
 * 三处取数在真机上完成、且都不用后端 API 返回：
 * - 注入表与下发字节：`verify/acceptance-017.mjs r24-ui`（首页 HTML 的 preload combo 行 + 该行取回的字节）；
 * - 页面 DOM 与保存往返：`verify/_visual/probe-r24-bundle-config.mjs`（无头 Edge 走真实页面）；
 * - 源码/注册接线：本文件直接读 `client.js`（`judgeSlotWiring`）与跑一遍 `apply()`（`runRegistration`）。
 *
 * 这里只放"给定读数 → 判据成立与否"的函数，没有任何 IO。
 */

/**
 * 去掉注释后的源码：判据只认**语句**里的字样。
 *
 * 为什么必须剥：`client.js` 的头部注释里写着槽位名、`whileServed([ENTRY])` 与
 * `ctx.configForms.get(ENTRY)`，不剥注释的话"把代码改回读 `props.form`"这类变异
 * 仍然命中注释、判据照样绿——这就是"把注释里的文字当成命中"的假绿。
 *
 * @param {string} text - 源码文本。
 * @returns {string} 剥掉 `//` 行注释与块注释的文本。
 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/**
 * 注入表 + 下发字节（R24 的第一段）。
 *
 * 判据是**落点**：bundle 页槽必须在、卡片工厂必须在，组件行槽与官方槽名必须不在——
 * 前者证明投递到浏览器的就是我们改过的那份，后者证明没有偷偷退回嵌套落点。
 *
 * @param {number} status - combo 行的 HTTP 状态码。
 * @param {string} text - 该行取回的下发字节。
 * @returns {{ ok: boolean, detail: string }} 判据结论与读数。
 */
export function judgeDeliveredBytes(status, text) {
  const code = stripComments(text);
  const hasCard = code.includes('AsyncToolsBundleCard');
  const hasBundleSlot = code.includes('plugins.bundle.config');
  const hasRowSlot = code.includes('plugins.row.config');
  const hasRetiredSlot = code.includes('"plugins.item"');
  const ok = status === 200 && hasCard && hasBundleSlot && !hasRowSlot && !hasRetiredSlot;
  return {
    ok,
    detail: `状态=${String(status)} 长度=${String(text.length)} 卡片=${String(hasCard)} `
      + `bundle槽=${String(hasBundleSlot)} 行槽=${String(hasRowSlot)} 旧槽名=${String(hasRetiredSlot)}`
  };
}

/**
 * 卡片接线的**源码面**判据（R24 / F97 / F101 / R27）。
 *
 * 六条各自都能单独失败：槽位名、键=包名、没有退回行槽、没有挂官方槽、whileServed 守卫、
 * 表单自取控制器并订阅。两处刻意写法：① 键的判据写成 `key: PACKAGE_NAME,`（带逗号）——
 * `.includes('key: PACKAGE_NAME')` 会被 `key: PACKAGE_NAME + "#" + ENTRY`（旧的嵌套落点）命中，
 * 那是恒真断言；② 全部在**剥掉注释**的文本上匹配（见 `stripComments`）。
 *
 * R27 起订阅面换锚：控制器交给官方 `SettingsFormModel`（模型构造时订阅 scope），组件用
 * `useSyncExternalStore` 订阅模型的快照店——旧锚（卡片手写 `controller.subscribe` effect）
 * 随自绘表单退场。
 *
 * @param {string} text - `client.js` 的源码文本。
 * @returns {{ ok: boolean, detail: string }} 判据结论与读数。
 */
export function judgeSlotWiring(text) {
  const code = stripComments(text);
  const bundleSlot = code.includes('name: "plugins.bundle.config"');
  const bundleKey = /key:\s*PACKAGE_NAME\s*,/.test(code);
  const noRowSlot = !code.includes('plugins.row.config');
  const noItemSlot = !code.includes('"plugins.item"');
  const guarded = code.includes('whileServed([ENTRY]');
  // 自取判据锚**卡片模型的三行配对**而不是全文字符串：`ctx.configForms.get(ENTRY)`
  // 在 client.js 里有两处（createCardModel 的卡片路径 + createAskModel 的 ask 路径，
  // R30 加入）——按 includes 找 anywhere 会被 ask 路径的同类行喂绿（mutate-config-slot
  // M6 的既有逃逸，2026-10-02 R38 ⑥ 轮坐实）。
  const selfServed = /function createCardModel\(ctx\) \{\s*var scope = ctx\.configForms\.get\(ENTRY\);\s*var model = new P\.SettingsFormModel\(scope, makeSpecs\(\)\);/.test(code)
    && code.includes('useSyncExternalStore(card.store.subscribe, card.store.getSnapshot)');
  const ok = bundleSlot && bundleKey && noRowSlot && noItemSlot && guarded && selfServed;
  return {
    ok,
    detail: `bundle槽=${String(bundleSlot)} 键=包名=${String(bundleKey)} 无行槽=${String(noRowSlot)} `
      + `无官方槽=${String(noItemSlot)} 守卫=${String(guarded)} 自取+模型+订阅=${String(selfServed)}`
  };
}

/**
 * 注册的**运行期**判据：真跑一遍 `apply()`，抓注册那一刻的 options（R24）。
 *
 * 源码面判据说不出"键真的等于包名"——键由常量拼出，只有跑一遍才知道。这里用最小假件：
 * `apply()` 只碰 `locale.register` / `configForms.whileServed` / `slots.inject|register` / `effect`，
 * 卡片组件本身不渲染，所以 React 替身只要三个空壳即可。
 *
 * @param {string} text - `client.js` 的源码文本。
 * @returns {{ ok: boolean, count: number, name: string, key: string, locale: string, detail: string }}
 *   判据结论与注册读数（`count` 不是 1 时其余字段取首次注册）。
 */
export function runRegistration(text) {
  let loaded;
  new Function('window', text)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const reactStub = { createElement: () => undefined, useState: () => [undefined, () => {}], useEffect: () => {} };
  const product = loaded.factory(() => reactStub);
  const registered = [];
  product.apply({
    locale: { register: () => () => {} },
    configForms: { whileServed: (ids, load) => load() },
    slots: { inject: (slotName, load) => load(), register: (options) => { registered.push(options); } },
    // R30 起 client.js 的 apply 还会自 mount remote 命名空间（ask 接管半边）：
    // $mount 返回 thenable、回调全走微任务。此前的假件没有 remote，apply 在
    // `ctx.remote.$mount` 一行炸 TypeError，整条 probe（基线+七个变异）红在脚手架
    // 而不是判据（2026-10-02 R38 ⑥ 轮发现于冻结 v0.1.7 实体同款复现，属 R30 起的
    // 既有断链，此处补齐）。$mount 返回**永不 resolve** 的 promise——座位/模型装配
    // 都在 then 回调里，探针只关心同步注册面，让 ask 半边整体惰性化。
    remote: { $mount: () => new Promise(function () {}) },
    effect: (fn) => fn()
  });
  const first = registered[0] ?? {};
  const ok = registered.length === 1
    && first.name === 'plugins.bundle.config'
    && first.key === product.PACKAGE_NAME;
  return {
    ok,
    count: registered.length,
    name: String(first.name ?? ''),
    key: String(first.key ?? ''),
    locale: String(first.locale ?? ''),
    detail: `注册数=${String(registered.length)} 槽=${String(first.name ?? '')} 键=${String(first.key ?? '')}`
      + ` 词典=${String(first.locale ?? '')} 包名常量=${String(product.PACKAGE_NAME)}`
  };
}

/**
 * 设置面**放置**判据（R24）：设置区必须长在**插件页**上、在组件行之前——
 * 而不是要先进某个组件行的子页才看得见。
 *
 * @param {{ pageKind?: string, sectionPresent?: boolean, fieldCount?: number, rowsAfterSection?: boolean, rowConfigureControls?: number }} dom
 *   页面读数（探针从 DOM 读）。
 * @param {string[]} [expectedKeys] 代码侧的字段键（`lib/config.js` 的 `BUDGET_FIELD_KEYS`）。
 * @returns {{ ok: boolean, detail: string }} 判据结论与读数。
 */
export function judgePlacement(dom, expectedKeys) {
  const expected = Array.isArray(expectedKeys) ? expectedKeys.length : 0;
  const onBundlePage = dom.pageKind === 'bundle';
  const section = dom.sectionPresent === true;
  const fields = dom.fieldCount === expected && expected > 0;
  const rowsAfter = dom.rowsAfterSection === true;
  const noRowControl = dom.rowConfigureControls === 0;
  const ok = onBundlePage && section && fields && rowsAfter && noRowControl;
  return {
    ok,
    detail: `页面=${String(dom.pageKind ?? '')} 设置区=${String(dom.sectionPresent)} `
      + `字段=${String(dom.fieldCount)}/${String(expected)} 组件行在后=${String(dom.rowsAfterSection)} `
      + `行内 configure 控件=${String(dom.rowConfigureControls)}`
  };
}

/**
 * 设置区的 DOM 读数（R24 的第二段；R27 起控件身份按 `id` 读）。
 *
 * "逐项等价"按**身份**核对两件事，各自能单独失败：
 * ① 字段身份：每个控件的 `id`（= `plugin-config-` + 代码里的字段键）与 `expectedKeys`
 *    一一对应，且都可写；
 * ② 读数身份：说明行带秒数读数的字段集合必须**恰好**等于 `msKeys`——只数个数抓不到
 *    "读数挂错字段"（旧判据写 `readouts.length >= 7`，而非毫秒字段上多一个 `= N s` 照样绿，
 *    impl-review-r23 N3）。
 *
 * @param {{ count?: number, readouts?: string[], readoutFields?: string[], keys?: string[], writable?: boolean[], failed?: boolean }} form
 *   页面读数（`keys`/`writable`/`readoutFields` 由探针从 DOM 的 `id`/`disabled` 与说明行读出；
 *   `failed` = 页脚出现失败文案）。
 * @param {string[]} [expectedKeys] 代码侧的字段键（`lib/config.js` 的 `BUDGET_FIELD_KEYS`）。
 * @param {string[]} [msKeys] 代码侧的毫秒字段键（`lib/config.js` 的 `MS_FIELD_KEYS`）。
 * @returns {{ ok: boolean, detail: string }} 判据结论与读数。
 */
export function judgeConfigForm(form, expectedKeys, msKeys) {
  const keys = Array.isArray(form.keys) ? form.keys : [];
  const writable = Array.isArray(form.writable) ? form.writable : [];
  const expected = Array.isArray(expectedKeys) ? expectedKeys : [];
  const ms = Array.isArray(msKeys) ? msKeys : [];
  const readoutFields = Array.isArray(form.readoutFields) ? form.readoutFields : [];
  const missing = expected.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !expected.includes(k));
  const identity = expected.length > 0 && missing.length === 0 && extra.length === 0;
  // 读数必须自洽：控件个数、读到的键、可写标记三者数量一致。少一项（页面只渲染了 9 个框却报了
  // 10 个键之类的错读数）就不算通过——否则"身份对了"会掩盖"其实没渲染出来"。
  const consistent = form.count === keys.length && writable.length === keys.length;
  const allWritable = writable.length === expected.length && writable.every((w) => w === true);
  const readouts = Array.isArray(form.readouts) && form.readouts.length > 0
    && form.readouts.every((r) => (/[\d.]+ s$/).test(r) || /< 0\.01 s$/.test(r) || /—$/.test(r));
  const readoutIdentity = ms.length > 0 && readoutFields.length === ms.length
    && ms.every((k) => readoutFields.includes(k));
  const clean = form.failed !== true;
  const ok = consistent && identity && allWritable && readouts && readoutIdentity && clean;
  return {
    ok,
    detail: `字段数=${String(form.count)} 自洽=${String(consistent)} 身份命中=${String(identity)}`
      + (missing.length > 0 ? ` 缺=${missing.join(',')}` : '')
      + (extra.length > 0 ? ` 多=${extra.join(',')}` : '')
      + ` 可写=${String(writable.filter((w) => w === true).length)}/${String(expected.length)}`
      + ` 秒数读数=${String(readouts)} 读数身份=${String(readoutIdentity)}`
      + ` 读数字段=[${readoutFields.join(',')}] 期望=[${ms.join(',')}] 页脚失败文案=${String(form.failed === true)}`
  };
}

/**
 * 两段读数**各自跟着变**的判据（R24 / R21 / F101；R27 增补：按段比对）。
 *
 * 说明行是两段（裁决 D）：生效段随保存换新快照变，输入段在**未保存**时随键入变。
 * 这条挡两种退化：① 卡片不订阅控制器（保存后页面停在旧值——生效段不换）；② 输入读数
 * 接错数据源（接了生效值——输入段不跟键入）。判据 = 生效段非空且等于期望、输入段等于
 * 当前草稿的换算；"必须变"由探针场景的 expected 选择承担（保存场景选新值、键入场景
 * 生效段不变）。**结尾 `$` 锚已删**：段后面还可能有别的文字，按"含该段"判。
 *
 * 探针侧的抽取口径（2026-09-26 用户裁定后的形状）：读数长在说明行的**换行**上，
 * 两段是说明行 `<p>` 里的两个 `<span>`，段 = `<标签>：<秒文本>`，秒文本三种形状
 * （`[\d.]+ s`、亚 10 ms 的 `< 0.01 s`、占位 `—`——判据 10）。
 *
 * @param {{effective: string, input: string}} before - 保存前两段（如 `{effective: '生效：0.5 s', input: '输入：4.32 s'}`；输入段占位传 `'输入：—'`）。
 * @param {{effective: string, input: string}} after - 保存后两段。
 * @param {{effective: string, input: string}} expected - 期望的两段（新生效值的换算 + 当前草稿的换算）。
 * @returns {{ ok: boolean, detail: string }} 判据结论与读数。
 */
export function judgeReadoutFollows(before, after, expected) {
  // 生效段是否"必须变"由场景决定（保存路径 expected ≠ before；纯键入路径 expected === before），
  // 判据只钉两件事：非空 + 等于期望。"必须变"由探针场景选择 expected 时承担。
  const effectiveFollows = after.effective !== '' && after.effective === expected.effective;
  const inputFollows = after.input === expected.input;
  return {
    ok: effectiveFollows && inputFollows,
    detail: `生效段：${JSON.stringify(before.effective)} → ${JSON.stringify(after.effective)}`
      + `（期望 ${JSON.stringify(expected.effective)}）命中=${String(effectiveFollows)}`
      + ` 输入段：${JSON.stringify(after.input)}（期望 ${JSON.stringify(expected.input)}）`
      + `跟键入=${String(inputFollows)}`
  };
}

/**
 * 保存往返后的落盘读数（R24 的第二段后半；R27 起按官方保存语义判）。
 *
 * 成功提示文案随自绘实现退场（裁决 E：成功不弹文案）；判成功用两个可观察面：
 * 字段回到生效值（模型成功后清草稿、由活 section 值回填）+ profile patch 命中。
 *
 * @param {string} controlValue - 保存后控件的值（回填到生效值才算成功）。
 * @param {boolean} failed - 页脚是否出现失败文案。
 * @param {string} patchText - profile patch 的文本。
 * @param {string} field - 字段名。
 * @param {string} value - 期望落盘的值。
 * @returns {{ ok: boolean, detail: string }} 判据结论与读数。
 */
export function judgeRoundTrip(controlValue, failed, patchText, field, value) {
  const restored = controlValue === value;
  const onDisk = new RegExp(`${field}:\\s*${value}`).test(patchText);
  const ok = restored && !failed && onDisk;
  return {
    ok,
    detail: `回填生效值=${String(restored)}（实得 ${JSON.stringify(controlValue)}）`
      + ` 页脚失败=${String(failed)} 落盘命中=${String(onDisk)}`
  };
}
