/**
 * 阶段二真机验收驱动（dsh 0.2.0-rc.2 / 验证实例；判据清单 = 需求 §8 验收要求、设计 §8 验证设计）。
 *
 * ## 为什么是"驱动"而不是一次性脚本
 *
 * 验收判据里，有的只要一次 RPC 往返（工具清单、设置命名空间），有的要真会话跑
 * 行为链，还有两项要**重启**验证实例（卸载无残留、跨字段三态链的重启腿）——
 * 重启是破坏性动作，不能与读取混在一条命令里。所以按**相位**切，每个相位独立可复跑：
 *
 * ```
 * node verify/acceptance-017.mjs face      # 工具清单冒烟/零 CJK/无同步 shell + 宿主行在线 + 设置基线（建 1 个会话）
 * node verify/acceptance-017.mjs control   # 对照预设工具清单（建 1 个会话）
 * ```
 *
 * ## 证据口径
 *
 * - 工具清单取自 `session/page` 里的 **`request/header`** 事件，也就是**真正发给模型的
 *   请求体**（防的坑：「描述改了、没验证它到达模型」）。不看 describe 的
 *   返回值、不看本地配置——那是"以为发了什么"。
 * - 令牌默认从托管方的 token 文件读（路径经配置加载器取）：
 *   文件是**截断重写**的，所以每次跑都现读，不缓存。
 * - **实例被别的会话重启过也不许丢证据**：相位体包在 try/catch 里，无论成败都落
 *   `verify/logs/acc017-<phase>.{json,log}`；掉线的相位留下已完成判据 + `phaseError`。
 *
 * @module verify/acceptance-017
 */
import { readFileSync, writeFileSync, mkdirSync, openSync, readSync, readdirSync, statSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { instanceCredentials, loadLocalPlaneOrSkip } from '../tools/_local-config.mjs';
import { judgeDeliveredBytes } from './r24-judgements.mjs';
import { judgeAgentRouting } from './agent-judgements.mjs';

const localConfig = await loadLocalPlaneOrSkip('verify/acceptance-017.mjs');
const BASE = instanceCredentials(localConfig).base;
const CWD = localConfig.workspaceDir;
/** token 落点（托管服务 `AppStdout` 截断重写；不在 `$DSH_HOME` 下）。 */
const TOKEN_FILE = localConfig.tokenFile;
/** 服务错误日志（托管服务 `AppStderr`，**追加**写：只许按字节游标读新增段）。 */
const LOG_PATH = localConfig.serviceLog;
const LOG_DIR = join(localConfig.evidenceDir, 'logs');

const phase = process.argv[2] ?? 'face';
const tokenArg = process.argv.find((a) => a.startsWith('--token='));

const lines = [];
/** 打印并留档（不把输出接进 PowerShell 管道——本机沙箱会拒）。 */
function say(text = '') {
  lines.push(text);
  console.log(text);
}

// ── 判据记账 ────────────────────────────────────────────────────────────────
const checks = [];
/** 会话 id 账（证据里要能指到具体会话）。 */
const sessionIds = {};
/** 工具清单账。 */
const faces = {};
/**
 * 记一条判据。
 * @param {string} name - 判据名（带编号，编号即本文件判据顺序）。
 * @param {boolean} passed - 是否通过。
 * @param {string} [detail] - 读数（必须能被第三方复核）。
 */
function record(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  say(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
}

// ── RPC ────────────────────────────────────────────────────────────────────
function readToken() {
  if (tokenArg !== undefined) return tokenArg.slice('--token='.length);
  const raw = readFileSync(TOKEN_FILE, 'utf8').trim();
  const at = raw.indexOf('http');
  if (at < 0) throw new Error(`token file has no URL: ${TOKEN_FILE}`);
  return new URL(raw.slice(at)).searchParams.get('token');
}

let cookie = '';
/** token 换 cookie（每次跑现读 token：实例重启会换令牌）。 */
async function connect() {
  const indexResponse = await fetch(`${BASE}/?token=${readToken()}`, { redirect: 'manual' });
  cookie = (indexResponse.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
  if (cookie.length === 0) throw new Error('token exchange returned no cookie（令牌过期：实例可能已重启）');
}

/**
 * 调一个网关方法。
 * @param {string} endpoint - 方法名。
 * @param {object} [args] - 参数。
 * @returns {Promise<any>} `result.value`。
 */
async function rpc(endpoint, args = {}) {
  const rpcId = `acc-${Math.random().toString(36).slice(2, 10)}`;
  const response = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } })
  });
  const text = await response.text();
  const body = JSON.parse(text);
  if (body?.result?.ok !== true) {
    throw new Error(`${endpoint}: ${JSON.stringify(body?.result?.error ?? text.slice(0, 300))}`);
  }
  return body.result.value;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 起一个会话并核对预设**没有被静默回退**。
 * @param {string} preset - 预设 id。
 * @returns {Promise<string>} sessionId。
 */
async function newSession(preset) {
  const created = await rpc('session/create', { request: { cwd: CWD, agentPreset: preset } });
  if (created.agentPreset !== preset) {
    throw new Error(`预设回退：要 ${preset}，得到 ${String(created.agentPreset)}`);
  }
  return created.sessionId;
}

/**
 * 发一条提示并等到本轮跑完。
 * @param {string} sessionId - 会话。
 * @param {string} text - 提示文本。
 * @param {number} [timeoutMs] - 上限。
 */
async function ask(sessionId, text, timeoutMs = 240000) {
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
  const startedAt = Date.now();
  let sawRunning = false;
  for (;;) {
    await sleep(1500);
    const row = (await rpc('session/list', { _request: {} })).items.find((x) => x.sessionId === sessionId);
    if (row === undefined) throw new Error('会话消失');
    if (row.running === true) sawRunning = true;
    if (sawRunning && row.running === false) return;
    if (Date.now() - startedAt > timeoutMs) return;
  }
}

/** 读一个会话的转录页。 */
async function page(sessionId, maxMessages = 200) {
  const row = (await rpc('session/list', { _request: {} })).items.find((x) => x.sessionId === sessionId);
  if (row === undefined) throw new Error(`会话 ${sessionId} 不在清单里`);
  return rpc('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages }
  });
}

/**
 * 读一个**子会话**的转录页。
 *
 * 子会话不在 `session/list` 里，也不能用 `{kind:'session'}` 寻址——服务端直接拒：
 * `session/agent-busy`「subagent Sessions require their durable parent address」
 * （`[0.1.7] dsh-api-session-controller/lib/index.js:1533`）。必须给
 * `{kind:'subagent', parentSessionId, childSessionId, mode}`（同包 `lib/types/types.d.ts:382-390`），
 * `mode` 取自父转录的 `subagent/catalog` 事件（`unknown` 可绕过 mode 校验）；
 * 游标走 `session/projections` 取子会话自己的 `asOfSeq`（`throughSeq:-1` 得到的是空页）。
 *
 * @param {string} parentSessionId - 父会话 id。
 * @param {string} childSessionId - 子会话 id（**裸 UUID**，不带 `session-` 前缀）。
 * @param {string} [mode] - `subagent/catalog` 的 `data.mode`。
 * @param {number} [maxMessages] - 页大小。
 * @returns {Promise<object>} `session/page` 的返回。
 */
async function pageChild(parentSessionId, childSessionId, mode = 'unknown', maxMessages = 200) {
  const projections = await rpc('session/projections', { request: { sessionId: childSessionId } });
  const asOfSeq = projections?.value?.asOfSeq ?? projections?.asOfSeq ?? -1;
  return rpc('session/page', {
    request: {
      address: { kind: 'subagent', parentSessionId, childSessionId, mode },
      throughSeq: asOfSeq,
      maxMessages
    }
  });
}

/**
 * 从转录里取**模型实际收到的**工具清单（第一条 `request/header`）。
 * @param {object} pageResult - `session/page` 的返回。
 * @returns {{names: string[], tools: object[]}|null} 工具名与完整 schema 列表。
 */
function faceOf(pageResult) {  for (const record of pageResult.records ?? []) {
    if (record.event?.type !== 'request/header') continue;
    const tools = record.event.data?.header?.tools ?? [];
    return { names: tools.map((t) => String(t.name)), tools };
  }
  return null;
}

/**
 * 从转录里抽工具调用、工具结果与助手文本（按序）。
 * @param {object} pageResult - `session/page` 的返回。
 * @returns {{calls: {name: string, args: string}[], results: string[], assistantText: string}} 三本账。
 */
function parseEvents(pageResult) {
  const calls = [];
  const results = [];
  let assistantText = '';
  for (const record of pageResult.records ?? []) {
    const event = record.event;
    if (event?.type === 'tool/call') calls.push({ name: String(event.data.name), args: String(event.data.arguments) });
    else if (event?.type === 'tool/result') {
      // 转录里 tool/result 的 content 是 [{type:'text',text}]（role:'tool'），
      // GUI 投影里才是 {type:'tool-result', content:[…]} 嵌套形状——两种都要认。
      for (const block of (event.data.message?.content ?? [])) {
        if (block.type === 'tool-result') results.push((block.content ?? []).map((p) => p.text ?? '').join(''));
        else if (block.type === 'text') results.push(`${event.data.isError === true ? '[error] ' : ''}${String(block.text ?? '')}`);
      }
    } else if (event?.type === 'assistant/message') {
      const text = (event.data.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      if (text.trim() !== '') assistantText += `${text}\n`;
    }
  }
  return { calls, results, assistantText };
}

/**
 * 发一条**插话**（steer）：落 `next-step`，在步骤边界被领取——这是"打断等待"
 * 的来源（需求 §2.1.2）。
 * @param {string} sessionId - 会话。
 * @param {string} text - 插话文本。
 */
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

/**
 * 读一个会话转录里出现过的 `sandbox/mode` 事件取值（按序）。
 * @param {object} pageResult - `session/page` 的返回。
 * @returns {string[]} 模式序列（如 `['workspace-write','danger-full-access']`）。
 */
function sandboxModes(pageResult) {
  return (pageResult.records ?? [])
    .filter((r) => r.event?.type === 'sandbox/mode')
    .map((r) => String(r.event.data?.mode ?? ''));
}

/**
 * 建一个**非受限**会话：创建后先发 `/permission danger-full-access` 切换本会话的
 * 权限预设（`dsh-permission-presets` 注册的 `permission` 命令；slash 前缀由
 * `dsh-commands` 的 `parseCommand` 识别）。
 *
 * 验证实例以 LocalSystem 托管，受限令牌执行器没有 logon SID
 * 起不来（归因证据 `acc017-sandbox-control.json`：内建 pwsh 报同一条
 * `windows-acl-run` 错）。测试套件测的是插件语义（让出/等待/打断/作业），不依赖沙箱
 * 模式，故跑在 danger-full-access 下；切完必须从转录断言模式真的变了。
 * @param {string} preset - 预设 id。
 * @returns {Promise<string>} sessionId。
 */
async function newSessionUnconfined(preset) {
  const sid = await newSession(preset);
  // ⚠️ `/permission` 必须走 `commands/execute` RPC（客户端同款通道）：slash 命令由
  // 客户端在提交前拦截执行、不经模型；塞进 session/prompt 只会变成一条普通用户
  // 消息（sandbox/mode 序列不动，命令零效果）。
  const executed = await rpc('commands/execute', {
    agentId: sid,
    line: '/permission danger-full-access',
    submittedAttachments: []
  });
  extra.permissionSwitch = extra.permissionSwitch ?? [];
  extra.permissionSwitch.push({ sid, result: executed });
  return sid;
}

/** 模型可见文本里的 CJK 判据（`\u3000-\u303f`、CJK 汉字、全角标点）。 */
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

const FOUR = ['async_run', 'async_wait_job', 'async_wait_agent', 'async_agent'];

/** 生效设置的出厂默认（T17 对账的十项；漂移了读数就不可比）。 */
const FACTORY = {
  defaultYieldMs: 20000, minYieldMs: 1000, maxYieldMs: 600000, defaultWaitMs: 30000,
  minWaitMs: 250, maxWaitMs: 600000, pollIntervalMs: 500, maxResultChars: 30000,
  jobKind: 'async-command', subagentProvider: 'spawn'
};

/** 只发一条不触发工具的提示：`request/header` 在请求发出时就已入账，不必等模型干活。 */
const ACK = 'Reply with exactly one line: ACK. Do not call any tool.';

// ── 相位：face（工具清单冒烟 / schema 零 CJK / 无同步 shell / 设置基线） ──────
async function phaseFace() {
  // 宿主行在线：设置命名空间存在 = 卡片有数据源（可读性判据）
  const described = await rpc('settings/describe', {});
  const nsNames = described.namespaces.map((n) => n.ns ?? n.namespace ?? n.id);
  record('前置 宿主行在线：settings/describe 含 async-tools-host',
    nsNames.includes('async-tools-host'), `命名空间数=${String(nsNames.length)}`);
  const ns = described.namespaces.find((n) => (n.ns ?? n.namespace ?? n.id) === 'async-tools-host');
  const liveValue = ns?.value ?? {};
  const drifted = Object.keys(FACTORY).filter((k) => liveValue[k] !== FACTORY[k]);
  record('前置 生效设置 = 出厂默认（否则"数字随设置变"的读数不可比）',
    drifted.length === 0, drifted.length === 0 ? '十项全等' : `偏离=${drifted.join(',')}`);

  const sid = await newSession('dsh-async');
  sessionIds.async = sid;
  await ask(sid, ACK);
  const face = faceOf(await page(sid));
  if (face === null) throw new Error('dsh-async 会话里没有 request/header——模型侧取不到，判据无法成立');
  faces.async = face.names;
  say(`dsh-async 工具清单（${String(face.names.length)} 个）：${face.names.join(', ')}`);
  record('冒烟：四个 async_* 都出现在模型实际收到的工具清单里',
    FOUR.every((n) => face.names.includes(n)),
    FOUR.map((n) => `${n}=${face.names.includes(n) ? 'Y' : 'N'}`).join(' '));
  record('需求 §3.1（Windows 面）无 bash', !face.names.includes('bash'), `bash=${face.names.includes('bash') ? 'Y' : 'N'}`);
  record('需求 §3.1（Windows 面）无 pwsh', !face.names.includes('pwsh'), `pwsh=${face.names.includes('pwsh') ? 'Y' : 'N'}`);
  // 同步 shell 的无条件禁用要看**两个口子都关**：工具不在清单里（上两条）且没有同步执行入口
  record('需求 §3.1 面里没有同步 shell 替代物（run_code 也不在）',
    !face.names.includes('run_code'), `run_code=${face.names.includes('run_code') ? 'Y' : 'N'}`);

  const fourSchemas = face.tools.filter((t) => FOUR.includes(String(t.name)));
  const cjkHits = [];
  for (const tool of fourSchemas) {
    const match = JSON.stringify(tool).match(CJK);
    if (match !== null) cjkHits.push(`${String(tool.name)}:${match[0]}`);
  }
  record('四个工具的 schema（描述+参数）零 CJK',
    cjkHits.length === 0, cjkHits.length === 0 ? `检查 ${String(fourSchemas.length)} 个 schema` : `命中 ${cjkHits.join(',')}`);
}

// ── 相位：control（对照预设；也是卸载后比对的基线） ─────────────────────────
async function phaseControl() {
  const ctl = await newSession('standard');
  sessionIds.control = ctl;
  await ask(ctl, ACK);
  const ctlFace = faceOf(await page(ctl));
  if (ctlFace === null) throw new Error('standard 会话里没有 request/header');
  faces.control = ctlFace.names;
  say(`standard 工具清单（${String(ctlFace.names.length)} 个）：${ctlFace.names.join(', ')}`);
  record('对照：standard 面不含任何 async_*（未泄漏到全局工具层）',
    !FOUR.some((n) => ctlFace.names.includes(n)),
    `async_* 命中=${String(FOUR.filter((n) => ctlFace.names.includes(n)).length)}`);
  record('对照：standard 面仍是标准形态（含 pwsh）',
    ctlFace.names.includes('pwsh'), `pwsh=${ctlFace.names.includes('pwsh') ? 'Y' : 'N'}`);
}

// ── 相位：behavior（行为链：短命令、让出、插话、等待、子代理） ───────────────
/** 各步要留档的读数（原始片段，便于第三方复核，不只看 PASS/FAIL）。 */
const extra = {};

/** A 段：短命令直返 / 长命令让出 / 句柄可复制 / 等待取回输出（需求 §2.2.1/§2.2.2）。 */
async function behaviorA() {
  const sid = await newSessionUnconfined('dsh-async');
  sessionIds.behaviorA = sid;
  await ask(sid, [
    'Follow these steps in order and do nothing else:',
    '1) async_run: `Write-Output SHORT_OK`',
    '2) async_run: `Start-Sleep -Seconds 6; Write-Output LONG_DONE` with yield_ms=1500',
    '3) take the job_id from step 2 and call async_wait_job with wait_ms=30000',
    '4) reply with exactly one line: ALL_DONE'
  ].join('\n'));
  const transcript = await page(sid);
  const modes = sandboxModes(transcript);
  record('运行形态：测试套件会话已切 danger-full-access（LocalSystem 无 logon SID，单次提权按需求 §6.1 走 danger-full-access；归因见 sandbox-control 相位）',
    modes.includes('danger-full-access'), `sandbox/mode 事件序列=${modes.join(' → ') || '(无)'}`);
  const { calls, results } = parseEvents(transcript);
  const runCalls = calls.filter((c) => c.name === 'async_run').length;
  const waitCalls = calls.filter((c) => c.name === 'async_wait_job').length;
  record('短命令直接返回（结果里有 SHORT_OK）',
    results.some((t) => t.includes('SHORT_OK')), `async_run 调用 ${String(runCalls)} 次`);
  record('长命令让出而非被杀（note 说明超出首次等待且未被终止）',
    results.some((t) => /it outlived the \d+ ms first wait/.test(t) && /It was NOT terminated/.test(t)),
    `命中首次等待文案=${String(results.filter((t) => /outlived the \d+ ms first wait/.test(t)).length)} 条`);
  record('让出返回给出可复制的 async_wait_job 调用（带作业编号）与生效数字',
    results.some((t) => /async_wait_job\(job_id="[^"]+", wait_ms=\d+\)/.test(t)),
    `async_wait_job 调用 ${String(waitCalls)} 次`);
  record('等待把长命令的输出取回（结果里有 LONG_DONE）',
    results.some((t) => t.includes('LONG_DONE')));
  extra.behaviorA = {
    calls: calls.map((c) => c.name),
    yieldNotes: results.filter((t) => /outlived the \d+ ms first wait/.test(t)).map((t) => t.slice(0, 400))
  };
}

/** B 段：插话打断等待、后台作业不受影响、job_list 显示 running（需求 §2.1.2）。 */
async function behaviorB() {
  const sid = await newSessionUnconfined('dsh-async');
  sessionIds.behaviorB = sid;
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: sid,
      mode: 'queue',
      content: [{
        type: 'text',
        text: 'Use async_run to run `Start-Sleep -Seconds 60; Write-Output SURVIVED` with yield_ms=1500; '
          + 'as soon as you get the job_id, call async_wait_job on it with wait_ms=120000 and do nothing else.'
      }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
  // 等到出现一次 async_wait_job 调用（说明它已经进入长等待），再发插话。
  let waiting = false;
  for (let i = 0; i < 90 && !waiting; i++) {
    await sleep(1000);
    const { calls } = parseEvents(await page(sid));
    waiting = calls.some((c) => c.name === 'async_wait_job');
  }
  record('情形搭建成功（模型已进入 async_wait_job 长等待）', waiting);
  if (waiting) {
    await steer(sid, 'By the way: nice weather. Use job_list to check that job\'s current status and reply with its status only.');
  }
  await ask(sid, 'Continue: fetch that job\'s output with async_wait_job (wait_ms=90000), then reply with the single line it printed.');
  const transcriptB = await page(sid);
  const modesB = sandboxModes(transcriptB);
  record('运行形态：B 段会话同样运行在 danger-full-access 下',
    modesB.includes('danger-full-access'), `sandbox/mode 事件序列=${modesB.join(' → ') || '(无)'}`);
  const { results } = parseEvents(transcriptB);
  record('插话打断等待，且 note 说明作业完全未受影响',
    results.some((t) => /Wait interrupted: a user message has arrived/.test(t) && /completely unaffected/.test(t)),
    `命中打断文案=${String(results.filter((t) => /Wait interrupted:/.test(t)).length)} 条`);
  record('job_list 显示作业仍在 running（插话没有取消作业）',
    results.some((t) => /async-command-\d+/.test(t) && /running/.test(t)));
  record('60 秒作业最终仍输出完整结果（SURVIVED）',
    results.some((t) => t.includes('SURVIVED')));
  extra.behaviorB = {
    interruptedNotes: results.filter((t) => /Wait interrupted:/.test(t)).map((t) => t.slice(0, 300)),
    jobList: results.filter((t) => /async-command-\d+/.test(t)).map((t) => t.slice(0, 300))
  };
}

/** C 段：async_agent 派生 + async_wait_agent 有界等待（需求 §2.3）。 */
async function behaviorC() {
  const sid = await newSession('dsh-async');
  sessionIds.behaviorC = sid;
  await ask(sid, [
    'Follow these steps in order and do nothing else:',
    '1) async_agent with prompt: `Reply with exactly one line: PONG`',
    '2) take the agent_id it returns and call async_wait_agent with wait_ms=60000',
    '3) reply with exactly one line: AGENT_DONE'
  ].join('\n'), 300000);
  const { calls, results } = parseEvents(await page(sid));
  record('async_agent 立即返回 agent_id 与可复制的等待调用',
    results.some((t) => /async_wait_agent\(agent_id="[^"]+", wait_ms=\d+\)/.test(t)),
    `async_agent 调用 ${String(calls.filter((c) => c.name === 'async_agent').length)} 次`);
  record('async_wait_agent 结算文案说明最终回答不在返回值里',
    results.some((t) => /is no longer observed running/.test(t)),
    `async_wait_agent 调用 ${String(calls.filter((c) => c.name === 'async_wait_agent').length)} 次`);
  extra.behaviorC = { calls: calls.map((c) => c.name), results: results.map((t) => t.slice(0, 300)) };
}

async function phaseBehavior() {
  await behaviorA();
  say('');
  await behaviorB();
  say('');
  await behaviorC();
}

// ── 相位：agent（指定模型真机判据；需求 §2.3.2 模型选择策略、设计 §3.3） ──────
/**
 * 从子会话转录里抽 assistant 消息的模型来源（`data.source` 或 `data.message.source`）。
 * @param {object} pageResult - `session/page` 的返回。
 * @returns {string[]} `provider/model` 序列。
 */
function childModelsOf(pageResult) {
  const models = [];
  for (const record of pageResult.records ?? []) {
    const event = record.event;
    if (event?.type !== 'assistant/message') continue;
    const source = event.data?.source ?? event.data?.message?.source;
    if (typeof source?.provider === 'string') {
      models.push(`${source.provider}/${String(source.model ?? '?')}`);
    }
  }
  return models;
}

async function phaseAgent() {
  // 主腿（白名单开）三判据 + 白名单关对照腿 + 收尾恢复。白名单关对照腿是
  // 宿主管控口径（无 policy 会话不暴露模型参数，设计 §3.3）的活体证据。
  const SEL_NS = 'subagent-model-selection-settings';
  const selBefore = await readNsOf(SEL_NS);
  say(`模型选择白名单改前：enabled=${String(selBefore.value.enabled)} allowedModels=${JSON.stringify(selBefore.value.allowedModels ?? [])}`);
  try {
    // 指定路由只在"会话有模型选择策略"时可用（需求 §2.3.2）；验证实例出厂 enabled=false，
    // 先开白名单（含 zai/glm-5.3——用户 2026-09-25 指定的子代理路由）。
    await rpc('settings/update', {
      ns: SEL_NS,
      patch: { enabled: true, allowedModels: [{ provider: 'zai', model: 'glm-5.3' }] }
    });
    const policy = await rpc('settings/describe', {});
    const nsNames = policy.namespaces.map((n) => n.ns ?? n.namespace ?? n.id);
    record('前置 会话模型白名单设置区存在（subagent-model-selection-settings）',
      nsNames.includes(SEL_NS), `命名空间数=${String(nsNames.length)}`);

    // ── 主腿：白名单开——会话被采样、策略在位，指定路由预期被接受 ──
    const sid = await newSession('dsh-async');
    sessionIds.agent = sid;
    await ask(sid, [
      'Follow these steps in order and do nothing else:',
      '1) async_agent with prompt: `Reply with exactly one line: ROUTED` and provider `zai`, model `glm-5.3`',
      '2) reply with exactly one line: ROUTE_DONE'
    ].join('\n'), 300000);
    const transcript = await page(sid);
    const { results } = parseEvents(transcript);
    // 判据本体在 `verify/agent-judgements.mjs` 的纯函数里（取数在这里，判据在那里）。
    const routing = judgeAgentRouting(results, 'zai', 'glm-5.3');
    record('指定路由的 async_agent 调用被接受（note 锚 requested 标记）',
      routing.ok, routing.detail);

    // 会话转录含策略持久事件——采样落档的直接证据（设计 §3.3：
    // fresh 顶层 + 白名单开 ⇒ agent/created 采样追加 subagent/model-selection-policy）。
    const policyEvents = (transcript.records ?? [])
      .filter((r) => r.event?.type === 'subagent/model-selection-policy');
    const policyRoutes = policyEvents.length > 0
      ? (policyEvents[policyEvents.length - 1].event.data?.allowedModels ?? [])
      : [];
    record('会话转录含 subagent/model-selection-policy 持久事件（模型策略采样的直接证据）',
      policyEvents.length > 0
        && policyRoutes.some((route) => route?.provider === 'zai' && route?.model === 'glm-5.3'),
      `事件数=${String(policyEvents.length)} 路由=${JSON.stringify(policyRoutes)}`);

    // 真机判据的强形态：不满足于工具 note 的自述——从 subagent/catalog 事件拿
    // childId，翻**子会话**转录，断言子代理的 assistant 消息真的产生自 zai/glm-5.3。
    const catalog = (transcript.records ?? [])
      .filter((r) => r.event?.type === 'subagent/catalog')
      .map((r) => r.event.data);
    const childId = catalog.length > 0 ? catalog[catalog.length - 1].childId : undefined;
    const childMode = catalog.length > 0 ? catalog[catalog.length - 1].mode : undefined;
    if (childId === undefined) {
      record('子会话转录显示子代理真的跑在 zai/glm-5.3 上', false, 'transcript 里没有 subagent/catalog 事件，拿不到 childId');
    } else {
      // 子会话 id 是**裸 UUID**（不带 `session-` 前缀），且必须用 subagent 寻址（见 `pageChild`）。
      const childSessionId = String(childId);
      sessionIds.agentChild = childSessionId;
      const childPage = await pageChild(sid, childSessionId, typeof childMode === 'string' ? childMode : 'unknown', 100);
      const models = childModelsOf(childPage);
      // 权威记录是子会话自己的 `subagent/descriptor`（`agentProvider`/`agentModel`）；
      // assistant 消息的 `source` 作为第二证据。
      const descriptor = (childPage.records ?? [])
        .map((r) => r.event)
        .find((e) => e?.type === 'subagent/descriptor');
      const routed = `${String(descriptor?.data?.agentProvider ?? '?')}/${String(descriptor?.data?.agentModel ?? '?')}`;
      record('子会话转录显示子代理真的跑在 zai/glm-5.3 上',
        descriptor?.data?.agentProvider === 'zai' && descriptor?.data?.agentModel === 'glm-5.3',
        `descriptor 路由=${routed}；assistant 模型序列=${models.join(', ') || '(无 assistant 消息)'}`);
      extra.agentChild = { childId, childMode, routed, models };
    }
    extra.agent = { results: results.map((t) => t.slice(0, 500)) };

    // ── 对照腿：白名单关（enabled=false）——新会话无策略，指定路由得可读拒绝 ──
    // 白名单关 ⇒ 采样不落事件 ⇒ 投影无值 ⇒ lib/agent.js 保守拒绝
    // （error.noPolicy 文案锚在 lib/text.js）。
    await rpc('settings/update', { ns: SEL_NS, patch: { enabled: false } });
    const sidOff = await newSession('dsh-async');
    sessionIds.agentOff = sidOff;
    await ask(sidOff, [
      'Follow these steps in order and do nothing else:',
      '1) async_agent with prompt: `Reply with exactly one line: OFF_ATTEMPTED` and provider `zai`, model `glm-5.3`',
      '2) reply with exactly one line: OFF_DONE'
    ].join('\n'), 300000);
    const transcriptOff = await page(sidOff);
    const routingOff = judgeAgentRouting(parseEvents(transcriptOff).results, 'zai', 'glm-5.3');
    record('白名单关时新会话的指定路由调用得到可读拒绝（error.noPolicy 锚）',
      routingOff.sawNoPolicy && !routingOff.sawRequested, routingOff.detail);
    extra.agentOff = { results: routingOff.count };
  } finally {
    // 恢复原值（共享验证实例不留脏状态）；恢复本身回读比对。
    await rpc('settings/update', { ns: SEL_NS, patch: selBefore.value });
    const selAfter = await readNsOf(SEL_NS);
    record('收尾恢复模型选择白名单原值（回读比对）',
      selAfter.value.enabled === selBefore.value.enabled
        && JSON.stringify(selAfter.value.allowedModels ?? []) === JSON.stringify(selBefore.value.allowedModels ?? []),
      `enabled=${String(selAfter.value.enabled)} allowedModels=${JSON.stringify(selAfter.value.allowedModels ?? [])}`);
  }
}

// ── 日志字节游标（只读新增段，绝不全文件 grep） ──────────────────────────────
/** 记下当前日志末尾字节位置，作为"从现在起的新增段"起点。 */
function logMark() {
  return statSync(LOG_PATH).size;
}

/**
 * 读 `from` 之后的新增字节。
 * @param {number} from - 起点字节位置。
 * @returns {string} 新增段文本（日志被轮转/截断时返回空串）。
 */
function logSince(from) {
  const size = statSync(LOG_PATH).size;
  if (size <= from) return '';
  const fd = openSync(LOG_PATH, 'r');
  try {
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// ── 相位：settings（活的设置链） ─────────────────────────────────────────────
/** 读某个命名空间的现行值。 */
async function readNsOf(ns) {
  const described = await rpc('settings/describe', {});
  const found = described.namespaces.find((n) => (n.ns ?? n.namespace ?? n.id) === ns);
  if (found === undefined) throw new Error(`${ns} 命名空间不在 describe 里（宿主行没激活？）`);
  return { value: found.value ?? {}, revision: found.revision ?? null };
}

/** 读 async-tools-host 的现行值。 */
async function readNs() {
  return readNsOf('async-tools-host');
}

async function phaseSettings() {
  const before = await readNs();
  say(`改前：defaultYieldMs=${String(before.value.defaultYieldMs)} maxWaitMs=${String(before.value.maxWaitMs)} revision=${String(before.revision)}`);

  const mark = logMark();
  const patch = { defaultYieldMs: 12000, maxWaitMs: 480000 };
  try {
    await rpc('settings/update', { ns: 'async-tools-host', patch });
    const after = await readNs();
    // 保存成功不靠异常判定（mutate 失败不抛错）——回读快照比对。
    record('保存后回读 = 新值（不靠 try/catch 判成败）',
      after.value.defaultYieldMs === 12000 && after.value.maxWaitMs === 480000,
      `defaultYieldMs=${String(after.value.defaultYieldMs)} maxWaitMs=${String(after.value.maxWaitMs)}`);

    const sid = await newSession('dsh-async');
    sessionIds.settings = sid;
    await ask(sid, ACK);
    const face = faceOf(await page(sid));
    if (face === null) throw new Error('设置相位：会话里没有 request/header');
    const runDesc = String(face.tools.find((t) => t.name === 'async_run')?.description ?? '');
    const waitDesc = String(face.tools.find((t) => t.name === 'async_wait_job')?.description ?? '');
    record('async_run 描述里的首次等待数字跟着设置变（12000）',
      runDesc.includes('The first wait defaults to 12000 ms'), `片段=${runDesc.match(/The first wait defaults to \d+ ms[^;]*/)?.[0] ?? '(未命中)'}`);
    record('async_wait_job 描述里的等待上限跟着设置变（480000）',
      waitDesc.includes('250–480000 ms'), `片段=${waitDesc.match(/Per-call wait budgets must be passed explicitly[^;]*/)?.[0] ?? '(未命中)'}`);

    const delta = logSince(mark);
    const reloadHits = delta.split('\n').filter((l) => l.includes('async-tools-host'));
    record('volatile 提交的新增日志段里没有 async-tools-host 装载行',
      reloadHits.length === 0, `新增字节=${String(delta.length)}，含 async-tools-host 的行=${String(reloadHits.length)}`);
    const deltaPath = `${LOG_DIR}acc017-settings-logdelta.txt`;
    writeFileSync(deltaPath, delta, 'utf8');
    extra.settings = {
      before: before.value, patch, after: after.value, revisionBefore: before.revision, revisionAfter: after.revision,
      runDesc: runDesc.slice(0, 400), waitDesc: waitDesc.slice(0, 400),
      logDeltaBytes: delta.length, logDeltaFile: deltaPath, logDeltaTail: delta.slice(-2000)
  };
    say(`新增日志段 ${String(delta.length)} 字节（已落 ${deltaPath}）`);
  } finally {
    // 恢复出厂值：验证实例是共享资源，不留脏状态；恢复本身也要回读比对。
    await rpc('settings/update', { ns: 'async-tools-host', patch: { defaultYieldMs: 20000, maxWaitMs: 600000 } });
    const restored = await readNs();
    record('收尾恢复出厂值（回读比对，不留脏状态）',
      restored.value.defaultYieldMs === 20000 && restored.value.maxWaitMs === 600000,
      `defaultYieldMs=${String(restored.value.defaultYieldMs)} maxWaitMs=${String(restored.value.maxWaitMs)}`);
  }
}

// ── 相位：reload-control（对照变异：非 volatile 变更必现装载行） ──────────────
/** 宿主行的组合层配置入口（config 是改出厂值的正式入口，需重启生效）。 */
const PATCH_FILE = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url));

async function phaseReloadControl() {
  const original = readFileSync(PATCH_FILE, 'utf8');
  const marker = '      name: dsh-async-tools\n';
  if (!original.includes(marker)) throw new Error('cordis.patch.yml 里的宿主行锚点没找到');
  const mutated = original.replace(marker, `${marker}      config:\n        pollIntervalMs: 700\n`);
  const mark = logMark();
  const before = await readNs();
  try {
    writeFileSync(PATCH_FILE, mutated, 'utf8');
    for (const waitMs of [4000, 6000, 8000]) {
      await sleep(waitMs);
      const delta = logSince(mark);
      const hits = delta.split('\n').filter((l) => l.includes('async-tools-host') || l.includes('ordinary config values'));
      say(`  +${String(waitMs)} ms 后新增 ${String(delta.length)} 字节，命中装载行 ${String(hits.length)} 条`);
      for (const h of hits.slice(0, 5)) say(`    > ${h.slice(0, 200)}`);
    }
  } finally {
    writeFileSync(PATCH_FILE, original, 'utf8');
  }
  const delta = logSince(mark);
  const after = await readNs();
  const hits = delta.split('\n').filter((l) => l.includes('async-tools-host') || l.includes('ordinary config values'));
  const deltaPath = `${LOG_DIR}acc017-reload-control-logdelta.txt`;
  writeFileSync(deltaPath, delta, 'utf8');
  extra.reloadControl = {
    mutated: 'cordis.patch.yml 宿主行加 config.pollIntervalMs=700（非 volatile 侧的组合层改动）',
    logDeltaBytes: delta.length, logDeltaFile: deltaPath, loadLineHits: hits.slice(0, 10),
    revisionBefore: before.revision, revisionAfter: after.revision
  };
  record('对照方向可判：非 volatile 变更是否真能产生"装载行"（结论写进证据，不预设）',
    true, `命中装载行 ${String(hits.length)} 条（新增 ${String(delta.length)} 字节，详见 ${deltaPath}）`);
}

// ── 相位：dump（看某个会话的原始工具调用与结果，用于诊断红项） ──────────────
async function phaseDump() {
  const sessionId = process.argv[3];
  if (sessionId === undefined) throw new Error('usage: acceptance-017.mjs dump <sessionId>');
  const pageResult = await page(sessionId, 400);
  const types = {};
  for (const record of pageResult.records ?? []) types[record.event?.type] = (types[record.event?.type] ?? 0) + 1;
  say(`事件类型：${JSON.stringify(types)}`);
  for (const record of pageResult.records ?? []) {
    const event = record.event;
    if (event?.type === 'tool/call') {
      say(`CALL ${String(event.data.name)} ${String(event.data.arguments).slice(0, 300)}`);
    } else if (event?.type === 'tool/result') {
      // 与 parseEvents 同口径：转录形状（content 直挂 text 块）与 GUI 投影形状都认。
      for (const block of (event.data.message?.content ?? [])) {
        if (block.type === 'tool-result') {
          const text = (block.content ?? []).map((p) => p.text ?? '').join('');
          say(`RESULT${block.isError === true ? ' (error)' : ''}: ${text.slice(0, 800).replace(/\n/g, ' ⏎ ')}`);
        } else if (block.type === 'text') {
          say(`RESULT${event.data.isError === true ? ' (error)' : ''}: ${String(block.text ?? '').slice(0, 800).replace(/\n/g, ' ⏎ ')}`);
        }
      }
    } else if (event?.type === 'subagent/catalog') {
      say(`SUBAGENT-CATALOG: ${JSON.stringify(event.data).slice(0, 600)}`);
    } else if (event?.type === 'sandbox/mode') {
      say(`SANDBOX-MODE: ${JSON.stringify(event.data)}`);
    } else if (event?.type === 'assistant/message') {
      const text = (event.data.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      if (text.trim() !== '') say(`ASSISTANT: ${text.slice(0, 400).replace(/\n/g, ' ⏎ ')}`);
    }
  }
  extra.dump = { sessionId, types };
}

// ── 相位：sandbox-control（归因：同样的命令走内置工具会不会同样失败） ─────────
/**
 * 用一个装了内置 `pwsh` 工具的预设（standard）跑同一条命令。
 *
 * 判据的用处是**归因**：`async_run` 在验证实例上报
 * `windows-acl-run: CreateRestrictedToken prerequisite failed`（exit 127）——
 * 若内置 `pwsh` 报同一条错，则失败发生在**沙箱执行器**里、与本插件无关
 * （实例以 LocalSystem 服务账户托管）。
 */
async function phaseSandboxControl() {
  const sid = await newSession('standard');
  sessionIds.sandboxControl = sid;
  // 禁止升级重试：携 sandbox_permissions 的重试会触发 approval/asked，而 RPC 建的会话
  // 没有应答者，回合会永久悬死——让模型报完原始错误就停，回合才能收敛。
  await ask(sid, 'Use the pwsh tool to run exactly `Write-Output SANDBOX_OK`. If it fails, do NOT retry and do NOT escalate (never pass sandbox_permissions or justification) — just reply with the raw error text and stop.', 180000);
  const { results } = parseEvents(await page(sid));
  const text = results.join('\n');
  say(`结果条数=${String(results.length)}`);
  for (const r of results) say(`  > ${r.slice(0, 300).replace(/\n/g, ' ⏎ ')}`);
  record('归因对照：内置 pwsh 工具在同一实例上**也**失败于沙箱启动器（同一个错就证明与本插件无关）',
    /CreateRestrictedToken|windows-acl-run/.test(text),
    /CreateRestrictedToken/.test(text) ? '内置工具报同一条沙箱启动器错误' : '内置工具没有报同一条错（需重新归因）');
  extra.sandboxControl = { results: results.map((r) => r.slice(0, 600)) };
}

// ── 相位：sibling-coexist（第三方插件在 0.2.0-rc.2 + 最小链接集下共存） ───────────
/** 验证实例的 profile 目录（与 BASE/LOG_PATH 同源，经配置加载器取 instanceHome 派生）。 */
const PROFILE_DIR = join(localConfig.instanceHome, 'profiles', 'web');

async function phaseSiblingCoexist() {
  // 这一相判的是"本包与**另一个第三方插件**在同一次部署里共存"。那个兄弟包是
  // **部署事实**（配置的 `siblingBundles`），外部读者那里通常只有一个包——
  // 那时本相整体**文档化跳过**，而不是把缺席读成通过（假绿比不测更糟）。
  const sibling = localConfig.siblingBundles[0];
  if (sibling === undefined) {
    console.log('SKIP 第三方插件共存相位：配置里没有登记兄弟包（siblingBundles 为空）。');
    console.log('     这一相判的是"两个第三方插件共存"，只有本包时无可判，按缺席跳过（不是通过）。');
    return;
  }
  // profile 里的行 id / 日志前缀惯例是包名去掉 `dsh-` 前缀（`dsh-x` ↔ `x`），两种写法都认。
  const aliases = [...new Set([sibling, sibling.replace(/^dsh-/, '')])];
  const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ① 挂载三处一致：bundles 名单、patch 行、node_modules 实体（junction）。
  const pkg = JSON.parse(readFileSync(`${PROFILE_DIR}/package.json`, 'utf8'));
  const bundles = pkg?.dsh?.profile?.bundles ?? [];
  record(`profile bundles 含本包与登记的兄弟包（${sibling}）`,
    bundles.includes('dsh-async-tools') && bundles.includes(sibling),
    `bundles=${bundles.join(', ')}`);
  const patch = readFileSync(`${PROFILE_DIR}/cordis.patch.yml`, 'utf8');
  record(`profile patch 里有兄弟包的行（${aliases.join(' / ')}）`,
    aliases.some((alias) => new RegExp(`id:\\s*${escapeRe(alias)}`).test(patch)),
    `patch 大小=${String(patch.length)}B`);
  const nodeModules = readdirSync(`${PROFILE_DIR}/node_modules`, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  record('node_modules 里本包与兄弟包的 junction 都在（最小链接集）',
    nodeModules.includes('dsh-async-tools') && nodeModules.includes(sibling),
    `目录项=${nodeModules.join(', ')}`);
  // ② 不兼容行为零：负向断言，全文件 grep 是保守方向（旧崩溃只会增加命中数）。
  const log = readFileSync(LOG_PATH, 'utf8');
  const incompatible = (log.match(/is incompatible with dsh/g) ?? []).length;
  record('错误日志里 "is incompatible with dsh" 为零',
    incompatible === 0, `命中=${String(incompatible)} 次（全文 ${String(log.length)}B）`);
  // ③ 两个第三方插件的活证据：本包宿主行命名空间在线，兄弟包有运行期决策日志行。
  const described = await rpc('settings/describe', {});
  const nsNames = described.namespaces.map((n) => n.ns ?? n.namespace ?? n.id);
  record('async-tools-host 命名空间在线（dsh-async-tools 宿主行激活）',
    nsNames.includes('async-tools-host'), `命名空间数=${String(nsNames.length)}`);
  const afmLines = aliases
    .map((alias) => (log.match(new RegExp(`^\\[${escapeRe(alias)}\\]`, 'gm')) ?? []).length)
    .reduce((a, b) => Math.max(a, b), 0);
  record(`兄弟包（${sibling}）有运行期决策日志（插件在工作，不是只挂载）`,
    afmLines > 0, `兄弟包日志行数=${String(afmLines)}`);
  extra.siblingCoexist = { bundles, nodeModules, incompatible, nsCount: nsNames.length, afmLines, sibling };
}

// ── 相位：r24-ui（客户端半边真的到达浏览器的判据） ───────────────────────────
/**
 * 界面侧判据之一：**注入表内容**（判据必须是注入表或页面 DOM，
 * 不是后端 API 的返回）。
 *
 * 两段：① 首页 HTML 的注入表必须把本包的 `client.js` 列进 preload combo 行
 * （那是 `webserver/index-inject` 的产物，不是任何接口的自述）；② 把该 combo 行
 * 原样取回来的**下发字节**里必须是本包的现行实现——含 `AsyncToolsBundleCard` 与
 * `plugins.bundle.config`、不含组件行槽 `plugins.row.config` 与官方槽 `plugins.item`。
 * 第②段的两个字符串断言方向相反，所以这条判据能变红。
 */
async function phaseR24Ui() {
  const home = await fetch(`${BASE}/`, { headers: { cookie } });
  const html = await home.text();
  const combo = /href="(plugins\/\?\?[^"]*dsh-async-tools\/client\.js[^"]*)"/.exec(html);
  record('注入表把本包 client.js 列进 preload 行（取页面 HTML，不看后端返回）',
    home.status === 200 && combo !== null,
    `首页状态=${String(home.status)} 长度=${String(html.length)}`);
  if (combo === null) return;
  const url = `${BASE}/${combo[1].replaceAll('&amp;', '&')}`;
  const response = await fetch(url, { headers: { cookie } });
  const text = await response.text();
  // 判据本体在 `verify/r24-judgements.mjs` 的纯函数里——取数在这里，判据在那里，
  // 后者可被 `verify/mutate-r24-ui.mjs` 用变异证明能红。
  const verdict = judgeDeliveredBytes(response.status, text);
  record('下发字节符合现行实现（bundle 槽在、行槽与禁用槽名都不在）', verdict.ok, verdict.detail);
  extra.r24ui = { combo: combo[1].slice(0, 200), bytes: text.length };
}

// ── 主流程：无论成败都落证据 ────────────────────────────────────────────────
const startedAt = new Date().toISOString();
let phaseError = null;
say(`== 阶段二 · ${phase}（${startedAt}；实例 ${BASE}） ==`);
try {
  await connect();
  if (phase === 'face') await phaseFace();
  else if (phase === 'control') await phaseControl();
  else if (phase === 'behavior') await phaseBehavior();
  else if (phase === 'agent') await phaseAgent();
  else if (phase === 'settings') await phaseSettings();
  else if (phase === 'reload-control') await phaseReloadControl();
  else if (phase === 'dump') await phaseDump();
  else if (phase === 'sibling-coexist') await phaseSiblingCoexist();
  else if (phase === 'sandbox-control') await phaseSandboxControl();
  else if (phase === 'r24-ui') await phaseR24Ui();
  else throw new Error(`unknown phase: ${phase}`);
} catch (error) {
  phaseError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  say(`PHASE-ERROR  ${phaseError}`);
}
const failed = checks.filter((c) => !c.passed);
say('');
say(`总判定：${String(checks.length - failed.length)}/${String(checks.length)} 通过${phaseError === null ? '' : '（相位中断，判据不完整）'}`);
for (const f of failed) say(`未通过：${f.name}`);
mkdirSync(LOG_DIR, { recursive: true });
writeFileSync(`${LOG_DIR}acc017-${phase}.json`, JSON.stringify({
  phase, at: startedAt, base: BASE, sessionIds, faces, extra, phaseError, checks
}, null, 2), 'utf8');
writeFileSync(`${LOG_DIR}acc017-${phase}.log`, `${lines.join('\n')}\n`, 'utf8');
process.exit(failed.length === 0 && phaseError === null ? 0 : 1);
