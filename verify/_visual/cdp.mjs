/**
 * 无依赖的 CDP 客户端：用 Edge 的 `--remote-debugging-port` 打开页面并取回真实 DOM。
 *
 * ## 为什么要自己写
 *
 * 本机装了 Edge，而 Edge 支持 `--headless=new --remote-debugging-port`。
 * 不需要 playwright/puppeteer（都没装，也不该为一个探针去装）。
 *
 * `--dump-dom` 在 Edge 上**不吐内容**（stdout/stderr 都是 0 字节），所以走 CDP：
 * `Runtime.evaluate` 才是可靠的取 DOM 方式——它拿的是 JS 求值结果，不依赖打印行为。
 *
 * 用法（一般由 probe-card-visual.mjs 调用，不直接跑）：
 *   node cdp.mjs <url> <表达式> [等待毫秒]
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

/**
 * 起一个无头浏览器并等它的调试端口就绪。
 *
 * ## 清理逻辑不是可选的
 *
 * `child.kill()` **只杀主进程**，而 Edge 是**多进程**架构（浏览器进程 + GPU + 渲染器 +
 * 网络服务 + 崩溃处理器…，一个实例约 10 个进程）。只杀主进程会把其余留成孤儿。
 *
 * 不清理的后果有两层：反复起实例会把多进程孤儿积在盘上；更要紧的是——
 * **每次启动无头 Edge 都会产生一条 4625 失败登录**（`Logon Type: 2`、
 * `Caller Process Name: msedge.exe`），本地账户策略按 **10 次 / 10 分钟 ⇒
 * 锁定 10 分钟**，账户一锁 NSSM 就用不了 `.\user` 拉起托管服务。
 *
 * 现行做法：尽量少起进程与少碰系统服务，**按整棵进程树清理**。
 *
 * @param {string} browserPath - 浏览器可执行文件。
 * @param {string[]} [extraArgs] - 追加启动参数（默认空——`Emulation.setLocaleOverride`
 *   在本机 headless Edge 上不改变 `navigator.language`，宿主语言模拟用 `--lang`
 *   启动开关）。
 * @returns {Promise<{process: import('node:child_process').ChildProcess, port: number, profile: string, close: () => void}>}
 */
export async function launch(browserPath, extraArgs = []) {
  const port = 9200 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
  const child = spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    // 少起进程、少碰网络与系统服务：既降资源，也减少触发系统登录的机会。
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-update',
    '--no-service-autorun',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    ...extraArgs,
    'about:blank'
  ], { stdio: 'ignore' });

  // 等端口就绪：轮询 `/json/version`。
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`);
      if (response.ok) { ready = true; break; }
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) {
    killTree(child.pid);
    throw new Error(`浏览器调试端口 ${String(port)} 在 30 秒内没就绪`);
  }
  return {
    process: child,
    port,
    profile,
    close: () => {
      // ① 按树杀（`/T`）——覆盖还没脱离父进程的那些；
      // ② 再按**本实例的 profile 路径**扫一遍——主进程若已退出、树结构断了，
      //    `--user-data-dir=<本实例 profile>` 仍能精确命中残留，
      //    且绝不会误伤用户自己开的浏览器（profile 路径不同）。
      killTree(child.pid);
      try { child.kill(); } catch { /* 已退出 */ }
      sweepByProfile(profile);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* 占用中，留着 */ }
    }
  };
}

/**
 * 按 PID 杀整棵进程树。
 *
 * 用 `taskkill /T /F`：Windows 上这是唯一可靠的"连同子进程一起杀"的手段。
 * 按父子关系递归（`Invoke-CimMethod Terminate`）**不可行**：主进程一死父子
 * 关系就断，剩下的孤儿再也找不到。
 *
 * @param {number} pid - 根进程 PID。
 */
function killTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' });
  } catch { /* 进程可能已经退出 */ }
}

/**
 * 按 profile 路径清掉残留进程（回退手段）。
 *
 * 比 `killTree` 更狠：即使主进程已退出、树结构断了，也能靠命令行里的
 * `--user-data-dir` 精确找到本实例的残留子进程。**只动本实例的 profile。**
 *
 * ## 路径**不能**拼进 PowerShell 脚本里
 *
 * 把路径插进 `-like '*<路径>*'` 并给反斜杠做"转义"（`\\`），会
 * **匹配到 0 个进程**——命令行里的实际内容是单反斜杠
 * （`--user-data-dir="C:\Users\...\cdp-XYZ"`），而双反斜杠的模式要求匹配
 * 两个连续反斜杠。PowerShell 字符串的转义符是**反引号**：反斜杠在单引号
 * 串里是字面量，在双引号串里也**不是**转义符——给它"转义"没有语言依据，
 * 只会把模式改坏。
 *
 * 所以路径走**环境变量**，脚本里只读 `$env:`，一个转义字符都不需要。
 *
 * @param {string} profile - 本实例的临时 profile 路径。
 */
function sweepByProfile(profile) {
  try {
    const script = 'if ($env:CDP_SWEEP_PROFILE) { '
      + 'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\' OR Name=\'chrome.exe\'" '
      + '| Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:CDP_SWEEP_PROFILE) } '
      + '| ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null } }';
    execFileSync('powershell', ['-NoProfile', '-Command', script], {
      stdio: 'pipe',
      env: { ...process.env, CDP_SWEEP_PROFILE: profile }
    });
  } catch { /* 清不掉就留着，下一次 sweep 还会命中 */ }
}

/**
 * 打开一个页面并返回它的 CDP 会话。
 *
 * @param {number} port - 调试端口。
 * @param {string} url - 目标 URL。
 * @returns {Promise<{send: (method: string, params?: object) => Promise<any>, close: () => void}>}
 */
export async function openPage(port, url) {
  const created = await fetch(`http://127.0.0.1:${String(port)}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT'
  });
  const target = await created.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (message.method !== undefined) events.push(message);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }
    }, 60_000);
  });

  await send('Runtime.enable');
  await send('Page.enable');
  return {
    send,
    events,
    close: () => { try { socket.close(); } catch { /* 已关 */ } }
  };
}

/** 在页面里求值，返回 JSON 化的结果。 */
export async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails !== undefined) {
    throw new Error(`页面求值抛错：${result.exceptionDetails.text} ${JSON.stringify(result.exceptionDetails.exception?.description ?? '')}`);
  }
  return result.result.value;
}

/** 找一个可用的浏览器；找不到返回 undefined。 */
export function findBrowser() {
  return EDGE_CANDIDATES.find((path) => existsSync(path));
}

/**
 * 轮询页面直到求值结果满足判据，或超时。
 *
 * ## 为什么必须有这个（而不是 `await wait(1200)`）
 *
 * 前端是异步渲染的：改一个受控输入后，按钮的 `disabled` 要等**下一次渲染**才更新。
 * 固定 `sleep(1200)` 在快机器上够、在慢机器上**偶发不够**——而偶发红会被人
 * 当成产品缺陷去查（本项目真实踩过：探针在设值后立刻点"保存"，读到的是上一次渲染的
 * `disabled=true`，于是"保存没生效"看起来像产品坏了，其实是探针的竞态）。
 *
 * 轮询还有一个好处：**超时时能把最后读到的值报出来**，
 * 而 `sleep` 之后只能知道"不对"，不知道"停在哪个状态"。
 *
 * @param {object} page - `openPage()` 返回的页对象。
 * @param {string} expression - 页面里求值的表达式。
 * @param {(value: unknown) => boolean} predicate - 判据。
 * @param {number} [timeoutMs] - 超时毫秒数。
 * @returns {Promise<unknown>} 满足判据时的值；超时则返回最后一次读到的值。
 */
export async function waitFor(page, expression, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await evaluate(page, expression);
    if (predicate(last)) return last;
    if (Date.now() > deadline) return last;
    await new Promise((resolve) => { setTimeout(resolve, 250); });
  }
}

/**
 * 截一张整页图，写到 `path`，并返回像素尺寸。
 *
 * ## 为什么截图是必需的验证手段
 *
 * 只读 `innerText` 的探针**只能证明文字在 DOM 里**，证明不了"人看得见"：
 * 元素可能被遮挡、宽度为 0、颜色与背景相同、藏在收起的抽屉里。
 * **截图一眼就能看出真实布局**。
 *
 * `Page.captureScreenshot` 返回 base64；`captureBeyondViewport: true` 让它连
 * 视口外的内容一起截，配合 `Emulation.setDeviceMetricsOverride` 设一个足够的视口高度。
 *
 * @param {object} page - `openPage()` 返回的会话。
 * @param {string} path - 输出 png 路径。
 * @param {{width?: number, height?: number, fullPage?: boolean}} [options] - 视口选项。
 * @returns {Promise<{path: string, bytes: number, width: number, height: number}>}
 */
export async function screenshot(page, path, options = {}) {
  const width = options.width ?? 1600;
  const height = options.height ?? 1000;
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  });
  const result = await page.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: options.fullPage !== false
  });
  const buffer = Buffer.from(result.data, 'base64');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, buffer);
  return { path, bytes: buffer.length, width, height };
}

// 允许直接跑：node cdp.mjs <url> <表达式> [等待毫秒]
if (process.argv[1]?.endsWith('cdp.mjs') === true) {
  const url = process.argv[2];
  const expression = process.argv[3] ?? 'document.title';
  const waitMs = Number(process.argv[4] ?? '4000');
  const browser = EDGE_CANDIDATES.find((path) => existsSync(path));
  if (browser === undefined) {
    console.error('找不到 Edge/Chrome');
    process.exit(2);
  }
  const instance = await launch(browser);
  try {
    const page = await openPage(instance.port, 'about:blank');
    await page.send('Page.navigate', { url });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const value = await evaluate(page, expression);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    page.close();
  } finally {
    instance.close();
  }
}
