/**
 * 子代理 activation 卸载面真机探针（VERIFY-01：需求 8.2「安装卸载」行的
 * 子代理面——设计 §7.1 第三类生命周期「dsh-subagent activation 所有权」；
 * issue-list「子代理 activation 所有权卸载面」项）。
 *
 * ## 探针在证什么
 *
 * IL-2 已锚定 owner 作业面（运行中卸载不取消已启动工作）；本探针把同一
 * 形态推到子代理面——后台子代理是宿主 activation 管理器拥有的运行（设计
 * §3.3「宿主 activation 管理器拥有已接受运行、后代所有权、自然结算、资源
 * 释放和父会话通知」），工具行卸载不取得停止 activation 的权限（§3.3「本
 * 包不将等待信号接到后台运行，也不在工具出口、finally 或工具行卸载时调用
 * dispose」；装置目标行＝§7.1 第三类待核验对象＋§8.2 核心矩阵「activation
 * 生命周期」行）。正文断言只认宿主侧载体（tool/result 文本、转录事件），
 * 模型文本只作回执：
 *
 * 1. SU-1 武装步：新会话（dsh-async 预设）经 async_agent 派生长跑子代理
 *    （子代理执行约 90s 命令后以固定 token 回答）——async_agent 调用在
 *    场＋工具返回含 agent_id（子代理真正启动的证据）＋模型回执；
 * 2. SU-2 卸载不取消已启动子代理（主判据，单尝试）：子代理运行中执行
 *    plugin remove（官方 CLI，运行中实例）——子代理照常结算、最终回答经
 *    宿主侧载体（注入侧 user/message）到达主会话、主代理按指令回执——
 *    「activation 所有权属宿主、卸载不停止后台」的行为面实证；
 * 3. SU-3 卸载后老会话可续派子代理：remove 后同会话再经 async_agent 派
 *    第二个短子代理——第二个 agent_id 回执在场＋其最终回答照常到达——
 *    保活链子代理面完整（内存中插件仍在，与 IL-2 的作业面对应）。
 *
 * 装置边界（如实声明）：宿主组件内部（dsh-subagent）的 activation 清理
 * 不可从 RPC 面观测——本探针锚定行为面（结算照常＋父通知照投＋可续派）；
 * 自然结算后的资源释放由宿主负责（§7.1 后台所有权约定），内部释放证据不
 * 冒称。SU-2 存在窗口竞态边界：武装步模型周转＋基线拉取＋remove（timeout
 * 300s）合计若超过子代理剩余运行时间，最终回答落在主步基线之前、主步必
 * FAIL——属装置形态（证据含 remove 耗时可事后归因），不是产品缺陷；子代
 * 理时长取 90s（含子代理自身模型周转）留出周转窗口。plugin remove 在运行
 * 中实例的 profile 上执行，Windows 文件锁若使 remove 失败按环境形态记录
 * （IL-2 同款）——remove 失败时 SU-3 照常执行，其 PASS 只证续派形态在场
 * （「卸载」未发生、不证卸载后可续派），事后按 pluginRemove.status 区分。
 * 子代理长跑命令依赖 PowerShell（Start-Sleep）——非 PowerShell 宿主上输出
 * token 缺席、SU-2 按 FAIL（非 FAULT）取证。每步超时或断言不成立同会话重
 * 试一次（SU-1/SU-3 默认双尝试——重试会派生新子代理、投递事件落在新窗
 * 内、重试有意义；模型偶发不执行单步指令不等于产品缺陷，重试留痕）；**重试承诺不适用于单次投递
 * 事件形态的步骤**——SU-2 的子代理最终回答只发生一次，重试的窗口基线会
 * 切走已发生的事件而必不成立，以 maxAttempts:1 声明单尝试。
 *
 * ## 用法
 *
 *   node verify/probe-subagent-uninstall.mjs --service-root <宿主服务根> \
 *     --host-subdir <宿主树目录名，如 dsh-0.2.1-rc.5> [--repo <本仓路径>] [--keep]
 *
 * `--service-root` 必填（或设 `DSAT_SERVICE_ROOT`）。探针以
 * `<serviceRoot>/patches/zai-glm.yml` 作为实例模型路由 patch——该文件由本机
 * 部署环境提供，缺失时实例在就绪等待处 FAULT（90s 超时＋stderr 尾部），请
 * 自备同位 patch 或改参。tgz 产物结束自清；证据 JSON 每次落盘保留在 `.local/`
 * （FAULT 路径的 tgz 与临时 home 都不清——fail() 会打印 home 路径，重跑前可
 * 手动清理）。退出码：0＝全部判定通过；
 * 1＝存在 FAIL 判定；2＝探针自身故障（FAULT）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const keep = args.includes('--keep');
// repo 先于 fail 解析（fail 的落盘路径要用它，避免早期故障时 TDZ）。
const repo = resolve(argOf('repo') ?? process.cwd());
let home = null;
// 证据容器前置声明：FAULT 路径也要尽力落盘已收集的部分证据（let 避免 TDZ）。
let evidence = null;
const fail = (msg) => {
  console.error(`[probe] FAULT: ${msg}\n[probe] 临时目录：${home ?? '（尚未创建）'}${keep ? '（--keep 保留）' : '（探针故障路径，请手动清理）'}`);
  try {
    if (evidence !== null) {
      mkdirSync(join(repo, '.local'), { recursive: true });
      writeFileSync(join(repo, '.local', 'probe-subagent-uninstall.json'), JSON.stringify({ ...evidence, fault: String(msg) }, null, 2));
      console.error('[probe] 已尽力落盘部分证据（本机材料目录）');
    }
  } catch { /* 故障路径的落盘失败不再掩盖原故障 */ }
  process.exit(2);
};
// 退出码契约（0/1/2）：任何未捕获异常/拒绝都归入 FAULT=2，不以裸异常退出。
process.on('uncaughtException', (error) => { fail(`未捕获异常：${String(error?.stack ?? error)}`); });
process.on('unhandledRejection', (reason) => { fail(`未处理的 Promise 拒绝：${String(reason)}`); });
const serviceRootArg = argOf('service-root') ?? process.env.DSAT_SERVICE_ROOT;
if (serviceRootArg === undefined || serviceRootArg.trim() === '') fail('缺少 --service-root（或环境变量 DSAT_SERVICE_ROOT）：指向装有各宿主树的根目录');
const serviceRoot = resolve(serviceRootArg);
const hostSubdir = argOf('host-subdir') ?? 'dsh-0.2.1-rc.5';
const hostRoot = join(serviceRoot, hostSubdir);
let hostVersion;
try {
  hostVersion = JSON.parse(readFileSync(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
} catch (error) {
  fail(`无法读取宿主树版本（--service-root/--host-subdir 是否指向有效的 dsh 安装树？）：${String(error?.message ?? error)}`);
}

const log = (msg) => console.log(`[probe] ${msg}`);

// 1) 打包当前工作区（npm pack --ignore-scripts；产物落 .local/）。
mkdirSync(join(repo, '.local'), { recursive: true });
const headRun = spawnSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
const head = headRun.status === 0 ? headRun.stdout.trim() : 'unknown-head';
const dirtyRun = spawnSync('git', ['-C', repo, 'status', '--short'], { encoding: 'utf8' });
const dirty = dirtyRun.status === 0 && dirtyRun.stdout.trim() !== '' ? '（含未提交改动）' : '';
log(`repo=${repo} head=${head}${dirty} hostRoot=${hostRoot} hostVersion=${hostVersion}`);
const packRun = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', '.local'], { cwd: repo, encoding: 'utf8', shell: true });
if (packRun.status !== 0) fail(`npm pack 退出 ${String(packRun.status)}：${packRun.stderr}`);
const tgzName = (packRun.stdout.match(/dsh-async-tools-[^\s]+\.tgz/g) ?? []).pop();
if (tgzName === undefined) fail('npm pack 未产出 dsh-async-tools tgz');
const tgzPath = join(repo, '.local', tgzName);
log(`tgz=${tgzName}`);

// 2) 独立 DSH_HOME（系统临时目录）＋ 官方 CLI 安装（正式装载路径）。
home = mkdtempSync(join(tmpdir(), 'dsh-sbun-'));
const cliBin = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const addRun = spawnSync('node', [cliBin, 'plugin', '--profile', 'web', 'add', tgzPath], {
  cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 300_000
});
if (addRun.status !== 0) fail(`plugin add 退出 ${String(addRun.status)}：stderr 尾部 ${String(addRun.stderr).slice(-600)}／stdout 尾部 ${String(addRun.stdout).slice(-600)}`);
log('plugin add 完成');

// 3) 起隔离实例（随机端口；本探针不重启，单实例跑全程）。
let child = null;
let stdout = '';
let stderrTail = '';
function killChild() {
  if (child !== null && child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
  }
}
process.on('exit', () => { killChild(); });
stdout = '';
stderrTail = '';
child = spawn('node', [cliBin, '--patch', join(serviceRoot, 'patches', 'zai-glm.yml'), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  cwd: serviceRoot,
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (c) => { stdout += c; });
child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-4000); });
const url1 = await new Promise((resolveUrl, rejectUrl) => {
  const timer = setTimeout(() => rejectUrl(new Error('实例 90s 内未就绪')), 90_000);
  const poll = setInterval(() => {
    const m = stdout.match(/https?:\/\/\S+/);
    if (m !== null) { clearTimeout(timer); clearInterval(poll); resolveUrl(m[0]); }
    if (child.exitCode !== null) { clearTimeout(timer); clearInterval(poll); rejectUrl(new Error(`实例提前退出 ${String(child.exitCode)}`)); }
  }, 200);
}).catch((error) => { killChild(); fail(`${String(error.message)}\nstderr 尾部：\n${stderrTail}`); });
log(`实例就绪：${url1.split('?')[0]}（token 已隐去）`);
await new Promise((r) => { setTimeout(r, 5000); });

// 4) RPC 骨架（token→cookie；fetch 带超时，连接被关闭时重试一次）。
const urlMatch = url1.match(/^(https?:\/\/[^/?#]+)\/?\?token=(.+)$/);
if (urlMatch === null) { killChild(); fail(`实例 URL 形态不符：${url1.split('?')[0]}`); }
const [, ORIGIN, TOKEN] = urlMatch;
const indexResponse = await fetch(`${ORIGIN}/?token=${TOKEN}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
const COOKIE = (indexResponse.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
if (COOKIE.length === 0) { killChild(); fail('token exchange returned no cookie'); }
async function rpc(endpoint, argsBody) {
  const body = JSON.stringify({
    type: 'client-request', rpcId: `probe-${Math.random().toString(36).slice(2, 10)}`,
    method: endpoint, payload: { args: argsBody }
  });
  let response;
  try {
    response = await fetch(`${ORIGIN}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body,
      signal: AbortSignal.timeout(60_000)
    });
  } catch (connError) {
    // 重试一次——session/prompt 首请求已达服务端而响应丢失时可能重复排队同
    // 文指令，本探针每步指令带固定 token、重复排队不产生假 PASS（判定窗按
    // 事件切）。
    log(`rpc ${endpoint} 首次请求失败，重试一次：${String(connError?.message ?? connError)}`);
    response = await fetch(`${ORIGIN}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body,
      signal: AbortSignal.timeout(60_000)
    });
  }
  const parsed = JSON.parse(await response.text());
  if (parsed?.result?.ok !== true) return { ok: false, error: parsed?.result?.error ?? null };
  return { ok: true, value: parsed.result.value };
}
async function rpcOk(endpoint, argsBody) {
  const r = await rpc(endpoint, argsBody);
  if (r.ok !== true) fail(`${endpoint} 调用失败：${JSON.stringify(r.error).slice(0, 200)}`);
  return r.value;
}

// 5) 转录取证提取器（同既有探针口径：下标切窗、宿主侧载体）。
async function transcriptOf(sessionId) {
  const listing = await rpcOk('session/list', { _request: {} });
  const row = listing.items.find((item) => item.sessionId === sessionId);
  if (row === undefined) throw new Error('session not found');
  return rpcOk('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 1200 }
  });
}
function stepRecords(transcript, fromIndex) {
  return (transcript.records ?? []).slice(fromIndex);
}
function modelTexts(transcript, fromIndex = 0) {
  return stepRecords(transcript, fromIndex)
    .filter((r) => r.event?.type === 'assistant/message' || r.event?.type === 'model/message')
    .map((r) => (r.event.data?.message?.content ?? r.event.data?.content ?? [])
      .map((c) => String(c.text ?? '')).join('\n'));
}
function toolResultTexts(transcript, fromIndex = 0) {
  return stepRecords(transcript, fromIndex)
    .filter((r) => r.event?.type === 'tool/result')
    .map((r) => (r.event.data?.message?.content ?? [])
      .filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('\n'));
}
function toolCallNames(transcript, fromIndex = 0) {
  const names = new Set();
  for (const r of stepRecords(transcript, fromIndex)) {
    if (r.event?.type !== 'tool/call') continue;
    const name = r.event.data?.name ?? r.event.data?.toolName ?? r.event.data?.message?.name;
    if (typeof name === 'string') names.add(name);
  }
  return names;
}
/** 全部注入侧 user/message 文本（不限 source.kind——子代理最终回答等交付载体
 *  有各自的 source 形态，取证先全量、判定再分形态；真用户消息不算注入）。 */
function injectedTexts(transcript, fromIndex = 0) {
  const out = [];
  for (const r of stepRecords(transcript, fromIndex)) {
    if (r.event?.type !== 'user/message') continue;
    const message = r.event.data?.message ?? r.event.data;
    const source = message?.source?.kind ?? '';
    if (source === '' || source === 'user') continue;
    out.push({ source, text: (message.content ?? []).map((c) => String(c.text ?? '')).join('\n') });
  }
  return out;
}

// 6) 步骤驱动（单步指令＋固定回执 token；首不成重试一次）。
const STEP_TIMEOUT_MS = 420_000;
const POLL_MS = 4000;
const verdicts = [];
evidence = { head, dirty: dirty !== '', hostVersion, sessions: {}, steps: [], verdicts, phases: {} };
function judge(name, ok, detail = '') {
  verdicts.push({ name, ok: ok === true, detail: String(detail).slice(0, 500) });
  console.log(`${ok === true ? 'PASS ' : 'FAIL '} ${name}${detail === '' ? '' : `  —— ${String(detail).slice(0, 240)}`}`);
}
async function driveStep(sessionId, step) {
  const record = { name: step.name, attempts: [] };
  evidence.steps.push(record);
  const maxAttempts = step.maxAttempts ?? 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let beforeCount = 0;
    let baselineDegraded = false;
    try { beforeCount = (await transcriptOf(sessionId)).records?.length ?? 0; }
    catch { baselineDegraded = true; /* 基线拉取失败沿用 0，窗退化为全转录（打标入尝试留痕） */ }
    try {
      await rpcOk('session/prompt', {
        request: {
          requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
          sessionId, mode: 'queue',
          content: [{ type: 'text', text: step.prompt }],
          clientTimeZone: 'Asia/Shanghai'
        }
      });
    } catch (error) {
      killChild();
      fail(`session/prompt 调用失败：${String(error?.message ?? error)}`);
    }
    const deadline = Date.now() + (step.timeoutMs ?? STEP_TIMEOUT_MS);
    let lastDetail = '（无判定输出）';
    while (Date.now() < deadline) {
      await new Promise((r) => { setTimeout(r, POLL_MS); });
      if (child !== null && child.exitCode !== null) { killChild(); fail('实例在步骤中途退出'); }
      let transcript;
      try { transcript = await transcriptOf(sessionId); } catch { continue; }
      const ctx = {
        modelTexts: modelTexts(transcript, beforeCount),
        toolResults: toolResultTexts(transcript, beforeCount),
        toolNames: toolCallNames(transcript, beforeCount),
        injected: injectedTexts(transcript, beforeCount),
        baselineDegraded
      };
      const outcome = step.judge(ctx);
      if (outcome.ok === true) {
        record.attempts.push({ attempt, ok: true, detail: outcome.detail, baselineDegraded });
        judge(step.name, true, outcome.detail);
        return true;
      }
      lastDetail = outcome.detail ?? lastDetail;
      record.snapshot = {
        toolNames: [...ctx.toolNames],
        toolResults: ctx.toolResults.slice(-8).map((t) => t.slice(-400)),
        injected: ctx.injected.slice(-4).map((e) => ({ source: e.source, text: e.text.slice(-250) })),
        modelTail: ctx.modelTexts.slice(-4).map((t) => t.slice(-200)),
        baselineDegraded
      };
    }
    record.attempts.push({ attempt, ok: false, detail: lastDetail });
    log(`步骤 ${step.name} 第 ${String(attempt)} 次未成立（${lastDetail}）${attempt < maxAttempts ? '，重试一次' : ''}`);
  }
  judge(step.name, false, `${String(maxAttempts)} 次尝试未成立；最后状态：${String(evidence.steps.at(-1).attempts.at(-1).detail)}`);
  return false;
}

// ── 会话建立（dsh-async 预设；装载前置失败归判据 FAIL 走收尾退出 1）──
console.log(`\n── 会话建立（当前候选 ${head}${dirty}）──`);
const created1 = await rpc('session/create', { request: { cwd: home, agentPreset: 'dsh-async' } });
if (created1.ok !== true || created1.value?.agentPreset !== 'dsh-async') {
  judge('SU-0 装载后 dsh-async 预设会话可用', false,
    `装载前置失败：${created1.ok ? `agentPreset 回落 ${String(created1.value?.agentPreset)}` : JSON.stringify(created1.error).slice(0, 160)}`);
  await shutdownAndFinish();
}
const s1 = created1.value;
evidence.sessions.main = s1.sessionId;
judge('SU-0 装载后 dsh-async 预设会话可用', true, `会话 A 已建（sessionId=${s1.sessionId.slice(0, 14)}…）`);

// ── SU-1 武装步：派生长跑子代理（约 90s）──
console.log('\n── SU-1 派生长跑子代理 ──');
await driveStep(s1.sessionId, {
  name: 'SU-1 长跑子代理已启动（agent_id 回执）',
  prompt: 'Run this single step and reply with exactly the token SU1_ARMED: call async_agent with description "su1 long child", prompt "Run this single step: call async_run with command \'Start-Sleep -Seconds 90; Write-Output SU1-CHILD-88\', description \'su1 child long job\', yield_ms 600000 and wait for its foreground output. Then reply with exactly the token SU1_CHILD_DONE plus that output token on one line." — it returns an agent_id immediately; then reply SU1_ARMED and end your turn WITHOUT waiting. No other tools, no questions.',
  judge: (ctx) => {
    const spawnUsed = ctx.toolNames.has('async_agent');
    // 启动锚：async_agent 工具返回文本含 agent_id——子代理真正被宿主接受的证据，
    // 模型只回 token 而子代理未启动时不得 PASS（否则 SU-2 会误归因为卸载取消）。
    const idReceipt = ctx.toolResults.some((t) => /agent_id/i.test(t));
    const receipt = ctx.modelTexts.some((t) => t.includes('SU1_ARMED'));
    const ok = spawnUsed && idReceipt && receipt;
    return { ok, detail: ok ? 'async_agent 在场＋agent_id 回执（子代理已启动）＋模型回执武装' : `async_agent 在场 ${String(spawnUsed)}／agent_id 回执 ${String(idReceipt)}／回执 ${String(receipt)}` };
  }
});

// 武装步未成立时 SU-2 判据不可归因——remove 照常执行以留证据，主步不并入结论。
const armedStep = evidence.steps.find((s) => s.name === 'SU-1 长跑子代理已启动（agent_id 回执）');
const armedOk = armedStep?.attempts.some((a) => a.ok === true) === true;
let baselineCount = null;
try { baselineCount = (await transcriptOf(s1.sessionId)).records?.length ?? null; } catch { baselineCount = null; }
evidence.phases.baselineBeforeRemove = baselineCount;
const removeStart = Date.now();
const removeRun = spawnSync('node', [cliBin, 'plugin', '--profile', 'web', 'remove', 'dsh-async-tools'], {
  cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 300_000
});
evidence.phases.pluginRemove = {
  status: removeRun.status,
  elapsedMs: Date.now() - removeStart,
  stdoutTail: String(removeRun.stdout).slice(-800),
  stderrTail: String(removeRun.stderr).slice(-800)
};
log(`plugin remove 退出码 ${String(removeRun.status)}，耗时 ${String(Math.round((Date.now() - removeStart) / 1000))}s${removeRun.status !== 0 ? '（Windows 文件锁或 pnpm 环境形态，见证据）' : ''}`);

// ── SU-2 卸载不取消已启动子代理（主判据；单次投递形态、单尝试）──
console.log('\n── SU-2 运行中卸载不取消已启动子代理 ──');
if (removeRun.status !== 0) {
  judge('SU-2 卸载后子代理照常结算且最终回答到达', false, `plugin remove 退出 ${String(removeRun.status)}（环境形态：${String(removeRun.stderr).slice(-200) || String(removeRun.stdout).slice(-200)}）——SU-3 照常执行以取证续派形态`);
} else if (!armedOk) {
  judge('SU-2 卸载后子代理照常结算且最终回答到达', false, '武装步未成立（子代理可能未启动）——主步判据不可归因，不并入「卸载取消子代理」结论');
} else {
  // remove 成功：子代理从启动到最终回答约 90s＋周转；此处等待最终回答经宿主侧
  // 载体到达。本步单尝试：子代理最终回答是单次投递事件（头注装置边界）。
  await driveStep(s1.sessionId, {
    name: 'SU-2 卸载后子代理照常结算且最终回答到达',
    maxAttempts: 1,
    prompt: 'The child agent from before is still running in the background. Do NOT call any tool yet. When its final answer reaches you (as a message or in any delivery form), reply with exactly SU2_DONE and end your turn. No other tools, no questions.',
    timeoutMs: 420_000,
    judge: (ctx) => {
      // 子代理最终回答只认宿主侧载体（注入侧 user/message——source 形态不限），
      // 模型文本单独出现不算（那正是「父通知丢失」要抓的缺陷面）。
      const childAnswer = ctx.injected.some((e) => e.text.includes('SU1_CHILD_DONE') && e.text.includes('SU1-CHILD-88'));
      const receipt = ctx.modelTexts.some((t) => t.includes('SU2_DONE'));
      const ok = childAnswer && receipt;
      return { ok, detail: ok ? '子代理最终回答经宿主侧载体到达（activation 所有权属宿主、卸载不停止后台）＋主代理回执' : `宿主侧载体命中 ${String(childAnswer)}（注入 ${String(ctx.injected.length)} 条）／主代理回执 ${String(receipt)}` };
    }
  });
}

// ── SU-3 卸载后老会话可续派子代理 ──
console.log('\n── SU-3 卸载后同会话续派子代理 ──');
await driveStep(s1.sessionId, {
  name: 'SU-3 卸载后同会话可续派子代理（保活链完整）',
  prompt: 'Run this single step: call async_agent with description "su3 second child", prompt "Reply with exactly the single token SU3-CHILD-77 and nothing else." — it returns an agent_id immediately; end your turn WITHOUT waiting. When the child agent answer reaches you, reply with exactly SU3_DONE and end your turn. No other tools, no questions.',
  timeoutMs: 420_000,
  judge: (ctx) => {
    const spawnUsed = ctx.toolNames.has('async_agent');
    const idReceipt = ctx.toolResults.some((t) => /agent_id/i.test(t));
    const childAnswer = ctx.injected.some((e) => e.text.includes('SU3-CHILD-77'));
    const receipt = ctx.modelTexts.some((t) => t.includes('SU3_DONE'));
    const ok = spawnUsed && idReceipt && childAnswer && receipt;
    return { ok, detail: ok ? '第二个 async_agent 在场＋agent_id 回执＋其最终回答经宿主侧载体到达＋回执——保活链子代理面完整' : `async_agent 在场 ${String(spawnUsed)}／agent_id 回执 ${String(idReceipt)}／第二子代理回答到达 ${String(childAnswer)}／回执 ${String(receipt)}` };
  }
});

// 7) 收尾：停实例→留证据→清理（--keep 时保留临时 home 供排查）。
function finishRun() {
  try { rmSync(tgzPath, { force: true }); } catch { /* 产物清理尽力而为 */ }
  mkdirSync(join(repo, '.local'), { recursive: true });
  writeFileSync(join(repo, '.local', 'probe-subagent-uninstall.json'), JSON.stringify(evidence, null, 2));
  const failures = verdicts.filter((v) => v.ok !== true).length;
  console.log(failures === 0 ? `\n判定：全部通过（${String(verdicts.length)} 项）` : `\n判定：${String(failures)} 项 FAIL（共 ${String(verdicts.length)} 项）`);
  process.exit(failures === 0 ? 0 : 1);
}
async function shutdownAndFinish() {
  killChild();
  await new Promise((r) => { setTimeout(r, 1500); });
  if (keep) {
    log(`--keep：保留临时 home 供排查：${home}`);
  } else {
    try { rmSync(home, { recursive: true, force: true }); log(`已清理临时 home：${home}`); }
    catch { console.error(`[probe] WARN: 临时目录清理失败，留存现场：${home}`); }
  }
  log(`证据落盘：${join('.local', 'probe-subagent-uninstall.json')}（本机材料目录）`);
  finishRun();
}
await shutdownAndFinish();
