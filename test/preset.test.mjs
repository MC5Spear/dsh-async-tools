/**
 * 预设补丁校验器的变异测试（对象 `tools/validate-preset.mjs`，判据 = 预设补丁九项；
 * 变异验收参数化覆盖两份补丁）。
 *
 * 为什么必须做变异测试而不是只看输出：实测 `validate-preset.mjs` 曾对**五类常见改错
 * 全部放行**（报 OK、退出码 0），其中最危险的是"四行都被 `disabled: true`"——真机上
 * **一个工具都不注册**，而校验器说一切正常。一个校验器只报"通过"是不可信的，
 * 得让它先证明自己会失败。
 *
 * 形态：对象是 `presets/dsh-async.patch.yml`（基线 = shipped standard）与
 * `presets/dsh-async-create.patch.yml`（基线 = shipped cordis）；校验器以
 * **模块导入**方式在进程内调用（子进程 spawn 在沙箱里 EPERM，且进程内调用让
 * "变异 → 断言"同轮完成）。变异副本写在系统临时目录，用完即删。
 *
 * dsh-async-create 专属用例：P1 基线绿、P2/P3 基线行缺/多、P4 派生入口翻活、
 * P5 plugin-manager 表达式、P6 persona 锚句、P7 pwsh 挂回、P8 tool-bash 表达式、
 * P9 未知 config.id、P10 护栏、P11 互斥判据复合、P12 嵌套行缺失、P13 toolName、
 * P14 期望集与 0.2.0-rc.2 证据树对账、P15 provider 形态、P16 公共异步纪律段同源。
 * 第五行工具与禁用手术专属用例：P17 tool-workflow 翻活、P18 dsh-async 的
 * tool-subagent 翻活、P19 删 async-workflow 行、P20 async-workflow 挪出
 * delegation 组（设计 §3.6 行位）、P21 删 workflow-ptc（create 侧）、P22 门槛锚句。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePatch, EXPECTATIONS, expectedTopFromBaseline, loadYaml } from '../tools/validate-preset.mjs';
import { candidateModules } from '../tools/_host-resolve.mjs';

const PATCH = join(import.meta.dirname, '..', 'presets', 'dsh-async.patch.yml');
const PATCH_CREATE = join(import.meta.dirname, '..', 'presets', 'dsh-async-create.patch.yml');
const baseline = readFileSync(PATCH, 'utf8');
const baselineCreate = readFileSync(PATCH_CREATE, 'utf8');

/** 两份 shipped 基线补丁（P14 对账的唯一出处；**读不到即红**，不许静默跳过）。
 *
 *  出处 = 宿主安装树里的 `@deepseek-ai/dsh-web-app/presets/`，目录按
 *  `DSAT_HOST_MODULES` → `DSH_HOME/profiles` → `%APPDATA%/npm` 次序推导
 *  （与 `tools/_host-resolve.mjs` 同一套候选），**不写死机器路径**——公开仓的 CI 用
 *  `npm install @deepseek-ai/dsh@0.2.0-rc.2` 提供这个包。
 *
 *  2026-10-03 实测：npm 公开发布版与本机安装树的两份文件**逐字节相同**
 *  （sha256 相同；standard 7511 B、cordis 8089 B）。锚点取哪一边期望集都一致
 *  （两文件与 [0.1.7] 树逐字节相同的既有核对继续成立）。 */
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

/** 从 persona prefix 里抽出公共异步纪律段（设计 §3.6：This deployment…failure. 整段）。 */
function commonIntro(prefix) {
  const start = prefix.indexOf('This deployment runs commands ASYNCHRONOUSLY.');
  const endMarker = 'Never treat a returned job_id as a failure.';
  const end = prefix.indexOf(endMarker);
  assert.ok(start !== -1 && end !== -1, `公共段边界句必须在场（start=${String(start)} end=${String(end)}）`);
  return prefix.slice(start, end + endMarker.length);
}

test('validate-preset：合法补丁必须通过（基线，防止断言恒真）', async () => {
  const result = await validatePatch(PATCH, { quiet: true });
  assert.equal(result.ok, true, `基线应当通过，失败行：\n${result.lines.filter((l) => l.includes('FAIL')).join('\n')}`);
});

test('validate-preset：dsh-async-create 基线必须通过（P1，R26）', async () => {
  const result = await validatePatch(PATCH_CREATE, { quiet: true });
  assert.equal(result.ok, true, `创造补丁基线应当通过，失败行：\n${result.lines.filter((l) => l.includes('FAIL')).join('\n')}`);
  assert.ok(result.lines.some((l) => l.includes('顶层 23 行 + 嵌套 14 行')), '③ 的对账读数必须是 23+14（R35-a 起嵌套多一行 async-workflow）');
});

test('validate-preset：tool-bash 被改成平台表达式必须拦住（需求 §3.3：Linux 也要无条件禁用）', async () => {
  const result = await validateMutation((text) => text
    .replace("id: tool-bash\n            name: '@deepseek-ai/dsh-tool-bash'\n            disabled: true",
      "id: tool-bash\n            name: '@deepseek-ai/dsh-tool-bash'\n            disabled: !!js process.platform === 'win32'"));
  assert.equal(result.ok, false, '平台表达式必须被拦（R20 静态侧）');
  assert.ok(result.lines.some((l) => l.includes('tool-bash.disabled') && l.includes('布尔 true')),
    `报错必须指向判据②，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
});

test('validate-preset：tool-bash 行被整个删掉必须拦住', async () => {
  // 行形态：10 空格 `- id: tool-bash` + 后随 12 空格属性行（见补丁 :58-60）。
  const result = await validateMutation((text) => text.replace(
    / {10}- id: tool-bash\n(?: {12}.*\n)*/,
    ''));
  assert.equal(result.ok, false, '没有 tool-bash 行（手术对象缺席）必须被拦');
});

test('validate-preset：toolName 写错（async_wait_agent 写成 async_run）必须拦住', async () => {
  const result = await validateMutation((text) => text
    .replace('toolName: async_wait_agent', 'toolName: async_run'));
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => l.includes('重复') || l.includes('缺')),
    `报错必须指向判据④的缺值/重复，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
});

test('validate-preset：toolName 写成不存在的值必须拦住', async () => {
  const result = await validateMutation((text) => text
    .replace('toolName: async_agent', 'toolName: async_frobnicate'));
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => l.includes('toolName 五值缺')));
});

test('validate-preset：tool-pwsh 挂回来必须拦住（R6）', async () => {
  const result = await validateMutation((text) => text
    .replace("name: '@deepseek-ai/dsh-tool-bash'",
      "name: '@deepseek-ai/dsh-tool-bash'\n          - id: tool-pwsh-sneak\n            name: '@deepseek-ai/dsh-tool-pwsh'"));
  assert.equal(result.ok, false, '挂回 tool-pwsh 必须被拦（前台同步 shell 到期杀进程树）');
  assert.ok(result.lines.some((l) => l.includes('tool-pwsh')));
});

test('validate-preset：workflow-ptc 行被删必须拦住（定向修改 4 存在性）', async () => {
  // 删行 = workflow 引擎供电行（workflow-ptc）静默消失，预设丢编排引擎行为——
  // 否定式判据（"不含 worker-thread"）对此不红（两边都不含），必须靠存在性判据。
  const result = await validateMutation((text) => text.replace(
    / {14}- id: workflow-ptc\n(?: {16}.*\n)*/,
    ''));
  assert.equal(result.ok, false, '删 workflow-ptc 行必须被拦');
  assert.ok(result.lines.some((l) => l.includes('缺 workflow-ptc')),
    `报错必须点名手术 4 的存在性，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
});

test('validate-preset：tool-ralph 被翻回启用必须拦住（定向修改 5）', async () => {
  const result = await validateMutation((text) => text
    .replace("id: tool-ralph\n                name: '@deepseek-ai/dsh-tool-ralph'\n                disabled: true",
      "id: tool-ralph\n                name: '@deepseek-ai/dsh-tool-ralph'\n                disabled: false"));
  assert.equal(result.ok, false, 'tool-ralph 翻回启用必须被拦');
  assert.ok(result.lines.some((l) => l.includes('tool-ralph.disabled')),
    '报错必须指向 tool-ralph 的 disabled 项');
});

test('validate-preset：tool-plugin-manager 行被删必须拦住（定向修改 6 存在性）', async () => {
  const result = await validateMutation((text) => text.replace(
    / {10}- id: tool-plugin-manager\n(?: {12}.*\n)*/,
    ''));
  assert.equal(result.ok, false, '删 tool-plugin-manager 行必须被拦');
  assert.ok(result.lines.some((l) => l.includes('tool-plugin-manager')),
    '报错必须点名手术 6 的存在性');
});

test('validate-preset：persona 锚句被删必须拦住（含反恒真句）', async () => {
  // persona 的该句跨两行（never pass / run_in_background: false.），变异按
  // 折叠后仍存在的子串删——锚句 'never pass run_in_background: false' 随之消失。
  const result = await validateMutation((text) => text
    .replace('run_in_background: false.', ''));
  assert.equal(result.ok, false, '删锚句必须被拦');
  assert.ok(result.lines.some((l) => l.includes('never pass run_in_background: false')),
    '报错必须点名缺的那条锚句');
});

test('validate-preset：预设行重新带上 disabled 护栏必须拦住', async () => {
  // 护栏会在 agentPresets 服务就绪前把行静默杀死（loader refresh() 的 disabled 检查，
  // cordis-plugin-loader/lib/index.js:359-363），落成启动审计里的 "failed to import"。
  // 判据反转：护栏**存在**才是缺陷。
  const result = await validateMutation((text) => text
    .replace('    - id: preset-dsh-async\n', '    - id: preset-dsh-async\n      disabled: !!js "!ctx.get(\'agentPresets\')"\n'));
  assert.equal(result.ok, false, '护栏回归必须被拦');
  assert.ok(result.lines.some((l) => l.includes('不得带 disabled 护栏')));
});

test('validate-preset：YAML 语法坏了必须报解析失败而不是崩', async () => {
  const result = await validateMutation((text) => `${text}\n  - : : broken\n    - ]]);
`);
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => l.includes('解析失败')));
});

test('validate-preset：!!js 负表达式未加引号必须报解析失败', async () => {
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

test('validate-preset：删基线行 tool-cordis 必须拦住（P2，③ 缺行）', async () => {
  const result = await validateMutation((text) => text.replace(
    "          - id: tool-cordis\n            name: '@deepseek-ai/dsh-tool-cordis'\n", ''),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '基线行静默缺失必须被拦（R26「不得静默缺失」）');
  assert.ok(result.lines.some((l) => l.includes('tool-cordis') && l.includes('缺行')),
    `报错必须点名缺的基线行，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
});

test('validate-preset：多出基线期望之外的行必须拦住（P3，③ 多行）', async () => {
  const result = await validateMutation((text) => text
    .replace("          - id: tool-cordis\n",
      "          - id: tool-web-extra\n            name: '@deepseek-ai/dsh-tool-web'\n          - id: tool-cordis\n"),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '未经设计裁决的加行必须被拦');
  assert.ok(result.lines.some((l) => l.includes('tool-web-extra') && l.includes('多出')),
    '报错必须点名多出的行');
});

test('validate-preset：tool-subagent 翻回启用必须拦住（P4，⑧ 裁决 A 结构性差异）', async () => {
  const result = await validateMutation((text) => text
    .replace("              - id: tool-subagent\n                name: '@deepseek-ai/dsh-tool-subagent'\n                disabled: true\n",
      "              - id: tool-subagent\n                name: '@deepseek-ai/dsh-tool-subagent'\n"),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '派生入口翻活必须被拦（async_agent 是唯一入口）');
  assert.ok(result.lines.some((l) => l.includes('tool-subagent.disabled')),
    '报错必须指向 ⑧ 的 disabled 项');
});

test('validate-preset：tool-plugin-manager 写回表达式必须拦住（P5，⑧ 布尔差异）', async () => {
  const result = await validateMutation((text) => text
    .replace("          - id: tool-plugin-manager\n            name: '@deepseek-ai/dsh-plugin-manager/tools'\n            disabled: true",
      "          - id: tool-plugin-manager\n            name: '@deepseek-ai/dsh-plugin-manager/tools'\n            disabled: !!js \"!ctx.get('profileContext')\""),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, 'R26 明文要求布尔 true（与 dsh-async 补丁一致的手术）');
  assert.ok(result.lines.some((l) => l.includes('tool-plugin-manager.disabled') && l.includes('布尔 true')),
    '报错必须指向布尔差异并区分表达式');
});

test('validate-preset：persona 唯一入口锚句被删必须拦住（P6，⑤）', async () => {
  const result = await validateMutation((text) => text
    .replace('async_agent is the ONLY delegation\n                entry in this preset', 'the delegation\n                entry in this preset'),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '删锚句必须被拦');
  assert.ok(result.lines.some((l) => l.includes('ONLY delegation entry')),
    '报错必须点名缺的那条锚句');
});

test('validate-preset：tool-pwsh 挂回创造补丁必须拦住（P7，③b）', async () => {
  const result = await validateMutation((text) => text
    .replace("name: '@deepseek-ai/dsh-tool-bash'",
      "name: '@deepseek-ai/dsh-tool-bash'\n          - id: tool-pwsh-sneak\n            name: '@deepseek-ai/dsh-tool-pwsh'"),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '挂回 tool-pwsh 必须被拦（前台同步 shell 到期杀进程树）');
  assert.ok(result.lines.some((l) => l.includes('tool-pwsh')));
});

test('validate-preset：tool-bash 改平台表达式必须拦住（P8，②）', async () => {
  const result = await validateMutation((text) => text
    .replace("          - id: tool-bash\n            name: '@deepseek-ai/dsh-tool-bash'\n            disabled: true",
      "          - id: tool-bash\n            name: '@deepseek-ai/dsh-tool-bash'\n            disabled: !!js process.platform === 'win32'"),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '平台表达式必须被拦（R20 静态侧：Linux 也要无条件禁用）');
  assert.ok(result.lines.some((l) => l.includes('tool-bash.disabled') && l.includes('布尔 true')));
});

test('validate-preset：config.id 改成无期望集的值必须拦住（P9，①）', async () => {
  const result = await validateMutation((text) => text
    .replace('id: dsh-async-create', 'id: dsh-async-frobnicate'),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '未知 config.id 不许"套不上就放行"');
  assert.ok(result.lines.some((l) => l.includes('没有对应期望集')),
    '报错必须点名期望集缺失');
});

test('validate-preset：创造补丁预设行加护栏必须拦住（P10，⑥）', async () => {
  const result = await validateMutation((text) => text
    .replace('    - id: preset-dsh-async-create\n', '    - id: preset-dsh-async-create\n      disabled: !!js "!ctx.get(\'agentPresets\')"\n'),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '护栏回归必须被拦');
  assert.ok(result.lines.some((l) => l.includes('不得带 disabled 护栏')));
});

test('validate-preset：活 subagent × async_agent 且缺锚句必须触发互斥判据（P11，⑦）', async () => {
  // 复合变异：subagent 翻活（⑧ 红）+ 删一句锚——⑦ 按句独立开火，两个分支各验一次，
  // 证明可验证段④的条件式守卫真的会开火（不是只有 ⑤⑧ 在兜）。
  const enableSubagent = (text) => text
    .replace("              - id: tool-subagent\n                name: '@deepseek-ai/dsh-tool-subagent'\n                disabled: true\n",
      "              - id: tool-subagent\n                name: '@deepseek-ai/dsh-tool-subagent'\n");
  const entryRemoved = await validateMutation((text) => enableSubagent(text)
    .replace('async_agent is the ONLY delegation\n                entry in this preset', 'the delegation\n                entry in this preset'),
    PATCH_CREATE, baselineCreate);
  assert.equal(entryRemoved.ok, false);
  assert.ok(entryRemoved.lines.some((l) => l.includes('唯一派生入口') && l.includes('需求 §3.1 可验证口径')),
    '⑦ 的入口专报必须在场');
  const retrievalRemoved = await validateMutation((text) => enableSubagent(text)
    .replace('wait with async_wait_agent', 'get results via async_wait_agent'),
    PATCH_CREATE, baselineCreate);
  assert.equal(retrievalRemoved.ok, false);
  assert.ok(retrievalRemoved.lines.some((l) => l.includes('取回通道') && l.includes('需求 §3.1 可验证口径')),
    '⑦ 的取回专报必须在场');
});

test('validate-preset：删嵌套行 plan-mode 必须拦住（P12，③ 嵌套缺行）', async () => {
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

test('validate-preset：创造补丁 toolName 写错必须拦住（P13，④）', async () => {
  const result = await validateMutation((text) => text
    .replace('toolName: async_agent', 'toolName: async_frobnicate'),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => l.includes('toolName 五值缺')));
});

test('validate-preset：期望集必须与 shipped 基线的真实行集合逐条比对（P14，防快照漂移）', async () => {
  const { load } = await loadYaml();
  for (const { configId, baselineFile, baselineName } of RECONCILE) {
    if (baselineFile === undefined || !existsSync(baselineFile)) {
      assert.fail(`P14 对账依赖的基线补丁读不到：@deepseek-ai/dsh-web-app/presets/${baselineName}（期望集 ${configId} 的出处就是它）。候选锚 = DSAT_HOST_MODULES → DSH_HOME/profiles → %APPDATA%/npm 全局树；CI 上由 npm install @deepseek-ai/dsh@0.2.0-rc.2 提供。锚缺失不许静默跳过。`);
    }
    const doc = load(readFileSync(baselineFile, 'utf8'));
    const exp = EXPECTATIONS[configId];
    assert.deepEqual(exp.baselineTop, expectedTopFromBaseline(doc),
      `${configId} 的 baselineTop 必须等于「真实基线 − tool-pwsh + 四行 async（插在 tool-bash 后）」；上游改动基线时这里先红，强迫重建期望集（更新入口）`);
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
    // **config 正文**逐行对账——手术集之外的每个叶子行与组行必须与真实基线
    // 深度一致（递归键序规范化后比对；disabled 单列在手术范围外剔除）。手术清单外改一个字
    // 必须红：只有行 id 比对的判据拦不住 plan-mode 段的措辞漂移。
    const surgery = new Set(exp.disabledBoolean); // 手术范围 = 结构性禁用行 + persona（前缀重写）；
    surgery.add('persona');
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
      // → **必须保留**；叶子行的 disabled **不剥**（手术集外的行连 disabled
      // 面也必须与基线一致——基线 codex/claude-code 的 disabled: true 两侧本就逐字）。
      isGroup ? { ...row, config: undefined } : { ...row }
    ));
    const bodyDiffs = [];
    for (const [id, row] of fromBaseline.leaf) {
      if (surgery.has(id) || id === 'tool-pwsh') continue; // pwsh 行按手术不挂；async 行只在补丁侧
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
      `${configId} 手术清单之外的行必须与真实基线逐字一致；差异：${bodyDiffs.join(' | ')}`);
    // 反向对照：手术外叶子行的 config 改一个字，同一比较器必须报出来（防恒真）。
    const driftBase = JSON.parse(stripSurgery(fromPatch.leaf.get('tool-fs-search'), false));
    driftBase.config.sampleOverCapGlobResults = true;
    assert.notEqual(JSON.stringify(driftBase), stripSurgery(fromBaseline.leaf.get('tool-fs-search'), false),
      'config 正文比较器必须能检出单字段漂移');
    //  反向对照：手术外叶子行**误加 disabled** 也必须被同一比较器报出来
    // ——disabled 项不许是盲区。（dsh-async 的 tool-subagent 本就按手术禁用，
    // 该行走 ⑧⑩ 的结构性判据；本对照只证比较器对 disabled 差异敏感。）
    const wrongDisable = JSON.parse(stripSurgery(fromPatch.leaf.get('tool-subagent'), false));
    wrongDisable.disabled = true;
    assert.notEqual(JSON.stringify(wrongDisable), stripSurgery(fromBaseline.leaf.get('tool-subagent'), false),
      'disabled 项比较器必须能检出补丁行与基线行的 disabled 差异');
  }
});

test('validate-preset：组内行重复必须拦住', async () => {
  // 重复行不产生缺行/多行（两个 id 都在期望集里）——靠长度比对与行序比对抓住。
  const result = await validateMutation((text) => text
    .replace("              - id: compaction-basic\n                name: '@deepseek-ai/dsh-compaction-basic'\n",
      "              - id: compaction-basic\n                name: '@deepseek-ai/dsh-compaction-basic'\n              - id: compaction-basic\n                name: '@deepseek-ai/dsh-compaction-basic'\n"),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '组内重复行必须被拦（重复的行都在期望集里，缺/多行判据抓不住）');
  assert.ok(result.lines.some((l) => l.includes('嵌套行数应为')),
    '报错必须指向嵌套行数判据');
});

test('validate-preset：组内行换序必须拦住', async () => {
  const result = await validateMutation((text) => text
    .replace("              - id: tool-subagent-control\n                name: '@deepseek-ai/dsh-tool-subagent-control'\n              - id: tool-subagent-list-agents\n",
      "              - id: tool-subagent-list-agents\n                name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'\n              - id: tool-subagent-control\n"),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '组内行换序必须被拦（基线行序是「逐项按序」承诺的一半）');
  assert.ok(result.lines.some((l) => l.includes('嵌套行序与基线期望不一致')),
    '报错必须指向嵌套行序判据');
});

test('validate-preset：workflow-ptc 的 provider 改掉必须拦住（P15，⑨；两份补丁都守）', async () => {
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

test('validate-preset：两份补丁的公共异步纪律段必须逐字同源（P16，设计 §3.6）', async () => {
  const { load } = await loadYaml();
  const readPrefix = async (path) => {
    const doc = load(readFileSync(path, 'utf8'));
    return doc[0].insert[0].config.plugins.find((child) => child?.id === 'persona').config.prefix;
  };
  const introAsync = commonIntro(await readPrefix(PATCH));
  const introCreate = commonIntro(await readPrefix(PATCH_CREATE));
  assert.equal(introAsync, introCreate,
    '公共段（This deployment…failure. 整段）必须逐字相同——分叉只许发生在 DELEGATION RULES 段');
  // 反向对照：改掉一份的公共段，比较器必须真的能发现（否则上面的相等断言是恒真的）。
  const mutatedIntro = introCreate.replace('ASYNCHRONOUSLY', 'ASYNCHRONOUSLY.');
  assert.notEqual(mutatedIntro, introAsync, '比较器必须能检出公共段漂移');
});

// ══════════════════ 第五行工具与禁用手术的判据（P17–P21）════════════════════════

test('validate-preset：tool-workflow 翻回启用必须拦住（P17，⑧，R35-b；两份都守）', async () => {
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

test('validate-preset：dsh-async 的 tool-subagent 翻回启用必须拦住（P18，⑧，R35-c）', async () => {
  const result = await validateMutation((text) => text
    .replace("              - id: tool-subagent\n                name: '@deepseek-ai/dsh-tool-subagent'\n                disabled: true\n",
      "              - id: tool-subagent\n                name: '@deepseek-ai/dsh-tool-subagent'\n"));
  assert.equal(result.ok, false, 'dsh-async 的宿主单发委托入口翻活必须被拦（R35-c）');
  assert.ok(result.lines.some((l) => l.includes('tool-subagent.disabled')),
    '报错必须指向 ⑧ 的 disabled 项');
});

test('validate-preset：删 async-workflow 行必须拦住（P19，③/④，R35-a；两份都守）', async () => {
  for (const [path, text] of [[PATCH, baseline], [PATCH_CREATE, baselineCreate]]) {
    const result = await validateMutation((t) => t
      .replace(/ {14}- id: async-workflow\n(?: {16}.*\n)*/, ''), path, text);
    assert.equal(result.ok, false, `删第五行必须被拦（${path}）`);
    assert.ok(result.lines.some((l) => (l.includes('async-workflow') && l.includes('缺行')) || l.includes('toolName 五值缺')),
      `报错必须点名 ③ 嵌套缺行或 ④ 缺值，实得：${result.lines.filter((l) => l.includes('FAIL')).join(' | ')}`);
  }
});

test('validate-preset：async-workflow 挪出 delegation 组必须拦住（P20，④ 行位，设计 §3.6）', async () => {
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

test('validate-preset：workflow-ptc 行删掉必须拦住（P21，⑨，R34 供电；create 侧）', async () => {
  const result = await validateMutation((text) => text.replace(
    / {14}- id: workflow-ptc\n(?: {16}.*\n)*/, ''),
    PATCH_CREATE, baselineCreate);
  assert.equal(result.ok, false, '删 workflow-ptc 行必须被拦（async_workflow 的引擎供电行）');
  assert.ok(result.lines.some((l) => l.includes('缺 workflow-ptc')),
    '报错必须点名 ⑨ 的存在性');
});

test('validate-preset：async_workflow 门槛锚句被删必须拦住（P22，⑪，R34-h）', async () => {
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
