/**
 * 双语言开关（需求 §5.3）的**纯函数**判据：展示侧文案与 Agent 侧文案各自独立切换。
 *
 * 取数在 `verify/probe-lang-independence.mjs`（真机：页面 DOM + 每次新会话的 `request/header`），
 * 判据在这里，所以 `verify/mutate-lang.mjs` 能用变异证明每一条都能被改坏打成红。
 */

/** CJK 表意字符计数（判定"这一档到底换没换语言"）。 */
export function cjkCount(text) {
  return (String(text).match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length;
}

/** 两个数组逐项相等（顺序敏感）。 */
function same(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * 需求 §5.3 的判据：两个方向各自"换了自己那块"且"没动对方那块"。
 *
 * 读数来源与命名（`0` = 出厂态、`1` = 只改 `agentLang` 之后、`2` = 再改 `uiLang` 之后）：
 * - `labels*`：设置表单的可见字段标签（`[data-plugin-config] label` 的文本序列）；
 * - `names*`：表单控件的身份序列（`[id^="plugin-config-"]` 去前缀，字段身份，语言切换不得改变它）；
 * - `desc*`：新会话第一条 `request/header` 里 `async_run` 的描述（模型实际收到的串）。
 *
 * @param {{labels0: string[], labels1: string[], labels2: string[], names0: string[], names2: string[],
 *   desc0: string, desc1: string, desc2: string, expectedFields: number}} reading - 真机读数。
 * @returns {{ok: boolean, detail: string, parts: object}} 判据结论、读数与分项。
 */
export function judgeLangIndependence(reading) {
  const parts = {
    // 方向 A：只改 agentLang —— 描述换到中文档，且表单文案逐字不变。
    agentSwitch: reading.desc1 !== reading.desc0
      && cjkCount(reading.desc1) > 0 && cjkCount(reading.desc0) === 0,
    uiInvariant: same(reading.labels1, reading.labels0),
    // 方向 B：只改 uiLang —— 表单文案整体换到英文档，且工具描述逐字不变。
    uiSwitch: !same(reading.labels2, reading.labels1)
      && cjkCount(reading.labels2) === 0 && cjkCount(reading.labels1) > 0,
    agentInvariant: reading.desc2 === reading.desc1,
    // 字段身份不随语言变（语言只换文案，不换字段集合）。
    identity: same(reading.names0, reading.names2) && reading.names0.length === reading.expectedFields
  };
  const ok = parts.agentSwitch && parts.uiInvariant && parts.uiSwitch
    && parts.agentInvariant && parts.identity;
  return {
    ok,
    parts,
    detail: `agentSwitch=${String(parts.agentSwitch)}（desc0 CJK=${String(cjkCount(reading.desc0))} → desc1 CJK=${String(cjkCount(reading.desc1))}）`
      + ` uiInvariant=${String(parts.uiInvariant)}（标签 ${String(reading.labels0.length)} 项逐字比对）`
      + ` uiSwitch=${String(parts.uiSwitch)}（labels1 CJK=${String(cjkCount(reading.labels1.join('')))} → labels2 CJK=${String(cjkCount(reading.labels2.join('')))}）`
      + ` agentInvariant=${String(parts.agentInvariant)} identity=${String(parts.identity)}（字段 ${String(reading.names0.length)}/${String(reading.expectedFields)}）`
  };
}

/**
 * 收尾复原判据：两个开关都回到出厂态（验证实例是共享资源，不留脏状态）。
 *
 * @param {{uiLang?: string, agentLang?: string}} value - 复原后读回的设置值。
 * @returns {{ok: boolean, detail: string}} 判据结论与读数。
 */
export function judgeLangRestored(value) {
  const ok = value?.uiLang === 'auto' && value?.agentLang === 'en';
  return {
    ok,
    detail: `uiLang=${String(value?.uiLang)} agentLang=${String(value?.agentLang)}（期望 auto / en）`
  };
}
