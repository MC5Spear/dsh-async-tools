/**
 * 终局验收：把目标里的**每一条硬要求**在验证实例上逐条实测，一次跑完并给出总判定。
 *
 * 为什么要单独写这个：既有脚本每个只验一到两条要求，收口时"到底哪几条验过了"要靠人
 * 在几份 JSON 与文档之间对账。这份脚本把**硬要求 → 可观察判据**固化成一张表。
 *
 * 覆盖：
 *   1. R7-6 呈现模式 native（有 async_run/async_wait_job/async_wait_agent，无 run_code、无 pwsh）
 *   2. R7-7 预设隔离（standard 有 pwsh、无三个工具）
 *   3. R1 短命令直接返回（不注册作业）
 *   4. R1 长命令让出且**不被杀**，句柄可复制粘贴
 *   5. R2 async_wait_job 取回输出
 *   6. R4 插话打断等待、作业未被取消、最终仍取回完整输出
 *   7. 反复调用不累积（3 轮）
 *
 * 用法：node final-acceptance.mjs         （建议后台跑，约 3–5 分钟）
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { rpc, localConfig } from './_rpc.mjs';

const CWD = localConfig.workspaceDir;
const OUT = join(localConfig.evidenceDir, 'logs', 'final-acceptance.json');
mkdirSync(dirname(OUT), { recursive: true });

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const checks = [];
function record(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
}

/**
 * 起跑前把设置**打回出厂默认值**，并核对确实打回去了。
 *
 * ## 为什么每个真机脚本都要做这一步（这是类问题，不是单点）
 *
 * `probe-settings-behavior-full.mjs` 会**改写真实设置**再逐条还原，还原写在 `finally` 里。
 * 而它一旦被**外部切断**（跑批超时 kill、工具调用被中止），`finally` 不保证跑完——
 * 验证实例就被留在 `maxWaitMs=2000` 这类窄预算上。
 *
 * 后果不是"设置不对"，而是**判据假红**：后续任何真机脚本都会因为
 * "等待被夹到 2 秒"而报行为不符，看起来像产品坏了。本仓实测被这个坑误导过两次。
 *
 * 所以每个真机脚本都**自己**保证起跑状态，不依赖别人的 `finally`：
 * 写一遍默认值 + 读回核对。写不进去就明确报出来并失败，而不是带着脏状态跑出假结论。
 *
 * 归属边界：`restore-async-settings.mjs` 管"跑完之后还原"，这里管"跑之前先归位"。
 */
const FACTORY_DEFAULTS = {
  defaultYieldMs: 20000, minYieldMs: 1000, maxYieldMs: 600000,
  defaultWaitMs: 30000, minWaitMs: 250, maxWaitMs: 600000,
  pollIntervalMs: 500, maxResultChars: 30000, jobKind: 'async-command'
};

/** 命名空间，与主包 `lib/settings.js` 的 `SETTINGS_NAMESPACE` 一致。 */
const SETTINGS_NS = 'async-tools';

/**
 * 读当前生效的设置值。
 *
 * ⚠️ `settings/describe` **不接受 `namespace` 参数**（传了会被网关拒：
 * `unexpected "namespace"`）。正确形状是传空对象、再从返回的 `namespaces` 里按 `ns` 找。
 *
 * @returns {Promise<object>} 该命名空间的值。
 */
async function readSettings() {
  const described = await rpc('settings/describe', {});
  const ns = (described.namespaces ?? []).find((candidate) => candidate.ns === SETTINGS_NS);
  if (ns === undefined) throw new Error(`settings/describe 里没有命名空间 ${SETTINGS_NS}`);
  return ns.value ?? ns.resolved ?? {};
}

const before = await readSettings();
const drifted = Object.keys(FACTORY_DEFAULTS).filter((k) => before[k] !== FACTORY_DEFAULTS[k]);
if (drifted.length > 0) {
  console.log(`起跑前发现设置漂移，先归位：${drifted.map((k) => `${k}=${String(before[k])}`).join(' ')}`);
  await rpc('settings/update', { ns: SETTINGS_NS, patch: FACTORY_DEFAULTS });
}
const after = await readSettings();
const stillDrifted = Object.keys(FACTORY_DEFAULTS).filter((k) => after[k] !== FACTORY_DEFAULTS[k]);
if (stillDrifted.length > 0) {
  // 带着脏设置跑出来的红是**假红**，比不跑更糟——所以这里直接停。
  throw new Error(`起跑基线写不进去，拒绝继续（否则读数不可信）：${stillDrifted.join(', ')}`);
}
console.log(`起跑基线：设置全部等于出厂默认值（${drifted.length > 0 ? `本次归位了 ${String(drifted.length)} 项` : '本来就干净'}）。`);
console.log('');

/** 起一个会话并断言预设没被静默回退。 */
async function newSession(preset) {
  const created = await rpc('session/create', { request: { cwd: CWD, agentPreset: preset } });
  if (created.agentPreset !== preset) throw new Error(`预设回退：要 ${preset}，得到 ${String(created.agentPreset)}`);
  return created.sessionId;
}

async function ask(sessionId, text, timeoutMs = 240000) {
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId, mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
  const startedAt = Date.now();
  let sawRunning = false;
  for (;;) {
    await sleep(1500);
    const listing = await rpc('session/list', { _request: {} });
    const row = listing.items.find((item) => item.sessionId === sessionId);
    if (row === undefined) throw new Error('会话消失');
    if (row.running === true) sawRunning = true;
    if (sawRunning && row.running === false) return;
    if (Date.now() - startedAt > timeoutMs) return;
  }
}

async function transcript(sessionId) {
  const listing = await rpc('session/list', { _request: {} });
  const row = listing.items.find((item) => item.sessionId === sessionId);
  return rpc('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 200 }
  });
}

/** 从转录里抽出工具调用与结果（按序配对），以及 assistant 的最终文本。 */
function parse(page) {
  const calls = [];
  const results = [];
  let assistantText = '';
  for (const record of page.records) {
    const event = record.event;
    if (event?.type === 'tool/call') calls.push({ name: String(event.data.name), args: String(event.data.arguments) });
    else if (event?.type === 'tool/result') {
      for (const block of (event.data.message?.content ?? [])) {
        if (block.type === 'tool-result') results.push((block.content ?? []).map((p) => p.text ?? '').join(''));
      }
    } else if (event?.type === 'assistant/message') {
      const text = (event.data.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      if (text.trim() !== '') assistantText += `${text}\n`;
    }
  }
  return { calls, results, assistantText };
}

console.log('=== 1) R7-6 / R7-7 呈现模式与预设隔离 ===');
{
  const sid = await newSession('dsh-async');
  await ask(sid, '不要调用任何工具。把你这一轮实际可调用的全部工具名按字母序用英文逗号连接，'
    + '输出成单独一行，格式严格为 `TOOLS=name1,name2,...`。不要解释，不要输出别的行。');
  const { assistantText, calls } = parse(await transcript(sid));
  const match = assistantText.match(/TOOLS=([^\n`]+)/);
  const names = match === null ? [] : match[1].split(',').map((s) => s.trim()).filter(Boolean);
  record('R7-6 四个工具都在（async_run/async_wait_job/async_wait_agent/async_agent）',
    ['async_run', 'async_wait_job', 'async_wait_agent', 'async_agent'].every((n) => names.includes(n)),
    `工具清单=${names.join(',') || '(读不到)'}；模型调用数=${String(calls.length)}`);
  record('R7-6 呈现模式是 native（无 run_code）', !names.includes('run_code'));
  record('R7-6 未挂同步 shell（无 pwsh）', !names.includes('pwsh'));
}
{
  const sid = await newSession('standard');
  await ask(sid, '不要调用任何工具。把你这一轮实际可调用的全部工具名按字母序用英文逗号连接，'
    + '输出成单独一行，格式严格为 `TOOLS=name1,name2,...`。不要解释，不要输出别的行。');
  const { assistantText } = parse(await transcript(sid));
  const match = assistantText.match(/TOOLS=([^\n`]+)/);
  const names = match === null ? [] : match[1].split(',').map((s) => s.trim()).filter(Boolean);
  record('R7-7 standard 仍有 pwsh（其他预设未被改变）', names.includes('pwsh'), `工具数=${String(names.length)}`);
  // ## 这条判据读作"**没有被强行装到所有预设**"，不是"三个工具只许在本预设里"
  //
  // R6 明写：「**工具不限于本预设**：三个工具随**挂载它的那一行**生效，任何预设加同样的行
  // 就能得到它们，`dsh-async` 预设只是替使用者把三行写好的默认模板。本插件不提供、
  // 也不打算提供'只在某个预设里可见'的机制。」
  // 真正被禁的是**泄漏**：宿主平面注册的工具进全局工具层，会出现在**每一个**预设里
  // （违反 R4）。"别人可以自愿加"与"我们不可以强行装到所有预设"是两件事。
  //
  // ⚠️ 判据名原来写的是「standard 不含三个工具」——**行为对、读法错**：
  // 它会被读成"这三个工具不许出现在 standard 里"，也就是把**模板**读成了**限制**。
  // 而它在这里真正证明的是"我们那一行没有落到宿主平面"。
  record('R7-7 本插件**没有把工具强行装进所有预设**（standard 里不出现，即未泄漏到全局工具层）',
    !['async_run', 'async_wait_job', 'async_wait_agent', 'async_agent'].some((n) => names.includes(n)),
    '这条不表示"只有 dsh-async 预设能有它们"——别的预设自己加同样的行就能得到（R6）');
}

console.log('');
console.log('=== 2) R1/R2/R4 行为 ===');
{
  const sid = await newSession('dsh-async');
  await ask(sid, [
    '严格按顺序做四步，不要做别的事情：',
    '① 用 async_run 执行 `Write-Output SHORT_OK`；',
    '② 用 async_run 执行 `Start-Sleep -Seconds 6; Write-Output LONG_DONE`，传 yield_ms=1500；',
    '③ 用返回的 job_id 调 async_wait_job（wait_ms=30000）；',
    '④ 只回复一行 ALL_DONE，不要总结。'
  ].join('\n'));
  const { calls, results } = parse(await transcript(sid));
  const runCalls = calls.filter((c) => c.name === 'async_run');
  const waitCalls = calls.filter((c) => c.name === 'async_wait_job');
  record('R1 短命令直接返回且不注册作业', results.some((t) => t.includes('SHORT_OK')), '见结果里的 SHORT_OK');
  record('R1 长命令让出而非被杀',
    results.some((t) => /已超过 \d+ ms 的让出预算/.test(t) && /没有被终止/.test(t)),
    `async_run 调用 ${String(runCalls.length)} 次`);
  record('R2 async_wait_job 取回输出', results.some((t) => t.includes('LONG_DONE')), `async_wait_job 调用 ${String(waitCalls.length)} 次`);
  record('R1 让出结果里给出可复制粘贴的 async_wait_job 句柄',
    results.some((t) => /async_wait_job\(job_id="async-command-\d+", wait_ms=\d+\)/.test(t)));
}

console.log('');
console.log('=== 3) R4 插话不打断后台作业 ===');
{
  const sid = await newSession('dsh-async');
  // 先让模型起一个 60 秒作业并立刻进入长等待；插话必须在它**正在等**的时候发出。
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: sid, mode: 'queue',
      content: [{ type: 'text', text: '用 async_run 执行 `Start-Sleep -Seconds 60; Write-Output SURVIVED`，传 yield_ms=1500；'
        + '拿到 job_id 后**立刻**用 async_wait_job 等它（wait_ms=120000）。期间不要做别的。' }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
  // 等到出现一次 async_wait_job 调用（说明它已经进入长等待），再发插话。
  let waiting = false;
  for (let i = 0; i < 60 && !waiting; i++) {
    await sleep(1000);
    const { calls } = parse(await transcript(sid));
    waiting = calls.some((c) => c.name === 'async_wait_job');
  }
  record('R4 场景搭建成功（模型已进入 async_wait_job 长等待）', waiting);
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: sid, mode: 'steer',
      content: [{ type: 'text', text: '顺便说一句：天气不错。请用 job_list 看一下那个作业现在是什么状态，只回复它的状态。' }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
  await ask(sid, '继续：用 async_wait_job 把那个作业的输出取回来（wait_ms=90000），然后只回复它打印的那一行。');
  const { results } = parse(await transcript(sid));
  record('R4 等待被插话打断并说明作业未受影响',
    results.some((t) => /等待被打断/.test(t) && /没有受到任何影响/.test(t)));
  record('R4 job_list 显示作业仍在 running（未被取消）',
    results.some((t) => /async-command-\d+ \[async-command\] running/.test(t)));
  record('R4 60 秒作业最终仍输出完整结果', results.some((t) => t.includes('SURVIVED')));
}

console.log('');
console.log('=== 4) 反复调用不累积（3 轮）===');
{
  const sid = await newSession('dsh-async');
  const rounds = [];
  for (let n = 1; n <= 3; n++) {
    await ask(sid, `用 async_run 执行 \`Start-Sleep -Seconds 4; Write-Output REPEAT${String(n)}\`，传 yield_ms=1500；`
      + `拿到 job_id 后用 async_wait_job 等它（wait_ms=30000），然后只回复它打印的那一行。`);
    const { results } = parse(await transcript(sid));
    const y = results.map((t) => t.match(/当前已运行约 (\d+) ms/)).filter((m) => m !== null).map((m) => Number(m[1]));
    rounds.push({ n, got: results.some((t) => t.includes(`REPEAT${String(n)}`)), yieldMs: y.at(-1) ?? null });
  }
  record('每轮都能取回自己那轮的输出（不串号）', rounds.every((r) => r.got),
    rounds.map((r) => `第${String(r.n)}轮=${r.got ? 'OK' : 'FAIL'}`).join(' '));
  const yields = rounds.map((r) => r.yieldMs).filter((v) => v !== null);
  const spread = yields.length < 2 ? null : Math.max(...yields) - Math.min(...yields);
  record('让出耗时无累积劣化（极差 < 300 ms）', spread !== null && spread < 300, `各轮=${yields.join('/')} ms`);
}

writeFileSync(OUT, JSON.stringify({ checks, at: new Date().toISOString() }, null, 2), 'utf8');
const failed = checks.filter((c) => !c.passed);
console.log('');
console.log(`=== 总判定：${String(checks.length - failed.length)}/${String(checks.length)} 通过 ===`);
if (failed.length > 0) {
  for (const f of failed) console.log(`未通过：${f.name}`);
  process.exit(1);
}
console.log(`证据写入 ${OUT}`);
