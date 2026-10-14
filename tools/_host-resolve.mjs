/**
 * 开发期解析钩子：把宿主包名重新锚定到能真正读到它们的 node_modules。
 *
 * 插件部署到 profile 后，`@deepseek-ai/*` 由共享 node_modules 提供；仓库本地没有
 * node_modules，因此离线单测要用本钩子换锚点：
 *   node --import ./tools/_host-hooks.mjs --test "test/*.test.mjs"
 *
 * 0.2.0 线适配：本包的 peer 已锁 `0.2.0-rc.2`，
 * `@deepseek-ai/schemastery` 需要 `~3.18.4` 的 `.volatile()`——开发机请把
 * `DSAT_HOST_MODULES` 指向 0.2.0 线运行树（服务 AppParameters 所指的那棵
 * node_modules，位于服务家目录下；
 * 一次性 `setx` 即可）。落到旧代际树时
 * `.volatile is not a function` 就是 "锚点错了"的诚实信号，而不是静默错版。
 *
 * 可用 `DSAT_HOST_MODULES` 覆盖锚点目录。
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 需要重新锚定的裸包名。 */
const HOST_PACKAGES = ['@deepseek-ai/', 'zod'];

/**
 * 判断目录里能否真正读到宿主包。
 * @param {string} dir - 候选 node_modules。
 * @returns {boolean} 可读时为 true。
 */
function usable(dir) {
  try {
    return statSync(join(dir, '@deepseek-ai', 'dsh-tools', 'package.json')).isFile();
  } catch {
    return false;
  }
}

/** 缓存锚点。 */
let anchorUrl;

/**
 * 计算候选 node_modules 目录列表（需求 §6.1 安全红线：不写死本机路径——本包随包
 * 分发，机器路径只在开发机的 `DSAT_HOST_MODULES` 里；这里只留可推导的常规布局）。
 *
 * 候选次序（首个可用者胜）：`DSAT_HOST_MODULES` → `DSH_HOME/profiles` →
 * `%APPDATA%/npm` 全局安装树。`DSH_HOME` 缺省 `~/.dsh`（与宿主同款取法）。
 *
 * @param {string} home - 宿主 home 目录（`process.env.DSH_HOME ?? ~/.dsh`）。
 * @returns {string[]} 存在于磁盘上的候选目录。
 */
export function candidateModules(home) {
  return [
    process.env.DSAT_HOST_MODULES,
    join(home, 'profiles', 'node_modules'),
    process.env.APPDATA === undefined
      ? undefined
      : join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
  ].filter((entry) => typeof entry === 'string' && entry.length > 0 && existsSync(entry));
}

/**
 * 计算锚点 file URL。
 * @returns {string | undefined} 锚点；找不到可读目录时返回 undefined。
 */
function anchor() {
  if (anchorUrl !== undefined) return anchorUrl;
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const found = candidateModules(home).find(usable);
  anchorUrl = found === undefined ? '' : pathToFileURL(join(found, '__anchor__.js')).href;
  return anchorUrl === '' ? undefined : anchorUrl;
}

/**
 * 解析裸导入；只改写宿主包，其余交给 Node 默认解析。
 * @param {string} specifier - 导入说明符。
 * @param {object} context - 解析上下文。
 * @param {Function} next - 默认解析器。
 * @returns {Promise<object>} 解析结果。
 */
export async function resolve(specifier, context, next) {
  const parent = anchor();
  if (parent !== undefined && HOST_PACKAGES.some((prefix) => specifier === prefix || specifier.startsWith(prefix))) {
    return next(specifier, { ...context, parentURL: parent });
  }
  return next(specifier, context);
}
