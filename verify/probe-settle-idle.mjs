/**
 * 结算时序与空闲恢复真机探针（VERIFY-01：问题清单 L33 两项行为缺口的实例层
 * 装置——「结算通知与注册表状态滞后的自然时序」与「主体最后领取后进入空闲的
 * 完成消息恢复路径」；需求 9.3.3、9.3.2 与设计 §3.2.4 复核段、§2.6 完成消息
 * 通道）。
 *
 * ## 探针在证什么
 *
 * 套件层（wait-delivery 等 744 用例）已用受控替身锚定各出口逻辑；本探针在
 * 真实实例上以真实模型会话取证两组自然时序问题，判据只认宿主侧载体（工具
 * 返回文本、转录事件与 at 时间戳、消息投影、session/list running 采样），
 * 模型文本只作回执：
 *
 * - SG 系列（settle gate）：挂起中的等待收到子代理结算通知时，插件同步现读
 *   注册表复核（WAIT-SETTLE-GATE-01）。SG-1/SG-2 取 6 次自然结算的分档记录
 *   （即时／滞后／消息唤醒／无前缀 via 行／入口等九档，判定表首条命中定档），
 *   硬性不变量（无据新停止断言、不同时宣称结算与运行、滞后交付不早于停止
 *   证据且 lag-settled 距证据 ≤10s、即时档提前交回、通知不被吞）任一违反即
 *   FAIL；汇总不预设方向——滞后未自然出现就如实登记未出现。SG-3 补入口变体
 *   （通知先到、等待后发，含 wait.settleNoticeArrived 入口滞后档）。
 * - IR 系列（idle recovery）：忙碌且无活等待的回合内结算时完成消息的领取
 *   路径——忙碌窗内 inject（宿主同回合补步领取）／空闲后 followup（LA-5 的
 *   次序版）／滞留形态（转 IR-5：中性 queue 唤醒后恢复恰一次）。领取的结构性
 *   主锚是移除计数的 agent/inbox/spliced（target 记录 next-step／next-turn——
 *   claimed 事件不进转录；followup 落 next-turn、inject 落 next-step），
 *   回执 token 写在指令里、模型可凭记忆应答，只作旁证。
 *
 * 注册表无直接 RPC 读：通知时刻注册表是否已翻转，以插件自身可见行为（返回
 * 文案类别＋返回与通知记录的次序）为据，推证边界如实写进结论，不冒称直读。
 * 子会话最后一条 assistant 消息的 at（child_last_at）经子会话转录寻址补充
 * （acceptance-017 的 pageChild 先例），与父会话记录同源宿主时钟、跨会话
 * 差值只作记录不作硬性断言。
 *
 * 时间判据优先转录 at（ISO 与 epoch 双形态解析；缺失或负差回退轮询墙钟，
 * ± 一个轮询间隔 4s）。每步（试次）超时或断言不成立同会话重试一次、重试
 * 留痕；IR-5 条件步单尝试（观察窗不可重复）。作业命令依赖 PowerShell
 * （Start-Sleep）——非 PowerShell 宿主上按 token 缺席 FAIL 取证（非 FAULT）。
 * 装置不改插件或宿主行为：无设置前提（各步时长均大于 minYieldMs 出厂默认
 * 20000）、不注入人为延迟，自然时序＝结算与翻转按宿主自身次序发生、装置
 * 只观察。
 *
 * ## 用法
 *
 *   node verify/probe-settle-idle.mjs --service-root <宿主服务根> \
 *     --host-subdir <宿主树目录名，如 dsh-0.2.1-rc.5> [--repo <本仓路径>] [--keep]
 *
 * `--service-root` 必填（或设 `DSAT_SERVICE_ROOT`）。探针以
 * `<serviceRoot>/patches/zai-glm.yml` 作为实例模型路由 patch——该文件由本机
 * 部署环境提供，缺失时实例在就绪等待处 FAULT（90s 超时＋stderr 尾部），请
 * 自备同位 patch 或改参。tgz 产物结束自清；证据 JSON 每次落盘保留在
 * `.local/probe-settle-idle.json`（FAULT 路径尽力落盘部分证据；FAULT 路径的
 * tgz 不清，重跑前可手动清理）。退出码：0＝全部判定通过；1＝存在 FAIL 判定；
 * 2＝探针自身故障（FAULT）。
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
      writeFileSync(join(repo, '.local', 'probe-settle-idle.json'), JSON.stringify({ ...evidence, fault: String(msg) }, null, 2));
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
home = mkdtempSync(join(tmpdir(), 'dsh-settle-idle-'));
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

// 5) 会话前置（会话可用性判据步：服务端业务拒绝＝FAIL，装载与 RPC 基础设
//    施失败仍归 FAULT——rpc 的服务端错误体以「session/create:」前缀区分于
//    网络层异常）。会话策略＝**按系列分会话**（SG-1/2 挂起系列、SG-3、IR
//    各一个——真机实证（F6）：单长会话停摆会把其后所有步骤烧穿超时、放大
//    成全局失效，分会话隔离爆炸半径；每个会话创建时复验 dsh-async 预设，
//    仅首个计入 SG-0 判定项，后续系列回落只登记）。
const verdicts = [];
evidence = { head, dirty: dirty !== '', hostVersion, sessionId: null, sessions: [], steps: [], sgAggregate: null, irAggregate: null, verdicts };
function judge(name, ok, detail = '') {
  verdicts.push({ name, ok: ok === true, detail: String(detail).slice(0, 400) });
  console.log(`${ok === true ? 'PASS ' : 'FAIL '} ${name}${detail === '' ? '' : `  —— ${String(detail).slice(0, 240)}`}`);
}
let SESSION = null;
let firstSessionDone = false;
async function createSeriesSession(label) {
  let created;
  try {
    created = await rpc('session/create', { request: { cwd: home, agentPreset: 'dsh-async' } });
  } catch (error) {
    const message = String(error?.message ?? error);
    killChild();
    if (message.startsWith('session/create:') && firstSessionDone) {
      // 首会话已证明可用；后续系列会话的创建请求被服务端拒绝（返回体带
      // session/create: 前缀）——归基础设施异常（FAULT）。
      fail(`后续系列会话创建被服务端拒绝（${label}）：${message}`);
    }
    if (!firstSessionDone) {
      judge('SG-0 会话创建（dsh-async 预设）', false, `服务端业务拒绝：${message}`);
      await finish(1);
    }
    fail(`session/create 无法送达或网关错误：${message}`);
  }
  SESSION = created.sessionId;
  lastBaselineShared.value = 0;
  evidence.sessions.push({ label, sessionId: SESSION, agentPreset: String(created.agentPreset ?? '') });
  if (!firstSessionDone) {
    firstSessionDone = true;
    evidence.sessionId = SESSION;
    if (created.agentPreset !== 'dsh-async') {
      judge('SG-0 会话创建（dsh-async 预设）', false, `预设回落：${String(created.agentPreset)}`);
      await finish(1);
    }
    judge('SG-0 会话创建（dsh-async 预设）', true, `sessionId=${SESSION}`);
    log(`会话已建（${label}，sessionId=${SESSION}）`);
    return SESSION;
  }
  if (created.agentPreset !== 'dsh-async') {
    log(`系列会话（${label}）预设回落：${String(created.agentPreset)}（登记，不计新判定项）`);
  }
  log(`系列会话已建（${label}，sessionId=${SESSION}）`);
  return SESSION;
}

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
/** session/list 的本会话行（running 投影供 IR 时间线采样）。 */
async function sessionRow() {
  const listing = await rpc('session/list', { _request: {} });
  const row = listing.items.find((item) => item.sessionId === SESSION);
  if (row === undefined) throw new Error('session not found');
  return row;
}
async function transcriptOf() {
  const row = await sessionRow();
  return rpc('session/page', {
    request: { address: { kind: 'session', sessionId: SESSION }, throughSeq: row.projections.asOfSeq, maxMessages: 1200 }
  });
}
/**
 * 读一个**子会话**的转录页（acceptance-017 的 pageChild 先例）：子会话不在
 * session/list、必须以 {kind:'subagent', parentSessionId, childSessionId, mode}
 * 寻址，游标走 session/projections 取子会话自己的 asOfSeq。
 */
async function pageChild(childSessionId, mode = 'unknown') {
  const projections = await rpc('session/projections', { request: { sessionId: childSessionId } });
  const asOfSeq = projections?.value?.asOfSeq ?? projections?.asOfSeq ?? -1;
  return rpc('session/page', {
    request: {
      address: { kind: 'subagent', parentSessionId: SESSION, childSessionId, mode },
      throughSeq: asOfSeq,
      maxMessages: 200
    }
  });
}
function atOf(record) {
  // F5：session/page 记录不携带 at（真机实证全 null，WS 证据 waitSpan null
  // 同证）——保留解析仅为兼容潜在携带 at 的宿主形态，时序判据一律用记录
  // 下标（次序）与首见墙钟（毫秒差），不依赖本函数的返回。
  const raw = record.at ?? record.event?.at ?? null;
  if (raw === null) return null;
  // at 可能是 ISO 字符串，也可能是 epoch 毫秒数字（或数字串）——两种都收。
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(numeric) && numeric > 1e12) return numeric;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}
/** 步骤窗口：转录 append-only、seq 可能缺席，按数组下标切「本步新增」。 */
function stepRecords(transcript, fromIndex) {
  return (transcript.records ?? []).slice(fromIndex);
}
function modelTexts(transcript, fromIndex = 0) {
  return stepRecords(transcript, fromIndex)
    .filter((r) => r.event?.type === 'assistant/message' || r.event?.type === 'model/message')
    .map((r) => ({ idx: fromIndex + stepRecords(transcript, fromIndex).indexOf(r), at: atOf(r), text: (r.event.data?.message?.content ?? r.event.data?.content ?? [])
      .map((c) => String(c.text ?? '')).join('\n') }));
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
/** 窗口内各工具的调用次数（记录级直数——并行重复调用也计入；「次数恰 1」
 *  断言以此为准，pairCalls 的配对只用于取正文与时间，不用于计数）。 */
function toolCallCounts(transcript, fromIndex = 0) {
  const counts = new Map();
  for (const r of stepRecords(transcript, fromIndex)) {
    if (r.event?.type !== 'tool/call') continue;
    const name = r.event.data?.name ?? r.event.data?.toolName ?? r.event.data?.message?.name;
    if (typeof name === 'string') counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}
/**
 * 领取锚组收集（F2 修订：claim 的 splice 先于其领取的消息记录写入，但二者
 * **不相邻**——真机实证步边界形态＝[splice][step/start][user/message]、回
 * 合边界同款且同批多消息间无 splice 间隔；「相邻连续」扫描会恒漏检）。
 * 规则：从目标消息记录向前回走——未命中 splice 前跳过步／回合机器记录与
 * 同批兄弟消息（user/message、system/message、step/start、turn/start、
 * session/*、request/*）；命中后只收集相邻 splice 串（组）；遇内容／生命
 * 周期记录（tool/call、tool/result、assistant/message、job/*、step/end、
 * turn/end 等）或下界即停。兄弟 user 消息可安全跳过的依据：claim 必先写
 * splice 再附消息（F2），claimed 消息与更早步的指令消息之间必有 splice 或
 * tool/call／tool/result 等内容记录隔断（实证步内领取形态 [step/start]
 * [指令 user][tool/call][tool/result][splice][claimed user]——遇 tool/result
 * 即停、不会误入指令区）。**组＝相邻串，不跨边界记录收集**：回合边界形态
 * [splice][turn/start][splice][step/start][messages] 的两个 splice 可能分属
 * 两次 claim（回合开启清空 vs 步领取），跨边界合并会污染组——判别式两种
 * 形态下均不受影响（followup 判组内含 next-turn、inject 形态单 splice），
 * 落档口径＝「相邻串（回合边界形态下组可能只含尾 splice）」。job/* 归停
 * 列：若宿主未来在 splice 与消息间插入投影事件会漏检（FAIL 取证方向、非
 * 假 PASS）——每轮 windowShape 顺带复核该形态。返回 {spliceIdx（最近前
 * 邻）、target、targets（相邻串，时间升序）}。
 */
function claimGroupBefore(win, fromIdx, lowerBoundIdx = -1) {
  const type = (r) => String(r.event?.type ?? '');
  const isSplice = (r) => r.event?.type === 'agent/inbox/spliced' && (r.event.data?.removedCount ?? 0) > 0;
  const isMachinery = (r) => ['user/message', 'system/message', 'step/start', 'turn/start'].includes(type(r))
    || type(r).startsWith('session/') || type(r).startsWith('request/');
  const targets = [];
  let spliceIdx = -1;
  let target = '';
  let foundSplice = false;
  for (let i = fromIdx - 1; i >= 0 && i > lowerBoundIdx; i -= 1) {
    const r = win[i];
    if (isSplice(r)) {
      if (!foundSplice) {
        spliceIdx = i;
        target = String(r.event.data?.target ?? '');
        foundSplice = true;
      }
      targets.unshift(String(r.event.data?.target ?? ''));
      continue;
    }
    if (foundSplice) break;
    if (isMachinery(r)) continue;
    break;
  }
  return { spliceIdx, target, targets };
}

/**
 * 工具调用配对（装置假设模型按指令串行单工具调用——各步指令均要求；违规
 * 并行时配对可能失准，误差方向是假 FAIL（重试自愈）而非假 PASS）：窗口内
 * 每个 tool/call 配其后首个 tool/result，返回 {name, callIdx, callAt,
 * resultIdx, resultAt, resultText}（无结果时 resultIdx/resultAt 为 null）。
 */
function pairCalls(transcript, fromIndex = 0) {
  const records = stepRecords(transcript, fromIndex);
  const out = [];
  let open = null;
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    if (r.event?.type === 'tool/call') {
      if (open === null) {
        open = {
          name: r.event.data?.name ?? r.event.data?.toolName ?? r.event.data?.message?.name,
          callIdx: i, callAt: atOf(r), resultIdx: null, resultAt: null, resultText: ''
        };
      }
    } else if (r.event?.type === 'tool/result' && open !== null) {
      const content = r.event.data?.message?.content ?? [];
      open.resultText = content.filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('\n');
      open.resultIdx = i;
      open.resultAt = atOf(r);
      out.push(open);
      open = null;
    }
  }
  if (open !== null) out.push(open);
  return out;
}
/** user/message 记录条目（含 source 与正文）：探针自身指令以正文标记排除。 */
function injectedEntries(transcript, fromIndex = 0) {
  return stepRecords(transcript, fromIndex)
    .filter((r) => r.event?.type === 'user/message')
    .map((r) => {
      const message = r.event.data?.message ?? r.event.data;
      const source = message?.source ?? {};
      return {
        idx: fromIndex + stepRecords(transcript, fromIndex).indexOf(r),
        record: r,
        sourceKind: String(source.kind ?? ''),
        sourceForm: String(source.form ?? ''),
        senderSessionId: source.senderSessionId,
        at: atOf(r),
        text: (message?.content ?? []).map((c) => String(c.text ?? '')).join('\n')
      };
    });
}
/** 窗口内最后一个 subagent/catalog 事件（取 childId 与 mode，供子会话寻址）。 */
function catalogLast(transcript, fromIndex = 0) {
  const events = stepRecords(transcript, fromIndex).filter((r) => r.event?.type === 'subagent/catalog');
  return events.length > 0 ? events.at(-1).event.data : null;
}
/** 子代理最终回答的**投递载体**分 kind 计数（宿主源码＋真机双证）：结算通知
 *  正文内嵌最终回答全文（dsh-subagent createSettlementMessage——「Its closing
 *  message:」段），是**全量投递载体**、恒在场；agent-message 转达只在子代理
 *  主动调 send_message 时在场（宿主回传指引与探针指令竞争，缺席是合法形态
 *  ——真机实证：子代理服从探针「No other tools」时 relayCount=0、回答仅由
 *  通知承载）。判「恰一次」＝两载体各 ≤1 且至少一者在场；async_wait 返回
 *  内嵌的消息摘要（wait.targetMessage ｛summary｝）是通知引用、不计（需求
 *  9.3.2「同一最终结果只出现一次」约束的是投递）。WS-6 双载体同场先例：
 *  .local/probe-wait-semantics.json L178-187。 */
function deliveryTokenCounts(transcript, token, fromIndex = 0) {
  let relay = 0;
  let notice = 0;
  for (const entry of injectedEntries(transcript, fromIndex)) {
    if (entry.sourceKind === 'agent-message') relay += entry.text.split(token).length - 1;
    else if (entry.sourceKind === 'subagent-settled') notice += entry.text.split(token).length - 1;
  }
  return { relay, notice };
}
/** 子代理 token 在用户侧载体的出现次数（结算通知正文／agent 消息／工具返回
 *  并集；探针自身指令正文含 token——按「Run this single step」标记排除，
 *  模型转写不在此载体集内）。 */
function userSideTokenCount(transcript, token, fromIndex = 0) {
  let count = 0;
  for (const entry of injectedEntries(transcript, fromIndex)) {
    if (entry.sourceKind === '' || entry.sourceKind === 'user') continue;
    if (entry.text.includes('Run this single step')) continue;
    count += entry.text.split(token).length - 1;
  }
  for (const text of toolResultTexts(transcript, fromIndex)) {
    count += text.split(token).length - 1;
  }
  return count;
}

// 6) SG 分档判定表（C5：按下列次序首条命中定档——优先级消解共现歧义）。
//    锚句取 lib/text.js 两语词典原文的完整短语（措辞改动即红，按 FAIL 取证归因）。
const ANCHORS = {
  noteSettled: [/不再被观察到在运行/, /is no longer observed running/],
  viaIdle: [/状态转为 idle/, /status turned idle/],
  viaNoResident: [/已不在代理注册表驻留/, /no longer resident in the agent registry/],
  prefixSeen: [/该子代理的结算通知此前已见；/, /had already been received; /],
  noticePreexisting: [/在等待开始前就已收到该子代理的结算通知/, /had already arrived before the wait started/],
  targetMessage: [/目标子代理发来一条消息/, /A message from target subagent/],
  arrived: [/静止尚未证实（注册表仍观察到运行或读取失败）/, /not confirmed to have stopped \(the registry still reads running or the read failed\)/],
  pending: [/至本次返回其静止仍未证实/, /stillness remained unconfirmed until this return/],
  budget: [/等待预算到期（已等待 \d+ ms），目标条件未满足|等待预算到期（已等待 \d+ ms），无可处理消息/, /wait budget expired after \d+ ms with no target condition met|wait budget expired after \d+ ms with no processable message/],
  interrupted: [/等待被打断|等待未开始：一条用户消息/, /Wait interrupted|Wait not started/],
  cancelled: [/被取消/, /was cancelled/],
  targetsSettled: [/维持上次报告的停止态/, /remain settled as last reported/],
  unconfirmed: [/目标资格未证实/, /target eligibility is unconfirmed/]
};
const hit = (key, text) => ANCHORS[key].some((re) => re.test(text));
function classifyWaitReturn(text) {
  const f = {
    noteSettled: hit('noteSettled', text),
    viaIdle: hit('viaIdle', text),
    viaNoResident: hit('viaNoResident', text),
    prefixSeen: hit('prefixSeen', text),
    noticePreexisting: hit('noticePreexisting', text),
    targetMessage: hit('targetMessage', text),
    arrived: hit('arrived', text),
    pending: hit('pending', text),
    budget: hit('budget', text),
    interrupted: hit('interrupted', text),
    cancelled: hit('cancelled', text),
    targetsSettled: hit('targetsSettled', text),
    unconfirmed: hit('unconfirmed', text)
  };
  f.viaRow = f.viaIdle || f.viaNoResident;
  let cls;
  if (f.prefixSeen) cls = 'lag-settled';
  else if (f.arrived) cls = 'entry-lag';
  else if (f.targetMessage && f.viaRow) cls = 'message-wake-confirm';
  else if (f.targetMessage) cls = 'lag-changed';
  else if (f.viaRow && f.noteSettled) cls = 'settled-via-observed';
  else if (f.noteSettled) cls = 'immediate';
  else if (f.pending) cls = 'budget-interrupt-pending';
  else if (f.budget || f.interrupted || f.cancelled) cls = 'budget-interrupt-plain';
  else cls = 'other';
  return { cls, flags: f };
}
/**
 * C5 硬性不变量（与分档正交，任一违反即该试次 FAIL）：
 * 1) 无据新停止断言——对停止作新断言却三类依据（note.settled／任一 via 行／
 *    前缀）全无（targetsSettled 形按最近报告转述、不作新断言，白名单放行）；
 * 2) 同报结算与运行——同一次返回同时含 settled 措辞与未证实附注（单目标
 *    试次不应出现，出现即记录复核）；
 * 3) 滞后交付不早于停止证据——lag-settled 且通知先于返回时断言
 *    result_at ≥ notice_at（容差 −2s）且差 ≤10s（pollIntervalMs 500ms 的
 *    「至多一个轮询周期」口径＋事件周转容差；超限不静默 PASS，指向滞后拖
 *    长的实例发现）；order=result-before-notice 时停止证据可由 agent/status
 *    转闲事件先行触发（无通知记录），下界与上界均不适用；lag-changed／
 *    entry-lag 仅 order=notice-before-result 的试次断言下界（该两档的唤醒
 *    证据是目标消息而非结算通知，通知晚于返回同理合法；返回发生在证据
 *    时刻、翻转尚未证实，不设上界）；immediate 档 span < 150s（提前交回）、
 *    次序两序都合法只记录。
 */
function sgInvariants(cls, flags, text, noticeIdx, resultIdx, noticeSeenAt, resultSeenAt, spanMs) {
  const problems = [];
  // 白名单说明：除设计明列的 targetsSettled（按最近报告转述、不作新断言）外，
  // arrived／pending／budget／interrupted／cancelled／unconfirmed／targetMessage
  // 均为「不作停止断言」的已知出口组成——红线只针对「对停止作新断言却无依据」
  // 的文本，上述出口措辞的出现不构成停止断言，排除以避免已知出口误触红线。
  if (!flags.noteSettled && !flags.viaRow && !flags.prefixSeen && !flags.targetsSettled
    && !flags.arrived && !flags.pending && !flags.budget && !flags.unconfirmed && !flags.targetMessage
    && !flags.interrupted && !flags.cancelled
    && /不再被观察到在运行|no longer observed running|已停止|has stopped|已完成并停止/.test(text)) {
    problems.push('无据新停止断言：出现停止措辞但三类依据全无，且不属已知出口');
  }
  if (flags.noteSettled && flags.pending) problems.push('同报结算与运行：settled 措辞与「静止仍未证实」附注共现（单目标试次不应出现，登记复核）');
  // 不变量 2 全量形态（盲审补）：settled 措辞（note.settled 前缀或 via 行）
  // 与任何「未证实／仍观察到运行」类附注（pending／arrived 锚）共现即矛盾
  // 文本——互斥分档不应静默放行。
  if ((flags.viaRow) && (flags.pending || flags.arrived)) problems.push('同报结算与运行：via 行与「静止未证实／仍观察到运行」附注共现（登记复核）');
  if (flags.noteSettled && flags.arrived) problems.push('同报结算与运行：settled 措辞与「静止尚未证实（注册表仍观察到运行）」共现（登记复核）');
  // 次序以记录下标判定（F5：session/page 记录不携带 at——真机实证全字段
  // null，WS 证据 waitSpan null 同证；下标次序不受观察粒度影响）；毫秒差用
  // 首见墙钟、粒度 ≤2×POLL_MS（4s），容差按下界 −6s／上界 14s 换算（原
  // 设计 −2s/10s 加观察粒度——见 §3 C5 不变量 3）。
  const order = noticeIdx === null ? 'na' : (noticeIdx <= resultIdx ? 'notice-before-result' : 'result-before-notice');
  if (cls === 'lag-settled' && order === 'notice-before-result' && noticeSeenAt !== null && resultSeenAt !== null) {
    const delta = resultSeenAt - noticeSeenAt;
    if (delta > 14_000) problems.push(`滞后交付距证据 ${String(delta)}ms 超过 14s 上界（首见墙钟粒度 4s 换算；滞后拖长实例发现，复现即转问题清单）`);
    if (delta < -6000) problems.push('返回早于通知记录超过 6s 容差（首见墙钟粒度换算）');
  }
  if ((cls === 'lag-changed' || cls === 'entry-lag') && order === 'notice-before-result' && noticeSeenAt !== null && resultSeenAt !== null && resultSeenAt - noticeSeenAt < -6000) {
    problems.push('changed 交回早于通知记录超过 6s 容差（首见墙钟粒度换算）');
  }
  if (cls === 'immediate' && spanMs !== null && spanMs >= 150_000) problems.push('即时档 span ≥ 150s（应提前交回）');
  return { problems, order };
}

const POLL_MS = 2000;
const sgTrials = [];
const irTrials = [];
let lingerTrial = null;
let sgStepsRun = 0;
// 步骤基线（跨步内部状态）：拉取失败时沿用上一成功基线（WS 同款），避免
// 偶发 RPC 失败把窗口归零、历史记录涌入本步窗口造成假 FAIL。系列会话切换
// 时归零（新会话转录从空开始）。
const lastBaselineShared = { value: 0 };
/** 记录**首见墙钟**（F5：记录不携带 at——毫秒差与 span 的唯一时源；次序另
 *  以记录下标直判，不受粒度影响。键含 SESSION：按系列分会话后各会话下标
 *  独立；粒度 ≤POLL_MS×2＝4s，证据与判据容差按此换算）。 */
const firstSeenAt = new Map();
function stampNew(transcript) {
  const records = transcript.records ?? [];
  const now = Date.now();
  for (let i = 0; i < records.length; i += 1) {
    const key = `${SESSION}:${String(i)}`;
    if (!firstSeenAt.has(key)) firstSeenAt.set(key, now);
  }
}
const seenOf = (absIdx) => firstSeenAt.get(`${SESSION}:${String(absIdx)}`) ?? null;
/** 系列级停摆重试标记（F6：停摆后该系列最多换一次新会话重试）。 */
const seriesRolled = new Set();
async function currentBaseline() {
  try {
    const transcript = await transcriptOf();
    const n = transcript.records?.length ?? 0;
    lastBaselineShared.value = n;
    return n;
  } catch {
    return lastBaselineShared.value;
  }
}

// 7) SG 试次驱动（SG-1／SG-2 共用；重试一次，重试即新子代理——token 按
//    attempt 后缀重生成，旧尝试残留的最终消息不会污染新窗口的恰一次断言）。
function sgTrialPrompt(t, childToken) {
  const childPrompt = `First run this exact PowerShell command: Start-Sleep -Seconds ${String(t.durS)}; Write-Output CHILD-STEP. Then reply with exactly the single token ${childToken} and nothing else. No other tools, no questions.`;
  return `Run this single step and reply with exactly the token ${t.receipt}: (1) call async_agent with description "sg1 child" and prompt "${childPrompt}"; it returns an agent_id immediately. (2) immediately call async_wait with targets [{"kind":"agent","id":"<the agent_id from step 1>"}] and wait_ms ${String(t.budgetMs)} — wait inline until it returns. (3) reply with exactly ${t.receipt}. No other tools, no questions.`;
}
async function driveSgTrial(t) {
  const record = { name: t.name, attempts: [] };
  evidence.steps.push(record);
  sgStepsRun += 1;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const beforeCount = await currentBaseline();
    const childToken = `${t.childToken}-A${String(attempt)}`;
    try {
      await prompt(sgTrialPrompt(t, childToken));
    } catch (error) {
      killChild();
      fail(`session/prompt 调用失败：${String(error?.message ?? error)}`);
    }
    const deadline = Date.now() + (t.durS + 240) * 1000;
    let lastDetail = '（无判定输出）';
    let stalled = false;
    let lastCount = -1;
    let lastChangeAt = Date.now();
    while (Date.now() < deadline) {
      await new Promise((r) => { setTimeout(r, POLL_MS); });
      if (child.exitCode !== null) { killChild(); fail('实例在步骤中途退出'); }
      let transcript;
      try { transcript = await transcriptOf(); } catch { continue; }
      stampNew(transcript);
      // 停摆防护（F6：真机实证模型路由可能停产出——烧穿全超时无增量证据；
      // 合法最长静默＝子代理时长（≤50s）＋首延迟，180s 阈值不误伤）。
      const count = transcript.records?.length ?? 0;
      if (count !== lastCount) {
        lastCount = count;
        lastChangeAt = Date.now();
      } else if (Date.now() - lastChangeAt >= 180_000) {
        // running 为真（模型生成／等待中）不算停摆——重置计时；读取失败按
        // 运行中处理（不触发停摆，方向是少杀不误杀）。文案附前次判定、不
        // 覆盖最后断言状态（三驱动统一口径）。
        let runningNow = true;
        try { runningNow = (await sessionRow()).running === true; } catch { /* 保持 true */ }
        if (runningNow !== true) {
          stalled = true;
          lastDetail = `停摆（180s 无新记录且非运行；末次记录计数 ${String(lastCount)}；前次判定：${lastDetail}）`;
          break;
        }
        lastChangeAt = Date.now();
      }
      const win = stepRecords(transcript, beforeCount);
      const winPage = { records: win };
      const calls = pairCalls(winPage);
      const waitCalls = calls.filter((c) => c.name === 'async_wait' && c.resultIdx !== null);
      const receipt = modelTexts(winPage).some((m) => m.text.includes(t.receipt));
      if (waitCalls.length === 0 || !receipt) {
        continue;
      }
      const wc = waitCalls.at(-1);
      // —— 断言 1：async_agent 调用与 agent_id、subagent/catalog。
      const agentCalls = calls.filter((c) => c.name === 'async_agent' && c.resultIdx !== null);
      const agentIdMatch = agentCalls.length > 0 ? (agentCalls.at(-1).resultText.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) ?? []) : [];
      const agentId = agentIdMatch[1] ?? null;
      const catalog = catalogLast(winPage);
      const a1 = agentCalls.length >= 1 && agentId !== null && catalog !== null && String(catalog.childId ?? '') === agentId;
      // —— 断言 2：async_wait **到场 ≥1 次**（F4：真实模型在首个等待返回后
      // 补等合法——结算返回说明最终回答仍将作为独立消息到达，SG-2 实测
      // async_wait×2；计数与各次返回类别全列表落档 waitCalls）、每个已完成
      // 等待提前交回（首见墙钟 span < 150s）。
      const waitAll = calls.filter((c) => c.name === 'async_wait');
      const waitDone = waitAll.filter((c) => c.resultIdx !== null);
      const spanOf = (c) => {
        const s0 = seenOf(beforeCount + c.callIdx);
        const s1 = seenOf(beforeCount + c.resultIdx);
        return s0 !== null && s1 !== null && s1 >= s0 ? s1 - s0 : null;
      };
      const spansAll = waitDone.map(spanOf);
      const span = spansAll.at(-1) ?? null;
      const a2 = waitDone.length >= 1 && spansAll.every((s) => s !== null && s < 150_000);
      // —— 断言 3：结算通知在场（senderSessionId 与 agent_id 对上；缺席记录不 FAIL）。
      const entries = injectedEntries(winPage);
      const notices = entries.filter((e) => e.sourceKind === 'subagent-settled'
        && (e.senderSessionId === undefined || e.senderSessionId === null || e.senderSessionId === agentId));
      const notice = notices.length > 0 ? notices[0] : null;
      const noticeBad = entries.some((e) => e.sourceKind === 'subagent-settled' && e.senderSessionId != null && agentId !== null && e.senderSessionId !== agentId);
      const a3 = notice !== null;
      // —— 断言 4：返回文本可分类（含 other 档）＋硬性不变量（次序＝记录
      // 下标，毫秒差＝首见墙钟——F5 口径。**下标基统一为会话绝对下标**：
      // notice.idx 等注入条目下标在 winPage 视图下是窗口相对值，与
      // callAbsIdx/resultAbsIdx、seenOf 键域（绝对）比较前一律 +beforeCount）。
      const { cls, flags } = classifyWaitReturn(wc.resultText);
      const callAbsIdx = beforeCount + wc.callIdx;
      const resultAbsIdx = beforeCount + wc.resultIdx;
      const noticeAbsIdx = notice !== null ? beforeCount + notice.idx : null;
      const { problems, order } = sgInvariants(cls, flags, wc.resultText, noticeAbsIdx, resultAbsIdx, notice !== null ? seenOf(noticeAbsIdx) : null, seenOf(resultAbsIdx), span);
      const a4 = problems.length === 0;
      // —— 断言 5：子代理最终回答经投递载体到场恰一次——转达（agent-message）
      // 与结算通知 closing text（全量载体、恒在场）各 ≤1、至少一者在场；wait
      // 返回内嵌摘要属通知引用、不计。
      const tokenCounts = deliveryTokenCounts(winPage, childToken);
      const a5 = tokenCounts.relay <= 1 && tokenCounts.notice <= 1 && (tokenCounts.relay + tokenCounts.notice) >= 1;
      const noticeBeforeWait = notice !== null && noticeAbsIdx < callAbsIdx;
      const detail = `class=${cls}${cls === 'settled-via-observed' ? `（subform=${noticeBeforeWait ? 'entry-stop-once' : 'flip-before-notice'}）` : ''} order=${order} span=${span === null ? '未取得' : `${String(Math.round(span / 1000))}s`}／a1 ${String(a1)}／a2 ${String(a2)}／a3 ${String(a3)}（异己通知 ${String(noticeBad)}）／a5 载体（转达×${String(tokenCounts.relay)}／通知×${String(tokenCounts.notice)}）／回执 ${String(receipt)}${problems.length > 0 ? `／不变量：${problems.join('；')}` : ''}`;
      if (a1 && a2 && a3 && a4 && a5) {
        record.attempts.push({ attempt, ok: true, detail });
        // C7 四元组之子会话域：子会话转录同样不携带 at（F5）——子会话末条
        // 产出的时刻在本装置不可测，C7 只落父会话域四锚，childLastIdx 由
        // pageChild 单次读取登记（下标供对照，不作时序主张）。
        let childLastIdx = null;
        try {
          const childPage = await pageChild(agentId, typeof catalog.mode === 'string' ? catalog.mode : 'unknown');
          const childModels = modelTexts(childPage);
          childLastIdx = childModels.length > 0 ? childModels.at(-1).idx : null;
        } catch (error) {
          killChild();
          fail(`子会话 projections 读取失败（${agentId}）：${String(error?.message ?? error)}`);
        }
        const noticeSeenAt = notice !== null ? seenOf(noticeAbsIdx) : null;
        const resultSeenAt = seenOf(resultAbsIdx);
        sgTrials.push({
          trial: t.trial, series: 'pending', childDurS: t.durS, class: cls,
          tokenCounts: { relay: tokenCounts.relay, notice: tokenCounts.notice },
          waitCalls: waitDone.map((c, i) => ({ spanMs: spansAll[i], class: classifyWaitReturn(c.resultText).cls })),
          subform: cls === 'settled-via-observed' ? (noticeBeforeWait ? 'entry-stop-once' : 'flip-before-notice') : null,
          entry: flags.noticePreexisting === true || undefined,
          pollution: noticeBeforeWait ? 'entry（通知记录早于等待调用（会话绝对下标判定，任意档含 immediate），不计入挂起系列比例句）' : undefined,
          order,
          noticeIdx: noticeAbsIdx, waitCallIdx: callAbsIdx, resultIdx: resultAbsIdx, childLastIdx,
          waitCallSeenAt: seenOf(callAbsIdx), resultSeenAt, noticeSeenAt,
          deltaNoticeToResultMs: noticeSeenAt !== null && resultSeenAt !== null ? resultSeenAt - noticeSeenAt : null,
          rawNote: wc.resultText.slice(0, 400)
        });
        judge(t.name, true, detail);
        return true;
      }
      lastDetail = detail;
      record.snapshot = { waitResultTail: wc.resultText.slice(-400), span };
    }
    record.attempts.push({ attempt, ok: false, detail: lastDetail });
    // 停摆重试（F6）：该系列停摆一次后换新会话重试（系列内最多一次）。
    if (stalled && !seriesRolled.has('sg') && attempt === 1) {
      seriesRolled.add('sg');
      await createSeriesSession('sg-停摆重试');
    }
    log(`步骤 ${t.name} 第 ${String(attempt)} 次未成立（${lastDetail}）${attempt === 1 ? '，重试一次' : ''}`);
  }
  judge(t.name, false, `两次尝试未成立；最后状态：${String(record.attempts.at(-1).detail)}`);
  return false;
}

// 8) SG-3 入口变体（通知先到、等待后发；两次都落挂起形态按实测类别记录、不强行 FAIL）。
async function driveSg3() {
  const record = { name: 'SG-3 入口变体', attempts: [] };
  evidence.steps.push(record);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const beforeCount = await currentBaseline();
    // token 按 attempt 后缀重生成（跨尝试残留防护，与 SG 试次同款）。
    const childToken = `SG3-CHILD-${Math.random().toString(36).slice(2, 8)}-A${String(attempt)}`;
    const childPrompt = `First run this exact PowerShell command: Start-Sleep -Seconds 35; Write-Output CHILD-STEP. Then reply with exactly the single token ${childToken} and nothing else. No other tools, no questions.`;
    const instruction = `Run this single step and reply with exactly the token SG3_DONE: (1) call async_agent with description "sg3 child" and prompt "${childPrompt}"; it returns an agent_id immediately. (2) then call async_run with command "Start-Sleep -Seconds 45; Write-Output SG3-FG", description "sg3 foreground hold", yield_ms 600000 — the command runs and returns in the foreground (about 45 seconds). (3) immediately after it returns, call async_wait with targets [{"kind":"agent","id":"<the agent_id from step 1>"}] and wait_ms 60000. (4) reply with exactly SG3_DONE. No other tools, no questions.`;
    try {
      await prompt(instruction);
    } catch (error) {
      killChild();
      fail(`session/prompt 调用失败：${String(error?.message ?? error)}`);
    }
    const deadline = Date.now() + 300_000;
    let lastDetail = '（无判定输出）';
    let stalled = false;
    let lastCount = -1;
    let lastChangeAt = Date.now();
    while (Date.now() < deadline) {
      await new Promise((r) => { setTimeout(r, POLL_MS); });
      if (child.exitCode !== null) { killChild(); fail('实例在步骤中途退出'); }
      let transcript;
      try { transcript = await transcriptOf(); } catch { continue; }
      stampNew(transcript);
      const count = transcript.records?.length ?? 0;
      if (count !== lastCount) {
        lastCount = count;
        lastChangeAt = Date.now();
      } else if (Date.now() - lastChangeAt >= 180_000) {
        // running 为真不算停摆（同 SG 试次款）；读取失败按运行中处理。文案
        // 附前次判定、不覆盖最后断言状态（三驱动统一口径）。
        let runningNow = true;
        try { runningNow = (await sessionRow()).running === true; } catch { /* 保持 true */ }
        if (runningNow !== true) {
          stalled = true;
          lastDetail = `停摆（180s 无新记录且非运行；末次记录计数 ${String(lastCount)}；前次判定：${lastDetail}）`;
          break;
        }
        lastChangeAt = Date.now();
      }
      const winPage = { records: stepRecords(transcript, beforeCount) };
      const calls = pairCalls(winPage);
      const waitCalls = calls.filter((c) => c.name === 'async_wait' && c.resultIdx !== null);
      const receipt = modelTexts(winPage).some((m) => m.text.includes('SG3_DONE'));
      if (waitCalls.length === 0 || !receipt) continue;
      const wc = waitCalls.at(-1);
      // span＝首见墙钟差（F5：记录不携带 at）；判定取最后一个完成等待。
      const spanOf3 = (c) => {
        const s0 = seenOf(beforeCount + c.callIdx);
        const s1 = seenOf(beforeCount + c.resultIdx);
        return s0 !== null && s1 !== null && s1 >= s0 ? s1 - s0 : null;
      };
      const span = spanOf3(wc);
      const { cls, flags } = classifyWaitReturn(wc.resultText);
      // 异己通知（重试残留子代理等）按 senderSessionId 过滤，不参与次序判据。
      const agentCalls3 = calls.filter((c) => c.name === 'async_agent' && c.resultIdx !== null);
      const agentId3 = agentCalls3.length > 0
        ? ((agentCalls3.at(-1).resultText.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) ?? [])[1] ?? null)
        : null;
      const entries = injectedEntries(winPage);
      const notices = entries.filter((e) => e.sourceKind === 'subagent-settled'
        && (e.senderSessionId === undefined || e.senderSessionId === null || e.senderSessionId === agentId3));
      const notice = notices.length > 0 ? notices[0] : null;
      // 入口次序＝记录下标（F5：通知记录早于等待调用即入口先到；两侧同加
      // beforeCount 统一会话绝对下标，at 缺席不再使断言悬空）。
      const noticeFirst = notice !== null && beforeCount + notice.idx < beforeCount + wc.callIdx;
      // 「通知已被领入模型输入」的替代判据：等待调用之前存在 next-step 移除 splice。
      const waitCallRecIdx = wc.callIdx;
      const claimedBeforeWait = stepRecords(winPage, 0).some((r, i) => r.event?.type === 'agent/inbox/spliced'
        && r.event.data?.target === 'next-step' && (r.event.data?.removedCount ?? 0) > 0 && i < waitCallRecIdx);
      const accepted = flags.noteSettled || flags.arrived;
      const entryOk = noticeFirst || claimedBeforeWait;
      // 投递载体恰一次（与 SG-1/2 断言 5 同款：转达／通知 closing text 双载体）。
      const tokenCounts3 = deliveryTokenCounts(winPage, childToken);
      const tokenCount3Ok = tokenCounts3.relay <= 1 && tokenCounts3.notice <= 1 && (tokenCounts3.relay + tokenCounts3.notice) >= 1;
      // span<10s 的前提＝「已结算目标的等待即时返回」（真机 SG-2 末次等待
      // 实测 via.noticePreexisting＋note.settled 即时返回支持；与 SG-1/2 的
      // F4 补等观察同源——若宿主行为变化致此前提失效，此处会假 FAIL，按实
      // 例发现取证）。
      const aSpan = span !== null && span < 10_000;
      const detail = `class=${cls} span=${span === null ? '未取得' : `${String(Math.round(span / 1000))}s`}／接受集 ${String(accepted)}（noteSettled=${String(flags.noteSettled)}／arrived=${String(flags.arrived)}）／入口次序 ${String(entryOk)}（noticeFirst=${String(noticeFirst)}／claimedBeforeWait=${String(claimedBeforeWait)}）／载体（转达×${String(tokenCounts3.relay)}／通知×${String(tokenCounts3.notice)}）`;
      if (accepted && entryOk && aSpan && tokenCount3Ok) {
        record.attempts.push({ attempt, ok: true, detail });
        const resultAbsIdx3 = beforeCount + wc.resultIdx;
        const noticeAbsIdx3 = notice !== null ? beforeCount + notice.idx : null;
        const noticeSeenAt3 = notice !== null ? seenOf(noticeAbsIdx3) : null;
        const resultSeenAt3 = seenOf(resultAbsIdx3);
        sgTrials.push({
          trial: 'SG-3', series: 'entry', childDurS: 35, class: cls, subform: null,
          tokenCounts: { relay: tokenCounts3.relay, notice: tokenCounts3.notice },
          order: notice !== null ? (noticeAbsIdx3 <= resultAbsIdx3 ? 'notice-before-result' : 'result-before-notice') : 'na',
          noticeIdx: noticeAbsIdx3, waitCallIdx: beforeCount + wc.callIdx, resultIdx: resultAbsIdx3,
          waitCallSeenAt: seenOf(beforeCount + wc.callIdx), resultSeenAt: resultSeenAt3, noticeSeenAt: noticeSeenAt3,
          deltaNoticeToResultMs: noticeSeenAt3 !== null && resultSeenAt3 !== null ? resultSeenAt3 - noticeSeenAt3 : null,
          rawNote: wc.resultText.slice(0, 400), note: '入口变体（通知先到、等待后发）'
        });
        judge('SG-3 入口变体', true, detail);
        return true;
      }
      // 边界：结算落在挂起中（挂起档）——按实测类别记录，第二次仍如此则不强行 FAIL。
      if (attempt === 2 && tokenCount3Ok) {
        record.attempts.push({ attempt, ok: true, detail: `${detail}——入口窗未自然命中，按实测类别记录（挂起档由 SG-1/2 覆盖）` });
        sgTrials.push({
          trial: 'SG-3', series: 'entry', childDurS: 35, class: cls, subform: null, order: 'na',
          tokenCounts: { relay: tokenCounts3.relay, notice: tokenCounts3.notice },
          waitCallIdx: beforeCount + wc.callIdx, resultIdx: beforeCount + wc.resultIdx,
          waitCallSeenAt: seenOf(beforeCount + wc.callIdx), resultSeenAt: seenOf(beforeCount + wc.resultIdx),
          deltaNoticeToResultMs: null,
          rawNote: wc.resultText.slice(0, 400), note: `入口窗未自然命中（实测类别 ${cls}，按实测记录、不判 FAIL）`
        });
        judge('SG-3 入口变体', true, `${detail}——入口窗未自然命中，按实测类别记录（不判 FAIL）`);
        return true;
      }
      lastDetail = detail;
    }
    record.attempts.push({ attempt, ok: false, detail: lastDetail });
    // 停摆重试（F6）：本系列停摆一次后换新会话重试（系列内最多一次）。
    if (stalled && !seriesRolled.has('sg3') && attempt === 1) {
      seriesRolled.add('sg3');
      await createSeriesSession('sg3-停摆重试');
    }
    log(`步骤 SG-3 第 ${String(attempt)} 次未成立（${lastDetail}）${attempt === 1 ? '，重试一次' : ''}`);
  }
  judge('SG-3 入口变体', false, `两次尝试未成立；最后状态：${String(record.attempts.at(-1).detail)}`);
  return false;
}

// 9) IR 试次驱动（忙碌回合中的结算；自定义循环：running 时间线采样＋滞留检测）。
const IR_TOPICS = ['the history of timekeeping instruments', 'lighthouses and maritime navigation', 'urban water supply systems', 'map projections and their trade-offs'];
function irTrialPrompt(t, token) {
  return `Run this single step: (1) call async_run with command "Start-Sleep -Seconds ${String(t.durS)}; Write-Output ${token}", description "ir${String(t.k)} bg job", yield_ms 20000 — it goes to background, note the job id. (2) In the SAME turn, immediately write a coherent essay of at least 900 words about ${IR_TOPICS[t.k - 1] ?? 'the history of writing materials'}; do NOT call any tools while writing; the very last line of the essay must be exactly ${t.busyEnd}. (3) After the essay, end your turn. When the background job result reaches you (during the turn or later as a message), reply with exactly ${t.receipt} and stop. No other tools, no questions.`;
}
async function driveIrTrial(t) {
  const record = { name: t.name, attempts: [] };
  evidence.steps.push(record);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const beforeCount = await currentBaseline();
    // token 按 attempt 后缀重生成（跨尝试残留防护，与 SG 试次同款）。
    const token = `${t.token}-A${String(attempt)}`;
    const runningSamples = [];
    try {
      await prompt(irTrialPrompt(t, token));
    } catch (error) {
      killChild();
      fail(`session/prompt 调用失败：${String(error?.message ?? error)}`);
    }
    const deadline = Date.now() + t.durS * 1000 + 150_000 + 90_000;
    let settledWallSeen = null;
    let lastDetail = '（无判定输出）';
    let lingerDetected = false;
    let stalled = false;
    let lastCount = -1;
    let lastChangeAt = Date.now();
    while (Date.now() < deadline) {
      await new Promise((r) => { setTimeout(r, POLL_MS); });
      if (child.exitCode !== null) { killChild(); fail('实例在步骤中途退出'); }
      let row;
      let transcript;
      try {
        row = await sessionRow();
        transcript = await transcriptOf();
      } catch { continue; }
      stampNew(transcript);
      runningSamples.push({ at: Date.now(), running: row.running === true });
      // 停摆防护（F6，同 SG 款；essay 生成期 running 真——重置计时不算停摆，
      // 长文生成的合法静默不触发；滞留检测的 90s 尾窗先于本 180s 阈值触发）。
      const count = transcript.records?.length ?? 0;
      if (count !== lastCount) {
        lastCount = count;
        lastChangeAt = Date.now();
      } else if (Date.now() - lastChangeAt >= 180_000) {
        if (row.running !== true) {
          stalled = true;
          // 停摆消息不覆盖最后一次判定状态——保留归因线索（真机实证：覆盖
          // 后 attempts.detail 只剩停摆文案，最后断言状态丢失）。
          lastDetail = `停摆（180s 无新记录且非运行；末次记录计数 ${String(lastCount)}；前次判定：${lastDetail}）`;
          break;
        }
        lastChangeAt = Date.now();
      }
      const win = stepRecords(transcript, beforeCount);
      const winPage = { records: win };
      // —— 断言 1：单次 async_run（记录级直数）、job/registered、无等待类工具。
      const calls = pairCalls(winPage);
      const runCalls = calls.filter((c) => c.name === 'async_run' && c.resultIdx !== null);
      const toolNames = toolCallNames(winPage);
      const stepJobIds = new Set(win.filter((r) => r.event?.type === 'job/registered')
        .map((r) => String(r.event.data?.jobId ?? '')).filter((id) => id !== ''));
      const a1 = (toolCallCounts(winPage).get('async_run') ?? 0) === 1 && !toolNames.has('async_wait') && !toolNames.has('job_output')
        && stepJobIds.size >= 1;
      // —— 断言 2：文章末条产出锚（记录下标空间与注入一致；取末条含锚消息——
      // 指令约束锚在末行，取末条更贴「末条产出」语义，违规续写不误导分类）。
      const assistantRecords = win
        .map((r, i) => ({ r, i }))
        .filter((x) => x.r.event?.type === 'assistant/message' || x.r.event?.type === 'model/message')
        .map((x) => ({
          i: x.i,
          text: (x.r.event.data?.message?.content ?? x.r.event.data?.content ?? []).map((c) => String(c.text ?? '')).join('\n')
        }));
      const essay = assistantRecords.findLast((m) => m.text.includes(t.busyEnd)) ?? null;
      // —— 断言 3：结算与完成消息恰一次（按本步 job 身份过滤，跨步残留不误伤）。
      const entries = injectedEntries(winPage);
      const completions = entries.filter((e) => e.sourceKind === 'async-tools-job-result' && e.text.includes(token));
      const settledOk = win.some((r) => r.event?.type === 'job/settled' && (r.event.data?.status ?? '') === 'completed'
        && stepJobIds.has(String(r.event.data?.jobId ?? '')));
      const tokenCount = userSideTokenCount(winPage, token);
      const a3 = completions.length === 1 && tokenCount === 1;
      // —— 断言 4：恢复证据（结构性主锚＝完成消息的领取 splice，任一 target、
      // 记录值）。真机事实：claim 的 splice 事件**先于**其领取的消息记录写入
      // 转录（claimed 事件不进转录、splice 是可观察痕迹——batch-window 同款口
      // 径），故锚向为「注入记录之前最近的 removedCount>0 splice」（本装置单
      // 作业单消息构造下，探针自身 prompt 的领取 splice 更早、被中间的工具与
      // 文章记录隔开，最近前者即本完成消息的领取点；复用到多消息构造时需重
      // 证此前提，非普适锚向）。
      const injection = completions[0] ?? null;
      if (settledOk && settledWallSeen === null) settledWallSeen = Date.now();
      let spliceIdx = -1;
      let runStartRecord = null;
      let spliceTargets = [];
      if (injection != null) {
        // 扫描下界＝本步首个 tool/call 记录（探针自身 prompt 的领取 splice 在其
        // 之前；完成消息的领取点必在其后——护栏防异常回退）。锚组收集按
        // claimGroupBefore（F2 修订：splice 与消息记录间可隔步／回合机器记录）；
        // 串首记录（runStartRecord）供 detail 与落档——idx/target/removedCount
        // 三者同口径（串首）。
        const firstToolIdx = win.findIndex((r) => r.event?.type === 'tool/call');
        const group = claimGroupBefore(win, injection.idx, firstToolIdx);
        spliceIdx = group.spliceIdx;
        spliceTargets = group.targets;
        if (spliceIdx >= 0) {
          runStartRecord = win[spliceIdx - (spliceTargets.length - 1)];
        }
      }
      const receipt = assistantRecords.some((m) => m.text.includes(t.receipt));
      // 注入后产出（观测字段 afterRoll——真机实证降级：回执抢跑（essay 末同
      // 回合即写 IRk_DONE）＋跟随回合静默收尾是实测一致的合法模型行为，该值
      // 恒假但不构成插件缺陷证据；LA-5 的「完成消息到达模型输入」由结构锚
      // （记录在场＝已领取＋领取 splice 组＋token 恰一次）完整证明）。
      const afterRoll = injection != null
        ? assistantRecords.some((m) => m.i > injection.idx)
        : false;
      // —— 滞留检测（转 IR-5）：job 已结算 ≥90s，完成消息记录始终未出现（未
      // 领取的消息不进转录——滞留的可观察形态是「结算后无记录」，不是「记录
      // 在场无人理」）、**最近 90s 采样窗内** running 持续为假（尾窗口径——
      // 覆盖「结算时仍忙碌、随后空闲且未领取」的真实滞留变体；全程 idle 的
      // 标准形态自然满足。settledWallSeen 是首见 job/settled 的墙钟、含 ≤1
      // 个轮询间隔的滞后——方向是少杀不误杀）。**不以回执缺席为前提**（真
      // 机实证：回执抢跑是系统性行为，真实滞留时模型同样已凭指令记忆抢写
      // 回执——回执在场＋记录缺席恰是更强的滞留信号，按抢跑口径登记
      // racedReceipt 仍转 IR-5；IR-5 恢复判据是记录＋token 口径、不受回执
      // 影响）。接受前先过构造锚（模型违规产物不是自然滞留——设计把「忙碌
      // 回合锚被破坏经重试仍成立」列为 FAIL 条件）。
      if (injection === null && a1 && essay !== null && settledOk && settledWallSeen !== null
        && Date.now() - settledWallSeen >= 90_000
        && (() => { const tail = runningSamples.filter((s) => s.at >= Date.now() - 90_000); return tail.length > 0 && tail.every((s) => s.running !== true); })()) {
        lingerDetected = true;
        lingerTrial = { t, token, beforeCount, runningSamples, essayIdx: essay?.i ?? null, injectionIdx: null, tokenCount, detectedAtMs: Date.now() };
        // 滞留条目四锚（盲审 N2：与 §5「…Idx/…At 成对」口径看齐——结算锚
        // 与 essay 锚在检出时已在场；inject／claim 锚缺席即滞留本体、保持
        // null，恢复后由 IR-5 补）。
        const settledIdxLinger = win.findIndex((r) => r.event?.type === 'job/settled'
          && (r.event.data?.status ?? '') === 'completed' && stepJobIds.has(String(r.event.data?.jobId ?? '')));
        record.attempts.push({ attempt, ok: true, detail: `滞留形态（结算后 ≥90s 完成消息记录未出现、running 持续为假；回执${receipt ? '在场——抢跑口径' : '缺席——标准口径'}）——转 IR-5` });
        irTrials.push({
          trial: t.name, jobDurS: t.durS, class: 'linger',
          racedReceipt: receipt === true,
          afterRoll: false,
          settledIdx: settledIdxLinger >= 0 ? beforeCount + settledIdxLinger : null,
          settledAt: settledIdxLinger >= 0 ? seenOf(beforeCount + settledIdxLinger) : null,
          essayAt: seenOf(beforeCount + essay.i),
          injectIdx: null, essayIdx: beforeCount + essay.i, claimSpliceIdx: null, claimSpliceTarget: null,
          receiptAfterInjectMs: null, receiptAfterClaimMs: null,
          runningSamples: runningSamples.map((s) => ({ t: s.at, running: s.running }))
        });
        judge(t.name, true, `滞留形态（转 IR-5；不判 FAIL；回执${receipt ? '在场——抢跑口径' : '缺席'}）`);
        return true;
      }
      const detail = `a1 ${String(a1)}／essay ${String(essay !== null)}／结算 ${String(settledOk)}／完成消息×${String(completions.length)}（token×${String(tokenCount)}）／领取 splice ${String(spliceIdx >= 0 ? `${String(runStartRecord?.event?.data?.target ?? '')}×${String(Number(runStartRecord?.event?.data?.removedCount ?? 0))}（注入前，串首）` : '缺席')}／afterRoll（观测）${String(afterRoll)}／回执（旁证）${String(receipt)}`;
      // PASS 不以回执与 afterRoll 为必要条件（回执＝设计断言 6 旁证；
      // afterRoll＝观测字段——回执抢跑＋跟随回合静默是合法模型行为，真机
      // 实证见注释；领取 splice＋完成消息恰一次才是结构性主锚）。
      if (a1 && essay !== null && settledOk && a3 && spliceIdx >= 0) {
        // —— IR 判别式分类（真机事实修正版）：claim 只发生在 step 边界——essay
        // 是单 step 纯文本、期间无领取点，「忙碌窗内 inject＋同回合补步领取」
        // 的注入记录恒写于 essay 之后，下标次序无区分力；有区分力的是**注入
        // 记录之前领取 splice 组的 target 构成**（组收集＝claimGroupBefore——
        // splice 与消息记录间可隔步／回合机器记录；宿主源码 dsh-agent-loop/
        // lib/index.js L103-110：补步 claim 只清 next-step——单 next-step
        // splice；宿主开新回合的 claim 先清 next-step 再领 next-turn 条目——
        // 同点相邻双 splice、以 next-turn 为准、组＝相邻串落档（回合边界形
        // 态下组可能只含尾 splice——见 claimGroupBefore 注））：组只含
        // next-step＝同回合补步领取（inject-during-step），组含 next-turn＝
        // 空闲后宿主开回合领取（followup-after-idle，LA-5 次序版）。
        const cls = spliceTargets.includes('next-turn') ? 'followup-after-idle' : 'inject-during-step';
        const receiptMsg = assistantRecords.find((m) => m.text.includes(t.receipt)) ?? null;
        // 四锚下标＋首见墙钟（设计 §3：settled／inject／essay／receipt 各落
        // idx＋首见墙钟；claimSpliceIdx/Target/removedCount 统一取**组内最早
        // 成员（串首）**记录（runStartRecord 已在外层就位）——三字段同口径；
        // 组＝相邻串，串首＝spliceIdx−(len−1)。splice target 字段缺失（宿主
        // 契约异常）落 spliceTargetAnomaly 标记、不静默归档。settledIdx 与
        // settledOk 同过滤 stepJobIds（防跨步残留作业的 job/settled 记错锚）。
        const runStart = spliceIdx - (spliceTargets.length - 1);
        const settledIdxWin = win.findIndex((r) => r.event?.type === 'job/settled'
          && (r.event.data?.status ?? '') === 'completed' && stepJobIds.has(String(r.event.data?.jobId ?? '')));
        const settledIdxAbs = settledIdxWin >= 0 ? beforeCount + settledIdxWin : null;
        record.attempts.push({ attempt, ok: true, detail });
        // 下标基统一为会话绝对下标（与 firstSeenAt 键域、SG 系列字段同基）。
        irTrials.push({
          trial: t.name, jobDurS: t.durS, class: cls,
          injectIdx: beforeCount + injection.idx, essayIdx: beforeCount + essay.i,
          claimSpliceIdx: beforeCount + runStart,
          settledIdx: settledIdxAbs,
          settledAt: settledIdxAbs !== null ? seenOf(settledIdxAbs) : null,
          injectAt: seenOf(beforeCount + injection.idx),
          essayAt: seenOf(beforeCount + essay.i),
          receiptIdx: receiptMsg != null ? beforeCount + receiptMsg.i : null,
          receiptAt: receiptMsg != null ? seenOf(beforeCount + receiptMsg.i) : null,
          claimSpliceTarget: String(runStartRecord?.event?.data?.target ?? ''),
          claimSpliceRemovedCount: runStartRecord != null ? Number(runStartRecord.event?.data?.removedCount ?? 0) : null,
          claimSpliceTargets: spliceTargets,
          spliceTargetAnomaly: spliceTargets.includes('') || undefined,
          afterRoll,
          // 毫秒差＝首见墙钟差（F5：记录不携带 at；粒度 ≤4s）。领取基准＝
          // 串首 splice（与 claimSpliceIdx 同口径）。负值＝回执抢跑（回执早于
          // 完成消息到达），与 afterRoll=false 同源、合法模型行为——真机
          // IR-1..4 实测即此形，非计算错误。
          receiptAfterInjectMs: receiptMsg != null && seenOf(beforeCount + injection.idx) !== null && seenOf(beforeCount + receiptMsg.i) !== null
            ? seenOf(beforeCount + receiptMsg.i) - seenOf(beforeCount + injection.idx) : null,
          receiptAfterClaimMs: receiptMsg != null && seenOf(beforeCount + receiptMsg.i) !== null && seenOf(beforeCount + runStart) !== null
            ? seenOf(beforeCount + receiptMsg.i) - seenOf(beforeCount + runStart) : null,
          // running 时间线入证据（设计 IR-1 断言 5：忙碌→空闲采样可事后复核；
          // 字段 t＝采样墙钟）。
          runningSamples: runningSamples.map((s) => ({ t: s.at, running: s.running }))
        });
        judge(t.name, true, `${detail}——形态=${cls}`);
        return true;
      }
      record.snapshot = {
        toolNames: [...toolNames],
        modelTail: assistantRecords.slice(-5).map((m) => m.text.slice(-250)),
        injectedTail: entries.slice(-5).map((e) => ({ source: e.sourceKind, text: e.text.slice(-200) })),
        // 窗口形态（末 ~40 条记录的 event.type 序列）——失败时可离线归因
        // splice 邻接形态（完成消息与领取 splice 之间是否插入其他记录）。
        windowShape: win.slice(-40).map((r) => String(r.event?.type ?? ''))
      };
      lastDetail = detail;
    }
    if (!lingerDetected) {
      record.attempts.push({ attempt, ok: false, detail: lastDetail });
      // 停摆重试（F6）：本系列停摆一次后换新会话重试（系列内最多一次）。
      if (stalled && !seriesRolled.has('ir') && attempt === 1) {
        seriesRolled.add('ir');
        await createSeriesSession('ir-停摆重试');
      }
      log(`步骤 ${t.name} 第 ${String(attempt)} 次未成立（${lastDetail}）${attempt === 1 ? '，重试一次' : ''}`);
    }
  }
  judge(t.name, false, `两次尝试未成立；最后状态：${String(record.attempts.at(-1)?.detail ?? '（无判定输出）')}`);
  return false;
}

// 10) IR-5 滞留观察与恢复（条件步、单尝试；滞留检出后**立即**执行——后续试次
//     的探针 prompt 会先开回合领取滞留消息，把恢复归因污染成外部唤醒）。
async function driveIr5() {
  const record = { name: 'IR-5 滞留观察与恢复', attempts: [] };
  evidence.steps.push(record);
  const t = lingerTrial.t;
  const wakePrompt = 'Reply now with any pending receipt tokens you owe from earlier job results, then stop. No tools.';
  // 滞留窗内 reminder 催领条有无（迟到作答路径的空闲观察会发；完成消息路径按实现不武装）。
  let transcriptNow;
  try { transcriptNow = await transcriptOf(); } catch (error) { killChild(); fail(`转录读取失败：${String(error?.message ?? error)}`); }
  stampNew(transcriptNow);
  const winNow = stepRecords(transcriptNow, lingerTrial.beforeCount);
  const preEntries = injectedEntries({ records: winNow });
  const reminderSeen = preEntries.some((e) => e.sourceForm === 'reminder');
  record.attempts.push({ attempt: 1, ok: null, detail: `滞留窗内 reminder 催领条：${reminderSeen ? '在场' : '缺席'}（完成消息路径按实现不武装空闲观察——如实记录）` });
  // 恢复证据（滞留的可观察形态是「结算后完成消息记录未出现」——未领取的消
  // 息不进转录，记录本体即领取证据；恢复＝该记录出现＋token 经用户侧载体恰
  // 一次。其之前的领取 splice 组（claim 的 splice 先于其领取的消息记录写入、
  // 与 IR-1..4 同锚向——claimGroupBefore 口径）是痕迹佐证，缺席按实例发现记
  // 录。回执只作旁证。滞留时长证据＝检出时刻（lingerTrial.detectedAtMs）→
  // 恢复记录首见墙钟（recoveredAtMs）→ 回执首见墙钟（receiptAtMs））。
  const recoveryOf = (win) => {
    const entry = injectedEntries({ records: win })
      .find((e) => e.sourceKind === 'async-tools-job-result' && e.text.includes(lingerTrial.token));
    if (entry === undefined) return null;
    const firstToolIdx = win.findIndex((r) => r.event?.type === 'tool/call');
    const group = claimGroupBefore(win, entry.idx, firstToolIdx);
    const receiptMsg = modelTexts({ records: win }).find((m) => m.text.includes(t.receipt)) ?? null;
    const runStart = group.spliceIdx >= 0 ? group.spliceIdx - (group.targets.length - 1) : -1;
    const runStartTarget = runStart >= 0 ? String(win[runStart].event?.data?.target ?? '') : '';
    const runStartRemoved = runStart >= 0 ? Number(win[runStart].event?.data?.removedCount ?? 0) : null;
    return { entry, spliceIdx: group.spliceIdx, runStart, runStartTarget, runStartRemoved, targets: group.targets, receipt: receiptMsg !== null, receiptMsg };
  };
  // 预读守卫：唤醒前完成消息记录若已自行出现（宿主自开回合领取——滞留检出
  // 与 IR-5 之间无探针 prompt），恢复先于唤醒，如实记录、不归因中性唤醒、不
  // 发唤醒。
  const pre = recoveryOf(winNow);
  if (pre !== null) {
    const tokenCountNow = userSideTokenCount({ records: winNow }, lingerTrial.token);
    const lingerEntry = irTrials.find((e) => e.trial === t.name);
    if (lingerEntry !== undefined) {
      lingerEntry.injectIdx = lingerTrial.beforeCount + pre.entry.idx;
      lingerEntry.claimSpliceIdx = pre.spliceIdx >= 0 ? lingerTrial.beforeCount + pre.runStart : null;
      lingerEntry.claimSpliceTarget = pre.spliceIdx >= 0 ? pre.runStartTarget : null;
      lingerEntry.claimSpliceRemovedCount = pre.spliceIdx >= 0 ? pre.runStartRemoved : null;
      lingerEntry.claimSpliceTargets = pre.targets;
      lingerEntry.recovered = true;
      lingerEntry.reminderSeen = reminderSeen;
      lingerEntry.recoveredBy = 'pre-wake';
      lingerEntry.recoveredNote = '恢复先于中性唤醒——宿主自开回合领取，不归因中性唤醒，按实例发现记录';
      lingerEntry.lingerDetectedAtMs = lingerTrial.detectedAtMs ?? null;
      lingerEntry.recoveredAtMs = seenOf(lingerTrial.beforeCount + pre.entry.idx);
      lingerEntry.injectAt = lingerEntry.recoveredAtMs;
      lingerEntry.receiptAtMs = pre.receiptMsg != null ? seenOf(lingerTrial.beforeCount + pre.receiptMsg.i) : null;
      lingerEntry.spliceTargetAnomaly = pre.targets.includes('') || undefined;
    }
    record.attempts.push({ attempt: 1, ok: tokenCountNow === 1, detail: `唤醒前完成消息记录已自行出现（领取 splice ${pre.spliceIdx >= 0 ? `idx=${String(lingerTrial.beforeCount + pre.runStart)}（串首）、target=${pre.runStartTarget}` : '缺席——按实例发现记录'}）——恢复先于唤醒，按实例发现记录；token 用户侧×${String(tokenCountNow)}` });
    judge(`IR-5 滞留观察与恢复（${t.name}）`, tokenCountNow === 1, tokenCountNow === 1 ? '恢复先于唤醒（预读守卫命中，如实记录）' : `恢复先于唤醒且 token 计数 ${String(tokenCountNow)}（重复投递）`);
    return tokenCountNow === 1;
  }
  try {
    await prompt(wakePrompt, 'queue');
  } catch (error) {
    killChild();
    fail(`session/prompt 调用失败：${String(error?.message ?? error)}`);
  }
  const deadline = Date.now() + 120_000;
  let lastDetail = '（无判定输出）';
  while (Date.now() < deadline) {
    await new Promise((r) => { setTimeout(r, POLL_MS); });
    if (child.exitCode !== null) { killChild(); fail('实例在步骤中途退出'); }
    let transcript;
    try { transcript = await transcriptOf(); } catch { continue; }
    stampNew(transcript);
    const win = stepRecords(transcript, lingerTrial.beforeCount);
    // 唤醒 prompt 自身的领取（next-turn）与滞留消息的领取（next-step）在同一次
    // claim 发生——splice 事件先于其领取的消息记录写入（F2），故唤醒 prompt 的
    // next-turn splice 备查锚向取唤醒记录**之前**最近（与 recoveryOf 同锚向）；
    // 滞留消息恢复的主锚＝完成消息记录出现（未领取的消息不进转录——记录本
    // 体即领取证据）＋token 恰一次；领取 splice 是痕迹佐证，缺席按实例发现
    // 记录（守卫与唤醒两分支同口径）。
    const wakeIdx = win.findIndex((r) => r.event?.type === 'user/message'
      && ((r.event.data?.message?.content ?? r.event.data?.content ?? []).map((c) => String(c.text ?? '')).join('\n')).includes('Reply now with any pending receipt tokens'));
    // 备查锚向＝唤醒记录之前的领取 splice **组**（claimGroupBefore 口径——
    // 与 recoveryOf 同款：splice 与消息记录间可隔步／回合机器记录与同批兄弟
    // 消息）内含 next-turn；组不含 next-turn 记缺席（防 splice 异常缺席时回
    // 退命中更早步的回合开始 splice 而失真——组收集遇内容记录即停）。无下
    // 界调用安全：滞留检出前提保证 essay（assistant/message 内容记录）在场，
    // 回走必被 essay 或本批 splice 挡住、不会误入指令区。
    const wakeGroup = wakeIdx >= 0 ? claimGroupBefore(win, wakeIdx, -1) : { spliceIdx: -1, target: '', targets: [] };
    // 取 next-turn 本体的位置（组＝相邻连续 splice 串，spliceIdx＝串尾；成员
    // 下标＝spliceIdx−(len−1)+targets.indexOf——不依赖宿主 ns 先／nt 后的写
    // 入次序；组不含 next-turn 记 −1）。
    const ntPos = wakeGroup.targets.indexOf('next-turn');
    const wakeTurnSpliceIdx = ntPos >= 0 ? wakeGroup.spliceIdx - (wakeGroup.targets.length - 1) + ntPos : -1;
    const rec = recoveryOf(win);
    const tokenCount = userSideTokenCount({ records: win }, lingerTrial.token);
    const detail = `唤醒后完成消息记录 ${String(rec !== null ? '在场' : '缺席')}（领取 splice ${String(rec !== null && rec.spliceIdx >= 0 ? `${rec.runStartTarget}（记录前，串首）` : rec !== null ? '缺席（按实例发现记录）' : '—')}；唤醒 prompt 的 next-turn splice ${String(wakeTurnSpliceIdx >= 0 ? '在场' : '缺席')}，备查）／回执（旁证）${String(rec !== null && rec.receipt)}／token 用户侧×${String(tokenCount)}／reminder=${String(reminderSeen)}`;
    if (rec !== null && tokenCount === 1) {
      record.attempts.push({ attempt: 1, ok: true, detail });
      const lingerEntry = irTrials.find((e) => e.trial === t.name);
      if (lingerEntry !== undefined) {
        lingerEntry.injectIdx = lingerTrial.beforeCount + rec.entry.idx;
        lingerEntry.claimSpliceIdx = rec.spliceIdx >= 0 ? lingerTrial.beforeCount + rec.runStart : null;
        lingerEntry.claimSpliceTarget = rec.spliceIdx >= 0 ? rec.runStartTarget : null;
        lingerEntry.claimSpliceRemovedCount = rec.spliceIdx >= 0 ? rec.runStartRemoved : null;
        lingerEntry.claimSpliceTargets = rec.targets;
        lingerEntry.recovered = true;
        lingerEntry.reminderSeen = reminderSeen;
        lingerEntry.recoveredBy = 'wake';
        lingerEntry.recoveredNote = '中性 queue 唤醒后恢复';
        lingerEntry.lingerDetectedAtMs = lingerTrial.detectedAtMs ?? null;
        lingerEntry.recoveredAtMs = seenOf(lingerTrial.beforeCount + rec.entry.idx);
        lingerEntry.injectAt = lingerEntry.recoveredAtMs;
        lingerEntry.receiptAtMs = rec.receiptMsg != null ? seenOf(lingerTrial.beforeCount + rec.receiptMsg.i) : null;
        lingerEntry.spliceTargetAnomaly = rec.targets.includes('') || undefined;
        lingerEntry.wakeTurnSpliceIdx = wakeTurnSpliceIdx >= 0 ? lingerTrial.beforeCount + wakeTurnSpliceIdx : null;
      }
      judge(`IR-5 滞留观察与恢复（${t.name}）`, true, `${detail}${rec.receipt ? '' : '——结构证据成立、回执缺席（按实例发现记录，不判 FAIL）'}`);
      return true;
    }
    if (tokenCount > 1) {
      record.attempts.push({ attempt: 1, ok: false, detail: `${detail}——恢复产生重复投递（违反需求 9.3.2「同一最终结果只出现一次」）` });
      judge(`IR-5 滞留观察与恢复（${t.name}）`, false, `${detail}——重复投递`);
      return false;
    }
    lastDetail = detail;
  }
  record.attempts.push({ attempt: 1, ok: false, detail: lastDetail });
  judge(`IR-5 滞留观察与恢复（${t.name}）`, false, `唤醒后完成消息记录未出现（${lastDetail}）`);
  return false;
}

// 11) 步骤序列（会话策略＝按系列分会话（F6）：SG-1/2 挂起系列、SG-3、IR
//     各一个会话，停摆重试各自最多换一次新会话）。
console.log(`\n── SG 系列：结算时序（当前候选 ${head}${dirty}）──`);
await createSeriesSession('sg');
await driveSgTrial({ trial: 'SG-1', name: 'SG-1 挂起等待中的自然结算', durS: 35, childToken: `SG1-CHILD-${Math.random().toString(36).slice(2, 8)}`, receipt: 'SG1_DONE', budgetMs: 180_000 });
for (const [i, durS] of [30, 35, 40, 45, 50].entries()) {
  await driveSgTrial({ trial: `SG-2.${String(i + 1)}`, name: `SG-2 采样 ${String(i + 1)}/5（子代理 ${String(durS)}s）`, durS, childToken: `SG2-${String(i + 1)}-CHILD-${Math.random().toString(36).slice(2, 8)}`, receipt: `SG2${String(i + 1)}_DONE`, budgetMs: 180_000 });
}
await createSeriesSession('sg3');
await driveSg3();

console.log('\n── IR 系列：忙碌回合中的完成消息领取 ──');
await createSeriesSession('ir');
let ir5Done = false;
for (const [i, durS] of [45, 60, 75, 90].entries()) {
  const k = i + 1;
  await driveIrTrial({ k, name: `IR-${String(k)} 忙碌回合中的结算（D=${String(durS)}s）`, durS, token: `IR${String(k)}-TOKEN-${Math.random().toString(36).slice(2, 8)}`, busyEnd: `BUSY-END-${String(k)}`, receipt: `IR${String(k)}_DONE` });
  if (lingerTrial !== null) {
    // 滞留检出后立即执行 IR-5：后续试次的探针 prompt 会先开回合、claim 清
    // next-step，把恢复归因污染成「外部唤醒」——立即执行保住中性唤醒单尝试
    // 的证据位（盲审 major-1 修法），剩余 IR 试次在 IR-5 后继续。
    await driveIr5();
    ir5Done = true;
    lingerTrial = null;
  }
}
if (!ir5Done) {
  evidence.steps.push({ name: 'IR-5 滞留观察与恢复', attempts: [{ attempt: 1, ok: null, detail: '滞留形态未检出（含抢跑口径——本轮无检出，不区分「未发生」与「未被触发」以外的语义）' }] });
  console.log('SKIP IR-5 滞留观察与恢复——滞留形态未检出（含抢跑口径）');
}

// 12) 汇总（自然时序结论；不预设方向——各档以硬性不变量为 PASS 条件）。
// 挂起系列＝SG-1/2（设计 §5 trials:6，此处为实际计入数）；SG-3 入口变体单
// 列（entryTrial）；污染备注试次（入口形态混入）单独落档、**不参与类别计数
// 与比例句**（类别计数描述挂起系列的干净分布；FAIL 试次不入 trials——以
// trialsAttempted／trialsScored 两数并记，明细在 steps.attempts 与 verdicts）。
const sgPending = sgTrials.filter((x) => x.series !== 'entry');
const sgEntry = sgTrials.filter((x) => x.series === 'entry');
const sgClean = sgPending.filter((x) => x.pollution === undefined);
const sgClasses = { immediate: 0, 'lag-settled': 0, 'lag-changed': 0, 'entry-lag': 0, 'message-wake-confirm': 0, 'settled-via-observed': 0, 'budget-interrupt-pending': 0, 'budget-interrupt-plain': 0, other: 0 };
for (const trial of sgClean) sgClasses[trial.class] = (sgClasses[trial.class] ?? 0) + 1;
const polluted = sgPending.filter((x) => x.pollution !== undefined).length;
const lagSettledDeltas = sgClean.filter((x) => x.class === 'lag-settled' && x.order === 'notice-before-result' && x.deltaNoticeToResultMs !== null).map((x) => x.deltaNoticeToResultMs);
// 系列会话聚合（设计 §5 顶层 sessionIds：各系列取实际判定所用（末个）会话
// id；停摆换会话重试后取重试会话，全过程留痕在 evidence.sessions）。
evidence.sessionIds = {
  sg: (evidence.sessions.filter((s) => s.label === 'sg' || s.label === 'sg-停摆重试').at(-1) ?? {}).sessionId ?? null,
  sg3: (evidence.sessions.filter((s) => s.label === 'sg3' || s.label === 'sg3-停摆重试').at(-1) ?? {}).sessionId ?? null,
  ir: (evidence.sessions.filter((s) => s.label === 'ir' || s.label === 'ir-停摆重试').at(-1) ?? {}).sessionId ?? null
};
evidence.sgAggregate = {
  trialsAttempted: sgStepsRun, trialsScored: sgPending.length, classes: sgClasses, perTrial: sgPending,
  classesNote: 'trialsAttempted＝挂起系列（SG-1/2）实际步数（不含 SG-3 入口变体——其单独见 entryTrial）；perTrial＝挂起系列条目（SG-3 入口条目单列于 entryTrial——基数与 trialsScored 一致）；类别计数＝挂起系列剔除入口污染试次后的干净分布（污染判定＝通知记录下标早于等待调用（任意档含 immediate）——计入 pollution 计数、不在此表）；FAIL 试次（两次尝试未成立）不入 trialsScored，明细在 steps.attempts 与 verdicts',
  entryTrial: sgEntry.length > 0 ? { classes: sgEntry.map((x) => x.class), note: sgEntry.map((x) => x.note ?? '') } : null,
  maxLagMs: lagSettledDeltas.length > 0 ? Math.max(...lagSettledDeltas) : null,
  conclusion: `${String(sgPending.length)} 次挂起系列自然结算（其中入口污染 ${String(polluted)} 次——单独落档、不参与下列类别计数）：滞后已交付 ${String(sgClasses['lag-settled'])} 次、即时 ${String(sgClasses.immediate)} 次、消息唤醒证实 ${String(sgClasses['message-wake-confirm'])} 次、无前缀 via 行档 ${String(sgClasses['settled-via-observed'])} 次、其余 ${String(sgClasses.other + sgClasses['budget-interrupt-pending'] + sgClasses['budget-interrupt-plain'])} 次${sgEntry.length > 0 ? `；入口变体（SG-3）${String(sgEntry.length)} 次：${sgEntry.map((x) => x.class).join('／')}` : ''}；次序＝记录下标判定、毫秒差＝首见墙钟（粒度 ≤4s；滞后宽度上界仅对通知先于返回的滞后档断言）；即时档机制句＝通知到达时复核现读已不运行；消息唤醒证实档＝唤醒时刻现读已不运行、通知到达与翻转不可分——三者不互相冒称`
};
const irClasses = { 'inject-during-step': 0, 'followup-after-idle': 0, linger: 0 };
for (const trial of irTrials) irClasses[trial.class] = (irClasses[trial.class] ?? 0) + 1;
evidence.irAggregate = {
  trials: irTrials.length, classes: irClasses, perTrial: irTrials,
  // 聚合层 reminder：立即执行序列下 lingerTrial 在 IR-5 后即置空——观测值
  // 直接从 perTrial 的滞留条目取（未滞留／未触发恢复观察时为 null）。
  reminderSeen: irTrials.find((e) => e.reminderSeen !== undefined)?.reminderSeen ?? null,
  conclusion: `${String(irTrials.length)} 次忙碌无活等待回合的结算：忙碌窗内 inject ${String(irClasses['inject-during-step'])} 次（同回合补步领取——判据＝注入记录之前领取 splice **组只含 next-step**）、空闲后 followup ${String(irClasses['followup-after-idle'])} 次（宿主开回合领取——判据＝**组含 next-turn**（组＝相邻串，回合边界形态下可能只含尾 splice；判别以组内含 next-turn 为准）），LA-5 的次序版）、滞留 ${String(irClasses.linger)} 次${irClasses.linger > 0 ? '（恢复见 IR-5）' : ''}；领取的结构性主锚为完成消息记录（未领取的消息不进转录）与领取 splice 组构成，模型回执只作旁证`
};
log(`SG 汇总：${evidence.sgAggregate.conclusion}`);
log(`IR 汇总：${evidence.irAggregate.conclusion}`);

// 13) 收尾：停实例→留证据→清理→退出码。
await finish(null);
async function finish(forceExitCode) {
  killChild();
  await new Promise((r) => { setTimeout(r, 1500); });
  if (!keep) {
    try { rmSync(home, { recursive: true, force: true }); log(`已清理临时 home：${home}`); }
    catch { console.error(`[probe] WARN: 临时目录清理失败，留存现场：${home}`); }
  }
  try { rmSync(tgzPath, { force: true }); } catch { /* 产物清理尽力而为 */ }
  mkdirSync(join(repo, '.local'), { recursive: true });
  writeFileSync(join(repo, '.local', 'probe-settle-idle.json'), JSON.stringify(evidence, null, 2));
  log(`证据落盘：${join('.local', 'probe-settle-idle.json')}（本机材料目录）`);
  if (forceExitCode !== null) process.exit(forceExitCode);
  const failures = verdicts.filter((v) => v.ok !== true).length;
  console.log(failures === 0 ? `\n判定：全部通过（${String(verdicts.length)} 项）` : `\n判定：${String(failures)} 项 FAIL（共 ${String(verdicts.length)} 项）`);
  process.exit(failures === 0 ? 0 : 1);
}
function killChild() {
  if (child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
  }
}
