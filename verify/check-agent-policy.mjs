/**
 * 钉版看守（设计 §3.3 整段互锚）：本包 `lib/agent-policy.js` 的
 * 投影定义/采样链副本与宿主 `dsh-tool-subagent` 的现行源**整段互锚**。
 *
 * ## 为什么要有它
 *
 * B 路线的代价是宿主内部耦合（fold 形状、`stateVersion`、事件串、zod schema——
 * 同键合并先到先得 def，错形会污染全实例该键）。宿主升级改 fold/schema 而不动
 * key/版本时，装载不会炸——本检查器让它在**静态期先红**。
 *
 * ## 判据（缺一即红；缺树即红——显式红，与 preset.test 的对账口径一致）
 *
 * 宿主侧（H1–H9）：投影定义 key/stateVersion/zod import/schema 串/init 短路/
 * assert 调用/空名单 throw/采样链四锚。本包侧（O1–O11）：与宿主逐条对应的常量与
 * 实现行。纯函数 `analyzeAgentPolicy` 供变异看守（`verify/mutate-agent-policy.mjs`）
 * 进程内复用（默认沙箱下不起子进程）。
 *
 * 用法：node verify/check-agent-policy.mjs [--host-file <tool-subagent index.js>]
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCAL_DIR, loadLocalPlaneOrSkip } from '../tools/_local-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * 宿主源在 0.2.1 线树里的相对位置。
 *
 * 树根**不在这里**——它经 `tools/_local-config.mjs` 从本机侧读（或环境变量
 * `DSAT_HOST_MODULES`）。写死树根会让仓内多处各写一份，漏改一处不会有任何检查器红。
 */
const HOST_REL = ['dsh-tool-subagent', 'lib', 'index.js'];

/** 宿主侧锚（dsh-tool-subagent/lib/index.js 现行行形；调用形一律行锚）。 */
const HOST_ANCHORS = [
  ['H1', /key:\s*"subagentModelSelectionPolicy"/, '投影键字面量'],
  ['H2', /stateVersion:\s*1,/, 'stateVersion=1（升版而我们未跟 ⇒ 红）'],
  ['H3', /import \{ z as z\$1 \} from "zod";/, 'stateSchema 用 zod（契约是 .parse）'],
  ['H4', /\.strict\(\)\)\.min\(1\)\.nullable\(\)/, 'schema 形状串'],
  ['H5', /^\s*init: \(\) => null,/m, 'init null'],
  ['H6', /^\s*if \(policy !== null \|\| event\.type !== "subagent\/model-selection-policy"\) return policy;/m, 'fold 短路（先到先记）'],
  ['H7', /^\s*assertAllowedModelRoutes\(allowedModels\);/m, 'fold 内校验调用'],
  ['H8', /length === 0[\s\S]{0,200}requires at least one route/, '空名单 throw'],
  ['H9a', /firstLiveSeq === 0/, '采样链：fresh 判定'],
  ['H9b', /session\/end-seed/, '采样链：恢复会话排除'],
  ['H9c', /parentSession/, '采样链：父继承'],
  ['H9d', /settings\.current\(\)/, '采样链：全局白名单读取']
];

/** 本包侧锚（lib/agent-policy.js，与宿主逐条对应；**一律行锚**——注释化/删行变异不许命中）。 */
const OUR_ANCHORS = [
  ['O1', /^\s*export const POLICY_KEY = 'subagentModelSelectionPolicy';/m, '键常量（与 H1 同串）'],
  ['O2', /^\s*export const POLICY_STATE_VERSION = 1;/m, '版本常量（与 H2 同值）'],
  ['O3', /^\s*import \{ z \} from 'zod';/m, 'zod import（换成 schemastery 必红）'],
  ['O4', /^\s*\}\)\.strict\(\)\)\.min\(1\)\.nullable\(\),/m, 'schema 形状串（与 H4 同形）'],
  ['O5', /^\s*init: \(\) => null,/m, 'init null（与 H5 同形）'],
  ['O6', /^\s*if \(policy !== null \|\| event\.type !== POLICY_EVENT\) return policy;/m, 'fold 短路（与 H6 同形）'],
  ['O7', /^\s*assertRoutes\(allowedModels\);/m, 'fold 内校验调用（与 H7 同形）'],
  ['O8', /^\s*if \(allowedModels\.length === 0\) throw new Error\(`\$\{POLICY_EVENT\} requires at least one route`\);/m, '空名单 throw（与 H8 同形）'],
  ['O9', /^\s*return projections\.stateOf\(session, POLICY_KEY\)\?\.map\(\(route\) => \(\{ \.\.\.route \}\)\);/m, 'policyOf 包装（init null 折 undefined）'],
  ['O10', /^\s*session\.append\(POLICY_EVENT, \{ allowedModels: routes\.map\(\(route\) => \(\{ \.\.\.route \}\)\) \}\);/m, '幂等追加持久事件'],
  ['O11a', /^\s*if \(session\.header\.origin === 'subagent'\) \{/m, '采样链：父继承分支'],
  ['O11b', /session\.firstLiveSeq === 0 && session\.eventAt\(0\)\?\.type !== 'session\/end-seed'/, '采样链：fresh 判定'],
  ['O11c', /'session\/end-seed'/, '采样链：恢复会话排除'],
  ['O11d', /^\s*routes = current\.enabled \? current\.allowedModels : undefined;/m, '采样链：白名单开关短路'],
  ['O12', /^\s*export const POLICY_EVENT = 'subagent\/model-selection-policy';/m, '事件类型**值**锚（标识符锚不住串值改错）']
];

/**
 * 纯分析：两份文本互锚。缺文本（null）按「文件缺席」成红行。
 * @param {{hostText: string|null, ourText: string|null}} texts
 * @returns {{report: string[], failures: number}}
 */
export function analyzeAgentPolicy(texts) {
  const report = [];
  let failures = 0;
  const red = (id, label, why) => {
    failures += 1;
    report.push(`${id} MISSING ${label}：${why}`);
  };
  if (texts.hostText === null) {
    red('HOST', '宿主源文件', '读不到（0.2.1 树缺席或路径不对——缺树即红，不许静默跳过）');
  } else {
    for (const [id, re, label] of HOST_ANCHORS) {
      if (re.test(texts.hostText)) report.push(`${id} OK       ${label}`);
      else red(id, label, '宿主源锚漂移——宿主已改而我们未跟（或宿主换行形，须重锚）');
    }
  }
  if (texts.ourText === null) {
    red('OURS', '本包 lib/agent-policy.js', '读不到');
  } else {
    for (const [id, re, label] of OUR_ANCHORS) {
      if (re.test(texts.ourText)) report.push(`${id} OK       ${label}`);
      else red(id, label, '本包副本锚漂移——实现与设计 §3.3 副本不同形');
    }
  }
  return { report, failures };
}

// CLI 尾：只在作为主模块运行时执行（变异看守 import 纯函数时不自跑）。
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const hostArgIdx = process.argv.indexOf('--host-file');
  const config = await loadLocalPlaneOrSkip('verify/check-agent-policy.mjs（模型策略钉版看守）');
  const tree021 = config.evidenceTree['021'];
  if (hostArgIdx < 0 && tree021 === undefined) {
    console.error('宿主锚无来源：配置里既没有 evidenceTree[\'021\']，也没有 hostModules。');
    console.error(`二选一：在 ${LOCAL_DIR}/config.mjs 里写 hostModules，或设环境变量 DSAT_HOST_MODULES；`
      + '也可以临时用 --host-file <路径> 覆盖。');
    process.exit(2);
  }
  const hostPath = hostArgIdx >= 0 ? process.argv[hostArgIdx + 1] : join(tree021, ...HOST_REL);
  const readOr = (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  };
  const { report, failures } = analyzeAgentPolicy({
    hostText: readOr(hostPath),
    ourText: readOr(join(ROOT, 'lib', 'agent-policy.js'))
  });
  for (const line of report) console.log(line);
  console.log(`宿主源：${hostPath}`);
  console.log(failures === 0
    ? `agent-policy 钉版看守全绿（宿主 ${String(HOST_ANCHORS.length)} 锚 + 本包 ${String(OUR_ANCHORS.length)} 锚）`
    : `agent-policy 钉版看守 ${String(failures)} 处红`);
  process.exitCode = failures === 0 ? 0 : 1;
}
