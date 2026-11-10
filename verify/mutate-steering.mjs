/**
 * 守哪条需求：需求 §2.1.2 消息唤醒与取消——打断信号只认"插话" steer，排队 queue
 * 不打断（kind 过滤线）
 *
 * 三个变异，方向互补，缺一个就有无守卫的防线：
 * - M1 **旧实现回潮**：去掉 `isSteering` 落点判定（一切 `source.kind==='user'` 的插入都打断）
 *   → 必须红在"排队消息（next-turn）不打断等待"上。守的是**新增**性质（排队不打断）。
 * - M2 **收窄过头**：`isSteering` 恒 false（谁都不打断）
 *   → 必须红在"插话打断"的正向用例上（挂起的 `await watcher.promise` 本身就是红）。
 *   守的是**没有顺手杀掉**的旧性质（插话打断路径）。
 * - M3 **拆掉承重墙**：删掉 `source.kind !== USER_MESSAGE_SOURCE` 过滤——它看起来被 isSteering 顺带覆盖，
 *   但真机上 deferContext 的上下文消息（工具结果、subagent-settled 结算通知）恰恰落
 *   **next-step**（`dsh-agent-loop:1154`），删过滤 ⇒ 等待被自己的通知打断。
 *   → 必须红在"非 user 的 next-step 消息不打断"上。
 *
 * ## 测试文件映射（VERIFY-STEERING-TARGETS 修正）
 *
 * 旧清单引用过 `test/wait-job.test.mjs`、`test/wait-agent.test.mjs`——两份文件早已
 * 不存在，加载失败被当成"红"，产生了变异被捕获的假象。现行覆盖唤醒／等待逻辑的
 * 真实文件：
 * - `test/interrupt.test.mjs`：单元判定——`wakesWait`/`classifyWake`/`watchWakeSignal`
 *   与落点过滤（M1 的"排队不唤醒"、M2 的"插话唤醒"、M3 的"上下文形态不唤醒"）；
 * - `test/wait-delivery.test.mjs`：统一等待入口的行为层——R55 起始检查、插话
 *   interrupted、排队不唤醒在完整等待流程上的判据。
 *
 * 结局分级（互相独立，不混算）：
 * - `load-failure`：测试文件缺席或模块加载失败（找不到文件/模块）——**没测成**，
 *   任何变异在此环境下都不算 CAUGHT；
 * - `didnt-run`：spawn 没跑起来（沙箱拒绝、找不到可执行）——同样**没测成**；
 * - `red`：真正跑完且变红（含超时击杀的挂起形态）——只有它算 CAUGHT；
 * - `green`：跑完且全绿——MISSED。
 *
 * ## 隔离执行（VERIFY-MUTATION-ISOLATION）
 *
 * 本脚本不再原地改写开发树的 `lib/interrupts.js`：变异与测试都发生在**当前树的
 * 隔离副本**（`verify/_isolate.mjs`）里——运行前核对副本目标与开发树逐字一致，
 * 运行后比对开发树原始摘要；`finally` 里的写回只作用于副本（纵深防御）。
 *
 * 用法：node verify/mutate-steering.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { prepareIsolatedMutation } from './_isolate.mjs';

// 覆盖唤醒/等待逻辑（barrier/wake/steering）的现行测试文件，见头注映射说明。
const TESTS = ['test/interrupt.test.mjs', 'test/wait-delivery.test.mjs'];

const iso = prepareIsolatedMutation({ script: 'verify/mutate-steering.mjs', targets: ['lib/interrupts.js'] });
// 变异与测试都在隔离副本里（ROOT＝副本根）；开发树全程只读。
const ROOT = iso.root;
const TARGET = join(ROOT, 'lib', 'interrupts.js');

const original = readFileSync(TARGET, 'utf8');
const hashBefore = createHash('sha256').update(original, 'utf8').digest('hex');

/** spawn 没跑起来（沙箱拒绝、找不到可执行）时 execFileSync 错误的 code 形态。 */
const SPAWN_FAILURE_CODES = new Set(['EPERM', 'ENOENT', 'EACCES']);
/** 模块加载失败的输出形态（测试文件或其 import 目标缺席/不可解析）。 */
const LOAD_FAILURE_PATTERNS = [/Cannot find module/, /ERR_MODULE_NOT_FOUND/, /Could not find/];

// 结构性预检：清单里的测试文件必须在副本里存在——缺席直接归 load-failure，
// 不进入运行（旧形态会把它跑成"红"再误记 CAUGHT）。
const missingTests = TESTS.filter((rel) => !existsSync(join(ROOT, ...rel.split('/'))));
if (missingTests.length > 0) {
  console.log(`BASELINE-LOAD-FAILURE  测试文件不在仓里：${missingTests.join('、')}——清单烂了，先修映射（本环境下一切变异都不算 CAUGHT）。`);
  iso.cleanup();
  process.exit(2);
}

/**
 * 跑目标测试并回读结果。
 *
 * 四种结局必须分清（把"没跑成"或"没加载"记成 CAUGHT 都是假绿）：
 * - 正常跑完退出 0 → 绿；
 * - 跑完非 0 退出（有 fail 摘要或 ✖ 行）或超时击杀（`error.killed`，M2 的挂起形态）→ **真红**；
 * - 模块加载失败（输出含加载失败形态）→ **load-failure**：没测成，不算红；
 * - spawn 失败（`error.code` ∈ SPAWN_FAILURE_CODES，或 status 为 null 且无任何输出）→
 *   **没跑成**：既不算绿也不算红，整个脚本判失败（fail-closed）。
 *
 * @param {number} timeoutMs - 超时；M2 会让用例挂起，超时击杀也算红。
 * @returns {{state: 'green'|'red'|'load-failure'|'didnt-run', summary: string, firstFail: string}} 结果。
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
  if (LOAD_FAILURE_PATTERNS.some((pattern) => pattern.test(out))) {
    return {
      state: 'load-failure',
      summary: '没测成（模块/测试文件加载失败——见输出）',
      firstFail: (out.split('\n').find((l) => LOAD_FAILURE_PATTERNS.some((p) => p.test(l))) ?? '').trim().slice(0, 110)
    };
  }
  // 超时击杀算**真红**（M2 的用例本来就可能挂起——挂起本身就是失败）。
  // Windows 上 execFileSync 的超时错误形态是 `code: 'ETIMEDOUT'`（实测），
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

/** 写回原文并核对摘要（只作用于隔离副本——开发树本来就没被写）。 */
function restore() {
  writeFileSync(TARGET, original, 'utf8');
  const after = createHash('sha256').update(readFileSync(TARGET, 'utf8'), 'utf8').digest('hex');
  if (after !== hashBefore) throw new Error(`还原失败：副本里的 ${TARGET} 与变异前不一致（不影响开发树，仅提示副本残留）。`);
}

// M1 的锚点：watchWakeSignal 里的落点判定行（排队不打断的判定核心，需求 §2.1.2）。
const M1_ANCHOR = '    if (!isSteering(agent, wake.messageId)) return;';
const M1_MUTATED = '    /* mutated M1: 旧实现回潮——不看落点，一切 user 插入都打断 */';
// M2 的锚点：isSteering 的正判行。
const M2_ANCHOR = '  return nextStep.some((message) => message?.id === messageId);';
const M2_MUTATED = '  return false; // mutated M2: 收窄过头——谁都不打断';
// M3 的锚点：classifyWake 的唤醒过滤行（判据的承重墙——非唤醒消息在此被挡，
// 现行实现经 wakesWait 单一事实源起作用，见头注 M3）。
const M3_ANCHOR = '  if (!wakesWait(message)) return null;';
const M3_MUTATED = '  /* mutated M3: 拆掉唤醒过滤——非 user 的 next-step 消息（工具结果、结算通知）也归类为唤醒 */';

const baseline = runTests(180000);
if (baseline.state !== 'green') {
  const label = { red: 'RED', 'didnt-run': 'DIDNT-RUN', 'load-failure': 'LOAD-FAILURE' }[baseline.state];
  console.log(`BASELINE-${label}  未变异时测试不是绿的（${baseline.summary}）——先修基线/换环境；本清单下的变异结论一律不算数。`);
  iso.cleanup();
  process.exit(2);
}
console.log(`基线：未变异时 ${TESTS.join('、')} 全绿。`);
console.log('');

let ok = true;
try {
  const variants = [
    { name: 'M1', anchor: M1_ANCHOR, mutated: M1_MUTATED, note: '去掉落点判定（queue 也会打断）', timeoutMs: 180000 },
    { name: 'M2', anchor: M2_ANCHOR, mutated: M2_MUTATED, note: 'isSteering 恒 false（插话也不打断）', timeoutMs: 60000 },
    { name: 'M3', anchor: M3_ANCHOR, mutated: M3_MUTATED, note: '删掉 kind 过滤（非 user 落 next-step 也打断）', timeoutMs: 180000 }
  ];
  for (const variant of variants) {
    if (!original.includes(variant.anchor)) {
      console.log(`SKIP  找不到 ${variant.name} 锚点，本变异失效——当失败处理。`);
      ok = false;
      continue;
    }
    writeFileSync(TARGET, original.replace(variant.anchor, variant.mutated), 'utf8');
    const after = runTests(variant.timeoutMs);
    if (after.state === 'load-failure' || after.state === 'didnt-run') {
      console.log(`${after.state === 'load-failure' ? 'LOAD-FAILURE' : 'DIDNT-RUN'}  ${variant.name} ${variant.note}  ${after.summary} —— 环境没测成，不算 CAUGHT（fail-closed）`);
      if (after.firstFail !== '') console.log(`        ${after.firstFail}`);
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
iso.assertDevTreeUntouched('变异收尾');
iso.cleanup();
console.log('');
console.log(ok ? '变异被抓住：排队不打断与插话打断两个方向 + kind 过滤承重墙都有能失败的判据。' : '**变异逃逸或没测成**——判据是恒真的，或环境不可用。');
console.log(`隔离副本已清理；开发树 ${iso.devRoot} 的 lib/interrupts.js 全程未被写入（起跑摘要与收尾一致）。`);
process.exitCode = ok ? 0 : 1;
