/**
 * 开发树 node_modules 七条 junction 的重锚核验。
 *
 * 判据：六条 `@deepseek-ai` junction（cordis / dsh-jobs / dsh-sandbox / dsh-subagent /
 * dsh-tools / schemastery）必须逐条存在、逐条指向 0.2.1 线树的 `@deepseek-ai` 目录，
 * 且目标的版本串符合线（dsh* = 0.2.1-rc.4；cordis 4.0.5；schemastery 3.18.5）；
 * 第七条 zod（**顶层平铺**，非 `@deepseek-ai` 域）锚树顶层 `node_modules\zod`，
 * 版本 4.6.7——投影 stateSchema 的注册表契约是 zod，与宿主同一物理实例、零版本漂移。
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
 * 用法：`node verify/check-junctions.mjs [--tree <0.2.1 线树的 @deepseek-ai 目录>]`
 */
import { readFileSync, readlinkSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_DIR, loadLocalPlaneOrSkip } from '../tools/_local-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const NM = join(ROOT, 'node_modules', '@deepseek-ai');

const TREE_ARG = process.argv.includes('--tree') ? process.argv[process.argv.indexOf('--tree') + 1] : undefined;
if (process.argv.includes('--tree') && (TREE_ARG === undefined || TREE_ARG.startsWith('--'))) {
  console.error('用法：node verify/check-junctions.mjs [--tree <0.2.1 线树的 @deepseek-ai 目录>]');
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

/** 期望表：junction 名 → 目标版本串（dsh* 精确锁 0.2.1-rc.4；平台包随上游）。 */
const EXPECTED = {
  cordis: '4.0.5',
  'dsh-jobs': '0.2.1-rc.4',
  'dsh-sandbox': '0.2.1-rc.4',
  'dsh-subagent': '0.2.1-rc.4',
  'dsh-tools': '0.2.1-rc.4',
  schemastery: '3.18.5'
};

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

/** 单条 junction 的四段核验（存在 / 形态 / 指树 / 版本）。 */
function checkOne({ label, link, wantTarget, wantVersion }) {
  checked += 1;
  let st;
  try {
    st = lstatSync(link);
  } catch {
    console.log(`MISSING  ${label}：${link} 不存在（junction 缺席就是红——那份七条清单是交付物）`);
    bad += 1;
    return;
  }
  if (!st.isSymbolicLink()) {
    console.log(`NOT-LINK ${label}：不是 junction/符号链接（开发树接线形态走 junction）`);
    bad += 1;
    return;
  }
  const target = readlinkSync(link);
  if (target.toLowerCase() !== wantTarget.toLowerCase()) {
    console.log(`WRONG-TREE ${label}：指向 ${target}，期望 ${wantTarget}`);
    bad += 1;
    return;
  }
  let version;
  try {
    version = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version;
  } catch (error) {
    console.log(`BAD-TARGET ${label}：目标不可读（${error.code}）`);
    bad += 1;
    return;
  }
  if (version !== wantVersion) {
    console.log(`VERSION   ${label}：目标版本 ${version}，期望 ${wantVersion}`);
    bad += 1;
    return;
  }
  console.log(`OK       ${label} -> ${target}（${version}）`);
}

for (const [name, wantVersion] of Object.entries(EXPECTED)) {
  checkOne({
    label: name,
    link: join(NM, name),
    wantTarget: join(TREE, name),
    wantVersion
  });
}

// zod 顶层平铺（node_modules\zod → 运行树顶层 node_modules\zod）。
checkOne({
  label: `${ZOD.name}（顶层）`,
  link: join(ROOT, 'node_modules', ZOD.name),
  wantTarget: join(TREE_TOP, ZOD.name),
  wantVersion: ZOD.wantVersion
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
