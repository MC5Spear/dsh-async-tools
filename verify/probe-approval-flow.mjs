/**
 * 单次审批真机探针（VERIFY-01：需求 §6.1「沙箱与单次提权」——issue-list
 * 「单次审批」行的实例证据装置）。
 *
 * ## 探针在证什么
 *
 * `async_run` 的单次提权链（需求 §6.1：单次升权先取得正常审批再接受进程
 * 启动；拒绝、非严格加宽等在进程启动前可读区分、零进程启动）。装置用
 * **探针自带的测试 answerer 插件**接宿主审批 seam 真实作答（不 mock 工具
 * 层）：answerer 按 justification 标记返回 allowed-once / rejected——审批
 * 链（插件 approveRunEscalation 预检 → 宿主 approveEscalation →
 * ApprovalService.request → approval/request waterfall → answerer）全程真实
 * 走通。三条路径：
 *
 * 1. AP-1 批准：async_run 带 sandbox_permissions='danger-full-access'＋
 *    justification 含标记 PROBE:ALLOW；命令写**工作区外**文件（会话 cwd 为
 *    临时 home，工作区外取宿主树目录下探针文件——workspace-write 档禁止、
 *    danger-full-access 档允许）并回读 token。断言：审批审计对在会话转录
 *    在场（approval/asked 的 toolName='async_run'＋callId 与本次 tool/call
 *    配对；approval/decided 同 id、outcome='allowed-once'）；作业正文经
 *    tool/result 到达；工作区外文件真实写成（获批模式只作用本次的正面
 *    证据）。
 * 2. AP-2 拒绝：同工作区外目标（另一文件名）＋标记 PROBE:REJECT。断言：
 *    工具错误文本含宿主拒绝文案（the user rejected escalating）；审计对
 *    outcome='rejected'；本窗零宿主作业注册事件（审批失败在注册之前）；
 *    **目标文件不存在**（零进程启动的直接证据：进程若跑了文件就会在）。
 * 3. AP-3 非严格加宽（同级）：sandbox_permissions='workspace-write'（与
 *    会话当前模式同级）。断言：插件预检文案（escalationSameLevel 错误）；
 *    **无审批审计对**（同级预检不走 seam）；本窗零注册；命令正文未出现。
 *
 * ## 观测与断言口径
 *
 * - 审批事件 approval/asked / approval/decided 是 log-only 审计事件（不投
 *   影为消息），但经 API session/page 的 records 原样可读（宿主 follow 与
 *   history 分页均无类型白名单）——本探针从 session/page 转录取审计对，
 *   asked→decided 按 id 配对。
 * - 正文与错误断言只认 tool/result 载体（模型文本只作回执）。
 * - answerer 必须以 { prepend: true } 注册：宿主 api-remotes 转发器在 bundle
 *   层先注册，请求入队 gateway pending 后不调 next()（无浏览器连接且无人
 *   作答时占链挂起），后注册的监听器收不到——prepend 抢到链头才能作答。
 * - 探针实例不设 DSH_PERMISSION_MODE（默认 workspace-write → 审批策略
 *   'ask'；若设 danger-full-access 会变 'never' 直接 rejected，装置前提被
 *   破坏）。
 *
 * 装置边界（如实声明）：「审批服务缺席」（seam 不组合）、「无人作答」
 * （waterfall 空转 → unavailable）与 web 默认形态（转发器占链、无浏览器时
 * 挂起）三个变体需要额外 overlay 禁用组合行，本装置不覆盖，issue-list 继
 * 追踪；「取消」（cancelled）变体不单独装置（与 rejected 同链，仅
 * outcome/文案不同）。AP-2「文件不存在」作为零进程直接证据依赖两个前提：
 * 模型如实转写命令文本（指令给出精确路径）、写操作本身不因环境原因失败
 * （目标目录为本机开发树、普通用户可写）——两前提破坏需模型改路径与插件
 * 无视拒绝两个错误叠加，装置不另行区分。审批链依赖模型依从单步指令带齐
 * 提权参数（sandbox_permissions＋justification 成对）；指令给出精确参数名
 * 与值，依从性由审计对与错误文案双向锚定（模型不带参数则 asked 缺席、断
 * 言 FAIL——保守方向）。同级预检（AP-3）由插件在委托宿主之前完成（宿主
 * 对同级免审批放行，与本包口径不同——lib/jobs.js 预检注释），故无审计事
 * 件是预期形态。FAULT 路径不清理工作区外目标文件（evidence.phases 记录路
 * 径，供手动清理；正常路径结尾自清）。
 *
 * 每步超时或断言不成立同会话重试一次（重试留痕；AP-1/AP-2 各自目标文件
 * 名含随机后缀，重试不残留歧义）。转录取证同既有探针（下标切窗、宿主侧
 * 载体）。
 *
 * ## 用法
 *
 *   node verify/probe-approval-flow.mjs --service-root <宿主服务根> \
 *     --host-subdir <宿主树目录名，如 dsh-0.2.1-rc.5> [--repo <本仓路径>] [--keep]
 *
 * `--service-root` 必填（或设 `DSAT_SERVICE_ROOT`）。实例以
 * `<serviceRoot>/patches/zai-glm.yml` 作模型路由 patch（本机部署环境提供，
 * 缺失时实例就绪等待处 FAULT）。工作区外目标写在 `<hostRoot>/` 下（本机
 * 开发树、可写、无害），探针结束自清。tgz 与临时 home 结束自清；证据 JSON
 * 每次落盘保留在 `.local/`（FAULT 路径的 tgz 与 home 不清——fail() 打印
 * home 路径，重跑前手动清理）。退出码：0＝全部判定通过；1＝存在 FAIL 判
 * 定；2＝探针自身故障（FAULT；未捕获异常也归入 2）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
  console.error(`[probe] FAULT: ${msg}\n[probe] 临时目录：${home ?? '（尚未创建）'}${keep ? '（--keep 保留）' : '（探针故障路径，请手动清理）'}${evidence?.phases?.outsideAllow !== undefined || evidence?.phases?.outsideReject !== undefined ? `（工作区外目标文件不清理，路径见 ${join('.local', 'probe-approval-flow.json')} 的 phases）` : ''}`);
  try {
    if (evidence !== null) {
      mkdirSync(join(repo, '.local'), { recursive: true });
      writeFileSync(join(repo, '.local', 'probe-approval-flow.json'), JSON.stringify({ ...evidence, fault: String(msg) }, null, 2));
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

// 2) 生成测试 answerer 插件包并打包（真实接宿主审批 seam 作答；按
//    justification 标记分流，prepend 抢在 api-remotes 转发器之前）。
home = mkdtempSync(join(tmpdir(), 'dsh-appr-'));
const answererDir = join(home, 'answerer-src');
mkdirSync(join(answererDir, 'lib'), { recursive: true });
writeFileSync(join(answererDir, 'package.json'), JSON.stringify({
  name: 'dsh-probe-approver',
  version: '0.0.1',
  description: 'Probe-only approval answerer: decides by justification marker (PROBE:ALLOW / PROBE:REJECT), delegates the rest.',
  license: 'UNLICENSED',
  private: true,
  type: 'module',
  main: 'lib/index.js',
  files: ['lib', 'cordis.patch.yml'],
  dsh: { bundle: { patch: ['./cordis.patch.yml'] } }
}, null, 2));
writeFileSync(join(answererDir, 'cordis.patch.yml'), [
  '# 探针专用审批 answerer 行（不注册任何工具、不进客户端模块图）。',
  '- insert:',
  '    - id: probe-approver',
  '      name: dsh-probe-approver',
  ''
].join('\n'));
writeFileSync(join(answererDir, 'lib', 'index.js'), [
  '/**',
  ' * 探针 answerer：监听 agent-scoped 审批 waterfall（dsh-user-approval 的',
  " * 'approval/request'），按请求 reason 中的 justification 标记作答。",
  ' *',
  " * { prepend: true } 是硬前提：宿主 api-remotes 在 bundle 层先注册且转发时",
  ' * 不调 next()（无浏览器连接时把请求挂进 gateway pending、无人作答），后注册',
  ' * 的监听器收不到——prepend 抢到链头才能作答。',
  ' */',
  "export const name = 'dsh-probe-approver';",
  'export function apply(ctx) {',
  "  ctx.on('approval/request', (req, next) => {",
  "    if (req.reason !== undefined && req.reason.includes('PROBE:ALLOW')) {",
  "      return Promise.resolve('allowed-once');",
  '    }',
  "    if (req.reason !== undefined && req.reason.includes('PROBE:REJECT')) {",
  "      return Promise.resolve('rejected');",
  '    }',
  '    return next();',
  '  }, { prepend: true });',
  '}',
  ''
].join('\n'));
const aPackRun = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', home], { cwd: answererDir, encoding: 'utf8', shell: true });
if (aPackRun.status !== 0) fail(`answerer npm pack 退出 ${String(aPackRun.status)}：${aPackRun.stderr}`);
const aTgzName = (aPackRun.stdout.match(/dsh-probe-approver-[^\s]+\.tgz/g) ?? []).pop();
if (aTgzName === undefined) fail('answerer npm pack 未产出 tgz');
const aTgzPath = join(home, aTgzName);
log(`answerer tgz=${aTgzName}`);

// 3) 独立 DSH_HOME（系统临时目录）＋ 官方 CLI 安装两个插件。
const cliBin = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
for (const [label, tgz] of [['dsh-async-tools', tgzPath], ['answerer', aTgzPath]]) {
  const addRun = spawnSync('node', [cliBin, 'plugin', '--profile', 'web', 'add', tgz], {
    cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 300_000
  });
  if (addRun.status !== 0) fail(`plugin add（${label}）退出 ${String(addRun.status)}：stderr 尾部 ${String(addRun.stderr).slice(-600)}／stdout 尾部 ${String(addRun.stdout).slice(-600)}`);
}
log('plugin add ×2 完成（受测插件＋探针 answerer）');

// 4) 起隔离实例（随机端口；不设 DSH_PERMISSION_MODE——默认 workspace-write
//    → 审批策略 'ask'，装置前提）。
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
const childEnv = { ...process.env, DSH_HOME: home };
delete childEnv.DSH_PERMISSION_MODE;
child = spawn('node', [cliBin, '--patch', join(serviceRoot, 'patches', 'zai-glm.yml'), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  cwd: serviceRoot,
  env: childEnv,
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

// 5) RPC 骨架。
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
  // 非幂等端点（session/create、session/prompt）不走自动重试——重复投递会
  // 建双会话或重复指令；幂等端点（list/page）失败重试一次。两条分支都
  // 在此解析响应（返回值统一为 {ok, value|error}）。
  const parse = async (response) => {
    const parsed = JSON.parse(await response.text());
    if (parsed?.result?.ok !== true) return { ok: false, error: parsed?.result?.error ?? null };
    return { ok: true, value: parsed.result.value };
  };
  if (endpoint === 'session/prompt' || endpoint === 'session/create') {
    return parse(await fetch(`${ORIGIN}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body,
      signal: AbortSignal.timeout(60_000)
    }));
  }
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
  return parse(response);
}
async function rpcOk(endpoint, argsBody) {
  const r = await rpc(endpoint, argsBody);
  if (r.ok !== true) fail(`${endpoint} 调用失败：${JSON.stringify(r.error).slice(0, 200)}`);
  return r.value;
}

// 6) 转录取证提取器（含 log-only 审批审计对）。
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
/** 审批审计对：approval/asked 与 approval/decided 按 id 配对（log-only，API
 *  session/page records 原样可读）。 */
function approvalPairs(transcript, fromIndex = 0) {
  const asked = new Map();
  for (const r of stepRecords(transcript, fromIndex)) {
    if (r.event?.type === 'approval/asked') asked.set(r.event.data?.id, r.event.data);
  }
  const decided = new Map();
  for (const r of stepRecords(transcript, fromIndex)) {
    if (r.event?.type === 'approval/decided') decided.set(r.event.data?.id, r.event.data);
  }
  const pairs = [];
  for (const [id, ask] of asked) {
    const decision = decided.get(id);
    if (decision !== undefined) pairs.push({ id, ask, decided: decision });
  }
  return { pairs, orphanAsked: [...asked.keys()].filter((id) => !decided.has(id)) };
}
/** 本窗内 async_run 的 tool/call id 集（审批 asked.callId 配对用）。 */
function asyncRunCallIds(transcript, fromIndex = 0) {
  const ids = new Set();
  for (const r of stepRecords(transcript, fromIndex)) {
    if (r.event?.type !== 'tool/call') continue;
    const name = r.event.data?.name;
    if (name === 'async_run') ids.add(r.event.data?.callId);
  }
  return ids;
}
/** 本窗内宿主作业注册事件数（审批失败在注册之前——零注册断言用）。 */
function jobRegisteredCount(transcript, fromIndex = 0) {
  return stepRecords(transcript, fromIndex).filter((r) => r.event?.type === 'job/registered').length;
}

// 7) 步骤驱动（单步指令＋固定回执 token；首不成重试一次）。
const STEP_TIMEOUT_MS = 300_000;
const POLL_MS = 4000;
const verdicts = [];
evidence = { head, dirty: dirty !== '', hostVersion, sessions: {}, steps: [], verdicts, phases: {} };
function judge(name, ok, detail = '') {
  verdicts.push({ name, ok: ok === true, detail: String(detail).slice(0, 600) });
  console.log(`${ok === true ? 'PASS ' : 'FAIL '} ${name}${detail === '' ? '' : `  —— ${String(detail).slice(0, 260)}`}`);
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
        toolResults: toolResultTexts(transcript, beforeCount),
        approvals: approvalPairs(transcript, beforeCount),
        runCallIds: asyncRunCallIds(transcript, beforeCount),
        jobRegistrations: jobRegisteredCount(transcript, beforeCount),
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
        toolResults: ctx.toolResults.slice(-6).map((t) => t.slice(-400)),
        approvals: ctx.approvals.pairs.map(({ ask, decided }) => ({ toolName: ask.toolName, callId: ask.callId, reason: String(ask.reason ?? '').slice(0, 200), outcome: decided.outcome })),
        orphanAsked: ctx.approvals.orphanAsked.slice(-4),
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

// 8) 三路径装置。
console.log(`\n── 单次审批链（当前候选 ${head}${dirty}）──`);
const s1 = await rpcOk('session/create', { request: { cwd: home, agentPreset: 'dsh-async' } });
if (s1.agentPreset !== 'dsh-async') { killChild(); fail(`预设回落：${String(s1.agentPreset)}`); }
evidence.sessions.main = s1.sessionId;
log(`会话=${s1.sessionId}（cwd=临时 home，工作区外目标在宿主树目录下）`);

// 工作区外目标（宿主树目录下、本机开发树可写；结尾自清）。
const outsideAllow = join(hostRoot, `probe-appr-allow-${Date.now()}.txt`);
const outsideReject = join(hostRoot, `probe-appr-reject-${Date.now()}.txt`);
evidence.phases.outsideAllow = outsideAllow;
evidence.phases.outsideReject = outsideReject;

// AP-1 批准路径。
await driveStep(s1.sessionId, {
  name: 'AP-1 批准：审计对在场＋allowed-once＋作业正文＋工作区外写生效',
  prompt: `Run this single step: call async_run with command "Set-Content -Path '${outsideAllow}' -Value 'AP1-WIDE-OK'; Get-Content '${outsideAllow}'", description "approval allow-path probe", sandbox_permissions "danger-full-access", justification "PROBE:ALLOW writing one probe file outside the workspace to verify the granted mode", yield_ms 60000. The command is quick and should finish in the foreground. When it returns, reply with exactly AP1_DONE. No other tools, no questions.`,
  timeoutMs: 300_000,
  judge: (ctx) => {
    const receipt = ctx.modelTexts.some((t) => t.includes('AP1_DONE'));
    const body = ctx.toolResults.some((t) => t.includes('AP1-WIDE-OK'));
    const pair = ctx.approvals.pairs.find(({ ask, decided }) =>
      ask.toolName === 'async_run' && ctx.runCallIds.has(ask.callId)
      && String(ask.reason ?? '').includes('PROBE:ALLOW') && decided.outcome === 'allowed-once');
    const fileWritten = existsSync(outsideAllow);
    const ok = receipt && body && pair !== undefined && fileWritten;
    return { ok, detail: ok
      ? `审批对（allowed-once，callId 与 tool/call 配对）＋正文到达＋工作区外文件写成`
      : `回执 ${String(receipt)}／正文 ${String(body)}／审计对 ${String(pair !== undefined)}／文件写成 ${String(fileWritten)}` };
  }
});

// AP-2 拒绝路径。
await driveStep(s1.sessionId, {
  name: 'AP-2 拒绝：审计对 rejected＋宿主拒绝文案＋零注册＋目标文件不存在',
  prompt: `Run this single step: call async_run with command "Set-Content -Path '${outsideReject}' -Value 'AP2-SHOULD-NOT-EXIST'", description "approval reject-path probe", sandbox_permissions "danger-full-access", justification "PROBE:REJECT writing one probe file outside the workspace to verify rejection", yield_ms 60000. Expect the call to fail with an approval rejection error — that is the wanted outcome. When the tool returns that error, reply with exactly AP2_DONE. No other tools, no questions.`,
  timeoutMs: 300_000,
  judge: (ctx) => {
    const receipt = ctx.modelTexts.some((t) => t.includes('AP2_DONE'));
    const denied = ctx.toolResults.some((t) => /the user rejected escalating|rejected escalating this command/.test(t));
    const pair = ctx.approvals.pairs.find(({ ask, decided }) =>
      ask.toolName === 'async_run' && ctx.runCallIds.has(ask.callId)
      && String(ask.reason ?? '').includes('PROBE:REJECT') && decided.outcome === 'rejected');
    const fileAbsent = !existsSync(outsideReject);
    // 零注册断言：审批失败在 startForegroundJob 之前——本窗宿主作业注册
    // 事件应为零（文件缺席是零进程的直接证据；注册事件是零注册的转录证据）。
    const zeroRegistered = ctx.jobRegistrations === 0;
    const ok = receipt && denied && pair !== undefined && fileAbsent && zeroRegistered;
    return { ok, detail: ok
      ? `审批对（rejected，callId 配对）＋宿主拒绝文案到达＋目标文件不存在（零进程）＋零注册`
      : `回执 ${String(receipt)}／拒绝文案 ${String(denied)}／审计对 ${String(pair !== undefined)}／文件不存在 ${String(fileAbsent)}／零注册 ${String(zeroRegistered)}（注册 ${String(ctx.jobRegistrations)}）` };
  }
});

// AP-3 同级（非严格加宽）预检路径。
await driveStep(s1.sessionId, {
  name: 'AP-3 同级预检：插件文案＋零审计对＋零注册',
  prompt: `Run this single step: call async_run with command "Write-Output AP3-SHOULD-NOT-RUN", description "same-level escalation probe", sandbox_permissions "workspace-write", justification "PROBE:ALLOW same-level request that must be refused before approval", yield_ms 60000. Expect the call to fail with a same-level / not-a-widening error — that is the wanted outcome. When the tool returns that error, reply with exactly AP3_DONE. No other tools, no questions.`,
  timeoutMs: 300_000,
  judge: (ctx) => {
    const receipt = ctx.modelTexts.some((t) => t.includes('AP3_DONE'));
    const refused = ctx.toolResults.some((t) => /not a widening request|不是加宽请求|equals this call's current sandbox mode|与本次调用的当前沙箱模式相同/.test(t));
    const noApproval = ctx.approvals.pairs.length === 0 && ctx.approvals.orphanAsked.length === 0;
    const bodyAbsent = !ctx.toolResults.some((t) => t.includes('AP3-SHOULD-NOT-RUN'));
    const zeroRegistered = ctx.jobRegistrations === 0;
    const ok = receipt && refused && noApproval && bodyAbsent && zeroRegistered;
    return { ok, detail: ok
      ? `同级预检文案到达＋无审批审计（预检在 seam 之前）＋命令正文未出现（零进程）＋零注册`
      : `回执 ${String(receipt)}／预检文案 ${String(refused)}／零审计 ${String(noApproval)}／正文未出现 ${String(bodyAbsent)}／零注册 ${String(zeroRegistered)}（注册 ${String(ctx.jobRegistrations)}）` };
  }
});

// 9) 收尾。
function finishRun() {
  try { rmSync(tgzPath, { force: true }); } catch { /* 产物清理尽力而为 */ }
  for (const target of [outsideAllow, outsideReject]) {
    try { if (existsSync(target)) rmSync(target, { force: true }); } catch { /* 工作区外目标清理尽力而为 */ }
  }
  mkdirSync(join(repo, '.local'), { recursive: true });
  writeFileSync(join(repo, '.local', 'probe-approval-flow.json'), JSON.stringify(evidence, null, 2));
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
log(`证据落盘：${join('.local', 'probe-approval-flow.json')}（本机材料目录）`);
finishRun();
