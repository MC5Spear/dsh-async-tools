/**
 * 当前候选实装行为复验探针（VERIFY-01：候选提交态的实例证据）。
 *
 * ## 探针在证什么
 *
 * 全量测试（双锚 744）与运行时同源探针都不代替「当前候选在真实实例上把核心
 * 行为面跑一遍」。本探针打包当前工作区为官方 tgz，在系统临时目录的独立 home
 * 里经官方 CLI 安装，起随机端口隔离实例，用真实模型会话依次驱动五个单步任务，
 * 每步从会话转录（session/page）取证断言：
 *
 * 1. LA-1 前台真实命令：async_run 执行固定命令，tool/result 正文含固定 token；
 * 2. LA-2 后台作业＋等待领取：async_run 后台返回 job_id，async_wait 领取的
 *    正文含固定 token（交付载体之一）；
 * 3. LA-3 取消与名册：job_kill 取消长睡眠作业（终态记录在案），job_list 返回
 *    注册列表（job_output 不出现在模型可见名册）；
 * 4. LA-4 子代理派生与领取：async_agent 派生后台子代理，其最终回答经完成消息
 *    或等待返回到达主代理（不限定载体，与交付设计一致）；
 * 5. LA-5 空闲主体完成消息：主体无活等待时后台作业结算，完成消息
 *    （user/message 且 source.kind=async-tools-job-result）注入到达。
 *
 * 每步由模型回固定 token 判定执行到位；任一步超时或断言不成立按 FAIL 计。
 * 模型可能偶发不照单步指令执行——同一会话重试一次后仍不成立才判 FAIL，
 * 重试在证据中留痕，不静默吞掉。正文类断言只认宿主侧载体（工具返回、完成
 * 消息、注入消息）——模型文本只作回执，防模型转写指令里的 token 造成假 PASS。
 *
 * ## 用法
 *
 *   node verify/probe-live-acceptance.mjs --service-root <宿主服务根> \
 *     --host-subdir <宿主树目录名，如 dsh-0.2.1-rc.5> [--repo <本仓路径>] [--keep]
 *
 * `--service-root` 必填（或设 `DSAT_SERVICE_ROOT`）——指向装有各宿主树的根目录；
 * `--repo` 缺省取当前目录。产物落 `.local/`，结束自清；`--keep` 保留临时 home。
 * 退出码：0＝全部判定通过；1＝存在 FAIL 判定；2＝探针自身故障（FAULT）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const keep = args.includes('--keep');
let home = null;
const fail = (msg) => {
  console.error(`[probe] FAULT: ${msg}\n[probe] 临时目录：${home ?? '（尚未创建）'}${keep ? '（--keep 保留）' : '（探针故障路径，请手动清理）'}`);
  process.exit(2);
};
const serviceRootArg = argOf('service-root') ?? process.env.DSAT_SERVICE_ROOT;
if (serviceRootArg === undefined || serviceRootArg.trim() === '') fail('缺少 --service-root（或环境变量 DSAT_SERVICE_ROOT）：指向装有各宿主树的根目录');
const serviceRoot = resolve(serviceRootArg);
const hostSubdir = argOf('host-subdir') ?? 'dsh-0.2.1-rc.5';
const repo = resolve(argOf('repo') ?? process.cwd());
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

// 2) 独立 DSH_HOME（系统临时目录）＋ 官方 CLI 安装（正式装载路径；plugin add
//    内部转 pnpm 装依赖可能较慢——给足超时并在失败时带出两侧输出）。
home = mkdtempSync(join(tmpdir(), 'dsh-live-acc-'));
const cliBin = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const addRun = spawnSync('node', [cliBin, 'plugin', '--profile', 'web', 'add', tgzPath], {
  cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 300_000
});
if (addRun.status !== 0) fail(`plugin add 退出 ${String(addRun.status)}：stderr 尾部 ${String(addRun.stderr).slice(-600)}／stdout 尾部 ${String(addRun.stdout).slice(-600)}`);
log('plugin add 完成');

// 3) 起隔离实例（随机端口；凭据取 serviceRoot 下 .env 由宿主装载）。
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

// 4) RPC 骨架（token→cookie→会话；fetch 各带超时，连接被服务端关闭时重试一次）。
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
async function prompt(text) {
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: SESSION, mode: 'queue',
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
    request: { address: { kind: 'session', sessionId: SESSION }, throughSeq: row.projections.asOfSeq, maxMessages: 900 }
  });
}
/** 转录里的模型可见文本（assistant/message；含 tool 调用回合的最终文本）。 */
function modelTexts(transcript) {
  return (transcript.records ?? [])
    .filter((r) => r.event?.type === 'assistant/message' || r.event?.type === 'model/message')
    .map((r) => (r.event.data?.message?.content ?? r.event.data?.content ?? [])
      .map((c) => String(c.text ?? '')).join('\n'));
}
/** tool/result 文本集合（按工具调用断言命令输出与等待领取正文的载体）。 */
function toolResultTexts(transcript) {
  return (transcript.records ?? [])
    .filter((r) => r.event?.type === 'tool/result')
    .map((r) => (r.event.data?.message?.content ?? [])
      .filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('\n'));
}
/** 模型可见工具名册：tool/call 记录里出现过的工具名集合。 */
function toolCallNames(transcript) {
  const names = new Set();
  for (const r of transcript.records ?? []) {
    if (r.event?.type !== 'tool/call') continue;
    const name = r.event.data?.name ?? r.event.data?.toolName ?? r.event.data?.message?.name;
    if (typeof name === 'string') names.add(name);
  }
  return names;
}
/** 转录中出现过的宿主事件类型集合（job/settled 等终态事件的机器证据来源）。 */
function eventTypes(transcript) {
  const types = new Set();
  for (const r of transcript.records ?? []) {
    if (typeof r.event?.type === 'string') types.add(r.event.type);
  }
  return types;
}
/** 完成消息注入（lib/delivery-sources.js 的 JOB_RESULT_SOURCE）。 */
function completionSends(transcript) {
  const out = [];
  for (const r of transcript.records ?? []) {
    if (r.event?.type !== 'user/message') continue;
    const message = r.event.data?.message ?? r.event.data;
    if (message?.source?.kind !== 'async-tools-job-result') continue;
    out.push((message.content ?? []).map((c) => String(c.text ?? '')).join('\n'));
  }
  return out;
}
/** 全部注入侧 user/message 文本（不限 source.kind——子代理回答等交付载体可能
 *  有各自的 source 形态，取证先全量、判定再分形态）。 */
function injectedTexts(transcript) {
  const out = [];
  for (const r of transcript.records ?? []) {
    if (r.event?.type !== 'user/message') continue;
    const message = r.event.data?.message ?? r.event.data;
    const source = message?.source?.kind ?? '';
    if (source === '' || source === 'user') continue; // 真用户消息不算注入
    out.push({ source, text: (message.content ?? []).map((c) => String(c.text ?? '')).join('\n') });
  }
  return out;
}

// 5) 五步驱动：每步单条明确指令＋固定回执 token；轮询转录至 token 出现或超时。
//    超时或断言不成立时同一会话重发一次（模型偶发不执行不等于产品缺陷）。
const STEP_TIMEOUT_MS = 240_000;
const POLL_MS = 4000;
const verdicts = [];
const evidence = { head, dirty: dirty !== '', hostVersion, sessionId: SESSION, steps: [], verdicts };
function judge(name, ok, detail = '') {
  verdicts.push({ name, ok: ok === true, detail: String(detail).slice(0, 400) });
  console.log(`${ok === true ? 'PASS ' : 'FAIL '} ${name}${detail === '' ? '' : `  —— ${String(detail).slice(0, 240)}`}`);
}
/** 驱动一步：发指令→轮询至判定函数返回 true（或超时）；首次不成重试一次。 */
async function driveStep(step) {
  const record = { name: step.name, attempts: [] };
  evidence.steps.push(record);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
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
        modelTexts: modelTexts(transcript),
        toolResults: toolResultTexts(transcript),
        toolNames: toolCallNames(transcript),
        completions: completionSends(transcript),
        injected: injectedTexts(transcript),
        events: eventTypes(transcript)
      };
      const outcome = step.judge(ctx);
      if (outcome.ok === true) {
        record.attempts.push({ attempt, ok: true, detail: outcome.detail });
        judge(step.name, true, outcome.detail);
        return true;
      }
      lastDetail = outcome.detail ?? lastDetail;
      // 判定未成立时留取证据快照（截尾），供离线区分「模型未执行」与「载体取证缺口」。
      if (record.snapshot === undefined) {
        record.snapshot = {
          toolNames: [...ctx.toolNames],
          toolResults: ctx.toolResults.slice(-12).map((t) => t.slice(-600)),
          completions: ctx.completions.slice(-6).map((t) => t.slice(-400)),
          injected: ctx.injected.slice(-6).map((e) => ({ source: e.source, text: e.text.slice(-400) })),
          modelTail: ctx.modelTexts.slice(-6).map((t) => t.slice(-300))
        };
      }
    }
    record.attempts.push({ attempt, ok: false, detail: lastDetail });
    log(`步骤 ${step.name} 第 ${String(attempt)} 次未成立（${lastDetail}）${attempt === 1 ? '，重试一次' : ''}`);
  }
  judge(step.name, false, `两次尝试未成立；最后状态：${String(record.attempts.at(-1).detail)}`);
  return false;
}

console.log(`\n── LA-1 前台真实命令（当前候选 ${head}${dirty}）──`);
await driveStep({
  name: 'LA-1 前台命令正文到达',
  prompt: 'Run this single step and reply with exactly the token LA1_OK: call async_run with command "Write-Output LA1-TOKEN-9f3", description "la1 foreground", yield_ms 30000, and wait for it inline. No other tools, no questions.',
  judge: (ctx) => {
    const ok = ctx.toolResults.some((t) => t.includes('LA1-TOKEN-9f3')) && ctx.modelTexts.some((t) => t.includes('LA1_OK'));
    return { ok, detail: ok ? 'async_run 前台正文含固定 token 且模型回执' : `toolResults 命中 ${String(ctx.toolResults.some((t) => t.includes('LA1-TOKEN-9f3')))}／回执 ${String(ctx.modelTexts.some((t) => t.includes('LA1_OK')))}` };
  }
});

console.log('\n── LA-2 后台作业＋等待领取 ──');
await driveStep({
  name: 'LA-2 后台作业经等待领取正文',
  prompt: 'Run this single step and reply with exactly the token LA2_OK: call async_run with command "Start-Sleep -Seconds 22; Write-Output LA2-TOKEN-7c1", description "la2 background", yield_ms 20000 (it will outlive the first wait and go to background); then call async_wait with wait_ms 60000 to claim its result inline; after the claim returns, reply LA2_OK. No other tools, no questions.',
  judge: (ctx) => {
    const claimed = (ctx.toolResults.some((t) => t.includes('LA2-TOKEN-7c1')) || ctx.completions.some((t) => t.includes('LA2-TOKEN-7c1')))
      && ctx.toolNames.has('async_run') && ctx.toolNames.has('async_wait');
    const ok = claimed && ctx.modelTexts.some((t) => t.includes('LA2_OK'));
    return { ok, detail: ok ? '后台作业正文经等待领取或完成消息到达（async_run＋async_wait 均在场）且模型回执' : `正文命中 ${String(claimed)}／回执 ${String(ctx.modelTexts.some((t) => t.includes('LA2_OK')))}` };
  }
});

console.log('\n── LA-3 取消与名册 ──');
await driveStep({
  name: 'LA-3 job_kill 终态＋job_list 名册（job_output 不在场）',
  prompt: 'Run this single step and reply with exactly the token LA3_OK: (1) call async_run with command "Start-Sleep -Seconds 600", description "la3 victim", yield_ms 20000 — note the job_id it returns; (2) call job_kill with that job_id; (3) call job_list and check the killed job is listed in a terminal state; (4) reply LA3_OK. Do NOT call job_output at any point. No questions.',
  judge: (ctx) => {
    const receipt = ctx.modelTexts.some((t) => t.includes('LA3_OK'));
    const killSeen = ctx.toolNames.has('job_kill') && ctx.toolNames.has('job_list');
    const outputAbsent = !ctx.toolNames.has('job_output');
    // 终态的机器证据：作业结算事件在场（模型转述不作数）；名册检查以「未出现在
    // tool/call 记录」反推——「未调用」不严格等于「不可见」，此为脚本化抽样的
    // 已知边界，离线排查靠快照。
    const settledSeen = ctx.events.has('job/settled');
    const ok = receipt && killSeen && outputAbsent && settledSeen;
    return { ok, detail: ok ? 'job_kill＋job_list 在场、job/settled 事件在案、job_output 未出现在模型名册、模型回执' : `回执 ${String(receipt)}／job_kill ${String(ctx.toolNames.has('job_kill'))}／job_list ${String(ctx.toolNames.has('job_list'))}／job_output 缺席 ${String(outputAbsent)}／job/settled ${String(settledSeen)}` };
  }
});

console.log('\n── LA-4 子代理派生与领取 ──');
await driveStep({
  name: 'LA-4 后台子代理最终回答到达',
  prompt: 'Run this single step and reply with exactly the token LA4_OK: call async_agent with description "la4 child", prompt "Reply with exactly the single token LA4-CHILD-5e8 and nothing else."; it returns an agent_id immediately; then end your turn WITHOUT waiting. When the child agent answer reaches you (as a message or in any delivery form), reply with exactly LA4_OK in your next turn. No other tools, no questions.',
  judge: (ctx) => {
    // 子代理回答只认宿主侧载体（完成消息/注入消息/工具返回）——模型文本单独
    // 命中不算到达：token 明文写在主代理指令里，模型转写即可伪造，恰会掩盖
    // 「子代理回答丢失」这一本探针要抓的缺陷。
    const childAnswer = ctx.completions.some((t) => t.includes('LA4-CHILD-5e8'))
      || ctx.injected.some((e) => e.text.includes('LA4-CHILD-5e8'))
      || ctx.toolResults.some((t) => t.includes('LA4-CHILD-5e8'));
    const ok = ctx.modelTexts.some((t) => t.includes('LA4_OK')) && childAnswer;
    return { ok, detail: ok ? '子代理回答经宿主侧载体到达且主代理回执' : `宿主侧载体命中 ${String(childAnswer)}／主代理回执 ${String(ctx.modelTexts.some((t) => t.includes('LA4_OK')))}` };
  }
});

console.log('\n── LA-5 空闲主体完成消息注入 ──');
await driveStep({
  name: 'LA-5 完成消息（JOB_RESULT_SOURCE）到达空闲主体',
  prompt: 'Run this single step: call async_run with command "Start-Sleep -Seconds 25; Write-Output LA5-TOKEN-3a7", description "la5 idle delivery", yield_ms 20000 (it goes to background); then immediately end your turn — do NOT call async_wait, do NOT reply with any token yet. When the job result reaches you later as an injected message, reply with exactly LA5_OK. No other tools, no questions.',
  judge: (ctx) => {
    const send = ctx.completions.some((t) => t.includes('LA5-TOKEN-3a7'));
    const ok = send && ctx.modelTexts.some((t) => t.includes('LA5_OK'));
    return { ok, detail: ok ? '完成消息注入含作业正文且模型回执' : `完成消息命中 ${String(send)}／回执 ${String(ctx.modelTexts.some((t) => t.includes('LA5_OK')))}` };
  }
});

// 6) 收尾：停实例→等句柄释放→留证据→清理。
killChild();
await new Promise((r) => { setTimeout(r, 1500); });
try { rmSync(home, { recursive: true, force: true }); log(`已清理临时 home：${home}`); }
catch { console.error(`[probe] WARN: 临时目录清理失败，留存现场：${home}`); }
try { rmSync(tgzPath, { force: true }); } catch { /* 产物清理尽力而为 */ }
mkdirSync(join(repo, '.local'), { recursive: true });
writeFileSync(join(repo, '.local', 'probe-live-acceptance.json'), JSON.stringify(evidence, null, 2));
log(`证据落盘：${join('.local', 'probe-live-acceptance.json')}（本机材料目录）`);
const failures = verdicts.filter((v) => v.ok !== true).length;
console.log(failures === 0 ? `\n判定：全部通过（${String(verdicts.length)} 项）` : `\n判定：${String(failures)} 项 FAIL（共 ${String(verdicts.length)} 项）`);
process.exit(failures === 0 ? 0 : 1);

function killChild() {
  if (child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
  }
}
