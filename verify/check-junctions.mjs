/**
 * 开发树 node_modules 七条 junction 的重锚核验。
 *
 * 判据（按支持集合，支持集合的唯一权威是[包清单](<../package.json>)里九条 dsh peer 的原文）：
 *
 * - 六条 `@deepseek-ai` junction（cordis / dsh-jobs / dsh-sandbox / dsh-subagent /
 *   dsh-tools / schemastery）逐条存在、逐条指向**同一棵**宿主树的 `@deepseek-ai` 目录；
 * - dsh* 四条接受集合内**任一** rc，但四条必须**同 rc 版本**（同树同代，不许 rc.2 与
 *   rc.4 混接）；dsh* 的版本串必须落在支持集合内，集合外版本即红；
 * - cordis、schemastery 按各自预期版本判（`4.0.5` / `3.18.5`），它们不随宿主 rc 改号；
 * - 第七条 zod（**顶层平铺**，非 `@deepseek-ai` 域）锚同一棵树的顶层 `node_modules\zod`，
 *   版本 `4.6.7`——投影 stateSchema 的注册表契约是 zod，与宿主同一物理实例、零版本漂移。
 *
 * ## 树根从哪来
 *
 * 树根**只有一个来源**：`tools/_local-config.mjs` 从本机侧读（或环境变量
 * `DSAT_HOST_MODULES`）。`evidenceTree['021']` 的缺省值就是 `<hostModules>/@deepseek-ai`，
 * 所以"宿主锚"与"证据锚"在构造上不可能指向两棵不同的树。
 *
 * 对账段保留，形态是断言"树的消费者不许自带树根"——
 * 下面 `TREE_CONSUMERS` 列出的每个模块都必须引用配置加载器。自带绝对路径字面量的
 * 情形另有 `tools/check-public-surface.mjs` 从全局承接（公开范围零本机指纹）。
 *
 * ## 与 `npm test` 的关系
 *
 * 这是**接线层**守卫（与单测的替身层互补）：单测经 `DSAT_HOST_MODULES` 锚解析宿主包，
 * junction 只服务不经钩子的解析路径（编辑器、裸 node 冒烟、实体接线同款清单）。
 * junction 锚错树时，`_host-resolve` 的 `.volatile is not a function` 诚实信号管钩子路径，
 * 本脚本管 junction 路径。
 *
 * ## 跳过态
 *
 * 本机环境缺席（CI、外部 clone）时打一行 `SKIP` 放过。本机上**没有跳过态**：
 * junction 是开发机接线状态，缺席就是红（那份七条清单是交付物本身）。
 *
 * 用法：`node verify/check-junctions.mjs [--tree <受支持宿主树的 @deepseek-ai 目录>]`
 */
import { readFileSync, readlinkSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_DIR, loadLocalPlaneOrSkip } from '../tools/_local-config.mjs';
import { readSupportSet } from '../tools/check-host-compat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const NM = join(ROOT, 'node_modules', '@deepseek-ai');

const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const support = readSupportSet(MANIFEST);
if (support.problems.length > 0) {
  for (const item of support.problems) console.log(`BAD-MANIFEST ${item}`);
  process.exit(1);
}
const SUPPORT = new Set(support.members);
const SUPPORT_TEXT = support.members.join(' / ');

const TREE_ARG = process.argv.includes('--tree') ? process.argv[process.argv.indexOf('--tree') + 1] : undefined;
if (process.argv.includes('--tree') && (TREE_ARG === undefined || TREE_ARG.startsWith('--'))) {
  console.error('用法：node verify/check-junctions.mjs [--tree <受支持宿主树的 @deepseek-ai 目录>]');
  process.exit(2);
}

const config = await loadLocalPlaneOrSkip('verify/check-junctions.mjs（开发树 junction 核验）');
const TREE = TREE_ARG ?? config.evidenceTree['021'];
if (TREE === undefined) {
  console.error('宿主锚无来源：配置里既没有 evidenceTree[\'021\']，也没有 hostModules。');
  console.error(`二选一：在 ${LOCAL_DIR}/config.mjs 里写 hostModules，或设环境变量 DSAT_HOST_MODULES；`
    + '也可以临时用 --tree <路径> 覆盖。');
  process.exit(2);
}

/** 配套依赖的期望版本：不随宿主 rc 改号，按上游各自版本判。 */
const EXPECTED = {
  cordis: '4.0.5',
  schemastery: '3.18.5'
};

/** dsh* junction：接受集合内任一 rc，但四条必须同 rc（同树同代）。 */
const DSH_JUNCTIONS = ['dsh-jobs', 'dsh-sandbox', 'dsh-subagent', 'dsh-tools'];

/** zod 在**顶层平铺**（非 `@deepseek-ai` 域）——junction 落在 `node_modules\zod`。 */
const ZOD = { name: 'zod', wantVersion: '4.6.7' };

const TREE_TOP = dirname(TREE); // 0.2.1 树 node_modules 根（zod 顶层平铺用）

/**
 * 树根的消费者：每个都**必须**从配置加载器取树，不许自带树根字面量。
 *
 * 加一个新的树消费者时要同步登记——
 * 漏登记不会立刻红，但下一个人就没有地方看到这条约定。
 *
 * `tools/_host-resolve.mjs` **不在名单里**：它就是锚的提供方（环境变量契约
 * `DSAT_HOST_MODULES`/`DSH_HOME` 的实现），把它列进来等于要求它引用自己。
 * 消费方引用它（`LOADER_REF` 认 `_host-resolve.mjs`）与引用 `_local-config.mjs`
 * 同效。
 */
const TREE_CONSUMERS = [
  'verify/check-facts-anchors.mjs',
  'verify/check-agent-policy.mjs',
  'verify/mutate-agent-policy.mjs',
  'verify/diff-trees.mjs',
  'tools/validate-preset.mjs',
  'test/preset.test.mjs'
];

let bad = 0;
let checked = 0;

/**
 * 单条 junction 的四段核验（存在 / 形态 / 指树 / 版本），返回目标版本。
 *
 * @param {object} entry - 核验项。
 * @param {string} entry.label - 展示名。
 * @param {string} entry.link - junction 路径。
 * @param {string} entry.wantTarget - 期望目标（同一棵宿主树下的同名目录）。
 * @param {(version: string) => string | undefined} entry.verdict - 版本判定；返回原因即失败。
 * @returns {string | undefined} 通过时的目标版本；失败时 `undefined`。
 */
function checkOne({ label, link, wantTarget, verdict }) {
  checked += 1;
  let st;
  try {
    st = lstatSync(link);
  } catch {
    console.log(`MISSING  ${label}：${link} 不存在（junction 缺席就是红——那份七条清单是交付物）`);
    bad += 1;
    return undefined;
  }
  if (!st.isSymbolicLink()) {
    console.log(`NOT-LINK ${label}：不是 junction/符号链接（开发树接线形态走 junction）`);
    bad += 1;
    return undefined;
  }
  const target = readlinkSync(link);
  if (target.toLowerCase() !== wantTarget.toLowerCase()) {
    console.log(`WRONG-TREE ${label}：指向 ${target}，期望 ${wantTarget}`);
    bad += 1;
    return undefined;
  }
  let version;
  try {
    version = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version;
  } catch (error) {
    console.log(`BAD-TARGET ${label}：目标不可读（${error.code}）`);
    bad += 1;
    return undefined;
  }
  const reason = verdict(version);
  if (reason !== undefined) {
    console.log(`VERSION   ${label}：目标版本 ${version}，${reason}`);
    bad += 1;
    return undefined;
  }
  console.log(`OK       ${label} -> ${target}（${version}）`);
  return version;
}

for (const [name, wantVersion] of Object.entries(EXPECTED)) {
  checkOne({
    label: name,
    link: join(NM, name),
    wantTarget: join(TREE, name),
    verdict: (version) => (version === wantVersion ? undefined : `期望 ${wantVersion}（配套依赖按自身版本，不随宿主 rc 改号）`)
  });
}

// dsh* 四条：接受集合内任一 rc，但必须同 rc——同一条兼容线的宿主树不会被两次安装
// 拼成两代实现。
const dshVersions = new Map();
for (const name of DSH_JUNCTIONS) {
  const version = checkOne({
    label: name,
    link: join(NM, name),
    wantTarget: join(TREE, name),
    verdict: (value) => (SUPPORT.has(value) ? undefined : `不在支持集合 ${SUPPORT_TEXT} 内`)
  });
  if (version !== undefined) dshVersions.set(name, version);
}
if (dshVersions.size > 0) {
  const distinct = new Set(dshVersions.values());
  if (distinct.size > 1) {
    bad += 1;
    console.log(`MIXED-RC ${[...dshVersions].map(([name, version]) => `${name}=${version}`).join(' ')}`
      + `——dsh* junction 必须同 rc 版本（支持集合 ${SUPPORT_TEXT}）`);
  } else {
    console.log(`OK       dsh* junction 同 rc：${[...distinct][0]}（支持集合 ${SUPPORT_TEXT}）`);
  }
}

// zod 顶层平铺（node_modules\zod → 运行树顶层 node_modules\zod）。
checkOne({
  label: `${ZOD.name}（顶层）`,
  link: join(ROOT, 'node_modules', ZOD.name),
  wantTarget: join(TREE_TOP, ZOD.name),
  verdict: (version) => (version === ZOD.wantVersion ? undefined : `期望 ${ZOD.wantVersion}（与宿主同一物理实例）`)
});

// ── 树根唯一来源的对账段 ────────────────────────────────────────────────────
//
// 判据：每个树消费者都必须**引用配置加载器**（或经 `_host-resolve` 的环境变量契约）——
// 树根常量只许存在于配置加载器一处，"另一处偷偷自带树根"即红。
const LOADER_REF = /_local-config\.mjs|_host-resolve\.mjs/;
for (const file of TREE_CONSUMERS) {
  checked += 1;
  let text;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch (error) {
    console.log(`ANCHOR-UNREADABLE ${file}（${error.code}）——对账无从进行，按红处理`);
    bad += 1;
    continue;
  }
  if (!LOADER_REF.test(text)) {
    console.log(`ANCHOR-INDEPENDENT ${file}：它消费树根却没有引用配置加载器——`
      + `树根只许有一个来源（${LOCAL_DIR}/config.mjs / DSAT_HOST_MODULES）`);
    bad += 1;
    continue;
  }
  console.log(`OK       ${file} 经配置加载器取树根`);
}

console.log(`树根 ${TREE}`);
console.log(bad === 0
  ? `七条 junction 全部锚运行树且版本符合线、${String(TREE_CONSUMERS.length)} 个树消费者都经配置加载器取根`
    + `（${String(checked)}/${String(checked)}）`
  : `${String(bad)} 条不合格`);
process.exitCode = bad === 0 ? 0 : 1;
