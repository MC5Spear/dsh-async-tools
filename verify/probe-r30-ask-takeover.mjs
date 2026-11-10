/**
 * 提问接管真机探针（设计 §4.1–4.4／需求 §4，判据⓪–⑧）。
 *
 * 两相用法：
 * - 主相：`node verify/probe-r30-ask-takeover.mjs`（判据⓪①②③④⑥⑦⑧；收尾**故意
 *   留着** `askTakeover=true` —— 判据⑤要穿过重启验证持久化）。
 * - 重启相：操作者按三道安全检查重启验证实例（无 running 会话、近 10 分钟无活动、
 *   操作会话不在其进程树）后 `node verify/probe-r30-ask-takeover.mjs --after-restart`
 *   （判据⑤：设置仍开 + 提问仍被接管；收尾复原全部默认）。
 *
 * 判据（设计 §4.1–4.4／需求 §4）：
 * - ⓪ 座位默认（需求 §5.2·设计 §4.3）：清掉 askUiSeat 的用户层覆盖（patch null）
 *   → 生效值 sidebar；接管开时提问 → **徽标**在场（.ats-ask-badge ≥ 1）、浮框缺席。
 *   随后显式 overlay（同条件）→ 浮框在场（②接手）——默认档与显式档两步对照；
 *   实例若不支持 null 清层则本步降级为留痕跳过（不算通过也不算失败）。
 * - ① `dsh-async` 会话让 Agent 提问 → 10 s 窗口耗尽 → 转录含合成超时答案
 *   （en 档 `ask.timeoutCustom` 锚句）且模型继续工作（turn/end + 后续 assistant 文本）。
 * - ② overlay 出现（`.ats-ask-panel`）且计数正确；等超时徽标出现后对选项 chip 真实
 *   点击 + 提交 → 转录出现**通知形触发行**（迟到正文锚 + 转录源对象带
 *   `kind=async-tools-late-answer`/`form=notice`/summary——非用户消息气泡，
 *   设计 §4.4）→ Agent 空闲后被唤醒续答（answer 通道端到端：typert 标记 → 裸传
 *   载荷 → 注册表迟到注入 followup）。锚句随实例 `agentLang` 双档自适应
 *   （共享实例的语言档可能被并行轮/用户置 zh，探针不强制改回）。
 * - ③ `standard` 对照会话：原生问题卡（`.Mbwy4a_card`，user-questions 官方包）
 *   出现在 DOM、本包的浮框与徽标**都不在场**（条件②行为证据）；随后经原生卡作答
 *   释放会话（顺证原生链未被接管路径损伤）。
 * - ④ `askUiSeat='sidebar'` 后再问 → 徽标（`.ats-ask-badge`）在场、浮框缺席；
 *   点徽标浮框出现（纯呈现层切换，实例环境同 ③）。
 * - ⑤ 重启验证实例 → 设置与行为不变（开关仍开、提问仍被接管）；复原到探针固定档。
 * - ⑥ 等待期间作答：Agent 发长跑作业 → 提问（超时放行）→ 进入 `async_wait`
 *   长等待；此时对超时批作答 → 迟到作答事件（需求 §4.4：插件事件 + 起始检查）
 *   唤醒等待 → 工具**提前返回运行句柄**（tool/result 渲染文含 note 锚句「迟到作答已到/A late answer
 *   has arrived」+「仍在运行」语义；无打断锚——非 interrupted、非终态；真
 *   机读数：转录 tool/result 是渲染文本，无结构化 status 字段）；后续回合读到
 *   通知正文。
 * - ⑦ 语言四组合（需求 §5.3）：宿主语言用 `--lang` 启动开关分起两个无头实例
 *   （zh-CN 宿主 = 默认启动 / en-US 宿主 = `--lang=en-US`；真机读数：
 *   `Emulation.setLocaleOverride` 在本机 headless Edge 上不改变
 *   `navigator.language`）× `uiLang`（auto/zh/en）四组合下待答面板文案语言
 *   正确（auto 跟宿主；zh/en 钉住本包词典）。
 * - ⑧ 通道与整批领取（需求 §4.4）：(a) 子代理等待期间作答不排队——正文
 *   当回合进入上下文（点答到正文送达 < 25 s，非等待预算耗尽后），wait 唤醒
 *   返回带 note 锚；(b) 空闲时两秒内乱序连答三题——首条立即开回合，其余并入
 *   该回合下一领取点**整批领取**（转录相邻通知记录无间隔），新增 turn/end ≤ 2
 *   （判基线：串行开回是缺陷形态）。
 *
 * 证据：本机证据目录 logs/r30-ask-takeover{-after-restart}.json + shots/r30-*.png。
 * 前置：验证实例在听；本包宿主行已随 0.2.0 装载（验证实例的 DSH_HOME 插件树）。
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rpc, transcriptOf, localConfig } from './_rpc.mjs';
import { newSession, prompt, waitTurnEnd, lastAssistantText, readNs, patchNs, PRESET } from './_r28-helpers.mjs';
import { WAIT_INTERRUPTED, LATE_ANSWER_ARRIVED, LATE_ANSWER_SUMMARY } from './message-markers.mjs';
import { findBrowser, launch, openPage, evaluate, waitFor, screenshot } from './_visual/cdp.mjs';

const LOGS = join(localConfig.evidenceDir, 'logs');
const SHOTS = join(localConfig.evidenceDir, 'shots');
mkdirSync(LOGS, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

// —— 锚句 ——
// note/summary 取共享锚模块（verify/message-markers.mjs，两语成对、漂移由
// test/message-markers.test.mjs 的 t() 两档渲染回归钉住）。共享锚是「en|zh」
// 合一正则，而本探针使用点是字符串 includes 语义——按内容拆出各档字面量
// （这两枚锚的 source 无转义、两半中恰一半为纯 ASCII——en 半边）。
// timeout/late/delay 留本地：timeout 是「词典前缀＋场景秒数 10」复合、
// late 与 delay 是 ask.lateAnswer＋ask.lateIgnore 两键共用的跨键片段（按
// 设计 §8.3 口径不入共享锚；改词典文案时须同步这里）。
// 双档锚（真机读数）：验证实例是共享实例，agentLang 可能被并行轮/用户置
// zh——锚句随实例实况选档，不强制改别人的 agentLang。
const anchorTiers = (anchor) => {
  const halves = anchor.source.split('|');
  return {
    en: halves.find((s) => /^[\x20-\x7F]+$/.test(s)),
    zh: halves.find((s) => !/^[\x20-\x7F]+$/.test(s))
  };
};
const NOTE_TIERS = anchorTiers(LATE_ANSWER_ARRIVED);
const SUMMARY_TIERS = anchorTiers(LATE_ANSWER_SUMMARY);
const ANCHORS = {
  en: {
    timeout: 'The user has not answered within 10 s',
    late: '[Late answer]',
    note: NOTE_TIERS.en,
    summary: SUMMARY_TIERS.en,
    delay: 'Delay:'
  },
  zh: {
    timeout: '用户暂未作答（等待 10 秒超时）',
    late: '[迟到作答]',
    note: NOTE_TIERS.zh,
    summary: SUMMARY_TIERS.zh,
    delay: '时延：提问后'
  }
};
/** 本轮实例的锚句档（mainPhase 前置时按 agentLang 选定；after-restart 同法重选）。 */
let A = ANCHORS.en;
// 迟到作答通知形（设计 §4.4）：迟到作答消息的自声明源（与 lib/interrupts.js LATE_ANSWER_SOURCE 同串）。
const LATE_KIND = 'async-tools-late-answer';
const ASK_TOOL = 'ask_user_question';
const WAIT_JOB_TOOL = 'async_wait';
// ⑦ 语言四组合的期望标题（与 client.js 词典 zh/en 的 ask.title 逐字一致）。
const TITLE_ZH = '待答问题';
const TITLE_EN = 'Pending questions';

const results = [];
const log = { at: new Date().toISOString() };

/**
 * 记一条判据。
 * @param {string} name - 判据名。
 * @param {boolean} ok - 结论。
 * @param {string} detail - 读数。
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'OK    ' : 'WRONG '} ${name}${detail === '' ? '' : `\n          ${detail}`}`);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 转录全文化（判据锚句检索范围）。 */
function transcriptText(transcript) {
  const parts = [];
  for (const record of transcript.records ?? []) {
    parts.push(JSON.stringify(record.event?.data ?? {}));
  }
  return parts.join('\n');
}

/** 转录里是否出现了 ask_user_question 的 tool/call。 */
function hasAskCall(transcript) {
  return (transcript.records ?? []).some((r) => r.event?.type === 'tool/call'
    && r.event.data?.name === ASK_TOOL);
}

/** 让 Agent 提一道双色题（题目文本与选项钉死，探针才好点）。 */
const ASK_PROMPT = 'Call the ask_user_question tool with exactly one question: '
  + 'question text "Pick a color", two options "red" and "blue", no multiSelect. '
  + 'After you receive the answer, reply with one short sentence naming the chosen color.';

/**
 * 起无头浏览器开验证实例页面。
 * @param {string[]} [launchArgs] - 追加启动参数（⑦ 的 en 宿主用 `--lang=en-US`）。
 * @returns {Promise<{instance: object, page: object}>}
 */
async function openApp(launchArgs = []) {
  const rawLine = readFileSync(localConfig.tokenFile, 'utf8').trim();
  const appUrl = rawLine.slice(rawLine.indexOf('http'));
  const browser = findBrowser();
  if (browser === undefined) throw new Error('找不到 Edge/Chrome（CDP 探针需要）');
  const instance = await launch(browser, launchArgs);
  const page = await openPage(instance.port, 'about:blank');
  await page.send('Page.navigate', { url: appUrl });
  await waitFor(page, 'document.querySelectorAll("#root *").length', (n) => Number(n) > 20, 30_000);
  return { instance, page };
}

/** DOM 计数助手。 */
const countOf = (selector) => `document.querySelectorAll("${selector}").length`;

/**
 * 会话组定位（真机实测：同时会有多批）：expired 批按设计留列供迟到作答——面板里同时会有
 * 历史批与本轮批。所有断言与点击都必须**落在目标会话的组里**（组头文本
 * `session <id 前 8 位>`），不能数全局。
 */
function groupExpr(sessionId) {
  return `(() => {
    const groups = [...document.querySelectorAll(".ats-ask-group")];
    const prefix = "session ${String(sessionId).replace(/^session-/, '').slice(0, 8)}";
    return groups.find((g) => g.querySelector(".ats-ask-grouphead span")?.textContent === prefix) ?? null;
  })()`;
}

/** 组内 chips 数。 */
const chipsIn = (sessionId) => `(() => { const g = ${groupExpr(sessionId)}; return g === null ? -1 : g.querySelectorAll(".ats-ask-chip").length; })()`;

/** 组内超时徽标数。 */
const expiredIn = (sessionId) => `(() => { const g = ${groupExpr(sessionId)}; return g === null ? -1 : g.querySelectorAll(".ats-ask-expired").length; })()`;

/** 组是否在场（布尔——CDP 不能把 DOM 元素直接回传，会炸 Object reference chain）。 */
const groupPresent = (sessionId) => `(() => { const g = ${groupExpr(sessionId)}; return g !== null; })()`;

/** 在目标会话的组里点第一个选项 chip 并提交（②/④ 的作答动作——组内定位）。 */
async function clickFirstOptionAndSubmit(page, sessionId) {
  await evaluate(page, `(() => {
    const g = ${groupExpr(sessionId)};
    if (g === null) throw new Error("目标会话的待答组不在 DOM 里");
    g.querySelector(".ats-ask-chip").click();
  })()`);
  await sleep(150);
  await evaluate(page, `(() => {
    const g = ${groupExpr(sessionId)};
    if (g === null) throw new Error("目标会话的待答组不在 DOM 里（提交前消失）");
    g.querySelector(".ats-ask-submit").click();
  })()`);
}

// ══ 主相（①–⑦）═══════════════════════════════════════════════════════════

/** 起始快照（前置前读；复原按它回写——不动共享实例上别人的字段值）。 */
let nsBefore = null;

async function mainPhase() {
  console.log('· 前置：接管开 + 窗口 10 s + 界面 auto + 座位清层（默认档先行；agentLang 按实例实况选锚档）');
  nsBefore = (await readNs()).value;
  log.nsBefore = nsBefore;
  A = nsBefore?.agentLang === 'zh' ? ANCHORS.zh : ANCHORS.en;
  log.anchorLang = nsBefore?.agentLang === 'zh' ? 'zh' : 'en';
  // 座位/界面语言是本探针的判定对象，前置归一；agentLang 不动（并行轮可能在用）。
  // askUiSeat=null 是**清层**（去掉用户层覆盖）——默认档判据（⓪）需要真正的
  //「无覆盖」：宿主配置行与用户层都没写这个字段，生效值只能来自 schema 默认 sidebar。
  let seatUnsetOk = true;
  try {
    await patchNs({ askTakeover: true, askTimeoutMs: 10000, uiLang: 'auto', askUiSeat: null });
  } catch (error) {
    seatUnsetOk = false;
    log.seatUnsetError = String(error);
    console.log(`  （askUiSeat=null 清层不被支持：${String(error)}；⓪ 降级为留痕跳过）`);
    await patchNs({ askTakeover: true, askTimeoutMs: 10000, uiLang: 'auto' });
  }
  const ns = await readNs();
  check('前置 开关开 + 窗口 10 s + auto + 默认座位 sidebar（回读比对）',
    ns?.value?.askTakeover === true && ns?.value?.askTimeoutMs === 10000
    && ns?.value?.askUiSeat === 'sidebar' && ns?.value?.uiLang === 'auto',
    `读数=${JSON.stringify(ns?.value)}`);

  const { instance, page } = await openApp();
  try {
    // —— ⓪ 座位默认档（无覆盖 → 徽标；需求 §5.2·设计 §4.3）——
    if (seatUnsetOk) {
      console.log('· ⓪ askUiSeat 无覆盖 → 生效 sidebar → 徽标在场、浮框缺席');
      const s0 = await newSession(PRESET);
      log.session0 = s0;
      await prompt(s0, ASK_PROMPT);
      const badgeCount = await waitFor(page, countOf('.ats-ask-badge'), (n) => Number(n) >= 1, 60_000);
      const panel0 = Number(await evaluate(page, countOf('.ats-ask-panel'))) || 0;
      check('⓪-a 默认座位徽标在场（.ats-ask-badge ≥ 1）', Number(badgeCount) >= 1,
        `徽标数=${String(badgeCount)}`);
      check('⓪-b 默认座位浮框缺席（.ats-ask-panel = 0）', panel0 === 0,
        `面板数=${String(panel0)}`);
      await screenshot(page, join(SHOTS, 'r30-0-default-sidebar-badge.png'));
    } else {
      // 留痕跳过：不算通过也不算失败——总判定行会把它带进分子，但 ok=true 只是
      //「没有失败」，skipped=true 与 detail 里的清层报错才是它的真实身份。
      results.push({ name: '⓪ 座位默认档（askUiSeat=null 清层不受支持，留痕跳过）', ok: true, skipped: true, detail: log.seatUnsetError ?? '' });
      console.log('  SKIP  ⓪ 座位默认档（清层不受支持，见 log.seatUnsetError）');
    }

    // —— ⓪-b 显式 overlay（前置 B；①② 在此档执行）——
    console.log('· 前置 B：显式 askUiSeat=overlay（显式选择保持原值、不被清洗——与 ⓪ 两步对照）');
    await patchNs({ askUiSeat: 'overlay' });
    const nsB = await readNs();
    check('⓪-c 显式 overlay 回读在位（不被清洗回默认）',
      nsB?.value?.askUiSeat === 'overlay', `读数=${JSON.stringify(nsB?.value)}`);

    // —— ① 超时放行（合成答案 + 模型继续）——
    console.log('· ① dsh-async 提问 → 超时合成 → 模型继续');
    const s1 = await newSession(PRESET);
    log.session1 = s1;
    await prompt(s1, ASK_PROMPT);
    const t1 = await waitTurnEnd(s1, 120_000);
    const text1 = transcriptText(t1);
    check('①-a ask_user_question 真的发了（tool/call 在场）', hasAskCall(t1),
      `转录长度=${String((t1.records ?? []).length)}`);
    check(`①-b 超时合成答案在场（${log.anchorLang} 锚句逐字）`, text1.includes(A.timeout),
      `锚句命中=${String(text1.includes(A.timeout))}`);
    check('①-c 模型继续工作（turn/end 后仍有 assistant 文本）',
      lastAssistantText(t1).length > 0,
      `末条 assistant 文本=${JSON.stringify(lastAssistantText(t1).slice(0, 120))}`);

    // —— ② overlay + 超时后点击（迟到作答端到端）——
    console.log('· ② overlay 出现 → 等超时徽标 → CDP 点击 chip → 迟到注入');
    const s2 = await newSession(PRESET);
    log.session2 = s2;
    await prompt(s2, ASK_PROMPT);
    const panelCount = await waitFor(page, countOf('.ats-ask-panel'), (n) => Number(n) >= 1, 60_000);
    check('②-a overlay 浮框出现（.ats-ask-panel ≥ 1）', Number(panelCount) >= 1,
      `面板数=${String(panelCount)}`);
    const chipCount = await waitFor(page, chipsIn(s2), (n) => Number(n) >= 2, 20_000);
    check('②-b 目标会话组内两个选项 chip 在场（组内定位——expired 批按设计留列，全局数无意义）',
      Number(chipCount) === 2, `组内 chip 数=${String(chipCount)}`);
    await screenshot(page, join(SHOTS, 'r30-2-overlay-open.png'));
    const expiredMark = await waitFor(page, expiredIn(s2), (n) => Number(n) >= 1, 20_000);
    check('②-c 超时后目标组仍在且带超时徽标（expired 批留列——迟到作答入口）',
      Number(expiredMark) >= 1, `组内超时标记数=${String(expiredMark)}`);
    await screenshot(page, join(SHOTS, 'r30-2-overlay-expired.png'));
    // 点的是组内**第一条**条目——按 state 的 questionId 记住它（模型可能在收到迟到
    // 作答前重问同题，生成新的 expired 条目；②-f 只认被答的那条出列，真机读数）。
    const stateBeforeClick = await rpc('async-tools-ask/state', {});
    const s2ItemsBefore = (stateBeforeClick.items ?? stateBeforeClick).filter((i) => i.sessionId === s2);
    const answeredQid = s2ItemsBefore[0]?.questionId;
    await clickFirstOptionAndSubmit(page, s2);
    await sleep(1500);
    // 迟到作答的落点有两种（设计 §4.4）：第一回合仍在跑则**折进当前回合**（真机读数：10 s
    // 窗口一过期就点，模型多半还在作答——turn/end 恒为 1）；回合已收则开新回合。
    // 判据取锚句而非回合数：轮询转录至迟到正文锚在场（240 s 预算）。
    let t2 = await transcriptOf(s2);
    let text2 = transcriptText(t2);
    for (let i = 0; i < 120 && !text2.includes(A.late); i += 1) {
      await sleep(2000);
      t2 = await transcriptOf(s2);
      text2 = transcriptText(t2);
    }
    check(`②-d 转录出现迟到通知正文（${log.anchorLang} 锚句）`, text2.includes(A.late),
      `迟到锚句命中=${String(text2.includes(A.late))}`);
    // ②：注入是**通知形**（设计 §4.4）——转录源对象带自声明 kind ≠ 'user'、
    // form=notice、summary 在册；正文自含完整题目内容（题干/选项/multiSelect/时延）。
    check('②-d2 通知形源对象在场（kind=async-tools-late-answer + form=notice，非用户消息气泡）',
      text2.includes(`"kind":"${LATE_KIND}"`) && text2.includes('"form":"notice"'),
      `kind=${String(text2.includes(`"kind":"${LATE_KIND}"`))} form=${String(text2.includes('"form":"notice"'))}`);
    check('②-d3 summary 在册（一句话作答摘要）', text2.includes(A.summary),
      `summary 锚=${String(text2.includes(A.summary))}`);
    check('②-d4 正文自含题目内容（题干 + 选项 + multiSelect + 时延字段）',
      text2.includes('Pick a color') && text2.includes('multiSelect=false') && text2.includes(A.delay),
      `题干=${String(text2.includes('Pick a color'))} multiSelect=${String(text2.includes('multiSelect=false'))} 时延=${String(text2.includes(A.delay))}`);
    // ②-e Agent 续答：followup 唤醒开新回合后模型才回话——正文锚出现与 assistant
    // 回复之间有生成延迟，轮询等它（60 s 预算）而不是只看当下。
    let reply2 = '';
    for (let i = 0; i < 30 && reply2.length === 0; i += 1) {
      const latest = await transcriptOf(s2);
      reply2 = lastAssistantText(latest);
      if (reply2.length > 0) break;
      await sleep(2000);
    }
    check('②-e Agent 续答（迟到消息后的 assistant 文本）', reply2.length > 0,
      `末条=${JSON.stringify(reply2.slice(0, 120))}`);
    const stateAfterLate = await rpc('async-tools-ask/state', {});
    const s2ItemsAfter = (stateAfterLate.items ?? stateAfterLate).filter((i) => i.sessionId === s2);
    check('②-f 被答的那条出列（按 questionId；模型重问的新条目不算失败）',
      !s2ItemsAfter.some((i) => i.questionId === answeredQid),
      `被答 qid=${String(answeredQid)} 组内余条=${String(s2ItemsAfter.length)}（重问会产生新条目）`);

    // —— ⑥ 等待期间作答（迟到作答唤醒，需求 §4.4）——
    // 流程：长跑作业（150 s）→ 提问（10 s 超时放行）→ async_wait 长等待；
    // 轮询转录见到 wait 的 tool/call（订阅已挂）后对超时批作答 → followup 通知
    // 唤醒等待 → 工具提前返回运行句柄 + note（非 interrupted、非终态）。
    console.log('· ⑥ 等待期间作答：wait 中 followup 唤醒 → 运行句柄 + note');
    const s6 = await newSession(PRESET);
    log.session6 = s6;
    const ASK_PROMPT_6 = 'Do these steps in order. '
      + 'Step 1: run a shell command with the async_run tool (yield_ms=2000) that sleeps 150 seconds and then prints DONE. '
      + 'If that command looks killed at the process-creation layer (empty output, no exit-code marker), '
      + 'retry the exact same call once with sandbox_permissions set to danger-full-access. '
      + 'Step 2: call ask_user_question with exactly one question: question text "Pick a flavor", two options "mint" and "vanilla", no multiSelect. '
      + 'Step 3: call async_wait on the job from step 1 (targets=[{kind:"job", id:...}]) with wait_ms=180000. '
      + 'After the wait call returns, reply with one short sentence about what happened.';
    await prompt(s6, ASK_PROMPT_6);
    // 面板出现本会话组并等到超时徽标（10 s 窗口耗尽、批转 expired）。
    await waitFor(page, expiredIn(s6), (n) => Number(n) >= 1, 40_000);
    // 关键时序：必须等 wait 的 tool/call 进转录（此时订阅已挂）再点作答。预算 180 s
    // ——含沙箱进程创建层被杀后的 full-access 重试周期（真机读数）。
    let t6 = await transcriptOf(s6);
    let waitCallSeen = (t6.records ?? []).some((r) => r.event?.type === 'tool/call'
      && r.event.data?.name === WAIT_JOB_TOOL);
    for (let i = 0; i < 90 && !waitCallSeen; i += 1) {
      await sleep(2000);
      t6 = await transcriptOf(s6);
      waitCallSeen = (t6.records ?? []).some((r) => r.event?.type === 'tool/call'
        && r.event.data?.name === WAIT_JOB_TOOL);
    }
    check('⑥-a async_wait 已进入等待（tool/call 在转录）', waitCallSeen,
      `wait 调用=${String(waitCallSeen)}`);
    await screenshot(page, join(SHOTS, 'r30-6-waiting.png'));
    await clickFirstOptionAndSubmit(page, s6);
    // 轮询转录：wait 的 tool/result 带 note 锚句（唤醒提前返回）。真机形状（真机
    // 读数）：data.message.content[0].text 是**渲染文本**（note + 再等提示直文），
    // 没有结构化 status——⑥-b/⑥-c 都按这份文断言。
    let wakeResult = null;
    for (let i = 0; i < 60 && wakeResult === null; i += 1) {
      await sleep(2000);
      t6 = await transcriptOf(s6);
      const records = t6.records ?? [];
      for (let j = records.length - 1; j >= 0; j -= 1) {
        const record = records[j];
        if (record.event?.type !== 'tool/result') continue;
        const content = record.event.data?.message?.content;
        const text = Array.isArray(content) ? String(content[0]?.text ?? '') : '';
        if (text.includes(A.note)) { wakeResult = text; break; }
      }
    }
    check(`⑥-b 等待被唤醒提前返回（tool/result note 含迟到作答已到锚，${log.anchorLang} 档）`,
      wakeResult !== null, `命中=${String(wakeResult !== null)}`);
    if (wakeResult !== null) {
      // 运行句柄语义 = 渲染文含「仍在运行」（唤醒文＝wait.lateArrived 与再等提示
      // note.waitAgain 拼接，「仍在运行」来自后者——wait.lateArrived 本身不含该词），
      // 且不含打断锚（note.interrupted，两语锚取共享模块）。
      const runningHit = wakeResult.includes('仍在运行') || wakeResult.includes('still running');
      const interruptedHit = WAIT_INTERRUPTED.test(wakeResult);
      check('⑥-c 运行句柄非 interrupted 非终态（渲染文含「仍在运行」、无打断锚）',
        runningHit && !interruptedHit,
        `running=${String(runningHit)} interrupted=${String(interruptedHit)}`);
    } else {
      check('⑥-c 运行句柄非 interrupted 非终态（渲染文含「仍在运行」、无打断锚）', false, '⑥-b 未命中，无从判定');
    }
    const t6end = await waitTurnEnd(s6, 180_000);
    const text6 = transcriptText(t6end);
    check('⑥-d 后续回合读到通知正文（迟到正文锚 + summary）',
      text6.includes(A.late) && text6.includes(A.summary),
      `正文=${String(text6.includes(A.late))} summary=${String(text6.includes(A.summary))}`);
    check('⑥-e 模型继续工作（turn/end 后 assistant 文本）',
      lastAssistantText(t6end).length > 0,
      `末条=${JSON.stringify(lastAssistantText(t6end).slice(0, 120))}`);
    await screenshot(page, join(SHOTS, 'r30-6-after-wake.png'));

    // —— ⑧ 通道与整批领取（迟到作答通道联测，需求 §4.4 判据⑧）——
    // (a) 子代理等待期间作答不排队：正文当回合进入上下文（秒级），非等待预算耗尽后。
    console.log('· ⑧-a 子代理等待期间作答：秒级进上下文（不排队）');
    const s8a = await newSession(PRESET);
    log.session8a = s8a;
    const ASK_PROMPT_8A = 'Do these steps in order. '
      + 'Step 1: use the async_agent tool to start one continuable subagent whose task is: '
      + 'run a shell command that sleeps 150 seconds and then prints DONE '
      + '(if that command looks killed at the process-creation layer — empty output, no exit-code marker — '
      + 'retry the exact same call once with sandbox_permissions set to danger-full-access); label it "sleeper8a". '
      + 'Step 2: call ask_user_question with exactly one question: question text "Pick a season", '
      + 'two options "spring" and "winter", no multiSelect. '
      + 'Step 3: call async_wait on that subagent (targets=[{kind:"agent", id:...}]) with wait_ms=180000. '
      + 'After the wait call returns, reply with one short sentence naming the season you were told.';
    await prompt(s8a, ASK_PROMPT_8A);
    await waitFor(page, expiredIn(s8a), (n) => Number(n) >= 1, 40_000);
    // 关键时序：等 async_wait 的 tool/call 进转录（订阅已挂）再点作答。
    const WAIT_AGENT_TOOL = 'async_wait';
    let t8a = await transcriptOf(s8a);
    let waitAgentSeen = (t8a.records ?? []).some((r) => r.event?.type === 'tool/call'
      && r.event.data?.name === WAIT_AGENT_TOOL);
    for (let i = 0; i < 120 && !waitAgentSeen; i += 1) {
      await sleep(2000);
      t8a = await transcriptOf(s8a);
      waitAgentSeen = (t8a.records ?? []).some((r) => r.event?.type === 'tool/call'
        && r.event.data?.name === WAIT_AGENT_TOOL);
    }
    check('⑧-a-1 async_wait 已进入等待（tool/call 在转录）', waitAgentSeen,
      `wait 调用=${String(waitAgentSeen)}`);
    await screenshot(page, join(SHOTS, 'r30-8a-waiting.png'));
    const t8aClick = Date.now();
    await clickFirstOptionAndSubmit(page, s8a);
    // 轮询：迟到正文锚进入转录的时延。秒级 = 运行中走 inject、wait 返回后的下一
    // 领取点当回合领取（不排队到等待预算耗尽后——排队到预算耗尽后才交付是缺陷形态）。
    let late8aElapsed = -1;
    for (let i = 0; i < 150; i += 1) {
      await sleep(1000);
      const latest = await transcriptOf(s8a);
      if (transcriptText(latest).includes(A.late)) { late8aElapsed = Date.now() - t8aClick; break; }
    }
    check('⑧-a-2 作答正文秒级进入上下文（< 25 s，非等待预算耗尽后）',
      late8aElapsed >= 0 && late8aElapsed < 25_000, `点答到正文送达时延=${String(late8aElapsed)} ms`);
    const t8aMid = await transcriptOf(s8a);
    let wake8a = null;
    for (const record of t8aMid.records ?? []) {
      if (record.event?.type !== 'tool/result') continue;
      const content = record.event.data?.message?.content;
      const text = Array.isArray(content) ? String(content[0]?.text ?? '') : '';
      if (text.includes(A.note)) wake8a = text;
    }
    check('⑧-a-3 等待被唤醒提前返回（tool/result note 锚在场）', wake8a !== null,
      `命中=${String(wake8a !== null)}`);
    const t8aEnd = await waitTurnEnd(s8a, 180_000);
    check('⑧-a-4 模型消费了作答（assistant 文本提及季节词）',
      /spring|winter|春|冬/i.test(lastAssistantText(t8aEnd)),
      `末条=${JSON.stringify(lastAssistantText(t8aEnd).slice(0, 100))}`);

    // (b) 空闲时两秒内乱序连答三题：首条立即开回合，其余并入该回合下一领取点
    //     整批领取（转录相邻通知记录无间隔）——不串行开三个回合。
    console.log('· ⑧-b 空闲连答三题（乱序）：一个回合 + 同一领取点整批');
    const s8b = await newSession(PRESET);
    log.session8b = s8b;
    const ASK_PROMPT_8B = 'Call ask_user_question with exactly three questions, all no multiSelect: '
      + 'question "Pick a fruit A" with options "apple" and "apricot"; '
      + 'question "Pick a fruit B" with options "banana" and "blueberry"; '
      + 'question "Pick a fruit C" with options "cherry" and "cranberry". '
      + 'When you receive answers, reply with one short sentence naming one chosen fruit.';
    await prompt(s8b, ASK_PROMPT_8B);
    const t8bBase = await waitTurnEnd(s8b, 120_000);
    const turnEndsBefore = (t8bBase.records ?? []).filter((r) => r.event?.type === 'turn/end').length;
    // 超时合成（3 题全合成空选）后模型已收尾 → idle；三题都带超时徽标留列。
    await waitFor(page, expiredIn(s8b), (n) => Number(n) >= 3, 30_000);
    await sleep(2500); // 回合彻底收尾（idle 落定）——首答走 followup 立即开回合
    const clickAnswer8b = async (questionText, optionText) => {
      await evaluate(page, `(() => {
        const g = ${groupExpr(s8b)};
        if (g === null) throw new Error("s8b 组不在 DOM");
        const item = [...g.querySelectorAll(".ats-ask-q")]
          .find((q) => (q.querySelector(".ats-ask-text")?.textContent ?? "").startsWith("${questionText}"));
        if (item === undefined) throw new Error("题目 ${questionText} 不在 DOM");
        [...item.querySelectorAll(".ats-ask-chip")].find((c) => c.textContent === "${optionText}").click();
      })()`);
      await sleep(120);
      await evaluate(page, `(() => {
        const g = ${groupExpr(s8b)};
        const item = [...g.querySelectorAll(".ats-ask-q")]
          .find((q) => (q.querySelector(".ats-ask-text")?.textContent ?? "").startsWith("${questionText}"));
        if (item === undefined) throw new Error("题目 ${questionText} 提交前消失");
        item.querySelector(".ats-ask-submit").click();
      })()`);
    };
    // 乱序：C → A → B，间隔约 300 ms（两秒窗口内）。
    await clickAnswer8b('Pick a fruit C', 'cherry');
    await sleep(300);
    await clickAnswer8b('Pick a fruit A', 'apple');
    await sleep(300);
    await clickAnswer8b('Pick a fruit B', 'banana');
    let t8b = await transcriptOf(s8b);
    let text8b = transcriptText(t8b);
    const countLate8b = (text) => text.split(A.late).length - 1;
    for (let i = 0; i < 60 && countLate8b(text8b) < 3; i += 1) {
      await sleep(2000);
      t8b = await transcriptOf(s8b);
      text8b = transcriptText(t8b);
    }
    const turnEndsAfter = (t8b.records ?? []).filter((r) => r.event?.type === 'turn/end').length;
    check('⑧-b-1 三条迟到通知全部送达（late 锚 ×3）', countLate8b(text8b) >= 3,
      `late 计数=${String(countLate8b(text8b))}`);
    check('⑧-b-2 不串行开回合（新增 turn/end ≤ 2；串行开回是缺陷形态）',
      turnEndsAfter - turnEndsBefore <= 2, `turn/end delta=${String(turnEndsAfter - turnEndsBefore)}`);
    // 整批判据（需求 §4.4）：相邻两条迟到通知记录之间无任何其他记录（同一领取点领取）。
    const isLate8b = (r) => {
      const s = JSON.stringify(r.event?.data ?? {});
      return s.includes(`"kind":"${LATE_KIND}"`) && s.includes('"form":"notice"');
    };
    let adjacent8b = false;
    const recs8b = t8b.records ?? [];
    for (let i = 0; i + 1 < recs8b.length; i += 1) {
      if (isLate8b(recs8b[i]) && isLate8b(recs8b[i + 1])) { adjacent8b = true; break; }
    }
    check('⑧-b-3 同一领取点整批领取（相邻两条通知记录无间隔）', adjacent8b,
      `相邻命中=${String(adjacent8b)}`);
    await screenshot(page, join(SHOTS, 'r30-8b-batch.png'));

    // —— ④ 座位切换（sidebar 徽标；纯呈现层）——
    console.log('· ④ askUiSeat=sidebar → 徽标在场、浮框缺席');
    await patchNs({ askUiSeat: 'sidebar' });
    const s4 = await newSession(PRESET);
    log.session4 = s4;
    await prompt(s4, ASK_PROMPT);
    const badgeCount = await waitFor(page, countOf('.ats-ask-badge'), (n) => Number(n) >= 1, 60_000);
    const panelDuringSidebar = await evaluate(page, countOf('.ats-ask-panel'));
    check('④-a 徽标在场（.ats-ask-badge ≥ 1）', Number(badgeCount) >= 1, `徽标数=${String(badgeCount)}`);
    check('④-b 浮框缺席（未点徽标时 .ats-ask-panel = 0）', Number(panelDuringSidebar) === 0,
      `面板数=${String(panelDuringSidebar)}`);
    await screenshot(page, join(SHOTS, 'r30-4-sidebar-badge.png'));
    await evaluate(page, 'document.querySelector(".ats-ask-badge").click()');
    const panelAfterBadge = await waitFor(page, countOf('.ats-ask-panel'), (n) => Number(n) >= 1, 5000);
    check('④-c 点徽标浮框出现（同组件换座位）', Number(panelAfterBadge) >= 1,
      `面板数=${String(panelAfterBadge)}`);
    await screenshot(page, join(SHOTS, 'r30-4-sidebar-opened.png'));
    // 窗口内快速作答，释放会话（不留给 ⑤ 的重启安全检查添堵）——同样组内定位。
    await waitFor(page, chipsIn(s4), (n) => Number(n) >= 2, 10_000);
    await clickFirstOptionAndSubmit(page, s4);
    const t4 = await waitTurnEnd(s4, 120_000);
    check('④-d 窗口内作答照常回流（turn/end + assistant 文本）',
      lastAssistantText(t4).length > 0,
      `末条=${JSON.stringify(lastAssistantText(t4).slice(0, 120))}`);
    await patchNs({ askUiSeat: 'overlay' });

    // —— ③ standard 预设对照（零接管的宿主侧证明）——
    // 原生问题卡（.Mbwy4a_card）只渲染在**正在查看该会话**的主视图里；API 建的会话
    // 不在侧栏当前工作区分组里，页面导航不可靠（探针实测结论）。③ 的契约本来就不是
    // 「原生卡长什么样」——是「标准预设不被接管、原生链不被损伤」：宿主侧判据更硬。
    // （顺序：排在 ⑦ 之前——⑦ 会关掉主实例换 en 宿主实例，主 page 随之失效。）
    console.log('· ③ standard 对照：零接管 + 原生链未损伤');
    const s3 = await newSession('standard');
    log.session3 = s3;
    await prompt(s3, ASK_PROMPT);
    await sleep(12_000); // 让 ask 发出且过了接管窗口（10 s）
    const st3 = await rpc('async-tools-ask/state', {});
    const taken3 = (st3.items ?? st3).filter((i) => i.sessionId === s3).length;
    check('③-a 未被接管（takeover 注册表里 s3 零批——边界：标准预设不碰）',
      taken3 === 0, `s3 批数=${String(taken3)}`);
    const t3 = await transcriptOf(s3);
    const recs3 = t3.records ?? [];
    const askCalled3 = recs3.some((r) => r.event?.type === 'tool/call' && r.event.data?.name === 'ask_user_question');
    const synth3 = recs3.some((r) => r.event?.type === 'tool/result'
      && String(JSON.stringify(r.event.data ?? {})).includes(A.timeout));
    check('③-b 原生 ask 发出且悬置（无合成结果——合成只发生在接管管线下）',
      askCalled3 === true && synth3 === false,
      `ask=${String(askCalled3)} 合成=${String(synth3)}`);
    const oursGroup3 = await evaluate(page, groupPresent(s3));
    check('③-c 本包的浮框里没有 s3 的组', oursGroup3 === false, `组在场=${String(oursGroup3)}`);
    await screenshot(page, join(SHOTS, 'r30-3-standard-notake.png'));
    // 原生卡留给官方 UI 的超时/人工路径——会话悬置安静，不影响 ⑤ 的安静检查项。

    // —— ⑦ 语言四组合（需求 §5.3）——
    // 宿主语言模拟：真机读数证明 `Emulation.setLocaleOverride` 在本机 headless Edge
    // 上不改变 navigator.language（探针实测）——改用 `--lang` 启动开关分起两个
    // 实例：默认实例 = 本机 zh 宿主；`--lang=en-US` 实例 = en 宿主。uiLang 走设置
    // RPC。面板挂靠 ① 留下的 expired 批（24 h TTL 内恒在场）——四个组合复用同组。
    console.log('· ⑦ 语言四组合：宿主 locale × uiLang → 面板文案语言');
    const headerText = '(() => { const p = document.querySelector(".ats-ask-panel"); '
      + 'return p === null ? null : p.textContent.slice(0, 60); })()';
    const assertCombo = async (comboPage, combo) => {
      await patchNs({ uiLang: combo.uiLang });
      await sleep(2500); // 轮询周期（1 s）+ 渲染余量
      const header = await evaluate(comboPage, headerText);
      check(`⑦ ${combo.name} → 面板标题=${combo.expect}`,
        typeof header === 'string' && header.includes(combo.expect),
        `读数=${JSON.stringify(header)}`);
      await screenshot(comboPage, join(SHOTS, `r30-7-lang-${combo.host}-${combo.uiLang}.png`));
    };
    // zh 宿主（默认实例，页面在场）：auto → zh；en 档钉住 en。
    await assertCombo(page, { name: 'auto×zh 宿主', host: 'zh-CN', uiLang: 'auto', expect: TITLE_ZH });
    await assertCombo(page, { name: 'en 档（zh 宿主下钉住）', host: 'zh-CN', uiLang: 'en', expect: TITLE_EN });
    // en 宿主：换 `--lang=en-US` 实例（auto 跟宿主 → en；zh 档钉住 zh）。
    instance.close();
    const en = await openApp(['--lang=en-US']);
    try {
      await assertCombo(en.page, { name: 'auto×en 宿主', host: 'en-US', uiLang: 'auto', expect: TITLE_EN });
      await assertCombo(en.page, { name: 'zh 档（en 宿主下钉住）', host: 'en-US', uiLang: 'zh', expect: TITLE_ZH });
    } finally {
      en.instance.close();
    }
    // 收尾：语言档复原 auto（默认）；主实例已关（外层 finally 的 close 幂等）。
    await patchNs({ uiLang: 'auto' });
  } finally {
    instance.close();
  }

  console.log('· 收尾：留着 askTakeover=true（判据⑤要穿过重启）——重启相会复原到探针固定档');
}

// ══ 重启相（⑤）═══════════════════════════════════════════════════════════

async function afterRestartPhase() {
  console.log('· ⑤ 重启后：设置与行为双回读');
  // 锚档与起始快照都从主相日志带过来（重启相是独立进程）。
  const mainLog = JSON.parse(readFileSync(join(LOGS, 'r30-ask-takeover.json'), 'utf8'));
  A = mainLog?.nsBefore?.agentLang === 'zh' ? ANCHORS.zh : ANCHORS.en;
  log.anchorLang = mainLog?.nsBefore?.agentLang === 'zh' ? 'zh' : 'en';
  const ns = await readNs();
  log.nsAfterRestart = ns?.value;
  check('⑤-a 开关重启后仍开（持久化，不是内存态）',
    ns?.value?.askTakeover === true && ns?.value?.askTimeoutMs === 10000,
    `读数=${JSON.stringify(ns?.value)}`);

  const s5 = await newSession(PRESET);
  log.session5 = s5;
  await prompt(s5, ASK_PROMPT);
  const t5 = await waitTurnEnd(s5, 120_000);
  const text5 = transcriptText(t5);
  check(`⑤-b 提问仍被接管（超时合成锚句在场，${log.anchorLang} 档 + 模型继续）`,
    text5.includes(A.timeout) && lastAssistantText(t5).length > 0,
    `锚句=${String(text5.includes(A.timeout))} 末条=${JSON.stringify(lastAssistantText(t5).slice(0, 80))}`);

  // 复原到探针固定档（overlay；不动共享实例的座位选择）：探针自控的四字段回
  // 固定值（不回写起始快照——上跑遗留的 true 会被级联当起点，真机读数）；
  // 别人的字段（agentLang 等）探针从未改过，不碰。
  const restorePatch = { askTakeover: false, askTimeoutMs: 60000, askUiSeat: 'overlay', uiLang: 'auto' };
  console.log(`· 复原到探针固定档：${JSON.stringify(restorePatch)}`);
  await patchNs(restorePatch);
  const nsRestored = await readNs();
  log.nsRestored = nsRestored?.value;
  check('⑤-c 复原到探针固定档（回读比对）',
    nsRestored?.value?.askTakeover === false && nsRestored?.value?.askTimeoutMs === 60000
    && nsRestored?.value?.askUiSeat === 'overlay' && nsRestored?.value?.uiLang === 'auto',
    `读数=${JSON.stringify(nsRestored?.value)}`);
}

// ══ 入口 ══════════════════════════════════════════════════════════════════

const phase = process.argv[2] ?? '';
try {
  if (phase === '--after-restart') await afterRestartPhase();
  else await mainPhase();
} catch (error) {
  check('探针自身无异常', false, error instanceof Error ? `${error.message}\n${String(error.stack ?? '')}` : String(error));
  try {
    // 异常路径复原到探针固定档（与 ⑤-c 同一套四字段——探针自控范围，别人的字段不碰）。
    const restorePatch = { askTakeover: false, askTimeoutMs: 60000, askUiSeat: 'overlay', uiLang: 'auto' };
    await patchNs(restorePatch);
    console.log(`  （异常路径复原到探针固定档：${JSON.stringify(restorePatch)}）`);
  } catch (restoreError) {
    console.log(`  （异常路径复原失败：${String(restoreError)}）`);
  }
} finally {
  const suffix = phase === '--after-restart' ? '-after-restart' : '';
  writeFileSync(join(LOGS, `r30-ask-takeover${suffix}.json`),
    JSON.stringify({ ...log, results }, null, 2), 'utf8');
}
const failures = results.filter((r) => !r.ok).length;
console.log(`\n总判定：${String(results.length - failures)}/${String(results.length)} 通过`);
process.exitCode = failures === 0 ? 0 : 1;
