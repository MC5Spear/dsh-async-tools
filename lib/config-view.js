/**
 * 配置视图：把"每次现取"的配置包成一个可像普通对象一样读的东西。
 *
 * 为什么需要它：工具的代码通篇写 `config.minWaitMs`，而需求 §5.1 要求这些值在**调用时**
 * 取（设置改了要立刻生效）。用 Proxy 让属性读取转发到实时配置上，工具代码一行都不用改，
 * 也不用担心漏改某处——漏改一处就是"某个参数不跟着设置走"。
 *
 * @param {() => object} getConfig - 返回当前生效配置的函数。
 * @returns {object} 行为等价的只读视图。
 */
export function makeConfigView(getConfig) {
  return new Proxy({}, {
    get(_target, key) {
      return getConfig()[key];
    },
    // 视图是只读的：写进去会让人以为改了配置，而实际上什么都没发生。
    // 报错文本用英文，依据不是「错误属模型文案」：`agentLang` 管不到 Proxy
    // 陷阱抛出的 TypeError，这也不是操作者日志。它是防御性护栏，真实到达者
    // 是误写视图的本包代码或测试（生产路径只读配置视图），沿用宿主 TypeError
    // 的英文惯例即可；需求 §5.3 的双语要求覆盖的是模型可见文案，不覆盖这类
    // 编程缺陷信号。
    set() {
      throw new TypeError('async-tools: the config view is read-only; change settings via the plugin settings page');
    },
    has(_target, key) {
      return key in getConfig();
    },
    ownKeys() {
      return Reflect.ownKeys(getConfig());
    },
    getOwnPropertyDescriptor(_target, key) {
      const value = getConfig()[key];
      if (value === undefined) return undefined;
      return { value, enumerable: true, writable: false, configurable: true };
    }
  });
}
