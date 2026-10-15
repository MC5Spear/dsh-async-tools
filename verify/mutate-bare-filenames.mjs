/**
 * 变异：往现行文档里塞一个**不存在的裸文件名**，要求 `tools/check-bare-filenames.mjs` 变红。
 *
 * ## 为什么必须做这一步
 *
 * 那条检查器挡的是"文档写光名字、文件已删"。一个不会失败的检查器
 * 在这里等于没写：它跑绿只能说明"没扫到"。本项目纪律：**恒真断言比缺测试更危险**。
 *
 * 本脚本会原地改写真实的 `docs/design.md`，跑完在 `finally` 里写回并核对摘要。
 *
 * 用法：node verify/mutate-bare-filenames.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { checkBareFilenames } from '../tools/check-bare-filenames.mjs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从模块自身位置推仓根（verify/ 上一级）——变异脚本要在任意 cwd 下都能跑。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARGET = join(ROOT, 'docs', 'design.md');

const original = readFileSync(TARGET, 'utf8');
const hashBefore = createHash('sha256').update(original, 'utf8').digest('hex');

/**
 * 跑检查器。
 *
 * @returns {{red: boolean, tail: string}} 是否变红、输出末行。
 */
function run() {
  const { code, out: text } = checkBareFilenames(ROOT, { quiet: true });
  const lines = text.trim().split('\n').filter((l) => l.trim() !== '');
  return { red: code !== 0, tail: lines.filter((l) => l.includes('→')).slice(0, 1).join('') || (lines.slice(-1)[0] ?? '') };
}

/** 写回原文并核对摘要。 */
function restore() {
  writeFileSync(TARGET, original, 'utf8');
  const after = createHash('sha256').update(readFileSync(TARGET, 'utf8'), 'utf8').digest('hex');
  if (after !== hashBefore) throw new Error(`还原失败：${TARGET} 与变异前不一致，请 git checkout 恢复。`);
}

/** 注入点：一个二级标题，插在它后面不破坏结构（锚随设计文档现行章节走）。 */
const ANCHOR = '## 10. 增补设计';
/** 注入的光文件名：**不带路径前缀**且一定不存在。 */
const DEAD = '\n（变异注入：`this-bare-name-does-not-exist-probe.mjs`）\n';

const baseline = run();
if (baseline.red) {
  console.log(`BASELINE-RED  未变异时检查器就是红的（${baseline.tail}）——先修基线。本脚本**进程内**调用检查器（不起子进程，默认权限下即可跑），所以基线红就是检查器真的红了，不是环境问题。`);
  process.exit(2);
}
console.log(`基线：未变异时检查器通过（${baseline.tail}）。`);
console.log('');

let ok = true;
try {
  if (!original.includes(ANCHOR)) {
    console.log(`SKIP  找不到锚点 ${ANCHOR}，本变异失效——当失败处理。`);
    ok = false;
  } else {
    writeFileSync(TARGET, original.replace(ANCHOR, `${ANCHOR}${DEAD}`), 'utf8');
    const after = run();
    console.log(`${after.red ? 'CAUGHT' : 'MISSED'}  M1 现行文档里塞一个不存在的裸文件名`);
    if (after.red) console.log(`        ${after.tail}`);
    ok = after.red && ok;
  }
} finally {
  restore();
}
console.log('');
console.log(ok ? '变异被抓住：裸文件名这条判据真的能失败。' : '**变异逃逸**——判据区分力不足。');
console.log('还原完成，摘要一致。');
process.exitCode = ok ? 0 : 1;
