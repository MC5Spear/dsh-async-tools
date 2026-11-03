#!/usr/bin/env node
/**
 * 编排 PTC 钩子真机探针（VERIFY-01「编排 PTC 钩子仍缺完整实例证据」项）。
 *
 * 流程骨架与姊妹探针（probe-concurrent-wait／probe-wait-semantics）同款：npm pack
 * 受测 tgz→mkdtemp 独立 DSH_HOME→官方 CLI plugin add→随机端口隔离实例（模型
 * 路由 patch 取 `<serviceRoot>/patches/zai-glm.yml`）→RPC→单会话（agentPreset
 * ='dsh-async'）→三步单步指令（prompt 显式要求串行单工具调用）。
 *
 * 三步（对应需求 4 章 async_workflow 行为约定 232-257）：
 *
 * 1. WF-1 pipeline 逐条独立流过＋局部降 null（249 行 pipeline 条款）：纯 JS 阶段（不派
 *    子代理——pipeline 阶段是编排脚本内同步函数，只有 agent() 钩子派子代理），
 *    三条目中间条在第二阶段抛错——该条降 null、跳过其余阶段，其余条目正常，
 *    整个脚本照常 return（局部错误不终止，致命误用才终止）。判据锚结果正文
 *    （载体＝工具返回∪完成消息——workflow 首次等待 24s 内纯脚本必完成，前台
 *    直接返回或短等待返回都合法）含两条正结果标记与序列化 null、单次
 *    async_workflow 调用、回执。误用终止面与局部 null 面的对照由此分界。
 *
 * 2. WF-2 致命误用终止整个脚本（252 行）：agent() 钩子传未知选项（effort——
 *    workflow 契约「effort/isolation/agentType 一律报错拒绝」）。误用钩子参数
 *    终止整个脚本、错误可读、不能被 parallel 吞成局部 null——判据锚错误文案
 *    在场（工具返回∪完成消息）＋子代理 token 永不出现（WF2-NEVER-TOKEN——
 *    无论校验发生在派发前（秒错）还是派发后（错误仍终止、子代理回答不进
 *    结果），两形态判据都闭合）。
 *
 * 3. WF-3 agent() 真实子代理＋phase/log＋进度日志默认关闭（251/256-257/773 行）：
 *    脚本声明 phase（标记串）＋派一个真实子代理（回执 token）＋log（标记串）。
 *    判据：子代理 token 经结果正文到达（async_workflow 前台 24s 转后台、模型
 *    按指令以 async_wait 领取或完成消息到达——载体不限）＋**进度日志不在结果
 *    正文**（phase 标题与 log 消息标记串缺席——工作流进度日志展示开关默认
 *    false，观察日志仅供界面与既有记录，不进交付正文；命令输出与最终结果
 *    不属可关闭日志——token 是最终结果必须到达）＋单次 async_workflow 调用
 *    ＋回执。
 *
 * 三步共通：单次 async_workflow（结果正文与调用数锚定同一次调用）＋串行单工
 * 具。装置边界：并发/总量/组合上限与「并发槽满排队」属宿主 PTC 引擎出厂行
 * 为（设计 §「宿主 PTC 编排引擎的核验基准」；需求 236 本包不重写引擎与配
 * 置），本装置各步 ≤1 子代理不触发，也不由本仓套件锚定（套件两处编排引擎
 * 均为替身）——按宿主行为边界不装置不另锚定。同属编排契约但不单独装置：
 * parallel 普通函数错误降 null（250 行——与 pipeline 局部降 null 同语义不
 * 同钩子，WF-1 只装置 pipeline 侧）、agent() schema 白名单外字段拒绝（248
 * 行）、meta 未知字段拒绝（245 行）。GUI 回放持久节点（257 行「运行开始、
 * 子代理开始／结束、运行结束」）的界面呈现不在 RPC 装置范围，也不进本探针
 * 证据快照（五类提取器按 event.type 过滤、不含 recorder 事件）——需要时可
 * 从会话档案另查；meta.phases 声明匹配（「已声明阶段按精确标题匹配」）不
 * 单独装置（phase 标题进度属界面观感）。
 *
 * ## 用法
 *
 *   node verify/probe-workflow-engine.mjs --service-root <宿主服务根> \
 *     --host-subdir <宿主树目录名，如 dsh-0.2.1-rc.5> [--repo <本仓路径>] [--keep]
 *
 * `--service-root` 必填（或设 `DSAT_SERVICE_ROOT`）。模型路由 patch 同姊妹探针
 * （本机部署环境提供，缺失时实例就绪等待处 FAULT）。tgz 产物结束自清；证据
 * JSON 每次落盘保留在 `.local/`（FAULT 路径的 tgz 不清，重跑前可手动清理）。
 * 退出码：0＝全部判定通过；1＝存在 FAIL 判定；2＝探针自身故障（FAULT）。
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
      writeFileSync(join(repo, '.local', 'probe-workflow-engine.json'), JSON.stringify({ ...evidence, fault: String(msg) }, null, 2));
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
home = mkdtempSync(join(tmpdir(), 'dsh-wf-engine-'));
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
function killChild() {
  if (child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
  }
}
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
  // 非幂等端点（session/create、session/prompt）不走自动重试——重复投递会
  // 建双会话或重复指令；其余端点（list/page）失败重试一次。两分支统一解析。
  const parse = async (response) => {
    const parsed = JSON.parse(await response.text());
    if (parsed?.result?.ok !== true) return { ok: false, error: parsed?.result?.error ?? null };
    return { ok: true, value: parsed.result.value };
  };
  const once = () => fetch(`${ORIGIN}/api/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body,
    signal: AbortSignal.timeout(60_000)
  });
  if (endpoint === 'session/prompt' || endpoint === 'session/create') return parse(await once());
  let response;
  try {
    response = await once();
  } catch (connError) {
    log(`rpc ${endpoint} 首次请求失败，重试一次：${String(connError?.message ?? connError)}`);
    response = await once();
  }
  return parse(response);
}
async function rpcOk(endpoint, argsBody) {
  const r = await rpc(endpoint, argsBody);
  if (r.ok !== true) fail(`${endpoint} 调用失败：${JSON.stringify(r.error).slice(0, 200)}`);
  return r.value;
}
const created = await rpcOk('session/create', { request: { cwd: home, agentPreset: 'dsh-async' } });
if (created.agentPreset !== 'dsh-async') { killChild(); fail(`agentPreset 回落：${String(created.agentPreset)}`); }
const SESSION = created.sessionId;
log(`会话已建（sessionId=${SESSION}）`);
async function prompt(text, mode = 'queue') {
  await rpcOk('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: SESSION, mode,
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
}
// transcriptOf 对 RPC 失败抛错（不升格 FAULT）——轮询环与基线拉取按瞬时
// 故障容忍重试（姊妹 wait-semantics 同款通道形态）；fail() 保留给不可自动
// 重试的调用（建链：实例/token/会话创建；步骤指令投递 session/prompt——
// 非幂等，失败即 FAULT）。
async function transcriptOf() {
  const listing = await rpc('session/list', { _request: {} });
  if (listing.ok !== true) throw new Error(`session/list 失败：${JSON.stringify(listing.error).slice(0, 160)}`);
  const row = listing.value.items.find((item) => item.sessionId === SESSION);
  if (row === undefined) throw new Error('session not found');
  const page = await rpc('session/page', {
    request: { address: { kind: 'session', sessionId: SESSION }, throughSeq: row.projections.asOfSeq, maxMessages: 1200 }
  });
  if (page.ok !== true) throw new Error(`session/page 失败：${JSON.stringify(page.error).slice(0, 160)}`);
  return page.value;
}
/** 载体提取器统一带 fromIndex：转录 append-only、seq 可能缺席，按数组下标
 *  切出「本步新增」窗口——跨步陈旧记录（前步作业的迟到结算与完成消息）
 *  不进断言。 */
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
/** 本步窗口内各工具的调用次数（单次调用锚：结果正文与调用数锚定同一次调用）。 */
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

// 5) 步骤驱动（每步单条明确指令＋固定回执 token；首不成重试一次）。
const STEP_TIMEOUT_MS = 420_000;
const POLL_MS = 4000;
const verdicts = [];
evidence = { head, dirty: dirty !== '', hostVersion, sessionId: SESSION, steps: [], verdicts };
function judge(name, ok, detail = '') {
  verdicts.push({ name, ok: ok === true, detail: String(detail).slice(0, 400) });
  console.log(`${ok === true ? 'PASS ' : 'FAIL '} ${name}${detail === '' ? '' : `  —— ${String(detail).slice(0, 240)}`}`);
}
/** 驱动一步：发指令→轮询至判定成立或超时；重试一次。 */
const lastBaselineShared = { value: 0 };
async function driveStep(step) {
  const record = { name: step.name, attempts: [] };
  evidence.steps.push(record);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // 步骤基线：当前记录条数（seq 可能缺席，append-only 下标即坐标）；拉取
    // 失败时沿用上一成功基线（首步按 0）并打标——退化窗会把前步调用计入
    // 单次调用锚（假 FAIL 方向），留痕供离线区分退化与真 FAIL。
    let beforeCount = lastBaselineShared.value;
    let baselineDegraded = false;
    try {
      beforeCount = (await transcriptOf()).records?.length ?? 0;
      lastBaselineShared.value = beforeCount;
    } catch { baselineDegraded = beforeCount !== 0; }
    try {
      await prompt(step.prompt);
    } catch (error) {
      killChild();
      fail(`session/prompt 调用失败：${String(error?.message ?? error)}`);
    }
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    let lastDetail = '（无判定输出）';
    while (Date.now() < deadline) {
      await new Promise((r) => { setTimeout(r, POLL_MS); });
      if (child.exitCode !== null) { killChild(); fail('实例在步骤中途退出'); }
      let transcript;
      try { transcript = await transcriptOf(); } catch { continue; }
      const ctx = {
        modelTexts: modelTexts(transcript, beforeCount),
        toolResults: toolResultTexts(transcript, beforeCount),
        toolNames: toolCallNames(transcript, beforeCount),
        toolCallCounts: toolCallCounts(transcript, beforeCount),
        completions: completionSends(transcript, beforeCount)
      };
      const outcome = step.judge(ctx);
      if (outcome.ok === true) {
        record.attempts.push({ attempt, ok: true, detail: outcome.detail, baselineDegraded });
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
        modelTail: ctx.modelTexts.slice(-5).map((t) => t.slice(-250))
      };
    }
    record.attempts.push({ attempt, ok: false, detail: lastDetail, baselineDegraded });
    log(`步骤 ${step.name} 第 ${String(attempt)} 次未成立（${lastDetail}）${attempt === 1 ? '，重试一次' : ''}`);
  }
  judge(step.name, false, `两次尝试未成立；最后状态：${String(evidence.steps.at(-1).attempts.at(-1).detail)}`);
  return false;
}

console.log(`\n── WF-1 pipeline 逐条独立流过＋局部降 null（纯脚本阶段）（当前候选 ${head}${dirty}）──`);
await driveStep({
  name: 'WF-1 局部阶段错误只降该条 null、不终止脚本',
  // pipeline 阶段是编排脚本内的同步函数（不派子代理）——24s 首次等待内整个
  // 脚本必然完成，前台直接返回或短等待返回都合法（载体＝工具返回∪完成消息）。
  // 中间条（beta）在第二阶段抛错：该条降 null 并跳过其余阶段，alpha/gamma
  // 正常流过——「局部错误不终止，致命误用才终止」的对照前半。
  prompt: 'Run this single step, issuing each tool call in sequence and waiting for its result before the next call, and reply with exactly the token WF1_DONE: call async_workflow once with meta={name:"wf1-pipeline", description:"probe wf1 pipeline"} and script exactly: const out = await pipeline(["alpha","beta","gamma"], (v) => ({ item: v }), (p) => { if (p.item === "beta") { throw new Error("WF1-LOCAL-ERR"); } return "WF1-OK-" + p.item; }); return { out }; — yield_ms 24000, wait inline for it to return; the final result should be the JSON object with out containing "WF1-OK-alpha", null, "WF1-OK-gamma". After it returns, reply WF1_DONE. No other tools, no questions.',
  judge: (ctx) => {
    const singleCall = (ctx.toolCallCounts.get('async_workflow') ?? 0) === 1;
    const textAll = [...ctx.toolResults, ...ctx.completions].join('\n');
    const alphaOk = textAll.includes('WF1-OK-alpha');
    const gammaOk = textAll.includes('WF1-OK-gamma');
    // 序列化 null 在场：结果经 JSON 序列化（return 值必须可 JSON 序列化），
    // null 条目以字面形态出现在正文。宽松匹配（数组形态引号差异容忍）。
    const nullEntry = /\bnull\b/.test(textAll);
    const receipt = ctx.modelTexts.some((t) => t.includes('WF1_DONE'));
    const ok = singleCall && alphaOk && gammaOk && nullEntry && receipt;
    return { ok, detail: ok ? `单次 async_workflow＋alpha/gamma 正结果与 null 条目到场（局部降 null、脚本照常 return）＋回执` : `单次调用 ${String(singleCall)}（${String(ctx.toolCallCounts.get('async_workflow') ?? 0)} 次）／alpha ${String(alphaOk)}／gamma ${String(gammaOk)}／null 条目 ${String(nullEntry)}／回执 ${String(receipt)}` };
  }
});

console.log('\n── WF-2 致命误用终止整个脚本（agent 未知选项）──');
await driveStep({
  name: 'WF-2 钩子误用报错终止、不被吞成局部 null',
  // agent() 传未知选项 effort（契约「effort/isolation/agentType 一律报错拒绝」）
  // ——致命误用终止整个脚本、错误可读、不能被 parallel 吞成 null。判据锚
  // 错误文案在场＋子代理 token 永不出现（校验在派发前后两形态都闭合）。
  prompt: 'Run this single step, issuing each tool call in sequence and waiting for its result before the next call, and reply with exactly the token WF2_DONE: call async_workflow once with meta={name:"wf2-fatal", description:"probe wf2 fatal misuse"} and script exactly: const r = await parallel([async () => await agent("Reply with exactly WF2-NEVER-TOKEN and nothing else.", {label:"wf2 child", effort:"high"})]); return { r }; — yield_ms 24000, wait inline; the workflow MUST fail with a readable error (unknown option effort), it must NOT return normally. After it returns (with the error), reply WF2_DONE. No other tools, no questions.',
  judge: (ctx) => {
    const singleCall = (ctx.toolCallCounts.get('async_workflow') ?? 0) === 1;
    const textAll = [...ctx.toolResults, ...ctx.completions].join('\n');
    // 错误文案在场：未知选项拒绝（同一文本内 effort 与错误语标记共现——
    // 收紧到单条载体，避免跨条目拼凑）。
    const errorRead = [...ctx.toolResults, ...ctx.completions].some((t) => t.includes('effort') && /(error|错误|unknown|option|选项|reject|拒绝|invalid|不支持)/i.test(t));
    // 子代理 token 缺席：误用必须终止——子代理回答不得作为正常结果出现。
    const agentAbsent = !textAll.includes('WF2-NEVER-TOKEN');
    const receipt = ctx.modelTexts.some((t) => t.includes('WF2_DONE'));
    const ok = singleCall && errorRead && agentAbsent && receipt;
    return { ok, detail: ok ? `单次 async_workflow＋致命误用可读错误到场＋子代理 token 缺席（终止不被吞）＋回执` : `单次调用 ${String(singleCall)}（${String(ctx.toolCallCounts.get('async_workflow') ?? 0)} 次）／错误可读 ${String(errorRead)}／token 缺席 ${String(agentAbsent)}／回执 ${String(receipt)}` };
  }
});

console.log('\n── WF-3 真实子代理＋phase/log 进度默认不进正文 ──');
await driveStep({
  name: 'WF-3 子代理 token 到场、进度日志缺席正文',
  // 真实子代理回答（约 30-60s）超出 24s 首次等待→转后台→模型按指令以
  // async_wait 领取（或完成消息到达——载体不限）。进度日志展示开关默认
  // false：phase 标题与 log 消息不进交付正文；最终结果（token）必须到达。
  prompt: 'Run this single step, issuing each tool call in sequence and waiting for its result before the next call, and reply with exactly the token WF3_DONE: (1) call async_workflow once with meta={name:"wf3-run", description:"probe wf3 agent"}, args={}, and script exactly: phase("WF3-PHASE-MARK"); const r = await agent("Reply with exactly WF3-AGENT-8c4 and nothing else.", {label:"wf3 child"}); log("WF3-LOG-MARK"); return { answer: r }; — yield_ms 24000; (2) the child agent takes a while, so if the call returns a job_id, immediately call async_wait once with targets [{kind:"job", id:<that job_id>}] and wait_ms 240000, waiting inline until it returns; (3) the final result should contain WF3-AGENT-8c4; workflow progress logs (phase title, log message) should NOT appear in the result. After the result arrives, reply WF3_DONE. No other tools, no job_output, no questions.',
  judge: (ctx) => {
    const singleCall = (ctx.toolCallCounts.get('async_workflow') ?? 0) === 1;
    const textAll = [...ctx.toolResults, ...ctx.completions].join('\n');
    const agentToken = textAll.includes('WF3-AGENT-8c4');
    // 进度日志缺席正文（默认关闭——需求 773：观察日志仅供界面与既有记录）。
    // 缺席锚只查交付正文（tool/result∪完成消息）——模型转述不算交付。
    const phaseAbsent = !textAll.includes('WF3-PHASE-MARK');
    const logAbsent = !textAll.includes('WF3-LOG-MARK');
    const noReadTool = !ctx.toolNames.has('job_output');
    const receipt = ctx.modelTexts.some((t) => t.includes('WF3_DONE'));
    const ok = singleCall && agentToken && phaseAbsent && logAbsent && noReadTool && receipt;
    return { ok, detail: ok ? `单次 async_workflow＋子代理 token 经结果到达＋phase/log 标记缺席正文（进度日志默认关闭）＋无 job_output＋回执` : `单次调用 ${String(singleCall)}（${String(ctx.toolCallCounts.get('async_workflow') ?? 0)} 次）／token ${String(agentToken)}／phase 缺席 ${String(phaseAbsent)}／log 缺席 ${String(logAbsent)}／无 job_output ${String(noReadTool)}／回执 ${String(receipt)}` };
  }
});

// 6) 收尾：停实例→等句柄释放→留证据→清理（--keep 时保留临时 home）。
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
writeFileSync(join(repo, '.local', 'probe-workflow-engine.json'), JSON.stringify(evidence, null, 2));
log(`证据落盘：${join('.local', 'probe-workflow-engine.json')}（本机材料目录）`);
const failures = verdicts.filter((v) => v.ok !== true).length;
console.log(failures === 0 ? `\n判定：全部通过（${String(verdicts.length)} 项）` : `\n判定：${String(failures)} 项 FAIL（共 ${String(verdicts.length)} 项）`);
process.exit(failures === 0 ? 0 : 1);
