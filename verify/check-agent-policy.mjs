/**
 * 钉版看守（设计 §3.3 有限锚集）：本包 `lib/agent-policy.js` 的投影定义形状
 * 副本与宿主 `dsh-tool-subagent` 的现行源按**有限锚集**逐行互锚——锚外漂移不红、
 * **不证明语义等价**，也不代替实际指定路由验证（清单以本脚本的锚表为准）。
 * 只看守形状副本与宿主定义的同形、不锚定采样链——派生路径现读实时策略
 * （需求 §2.3.2，无会话采样），形状副本只服务于原生会话投影的解读与钉版
 * （设计 §3.3）。
 *
 * ## 为什么要有它
 *
 * B 路线的代价是宿主内部耦合（fold 形状、`stateVersion`、事件串、zod schema——
 * 同键合并先到先得 def，错形会污染全实例该键）。宿主升级改 fold/schema 而不动
 * key/版本时，装载不会炸——本检查器让它在**静态期先红**。
 *
 * ## 判据（缺一即红；缺树即红——显式红，与 preset.test 的对账口径一致）
 *
 * 宿主侧（H1–H8）：投影定义 key/stateVersion/zod import/schema 串/init 短路/
 * assert 调用/空名单 throw。本包侧（O1–O12）：与宿主逐条对应的常量与实现行；
 * O13/O14 额外钉**行号**（fold 返回值行、provider/model 字段类型行——
 * 行被移走或行序漂移即红，行号以现行 `lib/agent-policy.js` 为准，改行序须重锚）。
 * 纯函数 `analyzeAgentPolicy` 供变异看守（`verify/mutate-agent-policy.mjs`）
 * 进程内复用（默认沙箱下不起子进程）；锚表可经第二参数覆盖（变异看守的
 * 「锚改错行号」腿用，缺省即本表）。
 *
 * 用法：node verify/check-agent-policy.mjs [--host-file <tool-subagent index.js>]
 *
 * 宿主源按 `--host-file` > 环境变量 `DSAT_HOST_MODULES` > 本机配置 `evidenceTree['021']`
 * 取（`explicitHostSource` / `resolveHostSource`）。前两者是**显式来源**：给了就不装载
 * 本机配置——干净公开副本（无 `.local/`）与 CI 里都能独立执行，运行期留下的 `.local/`
 * 祖先也不改变结论。没有显式来源时保留本机配置的原有加载合同（整个不在 → 文档化跳过；
 * 在场却损坏 → 红）。缺树与错误锚一律红，不回退、不跳过。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LOCAL_DIR,
  LocalPlaneAbsent,
  loadLocalConfig,
  loadLocalPlaneOrSkip,
  treeFromHostModules
} from '../tools/_local-config.mjs';

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
  ['H8', /length === 0[\s\S]{0,200}requires at least one route/, '空名单 throw']
];

/** 本包侧锚（lib/agent-policy.js，与宿主逐条对应；**一律行锚**——注释化/删行变异不许命中。
 * 第 4 元（可选）＝1-based 行号：正则须**从该行行首**命中，行被移走或行序漂移即红。 */
export const OUR_ANCHORS = [
  ['O1', /^\s*export const POLICY_KEY = 'subagentModelSelectionPolicy';/m, '键常量（与 H1 同串）'],
  ['O2', /^\s*export const POLICY_STATE_VERSION = 1;/m, '版本常量（与 H2 同值）'],
  ['O3', /^\s*import \{ z \} from 'zod';/m, 'zod import（换成 schemastery 必红）'],
  ['O4', /^\s*\}\)\.strict\(\)\)\.min\(1\)\.nullable\(\),/m, 'schema 形状串（与 H4 同形）'],
  ['O5', /^\s*init: \(\) => null,/m, 'init null（与 H5 同形）'],
  ['O6', /^\s*if \(policy !== null \|\| event\.type !== POLICY_EVENT\) return policy;/m, 'fold 短路（与 H6 同形）'],
  ['O7', /^\s*assertRoutes\(allowedModels\);/m, 'fold 内校验调用（与 H7 同形）'],
  ['O8', /^\s*if \(allowedModels\.length === 0\) throw new Error\(`\$\{POLICY_EVENT\} requires at least one route`\);/m, '空名单 throw（与 H8 同形）'],
  ['O9', /^\s*return projections\.stateOf\(session, POLICY_KEY\)\?\.map\(\(route\) => \(\{ \.\.\.route \}\)\);/m, 'policyOf 包装（init null 折 undefined）'],
  ['O12', /^\s*export const POLICY_EVENT = 'subagent\/model-selection-policy';/m, '事件类型**值**锚（标识符锚不住串值改错）'],
  // O13/O14 补齐设计 §3.3 锚清单里的「fold 返回值」与「schema 内层字段类型」两项；
  // 行号对应现行 lib/agent-policy.js（provider/model 在 :74-75，fold 的 return 在 :83）。
  ['O13', /^ {4}return allowedModels;$/m, 'fold 返回值（首条策略事件折出路由表）', 83],
  ['O14', /^ {4}provider: z\.string\(\)\.min\(1\),\r?\n {4}model: z\.string\(\)\.min\(1\)$/m, 'provider/model 字段类型（z.string().min(1)）', 74]
];

/** 每行行首偏移（含首行 0）。行号钉版锚取「从该行行首起」的文本切片。 */
function lineStartOffsets(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 行号钉版：正则须从第 `lineNo` 行行首命中（跨行正则以起始行计；行号越界即红）。 */
function pinnedAt(text, starts, lineNo, re) {
  const start = starts[lineNo - 1];
  if (start === undefined) return false;
  const match = re.exec(text.slice(start));
  return match !== null && match.index === 0;
}

/**
 * 纯分析：两份文本互锚。缺文本（null）按「文件缺席」成红行。
 * @param {{hostText: string|null, ourText: string|null}} texts
 * @param {{hostAnchors?: Array, ourAnchors?: Array}} [overrides] - 锚表覆盖（变异看守
 *   的「锚改错行号」腿用）；缺省用本模块的现行锚表。
 * @returns {{report: string[], failures: number}}
 */
export function analyzeAgentPolicy(texts, { hostAnchors = HOST_ANCHORS, ourAnchors = OUR_ANCHORS } = {}) {
  const report = [];
  let failures = 0;
  const red = (id, label, why) => {
    failures += 1;
    report.push(`${id} MISSING ${label}：${why}`);
  };
  if (texts.hostText === null) {
    red('HOST', '宿主源文件', '读不到（0.2.1 树缺席或路径不对——缺树即红，不许静默跳过）');
  } else {
    for (const [id, re, label] of hostAnchors) {
      if (re.test(texts.hostText)) report.push(`${id} OK       ${label}`);
      else red(id, label, '宿主源锚漂移——宿主已改而我们未跟（或宿主换行形，须重锚）');
    }
  }
  if (texts.ourText === null) {
    red('OURS', '本包 lib/agent-policy.js', '读不到');
  } else {
    const ourStarts = lineStartOffsets(texts.ourText);
    for (const entry of ourAnchors) {
      const [id, re, label, lineNo] = entry;
      const hitAnchor = lineNo === undefined
        ? re.test(texts.ourText)
        : pinnedAt(texts.ourText, ourStarts, lineNo, re);
      if (hitAnchor) report.push(`${id} OK       ${label}`);
      else if (lineNo === undefined) red(id, label, '本包副本锚漂移——实现与设计 §3.3 副本不同形');
      else red(id, label, `本包副本锚不在钉住的第 ${String(lineNo)} 行——行序漂移或行形改坏`);
    }
  }
  return { report, failures };
}

/**
 * 显式宿主源：`--host-file` 优先于环境变量 `DSAT_HOST_MODULES`；空串按"没有来源"。
 *
 * 两条都是纯源输入——路径拼装只用 `tools/_local-config.mjs` 的 `treeFromHostModules`，
 * 不读 `.local/`、不读配置。
 *
 * @param {{hostFile?: string, env?: Record<string, string | undefined>}} [options]
 *   `hostFile` 是 `--host-file` 的值；`env` 默认 `process.env`（测试喂合成值）。
 * @returns {{hostPath: string, source: 'host-file' | 'env'} | undefined} 显式来源；都没有时 `undefined`。
 */
export function explicitHostSource({ hostFile, env = process.env } = {}) {
  if (typeof hostFile === 'string' && hostFile.length > 0) {
    return { hostPath: hostFile, source: 'host-file' };
  }
  const hostModules = env.DSAT_HOST_MODULES;
  if (typeof hostModules === 'string' && hostModules.length > 0) {
    return { hostPath: join(treeFromHostModules(hostModules), ...HOST_REL), source: 'env' };
  }
  return undefined;
}

/**
 * 解析宿主源：显式来源优先，其次本机配置。
 *
 * 显式来源在场时**不装载本机配置**——这是"纯源检查器要能脱离本机环境执行"的那条出口；
 * 本机配置的缺席/损坏合同留给没有显式来源的路径。
 *
 * @param {{hostFile?: string, env?: Record<string, string | undefined>, root?: string}} [options]
 *   `root` 是仓根（`.local/` 与 `config.mjs` 的解析基准；默认本检查器上一级，测试喂合成根）。
 * @returns {Promise<
 *   | {status: 'host', hostPath: string, source: 'host-file' | 'env' | 'local'}
 *   | {status: 'absent', reason: string}
 *   | {status: 'no-tree', reason: string}>}
 *   `absent` = 本机环境整个不在（调用方按文档化跳过，退出码 0）；`no-tree` = 本机配置
 *   在场却没有 `evidenceTree['021']` 来源（调用方按红退出，缺树不许静默跳过）。
 *   `.local/` 在场而配置损坏（`LocalConfigInvalid`）不折成状态，原样抛出。
 */
export async function resolveHostSource({ hostFile, env = process.env, root = ROOT } = {}) {
  const explicit = explicitHostSource({ hostFile, env });
  if (explicit !== undefined) return { status: 'host', ...explicit };

  let config;
  try {
    config = await loadLocalConfig({ root, env });
  } catch (error) {
    if (error instanceof LocalPlaneAbsent) return { status: 'absent', reason: error.message };
    throw error;
  }
  const tree021 = config.evidenceTree['021'];
  if (tree021 === undefined) {
    return {
      status: 'no-tree',
      reason: '宿主锚无来源：配置里既没有 evidenceTree[\'021\']，也没有 hostModules。\n'
        + `二选一：在 ${LOCAL_DIR}/config.mjs 里写 hostModules，或设环境变量 DSAT_HOST_MODULES；`
        + '也可以临时用 --host-file <路径> 覆盖。'
    };
  }
  return { status: 'host', hostPath: join(tree021, ...HOST_REL), source: 'local' };
}

// CLI 尾：只在作为主模块运行时执行（变异看守 import 纯函数时不自跑）。
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const WHAT = 'verify/check-agent-policy.mjs（模型策略钉版看守）';
  const hostArgIdx = process.argv.indexOf('--host-file');
  const hostFile = hostArgIdx < 0 ? undefined : process.argv[hostArgIdx + 1];
  // 显式来源给了就必须可用：缺值不回退本机配置（回退会把调用错误读成"锚漂移"或跳过）。
  if (hostArgIdx >= 0 && (hostFile === undefined || hostFile.length === 0)) {
    console.error('--host-file 缺少路径参数。');
    process.exit(2);
  }
  const resolved = await resolveHostSource({ hostFile });
  if (resolved.status === 'absent') {
    // 本机环境整个不在：走所有 CLI 判据共用的跳过出口（同一文案、退出码 0）。
    await loadLocalPlaneOrSkip(WHAT);
  }
  if (resolved.status === 'no-tree') {
    console.error(resolved.reason);
    process.exit(2);
  }
  const readOr = (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  };
  const { report, failures } = analyzeAgentPolicy({
    hostText: readOr(resolved.hostPath),
    ourText: readOr(join(ROOT, 'lib', 'agent-policy.js'))
  });
  for (const line of report) console.log(line);
  console.log(`宿主源：${resolved.hostPath}（来源：${resolved.source}）`);
  console.log(failures === 0
    ? `agent-policy 钉版看守全绿（宿主 ${String(HOST_ANCHORS.length)} 锚 + 本包 ${String(OUR_ANCHORS.length)} 锚）`
    : `agent-policy 钉版看守 ${String(failures)} 处红`);
  process.exitCode = failures === 0 ? 0 : 1;
}
