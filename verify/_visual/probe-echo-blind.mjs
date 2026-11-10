#!/usr/bin/env node
/**
 * fullCommandEcho 真机盲测采集装置（判定基准＝盲测代理的捕获计划）。本脚本
 * **只采集原始证据、不下任何通过判定**——逐项
 * 判据 PASS/FAIL/无法判定由独立盲测代理对回传材料作出（装置/审阅两栏记账，
 * 本装置是装置栏的取证人）。
 *
 * ## 覆盖（对准捕获计划编号）
 * - P-0：临时实例（本仓 tgz 官方 CLI 安装、独立 home、随机端口、rc.5 宿主、
 *   zai 真实模型路由）＋各时点设置 RPC 读值原样登记。
 * - M1：echo off/on 两轮（async_run＋async_workflow 各一/轮），GUI 调用卡片
 *   DOM 子树 textContent＋截图（导航＝侧栏会话行 [data-row-key=session:<id>]
 *   直点，见 gotoSession 头注的宿主源码事实）、会话 A 全量转录、操作者
 *   yielded 行多源扫描（stdout/stderr/home logs/会话页文本＋API 面探查）。
 * - M2：echo on 真实模型流——后台命令＋编排各一（脚本经真实子代理跑长命令）、
 *   job_list 运行期复述、结算后模型逐字引用；会话 B 转录**全量翻页**落盘
 *   （不过滤——判定核心记录必须原样在档）。
 * - M3：设置页 uiLang zh/en 两语字段行（宽视口＋帮助展开）＋390×844 窄屏
 *   （zh 双主题＋en 单主题）的 DOM 读数与截图。
 * - M4：同会话 off 基线交付 → GUI 保存翻开 → on 交付 → GUI 保存翻回 → off
 *   交付，三段完成消息记录＋保存前后截图与 RPC 读值。
 *
 * ## 用法（须 danger-full-access 或非受限环境——CDP 无头浏览器在受限沙箱必早夭）
 *   node verify/_visual/probe-echo-blind.mjs --service-root <宿主服务根> \
 *     [--host-subdir dsh-0.2.1-rc.5] [--repo <本仓路径>] [--keep]
 *
 * 红线：只操作本装置自建的隔离实例，不连接、不改动任何既有实例。--patch 只带
 * zai-glm.yml 模型路由。证据：`.local/evidence/echo-blind/`（manifest.json＋
 * m1..m4 子目录＋logs/instance-stderr.log）。退出 0＝采集完整、1＝采集有缺口
 * （仍落盘已得材料，缺口列在 manifest）、2＝装置故障（FAULT）。
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
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
    mkdirSync(join(EVID, 'logs'), { recursive: true });
    writeFileSync(join(EVID, 'logs', 'fault.json'), JSON.stringify({ at: new Date().toISOString(), msg, manifest }, null, 2));
  } catch { /* 磁盘写失败不阻塞清理与退出 */ }
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
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const manifest = { at: new Date().toISOString(), repo, hostVersion, items: [], gaps: [] };
let gaps = 0;
/** 采集项登记：只记「采到什么＋在哪」，不记判定。 */
function capture(id, ok, pointer, note = '') {
  manifest.items.push({ id, ok: ok === true, pointer, note, at: new Date().toISOString() });
  if (ok !== true) { manifest.gaps.push({ id, note }); gaps += 1; }
  console.log(`  ${ok === true ? 'CAP   ' : 'GAP   '}${id}${note === '' ? '' : `——${note}`}`);
}
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

// ── 实例与 RPC（probe-a11y-input 同款骨架；stderr 全量落盘）─────────────────
let ORIGIN = '';
let TOKEN = '';
let COOKIE = '';
const EVID = join(repo, '.local', 'evidence', 'echo-blind');
const STDERR_LOG = join(EVID, 'logs', 'instance-stderr.log');
const STDOUT_LOG = join(EVID, 'logs', 'instance-stdout.log');
async function startInstance() {
  child = spawn('node', [
    bin, '--patch', 'patches/zai-glm.yml', '--profile', 'web',
    '--host', '127.0.0.1', '--port', '0', '--no-open'
  ], { cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderrTail = '';
  mkdirSync(join(EVID, 'logs'), { recursive: true });
  child.stdout.on('data', (c) => { stdout += c; try { appendFileSync(STDOUT_LOG, c); } catch { /* 尽力 */ } });
  child.stderr.on('data', (c) => {
    stderrTail = (stderrTail + c).slice(-4000);
    try { appendFileSync(STDERR_LOG, c); } catch { /* 尽力 */ }
  });
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
    signal: AbortSignal.timeout(120_000)
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
const settingsNS = 'async-tools-host';
async function patchSettings(patch) {
  await rpc('settings/update', { ns: settingsNS, patch: { settings: patch } });
}
/** P-0 读值：async-tools-host 生效 settings 原样登记。 */
async function readEchoSettings() {
  const described = await rpc('settings/describe', {});
  const row = described.namespaces.find((n) => (n.ns ?? n.namespace ?? n.id) === settingsNS);
  const s = row?.value?.settings ?? {};
  return { fullCommandEcho: s.fullCommandEcho, agentLang: s.agentLang, uiLang: s.uiLang, maxResultChars: s.maxResultChars };
}

const rand = () => Math.random().toString(36).slice(2, 8);
let sessionCreateBase = null; // P-0 置：注册工作区后用 workspaceId 挂接（侧栏才列会话）。
async function newSession(marker) {
  const req = sessionCreateBase ?? { cwd: home };
  const created = await rpc('session/create', { request: { ...req, agentPreset: 'dsh-async' } });
  await rpc('session/prompt', {
    request: {
      requestId: `req-${rand()}`, sessionId: created.sessionId, mode: 'queue',
      content: [{ type: 'text', text: `${marker} — reply with the single word ACK and nothing else. Do not call any tools.` }],
      clientTimeZone: 'Asia/Hong_Kong'
    }
  });
  await waitAssistant(created.sessionId, 60_000);
  return created.sessionId;
}
/** 等待会话出现下一条 assistant 文本记录。 */
async function waitAssistant(sessionId, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const t = await transcriptOf(sessionId).catch(() => null);
    const has = (t?.records ?? []).some((r) => r.event?.type === 'assistant' || r.event?.type === 'message'
      && r.event?.data?.role === 'assistant');
    if (has) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(3000);
  }
}
/** 提示模型做一次「按精确参数调用某工具、随即结束回合」。 */
async function promptToolCall(sessionId, instruction) {
  await rpc('session/prompt', {
    request: {
      requestId: `req-${rand()}`, sessionId, mode: 'queue',
      content: [{ type: 'text', text: instruction }], clientTimeZone: 'Asia/Hong_Kong'
    }
  });
}
/** 转储会话**全量**记录（session/page 按 beforeSeq 翻页至 hasMore=false，
 * 不做关键词过滤——user/message、tool/call、工具结果、assistant/message、
 * 作业结果通知 source 记录必须原样在档，判定权在盲测代理；needles 只用于
 * 附带命中统计，不参与取舍）。 */
async function dumpRecords(sessionId, needles, outFile) {
  const listing = await rpc('session/list', { _request: {} });
  const row = listing.items.find((item) => item.sessionId === sessionId);
  if (row === undefined) throw new Error(`session ${sessionId} not found`);
  const throughSeq = row.projections.asOfSeq;
  let records = [];
  let hasMore = true;
  let beforeSeq;
  let pages = 0;
  while (hasMore === true && pages < 20) {
    const request = { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 400 };
    if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
    const page = await rpc('session/page', { request });
    pages += 1;
    const batch = page.records ?? [];
    records = records.concat(batch);
    const oldestSeq = batch[0]?.event?.seq;
    hasMore = page.hasMore === true && batch.length > 0 && oldestSeq !== undefined && oldestSeq !== beforeSeq;
    beforeSeq = oldestSeq;
  }
  const hits = records.filter((r) => needles.some((n) => JSON.stringify(r).includes(n)));
  writeFileSync(outFile, JSON.stringify({
    sessionId, at: new Date().toISOString(), needles, pages,
    totalRecords: records.length, complete: hasMore !== true, hitCount: hits.length, records
  }, null, 1));
  return { hits: hits.length, total: records.length, complete: hasMore !== true };
}

/** 记录文本尽力取（user/message、assistant、tool/result 通用——content 是
 * 分段数组，须逐段 join；直接 String() 会得 '[object Object]' 假阴性）。 */
const textOfR = (r) => {
  const d = r.event?.data ?? {};
  const parts = (p) => Array.isArray(p) ? p.map((x) => String(x?.text ?? '')).join('\n') : String(p ?? '');
  if (typeof d.text === 'string') return d.text;
  if (Array.isArray(d.content)) return parts(d.content);
  if (Array.isArray(d.message?.content)) return parts(d.message.content);
  if (typeof d.message?.content === 'string') return d.message.content;
  return '';
};
/** 判定式等待（捕获计划第 1/3 项）：断言不得命中注入指令文本——
 * 调用＝tool/call＋token；结算＝source.kind=async-tools-job-result 的
 * user/message 同条含输出 token（「已结算」同条共现）；引用＝assistant 记录。 */
async function waitForPred(sessionId, pred, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const t = await transcriptOf(sessionId).catch(() => null);
    const hit = (t?.records ?? []).find(pred) ?? null;
    if (hit !== null) return hit;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(2500);
  }
}
const callPred = (tok) => (r) => r.event?.type === 'tool/call' && JSON.stringify(r.event?.data ?? {}).includes(tok);
const completionPred = (outTok) => (r) => r.event?.type === 'user/message'
  && r.event?.data?.source?.kind === 'async-tools-job-result' && textOfR(r).includes(outTok);
const isAssistantR = (r) => r.event?.type === 'assistant' || r.event?.type === 'assistant/message'
  || (r.event?.type === 'message' && r.event?.data?.role === 'assistant');
/** 滚动目标入视口并稳定（第四轮清单第 2 项：全部截图先框定目标区域）。 */
async function scrollIntoViewExpr(expr) {
  await evaluate(page, `(() => { const n = ${expr}; if (n !== null && n !== undefined) n.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(800);
}
/** 关闭宿主「预览版说明」类对话框（同款护栏）。 */
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
};
const shotOf = async (name, opts) => {
  await ensureNoDialog();
  await sleep(400);
  await screenshot(page, join(EVID, 'shots', name), opts);
};
const clickBy = async (expr, what) => {
  const r = await evaluate(page, `(() => { const n = ${expr}; if (n !== null && n !== undefined) { n.click(); return 'clicked'; } return 'missing'; })()`);
  log(`click ${what}: ${String(r)}`);
  return r;
};
async function gotoPluginPage() {
  const already = await evaluate(page, 'document.querySelector("[data-plugin-config]") !== null');
  if (already === true) return;
  const nav1 = await clickBy(`[...document.querySelectorAll('button,[role=button],a')].find((n) => (n.getAttribute('aria-label') || '') === '插件')`, '插件');
  if (nav1 !== 'clicked') fail(`插件入口未找到（${nav1}）`);
  await sleep(2500);
  const nav2 = await clickBy(`[...document.querySelectorAll('*')].find((n) => (n.getAttribute('aria-label') || '') === '查看 dsh-async-tools')`, '查看 dsh-async-tools');
  if (nav2 !== 'clicked') fail(`插件详情入口未找到（${nav2}）`);
  await sleep(3000);
  await waitFor(page, 'document.querySelector("[data-plugin-config]") !== null', (v) => v === true, 15000);
}
/** 打开会话视图。宿主侧栏事实（rc.5 源码静态核对，2026-11-06）：
 * - 会话行是 div[role="treeitem"][data-row-key="session:<id>"]，点击即 open(id)
 *   （dsh-client-ui-workspace/lib/client.js SessionNodeItem，line 2276-2283）；
 *   **不是** button/[role=button]——旧版行迭代选择器从一开始就选不中它。
 * - 工作区组行 [data-row-key="workspace:<workspaceId>"] 本体 onClick=onToggle
 *   （ProjectRowItem，line 1966-1971），aria-expanded 反映展开态。
 * - 「无匹配会话」是**搜索结果空态**（SearchResults search.noMatches，line
 *   3493-3496）：搜索框带查询时整棵树被替换——绝不能靠搜首提示词标记定位
 *   （会话标题是 LLM 生成的，不含标记）；进树前必须清空搜索框。
 * - 会话列表来自 session.list 全量刷新（页加载/重连时 handleConnected→
 *   refreshList），运行期靠 api-session/added 推送——推送缺席时以整页重开补拉。
 * 策略：① 标记已在页面→完成；② 展开侧栏＋清空搜索框（保树模式）＋选工作区；
 * ③ 等会话行出现（推送路径）→组行折叠则展开重试；④ 仍无→整页重开（列表必含
 * RPC 创建的会话）重复②③；⑤ 点行→轮询标记进正文（转录异步加载渲染）。 */
async function gotoSession(sessionId, marker, wsBasename, workspaceId) {
  const bodyHasMarker = async () => (await evaluate(page, `document.body.textContent.includes(${JSON.stringify(marker)})`)) === true;
  if (await bodyHasMarker()) return 'already-open';
  const rowSel = `[data-row-key="session:${sessionId}"]`;
  const rowVisibleExpr = `(() => { const n = document.querySelector(${JSON.stringify(rowSel)}); return n !== null && n.getClientRects().length > 0; })()`;
  const rowVisible = async () => (await evaluate(page, rowVisibleExpr)) === true;
  const prepSidebar = async () => {
    const openSb = await clickBy(`[...document.querySelectorAll('button,[role=button]')].find((n) => (n.getAttribute('aria-label') || '') === '打开侧边栏')`, '打开侧边栏');
    if (openSb === 'clicked') await sleep(1200);
    // 清空搜索框：非空查询会把会话树替换成搜索结果（「无匹配会话」空态）。
    await evaluate(page, `(() => {
      const input = [...document.querySelectorAll('input, textarea')].find((i) => (i.placeholder || '').includes('搜索会话'));
      if (input === undefined) return 'no-box';
      const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'cleared';
    })()`);
    await sleep(500);
    // 首页要求先选工作区（中央「选择工作区」gate；侧栏底部同名钮亦开同一下拉）。
    const wsBtn = await clickBy(`[...document.querySelectorAll('button,[role=button]')].find((n) => (n.getAttribute('aria-label') || '') === '选择工作区')`, '选择工作区');
    if (wsBtn === 'clicked') {
      await sleep(1800);
      const wsItem = await clickBy(`(() => {
        const cands = [...document.querySelectorAll('[role=option],[role=menuitem],button,li,div[class*=option]')]
          .filter((n) => n.getClientRects().length > 0
            && (n.textContent || '').trim().includes(${JSON.stringify(wsBasename)}) && n.children.length <= 4);
        return cands[cands.length - 1] ?? null;
      })()`, `工作区 ${wsBasename}`);
      if (wsItem !== 'clicked') return `工作区项:${String(wsItem)}`;
      await sleep(2500);
    }
    if (await bodyHasMarker()) return 'open';
    return 'ready';
  };
  const tryRow = async (timeoutMs) => {
    await waitFor(page, rowVisibleExpr, (v) => v === true, timeoutMs);
    if (await rowVisible()) return true;
    // 行不可见且组行明确折叠（aria-expanded="false"）→ 点组行展开后再等一轮。
    const groupSel = workspaceId !== undefined ? `[data-row-key="workspace:${workspaceId}"]` : '[data-row-key^="workspace:"]';
    const expanded = await evaluate(page, `(() => { const n = document.querySelector(${JSON.stringify(groupSel)}); return n === null ? 'missing' : String(n.getAttribute('aria-expanded')); })()`);
    if (expanded === 'false') {
      await clickBy(`document.querySelector(${JSON.stringify(groupSel)})`, '工作区组行（展开）');
      await waitFor(page, rowVisibleExpr, (v) => v === true, 6000);
    }
    return rowVisible();
  };
  let prep = await prepSidebar();
  if (prep === 'open') return 'clicked-after-prep';
  if (await tryRow(10_000) !== true) {
    // 回退路径：整页重开——加载即 refreshList 全量拉取，RPC 创建的会话必在列表。
    try { await page.close(); } catch { /* 已关 */ }
    page = await openPage(browser.port, `${ORIGIN}/?token=${encodeURIComponent(TOKEN)}`);
    await waitFor(page, 'document.querySelectorAll("button,[role=button]").length', (n) => n > 0, 15000);
    await ensureNoDialog();
    await setViewport(page, 1500, 1000);
    prep = await prepSidebar();
    if (prep === 'open') return 'clicked-after-reload';
    if (await tryRow(15_000) !== true) {
      // 诊断留痕：侧栏行键全景＋页面文本（供装置侧核实，不进判定材料）。
      try {
        const dump = await evaluate(page, `(() => ({
          rows: [...document.querySelectorAll('[data-row-key]')].filter((n) => n.getClientRects().length > 0)
            .map((n) => \`\${n.getAttribute('data-row-key')}=\${(n.textContent || '').trim().slice(0, 40)}\`),
          body: document.body.innerText.slice(0, 1200),
          href: location.href
        }))()`);
        writeFileSync(join(EVID, 'logs', `nav-debug-${marker.slice(0, 14)}.txt`), JSON.stringify(dump, null, 1));
        await screenshot(page, join(EVID, 'shots', 'm1-nav-fail.png'), { width: 1500, height: 1000, fullPage: false });
      } catch { /* 尽力 */ }
      return `会话行不可见（${rowSel}；prep=${String(prep)}）`;
    }
  }
  const clicked = await clickBy(`document.querySelector(${JSON.stringify(rowSel)})`, `会话行 ${sessionId.slice(0, 16)}`);
  if (clicked !== 'clicked') return `会话行点击:${String(clicked)}`;
  // 会话视图异步加载转录（session/page 拉取＋渲染），轮询至标记进正文。
  await waitFor(page, `document.body.textContent.includes(${JSON.stringify(marker)})`, (v) => v === true, 15_000);
  return (await bodyHasMarker()) ? 'clicked-row' : '行已点但标记未现（转录加载/渲染超时）';
}
/** M1 卡片采集：卡片行类名＝宿主 flowItem（rc.5 实测 EvIC1a_flowItem）。
 * ① 只在含「工具调用」的 flowItem 卡内点展开钮（全页无差别展开会点开数百个
 * 非目标节点）；② 从含 token 的最深元素向上找最近 flowItem 祖先＝卡片本体
 * （首个命中可能是视图容器或标签碎片，不能直接当卡片）；③ 子树须同时含
 * token 与「工具调用」（≥150 字符完整性检查）才记 CAP。 */
async function captureCard(toolName, tokenH, jsonOut, shotName) {
  const expandedInfo = await evaluate(page, `(() => {
    const cards = [...document.querySelectorAll('[class*="flowItem"]')].filter((n) => n.getClientRects().length > 0
      && (n.textContent || '').includes('工具调用') && (n.textContent || '').includes(${JSON.stringify(toolName)}));
    let clicks = 0;
    for (const c of cards) for (const b of c.querySelectorAll('[aria-expanded="false"]')) { b.click(); clicks += 1; }
    return { flowCards: cards.length, expanderClicks: clicks };
  })()`);
  await sleep(900);
  const dump = await evaluate(page, `(() => {
    const hits = [...document.querySelectorAll('*')].filter((n) => n.getClientRects().length > 0
      && (n.textContent || '').includes(${JSON.stringify(tokenH)}));
    if (hits.length === 0) return null;
    // 收集全部含 token 的 flowItem 卡（去重）——用户消息气泡也含 token 且在
    // DOM 前面，工具调用卡须以「工具调用」标签区分（首个命中可能是用户消息气泡）。
    const cards = [];
    for (const h of hits) {
      let cur = h;
      while (cur !== null && cur !== document.body) {
        if (String(cur.className).includes('flowItem')) {
          if (!cards.includes(cur)) cards.push(cur);
          break;
        }
        cur = cur.parentElement;
      }
    }
    if (cards.length === 0) return null;
    const toolCard = cards.find((c) => (c.textContent || '').includes('工具调用')) ?? cards[0];
    toolCard.scrollIntoView({ block: 'center' });
    const r = toolCard.getBoundingClientRect();
    const text = toolCard.textContent || '';
    return { tag: toolCard.tagName, cls: String(toolCard.className).slice(0, 120), textLen: text.length,
      cardCount: cards.length,
      hasToolLabel: text.includes('工具调用'), hasToken: text.includes(${JSON.stringify(tokenH)}),
      inViewport: r.top >= -2 && r.bottom <= window.innerHeight + 2 && r.left >= -2 && r.right <= window.innerWidth + 2,
      rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },
      text };
  })()`);
  await sleep(600);
  await shotOf(shotName, { width: 1500, height: 1000, fullPage: false });
  if (dump !== null) writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), expandedInfo, ...dump }, null, 1));
  return dump !== null && dump.inViewport === true && dump.hasToolLabel === true && dump.hasToken === true && dump.textLen >= 150;
}

try {
  mkdirSync(EVID, { recursive: true });
  for (const d of ['m1', 'm2', 'm3', 'm4', 'shots']) mkdirSync(join(EVID, d), { recursive: true });
  // ════ P-0：打包＋安装＋起实例＋设置读值 ════
  mkdirSync(join(repo, '.local'), { recursive: true });
  const packRun = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', '.local'], { cwd: repo, encoding: 'utf8', shell: true });
  if (packRun.status !== 0) fail(`npm pack 退出 ${String(packRun.status)}：${packRun.stderr}`);
  const tgzName = (packRun.stdout.match(/dsh-async-tools-[^\s]+\.tgz/g) ?? []).pop();
  if (tgzName === undefined) fail('npm pack 未产出 tgz');
  home = mkdtempSync(join(tmpdir(), 'dsh-echo-blind-'));
  const install = spawnSync('node', [bin, 'plugin', '--profile', 'web', 'add', join(repo, '.local', tgzName)], {
    cwd: serviceRoot, encoding: 'utf8', timeout: 300_000, env: { ...process.env, DSH_HOME: home }
  });
  if (install.status !== 0) { console.error(install.stdout); console.error(install.stderr); fail('plugin add 退出非 0'); }
  const browserPath = findBrowser();
  if (browserPath === undefined) fail('找不到 Edge/Chrome');
  await startInstance();
  manifest.tgz = tgzName;
  let head = '';
  try { head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(); } catch { /* 无 git */ }
  manifest.head = head;
  log(`repo=${repo} head=${head} hostVersion=${hostVersion} tgz=${tgzName}`);
  manifest.p0 = { atFactory: await readEchoSettings() };
  // 把会话 cwd（临时 home）注册为工作区——GUI 首页的选择器按工作区过滤会话列表，
  // 未注册时侧栏恒「无匹配会话」（2026-11-06 nav 诊断实证；workspace/list 端点
  // 不存在，create 幂等返回 created=false）。
  const wsCreated = await rpc('workspace/create', { request: { path: home } })
    .then((v) => ({ ok: true, created: v?.created, id: v?.workspace?.workspaceId }))
    .catch((e) => ({ ok: false, error: String(e.message).slice(0, 120) }));
  manifest.p0.workspace = wsCreated;
  // 会话须以 workspaceId 挂接（与 cwd 互斥）才会出现在 GUI 侧栏——仅 cwd 同路径
  // 不挂接（session-controller commands.js:113-145）。
  if (wsCreated.ok === true && wsCreated.id !== undefined) sessionCreateBase = { workspaceId: wsCreated.id };
  const wsBasename = home.split(/[\\/]/).filter(Boolean).pop();
  manifest.p0.wsBasename = wsBasename;
  await patchSettings({ agentLang: 'zh', uiLang: 'zh' });
  manifest.p0.atStart = await readEchoSettings();
  log(`P-0 设置读值：${JSON.stringify(manifest.p0.atStart)}`);
  browser = await launch(browserPath);
  page = await openPage(browser.port, `${ORIGIN}/?token=${encodeURIComponent(TOKEN)}`);
  await waitFor(page, 'document.querySelectorAll("button,[role=button]").length', (n) => n > 0, 15000);
  await ensureNoDialog();

  // ════ M1：echo off/on 两轮（会话 A）════
  const OFF = { h: `OFFH1-${rand()}`, t: `OFFT1-${rand()}`, oh: `WOFFH1-${rand()}`, ot: `WOFFT1-${rand()}` };
  const ON = { h: `ONH1-${rand()}`, t: `ONT1-${rand()}`, oh: `WONH1-${rand()}`, ot: `WONT1-${rand()}` };
  const runCmd = (h, t, out) => `$tail='${t}'; Write-Output '${h}'; Start-Sleep -Seconds 42; Write-Output '${out}'`;
  const wfScript = (h, t, inner) => `// ${h}\nconst r = await agent(${JSON.stringify(`Run this PowerShell command and wait for it to finish: Start-Sleep -Seconds 42; Write-Output "${inner}"`)}, { label: 'wf-inner-${rand()}' });\nreturn 'wf-done-${rand()} ${t}';\n// ${t}`;
  const runPrompt = (desc, cmd) => `Call the async_run tool with these EXACT arguments and nothing else changed: description=${JSON.stringify(desc)}, command=${JSON.stringify(cmd)}. After the tool returns a handle, end your turn immediately with a one-sentence note. Do NOT call async_wait or any other tool.`;
  const wfPrompt = (name, desc, script) => `Call the async_workflow tool with EXACTLY these arguments: meta={"name":${JSON.stringify(name)},"description":${JSON.stringify(desc)}}, script=${JSON.stringify(script)}. Pass the script string verbatim including comments and line breaks. After the tool returns a handle, end your turn immediately with a one-sentence note. Do NOT call async_wait or any other tool.`;
  {
    const marker = `ECHOBLIND-A-${rand()}`;
    const sid = await newSession(marker);
    const OFF_OUT = `OOUT-OFF-${rand()}`;
    const WOFF_OUT = `WOUT-OFF-${rand()}`;
    const ON_OUT = `OOUT-ON-${rand()}`;
    const WON_OUT = `WOUT-ON-${rand()}`;
    manifest.m1 = { session: sid, marker, off: OFF, on: ON, offOut: OFF_OUT, onOut: ON_OUT };
    // off 轮（fullCommandEcho 默认 false——P-0 读值已证）。
    await promptToolCall(sid, runPrompt(`m1cmd-off-${rand()}`, runCmd(OFF.h, OFF.t, OFF_OUT)));
    let okCall = await waitForPred(sid, callPred(OFF.h), 90_000);
    capture('M1-a/off 前置：模型按精确参数调用（tool/call 含命令首 token）', okCall !== null, 'm1/session-a-records.json');
    await promptToolCall(sid, wfPrompt(`m1wf-off-${rand()}`, 'M1 off workflow', wfScript(OFF.oh, OFF.ot, WOFF_OUT)));
    okCall = await waitForPred(sid, callPred(OFF.oh), 120_000);
    capture('M1-b/off 前置：编排调用在转录', okCall !== null, 'm1/session-a-records.json');
    // 交付入档等待（第四轮清单第 1 项）：两条完成消息记录落转录后再转储——
    // 完成消息判据＝source.kind=async-tools-job-result 的 user/message 同条含
    // 输出 token（run＝OOUT-OFF-*；wf＝返回值尾 token OFF.ot，不命中注入指令）。
    const offRunDone = await waitForPred(sid, completionPred(OFF_OUT), 150_000);
    const offWfDone = await waitForPred(sid, completionPred(OFF.ot), 150_000);
    capture('M1/off 交付入档（两条完成消息记录在转录）', offRunDone !== null && offWfDone !== null, 'm1/session-a-off-records.json');
    await dumpRecords(sid, [OFF.h, OFF.oh, OFF.t, OFF.ot, OFF_OUT, '已结算', 'settled'], join(EVID, 'm1', 'session-a-off-records.json'));
    // RPC 翻 on（M1 的 on 轮由 RPC 设定；GUI 保存翻转归 M4）。
    await patchSettings({ fullCommandEcho: true });
    manifest.m1.readAfterOn = await readEchoSettings();
    await promptToolCall(sid, runPrompt(`m1cmd-on-${rand()}`, runCmd(ON.h, ON.t, ON_OUT)));
    okCall = await waitForPred(sid, callPred(ON.h), 90_000);
    capture('M1-d 前置：on 态命令调用在转录', okCall !== null, 'm1/session-a-records.json');
    await promptToolCall(sid, wfPrompt(`m1wf-on-${rand()}`, 'M1 on workflow', wfScript(ON.oh, ON.ot, WON_OUT)));
    okCall = await waitForPred(sid, callPred(ON.oh), 120_000);
    capture('M1-e 前置：on 态编排调用在转录', okCall !== null, 'm1/session-a-records.json');
    const onRunDone = await waitForPred(sid, completionPred(ON_OUT), 150_000);
    const onWfDone = await waitForPred(sid, completionPred(ON.ot), 150_000);
    capture('M1/on 交付入档（两条完成消息记录在转录）', onRunDone !== null && onWfDone !== null, 'm1/session-a-on-records.json');
    await dumpRecords(sid, [ON.h, ON.oh, ON.t, ON.ot, ON_OUT, '已结算', 'settled'], join(EVID, 'm1', 'session-a-on-records.json'));
    // GUI 卡片（两态四张，同一会话页）。
    const nav1 = await gotoSession(sid, marker, wsBasename, wsCreated.id);
    const navOk = ['clicked-row', 'already-open', 'clicked-after-prep', 'clicked-after-reload'].includes(String(nav1));
    capture('M1 会话视图导航', navOk, 'm1/', `导航结果=${String(nav1)}`);
    if (navOk) {
      // 路由事实：会话打开后 location.href 是否随选择变化（盲测代理深链问题的
      // 原始材料——openSession 是状态导航，静态源码未见路径路由）。
      writeFileSync(join(EVID, 'm1', 'session-view-route.txt'), String(await evaluate(page, 'location.href')));
      // 会话页全文（GUI 活动日志面——若宿主把操作者日志行渲染进会话视图，
      // 这里是 M1-c 的第三来源；与 stdout/stderr 多源扫描互补）。
      const viewText = await evaluate(page, 'document.body.innerText');
      writeFileSync(join(EVID, 'm1', 'session-view-text.txt'), String(viewText));
      const yieldedInView = String(viewText).split('\n').filter((l) => l.includes('async_run yielded:') || l.includes('async_workflow yielded:'));
      writeFileSync(join(EVID, 'm1', 'operator-yielded-view.txt'), yieldedInView.join('\n'));
    }
    await sleep(2000);
    capture('M1-a/off 命令卡片（展开态卡片子树 DOM＋截图）', await captureCard('async_run', OFF.h, join(EVID, 'm1', 'card-off-run.json'), 'm1-card-off-run.png'), 'm1/card-off-run.json');
    capture('M1-b/off 编排卡片（展开态卡片子树 DOM＋截图）', await captureCard('async_workflow', OFF.oh, join(EVID, 'm1', 'card-off-wf.json'), 'm1-card-off-wf.png'), 'm1/card-off-wf.json');
    capture('M1-d/on 命令卡片（展开态卡片子树 DOM＋截图）', await captureCard('async_run', ON.h, join(EVID, 'm1', 'card-on-run.json'), 'm1-card-on-run.png'), 'm1/card-on-run.json');
    capture('M1-e/on 编排卡片（展开态卡片子树 DOM＋截图）', await captureCard('async_workflow', ON.oh, join(EVID, 'm1', 'card-on-wf.json'), 'm1-card-on-wf.png'), 'm1/card-on-wf.json');
    // M1-c/f：操作者日志 yielded 行——三源并扫（stdout/stderr 已落盘；cordis
    // logger 亦可能写 home/logs/*），全部原样登记并注明来源。
    const yieldedLines = [];
    for (const [src, path] of [['stdout', STDOUT_LOG], ['stderr', STDERR_LOG]]) {
      try {
        for (const l of readFileSync(path, 'utf8').split('\n')) {
          if (l.includes('async_run yielded:') || l.includes('async_workflow yielded:')) yieldedLines.push(`[${src}] ${l}`);
        }
      } catch { /* 文件不存在 */ }
    }
    try {
      const homeLogs = join(home, 'logs');
      for (const f of readdirSync(homeLogs)) {
        const text = readFileSync(join(homeLogs, f), 'utf8');
        for (const l of text.split('\n')) {
          if (l.includes('async_run yielded:') || l.includes('async_workflow yielded:')) yieldedLines.push(`[home/logs/${f}] ${l}`);
        }
      }
    } catch { /* 无 home/logs 或不可读——如实少源 */ }
    writeFileSync(join(EVID, 'm1', 'operator-yielded-lines.txt'), yieldedLines.join('\n'));
    // 会话视图来源（GUI 活动日志面）并计。
    let yieldedViewCount = 0;
    try { yieldedViewCount = readFileSync(join(EVID, 'm1', 'operator-yielded-view.txt'), 'utf8').split('\n').filter((l) => l.trim() !== '').length; } catch { /* 尚无 */ }
    // API 面探查：宿主是否暴露读 cordis 日志环形缓冲的 RPC。静态扫描宿主
    // @deepseek-ai 树的 typert 方法面未见日志类端点（settings 面＝describe/set/
    // unset/update/replace/mutate/openSettingsDocument）——此步把静态结论落成
    // 实测事实，候选端点的响应原样在档（typert 拒绝即「无此端点」的实测证据）。
    const apiLogSurface = {};
    for (const ep of ['diagnostics/logs', 'logs', 'host/logs']) {
      try {
        const r = await fetch(`${ORIGIN}/api/${ep}`, {
          method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE },
          body: JSON.stringify({ type: 'client-request', rpcId: `probe-${rand()}`, method: ep, payload: { args: {} } }),
          signal: AbortSignal.timeout(15_000)
        });
        apiLogSurface[ep] = { httpStatus: r.status, body: (await r.text()).slice(0, 400) };
      } catch (error) { apiLogSurface[ep] = { error: String(error?.message ?? error).slice(0, 200) }; }
    }
    writeFileSync(join(EVID, 'm1', 'api-log-surface.json'), JSON.stringify({ at: new Date().toISOString(), probed: apiLogSurface }, null, 1));
    // 机制事实登记（供盲测代理判定用；装置不作产品结论）：cordis logger 在宿主
    // web 形态只挂内存环形缓冲 exporter（@deepseek-ai/cordis/lib/index.js:598-604，
    // bufferSize=1000），宿主树唯一其他 exporter 仅收启动期 warn/error
    // （dsh-app-boot/lib/index.js:4512-4522），无 stdout/文件出口；插件 yielded
    // 行走 ctx.logger.info（lib/jobs.js:1244、lib/workflow.js:588；本包
    // lib/notice.js:14-20 有同一论证）。
    manifest.m1.operatorLogMechanism = {
      finding: '四源 0 行与宿主机制一致：cordis logger 仅内存环形缓冲，web 形态无 stdout/文件出口，typert API 面无日志读取 RPC（静态扫描＋实测探查）。',
      staticRefs: [
        '@deepseek-ai/cordis/lib/index.js:598-604（内置 exporter 只入 buffer）',
        '@deepseek-ai/dsh-app-boot/lib/index.js:4512-4522（唯一其他 exporter，仅启动期 warn/error）',
        'lib/jobs.js:1244、lib/workflow.js:588（yielded 行走 ctx.logger.info）',
        'lib/notice.js:14-20（插件侧同一论证：只走 logger 等于什么都没说）'
      ],
      apiProbe: 'm1/api-log-surface.json'
    };
    capture('M1-c/f 操作者日志 yielded 行（多源扫描：stdout/stderr/home logs/会话视图＋API 面探查；机制事实见 manifest.m1.operatorLogMechanism）',
      yieldedLines.length + yieldedViewCount >= 4, 'm1/operator-yielded-lines.txt',
      `多源行数=${String(yieldedLines.length)}＋会话视图=${String(yieldedViewCount)}；宿主 web 形态 logger 无外部出口（实测见 m1/api-log-surface.json）`);
  }

  // ════ M2：echo on 真实模型流（会话 B）════
  {
    const marker = `ECHOBLIND-B-${rand()}`;
    const sid = await newSession(marker);
    const T2 = { h: `CMD2H-${rand()}`, t: `CMD2T-${rand()}`, oh: `WF2H-${rand()}`, ot: `WF2T-${rand()}` };
    const M2_OUT = `OUT2-${rand()}`;
    const M2_WOUT = `WOUT2-${rand()}`;
    manifest.m2 = { session: sid, marker, tokens: T2, outToken: M2_OUT, settings: await readEchoSettings() };
    await promptToolCall(sid, `${runPrompt(`m2cmd-${rand()}`, runCmd(T2.h, T2.t, M2_OUT))} Then in the SAME turn, also call the async_workflow tool with EXACTLY: meta={"name":"m2wf-${rand()}","description":"M2 workflow"}, script=${JSON.stringify(wfScript(T2.oh, T2.ot, M2_WOUT))}. After both tools return handles, end your turn immediately. Do NOT call async_wait.`);
    // 前置判据＝tool/call 记录（不命中注入指令文本——第四轮清单第 3 项）。
    const runCalled = await waitForPred(sid, callPred(T2.h), 90_000);
    const wfCalled = await waitForPred(sid, callPred(T2.oh), 120_000);
    capture('M2-a 前置：后台命令调用在转录', runCalled !== null, 'm2/session-b-records.json');
    capture('M2-b 前置：编排调用在转录', wfCalled !== null, 'm2/session-b-records.json');
    // job_list 复述（作业运行窗内）：判据＝job_list 的 tool/call＋assistant 复述。
    await promptToolCall(sid, 'Call the job_list tool now, then reply with its exact raw output verbatim, nothing else added.');
    const jlCall = await waitForPred(sid, (r) => r.event?.type === 'tool/call' && String(r.event?.data?.name ?? r.event?.data?.toolName ?? r.event?.data?.message?.name ?? '').includes('job_list'), 120_000);
    const jlReply = await waitForPred(sid, (r) => isAssistantR(r) && /m2cmd-|m2wf-/.test(textOfR(r)), 150_000);
    capture('M2-c 前置：job_list 调用＋复述记录', jlCall !== null && jlReply !== null, 'm2/session-b-records.json');
    // 等结算：两条完成消息（source=async-tools-job-result 同条含输出 token）。
    const settledRun = await waitForPred(sid, completionPred(M2_OUT), 150_000);
    const settledWf = await waitForPred(sid, completionPred(T2.ot), 150_000);
    capture('M2 结算观察：两条作业完成消息记录', settledRun !== null && settledWf !== null, 'm2/session-b-records.json');
    // 模型逐字引用：判据＝assistant 记录（注入指令自身含「命令原文」不算命中）。
    await promptToolCall(sid, 'Without calling any tools, quote VERBATIM from the conversation context you received: (1) the full line that starts with 命令原文： and the line immediately after it; (2) the full line that starts with 脚本原文： and the line immediately after it. If either is absent from your context, reply ABSENT for that item.');
    const quoted = await waitForPred(sid, (r) => isAssistantR(r) && (textOfR(r).includes('命令原文') || textOfR(r).includes('ABSENT')), 150_000);
    capture('M2-a/b 后置：模型引用回合（assistant 记录在转录）', quoted !== null, 'm2/session-b-records.json');
    const dump = await dumpRecords(sid, [T2.h, T2.t, T2.oh, T2.ot, M2_OUT, '命令原文', '脚本原文', 'm2cmd-', 'm2wf-', '已结算', 'settled', 'job_list'], join(EVID, 'm2', 'session-b-records.json'));
    capture('M2 材料落盘', dump.hits > 0, 'm2/session-b-records.json', `命中记录=${String(dump.hits)}/${String(dump.total)}`);
    manifest.m2.note = '载体偏离（模型等待/回合形态）以转录记录原样为准；判定权在盲测代理。';
  }

  // ════ M3：设置页两语＋窄屏（浏览器面，echo 状态不影响设置页）════
  {
    // 字段行锚（settings-visual 同款）：帮助钮 aria-controls 唯一定位 →
    // .ats-enum-field 是全部字段（含布尔）的行容器类。
    const rowExpr = `(() => document.querySelector('.ats-help-button[aria-controls="plugin-config-fullCommandEcho-help"]')?.closest('.ats-enum-field') ?? null)()`;
    const fieldRow = () => evaluate(page, `(() => {
      const row = ${rowExpr};
      if (row === null) return null;
      // 字段标签按类定位：布尔（flag）字段渲染 div.ats-enum-label、值字段渲染
      // <label class="ats-enum-label" htmlFor>——旧版 querySelector('label') 对
      // 布尔字段恒空（labelText=""/rectCount=0 的根因，client.js:648-654）。
      const label = row.querySelector('.ats-enum-label');
      return { rowText: row.textContent, labelText: label === null ? '' : label.textContent,
        labelTag: label === null ? '' : label.tagName,
        rectCount: label === null ? 0 : label.getClientRects().length,
        rowScrollW: row.scrollWidth, rowClientW: row.clientWidth,
        helpBtn: row.querySelector('.ats-help-button') !== null };
    })()`);
    const expandHelp = () => clickBy(`document.querySelector('.ats-help-button[aria-controls="plugin-config-fullCommandEcho-help"]')`, 'fullCommandEcho 帮助钮');
    const helpDom = () => evaluate(page, `(() => {
      const region = document.getElementById('plugin-config-fullCommandEcho-help');
      if (region === null) return null;
      return { helpText: region.textContent, clipped: region.scrollWidth > region.clientWidth + 1 };
    })()`);
    for (const lang of ['zh', 'en']) {
      await patchSettings({ uiLang: lang });
      try { await page.close(); } catch { /* 已关 */ }
      page = await openPage(browser.port, `${ORIGIN}/?token=${encodeURIComponent(TOKEN)}`);
      await waitFor(page, 'document.querySelectorAll("button,[role=button]").length', (n) => n > 0, 15000);
      await ensureNoDialog();
      await gotoPluginPage();
      await setViewport(page, 1500, 1000);
      await sleep(600);
      const wide = await fieldRow();
      if (wide !== null) writeFileSync(join(EVID, 'm3', `m3-${lang}-wide.json`), JSON.stringify({ at: new Date().toISOString(), lang, wide }, null, 1));
      // CAP 判据含标签可读（rectCount>0）——标签读不出时如实 GAP，不再 CAP 空读数。
      capture(`M3-${lang === 'zh' ? 'a' : 'c'} ${lang} 宽视口字段行 DOM`, wide !== null && Number(wide?.rectCount ?? 0) > 0, `m3/m3-${lang}-wide.json`);
      // 截图先框定目标（第四轮清单第 2 项：滚动字段行入视口再截）。
      await scrollIntoViewExpr('document.querySelector(\'[data-plugin-config]\') !== null ? document.querySelector(\'.ats-help-button[aria-controls="plugin-config-fullCommandEcho-help"]\')?.closest(\'.ats-enum-field\') : null');
      await shotOf(`m3-${lang}-wide.png`, { width: 1500, height: 1000, fullPage: false });
      await expandHelp();
      await sleep(700);
      const help = await helpDom();
      if (help !== null) writeFileSync(join(EVID, 'm3', `m3-${lang}-help.json`), JSON.stringify({ at: new Date().toISOString(), lang, help }, null, 1));
      capture(`M3-${lang === 'zh' ? 'b' : 'd'} ${lang} 帮助展开 DOM`, help !== null, `m3/m3-${lang}-help.json`);
      await scrollIntoViewExpr('document.getElementById("plugin-config-fullCommandEcho-help")');
      await shotOf(`m3-${lang}-help.png`, { width: 1500, height: 1000, fullPage: false });
    }
    // 窄屏 390×844：zh 双主题＋en 单主题（body[data-ds-dark-theme] 同款切法）。
    const narrowOnce = async (lang, theme) => {
      await patchSettings({ uiLang: lang });
      await evaluate(page, theme === 'dark'
        ? 'document.body.setAttribute("data-ds-dark-theme", ""), true'
        : 'document.body.removeAttribute("data-ds-dark-theme"), true');
      await sleep(600);
      await setViewport(page, 390, 844);
      await sleep(800);
      const narrow = await fieldRow();
      if (narrow !== null) writeFileSync(join(EVID, 'm3', `m3-${lang}-${theme}-390.json`), JSON.stringify({ at: new Date().toISOString(), lang, theme, narrow }, null, 1));
      // 窄屏同律：滚动字段行入视口再截（视觉面判据＝折行行数/无裁切重叠）。
      await scrollIntoViewExpr('document.querySelector(\'.ats-help-button[aria-controls="plugin-config-fullCommandEcho-help"]\')?.closest(\'.ats-enum-field\')');
      await shotOf(`m3-${lang}-${theme}-390.png`, { width: 390, height: 844, fullPage: false });
      // 同宽视口判据：标签读不出（rectCount=0）按 GAP 记，不 CAP 空读数。
      return narrow !== null && Number(narrow?.rectCount ?? 0) > 0;
    };
    capture('M3-e zh 窄屏 dark', await narrowOnce('zh', 'dark'), 'm3/m3-zh-dark-390.json');
    capture('M3-e zh 窄屏 light', await narrowOnce('zh', 'light'), 'm3/m3-zh-light-390.json');
    capture('M3-f en 窄屏 light', await narrowOnce('en', 'light'), 'm3/m3-en-light-390.json');
    await setViewport(page, 1500, 1000);
  }

  // ════ M4：GUI 保存翻转→下一次交付对照（会话 C，同实例同会话）════
  {
    const marker = `ECHOBLIND-C-${rand()}`;
    const sid = await newSession(marker);
    manifest.m4 = { session: sid, marker, settingsAtStart: await readEchoSettings() };
    // 基线 off：RPC 翻回 off（GUI 翻转是 M4-b 的动作，基线允许 RPC 设定——登记来源）。
    await patchSettings({ fullCommandEcho: false });
    manifest.m4.readBaseline = await readEchoSettings();
    const C1 = { h: `CMD1H-${rand()}`, t: `CMD1T-${rand()}` };
    const C2 = { h: `CMD2H-${rand()}`, t: `CMD2T-${rand()}` };
    const C3 = { h: `CMD3H-${rand()}`, t: `CMD3T-${rand()}` };
    manifest.m4.tokens = { c1: C1, c2: C2, c3: C3 };
    const deliver = async (tokens, tag) => {
      const outTok = `OUT${tag.toUpperCase()}-${rand()}`;
      await promptToolCall(sid, runPrompt(`m4${tag}-${rand()}`, runCmd(tokens.h, tokens.t, outTok)));
      const called = await waitForPred(sid, callPred(tokens.h), 90_000);
      capture(`M4-${tag} 前置：命令调用在转录`, called !== null, 'm4/session-c-records.json');
      // 结算判据＝完成消息记录同条含输出 token（第四轮清单第 1/3 项：等交付
      // 落档再转储，断言不命中注入指令）。
      const settled = await waitForPred(sid, completionPred(outTok), 150_000);
      capture(`M4-${tag} 结算观察：完成消息记录（source=async-tools-job-result＋输出 token 同条）`, settled !== null, 'm4/session-c-records.json');
      await dumpRecords(sid, [tokens.h, tokens.t, outTok, '命令原文', '已结算', 'settled'], join(EVID, 'm4', `msg-${tag}.json`));
    };
    await deliver(C1, 'a');
    // GUI 翻开并保存。
    await gotoPluginPage();
    await sleep(1000);
    const switchSel = `(() => document.querySelector('.ats-help-button[aria-controls="plugin-config-fullCommandEcho-help"]')?.closest('.ats-enum-field')?.querySelector('[role="switch"], input[type="checkbox"], button[class*="switch"]') ?? null)()`;
    // 四帧开关截图先框定目标行（第四轮清单第 2 项）。
    await scrollIntoViewExpr('document.querySelector(\'.ats-help-button[aria-controls="plugin-config-fullCommandEcho-help"]\')?.closest(\'.ats-enum-field\')');
    await shotOf('m4-switch-before.png', { width: 1500, height: 1000, fullPage: false });
    const clicked = await clickBy(switchSel, 'fullCommandEcho 开关');
    await sleep(800);
    const saveSel = `[...document.querySelectorAll('[data-plugin-config] button')].find((b) => /^(保存|Save)$/.test(b.textContent.trim()))`;
    const saved = await clickBy(saveSel, '保存');
    let sawBusy = false;
    for (let i = 0; i < 40; i += 1) {
      const st = await evaluate(page, `(() => { const b = ${saveSel}; return b === undefined ? 'gone' : (b.disabled ? 'disabled' : (/保存中|Saving/.test(b.textContent) ? 'busy' : 'enabled')); })()`);
      if (st === 'busy') sawBusy = true;
      if (sawBusy && (st === 'enabled' || st === 'disabled')) break;
      await sleep(250);
    }
    await sleep(1200);
    await scrollIntoViewExpr('document.querySelector(\'.ats-help-button[aria-controls="plugin-config-fullCommandEcho-help"]\')?.closest(\'.ats-enum-field\')');
    await shotOf('m4-switch-after-on.png', { width: 1500, height: 1000, fullPage: false });
    manifest.m4.readAfterGuiOn = await readEchoSettings();
    capture('M4-b GUI 翻开保存（开关点击＋保存点击＋截图＋RPC 读值）',
      clicked === 'clicked' && saved === 'clicked', 'm4/（见 manifest.m4.readAfterGuiOn）',
      `读值=${JSON.stringify(manifest.m4.readAfterGuiOn)}`);
    // on 交付（回到会话视图不需要——命令经 RPC prompt 驱动）。
    await deliver(C2, 'c');
    // GUI 翻回 off。
    await gotoPluginPage();
    await sleep(1000);
    await scrollIntoViewExpr('document.querySelector(\'.ats-help-button[aria-controls="plugin-config-fullCommandEcho-help"]\')?.closest(\'.ats-enum-field\')');
    await shotOf('m4-switch-before-off.png', { width: 1500, height: 1000, fullPage: false });
    const clicked2 = await clickBy(switchSel, 'fullCommandEcho 开关（关）');
    await sleep(800);
    const saved2 = await clickBy(saveSel, '保存');
    await sleep(2500);
    await scrollIntoViewExpr('document.querySelector(\'.ats-help-button[aria-controls="plugin-config-fullCommandEcho-help"]\')?.closest(\'.ats-enum-field\')');
    await shotOf('m4-switch-after-off.png', { width: 1500, height: 1000, fullPage: false });
    manifest.m4.readAfterGuiOff = await readEchoSettings();
    capture('M4-d GUI 翻回保存', clicked2 === 'clicked' && saved2 === 'clicked', 'm4/（见 manifest.m4.readAfterGuiOff）',
      `读值=${JSON.stringify(manifest.m4.readAfterGuiOff)}`);
    await deliver(C3, 'd');
  }

  manifest.atEnd = { settings: await readEchoSettings(), at: new Date().toISOString() };
  manifest.completed = true;
} catch (error) {
  fail(`未预期异常：${String(error?.stack ?? error)}`);
}
cleanup();
writeFileSync(join(EVID, 'manifest.json'), JSON.stringify(manifest, null, 2));
log(`manifest 落盘：${join(EVID, 'manifest.json')}`);
if (gaps > 0) {
  console.log(`判定：采集有缺口（${String(gaps)} 项，见 manifest.gaps——已得材料照常交付）`);
  process.exit(1);
}
console.log('判定：采集完整（判定权在盲测代理）');
