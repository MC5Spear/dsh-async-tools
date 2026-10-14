/**
 * 两个语言开关独立性的真机判据（需求 §5.3）：**两块文案各自独立切换**（展示侧 = 设置表单可见文案，Agent 侧 = 模型收到的工具描述）。
 *
 * 判据本体在 `verify/lang-judgements.mjs`（纯函数，`verify/mutate-lang.mjs` 证明能红）；这里只取数：
 *
 * 1. **出厂态**：页面读设置表单的字段标签与控件身份（`id` 去前缀）；新会话读 `request/header` 里
 *    `async_run` 的描述（模型实际收到的串）。
 * 2. **只改 `agentLang` → `zh`**（走 RPC 写入宿主行设置，与真实保存同一条链）：新会话的描述必须
 *    换成中文档；**表单文案必须逐字不变**（agentLang 不得影响展示侧）。
 * 3. **只改 `uiLang` → `en`**（走**页面本身**：改下拉 + 点保存，证明这个控件真的可用）：表单文案必须
 *    整体换成英文档、字段身份不变；**工具描述必须逐字不变**（uiLang 不得影响 Agent 面）。
 * 4. **复原**：两个开关回 `auto` / `en` 并回读比对（验证实例是共享资源，不留脏状态）。
 *
 * 前置：验证实例在跑（loopback 打开）、包名在 profile 的 dependencies 与 bundles 里。
 * 证据：判据读数与截图随脚本落盘到本机证据目录（logs/lang-independence.json、shots/lang-*.png）。
 * 用法：node verify/probe-lang-independence.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { launch, openPage, evaluate, findBrowser, waitFor, screenshot } from './_visual/cdp.mjs';
import { rpc, transcriptOf, localConfig } from './_rpc.mjs';
import { instanceCredentials } from '../tools/_local-config.mjs';
import { judgeLangIndependence, judgeLangRestored } from './lang-judgements.mjs';
import { BUDGET_FIELD_KEYS, LANG_FIELD_KEYS, FLAG_FIELD_KEYS, ASK_FIELD_KEYS } from '../lib/config.js';

const { base: BASE, token } = instanceCredentials(localConfig);
const SHOTS = join(localConfig.evidenceDir, 'shots');
const NS = 'async-tools-host';
const PRESET = 'dsh-async';
const ACK = 'Reply with exactly: ACK. Do not call any tool.';

const url = `${BASE}/?token=${encodeURIComponent(token)}`;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const results = [];
/**
 * 记一条判据。
 *
 * @param {string} name - 判据名。
 * @param {boolean} ok - 结论。
 * @param {string} detail - 读数。
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'OK    ' : 'WRONG '} ${name}${detail === '' ? '' : `\n          ${detail}`}`);
}

/** 读宿主行的现行设置值。 */
async function readNs() {
  const described = await rpc('settings/describe', {});
  const found = described.namespaces.find((n) => (n.ns ?? n.namespace ?? n.id) === NS);
  if (found === undefined) throw new Error(`${NS} 命名空间不在 describe 里（宿主行没激活？）`);
  return { value: found.value ?? {}, revision: found.revision ?? null };
}

/** 写一个设置补丁（与页面保存同一条链：settings/update）。 */
async function patchNs(patch) {
  await rpc('settings/update', { ns: NS, patch });
}

/** 起一个会话（核对预设没被静默回退）。 */
async function newSession() {
  const created = await rpc('session/create', {
    request: { cwd: localConfig.workspaceDir, agentPreset: PRESET }
  });
  if (created.agentPreset !== PRESET) throw new Error(`预设回退：要 ${PRESET}，得到 ${String(created.agentPreset)}`);
  return created.sessionId;
}

/** 发一条不触发工具的提示（只发不等——判据要的是模型**收到**的工具清单，不是这轮的答案）。 */
async function prompt(sessionId) {
  await rpc('session/prompt', {
    request: {
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: ACK }],
      clientTimeZone: 'Asia/Shanghai'
    }
  });
}

/**
 * 等第一条 `request/header` 入账。
 *
 * 判据只需要"请求真的发出去了"这一刻（工具清单就在这条事件里），所以不去等整轮跑完——
 * 等轮次结束要靠轮询 `session/list` 的 `running`，短轮次会整段错过 running 窗口而白等到超时。
 *
 * @param {string} sessionId - 会话。
 * @returns {Promise<object>} 转录（已含 header）。
 */
async function waitForHeader(sessionId) {
  for (let i = 0; i < 40; i += 1) {
    const transcript = await transcriptOf(sessionId);
    if ((transcript.records ?? []).some((record) => record.event?.type === 'request/header')) return transcript;
    await sleep(1500);
  }
  throw new Error('等待 request/header 超时——模型侧取不到，判据无法成立');
}

/** 取新会话里模型实际收到的 `async_run` 描述（形状照 `acceptance-017.mjs` 的 `faceOf`）。 */
async function runDescription() {
  const sessionId = await newSession();
  await prompt(sessionId);
  const transcript = await waitForHeader(sessionId);
  for (const record of transcript.records ?? []) {
    if (record.event?.type !== 'request/header') continue;
    const tools = record.event.data?.header?.tools ?? [];
    const tool = tools.find((t) => t.name === 'async_run');
    if (tool !== undefined) return { sessionId, description: String(tool.description ?? '') };
  }
  throw new Error('第一条 request/header 里没有 async_run——模型侧取不到，判据无法成立');
}

mkdirSync(SHOTS, { recursive: true });
const browser = findBrowser();
if (browser === undefined) {
  console.log('找不到 Edge/Chrome。');
  process.exit(2);
}
const { port, close } = await launch(browser);
let page;
let failed = 1;
let log = {};
try {
  page = await openPage(port, url);
  await waitFor(page, 'document.querySelectorAll("button,[role=button]").length', (n) => n > 0, 15000);

  const clickBy = (selectorJs, label) => evaluate(page, `(() => {
    const target = ${selectorJs};
    if (target === undefined || target === null) return 'missing:' + ${JSON.stringify(label)};
    target.click();
    return 'clicked';
  })()`);
  /** 打开本包插件页（设置区就在插件页上）。 */
  const openPluginPage = async () => {
    await clickBy(`[...document.querySelectorAll('button,[role=button],a')].find((n) => (n.getAttribute('aria-label') || '') === '插件')`, '插件');
    await sleep(2000);
    await clickBy(`[...document.querySelectorAll('*')].find((n) => (n.getAttribute('aria-label') || '') === '查看 dsh-async-tools')`, '查看 dsh-async-tools');
    await sleep(2500);
  };
  /** 读设置表单的可见标签、字段身份，以及下拉的**当前显示值**（控件身份 = id 去前缀，设计 §5.5）。 */
  const readForm = () => evaluate(page, `(() => {
    const section = document.querySelector('[data-plugin-config]');
    if (section === null) return { labels: [], names: [], selectValues: [] };
    // 只收控件本体（input/select）——按 id 前缀选会连说明行 p（*-message）一起捞进来。
    const controls = [...section.querySelectorAll('input[id^="plugin-config-"], select[id^="plugin-config-"]')];
    return {
      labels: [...section.querySelectorAll('label[for^="plugin-config-"]')].map((n) => n.textContent.trim()),
      names: controls.map((n) => n.id.slice('plugin-config-'.length)),
      selectValues: [...section.querySelectorAll('select[id^="plugin-config-"]')]
        .map((n) => [n.id.slice('plugin-config-'.length), n.value])
    };
  })()`);

  console.log('· 0/4 先把两个开关复位到出厂态（上一次中断可能留下脏状态）');
  await patchNs({ uiLang: 'auto', agentLang: 'en' });
  const reset = judgeLangRestored((await readNs()).value);
  check('⓪ 起始态是 auto / en（回读比对）', reset.ok, reset.detail);

  console.log('· 1/4 出厂态：读表单 + 读模型侧描述');
  await openPluginPage();
  const form0 = await readForm();
  // 无覆盖时下拉必须显示**生效值**（不是空串——空串在下拉里没有对应选项，会渲染成白板）。
  check('③b 两个语言下拉显示的是生效值',
    JSON.stringify(form0.selectValues) === JSON.stringify([['uiLang', 'auto'], ['agentLang', 'en']]),
    `读数=${JSON.stringify(form0.selectValues)}`);
  const desc0 = await runDescription();
  log = { form0, desc0: desc0.description.slice(0, 300) };
  await screenshot(page, `${SHOTS}\\lang-01-baseline.png`);

  console.log('· 2/4 只改 agentLang → zh');
  await patchNs({ agentLang: 'zh' });
  await sleep(2000);
  const reloaded = await evaluate(page, `(() => { window.location.reload(); return 'reloading'; })()`);
  log.reload = reloaded;
  await sleep(4000);
  await openPluginPage();
  const form1 = await readForm();
  const desc1 = await runDescription();
  log.form1 = form1;
  log.desc1 = desc1.description.slice(0, 300);
  await screenshot(page, `${SHOTS}\\lang-02-agentlang-zh.png`);

  console.log('· 3/4 只改 uiLang → en（走页面下拉 + 保存，证明控件可用）');
  const switched = await evaluate(page, `(() => {
    const select = document.querySelector('[data-plugin-config] select#plugin-config-uiLang');
    if (select === null) return 'no-select';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'en');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return 'changed';
  })()`);
  check('③a uiLang 下拉可用（页面控件，不是 RPC）', switched === 'changed', `动作=${switched}`);
  await sleep(400);
  await clickBy(`[...document.querySelectorAll('[data-plugin-config] button')].find((b) => /^(保存|Save)$/.test(b.textContent.trim()))`, '保存');
  await sleep(3500);
  const afterUiSave = await readNs();
  log.afterUiSave = afterUiSave.value;
  console.log(`          页面保存后的设置值：uiLang=${String(afterUiSave.value.uiLang)} agentLang=${String(afterUiSave.value.agentLang)}`);
  const form2 = await readForm();
  const desc2 = await runDescription();
  log.form2 = form2;
  log.desc2 = desc2.description.slice(0, 300);
  await screenshot(page, `${SHOTS}\\lang-03-uilang-en.png`);

  console.log('· 4/4 判据 + 复原');
  // 四组全取：这条判据要证的正是"换语言**不动**字段集合"，
  // 只数两组（12 个）的话，开关与提问接管四个字段的在场/缺席它根本看不见。
  const expectedFields = BUDGET_FIELD_KEYS.length + LANG_FIELD_KEYS.length
    + FLAG_FIELD_KEYS.length + ASK_FIELD_KEYS.length;
  const verdict = judgeLangIndependence({
    labels0: form0.labels, labels1: form1.labels, labels2: form2.labels,
    names0: form0.names, names2: form2.names,
    desc0: desc0.description, desc1: desc1.description, desc2: desc2.description,
    expectedFields
  });
  check('①②③④ 两块文案各自独立切换（agentLang 换描述不动表单；uiLang 换表单不动描述）',
    verdict.ok, verdict.detail);
  for (const [key, value] of Object.entries(verdict.parts)) console.log(`          ${key}=${String(value)}`);
  log.verdict = verdict;
  log.sessions = { base: desc0.sessionId, zh: desc1.sessionId, uiEn: desc2.sessionId };

  failed = results.filter((r) => !r.ok).length;
} catch (error) {
  console.log('PROBE-ERROR', error instanceof Error ? error.message : String(error));
} finally {
  // 复原：验证实例是共享资源，两个开关都回出厂态并回读比对。
  try {
    await patchNs({ uiLang: 'auto', agentLang: 'en' });
    const restored = await readNs();
    const verdict = judgeLangRestored(restored.value);
    check('⑤ 收尾复原到 auto / en（回读比对，不留脏状态）', verdict.ok, verdict.detail);
    log.restored = restored.value;
  } catch (error) {
    check('⑤ 收尾复原到 auto / en（回读比对，不留脏状态）', false,
      `复原失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const OUT = join(localConfig.evidenceDir, 'logs', 'lang-independence.json');
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT,
    JSON.stringify({ at: new Date().toISOString(), base: BASE, ...log, results }, null, 2), 'utf8');
  if (page !== undefined) await page.close?.();
  await close();
}
const failures = results.filter((r) => !r.ok).length;
console.log(`\n总判定：${String(results.length - failures)}/${String(results.length)} 通过`);
process.exitCode = failures === 0 ? 0 : 1;
