/**
 * 认证首跳与 API 重定向的共享判定（`verify/` 真机探针复用；纯函数，无本机副作用）。
 *
 * 背景（VERIFY-AUTH-REDIRECT-COMPAT）：dsh `0.2.1-rc.5` 实测的正常认证首跳是
 * `303`＋一个 `Set-Cookie`＋同源相对 `Location: ./`——cookie 交换在首跳完成，
 * 不需要也不应该向 Location 发第二个请求。早先把「一切 3xx 都按错误」的检查放在
 * 读 `Set-Cookie` 之前，会把这台宿主的正常首跳整个拒掉，所有真机探针起不来。
 *
 * 两类判定各自固定：
 *
 * - **认证首跳**（token 换 cookie，用 {@link authCookieFromFirstHop}）：3xx 仅在
 *   「Location 缺席，或解析后与基址同源（相对或同源绝对）」时按正常交换接受，
 *   且必须携带至少一个 `Set-Cookie`；跨源 `Location`、无 cookie 都按错误处理。
 *   任何形态都不跟随 Location——cookie 消费完即止，不发第二个请求。
 * - **API 调用**（用 {@link assertApiNotRedirected}）：任何 3xx 都按错误处理；
 *   API 响应被重定向不属于正常形态，凭据不随跳转重发。
 *
 * @module verify/_auth
 */

/**
 * 判断 Location 是否与基址同源（缺席／空＝无跳转目标，按同源口径处理）。
 *
 * @param {string|null} location - Location 头（可能缺席）。
 * @param {string} base - 实例基址。
 * @returns {boolean} 同源（或无目标）为 true；跨源或不可解析为 false。
 */
function sameOriginLocation(location, base) {
  if (location === null || location === undefined || location === '') return true;
  let resolved;
  try {
    resolved = new URL(location, base);
  } catch {
    return false;
  }
  try {
    return resolved.origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * 认证首跳判定：接受正常的 cookie 交换（含 303＋Set-Cookie＋同源 Location 形态），
 * 返回拼好的 cookie 头；不正常形态（跨源 Location、无 cookie）抛错。
 *
 * @param {Response} response - 首跳 fetch 结果（`redirect:'manual'`）。
 * @param {string} base - 实例基址（同源判定基准）。
 * @param {string} [what] - 报错时指名哪一步。
 * @returns {string} cookie 头串（`k1=v1; k2=v2`）。
 */
export function authCookieFromFirstHop(response, base, what = 'token exchange') {
  const status = Number(response?.status ?? 0);
  const location = response?.headers?.get?.('location') ?? null;
  if (status >= 300 && status < 400 && !sameOriginLocation(location, base)) {
    throw new Error(`${what}：收到 ${String(status)} 重定向且 Location 非同源（${String(location)}）`
      + '——认证首跳不接受跨源跳转目标，按错误处理。');
  }
  // 3xx＋同源（或缺席）Location：正常 cookie 交换形态，不跟随 Location；
  // 非 3xx：直接落到 cookie 读取（200＋Set-Cookie 同样是已观察到的合法形态）。
  const cookie = (response?.headers?.getSetCookie?.() ?? []).map((e) => e.split(';', 1)[0]).join('; ');
  if (cookie.length === 0) throw new Error(`${what} returned no cookie`);
  return cookie;
}

/**
 * 拒绝 API 重定向响应：API 调用被 3xx 是错误，不跟随、不带凭据重发。
 *
 * @param {Response} response - fetch 结果。
 * @param {string} what - 报错时指名哪一步。
 */
export function assertApiNotRedirected(response, what) {
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${what}：收到 ${String(response.status)} 重定向（Location=${String(response.headers.get('location'))}）`
      + '——API 调用不跟随重定向，按错误处理。');
  }
}
