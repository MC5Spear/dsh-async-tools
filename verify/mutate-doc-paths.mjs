/**
 * 变异：往现行文档里塞**不存在的引用**，要求 `tools/check-doc-paths.mjs` 变红。
 *
 * ## 为什么必须做这一步
 *
 * 那条检查器挡的是"删了东西、文档还在指它"的两类退化：
 * ① 删了文件，文档还在指路径；② 删了 npm 脚本，文档还在让人跑它们。
 *
 * 一个不会失败的检查器在这里等于没写：它跑绿只能说明"没扫到"，
 * 说明不了"扫到的都存在"。本项目纪律：**恒真断言比缺测试更危险**。
 *
 * 本脚本会原地改写真实的 `CONTRIBUTING.md` 与 `README.md`，每条跑完立刻写回并核对摘要。
 *
 * 用法：node verify/mutate-doc-paths.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { checkDocPaths } from '../tools/check-doc-paths.mjs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从模块自身位置推仓根（verify/ 上一级）——变异脚本要在任意 cwd 下都能跑。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** M1 改它（一条本仓相对路径的指针）。
 *
 * 选 `CONTRIBUTING.md` 的理由：现行文档之一、受同一条检查器管辖、
 * `## 3. 文档维护` 标题小而稳定（注入点随现行章节走，见 ANCHOR）。
 */
const TARGET = join(ROOT, 'CONTRIBUTING.md');
/** M2 改它（一条 `npm run <脚本>` 的引用）。 */
const README = join(ROOT, 'README.md');

/**
 * 跑检查器。
 *
 * @returns {{red: boolean, tail: string}} 是否变红、输出末行。
 */
function run() {
  const { code, out: text } = checkDocPaths(ROOT, { quiet: true });
  const lines = text.trim().split('\n').filter((l) => l.trim() !== '');
  return { red: code !== 0, tail: lines.filter((l) => l.includes('→')).slice(0, 1).join('') || (lines.slice(-1)[0] ?? '') };
}

/** 注入点：`CONTRIBUTING.md` 里一个二级标题，插在它后面不会破坏结构（锚随现行章节走）。 */
const ANCHOR = '## 3. 文档维护';
/** 注入的指针：本仓相对路径且**一定不存在**。 */
const DEAD = '\n（变异注入：`verify/this-file-does-not-exist-mutation-probe.mjs`）\n';
/** M3 改它（一条 markdown 尖括号链接）。`docs/design.md` 的文件链接全部是
 * `(<../…>)` 形态——这一趟专守「链接形态的引用也会被核对」。 */
const DESIGN = join(ROOT, 'docs', 'design.md');
/** M3 注入点：design.md 的二级标题锚（章号会重排，标题文字稳定）。 */
const DESIGN_ANCHOR = '## 8. 验证设计';
/** M3 注入的链接：相对文档目录解析、目标**一定不存在**（`../lib/` 真实存在，
 * 挂掉的是文件名本身——正则若只查目录存在性会被这条抓住）。 */
const DEAD_LINK = `${DESIGN_ANCHOR}\n\n[变异注入](<../lib/no-such-file-mutation-probe.js>)\n`;

/**
 * M2 用的替换：把 README 里一个**真实存在**的 npm 脚本名改成不存在的。
 *
 * 名字里**必须带连字符**：检查器的脚本名字符类若不含连字符，会把名字截成
 * `check:docs`（存在 ⇒ 通过），变异逃逸；带连字符的名字演示"脚本名真的会被整个核对"。
 */
const SCRIPT_FROM = 'npm run check:docs';
const SCRIPT_TO = 'npm run check:docs-typo-does-not-exist';

const baseline = run();
if (baseline.red) {
  console.log(`BASELINE-RED  未变异时检查器就是红的（${baseline.tail}）——先修基线。本脚本**进程内**调用检查器（不起子进程，默认权限下即可跑），所以基线红就是检查器真的红了，不是环境问题。`);
  process.exit(2);
}
console.log(`基线：未变异时检查器通过（${baseline.tail}）。`);
console.log('');

/** 三条变异：路径引用、npm 脚本引用、markdown 链接引用。 */
const MUTATIONS = [
  {
    name: 'M1 现行文档里塞一条指向不存在文件的指针',
    target: TARGET,
    from: ANCHOR,
    to: `${ANCHOR}${DEAD}`
  },
  {
    name: 'M2 现行文档里让人跑一个不存在的 npm 脚本',
    target: README,
    from: SCRIPT_FROM,
    to: SCRIPT_TO
  },
  {
    name: 'M3 现行文档里塞一条指向不存在文件的尖括号链接',
    target: DESIGN,
    from: DESIGN_ANCHOR,
    to: DEAD_LINK
  }
];

let ok = true;
for (const m of MUTATIONS) {
  const before = readFileSync(m.target, 'utf8');
  const hash = createHash('sha256').update(before, 'utf8').digest('hex');
  try {
    if (!before.includes(m.from)) {
      console.log(`SKIP  ${m.name}——找不到锚点，本变异失效，当失败处理。`);
      ok = false;
      continue;
    }
    writeFileSync(m.target, before.replace(m.from, m.to), 'utf8');
    const after = run();
    console.log(`${after.red ? 'CAUGHT' : 'MISSED'}  ${m.name}`);
    if (after.red) console.log(`        ${after.tail}`);
    ok = after.red && ok;
  } finally {
    writeFileSync(m.target, before, 'utf8');
    const back = createHash('sha256').update(readFileSync(m.target, 'utf8'), 'utf8').digest('hex');
    if (back !== hash) throw new Error(`还原失败：${m.target} 与变异前不一致，请 git checkout 恢复。`);
  }
}
console.log('');
console.log(ok ? '三条变异都被抓住：路径引用、npm 脚本引用与链接引用三头都能失败。' : '**有变异逃逸**——检查器区分力不足。');
console.log('还原完成，摘要一致。');
process.exitCode = ok ? 0 : 1;
