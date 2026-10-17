/**
 * 宿主锚守卫：离线自跳过契约的唯一来源（ci.yml offline 作业的防线兑现）。
 *
 * ## 这层守卫在挡什么
 *
 * 本包九个 `@deepseek-ai/dsh*` 是 peer，离线安装形态（`--legacy-peer-deps`）下
 * 它们缺席；`lib/` 的宿主链模块（jobs、workflow、wait-job、wait-agent、
 * agent、host、index 等）顶层静态 import 这些包，缺席时加载即
 * `ERR_MODULE_NOT_FOUND`。契约：需要宿主锚的用例
 * 在锚缺席时**自跳过并打印理由**，而不是整片测试文件崩掉——离线形态的读数是
 * `pass + skip` 等于用例总数，`fail = 0`。
 *
 * ## 防假跳过（判据只认解析事实）
 *
 * `loadOfflineSafe` 只吞一种错误：`ERR_MODULE_NOT_FOUND` 且报错文本含
 * `@deepseek-ai/`（peer 说明符不可解析）。语法错误、模块内部抛错原样上抛；
 * 错版本的宿主包可以解析——用例照常真跑，行为断言负责红。跳过判定不读
 * 环境名、CI 变量或机器名。宿主锚在场时（`npm run test:inproc`）全部用例
 * 透传注册、零跳过——这是防假跳过的反证判据。
 *
 * ## 用法
 *
 * ```js
 * import { hostTestFor, loadOfflineSafe } from './_host-gate.mjs';
 * const jobsModule = await loadOfflineSafe('../lib/jobs.js');
 * const { createRunTool: buildRunTool } = jobsModule ?? {};
 * const hostTest = await hostTestFor('../lib/jobs.js');
 * // 正文需要宿主锚的用例：test( → hostTest(；锚在场时与 test 完全同形（断言不放宽）。
 * ```
 *
 * 无法用 import 说明符探测缺席的场景（如 preset.test 的宿主 js-yaml 候选路径
 * 探测）用 `hostTestByProbe(absent)` 复用同一包装与文案。
 *
 * @module dsh-async-tools/test/_host-gate
 */
import { test } from 'node:test';

/** skip 理由唯一来源；全部跳过点必须用它，验证按此常量核对（无匿名跳过）。 */
export const HOST_SKIP_REASON = '宿主包不可解析（离线环境），本用例跳过';

/**
 * 动态 import；仅宿主包不可解析时返回 `undefined`，其余错误原样抛。
 * @param {string} specifier - 模块说明符（相对说明符以调用文件为解析基准）。
 * @returns {Promise<object | undefined>} 模块；宿主包不可解析时为 `undefined`。
 */
export async function loadOfflineSafe(specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && message.includes('@deepseek-ai/')) return undefined;
    throw error;
  }
}

/**
 * 探测一组宿主链模块，返回 test 包装：全部在场 → 与 node:test 的 test 同形
 * （断言不放宽）；任一缺席 → 注册即 `t.skip(HOST_SKIP_REASON)`。
 * 只支持 `(name, fn)` 两参调用（本仓用例无 options 形态；带 options 的
 * 新用例会以可见的参数错暴露，不静默假绿）。
 * @param {...string} specifiers - 宿主链模块说明符。
 * @returns {Promise<(name: string, fn: Function) => void>} test 包装。
 */
export async function hostTestFor(...specifiers) {
  const modules = await Promise.all(specifiers.map(loadOfflineSafe));
  return hostTestByProbe(modules.some((module) => module === undefined));
}

/**
 * 入参为「宿主锚缺席」探测结果的 test 包装（与 `hostTestFor` 同形同文案），
 * 供无法用 import 说明符探测的文件复用；同样只支持 `(name, fn)` 两参调用。
 * @param {boolean} absent - 宿主锚是否缺席。
 * @returns {Promise<(name: string, fn: Function) => void>} test 包装。
 */
export async function hostTestByProbe(absent) {
  return absent
    ? (name, _fn) => test(name, (t) => { t.skip(HOST_SKIP_REASON); })
    : (name, fn) => test(name, fn);
}
