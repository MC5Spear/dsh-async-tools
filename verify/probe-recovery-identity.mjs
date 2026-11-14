/**
 * 消息身份确认与取消可达性的实例级时序探针（§9.4① 真实宿主时序证据＋
 * ④ CANCELLED-CREATION 可达性探针；装置对 0.2.2 与 0.2.1 两线通用）。
 *
 * ## 探针在证什么（转录可见面）
 *
 * claimed／discarded 事件不进转录——身份匹配机制本身由套件层 T-RC-1（真
 * agent-loop 装置）与 RM-MATRIX／RM-IDLE 锚定；本探针补**真实宿主**的消息
 * 形态与时序：
 *  - RI-1 多条排队完成消息：忙碌窗（首等中阻塞命令）内多作业错峰结算 →
 *    逐条独立 user/message（source.kind=async-tools-job-result）注入；回合
 *    收尾后全部被领取消费（模型下轮可读）。
 *  - RI-2 完成消息与普通消息交错：忙碌窗内先入一条普通排队消息、完成消息
 *    后至——两类载体都在册、都被消费，无丢失。
 *  - RI-4 一条消息携多作业：空闲主体同窗结算的多作业合并为恰一条完成消息
 *    （一载体多份额同 id 形态的实例面）。装置边界：自然模型流中三个作业经
 *    模型步进串行发出、启动间隔常被拉开而不同窗结算——本步按信息项登记
 *    （「自然流未复现」不判产品红；合并形态由受控锚 RM-IDLE 承担）。
 *  - RI-3 先丢弃再领取（尝试）：忙碌窗排队消息＋session/cancel——RPC 面不
 *    可触发 discard（事件不进转录、pending 消息取消后不可见），如实登记为
 *    装置边界缺口（事件形态由 T-RC-1 ⑥ 真投影锚定）。
 *  - RC-1 取消可达性（④ 登记的实例级探针，预期不可达）：首等窗内长命令
 *    执行中取消会话 → 会话停止运行（runGroup 排空、无悬挂）＝与「窗口不可
 *    达」契约判定一致。装置边界：宿主 tool/call 记录先于派遣入转录，转录
 *    不可判派遣时点——「取消后作业正文经等待照达」子项若命中取消落在派遣
 *    前（无作业可领）按未取得登记，不判产品红。
 *
 * 模型依从性边界：RI-1 阻断回合超时、RI-2 消费回显未取得均按信息项登记
 * （单步指令的模型依从波动不判产品红）；核心判据（注入形态、交错在册、
 * 会话停止）才计退出码。
 *
 * ## 装置
 *
 * 候选 tgz（npm pack --ignore-scripts）→ 独立 DSH_HOME → 官方 CLI 安装 →
 * 随机端口隔离实例（--host 127.0.0.1 --port 0）→ RPC 驱动真实模型会话
 * （凭据自 --r 部署读 ZAI_API_KEY，仅注入子进程环境，不落证据文件）→ 收尾
 * 杀进程树并清运行目录。机器坐标全部外部传入（判据 12）；两线示例：
 *   022：node verify/probe-recovery-identity.mjs --host-root <0.2.2-rc.1 安装树> --r <部署> --label 022
 *   021：node verify/probe-recovery-identity.mjs --host-root <dsh-0.2.1-rc.5 树> --r <部署> --label 021
 *
 * ## 输入契约（DOC-03 统一）
 *
 * - `--host-root`（或环境 DSAT_HOST_MODULES）：宿主树，接受两种形态并**归一**
 *   ——模块树本身（basename 为 node_modules，或树下已有 `@deepseek-ai/`）直接
 *   使用；安装树（其下才有 node_modules/）补 node_modules。归一后的 CLI 实际
 *   路径随启动日志打印，供核对来源；不再对环境变量无条件拼接 node_modules。
 * - `--model-patch`（或环境 DSAT_MODEL_PATCH）：模型路由 patch 显式入口（与
 *   probe-workflow-engine 同款）；缺省依次找 `<R>/patches/zai-glm.yml`、
 *   `<R>/ops/patches/zai-glm.yml`。patch 缺失＝启动前置检查 FAULT（退出码 2，
 *   指向 verify/patches/model-routing.example.yml 模板），不进入会话阶段。
 * - `--repo` 默认本脚本所在树（跨树取证显式传）；`--label` 进证据文件名。
 *
 * ## 运行目录与清理域（DOC-06）
 *
 * 运行目录 `.local/tmp/reid-<label>-<时间戳>-<pid>` 唯一命名，内含 home／
 * playground／tgz／所有权标记 `PROBE-OWNED`——起跑**不删除任何既有目录**，
 * 重跑／并行互不覆盖；全部退出路径（前置失败、实例未就绪、判据完成）统一
 * 收尾：杀实例进程树＋整目录删除。共享 npm 缓存（`.local/npm-cache`）非本次
 * 运行私有，不在清理域内。证据写 `<repo>/.local/evidence/probe-recovery-
 * identity-<label>.json`（不含 token/密钥）。退出码 0＝核心判据全过；
 * 1＝核心判据有 FAIL；2＝装置自身故障；3＝未执行（无凭据 SKIP，落 skipped 标记证据）。
 *
 * ## RPC 纪律（DOC-07，对齐 verify/_rpc.mjs 只读重试口径）
 *
 * API fetch 一律 `redirect:'manual'`；仅只读方法（session/list、session/page）
 * 在 fetch 拒绝时自动重试一次；写方法（session/create、session/prompt、
 * session/cancel）不自动重发——响应丢失不等于未执行；任何 3xx 按错误处理
 * （凭据不随跳转重发）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authCookieFromFirstHop, assertApiNotRedirected } from './_auth.mjs';

// ── 参数（机器坐标一律外部传入——判据 12：交付代码不内置开发机路径） ─────────
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
// 默认 REPO＝本脚本所在 verify/ 的上一级（探针随树分发、默认即本树候选；
// 跨树取证用 --repo 显式指向另一树）。
const REPO = opt('repo') ?? resolve(import.meta.dirname, '..');
const LABEL = opt('label') ?? 'run';
const R = opt('r');
if (R === undefined) {
  console.error('需要 --r <dsh-service 部署根>（读其 .env 的 ZAI_API_KEY；模型路由 patch 亦默认在其中找）');
  process.exit(2);
}
// 宿主树归一（DOC-03）：--host-root 显式优先，环境 DSAT_HOST_MODULES 兜底——
// 环境语义与测试套件一致＝**模块树本身**；两来源统一按「模块树直接用、安装
// 树补 node_modules」归一，不再无条件拼接。归一结果打印供核对。
const HOST_ROOT = opt('host-root') ?? process.env.DSAT_HOST_MODULES;
if (HOST_ROOT === undefined) {
  console.error('需要 --host-root <宿主树>（或环境 DSAT_HOST_MODULES＝模块树）——021 线配 rc.5 树、022 线配 0.2.2-rc.1 树');
  process.exit(2);
}
const hostBinOf = (root) => (/[\\/]node_modules$/.test(root) || existsSync(join(root, '@deepseek-ai/dsh'))
  ? join(root, '@deepseek-ai/dsh/lib/bin.js')
  : join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'));
const BIN = hostBinOf(HOST_ROOT);
if (!existsSync(BIN)) {
  console.error(`宿主树未找到 CLI：${BIN}——--host-root / DSAT_HOST_MODULES 指的树对吗？`);
  process.exit(2);
}
// 模型路由 patch（DOC-03）：显式参数/环境优先；缺省按公开准备说明找
// <R>/patches/zai-glm.yml，兼容 <R>/ops/patches/zai-glm.yml（历史部署形态）。
// 缺失＝启动前置检查 FAULT，不带着错误前提进入会话阶段。
const MODEL_PATCH = opt('model-patch') ?? process.env.DSAT_MODEL_PATCH ?? null;
const PATCH_CANDIDATES = [MODEL_PATCH, join(R, 'patches/zai-glm.yml'), join(R, 'ops/patches/zai-glm.yml')]
  .filter((p) => p !== null);
const PATCH = PATCH_CANDIDATES.find((p) => existsSync(p));
const OUT_DIR = join(REPO, '.local/evidence');
// 唯一运行目录＋所有权标记（DOC-06）：起跑不删任何既有目录；全部退出路径
// 统一清整个运行目录（见 cleanup）。
const RUN_STAMP = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${String(process.pid)}`;
const RUN_DIR = join(REPO, '.local/tmp', `reid-${LABEL}-${RUN_STAMP}`);
const HOME = join(RUN_DIR, 'home');
const PLAYGROUND = join(RUN_DIR, 'playground');
const EVIDENCE = join(OUT_DIR, `probe-recovery-identity-${LABEL}.json`);
let child = null;
// 统一收尾（DOC-06）：杀实例进程树＋删整个运行目录（home/playground/tgz/标记）；
// 共享 npm 缓存不在域内。所有失败/完成路径都经本函数，不留早退泄漏。删除遇
// Windows 文件锁（EBUSY/EPERM）只告警留现场——cleanup 自身永不抛（进程级兜底
// 路径里再抛会把 Node 打成 fatal，清理反而做不完）。
const cleanup = () => {
  if (child !== null) {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { /* 已退出 */ }
  }
  try {
    rmSync(RUN_DIR, { recursive: true, force: true });
  } catch (rmError) {
    console.error(`[launcher] WARN: 运行目录清理失败，留存现场：${RUN_DIR}（${String(rmError?.message ?? rmError)}）`);
  }
};
const die = (code, message) => { console.error(message); cleanup(); process.exit(code); };
// 进程级兜底（DOC-06）：先于任何目录创建（含证据目录与运行目录）注册——本文件
// 任何未捕获异常都统一转 die() 清理并以 2 收束，不混入「1＝核心 FAIL」档，也不留
// 「目录已建、兜底未挂」的窗口。
process.on('uncaughtException', (err) => { die(2, `FAULT：未捕获异常（${String(err instanceof Error ? err.stack : err)}）——运行目录已随收尾清除`); });
process.on('unhandledRejection', (err) => { die(2, `FAULT：未处理的 Promise 拒绝（${String(err instanceof Error ? err.stack : err)}）——运行目录已随收尾清除`); });
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(RUN_DIR, { recursive: true });
writeFileSync(join(RUN_DIR, 'PROBE-OWNED'), JSON.stringify(
  { probe: 'probe-recovery-identity', label: LABEL, pid: process.pid, startedAt: new Date().toISOString(), repo: REPO }, null, 2));
mkdirSync(HOME, { recursive: true });
mkdirSync(PLAYGROUND, { recursive: true });

// ── 凭据（只进子进程环境；证据与日志不落密钥） ──────────────────────────────
// 环境已带 ZAI_API_KEY 则直用；否则读 --r 部署的 .env。
let ZAI = process.env.ZAI_API_KEY ?? '';
if (ZAI === '') {
  for (const line of readFileSync(join(R, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*ZAI_API_KEY\s*=\s*(.+)\s*$/);
    if (m) ZAI = m[1].replace(/^["']|["']$/g, '');
  }
}
if (ZAI === '') {
  // 未执行≠全过（退出码契约）：专用退出码 3＋skipped 证据，防止无凭据环境的
  // 批处理把「跳过」读成「核心判据全过」，也避免旧证据文件被误读为本轮结果。
  writeFileSync(EVIDENCE, JSON.stringify(
    { label: LABEL, host: HOST_ROOT, skipped: true, reason: 'no ZAI_API_KEY (env and --r deployment .env)', at: new Date().toISOString() },
    null, 2));
  die(3, 'SKIP：环境与 --r 部署的 .env 均无 ZAI_API_KEY（实例判据只对开发机临时实例有意义）——退出码 3＝未执行');
}
if (PATCH === undefined) {
  die(2, `FAULT：模型路由 patch 缺失（尝试：${PATCH_CANDIDATES.join(' ; ')}）——按 verify/patches/model-routing.example.yml 准备后放缺省路径，或用 --model-patch / DSAT_MODEL_PATCH 显式传入`);
}
const CHILD_ENV = { ...process.env, DSH_HOME: HOME, ZAI_API_KEY: ZAI };
console.log(`[launcher] host bin = ${BIN}`);
console.log(`[launcher] model patch = ${PATCH}`);

// ── 1) 打包候选 tgz ─────────────────────────────────────────────────────────
const packRun = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', RUN_DIR, '--cache', join(REPO, '.local/npm-cache')],
  { cwd: REPO, encoding: 'utf8', shell: true, timeout: 300000 });
// spawn 层失败（如受限沙箱 EPERM 击杀）时 stdout 缺失，下面直接 match 会 TypeError
// 绕过一切收尾——先判空走 die()（DOC-06：全退出路径统一清理运行目录）。
if (packRun.error !== undefined || typeof packRun.stdout !== 'string') {
  die(2, `FAULT：npm pack 未运行（spawn：${String(packRun.error ?? 'stdout 缺失')}）——运行目录已随收尾清除`);
}
const tgzName = (packRun.stdout.match(/dsh-async-tools-[^\s]+\.tgz/g) ?? []).pop();
if (tgzName === undefined) {
  die(2, `npm pack 未产出 tgz：${packRun.stdout?.slice(-400) ?? ''} ${packRun.stderr?.slice(-400) ?? ''}`);
}
const TGZ = join(RUN_DIR, tgzName);

// ── 2) 插件安装（官方 CLI） ─────────────────────────────────────────────────
const install = spawnSync('node', [BIN, 'plugin', '--profile', 'web', 'add', TGZ],
  { env: CHILD_ENV, encoding: 'utf8', timeout: 300000 });
if (install.status !== 0) {
  die(2, `plugin add 失败：${install.stdout ?? ''} ${install.stderr ?? ''}`);
}
console.log('[launcher] plugin add ok');

// ── 3) 起实例（随机端口；stdout 出带 token URL 即 web 就绪） ────────────────
child = spawn('node', [BIN, '--patch', PATCH, '--profile', 'web',
  '--host', '127.0.0.1', '--port', '0', '--no-open'],
{ env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stdout = ''; let stderrTail = '';
child.stdout.on('data', (c) => { stdout += c; });
child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-4000); });

const URL_RE = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9._~%-]+/;
let URL = null;
for (let i = 0; i < 120 && URL === null; i += 1) {
  const m = stdout.match(URL_RE);
  if (m) URL = m[0];
  else await new Promise((res) => setTimeout(res, 1000));
}
if (URL === null) {
  die(2, `实例 120s 未就绪；stderr 尾：${stderrTail}`);
}
console.log('[launcher] instance ready on', URL.split('?')[0]);

// ── RPC ─────────────────────────────────────────────────────────────────────
const ORIGIN = URL.split('/?')[0];
const TOKEN = URL.split('token=')[1];
// 认证首跳（DOC-07）：manual 重定向＋同源判定统一走 verify/_auth.mjs——
// 正常 cookie 交换（3xx＋Set-Cookie＋同源/缺席 Location）不跟随，跨源按错误。
// 首跳 fetch／判定抛错同样走 die()——本段在主 try 之外，裸抛会绕过收尾。
let COOKIE = '';
try {
  const indexResponse = await fetch(`${ORIGIN}/?token=${TOKEN}`, { redirect: 'manual' });
  COOKIE = authCookieFromFirstHop(indexResponse, ORIGIN);
} catch (authError) {
  die(2, `FAULT：认证首跳失败（${String(authError instanceof Error ? authError.message : authError)}）——运行目录已随收尾清除`);
}

// 只读方法（DOC-07）：无副作用，fetch 拒绝可安全重试一次；其余（create／
// prompt／cancel 等写方法）不自动重发——响应丢失不等于未执行。
const RETRYABLE_METHODS = new Set(['session/list', 'session/page']);

async function rpc(endpoint, args) {
  const body = JSON.stringify({ type: 'client-request', rpcId: `reid-${Math.random().toString(36).slice(2, 10)}`, method: endpoint, payload: { args } });
  const once = () => fetch(`${ORIGIN}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: COOKIE },
    body,
    redirect: 'manual'
  });
  let response;
  try {
    response = await once();
  } catch (connError) {
    if (!RETRYABLE_METHODS.has(endpoint)) {
      throw new Error(`${endpoint}：请求未获响应（${String(connError instanceof Error ? connError.message : connError)}）。`
        + '响应丢失不等于未执行——本方法不是只读方法，不自动重发（对齐 verify/_rpc.mjs 口径）。');
    }
    response = await once();
  }
  // API 被重定向＝错误：不跟随、不带凭据重发（DOC-07）。
  assertApiNotRedirected(response, endpoint);
  const text = await response.text();
  const parsed = JSON.parse(text);
  if (parsed?.result?.ok !== true) throw new Error(`${endpoint}: ${JSON.stringify(parsed?.result?.error ?? text.slice(0, 200))}`);
  return parsed.result.value;
}

async function rowOf(sessionId) {
  const listing = await rpc('session/list', { _request: {} });
  return listing.items.find((item) => item.sessionId === sessionId);
}
async function transcriptOf(sessionId) {
  const row = await rowOf(sessionId);
  return rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 1200 } });
}
async function promptOn(sessionId, text) {
  await rpc('session/prompt', { request: { requestId: `reid-${Math.random().toString(36).slice(2, 10)}`, sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Hong_Kong' } });
}
function completionRecords(transcript) {
  return (transcript.records ?? []).filter((r) => {
    if (r.event?.type !== 'user/message') return false;
    const message = r.event.data?.message ?? r.event.data;
    return (message?.source ?? {}).kind === 'async-tools-job-result';
  }).map((r, i) => {
    const message = r.event.data?.message ?? r.event.data;
    return { text: (message?.content ?? []).map((c) => String(c.text ?? '')).join('\n') };
  });
}
function userTexts(transcript) {
  return (transcript.records ?? []).filter((r) => r.event?.type === 'user/message').map((r) => {
    const message = r.event.data?.message ?? r.event.data;
    return { source: (message?.source ?? {}).kind ?? null, text: (message?.content ?? []).map((c) => String(c.text ?? '')).join('\n') };
  });
}
function modelTexts(transcript) {
  return (transcript.records ?? []).filter((r) => r.event?.type === 'assistant/message' || r.event?.type === 'model/message')
    .map((r) => (r.event.data?.message?.content ?? r.event.data?.content ?? []).map((c) => String(c.text ?? '')).join('\n'));
}
async function waitIdle(sessionId, token, maxMs) {
  const t0 = Date.now();
  for (;;) {
    const row = await rowOf(sessionId);
    const tr = await transcriptOf(sessionId);
    const seen = modelTexts(tr).some((t) => t.includes(token));
    if (seen && row.running !== true) return { transcript: tr, ms: Date.now() - t0 };
    if (Date.now() - t0 > maxMs) return { transcript: tr, ms: Date.now() - t0, timeout: true };
    await new Promise((res) => setTimeout(res, 2000));
  }
}
/** RC1 正文断言防子串误匹配：模型文本「cannot report RC1-BODY」不算正文到达。 */
const bodyDelivered = (modelText) => modelText.includes('RC1_DONE')
  && /(^|[^a-z])RC1-BODY([^a-z]|$)/.test(modelText)
  && !/cannot report RC1-BODY|aborted before dispatch|no job/i.test(modelText);

const verdicts = [];
const CORE = new Set();
function judge(name, kind, detail = '', core = false) {
  // kind：PASS / FAIL / SKIP（信息项）——仅 core=true 的 FAIL 计退出码。
  verdicts.push({ name, kind, core, detail: String(detail).slice(0, 500) });
  if (core) CORE.add(name);
  console.log(`${kind}  ${name}${detail === '' ? '' : `  —— ${String(detail).slice(0, 220)}`}`);
}
const evidence = { label: LABEL, host: HOST_ROOT, candidate: tgzName, origin: ORIGIN, steps: {} };
// 判级中途中止标记（退出码契约，README「0/1/2」）：主 try 内任何步骤抛错时置位，
// finally 以 2（装置故障）收束——否则 verdicts 为空会被 finally 读成「核心判据全过」
// 的 0，装置故障冒充全过。
let aborted = false;

try {
  // ── RI-4 空闲合并载体（信息项：自然流聚窗不可控，形态由受控锚承担） ──────
  const s4 = await rpc('session/create', { request: { cwd: PLAYGROUND, agentPreset: 'dsh-async' } });
  await promptOn(s4.sessionId, [
    'Isolated timing probe RI-4. Execute exactly, no questions:',
    'STEP 1 — in one batch (all three calls in ONE tool-call block, issued together) call async_run three times with commands: "Start-Sleep -Seconds 25; Write-Output RI4-A" / "Start-Sleep -Seconds 25; Write-Output RI4-B" / "Start-Sleep -Seconds 25; Write-Output RI4-C" (descriptions probe ri4 a/b/c). Take the job_ids but do NOT wait: no async_wait, no blocking parameter changes.',
    'STEP 2 — reply with exactly RI4_ARMED and end your turn immediately.'
  ].join('\n'));
  let r = await waitIdle(s4.sessionId, 'RI4_ARMED', 120000);
  let merged = null;
  for (let i = 0; i < 45 && merged === null; i += 1) {
    await new Promise((res) => setTimeout(res, 2000));
    const tr = await transcriptOf(s4.sessionId);
    const comps = completionRecords(tr);
    const withTokens = comps.filter((c) => /RI4-[ABC]/.test(c.text));
    if (withTokens.length > 0) {
      const allTokens = withTokens.length === 1 && withTokens[0].text.includes('RI4-A') && withTokens[0].text.includes('RI4-B') && withTokens[0].text.includes('RI4-C');
      merged = allTokens ? withTokens[0] : 'SPLIT';
    }
  }
  judge('RI-4 空闲同窗多作业合并为恰一条完成消息', merged !== null && merged !== 'SPLIT' ? 'PASS' : 'SKIP',
    merged === 'SPLIT'
      ? '自然流未复现（模型步进拉开启动间隔、不同窗结算）；形态由受控锚 RM-IDLE 承担（装置边界，不判产品红）'
      : merged === null ? '120s 内未见完成消息（信息项登记）' : '单条含 RI4-A/B/C', false);
  if (merged !== null && merged !== 'SPLIT') {
    await promptOn(s4.sessionId, 'Report only the distinct tokens (RI4-*) that reached you as injected job-result messages, one line, then end turn.');
    r = await waitIdle(s4.sessionId, 'RI4-A', 120000);
    const ok4 = !r.timeout && modelTexts(r.transcript).some((t) => t.includes('RI4-A') && t.includes('RI4-B') && t.includes('RI4-C'));
    judge('RI-4 合并消息被领取消费（模型下轮读到全部 token）', ok4 ? 'PASS' : 'SKIP', r.timeout ? '等待超时（模型依从性，信息项）' : 'ok', false);
  }
  evidence.steps.RI4 = { merged: merged !== 'SPLIT' && merged !== null };

  // ── RI-1 忙碌窗多条排队完成消息 ───────────────────────────────────────────
  const s1 = await rpc('session/create', { request: { cwd: PLAYGROUND, agentPreset: 'dsh-async' } });
  await promptOn(s1.sessionId, [
    'Isolated timing probe RI-1. Execute exactly, no questions:',
    'STEP 1 — in one batch call async_run three times with commands: "Start-Sleep -Seconds 22; Write-Output RI1-A" / "Start-Sleep -Seconds 24; Write-Output RI1-B" / "Start-Sleep -Seconds 26; Write-Output RI1-C" (descriptions probe ri1 a/b/c). Do NOT wait for them.',
    'STEP 2 — after STEP 1 returns, call async_run once with command "Start-Sleep -Seconds 40", description "ri1 blocker", yield_ms 60000, and wait for it inline.',
    'STEP 3 — after the blocker returns, reply with exactly RI1_DONE and end your turn. Do not call async_wait at any point. If job results reach you later as injected messages, reply with exactly RI1_SEEN then list the RI1-* tokens you read, no tools.'
  ].join('\n'));
  r = await waitIdle(s1.sessionId, 'RI1_DONE', 240000);
  if (r.timeout) judge('RI-1 阻断回合完成（前置）', 'SKIP', '模型依从性超时（信息项；注入判据不依赖本步）', false);
  let comps1 = [];
  for (let i = 0; i < 30; i += 1) {
    const tr = await transcriptOf(s1.sessionId);
    comps1 = completionRecords(tr).filter((c) => /RI1-[ABC]/.test(c.text));
    const row = await rowOf(s1.sessionId);
    if (comps1.length >= 3 || (comps1.length > 0 && row.running !== true)) break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  const perMessage = ['RI1-A', 'RI1-B', 'RI1-C'].map((tok) => comps1.filter((c) => c.text.includes(tok)));
  const splitOk = perMessage.every((hits) => hits.length === 1) && comps1.length === 3;
  judge('RI-1 忙碌窗逐条注入（三条独立 user/message，每条恰一 token）', splitOk ? 'PASS' : 'FAIL',
    `完成消息 ${String(comps1.length)} 条：${comps1.map((c) => String(c.text).slice(0, 40).replace(/\n/g, ' ')).join(' | ')}`, true);
  let seen1 = false;
  for (let i = 0; i < 20 && !seen1; i += 1) {
    const tr = await transcriptOf(s1.sessionId);
    const row = await rowOf(s1.sessionId);
    seen1 = modelTexts(tr).some((t) => t.includes('RI1-A') && t.includes('RI1-B') && t.includes('RI1-C'));
    if (!seen1 && row.running !== true) { await promptOn(s1.sessionId, 'List the RI1-* tokens that reached you as injected messages, one line, then end turn.'); }
    await new Promise((res) => setTimeout(res, 3000));
  }
  judge('RI-1 排队消息回合边界后被逐条领取（模型读到全部）', seen1 ? 'PASS' : 'FAIL', seen1 ? 'ok' : '60s 未确认', true);
  evidence.steps.RI1 = { split: splitOk, consumed: seen1 };

  // ── RI-2 完成消息与普通消息交错 ───────────────────────────────────────────
  const s2 = await rpc('session/create', { request: { cwd: PLAYGROUND, agentPreset: 'dsh-async' } });
  await promptOn(s2.sessionId, [
    'Isolated timing probe RI-2. Execute exactly, no questions:',
    'STEP 1 — in one batch call async_run twice with commands: "Start-Sleep -Seconds 23; Write-Output RI2-A" / "Start-Sleep -Seconds 25; Write-Output RI2-B" (descriptions probe ri2 a/b). Do NOT wait for them.',
    'STEP 2 — after STEP 1 returns, call async_run once with command "Start-Sleep -Seconds 40", description "ri2 blocker", yield_ms 60000, and wait for it inline.',
    'STEP 3 — after the blocker returns, reply with exactly RI2_DONE and end your turn. Do not call async_wait. If messages (job results or queued notes) reach you later, reply RI2_SEEN and echo every token you read (RI2-A, RI2-B, RI2-NORM), no tools.'
  ].join('\n'));
  let queuedAt = null;
  for (let i = 0; i < 60 && queuedAt === null; i += 1) {
    const tr = await transcriptOf(s2.sessionId);
    if ((tr.records ?? []).some((x) => x.event?.type === 'tool/call')) {
      await promptOn(s2.sessionId, 'Queued note: remember the token RI2-NORM. No action needed now.');
      queuedAt = Date.now();
    } else await new Promise((res) => setTimeout(res, 1000));
  }
  r = await waitIdle(s2.sessionId, 'RI2_DONE', 240000);
  if (r.timeout) judge('RI-2 阻断回合完成（前置）', 'SKIP', '模型依从性超时（信息项；在册判据不依赖本步）', false);
  let all2 = null;
  for (let i = 0; i < 30 && all2 === null; i += 1) {
    const tr = await transcriptOf(s2.sessionId);
    const users = userTexts(tr);
    const comp = users.filter((u) => u.source === 'async-tools-job-result' && /RI2-[AB]/.test(u.text));
    const norm = users.filter((u) => u.source !== 'async-tools-job-result' && u.text.includes('Queued note: remember the token RI2-NORM'));
    if (comp.length >= 2 && norm.length >= 1) all2 = { comp, norm };
    else await new Promise((res) => setTimeout(res, 2000));
  }
  const interOk = all2 !== null && all2.comp.length === 2 && all2.norm.length === 1;
  judge('RI-2 普通消息与完成消息交错在册（两类载体共存）', interOk ? 'PASS' : 'FAIL',
    all2 === null ? '未集齐' : `普通×${String(all2.norm.length)}＋完成×${String(all2.comp.length)}`, true);
  let seen2 = false;
  for (let i = 0; i < 20 && !seen2; i += 1) {
    const tr = await transcriptOf(s2.sessionId);
    seen2 = modelTexts(tr).some((t) => t.includes('RI2-A') && t.includes('RI2-B') && t.includes('RI2-NORM'));
    if (!seen2) await new Promise((res) => setTimeout(res, 3000));
  }
  judge('RI-2 交错消息全部被领取消费', seen2 ? 'PASS' : 'SKIP', seen2 ? 'ok' : '60s 未确认（模型依从性，信息项）', false);
  evidence.steps.RI2 = { interleaved: interOk, consumed: seen2 };

  // ── RI-3 先丢弃再领取（尝试；RPC 面可能触发不了 discard） ──────────────────
  const s3 = await rpc('session/create', { request: { cwd: PLAYGROUND, agentPreset: 'dsh-async' } });
  await promptOn(s3.sessionId, [
    'Isolated timing probe RI-3. Execute exactly, no questions:',
    'STEP 1 — call async_run once with command "Start-Sleep -Seconds 60; Write-Output RI3-BODY", description "ri3 long". Wait inline with yield_ms 60000.',
    'No further steps.'
  ].join('\n'));
  let queued3 = false;
  for (let i = 0; i < 60 && !queued3; i += 1) {
    const tr = await transcriptOf(s3.sessionId);
    if ((tr.records ?? []).some((x) => x.event?.type === 'tool/call')) {
      await promptOn(s3.sessionId, 'Queued note: token RI3-QUEUED.');
      queued3 = true;
    } else await new Promise((res) => setTimeout(res, 1000));
  }
  await new Promise((res) => setTimeout(res, 2000));
  await rpc('session/cancel', { request: { sessionId: s3.sessionId } }).catch(() => {});
  await new Promise((res) => setTimeout(res, 5000));
  const tr3 = await transcriptOf(s3.sessionId);
  const row3 = await rowOf(s3.sessionId);
  const queued3Visible = userTexts(tr3).some((u) => u.text.includes('RI3-QUEUED'));
  evidence.steps.RI3 = { queuedNoteVisibleAfterCancel: queued3Visible, stillRunningAfterCancel: row3.running === true };
  judge('RI-3 取消后待决消息处置可观察（形态如实登记）', 'SKIP',
    `取消后：queued note 在转录=${String(queued3Visible)}；会话 running=${String(row3.running)}；discard 事件不进转录——RPC 面不可触发「先丢弃再领取」形态，按装置边界登记（事件形态由套件层 T-RC-1 ⑥ 真投影锚定）`, false);

  // ── RC-1 取消可达性探针（④，预期不可达） ─────────────────────────────────
  const sc = await rpc('session/create', { request: { cwd: PLAYGROUND, agentPreset: 'dsh-async' } });
  await promptOn(sc.sessionId, [
    'Isolated cancel probe RC-1. Execute exactly, no questions:',
    'STEP 1 — call async_run once with command "Start-Sleep -Seconds 90; Write-Output RC1-BODY", description "rc1 long", yield_ms 60000. Wait for it inline.'
  ].join('\n'));
  let toolCallSeen = false;
  for (let i = 0; i < 60 && !toolCallSeen; i += 1) {
    const tr = await transcriptOf(sc.sessionId);
    toolCallSeen = (tr.records ?? []).some((x) => x.event?.type === 'tool/call');
    if (!toolCallSeen) await new Promise((res) => setTimeout(res, 1000));
  }
  // tool/call 记录先于派遣入转录：多等 8s 覆盖「记录已见、派遣未发生」的窄窗。
  await new Promise((res) => setTimeout(res, 8000));
  await rpc('session/cancel', { request: { sessionId: sc.sessionId } }).catch(() => {});
  let stopped = false;
  for (let i = 0; i < 20 && !stopped; i += 1) {
    const row = await rowOf(sc.sessionId);
    stopped = row.running !== true;
    if (!stopped) await new Promise((res) => setTimeout(res, 1000));
  }
  judge('RC-1 首等窗内取消：会话停止运行（runGroup 排空、无悬挂）', stopped ? 'PASS' : 'FAIL', stopped ? 'ok' : '20s 仍 running', true);
  await promptOn(sc.sessionId, [
    'Continue RC-1. The long job from before should still be running or finished. Call async_wait with targets [{kind:"job", id:"<the job id from your earlier async_run>"}] and wait_ms 35000. Then reply exactly RC1_DONE plus the body token you read (RC1-BODY), and end turn. If the job id is not visible anymore or no job was ever created, call async_wait with no targets and wait_ms 35000, then reply RC1_DONE and state plainly why no body token is reported.'
  ].join('\n'));
  let rcText = '';
  for (let i = 0; i < 45 && rcText === ''; i += 1) {
    const tr = await transcriptOf(sc.sessionId);
    const hit = modelTexts(tr).find((t) => t.includes('RC1_DONE'));
    if (hit !== undefined) rcText = hit;
    else await new Promise((res) => setTimeout(res, 3000));
  }
  const dispatched = !/no job|aborted before dispatch|not visible anymore|never created/i.test(rcText);
  if (dispatched && rcText !== '') {
    judge('RC-1 取消后作业正文经等待照达（交付链完好）', bodyDelivered(rcText) ? 'PASS' : 'FAIL', rcText.slice(0, 200), true);
  } else {
    judge('RC-1 取消后作业正文经等待照达（交付链完好）', 'SKIP',
      `装置边界未取得：取消落在派遣前（转录 tool/call 先于派遣、不可判派遣时点）——${rcText.slice(0, 160) || '90s 无回执'}`, false);
  }
  evidence.steps.RC1 = {
    sessionStopped: stopped, bodyDeliveredTested: dispatched && rcText !== '' && bodyDelivered(rcText),
    note: 'turn-stopping/收尾事件不进转录——不可观测面如实登记；窗口不可达判定以宿主源码契约分析为准（设计 §2.6 准备期窗口条）'
  };
} catch (probeError) {
  // 中止≠核心判据全过（README 退出码契约）：已判级照常落证据，收束以 2 报装置故障。
  aborted = true;
  console.error(`FAULT：判级中途中止（${String(probeError instanceof Error ? probeError.stack : probeError)}）——按装置故障以退出码 2 收束`);
} finally {
  writeFileSync(EVIDENCE, JSON.stringify({ ...evidence, verdicts, aborted }, null, 2));
  console.log(`[launcher] evidence → ${EVIDENCE}`);
  const failed = verdicts.filter((v) => v.kind === 'FAIL' && CORE.has(v.name)).length;
  const passed = verdicts.filter((v) => v.kind === 'PASS').length;
  const verdictLine = `[launcher] verdicts: ${String(passed)} PASS / ${String(failed)} core-FAIL（其余为信息项登记）${aborted ? '；ABORTED（装置故障，退出码 2）' : ''}`;
  cleanup();
  console.log(verdictLine);
  process.exit(aborted ? 2 : (failed > 0 ? 1 : 0));
}
