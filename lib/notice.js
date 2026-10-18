/**
 * stderr 审计出口（生命周期诊断的最小出口件，设计 §6.3）。
 *
 * ## 它是什么、还剩什么职责
 *
 * 预设行生命周期由 loader 拥有（补丁在，预设就在），本包不设生命周期机制；
 * 这个**出口函数**的消费方按真实调用点列：`lib/index.js`（设置接线异常播报）、
 * `lib/settings.js`（非法持久化忽略与 volatile 提交失败两处）、`lib/agent-policy.js`
 * （模型选择服务缺席/`sessions` 缺席通告两处）、`lib/agent.js`（result 观察通道
 * 非完成结局与拒绝两分支诊断），外加各测试的出口注入。
 *
 * ## 为什么必须是 stderr
 *
 * cordis 的 logger 只注册了"把消息推进内存环形缓冲"的 exporter（`bufferSize = 1000`，
 * 超出截尾），dsh-base / dsh-web-app 都不挂 stdout / 文件出口——只走 logger
 * 等于什么都没说。而：
 * - **`dsh web` 部署形态下**：该形态的服务脚本把带令牌的 URL 重定向进 stdout
 *   指向的令牌文件，审计写 stdout 会污染它（这是该部署的条件事实，不是
 *   stdout 的普遍属性）；
 * - stderr 是**既有插件的审计落点**，不引入新约定。
 *
 * ## 为什么做成可注入
 *
 * 直接调 `process.stderr.write` 会让**每条用例都往测试输出里写噪声**，而噪声会淹没
 * 真正的失败。生产路径不传第二个参数，走默认的 `process.stderr`；测试传一个收集
 * 数组进去断言"确实写了"。
 *
 * 文案保持**中文**：这些是操作者一侧文本，不进模型上下文（设计 §6.3 的口径）。
 *
 * @module dsh-async-tools/lib/notice
 */

/**
 * 把一行审计结论写到 stderr（或注入的出口）。
 * @param {string} line - 一行结论（不含换行）。
 * @param {(line: string) => void} [sink] - 可注入的输出出口；默认写 `process.stderr`。
 * @returns {void}
 */
export function emitLifecycleNotice(line, sink) {
  if (typeof sink === 'function') {
    sink(`${line}\n`);
    return;
  }
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // stderr 都写不了就只能放弃——调用方保证本函数不抛（不因播报失败打掉插件行）。
  }
}
