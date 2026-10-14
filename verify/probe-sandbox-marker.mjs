/**
 * 真机：沙箱拒绝的**模型可见文本**——共享拒绝词表＋退出状态标记。
 *
 * 两族执行面（命令族 pwsh／文件族 fs 围栏）共用同一份拒绝词表：`dsh-sandbox`
 * 的 `sandboxDenialMarker` 与 `escalationHintMarker` 是两族唯一来源，宿主的设计
 * 就是让模型在两种拒绝上读到逐字相同的标记。本探针按部署能真实触发的族取证：
 *
 *  1. **拒绝词表** `[sandbox: file access denied under <mode> mode]` 与
 *     `[sandbox: escalation available …]`：经**文件族围栏**触发——workspace-write
 *     会话里 `write` 工具写工作区外路径，围栏是纯路径策略检查，不经受限令牌。
 *     本验证实例是 NSSM 托管服务（LocalSystem、无登录 SID），受限令牌 runner
 *     在进程创建层死亡（`CreateRestrictedToken prerequisite failed`，与受限档
 *     spawn 必死同源），
 *     **命令族策略拒绝在本部署不可触发**——词表的真实性由文件族围栏承担。
 *  2. **退出状态标记** `[exit code: N]`：async_run 的失败结果必须让模型分得清
 *     成败——包括 runner 死亡形态（exit 127 也是可解码的失败，不是空文本）。
 *
 * 命令族 runner 存活的部署上（交互实例），探针会追做命令族外写命令并断言
 * 同一份词表落在 async_run 的结果里——两条路径共用判据常量，词表断言不分叉。
 *
 * 判据全部来自**真实转录的 tool/result**，不模拟、不空转：拿不到对应结果就
 * 以退出码 2 报"无法判定"，绝不把"没验到"记成"验过且通过"。
 *
 * 副作用：围栏拒绝的写不会创建文件；命令族分支的命令只写标准输出。
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

// 登录与 `verify/_rpc.mjs` 同款：token 换 cookie 一跳（redirect:'manual'），
// **不追 Location**——相对重定向 `.` 拼进基址会得到 `http://…/./` 形态的坏 URL，
// 且现行宿主在首跳就下发全部会话 cookie。
const first = await fetch(`${BASE}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
const cookie = (first.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
if (cookie.length === 0) throw new Error('token exchange returned no cookie');

let rpcId = 0;
/**
 * 调一次宿主 RPC。
 *
 * @param {string} method - RPC 方法名。
 * @param {object} args - 参数。
 * @returns {Promise<any>} `result.value`。
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

/**
 * 发一条提示（queue 模式）。
 *
 * @param {string} sessionId - 会话 id。
 * @param {string} text - 正文。
 * @returns {Promise<void>} 提交被接受。
 */
async function prompt(sessionId, text) {
  await rpc('session/prompt', {
    request: {
      requestId: `marker-${String(Date.now())}-${String(rpcId)}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
}

/**
 * 等会话静下来并取整个转录。
 *
 * @param {string} sessionId - 会话 id。
 * @param {number} timeoutMs - 轮询上限。
 * @returns {Promise<object[]> - 事件记录数组。
 */
async function settleAndRead(sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let page = null;
  while (Date.now() < deadline) {
    await new Promise((r) => { setTimeout(r, 3000); });
    const row = (await rpc('session/list', { _request: {} })).items.find((s) => s.sessionId === sessionId);
    if (row === undefined) continue;
    page = await rpc('session/page', {
      request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 400 }
    });
    if (row.running !== true) break;
  }
  return page?.records ?? [];
}

/**
 * 从转录里取**指定下标之后**最后一次 tool/result 文本（轮次隔离：每阶段一个
 * 水位下标，只认本阶段新出现的结果）。
 *
 * @param {object[]} records - 转录记录。
 * @param {number} afterIndex - 水位（只看 records 下标大于它的记录）。
 * @param {string} [toolName] - 可选：限定产生这次结果的工具（匹配 tool/call 的
 *   名字与结果的 toolCallId/source.callId 对应关系）。
 * @returns {{text: string | null, index: number}} 文本与新的水位；没出现返回
 *   `{ text: null, index: records.length }`。
 */
function lastToolResult(records, afterIndex, toolName) {
  // tool/call 的 callId → 工具名（字段形状以转录实测为准：名字在 data.name，
  // 调用号在 data.callId；结果侧在 message.toolCallId / message.source.callId）。
  const callTool = new Map();
  records.forEach((record, index) => {
    if (index <= afterIndex || record.event?.type !== 'tool/call') return;
    const data = record.event.data;
    if (typeof data?.callId === 'string' && typeof data?.name === 'string') callTool.set(data.callId, data.name);
  });
  let text = null;
  let watermark = afterIndex;
  records.forEach((record, index) => {
    if (index <= afterIndex) return;
    const message = record.event?.data?.message;
    const content = message?.content;
    if (!Array.isArray(content)) return;
    const callId = message?.toolCallId ?? message?.source?.callId;
    if (toolName !== undefined && callTool.size > 0 && callTool.get(callId) !== toolName) return;
    const body = content.map((item) => {
      if (typeof item.text === 'string') return item.text;
      const blocks = Array.isArray(item.content) ? item.content : [item.content];
      return blocks.map((b) => (typeof b === 'string' ? b : (b?.text ?? ''))).join('');
    }).join('');
    if (body.length > 0) {
      text = body;
      watermark = index;
    }
  });
  return { text, index: watermark };
}

// 「工作区外」＝仓根的上一级，经配置派生——写死绝对盘符路径会让判据换机就指向
// 不存在的位置，"围栏拒绝了"与"路径本来就不对"就分不清了。
const OUTSIDE = join(dirname(localConfig.workspaceDir), 'dsh-sandbox-marker-probe.txt');

// 词表断言用的常量：两族共用同一份（`dsh-sandbox` 单一来源），断言不分叉。
const MARKER_RE = /\[sandbox: file access denied under ([a-z-]+) mode\]/;
const HINT_RE = /\[sandbox: escalation available/;

// ── 会话：预设点名 dsh-async（不带 agentPreset 会落实例默认预设，async 工具缺席），
// cwd 必须钉到仓根——不传 cwd 会落实例缺省工作区，围栏的工作区根就跟着错位，
// 「工作区外」的靶子路径可能反而落在会话工作区内（围栏不拒、判据空转）。
// 档位切 workspace-write（拒绝词表要在受约束档下才出现；GUI composer 的
// /permission 同链），采纳与否经 sandbox/mode 事件核验（fail-closed）。
const created = await rpc('session/create', {
  request: { cwd: localConfig.workspaceDir, agentPreset: 'dsh-async' }
});
const sessionId = created.sessionId;
if (created.agentPreset !== 'dsh-async') {
  throw new Error(`预设回退：要 dsh-async，得到 ${String(created.agentPreset)}`);
}
console.log(`  会话：${sessionId}（预设 ${String(created.agentPreset)}，cwd=${localConfig.workspaceDir}）\n`);

let watermark = -1;
await rpc('commands/execute', { agentId: sessionId, line: '/permission workspace-write', submittedAttachments: [] });
{
  const records = await settleAndRead(sessionId, 30_000);
  watermark = records.length - 1;
  const modes = records
    .filter((r) => r.event?.type === 'sandbox/mode').map((r) => r.event.data?.mode);
  if (!modes.includes('workspace-write')) {
    throw new Error(`档位切换未被采纳：sandbox/mode 事件序列 ${JSON.stringify(modes)}`);
  }
}
console.log('  会话档位：workspace-write（经 sandbox/mode 事件核验）');

// ── 阶段 A：文件族围栏的真实拒绝（词表 ①② 的载体） ──────────────────────────
await prompt(sessionId,
  '请严格按下面做，不要质疑、不要改路径、不要换工具、不要带 sandbox_permissions 或 justification 参数：\n'
  + `用 write 工具创建文件 ${OUTSIDE}，内容为 probe。`
  + '完成后把 write 工具返回的错误文本原样贴出来，不要重试。');

{
  const records = await settleAndRead(sessionId, 240_000);
  const { text } = lastToolResult(records, watermark, 'write');
  watermark = records.length - 1;
  if (text === null) {
    console.log('  **这次会话没有产生 write 工具的 tool/result**——无法判定（看转录：模型是否拒用 write）。');
    process.exit(2);
  }
  console.log('  === write 工具的拒绝文本（逐字，前 500 字符）===');
  console.log(text.slice(0, 500).split('\n').map((l) => `      ${l}`).join('\n'));
  console.log('');
  const marker = MARKER_RE.exec(text);
  check('围栏拒绝产出词表标记 `[sandbox: file access denied under <mode> mode]`', marker !== null,
    marker === null ? '没看到这一行——围栏没拒或词表漂移' : `mode=${marker[1]}`);
  check('围栏拒绝产出同轮提权提示 `[sandbox: escalation available …]`', HINT_RE.test(text),
    HINT_RE.test(text) ? '' : '没看到这一行（模型因此看不到"原样重试一次并带提权参数"这条唯一该走的路）');
}

// ── 阶段 B：async_run 的退出状态标记（含 runner 死亡形态） ────────────────────
await prompt(sessionId,
  '请严格按下面做：用 async_run 执行 `Write-Output SANDBOX_MARKER_ALIVE`，'
  + '不要传提权参数。完成后把工具返回原样贴出来，不要重试。');

{
  const records = await settleAndRead(sessionId, 240_000);
  const { text } = lastToolResult(records, watermark, 'async_run');
  watermark = records.length - 1;
  if (text === null) {
    console.log('  **这次会话没有产生 async_run 的 tool/result**——无法判定。');
    process.exit(2);
  }
  console.log('  === async_run 的返回（逐字，前 500 字符）===');
  console.log(text.slice(0, 500).split('\n').map((l) => `      ${l}`).join('\n'));
  console.log('');
  const runnerDead = /windows-acl-run: .*CreateRestrictedToken/.test(text);
  if (runnerDead) {
    console.log('  环境事实：受限令牌 runner 在本部署死亡（NSSM LocalSystem、无登录 SID）——命令族策略拒绝不可触发，词表已由文件族围栏验证。\n');
    check('runner 死亡仍是可解码的失败（`[exit code: N]` 在场，不是空文本）',
      /\[exit code: \d+\]/.test(text),
      /\[exit code: \d+\]/.test(text) ? '' : '缺了它，模型拿到一段文本却无从判断命令成功还是失败');
  } else {
    // 命令族 runner 存活的部署（交互实例）：追做命令族外写，断言同一份词表落在
    // async_run 的结果里（subject=command 的同轮提权提示）。
    await prompt(sessionId,
      '请严格按下面做，不要质疑、不要改路径、不要换工具、不要带提权参数：\n'
      + `用 async_run 执行 New-Item -ItemType File -Path '${OUTSIDE}' -Force。`
      + '完成后把工具返回原样贴出来，不要重试。');
    const denied = await settleAndRead(sessionId, 240_000);
    const { text: deniedText } = lastToolResult(denied, watermark, 'async_run');
    if (deniedText === null) {
      console.log('  **命令族外写没有产生 async_run 的 tool/result**——无法判定。');
      process.exit(2);
    }
    const marker = MARKER_RE.exec(deniedText);
    check('命令族拒绝产出同一份词表标记', marker !== null,
      marker === null ? '没看到这一行（词表在命令族漂移？）' : `mode=${marker[1]}`);
    check('命令族拒绝产出同轮提权提示', HINT_RE.test(deniedText), '');
    check('拒绝结果带退出状态标记 `[exit code: N]`', /\[exit code: \d+\]/.test(deniedText), '');
  }
}

// ── 收尾：清掉靶子文件（围栏失效或命令族存活时它可能真的被创建过）。清理走
// 本会话升档后的 async_run（命令族在本部署受限档死亡，升档是唯一活路）；
// `-ErrorAction SilentlyContinue` 让"本来就不存在"也安静通过。
try {
  await rpc('commands/execute', { agentId: sessionId, line: '/permission danger-full-access', submittedAttachments: [] });
  await prompt(sessionId,
    `请用 async_run 执行 Remove-Item -Path '${OUTSIDE}' -Force -ErrorAction SilentlyContinue，完成后只回一个字：完。`);
  await settleAndRead(sessionId, 120_000);
  console.log(`\n  收尾：已清理靶子文件 ${OUTSIDE}。`);
} catch (error) {
  console.log(`\n  收尾清理失败：${String(error)}——靶子文件可能残留（${OUTSIDE}，内容 probe）。`);
}

const failed = results.filter((r) => !r.ok).length;
console.log('');
console.log(`${String(results.length - failed)}/${String(results.length)} 条成立。`);
if (failed > 0) {
  console.log('');
  process.exitCode = 1;
}
