/**
 * 基线探针（在收窄打断信号**之前**跑）：记录"queue 模式消息"的现行行为。
 *
 * 要回答的两个问题（都不设断言，只记录——这是取证，不是回归判据）：
 *  1. queue 消息（落 `next-turn`）会不会打断 async_wait_job 的等待？
 *     （旧实现只判 `source.kind === 'user'`，不区分落点——按源码推断"会"，此处取活体证据。）
 *  2. 本轮结束（turn/end）之后，宿主会不会把 `next-turn` 里排队的消息领取进新轮次
 *     （user/message 出现）？——这是"收窄后 queue 消息还能不能被投递"的宿主侧地基。
 *
 * 用法：node verify/probe-queue-baseline.mjs
 * 证据：verify/logs/queue-baseline.json + 控制台 RECORD 行。退出码恒 0。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { rpc, rowOf, transcriptOf, localConfig } from './_rpc.mjs';
import { NS, elevateSession } from './_r28-helpers.mjs';
import { WAIT_INTERRUPTED } from './message-markers.mjs';

const CWD = localConfig.workspaceDir;
const PRESET = 'dsh-async';
const OUT = join(localConfig.evidenceDir, 'logs', 'queue-baseline.json');
const QUEUE_MARKER = '排队投递测试';
const QUEUE_TEXT = `${QUEUE_MARKER}：这条消息是用 queue 模式发进队列的。当它真正到达你时，请只回复一行：QUEUE_RECEIVED_OK`;

// 起跑前把设置写回出厂默认（上游残留的 maxWaitMs 会让窗口假窄）。
const DEFAULTS = {
  maxResultChars: 30000, defaultYieldMs: 20000, minYieldMs: 1000, maxYieldMs: 600000,
  defaultWaitMs: 30000, minWaitMs: 250, maxWaitMs: 600000, pollIntervalMs: 500, jobKind: 'async-command'
};
// ns 单一登记点 `_r28-helpers.mjs`（各探针统一从这里取，不自带字面量）。
await rpc('settings/replace', { ns: NS, section: DEFAULTS });

const created = await rpc('session/create', { request: { cwd: CWD, agentPreset: PRESET } });
if (created.agentPreset !== PRESET) throw new Error(`session/create fell back: ${String(created.agentPreset)}`);
const sessionId = created.sessionId;
// 环境前置：本验证实例（LocalSystem 托管服务）受限档 spawn 必死，长命令前先升档
// （见 `_r28-helpers.elevateSession` 头注）。
await elevateSession(sessionId);
console.log(`sessionId=${sessionId}`);

const TASK = [
  '请严格按两步做：',
  '第 1 步：用 async_run 执行 `Start-Sleep -Seconds 300; Write-Output PATIENCE`，传 yield_ms=1500。拿到 job_id 后立刻用 async_wait_job 等它，wait_ms=120000。',
  '第 2 步：那次 async_wait_job 返回后（无论 status 是什么），不要再调用任何工具，直接用一句话原样引用返回里"等待被打断"或"仍在运行"那句，然后结束回合。'
].join('\n');

await rpc('session/prompt', {
  request: {
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: TASK }],
    clientTimeZone: 'Asia/Shanghai'
  }
});

/** 提取一条 user/message 的纯文本。 */
function userTextOf(event) {
  const content = event.data?.content ?? event.data?.message?.content ?? [];
  return content.map((b) => (b?.type === 'text' ? String(b.text ?? '') : '')).join(' ');
}

/** 工具结果文本（0.2.0 转录形状：渲染文本块 type:'text'，句柄在 message.toolCallId
 *  ——旧 'tool-result' 块形状在现行转录中 0 次出现，与 async-e2e 同款形状判据）。 */
function toolResultTexts(page) {
  const texts = [];
  for (const record of page.records) {
    if (record.event?.type !== 'tool/result') continue;
    texts.push((record.event.data?.message?.content ?? [])
      .filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join(''));
  }
  return texts;
}

const startedAt = Date.now();
let sawRunning = false;
let queueSent = false;
let queueSentAt = 0;
let waitFirstSeenPoll = -1;
let pollCount = 0;
let turnEndedAfterQueue = false;
let turnEndAt = 0;
const evidence = { sessionId, preset: PRESET, queueSplice: undefined, waitInterrupted: undefined, turnEndedAfterQueue: undefined, queueDelivered: undefined, deliveredAtSeq: undefined, modelRepliedToQueue: undefined, timings: {} };

for (;;) {
  await new Promise((resolve) => { setTimeout(resolve, 2000); });
  pollCount += 1;
  const row = await rowOf(sessionId);
  const page = await transcriptOf(sessionId);
  if (row.running === true) sawRunning = true;

  // queue 消息落队证据：agent/inbox/spliced 且 target 为 next-turn、含标记文本。
  if (evidence.queueSplice === undefined) {
    for (const record of page.records) {
      const event = record.event;
      if (event?.type !== 'agent/inbox/spliced') continue;
      if (event.data?.target !== 'next-turn') continue;
      if ((event.data.inserted ?? []).some((m) => userTextOf({ data: m }).includes(QUEUE_MARKER))) {
        evidence.queueSplice = { seq: event.seq, at: Date.now() - startedAt };
        console.log(`RECORD +${String(evidence.queueSplice.at)}ms queue 消息落进 next-turn（seq=${String(event.seq)}）`);
      }
    }
  }

  // 定位长等待（wait_ms=120000），两拍后发 queue 消息（窗口定位法与 async-e2e 同款）。
  const longWaitActive = page.records.some((r) => {
    if (r.event?.type !== 'tool/call' || r.event.data?.name !== 'async_wait_job') return false;
    return /wait_ms"\s*:\s*120000/.test(String(r.event.data.arguments ?? ''));
  });
  if (longWaitActive && waitFirstSeenPoll < 0) waitFirstSeenPoll = pollCount;
  if (!queueSent && waitFirstSeenPoll >= 0 && pollCount - waitFirstSeenPoll >= 2 && row.running === true) {
    queueSent = true;
    queueSentAt = Date.now();
    await rpc('session/prompt', {
      request: {
        requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: QUEUE_TEXT }],
        clientTimeZone: 'Asia/Shanghai'
      }
    });
    evidence.timings.queueSentAtMs = Date.now() - startedAt;
    console.log(`RECORD +${String(evidence.timings.queueSentAtMs)}ms 发出 queue 消息`);
  }

  // 打断证据：queue 消息发出之后，等待的工具结果里出现打断锚（两语标记）。
  if (queueSentAt > 0 && evidence.waitInterrupted === undefined) {
    const interrupted = toolResultTexts(page).some((t) => WAIT_INTERRUPTED.test(t));
    if (interrupted) {
      evidence.waitInterrupted = true;
      evidence.timings.interruptSeenAtMs = Date.now() - startedAt;
      console.log(`RECORD +${String(evidence.timings.interruptSeenAtMs)}ms 等待被打断（queue 消息打断了等待——旧实现的行为）`);
    }
  }

  // 轮次结束证据：queue 消息之后出现 turn/end。
  if (queueSentAt > 0 && !turnEndedAfterQueue) {
    const endAfter = page.records.find((r) => r.event?.type === 'turn/end' && (evidence.queueSplice === undefined || r.event.seq > evidence.queueSplice.seq));
    if (endAfter !== undefined) {
      turnEndedAfterQueue = true;
      turnEndAt = Date.now();
      evidence.turnEndedAfterQueue = true;
      evidence.timings.turnEndAtMs = Date.now() - startedAt;
      console.log(`RECORD +${String(evidence.timings.turnEndAtMs)}ms queue 消息之后本轮结束（turn/end seq=${String(endAfter.event.seq)}，reason=${JSON.stringify(endAfter.event.data?.reason?.kind ?? null)}）`);
    }
  }

  // 投递证据：queue 消息之后出现含标记的 user/message（即被领取进新轮次）。
  if (queueSentAt > 0 && evidence.queueDelivered === undefined) {
    const delivered = page.records.find((r) => r.event?.type === 'user/message' && userTextOf(r.event).includes(QUEUE_MARKER));
    if (delivered !== undefined) {
      evidence.queueDelivered = true;
      evidence.deliveredAtSeq = delivered.event.seq;
      evidence.timings.deliveredAtMs = Date.now() - startedAt;
      console.log(`RECORD +${String(evidence.timings.deliveredAtMs)}ms queue 消息被投递为 user/message（seq=${String(delivered.event.seq)}）`);
    }
  }

  // 模型回应证据：投递之后出现含 QUEUE_RECEIVED_OK 的 assistant 消息。
  if (evidence.queueDelivered === true && evidence.modelRepliedToQueue === undefined) {
    const replied = page.records.find((r) => {
      if (r.event?.type !== 'assistant/message') return false;
      if (evidence.deliveredAtSeq !== undefined && r.event.seq <= evidence.deliveredAtSeq) return false;
      return userTextOf(r.event).includes('QUEUE_RECEIVED_OK');
    });
    if (replied !== undefined) {
      evidence.modelRepliedToQueue = true;
      evidence.timings.modelRepliedAtMs = Date.now() - startedAt;
      console.log(`RECORD +${String(evidence.timings.modelRepliedAtMs)}ms 模型对 queue 消息作出回应（QUEUE_RECEIVED_OK）`);
    }
  }

  // 收尾条件：模型回应完成；或轮次结束后又等了 60 秒仍没投递（判"未投递"）；或总超时。
  if (evidence.modelRepliedToQueue === true) break;
  if (turnEndedAfterQueue && Date.now() - turnEndAt > 60000) {
    if (evidence.queueDelivered === undefined) evidence.queueDelivered = false;
    if (evidence.waitInterrupted === undefined) evidence.waitInterrupted = false;
    console.log(`RECORD +${String(Date.now() - startedAt)}ms 轮次结束 60 秒后仍无投递——判"未投递"`);
    break;
  }
  if (Date.now() - startedAt > 280000) {
    if (evidence.queueDelivered === undefined) evidence.queueDelivered = false;
    if (evidence.waitInterrupted === undefined) evidence.waitInterrupted = false;
    console.log('RECORD 总超时（280 秒），按已观察到的证据收卷');
    break;
  }
  if (sawRunning && row.running === false && queueSent && turnEndedAfterQueue && evidence.queueDelivered === true && evidence.modelRepliedToQueue === undefined && Date.now() - turnEndAt > 45000) {
    console.log('RECORD 会话已空闲但模型未回应 queue 消息（投递了但没回应）');
    break;
  }
}

// 完整转录一并落盘。
const finalPage = await transcriptOf(sessionId);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ evidence, page: finalPage }, null, 2), 'utf8');
console.log(`wrote ${OUT}`);
console.log('SUMMARY ' + JSON.stringify(evidence));
