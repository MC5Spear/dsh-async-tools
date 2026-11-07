/**
 * 活体验证实例的 RPC 通道（供 `verify/` 下的真机探针复用）。
 *
 * 信封协议：token 换 cookie，POST `/api/<method>`，body 是
 * `{ type: "client-request", rpcId, method, payload: { args } }`。
 *
 * ## 实例坐标不在代码里
 *
 * 基址与令牌文件的路径都是**本机事实**，所以它们经 `tools/_local-config.mjs` 从
 * 本机侧读（`.local/config.mjs`，或环境变量 `DSAT_INSTANCE_URL` / `DSAT_TOKEN_FILE`）。
 * 写死路径（含从本文件位置推算服务家目录的写法）只在"仓库与服务目录是兄弟"
 * 这一台机器上成立；换个目录布局就解析到不存在的路径，而报错会指向 `ENOENT`
 * 而不是"你的坐标没配置"。
 *
 * 本机环境缺席（CI、外部 clone）时本模块打印一行 `SKIP …` 并以 0 退出——这类判据只对
 * 开发机上的活体实例有意义，缺席不是失败，但必须留痕。
 *
 * @module verify/_rpc
 */
import { instanceCredentials, loadLocalPlaneOrSkip, tokenEntryUrl } from '../tools/_local-config.mjs';

const config = await loadLocalPlaneOrSkip('verify/_rpc.mjs（活体实例 RPC 通道）');
const { base: BASE, token } = instanceCredentials(config);

// 认证首跳与 API 调用统一 redirect:'manual'：认证 RPC 不应被重定向携带凭据跳转，
// 3xx 一律按错误处理（见 assertNotRedirected）。
const indexResponse = await fetch(tokenEntryUrl(BASE, token), { redirect: 'manual' });
assertNotRedirected(indexResponse, 'token exchange');
const cookie = (indexResponse.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
if (cookie.length === 0) throw new Error('token exchange returned no cookie');

/**
 * 拒绝重定向响应：认证请求被 3xx 携带凭据跳转是错误，不跟随。
 *
 * @param {Response} response - fetch 结果。
 * @param {string} what - 报错时指名哪一步。
 */
function assertNotRedirected(response, what) {
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${what}：收到 ${String(response.status)} 重定向（Location=${String(response.headers.get('location'))}）`
      + '——认证 RPC 不跟随重定向，请核对实例地址；这按错误处理。');
  }
}

/**
 * 可自动重试的方法（只读、无副作用——重发只是再问一遍）。
 * 其余方法（`session/create`、`session/prompt`、`settings/*`、`commands/execute`、
 * `job/kill` 等非幂等写）**不自动重发**：fetch 拒绝只说明响应没回来，不说明请求
 * 没被执行；盲目重发可能造成第二次执行。
 */
const RETRYABLE_METHODS = new Set(['session/list', 'session/page', 'settings/describe']);

/**
 * 调一个网关方法。
 *
 * 重试范围按方法分级：只有 `RETRYABLE_METHODS` 里的只读方法在任意 fetch 拒绝时
 * 重试一次（长时间运行的探针会经历浏览器阶段的长时间隙，服务端在此期间关闭空闲
 * keep-alive 连接，undici 复用旧连接就会撞上一次随机 fetch failed；重试发起新连接
 * 即成）。写方法不自动重发，失败显式报错并说明「响应丢失不等于未执行」。
 * @param {string} endpoint - 方法名（如 `session/list`）。
 * @param {object} args - 参数。
 * @returns {Promise<object>} `result.value`。
 */
export async function rpc(endpoint, args) {
  const rpcId = `probe-${Math.random().toString(36).slice(2, 10)}`;
  const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } });
  const once = () => fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body,
    redirect: 'manual'
  });
  let response;
  try {
    response = await once();
  } catch (connError) {
    if (!RETRYABLE_METHODS.has(endpoint)) {
      throw new Error(`${endpoint}：请求未获响应（${String(connError instanceof Error ? connError.message : connError)}）。`
        + '响应丢失不等于未执行——本方法不是只读方法，不自动重发；'
        + '请按方法语义核对实例侧实际状态后再决定是否重试。');
    }
    response = await once();
  }
  assertNotRedirected(response, endpoint);
  const text = await response.text();
  const parsed = JSON.parse(text);
  if (parsed?.result?.ok !== true) {
    throw new Error(`${endpoint}: ${JSON.stringify(parsed?.result?.error ?? text.slice(0, 200))}`);
  }
  return parsed.result.value;
}

/** 读一个会话的清单行。 */
export async function rowOf(sessionId) {
  const listing = await rpc('session/list', { _request: {} });
  const row = listing.items.find((item) => item.sessionId === sessionId);
  if (row === undefined) throw new Error(`session ${sessionId} not found`);
  return row;
}

/** 读一个会话的完整转录。 */
export async function transcriptOf(sessionId) {
  const row = await rowOf(sessionId);
  return rpc('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 400 }
  });
}

/**
 * 本机配置（探针还要用它取证据落点与工作目录）。
 *
 * 从本模块再导出，是为了让探针**只 import 一处**就拿到实例坐标——两处 import
 * 迟早会漂。
 */
export { config as localConfig };
