/**
 * lang 盲测采集装置·补采二号（verify/probe-lang-blind-2.mjs）。
 *
 * ## 装置定位（装置边界，同一号装置）
 *
 * 只记 CAP/GAP（采到／缺口），绝不产出产品合格判定——材料是否满足
 * docs/requirements.md §5.3（L436-437：错误文案两档完整；只改一边另一边可见
 * 文案不变）由盲测代理判定。装置不改插件与宿主行为；唯一状态改写是
 * `agentLang`／`uiLang` 设置项，收尾恢复原值。
 *
 * ## 补采目标（一号装置判定表遗留三项「无法判定」）
 *
 * - U-1 uiLang 独立性（Agent 侧）：agentLang=en 出厂档下把 uiLang 改 zh，
 *   新会话 Agent 侧载体（header 工具描述、完成消息、错误文案）语言应仍随
 *   agentLang（en）——uiLang 只管设置表单与待答界面（GUI 面已由
 *   settings-visual 探针覆盖，本装置只采 Agent 侧）。
 * - U-2 错误文案两档：同会话触发一次缺 wait_ms 的 async_wait 调用（只传
 *   targets、省略必填的 wait_ms——execute 侧抛 error.waitRequired，本包自有
 *   错误文案、随 agentLang 两档；async_run 没有 wait_ms 参数，其首次等待键是
 *   可选的 yield_ms，不能用来构造该用例），采 tool/result 错误文本；en／zh
 *   两档各一次（en 档在 U-1 的会话里采，zh 档在 L-1 的会话里采）。
 * - L-1 同会话活读切换：zh 档会话完成一轮投递后，把 agentLang 切 en，同会话
 *   再投一轮——后续组稿（system/message 纪律段／收集句）语言形态原样落卷。
 *
 * ## 用法
 *
 *   node verify/probe-lang-blind-2.mjs --service-root <宿主服务根> \
 *     --host-subdir <宿主树目录名，如 dsh-0.2.1-rc.5> [--repo <本仓路径>] [--keep]
 *
 * 证据落盘 .local/evidence/lang-blind-2/。退出码 0＝采集序列跑完；2＝FAULT。
 * 「Run this single step:」装置指令排除出断言域（token 计数只统计宿主侧载体）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const NS = 'async-tools-host';
const PRESET = 'dsh-async';
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const keep = args.includes('--keep');
const repo = resolve(argOf('repo') ?? process.cwd());
const EVID_DIR = join(repo, '.local', 'evidence', 'lang-blind-2');
let home = null;
let restoredFlag = false;
const evidence = {
  meta: { startedAt: null, finishedAt: null, head: null, dirty: null, hostVersion: null, repo, instanceUrl: null },
  settingsTrace: {},
  turns: [],
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
if (serviceRootArg === undefined || serviceRootArg.trim() === '') fail('缺少 --service-root');
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
evidence.meta.hostVersion = hostVersion;
evidence.meta.serviceRoot = serviceRoot;
evidence.meta.hostSubdir = hostSubdir;

mkdirSync(join(repo, '.local'), { recursive: true });
mkdirSync(EVID_DIR, { recursive: true });
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
if (tgzName === undefined) fail('npm pack 未产出 tgz');
log(`tgz=${tgzName}`);

home = mkdtempSync(join(tmpdir(), 'dsh-lang-blind2-'));
const cliBin = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const addRun = spawnSync('node', [cliBin, 'plugin', '--profile', 'web', 'add', join(repo, '.local', tgzName)], {
  cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 300_000
});
if (addRun.status !== 0) fail(`plugin add 退出 ${String(addRun.status)}`);
log('plugin add 完成');

let child;
function killChild() { if (child?.pid > 0) { try { process.kill(child.pid, 'SIGTERM'); } catch { /* */ } } }
child = spawn('node', [cliBin, '--patch', join(serviceRoot, 'patches', 'zai-glm.yml'), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe']
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

const urlMatch = url.match(/^(https?:\/\/[^/?#]+)\/?\?token=(.+)$/);
if (urlMatch === null) { killChild(); fail('实例 URL 形态不符'); }
const [, ORIGIN, TOKEN] = urlMatch;
const indexResponse = await fetch(`${ORIGIN}/?token=${TOKEN}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
const COOKIE = (indexResponse.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
if (COOKIE.length === 0) { killChild(); fail('token exchange returned no cookie'); }
async function rpc(endpoint, argsBody) {
  const body = JSON.stringify({ type: 'client-request', rpcId: `probe-${Math.random().toString(36).slice(2, 10)}`, method: endpoint, payload: { args: argsBody } });
  let response;
  try {
    response = await fetch(`${ORIGIN}/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body, signal: AbortSignal.timeout(60_000) });
  } catch (connError) {
    response = await fetch(`${ORIGIN}/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body, signal: AbortSignal.timeout(60_000) });
    void connError;
  }
  const parsed = JSON.parse(await response.text());
  if (parsed?.result?.ok !== true) throw new Error(`${endpoint}: ${JSON.stringify(parsed?.result?.error ?? '').slice(0, 200)}`);
  return parsed.result.value;
}

function cap(item, ok, detail = '') {
  // ok＝采集是否成立：false 记 GAP 并保留 detail 里的原始失败事实——退出码仍为 0
  // （装置跑完采集序列即 0，CAP/GAP 都是合法产出），采集不成立不靠退出码表达。
  evidence.capGap.push({ item, status: ok ? 'CAP' : 'GAP', detail: String(detail).slice(0, 500) });
  console.log(`${ok ? 'CAP' : 'GAP'}   ${item}${detail === '' ? '' : `  —— ${String(detail).slice(0, 200)}`}`);
  if (!ok) evidence.gaps.push({ item, reason: String(detail).slice(0, 500) });
}
function gap(item, reason) {
  evidence.capGap.push({ item, status: 'GAP', detail: String(reason).slice(0, 500) });
  evidence.gaps.push({ item, reason: String(reason).slice(0, 500) });
  console.log(`GAP   ${item}  —— ${String(reason).slice(0, 240)}`);
}
const containsCJK = (s) => /[\u3400-\u9fff\uf900-\ufaff]/.test(String(s ?? ''));

async function describeNs() {
  const described = await rpc('settings/describe', {});
  const found = (described.namespaces ?? []).find((n) => (n.ns ?? n.namespace ?? n.id) === NS);
  if (found === undefined) throw new Error(`${NS} 命名空间不在 describe 里`);
  const subtree = found.value?.settings;
  return {
    agentLang: subtree?.agentLang ?? null,
    uiLang: subtree?.uiLang ?? null,
    userSettings: found.user?.settings ?? {},
    revision: found.revision ?? null,
    at: new Date().toISOString()
  };
}
const patch = (kv) => rpc('settings/update', { ns: NS, patch: { settings: kv } });
const unsetKey = (key) => rpc('settings/mutate', { ns: NS, ops: [{ op: 'unset', path: ['settings', key] }] });

evidence.settingsTrace.before = await describeNs();
const beforeUser = evidence.settingsTrace.before.userSettings ?? {};
const hadAgent = Object.hasOwn(beforeUser, 'agentLang');
const hadUi = Object.hasOwn(beforeUser, 'uiLang');
const agentUserVal = beforeUser.agentLang ?? null;
const uiUserVal = beforeUser.uiLang ?? null;
cap('settings 改前读值', true, `agentLang=${String(evidence.settingsTrace.before.agentLang)} uiLang=${String(evidence.settingsTrace.before.uiLang)}（user 层 agentLang=${JSON.stringify(agentUserVal)} uiLang=${JSON.stringify(uiUserVal)}）`);
async function restoreAll() {
  if (restoredFlag) return;
  restoredFlag = true;
  try {
    if (hadAgent) await patch({ agentLang: agentUserVal }); else await unsetKey('agentLang');
    if (hadUi) await patch({ uiLang: uiUserVal }); else await unsetKey('uiLang');
    evidence.settingsTrace.afterRestore = await describeNs();
    cap('settings 恢复原值回读', true, `agentLang=${String(evidence.settingsTrace.afterRestore.agentLang)} uiLang=${String(evidence.settingsTrace.afterRestore.uiLang)}`);
  } catch (error) {
    gap('settings 恢复原值回读', String(error?.message ?? error));
  }
}

async function createSession(label) {
  const created = await rpc('session/create', { request: { cwd: home, agentPreset: PRESET } });
  log(`会话已建（${label}，sessionId=${created.sessionId}）`);
  return created.sessionId;
}
async function promptOn(sessionId, text) {
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`, sessionId, mode: 'queue',
      content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai'
    }
  });
}
async function sessionRunning(sessionId) {
  try {
    const listing = await rpc('session/list', { _request: {} });
    const row = listing.items.find((item) => item.sessionId === sessionId);
    return row?.running === true;
  } catch { return true; }
}
/** 全量翻页转储（不过滤；判定权在盲测代理）。 */
async function dumpFull(sessionId, outFile) {
  const listing = await rpc('session/list', { _request: {} });
  const row = listing.items.find((item) => item.sessionId === sessionId);
  if (row === undefined) throw new Error('session not found');
  const throughSeq = row.projections.asOfSeq;
  let records = [];
  let hasMore = true;
  let beforeSeq;
  let pages = 0;
  while (hasMore === true && pages < 20) {
    const request = { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 400 };
    if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
    const page = await rpc('session/page', { request });
    pages += 1;
    const batch = page.records ?? [];
    records = records.concat(batch);
    const oldestSeq = batch[0]?.event?.seq;
    hasMore = page.hasMore === true && batch.length > 0 && oldestSeq !== undefined && oldestSeq !== beforeSeq;
    beforeSeq = oldestSeq;
  }
  writeFileSync(join(EVID_DIR, outFile), JSON.stringify({ sessionId, at: new Date().toISOString(), pages, totalRecords: records.length, complete: hasMore !== true, records }, null, 1));
  return { total: records.length, complete: hasMore !== true, records };
}
/** 等回合静止（running=false）＋可选条件（轮询转录）。 */
async function waitTurn(sessionId, cond, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const running = await sessionRunning(sessionId);
    if (!running) {
      const listing = await rpc('session/list', { _request: {} });
      const row = listing.items.find((item) => item.sessionId === sessionId);
      const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 1200 } });
      if (cond(page.records ?? [])) return { ok: true, waitedMs: Date.now() - start };
    }
    if (Date.now() - start > timeoutMs) return { ok: false, waitedMs: Date.now() - start, label };
    await new Promise((r) => { setTimeout(r, 2500); });
  }
}
const tokenOf = () => `LANG2-${Math.random().toString(36).slice(2, 8)}`;
const textOf = (r) => {
  const d = r.event?.data ?? {};
  const parts = (p) => Array.isArray(p) ? p.map((x) => String(x?.text ?? '')).join('\n') : String(p ?? '');
  if (typeof d.text === 'string') return d.text;
  if (Array.isArray(d.content)) return parts(d.content);
  if (Array.isArray(d.message?.content)) return parts(d.message.content);
  if (typeof d.message?.content === 'string') return d.message.content;
  return '';
};

/** 便捷摘录（供盲测代理快览；判定以全量记录为准）。 */
function excerptOf(records, token) {
  const headerDesc = records.filter((r) => r.event?.type === 'request/header')
    .map((r) => JSON.stringify(r.event?.data?.tools?.find?.((t) => t?.name === 'async_run') ?? null)).find((s) => s !== 'null') ?? null;
  const systemMsgs = records.filter((r) => r.event?.type === 'system/message').map((r) => textOf(r));
  const completions = records.filter((r) => r.event?.type === 'user/message' && (r.event?.data?.source?.kind === 'async-tools-job-result')).map((r) => textOf(r));
  const errorResults = records.filter((r) => r.event?.type === 'tool/result' && /error|错误|invalid|缺/i.test(textOf(r))).map((r) => textOf(r));
  const toolCalls = records.filter((r) => r.event?.type === 'tool/call').map((r) => ({ name: r.event?.data?.name, args: JSON.stringify(r.event?.data?.args ?? r.event?.data?.arguments ?? '').slice(0, 300) }));
  const tokenHits = records.filter((r) => textOf(r).includes(token)).length;
  return {
    headerAsyncRunContainsCJK: headerDesc === null ? null : containsCJK(headerDesc),
    headerAsyncRunLen: headerDesc === null ? null : headerDesc.length,
    systemMsgCount: systemMsgs.length,
    systemMsgContainsCJK: systemMsgs.map(containsCJK),
    systemMsgLast: systemMsgs[systemMsgs.length - 1]?.slice(0, 1200) ?? null,
    completionMsgs: completions.map((t) => ({ containsCJK: containsCJK(t), text: t.slice(0, 400) })),
    errorResults: errorResults.map((t) => ({ containsCJK: containsCJK(t), text: t.slice(0, 400) })),
    toolCalls, tokenHits
  };
}

// ── U-1：uiLang=zh（agentLang 保持 en 出厂档）→ 新会话 Agent 侧载体应仍 en。 ──
await patch({ uiLang: 'zh' });
evidence.settingsTrace.afterUiZh = await describeNs();
cap('U-1 前置：uiLang=zh 改后读值', true, `agentLang=${String(evidence.settingsTrace.afterUiZh.agentLang)} uiLang=${String(evidence.settingsTrace.afterUiZh.uiLang)}`);
const s1 = await createSession('U-1/L-err-en');
const errTok = tokenOf();
// 错误用例＝缺 wait_ms 的 async_wait（只传 targets）：execute 侧 error.waitRequired，
// 本包自有文案、随会话 agentLang 两档（async_run 没有 wait_ms 参数，不能构造此用例）。
await promptOn(s1, `Run this single step: call the async_wait tool with ONLY {"targets":[{"kind":"job","id":"lang2-no-such-job"}]} — deliberately OMIT the required wait_ms parameter entirely. Reply with the tool's exact error text and nothing else.`);
let waitState = await waitTurn(s1, (recs) => recs.some((r) => r.event?.type === 'tool/result' && textOf(r).length > 0), 120_000, 'U-1 错误回合');
cap('U-2a(en) 错误回合结束', waitState.ok, `waitedMs=${String(waitState.waitedMs)}`);
const jobTok1 = tokenOf();
await promptOn(s1, `Run this single step: use async_run with command "node -e \\"const t=Date.now();while(Date.now()-t<45000);process.stdout.write('${jobTok1}')\\"", description "lang2 blind bg job" and yield_ms=20000. After it yields to background, end your turn immediately.`);
waitState = await waitTurn(s1, (recs) => recs.some((r) => r.event?.type === 'user/message' && r.event?.data?.source?.kind === 'async-tools-job-result' && textOf(r).includes(jobTok1)), 150_000, 'U-1 投递回合');
// 作业 45s；完成消息经 followup 通道可能再等一轮（宿主开新回合投递）。
if (waitState.ok !== true) {
  await promptOn(s1, 'Status check only: reply with the single word PONG.');
  await waitTurn(s1, () => true, 90_000, 'U-1 唤醒回合');
}
const s1Dump = await dumpFull(s1, 'u1-session-records.json');
cap('U-1 全量记录落盘', s1Dump.complete, `records=${String(s1Dump.total)}`);
evidence.turns.push({ trial: 'U-1', sessionId: s1, token: jobTok1, errorToken: errTok, excerpt: excerptOf(s1Dump.records, jobTok1) });

// ── L-1：agentLang 切 zh → 新会话两轮（错误 en 档已在 U-1；zh 档错误在此采），
//         第二轮前把 agentLang 切回 en —— 同会话活读形态原样落卷。 ──
await patch({ agentLang: 'zh' });
evidence.settingsTrace.afterAgentZh = await describeNs();
cap('L-1 前置：agentLang=zh 改后读值', true, `agentLang=${String(evidence.settingsTrace.afterAgentZh.agentLang)} uiLang=${String(evidence.settingsTrace.afterAgentZh.uiLang)}`);
const s2 = await createSession('L-1 同会话两档');
const errTokZh = tokenOf();
// zh 档同一用例：缺 wait_ms 的 async_wait（execute 侧 error.waitRequired 的中文档文案）。
await promptOn(s2, `Run this single step: call the async_wait tool with ONLY {"targets":[{"kind":"job","id":"lang2-no-such-job"}]} — deliberately OMIT the required wait_ms parameter entirely. Reply with the tool's exact error text and nothing else.`);
waitState = await waitTurn(s2, (recs) => recs.some((r) => r.event?.type === 'tool/result' && textOf(r).length > 0), 120_000, 'L-1 zh 错误回合');
cap('U-2b(zh) 错误回合结束', waitState.ok, `waitedMs=${String(waitState.waitedMs)}`);
const jobTok2 = tokenOf();
await promptOn(s2, `Run this single step: use async_run with command "node -e \\"const t=Date.now();while(Date.now()-t<45000);process.stdout.write('${jobTok2}')\\"", description "lang2 blind bg job" and yield_ms=20000. After it yields to background, end your turn immediately.`);
waitState = await waitTurn(s2, (recs) => recs.some((r) => r.event?.type === 'user/message' && r.event?.data?.source?.kind === 'async-tools-job-result' && textOf(r).includes(jobTok2)), 150_000, 'L-1 zh 投递回合');
if (waitState.ok !== true) {
  await promptOn(s2, 'Status check only: reply with the single word PONG.');
  await waitTurn(s2, () => true, 90_000, 'L-1 zh 唤醒回合');
}
// 同会话活读：agentLang zh→en，同会话再投一轮。
await patch({ agentLang: 'en' });
evidence.settingsTrace.afterAgentEnSameSession = await describeNs();
cap('L-1 中点：同会话存活期间 agentLang 切 en 读值', true, `agentLang=${String(evidence.settingsTrace.afterAgentEnSameSession.agentLang)}`);
const jobTok3 = tokenOf();
await promptOn(s2, `Run this single step: use async_run with command "node -e \\"const t=Date.now();while(Date.now()-t<45000);process.stdout.write('${jobTok3}')\\"", description "lang2 blind bg job" and yield_ms=20000. After it yields to background, end your turn immediately.`);
waitState = await waitTurn(s2, (recs) => recs.some((r) => r.event?.type === 'user/message' && r.event?.data?.source?.kind === 'async-tools-job-result' && textOf(r).includes(jobTok3)), 150_000, 'L-1 en 投递回合');
if (waitState.ok !== true) {
  await promptOn(s2, 'Status check only: reply with the single word PONG.');
  await waitTurn(s2, () => true, 90_000, 'L-1 en 唤醒回合');
}
const s2Dump = await dumpFull(s2, 'l1-session-records.json');
cap('L-1 全量记录落盘', s2Dump.complete, `records=${String(s2Dump.total)}`);
evidence.turns.push({ trial: 'L-1', sessionId: s2, tokenZh: jobTok2, tokenEn: jobTok3, errorTokenZh: errTokZh, excerpt: excerptOf(s2Dump.records, jobTok3) });

await restoreAll();
evidence.meta.finishedAt = new Date().toISOString();
function dumpAll() {
  mkdirSync(EVID_DIR, { recursive: true });
  writeFileSync(join(EVID_DIR, 'manifest.json'), JSON.stringify(evidence, null, 1));
}
dumpAll();
log(`证据落盘：${EVID_DIR}（CAP ${String(evidence.capGap.filter((e) => e.status === 'CAP').length)}／GAP ${String(evidence.gaps.length)}）`);
killChild();
if (!keep) { try { rmSync(home, { recursive: true, force: true }); log(`已清理临时 home：${home}`); } catch { /* */ } }
process.exit(0);
