/**
 * async_workflow 编排工具与预设隔离的真机探针（需求 §2.4 后台编排、设计 §3.5 编排作业、
 * §3.6 预设隔离）。
 *
 * 判据（全部取自验证实例）：
 * - (a) 即时性·插话：编排脚本（6 agent 串行慢跑）+ yield_ms=60000；**同步点 =
 *   转录出现 async_workflow 的 tool/call**（本工具无审批环节，不存在
 *   approval/decided，同步点只认 tool/call）→ steer → tool/result
 *   距 steer ≤ 5000 ms + 句柄 + 提前让出锚；结算后完成通知恰 1 条（前缀
 *   `(async-workflow: <name>)`）。
 * - (b) 即时性·abort：GUI 会话同景点「停止生成」→ ≤5 s（形状如实登记：handle
 *   为设计形状、aborted/empty 为宿主改写——dsh-tools 在调用信号已中止时丢弃
 *   工具返回值）+ run 存活 + 结算后完成
 *   通知恰 1 条（abort 的恢复通道）。
 * - (c) 呈现：任务卡 label=`meta.name`、progress=`meta.description`、结算后
 *   progress 清除（卡内断言——正文断言会被提示词回显污染）。
 * - (d) 触顶：与 async_run 同池（每 owner 出厂存活上限 10，设计 §3.5）——混编 11 连发（6 命令 +
 *   5 编排）第 11 条 startRefused（含 limit 与出路锚句）；收尾 session/cancel。
 * - (e) 预算内结算：短编排（1 agent 即回）→ 渲染文本 `workflow "x" completed
 *   (1 agent)`（zh 档 `workflow「x」已完成（1 个子代理）`）+ Return value／返回值
 *   JSON + 零完成通知（活 waiter）。
 * - (f) 描述门槛（需求 §2.4：使用条件与替代入口说明）：dsh-async / dsh-async-create 两预设 request/header
 *   里 `async_workflow` 在场且描述含 p2 门槛短语、宿主 `workflow` 与
 *   `subagent` 系缺席；standard 对照：宿主 workflow 与 subagent 在场（需求 §3.2 隔离对照）。
 * - (g) GUI 运行节点：转录出现 `tool-workflow/run-start`…`run-end` 四记录类型
 *   （recorder 复用范围活体）；GUI 运行视图显示该 run（CDP 读）；不可达则记
 *   未验证（需求 §8.1，不冒充通过）。
 *
 * 用法：node verify/probe-r34-async-workflow.mjs [--only=a,b,c,d,e,f,g]
 * （(b)(c)(g) 的 GUI 侧需要 Edge/Chrome——找不到时如实 FAIL 'cdp-missing'。）
 * 证据落本机证据目录 logs/r34-async-workflow.json。
 *
 * 共享实例纪律：不动别人的设置与语言档；会话建在 dsh-async 预设下，
 * 锚句双档自适应（渲染文两种语言档都认）。
 * 时序锚：本工具无审批环节——一切"窗口内"动作以转录出现
 * async_workflow 的 tool/call 为同步点，不是 approval/decided。
 * 通知计数只认 `user/message + source(tool-jobs, notice)` 且按消息 id 去重
 * （request/header 自带工具描述示例会误报）。
 *
 * @module verify/probe-r34-async-workflow
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rpc, transcriptOf, localConfig } from './_rpc.mjs';
import { newSession, prompt, waitTurnEnd, elevateSession, NS, PRESET } from './_r28-helpers.mjs';
import { YIELD_EARLY_BY_USER as EARLY_ANCHOR, START_REFUSED as REFUSED_ANCHOR, WORKFLOW_COMPLETED as COMPLETED_ANCHOR, WORKFLOW_RETURN as RETURN_ANCHOR, WORKFLOW_P2_PHRASE as P2_PHRASE } from './message-markers.mjs';
import { findBrowser, launch, openPage, evaluate, waitFor } from './_visual/cdp.mjs';

const LOG_DIR = join(localConfig.evidenceDir, 'logs');
mkdirSync(LOG_DIR, { recursive: true });
const URL_LINE = readFileSync(localConfig.tokenFile, 'utf8').trim();
const APP_URL = URL_LINE.slice(URL_LINE.indexOf('http'));
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 即时性窗口（与设计 §8.1 的 5000 ms 真实运行窗口一致）：毫秒。 */
const IMMENSITY_MS = 5000;
/** (a)(b) 的首次等待时长（预算路径必须排不出 ≤5 s 的返回）。 */
const YIELD_MS = 60000;
/** tool/call 落转录后的入窗等待：注册+引擎启动毫秒级，2 s 足够落进让出窗口。 */
const POST_CALL_MS = 2000;
/**
 * 语法判据锚。词典句锚（提前结束注记、触顶拒绝、完成渲染头两半、门槛短语）已
 * 收敛到共享锚模块 `verify/message-markers.mjs`（两语成对；漂移由
 * test/message-markers.test.mjs 的 `t()` 两档渲染回归钉住）。留在本地的两枚按
 * 设计 §8.3 口径豁免：`HANDLE_ANCHOR` 是 `lib/output.js` 代码构造的调用句式
 * 字面量、`ABORT_ANCHOR` 是宿主 dsh-tools 的改写文本，均非本包词典成句。
 */
const HANDLE_ANCHOR = /async_wait_job\(job_id="/;
const ABORT_ANCHOR = /Error: tool call aborted/;

/**
 * 编排脚本体：
 * - 慢跑（(a)(b)(c)(d)）：6 个 agent **串行**（每个真实派生 ~10-20 s，全程
 *   ~1-2 min，超过首次等待时长）——子代理只回一个词，不跑命令（不涉及命令提权范围）。
 * - 快跑（(e)(g)）：1 个 agent 即回（预算内结算）。
 */
const SLOW_SCRIPT = 'const out = []; for (const label of ["s1","s2","s3","s4","s5","s6"]) { out.push(await agent("reply with the single word ok", { label })); } return { done: out.length };';
const FAST_SCRIPT = 'const v = await agent("reply with the single word ok", { label: "fast-1" }); return { value: v };';

const results = [];
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console[ok ? 'log' : 'error'](`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
};

/** 防撞尾缀：每轮 run 的 meta.name/标记唯一——旧 run 的同名会话不会再被扫中。 */
const TAG = Date.now().toString(36).slice(-4);

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

/** 转录里指定工具的 tool/result 文本列表（按 callId 配对 tool/call）。 */
function toolResultTexts(transcript, toolName) {
  const records = transcript.records ?? [];
  const nameById = new Map();
  for (const r of records) {
    if (r.event?.type === 'tool/call') nameById.set(r.event.data?.callId, r.event.data?.name);
  }
  const texts = [];
  for (const r of records) {
    if (r.event?.type !== 'tool/result') continue;
    if (nameById.get(r.event.data?.message?.toolCallId) !== toolName) continue;
    texts.push((r.event.data?.message?.content ?? [])
      .filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('\n'));
  }
  return texts;
}

/** 转录里某事件类型的 data 列表。 */
function eventsOf(transcript, type) {
  return (transcript.records ?? []).filter((r) => r.event?.type === type).map((r) => r.event.data);
}

/** 轮询转录直到谓词命中；返回 { transcript, elapsedMs }。 */
async function pollUntil(sessionId, predicate, { maxMs = 120000, everyMs = 500, t0 = Date.now() } = {}) {
  for (;;) {
    const transcript = await transcriptOf(sessionId);
    if (predicate(transcript)) return { transcript, elapsedMs: Date.now() - t0 };
    if (Date.now() - t0 > maxMs) throw new Error(`pollUntil 超时（${String(maxMs)} ms）`);
    await sleep(everyMs);
  }
}

/** 等到转录出现 async_workflow 的 tool/call（本探针一切窗口动作的同步点）。 */
function workflowCalled(transcript) {
  return eventsOf(transcript, 'tool/call').some((d) => d?.name === 'async_workflow');
}
async function waitWorkflowCalled(sessionId, n = 1) {
  return pollUntil(sessionId,
    (t) => eventsOf(t, 'tool/call').filter((d) => d?.name === 'async_workflow').length >= n,
    { maxMs: 180000 });
}

/**
 * 完成通知计数：只认 `user/message + source(tool-jobs, notice)`，
 * 按消息 id 去重；文本需含 async-workflow 字样与完成语义。
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
    if (/async-workflow/.test(text) && /(finished|completed|已完成)/.test(text)) {
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

/** 结果形状分类（设计形状与宿主改写两副面孔，如实登记）。 */
function classifyResult(text) {
  if (HANDLE_ANCHOR.test(text) || EARLY_ANCHOR.test(text)) return 'handle';
  if (ABORT_ANCHOR.test(text)) return 'aborted';
  if (text.trim() === '') return 'empty';
  return 'other';
}

/**
 * 会话升档（用户裁定：探针可经 GUI 自动化执行）：
 * workflow 引擎的 PTC worker 按**父会话现行档位**取沙箱（dsh-workflow-ptc:632
 * `sandboxPolicy.resolve({session})`）；验证实例是托管服务、无 logon SID，受限档下
 * CreateRestrictedToken 必死（实读：引擎同步抛 `workflow execution failed
 * (sandbox-unavailable)`）。`/permission danger-full-access` 经 GUI composer 提交
 * （命令弹出层认领，dsh-client-ui-commands 的 submit 事务）——顺带把审批档切到
 * never，(d) 的混编 async_run 免去 15-46 s/次的审批串行。
 */
async function guiEnsureFullAccess(page) {
  await guiSendText(page, '/permission danger-full-access');
  await sleep(3000);
}

/** RPC 侧核对某会话已升档（只读；升档动作只经 GUI）。 */
async function assertElevated(sessionId) {
  const transcript = await transcriptOf(sessionId);
  const elevated = (transcript.records ?? []).some((r) => r.event?.type === 'sandbox/mode'
    && r.event.data?.mode === 'danger-full-access');
  if (!elevated) throw new Error('会话升档失败：转录无 sandbox/mode danger-full-access（GUI 命令未被接受？）');
}

/** 编排提示词：让模型按给定参量调 async_workflow（一次编排，name 固定）。 */
function workflowPrompt(name, description, scriptBody, yieldMs, extra = '') {
  return [
    `Call the async_workflow tool now with EXACTLY these parameters (do not reword, do not explain, do not do anything else first):`,
    `- meta.name = "${name}"`,
    `- meta.description = "${description}"`,
    `- script = a string whose body is: ${scriptBody}`,
    `- yield_ms = ${String(yieldMs)}`,
    extra,
    'While it yields, do nothing else and do not call any other tool — wait.',
    'If the yield ends early with a handle note, do NOT call async_wait_job and do NOT wait for the job — just reply ack and finish your turn.'
  ].join('\n');
}

// —— CDP 面（GUI-first：RPC 建的会话不在 GUI 当前视图） ——

/** GUI 会话内点按运行态控件（现场标定：停止键 aria-label「停止生成」）。 */
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
 * `agentPresets/select` 给它定 dsh-async（宿主只拒「已开始」的会话；
 * diag 链全程证实：select 采纳→composer 发词→async_workflow 真被调）。
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

/** GUI：向当前会话键入提示词并点发送（contenteditable 通道，r32 实测）。 */
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

/**
 * GUI blank 会话的物化与升档（0.2.0 校准，diag7b 实测）：blank 行上选好的预设
 * 只随**普通首发消息**的物化生效——`/permission` 作为首发消息触发物化时，
 * 该回合请求落回 standard 工具集（r34b 真机会话 27 工具无 async_*、模型自答
 * "no such tool" 实证）。故先用无害小消息物化（预设随请求生效），再走 RPC
 * 升档（与 a/e 相同通道），最后才发正式提示词。
 * @param {object} page - CDP 会话。
 * @param {string} sessionId - blank 行会话 id（物化保 id）。
 */
async function guiMaterializeAndElevate(page, sessionId) {
  await guiSendText(page, 'Setup: reply with just the word "ack" and end your turn. Do not call any tool.');
  await waitTurnEnd(sessionId);
  await elevateSession(sessionId);
}

/**
 * RPC 侧定位 GUI 新建的会话：按提示词标记扫**按 updatedAt 排序的最新一批**
 * （session/list 的行序不是时间序——384 行里新会话排在任意处；跳过读不了的
 * 子代理档——a 相跑完后列表里满是 workflow 子代理会话）。
 */
async function findGuiSession(promptMark) {
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    await sleep(3000);
    const listing = await rpc('session/list', { _request: {} });
    const newest = [...listing.items].sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0)).slice(0, 15);
    for (const row of newest) {
      const t = await transcriptOf(row.sessionId).catch(() => null);
      if (t === null) continue;
      const hit = (t.records ?? []).some((r) => r.event?.type === 'user/message'
        && JSON.stringify(r.event.data ?? {}).includes(promptMark));
      if (hit) return row.sessionId;
    }
  }
  throw new Error(`GUI 会话未能在 RPC 侧定位（90 s 内无提示词标记「${promptMark}」命中）`);
}

/**
 * 任务面板里目标作业卡的文本（卡=含 `async-workflow` 与 meta.name 的最深 div；
 * 断言只认卡内文本——正文级断言会被提示词回显污染）。
 */
async function jobCardText(page, label) {
  const card = await evaluate(page, `(() => {
    const label = ${JSON.stringify(label)};
    const els = [...document.querySelectorAll('div')]
      .filter((el) => (el.textContent || '').includes('async-workflow') && (el.textContent || '').includes(label) && (el.textContent || '').length < 400)
      .sort((a, b) => ((a.textContent || '').length - (b.textContent || '').length));
    return els.length === 0 ? '' : els[0].textContent || '';
  })()`);
  return typeof card === 'string' ? card : '';
}

// ── 判据实现 ───────────────────────────────────────────────────────────────

/** (a) 即时性·插话（RPC 定向建会话＋升档；插话走 RPC steer）。
 *
 * (a)(e) 不经 GUI 建会话：0.2.0 的「新建会话」默认落**标准
 * 模式**（新任务页 seat 默认；diag 链实证），提示词会打进 standard 会话——模型
 * 只有宿主 workflow 可用，等不到 async_workflow 调用。
 * 本两相判据全在转录侧（时序/形状/通知计数），会话管理改 RPC 显式预设＋
 * `_r28-helpers.elevateSession`（GUI composer /permission 的同一提交事务）。
 * (b)(c)(g) 的 GUI 断言仍 GUI-first；(d) 待同法改造。 */
async function phaseA() {
  const name = `wf-r34a-${TAG}`;
  const sessionId = await newSession(PRESET);
  await elevateSession(sessionId);
  await prompt(sessionId, workflowPrompt(name, 'R34 probe phase A', SLOW_SCRIPT, YIELD_MS));
  await waitWorkflowCalled(sessionId);
  await sleep(POST_CALL_MS);
  const t0 = Date.now();
  await steer(sessionId, 'Status check: reply with just the word "ack" and end your turn. Do not call async_wait_job or any other tool; do not wait for the job.');
  const { transcript } = await pollUntil(sessionId,
    (t) => toolResultTexts(t, 'async_workflow').length > 0, { maxMs: 30000, t0 });
  const elapsed = Date.now() - t0;
  const text = toolResultTexts(transcript, 'async_workflow')[0] ?? '';
  const shape = classifyResult(text);
  record('a-1-immediacy', elapsed <= IMMENSITY_MS,
    `steer → tool/result ${String(elapsed)} ms ≤ ${String(IMMENSITY_MS)} ms（预算 ${String(YIELD_MS)} ms 排除预算路径）`);
  record('a-2-shape', shape === 'handle' && EARLY_ANCHOR.test(text),
    `插话结束首次等待：形状=${shape}（handle+early=设计形状）；样例：${text.slice(0, 160)}`);
  // 结算后完成通知恰 1 条（慢跑 ~1-2 min；5 min 预算）。
  const notice = await waitForNoticeCount(sessionId, 1, 300000);
  record('a-3-one-notice', notice.count === 1,
    `完成通知 ${String(notice.count)} 条（判据恰 1；样例：${(notice.samples[0] ?? '').slice(0, 120)}）`);
}

/** (b) 即时性·GUI 停止（abort 不接 cancel；恢复通道=完成通知）。 */
async function phaseB(page) {
  const name = `wf-r34b-${TAG}`;
  // 0.2.0：GUI 新建默认标准模式——blank 会话经 RPC 定 dsh-async（见
  // guiBlankSession 头注），升档与提示词仍走 composer，断言与标准路径全同。
  const sid = await guiBlankSession(page, PRESET);
  await guiMaterializeAndElevate(page, sid);
  await guiSendText(page, workflowPrompt(name, 'R34 probe phase B', SLOW_SCRIPT, YIELD_MS));
  await waitWorkflowCalled(sid);
  await sleep(POST_CALL_MS);
  const stopT0 = Date.now();
  const hit = await clickByLabel(page, /^(停止生成|停止|Stop generation|Stop|⏹)$/);
  if (hit === '') {
    record('b-0-stop-click', false, '未找到「停止生成」键（运行态发送键换装现场已标定，重跑仍失配则再标定）');
    return;
  }
  const { transcript } = await pollUntil(sid,
    (t) => toolResultTexts(t, 'async_workflow').length > 0, { maxMs: 30000, t0: stopT0 });
  const elapsed = Date.now() - stopT0;
  const text = toolResultTexts(transcript, 'async_workflow')[0] ?? '';
  const shape = classifyResult(text);
  record('b-1-immediacy', elapsed <= IMMENSITY_MS, `停止 → tool/result ${String(elapsed)} ms ≤ ${String(IMMENSITY_MS)} ms`);
  record('b-2-shape-honest', shape === 'handle' || shape === 'aborted' || shape === 'empty',
    `形状如实登记=${shape}（handle=设计形状；aborted/empty=宿主改写）；样例：${text.slice(0, 140)}`);
  const notice = await waitForNoticeCount(sid, 1, 300000);
  record('b-3-run-survives', notice.count === 1,
    `abort 后 run 存活并由完成通知恢复：${String(notice.count)} 条（判据恰 1——cancelCalls=0 的真机体）`);
}

/** (c) 呈现：任务卡 label=meta.name、progress=meta.description、结算后清除。 */
async function phaseC(page) {
  const name = `wf-r34c-${TAG}`;
  const desc = `R34 probe panel phase ${TAG}`;
  const sid = await guiBlankSession(page, PRESET);
  await guiMaterializeAndElevate(page, sid);
  await guiSendText(page, workflowPrompt(name, desc, SLOW_SCRIPT, 1000));
  await waitWorkflowCalled(sid);
  await sleep(POST_CALL_MS);
  const opened = await clickByLabel(page, /个后台任务/);
  if (opened === '') {
    record('c-0-panel-open', false, '未找到任务面板入口（N 个后台任务运行中）');
    return;
  }
  const runningCard = await jobCardText(page, name);
  record('c-1-label-name', runningCard.includes(name), `任务卡 label=meta.name（卡内实读：${runningCard.slice(0, 120)}）`);
  record('c-2-progress-description', runningCard.includes(desc), 'progress 行=meta.description（活动期卡内可见）');
  // 等结算（慢跑 ~1-2 min + 余量）：通知到 → progress 清除、label 仍在。
  await waitForNoticeCount(sid, 1, 300000);
  const settledCard = await jobCardText(page, name);
  record('c-3-progress-cleared',
    settledCard !== '' && !settledCard.includes(desc) && settledCard.includes(name),
    `结算后卡内 progress 行清除、label 仍在（卡内实读：${settledCard.slice(0, 140)}）`);
}

/** (d) 触顶：与 async_run 同池混编 11 连发 → 第 11 条 startRefused。
 * 会话管理同 (a)(e)：RPC 定向＋elevateSession（本部署审批档为
 * 自动审批，无审批串行；判据全在转录侧）。 */
async function phaseD() {
  const sessionId = await newSession(PRESET);
  await elevateSession(sessionId);
  // 触顶要同窗并存：6 条 sleep-600 命令 + 5 个慢编排（串行 3 agent，~40 s+）——
  // 用快编排时第 11 条启动前已有 2 个结算完，在册数从未到 11。
  await prompt(sessionId,
    'Fire 11 calls in ONE batch (same turn, back to back, no waiting between them): '
    + 'calls 1-6 are async_run, each running Start-Sleep -Seconds 600 with yield_ms=1000 and description "limit probe N" (N=1..6); '
    + `calls 7-11 are async_workflow, each with meta.name="wf-limit-N-${TAG}" (N=7..11), meta.description="limit probe N", `
    + `script='${SLOW_SCRIPT}' and yield_ms=1000. `
    + 'Do not retry failed calls. '
    + 'Then report exactly which calls returned a job_id and which failed, quoting each failure text verbatim.');
  // 让出：10 min 预算。
  await waitTurnEnd(sessionId, 600000);
  const transcript = await transcriptOf(sessionId);
  const text = JSON.stringify(transcript.records ?? []);
  record('d-1-refused-anchor', REFUSED_ANCHOR.test(text), '第 11 条文案含「进程启动前被拒」锚（同池准入在先）');
  record('d-2-limit-ten', /limit: 10|current limit: 10|当前上限:? 10/.test(text), '复述生效上限 10（与 async_run 同池，设计 §3.5）');
  record('d-3-way-out', /job_kill/.test(text), '给出 kill/等待出路');
  await rpc('session/cancel', { request: { sessionId } }).catch((error) => {
    console.log(`cleanup session/cancel: ${String(error?.message ?? error)}`);
  });
}

/** (e) 预算内结算：渲染文本形态 + 零完成通知（会话管理同 (a)：RPC 定向）。 */
async function phaseE() {
  const name = `wf-r34e-${TAG}`;
  const sessionId = await newSession(PRESET);
  await elevateSession(sessionId);
  await prompt(sessionId, workflowPrompt(name, 'R34 probe phase E', FAST_SCRIPT, YIELD_MS));
  await pollUntil(sessionId,
    (t) => toolResultTexts(t, 'async_workflow').length > 0, { maxMs: 180000 });
  const text = toolResultTexts(await transcriptOf(sessionId), 'async_workflow')[0] ?? '';
  const okShape = COMPLETED_ANCHOR.test(text) && RETURN_ANCHOR.test(text);
  record('e-1-render', okShape, `渲染文本形态（completed 锚 + Return value）：${text.slice(0, 160)}`);
  const notice = await waitForNoticeCount(sessionId, 0, 15000);
  record('e-2-zero-notice', notice.count === 0, `预算内结算零完成通知（实得 ${String(notice.count)}——活 waiter 语义）`);
}

/** (f) 描述门槛（需求 §2.4：双预设 + standard 对照）。 */
const hasTool = (header, name) => header.includes(`"name":"${name}"`);
async function checkPresetFace(presetId, expectAsyncFace) {
  const sessionId = await newSession(presetId);
  await prompt(sessionId, '只回复 ok，不要调用任何工具。');
  await waitTurnEnd(sessionId);
  const transcript = await transcriptOf(sessionId);
  const header = JSON.stringify((transcript.records ?? []).find((r) => r.event?.type === 'request/header') ?? {});
  const hasAsyncWorkflow = hasTool(header, 'async_workflow');
  const hasP2 = P2_PHRASE.test(header);
  const hostWorkflow = hasTool(header, 'workflow');
  const subagent = hasTool(header, 'subagent') || hasTool(header, 'subagent_fork');
  if (expectAsyncFace) {
    record(`f-${presetId}`, hasAsyncWorkflow && hasP2 && !hostWorkflow && !subagent,
      `async_workflow 在场=${String(hasAsyncWorkflow)}；p2 门槛短语=${String(hasP2)}；宿主 workflow 缺席=${String(!hostWorkflow)}；subagent 系缺席=${String(!subagent)}`);
  } else {
    record(`f-${presetId}-contrast`, hostWorkflow && subagent,
      `standard 对照：宿主 workflow 在场=${String(hostWorkflow)}；subagent 在场=${String(subagent)}（需求 §3.2 隔离对照）`);
  }
}

async function phaseF() {
  await checkPresetFace('dsh-async', true);
  await checkPresetFace('dsh-async-create', true);
  await checkPresetFace('standard', false);
}

/** (g) recorder 复用范围（四记录类型）+ GUI 运行视图（尽力而为）。 */
async function phaseG(guiPage) {
  const name = `wf-r34g-${TAG}`;
  const sessionId = await guiBlankSession(guiPage, PRESET);
  await guiMaterializeAndElevate(guiPage, sessionId);
  await guiSendText(guiPage, workflowPrompt(name, 'R34 probe phase G', FAST_SCRIPT, YIELD_MS));
  await assertElevated(sessionId);
  await pollUntil(sessionId,
    (t) => toolResultTexts(t, 'async_workflow').length > 0, { maxMs: 180000 });
  const full = JSON.stringify(await transcriptOf(sessionId));
  const types = ['tool-workflow/run-start', 'tool-workflow/agent-start', 'tool-workflow/agent-end', 'tool-workflow/run-end'];
  const present = types.filter((type) => full.includes(type));
  record('g-1-records', present.length === 4,
    `四记录类型齐备：${present.join(', ')}（缺：${types.filter((t) => !present.includes(t)).join(', ') || '无'}）`);
  if (guiPage === null) {
    record('g-2-gui', false, 'cdp-missing：无浏览器可连，GUI 运行视图未取证（按需求 §8.1 如实降级登记，不冒充）');
    return;
  }
  try {
    const runView = await evaluate(guiPage, 'document.body.innerText');
    record('g-2-gui', runView.includes(name), `GUI 运行视图显示 ${name}`);
  } catch (error) {
    record('g-2-gui', false, `GUI 侧取证失败：${String(error?.message ?? error)}（如实登记）`);
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const want = (id) => only.length === 0 || only.includes(id);

const summary = { ranAt: new Date().toISOString(), ns: NS, preset: PRESET, results: [] };
let browser = null;
let page = null;
try {
  // GUI 只剩 (b)(c)(g) 的界面断言需要（停止键/任务卡/运行视图）；(a)(d)(e)
  // RPC 定向（会话管理不走 GUI，默认权限即可跑）。
  const needGui = want('b') || want('c') || want('g');
  if (needGui) {
    const browserPath = findBrowser();
    if (browserPath === undefined || browserPath === null) {
      record('cdp-missing', false, '找不到 Edge/Chrome：GUI 侧判据无法取证（如实记录，不冒充）');
    } else {
      browser = await launch(browserPath, ['--lang=zh-CN']);
      page = await openPage(browser.port, 'about:blank');
      await page.send('Page.navigate', { url: APP_URL });
      await waitFor(page, 'document.querySelectorAll("#root *").length', (n) => Number(n) > 20, 30_000);
      await sleep(2000);
    }
  }
  const guiReady = (id) => {
    if (page === null) { record(id, false, 'cdp-missing：浏览器不可用，本相未取证'); return false; }
    return true;
  };
  if (want('a')) await phaseA();
  if (want('b') && guiReady('b-phase')) await phaseB(page);
  if (want('c') && guiReady('c-phase')) await phaseC(page);
  if (want('d')) await phaseD();
  if (want('e')) await phaseE();
  if (want('f')) await phaseF();
  if (want('g') && guiReady('g-phase')) await phaseG(page);
} catch (error) {
  record('probe-error', false, String(error?.stack ?? error));
} finally {
  if (browser !== null) browser.close();
  const failed = results.filter((r) => !r.ok).length;
  summary.results = results;
  const path = join(LOG_DIR, 'r34-async-workflow.json');
  writeFileSync(path, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n探针结束：${String(results.length - failed)}/${String(results.length)} 通过；证据 ${path}`);
  process.exitCode = failed === 0 ? 0 : 1;
}
