/**
 * 守哪条需求：需求 §2.2.3 输出与一次性交付（后台 workflow 最终结果的一次性
 * 交付；设计 §2.4 读取、合并和裁剪）。
 *
 * 三个变异，方向互补：
 * - M1 **缺陷回潮**：`outputOf` 丢弃一次性 `result`（只拼 chunks）→ 必须红在
 *   「最终 JSON 出现恰一次」的正向判据上（单元分隔三分＋真实注册表①②）。
 * - M2 **恒加分隔**：增量与 `result` 之间无条件补换行 → 必须红在「增量已以
 *   换行结尾不补」的精确文本断言上。守分隔规则的边界一。
 * - M3 **恒无分隔**：增量与 `result` 直接拼接 → 必须红在「非换行结尾的增量
 *   恰一个换行」的精确文本断言上。守分隔规则的边界二。
 *
 * **本脚本会原地改写真实的 `lib/wait-job.js`**，跑完在 `finally` 里写回并核对摘要。
 *
 * 用法：node verify/mutate-atb01-final-result.mjs
 * （会跑 `node --test` 测试文件：受限沙箱下按「没跑成不算 CAUGHT」fail-closed，
 * 取证须提权环境——与 `mutate-steering.mjs` 同类。）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从模块自身位置推仓根（verify/ 上一级）——变异脚本要在任意 cwd 下都能跑。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARGET = join(ROOT, 'lib', 'wait-job.js');
const TESTS = ['test/wait-job.test.mjs', 'test/wait-job-result.test.mjs'];

const original = readFileSync(TARGET, 'utf8');
const hashBefore = createHash('sha256').update(original, 'utf8').digest('hex');

/** spawn 没跑起来（沙箱拒绝、找不到可执行）时 execFileSync 错误的 code 形态。 */
const SPAWN_FAILURE_CODES = new Set(['EPERM', 'ENOENT', 'EACCES']);

/**
 * 跑目标测试并回读结果。三种结局必须分清（把「没跑成」记成 CAUGHT 是假绿）：
 * 正常退出 0 → 绿；非 0 退出或超时击杀 → 真红；spawn 失败 → 没跑成（fail-closed）。
 *
 * @param {number} timeoutMs - 超时。
 * @returns {{state: 'green'|'red'|'didnt-run', summary: string, firstFail: string}} 结果。
 */
function runTests(timeoutMs) {
  let error;
  try {
    const out = execFileSync(process.execPath,
      ['--import', './tools/_host-hooks.mjs', '--test', '--test-isolation=none', ...TESTS],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs });
    return { state: 'green', summary: summaryOf(out), firstFail: firstFailOf(out) };
  } catch (thrown) {
    error = thrown;
  }
  const out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
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
    summary: timedOut ? '（超时击杀）' : summaryOf(out),
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

// 现行实现的合并段（outputOf 尾部三分支）。
const MERGE_ANCHOR = "  const text = read?.result === undefined\n    ? delta\n    : `${delta}${delta.length > 0 && !delta.endsWith('\\n') ? '\\n' : ''}${read.result}`;";
const M1_MUTATED = '  const text = delta; // mutated M1: 丢弃一次性 result（缺陷回潮）';
const M2_MUTATED = "  const text = read?.result === undefined\n    ? delta\n    : `${delta}\\n${read.result}`; // mutated M2: 恒加分隔";
const M3_MUTATED = "  const text = read?.result === undefined\n    ? delta\n    : `${delta}${read.result}`; // mutated M3: 恒无分隔";

const baseline = runTests(120000);
if (baseline.state !== 'green') {
  console.log(`BASELINE-${baseline.state === 'red' ? 'RED' : 'DIDNT-RUN'}  未变异时不是绿的（${baseline.summary}）——先修基线/换环境。`);
  process.exit(2);
}
console.log('基线：未变异时两个测试文件全绿。');
console.log('');

let ok = true;
try {
  const variants = [
    { name: 'M1', mutated: M1_MUTATED, note: '丢弃一次性 result（只拼 chunks，缺陷回潮）', timeoutMs: 120000 },
    { name: 'M2', mutated: M2_MUTATED, note: '恒加分隔（增量已以换行结尾也补）', timeoutMs: 120000 },
    { name: 'M3', mutated: M3_MUTATED, note: '恒无分隔（非换行结尾的增量不补换行）', timeoutMs: 120000 }
  ];
  if (!original.includes(MERGE_ANCHOR)) {
    console.log('SKIP  找不到合并段锚点，全部变异失效——当失败处理。');
    ok = false;
  } else {
    for (const variant of variants) {
      writeFileSync(TARGET, original.replace(MERGE_ANCHOR, variant.mutated), 'utf8');
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
  }
} finally {
  restore();
}
console.log('');
console.log(ok ? '变异被抓住：最终回答的正向交付与两条分隔边界都有能失败的判据。' : '**变异逃逸或没跑成**——判据是恒真的，或环境不可用。');
console.log('还原完成，摘要一致。');
process.exitCode = ok ? 0 : 1;
