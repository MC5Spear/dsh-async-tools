/**
 * lang 盲测补采·错误文案（verify/probe-lang-err.mjs）。
 *
 * 目标（一号判定表遗留「错误文案两档」）：en／zh 两档各触发一次本包自有错误
 * 文案（error.unknownJob——async_wait 对不存在的 job id），tool/result 错误
 * 文本原样落卷；判定权在盲测代理。只记 CAP/GAP；唯一状态改写 agentLang，
 * 收尾恢复原值。「Run this single step:」装置指令排除出断言域。
 *
 * 用法：node verify/probe-lang-err.mjs --service-root <根> --host-subdir dsh-0.2.1-rc.5
 * 证据落盘 .local/evidence/lang-err/。退出码 0＝跑完；2＝FAULT。
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
const repo = resolve(argOf('repo') ?? process.cwd());
const EVID = join(repo, '.local', 'evidence', 'lang-err');
let home = null;
let restored = false;
const evidence = { meta: {}, trials: [], capGap: [], gaps: [] };
const fail = (msg) => {
  console.error(`[probe] FAULT: ${msg}`);
  try {
    evidence.fault = String(msg);
    mkdirSync(EVID, { recursive: true });
    writeFileSync(join(EVID, 'manifest.json'), JSON.stringify(evidence, null, 1));
  } catch { /* */ }
  process.exit(2);
};
process.on('uncaughtException', (e) => { fail(String(e?.stack ?? e)); });
process.on('unhandledRejection', (r) => { fail(String(r)); });
const serviceRoot = resolve(argOf('service-root') ?? fail('缺少 --service-root'));
const hostSubdir = argOf('host-subdir') ?? 'dsh-0.2.1-rc.5';
const hostRoot = join(serviceRoot, hostSubdir);
const log = (m) => console.log(`[probe] ${m}`);
mkdirSync(join(repo, '.local'), { recursive: true });
mkdirSync(EVID, { recursive: true });
evidence.meta.startedAt = new Date().toISOString();
const cap = (item, ok, detail = '') => {
  evidence.capGap.push({ item, status: ok ? 'CAP' : 'GAP', detail: String(detail).slice(0, 400) });
  console.log(`${ok ? 'CAP' : 'GAP'}   ${item}${detail === '' ? '' : `  —— ${String(detail).slice(0, 200)}`}`);
  if (!ok) evidence.gaps.push({ item });
};
const packRun = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', '.local'], { cwd: repo, encoding: 'utf8', shell: true });
if (packRun.status !== 0) fail('npm pack 失败');
const tgz = (packRun.stdout.match(/dsh-async-tools-[^\s]+\.tgz/g) ?? []).pop();
home = mkdtempSync(join(tmpdir(), 'dsh-lang-err-'));
const cliBin = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const addRun = spawnSync('node', [cliBin, 'plugin', '--profile', 'web', 'add', join(repo, '.local', tgz)], { cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 300_000 });
if (addRun.status !== 0) fail('plugin add 失败');
const child = spawn('node', [cliBin, '--patch', join(serviceRoot, 'patches', 'zai-glm.yml'), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
child.stdout.on('data', (c) => { stdout += c; });
process.on('exit', () => { try { process.kill(child.pid, 'SIGTERM'); } catch { /* */ } });
const url = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('实例 90s 未就绪')), 90_000);
  const p = setInterval(() => {
    const m = stdout.match(/https?:\/\/\S+/);
    if (m !== null) { clearTimeout(t); clearInterval(p); res(m[0]); }
    if (child.exitCode !== null) { clearTimeout(t); clearInterval(p); rej(new Error('实例提前退出')); }
  }, 200);
}).catch((e) => { fail(String(e.message)); });
log(`实例就绪：${url.replace(/token=[^&]+/, 'token=***')}`);
await new Promise((r) => { setTimeout(r, 5000); });
const [, ORIGIN, TOKEN] = url.match(/^(https?:\/\/[^/?#]+)\/?\?token=(.+)$/) ?? [];
if (TOKEN === undefined) fail('URL 形态不符');
const ir = await fetch(`${ORIGIN}/?token=${TOKEN}`, { redirect: 'manual' });
const COOKIE = (ir.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
const rpc = async (endpoint, argsBody) => {
  const r = await fetch(`${ORIGIN}/api/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE },
    body: JSON.stringify({ type: 'client-request', rpcId: `p-${Math.random().toString(36).slice(2, 8)}`, method: endpoint, payload: { args: argsBody } }),
    signal: AbortSignal.timeout(60_000)
  });
  const parsed = JSON.parse(await r.text());
  if (parsed?.result?.ok !== true) throw new Error(`${endpoint}: ${JSON.stringify(parsed?.result?.error ?? '').slice(0, 150)}`);
  return parsed.result.value;
};
const describeNs = async () => {
  const d = await rpc('settings/describe', {});
  const row = (d.namespaces ?? []).find((n) => (n.ns ?? n.namespace ?? n.id) === NS);
  return { agentLang: row?.value?.settings?.agentLang ?? null, userSettings: row?.user?.settings ?? {} };
};
const before = await describeNs();
const hadKey = Object.hasOwn(before.userSettings ?? {}, 'agentLang');
const userVal = before.userSettings?.agentLang ?? null;
cap('settings 改前读值', true, `agentLang=${String(before.agentLang)}`);
const textOf = (r) => {
  const d = r.event?.data ?? {};
  const parts = (p) => Array.isArray(p) ? p.map((x) => String(x?.text ?? '')).join('\n') : String(p ?? '');
  if (typeof d.text === 'string') return d.text;
  if (Array.isArray(d.content)) return parts(d.content);
  if (Array.isArray(d.message?.content)) return parts(d.message.content);
  return '';
};
const BOGUS = `job-no-such-${Math.random().toString(36).slice(2, 8)}`;
const ERR_PROMPT = `Run this single step: call the async_wait tool with exactly targets=[{"kind":"job","id":"${BOGUS}"}] and wait_ms=30000. Report the tool's exact error text verbatim, nothing else.`;
async function errTrial(lang) {
  if (lang === 'zh') await rpc('settings/update', { ns: NS, patch: { settings: { agentLang: 'zh' } } });
  const created = await rpc('session/create', { request: { cwd: home, agentPreset: PRESET } });
  const sid = created.sessionId;
  await rpc('session/prompt', { request: { requestId: `r-${Math.random().toString(36).slice(2, 8)}`, sessionId: sid, mode: 'queue', content: [{ type: 'text', text: ERR_PROMPT }], clientTimeZone: 'Asia/Shanghai' } });
  const start = Date.now();
  let records = [];
  for (;;) {
    await new Promise((r) => { setTimeout(r, 3000); });
    const listing = await rpc('session/list', { _request: {} });
    const row = listing.items.find((i) => i.sessionId === sid);
    if (row?.running !== true) {
      const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: sid }, throughSeq: row.projections.asOfSeq, maxMessages: 800 } });
      records = page.records ?? [];
      const hasResult = records.some((r) => r.event?.type === 'tool/result');
      const hasErr = records.some((r) => r.event?.type === 'tool/result' && textOf(r).includes(BOGUS));
      if (hasResult) {
        const errors = records.filter((r) => r.event?.type === 'tool/result').map(textOf);
        writeFileSync(join(EVID, `err-${lang}-records.json`), JSON.stringify({ sessionId: sid, at: new Date().toISOString(), agentLang: lang, bogusId: BOGUS, totalRecords: records.length, records }, null, 1));
        cap(`U-2(${lang}) 错误文本入档`, hasErr, `错误文本含假 id；tool/result=${String(errors.length)} 条`);
        return;
      }
    }
    if (Date.now() - start > 150_000) {
      writeFileSync(join(EVID, `err-${lang}-records.json`), JSON.stringify({ sessionId: sid, at: new Date().toISOString(), agentLang: lang, bogusId: BOGUS, totalRecords: records.length, records }, null, 1));
      cap(`U-2(${lang}) 错误文本入档`, false, '150s 内未见 tool/result');
      return;
    }
  }
}
await errTrial('en');
await errTrial('zh');
try {
  if (hadKey) await rpc('settings/update', { ns: NS, patch: { settings: { agentLang: userVal } } });
  else await rpc('settings/mutate', { ns: NS, ops: [{ op: 'unset', path: ['settings', 'agentLang'] }] });
  const after = await describeNs();
  cap('settings 恢复原值回读', true, `agentLang=${String(after.agentLang)}（改前=${String(before.agentLang)}）`);
} catch (e) { cap('settings 恢复原值回读', false, String(e?.message ?? e)); }
restored = true;
evidence.meta.finishedAt = new Date().toISOString();
writeFileSync(join(EVID, 'manifest.json'), JSON.stringify(evidence, null, 1));
log(`证据落盘：${EVID}`);
try { process.kill(child.pid, 'SIGTERM'); } catch { /* */ }
try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
process.exit(0);
