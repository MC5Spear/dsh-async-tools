/**
 * 变异：往现行文档里塞**不存在的引用**，要求 `tools/check-doc-paths.mjs` 变红。
 *
 * ## 为什么必须做这一步
 *
 * 那条检查器挡的是"删了东西、文档还在指它"——本轮真实发生过两类：
 * ① 删了文件，文档还在指路径（独立审查 r11 的 N3 数出约 50 处）；
 * ② 删了 npm 脚本（`probe:e2e` / `probe:schema`），文档还在让人跑它们。
 *
 * 一个不会失败的检查器在这里等于没写：它跑绿只能说明"没扫到"，
 * 说明不了"扫到的都存在"。本项目纪律：**恒真断言比缺测试更危险**。
 *
 * ⚠️ 本脚本会原地改写真实的 `CONTRIBUTING.md` 与 `README.md`，每条跑完立刻写回并核对摘要。
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
 * 这里曾经指 `docs/facts.md`——那棵树在"公开面／本机平面"分流时搬进了 `.local/docs/`，
 * 于是本脚本**每次跑都在读一个不存在的文件**并抛 ENOENT。它没被任何人发现，因为
 * `verify/` 下的脚本不在电池里。后来改成安全政策文件：现行文档之一、受同一条检查器
 * 管辖、标题小而稳定；2026-10 该文件随参与政策收紧**删除**，于是再换 `CONTRIBUTING.md`
 * ——同样的理由依然成立（现行文档、受管辖、`## 二、跑起来` 标题小而稳定）。
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

/** 注入点：`CONTRIBUTING.md` 里一个二级标题，插在它后面不会破坏结构。 */
const ANCHOR = '## 二、跑起来';
/** 注入的指针：本仓相对路径且**一定不存在**。 */
const DEAD = '\n（变异注入：`verify/this-file-does-not-exist-mutation-probe.mjs`）\n';

/**
 * M2 用的替换：把 README 里一个**真实存在**的 npm 脚本名改成不存在的。
 *
 * ⚠️ 名字里**必须带连字符**：第一版我用的是 `check:docs-typo-…`，而当时检查器的
 * 字符类是 `[a-z0-9:]*`——它把名字截成 `check:docs`（存在 ⇒ 通过），于是这条变异
 * **逃逸**了。逃逸暴露的正是那个真缺陷（带连字符的脚本名整个漏检）。现在演示的是
 * "带连字符的名字真的会被核对"。
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

/** 两条变异：一条验路径引用，一条验 npm 脚本引用。 */
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
console.log(ok ? '两条变异都被抓住：路径引用与 npm 脚本引用两头都能失败。' : '**有变异逃逸**——检查器区分力不足。');
console.log('还原完成，摘要一致。');
process.exitCode = ok ? 0 : 1;
