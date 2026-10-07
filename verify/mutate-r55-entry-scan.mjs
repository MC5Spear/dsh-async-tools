/**
 * 守哪些需求：R55（等待工具对先到插话的起始检查）五判据——设计 §42.2 变异口径。
 *
 * 五个变异，方向互补，缺一个就有无守卫的防线：
 * - MA **纯事件驱动回潮**：两工具的起始检查调用点失效 → C1a/C1b 必红（判据 1 的
 *   "改回必红"；C1 组自带挂起护栏，回潮时红得快而不是挂死套件）；同时既有 T2
 *   （等待中插话 → interrupted）必须仍绿——红的必须是新判据，绿的必须是旧判据，
 *   两者合成完整证明。
 * - MB **拆 kind 过滤**：`preexistingSteering` 认 next-step 里一切消息 → 转达/结算/
 *   迟到作答滞留也打断 → C2a/C2b 红（判据 2 负面对照一）。
 * - MC **加扫 next-turn**：排队消息也命中 → C3a/C3b 红（判据 3 负面对照二，R12 不回归）。
 * - MD **wait-agent 去结算并存决定**：起始命中即无条件 interrupted → C5a 红（判据 5）。
 * - ME **wait-job 停点前移**：屏障终态判定对插话在场让路 → C5b 红（判据 5，停点防回归）。
 *
 * ⚠️ **本脚本会原地改写 `lib/interrupts.js`、`lib/wait-agent.js`、`lib/wait-job.js`**，
 * 跑完在 `finally` 里写回并逐文件核对摘要。受限沙箱会杀 node→node spawn
 * （EPERM）——按"没跑成不算 CAUGHT"fail-closed，换宽松环境或提权重跑。
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
 * 跑目标测试并回读结果。三种结局必须分清（把"没跑成"记成 CAUGHT 是假绿）：
 * 正常退出 0 → 绿；非 0 退出或超时击杀 → 真红；spawn 失败 → 没跑成（fail-closed）。
 *
 * @param {number} timeoutMs - 超时；MA 回潮形态由用例的挂起护栏兜住（250 ms 标记），
 *   超时击杀仍按真红处理。
 * @returns {{state: 'green'|'red'|'didnt-run', summary: string, firstFail: string}} 结果。
 */
function runTests(timeoutMs) {
  let error;
  try {
    const out = execFileSync(process.execPath,
      ['--import', './tools/_host-hooks.mjs', '--test', ...TESTS],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs });
    return { state: 'green', summary: summaryOf(out), firstFail: firstFailOf(out) };
  } catch (thrown) {
    error = thrown;
  }
  const out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  // 超时击杀算**真红**（挂起本身就是失败；Windows 上形态是 code:'ETIMEDOUT'，killed 未必真）。
  const timedOut = error.killed === true || error.code === 'ETIMEDOUT';
  const spawnFailed = !timedOut
    && (SPAWN_FAILURE_CODES.has(error.code) || (error.status == null && out === ''));
  if (spawnFailed) {
    return {
      state: 'didnt-run',
      summary: `没跑成（spawn 失败：${String(error.code ?? error.message).slice(0, 80)}）——受限沙箱会杀 node→node spawn，提权或宽松环境重跑`,
      firstFail: ''
    };
  }
  return {
    state: 'red',
    summary: timedOut ? '（超时击杀——挂起本身就是红）' : summaryOf(out),
    firstFail: firstFailOf(out)
  };
}

function summaryOf(out) {
  const fail = /ℹ fail (\d+)/.exec(out);
  return fail === null ? '（无 fail 摘要）' : `ℹ fail ${fail[1]}`;
}

function firstFailOf(out) {
  return (out.split('\n').find((l) => /^✖ /.test(l.trim())) ?? '').trim().slice(0, 110);
}

/** 写回原文并逐文件核对摘要。 */
function restore() {
  for (const { path, content, hash } of originals.values()) {
    writeFileSync(path, content, 'utf8');
    const after = createHash('sha256').update(readFileSync(path, 'utf8'), 'utf8').digest('hex');
    if (after !== hash) throw new Error(`还原失败：${path} 与变异前不一致，请 git checkout 恢复。`);
  }
}

/** 对指定文件应用一组锚点替换（任一锚点缺失 → 整个变异失效，当失败处理）。 */
function applyVariant(patches) {
  for (const { file, anchor, mutated } of patches) {
    const entry = originals.get(file);
    if (!entry.content.includes(anchor)) {
      return `找不到锚点（${file}）：${anchor.slice(0, 60)}`;
    }
  }
  for (const { file, anchor, mutated } of patches) {
    const entry = originals.get(file);
    writeFileSync(entry.path, entry.content.replace(anchor, mutated), 'utf8');
  }
  return null;
}

const INTERRUPT_FIND = '  return nextStep.find((message) => message?.source?.kind === USER_MESSAGE_SOURCE) ?? null;';
const INTERRUPT_LIST = '  const nextStep = inbox?.nextStep;';
const AGENT_SCAN = '      const earlySteer = preexistingSteering(agent);';
const AGENT_ADJUDICATE = '        if (unclaimedSettlement(agent, agentId) !== null) {';
const JOB_SCAN = '      if (preexistingSteering(exec.agent) !== null) {';
const JOB_TERMINAL = '      if (TERMINAL.has(barrier.status)) return settledResult(barrier);';

const variants = [
  {
    name: 'MA', note: '纯事件驱动回潮（两工具起始检查拆除）→ C1a/C1b 红、既有 T2 仍绿。预期红面恰 3：wait-agent 判据1 / wait-job 判据1 / wait-agent 判据5（挂起护栏 250 ms 兜住回潮形态，红得快不是挂死）；既有 T2（两文件）必须留在绿面——fail 超出预期红面即变异口径漂移，按失败处理', timeoutMs: 120000,
    patches: [
      { file: 'lib/wait-agent.js', anchor: AGENT_SCAN, mutated: '      const earlySteer = null; // mutated MA: 起始检查拆除' },
      { file: 'lib/wait-job.js', anchor: JOB_SCAN, mutated: '      if (false) { // mutated MA: 起始检查拆除' }
    ]
  },
  {
    name: 'MB', note: '拆 kind 过滤（next-step 一切消息都算先到插话）→ C2a/C2b 红', timeoutMs: 120000,
    patches: [
      { file: 'lib/interrupts.js', anchor: INTERRUPT_FIND, mutated: '  return nextStep.find((message) => message != null) ?? null; // mutated MB: 拆 kind 过滤' }
    ]
  },
  {
    name: 'MC', note: '加扫 next-turn（排队消息也命中）→ C3a/C3b 红', timeoutMs: 120000,
    patches: [
      {
        file: 'lib/interrupts.js', anchor: INTERRUPT_LIST,
        mutated: '  const nextStep = [...(Array.isArray(inbox?.nextStep) ? inbox.nextStep : []), ...(Array.isArray(inbox?.nextTurn) ? inbox.nextTurn : [])]; // mutated MC: 加扫 next-turn'
      }
    ]
  },
  {
    name: 'MD', note: 'wait-agent 去结算并存决定（命中即无条件 interrupted）→ C5a 红', timeoutMs: 120000,
    patches: [
      { file: 'lib/wait-agent.js', anchor: AGENT_ADJUDICATE, mutated: '        if (false) { // mutated MD: 去结算并存决定' }
    ]
  },
  {
    name: 'ME', note: 'wait-job 停点前移（终态判定对插话在场让路）→ C5b 红', timeoutMs: 120000,
    patches: [
      {
        file: 'lib/wait-job.js', anchor: JOB_TERMINAL,
        mutated: '      if (TERMINAL.has(barrier.status) && preexistingSteering(exec.agent) === null) return settledResult(barrier); // mutated ME: 停点前移'
      }
    ]
  }
];

const baseline = runTests(120000);
if (baseline.state !== 'green') {
  console.log(`BASELINE-${baseline.state === 'red' ? 'RED' : 'DIDNT-RUN'}  未变异时不是绿的（${baseline.summary}）——先修基线/换环境。`);
  process.exit(2);
}
console.log('基线：未变异时三个测试文件全绿。');
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
    const after = runTests(variant.timeoutMs);
    if (after.state === 'didnt-run') {
      console.log(`DIDNT-RUN  ${variant.name} ${variant.note}  ${after.summary} —— 环境没跑成测试，不算 CAUGHT（fail-closed）`);
      ok = false;
    } else {
      const caught = after.state === 'red';
      console.log(`${caught ? 'CAUGHT' : 'MISSED'}  ${variant.name} ${variant.note}  ${after.summary}`);
      if (after.firstFail !== '') console.log(`        ${after.firstFail}`);
      ok = caught && ok;
    }
    // 每个变异跑完立即还原，失败也复原（finally 之外再兜一层）。
    restore();
  }
} finally {
  restore();
}
console.log('');
console.log(ok ? '变异被抓住：R55 五判据都有能失败的判据（含两组负面对照与结束优先并存决定）。' : '**变异逃逸或没跑成**——判据是恒真的，或环境不可用。');
console.log('还原完成，摘要一致。');
process.exitCode = ok ? 0 : 1;
