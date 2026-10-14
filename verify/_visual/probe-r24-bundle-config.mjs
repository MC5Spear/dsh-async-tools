/**
 * 浏览器侧判据（设计 §5.3）：**设置区在插件页上真的可用**（不靠后端 API 自述）。
 *
 * 路径（全部在真实页面上做）：插件 → 「查看 dsh-async-tools」→ **本包插件页本身**。
 * 不进任何组件行子页——设置区落点是 `plugins.bundle.config`，宿主把该槽渲染在
 * 插件页的**描述与组件行之间**（`dsh-client-ui-plugin-manager/lib/client.js:1915-1919`）。
 *
 * 判据段（设计 §5.3 口径；控件身份 = `id`，读数 = 说明行两段）：
 * ① **放置**：页面是插件页（`[data-plugin-detail="dsh-async-tools"]`）、设置区在插件页内、
 *    排在组件行**之前**，且组件行里**没有** configure 控件；
 * ② 设置区渲染出四组全部字段（值字段 `[id^="plugin-config-"]`；布尔官方 Switch 按行内
 *    帮助锚的 aria-controls 身份读——设计 §5.5：Switch 无障碍名走 label 属性），逐项核对；
 * ③ 毫秒字段的说明行带秒数读数段（两段口径：生效段恒在；只数个数抓不到"读数挂错字段"）；
 * ④-0 **输入读数实时**：不保存、只在输入框键入 → 输入段当场变（含亚 10 ms 形状）；
 * ④ 改一个字段 → 保存 → 等待态 = 保存按钮从「保存中…」恢复且重新可点；成功判据 =
 *    字段回到生效值（活 section 值回填）+ profile patch 出现该覆盖 + 生效段跟着变成
 *    新值的换算（这条同时证明卡片订阅了控制器：不订阅就永远不会用新快照重渲染）；
 * ⑤ 复原（清空该字段再保存）→ 落盘覆盖消失、字段与两段读数回到默认值、清空时输入段
 *    换成 — 占位（不给秒数）；
 * ⑥ 字段帮助（需求 §5.5/§5.6·设计 §5.5）：17 个字段各有带圈问号按钮（type=button、
 *    aria-controls=<id>-help、aria-expanded=false、可访问名走 help.a11yName 模板）；
 *    点击 defaultYieldMs 的按钮 → 展开区（role=region、\n\n 分段 ≥ 2、首段=技术标识行）、
 *    控件 aria-describedby 并入帮助区 id、保存启用状态不变（无副作用）；再点收起。
 *
 * 证据：判据读数与截图随脚本落盘到本机证据目录（logs/r24-dom.json、shots/r24-0*.png）。
 * 用法：node verify/_visual/probe-r24-bundle-config.mjs
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, openPage, evaluate, findBrowser, waitFor, screenshot } from './cdp.mjs';
import { judgeConfigForm, judgeHelpButtons, judgeHelpInteraction, judgePlacement, judgeReadoutFollows, judgeRoundTrip } from '../r24-judgements.mjs';
import { BUDGET_FIELD_KEYS, LANG_FIELD_KEYS, FLAG_FIELD_KEYS, ASK_FIELD_KEYS, MS_FIELD_KEYS } from '../../lib/config.js';
import { instanceCredentials, loadLocalPlaneOrSkip } from '../../tools/_local-config.mjs';

const localConfig = await loadLocalPlaneOrSkip('verify/_visual/probe-r24-bundle-config.mjs');
const { base: BASE, token } = instanceCredentials(localConfig);
const SHOTS = join(localConfig.evidenceDir, 'shots');
const LOGS = join(localConfig.evidenceDir, 'logs');
const PATCH = join(localConfig.instanceHome, 'profiles', 'web', 'cordis.patch.yml');
const FIELD = 'pollIntervalMs';
const NEW_VALUE = '4321';
/** `formatSeconds(4321)`：4.321 s 保留两位 → `4.32 s`；默认 500 ms → `0.5 s`。 */
const NEW_SECONDS = '4.32 s';
const DEFAULT_SECONDS = '0.5 s';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'OK    ' : 'WRONG '} ${name}${detail === '' ? '' : `\n          ${detail}`}`);
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
/** 段的标签（`生效：4.32 s` → `生效：`）：从段文本剥掉秒文本尾巴。 */
const labelOf = (segment) => String(segment).replace(/(< 0\.01 s|[\d.]+ s|—)$/, '');

const url = `${BASE}/?token=${encodeURIComponent(token)}`;

mkdirSync(SHOTS, { recursive: true });
const browser = findBrowser();
if (browser === undefined) {
  console.log('找不到 Edge/Chrome。');
  process.exit(2);
}
const { port, close } = await launch(browser);
let page;
let failed = 1;
try {
  page = await openPage(port, url);
  await waitFor(page, 'document.querySelectorAll("button,[role=button]").length', (n) => n > 0, 15000);

  const clickBy = (selectorJs, label) => evaluate(page, `(() => {
    const target = ${selectorJs};
    if (target === undefined || target === null) return 'missing:' + ${JSON.stringify(label)};
    target.click();
    return 'clicked';
  })()`);

  console.log('· 进插件页（不点任何组件行）');
  await clickBy(`[...document.querySelectorAll('button,[role=button],a')].find((n) => (n.getAttribute('aria-label') || '') === '插件')`, '插件');
  await sleep(2500);
  await clickBy(`[...document.querySelectorAll('*')].find((n) => (n.getAttribute('aria-label') || '') === '查看 dsh-async-tools')`, '查看 dsh-async-tools');
  await sleep(3000);

  // ① 放置 + ② 字段身份 + ③ 两段读数：一次取数，三个纯函数判据。
  //    控件身份 = `id` 去前缀；读数长在哪个字段上 = 该字段说明行（aria-describedby 指向的
  //    p）里有没有读数段 span（`.ats-sec-effective`——官方说明行 + 换行 + 两段的结构）。
  const reading = await evaluate(page, `(() => {
    const bundleRoot = document.querySelector('[data-plugin-detail="dsh-async-tools"]');
    const section = document.querySelector('[data-plugin-config]');
    // 只收控件本体——按 id 前缀选会连说明行 p（*-message）一起捞进来，身份就多了一倍。
    // 值字段（input/select）按 id 前缀；布尔字段是官方 P.Switch（设计 §5.5：Switch 不吃
    // id prop，无障碍名走 label 属性），其身份按**同字段容器**里帮助按钮的
    // aria-controls（plugin-config-<key>-help）读出——行归属即身份。
    const controls = section === null
      ? []
      : [...section.querySelectorAll('input[id^="plugin-config-"], select[id^="plugin-config-"]')];
    const flagKeys = [];
    const flagWritable = [];
    if (section !== null) {
      for (const hb of section.querySelectorAll('.ats-help-button')) {
        const container = hb.closest('.ats-enum-field');
        const sw = container === null ? null : container.querySelector('button[role="switch"]');
        if (sw !== null) {
          flagKeys.push((hb.getAttribute('aria-controls') || '').replace('plugin-config-', '').replace(/-help$/, ''));
          flagWritable.push(sw.disabled !== true);
        }
      }
    }
    const messageOf = (ctl) => {
      const described = ctl.getAttribute('aria-describedby') || '';
      const node = described === '' ? null : document.getElementById(described);
      return node === null ? null : node;
    };
    const rowToggle = [...document.querySelectorAll('button,[role=button]')]
      .find((n) => /^启用组件 dsh-async-tools/.test(n.getAttribute('aria-label') || ''));
    const rowControls = [...document.querySelectorAll('button,[role=button]')]
      .filter((n) => /^配置 /.test(n.getAttribute('aria-label') || ''))
      .filter((n) => (n.getAttribute('aria-label') || '').includes('dsh-async-tools'))
      .filter((n) => section === null || !section.contains(n));
    const order = section !== null && rowToggle !== undefined && rowToggle !== null
      ? (section.compareDocumentPosition(rowToggle) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      : false;
    const seconds = [];
    const readoutKeys = [];
    for (const ctl of controls) {
      const message = messageOf(ctl);
      if (message === null) continue;
      const spans = message.querySelectorAll('span.ats-sec-effective');
      if (spans.length === 0) continue;
      readoutKeys.push(ctl.id.slice('plugin-config-'.length));
      seconds.push(spans[0].textContent.trim());
    }
    return {
      pageKind: bundleRoot !== null ? 'bundle' : (section !== null ? 'row' : 'unknown'),
      sectionPresent: section !== null,
      count: controls.length + flagKeys.length,
      fieldCount: controls.length + flagKeys.length,
      rowsAfterSection: order,
      rowConfigureControls: rowControls.length,
      keys: [...controls.map((n) => n.id.slice('plugin-config-'.length)), ...flagKeys],
      writable: [...controls.map((n) => n.disabled !== true && n.readOnly !== true), ...flagWritable],
      readouts: seconds,
      readoutFields: readoutKeys,
      labels: section === null ? [] : [...section.querySelectorAll('label[for^="plugin-config-"]')]
        .map((n) => n.textContent.trim()),
      failed: document.querySelector('[data-plugin-config] .failed') !== null
    };
  })()`);
  // —— ⑥ 字段帮助·静态判据：17 个按钮逐项按 aria-controls 身份核对（不只数个数）——
  const helpReading = await evaluate(page, `(() => {
    const section = document.querySelector('[data-plugin-config]');
    const buttons = section === null ? [] : [...section.querySelectorAll('.ats-help-button')];
    return {
      helpButtons: buttons.map((b) => ({
        controls: (b.getAttribute('aria-controls') || '').replace('plugin-config-', '').replace(/-help$/, ''),
        type: b.getAttribute('type') || '',
        expanded: b.getAttribute('aria-expanded') === 'true',
        label: b.getAttribute('aria-label') || ''
      }))
    };
  })()`);
  // 判据本体在 `verify/r24-judgements.mjs` 的纯函数里（取数在这里、判据在那里），
  // 这样 `verify/mutate-r24-ui.mjs` 能用变异证明这些判据可被改坏打成红。
  // ⚠️ 四组**全要**（键集的单一来源是 `lib/config.js`）。判据少看几个字段
  // 不会报错，只会安静地少测。
  const EXPECTED_KEYS = [...BUDGET_FIELD_KEYS, ...LANG_FIELD_KEYS, ...FLAG_FIELD_KEYS, ...ASK_FIELD_KEYS];
  const placementVerdict = judgePlacement(reading, EXPECTED_KEYS);
  check('① 设置区在插件页上、排在组件行之前、组件行里没有 configure 控件',
    placementVerdict.ok, placementVerdict.detail);
  const formVerdict = judgeConfigForm(reading, EXPECTED_KEYS, MS_FIELD_KEYS);
  check(`②③ 设置区逐项在场且可写（${String(EXPECTED_KEYS.length)} 个字段，四组全取，id 身份与代码一致）+ 秒数读数长在 ${String(MS_FIELD_KEYS.length)} 个毫秒字段上（两段口径）`,
    formVerdict.ok, `${formVerdict.detail}；标签=${reading.labels.join(', ').slice(0, 130)}`);
  const helpVerdict = judgeHelpButtons(helpReading, EXPECTED_KEYS);
  check(`⑥-a 字段帮助按钮逐项在场（${String(EXPECTED_KEYS.length)} 个，aria-controls 身份核对；需求 §5.5/§5.6）`,
    helpVerdict.ok, helpVerdict.detail);
  await screenshot(page, `${SHOTS}\\r24-04-plugin-page-config.png`);

  /** 把目标字段写成 `value`（`''` = 清空）；按 id 定位，不按标签文本、不按下标。 */
  const typeInto = (value) => evaluate(page, `(() => {
    const input = document.querySelector('#plugin-config-${FIELD}');
    if (input === null) return 'no-input';
    const proto = input.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  /**
   * 读目标字段的两段读数与保存按钮态。
   * 两段 = 说明行 `<p>` 里的两个 span（生效段 `.ats-sec-effective` / 输入段
   * `.ats-sec-input`——值只写秒文本，空草稿占位 `—`；非法草稿整行换 invalidLabel，
   * 两段都不在，这是官方行为）。
   */
  const readBack = () => evaluate(page, `(() => {
    const ctl = document.querySelector('#plugin-config-${FIELD}');
    if (ctl === null) return { controlValue: '', effective: '', input: '', saving: true, enabled: false, failed: false };
    const described = ctl.getAttribute('aria-describedby') || '';
    const messageNode = described === '' ? null : document.getElementById(described);
    const eff = messageNode === null ? null : messageNode.querySelector('span.ats-sec-effective');
    const input = messageNode === null ? null : messageNode.querySelector('span.ats-sec-input');
    const save = [...document.querySelectorAll('[data-plugin-config] button')]
      .find((b) => /^(保存|Save)$/.test(b.textContent.trim()));
    return {
      controlValue: ctl.value,
      effective: eff === null ? '' : eff.textContent.trim(),
      input: input === null ? '' : input.textContent.trim(),
      saving: save !== undefined && /保存中|Saving/.test(save.textContent),
      enabled: save !== undefined && save.disabled !== true,
      failed: document.querySelector('[data-plugin-config] .failed') !== null
    };
  })()`);
  /** 点保存，并把动作结果返回（不忽略"没点到"——静默的 no-op 会让后面的判据看着像实现坏了）。 */
  const save = async () => clickBy(`[...document.querySelectorAll('[data-plugin-config] button')].find((b) => /^(保存|Save)$/.test(b.textContent.trim()))`, '保存');
  /**
   * 等页面给出结果：保存按钮从「保存中…」恢复**且**重新可点（成功不弹文案，
   * 等待态只能看按钮；上限 ~15 秒）。
   */
  const waitForOutcome = async () => {
    for (let i = 0; i < 15; i += 1) {
      const state = await readBack();
      if (!state.saving && state.enabled) return state;
      await sleep(1000);
    }
    return readBack();
  };

  // ⓪ 先把目标字段恢复到"无覆盖"状态：上一次中断可能把覆盖留在 profile patch 里，
  //    那样第 ④ 步的写入会与现状相同（差集为空 ⇒ 不发 op），判据就测不到任何东西。
  if (new RegExp(`${FIELD}:`).test(readFileSync(PATCH, 'utf8'))) {
    const cleared = await typeInto('');
    const resetClick = await save();
    const resetState = await waitForOutcome();
    check('⓪ 起始无覆盖（上次残留的覆盖已通过表单清掉）',
      cleared === 'typed' && resetClick === 'clicked' && resetState.controlValue === '500'
        && resetState.effective.endsWith(DEFAULT_SECONDS),
      `清空动作=${cleared} 保存动作=${resetClick} 页面=${JSON.stringify(resetState)}`);
    await sleep(1500);
  }
  /** 基线的两段读数（必须在清掉残留覆盖之后取，否则"读数跟着变"会比对一个过期的起点）。 */
  const baseline = await readBack();
  check('③b 起始两段读数 = 默认值的换算（清掉残留覆盖之后）',
    baseline.effective.endsWith(DEFAULT_SECONDS) && baseline.input.endsWith(DEFAULT_SECONDS),
    `生效段=${JSON.stringify(baseline.effective)} 输入段=${JSON.stringify(baseline.input)}`);

  // ④-0 输入读数实时（核心是**不保存**）：键入 4 → 亚 10 ms；键入 4321 → 新值换算。
  const typedSub10 = await typeInto('4');
  await sleep(400);
  const sub10 = await readBack();
  check('④-0a 键入 4（未保存）：输入段当场给亚 10 ms 读数（不得 0 s），生效段不动',
    typedSub10 === 'typed' && sub10.input.endsWith('< 0.01 s') && !/0 s$/.test(sub10.input)
      && sub10.effective.endsWith(DEFAULT_SECONDS),
    `动作=${typedSub10} 输入段=${JSON.stringify(sub10.input)}`);
  const typedLive = await typeInto(NEW_VALUE);
  await sleep(400);
  const liveRead = await readBack();
  check('④-0b 键入 4321（仍未保存）：输入段 = 新值换算（读数接的是草稿，不是生效值）',
    typedLive === 'typed' && liveRead.input.endsWith(NEW_SECONDS)
      && liveRead.effective.endsWith(DEFAULT_SECONDS),
    `输入段=${JSON.stringify(liveRead.input)}`);
  await screenshot(page, `${SHOTS}\\r24-05-plugin-page-typed.png`);

  // ④ 改值 → 保存 → 落盘 + 字段回生效值 + 生效段跟着变
  const saveAction = await save();
  check('④b-0 保存按钮可点（动作结果必须检查）', saveAction === 'clicked', `动作=${saveAction}`);
  const afterSave = await waitForOutcome();
  const roundTrip = judgeRoundTrip(afterSave.controlValue, afterSave.failed, readFileSync(PATCH, 'utf8'), FIELD, NEW_VALUE);
  check('④b 保存后：字段回到生效值、无页脚失败文案、profile patch 出现该覆盖', roundTrip.ok, roundTrip.detail);
  const effLabel = labelOf(baseline.effective);
  const inpLabel = labelOf(sub10.input) || effLabel;
  const followed = judgeReadoutFollows(baseline, afterSave, {
    effective: `${effLabel}${NEW_SECONDS}`,
    input: `${inpLabel}${NEW_SECONDS}`
  });
  check('④c 保存后生效段跟着变成新值换算、输入段随草稿清空回到生效值（证明卡片订阅了控制器）',
    followed.ok, followed.detail);
  await screenshot(page, `${SHOTS}\\r24-06-plugin-page-saved.png`);

  // ⑤ 复原：清空该字段再保存（清空输入段先换成 — 占位——不给秒数）
  const cleared = await typeInto('');
  await sleep(400);
  const emptied = await readBack();
  check('⑤-0 清空（未保存）：输入段换成 — 占位（不给秒数、不留残段），生效段不动',
    cleared === 'typed' && emptied.input.endsWith('—')
      && !(/[\d.]+ s$/.test(emptied.input) || /< 0\.01 s$/.test(emptied.input))
      && emptied.effective.endsWith(NEW_SECONDS),
    `输入段=${JSON.stringify(emptied.input)}`);
  const restoreAction = await save();
  const afterRestore = await waitForOutcome();
  const hitFinal = new RegExp(`${FIELD}:\\s*${NEW_VALUE}`).test(readFileSync(PATCH, 'utf8'));
  const restored = judgeReadoutFollows(afterSave, afterRestore, {
    effective: `${effLabel}${DEFAULT_SECONDS}`,
    input: `${inpLabel}${DEFAULT_SECONDS}`
  });
  check('⑤ 复原后落盘覆盖消失、字段回到默认值、两段读数回到默认换算',
    restoreAction === 'clicked' && !hitFinal && restored.ok && afterRestore.controlValue === '500',
    `动作=${restoreAction}；复原后仍命中=${String(hitFinal)}；${restored.detail}`);
  await screenshot(page, `${SHOTS}\\r24-07-plugin-page-restored.png`);

  // —— ⑥-b 字段帮助·交互判据：开合 + aria + 无副作用（复原之后做——帮助开合不得
  //    弄脏表单，此拍表单必须干净；保存按钮启用状态前后对照）——
  const helpInteraction = await evaluate(page, `(() => {
    const HELP_KEY = 'defaultYieldMs';
    const button = document.querySelector('[aria-controls="plugin-config-' + HELP_KEY + '-help"]');
    const ctl = document.getElementById('plugin-config-' + HELP_KEY);
    const saveBtn = [...document.querySelectorAll('[data-plugin-config] button')]
      .find((b) => b.disabled !== undefined && /保存|Save/.test(b.textContent || ''));
    const saveDisabledBefore = saveBtn === undefined ? null : saveBtn.disabled === true;
    if (button === null) return { error: 'no-button' };
    button.click();
    return { saveDisabledBefore, clicked: true };
  })()`);
  await sleep(300);
  const opened = await evaluate(page, `(() => {
    const region = document.getElementById('plugin-config-defaultYieldMs-help');
    const button = document.querySelector('[aria-controls="plugin-config-defaultYieldMs-help"]');
    const ctl = document.getElementById('plugin-config-defaultYieldMs');
    const paragraphs = region === null ? 0 : region.querySelectorAll('p').length;
    return {
      open: {
        present: region !== null,
        role: region === null ? '' : (region.getAttribute('role') || ''),
        paragraphs,
        firstParagraph: region === null ? '' : (region.querySelector('p')?.textContent || ''),
        expanded: button === null ? false : button.getAttribute('aria-expanded') === 'true',
        describedby: ctl === null ? '' : (ctl.getAttribute('aria-describedby') || '')
      }
    };
  })()`);
  await screenshot(page, `${SHOTS}\\r24-08-help-open.png`);
  const closed = await evaluate(page, `(() => {
    document.querySelector('[aria-controls="plugin-config-defaultYieldMs-help"]').click();
    return true;
  })()`);
  await sleep(300);
  const closedReading = await evaluate(page, `(() => {
    const region = document.getElementById('plugin-config-defaultYieldMs-help');
    const button = document.querySelector('[aria-controls="plugin-config-defaultYieldMs-help"]');
    const saveBtn = [...document.querySelectorAll('[data-plugin-config] button')]
      .find((b) => b.disabled !== undefined && /保存|Save/.test(b.textContent || ''));
    return {
      closed: { present: region !== null, expanded: button === null ? true : button.getAttribute('aria-expanded') === 'true' },
      saveDisabledAfter: saveBtn === undefined ? null : saveBtn.disabled === true
    };
  })()`);
  const interactionVerdict = judgeHelpInteraction({
    open: opened.open,
    closed: closedReading.closed,
    saveDisabledBefore: helpInteraction.saveDisabledBefore,
    saveDisabledAfter: closedReading.saveDisabledAfter
  });
  check('⑥-b 帮助开合：展开区分段渲染+技术标识行首段、aria-expanded/describedby 并入、保存启用状态不变、再点收起',
    helpInteraction.clicked === true && closed === true && interactionVerdict.ok,
    interactionVerdict.detail);

  failed = results.filter((r) => !r.ok).length;
  console.log(`\n总判定：${String(results.length - failed)}/${String(results.length)} 通过`);
  mkdirSync(LOGS, { recursive: true });
  writeFileSync(join(LOGS, 'r24-dom.json'),
    JSON.stringify({ at: new Date().toISOString(), base: BASE, field: FIELD, value: NEW_VALUE, reading, helpReading, helpInteraction, opened, closedReading, baseline, sub10, liveRead, afterSave, emptied, afterRestore, results }, null, 2), 'utf8');
} catch (error) {
  console.log('PROBE-ERROR', error instanceof Error ? error.message : String(error));
} finally {
  if (page !== undefined) await page.close?.();
  await close();
}
process.exitCode = failed === 0 ? 0 : 1;
