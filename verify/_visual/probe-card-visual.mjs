/**
 * 视觉探针：**本包设置表单与官方设置表单的形态一致性**（设计 §5.3 浏览器入口与官方表单）。
 *
 * ## 判据分三层
 *
 * 1. **computed style 并排对比**（可失败、可复现）：把本包插件页上的字段（官方
 *    `SettingsValueField` + 自绘枚举 select）与**官方设置页自己的**字段逐项比——
 *    度量（高度/圆角/字号/内边距/边框）、颜色（底色/文字色对主题变量的解析）。
 *    值字段控件已同源（官方组件），这条的余量主要落在**自绘的枚举 select**上；
 *    允许的差异只有两项：官方没有的枚举控件、官方没有的秒数读数（生效 + 输入两段）。
 * 2. **结构判据**（设计 §5.3 的真机环境）：四组全部字段（`lib/config.js` 现读，现为 17 个）
 *    各 = label 行（for 绑定）+
 *    整行控件 + 说明行（aria-describedby 指向）；相邻字段之间 0.5px 分隔线（读计算样式）；
 *    页脚只有「保存」一个动作按钮。
 * 3. **截图**（给人看 + 给有视觉功能的子代理审）：深色与浅色主题各两张（顶部 + 底部）。
 *    断言接不了"看起来搭不搭"，那一层交给看图的人。
 *
 * ## 为什么必须真的开浏览器
 *
 * 颜色取值若写死成浅色主题，深色下就是一块白底黑框——而单测与真机功能验收照样
 * 全绿：那些判据验的是"保存有没有生效"，没有一条看颜色。
 *
 * 证据：判据读数与截图随脚本落盘到本机证据目录（logs/card-visual.json、shots/card-*.png）。
 * 用法：node verify/_visual/probe-card-visual.mjs（验证实例）
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { launch, openPage, evaluate, findBrowser, waitFor, screenshot } from './cdp.mjs';
import { BUDGET_FIELD_KEYS, LANG_FIELD_KEYS, FLAG_FIELD_KEYS, ASK_FIELD_KEYS, MS_FIELD_KEYS } from '../../lib/config.js';
import { instanceCredentials, loadLocalPlaneOrSkip } from '../../tools/_local-config.mjs';

const localConfig = await loadLocalPlaneOrSkip('verify/_visual/probe-card-visual.mjs');
const { base: BASE, token } = instanceCredentials(localConfig);
const SHOTS = join(localConfig.evidenceDir, 'shots');
const LOGS = join(localConfig.evidenceDir, 'logs');
// 四组**全要**。判据少看几个字段不会报错，只会安静地少测；
// 名单的单一来源是 `lib/config.js` 的四组键集合。
const EXPECTED_KEYS = [...BUDGET_FIELD_KEYS, ...LANG_FIELD_KEYS, ...FLAG_FIELD_KEYS, ...ASK_FIELD_KEYS];

const results = [];
/**
 * 记一条判据。
 *
 * @param {string} name - 判据名。
 * @param {boolean} ok - 是否成立。
 * @param {string} [detail] - 读数。
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'OK    ' : 'WRONG '} ${name}${detail === '' ? '' : `\n          ${detail}`}`);
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const url = `${BASE}/?token=${encodeURIComponent(token)}`;

mkdirSync(SHOTS, { recursive: true });
const browser = findBrowser();
if (browser === undefined) {
  console.log('找不到 Edge/Chrome，视觉探针无法运行。');
  process.exit(2);
}
console.log(`浏览器：${browser}`);
const { port, close } = await launch(browser);
let page;
let failed = 0;
let log = {};

/** 单个控件/按钮的度量采集（只在页面里做查询，返回纯数据）。 */
const PICK = `(n) => {
  const s = getComputedStyle(n);
  const r = n.getBoundingClientRect();
  return {
    tag: n.tagName, background: s.backgroundColor, color: s.color,
    borderColor: s.borderTopColor, borderWidth: s.borderTopWidth, borderStyle: s.borderTopStyle,
    radius: s.borderTopLeftRadius, height: s.height, lineHeight: s.lineHeight,
    paddingLeft: s.paddingLeft, paddingRight: s.paddingRight, fontSize: s.fontSize,
    appearance: s.appearance, boxWidth: Math.round(r.width), boxHeight: Math.round(r.height)
  };
}`;

try {
  page = await openPage(port, url);
  await waitFor(page, 'document.readyState', (v) => v === 'complete', 30000);
  await waitFor(page, `document.querySelectorAll('[aria-label]').length`, (v) => v > 5, 30000);

  const clickBy = (selectorJs, label) => evaluate(page, `(() => {
    const target = ${selectorJs};
    if (target === undefined || target === null) return 'missing:' + ${JSON.stringify(label)};
    target.click();
    return 'clicked';
  })()`);

  console.log('· ① 本包插件页：读字段结构与度量');
  await clickBy(`[...document.querySelectorAll('button,[role=button],a')].find((n) => (n.getAttribute('aria-label') || '') === '插件')`, '插件');
  await sleep(2500);
  await clickBy(`[...document.querySelectorAll('*')].find((n) => (n.getAttribute('aria-label') || '') === '查看 dsh-async-tools')`, '查看 dsh-async-tools');
  await sleep(3000);

  // 本包表单的结构与度量（设计 §5.3 的真机环境：读 DOM 与计算样式，不读源码文本）。
  const ours = await evaluate(page, `(() => {
    const pick = ${PICK};
    const section = document.querySelector('[data-plugin-config]');
    if (section === null) return { found: false };
    // 只收控件本体（input/select）——按 id 前缀选会连说明行 p（*-message）一起捞进来。
    const controls = [...section.querySelectorAll('input[id^="plugin-config-"], select[id^="plugin-config-"]')];
    const messageOf = (ctl) => {
      const described = ctl.getAttribute('aria-describedby') || '';
      const node = described === '' ? null : document.getElementById(described);
      return { id: described, present: node !== null, text: node === null ? '' : node.textContent.trim() };
    };
    // 字段行容器：控件的最近祖先、其 borderTop 是相邻字段之间的分隔线（判据 2）。
    const fieldRowOf = (ctl) => {
      let row = ctl.parentElement;
      while (row !== null && row !== section && row.querySelectorAll('input[id^="plugin-config-"], select[id^="plugin-config-"]').length > 1) row = row.parentElement;
      return row;
    };
    const rows = controls.map((ctl) => {
      const row = fieldRowOf(ctl);
      const s = row === null ? null : getComputedStyle(row, '::before');
      return row === null ? { width: 0 } : { width: Math.round(row.getBoundingClientRect().width) };
    });
    const separators = controls.slice(1).map((ctl) => {
      const row = fieldRowOf(ctl);
      if (row === null) return '';
      // 分隔线 = 行容器自身的上边框（官方 .field:not(:first-child) 的形态）。
      return getComputedStyle(row).borderTopWidth;
    });
    return {
      found: true,
      keys: controls.map((n) => n.id.slice('plugin-config-'.length)),
      labelFor: [...section.querySelectorAll('label[for^="plugin-config-"]')].map((n) => n.getAttribute('for')),
      messages: controls.map(messageOf),
      readoutSpans: section.querySelectorAll('span.ats-sec-effective').length,
      valueInputs: controls.filter((n) => n.tagName === 'INPUT').map(pick),
      enumSelects: controls.filter((n) => n.tagName === 'SELECT').map(pick),
      separators,
      saveButtons: [...section.querySelectorAll('button')]
        .filter((b) => /^(保存|Save)$/.test(b.textContent.trim())).map(pick),
      otherButtons: [...section.querySelectorAll('button')]
        .filter((b) => !/^(保存|Save)$/.test(b.textContent.trim()))
        .map((b) => b.textContent.trim()).slice(0, 8),
      themeVars: (() => {
        const s = getComputedStyle(document.body);
        return {
          bgLayer3: s.getPropertyValue('--dsw-alias-bg-layer-3').trim(),
          labelPrimary: s.getPropertyValue('--dsw-alias-label-primary').trim()
        };
      })()
    };
  })()`);

  if (ours.found !== true) {
    check('能定位到本包设置区（[data-plugin-config]）', false, '插件页上没有设置区');
  } else {
    check('能定位到本包设置区（[data-plugin-config]）', true, `字段 ${String(ours.keys.length)} 个`);
    // 结构判据：身份、label 绑定、说明行、分隔线。
    check(`判据1：${String(EXPECTED_KEYS.length)} 个字段的 id 身份与代码逐项一致`,
      JSON.stringify(ours.keys) === JSON.stringify(EXPECTED_KEYS), ours.keys.join(','));
    check('判据1：每个字段有 label 行且 for 绑定到控件 id',
      ours.labelFor.length === EXPECTED_KEYS.length
        && ours.labelFor.every((f) => EXPECTED_KEYS.includes(f.slice('plugin-config-'.length))),
      `label ${String(ours.labelFor.length)} 个`);
    check('判据2：每个字段有说明行（aria-describedby 指向的元素在场）',
      ours.messages.every((m) => m.present && m.id !== ''), `说明行 ${String(ours.messages.filter((m) => m.present).length)}/${String(EXPECTED_KEYS.length)}`);
    check('判据2：相邻字段之间有分隔线（官方 0.5px；本机 DPR 下计算样式取整为 1px）',
      ours.separators.length === EXPECTED_KEYS.length - 1
        && ours.separators.every((w) => { const v = Number.parseFloat(w); return v > 0 && v <= 1; }),
      `实得 ${ours.separators.join(', ')}`);
    check(`判据10：读数长在 ${String(MS_FIELD_KEYS.length)} 个毫秒字段的说明行里（换行 + 两段 span，值只写秒文本）`,
      ours.readoutSpans === MS_FIELD_KEYS.length,
      `生效段 span=${String(ours.readoutSpans)} 期望=${String(MS_FIELD_KEYS.length)}`);
    check('判据5：页脚只有「保存」一个动作按钮（枚举的「恢复默认」除外）',
      ours.saveButtons.length === 1 && ours.otherButtons.every((t) => t === '' || /恢复默认|Reset/.test(t)),
      `save=${String(ours.saveButtons.length)} 其他=${ours.otherButtons.join('|')}`);

    // 度量参考表（官方 fields.module.css 的声明值；颜色走主题变量解析）。
    const firstInput = ours.valueInputs[0];
    const REF = [
      ['值字段高度', firstInput.height, (v) => Math.abs(Number.parseFloat(v) - 34) <= 2, '34px'],
      ['值字段圆角', firstInput.radius, (v) => Math.abs(Number.parseFloat(v) - 8) <= 1, '8px'],
      ['值字段字号', firstInput.fontSize, (v) => v === '13px', '13px'],
      ['值字段左内边距', firstInput.paddingLeft, (v) => Math.abs(Number.parseFloat(v) - 12) <= 1, '0 12px'],
      ['值字段边框宽', firstInput.borderWidth, (v) => Number.parseFloat(v) <= 1, '.5px'],
      ['值字段边框样式', firstInput.borderStyle, (v) => v === 'solid', 'solid']
    ];
    for (const [label, actual, ok, expected] of REF) {
      check(`${label} 与官方字段声明一致（${expected}）`, ok(actual), `实得 ${String(actual)}`);
    }
    check('主题变量确实存在（说明页面用了宿主那套主题变量）',
      ours.themeVars.bgLayer3 !== '' && ours.themeVars.labelPrimary !== '',
      `bg-layer-3=${ours.themeVars.bgLayer3}`);
    // 枚举 select：唯一允许的形态偏离——但度量仍照官方 input + 官方下拉成例。
    const sel = ours.enumSelects[0];
    check('枚举 select 度量照官方（34px 高 / 8px 圆角 / appearance:none / 右侧留白 ≥ 28px）',
      ours.enumSelects.length === 2
        && Math.abs(Number.parseFloat(sel.height) - 34) <= 2
        && Math.abs(Number.parseFloat(sel.radius) - 8) <= 1
        && sel.appearance === 'none'
        && Number.parseFloat(sel.paddingRight) >= 28,
      `select×${String(ours.enumSelects.length)} 高=${sel.height} 圆角=${sel.radius} appearance=${sel.appearance} pr=${sel.paddingRight}`);
    check('枚举 select 底色/文字色与主题变量解析一致（不是写死的颜色）',
      sel.background !== '' && sel.color === firstInput.color,
      `底色=${sel.background} 文字=${sel.color}（值字段文字 ${firstInput.color}）`);
  }

  console.log('· ② 官方设置页：读官方字段度量作对照');
  await clickBy(`[...document.querySelectorAll('[aria-label]')].find((n) => (n.getAttribute('aria-label') ?? '').replace(/\\s+/g, '') === '设置')`, '设置');
  await sleep(2500);
  const official = await evaluate(page, `(() => {
    const pick = ${PICK};
    // 官方值字段 = 官方设置页上 34px 高、8px 圆角的文本输入件（fields.module.css 的形态）。
    const inputs = [...document.querySelectorAll('input')]
      .map((n) => ({ node: n, m: pick(n) }))
      .filter((e) => Math.abs(Number.parseFloat(e.m.height) - 34) <= 2
        && Math.abs(Number.parseFloat(e.m.radius) - 8) <= 1);
    const saves = [...document.querySelectorAll('button')]
      .filter((b) => /^(保存|Save)$/.test(b.textContent.trim())).map(pick);
    return { count: inputs.length, first: inputs[0]?.m ?? null, saves: saves[0] ?? null };
  })()`);
  if (ours.found === true && official.count > 0) {
    const a = ours.valueInputs[0];
    const b = official.first;
    const PAIRS = [
      ['高度', a.height, b.height, 2],
      ['圆角', a.radius, b.radius, 1],
      ['字号', a.fontSize, b.fontSize, 0],
      ['左内边距', a.paddingLeft, b.paddingLeft, 1],
      ['边框宽', a.borderWidth, b.borderWidth, 0.6],
      ['底色', a.background, b.background, 0],
      ['文字色', a.color, b.color, 0]
    ];
    for (const [label, mine, theirs, tol] of PAIRS) {
      const near = tol === 0
        ? mine === theirs
        : Math.abs(Number.parseFloat(mine) - Number.parseFloat(theirs)) <= tol;
      check(`并排对比：值字段${label}与官方设置页字段一致（容差 ${String(tol)}）`, near,
        `本包 ${String(mine)} 官方 ${String(theirs)}`);
    }
    if (official.saves !== null) {
      const s = ours.saveButtons[0];
      check('并排对比：保存按钮高度与官方一致（容差 2px）',
        Math.abs(Number.parseFloat(s.height) - Number.parseFloat(official.saves.height)) <= 2,
        `本包 ${String(s.height)} 官方 ${String(official.saves.height)}`);
    }
  } else {
    check('官方设置页上能找到官方字段作对照', official.count > 0, `实得 ${String(official.count)} 个`);
  }
  log = { ours: { keys: ours.keys, separators: ours.separators, saveButtons: ours.saveButtons.length }, official: { count: official.count }, results };

  console.log('· ③ 回本包插件页，两主题截图（顶部 + 底部）');
  await clickBy(`[...document.querySelectorAll('button,[role=button],a')].find((n) => (n.getAttribute('aria-label') || '') === '插件')`, '插件');
  await sleep(2000);
  await clickBy(`[...document.querySelectorAll('*')].find((n) => (n.getAttribute('aria-label') || '') === '查看 dsh-async-tools')`, '查看 dsh-async-tools');
  await sleep(2500);

  for (const scheme of ['dark', 'light']) {
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }]
    });
    // `data-ds-dark-theme` 是主题运行时的选择器（实读确认）。
    await evaluate(page, scheme === 'dark'
      ? 'document.documentElement.setAttribute("data-ds-dark-theme", ""), true'
      : 'document.documentElement.removeAttribute("data-ds-dark-theme"), true');
    await sleep(1500);

    // 控件底色跟主题走的实证：直接读本卡字段在当前主题下的计算值。
    const bg = await evaluate(page, `(() => {
      const ctl = document.querySelector('[data-plugin-config] input[id^="plugin-config-"], [data-plugin-config] select[id^="plugin-config-"]');
      return ctl === null ? '' : getComputedStyle(ctl).backgroundColor;
    })()`);
    console.log(`  ${scheme} 主题下字段底色：${bg}`);
    check(`${scheme} 主题下字段在场且能读到底色`, /^rgba?\(/.test(bg), bg);
    if (scheme === 'dark') {
      const parts = (/^rgba?\((\d+), (\d+), (\d+)/.exec(bg) ?? []).slice(1).map(Number);
      check('深色主题下字段底色随之变深（不是白底）',
        parts.length === 3 && parts[0] < 90 && parts[1] < 90 && parts[2] < 90, `深色下实得 ${bg}`);
    } else {
      // 浅色主题真的切过去的可见证据：设置区根的底色必须是浅的。
      const sectionBg = await evaluate(page, `(() => {
        const section = document.querySelector('[data-plugin-config]');
        let node = section;
        while (node !== null) {
          const bg = getComputedStyle(node).backgroundColor;
          if (bg !== '' && bg !== 'rgba(0, 0, 0, 0)' && !/rgba\\(0, 0, 0, 0\\)/.test(bg)) return bg;
          node = node.parentElement;
        }
        return '';
      })()`);
      const parts = (/^rgba?\((\d+), (\d+), (\d+)/.exec(sectionBg) ?? []).slice(1).map(Number);
      check('浅色主题下设置区底色确实是浅的（主题真的切过去了）',
        parts.length === 3 && parts[0] > 180 && parts[1] > 180 && parts[2] > 180, `浅色下实得 ${sectionBg}`);
    }

    for (const where of ['top', 'bottom']) {
      await evaluate(page, `(() => {
        const scrollers = [...document.querySelectorAll('*')].filter((n) => {
          const s = getComputedStyle(n);
          return /auto|scroll/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 8;
        });
        for (const n of scrollers) n.scrollTop = ${where === 'top' ? '0' : 'n.scrollHeight'};
        return scrollers.length;
      })()`);
      await sleep(700);
      const shot = await screenshot(page, `${SHOTS}\\card-${scheme}-${where}.png`,
        { width: 1500, height: 1000, fullPage: true });
      console.log(`  截图 ${scheme}-${where}：${String(shot.bytes)} B`);
    }
    // 顶部图的可判性：同框能看到页签与设置区；底部图：末字段 + 保存按钮。
    const view = await evaluate(page, `(() => {
      const text = document.body.innerText;
      return {
        hasTabs: text.includes('插件配置') || text.includes('插件列表'),
        hasLastField: text.includes('子代理后端') || text.includes('subagent'),
        hasSave: text.includes('保存') || text.includes('Save')
      };
    })()`);
    check(`${scheme} 视图可判（页签=${String(view.hasTabs)} 末字段=${String(view.hasLastField)} 保存=${String(view.hasSave)}）`,
      view.hasTabs && view.hasLastField && view.hasSave, JSON.stringify(view));
  }

  failed = results.filter((r) => !r.ok).length;
  mkdirSync(LOGS, { recursive: true });
  writeFileSync(join(LOGS, 'card-visual.json'),
    JSON.stringify({ at: new Date().toISOString(), base: BASE, ...log, results }, null, 2), 'utf8');
} catch (error) {
  console.log('PROBE-ERROR', error instanceof Error ? error.message : String(error));
} finally {
  try { page?.close(); } catch { /* 忽略 */ }
  await close();
}

console.log('');
console.log(`${String(results.length - failed)}/${String(results.length)} 条成立。`);
console.log(`截图目录：${SHOTS}`);
process.exitCode = failed === 0 ? 0 : 1;
