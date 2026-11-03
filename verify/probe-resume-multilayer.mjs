/**
 * 恢复会话与多层子代理真机探针（VERIFY-01：需求 8.2「实时模型选择」行的
 * 「恢复会话和多层子代理一致」面＋「插话与排队」在等待挂起之外／恢复会话／
 * 多层链上的行为面；issue-list「实时模型策略在恢复会话和多层子代理中的
 * 行为、等待挂起之外与恢复会话／多层子代理中的插话与排队」项）。
 *
 * ## 探针在证什么
 *
 * wait-semantics 已锚定等待挂起中的 steer／queue 通道（WS-4/WS-5）与单层
 * 派生（LA-4）；本探针把同域推到三个缺证形态。正文断言只认宿主侧载体
 * （tool/result 文本、转录事件、注入侧消息），模型文本只作回执：
 *
 * 1. RM-1 重启前武装：dsh-async 会话派 async_agent 短子代理——agent_id
 *    回执＋最终回答经宿主侧载体到达（会话活跃＋派生可用的基线）；
 * 2. RM-2 重启后恢复会话（resume）：停实例→重启（插件仍在 profile，与
 *    IL-3 的卸载重启对照——不卸载时 resume 应成功）→老会话继续发指令、
 *    回执到达；
 * 3. RM-3 恢复会话续派子代理：resume 后同会话再派 async_agent——agent_id
 *    回执＋最终回答到达——「恢复会话的实时模型选择一致」的行为面（派生
 *    许可与配置在恢复会话中继续生效）；
 * 4. RM-4 恢复会话中的排队消息：忙碌窗（async_run 约 20s 前台命令——工具
 *    调用在场门控）期间 queue 通道注入→回合边界领取→回执，判据含忙碌窗
 *    实锚（async_run 在场＋命令输出 token 经宿主侧载体到达——宿主下一轮
 *    语义在恢复会话不漂移）；
 * 5. RM-5 首等工具执行中的插话：主代理执行约 60s 命令（async_run
 *    yield_ms 600000——首等窗内、非等待挂起形态）期间经 steer 通道注入
 *    ——实测锚定形态：steer 结束首次等待→返回同一作业句柄（本包契约
 *    「插话只结束等待、绝不终止命令」）→命令后台续跑→正文经后续等待到
 *    达（未终止）＋插话指令被履行（唯一 token 回执；agent/inbox/spliced
 *    事件在场为旁证——该宿主对上下文注入同样产生 spliced，不单独归因）；
 * 6. RM-6 多层链与主代理层插话共存：主代理派中间子代理→中间代理再派
 *    孙代理（回固定 token）→孙代理回答经中间代理中转、中间代理最终回答
 *    经宿主侧载体到达主会话；期间主会话 steer 插话照达主代理层（唯一
 *    token 回执，spliced 旁证）——宿主 rc.5 不允许后台子代理直接请求人类
 *    交互——插话的落点是主代理层，子代理层不被打扰即「多层中的插话不
 *    漂移」。
 *
 * 装置边界（如实声明）：「实时模型选择一致」锚定行为面（恢复会话/多层
 * 子代理链的派生可用与回答投递、许可链畅通）；配置变更（新增/删除路由后
 * 派生被拒）的拒绝面不在本装置（由套件层许可链用例承担，不冒称实例层覆
 * 盖）。RM-2 的 resume 拒绝形态发生在 session/prompt RPC 层——探针用 rpc()
 * 原样捕获错误体判 FAIL（错误体入证据，不混入 FAULT）；老会话不在重启后
 * 名册同样按 FAIL 如实记录。RM-5 锚定「首等工具执行中」形态（steer 经首
 * 等打断机制处理——契约「插话只结束等待、绝不终止命令」）；纯无等待形
 * 态（如纯生成中插话）不在本装置。steer 的 spliced 事件仅作旁证——该宿
 * 主对上下文注入同样产生 agent/inbox/spliced，插话到达的主锚是唯一
 * token 回执。RM-5 时序不精确断言（只断「命令完成＋插话被履行」两宿主侧
 * 事实）。RM-6 依赖模型两跳依从（主→中间→孙），中间层失败时按 FAIL 取
 * 证（attempts 留痕区分模型未依从与投递丢失——快照含注入消息形态）。
 * 每步超时或断言不成立同会话重试一次（模型偶发不执行单步指令不等于产品
 * 缺陷，重试留痕）；RM-1/RM-3/RM-6 的重试派新子代理、新投递事件落在新
 * 窗内、RM-5 重试跑新命令同形态——同 token 边界：首试子代理/命令迟到结
 * 算时可落入重试窗满足重试判据（窗按下标切、不按尝试身份切），属已知
 * 缺口、概率极低，attempts 快照可事后归因。长跑命令依赖 PowerShell
 * （Start-Sleep）——非 PowerShell 宿主上 RM-4/RM-5 按输出正文缺席 FAIL
 * （非 FAULT）取证。
 *
 * ## 用法
 *
 *   node verify/probe-resume-multilayer.mjs --service-root <宿主服务根> \
 *     --host-subdir <宿主树目录名，如 dsh-0.2.1-rc.5> [--repo <本仓路径>] [--keep]
 *
 * `--service-root` 必填（或设 `DSAT_SERVICE_ROOT`）。探针以
 * `<serviceRoot>/patches/zai-glm.yml` 作为实例模型路由 patch——该文件由本机
 * 部署环境提供，缺失时实例在就绪等待处 FAULT（90s 超时＋stderr 尾部），请
 * 自备同位 patch 或改参。tgz 产物结束自清；证据
 * JSON 每次落盘保留在 `.local/`（FAULT 路径的 tgz 与临时 home 都不清——
 * fail() 会打印 home 路径，重跑前可手动清理）。退出码：0＝全部判定通过；
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
      writeFileSync(join(repo, '.local', 'probe-resume-multilayer.json'), JSON.stringify({ ...evidence, fault: String(msg) }, null, 2));
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
home = mkdtempSync(join(tmpdir(), 'dsh-rsm-ml-'));
const cliBin = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const addRun = spawnSync('node', [cliBin, 'plugin', '--profile', 'web', 'add', tgzPath], {
  cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 300_000
});
if (addRun.status !== 0) fail(`plugin add 退出 ${String(addRun.status)}：stderr 尾部 ${String(addRun.stderr).slice(-600)}／stdout 尾部 ${String(addRun.stdout).slice(-600)}`);
log('plugin add 完成');

// 3) 起隔离实例（随机端口；RM-2 要重启，spawn 封装成可重入）。
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
// 重启后 --port 0 会换端口：rebind 用新 URL 重做 token→cookie 并重绑变量。
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
/** 全部注入侧 user/message 文本（不限 source.kind——子代理最终回答等交付载体
 *  有各自的 source 形态；真用户消息不算注入）。 */
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
/** steer 插话进入模型上下文的宿主侧事件（WS-4 同款锚）。 */
function splicedSeen(transcript, fromIndex = 0) {
  return stepRecords(transcript, fromIndex).some((r) => r.event?.type === 'agent/inbox/spliced');
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
/** 发指令（默认 queue 通道；RM-4/RM-5/RM-6 的注入按步骤指定 mode）。 */
async function sendPrompt(sessionId, text, mode = 'queue') {
  await rpcOk('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId, mode,
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
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
      await sendPrompt(sessionId, step.prompt, step.mode ?? 'queue');
    } catch (error) {
      killChild();
      fail(`session/prompt 调用失败：${String(error?.message ?? error)}`);
    }
    const deadline = Date.now() + (step.timeoutMs ?? STEP_TIMEOUT_MS);
    let lastDetail = '（无判定输出）';
    let acted = false;
    while (Date.now() < deadline) {
      await new Promise((r) => { setTimeout(r, POLL_MS); });
      if (child !== null && child.exitCode !== null) { killChild(); fail('实例在步骤中途退出'); }
      let transcript;
      try { transcript = await transcriptOf(sessionId); } catch { continue; }
      // 步骤专属动作：观察到本窗相应工具调用（gate）后注入（RM-4/5 的
      // async_run、RM-6 的 async_agent——门控注入不早于工作形态开始）。
      if (!acted && step.afterWorking !== undefined) {
        const workingSeen = step.gate === undefined
          || toolCallNames(transcript, beforeCount).has(step.gate);
        if (workingSeen) {
          acted = true;
          await step.afterWorking(sessionId);
          log(`步骤 ${step.name}：主体进入工作形态，注入动作完成。`);
        }
      }
      const ctx = {
        modelTexts: modelTexts(transcript, beforeCount),
        toolResults: toolResultTexts(transcript, beforeCount),
        toolNames: toolCallNames(transcript, beforeCount),
        injected: injectedTexts(transcript, beforeCount),
        spliced: splicedSeen(transcript, beforeCount),
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
        spliced: ctx.spliced,
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
  judge('RM-0 装载后 dsh-async 预设会话可用', false,
    `装载前置失败：${created1.ok ? `agentPreset 回落 ${String(created1.value?.agentPreset)}` : JSON.stringify(created1.error).slice(0, 160)}`);
  await shutdownAndFinish();
}
const s1 = created1.value;
evidence.sessions.main = s1.sessionId;
judge('RM-0 装载后 dsh-async 预设会话可用', true, `会话 A 已建（sessionId=${s1.sessionId.slice(0, 14)}…）`);

// ── RM-1 重启前武装：派生短子代理（基线）──
console.log('\n── RM-1 重启前派生子代理（基线）──');
await driveStep(s1.sessionId, {
  name: 'RM-1 重启前子代理往返（agent_id＋回答到达）',
  prompt: 'Run this single step: call async_agent with description "rm1 child", prompt "Reply with exactly the single token RM1-CHILD-2a6 and nothing else." — it returns an agent_id immediately; end your turn WITHOUT waiting. When the child agent answer reaches you, reply with exactly RM1_DONE and end your turn. No other tools, no questions.',
  judge: (ctx) => {
    const spawnUsed = ctx.toolNames.has('async_agent');
    const idReceipt = ctx.toolResults.some((t) => /agent_id/i.test(t));
    const childAnswer = ctx.injected.some((e) => e.text.includes('RM1-CHILD-2a6'));
    const receipt = ctx.modelTexts.some((t) => t.includes('RM1_DONE'));
    const ok = spawnUsed && idReceipt && childAnswer && receipt;
    return { ok, detail: ok ? 'async_agent 在场＋agent_id 回执＋子代理回答经宿主侧载体到达＋回执' : `async_agent 在场 ${String(spawnUsed)}／agent_id 回执 ${String(idReceipt)}／子代理回答到达 ${String(childAnswer)}／回执 ${String(receipt)}` };
  }
});

// ── RM-2 重启后恢复会话（resume）：插件仍在 profile，resume 应成功 ──
console.log('\n── RM-2 重启后恢复会话 ──');
killChild();
await new Promise((r) => { setTimeout(r, 2500); });
const url2 = await startInstance();
await rebind(url2);
const listing2 = await rpcOk('session/list', { _request: {} });
const oldRow = listing2.items.find((item) => item.sessionId === s1.sessionId);
evidence.phases.oldSessionAfterRestart = oldRow === undefined ? null : { sessionId: s1.sessionId };
// RM-2 独立驱动：resume 的拒绝形态发生在 session/prompt RPC 层（IL-3 实测
// 同层）——用 rpc() 原样捕获错误体判 FAIL（不混入 FAULT），成功时轮询回执。
if (oldRow === undefined) {
  judge('RM-2 恢复会话继续接受指令（resume 回执）', false, `老会话不在重启后名册（宿主形态如实记录——session/list 无 ${s1.sessionId.slice(0, 14)}…）`);
} else {
  const resumePrompt = await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: s1.sessionId, mode: 'queue',
      content: [{ type: 'text', text: 'Reply with exactly RM2_DONE and end your turn. No tools, no questions.' }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
  if (resumePrompt.ok !== true) {
    evidence.phases.resumePrompt = { ok: false, error: resumePrompt.error };
    judge('RM-2 恢复会话继续接受指令（resume 回执）', false, `resume 指令被宿主拒（错误体入证据——与 IL-3 卸载后 resume 被拒同层形态）：${JSON.stringify(resumePrompt.error).slice(0, 200)}`);
  } else {
    evidence.phases.resumePrompt = { ok: true };
    // 轮询回执；prompt 层拒绝已由上面 rpc() 捕获（IL-3 实测拒绝层），轮询
    // 中途 session/page 的网络层异常/'session not found' 抛错同样按超时
    // FAIL 取证（page 层 RPC 拒绝形态走 rpcOk→FAULT，不在此分支内）。
    const resumeDeadline = Date.now() + 180_000;
    let resumeOk = false;
    let resumeDetail = '回执未到达（resume 被拒或指令未执行——180s 超时）';
    while (Date.now() < resumeDeadline) {
      await new Promise((r) => { setTimeout(r, POLL_MS); });
      if (child !== null && child.exitCode !== null) { killChild(); fail('实例在 RM-2 轮询中退出'); }
      let transcript;
      try { transcript = await transcriptOf(s1.sessionId); } catch (error) {
        resumeDetail = `session/page 被拒：${String(error?.message ?? error).slice(0, 160)}`;
        break;
      }
      if (modelTexts(transcript).some((t) => t.includes('RM2_DONE'))) {
        resumeOk = true;
        resumeDetail = '恢复会话指令回执到达（未卸载重启后 resume 成功——与 IL-3 卸载后 resume 被拒对照）';
        break;
      }
    }
    judge('RM-2 恢复会话继续接受指令（resume 回执）', resumeOk, resumeDetail);
    // RM-2 FAIL（resume 被拒/回执未达）即收尾——后续 RM-3 的 sendPrompt 会在
    // 同层被拒处 FAULT，先按 FAIL 判定收束退出码 1（错误体已留证据）。
    if (!resumeOk) await shutdownAndFinish();
  }
}

// ── RM-3 恢复会话续派子代理（实时模型选择的恢复会话面）──
console.log('\n── RM-3 恢复会话续派子代理 ──');
await driveStep(s1.sessionId, {
  name: 'RM-3 恢复会话续派子代理（派生许可与回答投递）',
  prompt: 'Run this single step: call async_agent with description "rm3 resumed child", prompt "Reply with exactly the single token RM3-CHILD-5c1 and nothing else." — it returns an agent_id immediately; end your turn WITHOUT waiting. When the child agent answer reaches you, reply with exactly RM3_DONE and end your turn. No other tools, no questions.',
  judge: (ctx) => {
    const spawnUsed = ctx.toolNames.has('async_agent');
    const idReceipt = ctx.toolResults.some((t) => /agent_id/i.test(t));
    const childAnswer = ctx.injected.some((e) => e.text.includes('RM3-CHILD-5c1'));
    const receipt = ctx.modelTexts.some((t) => t.includes('RM3_DONE'));
    const ok = spawnUsed && idReceipt && childAnswer && receipt;
    return { ok, detail: ok ? '恢复会话中 async_agent 派生在场＋agent_id 回执＋子代理回答到达——派生许可与配置继续生效' : `async_agent 在场 ${String(spawnUsed)}／agent_id 回执 ${String(idReceipt)}／子代理回答到达 ${String(childAnswer)}／回执 ${String(receipt)}` };
  }
});

// ── RM-4 恢复会话中的排队消息（queue 通道→回合边界领取）──
console.log('\n── RM-4 恢复会话排队消息 ──');
// 第一步：发一条会被执行的普通指令（让主体进入忙碌），随后 queue 注入目标消息；
// 主体在回合边界领取 queue 消息并回执。
await driveStep(s1.sessionId, {
  name: 'RM-4 排队消息经回合边界领取（恢复会话不漂移）',
  prompt: 'Run this single step: call async_run with command "Start-Sleep -Seconds 20; Write-Output RM4-BUSY-8d3", description "rm4 busy window", yield_ms 30000 and wait for its foreground output. Then end your turn with exactly RM4_BUSY_DONE.',
  gate: 'async_run',
  afterWorking: async (sessionId) => {
    // 忙碌已开始（async_run 调用在场门控）即注入（queue 通道——回合边界领取）。
    await sendPrompt(sessionId, 'Queued follow-up: after your current work, reply with exactly RM4_DONE (in addition to anything you already planned) and end your turn. Do not call more tools.', 'queue');
  },
  judge: (ctx) => {
    // 忙碌窗实锚：async_run 在场＋命令输出 token 经宿主侧载体到达（模型跳过
    // 命令直回 token 的假 PASS 被拦截；非 PowerShell 宿主上输出缺席按 FAIL）。
    const runUsed = ctx.toolNames.has('async_run');
    const busyOutput = ctx.toolResults.some((t) => t.includes('RM4-BUSY-8d3'));
    const busyDone = ctx.modelTexts.some((t) => t.includes('RM4_BUSY_DONE'));
    // 回执 RM4_DONE＝queue 消息被领取并履行（token 只在注入文本出现——queue
    // 丢失时模型无法产出，该方向闭合）。
    const queuedReceipt = ctx.modelTexts.some((t) => t.includes('RM4_DONE'));
    const ok = runUsed && busyOutput && busyDone && queuedReceipt;
    return { ok, detail: ok ? '忙碌窗实锚（async_run＋输出正文）＋排队消息经回合边界领取并履行（恢复会话的宿主下一轮语义不漂移）' : `async_run 在场 ${String(runUsed)}／忙碌输出 ${String(busyOutput)}／忙碌回执 ${String(busyDone)}／排队消息回执 ${String(queuedReceipt)}` };
  }
});

// ── RM-5 首等工具执行中的插话（等待挂起之外形态）──
console.log('\n── RM-5 首等工具执行中的插话 ──');
await driveStep(s1.sessionId, {
  name: 'RM-5 首等工具执行中 steer 插话不丢失且命令不终止',
  prompt: 'Run this single step: call async_run with command "Start-Sleep -Seconds 60; Write-Output RM5-TOKEN-4e7", description "rm5 first-wait work", yield_ms 600000 and wait for the command to finish (foreground, or via a follow-up async_wait if your first wait ends early). Then end your turn with exactly RM5_DONE.',
  gate: 'async_run',
  afterWorking: async (sessionId) => {
    // 命令调用在场门控后约 8s 经 steer 通道注入（首等窗内——非等待挂起形态）。
    await new Promise((r) => { setTimeout(r, 8000); });
    await sendPrompt(sessionId, 'Steering message while you work: when the command finishes, also reply with exactly RM5_STEER_DONE (in addition to RM5_DONE) in the same final message. Do not restart or kill the command.', 'steer');
  },
  judge: (ctx) => {
    // 命令未终止：输出 token 经宿主侧载体到达（实测形态：steer 结束首次等待
    // →同一作业句柄→命令后台续跑→正文经后续等待到达——不限定前台/等待载体，
    // 只锚「命令完成且正文在场」这一宿主侧事实）。
    const runUsed = ctx.toolNames.has('async_run');
    const outputThere = ctx.toolResults.some((t) => t.includes('RM5-TOKEN-4e7'));
    // 插话不丢失：steer 指令被履行（RM5_STEER_DONE 唯一 token 回执——主锚）；
    // spliced 事件在场为旁证（该宿主对上下文注入同样产生 spliced，不单独归因）。
    const steerReceipt = ctx.modelTexts.some((t) => t.includes('RM5_STEER_DONE'));
    const spliced = ctx.spliced;
    const ok = runUsed && outputThere && steerReceipt && spliced;
    return { ok, detail: ok ? '命令正文到达（未终止——实测经句柄＋后续等待）＋steer 插话被履行（唯一 token 回执，spliced 旁证）——首等工具执行中的插话面' : `async_run 在场 ${String(runUsed)}／命令正文 ${String(outputThere)}／插话回执 ${String(steerReceipt)}／spliced 旁证 ${String(spliced)}` };
  }
});

// ── RM-6 多层链与主代理层插话共存 ──
console.log('\n── RM-6 多层链（孙代理）与主代理层插话 ──');
await driveStep(s1.sessionId, {
  name: 'RM-6 多层链通且主代理层插话照达',
  prompt: 'Run this single step: call async_agent with description "rm6 middle agent", prompt "Run this single step: call async_agent with description \'rm6 grandchild\', prompt \'Reply with exactly the single token GRAND-9c4 and nothing else.\' — it returns an agent_id; end your turn WITHOUT waiting. When that child answer reaches you, reply with exactly MID_DONE plus that token." — it returns an agent_id immediately; end your turn WITHOUT waiting. When the middle agent final answer reaches you AND any newer user message, reply with exactly RM6_DONE plus the grandchild token, then end your turn. No other tools, no questions.',
  gate: 'async_agent',
  afterWorking: async (sessionId) => {
    // 中间代理派生在场门控后约 12s（中间代理在等孙代理期间——主代理已结束
    // 回合、等注入），主会话 steer 插话——落点是主代理层（宿主不允许后台
    // 子代理直接人类交互）。
    await new Promise((r) => { setTimeout(r, 12000); });
    await sendPrompt(sessionId, 'Steering message: when the middle agent answer reaches you, make sure your final reply contains RM6_STEER_OK as well. Do not call more tools.', 'steer');
  },
  judge: (ctx) => {
    // 多层链：主代理 async_agent 在场＋中间代理最终回答（MID_DONE＋GRAND-9c4）
    // 经宿主侧载体到达主会话。
    const spawnUsed = ctx.toolNames.has('async_agent');
    const midAnswer = ctx.injected.some((e) => e.text.includes('MID_DONE') && e.text.includes('GRAND-9c4'));
    // 主代理层插话：steer 回执（RM6_STEER_OK 唯一 token——主锚）；spliced
    // 事件在场为旁证（对上下文注入同样产生，不单独归因）。
    const steerReceipt = ctx.modelTexts.some((t) => t.includes('RM6_STEER_OK'));
    const spliced = ctx.spliced;
    const receipt = ctx.modelTexts.some((t) => t.includes('RM6_DONE') && t.includes('GRAND-9c4'));
    const ok = spawnUsed && midAnswer && steerReceipt && spliced && receipt;
    return { ok, detail: ok ? '多层链（孙代理 token 双跳到达主会话）＋主代理层 steer 插话被履行（唯一 token 回执，spliced 旁证）＋回执' : `async_agent 在场 ${String(spawnUsed)}／中间回答到达 ${String(midAnswer)}／插话回执 ${String(steerReceipt)}／spliced 旁证 ${String(spliced)}／回执 ${String(receipt)}` };
  }
});

// 7) 收尾：停实例→留证据→清理（--keep 时保留临时 home 供排查）。
function finishRun() {
  try { rmSync(tgzPath, { force: true }); } catch { /* 产物清理尽力而为 */ }
  mkdirSync(join(repo, '.local'), { recursive: true });
  writeFileSync(join(repo, '.local', 'probe-resume-multilayer.json'), JSON.stringify(evidence, null, 2));
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
  log(`证据落盘：${join('.local', 'probe-resume-multilayer.json')}（本机材料目录）`);
  finishRun();
}
await shutdownAndFinish();
