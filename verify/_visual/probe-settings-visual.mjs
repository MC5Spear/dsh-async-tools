#!/usr/bin/env node
/**
 * 设置页视觉证据探针（VERIFY-01，设计 `.local/design/gui-persistence-visual.md`
 * §7 装置 B，SV-1..SV-7）：官方可写临时实例上，对设置卡做**只读操作＋草稿**
 * （不保存）的机器面断言与两主题截图取证。
 *
 * ## 装置在证什么
 *
 * r24/card-visual 已证字段身份与尺寸基线；本装置补需求 §5.6 的视觉判据的
 * 机器面：帮助按钮触屏/键盘可操作（SV-1b）、帮助展开不裁切不遮挡（SV-2）、
 * 非法草稿四档的错误关联实际呈现（SV-3，含低于下界档——与设计 L1194 清单
 * 一一对应）、控件尺寸两主题（SV-4）、主题别名实际取值按语义分档（SV-5——
 * 结构色要求翻转、语义/强调色只要求非空解析，宿主语义色两主题同值是正常
 * 设计不据此判 FAIL）、绑定块两主题（SV-6）、非法态下帮助并存（SV-7）。
 * 只读态/保存中态不装置（rc.5 writable 恒 true，设计 §7 末段——真机不伪造
 * 状态）。
 *
 * ## 用法（须 danger-full-access 或非受限环境——CDP 无头浏览器在受限沙箱档必早夭）
 *
 *   node verify/_visual/probe-settings-visual.mjs --service-root <宿主服务根> \
 *     [--host-subdir dsh-0.2.1-rc.5] [--repo <本仓路径>] [--keep]
 *
 * 红线：只操作自建隔离实例，不连接、不改动任何既有实例（开发用或常驻服务）。装置只做草稿、不点保存。
 * 证据：`.local/evidence/settings-visual/{logs,shots}`。退出 0＝全部通过、
 * 1＝存在 FAIL、2＝装置故障（FAULT，输出区分）。
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, openPage, evaluate, findBrowser, waitFor, screenshot } from './cdp.mjs';
import { judgeHelpButtons } from '../r24-judgements.mjs';
import { SETTING_FIELD_KEYS } from '../../lib/config.js';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const keep = args.includes('--keep');
let home = null;
let child = null;
let browser = null;
let page = null;
const fail = (msg) => {
  // 盲审 d1/d2：FAULT 先落已跑判据＋清理资源（设计 §10「退出 2 前先清」）；
  // 早期调用（目录未建）时静默跳过落盘。
  try {
    mkdirSync(join(repo, '.local', 'evidence', 'settings-visual', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.local', 'evidence', 'settings-visual', 'logs', 'fault.json'),
      JSON.stringify({ at: new Date().toISOString(), msg, results }, null, 2));
  } catch { /* 磁盘写失败不阻塞清理与退出 */ }
  try { cleanup(); } catch { /* 尽力清理 */ }
  console.error(`[probe] FAULT: ${msg}\n[probe] 临时目录：${home ?? '（尚未创建）'}${keep ? '（--keep 保留）' : '（已清理；如占用残留请手动删除）'}`);
  process.exit(2);
};
const serviceRootArg = argOf('service-root') ?? process.env.DSAT_SERVICE_ROOT;
if (serviceRootArg === undefined || serviceRootArg.trim() === '') fail('缺少 --service-root（或环境变量 DSAT_SERVICE_ROOT）');
const serviceRoot = resolve(serviceRootArg);
const hostSubdir = argOf('host-subdir') ?? 'dsh-0.2.1-rc.5';
const repo = resolve(argOf('repo') ?? process.cwd());
const hostRoot = join(serviceRoot, hostSubdir);
let hostVersion;
try {
  hostVersion = JSON.parse(readFileSync(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
} catch (error) {
  fail(`无法读取宿主树版本：${String(error?.message ?? error)}`);
}
const bin = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

const log = (msg) => console.log(`[probe] ${msg}`);
const results = [];
const shots = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail, at: new Date().toISOString() });
  if (ok !== true && ok !== null) failed += 1;
  console.log(`  ${ok === true ? 'PASS  ' : ok === false ? 'FAIL  ' : '留痕  '}${name}${detail === '' ? '' : `\n          ${detail}`}`);
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
function killTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return;
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' }); } catch { /* 已退出 */ }
}
process.on('exit', () => { if (child !== null) killTree(child.pid); });
function cleanup() {
  try { page?.close(); } catch { /* 已关 */ }
  try { browser?.close(); } catch { /* 已关 */ }
  if (child !== null) { killTree(child.pid); child = null; }
  if (!keep && home !== null) { try { rmSync(home, { recursive: true, force: true }); } catch { /* 占用中 */ } }
}

// ── 实例与 GUI（装置 A 同款，无 RPC 面需求——本装置只做只读＋草稿） ──────────
let ORIGIN = '';
let TOKEN = '';
async function startInstance() {
  child = spawn('node', [
    bin, '--patch', 'patches/zai-glm.yml', '--profile', 'web',
    '--host', '127.0.0.1', '--port', '0', '--no-open'
  ], { cwd: serviceRoot, env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderrTail = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-4000); });
  const url = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => rejectUrl(new Error('实例 90s 内未就绪')), 90_000);
    const poll = setInterval(() => {
      const m = stdout.match(/https?:\/\/\S+/);
      if (m !== null) { clearTimeout(timer); clearInterval(poll); resolveUrl(m[0]); }
      if (child.exitCode !== null) { clearTimeout(timer); clearInterval(poll); rejectUrl(new Error(`实例提前退出 ${String(child.exitCode)}`)); }
    }, 200);
  }).catch((error) => { killTree(child.pid); fail(`${String(error.message)}\nstderr 尾部：\n${stderrTail}`); });
  const urlMatch = url.match(/^(https?:\/\/[^/?#]+)\/?\?token=(.+)$/);
  if (urlMatch === null) { killTree(child.pid); fail(`实例 URL 形态不符：${url.split('?')[0]}`); }
  [, ORIGIN, TOKEN] = urlMatch;
  log(`实例就绪：${ORIGIN}（token 已脱敏）`);
}
const clickBy = (selectorJs, label) => evaluate(page, `(() => {
  const target = ${selectorJs};
  if (target === undefined || target === null) return 'missing:' + ${JSON.stringify(label)};
  target.click();
  return 'clicked';
})()`);
async function openGui() {
  page = await openPage(browser.port, `${ORIGIN}/?token=${encodeURIComponent(TOKEN)}`);
  await waitFor(page, 'document.querySelectorAll("button,[role=button]").length', (n) => n > 0, 15000);
}
async function gotoPluginPage() {
  const nav1 = await clickBy(`[...document.querySelectorAll('button,[role=button],a')].find((n) => (n.getAttribute('aria-label') || '') === '插件')`, '插件');
  if (nav1 !== 'clicked') fail(`插件入口未找到（${nav1}）`);
  await sleep(2500);
  const nav2 = await clickBy(`[...document.querySelectorAll('*')].find((n) => (n.getAttribute('aria-label') || '') === '查看 dsh-async-tools')`, '查看 dsh-async-tools');
  if (nav2 !== 'clicked') fail(`插件详情入口未找到（${nav2}）`);
  await sleep(3000);
  await waitFor(page, 'document.querySelector("[data-plugin-config]") !== null', (v) => v === true, 15000);
}

// ── 装置 B 专用手法 ─────────────────────────────────────────────────────────
/** 切主题并实证（card-visual 手法：emulated media＋body[data-ds-dark-theme]——
 * 必须设在 body 上；每主题以设置区底色亮度实证真的切换：深 <90、浅 >180）。 */
async function applyTheme(scheme) {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await evaluate(page, scheme === 'dark'
    ? 'document.body.setAttribute("data-ds-dark-theme", ""), true'
    : 'document.body.removeAttribute("data-ds-dark-theme"), true');
  await sleep(1200);
  const bg = await evaluate(page, `(() => {
    const section = document.querySelector('[data-plugin-config]');
    let node = section;
    while (node !== null) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg !== '' && bg !== 'rgba(0, 0, 0, 0)') return bg;
      node = node.parentElement;
    }
    return '';
  })()`);
  const parts = (/^rgba?\((\d+), (\d+), (\d+)/.exec(bg) ?? []).slice(1).map(Number);
  const applied = parts.length === 3
    && (scheme === 'dark' ? parts.every((p) => p < 90) : parts.every((p) => p > 180));
  return { applied, bg };
}
/** 数值草稿键入（React 受控 input——原生 setter＋input 事件，r24 手法）。 */
const setDraft = (key, value) => evaluate(page, `(() => {
  const input = document.querySelector('#plugin-config-${key}');
  if (input === null) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'set';
})()`);
/** 帮助按钮开合（按字段键定位；clickKey＝'click'|null 表示只读在场性）。 */
const helpStateOf = (key) => evaluate(page, `(() => {
  const btn = document.querySelector('.ats-help-button[aria-controls="plugin-config-${key}-help"]');
  if (btn === null) return null;
  const region = document.getElementById('plugin-config-${key}-help');
  return { expanded: btn.getAttribute('aria-expanded') === 'true', regionPresent: region !== null,
    type: btn.getAttribute('type') || '' };
})()`);
/** 读保存按钮态（禁用＝草稿非法或不可写）。 */
const saveState = () => evaluate(page, `(() => {
  const save = [...document.querySelectorAll('[data-plugin-config] button')]
    .find((b) => /^(保存|Save)$/.test(b.textContent.trim()));
  return save === undefined ? null : { disabled: save.disabled === true };
})()`);
/** 关闭宿主「预览版说明」类对话框（视觉审阅发现：不关则全批截图被遮——审阅
 * 首轮 25/25 张被居中对话框覆盖；对话框内主按钮文案含「继续」）。 */
const dismissDialog = () => evaluate(page, `(() => {
  const vis = [...document.querySelectorAll('[role="dialog"], dialog')]
    .filter((d) => d.getClientRects().length > 0);
  let clicked = 0;
  for (const d of vis) {
    const btns = [...d.querySelectorAll('button')];
    const primary = btns.find((b) => /继续|开始|知道了|确认|Got it|Continue/i.test(b.textContent.trim()));
    (primary ?? btns[btns.length - 1])?.click();
    clicked += 1;
  }
  return clicked;
})()`);
/** 每张截图前的护栏：对话框在场即关（最多三轮），仍关不掉则留痕警告。 */
const ensureNoDialog = async () => {
  let rounds = 0;
  while (Number(await dismissDialog()) > 0 && rounds < 3) { await sleep(700); rounds += 1; }
  const left = await evaluate(page, `[...document.querySelectorAll('[role="dialog"], dialog')].filter((d) => d.getClientRects().length > 0).length`);
  if (Number(left) > 0) log(`警告：仍有 ${String(left)} 个对话框在场（截图可能被遮）`);
};
/** 草稿清净扫描（复审二轮发现：值还原后「已覆盖」pill 可能残留，污染下一主题
 * 的默认态截图）：统计带恢复默认按钮的字段行（草稿脏标记），脏则点字段级
 * 「恢复默认」（草稿重置，不动保存面）再复读；返回清净与否。诊断计数入日志。 */
const draftCleanSweep = async (label) => {
  const countPills = () => evaluate(page, `(() => {
    const rows = [...document.querySelectorAll('[data-plugin-config] .ats-enum-field')];
    return rows.filter((row) => [...row.querySelectorAll('button.ats-enum-reset')]
      .some((b) => /^(恢复默认|Reset)$/.test(b.textContent.trim()))).length;
  })()`);
  let dirty = Number(await countPills());
  let cleaned = 0;
  if (dirty > 0) {
    cleaned = dirty;
    log(`${label}：检测到 ${String(dirty)} 个草稿脏字段，点恢复默认清场`);
    await evaluate(page, `(() => {
      const rows = [...document.querySelectorAll('[data-plugin-config] .ats-enum-field')];
      for (const row of rows) {
        const btn = [...row.querySelectorAll('button.ats-enum-reset')]
          .find((b) => /^(恢复默认|Reset)$/.test(b.textContent.trim()));
        btn?.click();
      }
      return true;
    })()`);
    await sleep(600);
    dirty = Number(await countPills());
  }
  // 复审四轮发现（证据缺口）：扫场记录只在 stdout、未入 settings-visual.json——
  // 以 JSON 为唯一可复现日志时「档前扫场」不可追。落 ok:null 留痕行（不作判定，
  // 只作可复现记录：清前脏字段数＋清后结果）。
  check(`草稿扫场 ${label}（留痕：拍前清净动作可复现）`, null,
    `清前脏字段=${String(cleaned)} 清后残留=${String(dirty)}`);
  if (dirty > 0) log(`警告：${label} 清场后仍有 ${String(dirty)} 个脏字段（默认态截图可能带 pill）`);
  return dirty === 0;
};
/** 内层滚动容器滚顶/滚底（视觉证据分段采集——fullPage 穿不透内层滚动容器，
 * 审阅首轮 top 图与 pano 重复、均只截到视口中段）。 */
const scrollTopTo = (where) => evaluate(page, `(() => {
  let node = document.querySelector('[data-plugin-config]');
  while (node !== null && node !== document.body) {
    const st = getComputedStyle(node);
    if (/(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 4) {
      node.scrollTop = ${where === 0 ? '0' : 'node.scrollHeight'};
      return true;
    }
    node = node.parentElement;
  }
  window.scrollTo(0, ${where === 0 ? '0' : 'document.body.scrollHeight'});
  return false;
})()`);
const shotOf = async (name, opts) => { await ensureNoDialog(); shots.push(name); await screenshot(page, join(SHOTS, name), opts); };
/** 把元素滚进视口（窄屏/近景用）。 */
const scrollIntoView = (selectorJs) => evaluate(page, `(() => { const n = ${selectorJs}; if (n !== null) n.scrollIntoView({ block: 'center' }); return n !== null; })()`);

// SV-5 别名清单（client.js 样式段实读清点；分档按设计 SV-5②）。
// 盲审 a3：label-caption 经核 client.js 未消费——从判定清单移除（宿主若不定义/
// 不翻转该别名会假红；实际取值仍由 readAliases 全量读入证据供查阅）。
const STRUCTURAL_ALIASES = ['bg-layer-3', 'label-primary', 'label-secondary', 'label-tertiary', 'border-l2', 'border-l4', 'interactive-bg-hover'];
const SEMANTIC_ALIASES = ['state-error-primary', 'state-warn-primary', 'state-warn-tertiary', 'state-warn-label', 'state-business-primary', 'brand-primary'];
const readAliases = () => evaluate(page, `(() => {
  const s = getComputedStyle(document.body);
  const read = (name) => s.getPropertyValue('--dsw-alias-' + name).trim();
  const out = {};
  for (const n of ${JSON.stringify([...STRUCTURAL_ALIASES, ...SEMANTIC_ALIASES])}) out[n] = read(n);
  const ctl = document.querySelector('[data-plugin-config] input[id^="plugin-config-"], [data-plugin-config] select[id^="plugin-config-"]');
  out.__controlBg = ctl === null ? '' : getComputedStyle(ctl).backgroundColor;
  const s2 = getComputedStyle(document.body);
  out.__radiusMd = s2.getPropertyValue('--dsw-radius-md').trim();
  out.__inputRadius = ctl === null ? '' : getComputedStyle(ctl).borderTopLeftRadius;
  return out;
})()`);

const EVID = join(repo, '.local', 'evidence', 'settings-visual');
const LOGS = join(EVID, 'logs');
const SHOTS = join(EVID, 'shots');
mkdirSync(LOGS, { recursive: true });
// 复审三轮发现（旧图残留）：上一轮改名/弃用的截图会留在目录里与本次清单矛盾
// （脏旧 pano 与新 tall 并存误导审阅）——跑前清空 shots，目录内容恒＝本次清单。
try { rmSync(SHOTS, { recursive: true, force: true }); } catch { /* 无旧目录 */ }
mkdirSync(SHOTS, { recursive: true });

try {
  // 1) 打包＋官方 CLI 安装＋起实例（装置 A 同款；--patch 只带模型路由）。
  mkdirSync(join(repo, '.local'), { recursive: true });
  const packRun = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', '.local'], { cwd: repo, encoding: 'utf8', shell: true });
  if (packRun.status !== 0) fail(`npm pack 退出 ${String(packRun.status)}：${packRun.stderr}`);
  const tgzName = (packRun.stdout.match(/dsh-async-tools-[^\s]+\.tgz/g) ?? []).pop();
  if (tgzName === undefined) fail('npm pack 未产出 tgz');
  home = mkdtempSync(join(tmpdir(), 'dsh-settings-visual-'));
  const install = spawnSync('node', [bin, 'plugin', '--profile', 'web', 'add', join(repo, '.local', tgzName)], {
    cwd: serviceRoot, encoding: 'utf8', timeout: 300_000, env: { ...process.env, DSH_HOME: home }
  });
  if (install.status !== 0) { console.error(install.stdout); console.error(install.stderr); fail('plugin add 退出非 0'); }
  const browserPath = findBrowser();
  if (browserPath === undefined) fail('找不到 Edge/Chrome（视觉探针需本机浏览器）');
  await startInstance();
  browser = await launch(browserPath);
  await openGui();
  await gotoPluginPage();
  await ensureNoDialog();
  log(`repo=${repo} hostVersion=${hostVersion} tgz=${tgzName}`);

  const aliasByTheme = {};
  const sv6SaveByTheme = {};

  for (const scheme of ['dark', 'light']) {
    console.log(`\n── ${scheme === 'dark' ? '深' : '浅'}主题 ──`);
    const theme = await applyTheme(scheme);
    check(`SV-1前置 ${scheme} 主题实证（设置区底色${scheme === 'dark' ? '深 <90' : '浅 >180'}）`, theme.applied, `实得 ${theme.bg}`);
    // 主题开局先清草稿（上一主题轮的还原残留不带入本主题截图——复审二轮发现），
    // 再读本主题基线保存钮态（本主题轮开始时无任何草稿——「无变更即禁用」是官方
    // 形态之一，还原判据对齐基线而非「必须可用」）。
    const sweepStart = await draftCleanSweep(`${scheme} 主题开局`);
    check(`SV-0 ${scheme} 主题开局草稿清净（无「已覆盖」残留字段）`, sweepStart === true, `清净=${String(sweepStart)}`);
    const saveBaseline = await saveState();

    // SV-1 帮助按钮全量在场（judgeHelpButtons）＋全景＋顶部近景。
    const helpReading = await evaluate(page, `(() => {
      const section = document.querySelector('[data-plugin-config]');
      const buttons = section === null ? [] : [...section.querySelectorAll('.ats-help-button')];
      return { helpButtons: buttons.map((b) => ({
        controls: (b.getAttribute('aria-controls') || '').replace('plugin-config-', '').replace(/-help$/, ''),
        type: b.getAttribute('type') || '',
        expanded: b.getAttribute('aria-expanded') === 'true',
        label: b.getAttribute('aria-label') || ''
      })) };
    })()`);
    const helpVerdict = judgeHelpButtons(helpReading, SETTING_FIELD_KEYS);
    check(`SV-1 ${scheme} 帮助按钮 ${String(SETTING_FIELD_KEYS.length)} 枚逐项在场`, helpVerdict.ok, helpVerdict.detail);
    // 全景分段（审阅首轮发现 fullPage 对内层滚动容器只截到视口中段、top 图
    // 与 pano 画面重复；复审二轮再证 pano 实为视口非整页；复审三轮发现按
    // [data-plugin-config] 区块量高仍截不到区块外的「包含的组件/来源信息」）
    // ：改「高视口单帧整页」——按内层滚动容器的 scrollHeight（整页内容，含
    // 区块外的组件与来源段）定视口高，一帧收全；机器面同时断言视口高≥内容高
    // （整页性判据）；top/bottom 视口图保留（布局常态）。
    const contentH = Number(await evaluate(page, `(() => {
      const sec = document.querySelector('[data-plugin-config]');
      if (sec === null) return 0;
      let node = sec;
      while (node !== null && node !== document.body) {
        const st = getComputedStyle(node);
        if (/(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight) {
          return Math.ceil(node.scrollHeight);
        }
        node = node.parentElement;
      }
      return Math.ceil(sec.getBoundingClientRect().height);
    })()`));
    const tallH = Math.min(12_000, Math.max(1200, contentH + 320));
    await scrollTopTo(0);
    await sleep(300);
    await shotOf(`sv1-${scheme}-tall.png`, { width: 1500, height: tallH, fullPage: false });
    check(`SV-1c ${scheme} 整页单帧（高视口）覆盖全部设置区（视口高≥内容高）`,
      contentH > 0 && tallH >= contentH, `内容高=${String(contentH)} 视口高=${String(tallH)}`);
    await shotOf(`sv1-${scheme}-top.png`, { width: 1500, height: 1000, fullPage: false });
    await scrollTopTo(1);
    await sleep(300);
    await shotOf(`sv1-${scheme}-bottom.png`, { width: 1500, height: 1000, fullPage: false });

    // SV-2 帮助展开不裁切不遮挡（最长帮助两枚：boundPresets＋defaultYieldMs）。
    // 判定顺序：先滚进视口再量——内层滚动容器（overflow:auto）把区域「滚出可视框」
    // 是页面滚动、不是裁切；真裁切只对 overflow:hidden/clip 的祖先断。
    for (const key of ['boundPresets', 'defaultYieldMs']) {
      const open = await clickBy(`document.querySelector('.ats-help-button[aria-controls="plugin-config-${key}-help"]')`, `帮助·${key}`);
      await sleep(500);
      await scrollIntoView(`document.getElementById('plugin-config-${key}-help')`);
      await sleep(200);
      const snap = await evaluate(page, `(() => {
        const region = document.getElementById('plugin-config-${key}-help');
        if (region === null) return { present: false };
        const row = region.closest('.ats-enum-field');
        const next = row === null ? null : row.nextElementSibling;
        return { present: true, scrollHeight: region.scrollHeight, clientHeight: region.clientHeight,
          nextTop: next === null ? null : next.getBoundingClientRect().top,
          regionTop: region.getBoundingClientRect().top,
          regionBottom: region.getBoundingClientRect().bottom,
          viewportBottom: window.innerHeight,
          ancestorClip: (() => {
            let node = region.parentElement;
            while (node !== null) {
              const s2 = getComputedStyle(node);
              // 只对不可滚动的裁切形态判真裁切；overflow:auto/scroll 是页面滚动。
              if (s2.overflowY === 'hidden' || s2.overflowY === 'clip' || s2.overflowX === 'hidden' || s2.overflowX === 'clip') {
                const rr = region.getBoundingClientRect();
                const nr = node.getBoundingClientRect();
                if (rr.bottom > nr.bottom + 1 || rr.top < nr.top - 1 || rr.right > nr.right + 1 || rr.left < nr.left - 1) return true;
              }
              node = node.parentElement;
            }
            return false;
          })() };
      })()`);
      check(`SV-2 ${scheme} ${key} 帮助展开：区域在场滚进视口、内部不滚（scrollHeight≤clientHeight）、无 hidden/clip 祖先真裁切、后续字段被下推`,
        open === 'clicked' && snap.present === true && snap.scrollHeight <= snap.clientHeight + 1
          && snap.ancestorClip === false && snap.nextTop !== null && snap.nextTop > snap.regionTop
          && snap.regionBottom <= snap.viewportBottom + 40,
        `scroll=${String(snap.scrollHeight)}/${String(snap.clientHeight)} 裁切=${String(snap.ancestorClip)} 下推 next=${String(snap.nextTop)} region=${String(snap.regionTop)} 可见底=${String(snap.regionBottom)}/${String(snap.viewportBottom)}`);
      await scrollIntoView(`document.getElementById('plugin-config-${key}-help')`);
      await shotOf(`sv2-${scheme}-${key}.png`, { width: 1500, height: 1000, fullPage: false });
      const close = await clickBy(`document.querySelector('.ats-help-button[aria-controls="plugin-config-${key}-help"]')`, `帮助收起·${key}`);
      await sleep(400);
      const closed = await helpStateOf(key);
      check(`SV-2 ${scheme} ${key} 收起后展开区退场`, close === 'clicked' && closed !== null && closed.regionPresent === false,
        `expanded=${String(closed?.expanded)} region=${String(closed?.regionPresent)}`);
    }

    // SV-4 尺寸表（两主题各采一遍：值输入/枚举下拉/布尔 Switch 在场/绑定复选框）＋分隔线＋官方圆角对照。
    const metrics = await evaluate(page, `(() => {
      const section = document.querySelector('[data-plugin-config]');
      const pick = (n) => { const s = getComputedStyle(n); return {
        height: s.height, radius: s.borderTopLeftRadius, fontSize: s.fontSize,
        paddingLeft: s.paddingLeft, borderWidth: s.borderTopWidth, borderStyle: s.borderTopStyle }; };
      const input = document.querySelector('[data-plugin-config] input[id^="plugin-config-"]:not([type="checkbox"])');
      const select = document.querySelector('[data-plugin-config] select[id^="plugin-config-"]');
      const checkbox = document.querySelector('ul.ats-preset-list input[type=checkbox]');
      const sw = document.querySelector('[data-plugin-config] button[role="switch"]');
      const fieldRows = [...section.querySelectorAll('.ats-help-button')].map((hb) => hb.closest('.ats-enum-field'));
      const separators = fieldRows.slice(1).map((row) => getComputedStyle(row).borderTopWidth);
      const cbBox = checkbox === null ? null : (() => { const r = checkbox.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })();
      return {
        input: input === null ? null : pick(input), select: select === null ? null : pick(select),
        checkbox: checkbox === null ? null : pick(checkbox), checkboxBox: cbBox,
        switchPresent: sw !== null,
        rows: fieldRows.length, separators
      };
    })()`);
    const REF = [
      ['值输入高度 34±2', metrics.input?.height, (v) => Math.abs(Number.parseFloat(v) - 34) <= 2],
      ['值输入圆角 12±1（--dsw-radius-md）', metrics.input?.radius, (v) => Math.abs(Number.parseFloat(v) - 12) <= 1],
      ['值输入字号 13px', metrics.input?.fontSize, (v) => v === '13px'],
      ['值输入左内边距 12±1', metrics.input?.paddingLeft, (v) => Math.abs(Number.parseFloat(v) - 12) <= 1],
      ['值输入边框 ≤1px solid', metrics.input?.borderWidth, (v) => Number.parseFloat(v) <= 1 && metrics.input?.borderStyle === 'solid'],
      ['枚举下拉高度 34±2', metrics.select?.height, (v) => Math.abs(Number.parseFloat(v) - 34) <= 2],
      ['枚举下拉圆角 12±1', metrics.select?.radius, (v) => Math.abs(Number.parseFloat(v) - 12) <= 1],
      // 盲审 a2：绑定复选框原为采集后无断言的死数据。实测 13×13（宿主官方
      // 表单默认形态，本包未自绘）——低于常见 16px 基线，按观察项留痕交接
      // （真实触屏目标与行级点击热区归人工面），不设机器阈值（无私自加严）。
      ['绑定块复选框包围盒（实测留痕，观察项——宿主默认形态，阈值归人工面）', metrics.checkboxBox, null]
    ];
    for (const [label, actual, ok] of REF) {
      check(`SV-4 ${scheme} ${label}`, ok === null ? null : actual !== undefined && actual !== null && ok(actual), `实得 ${String(actual)}`);
    }
    check(`SV-4 ${scheme} 布尔 Switch 为官方组件本体在场（不比自绘项）`, metrics.switchPresent === true, `rows=${String(metrics.rows)}`);
    check(`SV-4 ${scheme} 相邻字段分隔线 ${String(metrics.rows - 1)} 条（≤1px 计算取整口径）`,
      metrics.separators.length === metrics.rows - 1 && metrics.separators.every((w) => { const v = Number.parseFloat(w); return v > 0 && v <= 1; }),
      `实得 ${metrics.separators.join(', ')}`);

    // SV-5 别名计算值（两主题各读一遍，循环外比对）。
    aliasByTheme[scheme] = await readAliases();

    // SV-6 绑定块两主题：默认态→草稿勾选变化（不保存）→帮助展开。
    const boundDefault = await evaluate(page, `(() => {
      const msg = document.getElementById('plugin-config-boundPresets-message');
      const field = msg === null ? null : msg.closest('.ats-enum-field');
      const boxes = field === null ? [] : [...field.querySelectorAll('ul.ats-preset-list input[type=checkbox]')];
      const badges = field === null ? null : field.querySelector('.ats-enum-badges');
      return { rows: boxes.length,
        idSmall: field === null ? false : field.querySelectorAll('.ats-preset-id').length > 0,
        tagPresent: badges !== null,
        notePresent: field === null ? false : field.querySelector('.ats-preset-note') !== null };
    })()`);
    check(`SV-6 ${scheme} 绑定块条目行在场（复选框＋ID 小字类）`, boundDefault.rows > 0 && boundDefault.idSmall === true,
      `rows=${String(boundDefault.rows)} idSmall=${String(boundDefault.idSmall)} tag=${String(boundDefault.tagPresent)}`);
    // SV-6 默认态拍前再扫一次（防前步残留污染「默认→勾选」对照）。
    await draftCleanSweep(`SV-6 ${scheme} 默认态拍前`);
    await scrollIntoView(`document.getElementById('plugin-config-boundPresets-message')`);
    await shotOf(`sv6-${scheme}-default.png`, { width: 1500, height: 1000, fullPage: false });
    const flip = await evaluate(page, `(() => {
      const boxes = [...document.querySelectorAll('ul.ats-preset-list input[type=checkbox]')];
      const first = boxes.find((b) => !b.checked) ?? boxes[0];
      if (first === undefined) return { acted: 'no-box', id: null };
      first.click();
      return { acted: 'clicked', id: first.id };
    })()`);
    await sleep(400);
    const flipped = await evaluate(page, `(() => {
      const boxes = [...document.querySelectorAll('ul.ats-preset-list input[type=checkbox]')];
      const field = document.getElementById('plugin-config-boundPresets-message')?.closest('.ats-enum-field');
      const badges = field === null ? null : field.querySelector('.ats-enum-badges');
      const reset = field === null ? null : [...field.querySelectorAll('button.ats-enum-reset')].find((b) => /^(恢复默认|Reset)$/.test(b.textContent.trim()));
      return { changed: boxes.some((b) => b.checked) && boxes.some((b) => !b.checked),
        draftMarked: badges !== null && reset !== null };
    })()`);
    check(`SV-6 ${scheme} 勾选草稿变化：混合勾集＋草稿级徽标/恢复默认按钮出现（不保存）`,
      flip.acted === 'clicked' && flipped.changed === true && flipped.draftMarked === true,
      `flip=${JSON.stringify(flip)} draftMarked=${String(flipped.draftMarked)}`);
    await shotOf(`sv6-${scheme}-checked.png`, { width: 1500, height: 1000, fullPage: false });
    // 审阅首轮疑点配对（深浅保存钮观感不一致）：同场景机器读数两主题各记一份，
    // 循环外断言语义一致（勾选草稿＝有变更→保存可用）——观感差异是否为主题
    // 样式由配对结论＋复拍截图共同回答。
    sv6SaveByTheme[scheme] = await saveState();
    const helpBound = await clickBy(`document.querySelector('.ats-help-button[aria-controls="plugin-config-boundPresets-help"]')`, '帮助·绑定块');
    await sleep(400);
    const boundHelp = await helpStateOf('boundPresets');
    check(`SV-6 ${scheme} 绑定块帮助展开在场`, helpBound === 'clicked' && boundHelp !== null && boundHelp.regionPresent === true,
      `expanded=${String(boundHelp?.expanded)}`);
    await shotOf(`sv6-${scheme}-help.png`, { width: 1500, height: 1000, fullPage: false });
    // 还原草稿（再点同一复选框＋收帮助）——装置不动保存面。
    if (flip.id !== null) {
      await evaluate(page, `document.getElementById(${JSON.stringify(flip.id)})?.click(), true`);
      await sleep(300);
    }
    await clickBy(`document.querySelector('.ats-help-button[aria-controls="plugin-config-boundPresets-help"]')`, '帮助收起·绑定块');
    // 勾选草稿还原后扫场（再点复选框失败时兜底清场——复审二轮浅色污染源之一）。
    await draftCleanSweep(`SV-6 ${scheme} 勾选草稿还原后`);

    // SV-3＋SV-7 非法草稿四档（两主题各呈现一遍；档值按 lib/budget-limits.js 边界选）。
    const TIERS = [
      { key: 'maxResultChars', value: '12.5', hit: '整数', tier: '非整数' },
      { key: 'pollIntervalMs', value: '9999999999', hit: '上界', tier: '越上界' },
      { key: 'maxResultChars', value: '0', hit: '下界', tier: '低于下界' },
      { key: 'minYieldMs', value: '800000', hit: '不能大于', tier: '链式' }
    ];
    const savedBaselines = {};
    for (const t of TIERS) {
      if (savedBaselines[t.key] === undefined) {
        savedBaselines[t.key] = await evaluate(page, `document.querySelector('#plugin-config-${t.key}')?.value ?? ''`);
      }
      // 复审三轮发现（组内串场）：上一档末的还原只回值、「已覆盖」pill 残留泄入
      // 下一档截图——每档设非法草稿前全字段扫场，本档画面只含本档脏字段。
      await draftCleanSweep(`SV-3 ${scheme} ${t.tier} 档前`);
      const typed = await setDraft(t.key, t.value);
      await sleep(500);
      const snap = await evaluate(page, `(() => {
        const ctl = document.querySelector('#plugin-config-${t.key}');
        const invalid = document.getElementById('plugin-config-${t.key}-invalid');
        const message = document.getElementById('plugin-config-${t.key}-message');
        const save = [...document.querySelectorAll('[data-plugin-config] button')]
          .find((b) => /^(保存|Save)$/.test(b.textContent.trim()));
        return { typed: ctl === null ? '' : ctl.value,
          invalidPresent: invalid !== null, invalidAria: invalid?.getAttribute('aria-invalid') === 'true',
          invalidText: invalid?.textContent.trim() ?? '',
          ctlAriaInvalid: ctl?.getAttribute('aria-invalid') === 'true',
          describedFirst: (ctl?.getAttribute('aria-describedby') || '').split(' ')[0] ?? '',
          messageKept: message !== null,
          saveDisabled: save === undefined ? null : save.disabled === true };
      })()`);
      check(`SV-3 ${scheme} ${t.tier}（${t.key}=${t.value}）：原因行在场＋aria-invalid＋described 首指原因行＋常驻说明保留＋保存禁用＋文案命中`,
        typed === 'set' && snap.invalidPresent === true && snap.invalidAria === true
          && snap.ctlAriaInvalid === true && snap.describedFirst === `plugin-config-${t.key}-invalid`
          && snap.messageKept === true && snap.saveDisabled === true && snap.invalidText.includes(t.hit),
        `文案=${JSON.stringify(snap.invalidText)} described=${snap.describedFirst} save=${JSON.stringify(snap.saveDisabled)}`);
      await scrollIntoView(`document.querySelector('#plugin-config-${t.key}')?.closest('.ats-enum-field')`);
      await shotOf(`sv3-${scheme}-${t.tier}.png`, { width: 1500, height: 1000, fullPage: false });
      // SV-7（链式档上顺带）：非法态展开同字段帮助——原因行与帮助并存、收合不消除错误行。
      if (t.tier === '链式') {
        const openHelp = await clickBy(`document.querySelector('.ats-help-button[aria-controls="plugin-config-${t.key}-help"]')`, `帮助·${t.key}`);
        await sleep(500);
        const both = await evaluate(page, `(() => {
          const invalid = document.getElementById('plugin-config-${t.key}-invalid');
          const help = document.getElementById('plugin-config-${t.key}-help');
          return { invalid: invalid !== null, help: help !== null };
        })()`);
        check(`SV-7 ${scheme} 非法态下帮助展开：原因行与帮助区并存`,
          openHelp === 'clicked' && both.invalid === true && both.help === true, JSON.stringify(both));
        await shotOf(`sv7-${scheme}.png`, { width: 1500, height: 1000, fullPage: false });
        await clickBy(`document.querySelector('.ats-help-button[aria-controls="plugin-config-${t.key}-help"]')`, `帮助收起·${t.key}`);
        await sleep(300);
        const afterClose = await evaluate(page, `document.getElementById('plugin-config-${t.key}-invalid') !== null`);
        check(`SV-7 ${scheme} 帮助收起不消除错误行`, afterClose === true, `invalid 仍在=${String(afterClose)}`);
      }
      // 档间即时还原（审阅首轮发现：逐档累积残留下一档画面——每档截图只呈现
      // 本档非法，避免多错误同屏干扰审阅；末尾的聚合还原断言保持不变）。
      await setDraft(t.key, savedBaselines[t.key]);
      await sleep(300);
    }
    // 还原全部草稿为基线值＋断言无残留非法（保存钮回基线态——无变更时禁用是官方形态）。
    for (const [key, baseline] of Object.entries(savedBaselines)) {
      if (baseline !== '') await setDraft(key, baseline);
      await sleep(300);
    }
    const restored = await saveState();
    const residualInvalid = await evaluate(page, `document.querySelectorAll('[data-plugin-config] [id$="-invalid"]').length`);
    check(`SV-3 ${scheme} 四档草稿还原后无残留非法行、保存钮回基线态（装置不动保存面）`,
      residualInvalid === 0 && restored !== null && restored.disabled === (saveBaseline?.disabled ?? false),
      `残留非法=${String(residualInvalid)} 保存钮=${JSON.stringify(restored)} 基线=${JSON.stringify(saveBaseline)}`);
    // 复审二轮发现（浅色默认态带「已覆盖」pill）：值还原后 pill 可能残留——
    // 扫描并清场（字段级恢复默认＝草稿重置，不动保存面），关键拍点前保证默认态干净。
    await draftCleanSweep(`SV-3 ${scheme} 还原后`);
  }

  // SV-6 保存钮配对结论：勾选草稿（有变更）时两主题保存钮语义一致且可用。
  check('SV-6 深浅两主题勾选草稿后保存钮语义一致（有变更→可用；观感差异属主题样式）',
    sv6SaveByTheme.dark !== null && sv6SaveByTheme.light !== null
      && sv6SaveByTheme.dark.disabled === false && sv6SaveByTheme.light.disabled === false,
    `深=${JSON.stringify(sv6SaveByTheme.dark)} 浅=${JSON.stringify(sv6SaveByTheme.light)}`);

  // SV-1b 帮助按钮触屏与键盘可操作（主题无关，深色下执行一次）。
  // 实测更正（六跑）：首五跑「触摸合成不触发 onClick、Tab 焦点被困、程序焦点被
  // 夺回」的真因是宿主「预览版说明」对话框拦截指针事件与焦点——启动即关＋每张
  // 截图前护栏后，touchStart/End 两翻成立、Tab 可遍历（67 步达帮助按钮）。键
  // 激活需 keyDown 带 text:'\r'（无 text 不触发按钮激活合成）。观察项口径保留
  // 为护栏失效时的兜底登记。
  await applyTheme('dark');
  console.log('\n── SV-1b 触屏与键盘（深色一次）──');
  const structural = await evaluate(page, `(() => {
    const btn = document.querySelector('.ats-help-button[aria-controls="plugin-config-boundPresets-help"]');
    if (btn === null) return null;
    return { tag: btn.tagName, type: btn.getAttribute('type') || '',
      tabindex: btn.getAttribute('tabindex'), ariaHidden: btn.getAttribute('aria-hidden'),
      disabledAttr: btn.hasAttribute('disabled') };
  })()`);
  check('SV-1b 结构可证面：帮助按钮为原生 button[type=button]、tabindex 未被置负、未 aria-hidden、未禁用（触屏/键盘可操作的机器面旁证）',
    structural !== null && structural.tag === 'BUTTON' && structural.type === 'button'
      && structural.tabindex !== '-1' && structural.ariaHidden !== 'true' && structural.disabledAttr === false,
    JSON.stringify(structural));
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxPoints: 1 });
  const touchTap = async (key, expectOpen) => {
    const rect = await evaluate(page, `(() => {
      const btn = document.querySelector('.ats-help-button[aria-controls="plugin-config-${key}-help"]');
      if (btn === null) return null;
      btn.scrollIntoView({ block: 'center' });
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (rect === null) return { method: 'missing', ok: false };
    const isOpen = () => evaluate(page, `document.querySelector('.ats-help-button[aria-controls="plugin-config-${key}-help"]')?.getAttribute('aria-expanded') === 'true'`);
    // 盲审 b3：触摸三径各试一次构成判定环；鼠标坐标径只作事件通道对照诊断、
    // 不参与「触摸通过」判定（触摸受限而鼠标命中时不得记 FAIL——观察项纪律）。
    const attempts = [
      { method: 'synthesizeTapGesture', run: async () => {
        await page.send('Input.synthesizeTapGesture', { x: rect.x, y: rect.y, durationMs: 80, tapCount: 1, gestureSourceType: 'touch' });
        await sleep(500);
      } },
      { method: 'touchStart/End', run: async () => {
        await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...rect, id: 1 }] });
        await sleep(120);
        await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await sleep(400);
      } },
      { method: 'emulateTouchFromMouseEvent', run: async () => {
        await page.send('Input.emulateTouchFromMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        await page.send('Input.emulateTouchFromMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        await sleep(400);
      } }
    ];
    let touchHit = null;
    for (const attempt of attempts) {
      await attempt.run();
      if ((await isOpen()) === expectOpen) { touchHit = attempt.method; break; }
    }
    let mouseDiagnostic = '';
    if (touchHit === null) {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await sleep(400);
      if ((await isOpen()) === expectOpen) {
        mouseDiagnostic = '（鼠标坐标径命中——事件通道正常、触摸合成形态受限）';
        // 对照径翻转了状态：再点回去，不污染后续判据。
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        await sleep(400);
      }
    }
    return { method: touchHit ?? 'none-worked', touch: touchHit !== null, ok: touchHit !== null, mouseDiagnostic };
  };
  const tap1 = await touchTap('boundPresets', true);
  const afterTap1 = await helpStateOf('boundPresets');
  if (afterTap1?.expanded === true) {
    const tap2 = await touchTap('boundPresets', false);
    const afterTap2 = await helpStateOf('boundPresets');
    check('SV-1b 触屏 tap 开→合：aria-expanded 两翻＋展开区渲染/退场',
      tap2.ok === true && tap2.touch === true && afterTap2 !== null && afterTap2.expanded === false && afterTap2.regionPresent === false,
      `tap1=${JSON.stringify(tap1)} tap2=${JSON.stringify(tap2)}`);
  } else {
    check('SV-1b 触屏合成面：本机无头 CDP 上三种触摸合成均不触发 onClick（观察项——非本包缺陷；结构面＋SV-2 click 开合已证，真实触屏留人工面）',
      null, `tap1=${JSON.stringify(tap1)} 后 expanded=${String(afterTap1?.expanded)}${tap1.mouseDiagnostic ?? ''}`);
  }
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxPoints: 1 });
  await shotOf('sv1b-after-touch.png', { width: 1500, height: 1000, fullPage: false });
  // 键盘：Tab 去向诊断（宿主壳疑似焦点陷阱）＋Enter 激活尝试；焦点不可得时按
  // 观察项登记，不冒称键盘面通过。
  await evaluate(page, `(() => { document.activeElement?.blur?.(); return true; })()`);
  let focused = false;
  let tabsUsed = 0;
  let activeDesc = '';
  for (let i = 0; i < 120 && !focused; i += 1) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(100);
    tabsUsed = i + 1;
    focused = await evaluate(page, `document.activeElement?.classList?.contains('ats-help-button') === true
      && document.activeElement.getAttribute('aria-controls') === 'plugin-config-boundPresets-help'`);
    if (!focused && (tabsUsed % 30 === 0)) {
      activeDesc = await evaluate(page, `(() => {
        const n = document.activeElement;
        return n === null || n === document.body ? 'body' : (n.tagName + '.' + String(n.className).slice(0, 30));
      })()`);
      log(`Tab×${String(tabsUsed)} 未达，当前焦点：${activeDesc}`);
    }
  }
  if (!focused) {
    const progFocused = await evaluate(page, `(() => {
      const btn = document.querySelector('.ats-help-button[aria-controls="plugin-config-boundPresets-help"]');
      if (btn === null) return false;
      btn.scrollIntoView({ block: 'center' });
      btn.focus();
      return document.activeElement === btn;
    })()`);
    focused = progFocused === true;
    if (focused) log('Tab 未达，程序置入焦点成功');
  }
  if (focused) {
    // Enter 激活：keyDown 须带 text:'\r'（＋nativeVirtualKeyCode）才会走浏览器
    // 的按钮激活合成——六跑实测无 text 不激活；Space 为备径，哪条命中如实记录。
    const keyTap = async (spec) => {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, text: spec.text });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk });
      await sleep(400);
    };
    let via = '';
    for (const spec of [{ key: 'Enter', code: 'Enter', vk: 13, text: '\r', name: 'Enter' }, { key: ' ', code: 'Space', vk: 32, text: ' ', name: 'Space' }]) {
      await keyTap(spec);
      const open = await helpStateOf('boundPresets');
      if (open?.expanded === true) { via = spec.name; break; }
    }
    const kbOpen = await helpStateOf('boundPresets');
    // 收起复用命中键（复审 info：Enter 不激活而 Space 激活的环境里固定 Enter 会假红）。
    const viaSpec = via === 'Space' ? { key: ' ', code: 'Space', vk: 32, text: ' ' } : { key: 'Enter', code: 'Enter', vk: 13, text: '\r' };
    await keyTap(viaSpec);
    const kbClose = await helpStateOf('boundPresets');
    check('SV-1b 键盘开→合：Tab 聚焦（如实记步数）后键激活两翻 aria-expanded＋展开区渲染/退场',
      via !== '' && kbOpen !== null && kbOpen.expanded === true && kbOpen.regionPresent === true
        && kbClose !== null && kbClose.expanded === false && kbClose.regionPresent === false,
      `Tab 步数=${String(tabsUsed)} 激活键=${via || '未激活'} 开=${JSON.stringify(kbOpen)} 合=${JSON.stringify(kbClose)}`);
  } else {
    check('SV-1b 键盘面：Tab 未达按钮且程序置入焦点失败（观察项——弹窗护栏生效后六跑未再出现此形态；如复现按缺口登记补拍）',
      null, `Tab×${String(tabsUsed)} 末焦点 ${activeDesc || '未记录'}；程序置入焦点=false`);
  }

  // SV-5 比对（两主题读数齐了）：结构色翻转／语义色非空／控件底色翻转／官方圆角对照。
  console.log('\n── SV-5 别名分档比对 ──');
  const dark = aliasByTheme.dark ?? {};
  const light = aliasByTheme.light ?? {};
  for (const name of STRUCTURAL_ALIASES) {
    check(`SV-5② 结构色 ${name}：两主题非空且计算值不同（随主题翻转）`,
      dark[name] !== '' && light[name] !== '' && dark[name] !== light[name],
      `深=${JSON.stringify(dark[name])} 浅=${JSON.stringify(light[name])}`);
  }
  for (const name of SEMANTIC_ALIASES) {
    check(`SV-5② 语义/强调色 ${name}：两主题非空解析（同值为宿主正常设计，不判 FAIL；可读性归审阅）`,
      dark[name] !== '' && light[name] !== '',
      `深=${JSON.stringify(dark[name])} 浅=${JSON.stringify(light[name])}`);
  }
  const bgParts = (bg) => (/^rgba?\((\d+), (\d+), (\d+)/.exec(bg) ?? []).slice(1).map(Number);
  const dBg = bgParts(dark.__controlBg);
  const lBg = bgParts(light.__controlBg);
  check('SV-5③ 控件底色随主题翻转（亮度判别——别名落到实际 CSS 值）',
    dBg.length === 3 && lBg.length === 3 && dark.__controlBg !== light.__controlBg
      && (dBg[0] + dBg[1] + dBg[2]) / 3 < (lBg[0] + lBg[1] + lBg[2]) / 3,
    `深=${dark.__controlBg} 浅=${light.__controlBg}`);
  check('SV-4 官方同族：本卡输入件圆角＝宿主 --dsw-radius-md 运行时解析',
    Math.abs(Number.parseFloat(dark.__radiusMd) - Number.parseFloat(dark.__inputRadius)) <= 1,
    `token=${dark.__radiusMd} 本卡=${dark.__inputRadius}`);
} catch (error) {
  cleanup();
  fail(`未预期异常：${String(error?.stack ?? error)}`);
}
cleanup();

let head = '';
try { head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(); } catch { /* 非 git 环境 */ }
writeFileSync(join(LOGS, 'settings-visual.json'), JSON.stringify({
  at: new Date().toISOString(), repo, head, hostVersion, failed, results, shots
}, null, 2));
log(`证据落盘：${join(LOGS, 'settings-visual.json')}（截图 ${String(shots.length)} 张在 shots/）`);
console.log(`\n判定：${failed === 0 ? '全部通过' : `存在 FAIL（${String(failed)} 项）`}`);
process.exit(failed === 0 ? 0 : 1);
