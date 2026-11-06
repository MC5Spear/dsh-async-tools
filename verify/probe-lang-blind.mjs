/**
 * lang 盲测采集装置（为「lang 盲测代理」采集原始材料；权威需求 docs/requirements.md §5.3）。
 *
 * ## 装置定位（装置边界）
 *
 * 本装置**只记 CAP/GAP（采到／缺口），绝不产出产品合格判定**——材料是否满足
 * §5.3（agentLang 行为：宿主原封不动的提示原文可保留宿主语言；本包新增或改写的
 * 指令，包括结果收集句，随 agentLang 切换；混合来源逐段区分）由盲测代理判定。
 * 装置不改插件与宿主行为；唯一的状态改写是 `agentLang` 设置项，收尾恢复原值。
 *
 * ## 采集计划（按盲测代理委托书；V1-V5 载具定义未随任务提供——见 GAP 登记）
 *
 * - NI-1/2/3＝非交互投递（async_run 转后台后模型结束回合、作业结算时完成消息
 *   到达），作业时长 D 分别 45/60/75 秒；NI-1 在出厂 en 档、NI-2/3 在 zh 档。
 * - LP-A/B/C＝静默投递路径各形态：A＝忙碌窗内（同回合 essay ≥900 词构造）、
 *   B＝快速空闲（投递后宿主开回合）、C＝滞留观察（结算后 ≥90s 完成消息记录
 *   未出现且非 running → 中性 queue 唤醒，单尝试）。形态按转录 splice 组与记录
 *   实测登记（装置不强行制造形态）。
 * - LP-D＝复用 NI-3 会话再投一条（同会话第二轮投递）。
 * - settings 痕迹＝agentLang 改前／改后／恢复的 settings/describe 读值留痕。
 * - splice-group 读数＝各关键时点转录分组原文（splice 事件与消息记录原样落盘，
 *   不做有利筛选；试次窗口整段记录原样附卷）。
 * - 断言域排除「Run this single step:」装置指令（token 计数仅统计宿主侧载体）。
 * - 模型一次不合规可重试一次，重试留痕（attempts）；LP-C 条件步单尝试。
 * - M 系列＝装置自定义补充（计划书缺位）：en／zh 两档新会话各一次固定格式
 *   问答，问模型自报的常驻指令语言特征（不逐字引用、不含锚句原文，防泄漏
 *   与复述污染）。
 *
 * 载具编号（装置自定义映射，判定权在盲测代理）：
 *   V1＝request/header 中 async_run 的 description（模型收到的工具描述）
 *   V2＝async_run 转后台返回文本（tool/result 正文）
 *   V3＝完成消息正文（sourceKind=async-tools-job-result 的 user/message）
 *   V4＝async_wait 返回文本（试次中在场时）
 *   V5＝settings/describe 的 agentLang 生效值／用户覆盖层时点快照
 *
 * ## 用法
 *
 *   node verify/probe-lang-blind.mjs --service-root <宿主服务根> \
 *     --host-subdir <宿主树目录名，如 dsh-0.2.1-rc.5> [--repo <本仓路径>] [--keep]
 *
 * 证据落盘 .local/evidence/lang-blind/（manifest.json＋分节 JSON）。退出码：
 * 0＝装置跑完采集序列（CAP/GAP 均为合法产出）；2＝装置自身故障（FAULT）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const NS = 'async-tools-host';
const PRESET = 'dsh-async';
const POLL_MS = 2000;
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const keep = args.includes('--keep');
const repo = resolve(argOf('repo') ?? process.cwd());
const EVID_DIR = join(repo, '.local', 'evidence', 'lang-blind');
let home = null;
let restoredFlag = false;
// 证据容器前置声明：FAULT 路径尽力落盘部分证据。
const evidence = {
  meta: { startedAt: null, finishedAt: null, head: null, dirty: null, hostVersion: null, repo, serviceRoot: null, hostSubdir: null, instanceUrl: null },
  settingsTrace: null,
  niTrials: [],
  lpTrials: [],
  mProbes: [],
  capGap: [],
  gaps: [],
  deviations: []
};
const fail = (msg) => {
  console.error(`[probe] FAULT: ${msg}\n[probe] 临时目录：${home ?? '（尚未创建）'}${keep ? '（--keep 保留）' : '（装置故障路径，请手动清理）'}`);
  try {
    evidence.meta.finishedAt = new Date().toISOString();
    evidence.fault = String(msg);
    mkdirSync(EVID_DIR, { recursive: true });
    dumpAll();
    console.error('[probe] 已尽力落盘部分证据');
  } catch { /* 故障路径的落盘失败不再掩盖原故障 */ }
  process.exit(2);
};
process.on('uncaughtException', (error) => { fail(`未捕获异常：${String(error?.stack ?? error)}`); });
process.on('unhandledRejection', (reason) => { fail(`未处理的 Promise 拒绝：${String(reason)}`); });
const serviceRootArg = argOf('service-root') ?? process.env.DSAT_SERVICE_ROOT;
if (serviceRootArg === undefined || serviceRootArg.trim() === '') fail('缺少 --service-root（或环境变量 DSAT_SERVICE_ROOT）');
const serviceRoot = resolve(serviceRootArg);
const hostSubdir = argOf('host-subdir') ?? 'dsh-0.2.1-rc.5';
const hostRoot = join(serviceRoot, hostSubdir);
let hostVersion;
try {
  hostVersion = JSON.parse(readFileSync(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
} catch (error) {
  fail(`无法读取宿主树版本：${String(error?.message ?? error)}`);
}
const log = (msg) => console.log(`[probe] ${msg}`);
evidence.meta.startedAt = new Date().toISOString();
evidence.meta.serviceRoot = serviceRoot;
evidence.meta.hostSubdir = hostSubdir;
evidence.meta.hostVersion = hostVersion;

// 1) 打包当前工作区（npm pack --ignore-scripts；产物名含「+」，产物落 .local/）。
mkdirSync(join(repo, '.local'), { recursive: true });
const headRun = spawnSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
const head = headRun.status === 0 ? headRun.stdout.trim() : 'unknown-head';
const dirtyRun = spawnSync('git', ['-C', repo, 'status', '--short'], { encoding: 'utf8' });
const dirty = dirtyRun.status === 0 && dirtyRun.stdout.trim() !== '' ? '（含未提交改动）' : '';
evidence.meta.head = head;
evidence.meta.dirty = dirty !== '';
log(`repo=${repo} head=${head}${dirty} hostRoot=${hostRoot} hostVersion=${hostVersion}`);
const packRun = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', '.local'], { cwd: repo, encoding: 'utf8', shell: true });
if (packRun.status !== 0) fail(`npm pack 退出 ${String(packRun.status)}：${packRun.stderr}`);
const tgzName = (packRun.stdout.match(/dsh-async-tools-[^\s]+\.tgz/g) ?? []).pop();
if (tgzName === undefined) fail('npm pack 未产出 dsh-async-tools tgz');
const tgzPath = join(repo, '.local', tgzName);
log(`tgz=${tgzName}`);

// 2) 独立 DSH_HOME（系统临时目录）＋ 官方 CLI 安装（正式装载路径）。
home = mkdtempSync(join(tmpdir(), 'dsh-lang-blind-'));
const cliBin = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const addRun = spawnSync('node', [cliBin, 'plugin', '--profile', 'web', 'add', tgzPath], {
  cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 300_000
});
if (addRun.status !== 0) fail(`plugin add 退出 ${String(addRun.status)}：stderr 尾部 ${String(addRun.stderr).slice(-600)}`);
log('plugin add 完成');

// 3) 起隔离实例（随机端口，仅 127.0.0.1）。
const child = spawn('node', [cliBin, '--patch', join(serviceRoot, 'patches', 'zai-glm.yml'), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  cwd: serviceRoot,
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe']
});
let stdout = '';
child.stdout.on('data', (c) => { stdout += c; });
let stderrTail = '';
child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-4000); });
process.on('exit', () => { killChild(); });
const url = await new Promise((resolveUrl, rejectUrl) => {
  const timer = setTimeout(() => rejectUrl(new Error('实例 90s 内未就绪')), 90_000);
  const poll = setInterval(() => {
    const m = stdout.match(/https?:\/\/\S+/);
    if (m !== null) { clearTimeout(timer); clearInterval(poll); resolveUrl(m[0]); }
    if (child.exitCode !== null) { clearTimeout(timer); clearInterval(poll); rejectUrl(new Error(`实例提前退出 ${String(child.exitCode)}`)); }
  }, 200);
}).catch((error) => { killChild(); fail(`${String(error.message)}\nstderr 尾部：\n${stderrTail}`); });
evidence.meta.instanceUrl = url.replace(/token=[^&]+/, 'token=***');
log(`实例就绪：${evidence.meta.instanceUrl}`);
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
  let response;
  try {
    response = await fetch(`${ORIGIN}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body,
      signal: AbortSignal.timeout(60_000)
    });
  } catch (connError) {
    response = await fetch(`${ORIGIN}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body,
      signal: AbortSignal.timeout(60_000)
    });
    void connError;
  }
  const text = await response.text();
  const parsed = JSON.parse(text);
  if (parsed?.result?.ok !== true) throw new Error(`${endpoint}: ${JSON.stringify(parsed?.result?.error ?? '').slice(0, 200)}`);
  return parsed.result.value;
}

// 5) CAP/GAP 登记（只记事实，不判合格）。
function cap(item, detail = '') {
  evidence.capGap.push({ item, status: 'CAP', detail: String(detail).slice(0, 500) });
  console.log(`CAP   ${item}${detail === '' ? '' : `  —— ${String(detail).slice(0, 200)}`}`);
}
function gap(item, reason) {
  evidence.capGap.push({ item, status: 'GAP', detail: String(reason).slice(0, 500) });
  evidence.gaps.push({ item, reason: String(reason).slice(0, 500) });
  console.log(`GAP   ${item}  —— ${String(reason).slice(0, 240)}`);
}

// 6) 设置读写（agentLang 改前留痕 / 改后留痕 / 收尾恢复原值）。
async function describeNs() {
  const described = await rpc('settings/describe', {});
  const found = (described.namespaces ?? []).find((n) => (n.ns ?? n.namespace ?? n.id) === NS);
  if (found === undefined) throw new Error(`${NS} 命名空间不在 describe 里`);
  const subtree = found.value?.settings;
  if (subtree === undefined || typeof subtree !== 'object') throw new Error(`${NS} 缺 settings 子树`);
  return {
    effectiveAgentLang: subtree.agentLang ?? null,
    userSettings: found.user?.settings ?? {},
    revision: found.revision ?? null,
    at: new Date().toISOString()
  };
}
evidence.settingsTrace = { before: null, afterPatchZh: null, afterRestore: null };
try {
  evidence.settingsTrace.before = await describeNs();
  cap('settings 改前读值', `agentLang=${String(evidence.settingsTrace.before.effectiveAgentLang)}（user 层 agentLang=${JSON.stringify(evidence.settingsTrace.before.userSettings.agentLang ?? null)}）`);
} catch (error) {
  gap('settings 改前读值', `settings/describe 读取失败：${String(error?.message ?? error)}`);
}
const agentLangBefore = evidence.settingsTrace.before?.effectiveAgentLang ?? 'en';
const userLayerHadKey = Object.hasOwn(evidence.settingsTrace.before?.userSettings ?? {}, 'agentLang');
const userLayerValue = evidence.settingsTrace.before?.userSettings?.agentLang ?? null;
async function patchAgentLang(value) {
  await rpc('settings/update', { ns: NS, patch: { settings: { agentLang: value } } });
}
/** 恢复 agentLang 至改前状态（user 层原无键 → unset 回继承；有键 → set 回原值）。 */
async function restoreAgentLang() {
  if (restoredFlag) return;
  restoredFlag = true;
  try {
    if (userLayerHadKey) {
      await rpc('settings/mutate', { ns: NS, ops: [{ op: 'set', path: ['settings', 'agentLang'], value: userLayerValue }] });
    } else {
      await rpc('settings/mutate', { ns: NS, ops: [{ op: 'unset', path: ['settings', 'agentLang'] }] });
    }
    evidence.settingsTrace.afterRestore = await describeNs();
    cap('settings 恢复原值回读', `agentLang=${String(evidence.settingsTrace.afterRestore.effectiveAgentLang)}（改前=${String(agentLangBefore)}）`);
  } catch (error) {
    gap('settings 恢复原值回读', `恢复或回读失败：${String(error?.message ?? error)}——临时实例随装置退出销毁，脏状态不外溢`);
  }
}

// 7) 会话与转录工具。
let SESSION = null;
const firstSeenAt = new Map();
function stampNew(sessionId, transcript) {
  const records = transcript.records ?? [];
  const now = Date.now();
  for (let i = 0; i < records.length; i += 1) {
    const key = `${sessionId}:${String(i)}`;
    if (!firstSeenAt.has(key)) firstSeenAt.set(key, now);
  }
}
const seenOf = (sessionId, absIdx) => firstSeenAt.get(`${sessionId}:${String(absIdx)}`) ?? null;
async function createSession(label) {
  const created = await rpc('session/create', { request: { cwd: home, agentPreset: PRESET } });
  SESSION = created.sessionId;
  log(`会话已建（${label}，sessionId=${SESSION}，preset=${String(created.agentPreset)}）`);
  return { sessionId: SESSION, agentPreset: created.agentPreset };
}
async function promptOn(sessionId, text, mode = 'queue') {
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId, mode,
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
}
async function transcriptOf(sessionId) {
  const listing = await rpc('session/list', { _request: {} });
  const row = listing.items.find((item) => item.sessionId === sessionId);
  if (row === undefined) throw new Error('session not found');
  return rpc('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 1200 }
  });
}
async function sessionRunning(sessionId) {
  try {
    const listing = await rpc('session/list', { _request: {} });
    const row = listing.items.find((item) => item.sessionId === sessionId);
    return row?.running === true;
  } catch { return true; } // 读取失败按运行中处理（少杀不误杀）
}
async function currentBaseline(sessionId) {
  try {
    const transcript = await transcriptOf(sessionId);
    return transcript.records?.length ?? 0;
  } catch { return -1; }
}
function stepRecords(transcript, fromIndex) {
  return (transcript.records ?? []).slice(fromIndex);
}
function pairCalls(winRecords) {
  const out = [];
  let open = null;
  for (let i = 0; i < winRecords.length; i += 1) {
    const r = winRecords[i];
    if (r.event?.type === 'tool/call') {
      if (open === null) {
        open = {
          name: r.event.data?.name ?? r.event.data?.toolName ?? r.event.data?.message?.name,
          callIdx: i, resultIdx: null, resultText: ''
        };
      }
    } else if (r.event?.type === 'tool/result' && open !== null) {
      const content = r.event.data?.message?.content ?? [];
      open.resultText = content.filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('\n');
      open.resultIdx = i;
      out.push(open);
      open = null;
    }
  }
  if (open !== null) out.push(open);
  return out;
}
function injectedEntries(winRecords) {
  return winRecords
    .map((r, i) => {
      if (r.event?.type !== 'user/message') return null;
      const message = r.event.data?.message ?? r.event.data;
      const source = message?.source ?? {};
      return {
        idx: i,
        sourceKind: String(source.kind ?? ''),
        sourceForm: String(source.form ?? ''),
        senderSessionId: source.senderSessionId,
        text: (message?.content ?? []).map((c) => String(c.text ?? '')).join('\n'),
        record: r
      };
    })
    .filter((e) => e !== null);
}
/** 断言域排除装置自身指令：含「Run this single step」标记的注入条目不进 token 计数。 */
function userSideTokenCount(winRecords, token) {
  let count = 0;
  for (const entry of injectedEntries(winRecords)) {
    if (entry.sourceKind === '' || entry.sourceKind === 'user') continue;
    if (entry.text.includes('Run this single step')) continue;
    count += entry.text.split(token).length - 1;
  }
  for (const r of winRecords) {
    if (r.event?.type !== 'tool/result') continue;
    const content = r.event.data?.message?.content ?? [];
    const text = content.filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('\n');
    count += text.split(token).length - 1;
  }
  return count;
}
/** 领取锚组（骨架 claimGroupBefore 口径：相邻 splice 串，遇内容记录即停）。 */
function claimGroupBefore(win, fromIdx, lowerBoundIdx = -1) {
  const type = (r) => String(r.event?.type ?? '');
  const isSplice = (r) => r.event?.type === 'agent/inbox/spliced' && (r.event.data?.removedCount ?? 0) > 0;
  const isMachinery = (r) => ['user/message', 'system/message', 'step/start', 'turn/start'].includes(type(r))
    || type(r).startsWith('session/') || type(r).startsWith('request/');
  const targets = [];
  let spliceIdx = -1;
  let foundSplice = false;
  for (let i = fromIdx - 1; i >= 0 && i > lowerBoundIdx; i -= 1) {
    const r = win[i];
    if (isSplice(r)) {
      if (!foundSplice) { spliceIdx = i; foundSplice = true; }
      targets.unshift(String(r.event.data?.target ?? ''));
      continue;
    }
    if (foundSplice) break;
    if (isMachinery(r)) continue;
    break;
  }
  return { spliceIdx, targets };
}
function assistantTexts(winRecords) {
  return winRecords
    .filter((r) => r.event?.type === 'assistant/message' || r.event?.type === 'model/message')
    .map((r) => (r.event.data?.message?.content ?? r.event.data?.content ?? []).map((c) => String(c.text ?? '')).join('\n'));
}
/** 客观语言特征（非判定）：CJK 字符在场性与长度。 */
const langFeature = (text) => ({
  containsCJK: /[\u3400-\u9fff\uf900-\ufaff]/.test(text ?? ''),
  length: (text ?? '').length
});
function headerRunDescription(winRecords) {
  for (const r of winRecords) {
    if (r.event?.type !== 'request/header') continue;
    const tool = (r.event.data?.header?.tools ?? []).find((t) => t.name === 'async_run');
    if (tool !== undefined) return String(tool.description ?? '');
  }
  return null;
}

// 8) 试次驱动（NI/LP 共用；每试次最多 2 attempts，重试留痕；LP-C 观察窗单尝试）。
const TOPIC = 'the history of lighthouse construction';
function trialPrompt(t, token, attempt) {
  const tok = `${token}-A${String(attempt)}`;
  const bg = `call async_run with command "Start-Sleep -Seconds ${String(t.durS)}; Write-Output ${tok}", description "lang blind ${t.id} bg job", yield_ms 20000`;
  if (t.mode === 'essay') {
    return `Run this single step: (1) ${bg} — it goes to background, note the job id. (2) In the SAME turn, immediately write a coherent essay of at least 900 words about ${TOPIC}; do NOT call any tools while writing; the very last line of the essay must be exactly ${t.busyEnd}. (3) After the essay, end your turn. When the background job result reaches you (during the turn or later as a message), reply with exactly ${t.receipt} and stop. No other tools, no questions.`;
  }
  return `Run this single step: (1) ${bg} — it goes to background, note the job id. (2) reply with exactly ${t.ack} and end your turn immediately; do not wait, do not call any other tool. When the job result reaches you later as a message, reply with exactly ${t.receipt} and stop. No other tools, no questions.`;
}
async function readSettingsSnapshotQuiet() {
  try { return await describeNs(); } catch (error) { return { error: String(error?.message ?? error) }; }
}
/**
 * @returns {Promise<{trialId: string, ok: boolean, sessionIds: string[], record: object}>}
 *   ok＝核心载体（V2 转后台返回＋V3 完成消息，linger 模式＝观察窗走完）在场。
 */
async function driveTrial(t) {
  const record = { trialId: t.id, lang: t.lang, mode: t.mode, durS: t.durS, attempts: [] };
  (t.series === 'NI' ? evidence.niTrials : evidence.lpTrials).push(record);
  const sessionIds = [];
  const maxAttempts = t.mode === 'linger' ? 1 : 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptRec = { attempt, sessionId: null, carriers: {}, timeline: [], spliceGroups: null, transcriptExcerpt: null, settingsSnapshot: null, note: '' };
    record.attempts.push(attemptRec);
    let sessionId;
    if (t.reuseSessionId !== undefined && attempt === 1) {
      sessionId = t.reuseSessionId;
    } else {
      try {
        sessionId = (await createSession(`${t.id}/A${String(attempt)}`)).sessionId;
      } catch (error) {
        attemptRec.note = `会话创建失败：${String(error?.message ?? error)}`;
        continue;
      }
    }
    sessionIds.push(sessionId);
    attemptRec.sessionId = sessionId;
    attemptRec.settingsSnapshot = await readSettingsSnapshotQuiet();
    const token = `${t.token}-A${String(attempt)}`;
    let beforeCount = await currentBaseline(sessionId);
    if (beforeCount < 0) beforeCount = 0;
    try {
      await promptOn(sessionId, trialPrompt(t, t.token, attempt));
    } catch (error) {
      attemptRec.note = `session/prompt 调用失败：${String(error?.message ?? error)}`;
      continue;
    }
    const deadline = Date.now() + t.observeMs;
    let settledWallSeen = null;
    let lingerFired = false;
    let wakePromptSent = false;
    let lastCount = -1;
    let lastChangeAt = Date.now();
    let stalled = false;
    const mark = (label, win, idx) => {
      attemptRec.timeline.push({
        label, wallMs: Date.now(), recordIdx: idx,
        seenAt: seenOf(sessionId, beforeCount + idx),
        excerpt: JSON.parse(JSON.stringify(win[idx]?.event ?? null))
      });
    };
    while (Date.now() < deadline) {
      await new Promise((r) => { setTimeout(r, POLL_MS); });
      if (child.exitCode !== null) { await restoreAgentLang(); killChild(); fail('实例在步骤中途退出'); }
      let transcript;
      try { transcript = await transcriptOf(sessionId); } catch { continue; }
      stampNew(sessionId, transcript);
      const count = transcript.records?.length ?? 0;
      const win = stepRecords(transcript, beforeCount);
      // —— 载体采集（每次轮询刷新，最终以末次为准）。
      const headerDesc = headerRunDescription(win);
      if (headerDesc !== null && attemptRec.carriers.header === undefined) {
        attemptRec.carriers.header = { verbatim: headerDesc, feature: langFeature(headerDesc) };
        mark('header', win, win.findIndex((r) => r.event?.type === 'request/header'));
      }
      const calls = pairCalls(win);
      const runCalls = calls.filter((c) => c.name === 'async_run' && c.resultIdx !== null);
      if (runCalls.length > 0) {
        const rc = runCalls.at(-1);
        attemptRec.carriers.yieldReturn = { verbatim: rc.resultText, feature: langFeature(rc.resultText), jobCount: runCalls.length };
        if (attemptRec.timeline.find((x) => x.label === 'runResult') === undefined) mark('runResult', win, rc.resultIdx);
      }
      const waitCalls = calls.filter((c) => c.name === 'async_wait' && c.resultIdx !== null);
      if (waitCalls.length > 0) {
        attemptRec.carriers.waitReturn = waitCalls.map((c) => ({ verbatim: c.resultText, feature: langFeature(c.resultText) }));
      }
      const stepJobIds = new Set(win.filter((r) => r.event?.type === 'job/registered')
        .map((r) => String(r.event.data?.jobId ?? '')).filter((id) => id !== ''));
      const settledIdx = win.findIndex((r) => r.event?.type === 'job/settled' && stepJobIds.has(String(r.event.data?.jobId ?? '')));
      if (settledIdx >= 0) {
        if (settledWallSeen === null) { settledWallSeen = Date.now(); mark('settled', win, settledIdx); }
      }
      const completion = injectedEntries(win).find((e) => e.sourceKind === 'async-tools-job-result' && e.text.includes(token)) ?? null;
      if (completion !== null) {
        attemptRec.carriers.completion = { verbatim: completion.text, feature: langFeature(completion.text), idx: completion.idx };
        if (attemptRec.timeline.find((x) => x.label === 'completion') === undefined) mark('completion', win, completion.idx);
      }
      // —— 滞留分支（LP-C）：结算后 ≥90s 完成消息未出现且持续非 running → 唤醒（单次）。
      if (t.mode === 'linger' && completion === null && settledWallSeen !== null
        && Date.now() - settledWallSeen >= 90_000 && !lingerFired
        && !(await sessionRunning(sessionId))) {
        lingerFired = true;
        attemptRec.note += '滞留形态检出（结算后 ≥90s 完成消息记录未出现、非 running）；发送中性 queue 唤醒（单尝试）。';
        try { await promptOn(sessionId, 'Reply now with any pending receipt tokens you owe from earlier job results, then stop. No tools.'); wakePromptSent = true; } catch { /* 唤醒失败按超时路径留痕 */ }
      }
      // —— 停摆防护（非 linger 模式：180s 无新记录且非 running）。
      if (t.mode !== 'linger') {
        if (count !== lastCount) { lastCount = count; lastChangeAt = Date.now(); }
        else if (Date.now() - lastChangeAt >= 180_000 && !(await sessionRunning(sessionId))) {
          stalled = true;
          attemptRec.note += `停摆（180s 无新记录且非运行；末次记录计数 ${String(lastCount)}）。`;
          break;
        }
      }
      // —— 完成条件：完成消息在场（essay/plain/quick-idle/reuse 全模式同判）。
      if (completion !== null) break;
    }
    // —— 收尾读数：splice 组与窗口原文（不做有利筛选，整窗原样落卷）。
    let finalTranscript = null;
    try { finalTranscript = await transcriptOf(sessionId); } catch { /* 末读失败按已有材料留痕 */ }
    if (finalTranscript !== null) {
      const win = stepRecords(finalTranscript, beforeCount);
      const splices = [];
      for (let i = 0; i < win.length; i += 1) {
        const r = win[i];
        if (r.event?.type !== 'agent/inbox/spliced') continue;
        splices.push({ idx: i, target: String(r.event.data?.target ?? ''), removedCount: Number(r.event.data?.removedCount ?? 0), verbatim: JSON.parse(JSON.stringify(r.event)) });
      }
      const completionEntry = injectedEntries(win).find((e) => e.sourceKind === 'async-tools-job-result' && e.text.includes(token)) ?? null;
      const firstToolIdx = win.findIndex((r) => r.event?.type === 'tool/call');
      const group = completionEntry !== null ? claimGroupBefore(win, completionEntry.idx, firstToolIdx) : { spliceIdx: -1, targets: [] };
      attemptRec.spliceGroups = {
        sessionRecordBase: beforeCount,
        allSplices: splices,
        completionClaimGroup: completionEntry !== null
          ? { spliceIdx: group.spliceIdx, targets: group.targets, absoluteIdx: group.spliceIdx >= 0 ? beforeCount + group.spliceIdx : null,
              shape: group.targets.includes('next-turn') ? 'followup-after-idle' : group.targets.length > 0 ? 'inject-during-step' : 'no-splice-before-completion' }
          : null,
        shapeNote: 'shape 为装置按 splice 组实测形态的客观登记（组含 next-turn=followup；只含 next-step=inject；无 splice=缺席），非产品判定。',
        wakePromptSent
      };
      attemptRec.transcriptExcerpt = {
        note: '试次窗口全部记录原样落卷（不做有利筛选；record.event 原文）。',
        records: win.map((r) => JSON.parse(JSON.stringify(r)))
      };
      if (completionEntry !== null && attemptRec.carriers.completion === undefined) {
        attemptRec.carriers.completion = { verbatim: completionEntry.text, feature: langFeature(completionEntry.text), idx: completionEntry.idx };
      }
    }
    attemptRec.tokenUserSideCount = attemptRec.transcriptExcerpt !== null
      ? userSideTokenCount(attemptRec.transcriptExcerpt.records.map((r) => ({ event: r.event })), token)
      : null;
    const receipts = attemptRec.transcriptExcerpt !== null
      ? assistantTexts(attemptRec.transcriptExcerpt.records.map((r) => ({ event: r.event }))).filter((txt) => txt.includes(t.receipt)).length
      : 0;
    attemptRec.receiptSeen = receipts > 0;
    if (attemptRec.carriers.yieldReturn !== undefined && attemptRec.carriers.completion !== undefined) break;
    if (t.mode === 'linger') break; // 观察窗单尝试：走完即登记（材料在场与否按 CAP/GAP 记）
    log(`试次 ${t.id} 第 ${String(attempt)} 次核心载体缺席（${attemptRec.carriers.yieldReturn !== undefined ? 'V2 在场' : 'V2 缺席'}／${attemptRec.carriers.completion !== undefined ? 'V3 在场' : 'V3 缺席'}），重试一次`);
  }
  const last = record.attempts.at(-1);
  const ok = last?.carriers?.yieldReturn !== undefined && last?.carriers?.completion !== undefined;
  // 载体级 CAP/GAP（以末次 attempt 为准；重试 attempts 全留痕）。
  const itemV1 = `${t.id}/V1 header 描述`;
  const itemV2 = `${t.id}/V2 转后台返回`;
  const itemV3 = `${t.id}/V3 完成消息正文`;
  if (last?.carriers?.header !== undefined) cap(itemV1, `语言特征 containsCJK=${String(last.carriers.header.feature.containsCJK)}，长度 ${String(last.carriers.header.feature.length)}；全文见分节 JSON`);
  else gap(itemV1, 'request/header 未采到（窗口内无 header 或无 async_run 工具）');
  if (last?.carriers?.yieldReturn !== undefined) cap(itemV2, `语言特征 containsCJK=${String(last.carriers.yieldReturn.feature.containsCJK)}，长度 ${String(last.carriers.yieldReturn.feature.length)}；全文见分节 JSON`);
  else gap(itemV2, 'async_run 转后台返回未采到');
  if (last?.carriers?.completion !== undefined) {
    cap(itemV3, `语言特征 containsCJK=${String(last.carriers.completion.feature.containsCJK)}；splice 组形态=${String(last.spliceGroups?.completionClaimGroup?.shape ?? 'n/a')}；token 用户侧×${String(last.tokenUserSideCount ?? 'n/a')}`);
  } else {
    gap(itemV3, t.mode === 'linger'
      ? `完成消息未采到（滞留窗＋唤醒后仍未出现；wakePromptSent=${String(last?.spliceGroups?.wakePromptSent ?? false)}）`
      : '完成消息未采到（观察窗内未出现）');
  }
  if (last?.carriers?.waitReturn !== undefined) cap(`${t.id}/V4 wait 返回`, `${String(last.carriers.waitReturn.length)} 次在场（全文见分节 JSON）`);
  cap(`${t.id}/V5 settings 时点快照`, `agentLang=${String(last?.settingsSnapshot?.effectiveAgentLang ?? '读取失败')}（改档意图=${t.lang}）`);
  record.ok = ok;
  return { trialId: t.id, ok, sessionIds };
}

// 9) M 系列：固定格式问答（自报读数；不含锚句原文，防泄漏与复述污染）。
const M_BATTERY = [
  'Reply using the three fixed-format lines below and nothing else. Do not call any tools.',
  'JOBS_GUIDE_SEEN=<in your own standing instructions above (the system prompt, not tool descriptions), is there guidance about tracking background job ids and collecting their results before your final answer? yes/no>',
  'JOBS_COLLECT_LANG=<what language is that collection guidance (the part about collecting undelivered results with async_wait) written in? en/zh/none>',
  'CONFIDENCE=<sure/unsure>'
].join('\n');
const fieldOf = (answer, key) => {
  const match = answer.match(new RegExp(`${key}\\s*=\\s*([^\\r\\n]+)`, 'i'));
  return match === null ? '' : match[1].trim();
};
async function driveM(id, lang) {
  const record = { id, lang, attempts: [] };
  evidence.mProbes.push(record);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptRec = { attempt, sessionId: null, answer: '', fields: null, settingsSnapshot: null };
    record.attempts.push(attemptRec);
    let sessionId;
    try { sessionId = (await createSession(`${id}/A${String(attempt)}`)).sessionId; } catch (error) {
      attemptRec.answer = `会话创建失败：${String(error?.message ?? error)}`;
      continue;
    }
    attemptRec.sessionId = sessionId;
    attemptRec.settingsSnapshot = await readSettingsSnapshotQuiet();
    try { await promptOn(sessionId, M_BATTERY); } catch (error) {
      attemptRec.answer = `session/prompt 调用失败：${String(error?.message ?? error)}`;
      continue;
    }
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      await new Promise((r) => { setTimeout(r, POLL_MS); });
      if (child.exitCode !== null) { await restoreAgentLang(); killChild(); fail('实例在 M 步骤中途退出'); }
      let transcript;
      try { transcript = await transcriptOf(sessionId); } catch { continue; }
      stampNew(sessionId, transcript);
      const texts = assistantTexts(transcript.records ?? []);
      const answer = texts.findLast((txt) => txt.includes('JOBS_GUIDE_SEEN') || txt.includes('JOBS_COLLECT_LANG')) ?? '';
      const turnEnded = (transcript.records ?? []).some((r) => r.event?.type === 'turn/end');
      if (answer !== '' && turnEnded) {
        attemptRec.answer = answer;
        attemptRec.fields = { JOBS_GUIDE_SEEN: fieldOf(answer, 'JOBS_GUIDE_SEEN'), JOBS_COLLECT_LANG: fieldOf(answer, 'JOBS_COLLECT_LANG'), CONFIDENCE: fieldOf(answer, 'CONFIDENCE') };
        break;
      }
    }
    if (attemptRec.fields !== null) break;
    log(`M 步骤 ${id} 第 ${String(attempt)} 次未取得固定格式回答，重试一次`);
  }
  const last = record.attempts.at(-1);
  if (last?.fields !== null && last?.fields !== undefined) {
    cap(`${id}/M 自报读数`, `JOBS_GUIDE_SEEN=${last.fields.JOBS_GUIDE_SEEN}／JOBS_COLLECT_LANG=${last.fields.JOBS_COLLECT_LANG}／CONFIDENCE=${last.fields.CONFIDENCE}（自报旁证，判定权在盲测代理）`);
  } else {
    gap(`${id}/M 自报读数`, `固定格式回答未取得（末次：${String(last?.answer ?? '').slice(0, 200)}）`);
  }
}

// 10) 主序列。
console.log(`\n── lang 盲测采集（候选 ${head}${dirty}；en 档先采，切 zh 后采 zh 档）──`);
// 连通性：首会话（NI-1 第 1 attempt 会内建；此处先验 RPC 会话面可用）。
try {
  const probe0 = await createSession('connectivity');
  cap('RPC 会话面连通', `sessionId=${probe0.sessionId}`);
} catch (error) {
  fail(`连通性会话创建失败（实例 RPC 面不可用）：${String(error?.message ?? error)}`);
}
const rnd = () => Math.random().toString(36).slice(2, 8);
// reuseId 提前声明（FAULT 路径 dumpAll 也引用它——避免主序列 const 的 TDZ）。
let reuseId;
const ni1 = await driveTrial({ series: 'NI', id: 'NI-1', lang: 'en', mode: 'plain', durS: 45, observeMs: (45 + 240) * 1000, token: `NI1-${rnd()}`, ack: 'NI1_ACK', receipt: 'NI1_DONE' });
await driveM('M-en', 'en');
// 切 zh（改前读值已留痕；改后读值留痕）。
try {
  await patchAgentLang('zh');
  evidence.settingsTrace.afterPatchZh = await describeNs();
  cap('settings 改后读值（zh）', `agentLang=${String(evidence.settingsTrace.afterPatchZh.effectiveAgentLang)}`);
} catch (error) {
  gap('settings 改后读值（zh）', `写入或回读失败：${String(error?.message ?? error)}——后续 zh 档试次仍按计划执行、读数以各试段 V5 快照为准`);
}
const ni2 = await driveTrial({ series: 'NI', id: 'NI-2', lang: 'zh', mode: 'plain', durS: 60, observeMs: (60 + 240) * 1000, token: `NI2-${rnd()}`, ack: 'NI2_ACK', receipt: 'NI2_DONE' });
const ni3 = await driveTrial({ series: 'NI', id: 'NI-3', lang: 'zh', mode: 'plain', durS: 75, observeMs: (75 + 240) * 1000, token: `NI3-${rnd()}`, ack: 'NI3_ACK', receipt: 'NI3_DONE' });
await driveTrial({ series: 'LP', id: 'LP-A', lang: 'zh', mode: 'essay', durS: 45, observeMs: (45 + 300) * 1000, token: `LPA-${rnd()}`, busyEnd: 'LP-A-BUSY-END', receipt: 'LPA_DONE' });
await driveTrial({ series: 'LP', id: 'LP-B', lang: 'zh', mode: 'plain', durS: 30, observeMs: (30 + 180) * 1000, token: `LPB-${rnd()}`, ack: 'LPB_ACK', receipt: 'LPB_DONE' });
await driveTrial({ series: 'LP', id: 'LP-C', lang: 'zh', mode: 'linger', durS: 30, observeMs: (30 + 90 + 150) * 1000, token: `LPC-${rnd()}`, ack: 'LPC_ACK', receipt: 'LPC_DONE' });
// LP-D＝复用 NI-3 会话（末次 attempt 的会话；NI-3 无会话则记偏差换新会话）。
reuseId = ni3.sessionIds.at(-1);
if (reuseId === undefined) {
  evidence.deviations.push({ item: 'LP-D', note: 'NI-3 未产生会话，无法按计划复用——LP-D 换新会话执行（偏差登记）' });
}
await driveTrial({ series: 'LP', id: 'LP-D', lang: 'zh', mode: 'reuse', durS: 30, observeMs: (30 + 180) * 1000, token: `LPD-${rnd()}`, ack: 'LPD_ACK', receipt: 'LPD_DONE', reuseSessionId: reuseId });
await driveM('M-zh', 'zh');
// 计划书缺口登记（V1-V5 定义未随任务提供；本装置自定义映射）。
gap('计划书 V1-V5 载具定义', '盲测代理计划书未随任务提供，V1-V5 无法按原文执行——本装置按材料形态自定义映射（见文件头注释），判定权在盲测代理');
if (reuseId !== undefined && ni1.ok !== true) evidence.deviations.push({ item: 'NI-1', note: `en 档对照样本核心载体缺席（ok=${String(ni1.ok)}），材料以 attempts 留痕` });

// 11) 收尾：恢复设置原值 → 停实例 → 落盘 → 退出。
await restoreAgentLang();
await finish();
async function finish() {
  killChild();
  await new Promise((r) => { setTimeout(r, 1500); });
  if (!keep) {
    try { rmSync(home, { recursive: true, force: true }); log(`已清理临时 home：${home}`); }
    catch { console.error(`[probe] WARN: 临时目录清理失败，留存现场：${home}`); }
  }
  try { rmSync(tgzPath, { force: true }); } catch { /* 产物清理尽力而为 */ }
  evidence.meta.finishedAt = new Date().toISOString();
  evidence.capGapSummary = {
    cap: evidence.capGap.filter((x) => x.status === 'CAP').length,
    gap: evidence.capGap.filter((x) => x.status === 'GAP').length
  };
  dumpAll();
  log(`证据落盘：${EVID_DIR}（CAP ${String(evidence.capGapSummary.cap)}／GAP ${String(evidence.capGapSummary.gap)}）`);
  process.exit(0);
}
function dumpAll() {
  mkdirSync(EVID_DIR, { recursive: true });
  const write = (name, data) => writeFileSync(join(EVID_DIR, name), JSON.stringify(data, null, 2));
  write('manifest.json', {
    meta: evidence.meta,
    planMapping: {
      'NI-1': 'en 档 plain，D=45s', 'NI-2': 'zh 档 plain，D=60s', 'NI-3': 'zh 档 plain，D=75s',
      'LP-A': 'zh 档 essay（忙碌窗构造），D=45s', 'LP-B': 'zh 档 quick-idle（立即结束回合），D=30s',
      'LP-C': 'zh 档 linger（滞留观察＋中性唤醒，单尝试），D=30s', 'LP-D': `zh 档 reuse（${reuseId !== undefined ? `复用 NI-3 会话 ${reuseId}` : '计划复用失败换新会话'}），D=30s`,
      'M-en/M-zh': '装置自定义补充：常驻指令语言特征自报问答（计划书缺位）',
      carriers: { V1: 'request/header async_run description', V2: 'async_run 转后台返回文本', V3: '完成消息正文', V4: 'async_wait 返回文本', V5: 'settings agentLang 时点快照' }
    },
    settingsTrace: evidence.settingsTrace,
    capGap: evidence.capGap,
    capGapSummary: evidence.capGapSummary ?? { cap: evidence.capGap.filter((x) => x.status === 'CAP').length, gap: evidence.capGap.filter((x) => x.status === 'GAP').length },
    gaps: evidence.gaps,
    deviations: evidence.deviations,
    files: ['manifest.json', 'settings-trace.json', 'ni-trials.json', 'lp-trials.json', 'm-probes.json', 'splice-groups.json']
  });
  write('settings-trace.json', evidence.settingsTrace);
  write('ni-trials.json', evidence.niTrials);
  write('lp-trials.json', evidence.lpTrials);
  write('m-probes.json', evidence.mProbes);
  write('splice-groups.json', {
    note: '各试次 splice 组读数与窗口关键时点（转录分组原文；完整窗口记录见 ni-trials.json / lp-trials.json 的 transcriptExcerpt）。',
    trials: [...evidence.niTrials, ...evidence.lpTrials].map((t) => ({
      trialId: t.trialId,
      attempts: t.attempts.map((a) => ({ attempt: a.attempt, sessionId: a.sessionId, spliceGroups: a.spliceGroups, timeline: a.timeline }))
    }))
  });
}
function killChild() {
  if (child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
  }
}
