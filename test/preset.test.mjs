/**
 * 预设补丁校验器的变异测试（对象 `tools/validate-preset.mjs`，判据清单以
 * `tools/validate-preset.mjs` 文件头为准（现行十四条，③b、⑤b、⑧b 各独立计
 * 一条）；变异验收参数化覆盖两份补丁）。
 *
 * 为什么必须做变异测试而不是只看校验报告：绿读数证明不了校验器拦得住改错。
 * 下面的用例逐类锁死：补丁被改坏时 `validate-preset.mjs` 必须红，报错必须点名
 * 对应判据；基线用例同守"合法补丁必须通过"，防止变异断言恒真。
 *
 * 形态：对象是 `presets/dsh-async.patch.yml`（基线 = shipped standard）与
 * `presets/dsh-async-create.patch.yml`（基线 = shipped cordis）；校验器以
 * **模块导入**方式在进程内调用（子进程 spawn 在沙箱里 EPERM，且进程内调用让
 * "变异 → 断言"同轮完成）。变异副本写在系统临时目录，用完即删。涉及词典锚句
 * （⑤b/⑦/⑪）的用例把「校验器 + 文案表」成对复制到临时目录再动态导入（保留
 * 相对布局），对 `lib/text.js` 副本做变异。
 *
 * dsh-async-create 专属用例：P1 基线绿、P2/P3 基线行缺/多、P4 派生入口翻活、
 * P5 plugin-manager 回归布尔禁用（⑧b）、P6 词典纪律锚句（⑤b）、P7 pwsh 挂回、
 * P8 tool-bash 表达式、P9 未知 config.id、P10 护栏、P11 互斥判据复合、
 * P12 嵌套行缺失、P13 toolName、P14 期望集与 0.2.1-rc.3 证据树对账、
 * P15 provider 形态、P16 词典公共纪律段同源。
 * 第五行工具与禁用改动专属用例：P17 tool-workflow 翻活、P18 dsh-async 的
 * tool-subagent 翻活、P19 删 async-workflow 行、P20 async-workflow 挪出
 * delegation 组（设计 §3.6 行位）、P21 删 workflow-ptc（create 侧）、P22 门槛锚句。
 * 提问角色纪律（ASK-01，需求 §9.1）用例：P23 词典四组锚词缺一必红
 * （en/zh 两档 × 两份补丁同守）。
 * 锚句表逐句齐套用例：P24 dsh-async 有界等待取回锚（⑤b）、P25 create
 * 变体差异句锚（⑤b）、P26 两期望表×两语言档逐锚参数化删除变异（⑤b）、
 * P27 锚句表快照锁（⑤b）——文案侧删句由 P26 全表逐锚击杀看守（表内每条
 * 锚被删必红）；表侧弱化（删行、改锚、加锚）由 P27 的独立期望清单看守，
 * 两方向都要显式改测试才会动。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePatch, EXPECTATIONS, expectedTopFromBaseline, loadYaml } from '../tools/validate-preset.mjs';
import { candidateModules } from '../tools/_host-resolve.mjs';
import { t } from '../lib/text.js';
import { hostTestByProbe } from './_host-gate.mjs';

// 宿主锚探测（文件级）：validate-preset 的 YAML 解析依赖宿主树自带的 js-yaml
// （候选路径复用 _host-resolve 的候选表），本文件全部用例都经 validatePatch →
// loadYaml。候选全缺（离线形态）时 loadYaml 抛「找不到宿主的 js-yaml」——整组
// 自跳过并打印理由（ci.yml offline 作业的契约）；锚在场时全部照常跑。探测只认
// 候选全缺这一种错误：锚在场而 js-yaml 本身加载失败属于真故障，原样红。
let yamlAbsent = false;
try {
  await loadYaml();
} catch (error) {
  if (!String(error?.message ?? error).includes('找不到宿主的 js-yaml')) throw error;
  yamlAbsent = true;
}
const hostTest = await hostTestByProbe(yamlAbsent);

const PATCH = join(import.meta.dirname, '..', 'presets', 'dsh-async.patch.yml');
const PATCH_CREATE = join(import.meta.dirname, '..', 'presets', 'dsh-async-create.patch.yml');
const baseline = readFileSync(PATCH, 'utf8');
const baselineCreate = readFileSync(PATCH_CREATE, 'utf8');

/** 两份 shipped 基线补丁（P14 对账的唯一出处；宿主锚**在场时**读不到即红——
 *  那是防 with-host 形态假绿的口径，不是离线契约；宿主锚缺席（离线形态）时
 *  本文件整组自跳过，见文件头探测）。
 *
 *  出处 = 宿主安装树里的 `@deepseek-ai/dsh-web-app/presets/`，目录按
 *  `DSAT_HOST_MODULES` → `DSH_HOME/profiles` → `%APPDATA%/npm` 次序推导
 *  （与 `tools/_host-resolve.mjs` 同一套候选），**不写死机器路径**——公开仓的 CI 用
 *  `npm install @deepseek-ai/dsh@0.2.1-rc.3` 提供这个包。
 *
 *  npm 安装树（本机与 CI 同源装出）的两份基线文件字节固定（standard 6799 B、
 *  cordis 7406 B——基线漂移会先在这里露头）。锚点取哪边期望集都一致。 */
const WEB_APP_PRESETS = candidateModules(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  .map((dir) => join(dir, '@deepseek-ai', 'dsh-web-app', 'presets'))
  .find((dir) => existsSync(join(dir, 'standard.patch.yml')));
const RECONCILE = [
  { configId: 'dsh-async', baselineName: 'standard.patch.yml' },
  { configId: 'dsh-async-create', baselineName: 'cordis.patch.yml' }
].map((entry) => ({
  ...entry,
  baselineFile: WEB_APP_PRESETS === undefined ? undefined : join(WEB_APP_PRESETS, entry.baselineName)
}));

/** 造一份变异副本并校验它（临时目录，用完即删）。 */
async function validateMutation(mutation, patchPath = PATCH, baselineText = baseline) {
  const dir = mkdtempSync(join(tmpdir(), 'async-preset-'));
  try {
    const path = join(dir, 'patch.yml');
    writeFileSync(path, mutation(baselineText), 'utf8');
    return await validatePatch(path, { quiet: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 从词典纪律文本里抽出公共异步纪律段（设计 §3.6：This deployment…failure. 整段，
 *  两变体逐字同源、分叉只许发生在委托规则第 1 条）。 */
function commonIntro(text) {
  const start = text.indexOf('This deployment runs commands ASYNCHRONOUSLY.');
  const endMarker = 'Never treat a returned job_id as a failure.';
  const end = text.indexOf(endMarker);
  assert.ok(start !== -1 && end !== -1, `公共段边界句必须在场（start=${String(start)} end=${String(end)}）`);
  return text.slice(start, end + endMarker.length);
}

/** 把「校验器 + 变异文案表」成对复制到临时目录再动态导入（保留相对布局
 *  tmp/tools/validate-preset.mjs + tmp/lib/text.js + tmp/tools/_host-resolve.mjs），
 *  返回该副本的 validatePatch——词典锚句判据（⑤b/⑦/⑪）的变异通道：锚句住在
 *  `lib/text.js`，不复制成对副本就变异不到校验器实际读取的文案表。 */
async function validatorWithText(mutateText) {
  const dir = mkdtempSync(join(tmpdir(), 'async-dict-'));
  try {
    mkdirSync(join(dir, 'tools'), { recursive: true });
    mkdirSync(join(dir, 'lib'), { recursive: true });
    const root = join(import.meta.dirname, '..');
    writeFileSync(join(dir, 'tools', 'validate-preset.mjs'),
      readFileSync(join(root, 'tools', 'validate-preset.mjs'), 'utf8'), 'utf8');
    writeFileSync(join(dir, 'tools', '_host-resolve.mjs'),
      readFileSync(join(root, 'tools', '_host-resolve.mjs'), 'utf8'), 'utf8');
    const mutated = mutateText(readFileSync(join(root, 'lib', 'text.js'), 'utf8'));
    writeFileSync(join(dir, 'lib', 'text.js'), mutated, 'utf8');
    return {
      dir,
      validate: (await import(pathToFileURL(join(dir, 'tools', 'validate-preset.mjs')).href)).validatePatch
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

hostTest('validate-preset：合法补丁必须通过（基线，防止断言恒真）', async () => {
  const result = await validatePatch(PATCH, { quiet: true });
  assert.equal(result.ok, true, `基线应当通过，失败行：\n${result.lines.filter((l) => l.includes('FAIL')).join('\n')}`);
});

hostTest('validate-preset：dsh-async-create 基线必须通过（P1，R26）', async () => {
  const result = await validatePatch(PATCH_CREATE, { quiet: true });
  assert.equal(result.ok, true, `创造补丁基线应当通过，失败行：\n${result.lines.filter((l) => l.includes('FAIL')).join('\n')}`);
  assert.ok(result.lines.some((l) => l.includes('顶层 27 行 + 嵌套 11 行')), '③ 的对账读数必须是 27+11（0.2.1 基线 + 五行顶层 async 工具行；delegation 组 6 行 + async-workflow）');
});

hostTest('validate-preset：tool-bash 被改成平台表达式必须拦住（需求 §3.3：Linux 也要无条件禁用）', async () => {
  const result = await validateMutation((text) => text
    .replace("id: tool-bash\n            name: '@deepseek-ai/dsh-tool-bash'\n            disabled: true",
      "id: tool-bash\n            name: '@deepseek-ai/dsh-tool-bash'\n            disabled: !!js process.platform === 'win32'"));
  assert.equal(result.ok, false, '平台表达式必须被拦（R20 静态侧）');
  assert.ok(result.lines.some((l) => l.includes('tool-bash.disabled') && l.includes('布尔 true')),
    `报错必须指向判据②，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
});

hostTest('validate-preset：tool-bash 行被整个删掉必须拦住', async () => {
  // 行形态：10 空格 `- id: tool-bash` + 后随 12 空格属性行（见补丁 :58-60）。
  const result = await validateMutation((text) => text.replace(
    / {10}- id: tool-bash\n(?: {12}.*\n)*/,
    ''));
  assert.equal(result.ok, false, '没有 tool-bash 行（改动对象缺席）必须被拦');
});

hostTest('validate-preset：toolName 写错（async_wait_agent 写成 async_run）必须拦住', async () => {
  const result = await validateMutation((text) => text
    .replace('toolName: async_wait_agent', 'toolName: async_run'));
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => l.includes('重复') || l.includes('缺')),
    `报错必须指向判据④的缺值/重复，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
});

hostTest('validate-preset：toolName 写成不存在的值必须拦住', async () => {
  const result = await validateMutation((text) => text
    .replace('toolName: async_agent', 'toolName: async_frobnicate'));
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => l.includes('toolName 六值缺')));
});

hostTest('validate-preset：tool-pwsh 挂回来必须拦住（R6）', async () => {
  const result = await validateMutation((text) => text
    .replace("name: '@deepseek-ai/dsh-tool-bash'",
      "name: '@deepseek-ai/dsh-tool-bash'\n          - id: tool-pwsh-sneak\n            name: '@deepseek-ai/dsh-tool-pwsh'"));
  assert.equal(result.ok, false, '挂回 tool-pwsh 必须被拦（前台同步 shell 到期杀进程树）');
  assert.ok(result.lines.some((l) => l.includes('tool-pwsh')));
});

hostTest('validate-preset：workflow-ptc 行被删必须拦住（定向修改 4 存在性）', async () => {
  // 删行 = workflow 引擎供电行（workflow-ptc）静默消失，预设丢编排引擎行为——
  // 否定式判据（"不含 worker-thread"）对此不红（两边都不含），必须靠存在性判据。
  const result = await validateMutation((text) => text.replace(
    / {14}- id: workflow-ptc\n(?: {16}.*\n)*/,
    ''));
  assert.equal(result.ok, false, '删 workflow-ptc 行必须被拦');
  assert.ok(result.lines.some((l) => l.includes('缺 workflow-ptc')),
    `报错必须点名改动项 4 的存在性，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
});

hostTest('validate-preset：挂回已从基线消失的 tool-ralph 行必须拦住（定向修改 5 的 0.2.1 形态）', async () => {
  // 0.2.1 基线的 delegation 组不再有 ralph / codex / claude-code 行——"翻活"变异
  // 失去对象，回归形态变成"挂回整行"：③ 的嵌套序列判据（多出基线期望之外的行）
  // 必须拦住复活的委托入口。
  const result = await validateMutation((text) => text
    .replace("              - id: async-workflow",
      "              - id: tool-ralph\n                name: '@deepseek-ai/dsh-tool-ralph'\n                config:\n                  subagentProvider: spawn\n                  maxRounds: 64\n              - id: async-workflow"));
  assert.equal(result.ok, false, '挂回 tool-ralph 行必须被拦');
  assert.ok(result.lines.some((l) => l.includes('tool-ralph') && l.includes('多出')),
    '报错必须指向③的嵌套多行判据');
});

hostTest('validate-preset：tool-plugin-manager 行被删必须拦住（③/⑧b 基线行存在性）', async () => {
  const result = await validateMutation((text) => text.replace(
    / {10}- id: tool-plugin-manager\n(?: {12}.*\n)*/,
    ''));
  assert.equal(result.ok, false, '删 tool-plugin-manager 行必须被拦');
  assert.ok(result.lines.some((l) => l.includes('tool-plugin-manager')),
    '报错必须点名基线行的存在性');
});

hostTest('validate-preset：persona prefix 增改必须拦住（⑤ 含反恒真对照）', async () => {
  // 身份句不承载本包内容（纪律走运行时 section，设计 §3.6）：prefix 与宿主基线
  // 身份句逐字一致，加一个词也必须红——判据是相等，不是包含。
  const result = await validateMutation((text) => text
    .replace('prefix: You are a coding agent powered by the {{model}} model.',
      'prefix: You are a coding agent powered by the {{model}} model. Be disciplined.'));
  assert.equal(result.ok, false, 'prefix 增改必须被拦');
  assert.ok(result.lines.some((l) => l.includes('基线身份句逐字一致')),
    `报错必须指向判据⑤的逐字一致，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
  // 反恒真：删掉整句同样红（空 prefix 不是基线句）。
  const emptied = await validateMutation((text) => text
    .replace('prefix: You are a coding agent powered by the {{model}} model.', 'prefix:'));
  assert.equal(emptied.ok, false, '清空 prefix 同样必须被拦');
});

hostTest('validate-preset：词典纪律锚句被删必须拦住（⑤b；含反恒真对照）', async () => {
  // 锚句住在 lib/text.js 的 discipline.preset.<id>（宿主半边运行时注入，设计
  // §3.6）——变异经成对副本通道（validatorWithText）。en 档杀「前台委托禁句」，
  // zh 档杀对应译文锚。
  const enKill = await validatorWithText((src) => src
    .replace('never pass run_in_background: false.', ''));
  const enResult = await enKill.validate(PATCH, { quiet: true });
  assert.equal(enResult.ok, false, 'en 档删锚句必须被拦');
  assert.ok(enResult.lines.some((l) => l.includes('never pass run_in_background: false') && l.includes('en 档')),
    `报错必须点名 en 档缺的那条锚句，实得：${enResult.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
  const zhKill = await validatorWithText((src) => src
    .replace('绝不要传 run_in_background: false。', ''));
  const zhResult = await zhKill.validate(PATCH, { quiet: true });
  assert.equal(zhResult.ok, false, 'zh 档删锚句必须被拦');
  assert.ok(zhResult.lines.some((l) => l.includes('run_in_background: false') && l.includes('zh 档')),
    '报错必须点名 zh 档缺的那条锚句');
});

hostTest('validate-preset：预设行重新带上 disabled 护栏必须拦住', async () => {
  // 护栏会在 agentPresets 服务就绪前把行静默杀死（loader refresh() 的 disabled 检查，
  // cordis-plugin-loader/lib/index.js:359-363），落成启动审计里的 "failed to import"。
  // 判据反转：护栏**存在**才是缺陷。
  const result = await validateMutation((text) => text
    .replace('    - id: preset-dsh-async\n', '    - id: preset-dsh-async\n      disabled: !!js "!ctx.get(\'agentPresets\')"\n'));
  assert.equal(result.ok, false, '护栏回归必须被拦');
  assert.ok(result.lines.some((l) => l.includes('不得带 disabled 护栏')));
});

hostTest('validate-preset：YAML 语法坏了必须报解析失败而不是崩', async () => {
  const result = await validateMutation((text) => `${text}\n  - : : broken\n    - ]]);
`);
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => l.includes('解析失败')));
});

hostTest('validate-preset：!!js 负表达式未加引号必须报解析失败', async () => {
  // `!!js !ctx.get(...)` 的首字符 `!` 会被 YAML 当成第二个标签
  // （duplication of a tag property）。上游成例整体加引号
  // （`dsh-base/cordis.patch.yml:22`）。校验器必须真的能解析宿主方言才能抓住它。
  // 补丁正文不含护栏行，这里直接注入坏形态来保留方言解析判据。
  const result = await validateMutation((text) => text
    .replace('    - id: preset-dsh-async\n', '    - id: preset-dsh-async\n      disabled: !!js !ctx.get(\'agentPresets\')\n'));
  assert.equal(result.ok, false, '未加引号的负表达式必须解析失败');
  assert.ok(result.lines.some((l) => l.includes('解析失败')));
});

// ══════════════════ dsh-async-create 补丁的判据（P2–P16）══════════════════════

hostTest('validate-preset：删基线行 tool-cordis 必须拦住（P2，③ 缺行）', async () => {
  const result = await validateMutation((text) => text.replace(
    "          - id: tool-cordis\n            name: '@deepseek-ai/dsh-tool-cordis'\n", ''),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '基线行静默缺失必须被拦（R26「不得静默缺失」）');
  assert.ok(result.lines.some((l) => l.includes('tool-cordis') && l.includes('缺行')),
    `报错必须点名缺的基线行，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
});

hostTest('validate-preset：多出基线期望之外的行必须拦住（P3，③ 多行）', async () => {
  const result = await validateMutation((text) => text
    .replace("          - id: tool-cordis\n",
      "          - id: tool-web-extra\n            name: '@deepseek-ai/dsh-tool-web'\n          - id: tool-cordis\n"),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '未经设计裁定的加行必须被拦');
  assert.ok(result.lines.some((l) => l.includes('tool-web-extra') && l.includes('多出')),
    '报错必须点名多出的行');
});

hostTest('validate-preset：tool-subagent 翻回启用必须拦住（P4，⑧ 结构性差异裁定）', async () => {
  const result = await validateMutation((text) => text
    .replace("              - id: tool-subagent\n                name: '@deepseek-ai/dsh-tool-subagent'\n                disabled: true\n",
      "              - id: tool-subagent\n                name: '@deepseek-ai/dsh-tool-subagent'\n"),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '派生入口翻活必须被拦（async_agent 是唯一入口）');
  assert.ok(result.lines.some((l) => l.includes('tool-subagent.disabled')),
    '报错必须指向 ⑧ 的 disabled 项');
});

hostTest('validate-preset：tool-plugin-manager 回归布尔禁用必须拦住（P5，⑧b 基线同形）', async () => {
  const block = (disabled) => `          - id: tool-plugin-manager\n            name: '@deepseek-ai/dsh-plugin-manager/tools'\n            disabled: ${disabled}\n`;
  const expr = '!!js "!ctx.get(\'profileContext\')"';
  // 反例方向一（create）：基线条件表达式被换回布尔 true——创造上下文中插件
  // 管理入口整个锁死（需求 §7.3.2：保留基线启用条件）。
  const toBoolean = await validateMutation((text) => text
    .replace(block(expr), block('true')),
    PATCH_CREATE, baselineCreate);
  assert.equal(toBoolean.ok, false, '回归布尔禁用必须被拦');
  assert.ok(toBoolean.lines.some((l) => l.includes('tool-plugin-manager.disabled') && l.includes('基线禁用形态逐字同形')),
    `报错必须指向 ⑧b 的基线同形判据，实得：${toBoolean.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
  // 反例方向二（create）：表达式本身被改——判据逐字，不是「是表达式即可」。
  const exprDrift = await validateMutation((text) => text
    .replace(block(expr), block('!!js "!ctx.get(\'pluginContext\')"')),
    PATCH_CREATE, baselineCreate);
  assert.equal(exprDrift.ok, false, '表达式漂移必须被拦（逐字判据）');
  assert.ok(exprDrift.lines.some((l) => l.includes('tool-plugin-manager.disabled') && l.includes('基线禁用形态逐字同形')));
  // 反例方向三（dsh-async 侧）：布尔禁用被换成条件表达式——standard 基线两行布尔。
  const toExpr = await validateMutation((text) => text
    .replace(block('true'), block(expr)));
  assert.equal(toExpr.ok, false, 'dsh-async 的插件管理行必须保持 standard 基线布尔禁用');
  assert.ok(toExpr.lines.some((l) => l.includes('tool-plugin-manager.disabled') && l.includes('基线禁用形态逐字同形')));
});

hostTest('validate-preset：词典唯一入口锚句被删必须拦住（P6，⑤b，create 变体）', async () => {
  // create 变体的锚句集第五句才是差异句「已禁用、不要调用」；本用例
  // 杀掉 create 键 en 档的入口锚，⑤b 必须按句点名。
  const kill = await validatorWithText((src) => src
    .replace('async_agent is the ONLY delegation entry in this preset — it has no foreground mode.',
      'async_agent delegates in this preset — it has no foreground mode.'));
  const result = await kill.validate(PATCH_CREATE, { quiet: true });
  assert.equal(result.ok, false, '删锚句必须被拦');
  assert.ok(result.lines.some((l) => l.includes('ONLY delegation entry')),
    `报错必须点名缺的那条锚句，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
});

hostTest('validate-preset：tool-pwsh 挂回创造补丁必须拦住（P7，③b）', async () => {
  const result = await validateMutation((text) => text
    .replace("name: '@deepseek-ai/dsh-tool-bash'",
      "name: '@deepseek-ai/dsh-tool-bash'\n          - id: tool-pwsh-sneak\n            name: '@deepseek-ai/dsh-tool-pwsh'"),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '挂回 tool-pwsh 必须被拦（前台同步 shell 到期杀进程树）');
  assert.ok(result.lines.some((l) => l.includes('tool-pwsh')));
});

hostTest('validate-preset：tool-bash 改平台表达式必须拦住（P8，②）', async () => {
  const result = await validateMutation((text) => text
    .replace("          - id: tool-bash\n            name: '@deepseek-ai/dsh-tool-bash'\n            disabled: true",
      "          - id: tool-bash\n            name: '@deepseek-ai/dsh-tool-bash'\n            disabled: !!js process.platform === 'win32'"),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '平台表达式必须被拦（R20 静态侧：Linux 也要无条件禁用）');
  assert.ok(result.lines.some((l) => l.includes('tool-bash.disabled') && l.includes('布尔 true')));
});

hostTest('validate-preset：config.id 改成无期望集的值必须拦住（P9，①）', async () => {
  const result = await validateMutation((text) => text
    .replace('id: dsh-async-create', 'id: dsh-async-frobnicate'),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '未知 config.id 不许"套不上就放行"');
  assert.ok(result.lines.some((l) => l.includes('没有对应期望集')),
    '报错必须点名期望集缺失');
});

hostTest('validate-preset：创造补丁预设行加护栏必须拦住（P10，⑥）', async () => {
  const result = await validateMutation((text) => text
    .replace('    - id: preset-dsh-async-create\n', '    - id: preset-dsh-async-create\n      disabled: !!js "!ctx.get(\'agentPresets\')"\n'),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '护栏回归必须被拦');
  assert.ok(result.lines.some((l) => l.includes('不得带 disabled 护栏')));
});

hostTest('validate-preset：活 subagent × async_agent 且词典缺锚句必须触发互斥判据（P11，⑦）', async () => {
  // 复合变异：补丁侧 subagent 翻活（⑧ 红）+ 词典侧删锚——⑦ 读 en 档词典文本，
  // 两个分支各验一次，证明可验证段④的条件式守卫真的会开火（不是只有 ⑤⑧ 在兜）。
  // 补丁变异先落临时文件（⑦ 只对翻活后的补丁开火），词典变异走成对副本通道。
  const patchDir = mkdtempSync(join(tmpdir(), 'async-preset-11-'));
  try {
    const enableSubagent = (text) => text
      .replace("              - id: tool-subagent\n                name: '@deepseek-ai/dsh-tool-subagent'\n                disabled: true\n",
        "              - id: tool-subagent\n                name: '@deepseek-ai/dsh-tool-subagent'\n");
    const mutatedPatchPath = join(patchDir, 'patch.yml');
    writeFileSync(mutatedPatchPath, enableSubagent(baselineCreate), 'utf8');
    const entryKill = await validatorWithText((src) => src
      .replace('async_agent is the ONLY delegation entry in this preset — it has no foreground mode.',
        'async_agent delegates in this preset — it has no foreground mode.'));
    const entryRemoved = await entryKill.validate(mutatedPatchPath, { quiet: true });
    assert.equal(entryRemoved.ok, false);
    assert.ok(entryRemoved.lines.some((l) => l.includes('唯一派生入口') && l.includes('需求 §3.1 可验证口径')),
      `⑦ 的入口专报必须在场，实得：${entryRemoved.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
    const retrievalKill = await validatorWithText((src) => src
      .split('wait with async_wait_agent (bounded').join('get results via async_wait_agent (bounded'));
    const retrievalRemoved = await retrievalKill.validate(mutatedPatchPath, { quiet: true });
    assert.equal(retrievalRemoved.ok, false);
    assert.ok(retrievalRemoved.lines.some((l) => l.includes('取回通道') && l.includes('需求 §3.1 可验证口径')),
      `⑦ 的取回专报必须在场，实得：${retrievalRemoved.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
  } finally {
    rmSync(patchDir, { recursive: true, force: true });
  }
});

hostTest('validate-preset：删嵌套行 plan-mode 必须拦住（P12，③ 嵌套缺行）', async () => {
  // 段内含空行，正则按行匹配会在空行截断——用锚定切割：从 plan-mode 行首删到
  // 下一个顶层行（compaction）之前。
  const result = await validateMutation((text) => {
    const start = text.indexOf('              - id: plan-mode');
    const end = text.indexOf('          - id: compaction', start);
    return text.slice(0, start) + text.slice(end);
  }, PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '组内行静默缺失必须被拦');
  assert.ok(result.lines.some((l) => l.includes('plan-mode') && l.includes('嵌套行')),
    '报错必须点名嵌套行判据');
});

hostTest('validate-preset：创造补丁 toolName 写错必须拦住（P13，④）', async () => {
  const result = await validateMutation((text) => text
    .replace('toolName: async_agent', 'toolName: async_frobnicate'),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => l.includes('toolName 六值缺')));
});

hostTest('validate-preset：期望集必须与 shipped 基线的真实行集合逐条比对（P14，防快照漂移）', async () => {
  const { load } = await loadYaml();
  for (const { configId, baselineFile, baselineName } of RECONCILE) {
    if (baselineFile === undefined || !existsSync(baselineFile)) {
      assert.fail(`P14 对账依赖的基线补丁读不到：@deepseek-ai/dsh-web-app/presets/${baselineName}（期望集 ${configId} 的出处就是它）。候选锚 = DSAT_HOST_MODULES → DSH_HOME/profiles → %APPDATA%/npm 全局树；CI 上由 npm install @deepseek-ai/dsh@0.2.1-rc.3 提供。锚缺失不许静默跳过。`);
    }
    const doc = load(readFileSync(baselineFile, 'utf8'));
    const exp = EXPECTATIONS[configId];
    assert.deepEqual(exp.baselineTop, expectedTopFromBaseline(doc),
      `${configId} 的 baselineTop 必须等于「真实基线 − tool-pwsh + 五行 async（插在 tool-bash 后）」；上游改动基线时这里先红，强迫重建期望集（更新入口）`);
    const nestedFromBaseline = doc[0].insert[0].config.plugins
      .filter((child) => Array.isArray(child?.config))
      .flatMap((child) => child.config)
      .map((child) => child?.id);
    // 期望嵌套序列 = 真实基线 + async-workflow 插在 tool-workflow 行后
    // （delegation 组内第五行，设计 §3.6 行位）。基线侧不插、补丁侧不拔都先红。
    const wfIdx = nestedFromBaseline.indexOf('tool-workflow');
    const expectedNested = [...nestedFromBaseline.slice(0, wfIdx + 1), 'async-workflow', ...nestedFromBaseline.slice(wfIdx + 1)];
    assert.deepEqual(exp.baselineNested, expectedNested,
      `${configId} 的 baselineNested 必须等于「真实基线嵌套行 + async-workflow（tool-workflow 行后）」；上游改动基线时这里先红，强迫重建期望集（更新入口）`);
    // **config 正文**逐行对账——改动集之外的每个叶子行与组行必须与真实基线
    // 深度一致（递归键序规范化后比对；disabled 单列在改动范围外剔除）。改动清单外改一个字
    // 必须红：只有行 id 比对的判据拦不住 plan-mode 段的措辞漂移。
    // 改动范围 = 结构性禁用行。persona **不在改动集**——prefix 与基线身份句
    // 逐字一致（⑤ 锁死），行体比对连 persona 的 config 一并锁成与基线逐字。
    // 插件管理两行不在改动集——与基线禁用形态逐字同形（⑧b），行体比对连
    // disabled 面一并锁它们。
    const surgery = new Set(exp.disabledBoolean);
    const patchDoc = load(readFileSync(join(import.meta.dirname, '..', exp.patchRel), 'utf8'));
    const collect = (insertRow) => {
      const leaf = new Map(), group = new Map();
      const walk = (arr) => arr.forEach((child) => {
        if (Array.isArray(child?.config)) { group.set(child.id, child); walk(child.config); }
        else leaf.set(child.id, child);
      });
      walk(insertRow.config.plugins);
      return { leaf, group };
    };
    const fromBaseline = collect(doc[0].insert[0]);
    const fromPatch = collect(patchDoc[0].insert[0]);
    const normalize = (value) => {
      if (Array.isArray(value)) return value.map(normalize);
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
      }
      return value;
    };
    const stripSurgery = (row, isGroup) => JSON.stringify(normalize(
      // 组行的 config 是子行数组（子行已单独比对）→ 剥掉只比 id/name/group/isolate；
      // 叶子行的 config 是正文（sampleOverCapGlobResults、plan-mode 的 section 等）
      // → **必须保留**；叶子行的 disabled **不剥**（改动集外的行连 disabled
      // 面也必须与基线一致——基线 codex/claude-code 的 disabled: true 两侧本就逐字）。
      isGroup ? { ...row, config: undefined } : { ...row }
    ));
    const bodyDiffs = [];
    for (const [id, row] of fromBaseline.leaf) {
      if (surgery.has(id) || id === 'tool-pwsh') continue; // pwsh 行按改动不挂；async 行只在补丁侧
      const other = fromPatch.leaf.get(id);
      if (other === undefined) { bodyDiffs.push(`${id} 仅在基线`); continue; }
      if (stripSurgery(row, false) !== stripSurgery(other, false)) bodyDiffs.push(`${id} 的 config 正文与基线不一致`);
    }
    for (const id of fromPatch.leaf.keys()) {
      if (!fromBaseline.leaf.has(id) && !id.startsWith('async-')) bodyDiffs.push(`${id} 仅在补丁`);
    }
    for (const [id, row] of fromBaseline.group) {
      const other = fromPatch.group.get(id);
      if (other === undefined) { bodyDiffs.push(`${id} 组行缺失`); continue; }
      if (stripSurgery(row, true) !== stripSurgery(other, true)) bodyDiffs.push(`${id} 组行属性与基线不一致`);
    }
    assert.deepEqual(bodyDiffs, [],
      `${configId} 改动清单之外的行必须与真实基线逐字一致；差异：${bodyDiffs.join(' | ')}`);
    // 反向对照：改动外叶子行的 config 改一个字，同一比较器必须报出来（防恒真）。
    const driftBase = JSON.parse(stripSurgery(fromPatch.leaf.get('tool-fs-search'), false));
    driftBase.config.sampleOverCapGlobResults = true;
    assert.notEqual(JSON.stringify(driftBase), stripSurgery(fromBaseline.leaf.get('tool-fs-search'), false),
      'config 正文比较器必须能检出单字段漂移');
    //  反向对照：改动外叶子行**误加 disabled** 也必须被同一比较器报出来
    // ——disabled 项不许是盲区。（dsh-async 的 tool-subagent 本就按改动禁用，
    // 该行走 ⑧⑩ 的结构性判据；本对照只证比较器对 disabled 差异敏感。）
    const wrongDisable = JSON.parse(stripSurgery(fromPatch.leaf.get('tool-subagent'), false));
    wrongDisable.disabled = true;
    assert.notEqual(JSON.stringify(wrongDisable), stripSurgery(fromBaseline.leaf.get('tool-subagent'), false),
      'disabled 项比较器必须能检出补丁行与基线行的 disabled 差异');
  }
});

hostTest('validate-preset：组内行重复必须拦住', async () => {
  // 重复行不产生缺行/多行（两个 id 都在期望集里）——靠长度比对与行序比对抓住。
  const result = await validateMutation((text) => text
    .replace("              - id: compaction-basic\n                name: '@deepseek-ai/dsh-compaction-basic'\n",
      "              - id: compaction-basic\n                name: '@deepseek-ai/dsh-compaction-basic'\n              - id: compaction-basic\n                name: '@deepseek-ai/dsh-compaction-basic'\n"),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '组内重复行必须被拦（重复的行都在期望集里，缺/多行判据抓不住）');
  assert.ok(result.lines.some((l) => l.includes('嵌套行数应为')),
    '报错必须指向嵌套行数判据');
});

hostTest('validate-preset：组内行换序必须拦住', async () => {
  const result = await validateMutation((text) => text
    .replace("              - id: tool-subagent-control\n                name: '@deepseek-ai/dsh-tool-subagent-control'\n              - id: tool-subagent-list-agents\n",
      "              - id: tool-subagent-list-agents\n                name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'\n              - id: tool-subagent-control\n"),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '组内行换序必须被拦（基线行序是「逐项按序」承诺的一半）');
  assert.ok(result.lines.some((l) => l.includes('嵌套行序与基线期望不一致')),
    '报错必须指向嵌套行序判据');
});

hostTest('validate-preset：workflow-ptc 的 provider 改掉必须拦住（P15，⑨；两份补丁都守）', async () => {
  const block = (indent) => `${indent}- id: workflow-ptc\n${' '.repeat(indent.length + 2)}name: '@deepseek-ai/dsh-workflow-ptc'\n${' '.repeat(indent.length + 2)}config:\n${' '.repeat(indent.length + 4)}provider: spawn\n`;
  for (const [path, text, indent] of [
    [PATCH_CREATE, baselineCreate, ' '.repeat(14)],
    [PATCH, baseline, ' '.repeat(14)]
  ]) {
    const result = await validateMutation((t) => t
      .replace(block(indent), block(indent).replace('provider: spawn', 'provider: fork')),
      path, text);
    assert.equal(result.ok, false, 'provider 形态守卫不随参数化丢失');
    assert.ok(result.lines.some((l) => l.includes('workflow-ptc.config.provider')),
      '报错必须指向 ⑨ 的 provider 面');
  }
});

hostTest('validate-preset：两份补丁的词典公共纪律段必须逐字同源（P16，设计 §3.6）', async () => {
  // persona prefix 与宿主基线身份句逐字一致（宿主原生身份句不承载本包内容），
  // 公共异步纪律段住在两语表的两个词典键里，分叉只许发生在委托规则第 1 条。
  const { load } = await loadYaml();
  const readPrefix = async (path) => {
    const doc = load(readFileSync(path, 'utf8'));
    return doc[0].insert[0].config.plugins.find((child) => child?.id === 'persona').config.prefix;
  };
  const BASELINE_IDENTITY = 'You are a coding agent powered by the {{model}} model.';
  assert.equal(await readPrefix(PATCH), BASELINE_IDENTITY, 'dsh-async 的 prefix 与基线身份句逐字一致');
  assert.equal(await readPrefix(PATCH_CREATE), BASELINE_IDENTITY, 'dsh-async-create 的 prefix 与基线身份句逐字一致');
  const introAsync = commonIntro(t('en', 'discipline.preset.dsh-async'));
  const introCreate = commonIntro(t('en', 'discipline.preset.dsh-async-create'));
  assert.equal(introAsync, introCreate,
    '公共段（This deployment…failure. 整段）必须逐字相同——分叉只许发生在 DELEGATION RULES 段');
  // 反向对照：改掉一份的公共段，比较器必须真的能发现（否则上面的相等断言是恒真的）。
  const mutatedIntro = introCreate.replace('ASYNCHRONOUSLY', 'ASYNCHRONOUSLY.');
  assert.notEqual(mutatedIntro, introAsync, '比较器必须能检出公共段漂移');
  // zh 档同守：两变体的公共段（本部署异步执行命令……当作失败。）逐字同源。
  const zhIntro = (text) => {
    const start = text.indexOf('本部署异步执行命令。');
    const endMarker = '绝不能把返回的 job_id 当作失败。';
    const end = text.indexOf(endMarker);
    assert.ok(start !== -1 && end !== -1, 'zh 公共段边界句必须在场');
    return text.slice(start, end + endMarker.length);
  };
  assert.equal(zhIntro(t('zh', 'discipline.preset.dsh-async')), zhIntro(t('zh', 'discipline.preset.dsh-async-create')),
    'zh 档公共段必须逐字相同（语言档语义同源，需求 §5.3）');
});

// ══════════════════ 第五行工具与禁用改动的判据（P17–P21）════════════════════════

hostTest('validate-preset：tool-workflow 翻回启用必须拦住（P17，⑧，R35-b；两份都守）', async () => {
  const block = (indent) => `${indent}- id: tool-workflow\n${' '.repeat(indent.length + 2)}name: '@deepseek-ai/dsh-tool-workflow'\n${' '.repeat(indent.length + 2)}disabled: true\n`;
  const revived = (indent) => `${indent}- id: tool-workflow\n${' '.repeat(indent.length + 2)}name: '@deepseek-ai/dsh-tool-workflow'\n`;
  for (const [path, text, indent] of [
    [PATCH, baseline, ' '.repeat(14)],
    [PATCH_CREATE, baselineCreate, ' '.repeat(14)]
  ]) {
    const result = await validateMutation((t) => t.replace(block(indent), revived(indent)), path, text);
    assert.equal(result.ok, false, `tool-workflow 翻活必须被拦（编排只走 async_workflow，${path}）`);
    assert.ok(result.lines.some((l) => l.includes('tool-workflow.disabled')),
      `报错必须指向 ⑧ 的 disabled 项，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
  }
});

hostTest('validate-preset：dsh-async 的 tool-subagent 翻回启用必须拦住（P18，⑧，R35-c）', async () => {
  const result = await validateMutation((text) => text
    .replace("              - id: tool-subagent\n                name: '@deepseek-ai/dsh-tool-subagent'\n                disabled: true\n",
      "              - id: tool-subagent\n                name: '@deepseek-ai/dsh-tool-subagent'\n"));
  assert.equal(result.ok, false, 'dsh-async 的宿主单发委托入口翻活必须被拦（R35-c）');
  assert.ok(result.lines.some((l) => l.includes('tool-subagent.disabled')),
    '报错必须指向 ⑧ 的 disabled 项');
});

hostTest('validate-preset：删 async-workflow 行必须拦住（P19，③/④，R35-a；两份都守）', async () => {
  for (const [path, text] of [[PATCH, baseline], [PATCH_CREATE, baselineCreate]]) {
    const result = await validateMutation((t) => t
      .replace(/ {14}- id: async-workflow\n(?: {16}.*\n)*/, ''), path, text);
    assert.equal(result.ok, false, `删 delegation 组内行必须被拦（${path}）`);
    assert.ok(result.lines.some((l) => (l.includes('async-workflow') && l.includes('缺行')) || l.includes('toolName 六值缺')),
      `报错必须点名 ③ 嵌套缺行或 ④ 缺值，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
  }
});

hostTest('validate-preset：async-workflow 挪出 delegation 组必须拦住（P20，④ 行位，设计 §3.6）', async () => {
  // 变异 = 组内删行 + 顶层 async-agent 行后插同款行（挪到组外顶层——正是行位判据要拦的形态）。
  const removed = (t) => t.replace(/ {14}- id: async-workflow\n(?: {16}.*\n)*/, '');
  const movedOut = (t) => removed(t).replace(
    "          - id: async-agent\n            name: dsh-async-tools\n            config:\n              toolName: async_agent\n",
    "          - id: async-agent\n            name: dsh-async-tools\n            config:\n              toolName: async_agent\n          - id: async-workflow\n            name: dsh-async-tools\n            config:\n              toolName: async_workflow\n");
  const result = await validateMutation(movedOut);
  assert.equal(result.ok, false, '挪出组外必须被拦（workflowEngine 是组内隔离服务，组外行 ctx.get 恒 miss——设计 §3.6 行位）');
  assert.ok(result.lines.some((l) => l.includes('必须落进组内') || l.includes('必须紧跟 tool-workflow')),
    `报错必须点名行位判据（设计 §3.6），实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
});

hostTest('validate-preset：workflow-ptc 行删掉必须拦住（P21，⑨，R34 供电；create 侧）', async () => {
  const result = await validateMutation((text) => text.replace(
    / {14}- id: workflow-ptc\n(?: {16}.*\n)*/, ''),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '删 workflow-ptc 行必须被拦（async_workflow 的引擎供电行）');
  assert.ok(result.lines.some((l) => l.includes('缺 workflow-ptc')),
    '报错必须点名 ⑨ 的存在性');
});

hostTest('validate-preset：async_workflow 门槛锚句被删必须拦住（P22，⑪，R34-h）', async () => {
  // ⑪ 读的是真 text.js，变异用例要把「校验器 + 文案表」成对复制到临时目录再动态导入
  // （保留相对布局 tmp/tools/validate-preset.mjs + tmp/lib/text.js），证 ⑪ 的检查
  // 对缺锚句的文案表真的开火——不是恒真。
  const dir = mkdtempSync(join(tmpdir(), 'async-threshold-'));
  try {
    mkdirSync(join(dir, 'tools'), { recursive: true });
    mkdirSync(join(dir, 'lib'), { recursive: true });
    const validatorSrc = readFileSync(join(import.meta.dirname, '..', 'tools', 'validate-preset.mjs'), 'utf8');
    const textSrc = readFileSync(join(import.meta.dirname, '..', 'lib', 'text.js'), 'utf8');
    // 删句变异：两档 p2 里指向 async_agent 的出路句整体移除。
    const mutated = textSrc
      .replace('for one or two delegations prefer async_agent.', '')
      .replace('一两个委托用 async_agent。', '');
    assert.notEqual(mutated, textSrc, '变异必须真的改到文案（否则本用例恒真）');
    writeFileSync(join(dir, 'tools', 'validate-preset.mjs'), validatorSrc, 'utf8');
    writeFileSync(join(dir, 'lib', 'text.js'), mutated, 'utf8');
    // 校验器现在的锚候选表来自 tools/_host-resolve.mjs（树根单一来源），副本必须成对带上，
    // 否则动态导入在临时目录里找不到它——那红的是搬运缺件，不是 ⑪ 判据。
    writeFileSync(
      join(dir, 'tools', '_host-resolve.mjs'),
      readFileSync(join(import.meta.dirname, '..', 'tools', '_host-resolve.mjs'), 'utf8'),
      'utf8'
    );
    const mod = await import(pathToFileURL(join(dir, 'tools', 'validate-preset.mjs')).href);
    const result = await mod.validatePatch(PATCH, { quiet: true });
    assert.equal(result.ok, false, '门槛锚句缺失必须被拦（R34-h/R35-g）');
    assert.ok(result.lines.some((l) => l.includes('门槛锚句')),
      `报错必须指向 ⑪ 的门槛判据，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════ 提问角色纪律锚句的判据（P23，ASK-01）═══════════════════════

hostTest('validate-preset：提问角色纪律锚词缺任一组必须拦住（P23，⑤b；en/zh 两档×两份补丁同守）', async () => {
  // ASK-01 四组锚词住在两语表的两个词典键里（en＋zh 两档，语言档由 agentLang
  // 管理，需求 §5.3）。各杀一句 en 锚与一句 zh 锚——⑤b 按档独立开火，两份
  // 补丁的该段逐字同文，共用同一张变异表（变异走成对副本通道）。
  const KILLS_EN = [
    ['no personal pronouns for the actor, authorizer, or owner', 'clear role names for the actor, authorizer, owner'],
    ['explicit, distinguishable role names', 'distinguishable role names'],
    ['role plus the action', 'role and action'],
    ['keep role references consistent', 'keep roles consistent']
  ];
  const KILLS_ZH = [
    ['不使用指代执行者、授权者或归属对象的人称代词', '不用人称代词指代执行者、授权者或归属对象'],
    ['明确、可区分的角色名称', '明确的角色名称'],
    ['写清角色与动作', '写明角色和动作'],
    ['与所选角色名称保持一致', '与所选角色一致']
  ];
  for (const [anchor, replacement] of [...KILLS_EN, ...KILLS_ZH]) {
    for (const path of [PATCH, PATCH_CREATE]) {
      const killed = await validatorWithText((src) => src.split(anchor).join(replacement));
      const result = await killed.validate(path, { quiet: true });
      assert.equal(result.ok, false, `删锚词必须被拦（${anchor}；${path}）`);
      assert.ok(result.lines.some((l) => l.includes(anchor)),
        `报错必须点名缺失的锚词，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
    }
  }
});

// ══════════════════ 锚句表逐句齐套（P24/P25，⑤b；删任一句必红）═══════════════════════

hostTest('validate-preset：dsh-async 有界等待取回锚句被删必须拦住（P24，⑤b，en/zh 两档）', async () => {
  // 「需要结果时有界等待取回」是委托纪律五句之一：从 dsh-async 文案删掉
  // 该句（保留同条的「不要循环轮询」半句）而锚句表仍在，⑤b 必须按档点名。
  const killed = await validatorWithText((src) => src
    .replace('wait with async_wait_agent (bounded wait_ms)',
      'call async_wait_agent (bounded wait_ms)')
    .replace('用 async_wait_agent 有界等待', '以 async_wait_agent 有界等待'));
  const result = await killed.validate(PATCH, { quiet: true });
  assert.equal(result.ok, false, '删有界等待取回句必须被拦');
  assert.ok(result.lines.some((l) => l.includes('wait with async_wait_agent') && l.includes('en 档')),
    `报错必须点名 en 档缺失锚句，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
  assert.ok(result.lines.some((l) => l.includes('用 async_wait_agent 有界等待') && l.includes('zh 档')),
    '报错必须点名 zh 档缺失锚句');
});

hostTest('validate-preset：create 变体差异句被删必须拦住（P25，⑤b，en/zh 两档）', async () => {
  // 「宿主 subagent／subagent_fork 已禁用、不要调用」是 create 变体的差异句：
  // 删掉它而锚句表仍在，⑤b 必须按档点名（该句是两变体分工的关键差异）。
  const killed = await validatorWithText((src) => src
    .replace('subagent / subagent_fork are disabled here; do not call them.',
      'subagent / subagent_fork are not used here.')
    .replace('subagent / subagent_fork 在本预设已禁用，不要调用。',
      'subagent / subagent_fork 在本预设不使用。'));
  const result = await killed.validate(PATCH_CREATE, { quiet: true });
  assert.equal(result.ok, false, '删变体差异句必须被拦');
  assert.ok(result.lines.some((l) => l.includes('disabled here; do not call them') && l.includes('en 档')),
    `报错必须点名 en 档缺失锚句，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
  assert.ok(result.lines.some((l) => l.includes('已禁用，不要调用') && l.includes('zh 档')),
    '报错必须点名 zh 档缺失锚句');
});

hostTest('validate-preset：锚句表逐锚删除变异——表内任一锚被删必红（P26，⑤b，两变体×两档全表）', async () => {
  // 守卫网的守卫网：锚句表本身也可能被静默弱化——删掉某条锚后，对应文案
  // 逃出看守而既有测试全绿。对两张期望表的每个语言档、每条锚做参数化删除
  // 变异，⑤b 必须按档点名；这让「表内每条锚都有删除变异」成为机器核实的
  // 事实，而不是头注的声明。表收缩方向的看守见下一条快照锁（P26 的击杀
  // 清单派生自锚句表本身，表缩小时循环同步缩小——两方向各需一条用例）。
  for (const [configId, expectation] of Object.entries(EXPECTATIONS)) {
    const patchPath = configId === 'dsh-async' ? PATCH : PATCH_CREATE;
    for (const lang of ['en', 'zh']) {
      for (const anchor of expectation.disciplineAnchors[lang]) {
        const killed = await validatorWithText((src) => src.split(anchor).join(''));
        const result = await killed.validate(patchPath, { quiet: true });
        assert.equal(result.ok, false, `删锚句必须被拦（${configId} ${lang} 档：${anchor}）`);
        assert.ok(result.lines.some((l) => l.includes(anchor) && l.includes(`${lang} 档`)),
          `报错必须点名缺失锚句（${configId} ${lang} 档），实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
      }
    }
  }
});

hostTest('validate-preset：锚句表快照锁——表删行、改锚或加锚必红（P27，⑤b，两变体×两档）', () => {
  // P26 的击杀清单派生自锚句表本身，测不出表自身被静默弱化（删行后循环
  // 同步缩小、基线照常绿）。这里用测试内独立持份的期望清单逐项 deepEqual
  // 锚句表：删行、改锚、加锚都必须先改这份锁才过得去——两处同改在 diff
  // 评审里可见，静默弱化不再有零红通道。
  const LOCKED = {
    'dsh-async': {
      en: [
        'ALWAYS',
        'async_agent is the ONLY delegation entry',
        'wait with async_wait_agent',
        'never pass run_in_background: false',
        'Do not poll in a loop',
        'no personal pronouns for the actor, authorizer, or owner',
        'explicit, distinguishable role names',
        'role plus the action',
        'keep role references consistent'
      ],
      zh: [
        '一律在后台',
        '唯一的委托入口',
        '用 async_wait_agent 有界等待',
        '绝不要传 run_in_background: false',
        '不要循环轮询',
        '不使用指代执行者、授权者或归属对象的人称代词',
        '明确、可区分的角色名称',
        '写清角色与动作',
        '与所选角色名称保持一致'
      ]
    },
    'dsh-async-create': {
      en: [
        'ALWAYS',
        'async_agent is the ONLY delegation entry',
        'wait with async_wait_agent',
        'disabled here; do not call them',
        'Do not poll in a loop',
        'no personal pronouns for the actor, authorizer, or owner',
        'explicit, distinguishable role names',
        'role plus the action',
        'keep role references consistent'
      ],
      zh: [
        '一律在后台',
        '唯一的委托入口',
        '用 async_wait_agent 有界等待',
        '已禁用，不要调用',
        '不要循环轮询',
        '不使用指代执行者、授权者或归属对象的人称代词',
        '明确、可区分的角色名称',
        '写清角色与动作',
        '与所选角色名称保持一致'
      ]
    }
  };
  for (const [configId, expected] of Object.entries(LOCKED)) {
    for (const lang of ['en', 'zh']) {
      assert.deepEqual(EXPECTATIONS[configId].disciplineAnchors[lang], expected[lang],
        `锚句表与独立期望清单不一致（${configId} ${lang} 档）——表被弱化或锁未同步，两处需同改并过评审`);
    }
  }
});
