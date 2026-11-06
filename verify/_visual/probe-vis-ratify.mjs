#!/usr/bin/env node
/**
 * 隔离真机验收探针（官方 tgz 临时实例，zai 路由真实模型）。第五轮（vis-ratify-5，
 * VIS-BADGE-01 终态收官——第四轮后两处定向微调的复测）：
 *
 * 微调形：①--sidebar 面板删 left:60px——右锚 16px＋width:min(340px,100vw-76px)
 * 在一切宽度左缘 ≥60px（390 形态 l=60 不变；768 回右锚 l≈412/r=752，消除四轮
 * 过度约束致面板居左的形态差）；②泡 right:-4px→-2px（四轮泡 r=57 贴列界 56 约
 * 1px——内收后泡盒右缘 ≤56 入列，判据 A 间隙应 ≥8px）。
 *
 * 常设判据（第四轮起入判，本轮沿用同口径；判据为徽标/面板矩阵×4 配置＋徽标
 * 悬停两主题＋收口消隐，逐条见 check 调用点）：
 * - A：问号 svg 盒×计数泡盒零重叠（矩形相交即 FAIL）。
 * - B：面板盒×侧栏列盒（徽标第一个 overflow hidden/clip 祖先——等价选择器，
 *   不依赖宿主 CSS 模块类名）零重叠。
 * 其余：三盒零重叠维持（bottom=94px）、泡对比度（浅 92%/深 62% 混黑白字）、
 * aria 面、52px 盒在列内不裁切确认、悬停一眼（两主题）。
 * 前四轮证据 ../vis-ratify{,-2,-3,-4}/。本轮 0 FAIL 即 VIS-BADGE-01 终态
 * （shots badge/panel×4＋hover×2 供 flash 视觉复审）。
 *
 * ## 用法（须 danger-full-access 或非受限环境——CDP 无头浏览器在受限沙箱档必早夭）
 *   node verify/_visual/probe-vis-ratify.mjs --service-root <宿主服务树> \
 *     [--host-subdir dsh-0.2.1-rc.5] [--repo <本仓路径>] [--keep]
 *
 * 红线：只操作本装置自建的隔离实例，不连接、不改动任何既有实例（开发用或常驻服务）。--patch 只带 zai-glm.yml
 * 模型路由。证据：`.local/evidence/vis-ratify-5/{logs,shots}`（不覆盖前四轮）。退出
 * 码 0＝全部通过、1＝存在 FAIL、2＝装置故障（FAULT，输出区分）。
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
    mkdirSync(join(repo, '.local', 'evidence', 'vis-ratify-5', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.local', 'evidence', 'vis-ratify-5', 'logs', 'fault.json'),
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
let instanceStdio = { stdout: '', stderr: '' };
function cleanup() {
  try { page?.close(); } catch { /* 已关 */ }
  try { browser?.close(); } catch { /* 已关 */ }
  if (child !== null) { killTree(child.pid); child = null; }
  if (!keep && home !== null) { try { rmSync(home, { recursive: true, force: true }); } catch { /* 占用中 */ } }
}

// ── 实例与 RPC（probe-ask-visual 同款）────────────────────────────────────────
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
  child.stdout.on('data', (c) => { stdout += c; instanceStdio.stdout += String(c); });
  child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-4000); instanceStdio.stderr += String(c); });
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

// ── 页面手法（ask-visual / settings-visual 同款）──────────────────────────────
/** 切主题并实证（锚点元素向上第一个不透明底色：深 <90、浅 >180）。 */
async function applyTheme(scheme, anchorJs) {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await evaluate(page, scheme === 'dark'
    ? 'document.body.setAttribute("data-ds-dark-theme", ""), true'
    : 'document.body.removeAttribute("data-ds-dark-theme"), true');
  await sleep(1000);
  const bg = await evaluate(page, `(() => {
    let node = ${anchorJs} ?? document.body;
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
const shotOf = async (name, opts) => { await ensureNoDialog(); await sleep(400); shots.push(name); await screenshot(page, join(SHOTS, name), opts); };
const clickBy = (selectorJs, label) => evaluate(page, `(() => {
  const target = ${selectorJs};
  if (target === undefined || target === null) return 'missing:' + ${JSON.stringify(label)};
  target.click();
  return 'clicked';
})()`);

const EVID = join(repo, '.local', 'evidence', 'vis-ratify-5');
const LOGS = join(EVID, 'logs');
const SHOTS = join(EVID, 'shots');
mkdirSync(LOGS, { recursive: true });
try { rmSync(SHOTS, { recursive: true, force: true }); } catch { /* 无旧目录 */ }
mkdirSync(SHOTS, { recursive: true });

// ── 单题作用域（批次固定两题，与 ask-visual 同题干）──────────────────────────
const Q1_TEXT = 'Pick a color';
const Q2_TEXT = 'Pick fruits';
const qExpr = (text) => `(() => {
  const qs = [...document.querySelectorAll('.ats-ask-q')];
  return qs.find((n) => (n.querySelector('.ats-ask-text')?.textContent ?? '').includes(${JSON.stringify(text)})) ?? null;
})()`;

// ── WCAG 对比度（Node 侧计算）────────────────────────────────────────────────
/** WCAG 相对亮度（sRGB→线性→加权和）。 */
function luminance(r, g, b) {
  const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
/** 两色对比比值（亮者在分子）。入参 [r,g,b] 0-255。 */
function contrastRatio(a, b) {
  const la = luminance(a[0], a[1], a[2]);
  const lb = luminance(b[0], b[1], b[2]);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
/** rgb()/rgba()/color(srgb r g b [/ a]) 计算值字符串 → [r,g,b,a]（0-255）。 */
function parseCssColor(text) {
  const raw = String(text ?? '').trim();
  const m = /^rgba?\(([^)]+)\)/.exec(raw);
  if (m !== null) {
    const parts = m[1].split(',').map((x) => Number.parseFloat(x.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [parts[0], parts[1], parts[2], parts.length >= 4 ? parts[3] : 1];
    }
  }
  // Chromium 对 color-mix() 背景的 computed 值可能序列化为 color(srgb r g b / a)
  // （分量 0-1 浮点）——深色档 62%／浅色 92% 两档 mix 都经此通道拿最终生效值。
  const c = /^color\(srgb ([\d.e+-]+) ([\d.e+-]+) ([\d.e+-]+)(?:\s*\/\s*([\d.e+-]+))?\)/.exec(raw);
  if (c !== null) {
    const [r, g, b] = [Number.parseFloat(c[1]), Number.parseFloat(c[2]), Number.parseFloat(c[3])];
    const a = c[4] === undefined ? 1 : Number.parseFloat(c[4]);
    if ([r, g, b, a].every((n) => Number.isFinite(n))) return [r * 255, g * 255, b * 255, a];
  }
  return null;
}

// ── 徽标/面板几何读取（第二轮：纯图标按钮＋右上叠置泡）──────────────────────
const BADGE_READ = `(() => {
  const b = document.querySelector('.ats-ask-badge');
  if (b === null) return null;
  const count = b.querySelector('.ats-ask-count');
  const svg = b.querySelector('svg');
  const r = b.getBoundingClientRect();
  const cr = count === null ? null : count.getBoundingClientRect();
  const sr = svg === null ? null : svg.getBoundingClientRect();
  // 宿主窄图标列（第一个 overflow hidden/clip 祖先）——左缘供徽标不裁切参照，
  // 全盒供面板×列零重叠判据（判据 B，不依赖宿主 CSS 模块类名）。
  const colNode = (() => {
    let node = b.parentElement;
    while (node !== null && node instanceof Element) {
      const s = getComputedStyle(node);
      if (s.overflowX === 'hidden' || s.overflowX === 'clip' || s.overflowY === 'hidden' || s.overflowY === 'clip') return node;
      node = node.parentElement;
    }
    return null;
  })();
  const colRect = colNode === null ? null : colNode.getBoundingClientRect();
  const colLeft = colRect === null ? 0 : colRect.left;
  const ancestorClipped = (() => {
    let node = b.parentElement;
    while (node !== null && node instanceof Element) {
      const s = getComputedStyle(node);
      if (s.overflowX === 'hidden' || s.overflowX === 'clip' || s.overflowY === 'hidden' || s.overflowY === 'clip') {
        const nr = node.getBoundingClientRect();
        // 泡带负偏移（top/right -6px）有意越出徽标盒但不得越出裁切列。
        const ur = cr === null ? r : { left: Math.min(r.left, cr.left), right: Math.max(r.right, cr.right), top: Math.min(r.top, cr.top), bottom: Math.max(r.bottom, cr.bottom) };
        if (ur.right > nr.right + 1 || ur.left < nr.left - 1 || ur.bottom > nr.bottom + 1 || ur.top < nr.top - 1) return String(node.tagName) + '.' + String(node.className).slice(0, 40);
      }
      node = node.parentElement;
    }
    return '';
  })();
  return {
    ariaLabel: b.getAttribute('aria-label') ?? '',
    ariaExpanded: b.getAttribute('aria-expanded') ?? '',
    rect: { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) },
    colLeft: Math.round(colLeft * 10) / 10,
    colRect: colRect === null ? null : { l: Math.round(colRect.left), t: Math.round(colRect.top), r: Math.round(colRect.right), b: Math.round(colRect.bottom), w: Math.round(colRect.width), h: Math.round(colRect.height) },
    withinCol: r.left >= colLeft - 0.5,
    inViewport: r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5,
    // 记录字段（不入判）：绝对定位泡有意越出按钮盒（top/right -6px），按 CSS
    // 规范参与 scrollWidth/scrollHeight 溢出区——叠置泡形态下此读数结构性偏大，
    // 不构成内容溢出判定；内容真溢出的直接判据是 svgInBox。
    noSelfOverflowH: b.scrollWidth <= b.clientWidth + 1,
    ancestorClipped,
    count: cr === null ? null : {
      w: Math.round(cr.width), h: Math.round(cr.height),
      text: count.textContent ?? '',
      position: getComputedStyle(count).position,
      // 右上叠置形：绝对定位＋越出徽标盒（top/right 负偏移，相对 padding box——
      // right:-2 时越出 border 盒约 1~1.5px，容差取 0.5px 防亚像素边界假阴；
      // 若内收为 right:0 及以内则如实判非叠置）。
      anchoredOverlay: getComputedStyle(count).position === 'absolute' && cr.top < r.top - 0.5 && cr.right > r.right + 0.5,
      inViewport: cr.left >= -0.5 && cr.right <= innerWidth + 0.5 && cr.top >= -0.5 && cr.bottom <= innerHeight + 0.5,
      rect: { l: Math.round(cr.left), t: Math.round(cr.top), r: Math.round(cr.right), b: Math.round(cr.bottom) },
      // 泡中心实际绘制者（不被裁切/遮挡——命中泡自身或其文本）。
      bubbleHit: (() => {
        const x = Math.round(cr.left + cr.width / 2), y = Math.round(cr.top + cr.height / 2);
        if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) return 'off';
        const hit = document.elementFromPoint(x, y);
        if (hit === null) return 'off';
        return (hit === count || count.contains(hit)) ? 'bubble' : (hit === b || b.contains(hit) ? 'badge' : hit.tagName + '.' + String(hit.className).slice(0, 30));
      })()
    },
    // 泡对比度取样：computed 池底（color-mix 解析值；未解析时 Node 侧按令牌现值
    // 92/8 srgb mix 实算）＋泡文字色＋error 令牌现值。
    countColors: count === null ? null : (() => {
      const s = getComputedStyle(count);
      return { bg: s.backgroundColor, color: s.color, fontSize: s.fontSize,
        tokenError: getComputedStyle(document.body).getPropertyValue('--dsw-alias-state-error-primary').trim() };
    })(),
    svg: sr === null ? null : { w: Math.round(sr.width), h: Math.round(sr.height), rect: { l: Math.round(sr.left), t: Math.round(sr.top), r: Math.round(sr.right), b: Math.round(sr.bottom) } },
    // 判据 A（第四轮常设，flash 视觉盲测盲区）：问号图标盒与计数泡盒零重叠——
    // 旧形泡直接叠图标右上，几何命中判据全过但问号被盖不可辨；两盒矩形相交即 FAIL。
    svgCountOverlap: sr === null || cr === null ? null
      : !(sr.right <= cr.left + 0.5 || cr.right <= sr.left + 0.5 || sr.bottom <= cr.top + 0.5 || cr.bottom <= sr.top + 0.5),
    svgGapX: sr === null || cr === null ? null : Math.round((cr.left - sr.right) * 10) / 10,
    // 纵向内容真溢出的直接判据：svg 包围盒完全在按钮盒内（±0.5px）。
    svgInBox: sr === null ? false
      : sr.left >= r.left - 0.5 && sr.right <= r.right + 0.5 && sr.top >= r.top - 0.5 && sr.bottom <= r.bottom + 0.5,
    drawnAtLeftEdge: (() => {
      const x0 = Math.max(Math.round(r.left) + 2, 0);
      const y0 = Math.round(r.top + r.height / 2);
      if (y0 < 0 || y0 >= innerHeight || x0 < 0 || x0 >= innerWidth) return 'off';
      const hit = document.elementFromPoint(x0, y0);
      return hit === null ? 'off' : (hit === b || b.contains(hit) ? 'self' : hit.tagName + '.' + String(hit.className).slice(0, 30));
    })(),
    badgeDisplay: getComputedStyle(b).display,
    vw: innerWidth, vh: innerHeight
  };
})()`;
const PANEL_READ = `(() => {
  const p = document.querySelector('.ats-ask-panel');
  if (p === null) return null;
  const b = document.querySelector('.ats-ask-badge');
  const pr = p.getBoundingClientRect();
  const br = b === null ? null : b.getBoundingClientRect();
  const s = getComputedStyle(p);
  const title = p.querySelector('.ats-ask-title');
  const cr = b === null ? null : b.querySelector('.ats-ask-count')?.getBoundingClientRect() ?? null;
  const separated = br === null ? false
    : pr.bottom <= br.top + 0.5 || br.bottom <= pr.top + 0.5 || pr.right <= br.left + 0.5 || br.right <= pr.left + 0.5;
  // 泡盒分离（独立于徽标盒——泡带 top/right 负偏移，可能与面板角相碰）。
  const countSeparated = cr === null ? false
    : pr.bottom <= cr.top + 0.5 || cr.bottom <= pr.top + 0.5 || pr.right <= cr.left + 0.5 || cr.right <= pr.left + 0.5;
  // 判据 B（第四轮常设，flash 视觉盲测盲区）：面板盒与宿主侧栏列盒（徽标的第一
  // 个 overflow hidden/clip 祖先）零重叠——旧形 390 下面板 l=34 压进 ~52px 收起列、
  // 裁到列内图标右缘；--sidebar 现形右锚 16px＋width:min(340px,100vw-76px)
  //（左缘恒 ≥60px）避列。
  const colNode = (() => {
    if (b === null) return null;
    let node = b.parentElement;
    while (node !== null && node instanceof Element) {
      const st = getComputedStyle(node);
      if (st.overflowX === 'hidden' || st.overflowX === 'clip' || st.overflowY === 'hidden' || st.overflowY === 'clip') return node;
      node = node.parentElement;
    }
    return null;
  })();
  const colR = colNode === null ? null : colNode.getBoundingClientRect();
  const colOverlap = colR === null ? null
    : !(pr.right <= colR.left + 0.5 || colR.right <= pr.left + 0.5 || pr.bottom <= colR.top + 0.5 || colR.bottom <= pr.top + 0.5);
  const isSidebar = p.classList.contains('ats-ask-panel--sidebar');
  return {
    rect: { l: Math.round(pr.left), t: Math.round(pr.top), r: Math.round(pr.right), b: Math.round(pr.bottom), w: Math.round(pr.width), h: Math.round(pr.height) },
    computedBottom: s.bottom, computedWidth: s.width, position: s.position,
    sidebarClass: isSidebar,
    titleText: title?.textContent ?? '',
    leftNonNegative: pr.left >= -0.5,
    rightWithinViewport: pr.right <= innerWidth + 0.5,
    // --sidebar 现形钳制 min(340px, 100vw-76px)（右锚 16px，左缘=vw-16-w≥60）；base
    // 面板（overlay 座位）维持 min(340px, 100vw-32px)。注意 left+width+right 在
    // 768 视口过度约束（LTR 忽略 right）——面板实际左锚以实测坐标登记。
    widthClamped: pr.width <= (isSidebar ? Math.min(340, innerWidth - 76) : Math.min(340, innerWidth - 32)) + 0.5,
    colRect: colR === null ? null : { l: Math.round(colR.left), t: Math.round(colR.top), r: Math.round(colR.right), b: Math.round(colR.bottom) },
    colOverlap,
    badgeRect: br === null ? null : { l: Math.round(br.left), t: Math.round(br.top), r: Math.round(br.right), b: Math.round(br.bottom) },
    countRect: cr === null ? null : { l: Math.round(cr.left), t: Math.round(cr.top), r: Math.round(cr.right), b: Math.round(cr.bottom) },
    separatedFromBadge: separated,
    separatedFromCount: countSeparated,
    badgeCountStillVisible: (() => {
      if (b === null) return false;
      const c = b.querySelector('.ats-ask-count');
      if (c === null) return false;
      const cr = c.getBoundingClientRect();
      if (!(cr.width >= 10 && cr.height >= 10 && cr.right <= innerWidth + 0.5 && cr.bottom <= innerHeight + 0.5)) return false;
      // elementFromPoint 实际绘制可见性：fixed 高 z-index 面板遮挡时泡中心命中
      // 的是面板而非泡（首跑 390 视口实证覆盖后的硬判——包围盒在视口内不等于
      // 没被盖住）。
      const hit = document.elementFromPoint(Math.round(cr.left + cr.width / 2), Math.round(cr.top + cr.height / 2));
      return hit !== null && (hit === c || c.contains(hit));
    })(),
    questions: document.querySelectorAll('.ats-ask-panel .ats-ask-q').length,
    vw: innerWidth, vh: innerHeight
  };
})()`;
const badgeClick = () => evaluate(page, `document.querySelector('.ats-ask-badge')?.click(), true`);
async function ensureCollapsed() {
  const panels = Number(await evaluate(page, 'document.querySelectorAll(".ats-ask-panel").length'));
  if (panels > 0) { await badgeClick(); await sleep(700); }
}
async function expandPanel() {
  let panels = Number(await evaluate(page, 'document.querySelectorAll(".ats-ask-panel .ats-ask-q").length'));
  if (panels < 2) {
    await badgeClick();
    panels = Number(await waitFor(page, 'document.querySelectorAll(".ats-ask-panel .ats-ask-q").length', (n) => Number(n) >= 2, 10_000));
  }
  return panels;
}
/** 排空旧接管项：逐题点预设＋提交，直至面板无题（重试前的清场纪律）。 */
async function drainAsk() {
  const badge = Number(await evaluate(page, 'document.querySelectorAll(".ats-ask-badge").length'));
  if (badge < 1) return;
  try { await expandPanel(); } catch { /* 面板门不判——尽力排空 */ }
  for (let guard = 0; guard < 12; guard += 1) {
    const remain = Number(await evaluate(page, 'document.querySelectorAll(".ats-ask-panel .ats-ask-q").length'));
    if (remain < 1) break;
    const firstQ = '(() => { const qs = [...document.querySelectorAll(".ats-ask-panel .ats-ask-q")]; return qs[0] ?? null; })()';
    await clickBy(`${firstQ}?.querySelector('button.ats-ask-opt')`, '排空·预设一');
    await sleep(250);
    await clickBy(`${firstQ}?.querySelector('.ats-ask-submit')`, '排空·提交');
    await sleep(700);
  }
}

// ── 悬停前后样式对比（静止目标）──────────────────────────────────────────────
const HOVER_STYLE_JS = `(() => {
  const el = ${'__EL__'};
  if (el === null || el === undefined) return null;
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return { bg: s.backgroundColor, color: s.color, rect: { l: Math.round(r.left * 10) / 10, t: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } };
})()`;
const hoverStyleOf = (elJs) => evaluate(page, HOVER_STYLE_JS.replace('__EL__', elJs));
const centerOf = (elJs) => evaluate(page, `(() => {
  const el = ${elJs};
  if (el === null || el === undefined) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), inViewport: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth };
})()`);
async function hoverSequence(label, elJs, theme, shotName, expectations) {
  const center = await centerOf(elJs);
  if (center === null || center === undefined) {
    check(`HOVER ${theme} ${label}：目标在场`, false, '元素缺席');
    return;
  }
  if (center.inViewport !== true) {
    // 若元素在可视区外先滚入（复用 ask-visual 的可见节点纪律）。
    log(`警告：${theme} ${label} 中心点初始不在视口（${JSON.stringify(center)}），scrollIntoView 后重读`);
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8 });
  await sleep(350);
  const before = await hoverStyleOf(elJs);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y });
  await sleep(450);
  const after = await hoverStyleOf(elJs);
  const bgChanged = before?.bg !== after?.bg && after?.bg !== 'rgba(0, 0, 0, 0)';
  const colorChanged = before?.color !== after?.color;
  const still = before !== null && after !== null
    && Math.abs(before.rect.l - after.rect.l) <= 0.5 && Math.abs(before.rect.t - after.rect.t) <= 0.5
    && Math.abs(before.rect.w - after.rect.w) <= 0.5 && Math.abs(before.rect.h - after.rect.h) <= 0.5;
  const wantBg = expectations.bg === true;
  const wantColor = expectations.color === true;
  const styleOk = wantBg === true ? bgChanged === true : true;
  const styleOk2 = wantColor === true ? colorChanged === true : true;
  check(`HOVER ${theme} ${label}：真实指针悬停后${wantBg && wantColor ? '背景与前景' : wantBg ? '背景' : '前景'}变化（getComputedStyle 前后对比）＋包围盒静止`,
    styleOk === true && styleOk2 === true && still === true,
    `bg ${String(before?.bg)} → ${String(after?.bg)}（变化=${String(bgChanged)}）；color ${String(before?.color)} → ${String(after?.color)}（变化=${String(colorChanged)}）；rect ${JSON.stringify(before?.rect)} → ${JSON.stringify(after?.rect)}（静止=${String(still)}）`);
  await shotOf(shotName, { width: 1500, height: 1000, fullPage: false });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8 });
  await sleep(250);
}

// ── RA 双预设行为判据 ─────────────────────────────────────────────────────────
/** 问题文本不得包含判别词（async_wait / job_output / wait_ms / set wait）。 */
// ── 会话驱动（触发真实问答批次用；RA 双预设核对归首轮 ../vis-ratify/）────────
async function newSession(preset, cwd) {
  const created = await rpc('session/create', { request: { cwd, agentPreset: preset } });
  if (created.agentPreset !== preset) throw new Error(`预设回退：要 ${String(preset)}，得到 ${String(created.agentPreset)}`);
  return created.sessionId;
}
async function promptSession(sessionId, text) {
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId, mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
try {
  // 1) 打包＋官方 CLI 安装＋起实例（zai 路由）。
  mkdirSync(join(repo, '.local'), { recursive: true });
  const packRun = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', '.local'], { cwd: repo, encoding: 'utf8', shell: true });
  if (packRun.status !== 0) fail(`npm pack 退出 ${String(packRun.status)}：${packRun.stderr}`);
  const tgzName = (packRun.stdout.match(/dsh-async-tools-[^\s]+\.tgz/g) ?? []).pop();
  if (tgzName === undefined) fail('npm pack 未产出 tgz');
  home = mkdtempSync(join(tmpdir(), 'dsh-vis-ratify-'));
  const install = spawnSync('node', [bin, 'plugin', '--profile', 'web', 'add', join(repo, '.local', tgzName)], {
    cwd: serviceRoot, encoding: 'utf8', timeout: 300_000, env: { ...process.env, DSH_HOME: home }
  });
  if (install.status !== 0) { console.error(install.stdout); console.error(install.stderr); fail('plugin add 退出非 0'); }
  const browserPath = findBrowser();
  if (browserPath === undefined) fail('找不到 Edge/Chrome（视觉探针需本机浏览器）');
  await startInstance();
  browser = await launch(browserPath);
  page = await openPage(browser.port, `${ORIGIN}/?token=${encodeURIComponent(TOKEN)}`);
  await waitFor(page, 'document.querySelectorAll("button,[role=button]").length', (n) => n > 0, 15000);
  log(`repo=${repo} hostVersion=${hostVersion} tgz=${tgzName}`);

  // 2) 接管前置（公开设置接口）：askTakeover 长窗＋中文界面＋sidebar 座位。
  const settingsNS = 'async-tools-host';
  async function patchSettings(patch) {
    await rpc('settings/update', { ns: settingsNS, patch: { settings: patch } });
  }
  await patchSettings({ askTakeover: true, askTimeoutMs: 600000, uiLang: 'zh', askUiSeat: 'sidebar' });
  const described = await rpc('settings/describe', {});
  const nsRow = described.namespaces.find((n) => (n.ns ?? n.namespace ?? n.id) === settingsNS);
  if (nsRow?.value?.settings?.askTakeover !== true) fail('askTakeover 前置未生效');

  // 3) 触发真实问答批次（模型依从波动：重试上限 4、attempts 留痕、换会话重试）。
  const BATCH_PROMPT = 'Call the ask_user_question tool with exactly two questions in ONE call: '
    + 'question 1 text "Pick a color", options "red" and "blue", no multiSelect; '
    + 'question 2 text "Pick fruits", options "apple", "banana", "cherry", multiSelect true. '
    + 'Do not answer them yourself; call the tool once and wait for the user.';
  const attemptsLog = [];
  let SESSION = null;
  let panelReady = false;
  for (let attempt = 1; attempt <= 4 && !panelReady; attempt += 1) {
    SESSION = await newSession('dsh-async', home);
    await promptSession(SESSION, BATCH_PROMPT);
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
        // 宿主语义：multiSelect 缺省＝单选（模型按 schema 可省略 multi_select）；
        // every 全量判定＋排空纪律防跨轮同名旧题干扰 find 首命中。
        const q1Items = items.filter((it) => (it.question ?? '').includes('Pick a color'));
        const q2Items = items.filter((it) => (it.question ?? '').includes('Pick fruits'));
        multiOk = q1Items.length > 0 && q2Items.length > 0
          && q1Items.every((it) => it.multiSelect !== true)
          && q2Items.every((it) => it.multiSelect === true);
        if (!multiOk) await sleep(1000);
      }
    }
    // sidebar 座位面板默认收起（openRef 初始 false，.ats-ask-panel 仅展开时渲染）
    // ——ask-visual ensurePanel 的 sidebar 分支同款：先等徽标在场、点徽标展开再验题数。
    const badgeSeen = Number(await waitFor(page, 'document.querySelectorAll(".ats-ask-badge").length', (n) => Number(n) >= 1, 30_000));
    let panels = 0;
    if (badgeSeen >= 1) panels = await expandPanel();
    panelReady = panels >= 2 && multiOk;
    if (!panelReady) {
      attemptsLog.push({ attempt, askCalled: askRecordText !== '', batchShapeOk: multiOk, badgeSeen, panels });
      const cause = askRecordText === '' ? '转录未见 ask 调用（模型未依从）'
        : multiOk !== true ? '接管 state 批次形态不符（Q1 应单选＋Q2 应多选）'
          : `面板未出（题数=${String(panels)}）`;
      log(`第 ${String(attempt)} 次触发不可用（${cause}），${attempt < 4 ? '排空旧接管项后换会话重试' : '放弃'}`);
      // 排空旧接管项（ask-visual 纪律）：旧会话未答题留在全局 state，跨轮累积
      // 会污染下一轮的形态判定与面板题数。
      if (badgeSeen >= 1) { await drainAsk(); }
    }
  }
  if (!panelReady) fail(`四轮触发未达可用面板（attempts=${JSON.stringify(attemptsLog)}——模型依从波动按装置纪律登记）`);
  log(`面板就绪（sessionId=${String(SESSION)}，attempts=${JSON.stringify(attemptsLog)}）`);
  await ensureCollapsed();
  await ensureNoDialog();

  // ── 4) VIS-BADGE 矩阵：两主题 × 390/768（判据 A/B＋三盒零重叠，终态收官）──
  const CONFIGS = [
    { theme: 'dark', w: 390, h: 844 },
    { theme: 'light', w: 390, h: 844 },
    { theme: 'dark', w: 768, h: 1024 },
    { theme: 'light', w: 768, h: 1024 }
  ];
  for (const cfg of CONFIGS) {
    const tag = `${cfg.theme}-${String(cfg.w)}`;
    await setViewport(page, cfg.w, cfg.h);
    await ensureCollapsed();
    const theme = await applyTheme(cfg.theme, 'document.querySelector(".ats-ask-badge")');
    check(`BADGE前置 ${tag} 主题实证（徽标区底色${cfg.theme === 'dark' ? '深 <90' : '浅 >180'}）`, theme.applied, `实得 ${theme.bg}`);
    const collapsed = await evaluate(page, BADGE_READ);
    if (collapsed === null || collapsed === undefined) {
      check(`BADGE ${tag} 收起态徽标在场`, false, '.ats-ask-badge 未命中');
    } else {
      check(`BADGE ${tag} 徽标盒 ≤52px 且左缘不裁切（≥图标列左缘＋svg 在按钮盒内＋无 hidden/clip 祖先真裁切＋视口内）`,
        collapsed.rect.w <= 52 && collapsed.withinCol === true && collapsed.inViewport === true
          && collapsed.svgInBox === true && collapsed.ancestorClipped === '',
        `rect=${JSON.stringify(collapsed.rect)}（宽=${String(collapsed.rect.w)}px，列左缘=${String(collapsed.colLeft)}） 视口=${String(collapsed.vw)}×${String(collapsed.vh)} svg在盒内=${String(collapsed.svgInBox)} 祖先裁切=${String(collapsed.ancestorClipped)} 左缘带绘制=${String(collapsed.drawnAtLeftEdge)}（记录：scrollWidth≤clientWidth=${String(collapsed.noSelfOverflowH)}——叠置泡越出计入溢出区，非内容溢出）`);
      check(`BADGE ${tag} 问号图标 16×16 在场（纯图标按钮）`,
        collapsed.svg !== null && collapsed.svg.w >= 14 && collapsed.svg.h >= 14,
        `svg=${JSON.stringify(collapsed.svg)} display=${String(collapsed.badgeDisplay)}`);
      check(`BADGE ${tag} 计数泡：右上叠置（绝对定位负偏移）＋≥16×16＋视口内＋泡中心 elementFromPoint 命中泡/徽标（不被裁切遮挡）`,
        collapsed.count !== null && collapsed.count.anchoredOverlay === true
          && collapsed.count.w >= 15 && collapsed.count.h >= 15 && collapsed.count.inViewport === true
          && (collapsed.count.bubbleHit === 'bubble' || collapsed.count.bubbleHit === 'badge'),
        `count=${JSON.stringify(collapsed.count)}`);
      // 判据 A（第四轮常设）：svg 盒×泡盒零重叠——flash 视觉盲测抓到的盲区
      //（旧形泡叠图标右上，问号被盖不可辨；几何命中判据对「盖住图标」天然失明）。
      check(`BADGE ${tag} 判据A：问号图标盒与计数泡盒零重叠（两盒矩形相交即 FAIL）`,
        collapsed.svgCountOverlap === false,
        `svg盒=${JSON.stringify(collapsed.svg?.rect)} 泡盒=${JSON.stringify(collapsed.count?.rect)} 相交=${String(collapsed.svgCountOverlap)} 横向间隙=${String(collapsed.svgGapX)}px`);
      // 泡对比度实算：泡底 computed（color-mix 解析值，深浅两档各拿最终生效值）。
      // 解析失败不猜比例（深色 62%/浅色 92% 两档，猜错出假数）——直接 FAIL 附原串。
      if (collapsed.countColors !== null) {
        const cc = collapsed.countColors;
        const bgRgb = parseCssColor(cc.bg);
        const fgRgb = parseCssColor(cc.color) ?? [255, 255, 255, 1];
        if (bgRgb !== null && bgRgb[3] >= 0.999) {
          const ratio = contrastRatio(fgRgb.slice(0, 3), bgRgb.slice(0, 3));
          check(`BADGE ${tag} 计数泡文字对泡底 ≥4.5:1 实算（10px/600 普通文字）`,
            ratio >= 4.5,
            `泡底=${String(cc.bg)}（→rgb(${String(Math.round(bgRgb[0]))}, ${String(Math.round(bgRgb[1]))}, ${String(Math.round(bgRgb[2]))}）） 文字=${String(cc.color)} 字号=${String(cc.fontSize)} tokenError=${String(cc.tokenError)} 比值=${String(Math.round(ratio * 100) / 100)}:1`);
        } else {
          check(`BADGE ${tag} 计数泡底色可解析为不透明计算值`, false,
            `computed=${String(cc.bg)} token=${String(cc.tokenError)}（color-mix 深浅两档按 computed 生效值判定，不猜比例）`);
        }
      }
      check(`BADGE ${tag} aria-label 含完整名称（待答问题＋N 题待答）＋收起态 aria-expanded=false`,
        collapsed.ariaLabel.includes('待答问题') === true && collapsed.ariaLabel.includes('题待答') === true
          && collapsed.ariaExpanded === 'false',
        `aria-label=${JSON.stringify(collapsed.ariaLabel)} aria-expanded=${String(collapsed.ariaExpanded)}`);
    }
    await shotOf(`badge-${tag}.png`, { width: cfg.w, height: cfg.h, fullPage: false });
    // 展开面板：--sidebar 让位＋宽度钳制＋aria 翻转。
    const panels = await expandPanel();
    if (panels < 2) { check(`BADGE ${tag} 面板展开门（题数≥2）`, false, `题数=${String(panels)}`); continue; }
    await sleep(400);
    const openBadge = await evaluate(page, BADGE_READ);
    const panel = await evaluate(page, PANEL_READ);
    check(`BADGE ${tag} 展开后 aria-expanded=true（翻转）`,
      openBadge?.ariaExpanded === 'true', `aria-expanded=${String(openBadge?.ariaExpanded)}`);
    check(`BADGE ${tag} 面板标题行承载可见全名（.ats-ask-title 与 aria-label 同文）`,
      panel?.titleText === openBadge?.ariaLabel && panel?.titleText.includes('待答问题') === true,
      `title=${JSON.stringify(panel?.titleText)} aria-label=${JSON.stringify(openBadge?.ariaLabel)}`);
    check(`BADGE ${tag} --sidebar 让位 bottom=94px＋面板与徽标盒及泡盒零重叠（盒重叠几何判定，泡带负偏移）`,
      panel?.computedBottom === '94px' && panel?.sidebarClass === true && panel?.separatedFromBadge === true
        && panel?.separatedFromCount === true && panel?.badgeCountStillVisible === true,
      `bottom=${String(panel?.computedBottom)} sidebar类=${String(panel?.sidebarClass)} 分离(徽标)=${String(panel?.separatedFromBadge)} 分离(泡)=${String(panel?.separatedFromCount)} 泡中心命中(展开态)=${String(panel?.badgeCountStillVisible)} panel=${JSON.stringify(panel?.rect)} badge=${JSON.stringify(panel?.badgeRect)} 泡=${JSON.stringify(panel?.countRect)}`);
    // 判据 B（第四轮常设）：面板盒×侧栏列盒零重叠——旧形 390 下面板 l=34 压进
    // ~52px 收起列、裁到列内图标右缘（flash 视觉盲测盲区；机器面此前未设此判）。
    check(`BADGE ${tag} 判据B：面板盒与侧栏列盒零重叠（两盒矩形相交即 FAIL）`,
      panel?.colOverlap === false,
      `panel=${JSON.stringify(panel?.rect)} 列盒=${JSON.stringify(panel?.colRect)} 相交=${String(panel?.colOverlap)}`);
    check(`BADGE ${tag} 面板宽度钳制生效（--sidebar：min(340px, 100vw-76px)）且不超视口`,
      panel?.widthClamped === true && panel?.leftNonNegative === true && panel?.rightWithinViewport === true,
      `computedWidth=${String(panel?.computedWidth)} 实测宽=${String(panel?.rect.w)} 期望上限=min(340, ${String(cfg.w)}-76)=${String(Math.min(340, cfg.w - 76))} left=${String(panel?.rect.l)} right=${String(panel?.rect.r)}/${String(panel?.vw)}`);
    await shotOf(`panel-${tag}.png`, { width: cfg.w, height: cfg.h, fullPage: false });
    await ensureCollapsed();
  }

  // ── 5) VIS-HOVER 回归（两主题；首轮三目标已证，本轮样式段重写只回归徽标）──
  await setViewport(page, 1500, 1000);
  for (const scheme of ['dark', 'light']) {
    console.log(`\n── HOVER ${scheme === 'dark' ? '深' : '浅'}主题 ──`);
    await ensureCollapsed();
    const theme = await applyTheme(scheme, 'document.querySelector(".ats-ask-badge")');
    check(`HOVER前置 ${scheme} 主题实证`, theme.applied, `实得 ${theme.bg}`);
    await hoverSequence('.ats-ask-badge（收起态）', 'document.querySelector(".ats-ask-badge")', scheme,
      `hover-badge-${scheme}.png`, { bg: true, color: true });
  }

  // ── 6) 收口批次：答掉两题（徽标随清空消隐——后续设置页阶段不再有 ask 面）──
  {
    // 判在场用徽标计数（sidebar 收起态 .ats-ask-panel 不渲染——读面板题数恒 0，
    // 首跑实证此口径缺陷会把待答批次误判「已收口」）。
    const badgeText = await evaluate(page, `document.querySelector('.ats-ask-badge .ats-ask-count')?.textContent ?? ''`);
    const badgeCount = Number.parseInt(badgeText, 10);
    if (Number.isFinite(badgeCount) && badgeCount > 0) {
      await expandPanel();
      const c1 = await clickBy(`${qExpr(Q1_TEXT)}?.querySelector('button.ats-ask-opt')`, 'Q1 预设一');
      await sleep(300);
      const s1 = await clickBy(`${qExpr(Q1_TEXT)}?.querySelector('.ats-ask-submit')`, 'Q1 提交');
      const c2 = await clickBy(`${qExpr(Q2_TEXT)}?.querySelector('button.ats-ask-opt')`, 'Q2 预设一');
      await sleep(300);
      const s2 = await clickBy(`${qExpr(Q2_TEXT)}?.querySelector('.ats-ask-submit')`, 'Q2 提交');
      const gone = (await waitFor(page, 'document.querySelectorAll(".ats-ask-panel .ats-ask-q").length', (n) => Number(n) === 0, 10_000)) === 0;
      const badgeGone = Number(await evaluate(page, 'document.querySelectorAll(".ats-ask-badge").length')) === 0;
      check('BADGE 收口：两题作答出列后徽标随待答清空消隐',
        c1 === 'clicked' && s1 === 'clicked' && c2 === 'clicked' && s2 === 'clicked' && gone && badgeGone,
        `q1=${String(c1)}/${String(s1)} q2=${String(c2)}/${String(s2)} 题目清空=${String(gone)} 徽标消隐=${String(badgeGone)}`);
      // 消隐后的底栏帧（视觉盲审面补帧：徽标不在场、面板收起——供审阅面判定）。
      if (gone && badgeGone) {
        await screenshot(page, join(SHOTS, 'badge-cleared.png'), { width: 768, height: 1024, fullPage: false });
      }
    } else {
      check('BADGE 收口：批次已在早前收口（留痕）', null, `徽标计数读数=${JSON.stringify(badgeText)}`);
    }
  }

  // 第二轮范围不含设置页正文对比度与 RA 双预设核对（首轮全 PASS，本轮 client.js
  // 改动不涉及设置页与 lib/——证据沿用 ../vis-ratify/）。
} catch (error) {
  cleanup();
  fail(`未预期异常：${String(error?.stack ?? error)}`);
}
cleanup();

let head = '';
try { head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(); } catch { /* 非 git 环境 */ }
const SCENE_NOTES = {
  badge: 'sidebar 收起态整帧：纯图标徽标（问号圆环）＋右上叠置计数泡在侧栏底栏窄图标列',
  panel: 'sidebar 展开态整帧：面板 --sidebar 让位（bottom:94px、右锚 16px 宽度公式左缘 ≥60px）、避列与三盒零重叠',
  'hover-badge': '徽标悬停近景（收起态，指针在徽标上——样式段重写后的回归）'
};
const sceneOf = (name) => {
  for (const key of Object.keys(SCENE_NOTES)) {
    if (name.startsWith(`${key}-`) === true) return SCENE_NOTES[key];
  }
  return '';
};
writeFileSync(join(LOGS, 'vis-ratify.json'), JSON.stringify({
  at: new Date().toISOString(), repo, head, hostVersion, failed, results,
  shots, sceneNotes: Object.fromEntries(shots.map((n) => [n, sceneOf(n)]))
}, null, 2));
writeFileSync(join(LOGS, 'instance-stdio.log'), instanceStdio.stdout + instanceStdio.stderr);
log(`证据落盘：${join(LOGS, 'vis-ratify.json')}（截图 ${String(shots.length)} 张在 shots/）`);
console.log(`\n判定：${failed === 0 ? '全部通过' : `存在 FAIL（${String(failed)} 项）`}`);
process.exit(failed === 0 ? 0 : 1);
