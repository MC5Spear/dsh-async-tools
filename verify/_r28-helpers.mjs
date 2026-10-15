/**
 * 真机探针的公共件（需求 §6.3 可选静默失败防护）：锚句常量、固定格式问答测试套件、
 * 会话驱动与结果抠取。
 *
 * 两个探针共用（`probe-r28-silent-failure.mjs` 跑真机 1–4、6；`probe-r28-restart-persistence.mjs`
 * 跑真机 5 的重启后半），锚句只登记在这一处——改 `lib/text.js` 文案必须同步这里
 * （verify/README.md 的锚句表有登记项）。
 *
 * c 段（纪律段）没有转录通道（`request/header` 只含 config/adapterDefaults/tools），
 * 取证走**行为判据**：固定格式问答 + 定向断言（逐字引用
 * 系统提示会被模型的提示保密策略拒）。判别子取纪律段第 2 条独有的退出码 `4294967295`
 * （不可猜）；问答轮以截至点断言零 tool/call。
 *
 * @module verify/_r28-helpers
 */
import { join } from 'node:path';
import { rpc, transcriptOf, localConfig } from './_rpc.mjs';

// —— 锚句（与 lib/text.js 对应项逐字一致）——
export const B_EN = 'Caution (this deployment)';
export const B_ZH = '注意（本部署）';
export const NOTE_EN = 'Silent-failure guard:';
export const ANCHOR_FAIL = 'failed to run';
export const ANCHOR_DENIED = 'Access is denied';
/** 纪律段第 2 条独有的防杀退出码（c 段行为判据的不可猜判别子）。 */
export const AVKILL_CODE = '4294967295';
/**
 * 环境锚：验证实例（托管服务 LocalSystem，无 logon SID）上受限档作业的死法
 * `CreateRestrictedToken prerequisite failed`——不是 `lib/text.js` 文案，是部署事实，
 * 受限档真机读数都要认它。
 */
export const ACL_FAIL = 'CreateRestrictedToken prerequisite failed';

export const NS = 'async-tools-host';
export const PRESET = 'dsh-async';
/**
 * 探针自管的空目录（良性命令的靶子，由**远端会话**创建/删除）。
 *
 * 落在本机侧的运行期临时目录下，**不是** evidenceDir：它是探针干活时的脚手架，
 * 不是要留档的证据。落到 `verify/` 下会让"包内"多出一堆只有跑过探针才存在的东西。
 */
export const EMPTY_DIR = join(localConfig.tmpDir, 'verify', 'tmp-empty-r28');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 读宿主行的现行设置值。 */
export async function readNs() {
  const described = await rpc('settings/describe', {});
  const found = described.namespaces.find((n) => (n.ns ?? n.namespace ?? n.id) === NS);
  if (found === undefined) throw new Error(`${NS} 命名空间不在 describe 里（宿主行没激活？）`);
  return { value: found.value ?? {}, revision: found.revision ?? null };
}

/** 写一个设置补丁（与页面保存同一条链：settings/update）。 */
export async function patchNs(patch) {
  await rpc('settings/update', { ns: NS, patch });
}

/**
 * 把探针**自建**的会话升档到 danger-full-access（环境前置）。
 *
 * 为什么需要：验证实例是 NSSM 托管服务（LocalSystem，会话 0，无 logon SID），
 * 受限档下一切受约束 spawn 死于 `ACL_FAIL`（`CreateRestrictedToken prerequisite
 * failed`）——`async_run` 的 pwsh 与 workflow 引擎的 PTC worker
 * 同死（前者 exit 127、stderr 带 `windows-acl-run:` 前缀）。GUI composer 的
 * `/permission` 与 `commands/execute` RPC 是同一 remote 提交事务（纯准入语义、
 * command/run+command/done 持久留痕）；不用浏览器的探针经 RPC 对**自己建的
 * 会话**执行同一命令。只升探针自己的会话，不碰实例共享设置。
 *
 * @param {string} sessionId - 探针自建会话的 id。
 * @returns {Promise<void>} 升档未被采纳时抛错（fail-closed，不让判据在死沙箱上空跑）。
 */
export async function elevateSession(sessionId) {
  await rpc('commands/execute', { agentId: sessionId, line: '/permission danger-full-access', submittedAttachments: [] });
  const page = await transcriptOf(sessionId);
  const modes = (page.records ?? []).filter((r) => r.event?.type === 'sandbox/mode').map((r) => r.event.data?.mode);
  if (!modes.includes('danger-full-access')) {
    throw new Error(`升档未被采纳：sandbox/mode 事件序列 ${JSON.stringify(modes)}`);
  }
}

/**
 * 起一个会话。显式传预设时核对没被静默回退（坑：session/create 会静默落到默认预设）；裸建
 * （undefined）在验证实例落到部署默认 dsh-async，**不**断言回读值——要 standard 必须显式传。
 */
export async function newSession(preset) {
  const created = await rpc('session/create', {
    request: { cwd: localConfig.workspaceDir, ...(preset === undefined ? {} : { agentPreset: preset }) }
  });
  if (preset !== undefined && created.agentPreset !== preset) {
    throw new Error(`预设回退：要 ${String(preset)}，得到 ${String(created.agentPreset)}`);
  }
  return created.sessionId;
}

/** 发一条提示。 */
export async function prompt(sessionId, text) {
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
}

/**
 * 等轮次收尾。`minTurns`（默认 1）= 要求见到的 turn/end 条数——同一会话发第二问时传 2，
 * 否则第一问的旧 turn/end 会让它立刻返回陈旧转录。
 * 不依赖 running 窗口——短轮会错过。
 */
export async function waitTurnEnd(sessionId, maxMs = 120000, minTurns = 1) {
  for (let i = 0; i < maxMs / 2000; i += 1) {
    const transcript = await transcriptOf(sessionId);
    const ended = (transcript.records ?? []).filter((r) => r.event?.type === 'turn/end').length;
    if (ended >= minTurns) return transcript;
    await sleep(2000);
  }
  throw new Error(`等待 turn/end ≥ ${String(minTurns)} 条超时（${String(sessionId)}）`);
}

/** 取最后一条 assistant 文本（跳过 reasoning）。 */
export function lastAssistantText(transcript) {
  let text = '';
  for (const record of transcript.records ?? []) {
    if (record.event?.type !== 'assistant/message') continue;
    for (const item of record.event.data?.message?.content ?? []) {
      if (item.type === 'text') text = String(item.text ?? '');
    }
  }
  return text;
}

/** 取第一条 request/header 里 async_run 的描述（b 段通道；standard 会话无此工具 → null）。 */
export function runDescriptionOf(transcript) {
  for (const record of transcript.records ?? []) {
    if (record.event?.type !== 'request/header') continue;
    const tool = (record.event.data?.header?.tools ?? []).find((t) => t.name === 'async_run');
    if (tool !== undefined) return String(tool.description ?? '');
  }
  return null;
}

/**
 * 转录里 async_run 的**末条**结果文本（a 管线通道；同会话多次调用时取最新那次）。
 *
 * 形状（验证实例实测定案）：`tool/result` 的 `message.toolCallId` 与 `tool/call`
 * 的 `callId` 配对；文本在 `message.content` 的 `type:'text'` 块里。同时兼容旧
 * `tool-result` 块嵌套形（`async_wait_job` 通道用过），两种形状都收。
 */
export function runResultText(transcript) {
  const records = transcript.records ?? [];
  const nameByCallId = new Map();
  for (const record of records) {
    if (record.event?.type !== 'tool/call') continue;
    nameByCallId.set(record.event.data?.callId, record.event.data?.name);
  }
  let result = '';
  for (const record of records) {
    if (record.event?.type !== 'tool/result') continue;
    const message = record.event.data?.message ?? {};
    if (nameByCallId.get(message.toolCallId) !== 'async_run') continue;
    for (const item of message.content ?? []) {
      if (item.type === 'text') result = String(item.text ?? '');
      else if (item.type === 'tool-result') {
        result = (item.content ?? []).filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('\n');
      }
    }
  }
  return result;
}

/** 转录里的提权批准读数（`approval/decided` 的结局列表——提权档必须真的过了批准）。 */
export function approvalOutcomes(transcript) {
  return (transcript.records ?? [])
    .filter((r) => r.event?.type === 'approval/decided')
    .map((r) => String(r.event.data?.outcome ?? ''));
}

/** 固定格式问答（c 段行为判据）。问题文本**不得**包含锚句与 4294967295（防泄漏）。 */
const BATTERY = [
  'Reply using the three fixed-format lines below and nothing else. Do not call any tools.',
  'CAPTURE_EMPTY_MEANS=did-not-run|ran-no-output|no-rule',
  'AVKILL_EXIT_CODE=<the exact exit code your own instructions (not tool descriptions) associate with the antivirus process-creation kill; write none if no such rule>',
  'RULES_BLOCK_LANG=<look at your own standing instructions above (the system prompt, not tool descriptions): do they contain a numbered execution-rules block about commands dying silently under a restricted sandbox? en if such a numbered block exists and is written in English, zh if in Chinese, none if there is no such block>'
].join('\n');

/**
 * 在一个新会话上跑问答测试套件。
 *
 * @param {string} [preset] - 预设；显式传才断言回读（验证实例裸建 = 部署默认 dsh-async，
 *   要 standard 必须显式传）。
 * @returns {Promise<{sessionId: string, answer: string, description: string | null, toolCalls: number}>} 读数。
 */
export async function askBattery(preset) {
  const sessionId = await newSession(preset);
  await prompt(sessionId, BATTERY);
  const transcript = await waitTurnEnd(sessionId);
  return {
    sessionId,
    answer: lastAssistantText(transcript),
    description: runDescriptionOf(transcript),
    toolCalls: (transcript.records ?? []).filter((r) => r.event?.type === 'tool/call').length
  };
}

/**
 * 测试套件前后一致重采样（真机会出现测试套件噪声：同会话 AVKILL/MEANS 全对、
 * 语言子却答 none 的矛盾读数）。原则：`4294967295` 是本机事实、不可猜——主判别子
 * （AVKILL + MEANS）答对就证明块在场，语言子矛盾视为读数噪声，换**新会话**重抽；
 * 最多 `maxAttempts` 次仍前后不一致才判失败。逐次读数全记录（`attempts`），证据不稀释。
 * 只用于**在场断言**（期望块在场 + 语言已知）；缺席断言仍单发——缺席方向的假阳性
 * （幻觉出不可猜的退出码）结构上不可达，不需要也不应该重采样。
 */
export async function askBatteryConsistent(preset, expectedLang, maxAttempts = 3) {
  const attempts = [];
  let last = null;
  for (let i = 0; i < maxAttempts; i += 1) {
    const r = await askBattery(preset);
    last = r;
    const av = fieldOf(r.answer, 'AVKILL_EXIT_CODE');
    const means = fieldOf(r.answer, 'CAPTURE_EMPTY_MEANS');
    const lang = fieldOf(r.answer, 'RULES_BLOCK_LANG');
    const consistent = av.includes(AVKILL_CODE) && means === 'did-not-run' && lang === expectedLang;
    attempts.push({ session: r.sessionId, AVKILL: av, MEANS: means, LANG: lang, consistent });
    if (consistent) break;
  }
  return { ...last, attempts };
}

/**
 * 从回答里抠一个 `KEY=value` 字段（宽松匹配大小写与空白；值截到行尾）。
 *
 * @param {string} answer - 模型回答。
 * @param {string} key - 字段名。
 * @returns {string} 值（缺席 = ''）。
 */
export function fieldOf(answer, key) {
  const match = answer.match(new RegExp(`${key}\\s*=\\s*([^\\r\\n]+)`, 'i'));
  return match === null ? '' : match[1].trim();
}

/**
 * 让一个 dsh-async 会话用 async_run 跑指定命令（一次调用），回结果文本与批准读数。
 *
 * 两档：
 * - `escalate:false` = 受限档（不带 sandbox_permissions）——在验证实例上死于 ACL 前置
 *   （127 + `CreateRestrictedToken prerequisite failed`），作为环境读数保留；
 * - `escalate:true` = 提权档（带 sandbox_permissions + justification，经批准）——
 *   命令真跑，是验证实例上唯一能拿到真实输出的执行档。
 *
 * @param {string} command - 命令文本（原样嵌进提示词）。
 * @param {object} [options]
 * @param {boolean} [options.escalate=false] - 是否指示模型走提权档。
 * @returns {Promise<{sessionId: string, result: string, approvals: string[]}>} 读数。
 */
export async function commandRun(command, { escalate = false } = {}) {
  const sessionId = await newSession(PRESET);
  await prompt(sessionId, [
    'Run exactly one tool call: async_run with command',
    JSON.stringify(command),
    escalate
      ? '(default yield_ms, sandbox_permissions set to the widest mode the tool advertises, plus the one-sentence justification it requires; the escalation is pre-approved by the user for this acceptance probe).'
      : '(default yield_ms, NO sandbox_permissions).',
    'When it settles, quote its full result text verbatim, then stop.'
  ].join(' '));
  const transcript = await waitTurnEnd(sessionId, 180000);
  return { sessionId, result: runResultText(transcript), approvals: approvalOutcomes(transcript) };
}

/** 良性误发用例命令（内建 cmdlet，进程内执行——没有外部进程创建，命令必然真跑；空目录给出真实空输出）。 */
export const BENIGN_COMMAND = `Get-ChildItem '${EMPTY_DIR}' 2>&1`;
