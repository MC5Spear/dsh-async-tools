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
 * 3. **截图**（给人看 + 给有视觉功能的子代理审）：每主题两张视口图——顶部一张＋
 *    内层容器滚到底一张（卡片在内层滚动容器里，`captureBeyondViewport` 对"只有
 *    内层容器滚"的页面无效，页脚与末尾字段必须真滚到位再拍）＋浅色枚举展开图
 *    一张。截图前先以设置区底色实证主题已生效。
 *    断言接不了"看起来搭不搭"，那一层交给看图的人。
 *    运行前提：`danger-full-access` 或非受限环境（受限令牌下浏览器必早夭，见
 *    `cdp.mjs` 头注）。
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
    // 字段行锚 = 帮助按钮（.ats-help-button）所在的 .ats-enum-field 容器——值字段与
    // 布尔字段（官方 P.Switch，不吃 id prop——设计 §5.5）都有；17 个容器即 17 行。
    // 布尔字段判定 = 行内有 button[role="switch"]（与 probe-r24 的口径一致）。
    const helpButtons = [...section.querySelectorAll('.ats-help-button')];
    const keyOfHelp = (n) => (n.getAttribute('aria-controls') || '').replace('plugin-config-', '').replace(/-help$/, '');
    const fieldRows = helpButtons.map((hb) => hb.closest('.ats-enum-field'));
    const booleanRows = fieldRows.filter((row) => row !== null && row.querySelector('button[role="switch"]') !== null);
    const messageOf = (ctl) => {
      const described = ctl.getAttribute('aria-describedby') || '';
      const node = described === '' ? null : document.getElementById(described);
      return { id: described, present: node !== null, text: node === null ? '' : node.textContent.trim() };
    };
    // 分隔线 = 字段行容器自身的上边框（官方 .field:not(:first-child) 的形态）。
    const separators = fieldRows.slice(1).map((row) => (row === null ? '' : getComputedStyle(row).borderTopWidth));
    return {
      found: true,
      keys: helpButtons.map(keyOfHelp),
      labelFor: [...section.querySelectorAll('label[for^="plugin-config-"]')].map((n) => n.getAttribute('for')),
      // 布尔字段的可见标签是 .ats-enum-label 文本（P.Switch 不接 label[for]，两种
      // 写法渲染相同；这里只证明「有可见标签文本」，不要求绑定形态）。
      booleanLabels: booleanRows.map((row) => (row.querySelector('.ats-enum-label')?.textContent ?? '').trim()),
      // 布尔行的说明行按 id 全局在场核对（官方 Switch 未接 aria-describedby，
      // 不能用值字段那条 describedby 通道——那是结构审查登记项，不是视觉判据）。
      booleanMessages: booleanRows.map((row) => {
        const key = (row.querySelector('.ats-help-button')?.getAttribute('aria-controls') || '').replace('plugin-config-', '').replace(/-help$/, '');
        return key !== '' && document.getElementById('plugin-config-' + key + '-message') !== null;
      }),
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
    // 身份按**集合**比（不比 DOM 顺序——四组键的拼装顺序与渲染顺序本就不必一致）。
    check(`判据1：${String(EXPECTED_KEYS.length)} 个字段的 id 身份与代码逐项一致（集合等价）`,
      ours.keys.length === EXPECTED_KEYS.length
        && JSON.stringify([...new Set(ours.keys)].sort()) === JSON.stringify([...EXPECTED_KEYS].sort()),
      ours.keys.join(','));
    check('判据1：值字段有 label[for] 绑定、布尔字段有可见标签文本',
      ours.labelFor.length === EXPECTED_KEYS.length - ours.booleanLabels.length
        && ours.labelFor.every((f) => EXPECTED_KEYS.includes(f.slice('plugin-config-'.length)))
        && ours.booleanLabels.every((t) => t !== ''),
      `label ${String(ours.labelFor.length)} 个；布尔标签 ${String(ours.booleanLabels.filter((t) => t !== '').length)}/${String(ours.booleanLabels.length)}`);
    check('判据2：每个字段有说明行（值字段 aria-describedby 指向在场；布尔行内 -message 段在场）',
      ours.messages.every((m) => m.present && m.id !== '') && ours.booleanMessages.every(Boolean),
      `说明行 ${String(ours.messages.filter((m) => m.present).length + ours.booleanMessages.filter(Boolean).length)}/${String(EXPECTED_KEYS.length)}`);
    check('判据2：相邻字段之间有分隔线（官方 0.5px；本机 DPR 下计算样式取整为 1px）',
      ours.separators.length === EXPECTED_KEYS.length - 1
        && ours.separators.every((w) => { const v = Number.parseFloat(w); return v > 0 && v <= 1; }),
      `实得 ${ours.separators.length} 条：${ours.separators.join(', ')}`);
    check(`判据10：读数长在 ${String(MS_FIELD_KEYS.length)} 个毫秒字段的说明行里（换行 + 两段 span，值只写秒文本）`,
      ours.readoutSpans === MS_FIELD_KEYS.length,
      `生效段 span=${String(ours.readoutSpans)} 期望=${String(MS_FIELD_KEYS.length)}`);
    check('判据5：页脚只有「保存」一个动作按钮（枚举的「恢复默认」除外）',
      ours.saveButtons.length === 1 && ours.otherButtons.every((t) => t === '' || /恢复默认|Reset/.test(t)),
      `save=${String(ours.saveButtons.length)} 其他=${ours.otherButtons.join('|')}`);

    // 度量参考表（官方 fields.module.css 的声明值；颜色走主题变量解析）。
    // 值字段圆角 = --dsw-radius-md（12px，fields.module.css .input 用它）；
    // --dsw-radius-sm（8px）用在帮助按钮上——两个变量名近邻，断言时勿混。
    const firstInput = ours.valueInputs[0];
    const REF = [
      ['值字段高度', firstInput.height, (v) => Math.abs(Number.parseFloat(v) - 34) <= 2, '34px'],
      ['值字段圆角', firstInput.radius, (v) => Math.abs(Number.parseFloat(v) - 12) <= 1, '12px（--dsw-radius-md）'],
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
    check('枚举 select 度量照官方（34px 高 / 12px 圆角 / appearance:none / 右侧留白 ≥ 28px；枚举字段现为三个：uiLang、agentLang、askUiSeat）',
      ours.enumSelects.length === 3
        && Math.abs(Number.parseFloat(sel.height) - 34) <= 2
        && Math.abs(Number.parseFloat(sel.radius) - 12) <= 1
        && sel.appearance === 'none'
        && Number.parseFloat(sel.paddingRight) >= 28,
      `select×${String(ours.enumSelects.length)} 高=${sel.height} 圆角=${sel.radius} appearance=${sel.appearance} pr=${sel.paddingRight}`);
    check('枚举 select 底色/文字色与主题变量解析一致（不是写死的颜色）',
      sel.background !== '' && sel.color === firstInput.color,
      `底色=${sel.background} 文字=${sel.color}（值字段文字 ${firstInput.color}）`);
  }

  console.log('· ② 官方形态对照：宿主主题 token 现读（fields.module.css 声明值的运行时对应物）');
  // 不再点开「设置」对话框取样：对话框控件是另一组件族（灰底药丸 36px），不是
  // fields.module.css 的白底描边输入件——拿它并排只会制造假红。官方同族证据 =
  // 本卡输入件的圆角与宿主 --dsw-radius-md 运行时解析值一致（.input 消费该 token）。
  const official = await evaluate(page, `(() => {
    const s = getComputedStyle(document.body);
    const input = document.querySelector('[data-plugin-config] input[id^="plugin-config-"]');
    return {
      radiusMd: s.getPropertyValue('--dsw-radius-md').trim(),
      radiusSm: s.getPropertyValue('--dsw-radius-sm').trim(),
      inputRadius: input === null ? '' : getComputedStyle(input).borderTopLeftRadius
    };
  })()`);
  check('官方同族实证：本卡输入件圆角 = 宿主 --dsw-radius-md（fields.module.css .input 的圆角源）',
    Math.abs(Number.parseFloat(official.radiusMd) - Number.parseFloat(official.inputRadius)) <= 1,
    `token=${official.radiusMd} 本卡=${official.inputRadius}（--dsw-radius-sm=${official.radiusSm} 用于帮助按钮）`);
  log = { ours: { keys: ours.keys, separators: ours.separators, saveButtons: ours.saveButtons.length }, official: { radiusMd: official.radiusMd }, results };

  console.log('· ③ 本包插件页，两主题截图（每主题一张整页图；浅色另拍一张枚举展开）');
  for (const scheme of ['dark', 'light']) {
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }]
    });
    // 宿主深色选择器是 body[data-ds-dark-theme]（boot CSS 与主题包样式表实读）：
    // 必须设在 body 上，设在 documentElement 不生效——否则「深色截图」实为浅色
    // 渲染，两主题的对照没有意义。
    await evaluate(page, scheme === 'dark'
      ? 'document.body.setAttribute("data-ds-dark-theme", ""), true'
      : 'document.body.removeAttribute("data-ds-dark-theme"), true');
    await sleep(1500);

    // 主题**已生效**的实证（两档都验，防「名为深色实为浅色」的无效证据）：
    // 设置区向上找第一层有底色的祖先，深色须 <90、浅色须 >180。
    const sectionBg = await evaluate(page, `(() => {
      const section = document.querySelector('[data-plugin-config]');
      let node = section;
      while (node !== null) {
        const bg = getComputedStyle(node).backgroundColor;
        if (bg !== '' && bg !== 'rgba(0, 0, 0, 0)') return bg;
        node = node.parentElement;
      }
      return '';
    })()`);
    const parts = (/^rgba?\((\d+), (\d+), (\d+)/.exec(sectionBg) ?? []).slice(1).map(Number);
    const applied = parts.length === 3
      && (scheme === 'dark' ? parts[0] < 90 && parts[1] < 90 && parts[2] < 90
        : parts[0] > 180 && parts[1] > 180 && parts[2] > 180);
    check(`${scheme} 主题真的切过去了（设置区底色 ${scheme === 'dark' ? '变深' : '为浅'}）`,
      applied, `${scheme} 下实得 ${sectionBg}`);

    // 控件底色跟主题走的实证：直接读本卡字段在当前主题下的计算值。
    const bg = await evaluate(page, `(() => {
      const ctl = document.querySelector('[data-plugin-config] input[id^="plugin-config-"], [data-plugin-config] select[id^="plugin-config-"]');
      return ctl === null ? '' : getComputedStyle(ctl).backgroundColor;
    })()`);
    console.log(`  ${scheme} 主题下字段底色：${bg}`);
    check(`${scheme} 主题下字段在场且能读到底色`, /^rgba?\(/.test(bg), bg);

    const shot = await screenshot(page, `${SHOTS}\\card-${scheme}-top.png`,
      { width: 1500, height: 1000, fullPage: true });
    console.log(`  截图 ${scheme}-top：${String(shot.bytes)} B`);
    // 内层滚动容器滚到底再拍一张：页脚「保存」与末尾字段（askExtendMs/askUiSeat）
    // 只在这张里入镜——fullPage 截图对"内层容器滚"的页面截不到视口外内容。
    await evaluate(page, `(() => {
      const scrollers = [...document.querySelectorAll('*')].filter((n) => {
        const s = getComputedStyle(n);
        return /auto|scroll/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 8;
      });
      for (const n of scrollers) n.scrollTop = n.scrollHeight;
      return scrollers.length;
    })()`);
    await sleep(700);
    const shotBottom = await screenshot(page, `${SHOTS}\\card-${scheme}-bottom.png`,
      { width: 1500, height: 1000, fullPage: false });
    console.log(`  截图 ${scheme}-bottom：${String(shotBottom.bytes)} B`);

    // 整页图的可判性：页签 + 末字段标签 + 保存按钮都在 innerText 里。
    // 末字段标签必须抄**真实标签全文**（「子代理创建后端」；拿缩写当断言子串
    // 会恒假红）；布尔标签「命令静默失败提示」一并作证。
    const view = await evaluate(page, `(() => {
      const text = document.body.innerText;
      return {
        hasTabs: text.includes('插件配置') || text.includes('插件列表'),
        hasLastField: text.includes('子代理创建后端') || text.includes('待答问题显示方式'),
        hasSave: text.includes('保存') || text.includes('Save')
      };
    })()`);
    check(`${scheme} 视图可判（页签=${String(view.hasTabs)} 末字段=${String(view.hasLastField)} 保存=${String(view.hasSave)}）`,
      view.hasTabs && view.hasLastField && view.hasSave, JSON.stringify(view));
  }
  // 枚举展开态（浅色）：点开一个 select 截图后收起。原生下拉若不被 CDP 截图
  // 捕获（OS 合成层），此图只证控件本体形态——判读时按图上实见下结论。
  await evaluate(page, `(() => {
    const s = document.querySelector('[data-plugin-config] select[id^="plugin-config-"]');
    if (s !== null) { s.focus(); s.click(); }
    return s !== null;
  })()`);
  await sleep(700);
  await screenshot(page, `${SHOTS}\\card-light-enum-open.png`, { width: 1500, height: 1000, fullPage: false });
  await evaluate(page, `(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const s = document.querySelector('[data-plugin-config] select[id^="plugin-config-"]');
    if (s !== null) s.blur();
    return true;
  })()`);

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
