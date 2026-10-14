/**
 * 守哪条需求：需求 §3.2 可见性与隔离——「使用者可在自建预设按工具选择挂载」。
 *
 * ## 证明的是哪一句
 *
 * 需求 §3.2 明写：「工具行只在挂载它们的预设范围内注册」且「使用者可在自建预设
 * 按工具选择挂载」——`dsh-async` 预设只是替使用者把四行写好的默认模板，
 * 本包不提供"只在某个预设里可见"的机制。
 *
 * ## 为什么必须有这条反向证据
 *
 * 其余证据都只在**一个方向**上说事：
 *
 * | 已有判据 | 它说的 |
 * |---|---|
 * | 本包预设里四个工具都在 | 本包的预设里有这四个工具 |
 * | standard 里不出现 | 本包**没有**把它们强行装到所有预设 |
 *
 * 两条合起来**证明不了**"别处也能有"。只靠这两条，一个"把工具**锁死在**本预设里"的
 * 实现同样能全绿——而那正好与 §3.2 相悖。
 *
 * ⇒ 本探针在**另一个预设 id** 下挂同样的四行，断言工具出现。
 * 这才是"预设是模板、不是限制"的证据。
 *
 * ## 它做什么
 *
 * 1. 在可写预设根下建一个**临时**预设 `dsh-async-portability-probe`（复制已部署那份，
 *    只改 `id` 与 `preset.yml` 的 `name`/`order`）；
 * 2. 用它开一个会话，从真实 `request/header` 读工具清单；
 * 3. 断言四个工具都在（若本插件真的"只在某个预设里可见"，这里必然缺失）；
 * 4. **无论成败都删掉那个临时预设目录**，并复核删干净了。
 *
 * ⚠️ 只碰它自己建的那个目录：目录名是固定常量，删除前会核对**里面确实只有本探针写的文件**。
 * ⚠️ 用法：node verify/probe-preset-portability.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { instanceCredentials, loadLocalPlaneOrSkip } from '../tools/_local-config.mjs';

const localConfig = await loadLocalPlaneOrSkip('verify/probe-preset-portability.mjs');
const { base: BASE, token } = instanceCredentials(localConfig);
const CWD = localConfig.workspaceDir;
/** **本探针自己的**预设 id——绝不复用、绝不删除已部署的 `dsh-async`。 */
const PROBE_ID = 'dsh-async-portability-probe';
const PRESETS_ROOT = join(homedir(), '.dsh', '.agent-presets');
const PROBE_DIR = join(PRESETS_ROOT, PROBE_ID);
const SOURCE_DIR = join(PRESETS_ROOT, 'dsh-async');

const checks = [];
/**
 * 记一条判据。
 *
 * @param {string} name - 判据名。
 * @param {boolean} ok - 是否成立。
 * @param {string} [detail] - 读数。
 */
function record(name, ok, detail = '') {
  checks.push({ name, ok });
  console.log(`  ${ok ? 'OK    ' : 'WRONG '} ${name}${detail === '' ? '' : `\n          ${detail}`}`);
}

const indexResponse = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' });
const cookie = (indexResponse.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');

/**
 * 发一次信封 RPC。
 *
 * @param {string} method - 方法名。
 * @param {object} args - 参数。
 * @returns {Promise<any>} `result.value`。
 */
async function rpc(method, args) {
  const rpcId = `pp-${Math.random().toString(36).slice(2, 8)}`;
  const response = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
  });
  const body = JSON.parse(await response.text());
  if (body?.result?.ok !== true) throw new Error(`${method}: ${JSON.stringify(body?.result?.error).slice(0, 200)}`);
  return body.result.value;
}

// ── 建临时预设 ──────────────────────────────────────────────────────────────
if (existsSync(PROBE_DIR)) {
  console.log(`**${PROBE_DIR} 已存在**——上一次没清干净。先手工确认它不是你要的东西再删。`);
  process.exit(2);
}
const source = readFileSync(`${SOURCE_DIR}\\agent.cordis.yml`, 'utf8');
if (!source.includes('toolName: async_run')) {
  console.log('**源预设里没有本包的工具行**——拿它复制证明不了任何事，本探针失效。');
  process.exit(2);
}
// ⚠️ 预设 id **就是目录名**，`agent.cordis.yml` 里没有 id 字段（组合文件里改
// `^id:` 永远匹配不到；探针目录若与 dsh-async 同名，实验证明的东西就是空的）。
// ⇒ 复制组合文件原样即可；id 由下面的目录名给出。
mkdirSync(PROBE_DIR, { recursive: true });
writeFileSync(`${PROBE_DIR}\\agent.cordis.yml`, source, 'utf8');
writeFileSync(`${PROBE_DIR}\\preset.yml`,
  `name: 可移植性探针\n`
  + `description: 临时预设，只用来证明"工具随挂载它的那一行生效，不限于 dsh-async 预设"。用完即删。\n`
  + 'order: 99\n', 'utf8');
console.log(`临时预设已建：${PROBE_DIR}（id 取自目录名）`);
console.log('');

let failed = 0;
try {
  const created = await rpc('session/create', { request: { cwd: CWD, agentPreset: PROBE_ID } });
  const sessionId = created.sessionId ?? created.id;
  record(`能用**另一个预设 id**（\`${PROBE_ID}\`）开会话（不是回退到 dsh-async）`,
    created.agentPreset === PROBE_ID,
    `实得 agentPreset=${String(created.agentPreset)}`);

  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: '回复一个句号即可，不要调用任何工具。' }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });

  // 等转录稳定（连续两拍记录条数相同）——同 `probe-settings-behavior-full` 的取样纪律。
  //
  // ⚠️ `session/page` 的 args 形状是
  // `{ request: { address: { kind:'session', sessionId }, throughSeq, maxMessages } }`——
  // 少 `address`、少 `throughSeq` 都会被网关直接拒绝：
  // `wire field "request" failed boundary validation`。
  // **形状错就是实证错误，不会静默**：它没有"看起来跑过了"的中间态。
  const rowOf = async () => {
    const listing = await rpc('session/list', { _request: {} });
    return listing.items.find((item) => item.sessionId === sessionId);
  };
  const pageOf = async () => {
    const row = await rowOf();
    return rpc('session/page', {
      request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 400 }
    });
  };
  let stable = 0;
  let lastCount = -1;
  const started = Date.now();
  for (;;) {
    const page = await pageOf();
    const count = (page.records ?? []).length;
    if (count === lastCount) stable += 1; else stable = 0;
    lastCount = count;
    const done = (page.records ?? []).some((r) => r.event?.type === 'request/header');
    if (done && stable >= 2) break;
    if (Date.now() - started > 120000) break;
    await new Promise((resolve) => { setTimeout(resolve, 1500); });
  }

  const page = await pageOf();
  const tools = page.records
    .filter((r) => r.event?.type === 'request/header')
    .flatMap((r) => r.event.data?.header?.tools ?? [])
    .map((t) => t?.name);
  const ours = ['async_run', 'async_wait_job', 'async_wait_agent', 'async_agent'];
  const present = ours.filter((n) => tools.includes(n));
  record('四个工具在**另一个预设**下也出现（"不限于本预设"）',
    present.length === 4,
    `实得 ${JSON.stringify(present)}；该预设工具数 ${String(tools.length)}`);
  failed = checks.filter((c) => !c.ok).length;
} finally {
  // ── 清理：只删**本探针自己建的**那个目录，且先核对里面只有本探针写的文件 ──
  const expected = ['agent.cordis.yml', 'preset.yml'];
  const actual = existsSync(PROBE_DIR) ? readdirSync(PROBE_DIR).sort() : [];
  const onlyOurs = actual.length === expected.length && expected.every((n, i) => actual[i] === n);
  if (!onlyOurs) {
    console.log(`**不删**：${PROBE_DIR} 里的内容是 ${JSON.stringify(actual)}，与预期不符——留给人工判断。`);
    failed += 1;
  } else {
    rmSync(PROBE_DIR, { recursive: true, force: true });
    console.log('');
    console.log(`清理：${PROBE_DIR} 已删除（复核：${existsSync(PROBE_DIR) ? '**仍在**' : '不存在'}）`);
    if (existsSync(PROBE_DIR)) failed += 1;
  }
}

console.log('');
console.log(`${String(checks.length - failed)}/${String(checks.length)} 条成立。`);
process.exitCode = failed === 0 ? 0 : 1;
