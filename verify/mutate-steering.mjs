/**
 * 守哪些需求：R12（打断信号只认"插话" steer；排队 queue 不打断）+ F10（kind 过滤线）
 *
 * 三个变异，方向互补，缺一个就有无守卫的防线（r12 审查 N1 用变异 K 实证过缺 M3 的后果）：
 * - M1 **旧实现回潮**：去掉 `isSteering` 落点判定（一切 `source.kind==='user'` 的插入都打断）
 *   → 必须红在"排队消息（next-turn）不打断等待"上。守的是 R12 的**新增**性质。
 * - M2 **收窄过头**：`isSteering` 恒 false（谁都不打断）
 *   → 必须红在"插话打断"的正向用例上（挂起的 `await watcher.promise` 本身就是红）。
 *   守的是 R12 **没有顺手杀掉**的旧性质（F10/R2/R3 的插话打断路径）。
 * - M3 **拆掉承重墙**：删掉 `source.kind !== USER` 过滤——它看起来被 isSteering 顺带覆盖，
 *   但真机上 deferContext 的上下文消息（工具结果、subagent-settled 结算通知）恰恰落
 *   **next-step**（`dsh-agent-loop:1118`），删过滤 ⇒ 等待被自己的通知打断。
 *   → 必须红在"非 user 的 next-step 消息不打断（F10×R12）"上（r12 审查 N1 补的用例）。
 *
 * ⚠️ **本脚本会原地改写真实的 `lib/interrupts.js`**，跑完在 `finally` 里写回并核对摘要。
 *
 * 用法：node verify/mutate-steering.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从模块自身位置推仓根（verify/ 上一级）——变异脚本要在任意 cwd 下都能跑。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARGET = join(ROOT, 'lib', 'interrupts.js');
const TESTS = ['test/interrupt.test.mjs', 'test/wait-job.test.mjs', 'test/wait-agent.test.mjs'];

const original = readFileSync(TARGET, 'utf8');
const hashBefore = createHash('sha256').update(original, 'utf8').digest('hex');

/** spawn 没跑起来（沙箱拒绝、找不到可执行）时 execFileSync 错误的 code 形态。 */
const SPAWN_FAILURE_CODES = new Set(['EPERM', 'ENOENT', 'EACCES']);

/**
 * 跑目标测试并回读结果。
 *
 * 三种结局必须分清（r12 审查 §四.5：把"没跑成"记成 CAUGHT 是假绿）：
 * - 正常跑完退出 0 → 绿；
 * - 跑完非 0 退出（有 fail 摘要或 ✖ 行）或超时击杀（`error.killed`，M2 的挂起形态）→ **真红**；
 * - spawn 失败（`error.code` ∈ SPAWN_FAILURE_CODES，或 status 为 null 且无任何输出）→
 *   **没跑成**：既不算绿也不算红，整个脚本判失败（fail-closed）。
 *
 * @param {number} timeoutMs - 超时；M2 会让用例挂起，超时击杀也算红。
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
  // 超时击杀算**真红**（M2 的用例本来就可能挂起——挂起本身就是失败）。
  // ⚠️ Windows 上 execFileSync 的超时错误形态是 `code: 'ETIMEDOUT'`（实测），
  // `killed` 不一定是 true；两种形态都按超时处理。
  const timedOut = error.killed === true || error.code === 'ETIMEDOUT';
  const spawnFailed = !timedOut
    && (SPAWN_FAILURE_CODES.has(error.code) || (error.status == null && out === ''));
  if (spawnFailed) {
    return {
      state: 'didnt-run',
      summary: `没跑成（spawn 失败：${String(error.code ?? error.message).slice(0, 80)}）`,
      firstFail: ''
    };
  }
  return {
    state: 'red',
    summary: timedOut
      ? '（超时击杀——插话永远不来，await 挂起本身就是红）'
      : summaryOf(out),
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

/** 写回原文并核对摘要。 */
function restore() {
  writeFileSync(TARGET, original, 'utf8');
  const after = createHash('sha256').update(readFileSync(TARGET, 'utf8'), 'utf8').digest('hex');
  if (after !== hashBefore) throw new Error(`还原失败：${TARGET} 与变异前不一致，请 git checkout 恢复。`);
}

// M1 的锚点：watchUserInterrupt 里的落点判定行（R12 的核心新增）。
const M1_ANCHOR = '      if (!isSteering(agent, payload.message.id)) return;';
const M1_MUTATED = '      /* mutated M1: 旧实现回潮——不看落点，一切 user 插入都打断 */';
// M2 的锚点：isSteering 的正判行。
const M2_ANCHOR = '  return nextStep.some((message) => message?.id === messageId);';
const M2_MUTATED = '  return false; // mutated M2: 收窄过头——谁都不打断';
// M3 的锚点：kind 过滤行（F10 的承重墙，r12 审查 N1 之前无守卫）。
const M3_ANCHOR = '      if (payload?.message?.source?.kind !== USER) return;';
const M3_MUTATED = '      /* mutated M3: 拆掉 kind 过滤——非 user 的 next-step 消息（结算通知等）也会打断 */';

const baseline = runTests(120000);
if (baseline.state !== 'green') {
  console.log(`BASELINE-${baseline.state === 'red' ? 'RED' : 'DIDNT-RUN'}  未变异时不是绿的（${baseline.summary}）——先修基线/换环境。`);
  process.exit(2);
}
console.log(`基线：未变异时三个测试文件全绿。`);
console.log('');

let ok = true;
try {
  const variants = [
    { name: 'M1', anchor: M1_ANCHOR, mutated: M1_MUTATED, note: '去掉落点判定（queue 也会打断）', timeoutMs: 120000 },
    { name: 'M2', anchor: M2_ANCHOR, mutated: M2_MUTATED, note: 'isSteering 恒 false（插话也不打断）', timeoutMs: 60000 },
    { name: 'M3', anchor: M3_ANCHOR, mutated: M3_MUTATED, note: '删掉 kind 过滤（非 user 落 next-step 也打断）', timeoutMs: 120000 }
  ];
  for (const variant of variants) {
    if (!original.includes(variant.anchor)) {
      console.log(`SKIP  找不到 ${variant.name} 锚点，本变异失效——当失败处理。`);
      ok = false;
      continue;
    }
    writeFileSync(TARGET, original.replace(variant.anchor, variant.mutated), 'utf8');
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
  }
} finally {
  restore();
}
console.log('');
console.log(ok ? '变异被抓住：R12 的两个方向 + F10 承重墙都有能失败的判据。' : '**变异逃逸或没跑成**——判据是恒真的，或环境不可用。');
console.log('还原完成，摘要一致。');
process.exitCode = ok ? 0 : 1;
