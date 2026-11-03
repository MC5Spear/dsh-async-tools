/**
 * 等待语义真机探针（VERIFY-01：需求 8.2「目标判断／共用等待／等待必要性」
 * 的实例层装置）。
 *
 * ## 探针在证什么
 *
 * 套件层（wait-delivery 等 744 用例）已锚定各出口逻辑；本探针在真实实例上
 * 以真实模型会话取证六个可脚本化判据，每条判据只认宿主侧载体（tool/result
 * 文本、转录事件与时间戳），模型文本只作回执：
 *
 * 1. WS-1 查无目标可读拒绝：async_wait 指向不存在的作业 id，返回错误文案
 *    （error.unknownJob：未知作业＋job_list 指引），不静默、不当作已结束；
 *    紧接 wait_ms=0 无目标立即检查（不挂起、无假挂起报错，两次调用都在场）；
 * 2. WS-2 目标终态提前交回：后台作业（约 30s）＋async_wait 指定该目标、
 *    预算 180s——等待在作业完成时刻附近交回（时间戳判据），不等满预算；
 * 3. WS-3 非目标不误报：作业 A（约 20s）与 B（约 65s）先后转后台，等待只指定
 *    B、预算 180s——B 正文在等待返回中到达、挂起时长贴 B 的剩余窗口。装置
 *    边界：模型串行启动两作业（各自前台等满 20s），A 在等待开始前已完成，
 *    时序上不可能唤醒等待——本步主要证据是「B 正文到达＋时长窗口」，
 *    不是 A 与 B 的竞态对照；
 * 4. WS-4 用户插话打断等待：后台长作业＋等待挂起后经 steer 通道注入用户
 *    消息——等待以被打断形态交回（返回时刻远早于作业完成与预算），插话
 *    消息进入模型上下文（agent/inbox/spliced 在案），后台作业不被终止；
 * 5. WS-5 排队消息不唤醒等待：长作业（约 150s，恒晚于预算到期）＋预算 60s，
 *    等待挂起后经 queue 通道注入消息（设计语义：排队消息只在回合边界送达，
 *    不结束等待）——等待挂满 60s 预算经到期出口返回（返回注明目标仍在
 *    运行），作业正文不在等待返回中（尚未结算、无 job/settled），作业不被
 *    终止；
 * 6. WS-6 协作续接：后台子代理完成、回答到达后，主代理经 send_message 继续
 *    驱动同一子代理，续接回答经宿主侧载体到达。
 *
 * 时间判据优先取转录时间戳（tool/call 与其后 tool/result 的 at 差；at 可能是
 * ISO 字符串或 epoch 毫秒数字，两种形态都解析；seq 缺席时按数组下标定位），
 * 时间戳缺席时以轮询墙钟回退（±一个轮询间隔）。每步超时或断言不成立同会话
 * 重试一次（模型偶发不执行单步指令不等于产品缺陷，重试留痕）。
 *
 * ## 用法
 *
 *   node verify/probe-wait-semantics.mjs --service-root <宿主服务根> \
 *     --host-subdir <宿主树目录名，如 dsh-0.2.1-rc.5> [--repo <本仓路径>] [--keep]
 *
 * `--service-root` 必填（或设 `DSAT_SERVICE_ROOT`）。探针以
 * `<serviceRoot>/patches/zai-glm.yml` 作为实例模型路由 patch——该文件由本机
 * 部署环境提供，缺失时实例在就绪等待处 FAULT（90s 超时＋stderr 尾部），请
 * 自备同位 patch 或改参。tgz 产物结束自清；证据 JSON 每次落盘保留在 `.local/`
 * （FAULT 路径的 tgz 不清，重跑前可手动清理）。退出码：0＝全部判定通过；
 * 1＝存在 FAIL 判定；2＝探针自身故障（FAULT）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
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
      writeFileSync(join(repo, '.local', 'probe-wait-semantics.json'), JSON.stringify({ ...evidence, fault: String(msg) }, null, 2));
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

// 1) 打包当前工作区（npm pack --ignore-scripts；产物名含「+」，产物落 .local/）。
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
home = mkdtempSync(join(tmpdir(), 'dsh-wait-sem-'));
const cliBin = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const addRun = spawnSync('node', [cliBin, 'plugin', '--profile', 'web', 'add', tgzPath], {
  cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 300_000
});
if (addRun.status !== 0) fail(`plugin add 退出 ${String(addRun.status)}：stderr 尾部 ${String(addRun.stderr).slice(-600)}／stdout 尾部 ${String(addRun.stdout).slice(-600)}`);
log('plugin add 完成');

// 3) 起隔离实例（随机端口）。
const child = spawn('node', [cliBin, '--patch', join(serviceRoot, 'patches', 'zai-glm.yml'), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  cwd: serviceRoot,
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe']
});
let stdout = '';
child.stdout.on('data', (c) => { stdout += c; });
let stderrTail = '';
child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-4000); });
// 安全网：任何未捕获异常走到进程退出时也停掉实例（同步 taskkill 在 exit 钩子里可用）。
process.on('exit', () => { killChild(); });
const url = await new Promise((resolveUrl, rejectUrl) => {
  const timer = setTimeout(() => rejectUrl(new Error('实例 90s 内未就绪')), 90_000);
  const poll = setInterval(() => {
    const m = stdout.match(/https?:\/\/\S+/);
    if (m !== null) { clearTimeout(timer); clearInterval(poll); resolveUrl(m[0]); }
    if (child.exitCode !== null) { clearTimeout(timer); clearInterval(poll); rejectUrl(new Error(`实例提前退出 ${String(child.exitCode)}`)); }
  }, 200);
}).catch((error) => { killChild(); fail(`${String(error.message)}\nstderr 尾部：\n${stderrTail}`); });
log(`实例就绪：${url.replace(/token=[^&]+/, 'token=***')}`);
await new Promise((r) => { setTimeout(r, 5000); });

// 4) RPC 骨架（token→cookie→会话；fetch 带超时，连接被关闭时重试一次）。
const urlMatch = url.match(/^(https?:\/\/[^/?#]+)\/?\?token=(.+)$/);
if (urlMatch === null) { killChild(); fail(`实例 URL 形态不符：${url.split('?')[0]}`); }
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
    response = await fetch(`${ORIGIN}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body,
      signal: AbortSignal.timeout(60_000)
    });
    void connError;
  }
  const text = await response.text();
  const parsed = JSON.parse(text);
  if (parsed?.result?.ok !== true) throw new Error(`${endpoint}: ${JSON.stringify(parsed?.result?.error ?? '').slice(0, 200)}`);
  return parsed.result.value;
}
const created = await rpc('session/create', { request: { cwd: home, agentPreset: 'dsh-async' } });
if (created.agentPreset !== 'dsh-async') { killChild(); fail(`agentPreset 回落：${String(created.agentPreset)}`); }
const SESSION = created.sessionId;
log(`会话已建（sessionId=${SESSION}）`);
async function prompt(text, mode = 'queue') {
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: SESSION, mode,
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
}
async function transcriptOf() {
  const listing = await rpc('session/list', { _request: {} });
  const row = listing.items.find((item) => item.sessionId === SESSION);
  if (row === undefined) throw new Error('session not found');
  return rpc('session/page', {
    request: { address: { kind: 'session', sessionId: SESSION }, throughSeq: row.projections.asOfSeq, maxMessages: 1200 }
  });
}
function atOf(record) {
  const raw = record.at ?? record.event?.at ?? null;
  if (raw === null) return null;
  // at 可能是 ISO 字符串，也可能是 epoch 毫秒数字（或数字串）——两种都收。
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(numeric) && numeric > 1e12) return numeric;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}
/** 载体提取器统一带 fromIndex：转录 append-only、seq 可能缺席，按数组下标
 *  切出「本步新增」窗口——跨步陈旧记录不进断言（早先尝试的误调用不污染
 *  后续步骤的 notKilled 等判定）。 */
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
/** 本步窗口内各工具的调用次数（如 WS-1 断言两次 async_wait 调用都在场）。 */
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
/** async_wait 挂起时长与其返回文本：records 的 seq 在本宿主线上可能缺席，
 *  统一以数组下标（转录 append-only 且总记录量不超过拉取上限，下标稳定）取
 *  「fromIndex 之后」的最后一个 tool/call(name=async_wait) 与其后第一个
 *  tool/result——**装置假设模型按指令串行单工具调用**（各步指令均要求），
 *  违规并行时配对可能失准，误差方向是假 FAIL（重试自愈）而非假 PASS。
 *  优先转录 at 时间戳，缺席时由调用侧用轮询墙钟回退（±一个轮询间隔）。 */
function waitSpanSince(transcript, fromIndex) {
  const records = (transcript.records ?? []).slice(fromIndex);
  const callIdx = [];
  records.forEach((r, i) => {
    if (r.event?.type !== 'tool/call') return;
    const name = r.event.data?.name ?? r.event.data?.toolName ?? r.event.data?.message?.name;
    if (name === 'async_wait') callIdx.push(i);
  });
  if (callIdx.length === 0) return { callSeen: false, resultSeen: false, spanMs: null, resultText: '' };
  const i = callIdx.at(-1);
  for (let j = i + 1; j < records.length; j += 1) {
    if (records[j].event?.type === 'tool/result') {
      const callAt = atOf(records[i]);
      const at = atOf(records[j]);
      const diff = callAt !== null && at !== null ? at - callAt : null;
      const content = records[j].event.data?.message?.content ?? [];
      const resultText = content.filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('\n');
      return { callSeen: true, resultSeen: true, spanMs: diff !== null && Number.isFinite(diff) ? diff : null, resultText };
    }
  }
  return { callSeen: true, resultSeen: false, spanMs: null, resultText: '' };
}
const eventHas = (transcript, type, fromIndex = 0) => stepRecords(transcript, fromIndex).some((r) => r.event?.type === type);

// 5) 步骤驱动（每步单条明确指令＋固定回执 token；首不成重试一次）。
const STEP_TIMEOUT_MS = 420_000;
const POLL_MS = 4000;
const verdicts = [];
evidence = { head, dirty: dirty !== '', hostVersion, sessionId: SESSION, steps: [], verdicts };
function judge(name, ok, detail = '') {
  verdicts.push({ name, ok: ok === true, detail: String(detail).slice(0, 400) });
  console.log(`${ok === true ? 'PASS ' : 'FAIL '} ${name}${detail === '' ? '' : `  —— ${String(detail).slice(0, 240)}`}`);
}
/** 驱动一步：发指令（可附带挂起后注入函数）→轮询至判定成立或超时；重试一次。 */
const lastBaselineShared = { value: 0 };
async function driveStep(step) {
  const record = { name: step.name, attempts: [] };
  evidence.steps.push(record);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // 步骤基线：当前记录条数（seq 可能缺席，append-only 下标即坐标）；拉取
    // 失败时沿用上一成功基线（首步按 0——回执 token 步内唯一，主要代价是
    // 多扫旧记录而非误判）。基线是跨步内部状态，不入证据 JSON。
    let beforeCount = lastBaselineShared.value;
    try {
      beforeCount = (await transcriptOf()).records?.length ?? 0;
      lastBaselineShared.value = beforeCount;
    } catch { /* 沿用上一成功基线 */ }
    // 墙钟回退：首次观察到本步 async_wait 调用与其结果的时刻（±轮询间隔）。
    let wallCallAt = null;
    let wallResultAt = null;
    try {
      await prompt(step.prompt);
    } catch (error) {
      killChild();
      fail(`session/prompt 调用失败：${String(error?.message ?? error)}`);
    }
    // 步骤专属动作：等待挂起后注入插话（WS-4／WS-5）。
    let acted = false;
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    let lastDetail = '（无判定输出）';
    while (Date.now() < deadline) {
      await new Promise((r) => { setTimeout(r, POLL_MS); });
      if (child.exitCode !== null) { killChild(); fail('实例在步骤中途退出'); }
      let transcript;
      try { transcript = await transcriptOf(); } catch { continue; }
      const spanInfo = waitSpanSince(transcript, beforeCount);
      if (spanInfo.callSeen && wallCallAt === null) wallCallAt = Date.now();
      if (spanInfo.callSeen && spanInfo.spanMs === null && wallResultAt === null && spanInfo.resultSeen === true) wallResultAt = Date.now();
      if (!acted && step.afterWaitSuspended !== undefined && spanInfo.callSeen) {
        acted = true;
        await step.afterWaitSuspended();
        log(`步骤 ${step.name}：等待已挂起，注入动作完成。`);
      }
      const wallSpan = wallCallAt !== null && wallResultAt !== null ? wallResultAt - wallCallAt : null;
      // 本步窗口内出现的作业 id（async_run 返回与 wait 目标状态都带 id）——
      // 结算断言按身份过滤，跨步残留作业（如 WS-4 有意不杀的长作业）的结算
      // 不误伤本步判定。
      const stepText = toolResultTexts(transcript, beforeCount).join('\n');
      const stepJobIds = new Set([...stepText.matchAll(/async-command-[0-9a-f]+/g)].map((m) => m[0]));
      const settledEvents = stepRecords(transcript, beforeCount)
        .filter((r) => r.event?.type === 'job/settled')
        .map((r) => ({ jobId: String(r.event.data?.jobId ?? ''), status: r.event.data?.status ?? '?' }))
        .filter((e) => e.jobId === '' || stepJobIds.has(e.jobId));
      const ctx = {
        modelTexts: modelTexts(transcript, beforeCount),
        toolResults: toolResultTexts(transcript, beforeCount),
        toolNames: toolCallNames(transcript, beforeCount),
        toolCallCounts: toolCallCounts(transcript, beforeCount),
        completions: completionSends(transcript, beforeCount),
        injected: injectedTexts(transcript, beforeCount),
        spliced: eventHas(transcript, 'agent/inbox/spliced', beforeCount),
        settled: settledEvents.map((e) => e.status),
        settledEvents,
        waitSpan: spanInfo.spanMs ?? wallSpan,
        waitResultText: spanInfo.resultText
      };
      const outcome = step.judge(ctx);
      if (outcome.ok === true) {
        record.attempts.push({ attempt, ok: true, detail: outcome.detail });
        judge(step.name, true, outcome.detail);
        return true;
      }
      lastDetail = outcome.detail ?? lastDetail;
      // 快照持续更新为最新轮询末态（首败时刻的形态在 attempts.lastDetail 与
      // 下轮快照对比中仍可辨）。
      record.snapshot = {
        toolNames: [...ctx.toolNames],
        toolResults: ctx.toolResults.slice(-10).map((t) => t.slice(-500)),
        completions: ctx.completions.slice(-5).map((t) => t.slice(-300)),
        injected: ctx.injected.slice(-5).map((e) => ({ source: e.source, text: e.text.slice(-300) })),
        modelTail: ctx.modelTexts.slice(-5).map((t) => t.slice(-250)),
        waitSpan: ctx.waitSpan
      };
    }
    record.attempts.push({ attempt, ok: false, detail: lastDetail });
    log(`步骤 ${step.name} 第 ${String(attempt)} 次未成立（${lastDetail}）${attempt === 1 ? '，重试一次' : ''}`);
  }
  judge(step.name, false, `两次尝试未成立；最后状态：${String(evidence.steps.at(-1).attempts.at(-1).detail)}`);
  return false;
}

console.log(`\n── WS-1 查无目标可读拒绝＋零等待立即检查（当前候选 ${head}${dirty}）──`);
await driveStep({
  name: 'WS-1 未知目标报错且零等待不挂起',
  prompt: 'Run this single step and reply with exactly the token WS1_DONE: (1) call async_wait with targets [{kind:"job", id:"no-such-job-7f3a"}] and wait_ms 0 — it must return an error mentioning an unknown job and suggesting job_list, this is expected; do not retry it. (2) then call async_wait with wait_ms 0 only (no targets) — it must return immediately with a ready-list summary, no hang. (3) reply WS1_DONE. No other tools, no questions.',
  judge: (ctx) => {
    const unknownRejected = ctx.toolResults.some((t) => /unknown job|未知作业/.test(t) && /job_list/.test(t));
    // 两次 async_wait 调用都在场——模型跳过步骤 (2) 只回执不得通过。
    const bothCalled = (ctx.toolCallCounts.get('async_wait') ?? 0) >= 2;
    // 零等待立即性：最后一次调用（即 wait_ms=0）从调用到返回 <10s，不挂起。
    const zeroWaitQuick = ctx.waitSpan !== null && ctx.waitSpan < 10_000;
    const receipt = ctx.modelTexts.some((t) => t.includes('WS1_DONE'));
    const ok = unknownRejected && bothCalled && zeroWaitQuick && receipt;
    return { ok, detail: ok ? `未知作业可读拒绝（含 job_list 指引）＋两次调用在场＋零等待 ${String(Math.round(ctx.waitSpan / 1000))}s 立即返回＋回执` : `未知作业拒绝命中 ${String(unknownRejected)}／两次调用在场 ${String(bothCalled)}（${String(ctx.toolCallCounts.get('async_wait') ?? 0)} 次）／零等待立即 ${String(zeroWaitQuick)}（${ctx.waitSpan === null ? '未取得' : `${String(Math.round(ctx.waitSpan / 1000))}s`}）／回执 ${String(receipt)}` };
  }
});

console.log('\n── WS-2 目标终态提前交回（约 30s 作业，预算 180s）──');
await driveStep({
  name: 'WS-2 目标完成即交回（不等满预算）',
  prompt: 'Run this single step and reply with exactly the token WS2_DONE: (1) call async_run with command "Start-Sleep -Seconds 30; Write-Output WS2-TOKEN-4d9", description "ws2 target", yield_ms 20000 — it goes to background, note its job_id; (2) immediately call async_wait with targets [{kind:"job", id:<that job_id>}] and wait_ms 180000, waiting inline until it returns; (3) after the wait returns, reply WS2_DONE. No other tools, no questions.',
  judge: (ctx) => {
    const claimed = ctx.toolResults.some((t) => t.includes('WS2-TOKEN-4d9'));
    const span = ctx.waitSpan;
    // span 是「wait 调用起的剩余等待」——async_run 先前台等满首等下限，转后台
    // 后模型才调 wait，span 只剩作业余量＋周转；作业已就绪时立即交付（span≈0，
    // 需求 8.2 目标判断行「已就绪内容……及时交回」）也合法。提前交回的判别在
    // 上限侧：远小于 180s 预算；正文到达是主判据。
    const early = span !== null && span < 150_000;
    const ok = claimed && early && ctx.modelTexts.some((t) => t.includes('WS2_DONE'));
    return { ok, detail: ok ? `正文到达＋等待挂起 ${String(Math.round(span / 1000))}s 交回（远小于 180s 预算）` : `正文 ${String(claimed)}／挂起时长 ${span === null ? '未取得' : `${String(Math.round(span / 1000))}s`}／回执 ${String(ctx.modelTexts.some((t) => t.includes('WS2_DONE')))}` };
  }
});

console.log('\n── WS-3 非目标完成不唤醒等待（A≈20s／B≈65s，只等 B）──');
await driveStep({
  name: 'WS-3 非目标通知不提前结束等待',
  prompt: 'Run this single step and reply with exactly the token WS3_DONE: (1) call async_run twice: job A with command "Start-Sleep -Seconds 20; Write-Output WS3-A-2e7", description "ws3 job A", yield_ms 20000; job B with command "Start-Sleep -Seconds 65; Write-Output WS3-B-8c4", description "ws3 job B", yield_ms 20000 — both go to background, note both job_ids; (2) immediately call async_wait with targets [{kind:"job", id:<B job_id>}] and wait_ms 180000, waiting inline; job A is NOT a target — its completion must not end your wait early; (3) after the wait returns, reply WS3_DONE. No other tools, no questions.',
  judge: (ctx) => {
    const claimed = ctx.toolResults.some((t) => t.includes('WS3-B-8c4'));
    const span = ctx.waitSpan;
    // 期望交回贴 B 的剩余窗口（wait 起点约在 B 启动后 20s+，B 剩约 45s±周转）；
    // 装置边界见头注——A 时序上早于 wait 完成，本判据主证「B 正文＋时长窗口」。
    const nearB = span !== null && span >= 25_000 && span < 150_000;
    const ok = claimed && nearB && ctx.modelTexts.some((t) => t.includes('WS3_DONE'));
    return { ok, detail: ok ? `B 正文到达＋挂起 ${String(Math.round(span / 1000))}s（贴 B 剩余窗口）` : `B 正文 ${String(claimed)}／挂起时长 ${span === null ? '未取得' : `${String(Math.round(span / 1000))}s`}／回执 ${String(ctx.modelTexts.some((t) => t.includes('WS3_DONE')))}` };
  }
});

console.log('\n── WS-4 用户插话打断等待（steer 通道注入）──');
await driveStep({
  name: 'WS-4 插话打断等待且后台不终止',
  prompt: 'Run this single step: (1) call async_run with command "Start-Sleep -Seconds 240; Write-Output WS4-TOKEN-6b2", description "ws4 long job", yield_ms 20000 — it goes to background, note its job_id; (2) immediately call async_wait with targets [{kind:"job", id:<that job_id>}] and wait_ms 180000, waiting inline. Do not reply yet. When your wait is interrupted by an incoming user message, reply with exactly WS4_DONE and end your turn — do NOT kill or wait for the long job again. No other tools, no questions.',
  afterWaitSuspended: async () => {
    // 等待挂起后 6s 经 steer 通道注入用户消息（立即进入当前回合——打断挂起等待）。
    await new Promise((r) => { setTimeout(r, 6000); });
    await prompt('Interrupting message via steer: your wait should return now as interrupted. Reply with exactly WS4_DONE and end your turn. Do not call any tool.', 'steer');
  },
  judge: (ctx) => {
    const span = ctx.waitSpan;
    // 期望交回远早于作业 240s 与预算 180s（steer 在挂起后约 6-20s 到达）。
    const interrupted = span !== null && span < 90_000;
    const spliced = ctx.spliced;
    const receipt = ctx.modelTexts.some((t) => t.includes('WS4_DONE'));
    // 不终止的宿主侧证据：模型未调 job_kill，且本步作业无 killed 结算事件
    // （隐式连带终止也会在结算流留下 killed）。
    const notKilled = !ctx.toolNames.has('job_kill') && !ctx.settledEvents.some((e) => e.status === 'killed');
    const ok = interrupted && spliced && receipt && notKilled;
    return { ok, detail: ok ? `挂起 ${String(Math.round(span / 1000))}s 被插话交回（agent/inbox/spliced 在案、无 killed 结算）＋回执` : `早交回 ${String(interrupted)}（挂起 ${span === null ? '未取得' : `${String(Math.round(span / 1000))}s`}）／spliced ${String(spliced)}／回执 ${String(receipt)}／无 killed ${String(notKilled)}` };
  }
});

console.log('\n── WS-5 排队消息不唤醒等待（queue 通道注入，期望挂满 60s 预算经到期出口返回）──');
await driveStep({
  name: 'WS-5 排队消息不唤醒等待（预算到期出口）',
  // 作业 150s 恒晚于预算到期（wait 起点约 20s+τ、到期约 80-90s、结算约 152s）——
  // 等待只能经预算到期出口返回，目标终态出口在算术上不可达。
  prompt: 'Run this single step: (1) call async_run with command "Start-Sleep -Seconds 150; Write-Output WS5-TOKEN-3f8", description "ws5 long job", yield_ms 20000 — it goes to background, note its job_id; (2) immediately call async_wait with targets [{kind:"job", id:<that job_id>}] and wait_ms 60000, waiting inline until the budget expires and the wait returns; (3) after the wait returns, reply with exactly WS5_DONE and end your turn — do NOT kill or wait for the job again. No other tools, no questions.',
  afterWaitSuspended: async () => {
    // 等待挂起后 6s 经 queue 通道注入消息——排队消息只在回合边界送达，设计语义
    // 明确不结束等待（text.js「queue 不唤醒」）；期望等待挂满 60s 预算返回。
    await new Promise((r) => { setTimeout(r, 6000); });
    await prompt('Queued message: this must NOT interrupt your wait. Keep waiting until the budget expires.', 'queue');
  },
  judge: (ctx) => {
    const span = ctx.waitSpan;
    // 期望挂满预算（60s±周转容差）——排队消息不唤醒。
    const heldFull = span !== null && span >= 50_000 && span < 90_000;
    // 到期出口形态：只认 async_wait 自身返回（waitResultText——call→result
    // 配对所得）的到期专属文案；不扫全窗口（转后台返回也含「仍在运行」，
    // 会架空断言）。token 缺席与未结算（按本步作业身份过滤）同判。
    const expiryNote = /预算到期|budget expired/.test(ctx.waitResultText);
    const tokenAbsent = !ctx.toolResults.some((t) => t.includes('WS5-TOKEN-3f8'));
    const notSettled = ctx.settledEvents.length === 0;
    const receipt = ctx.modelTexts.some((t) => t.includes('WS5_DONE'));
    const notKilled = !ctx.toolNames.has('job_kill');
    const ok = heldFull && expiryNote && tokenAbsent && notSettled && receipt && notKilled;
    return { ok, detail: ok ? `挂起 ${String(Math.round(span / 1000))}s 挂满 60s 预算经到期出口返回（wait 返回注明预算到期、本步作业未结算未杀、token 不在返回中）＋回执` : `挂满 ${String(heldFull)}（挂起 ${span === null ? '未取得' : `${String(Math.round(span / 1000))}s`}）／到期注记 ${String(expiryNote)}／token 缺席 ${String(tokenAbsent)}／未结算 ${String(notSettled)}／回执 ${String(receipt)}／未杀作业 ${String(notKilled)}` };
  }
});

console.log('\n── WS-6 协作续接（子代理回答到达后 send_message 续接）──');
await driveStep({
  name: 'WS-6 已完成子代理经 send_message 续接',
  prompt: 'Run this single step: (1) call async_agent with description "ws6 child", prompt "Reply with exactly the single token WS6-CHILD-1a6 and nothing else." — note the agent_id it returns; (2) end your turn WITHOUT waiting. When the child answer reaches you, call send_message with that agent_id and message "Now reply with exactly the single token WS6-CHILD2-9c3 and nothing else."; then end your turn again. When the second answer reaches you, reply with exactly WS6_DONE. No other tools, no questions.',
  judge: (ctx) => {
    const firstAnswer = ctx.completions.some((t) => t.includes('WS6-CHILD-1a6'))
      || ctx.injected.some((e) => e.text.includes('WS6-CHILD-1a6'))
      || ctx.toolResults.some((t) => t.includes('WS6-CHILD-1a6'));
    const secondAnswer = ctx.completions.some((t) => t.includes('WS6-CHILD2-9c3'))
      || ctx.injected.some((e) => e.text.includes('WS6-CHILD2-9c3'))
      || ctx.toolResults.some((t) => t.includes('WS6-CHILD2-9c3'));
    const sendUsed = ctx.toolNames.has('send_message');
    const ok = firstAnswer && secondAnswer && sendUsed && ctx.modelTexts.some((t) => t.includes('WS6_DONE'));
    return { ok, detail: ok ? '两次子代理回答均经宿主侧载体到达＋send_message 在场＋回执' : `首答 ${String(firstAnswer)}／续答 ${String(secondAnswer)}／send_message ${String(sendUsed)}／回执 ${String(ctx.modelTexts.some((t) => t.includes('WS6_DONE')))}` };
  }
});

// 6) 收尾：停实例→等句柄释放→留证据→清理（--keep 时保留临时 home 供排查）。
killChild();
await new Promise((r) => { setTimeout(r, 1500); });
if (keep) {
  log(`--keep：保留临时 home 供排查：${home}`);
} else {
  try { rmSync(home, { recursive: true, force: true }); log(`已清理临时 home：${home}`); }
  catch { console.error(`[probe] WARN: 临时目录清理失败，留存现场：${home}`); }
}
try { rmSync(tgzPath, { force: true }); } catch { /* 产物清理尽力而为 */ }
mkdirSync(join(repo, '.local'), { recursive: true });
writeFileSync(join(repo, '.local', 'probe-wait-semantics.json'), JSON.stringify(evidence, null, 2));
log(`证据落盘：${join('.local', 'probe-wait-semantics.json')}（本机材料目录）`);
const failures = verdicts.filter((v) => v.ok !== true).length;
console.log(failures === 0 ? `\n判定：全部通过（${String(verdicts.length)} 项）` : `\n判定：${String(failures)} 项 FAIL（共 ${String(verdicts.length)} 项）`);
process.exit(failures === 0 ? 0 : 1);

function killChild() {
  if (child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
  }
}
