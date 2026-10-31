/**
 * 面向模型的文案双语完整性检查（需求 §5.3）。
 *
 * ## 口径
 *
 * - **英文档**：`TEXT.en` 每个键的串零 CJK；运行时 `agentLang:'en'` 构造出的全部
 *   模型可见串零 CJK。
 * - **中文档**：`TEXT.zh` 每个键都含中文（缺译即红）；运行时 `agentLang:'zh'` 的
 *   模型可见串与 en 同位串**确实不同**且含 CJK（防"两档其实共用一套文案"）。
 * - **键集一致**：两档键集必须相等（少一个键就是少一句提示）。
 * - **源码层补检**：`lib/*.js`（`text.js` 除外——它就是双语表本体，由上面三层审）
 *   剥注释后不得出现 CJK 字符串字面量，白名单放行两类：操作者一侧（stderr 通告、
 *   logger）与**判定常量**（`lib/silent-failure.js` 的 ZH 拒绝锚——匹配的是命令输出，
 *   不是模型文案，需求 §6.3）。
 * - `client.js`（展示侧，`uiLang` 的地盘）**不在扫描范围**。
 *
 * ## 能红自证
 *
 * 往 `TEXT.zh` 删一个键、往 `TEXT.en` 某串塞一个汉字、或往任一 lib 文件里塞一行
 * `const x = '中文';`，再跑本脚本必须变红。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'lib');

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
let failures = 0;

// ── 第一层：TEXT.en 零 CJK ───────────────────────────────────────────────
// ── 第二层：TEXT.zh 每键含中文 ───────────────────────────────────────────
// ── 第三层：两档键集相等 ─────────────────────────────────────────────────
{
  const { TEXT, LANGS } = await import('../lib/text.js');
  if (Array.from(LANGS).join(',') !== 'en,zh') {
    console.error('FAIL  LANGS 必须恰为 [en, zh]');
    failures++;
  }
  const enKeys = Object.keys(TEXT.en).sort();
  const zhKeys = Object.keys(TEXT.zh).sort();
  for (const key of enKeys) {
    if (CJK.test(TEXT.en[key])) {
      console.error(`FAIL  TEXT.en[${key}] 含 CJK：${TEXT.en[key].slice(0, 60)}`);
      failures++;
    }
  }
  for (const key of zhKeys) {
    if (!CJK.test(TEXT.zh[key])) {
      console.error(`FAIL  TEXT.zh[${key}] 缺中文（疑似缺译或误抄英文）：${String(TEXT.zh[key]).slice(0, 60)}`);
      failures++;
    }
  }
  const missingInZh = enKeys.filter((key) => !(key in TEXT.zh));
  const extraInZh = zhKeys.filter((key) => !(key in TEXT.en));
  for (const key of missingInZh) {
    console.error(`FAIL  TEXT.zh 缺键：${key}`);
    failures++;
  }
  for (const key of extraInZh) {
    console.error(`FAIL  TEXT.zh 多键（en 档没有）：${key}`);
    failures++;
  }
  if (failures === 0) {
    console.log(`表层通过（en/zh 各 ${String(enKeys.length)} 键，键集相等，en 零 CJK，zh 每键含中文）。`);
  }
}

// ── 源码层：lib/*.js 剥注释后零 CJK（白名单放行操作者一侧） ────────────────
//
// `lib/text.js` 是双语表本体（zh 档的 CJK 是它的职责），由上面三层判据审计，
// 不参加源码扫描；这一层拦的是"新加了一句没进表的模型侧中文"。

/**
 * 白名单：文件名 → [{ needle, why }]。needle 是包含 CJK 的**完整字符串片段**
 * （用 includes 匹配该行命中是否落在此片段内）。
 */
const ALLOWLIST = {
  // 宿主行装载时的 stderr 通告：操作者一侧（部署期线索），不进模型上下文。
  'index.js': [
    { needle: '设置快照缺席', why: 'stderr 通告（emitLifecycleNotice），操作者一侧' },
    { needle: '宿主行未装载', why: '同上通告的续行字符串，操作者一侧' }
  ],
  // 刷新总线的诊断与失败通告：logger.debug / emitLifecycleNotice（stderr）。
  'refresh-bus.js': [
    { needle: '登记监听器', why: 'diag（logger.debug），操作者一侧' },
    { needle: '注销监听器', why: 'diag（logger.debug），操作者一侧' },
    { needle: '广播设置变更', why: 'diag（logger.debug），操作者一侧' },
    { needle: '刷新工具描述失败', why: 'stderr 通告（emitLifecycleNotice），操作者一侧' }
  ],
  // volatile 提交失败的报错与首次装载的降级通告：warn + stderr 通告，操作者一侧。
  'settings.js': [
    { needle: 'volatile 提交后配置自检失败', why: 'logger.warn，操作者一侧' },
    { needle: 'volatile 提交未生效', why: 'stderr 通告（emitLifecycleNotice），操作者一侧' },
    { needle: '宿主行配置自检失败', why: '首次装载降级的 logger.warn，操作者一侧' },
    { needle: '宿主行忽略持久化的非法设置', why: '首次装载降级的 stderr 通告，操作者一侧' },
    { needle: '设置变更广播失败', why: '悬空动态 import 的 .catch warn，操作者一侧（快照已落，只影响描述刷新转达）' },
    { needle: '降级警示的描述刷新失败', why: '降级登记（markDegraded）同款动态 import 的 .catch warn，操作者一侧（登记已落，只影响警示段刷新转达）' },
    { needle: '最近提交的原始值自检失败', why: 'internal/config waterfall 降级通告的 logger.warn，操作者一侧（同 volatile 提交后配置自检失败一条的通道）' },
    { needle: '最近提交的设置未生效', why: '同上通道的 stderr 通告（emitLifecycleNotice），操作者一侧（同 volatile 提交未生效一条）' }
  ],
  // 装载期降级通告（emitLifecycleNotice → stderr）的豁免先例见 index.js 的
  // 「设置快照缺席」组——agent-policy.js 现仅含形状副本与 policyOf，无 CJK
  // 字面量，不设豁免组。
  'agent.js': [
    { needle: '以非完成结局收场', why: 'stderr 通告（emitLifecycleNotice），操作者一侧（result 观察通道）' },
    { needle: '结果通道拒绝（基础设施故障）', why: '同上通道的拒绝分支通告，操作者一侧' },
    { needle: '子代理路由预检拒绝', why: 'stderr 通告（emitLifecycleNotice），操作者一侧（预检拒绝的完整宿主原文）' },
    { needle: '子代理启动前重读模型选择设置失败', why: '同上通道的启动前重读失败通告，操作者一侧（完整原错走 stderr；模型侧只吃 routeRecheckReadFailed 词典键的单行化截断段）' }
  ],
  // 注册拒绝完整原文的 stderr 通告：操作者一侧——模型侧只吃单行化＋500 截断
  // 段（t() 词典 error.startRefused*），完整原文不进模型上下文（同 agent.js
  // 预检拒绝通告的先例）。
  'jobs.js': [
    { needle: '注册拒绝（进程启动前）完整原文', why: 'stderr 通告（emitLifecycleNotice），操作者一侧（注册拒绝的完整宿主原文）' }
  ],
  // 静默失败签名 2 的 ZH 拒绝锚：**判定常量**——匹配的是命令输出文本，不是面向模型的文案
  // （EN 对零 CJK 不触发本层；文案本身在 text.js 的 note.silentDenied）。
  'silent-failure.js': [
    // 两枚锚分列登记；匹配是行级的（lines[n].includes），两锚虽同行 30，
    // 单枚即覆盖，但分列登记让任何一侧挪行后仍各自豁免。
    { needle: '无法运行', why: '签名 2 的 ZH 拒绝锚对之一（判定常量，匹配命令输出）' },
    { needle: '拒绝访问', why: '签名 2 的 ZH 拒绝锚对之二（判定常量，匹配命令输出）' }
  ]
};

/** 剥离注释（引号敏感；字符串字面量内部不算注释）。返回无注释源码。 */
function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null; // 当前所在的引号字符（'、"、`）或 null
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue; // 换行符保留——行号与原文件一致（不含注释本体）
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n'; // 保留换行数
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

{
  const files = readdirSync(LIB)
    .filter((f) => f.endsWith('.js') && f !== 'text.js')
    .sort();
  let sourceFailures = 0;
  for (const file of files) {
    const raw = readFileSync(join(LIB, file), 'utf8');
    const stripped = stripComments(raw);
    const lines = stripped.split('\n');
    const allows = ALLOWLIST[file] ?? [];
    for (let n = 0; n < lines.length; n++) {
      if (!CJK.test(lines[n])) continue;
      const covered = allows.some((entry) => lines[n].includes(entry.needle));
      if (covered) continue;
      console.error(`FAIL  lib/${file}:${String(n + 1)} 模型侧出现 CJK：${lines[n].trim().slice(0, 100)}`);
      sourceFailures++;
    }
  }
  failures += sourceFailures;
  if (sourceFailures === 0) {
    console.log(`源码扫描层通过（lib/*.js 除 text.js 外共 ${String(files.length)} 文件，白名单 ${String(Object.values(ALLOWLIST).flat().length)} 条）。`);
  }
}

// ── 硬编码文案层：连"看起来像句子的英文字面量"一起挡 ────────────────────────
//
// 只扫 CJK 有个盲区：中文档下**硬编码的英文句子**既不触发 CJK 判据，也不在 `t()` 的键集里，
// 于是那句提示永远是英文、中英混排，而三层判据全绿（例：硬编码英文句
// " (a user message arrived during the wait)" 一类）。这一层把"像句子的字面量"全部点出来：
// 面向模型的文案只能来自 `lib/text.js`（该文件本身由表层逐键审计）。
//
// 判据口径：字面量里出现"两个 ≥2 字母的词、中间有空白"就算句子。允许清单只收**标记**
// （如 `[output truncated]`）——那不是句子，是宿主同款的定长标记。

/**
 * 抽出一个源文件里像句子的字符串字面量。
 * @param {string} source - 源码。
 * @param {string[]} [allowNeedles] - 允许的字面量片段（标记类，逐条给出理由见调用方）。
 * @param {string[]} [operatorMarkers] - 命中所在行含这些片段时视为**操作者一侧**（logger/diag/stderr 通告）。
 * @returns {{line: number, text: string}[]} 命中（行号 + 字面量内容）。
 */
export function scanProseLiterals(source, allowNeedles = [], operatorMarkers = []) {
  const stripped = stripComments(source);
  const lines = stripped.split('\n');
  const hits = [];
  const literal = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  for (const match of stripped.matchAll(literal)) {
    const text = match[2];
    // "像句子" = 两个 ≥2 字母的词、中间有空白。
    //
    // 已知边界（不假装覆盖）：**半句 + 插值**的碎片（`' (diagnostic: ' + reason`）不算命中——
    // 把规则放宽到"一个 ≥3 字母的词 + 空白"会把插值调用模板（`job ${id}`）与日志片段一起卷进来，
    // 允许清单会膨胀到没人再看。这类碎片由运行时层（两档取数）与实现审查承接。
    if (!/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(text)) continue;
    // 纯转义/空白（换行拼接）不算文案。
    if (text.replace(/\\[nrt]/g, '').trim() === '') continue;
    if (allowNeedles.some((needle) => text.includes(needle))) continue;
    const line = stripped.slice(0, match.index).split('\n').length;
    if (operatorMarkers.some((marker) => lines[line - 1].includes(marker))) continue;
    hits.push({ line, text });
  }
  return hits;
}

/** 操作者一侧的行标记：这些行上的文案进 logger / diag / stderr，不进模型上下文。 */
const OPERATOR_MARKERS = ['LOG_PREFIX', 'logger.', 'logger?.', 'diag(', 'process.stderr', 'console.', 'emitLifecycleNotice'];

/**
 * 允许的模型侧英文字面量：每条都要说清"为什么它不进 `text.js`"。
 * 允许的有三类——**定长标记**（宿主同款英文，不是句子）、**校验/断言错误**
 * （操作者一侧：降级 stderr 与开发期断言，schemastery 同层也是英文）与
 * **宿主逐字同形副本**：宿主源码里逐字存在的
 * 串，钉版看守（有限锚集）要求被锚住的串与宿主逐字同形——双语化即破坏锚、即与宿主
 * 行为漂移。判定特征统一为"宿主侧同串同现 + 看守锚定于宿主源"。
 */
const PROSE_ALLOWLIST = {
  'jobs.js': [
    { needle: '[output truncated', why: '截断标记（与宿主 pwsh 同款定长英文标记）' },
    { needle: 'guard ownership evidence', why: '`ctx.effect` 的标签（行卸载时清归属证据的处置器；诊断侧，进 Fiber 树与日志，不进模型上下文——与 host.js 的 host snapshot source 同类）' },
    { needle: 'exit code', why: '退出码标记（同上）' },
    { needle: 'tool call aborted', why: '宿主契约串（宿主把中止的工具调用整体改写为 "Error: tool call aborted"，本包入口检查抛同款短语走同一改写通道——不是本包文案）' },
    { needle: 'async-tools: yield race concluded', why: '内部中止原因（喂给 raceAbort 的 Error，只在进程内传播；同 wait-job 的 wait concluded 一类）' },
    { needle: 'preparation failed', why: '防御性回退占位（正常路径 detail/原始错误必在；英文是它唯一形态，同 config-view 只读防御一类）' },
    { needle: 'registry settled completed before the process handle arrived', why: '不变量破坏时的 fail-loud 断言（正常路径不可达，不进模型上下文；同 config-view 只读防御一类）' },
    { needle: 'subprocess failed before reporting an outcome', why: '宿主契约判定常量（dsh-pwsh-local/dsh-bash-local「进程未上报结局」注记前缀——killed 触发形态的检测信号按宿主逐字匹配命令输出，双语化即失配；判定常量不是文案，诊断文案在 text.js 的 error.workdirPrep*，同 silent-failure 签名锚对一类）' }
  ],
  'workflow.js': [
    { needle: 'tool call aborted', why: '宿主契约串（入口中止守卫：宿主把中止的工具调用整体改写为 "Error: tool call aborted"，本包抛同款短语走同一改写通道——与 jobs.js 的同名条目同一理由）' },
    { needle: 'unknown error', why: '宿主同形回退（jobOutcomeOf error 支的 detail 缺省值——宿主原文，非本包文案）' },
    { needle: 'workflow run ended abnormally', why: '宿主同形防御分支（stopReason 封闭联合的未来变体；正常路径不可达，宿主同款英文）' },
    { needle: 'async workflow job killed', why: '内部取消缺省理由（喂给 run.cancel，经注册表 kill-reason 合并；对应宿主后台的 background workflow job killed 同类缺省）' },
    { needle: 'workflow run settled before the outcome arrived', why: '不变量破坏时的 fail-loud 断言（终态到达时 done 链必已映射，正常路径不可达）' },
    { needle: 'workflow run failed', why: 'failed 支的 detail 缺省回退（宿主 stopReasonError 同款前缀；正常路径 settled.detail 必在）' }
  ],
  'config-view.js': [
    { needle: 'the config view is read-only', why: '只读视图的防御性异常（正常路径不会到达模型；英文是它唯一形态）' }
  ],
  'config.js': [
    { needle: 'must be a positive finite number', why: '配置校验错误（操作者一侧：降级 stderr 说明；同层 schemastery 文案也是英文）' },
    { needle: 'must lie within', why: '同上（跨字段顺序）' },
    { needle: 'uiLang must be one of', why: '同上（语言字段值域）' },
    { needle: 'agentLang must be', why: '同上（语言字段值域）' },
    { needle: 'jobKind must be a non-empty string', why: '同上' },
    { needle: '[async-tools] cross-field violation', why: '跨字段校验错误的组装前缀（操作者一侧：武装/降级回调的 schema 拒绝与降级 stderr，与前缀拼 detail 的 must lie within 同类；detail 部分来自 error.message 变量，本就不过字面量层）' },
    { needle: '[async-tools] type violation', why: '布尔类型检查错误的组装前缀（操作者一侧：武装/降级回调的 schema 拒绝，与 cross-field violation 同一形态——自包含回调不能引用词典，序列化链约束见 makeSelfSustaining）' },
    { needle: 'must be a boolean, got', why: '同上（布尔类型检查的逐字段明细片段；字段名与候选值来自变量插值，本就不过字面量层）' },
    { needle: 'const BASELINE', why: '降级回调的 Function 构造源码模板（一段 JS 源码片段，不是面向模型的文案——模板内嵌的拒绝前缀经上一条豁免，五查判据由两形同值对账测试与 armed 形锁定）' }
  ],
  'settings.js': [
    { needle: 'recent commit failed self-check', why: '降级登记明细的组装前缀（markDegraded 前缀 + error.message 变量；与 config.js 校验错误同类：明细主体是操作者一侧的校验错误文本，同路径 seed/volatile 两条直接透传 error.message）' }
  ],
  'descriptions.js': [
    { needle: 'unknown tool name', why: '构建器的开发期断言（工具名写错时立刻炸，不进模型上下文）' }
  ],
  'refresh-bus.js': [
    { needle: 'error.message', why: '透传宿主错误文本的拼接（不是本包文案）' }
  ],
  'host.js': [
    { needle: 'host snapshot source', why: '`ctx.effect` 的标签（诊断侧，进 Fiber 树与日志，不进模型上下文）' },
    { needle: 'ask takeover wiring', why: '同上（提问接管接线的 effect 标签）' }
  ],
  'ask-takeover.js': [
    { needle: 'was aborted before the user answered', why: '契约串：与原生 ask() 的 ASK_ABORTED 形状逐字一致，改一字即失配（不是文案）' },
    { needle: 'preset check failed', why: '操作者一侧 stderr 审计（audit 助手内部走 process.stderr）' },
    { needle: 'root re-check failed', why: '同上（判定④三态之一的审计行）' },
    { needle: 'failed for batch', why: '同上（迟到注入投递失败/可逆卸载交还失败的审计行——通道名 followup/inject 在模板里插值，故用稳定片段）' },
    { needle: 'idle watch failed for agent', why: '同上（末步竞态空闲观察失败的审计行）' },
    { needle: 'ledger read failed for agent', why: '同上（补醒观察期账本对账读 inbox 抛错的审计行，防护路径）' },
    { needle: 'sweep reminder sent for agent', why: '同上（补醒提醒发出的审计行）' },
    { needle: 'sweep reminder failed for agent', why: '同上（补醒提醒失败的审计行）' },
    { needle: 'hand-back failed for batch', why: '同上（可逆卸载交还失败的审计行）' }
  ],
  'wait.js': [
    { needle: 'wait concluded', why: '内部中止原因（喂给 raceAbort 的 Error，只在进程内传播；原 wait-job 同款条目随文件并入）' },
    { needle: 'returning as budget-exhausted', why: '操作者一侧诊断（ctx.logger.warn——自旋防线兜底触发的缺陷信号行的尾段字面量，不进模型上下文；needle 须与被抽取字面量同段）' }
  ],
  'index.js': [
    { needle: 'the tool-jobs row must be part of', why: '操作者一侧诊断（ctx.logger.warn——job_output 隐藏登记降级行的尾段字面量，不进模型上下文；agent/created 挂点改版后的新措辞，needle 须与被抽取字面量同段）' },
    { needle: 'agent.ctx.tools.restrict unavailable', why: '操作者一侧诊断（同上降级路径 throw 的 Error 消息——只在进程内被 catch 转 warn，不进模型上下文）' },
    { needle: 'async-tools: job_output hide', why: 'cordis effect 卸载标签（行卸载时摘限制句柄的登记名，宿主日志一侧，不进模型上下文）' }
  ],
  'delivery.js': [
    { needle: 'claimed listener attach failed', why: '操作者一侧 stderr 诊断（log() 通道——attachClaimedListener 的防御路径，不进模型上下文）' },
    { needle: 'keep-alive beat', why: '同上（预注册心跳被注册表拒绝的 warn 行；jobId 与错误文本来自变量插值）' },
    { needle: 'settled read', why: '同上（结算读取失败的 warn 行）' },
    { needle: 'incremental read', why: '同上（增量读取失败的 warn 行）' },
    { needle: 'completion delivery for', why: '同上（完成消息投递失败/registry miss 的 warn 行——owner 与错误文本来自变量插值，两条同前缀合并登记）' }
  ],
  // 宿主副本豁免类：assertRoutes 三条 + fold 空名单 throw 一条，全部是宿主
  // `dsh-tool-subagent` 源码的逐字同形串——verify/check-agent-policy.mjs 钉版看守
  // （有限锚集）锚住这些串的逐字形态；改一字（含双语化）看守即红、
  // 本包即与宿主行为漂移。宿主侧同串同现，不是本包自有文案。
  'agent-policy.js': [
    { needle: 'subagent model selection requires an array of routes', why: '宿主逐字同形副本（assertRoutes ↔ 宿主 assertAllowedModelRoutes；钉版看守锚住该串、要求逐字，双语化即破坏锚）' },
    { needle: 'subagent model selection requires non-empty provider and model ids', why: '同上（宿主 assertAllowedModelRoutes 的第二条校验串）' },
    { needle: 'subagent model selection repeats route', why: '同上（重复路由 throw 的模板串；needle 取插值前的稳定前缀）' },
    { needle: 'requires at least one route', why: '宿主逐字同形副本（fold 空名单 throw ↔ 宿主投影定义同串；「≥1 条」分列在此处与 settings current() 等三处校验，不在 assertRoutes）' }
  ],
  'silent-failure.js': [
    { needle: 'failed to run', why: '签名 2 的 EN 拒绝锚对之一（判定常量，匹配命令输出；文案在 text.js）' },
    { needle: 'Access is denied', why: '同上（EN 锚对之二）' }
  ]
};
/** 允许标记总数（跨文件合计；每条 needle 的生效范围见下方调用处——只对自己登记的文件生效）。 */
const PROSE_ALLOW_NEEDLES = Object.values(PROSE_ALLOWLIST).flat().map((entry) => entry.needle);

{
  const files = readdirSync(LIB)
    .filter((f) => f.endsWith('.js') && f !== 'text.js')
    .sort();
  let proseFailures = 0;
  for (const file of files) {
    // 每条允许只对它自己的文件生效：`config.js` 的豁免不给别的文件开口子——
    // 传给 scanProseLiterals 的是本文件登记的清单，不是全表摊平。
    const fileNeedles = (PROSE_ALLOWLIST[file] ?? []).map((entry) => entry.needle);
    const hits = scanProseLiterals(readFileSync(join(LIB, file), 'utf8'), fileNeedles, OPERATOR_MARKERS)
      // 纯标识符（工具名、事件名、模式名）不是句子。
      .filter((hit) => !/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/.test(hit.text));
    for (const hit of hits) {
      console.error(`FAIL  lib/${file}:${String(hit.line)} 面向模型的文案未进 lib/text.js：${JSON.stringify(hit.text.slice(0, 100))}`);
      proseFailures++;
    }
  }
  failures += proseFailures;
  if (proseFailures === 0) {
    console.log(`硬编码文案层通过（lib/*.js 除 text.js 外共 ${String(files.length)} 文件，允许标记 ${String(PROSE_ALLOW_NEEDLES.length)} 条）。`);
  }
}

// ── 运行时层：两档各构造三个工具，另对编排取端到端渲染样例 ────────────────
//
// 构造 async_run / async_wait / async_agent 三个工具，取
// description / 参数说明 / render 输出 / 全部 note 与 digest 函数的样例串——这些
// 正是模型看到的串；编排工具的完成分支渲染经下方端到端取样，查询工具的模型可见
// 文本全部由词典键组装、由表层逐键判据覆盖。en 档零 CJK；zh 档与 en 同位串不同
// 且含 CJK。需要宿主依赖可解析：`node --import ./tools/_host-hooks.mjs tools/check-model-text.mjs`。

/**
 * 编排完成渲染的端到端取样（常设看守）：最小内联装置走真实
 * `createWorkflowTool.execute`——首等窗口内结算的完成分支，覆盖
 * `render.workflowCompleted` 头部与 `detail.workflowAgents`（截断标记由
 * wait_job 的 render 样例覆盖，两处共用 `output.truncate`）。
 *
 * 不 import `test/_helpers.mjs`：检查器不依赖测试件（tools 层自包含）。
 *
 * @param {string} agentLang - 语言档。
 * @returns {Promise<string>} 完成分支的 result 文本。
 */
async function collectWorkflowCompletedRender(agentLang) {
  const { resolveConfig } = await import('../lib/config.js');
  const { createWorkflowTool } = await import('../lib/workflow.js');
  const config = resolveConfig({
    toolName: 'async_workflow', agentLang, minYieldMs: 1, defaultYieldMs: 200, maxYieldMs: 1000
  });
  /** 结算即翻视图、释放活 waiter（真实注册表同款 done→settle 链）。 */
  let view = { id: 'async-workflow-1', kind: 'async-workflow', label: 'text-sample', owner: 'sample-owner', status: 'running' };
  const waiters = [];
  const ctx = {
    on: () => () => {},
    get: (key) => (key === 'workflowEngine'
      ? {
        start: () => ({
          id: 'sample-run-1',
          meta: { name: 'text-sample' },
          result: Promise.resolve({ stopReason: 'completed', agentsStarted: 1, value: { ok: true } }),
          dispose: async () => {},
          cancel: () => {}
        })
      }
      : undefined),
    timer: {
      timeout: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); }
    },
    logger: { info() {}, warn() {} },
    jobs: {
      start(spec) {
        const hooks = spec.run({ updateProgress() {}, append() {} });
        void Promise.resolve(hooks.done).then((outcome) => {
          view = { ...view, status: outcome.status, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) };
          for (const waiter of waiters.splice(0)) waiter({ ...view });
        });
        return view.id;
      },
      wait: () => new Promise((resolve) => { waiters.push(resolve); }),
      list: () => [{ ...view }]
    }
  };
  const tool = createWorkflowTool(ctx, config);
  const agent = { id: 'sample-owner', inbox: { nextStep: [], nextTurn: [] }, session: { append() {} } };
  const result = await tool.execute(
    { meta: { name: 'text-sample', description: 'checker sample' }, script: 'return 1', yield_ms: 200 },
    { agent }
  );
  return String(result.result);
}

/** 取一个语言档的全部模型可见串（label → text 的有序对）。 */
async function collectSamples(agentLang) {
  const { resolveConfig, resolveWait } = await import('../lib/config.js');
  const { createRunTool } = await import('../lib/jobs.js');
  const { createWaitTool } = await import('../lib/wait.js');
  const { createAgentTool } = await import('../lib/agent.js');
  const output = await import('../lib/output.js');
  const { t } = await import('../lib/text.js');

  const config = resolveConfig({ agentLang });
  const ctx = { shell: { sandboxMode: 'workspace-write' } };
  const tools = {
    run: createRunTool(ctx, { ...config }),
    wait: createWaitTool(ctx, { ...config }),
    agent: createAgentTool(ctx, { ...config })
  };
  const samples = [];
  for (const [key, tool] of Object.entries(tools)) {
    samples.push([`description(${key})`, String(tool.description)]);
    for (const [param, spec] of Object.entries(tool.parameters?.properties ?? {})) {
      samples.push([`param ${key}.${param}`, String(spec.description)]);
    }
    const renders = tool.output?.render;
    if (typeof renders !== 'function') continue;
    // 样例值按各 render 分支取真会走到文案的形状（截断/非零退出/落 detail 的终态）。
    const noteValues = key === 'run'
      ? [{ status: 'completed', output: 'ok', truncated: true, exit_code: 1 },
        { status: 'running', note: output.yieldNote({ lang: agentLang, jobId: 'async-command-1', yieldMs: config.defaultYieldMs, maxWaitMs: config.maxWaitMs, defaultWaitMs: config.defaultWaitMs, elapsedMs: 1, mode: 'user' }) }]
      : key === 'wait'
        ? [{ status: 'completed', job_id: 'j', output: t(agentLang, 'detail.exitCode', { code: 0 }), truncated: true, detail: t(agentLang, 'detail.exitCode', { code: 0 }) },
          { status: 'running', job_id: 'j', waited_ms: 1, note: output.waitAgainNote({ lang: agentLang, jobId: 'j', waitedMs: 1, maxWaitMs: config.maxWaitMs }) },
          { status: 'interrupted', job_id: 'j', waited_ms: 1, note: output.interruptedNote({ lang: agentLang, subject: 'job j', waitedMs: 1, resume: 'async_wait(...)' }) }]
        : [{ agent_id: 'sa-1', note: t(agentLang, 'note.agentStarted', { agentId: 'sa-1', defaultWaitMs: config.defaultWaitMs }) + t(agentLang, 'route.inherits') }];
    for (const value of noteValues) {
      for (const block of renders({}, value)) samples.push([`render(${key})`, String(block?.text ?? '')]);
    }
  }
  samples.push(
    ['settledNote', output.settledNote({ lang: agentLang, agentId: 'sa-1' })],
    ['agentWaitAgainNote', output.agentWaitAgainNote({ lang: agentLang, agentId: 'sa-1', waitedMs: 1, maxWaitMs: config.maxWaitMs })],
    ['recheckFailedNote', output.recheckFailedNote({ lang: agentLang, jobId: 'async-command-1', waitedMs: 1, maxWaitMs: config.maxWaitMs })],
    ['agentRecheckFailedNote', output.agentRecheckFailedNote({ lang: agentLang, agentId: 'sa-1', waitedMs: 1, maxWaitMs: config.maxWaitMs })],
    ['interruptedNote(agent)', output.interruptedNote({ lang: agentLang, subject: 'subagent sa-1', waitedMs: 1, resume: 'async_wait(...)' })],
    ['yieldDigest', output.yieldDigest(config)],
    ['waitDigest', output.waitDigest(config)]
  );
  // 等待预算的必填报错（需求 §5.3：工具抛错也走双语档；空串=取样失败，zh 档判据必红）。
  let waitError = '';
  try { resolveWait(undefined, resolveConfig({ agentLang })); } catch (error) { waitError = String(error?.message ?? error); }
  samples.push(['error.waitRequired', waitError]);
  // 编排完成渲染（端到端；render.workflowCompleted + detail.workflowAgents）。
  samples.push(['render(workflow completed)', await collectWorkflowCompletedRender(agentLang)]);
  return samples;
}

let runtimeReady = true;
const RUNTIME = {};
try {
  RUNTIME.en = await collectSamples('en');
  RUNTIME.zh = await collectSamples('zh');
} catch (error) {
  runtimeReady = false;
  console.error(`FAIL  运行时层无法装载（${String(error?.message ?? error)}）——请用 \`npm run check:model-text\`（带 --import ./tools/_host-hooks.mjs）运行`);
  failures++;
}

if (runtimeReady) {
  let runtimeFailures = 0;
  for (const [label, text] of RUNTIME.en) {
    if (CJK.test(text)) {
      console.error(`FAIL  [runtime en] ${label} 出现 CJK：${text.slice(0, 80)}`);
      runtimeFailures++;
    }
  }
  const enMap = new Map(RUNTIME.en);
  for (const [label, text] of RUNTIME.zh) {
    if (!CJK.test(text)) {
      console.error(`FAIL  [runtime zh] ${label} 不含中文（缺译或语言未生效）：${text.slice(0, 80)}`);
      runtimeFailures++;
    } else if (enMap.get(label) === text) {
      console.error(`FAIL  [runtime zh] ${label} 与 en 档逐字相同（语言开关没换到它）：${text.slice(0, 80)}`);
      runtimeFailures++;
    }
  }
  failures += runtimeFailures;
  if (runtimeFailures === 0) {
    console.log(`运行时层通过（en ${String(RUNTIME.en.length)} 条零 CJK；zh ${String(RUNTIME.zh.length)} 条全部换语言）。`);
  }
}

if (failures > 0) {
  console.error(`\n面向模型的文案检查失败：合计 ${String(failures)} 处。`);
  process.exit(1);
}
console.log('\n面向模型的文案检查通过（表层 + 源码层 + 硬编码文案层 + 运行时层）。');
