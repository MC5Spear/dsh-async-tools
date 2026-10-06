/**
 * 预算上界与跨字段配对的常量单一来源（R29-d，design §31.4）。
 *
 * 为什么单独一个文件：`lib/config.js` 的 `.max()` 接线（服务侧，schemastery）与
 * 设置卡片的草稿校验（`client.js`，CJS 包裹、客户端模块图只投递平名包——**引不到
 * 本文件**）都要用同一组数值。服务侧从这里 import；客户端侧内联同一组字面并在
 * `test/two-planes.test.mjs`（T23c）里做对账断言（两处相等，漂移必红）。改值时
 * 两处一起改，对账测试会拦住只改一处的手滑。
 *
 * 数值依据：2147483647 = 2^31-1——`setTimeout` 延迟越过它会被置 1ms 立即触发，
 * 所以一切进定时器路径的毫秒字段都封这个上界；`maxResultChars` 封
 * 1000000，与 `outputLimitBytes = maxResultChars × 3`（`lib/jobs.js`）联动，环形
 * 缓冲上界 3MB/作业。
 */

/** 一切毫秒预算字段的共同上界（2^31-1）。 */
export const MS_FIELD_LIMIT = 2147483647;

/** `maxResultChars` 的上界（与 outputLimitBytes 三倍换算联动）。 */
export const RESULT_CHARS_LIMIT = 1000000;

/** `askTimeoutMs` 的上界（§32.1/R30：提问接管窗口最长 10 分钟，与等待字段量级一致）。 */
export const ASK_TIMEOUT_LIMIT = 600000;

/** 字段 → 上界。键集必须与 `lib/config.js` 的 BUDGET_FIELD_KEYS + ASK_FIELD_KEYS 一致（测试对账）。 */
export const FIELD_MAX = Object.freeze({
  defaultYieldMs: MS_FIELD_LIMIT,
  minYieldMs: MS_FIELD_LIMIT,
  maxYieldMs: MS_FIELD_LIMIT,
  defaultWaitMs: MS_FIELD_LIMIT,
  minWaitMs: MS_FIELD_LIMIT,
  maxWaitMs: MS_FIELD_LIMIT,
  pollIntervalMs: MS_FIELD_LIMIT,
  maxResultChars: RESULT_CHARS_LIMIT,
  askTimeoutMs: ASK_TIMEOUT_LIMIT
});

/**
 * 跨字段有序配对：每对 `[minKey, maxKey]` 要求 `config[minKey] <= config[maxKey]`。
 * 第三对是 R29 新增（`pollIntervalMs` 不得大于 `maxWaitMs`——轮询间隔比整个等待
 * 预算还长没有意义，且会放大屏障窗口）。消费方：`lib/config.js` 的
 * `assertCrossFieldOrder` 与设置卡片的配对草稿校验。
 */
export const ORDERED_PAIRS = Object.freeze([
  Object.freeze(['minYieldMs', 'maxYieldMs']),
  Object.freeze(['minWaitMs', 'maxWaitMs']),
  Object.freeze(['pollIntervalMs', 'maxWaitMs'])
]);
