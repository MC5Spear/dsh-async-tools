/**
 * 跨两层的刷新通知（信号源：`'loader/volatile-update'`，设计 §5.1）。
 *
 * ## 为什么需要它（以及为什么不能靠"值本身是活的"）
 *
 * 取值**行为**已经是活的：预设层的工具持有 `makeConfigView(() => getConfig())`，
 * 每次 `execute` 都现读模块级快照（`lib/settings.js` 的 `readSnapshot()`），所以
 * "改设置后夹紧、截断真的变了"天然成立。
 *
 * **但描述字符串是另一条路**：`defineTool` 在构造时把 `description` 求值成字符串
 * （`dsh-tools/lib/index.js:851`），所以它不会自己变。刷新它需要一个"设置变了"的通知，
 * 而这个通知只有**宿主行的 fiber** 收得到：loader 的 volatile 就地提交只向**拥有该
 * fiber** 的上下文派发 `'loader/volatile-update'`（`cordis-plugin-loader/lib/index.js:393-425`；
 * 本包不做命名空间注册，不走 `scope.watch` 通道）。宿主行
 * 收到后在 `lib/settings.js` 里重播快照并调用本模块的 `notifySettingsChanged`。
 *
 * ## 为什么要模块级登记表
 *
 * 两层是**两次装载**：宿主行走 `dsh.profile.bundles`，工具行在预设子树里。
 * 宿主那一次拿不到预设那一次的 `tool` 对象，预设那一次也收不到 volatile 事件。
 * 它们能共享的东西只有**同一次进程内的模块实例**——两个入口最终都解析到本包的
 * 同一个文件，所以模块级登记表是通的。
 *
 * 登记表只存回调，不存工具对象，也不跨进程；每次装载登记一次、卸载时注销
 * （由调用方的 `ctx.effect` 保证），因此不会随会话数增长。
 *
 * @module dsh-async-tools/lib/refresh-bus
 */

/** 当前已装载的预设工具刷新回调。 */
const listeners = new Set();

/**
 * 本模块实例的标识（诊断用）。
 *
 * ## 为什么需要它
 *
 * 这套转达的**成立前提**是"两层解析到同一个模块实例"。实测证明这个前提会破：
 * 宿主包按自己的 `node_modules` 解析 `dsh-async-tools`，预设行按 profile 的
 * `node_modules` 解析同名包——**同一个包经两条不同路径进入 ESM 图，就是两个模块实例、
 * 两张登记表**。此时宿主那一次 `notifySettingsChanged` 遍历的是一张**空表**：
 * 不报错、不抛异常、`await` 也没有任何异常可捕，只是**什么也没发生**。
 *
 * 有了这个标识，日志里两层各报一次自己的 ID，**一致 = 同实例、不一致 = 断链**，
 * 不需要靠推理。诊断时把 `DSH_ASYNC_BUS_DIAG=1` 打开即可。
 */
const BUS_ID = Math.random().toString(36).slice(2, 8);

/** 诊断开关：设 `DSH_ASYNC_BUS_DIAG=1` 时把总线事件写到 stderr。 */
function diag(line) {
  if (process.env.DSH_ASYNC_BUS_DIAG !== '1') return;
  process.stderr.write(`[async-tools] [bus ${BUS_ID}] ${line}\n`);
}

/**
 * 登记一个"设置变了，请刷新你的描述"回调。
 *
 * @param {() => void} listener - 刷新回调。
 * @returns {() => void} 注销函数（调用方必须把它挂到 `ctx.effect` 上）。
 */
export function onSettingsChanged(listener) {
  listeners.add(listener);
  diag(`登记监听器，本实例现有 ${String(listeners.size)} 个`);
  return () => {
    listeners.delete(listener);
    diag(`注销监听器，本实例现有 ${String(listeners.size)} 个`);
  };
}

/**
 * 通知所有已登记的预设工具刷新描述。
 *
 * 单个回调抛错**不得**影响其他回调，也不得冒泡到 `dsh-settings` 的 watch 里
 * （那会污染设置服务自身的状态机）。
 *
 * @param {object} [logger] - 可选日志器，用于记录失败。
 */
export function notifySettingsChanged(logger) {
  diag(`广播设置变更，本实例有 ${String(listeners.size)} 个监听器`);
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      logger?.warn?.(
        `[async-tools] 刷新工具描述失败（设置已生效，只是描述可能仍是旧数字）：`
        + `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/** 供测试使用：当前登记的回调数。 */
export function listenerCount() {
  return listeners.size;
}
