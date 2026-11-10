/**
 * 并发等待与同批交付真机探针（VERIFY-01：需求 9.3.2 场景 2／场景 7 的
 * 实例层装置——「同时运行 A、B……同一领取窗口中已就绪的其他作业内容按
 * 同批预算交付」与「多作业并发、同拍完成……共享总内容预算」）。
 *
 * ## 探针在证什么
 *
 * 套件层（wait-delivery 等 744 用例）已锚定同批预算与延后规则；本
 * 探针在真实实例上以真实模型会话取证三个并发行为面，每条判据只认宿主侧
 * 载体（tool/result 文本、完成消息与注入消息、转录事件与时间戳），模型
 * 文本只作回执：
 *
 * 1. CW-1 指定目标等待＋非目标同批汇集（需求 9.3.2 场景 2 前半）：作业 A
 *    （约 15s）与 B（约 50s）先后起跑、等待只指定 B——A 更早完成，其正文
 *    应与等待交回同批到达（设计 2.6：活等待让位——完成消息路径让位、内容
 *    随等待返回交付；主体忙碌时先注入完成消息也是合法同批形态），不是另
 *    开新批；等待保持到 B 的事件（A 完成不提前唤醒——waitSpan 下界锚）。
 *    前提：探针起跑前把 minYieldMs 调至 1000（出厂默认 20000 会把 prompt
 *    的 yield_ms 8000 夹紧为 20s，A（15s）前台直付、检验面被旁路——二轮
 *    盲审实锤，lib/config.js resolveYield clamp）；生效后前台 8s 转后台：
 *    并行起跑形态 wait 起点约在起跑后 4s（A 剩 11s、B 剩 46s），串行形态
 *    约 19s（A 已完成经完成消息交付、B 剩 31s）；下界 25s 对正确路径都
 *    通过、误把 A 当唤醒条件的并行形态（约 11s）被拦。锚点为两极端形
 *    态，实测落在中间形态（如两 run 同批发起＋wait 单发，起点约 10s）
 *    同样自洽——判据窗口 25-200s 容纳一切中间起点，误触发拦截对任意
 *    起点恒成立（误触发 span＝15−起点 <15s，恒在下界之下）。极慢周转
 *    边界：wait 起点晚于约 25s 时正确实现 span<25s——假 FAIL 方向、
 *    有重试，按 FAIL 如实取证（与 CW-2 的极慢周转边界同类）。
 * 2. CW-2 多目标任一满足（需求「多目标采用任一满足即返回」）：作业 A
 *    （约 60s）与 B（约 25s）都在目标列表——B 先完成即交回；主锚＝A 正文
 *    缺席（误等全部目标时 A 正文会进入等待返回，缺席断言拦住该形态）＋
 *    B 正文在场（载体不限：等待返回或同窗完成消息——「因可用内容交回」
 *    的两形态都合法）；span 只排「挂满预算」异常（0-70s），不再承担
 *    「任一 vs 全部」的分隔（两起跑形态的 span 分布重叠，单阈值分不开）；
 * 3. CW-3 无目标等待＋同拍完成同批（需求 9.3.2 场景 7 的可脚本化子集）：
 *    两作业同时长（约 12s）同拍完成、等待不指定目标——两份正文并入同一次
 *    等待返回（同一领取窗口共享批预算），单次等待、无追加领取调用。
 *
 * 三步都断言「不附纯读取指令」（同窗无 job_output 调用——需求 9.3.2
 * 「不附纯读取指令」）与单次 async_wait（正文来源与时长锚定同一次调用）。
 *
 * 时间判据优先取转录时间戳（tool/call 与其后 tool/result 的 at 差；at 可能
 * 是 ISO 字符串或 epoch 毫秒数字，两种形态都解析；seq 缺席时按数组下标定位），
 * 时间戳缺席时以轮询墙钟回退（±一个轮询间隔）。每步超时或断言不成立同会话
 * 重试一次（模型偶发不执行单步指令不等于产品缺陷，重试留痕）。
 *
 * 装置边界（如实声明）：「等待取消与交付重叠」「条目上限 10／批预算截断的
 * 延后与恢复」「完成消息路径的批级配额」属套件层受控装置（test/
 * wait-delivery.test.mjs），真机内容量小、不足以触发上限，本探针不覆盖；
 * CW-1 的 A/B 起跑形态：各步 prompt 显式要求串行单工具调用（逐个等待
 * 结果）；模型违规并行时 span 配对可靠性下降（误差方向假 FAIL，重试自
 * 愈——模型稳定偏并行时不自愈，按 FAIL 如实取证）——断言只锚结果形态；
 * 「已有消息同窗交付不重复到等待返回」（去重义务）需要同窗
 * 消息与等待交回的精确重叠，真机时序不可控，不装置。「同批」断言以同窗
 * 近似（同一模型输入边界宿主不可辨：P 经上批完成消息＋Q 经等待返回也过
 * 判据）。作业命令依赖 PowerShell（Start-Sleep）——非 PowerShell 宿主上
 * 作业失败会以正文缺席形态按 FAIL 取证（非 FAULT），Linux 侧由问题清单
 * 另项追踪。**装置前提（设置）**：探针经公开设置接口把 minYieldMs 临时
 * 调至 1000（出厂默认 20000 会把 prompt 的 yield_ms 8000 夹紧为 20s——
 * lib/config.js resolveYield clamp、需求 622 明文；CW-1 的 A 15s 与 CW-3
 * 的 P/Q 12s 将前台直付不转后台，核心检验面被旁路——该缺陷由二轮盲审
 * 实锤，修复前的两轮实测数值按夹紧形态解读、不作为检验面通过的依据）。
 * 首跑（设置前提修复前）CW-3 出现 span≈121s（挂满 120s 预算才交回两正文）
 * 形态，成因未定：夹紧世界的复跑未复现只能弱排除（P/Q 前台直付、就绪
 * 通道未被压到）；设置修复后挂起路径才真正受压，判据保留「挂满预算按
 * FAIL 拦截」，复现即转入问题清单查实现。
 *
 * ## 用法
 *
 *   node verify/probe-concurrent-wait.mjs --service-root <宿主服务根> \
 *     --host-subdir <宿主树目录名，如 dsh-0.2.1-rc.5> [--repo <本仓路径>] [--keep]
 *
 * `--service-root` 必填（或设 `DSAT_SERVICE_ROOT`）。探针以
 * `<serviceRoot>/patches/zai-glm.yml` 作为实例模型路由 patch——该文件由本机
 * 部署环境提供，缺失时实例在就绪等待处 FAULT（90s 超时＋stderr 尾部），请
 * 自备同位 patch 或改用 --service-root 指向提供该 patch 的根。装置前提：
 * 探针经公开设置接口把 minYieldMs 临时调至 1000（收尾恢复）——三步短窗
 * 作业的转后台前提。tgz 产物结束自清；证据 JSON 每次落盘保留在 `.local/`
 * （FAULT 路径的 tgz 不清，重跑前可手动清理）。退出码：0＝全部判定通过；
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
      writeFileSync(join(repo, '.local', 'probe-concurrent-wait.json'), JSON.stringify({ ...evidence, fault: String(msg) }, null, 2));
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
home = mkdtempSync(join(tmpdir(), 'dsh-conc-wait-'));
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
  // 建双会话或重复指令；其余端点（list/page，及本探针的 settings/update、
  // settings/mutate——固定值写与固定路径 unset，等值重发收敛无害）失败重试
  // 一次。两分支统一解析。
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

// 装置前提：短窗作业需要 minYieldMs 下限低于 prompt 的 yield_ms——出厂默认
// 20000 会把 yield_ms 8000 夹紧为 20s（lib/config.js resolveYield clamp；需求
// 622「显式短 yield_ms 按生效下限夹紧」），CW-1 的 A（15s）与 CW-3 的 P/Q
// （12s）将在首次等待内前台直付、不转后台，「非目标同批」与「同拍同批」
// 检验面被旁路。经公开设置接口临时调低（与套件层短窗用例同款手法——
// test/wait-delivery.test.mjs 装置段「不吃出厂下限 20000 的夹紧」），
// 记录原用户覆盖、收尾恢复。
const settingsNS = 'async-tools-host';
const describedSettings = await rpcOk('settings/describe', {});
const settingsRow = describedSettings.namespaces.find((n) => (n.ns ?? n.namespace ?? n.id) === settingsNS);
if (settingsRow === undefined || typeof settingsRow.value?.settings !== 'object') {
  killChild(); fail(`settings/describe 缺少 ${settingsNS} 行（宿主行没激活？）`);
}
const minYieldBefore = settingsRow.value.settings.minYieldMs;
const minYieldHadUserOverride = settingsRow.user?.settings?.minYieldMs !== undefined;
const minYieldUserBefore = settingsRow.user?.settings?.minYieldMs;
await rpcOk('settings/update', { ns: settingsNS, patch: { settings: { minYieldMs: 1000 } } });
const describedAfter = await rpcOk('settings/describe', {});
const settingsRowAfter = describedAfter.namespaces.find((n) => (n.ns ?? n.namespace ?? n.id) === settingsNS);
if (settingsRowAfter?.value?.settings?.minYieldMs !== 1000) {
  killChild(); fail(`minYieldMs 调低未生效：${String(settingsRowAfter?.value?.settings?.minYieldMs)}`);
}
log(`minYieldMs=${String(minYieldBefore)}→1000（装置前提：短窗转后台；收尾恢复）`);
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
/** 本步窗口内各工具的调用次数（单次等待锚：正文来源与时长锚定同一次调用）。 */
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
/** async_wait 挂起时长与其返回文本：以数组下标取「fromIndex 之后」的最后一个
 *  tool/call(name=async_wait) 与其后第一个 tool/result——装置假设模型按指令
 *  串行单工具调用（各步 prompt 均显式要求 issue each call in sequence and
 *  wait for its result），并行调用时配对可能失准，误差方向是假 FAIL（重试
 *  自愈）而非假 PASS。优先转录 at 时间戳，缺席时由调用侧用轮询墙钟回退
 *  （±一个轮询间隔）。 */
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
      // 时间戳合法性：at 缺席或差值为负（乱序/异常）都交墙钟回退，负 span
      // 不进入断言（下界型断言对负值恒假会误判、上界型恒真会架空判据）。
      const diff = callAt !== null && at !== null ? at - callAt : null;
      const content = records[j].event.data?.message?.content ?? [];
      const resultText = content.filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('\n');
      return { callSeen: true, resultSeen: true, spanMs: diff !== null && Number.isFinite(diff) && diff >= 0 ? diff : null, resultText };
    }
  }
  return { callSeen: true, resultSeen: false, spanMs: null, resultText: '' };
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
    // 失败时沿用上一成功基线（首步按 0）并打标——退化窗会把前步等待计入
    // singleWait／span 配对（假 FAIL 方向），留痕供离线区分退化与真 FAIL。
    let beforeCount = lastBaselineShared.value;
    let baselineDegraded = false;
    try {
      beforeCount = (await transcriptOf()).records?.length ?? 0;
      lastBaselineShared.value = beforeCount;
    } catch { baselineDegraded = beforeCount !== 0; }
    // 墙钟回退：首次观察到本步 async_wait 调用与其结果的时刻（±轮询间隔）。
    let wallCallAt = null;
    let wallResultAt = null;
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
      const spanInfo = waitSpanSince(transcript, beforeCount);
      if (spanInfo.callSeen && wallCallAt === null) wallCallAt = Date.now();
      if (spanInfo.callSeen && spanInfo.spanMs === null && wallResultAt === null && spanInfo.resultSeen === true) wallResultAt = Date.now();
      const wallSpan = wallCallAt !== null && wallResultAt !== null ? wallResultAt - wallCallAt : null;
      const ctx = {
        modelTexts: modelTexts(transcript, beforeCount),
        toolResults: toolResultTexts(transcript, beforeCount),
        toolNames: toolCallNames(transcript, beforeCount),
        toolCallCounts: toolCallCounts(transcript, beforeCount),
        completions: completionSends(transcript, beforeCount),
        waitSpan: spanInfo.spanMs ?? wallSpan,
        waitResultText: spanInfo.resultText
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
        modelTail: ctx.modelTexts.slice(-5).map((t) => t.slice(-250)),
        waitSpan: ctx.waitSpan,
        waitResultTail: ctx.waitResultText.slice(-400)
      };
    }
    record.attempts.push({ attempt, ok: false, detail: lastDetail, baselineDegraded });
    log(`步骤 ${step.name} 第 ${String(attempt)} 次未成立（${lastDetail}）${attempt === 1 ? '，重试一次' : ''}`);
  }
  judge(step.name, false, `两次尝试未成立；最后状态：${String(evidence.steps.at(-1).attempts.at(-1).detail)}`);
  return false;
}

console.log(`\n── CW-1 指定目标等待＋非目标同批汇集（A≈15s／B≈50s，只等 B）（当前候选 ${head}${dirty}）──`);
await driveStep({
  name: 'CW-1 非目标正文与等待交回同批到达',
  // 两作业起跑形态（并行一次消息或先后两次调用）都接受——判据只锚结果：
  // B 正文经等待返回、A 正文同批在场、span 下界不被 A 完成时刻顶穿。
  // 时距设定按两形态的算术最坏侧：并行形态 wait 起点约在起跑后 4s（A 剩
  // 11s），若误把非目标 A 当唤醒条件 span≈11s；串行形态 wait 起点约在
  // 起跑后 19s（A 已完成、经完成消息交付），span 贴 B 剩余约 31s。下界
  // 25s 对两形态的正确路径都通过、对误触发形态都拦住。
  prompt: 'Run this single step, issuing each tool call in sequence and waiting for its result before the next call, and reply with exactly the token CW1_DONE: (1) start job A with async_run: command "Start-Sleep -Seconds 15; Write-Output CW1-A-5e8", description "cw1 job A", yield_ms 8000; (2) start job B with async_run: command "Start-Sleep -Seconds 50; Write-Output CW1-B-3d6", description "cw1 job B", yield_ms 8000; (3) immediately call async_wait with targets [{kind:"job", id:<B job_id>}] and wait_ms 240000, waiting inline until it returns — job A is NOT a target, its earlier completion must NOT end the wait early; (4) after the wait returns, reply CW1_DONE — job A result may have reached you earlier as a completion notice, that is fine. No other tools, no extra waits, no job_output, no questions.',
  judge: (ctx) => {
    const singleWait = (ctx.toolCallCounts.get('async_wait') ?? 0) === 1;
    const bInWait = ctx.toolResults.some((t) => t.includes('CW1-B-3d6'));
    // A 同批在场：等待返回（tool/result——等待返回本体）或同窗完成消息
    // （completions——主体忙碌时先注入完成消息也是设计允许的同批形态）。
    const aInBatch = ctx.toolResults.some((t) => t.includes('CW1-A-5e8')) || ctx.completions.some((t) => t.includes('CW1-A-5e8'));
    const aCarrier = ctx.toolResults.some((t) => t.includes('CW1-A-5e8')) ? '等待返回' : (ctx.completions.some((t) => t.includes('CW1-A-5e8')) ? '完成消息' : '缺席');
    const span = ctx.waitSpan;
    // 正确形态 span 贴 B 剩余（并行约 46s／串行约 31s±周转）；误把 A 当
    // 唤醒条件（并行形态 A 剩约 11s）会被下界拦住。上界远低于 240s 预算
    // （到期出口属 FAIL 方向）。
    const heldToB = span !== null && span >= 25_000 && span < 200_000;
    const noReadTool = !ctx.toolNames.has('job_output');
    const receipt = ctx.modelTexts.some((t) => t.includes('CW1_DONE'));
    const ok = singleWait && bInWait && aInBatch && heldToB && noReadTool && receipt;
    return { ok, detail: ok ? `B 正文经等待返回＋A 正文同批在场（载体：${aCarrier}）＋单次等待挂起 ${String(Math.round(span / 1000))}s 贴 B（不被 A 时刻顶穿）＋无 job_output＋回执` : `单次等待 ${String(singleWait)}（${String(ctx.toolCallCounts.get('async_wait') ?? 0)} 次）／B 正文 ${String(bInWait)}／A 同批 ${String(aInBatch)}（${aCarrier}）／贴 B ${String(heldToB)}（${span === null ? '未取得' : `${String(Math.round(span / 1000))}s`}）／无 job_output ${String(noReadTool)}／回执 ${String(receipt)}` };
  }
});

console.log('\n── CW-2 多目标任一满足即返回（A≈60s／B≈25s，都在目标列表）──');
await driveStep({
  name: 'CW-2 任一目标完成即交回（B 先、A 后）',
  prompt: 'Run this single step, issuing each tool call in sequence and waiting for its result before the next call, and reply with exactly the token CW2_DONE: (1) start job A with async_run: command "Start-Sleep -Seconds 60; Write-Output CW2-A-7f1", description "cw2 job A", yield_ms 8000; (2) start job B with async_run: command "Start-Sleep -Seconds 25; Write-Output CW2-B-9b4", description "cw2 job B", yield_ms 8000; (3) immediately call async_wait with targets [{kind:"job", id:<A job_id>}, {kind:"job", id:<B job_id>}] and wait_ms 240000, waiting inline — ANY ONE target completing ends the wait (B finishes first); do NOT wait for all targets, do NOT issue a second wait; (4) after the single wait returns (carrying job B result), reply CW2_DONE and end your turn — do NOT wait for job A again, do NOT kill it. No other tools, no job_output, no questions.',
  judge: (ctx) => {
    const singleWait = (ctx.toolCallCounts.get('async_wait') ?? 0) === 1;
    // B 正文在场（载体不限：等待返回或同窗完成消息——两起跑形态下 B 完成
    // 时刻可能早于或晚于等待发起，「因可用内容交回」与「活等待期间唤醒」
    // 都是需求允许的正确形态）。
    const bTriggered = ctx.toolResults.some((t) => t.includes('CW2-B-9b4')) || ctx.completions.some((t) => t.includes('CW2-B-9b4'));
    // 主锚：A（约 60s，远晚于 B）正文不得出现在本窗任何 tool/result 或完成
    // 消息——误等全部目标（无论模型违规还是实现挂到全部目标）时 A 正文会
    // 进入等待返回，缺席断言拦住该形态。A 残留作业的迟到完成消息在回合结
    // 束后注入，不在本窗。
    const aAbsent = !ctx.toolResults.some((t) => t.includes('CW2-A-7f1')) && !ctx.completions.some((t) => t.includes('CW2-A-7f1'));
    const span = ctx.waitSpan;
    // span 只排「挂满预算」异常（两起跑形态的正确 span 分布约 0-25s，重叠
    // 区间不再承担「任一 vs 全部」的分隔——该分隔由 aAbsent 承担）。
    const notFull = span !== null && span >= 0 && span < 70_000;
    const noReadTool = !ctx.toolNames.has('job_output');
    const receipt = ctx.modelTexts.some((t) => t.includes('CW2_DONE'));
    const ok = singleWait && bTriggered && aAbsent && notFull && noReadTool && receipt;
    return { ok, detail: ok ? `B 正文到达（任一满足即返回，载体不限）＋A 正文缺席（未等全部）＋单次等待挂起 ${String(Math.round(span / 1000))}s＋无 job_output＋回执` : `单次等待 ${String(singleWait)}（${String(ctx.toolCallCounts.get('async_wait') ?? 0)} 次）／B 触发 ${String(bTriggered)}／A 缺席 ${String(aAbsent)}／未挂满 ${String(notFull)}（${span === null ? '未取得' : `${String(Math.round(span / 1000))}s`}）／无 job_output ${String(noReadTool)}／回执 ${String(receipt)}` };
  }
});

console.log('\n── CW-3 无目标等待＋同拍完成同批（两作业各≈12s 同拍结算）──');
await driveStep({
  name: 'CW-3 同拍完成两正文并入同一次等待返回',
  prompt: 'Run this single step, issuing each tool call in sequence and waiting for its result before the next call, and reply with exactly the token CW3_DONE: (1) start two jobs, both with async_run: job P with command "Start-Sleep -Seconds 12; Write-Output CW3-P-2c9", description "cw3 job P", yield_ms 8000; job Q with command "Start-Sleep -Seconds 12; Write-Output CW3-Q-6a5", description "cw3 job Q", yield_ms 8000; (2) immediately call async_wait with NO targets (omit targets entirely) and wait_ms 120000, waiting inline — both jobs finish at about the same moment; BOTH results should arrive together in that single wait return (or as completion notices in the same window); (3) after the wait returns, reply CW3_DONE. No other tools, no extra waits, no job_output, no questions.',
  judge: (ctx) => {
    const singleWait = (ctx.toolCallCounts.get('async_wait') ?? 0) === 1;
    // 两正文载体不限（等待返回∪完成消息）：两起跑形态下结算时刻可能早于
    // 等待发起（完成消息先注入）或晚于（并入等待返回），主锚＝单次等待＋
    // 两正文都在场＋span 未挂满预算。
    const pArrived = ctx.toolResults.some((t) => t.includes('CW3-P-2c9')) || ctx.completions.some((t) => t.includes('CW3-P-2c9'));
    const qArrived = ctx.toolResults.some((t) => t.includes('CW3-Q-6a5')) || ctx.completions.some((t) => t.includes('CW3-Q-6a5'));
    // 首跑实测出现过「挂满 120s 预算才交回已就绪内容」形态（span≈121s），
    // 成因未定（见头注装置边界）：不排除实现侧就绪唤醒／复查通道低概率
    // 缺口——挂满预算交回按 FAIL 取证，复现即转入问题清单查实现。
    const span = ctx.waitSpan;
    const notFull = span !== null && span >= 0 && span < 70_000;
    const noReadTool = !ctx.toolNames.has('job_output');
    const receipt = ctx.modelTexts.some((t) => t.includes('CW3_DONE'));
    const ok = singleWait && pArrived && qArrived && notFull && noReadTool && receipt;
    return { ok, detail: ok ? `P、Q 两正文到场（单次等待窗口）＋挂起 ${String(Math.round(span / 1000))}s（同拍交回）＋无 job_output＋回执` : `单次等待 ${String(singleWait)}（${String(ctx.toolCallCounts.get('async_wait') ?? 0)} 次）／P ${String(pArrived)}／Q ${String(qArrived)}／未挂满 ${String(notFull)}（${span === null ? '未取得' : `${String(Math.round(span / 1000))}s`}）／无 job_output ${String(noReadTool)}／回执 ${String(receipt)}` };
  }
});

// 6) 收尾：恢复设置→停实例→等句柄释放→留证据→清理（--keep 时保留临时 home）。
try {
  // 恢复 minYieldMs：原状有用户覆盖则回写原值，否则 unset 回继承值（临时
  // 实例生命周期即止，恢复是设置链规范动作而非必要善后）。恢复走 rpc 手工
  // 检查（不用 rpcOk）：应用层失败只 WARN，不把可能已全过的判定运行改写
  // 为 FAULT 退出码——与「非必要善后」的降级意图一致（0/1/2 契约不混同）。
  const restore = minYieldHadUserOverride
    ? await rpc('settings/update', { ns: settingsNS, patch: { settings: { minYieldMs: minYieldUserBefore } } })
    : await rpc('settings/mutate', { ns: settingsNS, ops: [{ op: 'unset', path: ['settings', 'minYieldMs'] }] });
  if (restore.ok === true) log(`minYieldMs 已恢复（原值 ${String(minYieldBefore)}）`);
  else log(`WARN: minYieldMs 恢复被设置链拒绝（临时实例生命周期即止）：${JSON.stringify(restore.error).slice(0, 160)}`);
} catch (error) { log(`WARN: minYieldMs 恢复失败（临时实例生命周期即止）：${String(error?.message ?? error)}`); }
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
writeFileSync(join(repo, '.local', 'probe-concurrent-wait.json'), JSON.stringify(evidence, null, 2));
log(`证据落盘：${join('.local', 'probe-concurrent-wait.json')}（本机材料目录）`);
const failures = verdicts.filter((v) => v.ok !== true).length;
console.log(failures === 0 ? `\n判定：全部通过（${String(verdicts.length)} 项）` : `\n判定：${String(failures)} 项 FAIL（共 ${String(verdicts.length)} 项）`);
process.exit(failures === 0 ? 0 : 1);
