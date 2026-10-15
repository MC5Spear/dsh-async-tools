/**
 * 静默失败三防线的真机判据（验证实例；需求 §6.3、设计 §6.2；重启保持半边在
 * `probe-r28-restart-persistence.mjs`——重启会换 token/cookie，必须另起进程重读）。
 *
 * 三条取证通道（c 段无转录通道：`request/header` 只有 config/adapterDefaults/tools，
 * systemPrompt 本体不可直接取证）：
 *
 * - **b 段**（描述警告）：新会话 `request/header` 里 `async_run` 描述含/不含
 *   `Caution (this deployment)` 段（en 档；zh 档锚在 `_r28-helpers.mjs` 对应 zh 常量）。
 * - **c 段**（纪律段）：**行为判据**——固定格式问答 + 定向断言（既定口径：
 *   逐字引用系统提示会被提示保密策略拒），判别子与测试套件见 `_r28-helpers.mjs` 头注。
 * - **a 管线**（结果侧 note）：真机只跑良性误发用例（空目录 `Get-ChildItem 2>&1`，内建
 *   cmdlet 进程内执行——不受外部 EXE 捕获形在进程创建层被杀的牵连，无 0xC0000142、
 *   无桌面弹窗），
 *   以及签名 2 的管道形（`git.exe` + `|`）。**执行档按用户裁定「走提权」**：
 *   验证实例是托管服务 LocalSystem，无 logon SID，受限沙箱结构性缺席
 *   （作业死于 `CreateRestrictedToken prerequisite failed`）——
 *   真机 a 管线一律**双档**取证：受限档跑一次记环境读数（127 死法 + 无 note，
 *   顺带断言**无误发**），提权档（`sandbox_permissions`+`justification`，经批准）真跑
 *   拿真实输出。签名 1/签名 2 的 **note 阳性渲染**在验证实例受限环境下不可达，由
 *   `test-r28` 单测覆盖；锚句真实性有实测档案背书。
 *   提权档良性空输出 → 无 note，同时是需求 §6.3 签名条件（受限且未提权才提示）的真机证据。
 *
 * 状态机：OFF 基线 → 页面 Switch 翻转保存（证明控件可用，不走 RPC）→ 三项在场（含
 * standard 预设全局性）→ 签名 2 → RPC 关回 → 三项消失 → agentLang=zh → 中文纪律段。
 * 收尾**故意留 silentFailureGuard=true**（真机 5 要验重启保持；由重启探针的 finally 复原
 * false），语言/界面档复原 auto/en。
 *
 * 测试套件噪声治理（实测口径）：在场类行为判据走 `askBatteryConsistent`——4294967295
 * 不可猜，主判别子（AVKILL+MEANS）命中即证明块在场，语言子矛盾的读数视为测试套件噪声，
 * 换**新会话**重抽 ≤3 次、逐次记录进证据 JSON；缺席断言仍单发（幻觉出不可猜退出码
 * 结构上不可达，不重抽）。
 *
 * 前置：验证实例在跑（loopback 打开）、junction 指向本仓库当前提交。
 * 证据：本机证据目录 logs/r28-silent-failure.json 与 shots/r28-*.png。
 * 用法：node verify/probe-r28-silent-failure.mjs（裸调用，不捕获输出）
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launch, openPage, evaluate, findBrowser, waitFor, screenshot } from './_visual/cdp.mjs';
import { instanceCredentials } from '../tools/_local-config.mjs';
import { localConfig } from './_rpc.mjs';
import {
  B_EN, B_ZH, NOTE_EN, ANCHOR_FAIL, ANCHOR_DENIED, AVKILL_CODE, ACL_FAIL,
  PRESET, EMPTY_DIR, BENIGN_COMMAND, readNs, patchNs, askBattery, askBatteryConsistent, fieldOf, commandRun
} from './_r28-helpers.mjs';

/** 签名 2 的管道形命令（实测形：EXE + 管道）。 */
const GIT_COMMAND = 'git --version | Select-String git';

const { base: BASE, token } = instanceCredentials(localConfig);
const SHOTS = join(localConfig.evidenceDir, 'shots');
const LOGS = join(localConfig.evidenceDir, 'logs');
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

mkdirSync(EMPTY_DIR, { recursive: true });
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
  /** 读设置表单的开关（`silentFailureGuard` 不是 input/select，控件本体是官方 Switch）。 */
  const readForm = () => evaluate(page, `(() => {
    const section = document.querySelector('[data-plugin-config]');
    if (section === null) return { names: [], switches: [] };
    return {
      names: [...section.querySelectorAll('input[id^="plugin-config-"], select[id^="plugin-config-"]')]
        .map((n) => n.id.slice('plugin-config-'.length)),
      switches: [...section.querySelectorAll('button[role="switch"]')].map((n) => ({
        label: n.getAttribute('aria-label'),
        checked: n.getAttribute('aria-checked')
      }))
    };
  })()`);

  console.log('· 0/6 起始态核对（默认关）');
  const start = await readNs();
  check('⓪ silentFailureGuard 出厂默认 false（回读）', start.value.silentFailureGuard === false,
    `读数=${JSON.stringify(start.value)}`);

  console.log('· 1/6 真机 1：默认关——三项都不在场');
  await openPluginPage();
  const form0 = await readForm();
  check('真机 1a 设置卡第 13 字段以官方 Switch 在场（aria-checked=false）',
    form0.switches.length === 1 && form0.switches[0].checked === 'false',
    `switches=${JSON.stringify(form0.switches)} 值/枚举字段数=${String(form0.names.length)}`);
  await screenshot(page, `${SHOTS}\\r28-01-off.png`);
  const off1 = await askBattery(PRESET);
  log.off1 = { session: off1.sessionId, answer: off1.answer };
  check('真机 1b c 段缺席（行为：无防杀退出码规则、无纪律段）',
    fieldOf(off1.answer, 'AVKILL_EXIT_CODE') !== AVKILL_CODE && fieldOf(off1.answer, 'RULES_BLOCK_LANG') === 'none',
    `AVKILL=${fieldOf(off1.answer, 'AVKILL_EXIT_CODE')} LANG=${fieldOf(off1.answer, 'RULES_BLOCK_LANG')} MEANS=${fieldOf(off1.answer, 'CAPTURE_EMPTY_MEANS')}`);
  check('真机 1c b 段缺席（描述无捕获形警告）',
    off1.description !== null && !off1.description.includes(B_EN),
    `含警告段=${String(off1.description?.includes(B_EN) ?? 'N/A')}`);
  check('真机 1d 问答轮零工具调用（判据只测系统提示）', off1.toolCalls === 0, `toolCalls=${String(off1.toolCalls)}`);
  const benign0c = await commandRun(BENIGN_COMMAND);
  log.benign0confined = { session: benign0c.sessionId, result: benign0c.result.slice(0, 400) };
  check('真机 1e-受限 a 管线缺席 + 受限档环境读数（127 死于 ACL 前置，无 note）',
    benign0c.result.includes(ACL_FAIL) && !benign0c.result.includes(NOTE_EN),
    `环境锚=${String(benign0c.result.includes(ACL_FAIL))} 含note=${String(benign0c.result.includes(NOTE_EN))} 结果前 200 字=${JSON.stringify(benign0c.result.slice(0, 200))}`);
  const benign0e = await commandRun(BENIGN_COMMAND, { escalate: true });
  log.benign0escalated = { session: benign0e.sessionId, result: benign0e.result.slice(0, 400), approvals: benign0e.approvals };
  check('真机 1e a 管线缺席（提权档良性捕获形：真空输出、无 note、经批准真跑）',
    benign0e.result.trim() === '' && !benign0e.result.includes(NOTE_EN)
      && benign0e.approvals.length >= 1 && benign0e.approvals.every((o) => o === 'allowed-once'),
    `空输出=${String(benign0e.result.trim() === '')} 批准=${JSON.stringify(benign0e.approvals)} 含note=${String(benign0e.result.includes(NOTE_EN))}`);

  console.log('· 2/6 真机 2：页面 Switch 翻转保存 → 开（不重启，三项在场 + 全局性）');
  const flipped = await evaluate(page, `(() => {
    const sw = document.querySelector('[data-plugin-config] button[role="switch"]');
    if (sw === null) return 'no-switch';
    sw.click();
    return 'clicked';
  })()`);
  await sleep(400);
  await clickBy(`[...document.querySelectorAll('[data-plugin-config] button')].find((b) => /^(保存|Save)$/.test(b.textContent.trim()))`, '保存');
  await sleep(3500);
  const onNs = await readNs();
  check('真机 2a 第 13 字段控件可用（Switch 翻转 + 页面保存生效）',
    flipped === 'clicked' && onNs.value.silentFailureGuard === true,
    `动作=${String(flipped)} 保存后读数=${String(onNs.value.silentFailureGuard)}`);
  await screenshot(page, `${SHOTS}\\r28-02-on.png`);
  const on1 = await askBatteryConsistent(PRESET, 'en');
  log.on1 = { session: on1.sessionId, answer: on1.answer, attempts: on1.attempts };
  check('真机 2b c 段在场（行为：防杀退出码 4294967295 + 语义判别子 + 语言子；矛盾读数换会话重抽 ≤3 全记录）',
    on1.attempts.some((a) => a.consistent),
    `AVKILL=${fieldOf(on1.answer, 'AVKILL_EXIT_CODE')} MEANS=${fieldOf(on1.answer, 'CAPTURE_EMPTY_MEANS')} LANG=${fieldOf(on1.answer, 'RULES_BLOCK_LANG')} 抽次=${String(on1.attempts.length)} 逐次=${JSON.stringify(on1.attempts)}`);
  check('真机 2d b 段在场（描述带捕获形警告，en 档）',
    on1.description !== null && on1.description.includes(B_EN),
    `含警告段=${String(on1.description?.includes(B_EN) ?? 'N/A')}`);
  const onStd = await askBatteryConsistent('standard', 'en');
  log.on1std = {
    session: onStd.sessionId,
    answer: onStd.answer,
    attempts: onStd.attempts,
    note: onStd.description === null ? 'standard 会话无 async_run，b 段不适用' : '意外：async_run 描述在场'
  };
  check('真机 2c c 段全局性（standard 预设会话同样在场——宿主行注入，不挑预设；矛盾读数重抽 ≤3）',
    onStd.attempts.some((a) => a.consistent),
    `抽次=${String(onStd.attempts.length)} 逐次=${JSON.stringify(onStd.attempts)}`);
  check('真机 2c′ standard 会话确实无 async_run（b 段判别范围只属本包工具）',
    onStd.description === null,
    `async_run 描述${onStd.description === null ? '缺席（预期）' : '在场（意外）'}`);
  const benign1c = await commandRun(BENIGN_COMMAND);
  log.benign1confined = { session: benign1c.sessionId, result: benign1c.result.slice(0, 400) };
  check('真机 2e-受限 a 管线无误发（guard=on，127 stderr 非空 → 不产 note）',
    benign1c.result.includes(ACL_FAIL) && !benign1c.result.includes(NOTE_EN),
    `环境锚=${String(benign1c.result.includes(ACL_FAIL))} 含note=${String(benign1c.result.includes(NOTE_EN))} 结果前 200 字=${JSON.stringify(benign1c.result.slice(0, 200))}`);
  const benign1e = await commandRun(BENIGN_COMMAND, { escalate: true });
  log.benign1escalated = { session: benign1e.sessionId, result: benign1e.result.slice(0, 400), approvals: benign1e.approvals };
  check('真机 2e a 管线提权豁免（guard=on，良性捕获形提权真跑空输出仍无 note——需求 §6.3 的噪声豁免：提权跑完不再提醒）',
    benign1e.result.trim() === '' && !benign1e.result.includes(NOTE_EN)
      && benign1e.approvals.length >= 1 && benign1e.approvals.every((o) => o === 'allowed-once'),
    `空输出=${String(benign1e.result.trim() === '')} 批准=${JSON.stringify(benign1e.approvals)} 含note=${String(benign1e.result.includes(NOTE_EN))}`);

  console.log('· 3/6 真机 3：签名 2 管道形——受限档记环境读数；同命令提权重跑真执行（用户裁定「走提权」）');
  const s3c = await commandRun(GIT_COMMAND);
  log.s3confined = { session: s3c.sessionId, result: s3c.result.slice(0, 500) };
  check('真机 3a 受限档管道形（受限档死法在场；锚对不在、无 note——本机受限环境下无真拒绝可复现）',
    s3c.result.includes(ACL_FAIL)
      && !s3c.result.includes(ANCHOR_FAIL) && !s3c.result.includes(ANCHOR_DENIED)
      && !s3c.result.includes(NOTE_EN),
    `环境锚=${String(s3c.result.includes(ACL_FAIL))} failed-to-run锚=${String(s3c.result.includes(ANCHOR_FAIL))} access-denied锚=${String(s3c.result.includes(ANCHOR_DENIED))} 含note=${String(s3c.result.includes(NOTE_EN))}`);
  const s3e = await commandRun(GIT_COMMAND, { escalate: true });
  log.s3escalated = { session: s3e.sessionId, result: s3e.result.slice(0, 500), approvals: s3e.approvals };
  check('真机 3b 同命令提权重跑（干净版本输出 + 经批准 + 无 note——死法归提权语境）',
    /git version \d/.test(s3e.result) && !s3e.result.includes(NOTE_EN)
      && s3e.approvals.length >= 1 && s3e.approvals.every((o) => o === 'allowed-once'),
    `版本输出=${String(/git version \d/.test(s3e.result))} 批准=${JSON.stringify(s3e.approvals)} 含note=${String(s3e.result.includes(NOTE_EN))} 结果前 200 字=${JSON.stringify(s3e.result.slice(0, 200))}`);
  log.s3coverage = {
    note: '签名 1/签名 2 的 note 阳性渲染在验证实例受限环境下不可达（LocalSystem 无 logon SID，受限沙箱结构性缺席）；阳性渲染由 test-r28 单测覆盖（含四条件判定与锚对匹配），锚句真实性有实测档案背书'
  };

  console.log('· 4/6 真机 4：关回（RPC 写 false，不重启）——三项同时消失');
  await patchNs({ silentFailureGuard: false });
  await sleep(1500);
  const off2 = await askBattery(PRESET);
  log.off2 = { session: off2.sessionId, answer: off2.answer };
  check('真机 4a c 段消失（行为判据回 none）',
    fieldOf(off2.answer, 'AVKILL_EXIT_CODE') !== AVKILL_CODE && fieldOf(off2.answer, 'RULES_BLOCK_LANG') === 'none',
    `AVKILL=${fieldOf(off2.answer, 'AVKILL_EXIT_CODE')} LANG=${fieldOf(off2.answer, 'RULES_BLOCK_LANG')}`);
  check('真机 4b b 段消失（描述不再带警告段）',
    off2.description !== null && !off2.description.includes(B_EN),
    `含警告段=${String(off2.description?.includes(B_EN) ?? 'N/A')}`);
  const benign2e = await commandRun(BENIGN_COMMAND, { escalate: true });
  log.benign2escalated = { session: benign2e.sessionId, result: benign2e.result.slice(0, 400), approvals: benign2e.approvals };
  check('真机 4c a 管线消失（提权档良性捕获形：空输出、无 note）',
    benign2e.result.trim() === '' && !benign2e.result.includes(NOTE_EN)
      && benign2e.approvals.length >= 1 && benign2e.approvals.every((o) => o === 'allowed-once'),
    `空输出=${String(benign2e.result.trim() === '')} 批准=${JSON.stringify(benign2e.approvals)} 含note=${String(benign2e.result.includes(NOTE_EN))}`);

  console.log('· 5/6 真机 6：agentLang=zh → 纪律段换中文（行为语言子 + b 段中文档；guard 先重开——真机 4 已关回，语言判据须在三防线在场下测）');
  await patchNs({ agentLang: 'zh', silentFailureGuard: true });
  await sleep(1500);
  const zhPre = await readNs();
  check('真机 6⓪ 前提：zh + guard 已开（回读；防真机 4 关回污染语言判据）',
    zhPre.value.agentLang === 'zh' && zhPre.value.silentFailureGuard === true,
    `agentLang=${String(zhPre.value.agentLang)} guard=${String(zhPre.value.silentFailureGuard)}`);
  const zh = await askBatteryConsistent(PRESET, 'zh');
  log.zh = { session: zh.sessionId, answer: zh.answer, attempts: zh.attempts };
  check('真机 6a c 段仍是纪律段本体（防杀退出码跨语言不变；矛盾读数重抽 ≤3）',
    zh.attempts.some((a) => a.AVKILL.includes(AVKILL_CODE)),
    `AVKILL=${fieldOf(zh.answer, 'AVKILL_EXIT_CODE')} 抽次=${String(zh.attempts.length)} 逐次=${JSON.stringify(zh.attempts)}`);
  check('真机 6b 纪律段语言 = zh（RULES_BLOCK_LANG 判别子）',
    zh.attempts.some((a) => a.consistent),
    `LANG=${fieldOf(zh.answer, 'RULES_BLOCK_LANG')}`);
  check('真机 6c b 段描述同步换中文档（警告段中文锚）',
    zh.description !== null && zh.description.includes(B_ZH) && !zh.description.includes(B_EN),
    `含中文段=${String(zh.description?.includes(B_ZH) ?? 'N/A')} 含英文段=${String(zh.description?.includes(B_EN) ?? 'N/A')}`);

  console.log('· 6/6 收尾：语言/界面档复原；guard 故意留在 true（真机 5 的重启输入，由重启探针复原）');
  await patchNs({ uiLang: 'auto', agentLang: 'en', silentFailureGuard: true });
  const restored = await readNs();
  check('⑥ 收尾：auto/en、guard=true 留给重启探针（回读比对）',
    restored.value.uiLang === 'auto' && restored.value.agentLang === 'en' && restored.value.silentFailureGuard === true,
    `uiLang=${String(restored.value.uiLang)} agentLang=${String(restored.value.agentLang)} guard=${String(restored.value.silentFailureGuard)}`);
} catch (error) {
  check('探针自身无异常', false, error instanceof Error ? `${error.message}\n${String(error.stack ?? '')}` : String(error));
  try {
    await patchNs({ uiLang: 'auto', agentLang: 'en', silentFailureGuard: false });
    console.log('  （异常路径复原：auto/en、guard=false）');
  } catch (restoreError) {
    console.log(`  （异常路径复原失败：${String(restoreError)}）`);
  }
} finally {
  rmSync(EMPTY_DIR, { recursive: true, force: true });
  writeFileSync(`${LOGS}\\r28-silent-failure.json`,
    JSON.stringify({ at: new Date().toISOString(), base: BASE, ...log, results }, null, 2), 'utf8');
  if (page !== undefined) await page.close?.();
  await close();
}
const failures = results.filter((r) => !r.ok).length;
console.log(`\n总判定：${String(results.length - failures)}/${String(results.length)} 通过`);
process.exitCode = failures === 0 ? 0 : 1;
