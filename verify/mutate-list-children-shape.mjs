/**
 * 变异：把 `listChildren()` 的行形状消费改回**只认判别联合**，要求 `test/wait-delivery.test.mjs` 变红。
 *
 * ## 为什么必须做这一步
 *
 * 真机缺陷（`async_wait_agent` 对刚派发的子代理报 `unknown subagent`、
 * `Known children:` 空清单）根因就是**行形状漂移**。三个变异各自对应一种真实退化：
 *
 * - **M1 只认 `kind === 'child'`**：0.1.7 的 catalog 行没有 `kind`，过滤后一行不剩
 *   ⇒ 屏障恒 `not_found`（真机缺陷原形）；
 * - **M2 纠错清单按 `kind` 过滤**：清单恒空 ⇒ 模型拿不到任何可纠错线索；
 * - **M3 不排除诊断行**：`kind: 'diagnostic'` 的行被当成可等待的子代理
 *   ⇒ 对一条读不出来的记录进入等待，而不是给出 not_found。
 *
 * **本脚本会原地改写真实的 `lib/wait-agent-target.js`**，跑完在
 * `finally` 里写回并核对摘要。
 *
 * 用法：node verify/mutate-list-children-shape.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从模块自身位置推仓根（verify/ 上一级）——变异脚本要在任意 cwd 下都能跑。
const PKG = fileURLToPath(new URL('..', import.meta.url));
const TARGET = join(PKG, 'lib', 'wait-agent-target.js');
const TEST = 'test/wait-delivery.test.mjs';

const original = readFileSync(TARGET, 'utf8');
const hashBefore = createHash('sha256').update(original, 'utf8').digest('hex');

/** 三种退化：每个都改坏一处，锚点必须唯一命中（否则 SKIP，当失败处理）。 */
const MUTATIONS = [
  {
    id: 'M1',
    what: '屏障只认 kind === "child"（真机缺陷原形：catalog 行被全部滤掉）',
    apply: (text) => text.replace(
      "entries.find((entry) => entry?.id === agentId && entry?.kind !== 'diagnostic')",
      "entries.find((entry) => entry?.kind === 'child' && entry.id === agentId)")
  },
  {
    id: 'M2',
    what: '纠错清单按 kind === "child" 过滤（真机现象：Known children 为空）',
    apply: (text) => text.replace(
      'return entries.map((entry) => describeEntry(entry, this.config.agentLang, t));',
      "return entries.filter((entry) => entry?.kind === 'child').map((entry) => describeEntry(entry, this.config.agentLang, t));")
  },
  {
    id: 'M3',
    what: '不排除诊断行（读不出来的记录被当成可等待子代理）',
    apply: (text) => text.replace(
      "entry?.id === agentId && entry?.kind !== 'diagnostic'",
      'entry?.id === agentId')
  }
];

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
  console.log(`BASELINE-RED  未变异时 ${TEST} 就是红的（${baseline.summary}）——先修基线；若括号里是空的、且本脚本以 2 退出，更可能是默认沙箱禁止捕获子进程输出（EPERM）：本脚本要跑测试文件，需带提权运行。规范见 verify/README.md 的「优先默认权限执行；纯函数判断尽量进程内复用」要点。`);
  process.exit(2);
}
console.log(`基线：未变异时 ${TEST} 全绿（${baseline.summary}）。`);
console.log('');

let ok = true;
try {
  for (const mutation of MUTATIONS) {
    const mutated = mutation.apply(original);
    if (mutated === original) {
      console.log(`SKIP  ${mutation.id} 找不到锚点，本变异失效——当失败处理。`);
      ok = false;
      continue;
    }
    writeFileSync(TARGET, mutated, 'utf8');
    const after = runTests();
    console.log(`${after.red ? 'CAUGHT' : 'MISSED'}  ${mutation.id} ${mutation.what}  ${after.summary}`);
    if (after.firstFail !== '') console.log(`        ${after.firstFail}`);
    ok = after.red && ok;
    writeFileSync(TARGET, original, 'utf8');
  }
} finally {
  restore();
}
console.log('');
console.log(ok ? '三个变异都被抓住：形状自适应、纠错清单、诊断行排除都有能失败的判据。' : '**有变异逃逸**——判据区分力不足。');
console.log('还原完成，摘要一致。');
process.exitCode = ok ? 0 : 1;
