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
import { instanceCredentials, loadLocalPlaneOrSkip } from '../tools/_local-config.mjs';

const config = await loadLocalPlaneOrSkip('verify/_rpc.mjs（活体实例 RPC 通道）');
const { base: BASE, token } = instanceCredentials(config);

const indexResponse = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' });
const cookie = (indexResponse.headers.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
if (cookie.length === 0) throw new Error('token exchange returned no cookie');

/**
 * 调一个网关方法。
 *
 * 重试范围是**任意 fetch 拒绝、任意方法各重试一次**（不只连接级失败）：长时间
 * 运行的探针会经历浏览器阶段的长时间隙，服务端在此期间关闭空闲 keep-alive
 * 连接，undici 复用旧连接就会撞上一次随机 fetch failed。重试发起新连接即成。
 *
 * 重试的副作用要如实说：**fetch 拒绝≠请求未到达**——服务端可能已执行、只是
 * 响应没回来，重试就是**同一请求再发一次**。各方法的重复后果：
 * - 读取类（session/list 等）：无副作用；
 * - `settings/*` 幂等（同值再写一次无害）；
 * - `session/new`：可能多出一个孤儿会话——探针本来就留会话，可接受；
 * - 其余写入类（会话内发词、取消等）：重试可能造成**第二次执行**，本文件的使用
 *   方（探针）要么容忍重复（判据按最终转录收敛），要么在调用点自行去重——需要
 *   严格一次性的请求不该走这里的盲目重试。
 * @param {string} endpoint - 方法名（如 `session/list`）。
 * @param {object} args - 参数。
 * @returns {Promise<object>} `result.value`。
 */
export async function rpc(endpoint, args) {
  const rpcId = `probe-${Math.random().toString(36).slice(2, 10)}`;
  const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } });
  let response;
  try {
    response = await fetch(`${BASE}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body
    });
  } catch (connError) {
    await fetch(`${BASE}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body
    }).then((retry) => { response = retry; }, (retryError) => { throw retryError; });
    void connError;
  }
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
