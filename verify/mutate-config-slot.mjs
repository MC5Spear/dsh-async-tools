/**
 * 变异：把设置卡的**接线**改坏（槽位名、落点、槽键、守卫、表单来源、订阅），要求
 * `judgeSlotWiring`（源码级）或 `runRegistration`（运行期）变红（设计 §5.3）。
 *
 * ## 为什么必须做这一步
 *
 * 设置区判据是"槽位名对 + 落点对 + 槽键对 + 表单真的自取"。槽键由常量拼出——
 * 静态 grep 只能证明源码里出现过某个词；所以除源码级判据外还有一条**运行期**判据：
 * 跑一遍 `apply()`，抓注册那一刻真实的 options。
 *
 * 七个突变各自对应一种真实退化：
 * - **M1 挂回 `plugins.item`**：契约里该槽留给官方伴随包（OCCUPIED），挂了页面永不渲染且无报错；
 * - **M2 退回组件行子页**（`plugins.row.config` + `<包名>#<行 id>` 键）：设置又藏进某个组件行，
 *   用户在插件页上看不到它——正是换落点要消除的形态；
 * - **M3 槽键改成行 id**：keyed 槽按键对准，键错 = 卡片永不出现、页面不报错；
 * - **M4 注册整段废掉**：`inject` 回调直接返回，卡片根本不存在；
 * - **M5 去掉 `whileServed` 守卫**：宿主行没装载也注册卡片，"部署无痕"失效；
 * - **M6 表单改读 `props.form`**：bundle 槽**不传** `form` ⇒ 渲染出一张空卡，且不报错；
 * - **M7 不订阅控制器**：快照换新后卡片再也不重渲染，保存后页面停在旧值。
 *
 * 本脚本**只在内存里**改写源码文本、喂给纯函数判据：不落盘、不需要还原、不 spawn 子进程，
 * 因此默认权限沙箱下可跑（`verify/README.md` 现行要点：「优先默认权限执行；纯函数判断尽量进程内复用」）。
 * 同一批性质在 `test/two-planes.test.mjs` 的 T5/T16/T18 里各有一条断言（`npm run test:inproc` 跑）。
 *
 * 用法：node verify/mutate-config-slot.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeSlotWiring, runRegistration } from './r24-judgements.mjs';

/** 语义对应的测试落点（变异索引登记用）：T5/T16/T18 各有一条断言。 */
const TEST = 'test/two-planes.test.mjs';

// 从模块自身位置推仓根（verify/ 上一级）——变异脚本要在任意 cwd 下都能跑。
const TARGET = join(fileURLToPath(new URL('..', import.meta.url)), 'client.js');
const original = readFileSync(TARGET, 'utf8');

/** 七个退化：每个都把源码文本改坏一处，锚点必须唯一命中（否则 SKIP，当失败处理）。 */
const MUTATIONS = [
  {
    id: 'M1',
    what: '槽位挂回官方占用的 plugins.item',
    apply: (text) => text.replace('name: "plugins.bundle.config"', 'name: "plugins.item"')
  },
  {
    id: 'M2',
    what: '退回组件行子页落点（plugins.row.config + `<包名>#<行 id>` 键）',
    apply: (text) => text
      .replace('name: "plugins.bundle.config"', 'name: "plugins.row.config"')
      .replace('key: PACKAGE_NAME,', 'key: PACKAGE_NAME + "#" + ENTRY,')
  },
  {
    id: 'M3',
    what: '槽键改成行 id（keyed 槽按键对准，键错永不渲染）',
    apply: (text) => text.replace('key: PACKAGE_NAME,', 'key: ENTRY,')
  },
  {
    id: 'M4',
    what: '注册整段废掉：inject 回调直接返回，卡片不存在',
    apply: (text) => text.replace('return ctx.slots.inject("plugins.bundle.config", function () {',
      'return ctx.slots.inject("plugins.bundle.config", function () {\n        if (true) return undefined;')
  },
  {
    id: 'M5',
    what: '去掉 whileServed 守卫（宿主行没装载也注册卡片）',
    apply: (text) => text.replace('return ctx.configForms.whileServed([ENTRY], function () {',
      'return (function () {')
  },
  {
    id: 'M6',
    what: '表单改读 props.form（bundle 槽不传 form ⇒ 静默空卡）',
    // 变异后的形态必须**真的不再取控制器**（不能留 `: ctx.configForms.get(ENTRY)` 回落——
    // 回落分支在 bundle 槽永远走不到，行为等价于坏，但源码级判据会被回落文本喂绿）。
    // 锚点带上下文锚到 createCardModel 的取控制器行（设置卡片的活路径）：`var scope =
    // ctx.configForms.get(ENTRY);` 在 client.js 里有两处（另一处在 createAskModel，
    // 提问接管侧加入）——裸字符串 replace 只换第一处时第二处会把源码级判据喂绿
    // （既有逃逸形态，变异以此加固）。
    apply: (text) => text.replace(
      'function createCardModel(ctx) {\n  var scope = ctx.configForms.get(ENTRY);',
      'function createCardModel(ctx) {\n  var scope = props.form !== undefined && props.form.state !== undefined ? props.form : undefined;')
  },
  {
    id: 'M7',
    what: '卡片不订阅模型的快照存储（快照换新后再也不重渲染）',
    apply: (text) => text.replace(
      'var state = React.useSyncExternalStore(card.store.subscribe, card.store.getSnapshot);',
      'var state = React.useSyncExternalStore(function () { return function () {}; }, card.store.getSnapshot);')
  }
];

const baseWiring = judgeSlotWiring(original);
const baseRegistration = runRegistration(original);
if (!baseWiring.ok || !baseRegistration.ok) {
  console.log(`BASELINE-RED  未变异时判据就不成立——先修基线：${baseWiring.detail}；${baseRegistration.detail}`);
  process.exit(2);
}
console.log('基线：未变异时接线判据与注册判据都成立。');
console.log(`  ${baseWiring.detail}`);
console.log(`  ${baseRegistration.detail}`);
console.log('');

let ok = true;
for (const mutation of MUTATIONS) {
  const mutated = mutation.apply(original);
  if (mutated === original) {
    console.log(`SKIP  ${mutation.id} 找不到锚点，本变异失效——当失败处理。`);
    ok = false;
    continue;
  }
  const wiring = judgeSlotWiring(mutated);
  let registration = { ok: false, detail: '（未跑：源码级判据已红）' };
  if (wiring.ok) {
    try {
      registration = runRegistration(mutated);
    } catch (error) {
      registration = { ok: false, detail: `运行期抛错：${error.message}` };
    }
  }
  const caught = !wiring.ok || !registration.ok;
  console.log(`${caught ? 'CAUGHT' : 'MISSED'}  ${mutation.id} ${mutation.what}`);
  console.log(`        接线：${wiring.detail}`);
  console.log(`        注册：${registration.detail}`);
  ok = caught && ok;
}
console.log('');
console.log(ok
  ? '七个变异都被抓住：槽位名、落点、槽键、注册发生、守卫、表单来源、订阅都有能失败的判据。'
  : '**有变异逃逸**——判据区分力不足。');
process.exitCode = ok ? 0 : 1;
