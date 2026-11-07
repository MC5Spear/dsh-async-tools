/**
 * 变异：把未定义的别名变量写回 `client.js`，要求 `tools/check-alias-tokens.mjs`
 * 变红。
 *
 * 两条变异对应未定义别名 token 的两种退化：
 * ① 放回 `label-danger`（自绘错误色用过的死名字，全树零定义）；
 * ② 把 `label-error` 写成引用（官方 `.failed` 引用的那个未定义名字——照抄它
 * 就是复刻本判据要消灭的缺陷）。
 *
 * **本脚本在当前树的隔离副本里改写 `client.js` 并跑检查器**（`verify/_isolate.mjs`）：
 * 运行前核对副本目标与开发树逐字一致，运行后比对开发树原始摘要——开发树不再被
 * 原地写回（`finally` 的还原只作用于副本）。任何 SKIP 按失败处理。
 *
 * 用法：node verify/mutate-alias-tokens.mjs（需可捕获子进程输出——默认沙箱下 EPERM，
 * 见 verify/README.md 的「优先默认权限执行；纯函数判断尽量进程内复用」要点与既有 mutate-card-theme 的先例）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { prepareIsolatedMutation } from './_isolate.mjs';

// 隔离现场：变异与检查都发生在副本里；PKG＝副本根（开发树全程只读）。
const iso = prepareIsolatedMutation({ script: 'verify/mutate-alias-tokens.mjs', targets: ['client.js'] });
const PKG = iso.root;
const TARGET = join(PKG, 'client.js');

const original = readFileSync(TARGET, 'utf8');
const hashBefore = createHash('sha256').update(original, 'utf8').digest('hex');

/** 跑 token 检查器；非零退出 = 红。 */
function runChecker() {
  try {
    execFileSync(process.execPath, ['tools/check-alias-tokens.mjs'],
      { cwd: PKG, encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
    return { red: false, summary: '（退出 0）' };
  } catch (error) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    const line = out.split('\n').find((l) => /处引用未定义|BAD/.test(l)) ?? '';
    return { red: true, summary: line.trim().slice(0, 120) };
  }
}

/** 写回原文并核对摘要（只作用于隔离副本——开发树本来就没被写）。 */
function restore() {
  writeFileSync(TARGET, original, 'utf8');
  const after = createHash('sha256').update(readFileSync(TARGET, 'utf8'), 'utf8').digest('hex');
  if (after !== hashBefore) throw new Error(`还原失败：副本里的 ${TARGET} 与变异前不一致（不影响开发树，仅提示副本残留）。`);
}

const baseline = runChecker();
if (baseline.red) {
  console.log(`BASELINE-RED  未变异时检查器就是红的（${baseline.summary}）——先修基线。`);
  iso.cleanup();
  process.exit(2);
}
console.log(`基线：未变异时别名变量检查通过（${baseline.summary}）。`);
console.log('');

let ok = true;
try {
  // ① 放回 label-danger：把枚举错误色的一个定义表内引用换成死名字。
  const mutated1 = original.replace(
    '.ats-enum-message[aria-invalid=\'true\']{color:var(--dsw-alias-state-error-primary)}',
    ".ats-enum-message[aria-invalid='true']{color:var(--dsw-alias-label-danger)}");
  if (mutated1 === original) {
    console.log('SKIP  找不到枚举错误色的锚点，变异①失效——当失败处理。');
    ok = false;
  } else {
    writeFileSync(TARGET, mutated1, 'utf8');
    const after = runChecker();
    console.log(`${after.red ? 'CAUGHT' : 'MISSED'}  ① label-danger 放回（主题未定义的死名字）  ${after.summary}`);
    ok = after.red && ok;
  }

  // ② 照抄官方 .failed：把 label-error 写成引用（它零定义、只被官方引用过）。
  //    锚按**源码字面**写（规则跨两个字符串字面量，拼接发生在运行期）。
  const mutated2 = original.replace(
    '.ats-enum-select[aria-invalid=\'true\'],.ats-value-input[aria-invalid=\'true\']{"\n  + "border-color:var(--dsw-alias-state-error-primary)}',
    ".ats-enum-select[aria-invalid='true'],.ats-value-input[aria-invalid='true']{\"\n  + \"border-color:var(--dsw-alias-label-error)}");
  if (mutated2 === original) {
    console.log('SKIP  找不到枚举非法边框的锚点，变异②失效——当失败处理。');
    ok = false;
  } else {
    writeFileSync(TARGET, mutated2, 'utf8');
    const after = runChecker();
    console.log(`${after.red ? 'CAUGHT' : 'MISSED'}  ② label-error 写成引用（照抄官方 .failed 的缺陷）  ${after.summary}`);
    ok = after.red && ok;
  }
} finally {
  restore();
}
iso.assertDevTreeUntouched('变异收尾');
iso.cleanup();
console.log('');
console.log(ok ? '变异被抓住：token 判据真的能拦住未定义的别名变量。' : '**变异逃逸**——token 判据区分力不足。');
console.log(`隔离副本已清理；开发树 ${iso.devRoot} 的 client.js 全程未被写入（起跑摘要与收尾一致）。`);
process.exitCode = ok ? 0 : 1;
