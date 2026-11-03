/**
 * 等待经济性真机探针（VERIFY-01：需求 8.2「等待必要性」的计量对照装置——
 * issue-list「计量对照须记录模型请求数和可取得的输入、缓存命中及输出用量」）。
 *
 * ## 探针在证什么
 *
 * 等待语义探针（probe-wait-semantics）已证行为面（挂起、出口、打断、协作）；
 * 本探针补**计量面**：同一时长的后台作业下，「async_wait 挂起等待」与「模型
 * 反复零等待轮询」两种形态的模型请求数对照——等待式不逐轮消耗模型请求，
 * 是「等待必要性」的收益实证。两形态各一会话、同实例同模型路由并行对照：
 *
 * 1. EC-A 等待式：async_run（约 45s 作业，token A）转后台 → async_wait 以足额
 *    预算挂起 → 作业完成正文经等待返回 → 回执；
 * 2. EC-B 轮询式：async_run（约 45s 作业，token B）转后台 → 按指令反复
 *    async_wait wait_ms=0（零等待立即检查）直至正文到达 → 回执；
 *    （两会话同实例同模型路由、作业时长相同——平行分组对照；先后推进，
 *    对照口径是模型轮次与用量而非墙钟）
 * 3. EC-C 对照判定：B 的模型轮次（assistant/message 事件数——每轮一次模型
 *    请求恰产出一条；两会话自创建起 fromIndex=0 对称累计，公平对照；步骤重
 *    试会抬高各自轮次——A 侧抬高走保守方向可假 FAIL，B 侧抬高与差值判据同
 *    向，次数锚保证成功尝试确为轮询形态、失败尝试的抬高幅度可由 attempts
 *    留痕离线区分）显著多于 A（差值 ≥2 且 A ≤3）；
 *    session/list 两行的 usage 聚合（projections.values.tokenUsage）与
 *    pressureTokens/projectedTokens（projections.values.contextPressure）落
 *    证据作旁证——usage 由供应商报告决定在场与否，缺席不构成 FAIL，按「可
 *    取得的」口径记录。
 *
 * 装置边界（如实声明）：模型轮次对照依赖模型依从单步指令（B 依从「反复零
 * 等待」指令、A 依从「挂起等待」指令）；B 的实际轮数随模型节奏浮动，判据只
 * 锚定差值下限与 A 的上限，不锚定绝对轮数。两作业时长刻意相同（45s），
 * 排除时长差引入的偏差；两会话先后推进（先 A 后 B，对照口径是模型轮次而非
 * 墙钟），总运行时长约 3-4 分钟。轮询形态是对照装置，不是本包推荐的用法。
 *
 * 转录取证同既有探针（下标切窗、宿主侧载体；正文断言只认 tool/result 与
 * 完成消息，模型文本只作回执）。每步超时或断言不成立同会话重试一次（重试
 * 留痕）。
 *
 * ## 用法
 *
 *   node verify/probe-wait-economy.mjs --service-root <宿主服务根> \
 *     --host-subdir <宿主树目录名，如 dsh-0.2.1-rc.5> [--repo <本仓路径>] [--keep]
 *
 * `--service-root` 必填（或设 `DSAT_SERVICE_ROOT`）。探针以
 * `<serviceRoot>/patches/zai-glm.yml` 作为实例模型路由 patch——该文件由本机
 * 部署环境提供，缺失时实例在就绪等待处 FAULT（90s 超时＋stderr 尾部），请
 * 自备同位 patch 或改参。tgz 产物结束自清；证据 JSON 每次落盘保留在 `.local/`
 * （FAULT 路径的 tgz 与临时 home 都不清——fail() 会打印 home 路径，重跑前可
 * 手动清理）。退出码：0＝全部判定通过；1＝存在 FAIL 判定；2＝探针自身故障
 * （FAULT）。
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
const repo = resolve(argOf('repo') ?? process.cwd());
let home = null;
let evidence = null;
const fail = (msg) => {
  console.error(`[probe] FAULT: ${msg}\n[probe] 临时目录：${home ?? '（尚未创建）'}${keep ? '（--keep 保留）' : '（探针故障路径，请手动清理）'}`);
  try {
    if (evidence !== null) {
      mkdirSync(join(repo, '.local'), { recursive: true });
      writeFileSync(join(repo, '.local', 'probe-wait-economy.json'), JSON.stringify({ ...evidence, fault: String(msg) }, null, 2));
      console.error('[probe] 已尽力落盘部分证据（本机材料目录）');
    }
  } catch { /* 故障路径的落盘失败不再掩盖原故障 */ }
  process.exit(2);
};
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

// 2) 独立 DSH_HOME（系统临时目录）＋ 官方 CLI 安装。
home = mkdtempSync(join(tmpdir(), 'dsh-wait-eco-'));
const cliBin = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const addRun = spawnSync('node', [cliBin, 'plugin', '--profile', 'web', 'add', tgzPath], {
  cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 300_000
});
if (addRun.status !== 0) fail(`plugin add 退出 ${String(addRun.status)}：stderr 尾部 ${String(addRun.stderr).slice(-600)}／stdout 尾部 ${String(addRun.stdout).slice(-600)}`);
log('plugin add 完成');

// 3) 起隔离实例（随机端口）。
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

// 4) RPC 骨架。
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

// 5) 转录取证提取器。
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
  // 'model/message' 为旧宿主事件名析取（rc.5 宿主只有 assistant/message，
  // 死析取无害——沿姊妹探针同款写法保持两探针口径一致）。
  return stepRecords(transcript, fromIndex)
    .filter((r) => r.event?.type === 'assistant/message' || r.event?.type === 'model/message')
    .map((r) => (r.event.data?.message?.content ?? r.event.data?.content ?? [])
      .map((c) => String(c.text ?? '')).join('\n'));
}
/** 模型轮次：assistant/message 事件数（每轮一次模型请求→一条模型消息）。 */
function modelTurnCount(transcript, fromIndex = 0) {
  return stepRecords(transcript, fromIndex)
    .filter((r) => r.event?.type === 'assistant/message' || r.event?.type === 'model/message')
    .length;
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
/** 按名计数工具调用（判据锚定「反复 async_wait」的次数形态）。 */
function toolCallCounts(transcript, fromIndex = 0) {
  const counts = new Map();
  for (const r of stepRecords(transcript, fromIndex)) {
    if (r.event?.type !== 'tool/call') continue;
    const name = r.event.data?.name ?? r.event.data?.toolName ?? r.event.data?.message?.name;
    if (typeof name === 'string') counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}
function completionSends(transcript, fromIndex = 0) {
  const out = [];
  for (const r of stepRecords(transcript, fromIndex)) {
    if (r.event?.type !== 'user/message') continue;
    const message = r.event.data?.message ?? r.event.data;
    if (message?.source?.kind !== 'async-tools-job-result') continue;
    out.push((message.content ?? []).map((c) => String(c.text ?? '')).join('\n'));
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
  for (let attempt = 1; attempt <= 2; attempt += 1) {
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
        modelTurns: modelTurnCount(transcript, beforeCount),
        toolResults: toolResultTexts(transcript, beforeCount),
        toolNames: toolCallNames(transcript, beforeCount),
        toolCounts: toolCallCounts(transcript, beforeCount),
        completions: completionSends(transcript, beforeCount),
        baselineDegraded
      };
      const outcome = step.judge(ctx);
      if (outcome.ok === true) {
        record.attempts.push({ attempt, ok: true, detail: outcome.detail, modelTurns: ctx.modelTurns, baselineDegraded });
        judge(step.name, true, outcome.detail);
        return true;
      }
      lastDetail = outcome.detail ?? lastDetail;
      record.snapshot = {
        toolNames: [...ctx.toolNames],
        modelTurns: ctx.modelTurns,
        toolResults: ctx.toolResults.slice(-8).map((t) => t.slice(-400)),
        completions: ctx.completions.slice(-4).map((t) => t.slice(-250)),
        modelTail: ctx.modelTexts.slice(-4).map((t) => t.slice(-200)),
        baselineDegraded
      };
    }
    record.attempts.push({ attempt, ok: false, detail: lastDetail });
    log(`步骤 ${step.name} 第 ${String(attempt)} 次未成立（${lastDetail}）${attempt === 1 ? '，重试一次' : ''}`);
  }
  judge(step.name, false, `两次尝试未成立；最后状态：${String(evidence.steps.at(-1).attempts.at(-1).detail)}`);
  return false;
}
/** 会话自某步起的累计模型轮次（对照计量用——从两形态共同起点起算）。 */
async function turnsSince(sessionId, fromIndex) {
  const t = await transcriptOf(sessionId);
  return modelTurnCount(t, fromIndex);
}

// 7) 两会话并行装置。
console.log(`\n── 等待经济性对照（当前候选 ${head}${dirty}）──`);
const sA = await rpcOk('session/create', { request: { cwd: home, agentPreset: 'dsh-async' } });
const sB = await rpcOk('session/create', { request: { cwd: home, agentPreset: 'dsh-async' } });
if (sA.agentPreset !== 'dsh-async' || sB.agentPreset !== 'dsh-async') { killChild(); fail(`预设回落：A=${String(sA.agentPreset)} B=${String(sB.agentPreset)}`); }
evidence.sessions.A = sA.sessionId;
evidence.sessions.B = sB.sessionId;
log(`会话 A（等待式）=${sA.sessionId}／会话 B（轮询式）=${sB.sessionId}`);

// EC-A 步骤 1：等待式启动＋挂起（作业 45s；预算 150s——挂到完成）。
// 串行装置：A 完成后再推进 B（对照口径是模型轮次而非墙钟，见头注）。
await driveStep(sA.sessionId, {
  name: 'EC-A 等待式启动并挂起',
  prompt: 'Run this single step: call async_run with command "Start-Sleep -Seconds 45; Write-Output EC-A-TOKEN-9e1", description "economy wait-mode job", yield_ms 20000 — it goes to background. Then immediately call async_wait with wait_ms 150000 on that job and wait inside it until the job result arrives. When it returns, reply with exactly EC_A_DONE. No other tools, no questions.',
  timeoutMs: 420_000,
  judge: (ctx) => {
    const runUsed = ctx.toolNames.has('async_run');
    const waitUsed = ctx.toolNames.has('async_wait');
    // 正文锚：作业结算时结果正文直接附在挂起等待的返回里——模型从未挂起
    // （仅零等待一次即回执）时不得 PASS（否则「等待式」形态未被锚定，对照
    // 主张落空）。
    const claimed = ctx.toolResults.some((t) => t.includes('EC-A-TOKEN-9e1'));
    const receipt = ctx.modelTexts.some((t) => t.includes('EC_A_DONE'));
    const ok = runUsed && waitUsed && claimed && receipt;
    return { ok, detail: ok ? `等待式完成（正文经挂起等待返回到达，async_run＋async_wait 在场，模型轮次 ${String(ctx.modelTurns)}）` : `async_run 在场 ${String(runUsed)}／async_wait 在场 ${String(waitUsed)}／正文 ${String(claimed)}／回执 ${String(receipt)}` };
  }
});
const baselineA = (await transcriptOf(sA.sessionId)).records?.length ?? 0;
evidence.phases.baselineA = baselineA;

// EC-B 步骤 1：轮询式启动＋反复零等待（作业同样 45s）。
await driveStep(sB.sessionId, {
  name: 'EC-B 轮询式启动并反复零等待检查',
  prompt: 'Run this single step: call async_run with command "Start-Sleep -Seconds 45; Write-Output EC-B-TOKEN-6c3", description "economy poll-mode job", yield_ms 20000 — it goes to background. Then repeatedly call async_wait with wait_ms 0 on that job (immediate check, no waiting) over and over until the job result text EC-B-TOKEN-6c3 arrives in a tool result. Then reply with exactly EC_B_DONE. This polling loop is the requested experiment. No other tools, no questions.',
  timeoutMs: 420_000,
  judge: (ctx) => {
    const runUsed = ctx.toolNames.has('async_run');
    const waitUsed = ctx.toolNames.has('async_wait');
    // 「反复零等待」的次数形态：async_wait 调用 ≥2 次才构成轮询（一次挂起
    // 或一次零等待都不算）；调用次数落 attempts 留痕。
    const waitCount = ctx.toolCounts.get('async_wait') ?? 0;
    const polled = waitCount >= 2;
    const claimed = ctx.toolResults.some((t) => t.includes('EC-B-TOKEN-6c3'));
    const receipt = ctx.modelTexts.some((t) => t.includes('EC_B_DONE'));
    const ok = runUsed && waitUsed && polled && claimed && receipt;
    return { ok, detail: ok ? `轮询式完成（正文经 ${String(waitCount)} 次零等待检查到达，模型轮次 ${String(ctx.modelTurns)}）` : `async_run 在场 ${String(runUsed)}／async_wait 在场 ${String(waitUsed)}（${String(waitCount)} 次）／正文 ${String(claimed)}／回执 ${String(receipt)}` };
  }
});
const baselineB = (await transcriptOf(sB.sessionId)).records?.length ?? 0;
evidence.phases.baselineB = baselineB;

// EC-C 对照判定：B 轮次显著多于 A；usage 旁证落证据。
// 轮次口径：两会话自创建起（fromIndex=0）的全部 assistant/message——两形态
// 从同一起点（空会话）累计，公平对照。
const turnsA = await turnsSince(sA.sessionId, 0);
const turnsB = await turnsSince(sB.sessionId, 0);
evidence.phases.turnsA = turnsA;
evidence.phases.turnsB = turnsB;
const listing = await rpcOk('session/list', { _request: {} });
const rowA = listing.items.find((i) => i.sessionId === sA.sessionId);
const rowB = listing.items.find((i) => i.sessionId === sB.sessionId);
// usage 读取路径：session/list 行的 usage 聚合在 projections.values.tokenUsage
// （uncachedInput/output/cacheRead/cacheWrite），pressureTokens/projectedTokens
// 在 projections.values.contextPressure 下（宿主 SessionSummary schema——顶层
// 无 usage 字段）。供应商未报告时字段缺席，按「可取得的」口径记录。
const valuesOf = (row) => row?.projections?.values ?? null;
evidence.phases.usageA = valuesOf(rowA)?.tokenUsage ?? null;
evidence.phases.usageB = valuesOf(rowB)?.tokenUsage ?? null;
evidence.phases.pressureA = valuesOf(rowA)?.contextPressure ?? null;
evidence.phases.pressureB = valuesOf(rowB)?.contextPressure ?? null;
const diff = turnsB - turnsA;
const bOutPollsA = diff >= 2;
const aLean = turnsA <= 3;
judge('EC-C 等待式模型轮次显著少于轮询式', bOutPollsA && aLean,
  `A（等待式）=${String(turnsA)} 轮／B（轮询式）=${String(turnsB)} 轮／差值 ${String(diff)}（判据：差值≥2 且 A≤3）；usage 旁证 A=${JSON.stringify(evidence.phases.usageA ?? '（供应商未报告）')} B=${JSON.stringify(evidence.phases.usageB ?? '（供应商未报告）')}（按在场记录）`);

// 8) 收尾。
function finishRun() {
  try { rmSync(tgzPath, { force: true }); } catch { /* 产物清理尽力而为 */ }
  mkdirSync(join(repo, '.local'), { recursive: true });
  writeFileSync(join(repo, '.local', 'probe-wait-economy.json'), JSON.stringify(evidence, null, 2));
  const failures = verdicts.filter((v) => v.ok !== true).length;
  console.log(failures === 0 ? `\n判定：全部通过（${String(verdicts.length)} 项）` : `\n判定：${String(failures)} 项 FAIL（共 ${String(verdicts.length)} 项）`);
  process.exit(failures === 0 ? 0 : 1);
}
killChild();
await new Promise((r) => { setTimeout(r, 1500); });
if (keep) {
  log(`--keep：保留临时 home 供排查：${home}`);
} else {
  try { rmSync(home, { recursive: true, force: true }); log(`已清理临时 home：${home}`); }
  catch { console.error(`[probe] WARN: 临时目录清理失败，留存现场：${home}`); }
}
log(`证据落盘：${join('.local', 'probe-wait-economy.json')}（本机材料目录）`);
finishRun();
