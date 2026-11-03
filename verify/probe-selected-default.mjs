/**
 * 默认预设 selectedDefault 风险真机探针（VERIFY-01：需求 8.2「安装卸载」行
 * 「默认预设风险可复现与指引」项——需求 565／设计 §5.4 提示块与 §7.2）。
 *
 * ## 探针在证什么
 *
 * 需求 565：用户把默认预设选成本包预设后移除本包，可能使默认创建新会话报
 * 错；应提供卸载前切换指引并在设置页与使用说明醒目提示；不能宣称宿主必自
 * 动回退。设计 §7.2：注册表 selectedDefault 可能继续指向已撤预设、resolve
 * 没有自动回退、不静默改用户默认。本探针在真实实例上取证四组判据（全部探
 * 针侧断言：设置读写与 session/create 的成败即载体，不经模型周转）：
 *
 * 1. SD-0 指引在场（静态）：client.js 两语词典键 `uninstallRisk`（各含
 *    agent-preset/not-found 与清选／重选动作）＋中英两语首页与用户参考的
 *    指引段在场。设置页提示块的渲染与深浅主题可读性不装置（GUI 面）。
 * 2. SD-1 风险复现：装载→经公开设置接口把 selectedDefault 写为 dsh-async
 *    （与 GUI 同一条链：settings/update）→describe 复核生效→官方 CLI
 *    plugin remove→重启实例→无指定预设的 session/create 被拒且错误形态
 *    锚定 agent-preset/not-found（不静默回落）；describe 复核 selectedDefault
 *    仍指向已撤预设（宿主不自动清除该选择）。
 * 3. SD-2 重选路径：selectedDefault 改写为宿主可用预设 standard→无指定预
 *    设的会话创建成功且落 standard（「切换到可用预设」指引的正面路径）。
 * 4. SD-3 清选路径：settings/mutate unset selectedDefault（回继承层；该 ns
 *    schema 是直根字段——mutate 的 path 不带 settings 前缀，与 async-tools-
 *    host 的嵌套 schema 不同）→无指定预设的会话创建成功且落部署默认（「清空
 *    该选择」指引的正面路径；落点按实测记录——unset 后 resolve 走部署 default）。
 *
 * 装置边界（如实声明）：「不抢默认预设、不替用户写默认选择」（需求 555）
 * 由装载期不改写 selectedDefault 佐证——SD-1 写入发生在装载复核之后、由
 * 探针显式发起，装载后首读（写入前）的 selectedDefault 不指向本包预设即
 * 在案证据；该佐证仅在「全新临时 home＋官方 CLI add＋web profile」一次装
 * 载形态下取证，已有用户选择或升级装载下的条件性抢默认不装置。宿主
 * volatile 字段经设置接口写（GUI 同链）；写入与 unset 均在探针自建临时
 * home 上进行，结束整目录清理，无需回写原状。SD-1 的报错形态锚定
 * not-found 与 IL-3a 同源（显式预设与默认预设走同一 resolve）；其他错误
 * 码语义不同、不算复现（错误码按精确相等锚定）。
 *
 * 本探针无模型周转步骤（无 session/prompt），步骤驱动与重试机制不适用；
 * 各判据一次读数（设置读写与 create 的响应即证据，无窗口竞态）。退出码：
 * 0＝全部判定通过；1＝存在 FAIL 判定；2＝探针自身故障（FAULT）。
 *
 * ## 用法
 *
 *   node verify/probe-selected-default.mjs --service-root <宿主服务根> \
 *     --host-subdir <宿主树目录名，如 dsh-0.2.1-rc.5> [--repo <本仓路径>] [--keep]
 *
 * `--service-root` 必填（或设 `DSAT_SERVICE_ROOT`）。探针以
 * `<serviceRoot>/patches/zai-glm.yml` 作为实例模型路由 patch（实例就绪链需
 * 要它；本探针虽不经模型，实例启动参数与姊妹一致）。tgz 产物结束自清；
 * 证据 JSON 每次落盘保留在 `.local/`（FAULT 路径的 tgz 与临时 home 都不
 * 清——fail() 会打印 home 路径）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const keep = args.includes('--keep');
const repo = resolve(argOf('repo') ?? process.cwd());
let home = null;
let evidence = null;
const fail = (msg) => {
  console.error(`[probe] FAULT: ${msg}\n[probe] 临时目录：${home ?? '（尚未创建）'}${keep ? '（--keep 保留）' : '（探针故障路径，请手动清理）'}`);
  try {
    if (evidence !== null) {
      mkdirSync(join(repo, '.local'), { recursive: true });
      writeFileSync(join(repo, '.local', 'probe-selected-default.json'), JSON.stringify({ ...evidence, fault: String(msg) }, null, 2));
      console.error('[probe] 已尽力落盘部分证据（本机材料目录）');
    }
  } catch { /* 故障路径的落盘失败不再掩盖原故障 */ }
  process.exit(2);
};
process.on('uncaughtException', (error) => { fail(`未捕获异常：${String(error?.stack ?? error)}`); });
process.on('unhandledRejection', (reason) => { fail(`未处理的 Promise 拒绝：${String(reason)}`); });
const serviceRootArg = argOf('service-root') ?? process.env.DSAT_SERVICE_ROOT;
if (serviceRootArg === undefined || serviceRootArg.trim() === '') fail('缺少 --service-root（或环境变量 DSAT_SERVICE_ROOT）：指向装有各宿主树的根目录');
const serviceRoot = resolve(serviceRootArg);
const hostSubdir = argOf('host-subdir') ?? 'dsh-0.2.1-rc.5';
const hostRoot = join(serviceRoot, hostSubdir);
let hostVersion;
try {
  hostVersion = JSON.parse(readFileSync(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
} catch (error) {
  fail(`无法读取宿主树版本（--service-root/--host-subdir 是否指向有效的 dsh 安装树？）：${String(error?.message ?? error)}`);
}

const log = (msg) => console.log(`[probe] ${msg}`);
const verdicts = [];
evidence = { head: null, dirty: false, hostVersion, phases: {}, verdicts };
function judge(name, ok, detail = '') {
  verdicts.push({ name, ok: ok === true, detail: String(detail).slice(0, 500) });
  console.log(`${ok === true ? 'PASS ' : 'FAIL '} ${name}${detail === '' ? '' : `  —— ${String(detail).slice(0, 240)}`}`);
}

// ── SD-0 指引在场（静态断言；先于实例——文档面与词典面不依赖运行态）──
console.log('── SD-0 指引在场（词典两语＋四份文档）──');
function readRepoText(rel) {
  try { return readFileSync(join(repo, rel), 'utf8'); } catch { return null; }
}
const clientJs = readRepoText('client.js') ?? '';
const zhDictOk = (() => {
  const m = clientJs.match(/uninstallRisk: "卸载风险[^"]*"/);
  return m !== null && m[0].includes('agent-preset/not-found') && m[0].includes('清空') && m[0].includes('可用预设') && m[0].includes('切换');
})();
const enDictOk = (() => {
  const m = clientJs.match(/uninstallRisk: "Uninstall risk[^"]*"/);
  return m !== null && m[0].includes('agent-preset/not-found') && m[0].toLowerCase().includes('clear') && m[0].includes('available preset') && m[0].toLowerCase().includes('switch');
})();
// 时机构词：首页用「停用或卸载前」、用户参考用「移除前」——三种动词形态都认
// （需求 565 的语义是「卸载前切换」，本仓文档按受众用词）。
const zhDoc = (t) => t !== null && t.includes('agent-preset/not-found') && t.includes('默认预设') && (t.includes('清空') || t.includes('重选')) && /(卸载|停用|移除)前/.test(t);
const enDoc = (t) => t !== null && t.includes('agent-preset/not-found') && t.toLowerCase().includes('default preset') && t.toLowerCase().includes('before');
judge('SD-0a 设置页词典键两语在场（含错误码与清选/重选动作）', zhDictOk && enDictOk,
  `中文 ${String(zhDictOk)}／英文 ${String(enDictOk)}（渲染与主题可读性属 GUI 面不装置）`);
judge('SD-0b 中文使用说明指引在场（首页＋用户参考）', zhDoc(readRepoText('README.md')) && zhDoc(readRepoText(join('docs', 'user-reference.md'))), '');
judge('SD-0c 英文使用说明指引在场（首页＋用户参考）', enDoc(readRepoText('README.en.md')) && enDoc(readRepoText(join('docs', 'user-reference.en.md'))), '');

// 1) 打包当前工作区（npm pack --ignore-scripts；产物落 .local/）。
mkdirSync(join(repo, '.local'), { recursive: true });
const headRun = spawnSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
const head = headRun.status === 0 ? headRun.stdout.trim() : 'unknown-head';
const dirtyRun = spawnSync('git', ['-C', repo, 'status', '--short'], { encoding: 'utf8' });
const dirty = dirtyRun.status === 0 && dirtyRun.stdout.trim() !== '' ? '（含未提交改动）' : '';
evidence.head = head;
evidence.dirty = dirty !== '';
log(`repo=${repo} head=${head}${dirty} hostRoot=${hostRoot} hostVersion=${hostVersion}`);
const packRun = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', '.local'], { cwd: repo, encoding: 'utf8', shell: true });
if (packRun.status !== 0) fail(`npm pack 退出 ${String(packRun.status)}：${packRun.stderr}`);
const tgzName = (packRun.stdout.match(/dsh-async-tools-[^\s]+\.tgz/g) ?? []).pop();
if (tgzName === undefined) fail('npm pack 未产出 dsh-async-tools tgz');
const tgzPath = join(repo, '.local', tgzName);
log(`tgz=${tgzName}`);

// 2) 独立 DSH_HOME＋官方 CLI 安装。
home = mkdtempSync(join(tmpdir(), 'dsh-sel-def-'));
const cliBin = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const addRun = spawnSync('node', [cliBin, 'plugin', '--profile', 'web', 'add', tgzPath], {
  cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 300_000
});
if (addRun.status !== 0) fail(`plugin add 退出 ${String(addRun.status)}：stderr 尾部 ${String(addRun.stderr).slice(-600)}／stdout 尾部 ${String(addRun.stdout).slice(-600)}`);
log('plugin add 完成');

// 3) 起隔离实例（随机端口；重启可重入）。
let child = null;
let stdout = '';
let stderrTail = '';
function killChild() {
  if (child !== null && child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
  }
}
process.on('exit', () => { killChild(); });
async function startInstance() {
  stdout = '';
  stderrTail = '';
  child = spawn('node', [cliBin, '--patch', join(serviceRoot, 'patches', 'zai-glm.yml'), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: serviceRoot,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-4000); });
  const url = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => rejectUrl(new Error('实例 90s 内未就绪')), 90_000);
    const poll = setInterval(() => {
      const m = stdout.match(/https?:\/\/\S+/);
      if (m !== null) { clearTimeout(timer); clearInterval(poll); resolveUrl(m[0]); }
      if (child.exitCode !== null) { clearTimeout(timer); clearInterval(poll); rejectUrl(new Error(`实例提前退出 ${String(child.exitCode)}`)); }
    }, 200);
  }).catch((error) => { killChild(); fail(`${String(error.message)}\nstderr 尾部：\n${stderrTail}`); });
  log(`实例就绪：${url.split('?')[0]}（token 已隐去）`);
  await new Promise((r) => { setTimeout(r, 5000); });
  return url;
}
const url1 = await startInstance();

// 4) RPC 骨架（token→cookie）。
const urlMatch = url1.match(/^(https?:\/\/[^/?#]+)\/?\?token=(.+)$/);
if (urlMatch === null) { killChild(); fail(`实例 URL 形态不符：${url1.split('?')[0]}`); }
let [, ORIGIN, TOKEN] = urlMatch;
const indexResponse = await fetch(`${ORIGIN}/?token=${TOKEN}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
let COOKIE = (indexResponse.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
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
    log(`rpc ${endpoint} 首次请求失败，重试一次：${String(connError?.message ?? connError)}`);
    response = await fetch(`${ORIGIN}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body,
      signal: AbortSignal.timeout(60_000)
    });
  }
  const parsed = JSON.parse(await response.text());
  if (parsed?.result?.ok !== true) return { ok: false, error: parsed?.result?.error ?? null };
  return { ok: true, value: parsed.result.value };
}
async function rpcOk(endpoint, argsBody) {
  const r = await rpc(endpoint, argsBody);
  if (r.ok !== true) fail(`${endpoint} 调用失败：${JSON.stringify(r.error).slice(0, 200)}`);
  return r.value;
}
async function rebind(urlNext) {
  const m = urlNext.match(/^(https?:\/\/[^/?#]+)\/?\?token=(.+)$/);
  if (m === null) fail(`重启后 URL 形态不符：${urlNext.split('?')[0]}`);
  const [, originNext, tokenNext] = m;
  const res = await fetch(`${originNext}/?token=${tokenNext}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const cookieNext = (res.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
  if (cookieNext.length === 0) fail('重启后 token exchange 无 cookie');
  ORIGIN = originNext;
  TOKEN = tokenNext;
  COOKIE = cookieNext;
}

// ── SD-1 风险复现（装载可用前置＋设置写入＋卸载重启＋not-found 复现＋不自动清除）──
console.log(`\n── SD-1 风险复现（当前候选 ${head}${dirty}）──`);
const PRESET_NS = 'agent-preset-registry';
/** describe 里该 ns 的行（value 投影形状按实测兼容读：直根字段或 settings 子树）。 */
async function readPresetNs() {
  const described = await rpcOk('settings/describe', {});
  const found = (described.namespaces ?? []).find((n) => (n.ns ?? n.namespace ?? n.id) === PRESET_NS);
  if (found === undefined) return null;
  return {
    value: found.value?.settings ?? found.value ?? {},
    user: found.user?.settings ?? found.user ?? {},
    revision: found.revision ?? null
  };
}
// 装载可用前置：显式 dsh-async 会话创建成功（装载失败属判据目标方向，记 FAIL 收尾）。
const createdLoaded = await rpc('session/create', { request: { cwd: home, agentPreset: 'dsh-async' } });
if (createdLoaded.ok !== true || createdLoaded.value?.agentPreset !== 'dsh-async') {
  judge('SD-1 默认指向已撤预设时新会话被拒（not-found 形态）', false,
    `装载前置失败：${createdLoaded.ok ? `agentPreset 回落 ${String(createdLoaded.value?.agentPreset)}` : JSON.stringify(createdLoaded.error).slice(0, 160)}`);
  await shutdownAndFinish();
}
log(`装载可用（显式 dsh-async 会话 ${String(createdLoaded.value.sessionId).slice(0, 14)}…）`);
// 装载后首读：selectedDefault 不指向本包预设（「不抢默认预设」佐证）。
const nsBefore = await readPresetNs();
if (nsBefore === null) {
  judge('SD-1 默认指向已撤预设时新会话被拒（not-found 形态）', false, '装载后 describe 里无 agent-preset-registry 命名空间（宿主设置面契约漂移？）');
  await shutdownAndFinish();
}
const beforeValue = nsBefore.value?.selectedDefault;
evidence.phases.selectedDefaultBeforeWrite = { value: beforeValue ?? null, user: nsBefore.user ?? null, revision: nsBefore.revision };
judge('SD-1a 装载不改写默认预设（首读不指向本包预设）', beforeValue !== 'dsh-async' && beforeValue !== 'dsh-async-create',
  `装载后 selectedDefault=${JSON.stringify(beforeValue ?? null)}（需求 555「不抢默认预设」佐证）`);
// 经公开设置接口写 selectedDefault='dsh-async'（GUI 同链：settings/update；与 GUI
// 一致不包 settings 子树——该 ns 的 schema 是直根字段）。
const updateWrite = await rpc('settings/update', { ns: PRESET_NS, patch: { selectedDefault: 'dsh-async' } });
if (updateWrite.ok !== true) {
  judge('SD-1 默认指向已撤预设时新会话被拒（not-found 形态）', false, `写入 selectedDefault 失败：${JSON.stringify(updateWrite.error).slice(0, 160)}`);
  await shutdownAndFinish();
}
const nsWritten = await readPresetNs();
const writtenOk = nsWritten.value?.selectedDefault === 'dsh-async';
evidence.phases.selectedDefaultAfterWrite = { value: nsWritten.value?.selectedDefault ?? null, user: nsWritten.user ?? null, revision: nsWritten.revision };
judge('SD-1b 设置接口写入生效（describe 复核）', writtenOk,
  writtenOk ? `selectedDefault=dsh-async（user 层覆盖在案）` : `describe 读回 ${JSON.stringify(nsWritten.value?.selectedDefault ?? null)}`);
if (!writtenOk) await shutdownAndFinish();
// 卸载＋重启（同 DSH_HOME）。
const removeStart = Date.now();
const removeRun = spawnSync('node', [cliBin, 'plugin', '--profile', 'web', 'remove', 'dsh-async-tools'], {
  cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 300_000
});
evidence.phases.pluginRemove = {
  status: removeRun.status,
  elapsedMs: Date.now() - removeStart,
  stderrTail: String(removeRun.stderr).slice(-800)
};
log(`plugin remove 退出码 ${String(removeRun.status)}，耗时 ${String(Math.round((Date.now() - removeStart) / 1000))}s`);
if (removeRun.status !== 0) {
  judge('SD-1 默认指向已撤预设时新会话被拒（not-found 形态）', false, `plugin remove 退出 ${String(removeRun.status)}（环境形态：${String(removeRun.stderr).slice(-200)}）`);
  await shutdownAndFinish();
}
killChild();
await new Promise((r) => { setTimeout(r, 2500); });
const url2 = await startInstance();
await rebind(url2);
// 无指定预设的会话：预期被拒且形态锚定 not-found（默认预设 resolve 已撤预设、
// 不静默回落——「不能宣称宿主必自动回退」的实证方向：它真不回退）。
const createdRisk = await rpc('session/create', { request: { cwd: home } });
evidence.phases.createDefaultAfterRemove = createdRisk.ok
  ? { ok: true, agentPreset: createdRisk.value?.agentPreset ?? '?' }
  : { ok: false, error: createdRisk.error };
const riskRejected = createdRisk.ok !== true
  && String(createdRisk.error?.code ?? '') === 'agent-preset/not-found';
judge('SD-1 默认指向已撤预设时新会话被拒（not-found 形态）', riskRejected,
  riskRejected ? `可读错误（不静默回落）：${JSON.stringify(createdRisk.error).slice(0, 160)}` : `形态未锚定：${createdRisk.ok ? `create 成功且预设=${String(createdRisk.value?.agentPreset)}` : JSON.stringify(createdRisk.error).slice(0, 160)}——宿主回退了默认或形态漂移`);
// 宿主不自动清除该选择：describe 复核 selectedDefault 仍指向已撤预设。
const nsAfter = await readPresetNs();
const kept = nsAfter?.value?.selectedDefault === 'dsh-async';
evidence.phases.selectedDefaultAfterRestart = { value: nsAfter?.value?.selectedDefault ?? null, user: nsAfter?.user ?? null, revision: nsAfter?.revision };
judge('SD-1c 宿主不自动清除该选择（重启后 describe 复核）', kept,
  kept ? 'selectedDefault=dsh-async 仍在（user 覆盖层在案）——清选/重选是用户动作' : `读回 ${JSON.stringify(nsAfter?.value?.selectedDefault ?? null)}`);

// ── SD-2 重选路径（改写为宿主可用预设→默认会话恢复）──
console.log('\n── SD-2 重选路径 ──');
const updateReselect = await rpc('settings/update', { ns: PRESET_NS, patch: { selectedDefault: 'standard' } });
if (updateReselect.ok !== true) {
  judge('SD-2 重选后默认会话恢复（落 standard）', false, `写入失败：${JSON.stringify(updateReselect.error).slice(0, 160)}`);
} else {
  const nsReselect = await readPresetNs();
  const reselectRead = nsReselect.value?.selectedDefault === 'standard';
  const createdReselect = await rpc('session/create', { request: { cwd: home } });
  const recovered = createdReselect.ok === true && createdReselect.value?.agentPreset === 'standard';
  judge('SD-2 重选后默认会话恢复（落 standard）', reselectRead && recovered,
    `describe=${String(reselectRead)}／create=${createdReselect.ok ? `落 ${String(createdReselect.value?.agentPreset)}` : JSON.stringify(createdReselect.error).slice(0, 120)}`);
}

// ── SD-3 清选路径（unset 回继承层→默认会话落部署默认）──
console.log('\n── SD-3 清选路径 ──');
const unsetRun = await rpc('settings/mutate', { ns: PRESET_NS, ops: [{ op: 'unset', path: ['selectedDefault'] }] });
if (unsetRun.ok !== true) {
  judge('SD-3 清选后默认会话落部署默认', false, `unset 失败：${JSON.stringify(unsetRun.error).slice(0, 160)}`);
} else {
  const nsCleared = await readPresetNs();
  const clearedRead = (nsCleared.value?.selectedDefault ?? null) !== 'dsh-async' && (nsCleared.value?.selectedDefault ?? null) !== 'standard';
  const createdCleared = await rpc('session/create', { request: { cwd: home } });
  const presetCleared = createdCleared.ok === true ? String(createdCleared.value?.agentPreset ?? '?') : null;
  const recovered = createdCleared.ok === true && presetCleared !== '' && presetCleared !== '?' && presetCleared !== 'dsh-async';
  evidence.phases.createAfterClear = createdCleared.ok ? { agentPreset: presetCleared } : { error: createdCleared.error };
  judge('SD-3 清选后默认会话落部署默认', clearedRead && recovered,
    `describe=${JSON.stringify(nsCleared.value?.selectedDefault ?? null)}（unset 生效＝不指向探针写入值）／create=${presetCleared === null ? JSON.stringify(createdCleared.error).slice(0, 120) : `落 ${presetCleared}（部署默认，按实测记录）`}`);
}

// 7) 收尾：停实例→留证据→清理。
function finishRun() {
  try { rmSync(tgzPath, { force: true }); } catch { /* 产物清理尽力而为 */ }
  mkdirSync(join(repo, '.local'), { recursive: true });
  writeFileSync(join(repo, '.local', 'probe-selected-default.json'), JSON.stringify(evidence, null, 2));
  const failures = verdicts.filter((v) => v.ok !== true).length;
  console.log(failures === 0 ? `\n判定：全部通过（${String(verdicts.length)} 项）` : `\n判定：${String(failures)} 项 FAIL（共 ${String(verdicts.length)} 项）`);
  process.exit(failures === 0 ? 0 : 1);
}
async function shutdownAndFinish() {
  killChild();
  await new Promise((r) => { setTimeout(r, 1500); });
  if (keep) {
    log(`--keep：保留临时 home 供排查：${home}`);
  } else {
    try { rmSync(home, { recursive: true, force: true }); log(`已清理临时 home：${home}`); }
    catch { console.error(`[probe] WARN: 临时目录清理失败，留存现场：${home}`); }
  }
  log(`证据落盘：${join('.local', 'probe-selected-default.json')}（本机材料目录）`);
  finishRun();
}
await shutdownAndFinish();
