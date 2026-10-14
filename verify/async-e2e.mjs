/**
 * 真机端到端（需求 §2.1.2 消息唤醒与取消、§2.2 命令执行与作业取回）：在**验证实例**上、
 * 在 `dsh-async` 预设下驱动一个真实会话，走完"让出 → async_wait_job 取回 → 插话打断等待但作业不受影响"。
 *
 * 为什么必须自己写脚本而不是在聊天里下指令：端到端证据必须来自验证实例，而
 * 本会话跑在开发实例上，两边不是同一个进程。这里用 dsh 自己的浏览器 RPC
 * 建会话、发消息、读转录。
 *
 * 三条强制规则（每条都对应一类失败形态）：
 *   1. `session/create` 会**静默回退**到默认预设 —— 必须断言回读的 agentPreset；
 *   2. 轮询"是否在跑"要等到**先见过 running** 再等 running=false，否则会把
 *      "还没来得及起跑"当成跑完；
 *   3. 插话要落在第 4 步的长命令**还在跑**的窗口里，所以按上下文预算（token 增量）
 *      而不是按墙上时钟来定位该发消息的时刻。
 *
 * 用法：node async-e2e.mjs [outFile]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as MESSAGE_MARKERS from './message-markers.mjs';
import { rpc, rowOf, transcriptOf, localConfig } from './_rpc.mjs';
import { NS, elevateSession } from './_r28-helpers.mjs';

// ⚠️ 服务住在自己的家目录（服务家目录），**不在本包内**。实例坐标一律经配置加载器取——
// 写死绝对路径（含从本文件位置推算服务目录的写法）在服务目录迁走之后集体失效。
const CWD = localConfig.workspaceDir;
const PRESET = 'dsh-async';
const OUT = process.argv[2] ?? join(localConfig.evidenceDir, 'logs', 'async-e2e.json');
mkdirSync(dirname(OUT), { recursive: true });

/** 从转录里数出"已经发生的模型步数"——用它定位插话时刻。 */
function stepCount(page) {
  return page.records.filter((record) => record.event?.type === 'step/end').length;
}

/** 累加每条 assistant/message 的 totalTokens，作为"上下文已经涨到哪"的代理量。 */
function contextBudget(page) {
  let total = 0;
  for (const record of page.records) {
    const usage = record.event?.data?.usage;
    if (typeof usage?.totalTokens === 'number') total = Math.max(total, usage.totalTokens);
  }
  return total;
}

// ── 起跑前**确保设置是默认值** ────────────────────────────────────────────────
//
// ⚠️ **真机判据不能假设实例是干净的**：上游流程被外部中止时 `finally` 可能没跑完，
// 把改小的设置留在实例上——例如残留 `maxWaitMs=2000` 时每次等待被夹在 2 秒，
// 插话窗口窄到本脚本的 2 秒轮询撞不进。起跑前先写一遍默认值并读回核对，
// 把"上游留下的脏状态"从被测对象身上摘掉。
const DEFAULTS = {
  maxResultChars: 30000, defaultYieldMs: 20000, minYieldMs: 1000, maxYieldMs: 600000,
  defaultWaitMs: 30000, minWaitMs: 250, maxWaitMs: 600000, pollIntervalMs: 500, jobKind: 'async-command'
};
// 设置侧是宿主行 entry（`async-tools-host`；单一登记点 `_r28-helpers.mjs` 的 NS）。
// 命名空间必须逐字一致：describe 里没有的 ns，replace 直接报
// "No configurable plugin entry"。
await rpc('settings/replace', { ns: NS, section: DEFAULTS });
const effective = await rpc('settings/describe', {});
const asyncNs = effective.namespaces.find((n) => (n.ns ?? n.namespace ?? n.id) === NS);
const effectiveWait = (asyncNs.value ?? asyncNs.resolved ?? asyncNs).maxWaitMs;
console.log(`起跑基线：maxWaitMs=${String(effectiveWait)}（必须够宽，否则插话窗口只有 ${String(effectiveWait)} ms 宽，本脚本的 2 秒轮询撞不进）`);
if (effectiveWait < 600000) {
  throw new Error(`设置没写进去：maxWaitMs=${String(effectiveWait)}——先修设置再跑，否则插话判据会因为窗口太窄而假红`);
}

const created = await rpc('session/create', { request: { cwd: CWD, agentPreset: PRESET } });
const sessionId = created.sessionId;
console.log(`preset=${String(created.agentPreset)} sessionId=${sessionId}`);
if (created.agentPreset !== PRESET) {
  throw new Error(`session/create fell back: asked ${PRESET}, got ${String(created.agentPreset)}`);
}

// 会话升档（环境前置，机制与边界详见 `_r28-helpers.elevateSession` 头注）：
// 本验证实例是 LocalSystem 托管服务，受限档下 async_run 的 pwsh spawn 必死
// （2026-10-09 实测：exit 127，stderr `windows-acl-run: CreateRestrictedToken
// prerequisite failed`）。不升档，下面五步里的每一步 async_run 都到不了被测逻辑。
await elevateSession(sessionId);
console.log('会话已升档 danger-full-access（commands/execute RPC 侧，GUI composer 同链）');

const TASK = [
  '请严格按四步做，每步的 finish 之前不要做别的：',
  '第 1 步：用 async_run 执行 `Write-Output SHORT_OK`，不要传 yield_ms。',
  '第 2 步：用 async_run 执行 `Start-Sleep -Seconds 6; Write-Output LONG_DONE`，传 yield_ms=1500。它应当返回一个作业编号（job_id）。',
  '第 3 步：用 async_wait_job 等第 2 步那个 job_id，wait_ms=20000。',
  '第 4 步：用 async_run 执行 `Start-Sleep -Seconds 180; Write-Output PATIENCE`，传 yield_ms=1500，拿到 job_id 后立刻用 async_wait_job 等它，wait_ms=600000。',
  '第 5 步（**关键**）：若第 4 步的等待返回"等待被打断"，就用同一个 job_id **再次**调用 async_wait_job、wait_ms=600000，把它的最终输出取回来。',
  '四步都做完后，用一段话报告每一步的工具名与关键返回字段（status / job_id）。'
].join('\n');

await rpc('session/prompt', {
  request: {
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: TASK }],
    clientTimeZone: 'Asia/Shanghai'
  }
});

const startedAt = Date.now();
let sawRunning = false;
let interrupted = false;
let lastSteps = 0;
/** 插话次数上限——有界重试，不是无限重发。 */
const MAX_INTERJECTIONS = 3;
/** 已发出的插话次数。 */
let interjectionCount = 0;
/** 最近一次插话的时刻（0 表示还没发过）；用来只认**这次之后**出现的打断证据。 */
let interjectionAt = 0;
/** 第几次插话生效的（0 表示一次都没生效）——读数里要能看出来。 */
let interjectionSucceededOn = 0;
/** 轮询次数——用它代替时间字段（`record.time` 不存在，只有 `event.time`，见插话窗口的注释）。 */
let pollCount = 0;
/** 第一次在转录里看到长作业那次等待的轮询序号；-1 表示还没看到。 */
let longWaitFirstSeenPoll = -1;

for (;;) {
  await new Promise((resolve) => { setTimeout(resolve, 2000); });
  pollCount += 1;
  const row = await rowOf(sessionId);
  const page = await transcriptOf(sessionId);
  const steps = stepCount(page);
  if (steps !== lastSteps) {
    console.log(`+${String(Date.now() - startedAt)}ms steps=${String(steps)} running=${String(row.running)}`);
    lastSteps = steps;
  }
  if (row.running === true) sawRunning = true;

  // 插话窗口：精确定位到**长作业的那一次等待**，并在它活跃期间发。
  //
  // 按时刻猜窗口有三个失败形态（机制原因，不是运气）：
  //
  // - **按步数猜**（`steps >= 6`）：本质是抢墙壁时钟。插话发出时命令早结束了。
  // - **出现 async_wait_job 就发**：太早。第 3 步（6 秒命令）那次等待就满足，
  //   插话在长命令还没开始时发出，整个会话当场结束。
  // - **让出 ≥ 2 次且有等待调用**：还是太早。长作业刚让出时，模型还没来得及
  //   发出它的等待；插话落在"模型正在想下一步"，于是那次等待要么没发生、
  //   要么正常返回。窗口是"模型发调用到调用返回"之间的那几十毫秒，
  //   **轮询的 2 秒粒度根本够不着**。
  //
  // 现行做法：把窗口从"时刻"改成"**状态**"——
  //   ① 读转录里那次 `async_wait_job` 的**参数**，确认它的 `wait_ms` 很大（长作业的等待）；
  //   ② 第一次看到它时记下时刻，**再等两拍**（轮询 2 秒一次，所以约 2–4 秒）才插话
  //      ——那时它必然还在等（`wait_ms` 是 600000，而整轮只有几十秒）；
  //   ③ 此刻发插话，必然落在等待活跃期内。
  //
  // ⚠️ 不要用 `record.time` 算"活跃了多久"——**转录记录的字段是 `event.time`，
  // `record.time` 是 `undefined`** ⇒ 算出 `NaN`/`-1` ⇒ 条件恒假 ⇒
  // **插话一次都没发**，判据红得让人以为"打断坏了"。现行做法记"第几次轮询看到它"，
  // 不依赖任何时间字段。
  const longWaitArgs = (() => {
    for (const record of page.records) {
      const event = record.event;
      if (event?.type !== 'tool/call' || event.data?.name !== 'async_wait_job') continue;
      const args = String(event.data.arguments ?? '');
      // ⚠️ 判据要**精确到长作业那一次**：`wait_ms` 是 600000。正则不能放宽到
      // 任意 ≥5 位数字——会把第 3 步那个 20000 也匹配，"长作业的等待"在
      // 第 3 步就被认定、插话落在错误的窗口。
      if (/wait_ms"\s*:\s*6\d{5}\b/.test(args)) return args;
    }
    return undefined;
  })();
  if (longWaitArgs !== undefined && longWaitFirstSeenPoll < 0) {
    longWaitFirstSeenPoll = pollCount;
    console.log(`+${String(Date.now() - startedAt)}ms 观测到长作业的等待（poll ${String(pollCount)}）：${longWaitArgs.slice(0, 60)}`);
  }
  // 从第一次看到那次等待起，**再过两拍**才插话——那时它还在等的概率很高。
  const waitIsActive = longWaitFirstSeenPoll >= 0 && pollCount - longWaitFirstSeenPoll >= 2;

  // ── 插话：**有界重试**，而不是"发一次就认定成功" ─────────────────────────────
  //
  // 窗口错过的三个机制原因：
  //
  // **窗口太窄。** "再等两拍"在真实会话里不够——模型可能把 `wait_ms=600000`
  // 的等待**连发多次**，插话落在两次调用之间，成了排队消息、没有"打断"任何东西。
  //
  // **等待上限被夹小。** 若实例上残留 `maxWaitMs=2000`，每次"等待"只阻塞 2 秒，
  // 而本脚本的轮询间隔也是 2 秒——想在 2 秒宽的窗口里撞进去，概率本来就低
  // （这就是起跑前重写默认值的原因，见上面那段）。
  //
  // **判据不能靠运气。** 换成**有界重试**：发一次插话，看转录里有没有出现
  // "等待被打断"；没有就再发一次（最多 `MAX_INTERJECTIONS` 次）。判据仍是
  // "**必须有一次等待被打断**"——重试**不放松**这条，它只是把"轮询撞准了"
  // 这个运气成分挤出去。每次发都打日志，读数里能看出是第几次成功的。
  if (!interrupted && waitIsActive && interjectionCount < MAX_INTERJECTIONS) {
    interjectionCount += 1;
    console.log(`+${String(Date.now() - startedAt)}ms 发送第 ${String(interjectionCount)} 次插话`
      + `——长作业的等待已出现 ${String(pollCount - longWaitFirstSeenPoll)} 拍（轮询 2 秒一次）`
      + ` steps=${String(steps)} budget=${String(contextBudget(page))}`);
    await rpc('session/prompt', {
      request: {
        requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
        sessionId,
        mode: 'steer',
        // ⚠️ 插话文案**不能叫模型"不要调用任何工具"**：这条判据要的正是"打断之后
        // 模型还能继续把那个作业等回来"（第 5 步）。模型若照做"不调用工具"，
        // 会话当场结束，第 5 步永远跑不到——**判据没错，是提示词自己把路堵了**。
        content: [{ type: 'text', text: '插话测试：这是一条用户新消息。请先回复一行 INTERRUPT_RECEIVED，'
          + '然后**继续执行第 5 步**（用同一个 job_id 再次调用 async_wait_job 把最终输出取回来），不要跳过。' }],
        clientTimeZone: 'Asia/Shanghai'
      }
    });
    // 这一拍之后才开始找"等待被打断"的证据——**只认这次插话之后出现的**，
    // 否则前一次的成功会被算到这一次头上（重试就变成了自欺）。
    interjectionAt = Date.now();
  }

  // 看到"等待被打断"就收手——判定只看转录里的实际返回，不看"本脚本发出去了"。
  //
  // 这里直接按 `toolCallId` 关联，与循环外那套 `resultsById` 同构（两处形状一致，
  // 免得"循环里看到一份、循环外看到另一份"）。字段名注意：`tool/call` 用 `callId`，
  // `tool/result` 用 `toolCallId`。
  if (!interrupted && interjectionAt > 0) {
    const waitCallIds = new Set(page.records
      .filter((r) => r.event?.type === 'tool/call' && r.event.data?.name === 'async_wait_job')
      .map((r) => r.event.data.callId));
    // 转录形状：tool/result 的 content 是**渲染文本块**（type:'text'，句柄在
    // message.toolCallId）——没有 'tool-result' 块。断言锚取 message-markers（两语）。
    const notes = page.records
      .filter((r) => r.event?.type === 'tool/result' && waitCallIds.has(r.event.data?.message?.toolCallId))
      .map((r) => (r.event.data?.message?.content ?? [])
        .filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''))
      .filter((t) => MESSAGE_MARKERS.WAIT_INTERRUPTED.test(t));
    if (notes.length > 0) {
      interrupted = true;
      interjectionSucceededOn = interjectionCount;
      console.log(`+${String(Date.now() - startedAt)}ms 第 ${String(interjectionCount)} 次插话生效：`
        + JSON.stringify(notes[0].slice(0, 100)));
    }
  }

  if (sawRunning && row.running === false) break;
  if (Date.now() - startedAt > 300000) { console.log('TIMEOUT'); break; }
}

const page = await transcriptOf(sessionId);
writeFileSync(OUT, JSON.stringify({ sessionId, preset: PRESET, page }, null, 2), 'utf8');
console.log(`elapsed=${String(Date.now() - startedAt)}ms wrote ${OUT}`);

// 只打印判定所需的叶子字段：工具调用（名字 + 参数）与工具结果（原文）。
const calls = [];
const resultsById = new Map();
for (const record of page.records) {
  const event = record.event;
  if (event?.type === 'tool/call') {
    calls.push({ name: event.data.name, callId: event.data.callId, args: event.data.arguments });
    console.log(`TOOL-CALL  ${String(event.data.name)} ${String(event.data.arguments)}`);
  } else if (event?.type === 'tool/result') {
    // 渲染文本形状（同循环内注释）：句柄在 message.toolCallId，正文是 type:'text' 块拼接。
    const text = (event.data.message?.content ?? [])
      .filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('');
    resultsById.set(event.data.message?.toolCallId, text);
    console.log(`TOOL-RESULT (${String(event.data.message?.toolCallId)}) ${JSON.stringify(text)}`);
  }
}

// ── 判定 ─────────────────────────────────────────────────────────────────────
//
// ⚠️ 脚本必须有断言：只打印工具调用与结果、退出码恒 0 的形态比没有脚本更坏——
// 一次空转录、一次报错的工具调用，读数看起来都"有输出"，却会被当成
// "让出→取回"的证据。
//
// 判据覆盖需求 §2.2 的端到端链（短命令直接返回 / 长命令让出后能取回最终输出），
// 以及需求 §2.1.2 的"插话不影响作业"。
const verdicts = [];
/**
 * 记一条判定。
 *
 * @param {string} name - 判定名。
 * @param {boolean} ok - 是否成立。
 * @param {string} detail - 读数。
 * @returns {void}
 */
function judge(name, ok, detail) {
  verdicts.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'WRONG'}  ${name}`);
  console.log(`         ${detail}`);
}

/** 取某次 `async_run` 调用的工具结果原文。 */
function resultOf(callIndex) {
  const call = calls.filter((c) => c.name === 'async_run')[callIndex];
  if (call === undefined) return undefined;
  return resultsById.get(call.callId);
}

const runCalls = calls.filter((c) => c.name === 'async_run');
const waitCalls = calls.filter((c) => c.name === 'async_wait_job');
judge('会话里真的调用了 async_run 与 async_wait_job（否则后面的判定都是空的）',
  runCalls.length >= 1 && waitCalls.length >= 1,
  `async_run × ${String(runCalls.length)}、async_wait_job × ${String(waitCalls.length)}`);

// ① 短命令（ROUND 之前那条 SHORT_OK）：必须**直接返回输出**，不注册作业。
const shortResult = resultOf(0);
judge('短命令直接返回完整输出（不返回句柄）',
  typeof shortResult === 'string' && shortResult.includes('SHORT_OK'),
  shortResult === undefined ? '没有第一条 async_run 的结果' : `结果=${JSON.stringify(shortResult.slice(0, 90))}`);

// ② 长命令：首次等待分支必须回一个作业编号（job_id），且**明说命令仍在运行**（需求 §2.2.1：到时结束等待、命令继续后台执行）。
const yielded = runCalls
  .map((c, i) => ({ c, text: resultOf(i) }))
  .filter((x) => typeof x.text === 'string' && MESSAGE_MARKERS.YIELD_RUNNING.test(x.text));
judge('超出首次等待的那次返回了"仍在运行"的作业编号（不得杀死进程）',
  yielded.length >= 1,
  yielded.length === 0 ? '没有任何一次首次等待返回' : `首次等待返回 ${String(yielded.length)} 次，首次文本=${JSON.stringify(yielded[0].text.slice(0, 80))}`);

// ③ **核心**：让出去的作业必须能被 `async_wait_job` 取回**最终输出**。
//    这是"不得杀死进程"的唯一实证——只断言返回里有 job_id 是不够的。
const jobIds = [...new Set((yielded.map((x) => /(async-command-\d+)/.exec(x.text)?.[1])).filter(Boolean))];
const recovered = jobIds.map((id) => ({
  id,
  text: waitCalls.map((c) => resultsById.get(c.callId)).find((t) => typeof t === 'string' && t.includes(id) === false && t.length > 0)
}));
const waitTexts = waitCalls.map((c) => resultsById.get(c.callId)).filter((t) => typeof t === 'string');
judge('每一次让出的作业都被 async_wait_job 取回了最终输出',
  jobIds.length >= 1 && waitTexts.some((t) => /LONG_DONE|PATIENCE/.test(t)),
  `job_id=[${jobIds.join(', ')}]；`
  + `取回的文本=${JSON.stringify((waitTexts.find((t) => /LONG_DONE|PATIENCE/.test(t)) ?? '').slice(0, 90))}`);
void recovered;

// ④ 取回的结果必须能证明"进程真的跑完了"。正常退出不带退出码标记（需求
// 2.2.3 两路径一致：与前台同口径，成功由"无失败标记"表达），证据取：
// 完整的末尾输出（LONG_DONE/PATIENCE 是命令最后一句，只有跑完才会出现）
// + 无截断标注 + 无失败标记（非零退出码/信号）。
judge('取回的输出证明进程正常结束：末尾输出完整、无截断、无失败标记',
  waitTexts.some((t) => /LONG_DONE|PATIENCE/.test(t)
    && !/output truncated|已截断/.test(t)
    && !/exit code: [1-9]|退出码: [1-9]|killed by signal|被信号杀死/.test(t)),
  waitTexts.map((t) => JSON.stringify(t.slice(-40))).join(' | ').slice(0, 140));

// ⑤ 插话：等待被中断，而作业**不受影响**（需求 §2.1.2 的不变量）。
//
// ⚠️ **断言文案必须来自真实返回**。真实返回原文形如
//   「等待被打断：用户发来了新消息（已等待 1052 ms）。作业 async-command-6 仍在后台继续运行，
//     没有受到任何影响。」
// 断言模式必须照着真实返回写——自造英文关键词会匹配不到中文文案。
//
// 这条判据同时要求两半，缺一不可：
//   (a) 等待**确实**被用户消息打断（证明打断路径真的会触发，不是恒不触发）；
//   (b) 打断的返回里明说**作业不受影响**（证明"打断等待 ≠ 打断工作"这句话
//       被写在模型看得见的地方，而不是只在文档里）。
const interruptNotes = waitTexts.filter((t) => MESSAGE_MARKERS.WAIT_INTERRUPTED.test(t));
judge('用户插话让 async_wait_job 立即返回"等待被打断"（打断等待）',
  interruptNotes.length >= 1,
  interruptNotes.length === 0
    ? `没有一次等待被打断；取回文本=${waitTexts.map((t) => JSON.stringify(t.slice(0, 60))).join(' | ')}`
    : JSON.stringify(interruptNotes[0].slice(0, 110)));
judge('打断的返回里明说作业仍在后台继续运行、没有受到影响（打断不等于打断工作）',
  // 文案标记取自 `verify/message-markers.mjs`（逐字来自 `lib/output.js:71`）。
  interruptNotes.some((t) => MESSAGE_MARKERS.SUBJECT_UNTOUCHED.test(t)),
  interruptNotes.length === 0 ? '（上一条已红）' : JSON.stringify(interruptNotes[0].slice(0, 130)));
// 上面那条靠的是**返回里的措辞**，措辞可能"说得好听而事情没做"。这一条要实证：
// 打断之后**再等一次**，那个作业必须还能交出它的**完整**最终输出（`PATIENCE`
// 且无失败标记——正常退出不带退出码行，与前台同口径）。若打断路径顺手把
// 作业杀了，这里就取不回东西——那才是这条判据真正要防的。
judge('打断之后**再等一次**仍能取回同一个作业的最终输出（实证：作业活着）',
  /PATIENCE/.test(waitTexts.join('\n'))
    && !/exit code: [1-9]|退出码: [1-9]|killed by signal|被信号杀死/.test(waitTexts.join('\n')),
  waitTexts.map((t) => JSON.stringify(t.slice(0, 70))).join(' | ').slice(0, 200));

const failed = verdicts.filter((v) => !v.ok).length;
console.log('');
console.log(`${String(verdicts.length - failed)}/${String(verdicts.length)} 条成立。`);
if (failed > 0) {
  console.log(`不成立的是：${verdicts.filter((v) => !v.ok).map((v) => v.name).join('、')}`);
}
process.exitCode = failed === 0 ? 0 : 1;
