/**
 * 预设补丁校验（判据按 config.id 参数化；每条都能红；期望集按宿主锚版本分档）。
 *
 * 校验对象是 `presets/` 下的预设补丁。两套期望按 `config.id` 切换：`dsh-async`
 * （基线 = shipped standard 补丁）与 `dsh-async-create`（基线 = shipped cordis
 * 补丁）。解析必须走 dsh 自己的方言：补丁里有 `!!js` 标签（skill-filesystem 的
 * customSkillDirs、tool-office 的 disabled 探测），普通 YAML 解析器会报未知标签；
 * 这里从宿主包树按真实路径 import 宿主自带的 js-yaml 并注册同一形状的自定义
 * `js` 类型（`!!js` 表达式解析为**字符串**，这正好让"disabled 必须是布尔"这类
 * 判据可区分）。
 *
 * ## 宿主锚分档（设计 §7.4.5；0.2.2-rc.1／rc.2／rc.3 三版同包）
 *
 * 锚版本从 `_host-resolve` 候选树（`DSAT_HOST_MODULES` → `DSH_HOME/profiles` →
 * npm 全局嵌套树）的 `@deepseek-ai/dsh` 包清单读取（退而 `dsh-subagent`，两者
 * 都按 name 核对，防误读安装根清单），经 `lib/host-contract.js` 的
 * `compareVersions` 以 `0.2.2-rc.2` 为界二分：小于 → `rc1` 档（rc.1；服务契约
 * 嵌套形态），大于等于 → `rc2` 档（rc.2 与 rc.3 基线逐字节相同、同档；扁平
 * 形态）。读不到版本或版本不可解析 → 明确报错、退出非零，不许"套不上就放行"。
 *
 * 分档原则：与基线的对账判据（③ 顶层行序、⑧b 插件管理两行、⑤ persona）在两
 * 档各自与**该档基线**比对；本包设计分歧 D1/D2/D4 的锚串逐字锁死、两档相同
 * （补丁是单份静态文件）；D3/D5 是"不随迁"分歧，判据验证本补丁不含该键。两档
 * 期望值当前多处重合——standard 身份句两档同串、dsh-async 顶层序列经 D4 插入
 * 后两档同序列、插件管理两行两档同形——重合是被对账证明过的事实
 * （`reconcileBaseline` 在每档基线上独立证明，上游任一档漂移时按档先红），不
 * 是省略分档的理由。
 *
 * ## 条件适配分歧 D1–D5（设计 §7.4.9；判据落点）
 *
 * - D1（两补丁，⑫）：skill-filesystem 行 `config.customSkillDirs` 的 `!!js`
 *   表达式串**逐字锚**。rc.2+ standard 基线有此键、rc.1 standard 基线无——本
 *   包统一携带（cordis 基线 rc.1 起即同式携带，键与被引用包三版在场）。rc1 档
 *   dsh-async 相对其基线多此键是登记分歧：判据只锁表达式串逐字，不做"与基线
 *   差异"判断。
 * - D2（create 补丁，⑤）：persona `prefix` 逐字等于两句锚串（首句身份句＋
 *   `You help the user customize DeepSeek Harness itself.`）。rc2 档与 rc.2+
 *   cordis 基线同形；rc1 档较其基线多第二句为登记分歧，同上只锁逐字——单份
 *   补丁回落单句同样红。dsh-async 补丁的 ⑤ 维持与**该档** standard 基线身份句
 *   逐字一致（当前两档同串，见期望集注释）。
 * - D3（两补丁，⑬）：tool-subagent-control 行**不得**携带 `config`——含
 *   `interrupt: false` 在内的任何键都红（rc.2+ 基线此行有 `interrupt: false`，
 *   随迁会撤下 interrupt_agent 注册；需求 §3.1 要求保留宿主非阻塞的检查、消息
 *   和停止管理，不能机械复制会隐藏所需入口的配置）。rc.1 基线此行本就无
 *   config，两档判据相同（无 config 键或 config 为空均可）。
 * - D4（仅 dsh-async 补丁，⑭＋③）：tool-office 行必须在场、位置钉在 `present`
 *   行之后，`disabled` 必须是在场性探测表达式**逐字锚**（一个 IIFE：先
 *   createRequire(baseUrl) 解析 `@deepseek-ai/dsh/package.json`，再从该位置解
 *   析 `@deepseek-ai/dsh-tool-office/package.json`，成功 false／异常 true；探测
 *   失败形态＝禁用，失效安全）。rc1 档基线顶层无此行——③ 的期望顶层序列 =
 *   rc.1 基线序列 + present 后插入 tool-office（登记分歧：对账打印
 *   DESIGNED-DELTA，不红也不静默放过）；rc2 档基线 present 后本就有此行，正常
 *   对账。create 补丁（cordis 基线）两档均无 office 行，⑭ 不挂、挂入由 ③ 拦。
 * - D5（无独立补丁行判据）：rc.2+ 本包两预设内隐藏原生 wait_agent 的处理在代
 *   码侧（agent/created 的 restrict、按预设身份判定，lib/index.js）；预设补丁
 *   层面它的面与 D3 同一处——控制行零 config（无按工具关闭键可表达），③ 的
 *   多行判据看守不多挂任何替代行。
 *
 * 十八条判据（③b、⑤b、⑤c、⑧b 各独立计一条；骨架两套共用、期望随套与档切
 * 换；⑫⑬⑭ 为 0.2.2 双档线新增）：
 * 1. 补丁恰一条 `insert`，行 `name` 是 `@deepseek-ai/dsh-agent-preset`，行 `id`
 *    与 `config.id` 等于期望集的 `rowId` / `configId`；未知 `config.id` 即红（不许
 *    "套不上就放行"）；
 * 2. 子清单里 `tool-bash` 行 `disabled === true` 且**不是**平台表达式（静态判据）；
 * 3. 顶层行 id 序列与嵌套行 id 序列同期望集**该档** `tiers.<档>.baselineTop` /
 *    `baselineNested` **逐项按序**比对——缺一即红、多一行也红、顺序错也红（"不得
 *    静默缺失"；嵌套序列含 delegation 组内 `async-workflow` 行；dsh-async 两档的
 *    期望顶层序列都含 tool-office——rc1 档为 D4 登记插入、rc2 档随基线）；
 * 3b. 子清单不含期望集 `forbidden` 的行名（pwsh 禁入；worker-thread 缺席）；
 * 4. 恰五行 `dsh-async-tools`（顶层四行 + delegation 组内第五行），`toolName` 恰为
 *    五值且无重复；顶层第四行是只读查询行 `async_list_subagent_models`（需求
 *    §2.3.4），delegation 组内行钉在组内 `tool-workflow` 行后（行位判据：
 *    workflowEngine 是组内隔离服务，挪出组必红）；
 * 5. persona `prefix` 逐字锚（任何增改即红——宿主原生身份句不承载本包内容，执
 *    行纪律走运行时 section，见 ⑤b）：dsh-async 与**该档** standard 基线身份句
 *    逐字一致（两档同串）；create 为 D2 固定两句锚（两档同串，rc1 档较其基线多
 *    第二句为登记分歧——判据只锁逐字，不做"与基线差异"判断）；
 * 5b. 纪律锚句改挂两语表：`lib/text.js` 的 `discipline.preset.<config.id>` 键
 *     在 en／zh 两档都必须含期望集 `disciplineAnchors` 的每条锚句——委托纪律
 *     五句（一律后台、唯一委托入口、有界等待取回、变体差异句、不循环轮询；
 *     差异句 dsh-async 为 `never pass run_in_background: false`（en）／「绝不要
 *     传」句（zh），create 为「已禁用、不要调用」句）+ 提问角色纪律四组锚词
 *     （ASK-01，人称代词禁用 / 明确角色名称 / 角色加动作 / 指向一致，两套同值）
 *     ——语言档由 agentLang 管理（需求 §5.3），zh 档锚句必须与 en 档语义同源；
 * 5c. 通用纪律锚句（VERIFY-GENERIC-01）：`discipline.preset.generic` 的 en/zh
 *     两档每档须含通用锚句表（后台创建／不传 `run_in_background: false`／
 *     直接交付／有界等待／不循环轮询＋提问角色四组，ASK 与内置同值）的每一条
 *     ——不随期望集切换，随每份补丁校验各执行一次（无参 CLI 重复输出属预期）；
 *     「唯一入口」不设通用锚（通用变体按 §3.5.4 不声称宿主入口已禁用）；
 * 6. 预设行**不得**出现 `disabled` 护栏（护栏会在 agentPresets 就绪前把行静默杀死，
 *    cordis-plugin-loader/lib/index.js:359-363）；
 * 7. 互斥判据（期望集 `bothAliveRule` 开时；两套都开）：活 `tool-subagent`
 *    行与 `async_agent` 行同时在场 ⇒ 纪律词典键（en 档）必须写明唯一派生入口
 *    与取回通道，否则红；
 * 8. 期望集 `disabledBoolean` 列的每行必须在场且布尔 `disabled: true`（两套同为
 *    四行：tool-bash / tool-subagent / tool-subagent-fork / tool-workflow——插件
 *    管理两行走 ⑧b；0.2.2 基线沿用无 codex / claude-code / ralph 的形态，且
 *    delegation 组不再挂 tool-subagent-list-agents 行）；
 * 8b. 插件管理两行（`tool-plugin-manager` / `tool-plugin-market`）的 `disabled`
 *     与**该档基线**禁用形态**按行**逐字同形（两档基线此两行同形，对账按档核
 *     对）：dsh-async（standard 基线）manager 行 `!ctx.get('profileContext')`
 *     表达式字符串＋market 行布尔 `true`；dsh-async-create（cordis 基线）两行均
 *     为表达式字符串——改布尔或改表达式必红（需求 §3.1、§7.3.2：创造上下文中
 *     插件管理入口在场，不得锁死）；
 * 9. `workflow-ptc` 行在场且 `config.provider === 'spawn'`（形态守卫 + 供电）；
 * 10. 禁用行 `tool-subagent` / `tool-subagent-fork` 与基线随迁行 `tool-fs` 的
 *     config 键值逐字锁死（删键/改值/加键必红；tool-fs 的 `applyPatch: false`
 *     与 tool-subagent 的 `modelSelection`＋`modelDiscovery` 是 0.2.2 基线
 *     漂移的逐字锚）；
 * 11. `lib/text.js` 两档 `tool.workflow.p2` 都含指向 `async_agent` 的门槛锚句
 *     （删句必红）；
 * 12. ⑫ D1：skill-filesystem 行 config 恰含 `customSkillDirs` 一键、值为恰含
 *     D1 锚表达式的单元素列表（逐字符锚，改一字符即红；两补丁两档同判据）；
 * 13. ⑬ D3：tool-subagent-control 行在场且**零 config**（含 `interrupt: false`
 *     在内任何键都红——rc.2+ 基线该键不随迁，随迁会撤下 interrupt_agent 注册；
 *     两补丁两档同判据）；
 * 14. ⑭ D4：tool-office 行（仅 dsh-async）在场、`name` 正确、位置钉在 `present`
 *     行之后、`disabled` 与 D4 在场性探测表达式逐字相同、无 config 键（删行、
 *     挪位、改一字符、加 config 都红；两档同判据；create 的 cordis 基线两档均
 *     无 office 行，本判据对其关闭）。
 *
 * ## 对账（reconcileBaseline；CLI 与 test/preset.test.mjs 共用）
 *
 * 期望集与一份 shipped 基线补丁在**序列与行体**两层对账：顶层/嵌套序列由
 * `expectedTopFromBaseline` 从基线反推（去 tool-pwsh、tool-jobs 前移到 tool-bash
 * 后、插入四行顶层 async 工具；rc1 档另按 D4 在 present 后插入 tool-office）；
 * 行体按行深度比对（键序规范化；结构性禁用行单列在外）。条件适配分歧按
 * `DESIGNED_DELTAS` 注册表豁免并逐项打印 DESIGNED-DELTA 行——不红也不静默放
 * 过；豁免必须恰好用上注册表声明的各项：基线形态与档位不符（豁免用不上，或
 * 多出未登记分歧）都红。rc2 档**顶层序列**对账零登记差异（忠实随迁）；行体层
 * 的 D3/D4 分歧同样登记在表内（§7.4.9：D3/D4 的分歧方向本就是"较 rc.2+ 基线"）。
 *
 * 用法：node tools/validate-preset.mjs [补丁文件]。无参 = 依次校验两份补丁并对
 * 该档 shipped 基线对账，任一失败即非零退出；带参 = 只校验那一份（路径命中已
 * 登记补丁时同样对账）。
 *
 * 也可作为模块导入：`validatePatch(patchPath, { quiet, expectation, tier })` 返回
 * `{ ok, failures, lines }`（`tier` 注入时期望集按该档选定、不读锚树——双档变
 * 异测试用）；`reconcileBaseline(configId, { tier, baselineDoc, patchDoc, quiet })`
 * 返回 `{ ok, failures, lines, deltas }`；`loadYaml()` / `EXPECTATIONS` /
 * `GENERIC_DISCIPLINE_ANCHORS` / `expectedTopFromBaseline` / `DESIGNED_DELTAS` /
 * `tierForVersion` / `readAnchorHostVersion` / `resolveAnchorTier` 一并导出——
 * `test/preset.test.mjs` 用它们在**进程内**跑变异副本（子进程 spawn 在沙箱里会
 * 被 EPERM 拦，且进程内调用让"变异 → 断言红"同轮完成），并把期望集与两档基线
 * （真实锚档＋构造快照档）对账（防快照漂移）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { candidateModules } from './_host-resolve.mjs';
import { t } from '../lib/text.js';
import { compareVersions } from '../lib/host-contract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 宿主 js-yaml 的候选路径：基目录**复用 `tools/_host-resolve.mjs` 的候选表**
 * （`DSAT_HOST_MODULES` → `DSH_HOME/profiles/node_modules` → npm 全局嵌套树）——
 * 树根只许有一个来源，本文件不自带第二份候选表（check-junctions 的
 * TREE_CONSUMERS 对账要求消费方必须经 `_host-resolve`/`_local-config` 取锚）。
 *
 * 每个基目录下认**两种布局**：
 *   - **提升形** `<base>/js-yaml/index.js`——npm 装 `@deepseek-ai/dsh` 时把依赖提升到
 *     node_modules 根；CI 按支持集合逐宿主显式安装（`npm install @deepseek-ai/dsh@<精确宿主版本>`）就是这一种；
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

// ── 宿主锚分档（设计 §7.4.5；0.2.2-rc.1／rc.2／rc.3 三版同包）────────────────
//
// 锚版本从 _host-resolve 候选树的 @deepseek-ai/dsh（退而 dsh-subagent）包清单读
// 取，经 lib/host-contract.js 的 compareVersions 以 0.2.2-rc.2 为界二分。锚树与
// js-yaml 候选同一份表（树根单一来源）；读不到版本 → 报错，不许"套不上就放行"。

/** 分档边界（与 lib/host-contract.js 的 FLAT_BOUNDARY 同值；比较器同源）。 */
const TIER_BOUNDARY = '0.2.2-rc.2';
/** 锚版本清单可接受的包名（带 name 核对，防把安装根的 package.json 误当锚）。 */
const ANCHOR_VERSION_NAMES = new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-subagent']);

/**
 * 版本串 → 档位：小于 0.2.2-rc.2 → 'rc1'；大于等于 → 'rc2'（rc.2 与 rc.3 基线
 * 逐字节相同、同档）。任一不可解析（compareVersions 返回 NaN）→ 抛错。
 * @param {string} version
 * @returns {'rc1'|'rc2'}
 */
export function tierForVersion(version) {
  const comparison = compareVersions(version, TIER_BOUNDARY);
  if (Number.isNaN(comparison)) {
    throw new Error(`宿主锚版本不可解析：${JSON.stringify(version)}（分档边界 ${TIER_BOUNDARY}；比较器 lib/host-contract.js#compareVersions）——不许"套不上就放行"`);
  }
  return comparison < 0 ? 'rc1' : 'rc2';
}

/**
 * 从候选基目录表读宿主锚版本。每个基目录试三种清单位置（提升形 dsh／
 * dsh-subagent，及基目录本身即某包 node_modules 的上级清单），都按 name 核对。
 * @param {string[]} [bases] - 候选基目录（缺省 = _host-resolve 候选表）。
 * @returns {{ version: string, source: string }}
 * @throws {Error} 全部候选都读不到合格版本时。
 */
export function readAnchorHostVersion(bases = candidateModules(HOST_HOME)) {
  const tried = [];
  for (const base of bases) {
    for (const relative of [
      join('@deepseek-ai', 'dsh', 'package.json'),
      join('@deepseek-ai', 'dsh-subagent', 'package.json'),
      join('..', 'package.json')
    ]) {
      const manifestPath = join(base, relative);
      tried.push(manifestPath);
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (!ANCHOR_VERSION_NAMES.has(manifest?.name)) continue;
        if (typeof manifest?.version === 'string' && manifest.version.length > 0) {
          return { version: manifest.version, source: manifestPath };
        }
      } catch {
        // 坏清单不算锚——试下一个候选。
      }
    }
  }
  throw new Error(`读不到宿主锚版本（${TIER_BOUNDARY} 边界分档无从谈起；试过：\n  ${tried.join('\n  ')}）——不许"套不上就放行"`);
}

/** 记忆化锚档（进程内环境不变；测试注入档位时不经此函数）。 */
let memoAnchorTier;

/**
 * 解析当前环境的宿主锚档。
 * @returns {{ tier: 'rc1'|'rc2', version: string, source: string }}
 * @throws {Error} 读不到版本或版本不可解析时。
 */
export function resolveAnchorTier() {
  if (memoAnchorTier === undefined) {
    const { version, source } = readAnchorHostVersion();
    memoAnchorTier = { tier: tierForVersion(version), version, source };
  }
  return memoAnchorTier;
}

/** 四行顶层 async 工具行在基线行序列里的插入位：紧跟前移后的 `tool-jobs`（行位判据
 * 的既定形态——插入位保持稳定供对账；`job_output` 隐藏挂点在 `agent/created` 并按
 * 名册判定，与行序无关，见 lib/index.js 与设计 §3.5.1）。 */
const ASYNC_ROW_IDS = ['async-run', 'async-wait', 'async-agent', 'async-list-models'];
/** toolName 五值（判据④：顶层四行 + delegation 组内第五行 async_workflow；WAIT-01 合并等待入口）。 */
const EXPECTED_TOOL_NAMES = ['async_run', 'async_wait', 'async_agent', 'async_list_subagent_models', 'async_workflow'];

/** 嵌套行序列（两档基线同构：planning 1 + compaction 3 + delegation 5——rc.1 与
 * rc.2 基线仅 control 行 config 有无差异、行 id 序列逐项相同；0.2.2 基线的
 * delegation 组不再挂 tool-subagent-list-agents 行（随 rc.1 整行移除，与
 * codex / claude-code / ralph 的早前移除同理）；组在 tool-workflow 行后多一行
 * async-workflow——行位判据）。 */
const NESTED_ROWS = [
  'plan-mode',
  'compaction-basic', 'command-compact', 'tool-result-pruner',
  'tool-subagent-control', 'tool-subagent', 'tool-subagent-fork',
  'workflow-ptc', 'tool-workflow', 'async-workflow'
];

/** 禁用行 config 逐字期望（键与值都锁死——删键/改值必红；与 0.2.2 基线
 * 同形：tool-subagent 行的 config 键为 modelSelection＋modelDiscovery——旧键
 * modelSelectionSettings 在 0.2.2 宿主 Config 中不存在；无 backgroundMode 键）。 */
const SUBAGENT_CONFIG_VERBATIM = {
  'tool-subagent': {
    provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true
  },
  'tool-subagent-fork': {
    provider: 'fork', toolName: 'subagent_fork'
  }
};

/** 基线随迁行的 config 逐字期望（0.2.2 基线漂移：tool-fs 行新增
 * applyPatch: false——补丁写路径默认关闭；随基线逐字，键值漂移必红）。 */
const BASELINE_DRIFT_CONFIG_VERBATIM = {
  'tool-fs': {
    applyPatch: false
  }
};

/** 插件管理两行（⑧b 判据对象）。 */
const PLUGIN_ROWS = ['tool-plugin-manager', 'tool-plugin-market'];

/** cordis 基线的插件管理禁用表达式（`!!js` 在本校验器里解析出的字符串形态）。 */
const PROFILE_CONTEXT_EXPR = "!ctx.get('profileContext')";

/** 插件管理两行按基线分形的期望（两档基线此两行同形——rc.1 与 rc.2 的
 * standard／cordis 补丁这四行逐字相同；对账在两档基线上各自证明该重合）。 */
const STANDARD_PLUGIN_ROWS_DISABLED = {
  'tool-plugin-manager': PROFILE_CONTEXT_EXPR,
  'tool-plugin-market': true
};
const CORDIS_PLUGIN_ROWS_DISABLED = {
  'tool-plugin-manager': PROFILE_CONTEXT_EXPR,
  'tool-plugin-market': PROFILE_CONTEXT_EXPR
};

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

/** 通用纪律变体（`discipline.preset.generic`，判据 ⑤c／VERIFY-GENERIC-01）的
 * 强制锚句表：只取现行文案里的**指令式**句子——通用变体按设计 §3.5.4 不声称
 * 宿主入口已禁用，「唯一入口」句对自建组合不真实，故不设该锚；提问角色四组
 * 与内置期望集同值（ASKING RULES 段三变体逐字同文，ASK-01）。锚句只是
 * `includes` 判据，不向变体文本新增内容。 */
export const GENERIC_DISCIPLINE_ANCHORS = {
  en: [
    'Delegations are created with async_agent in the background',
    'never pass run_in_background: false',
    'delivered directly (attached to an in-flight async_wait return, or as a completion message)',
    'wait with async_wait',
    'Do not poll in a loop',
    ...ASK_ANCHORS
  ],
  zh: [
    '委托一律经 async_agent 在后台创建',
    '也不传 run_in_background: false',
    '结果正文直接交付',
    '需要子代理的结果时，用 async_wait',
    '不要循环轮询',
    ...ASK_ANCHORS_ZH
  ]
};

/** dsh-async 的 persona 身份句锚（standard 基线）。两档同串：rc.1 与 rc.2 的
 * standard 基线 persona 行同为该句（两树 standard.patch.yml 逐字核对）——按档
 * 分立登记（见 EXPECTATIONS），上游单档漂移时对账先红、此处跟随。 */
const STANDARD_IDENTITY = 'You are a coding agent powered by the {{model}} model.';
/** create 的 persona 两句锚（D2 固定锚，两档同串）：rc.2+ cordis 基线逐字（其
 * `>-` 折叠标量解析后的整串）；rc1 档较 rc.1 基线（单句）多第二句为登记分歧
 * ——判据只锁逐字，不做"与基线差异"判断。 */
const CREATE_IDENTITY = 'You are a coding agent powered by the {{model}} model. You help the user customize DeepSeek Harness itself.';

/** D1 锚：customSkillDirs 的 `!!js` 表达式串（两补丁同串、两档同串；rc.1 起的
 * cordis 基线与 rc.2+ 的 standard 基线均为该串——对账在两档基线上证明）。 */
const CUSTOM_SKILL_DIRS_EXPR = "process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')";

/** D4 锚：tool-office 行 disabled 的在场性探测表达式（YAML 双引号内的整串）。
 * IIFE 先 createRequire(baseUrl) 解析 `@deepseek-ai/dsh/package.json`（三版准入
 * 必在），再从该位置解析 `@deepseek-ai/dsh-tool-office/package.json`——成功
 * false（启用）／异常 true（禁用跳过）；探测失败形态＝禁用，失效安全。 */
const OFFICE_PROBE_EXPR = "(() => { try { const cr = process.getBuiltinModule('node:module').createRequire; const dshRoot = cr(baseUrl).resolve('@deepseek-ai/dsh/package.json'); cr(dshRoot).resolve('@deepseek-ai/dsh-tool-office/package.json'); return false } catch { return true } })()";

/** dsh-async 的顶层期望序列（**两档同序列**——重合是被对账证明的事实，不是省略
 * 分档的理由）：rc1 档 = rc.1 standard 基线 − tool-pwsh + tool-jobs 前移 + 四行
 * 顶层 async 工具 + tool-office（D4 登记插入，present 后）；rc2 档 = rc.2 基线
 * 同变换（present 后本就有 office 行）——两序列重合，reconcileBaseline 在两档
 * 基线上各自证明。 */
const STANDARD_TOP = [
  'persona', 'agent-instructions', 'time-context', 'tool-bash', 'tool-jobs',
  ...ASYNC_ROW_IDS,
  'tool-fs', 'tool-fs-search', 'tool-schedule', 'skill-filesystem', 'tool-skill',
  'command-goal', 'tool-goal',
  'planning', 'compaction', 'delegation',
  'tool-ask-user', 'tool-todo', 'tool-web', 'present', 'tool-office',
  'tool-plugin-manager', 'tool-plugin-market'
];

/** create 的顶层期望序列（**两档同序列**：rc.1 与 rc.2 的 cordis 基线顶层行序
 * 逐项相同——两档差异只在 persona 句数与 control 行 config，不涉行序）。 */
const CREATE_TOP = [
  'persona', 'agent-instructions', 'time-context', 'tool-bash', 'tool-jobs',
  ...ASYNC_ROW_IDS,
  'tool-fs', 'tool-fs-search', 'tool-schedule',
  'command-goal', 'tool-goal',
  'planning', 'compaction', 'delegation',
  'tool-ask-user', 'tool-todo', 'tool-web', 'tool-cordis',
  'skill-filesystem', 'tool-skill', 'present', 'tool-plugin-manager', 'tool-plugin-market'
];

/**
 * 期望集：判据③⑤⑧⑧b⑫⑬⑭ 读取 `tiers.<档>` 的按档期望；其余键档不变。
 * 每预设两档（'rc1'／'rc2'）当前值多处相同——相同是"对账在两档基线上证明过
 * 的重合"（见各键注释），上游任一档基线漂移时按档对账先红、期望集跟随重建。
 */
export const EXPECTATIONS = {
  'dsh-async': {
    rowId: 'preset-dsh-async',
    configId: 'dsh-async',
    patchRel: join('presets', 'dsh-async.patch.yml'),
    /** 对账用的 shipped 基线补丁名（@deepseek-ai/dsh-web-app/presets/ 下）。 */
    baselineId: 'standard',
    /** D4 适用（standard 基线 rc.2+ 有 tool-office 行、本补丁行在场）。 */
    officeRow: true,
    /** ⑤ 的锚形态：'baseline' = 与该档基线身份句逐字一致；'designed-d2' = D2 固定两句锚。 */
    personaAnchor: 'baseline',
    baselineNested: NESTED_ROWS,
    disabledBoolean: ['tool-bash', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow'],
    forbidden: ['@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-workflow-worker-thread'],
    disciplineAnchors: {
      en: [
        'ALWAYS',
        'async_agent is the ONLY delegation entry',
        'delivered directly',
        'wait with async_wait',
        'never pass run_in_background: false',
        'Do not poll in a loop',
        ...ASK_ANCHORS
      ],
      zh: [
        '一律在后台',
        '唯一的委托入口',
        '结果正文直接交付',
        '需要后台子代理的结果时用 async_wait',
        '绝不要传 run_in_background: false',
        '不要循环轮询',
        ...ASK_ANCHORS_ZH
      ]
    },
    workflowPtcProvider: 'spawn',
    bothAliveRule: true,
    tiers: {
      // 两档同值（rc.1 与 rc.2 的 standard 基线：插件管理两行逐字相同；身份句
      // 同串；顶层序列经 D4 插入后重合——对账在两档基线上各自证明）。
      rc1: {
        baselineTop: STANDARD_TOP,
        personaPrefix: STANDARD_IDENTITY,
        pluginRowsDisabled: STANDARD_PLUGIN_ROWS_DISABLED
      },
      rc2: {
        baselineTop: STANDARD_TOP,
        personaPrefix: STANDARD_IDENTITY,
        pluginRowsDisabled: STANDARD_PLUGIN_ROWS_DISABLED
      }
    }
  },
  'dsh-async-create': {
    rowId: 'preset-dsh-async-create',
    configId: 'dsh-async-create',
    patchRel: join('presets', 'dsh-async-create.patch.yml'),
    baselineId: 'cordis',
    /** cordis 基线两档均无 tool-office 行，⑭ 对本期望集关闭（挂入由 ③ 拦）。 */
    officeRow: false,
    personaAnchor: 'designed-d2',
    baselineNested: NESTED_ROWS,
    disabledBoolean: [
      'tool-bash', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow'
    ],
    forbidden: ['@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-workflow-worker-thread'],
    disciplineAnchors: {
      en: [
        'ALWAYS',
        'async_agent is the ONLY delegation entry',
        'delivered directly',
        'wait with async_wait',
        'disabled here; do not call them',
        'Do not poll in a loop',
        ...ASK_ANCHORS
      ],
      zh: [
        '一律在后台',
        '唯一的委托入口',
        '结果正文直接交付',
        '需要后台子代理的结果时用 async_wait',
        '已禁用，不要调用',
        '不要循环轮询',
        ...ASK_ANCHORS_ZH
      ]
    },
    workflowPtcProvider: 'spawn',
    bothAliveRule: true,
    tiers: {
      // 两档同值（cordis 基线：插件管理两行两档逐字相同；persona 为 D2 固定
      // 两句锚、不随档变；顶层序列两档本就相同）。
      rc1: {
        baselineTop: CREATE_TOP,
        personaPrefix: CREATE_IDENTITY,
        pluginRowsDisabled: CORDIS_PLUGIN_ROWS_DISABLED
      },
      rc2: {
        baselineTop: CREATE_TOP,
        personaPrefix: CREATE_IDENTITY,
        pluginRowsDisabled: CORDIS_PLUGIN_ROWS_DISABLED
      }
    }
  }
};

/**
 * 从一份真实 shipped 基线补丁的解析结果反推改动后的顶层行序列（对账用）：
 * 去掉 tool-pwsh，把 tool-jobs 前移到 tool-bash 之后，再在 tool-jobs 之后插入
 * 四行顶层 async 工具（ASYNC_ROW_IDS；编排行 async-workflow 在 delegation
 * 组内，不在顶层——见 NESTED_ROWS）。rc1 档另按 D4 在 present 之后插入
 * tool-office（rc.1 基线无此行、本包补丁行在场——登记差异，对账打印
 * DESIGNED-DELTA）；rc2 档基线 present 后本就有该行、不插入，若缺席则报
 * "意外"差异（档位与基线形态不符，由调用方红）。
 * @param {object} doc - 基线补丁的解析结果（一条 insert 一行）。
 * @param {'rc1'|'rc2'} tier - 档位（决定 tool-office 插入差异的登记口径）。
 * @param {object} [options] - `{ officeRow = true }`：期望序列是否含 tool-office
 *   （dsh-async true／create false——cordis 基线两档均无此行）。
 * @returns {{ top: string[], deltas: string[] }} 改动后的顶层行 id 序列与登记差异。
 */
export function expectedTopFromBaseline(doc, tier, { officeRow = true } = {}) {
  const baselineIds = doc[0].insert[0].config.plugins.map((child) => child?.id);
  const withoutPwsh = baselineIds.filter((id) => id !== 'tool-pwsh');
  const bashIndex = withoutPwsh.indexOf('tool-bash');
  if (bashIndex === -1) throw new Error('基线补丁没有 tool-bash 行（插入位无从谈起）');
  const rest = withoutPwsh.slice(bashIndex + 1);
  const jobsIndex = rest.indexOf('tool-jobs');
  if (jobsIndex === -1) throw new Error('基线补丁没有 tool-jobs 行（前移位无从谈起）');
  let top = [
    ...withoutPwsh.slice(0, bashIndex + 1),
    'tool-jobs',
    ...ASYNC_ROW_IDS,
    ...rest.slice(0, jobsIndex),
    ...rest.slice(jobsIndex + 1)
  ];
  const deltas = [];
  if (officeRow && !top.includes('tool-office')) {
    const presentIndex = top.indexOf('present');
    if (presentIndex === -1) throw new Error('基线补丁没有 present 行（tool-office 插入位无从谈起）');
    top = [...top.slice(0, presentIndex + 1), 'tool-office', ...top.slice(presentIndex + 1)];
    deltas.push(tier === 'rc1'
      ? D4_OFFICE_ROW_DELTA
      : 'D4(意外) tool-office 行缺席：rc2 档基线 present 后本就有此行——档位与基线形态不符');
  }
  return { top, deltas };
}

/** D4 的 rc1 档行级登记差异（expectedTopFromBaseline 的插入行与行体对账的
 * row-only 豁免共用同一串，保证对账两侧口径逐字一致）。 */
const D4_OFFICE_ROW_DELTA = 'D4 tool-office 行在场：rc.1 基线无此行（在场性条件装载，包缺席时行跳过）';

/**
 * 条件适配分歧注册表（设计 §7.4.9 D1–D4 中有补丁行对账面的各项；D5 无行面，
 * 见文件头）。每项 `{ id, kind, delta }`：对账时按 kind 豁免该行的对应差异面，
 * 并把 `delta` 计入登记差异清单——豁免必须恰好用上注册表声明的各项：基线
 * 形态与档位不符（豁免用不上）或多出未登记分歧都红。
 * kind 语义：'config'＝整块 config 不比（D1/D3）；'prefix'＝只豁免
 * config.prefix（D2——persona 行其余键仍比）；'disabled'＝只豁免 disabled 键
 * （D4 rc2 档）；'row-only'＝行仅在补丁侧、不与基线比行体（D4 rc1 档）。
 */
export const DESIGNED_DELTAS = {
  'dsh-async': {
    rc1: [
      { id: 'skill-filesystem', kind: 'config', delta: 'D1 skill-filesystem config.customSkillDirs：本补丁携带、rc.1 standard 基线无此键（统一携带，cordis 基线先例；表达式串另由 ⑫ 逐字锚）' },
      { id: 'tool-office', kind: 'row-only', delta: D4_OFFICE_ROW_DELTA }
    ],
    rc2: [
      { id: 'tool-subagent-control', kind: 'config', delta: 'D3 tool-subagent-control config.interrupt 不随迁：本补丁无 config、rc.2+ 基线有（保留 interrupt_agent 注册，需求 §3.1；另由 ⑬ 守卫）' },
      { id: 'tool-office', kind: 'disabled', delta: 'D4 tool-office 行 disabled 探测键：本补丁条件装载、rc.2+ 基线行裸（另由 ⑭ 逐字锚）' }
    ]
  },
  'dsh-async-create': {
    rc1: [
      { id: 'persona', kind: 'prefix', delta: 'D2 persona prefix 第二句：本补丁两句、rc.1 cordis 基线单句（用途陈述对 rc.1 同真；两句串另由 ⑤ 逐字锚）' }
    ],
    rc2: [
      { id: 'tool-subagent-control', kind: 'config', delta: 'D3 tool-subagent-control config.interrupt 不随迁：本补丁无 config、rc.2+ 基线有（保留 interrupt_agent 注册，需求 §3.1；另由 ⑬ 守卫）' }
    ]
  }
};

/** 递归键序规范化（行体比对与键序无关）。 */
function normalizeValue(value) {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeValue(value[key])]));
  }
  return value;
}

/**
 * 行体 → 规范化串（对账比较器）。组行只比 id/name/group/isolate（子行单独比）；
 * 叶子行保留 config 正文与 disabled 面，再按登记豁免剥除对应差异面。
 * @param {object} row - 行对象。
 * @param {boolean} isGroup - 是否组行。
 * @param {object[]} [exemptions] - 该行适用的登记豁免（DESIGNED_DELTAS 项）。
 */
function rowBodyKey(row, isGroup, exemptions = []) {
  const clone = { ...row };
  if (isGroup) {
    clone.config = undefined;
  } else {
    for (const { kind } of exemptions) {
      if (kind === 'config') clone.config = undefined;
      else if (kind === 'disabled') delete clone.disabled;
      else if (kind === 'prefix' && clone.config !== undefined) {
        clone.config = { ...clone.config, prefix: undefined };
      }
    }
  }
  return JSON.stringify(normalizeValue(clone));
}

/**
 * 期望集 × 真实基线补丁的双层对账（CLI 与 test/preset.test.mjs 共用；判据见文
 * 件头「对账」节）。序列层经 expectedTopFromBaseline 反推；行体层按行深度比对，
 * 条件适配分歧按 DESIGNED_DELTAS 注册表豁免并计入 `deltas`——豁免必须恰好用
 * 上注册表声明的各项（基线形态与档位不符都红）。
 * @param {string} configId - 期望集键（'dsh-async'｜'dsh-async-create'）。
 * @param {object} options - `{ tier, baselineDoc, patchDoc, quiet }`。
 * @returns {{ ok: boolean, failures: number, lines: string[], deltas: string[] }}
 */
export function reconcileBaseline(configId, { tier, baselineDoc, patchDoc, quiet = false }) {
  const lines = [];
  const emit = (line) => { lines.push(line); if (!quiet) console.log(line); };
  let failures = 0;
  const fail = (message) => { const line = `      FAIL  ${message}`; lines.push(line); if (!quiet) console.error(line); failures++; };
  const exp = EXPECTATIONS[configId];
  if (exp === undefined) throw new Error(`未知期望集：${String(configId)}（合法值：${Object.keys(EXPECTATIONS).join(', ')}）——不许"套不上就放行"`);
  const registered = DESIGNED_DELTAS[configId]?.[tier];
  if (registered === undefined) throw new Error(`未知档位：${String(tier)}（合法值：rc1, rc2）——不许"套不上就放行"`);
  emit(`对账：${configId} × ${exp.baselineId} 基线（${tier} 档）`);
  if (baselineDoc?.[0]?.insert?.[0]?.config?.id !== exp.baselineId) {
    fail(`基线补丁的 config.id 应为 "${exp.baselineId}"，实为 ${JSON.stringify(baselineDoc?.[0]?.insert?.[0]?.config?.id)}——基线文件与期望集错配`);
  }
  const patchDocId = patchDoc?.[0]?.insert?.[0]?.config?.id;
  if (patchDocId !== configId) {
    fail(`补丁的 config.id 应为 "${configId}"，实为 ${JSON.stringify(patchDocId)}——补丁文件与期望集错配`);
  }

  // ── 序列层：顶层（含 D4 登记插入）与嵌套 ─────────────────────────────────
  const { top: topFromBaseline, deltas: topDeltas } = expectedTopFromBaseline(baselineDoc, tier, { officeRow: exp.officeRow });
  const expectedTop = exp.tiers[tier].baselineTop;
  if (JSON.stringify(topFromBaseline) !== JSON.stringify(expectedTop)) {
    const missing = expectedTop.filter((id) => !topFromBaseline.includes(id));
    const extra = topFromBaseline.filter((id) => !expectedTop.includes(id));
    const firstDiff = topFromBaseline.findIndex((id, index) => id !== expectedTop[index]);
    fail(`顶层序列对账不一致（${configId}，${tier} 档）：基线反推 ${String(topFromBaseline.length)} 行 vs 期望 ${String(expectedTop.length)} 行${missing.length > 0 ? `；期望有而基线反推缺：${missing.join(', ')}` : ''}${extra.length > 0 ? `；基线反推多：${extra.join(', ')}` : ''}${firstDiff !== -1 ? `；首个错位：第 ${String(firstDiff + 1)} 行期望 ${String(expectedTop[firstDiff])}、基线 ${String(topFromBaseline[firstDiff])}` : ''}——上游改动基线时这里先红，强迫重建期望集（更新入口）`);
  }
  // 顶层登记差异：恰好 rc1 档 dsh-async 的 D4 插入行；rc2 档零差异（忠实随迁）。
  const expectedTopDeltas = exp.officeRow && tier === 'rc1' ? [D4_OFFICE_ROW_DELTA] : [];
  if (JSON.stringify(topDeltas) !== JSON.stringify(expectedTopDeltas)) {
    fail(`顶层序列登记差异与注册表不符（${configId}，${tier} 档）：期望 ${JSON.stringify(expectedTopDeltas)}，实得 ${JSON.stringify(topDeltas)}`);
  }

  const nestedFromBaseline = baselineDoc[0].insert[0].config.plugins
    .filter((child) => Array.isArray(child?.config))
    .flatMap((child) => child.config)
    .map((child) => child?.id);
  // 期望嵌套序列 = 真实基线 + async-workflow 插在 tool-workflow 行后
  // （delegation 组内第五行，设计 §3.6 行位）。基线侧不插、补丁侧不拔都先红。
  const wfIdx = nestedFromBaseline.indexOf('tool-workflow');
  const expectedNested = wfIdx === -1
    ? ['async-workflow', ...nestedFromBaseline]
    : [...nestedFromBaseline.slice(0, wfIdx + 1), 'async-workflow', ...nestedFromBaseline.slice(wfIdx + 1)];
  if (JSON.stringify(expectedNested) !== JSON.stringify(exp.baselineNested)) {
    fail(`嵌套序列对账不一致（${configId}，${tier} 档）：基线反推 ${JSON.stringify(expectedNested)} vs 期望 ${JSON.stringify(exp.baselineNested)}——上游改动基线时这里先红，强迫重建期望集（更新入口）`);
  }

  // ── 行体层：改动清单之外的每个叶子行与组行必须与基线深度一致（键序规范化
  //    后比对），登记分歧按注册表豁免。结构性禁用行（surgery）单列在外——
  //    它们由 ⑧⑩ 的结构性判据看守。────────────────────────────────────────
  const surgery = new Set(exp.disabledBoolean);
  const collect = (insertRow) => {
    const leaf = new Map(), group = new Map();
    const walk = (arr) => arr.forEach((child) => {
      if (Array.isArray(child?.config)) { group.set(child.id, child); walk(child.config); }
      else leaf.set(child.id, child);
    });
    walk(insertRow.config.plugins);
    return { leaf, group };
  };
  const fromBaseline = collect(baselineDoc[0].insert[0]);
  const fromPatch = collect(patchDoc[0].insert[0]);
  const applied = [...topDeltas];
  // 基线侧叶子行 → 补丁侧（缺行即红；行体差异在豁免面之外即红）。
  for (const [id, row] of fromBaseline.leaf) {
    if (surgery.has(id) || id === 'tool-pwsh') continue; // pwsh 行按改动不挂；async 行只在补丁侧
    const exemptions = registered.filter((entry) => entry.id === id && entry.kind !== 'row-only');
    const other = fromPatch.leaf.get(id);
    if (other === undefined) { fail(`${id} 仅在基线（基线行不得静默缺失）`); continue; }
    if (rowBodyKey(row, false, exemptions) !== rowBodyKey(other, false, exemptions)) {
      fail(`${id} 的行体与基线不一致（${configId}，${tier} 档；差异在登记豁免面之外）`);
    }
    applied.push(...exemptions.map((entry) => entry.delta));
  }
  // 补丁侧叶子行 → 基线侧（async 行与 row-only 登记行之外不得多行）。
  for (const id of fromPatch.leaf.keys()) {
    if (fromBaseline.leaf.has(id)) continue;
    if (id.startsWith('async-')) continue;
    const rowOnly = registered.find((entry) => entry.id === id && entry.kind === 'row-only');
    if (rowOnly !== undefined) { applied.push(rowOnly.delta); continue; }
    fail(`${id} 仅在补丁（加行须经设计决定并改期望集）`);
  }
  // 组行属性（子行已单独比）。
  for (const [id, row] of fromBaseline.group) {
    const other = fromPatch.group.get(id);
    if (other === undefined) { fail(`${id} 组行缺失`); continue; }
    if (rowBodyKey(row, true) !== rowBodyKey(other, true)) fail(`${id} 组行属性与基线不一致（${configId}，${tier} 档）`);
  }
  // 豁免恰好用上：实得登记差异 = 注册表声明（档位与基线形态不符时两侧失配）。
  const appliedSorted = [...new Set(applied)].sort();
  const registeredSorted = registered.map((entry) => entry.delta).sort();
  if (JSON.stringify(appliedSorted) !== JSON.stringify(registeredSorted)) {
    fail(`登记差异与注册表不符（${configId}，${tier} 档）：注册 ${JSON.stringify(registeredSorted)}，实得 ${JSON.stringify(appliedSorted)}——基线形态与档位不符，或出现未登记分歧`);
  } else if (appliedSorted.length > 0) {
    for (const delta of appliedSorted) emit(`DESIGNED-DELTA  ${delta}`);
  }

  if (failures > 0) {
    const line = `基线对账失败（${configId}，${tier} 档）：${String(failures)} 项。`;
    lines.push(line); if (!quiet) console.error(`\n${line}`);
    return { ok: false, failures, lines, deltas: appliedSorted };
  }
  const line = `基线对账通过（${configId}，${tier} 档${appliedSorted.length > 0 ? `；登记差异 ${String(appliedSorted.length)} 处` : '；登记差异零处——忠实随迁'}）。`;
  lines.push(line); if (!quiet) console.log(`\n${line}`);
  return { ok: true, failures: 0, lines, deltas: appliedSorted };
}

/**
 * 校验一份预设补丁（判据同文件头；期望集按 config.id 自选、期望值按档选定）。
 * @param {string} patchPath - 补丁文件路径。
 * @param {object} [options] - `{ quiet, expectation, tier }`：静默模式不打印；
 *   expectation 显式指定时期望集不按 config.id 自选（变异用例把 config.id 改坏
 *   时仍能对原套断言）；tier 显式指定时期望集按该档选定、不读锚树（双档变异
 *   测试用），缺省解析宿主锚档（读不到版本即红）。
 * @returns {{ ok: boolean, failures: number, lines: string[] }} 校验结果。
 */
export async function validatePatch(patchPath, { quiet = false, expectation, tier } = {}) {
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

  // ── ⓪ 宿主锚分档（设计 §7.4.5）：读不到版本即红，不许"套不上就放行" ──────
  if (tier !== undefined && tier !== 'rc1' && tier !== 'rc2') {
    fail(`未知档位 "${String(tier)}"（合法值：rc1, rc2）——注入档位也必须显式合法`);
    return { ok: false, failures, lines };
  }
  let anchor;
  if (tier === undefined) {
    try {
      anchor = resolveAnchorTier();
    } catch (error) {
      fail(`宿主锚分档失败 → ${error.message}`);
      return { ok: false, failures, lines };
    }
  } else {
    anchor = { tier, version: '(注入档位)', source: '(注入档位)' };
  }
  emit(`OK    ⓪ 锚档 ${anchor.tier}（${anchor.version === '(注入档位)' ? '注入档位' : `dsh@${anchor.version}`}）——期望集按 ${TIER_BOUNDARY} 边界分档（rc.2 与 rc.3 基线逐字节相同、同档）`);

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
  if (!(anchor.tier in exp.tiers)) {
    fail(`期望集 ${String(configId)} 没有 "${anchor.tier}" 档（合法值：${Object.keys(exp.tiers).join(', ')}）`);
    return { ok: false, failures, lines };
  }
  const tierExp = exp.tiers[anchor.tier];
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

  // ── ③ 顶层/嵌套行序列与该档基线期望逐项按序比对（缺一即红、多一行也红、换序/重复也红） ──
  const actualTop = plugins.map((child) => child?.id);
  const expectedTop = tierExp.baselineTop;
  const missingTop = expectedTop.filter((id) => !actualTop.includes(id));
  const extraTop = actualTop.filter((id) => !expectedTop.includes(id));
  if (missingTop.length > 0) fail(`顶层行与基线期望（${exp.configId}，${anchor.tier} 档）比对缺行：${missingTop.join(', ')}（基线行不得静默缺失）`);
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
    emit(`OK    ③ 顶层 ${String(actualTop.length)} 行 + 嵌套 ${String(actualNested.length)} 行与基线期望逐项按序一致（${anchor.tier} 档${exp.officeRow && anchor.tier === 'rc1' ? '；tool-office 为 D4 登记差异——期望 = rc.1 基线 + present 后插入' : ''}）`);
  }

  // ── ③b 禁入行名（pwsh 禁入；worker-thread 缺席） ────────────────────────
  for (const moduleName of exp.forbidden) {
    if (allRows.some((child) => child?.name === moduleName)) {
      fail(`子清单不得含 ${moduleName}${moduleName.includes('worker-thread') ? '（禁入的替代行）' : '（前台同步 shell 到期杀进程树）'}`);
    }
  }

  // ── ④ 五行 dsh-async-tools（顶层四行 + delegation 组内一行），toolName 五值各一；
  //      顶层第四行是只读查询行 async_list_subagent_models（需求 §2.3.4）；
  //      delegation 组内行必须钉在组内 tool-workflow 行后（行位判据：
  //      workflowEngine 是组内隔离服务，组外行 ctx.get 恒 miss——挪出组必红） ──
  const asyncRows = allRows.filter((child) => child?.name === 'dsh-async-tools');
  const actualToolNames = asyncRows.map((child) => child?.config?.toolName).filter((v) => typeof v === 'string');
  const dupToolNames = actualToolNames.filter((v, index) => actualToolNames.indexOf(v) !== index);
  if (asyncRows.length !== 5) fail(`期望恰 5 行 dsh-async-tools（顶层 4 + delegation 组内 1），实得 ${String(asyncRows.length)}`);
  for (const expected of EXPECTED_TOOL_NAMES) {
    if (!actualToolNames.includes(expected)) fail(`toolName 五值缺 "${expected}"（实得 ${actualToolNames.join(', ') || '(无)'}）`);
  }
  if (dupToolNames.length > 0) fail(`toolName 有重复：${dupToolNames.join(',')}`);
  // 行身份（设计 §6.2）：五行必须各自携带 owningPreset 且等于本补丁的 config.id
  // ——组合文件与诊断据此指认「这一行属于哪份预设」；防护内容按「会话实际
  // 预设 ∈ boundPresets」判定、与行声明无关（PRESET-ISOLATION-02），此检查
  // 只锁行身份一致性，不承载警示在场判定。
  if (!asyncRows.every((child) => child?.config?.owningPreset === configId)) {
    fail(`五行 dsh-async-tools 的 owningPreset 必须全部等于 "${String(configId)}"（行身份声明）`);
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
  if (asyncRows.length === 5 && dupToolNames.length === 0 && workflowAsyncRow !== undefined && listModelsRow !== undefined) {
    emit(`OK    ④ 五行 dsh-async-tools（toolName：${actualToolNames.join(', ')}，owningPreset=${String(configId)}），async_list_subagent_models 在顶层，async_workflow 钉在 delegation 组内 tool-workflow 行后`);
  }

  // ── ⑤ persona prefix 逐字锚（增改即红——身份句不承载本包内容，执行纪律
  //      走运行时 section）：dsh-async 与该档 standard 基线身份句逐字一致
  //      （两档同串）；create 为 D2 固定两句锚（两档同串；rc1 档较其基线多
  //      第二句为登记分歧——判据只锁逐字，不做"与基线差异"判断） ──────────
  const personaRow = plugins.find((child) => child?.id === 'persona');
  const prefix = typeof personaRow?.config?.prefix === 'string' ? personaRow.config.prefix : '';
  if (prefix !== tierExp.personaPrefix) {
    fail(exp.personaAnchor === 'designed-d2'
      ? `persona prefix 必须与 D2 固定两句锚逐字一致（两档同串；rc1 档较 rc.1 基线多第二句为登记分歧——单份补丁回落单句同样红），实为：${JSON.stringify(prefix)}`
      : `persona prefix 必须与该档基线身份句逐字一致（${anchor.tier} 档，两档同串；任何增改即红——本包执行纪律由宿主半边的 systemPrompt section 运行时注入，设计 §3.6），实为：${JSON.stringify(prefix)}`);
  } else {
    emit(exp.personaAnchor === 'designed-d2'
      ? 'OK    ⑤ persona prefix 与 D2 固定两句锚逐字一致（两档同串）'
      : `OK    ⑤ persona prefix 与基线身份句逐字一致（${anchor.tier} 档，两档同串）`);
  }

  // ── ⑤b 纪律锚句（两语表两档；删任一句必红） ─────────────────────────────
  // 文案住在 lib/text.js 的 discipline.preset.<configId>（宿主半边按 agentLang
  // 现读、按目标会话预设选变体，设计 §3.6）——zh 档锚句与 en 档语义同源。
  let disciplineOk = true;
  for (const lang of ['en', 'zh']) {
    const disciplineText = t(lang, `discipline.preset.${String(configId)}`);
    for (const anchorPhrase of exp.disciplineAnchors[lang]) {
      if (!disciplineText.includes(anchorPhrase)) {
        fail(`discipline.preset.${String(configId)}（${lang} 档）缺强制规则锚句：${JSON.stringify(anchorPhrase)}`);
        disciplineOk = false;
      }
    }
  }
  if (disciplineOk) emit(`OK    ⑤b 纪律锚句齐全（discipline.preset.${String(configId)}，en/zh 两档）`);

  // ── ⑤c 通用纪律锚句（discipline.preset.generic，en/zh 两档） ─────────────
  // 独立于期望集、每份补丁校验都执行（通用变体不属于任何一份补丁的期望集；
  // 无参 CLI 校验两份补丁 → 本行输出两遍属预期，不为去重引入跨调用状态）。
  let genericDisciplineOk = true;
  for (const lang of ['en', 'zh']) {
    const genericText = t(lang, 'discipline.preset.generic');
    for (const anchorPhrase of GENERIC_DISCIPLINE_ANCHORS[lang]) {
      if (!genericText.includes(anchorPhrase)) {
        fail(`discipline.preset.generic（${lang} 档）缺强制规则锚句：${JSON.stringify(anchorPhrase)}`);
        genericDisciplineOk = false;
      }
    }
  }
  if (genericDisciplineOk) emit('OK    ⑤c 通用纪律锚句齐全（discipline.preset.generic，en/zh 两档）');

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
    const liveSubagent = allRows.find((child) => child?.id === 'tool-subagent' && child.disabled !== true);
    const hasAsyncAgent = asyncRows.some((child) => child?.config?.toolName === 'async_agent');
    if (liveSubagent !== undefined && hasAsyncAgent) {
      const disciplineEn = t('en', `discipline.preset.${String(configId)}`);
      const hasEntry = disciplineEn.includes('async_agent is the ONLY delegation entry');
      const hasRetrieval = disciplineEn.includes('wait with async_wait');
      if (!hasEntry) fail('活 tool-subagent 行与 async_agent 行同时在场，纪律段必须写明唯一派生入口（async_agent is the ONLY delegation entry）——需求 §3.1 可验证口径');
      if (!hasRetrieval) fail('活 tool-subagent 行与 async_agent 行同时在场，纪律段必须写明取回通道（wait with async_wait）——需求 §3.1 可验证口径');
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

  // ── ⑧b 插件管理两行与该档基线禁用形态逐字同形 ──────────────────────────
  // 两档基线此两行同形（对账按档核对）；standard 基线 manager 行 profileContext
  // 条件表达式＋market 行布尔禁用；cordis 基线两行 profileContext 条件表达式——
  // 创造上下文（profileContext 在场）中插件管理与市场入口按基线启用，换成布尔
  // 禁用会把入口整个锁死（需求 §3.1、§7.3.2）。`!!js` 表达式解析为字符串，布尔
  // 与表达式在此可区分——按行逐字比对，改任一侧必红。
  let pluginRowsOk = true;
  for (const rowId of PLUGIN_ROWS) {
    const target = allRows.find((child) => child?.id === rowId);
    if (target === undefined) {
      fail(`子清单缺 ${rowId} 行（基线行不得静默缺失）`);
      pluginRowsOk = false;
    } else if (target.disabled !== tierExp.pluginRowsDisabled[rowId]) {
      fail(`${rowId}.disabled 必须与基线禁用形态逐字同形（${exp.configId}，${anchor.tier} 档基线 = ${JSON.stringify(tierExp.pluginRowsDisabled[rowId])}），实为 ${JSON.stringify(target.disabled)}`);
      pluginRowsOk = false;
    }
  }
  if (pluginRowsOk) {
    emit(`OK    ⑧b 插件管理两行与基线禁用形态逐字同形（${exp.configId}，${anchor.tier} 档：manager = ${JSON.stringify(tierExp.pluginRowsDisabled['tool-plugin-manager'])}，market = ${JSON.stringify(tierExp.pluginRowsDisabled['tool-plugin-market'])}）`);
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

  // ── ⑩ 禁用行与基线随迁行的 config 逐字（翻活已由 ⑧ 红；此处锁死 config
  //      键值——删键/改值必红；两份补丁同款检查。tool-fs 行是 0.2.2 基线随迁
  //      漂移〔applyPatch: false〕的逐字锚） ──
  let verbatimOk = true;
  for (const [rowId, expectedConfig] of Object.entries({ ...SUBAGENT_CONFIG_VERBATIM, ...BASELINE_DRIFT_CONFIG_VERBATIM })) {
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
  if (verbatimOk) emit('OK    ⑩ tool-subagent / -fork 禁用行与 tool-fs 基线随迁行 config 逐字（键值零漂移）');

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

  // ── ⑫ D1：skill-filesystem 行 config 形状与 customSkillDirs 表达式串逐字锚
  //      （两补丁两档同判据；rc2 档该键与 rc.2+ 基线同形，rc1 档 dsh-async 较
  //      其基线多此键为登记分歧——判据只锁表达式串，不做"与基线差异"判断） ──
  const skillRow = allRows.find((child) => child?.id === 'skill-filesystem');
  let skillExprOk = true;
  if (skillRow === undefined) {
    fail('子清单缺 skill-filesystem 行（⑫ D1 表达式锚无从谈起）');
    skillExprOk = false;
  } else {
    const configKeys = Object.keys(skillRow.config ?? {});
    if (configKeys.length !== 1 || configKeys[0] !== 'customSkillDirs') {
      fail(`skill-filesystem.config 必须恰含 customSkillDirs 一键（D1；键集逐字锁死），实得键：${JSON.stringify(configKeys)}`);
      skillExprOk = false;
    } else {
      const dirs = skillRow.config.customSkillDirs;
      if (!Array.isArray(dirs) || dirs.length !== 1 || dirs[0] !== CUSTOM_SKILL_DIRS_EXPR) {
        fail(`skill-filesystem.config.customSkillDirs 必须是恰含 D1 锚表达式的单元素列表（表达式串逐字符锚，改一字符即红），实为：${JSON.stringify(dirs)}`);
        skillExprOk = false;
      }
    }
  }
  if (skillExprOk) emit('OK    ⑫ skill-filesystem 的 customSkillDirs 表达式串逐字锚（D1，两档同串）');

  // ── ⑬ D3：tool-subagent-control 行零 config（含 interrupt:false 在内任何键都
  //      红——rc.2+ 基线该键不随迁，随迁会撤下 interrupt_agent 注册、违反需求
  //      §3.1 非阻塞停止管理；rc.1 基线此行本就无 config，两档判据相同。D5 的
  //      补丁面同在此处（控制行无按工具关闭键，wait_agent 隐藏走代码侧） ──
  const controlRow = allRows.find((child) => child?.id === 'tool-subagent-control');
  let controlOk = true;
  if (controlRow === undefined) {
    fail('子清单缺 tool-subagent-control 行（⑬ D3 判据无从谈起）');
    controlOk = false;
  } else {
    if (controlRow.name !== '@deepseek-ai/dsh-tool-subagent-control') {
      fail(`tool-subagent-control 行 name 应为 "@deepseek-ai/dsh-tool-subagent-control"，实为 ${JSON.stringify(controlRow.name)}`);
      controlOk = false;
    }
    if (controlRow.config !== undefined && Object.keys(controlRow.config).length > 0) {
      fail(`tool-subagent-control 行不得携带 config（D3：rc.2+ 基线的 interrupt:false 不随迁——会撤下 interrupt_agent 注册；含任何键都红），实得键：${JSON.stringify(Object.keys(controlRow.config))}`);
      controlOk = false;
    }
  }
  if (controlOk) emit('OK    ⑬ tool-subagent-control 行零 config（D3 不随迁 + D5 补丁面；两档同判据）');

  // ── ⑭ D4：tool-office 行在场、钉在 present 后、disabled 为在场性探测表达式
  //      逐字锚（仅 dsh-async；create 的 cordis 基线两档均无 office 行，本判据
  //      对其关闭，挂入由 ③ 拦） ──────────────────────────────────────────
  if (exp.officeRow) {
    const officeRow = plugins.find((child) => child?.id === 'tool-office');
    let officeOk = true;
    if (officeRow === undefined) {
      fail('子清单缺 tool-office 行（D4：行必须在场——rc.1 树包缺席靠 disabled 探测跳过，不得整行省略）');
      officeOk = false;
    } else {
      if (officeRow.name !== '@deepseek-ai/dsh-tool-office') {
        fail(`tool-office 行 name 应为 "@deepseek-ai/dsh-tool-office"，实为 ${JSON.stringify(officeRow.name)}`);
        officeOk = false;
      }
      const presentIndex = actualTop.indexOf('present');
      const officeIndex = actualTop.indexOf('tool-office');
      if (presentIndex === -1 || officeIndex !== presentIndex + 1) {
        fail(`tool-office 行必须钉在 present 行之后（D4；两档期望行序），实得 present 第 ${String(presentIndex + 1)} 位、tool-office 第 ${String(officeIndex + 1)} 位`);
        officeOk = false;
      }
      if (officeRow.disabled !== OFFICE_PROBE_EXPR) {
        fail(`tool-office.disabled 必须逐字等于 D4 在场性探测表达式（IIFE：先解析 @deepseek-ai/dsh/package.json，再从该位置解析 @deepseek-ai/dsh-tool-office/package.json，成功 false／异常 true；逐字符锚），实为：${JSON.stringify(officeRow.disabled)}`);
        officeOk = false;
      }
      if (officeRow.config !== undefined) {
        fail(`tool-office 行不得携带 config（基线行无 config，D4 仅多 disabled 探测一键），实得键：${JSON.stringify(Object.keys(officeRow.config))}`);
        officeOk = false;
      }
    }
    if (officeOk) emit('OK    ⑭ tool-office 行在场、钉在 present 后、disabled 探测表达式逐字锚（D4，两档同串）');
  } else {
    emit('OK    ⑭ tool-office 判据对本期望集关闭（cordis 基线两档均无 office 行；挂入由 ③ 多行判据拦）');
  }

  if (failures > 0) {
    const line = `预设补丁校验失败（${exp.configId}，${anchor.tier} 档）：${String(failures)} 项。`;
    lines.push(line); if (!quiet) console.error(`\n${line}`);
    return { ok: false, failures, lines };
  }
  const line = `预设补丁校验通过（${exp.configId}，${anchor.tier} 档）。`;
  lines.push(line); if (!quiet) console.log(`\n${line}`);
  return { ok: true, failures: 0, lines };
}

// CLI 入口（被 node 直接执行时才跑；被 import 时静默导出）。无参 = 两份补丁都校验
// 并对该档 shipped 基线对账。
const invokedDirectly = process.argv[1] !== undefined
  && existsSync(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  let anchor;
  try {
    anchor = resolveAnchorTier();
  } catch (error) {
    console.error(`宿主锚分档失败 → ${error.message}`);
    process.exit(1);
  }
  console.log(`锚档：${anchor.tier}（dsh@${anchor.version}，${anchor.source}）——期望集按 ${TIER_BOUNDARY} 边界分档（rc.2 与 rc.3 基线逐字节相同、同档）。`);
  // resolve 而不是 join：绝对路径参数必须原样生效（join 会把绝对路径拼坏）。
  // 带参 = 只校验那一份；路径命中已登记补丁时同样对账，其余路径仅判据校验
  // （对账需要期望集与基线的对应关系，任意路径无从建立）。
  const argPath = process.argv[2] === undefined ? undefined : resolve(process.cwd(), process.argv[2]);
  const selected = argPath === undefined
    ? Object.values(EXPECTATIONS).map((exp) => ({ exp, patchPath: join(ROOT, exp.patchRel) }))
    : [{ exp: Object.values(EXPECTATIONS).find((exp) => join(ROOT, exp.patchRel) === argPath), patchPath: argPath }];
  // shipped 基线补丁与锚树同源（@deepseek-ai/dsh-web-app 随包预设；候选次序同
  // _host-resolve）。将对账而基线缺席不许静默跳过；任意路径（仅判据校验）不要求。
  const needsReconcile = selected.some(({ exp }) => exp !== undefined);
  const baselinePresetsDir = needsReconcile
    ? candidateModules(HOST_HOME)
      .map((base) => join(base, '@deepseek-ai', 'dsh-web-app', 'presets'))
      .find((dir) => existsSync(join(dir, 'standard.patch.yml')))
    : undefined;
  if (needsReconcile && baselinePresetsDir === undefined) {
    console.error(`找不到 shipped 基线补丁目录（@deepseek-ai/dsh-web-app/presets；候选基目录 = ${candidateModules(HOST_HOME).join(' ; ') || '(无)'}）——锚在场而基线缺席，对账无从谈起，不许静默跳过`);
    process.exit(1);
  }
  const { load } = await loadYaml();
  let allOk = true;
  for (const { exp, patchPath } of selected) {
    const result = await validatePatch(patchPath);
    if (!result.ok) allOk = false;
    if (exp === undefined) continue; // 任意路径：仅判据校验（见上）
    const baselineFile = join(baselinePresetsDir, `${exp.baselineId}.patch.yml`);
    console.log(`对账基线：${baselineFile}`);
    let baselineDoc;
    try {
      baselineDoc = load(readFileSync(baselineFile, 'utf8'));
    } catch (error) {
      console.error(`      FAIL  基线补丁读取/解析失败（${baselineFile}）→ ${error.message}`);
      allOk = false;
      continue;
    }
    let patchDoc;
    try {
      patchDoc = load(readFileSync(patchPath, 'utf8'));
    } catch (error) {
      console.error(`      FAIL  补丁读取/解析失败（${patchPath}）→ ${error.message}`);
      allOk = false;
      continue;
    }
    const reconciled = reconcileBaseline(exp.configId, { tier: anchor.tier, baselineDoc, patchDoc });
    if (!reconciled.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}
