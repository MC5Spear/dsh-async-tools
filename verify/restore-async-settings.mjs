/**
 * 把 `async-tools-host` 宿主行设置还原为**出厂默认**（真机探针的收尾出口）。
 *
 * ## 为什么需要它单独存在
 *
 * `probe-settings-behavior-full.mjs` 的还原写在 `finally` 里。这**不够**：探针在跑批里
 * 被超时切断（外部 kill）时 `finally` 没跑完，验证实例被留在改过的配置上，
 * 且不会有任何判据变红——一个"改设置再还原"的探针，
 * 被切断时留下的是一台配置被改过的机器，这比探针失败更麻烦。
 *
 * ⇒ 还原功能必须能**独立于探针进程**存在。本脚本就是那个出口：
 * 探针被切断后，跑它一次即可回到出厂默认。
 *
 * ## 与探针测试基线的分工
 *
 * 各真机探针（final-acceptance、async-e2e、probe-agent-e2e 等）起跑写入的是各自的
 * **测试基线**——其中 `minYieldMs`／`minWaitMs`／`maxResultChars` 三项有意偏离出厂
 * 默认（短下限让探针指令里的小额预算原样生效），见各探针头注。本脚本不管测试基线：
 * `replaceNs({})` 复位全部 volatile 用户覆盖，设置回落到 schema 默认，然后用下表核对。
 *
 * 本清单是 `lib/config.js` schema 默认值（`SETTING_FIELDS` 各 `.default()`）的手抄
 * 副本——**改 schema 默认值时必须同步这里**。副本失真的后果是 fail-closed：复位
 * 成功也会报「仍不是默认值」并退出 1，宁可红也不静默放过。持有同族副本的文件：
 * 本文件、`probe-queue-delivery.mjs`、`probe-queue-baseline.mjs`、`async-e2e.mjs`、
 * `final-acceptance.mjs`、`acceptance-017.mjs`、`probe-agent-e2e.mjs`、
 * `probe-settings-behavior-full.mjs`（后五者写的是各自的测试基线，不承担出厂核对）。
 *
 * 用法：node verify/restore-async-settings.mjs
 */
// 设置读写经共享助手（NS 单一登记点＋嵌套 settings 形状，设计 §8.3）。
import { readNs, replaceNs } from './_r28-helpers.mjs';

/** 与 `lib/config.js` 的 schema 默认值一致（出厂默认）；`probe-settings-behavior-full.mjs`
 * 的起跑基线在此基础上另含 `agentLang`（探针自用键）。 */
const SCHEMA_DEFAULTS = {
  maxResultChars: 12000,
  defaultYieldMs: 20000,
  minYieldMs: 20000,
  maxYieldMs: 600000,
  defaultWaitMs: 30000,
  minWaitMs: 20000,
  maxWaitMs: 600000,
  pollIntervalMs: 500,
  jobKind: 'async-command'
};

// 用 `replace` 而不是 `update`：`replaceNs({})` 会**整体重置** volatile 用户覆盖、
// 回落到 schema 默认值，而 `update`（merge）只会覆盖传进去的键——留一个没传的键
// 就还原不干净。
await replaceNs({});

const value = (await readNs()).value;
const drifted = Object.keys(SCHEMA_DEFAULTS).filter((k) => value[k] !== SCHEMA_DEFAULTS[k]);
console.log(`还原后：${drifted.length === 0 ? '全部等于出厂默认' : `**这些键仍不是出厂默认（本表若失真也会这样报——对照 lib/config.js 现值核一遍）：${drifted.join('、')}**`}`);
for (const k of Object.keys(SCHEMA_DEFAULTS)) console.log(`  ${k.padEnd(18, ' ')} ${String(value[k])}`);
process.exitCode = drifted.length === 0 ? 0 : 1;
