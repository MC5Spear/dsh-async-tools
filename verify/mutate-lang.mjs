/**
 * 语言双开关判据（需求 §5.3）的变异证明（`verify/lang-judgements.mjs` 的两个纯函数）。
 *
 * 每条变异对应一种真实退化：Agent 侧没换语言 / 只译了一半 / 英文档混进中文、
 * 改 agentLang 顺带动了界面文案、uiLang 没生效、en 档没换干净、改 uiLang 顺带动了工具描述、
 * 语言切换把字段身份也换了。任一条没红即 UNCAUGHT 退出 1（不设 SKIP）。
 *
 * 用法：node verify/mutate-lang.mjs
 */
import { judgeLangIndependence, judgeLangRestored } from './lang-judgements.mjs';

const results = [];
/**
 * 跑一条变异。
 *
 * @param {string} name - 变异名。
 * @param {boolean} expectRed - 期望判据结论。
 * @param {() => { ok: boolean, detail: string }} run - 跑一次判据。
 */
function mutation(name, expectRed, run) {
  const verdict = run();
  const ok = verdict.ok === !expectRed;
  results.push(ok);
  console.log(`${ok ? 'CAUGHT  ' : 'UNCAUGHT'} ${name}`);
  console.log(`          ${verdict.detail}`);
}

const LABELS_ZH = ['默认首次等待时长（毫秒）', '首次等待时长下限（毫秒）', '插件界面语言', 'Agent 文案语言'];
const LABELS_EN = ['Default first-wait duration (ms)', 'First-wait lower bound (ms)', 'Plugin interface language', 'Agent-facing text language'];
const NAMES = ['defaultYieldMs', 'minYieldMs', 'uiLang', 'agentLang'];
const DESC_EN = 'Run a PowerShell command with a first-wait budget. The first wait defaults to 20000 ms;';
const DESC_ZH = '以首次等待预算运行一条 PowerShell 命令。首次等待默认为 20000 ms；';

const baseline = () => ({
  labels0: [...LABELS_ZH],
  labels1: [...LABELS_ZH],
  labels2: [...LABELS_EN],
  names0: [...NAMES],
  names2: [...NAMES],
  desc0: DESC_EN,
  desc1: DESC_ZH,
  desc2: DESC_ZH,
  expectedFields: NAMES.length
});

mutation('M1 基线：两个方向各自换语言、互不牵连必须判成立', false, () => judgeLangIndependence(baseline()));
mutation('M2 agentLang 没生效（描述与英文档一致）必须判不成立', true,
  () => judgeLangIndependence({ ...baseline(), desc1: DESC_EN }));
mutation('M3 中档案只译了一半（描述里没有中文）必须判不成立', true,
  () => judgeLangIndependence({ ...baseline(), desc1: 'Run a PowerShell command（带首次等待预算）'.replace(/[\u4e00-\u9fff]/g, '') }));
mutation('M4 英文档混进中文必须判不成立', true,
  () => judgeLangIndependence({ ...baseline(), desc0: `${DESC_EN} 预算` }));
mutation('M5 改 agentLang 顺带改了界面文案必须判不成立', true,
  () => judgeLangIndependence({ ...baseline(), labels1: [...LABELS_EN] }));
mutation('M6 uiLang 没生效（表单文案没换）必须判不成立', true,
  () => judgeLangIndependence({ ...baseline(), labels2: [...LABELS_ZH] }));
mutation('M7 en 档没换干净（表单文案里还剩中文）必须判不成立', true,
  () => judgeLangIndependence({ ...baseline(), labels2: [...LABELS_EN.slice(0, 3), '面向模型的文案语言（agentLang）'] }));
mutation('M8 改 uiLang 顺带改了工具描述必须判不成立', true,
  () => judgeLangIndependence({ ...baseline(), desc2: DESC_EN }));
mutation('M9 语言切换把字段身份也换了必须判不成立', true,
  () => judgeLangIndependence({ ...baseline(), names2: [...NAMES.slice(0, 3), 'language'] }));
mutation('M10 字段数不足（页面少渲染一项）必须判不成立', true,
  () => judgeLangIndependence({ ...baseline(), names0: NAMES.slice(0, 3), names2: NAMES.slice(0, 3) }));

mutation('M11 基线：收尾复原到 auto/en 必须判成立', false, () => judgeLangRestored({ uiLang: 'auto', agentLang: 'en' }));
mutation('M12 收尾没复原（agentLang 留在 zh）必须判不成立', true,
  () => judgeLangRestored({ uiLang: 'auto', agentLang: 'zh' }));

const uncaught = results.filter((ok) => !ok).length;
console.log(`\n${uncaught === 0 ? `全部变异都被抓住（${String(results.length)}/${String(results.length)}）` : `${String(uncaught)} 处没被抓住`}`);
process.exitCode = uncaught === 0 ? 0 : 1;
