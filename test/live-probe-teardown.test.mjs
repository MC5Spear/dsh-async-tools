/**
 * probe-live-acceptance 收尾分支进程内复验（`--keep` 修复的针对性测试）：
 * 探针脚本的收尾序列已提取为依赖注入的 `finalTeardown`——本测试用源码切片
 * ＋vm 执行该函数的真实分支（不 import 探针文件、不起实例、不建真实临时
 * home、不触碰他人目录），验证：
 * - keep=true：不删临时 home，停实例、证据落盘、打包产物清理照常；
 * - keep=false：按原职责清理临时 home；
 * - 顺序：停实例→等释放→证据落盘→home 去留→产物清理；
 * - 失败状态保留：含 FAIL 判定的证据完整落盘；rmHome 失败只告警不中断。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_PATH = join(ROOT, 'verify', 'probe-live-acceptance.mjs');

/** 从探针源码截取 `async function finalTeardown(...){...}`（花括号配平），
 *  在空 vm 上下文里作为函数表达式求值——不执行探针脚本的任何顶层语句。 */
function loadFinalTeardown() {
  const source = readFileSync(PROBE_PATH, 'utf8');
  const marker = 'async function finalTeardown(';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'probe-live-acceptance.mjs 应包含 finalTeardown（收尾序列保持为可注入函数）');
  // 先配平参数列表括号（解构参数自带花括号，不能从首个 `{` 起算），再从函数体首 `{` 配平。
  const parenStart = source.indexOf('(', start);
  let parenDepth = 0;
  let bodyStart = -1;
  for (let i = parenStart; i < source.length; i += 1) {
    if (source[i] === '(') parenDepth += 1;
    else if (source[i] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) { bodyStart = source.indexOf('{', i); break; }
    }
  }
  assert.notEqual(bodyStart, -1, 'finalTeardown 应有函数体');
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.notEqual(end, -1, 'finalTeardown 函数体应能完整截取');
  const fn = vm.runInNewContext(`(${source.slice(start, end)})`, {}, { timeout: 5000 });
  assert.equal(typeof fn, 'function');
  return { fn, source };
}

/** 全替身依赖：记录调用序列；home／tgz／证据路径都是不存在的虚构路径，无文件系统副作用。 */
function makeDeps({ keep, rmHomeThrows = false }) {
  const home = String(join('C:', 'tmp', 'dsh-live-acc-TESTONLY'));
  const tgz = String(join(ROOT, '.local', 'dsh-async-tools-TESTONLY.tgz'));
  const evidence = {
    head: 'deadbeef', dirty: true, hostVersion: '0.2.1-rc.5', sessionId: 's-test',
    steps: [], verdicts: [{ name: 'LA-1 前台命令正文到达', ok: true }, { name: 'LA-2 后台作业经等待领取正文', ok: false }]
  };
  const calls = [];
  let evidenceText = null;
  const deps = {
    keep, home, tgzPath: tgz, evidence,
    evidencePath: String(join(ROOT, '.local', 'probe-live-acceptance-TESTONLY.json')),
    evidenceLabel: join('.local', 'probe-live-acceptance-TESTONLY.json'),
    stopInstance: () => { calls.push('stop'); },
    waitReleased: () => new Promise((r) => { calls.push('wait'); r(); }),
    rmHome: (p) => { calls.push(`rmHome ${p}`); if (rmHomeThrows) throw new Error('EBUSY（测试注入）'); },
    rmArtifact: (p) => { calls.push(`rmArtifact ${p}`); },
    writeEvidence: (p, text) => { calls.push(`writeEvidence ${p}`); evidenceText = text; },
    log: () => {},
    warn: (m) => { calls.push(`warn ${m}`); }
  };
  return { deps, calls, evidenceText: () => evidenceText, home, tgz };
}

test('keep=false：清理临时 home，完整顺序＝停实例→等释放→证据落盘→删 home→清产物', async () => {
  const { fn } = loadFinalTeardown();
  const { deps, calls, evidenceText, home, tgz } = makeDeps({ keep: false });
  await fn(deps);
  assert.deepEqual(calls, [
    'stop', 'wait', `writeEvidence ${deps.evidencePath}`, `rmHome ${home}`, `rmArtifact ${tgz}`
  ]);
  const parsed = JSON.parse(evidenceText());
  assert.deepEqual(parsed, deps.evidence, '证据应原样序列化落盘');
  assert.equal(parsed.verdicts.some((v) => v.ok === false), true, 'FAIL 判定应保留在落盘证据中');
});

test('keep=true：不删临时 home；停实例、证据落盘、产物清理照常且顺序不变', async () => {
  const { fn } = loadFinalTeardown();
  const { deps, calls, evidenceText, tgz } = makeDeps({ keep: true });
  await fn(deps);
  assert.equal(calls.some((c) => c.startsWith('rmHome')), false, 'keep=true 不得删除临时 home');
  assert.equal(calls.some((c) => c.startsWith('warn')), false);
  assert.deepEqual(calls, ['stop', 'wait', `writeEvidence ${deps.evidencePath}`, `rmArtifact ${tgz}`]);
  assert.equal(typeof evidenceText(), 'string', 'keep=true 下证据仍落盘');
});

test('rmHome 失败（keep=false）：只告警留现场，不中断——证据已先行落盘、产物仍清理', async () => {
  const { fn } = loadFinalTeardown();
  const { deps, calls, evidenceText, tgz } = makeDeps({ keep: false, rmHomeThrows: true });
  await assert.doesNotReject(fn(deps));
  assert.equal(calls.indexOf('warn [probe] WARN: 临时目录清理失败，留存现场：' + deps.home) >= 0, true);
  assert.ok(calls.indexOf('writeEvidence ' + deps.evidencePath) < calls.findIndex((c) => c.startsWith('warn')), '证据落盘应先于清理告警');
  assert.ok(calls.includes(`rmArtifact ${tgz}`), '产物清理不受 home 清理失败影响');
  assert.equal(typeof evidenceText(), 'string');
});

test('收尾调用点与结构 sanity：脚本把 keep 传入 finalTeardown，且不再对 home 无条件 rmSync', () => {
  const { source } = loadFinalTeardown();
  assert.match(source, /await finalTeardown\(\{\s*\n\s*keep, home, tgzPath, evidence,/, '收尾调用应以真实 keep 值驱动 finalTeardown');
  assert.doesNotMatch(source, /rmSync\(home/, 'home 的删除必须经 rmHome 注入（由 keep 决定），不得无条件 rmSync(home)');
});
