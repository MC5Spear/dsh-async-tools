/**
 * 变异：把卡片样式**改回写死颜色**，要求 T14 变红。
 *
 * ## 为什么必须做这一步
 *
 * T14 是刚写的判据。不证明它能失败，它就只是"看着在那儿"——
 * 而这个项目已经吃过三次"判据从没被证明能失败"的亏。
 *
 * 变异内容就是**缺陷原形**：R27 起表单本体改用官方控件，自有样式只剩
 * `EnumField` 的壳与 select 本体（`ENUM_CSS`）；变异把 select 底色从
 * `var(--dsw-alias-bg-layer-3)` 改回 `#ffffff`——那正是深色主题下渲染成
 * 白底黑框的那类缺陷。
 *
 * ⚠️ **本脚本会原地改写真实的 `client.js`**（单包化后卡片就在
 * 本包根，2026-09-17），跑完在 `finally` 里写回并核对摘要。
 *
 * 用法：node verify/mutate-card-theme.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从模块自身位置推仓根（verify/ 上一级）——变异脚本要在任意 cwd 下都能跑。
const PKG = fileURLToPath(new URL('..', import.meta.url));
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

/** 写回原文并核对摘要。 */
function restore() {
  writeFileSync(TARGET, original, 'utf8');
  const after = createHash('sha256').update(readFileSync(TARGET, 'utf8'), 'utf8').digest('hex');
  if (after !== hashBefore) throw new Error(`还原失败：${TARGET} 与变异前不一致，请手工恢复。`);
}

const baseline = runTests();
if (baseline.red) {
  console.log(`BASELINE-RED  未变异时 ${TEST} 就是红的（${baseline.summary}）——先修基线；⚠️ 若括号里是空的、且本脚本以 2 退出，更可能是默认沙箱禁止捕获子进程输出（EPERM）：本脚本要跑测试文件，需带提权运行。规范见 verify/README.md 的「判据必须在默认权限下可跑」。`);
  process.exit(2);
}
console.log(`基线：未变异时 ${TEST} 全绿（${baseline.summary}）。`);
console.log('');

let ok = true;
try {
  const mutated = original
    .replace('border-radius:8px;"\n  + "background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;"',
      'border-radius:8px;"\n  + "background:#ffffff;font:inherit;font-size:13px;line-height:1.5;"');
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
console.log('');
console.log(ok ? '变异被抓住：这条判据真的能拦住写死颜色。' : '**变异逃逸**——判据区分力不足。');
console.log('还原完成，摘要一致。');
process.exitCode = ok ? 0 : 1;
