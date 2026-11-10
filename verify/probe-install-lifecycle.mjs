/**
 * 装卸生命周期真机探针（VERIFY-01：需求 8.2「安装卸载」行的实例层装置——
 * 干净装载、声明退役与活动引用、owner 作业生命周期；对应设计 §7.1／§7.2）。
 *
 * ## 探针在证什么
 *
 * 套件层与预设校验器已锚定行卸载的清扫语义（行卸载按行清扫、账本整体释放
 * 在末行）；本探针在真实实例上取证三组可脚本化判据，正文断言只认宿主侧载体
 * （tool/result 文本、转录事件），模型文本只作回执：
 *
 * 1. IL-1 干净装载可用：plugin add 后新会话以 agentPreset='dsh-async' 创建，
 *    前台命令正文经 async_run 到达；
 * 2. IL-2 进程内 owner 作业生命周期（运行中卸载不取消已启动工作，设计 §7.1
 *    「只卸载工具行不取消已启动工作」）：长作业（约 75s）转后台后执行
 *    pnpm remove（经官方 CLI plugin remove 转发）——运行中实例里该作业照常
 *    结算（job/settled(completed) 在案）、本包完成消息照投（保活链随内存中
 *    插件仍在；JOB_RESULT_SOURCE 含作业正文）、老会话继续可用（job_list 调
 *    用在场）；
 * 3. IL-3 重启后声明退役（设计 §7.1「预设声明移除即退出新会话花名册」）：
 *    停实例→重启（同 DSH_HOME）——新会话显式 agentPreset='dsh-async' 被拒
 *    （可读错误，不静默回落）；无指定预设的会话落在宿主默认（记录落点；响应
 *    省略字段时按落点未知判 FAIL——落点未被实证）；卸载前的老会话仍在
 *    session 名册（记录；对其继续发指令的宿主形态如实记录——「已绑定
 *    Agent 持有 generation 引用」在重启后的宿主行为是实测对象，不作预设立
 *    场）。
 *
 * 装置边界（如实声明）：作业是宿主进程内工作，停实例即终止——「卸载后宿主
 * 完成通知照发（含原生读取工具引导句）」的 §7.2 形态在本装置不可达（需要卸
 * 载重启后仍有本包遗留作业在跑，作业随进程死），该形态由套件层「抑制失败与
 * 外来作业的宿主完成通知」用例按已知残留清点承担；本探针不重复该部分。IL-2
 * 主步存在窗口竞态边界：武装步模型周转＋基线拉取＋remove（timeout 300s）合
 * 计若超过作业剩余运行时间（约 75s），结算与完成消息落在主步基线之前，主步
 * 必 FAIL——属装置形态（证据含 remove 耗时可事后归因），不是产品缺陷；两轮
 * 实测未触发（周转合计远小于作业时长）。pnpm remove 在运行中实例的 profile
 * 上执行，Windows 文件锁若使 remove 失败，按环境形态记录（FAIL 判定注明原
 * 因），不视为产品缺陷。
 *
 * 转录取证同既有探针（下标切窗、宿主侧载体）；本探针无时长类判据，at 双形
 * 态与墙钟回退机制不适用。每步超时
 * 或断言不成立同会话重试一次（模型偶发不执行单步指令不等于产品缺陷，重试
 * 留痕）；**重试承诺不适用于单次投递事件形态的步骤**——结算事件与完成消息
 * 只发生一次，重试的窗口基线会切走已发生的事件而必不成立，此类步骤以
 * maxAttempts:1 声明单尝试（当前仅 IL-2 主步）。
 *
 * ## 用法
 *
 *   node verify/probe-install-lifecycle.mjs --service-root <宿主服务根> \
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
      writeFileSync(join(repo, '.local', 'probe-install-lifecycle.json'), JSON.stringify({ ...evidence, fault: String(msg) }, null, 2));
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
home = mkdtempSync(join(tmpdir(), 'dsh-inst-lc-'));
const cliBin = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const addRun = spawnSync('node', [cliBin, 'plugin', '--profile', 'web', 'add', tgzPath], {
  cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 300_000
});
if (addRun.status !== 0) fail(`plugin add 退出 ${String(addRun.status)}：stderr 尾部 ${String(addRun.stderr).slice(-600)}／stdout 尾部 ${String(addRun.stdout).slice(-600)}`);
log('plugin add 完成');

// 3) 起隔离实例（随机端口）；B 组要重启，spawn 封装成可重入。
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
async function startInstance() {
  stdout = '';
  stderrTail = '';
  child = spawn('node', [cliBin, '--patch', join(serviceRoot, 'patches', 'zai-glm.yml'), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: serviceRoot,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-4000); });
  const url = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => rejectUrl(new Error('实例 90s 内未就绪')), 90_000);
    const poll = setInterval(() => {
      const m = stdout.match(/https?:\/\/\S+/);
      if (m !== null) { clearTimeout(timer); clearInterval(poll); resolveUrl(m[0]); }
      if (child.exitCode !== null) { clearTimeout(timer); clearInterval(poll); rejectUrl(new Error(`实例提前退出 ${String(child.exitCode)}`)); }
    }, 200);
  }).catch((error) => { killChild(); fail(`${String(error.message)}\nstderr 尾部：\n${stderrTail}`); });
  log(`实例就绪：${url.split('?')[0]}（token 已隐去）`);
  await new Promise((r) => { setTimeout(r, 5000); });
  return url;
}
const url1 = await startInstance();

// 4) RPC 骨架（token→cookie；fetch 带超时，连接被关闭时重试一次）。
const urlMatch = url1.match(/^(https?:\/\/[^/?#]+)\/?\?token=(.+)$/);
if (urlMatch === null) { killChild(); fail(`实例 URL 形态不符：${url1.split('?')[0]}`); }
let [, ORIGIN, TOKEN] = urlMatch;
const indexResponse = await fetch(`${ORIGIN}/?token=${TOKEN}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
let COOKIE = (indexResponse.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
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
    // 保留首次失败原因（FAULT 诊断）；重试一次——注意非幂等端点（session/
    // prompt）在首请求已达服务端而响应丢失时可能重复排队同文指令，本探针
    // 每步指令带固定 token、重复排队不产生假 PASS（判定窗按事件切）。
    log(`rpc ${endpoint} 首次请求失败，重试一次：${String(connError?.message ?? connError)}`);
    response = await fetch(`${ORIGIN}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body,
      signal: AbortSignal.timeout(60_000)
    });
  }
  const parsed = JSON.parse(await response.text());
  // error 形态是断言对象（IL-3）：带错误返回，不抛出。
  if (parsed?.result?.ok !== true) return { ok: false, error: parsed?.result?.error ?? null };
  return { ok: true, value: parsed.result.value };
}
async function rpcOk(endpoint, argsBody) {
  const r = await rpc(endpoint, argsBody);
  if (r.ok !== true) fail(`${endpoint} 调用失败：${JSON.stringify(r.error).slice(0, 200)}`);
  return r.value;
}
// 重启后 --port 0 会换端口：rebind 用新 URL 重做 token→cookie 并重绑三个变量。
async function rebind(urlNext) {
  const m = urlNext.match(/^(https?:\/\/[^/?#]+)\/?\?token=(.+)$/);
  if (m === null) fail(`重启后 URL 形态不符：${urlNext.split('?')[0]}`);
  const [, originNext, tokenNext] = m;
  const res = await fetch(`${originNext}/?token=${tokenNext}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const cookieNext = (res.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
  if (cookieNext.length === 0) fail('重启后 token exchange 无 cookie');
  ORIGIN = originNext;
  TOKEN = tokenNext;
  COOKIE = cookieNext;
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
const settledEvents = (transcript, fromIndex = 0) => stepRecords(transcript, fromIndex)
  .filter((r) => r.event?.type === 'job/settled')
  .map((r) => ({ jobId: String(r.event.data?.jobId ?? ''), status: r.event.data?.status ?? '?' }));
/** 本步窗口内的作业 id（job/registered 事件为主源——与 jobKind 命名解耦、
 *  宿主注册时无条件发；工具返回文本回退仍锚定默认 async-command 前缀，仅作
 *  补充）；结算断言按身份过滤。 */
function stepJobIds(transcript, fromIndex) {
  const ids = new Set([...toolResultTexts(transcript, fromIndex).join('\n').matchAll(/async-command-[0-9a-f]+/g)].map((m) => m[0]));
  for (const r of stepRecords(transcript, fromIndex)) {
    if (r.event?.type !== 'job/registered') continue;
    const id = r.event.data?.jobId;
    if (typeof id === 'string' && id !== '') ids.add(id);
  }
  return ids;
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
      const stepIds = stepJobIds(transcript, beforeCount);
      const ctx = {
        modelTexts: modelTexts(transcript, beforeCount),
        toolResults: toolResultTexts(transcript, beforeCount),
        toolNames: toolCallNames(transcript, beforeCount),
        completions: completionSends(transcript, beforeCount),
        settled: settledEvents(transcript, beforeCount)
          .filter((e) => stepIds.has(e.jobId))
          .map((e) => e.status),
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
        completions: ctx.completions.slice(-4).map((t) => t.slice(-250)),
        modelTail: ctx.modelTexts.slice(-4).map((t) => t.slice(-200)),
        settled: ctx.settled,
        baselineDegraded
      };
    }
    record.attempts.push({ attempt, ok: false, detail: lastDetail });
    log(`步骤 ${step.name} 第 ${String(attempt)} 次未成立（${lastDetail}）${attempt < maxAttempts ? '，重试一次' : ''}`);
  }
  judge(step.name, false, `${String(maxAttempts)} 次尝试未成立；最后状态：${String(evidence.steps.at(-1).attempts.at(-1).detail)}`);
  return false;
}

// ── IL-1 干净装载可用（新会话 dsh-async＋前台命令正文）──
console.log(`\n── IL-1 干净装载可用（当前候选 ${head}${dirty}）──`);
// 装载前置失败属 IL-1 的判据目标（产品缺陷方向），记判定 FAIL 并收尾退出 1，
// 不归入探针自身故障（FAULT=2）。
const created1 = await rpc('session/create', { request: { cwd: home, agentPreset: 'dsh-async' } });
if (created1.ok !== true || created1.value?.agentPreset !== 'dsh-async') {
  judge('IL-1 装载后前台命令正文到达', false,
    `装载前置失败：${created1.ok ? `agentPreset 回落 ${String(created1.value?.agentPreset)}` : JSON.stringify(created1.error).slice(0, 160)}`);
  await shutdownAndFinish();
}
const s1 = created1.value;
evidence.sessions.main = s1.sessionId;
log(`会话 A 已建（sessionId=${s1.sessionId}）`);
await driveStep(s1.sessionId, {
  name: 'IL-1 装载后前台命令正文到达',
  prompt: 'Run this single step and reply with exactly the token IL1_DONE: call async_run with command "Write-Output IL1-TOKEN-7d2", description "il1 check". Then reply IL1_DONE. No other tools, no questions.',
  judge: (ctx) => {
    const runUsed = ctx.toolNames.has('async_run');
    const claimed = ctx.toolResults.some((t) => t.includes('IL1-TOKEN-7d2'));
    const receipt = ctx.modelTexts.some((t) => t.includes('IL1_DONE'));
    const ok = claimed && runUsed && receipt;
    return { ok, detail: ok ? 'async_run 在场＋前台正文含固定 token 且模型回执' : `正文 ${String(claimed)}／async_run 在场 ${String(runUsed)}／回执 ${String(receipt)}` };
  }
});

// ── IL-2 进程内 owner 作业生命周期（运行中 pnpm remove，作业照常结算投递）──
console.log('\n── IL-2 运行中卸载不取消已启动工作（约 75s 作业）──');
await driveStep(s1.sessionId, {
  name: 'IL-2 长作业转后台',
  prompt: 'Run this single step and reply with exactly the token IL2_ARMED: call async_run with command "Start-Sleep -Seconds 75; Write-Output IL2-TOKEN-4b8", description "il2 long job", yield_ms 20000 — it goes to background. Then reply IL2_ARMED. No other tools, no questions.',
  judge: (ctx) => {
    const runUsed = ctx.toolNames.has('async_run');
    // 注册锚：转后台返回文本含 async-command- id——作业真正启动的证据，模型
    // 只回 token 而作业未启动时不得 PASS（否则主步 FAIL 会误归因为卸载取消）。
    const registered = ctx.toolResults.some((t) => /async-command-[0-9a-f]+/.test(t));
    const receipt = ctx.modelTexts.some((t) => t.includes('IL2_ARMED'));
    const ok = runUsed && registered && receipt;
    return { ok, detail: ok ? '长作业已转后台（async_run 在场＋作业 id 注册锚＋模型回执武装）' : `async_run 在场 ${String(runUsed)}／作业 id 注册锚 ${String(registered)}／回执 ${String(receipt)}` };
  }
});
// 步骤一未成立时（两次尝试），主步判据不可归因——remove 照常执行以取证 B
// 组；主步不执行（作业未启动时等待必超时），按归因受限单独记录、不并入
// 「卸载取消工作」结论。
const armedStep = evidence.steps.find((s) => s.name === 'IL-2 长作业转后台');
const armedOk = armedStep?.attempts.some((a) => a.ok === true) === true;
// 记录基线（remove 前的记录条数），remove 后在该基线上观察结算与投递；拉取
// 偶发失败降级记录 null（此值仅作证据，不作步骤窗口基线）。
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
if (removeRun.status !== 0) {
  judge('IL-2 运行中卸载不取消已启动工作', false, `plugin remove 退出 ${String(removeRun.status)}（环境形态：${String(removeRun.stderr).slice(-200) || String(removeRun.stdout).slice(-200)}）——B 组照常执行以取证重启后形态`);
} else if (!armedOk) {
  judge('IL-2 运行中卸载不取消已启动工作', false, '武装步未成立（作业可能未启动）——主步判据不可归因，不并入「卸载取消工作」结论');
} else {
  // remove 成功：运行中实例里作业照常结算＋完成消息照投＋老会话继续可用。
  // 作业从启动到结算约 75s＋周转；此处等待结算事件与投递到达。
  // 本步单尝试：结算与完成消息是单次投递事件，重试的窗口基线会切走已发生
  // 的事件、必不成立（重试承诺不适用于单次投递形态，见头注）。
  await driveStep(s1.sessionId, {
    name: 'IL-2 运行中卸载不取消已启动工作',
    maxAttempts: 1,
    prompt: 'The long job from before is still running in the background. Do NOT call any tool yet. When its completion message reaches you, call job_list once to confirm the roster is readable, then reply with exactly IL2_DONE and end your turn. No other tools, no questions.',
    timeoutMs: 420_000,
    judge: (ctx) => {
      const settled = ctx.settled.includes('completed');
      const delivered = ctx.completions.some((t) => t.includes('IL2-TOKEN-4b8'));
      const roster = ctx.toolNames.has('job_list');
      const receipt = ctx.modelTexts.some((t) => t.includes('IL2_DONE'));
      const ok = settled && delivered && roster && receipt;
      return { ok, detail: ok ? 'job/settled(completed) 在案＋完成消息含作业正文（保活链仍在）＋job_list 调用在场' : `结算 completed ${String(settled)}（${ctx.settled.join(',') || '无'}）／完成消息 ${String(delivered)}／job_list 调用在场 ${String(roster)}／回执 ${String(receipt)}` };
    }
  });
}

// ── IL-3 重启后声明退役（新会话被拒＋默认落点＋老会话在场）──
console.log('\n── IL-3 重启后声明退役与活动引用 ──');
killChild();
await new Promise((r) => { setTimeout(r, 2500); });
const url2 = await startInstance();
await rebind(url2);
const createdRetired = await rpc('session/create', { request: { cwd: home, agentPreset: 'dsh-async' } });
evidence.phases.createRetired = createdRetired.ok ? { ok: true, agentPreset: createdRetired.value?.agentPreset ?? '?' } : { ok: false, error: createdRetired.error };
// 锚定错误形态：agent-preset/not-found 表示声明已退出花名册（available 名单指
// 引）；其他错误码（如 invalid＝声明在但损坏）语义不同，不算退役实证。
const retiredRejected = createdRetired.ok !== true
  && String(createdRetired.error?.code ?? '').includes('agent-preset/not-found');
judge('IL-3a 新会话显式 dsh-async 被拒（声明退役，形态锚定 not-found）', retiredRejected,
  retiredRejected ? `可读错误（不静默回落）：${JSON.stringify(createdRetired.error).slice(0, 160)}` : `错误形态未锚定 not-found：${createdRetired.ok ? `create 成功且预设=${String(createdRetired.value?.agentPreset)}` : JSON.stringify(createdRetired.error).slice(0, 160)}——声明未退出花名册或形态漂移`);
const createdDefault = await rpc('session/create', { request: { cwd: home } });
if (createdDefault.ok !== true) {
  judge('IL-3b 无指定预设落在宿主可用默认', false, `create 失败：${JSON.stringify(createdDefault.error).slice(0, 160)}`);
} else {
  const preset = String(createdDefault.value?.agentPreset ?? '?');
  evidence.phases.createDefault = { agentPreset: preset };
  judge('IL-3b 无指定预设落在宿主可用默认', preset !== '' && preset !== 'dsh-async' && preset !== '?', `落点预设=${preset}（记录；'?'＝响应省略字段、落点未知；不等于对本包的建议）`);
}
const listing = await rpcOk('session/list', { _request: {} });
const oldRow = listing.items.find((item) => item.sessionId === s1.sessionId);
evidence.phases.oldSessionAfterRestart = oldRow === undefined ? null : { sessionId: s1.sessionId };
judge('IL-3c 卸载前老会话仍在名册', oldRow !== undefined, oldRow !== undefined ? `老会话 ${s1.sessionId.slice(0, 14)}… 在 session/list` : '老会话不在名册');
if (oldRow !== undefined) {
  // 老会话继续发指令的宿主形态如实记录（generation 引用重启后的行为是实测对象）。
  const promptOutcome = await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: s1.sessionId, mode: 'queue',
      content: [{ type: 'text', text: 'Reply with exactly IL3_OLD_DONE.' }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
  evidence.phases.oldSessionPrompt = promptOutcome.ok ? { ok: true } : { ok: false, error: promptOutcome.error };
  if (promptOutcome.ok === true) {
    const deadline = Date.now() + 180_000;
    let oldReceipt = false;
    while (Date.now() < deadline && !oldReceipt) {
      await new Promise((r) => { setTimeout(r, POLL_MS); });
      try {
        const t = await transcriptOf(s1.sessionId);
        oldReceipt = modelTexts(t).some((m) => m.includes('IL3_OLD_DONE'));
      } catch { /* 继续轮询 */ }
    }
    log(`老会话重启后 prompt 回执：${String(oldReceipt)}（generation 引用形态记录在证据）`);
    evidence.phases.oldSessionReceipt = oldReceipt;
  } else {
    log(`老会话重启后 prompt 被拒（generation 引用形态）：${JSON.stringify(promptOutcome.error).slice(0, 160)}`);
  }
  // 老会话形态不作 PASS/FAIL 断言（宿主行为是记录对象，两种形态都如实入证据）。
}

// 7) 收尾：停实例→留证据→清理（--keep 时保留临时 home 供排查）。
// 抽成函数：装载前置失败等中途判定失败也走同一收尾（退出码 1＝存在 FAIL）。
function finishRun() {
  try { rmSync(tgzPath, { force: true }); } catch { /* 产物清理尽力而为 */ }
  mkdirSync(join(repo, '.local'), { recursive: true });
  writeFileSync(join(repo, '.local', 'probe-install-lifecycle.json'), JSON.stringify(evidence, null, 2));
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
  log(`证据落盘：${join('.local', 'probe-install-lifecycle.json')}（本机材料目录）`);
  finishRun();
}
await shutdownAndFinish();
