/**
 * 真机：**沙箱拒绝时，模型可见的文本里到底有没有标记与同轮提示**（R11 的核心交付之一）。
 *
 * ## 为什么必须真机、且必须现在重跑
 *
 * 子代理在真机上验过提权链路，并报了一条缺陷线索："真实沙箱拒绝时**没有**
 * `[sandbox: … denied]` 标记行。" 但时序对不上：
 *
 * | 时刻 | 事件 |
 * |---|---|
 * | 00:05:28 | nssm 重启服务（装载当时的 `lib/`） |
 * | **00:06:51** | **我改完 `lib/jobs.js`（标记与提示是这次加的）** |
 * | 00:10:25 | 子代理那次会话的转录落盘 |
 *
 * 也就是说那次会话跑的是**旧代码**——"没标记"完全可能是"功能还没部署"。
 * 这类判断不能靠时序推断结案，必须在当前代码上重跑一次同形态的现场。
 *
 * ## 判据怎么取
 *
 * 让会话执行一条**必然被沙箱拒绝**的命令（往工作区外写一个文件），
 * 然后从转录里**逐字**取出 `async_run` 的 `tool/result` 文本，查两样东西：
 * ① `[sandbox: file access denied under <mode> mode]`；② `[sandbox: escalation available …]`。
 *
 * 副作用：被拒的写在沙箱下**不会真的创建文件**；脚本不碰任何真实数据。
 *
 * 用法：node verify/probe-sandbox-marker.mjs
 */
import { dirname, join } from 'node:path';
import { instanceCredentials, loadLocalPlaneOrSkip } from '../tools/_local-config.mjs';

const localConfig = await loadLocalPlaneOrSkip('verify/probe-sandbox-marker.mjs');
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
const home = await fetch(`${BASE}${first.headers.get('location') ?? '/'}`, { headers: { cookie } });
const more = (home.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
if (more !== '') cookie = `${cookie}; ${more}`;

let rpcId = 0;
/**
 * 调一次宿主 RPC。
 *
 * @param {string} method - RPC 方法名。
 * @param {object} args - 参数。
 * @returns {Promise<object>} `result.value`。
 */
async function rpc(method, args) {
  rpcId += 1;
  const response = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `m${String(rpcId)}`, method, payload: { args } })
  });
  const body = await response.json();
  if (body.result?.ok !== true) throw new Error(`${method}: ${JSON.stringify(body.result?.error ?? body).slice(0, 200)}`);
  return body.result.value;
}

const created = await rpc('session/create', { request: {} });
const sessionId = created.sessionId;
console.log(`  会话：${sessionId}（预设 ${String(created.agentPreset)}）\n`);

// 一条必然被沙箱拒绝的命令：往工作区外写。命令本身无害（被拒就不会创建任何东西）。
//
// 「工作区外」= **仓根的上一级**，经配置派生——写死一个绝对盘符路径会让这条判据
// 换一台机器就指到不存在的位置，而"沙箱拒绝了"与"路径本来就不对"就分不清了。
const OUTSIDE = join(dirname(localConfig.workspaceDir), 'dsh-sandbox-marker-probe.txt');
await rpc('session/prompt', {
  request: {
    requestId: `marker-${String(Date.now())}`,
    sessionId,
    mode: 'queue',
    content: [{
      type: 'text',
      text: `请用 async_run 执行这条命令，不要改用别的工具，也不要加提权参数：`
        + `New-Item -ItemType File -Path '${OUTSIDE}' -Force。执行完把工具返回的内容原样告诉我。`
    }],
    clientTimeZone: 'Asia/Shanghai'
  }
});

// 轮询转录：等出现 async_run 的结果，且会话静下来。
const deadline = Date.now() + 180_000;
let text = null;
let reason = '';
while (Date.now() < deadline) {
  await new Promise((r) => { setTimeout(r, 3000); });
  const row = (await rpc('session/list', { _request: {} })).items.find((s) => s.sessionId === sessionId);
  if (row === undefined) continue;
  const page = await rpc('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 400 }
  });
  const records = page.records ?? [];
  // 最后一次 async_run 的 tool/result 文本。
  for (const record of records) {
    const content = record.event?.data?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item.type !== 'tool-result') continue;
      const blocks = Array.isArray(item.content) ? item.content : [item.content];
      const body = blocks.map((b) => (typeof b === 'string' ? b : (b?.text ?? ''))).join('');
      if (/is denied|UnauthorizedAccess|Access to the path/.test(body)) text = body;
    }
  }
  if (text !== null && row.running !== true) { reason = '拿到拒绝文本且会话已停'; break; }
  reason = `等待中：拒绝文本=${text === null ? '未出现' : '已出现'}，running=${String(row.running)}`;
}
console.log(`  轮询结束（${reason}）\n`);

if (text === null) {
  console.log('  **这次会话没有产生"被沙箱拒绝"的 tool/result**——无法判定。');
  console.log('  （可能模型改了工具、加了提权参数，或本会话的沙箱模式不是受限模式。看转录。）');
  process.exit(2);
}

console.log('  === 模型可见的拒绝文本（逐字，前 700 字符）===');
console.log(text.slice(0, 700).split('\n').map((l) => `      ${l}`).join('\n'));
console.log('');

check('拒绝真的发生了（非零退出 + 报错正文）',
  /is denied|对路径|访问被拒绝|UnauthorizedAccess|Access to the path/.test(text));
check('产出**退出状态标记** `[exit code: N]`（R11：模型必须分得清成功与失败）',
  /\[exit code: \d+\]/.test(text),
  '缺了它，模型拿到一段文本却无从判断命令成功还是失败（内置 pwsh 会给）');

// ── 沙箱拒绝标记 ────────────────────────────────────────────────────────────
//
// ## 这条判据**必须能失败**（第一版不能，独立审查 r11 的 N2 抓到了）
//
// 第一版在"报错正文被本地化"时走一条 SKIP 分支、**照样记一条成立**，于是无论
// 标记有没有产出都是 3/3——那正是本项目纪律里点名禁止的**恒真断言**：
// 它无法区分"标记真的到了模型眼前"与"标记根本没产出"。
//
// 现在的口径：**只有在文本里真的看到那两行标记才算成立**。
// 落在那条已知缺口里时如实记 **FAIL 并写明"无法判定"**，退出码非零——
// 让"没验到"长得像"没验到"，而不是像"验过且通过"。
//
// 已知缺口（登记在 `docs/requirements.md` R11）：宿主的 `DENIAL_SIGNATURES["windows-acl"]`
// 是英文子串表，若 Windows 把拒绝消息本地化，`proc.sandbox.denied` 会是 `false`。
// 这是**宿主侧**的缺口、本包不自造判定（自造会与内置 `pwsh` 产生不对称），
// 但它**不因此变成通过**——探针照实报"这一次没能证明标记会出现"。
const hasMarker = /\[sandbox: file access denied under [a-z-]+ mode\]/.test(text);
const hasHint = /\[sandbox: escalation available/.test(text);
check('产出沙箱拒绝标记 `[sandbox: file access denied under <mode> mode]`', hasMarker,
  hasMarker ? '' : '没看到这一行——若报错正文被本地化，则落在那条已登记的宿主缺口里；'
    + '无论哪种原因，**这一次都没能证明标记会出现**');
check('产出同轮提权提示 `[sandbox: escalation available …]`', hasHint,
  hasHint ? '' : '没看到这一行（模型因此看不到"原样重试一次并带提权参数"这条唯一该走的路）');

const failed = results.filter((r) => !r.ok).length;
console.log('');
console.log(`${String(results.length - failed)}/${String(results.length)} 条成立。`);
if (failed > 0) {
  console.log('');
  console.log('  说明：本探针**只在文本里真的看到标记时才算成立**。');
  console.log('  若上一条因本地化缺口而红，请把它当作"这一轮没验到"，不要当作通过——');
  console.log('  缺口本身已登记在 `docs/requirements.md` 的 R11 节。');
}
process.exitCode = failed === 0 ? 0 : 1;
