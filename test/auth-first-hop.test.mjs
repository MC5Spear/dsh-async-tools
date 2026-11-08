import { test } from 'node:test';
import assert from 'node:assert/strict';

// 认证首跳与 API 重定向的共享判定（VERIFY-AUTH-REDIRECT-COMPAT 修复的判据面）：
// 正常首跳＝303＋Set-Cookie＋同源/缺席 Location（rc.5 实测形态，不跟随 Location，
// cookie 在首跳完成）；跨源 Location、无 cookie 的 3xx 按错误处理；API 的任何
// 3xx 一律按错误处理。这里全部用受控 Response 替身，离线可跑。
import { authCookieFromFirstHop, assertApiNotRedirected } from '../verify/_auth.mjs';

const BASE = 'http://127.0.0.1:59530';

/**
 * 构造最小 Response 替身：只实现两个判定用到的读取（location 头与 Set-Cookie 列表）。
 *
 * @param {number} status - 状态码。
 * @param {object} [options]
 * @param {string|null} [options.location] - Location 头（null＝缺席）。
 * @param {string[]} [options.setCookie] - Set-Cookie 原始行列表。
 * @returns {object} Response 替身。
 */
function fakeResponse(status, { location = null, setCookie = [] } = {}) {
  return {
    status,
    headers: {
      get: (name) => (name.toLowerCase() === 'location' ? location : null),
      getSetCookie: () => setCookie
    }
  };
}

test('认证首跳：303＋Set-Cookie＋相对 Location "./"（rc.5 实测正常形态）放行并返回 cookie', () => {
  const cookie = authCookieFromFirstHop(
    fakeResponse(303, { location: './', setCookie: ['sid=abc; Path=/; HttpOnly'] }),
    BASE
  );
  assert.equal(cookie, 'sid=abc');
});

test('认证首跳：303＋Set-Cookie＋Location 缺席也放行（无跳转目标不是跨源）', () => {
  assert.equal(
    authCookieFromFirstHop(fakeResponse(303, { setCookie: ['sid=abc'] }), BASE),
    'sid=abc'
  );
});

test('认证首跳：303＋Set-Cookie＋同源绝对 Location 放行', () => {
  assert.equal(
    authCookieFromFirstHop(
      fakeResponse(303, { location: `${BASE}/`, setCookie: ['sid=abc'] }),
      BASE
    ),
    'sid=abc'
  );
});

test('认证首跳：多个 Set-Cookie 全部并入 cookie 头', () => {
  assert.equal(
    authCookieFromFirstHop(
      fakeResponse(303, { location: './', setCookie: ['sid=abc; HttpOnly', 'cfg=1'] }),
      BASE
    ),
    'sid=abc; cfg=1'
  );
});

test('认证首跳：303＋跨源 Location 拒绝（即使带了 cookie，也不接受跨源跳转目标）', () => {
  assert.throws(
    () => authCookieFromFirstHop(
      fakeResponse(303, { location: 'https://collector.invalid/x', setCookie: ['sid=abc'] }),
      BASE
    ),
    /非同源/
  );
});

test('认证首跳：303＋无 Set-Cookie 拒绝（没有 cookie 可消费不是正常交换）', () => {
  assert.throws(
    () => authCookieFromFirstHop(fakeResponse(303, { location: './' }), BASE),
    /no cookie/
  );
});

test('认证首跳：200＋Set-Cookie 放行（非重定向的合法首跳形态）', () => {
  assert.equal(
    authCookieFromFirstHop(fakeResponse(200, { setCookie: ['sid=abc'] }), BASE),
    'sid=abc'
  );
});

test('认证首跳：200＋无 Set-Cookie 按无 cookie 报错', () => {
  assert.throws(
    () => authCookieFromFirstHop(fakeResponse(200, {}), BASE),
    /no cookie/
  );
});

test('API 判定：任何 3xx 都按错误处理（不跟随、不携带凭据重发）', () => {
  assert.throws(
    () => assertApiNotRedirected(fakeResponse(303, { location: './' }), 'session/list'),
    /session\/list.*303/s
  );
  assert.throws(
    () => assertApiNotRedirected(fakeResponse(307, { location: 'https://elsewhere.invalid' }), 'settings/update'),
    /settings\/update.*307/s
  );
});

test('API 判定：非 3xx 不抛', () => {
  assert.doesNotThrow(() => assertApiNotRedirected(fakeResponse(200, {}), 'session/list'));
  assert.doesNotThrow(() => assertApiNotRedirected(fakeResponse(404, {}), 'session/list'));
});
