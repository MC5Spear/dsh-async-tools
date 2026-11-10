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
 *    例外：调用方只**需要宿主源**时，可用显式来源（环境变量 `DSAT_HOST_MODULES` 或
 *    命令行 `--host-file`）不装载本机配置直接执行——此时本机配置的缺席/损坏合同不适用
 *    （现行实例：`verify/check-agent-policy.mjs` 的 `resolveHostSource`）。
 * 2. 准入后逐字段取非空环境变量优先、文件值备用；支持 `DSAT_HOST_MODULES` /
 *    `DSAT_INSTANCE_URL` / `DSAT_TOKEN_FILE` 等。文件为 ESM 默认导出对象，示例为
 *    `tools/local-config.example.mjs`。宿主解析钩子可单独用环境变量跑单测，与本入口不同。
 *    两个例外：`siblingBundles` 以文件数组为准（含空数组 `[]`＝只断言本包自己），
 *    `DSAT_SIBLING_BUNDLES` 仅当文件未提供该字段时作为回退；`evidenceDir` /
 *    `workspaceDir` / `tmpDir` 与普通字段同规则（env→文件→派生缺省），不是固定值。
 *    `credentialOriginMap`（合法跨源的显式映射）也是数组字段：环境变量
 *    `DSAT_CREDENTIAL_ORIGIN_MAP`（JSON 数组文本）优先、文件值备用。
 * 3. 两个来源都没有相关字段时留 `undefined`，调用方打印理由并跳过相应本机判据。
 *
 * ## 凭据与目标的绑定（`instanceCredentials` 的合同）
 *
 * 令牌文件里的 URL 自报来源（origin）。取令牌时**必须**核对它与 `instanceUrl` 的
 * 协议／主机／端口对应关系，防止部分环境变量覆盖把 A 实例的凭据发给 B 实例：
 *
 * - 默认要求两者 origin 一致；不一致按**错误**拒绝（不是警告），错误里写明两者
 *   各自的取值与来源（复用 `notes` 的来源登记）。
 * - SSH 隧道／反向代理等合法跨源走**显式、可审计的映射**（`credentialOriginMap`，
 *   形如 `[{ tokenOrigin, instanceOrigin }]`）：映射两端同时命中才放行，不能只比
 *   端口、不能 host 不同一律放过。
 * - 非 loopback 的 `http:` 目标**一律拒绝**（同源与显式映射都不放行；本实现不提供
 *   `allowInsecure` 之类的例外）——明文远程会让传输路径上的任何观察者读到令牌。
 *   loopback（`127.*`／`localhost`／`::1`）的 http 与一切 https 照常按上述规则放行。
 * - 探针构造带令牌的请求 URL 一律用 `tokenEntryUrl`（`URLSearchParams` 统一编码）。
 *
 * ## 缺席与损坏是两件事（这条分开是本模块的关键设计）
 *
 * - **`.local/` 整个不在** → `LocalPlaneAbsent`。这是 CI 与外部 clone 的正常形态，
 *   调用方按**文档化跳过**处理（打印理由 + 非失败退出）。
 * - **`.local/` 在、`config.mjs` 不在或装载失败** → `LocalConfigInvalid`。这是**开发机
 *   配置坏了**，按**红**处理。
 *
 * 若不分开，开发机上误删一次 `config.mjs` 就会让所有本机判据静默变绿（假绿比不测
 * 更糟；`verify/README.md` 现行要点：「优先默认权限执行；纯函数判断尽量进程内复用」）。
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
 * 把来源文本解析成 http(s) URL（凭据绑定的公共入口）。
 *
 * @param {string} text - 来源文本（instanceUrl 或令牌文件里的 URL）。
 * @param {string} what - 报错时指名这份文本是什么。
 * @returns {URL} 已解析并核过协议的 URL。
 * @throws {Error} 文本不可解析，或协议不是 http:/https:。
 */
function parseHttpUrl(text, what) {
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${what} 不是可解析的 URL：${text}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${what} 的协议必须是 http: 或 https:（实得 ${parsed.protocol}）：${text}`);
  }
  return parsed;
}

/** 主机名是否 loopback：`127.*`、`localhost`、`::1`（明文 http 的唯一放行范围；
 * IPv6 主机名按 WHATWG 序列化带方括号，比较前剥掉）。 */
function isLoopbackHostname(hostname) {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return bare === 'localhost' || bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/**
 * 从 `notes` 里找某字段的来源说明（loadLocalConfig 已登记「xx 取自环境变量 YY」）。
 *
 * @param {Awaited<ReturnType<typeof loadLocalConfig>>} config - 已装载的配置。
 * @param {string} field - 字段名（如 `instanceUrl`）。
 * @returns {string} 来源说明；notes 没登记时说明来自配置文件或调用方直传。
 */
function sourceNoteOf(config, field) {
  const hit = (config.notes ?? []).find((note) => note.startsWith(`${field} 取自环境变量`));
  return hit ?? `${field} 来自本机配置文件（或调用方直接传入）`;
}

/**
 * 归一化一条显式映射：两端必须是可解析的 http(s) origin，按 `origin` 精确比较。
 *
 * @param {unknown} entry - 映射条目。
 * @param {string} where - 报错时指名来源（文件字段或环境变量）。
 * @returns {{ tokenOrigin: string, instanceOrigin: string }} 归一化条目。
 * @throws {LocalConfigInvalid} 条目形状不对。
 */
function normalizeOriginMapEntry(entry, where) {
  if (typeof entry !== 'object' || entry === null) {
    throw new LocalConfigInvalid(`${where} 的条目必须是 { tokenOrigin, instanceOrigin } 对象`);
  }
  const { tokenOrigin, instanceOrigin } = entry;
  if (typeof tokenOrigin !== 'string' || typeof instanceOrigin !== 'string'
    || tokenOrigin.length === 0 || instanceOrigin.length === 0) {
    throw new LocalConfigInvalid(`${where} 的映射条目缺少非空 tokenOrigin／instanceOrigin：${JSON.stringify(entry)}`);
  }
  return {
    tokenOrigin: parseHttpUrl(tokenOrigin, `${where} 的 tokenOrigin`).origin,
    instanceOrigin: parseHttpUrl(instanceOrigin, `${where} 的 instanceOrigin`).origin
  };
}

/**
 * 解析 credentialOriginMap（合法跨源的显式映射）：环境变量 JSON 文本优先、文件数组备用。
 *
 * @param {Record<string, unknown>} fromFile - 文件值。
 * @param {Record<string, string | undefined>} env - 环境。
 * @param {string[]} notes - 来源登记（就地追加）。
 * @returns {{ tokenOrigin: string, instanceOrigin: string }[]} 归一化映射（可为空数组）。
 * @throws {LocalConfigInvalid} 提供了该字段但形状不对（配置坏了按红处理）。
 */
function resolveCredentialOriginMap(fromFile, env, notes) {
  const envRaw = env.DSAT_CREDENTIAL_ORIGIN_MAP;
  if (typeof envRaw === 'string' && envRaw.length > 0) {
    let parsed;
    try {
      parsed = JSON.parse(envRaw);
    } catch (error) {
      throw new LocalConfigInvalid(`环境变量 DSAT_CREDENTIAL_ORIGIN_MAP 不是合法 JSON：${String(error instanceof Error ? error.message : error)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new LocalConfigInvalid('环境变量 DSAT_CREDENTIAL_ORIGIN_MAP 必须是 JSON 数组（形如 [{"tokenOrigin":"…","instanceOrigin":"…"}]）');
    }
    const entries = parsed.map((entry, i) => normalizeOriginMapEntry(entry, `环境变量 DSAT_CREDENTIAL_ORIGIN_MAP 第 ${String(i + 1)} 条`));
    notes.push(`credentialOriginMap 取自环境变量 DSAT_CREDENTIAL_ORIGIN_MAP（${String(entries.length)} 条）`);
    return entries;
  }
  if (fromFile.credentialOriginMap !== undefined) {
    if (!Array.isArray(fromFile.credentialOriginMap)) {
      throw new LocalConfigInvalid(`${CONFIG_REL} 的 credentialOriginMap 必须是数组（形如 [{ tokenOrigin, instanceOrigin }]）`);
    }
    const entries = fromFile.credentialOriginMap.map((entry, i) => normalizeOriginMapEntry(entry, `${CONFIG_REL} 的 credentialOriginMap 第 ${String(i + 1)} 条`));
    notes.push(`credentialOriginMap 取自配置文件（${String(entries.length)} 条）`);
    return entries;
  }
  return [];
}

/**
 * 在显式映射里找「令牌来源 → 实例目标」两端同时命中的条目。
 *
 * @param {Awaited<ReturnType<typeof loadLocalConfig>>} config - 已装载的配置。
 * @param {string} tokenOrigin - 令牌 URL 的 origin。
 * @param {string} instanceOrigin - instanceUrl 的 origin。
 * @returns {{ tokenOrigin: string, instanceOrigin: string } | null} 命中的条目；没有为 null。
 */
function findOriginMapEntry(config, tokenOrigin, instanceOrigin) {
  const map = Array.isArray(config.credentialOriginMap) ? config.credentialOriginMap : [];
  return map.find((entry) => entry.tokenOrigin === tokenOrigin && entry.instanceOrigin === instanceOrigin) ?? null;
}

/**
 * `hostModules` → 0.2.1 线证据树根（其下的 `@deepseek-ai` 域目录）。
 *
 * 结构性缺省只此一处：走到显式宿主源（`DSAT_HOST_MODULES` / `--host-file`）的调用方
 * 也用它拼路径，域目录名不另抄一份；宿主锚与证据锚因此读同一份来源。
 *
 * @param {string | undefined} hostModules - 宿主安装树的 `node_modules`（无来源时 `undefined`）。
 * @returns {string | undefined} 证据树根；无来源时 `undefined`。
 */
export function treeFromHostModules(hostModules) {
  return hostModules === undefined ? undefined : join(hostModules, '@deepseek-ai');
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
 *   credentialOriginMap: Array<{ tokenOrigin: string, instanceOrigin: string }>,
 *   instanceHome: string | undefined, serviceLog: string | undefined,
 *   junctions: Array<{ name: string, link: string, target: string, version: string }> | undefined,
 *   siblingBundles: string[],
 *   evidenceDir: string, workspaceDir: string, tmpDir: string,
 *   notes: string[]
 * }>} 归一化配置；缺席/不可用的字段为 `undefined`，`notes` 逐条说明来源与跳过理由。
 *   `evidenceDir` / `workspaceDir` / `tmpDir` 是**带派生缺省的可配置字段**（与普通
 *   字段同规则：环境变量→文件→缺省）：`evidenceDir` 缺省指向本机侧的证据目录
 *   （探针的落盘位置）；`workspaceDir` 是探针驱动远端会话时该用的工作目录（缺省
 *   仓根）；`tmpDir` 是探针运行期要建/删的目录的落点（缺省 `.local/tmp`）——运行
 *   产物不落公开范围。
 *   `siblingBundles` 是"这台部署的 profile 里除本包之外还应当挂着的包名"，以文件
 *   数组为准（含空数组 `[]`——空数组的含义是"只断言本包自己"，这正是外部读者的
 *   形态）；`DSAT_SIBLING_BUNDLES` 仅当文件未提供该字段时作为回退。
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
    '021': fileTrees['021'] ?? treeFromHostModules(hostModules),
    '020': fileTrees['020'],
    '017': fileTrees['017'],
    '015': fileTrees['015']
  };
  for (const key of ['021', '020', '017', '015']) {
    if (evidenceTree[key] === undefined) notes.push(`evidenceTree['${key}'] 无来源（该档判据将跳过）`);
  }

  const junctions = Array.isArray(fromFile.junctions) ? fromFile.junctions : undefined;
  // `siblingBundles` 以文件数组为准（含空数组＝只断言本包自己）；环境变量
  // `DSAT_SIBLING_BUNDLES` 仅当文件未提供该字段时作为回退（数组没法定成
  // 字符串环境变量，文件是首选形状）。
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
  const credentialOriginMap = resolveCredentialOriginMap(fromFile, env, notes);
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
    credentialOriginMap,
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
 * ## 凭据与目标的绑定（防「A 实例的令牌发给 B 实例」）
 *
 * 令牌文件里的 URL 自报来源（origin）；本函数取令牌时**必须**核对它与
 * `instanceUrl` 的协议／主机／端口对应关系（合同详见本模块头注）：
 *
 * - 两者 origin 一致 → 放行；
 * - 命中 `credentialOriginMap` 显式映射（两端同时命中）→ 放行（合法隧道／反向代理）；
 * - 其余不一致 → **按错误拒绝**（不是警告），错误里写明两者各自的取值与来源；
 * - 非 loopback 的 `http:` 目标 → 一律拒绝（同源与映射都不放行，无明文远程例外）。
 *
 * @param {Awaited<ReturnType<typeof loadLocalConfig>>} config - 已装载的配置。
 * @returns {{ base: string, token: string, tokenFile: string }} 基址（形如 `http://127.0.0.1:<port>`）、
 *   令牌、令牌文件路径。
 * @throws {Error} `instanceUrl` / `tokenFile` 缺一、令牌读不出，或来源绑定不成立。
 */
export function instanceCredentials(config) {
  if (config.instanceUrl === undefined || config.tokenFile === undefined) {
    throw new Error('instanceCredentials：config 里 instanceUrl 与 tokenFile 必须都有'
      + `（现为 instanceUrl=${String(config.instanceUrl)} tokenFile=${String(config.tokenFile)}）`);
  }
  const raw = readFileSync(config.tokenFile, 'utf8').trim();
  const start = raw.indexOf('http');
  const tokenUrl = parseHttpUrl(start === -1 ? raw : raw.slice(start), `令牌文件里的 URL（${config.tokenFile}）`);
  const token = tokenUrl.searchParams.get('token');
  if (token === null || token.length === 0) {
    throw new Error(`令牌文件里没有 token 参数：${config.tokenFile}`);
  }
  const instanceUrl = parseHttpUrl(config.instanceUrl, 'instanceUrl');
  const tokenOrigin = tokenUrl.origin;
  const instanceOrigin = instanceUrl.origin;
  const instanceSource = sourceNoteOf(config, 'instanceUrl');

  // 明文远程不发送令牌——同源与显式映射都不放行；本实现不提供 allowInsecure 例外。
  if (instanceUrl.protocol === 'http:' && !isLoopbackHostname(instanceUrl.hostname)) {
    throw new Error([
      'instanceCredentials 拒绝：目标是非 loopback 的明文 http，不发送令牌。',
      `  目标：${config.instanceUrl}（${instanceSource}）`,
      '明文远程会让传输路径上的任何观察者读到令牌，显式映射也不为明文远程放行。',
      '请改用 https 目标，或使用 loopback 地址（127.*／localhost／::1）。'
    ].join('\n'));
  }

  const mapped = findOriginMapEntry(config, tokenOrigin, instanceOrigin);
  if (instanceOrigin !== tokenOrigin && mapped === null) {
    throw new Error([
      'instanceCredentials 拒绝：令牌来源与目标实例不一致。',
      `  令牌 URL origin：${tokenOrigin}（来自令牌文件 ${config.tokenFile}；${sourceNoteOf(config, 'tokenFile')}）`,
      `  instanceUrl origin：${instanceOrigin}（${instanceSource}）`,
      '只覆盖一项环境变量（例如只设 DSAT_INSTANCE_URL）就会造成这种错配——凭据可能发给另一个实例。',
      '同源或命中显式映射才放行。SSH 隧道／反向代理等合法跨源场景，请在 .local/config.mjs 的',
      'credentialOriginMap（或环境变量 DSAT_CREDENTIAL_ORIGIN_MAP，JSON 数组）登记',
      '{ "tokenOrigin": "…", "instanceOrigin": "…" }，两端同时命中才生效。'
    ].join('\n'));
  }
  return { base: config.instanceUrl, token, tokenFile: config.tokenFile };
}

/**
 * 构造带令牌的实例入口 URL——探针首跳与页面 URL 的**统一编码出口**。
 *
 * 令牌从令牌 URL 解析出来后已是解码文本；再拼回 URL 必须重新编码。直接字符串拼接
 * 会在令牌含 `&`／`=`／`+`／空格等字符时悄悄变形，所以一律经 `URLSearchParams`
 * 编码，不再各探针自拼 `?token=`。
 *
 * @param {string} base - 实例基址（instanceCredentials 的 `base`）。
 * @param {string} token - 令牌（解码文本）。
 * @returns {string} 形如 `${base}/?token=<已编码>` 的完整 URL。
 */
export function tokenEntryUrl(base, token) {
  const url = new URL(base);
  url.searchParams.set('token', token);
  return url.href;
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
    line("evidenceTree020", config.evidenceTree['020']),
    line("evidenceTree017", config.evidenceTree['017']),
    line("evidenceTree015", config.evidenceTree['015']),
    line('instanceUrl', config.instanceUrl),
    line('tokenFile', config.tokenFile),
    line('credentialOriginMap', (config.credentialOriginMap ?? []).length === 0
      ? '（无显式映射）'
      : `${String(config.credentialOriginMap.length)} 条（${config.credentialOriginMap.map((e) => `${e.tokenOrigin}→${e.instanceOrigin}`).join('、')}）`),
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
