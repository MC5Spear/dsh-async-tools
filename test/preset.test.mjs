/**
 * 预设补丁校验器的变异测试（对象 `tools/validate-preset.mjs`，判据清单以
 * `tools/validate-preset.mjs` 文件头为准（现行十八条，③b、⑤b、⑤c、⑧b 各独立
 * 计一条；⑫⑬⑭ 为 0.2.2 双档线新增——D1–D5 与分档说明见该文件头）；变异验收
 * 参数化覆盖两份补丁×两档）。
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
 * 相对布局，含校验器新 import 的 lib/host-contract.js），对 `lib/text.js` 副本
 * 做变异。
 *
 * 双档可测（期望集按宿主锚版本分档，边界 0.2.2-rc.2，rc.2 与 rc.3 基线逐字节
 * 相同、同档）：判据校验经 `tier` 注入在两档各跑（P31–P36）——不依赖同机同时
 * 存在两棵宿主树；基线对账（P14）按当前锚树档跑真实基线全量，另一档用**构造
 * 的基线快照**（对真实基线解析结果施加两档间已登记的全部漂移）跑同一套对账
 * 函数——两档判据都被执行、变异必红，避免"只在单档验证过"的死角。
 *
 * dsh-async-create 专属用例：P1 基线绿、P2/P3 基线行缺/多、P4 派生入口翻活、
 * P5 plugin-manager 回归布尔禁用（⑧b）、P6 词典纪律锚句（⑤b）、P7 pwsh 挂回、
 * P8 tool-bash 表达式、P9 未知 config.id、P10 护栏、P11 互斥判据复合、
 * P12 嵌套行缺失、P13 toolName、P14 双档基线对账（真实锚档＋构造快照档；含
 * 档位错标必红）、P15 provider 形态、P16 词典公共纪律段同源。
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
 * 通用纪律变体（VERIFY-GENERIC-01，判据 ⑤c）用例：P28 通用锚句表逐锚删除
 * 变异、P29 通用锚句表快照锁、P30 整段置空变异（en/zh 各一次 × 两份补丁——
 * 固化验收受控反例「置空仍通过」修后必不成立）。
 * 双档分档判据用例（0.2.2 双档线）：P31 锚版本分档边界与读不到版本必红、
 * P32 两档合法补丁全过（⓪ 报档、③ 双档读数）、P33 D1 表达式改一字符（⑫，
 * 两档×两补丁）、P34 D2 persona 第二句增删（⑤，两档）、P35 D3 control 行加
 * interrupt:false（⑬，两档×两补丁）、P36 D4 office 行删/挪/表达式漂移/加
 * config（⑭+③，两档）、P37 登记分歧表快照锁（D1–D4 对账豁免两侧同改才动）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePatch, EXPECTATIONS, GENERIC_DISCIPLINE_ANCHORS, loadYaml, reconcileBaseline, DESIGNED_DELTAS, tierForVersion, readAnchorHostVersion, resolveAnchorTier } from '../tools/validate-preset.mjs';
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

// 宿主锚档（模块级一次解析；离线形态不解析——整组用例经 hostTest 自跳过）。
// 锚版本读不到时这里抛错＝环境故障，红是诚实读数（校验器 ⓪ 同样红）。
const ANCHOR = yamlAbsent ? undefined : resolveAnchorTier();
const ANCHOR_TIER = ANCHOR?.tier;
const OTHER_TIER = ANCHOR_TIER === 'rc1' ? 'rc2' : 'rc1';

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
 *  `npm install @deepseek-ai/dsh@<精确宿主版本>`（支持集合逐宿主）提供这个包。
 *
 *  基线文件按宿主代际而变：0.2.2 适配线（首轮 0.2.2-rc.1）的基线相对 0.2.1
 *  兼容线有四处漂移（tool-fs 增 config.applyPatch、delegation 组移除
 *  tool-subagent-list-agents 行、tool-subagent 行 config 改 modelSelection＋
 *  modelDiscovery 键、插件管理 manager 行表达式化）；0.2.1 线树（standard/
 *  cordis 6799／7406 B）与 0.2.0-rc.2 树（7511／8089 B）都是不同代基线。
 *  P14 的期望集钉在 0.2.2 适配线（文件头 P14 定义），锚宿主是其他代际时对账
 *  不适用——用例内按锚内 dsh 版本做代际检查、显式 NOTE 跳过，不静默、不冒充
 *  对账通过。 */
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

/** 构造另一档的基线快照（P14 双档对账用；不依赖同机同时存在两棵宿主树）：
 *  对当前锚树的真实基线解析结果施加两档间已登记的全部漂移（设计 §7.4 事实
 *  清单）——standard：skill-filesystem 的 config.customSkillDirs、present 后
 *  tool-office 行；cordis：persona 第二句；两基线共通：tool-subagent-control
 *  行 config.interrupt。快照里的锚串为本文件独立持份（与校验器常量、真实基线
 *  三方一致；真实基线的逐字节事实由 CI 两档锚树矩阵各自主验）。 */
function synthTierBaseline(doc, toTier) {
  const clone = structuredClone(doc);
  const plugins = clone[0].insert[0].config.plugins;
  const isStandard = clone[0].insert[0].config.id === 'standard';
  const persona = plugins.find((child) => child?.id === 'persona');
  const skill = plugins.find((child) => child?.id === 'skill-filesystem');
  const control = plugins.find((child) => child?.id === 'delegation')
    .config.find((child) => child?.id === 'tool-subagent-control');
  const ONE = 'You are a coding agent powered by the {{model}} model.';
  const TWO = 'You are a coding agent powered by the {{model}} model. You help the user customize DeepSeek Harness itself.';
  const SKILL_EXPR = "process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')";
  if (toTier === 'rc2') {
    control.config = { interrupt: false };
    if (isStandard) {
      skill.config = { customSkillDirs: [SKILL_EXPR] };
      const presentIndex = plugins.findIndex((child) => child?.id === 'present');
      assert.ok(presentIndex !== -1, 'standard 基线必须有 present 行（快照插入位）');
      plugins.splice(presentIndex + 1, 0, { id: 'tool-office', name: '@deepseek-ai/dsh-tool-office' });
    } else {
      persona.config.prefix = TWO;
    }
  } else {
    delete control.config;
    if (isStandard) {
      delete skill.config;
      const officeIndex = plugins.findIndex((child) => child?.id === 'tool-office');
      if (officeIndex !== -1) plugins.splice(officeIndex, 1);
    } else {
      persona.config.prefix = ONE;
    }
  }
  return clone;
}

/** 收集一份补丁解析结果的叶子行/组行（P14 基线侧变异探针用；与对账比较器
 *  同款遍历）。 */
function walked(doc) {
  const leaf = new Map(), group = new Map();
  const walk = (arr) => arr.forEach((child) => {
    if (Array.isArray(child?.config)) { group.set(child.id, child); walk(child.config); }
    else leaf.set(child.id, child);
  });
  walk(doc[0].insert[0].config.plugins);
  return { leaf, group };
}

/** 造一份变异副本并校验它（临时目录，用完即删）。`opts.tier` 注入档位（双档
 *  变异用；缺省按宿主锚档）。 */
async function validateMutation(mutation, patchPath = PATCH, baselineText = baseline, { tier } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'async-preset-'));
  try {
    const path = join(dir, 'patch.yml');
    writeFileSync(path, mutation(baselineText), 'utf8');
    return await validatePatch(path, { quiet: true, tier });
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
 *  tmp/tools/validate-preset.mjs + tmp/lib/text.js + tmp/lib/host-contract.js +
 *  tmp/tools/_host-resolve.mjs），返回该副本的 validatePatch——词典锚句判据
 *  （⑤b/⑦/⑪）的变异通道：锚句住在 `lib/text.js`，不复制成对副本就变异不到
 *  校验器实际读取的文案表；host-contract 是校验器锚版本分档的新 import，副本
 *  不带上会在临时目录里 ERR_MODULE_NOT_FOUND。 */
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
    writeFileSync(join(dir, 'lib', 'host-contract.js'),
      readFileSync(join(root, 'lib', 'host-contract.js'), 'utf8'), 'utf8');
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
  assert.ok(result.lines.some((l) => l.includes('顶层 26 行 + 嵌套 10 行')), '③ 的对账读数必须是 26+10（0.2.2 基线 + 四行顶层 async 工具行；delegation 组 5 行 + async-workflow——list-agents 行随 0.2.2 基线移除）');
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

hostTest('validate-preset：toolName 写错（async_wait 写成 async_run）必须拦住', async () => {
  const result = await validateMutation((text) => text
    .replace('toolName: async_wait\n', 'toolName: async_run\n'));
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => l.includes('重复') || l.includes('缺')),
    `报错必须指向判据④的缺值/重复，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
});

hostTest('validate-preset：toolName 写成不存在的值必须拦住', async () => {
  const result = await validateMutation((text) => text
    .replace('toolName: async_agent', 'toolName: async_frobnicate'));
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => l.includes('toolName 五值缺')));
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
  const block = (rowId, disabled) => `          - id: ${rowId}\n            name: '@deepseek-ai/dsh-plugin-manager/tools'\n            disabled: ${disabled}\n`;
  const expr = '!!js "!ctx.get(\'profileContext\')"';
  // 反例方向一（create）：基线条件表达式被换回布尔 true——创造上下文中插件
  // 管理入口整个锁死（需求 §7.3.2：保留基线启用条件）。
  const toBoolean = await validateMutation((text) => text
    .replace(block('tool-plugin-manager', expr), block('tool-plugin-manager', 'true')),
    PATCH_CREATE, baselineCreate);
  assert.equal(toBoolean.ok, false, '回归布尔禁用必须被拦');
  assert.ok(toBoolean.lines.some((l) => l.includes('tool-plugin-manager.disabled') && l.includes('基线禁用形态逐字同形')),
    `报错必须指向 ⑧b 的基线同形判据，实得：${toBoolean.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
  // 反例方向二（create）：表达式本身被改——判据逐字，不是「是表达式即可」。
  const exprDrift = await validateMutation((text) => text
    .replace(block('tool-plugin-manager', expr), block('tool-plugin-manager', '!!js "!ctx.get(\'pluginContext\')"')),
    PATCH_CREATE, baselineCreate);
  assert.equal(exprDrift.ok, false, '表达式漂移必须被拦（逐字判据）');
  assert.ok(exprDrift.lines.some((l) => l.includes('tool-plugin-manager.disabled') && l.includes('基线禁用形态逐字同形')));
  // 反例方向三（dsh-async 侧，0.2.2 基线按行分形）：manager 行表达式被换回
  // 布尔——standard 基线该行已表达式化，回归布尔即漂移。
  const managerToBoolean = await validateMutation((text) => text
    .replace(block('tool-plugin-manager', expr), block('tool-plugin-manager', 'true')));
  assert.equal(managerToBoolean.ok, false, 'dsh-async 的 manager 行必须保持 standard 基线的表达式形态');
  assert.ok(managerToBoolean.lines.some((l) => l.includes('tool-plugin-manager.disabled') && l.includes('基线禁用形态逐字同形')));
  // 反例方向四（dsh-async 侧）：market 行布尔禁用被换成条件表达式——standard
  // 基线该行保持布尔，与 manager 行分形（market 是文件末行，替换串不带尾随
  // 换行以免因行尾形态失配而漏变异）。
  const marketToExpr = await validateMutation((text) => text
    .replace("- id: tool-plugin-market\n            name: '@deepseek-ai/dsh-plugin-market/tools'\n            disabled: true",
      "- id: tool-plugin-market\n            name: '@deepseek-ai/dsh-plugin-market/tools'\n            disabled: !!js \"!ctx.get('profileContext')\""));
  assert.equal(marketToExpr.ok, false, 'dsh-async 的 market 行必须保持 standard 基线的布尔禁用');
  assert.ok(marketToExpr.lines.some((l) => l.includes('tool-plugin-market.disabled') && l.includes('基线禁用形态逐字同形')));
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
      .split('wait with async_wait').join('retrieve via async_wait'));
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
  assert.ok(result.lines.some((l) => l.includes('toolName 五值缺')));
});

hostTest('validate-preset：期望集必须与两档 shipped 基线逐条对账（P14，防快照漂移；真实锚档＋构造快照档）', async () => {
  const { load } = await loadYaml();
  // 代际检查（对账按定义只认 0.2.2 适配线的两档基线）：锚宿主的 dsh 版本不是
  // 0.2.2 线时（如误把 0.2.1 兼容线树当锚——其 delegation 组仍挂 list-agents
  // 行、tool-subagent 行仍是 modelSelectionSettings 旧键），逐条比对会把「基线
  // 代际差」误报成快照漂移。显式 NOTE 后跳过对账：不静默、不冒充对账通过；
  // 判据校验（①–⑭）不受此影响、照常跑。
  if (!ANCHOR.version.startsWith('0.2.2')) {
    console.log(`NOTE P14 对账钉在 0.2.2 适配线两档基线；当前锚宿主 dsh@${ANCHOR.version} 的基线为另一代，逐条对账不适用，跳过（防把代际差误报成快照漂移）。`);
    return;
  }
  for (const { configId, baselineFile, baselineName } of RECONCILE) {
    if (baselineFile === undefined || !existsSync(baselineFile)) {
      assert.fail(`P14 对账依赖的基线补丁读不到：@deepseek-ai/dsh-web-app/presets/${baselineName}（期望集 ${configId} 的出处就是它）。候选锚 = DSAT_HOST_MODULES → DSH_HOME/profiles → %APPDATA%/npm 全局树；CI 上由 npm install @deepseek-ai/dsh@<精确宿主版本>（支持集合逐宿主）提供。锚缺失不许静默跳过。`);
    }
    const realDoc = load(readFileSync(baselineFile, 'utf8'));
    const patchDoc = load(readFileSync(join(import.meta.dirname, '..', EXPECTATIONS[configId].patchRel), 'utf8'));
    // 两档各自对账：锚档用真实基线；另一档用构造快照（对真实基线解析结果施加
    // 两档间已登记的全部漂移——见 synthTierBaseline）。同一套 reconcileBaseline
    // 在两档上都必须通过，且登记差异恰为注册表所列（rc1 档 D1/D2/D4 行级、
    // rc2 档 D3/D4——见 tools/validate-preset.mjs 的 DESIGNED_DELTAS）。
    for (const tier of [ANCHOR_TIER, OTHER_TIER]) {
      const baselineDoc = tier === ANCHOR_TIER ? realDoc : synthTierBaseline(realDoc, tier);
      const result = reconcileBaseline(configId, { tier, baselineDoc, patchDoc, quiet: true });
      assert.equal(result.ok, true, `${configId}（${tier} 档）对账失败：\n${result.lines.filter((l) => l.includes('FAIL')).join('\n')}`);
      assert.deepEqual(result.deltas, DESIGNED_DELTAS[configId][tier].map((entry) => entry.delta).sort(),
        `${configId}（${tier} 档）登记差异必须恰为注册表所列（表侧快照锁见 P37）`);
    }
    // 行体比较器灵敏度（防恒真）：基线侧改动清单外的叶子行改一个字段，同一
    // 比较器必须报出来——否则上面的通过断言恒真。
    const drifted = structuredClone(realDoc);
    const fsSearch = walked(drifted).leaf.get('tool-fs-search');
    fsSearch.config.sampleOverCapGlobResults = true;
    const driftResult = reconcileBaseline(configId, { tier: ANCHOR_TIER, baselineDoc: drifted, patchDoc, quiet: true });
    assert.equal(driftResult.ok, false, '行体比较器必须能检出基线侧单字段漂移');
    // 档位错标必红（分档真实起作用的证明）：rc.1 形态基线按 rc2 档对账 →
    // tool-office 行豁免错位（rc2 档无 row-only 豁免）；rc.2 形态基线按 rc1 档
    // 对账 → control 行 config（及 create 的 persona 两句）分歧未被豁免。两方向
    // 都红，证明对账不是"档位摆设"。
    const rc1Doc = ANCHOR_TIER === 'rc1' ? realDoc : synthTierBaseline(realDoc, 'rc1');
    const rc2Doc = ANCHOR_TIER === 'rc2' ? realDoc : synthTierBaseline(realDoc, 'rc2');
    assert.equal(reconcileBaseline(configId, { tier: 'rc2', baselineDoc: rc1Doc, patchDoc, quiet: true }).ok, false,
      '把 rc.1 形态基线按 rc2 档对账必须红（tool-office 行登记豁免错位）');
    assert.equal(reconcileBaseline(configId, { tier: 'rc1', baselineDoc: rc2Doc, patchDoc, quiet: true }).ok, false,
      '把 rc.2 形态基线按 rc1 档对账必须红（control 行 config 等分歧未被豁免）');
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
  // 0.2.2 基线移除 tool-subagent-list-agents 行后，以 tool-subagent ↔
  // tool-subagent-fork 相邻两行互换为换序反例（两份补丁同款行文本）。
  const subagentBlock = "              - id: tool-subagent\n                name: '@deepseek-ai/dsh-tool-subagent'\n                disabled: true\n                config:\n                  provider: spawn\n                  toolName: subagent\n                  modelSelection: true\n                  modelDiscovery: true\n";
  const forkBlock = "              - id: tool-subagent-fork\n                name: '@deepseek-ai/dsh-tool-subagent'\n                disabled: true\n                config:\n                  provider: fork\n                  toolName: subagent_fork\n";
  for (const [path, text] of [[PATCH, baseline], [PATCH_CREATE, baselineCreate]]) {
    const result = await validateMutation((t) => t
      .replace(subagentBlock + forkBlock, forkBlock + subagentBlock),
      path, text);
    assert.equal(result.ok, false, '组内行换序必须被拦（基线行序是「逐项按序」承诺的一半）');
    assert.ok(result.lines.some((l) => l.includes('嵌套行序与基线期望不一致')),
      '报错必须指向嵌套行序判据');
  }
});

hostTest('validate-preset：tool-fs 基线随迁键 applyPatch 漂移必须拦住（⑩，两份补丁）', async () => {
  for (const [path, text] of [[PATCH, baseline], [PATCH_CREATE, baselineCreate]]) {
    const drift = await validateMutation((t) => t
      .replace('              applyPatch: false', '              applyPatch: true'),
      path, text);
    assert.equal(drift.ok, false, 'applyPatch 值漂移必须被拦（0.2.2 基线随迁的逐字判据）');
    assert.ok(drift.lines.some((l) => l.includes('tool-fs') && l.includes('键值漂移')),
      '报错必须指向 ⑩ 的 tool-fs 逐字判据');
    const killed = await validateMutation((t) => t
      .replace("            config:\n              # 0.2.2 基线形态：补丁写路径默认关闭（applyPatch:false 随基线逐字）。\n              applyPatch: false\n", ''),
      path, text);
    assert.equal(killed.ok, false, '删 applyPatch 键（整个 config 块）必须被拦');
    assert.ok(killed.lines.some((l) => l.includes('tool-fs') && l.includes('缺键')),
      '报错必须指向 ⑩ 的缺键判据');
  }
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
  // persona prefix 逐字锚（⑤ 分档形态）：dsh-async 与该档 standard 基线身份句
  // 逐字一致（两档同串）；create 为 D2 固定两句锚（两档同串——rc1 档较其基线
  // 多第二句为登记分歧，判据只锁逐字）。公共异步纪律段住在两语表的两个词典
  // 键里，分叉只许发生在委托规则第 1 条。
  const { load } = await loadYaml();
  const readPrefix = async (path) => {
    const doc = load(readFileSync(path, 'utf8'));
    return doc[0].insert[0].config.plugins.find((child) => child?.id === 'persona').config.prefix;
  };
  const BASELINE_IDENTITY = 'You are a coding agent powered by the {{model}} model.';
  const CREATE_IDENTITY_D2 = 'You are a coding agent powered by the {{model}} model. You help the user customize DeepSeek Harness itself.';
  assert.equal(await readPrefix(PATCH), BASELINE_IDENTITY, 'dsh-async 的 prefix 与该档 standard 基线身份句逐字一致');
  assert.equal(await readPrefix(PATCH_CREATE), CREATE_IDENTITY_D2, 'dsh-async-create 的 prefix 与 D2 固定两句锚逐字一致（⑤ 逐字判据，P34 变异看守）');
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
  // ⑪ 读的是真 text.js，变异经成对副本通道（validatorWithText：校验器 + 文案表
  // + host-contract + _host-resolve 成对复制后动态导入）——证 ⑪ 的检查对缺锚句
  // 的文案表真的开火，不是恒真。
  const killed = await validatorWithText((src) => src
    .replace('for one or two delegations prefer async_agent.', '')
    .replace('一两个委托用 async_agent。', ''));
  const result = await killed.validate(PATCH, { quiet: true });
  assert.equal(result.ok, false, '门槛锚句缺失必须被拦（R34-h/R35-g）');
  assert.ok(result.lines.some((l) => l.includes('门槛锚句')),
    `报错必须指向 ⑪ 的门槛判据，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
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
    .replace('wait with async_wait(targets=[{kind:"agent", id:"..."}], wait_ms=...) (bounded)',
      'call async_wait(targets=[{kind:"agent", id:"..."}], wait_ms=...) (bounded)')
    .replace('需要后台子代理的结果时用 async_wait（有界、用户插话会打断等待）',
      '需要后台子代理的结果时以 async_wait（有界、用户插话会打断等待）'));
  const result = await killed.validate(PATCH, { quiet: true });
  assert.equal(result.ok, false, '删有界等待取回句必须被拦');
  assert.ok(result.lines.some((l) => l.includes('wait with async_wait') && l.includes('en 档')),
    `报错必须点名 en 档缺失锚句，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
  assert.ok(result.lines.some((l) => l.includes('需要后台子代理的结果时用 async_wait') && l.includes('zh 档')),
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
        'delivered directly',
        'wait with async_wait',
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
        '结果正文直接交付',
        '需要后台子代理的结果时用 async_wait',
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
        'delivered directly',
        'wait with async_wait',
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
        '结果正文直接交付',
        '需要后台子代理的结果时用 async_wait',
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

hostTest('validate-preset：通用锚句表逐锚删除变异——表内任一锚被删必红（P28，⑤c，两档全表）', async () => {
  // 与 P26 同法（表驱动删除变异），对象换成通用变体（discipline.preset.generic，
  // VERIFY-GENERIC-01）：⑤c 独立于期望集、随每份补丁校验执行——这里用基线
  // 补丁驱动。提问角色四组与内置逐字同文：删 ASK 锚时 ⑤b 与 ⑤c 同时红，
  // 断言只认点名 generic 的一行。
  for (const lang of ['en', 'zh']) {
    for (const anchor of GENERIC_DISCIPLINE_ANCHORS[lang]) {
      const killed = await validatorWithText((src) => src.split(anchor).join(''));
      const result = await killed.validate(PATCH, { quiet: true });
      assert.equal(result.ok, false, `删通用锚句必须被拦（generic ${lang} 档：${anchor}）`);
      assert.ok(result.lines.some((l) => l.includes(anchor) && l.includes(`${lang} 档`) && l.includes('discipline.preset.generic')),
        `报错必须点名通用变体缺失锚句（generic ${lang} 档），实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
    }
  }
});

hostTest('validate-preset：通用锚句表快照锁——表删行、改锚或加锚必红（P29，⑤c，两档）', () => {
  // 与 P27 同理：P28 的击杀清单派生自通用锚句表本身，测不出表自身被静默
  // 弱化——测试内独立持份清单逐项 deepEqual，两处同改才过得去。
  const LOCKED_GENERIC = {
    en: [
      'Delegations are created with async_agent in the background',
      'never pass run_in_background: false',
      'delivered directly (attached to an in-flight async_wait return, or as a completion message)',
      'wait with async_wait',
      'Do not poll in a loop',
      'no personal pronouns for the actor, authorizer, or owner',
      'explicit, distinguishable role names',
      'role plus the action',
      'keep role references consistent'
    ],
    zh: [
      '委托一律经 async_agent 在后台创建',
      '也不传 run_in_background: false',
      '结果正文直接交付',
      '需要子代理的结果时，用 async_wait',
      '不要循环轮询',
      '不使用指代执行者、授权者或归属对象的人称代词',
      '明确、可区分的角色名称',
      '写清角色与动作',
      '与所选角色名称保持一致'
    ]
  };
  for (const lang of ['en', 'zh']) {
    assert.deepEqual(GENERIC_DISCIPLINE_ANCHORS[lang], LOCKED_GENERIC[lang],
      `通用锚句表与独立期望清单不一致（generic ${lang} 档）——表被弱化或锁未同步，两处需同改并过评审`);
  }
});

hostTest('validate-preset：通用纪律段整段置空必红（P30，⑤c，en/zh 各一次 × 两份补丁）', async () => {
  // 固化验收受控反例（VERIFY-GENERIC-01）：修前把英文或中文
  // discipline.preset.generic 整段置空，两份预设补丁校验都仍通过——修后
  // ⑤c 随每份补丁校验执行，任一档置空两份补丁都必须红。text.js 里该键的
  // en/zh 值各占一行，按出现序（en 在前、zh 在后）定位替换。
  const killGenericAt = (index) => (src) => {
    let seen = -1;
    return src.replace(/'discipline\.preset\.generic': '.*',/g, (match) => {
      seen += 1;
      return seen === index ? "'discipline.preset.generic': ''," : match;
    });
  };
  for (const [index, lang] of [[0, 'en'], [1, 'zh']]) {
    const killed = await validatorWithText(killGenericAt(index));
    for (const [name, patchPath] of [['dsh-async', PATCH], ['dsh-async-create', PATCH_CREATE]]) {
      const result = await killed.validate(patchPath, { quiet: true });
      assert.equal(result.ok, false, `通用纪律段 ${lang} 档整段置空必须被拦（${name}）`);
      assert.ok(result.lines.some((l) => l.includes('discipline.preset.generic') && l.includes(`${lang} 档`)),
        `报错必须点名通用变体（${name}，${lang} 档），实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
    }
  }
});

// ══════════════════ 双档分档判据（P31–P37，D1–D4＋分档；0.2.2 双档线）════════════════

hostTest('validate-preset：锚版本分档边界与失败形态（P31，⓪/tierForVersion）', () => {
  // 边界语义（比较器 lib/host-contract.js#compareVersions；边界 0.2.2-rc.2）：
  // 小于 → rc1；大于等于 → rc2（rc.2 与 rc.3 基线逐字节相同、同档）；正式
  // 0.2.2 高于一切预发布。不可解析 → 明确报错（不许"套不上就放行"）；候选
  // 全空读不到版本同样报错。
  assert.equal(tierForVersion('0.2.2-rc.1'), 'rc1');
  assert.equal(tierForVersion('0.2.2-alpha.2'), 'rc1');
  assert.equal(tierForVersion('0.2.1'), 'rc1');
  assert.equal(tierForVersion('0.2.2-rc.2'), 'rc2');
  assert.equal(tierForVersion('0.2.2-rc.3'), 'rc2');
  assert.equal(tierForVersion('0.2.2'), 'rc2');
  assert.throws(() => tierForVersion('not-a-version'), /不可解析/);
  assert.throws(() => tierForVersion('0.2'), /不可解析/);
  assert.throws(() => readAnchorHostVersion([]), /读不到宿主锚版本/);
  // 锚树实读（进程内当前锚）：支持集合成员的档位判定与锚档一致。
  if (/^0\.2\.2-rc\.[123]$/.test(ANCHOR.version)) {
    assert.equal(ANCHOR.tier, ANCHOR.version === '0.2.2-rc.1' ? 'rc1' : 'rc2');
  }
});

hostTest('validate-preset：两档期望集都执行且合法补丁双档通过（P32，⓪/③）', async () => {
  for (const tier of ['rc1', 'rc2']) {
    for (const [name, path] of [['dsh-async', PATCH], ['dsh-async-create', PATCH_CREATE]]) {
      const result = await validatePatch(path, { quiet: true, tier });
      assert.equal(result.ok, true, `${name}（${tier} 档）应当通过，失败行：\n${result.lines.filter((l) => l.includes('FAIL')).join('\n')}`);
      assert.ok(result.lines.some((l) => l.includes(`锚档 ${tier}`)), `⓪ 必须报出所选档位（${name}，${tier} 档）`);
    }
  }
  // dsh-async 两档的 ③ 读数都是 26+10（tool-office 两档都在场——rc1 档为 D4
  // 登记插入；create 的 26+10 由 P1 锚定）。
  for (const tier of ['rc1', 'rc2']) {
    const result = await validatePatch(PATCH, { quiet: true, tier });
    assert.ok(result.lines.some((l) => l.includes('顶层 26 行 + 嵌套 10 行') && l.includes(tier)),
      `③ 的读数必须带档位并计入 office 行（${tier} 档），实得：${result.lines.filter((l) => l.includes('③')).join(' | ')}`);
  }
});

hostTest('validate-preset：customSkillDirs 表达式改一字符必红（P33，⑫ D1；两档×两补丁）', async () => {
  const expr = "process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')";
  const driftedExpr = expr.replace(", 'skills')", ", 'skillz')");
  assert.notEqual(driftedExpr, expr, '变异必须真的改到表达式（否则本用例恒真）');
  for (const tier of ['rc1', 'rc2']) {
    for (const [name, path, text] of [['dsh-async', PATCH, baseline], ['dsh-async-create', PATCH_CREATE, baselineCreate]]) {
      const result = await validateMutation((src) => src.split(expr).join(driftedExpr), path, text, { tier });
      assert.equal(result.ok, false, `D1 表达式漂移必须被拦（${name}，${tier} 档）`);
      assert.ok(result.lines.some((l) => l.includes('customSkillDirs') && l.includes('D1')),
        `报错必须指向 ⑫ 的 D1 逐字锚（${name}，${tier} 档），实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
    }
  }
});

hostTest('validate-preset：create persona 两句锚增删必红（P34，⑤ D2；两档）', async () => {
  const two = 'prefix: You are a coding agent powered by the {{model}} model. You help the user customize DeepSeek Harness itself.';
  for (const tier of ['rc1', 'rc2']) {
    // 改第二句（加一个词）
    const edited = await validateMutation((src) => src
      .replace(two, 'prefix: You are a coding agent powered by the {{model}} model. You help the user customize DeepSeek Harness itself, not other products.'),
      PATCH_CREATE, baselineCreate, { tier });
    assert.equal(edited.ok, false, `D2 第二句增改必须被拦（${tier} 档）`);
    assert.ok(edited.lines.some((l) => l.includes('D2 固定两句锚')),
      `报错必须指向 ⑤ 的 D2 固定锚（${tier} 档），实得：${edited.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
    // 删第二句（回落单句＝rc.1 基线形态）——登记分歧不是"退回基线"的许可：
    // 判据锚的是两句串本身，rc1 档下回落单句同样红。
    const dropped = await validateMutation((src) => src
      .replace(two, 'prefix: You are a coding agent powered by the {{model}} model.'),
      PATCH_CREATE, baselineCreate, { tier });
    assert.equal(dropped.ok, false, `D2 删第二句必须被拦（${tier} 档——rc1 档回落其基线单句形态也红）`);
    assert.ok(dropped.lines.some((l) => l.includes('D2 固定两句锚')), '报错必须指向 ⑤ 的 D2 固定锚');
  }
});

hostTest('validate-preset：control 行加 interrupt:false 必红（P35，⑬ D3；两档×两补丁）', async () => {
  const controlBlock = "              - id: tool-subagent-control\n                name: '@deepseek-ai/dsh-tool-subagent-control'\n";
  const withInterrupt = `${controlBlock}                config:\n                  interrupt: false\n`;
  for (const tier of ['rc1', 'rc2']) {
    for (const [name, path, text] of [['dsh-async', PATCH, baseline], ['dsh-async-create', PATCH_CREATE, baselineCreate]]) {
      const result = await validateMutation((src) => src.replace(controlBlock, withInterrupt), path, text, { tier });
      assert.equal(result.ok, false, `D3 随迁 interrupt:false 必须被拦（${name}，${tier} 档）`);
      assert.ok(result.lines.some((l) => l.includes('tool-subagent-control') && l.includes('不得携带 config')),
        `报错必须指向 ⑬ 的零 config 判据（${name}，${tier} 档），实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
    }
  }
});

hostTest('validate-preset：tool-office 行删/挪/表达式漂移/加 config 必红（P36，⑭+③ D4；两档）', async () => {
  const officeBlock = `          - id: tool-office\n            name: '@deepseek-ai/dsh-tool-office'\n            disabled: !!js "(() => { try { const cr = process.getBuiltinModule('node:module').createRequire; const dshRoot = cr(baseUrl).resolve('@deepseek-ai/dsh/package.json'); cr(dshRoot).resolve('@deepseek-ai/dsh-tool-office/package.json'); return false } catch { return true } })()"\n`;
  const presentBlock = "          - id: present\n            name: '@deepseek-ai/dsh-tool-present'\n";
  assert.ok(baseline.includes(officeBlock), '变异锚文本必须与补丁现状逐字一致（否则本用例恒真）');
  for (const tier of ['rc1', 'rc2']) {
    // a. 删行：rc.1 树包缺席靠 disabled 探测跳过，整行省略违反 D4。
    const removed = await validateMutation((src) => src.replace(officeBlock, ''), PATCH, baseline, { tier });
    assert.equal(removed.ok, false, `删 tool-office 行必须被拦（${tier} 档）`);
    assert.ok(removed.lines.some((l) => l.includes('tool-office') && (l.includes('必须在场') || l.includes('缺行'))),
      `报错必须点名 ⑭ 的存在性或 ③ 的缺行（${tier} 档），实得：${removed.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
    // b. 探测表达式改一字符（逐字锚）。
    const drifted = await validateMutation((src) => src
      .replace(officeBlock, officeBlock.replace('return false }', 'return falsx }')), PATCH, baseline, { tier });
    assert.equal(drifted.ok, false, `D4 探测表达式漂移必须被拦（${tier} 档）`);
    assert.ok(drifted.lines.some((l) => l.includes('tool-office.disabled') && l.includes('D4')),
      `报错必须指向 ⑭ 的表达式逐字锚（${tier} 档），实得：${drifted.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
    // c. 挪位（present 之前）——位置判据。
    const moved = await validateMutation((src) => src
      .replace(officeBlock, '')
      .replace(presentBlock, officeBlock + presentBlock), PATCH, baseline, { tier });
    assert.equal(moved.ok, false, `tool-office 挪位必须被拦（${tier} 档）`);
    assert.ok(moved.lines.some((l) => l.includes('tool-office 行必须钉在 present 行之后')),
      `报错必须点名 ⑭ 的位置判据（${tier} 档），实得：${moved.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
    // d. 加 config（基线行无 config，D4 仅多 disabled 探测一键）。
    const withConfig = await validateMutation((src) => src
      .replace(officeBlock, officeBlock.replace('            disabled:', "            config:\n              anything: true\n            disabled:")), PATCH, baseline, { tier });
    assert.equal(withConfig.ok, false, `tool-office 加 config 必须被拦（${tier} 档）`);
    assert.ok(withConfig.lines.some((l) => l.includes('tool-office') && l.includes('不得携带 config')),
      `报错必须点名 ⑭ 的零 config 判据（${tier} 档），实得：${withConfig.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
  }
});

hostTest('validate-preset：登记分歧表快照锁——表删行、改文案或加行必红（P37，D1–D4 对账豁免）', () => {
  // P14 的对账断言派生自校验器内的 DESIGNED_DELTAS 注册表，测不出表自身被静默
  // 弱化（删行后豁免与断言同步缩小、对账照常绿）。这里用测试内独立持份的清单
  // 逐项 deepEqual 注册表：删行、改文案、加行都必须先改这份锁才过得去——两处
  // 同改在 diff 评审里可见，静默弱化不再有零红通道。
  const LOCKED = {
    'dsh-async': {
      rc1: [
        'D1 skill-filesystem config.customSkillDirs：本补丁携带、rc.1 standard 基线无此键（统一携带，cordis 基线先例；表达式串另由 ⑫ 逐字锚）',
        'D4 tool-office 行在场：rc.1 基线无此行（在场性条件装载，包缺席时行跳过）'
      ],
      rc2: [
        'D3 tool-subagent-control config.interrupt 不随迁：本补丁无 config、rc.2+ 基线有（保留 interrupt_agent 注册，需求 §3.1；另由 ⑬ 守卫）',
        'D4 tool-office 行 disabled 探测键：本补丁条件装载、rc.2+ 基线行裸（另由 ⑭ 逐字锚）'
      ]
    },
    'dsh-async-create': {
      rc1: [
        'D2 persona prefix 第二句：本补丁两句、rc.1 cordis 基线单句（用途陈述对 rc.1 同真；两句串另由 ⑤ 逐字锚）'
      ],
      rc2: [
        'D3 tool-subagent-control config.interrupt 不随迁：本补丁无 config、rc.2+ 基线有（保留 interrupt_agent 注册，需求 §3.1；另由 ⑬ 守卫）'
      ]
    }
  };
  for (const [configId, tiers] of Object.entries(LOCKED)) {
    for (const [tier, expected] of Object.entries(tiers)) {
      assert.deepEqual(DESIGNED_DELTAS[configId][tier].map((entry) => entry.delta).sort(), [...expected].sort(),
        `登记分歧表与独立期望清单不一致（${configId}，${tier} 档）——表被弱化或锁未同步，两处需同改并过评审`);
    }
  }
});
