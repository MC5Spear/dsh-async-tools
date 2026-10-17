/**
 * 离线守卫看守：`test/*.test.mjs` 的**顶层静态**依赖不得触达宿主链（静态判据）。
 *
 * ## 为什么需要它（ci.yml offline 作业的防线在本地就能抓到）
 *
 * 离线契约要求宿主链模块一律经 `_host-gate.mjs` 动态守卫加载；但「新写的测试
 * 文件忘了守卫、直接顶层 `import` 宿主链模块」这类漏网，离线形态要等 CI 的
 * offline 作业才炸成整片 `ERR_MODULE_NOT_FOUND`。本看守在**源码层**静态对账，
 * 两种形态（离线/在线）本地跑测试即红——把漏网提前到提交前。
 *
 * ## 三条判据
 *
 * - **A（peer 静态依赖）**：测试文件顶层静态 import 裸说明符 ∈
 *   `package.json` 的 peerDependencies——离线形态的必崩点；
 * - **B（幽灵依赖）**：测试静态闭包内任何文件 import 不在
 *   dependencies ∪ peerDependencies 的裸包——声明范围外的包不可靠；
 * - **C（宿主链触达）**：测试文件顶层静态 import 的相对说明符闭包（递归到
 *   `lib/`、`tools/`、`verify/` 的仓库内文件）里出现「顶层静态 import peer 的
 *   文件」（宿主链模块）——经相对路径静态触达同样离线崩。
 *
 * `lib/` 产品代码静态 import peer 是合法的（判据 A 只看测试文件）；动态
 * `import( )` 是守卫的合法通道，不在提取范围。
 *
 * 名单不硬编码：peer 与已声明包动态读 `package.json`——换 peer 时代理不需要
 * 改这里（漏改会让看守红，而不是静默漂移）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../tools/check-public-surface.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = join(ROOT, 'test');

/** 单一来源：peer 名单与已声明裸包名单都读 `package.json`。 */
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const PEERS = new Set(Object.keys(pkg.peerDependencies ?? {}));
const DECLARED = new Set([...Object.keys(pkg.dependencies ?? {}), ...PEERS]);

/**
 * 提取顶层静态 import/export-from/副作用 import 的说明符。
 * 三个正则都锚定语句头（`import`/`export` 前只有空白），跨多行匹配到 `from`；
 * 中间段排除引号与分号，防止惰性匹配跨过语句边界。动态 `import( )` 带括号，
 * 三个正则都不命中。
 * @param {string} code - 去注释后的源码。
 * @returns {string[]} 说明符列表（含裸包与相对路径）。
 */
function staticSpecifiers(code) {
  const patterns = [
    /^[ \t]*import[ \t\n][^;'"]*?from[ \t]*['"]([^'"]+)['"]/gm,
    /^[ \t]*export[ \t\n][^;'"]*?from[ \t]*['"]([^'"]+)['"]/gm,
    /^[ \t]*import[ \t\n]*['"]([^'"]+)['"]/gm
  ];
  const specifiers = [];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/** 读取并去注释（注释里的 import 示例不算依赖）。 */
function bareCode(file) {
  return stripComments(readFileSync(file, 'utf8'));
}

/**
 * 相对说明符解析到仓库内文件；本仓 import 都带显式 `.js`/`.mjs` 后缀，
 * 落在仓库外或不存在的目标不进闭包。仓库内判定带分隔符边界：同级前缀目录
 * （如 `<ROOT>-other`）不属于仓库。
 */
function resolveRelative(fromFile, specifier) {
  const target = normalize(join(dirname(fromFile), specifier));
  const inside = target === ROOT || target.startsWith(ROOT + sep);
  return inside && existsSync(target) ? target : undefined;
}

/**
 * 从入口文件出发的静态相对 import 闭包（广度优先，仓库内文件）。
 * @param {string} entryFile - 起点文件（测试文件）。
 * @returns {string[]} 闭包文件列表（含起点；宿主链模块也含在内，由调用方判定）。
 */
function staticClosure(entryFile) {
  const queue = [entryFile];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const file = queue.shift();
    for (const specifier of staticSpecifiers(bareCode(file))) {
      if (!specifier.startsWith('.')) continue;
      const target = resolveRelative(file, specifier);
      if (target !== undefined && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...seen];
}

/** 该文件是否宿主链模块：顶层静态 import 了 peer 裸包。 */
function isHostChainModule(file) {
  return staticSpecifiers(bareCode(file)).some((specifier) => PEERS.has(specifier));
}

/** 全部测试文件（含本看守——自扫是守卫的一部分）。 */
function testFiles() {
  return readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => join(TEST_DIR, name));
}

test('离线守卫看守①：测试文件不得静态依赖 peer 或未声明裸包（判据 A/B）', () => {
  const violations = [];
  for (const entry of testFiles()) {
    const relative = (file) => file.slice(ROOT.length + 1).replace(/\\/g, '/');
    for (const specifier of staticSpecifiers(bareCode(entry))) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      if (PEERS.has(specifier)) {
        violations.push(`${relative(entry)} 顶层静态 import peer「${specifier}」——离线形态必崩；改经 _host-gate.mjs 动态守卫`);
      } else if (!DECLARED.has(specifier)) {
        violations.push(`${relative(entry)} import 未声明裸包「${specifier}」——不在 package.json 的 dependencies ∪ peerDependencies`);
      }
    }
    // 闭包内（lib/tools/verify 的仓库文件）的幽灵依赖同查——判据 B 的范围。
    for (const file of staticClosure(entry)) {
      if (file === entry) continue;
      for (const specifier of staticSpecifiers(bareCode(file))) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        if (!DECLARED.has(specifier)) {
          violations.push(`${relative(file)} import 未声明裸包「${specifier}」（经 ${relative(entry)} 静态闭包触达）`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], `离线守卫违规 ${violations.length} 条：\n${violations.join('\n')}`);
});

test('离线守卫看守②：测试文件的静态相对闭包不得触达宿主链模块（判据 C）', () => {
  const violations = [];
  for (const entry of testFiles()) {
    const relative = (file) => file.slice(ROOT.length + 1).replace(/\\/g, '/');
    for (const file of staticClosure(entry)) {
      if (file === entry) continue;
      if (isHostChainModule(file)) {
        violations.push(
          `${relative(entry)} 经顶层静态 import 触达宿主链模块 ${relative(file)}——离线形态整片 ERR_MODULE_NOT_FOUND；改经 _host-gate.mjs 动态守卫`
        );
        break;
      }
    }
  }
  assert.deepEqual(violations, [], `离线守卫违规 ${violations.length} 条：\n${violations.join('\n')}`);
});
