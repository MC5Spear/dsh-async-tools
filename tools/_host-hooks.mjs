/**
 * 把开发期解析钩子挂进模块解析链，并把**本机配置**桥接成环境变量契约。
 * 用法：`node --import ./tools/_host-hooks.mjs --test "test/*.test.mjs"`
 *
 * ## 为什么要有桥接这一段
 *
 * 解析钩子（`_host-resolve.mjs`）必须**同步**回答"候选 node_modules 在哪"——它在模块
 * 解析热路径上。而本机配置是 `.local/config.mjs` 这个 ESM 文件，读它只能异步。
 *
 * 解法是在这里（`--import` 前置模块，**允许顶层 await**）把配置文件里的 `hostModules`
 * 写进 `process.env.DSAT_HOST_MODULES`，此后全链沿用既有的环境变量契约，
 * 同步代码一处都不用改。
 *
 * ⚠️ **环境变量优先，配置文件兜底**——不是反过来。原因是"我这次就想临时指到别处"是
 * 常见需求（试验新树、跑对照），而 `setx` 那种持久化才是少见操作。
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { loadLocalConfig } from './_local-config.mjs';

if (typeof process.env.DSAT_HOST_MODULES !== 'string' || process.env.DSAT_HOST_MODULES.length === 0) {
  try {
    const config = await loadLocalConfig();
    if (config.hostModules !== undefined) {
      process.env.DSAT_HOST_MODULES = config.hostModules;
    }
  } catch {
    // 本机平面缺席（CI、外部 clone）或配置坏了——两种都不在这里报错：
    // 前者是正常形态，后者由真正需要它的判据去红（静默兜底只会把配置错误藏起来）。
  }
}

register('./_host-resolve.mjs', pathToFileURL(`${import.meta.dirname}/`));
