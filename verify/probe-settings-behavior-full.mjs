/**
 * 设置生效的**完整**真机行为判据（需求 §5.1 来源、生效与失败处理）：
 * 改设置，**三样东西**都必须跟着变。
 *
 * ## 为什么要把这三条放在一条里
 *
 * 三条判据指向设置生效的**三个不同侧面**：
 *
 * | # | 侧面 | 只在哪条路径上体现 |
 * |---|---|---|
 * | ① | **夹紧**（`maxWaitMs`） | 工具**等待时长**真的被压短——不是"值变了"，是"等了 2 秒而不是 600 秒" |
 * | ② | **截断**（`maxResultChars`） | 工具**返回给模型的文本**真的变短并带截断说明 |
 * | ③ | **描述里的数字**（`minWaitMs–maxWaitMs`） | **模型实际收到的那份请求体**里的描述已经换成新值 |
 *
 * 三条各自都能独立坏掉：取值入口断了（三条全红）、只刷了描述没换取值入口（①②红③绿）、
 * 只换了取值入口没刷描述（①②绿③红）。**分开验才知道坏在哪一半**。
 *
 * 三条都取自**真实请求体 / 真实工具返回值**：零浏览器，全程信封 RPC。
 *
 * 设置读写与恢复一律经 `verify/_r28-helpers.mjs` 的共享助手（嵌套 `settings`
 * 子树契约，设计 §8.3）：起跑先保存原状态（value/user 两层）并**落盘快照**（进程
 * 被强杀、finally 不执行时按快照人工恢复）。探针自己的每次写入都经**计数写**登记
 * 「预期的下一状态用户覆盖层」；每次读都走 `trackState`——自写窗口内覆盖层与预测
 * 不符、或无自写预期而 revision 推进／深比对有变，都**当场**记为窗口内他方写入
 * （不再等到收尾、也不吸收为已知状态），收尾按记录停止恢复并报告。恢复写本身带
 * `expectedRevision`（宿主 CAS：读—写窗口内他方写入使落库被拒，而不是被覆盖）；
 * 宿主不提供修订号（revision 为 null）时退化为深比对检测＋无 CAS 恢复，边界如实
 * 报告。两条恢复防线各有一次**在探针内演练**：绕过登记层的裸写入必须被下一次读
 * 检出；过期 `expectedRevision` 必须被服务端拒绝且状态不动。另有平铺负向对照
 * （显式绕过助手）与嵌套 replace 语义两条形状判据。**边界：本探针会写真实设置，
 * 只在专用验证实例上执行**；共享实例上他方更新一旦发生，恢复按上面的冲突语义停止。
 *
 * 用法：
 *   node verify/probe-settings-behavior-full.mjs
 *   node verify/probe-settings-behavior-full.mjs --out <证据文件路径>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { instanceCredentials, loadLocalPlaneOrSkip, tokenEntryUrl } from '../tools/_local-config.mjs';
import { authCookieFromFirstHop, assertApiNotRedirected } from './_auth.mjs';
// 设置读写/恢复一律走共享助手（设计 §8.3：嵌套形状单点封装；本探针自带的 rpc
// 只服务会话驱动与「显式绕过助手」的平铺负向对照）。
import { elevateSession, readNs, patchNs, replaceNs, mutateNs, NS } from './_r28-helpers.mjs';

const localConfig = await loadLocalPlaneOrSkip('verify/probe-settings-behavior-full.mjs');
const { base: BASE, token } = instanceCredentials(localConfig);
// 服务住在自己的家目录（服务家目录），**不在本包内**。实例坐标一律经配置加载器取——
// 写死绝对路径在服务目录迁走之后集体失效。
const CWD = localConfig.workspaceDir;

const outAt = process.argv.indexOf('--out');
const OUT_FILE = outAt >= 0 && process.argv[outAt + 1] !== undefined
  ? process.argv[outAt + 1]
  : join(localConfig.evidenceDir, 'logs', 'settings-behavior-full.json');
mkdirSync(dirname(OUT_FILE), { recursive: true });

/** 起跑归位用的测试基线（行为判据从这组数出发；收尾恢复的是**原状态**不是这组数）。
 * 与其他真机探针同族——`minYieldMs`/`minWaitMs`/`maxResultChars` 三项有意偏离
 * 出厂默认（口径见 final-acceptance.mjs 头注）。agentLang 出厂是 en（`lib/config.js`）；
 * 判据锚的等待读数与工具描述文案是中文档，跑动阶段各补丁统一钉 `agentLang: 'zh'`。 */
const TEST_BASELINE = {
  maxResultChars: 30000,
  defaultYieldMs: 20000,
  minYieldMs: 1000,
  maxYieldMs: 600000,
  defaultWaitMs: 30000,
  minWaitMs: 250,
  maxWaitMs: 600000,
  pollIntervalMs: 500,
  jobKind: 'async-command',
  agentLang: 'en'
};

// 登录与 `verify/_rpc.mjs` 同款：判定统一在 `verify/_auth.mjs`——首跳接受
// 「3xx＋Set-Cookie＋同源/缺席 Location」的正常 cookie 交换，不跟随 Location；
// API 调用的任何 3xx 仍按错误处理。令牌编码统一走 tokenEntryUrl。
const indexResponse = await fetch(tokenEntryUrl(BASE, token), { redirect: 'manual' });
const cookie = authCookieFromFirstHop(indexResponse, BASE);

/**
 * 发一次信封 RPC。重定向按错误处理（不携带凭据跳转）。
 *
 * @param {string} endpoint - RPC 方法名。
 * @param {object} args - 参数。
 * @returns {Promise<any>} `result.value`。
 */
async function rpc(endpoint, args) {
  const rpcId = `full-${Math.random().toString(36).slice(2, 10)}`;
  const response = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    redirect: 'manual'
  });
  assertApiNotRedirected(response, endpoint);
  const text = await response.text();
  const body = JSON.parse(text);
  if (body?.result?.ok !== true) {
    throw new Error(`${endpoint}: ${JSON.stringify(body?.result?.error ?? text.slice(0, 200))}`);
  }
  return body.result.value;
}

/** 读当前生效的设置值（嵌套契约经共享助手，严格取 settings 子树，无多形状回退）。 */
async function readEffective() {
  const entry = await readNs();
  trackState(entry);
  return entry.value;
}

/**
 * 恢复冲突检测的已知状态：本探针每次读／写设置后登记「我们已知的最新状态」。
 *
 * 检测分两个窗口（修订号缺席时的降级口径见各分支）：
 * - **自写窗口**（有未消费的自写预期）：读到的用户覆盖层必须与预测一致——
 *   不一致 ⇒ 除本探针的写入外还有别的写入，**当场**记入 `foreignChanges`
 *   （不等收尾；收尾的 revision 比对看不到已被吸收进 lastKnown 的变化）。
 * - **静默窗口**（无自写预期）：revision 在场时任何推进都是他方写入；缺席时按
 *   value＋user 深比对。
 *
 * @type {{ revision: number | null, value: object, user: object } | null}
 */
let lastKnown = null;

/**
 * 本探针自己发起、尚未被下一次读消费的写入预期。
 * `overlay`＝按写入语义预测的下一状态用户覆盖层（update 合并、replace 整替）；
 * `writes`＝累计写入次数（诊断用）。宿主各写入接口的修订号推进数不在预期内假设
 * ——判定只看覆盖层是否与预测相符（预测按写入语义构造，不依赖修订号节奏）。
 * @type {{ overlay: object, writes: number } | null}
 */
let ownWriteExpectation = null;

/** 窗口内检出的他方写入（含演练条目，`drill:true`；收尾只按非演练条目停止恢复）。 */
const foreignChanges = [];

/** 计数写（update 语义）：登记预期覆盖层（在已知/预期之上合并本批字段）再写。 */
async function countedPatch(fields) {
  const base = ownWriteExpectation?.overlay ?? lastKnown?.user ?? {};
  ownWriteExpectation = { overlay: { ...structuredClone(base), ...structuredClone(fields) }, writes: (ownWriteExpectation?.writes ?? 0) + 1 };
  await patchNs(fields);
}

/** 计数写（replace 语义）：先复位全部 volatile 字段再合并入参——覆盖层＝入参整替。 */
async function countedReplace(fields) {
  ownWriteExpectation = { overlay: structuredClone(fields), writes: (ownWriteExpectation?.writes ?? 0) + 1 };
  await replaceNs(fields);
}

/**
 * 把一次读到的设置状态登记为「本探针已知的最新状态」（并按上一窗口判定他方写入）。
 *
 * @param {{ revision: number | null, value: object, user: object }} entry - 读到的状态。
 */
function trackState(entry) {
  if (lastKnown !== null) {
    if (ownWriteExpectation !== null) {
      if (!isDeepStrictEqual(entry.user ?? {}, ownWriteExpectation.overlay)) {
        foreignChanges.push({
          reason: '自写窗口内用户覆盖层与预测不符（窗口内有本探针之外的写入）',
          expectedUser: ownWriteExpectation.overlay,
          actualUser: entry.user ?? {}
        });
      }
    } else if (lastKnown.revision !== null && entry.revision !== null) {
      if (entry.revision !== lastKnown.revision) {
        foreignChanges.push({
          reason: '无自写预期而 revision 推进（他方写入）',
          fromRevision: lastKnown.revision,
          toRevision: entry.revision
        });
      }
    } else if (!isDeepStrictEqual({ value: entry.value, user: entry.user },
      { value: lastKnown.value, user: lastKnown.user })) {
      foreignChanges.push({ reason: 'revision 缺席：深比对发现无自写预期的变化（按他方写入处理）' });
    }
  }
  lastKnown = { revision: entry.revision, value: structuredClone(entry.value), user: structuredClone(entry.user) };
  ownWriteExpectation = null;
}

/** 读会话清单行。 */
async function rowOf(sessionId) {
  const listing = await rpc('session/list', { _request: {} });
  const row = listing.items.find((item) => item.sessionId === sessionId);
  if (row === undefined) throw new Error(`session ${sessionId} not found`);
  return row;
}

/** 从清单行里读预设名（在 `projections.values.agentPreset`，不在顶层）。 */
function presetOf(row) {
  return row.projections?.values?.agentPreset;
}

/** 读会话转录。 */
async function transcriptOf(sessionId) {
  const row = await rowOf(sessionId);
  return rpc('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 400 }
  });
}

/**
 * 从转录里取 `async_wait` 的工具结果原文。
 *
 * 字段与形状以转录实测为准：`tool/call` 的调用号在 `data.callId`；
 * `tool/result` 的调用号在 `message.toolCallId`（`message.source.callId` 同值）；
 * 结果块现行形状是 `type: "text"`（text 直挂块上），旧形状 `type: "tool-result"`
 * （嵌套 content 数组）一并兼容。
 *
 * @param {any} page - 转录。
 * @returns {string[]} 结果文本。
 */
function waitResults(page) {
  const wanted = new Set();
  for (const record of page.records ?? []) {
    const event = record.event;
    if (event?.type === 'tool/call' && event.data?.name === 'async_wait') wanted.add(event.data.callId);
  }
  return resultTexts(page, wanted);
}

/** 从转录里取所有工具结果原文（不挑工具）。 */
function allResults(page) {
  return resultTexts(page, undefined);
}

/**
 * 结果原文收集器：按调用号过滤（缺省不过滤），兼容新旧两种结果块形状。
 *
 * @param {any} page - 转录。
 * @param {Set<string> | undefined} wanted - 要的调用号集合；undefined = 全收。
 * @returns {string[]} 结果文本。
 */
function resultTexts(page, wanted) {
  const out = [];
  for (const record of page.records ?? []) {
    const event = record.event;
    if (event?.type !== 'tool/result') continue;
    const message = event.data?.message;
    const callId = message?.toolCallId ?? message?.source?.callId;
    if (wanted !== undefined && !wanted.has(callId)) continue;
    for (const block of message?.content ?? []) {
      if (block.type === 'tool-result') out.push((block.content ?? []).map((p) => p.text ?? '').join(''));
      else if (block.type === 'text' && typeof block.text === 'string') out.push(block.text);
    }
  }
  return out;
}

const checks = [];
/**
 * 记一条断言。
 *
 * @param {string} name - 断言名。
 * @param {boolean} ok - 是否成立。
 * @param {string} detail - 读数。
 */
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'OK   ' : 'WRONG'}  ${name}`);
  console.log(`         ${detail}`);
}

/**
 * 起一个会话、发一条提示词、等它结束，返回转录。
 *
 * @param {string} prompt - 发给模型的提示词。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<any>} 转录。
 */
async function sessionWith(prompt, timeoutMs = 240000) {
  const created = await rpc('session/create', { request: { cwd: CWD, agentPreset: 'dsh-async' } });
  const sessionId = created.sessionId ?? created.id;
  const row0 = await rowOf(sessionId);
  const preset = presetOf(row0);
  if (preset !== 'dsh-async') {
    throw new Error(`预设回退到了 ${String(preset)}——本探针的判据只对 dsh-async 有效`);
  }
  // 会话升档（环境前置，机制与边界见 `_r28-helpers.elevateSession` 头注）：
  // 本验证实例是 NSSM 托管服务（LocalSystem、无登录 SID），受限档下 async_run 的
  // pwsh spawn 必死（exit 127，`windows-acl-run: CreateRestrictedToken prerequisite
  // failed`）。不升档，夹紧/下界/截断三段判据全部跑不到被测逻辑。
  await elevateSession(sessionId);
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
  const deadline = Date.now() + timeoutMs;

  // ## 怎么可靠地判断"这一轮结束了"
  //
  // "先见 `running: true`、再见 `running: false`"**偶发超时**：
  // 刚创建的会话在模型起来之前完全可能读到 `running: false`，
  // 于是 `sawRunning` 的时序一旦错位，循环就永远等不到"先 true"。
  //
  // `session/list` 的行里有 **`projections.asOfSeq`**（事件序号，单调递增，实读确认），
  // 它不受这种时序竞态影响：提示词一旦被受理，序号必然前进。
  // ⇒ 判据是"**序号前进过 且 当前不 running**"，两半都不依赖采样运气。
  const seqAtStart = (await rowOf(sessionId)).projections?.asOfSeq ?? 0;
  let sawProgress = false;
  for (;;) {
    const current = await rowOf(sessionId);
    const seq = current.projections?.asOfSeq ?? 0;
    if (seq > seqAtStart) sawProgress = true;
    if (sawProgress && current.running === false) break;
    if (Date.now() > deadline) {
      throw new Error(
        `会话超时未结束：asOfSeq 起于 ${String(seqAtStart)}、现为 ${String(seq)}、`
        + `running=${String(current.running)}、已见前进=${String(sawProgress)}`
      );
    }
    await new Promise((resolve) => { setTimeout(resolve, 1500); });
  }
  return transcriptOf(sessionId);
}

const evidence = { base: BASE, checks, runs: [], foreignChanges };
let valueBefore = null;
let userBefore = null;
let SNAPSHOT_FILE = '';
try {
  // ── 起跑：先保存**原状态**（value 与 user 两层），再从 TEST_BASELINE 出发 ──────
  //
  // 保存原状态是恢复的依据（收尾按 userBefore 逐键恢复，见 finally）；
  // 随后无条件把设置写成 `TEST_BASELINE`，让行为判据从确定基线出发——外部切断
  // （跑批超时 kill）留下的脏状态在下一次开跑即被抹平，不会累积。
  const entry0 = await readNs();
  valueBefore = structuredClone(entry0.value);
  userBefore = structuredClone(entry0.user);
  trackState(entry0);
  evidence.before = { value: entry0.value, user: entry0.user, revision: entry0.revision };
  // 原状快照**落盘**：finally 只覆盖常规退出路径，进程被强杀时不会执行——快照
  // 写在证据目录里，强杀后按它人工恢复（比「下次开跑抹平」多一条明确出路）。
  SNAPSHOT_FILE = join(dirname(OUT_FILE), `settings-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(SNAPSHOT_FILE, `${JSON.stringify({
    at: new Date().toISOString(),
    probe: 'verify/probe-settings-behavior-full.mjs',
    ns: NS,
    revision: entry0.revision,
    value: entry0.value,
    user: entry0.user,
    note: '起跑时的原状快照（value 与 user 两层）。探针被强杀、finally 未执行时，按此人工恢复。'
  }, null, 2)}\n`, 'utf8');
  await countedPatch(TEST_BASELINE);
  const before = await readEffective();
  evidence.baseline = { maxWaitMs: before.maxWaitMs, maxResultChars: before.maxResultChars };
  console.log(`原状态已存（user 覆盖 ${String(Object.keys(userBefore).length)} 键；快照 ${SNAPSHOT_FILE}）；起跑基线：maxWaitMs=${String(before.maxWaitMs)}  maxResultChars=${String(before.maxResultChars)}`);
  console.log('');

  // ── 0 形状契约：平铺拒绝（负向对照，显式绕过助手）＋嵌套 update/replace ──────
  //
  // 宿主行 describe 的 value 投影是 `{ settings: { … } }`；直接放在根上的字段
  // 会被宿主路径校验拒绝。负向对照**必须**绕过共享助手裸发平铺 patch——若哪天
  // 宿主接受平铺写（契约回摆），这条会变红，而不是被助手的包装悄悄掩盖。
  let flatError = '';
  try {
    await rpc('settings/update', { ns: NS, patch: { maxResultChars: 13731 } });
  } catch (error) {
    flatError = String(error?.message ?? error);
  }
  const afterFlat = await readNs();
  trackState(afterFlat);
  check('平铺 patch 被 settings/rejected 拒绝（not volatile）且生效值不变（负向对照）',
    /settings\/rejected/.test(flatError) && /not volatile/.test(flatError) && afterFlat.value.maxResultChars !== 13731,
    flatError.slice(0, 160) || '(未抛错：平铺写被接受＝形状负向对照失败)');

  await countedPatch({ maxResultChars: 48000 });
  const afterNested = await readNs();
  trackState(afterNested);
  check('嵌套 update 生效并落在用户覆盖层（value 与 user 同键同值）',
    afterNested.value.maxResultChars === 48000 && afterNested.user.maxResultChars === 48000,
    `value=${String(afterNested.value.maxResultChars)}  user=${String(afterNested.user.maxResultChars)}`);

  await countedReplace(structuredClone(entry0.base));
  const afterReplace = await readNs();
  trackState(afterReplace);
  check('嵌套 replace（完整 base）重建 volatile 生效值（复位语义，不是稀疏更新）',
    isDeepStrictEqual(afterReplace.value, entry0.base),
    `value===base：${String(isDeepStrictEqual(afterReplace.value, entry0.base))}`);

  // ── ① 夹紧：把 maxWaitMs 压到 2000，模型请求 600000，实际必须约 2 秒返回 ──
  //
  // 这是"值变了"与"行为变了"的分界：一个把设置读进内存后再也不看的实现，
  // 会老老实实等满 600 秒（或等到作业结束），而不是 2 秒就返回 running。
  await countedPatch({ ...TEST_BASELINE, maxWaitMs: 2000, defaultWaitMs: 2000, agentLang: 'zh' });
  const effectiveClamp = await readEffective();
  check('先把 `maxWaitMs` 写成 2000 并读回确认（区分"没写进去"与"写进去没生效"）',
    effectiveClamp.maxWaitMs === 2000,
    `分层读回 maxWaitMs=${String(effectiveClamp.maxWaitMs)}`);

  const t0 = Date.now();
  const pageClamp = await sessionWith(
    '请严格执行两步：\n'
    + '① 用 async_run 执行 `Start-Sleep -Seconds 45; Write-Output SLOWDONE`，传 yield_ms=1500；\n'
    + '② 拿到 job_id 后立刻用 async_wait 等它（targets=[{kind:"job", id:...}]），**wait_ms 传 600000**。\n'
    + '两步做完后用一句话报告第 ② 步返回的 status 字段。'
  );
  const clampElapsed = Date.now() - t0;
  const clampResults = waitResults(pageClamp);
  const clampText = clampResults.join('\n');
  evidence.runs.push({ label: '夹紧', elapsedMs: clampElapsed, results: clampResults.map((t) => t.slice(0, 90)) });
  // 判据读**工具自报的实际等待毫秒**（「已等待 N ms」），不读整轮墙钟：整轮含模型
  // 两轮往返，宿主模型延迟（实测可到 30 s/轮）会把 60 s 窗口顶穿——量错对象的窗口
  // 只会误红。自报读数是夹紧行为的直接证据：失效形态（等满 45 s 作业或 600 s 预算）
  // 要么自报 ≈45000/600000、要么根本不出 running 形回执（读数缺席判红）。
  const waitedMatch = clampText.match(/已等待 (\d+) ms|waited (\d+) ms/);
  const waitedMs = waitedMatch === null ? null : Number(waitedMatch[1] ?? waitedMatch[2]);
  check('请求 wait_ms=600000 时工具实际只等了约 2 秒（自报等待读数 ≤ 4000 ms；夹紧失效会自报 ≈45000/600000 或读数缺席）',
    waitedMs !== null && waitedMs <= 4000,
    `自报已等待 ${waitedMs === null ? '（未读到）' : String(waitedMs)} ms；整轮 ${String(clampElapsed)}ms（含模型两轮往返，仅记录不判）`);
  check('那一次等待返回的是 `status: running`（超出 2 秒预算 ⇒ 没等到就交还句柄）',
    /仍在运行|running/.test(clampText),
    JSON.stringify(clampText.slice(0, 110)));

  // ── ①b **下界**也要夹紧（与上界对称；缺了它"有界等待"只剩一半）──────────────
  //
  // 上界挡住"模型传一个巨大的 wait_ms 把一轮挂死"；下界挡住"模型传 wait_ms=1
  // 退化成忙轮询"。**两个方向各自是一条独立的不变量**，只验一个等于只守了一半。
  //
  // 判据取法：让模型请求 `wait_ms=1`（远低于下界 250），然后看**工具返回里自报的等待时长**。
  // 若下界失效，它会以 1 ms 到期 ⇒ 返回值里的"已等待"约等于 1；
  // 下界生效则应约等于 250。**读的是工具自己的读数，不是脚本自测的墙钟**——
  // 墙钟里混着模型往返，分辨不出 1 ms 与 250 ms。
  const pageFloor = await sessionWith(
    '请严格执行两步：\n'
    + '① 用 async_run 执行 `Start-Sleep -Seconds 30; Write-Output FLOORDONE`，传 yield_ms=1500；\n'
    + '② 拿到 job_id 后立刻用 async_wait 等它（targets=[{kind:"job", id:...}]），**wait_ms 传 1**。\n'
    + '两步做完后用一句话报告第 ② 步返回的 status 字段。'
  );
  const floorText = waitResults(pageFloor).join('\n');
  const waited = /已等待 (\d+) ms/.exec(floorText);
  evidence.runs.push({ label: '下界夹紧', waitedMs: waited === null ? null : Number(waited[1]), text: floorText.slice(0, 160) });
  check('请求 wait_ms=1 时等待被**抬到下界**（返回里自报的"已等待"≈250 ms，而不是 1 ms）',
    waited !== null && Number(waited[1]) >= 200,
    waited === null
      ? `返回里没有"已等待 N ms"：${JSON.stringify(floorText.slice(0, 120))}`
      : `已等待 ${waited[1]} ms（期望 ≥200；若下界失效会约 1，或干脆不进入等待）`);

  // ── ② 截断：把 maxResultChars 压到 500，长输出的返回必须变短并带截断说明 ──
  await countedPatch({ ...TEST_BASELINE, maxResultChars: 500, agentLang: 'zh' });
  const effectiveCut = await readEffective();
  check('再把 `maxResultChars` 写成 500 并读回确认',
    effectiveCut.maxResultChars === 500,
    `分层读回 maxResultChars=${String(effectiveCut.maxResultChars)}`);

  const TAIL = 'TAILMARKER';
  const pageCut = await sessionWith(
    '调用 async_run，command 参数用这一条，yield_ms 传 60000：\n\n'
    + `1..400 | ForEach-Object { "line $_ padding padding padding padding padding" }; Write-Output '${TAIL}'`
  );
  const cutResults = allResults(pageCut);
  const cutText = cutResults.reduce((a, b) => (a.length >= b.length ? a : b), '');
  evidence.runs.push({ label: '截断', chars: cutText.length, hasNote: /\[output truncated|\[输出已截断/.test(cutText) });
  // 判据标签**不写具体数字**：数字写进标签会随实现漂移（例如把某次观测到的
  // 输出长度误当默认值）；真实读数由下面的 `detail` 现场打出来。
  check('改成 500 之后模型收到的文本变短了（与默认预算下的同一条命令相比）',
    cutText.length < 3000,
    `长度 ${String(cutText.length)} 字符`);
  check('并出现显式的截断说明（保头保尾，删的是中间；双语键带省略量）',
    /\[output truncated: \d+ chars omitted\]|\[输出已截断：省略 \d+ 字符\]/.test(cutText),
    JSON.stringify(cutText.slice(0, 120)));

  // ── ③ 描述里的数字：模型收到的那份请求体里，**四个工具**的数字都必须跟着变 ──
  //
  // 去重后的形态：正文的预算区间只在 `async_run`（首次等待，digest.yield）；
  // 等待区间四个等待语义工具都在**尾部摘要**（digest.wait 共享同一句，正文不重复
  // 第二遍）。
  // `async_agent` 正文无预算区间，只有尾摘要——它与其他三个同组。
  //
  // 两条断言各自能独立失败：
  //   (a) `async_run` 的**正文**里让出区间仍是现行值（本轮未改的默认，不是被写成等待区间）；
  //   (b) 四个工具的**尾摘要**等待区间都是新值。
  const tools = pageClamp.records
    .filter((r) => r.event?.type === 'request/header')
    .flatMap((r) => r.event.data?.header?.tools ?? []);
  /** 取某个工具在请求体里的描述。 */
  const descOf = (name) => tools.find((t) => t?.name === name)?.description;
  evidence.runs.push({
    label: '描述',
    ranges: Object.fromEntries(['async_run', 'async_wait', 'async_agent']
      .map((n) => [n, (descOf(n) ?? '').match(/\d+–\d+ ms/g) ?? []]))
  });

  const runDesc = descOf('async_run') ?? '';
  const yieldBody = /范围 (\d+)–(\d+) ms）；/.exec(runDesc);
  check('(a) `async_run` 正文里的**让出**区间仍是现行默认，不是被写成等待区间',
    yieldBody !== null && yieldBody[1] === '1000' && yieldBody[2] === '600000',
    yieldBody === null
      ? 'async_run 正文里找不到让出区间'
      : `实得 ${yieldBody[1]}–${yieldBody[2]}（让出区间本轮未改，应仍是默认 1000–600000）`);

  const tailTools = ['async_run', 'async_wait', 'async_agent']
    .map((n) => ({ n, hit: /等待预算必须显式传入，范围 (\d+)–(\d+) ms/.exec(descOf(n) ?? '') }))
    .filter((x) => x.hit === null || x.hit[2] !== '2000');
  check('(b) 三个工具的尾摘要等待区间都已换成新值',
    tools.length > 0 && tailTools.length === 0,
    tools.length === 0
      ? '请求体里没有工具清单'
      : tailTools.length === 0
        ? '三个工具的尾摘要均为 250–2000'
        : `未换的：${tailTools.map((x) => x.n).join('、')}`);

  // ── ④ 让出区间**也要跟着变**（补上第 (a) 条的区分力）────────────────────────
  //
  // 第 (a) 条只改 `maxWaitMs`，让出区间全程停在默认值 ⇒ 它只能证明
  // "让出区间**没被写错**"，**证明不了"让出区间会跟着设置变"**。
  // 这两个结论的强度差得很远：前者在一个"让出区间永远是默认值"的实现上也会绿。
  //
  // 所以再改一次设置，**只动让出区间**，然后从真实请求体里读回来。`async_run` 是
  // 唯一有 `yieldDigest` 的工具，这条也是唯一能覆盖第③条形态规则的判据。
  // `defaultWaitMs` 必须跟着 `maxWaitMs` 一起收窄——跨字段校验会拒掉
  // "默认值落在区间外"的组合（`settings/rejected`：`defaultWaitMs (30000) 必须在 250–2000 ms 之内`）。
  // 那条校验本身是 `test/two-planes.test.mjs` T7b 在守的东西，这里撞上它说明它在工作。
  await countedPatch({ ...TEST_BASELINE, maxWaitMs: 2000, defaultWaitMs: 2000, minYieldMs: 1500, maxYieldMs: 450000, defaultYieldMs: 7000, agentLang: 'zh' });
  // 本探针的最后一次写之后没有别的读步骤了——紧跟一次读回并登记，恢复前的
  // 冲突检测才能把「我们自己的这次写」与「他方在窗口内的更新」区分开。
  trackState(await readNs());
  const pageYield = await sessionWith('回复一个句号即可，不要调用任何工具。');
  const runYield = (pageYield.records
    .filter((r) => r.event?.type === 'request/header')
    .flatMap((r) => r.event.data?.header?.tools ?? [])
    .find((t) => t?.name === 'async_run')?.description) ?? '';
  evidence.runs.push({ label: '让出区间', text: runYield.slice(0, 400) });
  const yieldTail = /首次等待默认 (\d+) ms（可传 yield_ms，范围 (\d+)–(\d+) ms）/.exec(runYield);
  const yieldBodyAfter = /范围 (\d+)–(\d+) ms）；/.exec(runYield);
  check('(c) 改首次等待后，`async_run` 正文与尾摘要里的**首次等待**区间都跟着变成新值',
    yieldTail !== null && yieldBodyAfter !== null
    && yieldBodyAfter[1] === '1500' && yieldBodyAfter[2] === '450000'
    && yieldTail[1] === '7000' && yieldTail[2] === '1500' && yieldTail[3] === '450000',
    `正文 ${yieldBodyAfter === null ? '(找不到)' : `${yieldBodyAfter[1]}–${yieldBodyAfter[2]}`}；`
    + `尾摘要 ${yieldTail === null ? '(找不到)' : `${yieldTail[1]} ms 默认 / ${yieldTail[2]}–${yieldTail[3]}`}`
    + '（期望 1500–450000，默认 7000）');
  check('(d) 同时等待区间**没有**被首次等待区间污染（两个区间各自对号）',
    /单次等待预算必须显式传入，范围 250–2000 ms/.test(runYield),
    JSON.stringify((/单次等待预算必须显式传入，范围 [\d–]+ ms/.exec(runYield) ?? ['(找不到)'])[0]));

  // ── ⑤ 恢复防线的演练：未登记写入检出 ＋ 过期 expectedRevision 被拒 ──────────
  //
  // 收尾恢复的并发安全靠两件东西：写入预期登记（读数与预测不符＝他方写入，当场
  // 记录，不等收尾）与恢复写的 CAS（expectedRevision）。两条防线没在真机上演练过
  // 就只是「看起来有」——这里各验一次。演练写入打 `drill` 标记：它检出的「他方
  // 写入」是我们自己制造的，收尾不按它停手。
  //
  // 演练①：绕过计数写直接裸写一个键（检测层无法区分写入者身份，只能区分「有无
  // 预期」——这正是要验的判定面），下一次读必须把它检出。
  const drillStart = await readNs();
  trackState(drillStart);
  const DRILL_KEY = 'pollIntervalMs';
  const drillValue = drillStart.value[DRILL_KEY] === 501 ? 502 : 501;
  await rpc('settings/update', { ns: NS, patch: { settings: { [DRILL_KEY]: drillValue } } });
  const drillAfter = await readNs();
  const foreignCountBefore = foreignChanges.length;
  trackState(drillAfter);
  const drillHits = foreignChanges.slice(foreignCountBefore);
  check('演练①：绕过登记层的写入在下一次读时被检出（不吸收为已知状态）',
    drillHits.length > 0,
    drillHits.length > 0
      ? drillHits[0].reason
      : `未检出（revision ${String(drillStart.revision)}→${String(drillAfter.revision)}）——登记层失效＝收尾恢复的并发检测同样失效`);
  for (let i = foreignCountBefore; i < foreignChanges.length; i += 1) foreignChanges[i].drill = true;
  // 演练键的还原是探针自己的写——走计数写（消费一档预期）。
  await countedPatch({ [DRILL_KEY]: drillStart.value[DRILL_KEY] });
  trackState(await readNs());

  // 演练②：恢复写带过期修订号（当前减一）必须被服务端拒绝，且状态不被改动。
  const casBase = await readNs();
  trackState(casBase);
  if (casBase.revision === null || casBase.revision < 1) {
    check('演练②：过期 expectedRevision 被服务端拒绝',
      false,
      `宿主未提供可用修订号（revision=${String(casBase.revision)}）——CAS 演练不可执行；本实例收尾恢复按无 CAS 形态运行（边界，如实报告）`);
  } else {
    let casError = '';
    try {
      await mutateNs([{ op: 'set', path: ['settings', DRILL_KEY], value: casBase.value[DRILL_KEY] }], casBase.revision - 1);
    } catch (error) {
      casError = String(error?.message ?? error);
    }
    const afterCas = await readNs();
    trackState(afterCas);
    check('演练②：过期 expectedRevision 被服务端拒绝且状态未被改动',
      casError !== '' && afterCas.revision === casBase.revision
        && isDeepStrictEqual(afterCas.user, casBase.user),
      casError === ''
        ? '(未被拒绝——宿主没有执行 CAS，恢复写的读—写窗口无并发保护)'
        : casError.slice(0, 160));
  }
} finally {
  // **无条件恢复原状态**（设计 §8.3）：replace 会给整组字段建用户覆盖，所以恢复
  // 按 `userBefore ∪ userNow` 逐键处理——原有覆盖按原值 set、其余 unset（回继承
  // 值，不把生效值写成新覆盖）；再读回核对 value 与 user **两层**都与原状态一致。
  // 恢复失败单独报错，不被主断言掩盖。
  //
  // **恢复前的并发判定**（两层）：①起跑以来累计的他方写入记录（`foreignChanges`
  // 里非演练条目非空——写入预期登记在读数现场检出，收尾只汇总）；②恢复前重读一
  // 次，与已知状态比对（revision；缺席按深比对）。任一命中就**停止恢复并报告**，
  // 把选择权交还操作者；原状快照已落盘（`SNAPSHOT_FILE`），供人工核对后恢复。
  // 恢复写本身带 `expectedRevision`（宿主 CAS）：恢复读与恢复写之间再插入他方写入
  // 时，落库被拒——同样按停手处理，不覆盖。revision 缺席（null）的实例没有 CAS
  // 可用，恢复写退化为无修订号保护（检测仍靠①②）。
  try {
    if (valueBefore === null) {
      console.log('收尾恢复跳过：未取得起跑快照（本次探针未改过设置）。');
      evidence.restored = true;
    } else {
      const settle = await readNs();
      const settleDrifted = lastKnown !== null
        && (lastKnown.revision !== null && settle.revision !== null
          ? settle.revision !== lastKnown.revision
          : !isDeepStrictEqual({ value: settle.value, user: settle.user },
            { value: lastKnown.value, user: lastKnown.user }));
      const foreignReal = foreignChanges.filter((c) => c.drill !== true);
      if (settleDrifted || foreignReal.length > 0) {
        console.log('');
        console.log('**停止恢复**：检测到窗口内的并发设置变更（他方更新了本命名空间）。');
        console.log(`  本探针已知状态：revision=${String(lastKnown?.revision ?? '?')}；当前读到：revision=${String(settle.revision ?? '?')}；`
          + `现场检出 ${String(foreignReal.length)} 条（另演练 ${String(foreignChanges.length - foreignReal.length)} 条）。`);
        for (const c of foreignReal) console.log(`  · ${c.reason}`);
        console.log('  按不覆盖原则不执行恢复写——实例可能停在本探针的测试基线上。');
        console.log(`  起跑原状快照（人工核对后恢复用）：${SNAPSHOT_FILE}`);
        evidence.restored = false;
        evidence.restoreConflict = {
          settle: { revision: settle.revision, value: settle.value, user: settle.user },
          known: lastKnown,
          foreignChanges: foreignReal,
          snapshotFile: SNAPSHOT_FILE
        };
      } else {
        const userNow = settle.user ?? {};
        const ops = [];
        for (const key of new Set([...Object.keys(userBefore), ...Object.keys(userNow)])) {
          ops.push(Object.hasOwn(userBefore, key)
            ? { op: 'set', path: ['settings', key], value: userBefore[key] }
            : { op: 'unset', path: ['settings', key] });
        }
        let casConflict = null;
        if (ops.length > 0) {
          try {
            await mutateNs(ops, lastKnown?.revision ?? undefined);
          } catch (error) {
            casConflict = String(error?.message ?? error);
          }
        }
        if (casConflict !== null) {
          console.log('');
          console.log('**恢复写被拒绝**（expectedRevision 不匹配：恢复读与恢复写之间有他方写入）——按不覆盖原则停手。');
          console.log(`  服务端拒绝原文：${casConflict.slice(0, 200)}`);
          console.log(`  起跑原状快照（人工核对后恢复用）：${SNAPSHOT_FILE}`);
          evidence.restored = false;
          evidence.restoreConflict = { reason: 'cas-rejected', error: casConflict, snapshotFile: SNAPSHOT_FILE };
        } else {
          const finalEntry = await readNs();
          const valueSame = isDeepStrictEqual(finalEntry.value, valueBefore);
          const userSame = isDeepStrictEqual(finalEntry.user, userBefore);
          console.log('');
          console.log(`收尾恢复原状态：${valueSame && userSame ? 'value 与 user 两层均回到原状' : '**存在未恢复差异（见 afterRestore）**'}`);
          evidence.restored = valueSame && userSame;
          evidence.afterRestore = { value: finalEntry.value, user: finalEntry.user };
        }
      }
    }
  } catch (error) {
    console.log(`收尾恢复**失败**：${String(error)}——验证实例可能停在被改过的状态。`);
    console.log(`  起跑原状快照（人工恢复用）：${SNAPSHOT_FILE === '' ? '（未写到）' : SNAPSHOT_FILE}`);
    evidence.restoreError = String(error);
  }
}

const failed = checks.filter((c) => !c.ok).length;
evidence.verdict = failed === 0 && evidence.restored === true ? 'PASS' : 'FAIL';
writeFileSync(OUT_FILE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log('');
console.log(`${String(checks.length - failed)}/${String(checks.length)} 条成立；证据写到 ${OUT_FILE}`);
process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
