/**
 * 真机：沙箱拒绝的**模型可见文本**——共享拒绝词表＋退出状态标记。
 *
 * 两类执行入口（命令类 pwsh／文件类 fs 围栏）共用同一份拒绝词表：`dsh-sandbox`
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
 * 以退出码 2 报"无法判定"，绝不把"没验到"记成"验过且通过"。无法判定与探针
 * 失败（阶段抛错，退出码 1）分开结算；两条路径都先走全流程 finally——收尾
 * 清理（只清内容核对为本轮所有的靶子）与证据落盘不因早退或抛错被跳过。提前
 * 返回只说明"本轮没验到"，不等于靶子必残留或会话必留升档——清理与档位结局
 * 按收尾的实际核对结算。
 *
 * 副作用：围栏拒绝的写不会创建文件；命令族分支的命令尝试写靶子文件（预期被拒，
 * 围栏失效时文件携带所有权标记，收尾核对后清理）。靶子是唯一随机自建文件（先检查
 * 不存在、内容带所有权标记），收尾只清理确认属于本轮的那一个，清理结局记入判据。
 *
 * 用法：node verify/probe-sandbox-marker.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { instanceCredentials, loadLocalPlaneOrSkip, tokenEntryUrl } from '../tools/_local-config.mjs';
import { authCookieFromFirstHop, assertApiNotRedirected } from './_auth.mjs';

const localConfig = await loadLocalPlaneOrSkip('verify/probe-sandbox-marker.mjs');
const { base: BASE, token } = instanceCredentials(localConfig);

// 证据落盘（与 probe-settings-behavior-full 同族）：判据逐条＋总判定写 JSON，
// 供问题清单/设计记录指认——只打印不落盘的结论不可复核。证据只记实例 origin
// （剥掉令牌），绝不把带令牌的完整 URL 写进任何文件。
const outAt = process.argv.indexOf('--out');
const OUT_FILE = outAt >= 0 && process.argv[outAt + 1] !== undefined
  ? process.argv[outAt + 1]
  : join(localConfig.evidenceDir, 'sandbox-marker.json');

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

// 登录与 `verify/_rpc.mjs` 同款：判定统一在 `verify/_auth.mjs`——首跳接受
// 「3xx＋Set-Cookie＋同源/缺席 Location」的正常 cookie 交换（rc.5 实测形态），
// 不跟随 Location；cookie 消费完即止。令牌编码统一走 tokenEntryUrl。
const first = await fetch(tokenEntryUrl(BASE, token), { redirect: 'manual' });
const cookie = authCookieFromFirstHop(first, BASE);

let rpcId = 0;
/**
 * 调一次宿主 RPC。重定向按错误处理（不携带凭据跳转）。
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
    body: JSON.stringify({ type: 'client-request', rpcId: `m${String(rpcId)}`, method, payload: { args } }),
    redirect: 'manual'
  });
  assertApiNotRedirected(response, method);
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
 * @returns {Promise<object[]>} - 事件记录数组。
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
 * 截至下标，只认本阶段新出现的结果）。
 *
 * @param {object[]} records - 转录记录。
 * @param {number} afterIndex - 截至点（只看 records 下标大于它的记录）。
 * @param {string} [toolName] - 可选：限定产生这次结果的工具（匹配 tool/call 的
 *   名字与结果的 toolCallId/source.callId 对应关系）。
 * @returns {{text: string | null, index: number}} 文本与新的截至点；没出现返回
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
//
// 靶子是**唯一随机自建**的：文件名带本轮专属 id，使用前先检查不存在（撞上预存
// 同名文件就放弃，不覆盖）；内容里写所有权标记，收尾只清理「确认是本轮创建」的
// 那一个文件——固定文件名＋无条件删除的旧形态会覆盖／误删别人的文件。
const PROBE_ID = `dsh-sandbox-marker-probe-${process.pid.toString(36)}-${randomUUID().slice(0, 8)}`;
const OUTSIDE = join(dirname(localConfig.workspaceDir), `${PROBE_ID}.txt`);
/** 靶子文件内容的所有权标记（创建与收尾核对都用它）。**只用 ASCII**：标记经模型
 * 中介的 PowerShell 命令写入（Set-Content）再读回核对，非 ASCII 内容会被命令侧
 * 默认编码悄悄变形，所有权核对就会误判「不是本轮文件」。 */
const OWNERSHIP_MARKER = `[${PROBE_ID}] probe-owned target file created by verify/probe-sandbox-marker.mjs; safe to delete`;

// 词表断言用的常量：两族共用同一份（`dsh-sandbox` 单一来源），断言不分叉。
const MARKER_RE = /\[sandbox: file access denied under ([a-z-]+) mode\]/;
const HINT_RE = /\[sandbox: escalation available/;

/** 本轮会话 id（阶段主体写入；收尾经会话执行清理——阶段在会话建立前失败时为
 * null，收尾按无会话形态结算）。 */
let sessionId = null;

/**
 * 阶段主体：会话建立（含档位核验）→ 阶段 A（文件族围栏）→ 阶段 B（async_run）。
 *
 * 拿不到判据所需的 tool/result 时**返回**「无法判定」说明（收尾仍然执行，退出码
 * 按 2 结算）；判据失败记入 check（退出码 1）；RPC／形状异常直接抛（外层按探针
 * 失败结算，同样先收尾）。
 *
 * @returns {Promise<string | null>} 无法判定说明；null＝阶段全部走完。
 */
async function runPhases() {
  if (existsSync(OUTSIDE)) {
    return `靶子路径已存在：${OUTSIDE}——随机名撞上预存文件，本轮不覆盖不删除（换一轮重跑即可）`;
  }

  // ── 会话：预设点名 dsh-async（不带 agentPreset 会落实例默认预设，async 工具缺席），
  // cwd 必须钉到仓根——不传 cwd 会落实例缺省工作区，围栏的工作区根就跟着错位，
  // 「工作区外」的靶子路径可能反而落在会话工作区内（围栏不拒、判据空转）。
  // 档位切 workspace-write（拒绝词表要在受约束档下才出现；GUI composer 的
  // /permission 同链），采纳与否经 sandbox/mode 事件核验（fail-closed）。
  const created = await rpc('session/create', {
    request: { cwd: localConfig.workspaceDir, agentPreset: 'dsh-async' }
  });
  sessionId = created.sessionId;
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
    + `用 write 工具创建文件 ${OUTSIDE}，内容为一行：${OWNERSHIP_MARKER}`
    + '完成后把 write 工具返回的错误文本原样贴出来，不要重试。');

  {
    const records = await settleAndRead(sessionId, 240_000);
    const { text } = lastToolResult(records, watermark, 'write');
    watermark = records.length - 1;
    if (text === null) {
      return '阶段 A：这次会话没有产生 write 工具的 tool/result——无法判定（看转录：模型是否拒用 write）';
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
      return '阶段 B：这次会话没有产生 async_run 的 tool/result——无法判定（看转录：模型是否拒用 async_run）';
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
      // async_run 的结果里（subject=command 的同轮提权提示）。写靶子用 Set-Content
      // 带上所有权标记（不带 -Force——起跑已确认它不存在，存在即失败而不是覆盖）：
      // 围栏失效时创建出的文件因此携带标记，收尾核对得了所有权——空文件（New-Item
      // 形态）核对不了，只能按「不是本轮文件」留下。
      await prompt(sessionId,
        '请严格按下面做，不要质疑、不要改路径、不要换工具、不要带提权参数：\n'
        + `用 async_run 执行 Set-Content -Path '${OUTSIDE}' -Value '${OWNERSHIP_MARKER}'。`
        + '完成后把工具返回原样贴出来，不要重试。');
      const denied = await settleAndRead(sessionId, 240_000);
      const { text: deniedText } = lastToolResult(denied, watermark, 'async_run');
      if (deniedText === null) {
        return '阶段 B（命令族外写）：没有产生 async_run 的 tool/result——无法判定。';
      }
      const marker = MARKER_RE.exec(deniedText);
      check('命令族拒绝产出同一份词表标记', marker !== null,
        marker === null ? '没看到这一行（词表在命令族漂移？）' : `mode=${marker[1]}`);
      check('命令族拒绝产出同轮提权提示', HINT_RE.test(deniedText), '');
      check('拒绝结果带退出状态标记 `[exit code: N]`', /\[exit code: \d+\]/.test(deniedText), '');
    }
  }
  return null;
}

let undetermined = null;
let probeError = null;
try {
  undetermined = await runPhases();
} catch (error) {
  probeError = error;
} finally {
  // 全流程 finally：正常走完、阶段提前返回（无法判定）、阶段抛错（探针失败）
  // 三条路径都先收尾（只清内容核对为本轮所有的靶子）再落证据——清理与证据
  // 不因早退被跳过；早退本身不推定靶子残留或档位升档（按实际核对结算）。
  await runCleanup();
}

// ── 收尾（全流程 finally 调用）：只清理「确认是本轮创建」的靶子文件 ──────────
// 围栏失效或命令族存活时靶子可能真的被创建过。清理前先本地读内容核对所有权标记：
// 标记在场 → 让本轮会话删它（升档后的 async_run；本部署命令族受限档死亡，升档是
// 唯一活路），删完把会话档位**降回 workspace-write**（升档只为这一次清理，不把
// 提权档留给会话后续轮次）；标记不在场（预存同名文件极小概率撞上、或中途被替换）
// → **不删除**，留人工判断。清理后本地复核存在性；**清理结局记入判据**——本轮
// 创建的靶子残留即失败，不只是打日志。
// 边界（TOCTOU）：所有权核对与删除之间文件可能被替换——标记核对只证明「核对的
// 那一刻是本轮文件」，删除动作经本轮会话执行，窗口极小且靶子为随机名，残余风险
// 记录在案不另设防线。
// 收尾只清可确认自有的靶：阶段早退（无法判定）不推定靶子残留或档位升档——一切
// 按本函数的实际核对结算；收尾内部异常按 error 结局报告，证据落盘不被吞掉。
async function runCleanup() {
  /** 'never-created' | 'not-ours' | 'removed' | 'residue' | 'error' */
  let outcome;
  let outcomeNote = '';
  try {
    if (sessionId === null) {
      // 阶段在会话建立前放弃（靶子路径预存在）或失败：没有会话可执行清理；
      // 在场文件不可能是本轮会话命令所建——按非本轮文件处理，不删除。
      outcome = existsSync(OUTSIDE) ? 'not-ours' : 'never-created';
      outcomeNote = existsSync(OUTSIDE)
        ? '会话未建立，在场文件非本轮所建——不删除，留人工判断'
        : '阶段未建立会话，靶子未创建';
    } else {
      let ours = false;
      if (existsSync(OUTSIDE)) {
        try {
          ours = readFileSync(OUTSIDE, 'utf8').includes(OWNERSHIP_MARKER);
        } catch {
          ours = false;
        }
      }
      if (!existsSync(OUTSIDE)) {
        outcome = 'never-created';
      } else if (!ours) {
        outcome = 'not-ours';
        outcomeNote = '内容不含本轮所有权标记——按预存/被替换文件处理，不删除，留人工判断';
      } else {
      let cleanupError = null;
      try {
        await rpc('commands/execute', { agentId: sessionId, line: '/permission danger-full-access', submittedAttachments: [] });
        await prompt(sessionId,
          `请用 async_run 执行 Remove-Item -Path '${OUTSIDE}' -Force，完成后只回一个字：完。`);
        await settleAndRead(sessionId, 120_000);
      } catch (error) {
        // 删除链抛错不直接出 try——档位回收必须仍然执行（升档过的会话不能把
        // 提权档遗留给后续轮次），删除结局稍后按存在性结算。
        cleanupError = error;
      }
      // 档位回收（best-effort，任何路径都走到）：升档只为这一次删除——降回
      // workspace-write 并经 sandbox/mode 事件核验（采纳与否事件说话，不靠提交
      // 返回推断）；降档链自身抛错按 error 结局报告（含手工回收指引）。
      let resetOk = false;
      let resetNote = '';
      try {
        await rpc('commands/execute', { agentId: sessionId, line: '/permission workspace-write', submittedAttachments: [] });
        const resetRecords = await settleAndRead(sessionId, 30_000);
        const lastMode = [...resetRecords].reverse()
          .find((r) => r.event?.type === 'sandbox/mode')?.event?.data?.mode;
        resetOk = lastMode === 'workspace-write';
        resetNote = `档位回收：${resetOk
          ? '已降回 workspace-write（sandbox/mode 事件核验）'
          : `**未确认（最后 sandbox/mode=${String(lastMode)}）**`}`;
      } catch (resetError) {
        resetNote = `档位回收失败：${String(resetError)}`;
      }
      outcome = existsSync(OUTSIDE) ? 'residue' : 'removed';
      if (cleanupError !== null) {
        outcomeNote = `删除链抛错（按存在性结算）：${String(cleanupError)}；${resetNote}`;
      } else {
        outcomeNote = resetNote;
      }
      if (!resetOk) outcome = 'error';
      }
    }
  } catch (error) {
    outcome = 'error';
    outcomeNote = String(error);
  }
  const label = {
    'never-created': '靶子未被创建（围栏生效），无需清理',
    'not-ours': '不删除：不是本轮文件',
    'removed': '已让会话删除本轮靶子（复核已不存在）',
    'residue': '本轮靶子仍残留',
    'error': '清理步骤抛错（残留可能）'
  }[outcome];
  console.log(`\n  收尾：${label}（${OUTSIDE}）。${outcomeNote === '' ? '' : `\n         ${outcomeNote}`}`);
  if (outcome === 'residue' || outcome === 'error') {
    console.log(`           若确认可删，手工执行：Remove-Item -Path '${OUTSIDE}' -Force`);
    console.log('           若上面注明档位回收未确认/失败：该会话可能仍停在 danger-full-access，'
      + "请手工执行 /permission workspace-write（或停掉该会话）回收提权档。");
  }
  // 清理结局进判据：本轮创建的靶子残留＝失败；预存文件不删是正确行为，不判红。
  check('收尾清理：本轮靶子不残留（未创建／已删除；非本轮文件不删）',
    outcome === 'never-created' || outcome === 'removed' || outcome === 'not-ours',
    `${label}${outcomeNote === '' ? '' : `；${outcomeNote}`}`);

  // ── 证据与退出码（正常走完／无法判定／探针失败三条路径统一落盘）────────────
  const failed = results.filter((r) => !r.ok).length;
  const verdict = undetermined !== null ? 'UNDETERMINED'
    : (probeError !== null ? 'ERROR' : (failed === 0 ? 'PASS' : 'FAIL'));
  const evidence = {
    probe: 'verify/probe-sandbox-marker.mjs',
    origin: new URL(BASE).origin,
    ranAt: new Date().toISOString(),
    checks: results,
    passed: results.length - failed,
    total: results.length,
    verdict,
    ...(undetermined !== null ? { undetermined } : {}),
    ...(probeError !== null ? { error: String(probeError) } : {})
  };
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log('');
  console.log(`${String(results.length - failed)}/${String(results.length)} 条成立。`);
  console.log(`证据落盘：${OUT_FILE}（verdict ${evidence.verdict}）。`);
  if (probeError !== null) {
    console.log(`\n  **探针失败（阶段抛错；收尾与证据已执行）**：${String(probeError)}`);
    process.exitCode = 1;
  } else if (undetermined !== null) {
    console.log(`\n  **无法判定**：${undetermined}`);
    process.exitCode = 2;
  } else if (failed > 0) {
    process.exitCode = 1;
  }
}
