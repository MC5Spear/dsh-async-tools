#!/usr/bin/env node
/**
 * 待答面板输入链与无障碍树探针（VERIFY-01 的三项「环境边界」收窄——浏览器侧
 * 可装置面，2026-11-05 立项）：官方可写临时实例（zai 路由真实模型）接管真实
 * ask_user_question 批次（一单选两项＋一多选三项），对面板做三个系列的
 * 浏览器侧取证——
 *
 * - AX 系列（读屏**近似**——浏览器完整无障碍树＋真实 Tab 键焦点遍历）：
 *   CDP Accessibility.getFullAXTree 的面板子树（角色／名称／状态与 DOM 断言
 *   一致性）、全部交互节点 AX 名称非空、真实 Tab 键事件的焦点序＝DOM 序且
 *   无陷阱（全部**可聚焦**交互可达；disabled 提交钮被浏览器合规跳过）。
 *   ASK-ANNOUNCE-01 扩展：AX-3 升 FAIL 判据——新题温和提醒的视觉隐藏
 *   live region（role=status＋polite＋atomic）唯一在场；AX-4 两座位×收起态
 *   新题播报＋焦点保持；AX-5 重复轮询/倒计时去重；AX-6 播报语言随 uiLang
 *   冻结。**分层注明**：合并多题计数由单元层（test/ask-takeover.test.mjs
 *   J50）在替身模型上覆盖，浏览器侧用单题批次装置「新到达→播报」主链。
 *   **边界如实**：这是浏览器无障碍树面（读屏软件的数据源），不等于
 *   NVDA/JAWS 实机朗读——真实读屏仍留环境边界。
 * - IME 系列（组合输入**事件链**——CDP Input.imeSetComposition/insertText）：
 *   组合输入进行中（compositionupdate、input isComposing=true）与提交后
 *   （insertText）两态——值不丢、组合事件链在场、组合中 Enter（keyCode 229
 *   Process 形态）不触发提交（经典 IME 误提交危害）。ASK-IME-SUBMIT-01
 *   扩展：IME-1b 升 FAIL 判据——组合期提交钮禁用＋就近原因＋data-composing；
 *   IME-3 组合期点击被拒；IME-4 失焦结束组合不补发、按有效性恢复、显式再
 *   提交成行；IME-5 多题隔离（组合中「不答」可用、他题提交不受影响）。
 *   **边界如实**：真实 OS 输入法（微软拼音等）端到端仍留环境边界。
 * - SK 系列（软键盘**契约面**——属性＋视口收缩模拟）：textarea 的
 *   inputmode/enterkeyhint（多行框 Enter＝换行、不应带任何键盘动作暗示）、
 *   字号 ≥16px（iOS 聚焦自动放大预防——按观察项留痕量测）、键盘遮屏近似
 *   （视口高度收缩后，两题的提交钮与输入框逐控件经面板内部滚动可达可视
 *   区——每题独立滚动位与独立证据帧）。**边界如实**：真实触屏软键盘
 *   （Windows 触摸键盘／移动端）仍留环境边界；visualViewport 真实行为不在
 *   无头近似内。
 *
 * ## 用法（须 danger-full-access 或非受限环境——CDP 无头浏览器在受限沙箱档必早夭）
 *   node verify/_visual/probe-a11y-input.mjs --service-root <宿主服务树> \
 *     [--host-subdir dsh-0.2.1-rc.5] [--repo <本仓路径>] [--keep]
 *
 * 红线：只操作本装置自建的隔离实例，不连接、不改动任何既有实例（开发用或常驻服务）。--patch 只带 zai-glm.yml
 * 模型路由。证据：`.local/evidence/a11y-input/{logs,shots}`。退出码 0＝全部
 * 通过、1＝存在 FAIL、2＝装置故障（FAULT，输出区分）。
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
  try {
    mkdirSync(join(repo, '.local', 'evidence', 'a11y-input', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.local', 'evidence', 'a11y-input', 'logs', 'fault.json'),
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

// ── 实例与 RPC（与 probe-ask-visual 同款骨架）───────────────────────────────
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

// ── 题面锚点（与 probe-ask-visual 同款）─────────────────────────────────────
const Q1_TEXT = 'Pick a color';
const Q2_TEXT = 'Pick fruits';
const qExpr = (text) => `(() => {
  const qs = [...document.querySelectorAll('.ats-ask-q')];
  const q = qs.find((n) => (n.querySelector('.ats-ask-text')?.textContent ?? '').includes(${JSON.stringify(text)}));
  return q ?? null;
})()`;

const EVID = join(repo, '.local', 'evidence', 'a11y-input');
const LOGS = join(EVID, 'logs');
const SHOTS = join(EVID, 'shots');
mkdirSync(LOGS, { recursive: true });
try { rmSync(SHOTS, { recursive: true, force: true }); } catch { /* 无旧目录 */ }
mkdirSync(SHOTS, { recursive: true });
/** 关闭宿主「预览版说明」类对话框（与装置 C 同款护栏）。 */
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
  await sleep(400);
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
  home = mkdtempSync(join(tmpdir(), 'dsh-a11y-input-'));
  const install = spawnSync('node', [bin, 'plugin', '--profile', 'web', 'add', join(repo, '.local', tgzName)], {
    cwd: serviceRoot, encoding: 'utf8', timeout: 300_000, env: { ...process.env, DSH_HOME: home }
  });
  if (install.status !== 0) { console.error(install.stdout); console.error(install.stderr); fail('plugin add 退出非 0'); }
  const browserPath = findBrowser();
  if (browserPath === undefined) fail('找不到 Edge/Chrome（本探针需本机浏览器）');
  await startInstance();
  log(`repo=${repo} hostVersion=${hostVersion} tgz=${tgzName}`);

  // 2) 接管前置：askTakeover=600s 长窗＋中文界面＋overlay 座位。
  const settingsNS = 'async-tools-host';
  async function patchSettings(patch) {
    await rpc('settings/update', { ns: settingsNS, patch: { settings: patch } });
  }
  await patchSettings({ askTakeover: true, askTimeoutMs: 600000, uiLang: 'zh', askUiSeat: 'overlay' });
  const described = await rpc('settings/describe', {});
  const nsRow = described.namespaces.find((n) => (n.ns ?? n.namespace ?? n.id) === settingsNS);
  if (nsRow?.value?.settings?.askTakeover !== true) fail('askTakeover 前置未生效');

  // 3) 会话＋一批两题（与装置 C 同款的重试与 state RPC 权威门禁）。
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
  // 每轮尝试前**排空旧接管项**（三跑诊断实证：接管队列跨会话累积，上一轮模型
  // 依从失败的旧项会以旧形态永远卡住 find() 首匹配——第 2 轮起其实已发对；
  // 该诊断跑的 fault.json 按「实证在案」保留在 logs/ 下，勿误读为本次故障）。
  // 排空＝逐题点「不答」（.ats-ask-skip）出列；最后一题出列后面板消失属正常。
  const qCountNow = () => evaluate(page, 'document.querySelectorAll(".ats-ask-panel .ats-ask-q").length');
  async function drainPending() {
    for (let guard = 0; guard < 16; guard += 1) {
      const before = Number(await qCountNow());
      if (before === 0) return true;
      await evaluate(page, `(() => {
        const q = document.querySelector('.ats-ask-panel .ats-ask-q');
        q?.querySelector('.ats-ask-skip')?.click();
        return true;
      })()`);
      let after = before;
      for (let i = 0; i < 10 && after === before; i += 1) {
        await sleep(500);
        after = Number(await qCountNow());
      }
      if (after >= before) log(`警告：排空旧项未递减（${String(before)}→${String(after)}）`);
    }
    return Number(await qCountNow()) === 0;
  }
  for (let attempt = 1; attempt <= 4 && !panelReady; attempt += 1) {
    if (attempt > 1 || Number(await qCountNow()) > 0) await drainPending();
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
        if (i === 19 && items.length > 0) {
          // 诊断留痕：实际批次形态（题面截断＋单复选），区分模型把 multiSelect
          // 放错题与 state 未及时反映两种形态。
          log(`  诊断：state 项=${JSON.stringify(items.map((it) => [String(it.question ?? '').slice(0, 18), it.multiSelect]))}`);
        }
        // 取**最新**匹配项（排空后应恰为本轮批次；若仍有旧项残留，旧形态
        // 不得卡死判定——三跑诊断实证的累积陷阱）。
        const lastOf = (text) => [...items].reverse().find((it) => (it.question ?? '').includes(text));
        const q1Item = lastOf('Pick a color');
        const q2Item = lastOf('Pick fruits');
        multiOk = q1Item !== undefined && q2Item !== undefined
          && q1Item.multiSelect === false && q2Item.multiSelect === true;
        if (!multiOk) await sleep(1000);
      }
    }
    const panels = Number(await waitFor(page, 'document.querySelectorAll(".ats-ask-panel .ats-ask-q").length', (n) => Number(n) >= 2, 120_000));
    panelReady = panels >= 2 && multiOk;
    if (!panelReady) {
      attemptsLog.push({ attempt, askCalled: askRecordText !== '', batchShapeOk: multiOk, panels });
      log(`第 ${String(attempt)} 次触发不可用，${attempt < 4 ? '换会话重试' : '放弃'}`);
    }
  }
  if (!panelReady) fail(`四轮触发未达可用面板（attempts=${JSON.stringify(attemptsLog)}）`);
  log(`面板就绪（sessionId=${String(SESSION)}，attempts=${JSON.stringify(attemptsLog)}）`);
  await ensureNoDialog();
  // 归一化：面板应恰为本轮批次两题（排空失败或批次外多题时，按「最旧先出列」
  // 收敛到 2——最后的 Q1/Q2 对为本轮正确形态）。
  for (let guard = 0; guard < 8 && Number(await qCountNow()) > 2; guard += 1) {
    await evaluate(page, `document.querySelector('.ats-ask-panel .ats-ask-q .ats-ask-skip')?.click(), true`);
    await sleep(700);
  }
  const finalCount = Number(await qCountNow());
  if (finalCount !== 2) log(`警告：面板题数归一未达 2（${String(finalCount)}）——后续按题干定位的断言仍以最新对为准`);
  await setViewport(page, 1500, 1000);
  await sleep(400);

  // ════════ AX 系列：浏览器完整无障碍树 + 真实 Tab 键焦点遍历 ════════
  // AX-1：Accessibility.getFullAXTree 的面板子树——角色/名称/状态与 DOM 断言一致。
  await page.send('Accessibility.enable', {}).catch(() => { /* 已启用 */ });
  const axTree = await page.send('Accessibility.getFullAXTree', {});
  const axNodes = axTree.nodes ?? [];
  const axOf = (node) => ({
    role: node.role?.value ?? '',
    name: node.name?.value ?? '',
    value: node.value?.value ?? '',
    props: Object.fromEntries((node.properties ?? []).map((p) => [p.name, p.value?.value]))
  });
  // 面板交互节点在 AX 树中的形态（按名称匹配题目与选项）。
  const axInteract = axNodes
    .filter((n) => ['radio', 'checkbox', 'textbox', 'button', 'radiogroup', 'group'].includes(n.role?.value ?? ''))
    .map(axOf)
    .filter((n) => n.name.includes('red') || n.name.includes('blue') || n.name.includes('apple')
      || n.name.includes('banana') || n.name.includes('cherry') || n.name.includes('Pick a color')
      || n.name.includes('Pick fruits') || n.name.includes('自定义回答') || n.name.includes('提交') || n.name.includes('不答'));  const domSummary = await evaluate(page, `(() => {
    const qs = [...document.querySelectorAll('.ats-ask-panel .ats-ask-q')];
    const out = [];
    for (const q of qs) {
      out.push({
        text: q.querySelector('.ats-ask-text')?.textContent ?? '',
        groupRole: q.querySelector('.ats-ask-opts')?.getAttribute('role') ?? '',
        opts: [...q.querySelectorAll('button.ats-ask-opt')].map((o) => ({
          role: o.getAttribute('role') ?? '', label: o.querySelector('.ats-ask-optlabel')?.textContent ?? '' })),
        customRole: q.querySelector('.ats-ask-custom .ats-ask-optctl')?.getAttribute('role') ?? '',
        inputLabel: q.querySelector('textarea.ats-ask-input')?.getAttribute('aria-label') ?? '',
        submitText: (q.querySelector('.ats-ask-submit')?.textContent ?? '').trim(),
        skipText: (q.querySelector('.ats-ask-skip')?.textContent ?? '').trim()
      });
    }
    return out;
  })()`);
  const domLabels = new Set(domSummary.flatMap((q) => [...q.opts.map((o) => o.label), q.inputLabel, q.submitText, q.skipText]));
  const axNames = new Set(axInteract.map((n) => n.name));
  const axRoleOk = axInteract.some((n) => n.role === 'radiogroup' && n.name.includes(Q1_TEXT))
    && axInteract.some((n) => n.role === 'group' && n.name.includes(Q2_TEXT))
    && axInteract.filter((n) => n.role === 'radio').length === 3
    && axInteract.filter((n) => n.role === 'checkbox').length === 4
    && axInteract.some((n) => n.role === 'textbox' && n.name.includes('自定义回答'));
  const axLabelCoverage = [...domLabels].filter((l) => l !== '' ).every((l) => [...axNames].some((n) => n.includes(l)));
  check('AX-1 面板子树在场：radiogroup/group 容器；选项 radio×2＋checkbox×3＋自定义控件 radio×1/checkbox×1；textbox「自定义回答」；AX 名称覆盖全部 DOM 交互标签',
    axRoleOk === true && axLabelCoverage === true,
    `AX 交互节点=${String(axInteract.length)}（radio=${String(axInteract.filter((n) => n.role === 'radio').length)}＝选项 2＋自定义 1；checkbox=${String(axInteract.filter((n) => n.role === 'checkbox').length)}＝选项 3＋自定义 1；textbox=${String(axInteract.filter((n) => n.role === 'textbox').length)}） 名称覆盖=${String(axLabelCoverage)} 样例=${JSON.stringify(axInteract.slice(0, 6))}`);

  // AX-2：真实 Tab 键焦点遍历——面板交互全可达、序＝DOM 序、无陷阱。
  await evaluate(page, `(() => {
    if (document.activeElement !== null && document.activeElement !== document.body) document.activeElement.blur();
    return true;
  })()`);
  const tabOnce = async () => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(60);
    return evaluate(page, `(() => {
      const el = document.activeElement;
      if (el === null || el === document.body) return null;
      const panel = document.querySelector('.ats-ask-panel');
      const desc = el.tagName.toLowerCase()
        + (el.getAttribute('role') !== null ? '|' + String(el.getAttribute('role')) : '')
        + (el.getAttribute('aria-label') !== null ? '|' + String(el.getAttribute('aria-label')) : '')
        + (el.textContent !== null && el.children.length === 0 ? '|' + el.textContent.trim().slice(0, 12) : '');
      // 与期望集同款过滤（display:none 剔除），保证 domIdx 两边同一编号体系。
      const all = [...document.querySelectorAll('.ats-ask-panel button, .ats-ask-panel textarea, .ats-ask-panel [tabindex]')]
        .filter((n) => n.getClientRects().length > 0);
      const idx = all.indexOf(el);
      return { desc, inPanel: panel !== null && panel.contains(el), domIdx: idx, total: all.length };
    })()`);
  };
  const walk = [];
  let stagnant = 0;
  for (let i = 0; i < 80 && stagnant < 6; i += 1) {
    const f = await tabOnce();
    if (f === null) { stagnant += 1; continue; }
    if (walk.length > 0 && walk[walk.length - 1].desc === f.desc) { stagnant += 1; } else stagnant = 0;
    walk.push(f);
  }
  const panelWalk = walk.filter((f) => f.inPanel && f.domIdx >= 0);
  // 首跑定因：两个「提交」钮在未选中态 disabled＝true，被 Tab 合规跳过——
  // 期望集＝**可聚焦**交互（disabled 天然不可达、非缺陷）；环绕后序重启，
  // 单调性按「首访顺序 DOM 递增」判。
  const focusables = await evaluate(page, `(() => {
    const all = [...document.querySelectorAll('.ats-ask-panel button, .ats-ask-panel textarea, .ats-ask-panel [tabindex]')]
      // 不把 display:none 元素计入期望集（tabIndex 属性仍在但不可达——假红
      // 方向脆弱性收口）。
      .filter((el) => el.getClientRects().length > 0);
    return { focusable: all.map((el, i) => ({ i, desc: el.tagName.toLowerCase()
      + (el.getAttribute('role') !== null ? '|' + String(el.getAttribute('role')) : '')
      + (el.getAttribute('aria-label') !== null ? '|' + String(el.getAttribute('aria-label')) : '')
      + (el.children.length === 0 ? '|' + el.textContent.trim().slice(0, 12) : ''), ok: el.disabled !== true && el.tabIndex !== -1 })) };
  })()`);
  const expectedIdx = focusables.focusable.filter((f) => f.ok).map((f) => f.i);
  const skippedIdx = focusables.focusable.filter((f) => !f.ok).map((f) => f.i);
  const seenIdx = [...new Set(panelWalk.map((f) => f.domIdx))];
  const firstVisitOrder = [];
  for (const f of panelWalk) if (!firstVisitOrder.includes(f.domIdx)) firstVisitOrder.push(f.domIdx);
  const firstVisitAscending = firstVisitOrder.every((v, i) => i === 0 || v > firstVisitOrder[i - 1]);
  check('AX-2 Tab 键遍历：面板全部**可聚焦**交互可达（disabled 提交钮合规跳过）、首访序＝DOM 序、无焦点陷阱',
    expectedIdx.length > 0 && expectedIdx.every((i) => seenIdx.includes(i)) && firstVisitAscending === true,
    `可聚焦=${String(expectedIdx.length)} Tab 到达=${String(seenIdx.length)} 跳过（disabled）=${String(skippedIdx.length)} 步数=${String(walk.length)} 首访序递增=${String(firstVisitAscending)} 首访序=${JSON.stringify(firstVisitOrder)} 序列=${JSON.stringify(panelWalk.map((f) => f.desc).slice(0, 16))}`);

  // AX-3（ASK-ANNOUNCE-01 升 FAIL 判据）：新题温和提醒的视觉隐藏 live region
  // 在场且唯一——role=status＋显式 polite/atomic（给探针一个确定断言面）、视觉
  // 隐藏类在身、**在面板外**（不随面板渲染门槛——侧栏收起形态仍可提醒）。面板
  // 容器本身不带 aria-live 是设计口径（区域是全界面唯一 live region，避免整面板
  // 变化被整段播报），一并留痕。
  const regionProbe = await evaluate(page, `(() => {
    const regions = [...document.querySelectorAll('[role="status"]')];
    const sr = [...document.querySelectorAll('.ats-ask-sr')];
    const panel = document.querySelector('.ats-ask-panel');
    return {
      statusCount: regions.length,
      srCount: sr.length,
      first: sr[0] === undefined ? null : {
        inPanel: panel !== null && panel.contains(sr[0]),
        role: sr[0].getAttribute('role'), live: sr[0].getAttribute('aria-live'),
        atomic: sr[0].getAttribute('aria-atomic'), className: String(sr[0].className),
        textLen: sr[0].textContent.length
      },
      panelLive: panel === null ? null : panel.getAttribute('aria-live'),
      assertiveCount: document.querySelectorAll('[aria-live="assertive"]').length
    };
  })()`);
  const srOk = regionProbe.statusCount === 1 && regionProbe.srCount === 1
    && regionProbe.first !== null && regionProbe.first.inPanel === false
    && regionProbe.first.role === 'status' && regionProbe.first.live === 'polite'
    && regionProbe.first.atomic === 'true' && regionProbe.first.className.includes('ats-ask-sr');
  check('AX-3 新题温和提醒 live region：role=status＋polite＋atomic＋视觉隐藏类，全页唯一且在面板外（面板容器无 aria-live 为设计口径）',
    srOk === true,
    `role=status 共 ${String(regionProbe.statusCount)}、.ats-ask-sr 共 ${String(regionProbe.srCount)}、区域=${JSON.stringify(regionProbe.first)}、面板 aria-live=${String(regionProbe.panelLive)}、assertive 计数=${String(regionProbe.assertiveCount)}`);
  // 盲测：首跑 A 帧滚在底部（Tab 走查把面板滚了下去）缺头部与 Q1 标题——拍
  // 前把面板内部滚动复位到顶＋blur 走查残留焦点，帧回归「全景顶锚」语义。
  await evaluate(page, `(() => {
    if (document.activeElement !== null && document.activeElement !== document.body) document.activeElement.blur();
    const qs = [...document.querySelectorAll('.ats-ask-panel .ats-ask-q')];
    let node = qs[qs.length - 1] ?? null;
    while (node !== null && node !== document.body) {
      const st = getComputedStyle(node);
      if (/(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 4) { node.scrollTop = 0; break; }
      node = node.parentElement;
    }
    return true;
  })()`);
  await sleep(200);
  await shotOf('a11y-ax-panel-wide.png', { width: 1500, height: 1000, fullPage: false });

  // ════════ IME 系列：组合输入事件链（imeSetComposition／insertText）════════
  // Q1 textarea 聚焦＋事件监听埋点，组合中与提交后两态取证。
  const imeFocus = await evaluate(page, `(() => {
    const q = ${qExpr(Q1_TEXT)};
    const input = q?.querySelector('textarea.ats-ask-input');
    if (input === null) return false;
    input.focus();
    input.scrollIntoView({ block: 'center' });
    window.__imeLog = [];
    for (const [type, tag] of [['compositionstart', 'start'], ['compositionupdate', 'update'], ['compositionend', 'end'], ['input', 'input'], ['keydown', 'key']]) {
      input.addEventListener(type, (e) => {
        // 盲测：单标志位有歧义（isComposing 与 isTrusted 分不清）——双标志
        // 并记。图例（读数各 detail 同此）：ic＝isComposing、it＝isTrusted；
        // CDP 合成链已知形态＝composition* 事件 ic 恒 0（真 IME 下为 1，事件
        // 类型分界而非组合态分界）、input/keydown ic=1、闭合 compositionend
        // 由 insertText 脚本侧触发故 it=0——均为近似边界内形态，判据只认
        // tag 前缀与值，不依赖标志位。
        window.__imeLog.push([tag, e.type, e.isComposing === true ? 'ic1' : 'ic0', e.isTrusted === true ? 'it1' : 'it0',
          e.key ?? '', e.keyCode ?? -1, String(e.data ?? '').slice(0, 10),
          String(input.value).slice(0, 16),
          q.querySelector('.ats-ask-custom')?.getAttribute('data-selected') ?? ''].join(':'));
      });
    }
    return document.activeElement === input;
  })()`);
  if (imeFocus !== true) fail('IME 步骤：textarea 程序聚焦不可得');
  await sleep(200);
  // IME-1：组合进行中——compositionupdate 在场、值随组合更新、组合中 Enter
  // （keyCode 229／Process 形态、**不带 text 注入**——CDP 的 text 会绕过组合链
  // 直接插字符）不触发提交（经典 IME 误提交危害）。
  await page.send('Input.imeSetComposition', { text: '拼音组合中', selectionStart: 5, selectionEnd: 5 });
  await sleep(500);
  const midState = await evaluate(page, `(() => {
    const q = ${qExpr(Q1_TEXT)};
    const input = q?.querySelector('textarea.ats-ask-input');
    return { value: String(input?.value ?? ''), selected: q?.querySelector('.ats-ask-custom')?.getAttribute('data-selected') ?? '',
      qCount: document.querySelectorAll('.ats-ask-panel .ats-ask-q').length,
      log: (window.__imeLog ?? []).slice(0, 12) };
  })()`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Process', code: 'Enter', windowsVirtualKeyCode: 229 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'Enter', windowsVirtualKeyCode: 229 });
  await sleep(400);
  const q1ValueAfterEnter = await evaluate(page, `(() => {
    const q = ${qExpr(Q1_TEXT)};
    return { value: String(q?.querySelector('textarea.ats-ask-input')?.value ?? ''), qCount: document.querySelectorAll('.ats-ask-panel .ats-ask-q').length };
  })()`);
  const hadUpdate = midState.log.some((l) => l.startsWith('update:')) || midState.log.some((l) => /^input:input:ic1/.test(l));
  // 图例入 detail（定向复核：外部无法独立解释 ic/it——补定义；链尾第 9 位＝
  // 当时 data-selected 值）。
  const LOG_LEGEND = '图例：ic＝isComposing、it＝isTrusted、链尾位＝data-selected；合成链 composition* 恒 ic0、闭合 end 为脚本触发 it0（已知近似形态，判据不依赖标志位）';
  check('IME-1 组合进行中：composition 事件链在场、值随组合更新、组合中 Enter（229）不误提交（题目仍在）',
    hadUpdate === true && midState.value.includes('拼音组合中') === true
      && q1ValueAfterEnter.qCount >= 2 && q1ValueAfterEnter.value.includes('拼音组合中') === true,
    `组合中值=${JSON.stringify(midState.value.slice(0, 20))} 选中=${midState.selected} Enter(229)后题数=${String(q1ValueAfterEnter.qCount)} 值保留=${String(q1ValueAfterEnter.value.includes('拼音组合中'))} ${LOG_LEGEND} 事件链=${JSON.stringify(midState.log.slice(0, 8))}`);
  await shotOf('a11y-ime-composing.png', { width: 1500, height: 1000, fullPage: false });
  // IME-1b（ASK-IME-SUBMIT-01 升 FAIL 判据）：组合进行中（自定义已选中、框内
  // 有组合文）——提交钮禁用（平台层拦截）、就近原因行=组合中文案、根节点
  // data-composing 探针锚点；「不答」不受组合位置禁用（隔离口径，IME-5 展开）。
  const submitDuringComp = await evaluate(page, `(() => {
    const q = ${qExpr(Q1_TEXT)};
    const s = q?.querySelector('.ats-ask-submit');
    const k = q?.querySelector('.ats-ask-skip');
    return s === null || s === undefined ? null : {
      disabled: s.disabled === true, text: s.textContent.trim(),
      skipDisabled: k === null || k === undefined ? null : k.disabled === true,
      composing: q.getAttribute('data-composing'),
      reason: q.querySelector('.ats-ask-reason')?.textContent ?? ''
    };
  })()`);
  const COMP_ZH = '输入法组词中：完成输入后再提交';
  check('IME-1b 组合期提交限制：提交钮 disabled＋就近原因＝组合中文案＋data-composing=true＋「不答」可用',
    submitDuringComp !== null && submitDuringComp.disabled === true
      && submitDuringComp.composing === 'true'
      && submitDuringComp.reason.includes('组词中') === true
      && submitDuringComp.skipDisabled === false,
    `disabled=${String(submitDuringComp?.disabled)} data-composing=${String(submitDuringComp?.composing)} 原因=${JSON.stringify(submitDuringComp?.reason)}（期望含 ${JSON.stringify(COMP_ZH)}）不答禁用=${String(submitDuringComp?.skipDisabled)}`);
  // IME-2：提交面。**环境语义（二跑事件链实证）**：无真 IME 时 Enter(13/229)
  // 都不提交组合（真 IME 的提交由输入法软件先行拦截，浏览器收不到裸键）；
  // CDP `insertText` 在组合活动时＝「替换式提交」（compositionupdate→
  // input(composing)→compositionend，组合文被插入文替换）。应用侧可证的面：
  // ①Enter 不破坏组合（值不丢、面板不提交——与 AV-4① 换行不提交互补）；
  // ②提交事件链闭合（end 在场）且终值自洽（＝插入文，无重复/残留拼接）、
  // 选中态成立。**边界如实**：「组合文在真实 IME 提交时被保留」是浏览器与
  // 输入法软件的行为，无头合成不装置、不冒称。
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(400);
  const afterEnter13 = await evaluate(page, `(() => {
    const q = ${qExpr(Q1_TEXT)};
    return { value: String(q?.querySelector('textarea.ats-ask-input')?.value ?? ''),
      qCount: document.querySelectorAll('.ats-ask-panel .ats-ask-q').length,
      log: (window.__imeLog ?? []).slice(-6) };
  })()`);
  check('IME-2a 组合中裸 Enter(13)：不破坏组合（值不无故丢文）、不触发面板提交（真 IME 的提交键由输入法拦截，浏览器不裸收——本装置只证应用侧不误响应）',
    afterEnter13.qCount >= 2 && afterEnter13.value.includes('拼音组合中') === true,
    `Enter(13)后值=${JSON.stringify(afterEnter13.value.slice(0, 20))} 题数=${String(afterEnter13.qCount)} 尾部事件=${JSON.stringify(afterEnter13.log.slice(-3))}`);
  await page.send('Input.insertText', { text: '，已提交' });
  await sleep(500);
  const committed = await evaluate(page, `(() => {
    const q = ${qExpr(Q1_TEXT)};
    const input = q?.querySelector('textarea.ats-ask-input');
    return { value: String(input?.value ?? ''), selected: q?.querySelector('.ats-ask-custom')?.getAttribute('data-selected') ?? '',
      log: (window.__imeLog ?? []).slice(-10) };
  })()`);
  const endFired = committed.log.some((l) => l.startsWith('end:'));
  // 两种自洽终值：替换式（本环境实测）＝插入文独占；保留追加式（若浏览器
  // 版本让 insertText 先闭合组合再追加）＝组合文＋插入文。败判只认损坏形态
  //（空值/重复拼接/残留组合态）。
  const flatFinal = committed.value.replace(/\n/g, '');
  const formOk = committed.value === '，已提交' || flatFinal.includes('拼音组合中，已提交');
  check('IME-2b 提交（insertText 替换式）：compositionend 闭合、终值自洽（替换式或保留追加式——败判只认空值/重复拼接）、选中自定义项',
    endFired === true && formOk === true && committed.selected === 'true',
    `终值=${JSON.stringify(committed.value)} 选中=${committed.selected} end 在场=${String(endFired)} 尾部事件=${JSON.stringify(committed.log.slice(-4))}`);
  // 清场（不给后续系列泄漏状态）。
  await evaluate(page, `(() => {
    const q = ${qExpr(Q1_TEXT)};
    const input = q?.querySelector('textarea.ats-ask-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const ctl = q?.querySelector('.ats-ask-custom .ats-ask-optctl');
    if (q?.querySelector('.ats-ask-custom')?.getAttribute('data-selected') === 'true') ctl?.click();
    delete window.__imeLog;
    if (document.activeElement !== null && document.activeElement !== document.body) document.activeElement.blur();
    return true;
  })()`);
  await sleep(300);

  // ════════ SK 系列：软键盘契约面（属性＋视口收缩模拟）════════
  // SK-1：输入控件软键盘语义属性——多行 textarea（Enter＝换行）不应带
  // enterkeyhint=send/go 一类提交语义；inputmode 记录在场性。
  const skAttrs = await evaluate(page, `(() => {
    const read = [];
    for (const q of document.querySelectorAll('.ats-ask-panel .ats-ask-q')) {
      const input = q.querySelector('textarea.ats-ask-input');
      if (input === null) continue;
      read.push({ inputmode: input.getAttribute('inputmode'), enterkeyhint: input.getAttribute('enterkeyhint'),
        autocomplete: input.getAttribute('autocomplete'), fontSize: getComputedStyle(input).fontSize });
    }
    return read;
  })()`);
  const noEnterHint = skAttrs.every((a) => a.enterkeyhint === null || a.enterkeyhint === '' || a.enterkeyhint === 'enter');
  check('SK-1 多行输入软键盘语义：textarea 无键盘动作暗示 enterkeyhint（白名单仅容空／enter——Enter＝换行不被 send/go/next 一类导航键劫持）；inputmode 记录',
    skAttrs.length >= 2 && noEnterHint === true,
    `样本=${String(skAttrs.length)} enterkeyhint=${JSON.stringify([...new Set(skAttrs.map((a) => a.enterkeyhint))])} inputmode=${JSON.stringify([...new Set(skAttrs.map((a) => a.inputmode))])}`);
  // SK-2：字号 ≥16px（iOS 聚焦自动放大预防——<16px 即触发聚焦缩放）——设计
  // 令牌现状按观察项量测留痕（是否调字号属产品决定，见问题清单 VIS-OBS-01）。
  const sizes = skAttrs.map((a) => Number((/(\d+(?:\.\d+)?)/.exec(a.fontSize ?? '') ?? [])[1] ?? 0));
  check('SK-2 输入框字号量测（≥16px 防 iOS 聚焦自动放大——现状不足按观察项留痕，产品决定在 VIS-OBS-01）',
    null, `fontSize=${JSON.stringify([...new Set(skAttrs.map((a) => a.fontSize))])} px=${JSON.stringify(sizes)}`);
  // SK-3：键盘遮屏近似（视口高度收缩 390×400）——可达性按「**逐题逐控件**
  // 各自滚入」判（首跑定因：一次滚到底只证 Q2 尾部；盲测定因：两题读数若在
  // 同一次 evaluate 里连滚连读，读数来自不同滚动位、不能同帧共存——改为每题
  // 一次滚动＋独立帧＋独立读数，帧与读数一一对应）。每题断言：提交钮与输入
  // 框**各自**滚入后均可达可视区。
  await setViewport(page, 390, 400);
  await sleep(600);
  const skReadQ = async (text, label) => {
    const r = await evaluate(page, `(() => {
      const qs = [...document.querySelectorAll('.ats-ask-panel .ats-ask-q')];
      const q = qs.find((n) => (n.querySelector('.ats-ask-text')?.textContent ?? '').includes(${JSON.stringify(text)}));
      const submit = q?.querySelector('.ats-ask-submit');
      const input = q?.querySelector('textarea.ats-ask-input');
      if (submit === null || input === null || submit === undefined || input === undefined) return null;
      submit.scrollIntoView({ block: 'center' });
      const sr = submit.getBoundingClientRect();
      const ir0 = input.getBoundingClientRect();
      const submitVisible = sr.top >= 0 && sr.bottom <= innerHeight && sr.height > 0;
      const inputWithSubmit = ir0.top >= 0 && ir0.bottom <= innerHeight;
      let inputVisible = inputWithSubmit;
      if (inputWithSubmit !== true) {
        input.scrollIntoView({ block: 'center' });
        const ir = input.getBoundingClientRect();
        inputVisible = ir.top >= 0 && ir.bottom <= innerHeight;
      }
      return { innerH: innerHeight, submitTop: Math.round(sr.top), submitBottom: Math.round(sr.bottom), submitVisible,
        inputTop: Math.round(ir0.top), inputBottom: Math.round(ir0.bottom), inputVisible, inputNeededOwnScroll: inputWithSubmit !== true };
    })()`);
    await sleep(300);
    await shotOf(`a11y-sk-shrunk-${label}.png`, { width: 390, height: 400, fullPage: false });
    return r;
  };
  const skQ1 = await skReadQ(Q1_TEXT, 'q1');
  const skQ2 = await skReadQ(Q2_TEXT, 'q2');
  const skOk = skQ1 !== null && skQ2 !== null
    && skQ1.submitVisible === true && skQ1.inputVisible === true
    && skQ2.submitVisible === true && skQ2.inputVisible === true;
  check('SK-3 键盘遮屏近似（视口 390×400）：两题的提交钮与输入框逐控件经面板内部滚动可达可视区（每题独立滚动位与独立帧）',
    skOk === true,
    `q1：提交钮=${String(skQ1?.submitTop)}..${String(skQ1?.submitBottom)}（可见=${String(skQ1?.submitVisible)}）输入框=${String(skQ1?.inputTop)}..${String(skQ1?.inputBottom)}（可见=${String(skQ1?.inputVisible)}${skQ1?.inputNeededOwnScroll === true ? '——独立滚动后' : ''}）；`
      + `q2：提交钮=${String(skQ2?.submitTop)}..${String(skQ2?.submitBottom)}（可见=${String(skQ2?.submitVisible)}）输入框=${String(skQ2?.inputTop)}..${String(skQ2?.inputBottom)}（可见=${String(skQ2?.inputVisible)}${skQ2?.inputNeededOwnScroll === true ? '——独立滚动后' : ''}）；`
      + `innerH=${String(skQ1?.innerH)}（两题读数各来自自己的滚动位与帧，不构成同帧矛盾）`);
  // 复位视口。
  await setViewport(page, 1500, 1000);
  await sleep(300);

  // ════════ AX-4/5/6：新题温和提醒主链（ASK-ANNOUNCE-01）════════
  // 分层注明：合并多题计数（同批多题合成一条）由单元层 J50 在替身模型上覆盖；
  // 浏览器侧用单题批次装置「新到达→播报→去重→语言」的真实链路。
  const regionRead = () => evaluate(page, `(() => {
    const r = document.querySelector('.ats-ask-sr[role="status"]');
    return r === null ? null : { raw: r.textContent, text: r.textContent.replace(/\\u200B/g, '') };
  })()`);
  const ANN_ZH = '待答问题新增 1 题';
  const ANN_EN = 'Pending questions: 1 new';
  /** 触发一个单题新批次（新会话，重试一轮）：state RPC 权威等待其进入列表。 */
  async function triggerSingleBatch(questionText) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const created = await rpc('session/create', { request: { cwd: home, agentPreset: 'dsh-async' } });
      const sid = created.sessionId;
      await rpc('session/prompt', {
        request: {
          requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
          sessionId: sid, mode: 'queue',
          content: [{ type: 'text', text: `Call the ask_user_question tool with exactly ONE question in ONE call: question text "${questionText}", options "yes" and "no", no multiSelect. Do not answer it yourself; call the tool once and wait for the user.` }],
          clientTimeZone: 'Asia/Hong_Kong'
        }
      });
      for (let i = 0; i < 40; i += 1) {
        const st = await rpc('async-tools-ask/state', {}).catch(() => null);
        if ((st?.items ?? []).some((it) => (it.question ?? '').includes(questionText) === true)) return sid;
        await sleep(3000);
      }
    }
    return null;
  }
  const waitForRegion = async (pred) => {
    for (let i = 0; i < 12; i += 1) {
      const r = await regionRead();
      if (r !== null && pred(r) === true) return r;
      await sleep(1000);
    }
    return null;
  };

  // AX-4①：sidebar 座位、面板收起（不点徽标）——新题到达仍播报、徽标计数＋1、
  // 焦点不动。锚点＝徽标按钮本身（用户正读侧栏的现实形态；React 原位更新该
  // 节点，身份跨重渲保持）。
  await patchSettings({ askUiSeat: 'sidebar' });
  await sleep(1800);
  const ax4PanelHidden = Number(await evaluate(page, 'document.querySelectorAll(".ats-ask-panel").length')) === 0;
  const badgeAnchor = await evaluate(page, `(() => {
    const b = document.querySelector('.ats-ask-badge');
    b?.focus();
    return b === null || b === undefined ? null : { focused: document.activeElement === b, count: b.querySelector('.ats-ask-count')?.textContent ?? '' };
  })()`);
  const ax4aBefore = await regionRead();
  const sidSize = await triggerSingleBatch('Pick a size');
  if (sidSize === null) fail('AX-4：单题批次两轮触发均未进 state（模型未调 ask_user_question）');
  const ax4a = await waitForRegion((r) => r.text === ANN_ZH);
  const ax4aBadge = await evaluate(page, `(() => {
    const b = document.querySelector('.ats-ask-badge');
    return b === null ? null : { stillFocused: document.activeElement === b, count: b.querySelector('.ats-ask-count')?.textContent ?? '' };
  })()`);
  check('AX-4① sidebar 收起态新题播报：区域文本→zh 数量句、徽标计数＋1、焦点保持、面板保持收起（区域常驻不受座位/收起门槛）',
    ax4a !== null && ax4PanelHidden === true && badgeAnchor !== null
      && ax4aBadge !== null && ax4aBadge.stillFocused === true
      && Number(ax4aBadge.count) === Number(badgeAnchor.count) + 1
      && Number(await evaluate(page, 'document.querySelectorAll(".ats-ask-panel").length')) === 0,
    `区域=${JSON.stringify(ax4a)}（前值=${JSON.stringify(ax4aBefore)}）徽标计数 ${String(badgeAnchor?.count)}→${String(ax4aBadge?.count)} 焦点保持=${String(ax4aBadge?.stillFocused)} 面板收起=${String(ax4PanelHidden)}`);

  // AX-5（去重）：批次在场期间重复轮询＋倒计时走秒重渲染——区域文本逐次不变。
  const ax5T0 = await regionRead();
  const leftT0 = await evaluate(page, `(() => {
    const el = document.querySelector('.ats-ask-panel .ats-ask-left, .ats-ask-badge');
    return el === null ? null : el.textContent;
  })()`);
  await sleep(2600); // ≥2×轮询间隔（1000ms）＋≥2 次走秒重渲染
  const ax5T1 = await regionRead();
  check('AX-5 播报去重：重复轮询与倒计时重渲染不重播（区域文本不变——读屏只读变化）',
    ax5T0 !== null && ax5T1 !== null && ax5T0.raw === ax5T1.raw,
    `区域文本 T0=${JSON.stringify(ax5T0?.raw)} T1=${JSON.stringify(ax5T1?.raw)}（2600ms 窗口，含 ≥2 轮轮询与走秒重渲染；倒计时读数 ${JSON.stringify(leftT0)} 属面板/徽标局部更新）`);

  // AX-4②：overlay 座位复跑——面板常显形态同样播报、焦点不动、全页无 assertive。
  await patchSettings({ askUiSeat: 'overlay' });
  await sleep(1800);
  const overlayAnchor = await evaluate(page, `(() => {
    const b = document.querySelector('.ats-ask-badge, #root button:not([disabled])');
    b?.focus();
    return b === null || b === undefined ? null : document.activeElement === b;
  })()`);
  const ax4bBefore = await regionRead();
  const sidShape = await triggerSingleBatch('Pick a shape');
  if (sidShape === null) fail('AX-4②：单题批次两轮触发均未进 state');
  const ax4b = await waitForRegion((r) => r.text === ANN_ZH && r.raw !== (ax4bBefore?.raw ?? ''));
  const ax4bFocus = await evaluate(page, `(() => ({
    panelVisible: document.querySelectorAll('.ats-ask-panel').length > 0,
    assertive: document.querySelectorAll('[aria-live="assertive"]').length
  }))()`);
  check('AX-4② overlay 座位新题播报：区域文本再更新（连续同文靠零宽空格交替保证文本有差）、面板常显、全页无 aria-live=assertive',
    ax4b !== null && ax4bFocus.panelVisible === true && ax4bFocus.assertive === 0 && overlayAnchor === true,
    `区域=${JSON.stringify(ax4b)}（前值=${JSON.stringify(ax4bBefore)}——原始文本已变）面板在场=${String(ax4bFocus.panelVisible)} assertive=${String(ax4bFocus.assertive)}`);

  // AX-6（语言）：uiLang=en 下新题→en 文案；切回 zh 后已冻结文本不被重写。
  await patchSettings({ uiLang: 'en' });
  await sleep(1500);
  const ax6Before = await regionRead();
  const sidPlace = await triggerSingleBatch('Pick a place');
  if (sidPlace === null) fail('AX-6：单题批次两轮触发均未进 state');
  const ax6En = await waitForRegion((r) => r.text === ANN_EN);
  await patchSettings({ uiLang: 'zh' });
  await sleep(1800);
  const ax6Frozen = await regionRead();
  check('AX-6 播报语言：uiLang=en 新题→en 数量句；切回 zh 后已冻结文本不变（语言切换不触发旧消息重播）',
    ax6En !== null && ax6Frozen !== null && ax6Frozen.text === ANN_EN,
    `en 档=${JSON.stringify(ax6En)}（前值=${JSON.stringify(ax6Before)}）切回 zh 后=${JSON.stringify(ax6Frozen)}（冻结）`);

  // ════════ IME-3/4/5：组合期提交限制（ASK-IME-SUBMIT-01）真实面板链 ════════
  const SIZE_TEXT = 'Pick a size';
  const SHAPE_TEXT = 'Pick a shape';
  // IME-3：组合期对提交钮的合成点击被拒——题仍 open、面板不消题。
  const ime3Setup = await evaluate(page, `(() => {
    const q = ${qExpr(SIZE_TEXT)};
    if (q === null) return false;
    q.querySelector('textarea.ats-ask-input')?.focus();
    return document.activeElement === q.querySelector('textarea.ats-ask-input');
  })()`);
  if (ime3Setup !== true) fail('IME-3 步骤：Pick a size 的 textarea 程序聚焦不可得');
  await page.send('Input.imeSetComposition', { text: '组词中答案', selectionStart: 5, selectionEnd: 5 });
  await sleep(500);
  const ime3Mid = await evaluate(page, `(() => {
    const q = ${qExpr(SIZE_TEXT)};
    return { composing: q?.getAttribute('data-composing') ?? '',
      disabled: q?.querySelector('.ats-ask-submit')?.disabled === true, qCount: document.querySelectorAll('.ats-ask-panel .ats-ask-q').length };
  })()`);
  await evaluate(page, `${qExpr(SIZE_TEXT)}?.querySelector('.ats-ask-submit')?.click(), true`);
  await sleep(700);
  const ime3After = await evaluate(page, `(() => {
    const q = ${qExpr(SIZE_TEXT)};
    return { qCount: document.querySelectorAll('.ats-ask-panel .ats-ask-q').length, composing: q?.getAttribute('data-composing') ?? '' };
  })()`);
  const ime3State = await rpc('async-tools-ask/state', {});
  check('IME-3 组合期动作被拒：合成 click 后题目仍在面板、state 仍列该题 open（被拒动作当场终结）',
    ime3Mid.composing === 'true' && ime3Mid.disabled === true
      && ime3After.qCount === ime3Mid.qCount && ime3After.composing === 'true'
      && ime3State.items.some((it) => (it.question ?? '').includes(SIZE_TEXT) === true),
    `组合中 data-composing=${String(ime3Mid.composing)} disabled=${String(ime3Mid.disabled)} 点击后题数 ${String(ime3Mid.qCount)}→${String(ime3After.qCount)} state 含该题=${String(ime3State.items.some((it) => (it.question ?? '').includes(SIZE_TEXT) === true))}`);

  // IME-4：失焦结束组合（onBlur 复位）→按有效性恢复 enabled、无自动提交；迟到
  // 合成 compositionend 幂等；显式点击后提交成行、转录含组合文本。
  await evaluate(page, `${qExpr(SIZE_TEXT)}?.querySelector('textarea.ats-ask-input')?.blur(), true`);
  await sleep(400);
  const ime4Blur = await evaluate(page, `(() => {
    const q = ${qExpr(SIZE_TEXT)};
    const input = q?.querySelector('textarea.ats-ask-input');
    return { composing: q?.getAttribute('data-composing') ?? '', disabled: q?.querySelector('.ats-ask-submit')?.disabled === true,
      value: String(input?.value ?? ''), qCount: document.querySelectorAll('.ats-ask-panel .ats-ask-q').length };
  })()`);
  await evaluate(page, `(() => {
    const input = ${qExpr(SIZE_TEXT)}?.querySelector('textarea.ats-ask-input');
    input?.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '组词中答案' }));
    return true;
  })()`);
  await sleep(400);
  const ime4End = await evaluate(page, `(() => {
    const q = ${qExpr(SIZE_TEXT)};
    return { composing: q?.getAttribute('data-composing') ?? '', disabled: q?.querySelector('.ats-ask-submit')?.disabled === true,
      qCount: document.querySelectorAll('.ats-ask-panel .ats-ask-q').length };
  })()`);
  await evaluate(page, `${qExpr(SIZE_TEXT)}?.querySelector('.ats-ask-submit')?.click(), true`);
  let ime4Gone = false;
  for (let i = 0; i < 10 && ime4Gone === false; i += 1) {
    await sleep(700);
    ime4Gone = (await evaluate(page, `${qExpr(SIZE_TEXT)} === null`)) === true;
  }
  let ime4TranscriptHit = false;
  try {
    const page4 = await transcriptOf(sidSize);
    ime4TranscriptHit = JSON.stringify(page4).includes('组词中答案');
  } catch { /* 转录读取失败按未命中留痕，不阻塞 */ }
  check('IME-4 失焦结束组合不补发＋重校验＋再提交：blur 后按有效性恢复 enabled、无自动提交；迟到 compositionend 幂等；显式提交成行且转录含组合文本',
    ime4Blur.composing === 'false' && ime4Blur.disabled === false && ime4Blur.qCount === ime3After.qCount
      && ime4End.composing === 'false' && ime4End.disabled === false && ime4End.qCount === ime4Blur.qCount
      && ime4Gone === true && ime4TranscriptHit === true,
    `blur 后 composing=${String(ime4Blur.composing)} disabled=${String(ime4Blur.disabled)}（无自动提交题数 ${String(ime4Blur.qCount)}）；合成 end 后 disabled=${String(ime4End.disabled)}；显式提交后该题离场=${String(ime4Gone)} 转录含组合文=${String(ime4TranscriptHit)} 终值=${JSON.stringify(ime4Blur.value.slice(0, 16))}`);

  // IME-5（隔离）：题 A 组合中——A 的「不答」可用且提交禁用；题 B 有效选中不受 A 组合影响。
  const ime5Setup = await evaluate(page, `(() => {
    const b = ${qExpr(Q2_TEXT)};
    b?.querySelectorAll('button.ats-ask-opt')[0]?.click();
    const a = ${qExpr(SHAPE_TEXT)};
    a?.querySelector('textarea.ats-ask-input')?.focus();
    return { bSelected: b?.querySelector('button.ats-ask-opt')?.getAttribute('data-selected') ?? '',
      aFocused: document.activeElement === a?.querySelector('textarea.ats-ask-input') };
  })()`);
  if (ime5Setup.aFocused !== true) fail('IME-5 步骤：Pick a shape 的 textarea 程序聚焦不可得');
  await page.send('Input.imeSetComposition', { text: '隔离组合', selectionStart: 4, selectionEnd: 4 });
  await sleep(500);
  const ime5Mid = await evaluate(page, `(() => {
    const a = ${qExpr(SHAPE_TEXT)};
    const b = ${qExpr(Q2_TEXT)};
    return { aComposing: a?.getAttribute('data-composing') ?? '', aSubmit: a?.querySelector('.ats-ask-submit')?.disabled === true,
      aSkipDisabled: a?.querySelector('.ats-ask-skip')?.disabled === true,
      bSubmit: b?.querySelector('.ats-ask-submit')?.disabled === true };
  })()`);
  await evaluate(page, `${qExpr(SHAPE_TEXT)}?.querySelector('.ats-ask-skip')?.click(), true`);
  let ime5Skipped = false;
  for (let i = 0; i < 10 && ime5Skipped === false; i += 1) {
    await sleep(700);
    ime5Skipped = (await evaluate(page, `${qExpr(SHAPE_TEXT)} === null`)) === true;
  }
  check('IME-5 多题隔离：组合中「不答」可用（该题出列）；他题有效提交不受本题组合影响',
    ime5Setup.bSelected === 'true' && ime5Mid.aComposing === 'true' && ime5Mid.aSubmit === true
      && ime5Mid.aSkipDisabled === false && ime5Mid.bSubmit === false && ime5Skipped === true,
    `题 B 选中=${String(ime5Setup.bSelected)}；题 A 组合中：data-composing=${String(ime5Mid.aComposing)} 提交禁用=${String(ime5Mid.aSubmit)} 不答禁用=${String(ime5Mid.aSkipDisabled)}；题 B 提交可用=${String(ime5Mid.bSubmit === false)}；组合中不答后 A 离场=${String(ime5Skipped)}`);
} catch (error) {
  cleanup();
  fail(`未预期异常：${String(error?.stack ?? error)}`);
}
cleanup();

let head = '';
try { head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(); } catch { /* 无 git 环境 */ }
const SCENE_NOTES = {
  'a11y-ax-panel-wide': 'AX 系列证据帧：宽幅面板全景顶锚（AX-1/2/3 断言时的画面形态；Tab 走查后内部滚动已复位到顶、焦点已 blur）',
  'a11y-ime-composing': 'IME 系列证据帧：Q1 输入框组合输入进行中（拼音组合中文本在场、自定义项选中）',
  'a11y-sk-shrunk-q1': 'SK 系列证据帧：390×400 收缩视口（键盘遮屏近似）Q1 滚动位——提交钮与输入框可见',
  'a11y-sk-shrunk-q2': 'SK 系列证据帧：390×400 收缩视口（键盘遮屏近似）Q2 滚动位——提交钮与输入框可见'
};
writeFileSync(join(LOGS, 'a11y-input.json'), JSON.stringify({
  at: new Date().toISOString(), repo, head, hostVersion, failed, results,
  shots, sceneNotes: Object.fromEntries(shots.map((n) => [n, SCENE_NOTES[n.replace(/\.png$/, '')] ?? '']))
}, null, 2));
log(`证据落盘：${join(LOGS, 'a11y-input.json')}（截图 ${String(shots.length)} 张在 shots/）`);
console.log(`\n判定：${failed === 0 ? '全部通过' : `存在 FAIL（${String(failed)} 项）`}`);
process.exit(failed === 0 ? 0 : 1);
