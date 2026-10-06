/**
 * 活体验证实例的 RPC 通道（供 `verify/` 下的真机探针复用）。
 *
 * 信封协议：token 换 cookie，POST `/api/<method>`，body 是
 * `{ type: "client-request", rpcId, method, payload: { args } }`。
 *
 * ## 实例坐标不在代码里
 *
 * 基址与令牌文件的路径都是**本机事实**，所以它们经 `tools/_local-config.mjs` 从
 * 本机平面读（`.local/config.mjs`，或环境变量 `DSAT_INSTANCE_URL` / `DSAT_TOKEN_FILE`）。
 *
 * 在本模块之前，这两件事是"从本文件位置往上两级推算服务家目录"，外加一个写死的端口。
 * 那个写法只在"仓库与服务目录是兄弟"这一台机器上成立；换个目录布局就解析到不存在的
 * 路径，而报错会指向 `ENOENT` 而不是"你的坐标没配置"。
 *
 * 本机平面缺席（CI、外部 clone）时本模块打印一行 `SKIP …` 并以 0 退出——这类判据只对
 * 开发机上的活体实例有意义，缺席不是失败，但必须留痕。
 *
 * @module verify/_rpc
 */
import { instanceCredentials, loadLocalPlaneOrSkip } from '../tools/_local-config.mjs';

const config = await loadLocalPlaneOrSkip('verify/_rpc.mjs（活体实例 RPC 通道）');
const { base: BASE, token } = instanceCredentials(config);

const indexResponse = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' });
const cookie = (indexResponse.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
if (cookie.length === 0) throw new Error('token exchange returned no cookie');

/**
 * 调一个网关方法。
 * @param {string} endpoint - 方法名（如 `session/list`）。
 * @param {object} args - 参数。
 * @returns {Promise<object>} `result.value`。
 */
export async function rpc(endpoint, args) {
  const rpcId = `probe-${Math.random().toString(36).slice(2, 10)}`;
  const response = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } })
  });
  const text = await response.text();
  const body = JSON.parse(text);
  if (body?.result?.ok !== true) {
    throw new Error(`${endpoint}: ${JSON.stringify(body?.result?.error ?? text.slice(0, 200))}`);
  }
  return body.result.value;
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
