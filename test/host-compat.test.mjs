/**
 * 兼容声明检查器的进程内断言（设计 7.3、8.2“版本与客户端”）。
 *
 * 本文件只做两件事：
 *
 * 1. **真实宿主树基线**：经宿主锚（`DSAT_HOST_MODULES` / `DSH_HOME/profiles` / npm 全局树，
 *    唯一来源为 `tools/_host-resolve.mjs`）找到一棵宿主树，跑 `checkHostCompat`——官方
 *   准入判定、集合外拒载、九个 dsh peer 同树同 rc、四项叶子依赖同树都须通过。
 *    锚缺席时按 `_host-gate.mjs` 的统一理由跳过，不整片崩。
 * 2. **清单与版本反例**：用合成清单与显式假版本证明判据会红——九条 peer 不一致、
 *    声明 `engines.dsh`、少了 peer、宿主树版本与显式要求不符、版本不在集合内、
 *    宿主根缺席各自对应一条能失败的输入。反例在内存里构造，不写磁盘。
 *
 * 离线形态不导入宿主链：本文件的静态导入只有本仓工具与 `node:` 内建，宿主模块由
 * `checkHostCompat` 在运行时按显式宿主根动态加载。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateModules } from '../tools/_host-resolve.mjs';
import { checkHostCompat, readSupportSet } from '../tools/check-host-compat.mjs';
import { hostTestByProbe } from './_host-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const support = readSupportSet(manifest);

/** 宿主树根：宿主锚的 `node_modules` 上一级；锚缺席时为 `undefined`。 */
const hostModules = candidateModules(process.env.DSH_HOME ?? join(homedir(), '.dsh'))[0];
const hostRoot = hostModules === undefined ? undefined : dirname(hostModules);
const hostTest = await hostTestByProbe(hostRoot === undefined);

test('支持集合：九条 dsh peer 同串，集合外宿主不在集合内', () => {
  assert.deepEqual(support.problems, []);
  assert.equal(support.dshPeers.length, 9);
  assert.ok(support.members.length > 0);
  for (const member of support.members) assert.match(member, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  for (const outside of ['0.2.1', '0.2.0', '0.2.2', '0.2.1-rc.6']) assert.ok(!support.members.includes(outside));
  assert.equal(manifest.engines?.dsh, undefined, '包清单不得声明 engines.dsh——它会顶替九条 peer 裁决');
});

test('清单反例：单条 peer 不同串、声明 engines.dsh、peer 条数不足、范围写法、重复成员都要报问题', () => {
  const mutate = (fn) => {
    const copy = structuredClone(manifest);
    fn(copy);
    return readSupportSet(copy).problems;
  };
  /** 九条 dsh peer 全部改成同一串（绕过“逐字符相同”这关，专测串本身的判据）。 */
  const setAll = (copy, range) => {
    for (const name of Object.keys(copy.peerDependencies)) {
      if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) copy.peerDependencies[name] = range;
    }
  };
  assert.notDeepEqual(mutate((copy) => { copy.peerDependencies['@deepseek-ai/dsh-tools'] = '0.2.1-rc.4'; }), []);
  assert.notDeepEqual(mutate((copy) => { copy.engines = { ...copy.engines, dsh: '0.2.1-rc.4' }; }), []);
  assert.notDeepEqual(mutate((copy) => { delete copy.peerDependencies['@deepseek-ai/dsh-shell-env']; }), []);
  // 范围写法不是精确项：`*` 会让集合外版本也被放行。
  assert.notDeepEqual(mutate((copy) => { setAll(copy, '0.2.1-rc.2 || *'); }), []);
  assert.notDeepEqual(mutate((copy) => { setAll(copy, '^0.2.1-rc.2'); }), []);
  // 同一版本重复列不等于支持集合。
  assert.notDeepEqual(mutate((copy) => { setAll(copy, '0.2.1-rc.2 || 0.2.1-rc.2'); }), []);
  assert.deepEqual(mutate(() => {}), []);
});

hostTest('真实宿主树：官方准入、集合外拒载、九个 peer 同树同 rc、叶子依赖同树', async () => {
  const result = await checkHostCompat({ root: ROOT, hostRoot, quiet: true });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /兼容检查通过/);
});

hostTest('宿主树版本与显式要求不符即失败（防止作业装了另一棵树的宿主）', async () => {
  const other = support.members.find((version) => version !== manifestVersionOfTree());
  assert.ok(other !== undefined, '集合内至少还有一个不同版本可供反例');
  const result = await checkHostCompat({ root: ROOT, hostRoot, hostVersion: other, quiet: true });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /不一致/);
});

hostTest('集合外宿主版本按失败处理，不进入解析来源段', async () => {
  const result = await checkHostCompat({ root: ROOT, hostRoot, hostVersion: '0.2.1', quiet: true });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /不在支持集合内/);
});

hostTest('profile 形态：插件安装位置的同版本地副本可接受，版本不同才失败', async (t) => {
  const tree = JSON.parse(readFileSync(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
  const versionOf = (name) => JSON.parse(readFileSync(join(hostRoot, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version;
  const local = mkdtempSync(join(tmpdir(), 'host-compat-'));
  t.after(() => rmSync(local, { recursive: true, force: true }));
  const writeStub = (name, version) => {
    const dir = join(local, 'node_modules', ...name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), 'export default {};\n');
  };
  // 宿主 CLI 把 dependencies 装到 profile 本地时，物理路径不同但版本与宿主同名包相同。
  writeStub('@deepseek-ai/schemastery', versionOf('@deepseek-ai/schemastery'));
  writeStub('zod', versionOf('zod'));
  const accepted = await checkHostCompat({ root: ROOT, hostRoot, leafLayout: 'profile', pluginRoot: local, quiet: true });
  assert.equal(accepted.code, 0, accepted.out);
  assert.match(accepted.out, /来自插件安装位置/);
  assert.ok(tree.version !== undefined);

  writeStub('zod', '0.0.1');
  const rejected = await checkHostCompat({ root: ROOT, hostRoot, leafLayout: 'profile', pluginRoot: local, quiet: true });
  assert.equal(rejected.code, 1, rejected.out);
  assert.match(rejected.out, /不同版/);
});

hostTest('宿主 dsh-tools 名册视图契约：view(scope) 返回 visible 名册（Map 名→定义）', () => {
  // 设计 §3.5.1 生效边界的常设依据：job_output 隐藏按 Agent 作用域名册判定，
  // 依赖宿主 ToolRuntime 的 view(scope).visible（名→定义的 Map，has() 可查）。
  // 支持集合各树已实证提供；本锚在宿主锚树源文上静态复验三处形态，宿主改版
  // 即红（与 agent-policy 逐行互锚同款守卫风格）。
  const source = readFileSync(
    join(hostModules, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'), 'utf8'
  );
  assert.match(source, /view\(scope\)\s*\{/, 'ToolRuntime 提供 view(scope) 作用域名册视图方法');
  assert.match(source, /view\(scope\)\.visible\.get\(/, '调用方经 view(scope).visible 按名取定义（名册形态互证）');
  assert.match(source, /visible\.set\(name, definition\)/, 'visible 名册按名→定义收集（Map 构造与填充形态）');
});

test('宿主根缺席或不可用时按环境不足退出（退出码 2），不算判据失败', async () => {
  const absent = await checkHostCompat({ root: ROOT, hostRoot: join(ROOT, 'no-such-host'), quiet: true });
  assert.equal(absent.code, 2, absent.out);
  const missing = await checkHostCompat({ root: ROOT, quiet: true });
  assert.equal(missing.code, 2, missing.out);
});

/** 读宿主树里 `@deepseek-ai/dsh` 的版本；树不可读时返回 `undefined`。 */
function manifestVersionOfTree() {
  if (hostRoot === undefined) return undefined;
  try {
    return JSON.parse(readFileSync(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}
