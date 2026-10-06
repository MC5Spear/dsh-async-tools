/**
 * 变异：让 `tools/check-mutate-index.mjs` 面对一个**不一致**的 README 表，
 * 要求它变红。
 *
 * ## 为什么必须做这一步
 *
 * `check-mutate-index` 刚写出来、一跑就"一致"。而它挡的正是"手工维护的表漂移了
 * 却没人发现"——一条不会失败的判据在这里等于没写。本项目纪律：
 * **恒真断言比缺测试更危险**。
 *
 * 两个变异各验一头：
 * - M1：在表里塞一行指向**不存在**的脚本（验"表→盘"这一头）；
 * - M2：从表里删掉一行**真实存在**的脚本（验"盘→表"这一头）。
 *
 * ⚠️ 本脚本会原地改写真实的 `README.md`，跑完在 `finally` 里写回并核对摘要。
 *
 * 用法：node verify/mutate-mutate-index.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { checkMutateIndex } from '../tools/check-mutate-index.mjs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从模块自身位置推仓根（verify/ 上一级）——变异脚本要在任意 cwd 下都能跑。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARGET = join(ROOT, 'README.md');

const original = readFileSync(TARGET, 'utf8');
const hashBefore = createHash('sha256').update(original, 'utf8').digest('hex');

/**
 * 跑检查器。
 *
 * @returns {{red: boolean, out: string}} 是否变红、以及输出首行。
 */
function run() {
  const { code, out: text } = checkMutateIndex(ROOT, { quiet: true });
  const lines = text.trim().split('\n').filter((l) => l.trim() !== '');
  return { red: code !== 0, out: lines.slice(-1)[0] ?? '' };
}

/** 写回原文并核对摘要。 */
function restore() {
  writeFileSync(TARGET, original, 'utf8');
  const after = createHash('sha256').update(readFileSync(TARGET, 'utf8'), 'utf8').digest('hex');
  if (after !== hashBefore) throw new Error(`还原失败：${TARGET} 与变异前不一致，请 git checkout 恢复。`);
}

const baseline = run();
if (baseline.red) {
  console.log(`BASELINE-RED  未变异时检查器就是红的（${baseline.out}）——先修基线。本脚本**进程内**调用检查器（不起子进程，默认权限下即可跑），所以基线红就是检查器真的红了，不是环境问题。`);
  process.exit(2);
}
console.log(`基线：未变异时检查器通过（${baseline.out}）。`);
console.log('');

/**
 * 表里**真实存在**的那一行，用来做锚点。
 *
 * ⚠️ 这里曾经写死一整行字面量，**连描述文字一起**：
 * `| \`verify/mutate-escalation-removed.mjs\` | \`test/escalation.test.mjs\` | R11 提权整段拿掉 |`。
 * README 重写时那一格的措辞改了（去掉了前缀），锚点就再也匹配不上——两条变异双双 SKIP，
 * 本脚本于是报"**有变异逃逸**"。它没被任何人发现，因为 `verify/` 下的脚本不在电池里。
 *
 * 教训：**锚点不要钉在散文上**。这里改成按"表行的形态"取第一条 `verify/mutate-*.mjs` 行，
 * 描述怎么写都不影响；而对**脚本名**的变化保持敏感——那才是这张表真正要守的东西。
 */
const REAL_ROW = original.split('\n').find((line) => /^\|\s*`verify\/mutate-[\w-]+\.mjs`\s*\|/.test(line));
if (REAL_ROW === undefined) {
  console.log('找不到任何 `verify/mutate-*.mjs` 表行——README 的变异索引表**形态**变了（不只是措辞）。先修本脚本的锚点。');
  process.exit(2);
}

const MUTATIONS = [
  {
    name: 'M1 表里塞一行指向不存在的脚本',
    why: '验"表→盘"这一头：列了盘上没有的脚本，读者按图索骥会扑空',
    apply(text) {
      if (!text.includes(REAL_ROW)) return null;
      return text.replace(REAL_ROW, `${REAL_ROW}\n| \`verify/mutate-does-not-exist.mjs\` | \`test/jobs.test.mjs\` | 编的 |`);
    }
  },
  {
    name: 'M2 表里删掉一行真实存在的脚本',
    why: '验"盘→表"这一头：脚本在盘上却没登记，没人知道它跑哪个测试文件',
    apply(text) {
      if (!text.includes(REAL_ROW)) return null;
      return text.replace(`${REAL_ROW}\n`, '');
    }
  }
];

let ok = true;
try {
  for (const m of MUTATIONS) {
    const mutated = m.apply(original);
    if (mutated === null) {
      console.log(`SKIP  ${m.name}——找不到锚点，本变异失效，当失败处理。`);
      ok = false;
      continue;
    }
    writeFileSync(TARGET, mutated, 'utf8');
    const after = run();
    console.log(`${after.red ? 'CAUGHT' : 'MISSED'}  ${m.name}`);
    console.log(`        （${m.why}）`);
    if (after.red) console.log(`        ${after.out}`);
    ok = after.red && ok;
  }
} finally {
  restore();
}
console.log('');
console.log(ok ? '两个变异都被抓住：这条检查器两头都能失败。' : '**有变异逃逸**——检查器区分力不足。');
console.log('还原完成，摘要一致。');
process.exitCode = ok ? 0 : 1;
