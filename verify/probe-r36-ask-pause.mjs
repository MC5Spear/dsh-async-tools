/**
 * R36 真机探针：待答面板暂停/恢复的机械面（设计 §36.5 真机项 (a)/(b)；R49 起
 * 暂停作用面为批级——本探针三断言属机械面不受翻转影响，批级独立/跨会话隔离
 * 取证走 probe-r49-batch-pause.mjs）。
 *
 * 前置：验证实例在听；dsh-async 预设；`askTakeover` 开（探针只读设置，不动别人
 * 的档位——共享实例纪律；若开关关，如实 FAIL 'takeover-off'，不擅自打开）。
 *
 * 判据（§36.5）：
 * - ① 组头出现「暂停计时/恢复计时」按钮（.ats-ask-pause/.ats-ask-resume）。
 * - ② 点击暂停 → 倒计时位变「已暂停/Paused」（.ats-ask-left 冻结文本）。
 * - ③ 停留超过原窗口（探针用 12 s 窗 + 20 s 停留）→ 问题**没有**超时放行
 *   （面板仍在、无合成答案记录、转录无超时锚句）——暂停真的冻住了计时。
 * - ④ 点击恢复 → 倒计时回到数字形态并递减；随后任其到期 → 合成答案放行
 *   （F132 超时锚句出现在转录）——恢复后窗口按剩余推进。
 * - ⑤ 幂等：连点两次暂停，剩余不重记（恢复后到期时刻 ≌ 一次暂停的剩余，
 *   不是被第二次点击重置成全窗口——按「恢复后到放行的时距 < 原窗口」断言）。
 *
 * GUI 面（Edge/Chrome CDP）：找不到浏览器时如实 FAIL 'cdp-missing'，不冒充通过。
 * 用法：node verify/probe-r36-ask-pause.mjs
 * 证据落本机证据目录 logs/r36-ask-pause.json + shots/r36-ask-pause-*.png。
 *
 * @module verify/probe-r36-ask-pause
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rpc, transcriptOf, localConfig } from './_rpc.mjs';
import { newSession, prompt, readNs, patchNs, PRESET } from './_r28-helpers.mjs';
import { findBrowser, launch, openPage, evaluate, waitFor, screenshot } from './_visual/cdp.mjs';

const LOG_DIR = join(localConfig.evidenceDir, 'logs');
const SHOT_DIR = join(localConfig.evidenceDir, 'shots');
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 探针窗口（写进宿主行设置的 askTimeoutMs——开工置位、收尾复原，不动别人的档）。
 * r36 首跑竞速教训：面板首绘时窗口已过大半（轮询链路 + 按钮等待 + 点击），暂停点
 * 下去时问题已到期——窗口必须宽到「面板出现→暂停」链路只占小头。 */
const WINDOW_MS = 30000;
/** 暂停停留时长（必须 > 窗口，证计时冻结）。 */
const HOLD_MS = 45000;

const results = [];
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console[ok ? 'log' : 'error'](`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
};

/** 面板内断言（F147 教训：读 DOM 而不是模型正文——正文会被提示词回显污染）。 */
const panelText = (page) => evaluate(page, 'document.querySelector(".ats-ask-panel")?.innerText ?? ""');

/** 组内点击（r36 二跑教训：残留旧组在 DOM 前，querySelector 永远命中别人的组——
 * 必须按组头短 id 定位本会话的组再点组内选择器）。 */
function clickInGroup(page, sessionId, selector) {
  const short = String(sessionId).replace(/^session-/, '').slice(0, 8);
  return evaluate(page, `(() => {
    const short = ${JSON.stringify(short)};
    const group = [...document.querySelectorAll('.ats-ask-group')]
      .find((el) => (el.textContent || '').includes(short));
    if (group === undefined) return 'no-group';
    const b = group.querySelector(${JSON.stringify(selector)});
    if (b === null) return 'no-button';
    b.click();
    return 'clicked';
  })()`);
}

/** 本会话组的文本（断言只认本组——旧组残留会污染整面板断言）。 */
function groupText(page, sessionId) {
  const short = String(sessionId).replace(/^session-/, '').slice(0, 8);
  return evaluate(page, `(() => {
    const short = ${JSON.stringify(short)};
    const group = [...document.querySelectorAll('.ats-ask-group')]
      .find((el) => (el.textContent || '').includes(short));
    return group === undefined ? '' : (group.innerText || '');
  })()`);
}

async function clickInPanel(page, selector) {
  return evaluate(page, `(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (b === null) return false; b.click(); return true; })()`);
}

/** 清面板：逐条点「不答」直到空（开工清残留 + 收尾清痕迹两用）。 */
async function clearPanel(page) {
  for (let round = 0; round < 8; round += 1) {
    const remaining = await evaluate(page,
      'document.querySelectorAll(".ats-ask-panel .ats-ask-skip").length');
    if (Number(remaining) === 0) break;
    await clickInPanel(page, '.ats-ask-panel .ats-ask-skip');
    await sleep(800);
  }
  const leftover = await evaluate(page,
    'document.querySelectorAll(".ats-ask-panel .ats-ask-skip").length');
  return Number(leftover);
}

/** 开工置位 + 返回复原闭包（r30 纪律：复原到开工快照，不动别人的档）。 */
async function setupTakeover() {
  const before = await readNs();
  const original = {
    askTakeover: before.value.askTakeover ?? false,
    askTimeoutMs: before.value.askTimeoutMs ?? 10000,
    askUiSeat: before.value.askUiSeat ?? 'overlay'
  };
  await patchNs({ askTakeover: true, askTimeoutMs: WINDOW_MS, askUiSeat: 'overlay' });
  const restore = async () => {
    await patchNs({ askTakeover: original.askTakeover, askTimeoutMs: original.askTimeoutMs, askUiSeat: original.askUiSeat });
  };
  return { restore };
}

async function main() {
  const browserPath = await findBrowser();
  if (browserPath === null || browserPath === undefined) {
    record('setup', false, 'cdp-missing：无浏览器可连（GUI 面判据不可取证）');
    return null;
  }
  const browser = await launch(browserPath, ['--lang=zh-CN']);
  const URL_LINE = readFileSync(localConfig.tokenFile, 'utf8').trim();
  const APP_URL = URL_LINE.slice(URL_LINE.indexOf('http'));
  const page = await openPage(browser.port, 'about:blank');
  await page.send('Page.navigate', { url: APP_URL });
  await waitFor(page, 'document.querySelectorAll("#root *").length', (n) => Number(n) > 20, 30000);
  await sleep(2000);

  const sessionId = await newSession(PRESET);

  // 开工先清残留：历轮失败跑留下的待答组会让点击与断言打到别人的组上。
  const leftoverStart = await clearPanel(page);
  record('setup-clean', true, `开工清残留（剩余 ${String(leftoverStart)} 条）`);

  await prompt(sessionId, [
    `请调用 ask_user_question 工具问用户一个单选题（选项：红/蓝），`,
    `提问后就安静等待用户作答，不要自行继续。`
  ].join(''));

  // 面板出现（15 s 内；断言走 DOM 而非模型正文）。
  await waitFor(page, 'document.querySelector(".ats-ask-panel") !== null', (v) => v === true, 15000);
  record('panel', true, '待答面板出现（askTakeover 在开）');

  // 等本会话的组上屏（轮询链路有秒级延迟——组没上就点会点空）。
  await waitFor(page, `(() => { const short = ${JSON.stringify(String(sessionId).replace(/^session-/, '').slice(0, 8))}; return [...document.querySelectorAll('.ats-ask-group')].some((el) => (el.textContent || '').includes(short)); })()`,
    (v) => v === true, 15000);

  // ① 组头暂停按钮。
  const hasPause = await waitFor(page,
    `(() => { const short = ${JSON.stringify(String(sessionId).replace(/^session-/, '').slice(0, 8))}; const g = [...document.querySelectorAll('.ats-ask-group')].find((el) => (el.textContent || '').includes(short)); return g !== undefined && g.querySelector('.ats-ask-pause') !== null; })()`,
    (v) => v === true, 5000).then(() => true, () => false);
  record('i-button', hasPause, '组头「暂停计时」按钮在场（.ats-ask-pause，本组内）');
  if (!hasPause) return browser;

  // ② 点暂停 → 已暂停文本（面板一出现立即点——窗口余量见 WINDOW_MS 注）。
  const pausedClick = await clickInGroup(page, sessionId, '.ats-ask-pause');
  await sleep(1500);
  const pausedText = await groupText(page, sessionId);
  const pausedOk = pausedClick === 'clicked' && /已暂停|Paused/.test(pausedText);
  await screenshot(page, `${SHOT_DIR}\\r36-ask-pause-paused.png`);
  record('ii-frozen', pausedOk, `暂停后倒计时位冻结（点击=${String(pausedClick)}）：${pausedText.slice(0, 120)}`);

  // ③ 停留 > 窗口 → 不放行。
  await sleep(HOLD_MS);
  const afterHold = await groupText(page, sessionId);
  const stillOpen = /红/.test(afterHold) && !/已超时|Timed out/.test(afterHold);
  const transcriptHold = JSON.stringify(await transcriptOf(sessionId));
  const noSynthetic = !/has not answered|暂未应答/.test(transcriptHold);
  await screenshot(page, `${SHOT_DIR}\\r36-ask-pause-holding.png`);
  record('iii-held', stillOpen && noSynthetic,
    `停留 ${String(HOLD_MS)} ms（窗口 ${String(WINDOW_MS)} ms）后：本组仍 open=${String(stillOpen)}；无合成答案=${String(noSynthetic)}`);

  // ④ 幂等二连点 + 恢复 → 倒计时回数字，随后到期放行。
  await clickInGroup(page, sessionId, '.ats-ask-resume');
  await sleep(300);
  await clickInGroup(page, sessionId, '.ats-ask-pause'); // 二次暂停（幂等：不重记剩余）
  await sleep(2000); // 暂停名义下再停留 2 s（不应推进计时）
  const resumedAt = Date.now();
  await clickInGroup(page, sessionId, '.ats-ask-resume');
  await sleep(1000);
  const resumedText = await groupText(page, sessionId);
  const counting = /剩 \d+ ?s|\d+ ?s left|秒/.test(resumedText);
  record('iv-resume', counting, `恢复后倒计时回数字形态：${resumedText.slice(0, 120)}`);

  // 到期放行（剩余 ≤ 窗口；给 1.5 倍余量轮询）。
  const deadline = Date.now() + Math.round(WINDOW_MS * 1.5);
  let syntheticSeen = false;
  while (Date.now() < deadline) {
    const text = JSON.stringify(await transcriptOf(sessionId));
    if (/has not answered|暂未应答/.test(text)) { syntheticSeen = true; break; }
    await sleep(1000);
  }
  const resumeToSettle = Date.now() - resumedAt;
  record('v-expire', syntheticSeen && resumeToSettle < WINDOW_MS * 1.5,
    `恢复后 ${String(resumeToSettle)} ms 到期放行（< 1.5×窗口——二次暂停没有重置成全窗口）`);

  // 收尾清面板：逐组点「不答」，把探针历轮遗留的待答条目清空（已超时条目也会随
  // 跳过离场）——面板不残留探针痕迹。
  const leftover = await clearPanel(page);
  record('cleanup', leftover === 0, `面板清空（残留待答 ${String(leftover)} 条）`);
  return browser;
}

let restore = null;
let openedBrowser = null;
try {
  const setup = await setupTakeover();
  restore = setup.restore;
  openedBrowser = await main();
} catch (error) {
  record('fatal', false, String(error?.stack ?? error));
} finally {
  if (openedBrowser !== null && openedBrowser !== undefined) openedBrowser.close();
  if (restore !== null) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const ok = await restore().then(() => true, (error) => {
        console.log(`restore 第 ${String(attempt)} 次失败：${String(error?.message ?? error)}`);
        return false;
      });
      if (ok) break;
      await sleep(2000);
    }
  }
}
const path = `${LOG_DIR}\\r36-ask-pause.json`;
writeFileSync(path, JSON.stringify({ results, at: new Date().toISOString() }, null, 2), 'utf8');
const failed = results.filter((r) => !r.ok).length;
console.log(`\n探针结束：${String(results.length - failed)}/${String(results.length)} 通过；证据 ${path}`);
process.exit(failed === 0 ? 0 : 1);
