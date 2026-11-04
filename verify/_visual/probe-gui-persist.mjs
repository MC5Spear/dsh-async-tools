#!/usr/bin/env node
/**
 * 绑定名单 GUI 持久化矩阵探针（VERIFY-01，设计 `.local/design/gui-persistence-visual.md`
 * §6 装置 A，BP-0..BP-9）：官方可写**临时实例**上，经 GUI（勾选＋保存按钮）驱动
 * boundPresets 的全部持久化形态，GUI 显示／落盘 profile patch／RPC describe 三侧互证。
 *
 * ## 装置在证什么（对照设计 §4 状态区分矩阵）
 *
 * 2026-11-02 GUI 盲测只在**复制式 profile**上看过绑定块的渲染与交互——保存被宿主
 * 正确拒绝（复制式 profile 的已知限制），「官方可写实例上的保存持久化」一直是开放
 * 项（设计 §9.3 L1391）。本探针用 runtime-peers 同款**官方 CLI 安装的临时实例**
 * 补齐：保存子集、刷新回读、空名单（显式 `[]`，与 unset 是两个状态）、恢复默认
 * unset（删用户覆盖键）、unset 与他字段覆盖并存（按键 unset 不清整段）、实例重启
 * 保留、同名重装保留、换版本号升级保留（fixture 定义与真实升级的差距见设计 §6——
 * 同 schema 无迁移，不冒称）、收尾复原。
 *
 * 三侧载体：GUI＝DOM 读数（生效名单行／覆盖徽标／恢复默认按钮／复选框勾集）；
 * 落盘＝`$DSH_HOME/profiles/web/cordis.patch.yml` 文本全量快照；RPC＝
 * `settings/describe` 的 `value`（生效）／`user`（用户覆盖——键缺席即 unset 的
 * 结构化判据）。HMR「就地刷新、无整页重载」以窗口存活标记＋navigation 计数断言
 * （整页重载即丢标记——r24 同型判据无此防护，此处补上）。
 *
 * 字段身份基线：值字段＝SETTING_FIELD_KEYS 去 boundPresets（19 枚，绑定块复选框
 * id 同以 plugin-config- 开头、按 ul.ats-preset-list 归属分流排除——设计 BP-0b）；
 * 绑定块本身单列判据（BP-0⑤），不与单值字段混计。
 *
 * ## 用法（须 danger-full-access 或非受限环境——CDP 无头浏览器在受限沙箱档必早夭）
 *
 *   node verify/_visual/probe-gui-persist.mjs --service-root <宿主服务根> \
 *     [--host-subdir dsh-0.2.1-rc.5] [--repo <本仓路径>] [--keep]
 *
 * 红线：不连开发实例（38200），不动活体实例（38114）——本装置全部用自建临时实例。
 * 证据：`.local/evidence/gui-persist/{logs,shots}`。退出 0＝全部通过、1＝存在 FAIL、
 * 2＝装置故障（FAULT，输出区分）。
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, openPage, evaluate, findBrowser, waitFor, screenshot } from './cdp.mjs';
import { judgePlacement, judgeConfigForm, judgeHelpButtons } from '../r24-judgements.mjs';
import { SETTING_FIELD_KEYS, MS_FIELD_KEYS } from '../../lib/config.js';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const keep = args.includes('--keep');
let home = null;
let child = null;
let browser = null;
let bumpDirNow = null;
const fail = (msg) => {
  // 盲审 d1/d2：FAULT 先落已跑判据＋清理资源（设计 §10「退出 2 前先清」；含
  // 升级临时目录 bumpDir）；早期调用（目录未建）时静默跳过落盘。
  try {
    mkdirSync(join(repo, '.local', 'evidence', 'gui-persist', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.local', 'evidence', 'gui-persist', 'logs', 'fault.json'),
      JSON.stringify({ at: new Date().toISOString(), msg, results }, null, 2));
  } catch { /* 磁盘写失败不阻塞清理与退出 */ }
  try {
    cleanup();
    if (!keep && typeof bumpDirNow === 'string') { try { rmSync(bumpDirNow, { recursive: true, force: true }); } catch { /* 占用中 */ } }
  } catch { /* 尽力清理 */ }
  console.error(`[probe] FAULT: ${msg}\n[probe] 临时目录：${home ?? '（尚未创建）'}${keep ? '（--keep 保留）' : '（已清理；如占用残留请手动删除）'}`);
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
/** 值字段＝六组 20 键去 boundPresets（绑定块单列，设计 BP-0b）。 */
const VALUE_FIELD_KEYS = SETTING_FIELD_KEYS.filter((k) => k !== 'boundPresets');

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
const eqSorted = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
function killTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return;
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' }); } catch { /* 已退出 */ }
}

// ── 实例生命周期 ────────────────────────────────────────────────────────────
let ORIGIN = '';
let TOKEN = '';
let COOKIE = '';
let tgzBase = '';
async function startInstance() {
  child = spawn('node', [
    bin, '--patch', 'patches/zai-glm.yml', '--profile', 'web',
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
  const indexResponse = await fetch(`${ORIGIN}/?token=${TOKEN}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  COOKIE = (indexResponse.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
  if (COOKIE.length === 0) { killTree(child.pid); fail('token 换 cookie 失败'); }
  log(`实例就绪：${ORIGIN}（token 已脱敏）`);
}
function stopInstance() {
  if (child !== null) { killTree(child.pid); child = null; }
}
async function rpc(endpoint, argsPayload) {
  // 载荷形状与宿主网关约定一致：payload 内恰一个 args 平面对象（少包一层会被
  // gateway/internal「exactly one plain-object args field」拒绝——首跑实测）。
  const body = JSON.stringify({
    type: 'client-request', rpcId: `probe-${Math.random().toString(36).slice(2, 10)}`,
    method: endpoint, payload: { args: argsPayload }
  });
  const response = await fetch(`${ORIGIN}/api/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body,
    signal: AbortSignal.timeout(30_000)
  });
  const parsed = JSON.parse(await response.text());
  if (parsed?.result?.ok !== true) throw new Error(`${endpoint}: ${JSON.stringify(parsed?.result?.error ?? '').slice(0, 200)}`);
  return parsed.result.value;
}
async function describeRow() {
  const described = await rpc('settings/describe', {});
  const row = described.namespaces.find((n) => (n.ns ?? n.namespace ?? n.id) === 'async-tools-host');
  if (row === undefined) throw new Error('settings/describe 缺少 async-tools-host 行');
  return row;
}
function patchText() {
  try { return readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'); } catch { return '(patch 文件缺席)'; }
}
function snapshotPatch(tag) {
  const text = patchText();
  results.push({ name: `patch 快照·${tag}`, ok: null, detail: text, at: new Date().toISOString() });
  return text;
}

// ── GUI 驱动 ────────────────────────────────────────────────────────────────
let page = null;
const clickBy = (selectorJs, label) => evaluate(page, `(() => {
  const target = ${selectorJs};
  if (target === undefined || target === null) return 'missing:' + ${JSON.stringify(label)};
  target.click();
  return 'clicked';
})()`);
async function openGui() {
  try { page?.close(); } catch { /* 旧目标已关 */ }
  page = await openPage(browser.port, `${ORIGIN}/?token=${encodeURIComponent(TOKEN)}`);
  await waitFor(page, 'document.querySelectorAll("button,[role=button]").length', (n) => n > 0, 15000);
}
async function gotoPluginPage() {
  const nav1 = await clickBy(`[...document.querySelectorAll('button,[role=button],a')].find((n) => (n.getAttribute('aria-label') || '') === '插件')`, '插件');
  if (nav1 !== 'clicked') fail(`插件入口未找到（${nav1}）——GUI 形态与 r24 先例不符，装置侧核实`);
  await sleep(2500);
  const nav2 = await clickBy(`[...document.querySelectorAll('*')].find((n) => (n.getAttribute('aria-label') || '') === '查看 dsh-async-tools')`, '查看 dsh-async-tools');
  if (nav2 !== 'clicked') fail(`插件详情入口未找到（${nav2}）`);
  await sleep(3000);
  await waitFor(page, 'document.querySelector("[data-plugin-config]") !== null', (v) => v === true, 15000);
}
/** 读绑定块三件套（生效名单行／覆盖徽标与恢复默认按钮／复选框勾集）＋保存按钮态＋版本标签。
 * 作用域钉在 boundPresets 块容器（`#plugin-config-boundPresets-message` 的
 * `.ats-enum-field`）——其他字段覆盖时也有同名「已覆盖」徽标与「恢复默认」按钮
 * （首跑实测：agentLang 覆盖时按全文第一个命中会读错/点错字段），一律在容器内取。
 * 徽标/恢复默认按钮是**草稿级**标记（fieldState.overridden 跟草稿——与毫秒读数
 * 输入段同源）：草稿回默认即退场；「未保存不冒称」由生效值行承担（保存前仍显示
 * 旧生效名单）。 */
const readBound = () => evaluate(page, `(() => {
  const msg = document.getElementById('plugin-config-boundPresets-message');
  const field = msg === null ? null : msg.closest('.ats-enum-field');
  const badges = field === null ? null : field.querySelector('.ats-enum-badges');
  const tagPresent = badges === null ? false
    : [...badges.querySelectorAll('*')].some((n) => n.children.length === 0 && /^(已覆盖|Overridden)$/.test((n.textContent || '').trim()));
  const resetBtn = field === null ? null
    : [...field.querySelectorAll('button.ats-enum-reset')]
      .find((b) => /^(恢复默认|Reset)$/.test(b.textContent.trim())) ?? null;
  const boxes = [...document.querySelectorAll('ul.ats-preset-list input[type=checkbox]')];
  const save = [...document.querySelectorAll('[data-plugin-config] button')]
    .find((b) => /^(保存|Save)$/.test(b.textContent.trim()));
  const versionTag = document.querySelector('[data-plugin-detail="dsh-async-tools"] [class*="versionTag"]');
  return {
    effectiveLine: msg === null ? '' : msg.textContent.trim(),
    tagPresent, resetPresent: resetBtn !== null,
    checked: boxes.map((b) => [b.id.slice('plugin-config-boundPresets-'.length), b.checked]),
    saveEnabled: save !== undefined && save.disabled !== true,
    saveBusy: save !== undefined && /保存中|Saving/.test(save.textContent),
    version: versionTag === null ? '' : versionTag.textContent.trim()
  };
})()`);
/** 把勾集改成目标集合（React 受控复选框——真 click 走 onChange，不伪造属性）。 */
const setChecks = (targetIds) => evaluate(page, `(() => {
  const want = new Set(${JSON.stringify(targetIds)});
  const boxes = [...document.querySelectorAll('ul.ats-preset-list input[type=checkbox]')];
  const acted = [];
  for (const b of boxes) {
    const id = b.id.slice('plugin-config-boundPresets-'.length);
    if (b.checked !== want.has(id)) { b.click(); acted.push(id); }
  }
  return acted;
})()`);
const save = () => clickBy(`[...document.querySelectorAll('[data-plugin-config] button')].find((b) => /^(保存|Save)$/.test(b.textContent.trim()))`, '保存');
async function waitForOutcome() {
  // 盲审 c2 修正的时序洞（五跑实测）：只判「非 busy」会在保存请求发出前的窗口
  // 早退、读到保存前状态。改为「见过 busy 且回落」才算到达观察点；若 busy 窗口
  // 整个未被采样到（<250ms 的极端快径），退化为超时后终读——两种路径都返回
  // 保存后的稳定读数，不早退。前 3s 用 250ms 粒度采样 busy 窗口。
  let sawBusy = false;
  for (let i = 0; i < 60; i += 1) {
    const state = await readBound();
    if (state.saveBusy === true) { sawBusy = true; } else if (sawBusy) { return state; }
    await sleep(i < 12 ? 250 : 1000);
  }
  return readBound();
}
/** 恢复默认（**boundPresets 块内**的行内按钮，只暂存草稿）——其他被覆盖字段也有
 * 同名按钮，须按绑定块容器限定（首跑实测：不限定会误点 agentLang 的同名按钮）。 */
const clickResetField = () => evaluate(page, `(() => {
  const msg = document.getElementById('plugin-config-boundPresets-message');
  const field = msg === null ? null : msg.closest('.ats-enum-field');
  const btn = field === null ? null
    : [...field.querySelectorAll('button.ats-enum-reset')]
      .find((b) => /^(恢复默认|Reset)$/.test(b.textContent.trim())) ?? null;
  if (btn === null) return 'missing:恢复默认（绑定块）';
  btn.click();
  return 'clicked';
})()`);
/** 把 select 字段写成 value（agentLang 用——原生 setter＋change，React 受控）。 */
const setSelect = (key, value) => evaluate(page, `(() => {
  const input = document.querySelector('#plugin-config-${key}');
  if (input === null) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'set';
})()`);
/** 无整页重载标记：注入窗口存活标记＋navigation 计数（BP-1 判据① 的断言手段）。 */
const injectNoReloadMark = () => evaluate(page, `(() => {
  window.__atsNoReload = (window.__atsNoReload ?? 0) + 1;
  return { mark: window.__atsNoReload, nav: performance.getEntriesByType('navigation').length };
})()`);
const readNoReloadMark = () => evaluate(page, `({ mark: window.__atsNoReload ?? 0, nav: performance.getEntriesByType('navigation').length })`);

// ── 收尾 ────────────────────────────────────────────────────────────────────
process.on('exit', () => { stopInstance(); });
function cleanup() {
  try { page?.close(); } catch { /* 已关 */ }
  try { browser?.close(); } catch { /* 已关 */ }
  stopInstance();
  if (!keep && home !== null) { try { rmSync(home, { recursive: true, force: true }); } catch { /* 占用中 */ } }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const EVID = join(repo, '.local', 'evidence', 'gui-persist');
const LOGS = join(EVID, 'logs');
const SHOTS = join(EVID, 'shots');
mkdirSync(LOGS, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
/** 每张截图前的护栏：宿主首访「预览版说明」弹窗会遮截图（B/C 实证同款实例存在；
 * 判据走 DOM/RPC 不受遮罩影响，此处只保截图证据干净）。 */
const dismissDialog = () => evaluate(page, `(() => {
  const dlg = [...document.querySelectorAll('[role="dialog"], dialog')].find((d) => d.getClientRects().length > 0) ?? null;
  if (dlg === null) return 0;
  const btns = [...dlg.querySelectorAll('button')];
  const primary = btns.find((b) => /继续|开始|知道了|确认|Got it|Continue/i.test(b.textContent));
  (primary ?? btns[btns.length - 1])?.click();
  return 1;
})()`);
const ensureNoDialog = async () => {
  let rounds = 0;
  while (Number(await dismissDialog()) > 0 && rounds < 3) { await sleep(700); rounds += 1; }
};
const shotOf = async (name) => { await ensureNoDialog(); shots.push(name); await screenshot(page, join(SHOTS, name)); };

try {
  // 1) 打包候选 tgz（npm pack --ignore-scripts，产物落 .local/）。
  mkdirSync(join(repo, '.local'), { recursive: true });
  const packRun = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', '.local'], { cwd: repo, encoding: 'utf8', shell: true });
  if (packRun.status !== 0) fail(`npm pack 退出 ${String(packRun.status)}：${packRun.stderr}`);
  const tgzName = (packRun.stdout.match(/dsh-async-tools-[^\s]+\.tgz/g) ?? []).pop();
  if (tgzName === undefined) fail('npm pack 未产出 tgz');
  tgzBase = tgzName;
  log(`repo=${repo} hostVersion=${hostVersion} tgz=${tgzName}`);

  // 2) 官方 CLI 安装（可写前提：--patch 只带模型路由，不带本行 config——设计 §3）。
  home = mkdtempSync(join(tmpdir(), 'dsh-gui-persist-'));
  const install = spawnSync('node', [bin, 'plugin', '--profile', 'web', 'add', join(repo, '.local', tgzName)], {
    cwd: serviceRoot, encoding: 'utf8', timeout: 300_000, env: { ...process.env, DSH_HOME: home }
  });
  if (install.status !== 0) { console.error(install.stdout); console.error(install.stderr); fail('plugin add（基线）退出非 0'); }

  const browserPath = findBrowser();
  if (browserPath === undefined) fail('找不到 Edge/Chrome（GUI 探针需本机浏览器）');

  await startInstance();
  browser = await launch(browserPath);
  await openGui();

  console.log('\n── BP-0 渲染基线（19 值字段＋绑定块，可写实例）──');
  await gotoPluginPage();

  // 取数：值字段排除绑定复选框（ul.ats-preset-list 内），布尔 Switch 身份照 r24
  // 读法（帮助按钮 aria-controls 归属）——绑定复选框 id 同以 plugin-config- 开头，
  // 旧查询会误捞（设计 BP-0b）。
  const reading = await evaluate(page, `(() => {
    const bundleRoot = document.querySelector('[data-plugin-detail="dsh-async-tools"]');
    const section = document.querySelector('[data-plugin-config]');
    const controls = section === null ? [] : [...section.querySelectorAll('input[id^="plugin-config-"], select[id^="plugin-config-"]')]
      .filter((n) => n.closest('ul.ats-preset-list') === null);
    const flagKeys = [];
    const flagWritable = [];
    if (section !== null) {
      for (const hb of section.querySelectorAll('.ats-help-button')) {
        const container = hb.closest('.ats-enum-field');
        const sw = container === null ? null : container.querySelector('button[role="switch"]');
        if (sw !== null) {
          flagKeys.push((hb.getAttribute('aria-controls') || '').replace('plugin-config-', '').replace(/-help$/, ''));
          flagWritable.push(sw.disabled !== true);
        }
      }
    }
    const seconds = [];
    const readoutKeys = [];
    for (const ctl of controls) {
      const described = ctl.getAttribute('aria-describedby') || '';
      const node = described === '' ? null : document.getElementById(described);
      if (node === null) continue;
      const spans = node.querySelectorAll('span.ats-sec-effective');
      if (spans.length === 0) continue;
      readoutKeys.push(ctl.id.slice('plugin-config-'.length));
      seconds.push(spans[0].textContent.trim());
    }
    const rowToggle = [...document.querySelectorAll('button,[role=button]')]
      .find((n) => /^启用组件 dsh-async-tools/.test(n.getAttribute('aria-label') || ''));
    const rowControls = [...document.querySelectorAll('button,[role=button]')]
      .filter((n) => /^配置 /.test(n.getAttribute('aria-label') || ''))
      .filter((n) => (n.getAttribute('aria-label') || '').includes('dsh-async-tools'))
      .filter((n) => section === null || !section.contains(n));
    const keys = [...controls.map((n) => n.id.slice('plugin-config-'.length)), ...flagKeys];
    const writable = [...controls.map((n) => n.disabled !== true && n.readOnly !== true), ...flagWritable];
    return {
      pageKind: bundleRoot !== null ? 'bundle' : (section !== null ? 'row' : 'unknown'),
      sectionPresent: section !== null,
      count: keys.length, fieldCount: keys.length,
      rowsAfterSection: section !== null && rowToggle !== undefined && rowToggle !== null
        ? (section.compareDocumentPosition(rowToggle) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : false,
      rowConfigureControls: rowControls.length,
      keys, writable,
      readouts: seconds, readoutFields: readoutKeys,
      boundCheckboxes: [...document.querySelectorAll('ul.ats-preset-list input[type=checkbox]')].length,
      failed: document.querySelector('[data-plugin-config] .failed') !== null
    };
  })()`);
  const helpReading = await evaluate(page, `(() => {
    const section = document.querySelector('[data-plugin-config]');
    const buttons = section === null ? [] : [...section.querySelectorAll('.ats-help-button')];
    return { helpButtons: buttons.map((b) => ({
      controls: (b.getAttribute('aria-controls') || '').replace('plugin-config-', '').replace(/-help$/, ''),
      type: b.getAttribute('type') || '',
      expanded: b.getAttribute('aria-expanded') === 'true',
      label: b.getAttribute('aria-label') || ''
    })) };
  })()`);
  const placementVerdict = judgePlacement(reading, VALUE_FIELD_KEYS);
  check('BP-0① 设置区在插件页、排在组件行之前、组件行无 configure 控件', placementVerdict.ok, placementVerdict.detail);
  const formVerdict = judgeConfigForm(reading, VALUE_FIELD_KEYS, MS_FIELD_KEYS);
  check(`BP-0②③ 值字段 ${String(VALUE_FIELD_KEYS.length)} 枚逐项在场可写＋毫秒读数两段口径`, formVerdict.ok, formVerdict.detail);
  const helpVerdict = judgeHelpButtons(helpReading, SETTING_FIELD_KEYS);
  check(`BP-0④ 字段帮助按钮 ${String(SETTING_FIELD_KEYS.length)} 枚逐项在场（含 boundPresets）`, helpVerdict.ok, helpVerdict.detail);
  check(`BP-0b 绑定复选框不计入单值字段（绑定块 ${String(reading.boundCheckboxes)} 个复选框、值字段集不含 boundPresets）`,
    reading.keys.includes('boundPresets') === false && reading.count === VALUE_FIELD_KEYS.length,
    `值字段=${reading.keys.join(',')}`);
  const baselineBound = await readBound();
  const baselineRow = await describeRow();
  const DEFAULT_BOUND = baselineRow.value.settings.boundPresets;
  const defaultChecked = baselineBound.checked.filter(([, on]) => on === true).map(([id]) => id);
  check(`BP-0⑤ 绑定块默认态：无覆盖徽标、无恢复默认按钮、生效行含默认 ${String(DEFAULT_BOUND.length)} 项、勾集＝默认`,
    baselineBound.tagPresent === false && baselineBound.resetPresent === false
      && eqSorted(defaultChecked, DEFAULT_BOUND)
      && DEFAULT_BOUND.every((id) => baselineBound.effectiveLine.includes(id)),
    `生效行=${JSON.stringify(baselineBound.effectiveLine)}；勾集=${JSON.stringify(baselineBound.checked)}`);
  snapshotPatch('BP-0 基线');
  await shotOf('bp0-baseline.png');

  // 子集＝默认去尾项＋目录中不在默认内的首项（保持真勾选次序由 React 草稿构造决定，
  // 比较一律按排序后等值——顺序不是判据对象）。
  const catalogOrder = baselineBound.checked.map(([id]) => id);
  // 盲审 a1：BP-0⑤ 补目录全量身份断言——宿主预设目录须含本包两预设＋至少一个
  // 其他预设（默认勾集只是目录的子集，目录本身此前未断言）。
  check('BP-0⑥ 预设目录全量在场：含本包 dsh-async 与 dsh-async-create＋至少一个其他预设',
    catalogOrder.includes('dsh-async') && catalogOrder.includes('dsh-async-create')
      && catalogOrder.some((id) => !DEFAULT_BOUND.includes(id) && id !== 'dsh-async' && id !== 'dsh-async-create'),
    `目录=${JSON.stringify(catalogOrder)}`);
  const outsider = catalogOrder.find((id) => !DEFAULT_BOUND.includes(id));
  const SUBSET = [...DEFAULT_BOUND.slice(0, -1), ...(outsider !== undefined ? [outsider] : [])].filter((v, i, a) => a.indexOf(v) === i);
  if (SUBSET.length === 0) fail(`子集构造失败（默认=${JSON.stringify(DEFAULT_BOUND)} 目录=${JSON.stringify(catalogOrder)}）`);

  console.log('\n── BP-1 保存子集（GUI 勾选＋保存按钮）──');
  const preMark = await injectNoReloadMark();
  const actedIds = await setChecks(SUBSET);
  const saveClick1 = await save();
  const afterSave1 = await waitForOutcome();
  const postMark = await readNoReloadMark();
  const row1 = await describeRow();
  const patch1 = snapshotPatch('BP-1 子集');
  const checkedNow1 = afterSave1.checked.filter(([, on]) => on === true).map(([id]) => id);
  // 盲审 c1：'dsh-async' ⊂ 'dsh-async-create'——子串断言换序即假红，改为对生效
  // 行精确解析 id 后比集合（从默认去掉的那一项不得在场）。
  const removedId = DEFAULT_BOUND[DEFAULT_BOUND.length - 1];
  const effectiveIds1 = (afterSave1.effectiveLine.match(/[A-Za-z0-9_-]+/g) ?? []);
  check('BP-1① 生效名单行就地刷新为子集（HMR 无整页重载——窗口标记在、navigation 计数未增）',
    SUBSET.every((id) => effectiveIds1.includes(id)) && !effectiveIds1.includes(removedId)
      && postMark.mark === preMark.mark && postMark.nav === preMark.nav,
    `生效行解析=${JSON.stringify(effectiveIds1)}（去项=${removedId}）；标记 pre=${JSON.stringify(preMark)} post=${JSON.stringify(postMark)}；save=${saveClick1}；动作=${JSON.stringify(actedIds)}`);
  check('BP-1② 覆盖徽标＋恢复默认按钮在场、勾集＝子集',
    afterSave1.tagPresent === true && afterSave1.resetPresent === true && eqSorted(checkedNow1, SUBSET),
    `勾集=${JSON.stringify(afterSave1.checked)}`);
  check('BP-1③ RPC user=value=子集、落盘含子集块',
    eqSorted(row1.user?.settings?.boundPresets, SUBSET) && eqSorted(row1.value.settings.boundPresets, SUBSET)
      && patch1.includes('boundPresets'),
    `user=${JSON.stringify(row1.user?.settings?.boundPresets)}；value=${JSON.stringify(row1.value.settings.boundPresets)}`);
  await shotOf('bp1-subset.png');

  console.log('\n── BP-2 刷新回读 ──');
  await openGui();
  await gotoPluginPage();
  const reloadBound = await readBound();
  const reloadRow = await describeRow();
  const reloadChecked = reloadBound.checked.filter(([, on]) => on === true).map(([id]) => id);
  check('BP-2 新开页面回读：勾集／生效行／覆盖徽标与保存值一致',
    eqSorted(reloadChecked, SUBSET)
      && SUBSET.every((id) => reloadBound.effectiveLine.includes(id)) && reloadBound.tagPresent === true
      && eqSorted(reloadRow.user?.settings?.boundPresets, SUBSET),
    `生效行=${JSON.stringify(reloadBound.effectiveLine)}；勾集=${JSON.stringify(reloadBound.checked)}`);
  await shotOf('bp2-reload.png');

  console.log('\n── BP-3 空名单（显式 []，与 unset 区分）──');
  await setChecks([]);
  const emptySave = await readBound();
  const saveClick3 = await save();
  const afterSave3 = await waitForOutcome();
  const row3 = await describeRow();
  const patch3 = snapshotPatch('BP-3 空名单');
  check('BP-3① 空勾集合法：保存按钮仍可用（非非法草稿）',
    emptySave.saveEnabled === true && saveClick3 === 'clicked',
    `保存前按钮可用=${String(emptySave.saveEnabled)}`);
  check('BP-3② 生效行＝「当前未绑定任何预设」、覆盖徽标在场、零勾选',
    /当前未绑定任何预设|No presets are currently bound/.test(afterSave3.effectiveLine)
      && afterSave3.tagPresent === true && afterSave3.checked.every(([, on]) => on === false),
    `生效行=${JSON.stringify(afterSave3.effectiveLine)}`);
  check('BP-3③ RPC user=[]、value=[]、落盘空数组形态',
    Array.isArray(row3.user?.settings?.boundPresets) && row3.user.settings.boundPresets.length === 0
      && Array.isArray(row3.value.settings.boundPresets) && row3.value.settings.boundPresets.length === 0
      && /boundPresets:\s*\[\]/.test(patch3),
    `user=${JSON.stringify(row3.user?.settings?.boundPresets)}；patch 片段=${JSON.stringify(patch3.split('\n').filter((l) => l.includes('boundPresets')).join(' | '))}`);
  await shotOf('bp3-empty.png');

  console.log('\n── BP-4 恢复默认 unset ──');
  const resetClick = await clickResetField();
  const staged = await readBound();
  const stagedChecked = staged.checked.filter(([, on]) => on === true).map(([id]) => id);
  // 前态接 BP-3 终局：上一保存值＝空名单。暂存期断言＝草稿回默认勾而生效行
  // 仍显示上一保存值（「未保存不冒称」由生效值行承担——BP-4① 的核心）。
  check('BP-4① 恢复默认只暂存：草稿回默认勾、生效行仍为上一保存值（BP-3 空名单）；徽标与恢复默认按钮是草稿级标记、随草稿退场',
    resetClick === 'clicked' && eqSorted(stagedChecked, DEFAULT_BOUND)
      && /当前未绑定任何预设|No presets are currently bound/.test(staged.effectiveLine)
      && staged.tagPresent === false && staged.resetPresent === false,
    `暂存勾集=${JSON.stringify(staged.checked)}；生效行=${JSON.stringify(staged.effectiveLine.split('\\n').at(-1))}；徽标=${String(staged.tagPresent)}`);
  await shotOf('bp4-staged.png');
  const saveClick4 = await save();
  const afterSave4 = await waitForOutcome();
  const row4 = await describeRow();
  const patch4 = snapshotPatch('BP-4 unset');
  const unsetChecked = afterSave4.checked.filter(([, on]) => on === true).map(([id]) => id);
  check('BP-4② 保存后 unset：勾集＝默认、生效行回默认名单',
    eqSorted(unsetChecked, DEFAULT_BOUND)
      && DEFAULT_BOUND.every((id) => afterSave4.effectiveLine.includes(id)),
    `勾集=${JSON.stringify(afterSave4.checked)}；save=${saveClick4}`);
  check('BP-4③ RPC user 键缺席、value 回默认；patch 的 boundPresets 键消失（宿主只删等值键，settings 可留空壳对象行——留痕非覆盖）',
    row4.user?.settings?.boundPresets === undefined
      && eqSorted(row4.value.settings.boundPresets, DEFAULT_BOUND)
      && !patch4.includes('boundPresets'),
    `user.settings=${JSON.stringify(row4.user?.settings)}；patch 片段=${JSON.stringify(patch4.split('\\n').filter((l) => l.includes('async-tools-host') || l.includes('settings')).join(' | '))}`);
  await shotOf('bp4-unset.png');

  console.log('\n── BP-5 unset 与他字段覆盖并存（按键 unset 不清整段）──');
  const setLang = await setSelect('agentLang', 'zh');
  const saveClick5a = await save();
  await waitForOutcome();
  const row5a = await describeRow();
  check('BP-5① 前置：GUI 另存 agentLang=zh 覆盖',
    setLang === 'set' && saveClick5a === 'clicked' && row5a.user?.settings?.agentLang === 'zh',
    `agentLang user=${JSON.stringify(row5a.user?.settings?.agentLang)}`);
  await setChecks(SUBSET);
  await save();
  await waitForOutcome();
  const resetClick5 = await clickResetField();
  const saveClick5b = await save();
  const afterSave5 = await waitForOutcome();
  const row5 = await describeRow();
  const patch5 = snapshotPatch('BP-5 并存后 unset');
  check('BP-5② boundPresets 回 unset（GUI 生效行回默认＋user 键缺席）、agentLang 覆盖仍在、行保留',
    resetClick5 === 'clicked' && saveClick5b === 'clicked'
      && DEFAULT_BOUND.every((id) => afterSave5.effectiveLine.includes(id))
      && row5.user?.settings?.boundPresets === undefined
      && row5.user?.settings?.agentLang === 'zh'
      && patch5.includes('async-tools-host') && patch5.includes('agentLang') && !patch5.includes('boundPresets'),
    `user.settings=${JSON.stringify(row5.user?.settings)}`);
  await shotOf('bp5-coexist.png');

  const stateBeforeRestart = { bound: await readBound(), userSettings: row5.user?.settings, valueBound: row5.value.settings.boundPresets, patch: patchText() };

  console.log('\n── BP-6 实例重启持久化 ──');
  stopInstance();
  await startInstance();
  await openGui();
  await gotoPluginPage();
  const bound6 = await readBound();
  const row6 = await describeRow();
  const patch6 = snapshotPatch('BP-6 重启后');
  check('BP-6 重启后三侧与重启前一致（boundPresets unset＋agentLang 覆盖并存形态保留）',
    JSON.stringify(bound6.checked) === JSON.stringify(stateBeforeRestart.bound.checked)
      && bound6.tagPresent === stateBeforeRestart.bound.tagPresent
      && JSON.stringify(row6.user?.settings) === JSON.stringify(stateBeforeRestart.userSettings)
      && eqSorted(row6.value.settings.boundPresets, stateBeforeRestart.valueBound)
      && patch6 === stateBeforeRestart.patch,
    `user.settings=${JSON.stringify(row6.user?.settings)}；勾集=${JSON.stringify(bound6.checked)}`);
  await shotOf('bp6-after-restart.png');

  console.log('\n── BP-7 同名重装保留 ──');
  const versionBefore = bound6.version;
  stopInstance();
  const reinstall = spawnSync('node', [bin, 'plugin', '--profile', 'web', 'add', join(repo, '.local', tgzName)], {
    cwd: serviceRoot, encoding: 'utf8', timeout: 300_000, env: { ...process.env, DSH_HOME: home }
  });
  if (reinstall.status !== 0) { console.error(reinstall.stdout); console.error(reinstall.stderr); fail('plugin add（同名重装）退出非 0'); }
  await startInstance();
  await openGui();
  await gotoPluginPage();
  const bound7 = await readBound();
  const row7 = await describeRow();
  const patch7 = snapshotPatch('BP-7 重装后');
  check('BP-7 重装后三侧一致＋版本显示不变',
    JSON.stringify(bound7.checked) === JSON.stringify(stateBeforeRestart.bound.checked)
      && bound7.tagPresent === stateBeforeRestart.bound.tagPresent
      && JSON.stringify(row7.user?.settings) === JSON.stringify(stateBeforeRestart.userSettings)
      && patch7 === stateBeforeRestart.patch
      && (versionBefore === '' || bound7.version === versionBefore),
    `版本=${JSON.stringify(bound7.version)}（前=${JSON.stringify(versionBefore)}）；user.settings=${JSON.stringify(row7.user?.settings)}`);
  await shotOf('bp7-after-reinstall.png');

  console.log('\n── BP-8 换版本号升级保留 ──');
  // 升级 fixture：解包基线 tgz→版本号提一位→重打包（文件集与基线同源，只有
  // package.json 版本不同——「同名行 id、新版本号包、覆盖安装」）。与真实升级的
  // 差距（同 schema 无迁移路径、无注册表版本跨度）按设计 §6 如实登记，不冒称。
  const bumpDir = mkdtempSync(join(tmpdir(), 'dsh-gui-persist-upgrade-'));
  bumpDirNow = bumpDir;
  const extractDir = join(bumpDir, 'pkg');
  mkdirSync(extractDir, { recursive: true });
  const tarRun = spawnSync('tar', ['-xzf', join(repo, '.local', tgzName), '-C', extractDir], { encoding: 'utf8' });
  if (tarRun.status !== 0) fail(`解包基线 tgz 失败：${tarRun.stderr}`);
  const pkgPath = join(extractDir, 'package');
  const pkgJson = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8'));
  const [base, suffix] = String(pkgJson.version).split('+');
  const parts = base.split('.');
  parts[2] = String(Number.parseInt(parts[2], 10) + 1);
  pkgJson.version = suffix === undefined ? parts.join('.') : `${parts.join('.')}+${suffix}`;
  writeFileSync(join(pkgPath, 'package.json'), JSON.stringify(pkgJson, null, 2));
  const packUp = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', bumpDir], { cwd: pkgPath, encoding: 'utf8', shell: true });
  if (packUp.status !== 0) fail(`升级 tgz 打包失败：${packUp.stderr}`);
  const upTgzName = (packUp.stdout.match(/dsh-async-tools-[^\s]+\.tgz/g) ?? []).pop();
  if (upTgzName === undefined) fail('升级打包未产出 tgz');
  const upVersion = pkgJson.version;
  log(`升级 tgz=${upTgzName}（版本 ${upVersion}）`);
  stopInstance();
  const upgrade = spawnSync('node', [bin, 'plugin', '--profile', 'web', 'add', join(bumpDir, upTgzName)], {
    cwd: serviceRoot, encoding: 'utf8', timeout: 300_000, env: { ...process.env, DSH_HOME: home }
  });
  if (upgrade.status !== 0) { console.error(upgrade.stdout); console.error(upgrade.stderr); fail('plugin add（升级）退出非 0'); }
  await startInstance();
  await openGui();
  await gotoPluginPage();
  const bound8 = await readBound();
  const row8 = await describeRow();
  const patch8 = snapshotPatch('BP-8 升级后');
  check('BP-8 升级后三侧一致＋GUI 显示新版本号',
    JSON.stringify(bound8.checked) === JSON.stringify(stateBeforeRestart.bound.checked)
      && bound8.tagPresent === stateBeforeRestart.bound.tagPresent
      && JSON.stringify(row8.user?.settings) === JSON.stringify(stateBeforeRestart.userSettings)
      && patch8 === stateBeforeRestart.patch
      && (bound8.version.includes(upVersion)),
    `版本=${JSON.stringify(bound8.version)}（期望含 ${upVersion}）；user.settings=${JSON.stringify(row8.user?.settings)}`);
  await shotOf('bp8-after-upgrade.png');
  try { rmSync(bumpDir, { recursive: true, force: true }); } catch { /* 占用中 */ }

  console.log('\n── BP-9 收尾复原 ──');
  // agentLang 复原走它自己的「恢复默认」按钮（resetField→unset 路径）。不能写回
  // 字面默认值：继承层本无该键，显式写 'en' 会成为用户覆盖（首跑实测——这正是
  // unset 与显式指定的区别，describe 的 user 子树是判别器）。
  const setLangBack = await evaluate(page, `(() => {
    const input = document.querySelector('#plugin-config-agentLang');
    if (input === null) return 'no-input';
    const field = input.closest('.ats-enum-field');
    const btn = field === null ? null
      : [...field.querySelectorAll('button.ats-enum-reset')]
        .find((b) => /^(恢复默认|Reset)$/.test(b.textContent.trim())) ?? null;
    if (btn === null) return 'missing:恢复默认（agentLang）';
    btn.click();
    return 'clicked';
  })()`);
  const saveClick9 = await save();
  await waitForOutcome();
  const row9 = await describeRow();
  const patch9 = snapshotPatch('BP-9 终态');
  check('BP-9 全部装置写入已 unset（agentLang 走其恢复默认按钮）：user.settings 全空、patch 无 boundPresets/agentLang 键（settings 空壳行＝宿主行为，留痕非覆盖）',
    setLangBack === 'clicked' && saveClick9 === 'clicked'
      && Object.keys(row9.user?.settings ?? {}).length === 0
      && !patch9.includes('boundPresets') && !patch9.includes('agentLang'),
    `user.settings=${JSON.stringify(row9.user?.settings)}；patch 片段=${JSON.stringify(patch9.split('\\n').filter((l) => l.includes('async-tools-host') || l.includes('settings')).join(' | '))}`);
} catch (error) {
  cleanup();
  fail(`未预期异常：${String(error?.stack ?? error)}`);
}
cleanup();

// 证据落盘。
let head = '';
try { head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(); } catch { /* 非 git 环境 */ }
const evidence = { at: new Date().toISOString(), repo, head, hostVersion, tgzBase, failed, checks: results, shots };
writeFileSync(join(LOGS, 'gui-persist.json'), JSON.stringify(evidence, null, 2));
log(`证据落盘：${join(LOGS, 'gui-persist.json')}（截图 ${String(shots.length)} 张在 shots/）`);
console.log(`\n判定：${failed === 0 ? '全部通过' : `存在 FAIL（${String(failed)} 项）`}`);
process.exit(failed === 0 ? 0 : 1);
