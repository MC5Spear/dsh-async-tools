/**
 * 宿主契约分派层（设计 §7.4）：0.2.2-rc.1（嵌套形态）与 rc.2/rc.3（扁平形态）
 * 两种服务契约的唯一汇聚点。三件出口：
 *
 * - `subagentContract()`——形态判定（§7.4.1）：读本包进程内解析到的
 *   `@deepseek-ai/dsh-subagent` 包清单 version，按 semver 预发布序以
 *   `0.2.2-rc.2` 为界二分；小于＝`'nested'`，大于等于＝`'flat'`，解析失败＝
 *   `undefined`（模块实例内一次记忆，含失败）。
 * - `startActivation(ctx, parts)`——创建分派（§7.4.2）：形态无关部件在分派层
 *   落成两形态各自的 spec；两形态产物都不携带对方形状的残键（rc.2+ 入口先读
 *   `spec.parent.id`，嵌套残键会同步抛 TypeError，不是静默忽略）。
 * - `listDirectChildren(ctx, owner, signal)`——直接子列举分派：嵌套形态走
 *   `listChildren`；扁平形态走 `listDescendants` 后过滤 `depth === 1`（诊断行
 *   同深度保留进纠错清单，更深的行与诊断一律丢弃——宿主可列举更大子树不授予
 *   额外等待范围，需求 §2.3.3／§7.3.4）。
 *
 * ## 判定纪律（§7.4.1 的硬约束）
 *
 * - **禁止**以「创建一次子代理捕获错误重试」探测形态（需求 §7.3.4 明令——
 *   避免重复派生）；禁止 instanceof／符号判等（跨树双实例下静默失效，本层只
 *   消费字符串）；禁止以服务面对象的方法在场性作主判——服务对象是注入产物，
 *   替身与隔离组合不一定忠实于宿主版本，版本串是唯一权威。形态与服务面不一致
 *   时（理论上不出现在准入集合内）经既有失败通道如实暴露，本层不静默纠偏。
 * - 解析链与 `lib/agent.js` 顶层静态 import 同一部署解析（宿主 installation
 *   scope 路由）：主链 `import.meta.resolve`——与静态 import 同过 ESM 解析
 *   链（测试钩子与宿主装载器都作用于它），`createRequire().resolve` 仅作
 *   后备（它走 CJS 链，可能解析到另一棵树——真机实测曾见环境级 node_modules
 *   遮蔽装载器锚树，两链分歧正是 8.2 装置「解析链一致性」的核对点）；读到的
 *   就是静态导入绑定的同一棵树。
 * - 准入由 peer 声明承担（§7.4.6）：集合外宿主经 peer 拒载不会进入本判定，
 *   `flat` 对更高版本的全称性只是防御连续性，不构成对未来版本兼容的承诺。
 *
 * ## 失败形态
 *
 * 解析、读取或版本串解析失败 → `undefined`：`async_agent` 以
 * `error.hostContractUnknown` 明确拒绝（零派生，原按 6.3 进操作者日志）；等待
 * 侧目录查询对 `undefined` 归一为查询失败，沿 §2.1 既有口径交回——不猜形态、
 * 不静默选边。
 *
 * @module dsh-async-tools/host-contract
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 形态分界版本：小于此为嵌套形态，大于等于为扁平形态（§7.4.1）。 */
const FLAT_BOUNDARY = '0.2.2-rc.2';

/**
 * 最小 semver 比较器（§7.4.1：不引入 semver 依赖）。数值三元组先比，再比
 * 预发布标识符——无预发布大于有预发布；标识符逐段比较，数值段小于字母数字段，
 * 前缀相同段少者小。非版本串返回 NaN（调用方按解析失败处理）。
 * @param {string} a
 * @param {string} b
 * @returns {number} -1／0／1；任一不可解析时 NaN。
 */
export function compareVersions(a, b) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value).trim());
    if (match === null) return undefined;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] === undefined ? undefined : match[4].split('.')
    };
  };
  const left = parse(a);
  const right = parse(b);
  if (left === undefined || right === undefined) return Number.NaN;
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  }
  if (left.pre === undefined && right.pre === undefined) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  const len = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < len; i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1;
    } else if (ln !== rn) {
      return ln ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 从 `@deepseek-ai/dsh-subagent` 的根入口解析逐级上溯读包清单 version。
 * 只依赖「根入口」这一最稳定导出（与 tools/check-host-compat 既有解析形态
 * 一致），不因任何子路径导出的增删而碎。
 * @param {() => string|undefined} [resolveEntry] - 可注入的「已解析条目路径」
 *   提供函数（测试用；返回 `@deepseek-ai/dsh-subagent` 入口的本机路径或
 *   file:// URL，缺席/失败返回 undefined——注意它不是按 specifier 解析的
 *   require.resolve 形函数，而是直接给出条目路径；缺省走本模块的部署解析链）。
 * @returns {string|undefined} version 串；不可解析／不可读／无 version 时 undefined。
 */
export function resolveHostSubagentVersion(resolveEntry) {
  const entrySource = resolveEntry ?? (() => {
    // 主链：import.meta.resolve 与静态 import 同过 ESM 解析链（装载器钩子
    // 作用于此），保证「形态判定读到的树」与「静态导入绑定的树」一致；
    // createRequire 后备仅覆盖个别装载器禁用同步 resolve 的环境。
    try {
      return import.meta.resolve('@deepseek-ai/dsh-subagent');
    } catch {
      /* 落后备链 */
    }
    try {
      return createRequire(import.meta.url).resolve('@deepseek-ai/dsh-subagent');
    } catch {
      return undefined;
    }
  })();
  if (typeof entrySource !== 'string' || entrySource.length === 0) return undefined;
  // 解析产物兼容两种形态：createRequire().resolve 返回本机绝对路径；注入的
  // 测试替身可能给 file:// URL。统一成路径后再逐级上溯。
  const entryPath = entrySource.startsWith('file://')
    ? fileURLToPath(entrySource)
    : entrySource;
  let dir = dirname(entryPath);
  for (let i = 0; i < 16 && dir !== undefined; i += 1) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const version = JSON.parse(readFileSync(manifest, 'utf8'))?.version;
        return typeof version === 'string' && version.length > 0 ? version : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** 记忆化形态（含失败——宿主版本在插件进程生命周期内不可变，§7.4.1）。 */
let memoizedForm;

/**
 * 宿主子代理契约形态判定（§7.4.1）：`'nested'`｜`'flat'`｜`undefined`（未知）。
 * 模块实例内求值一次并记忆；测试经 `resetSubagentContractMemo()` 复位后可注入
 * 条目路径提供函数重判（生产路径不注入）。
 * @param {() => string|undefined} [resolveEntry] - 测试注入的「已解析条目路径」
 *   提供函数（语义同 resolveHostSubagentVersion 的注入参数）。
 * @returns {'nested'|'flat'|undefined}
 */
export function subagentContract(resolveEntry) {
  if (memoizedForm !== undefined) return memoizedForm.form;
  const version = resolveHostSubagentVersion(resolveEntry);
  const comparison = version === undefined ? Number.NaN : compareVersions(version, FLAT_BOUNDARY);
  const form = Number.isNaN(comparison) ? undefined : (comparison < 0 ? 'nested' : 'flat');
  memoizedForm = { form };
  return form;
}

/** 测试隔离：清除形态记忆（生产代码不调用）。 */
export function resetSubagentContractMemo() {
  memoizedForm = undefined;
}

/**
 * 创建分派（§7.4.2）：形态无关部件落成两形态各自的 startActivation spec。
 * 扁平形态把任务字段逐个置于顶层（`request` 键不出现）、合法 `name` 携带、
 * 省缺不传（宿主分配 agent-N）；嵌套形态维持 rc.1 原形状。形态未知时抛错——
 * 调用方（async_agent）应在更早处以 `error.hostContractUnknown` 明确拒绝，
 * 这里是防御层，不猜形态。
 * @param {object} ctx - cordis 上下文（`ctx.subagents.startActivation`）。
 * @param {object} parts - 形态无关部件：`{ provider, label, signal, delivery,
 *   request, name? }`（request 含 prompt／parent／cwd／agentPreset／agentOptions／
 *   maxDepth）。
 * @returns {Promise<object>} 宿主回执（`childId`／`messageId?`／`result`／
 *   `dispose`；扁平形态另含 `name`），原样返回。
 */
export function startActivation(ctx, parts) {
  const { provider, label, signal, delivery, request, name } = parts;
  const form = subagentContract();
  if (form === 'nested') {
    return ctx.subagents.startActivation({ provider, label, request, signal, delivery });
  }
  if (form === 'flat') {
    const spec = {
      provider,
      label,
      ...request,
      ...(name === undefined ? {} : { name }),
      signal,
      delivery
    };
    return ctx.subagents.startActivation(spec);
  }
  throw new Error('host subagent contract form unknown');
}

/**
 * 直接子列举分派（§7.4.2）：嵌套形态 `listChildren` 原样；扁平形态
 * `listDescendants` 后过滤 `depth === 1`——第一层诊断行保留（不可读目录的
 * 说明仍进纠错清单），更深的行与诊断一律丢弃。形态未知时抛错——沿 §2.1
 * 既有查询失败口径交回（async 函数内同步 throw 即拒绝），不猜形态。同步
 * throw 与异步 reject 同径（RA-SYNC-LISTING-GUARD 的 Promise 工厂归一）。
 * @param {object} ctx - cordis 上下文（`ctx.subagents`）。
 * @param {unknown} owner - 主体（宿主会话标识）。
 * @param {AbortSignal} [signal]
 * @returns {Promise<object[]|undefined>} 直接子行集；查询失败由调用方口径承接。
 */
export async function listDirectChildren(ctx, owner, signal) {
  const form = subagentContract();
  if (form === 'nested') {
    return await ctx.subagents.listChildren(owner, signal);
  }
  if (form === 'flat') {
    const entries = await ctx.subagents.listDescendants(owner, signal);
    if (!Array.isArray(entries)) return entries;
    // depth===1 过滤：诊断行同深度保留（design 7.4.2 裁定——诊断行不算命中，
    // 但照常以 reason 展示进纠错清单）；更深的行与诊断零泄漏。
    return entries.filter((entry) => entry?.depth === 1);
  }
  throw new Error('host subagent contract form unknown');
}
