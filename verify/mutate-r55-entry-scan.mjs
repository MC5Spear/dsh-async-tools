/**
 * 守哪条需求：需求 §2.2（等待入口对先到插话的起始检查）五判据
 * （五状态机＋精确红面核验）。
 *
 * 五个变异，方向互补，缺一个就有无守卫的防线：
 * - MA **纯事件驱动回潮**：两工具的起始检查调用点失效 → C1a/C1b 必红（判据 1 的
 *   "改回必红"；C1 组自带挂起护栏，回潮时红得快而不是挂死套件）；同时既有 T2
 *   （等待中插话 → interrupted）必须仍绿——红的必须是新判据，绿的必须是旧判据，
 *   两者合成完整证明。
 * - MB **拆 kind 过滤**：`preexistingSteering` 认 next-step 里一切消息 → 转达/结算/
 *   迟到作答滞留也打断 → C2a/C2b＋读侧/起始检查 kind 守卫用例红（判据 2 负面对照一）。
 * - MC **加扫 next-turn**：排队消息也命中 → C3a/C3b＋读侧用例红（判据 3 负面对照二，
 *   打断语义不回归——需求 §2.1.2）。
 * - MD **wait-agent 去结算并存决定**：起始命中即无条件 interrupted → C5a 红（判据 5）。
 * - ME **wait-job 停点前移**：屏障终态判定对插话在场让路 → C5b 红（判据 5，停点防回归）。
 *
 * 核验口径：每个变异的**精确红面**＝按文件分组的用例名集合与
 * 下方 expectFail 名单双向相等，且 expectPass（两条既有 T2 用例）保持绿——红面多
 * 一条少一条都算 MISPLACED（非零退出），不是 CAUGHT。结局五状态分清：green / red /
 * timeout / didnt-run / incomplete——超时不算 CAUGHT（挂起护栏 250 ms 让真红快过
 * 超时），没跑成（spawn EPERM）与摘要不完整统一 fail-closed，不产生假 CAUGHT。
 *
 * ⚠️ **本脚本会原地改写 `lib/interrupts.js`、`lib/wait-agent.js`、`lib/wait-job.js`**，
 * 跑完在 `finally` 里写回并逐文件核对摘要。受限沙箱会杀 node→node spawn
 * （EPERM）——按"没跑成不算 CAUGHT"fail-closed，换宽松环境或提权重跑。
 * **逐文件各跑一次**（不加 `--test-isolation` 旗标）：node v24.x 的 tap reporter 在
 * 多文件成功时输出**平铺无文件归属**（全局连续编号、无文件级条目——实测；文件级
 * `# Subtest: <路径>` 条目只在子进程失败形态出现），同名用例跨文件无法区分；逐文件
 * 跑让每次 TAP 自带归属（文件内用例名唯一），解析按缩进 0 的 `ok|not ok` 行取名字。
 * 跨版本格式漂移按 incomplete fail-closed，不产生假 CAUGHT——见 verify/README
 * 「TAP 解析的版本口径」。
 *
 * 用法：node verify/mutate-r55-entry-scan.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从模块自身位置推仓根（verify/ 上一级）——变异脚本要在任意 cwd 下都能跑。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARGET_FILES = ['lib/interrupts.js', 'lib/wait-agent.js', 'lib/wait-job.js'];
const TESTS = ['test/interrupt.test.mjs', 'test/wait-job.test.mjs', 'test/wait-agent.test.mjs'];

const originals = new Map(TARGET_FILES.map((rel) => {
  const path = join(ROOT, rel);
  const content = readFileSync(path, 'utf8');
  return [rel, { path, content, hash: createHash('sha256').update(content, 'utf8').digest('hex') }];
}));

/** spawn 没跑起来（沙箱拒绝、找不到可执行）时 execFileSync 错误的 code 形态。 */
const SPAWN_FAILURE_CODES = new Set(['EPERM', 'ENOENT', 'EACCES']);

/**
 * 解析**单个测试文件**的 TAP 输出（实测形状：node v24.x）。
 *
 * 形状约定：单文件成功流为顶层平铺——缩进 0 的 `ok|not ok N - <名>` 叶子行
 * （剥 ` # SKIP` / ` # TODO` 类后缀）＋尾部 `# tests/pass/fail/skipped/cancelled`
 * 摘要行；子进程失败形态是 1 条顶层 `not ok 1 - <路径>` ＋缩水的 `# tests`（恰好
 * 落 incomplete，不冒充 red）。文件内用例名唯一（本仓测试名带判据编号，实测无重名）。
 *
 * @param {string} out - 子进程 stdout＋stderr 合并文本。
 * @returns {{complete: boolean, summary: {tests: number, fail: number, skipped: number,
 *   cancelled: number}, redNames: string[]}}
 */
function parseTap(out) {
  const summary = { tests: -1, fail: -1, skipped: -1, cancelled: -1 };
  const names = [];
  const redNames = [];
  for (const line of out.split(/\r?\n/)) {
    let m = /^(ok|not ok) \d+ - (.+)$/.exec(line);
    if (m !== null) {
      const name = m[2].replace(/\s+# (SKIP|TODO)\b.*$/u, '');
      names.push(name);
      if (m[1] === 'not ok') redNames.push(name);
      continue;
    }
    m = /^# tests (\d+)$/u.exec(line);
    if (m !== null) summary.tests = Number(m[1]);
    m = /^# fail (\d+)$/u.exec(line);
    if (m !== null) summary.fail = Number(m[1]);
    m = /^# skipped (\d+)$/u.exec(line);
    if (m !== null) summary.skipped = Number(m[1]);
    m = /^# cancelled (\d+)$/u.exec(line);
    if (m !== null) summary.cancelled = Number(m[1]);
  }
  const caseCount = names.length;
  const complete = summary.tests >= 0 && summary.fail >= 0 && summary.skipped >= 0
    && summary.cancelled >= 0 && caseCount === summary.tests;
  return { complete, summary, names, redNames };
}

/**
 * 跑**一个**测试文件并解析结局。五状态分清（把"没跑成/没跑完"记成 CAUGHT 是假绿）：
 * green（退出 0＋摘要完整＋零失败）/ red（非 0 退出＋摘要完整＋用例数与基线一致）/
 * timeout（超时击杀——挂起本身就是失败，但**不算 CAUGHT**）/ didnt-run（spawn 失败）/
 * incomplete（其余：摘要残缺、用例数缩水）。
 *
 * @param {string} testFile - 相对仓根的测试文件路径。
 * @param {number} timeoutMs - 超时；MA 回潮形态由用例的挂起护栏兜住（250 ms 标记），
 *   真红快于超时。
 * @param {number|null} baselineTests - 该文件基线用例数；red 判定要求与基线一致。
 * @returns {{state: 'green'|'red'|'timeout'|'didnt-run'|'incomplete', summary: string,
 *   parsed: object}} 结果。
 */
function runFile(testFile, timeoutMs, baselineTests = null) {
  let error;
  let out = '';
  try {
    out = execFileSync(process.execPath,
      ['--import', './tools/_host-hooks.mjs', '--test', '--test-reporter=tap', testFile],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    const parsed = parseTap(out);
    const green = parsed.complete && parsed.summary.fail === 0
      && parsed.summary.skipped === 0 && parsed.summary.cancelled === 0;
    return {
      state: green ? 'green' : 'incomplete',
      summary: `# tests ${String(parsed.summary.tests)} / fail ${String(parsed.summary.fail)}`,
      parsed
    };
  } catch (thrown) {
    error = thrown;
  }
  out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  const timedOut = error.killed === true || error.code === 'ETIMEDOUT';
  const spawnFailed = !timedOut
    && (SPAWN_FAILURE_CODES.has(error.code) || (error.status == null && out === ''));
  if (spawnFailed) {
    return {
      state: 'didnt-run',
      summary: `没跑成（spawn 失败：${String(error.code ?? error.message).slice(0, 80)}）——受限沙箱会杀 node→node spawn，提权或宽松环境重跑`,
      parsed: null
    };
  }
  if (timedOut) {
    return { state: 'timeout', summary: '（超时击杀——挂起本身就是红，但不算 CAUGHT）', parsed: null };
  }
  const parsed = parseTap(out);
  const red = parsed.complete && parsed.summary.fail > 0
    && (baselineTests === null || parsed.summary.tests === baselineTests);
  return {
    state: red ? 'red' : 'incomplete',
    summary: red
      ? `# tests ${String(parsed.summary.tests)} / fail ${String(parsed.summary.fail)}`
      : `摘要不完整或用例数漂移（tests ${String(parsed.summary.tests)}，基线 ${String(baselineTests)}）——按 incomplete fail-closed`,
    parsed
  };
}

/** 三个测试文件逐个跑；任一文件非 {green, red} 即整体非 green——red 的文件
 *  不掩盖别文件的未完成（incomplete 也要浮上来，didnt-run 最优先）。 */
function runAll(timeoutMs, baselines = null) {
  const perFile = {};
  let state = 'green';
  for (const file of TESTS) {
    const r = runFile(file, timeoutMs, baselines === null ? null : baselines[file]);
    perFile[file] = r;
    if (r.state === 'didnt-run') state = 'didnt-run';
    else if (r.state === 'timeout' && state !== 'didnt-run') state = 'timeout';
    else if (r.state === 'incomplete' && state !== 'didnt-run' && state !== 'timeout') state = 'incomplete';
    else if (r.state === 'red' && state === 'green') state = 'red';
  }
  return { state, perFile };
}

/** 写回原文并逐文件核对摘要。 */
function restore() {
  for (const { path, content, hash } of originals.values()) {
    writeFileSync(path, content, 'utf8');
    const after = createHash('sha256').update(readFileSync(path, 'utf8'), 'utf8').digest('hex');
    if (after !== hash) throw new Error(`还原失败：${path} 与变异前不一致，请 git checkout 恢复。`);
  }
}

/** 对指定文件应用一组锚点替换。锚唯一性计数门：任一锚出现次数 ≠ 1 →
 *  整个变异失效当失败处理（撞句在变异前暴露，不靠红面反推）。 */
function applyVariant(patches) {
  for (const { file, anchor } of patches) {
    const entry = originals.get(file);
    const count = entry.content.split(anchor).length - 1;
    if (count !== 1) {
      return `锚唯一性失败（${file} 出现 ${String(count)} 次）：${anchor.slice(0, 60)}`;
    }
  }
  for (const { file, anchor, mutated } of patches) {
    const entry = originals.get(file);
    writeFileSync(entry.path, entry.content.replace(anchor, mutated), 'utf8');
  }
  return null;
}

// ── 锚点（含缩进的完整字面量；与 `isSteering` 的 2 空格同句靠 4 空格缩进区分）──
const INTERRUPT_FIND = '    return nextStep.find((message) => message?.source?.kind === USER_MESSAGE_SOURCE) ?? null;';
const INTERRUPT_LIST = '    const nextStep = agent?.inbox?.nextStep;';
const AGENT_SCAN = '      const earlySteer = preexistingSteering(agent);';
const AGENT_ADJUDICATE = '        if (unclaimedSettlement(agent, agentId) !== null) {';
const JOB_SCAN = '      if (preexistingSteering(exec.agent) !== null) {';
const JOB_TERMINAL = '      if (TERMINAL.has(barrier.status)) return settledResult(barrier);';

// 期望红面（红面多一条少一条都算 MISPLACED）与期望绿面（T2 两例）。
const EXPECT_PASS = [
  { file: 'test/wait-agent.test.mjs', name: 'async_wait_agent（T2）：用户插话 → interrupted，子代理一次都没被碰过' },
  { file: 'test/wait-job.test.mjs', name: 'async_wait_job（T2）：用户插话 → interrupted，作业一次都没被碰过' }
];

const variants = [
  {
    name: 'MA',
    note: '纯事件驱动回潮（两工具起始检查拆除）→ C1a/C1b/C5a 红、既有 T2 仍绿（挂起护栏 250 ms 兜住回潮形态，红得快不是挂死）',
    timeoutMs: 120000,
    expectFail: [
      { file: 'test/wait-agent.test.mjs', name: 'R55（判据 1）：等待开始时 next-step 已有 user 插话 → 立即 interrupted，不订阅不进屏障' },
      { file: 'test/wait-job.test.mjs', name: 'R55（判据 1）：等待开始时 next-step 已有 user 插话 → 立即 interrupted，不接线不创建 waiter' },
      { file: 'test/wait-agent.test.mjs', name: 'R55（判据 5）：先到插话与未领取结算通知并存 → settled（结束优先于打断，入口侧）' }
    ],
    patches: [
      { file: 'lib/wait-agent.js', anchor: AGENT_SCAN, mutated: '      const earlySteer = null; // mutated MA: 起始检查拆除' },
      { file: 'lib/wait-job.js', anchor: JOB_SCAN, mutated: '      if (false) { // mutated MA: 起始检查拆除' }
    ]
  },
  {
    name: 'MB',
    note: '拆 kind 过滤（next-step 一切消息都算先到插话）→ 读侧两例＋R30 起始检查 kind 守卫＋C2a/C2b 红',
    timeoutMs: 120000,
    expectFail: [
      { file: 'test/interrupt.test.mjs', name: 'preexistingSteering（R55）：nextStep 已有 user 插话 → 命中该消息' },
      { file: 'test/interrupt.test.mjs', name: 'preexistingSteering（R55）：转达/结算/迟到作答在 next-step 也不命中（判定与 R12 同源）' },
      { file: 'test/wait-agent.test.mjs', name: 'async_wait_agent（R30 通道轮 起始检查）：作答先到、等待后开 → 立即运行句柄 + note（不空转预算）' },
      { file: 'test/wait-agent.test.mjs', name: 'R55（判据 2·负面对照一）：next-step 滞留的是转达/结算/迟到作答 → 不打断，迟到作答照旧唤醒' },
      { file: 'test/wait-job.test.mjs', name: 'R55（判据 2·负面对照一）：next-step 滞留的是转达/结算/迟到作答 → 不打断，迟到作答照旧唤醒' }
    ],
    patches: [
      {
        file: 'lib/interrupts.js', anchor: INTERRUPT_FIND,
        mutated: '    return nextStep.find((message) => message != null) ?? null; // mutated MB: 拆 kind 过滤'
      }
    ]
  },
  {
    name: 'MC',
    note: '加扫 next-turn（排队消息也命中）→ 读侧一例＋C3a/C3b 红（R12 不回归）',
    timeoutMs: 120000,
    expectFail: [
      { file: 'test/interrupt.test.mjs', name: 'preexistingSteering（R55）：next-turn 的 user 排队消息不命中（排队不打断，R12 不回归）' },
      { file: 'test/wait-agent.test.mjs', name: 'R55（判据 3·负面对照二）：next-turn 排队 user 消息、next-step 干净 → 不打断（R12 不回归）' },
      { file: 'test/wait-job.test.mjs', name: 'R55（判据 3·负面对照二）：next-turn 排队 user 消息、next-step 干净 → 不打断（R12 不回归）' }
    ],
    patches: [
      {
        file: 'lib/interrupts.js', anchor: INTERRUPT_LIST,
        mutated: '    const nextStep = [...(Array.isArray(agent?.inbox?.nextStep) ? agent?.inbox.nextStep : []), ...(Array.isArray(agent?.inbox?.nextTurn) ? agent?.inbox.nextTurn : [])]; // mutated MC: 加扫 next-turn'
      }
    ]
  },
  {
    name: 'MD',
    note: 'wait-agent 去结算并存决定（命中即无条件 interrupted）→ C5a 红',
    timeoutMs: 120000,
    expectFail: [
      { file: 'test/wait-agent.test.mjs', name: 'R55（判据 5）：先到插话与未领取结算通知并存 → settled（结束优先于打断，入口侧）' }
    ],
    patches: [
      { file: 'lib/wait-agent.js', anchor: AGENT_ADJUDICATE, mutated: '        if (false) { // mutated MD: 去结算并存决定' }
    ]
  },
  {
    name: 'ME',
    note: 'wait-job 停点前移（终态判定对插话在场让路）→ C5b 红',
    timeoutMs: 120000,
    expectFail: [
      { file: 'test/wait-job.test.mjs', name: 'R55（判据 5）：作业已终态 + 先到插话并存 → 完成结果（结束优先于打断，入口侧）' }
    ],
    patches: [
      {
        file: 'lib/wait-job.js', anchor: JOB_TERMINAL,
        mutated: '      if (TERMINAL.has(barrier.status) && preexistingSteering(exec.agent) === null) return settledResult(barrier); // mutated ME: 停点前移'
      }
    ]
  }
];

const baselineRun = runAll(120000);
if (baselineRun.state !== 'green') {
  const firstBad = TESTS.map((f) => baselineRun.perFile[f]).find((r) => r.state !== 'green');
  console.log(`BASELINE-${baselineRun.state === 'red' ? 'RED' : baselineRun.state === 'incomplete' ? 'INCOMPLETE' : baselineRun.state === 'timeout' ? 'TIMEOUT' : 'DIDNT-RUN'}  未变异时不是绿的（${firstBad.summary}）——先修基线/换环境。`);
  process.exit(2);
}
const baselines = Object.fromEntries(TESTS.map((f) => [f, baselineRun.perFile[f].parsed.summary.tests]));
console.log(`基线：未变异时三个测试文件全绿（${TESTS.map((f) => `${f.split('/').pop()} ${String(baselines[f])}`).join('、')}）。`);
console.log('');

let ok = true;
try {
  for (const variant of variants) {
    const anchorMissing = applyVariant(variant.patches);
    if (anchorMissing !== null) {
      console.log(`SKIP  ${variant.name} ${anchorMissing}——本变异失效，当失败处理。`);
      ok = false;
      continue;
    }
    const after = runAll(variant.timeoutMs, baselines);
    if (after.state !== 'red') {
      // 五状态里只有 red 能进一步核验红面；timeout/didnt-run/incomplete 一律 fail-closed。
      const badFile = TESTS.find((f) => after.perFile[f].state !== 'green' && after.perFile[f].state !== 'red');
      const label = after.state === 'didnt-run' ? 'DIDNT-RUN' : after.state === 'timeout' ? 'TIMEOUT' : 'INCOMPLETE';
      console.log(`${label}  ${variant.name} ${variant.note}  ${after.perFile[badFile].summary} —— 不算 CAUGHT（fail-closed）`);
      ok = false;
    } else {
      // 精确红面核验：按文件分组的观测红面与 expectFail 双向相等＋expectPass（T2 两例）保持绿
      //（红文件按基线用例数核过完整性；绿文件按 green 判定天然零失败）。
      const expectedByFile = {};
      for (const { file, name } of variant.expectFail) {
        (expectedByFile[file] ??= []).push(name);
      }
      let misplaced = false;
      for (const file of TESTS) {
        const expected = new Set(expectedByFile[file] ?? []);
        const observed = new Set(after.perFile[file].state === 'red' ? after.perFile[file].parsed.redNames : []);
        const missing = [...expected].filter((n) => !observed.has(n));
        const extra = [...observed].filter((n) => !expected.has(n));
        if (missing.length > 0) {
          console.log(`MISPLACED-REDFACE  ${variant.name} ${file} 期望红但没红：${missing.join(' | ')}`);
          misplaced = true;
        }
        if (extra.length > 0) {
          console.log(`MISPLACED-REDFACE  ${variant.name} ${file} 没料到的红：${extra.join(' | ')}`);
          misplaced = true;
        }
      }
      const passOk = EXPECT_PASS.every(({ file, name }) => {
        const r = after.perFile[file];
        // 存在性防线：T2 用例名若漂移（重命名/删除），"绿文件"的宽容判定会
        // 静默空转——先断言名字真在解析结果里，再判绿。
        if (r.state === 'green') return r.parsed.names.includes(name);
        if (r.state === 'red') return !r.parsed.redNames.includes(name) && r.parsed.names.includes(name);
        return false;
      });
      if (misplaced) {
        console.log(`  （${variant.name} 红面与名单不符——这不是 CAUGHT）`);
        ok = false;
      } else if (!passOk) {
        console.log(`MISPLACED-REDFACE  ${variant.name} expectPass（T2 两例）有变红——旧判据被殃及`);
        ok = false;
      } else {
        console.log(`CAUGHT  ${variant.name} ${variant.note}  ${TESTS.filter((f) => after.perFile[f].state === 'red').map((f) => `${f.split('/').pop()} fail ${String(after.perFile[f].parsed.summary.fail)}`).join('、')}`);
      }
    }
    // 每个变异跑完立即还原，失败也复原（finally 之外再兜一层）。
    restore();
  }
} finally {
  restore();
}
console.log('');
console.log(ok ? '变异被抓住且红面精确：R55 五判据都有能失败的判据（含两组负面对照与结束优先并存决定）。' : '**变异逃逸、没跑成或红面错置**——判据是恒真的，红面漂移了，或环境不可用。');
console.log('还原完成，摘要一致。');
process.exitCode = ok ? 0 : 1;
