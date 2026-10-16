/**
 * 守哪条需求：需求 §2.1.1 async_run 组成
 *
 * 变异：把 `yieldNote` 示例里的 `wait_ms` **改回写死**，要求单元测试变红。
 *
 * ## 为什么必须做这一步
 *
 * 示例若写死 `wait_ms` 且**凑巧等于**默认 `defaultWaitMs`（30 s），断言
 * `wait_ms=<默认值>` 会一直绿——**巧合让缺陷隐形**。
 *
 * 判据传 `defaultWaitMs: 7000` 并断言示例里出现 7000——一个"无论实现写死
 * 还是取值都绿"的断言等于没写。本变异把实现改回写死，看它是否真的红。
 *
 * **本脚本会原地改写真实的 `lib/output.js`**，跑完在 `finally` 里写回并核对摘要。
 *
 * 用法：node verify/mutate-yield-example.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从模块自身位置推仓根（verify/ 上一级）——变异脚本要在任意 cwd 下都能跑。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARGET = join(ROOT, 'lib', 'output.js');
const TEST = 'test/output.test.mjs';

const original = readFileSync(TARGET, 'utf8');
const hashBefore = createHash('sha256').update(original, 'utf8').digest('hex');

/**
 * 跑目标测试并回读结果。
 *
 * @returns {{red: boolean, summary: string, firstFail: string}} 结果。
 */
function runTests() {
  const collect = (out) => {
    const fail = /ℹ fail (\d+)/.exec(out);
    return {
      summary: fail === null ? '（无 fail 摘要）' : `ℹ fail ${fail[1]}`,
      firstFail: (out.split('\n').find((l) => /^✖ /.test(l.trim())) ?? '').trim().slice(0, 110)
    };
  };
  try {
    const out = execFileSync(process.execPath, ['--import', './tools/_host-hooks.mjs', '--test', TEST],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
    return { red: false, ...collect(out) };
  } catch (error) {
    return { red: true, ...collect(`${error.stdout ?? ''}${error.stderr ?? ''}`) };
  }
}

/** 写回原文并核对摘要。 */
function restore() {
  writeFileSync(TARGET, original, 'utf8');
  const after = createHash('sha256').update(readFileSync(TARGET, 'utf8'), 'utf8').digest('hex');
  if (after !== hashBefore) throw new Error(`还原失败：${TARGET} 与变异前不一致，请 git checkout 恢复。`);
}

/** 锚点：示例那一行（取生效配置的那个插值）。 */
const ANCHOR = '    `  async_wait_job(job_id="${jobId}", wait_ms=${String(defaultWaitMs)})`,';
/** 变异体：缺陷原形——写死成插件的默认值。 */
const MUTATED = '    `  async_wait_job(job_id="${jobId}", wait_ms=30000)`,';

const baseline = runTests();
if (baseline.red) {
  console.log(`BASELINE-RED  未变异时 ${TEST} 就是红的（${baseline.summary}）——先修基线；若括号里是空的、且本脚本以 2 退出，更可能是默认沙箱禁止捕获子进程输出（EPERM）：本脚本要跑测试文件，需带提权运行。规范见 verify/README.md 的「优先默认权限执行；纯函数判断尽量进程内复用」要点。`);
  process.exit(2);
}
console.log(`基线：未变异时 ${TEST} 全绿（${baseline.summary}）。`);
console.log('');

let ok = true;
try {
  if (!original.includes(ANCHOR)) {
    console.log('SKIP  找不到示例那一行的锚点，本变异失效——当失败处理。');
    console.log('      （锚点：`lib/output.js` 里那行取 `String(defaultWaitMs)` 的示例）');
    ok = false;
  } else {
    writeFileSync(TARGET, original.replace(ANCHOR, MUTATED), 'utf8');
    const after = runTests();
    console.log(`${after.red ? 'CAUGHT' : 'MISSED'}  M1 示例改回写死 \`wait_ms=30000\`（缺陷原形）  ${after.summary}`);
    if (after.firstFail !== '') console.log(`        ${after.firstFail}`);
    ok = after.red && ok;
  }
} finally {
  restore();
}
console.log('');
console.log(ok ? '变异被抓住：判据真的能区分"取配置"与"写死"。' : '**变异逃逸**——判据是恒真的。');
console.log('还原完成，摘要一致。');
process.exitCode = ok ? 0 : 1;
