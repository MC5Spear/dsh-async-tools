/**
 * 变异：把卡片样式**改回写死颜色**，要求 T14 变红。
 *
 * ## 为什么必须做这一步
 *
 * 判据若不被证明能失败，就只是"看着在那儿"。
 *
 * 变异内容就是**缺陷原形**：表单本体用官方控件，自有样式只剩
 * `EnumField` 的壳与 select 本体（`ENUM_CSS`）；变异把 select 底色从
 * `var(--dsw-alias-bg-layer-3)` 改回 `#ffffff`——那正是深色主题下渲染成
 * 白底黑框的那类缺陷。
 *
 * **本脚本在当前树的隔离副本里改写 `client.js`（卡片就在本包根）并跑测试**
 * （`verify/_isolate.mjs`）：运行前核对副本目标与开发树逐字一致，运行后比对开发
 * 树原始摘要——开发树不再被原地写回（`finally` 的还原只作用于副本）。
 *
 * 用法：node verify/mutate-card-theme.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { prepareIsolatedMutation } from './_isolate.mjs';

// 隔离现场：变异与测试都发生在副本里；PKG＝副本根（开发树全程只读）。
const iso = prepareIsolatedMutation({ script: 'verify/mutate-card-theme.mjs', targets: ['client.js'] });
const PKG = iso.root;
const TARGET = join(PKG, 'client.js');
const TEST = 'test/two-planes.test.mjs';

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
      { cwd: PKG, encoding: 'utf8', stdio: 'pipe', timeout: 180000 });
    return { red: false, ...collect(out) };
  } catch (error) {
    return { red: true, ...collect(`${error.stdout ?? ''}${error.stderr ?? ''}`) };
  }
}

/** 写回原文并核对摘要（只作用于隔离副本——开发树本来就没被写）。 */
function restore() {
  writeFileSync(TARGET, original, 'utf8');
  const after = createHash('sha256').update(readFileSync(TARGET, 'utf8'), 'utf8').digest('hex');
  if (after !== hashBefore) throw new Error(`还原失败：副本里的 ${TARGET} 与变异前不一致（不影响开发树，仅提示副本残留）。`);
}

const baseline = runTests();
if (baseline.red) {
  console.log(`BASELINE-RED  未变异时 ${TEST} 就是红的（${baseline.summary}）——先修基线；若括号里是空的、且本脚本以 2 退出，更可能是默认沙箱禁止捕获子进程输出（EPERM）：本脚本要跑测试文件，需带提权运行。规范见 verify/README.md 的「优先默认权限执行；纯函数判断尽量进程内复用」要点。`);
  iso.cleanup();
  process.exit(2);
}
console.log(`基线：未变异时 ${TEST} 全绿（${baseline.summary}）。`);
console.log('');

let ok = true;
try {
  const mutated = original
    .replace('border-radius:12px;"\n  + "background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;"',
      'border-radius:12px;"\n  + "background:#ffffff;font:inherit;font-size:13px;line-height:1.5;"');
  if (mutated === original) {
    console.log('SKIP  找不到枚举 select 底色的锚点，本变异失效——当失败处理。');
    ok = false;
  } else {
    writeFileSync(TARGET, mutated, 'utf8');
    const after = runTests();
    console.log(`${after.red ? 'CAUGHT' : 'MISSED'}  M1 枚举 select 底色改回写死的 #ffffff（缺陷原形）  ${after.summary}`);
    if (after.firstFail !== '') console.log(`        ${after.firstFail}`);
    ok = after.red && ok;
  }
} finally {
  restore();
}
iso.assertDevTreeUntouched('变异收尾');
iso.cleanup();
console.log('');
console.log(ok ? '变异被抓住：这条判据真的能拦住写死颜色。' : '**变异逃逸**——判据区分力不足。');
console.log(`隔离副本已清理；开发树 ${iso.devRoot} 的 client.js 全程未被写入（起跑摘要与收尾一致）。`);
process.exitCode = ok ? 0 : 1;
