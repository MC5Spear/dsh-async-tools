/**
 * async_run 执行即注册与可打断的首次等待的真机探针（需求 §2.2.1）。
 *
 * 判据（需求 §2.2.1；时序与形状锚取自验证实例实读）：
 * - (a) 即时性·插话：55 s 命令 + yield_ms=60000；让出窗口内（async_run 调用
 *       落转录后）steer → async_run 的 tool/result 距 steer 发出 ≤ 5000 ms
 *       （预算路径被预算值排除）；结果形状如实登记（handle/early 为设计形状；
 *       `Error: tool call aborted` 或空文为宿主对中止调用的改写形状——
 *       dsh-tools dispatchToolBody 在调用信号已中止时丢弃工具返回值；
 *       恢复通道=完成通知）；结算后完成通知恰 1 条。
 * - (b) 即时性·GUI 停止：GUI 会话内长让出（运行态发送键换装「停止生成」，
 *       aria-label 现场标定）→ 点击后 tool/result 距点击 ≤ 5000 ms、形状如实
 *       登记（handle=设计形状；aborted/empty=宿主改写）；作业存活（结算
 *       照常发生）+ 结算后完成通知恰 1 条（abort 的恢复通道）。
 * - (c) 呈现：任务面板（「N 个后台任务运行中」入口）任务卡 label=命令原文、
 *       running 期 progress 行=description；结算后 progress 消失、命令仍在。
 * - (d) 触顶：占满 owner 名额（10，设计 §3.5 出厂上限）→ 第 11 条 async_run 的错误文案
 *       含「进程启动前被拒」锚 + limit 10 + 作业出路。睡眠 600 s——名额必须
 *       在第 11 条发出时仍被占住，短睡眠会提前释放；取证后 session/cancel
 *       清理沉睡作业。
 * - (e) 短命令：预算内 completed 形状与现行一致（输出原样）；终态卡在场
 *       （裁定接受）；该路径零完成通知（(f) 前半）。
 * - (f) 通知计数：(a)/(b) 各恰 1 条；(e) 0 条。
 *
 * 时序锚：会话先整体升档（GUI 入口＝composer `/permission danger-full-access`；
 * RPC 入口＝`_r28-helpers.elevateSession`——同一 remote 提交事务），审批档随升档
 * 切 never。插话/停止/读面板的同步点＝转录出现 async_run 的 tool/call 后 2 s
 * （工具体注册+spawn 在调用后毫秒级完成）；动作过早会中止步骤信号，工具体
 * 还没注册任何作业，什么判据都取不到。
 *
 * (b)(c) 走 GUI 优先（RPC 建的会话不在 GUI 当前视图，停止键与面板入口
 * 都够不着）。0.2.0 起 GUI「新建会话」默认落**标准模式**（新任务页 seat
 * 默认），GUI 侧可行路径＝blank 会话（session/list `blank:true` 最新者）→
 * RPC `agentPresets/select` 定 dsh-async → composer 发词（`guiBlankSession`
 * 辅助）。
 *
 * 用法：node verify/probe-r32-run-interruptible.mjs [--only=a,b,c,d,e]
 * （(b)(c) 需要 Edge/Chrome——找不到时如实记 FAIL 'cdp-missing'，不冒充通过；
 * 含 (b)(c) 的整跑按惯例整跑提权 danger-full-access：受限档下无头浏览器
 * spawn 在进程创建层必死。）
 * 证据落本机证据目录 logs/r32-run-interruptible.json。
 *
 * 共享实例纪律：不动别人的设置与语言档；本探针只读设置作对照，
 * 会话建在 dsh-async 预设下，锚句双档自适应（转录里的渲染文两种语言档都认）。
 *
 * @module verify/probe-r32-run-interruptible
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rpc, transcriptOf, localConfig } from './_rpc.mjs';
import { newSession, prompt, waitTurnEnd, elevateSession, NS, PRESET } from './_r28-helpers.mjs';
import { YIELD_EARLY_BY_USER as EARLY_ANCHOR, START_REFUSED as REFUSED_ANCHOR, HOST_JOB_NOTICE, HOST_JOB_FINISHED } from './message-markers.mjs';
import { findBrowser, launch, openPage, evaluate, waitFor } from './_visual/cdp.mjs';

const LOG_DIR = join(localConfig.evidenceDir, 'logs');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 即时性窗口（需求 §6 已钉死）：毫秒。 */
const IMMENSITY_MS = 5000;
/** (a)(b) 的长跑命令与首次等待时长（预算路径必须排不出 ≤5 s 的返回）。 */
const LONG_RUN_SECONDS = 55;
const YIELD_MS = 60000;
/** 调用落转录后的入窗等待：注册+spawn 在调用后毫秒级完成，2 s 足够落进让出窗口。 */
const POST_CALL_MS = 2000;
/**
 * 语法判据锚。词典句锚（提前结束注记、触顶拒绝）已收敛到共享锚模块
 * `verify/message-markers.mjs`（两语成对；漂移由 test/message-markers.test.mjs
 * 的 `t()` 两档渲染回归钉住）。留在本地的两枚按设计 §8.3 口径豁免：
 * - `HANDLE_ANCHOR`：`lib/output.js` 代码构造的调用句式字面量，非词典成句；
 * - `ABORT_ANCHOR`：宿主 dsh-tools 对中止调用的改写文本，非本包词典。
 */
const HANDLE_ANCHOR = /async_wait\(targets=\[\{kind:"job", id:"/;
const ABORT_ANCHOR = /Error: tool call aborted/;

const results = [];
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console[ok ? 'log' : 'error'](`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
};

/** 发一条插话（steer：落 next-step 的插话判定口径——排队消息不打断）。 */
async function steer(sessionId, text) {
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      mode: 'steer',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
}

/** 转录里 async_run 的结果文本列表（tool/result 按 callId 配对 tool/call）。 */
function runResultTexts(transcript) {
  const records = transcript.records ?? [];
  const nameById = new Map();
  for (const r of records) {
    if (r.event?.type === 'tool/call') nameById.set(r.event.data?.callId, r.event.data?.name);
  }
  const texts = [];
  for (const r of records) {
    if (r.event?.type !== 'tool/result') continue;
    if (nameById.get(r.event.data?.message?.toolCallId) !== 'async_run') continue;
    texts.push((r.event.data?.message?.content ?? [])
      .filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('\n'));
  }
  return texts;
}

/** 转录里某工具的调用次数（配对辅助＋同步点）。 */
function toolCallsOf(transcript, name) {
  return (transcript.records ?? []).filter((r) => r.event?.type === 'tool/call' && r.event.data?.name === name).length;
}

/** 轮询转录直到谓词命中；返回 { transcript, elapsedMs }（elapsed 从 t0 起算）。 */
async function pollUntil(sessionId, predicate, { maxMs = 90000, everyMs = 500, t0 = Date.now() } = {}) {
  for (;;) {
    const transcript = await transcriptOf(sessionId);
    if (predicate(transcript)) return { transcript, elapsedMs: Date.now() - t0 };
    if (Date.now() - t0 > maxMs) throw new Error(`pollUntil 超时（${String(maxMs)} ms）`);
    await sleep(everyMs);
  }
}

/**
 * 等到转录出现首个 async_run 调用——工具体在调用后注册作业、进入让出竞速；
 * 本探针一切"窗口内"动作都以此为同步点。
 */
async function waitRunCalled(sessionId) {
  await pollUntil(sessionId, (t) => toolCallsOf(t, 'async_run') >= 1, { maxMs: 120000 });
}

/**
 * 完成通知计数：只认**通知注入侧**——`user/message` 且 `source.kind === 'tool-jobs'`、
 * `form === 'notice'`（实测形状；按消息 id 去重，splice 镜像不重复计）。
 * 不匹配 assistant/tool 记录（模型复述不算通知，r34-O6），也不匹配 request/header
 * 与 system/message——工具描述自带 `async_wait(targets=[{kind:"job", id:"async-command-…"}]` 示例与
 * 「完成」字样，正文级匹配会把请求头当成通知（(e) 实读的误报形态）。
 */
function completionNotices(transcript) {
  const seen = new Set();
  const notices = [];
  for (const r of transcript.records ?? []) {
    if (r.event?.type !== 'user/message') continue;
    const msg = r.event.data?.message ?? r.event.data;
    const source = msg?.source ?? {};
    if (source.kind !== 'tool-jobs' || source.form !== 'notice') continue;
    const text = (msg?.content ?? []).map((c) => String(c.text ?? '')).join('\n');
    // 宿主完成通知恒为英文（dsh-tool-jobs，agentLang 不影响宿主文本）、编号不透明
    // （形如 async-command-29bb2c6b2dff4ad9）——锚取共享模块的宿主锚，不假定数字
    // 编号、不依赖类型前缀（本探针不写设置）。
    if (HOST_JOB_NOTICE.test(text) && HOST_JOB_FINISHED.test(text)) {
      const id = String(msg?.id ?? `${notices.length}-`);
      if (!seen.has(id)) {
        seen.add(id);
        notices.push(text.slice(0, 300));
      }
    }
  }
  return notices;
}

/** 等到通知数 ≥ expected（expected=0 时等满稳定窗 maxMs 再返回计数）。 */
async function waitForNoticeCount(sessionId, expected, maxMs) {
  const t0 = Date.now();
  for (;;) {
    const transcript = await transcriptOf(sessionId);
    const count = completionNotices(transcript).length;
    if ((expected > 0 && count >= expected) || Date.now() - t0 > maxMs) {
      return { count, samples: completionNotices(transcript) };
    }
    await sleep(2000);
  }
}

/**
 * 结果形状分类（如实登记两副面孔）：
 * - `handle`/`early`：设计形状（让出句柄 / 插话提前结束注记）。
 * - `aborted`：宿主改写（dsh-tools 在调用信号已中止时丢弃返回值）。
 * - `empty`：中止后提交的空文本（中止后提交的实读形状）。
 */
function classifyResult(text) {
  if (HANDLE_ANCHOR.test(text) || EARLY_ANCHOR.test(text)) return 'handle';
  if (ABORT_ANCHOR.test(text)) return 'aborted';
  if (text.trim() === '') return 'empty';
  return 'other';
}

// —— CDP 面 ——

const URL_LINE = readFileSync(localConfig.tokenFile, 'utf8').trim();
const APP_URL = URL_LINE.slice(URL_LINE.indexOf('http'));

/**
 * GUI 会话内点按运行态控件（现场标定）：
 * - 停止键：aria-label「停止生成」，运行态与发送键同槽换装；
 * - 任务面板入口：aria-label 匹配 /个后台任务/。
 */
async function clickByLabel(page, labelRe) {
  const hit = await evaluate(page, `(() => {
    const re = ${String(labelRe)};
    const cands = [...document.querySelectorAll('button, [role="button"]')]
      .filter((el) => re.test(el.getAttribute('aria-label') || el.title || '') && !el.disabled);
    if (cands.length === 0) return '';
    cands[0].click();
    return cands.map((el) => el.getAttribute('aria-label') || el.title).join('|');
  })()`);
  return typeof hit === 'string' ? hit : '';
}

/** GUI：新建会话（一次）。 */
async function guiNewSession(page) {
  await evaluate(page, `(() => {
    const b = [...document.querySelectorAll('button')].find((el) => (el.getAttribute('aria-label') || '') === '新建会话');
    if (b) b.click();
    return true;
  })()`);
  await sleep(1500);
}

/**
 * 0.2.0 起 GUI「新建会话」落**标准模式**（新任务页 seat 默认），预设只有
 * developerTools 的 seat 菜单一条 GUI 路；探针改走同一 remote 的 RPC 面：
 * 取 `session/list` 里最新的 blank 会话（新任务页焦点在的就是它），
 * `agentPresets/select` 给它定 dsh-async（宿主只拒「已开始」的会话）。
 * 先清掉其余 blank（空会话、无历史可失），让「复用 or 新建」都收敛到同一个
 * 焦点会话。@returns 定好预设的 blank 会话 id——composer 发出的词就落在它里面。
 */
async function guiBlankSession(page, presetId) {
  const blanksNewestFirst = async () => (await rpc('session/list', { _request: {} })).items
    .filter((item) => item.blank === true)
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
  for (const row of (await blanksNewestFirst()).slice(1)) {
    await rpc('session/cancel', { request: { sessionId: row.sessionId } }).catch(() => {});
  }
  await guiNewSession(page);
  let sid = '';
  for (let i = 0; i < 6 && sid === ''; i += 1) {
    sid = (await blanksNewestFirst())[0]?.sessionId ?? '';
    if (sid === '') await sleep(1500);
  }
  if (sid === '') throw new Error('session/list 未见 blank 会话（「新建会话」没建出？）');
  const picked = await rpc('agentPresets/select', { agentId: sid, agentPreset: presetId });
  if (picked !== presetId) throw new Error(`agentPresets/select 回执 ${JSON.stringify(picked)} ≠ ${presetId}`);
  return sid;
}

/** GUI：向当前会话键入提示词并点发送（contenteditable 通道，实测）。 */
async function guiSendText(page, text) {
  const typed = await evaluate(page, `(() => {
    const area = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
    if (!area) return 'no-input';
    area.focus();
    document.execCommand('insertText', false, ${JSON.stringify(text)});
    return area.tagName;
  })()`);
  if (typed === 'no-input') throw new Error('GUI composer 未找到（textarea/contenteditable 缺席）');
  let sent = false;
  for (let i = 0; i < 5 && !sent; i += 1) {
    await sleep(600);
    sent = await evaluate(page, `(() => {
      const b = [...document.querySelectorAll('button')].find((el) => (el.getAttribute('aria-label') || '') === '发送消息' && !el.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
  }
  if (!sent) throw new Error('发送失败（发送键始终禁用或缺失）');
}

/** RPC 侧核对某会话已升档（只读；升档动作只经 composer /permission 或 elevateSession）。 */
async function assertElevated(sessionId) {
  const transcript = await transcriptOf(sessionId);
  const elevated = (transcript.records ?? []).some((r) => r.event?.type === 'sandbox/mode'
    && r.event.data?.mode === 'danger-full-access');
  if (!elevated) throw new Error('会话升档失败：转录无 sandbox/mode danger-full-access（/permission 未被接受？）');
}

/**
 * 任务面板里目标作业卡的文本（卡=含 `async-command` 与命令原文的最深 div；断言只认
 * 卡内文本——正文级断言会被提示词回显污染：提示词本身含 description 与命令原文，
 * 「结算后 progress 消失」在正文层面恒假——实测）。
 */
async function jobCardText(page, command) {
  const card = await evaluate(page, `(() => {
    const cmd = ${JSON.stringify(command)};
    const els = [...document.querySelectorAll('div')]
      .filter((el) => (el.textContent || '').includes('async-command') && (el.textContent || '').includes(cmd) && (el.textContent || '').length < 400)
      .sort((a, b) => ((a.textContent || '').length - (b.textContent || '').length));
    return els.length === 0 ? '' : els[0].textContent || '';
  })()`);
  return typeof card === 'string' ? card : '';
}

// —— 判据实现 ——

/** 中止后防重试句：模型见到 aborted 错误会自行重试（实读形态），污染通知计数。 */
const NO_RETRY = 'If a call returns an error mentioning "tool call aborted" or an empty result, do NOT retry or re-run it — just reply ack. ';

/** (a) 即时性·插话 + 句柄形状。 */
async function criterionA(sessionId) {
  await elevateSession(sessionId);
  await prompt(sessionId,
    NO_RETRY
    + `Run this exact command with async_run (yield_ms=${String(YIELD_MS)}): Start-Sleep -Seconds ${String(LONG_RUN_SECONDS)}. `
    + 'While it yields, do nothing else and do not call any other tool — wait. '
    + 'If the yield ever ends early with a handle note, do NOT call async_wait and do NOT wait for the job — just reply ack and finish your turn.');
  // 时序锚：等调用落转录（注册与让出窗口在此之后才开始）。
  await waitRunCalled(sessionId);
  await sleep(POST_CALL_MS);

  const steerT0 = Date.now();
  await steer(sessionId, 'Status check: reply with just the word "ack" and end your turn. Do not call async_wait or any other tool; do not wait for the job.');
  const { elapsedMs, transcript } = await pollUntil(sessionId,
    (t) => runResultTexts(t).length >= 1,
    { t0: steerT0, maxMs: 30000 });
  const result = runResultTexts(transcript).at(-1) ?? '(none)';
  const shape = classifyResult(result);

  record('a-1-immediacy', elapsedMs <= IMMENSITY_MS,
    `steer → tool/result ${String(elapsedMs)} ms（判据 ≤${String(IMMENSITY_MS)} ms；预算 ${String(YIELD_MS)} ms 排除预算路径）`);
  record('a-2-wait-ended', true,
    `插话结束首次等待：结果形状=${shape}（handle/early=设计形状；aborted/empty=宿主对中止调用的改写）；样例：${result.slice(0, 160)}`);
  if (shape === 'handle') {
    record('a-3-early-anchor', EARLY_ANCHOR.test(result), '提前让出注记（earlyByUser）在场');
  }
  return { steerToResultMs: elapsedMs, shape, resultHead: result.slice(0, 200) };
}

/** (b) 即时性·GUI 停止 + abort 形状 + 恢复通道（作业存活 → 完成通知恰 1）。 */
async function criterionB(page) {
  // 0.2.0：GUI 新建默认标准模式——blank 会话经 RPC 定 dsh-async（见
  // guiBlankSession 头注），升档与提示词仍走 composer，断言与标准路径全同。
  const sid = await guiBlankSession(page, PRESET);
  await guiSendText(page, '/permission danger-full-access');
  await sleep(3000);
  await assertElevated(sid);
  await guiSendText(page,
    NO_RETRY
    + `Run this exact command with async_run (yield_ms=${String(YIELD_MS)}): Start-Sleep -Seconds ${String(LONG_RUN_SECONDS)}. `
    + 'While it yields, do nothing else and do not call any other tool — wait.');
  await waitRunCalled(sid);
  await sleep(POST_CALL_MS);

  const stopT0 = Date.now();
  const hit = await clickByLabel(page, /^(停止生成|停止|Stop generation|Stop|⏹)$/);
  if (hit === '') {
    record('b-0-stop-click', false, '未找到「停止生成」键（运行态发送键换装现场已标定，重跑仍失配则再标定）');
    return { sessionId: sid };
  }
  console.log(`stop clicked: ${hit}`);
  const { elapsedMs, transcript } = await pollUntil(sid,
    (t) => runResultTexts(t).length >= 1,
    { t0: stopT0, maxMs: 30000 });
  const result = runResultTexts(transcript).at(-1) ?? '(none)';
  const shape = classifyResult(result);
  record('b-1-immediacy', elapsedMs <= IMMENSITY_MS, `停止 → 结果 ${String(elapsedMs)} ms ≤ ${String(IMMENSITY_MS)} ms（形状 ${shape}）`);
  record('b-2-shape-honest', shape === 'handle' || shape === 'aborted' || shape === 'empty',
    `中止形状如实登记=${shape}（handle=设计形状；aborted/empty=宿主改写）；样例：${result.slice(0, 140)}`);
  const notice = await waitForNoticeCount(sid, 1, (LONG_RUN_SECONDS + 30) * 1000);
  record('b-3-job-survives', notice.count === 1,
    `abort 后作业存活并由完成通知恢复：${String(notice.count)} 条（判据恰 1）`);
  return { sessionId: sid, shape };
}

/** (c) 呈现：任务卡 label=命令原文 + progress=description；结算后 progress 消失。 */
async function criterionC(page) {
  const command = 'Write-Output "r32-panel" ; Start-Sleep -Seconds 25';
  const sid = await guiBlankSession(page, PRESET);
  await guiSendText(page, '/permission danger-full-access');
  await sleep(3000);
  await assertElevated(sid);
  await guiSendText(page,
    `Run this exact command with async_run (yield_ms=30000): ${command} `
    + 'Description must be exactly: probe panel row');
  await waitRunCalled(sid);
  await sleep(POST_CALL_MS);

  // 打开任务面板（入口：「N 个后台任务运行中」）。
  const opened = await clickByLabel(page, /个后台任务/);
  if (opened === '') {
    record('c-0-panel-open', false, '未找到任务面板入口（N 个后台任务运行中）');
    return { sessionId: sid };
  }
  console.log(`panel opened: ${opened}`);
  const runningCard = await jobCardText(page, command);
  record('c-1-label-command', runningCard.includes(command), `任务卡 label=命令原文（卡内实读：${runningCard.slice(0, 120)}）`);
  record('c-2-progress-description', runningCard.includes('probe panel row'), 'progress 行=description（活动期卡内可见）');
  // 等结算：命令 25 s（注册后起算）+ 余量；卡内 progress 行消失、命令仍在。
  const t0 = Date.now();
  let settledCard = '';
  while (Date.now() - t0 < 70000) {
    await sleep(3000);
    settledCard = await jobCardText(page, command);
    if (!settledCard.includes('probe panel row') && settledCard.includes(command)) break;
  }
  record('c-3-progress-cleared',
    settledCard !== '' && !settledCard.includes('probe panel row') && settledCard.includes(command),
    `结算后卡内 progress 行清除、命令行仍在（终态卡在场——裁定接受；卡内实读：${settledCard.slice(0, 140)}）`);
  return { sessionId: sid };
}

/** (d) 触顶：11 连发占满 owner 名额（10，设计 §3.5）→ 第 11 条准入拒绝文案。 */
async function criterionD(sessionId) {
  await elevateSession(sessionId);
  await prompt(sessionId,
    'Fire 11 async_run calls in ONE batch (same turn, no waiting between them, issue them back to back), '
    + 'each running Start-Sleep -Seconds 600 with yield_ms=1000 and description "limit probe N" (N=1..11). '
    + 'Do not retry failed calls. '
    + 'Then report exactly which calls returned a job_id and which failed, quoting each failure text verbatim.');
  // 升档后审批档 never：11 连发无审批串行，10 min 预算只留给让出与收尾。
  await waitTurnEnd(sessionId, 600000);
  const transcript = await transcriptOf(sessionId);
  const text = JSON.stringify(transcript.records ?? []);
  record('d-1-refused-anchor', REFUSED_ANCHOR.test(text), '第 11 条文案含「进程启动前被拒」锚（准入在先、无进程可杀）');
  record('d-2-limit-ten', /limit: 10|current limit: 10|当前上限:? 10/.test(text), '复述生效上限 10（设计 §3.5）');
  record('d-3-way-out', /job_kill/.test(text), '给出 kill/等待出路');
  // 清理：沉睡作业随会话取消而终止（设计 §7.1：owner 处置取消作业）。
  await rpc('session/cancel', { request: { sessionId } }).catch((error) => {
    console.log(`cleanup session/cancel: ${String(error?.message ?? error)}`);
  });
}

/** (e) 短命令：预算内 completed 形状不变 + 零完成通知（(f) 前半）。 */
async function criterionE(sessionId) {
  await elevateSession(sessionId);
  await prompt(sessionId,
    'Run this exact command with async_run (do not pass yield_ms): Write-Output "short-ok". Reply with its exit code only.');
  await waitTurnEnd(sessionId, 180000);
  const transcript = await transcriptOf(sessionId);
  const last = runResultTexts(transcript).at(-1) ?? '';
  record('e-1-completed-shape', last.includes('short-ok') && !HANDLE_ANCHOR.test(last),
    '预算内完成：输出原样、无句柄（短命令体验不变）');
  const notice = await waitForNoticeCount(sessionId, 0, 15000);
  record('f-e-zero-notice', notice.count === 0, `预算内完成路径完成通知 ${String(notice.count)} 条（判据 0——awaited 语义）`);
}

// —— 主流程 ——

const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '--only=').slice(7).split(',').filter(Boolean);
const want = (id) => only.length === 0 || only.includes(id);
mkdirSync(LOG_DIR, { recursive: true });

const summary = { ranAt: new Date().toISOString(), ns: NS, preset: PRESET, criteria: {} };
let browser = null;
try {
  if (want('b') || want('c')) {
    const browserPath = findBrowser();
    if (browserPath === undefined) {
      record('cdp-missing', false, '找不到 Edge/Chrome：(b)(c) 无法取证（如实记录，不冒充）');
    } else {
      browser = await launch(browserPath, ['--lang=zh-CN']);
      const page = await openPage(browser.port, 'about:blank');
      await page.send('Page.navigate', { url: APP_URL });
      await waitFor(page, 'document.querySelectorAll("#root *").length', (n) => Number(n) > 20, 30_000);
      await sleep(2000);
      summary.page = 'ready';
      if (want('b')) {
        summary.criteria.b = { ...(await criterionB(page)) };
      }
      if (want('c')) {
        summary.criteria.c = { ...(await criterionC(page)) };
      }
    }
  }
  if (want('a')) {
    const sid = await newSession(PRESET);
    const reading = await criterionA(sid);
    const notice = await waitForNoticeCount(sid, 1, (LONG_RUN_SECONDS + 30) * 1000);
    summary.criteria.a = { sessionId: sid, noticeCount: notice.count, ...reading };
    record('f-a-one-notice', notice.count === 1,
      `插话路径结算后完成通知 ${String(notice.count)} 条（判据恰 1——撤销在先、结算照发；若模型自建 async_wait 等到结算，则按 (e) 相同的活 waiter 语义应为 0——提示词已明令禁止，见头注）`);
  }
  if (want('d')) {
    const sid = await newSession(PRESET);
    summary.criteria.d = { sessionId: sid };
    await criterionD(sid);
  }
  if (want('e')) {
    const sid = await newSession(PRESET);
    summary.criteria.e = { sessionId: sid };
    await criterionE(sid);
  }
} catch (error) {
  record('probe-error', false, `${String(error?.stack ?? error)}`);
} finally {
  if (browser !== null) browser.close();
  const pass = results.filter((r) => r.ok).length;
  summary.total = results.length;
  summary.pass = pass;
  summary.fail = results.length - pass;
  summary.results = results;
  writeFileSync(join(LOG_DIR, 'r32-run-interruptible.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`\n真机探针：${String(pass)}/${String(results.length)}（证据目录 logs/r32-run-interruptible.json）`);
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}
