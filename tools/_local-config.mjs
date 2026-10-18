/**
 * 本机配置加载器 —— **公开范围唯一的"读本机事实"入口**。
 *
 * ## 为什么要有它
 *
 * 产品代码、测试与工具、需求稿与设计稿属于公开范围；机器事实（宿主安装树、实例端口、
 * 令牌文件位置）属于本机配置，**不进入本公开仓**。配置从 `.local/` 或环境变量读取，
 * 公开脚本不得硬编码这些事实。本机环境缺席时文档化跳过，配置损坏时失败。
 *
 * ## 准入与字段来源
 *
 * 1. 先检查 `.local/` 与 `.local/config.mjs`，缺席/损坏处置如下；环境变量不绕过准入。
 * 2. 准入后逐字段取非空环境变量优先、文件值备用；支持 `DSAT_HOST_MODULES` /
 *    `DSAT_INSTANCE_URL` / `DSAT_TOKEN_FILE` 等。文件为 ESM 默认导出对象，示例为
 *    `tools/local-config.example.mjs`。宿主解析钩子可单独用环境变量跑单测，与本入口不同。
 * 3. 两个来源都没有相关字段时留 `undefined`，调用方打印理由并跳过相应本机判据。
 *
 * ## 缺席与损坏是两件事（这条分开是本模块的关键设计）
 *
 * - **`.local/` 整个不在** → `LocalPlaneAbsent`。这是 CI 与外部 clone 的正常形态，
 *   调用方按**文档化跳过**处理（打印理由 + 非失败退出）。
 * - **`.local/` 在、`config.mjs` 不在或装载失败** → `LocalConfigInvalid`。这是**开发机
 *   配置坏了**，按**红**处理。
 *
 * 若不分开，开发机上误删一次 `config.mjs` 就会让所有本机判据静默变绿——那正是
 * 本仓反复登记过的"假绿"形态（`verify/README.md` 现行要点：「优先默认权限执行；纯函数判断尽量进程内复用」）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 本机侧的目录名（相对仓根）。 */
export const LOCAL_DIR = '.local';

/** 本机配置文件的相对路径。 */
export const CONFIG_REL = '.local/config.mjs';

/** `.local/` 整个不在：CI 与外部 clone 的正常形态，调用方按文档化跳过处理。 */
export class LocalPlaneAbsent extends Error {
  constructor(root) {
    super(`本机环境缺席：${join(root, LOCAL_DIR)} 不存在——`
      + '这是 CI 与外部 clone 的正常形态，本机侧判据按文档化跳过');
    this.name = 'LocalPlaneAbsent';
  }
}

/** `.local/` 在但配置不可用：开发机配置坏了，按红处理。 */
export class LocalConfigInvalid extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocalConfigInvalid';
  }
}

/** 环境变量 → 配置字段（字段名见下）。 */
const ENV_FIELDS = [
  ['DSAT_HOST_MODULES', 'hostModules'],
  ['DSAT_INSTANCE_URL', 'instanceUrl'],
  ['DSAT_TOKEN_FILE', 'tokenFile'],
  ['DSAT_INSTANCE_HOME', 'instanceHome'],
  ['DSAT_SERVICE_LOG', 'serviceLog'],
  ['DSAT_EVIDENCE_DIR', 'evidenceDir'],
  ['DSAT_WORKSPACE_DIR', 'workspaceDir'],
  ['DSAT_TMP_DIR', 'tmpDir']
];
/**
 * 本机环境是否在场（`.local/` 目录是否存在）。
 *
 * @param {string} [root] - 仓根。
 * @returns {boolean} 在场为 true。
 */
export function localPlanePresent(root = MODULE_ROOT) {
  return existsSync(join(root, LOCAL_DIR));
}

/**
 * 装载本机配置。
 *
 * @param {{ root?: string, env?: Record<string, string | undefined> }} [options]
 *   `root` 仓根（默认本模块上一级）；`env` 环境（默认 `process.env`，测试可喂合成值）。
 * @returns {Promise<{
 *   root: string, source: 'file' | 'both', configFile: string | undefined,
 *   hostModules: string | undefined,
 *   evidenceTree: { '021': string | undefined, '020': string | undefined, '017': string | undefined, '015': string | undefined },
 *   instanceUrl: string | undefined, tokenFile: string | undefined,
 *   instanceHome: string | undefined, serviceLog: string | undefined,
 *   junctions: Array<{ name: string, link: string, target: string, version: string }> | undefined,
 *   siblingBundles: string[],
 *   evidenceDir: string, workspaceDir: string, tmpDir: string,
 *   notes: string[]
 * }>} 归一化配置；缺席/不可用的字段为 `undefined`，`notes` 逐条说明来源与跳过理由。
 *   `evidenceDir` / `workspaceDir` / `tmpDir` 是**派生**字段（不是配置项）：`evidenceDir`
 *   固定指向本机侧的证据目录（探针的落盘位置）；`workspaceDir` 是探针驱动远端会话时
 *   该用的工作目录；`tmpDir` 是探针运行期要建/删的目录的落点（缺省 `.local/tmp`，
 *   可被同名字段覆盖）——运行产物不落公开范围。
 *   `siblingBundles` 是"这台部署的 profile 里除本包之外还应当挂着的包名"，
 *   缺省空数组——空数组的含义是"只断言本包自己"，这正是外部读者的形态。
 * @throws {LocalPlaneAbsent} `.local/` 不存在。
 * @throws {LocalConfigInvalid} `.local/` 存在但 `config.mjs` 缺失或装载失败。
 */
export async function loadLocalConfig({ root = MODULE_ROOT, env = process.env } = {}) {
  const localDir = join(root, LOCAL_DIR);
  if (!existsSync(localDir)) throw new LocalPlaneAbsent(root);

  const configFile = join(root, CONFIG_REL);
  /** @type {Record<string, unknown>} */
  let fromFile = {};
  if (existsSync(configFile)) {
    try {
      const mod = await import(pathToFileURL(configFile).href);
      fromFile = mod.default ?? {};
    } catch (error) {
      throw new LocalConfigInvalid(`${CONFIG_REL} 存在但装载失败：`
        + `${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    throw new LocalConfigInvalid(`${CONFIG_REL} 不存在，但 ${LOCAL_DIR}/ 在场——`
      + '开发机上这是配置缺失（按红处理，不是跳过）。'
      + `形状照 ${'tools/local-config.example.mjs'} 写一份即可`);
  }

  const notes = [];
  /** @type {Record<string, string | undefined>} */
  const envValues = {};
  for (const [envName, field] of ENV_FIELDS) {
    const value = env[envName];
    if (typeof value === 'string' && value.length > 0) {
      envValues[field] = value;
      notes.push(`${field} 取自环境变量 ${envName}`);
    }
  }
  const pick = (field) => envValues[field]
    ?? (typeof fromFile[field] === 'string' && fromFile[field].length > 0 ? fromFile[field] : undefined);

  const hostModules = pick('hostModules');
  const fileTrees = (fromFile.evidenceTree ?? {});
  /**
   * 证据树四档（口径见本机侧事实登记簿）：
   * `021` = 0.2.1 线运行树（当前线）、`020` = 0.2.0 线树（历史线，显式配置）、
   * `017` = 0.1.7 线树、`015` = 0.1.5 线（npm 全局树）。
   *
   * `021` 有**结构性缺省**：它就是 `hostModules` 下的 `@deepseek-ai` 域目录。
   * 这条缺省让"宿主锚"与"证据锚"不可能指向两棵不同的树，
   * `verify/check-junctions.mjs` 的同根对账因此是构造性的，不靠让两处常量保持一致。
   */
  const evidenceTree = {
    '021': fileTrees['021'] ?? (hostModules === undefined ? undefined : join(hostModules, '@deepseek-ai')),
    '020': fileTrees['020'],
    '017': fileTrees['017'],
    '015': fileTrees['015']
  };
  for (const key of ['021', '020', '017', '015']) {
    if (evidenceTree[key] === undefined) notes.push(`evidenceTree['${key}'] 无来源（该档判据将跳过）`);
  }

  const junctions = Array.isArray(fromFile.junctions) ? fromFile.junctions : undefined;
  // `siblingBundles` 只能用逗号分隔的环境变量覆盖（数组没法定成字符串环境变量）。
  const siblingBundles = Array.isArray(fromFile.siblingBundles)
    ? fromFile.siblingBundles
    : (typeof env.DSAT_SIBLING_BUNDLES === 'string' && env.DSAT_SIBLING_BUNDLES.length > 0
      ? env.DSAT_SIBLING_BUNDLES.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : []);
  if (siblingBundles.length > 0) {
    notes.push(`siblingBundles 有 ${String(siblingBundles.length)} 项：${siblingBundles.join('、')}`);
  }
  const evidenceDir = pick('evidenceDir') ?? join(root, LOCAL_DIR, 'evidence');
  const workspaceDir = pick('workspaceDir') ?? root;
  const tmpDir = pick('tmpDir') ?? join(root, LOCAL_DIR, 'tmp');
  const source = envValues.hostModules === undefined && envValues.instanceUrl === undefined
    && envValues.tokenFile === undefined ? 'file' : 'both';

  return {
    root,
    source,
    configFile,
    hostModules,
    evidenceTree,
    instanceUrl: pick('instanceUrl'),
    tokenFile: pick('tokenFile'),
    instanceHome: pick('instanceHome'),
    serviceLog: pick('serviceLog'),
    junctions,
    siblingBundles,
    evidenceDir,
    workspaceDir,
    tmpDir,
    notes
  };
}

/**
 * 取验证实例的连接凭据（基址 + 令牌）。探针脚本用它代替"从自身位置推算服务家目录"。
 *
 * @param {Awaited<ReturnType<typeof loadLocalConfig>>} config - 已装载的配置。
 * @returns {{ base: string, token: string, tokenFile: string }} 基址（形如 `http://127.0.0.1:<port>`）、
 *   令牌、令牌文件路径。
 * @throws {Error} `instanceUrl` / `tokenFile` 缺一，或令牌文件读不出令牌。
 */
export function instanceCredentials(config) {
  if (config.instanceUrl === undefined || config.tokenFile === undefined) {
    throw new Error('instanceCredentials：config 里 instanceUrl 与 tokenFile 必须都有'
      + `（现为 instanceUrl=${String(config.instanceUrl)} tokenFile=${String(config.tokenFile)}）`);
  }
  const raw = readFileSync(config.tokenFile, 'utf8').trim();
  const start = raw.indexOf('http');
  const token = new URL(start === -1 ? raw : raw.slice(start)).searchParams.get('token');
  if (token === null || token.length === 0) {
    throw new Error(`令牌文件里没有 token 参数：${config.tokenFile}`);
  }
  return { base: config.instanceUrl, token, tokenFile: config.tokenFile };
}

/**
 * 一行式诊断文本（把"这套判据读到的是哪棵树/哪个实例"打出来）。
 *
 * 一条固定风险：**假绿往往来自"读的不是你以为的那份东西"**。诊断行让这件事
 * 一眼可见，不必再去猜。
 *
 * @param {Awaited<ReturnType<typeof loadLocalConfig>>} config - 已装载的配置。
 * @returns {string} 多行诊断文本。
 */
export function describeConfig(config) {
  const line = (label, value) => `  ${label.padEnd(16)} ${value ?? '（无来源）'}`;
  return [
    `本机配置 来源=${config.source} 文件=${config.configFile ?? '（无）'}`,
    line('hostModules', config.hostModules),
    line("evidenceTree021", config.evidenceTree['021']),
    line("evidenceTree017", config.evidenceTree['017']),
    line("evidenceTree015", config.evidenceTree['015']),
    line('instanceUrl', config.instanceUrl),
    line('tokenFile', config.tokenFile),
    line('instanceHome', config.instanceHome),
    line('serviceLog', config.serviceLog),
    line('evidenceDir', config.evidenceDir),
    line('workspaceDir', config.workspaceDir),
    line('tmpDir', config.tmpDir),
    line('siblingBundles', config.siblingBundles.length === 0 ? '（无）' : config.siblingBundles.join('、')),
    ...config.notes.map((note) => `  · ${note}`)
  ].join('\n');
}

/**
 * CLI 判据的本机侧入口：能装载就返回配置；**本机环境整个不在**时打印一行 `SKIP …`
 * 并结束进程（退出码 0）。
 *
 * 本函数**会调用 `process.exit`**，所以只给 CLI 脚本用，不给库用。名字里的
 * `OrSkip` 就是这件事的提示。`LocalConfigInvalid`（`.local/` 在但配置坏了）**不吞**——
 * 那是开发机配置错误，按红抛出。
 *
 * @param {string} what - 脚本自述（写进 SKIP 行，例如 `verify/probe-x.mjs`）。
 * @param {{ root?: string, env?: Record<string, string | undefined> }} [options] - 同 `loadLocalConfig`。
 * @returns {Promise<Awaited<ReturnType<typeof loadLocalConfig>>>} 配置；不在场时**不返回**（已退出）。
 */
export async function loadLocalPlaneOrSkip(what, options = {}) {
  try {
    return await loadLocalConfig(options);
  } catch (error) {
    if (!(error instanceof LocalPlaneAbsent)) throw error;
    console.log(`SKIP ${what}：${error.message}`);
    console.log('     本判据只对开发机上的活体实例/安装树有意义；'
      + 'CI 与外部 clone 上没有本机环境，按跳过处理（不是失败）。');
    process.exit(0);
  }
}
