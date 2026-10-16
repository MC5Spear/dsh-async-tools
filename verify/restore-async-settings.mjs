/**
 * 把 `async-tools-host` 宿主行设置写回默认值。
 *
 * ## 为什么需要它单独存在
 *
 * `probe-settings-behavior-full.mjs` 的还原写在 `finally` 里。这**不够**：探针在跑批里
 * 被超时切断（外部 kill）时 `finally` 没跑完，验证实例被留在改过的配置上，
 * 且不会有任何判据变红——一个"改设置再还原"的探针，
 * 被切断时留下的是一台配置被改过的机器，这比探针失败更麻烦。
 *
 * ⇒ 还原功能必须能**独立于探针进程**存在。本脚本就是那个出口：
 * 探针被切断后，跑它一次即可回到默认值。
 *
 * 本清单为 `lib/config.js` 出厂默认的手抄副本，改 schema 默认值时须同步四处：
 * 本文件、`probe-queue-delivery.mjs`、`final-acceptance.mjs`、`acceptance-017.mjs`。
 *
 * 用法：node verify/restore-async-settings.mjs
 */
import { rpc } from './_rpc.mjs';
// ns 单一登记点在 `_r28-helpers.mjs`（本文件不自带字面量，统一从登记点取）。
import { NS } from './_r28-helpers.mjs';

/** 与 `probe-settings-behavior-full.mjs` 的 `DEFAULTS`、以及 `lib/config.js` 的 schema 默认值一致。 */
const DEFAULTS = {
  maxResultChars: 30000,
  defaultYieldMs: 20000,
  minYieldMs: 1000,
  maxYieldMs: 600000,
  defaultWaitMs: 30000,
  minWaitMs: 250,
  maxWaitMs: 600000,
  pollIntervalMs: 500,
  jobKind: 'async-command'
};

// 用 `replace` 而不是 `update`：`replace({})` 会**整体重置**用户段、回落到 schema 默认值，
// 而 `update`（merge）只会覆盖传进去的键——留一个没传的键就还原不干净。
await rpc('settings/replace', { ns: NS, section: {} });

const described = await rpc('settings/describe', {});
const ns = described.namespaces.find((n) => n.ns === NS);
const value = ns.value ?? ns.resolved ?? ns;
const drifted = Object.keys(DEFAULTS).filter((k) => value[k] !== DEFAULTS[k]);
console.log(`还原后：${drifted.length === 0 ? '全部等于默认值' : `**这些键仍不是默认值：${drifted.join('、')}**`}`);
for (const k of Object.keys(DEFAULTS)) console.log(`  ${k.padEnd(18, ' ')} ${String(value[k])}`);
process.exitCode = drifted.length === 0 ? 0 : 1;
