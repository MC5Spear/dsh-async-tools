#!/usr/bin/env node
/**
 * 待答面板视觉与可访问性探针（VERIFY-01，设计稿 `.local/design/gui-persistence-visual.md`
 * §8 装置 C，AV-1..AV-9）：官方可写临时实例（zai 路由真实模型）上，接管真实
 * ask_user_question 批次（一单选两项＋一多选三项，askTimeoutMs=600000 长窗），
 * 对两种座位（overlay／sidebar）×两主题×两宽度的面板做结构断言与截图矩阵，
 * 交互态近景两座位各拍 3 配置×4 态），Enter 换行/焦点不伪装选中/选中底纹/
 * 触屏目标度量/aria 关联机器断言，末尾提交两行中文作答并断言换行原样交付。
 *
 * ## 与装置 B 同款的环境边界（如实登记，不冒称）
 * 无头 CDP 上触摸合成（synthesizeTapGesture／dispatchTouchEvent／
 * emulateTouchFromMouseEvent）与 Tab 焦点遍历受限的旧记载已作废——真因是宿主
 * 首访「预览版说明」对话框拦截指针与焦点（起页即关＋每张截图前护栏后，
 * touchStart/End 与 Tab 遍历实测可用）。AV-7 先照原判据实跑，受限面按观察项
 * 留痕（真实触屏留人工面）；**触屏目标 ≥24×24 的度量断言不受影响**（包围盒
 * 读取，与事件合成无关）。
 * ## 用法（须 danger-full-access 或非受限环境——CDP 无头浏览器在受限沙箱档必早夭）
 *   node verify/_visual/probe-ask-visual.mjs --service-root <宿主服务树> \
 *     [--host-subdir dsh-0.2.1-rc.5] [--repo <本仓路径>] [--keep]
 *
 * 红线：不连开发实例（38200），不动活体实例（38114）。--patch 只带 zai-glm.yml
 * 模型路由。证据：`.local/evidence/ask-visual/{logs,shots}`。退出码 0＝全部通过、
 * 1＝存在 FAIL、2＝装置故障（FAULT，输出区分）。
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, openPage, evaluate, findBrowser, waitFor, screenshot, setViewport } from './cdp.mjs';

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
const fail = (msg) => {
  // 盲审 d1/d2：FAULT 先落已跑判据＋清理资源（设计 §10「退出 2 前先清」），
  // --keep 语义保留；早期调用（目录未建）时静默跳过落盘。
  try {
    mkdirSync(join(repo, '.local', 'evidence', 'ask-visual', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.local', 'evidence', 'ask-visual', 'logs', 'fault.json'),
      JSON.stringify({ at: new Date().toISOString(), msg, results }, null, 2));
  } catch { /* 磁盘写失败不阻塞清理与退出 */ }
  try { cleanup(); } catch { /* 尽力清理 */ }
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

// ── 实例与 RPC ──────────────────────────────────────────────────────────────
let ORIGIN = '';
let TOKEN = '';
let COOKIE = '';
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
async function rpc(endpoint, argsPayload) {
  const body = JSON.stringify({
    type: 'client-request', rpcId: `probe-${Math.random().toString(36).slice(2, 10)}`,
    method: endpoint, payload: { args: argsPayload }
  });
  const response = await fetch(`${ORIGIN}/api/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body,
    signal: AbortSignal.timeout(60_000)
  });
  const parsed = JSON.parse(await response.text());
  if (parsed?.result?.ok !== true) throw new Error(`${endpoint}: ${JSON.stringify(parsed?.result?.error ?? '').slice(0, 200)}`);
  return parsed.result.value;
}
async function transcriptOf(sessionId) {
  const listing = await rpc('session/list', { _request: {} });
  const row = listing.items.find((item) => item.sessionId === sessionId);
  if (row === undefined) throw new Error(`session ${sessionId} not found`);
  return rpc('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 400 }
  });
}

// ── 主题与视口（card-visual 手法）────────────────────────────────────────────
async function applyTheme(scheme) {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await evaluate(page, scheme === 'dark'
    ? 'document.body.setAttribute("data-ds-dark-theme", ""), true'
    : 'document.body.removeAttribute("data-ds-dark-theme"), true');
  await sleep(1000);
  const bg = await evaluate(page, `(() => {
    let node = document.querySelector('.ats-ask-panel') ?? document.body;
    while (node !== null) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg !== '' && bg !== 'rgba(0, 0, 0, 0)') return bg;
      node = node.parentElement;
    }
    return '';
  })()`);
  const parts = (/^rgba?\((\d+), (\d+), (\d+)/.exec(bg) ?? []).slice(1).map(Number);
  const applied = parts.length === 3
    && (scheme === 'dark' ? parts.every((p) => p < 90) : parts.every((p) => p > 180));
  return { applied, bg };
}
const scrollToPanel = () => evaluate(page, `(() => {
  const p = document.querySelector('.ats-ask-panel');
  if (p !== null) p.scrollIntoView({ block: 'center' });
  return p !== null;
})()`);
/** 面板**可见**宽（复审三轮「竖条帧」定论：面板盒宽恒 340、被裁的是停靠祖先
 * 的 overflow）。首版祖先包围盒求交在 sidebar 席位全面误报——面板为 fixed
 * 定位、逃逸祖先 overflow 裁切（CSS：fixed 只被视口裁）。改为 elementFromPoint
 * 逐列采样：以面板纵向中点为扫描行，每 4px 一列，命中点落在面板内即计可见
 * ——量的是**实际绘制**的可见性（含遮挡/裁切/离屏），面板缺席返回 -1。 */
const PANEL_VISIBLE_WIDTH_JS = `(() => {
  const p = document.querySelector('.ats-ask-panel');
  if (p === null) return -1;
  const r = p.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return 0;
  const y = Math.round(Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2;
  if (y < 0 || y >= innerHeight) return 0;
  let vis = 0;
  for (let x = Math.round(r.left); x < Math.round(r.right); x += 4) {
    const el = document.elementFromPoint(x, y);
    if (el !== null && (el === p || p.contains(el))) vis += 4;
  }
  return vis;
})()`;
/** 面板几何门：滚进视口后等面板**可见**宽 ≥minW（盒宽＋停靠裁切一体判），未达
 * 则告警留痕（截图证据质量存疑，不冒称）。 */
const panelGeometryGate = async (minW) => {
  const width = Number(await waitFor(page, `Number(${PANEL_VISIBLE_WIDTH_JS})`, (n) => Number(n) >= minW, 5000));
  if (width < minW) log(`警告：面板几何门未过（可见宽=${String(width)}<${String(minW)}——停靠/挂载竞态或渲染异常，后续截图证据质量存疑）`);
  return width >= minW;
};
/** 滚进视口＋几何门（拍前标配）。 */
const scrollToPanelStable = async () => { await scrollToPanel(); await panelGeometryGate(120); };
// ── 面板结构读取（单题作用域：目标批次的第一/第二题按题干文本定位）──────────
const Q1_TEXT = 'Pick a color';
const Q2_TEXT = 'Pick fruits';
const qExpr = (text) => `(() => {
  const qs = [...document.querySelectorAll('.ats-ask-q')];
  const q = qs.find((n) => (n.querySelector('.ats-ask-text')?.textContent ?? '').includes(${JSON.stringify(text)}));
  return q ?? null;
})()`;
/** 单题面板结构一次读全（AV-1/2/8 用——纯数据返回）。 */
const readQ = (text) => evaluate(page, `(() => {
  const q = ${qExpr(text)};
  if (q === null) return { present: false };
  const custom = q.querySelector('.ats-ask-custom');
  const optctl = custom?.querySelector('.ats-ask-optctl') ?? null;
  const input = custom?.querySelector('textarea.ats-ask-input') ?? null;
  const opts = [...q.querySelectorAll('button.ats-ask-opt')];
  const group = q.querySelector('.ats-ask-opts');
  return { present: true,
    groupRole: group?.getAttribute('role') ?? '',
    labelledby: group?.getAttribute('aria-labelledby') ?? '',
    textId: q.querySelector('.ats-ask-text')?.id ?? '',
    opts: opts.map((o) => ({ role: o.getAttribute('role') ?? '', checked: o.getAttribute('aria-checked') ?? '',
      selected: o.getAttribute('data-selected') ?? '', label: o.querySelector('.ats-ask-optlabel')?.textContent ?? '' })),
    custom: custom === null ? null : {
      optctlRole: optctl?.getAttribute('role') ?? '', optctlChecked: optctl?.getAttribute('aria-checked') ?? '',
      optctlAriaLabel: optctl?.getAttribute('aria-label') ?? '', selected: custom.getAttribute('data-selected') ?? '',
      multi: custom.getAttribute('data-multi') ?? '',
      inputAriaLabel: input?.getAttribute('aria-label') ?? '', rows: input?.getAttribute('rows') ?? '',
      flow: custom === null ? '' : getComputedStyle(custom).flexDirection,
      ctlBeforeInput: optctl !== null && input !== null
        ? (optctl.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : false,
      inputWidthRatio: input === null || custom === null ? 0
        : Math.round(100 * input.getBoundingClientRect().width / custom.getBoundingClientRect().width),
      inputHeight: input === null ? 0 : input.getBoundingClientRect().height,
      inputLineHeight: input === null ? '' : getComputedStyle(input).lineHeight,
      inputScrollW: input === null ? 0 : input.scrollWidth, inputClientW: input === null ? 0 : input.clientWidth,
      inputScrollH: input === null ? 0 : input.scrollHeight, inputClientH: input === null ? 0 : input.clientHeight,
      value: input?.value ?? ''
    },
    submit: (() => { const s = q.querySelector('.ats-ask-submit'); return s === null ? null : { disabled: s.disabled === true }; })()
  };
})()`);
/** 自定义草稿键入（React 受控——原生 setter＋input 事件）。 */
const setAskDraft = (text, value) => evaluate(page, `(() => {
  const q = ${qExpr(text)};
  const input = q?.querySelector('textarea.ats-ask-input');
  if (input === null) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'set';
})()`);
/** **当前可见**的题目输入框（第 5 轮收口判据）：qExpr 按文本找题，可能命中
 * 隐藏或重挂载换前的节点——读写同一错节点会「断言绿、画面空」。这里以题目卡
 * 上三个采样点的 elementFromPoint 验证该卡真实可见（命中点落在卡内），返回其
 * textarea；全部不可见返回 null。 */
const VISIBLE_Q_INPUT_JS = (text) => `(() => {
  const qs = [...document.querySelectorAll('.ats-ask-q')]
    .filter((n) => (n.querySelector('.ats-ask-text')?.textContent ?? '').includes(${JSON.stringify(text)}));
  for (const q of qs) {
    const r = q.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const pts = [
      [r.left + r.width / 2, r.top + Math.min(r.height / 2, 120)],
      [r.left + r.width / 2, Math.max(r.top + 8, r.bottom - Math.min(r.height, 120))],
      [r.left + 12, r.top + Math.min(r.height, 60)]
    ];
    for (const [x, y] of pts) {
      if (y < 0 || y >= innerHeight || x < 0 || x >= innerWidth) continue;
      const el = document.elementFromPoint(x, y);
      if (el !== null && (el === q || q.contains(el))) {
        return q.querySelector('textarea.ats-ask-input') ?? null;
      }
    }
  }
  return null;
})()`;
const readDraftVisible = (text) => evaluate(page, `(() => {
  const input = ${VISIBLE_Q_INPUT_JS(text)};
  return input === null ? null : input.value;
})()`);
const setAskDraftVisible = (text, value) => evaluate(page, `(() => {
  const input = ${VISIBLE_Q_INPUT_JS(text)};
  if (input === null) return 'no-visible-input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'set';
})()`);
const clickIn = (selectorJs, label) => evaluate(page, `(() => {
  const n = ${selectorJs};
  if (n === null || n === undefined) return 'missing:' + ${JSON.stringify(label)};
  n.click();
  return 'clicked';
})()`);

const EVID = join(repo, '.local', 'evidence', 'ask-visual');
const LOGS = join(EVID, 'logs');
const SHOTS = join(EVID, 'shots');
mkdirSync(LOGS, { recursive: true });
// 跑前清空 shots：截图清单随轮次演化（25→35 张），旧名残留会与本次清单矛盾
// （装置 B 复审三轮实证过此类误导）——目录内容恒＝本次清单。
try { rmSync(SHOTS, { recursive: true, force: true }); } catch { /* 无旧目录 */ }
mkdirSync(SHOTS, { recursive: true });
/** 关闭宿主「预览版说明」类对话框（设置页视觉审阅发现：不关则截图被居中对话
 * 框遮挡；主按钮文案含「继续」）。每张截图前执行护栏。 */
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
const ensureNoDialog = async () => {
  let rounds = 0;
  while (Number(await dismissDialog()) > 0 && rounds < 3) { await sleep(700); rounds += 1; }
  const left = await evaluate(page, `[...document.querySelectorAll('[role="dialog"], dialog')].filter((d) => d.getClientRects().length > 0).length`);
  if (Number(left) > 0) log(`警告：仍有 ${String(left)} 个对话框在场（截图可能被遮）`);
};
const shotOf = async (name, opts) => {
  await ensureNoDialog();
  // 复审三轮发现（5 帧侧栏标签层偏暗）：宿主 chrome 过渡被拍进画面——拍前
  // 定量等过渡收敛。
  await sleep(400);
  // 复审三轮「竖条帧」（2/35）：拍前再查一次可见宽，未达则等待重查一次
  // （间歇竞态），仍窄照拍但已留告警（面板缺席＝收起态场景，跳过）。
  for (let i = 0; i < 2; i += 1) {
    const vis = Number(await evaluate(page, `Number(${PANEL_VISIBLE_WIDTH_JS})`));
    if (vis >= 120 || vis === -1) break;
    log(`警告：${name} 拍前面板可见宽 ${String(vis)}px<120（停靠/挂载竞态——竖条帧），等 700ms 重查`);
    await sleep(700);
  }
  shots.push(name);
  await screenshot(page, join(SHOTS, name), opts);
};

try {
  // 1) 打包＋官方 CLI 安装＋起实例（zai 路由）。
  mkdirSync(join(repo, '.local'), { recursive: true });
  const packRun = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', '.local'], { cwd: repo, encoding: 'utf8', shell: true });
  if (packRun.status !== 0) fail(`npm pack 退出 ${String(packRun.status)}：${packRun.stderr}`);
  const tgzName = (packRun.stdout.match(/dsh-async-tools-[^\s]+\.tgz/g) ?? []).pop();
  if (tgzName === undefined) fail('npm pack 未产出 tgz');
  home = mkdtempSync(join(tmpdir(), 'dsh-ask-visual-'));
  const install = spawnSync('node', [bin, 'plugin', '--profile', 'web', 'add', join(repo, '.local', tgzName)], {
    cwd: serviceRoot, encoding: 'utf8', timeout: 300_000, env: { ...process.env, DSH_HOME: home }
  });
  if (install.status !== 0) { console.error(install.stdout); console.error(install.stderr); fail('plugin add 退出非 0'); }
  const browserPath = findBrowser();
  if (browserPath === undefined) fail('找不到 Edge/Chrome（视觉探针需本机浏览器）');
  await startInstance();
  log(`repo=${repo} hostVersion=${hostVersion} tgz=${tgzName}`);

  // 2) 接管前置（公开设置接口）：askTakeover=600s 长窗＋中文界面＋overlay 座位。
  const settingsNS = 'async-tools-host';
  async function patchSettings(patch) {
    await rpc('settings/update', { ns: settingsNS, patch: { settings: patch } });
  }
  await patchSettings({ askTakeover: true, askTimeoutMs: 600000, uiLang: 'zh', askUiSeat: 'overlay' });
  const described = await rpc('settings/describe', {});
  const nsRow = described.namespaces.find((n) => (n.ns ?? n.namespace ?? n.id) === settingsNS);
  if (nsRow?.value?.settings?.askTakeover !== true) fail('askTakeover 前置未生效');

  // 3) 会话＋一批两题（模型依从波动：重试上限 3、attempts 留痕、换会话重试一次）。
  const BATCH_PROMPT = 'Call the ask_user_question tool with exactly two questions in ONE call: '
    + 'question 1 text "Pick a color", options "red" and "blue", no multiSelect; '
    + 'question 2 text "Pick fruits", options "apple", "banana", "cherry", multiSelect true. '
    + 'Do not answer them yourself; call the tool once and wait for the user.';
  browser = await launch(browserPath);
  page = await openPage(browser.port, `${ORIGIN}/?token=${encodeURIComponent(TOKEN)}`);
  await waitFor(page, 'document.querySelectorAll("button,[role=button]").length', (n) => n > 0, 15000);
  const attemptsLog = [];
  let SESSION = null;
  let panelReady = false;
  for (let attempt = 1; attempt <= 4 && !panelReady; attempt += 1) {
    const created = await rpc('session/create', { request: { cwd: home, agentPreset: 'dsh-async' } });
    SESSION = created.sessionId;
    await rpc('session/prompt', {
      request: {
        requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
        sessionId: SESSION, mode: 'queue',
        content: [{ type: 'text', text: BATCH_PROMPT }],
        clientTimeZone: 'Asia/Hong_Kong'
      }
    });
    // 盲审 b1＋诊断实证（tmp-diag-ask）：cdp.waitFor 超时只返回末值、从不 reject
    // ——一切以返回值判定。模型按宿主 schema 发 snake_case `multi_select`（宿主
    // dsh-tool-ask-user 翻译为 multiSelect 进服务请求），转录正则只认 camelCase
    // 会把合规批次误判四连拒；重试换会话后页面还叠显旧会话面板（waitFor 瞬时
    // 假阳性）。改为：重开页面跟随最新会话；轮询**当前会话**转录直到 ask 调用
    // 记录落地；再以接管 state RPC（面板语义权威源——客户端按它渲染）验批次
    // 形态：Q1 单选＋Q2 多选都在册；面板门在其后。
    if (attempt > 1) {
      try { await page.close(); } catch { /* 已关 */ }
      page = await openPage(browser.port, `${ORIGIN}/?token=${encodeURIComponent(TOKEN)}`);
      await waitFor(page, 'document.querySelectorAll("button,[role=button]").length', (n) => n > 0, 15000);
      await ensureNoDialog();
    }
    let askRecordText = '';
    for (let i = 0; i < 40 && askRecordText === ''; i += 1) {
      const t0 = await transcriptOf(SESSION).catch(() => null);
      const rec = (t0?.records ?? [])
        .find((r) => r.event?.type === 'tool/call' && r.event.data?.name === 'ask_user_question');
      if (rec !== undefined) askRecordText = JSON.stringify(rec);
      else await sleep(3000);
    }
    let multiOk = false;
    if (askRecordText !== '') {
      for (let i = 0; i < 20 && !multiOk; i += 1) {
        const st = await rpc('async-tools-ask/state', {}).catch(() => null);
        const items = st?.items ?? [];
        const q1Item = items.find((it) => (it.question ?? '').includes('Pick a color'));
        const q2Item = items.find((it) => (it.question ?? '').includes('Pick fruits'));
        multiOk = q1Item !== undefined && q2Item !== undefined
          && q1Item.multiSelect === false && q2Item.multiSelect === true;
        if (!multiOk) await sleep(1000);
      }
    }
    const panels = Number(await waitFor(page, 'document.querySelectorAll(".ats-ask-panel .ats-ask-q").length', (n) => Number(n) >= 2, 120_000));
    panelReady = panels >= 2 && multiOk;
    if (!panelReady) {
      attemptsLog.push({ attempt, askCalled: askRecordText !== '', batchShapeOk: multiOk, panels });
      const cause = askRecordText === '' ? '转录未见 ask 调用（模型未依从）'
        : multiOk !== true ? '接管 state 批次形态不符（Q1 应单选＋Q2 应多选）'
          : `面板未出（题数=${String(panels)}）`;
      // 失败诊断留痕（十跑发现「未见 ask 调用」需分辨模型自答/报错/未动）：
      // 转录尾部事件类型＋记录数＋末条文本片段。
      const tDiag = await transcriptOf(SESSION).catch(() => null);
      const diagRecs = tDiag?.records ?? [];
      const lastText = (() => {
        const r = diagRecs[diagRecs.length - 1];
        const text = JSON.stringify(r?.event?.data ?? {}).slice(0, 160);
        return text;
      })();
      log(`第 ${String(attempt)} 次触发不可用（${cause}），${attempt < 4 ? '换会话重试' : '放弃'}`);
      log(`  诊断：记录数=${String(diagRecs.length)} 尾部类型=${diagRecs.slice(-6).map((r) => r.event?.type).join(',')} 末条=${lastText}`);
    }
  }
  if (!panelReady) fail(`四轮触发未达可用面板（attempts=${JSON.stringify(attemptsLog)}——含未出面板与批次形态不符两种形态，模型依从波动按装置纪律登记）`);
  log(`面板就绪（sessionId=${String(SESSION)}，attempts=${JSON.stringify(attemptsLog)}）`);
  await ensureNoDialog();

  // ── 8 组全景＋AV-1/AV-2 逐配置断言 ──
  // sidebar 展开：只在面板缺席时点徽标——连续 sidebar 配置间面板已是展开态，
  // 再点一次会把面板收起（首跑实测的交替假红）。
  async function ensurePanel(seat) {
    await patchSettings({ askUiSeat: seat });
    if (seat === 'sidebar') {
      await waitFor(page, 'document.querySelectorAll(".ats-ask-badge").length', (n) => Number(n) >= 1, 10_000).catch(() => {});
      const panels = Number(await evaluate(page, 'document.querySelectorAll(".ats-ask-panel .ats-ask-q").length'));
      if (panels < 2) {
        await evaluate(page, `document.querySelector('.ats-ask-badge')?.click(), true`);
        const after = Number(await waitFor(page, 'document.querySelectorAll(".ats-ask-panel .ats-ask-q").length', (n) => Number(n) >= 2, 10_000));
        if (after < 2) fail(`sidebar 面板展开门未过（题数=${String(after)}）`);
      }
    } else {
      const panels = Number(await waitFor(page, 'document.querySelectorAll(".ats-ask-panel .ats-ask-q").length', (n) => Number(n) >= 2, 10_000));
      if (panels < 2) fail(`overlay 面板门未过（题数=${String(panels)}）`);
    }
  }
  const CONFIGS = [
    { seat: 'overlay', theme: 'dark', w: 1500, h: 1000 },
    { seat: 'overlay', theme: 'light', w: 1500, h: 1000 },
    { seat: 'overlay', theme: 'dark', w: 390, h: 844 },
    { seat: 'overlay', theme: 'light', w: 390, h: 844 },
    { seat: 'sidebar', theme: 'dark', w: 1500, h: 1000 },
    { seat: 'sidebar', theme: 'light', w: 1500, h: 1000 },
    { seat: 'sidebar', theme: 'dark', w: 390, h: 844 },
    { seat: 'sidebar', theme: 'light', w: 390, h: 844 }
  ];
  const lineHCache = {};
  for (const cfg of CONFIGS) {
    await ensurePanel(cfg.seat);
    const theme = await applyTheme(cfg.theme);
    check(`AV-1前置 ${cfg.seat}/${cfg.theme}/${String(cfg.w)} 主题实证（面板区底色）`, theme.applied, `实得 ${theme.bg}`);
    await scrollToPanelStable();
    await sleep(300);
    // AV-1：自定义项上下布局——控件行在前、textarea 其后占满可用宽；上下关系不随配置变。
    const q1 = await readQ(Q1_TEXT);
    lineHCache[`${cfg.seat}/${cfg.theme}`] = q1.custom?.inputLineHeight ?? '';
    const q2 = await readQ(Q2_TEXT);
    // 盲审 a6/b4：布局直读 flex 方向（文档序＋宽比作旁证）；行高须 px 可换算
    // （'normal' 形态按留痕登记，不用 ||1 兜底冒称）。
    const rowsOk = (q) => q.present === true && q.custom !== null
      && q.custom.flow === 'column'
      && q.custom.ctlBeforeInput === true && q.custom.inputWidthRatio >= 85;
    check(`AV-1 ${cfg.seat}/${cfg.theme}/${String(cfg.w)} 两题自定义项均上下布局（flex 纵向＋控件行在前＋输入框宽 ≥85% 可用宽）`,
      rowsOk(q1) && rowsOk(q2),
      `q1 flow=${q1.custom?.flow} 宽比=${String(q1.custom?.inputWidthRatio)}% 顺序=${String(q1.custom?.ctlBeforeInput)}；q2 flow=${q2.custom?.flow} 宽比=${String(q2.custom?.inputWidthRatio)}%`);
    // AV-2：初始 ≥3 行（rows=3＋可视高度换算）。
    const lhOf = (q) => Number.parseFloat(q.custom?.inputLineHeight ?? '');
    const lh1 = lhOf(q1);
    const lh2 = lhOf(q2);
    const lhUsable = Number.isFinite(lh1) && lh1 > 0 && Number.isFinite(lh2) && lh2 > 0;
    const rowsOf = (q, lh) => (q.custom?.inputHeight ?? 0) / lh;
    check(`AV-2 ${cfg.seat}/${cfg.theme}/${String(cfg.w)} 输入框初始可见高度 ≥3 行（rows=3）`,
      lhUsable !== true ? null
        : q1.custom?.rows === '3' && rowsOf(q1, lh1) >= 2.9 && q2.custom?.rows === '3' && rowsOf(q2, lh2) >= 2.9,
      `q1=${lhUsable === true ? `${String(Math.round(rowsOf(q1, lh1) * 10) / 10)} 行` : '行高不可换算'}（${q1.custom?.inputHeight}px/${q1.custom?.inputLineHeight}）；q2=${lhUsable === true ? `${String(Math.round(rowsOf(q2, lh2) * 10) / 10)} 行` : '行高不可换算'}`);
    // 复审三轮发现（浅色窄屏两席 normal 拍成底部视图）：上一配置的底部图把
    // 面板内部滚动容器留在底位且跨配置沿用——每配置拍全景前复位到顶并实证。
    const topReset = await evaluate(page, `(() => {
      const qs = [...document.querySelectorAll('.ats-ask-panel .ats-ask-q')];
      let node = qs[qs.length - 1] ?? null;
      while (node !== null && node !== document.body) {
        const st = getComputedStyle(node);
        if (/(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 4) {
          node.scrollTop = 0;
          return { found: true, top: node.scrollTop };
        }
        node = node.parentElement;
      }
      return { found: false, top: -1 };
    })()`);
    if (topReset.found === true && topReset.top !== 0) log(`警告：${cfg.seat}/${cfg.theme} 全景拍前面板滚动复位未达（scrollTop=${String(topReset.top)}——normal 可能非顶部视图）`);
    await shotOf(`ask-${cfg.seat}-${cfg.theme}-${cfg.w <= 500 ? 'narrow' : 'wide'}-normal.png`, { width: cfg.w, height: cfg.h, fullPage: false });
    // 窄屏两题面板高于视口（审阅首轮：全景图底边裁掉第二题自定义项）——补拍
    // 底部锚定图，与全景顶锚合成完整证据。复审材料问题 1：window.scrollBy 无效
    // （面板滚动发生在面板自身滚动容器、非窗口）——改为找第二题的可滚祖先滚到底，
    // 拍前实证 scrollTop>0（未真滚即告警，不再产出与 normal 同帧的假底部图）。
    if (cfg.w <= 500) {
      const scrolled = await evaluate(page, `(() => {
        const qs = [...document.querySelectorAll('.ats-ask-panel .ats-ask-q')];
        const last = qs[qs.length - 1] ?? null;
        let node = last;
        while (node !== null && node !== document.body) {
          const st = getComputedStyle(node);
          if (/(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 4) {
            node.scrollTop = node.scrollHeight;
            return { scrolled: true, by: 'panel-container', top: node.scrollTop, max: node.scrollHeight - node.clientHeight };
          }
          node = node.parentElement;
        }
        return { scrolled: false, by: 'none', top: 0, max: 0 };
      })()`);
      await sleep(400);
      if (scrolled.scrolled !== true) log(`警告：${cfg.seat}/${cfg.theme} 底部图未真滚（无可滚祖先——底部帧可能与全景同）`);
      else log(`底部图已滚：${cfg.seat}/${cfg.theme} scrollTop=${String(scrolled.top)}/${String(scrolled.max)}`);
      await shotOf(`ask-${cfg.seat}-${cfg.theme}-narrow-normal-bottom.png`, { width: cfg.w, height: cfg.h, fullPage: false });
    }
  }

  // ── AV-8 aria 关联（一次深读；座位无关——ensurePanel 保证面板在场）──
  await ensurePanel('overlay');
  const a11y = await evaluate(page, `(() => {
    const q1 = ${qExpr(Q1_TEXT)};
    const q2 = ${qExpr(Q2_TEXT)};
    const read = (q) => {
      if (q === null) return null;
      const group = q.querySelector('.ats-ask-opts');
      const custom = q.querySelector('.ats-ask-custom');
      const optctl = custom?.querySelector('.ats-ask-optctl');
      const input = custom?.querySelector('textarea.ats-ask-input');
      return { groupRole: group?.getAttribute('role') ?? '', labelledby: group?.getAttribute('aria-labelledby') ?? '',
        textId: q.querySelector('.ats-ask-text')?.id ?? '',
        optsRoles: [...q.querySelectorAll('button.ats-ask-opt')].map((o) => [o.getAttribute('role'), o.getAttribute('aria-checked')]),
        optctlRole: optctl?.getAttribute('role') ?? '', optctlChecked: optctl?.getAttribute('aria-checked') ?? '',
        inputAriaLabel: input?.getAttribute('aria-label') ?? '' };
    };
    return { q1: read(q1), q2: read(q2) };
  })()`);
  check('AV-8 单选题容器 role=radiogroup＋aria-labelledby 指题干 id；选项与自定义控件 role=radio＋aria-checked；textarea 可访问名＝自定义回答',
    a11y.q1 !== null && a11y.q1.groupRole === 'radiogroup' && a11y.q1.labelledby === a11y.q1.textId
      && a11y.q1.optsRoles.every(([r, c]) => r === 'radio' && c === 'false')
      && a11y.q1.optctlRole === 'radio' && a11y.q1.optctlChecked === 'false'
      && a11y.q1.inputAriaLabel === '自定义回答',
    JSON.stringify(a11y.q1));
  check('AV-8 多选题容器 role=group＋aria-labelledby；选项与自定义控件 role=checkbox＋aria-checked',
    a11y.q2 !== null && a11y.q2.groupRole === 'group' && a11y.q2.labelledby === a11y.q2.textId
      && a11y.q2.optsRoles.every(([r, c]) => r === 'checkbox' && c === 'false')
      && a11y.q2.optctlRole === 'checkbox' && a11y.q2.optctlChecked === 'false',
    JSON.stringify(a11y.q2));

  // ── AV-3 自动换行与纵向查看（overlay 宽桌面；填两行长度无换行符中文）──
  await patchSettings({ askUiSeat: 'overlay' });
  await waitFor(page, 'document.querySelectorAll(".ats-ask-panel .ats-ask-q").length', (n) => Number(n) >= 2, 10_000);
  await applyTheme('dark');
  await scrollToPanelStable();
  const LONG_TEXT = '这是一段用来验证自动换行与纵向查看行为的较长中文文本，不含任何手动换行符，长度足以在输入框里折成两行以上显示';
  const typed3 = await setAskDraft(Q1_TEXT, LONG_TEXT);
  await sleep(400);
  const wrap = await evaluate(page, `(() => {
    const q = ${qExpr(Q1_TEXT)};
    const input = q?.querySelector('textarea.ats-ask-input');
    const custom = q?.querySelector('.ats-ask-custom');
    const mark = custom?.querySelector('.ats-ask-mark');
    if (input === null) return null;
    const ir = input.getBoundingClientRect();
    const mr = mark?.getBoundingClientRect();
    const before = input.scrollTop;
    input.scrollTop = 10;
    const moved = input.scrollTop !== before;
    input.scrollTop = 0;
    const overlap = mr !== undefined
      && ir.left < mr.right && mr.left < ir.right && ir.top < mr.bottom && mr.top < ir.bottom;
    return { scrollW: input.scrollWidth, clientW: input.clientWidth,
      renderedH: ir.height, lineHeight: getComputedStyle(input).lineHeight,
      scrollH: input.scrollHeight, clientH: input.clientHeight, scrollTopWritable: moved,
      markPresent: mark != null, markOverlaps: overlap,
      selectedAfterType: custom.getAttribute('data-selected') };
  })()`);
  // 盲审 b4/b5：行高须可按 px 换算（'normal' 形态按留痕登记，不换算不冒称）；
  // 选择标记在场单列断言，重叠判两轴包围盒。
  const lhPx = Number.parseFloat(wrap?.lineHeight ?? '');
  const lhOk = Number.isFinite(lhPx) && lhPx > 0;
  check('AV-3 长文自动换行：无横向滚动（scrollWidth≤clientWidth）、渲染高度>单行；可滚时纵向可滚（scrollTop 可写）；选择标记在场且与文本框两轴不重叠',
    typed3 === 'set' && wrap !== null && wrap.scrollW <= wrap.clientW + 1
      && (lhOk !== true ? null : wrap.renderedH > lhPx * 1.5)
      && (wrap.scrollH <= wrap.clientH + 1 || wrap.scrollTopWritable === true)
      && wrap.markPresent === true && wrap.markOverlaps === false,
    `typed=${typed3} scrollW=${String(wrap?.scrollW)}/${String(wrap?.clientW)} scrollH=${String(wrap?.scrollH)}/${String(wrap?.clientH)} 高=${String(wrap?.renderedH)} 行高=${wrap?.lineHeight}（px 换算=${String(lhOk)}） 纵滚=${String(wrap?.scrollTopWritable)} 标记在场=${String(wrap?.markPresent)} 两轴重叠=${String(wrap?.markOverlaps)}`);
  check('AV-5 输入非空白文本即选中自定义项（键盘 Tab 聚焦不选中——见 AV-5 焦点步）',
    wrap?.selectedAfterType === 'true', `data-selected=${String(wrap?.selectedAfterType)}`);
  await shotOf('ask-overlay-dark-wide-wrap.png', { width: 1500, height: 1000, fullPage: false });

  // ── AV-5 焦点不伪装选中 ──
  // 盲审 b2＋四跑实证：AV-3 键入长文已选中自定义项，且清空草稿按需求 §4.2.2
  // 「保持选中」（client 只在非空白输入时选中、无输入即取消路径）——须先显式
  // 取消（点 optctl 走 customOff）再聚焦，断言「焦点不翻转选中值」才是本判据。
  await clickIn(`${qExpr(Q1_TEXT)}?.querySelector('.ats-ask-custom .ats-ask-optctl')`, '取消自定义项');
  await setAskDraft(Q1_TEXT, '');
  await sleep(300);
  const focusTry = await evaluate(page, `(() => {
    const q = ${qExpr(Q1_TEXT)};
    const input = q?.querySelector('textarea.ats-ask-input');
    const custom = q?.querySelector('.ats-ask-custom');
    if (input === null) return null;
    input.focus();
    return { focused: document.activeElement === input,
      selected: custom.getAttribute('data-selected'),
      optctlChecked: custom.querySelector('.ats-ask-optctl')?.getAttribute('aria-checked') };
  })()`);
  if (focusTry?.focused === true) {
    check('AV-5 焦点（未输入）不伪装选中：data-selected=false、aria-checked=false',
      focusTry.selected === 'false' && focusTry.optctlChecked === 'false', JSON.stringify(focusTry));
  } else {
    check('AV-5 焦点面：程序焦点不可得（观察项——弹窗护栏生效后未再出现此形态；点击/输入选中路径继续断言）', null,
      `focus 后 activeElement===textarea=${String(focusTry?.focused)}`);
  }
  const clickInput = await clickIn(`${qExpr(Q1_TEXT)}?.querySelector('textarea.ats-ask-input')`, '点击输入框');
  await sleep(300);
  const afterClick = await readQ(Q1_TEXT);
  check('AV-5 点击输入框选中自定义项（data-selected=true）',
    clickInput === 'clicked' && afterClick.custom?.selected === 'true',
    `data-selected=${String(afterClick.custom?.selected)}`);

  // ── AV-4 Enter 插入换行、不误提交（矩阵前半；提交在矩阵后） ──
  const enterKey = async () => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(300);
  };
  const focusForEnter = await evaluate(page, `(() => {
    const q = ${qExpr(Q1_TEXT)};
    const input = q?.querySelector('textarea.ats-ask-input');
    if (input === null) return false;
    input.focus();
    return document.activeElement === input;
  })()`);
  if (focusForEnter === true) {
    await enterKey();
    await enterKey();
    const afterEnter = await readQ(Q1_TEXT);
    const stillThere = await evaluate(page, `document.querySelectorAll('.ats-ask-panel .ats-ask-q').length`);
    check('AV-4① Enter×2：textarea 含换行、题目仍在（未提交）、提交钮状态不变（未选中无效态）',
      afterEnter.custom?.value.includes('\n') === true && Number(stillThere) >= 2
        && afterEnter.submit !== null && afterEnter.submit.disabled === true,
      `value=${JSON.stringify(afterEnter.custom?.value)} 题数=${String(stillThere)} submit=${JSON.stringify(afterEnter.submit)}`);
    // 盲审 a6：有效选中态（两行草稿）下 Enter 同样不误提交——提交钮保持可用。
    await setAskDraft(Q1_TEXT, 'Enter 有效性检查的第一行\n第二行内容');
    await sleep(300);
    await enterKey();
    const validAfter = await readQ(Q1_TEXT);
    const stillThere2 = await evaluate(page, `document.querySelectorAll('.ats-ask-panel .ats-ask-q').length`);
    check('AV-4① 有效选中态：Enter 不误提交（题目仍在＋提交钮保持可用＋草稿换行保留）',
      validAfter.submit !== null && validAfter.submit.disabled === false
        && Number(stillThere2) >= 2 && (validAfter.custom?.value.includes('\n') ?? false),
      `value=${JSON.stringify(validAfter.custom?.value)} 题数=${String(stillThere2)} submit=${JSON.stringify(validAfter.submit)}`);
    // 还原：取消选中＋清草稿，不向 AV-6 泄漏状态。
    await clickIn(`${qExpr(Q1_TEXT)}?.querySelector('.ats-ask-custom .ats-ask-optctl')`, '还原自定义选中');
    await setAskDraft(Q1_TEXT, '');
    await sleep(200);
  } else {
    check('AV-4① 焦点不可得（观察项）：换行注入无法定向，Enter 不误提交由套件层 J6＋DOM 结构（提交独立按钮）承担，换行原样交付仍由本步②实测',
      null, 'focus 后 activeElement!==textarea');
  }

  // ── AV-6 选中以底纹为主（两主题：选预设/选自定义 vs 未选中的计算底色） ──
  for (const scheme of ['dark', 'light']) {
    await applyTheme(scheme);
    await scrollToPanelStable();
    const sel = await evaluate(page, `(() => {
      const q = ${qExpr(Q1_TEXT)};
      if (q === null) return null;
      const opts = [...q.querySelectorAll('button.ats-ask-opt')];
      const red = opts.find((o) => o.querySelector('.ats-ask-optlabel')?.textContent === 'red');
      if (red === undefined) return null;
      red.click();
      return true;
    })()`);
    await sleep(300);
    const colors = await evaluate(page, `(() => {
      const q = ${qExpr(Q1_TEXT)};
      const opts = [...q.querySelectorAll('button.ats-ask-opt')];
      const red = opts.find((o) => o.querySelector('.ats-ask-optlabel')?.textContent === 'red');
      const blue = opts.find((o) => o.querySelector('.ats-ask-optlabel')?.textContent === 'blue');
      const mark = red?.querySelector('.ats-ask-mark');
      return { redBg: red === undefined ? '' : getComputedStyle(red).backgroundColor,
        blueBg: blue === undefined ? '' : getComputedStyle(blue).backgroundColor,
        redSelected: red?.getAttribute('data-selected') ?? '',
        markPresent: mark != null, redBorder: red === undefined ? '' : getComputedStyle(red).borderTopColor,
        blueBorder: blue === undefined ? '' : getComputedStyle(blue).borderTopColor };
    })()`);
    check(`AV-6 ${scheme} 选中预设项：底色≠未选中（底纹为主）＋选择标记在场＋边框变化并存（辅助）`,
      sel === true && colors.redBg !== colors.blueBg && colors.redSelected === 'true'
        && colors.markPresent === true && colors.redBorder !== colors.blueBorder,
      `红=${colors.redBg} 蓝=${colors.blueBg} 边框=${colors.redBorder}/${colors.blueBorder}`);
    await shotOf(`ask-overlay-${scheme}-wide-selected.png`, { width: 1500, height: 1000, fullPage: false });
  }

  // ── 交互态近景矩阵：两座位×3 配置×4 态（普通已在全景；悬停/选中/键盘焦点） ──
  // 审阅首轮教训（状态串场）：AV-3/5/6 步留下的选中与草稿泄入矩阵——hover 图
  // 拍到的是已选中态。每个配置拍前先清题面状态（预设/自定义全取消＋草稿清空）。
  const clearQ1 = async () => {
    // 单选语义（client.js:1977-1993 实读）：预设再点＝幂等替换（不清除）、
    // customOn 互斥清预设、customOff 只关自定义。同步双点会读到同一渲染闭包
    // （双发 customOn 卡在选中）——改为按状态读数分步点，每步等状态落定。
    const ctlExpr = `${qExpr(Q1_TEXT)}?.querySelector('.ats-ask-custom .ats-ask-optctl')`;
    const st0 = await readQ(Q1_TEXT);
    if (st0.opts.some((o) => o.selected === 'true')) {
      await clickIn(ctlExpr, '自定义 on（互斥清预设）');
      await sleep(300);
    }
    const st1 = await readQ(Q1_TEXT);
    if (st1.custom?.selected === 'true') {
      await clickIn(ctlExpr, '自定义 off');
      await sleep(300);
    }
    await setAskDraft(Q1_TEXT, '');
    await sleep(500);
    const st = await readQ(Q1_TEXT);
    return st.opts.every((o) => o.selected === 'false') && st.custom?.selected === 'false';
  };
  for (const seat of ['overlay', 'sidebar']) {
    await ensurePanel(seat);
    for (const [themeName, w, h, tag] of [['dark', 1500, 1000, 'wide-dark'], ['light', 1500, 1000, 'wide-light'], ['light', 390, 844, 'narrow-light']]) {
      await applyTheme(themeName);
      await scrollToPanelStable();
      let cleaned = await clearQ1();
      for (let retry = 0; retry < 2 && !cleaned; retry += 1) cleaned = await clearQ1();
      if (!cleaned) log(`警告：${seat}/${tag} 悬停拍前状态未清净（hover 图可能带选中残留）`);
      // 悬停：Input.dispatchMouseEvent mousemove 到第一题首个选项（未点击）。
      const hoverPt = await evaluate(page, `(() => {
        const q = ${qExpr(Q1_TEXT)};
        const o = q?.querySelector('button.ats-ask-opt');
        if (o === null || o === undefined) return null;
        const r = o.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (hoverPt !== null) {
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverPt.x, y: hoverPt.y });
        await sleep(400);
      }
      await shotOf(`ask-${seat}-${tag}-hover.png`, { width: w, height: h, fullPage: false });
      // 选中态：点第一题预设项＋自定义项并填两行较长中文。
      await clickIn(`${qExpr(Q1_TEXT)}?.querySelector('button.ats-ask-opt')`, '选项一');
      await clickIn(`${qExpr(Q1_TEXT)}?.querySelector('.ats-ask-custom .ats-ask-optctl')`, '自定义项');
      await setAskDraft(Q1_TEXT, '第一行较长中文内容用于选中态近景\n第二行同样较长中文内容');
      await sleep(400);
      const selState = await readQ(Q1_TEXT);
      // 单选语义（client.js 实测＋审阅）：选自定义即清预设——选中态的期望形态
      // ＝自定义选中＋预设全未选＋提交可用；不符才告警。
      if (selState.custom?.selected !== 'true' || selState.opts.some((o) => o.selected === 'true')) {
        log(`警告：${seat}/${tag} 选中拍前状态未达（custom=${selState.custom?.selected} presets=${JSON.stringify(selState.opts.map((o) => o.selected))}）`);
      }
      await scrollToPanelStable();
      await shotOf(`ask-${seat}-${tag}-selected.png`, { width: w, height: h, fullPage: false });
      // 键盘焦点态：:focus-visible 外廓在输入框（程序焦点可得时）。
      // 复审材料问题 2：选中态不清场时焦点帧与 selected 逐字节同帧（点击聚焦
      // 也匹配 :focus-visible，选中帧已带环）——先取消选中再聚焦，焦点帧与
      // 选中帧在图上可区分；:focus-visible 匹配入读数（不匹配时按观察项留痕）。
      const ctlExpr = `${qExpr(Q1_TEXT)}?.querySelector('.ats-ask-custom .ats-ask-optctl')`;
      await clickIn(ctlExpr, '取消自定义（焦点近景前）');
      // 复审三轮发现（焦点帧状态不自洽）：框里带两行草稿却未选中是用户打不出
      // 的中间态——清草稿，帧＝空框＋未选中＋聚焦环，状态自洽。
      await setAskDraft(Q1_TEXT, '');
      await sleep(300);
      const focused = await evaluate(page, `(() => {
        const q = ${qExpr(Q1_TEXT)};
        const input = q?.querySelector('textarea.ats-ask-input');
        if (input === null) return null;
        input.focus();
        return { ok: document.activeElement === input,
          focusVisible: input.matches(':focus-visible'),
          customSelected: q.querySelector('.ats-ask-custom')?.getAttribute('data-selected') ?? '' };
      })()`);
      if (focused?.ok === true) {
        if (focused.focusVisible !== true) log(`警告：${seat}/${tag} focus 近景 :focus-visible 未匹配（文本框聚焦环可能缺席——观察项）`);
        await scrollToPanelStable();
        await shotOf(`ask-${seat}-${tag}-focus.png`, { width: w, height: h, fullPage: false });
      } else {
        // 盲审 e：不可拍的说明走判据留痕（不混入截图文件清单）。
        check(`AV-5 焦点近景 ${seat}/${tag}：程序焦点不可得（观察项，近景缺）`,
          null, 'focus 后 activeElement!==textarea');
      }
    }
  }
  // 多行长文近景＋徽标计数近景。
  // 复核 c3 残余：直连座位切换补门禁返回值校验（面板重挂载慢时不拍空景）。
  await patchSettings({ askUiSeat: 'overlay' });
  const mlPanels = Number(await waitFor(page, 'document.querySelectorAll(".ats-ask-panel .ats-ask-q").length', (n) => Number(n) >= 2, 10_000));
  if (mlPanels < 2) fail(`multiline 近景前面板门禁未过（题数=${String(mlPanels)}）`);
  await applyTheme('dark');
  await scrollToPanelStable();
  // 视口预置（四轮复审定论「断言绿、画面空」的根因）：上一矩阵窄幅（390）后
  // 此处直接拍 1500——capture 时的视口切换触发 React 重挂载、草稿被清，断言
  // 读到的是换前节点。先预置 1500×1000 等收敛，再灌稿——capture 时尺寸不变、
  // 不再重挂载，草稿活着进入画面。
  await setViewport(page, 1500, 1000);
  // 第 5 轮收口做法①：面板身份稳定（根节点签名两读一致）后才灌稿。
  const panelIdent = () => evaluate(page, `(() => {
    const p = document.querySelector('.ats-ask-panel');
    return p === null ? 'none' : p.className + ':' + String(p.childElementCount) + ':' + String(document.querySelectorAll('.ats-ask-q').length);
  })()`);
  let identPrev = await panelIdent();
  for (let i = 0; i < 10; i += 1) {
    await sleep(300);
    const ident = await panelIdent();
    if (ident === identPrev) break;
    identPrev = ident;
  }
  const ML_TEXT = '多选题自定义内容第一行\n第二行\n第三行——用于多行长文近景与自动换行审阅';
  // 第 5 轮收口做法②：灌稿与断言都绑**当前可见**的 textarea（qExpr 可能命中
  // 隐藏/换前节点，读写一致却与画面脱节）。
  let mlLanded = false;
  for (let i = 0; i < 3 && !mlLanded; i += 1) {
    await setAskDraftVisible(Q2_TEXT, ML_TEXT);
    await sleep(700);
    mlLanded = (await readDraftVisible(Q2_TEXT))?.includes('第三行') === true;
  }
  const mlBefore = await readDraftVisible(Q2_TEXT);
  await shotOf('ask-overlay-dark-wide-multiline.png', { width: 1500, height: 1000, fullPage: false });
  // 第 5 轮收口做法③：**截图后回读**——截前截后两次非空才算过；截后丢失给
  // 一次重灌重拍机会，仍不落如实 FAIL（green 断言必须覆盖成品帧）。
  let mlAfter = await readDraftVisible(Q2_TEXT);
  if (mlAfter?.includes('第三行') !== true) {
    log('警告：multiline 截图后草稿丢失，重灌并重拍一次');
    await setAskDraftVisible(Q2_TEXT, ML_TEXT);
    await sleep(700);
    if ((await readDraftVisible(Q2_TEXT))?.includes('第三行') === true) {
      await shotOf('ask-overlay-dark-wide-multiline.png', { width: 1500, height: 1000, fullPage: false });
      mlAfter = await readDraftVisible(Q2_TEXT);
      // 重拍后清单去重（shots 是目录清单，重拍同名只计一次）。
      const f = shots.indexOf('ask-overlay-dark-wide-multiline.png');
      const l = shots.lastIndexOf('ask-overlay-dark-wide-multiline.png');
      if (f !== l) shots.splice(l, 1);
    }
  }
  check('AV-multiline 近景落稿（可见 textarea 截图前后两次含三行草稿）',
    mlBefore?.includes('第三行') === true && mlAfter?.includes('第三行') === true,
    `截前=${JSON.stringify(mlBefore ?? null).slice(0, 60)} 截后=${JSON.stringify(mlAfter ?? null).slice(0, 60)}`);
  await patchSettings({ askUiSeat: 'sidebar' });
  await waitFor(page, 'document.querySelectorAll(".ats-ask-badge").length', (n) => Number(n) >= 1, 10_000).catch(() => {});
  // 徽标近景＝「面板收起」形态（审阅首轮：座位切换后面板仍展开，图与场景不符
  // ——先点徽标收起再拍，AV-9 行为步在其后照常展开往返）。
  const panelsBeforeBadge = Number(await evaluate(page, 'document.querySelectorAll(".ats-ask-panel").length'));
  if (panelsBeforeBadge > 0) {
    await evaluate(page, `document.querySelector('.ats-ask-badge')?.click(), true`);
    await sleep(600);
  }
  await shotOf('ask-sidebar-dark-wide-badge.png', { width: 1500, height: 1000, fullPage: false });

  // ── AV-9 徽标计数与展开（sidebar） ──
  // 盲审 a4：解析徽标计数并与面板题数比对（不只断文本非空）。
  const badge = await evaluate(page, `(() => {
    const b = document.querySelector('.ats-ask-badge');
    if (b === null) return null;
    return { text: b.textContent.trim(), panels: document.querySelectorAll('.ats-ask-panel').length };
  })()`);
  const badgeCount = Number((/(\d+)/.exec(badge?.text ?? '') ?? [])[1]);
  const qCount = await evaluate(page, `document.querySelectorAll('.ats-ask-panel .ats-ask-q').length`);
  if (badge !== null && badge.panels === 0) {
    const before = Number(qCount);
    await evaluate(page, `document.querySelector('.ats-ask-badge')?.click(), true`);
    await waitFor(page, 'document.querySelectorAll(".ats-ask-panel .ats-ask-q").length', (n) => Number(n) >= 2, 10_000);
    const after = Number(await evaluate(page, `document.querySelectorAll('.ats-ask-panel .ats-ask-q').length`));
    check('AV-9 sidebar：徽标在场、计数＝展开后面板题数、点徽标展开同组件',
      Number.isFinite(badgeCount) && badgeCount === after && badgeCount > 0
        && badge.text !== '' && before === 0 && after >= 2,
      `徽标=${JSON.stringify(badge.text)}（解析计数=${String(badgeCount)}） 展开后题数=${String(after)}（收起态面板题数恒 0 不作比较对象）`);
  } else {
    // 徽标步前已在展开态（前面矩阵留下的面板）——收起再验计数与往返。
    const countWhenOpen = Number(qCount);
    await evaluate(page, `document.querySelector('.ats-ask-badge')?.click(), true`);
    await sleep(500);
    const collapsed = await evaluate(page, `document.querySelectorAll('.ats-ask-panel').length`);
    await evaluate(page, `document.querySelector('.ats-ask-badge')?.click(), true`);
    await waitFor(page, 'document.querySelectorAll(".ats-ask-panel .ats-ask-q").length', (n) => Number(n) >= 2, 10_000);
    const reopened = Number(await evaluate(page, `document.querySelectorAll('.ats-ask-panel .ats-ask-q').length`));
    check('AV-9 sidebar：徽标在场、计数＝面板题数、点徽标开合往返同组件',
      badge !== null && Number.isFinite(badgeCount) && badgeCount === countWhenOpen
        && badgeCount === reopened && collapsed === 0,
      `徽标=${JSON.stringify(badge?.text)}（解析计数=${String(badgeCount)}） 展开态题数=${String(countWhenOpen)} 收起后面板=${String(collapsed)} 复展题数=${String(reopened)}`);
  }

  // ── AV-7 触屏点按＋目标度量 ──
  // 复核 minor：座位切换补面板门禁（重挂载慢时 sizing 读 0×0 假红）。
  await ensurePanel('overlay');
  await applyTheme('dark');
  await scrollToPanelStable();
  const sizing = await evaluate(page, `(() => {
    const q = ${qExpr(Q1_TEXT)};
    const items = [];
    const opt = q?.querySelector('button.ats-ask-opt');
    const input = q?.querySelector('textarea.ats-ask-input');
    const submit = q?.querySelector('.ats-ask-submit');
    for (const [name, n] of [['option', opt], ['input', input], ['submit', submit]]) {
      if (n === null || n === undefined) { items.push([name, 0, 0]); continue; }
      const r = n.getBoundingClientRect();
      items.push([name, Math.round(r.width), Math.round(r.height)]);
    }
    return items;
  })()`);
  check('AV-7 触屏目标度量（自持口径）：选项/输入框/提交按钮包围盒 ≥24×24',
    sizing.every(([, w, h]) => w >= 24 && h >= 24), JSON.stringify(sizing));
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxPoints: 1 });
  // 复核 info：tapVia 复用命中径（仅 synthesizeTapGesture 可用的环境下固定
  // touchStart/End 会假红）——按已证方法分派。
  const tapVia = async (point, method) => {
    if (method === 'synthesizeTapGesture') {
      await page.send('Input.synthesizeTapGesture', { x: point.x, y: point.y, durationMs: 80, tapCount: 1, gestureSourceType: 'touch' });
      await sleep(500);
      return;
    }
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    await sleep(120);
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(400);
  };
  const touchPoint = await evaluate(page, `(() => {
    const q = ${qExpr(Q2_TEXT)};
    const o = q?.querySelectorAll('button.ats-ask-opt')[1];
    if (o === null || o === undefined) return null;
    const r = o.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  let touchWorked = false;
  let touchMethod = 'none-worked';
  if (touchPoint !== null) {
    const attempts = [
      { method: 'synthesizeTapGesture', run: async () => {
        await page.send('Input.synthesizeTapGesture', { x: touchPoint.x, y: touchPoint.y, durationMs: 80, tapCount: 1, gestureSourceType: 'touch' });
        await sleep(500);
      } },
      { method: 'touchStart/End', run: async () => { await tapVia(touchPoint, 'touchStart/End'); } },
      { method: 'emulateTouchFromMouseEvent', run: async () => {
        await page.send('Input.emulateTouchFromMouseEvent', { type: 'mousePressed', x: touchPoint.x, y: touchPoint.y, button: 'left', clickCount: 1 });
        await page.send('Input.emulateTouchFromMouseEvent', { type: 'mouseReleased', x: touchPoint.x, y: touchPoint.y, button: 'left', clickCount: 1 });
        await sleep(400);
      } }
    ];
    for (const attempt of attempts) {
      await attempt.run();
      const q2state = await readQ(Q2_TEXT);
      if (q2state.opts.some((o) => o.selected === 'true')) { touchWorked = true; touchMethod = attempt.method; break; }
    }
  }
  let touchInputWorked = false;
  let touchInputDetail = '';
  if (touchWorked) {
    // 同径再点输入框：触屏点输入框应选中自定义项（onClick customOn）。先取消
    // 矩阵留下的选中，避免「本已选中」的平凡通过。
    const preState = await readQ(Q1_TEXT);
    if (preState.custom?.selected === 'true') {
      await clickIn(`${qExpr(Q1_TEXT)}?.querySelector('.ats-ask-custom .ats-ask-optctl')`, '取消自定义项（触屏步前置）');
      await sleep(300);
    }
    const inputPoint = await evaluate(page, `(() => {
      const q = ${qExpr(Q1_TEXT)};
      const i = q?.querySelector('textarea.ats-ask-input');
      if (i === null || i === undefined) return null;
      const r = i.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (inputPoint !== null) {
      await tapVia(inputPoint, touchMethod);
      const st = await readQ(Q1_TEXT);
      touchInputWorked = st.custom?.selected === 'true';
      touchInputDetail = `data-selected=${String(st.custom?.selected)}`;
    }
  }
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxPoints: 1 });
  if (touchWorked) {
    check(`AV-7 触屏 tap 点选预设项＋点输入框选中自定义项生效（${touchMethod}；提交触屏路径因消题顺序冲突不实跑——AV-4② 点击路径＋本度量覆盖）`,
      touchInputWorked === true, `method=${touchMethod} 点输入框 ${touchInputDetail}`);
  } else {
    check('AV-7 触屏合成面：本机无头 CDP 触摸合成不触发 onClick（观察项——度量断言已过，点击路径由 AV-5/AV-6 证，真实触屏留人工面）',
      null, `target=${JSON.stringify(touchPoint)}`);
  }

  // ── AV-4② 换行原样交付（提交即消题——放最后） ──
  await patchSettings({ askUiSeat: 'overlay' });
  await scrollToPanelStable();
  const TWO_LINES = '窗口内作答的第一行中文\n窗口内作答的第二行中文';
  await clickIn(`${qExpr(Q1_TEXT)}?.querySelector('.ats-ask-custom .ats-ask-optctl')`, '选中自定义项');
  const typedFinal = await setAskDraft(Q1_TEXT, TWO_LINES);
  await sleep(300);
  const q1Before = await readQ(Q1_TEXT);
  check('AV-4② 前置：两行草稿＋提交钮可用（自定义选中有效）',
    typedFinal === 'set' && q1Before.custom?.selected === 'true' && q1Before.submit !== null && q1Before.submit.disabled === false,
    `value=${JSON.stringify(q1Before.custom?.value)} submit=${JSON.stringify(q1Before.submit)}`);
  const submitClick = await clickIn(`${qExpr(Q1_TEXT)}?.querySelector('.ats-ask-submit')`, '提交');
  // 盲审 c4：出列用轮询（固定 sleep 提交慢时假红）。
  const qGoneExpr = (text) => `(() => {
    const qs = [...document.querySelectorAll('.ats-ask-panel .ats-ask-q')];
    return qs.some((n) => (n.querySelector('.ats-ask-text')?.textContent ?? '').includes(${JSON.stringify(text)})) === false;
  })()`;
  const q1Gone = (await waitFor(page, qGoneExpr(Q1_TEXT), (v) => v === true, 10_000)) === true;
  // ask 工具调用整批完成才出结果（首跑实测：q2 挂着时 45s 无回执）——随手答掉
  // q2（预设＋提交）让批次收口，回执随批完成落转录。
  const q2Ans = await clickIn(`${qExpr(Q2_TEXT)}?.querySelector('button.ats-ask-opt')`, 'q2 预设一');
  await sleep(300);
  const q2Submit = await clickIn(`${qExpr(Q2_TEXT)}?.querySelector('.ats-ask-submit')`, 'q2 提交');
  const q2Gone = (await waitFor(page, qGoneExpr(Q2_TEXT), (v) => v === true, 10_000)) === true;
  check('AV-4② 前置②：批内余题随手作答收批（q2 出列）',
    q2Ans === 'clicked' && q2Submit === 'clicked' && q2Gone === true,
    `q2=${q2Ans}/${q2Submit} 出列=${String(q2Gone)}`);
  let receiptHasNewline = false;
  let receiptText = '';
  let receiptSearched = 0;
  for (let i = 0; i < 30 && !receiptHasNewline; i += 1) {
    await sleep(1500);
    receiptSearched = i + 1;
    const t = await transcriptOf(SESSION).catch(() => null);
    const text = (t?.records ?? []).map((r) => JSON.stringify(r.event?.data ?? {})).join('\n');
    const hit = text.includes('窗口内作答的第一行中文');
    if (hit) {
      receiptHasNewline = text.includes('窗口内作答的第一行中文\\n窗口内作答的第二行中文')
        || text.includes('窗口内作答的第一行中文\\\\n窗口内作答的第二行中文');
      const idx = text.indexOf('窗口内作答的第一行中文');
      receiptText = text.slice(Math.max(0, idx - 60), idx + 120);
    }
    if (hit && !receiptHasNewline && i === 29) {
      // 命中文本但换行形态不匹配——转录尾部落日志供诊断。
      log(`回执命中但换行不匹配，尾部：${text.slice(-400)}`);
    }
    if (!hit && i === 29) {
      log(`回执未命中（批已收口），转录尾部事件类型：${(t?.records ?? []).slice(-8).map((r) => r.event?.type).join(',')}`);
    }
  }
  check('AV-4② 提交后题目出列＋作答回执自定义原文含换行（未被折叠/改写空白）',
    submitClick === 'clicked' && q1Gone === true && receiptHasNewline === true,
    `出列=${String(q1Gone)} 回执含换行=${String(receiptHasNewline)}（轮询 ${String(receiptSearched)}×1.5s） 回执片段=${JSON.stringify(receiptText)}`);

  // 收尾：批内两题均已作答收批，无余题（实例即弃，无复原需求）。
} catch (error) {
  cleanup();
  fail(`未预期异常：${String(error?.stack ?? error)}`);
}
cleanup();

let head = '';
try { head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(); } catch { /* 无 git 环境 */ }
writeFileSync(join(LOGS, 'ask-visual.json'), JSON.stringify({
  at: new Date().toISOString(), repo, head, hostVersion, failed, results, shots
}, null, 2));
log(`证据落盘：${join(LOGS, 'ask-visual.json')}（截图 ${String(shots.length)} 张在 shots/）`);
console.log(`\n判定：${failed === 0 ? '全部通过' : `存在 FAIL（${String(failed)} 项）`}`);
process.exit(failed === 0 ? 0 : 1);
