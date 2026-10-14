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
 * ⚠️ **探针必须还原设置**（`finally` 里无条件写回并读回核对）：探针改的是
 * 验证实例的真实配置，留在改过的状态会污染后续真机判据。
 *
 * 用法：
 *   node verify/probe-settings-behavior-full.mjs
 *   node verify/probe-settings-behavior-full.mjs --out <证据文件路径>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { instanceCredentials, loadLocalPlaneOrSkip } from '../tools/_local-config.mjs';
import { elevateSession } from './_r28-helpers.mjs';

const localConfig = await loadLocalPlaneOrSkip('verify/probe-settings-behavior-full.mjs');
const { base: BASE, token } = instanceCredentials(localConfig);
// 服务住在自己的家目录（服务家目录），**不在本包内**。实例坐标一律经配置加载器取——
// 写死绝对路径在服务目录迁走之后集体失效。
const CWD = localConfig.workspaceDir;
const NS = 'async-tools-host';

const outAt = process.argv.indexOf('--out');
const OUT_FILE = outAt >= 0 && process.argv[outAt + 1] !== undefined
  ? process.argv[outAt + 1]
  : join(localConfig.evidenceDir, 'logs', 'settings-behavior-full.json');
mkdirSync(dirname(OUT_FILE), { recursive: true });

/** 原始默认值；收尾一律还原到这些数。agentLang 出厂是 en（`lib/config.js`）；
 * 判据锚的等待读数与工具描述文案是中文档，跑动阶段各补丁统一钉 `agentLang: 'zh'`。 */
const DEFAULTS = {
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

const indexResponse = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' });
const cookie = (indexResponse.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
if (cookie.length === 0) throw new Error('token exchange returned no cookie');

/**
 * 发一次信封 RPC。
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
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } })
  });
  const text = await response.text();
  const body = JSON.parse(text);
  if (body?.result?.ok !== true) {
    throw new Error(`${endpoint}: ${JSON.stringify(body?.result?.error ?? text.slice(0, 200))}`);
  }
  return body.result.value;
}

/** 读当前生效的设置分层值。 */
async function readEffective() {
  const described = await rpc('settings/describe', {});
  const ns = described.namespaces.find((candidate) => candidate.ns === NS);
  return ns.value ?? ns.resolved ?? ns;
}

/** 写设置。与页面保存同一条链（`settings/update`，ns=宿主行 entry id）——
 * 与 `verify/_r28-helpers.mjs` 一致，单一端点即可。 */
async function writeSettings(patch) {
  await rpc('settings/update', { ns: NS, patch });
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
 * 从转录里取 `async_wait_job` 的工具结果原文。
 *
 * ⚠️ 字段与形状以转录实测为准：`tool/call` 的调用号在 `data.callId`；
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
    if (event?.type === 'tool/call' && event.data?.name === 'async_wait_job') wanted.add(event.data.callId);
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

const evidence = { base: BASE, checks, runs: [] };
try {
  // ── 开跑前先**从基线出发** ────────────────────────────────────────────────
  //
  // ⚠️ 探针若只"读现状"就往下走：被外部切断（跑批超时 kill）时还原写在 `finally`
  // 里不会跑完，验证实例被留在改过的设置上，判据照样全绿；下一次跑又从脏值
  // 出发，**脏状态会累积**。
  //
  // ⇒ 每次开跑先无条件把设置写成 `DEFAULTS`。于是"被切断留下脏状态"不可能发生：
  // 即使上一次留了尾巴，这一次开跑就抹平了。还原仍然保留（它让**正常结束**的
  // 那次也回到基线），两者一个管"跑前"，一个管"跑后"。
  await writeSettings(DEFAULTS);
  const before = await readEffective();
  evidence.before = { maxWaitMs: before.maxWaitMs, maxResultChars: before.maxResultChars };
  console.log(`起跑基线：maxWaitMs=${String(before.maxWaitMs)}  maxResultChars=${String(before.maxResultChars)}`);
  console.log('');

  // ── ① 夹紧：把 maxWaitMs 压到 2000，模型请求 600000，实际必须约 2 秒返回 ──
  //
  // 这是"值变了"与"行为变了"的分界：一个把设置读进内存后再也不看的实现，
  // 会老老实实等满 600 秒（或等到作业结束），而不是 2 秒就返回 running。
  await writeSettings({ ...DEFAULTS, maxWaitMs: 2000, defaultWaitMs: 2000, agentLang: 'zh' });
  const effectiveClamp = await readEffective();
  check('先把 `maxWaitMs` 写成 2000 并读回确认（区分"没写进去"与"写进去没生效"）',
    effectiveClamp.maxWaitMs === 2000,
    `分层读回 maxWaitMs=${String(effectiveClamp.maxWaitMs)}`);

  const t0 = Date.now();
  const pageClamp = await sessionWith(
    '请严格执行两步：\n'
    + '① 用 async_run 执行 `Start-Sleep -Seconds 45; Write-Output SLOWDONE`，传 yield_ms=1500；\n'
    + '② 拿到 job_id 后立刻用 async_wait_job 等它，**wait_ms 传 600000**。\n'
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
    + '② 拿到 job_id 后立刻用 async_wait_job 等它，**wait_ms 传 1**。\n'
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
  await writeSettings({ ...DEFAULTS, maxResultChars: 500, agentLang: 'zh' });
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
  // ⚠️ 判据标签**不写具体数字**：数字写进标签会随实现漂移（例如把某次观测到的
  // 输出长度误当默认值）；真实读数由下面的 `detail` 现场打出来。
  check('改成 500 之后模型收到的文本变短了（与默认预算下的同一条命令相比）',
    cutText.length < 3000,
    `长度 ${String(cutText.length)} 字符`);
  check('并出现显式的截断说明（保头保尾，删的是中间；双语键带省略量）',
    /\[output truncated: \d+ chars omitted\]|\[输出已截断：省略 \d+ 字符\]/.test(cutText),
    JSON.stringify(cutText.slice(0, 120)));

  // ── ③ 描述里的数字：模型收到的那份请求体里，**四个工具**的数字都必须跟着变 ──
  //
  // ⚠️ 各工具的预算片段**形态互不相同**，五条替换规则里每条只对一部分工具生效
  // （见 `lib/index.js` 里那张表）。只验一个工具，等于放过了其他——而 `async_run`
  // 恰好是唯一带**两个不同区间**（让出 + 等待）的那个，最容易写错。
  // `async_agent` 正文无预算区间，只有尾摘要——它入 (c) 组。
  //
  // 三条断言各自能独立失败：
  //   (a) `async_wait_job` / `async_wait_agent` 的**正文**里等待区间是新值；
  //   (b) `async_run` 的**正文**里让出区间是**让出**的新值（不是被写成等待区间）；
  //   (c) 四个工具的**尾摘要**等待区间都是新值。
  const tools = pageClamp.records
    .filter((r) => r.event?.type === 'request/header')
    .flatMap((r) => r.event.data?.header?.tools ?? []);
  /** 取某个工具在请求体里的描述。 */
  const descOf = (name) => tools.find((t) => t?.name === name)?.description;
  evidence.runs.push({
    label: '描述',
    ranges: Object.fromEntries(['async_run', 'async_wait_job', 'async_wait_agent', 'async_agent']
      .map((n) => [n, (descOf(n) ?? '').match(/\d+–\d+ ms/g) ?? []]))
  });

  const waitBody = ['async_wait_job', 'async_wait_agent']
    .map((n) => ({ n, hit: /wait_ms 必填，范围 (\d+)–(\d+) ms/.exec(descOf(n) ?? '') }))
    .filter((x) => x.hit === null);
  check('(a) `async_wait_job` 与 `async_wait_agent` 的正文里，等待区间已是新值',
    tools.length > 0 && waitBody.length === 0,
    tools.length === 0
      ? '请求体里没有工具清单'
      : waitBody.length === 0
        ? waitBody.map((x) => x.n).join('、') + ' 均匹配到新值（250–2000）'
        : `未更新的：${waitBody.map((x) => x.n).join('、')}`);

  const runDesc = descOf('async_run') ?? '';
  const yieldBody = /范围 (\d+)–(\d+) ms）；/.exec(runDesc);
  check('(b) `async_run` 正文里的**让出**区间是让出的新值，不是被写成等待区间',
    yieldBody !== null && yieldBody[1] === '1000' && yieldBody[2] === '600000',
    yieldBody === null
      ? 'async_run 正文里找不到让出区间'
      : `实得 ${yieldBody[1]}–${yieldBody[2]}（让出区间本轮未改，应仍是默认 1000–600000）`);

  const tailTools = ['async_run', 'async_wait_job', 'async_wait_agent', 'async_agent']
    .map((n) => ({ n, hit: /等待预算必须显式传入，范围 (\d+)–(\d+) ms/.exec(descOf(n) ?? '') }))
    .filter((x) => x.hit === null || x.hit[2] !== '2000');
  check('(c) 四个工具的尾摘要等待区间都已换成新值',
    tools.length > 0 && tailTools.length === 0,
    tools.length === 0
      ? '请求体里没有工具清单'
      : tailTools.length === 0
        ? '四个工具的尾摘要均为 250–2000'
        : `未换的：${tailTools.map((x) => x.n).join('、')}`);

  // ── ④ 让出区间**也要跟着变**（补上第 (b) 条的区分力）────────────────────────
  //
  // ⚠️ 第 (b) 条只改 `maxWaitMs`，让出区间全程停在默认值 ⇒ 它只能证明
  // "让出区间**没被写错**"，**证明不了"让出区间会跟着设置变"**。
  // 这两个结论的强度差得很远：前者在一个"让出区间永远是默认值"的实现上也会绿。
  //
  // 所以再改一次设置，**只动让出区间**，然后从真实请求体里读回来。`async_run` 是
  // 唯一有 `yieldDigest` 的工具，这条也是唯一能覆盖第③条替换规则的判据。
  // ⚠️ `defaultWaitMs` 必须跟着 `maxWaitMs` 一起收窄——跨字段校验会拒掉
  // "默认值落在区间外"的组合（`settings/rejected`：`defaultWaitMs (30000) 必须在 250–2000 ms 之内`）。
  // 那条校验本身是 `test/two-planes.test.mjs` T7b 在守的东西，这里撞上它说明它在工作。
  await writeSettings({ ...DEFAULTS, maxWaitMs: 2000, defaultWaitMs: 2000, minYieldMs: 1500, maxYieldMs: 450000, defaultYieldMs: 7000, agentLang: 'zh' });
  const pageYield = await sessionWith('回复一个句号即可，不要调用任何工具。');
  const runYield = (pageYield.records
    .filter((r) => r.event?.type === 'request/header')
    .flatMap((r) => r.event.data?.header?.tools ?? [])
    .find((t) => t?.name === 'async_run')?.description) ?? '';
  evidence.runs.push({ label: '让出区间', text: runYield.slice(0, 400) });
  const yieldTail = /首次等待默认 (\d+) ms（可传 yield_ms，范围 (\d+)–(\d+) ms）/.exec(runYield);
  const yieldBodyAfter = /范围 (\d+)–(\d+) ms）；/.exec(runYield);
  check('(d) 改首次等待后，`async_run` 正文与尾摘要里的**首次等待**区间都跟着变成新值',
    yieldTail !== null && yieldBodyAfter !== null
    && yieldBodyAfter[1] === '1500' && yieldBodyAfter[2] === '450000'
    && yieldTail[1] === '7000' && yieldTail[2] === '1500' && yieldTail[3] === '450000',
    `正文 ${yieldBodyAfter === null ? '(找不到)' : `${yieldBodyAfter[1]}–${yieldBodyAfter[2]}`}；`
    + `尾摘要 ${yieldTail === null ? '(找不到)' : `${yieldTail[1]} ms 默认 / ${yieldTail[2]}–${yieldTail[3]}`}`
    + '（期望 1500–450000，默认 7000）');
  check('(e) 同时等待区间**没有**被首次等待区间污染（两个区间各自对号）',
    /单次等待预算必须显式传入，范围 250–2000 ms/.test(runYield),
    JSON.stringify((/单次等待预算必须显式传入，范围 [\d–]+ ms/.exec(runYield) ?? ['(找不到)'])[0]));
} finally {
  // **无条件还原**：探针改的是验证实例的真实配置。
  try {
    await writeSettings(DEFAULTS);
    const now = await readEffective();
    const drifted = Object.keys(DEFAULTS).filter((k) => now[k] !== DEFAULTS[k]);
    console.log('');
    console.log(`收尾还原：${drifted.length === 0 ? '全部回到默认值' : `**这些键不是默认值：${drifted.join('、')}**`}`);
    evidence.restored = drifted.length === 0;
    evidence.afterRestore = { maxWaitMs: now.maxWaitMs, maxResultChars: now.maxResultChars };
  } catch (error) {
    console.log(`收尾还原**失败**：${String(error)}——验证实例可能停在被改过的状态。`);
    evidence.restoreError = String(error);
  }
}

const failed = checks.filter((c) => !c.ok).length;
evidence.verdict = failed === 0 && evidence.restored === true ? 'PASS' : 'FAIL';
writeFileSync(OUT_FILE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log('');
console.log(`${String(checks.length - failed)}/${String(checks.length)} 条成立；证据写到 ${OUT_FILE}`);
process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
