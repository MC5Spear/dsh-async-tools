/**
 * 工具行登记簿（设计 §3.7 目标判定身份段的比对依据）。
 *
 * 模块级 WeakMap：工具对象 → 装载该工具的行的配置视图。插件入口在每行
 * `ctx.tools.register(tool)` 成功后登记；行卸载后工具对象不可达，登记随之
 * 消失，无须显式清理。
 *
 * 查询工具（`lib/list-models.js`）以 `tools.get(name, scope)` 取调用方作用域
 * 该名可见的工具定义，再与登记簿按对象同一性比对：命中＝该作用域实际可见的
 * 定义正是本包创建行注册的那个，同时取得**创建行**的配置视图——目标后端段读
 * 它的 `subagentProvider`，不用查询行自己的配置冒充。未命中＝同名外来登记或
 * 被遮蔽；查询行与创建行不在同一模块实例（如重复安装）时登记簿必然查不到，
 * 两种形态都按「适用性未确认」报告，不读策略与后端、不生成示例。
 *
 * 对象同一性判别的静态依据：目标版本 `0.2.1-rc.2` 的 `@deepseek-ai/dsh-tools`
 * 公开 `get(name, scope)`（返回该作用域解析到的定义对象）与
 * `@deepseek-ai/dsh-scope` 的按引用保存（"Values are borrowed"）。
 *
 * @module dsh-async-tools/lib/tool-rows
 */

/** 工具对象 → 该行配置视图（弱引用：行卸载后对象不可达即消失）。 */
const rowConfigs = new WeakMap();

/**
 * 登记一个工具行的工具对象与其配置视图（入口 `applyWith` 在
 * `ctx.tools.register(tool)` 成功后调用）。
 * @param {object} tool - 注册进工具表的工具定义对象。
 * @param {object} configView - 该行的生效配置视图。
 * @returns {void}
 */
export function registerToolRow(tool, configView) {
  rowConfigs.set(tool, configView);
}

/**
 * 按工具对象取它的行配置视图。
 * @param {object} tool - `tools.get(name, scope)` 返回的可见工具定义。
 * @returns {object|undefined} 该行的配置视图；非本模块实例登记的工具为 undefined。
 */
export function rowConfigOf(tool) {
  return rowConfigs.get(tool);
}
