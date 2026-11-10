/**
 * 把 `async-tools-host` 宿主行的**用户设置覆盖全部清除**（真机探针的收尾出口）。
 *
 * ## 为什么需要它单独存在
 *
 * `probe-settings-behavior-full.mjs` 的还原写在 `finally` 里。这**不够**：探针在跑批里
 * 被超时切断（外部 kill）时 `finally` 没跑完，验证实例被留在改过的配置上，
 * 且不会有任何判据变红——一个"改设置再还原"的探针，
 * 被切断时留下的是一台配置被改过的机器，这比探针失败更麻烦。
 *
 * ⇒ 还原功能必须能**独立于探针进程**存在。本脚本就是那个出口：
 * 探针被切断后，跑它一次即可清掉探针留下的全部用户设置覆盖。
 *
 * ## 还原范围与适用前提
 *
 * `replaceNs({})` 清除的是该命名空间的 **volatile 用户覆盖层**（`settings/replace`
 * 先复位全部 volatile 字段、再合并空入参）；清除后设置回落到组合层与 schema
 * 默认。它**不动组合层与 schema**——本脚本按**一次性验证实例**的前提使用（组合层
 * 本就没有别的覆盖，用户覆盖清空＝回到出厂形态）；在组合层有改动的共享实例上跑
 * 本脚本，只会清掉用户覆盖，组合层改动保持原样（不因此判红）。
 *
 * ## 判据
 *
 * 清除后读回用户覆盖层（describe 的 `user` 子树），必须为空——有任何一个残留键
 * 都按红退出。生效值的逐键打印保留为诊断信息；不再手抄 schema 默认值对照：手抄
 * 副本既证明不了覆盖已清空（组合层改动会让生效值偏离抄写值，红线会误报），也会
 * 随 schema 演进失真。
 *
 * 用法：node verify/restore-async-settings.mjs
 */
// 设置读写经共享助手（NS 单一登记点＋嵌套 settings 形状，设计 §8.3）。
import { readNs, replaceNs } from './_r28-helpers.mjs';

// 用 `replace` 而不是 `update`：`replaceNs({})` 会**整体重置** volatile 用户覆盖，
// 而 `update`（merge）只会覆盖传进去的键——留一个没传的键就还原不干净。
await replaceNs({});

const { value, user } = await readNs();
const residue = Object.keys(user ?? {});
console.log(residue.length === 0
  ? '用户覆盖层已清空（生效值回落到组合层/schema；逐键打印仅作诊断，不判红绿）'
  : `**用户覆盖层仍有残留键（清除未生效，或清除后又有写入）：${residue.join('、')}**`);
for (const [k, v] of Object.entries(value ?? {})) console.log(`  ${k.padEnd(18, ' ')} ${String(v)}`);
process.exitCode = residue.length === 0 ? 0 : 1;
