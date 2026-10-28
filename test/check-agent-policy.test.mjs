/**
 * `verify/check-agent-policy.mjs` 的宿主源解析与锚分析。
 *
 * ## 钉住什么
 *
 * 1. **显式来源优先**：`--host-file` > 环境变量 `DSAT_HOST_MODULES` > 本机配置；显式
 *    来源在场时**不装载本机配置**——干净公开副本里遗留的 `.local/` 祖先（测试建过就
 *    留下）不再把纯源检查器变成红。
 * 2. **本机配置的原有合同不放松**：`.local/` 在场而配置缺失仍抛 `LocalConfigInvalid`；
 *    整个 `.local/` 不在才是文档化跳过；在场却没有树来源是 `no-tree`（CLI 退出码 2）。
 * 3. **锚逐条执行**：8 个宿主锚与 12 个本包锚全绿；错误锚、缺树、行号漂移分别红。
 *
 * 夹具纪律：宿主源文本是**合成**的（判据只认锚的行形，不认宿主实现细节），本包侧读真
 * `lib/agent-policy.js`——钉的是现行实现，不另抄一份副本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  analyzeAgentPolicy,
  explicitHostSource,
  resolveHostSource
} from '../verify/check-agent-policy.mjs';
import { LocalConfigInvalid, LOCAL_DIR } from '../tools/_local-config.mjs';

const ROOT = resolve(import.meta.dirname, '..');

/** 本包侧被测源（现行实现，钉版看守的另一半）。 */
const OUR_TEXT = readFileSync(join(ROOT, 'lib', 'agent-policy.js'), 'utf8');

/**
 * 合成宿主源：只按 H1–H8 的行形拼（真实宿主文本不随公开仓分发，判据也只看行形）。
 * 行形示意在真宿主 `dsh-tool-subagent/lib/index.js` 的投影定义附近。
 */
const HOST_FIXTURE = [
  'import { z as z$1 } from "zod";',
  '',
  'const stateSchema = z$1.array(z$1.object({',
  '  provider: z$1.string(),',
  '  model: z$1.string()',
  '}).strict()).min(1).nullable();',
  '',
  'export const subagentModelSelectionProjectionDefinition = {',
  '  key: "subagentModelSelectionPolicy",',
  '  stateVersion: 1,',
  '  stateSchema,',
  '  init: () => null,',
  '  apply(policy, event) {',
  '    if (policy !== null || event.type !== "subagent/model-selection-policy") return policy;',
  '    const { allowedModels } = event.data;',
  '    assertAllowedModelRoutes(allowedModels);',
  "    if (allowedModels.length === 0) throw new Error('subagent/model-selection-policy requires at least one route');",
  '    return allowedModels;',
  '  }',
  '};',
  ''
].join('\n');

/**
 * 铺一棵合成仓根（`.local/` 与 `config.mjs` 的解析基准）。
 * @param {Record<string, string>} [files] - 相对路径 → 文本。
 * @returns {{root: string, cleanup: () => void}}
 */
function sandbox(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'policy-src-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('explicitHostSource：--host-file 优先，环境源次之，空值等于没有来源', () => {
  assert.deepEqual(
    explicitHostSource({ hostFile: 'host/subagent/index.js', env: { DSAT_HOST_MODULES: 'synthetic-modules' } }),
    { hostPath: 'host/subagent/index.js', source: 'host-file' },
    '--host-file 是最高优先的显式来源'
  );
  assert.deepEqual(
    explicitHostSource({ env: { DSAT_HOST_MODULES: 'synthetic-modules' } }),
    {
      hostPath: join('synthetic-modules', '@deepseek-ai', 'dsh-tool-subagent', 'lib', 'index.js'),
      source: 'env'
    },
    '环境源按 0.2.1 树的结构性缺省拼出宿主源路径'
  );
  assert.equal(explicitHostSource({ env: {} }), undefined, '没有显式来源');
  assert.equal(
    explicitHostSource({ hostFile: '', env: { DSAT_HOST_MODULES: '' } }),
    undefined,
    '空字符串不是来源（与配置加载器的非空口径一致）'
  );
});

test('resolveHostSource：显式来源不读本机配置——遗留的本机目录祖先不再把检查器变成红', async (t) => {
  // 模拟"测试跑过、本机目录里 tmp 祖先还在、但从来没有 config.mjs"的公开副本。
  const box = sandbox({ [join(LOCAL_DIR, 'tmp', 'f04-chain-x', 'keep.txt')]: 'x\n' });
  t.after(box.cleanup);
  assert.deepEqual(
    await resolveHostSource({ hostFile: 'host/subagent/index.js', env: {}, root: box.root }),
    { status: 'host', hostPath: 'host/subagent/index.js', source: 'host-file' },
    '显式来源在场时本机配置不参与判定'
  );
  // 反向：同一棵树，没有显式来源就是配置缺失（红，不是跳过）。
  await assert.rejects(
    resolveHostSource({ env: {}, root: box.root }),
    LocalConfigInvalid,
    '本机目录在场而配置不在，仍按开发机配置错误处理'
  );
});

test('resolveHostSource：本机环境缺席是文档化跳过，配置在场但无树是醒目的 no-tree', async (t) => {
  const absent = sandbox();
  const empty = sandbox({ [join(LOCAL_DIR, 'config.mjs')]: 'export default {};\n' });
  const wired = sandbox({ [join(LOCAL_DIR, 'config.mjs')]: 'export default { hostModules: "synthetic-modules" };\n' });
  t.after(() => {
    absent.cleanup();
    empty.cleanup();
    wired.cleanup();
  });

  const skipped = await resolveHostSource({ env: {}, root: absent.root });
  assert.equal(skipped.status, 'absent', '整个本机目录不在 = 跳过（不是失败）');
  assert.match(skipped.reason, /不存在/);

  const noTree = await resolveHostSource({ env: {}, root: empty.root });
  assert.equal(noTree.status, 'no-tree', '配置在场却没有树来源，不许静默跳过');
  assert.match(noTree.reason, /DSAT_HOST_MODULES/);

  assert.deepEqual(
    await resolveHostSource({ env: {}, root: wired.root }),
    {
      status: 'host',
      hostPath: join('synthetic-modules', '@deepseek-ai', 'dsh-tool-subagent', 'lib', 'index.js'),
      source: 'local'
    },
    '没有显式来源时仍从本机配置的 evidenceTree[\'021\'] 取树'
  );
});

test('锚分析：8 个宿主锚与 12 个本包锚逐条执行并全绿', () => {
  const { report, failures } = analyzeAgentPolicy({ hostText: HOST_FIXTURE, ourText: OUR_TEXT });
  assert.equal(failures, 0, report.join('\n'));
  assert.equal(
    report.filter((line) => /^H\d+ OK/.test(line)).length,
    8,
    '宿主侧 8 个锚必须逐条给出结论，不能只报一句总的'
  );
  assert.equal(
    report.filter((line) => /^O\d+ OK/.test(line)).length,
    12,
    '本包侧 12 个锚必须逐条给出结论'
  );
});

test('锚分析：错误锚、缺树与行号漂移都是红——不能回退成绿', () => {
  const badVersion = analyzeAgentPolicy({
    hostText: HOST_FIXTURE.replace('stateVersion: 1,', 'stateVersion: 2,'),
    ourText: OUR_TEXT
  });
  assert.equal(badVersion.failures, 1);
  assert.match(badVersion.report.join('\n'), /H2 MISSING/);

  const noHost = analyzeAgentPolicy({ hostText: null, ourText: OUR_TEXT });
  assert.equal(noHost.failures, 1);
  assert.match(noHost.report.join('\n'), /HOST MISSING/, '读不到宿主源即红，不许静默跳过');

  // 钉行号的锚：行形改坏即红（"文件里出现过一次"不算过）。
  const movedReturn = analyzeAgentPolicy({
    hostText: HOST_FIXTURE,
    ourText: OUR_TEXT.replace('    return allowedModels;', '    return allowedModels.slice();')
  });
  assert.equal(movedReturn.failures, 1);
  assert.match(movedReturn.report.join('\n'), /O13 MISSING/);
});
