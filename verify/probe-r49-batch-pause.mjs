/**
 * R49 真机探针：待答暂停计时的批级独立（设计 §36.5 真机 (c)/(d)、§41.3）。
 *
 * 前置：验证实例在听；dsh-async 预设；`askTakeover` 开（开工只读核档——开关关
 * 则如实 FAIL 'takeover-off'，不擅自打开。跑期会临时置位 askTimeoutMs/askUiSeat
 * 三键并在收尾复原到开工快照（settingsRestore 留痕进证据 json；不是全程只读）。
 *
 * 判据（§36.5，R49 新增两条；r51 盲审 F1/F4 后时点判据强化）：
 * - (c) 时序判据：批 1 暂停 → 齐答结清 → 模型发批 2 接管 → 首轮轮询
 *   paused=false（倒计时数字形态、组开关显「暂停计时」、**数字 ∈ [18,29] s**＝
 *   全额窗口的用户可见面——继承/缩短窗口在此必红）→ 墙钟越过全额窗口
 *   照表合成放行（转录出现超时锚句、组内出现已超时徽标、**放行时刻距首见
 *   ∈ [20s, 33s]**——早合成必红）。
 * - (d) 双会话隔离对照：会话 A 暂停在窗批、会话 B 在窗批照表走到期合成放行
 *   （B 的放行不被 A 的暂停冻结）；A 的恢复动作不触碰 B（B 组保持已超时态、
 *   不出现新倒计时）；A 恢复后按剩余平移放行。
 * - (d-6) B 活动计时中的恢复对照（复审 N1/N4 收紧）：暂停前先烧 ~10 s 窗口，
 *   以**暂停前读得的数字为首记剩余锚**——恢复后 A 的数字必须落在首记锚
 *   −4..0 s 内（全额重置会显示 ~30，必红）；B 的数字续走原表（严格下降且
 *   降幅 ≤4 s；重置跳升/冻结停摆必红）。B 的放行时刻对**读锚时刻＋锚数字**
 *   双侧限界（超出 −5/+7 s 容差窗的平移/重挂必红；窗内小幅平移可能被接受
 *   ——粒度=秒级显示＋2 s 轮询，细粒度隔离由单元 K13/K3 承担）。
 *   A 第二次恢复同锚口径；放行时刻对「第二次暂停前锚」双侧限界（全额重置
 *   ≈30 s 必红——不再用恢复后读数当非全窗口证据）。
 * - setup-clean 门（复审 N2 收紧）：开工**只读计数**，非零立即 FAIL 退出——
 *   不清场、不点任何他人的题；收尾清理只动本次创建会话的组，且无组归属的
 *   按钮一律不算自身。
 * - 指纹（复审 N2/N4）：证据 json 记**实测指纹**——profile link 行、node_modules
 *   junction 的 OS 级解析目标、实体 package.json 版本、BUILD-STAMP、
 *   lib/ask-takeover.js + client.js + lib/host.js 的 sha256 前 16 位、
 *   pluginManager/listPlugins 原始行、/version 尝试读数；环境变量
 *   R49_ENTITY_HINT 仅作旁注标签，不充当指纹。
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
import { realpathSync } from 'node:fs';
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
/** 倒计时数字（zh「剩 N s」/ en「N s left」）——时点判据的量化面。 */
function countdownDigit(text) {
  const m = /剩 (\d+) ?s|(\d+) ?s left/.exec(String(text));
  return m === null ? null : Number(m[1] ?? m[2]);
}

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

/** 清面板（收尾专用，scopeShorts 必给）：逐条点「不答」直到**本次会话**的组清空。
 *  复审 N2 收紧：无组归属（g===null）的按钮一律**不算自身**——既不点也不数；
 *  只匹配组头含本次会话短 id 的组。开工不再调用本函数（开工只读计数）。 */
async function clearPanel(page, scopeShorts) {
  const scopeExpr = JSON.stringify(scopeShorts.map((sid) => String(sid).replace(/^session-/, '').slice(0, 8)));
  const scopedSkipCount = `(() => {
    const shorts = ${scopeExpr};
    const buttons = [...document.querySelectorAll(".ats-ask-panel .ats-ask-skip")];
    const own = buttons.filter((b) => {
      const g = b.closest('.ats-ask-group');
      if (g === null) return false; // 无组归属 ≠ 自身（复审 N2）
      const head = (g.textContent || '');
      return shorts.some((s) => head.includes(s));
    });
    return own.length;
  })()`;
  for (let round = 0; round < 10; round += 1) {
    const remaining = Number(await evaluate(page, scopedSkipCount));
    if (remaining === 0) break;
    await evaluate(page, `(() => {
      const shorts = ${scopeExpr};
      const buttons = [...document.querySelectorAll(".ats-ask-panel .ats-ask-skip")];
      const own = buttons.filter((b) => {
        const g = b.closest('.ats-ask-group');
        if (g === null) return false;
        const head = (g.textContent || '');
        return shorts.some((s) => head.includes(s));
      });
      if (own.length > 0) own[0].click();
      return true;
    })()`);
    await sleep(800);
  }
  return Number(await evaluate(page, scopedSkipCount));
}

/** 只读残留计数（开工门用——不点任何东西；复审 N2：非零即 FAIL 退出）。 */
function countSkips(page) {
  return evaluate(page, 'document.querySelectorAll(".ats-ask-panel .ats-ask-skip").length')
    .then((n) => Number(n));
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

/** 有界等组回到倒计时数字形态后**即读即返**（恢复后首拍渲染竞态——等到那拍
 *  的文本本身就带数字，读数即锚读数；超时返回末读让断言如实红）。 */
async function waitForCountingText(page, sessionId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await groupTextOf(page, sessionId);
    if (COUNTING.test(text)) return text;
    if (Date.now() > deadline) return text;
    await sleep(300);
  }
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
  try { probeEnv.baseUrl = new URL(APP_URL).origin; } catch { /* 指纹尽力——非法 URL 留 null */ }
  const page = await openPage(browser.port, 'about:blank');
  await page.send('Page.navigate', { url: APP_URL });
  await waitFor(page, 'document.querySelectorAll("#root *").length', (n) => Number(n) > 20, 30000);
  await sleep(2000);

  // 开工门（复审 N2 收紧）：**只读计数**——非零立即 FAIL 退出，不清场、不点
  // 任何他人的题（残留下次重跑前由人工处置；「清完再宣称本就干净」是假门）。
  const leftoverStart = await countSkips(page);
  if (leftoverStart > 0) {
    record('setup-clean', false, `开工面板有残留 ${String(leftoverStart)} 条（只读计数；不清他人题——人工清后重跑）`);
    return browser;
  }
  record('setup-clean', true, '开工面板干净（只读计数 0，未做任何清理动作）');
  // 实测指纹（复审 N2/N4）：开工即采——证据 json 与判据同跑同落。
  probeEnv.fingerprint = await collectFingerprint(new URL(APP_URL).origin);

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
  // 首轮轮询形态：倒计时数字（非「已暂停」）+ 组开关显「暂停计时」（.ats-ask-pause 在场）
  // + 数字 ∈ [18,29] s（r51 盲审 F1：全额窗口的用户可见量化面——继承剩余/缩短
  //   窗口的实现数字会明显偏低，此处必红）。
  await sleep(1500); // 轮询链路 1 s 一拍——给首拍留余量
  const b2Text = await groupTextOf(page, sA);
  const b2Digit = countdownDigit(b2Text);
  marks.b2FirstDigit = b2Digit;
  const b2PauseBtn = await evaluate(page, `(() => { const g = ${groupExpr(sA)}; return g !== null && g.querySelector('.ats-ask-pause') !== null; })()`);
  record('c-3-batch2-independent', COUNTING.test(b2Text) && b2PauseBtn === true
    && b2Digit !== null && b2Digit >= 18 && b2Digit <= 29,
    `批 2 照表计时（倒计时数字 ${String(b2Digit)} s ∈ [18,29] + 开关显「暂停计时」）：${b2Text.slice(0, 100)}`);
  await screenshot(page, `${SHOT_DIR}\\r49-batch-pause-b2-counting.png`);

  // 墙钟越过全额窗口 → 照表合成放行。锚句出现后客户端面板要等下一拍轮询（500 ms
  // 级）才翻过期态——徽标用有界等待，不用瞬时读（r36 首跑竞速教训的同类）。
  marks.b2SettledBy = marks.b2Seen + PAST_WINDOW_MS;
  let b2Released = false;
  while (Date.now() < marks.b2SettledBy + 20000) {
    if (await released(sA)) { b2Released = true; break; }
    await sleep(2000);
  }
  let b2ExpiredBadge = false;
  if (b2Released) {
    b2ExpiredBadge = await waitFor(page,
      `(() => { const g = ${groupExpr(sA)}; return g !== null && g.querySelector('.ats-ask-expired') !== null; })()`,
      (v) => v === true, 8000);
  }
  marks.b2ReleasedAt = Date.now();
  const b2RelMs = marks.b2ReleasedAt - marks.b2Seen;
  marks.b2RelMs = b2RelMs;
  // r51 盲审 F1：放行时刻窗——距组首见 ∈ [20s, 33s]（全额 30 s 减面板链路时延
  // 加检测余量）。早合成（如继承剩余直接放行）必红；上限仍守「越界后放行」。
  record('c-4-batch2-released', b2Released && b2ExpiredBadge === true
    && b2RelMs >= 20000 && b2RelMs <= 33000,
    `批 2 越全额窗口照表放行（锚句=${String(b2Released)}、徽标=${String(b2ExpiredBadge)}、放行距首见 ${String(b2RelMs)} ms ∈ [20000,33000]）`);
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
  // 暂停前先烧 ~10 s（复审 N1：首记剩余锚必须离全额窗口足够远——30 s 重置会
  // 显示 ~29–30，锚落在 ~14–20 s 时「锚−4..0」判据有 ≥9 s 判别裕量）。
  await sleep(10000);
  const aPause1Text = await groupTextOf(page, sIsoA);
  marks.aDigitAtPause1 = countdownDigit(aPause1Text);
  // 只暂停 A——B 必须照表。
  const pauseA = await clickInGroup(page, sIsoA, '.ats-ask-pause');
  await sleep(2000);
  const textA = await groupTextOf(page, sIsoA);
  const textB = await groupTextOf(page, sIsoB);
  record('d-2-a-paused-b-counting', pauseA === 'clicked' && PAUSED_TEXT.test(textA)
    && COUNTING.test(textB) && !PAUSED_TEXT.test(textB) && marks.aDigitAtPause1 !== null,
    `A 已暂停（暂停前首记锚 ${String(marks.aDigitAtPause1)} s）、B 仍数字倒计时（A 的暂停不触碰 B）：A=${textA.slice(0, 60)} ‖ B=${textB.slice(0, 60)}`);
  await screenshot(page, `${SHOT_DIR}\\r49-batch-pause-iso-contrast.png`);

  // ══ (d-6) B 活动计时中的恢复对照（复审 N1/N4 收紧）═══════════════════
  // A 的判据对**暂停前首记锚**：恢复后数字 ∈ 锚−4..0（暂停冻结携带的剩余；
  // 全额重置显示 ~29–30 ⇒ 必红——不再用恢复后读数自身当「非全窗口」证据）。
  // B 的判据：严格下降且降幅 ≤4（重置跳升/冻结停摆必红；细粒度平移由 d-3 锚窗守）。
  const bPause1Text = await groupTextOf(page, sIsoB);
  marks.bAnchorAt = Date.now();
  marks.bDigit1 = countdownDigit(bPause1Text);
  const resumeA1 = await clickInGroup(page, sIsoA, '.ats-ask-resume');
  marks.d6ResumeAt = Date.now();
  const aResumedText = await waitForCountingText(page, sIsoA, 5000);
  // 读数间隔保底 ≥1.5 s（ceil 显示在同一秒窗内不翻牌——活体也会「相等」；
  // 保证真实流逝后，活体必降 ≥1、冻结世界读数相等 ⇒ 如实红。首跑 18→18 实录）。
  while (Date.now() - marks.bAnchorAt < 1500) await sleep(200);
  const bDuringText = await groupTextOf(page, sIsoB);
  const aDigit1 = countdownDigit(aResumedText);
  const bDigit2 = countdownDigit(bDuringText);
  marks.d6ADigit = aDigit1; marks.d6BDigit2 = bDigit2;
  const d6aOk = resumeA1 === 'clicked' && COUNTING.test(aResumedText)
    && marks.aDigitAtPause1 !== null && aDigit1 !== null
    && aDigit1 <= marks.aDigitAtPause1 && aDigit1 >= marks.aDigitAtPause1 - 4;
  const d6bOk = marks.bDigit1 !== null && bDigit2 !== null
    && bDigit2 < marks.bDigit1 && bDigit2 >= marks.bDigit1 - 4;
  await screenshot(page, `${SHOT_DIR}\\r49-batch-pause-d6-resume-while-b-counting.png`);
  // 再暂停回 d-3 前提（B 放行时 A 冻结在场）——暂停前读第二次锚（d-4/d-5 同源口径）。
  const aPause2Text = await groupTextOf(page, sIsoA);
  marks.aDigitAtPause2 = countdownDigit(aPause2Text);
  const pauseA2 = await clickInGroup(page, sIsoA, '.ats-ask-pause');
  await sleep(2000);
  const aRefrozen = await groupTextOf(page, sIsoA);
  record('d-6-resume-while-b-counting', d6aOk && d6bOk && pauseA2 === 'clicked'
    && PAUSED_TEXT.test(aRefrozen) && marks.aDigitAtPause2 !== null,
    `B 计时中恢复 A：A 数字 ${String(marks.aDigitAtPause1)}→${String(aDigit1)} s（∈ 首记锚−4..0——全额重置必红）、B ${String(marks.bDigit1)}→${String(bDigit2)} s（严格下降且降幅≤4）；再暂停前二次锚 ${String(marks.aDigitAtPause2)} s：A=${aResumedText.slice(0, 40)} ‖ B=${bDuringText.slice(0, 40)}`);

  // B 照表走到期合成放行（A 仍暂停中——B 的放行就是「没被冻住」的活体证据）。
  // 复审 N4：放行时刻对「读锚时刻＋锚数字」双侧限界——期望 ≈ bAnchorAt +
  // bDigit1 秒；超出 −5/+7 s 容差窗的平移/重挂与早放行必红；窗内小幅平移
  // 可能被接受——细粒度隔离由单元 K13/K3 承担（粒度=秒级显示＋2 s 轮询）。
  let bRel = false;
  const bDeadline = marks.bAnchorAt + marks.bDigit1 * 1000 + 15000;
  while (Date.now() < bDeadline) {
    if (await released(sIsoB)) { bRel = true; break; }
    await sleep(2000);
  }
  marks.isoBReleasedAt = Date.now();
  const aStillFrozen = await groupTextOf(page, sIsoA);
  const aReleasedEarly = await released(sIsoA);
  const bAnchorMs = marks.isoBReleasedAt - marks.bAnchorAt;
  marks.isoBAnchorMs = bAnchorMs;
  const bWindowOk = marks.bDigit1 !== null
    && bAnchorMs >= marks.bDigit1 * 1000 - 5000 && bAnchorMs <= marks.bDigit1 * 1000 + 7000;
  record('d-3-b-released-on-schedule', bRel && bWindowOk
    && PAUSED_TEXT.test(aStillFrozen) && !aReleasedEarly,
    `B 对锚放行（放行−读锚 ${String(bAnchorMs)} ms ≈ 锚 ${String(marks.bDigit1)} s ±[−5,+7] s——超出容差窗的平移/重挂/早放必红，窗内小幅平移可能被接受（细粒度隔离由单元 K13/K3 承担））且 A 仍冻结未放行`);
  await screenshot(page, `${SHOT_DIR}\\r49-batch-pause-iso-b-released.png`);

  // A 第二次恢复——不触碰 B：B 组保持已超时态（不出现新倒计时）；A 数字对
  // **二次锚**口径（复审 N1：全额重置显示 ~29–30 > 锚+4 ⇒ 必红）。
  marks.isoAResume2At = Date.now();
  const resumeA = await clickInGroup(page, sIsoA, '.ats-ask-resume');
  const aAfterResume = await waitForCountingText(page, sIsoA, 5000);
  const bAfterResume = await groupTextOf(page, sIsoB);
  const aDigit2 = countdownDigit(aAfterResume);
  marks.isoADigit2 = aDigit2;
  // B 的徽标同样用有界等待（瞬时读在重渲拍上抖过一次——与 c-4 同族竞态）。
  const bBadge = await waitFor(page,
    `(() => { const g = ${groupExpr(sIsoB)}; return g !== null && g.querySelector('.ats-ask-expired') !== null; })()`,
    (v) => v === true, 8000);
  const d4aOk = resumeA === 'clicked' && COUNTING.test(aAfterResume)
    && marks.aDigitAtPause2 !== null && aDigit2 !== null
    && aDigit2 <= marks.aDigitAtPause2 && aDigit2 >= marks.aDigitAtPause2 - 4;
  record('d-4-resume-isolated', d4aOk
    && bBadge === true && !COUNTING.test(bAfterResume) && PAUSED_TEXT.test(bAfterResume) === false,
    `A 恢复数字 ${String(aDigit2)} s ∈ 二次锚 ${String(marks.aDigitAtPause2)} −4..0（全额重置必红）；B 保持已超时态（无新倒计时、未被平移重挂；resume=${String(resumeA)}、badge=${String(bBadge)}）：A=${aAfterResume.slice(0, 50)} ‖ B=${bAfterResume.slice(0, 50)}`);
  await screenshot(page, `${SHOT_DIR}\\r49-batch-pause-iso-a-resumed.png`);

  // A 按剩余平移放行——放行时刻对**二次锚**双侧限界（复审 N1：期望 ≈
  // resume2 + 二次锚秒数；全额重置 ≈30 s，锚 ≤21 s 时上界 ≤28 s ⇒ 必红。
  // 细粒度（1–4 s 级）由单元 K13/K3 承担，此处粒度=秒级显示＋2 s 轮询）。
  let aRel = false;
  const aDeadline = Date.now() + marks.aDigitAtPause2 * 1000 + 15000;
  while (Date.now() < aDeadline) {
    if (await released(sIsoA)) { aRel = true; break; }
    await sleep(2000);
  }
  marks.isoAReleasedAt = Date.now();
  const aRelMs = marks.isoAReleasedAt - marks.isoAResume2At;
  marks.isoARelMs = aRelMs;
  const aWindowOk = marks.aDigitAtPause2 !== null
    && aRelMs >= marks.aDigitAtPause2 * 1000 - 5000 && aRelMs <= marks.aDigitAtPause2 * 1000 + 7000;
  record('d-5-a-released-after-resume', aRel && aWindowOk,
    `A 恢复后对二次锚放行（${String(aRelMs)} ms ≈ ${String(marks.aDigitAtPause2)} s ±[−5,+7]——全额重置≈30 s 必红；锚句=${String(aRel)}）`);

  // 收尾清面板——只动本次创建会话的组（r51 盲审建议：共享实例不误伤他人）。
  const own = [sA, sIsoA, sIsoB].filter(Boolean);
  const leftover = await clearPanel(page, own);
  record('cleanup', leftover === 0, `本次会话清空（自建组残留待答 ${String(leftover)} 条）`);
  return browser;
}

let restore = null;
let openedBrowser = null;
// 证据指纹（复审 N2/N4：**实测**，不接受环境自报）：profile link 行 + node_modules
// junction 的 OS 级解析目标（realpath——装载器解析的真实终点）+ 实体 package.json
// 版本 + BUILD-STAMP + lib/ask-takeover.js / client.js / lib/host.js 的 sha256
// 前 16 位 + pluginManager/listPlugins 原始行 + /version 尝试。baseUrl 只记 origin
//（令牌绝不落盘）；R49_ENTITY_HINT 降级为旁注标签，不充当指纹。
// 证明边界（R56，复审 T2 如实登记）：文件腿只证**磁盘实体**身份——已加载内存
// 模块与磁盘文件的同一性、宿主版本（/version 非 200 时）不在本探针证明范围；
// 指纹缺席/采集失败不改变探针退出码（行为判据与实体取证分层，不冒充）。
const probeEnv = {
  baseUrl: null,
  entityHint: process.env.R49_ENTITY_HINT ?? null,
  node: process.version,
  windowMs: WINDOW_MS,
  pastWindowMs: PAST_WINDOW_MS,
  fingerprint: null
};

/** 实测指纹采集（每段独立 try——单段缺席留 null/错误串，不炸整跑）。文件腿的
 *  profile 目录经 `R49_PROFILE_DIR` 传入（实例坐标不进代码——与 _rpc.mjs 的
 *  本机平面纪律同源；缺席则该段留注记，其余腿照采）。 */
async function collectFingerprint(baseUrl) {
  const fp = {};
  const profDir = process.env.R49_PROFILE_DIR;
  if (profDir === undefined || profDir === '') {
    fp.filesNote = 'R49_PROFILE_DIR 未设置——文件腿（link 行/junction 解析/实体版本与哈希）未采；跑取证时由部署命令传入';
  } else try {
    const pkgRaw = readFileSync(join(profDir, 'package.json'), 'utf8');
    const row = /"dsh-async-tools"\s*:\s*"link:([^"]+)"/.exec(pkgRaw);
    fp.profileLinkRow = row === null ? null : row[1];
    const resolved = realpathSync(join(profDir, 'node_modules', 'dsh-async-tools'));
    fp.junctionTarget = resolved;
    const entPkg = JSON.parse(readFileSync(join(resolved, 'package.json'), 'utf8'));
    fp.entityVersion = entPkg.version ?? null;
    try { fp.buildStamp = readFileSync(join(resolved, 'BUILD-STAMP'), 'utf8').trim(); } catch { fp.buildStamp = null; }
    const { createHash } = await import('node:crypto');
    const hashOf = (p) => {
      try { return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16); } catch { return null; }
    };
    fp.hashes = {
      libAskTakeover: hashOf(join(resolved, 'lib', 'ask-takeover.js')),
      client: hashOf(join(resolved, 'client.js')),
      libHost: hashOf(join(resolved, 'lib', 'host.js'))
    };
  } catch (error) { fp.filesError = String(error?.message ?? error); }
  try {
    const plugins = await rpc('pluginManager/listPlugins', {});
    fp.pluginsRows = plugins.filter?.((x) => JSON.stringify(x).includes('async-tools')) ?? [];
  } catch (error) { fp.pluginsError = String(error?.message ?? error); }
  try {
    const res = await fetch(new URL('/version', baseUrl), { signal: AbortSignal.timeout(5000) });
    fp.hostVersion = res.ok ? (await res.text()).slice(0, 120) : `http-${String(res.status)}`;
  } catch (error) { fp.hostVersion = `unreachable: ${String(error?.message ?? error)}`; }
  // 证据自述（R56）：证明边界随指纹落盘，读证据的人不必翻代码即知未覆盖项。
  fp.identityLimits = '文件腿只证磁盘实体身份；已加载内存模块与磁盘文件的同一性、'
    + '宿主版本（/version 非 200 时）未核验；指纹缺席不改变探针退出码';
  return fp;
}
// 设置复原留痕（test-review-r50 F1）：attempted/ok/attempts 进证据 json；复原
// 失败必须打进退出码——「判据全绿但实例设置没复原」不是绿跑。
const settingsRestore = { attempted: false, ok: null, attempts: 0 };
try {
  const setup = await setupTakeover();
  restore = setup.restore;
  openedBrowser = await main();
} catch (error) {
  record('fatal', false, String(error?.stack ?? error));
} finally {
  if (openedBrowser !== null && openedBrowser !== undefined) openedBrowser.close();
  if (restore !== null) {
    settingsRestore.attempted = true;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      settingsRestore.attempts = attempt;
      const ok = await restore().then(() => true, (error) => {
        console.log(`restore 第 ${String(attempt)} 次失败：${String(error?.message ?? error)}`);
        return false;
      });
      if (ok) { settingsRestore.ok = true; break; }
      settingsRestore.ok = false;
      await sleep(2000);
    }
  }
}
const path = `${LOG_DIR}\\r49-batch-pause.json`;
writeFileSync(path, JSON.stringify({ results, marks, settingsRestore, env: probeEnv, at: new Date().toISOString() }, null, 2), 'utf8');
const failed = results.filter((r) => !r.ok).length;
const exitOk = failed === 0 && settingsRestore.ok !== false;
console.log(`\n探针结束：${String(results.length - failed)}/${String(results.length)} 通过；设置复原=${settingsRestore.ok === true ? 'ok' : String(settingsRestore.ok)}；证据 ${path}`);
process.exit(exitOk ? 0 : 1);
