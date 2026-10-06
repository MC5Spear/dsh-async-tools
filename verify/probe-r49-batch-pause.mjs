/**
 * R49 真机探针：待答暂停计时的批级独立（设计 §36.5 真机 (c)/(d)、§41.3）。
 *
 * 前置：验证实例在听；dsh-async 预设；`askTakeover` 开（探针只读设置，不动别人
 * 的档位——共享实例纪律；若开关关，如实 FAIL 'takeover-off'，不擅自打开）。
 *
 * 判据（§36.5，R49 新增两条）：
 * - (c) 时序判据：批 1 暂停 → 齐答结清 → 模型发批 2 接管 → 首轮轮询
 *   paused=false（倒计时数字形态、组开关显「暂停计时」）→ 墙钟越过全额窗口
 *   照表合成放行（转录出现超时锚句、组内出现已超时徽标）。
 * - (d) 双会话隔离对照：会话 A 暂停在窗批、会话 B 在窗批照表走到期合成放行
 *   （B 的放行不被 A 的暂停冻结）；A 的恢复动作不触碰 B（B 组保持已超时态、
 *   不出现新倒计时）；A 恢复后按剩余平移放行。
 *
 * GUI 面（Edge/Chrome CDP）：找不到浏览器时如实 FAIL 'cdp-missing'，不冒充通过。
 * 用法：node verify/probe-r49-batch-pause.mjs（默认自起无头 Edge；环境spawn 被安全
 * 软件拦截时可设 R49_CDP_ATTACH_PORT=<port> 连用户侧预起的常驻实例，见 main() 注释）。
 * 证据落本机证据目录 logs/r49-batch-pause.json + shots/r49-batch-pause-*.png。
 *
 * @module verify/probe-r49-batch-pause
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
 * r36 首跑竞速教训沿用：面板首绘链路（轮询 + 按钮等待 + 点击）要占掉小头，
 * 窗口必须宽于「面板出现→动作」全程；30 s 窗 + 45 s 越界余量。 */
const WINDOW_MS = 30000;
/** 越界余量：墙钟要越过全额窗口才断言照表放行（探针不数秒，只等越界后核形态）。 */
const PAST_WINDOW_MS = 45000;

/** 转录超时锚句（F132；en/zh 两档都认——面板语言与转录语言不必同档）。 */
const TIMEOUT_ANCHOR = /has not answered within|用户暂未应答/;
/** 倒计时数字形态（zh「剩 N s」/ en「N s left」）。 */
const COUNTING = /剩 \d+ ?s|\d+ ?s left/;
/** 冻结形态（zh「已暂停」/ en「Paused」）。 */
const PAUSED_TEXT = /已暂停|Paused/;
/** 已超时徽标（zh「已超时」/ en「Timed out」）。 */
const EXPIRED_TEXT = /已超时|Timed out/;

const results = [];
const marks = {};
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console[ok ? 'log' : 'error'](`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
};

/** 组定位（r36/r30 真机教训：面板里同时有历史组——断言与点击都必须按组头短 id
 * 定位本会话的组，不能数全局）。 */
function groupExpr(sessionId) {
  return `(() => {
    const short = ${JSON.stringify(String(sessionId).replace(/^session-/, '').slice(0, 8))};
    const groups = [...document.querySelectorAll(".ats-ask-group")];
    return groups.find((g) => (g.textContent || '').includes(short)) ?? null;
  })()`;
}

/** 本会话组的文本（断言只认本组）。 */
function groupTextOf(page, sessionId) {
  return evaluate(page, `(() => { const g = ${groupExpr(sessionId)}; return g === null ? '' : (g.innerText || ''); })()`);
}

/** 组内点击（暂停/恢复/作答都在本组内）。 */
async function clickInGroup(page, sessionId, selector) {
  return evaluate(page, `(() => {
    const g = ${groupExpr(sessionId)};
    if (g === null) return 'no-group';
    const b = g.querySelector(${JSON.stringify(selector)});
    if (b === null) return 'no-button';
    b.click();
    return 'clicked';
  })()`);
}

/** 等本会话的组上屏（组内选择器出现即回）。 */
function waitForGroup(page, sessionId, timeoutMs) {
  return waitFor(page, `(() => { const g = ${groupExpr(sessionId)}; return g !== null && g.querySelector(".ats-ask-chip") !== null; })()`,
    (v) => v === true, timeoutMs).then(() => true, () => false);
}

/** 在目标会话的组里点第一个选项 chip 并提交（齐答动作——单题批）。 */
async function answerFirst(page, sessionId) {
  const chip = await clickInGroup(page, sessionId, '.ats-ask-chip');
  await sleep(200);
  const submit = await clickInGroup(page, sessionId, '.ats-ask-submit');
  return chip === 'clicked' && submit === 'clicked';
}

/** 清面板：逐条点「不答」直到空（开工清残留 + 收尾清痕迹两用）。 */
async function clearPanel(page) {
  for (let round = 0; round < 10; round += 1) {
    const remaining = await evaluate(page,
      'document.querySelectorAll(".ats-ask-panel .ats-ask-skip").length');
    if (Number(remaining) === 0) break;
    await evaluate(page, '(() => { const b = document.querySelector(".ats-ask-panel .ats-ask-skip"); if (b !== null) b.click(); return true; })()');
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
  if (original.askTakeover !== true) {
    record('setup', false, `takeover-off：askTakeover=${String(original.askTakeover)}（探针不擅自打开，如实失败）`);
    return { restore: async () => {} };
  }
  await patchNs({ askTakeover: true, askTimeoutMs: WINDOW_MS, askUiSeat: 'overlay' });
  const restore = async () => {
    await patchNs({ askTakeover: original.askTakeover, askTimeoutMs: original.askTimeoutMs, askUiSeat: original.askUiSeat });
  };
  return { restore };
}

/** 让 Agent 提一道单选题（提问后就安静等待——与 r30/r36 探针同款、真机已验形状）。 */
const askPrompt = (marker) => `Call the ask_user_question tool with exactly one question: `
  + `question text "Pick ${marker}", two options "red" and "blue", no multiSelect. `
  + `After you receive the answer, reply with one short sentence naming the chosen color.`;

/** 会话转录是否已含超时锚句。 */
async function released(sessionId) {
  const text = JSON.stringify(await transcriptOf(sessionId));
  return TIMEOUT_ANCHOR.test(text);
}

async function main() {
  // Attach 模式（R49 e2e 环境适应）：会话内 spawn 无头 Edge 因提权令牌在 mojo 通道
  // 创建处被拒（chrome_debug.log FATAL 0x5，platform_channel.cc）时，可由用户侧终端
  // 预起一个常驻无头实例（--remote-debugging-port），探针只连不启、结束不杀——
  // 环境变量 R49_CDP_ATTACH_PORT 门控；不设则维持自启自清的既有路径，零行为变化。
  // 断言正则本就 zh/en 双档，attach 实例的语言不影响判据。
  const attachPort = Number(process.env.R49_CDP_ATTACH_PORT ?? 0);
  let browser;
  if (attachPort > 0) {
    browser = { port: attachPort, close: () => {} };
  } else {
    const browserPath = await findBrowser();
    if (browserPath === null || browserPath === undefined) {
      record('setup', false, 'cdp-missing：无浏览器可连（GUI 面判据不可取证）');
      return null;
    }
    browser = await launch(browserPath, ['--lang=zh-CN']);
  }
  const URL_LINE = readFileSync(localConfig.tokenFile, 'utf8').trim();
  const APP_URL = URL_LINE.slice(URL_LINE.indexOf('http'));
  const page = await openPage(browser.port, 'about:blank');
  await page.send('Page.navigate', { url: APP_URL });
  await waitFor(page, 'document.querySelectorAll("#root *").length', (n) => Number(n) > 20, 30000);
  await sleep(2000);

  // 开工先清残留：历轮失败跑留下的待答组会让点击与断言打到别人的组上。
  const leftoverStart = await clearPanel(page);
  record('setup-clean', true, `开工清残留（剩余 ${String(leftoverStart)} 条）`);

  // ══ (c) 时序判据：暂停 → 齐答 → 新批照表放行 ══════════════════════════
  const sA = await newSession(PRESET);
  marks.aAsk = Date.now();
  await prompt(sA, askPrompt('a color'));

  const groupA1 = await waitForGroup(page, sA, 30000);
  if (!groupA1) {
    record('c-1-panel', false, '批 1 的待答组未上屏（30 s）');
    return browser;
  }
  // 批 1 暂停。
  const pause1 = await clickInGroup(page, sA, '.ats-ask-pause');
  await sleep(2000);
  const frozenText = await groupTextOf(page, sA);
  record('c-1-paused', pause1 === 'clicked' && PAUSED_TEXT.test(frozenText),
    `批 1 已暂停（点击=${String(pause1)}）：${frozenText.slice(0, 100)}`);
  await screenshot(page, `${SHOT_DIR}\\r49-batch-pause-b1-paused.png`);

  // 齐答批 1（暂停只是冻结计时——作答通道照常，R36-e 面在时序里顺带取证）。
  marks.aAnswered = Date.now();
  const answered = await answerFirst(page, sA);
  await sleep(1500);
  const a1Cleared = await evaluate(page, `(() => { const g = ${groupExpr(sA)}; return g === null || g.querySelector('.ats-ask-chip') === null; })()`);
  record('c-2-answered', answered && a1Cleared === true,
    `批 1 齐答结清（组内待答题清空，点击=${String(answered)}）`);

  // 模型发批 2：第二轮提问。
  await prompt(sA, askPrompt('another color'));
  const groupA2 = await waitForGroup(page, sA, 30000);
  marks.b2Seen = Date.now();
  if (!groupA2) {
    record('c-3-batch2', false, '批 2 的待答组未上屏（30 s）');
    return browser;
  }
  // 首轮轮询形态：倒计时数字（非「已暂停」）+ 组开关显「暂停计时」（.ats-ask-pause 在场）。
  await sleep(1500); // 轮询链路 1 s 一拍——给首拍留余量
  const b2Text = await groupTextOf(page, sA);
  const b2PauseBtn = await evaluate(page, `(() => { const g = ${groupExpr(sA)}; return g !== null && g.querySelector('.ats-ask-pause') !== null; })()`);
  record('c-3-batch2-independent', COUNTING.test(b2Text) && b2PauseBtn === true,
    `批 2 照表计时（倒计时数字 + 开关显「暂停计时」）：${b2Text.slice(0, 100)}`);
  await screenshot(page, `${SHOT_DIR}\\r49-batch-pause-b2-counting.png`);

  // 墙钟越过全额窗口 → 照表合成放行。
  marks.b2SettledBy = marks.b2Seen + PAST_WINDOW_MS;
  let b2Released = false;
  while (Date.now() < marks.b2SettledBy + 20000) {
    if (await released(sA)) { b2Released = true; break; }
    await sleep(2000);
  }
  const b2ExpiredBadge = await evaluate(page, `(() => { const g = ${groupExpr(sA)}; return g !== null && g.querySelector('.ats-ask-expired') !== null; })()`);
  marks.b2ReleasedAt = Date.now();
  record('c-4-batch2-released', b2Released && b2ExpiredBadge === true,
    `批 2 越全额窗口照表放行（转录超时锚句=${String(b2Released)}、已超时徽标=${String(b2ExpiredBadge)}）`);
  await screenshot(page, `${SHOT_DIR}\\r49-batch-pause-b2-expired.png`);

  // ══ (d) 双会话隔离对照：A 暂停在窗批，B 照表放行 ═════════════════════
  const sIsoA = await newSession(PRESET);
  const sIsoB = await newSession(PRESET);
  marks.isoAAsk = Date.now();
  marks.isoBAsk = Date.now();
  await prompt(sIsoA, askPrompt('iso alpha'));
  await prompt(sIsoB, askPrompt('iso beta'));

  const groupIsoA = await waitForGroup(page, sIsoA, 30000);
  const groupIsoB = await waitForGroup(page, sIsoB, 30000);
  if (!groupIsoA || !groupIsoB) {
    record('d-1-panels', false, `两会话待答组未齐上屏（A=${String(groupIsoA)} B=${String(groupIsoB)}）`);
    return browser;
  }
  marks.isoBothSeen = Date.now();
  // 只暂停 A——B 必须照表。
  const pauseA = await clickInGroup(page, sIsoA, '.ats-ask-pause');
  await sleep(2000);
  const textA = await groupTextOf(page, sIsoA);
  const textB = await groupTextOf(page, sIsoB);
  record('d-2-a-paused-b-counting', pauseA === 'clicked' && PAUSED_TEXT.test(textA) && COUNTING.test(textB) && !PAUSED_TEXT.test(textB),
    `A 已暂停、B 仍数字倒计时（A 的暂停不触碰 B）：A=${textA.slice(0, 60)} ‖ B=${textB.slice(0, 60)}`);
  await screenshot(page, `${SHOT_DIR}\\r49-batch-pause-iso-contrast.png`);

  // B 照表走到期合成放行（A 仍暂停中——B 的放行就是「没被冻住」的活体证据）。
  let bRel = false;
  const bDeadline = marks.isoBothSeen + PAST_WINDOW_MS + 20000;
  while (Date.now() < bDeadline) {
    if (await released(sIsoB)) { bRel = true; break; }
    await sleep(2000);
  }
  marks.isoBReleasedAt = Date.now();
  const aStillFrozen = await groupTextOf(page, sIsoA);
  const aReleasedEarly = await released(sIsoA);
  const bRelWithin = marks.isoBReleasedAt - marks.isoBothSeen < PAST_WINDOW_MS + 20000;
  record('d-3-b-released-on-schedule', bRel && bRelWithin && PAUSED_TEXT.test(aStillFrozen) && !aReleasedEarly,
    `B 照表放行（${String(marks.isoBReleasedAt - marks.isoBothSeen)} ms < 越界余量）且 A 仍冻结未放行`);
  await screenshot(page, `${SHOT_DIR}\\r49-batch-pause-iso-b-released.png`);

  // A 恢复——不触碰 B：B 组保持已超时态（不出现新倒计时），A 回数字倒计时。
  const resumeA = await clickInGroup(page, sIsoA, '.ats-ask-resume');
  await sleep(2500);
  const aAfterResume = await groupTextOf(page, sIsoA);
  const bAfterResume = await groupTextOf(page, sIsoB);
  const bBadge = await evaluate(page, `(() => { const g = ${groupExpr(sIsoB)}; return g !== null && g.querySelector('.ats-ask-expired') !== null; })()`);
  record('d-4-resume-isolated', resumeA === 'clicked' && COUNTING.test(aAfterResume)
    && bBadge === true && !COUNTING.test(bAfterResume) && PAUSED_TEXT.test(bAfterResume) === false,
    `A 恢复回数字倒计时；B 保持已超时态（无新倒计时、未被平移重挂）：A=${aAfterResume.slice(0, 60)} ‖ B=${bAfterResume.slice(0, 60)}`);
  await screenshot(page, `${SHOT_DIR}\\r49-batch-pause-iso-a-resumed.png`);

  // A 按剩余平移放行（收尾对照：恢复后照表到期——不被恢复重置成全窗口）。
  let aRel = false;
  const aDeadline = Date.now() + PAST_WINDOW_MS + 20000;
  while (Date.now() < aDeadline) {
    if (await released(sIsoA)) { aRel = true; break; }
    await sleep(2000);
  }
  marks.isoAReleasedAt = Date.now();
  record('d-5-a-released-after-resume', aRel,
    `A 恢复后照表放行（转录超时锚句出现）`);

  // 收尾清面板。
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
const path = `${LOG_DIR}\\r49-batch-pause.json`;
writeFileSync(path, JSON.stringify({ results, marks, at: new Date().toISOString() }, null, 2), 'utf8');
const failed = results.filter((r) => !r.ok).length;
console.log(`\n探针结束：${String(results.length - failed)}/${String(results.length)} 通过；证据 ${path}`);
process.exit(failed === 0 ? 0 : 1);
