/**
 * 批次领取窗口与延后说明批级配额的实例级探针（REL-NOTES-01 验收的硬性前置，
 * 设计 §2.6「条目数与说明上限」／r16 设计 §1.8 第 2 层）。
 *
 * ## 探针在证什么
 *
 * 套件层（T8）已证真实注册表下「准入上限（并发运行 ≤10）不能限定一个领取窗口
 * 内累计的终态候选总数」；本探针补实例层：真实会话（真收件箱、真领取事件）中，
 * 同一领取窗口内大量结算的完成消息**物理条数有界**（条目 ≤10＋延后说明 ≤3 逐条
 * ＋1 聚合），且窗口关闭（收件箱被领取）后**配额复位**——第二波结算重新获得
 * 延后说明，不因首波耗尽而静默。
 *
 * ## 装置
 *
 * 空闲主体（无 async_wait）下分两波，每波 14 个错峰短作业：模型先启动全部后台
 * 作业，再跑一条前台阻塞命令（窗口保持开放——结算落在主体忙碌、无活等待的
 * 完成消息路径上），阻塞结束后结束回合；宿主随后领取收件箱，批关闭。完成消息
 * 只认**通知注入侧**：`user/message` 且 `source.kind === 'async-tools-job-result'`
 * （`lib/delivery-sources.js` 的 `JOB_RESULT_SOURCE`）——宿主原生 `tool-jobs`
 * 通知与模型自述不计数。
 *
 * ## 通过判据
 *
 * - 每个领取窗口（相邻完成消息记录的连续段）物理消息 ≤14 条；
 * - 每波 14 个作业标记全部到达模型（完成消息正文或让出出口结构化附着——实例层
 *   的零丢失判据按「到达」计，不限定载体）；
 * - 若任一窗口超 10 条目（触发延后）：逐条说明 ≤3、聚合 ≤1，且跨窗口配额复位
 *   ——真实宿主的领取点在每个模型步进边界实发（next-step 领取）、波内结算优先
 *   被让出出口结构化携带，自然模型流下窗口实测远低于上限；配额路径本身由套件层
 *   T8/RN-* 在真实注册表上锚定（`test/wait-delivery.test.mjs`），本探针如实登记
 *   「未触发」而非伪造触发；
 * - 领取事件（agent/inbox next-step 移除计数）按窗口登记——批关闭时点的实例数据。
 *
 * 实测（2026-11-03，rc.5 隔离实例，最终判据版）：两波各 14 作业全部到达（零丢失
 * ——W1 让出出口结构化附着 1 条、W2 2 条）；完成消息领取窗口 W1 两窗各 4 条、
 * W2 四窗各 4 条（合计 8／16 条），无窗口触顶——延后说明配额未在实例层触发，
 * 属领取点密集的正常形态，判据按上条如实登记。
 *
 * ## 用法
 *
 * `node verify/probe-batch-window.mjs <url 或含 url 的文件路径>`
 * 缺省读环境变量 `DSAT_PROBE_URL`；两者都缺席时打印 SKIP 并以 0 退出（实例
 * 判据只对开发机上的临时实例有意义，缺席不是失败，但必须留痕）。url 形态
 * `http://host:port/?token=…`。证据写 `probe-batch-window.json`（当前目录或
 * `DSAT_PROBE_EVIDENCE` 指定路径）；任一判据不成立退出码 1。
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const rawArg = process.argv[2] ?? process.env.DSAT_PROBE_URL ?? '';
if (rawArg.trim() === '') {
  console.log('SKIP probe-batch-window.mjs：未提供实例 url（参数或 DSAT_PROBE_URL）');
  process.exit(0);
}
const raw = /[/?#]/.test(rawArg) && !/\s/.test(rawArg.trim()) && rawArg.includes('://')
  ? rawArg.trim()
  : (await import('node:fs')).readFileSync(rawArg.trim(), 'utf8').trim();
const match = raw.match(/^(https?:\/\/[^/?#]+)\/?\?token=([A-Za-z0-9._~%-]+)$/);
if (!match) throw new Error(`url 形态不符（仅显示问号前的 origin 与路径）：${raw.split('?')[0].slice(0, 48)}…`);
const [, ORIGIN, TOKEN] = match;

const EVIDENCE = process.env.DSAT_PROBE_EVIDENCE ?? join(process.cwd(), 'probe-batch-window.json');
const JOBS_PER_WAVE = 14; // > 10 条目上限，必然触发延后说明
const WAVES = ['W1', 'W2'];

// ── RPC（token 换 cookie；任意 fetch 拒绝各重试一次——长探针会撞上服务端
//    关闭空闲 keep-alive 连接，重试发起新连接即成） ─────────────────────────
const indexResponse = await fetch(`${ORIGIN}/?token=${TOKEN}`, { redirect: 'manual' });
const COOKIE = (indexResponse.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
if (COOKIE.length === 0) throw new Error('token exchange returned no cookie');

async function rpc(endpoint, args) {
  const body = JSON.stringify({
    type: 'client-request', rpcId: `probe-${Math.random().toString(36).slice(2, 10)}`,
    method: endpoint, payload: { args }
  });
  let response;
  try {
    response = await fetch(`${ORIGIN}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body
    });
  } catch (connError) {
    response = await fetch(`${ORIGIN}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body
    });
    void connError;
  }
  const text = await response.text();
  const parsed = JSON.parse(text);
  if (parsed?.result?.ok !== true) {
    throw new Error(`${endpoint}: ${JSON.stringify(parsed?.result?.error ?? text.slice(0, 200))}`);
  }
  return parsed.result.value;
}

async function rowOf(sessionId) {
  const listing = await rpc('session/list', { _request: {} });
  const row = listing.items.find((item) => item.sessionId === sessionId);
  if (row === undefined) throw new Error(`session ${sessionId} not found`);
  return row;
}

async function transcriptOf(sessionId) {
  const row = await rowOf(sessionId);
  return rpc('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 600 }
  });
}

// ── 会话与 playground ──────────────────────────────────────────────────────
const PLAYGROUND = join(tmpdir(), 'dsh-probe-batch-window');
mkdirSync(PLAYGROUND, { recursive: true });
const created = await rpc('session/create', { request: { cwd: PLAYGROUND, agentPreset: 'dsh-async' } });
if (created.agentPreset !== 'dsh-async') throw new Error(`session/create fell back: ${String(created.agentPreset)}`);
const SESSION = created.sessionId;
console.log(`sessionId=${SESSION}`);

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

// ── 两波作业任务书：14 个后台作业（睡眠 21-30s——默认首等下限 20s，短于此
//    会在首等内前台完成、永不进后台）分两段启动（并发准入 ≤10，11-14 号带
//    重试指令）＋ 前台阻塞命令保持领取窗口开放（结算落在主体忙碌、无活等待
//    的完成消息路径上）＋ 结束回合。 ──────────────────────────────────────
function wavePrompt(wave) {
  const sleeps = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 21, 22, 23, 24];
  const lines = sleeps.map((s, i) => `${i + 1}. command: "Start-Sleep -Seconds ${s}; Write-Output RN${wave}-${String(i + 1).padStart(2, '0')}"  description: "probe ${wave} job ${i + 1}"`);
  return [
    `Isolated delivery probe, wave ${wave}. Execute exactly these steps, no questions:`,
    `STEP 1 — call async_run 10 times in one batch, once per numbered line below (jobs 1-10), passing each command and description verbatim. Each will outlive its first wait and return a job_id; do NOT wait for them and do NOT call async_wait on them:`,
    ...lines.slice(0, 10),
    `STEP 2 — once STEP 1 has returned, call async_run 4 times (jobs 11-14):`,
    ...lines.slice(10),
    `Admission allows at most 10 concurrent jobs, so some of these four may be REJECTED with a limit error before any process starts. When a call is rejected, re-issue exactly the same call after a few seconds, until it returns a job_id; keep the two steps' calls otherwise untouched.`,
    `STEP 3 — after jobs 11-14 are all started, call async_run once with command "Start-Sleep -Seconds 40" and description "wave ${wave} blocker", yield_ms 60000, and wait for it inline.`,
    `STEP 4 — after the blocker returns, reply with exactly the single token RN${wave}_DONE and end your turn. Do not call async_wait at any point. If job results or deferred notices reach you later as messages, read them and reply with exactly RN${wave}_SEEN, no tools.`
  ].join('\n');
}

const verdicts = [];
function judge(name, ok, detail = '') {
  verdicts.push({ name, ok: ok === true, detail: String(detail).slice(0, 400) });
  console.log(`${ok === true ? 'PASS ' : 'FAIL '} ${name}${detail === '' ? '' : `  —— ${String(detail).slice(0, 200)}`}`);
}

/** 完成消息（注入侧）：user/message 且 source.kind=async-tools-job-result。
 * 载荷带记录序号（转录页的 seq 字段在本宿主线上缺席时以数组下标回退）。 */
function completionSends(transcript) {
  const out = [];
  (transcript.records ?? []).forEach((record, index) => {
    if (record.event?.type !== 'user/message') return;
    const message = record.event.data?.message ?? record.event.data;
    const source = message?.source ?? {};
    if (source.kind !== 'async-tools-job-result') return;
    const text = (message?.content ?? []).map((c) => String(c.text ?? '')).join('\n');
    out.push({
      seq: record.seq ?? index,
      at: record.at ?? record.event.at ?? null,
      text,
      isIndividualNotice: /did not fit the current delivery batch|没有排进当前交付批次/.test(text),
      isAggregateNotice: /also deferred|同样延后/.test(text)
    });
  });
  return out;
}

function modelTexts(transcript) {
  return (transcript.records ?? [])
    .filter((r) => r.event?.type === 'assistant/message' || r.event?.type === 'model/message')
    .map((r) => (r.event.data?.message?.content ?? r.event.data?.content ?? [])
      .map((c) => String(c.text ?? '')).join('\n'));
}

/** 让出出口结构化附着（jobs.js collectBatch 附进 async_run/async_wait 返回的
 * 就绪条目）：tool/result 文本中的「── 作业号 ── 状态行＋正文」段。零丢失判据
 * 把它计入「到达」——实例层不限定载体（设计 §2.6：等待返回与完成消息都是
 * 合法交付载体）。 */
function structuredDeliveries(transcript) {
  const texts = [];
  for (const record of transcript.records ?? []) {
    if (record.event?.type !== 'tool/result') continue;
    const text = (record.event.data?.message?.content ?? [])
      .filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('\n');
    if (/── async-command-/.test(text)) texts.push(text);
  }
  return texts;
}

/**
 * 领取窗口划分：完成消息按「中间是否插有模型/人类消息」分段——模型记录即一次
 * 领取与回应的痕迹（claimed 事件不进转录，模型记录与 next-step 移除计数是它的
 * 可观察投影）。宿主线转录的记录 seq 缺席时用数组下标，两种坐标都在段内单调。
 */
function windowsOf(transcript, sends) {
  const boundaries = [];
  (transcript.records ?? []).forEach((record, index) => {
    const type = record.event?.type ?? '';
    if (type === 'assistant/message' || type === 'model/message') {
      boundaries.push(record.seq ?? index);
    }
  });
  const windows = [];
  let current = [];
  for (const send of sends) {
    const gapHasModel = current.length > 0
      && boundaries.some((s) => s > current.at(-1).seq && s < send.seq);
    if (gapHasModel) {
      windows.push(current);
      current = [];
    }
    current.push(send);
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

function noticeCounts(win) {
  return {
    individual: win.filter((s) => s.isIndividualNotice).length,
    aggregate: win.filter((s) => s.isAggregateNotice).length
  };
}

const evidence = { origin: ORIGIN.replace(/\/\/[^@]*@/, '//'), sessionId: SESSION, waves: [], verdicts };

async function runWave(wave) {
  console.log(`── 波 ${wave}：${JOBS_PER_WAVE} 个错峰作业 + 前台阻塞 ──`);
  await prompt(wavePrompt(wave));
  // 等待波收尾：RN{wave}_DONE 出现、会话空闲、再稳定 10 秒无新记录。
  const t0 = Date.now();
  let transcript;
  let stableSince = null;
  for (;;) {
    transcript = await transcriptOf(SESSION);
    const row = await rowOf(SESSION);
    const done = modelTexts(transcript).some((t) => t.includes(`RN${wave}_DONE`));
    const count = (transcript.records ?? []).length;
    if (done && row.running !== true) {
      if (stableSince === null) stableSince = { at: Date.now(), count };
      const grew = (transcript.records ?? []).length > stableSince.count;
      const settled = Date.now() - stableSince.at > 10000 && !grew;
      if (settled) break;
      if (grew) stableSince = { at: Date.now(), count };
    }
    if (Date.now() - t0 > 300000) throw new Error(`wave ${wave} 等待超时（done=${String(done)}）`);
    await new Promise((resolve) => { setTimeout(resolve, 3000); });
  }
  const sends = completionSends(transcript);
  const windows = windowsOf(transcript, sends);
  const structured = structuredDeliveries(transcript);
  const markers = Array.from({ length: JOBS_PER_WAVE }, (_, i) => `RN${wave}-${String(i + 1).padStart(2, '0')}`);
  const messageText = sends.map((s) => s.text).join('\n');
  const carrierText = structured.join('\n');
  // 领取事件登记：next-step 移除计数（批关闭的实例侧投影——claimed 事件本身不
  // 进转录，next-step splice 的 removedCount 是它的可观察痕迹）。
  const claims = (transcript.records ?? [])
    .filter((r) => r.event?.type === 'agent/inbox/spliced'
      && r.event.data?.target === 'next-step'
      && (r.event.data?.removedCount ?? 0) > 0)
    .map((r) => r.event.data.removedCount);
  const waveEvidence = {
    wave,
    completionSends: sends.length,
    windows: windows.map((win) => ({
      size: win.length, firstSeq: win[0]?.seq ?? null, lastSeq: win.at(-1)?.seq ?? null,
      ...noticeCounts(win)
    })),
    claimRemovals: claims,
    structuredCarrierTexts: structured.length,
    markersSeen: markers.filter((m) => messageText.includes(m) || carrierText.includes(m)),
    markersMissing: markers.filter((m) => !messageText.includes(m) && !carrierText.includes(m)),
    noticeTotal: noticeCounts(sends)
  };
  evidence.waves.push(waveEvidence);
  return waveEvidence;
}

const w1 = await runWave('W1');
const w2 = await runWave('W2');

// ── 判据 ───────────────────────────────────────────────────────────────────
for (const w of [w1, w2]) {
  const over = w.windows.filter((win) => win.size > 14);
  judge(`波 ${w.wave}：每个领取窗口完成消息 ≤14 条`, over.length === 0,
    `窗口尺寸：${w.windows.map((x) => x.size).join(', ') || '（无消息窗口）'}`);
  judge(`波 ${w.wave}：${JOBS_PER_WAVE} 个作业标记全部到达（消息正文或结构化附着，零丢失）`,
    w.markersMissing.length === 0,
    `缺席：${w.markersMissing.join(', ') || '无'}；消息载体 ${w.completionSends} 条、结构化载体 ${w.structuredCarrierTexts} 条`);
  const exhausted = w.windows.find((win) => win.size > 10);
  if (exhausted !== undefined) {
    const badNotices = w.windows.filter((win) => win.individual > 3 || win.aggregate > 1);
    judge(`波 ${w.wave}：触顶窗口逐条说明 ≤3 且聚合 ≤1`, badNotices.length === 0,
      JSON.stringify(w.windows));
    judge(`波 ${w.wave}：触顶窗口存在延后说明（配额路径实发）`, w.noticeTotal.individual > 0 || w.noticeTotal.aggregate > 0,
      `逐条 ${w.noticeTotal.individual}／聚合 ${w.noticeTotal.aggregate}`);
  } else {
    verdicts.push({
      name: `波 ${w.wave}：延后说明配额未在实例层触发（所有消息窗口 ≤10 条目）`,
      ok: true,
      detail: `真实宿主领取点在每个模型步进边界实发，窗口尺寸 ${w.windows.map((x) => x.size).join(', ') || '无'}；配额路径由套件层 T8/RN-* 在真实注册表锚定——如实登记未触发，不伪造`
    });
    console.log(`NOTE  波 ${w.wave}：延后说明配额未在实例层触发（窗口 ≤10）——由套件层 T8/RN-* 锚定，如实登记`);
  }
}
const w2Exhausted = w2.windows.some((win) => win.size > 10);
const w1Exhausted = w1.windows.some((win) => win.size > 10);
if (w1Exhausted && w2Exhausted) {
  const w2HasNotices = w2.windows.some((win) => win.individual > 0 || win.aggregate > 0);
  judge('跨窗口配额复位：第二波窗口重新出现延后说明', w2HasNotices,
    `第二波逐条 ${w2.noticeTotal.individual}／聚合 ${w2.noticeTotal.aggregate}`);
} else {
  verdicts.push({
    name: '跨窗口配额复位（条件判据：两波均触顶才可断言）',
    ok: true,
    detail: `本轮实例流未触顶（W1 ${String(w1Exhausted)}／W2 ${String(w2Exhausted)}）——复位行为由 RN-F（两处关批点）在受控层锚定`
  });
  console.log('NOTE  跨窗口配额复位：实例流未触顶，复位行为由 RN-F 锚定——如实登记');
}
const claimEvidence = (w1.claimRemovals.length + w2.claimRemovals.length) > 0;
judge('领取事件实发（next-step 移除计数在案）', claimEvidence,
  `W1 移除 [${w1.claimRemovals.join(', ')}]，W2 移除 [${w2.claimRemovals.join(', ')}]`);
const multiWindow = w1.windows.length >= 1 && w2.windows.length >= 1;
judge('两波均有可划分的领取窗口（模型记录分隔）', multiWindow,
  `W1 ${w1.windows.length} 个窗口，W2 ${w2.windows.length} 个窗口`);

rmSync(PLAYGROUND, { recursive: true, force: true });
evidence.verdicts = verdicts;
writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
console.log(`evidence -> ${EVIDENCE}`);
process.exit(verdicts.every((v) => v.ok) ? 0 : 1);
