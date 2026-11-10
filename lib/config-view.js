/**
 * 配置视图：把"每次现取"的配置包成一个可像普通对象一样读的东西。
 *
 * 为什么需要它：工具代码按普通属性读配置（如 `config.minWaitMs`），而需求 §5.1
 * 要求这些值在**调用时**取（设置改了要立刻生效）。Proxy 把属性读取转发到实时
 * 配置，两个要求同时成立。
 *
 * @param {() => object} getConfig - 返回当前生效配置的函数。
 * @returns {object} 行为等价的只读视图。
 */
export function makeConfigView(getConfig) {
  return new Proxy({}, {
    get(_target, key) {
      return getConfig()[key];
    },
    // 视图是只读的：写进去不会改配置。报错文本用英文——Proxy 陷阱抛出的
    // TypeError 不是模型可见文案（`agentLang` 管不到），真实到达者是误写视图的
    // 本包代码或测试（生产路径只读配置视图），沿用宿主 TypeError 的英文惯例；
    // 需求 §5.3 的双语要求覆盖模型可见文案，不覆盖这类编程缺陷信号。
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
