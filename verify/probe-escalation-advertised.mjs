/**
 * 真机：`async_run` 的单次提权字段**在真机的工具表里**到底长什么样。
 *
 * ## 为什么必须真机验
 *
 * 单测用替身构造 `sandboxMode`，因此验的是"我的代码在替身下行为正确"。
 * 而 R11 的第一道门槛是**组合层**：预设要真的挂一个**约束型**执行器
 * （`pwsh-sandbox`），`ctx.shell.sandboxMode` 才非 `undefined`，两个键才会被广告。
 * 这件事**任何替身都证明不了**——它是组合事实。
 *
 * 判据读 `request/header` 里的 `tools[]`（模型实际收到的参数表）。
 *
 * 用法：node verify/probe-escalation-advertised.mjs
 */
import { instanceCredentials, loadLocalPlaneOrSkip } from '../tools/_local-config.mjs';

const localConfig = await loadLocalPlaneOrSkip('verify/probe-escalation-advertised.mjs');
const { base: BASE, token } = instanceCredentials(localConfig);

const results = [];
/**
 * 记一条判据。
 *
 * @param {string} name - 判据名。
 * @param {boolean} ok - 是否成立。
 * @param {string} [detail] - 读数。
 */
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK    ' : 'WRONG '} ${name}${detail === '' ? '' : `\n          ${detail}`}`);
}

const first = await fetch(`${BASE}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
let cookie = (first.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
const loc = first.headers.get('location');
const home = await fetch(`${BASE}${loc ?? '/'}`, { headers: { cookie } });
const more = (home.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
if (more !== '') cookie = `${cookie}; ${more}`;

let rpcId = 0;
/**
 * 调一次宿主 RPC。
 *
 * @param {string} method - RPC 方法名。
 * @param {object} args - 参数（各方法的形状以宿主网关为准）。
 * @returns {Promise<object>} `result.value`。
 */
async function rpc(method, args) {
  rpcId += 1;
  const response = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `p${String(rpcId)}`, method, payload: { args } })
  });
  const body = await response.json();
  if (body.result?.ok !== true) throw new Error(`${method}: ${JSON.stringify(body.result?.error ?? body)}`);
  return body.result.value;
}

// 开一个会话，停在"模型已收到工具表"那一刻。
const created = await rpc('session/create', { request: {} });
const sessionId = created.sessionId ?? created.session?.sessionId ?? created.id;
console.log(`  会话：${sessionId}`);
await rpc('session/prompt', {
  request: {
    requestId: `esc-${String(Date.now())}`,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '只回一个字：好' }],
    clientTimeZone: 'Asia/Shanghai'
  }
});

// 轮询转录直到拿到 request/header。
const deadline = Date.now() + 90_000;
let header = null;
while (Date.now() < deadline && header === null) {
  await new Promise((r) => { setTimeout(r, 2500); });
  // ⚠️ `session/list` 的行在 **`items`** 里（第一版写成 `sessions`，于是永远找不到会话，
  // 表现为"没拿到 request/header"——像个超时，其实是取错了键）。
  const row = (await rpc('session/list', { _request: {} })).items.find((s) => s.sessionId === sessionId);
  if (row === undefined) continue;
  const page = await rpc('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 400 }
  });
  for (const record of page.records ?? []) {
    if (record.event?.type === 'request/header') { header = record.event.data.header; break; }
  }
}
if (header === null) {
  console.log('  **没拿到 request/header**——无法判定。');
  process.exit(2);
}

const tools = header.tools ?? [];
const run = tools.find((t) => t.name === 'async_run');
console.log(`  工具表里 ${String(tools.length)} 个工具；async_run ${run === undefined ? '**不在**' : '在'}`);
// 把工具名全列出来：判断"执行器不约束"还是"命令执行工具根本没挂"，
// 靠猜容易猜错，列一遍就能分辨。
console.log(`  全部工具名：${tools.map((t) => t.name).join(', ')}`);
if (run !== undefined) {
  const props = run.parameters?.properties ?? {};
  console.log(`  async_run 的参数键：${Object.keys(props).join(', ')}`);
  check('async_run 出现在真机工具表里', true);
  check('真机**广告了** sandbox_permissions（说明挂的是约束型执行器）',
    'sandbox_permissions' in props,
    '拿不到就说明本部署的执行器不约束，或组合层没挂 pwsh-sandbox');
  check('真机**广告了** justification', 'justification' in props);
  if ('sandbox_permissions' in props) {
    check('枚举是闭集 ESCALATION_TARGETS',
      JSON.stringify(props.sandbox_permissions.enum) === JSON.stringify(['workspace-write', 'danger-full-access']),
      JSON.stringify(props.sandbox_permissions.enum));
    check('描述写明"仅当沙箱刚拒绝过的一次性重试"',
      /one-shot retry/i.test(props.sandbox_permissions.description ?? ''),
      String(props.sandbox_permissions.description ?? '').slice(0, 90));
  }
  // 与内置 pwsh 对齐：同一种能力在同一个部署里不该只有一半工具有。
  const pwsh = tools.find((t) => t.name === 'pwsh');
  if (pwsh !== undefined) {
    const pwshProps = pwsh.parameters?.properties ?? {};
    check('内置 pwsh 也广告同样两个键（两个工具口径一致）',
      ('sandbox_permissions' in pwshProps) === ('sandbox_permissions' in props),
      `pwsh: ${Object.keys(pwshProps).join(', ')}`);
  } else {
    console.log('  （内置 pwsh 不在工具表里——本预设没挂它，跳过对齐判据）');
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log('');
console.log(`${String(results.length - failed)}/${String(results.length)} 条成立。`);
process.exitCode = failed === 0 ? 0 : 1;
