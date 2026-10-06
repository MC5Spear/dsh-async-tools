/**
 * `verify/check-agent-policy.mjs` 的变异证明（§38.4；r22 判据：新判据必须自带
 * 「改坏必红」的用例）。进程内 import 纯函数（不起子进程——r22 沙箱教训在案）。
 *
 * 11 处变异分打宿主锚与本包锚：改常量 / 换库 / 删校验 / 改短路 / 宿主侧漂移
 * （stateVersion、init）——任何一处没红就报 UNCAUGHT 并退出 1；BASELINE-GREEN
 * 先证明未变异时恰绿。
 *
 * 用法：node verify/mutate-agent-policy.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeAgentPolicy } from './check-agent-policy.mjs';
import { loadLocalPlaneOrSkip } from '../tools/_local-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// 宿主源位置：树根经配置加载器读，不写死。变异看守打的是宿主源文本，
// 所以它必须在场——缺席按红处理（与 check-agent-policy 同一口径）。
const config = await loadLocalPlaneOrSkip('verify/mutate-agent-policy.mjs（钉版看守的变异证明）');
const tree020 = config.evidenceTree['020'];
if (tree020 === undefined) {
  console.error('宿主锚无来源：配置里既没有 evidenceTree[\'020\']，也没有 hostModules。'
    + '变异证明要先能读到宿主源才谈得上。');
  process.exit(2);
}
const HOST_PATH = join(tree020, 'dsh-tool-subagent', 'lib', 'index.js');
const OUR_PATH = join(ROOT, 'lib', 'agent-policy.js');

const readOr = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};
const hostOriginal = readOr(HOST_PATH);
const ourOriginal = readOr(OUR_PATH);
if (hostOriginal === null || ourOriginal === null) {
  console.error('BASELINE-RED：宿主源或本包源读不到——先让 check-agent-policy 绿再谈变异');
  process.exit(1);
}

// BASELINE-GREEN：未变异必须恰绿（防恒真）。
const baseline = analyzeAgentPolicy({ hostText: hostOriginal, ourText: ourOriginal });
console.log(baseline.failures === 0
  ? 'BASELINE-GREEN 未变异恰绿（0 红）'
  : `BASELINE-RED 未变异就有 ${String(baseline.failures)} 红——变异证明无效`);
if (baseline.failures !== 0) process.exit(1);

/** 变异表：side = 宿主/本包；expect = 命中报告行的正则。 */
const MUTATIONS = [
  {
    name: 'M1 本包键常量改值 → O1 必红',
    side: 'our',
    expect: /^O1 MISSING/m,
    mutate: (t) => t.replace("export const POLICY_KEY = 'subagentModelSelectionPolicy';",
      "export const POLICY_KEY = 'otherPolicyKey';")
  },
  {
    name: 'M2 本包 stateVersion 1→2 → O2 必红',
    side: 'our',
    expect: /^O2 MISSING/m,
    mutate: (t) => t.replace('export const POLICY_STATE_VERSION = 1;',
      'export const POLICY_STATE_VERSION = 2;')
  },
  {
    name: 'M3 本包 zod 换 schemastery → O3 必红（D1）',
    side: 'our',
    expect: /^O3 MISSING/m,
    mutate: (t) => t.replace("import { z } from 'zod';",
      "import z from '@deepseek-ai/schemastery';")
  },
  {
    name: 'M4 本包 schema 形状串删 .min(1).nullable() → O4 必红',
    side: 'our',
    expect: /^O4 MISSING/m,
    mutate: (t) => t.replace('.strict()).min(1).nullable()', '.strict())')
  },
  {
    name: 'M5 本包 fold 短路 null→undefined → O6 必红',
    side: 'our',
    expect: /^O6 MISSING/m,
    mutate: (t) => t.replace('if (policy !== null || event.type !== POLICY_EVENT) return policy;',
      'if (policy !== undefined || event.type !== POLICY_EVENT) return policy;')
  },
  {
    name: 'M6 本包删 fold 内校验调用 → O7 必红',
    side: 'our',
    expect: /^O7 MISSING/m,
    mutate: (t) => t.replace('assertRoutes(allowedModels);', '/* assertRoutes(allowedModels); */')
  },
  {
    name: 'M7 本包删空名单 throw → O8 必红（D8 的看守面）',
    side: 'our',
    expect: /^O8 MISSING/m,
    mutate: (t) => t.replace(/if \(allowedModels\.length === 0\) throw new Error\(`\$\{POLICY_EVENT\} requires at least one route`\);/, '')
  },
  {
    name: 'M8 宿主 stateVersion 1→2（升版漂移模拟）→ H2 必红',
    side: 'host',
    expect: /^H2 MISSING/m,
    mutate: (t) => t.replace('stateVersion: 1,', 'stateVersion: 2,')
  },
  {
    name: 'M9 宿主 init 换形（折叠语义漂移模拟）→ H5 必红',
    side: 'host',
    expect: /^H5 MISSING/m,
    mutate: (t) => t.replace('init: () => null,', 'init: () => [],')
  },
  {
    name: 'M10 本包事件类型串改值 → O12 必红（r41-N1：标识符锚不住串值）',
    side: 'our',
    expect: /^O12 MISSING/m,
    mutate: (t) => t.replace("export const POLICY_EVENT = 'subagent/model-selection-policy';",
      "export const POLICY_EVENT = 'other/event-type';")
  },
  {
    name: 'M11 本包 zod import 注释化 → O3 必红（r41-N3：行锚不吃注释文本）',
    side: 'our',
    expect: /^O3 MISSING/m,
    mutate: (t) => t.replace("import { z } from 'zod';", "// import { z } from 'zod';")
  }
];

let uncaught = 0;
for (const mutation of MUTATIONS) {
  const original = mutation.side === 'host' ? hostOriginal : ourOriginal;
  const mutated = mutation.mutate(original);
  const changed = mutated !== original;
  const result = analyzeAgentPolicy({
    hostText: mutation.side === 'host' ? mutated : hostOriginal,
    ourText: mutation.side === 'our' ? mutated : ourOriginal
  });
  const hit = mutation.expect.test(result.report.join('\n'));
  const ok = changed && result.failures > 0 && hit;
  if (!ok) uncaught += 1;
  console.log(`${ok ? 'CAUGHT  ' : 'UNCAUGHT'} ${mutation.name}`);
  console.log(`          变异生效=${String(changed)} 红数=${String(result.failures)} 命中期望=${String(hit)}`);
  if (!ok) {
    console.log(`          实际报告：${result.report.filter((l) => l.includes('MISSING')).slice(0, 3).join(' | ') || '（无红）'}`);
  }
}

console.log(uncaught === 0
  ? `全部 ${String(MUTATIONS.length)} 处变异被抓住（本包锚腿 + 宿主漂移腿 + 值锚/注释化腿）`
  : `${String(uncaught)} 处未抓住——看守存在恒真面`);
process.exitCode = uncaught === 0 ? 0 : 1;
