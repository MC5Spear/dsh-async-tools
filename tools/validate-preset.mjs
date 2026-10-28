/**
 * 预设补丁校验（判据按 config.id 参数化；每条都能红）。
 *
 * 校验对象是 `presets/` 下的预设补丁。两套期望按 `config.id`
 * 切换：`dsh-async`（基线 = shipped standard 补丁）与 `dsh-async-create`
 * （基线 = shipped cordis 补丁）。解析必须走 dsh 自己的方言：补丁里有 `!!js`
 * 标签（skill-filesystem 的 customSkillDirs），普通 YAML 解析器会报未知标签；这里从
 * 宿主包树按真实路径 import 宿主自带的 js-yaml 并注册同一形状的自定义 `js` 类型
 * （`!!js` 表达式解析为**字符串**，这正好让"disabled 必须是布尔"这类判据可区分）。
 *
 * 十四条判据（③b、⑤b、⑧b 各独立计一条；骨架两套共用、期望随套切换）：
 * 1. 补丁恰一条 `insert`，行 `name` 是 `@deepseek-ai/dsh-agent-preset`，行 `id` 与
 *    `config.id` 等于期望集的 `rowId` / `configId`；未知 `config.id` 即红（不许
 *    "套不上就放行"）；
 * 2. 子清单里 `tool-bash` 行 `disabled === true` 且**不是**平台表达式（静态判据）；
 * 3. 顶层行 id 序列与嵌套行 id 序列同期望集 `baselineTop` / `baselineNested`
 *    **逐项按序**比对——缺一即红、多一行也红、顺序错也红（"不得静默缺失"；
 *    嵌套序列含 delegation 组内 `async-workflow` 行）；
 * 3b. 子清单不含期望集 `forbidden` 的行名（pwsh 禁入；worker-thread 缺席）；
 * 4. 恰六行 `dsh-async-tools`（顶层五行 + delegation 组内第六行），`toolName` 恰为
 *    六值且无重复；顶层第五行是只读查询行 `async_list_subagent_models`（需求
 *    §2.3.4），delegation 组内行钉在组内 `tool-workflow` 行后（行位判据：
 *    workflowEngine 是组内隔离服务，挪出组必红）；
 * 5. persona `prefix` 与宿主基线身份句**逐字一致**（任何增改即红——宿主原生
 *    身份句不承载本包内容，执行纪律走运行时 section，见 ⑤b）；
 * 5b. 纪律锚句改挂两语表：`lib/text.js` 的 `discipline.preset.<config.id>` 键
 *     在 en／zh 两档都必须含期望集 `disciplineAnchors` 的每条锚句——委托纪律
 *     五句（一律后台、唯一委托入口、有界等待取回、变体差异句、不循环轮询；
 *     差异句 dsh-async 为 `never pass run_in_background: false`（en）／「绝不要
 *     传」句（zh），create 为「已禁用、不要调用」句）+ 提问角色纪律四组锚词
 *     （ASK-01，人称代词禁用 / 明确角色名称 / 角色加动作 / 指向一致，两套同值）
 *     ——语言档由 agentLang 管理（需求 §5.3），zh 档锚句必须与 en 档语义同源；
 * 6. 预设行**不得**出现 `disabled` 护栏（护栏会在 agentPresets 就绪前把行静默杀死，
 *    cordis-plugin-loader/lib/index.js:359-363）；
 * 7. 互斥判据（期望集 `bothAliveRule` 开时；两套都开）：活 `tool-subagent`
 *    行与 `async_agent` 行同时在场 ⇒ 纪律词典键（en 档）必须写明唯一派生入口
 *    与取回通道，否则红；
 * 8. 期望集 `disabledBoolean` 列的每行必须在场且布尔 `disabled: true`（两套同为
 *    四行：tool-bash / tool-subagent / tool-subagent-fork / tool-workflow——插件
 *    管理两行走 ⑧b；0.2.1 基线已无 codex / claude-code / ralph 行）；
 * 8b. 插件管理两行（`tool-plugin-manager` / `tool-plugin-market`）的 `disabled`
 *     与各自基线禁用形态逐字同形：dsh-async（standard 基线）两行布尔 `true`；
 *     dsh-async-create（cordis 基线）两行 `!ctx.get('profileContext')` 表达式
 *     字符串——改布尔或改表达式必红（需求 §3.1、§7.3.2：创造上下文中插件管理
 *     入口在场，不得锁死）；
 * 9. `workflow-ptc` 行在场且 `config.provider === 'spawn'`（形态守卫 + 供电）；
 * 10. 禁用行 `tool-subagent` / `tool-subagent-fork` 的 config 键值逐字锁死
 *     （删键/改值/加键必红）；
 * 11. `lib/text.js` 两档 `tool.workflow.p2` 都含指向 `async_agent` 的门槛锚句
 *     （删句必红）。
 *
 * 用法：node tools/validate-preset.mjs [补丁文件]。无参 = 依次校验两份补丁，任一失败
 * 即非零退出；带参 = 只校验那一份。
 *
 * 也可作为模块导入：`validatePatch(patchPath, { quiet })` 返回 `{ ok, failures, lines }`，
 * `loadYaml()` / `EXPECTATIONS` 一并导出——`test/preset.test.mjs` 用它们在**进程内**跑
 * 变异副本（子进程 spawn 在沙箱里会被 EPERM 拦，且进程内调用让"变异 → 断言红"同轮完成），
 * 并把期望集与真实基线补丁对账（防快照漂移）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { candidateModules } from './_host-resolve.mjs';
import { t } from '../lib/text.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 宿主 js-yaml 的候选路径：基目录**复用 `tools/_host-resolve.mjs` 的候选表**
 * （`DSAT_HOST_MODULES` → `DSH_HOME/profiles/node_modules` → npm 全局嵌套树）——
 * 树根只许有一个来源，本文件不自带第二份候选表（check-junctions 的
 * TREE_CONSUMERS 对账要求消费方必须经 `_host-resolve`/`_local-config` 取锚）。
 *
 * 每个基目录下认**两种布局**：
 *   - **提升形** `<base>/js-yaml/index.js`——npm 装 `@deepseek-ai/dsh` 时把依赖提升到
 *     node_modules 根；CI 的 `npm install @deepseek-ai/dsh@0.2.1-rc.3` 就是这一种；
 *   - **嵌套形** `<base>/@deepseek-ai/dsh/node_modules/js-yaml/index.js`——全局安装树
 *     与运行树的形状（自带一份嵌套副本）。
 * 只认嵌套形会让「干净环境 + npm 锚」的预设用例整片全红（实测 35 条失红），
 * 而本机开发树两种都在，所以这个缺口在开发机上永远看不见。
 */
const HOST_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const candidates = candidateModules(HOST_HOME).flatMap((base) => [
  join(base, 'js-yaml', 'index.js'),
  join(base, '@deepseek-ai', 'dsh', 'node_modules', 'js-yaml', 'index.js')
]);

/** 惰性加载宿主 js-yaml（带 !!js 自定义类型）。失败抛错，由调用方决定呈现。 */
export async function loadYaml() {
  const yamlPath = candidates.find((path) => existsSync(path));
  if (yamlPath === undefined) {
    throw new Error(`找不到宿主的 js-yaml；试过：\n  ${candidates.join('\n  ')}`);
  }
  const YAML = (await import(pathToFileURL(yamlPath).href)).default;
  const JsType = new YAML.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => data
  });
  return { load: (text) => YAML.load(text, { schema: YAML.DEFAULT_SCHEMA.extend([JsType]) }) };
}

/** 五行顶层 async 工具行在基线行序列里的插入位：紧跟 `tool-bash`（改动位）。 */
const ASYNC_ROW_IDS = ['async-run', 'async-wait-job', 'async-wait-agent', 'async-agent', 'async-list-models'];
/** toolName 六值（判据④：顶层五行 + delegation 组内第六行 async_workflow）。 */
const EXPECTED_TOOL_NAMES = ['async_run', 'async_wait_job', 'async_wait_agent', 'async_agent', 'async_list_subagent_models', 'async_workflow'];

/** 嵌套行序列（两基线同构：planning 1 + compaction 3 + delegation 6；0.2.1 基线
 * 的 delegation 组不再挂 codex / claude-code / ralph 行；组在 tool-workflow 行后
 * 多一行 async-workflow——行位判据）。 */
const NESTED_ROWS = [
  'plan-mode',
  'compaction-basic', 'command-compact', 'tool-result-pruner',
  'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork',
  'workflow-ptc', 'tool-workflow', 'async-workflow'
];

/** 禁用行 config 逐字期望（键与值都锁死——删键/改值必红；与 0.2.1 基线同形，
 * 无 backgroundMode 键）。 */
const SUBAGENT_CONFIG_VERBATIM = {
  'tool-subagent': {
    provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true
  },
  'tool-subagent-fork': {
    provider: 'fork', toolName: 'subagent_fork'
  }
};

/** 插件管理两行（⑧b 判据对象）。 */
const PLUGIN_ROWS = ['tool-plugin-manager', 'tool-plugin-market'];

/** cordis 基线的插件管理禁用表达式（`!!js` 在本校验器里解析出的字符串形态）。 */
const PROFILE_CONTEXT_EXPR = "!ctx.get('profileContext')";

/** 提问角色纪律四组锚词（ASK-01 四要素，两套期望集同值；锚句必须选新增文本
 * 独有的短语——纪律文案里其余段落不含这四个短语）。en／zh 各一组，zh 与 en
 * 语义同源（语言档由 agentLang 管理，需求 §5.3）。 */
const ASK_ANCHORS = [
  'no personal pronouns for the actor, authorizer, or owner',
  'explicit, distinguishable role names',
  'role plus the action',
  'keep role references consistent'
];
const ASK_ANCHORS_ZH = [
  '不使用指代执行者、授权者或归属对象的人称代词',
  '明确、可区分的角色名称',
  '写清角色与动作',
  '与所选角色名称保持一致'
];

/** 宿主基线 persona 身份句（shipped standard/cordis 补丁逐字同源）——预设
 * prefix 与它逐字一致，任何增改即红（宿主原生身份句不承载本包内容）。 */
const BASELINE_IDENTITY = 'You are a coding agent powered by the {{model}} model.';

/**
 * 期望集：`baselineTop` 是**改动后**的顶层行 id 序列（基线 − tool-pwsh +
 * 五行 async，插在 tool-bash 之后）；`expectedTopFromBaseline()` 从真实基线
 * 补丁反推并对账，改这里必须同时过那条用例。
 */
export const EXPECTATIONS = {
  'dsh-async': {
    rowId: 'preset-dsh-async',
    configId: 'dsh-async',
    patchRel: join('presets', 'dsh-async.patch.yml'),
    baselineTop: [
      'persona', 'agent-instructions', 'time-context', 'tool-bash',
      ...ASYNC_ROW_IDS,
      'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-schedule', 'skill-filesystem', 'tool-skill',
      'command-goal', 'tool-goal',
      'planning', 'compaction', 'delegation',
      'tool-ask-user', 'tool-todo', 'tool-web', 'present', 'tool-plugin-manager', 'tool-plugin-market'
    ],
    baselineNested: NESTED_ROWS,
    disabledBoolean: ['tool-bash', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow'],
    pluginRowsDisabled: true,
    forbidden: ['@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-workflow-worker-thread'],
    personaBaselineIdentity: true,
    disciplineAnchors: {
      en: [
        'ALWAYS',
        'async_agent is the ONLY delegation entry',
        'wait with async_wait_agent',
        'never pass run_in_background: false',
        'Do not poll in a loop',
        ...ASK_ANCHORS
      ],
      zh: [
        '一律在后台',
        '唯一的委托入口',
        '用 async_wait_agent 有界等待',
        '绝不要传 run_in_background: false',
        '不要循环轮询',
        ...ASK_ANCHORS_ZH
      ]
    },
    workflowPtcProvider: 'spawn',
    bothAliveRule: true
  },
  'dsh-async-create': {
    rowId: 'preset-dsh-async-create',
    configId: 'dsh-async-create',
    patchRel: join('presets', 'dsh-async-create.patch.yml'),
    baselineTop: [
      'persona', 'agent-instructions', 'time-context', 'tool-bash',
      ...ASYNC_ROW_IDS,
      'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-schedule',
      'command-goal', 'tool-goal',
      'planning', 'compaction', 'delegation',
      'tool-ask-user', 'tool-todo', 'tool-web', 'tool-cordis',
      'skill-filesystem', 'tool-skill', 'present', 'tool-plugin-manager', 'tool-plugin-market'
    ],
    baselineNested: NESTED_ROWS,
    disabledBoolean: [
      'tool-bash', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow'
    ],
    pluginRowsDisabled: PROFILE_CONTEXT_EXPR,
    forbidden: ['@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-workflow-worker-thread'],
    personaBaselineIdentity: true,
    disciplineAnchors: {
      en: [
        'ALWAYS',
        'async_agent is the ONLY delegation entry',
        'wait with async_wait_agent',
        'disabled here; do not call them',
        'Do not poll in a loop',
        ...ASK_ANCHORS
      ],
      zh: [
        '一律在后台',
        '唯一的委托入口',
        '用 async_wait_agent 有界等待',
        '已禁用，不要调用',
        '不要循环轮询',
        ...ASK_ANCHORS_ZH
      ]
    },
    workflowPtcProvider: 'spawn',
    bothAliveRule: true
  }
};

/**
 * 从一份真实 shipped 基线补丁的解析结果反推改动后的顶层行序列（对账用）：
 * 去掉 tool-pwsh，在 tool-bash 之后插入五行 async。
 * @param {object} doc - 基线补丁的解析结果（一条 insert 一行）。
 * @returns {string[]} 改动后的顶层行 id 序列。
 */
export function expectedTopFromBaseline(doc) {
  const baselineIds = doc[0].insert[0].config.plugins.map((child) => child?.id);
  const withoutPwsh = baselineIds.filter((id) => id !== 'tool-pwsh');
  const bashIndex = withoutPwsh.indexOf('tool-bash');
  if (bashIndex === -1) throw new Error('基线补丁没有 tool-bash 行（插入位无从谈起）');
  return [...withoutPwsh.slice(0, bashIndex + 1), ...ASYNC_ROW_IDS, ...withoutPwsh.slice(bashIndex + 1)];
}

/**
 * 校验一份预设补丁（判据同文件头；期望集按 config.id 自选）。
 * @param {string} patchPath - 补丁文件路径。
 * @param {object} [options] - `{ quiet, expectation }`：静默模式不打印；expectation
 *   显式指定时期望集不按 config.id 自选（变异用例把 config.id 改坏时仍能对原套断言）。
 * @returns {{ ok: boolean, failures: number, lines: string[] }} 校验结果。
 */
export async function validatePatch(patchPath, { quiet = false, expectation } = {}) {
  const lines = [];
  const emit = (line) => { lines.push(line); if (!quiet) console.log(line); };
  let failures = 0;
  const fail = (message) => { const line = `      FAIL  ${message}`; lines.push(line); if (!quiet) console.error(line); failures++; };

  if (!existsSync(patchPath)) {
    fail(`补丁不存在：${patchPath}`);
    return { ok: false, failures, lines };
  }

  let doc;
  try {
    doc = (await loadYaml()).load(readFileSync(patchPath, 'utf8'));
  } catch (error) {
    fail(`补丁解析失败 → ${error.message}`);
    return { ok: false, failures, lines };
  }
  emit(`OK    解析：${patchPath}`);

  // ── ① 一条 insert、一行预设声明、期望集选定 ────────────────────────────
  if (!Array.isArray(doc) || doc.length !== 1 || !Array.isArray(doc[0]?.insert) || doc[0].insert.length !== 1) {
    fail(`补丁应恰为一条 insert、一行；实得 ${JSON.stringify(doc).slice(0, 120)}…`);
    return { ok: false, failures, lines };
  }
  const row = doc[0].insert[0];
  const configId = row?.config?.id;
  const exp = expectation ?? EXPECTATIONS[configId];
  if (exp === undefined) {
    fail(`config.id "${String(configId)}" 没有对应期望集（合法值：${Object.keys(EXPECTATIONS).join(', ')}）——期望集不存在即红，不许"套不上就放行"`);
    return { ok: false, failures, lines };
  }
  if (row.id !== exp.rowId) fail(`行 id 应为 "${exp.rowId}"，实为 ${JSON.stringify(row.id)}`);
  if (row.name !== '@deepseek-ai/dsh-agent-preset') fail(`行 name 应为 "@deepseek-ai/dsh-agent-preset"，实为 ${JSON.stringify(row.name)}`);
  emit(`OK    ① 一条 insert 一行：${String(row.id)} / ${String(row.name)} / config.id=${String(configId)}`);

  const plugins = Array.isArray(row.config?.plugins) ? row.config.plugins : [];
  if (plugins.length === 0) fail('config.plugins 为空或缺失');
  emit(`OK    子清单 ${String(plugins.length)} 行`);

  const groupRows = plugins.filter((child) => Array.isArray(child?.config));
  const nestedRows = groupRows.flatMap((child) => child.config);
  const allRows = [...plugins, ...nestedRows];

  // ── ② tool-bash 无条件禁用（布尔，不是表达式） ───────────────────────
  const toolBash = plugins.find((child) => child?.id === 'tool-bash');
  if (toolBash === undefined) {
    fail('子清单没有 tool-bash 行（改动对象缺席）');
  } else if (toolBash.disabled !== true) {
    // `!!js` 表达式在这里是字符串 ⇒ 平台表达式与布尔可区分。
    fail(`tool-bash.disabled 必须是布尔 true（无条件禁用），实为 ${JSON.stringify(toolBash.disabled)}`);
  } else {
    emit('OK    ② tool-bash 无条件 disabled: true');
  }

  // ── ③ 顶层/嵌套行序列与基线期望逐项按序比对（缺一即红、多一行也红、换序/重复也红） ──
  const actualTop = plugins.map((child) => child?.id);
  const expectedTop = exp.baselineTop;
  const missingTop = expectedTop.filter((id) => !actualTop.includes(id));
  const extraTop = actualTop.filter((id) => !expectedTop.includes(id));
  if (missingTop.length > 0) fail(`顶层行与基线期望（${exp.configId}）比对缺行：${missingTop.join(', ')}（基线行不得静默缺失）`);
  if (extraTop.length > 0) fail(`顶层行多出基线期望之外的行：${extraTop.join(', ')}（加行须经设计决定并改期望集）`);
  const firstDiffTop = actualTop.findIndex((id, index) => id !== expectedTop[index]);
  if (missingTop.length === 0 && extraTop.length === 0 && firstDiffTop !== -1) {
    fail(`顶层行序与基线期望不一致：第 ${String(firstDiffTop + 1)} 行期望 ${String(expectedTop[firstDiffTop])}，实为 ${String(actualTop[firstDiffTop])}（cordis 基线的行序与 standard 不同）`);
  }
  const actualNested = nestedRows.map((child) => child?.id);
  const missingNested = exp.baselineNested.filter((id) => !actualNested.includes(id));
  const extraNested = actualNested.filter((id) => !exp.baselineNested.includes(id));
  if (missingNested.length > 0) fail(`嵌套行与基线期望比对缺行：${missingNested.join(', ')}（组内行不得静默缺失）`);
  if (extraNested.length > 0) fail(`嵌套行多出基线期望之外的行：${extraNested.join(', ')}`);
  if (actualNested.length !== exp.baselineNested.length) {
    fail(`嵌套行数应为 ${String(exp.baselineNested.length)}，实得 ${String(actualNested.length)}（组内行重复也会在这里红）`);
  }
  const firstDiffNested = actualNested.findIndex((id, index) => id !== exp.baselineNested[index]);
  if (missingNested.length === 0 && extraNested.length === 0 && firstDiffNested !== -1) {
    fail(`嵌套行序与基线期望不一致：第 ${String(firstDiffNested + 1)} 行期望 ${String(exp.baselineNested[firstDiffNested])}，实为 ${String(actualNested[firstDiffNested])}`);
  }
  if (missingTop.length === 0 && extraTop.length === 0 && firstDiffTop === -1
    && missingNested.length === 0 && extraNested.length === 0 && firstDiffNested === -1) {
    emit(`OK    ③ 顶层 ${String(actualTop.length)} 行 + 嵌套 ${String(actualNested.length)} 行与基线期望逐项按序一致`);
  }

  // ── ③b 禁入行名（pwsh 禁入；worker-thread 缺席） ────────────────────────
  for (const moduleName of exp.forbidden) {
    if (allRows.some((child) => child?.name === moduleName)) {
      fail(`子清单不得含 ${moduleName}${moduleName.includes('worker-thread') ? '（禁入的替代行）' : '（前台同步 shell 到期杀进程树）'}`);
    }
  }

  // ── ④ 六行 dsh-async-tools（顶层五行 + delegation 组内一行），toolName 六值各一；
  //      顶层第五行是只读查询行 async_list_subagent_models（需求 §2.3.4）；
  //      delegation 组内行必须钉在组内 tool-workflow 行后（行位判据：
  //      workflowEngine 是组内隔离服务，组外行 ctx.get 恒 miss——挪出组必红） ──
  const asyncRows = allRows.filter((child) => child?.name === 'dsh-async-tools');
  const actualToolNames = asyncRows.map((child) => child?.config?.toolName).filter((v) => typeof v === 'string');
  const dupToolNames = actualToolNames.filter((v, index) => actualToolNames.indexOf(v) !== index);
  if (asyncRows.length !== 6) fail(`期望恰 6 行 dsh-async-tools（顶层 5 + delegation 组内 1），实得 ${String(asyncRows.length)}`);
  for (const expected of EXPECTED_TOOL_NAMES) {
    if (!actualToolNames.includes(expected)) fail(`toolName 六值缺 "${expected}"（实得 ${actualToolNames.join(', ') || '(无)'}）`);
  }
  if (dupToolNames.length > 0) fail(`toolName 有重复：${dupToolNames.join(',')}`);
  // 归属声明（设计 §6.2）：六行必须各自携带 owningPreset 且等于本补丁的 config.id
  // ——描述警示按行归属判定，漏声明＝警示对预设行静默消失，此处锁死。
  if (!asyncRows.every((child) => child?.config?.owningPreset === configId)) {
    fail(`六行 dsh-async-tools 的 owningPreset 必须全部等于 "${String(configId)}"（描述警示按行归属判定）`);
  }
  // 行位：查询行必须在顶层（组外行消费的都是宿主全局服务，进组反而对编排
  // 会话外不可见）；delegation 组内行在嵌套序列里紧跟 tool-workflow。
  const listModelsRow = plugins.find((child) => child?.name === 'dsh-async-tools' && child?.config?.toolName === 'async_list_subagent_models');
  if (listModelsRow === undefined) {
    fail('async_list_subagent_models 行必须在顶层（它只消费宿主全局服务，不进 delegation 组）');
  }
  const workflowAsyncRow = nestedRows.find((child) => child?.name === 'dsh-async-tools' && child?.config?.toolName === 'async_workflow');
  if (workflowAsyncRow === undefined) {
    fail('async_workflow 行必须落进组内（delegation 的 config 里）——组外顶层行取不到组内隔离的 workflowEngine');
  } else if (workflowAsyncRow.id !== 'async-workflow') {
    fail(`async_workflow 行的行 id 应为 "async-workflow"，实为 ${JSON.stringify(workflowAsyncRow.id)}`);
  } else {
    const wfIdx = actualNested.indexOf('tool-workflow');
    const awIdx = actualNested.indexOf('async-workflow');
    if (wfIdx === -1 || awIdx !== wfIdx + 1) {
      fail(`async-workflow 行必须紧跟 tool-workflow 行（tool-workflow 在嵌套序列第 ${String(wfIdx + 1)} 位，async-workflow 在第 ${String(awIdx + 1)} 位）——行位判据`);
    }
  }
  if (asyncRows.length === 6 && dupToolNames.length === 0 && workflowAsyncRow !== undefined && listModelsRow !== undefined) {
    emit(`OK    ④ 六行 dsh-async-tools（toolName：${actualToolNames.join(', ')}，owningPreset=${String(configId)}），async_list_subagent_models 在顶层，async_workflow 钉在 delegation 组内 tool-workflow 行后`);
  }

  // ── ⑤ persona prefix 与宿主基线身份句逐字一致（增改即红——身份句不承载
  //      本包内容，执行纪律走运行时 section） ───────────────────────────
  const personaRow = plugins.find((child) => child?.id === 'persona');
  const prefix = typeof personaRow?.config?.prefix === 'string' ? personaRow.config.prefix : '';
  if (prefix !== BASELINE_IDENTITY) {
    fail(`persona prefix 必须与宿主基线身份句逐字一致（任何增改即红；本包执行纪律由宿主半边的 systemPrompt section 运行时注入，设计 §3.6），实为：${JSON.stringify(prefix)}`);
  } else {
    emit('OK    ⑤ persona prefix 与基线身份句逐字一致');
  }

  // ── ⑤b 纪律锚句（两语表两档；删任一句必红） ─────────────────────────────
  // 文案住在 lib/text.js 的 discipline.preset.<configId>（宿主半边按 agentLang
  // 现读、按目标会话预设选变体，设计 §3.6）——zh 档锚句与 en 档语义同源。
  let disciplineOk = true;
  for (const lang of ['en', 'zh']) {
    const disciplineText = t(lang, `discipline.preset.${String(configId)}`);
    for (const anchor of exp.disciplineAnchors[lang]) {
      if (!disciplineText.includes(anchor)) {
        fail(`discipline.preset.${String(configId)}（${lang} 档）缺强制规则锚句：${JSON.stringify(anchor)}`);
        disciplineOk = false;
      }
    }
  }
  if (disciplineOk) emit(`OK    ⑤b 纪律锚句齐全（discipline.preset.${String(configId)}，en/zh 两档）`);

  // ── ⑥ 预设行不得带 disabled 护栏 ──
  // loader 的 refresh() 在服务就绪前求值 disabled：`!ctx.get('agentPresets')` 为真
  // 时静默跳过 init，行永远不导入、审计报 "failed to import"。等待由 dsh-agent-preset
  // 自带的 inject=['agentPresets'] 原生承接；注册失败沿 fiber 抛出时可选行只是启动警告。
  if (row.disabled !== undefined) {
    fail(`预设行不得带 disabled 护栏（会在 agentPresets 就绪前杀死行；实为 ${JSON.stringify(row.disabled)}）`);
  } else {
    emit('OK    ⑥ 预设行无 disabled 护栏（inject 等待是原生机制）');
  }

  // ── ⑦ 互斥判据（bothAliveRule 开时）：活 subagent × async_agent ──
  // ⇒ 纪律文案（en 档）必须写明唯一派生入口与取回通道。对交付态的 create
  // 补丁，⑧ 已把 subagent 结构性禁用，本判据不会触发；它守的是"翻活（重新启用）subagent 却不改
  // 纪律文案"的回归。
  if (exp.bothAliveRule) {
    const liveSubagent = allRows.find((child) => child?.id === 'tool-subagent' && child?.disabled !== true);
    const hasAsyncAgent = asyncRows.some((child) => child?.config?.toolName === 'async_agent');
    if (liveSubagent !== undefined && hasAsyncAgent) {
      const disciplineEn = t('en', `discipline.preset.${String(configId)}`);
      const hasEntry = disciplineEn.includes('async_agent is the ONLY delegation entry');
      const hasRetrieval = disciplineEn.includes('wait with async_wait_agent');
      if (!hasEntry) fail('活 tool-subagent 行与 async_agent 行同时在场，纪律段必须写明唯一派生入口（async_agent is the ONLY delegation entry）——需求 §3.1 可验证口径');
      if (!hasRetrieval) fail('活 tool-subagent 行与 async_agent 行同时在场，纪律段必须写明取回通道（wait with async_wait_agent）——需求 §3.1 可验证口径');
      if (hasEntry && hasRetrieval) emit('OK    ⑦ 互斥判据触发并通过（活 tool-subagent × async_agent：纪律段已写明唯一派生入口与取回通道）');
    } else {
      emit('OK    ⑦ 互斥判据未触发（tool-subagent 行禁用中——结构性唯一入口在位，条件式守卫待翻活时接管）');
    }
  } else {
    emit('OK    ⑦ 互斥判据对本期望集关闭（两套期望集都对双入口声明 bothAlive；此分支按防御性处理，正常不应到达）');
  }

  // ── ⑧ disabledBoolean：每行在场且布尔禁用（结构性禁用判据） ────────────────
  let disabledBooleanOk = true;
  for (const rowId of exp.disabledBoolean) {
    const target = allRows.find((child) => child?.id === rowId);
    if (target === undefined) {
      fail(`子清单缺 ${rowId} 行（行按基线保留，只置 disabled）`);
      disabledBooleanOk = false;
    } else if (target.disabled !== true) {
      fail(`${rowId}.disabled 必须是布尔 true，实为 ${JSON.stringify(target.disabled)}`);
      disabledBooleanOk = false;
    }
  }
  if (disabledBooleanOk) {
    emit(`OK    ⑧ ${String(exp.disabledBoolean.length)} 行结构性禁用（布尔 true）：${exp.disabledBoolean.join(', ')}`);
  }

  // ── ⑧b 插件管理两行与各自基线禁用形态逐字同形 ──────────────────────────
  // standard 基线两行布尔禁用；cordis 基线两行 profileContext 条件表达式——
  // 创造上下文（profileContext 在场）中插件管理与市场入口按基线启用，换成布尔
  // 禁用会把入口整个锁死（需求 §3.1、§7.3.2）。`!!js` 表达式解析为字符串，
  // 布尔与表达式在此可区分——改任一侧必红。
  let pluginRowsOk = true;
  for (const rowId of PLUGIN_ROWS) {
    const target = allRows.find((child) => child?.id === rowId);
    if (target === undefined) {
      fail(`子清单缺 ${rowId} 行（基线行不得静默缺失）`);
      pluginRowsOk = false;
    } else if (target.disabled !== exp.pluginRowsDisabled) {
      fail(`${rowId}.disabled 必须与基线禁用形态逐字同形（${exp.configId} 基线 = ${JSON.stringify(exp.pluginRowsDisabled)}），实为 ${JSON.stringify(target.disabled)}`);
      pluginRowsOk = false;
    }
  }
  if (pluginRowsOk) {
    emit(`OK    ⑧b 插件管理两行与基线禁用形态逐字同形（${exp.configId}：disabled = ${JSON.stringify(exp.pluginRowsDisabled)}）`);
  }

  // ── ⑨ workflow-ptc 在场且 provider === 'spawn'（形态守卫） ────────────────
  const workflowPtc = allRows.find((child) => child?.id === 'workflow-ptc');
  if (workflowPtc === undefined) {
    fail('子清单缺 workflow-ptc 行（worker-thread 的替代行）');
  } else if (workflowPtc?.config?.provider !== exp.workflowPtcProvider) {
    fail(`workflow-ptc.config.provider 应为 ${JSON.stringify(exp.workflowPtcProvider)}，实为 ${JSON.stringify(workflowPtc?.config?.provider)}`);
  } else {
    emit(`OK    ⑨ workflow-ptc 在场且 provider === ${JSON.stringify(exp.workflowPtcProvider)}（供电行）`);
  }

  // ── ⑩ 禁用行 config 逐字（翻活已由 ⑧ 红；此处锁死 config 键值——
  //      删键/改值必红；两份补丁同款检查） ──
  let verbatimOk = true;
  for (const [rowId, expectedConfig] of Object.entries(SUBAGENT_CONFIG_VERBATIM)) {
    const target = allRows.find((child) => child?.id === rowId);
    if (target === undefined) { fail(`子清单缺 ${rowId} 行（⑩ 逐字检查无从谈起）`); verbatimOk = false; continue; }
    const actualConfig = target.config ?? {};
    const expectedKeys = Object.keys(expectedConfig);
    const actualKeys = Object.keys(actualConfig);
    const missing = expectedKeys.filter((key) => !(key in actualConfig));
    const extra = actualKeys.filter((key) => !(key in expectedConfig));
    const changed = expectedKeys.filter((key) => key in actualConfig && actualConfig[key] !== expectedConfig[key]);
    if (missing.length > 0) { fail(`${rowId} 禁用行的 config 缺键：${missing.join(', ')}（逐字判据）`); verbatimOk = false; }
    if (extra.length > 0) { fail(`${rowId} 禁用行的 config 多出键：${extra.join(', ')}（逐字判据）`); verbatimOk = false; }
    if (changed.length > 0) {
      const detail = changed.map((key) => `${key}: ${JSON.stringify(expectedConfig[key])} → ${JSON.stringify(actualConfig[key])}`).join('; ');
      fail(`${rowId} 禁用行的 config 键值漂移：${detail}（逐字判据）`);
      verbatimOk = false;
    }
  }
  if (verbatimOk) emit('OK    ⑩ tool-subagent / -fork 禁用行 config 逐字（键值零漂移）');

  // ── ⑪ async_workflow 描述门槛锚句（两档文案都必须指向
  //      async_agent 作一两个委托的出路——删句必红） ─────────────────────
  let thresholdOk = true;
  for (const lang of ['en', 'zh']) {
    const p2 = t(lang, 'tool.workflow.p2', { defaultYieldMs: 0 });
    if (!p2.includes('async_agent')) {
      fail(`lib/text.js 的 tool.workflow.p2（${lang} 档）缺门槛锚句（应指向 async_agent 作一两个委托的出路）`);
      thresholdOk = false;
    }
  }
  if (thresholdOk) emit('OK    ⑪ async_workflow 门槛锚句在场（en/zh 两档）');

  if (failures > 0) {
    const line = `预设补丁校验失败（${exp.configId}）：${String(failures)} 项。`;
    lines.push(line); if (!quiet) console.error(`\n${line}`);
    return { ok: false, failures, lines };
  }
  const line = `预设补丁校验通过（${exp.configId}）。`;
  lines.push(line); if (!quiet) console.log(`\n${line}`);
  return { ok: true, failures: 0, lines };
}

// CLI 入口（被 node 直接执行时才跑；被 import 时静默导出）。无参 = 两份补丁都校验。
const invokedDirectly = process.argv[1] !== undefined
  && existsSync(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // resolve 而不是 join：绝对路径参数必须原样生效（join 会把绝对路径拼坏）。
  const patchPaths = process.argv[2]
    ? [resolve(process.cwd(), process.argv[2])]
    : Object.values(EXPECTATIONS).map((exp) => join(ROOT, exp.patchRel));
  let allOk = true;
  for (const patchPath of patchPaths) {
    const result = await validatePatch(patchPath);
    if (!result.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}
