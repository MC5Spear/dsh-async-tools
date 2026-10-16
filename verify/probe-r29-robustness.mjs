/**
 * 安全/健壮性/异常处理的真机判据（验证实例；设置拒绝按需求 §5.1／§5.4 与设计 §5.4，
 * 耗时上界按设计 §2.1 时间判据）。
 *
 * 四组判据（killed 不设真机必过项——Windows 外杀不产生 POSIX signal，单测为准；
 * 文档核对类项目不设机证）：
 *
 * 1. **卡片层拒绝·单字段**（第一道防线）：插件页 maxWaitMs 草稿输入 2147483648 →
 *    保存按钮禁用 + 字段原因文案带上界数字（走官方 parse 通道）。
 * 2. **卡片层拒绝·配对**：pollIntervalMs 草稿 > maxWaitMs 草稿 → 保存禁用 +
 *    invalidPair 文案（壳层叠加）。
 * 3. **提交层拒绝**（第二道防线）：绕过卡片直写（RPC mutate）越界 maxWaitMs →
 *    **网关按本包 schema 拒绝**（`settings/rejected` + schemastery 可读消息，含上界）
 *    + 回读值未变（未落盘）+ 工具描述不受影响。字段级越界由网关 schema 当场拒绝；
 *    跨字段违例（如 min > max）schema 表达不了，走落盘 + loader warn 承接。
 * 4. **等待总耗时上界**：20 秒命令（提权档真跑）+ yield 后 async_wait_job
 *    (wait_ms=1500) → running 结局，渲染句 "Waited N ms; the job is still
 *    running" 在场且 N ∈ [0.9×wait_ms, wait_ms + 3×pollIntervalMs + 容差]
 *    （wait-job 屏障是一次快照，不睡；容差吃 RTT/轮机抖动）。**执行档走提权**
 *    （async_run 起新进程，受限档在验证实例死于 CreateRestrictedToken 前置；
 *    sandbox_permissions + justification 经批准 allowed-once），
 *    async_wait_job 本身不碰执行器。命令取 20 秒——提权批准往返会吃掉数秒，
 *    更短的命令会在第 2 步前已完结。
 *
 * 状态复原：起手先把四个等待/轮询字段归位出厂默认并读回核对；探针只在 3 组做
 * 直写（且被网关拒绝、未落盘），结尾再回正读回。
 *
 * 前置：验证实例在跑（loopback 打开）、junction 指向本仓库当前提交。
 * 证据：本机证据目录 logs/r29-robustness.json 与 shots/r29-*.png。
 * 用法：node verify/probe-r29-robustness.mjs（裸调用，不捕获输出）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, openPage, evaluate, findBrowser, waitFor, screenshot } from './_visual/cdp.mjs';
import { readNs, patchNs, newSession, prompt, waitTurnEnd, lastAssistantText, runDescriptionOf, runResultText, approvalOutcomes, PRESET } from './_r28-helpers.mjs';
import { transcriptOf, localConfig } from './_rpc.mjs';
import { instanceCredentials } from '../tools/_local-config.mjs';

const { base: BASE, token } = instanceCredentials(localConfig);
const SHOTS = join(localConfig.evidenceDir, 'shots');
const LOGS = join(localConfig.evidenceDir, 'logs');
const ERRLOG = localConfig.serviceLog;
const url = `${BASE}/?token=${encodeURIComponent(token)}`;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'OK    ' : 'WRONG '} ${name}${detail === '' ? '' : `\n          ${detail}`}`);
}

mkdirSync(SHOTS, { recursive: true });
mkdirSync(LOGS, { recursive: true });
const browser = findBrowser();
if (browser === undefined) {
  console.log('找不到 Edge/Chrome。');
  process.exit(2);
}
const { port, close } = await launch(browser);
let page;
const log = {};
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

  /** React 受控输入改草稿：原生 setter + input 事件（直接赋 value 不触发 onChange）。 */
  const setDraft = (key, text) => evaluate(page, `(() => {
    const input = document.getElementById('plugin-config-${key}');
    if (input === null) return 'missing-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'set';
  })()`);

  /** 读保存按钮禁用态 + 全部字段说明行文本（invalidLabel 就落在说明行）。 */
  const readFormState = () => evaluate(page, `(() => {
    const section = document.querySelector('[data-plugin-config]');
    if (section === null) return { error: 'missing-section' };
    const save = [...section.querySelectorAll('button')]
      .find((b) => /保存|Save/.test(b.textContent || ''));
    return {
      saveDisabled: save === undefined ? 'missing-save' : String(save.disabled === true || b2(save)),
      saveText: save === undefined ? '' : (save.textContent || '').trim(),
      hints: [...section.querySelectorAll('input[id^="plugin-config-"]')]
        .map((n) => ({ key: n.id.slice('plugin-config-'.length), text: n.value }))
    };
    function b2(button) { return button.getAttribute('aria-disabled') === 'true'; }
  })()`);

  /** 越界/配对原因文案（扫 section 全文，语言无关地找数字锚/字段名锚）。 */
  const sectionText = () => evaluate(page, `document.querySelector('[data-plugin-config]')?.textContent ?? ''`);

  // ── 起始态：先归位出厂默认（纪律 #4：会改设置的脚本自己保证起跑状态）再读回核对 ──
  console.log('· 起始态核对（先归位）');
  await patchNs({ maxWaitMs: 600000, minWaitMs: 250, defaultWaitMs: 30000, pollIntervalMs: 500 });
  await sleep(1200);
  const start = await readNs();
  const baselineMax = start.value.maxWaitMs;
  check('⓪ 归位后 maxWaitMs=600000、pollIntervalMs=500', baselineMax === 600000 && start.value.pollIntervalMs === 500,
    `读数 max=${String(baselineMax)} poll=${String(start.value.pollIntervalMs)}`);

  // ── 1a 卡片层·单字段 ─────────────────────────────────────────────────
  console.log('· 1/4 真机 1a：卡片层单字段上界（2147483648 → 保存禁用 + 带数字原因）');
  await openPluginPage();
  await setDraft('maxWaitMs', '2147483648');
  await sleep(400);
  let form = await readFormState();
  let text = await sectionText();
  check('1a-1 草稿输入已进输入框（input.value）', form.hints?.find((h) => h.key === 'maxWaitMs')?.text === '2147483648',
    `form=${JSON.stringify(form.hints?.find((h) => h.key === 'maxWaitMs'))}`);
  check('1a-2 保存按钮禁用', form.saveDisabled === 'true', `saveDisabled=${String(form.saveDisabled)} saveText=${form.saveText}`);
  check('1a-3 原因文案带上界数字（≤ 2147483647）', /2147483647/.test(text), text.slice(0, 400));
  await screenshot(page, `${SHOTS}\\r29-1a-field-bound.png`);

  // ── 1b 卡片层·配对 ───────────────────────────────────────────────────
  console.log('· 2/4 真机 1b：卡片层配对（poll 700000 > max 600000 → 保存禁用 + 配对文案）');
  await setDraft('maxWaitMs', '600000');
  await sleep(200);
  await setDraft('pollIntervalMs', '700000');
  await sleep(400);
  form = await readFormState();
  text = await sectionText();
  check('1b-1 保存按钮禁用', form.saveDisabled === 'true', `saveDisabled=${String(form.saveDisabled)}`);
  check('1b-2 配对原因文案在场（提到 maxWaitMs）', /maxWaitMs/.test(text) && /poll|轮询/.test(text), text.slice(0, 400));
  await screenshot(page, `${SHOTS}\\r29-1b-pair.png`);

  // 草稿清场：整页刷新（discard 不保证触发，刷新最干净——cdp 句柄没有 reload 方法，
  // 用 location.reload() 后等插件页重新就位）。
  await evaluate(page, 'location.reload()');
  await sleep(2500);
  await waitFor(page, 'document.querySelectorAll("button,[role=button]").length', (n) => n > 0, 15000);
  const afterReload = await readNs();
  check('1b-3 草稿未落盘（刷新后回读仍是 600000）', afterReload.value.maxWaitMs === 600000,
    `读数=${String(afterReload.value.maxWaitMs)}`);

  // ── 2 提交层拒绝（直写） ─────────────────────────────────────────────
  // 实测语义：RPC settings/update 网关按本包 schema 校验 patch，
  // 字段级越界在网关就被拒（settings/rejected + schemastery 可读消息），到不了落盘——
  // 这比设计稿的"落盘 + errlog warn 承接"更强；跨字段违例 schema 表达不了，仍走
  // 落盘 + loader warn（口径不变）。
  console.log('· 3/4 真机 2：绕过卡片直写越界值（提交层网关拒绝）');
  const errBase = readFileSync(ERRLOG, 'utf8');
  let rejectText = '';
  try {
    await patchNs({ maxWaitMs: 2147483648 });
  } catch (error) {
    rejectText = String(error instanceof Error ? error.message : error);
  }
  check('2-1 RPC 直写被拒（settings/rejected 且消息含上界）',
    /settings\/rejected/.test(rejectText) && /2147483647/.test(rejectText),
    rejectText.slice(0, 200));
  await sleep(1200);
  const written = await readNs();
  check('2-2 越界值未落盘（回读仍是 600000）', written.value.maxWaitMs === 600000,
    `读数=${String(written.value.maxWaitMs)}`);
  const errNew = readFileSync(ERRLOG, 'utf8').slice(errBase.length);
  const errLogged = /expected number <= 2147483647/.test(errNew) || /invalid config/.test(errNew);
  console.log(`  INFO  errlog 增量 ${String(errNew.length)} 字节；拒绝留痕=${String(errLogged)}（判据本体在 2-1 的 RPC 消息，留痕为旁证）`);
  // 工具行为不受影响：新会话的 async_run 描述里 wait 区间仍是 250–600000。
  // （READY 会话的 transcript 投影偶尔还没带上 header 的工具描述——
  // 缺席时等 2s 重取一次，仍缺席才按失败计。runDescriptionOf 返回**描述字符串**
  // （null = 无此工具/无 header），不是工具对象。）
  const sid = await newSession(PRESET);
  await prompt(sid, '只回复 READY 一词，不要调用任何工具。');
  await waitTurnEnd(sid);
  let runDesc = runDescriptionOf(await transcriptOf(sid));
  if (runDesc === null || runDesc === '') {
    await sleep(2000);
    runDesc = runDescriptionOf(await transcriptOf(sid));
  }
  const runDescText = String(runDesc ?? '');
  check('2-3 工具描述不受影响（wait 区间 250–600000）',
    /range 250–600000 ms/.test(runDescText),
    `async_run 描述等待区间片段=${(runDescText.match(/range \d+–\d+ ms/g) ?? []).join(' | ') || '(描述缺席)'}`);

  // ── 3 等待总耗时上界 ─────────────────────────────────────────────────
  // 执行档（用户裁定「走提权」，与 probe-r28 系探针同款口径）：async_run 起的是**新进程**，
  // 受限档在验证实例（托管服务 LocalSystem 无 logon SID）死于 CreateRestrictedToken
  // 前置。因此本组走提权档（sandbox_permissions + justification，
  // 经批准 allowed-once）；async_wait_job 本身不碰执行器，无需提权。
  // 解析侧：模型看到的是工具的**渲染文本**（running 结局 = note.waitAgain：
  // "Waited N ms; the job is still running"），不是原始 JSON——锚定渲染句。
  // 命令取 20 秒：提权批准往返 + 模型出话延迟可能吃掉数秒，6 秒会在第 2 步前
  // 已完结（实测翻车形态）；20 秒保证等待窗口内仍在运行。
  console.log('· 4/4 真机 3：async_wait_job 总耗时上界（20s 命令 + wait_ms=1500 → running）');
  const sid2 = await newSession(PRESET);
  const t0 = Date.now();
  await prompt(sid2, '依次做两步，一步一个工具调用。第 1 步：async_run 运行命令 "Start-Sleep -Seconds 20"，'
    + 'yield_ms 传 1000，并带 sandbox_permissions（设为该工具广告的最宽档）与它要求的一句 justification'
    + '（本次验收探针的提权已获用户预批准）。第 2 步：拿到 job_id 后**立即**调用 async_wait_job（wait_ms 传 1500，'
    + '不带任何提权参数）。然后把 async_wait_job 返回给你的那段文本原样粘贴出来，不要做别的。');
  const tr2 = await waitTurnEnd(sid2, 180000);
  const turnMs = Date.now() - t0;
  const approvals2 = approvalOutcomes(tr2);
  check('3-0 提权执行经批准（allowed-once 在场）', approvals2.some((a) => /allowed/.test(a)),
    `approvals=${JSON.stringify(approvals2)}`);
  const answer2 = `${lastAssistantText(tr2) ?? ''}\n${runResultText(tr2) ?? ''}`;
  // running 结局的渲染句（note.waitAgain，en/zh 两档都收）。
  const waited = /(?:Waited|已等待) (\d+) ms/.exec(answer2);
  const runningAnchor = /still running|仍在运行/.test(answer2);
  log.answer2Head = answer2.slice(0, 400);
  check('3-1 返回 running（预算到期，作业未受影响）', runningAnchor,
    !runningAnchor ? `running 锚缺席；答案头=${answer2.slice(0, 160)}` : 'note.waitAgain 渲染句在场');
  const pollDefault = 500;
  const upperTol = 3000;
  const w = waited === null ? -1 : Number(waited[1]);
  check('3-2 waited_ms 落在 [0.9×wait_ms, wait_ms + 3×poll + 容差]',
    w >= 1350 && w <= 1500 + 3 * pollDefault + upperTol,
    `waited_ms=${String(w)}；上界=${String(1500 + 3 * pollDefault + upperTol)}（容差含 RTT/轮机抖动）`);

  // ── 复原 ─────────────────────────────────────────────────────────────
  await patchNs({ maxWaitMs: 600000 });
  await sleep(1500);
  const restored = await readNs();
  check('④ 复原：maxWaitMs 回 600000', restored.value.maxWaitMs === 600000, `读数=${String(restored.value.maxWaitMs)}`);
  await screenshot(page, `${SHOTS}\\r29-4-restored.png`);

  log.errlogDeltaChars = errNew.length;
  log.turnMs = turnMs;
} catch (error) {
  log.error = String(error instanceof Error ? error.stack : error);
  console.error(log.error);
} finally {
  writeFileSync(`${LOGS}\\r29-robustness.json`, JSON.stringify({ results, log }, null, 2));
  const wrong = results.filter((entry) => !entry.ok).length;
  console.log(`\nR29 真机判据：${String(results.length - wrong)}/${String(results.length)} 通过`);
  await close();
  process.exit(wrong === 0 ? 0 : 1);
}
