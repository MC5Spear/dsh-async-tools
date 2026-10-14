/**
 * 无头 Edge 存活诊断（判据载体）：诊断「受限沙箱档位下 spawn 的 Edge 进程树早夭」。
 *
 * 两个子命令（用法：node verify/diag-headless-edge.mjs <frames|lifetime>）：
 *
 * - `frames`：起一个浏览器，抓**浏览器级**与**页面级**两条 WebSocket 的原始帧转储。
 *   早夭形态：浏览器级 WS 能应答 `Browser.getVersion`，随后收 ERROR、调试端口 ECONNREFUSED；
 *   页面级 WS 打开但 `Runtime.enable` 无响应（探针层的症状即 `CDP Runtime.enable 超时`）。
 * - `lifetime`：直接 spawn 两个开关变体（`--headless=new` / `--headless`），stdio 直出，
 *   打印各自存活时长与退出码。早夭形态：~300ms 内 exit 0，stderr 见 crashpad
 *   `OpenProcess: 拒绝访问。(0x5)`。
 *
 * 判定口径（A/B）：受限档全灭 + `danger-full-access` 档 `frames` 能拿到版本帧 ⇒ 命中。
 *
 * 注意：每次启动无头 Edge 会产生一条 4625 失败登录（本地策略 10 次/10 分钟锁账户，
 * 会连累 NSSM 拉起托管服务）——连续诊断别超过几个实例，间隔 10 分钟再跑下一批。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBrowser, launch } from './_visual/cdp.mjs';

/** 抓一条 WebSocket 上 6 秒内的全部帧（发一条命令，转储收到的原始帧）。 */
async function dumpFrames(label, url, method) {
  await new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.addEventListener('open', () => { ws.send(JSON.stringify({ id: 1, method })); });
    ws.addEventListener('message', (event) => { frames.push(String(event.data).slice(0, 200)); });
    ws.addEventListener('error', (e) => { frames.push(`ERROR ${String(e.message ?? 'ws-error')}`); });
    ws.addEventListener('close', (e) => { frames.push(`CLOSE code=${String(e.code)}`); });
    setTimeout(() => {
      console.log(`[${label}] frames: ${frames.length === 0 ? '（零帧）' : ''}`);
      for (const f of frames.slice(0, 5)) console.log(`  ${f}`);
      ws.close();
      resolve();
    }, 6000);
  });
}

/** 子命令 frames：浏览器级 vs 页面级 WS 帧对照。 */
async function framesMode() {
  const { port, close } = await launch(findBrowser());
  try {
    const version = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json();
    console.log(`browser=${version.Browser ?? '?'} ws=${version.webSocketDebuggerUrl ?? 'none'}`);
    await dumpFrames('browser-level', version.webSocketDebuggerUrl, 'Browser.getVersion');
    const created = await fetch(`http://127.0.0.1:${String(port)}/json/new?about%3Ablank`, { method: 'PUT' });
    const target = await created.json();
    console.log(`page target: ${String(target.id)} type=${String(target.type)}`);
    await dumpFrames('page-level', target.webSocketDebuggerUrl, 'Runtime.enable');
  } finally {
    await close();
  }
}

/** 起一个开关变体，等它死或活满 watchMs。 */
async function runVariant(name, args, watchMs, browser) {
  const port = 9200 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(join(tmpdir(), 'cdpdiag-'));
  const child = spawn(browser, [
    ...args,
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions',
    '--disable-component-update', '--no-service-autorun',
    `--remote-debugging-port=${String(port)}`,
    `--user-data-dir=${profile}`,
    'about:blank'
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  const t0 = Date.now();
  let exited = false;
  child.on('exit', (code, signal) => {
    exited = true;
    console.log(`[${name}] exit after ${String(Date.now() - t0)}ms code=${String(code)} signal=${String(signal)}`);
  });
  for (let i = 0; i < watchMs / 500 && !exited; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${String(port)}/json/version`);
      if (r.ok && i % 4 === 0) console.log(`[${name}] port alive @${String(Date.now() - t0)}ms`);
    } catch { /* 端口没了 */ }
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  if (!exited) console.log(`[${name}] survived ${String(watchMs)}ms`);
  try { child.kill(); } catch { /* 已退 */ }
  await new Promise((resolve) => { setTimeout(resolve, 1500); });
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 占用 */ }
}

/** 子命令 lifetime：开关变体矩阵，直出 stderr 抓 crashpad。 */
async function lifetimeMode() {
  const browser = findBrowser();
  await runVariant('headless=new', ['--headless=new'], 20000, browser);
  await runVariant('headless', ['--headless'], 20000, browser);
}

const mode = process.argv[2] ?? 'frames';
if (mode === 'frames') await framesMode();
else if (mode === 'lifetime') await lifetimeMode();
else {
  console.error('用法：node verify/diag-headless-edge.mjs <frames|lifetime>');
  process.exit(2);
}
