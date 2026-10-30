/**
 * 宿主兼容声明与解析来源检查（设计 7.3、8.2“版本与客户端”）。
 *
 * 判据分两部分，都在**离线**形态下完成，可放进 CI 的三宿主矩阵：
 *
 * 1. **官方准入判定**：用宿主自带的 `evaluatePluginCompatibility`（`@deepseek-ai/dsh-app-boot`）
 *    读本包清单——支持集合内三个版本全部放行（返回 `undefined`），集合外边界全部拒载，
 *    且拒载来自九条 dsh peer 而不是 `engines.dsh`。支持集合只有一个权威来源：包清单的
 *    dsh peer 原文；本脚本不另存一份版本表。
 * 2. **宿主树解析来源**：从显式给定的宿主安装树解析九个 dsh peer 与 peer 形态的配套依赖
 *    （`cordis`、`cordis-plugin-timer`），要求落在该树顶层、版本与声明相符；九个 dsh peer
 *    的版本必须全部等于本次宿主版本（同树同 rc）。一个宿主通过不等于集合通过，所以 CI
 *    按矩阵逐宿主运行本脚本。
 *
 * ## 它不证明什么
 *
 * 本脚本解析的是**给定的宿主安装树**：它回答“这棵树上的九个 peer 与配套 peer 是不是同代、
 * 同树、符合声明”。它**不**证明已安装插件在真实 runtime 里实际取得的 peer 路径——插件经
 * profile 装载时，解析基点是 profile 自己的 node_modules，与这里显式给的宿主树可能不是同一处。
 * 真实 runtime 的解析路径由运行期观测（observer）核对，不用本脚本的通过代替。
 *
 * ## 叶子依赖的两种安装形态
 *
 * `dependencies` 里的 `@deepseek-ai/schemastery`、`zod` 有两种真实落法，判据分开：
 *
 * - `--leaf-layout host`（缺省，CI 与开发树）：也必须解析自宿主树顶层。
 * - `--leaf-layout profile`（宿主 CLI 装进 profile 的形态）：允许插件在 profile 本地
 *   带一份同名副本——此时不按物理路径判失败，改为要求副本版本与宿主树同名包版本相同，
 *   并满足本包声明范围。路径不同本身不构成失败，版本不同才失败。
 *
 * ## 为什么宿主根与版本要显式传
 *
 * `--host-root` 是本次要核对的安装树，`--host-version` 是 CI 作业显式安装的精确宿主版本。
 * 两者都由调用方给出，脚本不去猜“机器上装的是哪个版本”，也不把宿主链静态 import 到
 * 测试文件顶层（离线形态下那些包本来就不存在）。缺少宿主根按环境不足退出（退出码 2），
 * 与判据失败（退出码 1）分开记录。
 *
 * 用法：
 *   node tools/check-host-compat.mjs --host-root <宿主安装树根或其 node_modules> \
 *     [--host-version <精确宿主版本>] [--leaf-layout <host|profile>] [--plugin-root <插件安装目录>]
 *
 * 也可作为模块导入：`checkHostCompat({ root, hostRoot, hostVersion, leafLayout, pluginRoot })`
 * 返回 `{ ok, code, out, lines }`，`test/host-compat.test.mjs` 用它跑进程内断言。
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 九个 dsh peer 的判定口径：`@deepseek-ai/dsh` 自身与 `@deepseek-ai/dsh-*` 后代。 */
const dshPeerName = (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');

/**
 * 支持集合成员必须是**精确 rc 版本串**（本线 `0.2.1-rc.N`）。
 * 范围写法（`*`、`^0.2.1`、`>=0.2.1-rc.2`）都不是精确项：有它们就没有“支持集合”可言，
 * 而且 `*` 会让宿主兼容判定放行集合外版本。
 */
const EXACT_MEMBER = /^0\.2\.1-rc\.\d+$/;

/** 本包必须放行的宿主版本来自 peer 原文；集合外边界用来证明拒载真的发生。 */
const REJECTED_BOUNDARIES = [
  ['0.2.1', '正式版'],
  ['0.2.0', '上一版本线'],
  ['0.2.2', '下一版本线'],
  ['0.2.1-rc.5', '未列入集合的新 rc']
];

/**
 * 解析一次宿主根输入：既接受“含 node_modules 的安装树根”，也接受 node_modules 目录本身。
 * @param {string} input - `--host-root` 原值。
 * @returns {{ treeRoot: string, modules: string } | undefined} 两种形态归一后的根；不可用时 `undefined`。
 */
function normalizeHostRoot(input) {
  const abs = resolve(input);
  const isModules = existsSync(join(abs, '@deepseek-ai', 'dsh', 'package.json'));
  const treeRoot = isModules ? dirname(abs) : abs;
  const modules = isModules ? abs : join(abs, 'node_modules');
  if (!existsSync(join(modules, '@deepseek-ai', 'dsh', 'package.json'))) return undefined;
  return { treeRoot, modules };
}

/**
 * 读包清单并取出支持集合。
 *
 * 支持集合的唯一权威是九条 dsh peer 的原文：本函数只核对“九条逐字符相同”，
 * 再把原文拆成精确版本列表。缺一条、多一条、写成范围或重复列同一版本都按失败返回。
 *
 * @param {object} manifest - 已解析的 `package.json`。
 * @returns {{ range?: string, members?: string[], dshPeers: string[], problems: string[] }} 支持集合或失败原因。
 */
export function readSupportSet(manifest) {
  const problems = [];
  const peers = manifest.peerDependencies ?? {};
  const dshPeers = Object.keys(peers).filter(dshPeerName);
  if (dshPeers.length !== 9) problems.push(`dsh peer 应有 9 条，实际 ${String(dshPeers.length)} 条`);
  const ranges = new Set(dshPeers.map((name) => peers[name]));
  if (ranges.size !== 1) {
    problems.push(`九条 dsh peer 声明不一致：${[...ranges].map((range) => JSON.stringify(range)).join('、')}`);
  }
  if (Object.hasOwn(manifest.engines ?? {}, 'dsh')) {
    problems.push('包清单声明了 engines.dsh——宿主的兼容判定会改由它单独裁决并忽略 peer，支持集合因此失效');
  }
  const range = dshPeers.length > 0 ? peers[dshPeers[0]] : undefined;
  const members = typeof range === 'string'
    ? range.split('||').map((item) => item.trim()).filter((item) => item.length > 0)
    : [];
  if (typeof range === 'string') {
    if (members.length === 0) {
      problems.push(`peer 支持集合为空：${JSON.stringify(range)}`);
    } else {
      const inexact = members.filter((item) => !EXACT_MEMBER.test(item));
      if (inexact.length > 0) {
        problems.push(`peer 支持集合含非精确项 ${inexact.map((item) => JSON.stringify(item)).join('、')}`
          + '——集合成员必须逐项为 0.2.1-rc.N，范围写法（如 * / ^0.2.1）不算支持集合');
      }
      if (new Set(members).size !== members.length) problems.push('peer 支持集合重复列同一版本');
    }
  }
  return { range, members, problems, dshPeers };
}

/**
 * 跑一遍兼容声明与解析来源检查。
 *
 * @param {object} options - 输入。
 * @param {string} [options.root] - 本包仓根（读 `package.json`）。
 * @param {string | undefined} options.hostRoot - 宿主安装树根或其 `node_modules`。
 * @param {string | undefined} options.hostVersion - CI 显式安装的精确宿主版本；省略时读树内版本并注明来源。
 * @param {'host' | 'profile'} [options.leafLayout] - `dependencies` 的安装形态：`host` 要求宿主树顶层副本；`profile` 允许插件安装位置的同版本地副本。
 * @param {string | undefined} [options.pluginRoot] - `profile` 形态下插件安装目录（解析本地副本的基准）。
 * @param {boolean} [options.quiet] - 不打印。
 * @returns {Promise<{ ok: boolean, code: number, out: string, lines: string[] }>} 结果；`code` 2 表示环境不足。
 */
export async function checkHostCompat({ root = MODULE_ROOT, hostRoot, hostVersion, leafLayout = 'host', pluginRoot, quiet = false } = {}) {
  const lines = [];
  const say = (line) => {
    lines.push(line);
    if (!quiet) console.log(line);
  };
  const done = (ok, code) => ({ ok, code, out: lines.join('\n'), lines });
  if (leafLayout !== 'host' && leafLayout !== 'profile') {
    say(`SKIP 未知的叶子依赖形态「${String(leafLayout)}」——只接受 host 或 profile`);
    return done(false, 2);
  }

  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const { range, members, problems, dshPeers } = readSupportSet(manifest);
  if (problems.length > 0) {
    for (const item of problems) say(`FAIL 包清单 ${item}`);
    return done(false, 1);
  }
  say(`OK   支持集合 ${members.join(' / ')}（九条 dsh peer 逐字符相同）`);

  if (hostRoot === undefined) {
    say('SKIP 宿主根未指定（--host-root）——官方准入判定与解析来源检查都只对给定安装树成立');
    return done(false, 2);
  }
  const normalized = normalizeHostRoot(hostRoot);
  if (normalized === undefined) {
    say(`SKIP 宿主根不可用（${hostRoot} 下没有 @deepseek-ai/dsh）——环境不足，不是判据失败`);
    return done(false, 2);
  }
  const { treeRoot, modules } = normalized;
  const modulesReal = realpathSync(modules);
  const isUnderHostTree = (real) => real === modulesReal || real.startsWith(`${modulesReal}${sep}`);

  /** 以某个安装位置为解析基准，返回“解析一次裸包名”的函数。 */
  const resolverFor = (base) => {
    const requireBase = createRequire(join(base, 'package.json'));
    return (name) => {
      const tryResolve = (specifier) => {
        try {
          return requireBase.resolve(specifier);
        } catch {
          return undefined;
        }
      };
      // 先走包清单（`@deepseek-ai/dsh` 只导出子路径、没有根入口），入口文件失败时退回包目录。
      let manifestPath = tryResolve(`${name}/package.json`);
      const entry = tryResolve(name);
      if (manifestPath === undefined && entry !== undefined) {
        let dir = dirname(entry);
        while (!existsSync(join(dir, 'package.json'))) {
          const parent = dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        if (existsSync(join(dir, 'package.json'))) manifestPath = join(dir, 'package.json');
      }
      if (manifestPath === undefined) return { error: '不可解析（无包清单且无根入口）' };
      const real = realpathSync(dirname(manifestPath));
      let version;
      try {
        version = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')).version;
      } catch (error) {
        return { error: `包清单不可读（${error instanceof Error ? error.message : String(error)}）` };
      }
      return { real, entry, version };
    };
  };
  const resolvePackage = resolverFor(treeRoot);

  let bad = 0;
  const fail = (line) => {
    bad += 1;
    say(`FAIL ${line}`);
  };

  // ── 官方准入判定 ──────────────────────────────────────────────────────────
  // 只取宿主树里的官方实现，不复制它的判定逻辑；宿主版本以显式传入值为准。
  const appBoot = resolvePackage('@deepseek-ai/dsh-app-boot');
  if (appBoot.error !== undefined || appBoot.entry === undefined) {
    fail(`宿主树里的 @deepseek-ai/dsh-app-boot ${appBoot.error ?? '没有可加载的入口'}——官方准入判定无从执行`);
    return done(false, 1);
  }
  if (!members.includes(appBoot.version)) {
    say(`NOTE 宿主树 @deepseek-ai/dsh-app-boot@${appBoot.version} 与支持集合不同代，仅用于判定口径`);
  }
  const { evaluatePluginCompatibility } = await import(pathToFileURL(appBoot.entry).href);

  for (const version of members) {
    const issue = evaluatePluginCompatibility(manifest, {}, version);
    if (issue === undefined) say(`OK   放行 dsh ${version}（官方判定无未满足要求）`);
    else fail(`放行 dsh ${version}：官方判定仍要求 ${JSON.stringify(issue.requirements)}`);
  }
  for (const [version, label] of REJECTED_BOUNDARIES) {
    if (members.includes(version)) {
      fail(`拒载反例 ${version}（${label}）不该出现在支持集合里`);
      continue;
    }
    const issue = evaluatePluginCompatibility(manifest, {}, version);
    if (issue === undefined) {
      fail(`拒载 dsh ${version}（${label}）：官方判定放行，集合外宿主因此可以装载本包`);
      continue;
    }
    const unmet = Object.keys(issue.requirements);
    const offPeer = unmet.filter((name) => !dshPeers.includes(name) || issue.requirements[name] !== range);
    if (offPeer.length > 0) fail(`拒载 dsh ${version}（${label}）：未满足项不是九条 dsh peer 原文（${offPeer.join('、')}）`);
    else if (Object.hasOwn(issue.requirements, 'engines.dsh')) fail(`拒载 dsh ${version}（${label}）：拒载来自 engines.dsh`);
    else if (issue.exempted) fail(`拒载 dsh ${version}（${label}）：判定带版本豁免，不能作为集合外拒载证据`);
    else if (unmet.length !== dshPeers.length) fail(`拒载 dsh ${version}（${label}）：未满足项 ${String(unmet.length)} 条，应覆盖九条 peer`);
    else say(`OK   拒载 dsh ${version}（${label}）：九条 dsh peer 未满足，无 engines.dsh、无豁免`);
  }

  // ── 实际解析来源 ──────────────────────────────────────────────────────────
  const dshPkg = resolvePackage('@deepseek-ai/dsh');
  if (dshPkg.error !== undefined) {
    fail(`宿主树里的 @deepseek-ai/dsh ${dshPkg.error}`);
    return done(false, 1);
  }
  const expectedVersion = hostVersion ?? dshPkg.version;
  if (hostVersion !== undefined && dshPkg.version !== hostVersion) {
    fail(`宿主树 dsh 版本 ${dshPkg.version} 与显式要求的 ${hostVersion} 不一致——这次作业装的不是目标宿主`);
  }
  if (!members.includes(expectedVersion)) {
    fail(`宿主版本 ${expectedVersion} 不在支持集合内：本次宿主不是受支持宿主，先核对作业安装的精确版本`);
    return done(false, 1);
  }
  say(`OK   宿主版本 ${expectedVersion}（${hostVersion === undefined ? '取自树内清单' : '显式指定'}），位于支持集合内`);

  /** 解析并核对一个包：必须落在宿主树顶层，版本满足给定判据。 */
  const checkResolved = (name, expected, kind) => {
    const found = resolvePackage(name);
    if (found.error !== undefined) {
      fail(`${kind} ${name} ${found.error}`);
      return;
    }
    const hoisted = realpathSync(join(modulesReal, ...name.split('/')));
    if (found.real !== hoisted) {
      fail(`${kind} ${name} 解析到 ${found.real}，不在宿主树顶层 ${hoisted}——混树或重复副本`);
      return;
    }
    const verdict = expected(found.version);
    if (verdict !== undefined) {
      fail(`${kind} ${name}@${found.version} ${verdict}`);
      return;
    }
    say(`OK   ${kind} ${name}@${found.version} 来自宿主树顶层`);
  };

  for (const name of dshPeers) {
    checkResolved(name, (version) => (version === expectedVersion ? undefined : `不是宿主版本 ${expectedVersion}`), 'dsh peer');
  }

  // 配套依赖分两类：peer 形态（cordis / timer）必须来自宿主树；`dependencies` 按形态判。
  const semver = createRequire(join(appBoot.real, 'package.json'))('semver');
  const inRange = (declared) => (version) => (semver.satisfies(version, declared, { includePrerelease: true })
    ? undefined
    : `不满足声明范围 ${declared}`);
  const peerLeaf = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => !dshPeerName(name));
  for (const [name, declared] of peerLeaf) {
    checkResolved(name, inRange(declared), '配套 peer');
  }

  // `dependencies`：host 形态按宿主树顶层判；profile 形态允许同版本地副本。
  const dependencies = Object.entries(manifest.dependencies ?? {});
  const resolveFromPlugin = leafLayout === 'profile' && pluginRoot !== undefined ? resolverFor(pluginRoot) : undefined;
  if (leafLayout === 'profile') {
    say(`NOTE 叶子依赖形态 profile${resolveFromPlugin === undefined ? '（未给 --plugin-root，仍按宿主树判）' : `，插件安装位置 ${pluginRoot}`}`);
  }
  for (const [name, declared] of dependencies) {
    const local = resolveFromPlugin?.(name);
    if (local === undefined || local.error !== undefined || isUnderHostTree(local.real)) {
      // 无法从插件位置解析、或插件位置解析回宿主树本身：仍按宿主树顶层判（最严的一档）。
      checkResolved(name, inRange(declared), '叶子依赖');
      continue;
    }
    // 插件安装位置的本地副本：路径不同不算失败，版本必须与宿主同名包相同并满足范围。
    const hostCopy = join(modulesReal, ...name.split('/'), 'package.json');
    let hostVersionOfLeaf;
    try {
      hostVersionOfLeaf = JSON.parse(readFileSync(hostCopy, 'utf8')).version;
    } catch {
      hostVersionOfLeaf = undefined;
    }
    if (hostVersionOfLeaf === undefined) {
      fail(`叶子依赖 ${name} 解析到插件安装位置 ${local.real}，但宿主树没有同名包 ${hostCopy}，无法证明同版`);
      continue;
    }
    if (local.version !== hostVersionOfLeaf) {
      fail(`叶子依赖 ${name}@${local.version}（插件安装位置）与宿主同名包 ${hostVersionOfLeaf} 不同版`);
      continue;
    }
    const verdict = inRange(declared)(local.version);
    if (verdict !== undefined) {
      fail(`叶子依赖 ${name}@${local.version} ${verdict}`);
      continue;
    }
    say(`OK   叶子依赖 ${name}@${local.version} 来自插件安装位置，与宿主同名包同版（按 profile 形态接受）`);
  }

  say('');
  say(bad === 0
    ? `兼容检查通过：支持集合 ${String(members.length)} 项放行、集合外 ${String(REJECTED_BOUNDARIES.length)} 项拒载、`
      + `${String(dshPeers.length)} 个 dsh peer 与 ${String(peerLeaf.length)} 项配套 peer 在宿主树 ${expectedVersion} 上同代同树、`
      + `${String(dependencies.length)} 项 dependencies 按 ${leafLayout} 形态核对。`
      + '（本检查只覆盖给定宿主树的解析；已安装插件在真实 runtime 实际取得的路径另由运行期观测核对。）'
    : `兼容检查不通过：${String(bad)} 项。`);
  return done(bad === 0, bad === 0 ? 0 : 1);
}

/** CLI 参数解析：只认四个显式输入，未知参数按用法错误退出。 */
function parseArgs(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const next = argv[index + 1];
    return next === undefined || next.startsWith('--') ? '' : next;
  };
  return {
    hostRoot: value('--host-root'),
    hostVersion: value('--host-version'),
    leafLayout: value('--leaf-layout'),
    pluginRoot: value('--plugin-root')
  };
}

// CLI 入口：只在直接执行时生效（测试以函数导入，不触发）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { hostRoot, hostVersion, leafLayout, pluginRoot } = parseArgs(process.argv.slice(2));
  const usage = '用法：node tools/check-host-compat.mjs --host-root <宿主安装树根或其 node_modules>'
    + ' [--host-version <精确宿主版本>] [--leaf-layout <host|profile>] [--plugin-root <插件安装目录>]';
  if (hostRoot === undefined || hostRoot === '' || hostVersion === '' || leafLayout === '' || pluginRoot === '') {
    console.error(usage);
    process.exit(2);
  }
  const result = await checkHostCompat({
    hostRoot,
    hostVersion: hostVersion === undefined ? undefined : hostVersion,
    leafLayout: leafLayout === undefined ? 'host' : leafLayout,
    pluginRoot: pluginRoot === undefined ? undefined : pluginRoot
  });
  process.exit(result.code);
}
