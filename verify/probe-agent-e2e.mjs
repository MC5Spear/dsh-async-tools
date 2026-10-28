/**
 * 子代理派生与等待的真机端到端证据（验证实例；需求 §2.3、设计 §8 验证设计）。
 *
 * 设置起跑块经共享助手（`verify/_r28-helpers.mjs`）：命名空间是宿主行 entry id
 * `async-tools-host`（不是包名 `async-tools`），嵌套 `settings` 子树形状——与
 * final-acceptance 同一条链。三节取证本体（转录读回）不依赖 settings API。
 *
 * 三件事，全部从**真实会话转录**读回，不碰验证实例以外的任何实例：
 *  1. 模型用 `async_agent` 派生子代理：调用参数只有 description+prompt（没有
 *     run_in_background——后台是结构保证，需求 §2.3.1 的机制半边），结果**立返** started+agent_id，
 *     note 里带可照抄的 async_wait_agent 调用；随后模型用 async_wait_agent 等到 settled，
 *     子代理的最终回答作为**独立消息**出现在会话里（不是塞在等待返回值里）。
 *  2. persona 强制规则（需求 §3.1）的**行为判据**：固定格式四问，值全部定向。
 *     口径（源已核证）：目标宿主 `0.2.1-rc.2` 的 `subagent`／`subagent_fork`
 *     **没有 `run_in_background` 参数**（dsh-tool-subagent 全包无此字面量；工具
 *     描述明说 independently managed、立返 id——结构上恒后台），因此
 *     FALSE_ALLOWED=no **不能区分**「答自 persona」与「答自工具表面」：只看
 *     工具描述的模型同样可能答 no。四问只证**模型作答与 persona 规则一致**
 *     （行为半边）；「规则段真的在系统提示里且生效」的来源半边由模板侧静态
 *     看守承担：validate-preset 五锚句 + `test/preset.test.mjs` +
 *     `verify/mutate-agent.mjs` M2。该轮断言零 tool/call，防止模型现读仓库里
 *     的模板污染行为来源；转录的 `request/header` 不含 systemPrompt，系统
 *     提示原文真机不可直接取证。
 *  3. 隔离对照：standard 预设的会话里四个 async 工具**一个都没有**（需求 §1.2）。
 *
 * 用法：node verify/probe-agent-e2e.mjs；全过退出码 0，证据落盘到本机证据目录的 logs/agent-e2e.json。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { rpc, transcriptOf, localConfig } from './_rpc.mjs';
import * as MESSAGE_MARKERS from './message-markers.mjs';
import { readNs, patchNs } from './_r28-helpers.mjs';

// 探针驱动子代理的工作目录从配置的工作目录派生（仓根的上一级）。
const CWD = dirname(localConfig.workspaceDir);
const LOG_DIR = join(localConfig.evidenceDir, 'logs');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const checks = [];
function record(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
}

// ── 起跑基线：设置写回出厂默认并读回核对（每个真机脚本自己保证起跑状态） ──────────
// 残留窄 `maxWaitMs` 会让 async_wait_agent 早返"仍在运行"，settled 判据假红。
const FACTORY_DEFAULTS = {
  defaultYieldMs: 20000, minYieldMs: 1000, maxYieldMs: 600000,
  defaultWaitMs: 30000, minWaitMs: 250, maxWaitMs: 600000,
  pollIntervalMs: 500, maxResultChars: 30000, jobKind: 'async-command',
  subagentProvider: 'spawn'
};
async function readSettings() {
  return (await readNs()).value;
}

{
  const before = await readSettings();
  const drifted = Object.keys(FACTORY_DEFAULTS).filter((k) => before[k] !== FACTORY_DEFAULTS[k]);
  if (drifted.length > 0) {
    console.log(`起跑前发现设置漂移，先归位：${drifted.map((k) => `${k}=${String(before[k])}`).join(' ')}`);
    await patchNs(FACTORY_DEFAULTS);
  }
  const after = await readSettings();
  const stillDrifted = Object.keys(FACTORY_DEFAULTS).filter((k) => after[k] !== FACTORY_DEFAULTS[k]);
  if (stillDrifted.length > 0) {
    // 带着脏设置跑出来的红是假红，比不跑更糟——直接停（final-acceptance 同款纪律）。
    throw new Error(`起跑基线写不进去，拒绝继续：${stillDrifted.join(', ')}`);
  }
  console.log(`起跑基线：设置全部等于出厂默认值（${drifted.length > 0 ? `本次归位了 ${String(drifted.length)} 项` : '本来就干净'}）。`);
}

async function newSession(preset) {
  const created = await rpc('session/create', { request: { cwd: CWD, agentPreset: preset } });
  if (created.agentPreset !== preset) throw new Error(`预设回退：要 ${preset}，得到 ${String(created.agentPreset)}`);
  return created.sessionId;
}

async function ask(sessionId, text, timeoutMs = 360000) {
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId, mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
  const startedAt = Date.now();
  let sawRunning = false;
  for (;;) {
    await sleep(2000);
    const listing = await rpc('session/list', { _request: {} });
    const row = listing.items.find((item) => item.sessionId === sessionId);
    if (row === undefined) throw new Error('会话消失');
    if (row.running === true) sawRunning = true;
    if (sawRunning && row.running === false) return;
    if (Date.now() - startedAt > timeoutMs) return;
  }
}

/** 当前 asOfSeq——用作"这一问之后新增记录"的游标。 */
async function seqOf(sessionId) {
  const listing = await rpc('session/list', { _request: {} });
  const row = listing.items.find((item) => item.sessionId === sessionId);
  if (row === undefined) throw new Error('会话消失');
  return row.projections.asOfSeq;
}

/** 按事件类型收集：tool/call、tool/result 文本、assistant 文本，以及**子代理中继消息**
 * （子代理的最终回答以 `user/message` 事件到达，`source.kind` 是 agent-message /
 * subagent-settled——只扫 assistant/message 会一无所获）。 */
function parse(page, afterSeq = -1) {
  const calls = [];
  const results = [];
  const assistantTexts = [];
  const childMessages = [];
  for (const record of page.records ?? []) {
    const event = record.event;
    if (typeof event?.seq === 'number' && event.seq <= afterSeq) continue;
    if (event?.type === 'tool/call') calls.push({ name: String(event.data.name), args: String(event.data.arguments) });
    else if (event?.type === 'tool/result') {
      // 结果块两种形状都收：`type: "tool-result"`（嵌套 content 数组）与现行
      // `message.role === "tool"` 下的 `type: "text"`（text 直挂块上）。
      for (const block of (event.data.message?.content ?? [])) {
        if (block.type === 'tool-result') results.push((block.content ?? []).map((p) => p.text ?? '').join(''));
        else if (block.type === 'text' && typeof block.text === 'string') results.push(block.text);
      }
    } else if (event?.type === 'assistant/message') {
      const text = (event.data.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      if (text.trim() !== '') assistantTexts.push(text);
    } else if (event?.type === 'user/message') {
      const source = event.data.source ?? {};
      if (source.kind === 'agent-message' || source.kind === 'subagent-settled') {
        childMessages.push({ kind: source.kind, text: (event.data.content ?? []).map((b) => b.text ?? '').join('') });
      }
    }
  }
  return { calls, results, assistantTexts, childMessages };
}

mkdirSync(LOG_DIR, { recursive: true });
const evidence = { at: new Date().toISOString(), sections: {} };

// ── 1) async_agent 立返 + async_wait_agent 等到 settled + 独立消息 ────────────────
console.log('=== 1) async_agent 派生 → 立返 → 等待 → 独立回答 ===');
const sid = await newSession('dsh-async');
evidence.asyncSessionId = sid;
// wait_ms 给 600000（默认 maxWaitMs 钳制上限），并允许预算到期后**再等一次**：
// 子代理在本实例的端到端延迟方差大（真机读数区间 <180 s 到 >420 s，随实例负载漂移；以探针本轮读数为准；模型排队），
// 单次预算太窄会把"等到 settled"变成"预算到期交还 running"——那是延迟红，不是判据红。
// 等待会在子代理结算时提前返回，预算只是上界；判据取**最后一次**等待的返回。
await ask(sid,
  '请严格按以下步骤执行，不要多做别的：'
  + '1) 调用 async_agent，参数 description="算术验证"，prompt="回答一个问题：3 乘 7 等于多少？'
  + '只回答一行，格式为 ANSWER=<数字>。"；'
  + '2) 拿到返回的 agent_id 后立即调用 async_wait_agent 等它（wait_ms=600000）；'
  + '2b) 若该次等待返回"仍在运行"，就用同一个 agent_id 再调用一次 async_wait_agent（wait_ms=600000），最多等两次；'
  + '3) 等待结束后，不要复述子代理内容，只输出一行 DONE。', 1_260_000);
{
  const { calls, results, assistantTexts, childMessages } = parse(await transcriptOf(sid));
  evidence.sections.s1 = { calls, results, assistantTexts, childMessages };

  const spawnCallIndex = calls.findIndex((c) => c.name === 'async_agent');
  const spawnCall = calls[spawnCallIndex];
  record('模型调用了 async_agent（而不是 subagent/subagent_fork）', spawnCall !== undefined,
    spawnCall === undefined ? `调用清单=${calls.map((c) => c.name).join(',')}` : '调用形参见转录');

  let spawnArgs = {};
  try { spawnArgs = JSON.parse(spawnCall?.args ?? '{}'); } catch { /* 保持空对象，走下面的断言 */ }
  record('调用参数恰好是 description+prompt（没有 run_in_background）',
    spawnCall !== undefined
    && Object.keys(spawnArgs).sort().join(',') === 'description,prompt',
    `实得键=${Object.keys(spawnArgs).join(',')}`);

  // 立返结果与调用序一致（spawn 是第 spawnCallIndex 个调用，其结果也在同序位置）。
  const spawnResultText = results[spawnCallIndex] ?? '';
  const agentId = /agent_id[=: ]+"?([A-Za-z0-9-]+)"?/.exec(spawnResultText)?.[1];
  record('async_agent 立返 started + agent_id', /started/.test(spawnResultText) && agentId !== undefined,
    `片段=${spawnResultText.slice(0, 120).replace(/\n/g, ' ')}`);
  record('立返结果带可照抄的 async_wait_agent 调用', /async_wait_agent\(agent_id="/.test(spawnResultText));

  // 取**最后一次** async_wait_agent 调用（允许二次等待后，settled 出现在末次返回）。
  let waitCallIndex = -1;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (calls[i].name === 'async_wait_agent') { waitCallIndex = i; break; }
  }
  const waitCall = waitCallIndex >= 0 ? calls[waitCallIndex] : undefined;
  record('模型用 async_wait_agent 等待（bounded wait_ms）', waitCall !== undefined
    && /"wait_ms"\s*:\s*\d+/.test(waitCall?.args ?? ''), (waitCall?.args ?? '').slice(0, 80));

  // 结局判据（与现行需求 §2.2/§2.3 一致，两条合法收尾）：CHILD_SETTLED 三选一；或
  // 被可处理消息唤醒——子代理的最终回答（中继）本身在唤醒集里，先于结算事件到达时
  // 等待按 running 交还。唤醒路径要求：文案如实说"目标仍在运行"（不冒称已结束/
  // 答案已到）并保留再等待出路。断言仍然**锚定到 async_wait_agent 那次调用**——
  // 在全量 results 里找会"断言等待收尾、证据却来自别处"。等待
  // 文案是中文，盯 "settled" 字样抓不住。
  const waitResultText = waitCallIndex >= 0 ? (results[waitCallIndex] ?? '') : '';
  const wokeByMessage = MESSAGE_MARKERS.WAIT_WOKE_BY_MESSAGE.test(waitResultText);
  const settledHit = MESSAGE_MARKERS.CHILD_SETTLED.some((m) => m.test(waitResultText));
  record('等待收尾对齐该次调用：settled 三选一，或被消息唤醒且不冒称已结束',
    settledHit || (wokeByMessage && !settledHit && /still running|仍在运行/.test(waitResultText)
      && /async_wait_agent/.test(waitResultText)),
    `片段=${waitResultText.slice(0, 100).replace(/\n/g, ' ')}`);

  // 子代理的最终回答以**独立消息**（user/message，source=agent-message/subagent-settled）
  // 到达——不是塞在等待返回值里。`(?!\d)` 防 ANSWER=215 这类误中。
  const childAnswer = childMessages.find((m) => /ANSWER\s*=\s*21(?!\d)/.test(m.text));
  record('子代理最终回答作为独立消息出现（ANSWER=21）', childAnswer !== undefined,
    childAnswer === undefined
      ? `中继消息=${childMessages.map((m) => `${m.kind}:${m.text.slice(0, 30)}`).join(' | ') || '(无)'}`
      : `source.kind=${childAnswer.kind}`);
}

// ── 2) persona 强制规则的行为判据 ─────────────────────────────────────────
console.log('');
console.log('=== 2) persona 强制规则的行为判据 ===');
{
  // 固定格式四问 + 定向断言（行为判据，见文件头注的口径）：目标宿主
  // `0.2.1-rc.2` 的 subagent/subagent_fork 没有 run_in_background 参数
  // （dsh-tool-subagent 全包无此字面量，工具描述 :384 明说 independently
  // managed、立返 id——结构上恒后台），所以 FALSE_ALLOWED=no 不区分答案来源：
  // 只学工具描述的模型也可能答 no。四问证「作答与 persona 规则一致」；
  // 「规则段在系统提示里且生效」的来源半边由模板侧看守（见文件头注）。
  // 该轮零 tool/call（会话 cwd 就在本仓工作树里，模型现读仓库模板即可
  // 污染行为来源）；系统提示原文不可从转录取证（request/header 无
  // systemPrompt）。
  const watermark = await seqOf(sid);
  await ask(sid, '不要调用任何工具（本轮一次工具都不许调）。只输出下面四行，每行严格按 `键=值` 格式，'
    + '值只能从各自括号里选一个：\n'
    + 'FALSE_ALLOWED=yes|no （在任何情况下，给 subagent 或 subagent_fork 传 run_in_background:false '
    + '是否被你的委派规则允许？）\n'
    + 'AGENT_FOREGROUND=yes|no （你的委派规则里 async_agent 是否有前台模式？）\n'
    + 'WAIT_TOOL=<工具名> （等待后台子代理的结果应该用哪个工具？）\n'
    + 'POLLING_ALLOWED=yes|no （你的委派规则是否允许用轮询循环的方式等待？）');
  const { calls, assistantTexts } = parse(await transcriptOf(sid), watermark);
  const answer = (assistantTexts.at(-1) ?? '').replace(/\s+/g, ' ');
  evidence.sections.s2 = { zeroToolCalls: calls.length === 0, callsAfterWatermark: calls, answer };
  const pick = (key) => new RegExp(`${key}\\s*=\\s*([^\\s]+)`).exec(answer)?.[1];

  record('问答轮零工具调用（防现读模板污染来源）', calls.length === 0,
    calls.length === 0 ? '游标之后无 tool/call' : `意外调用=${calls.map((c) => c.name).join(',')}`);
  record('FALSE_ALLOWED=no（行为判据：作答与 persona 的无条件禁止一致；来源不由此问鉴别）', pick('FALSE_ALLOWED') === 'no',
    `实答=${String(pick('FALSE_ALLOWED'))}`);
  record('AGENT_FOREGROUND=no（async_agent 无前台模式）', pick('AGENT_FOREGROUND') === 'no',
    `实答=${String(pick('AGENT_FOREGROUND'))}`);
  record('WAIT_TOOL=async_wait_agent', pick('WAIT_TOOL') === 'async_wait_agent',
    `实答=${String(pick('WAIT_TOOL'))}`);
  record('POLLING_ALLOWED=no（不许轮询循环）', pick('POLLING_ALLOWED') === 'no',
    `实答=${String(pick('POLLING_ALLOWED'))}`);
  record('模型按 persona 强制规则作答（四问定向全中）', answer.includes('FALSE_ALLOWED=no')
    && answer.includes('AGENT_FOREGROUND=no') && answer.includes('WAIT_TOOL=async_wait_agent')
    && answer.includes('POLLING_ALLOWED=no'), `回答=${answer.slice(0, 160)}`);
}

// ── 3) 隔离对照：standard 四个 async 工具都没有 ──────────────────────────
console.log('');
console.log('=== 3) 隔离：standard 预设不含四个 async 工具 ===');
{
  const std = await newSession('standard');
  evidence.standardSessionId = std;
  await ask(std, '不要调用任何工具。把你这一轮实际可调用的全部工具名按字母序用英文逗号连接，'
    + '输出成单独一行，格式严格为 `TOOLS=name1,name2,...`。不要解释。');
  const { assistantTexts } = parse(await transcriptOf(std));
  const line = (assistantTexts.at(-1) ?? '').match(/TOOLS=([^\n`]+)/)?.[1] ?? '';
  const names = line.split(',').map((s) => s.trim()).filter(Boolean);
  evidence.sections.s3 = { toolsLine: line, names };
  const ASYNC_TOOLS = ['async_run', 'async_wait_job', 'async_wait_agent', 'async_agent'];
  const leaked = ASYNC_TOOLS.filter((t) => names.includes(t));
  record('standard 有 pwsh 且四个 async 工具一个都没有（未泄漏到全局工具层）',
    names.includes('pwsh') && leaked.length === 0,
    `工具数=${String(names.length)}；泄漏=${leaked.join(',') || '无'}`);
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
console.log('');
const failed = checks.filter((c) => !c.passed).length;
writeFileSync(join(LOG_DIR, 'agent-e2e.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
writeFileSync(join(LOG_DIR, 'agent-e2e-summary.json'),
  `${JSON.stringify({ at: evidence.at, sessionIds: { async: sid, standard: evidence.standardSessionId }, checks }, null, 2)}\n`,
  'utf8');
console.log(`总判定：${String(checks.length - failed)}/${String(checks.length)} 通过`);
if (failed > 0) process.exitCode = 1;
