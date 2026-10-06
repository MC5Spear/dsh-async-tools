#!/usr/bin/env node
/**
 * probe-r26-create-preset.mjs —— R26「异步创造模式」第二份预设的实机验收探针（验证实例）。
 *
 * 用法：node verify/probe-r26-create-preset.mjs <face|drill|both>
 *   face  —— 部署态全量判据（重启装载第三份 patch 后跑）：
 *            ① 新会话选 dsh-async-create 不回退；② 工具目录（启用行在场/禁用行缺席）；
 *            ③ async_agent→async_wait_agent 有界等待取回；④ 插话打断等待而子代理照跑；
 *            ⑤ 隔离对照（dsh-async 预设面貌不变：subagent 双入口仍在）。
 *   drill —— 回滚态判据（package.json 摘掉第三项并重启后跑）：
 *            dsh-async-create 必须开不出来（报错或回退）；dsh-async 必须仍可用。
 *   both  —— 复原态快查（两项都在花名册上、都能开新会话）。
 *
 * 边界（诚实声明）：
 * - persona 四锚句这半边**不从转录取证**——`request/header` 不含 systemPrompt
 *   （r17 审查 r17-1 裁定，probe-agent-e2e.mjs 头注同款口径），由
 *   `tools/validate-preset.mjs` 判据⑤静态看守；本探针只验「真机上行为与目录」半边。
 * - 断言文案来自真实返回（async-e2e 的教训：不臆造英文 `interrupted`，中文返回里没有）。
 * - 证据：本机证据目录 logs/r26-create-<相位>.json（判据逐条 + 关键返回片段 + 会话号）。
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { instanceCredentials, loadLocalPlaneOrSkip } from '../tools/_local-config.mjs';

const localConfig = await loadLocalPlaneOrSkip('verify/probe-r26-create-preset.mjs');
const { base: BASE, tokenFile: TOKEN_FILE } = instanceCredentials(localConfig);
const OUT_DIR = join(localConfig.evidenceDir, 'logs');
mkdirSync(OUT_DIR, { recursive: true });
const CWD = localConfig.workspaceDir;

const PHASE = process.argv[2] ?? 'face';
if (!['face', 'drill', 'both'].includes(PHASE)) {
  console.error(`用法：node verify/probe-r26-create-preset.mjs <face|drill|both>（实得 ${PHASE}）`);
  process.exit(2);
}

/** @type {string} */
let cookie = '';

function readToken() {
  const raw = readText(TOKEN_FILE);
  const at = raw.indexOf('http');
  if (at < 0) throw new Error(`token file has no URL: ${TOKEN_FILE}`);
  return new URL(raw.slice(at)).searchParams.get('token');
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

async function connect() {
  const indexResponse = await fetch(`${BASE}/?token=${readToken()}`, { redirect: 'manual' });
  cookie = (indexResponse.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
  if (cookie.length === 0) throw new Error('token exchange returned no cookie（令牌过期：实例可能已重启）');
}

async function rpc(endpoint, args = {}) {
  const rpcId = `r26-${Math.random().toString(36).slice(2, 10)}`;
  const response = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } })
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`${endpoint}: 非 JSON 返回：${text.slice(0, 200)}`); }
  if (body?.result?.ok !== true) {
    const err = new Error(`${endpoint}: ${JSON.stringify(body?.result?.error ?? text.slice(0, 300))}`);
    err.rpcError = true;
    throw err;
  }
  return body.result.value;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 起会话并核对预设没有被静默回退（纪律：回退的会话不产证据）。 */
async function newSession(preset) {
  const created = await rpc('session/create', { request: { cwd: CWD, agentPreset: preset } });
  if (created.agentPreset !== preset) {
    const e = new Error(`预设回退：要 ${preset}，得到 ${String(created.agentPreset)}`);
    e.fellBack = true;
    throw e;
  }
  return created.sessionId;
}

async function prompt(sessionId, text, mode = 'queue') {
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

async function rowOf(sessionId) {
  const row = (await rpc('session/list', { _request: {} })).items.find((x) => x.sessionId === sessionId);
  if (row === undefined) throw new Error(`会话 ${sessionId} 不在清单里`);
  return row;
}

async function transcriptOf(sessionId) {
  const row = await rowOf(sessionId);
  return rpc('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 400 }
  });
}

/** 模型实收工具面（第一条 request/header）。 */
function faceOf(pageResult) {
  for (const record of pageResult.records ?? []) {
    if (record.event?.type !== 'request/header') continue;
    const tools = record.event.data?.header?.tools ?? [];
    return { names: tools.map((t) => String(t.name)), tools };
  }
  return null;
}

/** tool/call 的 arguments 兼容取值：可能是对象，也可能是 JSON 字符串（0.1.7 实测
 *  两种都出现过——字符串形态下 `.wait_ms` 恒 undefined，首轮探针因此没发过插话）。 */
function argsOf(data) {
  if (typeof data?.arguments === 'string') {
    try { return JSON.parse(data.arguments); } catch { return {}; }
  }
  return data?.arguments ?? {};
}

/** 转录里的工具调用与结果文本。
 *  字段与形状（验证实例实测，0.1.7）：tool/call 用 callId；tool/result 的 message 带
 *  toolCallId，正文是 message.content[].type==='text' 的文本块——不是旧探针里
 *  嵌套的 tool-result 块。两种形状都收，避免版本漂移再咬一次。 */
function callsOf(pageResult) {
  const calls = [];
  const resultsById = new Map();
  for (const record of pageResult.records ?? []) {
    const event = record.event;
    if (event?.type === 'tool/call') {
      calls.push({ name: event.data.name, callId: event.data.callId, args: argsOf(event.data) });
    } else if (event?.type === 'tool/result') {
      const message = event.data?.message ?? {};
      if (typeof message.toolCallId === 'string') {
        const text = (message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
        if (text !== '') resultsById.set(message.toolCallId, text);
      }
      for (const block of message.content ?? []) {
        if (block.type === 'tool-result') {
          resultsById.set(block.toolCallId, (block.content ?? []).map((p) => p.text ?? '').join(''));
        }
      }
    }
  }
  return { calls, resultsById };
}

/** 子代理中继消息（user/message，source.kind ∈ agent-message/subagent-settled——
 *  子代理最终回答以独立消息到达，只扫 assistant/message 会漏，2026-09-18 实测）。 */
function childMessagesOf(pageResult) {
  const out = [];
  for (const record of pageResult.records ?? []) {
    const event = record.event;
    if (event?.type !== 'user/message') continue;
    const source = event.data?.source ?? {};
    if (source.kind === 'agent-message' || source.kind === 'subagent-settled') {
      out.push({ kind: source.kind, text: (event.data?.content ?? []).map((b) => b.text ?? '').join('') });
    }
  }
  return out;
}

/** 判据记录器：name/ok/detail，结尾统一落盘 + 总判定退出码。 */
const verdicts = [];
function record(name, ok, detail) {
  verdicts.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

// ── 工具目录口径（§28.2 行集 → 模型面工具名；名字取自验证实例实测 faceNames，
//    不从开发实例的会话推断——两实例组合不同，tool-cordis 在验证实例只注册
//    cordis_inspect_list/cordis_inspect_query 两件）────────────────────────────
const CREATE_MUST_HAVE = [
  'async_run', 'async_wait_job', 'async_wait_agent', 'async_agent', // 四行 async（手术 3）
  'read', 'glob', 'grep', 'write', 'edit',                           // tool-fs（基线启用）
  'web_search', 'web_fetch',                                        // tool-web
  'ask_user_question', 'todo_write', 'skill',                       // 交互/规划行
  'cordis_inspect_list', 'cordis_inspect_query',                    // tool-cordis（创造侧独有于 dsh-async）
  'workflow',                                                       // tool-workflow
  'job_list', 'job_output',                                         // tool-jobs
  'interrupt_agent', 'list_agents',                                 // tool-subagent-control（行在场，管理面保留）
  'exit_plan_mode', 'create_goal', 'get_goal', 'update_goal',       // planning 组（goal 行）
  'present', 'send_message'                                         // tool-present / tool-subagent-control
];
// 禁用/摘除行 → 模型面不得出现的工具名（R26 e2e 判据②：禁用行的工具不在目录）。
const CREATE_MUST_NOT_HAVE = [
  'pwsh', 'bash',                        // tool-pwsh 摘除（手术 2b）/ tool-bash 布尔禁用（手术 1）
  'run_code',                            // 呈现面 native（R2）
  'subagent', 'subagent_fork',           // 裁决 A：结构性唯一入口
  'subagent_codex', 'subagent_claude_code', // 基线本就禁用
  'ralph'                                // 基线禁用（F86）
];
// 隔离对照：dsh-async 的面貌必须不变（R14 双入口仍在、async 四件也在）。
const ASYNC_MUST_HAVE = ['async_run', 'async_wait_job', 'async_wait_agent', 'async_agent', 'subagent', 'subagent_fork'];
// 面差集口径（裁决 A 的实机面）：create 独有 = tool-cordis 的两件；control 独有 = 双入口。
const CREATE_ONLY_EXPECTED = ['cordis_inspect_list', 'cordis_inspect_query'];
const CONTROL_ONLY_EXPECTED = ['subagent', 'subagent_fork'];

// ── face 相位 ────────────────────────────────────────────────────────────────
async function phaseFace() {
  console.log(`=== face：部署态判据（${BASE}）===`);
  // ① 新会话选预设不回退 + ② 工具目录
  const s1 = await newSession('dsh-async-create');
  record('① 新会话选 dsh-async-create，无静默回退', true, `sessionId=${s1}`);

  await prompt(s1, '（不需要做任何事，请直接回答：READY）');
  for (let i = 0; i < 60; i += 1) {
    await sleep(2000);
    const row = await rowOf(s1);
    if (row.running === false) break;
  }
  const face = faceOf(await transcriptOf(s1));
  if (face === null) throw new Error('转录里没有 request/header（工具面判据无从取数）');
  const missing = CREATE_MUST_HAVE.filter((n) => !face.names.includes(n));
  const leaked = CREATE_MUST_NOT_HAVE.filter((n) => face.names.includes(n));
  record('②a 创造侧启用行的工具在场（含四 async + cordis/workflow）', missing.length === 0,
    missing.length === 0 ? `${String(face.names.length)} 个工具` : `缺：${missing.join(', ')}`);
  record('②b 禁用/摘除行的工具不在目录（pwsh/bash/run_code/subagent×4/ralph）', leaked.length === 0,
    leaked.length === 0 ? '零泄漏' : `泄漏：${leaked.join(', ')}`);

  // ③+④ 派生→有界等待→插话打断。
  // 长子任务刻意做**慢**（约 2000 字输出，flash 也要写半分钟以上）——400 字太快，
  // 首轮实测等待在插话落地前就正常返回了（无打断证据，④a 假红）。
  const TASK = [
    '请严格按步做，每步 finish 前不要做别的：',
    '第 1 步：用 async_agent 派生一个子代理，prompt 让它「计算 17×23 并只回答这个数字」，不要传 provider/model。',
    '第 2 步：立刻用 async_wait_agent 等它，wait_ms=120000，把子代理的回答记下来。',
    '第 3 步：再用 async_agent 派生第二个子代理，prompt 让它「写一篇约 2000 字的中文短文，主题：异步，写完才算完成」。',
    '第 4 步：拿到第二个 agent_id 后立刻用 async_wait_agent 等它，wait_ms=600000。',
    '第 5 步（关键）：若第 4 步返回「等待被打断」，就用**同一个 agent_id** 再次 async_wait_agent、wait_ms=600000，把短文取回。',
    '全部做完后回答两行：第一行 Q1=<17×23 的答案>；第二行 DONE。'
  ].join('\n');
  await prompt(s1, TASK);

  const startedAt = Date.now();
  let sawRunning = false;
  let nonRunning = 0;
  let interjectionCount = 0;
  const MAX_INTERJECTIONS = 3;
  let longWaitSeenPoll = -1;
  let lastSteerPoll = -99;
  let pollCount = 0;

  for (;;) {
    await sleep(2000);
    pollCount += 1;
    const row = await rowOf(s1);
    const page = await transcriptOf(s1);
    if (row.running === true) { sawRunning = true; nonRunning = 0; } else { nonRunning += 1; }
    // 任务轮已开始 = 转录里出现过 async_agent 调用（防 READY 轮结束瞬间的假收敛）。
    const taskStarted = (page.records ?? []).some((r) => r.event?.type === 'tool/call' && r.event.data?.name === 'async_agent');

    // v4 插话窗口（状态不是时刻，async-e2e 的四版教训）：async_wait_agent 且 wait_ms
    // 很大 → 两拍后发 steer；若这轮等待已正常返回而打断证据未出现，则在**下一次**
    // 长等待里重试（有界 3 次）。
    const longWaitActive = (() => {
      for (const record of page.records) {
        const event = record.event;
        if (event?.type !== 'tool/call' || event.data?.name !== 'async_wait_agent') continue;
        const waitMs = Number(argsOf(event.data).wait_ms ?? 0);
        if (waitMs >= 300000) return true;
      }
      return false;
    })();
    const interruptSeen = (() => {
      const { resultsById: rById } = callsOf(page);
      for (const t of rById.values()) { if (/等待被打断/.test(String(t))) return true; }
      return false;
    })();
    if (longWaitActive && longWaitSeenPoll < 0) longWaitSeenPoll = pollCount;
    console.log(`poll#${String(pollCount)} running=${String(row.running)} task=${String(taskStarted)} longWait=${String(longWaitActive)} interrupted=${String(interruptSeen)} steers=${String(interjectionCount)}`);
    if (longWaitActive && !interruptSeen && longWaitSeenPoll > 0 && pollCount >= longWaitSeenPoll + 2
      && pollCount - lastSteerPoll >= 3 && interjectionCount < MAX_INTERJECTIONS) {
      interjectionCount += 1;
      lastSteerPoll = pollCount;
      await prompt(s1, '（插话：请继续按原步骤走完，不要改动任何参数。）', 'steer');
      console.log(`+${String(Date.now() - startedAt)}ms 第 ${String(interjectionCount)} 次插话已发（steer）`);
    }

    if (sawRunning && taskStarted && nonRunning >= 2) break;
    if (Date.now() - startedAt > 420000) { console.log('TIMEOUT（③④ 轮未收敛）'); break; }
  }

  const finalPage = await transcriptOf(s1);
  const { calls, resultsById } = callsOf(finalPage);
  const childMessages = childMessagesOf(finalPage);
  const agentCalls = calls.filter((c) => c.name === 'async_agent');
  const waitCalls = calls.filter((c) => c.name === 'async_wait_agent');
  const waitTexts = waitCalls.map((c) => resultsById.get(c.callId)).filter((t) => typeof t === 'string');
  const firstAgentText = agentCalls.length > 0 ? resultsById.get(agentCalls[0].callId) : undefined;
  record('③a async_agent 被真的调用并立返（agent_id 在结果里）',
    agentCalls.length >= 2 && typeof firstAgentText === 'string' && /agent_id/i.test(firstAgentText),
    firstAgentText === undefined ? '无结果文本' : JSON.stringify(firstAgentText.slice(0, 120)));
  // ③b 口径（契约事实，0.1.7 实测）：等待返回只报结算（「状态转为 idle…不再被观察」），
  // 子代理的**回答**以独立消息到达（agent-message/subagent-settled）。判据 = 两半：
  // 有界等待真的返回了（结算文案）+ 391 出现在子代理中继消息里。
  const firstWaitSettled = waitTexts.some((t) => /idle|不再被观察|完成/.test(t));
  const answerMessage = childMessages.find((m) => /391/.test(m.text));
  record('③b async_wait_agent 有界等待返回 + 子代理回答独立到达（agent-message 含 391）',
    firstWaitSettled && answerMessage !== undefined,
    `等待结算=${String(firstWaitSettled)}；回答消息=${answerMessage === undefined ? '未见' : `${answerMessage.kind} len=${String(answerMessage.text.length)}`}`);
  const interrupted = waitTexts.filter((t) => /等待被打断/.test(t));
  record('④a 插话打断等待（等待返回「等待被打断」）',
    interrupted.length >= 1,
    interrupted.length === 0 ? '未见打断文案' : JSON.stringify(interrupted[0].slice(0, 120)));
  // ④b 子代理未被打断杀：2000 字短文完整到达（len>150 排除只含任务描述的短结算文案；
  // 首轮实测 settle 文案只有 ~60 字，短文本体 500+ 字）。
  const essayMessage = childMessages.find((m) => m.text.length > 150 && /异步/.test(m.text));
  record('④b 子代理照跑到底（2000 字短文完整到达）',
    essayMessage !== undefined,
    essayMessage === undefined ? '未见短文本体' : `${essayMessage.kind} len=${String(essayMessage.text.length)}`);
  const finalTexts = (finalPage.records ?? [])
    .flatMap((r) => (r.event?.type === 'assistant/message'
      ? r.event.data?.message?.content ?? []
      : []))
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '').join('\n');
  record('③c 主线汇报 Q1=391（端到端答案一致）', /Q1\s*=\s*391/.test(finalTexts),
    JSON.stringify((finalTexts.match(/Q1[^\n]*/) ?? ['（无）'])[0].slice(0, 40)));

  // ⑤ 隔离对照：dsh-async 面貌不变 + 面差集恰为裁决 A 的形状
  const s2 = await newSession('dsh-async');
  await prompt(s2, '（不需要做任何事，请直接回答：READY）');
  for (let i = 0; i < 60; i += 1) {
    await sleep(2000);
    const row = await rowOf(s2);
    if (row.running === false) break;
  }
  const face2 = faceOf(await transcriptOf(s2));
  const missing2 = ASYNC_MUST_HAVE.filter((n) => !face2?.names.includes(n));
  record('⑤a 隔离对照：dsh-async 预设面貌不变（async 四件 + subagent 双入口都在）',
    missing2.length === 0, missing2.length === 0 ? `${String(face2?.names.length ?? 0)} 个工具` : `缺：${missing2.join(', ')}`);
  const createOnly = face.names.filter((n) => !face2?.names.includes(n));
  const controlOnly = (face2?.names ?? []).filter((n) => !face.names.includes(n));
  record('⑤b 面差集恰为裁决 A 的形状（create 独有 = cordis inspect 双件；control 独有 = subagent 双入口）',
    createOnly.join(',') === CREATE_ONLY_EXPECTED.join(',') && controlOnly.join(',') === CONTROL_ONLY_EXPECTED.join(','),
    `create 独有=[${createOnly.join(', ')}]；control 独有=[${controlOnly.join(', ')}]`);

  return { s1, s2, faceNames: face.names, face2Names: face2?.names ?? [] };
}

// ── drill 相位（回滚态）──────────────────────────────────────────────────────
async function phaseDrill() {
  console.log('=== drill：回滚态判据（第三项已摘、已重启）===');
  let createGone = false;
  let how = '';
  try {
    const sid = await newSession('dsh-async-create');
    how = `居然开出来了：${sid}`;
  } catch (err) {
    createGone = err.rpcError === true || err.fellBack === true;
    how = err.message.slice(0, 160);
  }
  record('R1 回滚后 dsh-async-create 开不出来（报错或回退）', createGone, how);

  let asyncAlive = false;
  let how2 = '';
  try {
    const sid = await newSession('dsh-async');
    asyncAlive = true;
    how2 = `sessionId=${sid}`;
  } catch (err) {
    how2 = err.message.slice(0, 160);
  }
  record('R2 回滚后 dsh-async 仍可用（第一份补丁不受牵连）', asyncAlive, how2);
}

// ── both 相位（复原态快查）───────────────────────────────────────────────────
async function phaseBoth() {
  console.log('=== both：复原态快查（第三项已恢复、已重启）===');
  for (const preset of ['dsh-async', 'dsh-async-create']) {
    let ok = false;
    let how = '';
    try {
      const sid = await newSession(preset);
      ok = true;
      how = `sessionId=${sid}`;
    } catch (err) {
      how = err.message.slice(0, 160);
    }
    record(`B ${preset} 在花名册上、能开新会话`, ok, how);
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
await connect();
const evidence = { phase: PHASE, base: BASE, at: new Date().toISOString(), verdicts: [] };
if (PHASE === 'face') {
  const extra = await phaseFace();
  evidence.sessions = { create: extra.s1, control: extra.s2 };
  evidence.faceNames = extra.faceNames;
  evidence.controlFaceNames = extra.face2Names;
} else if (PHASE === 'drill') {
  await phaseDrill();
} else {
  await phaseBoth();
}
evidence.verdicts = verdicts;
const out = join(OUT_DIR, `r26-create-${PHASE}.json`);
writeFileSync(out, JSON.stringify(evidence, null, 2), 'utf8');
const failed = verdicts.filter((v) => !v.ok);
console.log(`\n判据 ${String(verdicts.length - failed.length)}/${String(verdicts.length)}；证据 ${out}`);
process.exit(failed.length > 0 ? 1 : 0);
