/**
 * queue 不打断等待且轮次边界投递的真机回归判据（验证实例，需求 §2.1.2）；steer 仍打断。
 *
 * 对应需求 §2.1.2、设计 §2.2（queue 不进入唤醒判断，保持宿主下一轮领取语义）。三条判据缺一不可：
 *  A. 长等待期间发 **queue** 消息 → 等待**不**被打断（结果里没有"等待被打断"，
 *     且有"仍在运行"= 等满预算才返回）；
 *  B. 本轮结束 → 排队消息被宿主领取进新轮次（user/message 出现且模型回应了消息里的约定标记
 *     ——**回应是投递的实证**，模型只能回应它收到过的东西）；
 *  C. 随后另一次等待期间发 **steer** 消息 → 立即返回"等待被打断/用户插话已送达"，
 *     且 **job_list 的工具结果行**显示该作业仍在 running（需求 §2.1.2 的实证——只认 job_list
 *     的渲染行 `async-command-N [async-command] running`；句柄文案与模型自述是软证据，
 *     作业已不在运行时也可能被满足，不作回退依据）。
 *
 * 改前基线（旧实现 queue 也打断）见 `verify/probe-queue-baseline.mjs` 与其落盘的
 * queue-baseline.json——两条探针合起来构成"改前/改后"的对照。
 *
 * 用法：node verify/probe-queue-delivery.mjs
 * 证据：本机证据目录 logs/queue-delivery.json；任一判据不成立退出码 1。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { rpc, rowOf, transcriptOf, localConfig } from './_rpc.mjs';
import { SUBJECT_UNTOUCHED, WAIT_INTERRUPTED, WAIT_AGAIN } from './message-markers.mjs';
import { NS, elevateSession } from './_r28-helpers.mjs';

const CWD = localConfig.workspaceDir;
const PRESET = 'dsh-async';
const OUT = join(localConfig.evidenceDir, 'logs', 'queue-delivery.json');
const QUEUE_MARKER = '排队投递标记';
const STEER_MARKER = '插话投递标记';
const QUEUE_TEXT = `${QUEUE_MARKER}：这条消息是用 queue 模式发进队列的。当它真正到达你时，请只回复一行：QUEUE_DELIVERED_OK`;
const STEER_TEXT = `${STEER_MARKER}：这是插话（steer）。收到后只做一件事：调用一次 job_list，把其中 async-command 开头且状态是 running 的那一行原样贴出，然后立即结束回合。`;

// 起跑前把设置写回出厂默认（上游残留会让窗口假窄）。
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

async function prompt(text, mode) {
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      mode,
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
}

function userTextOf(event) {
  const content = event.data?.content ?? event.data?.message?.content ?? [];
  return content.map((b) => (b?.type === 'text' ? String(b.text ?? '') : '')).join(' ');
}

/** 全部工具结果文本（0.2.0 转录形状：渲染文本块 type:'text'，句柄在 message.toolCallId
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

/** 轮询直到谓词命中或超时。 */
async function until(describe, predicate, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    const page = await transcriptOf(sessionId);
    const row = await rowOf(sessionId);
    if (await predicate(page, row)) return page;
    if (Date.now() - startedAt > timeoutMs) return page;
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
  }
}

/** 定位"指定 wait_ms 的等待已经出现在转录里且会话在跑"后再等两拍，返回是否到达发消息的窗口。 */
async function waitForWaitWindow(waitMs, timeoutMs) {
  const startedAt = Date.now();
  let firstSeen = -1;
  let polls = 0;
  for (;;) {
    polls += 1;
    const page = await transcriptOf(sessionId);
    const row = await rowOf(sessionId);
    const seen = page.records.some((r) => {
      if (r.event?.type !== 'tool/call' || r.event.data?.name !== 'async_wait_job') return false;
      return new RegExp(`wait_ms"\\s*:\\s*${String(waitMs)}`).test(String(r.event.data.arguments ?? ''));
    });
    if (seen && firstSeen < 0) firstSeen = polls;
    if (firstSeen >= 0 && polls - firstSeen >= 2 && row.running === true) return true;
    if (Date.now() - startedAt > timeoutMs) return false;
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
  }
}

const verdicts = [];
function judge(name, ok, detail = '') {
  verdicts.push({ name, ok: ok === true, detail: String(detail).slice(0, 200) });
  console.log(`${ok === true ? 'PASS ' : 'FAIL '} ${name}${detail === '' ? '' : `  —— ${String(detail).slice(0, 160)}`}`);
}

// ── 阶段 A：queue 不打断 + 轮次边界投递 ─────────────────────────────────────
console.log('── 阶段 A：queue 消息不应打断等待 ──');
await prompt([
  '请严格按两步做：',
  '第 1 步：用 async_run 执行 `Start-Sleep -Seconds 240; Write-Output PATIENCE_A`，传 yield_ms=1500。拿到 job_id 后立刻用 async_wait_job 等它，wait_ms=45000。',
  '第 2 步：那次 async_wait_job 返回后（无论 status 是什么），不要再调用任何工具，直接用一句话原样引用返回里"等待被打断"或"仍在运行"那句，然后结束回合。'
].join('\n'), 'queue');

const windowA = await waitForWaitWindow(45000, 60000);
if (!windowA) throw new Error('阶段 A：没能定位到 wait_ms=45000 的等待窗口');
await prompt(QUEUE_TEXT, 'queue');
console.log('已发出 queue 消息，等待本轮走完（等满 45 秒预算后应返回 running）…');

// 阶段 A 完成 = 见过 running 之后转 idle，且模型回应了 queue 消息的标记。
let sawRunningA = false;
const pageA = await until('阶段 A 完成', async (page, row) => {
  if (row.running === true) sawRunningA = true;
  const replied = page.records.some((r) => r.event?.type === 'assistant/message' && userTextOf(r.event).includes('QUEUE_DELIVERED_OK'));
  return sawRunningA && row.running === false && replied;
}, 200000);
const textsA = toolResultTexts(pageA);
const deliveredA = pageA.records.find((r) => r.event?.type === 'user/message' && userTextOf(r.event).includes(QUEUE_MARKER));
const replyA = pageA.records.some((r) => r.event?.type === 'assistant/message' && userTextOf(r.event).includes('QUEUE_DELIVERED_OK'));
const turnEndBeforeDeliveryA = deliveredA === undefined
  ? null
  : pageA.records.some((r) => r.event?.type === 'turn/end' && r.event.seq < deliveredA.event.seq);

judge('场景A判据1 queue 消息没有打断等待：等待结果不含打断锚，且含预算到期锚（等满预算才返回；两语标记）',
  !textsA.some((t) => WAIT_INTERRUPTED.test(t)) && textsA.some((t) => WAIT_AGAIN.test(t)),
  textsA.filter((t) => WAIT_INTERRUPTED.test(t) || WAIT_AGAIN.test(t)).map((t) => JSON.stringify(t.slice(0, 80))).join(' | '));
judge('场景A判据2 queue 消息在轮次结束后被投递为 user/message，且模型回应了约定标记（投递的硬证据）',
  deliveredA !== undefined && turnEndBeforeDeliveryA === true && replyA === true,
  `user/message=${String(deliveredA !== undefined)} 先有 turn/end=${String(turnEndBeforeDeliveryA)} 回应=${String(replyA)}`);
judge('场景A判据3 阶段 A 全程没有出现任何打断锚（queue 是本阶段唯一的用户消息；两语标记）',
  !textsA.some((t) => WAIT_INTERRUPTED.test(t)),
  textsA.find((t) => WAIT_INTERRUPTED.test(t))?.slice(0, 120) ?? '');

// ── 阶段 B：steer 仍然打断，作业不受影响 ─────────────────────────────────────
console.log('── 阶段 B：steer 消息应打断等待 ──');
await prompt([
  '请严格按三步做：',
  '第 1 步：用 async_run 执行 `Start-Sleep -Seconds 240; Write-Output PATIENCE_B`，传 yield_ms=1500。拿到 job_id 后立刻用 async_wait_job 等它，wait_ms=60000。',
  '第 2 步：那次 async_wait_job 返回后，若 status 是 interrupted：第 3 步调用一次 job_list，把该作业那一行原样贴出，然后结束回合。若不是 interrupted，直接结束回合并说明。'
].join('\n'), 'queue');

const windowB = await waitForWaitWindow(60000, 60000);
if (!windowB) throw new Error('阶段 B：没能定位到 wait_ms=60000 的等待窗口');
await prompt(STEER_TEXT, 'steer');
console.log('已发出 steer 插话，等待它打断…');

let sawRunningB = false;
const pageB = await until('阶段 B 完成', async (page, row) => {
  if (row.running === true) sawRunningB = true;
  return sawRunningB && row.running === false;
}, 150000);

// 只看阶段 B 新增的记录（阶段 A 的转录可能也含 job 文本）。
const seqA = pageA.records.at(-1)?.event?.seq ?? 0;
const textsB = toolResultTexts({ records: pageB.records.filter((r) => (r.event?.seq ?? 0) > seqA) });

judge('场景B判据1 steer 消息打断了等待：结果含打断锚（两语标记）',
  textsB.some((t) => WAIT_INTERRUPTED.test(t)),
  textsB.find((t) => WAIT_INTERRUPTED.test(t))?.slice(0, 140) ?? '');
judge('场景B判据2 打断的返回里明说作业未受影响（需求 §2.1.2 的文案半边）',
  textsB.some((t) => SUBJECT_UNTOUCHED.test(t)),
  textsB.find((t) => SUBJECT_UNTOUCHED.test(t))?.slice(0, 120) ?? '');
// B3 只认 **job_list 的工具结果行**（渲染格式 `async-command-N [async-command] running`，
// 判据文档均按此格式引用 job_list 输出）。让出句柄文案（`命令仍在运行：…`）
// 不含 `[async-command]` 标记，不可能误满足；模型自述不再作为回退依据——它不是证据。
const JOB_LIST_RUNNING = /async-command-\d+\s*\[async-command\]\s*running/;
judge('场景B判据3 打断后 job_list 的工具结果显示该作业仍在 running（需求 §2.1.2 的硬证据）',
  textsB.some((t) => JOB_LIST_RUNNING.test(t)),
  textsB.find((t) => JOB_LIST_RUNNING.test(t))?.slice(0, 160)
    ?? `阶段 B 工具结果里没有 job_list 渲染行（共 ${String(textsB.length)} 条工具结果）`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ sessionId, verdicts, pageA: pageA.records.length, pageB: pageB.records.length }, null, 2), 'utf8');
const failed = verdicts.filter((v) => !v.ok);
console.log('');
console.log(`${String(verdicts.length - failed.length)}/${String(verdicts.length)} 条判据成立。`);
if (failed.length > 0) console.log(`不成立：${failed.map((v) => v.name).join('、')}`);
process.exitCode = failed.length === 0 ? 0 : 1;
