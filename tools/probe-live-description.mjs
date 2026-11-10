/**
 * 行为验证：**改设置后，模型看到的数字真的跟着变**（需求 §5.1）。
 *
 * 为什么不能用文本匹配代替：文本匹配（"源码里出现 `makeConfigView`"）挡不住
 * "实现退化成构造时快照"这类假绿——退化后源码照样含那些字。所以这里用**行为差异**
 * 判定：改设置前后，描述字符串必须不同，且必须不再含旧值。
 *
 * 用法：node --import ./tools/_host-hooks.mjs tools/probe-live-description.mjs
 */
import { createRunTool } from '../lib/jobs.js';
import { createWaitTool } from '../lib/wait.js';
import { refreshToolDescriptions } from '../lib/index.js';

let current = {
  toolName: 'async_run',
  agentLang: 'zh',
  defaultYieldMs: 20000,
  minYieldMs: 1000,
  maxYieldMs: 600000,
  defaultWaitMs: 30000,
  minWaitMs: 250,
  maxWaitMs: 600000,
  maxResultChars: 30000,
  jobKind: 'async-command',
  pollIntervalMs: 500
};
const view = new Proxy({}, { get: (_target, key) => current[key] });
const ctx = { logger: { info() {}, warn() {}, debug() {} }, get: () => undefined };

const tools = {
  async_run: { tool: createRunTool(ctx, view), param: 'yield_ms' },
  async_wait: { tool: createWaitTool(ctx, view), param: 'wait_ms' }
};

const checks = [];
const record = (label, passed, detail) => {
  checks.push({ label, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`);
};

const snapshot = () => Object.fromEntries(Object.entries(tools).map(([name, item]) => [name, {
  top: item.tool.description,
  param: String(item.tool.parameters.properties[item.param].description)
}]));

console.log('=== 改设置前 ===');
const before = snapshot();
for (const [name, value] of Object.entries(before)) {
  console.log(`  ${name} 顶层尾部：…${value.top.slice(-46)}`);
  console.log(`  ${name} 参数     ：${value.param.slice(0, 76)}`);
}

// 改设置，然后走**真实调用链**里那个刷新函数。
current = {
  ...current,
  defaultYieldMs: 5000,
  maxYieldMs: 120000,
  defaultWaitMs: 7000,
  maxWaitMs: 130000
};
for (const item of Object.values(tools)) refreshToolDescriptions(item.tool, view);

console.log('');
console.log('=== 改设置后（就地刷新，未重新注册）===');
const after = snapshot();
for (const name of Object.keys(tools)) {
  record(`${name}：顶层描述文本已变`, after[name].top !== before[name].top);
  // **解析出数字再比**，不要用 `!includes('600000')` 这种子串否定——
  // 新值 `130000` 里就含 `30000`，会让断言误报（度量口径陷阱）。
  //
  // 还要**锚定上下文**：`async_run` 的描述里有两个区间（首次等待 `1000-600000`、单次等待
  // `250–600000`），不锚定上下文就会匹配到第一个区间。
  const topRange = /单次等待预算必须显式传入，范围 (\d+)–(\d+) ms/.exec(after[name].top);
  record(`${name}：顶层描述里的等待区间已更新为 250–130000`,
    topRange !== null && topRange[1] === '250' && topRange[2] === '130000',
    topRange === null ? '没解析到区间' : `解析到 ${topRange[1]}–${topRange[2]}`);

  const paramText = after[name].param;
  // 参数说明的区间形态各档不同（zh「范围 X-Y」/「（毫秒，X-Y）」、en "(X-Y)"）——
  // 直接取第一组 X-Y 数字对，锚定上下文交给上面的顶层区间判据。
  const paramRange = /(\d+)-(\d+)/.exec(paramText);
  const expectParam = name === 'async_run' ? ['1000', '120000'] : ['250', '130000'];
  record(`${name}：参数描述里的区间已更新为 ${expectParam.join('-')}`,
    paramRange !== null && paramRange[1] === expectParam[0] && paramRange[2] === expectParam[1],
    paramRange === null ? '没解析到区间' : `解析到 ${paramRange[1]}-${paramRange[2]}`);
  if (name === 'async_run') {
    record('async_run：参数描述里的默认值已更新为 5000', /默认 5000\b/.test(paramText) || /Defaults to 5000\b/.test(paramText));
  }
}

console.log('');
console.log('=== 边界：参数不存在时不得抛 ===');
record('refreshToolDescriptions 对空参数对象不抛', (() => {
  try { refreshToolDescriptions({ description: 'x', parameters: {} }, view); return true; } catch { return false; }
})());

console.log('');
const failed = checks.filter((check) => !check.passed);
console.log(`=== 总判定：${String(checks.length - failed.length)}/${String(checks.length)} 通过 ===`);
process.exit(failed.length === 0 ? 0 : 1);
