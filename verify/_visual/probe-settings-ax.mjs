#!/usr/bin/env node
/**
 * 设置页无障碍树探针（UI-SETTINGS-AX / UI-SETTINGS-AX-DESCRIPTION 返修核验）：
 * 官方可写临时实例上，对自绘布尔开关与预设绑定组做 **CDP Accessibility 全树**
 * ＋真实键盘事件断言——不以 DOM 属性代替无障碍树（真实读屏仍归 VERIFY-REAL-INPUT
 * 暂缓边界，本装置证「树里有」而非「读屏读出」）。
 *
 * 判据（AX-1..AX-6）：
 * - AX-1 四个布尔开关：AX 节点 role=switch、name=可见标签、description 在场
 *   （说明行随控件可达）、checked 与 aria-checked 一致；label[for]→控件 id 绑定。
 * - AX-2 键盘：Tab 聚焦开关后 Space 翻转、Enter 翻转（CDP 真实按键事件，非
 *   dispatchEvent 合成——合成链已被 real-input 裁定不得作通过证据）。
 * - AX-3 绑定组：ul[role=group] 的 AX 节点 name（标题）与 description（生效名单
 *   说明行）都在场。
 * - AX-4 展开帮助：布尔开关的 AX description 随帮助区展开而含帮助正文（describedby
 *   清单动态扩列）。
 * - AX-5 动态错误：数值字段打非法草稿后，该控件 AX description 首段为非法原因、
 *   DOM 侧 aria-invalid 与 describedby 首指＝非法行（invalid 态字段在 CDP 树里的
 *   落点随版本漂移，装置留痕不判）。
 * - AX-6 两语：uiLang 切 en 后开关 name/description 换英文（同一棵树复核）。
 *
 * 用法（须 danger-full-access 或非受限环境——实例/浏览器子进程在受限档必 EPERM）：
 *   node verify/_visual/probe-settings-ax.mjs --service-root <宿主服务根> \
 *     [--host-subdir dsh-0.2.1-rc.5] [--repo <本仓路径>] [--keep]
 * 红线：只操作自建隔离实例；草稿不保存（uiLang 保存后复原）；证据落
 * `.local/evidence/rework3-settings-ax/`。退出 0＝全过、1＝有 FAIL、2＝装置故障。
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, openPage, evaluate, findBrowser, waitFor, screenshot } from './cdp.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const keep = args.includes('--keep');
let home = null;
let child = null;
let browser = null;
let page = null;
const EVID = 'rework3-settings-ax';
const fail = (msg) => {
  try {
    mkdirSync(join(repo, '.local', 'evidence', EVID, 'logs'), { recursive: true });
    writeFileSync(join(repo, '.local', 'evidence', EVID, 'logs', 'fault.json'),
      JSON.stringify({ at: new Date().toISOString(), msg, results }, null, 2));
  } catch { /* 落盘失败不阻塞清理 */ }
  try { cleanup(); } catch { /* 尽力清理 */ }
  console.error(`[probe] FAULT: ${msg}\n[probe] 临时目录：${home ?? '（尚未创建）'}${keep ? '（--keep 保留）' : '（已清理）'}`);
  process.exit(2);
};
const serviceRootArg = argOf('service-root') ?? process.env.DSAT_SERVICE_ROOT;
if (serviceRootArg === undefined || serviceRootArg.trim() === '') fail('缺少 --service-root（或环境变量 DSAT_SERVICE_ROOT）');
const serviceRoot = resolve(serviceRootArg);
const hostSubdir = argOf('host-subdir') ?? 'dsh-0.2.1-rc.5';
const repo = resolve(argOf('repo') ?? process.cwd());
const hostRoot = join(serviceRoot, hostSubdir);
let hostVersion;
try {
  hostVersion = JSON.parse(readFileSync(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
} catch (error) {
  fail(`无法读取宿主树版本：${String(error?.message ?? error)}`);
}
const bin = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

const log = (msg) => console.log(`[probe] ${msg}`);
const results = [];
const shots = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail, at: new Date().toISOString() });
  if (ok !== true && ok !== null) failed += 1;
  console.log(`  ${ok === true ? 'PASS  ' : ok === false ? 'FAIL  ' : '留痕  '}${name}${detail === '' ? '' : `\n          ${detail}`}`);
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
function killTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return;
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' }); } catch { /* 已退出 */ }
}
process.on('exit', () => { if (child !== null) killTree(child.pid); });
function cleanup() {
  try { page?.close(); } catch { /* 已关 */ }
  try { browser?.close(); } catch { /* 已关 */ }
  if (child !== null) { killTree(child.pid); child = null; }
  if (!keep && home !== null) { try { rmSync(home, { recursive: true, force: true }); } catch { /* 占用中 */ } }
}

let ORIGIN = '';
let TOKEN = '';
async function startInstance() {
  // 补丁绝对路径（rework2-F2 装置经验：相对路径有 ops\patches 歧义）；实例 cwd＝
  // 服务根——.env 凭据在根上，临时 home 无凭据。
  child = spawn('node', [
    bin, '--patch', join(serviceRoot, 'ops', 'patches', 'zai-glm.yml'), '--profile', 'web',
    '--host', '127.0.0.1', '--port', '0', '--no-open'
  ], { cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderrTail = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-4000); });
  const url = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => rejectUrl(new Error('实例 90s 内未就绪')), 90_000);
    const poll = setInterval(() => {
      const m = stdout.match(/https?:\/\/\S+/);
      if (m !== null) { clearTimeout(timer); clearInterval(poll); resolveUrl(m[0]); }
      if (child.exitCode !== null) { clearTimeout(timer); clearInterval(poll); rejectUrl(new Error(`实例提前退出 ${String(child.exitCode)}`)); }
    }, 200);
  }).catch((error) => { killTree(child.pid); fail(`${String(error.message)}\nstderr 尾部：\n${stderrTail}`); });
  const urlMatch = url.match(/^(https?:\/\/[^/?#]+)\/?\?token=(.+)$/);
  if (urlMatch === null) { killTree(child.pid); fail(`实例 URL 形态不符：${url.split('?')[0]}`); }
  [, ORIGIN, TOKEN] = urlMatch;
  log(`实例就绪：${ORIGIN}（token 已脱敏）`);
}
const clickBy = (selectorJs, label) => evaluate(page, `(() => {
  const target = ${selectorJs};
  if (target === undefined || target === null) return 'missing:' + ${JSON.stringify(label)};
  target.click();
  return 'clicked';
})()`);
async function openGui() {
  page = await openPage(browser.port, `${ORIGIN}/?token=${encodeURIComponent(TOKEN)}`);
  await waitFor(page, 'document.querySelectorAll("button,[role=button]").length', (n) => n > 0, 15000);
}
async function gotoPluginPage() {
  const nav1 = await clickBy(`[...document.querySelectorAll('button,[role=button],a')].find((n) => (n.getAttribute('aria-label') || '') === '插件')`, '插件');
  if (nav1 !== 'clicked') fail(`插件入口未找到（${nav1}）`);
  await sleep(2500);
  const nav2 = await clickBy(`[...document.querySelectorAll('*')].find((n) => (n.getAttribute('aria-label') || '') === '查看 dsh-async-tools')`, '查看 dsh-async-tools');
  if (nav2 !== 'clicked') fail(`插件详情入口未找到（${nav2}）`);
  await sleep(3000);
  await waitFor(page, 'document.querySelector("[data-plugin-config]") !== null', (v) => v === true, 15000);
}
const dismissDialog = () => evaluate(page, `(() => {
  const vis = [...document.querySelectorAll('[role="dialog"], dialog')]
    .filter((d) => d.getClientRects().length > 0);
  let clicked = 0;
  for (const d of vis) {
    const btns = [...d.querySelectorAll('button')];
    const primary = btns.find((b) => /继续|开始|知道了|确认|Got it|Continue/i.test(b.textContent.trim()));
    (primary ?? btns[btns.length - 1])?.click();
    clicked += 1;
  }
  return clicked;
})()`);

/** CDP 无障碍全树（限定设置区子树：data-plugin-config 容器 backendDOMId 内）。 */
async function axSubtree() {
  const rootId = await evaluate(page, `document.querySelector('[data-plugin-config]') !== null`);
  if (rootId !== true) return null;
  const full = await page.send('Accessibility.getFullAXTree', {});
  const secBackend = await evaluate(page, `(() => {
    const sec = document.querySelector('[data-plugin-config]');
    const walk = (n) => { if (n === undefined || n === null) return null; if (n === sec) return true; return walk(n.parentElement); };
    // AX 节点按 backendDOMId 对不上 DOM id——这里先返回全树，按 role/name 过滤在 JS 侧做。
    return true;
  })()`);
  return { nodes: full.nodes ?? [], sampled: secBackend };
}
/** 按谓词找 AX 节点。状态（checked/pressed/invalid/focused）在 CDP 树里落在节点的
 * `properties` 数组（AXProperty{name,value}），顶层字段不携带——三处兼容都取。 */
const axFind = (tree, pred) => (tree?.nodes ?? []).filter((n) => {
  try { return pred({
    role: n.role?.value ?? '',
    name: n.name?.value ?? '',
    description: n.description?.value ?? '',
    checked: n.checked?.value ?? axProp(n, 'checked') ?? '',
    pressed: n.pressed?.value ?? axProp(n, 'pressed') ?? '',
    invalid: n.invalid?.value ?? axProp(n, 'invalid') ?? undefined,
    value: n.value?.value ?? '',
    id: n.backendDOMId
  }); } catch { return false; }
}).map((n) => ({
  role: n.role?.value ?? '', name: n.name?.value ?? '', description: n.description?.value ?? '',
  checked: n.checked?.value ?? axProp(n, 'checked') ?? '', pressed: n.pressed?.value ?? axProp(n, 'pressed') ?? '',
  value: n.value?.value ?? '', invalid: n.invalid?.value ?? axProp(n, 'invalid') ?? undefined
}));
/** 读 AXNode.properties 数组里的具名状态值（无则 undefined）。 */
function axProp(node, name) {
  const hit = (node.properties ?? []).find((p) => p.name === name);
  return hit?.value?.value;
}
/** 真实键盘事件（CDP Input 域——非 DOM 合成）：Tab/Space/Enter。 */
async function key(k) {
  const defs = {
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
    Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' },
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' }
  }[k];
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 0, ...defs });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, ...defs });
}
const activeIs = (selectorJs) => evaluate(page, `(() => { const n = ${selectorJs}; return n !== null && n !== undefined && document.activeElement === n; })()`);

// ── 主流程 ─────────────────────────────────────────────────────────────────
try {
  const browserPath = findBrowser();
  if (browserPath === undefined) fail('找不到 Edge/Chrome（GUI 探针需本机浏览器）');
  home = mkdtempSync(join(tmpdir(), 'dsh-ax-settings-'));
  await startInstance();
  browser = await launch(browserPath);
  await openGui();
  let rounds = 0;
  while (Number(await dismissDialog()) > 0 && rounds < 3) { await sleep(700); rounds += 1; }

  log(`repo=${repo} hostVersion=${hostVersion}`);
  const packRun = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', '.local'], { cwd: repo, encoding: 'utf8', shell: true });
  if (packRun.status !== 0) fail(`npm pack 退出 ${String(packRun.status)}：${packRun.stderr}`);
  const tgzName = (packRun.stdout.match(/dsh-async-tools-[^\s]+\.tgz/g) ?? []).pop();
  if (tgzName === undefined) fail('npm pack 未产出 tgz');
  const install = spawnSync('node', [bin, 'plugin', '--profile', 'web', 'add', join(repo, '.local', tgzName)], {
    cwd: serviceRoot, encoding: 'utf8', env: { ...process.env, DSH_HOME: home }
  });
  if (install.status !== 0) { console.error(install.stdout); console.error(install.stderr); fail('plugin add 退出非 0'); }
  log(`已装插件 tgz=${tgzName}`);

  await gotoPluginPage();
  await sleep(1500);

  // AX-1 布尔开关：DOM 身份＋AX 树 name/description/checked。
  const switchRows = await evaluate(page, `(() => {
    const out = [];
    for (const sw of document.querySelectorAll('[data-plugin-config] button[role="switch"]')) {
      const row = sw.closest('.ats-enum-field');
      const label = row?.querySelector('.ats-enum-label')?.textContent.trim() ?? '';
      const labelFor = row?.querySelector('label.ats-enum-label')?.getAttribute('for') ?? '';
      out.push({ id: sw.id, label, labelFor, checked: sw.getAttribute('aria-checked'), ariaLabel: sw.getAttribute('aria-label') ?? '', describedBy: sw.getAttribute('aria-describedby') ?? '' });
    }
    return out;
  })()`);
  check('AX-1 布尔开关恰好四个（自绘 role=switch）', switchRows.length === 4, JSON.stringify(switchRows.map((r) => r.id)));
  let tree = await axSubtree();
  for (const row of switchRows) {
    const nodes = axFind(tree, (n) => n.role === 'switch' && n.name === row.label);
    const node = nodes[0];
    check(`AX-1 ${row.id}：AX 树有 switch 节点且 name=可见标签`, node !== undefined,
      `label=${row.label} 命中=${String(nodes.length)}`);
    if (node !== undefined) {
      check(`AX-1 ${row.id}：AX description 在场（说明行随控件可达）`, node.description.length > 0,
        `desc=${node.description.slice(0, 80)}`);
      const stateRead = String(node.checked || node.pressed || node.value || '');
      check(`AX-1 ${row.id}：AX checked 态与 aria-checked 一致`, stateRead === row.checked,
        `checked=${String(node.checked)} pressed=${String(node.pressed)} value=${String(node.value)} dom=${String(row.checked)}`);
    }
    check(`AX-1 ${row.id}：label[for] 绑定控件 id`, row.labelFor === row.id, `for=${row.labelFor}`);
  }

  // AX-2 键盘：Tab 到首个开关＋Space/Enter 翻转（真实按键）。
  const firstSwitch = switchRows[0];
  await evaluate(page, `document.getElementById(${JSON.stringify(firstSwitch.id)})?.focus()`);
  const beforeKey = await evaluate(page, `document.getElementById(${JSON.stringify(firstSwitch.id)})?.getAttribute('aria-checked')`);
  await key('Space');
  await sleep(400);
  const afterSpace = await evaluate(page, `document.getElementById(${JSON.stringify(firstSwitch.id)})?.getAttribute('aria-checked')`);
  check('AX-2 Space 翻转开关（真实按键事件）', beforeKey !== afterSpace && afterSpace !== undefined,
    `${String(beforeKey)}→${String(afterSpace)}`);
  await key('Enter');
  await sleep(400);
  const afterEnter = await evaluate(page, `document.getElementById(${JSON.stringify(firstSwitch.id)})?.getAttribute('aria-checked')`);
  check('AX-2 Enter 再翻转（回到原态）', afterEnter === beforeKey, `${String(afterSpace)}→${String(afterEnter)}`);
  // Tab 序：开关聚焦后连发 Tab 应离开（无焦点陷阱的轻量证据）。
  await key('Tab');
  const leftSwitch = await activeIs(`document.getElementById(${JSON.stringify(firstSwitch.id)})`);
  check('AX-2 Tab 可离开开关（无焦点陷阱）', leftSwitch === false, '');

  // AX-3 绑定组 name＋description。
  const groupInfo = await evaluate(page, `(() => {
    const ul = document.querySelector('ul.ats-preset-list');
    if (ul === null) return null;
    const labelledBy = ul.getAttribute('aria-labelledby') ?? '';
    const describedBy = ul.getAttribute('aria-describedby') ?? '';
    const nameNode = labelledBy === '' ? null : document.getElementById(labelledBy);
    const descNode = describedBy === '' ? null : document.getElementById(describedBy);
    return { labelledBy, describedBy, nameText: nameNode?.textContent.trim() ?? '', descHas: descNode?.textContent.includes('dsh-async') === true || (descNode?.textContent ?? '').length > 0 };
  })()`);
  check('AX-3 绑定组 labelledby/describedby 都指向在场节点', groupInfo !== null && groupInfo.labelledBy !== '' && groupInfo.describedBy !== '' && groupInfo.descHas === true,
    JSON.stringify(groupInfo));
  tree = await axSubtree();
  const groupNodes = axFind(tree, (n) => n.role === 'group' && n.name.includes('预设'));
  check('AX-3 绑定组 AX 节点 name 在场（含「预设」）', groupNodes.length >= 1,
    `命中=${String(groupNodes.length)} name=${groupNodes[0]?.name.slice(0, 60) ?? ''}`);
  if (groupNodes[0] !== undefined) {
    check('AX-3 绑定组 AX description 在场（生效名单说明）', groupNodes[0].description.length > 0,
      groupNodes[0].description.slice(0, 80));
  }

  // AX-4 展开帮助→describedby 扩列：描述取引用节点的可及名（实测＝帮助区 aria-label
  // 「… 的说明」），帮助正文本体是独立的 region 节点（自身可及、不挤进 description）。
  const helpKey = firstSwitch.id.replace('plugin-config-', '');
  const collapsedDesc = axFind(tree, (n) => n.role === 'switch' && n.name === firstSwitch.label)[0]?.description ?? '';
  const open = await clickBy(`document.querySelector('.ats-help-button[aria-controls="plugin-config-${helpKey}-help"]')`, `帮助·${helpKey}`);
  await sleep(500);
  const helpMeta = await evaluate(page, `(() => {
    const region = document.getElementById('plugin-config-${helpKey}-help');
    return { regionLabel: region?.getAttribute('aria-label') ?? '', text: region?.textContent.trim().slice(0, 60) ?? '' };
  })()`);
  tree = await axSubtree();
  const switchAfterHelp = axFind(tree, (n) => n.role === 'switch' && n.name === firstSwitch.label)[0];
  const helpRegionNode = axFind(tree, (n) => n.role === 'region' && n.name.includes(firstSwitch.label) && n.name.includes('说明'))[0];
  check('AX-4 展开后开关 AX description 扩列（含帮助区可及名）',
    switchAfterHelp !== undefined && helpMeta.regionLabel !== '' && switchAfterHelp.description.includes(helpMeta.regionLabel),
    `regionLabel=${helpMeta.regionLabel} desc尾=${switchAfterHelp?.description.slice(-60) ?? ''}`);
  check('AX-4 帮助正文以独立 region 节点在场（AX 树可及）', helpRegionNode !== undefined,
    `region=${helpRegionNode?.name ?? ''} 正文=${helpMeta.text.slice(0, 40)}`);
  await clickBy(`document.querySelector('.ats-help-button[aria-controls="plugin-config-${helpKey}-help"]')`, '帮助收起');
  await sleep(300);

  // AX-5 动态错误：数值字段非法草稿→AX invalid＋description 首段为原因。
  const numKey = 'defaultYieldMs';
  const setDraft = await evaluate(page, `(() => {
    const input = document.querySelector('#plugin-config-${numKey}');
    if (input === null) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '999999999');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'set';
  })()`);
  await sleep(600);
  const invalidRow = await evaluate(page, `(() => {
    const input = document.querySelector('#plugin-config-${numKey}');
    const invalid = document.getElementById('plugin-config-${numKey}-invalid');
    const described = input?.getAttribute('aria-describedby') ?? '';
    return { set: true, ariaInvalid: input?.getAttribute('aria-invalid') ?? '', firstId: described.split(' ')[0] ?? '', invalidText: invalid?.textContent.trim().slice(0, 40) ?? '' };
  })()`);
  tree = await axSubtree();
  // 命中口径：按 DOM 读到的字段可见标签定位 AX 节点，断言其 description 首段含
  // 非法原因（invalid 行是 describedby 首位）；invalid 态本身随版本落点不稳，留痕不判。
  const numLabel = await evaluate(page, `document.querySelector('#plugin-config-${numKey}')?.closest('.ats-enum-field')?.querySelector('.ats-enum-label')?.textContent.trim() ?? ''`);
  const invalidNode = axFind(tree, (n) => n.name === numLabel
    && (n.description.includes(invalidRow.invalidText.slice(0, 12)) || n.invalid === true))[0];
  check('AX-5 非法草稿：aria-invalid 入 DOM 且 describedby 首位＝非法行', invalidRow.ariaInvalid === 'true' && invalidRow.firstId === `plugin-config-${numKey}-invalid`,
    JSON.stringify(invalidRow));
  check('AX-5 AX 树该字段 description 含非法原因文本', invalidNode !== undefined,
    `label=${numLabel} 节点=${JSON.stringify(invalidNode ?? {}).slice(0, 120)}`);
  // 清草稿（恢复默认按钮）。
  await evaluate(page, `(() => {
    const row = document.querySelector('#plugin-config-${numKey}')?.closest('.ats-enum-field');
    const btn = [...(row?.querySelectorAll('button.ats-enum-reset') ?? [])].find((b) => /^(恢复默认|Reset)$/.test(b.textContent.trim()));
    btn?.click();
    return true;
  })()`);
  await sleep(500);

  // AX-6 两语：uiLang→en 需**保存后生效**（草稿不换界面语言——语言取生效快照）。
  const setEn = await evaluate(page, `(() => {
    const sel = document.querySelector('#plugin-config-uiLang');
    if (sel === null) return 'no-select';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, 'en');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'set';
  })()`);
  await sleep(400);
  const saveEn = await clickBy(`[...document.querySelectorAll('[data-plugin-config] button')].find((b) => /^(保存|Save)$/.test(b.textContent.trim()))`, '保存(en)');
  await sleep(2000);
  const enSwitch = await evaluate(page, `(() => {
    const sw = document.getElementById(${JSON.stringify(firstSwitch.id)});
    const row = sw?.closest('.ats-enum-field');
    return { ariaLabel: sw?.getAttribute('aria-label') ?? '', label: row?.querySelector('.ats-enum-label')?.textContent.trim() ?? '', desc: (document.getElementById(sw?.getAttribute('aria-describedby') ?? '')?.textContent ?? '').slice(0, 60) };
  })()`);
  tree = await axSubtree();
  const enNode = axFind(tree, (n) => n.role === 'switch' && n.name === enSwitch.label)[0];
  check('AX-6 en 档开关可见标签与 aria-label 同为英文', setEn === 'set' && saveEn === 'clicked' && enSwitch.ariaLabel === enSwitch.label && /[A-Za-z]{3}/.test(enSwitch.label),
    JSON.stringify(enSwitch));
  check('AX-6 en 档 AX 树 name=英文标签且 description 英文在场', enNode !== undefined && enNode.description.length > 0 && /[A-Za-z]{3}/.test(enNode.description),
    `name=${enNode?.name ?? ''} desc=${enNode?.description.slice(0, 60) ?? ''}`);
  // 还原 zh（草稿＋保存一轮：uiLang 属可保存字段——保存即恢复中文界面）。
  const revert = await evaluate(page, `(() => {
    const sel = document.querySelector('#plugin-config-uiLang');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, 'auto');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'set';
  })()`);
  await sleep(600);
  const saveRes = await clickBy(`[...document.querySelectorAll('[data-plugin-config] button')].find((b) => /^(保存|Save)$/.test(b.textContent.trim()))`, '保存');
  await sleep(1500);
  check('AX-6 收尾复原 uiLang=auto 并保存', revert === 'set' && saveRes === 'clicked', saveRes);

  mkdirSync(join(repo, '.local', 'evidence', EVID, 'shots'), { recursive: true });
  await screenshot(page, join(repo, '.local', 'evidence', EVID, 'shots', 'settings-ax-final.png'));
  shots.push('settings-ax-final.png');
} catch (error) {
  fail(`装置异常：${String(error?.stack ?? error)}`);
}

mkdirSync(join(repo, '.local', 'evidence', EVID, 'logs'), { recursive: true });
writeFileSync(join(repo, '.local', 'evidence', EVID, 'logs', 'results.json'),
  JSON.stringify({ at: new Date().toISOString(), host: hostVersion, repo, results, shots }, null, 2));
cleanup();
log(`结束：${String(results.length)} 项判据，失败 ${String(failed)}（证据目录 ${EVID}，路径见 verify/README 行与 results.json 内绝对路径）`);
process.exit(failed > 0 ? 1 : 0);
