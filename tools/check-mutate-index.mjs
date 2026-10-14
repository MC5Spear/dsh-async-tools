/**
 * README 的"变异脚本 ↔ 测试文件"表必须与盘上的文件一致。
 *
 * ## 这条判据挡什么
 *
 * 手工维护的名单会**漂移**：表里可能列着早已删掉的脚本，接手的人按图索骥全落空。
 *
 * 判据两头都查：
 * ① 表里列的每个脚本**必须在盘上**（指向不存在的文件 = 读者扑空）；
 * ② 每个变异脚本**必须在表里**（漏登记 = 没人知道它跑哪个测试文件，
 *    而"跑错文件"会报 MISSED、看起来像"断言是空的"）。
 *
 * 落点是一条通用纪律：**静态检查器的名单漏一项就是假绿**。
 *
 * 用法：node tools/check-mutate-index.mjs
 *
 * ## 双入口形态
 *
 * `checkMutateIndex(root)` 可导入（测试进程内调用，避免沙箱下 spawn EPERM 的假红）；
 * CLI 入口只在直接执行时生效。与 `tools/validate-preset.mjs` 同款分工。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 不进 README 表的豁免项——**每条都要写清理由**。
 *
 * 判据：README 那张表回答的是"**改坏哪个实现、跑哪个测试文件**"。
 * 若一个脚本改的**不是交付实现**、而是**检查器自己**，它就没有"跑的测试文件"这一列可言，
 * 塞进表里会把表的语义搅浑。
 *
 * ⚠️ 豁免不是"漏登记的借口"：名单里的条目验的都是检查器自身
 * （用变异证明那张表两头都能失败）。将来再有检查器的自测脚本，**不要默默加进来**——
 * 先判断它该不该有自己的"跑哪个测试文件"，判断不了就问。
 */
const EXEMPT_FROM_TABLE = new Map([
  ['verify/mutate-mutate-index.mjs', '验证 tools/check-mutate-index.mjs 自身的两头都能失败，不改交付实现'],
  ['verify/mutate-doc-paths.mjs', '验证 tools/check-doc-paths.mjs 能拦住悬空指针，不改交付实现'],
  ['verify/mutate-bare-filenames.mjs', '验证 tools/check-bare-filenames.mjs 能拦住裸文件名悬空，不改交付实现'],
  ['verify/mutate-facts-anchors.mjs', '验证 verify/check-facts-anchors.mjs 的三条判据（行号越界 / 文件不存在 / 四字段不齐）都能失败，不改交付实现'],
  ['verify/mutate-r24-ui.mjs', '验证 verify/r24-judgements.mjs 的界面判据（下发字节 / 配置页读数 / 保存往返 / 两段读数）都能失败，不改交付实现'],
  ['verify/mutate-model-text.mjs', '验证 tools/check-model-text.mjs 的硬编码文案层（像句子的字面量必须来自 lib/text.js）能失败，不改交付实现'],
  ['verify/mutate-alias-tokens.mjs', '验证 tools/check-alias-tokens.mjs 能拦住未定义的 --dsw-alias-* 引用；判据长在检查器而非测试文件，没有"跑的测试文件"一列'],
  ['verify/mutate-agent-policy.mjs', '验证 verify/check-agent-policy.mjs 的钉版判据（宿主锚与本包锚整段互锚）都能失败——变异打的是检查器的输入（本包副本/宿主源文本），不改交付行为；交付侧单测在 test/agent-policy.test.mjs，与本表无关'],
  ['verify/mutate-public-surface.mjs', '验证 tools/check-public-surface.mjs 的三类判据（结构 / 本机指纹 / 内部引用）都能失败——变异打在**合成树**上（不碰真仓），不改交付实现；判据语义的单测在 test/public-surface.test.mjs']
]);

// ── 从 README 的表里抽出"脚本"列的路径 ────────────────────────────────────
//
// 表行形如：`| verify/mutate-x.mjs | test/x.test.mjs | 覆盖 |`
// ⚠️ 单元格**可以带反引号也可以不带**——若只认带反引号的形式，而 README 里
// 那一列没加，于是基线就假红。两种都收。
// 只认首列是 `verify/mutate-*.mjs` 的表格行，正文里的顺带提及不算。
const unquote = (cell) => cell.replace(/^`/, '').replace(/`$/, '').trim();

/**
 * 跑一遍变异索引检查。
 *
 * @param {string} root - 仓库根。
 * @param {{quiet?: boolean}} [options] - `quiet:true` 时不向 stdout 打印（测试用）。
 * @returns {{ok: boolean, code: number, out: string, onDiskCount: number}} `onDiskCount` = 盘上变异脚本数。
 */
export function checkMutateIndex(root = MODULE_ROOT, { quiet = false } = {}) {
  const lines = [];
  const say = (line) => {
    lines.push(line);
    if (!quiet) console.log(line);
  };

  /** 盘上真实存在的变异脚本（`verify/mutate-*.mjs`）。 */
  const onDisk = new Set(
    readdirSync(join(root, 'verify'))
      .filter((name) => /^mutate-.*\.mjs$/.test(name))
      .map((name) => `verify/${name}`)
  );

  const listed = new Map();
  for (const line of readFileSync(join(root, 'README.md'), 'utf8').split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const script = /^(verify\/mutate-[^\s`]+\.mjs)$/.exec(unquote(cells[1]));
    if (script === null) continue;
    const test = /^(test\/[^\s`]+\.test\.mjs)$/.exec(unquote(cells[2]));
    listed.set(script[1], test === null ? null : test[1]);
  }

  const problems = [];

  for (const script of listed.keys()) {
    if (!onDisk.has(script)) problems.push(`README 列了 ${script}，但盘上不存在（读者会扑空）`);
  }
  for (const script of onDisk) {
    if (listed.has(script) || EXEMPT_FROM_TABLE.has(script)) continue;
    problems.push(`盘上有 ${script}，但 README 的表里没登记（没人知道它跑哪个测试文件）`);
  }
  // 豁免项也必须真的在盘上——豁免一个不存在的文件说明名单烂了。
  for (const script of EXEMPT_FROM_TABLE.keys()) {
    if (!onDisk.has(script)) problems.push(`豁免名单里有 ${script}，但盘上不存在（名单该清）`);
  }
  // 表里声明的测试文件也要真的存在——列一个不存在的测试文件同样会让人扑空。
  // ⚠️ 豁免项跳过这一列：它们登记在**另一张表**（"验什么"），第二列是说明文字不是测试文件。
  for (const [script, test] of listed) {
    if (EXEMPT_FROM_TABLE.has(script)) continue;
    if (test === null) { problems.push(`${script} 那一行的"跑的测试文件"列不是 \`test/*.test.mjs\` 形式`); continue; }
    try {
      readFileSync(join(root, test), 'utf8');
    } catch {
      problems.push(`${script} 声明跑 ${test}，但那个文件不存在`);
    }
  }

  say(`盘上的变异脚本 ${String(onDisk.size)} 个；README 表里登记 ${String(listed.size)} 个。`);
  for (const [script, test] of listed) say(`  ${script} → ${String(test)}`);

  let ok;
  if (problems.length > 0) {
    say('');
    for (const p of problems) say(`  **${p}**`);
    say('');
    say(`变异索引与现实不一致：${String(problems.length)} 处。`);
    ok = false;
  } else {
    say('');
    say('变异索引与现实一致。');
    ok = true;
  }
  return { ok, code: ok ? 0 : 1, out: lines.join('\n'), onDiskCount: onDisk.size };
}

// CLI 入口：只在直接执行时生效。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(checkMutateIndex(MODULE_ROOT).code);
}
