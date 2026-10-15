/**
 * 守哪条需求：需求 §6.1 单次提权安全红线
 *
 * 变异：把 `async_run` 的单次提权**整段拿掉**，要求单测变红。
 *
 * ## 为什么必须做这一步
 *
 * 一条判据不证明"能失败"，它就只是"看着在那儿"。
 *
 * 变异模拟的是**缺陷原形**：`execute` 里那段"先问审批、拿到更宽模式、再启动进程"
 * 被删掉，退回"读策略、服从策略"。
 *
 * **本脚本会原地改写真实的 `lib/jobs.js`**，跑完在 `finally` 里写回并核对摘要。
 *
 * 用法：node verify/mutate-escalation-removed.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从模块自身位置推仓根（verify/ 上一级）——变异脚本要在任意 cwd 下都能跑。
const PKG = fileURLToPath(new URL('..', import.meta.url));
const TARGET = join(PKG, 'lib', 'jobs.js');
const TEST = 'test/escalation.test.mjs';

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
      firstFail: (out.split('\n').find((l) => /^✖ /.test(l.trim())) ?? '').trim().slice(0, 100)
    };
  };
  try {
    const out = execFileSync(process.execPath, ['--import', './tools/_host-hooks.mjs', '--test', TEST],
      { cwd: PKG, encoding: 'utf8', stdio: 'pipe', timeout: 180000 });
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

/** 锚点：审批解析那段（取的是"成对且非空才真的去问审批"那一次调用）。 */
const ANCHOR = `      const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
        ? await approveRunEscalation(args.sandbox_permissions, args.justification, exec, sandboxPolicy)
        : undefined;`;
/** 变异体：直接当没提权——即缺陷原形"读策略、服从策略"。 */
const MUTATED = '      const approvedMode = undefined;';

const baseline = runTests();
if (baseline.red) {
  console.log(`BASELINE-RED  未变异时 ${TEST} 就是红的（${baseline.summary}）——先修基线；若括号里是空的、且本脚本以 2 退出，更可能是默认沙箱禁止捕获子进程输出（EPERM）：本脚本要跑测试文件，需带提权运行。规范见 verify/README.md 的「判据必须在默认权限下可跑」。`);
  process.exit(2);
}
console.log(`基线：未变异时 ${TEST} 全绿（${baseline.summary}）。`);
console.log('');

let ok = true;
try {
  if (!original.includes(ANCHOR)) {
    console.log('SKIP  找不到审批解析那段的锚点，本变异失效——当失败处理。');
    ok = false;
  } else {
    writeFileSync(TARGET, original.replace(ANCHOR, MUTATED), 'utf8');
    const after = runTests();
    console.log(`${after.red ? 'CAUGHT' : 'MISSED'}  M1 提权整段拿掉（缺陷原形）  ${after.summary}`);
    if (after.firstFail !== '') console.log(`        ${after.firstFail}`);
    ok = after.red && ok;
  }
} finally {
  restore();
}
console.log('');
console.log(ok ? '变异被抓住：判据真的能拦住"提权整段没了"。' : '**变异逃逸**——判据区分力不足。');
console.log('还原完成，摘要一致。');
process.exitCode = ok ? 0 : 1;
