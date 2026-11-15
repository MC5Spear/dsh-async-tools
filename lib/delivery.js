/**
 * 交付账本（设计 §2.6、§3.2.5）：作业结果的批次化直接交付。
 *
 * 三个职责面：
 * - **保活链**（设计 §2.3）——作业转入后台后 `jobs.wait` 按保活窗口续排，结算前始终
 *   有本包 waiter 在册（宿主以结算时刻在册 waiter 抑制自带完成通知，本包完成消息成为
 *   唯一含正文交付）。保活窗口 60 秒、相邻窗口交叠：每个窗口在过半（中点）时预注册
 *   下一窗口，「到期离集与续排入集之间」无空档；首次等待自身的 waiter 即链的零号
 *   窗口，首个保活窗口在零号窗口过半时预注册（零号窗口到期让出或提前结束时首窗口
 *   已在册——提前结束路径同步注册首窗口，中间不让出事件循环）。频率界（每作业每
 *   30 秒至多一次新注册）指保活链注册的稳态；链入口过渡（零号窗口→首个保活窗口）
 *   的注册间隔为零号窗口之半（首次等待预算之半），可短于 30 秒。
 * - **批次与预算**（设计 §2.6）——一个交付批次＝同一主体将共同进入下一次模型输入的本包
 *   交付内容集合；领取窗口按可观察事实识别：等待类调用的执行窗口（就绪内容并入该次
 *   调用的返回）、无活等待时作业结算由完成消息交付（完成消息本身即开启一个批次）。
 *   批在可观察的领取点关闭：主体的 `agent/inbox/claimed` 领取事件，或该主体全部本包
 *   活等待均已返回提交（并行以最后一个为准）。**内容预算的记账单位是输入代，不是
 *   批次**（§2.6「共同输入的预算记账」）：账本按主体维护当前输入代的
 *   已交付内容字符（`SubjectRecord.generation`），代边界＝该主体的
 *   `agent/pre-step`（宿主每步模型组稿恰发一次、先于模型调用；重复到达幂等。
 *   中止／回合结束后的空闲投递窗口无组稿事件——残余额度结转，followup 按
 *   投递时刻的代剩余装配，可能整条延后至下一回合首次组稿后领取）；任一批
 *   次的可用内容预算＝`maxResultChars` − 代内已交付
 *   （下限 0），关批只复位批级状态（延后说明配额、回显定值 `echoOn`——批对象
 *   生命周期不变）、不重置代额度。不变量：两次组稿之间交付的本包计费内容（正文份额、
 *   恢复条目正文切片、回显原文）合计 ≤ `maxResultChars`——覆盖同一步骤滚动池
 *   （并行池受限串行派发：先返回者关批后，后进入者不开新代取全额）、不同组与
 *   屏障／审批后错开进入 execute 的调用（同两次组稿之间天然同代）。逐个交付
 *   载体扣减；分配顺序：触发目标
 *   优先，其余按就绪时刻先进先出，同时刻并列按作业 id 字典序；剩余预算为零后
 *   到达的**非空**条目整条延后——空正文条目不受字符预算约束，仍以状态行入批
 *   （REL-BATCH-02：字符预算只约束正文，条目上限对一切条目适用）。代内额度耗尽
 *   后延后的中段至迟在下一次模型输入内可领取（`agent/pre-step` 重置输入代，
 *   其后零等待领取可用全额；`agent/turn-stopping` 不再承担额度重置，只保留
 *   份额确认与退回职责）。单批至多 10 条，满批后到达的条目（含空
 *   正文与读取失败注记）整条延后。完整命令回显（`fullCommandEcho`，ECHO-WORKFLOW-01，
 *   需求 2.2.4/9.3.4）的原文在同一批预算内计量：开批时定值 `echoOn`（同批一致、
 *   关批重取），条目内正文份额优先、原文用剩余份额（6:4 首尾裁剪并标注省略量），
 *   同一作业一次性附上（`echoAttached`，回滚清位后可重投）；预期附上而因预算
 *   未附的条目注记 `delivery.echoSkipped`，正文被裁剪的条目不附也不注记、随
 *   续段在下一批分配。说明分两档＋留存行单列：
 *   必要结局行（状态行 ≤200、退出码/信号标记 <60、诊断首行 ≤200）合计单条目
 *   ≤460、单批 ≤4600（条目上限 10 × 460），不入可裁剪说明的截断序列——退出码、
 *   失败原因、终止事实不因内容预算丢失；可裁剪说明（诊断第二行、lossy 行、延后
 *   说明）单行 ≤200、单条目渲染内合计 ≤2000，超限转一行计数汇总；留存行是定位
 *   数据、单列预算、完整出现或不出现（`MAX_SPILL_TOTAL`，见下）。完成消息路径的
 *   延后说明另有批级配额（REL-NOTES-01）：每批至多 3 条逐条说明＋1 条聚合摘要
 *   （同批同作业去重），合计 ≤4 条 send、≤800 字符，不随批内候选数放大。
 * - **在途仲裁与让位终局复查**（设计 §2.6）——同一作业同时被等待返回与完成消息两路
 *   认领时，以先构造交付内容的一方为认领方（构造点原子置位），后到者只输出状态行。
 *   作业结算时若该主体存在本包活等待，完成消息路径让位；等待返回提交、活等待注销时
 *   复查未交付的就绪内容——该主体已无本包活等待时补开完成消息，不等待模型主动领取。
 *
 * 完成消息经 `followup`（主体空闲）或 `inject`（主体忙）进入收件箱，与迟到作答同一
 * 投递通道（`lib/ask-takeover.js` 的先例）；完成消息与迟到作答共用「待启动投递」登记
 * ——已构造完成、尚未经宿主通道发出的本包投递项清单；同一领取窗口内多作业结算且
 * 主体空闲时，各条完成消息合并为一条 `followup` 轮次投递，不逐条开启轮次。
 *
 * 读取纪律（设计 §2.4）：一次交付只消费一次 `jobs.read` 的增量；宿主读取游标与一次性
 * `result` 通道按宿主契约全局唯一——账本缓冲是已消费正文的唯一持有处，重复等待只
 * 返回新增内容；其他读取方（如原生读取工具）已消费的正文，本包读取时只剩增量。
 *
 * 模块级单例（设计 §2.6「账本随模块单实例驻留」）：与 `lib/settings.js` 的快照同一
 * 成例——宿主行与工具行共用同一模块实例时全局一致；同进程多插件实例各自持有账本。
 *
 * @module dsh-async-tools/delivery
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { LOG_PREFIX } from './config.js';
import { JOB_RESULT_SOURCE, JOB_RESULT_EVENT } from './delivery-sources.js';
import { truncate, omittedMiddle } from './output.js';
import { t } from './text.js';

/** 保活窗口长度（设计 §2.3：60 秒）。 */
const BEAT_MS = 60_000;

/** 预注册点：保活窗口过半（设计中点，交叠由相邻窗口衔接）。 */
const HALF_BEAT_MS = BEAT_MS / 2;

/** 单批交付条目上限（设计 §2.6：与宿主单主体并发出厂上限一致）。 */
const MAX_BATCH_ITEMS = 10;

/**
 * 恢复份额上限三件（RESULT-RECOVERY-01 §2.6）：份额期限（按各自登记时刻惰性
 * 清扫，无定时器——恢复请求、确认与下一次装配时点现查现清）；单主体条数上限
 * （按份额记录计，FIFO 逐出最旧）；单主体字符上限（2×maxResultChars，按在册
 * 份额正文合计，FIFO 逐出，保护本次登记项）。到期或被逐出且未服务完的份额序号
 * 记入丢失清单（第 3 档如实说明缺失范围），清单有界（`RECOVERY_LOST_MAX`）。
 */
const RECOVERY_TTL_MS = 30 * 60 * 1000;
const RECOVERY_MAX_ITEMS = 10;
const RECOVERY_LOST_MAX = 20;

/**
 * 说明上限的两档口径（需求 9.3.2「批次还须限制条目数及预算外状态、标识和
 * 诊断说明的总量……由设计给出有限且可测的规则」）：
 * - **可裁剪说明**：单行至多 200 字符，超长截断（诊断次行、未附注记等外部
 *   字符串长度无界，必须在此入界）；单条目渲染内合计至多 2000——超限保留
 *   状态行、可裁剪说明合并为一行计数汇总（正文不受限——只约束说明）。粒度是
 *   **单条目渲染**：`renderCompletionMessage` 的 `used` 随条目重置、pendingSend
 *   的 items 恒单条目；合并 followup 的整条物理消息合计不受本常量控制。
 *   留存路径行不在本档——定位数据单列预算（见 `MAX_SPILL_TOTAL`）。
 * - **必要结局行**（REL-TERMINAL-01）：状态行（≤200）＋退出码/信号标记
 *   （<60）＋诊断首行（≤200）合计单条目 ≤460，单批（条目上限 10）合计
 *   ≤4600——不入可裁剪说明的截断序列，退出码、失败原因、终止事实不因内容
 *   预算丢失。
 */
export const MAX_NOTE_CHARS = 200;
export const MAX_NOTES_TOTAL = 2000;

/**
 * 留存行的单列预算（RA-SPILL-LOCATOR，需求 9.3.2 说明总量有界）：留存路径是
 * 定位数据，不是可裁剪说明——单条留存行不过 clampNote（完整出现或不出现，
 * 绝不用省略号冒充路径），也不与可裁剪说明共用 MAX_NOTES_TOTAL；条目内留存
 * 行合计超限的余量以计数行（`delivery.spillOverflow`）报告。说明总量的预算
 * 目标＝两档预算（可裁剪说明＋留存行）加溢出计数行（经 clampNote ≤200；
 * readFailed 单行同不入档，存量形态），但**不是**对所有路径行的固定总上界：
 * 首条超长路径按不可拆单条完整列入（单行无 200 界——截断路径会让定位数据
 * 失效，宁可例外入列）；余下路径的完整找回不靠说明行扩量，由结构化投影的
 * `spill_paths` 字段全量携带（`projectBatchEntry`，模型可按需分页读取）——
 * 说明层总量有界、完整数据走结构化面，两职责不互相迁就。
 */
export const MAX_SPILL_TOTAL = 2000;

/**
 * 完成消息路径延后说明的批级配额（REL-NOTES-01，需求 9.3.2「批次还须限制……
 * 预算外状态、标识和诊断说明的总量」）：每批至多 MAX_DEFERRED_NOTE_ITEMS 条
 * 逐条说明（`delivery.deferredNotice`，含作业标识与定向领取示例）＋至多
 * MAX_DEFERRED_NOTE_SUMMARIES 条聚合摘要（`delivery.deferredAggregate`，计数＋
 * 不带 targets 的零等待一并领取示例），同批同作业去重——合计单批 ≤4 条 send、
 * ≤800 字符（每条经 clampNote 入界），不随批内候选数放大。配额状态挂在本批
 * 对象上（`deferredNotes` 惰性初始化），随两处关批点丢弃批对象自然复位
 * （见 #pushBoundedDeferredNote）。
 */
export const MAX_DEFERRED_NOTE_ITEMS = 3;
export const MAX_DEFERRED_NOTE_SUMMARIES = 1;

/** 单条说明入界：超长截断（尾部省略号占 3 字符），原文已另存的不受影响。 */
export function clampNote(text) {
  const value = String(text ?? '');
  return value.length <= MAX_NOTE_CHARS ? value : `${value.slice(0, MAX_NOTE_CHARS - 3)}...`;
}

/** 宿主终态集合（completed / killed / failed）。 */
const TERMINAL = new Set(['completed', 'killed', 'failed']);

const isTerminal = (status) => TERMINAL.has(status);

/**
 * 读取回执的增量文本（设计 §2.4）：chunks 拼接 + 首次终态一次性 `result`
 * （增量在前、`result` 在后，中间仅在增量非空且不以换行结尾时补换行——与宿主
 * `job_output` 的消费读取一致）。
 *
 * **进度日志按展示开关先筛选**（设计 2.4／`workflowProgressLog`，需求 9.3.4）：
 * `log` 通道是观察者叙述（编排的阶段与子代理起讫），默认**不进**模型正文——与
 * 宿主 `job_output` 的 `renderModelDelta` 同判（滤 `channel === 'log'`）；开启
 * `workflowProgressLog` 后并入（并随批次预算统一裁剪——先筛选后裁剪，筛选在
 * 读取层、裁剪在分配层，互不重复）。命令作业没有 log 通道行，过滤对它无影响。
 */
function chunksTextOf(read, includeLog = false) {
  const chunks = Array.isArray(read?.chunks) ? read.chunks : [];
  const usable = includeLog
    ? chunks
    : chunks.filter((chunk) => chunk?.channel !== 'log');
  const delta = usable.map((chunk) => (typeof chunk?.text === 'string' ? chunk.text : '')).join('');
  if (read?.result === undefined) return delta;
  return `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}${read.result}`;
}

/** 读取回执的输出留存线索（`JobView.output.spillPaths`，读取回执的 job 字段）。 */
function spillPathsOf(read) {
  const paths = read?.job?.output?.spillPaths;
  return Array.isArray(paths) ? paths.filter((path) => typeof path === 'string' && path.length > 0) : [];
}

/** 日志出口（与全包一致的前缀诊断，不抛出）。 */
function log(message) {
  try {
    console.warn(`${LOG_PREFIX} ${message}`);
  } catch { /* 诊断通道自身失败不放大 */ }
}

/**
 * 账本主体条目：活等待集合、当前批与待启动投递登记。
 * 「主体」按宿主会话标识（owner SessionId）区分——消息投递与等待都以它为键。
 */
class SubjectRecord {
  constructor() {
    /** @type {Set<object>} 活等待令牌（claimWait 登记、releaseWait 注销）。 */
    this.activeWaits = new Set();
    /**
     * @type {Set<{kind: 'run'|'workflow', signal: object|null}>} 在途创建认领
     * （ACCEPT-BATCH-01，设计 §2.6「准备期窗口」）：async_run／async_workflow 的
     * execute 自参数校验通过、进入目录准备前（§3.1／§3.4）的同步前缀登记，任意
     * 出口注销——「活等待＋在途创建」合称本包窗口成员：并发创建调用的首次等待
     * 尚未 claimWait 时，先结算方的关批／完成消息让位不得提前关窗开新批取全额
     * 预算（双份预算形态）。令牌记录调用类型与取消信号，供回合收尾清扫判别
     * （宿主改写取消后 execute 悬挂的边角）。async_wait 不认领——以活等待登记（claimWait）参与共享预算；async_agent 不携带作业内容，不入批。
     */
    this.inFlightCreations = new Set();
    /**
     * 当前批：`null`＝无开批；`{ remaining, items }`＝已开批——`remaining` 为该批
     * 剩余字符预算（开批时自输入代剩余取值：`maxResultChars` − 代内已交付，见
     * `generation`；**关批不重置代额度**，下一批自最新代剩余开），`items` 为该批
     * 已装配条目数（等待返回与完成消息共用，受单批条目上限约束，设计 §2.6）。
     * 开批＝第一个交付载体构造；关批＝领取事件或全部活等待提交（设计 §2.6）。
     * 可选 `echoOn`＝完整命令回显在本批的定值（ECHO-WORKFLOW-01：开批时点现读
     * `fullCommandEcho` 并**绑定批对象**——同批全部装配用同值，关批后下一批重取，
     * 进行中批次不因设置翻转重算已构造内容）。可选 `deferredNotes` 字段＝本批
     * 延后说明配额状态（#pushBoundedDeferredNote 惰性初始化；关批随批对象一起
     * 丢弃复位）。
     */
    this.batch = null;
    /**
     * 当前输入代的已交付内容字符（§2.6「共同输入的预算记账」）：
     * 记账单位是输入代，不是批次——两次组稿之间交付的本包计费内容（正文份额、
     * 恢复条目正文切片、回显原文）合计 ≤ `maxResultChars`。代边界＝该主体的
     * `agent/pre-step` 事件重置（宿主每步模型组稿恰发一次、先于模型调用——
     * 无新消息的步骤同样组稿，领取事件覆盖不了这类输入边界；重复到达幂等。
     * 中止／回合结束后的空闲投递窗口无组稿事件——残余额度结转，followup 按
     * 投递时刻的代剩余装配，可能整条延后至下一回合首次组稿后领取）。任一批
     * 次开批时 `remaining = max(0, maxResultChars − spent)`；每个交付载体对批
     * 的扣减（含预留-结账差额退还）与 `spent` 同步（#chargeBatch／#refundBatch），
     * 关批只丢弃批对象、`spent` 保持；`agent/turn-stopping` 不参与额度
     * （只保留份额确认与退回职责）。
     * @type {{spent: number}}
     */
    this.generation = { spent: 0 };
    /** @type {Array<{kind:'completion', message: object, jobId: string}>} 待启动投递登记。 */
    this.pendingSends = [];
    /**
     * 恢复份额登记（§2.6 份额登记；RESULT-RECOVERY-01）：jobId →
     * 份额数组（`{ ord, text, partial, terminal, registeredAt, returned,
     * via, signal? }`，按登记次序并存）。
     * 已装配进载体、送达未经确认内容的主体级份额登记——不复用 `JobRecord.buffer`
     *（buffer 是「已消费未交付」，份额是「已装配未确认」，清理时机与读取入口
     * 都不同）。份额＝一次装配进单个载体的正文单元（批次终态条目、运行中增量的
     * 每次装配、首等直付直付文本、完成消息入箱正文各成一份）；同一作业的多份
     * 份额按登记次序并存（无单槽覆盖守卫——旧 `returned` 份额不被顶掉、也不
     * 阻止新份额入册，连续取消的各份额都有恢复锚点）。确认／退回判据按载体
     * 逐份额成立（§2.6 表）：`via: 'wait'`／`'firstwait'` 由回合收尾事件确认、
     * `via: 'message'` 由领取事件确认；`returned` 标记的份额（改写取消/丢弃退回）
     * 只经期限、逐出、行卸载或恢复流服务完成清理，任何确认信号无效（M1 豁免）。
     * `signal` 是装配调用的 `exec.signal`（回合收尾确认时的中止复检凭据，R3
     * 收窄）。`ord` 是作业内份额序（登记时递增，供恢复位置说明与缺失说明引用）。
     * 上限三件与惰性清扫见 `RECOVERY_TTL_MS` 处注释。
     * @type {Map<string, object[]>}
     */
    this.recoveries = new Map();
    /**
     * 恢复流游标（§2.6「恢复流装配」）：jobId → `{ ord, offset, advances }`。
     * `ord`＋`offset`＝当前服务到的份额与份额内偏移（装配点推进）；`advances`
     * 是本回合的推进记录 `{ ord, from, to, signal }`——回合收尾复检取消信号，
     * 中止者把游标回退到最早中止推进的起点（§2.6「推进的确认与回退」），载体
     * 构造失败经 undoClaim 同样回退。份额不在册（已确认/到期/逐出）时按下一
     * 在册份额继续。
     * @type {Map<string, {ord: number|null, offset: number, advances: object[]}>}
     */
    this.recoveryStreams = new Map();
    /**
     * 未服务完即消失（到期/逐出）的份额序号（§2.6 第 3 档缺失说明用）：
     * jobId → 序号数组（FIFO 有界，`RECOVERY_LOST_MAX`）。
     * @type {Map<string, number[]>}
     */
    this.lostPortions = new Map();
    /**
     * 份额序号发放计数（SOL-RC-01「稳定份额身份」）：jobId → 该主体×作业已
     * 发放的最大序号。序号单调递增、份额清空（确认／到期／逐出）后**不复位**
     * ——旧恢复游标与丢失清单中的序号不被新份额复用顶名（复用会让
     * `#recoveryStreamState` 按「游标之前＝已服务」把新输出前部跳过）。清理随
     * 条目卸载（`disposeRow`）与主体记录删除。
     * @type {Map<string, number>}
     */
    this.recoverySeqs = new Map();
    /**
     * 挂起的恢复请求（§2.6 恢复出口第 1 档的消费标记）：显式零等待点名已证
     * 「份额在册且有可服务内容」，下一次 `collectBatch`（同一次调用的出口批次）
     * 装配「标记行＋正文切片＋位置说明行」；批满/预算尽/同批已有恢复条目时整条
     * 延后，保持挂起，下一批自游标续。挂起请求唯一——恢复由显式点名触发，一次至多一个恢复口径（多目标点名末位胜出；与份额登记「不设覆盖守卫」无涉）。
     *  
     * @type {{jobId: string}|null}
     */
    this.stagedRecovery = null;
  }
}

/**
 * 账本作业条目：一个后台作业的交付事实与保活链。
 */
class JobRecord {
  /**
   * @param {object} init
   * @param {object} init.ctx - 装载行上下文（jobs / agents 服务）。
   * @param {object} init.config - 生效配置视图（maxResultChars、agentLang 等）。
   * @param {string} init.jobId
   * @param {unknown} init.owner - 主体（宿主会话标识）。
   */
  constructor({ ctx, config, jobId, owner }) {
    this.ctx = ctx;
    this.config = config;
    this.jobId = jobId;
    this.owner = owner;
    /** 终态事实：`null` 至快照证实终态；`{ status, exitCode, signal, detail }`。 */
    this.terminal = null;
    /**
     * 已消费未交付正文缓冲。清空点＝交付内容构造点（设计 §2.6「清空点、失败
     * 分类与不可观测窗口」）：构造即认领并清空对应部分，调用方提交失败按真实
     * 装配回滚（undoClaim）；宿主提交后的改写属不可观测窗口，不在此处理。
     * 被裁剪条目的未交付中段按装配前原文保留在缓冲（partial 交付，见
     * deliveredFact），经延后交付或零等待领取恢复，不因裁剪永久丢失。
     */
    this.buffer = '';
    /** 读取截断与溢出留存线索（最近一次读取，随载体呈现）。 */
    this.lossy = false;
    this.spillPaths = [];
    /**
     * 留存行已列游标（RA-SPILL-LOCATOR，设计 §2.6「留存路径的完整领取」）：
     * `spillPaths` 中前 `spillListed` 条已随先前载体的说明行列出——幂等不重发；
     * 余量经显式作业目标零等待分页领取（每次至少列入一条）。宿主报告的留存
     * 清单次序变化（重排）时归零重列（重复列出无害，按游标跳过有错位风险）。
     */
    this.spillListed = 0;
    /**
     * 回显原文（ECHO-WORKFLOW-01，需求 2.2.4/9.3.4）：注册时点无条件存入的
     * 命令原文或工作流脚本原文——**存储与展示分离**，是否附上由批次装配点的
     * `echoOn` 定值决定（见 SubjectRecord.batch）。空串＝不适用（账本外发现的
     * 外来作业没有本包可附的原文），该条目永不附。
     */
    this.echoText = '';
    /** 回显类别（标签行取词）：`'command'`｜`'script'`；echoText 为空时无意义。 */
    this.echoKind = '';
    /**
     * 原文一次性附上状态（ECHO-WORKFLOW-01 设计 §2.3 同窗去重第 2 层）：
     * `true`＝原文已随任一载体装配，后续批次（含 partial 续段、让位复查）不再
     * 附；仅投递回滚（undoClaim 按凭据 `echoAttached` 标记）清除后可重投，
     * 宿主已接受的交付不回滚、不清位。
     */
    this.echoAttached = false;
    /** 一次性 `result` 是否已被消费（宿主契约：首次终态一次性通道）。 */
    this.resultConsumed = false;
    /**
     * 本包工具注册的作业标记（§2.3 外来作业边界）：`true`＝async_run／
     * async_workflow 启动时经 noteJobStarted 入账；外来作业（含主体自有的
     * 非本包作业与无主公开作业）为 `false`——事件订阅处理与本包作业的交付
     * 机划分按本标记避让（本包作业的首次等待／#beat 自有路径）。
     */
    this.own = false;
    /**
     * 结算是否在本包在册 waiter 观察下发生（§2.3）：保活链窗口释放、首次等待
     * 结算、事件通道 jobs.wait 释放＝`true`（宿主 `awaited` 抑制成立）；快照／
     * 枚举首见即终态、抑制失败的结算＝`false`——此时正文可能已被宿主通知层
     * 消费，空读取走 §2.3 的正文去向判别。
     */
    this.observedSettlement = false;
    /**
     * 正文去向判别结论（§2.3「结算未经观察、正文已被消费时的如实说明」）：
     * `null`＝无需判别（读取有可消费正文，或结算已在观察下）；`'arrived'`＝
     * 正文已随宿主完成通知进入模型上下文（不复制）；`'held'`＝留存宿主通知层
     * （结算预读已消费、通知未内联）；`'unknown'`＝无法确认去向。读取无可消费
     * 正文（无增量且无 `result`）且结算未经观察时由判别器置位，随首个终态条目
     * 载体呈现（deliveredFact 承担其后去重）。
     */
    this.bodyDisposition = null;
    // HELD-RECOVER-01：held／unknown 判别经包内恢复通道取回正文的成功标记
    //（诊断锚——取回后去向结论清空，正文走正常批次路径交付）。
    this.heldRecovered = false;
    /** 就绪时刻（单调时钟；FIFO 分配次序），未就绪为 `null`。 */
    this.readyAt = null;
    /**
     * 已交付事实：`null` 或 `{ via, partial? }`。`partial: true`＝首尾已交付、
     * 省略中段仍在缓冲，可继续进批（续段）；完全交付（无 partial）对后续一切
     * 交付路径阻断——已交付的作业不再进入批次候选、不再触发被动完成消息。
     */
    this.deliveredFact = null;
    /** 在途仲裁认领方（设计 §2.6 构造点原子置位）：`null | 'wait' | 'message'`。 */
    this.claimedBy = null;
    /**
     * 最近一次读取失败：终态读取（WAIT-READ-01）与运行中增量读取
     * （WAIT-INCREMENT-01）共用本字段。`true`＝正文读取失败——终态路径终态
     * 已证实；增量路径作业可能仍在运行（失败的是增量读取，不是作业结局）。
     * 两条路径共用的口径不变：不置已交付事实、不按空结果交付，批次中只投
     * 状态行与重试出路；读取成功后清除。与「成功读取到空正文」区分，不互相
     * 冒充。
     */
    this.readFailed = false;
    /**
     * 本次读取失败的通知占位（REL-READ-02，跨载体一次性判据）：批次状态行与
     * 完成消息注记共用判据 `readFailed && !readFailedNoted`——任一载体装配该
     * 通知即置位，使「每次读取失败至多一条模型可见通知」（9.3.2「不多发只
     * 要求再次读取的通知」）。清除仅两处：注记回滚（通知没送达）与新一次
     * 读取失败的定论处（新失败可再通知）；读取成功时 `readFailed` 翻回
     * `false`，判据自然失效，陈旧占位无须另清。
     */
    this.readFailedNoted = false;
    /**
     * 送达确认时刻（RESULT-RECOVERY-01 §2.6）：`null`＝未确认；确认信号到达
     * 时置位（等待载体＝回合收尾事件、完成消息载体＝领取事件，见 SubjectRecord
     * .recoveries 的分载体判据）。确认后同名作业的显式零等待按第 2 档交回
     *（现行口径：状态行＋已交付说明，不重发正文）；未确认且有份额在册的按
     * 第 1 档恢复（标记行＋正文切片＋位置说明行）。
     */
    this.confirmedAt = null;
    /** 在途读取 Promise（去重并发读取）。 */
    this.readInFlight = null;
    /** 保活链状态：`null`＝未挂链。 */
    this.chain = null;
  }
}

/**
 * 交付账本。全部状态按主体与作业双索引；行卸载走行级清扫（`disposeRow`，
 * REL-LIFECYCLE-01）——卸载一行只清该行创建的条目，末行卸载才整体回收
 * （`disposeAll`）。
 */
export class DeliveryLedger {
  constructor() {
    /** @type {Map<string, JobRecord>} */
    this.jobs = new Map();
    /** @type {Map<unknown, SubjectRecord>} */
    this.subjects = new Map();
    /** job_output 隐藏形态判读（HELD-RECOVER-01）：Agent → boolean，由
     * lib/index.js 在隐藏挂点登记（WeakSet 现查）；null＝未登记（通道停用，
     * held／unknown 按 *_native 档指路原生入口——不猜隐藏形态）。 */
    this.jobOutputHiddenFor = null;
    /** claimed 监听（关批锚点）：装载行 ctx → disposer。 */
    this.claimedDisposers = new Map();
    /** 在册装载行 ctx 集合（显式行登记，`disposeRow` 末行判定用，见 registerRow）。 */
    this.rows = new Set();
    /** 单调时钟（可注入替身，测试锚定 FIFO 次序）。 */
    this.now = () => Number(process.hrtime.bigint() / 1_000_000n);
  }

  /** 主体条目（无则建）。 */
  #subject(owner) {
    let record = this.subjects.get(owner);
    if (record === undefined) {
      record = new SubjectRecord();
      this.subjects.set(owner, record);
    }
    return record;
  }

  /**
   * 本包自身 `jobs.start` 的同步再入计数（§2.3 事件登记的防串账守卫）：
   * `registered` 事件在 `jobs.start()` 内同步发出，先于 noteJobStarted——
   * 订阅处理据本计数跳过本包自己的作业（其登记由工具路径接管）。计数由
   * `beginOwnJobStart`／`endOwnJobStart` 成对维护（jobs.js／workflow.js 的
   * start 调用点 try/finally 包裹）。
   */
  #ownStartDepth = 0;

  /** 进入本包自身 start（见 `#ownStartDepth`）。 */
  beginOwnJobStart() {
    this.#ownStartDepth += 1;
  }

  /** 退出本包自身 start（见 `#ownStartDepth`；与 begin 成对，下限 0）。 */
  endOwnJobStart() {
    this.#ownStartDepth = Math.max(0, this.#ownStartDepth - 1);
  }

  /** 本包自身 start 是否在同步进行（订阅处理跳过判据）。 */
  ownJobStartInFlight() {
    return this.#ownStartDepth > 0;
  }

  /**
   * 无主公开作业的按主体分册键（§2.6 宿主所有权与交付分账）：作业 id 与宿主
   * 会话标识以 U+0000 连接——宿主作业 id 形如 `kind-<16hex>`，不含该分隔符，
   * 分册键与裸 id 命名空间不相交（有主作业恒用裸 id，行为与旧键控一致）。
   * @param {string} jobId - 作业标识。
   * @param {unknown} owner - 主体（宿主会话标识）。
   * @returns {string} 分册键。
   */
  static sharedJobKey(jobId, owner) {
    return `${jobId}\u0000${String(owner)}`;
  }

  /**
   * 按主体解析条目（§2.6 分账）：有主作业单条记录（键＝裸 id，宿主隔离语义
   * 仅该主体可访问）；无主公开作业按主体分册（键＝分册键，游标／交付事实／
   * 批次与恢复份额按主体维护）。裸键命中但主体不符时返回 `undefined`——
   * 有主条目不属于该主体，不回落到分册键（第二主体对无主作业另有自己的
   * 分册，对有主作业按查无口径处理）。
   * @param {string} jobId - 作业标识。
   * @param {unknown} owner - 主体。
   * @returns {object|undefined} 该主体的条目（无则 undefined）。
   */
  entryFor(jobId, owner) {
    const bare = this.jobs.get(jobId);
    if (bare !== undefined) return bare.owner === owner ? bare : undefined;
    return this.jobs.get(DeliveryLedger.sharedJobKey(jobId, owner));
  }

  /**
   * 开批（各开批点共用，设计 §2.6）：预算初始化＋回显定值一并完成。
   * 内容预算自输入代剩余取值（`maxResultChars` − 代内已交付，下限 0——
   * §2.6 预算记账上移到输入代；关批不重置代额度，此处按最新代剩余开）。
   * 跨载体 config 保守口径：代内 `spent` 不区分各批的 `maxResultChars`
   * 差异（同代内先小后大的载体仍被先前的累计扣减压缩）——代是宿主事实
   * （同一输入代只有一个 `maxResultChars` 生效，配置改动经宿主设置链在
   * 新输入代生效），按「本载体 full − spent」开批是保守方向。
   * `echoOn` 在开批时点现读 `config.fullCommandEcho`（活视图）并绑定批对象
   * （ECHO-WORKFLOW-01 设计 §5「后续调用生效、进行中批次不变更」）——同批
   * 全部装配用同值；关批丢弃批对象，下一批重取。
   */
  #newBatch(subject, config) {
    const full = Math.max(1, Number(config?.maxResultChars ?? 4096));
    return {
      remaining: Math.max(0, full - subject.generation.spent),
      items: 0,
      // 同批单恢复条目标记（§2.6：不区分同异作业——单批只装配一个恢复条目，
      // 其余份额保持在册、下一批自游标续）。
      recoveryAssembled: false,
      echoOn: config?.fullCommandEcho === true
    };
  }

  /**
   * 批内容扣减（§2.6 输入代记账）：批剩余与代内已交付同步变动——同代内
   * 跨批的合计约束（≤ `maxResultChars`）由 `generation.spent` 承载，批对象
   * 只是当前批的视图。
   */
  #chargeBatch(subject, batch, chars) {
    batch.remaining -= chars;
    subject.generation.spent += chars;
  }

  /** 批内容退还（预留-结账差额）：批剩余与代内已交付同步回退（下限 0）。 */
  #refundBatch(subject, batch, chars) {
    batch.remaining += chars;
    subject.generation.spent = Math.max(0, subject.generation.spent - chars);
  }

  // ── 装配（工具行 apply 调用一次）────────────────────────────────────────

  /**
   * 挂 `agent/inbox/claimed`／`agent/inbox/discarded`／`agent/pre-step`／
   * `agent/turn-stopping` 监听（关批锚点＋输入代边界＋送达确认，设计 §2.6／
   * RESULT-RECOVERY-01 分载体判据）：
   *
   * - `claimed`：主体的领取点关闭当前批（既有行为），并按**载体消息身份**
   *   确认完成消息份额（领取＝正文已作为 user/message 进入模型上下文；载荷
   *   `message.id` 与份额登记的 `messageId` 相等才确认，无关消息的领取零
   *   份额变动——ACCEPT-RECOVERY-MESSAGE-01）。
   * - `discarded`：取消待处理输入＝完成消息载体退回——按同一身份匹配把
   *   **该消息**的份额置 `returned` 标记、保持未确认（可恢复，M1 豁免），
   *   不清批（无领取发生）；其他消息的份额不受影响。
   * - `pre-step`（§2.6 共同输入的预算记账条）：**输入代边界**——宿主每步
   *   组稿恰发一次（先于模型调用；无新消息的步骤同样组稿），到达即上一输入
   *   代结束、该主体的内容预算重置。被 waterfall 拒绝或中止的步骤（组稿已
   *   发生、模型调用未发生）消耗一次无内容的重置，方向无害。它是 rc.1
   *   唯一准入宿主树已核在场的事件；未来宿主若无该事件，不得静默退化为
   *   回合记账（会重新引入同回合后续步骤无法续取的缺陷）——按 7.3 准入
   *   重核判据处理（挂失败本身已 log，不另建定时器替代）。
   * - `turn-stopping`：回合收尾（本 turn 全部 tool/result 已持久提交之后发出）
   *   确认等待载体的恢复副本；监听时点复检副本的 `signal`（装配调用的
   *   `exec.signal`）——中止即按退回处理（改写取消的正文从未进入
   *   模型上下文，按确认列字面处理会清掉唯一副本）。它**不再承担额度重置**
   *   （回合记账会把同回合后续模型步骤的合法续取压到回合末——§2.6 输入代
   *   条定稿返修），份额确认与退回职责不变。
   *
   * cordis 事件沿祖先链可达——预设行 ctx 能收到其下会话 agent 的事件
   * （宿主先例：`dsh-tool-jobs` 的 wakeup 预算、`dsh-user-questions` 的待答清理）。
   * 各事件按宿主公开契约消费，不另行自建定时器替代（`agent/pre-step` 在
   * 准入树静态已核；其余事件 rc.2／rc.5 已核，rc.3／rc.4 由实现轮静态核对，
   * 缺席某事件时该确认信号降级为仅依赖另一信号＋期限，§7 第 3 条）。
   * 返回 dispose，由行卸载处置。
   */
  attachClaimedListener(ctx) {
    if (this.claimedDisposers.has(ctx)) return () => {};
    const closeBatch = ({ agent }) => {
      const owner = agent?.id;
      if (owner === undefined) return;
      const subject = this.subjects.get(owner);
      if (subject === undefined) return;
      // 领取点只关批（下一批按代内剩余开批——全额仅在代重置后）。**不清
      // pendingSends**：待投递项的正文已从缓冲清出、凭据在项上，由下一次
      // flush 消费——清空即丢内容（push 与 flush 之间的微任务窗口内正是
      // claimed 可能到达的时刻）。
      subject.batch = null;
    };
    const onClaimed = (payload) => {
      closeBatch(payload);
      // 份额确认按载体消息身份匹配（ACCEPT-RECOVERY-MESSAGE-01 设计 §2.6）：
      // 宿主逐消息发 claimed（载荷含 `message`），只有 `message.id` 与份额登记
      // 的 `messageId` 相等的完成消息份额被确认；载荷无消息身份或份额无
      // `messageId`（热更边界前登记的旧份额）时零份额变动（保守——保恢复能力）。
      this.#confirmDeliveries(payload?.agent?.id, 'message', payload?.message?.id);
    };
    const onDiscarded = ({ agent, message }) => {
      const owner = agent?.id;
      const messageId = message?.id;
      if (owner === undefined) return;
      const subject = this.subjects.get(owner);
      if (subject === undefined) return;
      this.#sweepRecoveries(subject);
      // 退回判据（§2.6 表）：按载体消息身份匹配——被丢弃消息的 id 与份额
      // `messageId` 相等的完成消息份额置 `returned`（M1：此后任何确认信号对其
      // 无效，只经期限、逐出、行卸载或恢复流服务完成清理——正文可恢复）；
      // 无关消息的丢弃与旧份额（无 `messageId`）零变动。
      if (messageId === undefined) return;
      for (const portions of subject.recoveries.values()) {
        for (const copy of portions) {
          if (copy.via === 'message' && copy.messageId === messageId) copy.returned = true;
        }
      }
    };
    // 输入代边界（§2.6 共同输入的预算记账条）：agent/pre-step＝宿主每步模型
    // 组稿的确定性边界（每步恰一次、先于模型调用、无新消息步骤也组稿）——
    // 到达即上一代结束、该主体的内容预算重置为全额。重复到达幂等（重置同一
    // 初值）；中止路径不派发 turn-stopping 不影响本锚——代边界只看组稿事实。
    const onPreStep = ({ agent }) => {
      const owner = agent?.id;
      if (owner === undefined) return;
      const subject = this.subjects.get(owner);
      if (subject === undefined) return;
      subject.generation.spent = 0;
    };
    const onTurnStopping = ({ agent }) => {
      const owner = agent?.id;
      if (owner === undefined) return;
      const subject = this.subjects.get(owner);
      if (subject === undefined) return;
      // 回合收尾不重置内容预算（§2.6 输入代条定稿返修：回合记账会把同回合
      // 后续模型步骤的合法续取压到回合末）——额度只随 agent/pre-step 重置；
      // 中止／空闲投递窗口的残余额度结转（已知边界②：期间无组稿事件，
      // followup 按投递时刻的代剩余装配，可能整条延后至下一回合首次组稿后）。
      // 本监听保留份额确认与退回、悬挂创建清扫职责（判据不变）。
      this.#sweepRecoveries(subject);
      // 悬挂创建认领清扫（ACCEPT-BATCH-01，设计 §2.6）：宿主把调用改写为取消后
      // execute 仍悬挂的边角——回合收尾按取消信号清掉在册认领，防其无限期压住
      // 后续窗口的关批与让位（execute 真正退出时 releaseCreation 照常对空集注销，
      // 幂等）。只清集合成员，不触发交付——悬挂调用的 finally 是注销与复查的
      // 正规出口。
      let sweptCreations = false;
      for (const token of [...subject.inFlightCreations]) {
        if (token.signal?.aborted !== true) continue;
        subject.inFlightCreations.delete(token);
        sweptCreations = true;
      }
      // 清扫复查交付（ACCEPT-CANCELLED-CREATION-01）：取消的悬挂创建被清扫后，
      // 窗口若因此空闲（无活等待、无在途创建），就绪正文失去悬挂 execute 退出时
      // `releaseCreation` 这唯一正规复查出口——按该出口同款补一次「让位终局
      // 复查＋关批」（异步发出，不阻塞收尾事件；复查期间新开批的窄交错与
      // §2.6 已登记边缘同类处置）。悬挂 execute 之后的 finally 注销对空集幂等。
      if (sweptCreations && subject.activeWaits.size === 0 && subject.inFlightCreations.size === 0) {
        this.#idleReviewAfterSweep(owner, subject);
      }
      // 等待载体判据按判据表第一行统一（§2.6）：等待返回与首次等待直付同列
      // 载体——回合收尾逐份额确认，两者一体适用。
      for (const [jobId, portions] of [...subject.recoveries.entries()]) {
        const rest = [];
        let confirmedAny = false;
        for (const copy of portions) {
          if ((copy.via !== 'wait' && copy.via !== 'firstwait') || copy.returned === true) {
            rest.push(copy);
            continue;
          }
          // 中止复检：监听时点复检装配调用的中止信号——命中按退回处理，不确认
          //（改写取消的正文从未进入模型上下文，确认会清掉唯一副本）。
          if (copy.signal?.aborted === true) {
            copy.returned = true;
            rest.push(copy);
            continue;
          }
          const entry = this.entryFor(jobId, owner);
          if (entry !== undefined) entry.confirmedAt = this.now();
          confirmedAny = true;
        }
        if (!confirmedAny) continue;
        if (rest.length > 0) subject.recoveries.set(jobId, rest);
        else {
          subject.recoveries.delete(jobId);
          // 份额清空后的流校正（SOL-RC-01）：确认删除份额时同步清流记录——
          // 定案（下方 #finalizeRecoveryAdvances）只处理仍在册的份额，此处不
          // 清则游标滞留在已确认份额上，后续同作业新份额的前部会被按「游标
          // 之前＝已服务」跳过。
          this.#correctEmptyStream(subject, jobId);
        }
      }
      // 恢复流的推进定案（§2.6「推进的确认与回退」）：中止者回退游标，未中止
      // 者定案；服务到末尾且无待回退推进的份额清除并置作业确认标记。
      this.#finalizeRecoveryAdvances(subject, owner);
    };
    const disposeListeners = [];
    const attach = (name, listener) => {
      try {
        // cordis `ctx.on` 返回撤销函数——不走 `ctx.off`（服务访问静态扫描会把
        // 它当未声明服务，而事件 API 本就不是 inject 服务）。
        return { ok: true, dispose: ctx.on(name, listener) };
      } catch (error) {
        log(`${name} listener attach failed: ${String(error?.message ?? error)}`);
        return { ok: false, dispose: null };
      }
    };
    const claimed = attach('agent/inbox/claimed', onClaimed);
    if (!claimed.ok) {
      // 挂失败的行不占 disposer 键（REL-LIFECYCLE-01 M2/L8 契约：按键数判行
      // 会把挂失败行计入关批锚点，卸载时误触发整体释放）——辅助监听未挂，
      // 返回空函数，与既有行为一致。
      return () => {};
    }
    disposeListeners.push(claimed);
    disposeListeners.push(attach('agent/inbox/discarded', onDiscarded));
    disposeListeners.push(attach('agent/pre-step', onPreStep));
    disposeListeners.push(attach('agent/turn-stopping', onTurnStopping));
    const dispose = () => {
      for (const { dispose: one } of disposeListeners) {
        try {
          if (typeof one === 'function') one();
        } catch { /* 已卸载的通道再撤不放大 */ }
      }
      this.claimedDisposers.delete(ctx);
    };
    this.claimedDisposers.set(ctx, dispose);
    return dispose;
  }

  /**
   * 送达确认（RESULT-RECOVERY-01 §2.6）：按载体判据把未退回份额转为已确认
   * （条目置 `confirmedAt`、删该份额记录）。`returned` 标记的份额跳过（M1
   * 豁免——退回的正文从未进入模型上下文，清掉即丢唯一副本）。惰性清扫期限
   * 先于一切。
   * @param {unknown} owner - 主体（事件载荷的 agent id）。
   * @param {'wait'|'message'} via - 本次确认信号覆盖的载体（等待载体的
   *   `'firstwait'` 份额不经 `#confirmDeliveries`——回合收尾监听内联处理）。
    * @param {string} [messageId] - 载体消息身份（`via: 'message'` 时＝领取
    *   事件载荷的 `message.id`）：与份额登记 `messageId` 相等的完成消息份额
    *   才被确认；缺席时零份额变动。
   */
  #confirmDeliveries(owner, via, messageId) {
    if (owner === undefined || owner === null) return;
    // 事件无消息身份不构成任何 message 载体的确认证据（旧份额保守滞留）。
    if (via === 'message' && (messageId === undefined || messageId === null)) return;
    const subject = this.subjects.get(owner);
    if (subject === undefined) return;
    this.#sweepRecoveries(subject);
    for (const [jobId, portions] of [...subject.recoveries.entries()]) {
      const rest = portions.filter((copy) => copy.via !== via
        || copy.returned === true
        || copy.messageId !== messageId);
      if (rest.length === portions.length) continue;
      const entry = this.entryFor(jobId, owner);
      if (entry !== undefined) entry.confirmedAt = this.now();
      if (rest.length > 0) subject.recoveries.set(jobId, rest);
      else {
        subject.recoveries.delete(jobId);
        // 份额清空后的流校正（SOL-RC-01）：确认删除份额时同步清流记录，
        // 防止旧游标滞留、掩盖或跳过后续新份额的前部。
        this.#correctEmptyStream(subject, jobId);
      }
    }
  }

  /**
   * 恢复份额的惰性期限清扫（§2.6：无定时器——恢复请求、确认与下一次装配
   * 时点现查现清）。期限按各自份额的登记时刻判定；未服务完即到期的份额序号
   * 记入丢失清单（第 3 档缺失说明用），已被恢复流服务到末尾的不记。
   */
  #sweepRecoveries(subject) {
    if (subject.recoveries.size === 0) return;
    const now = this.now();
    for (const [jobId, portions] of [...subject.recoveries.entries()]) {
      const stream = subject.recoveryStreams.get(jobId);
      const servedThrough = (portion) => stream !== undefined && stream.ord !== null
        && (portion.ord < stream.ord
          || (portion.ord === stream.ord && stream.offset >= portion.text.length));
      const rest = [];
      for (const portion of portions) {
        if (now - portion.registeredAt <= RECOVERY_TTL_MS || servedThrough(portion)) {
          rest.push(portion);
          continue;
        }
        this.#noteLostPortion(subject, jobId, portion.ord);
      }
      if (rest.length > 0) subject.recoveries.set(jobId, rest);
      else {
        subject.recoveries.delete(jobId);
        // 份额清空后的流校正（SOL-RC-01）：到期清扫清空份额时同步清流记录。
        this.#correctEmptyStream(subject, jobId);
      }
    }
  }

  /**
   * 留存清单入账（RA-SPILL-LOCATOR，设计 §2.6「留存路径的完整领取」）：
   * 读取回执报告的留存路径按在册清单去重并入（宿主契约＝按源序去重）；已知
   * 路径在新清单中的相对次序与在册不一致（重排）时，已列游标归零重列——重复
   * 列出无害，按游标跳过有错位风险。
   * @param {object} entry - 作业账面条目（`spillPaths`／`spillListed`）。
   * @param {string[]} fresh - 本次读取回执报告的留存路径。
   */
  #noteSpill(entry, fresh) {
    if (!Array.isArray(fresh) || fresh.length === 0) return;
    const known = new Set(entry.spillPaths);
    const knownInFresh = fresh.filter((path) => known.has(path));
    let prevIndex = -1;
    for (const path of knownInFresh) {
      const at = entry.spillPaths.indexOf(path);
      if (at < prevIndex) {
        entry.spillListed = 0;
        break;
      }
      prevIndex = at;
    }
    const added = fresh.filter((path) => !known.has(path));
    if (added.length > 0) entry.spillPaths = [...entry.spillPaths, ...added];
  }

  /** 丢失份额序号登记（FIFO 有界，`RECOVERY_LOST_MAX`）。 */
  #noteLostPortion(subject, jobId, ord) {
    let lost = subject.lostPortions.get(jobId);
    if (!Array.isArray(lost)) { lost = []; subject.lostPortions.set(jobId, lost); }
    lost.push(ord);
    while (lost.length > RECOVERY_LOST_MAX) lost.shift();
  }

  /**
   * 恢复份额登记（§2.6 份额登记：装配点／接受点共用）。每份装配必登记、不设
   * 覆盖守卫——旧 `returned` 份额不被顶掉、也不阻止新份额入册，多份份额按
   * 登记次序并存（连续取消的各份额都有恢复锚点）。登记时信号已中止的装配
   * （出口时点检查）直接按退回置标记，回合收尾确认时再复检一次（监听复检），
   * 两层合成退回判据，逐份额独立成立；新份额登记把作业的已确认状态置回未
   * 确认（既有确认只覆盖此前份额，最新装配内容需重新确认）。条数与字符上限
   * 随登记实施（FIFO 逐出最旧，保护本次登记项；被逐出且未服务完的份额序号
   * 记入丢失清单）。
   * @param {unknown} owner - 主体。
   * @param {string} jobId - 作业标识。
   * @param {{text: string, partial?: boolean, terminal: object,
    *   via: 'wait'|'message'|'firstwait', signal?: object, messageId?: string}}
    *   fields - 装配份额与载体信息（`signal`＝装配调用（工具 exec）的取消
    *   信号；`messageId`＝`via: 'message'` 份额的载体消息构造期 id，确认与
    *   退回按该身份匹配——缺席＝热更边界前的旧份额，不被任何领取/丢弃事件
    *   匹配，保守滞留至期限、逐出、行卸载或恢复流）。
   */
  #registerRecovery(owner, jobId, fields, config) {
    const subject = this.#subject(owner);
    this.#sweepRecoveries(subject);
    const returnedNow = fields.signal?.aborted === true;
    const prior = subject.recoveries.get(jobId);
    // 稳定份额身份（SOL-RC-01）：序号按主体×作业的单调计数发放，份额清空
    // （确认／到期／逐出）后不复位——序号复用会让滞留／新建的恢复游标把新
    // 输出的前部当作已服务跳过。在册尾序只作计数下限防御（流回退等边角下
    // 仍保持单调）；丢失清单里的序号同样终身唯一。
    const ord = Math.max(
      subject.recoverySeqs.get(jobId) ?? 0,
      prior !== undefined && prior.length > 0 ? prior[prior.length - 1].ord : 0
    ) + 1;
    subject.recoverySeqs.set(jobId, ord);
    const portion = {
      ord,
      text: typeof fields.text === 'string' ? fields.text : '',
      partial: fields.partial === true,
      terminal: fields.terminal ?? null,
      registeredAt: this.now(),
      returned: returnedNow,
      via: fields.via,
      ...(fields.messageId !== undefined ? { messageId: fields.messageId } : {}),
      ...(fields.signal !== undefined && fields.signal !== null ? { signal: fields.signal } : {})
    };
    if (prior !== undefined) prior.push(portion);
    else subject.recoveries.set(jobId, [portion]);
    // 新份额登记＝回到未确认（§2.6「已确认」定义：最新装配内容经载体确认）：
    // 既有确认只覆盖此前份额，后续装配需重新确认，份额不因旧确认而
    // 永不可交回。
    const jobEntry = this.entryFor(jobId, owner);
    if (jobEntry !== undefined && jobEntry.owner === owner) jobEntry.confirmedAt = null;
    // 上限逐出（跨作业 FIFO，保护本次登记项）：条数按份额记录计、字符按在册
    // 份额正文合计；被逐出且未服务完的份额序号记入丢失清单。
    const servedThrough = (oneJob, portion) => {
      // 服务完成按**该份额所属作业自己的**恢复流游标判定——跨作业逐出时
      // 不得用登记作业的游标（他作业「已服务完、待回合收尾定案」的份额已
      // 送达，逐出不是丢失）。
      const oneStream = subject.recoveryStreams.get(oneJob);
      if (oneStream === undefined || oneStream.ord === null) return false;
      return portion.ord < oneStream.ord
        || (portion.ord === oneStream.ord && oneStream.offset >= portion.text.length);
    };
    const flatten = () => {
      const list = [];
      for (const [oneJob, portions] of subject.recoveries) {
        for (const onePortion of portions) list.push({ jobId: oneJob, portion: onePortion });
      }
      return list;
    };
    const evictOldest = () => {
      const oldest = flatten()
        .filter(({ jobId: oneJob, portion }) => !(oneJob === jobId && portion.ord === ord))
        .sort((a, b) => a.portion.registeredAt - b.portion.registeredAt
          || a.portion.ord - b.portion.ord)[0];
      if (oldest === undefined) return false;
      if (!servedThrough(oldest.jobId, oldest.portion)) {
        this.#noteLostPortion(subject, oldest.jobId, oldest.portion.ord);
      }
      const rest = subject.recoveries.get(oldest.jobId)
        .filter((onePortion) => onePortion !== oldest.portion);
      if (rest.length > 0) subject.recoveries.set(oldest.jobId, rest);
      else {
        subject.recoveries.delete(oldest.jobId);
        this.#correctEmptyStream(subject, oldest.jobId);
      }
      return true;
    };
    const totalOf = () => {
      let total = 0;
      for (const portions of subject.recoveries.values()) {
        for (const onePortion of portions) total += onePortion.text.length;
      }
      return total;
    };
    let count = flatten().length;
    while (count > RECOVERY_MAX_ITEMS && evictOldest()) count -= 1;
    const cap = 2 * Math.max(1, Number(config?.maxResultChars ?? 4096));
    let total = totalOf();
    while (total > cap) {
      const onlyThis = subject.recoveries.size === 1
        && subject.recoveries.get(jobId)?.length === 1
        && subject.recoveries.get(jobId)[0].ord === ord;
      if (onlyThis) break;
      if (!evictOldest()) break;
      total = totalOf();
    }
  }

  /**
   * 份额清空后的流校正（SOL-RC-01「删除后的流校正」）：某作业的在册份额
   * 全部消失（确认／到期／逐出）时，恢复流记录一并移除。滞留的旧游标
   * （`ord`／`offset`）指向已不存在的份额：序号稳定后新份额必取更大序号、
   * 自 0 服务，旧位置不再有语义，留着只成登记堆积并让「流取尽」误判
   * （`stageRecovery` 的 drained 档按流状态判定）。份额仍在册时不动作。
   */
  #correctEmptyStream(subject, jobId) {
    if ((subject.recoveries.get(jobId) ?? []).length === 0) subject.recoveryStreams.delete(jobId);
  }

  /**
   * 恢复流状态（§2.6 恢复流装配）：从游标起找到第一个有可服务内容的在册
   * 份额。游标指向的份额不在册（已确认/到期/逐出）时按下一在册份额自 0
   * 服务；全部在册份额都服务到末尾时返回 `null`（流取尽、待回合收尾定案）。
   * @returns {{portion: object, from: number}|null}
   */
  #recoveryStreamState(subject, jobId) {
    const portions = subject.recoveries.get(jobId);
    if (portions === undefined || portions.length === 0) return null;
    const stream = subject.recoveryStreams.get(jobId);
    const ord = stream?.ord ?? null;
    const offset = ord === null ? 0 : (stream?.offset ?? 0);
    for (const portion of portions) {
      if (ord !== null && portion.ord < ord) continue; // 游标之前的已服务份额
      if (ord !== null && portion.ord === ord) {
        if (offset < portion.text.length) return { portion, from: offset };
        continue; // 本份额已到末尾：按下一在册份额
      }
      return { portion, from: 0 }; // 游标份额不在册：下一份额自 0 服务
    }
    return null;
  }

  /**
   * 恢复流推进的回合收尾定案（§2.6「推进的确认与回退」；onTurnStopping 在
   * 份额确认清算后调用）：
   * - 回退：任一推进记录的取消信号中止 → 游标回到最早中止推进的起点（游标
   *   只标记连续前缀，其后已定案的推进内容因回退重取时按可能重复标记交回）；
   *   回退起点份额已不在册时不滞留游标，按下一在册份额继续。
   * - 定案：服务到末尾且无待回退推进的份额清除记录并置作业确认标记（经恢复
   *   载体完成交付）；游标随之跳到下一在册份额。
   */
  #finalizeRecoveryAdvances(subject, owner) {
    for (const [jobId, stream] of [...subject.recoveryStreams.entries()]) {
      const portions = subject.recoveries.get(jobId) ?? [];
      let rollback = null;
      for (const adv of stream.advances) {
        if (adv.signal?.aborted !== true) continue;
        if (rollback === null || adv.ord < rollback.ord
          || (adv.ord === rollback.ord && adv.from < rollback.from)) {
          rollback = { ord: adv.ord, from: adv.from };
        }
      }
      if (rollback !== null && portions.some((portion) => portion.ord === rollback.ord)) {
        stream.ord = rollback.ord;
        stream.offset = rollback.from;
      }
      // 回退起点份额已不在册（确认/到期/逐出）：不滞留游标，按现有位置继续。
      const advances = stream.advances;
      stream.advances = [];
      // 定案清除：推进记录覆盖且未被回退越过的份额＝服务到末尾且无待回退推进。
      const finalizedOrds = new Set();
      if (rollback === null) {
        for (const adv of advances) {
          const portion = portions.find((one) => one.ord === adv.ord);
          if (portion === undefined) continue;
          const lastTo = advances.filter((one) => one.ord === adv.ord)
            .reduce((max, one) => Math.max(max, one.to), 0);
          if (lastTo >= portion.text.length) finalizedOrds.add(adv.ord);
        }
      } else {
        for (const adv of advances) {
          if (adv.ord < rollback.ord) finalizedOrds.add(adv.ord);
        }
      }
      if (finalizedOrds.size === 0) continue;
      const rest = portions.filter((portion) => !finalizedOrds.has(portion.ord));
      if (rest.length > 0) subject.recoveries.set(jobId, rest);
      else subject.recoveries.delete(jobId);
      const entry = this.entryFor(jobId, owner);
      if (entry !== undefined) entry.confirmedAt = this.now();
      // 游标越过已清除份额：跳到下一在册份额（流取尽时游标归零、清流记录）。
      if (stream.ord !== null && finalizedOrds.has(stream.ord)) {
        const next = (subject.recoveries.get(jobId) ?? [])[0];
        if (next !== undefined) { stream.ord = next.ord; stream.offset = 0; }
        else { stream.ord = null; stream.offset = 0; }
      }
      // 份额清空即清流记录（SOL-RC-01「删除后的流校正」）：无条件清——若只按
      // `stream.ord === null` 判，会漏掉游标滞留在已清份额上的形态（定案清除
      // 份额后游标未推进时即此形态，滞留游标会让后续新份额的前部被跳过）。
      this.#correctEmptyStream(subject, jobId);
    }
  }

  /**
   * 恢复出口的分档决定（§2.6 恢复出口；显式作业目标的零等待调用——
   * `lib/wait.js` 入口终态分支与零等待主出口）：
   * - `null`：不属本主体，或按 §2.6 两形态辨析走正常批次路径——目标尚有
   *   未交付内容（省略中段／延后条目在缓冲）时续取优先、同批不重发副本；
   *   无在册份额、无丢失份额、亦无已交付事实可援引时同样无恢复语义
   *   ——按正常零等待路径返回当前状态（运行中份额过期且丢失清单非空时
   *   不属本档：按第 3 档如实说明缺失）；
   * - 第 1 档 `{tier: 1}`：份额在册（判定次序：份额在册先于已确认标记——
   *   混合载体下退回份额不因另一载体的确认失去出口）且流有可服务内容——
   *   挂起消费标记，本次出口的 `collectBatch` 装配「标记行＋正文切片＋
   *   位置说明行」（切片计入当批内容预算，标记/位置行入必要说明层另计）；
   *   点名多个作业目标时单批至多装配一个恢复条目，其余目标的份额保持在册、
   *   可再经显式零等待逐批交回；
   * - `{tier: 1, drained: true}`：份额在册但流已取尽、待回合收尾定案——本次
   *   不装配正文，返回「已重发、待确认」的状态说明（§2.6）；
   * - 第 2 档 `{tier: 2}`：已确认且无份额在册、无丢失份额（现行口径：状态行
   *   ＋已交付说明）；
   * - 第 3 档 `{tier: 3, terminal, spillPaths, lost}`：未确认但份额缺席/过期
   *   ——如实说明＋终态事实＋留存线索（如有）＋丢失份额序号（如有），不伪造
   *   正文；与交付事实解耦——丢失清单非空即进本档（运行中作业同样说明缺失，
   *   `terminal` 可为 `null`＝报当前状态，不伪造终态）；`partialConfirmed: true`
   *   变体（SOL-RC-02）＝已确认但丢失清单非空——其他份额不可用，按同档如实
   *   说明缺失。
   * @returns {null|{tier: 1}|{tier: 1, drained: true}|{tier: 2}|
   *   {tier: 3, terminal: object|null, spillPaths: string[], lost: number[]}}
   */
  stageRecovery(jobId, owner) {
    const subject = this.subjects.get(owner);
    const entry = this.entryFor(jobId, owner);
    if (subject === undefined || entry === undefined) return null;
    this.#sweepRecoveries(subject);
    // 未交付内容续取优先（§2.6 恢复出口两形态辨析）：目标作业尚有未交付内容
    //（裁剪省略的中段或整条延后的条目都留在缓冲）时，本次零等待经正常批次
    // 路径交付续段——续段确定未到达，副本只是未确认、可能已到达，重发排前
    // 会占满份额、中段在反复零等待下永不前进。份额保持在册，留待确认清除、
    // 期限到期或后续无未交付内容的恢复请求按第 1 档交回。
    if (entry.buffer !== '') return null;
    const portions = subject.recoveries.get(jobId);
    // 份额在册先于已确认标记：在册即构成恢复语义——含运行中增量登记的份额
    //（增量交付不置已交付事实，其份额同样有恢复出口）；流取尽、待定案时
    // 返回状态说明，不带正文。
    if (portions !== undefined && portions.length > 0) {
      if (this.#recoveryStreamState(subject, jobId) === null) {
        return { tier: 1, drained: true };
      }
      subject.stagedRecovery = { jobId };
      return { tier: 1 };
    }
    if (entry.confirmedAt !== null) {
      // 份额聚合确认（SOL-RC-02）：作业级确认只说明「已有份额送达」——其他
      // 份额到期或被逐出（丢失清单非空）时，后段确认不能掩盖前段不可用，按
      // 第 3 档如实说明缺失（`partialConfirmed`＝此前另有份额已确认送达），
      // 不伪称全部已交付。
      const lostConfirmed = subject.lostPortions.get(jobId) ?? [];
      if (lostConfirmed.length === 0) return { tier: 2, ...this.#spillGroup(entry) };
      return {
        tier: 3,
        terminal: entry.terminal,
        spillPaths: [...entry.spillPaths],
        lost: [...lostConfirmed],
        partialConfirmed: true,
        ...this.#spillGroup(entry)
      };
    }
    // 无份额时按「已知缺失与终态交付事实解耦」判档（§2.6 恢复出口第 3 档）：
    // 丢失清单非空即如实说明缺失——运行中作业同样进入本档（运行中不置整体
    // 交付事实，但其登记份额过期＝已知缺失），报当前状态＋已过期份额序号＋
    // 留存线索（如有），不伪造终态、不伪称该份额已送达，也不阻断后续增量
    // 照常装配（丢失清单与增量游标互不干扰）；丢失清单为空且无已交付事实可
    // 援引时无恢复语义——按正常零等待路径返回当前状态。
    const lost = subject.lostPortions.get(jobId) ?? [];
    if (lost.length === 0 && entry.deliveredFact === null) return null;
    return {
      tier: 3,
      terminal: entry.terminal,
      spillPaths: [...entry.spillPaths],
      lost: [...lost],
      ...this.#spillGroup(entry)
    };
  }

  /**
   * 留存路径续取领取组（RA-SPILL-LOCATOR，设计 §2.6「留存路径的完整领取」）：
   * 显式作业目标零等待点名已交付／已过期的作业时，已列游标的余量单独成组随
   * 本次返回交回——每条完整出现、单列 `MAX_SPILL_TOTAL` 预算、每次至少列入
   * 一条（单条超预算整条列入），仍未取尽由计数行重复领取方法。领取组属定位
   * 数据：不占正文批预算、不登记份额、不改变已交付事实。组内携带列出区间与
   * 全量总数，渲染层（lib/wait.js）按 `delivery.spill` 行呈现。
   * @param {object} entry - 作业账面条目。
   * @returns {{spillGroup?: {jobId: string, from: number, count: number,
   *   paths: string[], total: number}}} 空对象＝无余量。
   */
  #spillGroup(entry) {
    if (entry.spillListed >= entry.spillPaths.length) return {};
    const from = entry.spillListed;
    const count = spillListCount(entry.spillPaths, from, entry.config.agentLang ?? 'en');
    if (count <= 0) return {};
    entry.spillListed = from + count;
    return {
      spillGroup: {
        jobId: entry.jobId,
        from,
        count,
        paths: entry.spillPaths.slice(from, from + count),
        total: entry.spillPaths.length
      }
    };
  }

  // ── 作业侧（命令 / 编排的首次等待接线）──────────────────────────────────

  /**
   * 作业启动登记：命令或编排作业注册成功即建账（首次等待武装零号窗口信息由此续接）。
   * `options.echoText`／`options.echoKind`（ECHO-WORKFLOW-01）：注册时点存入的
   * 回显原文与类别——命令作业传 `args.command`／`'command'`，编排传
   * `args.script`／`'script'`。原文**无条件入账**（存储与展示分离）：是否附上
   * 由批次 `echoOn` 在装配时定值，开关翻转无须重算注册名称或重读注册表。
   */
  noteJobStarted(ctx, config, jobId, owner, options = {}) {
    if (this.jobs.has(jobId)) return;
    const entry = new JobRecord({ ctx, config, jobId, owner });
    entry.own = true;
    if (typeof options.echoText === 'string' && options.echoText !== '') {
      entry.echoText = options.echoText;
      entry.echoKind = options.echoKind === 'script' ? 'script' : 'command';
    }
    this.jobs.set(jobId, entry);
  }

  /**
   * 外来作业的存在性入账（§2.3 观察入口，RA-FOREIGN-DISCOVERY）：调用方须已
   * 持有存在证据（清单行、事件视图、事件订阅载荷）。幂等——已有该主体条目
   * （本包作业或既有外来登记）时直接返回。
   *
   * 分账（§2.6）：无主公开作业（`options.unowned`）按主体分册另立记录——第二
   * 主体的存在性判定、状态访问与等待不被本包登记拒绝；有主作业单条记录，
   * 登记撞见他主体在册条目时返回 `null`（跨主体防御——正常流程经宿主
   * `jobs.list(caller)` 过滤不可见，调用方按查无口径交回）。
   *
   * @param {object} ctx - 装载行上下文。
   * @param {object} config - 生效配置视图。
   * @param {string} jobId - 作业标识。
   * @param {unknown} owner - 主体。
   * @param {{unowned?: boolean}} [options] - 无主公开作业标记。
   * @returns {object|null} 条目；跨主体冲突为 `null`。
   */
  ensureForeignJob(ctx, config, jobId, owner, options = {}) {
    const existing = this.entryFor(jobId, owner);
    if (existing !== undefined) return existing;
    if (options.unowned !== true) {
      const bare = this.jobs.get(jobId);
      if (bare !== undefined && bare.owner !== owner) return null;
    }
    const entry = new JobRecord({ ctx, config, jobId, owner });
    this.jobs.set(options.unowned === true
      ? DeliveryLedger.sharedJobKey(jobId, owner)
      : jobId, entry);
    return entry;
  }

  /**
   * 外来作业的观察入账（§2.3「入账后按本节同款保活链规则挂链」）：存在性入账
   * 后立即挂保活链（无零号窗口交接——外来作业没有本包首次等待，链首窗口直接
   * 在册）。结算时宿主读到 `awaited`：不发通知、不做消费式预读，正文由链释放
   * 路径经账本读取（§2.6 交付）；抑制失败按既有口径（宿主通知照发＋本包完成
   * 消息照发、不计重复）。首见即终态（terminal 已证）不挂链——无结算可观察；
   * 本包自身作业（`own`）不在此挂链（其链由首次等待机制接管）。
   *
   * @param {object} ctx - 装载行上下文。
   * @param {object} config - 生效配置视图。
   * @param {string} jobId - 作业标识。
   * @param {unknown} owner - 主体。
   * @param {{unowned?: boolean, terminal?: boolean}} [options] - 无主公开作业标记；
   *   `terminal`＝调用方证据行已证终态（首见即终态）。
   * @returns {object|null} 条目（跨主体冲突为 `null`；已终态条目不挂链）。
   */
  observeForeignJob(ctx, config, jobId, owner, options = {}) {
    const entry = this.ensureForeignJob(ctx, config, jobId, owner, options);
    if (entry === null) return null;
    // 首见即终态（调用方证据已证）不挂链——无结算可观察。挂了链，`#beat` 的
    // jobs.wait 对已终态作业立即以终态视图释放，会被误记为「结算在本包观察下
    // 发生」（observedSettlement 置位）——而结算实际发生在挂链之前，宿主通知层
    // 可能已做消费式预读（正文被持有）；抑制前提不成立，误置位会跳过 §2.3
    // 正文去向判别与 held 档恢复通道（多目标同批点名时首个目标在通道耗时窗口
    // 内完成判别、其余目标被误置位跳过——正文静默搁浅形态）。终态事实由持有
    // 证据的调用方走 readSettled（不置观察）定论。
    if (options.terminal === true) return entry;
    if (entry.own === true || entry.terminal !== null) return entry;
    if (entry.chain === null) {
      entry.chain = {
        signal: new AbortController(),
        firstBeatArmed: true,
        firstBeatTimer: null,
        disposed: false
      };
      this.#beat(entry, 0);
    }
    return entry;
  }

  /**
   * 宿主作业事件的订阅处理（§2.3 观察入口③事件登记；`lib/index.js` 按
   * `agent/created` 路由在主体自己的 agent.ctx 上登记 `{owner}` 订阅后，回调
   * 转入此处）：
   * - `registered`——账本外的新作业入账挂链（两次等待之间、从未点名时结算的
   *   作业同样在册）；本包自身 start 的同步再入（`#ownStartDepth`）跳过——
   *   其登记由工具路径接管；
   * - `settled`——账本外的结算补入账＋定论读取（订阅晚挂的收窄面）；在册而
   *   无链（挂链失败）且尚无终态定论时补定论读取（`observedSettlement` 不置
   *   位——结算不在在册 waiter 观察下发生，空读取走 §2.3 判别）；在册有链时
   *   交由链释放路径（#beat）读取，本处理不重复读。
   * 本包自身作业（`own`）的 `settled` 全程跳过——其交付由首次等待／#beat 路径
   * 拥有，此处读取会与直付路径竞争一次性 `result` 通道。
   * @param {object} ctx - 装载行上下文（登记行）。
   * @param {object} config - 生效配置视图。
   * @param {unknown} owner - 订阅主体。
   * @param {object} event - 宿主作业事件载荷。
   */
  noteForeignEvent(ctx, config, owner, event) {
    try {
      const job = event?.job;
      if (typeof job?.id !== 'string' || job.id === '') return;
      // 宿主事件载荷的 `job` 是 view：`owner` 为宿主会话标识字符串（有主）或
      // 缺席（无主公开）——与 `{owner}` 订阅过滤口径一致（无主事件送达全部
      // `{owner}` 订阅者），此处按载荷复核。
      const unowned = job.owner === undefined;
      if (!unowned && job.owner !== owner) return; // {owner} 过滤的防御复核
      if (event.type === 'registered') {
        if (this.ownJobStartInFlight()) return;
        this.observeForeignJob(ctx, config, job.id, owner, { unowned });
        return;
      }
      if (event.type !== 'settled') return;
      const entry = this.entryFor(job.id, owner);
      if (entry === undefined) {
        if (this.ownJobStartInFlight()) return;
        const created = this.ensureForeignJob(ctx, config, job.id, owner, { unowned });
        if (created === null) return;
        // 订阅晚挂收窄面：首见即结算——入账（不挂链）补定论读取；结算未经
        // 在册 waiter 观察，空读取由 readSettled 内部走 §2.3 判别。
        this.readSettled(job.id, job, owner).catch(() => {});
        return;
      }
      if (entry.own === true) return;
      if (entry.chain === null && entry.terminal === null && entry.readInFlight === null) {
        this.readSettled(job.id, job, owner).catch(() => {});
      }
    } catch (error) {
      log(`foreign job event handling failed: ${String(error?.message ?? error)}`);
    }
  }

  /**
   * 正文去向判别（§2.3「结算未经观察、正文已被消费」）：只读主体自身待领取
   * 列表（nextStep）中的宿主完成通知——通知文本含正文（`Output:\n` 或
   * `. No new output.`）＝正文已随宿主消息进入模型上下文；仅状态与
   * `job_output` 引导（`Read its output with job_output.`，含截断形态的
   * `\nDone; job_output.`）＝正文留存宿主通知层；不在场＝无法确认。判别只读
   * 待领取列表，不追溯已领取消息或其他会话记录。
   * @param {object} entry - 作业条目。
   * @returns {'arrived'|'held'|'unknown'} 判别结论。
   */
  #classifyConsumedBody(entry) {
    try {
      const agent = this.#agentFor(entry.owner);
      const messages = agent?.inbox?.nextStep;
      if (Array.isArray(messages)) {
        const prefix = `background job ${entry.jobId}`;
        for (const message of messages) {
          if (message?.source?.kind !== 'tool-jobs') continue;
          const text = typeof message?.content?.[0]?.text === 'string'
            ? message.content[0].text
            : '';
          const hit = text.startsWith(`${prefix} `)
            || text.startsWith(`${prefix}.`)
            || text.startsWith(`${prefix}\n`);
          if (!hit) continue;
          if (text.includes('Read its output with job_output.')
            || text.includes('\nDone; job_output.')) {
            return 'held';
          }
          return 'arrived';
        }
      }
    } catch { /* 只读判别失败按无法确认 */ }
    return 'unknown';
  }

  /**
   * held 档正文恢复通道（HELD-RECOVER-01，设计 §2.3）：宿主结算预读持有的正文
   * 只存于做预读的 tool-jobs 组件实例闭包持有表（未服务化导出），宿主内唯一
   * 消费点是该实例注册的 `job_output` 定义——其 `execute` 以主体为 caller 做消费
   * 式读取（宿主注册表按 owner 匹配放行，跨主体在读取层被拒），命中持有记录时
   * 返回持有正文＋残余增量、删除记录并撤回主体收件箱的状态型通知。
   *
   * 解析口径：本包行与 tool-jobs 行同经组合装载（rc.1 的组合行不带作用域标签
   * ——注册同落 global 层），省略 scope 参数的全局视图即该层自身视图，本层注册
   * 无条件可见（dsh-tools view 的 own 面不受其他层限制影响）；不以主体作用域
   * 解析（主体视图对本组合已隐藏该定义，模型侧可见性不变）。
   *
   * 两态：取得非空正文→返回文本（调用方按正常批次路径交付）；定义缺席（组合
   * 未装载 tool-jobs 行、宿主形态变化）、无函数型 execute、调用抛错（含跨主体
    * 拒绝）或空回→返回 null（如实说明档，不清记录、不推进游标——重试窗口限于
    * 正文尚未交付或投递回滚退回未交付期间的再次点名，失败不撤宿主持有记录）。
   * @param {object} entry - 作业条目。
   * @param {object} agent - 主体 Agent 对象（execute 的 caller）。
   * @returns {Promise<string|null>} 取回的正文；未取得为 null。
   */
  async #recoverHeldBody(entry, agent) {
    try {
      const tools = entry.ctx.get('tools');
      if (tools === undefined || tools === null || typeof tools.get !== 'function') return null;
      const def = tools.get('job_output', undefined);
      if (def === undefined || def === null || typeof def.execute !== 'function') return null;
      const body = await def.execute({ job_id: entry.jobId }, { agent });
      return typeof body?.text === 'string' && body.text !== '' ? body.text : null;
    } catch {
      return null;
    }
  }

  /**
   * 零号窗口武装（设计 §2.3 链入口交接）：首次等待自身的 waiter 即链的零号窗口；
   * 首个保活窗口在零号窗口过半时预注册。`budgetMs` 是本次首次等待的剩余窗口。
   */
  noteFirstWaitArmed(jobId, budgetMs) {
    const entry = this.jobs.get(jobId);
    if (entry === undefined || entry.chain !== null) return;
    entry.chain = {
      signal: new AbortController(),
      firstBeatArmed: false,
      firstBeatTimer: null,
      disposed: false,
    };
    const half = Math.max(0, Math.floor(budgetMs / 2));
    entry.chain.firstBeatTimer = setTimeout(() => {
      this.#armFirstBeat(jobId);
    }, half);
    if (typeof entry.chain.firstBeatTimer.unref === 'function') entry.chain.firstBeatTimer.unref();
  }

  /**
   * 首个保活窗口预注册（若尚未注册）。`jobs.wait` 的 waiter 在宿主 Promise 执行器内
   * 同步入册（`dsh-jobs-local` 的 `waitResolvers.add`），调用即注册、无需等待。
   */
  #armFirstBeat(jobId) {
    const entry = this.jobs.get(jobId);
    if (entry === undefined || entry.chain === null) return;
    if (entry.chain.firstBeatArmed) return;
    entry.chain.firstBeatArmed = true;
    if (entry.chain.firstBeatTimer !== null) {
      clearTimeout(entry.chain.firstBeatTimer);
      entry.chain.firstBeatTimer = null;
    }
    this.#beat(entry, 0);
  }

  /**
   * 首次等待提前结束（插话 / 取消）且作业仍在运行：退出处理内同步注册首个保活窗口
   * （若它尚未在中点预注册），中间不让出事件循环（设计 §2.3）。
   */
  takeOverChain(jobId) {
    const entry = this.jobs.get(jobId);
    if (entry === undefined || entry.chain === null) return;
    if (!entry.chain.firstBeatArmed) this.#armFirstBeat(jobId);
  }

  /**
   * 首次等待结束的账面处理：
   * - `outcome = 'still-running'`（到期让出）——链已接管，无额外动作；
   * - `outcome = 'settled'`——撤销预注册（未让出则不挂链，设计 §2.3「零号窗口内
   *   结算则撤销预注册不挂链」），读取并按交付规则结算；
   * - `outcome = 'delivered'`——首次等待自身把终态结果直接交回了模型（async_run /
   *   async_workflow 的结算路径：输出经本包拉式源构造，不经账本）：登记终态
   *   事实与已交付事实（阻断后续完成消息与批次重复交付），不读取、不缓冲；
   *   `options.pendingTail`（直付被批次预算裁剪时的省略中段原文）非空时按
   *   partial 交付处理——中段进缓冲，续段可再交付（9.3.2 裁剪恢复）；`options.paidText`（本次直付文本）在场时按 §2.6 判据表第一行登记恢复份额（RESULT-RECOVERY-01：首等直付与等待返回同列载体——确认走回合收尾、退回走出口中止，份额经显式零等待恢复），`options.signal`＝首次等待调用方的 exec.signal 供退回判据两层检查；
   * - `outcome = 'detached'`——作业被撤销（如行卸载），整体回收。
   */
  async noteFirstWaitEnded(jobId, outcome, terminal, deliveredChars, options = {}) {
    const entry = this.jobs.get(jobId);
    if (entry === undefined) return;
    if (outcome === 'still-running') return;
    if (outcome === 'settled') {
      this.#disarmChainPreregistration(entry);
      // 首次等待自身的 waiter 在结算时刻在册（§2.3 观察成立；宿主 awaited）。
      entry.observedSettlement = true;
      await this.readSettled(jobId);
      return;
    }
    if (outcome === 'delivered') {
      this.#disarmChainPreregistration(entry);
      entry.observedSettlement = true;
      if (entry.terminal === null && terminal !== undefined && isTerminal(terminal.status)) {
        entry.terminal = {
          status: terminal.status,
          ...(terminal.exitCode !== undefined && terminal.exitCode !== null ? { exitCode: terminal.exitCode } : {}),
          ...(terminal.signal !== undefined && terminal.signal !== null ? { signal: terminal.signal } : {}),
          ...(terminal.detail !== undefined && terminal.detail !== null ? { detail: terminal.detail } : {})
        };
      }
      // 已交付事实阻断再交付（需求 9.3.2「同一最终结果在正常交付中只出现一次」
      // ——原始 JSON 与渲染文本算同一最终结果的两种形态）：完成消息
      // （#deliverIfNoWait）与批次（collectBatch）都按 deliveredFact 跳过。armed
      // 保活链保留（其目的＝抑制宿主原生完成通知，防双发），其 #beat 结算读取
      // 同样按本事实短路——partial 事实同样短路读取（中段已由直付方传入缓冲，
      // 宿主一次性 result 无需再消费）。
      if (entry.deliveredFact === null) {
        if (typeof options.pendingTail === 'string' && options.pendingTail !== '') {
          entry.buffer = options.pendingTail;
          entry.deliveredFact = { via: 'first-wait', partial: true };
          entry.readyAt = this.now();
        } else {
          entry.deliveredFact = { via: 'first-wait' };
        }
      }
      // 直付份额计入批次预算：直付正文与同一领取窗口内其他载体可进入同一次模型输入
      // （主体忙时完成消息走 inject 落 nextStep 随本轮领取），两载体合计不得超单份
      // maxResultChars——份额在 openFirstWaitShare 已**预留扣除**，这里按实际
      // 交付结账（预留与交付的差额退还，见 settleFirstWaitShare），同窗口其后的
      // #deliverIfNoWait/collectBatch 沿同一份剩余分配。
      if (Number.isFinite(Number(options.reservedShare)) && Number(options.reservedShare) > 0) {
        this.settleFirstWaitShare(entry.owner, entry.config, Number(options.reservedShare), Number(deliveredChars ?? 0));
      } else {
        this.chargeDelivery(entry.owner, entry.config, Number(deliveredChars ?? 0));
      }
      // 恢复份额登记（§2.6 载体判据表第一行——首等直付与等待返回同一载体行）：
      // text＝调用方传入的本次直付文本（正文
      // 在直付后不再可取，登记点必须持有）；partial＝裁剪中段在场；确认通道
      // ＝回合收尾（onTurnStopping 对 'firstwait' 与 'wait' 一体处理），退回＝
      // 出口中止（登记现查置 returned＋监听复检双层，同 #registerRecovery）。
      if (typeof options.paidText === 'string') {
        this.#registerRecovery(entry.owner, jobId, {
          text: options.paidText,
          partial: typeof options.pendingTail === 'string' && options.pendingTail !== '',
          terminal: entry.terminal ?? terminal ?? null,
          via: 'firstwait',
          ...(options.signal !== undefined && options.signal !== null ? { signal: options.signal } : {})
        }, entry.config);
      }
      return;
    }
    if (outcome === 'detached') this.detachJob(jobId);
  }

  /**
   * 首次等待直付的批份额（设计 §2.6「分配发生在构造返回内容之前」）：开批（若
   * 未开）并返回本次直付可用的内容字符上限＝当前批剩余预算与配置上限的较小值。
   * 调用方以该值构造直付文本（超限保首尾裁剪）。**份额在此刻预留扣除**——份额
   * 取得与实际交付之间隔着返回内容构造（含 await），并行直付在窗口内都读到
   * 未扣减余额会突破单份预算（RESULT-02「并行直付合计不超一份」）；实际交付
   * 后经 `noteFirstWaitEnded(jobId, 'delivered', …, chars, { reservedShare })`
   * 结账，预留与交付的差额由 settleFirstWaitShare 退还。
   *
   * 条数配额（RA-FIRSTWAIT-ITEMS）：直付载体与批次／汇总载体属同一领取窗口、
   * 共用单批 `MAX_BATCH_ITEMS` 上限——只扣字符不计数时，多个并行**空结果**
   * 直付各自零字符净占用（预留全额退还），可无限绕过 10 条上限。份额
   * 取得即占用一个条目名额，批条目已满时返回 0 份额（与字符预算取更严者）——
   * 调用方按零份额把返回内容裁剪为零，非空正文经 `pendingTail` 全文留在账本
   * 缓冲，显式零等待可续段领取（恢复方式与字符预算裁剪一致）。名额不做退还
   * （空结果交付成功也是一次真实的模型可见条目；构造抛错路径经
   * settleFirstWaitShare 全额退还字符，名额随批关闭释放，不跨批泄漏）。
   * @param {unknown} owner - 主体。
   * @param {object} config - 生效配置视图（maxResultChars）。
   * @returns {number} 本次直付可用字符上限（已从批剩余中扣除；批条目已满时为 0）。
   */
  openFirstWaitShare(owner, config) {
    const subject = this.#subject(owner);
    const full = Math.max(1, Number(config?.maxResultChars ?? 4096));
    if (subject.batch === null) subject.batch = this.#newBatch(subject, config);
    if (subject.batch.items >= MAX_BATCH_ITEMS) return 0;
    subject.batch.items += 1;
    const share = Math.max(0, Math.min(subject.batch.remaining, full));
    this.#chargeBatch(subject, subject.batch, share);
    return share;
  }

  /**
   * 首次等待直付份额结账（openFirstWaitShare 的预留已扣）：实际交付不超过预留，
   * 差额退还批预算（退还后的剩余不超过单份上限）。
   * @param {unknown} owner - 主体。
   * @param {object} config - 生效配置视图（maxResultChars）。
   * @param {number} share - openFirstWaitShare 返回的预留份额。
   * @param {number} deliveredChars - 实际交付字符数。
   */
  settleFirstWaitShare(owner, config, share, deliveredChars) {
    const refund = Math.max(0, Math.ceil(Number(share) || 0) - Math.ceil(Math.max(0, Number(deliveredChars) || 0)));
    if (refund <= 0) return;
    const subject = this.#subject(owner);
    const full = Math.max(1, Number(config?.maxResultChars ?? 4096));
    if (subject.batch === null) subject.batch = this.#newBatch(subject, config);
    // 退还后的批剩余不超过单份上限；代内已交付同步回退（输入代记账）。
    this.#refundBatch(subject, subject.batch, Math.min(refund, full - subject.batch.remaining));
  }

  /** 交付份额计费（无预留形态时的备用计费路径）：开批（若未开）并扣减直付字符数（下限 0）。 */
  chargeDelivery(owner, config, chars) {
    if (!Number.isFinite(chars) || chars <= 0) return;
    const subject = this.#subject(owner);
    if (subject.batch === null) {
      subject.batch = this.#newBatch(subject, config);
    }
    this.#chargeBatch(subject, subject.batch, Math.min(subject.batch.remaining, Math.ceil(chars)));
  }

  /** 撤销零号窗口预注册 timer 与链信号（未让出的结算路径；不撤已在册 waiter 由其自然到期）。 */
  #disarmChainPreregistration(entry) {
    if (entry.chain === null) return;
    if (entry.chain.firstBeatTimer !== null) {
      clearTimeout(entry.chain.firstBeatTimer);
      entry.chain.firstBeatTimer = null;
    }
    if (!entry.chain.firstBeatArmed) {
      // 首个保活窗口尚未注册：链未真正接管，整体撤销信号（预注册 timer 已清）。
      entry.chain.signal.abort();
      entry.chain = null;
    }
  }

  /**
   * 保活链的一个保活窗口（设计 §2.3）：`jobs.wait` 60 秒；窗口过半（中点）预注册
   * 下一窗口；结算释放或到期释放都回到本函数分档。撤销（`chain.signal`）产生的
   * reject 就地承接。`ordinal` 仅用于诊断。
   */
  async #beat(entry, ordinal) {
    if (entry.chain === null || entry.chain.disposed) return;
    const chain = entry.chain;
    const jobId = entry.jobId;
    // 本窗口的预注册 timer：窗口过半时启动下一窗口（其 waiter 立即在册——相邻窗口交叠）。
    let preregistered = false;
    const half = setTimeout(() => {
      preregistered = true;
      this.#beat(entry, ordinal + 1);
    }, HALF_BEAT_MS);
    if (typeof half.unref === 'function') half.unref();
    let view;
    try {
      view = await entry.ctx.jobs.wait(jobId, BEAT_MS, entry.owner, chain.signal.signal);
    } catch (error) {
      clearTimeout(half);
      // 撤销走 reject（宿主 signal 中止语义）：链已 dispose 属正常收尾；其余按残留照发口径记录。
      if (!chain.disposed) {
        log(`keep-alive beat ${jobId} rejected: ${String(error?.message ?? error)}`);
      }
      return;
    }
    if (isTerminal(view?.status)) {
      clearTimeout(half);
      // 结算：撤销信号停止后续窗口（已在册的下一窗口由 abort 拒绝承接）。
      this.#disposeChain(entry);
      // 在册 waiter 释放＝结算在本包观察下发生（§2.3：宿主读到 awaited，抑制
      // 成立——无通知、无消费式预读；空读取不进正文去向判别）。
      entry.observedSettlement = true;
      // 已交付（首次等待直付）不再读——读取只会填一段无人消费的缓冲
      //（deliveredFact 阻断一切再交付，见 noteFirstWaitEnded 'delivered'）。
      if (entry.deliveredFact === null) await this.readSettled(jobId, view, entry.owner);
      return;
    }
    // 非终态到期（或异常形状）：本窗口结束；下一窗口已过半预注册（在册交叠），未预注册则现在补。
    clearTimeout(half);
    if (!preregistered) this.#beat(entry, ordinal + 1);
  }

  /** 结束链：撤销信号、标记已处置（后续窗口的 reject 静默承接）。 */
  #disposeChain(entry) {
    if (entry.chain === null) return;
    entry.chain.disposed = true;
    if (entry.chain.firstBeatTimer !== null) {
      clearTimeout(entry.chain.firstBeatTimer);
      entry.chain.firstBeatTimer = null;
    }
    entry.chain.signal.abort();
    entry.chain = null;
  }

  /**
   * 作业整体回收（行卸载 / 作业终局）。撤销链并放弃账面。入参是**账本键**：
   * 有主作业＝裸 id；无主公开作业的分册条目由 disposeRow／disposeAll 的键
   * 迭代覆盖（noteFirstWaitEnded 'detached' 只用于本包自身作业＝裸 id）。
   */
  detachJob(jobId) {
    const entry = this.jobs.get(jobId);
    if (entry === undefined) return;
    this.#disposeChain(entry);
    this.jobs.delete(jobId);
  }

  /** 行卸载整体回收（末行卸载 / `resetDeliveryLedger`）。除清空在册行集合外与历史行为一致。 */
  disposeAll() {
    for (const jobId of [...this.jobs.keys()]) this.detachJob(jobId);
    for (const dispose of this.claimedDisposers.values()) dispose();
    this.claimedDisposers.clear();
    this.subjects.clear();
    this.rows.clear();
  }

  /**
   * 行装载登记（REL-LIFECYCLE-01，设计 §2.2）。行数**不**用 `claimedDisposers`
   * 键数推断：`attachClaimedListener` 在 `ctx.on` 抛错时返回空函数且不登记，
   * 挂监听失败的行仍在册、仍持有作业——按键数判末行会提前判空、误触发整体
   * 释放、把在册失败行的作业一并删掉。显式登记对所有行形态（查询行、挂监听
   * 失败行）一视同仁；`applyWith` 在任何可抛步骤之前先登记后注册卸载 effect。
   * @param {object} ctx - 本行装载上下文。
   */
  registerRow(ctx) {
    this.rows.add(ctx);
  }

  /** 在册行数（只读测试锚：行登记与卸载的收支断言用）。 */
  rowsCount() {
    return this.rows.size;
  }

  /**
   * 行卸载的行级清扫（REL-LIFECYCLE-01，设计 §2.2）。卸载一行只清该行应负责
   * 的资源：本行创建的作业条目（`JobRecord.ctx` 逐行区分）与只被这些作业占用
   * 的主体记录；其他行的作业、未交付缓冲（含 partial 裁剪中段）与保活链原样
   * 保留。末行（在册行集合为空）时执行与 `disposeAll` 等价的整体释放。
   * @param {object} ctx - 卸载行的装载上下文。
   */
  disposeRow(ctx) {
    this.rows.delete(ctx);
    // 第 1 步：只撤本行创建的作业条目（撤链＋删条目，复用 detachJob），记录
    // 本行撤销的 (jobId, owner) 对——第 2 步清副本用（此刻条目已不在册）。
    const droppedOwners = new Set();
    const droppedJobIds = [];
    for (const [jobId, entry] of [...this.jobs]) {
      if (entry.ctx !== ctx) continue;
      droppedOwners.add(entry.owner);
      // 份额级清理键＝条目裸 id（恢复映射的登记键）——无主分册条目的账本键
      // 带 U+0000 主体后缀，与恢复映射键不同源（PUBLIC-JOB-01 分册）；条目
      // 撤销本身仍按账本键（detachJob）。
      droppedJobIds.push([entry.jobId, entry.owner]);
      this.detachJob(jobId);
    }
    // 第 2 步：惰性清扫主体记录——该主体再无任何在册作业、又无等待者与待投递
    // 项时才删（有则原样保留，正在消费的批次与缓冲不受行卸载影响）。本行撤销
    // 作业的恢复副本一并清（RESULT-RECOVERY-01 §3.4：行卸载清该行作业副本），
    // 主体因他行作业保留时只清本行副本、不动他行副本与挂起请求之外的消费状态。
    for (const owner of droppedOwners) {
      const subject = this.subjects.get(owner);
      if (subject === undefined) continue;
      for (const [jobId, jobOwner] of droppedJobIds) {
        if (jobOwner !== owner) continue;
        subject.recoveries.delete(jobId);
        subject.recoveryStreams.delete(jobId);
        subject.lostPortions.delete(jobId);
        subject.recoverySeqs.delete(jobId);
        if (subject.stagedRecovery?.jobId === jobId) subject.stagedRecovery = null;
      }
      let ownerHasJobs = false;
      for (const entry of this.jobs.values()) {
        if (entry.owner === owner) { ownerHasJobs = true; break; }
      }
      if (ownerHasJobs) continue;
      if (subject.activeWaits.size > 0) continue;
      if (subject.pendingSends.length > 0) continue;
      // 在途创建认领同样是窗口成员（ACCEPT-BATCH-01：claimCreation 起作业 noteJobStarted
      // 止的批成员）——与 #deliverIfNoWait/closeBatchIfIdle 等三处口径一致；卸载窄窗内
      // 删主体会丢开批与占位，随后并行新调用重建主体开新批取全额预算，正是准备期
      // 窗口要防的双份预算形态。认领随自身 finally 正规出口后主体才可整体释放。
      if (subject.inFlightCreations.size > 0) continue;
      this.subjects.delete(owner);
    }
    // 第 3 步：末行判定（显式在册行集合，不推断）→ 整体释放。
    if (this.rows.size === 0) this.disposeAll();
  }

  // ── 读取（设计 §2.4 消费纪律）──────────────────────────────────────────

  /**
   * 结算读取：作业已证实终态后消费一次增量（chunks 拼接 + 首次终态一次性 `result`）。
   * 终态证据由调用方持有（保活链窗口释放、首次等待结算、`jobs.list` 快照）；
   * `terminal` 缺席时按当前快照自证一次（同步 `jobs.list`，设计 §2.4 的三分法）。
   * 在途读取共享同一 Promise（等待出口与保活链并发触发不双读）。
   * @param {string} jobId
   * @param {{status?: string, exitCode?: number|null, signal?: string|null, detail?: unknown}} [terminal]
   *   调用方已证实的终态事实（可选）。
   * @returns {Promise<{text: string, lossy: boolean, spillPaths: string[], terminal: object}|null>}
   *   非终态或读取失败返回 `null`（失败保留可重试口径，不写成空结果；失败同样
   *   经 `#settleReady` 发出就绪事件并在无活等待时投递注记——REL-READ-02）。
   */
  /**
   * 终态定论读取（经账本，设计 §2.4/§2.6）：快照或事件通道已证终态后调用；
   * 读取一次增量（含首次终态一次性 `result`）并进入主体批次的待交付缓冲。
   * 非终态或读取失败返回 `null`（失败不写成空结果，保留可重试口径）。
   *
   * §2.3 正文去向判别：`observed === true`（终态事实来自本包在册 waiter 的
   * 释放——事件通道 jobs.wait 或保活链）时置 `observedSettlement`（宿主
   * `awaited` 抑制成立，正文不被宿主通知层消费）；读取无可消费正文（无增量
   * 且无 `result`）且结算未经观察时，按 §2.3 判别次序置 `bodyDisposition`
   * （已交付事实 → nextStep 宿主完成通知形态 → 无法确认），不把暂不可读取
   * 写成空输出或已交付。
   *
   * @param {string} jobId - 作业标识（本包作业；外来作业随 `owner` 分账解析）。
   * @param {object} [terminal] - 调用方已证实的终态事实（快照行或事件视图）。
   * @param {unknown} [owner] - 主体（无主公开作业分册解析用；缺省按裸 id）。
   * @param {boolean} [observed] - 终态事实是否来自本包在册 waiter 的释放。
   */
  async readSettled(jobId, terminal, owner = undefined, observed = false) {
    const entry = owner === undefined ? this.jobs.get(jobId) : this.entryFor(jobId, owner);
    if (entry === undefined) return null;
    if (observed === true) entry.observedSettlement = true;
    if (entry.readInFlight !== null) return entry.readInFlight;
    // attempt 整体不 reject（WAIT-READ-01 口径）：任何一步失败都置读取失败标志
    // 并返回 `null`，不把 rejected Promise 留在 readInFlight——后续并发调用会拿到
    // 同一个失败 Promise 反复抛错。失败＝终态已证实、正文未取得，保留可重试
    // 口径（readFailed 置位；批次只投状态行与重试出路，不按空结果交付），并
    // 同样进入通知流程（REL-READ-02：就绪事件唤醒挂起等待＋无活等待注记）。
    const attempt = (async () => {
      // 先让出一个微任务轮次，保证外层 `entry.readInFlight = attempt` 先于本体内
      // 任何同步完成路径（read 同步抛错、快照非终态同步返回 null）——否则
      // finally 清理跑在赋值之前，已结束的 promise 永久占位 readInFlight，
      // 后续调用永远复用旧 null（readFailed 卡死、正文永远取不回）。
      await Promise.resolve();
      try {
        // 已交付事实短路（含 partial——首尾已付、中段在缓冲，宿主一次性
        // result 无需再消费，直接交付未领的续段）：不从宿主重复读取，也
        // 不把一次性通道的原文与已交付部分拼出重复正文。
        if (entry.deliveredFact !== null) {
          if (entry.terminal === null) return null; // 防御：交付事实与账面终态不一致时不伪造。
          if (entry.readyAt === null) entry.readyAt = this.now();
          return { text: entry.buffer, lossy: entry.lossy, spillPaths: entry.spillPaths, terminal: entry.terminal };
        }
        if (entry.terminal === null) {
          let facts = terminal;
          if (facts === undefined) {
            const rows = entry.ctx.jobs.list(entry.owner);
            const row = Array.isArray(rows) ? rows.find((candidate) => candidate?.id === jobId) : undefined;
            if (row !== undefined && isTerminal(row.status)) {
              facts = row;
            }
          }
          if (facts === undefined || !isTerminal(facts.status)) {
            return null; // 非终态：不是读取失败，不置 readFailed。
          }
          entry.terminal = {
            status: facts.status,
            ...(facts.exitCode !== undefined && facts.exitCode !== null ? { exitCode: facts.exitCode } : {}),
            ...(facts.signal !== undefined && facts.signal !== null ? { signal: facts.signal } : {}),
            ...(facts.detail !== undefined && facts.detail !== null ? { detail: facts.detail } : {})
          };
        }
        try {
          const read = await entry.ctx.jobs.read(jobId, entry.owner);
          if (read !== undefined && read !== null) {
            // 进度日志按展示开关筛选（设计 2.4：先筛选后裁剪——筛选在读取层）。
            const merged = chunksTextOf(read, entry.config?.workflowProgressLog === true);
            // §2.3 正文去向判别（前置事实采集）：本次读取无可消费正文（无增量
            // 且无 `result`——`result === ''` 也是在场结果，空串不进判别）且
            // 结算未经本包在册 waiter 观察（suppress 未命中，正文可能已被宿主
            // 通知层消费）时，按 §2.3 判别次序如实定论；账本已有交付事实的由
            // deliveredFact 分支短路在前，不至此。held／unknown 先经 held 档
            // 正文恢复通道尝试取回正文（HELD-RECOVER-01，设计 §2.3）：取回即按
            // 正常批次路径交付（正文入缓冲、去向结论清空）；通道只对隐藏判据
            // 成立的主体启用，判据不成立时原生入口对模型可见、指路原生
            // job_output 是合法出口（*_native 档），本包不代读、不撤其通知。
            if (merged === '' && read.result === undefined && entry.observedSettlement !== true) {
              const disposition = this.#classifyConsumedBody(entry);
              if (disposition === 'arrived') {
                entry.bodyDisposition = 'arrived';
              } else {
                // 主体 Agent 现读（判读失败按不可用处理——受控装置的 ctx 可能
                // 不带服务访问器；判别本身已在 #classifyConsumedBody 内部兜错）。
                let agent;
                try {
                  agent = this.#agentFor(entry.owner);
                } catch {
                  agent = undefined;
                }
                const hidden = agent !== undefined
                  && typeof this.jobOutputHiddenFor === 'function'
                  && this.jobOutputHiddenFor(agent) === true;
                if (hidden) {
                  const recovered = await this.#recoverHeldBody(entry, agent);
                  if (recovered !== null) {
                    // 通道消费由宿主 job_output 语义完成：持有记录一次性删除、
                    // 主体收件箱的状态型完成通知撤回——本包随后交付正文，不残留
                    // 指向已隐藏入口的待发通知。
                    entry.buffer += recovered;
                    entry.bodyDisposition = null;
                    entry.heldRecovered = true;
                  } else {
                    // 未取得（无持有记录／已被消费／实例重载丢失／通道不可用）：
                    // 如实说明不可再读；不清记录、不推进游标——失败本身不撤宿主
                    // 持有记录。重试窗口限于正文尚未交付（或投递回滚退回未交付）
                    // 期间的再次点名；已置交付事实后判别分支不再进入。
                    entry.bodyDisposition = disposition;
                  }
                } else {
                  entry.bodyDisposition = `${disposition}_native`;
                }
              }
            }
            entry.buffer += merged;
            if (read.lossy === true) entry.lossy = true;
            this.#noteSpill(entry, spillPathsOf(read));
          }
        } catch (error) {
          log(`settled read ${jobId} failed: ${String(error?.message ?? error)}`);
          entry.readFailed = true;
          // 失败定论处清通知占位（REL-READ-02）：模型侧重试出的新失败可再通知。
          // 调用保持在外层 try 之内——#settleReady 整体加固后不抛，万一抛出由
          // 外层 catch 承接（见 #settleReady 注释）。
          entry.readFailedNoted = false;
          await this.#settleReady(entry);
          return null;
        }
        entry.readFailed = false;
        if (entry.readyAt === null) entry.readyAt = this.now();
        await this.#settleReady(entry);
        return { text: entry.buffer, lossy: entry.lossy, spillPaths: entry.spillPaths, terminal: entry.terminal };
      } catch (error) {
        // 快照自证（jobs.list）或结算后续（#settleReady）失败：终态未证实或就绪
        // 广播失败——同样按读取失败口径保留重试，不区分冒充。
        log(`settled read ${jobId} failed: ${String(error?.message ?? error)}`);
        entry.readFailed = true;
        entry.readFailedNoted = false;
        // 本 catch 物理上在 try 之外、无再外层承接——该调用的安全性完全依赖
        // #settleReady 的整体加固（不抛不拒绝）；#beat 对 readSettled 的浮动
        // await，其拒绝在此路径内得到承接（不产生进程级未处理拒绝）。
        await this.#settleReady(entry);
        return null;
      } finally {
        entry.readInFlight = null;
      }
    })();
    entry.readInFlight = attempt;
    return attempt;
  }

  /**
   * 运行中增量读取（设计 §3.2.3：零等待对作业目标可交付当前未交付增量，即使作业
   * 尚在运行）。消费一次 `jobs.read` 的 chunks 增量并入缓冲（运行中无一次性
   * `result` 通道——宿主只在首次终态读取交付）；读取失败与终态读取失败同口径：
   * 账本级定论置位，由零等待出口的批次装配「状态行＋读取失败注记＋重试出路」
   * （WAIT-INCREMENT-01——不再静默成空增量），失败当次不消费游标，恢复读取
   * 取得全部未消费增量。
   * @returns {Promise<{text: string, terminal: object}|null>} 增量投影（空增量返回
   *   空串与当前终态事实——终态事实可能为 `null`；读取失败带 `readFailed: true`）。
   */
  async readIncremental(jobId, owner = undefined) {
    const entry = owner === undefined ? this.jobs.get(jobId) : this.entryFor(jobId, owner);
    if (entry === undefined) return null;
    let delta = '';
    try {
      const read = await entry.ctx.jobs.read(jobId, entry.owner);
      if (read !== undefined && read !== null) {
        // 同 readSettled：进度日志按展示开关筛选（设计 2.4）。
        delta = chunksTextOf(read, entry.config?.workflowProgressLog === true);
        if (read.lossy === true) entry.lossy = true;
        this.#noteSpill(entry, spillPathsOf(read));
      }
      // 读取成功（含空增量）即恢复：失败态翻回（与 readSettled 成功分支同款）。
      entry.readFailed = false;
    } catch (error) {
      log(`incremental read ${jobId} failed: ${String(error?.message ?? error)}`);
      // 运行中增量读取失败与终态读取失败同口径（WAIT-INCREMENT-01）：定论置位
      // ＋清一次性占位（新失败如实再报，与 readSettled 失败分支同款）——零等待
      // 出口经 collectBatch 的 readFailed 分支装配注记与重试出路，模型侧不再
      // 收到不可区分的「空增量」。
      entry.readFailed = true;
      entry.readFailedNoted = false;
      return { text: '', terminal: entry.terminal, readFailed: true };
    }
    entry.buffer += delta;
    return { text: delta, terminal: entry.terminal };
  }

  // ── 批次与交付（设计 §2.6）─────────────────────────────────────────────

  /**
   * 活等待登记（领取窗口锚点）。返回不透明令牌；`releaseWait` 注销并触发让位终局复查。
   */
  claimWait(owner) {
    const subject = this.#subject(owner);
    const token = {};
    subject.activeWaits.add(token);
    return token;
  }

  /**
   * 创建认领（批次窗口的入口锚，ACCEPT-BATCH-01／设计 §2.6「准备期窗口」）：
   * `async_run`／`async_workflow` 的 execute 同步前缀登记，随调用任意出口（直付、
   * 让出、准备失败、入口后取消）经 `releaseCreation` 注销。窗口成员＝活等待∪
   * 在途创建；认领在场时 `closeBatchIfIdle` 不关批、`#deliverIfNoWait` 让位，
   * 同窗判据对任意混合形态（等待×创建、编排×编排等）按在册认领集合同判
   * （设计 §8.2）。
   * @param {unknown} owner - 主体。
   * @param {'run'|'workflow'} kind - 创建调用的工具类型（清扫诊断用）。
   * @param {object|null} [signal] - 调用的 `exec.signal`（回合收尾中止复检凭据）。
   */
  claimCreation(owner, kind, signal = null) {
    const subject = this.#subject(owner);
    const token = { kind, signal };
    subject.inFlightCreations.add(token);
    return token;
  }

  /**
   * 创建认领注销（与 `releaseWait` 同口径）：该主体已无本包活等待且无在途
   * 创建认领时＝窗口空闲——先让位终局复查、后关批（与等待返回路径同序：复查
   * 发生在旧批仍开时，预算耗尽只产延后注记、正文留给下一载体；关批在复查后
   * ＝下一批恢复全额预算）。注销自身失败只记日志由调用方承担——不吞调用原始
   * 错误。
   */
  async releaseCreation(token, owner) {
    const subject = this.subjects.get(owner);
    if (subject === undefined) return;
    subject.inFlightCreations.delete(token);
    if (subject.activeWaits.size > 0 || subject.inFlightCreations.size > 0) return;
    await this.#yieldFinalReview(owner, subject);
    subject.batch = null;
  }

  /**
   * 清扫触发的窗口空闲复查（ACCEPT-CANCELLED-CREATION-01）：与
   * `releaseCreation` 同款「先复查后关批」，但由回合收尾清扫异步发出（不
   * 阻塞收尾事件）。复查投全部就绪未认领条目后关批；失败只记日志——清扫
   * 复查是补充出口，正文仍可经显式零等待领取。
   */
  #idleReviewAfterSweep(owner, subject) {
    this.#yieldFinalReview(owner, subject)
      .then(() => { subject.batch = null; })
      .catch((error) => { log(`idle review after creation sweep failed: ${String(error?.message ?? error)}`); });
  }

  /**
   * 让位终局复查（releaseWait／releaseCreation 共用，设计 §2.6）：投全部就绪
   * 未认领条目（含空正文终态条目——保活链抑制了宿主通知，让位复查是其唯一
   * 被动可见载体），逐条构造（deferFlush）后单次冲刷。
   */
  async #yieldFinalReview(owner, subject) {
    let queued = false;
    for (const entry of this.jobs.values()) {
      if (entry.owner !== owner) continue;
      if (entry.terminal === null) continue;
      if (entry.claimedBy === 'message') continue;
      await this.#deliverIfNoWait(entry, { deferFlush: true });
      queued = true;
    }
    if (queued) await this.#flushPendingSends(owner);
  }

  /**
   * 活等待注销与让位终局复查（设计 §2.6）：该主体已无本包活等待、也无在途
   * 创建认领，且存在就绪未交付内容时，补开完成消息交付，不等待模型主动领取
   * ——不存在「结算时让位、随后无等待却无任何交付载体」的终局。在途创建认领
   * 未清空时不复查（其首次等待即后续交付载体，提前复查会以完成消息形态吃掉
   * 同批预算外的份额，ACCEPT-BATCH-01）。
   */
  async releaseWait(token, owner) {
    const subject = this.subjects.get(owner);
    if (subject === undefined) return;
    subject.activeWaits.delete(token);
    if (subject.activeWaits.size > 0 || subject.inFlightCreations.size > 0) return;
    await this.#yieldFinalReview(owner, subject);
  }

  /**
   * 批次内容收集（等待出口构造交付载体时调用）：按分配次序装配本批条目并扣减批预算。
   *
   * 分配规则（设计 §2.6）：触发目标优先，其余按就绪时刻 FIFO，同时刻并列按作业 id
   * 字典序；每条取剩余批预算与条目长度的较小值（超批预算单条按首尾保留裁剪——由
   * 调用方渲染层执行，本层给出裁剪目标长度）；预算耗尽后到达的条目整条延后。
   * 关批（全部活等待提交）由调用方在交付载体提交后调 `closeBatchIfIdle`。
   *
   * 默认只装配**终态**条目；`includeRunning`（零等待出口使用，设计 §3.2.3「零等待
   * 对作业目标可交付当前未交付增量」）把有未交付缓冲的**运行中**条目也纳入——装配
   * 后只推进缓冲游标（已发增量不重发），**不置认领与已交付事实**：最终结果在终态后
   * 照常经完成消息或后续批次交付，增量交付不终结条目生命周期（曾实证的缺陷形态：零等待
   * 返回称增量已附、实际装配层把运行中条目整体滤除）。
   *
   * @param {unknown} owner - 主体。
   * @param {{triggerJobIds?: string[], lang?: string, includeRunning?: boolean,
    *   consumeRecovery?: boolean}} [options]
   * @returns {{delivered: Array<{jobId, terminal, text, truncated, lossy, spillPaths, chars}>,
   *   deferred: string[], deferredNote: string}}
   */
  collectBatch(owner, options = {}) {
    const subject = this.#subject(owner);
    const trigger = new Set(options.triggerJobIds ?? []);
    const includeRunning = options.includeRunning === true;
    // 恢复装配（RESULT-RECOVERY-01 §2.6 恢复流装配）：挂起的恢复请求在候选
    // 分配之前消费——恢复条目即本次出口的触发目标，优先取份额。单个恢复条目
    // 只服务一份额：份额内正文按字符顺序切片（长度＝剩余批预算与未服务长度的
    // 较小值），读取游标在装配点推进并记录推进区间与本次恢复调用的取消信号
    // （回合收尾复检中止即回退）。标记行＋位置说明行入必要说明层——**另计**
    // 内容预算、不裁剪、不入可裁剪说明的截断序列（clampNote），正文切片才计入当批条目数
    // 与字符预算；批满/预算尽/同批已装配过恢复条目/恢复调用信号已中止时整条
    // 延后（保持挂起，下一批自游标续）。不置认领、不写作业缓冲、不重置已交付
    // 事实、不登记新份额——标记行＋游标回退即恢复载体自身的送达保护，不递归
    // 保留副本的副本。
    let recoveryItem = null;
    let recoveryDeferred = false;
    // 恢复消费限定等待载体（RECOVERY-YIELD-CARRIER，需求 9.3.2）：consumeRecovery
    // 显式选择加入（仅 lib/wait.js 的批次装配传入）；不传（默认）不消费——
    // stagedRecovery 保持挂起，等待下一个等待载体批次。async_run／async_workflow
    // 的让出批次不传该选项：终态份额带 recovery_line 会被两工具 outputs schema
    //（additionalProperties:false）拒绝、增量份额 terminal:null 使投影读 .status
    // 抛 TypeError、且游标已推进无法回退——恢复装配从构造上就不属于让出载体。
    if (options.consumeRecovery === true && subject.stagedRecovery !== null) {
      const stagedJobId = subject.stagedRecovery.jobId;
      const stagedEntry = this.entryFor(stagedJobId, owner);
      const state = stagedEntry !== undefined
        ? this.#recoveryStreamState(subject, stagedJobId)
        : null;
      if (stagedEntry === undefined || state === null) {
        subject.stagedRecovery = null; // 行卸载/过期/流取尽：请求作废
      } else {
        if (subject.batch === null) subject.batch = this.#newBatch(subject, stagedEntry.config);
        const lang = stagedEntry.config.agentLang ?? 'en';
        const signal = options.carrierSignal ?? null;
        if (subject.batch.items >= MAX_BATCH_ITEMS
          || subject.batch.recoveryAssembled === true
          || subject.batch.remaining <= 0
          || signal?.aborted === true) {
          // 整条延后：保持挂起（stagedRecovery 不清），随 deferred 清单可见。
          recoveryDeferred = true;
        } else {
          const { portion, from } = state;
          const sliceLen = Math.min(subject.batch.remaining, portion.text.length - from);
          const slice = portion.text.slice(from, from + sliceLen);
          this.#chargeBatch(subject, subject.batch, sliceLen);
          subject.batch.items += 1;
          subject.batch.recoveryAssembled = true;
          // 游标推进＋推进记录（§2.6：回合收尾复检中止、undoClaim 回退）。
          let stream = subject.recoveryStreams.get(stagedJobId);
          if (stream === undefined) {
            stream = { ord: null, offset: 0, advances: [] };
            subject.recoveryStreams.set(stagedJobId, stream);
          }
          stream.ord = portion.ord;
          stream.offset = from + sliceLen;
          stream.advances.push({ ord: portion.ord, from, to: from + sliceLen, signal });
          const more = portion.text.length - (from + sliceLen) > 0;
          recoveryItem = {
            jobId: stagedJobId,
            terminal: portion.terminal,
            text: slice,
            truncated: false,
            lossy: false,
            spillPaths: [],
            chars: sliceLen,
            recovery: true,
            // 恢复头（必要说明层）：标记行＋位置说明行——render 时置于状态行后、
            // 正文前，不裁剪、不占内容预算（切片已全额计入）。
            recoveryHead: [
              t(lang, 'delivery.recoveryMarker', { jobId: stagedJobId }),
              t(lang, 'delivery.recoveryPosition', {
                index: portion.ord,
                from: from + 1,
                to: from + sliceLen,
                state: t(lang, more ? 'delivery.recoveryMore' : 'delivery.recoveryDone')
              })
            ].join('\n'),
            // 回滚凭据（undoClaim：载体构造失败把游标回退到装配前位置）。
            recoveryOrd: portion.ord,
            recoveryFrom: from
          };
          subject.stagedRecovery = null;
        }
      }
    }
    const candidates = [];
    for (const entry of this.jobs.values()) {
      if (entry.owner !== owner) continue;
      // 运行中条目进批口径（零等待出口，设计 §3.2.3）：有未交付缓冲（增量），
      // 或运行中**读取失败**（WAIT-INCREMENT-01——失败定论后缓冲为空，但状态行
      // ＋重试出路必须可见，不能因空缓冲整条滤除；装配走 readFailed 分支零扣减）。
      if (entry.terminal === null
        && !(includeRunning && (entry.buffer !== '' || entry.readFailed))) continue;
      // 空正文终态条目保留（设计 2.4「无输出完成的作业在批次中以状态行可见」）：
      // 不因 `buffer === ''` 整条滤除——非触发目标的无输出作业同样进批（状态行
      // 条目，`takeShare` 对空正文零扣减、不占预算）。读取失败条目（readFailed）
      // 同样保留：状态行＋重试出路进批，不置已交付事实（WAIT-READ-01——失败
      // 空条目不得被标为已交付）。
      if (entry.claimedBy === 'message') continue; // 完成消息已认领（本批不重复展开正文）
      // 已交付阻断（9.3.2「同一最终结果只出现一次」）——例外：partial 交付
      // （首尾已交付、裁剪中段仍在缓冲）可继续进批交付续段（9.3.2「已消费但
      // 尚未交付的内容不能因裁剪永久丢失」）。
      if (entry.deliveredFact !== null
        && !(entry.deliveredFact.partial === true && entry.buffer !== '')) continue;
      candidates.push(entry);
    }
    // 分配次序：触发目标优先 → 就绪时刻 FIFO → 作业 id 字典序。
    candidates.sort((a, b) => {
      const at = trigger.has(a.jobId) ? 0 : 1;
      const bt = trigger.has(b.jobId) ? 0 : 1;
      if (at !== bt) return at - bt;
      if (a.readyAt !== b.readyAt) return a.readyAt - b.readyAt;
      return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
    });
    const lang = options.lang ?? 'en';
    const firstConfig = candidates[0]?.config;
    // 空候选不开批：首个并行等待的空候选调用若在此开批，批预算会被 fallback
    // 4096 锁死，后续同批真实分配反而用不上 maxResultChars（默认 12000）——
    // 批随首个**有候选**的调用按其条目配置开（echoOn 同此定值）。
    if (subject.batch === null && candidates.length > 0) {
      subject.batch = this.#newBatch(subject, firstConfig);
    }
    const delivered = recoveryItem === null ? [] : [recoveryItem];
    const deferred = recoveryDeferred && subject.stagedRecovery !== null
      ? [subject.stagedRecovery.jobId]
      : [];
    for (const entry of candidates) {
      // 读取失败条目：状态行＋重试出路进批，不置认领与已交付事实（正文未取
      // 得，置事实会让重试读取的结果永远无法交付）；算入条目数（状态行占位），
      // 条目数到上限时同样延后。跨载体一次性判据（REL-READ-02）：该次失败的
      // 通知已被任一载体装配（readFailedNoted）则整条跳过，不重复提示。
      if (entry.readFailed) {
        if (entry.readFailedNoted) continue;
        if (subject.batch.items >= MAX_BATCH_ITEMS) {
          deferred.push(entry.jobId);
          continue;
        }
        subject.batch.items += 1;
        entry.readFailedNoted = true;
        delivered.push({
          jobId: entry.jobId,
          terminal: entry.terminal,
          text: '',
          truncated: false,
          lossy: false,
          spillPaths: [],
          chars: 0,
          readFailed: true
        });
        continue;
      }
      // 条目上限（设计 §2.6：单批至多 10 条，含完成消息已投条目——批次对象
      // 统一计数）与预算耗尽（「剩余预算为零后到达的条目整条延后」）都整条
      // 延后——缓冲保留，下一批按 FIFO 优先交付。空正文条目（状态行条目）不
      // 因预算延后：无正文可分配，延后只会把「已完成」推迟可见。
      if (subject.batch.items >= MAX_BATCH_ITEMS
        || (subject.batch.remaining <= 0 && entry.buffer !== '')) {
        deferred.push(entry.jobId);
        continue;
      }
      const item = this.#takeShare(entry, subject, subject.batch);
      subject.batch.items += 1;
      delivered.push(item);
      // 认领与缓冲处理：构造点即认领（调用方提交失败按真实装配回滚 undoClaim；
      // 宿主提交后的改写属不可观测窗口——设计 §2.6 失败分类，不在此处理）。
      if (entry.terminal !== null) {
        // 裁剪条目（truncated）的省略中段按装配前原文保留缓冲并置 partial
        // 事实——续段可再进批，中段不因裁剪永久丢失（9.3.2）；完整交付才
        // 清空并置完全事实。
        if (item.truncated) {
          entry.buffer = item.remainder;
          entry.deliveredFact = { via: 'wait', partial: true };
          entry.readyAt = this.now();
        } else {
          entry.buffer = '';
          entry.deliveredFact = { via: 'wait' };
          entry.readyAt = null;
        }
        entry.claimedBy = 'wait';
        // 留存行游标推进（RA-SPILL-LOCATOR）：本批列出的留存路径自此视为
        // 已列——认领点推进，回滚经 undoClaim 的 spillBefore 凭据回退。
        if (item.spillCount > 0) entry.spillListed = item.spillFrom + item.spillCount;
        // 份额登记（§2.6 载体判据表「等待返回」行）：装配即登记
        //（载体构造无异常＝认领点）；`signal`＝本次等待调用的 exec.signal
        //（回合收尾确认的中止复检凭据）。确认判据在事件监听（见
        // attachClaimedListener 的 onTurnStopping）。partial＋续段两档都交、
        // 不合并（§2.6 份额登记）：份额记**本次装配正文**，续段由后续载体另行登记。
        this.#registerRecovery(owner, entry.jobId, {
          text: item.text,
          partial: item.truncated === true,
          terminal: entry.terminal,
          via: 'wait',
          signal: options.carrierSignal ?? null
        }, entry.config);
      } else {
        // 运行中增量（includeRunning）：只推进游标——已发增量不重发；被裁剪的
        // 省略中段同样按原文保留缓冲（随后续增量或终态批次续交），不置认领/
        // 已交付事实，最终结果仍在终态后投递。
        entry.buffer = item.truncated ? item.remainder : '';
        entry.readyAt = this.now();
        // 留存行游标推进：同终态分支（认领点推进、回滚凭据回退）。
        if (item.spillCount > 0) entry.spillListed = item.spillFrom + item.spillCount;
        // 增量份额登记（§2.6 份额登记点＝collectBatch 终态条目与运行中增量
        // 装配）：宿主改写取消错误时该份额同样有恢复入口（9.3.2 丢失防护不
        // 区分增量与终态正文）；去重仍由增量游标承担（已发增量不重发），份额
        // 不做去重依据。确认随等待载体回合收尾（§2.6 分载体判据）。
        this.#registerRecovery(owner, entry.jobId, {
          text: item.text,
          partial: item.truncated === true,
          terminal: null,
          via: 'wait',
          signal: options.carrierSignal ?? null
        }, entry.config);
      }
    }
    // 两路口径（§2.6 领取时机句）：本键（等待返回 note_deferred）直放、完成
    // 消息路径（#deliverIfNoWait 的 deferredNotice/deferredAggregate）经
    // clampNote(200) 入界——delivery.deferred 的 en 全文按常规 jobId 插值
    // 已 ≤200（见 text.js 三键注释），两路同文不截断；zh 档无 clampNote 通道。
    const deferredNote = deferred.length > 0
      ? t(lang, 'delivery.deferred', { count: deferred.length })
      : '';
    return { delivered, deferred, deferredNote };
  }

  /**
   * 单条分配原语（两类交付载体共用，设计 §2.6）：取剩余批预算与条目长度的较小值，
   * 条长超份额按 2.4 的首尾保留裁剪＝`truncate`（词典标注带省略量）——内容预算
   * 只经本原语实施一次（读取层存原始拼接文本；「预算不被实施两次」）；裁剪省略
   * 的中段原文经 `remainder` 返回（调用方保留缓冲，续段可再交付——9.3.2「已
   * 消费但尚未交付的内容不能因裁剪永久丢失」）。完成消息载体不走本原语＝绕过
   * 共享预算（曾实证预算 100 收到 550 字符消息的缺陷形态）。
   * 回显原文（ECHO-WORKFLOW-01 设计 §2.6 回显计量）：正文份额之后经 `#takeEchoShare`
   * 接续分配——仅条目未截断时；截断条目的原文随省略中段在下一批重新分配。
   * @param {object} entry - 作业账面条目（读取 `buffer`／`terminal`／`lossy`／`spillPaths`）。
   * @param {object} subject - 主体记录（输入代记账——批扣减同步代内已交付）。
   * @param {{remaining: number, echoOn?: boolean}} budget - 批预算（就地扣减）。
   * @returns {{jobId, terminal, text, truncated, remainder, lossy, spillPaths, chars,
   *   echo?, echoTruncated?, echoKind?, echoAttached?, echoSkipped?}}
   */
  #takeShare(entry, subject, budget) {
    const want = entry.buffer.length;
    const take = Math.min(want, budget.remaining);
    let cut;
    if (take >= want) {
      cut = { text: entry.buffer, truncated: false };
    } else {
      cut = truncate(entry.buffer, take, entry.config.agentLang ?? 'en');
      cut.remainder = omittedMiddle(entry.buffer, take);
    }
    this.#chargeBatch(subject, budget, take);
    // 回显原文分配（ECHO-WORKFLOW-01 设计 §2.6「正文优先、原文用剩余份额」）：
    // 正文被裁剪的条目本批不附原文（省略中段在缓冲待续，原文随续段在下一批
    // 分配，不注记）；未截断（含空正文）条目在此一次性附上或注记未附。
    const echoFields = cut.truncated ? null : this.#takeEchoShare(entry, subject, budget);
    return {
      jobId: entry.jobId,
      terminal: entry.terminal,
      text: cut.text,
      truncated: cut.truncated,
      // 回滚凭据＝装配前原文：截断条目回滚必须退回**原文**——退回裁剪文本会让
      // 原文中段永久丢失（宿主读取游标已推进不可逆，模型又从未见过任何部分）。
      // 交付/渲染层不读本字段。
      original: entry.buffer,
      remainder: cut.truncated ? cut.remainder : '',
      lossy: entry.lossy,
      spillPaths: entry.spillPaths,
      // 留存行续取（RA-SPILL-LOCATOR）：本批自已列游标起列出的路径——
      // `spillFrom`＝装配时游标（回滚凭据 `spillBefore` 同值）、`spillCount`＝
      // 本批列出条数（预算内尽量多、至少一条）；渲染层（entryNoteLines）
      // 据此二字段列行，游标推进在认领点（collectBatch／完成消息路径）。
      spillFrom: entry.spillListed,
      spillCount: spillListCount(entry.spillPaths, entry.spillListed, entry.config.agentLang ?? 'en'),
      // 正文计量（TEXT-NOTE-01）：头部「(N chars)」报**正文字符数**＝本批取的原文
      // take——截断标注行属说明行、不占内容份额（与 echo 标注行同一口径），不得
      // 计入；未截断时 take＝全文长。预算扣减同样按 take，两口径一致。
      chars: take,
      // §2.3 正文去向结论随条目（三载体共用 entryNoteLines 呈现；正文裁剪
      // partial 的续段条目不再带——结论已随首段呈现）。
      ...(entry.bodyDisposition !== null && !cut.truncated
        ? { bodyDisposition: entry.bodyDisposition }
        : {}),
      ...(echoFields ?? {})
    };
  }

  /**
   * 回显原文的批次分配（ECHO-WORKFLOW-01 设计 §2.6 回显计量）：在正文份额之后
   * 执行，R＝`budget.remaining`（正文扣减后的剩余份额）。前置：批 `echoOn`
   * 开、`echoText` 非空、`echoAttached` 未置。形态：
   * - `E ≤ R`：全量附上，扣减 E，置一次性状态；
   * - `0 < R < E`：按 `truncate` 的 6:4 首尾保留裁剪到 R，标注行
   *   （`delivery.echoTruncated`）写明省略量 `E − R`——标注行属说明行，不占
   *   内容份额（与 `truncate` 内嵌标注同一口径）；扣减 R，置一次性状态。
   *   被裁中段不设模型侧找回通道——**原文在模型自身的调用参数中已在场，界面
   *   原始记录（调用卡片、recorder 持久记录）完整可查**，模型侧再设通道只是
   *   同一输入内的重复（设计 Q2 定案）；
   * - `R ≤ 0`（定案 M3 的两种形态：空正文条目进入分配时剩余已为零；非空正文
   *   恰好整份耗尽剩余——`want === remaining` 未截断，条目随即完全交付、不再
   *   进批）：不附、零扣减、不置状态，注记 `delivery.echoSkipped`（入既有
   *   说明配额）——「原文未附：本批结果字符预算已用尽」是该次不附唯一的模型
   *   可见说明（条目已完全交付，不会在后续批次补附）。
   * 正文被裁剪（truncated）的条目不进本原语（`#takeShare` 已分流）：其原文
   * 本批不附也不注记，随续段在下一批重新分配（设计 §2.6 回显计量的推论）。
   * @param {object} entry - 作业账面条目。
   * @param {object} subject - 主体记录（输入代记账——批扣减同步代内已交付）。
   * @param {{remaining: number, echoOn?: boolean}} budget - 批预算（就地扣减）。
   * @returns {{echo: string, echoTruncated: boolean, echoKind: string,
   *   echoAttached: true} | {echoSkipped: true} | null} 装配字段（展开进条目
   *   与回滚凭据；null＝本条目无原文动作）。
   */
  #takeEchoShare(entry, subject, budget) {
    if (budget.echoOn !== true || entry.echoText === '' || entry.echoAttached) return null;
    const full = entry.echoText;
    const remaining = budget.remaining;
    if (remaining <= 0) return { echoSkipped: true };
    if (full.length <= remaining) {
      this.#chargeBatch(subject, budget, full.length);
      entry.echoAttached = true;
      return { echo: full, echoTruncated: false, echoKind: entry.echoKind, echoAttached: true };
    }
    const head = Math.floor(remaining * 0.6);
    const tail = remaining - head;
    const omitted = full.length - remaining;
    this.#chargeBatch(subject, budget, remaining);
    entry.echoAttached = true;
    return {
      echo: `${full.slice(0, head)}\n\n${t(entry.config.agentLang ?? 'en', 'delivery.echoTruncated', { omitted })}\n\n${full.slice(full.length - tail)}`,
      echoTruncated: true,
      echoKind: entry.echoKind,
      echoAttached: true
    };
  }

  /**
   * 交付载体提交失败回滚（等待出口取消等）：正文退回缓冲、认领撤销，供下一载体携带。
   * 只处理本批装配/待投递产生的条目（via 'wait'/'message'）——首次等待直付的
   * 'first-wait' 事实不在此列（交付已真实发生，模型已见，不可撤销）。截断条目按
   * 装配前原文（`original`）退回，不得按裁剪文本退回（中段不得丢失）；partial
   * 装配后缓冲里的省略中段（`remainder` 前缀）被原文覆盖，装配之后新追加的增量
   * 保留在尾部。
   *
   * 凭据形态与分支不变量（REL-SEND-02/REL-READ-02）：`original`／`remainder`
   * 只属于 `#takeShare` 产生的正文凭据（`{jobId, text, original, remainder}`，
   * 走「以外文重建缓冲」分支）；空正文完成项与读取失败注记的凭据为
   * `{jobId, text: ''}`、**不带 `original`**——走「正文前置退回」分支保缓冲
   * （读取失败条目可达「缓冲保留待续段」状态，`original: ''` 会把缓冲整体
   * 置空、永久丢失已消费未交付增量）。回滚同时清除读取失败条目的通知占位
   * （通知没有送达，允许下一载体重投）。
   */
  undoClaim(owner, items) {
    for (const item of items ?? []) {
      // 恢复条目的回滚＝恢复游标回退（RESULT-RECOVERY-01 §2.6「回退以推进凭据
      // 与流前缀一致为前提」），不写作业缓冲、不清认领、不重置已交付事实
      // ——恢复交付不置这些状态；若误走 `original` 回写，会把「标记行＋正文
      // 切片」当成作业正文写回 buffer 并清 deliveredFact（minor ① 的缺陷形态）。
      // 身份校验分三档：
      // - **合法回滚**：凭据的份额序＝当前流份额序、其后无新推进（流未越过该
      //   区间——已定案推进随份额清除、同份额更后的在册推进都会改变流位置）
      //   → 清回退点之后的推进记录、游标回退到装配前位置；
      // - **迟到凭据（流已前进）**：只丢弃该条目自身的推进记录（若仍在册），
      //   不动游标——已按可能重复警示交回的内容不回退重取，避免旧份额的迟到
      //   回滚把新流重置到已发位置、从新份额头部重发；
      // - **流已移除**（份额清空后的流校正，份额序不复用）：零操作——不重建
      //   流、不复活旧序号。
      if (item.recovery === true) {
        const subject = this.subjects.get(owner);
        const stream = subject?.recoveryStreams.get(item.jobId);
        if (stream === undefined) continue;
        const stillCurrent = stream.ord === item.recoveryOrd
          && !stream.advances.some((adv) => adv.ord === item.recoveryOrd
            && adv.from > item.recoveryFrom);
        if (stillCurrent) {
          stream.ord = item.recoveryOrd;
          stream.offset = item.recoveryFrom;
          stream.advances = stream.advances.filter((adv) => adv.ord < item.recoveryOrd
            || (adv.ord === item.recoveryOrd && adv.to <= item.recoveryFrom));
        } else {
          stream.advances = stream.advances.filter((adv) => !(adv.ord === item.recoveryOrd
            && adv.from === item.recoveryFrom));
        }
        continue;
      }
      const entry = this.entryFor(item.jobId, owner);
      if (entry === undefined) continue;
      if (typeof item.original === 'string') {
        const tail = typeof item.remainder === 'string' && entry.buffer.startsWith(item.remainder)
          ? entry.buffer.slice(item.remainder.length)
          : '';
        entry.buffer = item.original + tail;
      } else {
        entry.buffer = (item.text ?? '') + entry.buffer;
      }
      entry.claimedBy = null;
      entry.deliveredFact = null;
      // 留存行游标回退（RA-SPILL-LOCATOR）：装配失败（通道故障回滚）时
      // 本批列出的路径并未送达，游标退回装配前位置，下一载体重列。凭据两种
      // 形态同值同义：完成消息路径在 #releaseClaims 预映射 `spillBefore`；
      // 等待出口的回滚条目直传 collectBatch 原始装配（#takeShare 携带
      // `spillFrom`＝装配时游标）——只认其一会让另一路径已列的说明行永不重列。
      const spillRestore = item.spillBefore ?? item.spillFrom;
      if (typeof spillRestore === 'number') {
        entry.spillListed = Math.min(entry.spillListed, spillRestore);
      }
      // 回显一次性状态随凭据标记清位（ECHO-WORKFLOW-01 设计 §2.6「一次性附上、
      // 仅投递回滚清位后可重投」）：装配过
      // 原文的条目回滚后回到「未附」，下一载体可重附；凭据不带标记的条目
      // （读取失败注记、未附原文的条目）没有可清的状态——echoSkipped 注记
      // 本就不置状态。
      if (item.echoAttached === true) entry.echoAttached = false;
      if (entry.readFailed === true) entry.readFailedNoted = false;
      if (entry.readyAt === null) entry.readyAt = this.now();
    }
  }

  /**
   * 等待返回全部提交后的关批判定（设计 §2.6：主体全部本包活等待均已返回提交时关批）。
   * 调用点：每笔等待返回提交后；无活等待即关闭当前批（下一批按代内剩余开批
   * ——全额仅在代重置后）。在途创建认领在场时不关批（ACCEPT-BATCH-01：同一
   * 领取窗口的并行创建调用仍是本批潜在载体，先关批＝并行调用按代内剩余各取
   * 批额度）。
   */
  closeBatchIfIdle(owner) {
    const subject = this.subjects.get(owner);
    if (subject === undefined) return;
    if (subject.activeWaits.size === 0 && subject.inFlightCreations.size === 0) subject.batch = null;
  }

  /**
   * 完成消息交付（无活等待路径，设计 §2.6）：构造点原子认领（`claimedBy`）——先构造
   * 交付内容的一方为认领方；主体有本包活等待时不投（让位给等待返回）。投递经
   * `followup`（空闲且无未领取本包通知）或 `inject`（忙），与迟到作答同一通道；
   * 同一领取窗口内多结算合并一条 `followup` 轮次（待启动投递登记 + 单次 flush）。
   * 认领在宿主接受点释放（`#releaseClaims`，REL-RECOVER-02）：仲裁只在「构造 →
   * 接受/回滚」的在途窗口内保持；释放后 partial 续段经批次/让位复查/零等待恢复。
   */
  async #deliverIfNoWait(entry, options = {}) {
    const subject = this.#subject(entry.owner);
    if (subject.activeWaits.size > 0 || subject.inFlightCreations.size > 0) return;
    if (entry.terminal === null) return;
    if (entry.claimedBy === 'message') return;
    // 已交付阻断（9.3.2）——例外：partial 交付的续段可继续投（同 collectBatch）。
    if (entry.deliveredFact !== null
      && !(entry.deliveredFact.partial === true && entry.buffer !== '')) return;
    const lang = entry.config.agentLang ?? 'en';
    // 读取失败条目：不投正文、不置事实——投「真实结局＋读失败标记＋重试出路」
    // 的注记（WAIT-READ-01/REL-READ-02：读取失败的条目不得被标为已交付，重试
    // 读取的结果仍可交付；注记按空正文形态构造合成零字符条目走完整渲染管线
    // ——终态状态行、结局标记行、诊断首行齐备，读取持续失败时这是该结局唯一
    // 的模型可见载体）。注记同样进批记账（计条目数；字符预算不约束——注记零
    // 内容字符）并走认领（防同窗口重复堆积）；跨载体一次性判据：该次失败的
    // 通知已被任一载体装配（readFailedNoted）则不投。
    if (entry.readFailed) {
      if (entry.readFailedNoted) return;
      if (subject.batch === null) {
        subject.batch = this.#newBatch(subject, entry.config);
      }
      // 条目上限（与 collectBatch 的 readFailed 分支同语义：只判条目上限，字符
      // 预算不参与）。超限不认领、不清占位，投有界延后说明（批级配额与同批
      // 去重见 #pushBoundedDeferredNote），正文结局由下一批交付。
      if (subject.batch.items >= MAX_BATCH_ITEMS) {
        await this.#pushBoundedDeferredNote(subject, entry, lang, options);
        return;
      }
      subject.batch.items += 1;
      entry.claimedBy = 'message';
      entry.readFailedNoted = true;
      const noticeItem = {
        jobId: entry.jobId,
        terminal: entry.terminal,
        text: '',
        truncated: false,
        lossy: false,
        spillPaths: [],
        chars: 0
      };
      subject.pendingSends.push({
        kind: 'completion',
        jobId: entry.jobId,
        lang,
        // 回滚凭据不带 original：读取失败条目可能持有待续段缓冲（includeRunning
        // 裁剪保留段、首次等待 pendingTail），回滚必须走 undoClaim 的「正文前置
        // 退回」分支保缓冲；回滚同时清通知占位（通知没送达，允许重投）。
        items: [{ jobId: entry.jobId, text: '' }],
        render: () => `${renderCompletionMessage(lang, [noticeItem])}\n${clampNote(t(lang, 'delivery.readFailed', { jobId: entry.jobId }))}`
      });
      if (options.deferFlush !== true) await this.#flushPendingSends(entry.owner);
      return;
    }
    // 完成消息与等待批次**共用同一分配管线**（需求 9.3.2/验收 7：多作业、多条完成
    // 消息和多个工具返回共享 maxResultChars，不按载体形态倍增预算）。
    if (subject.batch === null) {
      subject.batch = this.#newBatch(subject, entry.config);
    }
    // 批预算耗尽或条目数到上限（并行领取窗口内其他载体已扣完/投满，设计 §2.6
    // 「剩余批次预算为零后到达的条目整条延后」与「单批至多 10 条」——批次对象
    // 统一计数，完成消息不绕过条目额度）：条目上限对**一切**条目独立生效
    // （REL-BATCH-02——条目计数若以「正文非空」为前提即被架空，同窗口 12 个空
    // 输出作业会发出 12 条完成消息；状态行、标识与诊断同样占模型输入）；
    // 字符预算只约束非空正文（空正文零扣减，预算耗尽仍按状态行交付——不得因
    // 修正把空条目也按预算延后）。与 collectBatch 同语义——不认领、不清缓冲、
    // 不置已交付事实，投有界延后说明（#pushBoundedDeferredNote：逐条＋聚合受
    // 批级配额与同批去重约束，经 clampNote 入界——jobId 是宿主不透明字符串，
    // 领取出路照抄）；正文由下一批（领取点关批、代内剩余额度开新批）或
    // `async_wait(wait_ms=0)` 完整交付——代内额度耗尽时中段至迟在下一次模型
    // 输入内可领取（`agent/pre-step` 重置输入代）。（take=0 仍投截断标注的空壳并清缓冲会把
    // 正文永久丢失——空壳无法续取，9.3.2 防丢失红线。）
    if (subject.batch.items >= MAX_BATCH_ITEMS
      || (subject.batch.remaining <= 0 && entry.buffer !== '')) {
      await this.#pushBoundedDeferredNote(subject, entry, lang, options);
      return;
    }
    entry.claimedBy = 'message';
    const items = [];
    if (entry.buffer !== '') items.push(this.#takeShare(entry, subject, subject.batch));
    subject.batch.items += 1;
    // 空正文终态条目与有正文条目共用同一渲染管线（合成零字符条目）——状态行、
    // 结局标记行、诊断行、lossy／留存行的行序与预算两档口径完全一致；单独的
    // 单行捷径会漏掉终态细节（REL-TERMINAL-01：无输出完成的 killed 作业同样
    // 要让信号与诊断可见）。回显原文在合成条目上同样分配（ECHO-WORKFLOW-01
    // 设计 §2.6：#takeShare 只覆盖有正文条目，空正文条目的原文分配点在此补齐
    // ——与正文条目同判同形态）。
    const echoFields = items.length > 0 ? null : this.#takeEchoShare(entry, subject, subject.batch);
    const renderItems = items.length > 0 ? items : [{
      jobId: entry.jobId,
      terminal: entry.terminal,
      text: '',
      truncated: false,
      lossy: entry.lossy,
      spillPaths: entry.spillPaths,
      // 空正文合成条目同走留存行续取（#takeShare 不覆盖此形态，字段在此补齐）。
      spillFrom: entry.spillListed,
      spillCount: spillListCount(entry.spillPaths, entry.spillListed, lang),
      chars: 0,
      ...(entry.bodyDisposition !== null ? { bodyDisposition: entry.bodyDisposition } : {}),
      ...(echoFields ?? {})
    }];
    subject.pendingSends.push({
      kind: 'completion',
      jobId: entry.jobId,
      lang,
      // 回滚凭据（flush 通道失败时经 undoClaim 退回，正文与结局不因通道故障
      // 丢失）：有正文条目为 `#takeShare` 产物的四字段——original＝装配前原文
      // （截断条目按原文回滚，中段不得丢失）、remainder＝省略中段（装配后经
      // readIncremental 追加的增量在回滚时按前缀判 tail 保留——完成消息路径
      // 丢弃该字段会让追加增量在回滚时丢失）；空正文条目
      // `{ jobId, text: '' }` 不带 original（走保缓冲分支，见 undoClaim 注释）
      // ——空输出作业的结局同样不得在通道失败后被误记已交付（REL-SEND-02）。
      // `echoAttached` 标记随凭据携带（ECHO-WORKFLOW-01 设计 §2.6）：装配过
      // 原文的条目回滚时清一次性状态、下一载体可重附；读取失败注记的凭据
      // （上方 readFailed 分支）不带标记——其条目不附原文。
      items: items.length > 0
        ? items.map((item) => ({
          jobId: item.jobId,
          text: item.text,
          original: item.original,
          remainder: item.remainder,
          ...(item.spillFrom !== undefined ? { spillBefore: item.spillFrom } : {}),
          ...(item.echoAttached === true ? { echoAttached: true } : {})
        }))
        : [{
          jobId: entry.jobId,
          text: '',
          spillBefore: renderItems[0].spillFrom,
          ...(echoFields?.echoAttached === true ? { echoAttached: true } : {})
        }],
      render: () => renderCompletionMessage(lang, renderItems)
    });
    // 裁剪条目保留省略中段（partial 事实，续段可再投）；完整交付才清空。
    const item = items[0];
    if (item !== undefined && item.truncated) {
      entry.buffer = item.remainder;
      entry.deliveredFact = { via: 'message', partial: true };
      entry.readyAt = this.now();
    } else {
      entry.buffer = '';
      entry.deliveredFact = { via: 'message' };
      entry.readyAt = null;
    }
    // 留存行游标推进（RA-SPILL-LOCATOR）：认领点推进（空正文合成条目同），
    // 回滚经 undoClaim 的 spillBefore 凭据回退。
    const spillRef = items[0] ?? renderItems[0];
    if (spillRef.spillCount > 0) entry.spillListed = spillRef.spillFrom + spillRef.spillCount;
    if (options.deferFlush !== true) await this.#flushPendingSends(entry.owner);
  }

  /**
   * 超限延后说明的有界投递（REL-NOTES-01，设计 §2.6）：完成消息路径两个超限
   * 分支（readFailed 超限与正文超限）共用。规则：
   * - **同批同作业去重**——本批已得过逐条说明或已计入聚合集合的作业，重复
   *   触发不投新说明、不改变状态（逐条说明已在待投递登记或已投递，恢复方式
   *   已给；内容仍在缓冲，不属于丢失。聚合未冲刷时 render 读活集合，重复
   *   注册不重复计数；已冲刷则不再补投）。
   * - **逐条配额**——每批至多 `MAX_DEFERRED_NOTE_ITEMS` 条（先到先得），沿用
   *   `delivery.deferredNotice`（作业标识＋定向 `async_wait` 领取示例）。
   * - **聚合配额**——逐条配额用尽后的延后作业计入 `aggJobs`；每批至多
   *   `MAX_DEFERRED_NOTE_SUMMARIES` 条聚合 send（`delivery.deferredAggregate`：
   *   计数＋不带 targets 的零等待一并领取示例——恢复动作不依赖计数精确，对
   *   读取失败条目同样成立：一并领取返回状态行与重试出路、不重读正文，定向
   *   零等待才触发重试读取）。
   * - **批级上界**——合计 ≤4 条 send、≤800 字符，数值固定可测（需求 9.3.2）。
   *   超配额后同批再到的延后作业不追加说明：内容保留在缓冲（不认领、不清
   *   缓冲、不置已交付事实），下一批按 FIFO 优先交付或零等待领取恢复，不
   *   静默丢失；同批内说明不重投，重投只发生在下一批且仅当该批再次超限。
   * - 聚合 send 的 render 在 push 时**捕获本批 aggJobs 集合本身**——渲染只读
   *   捕获引用，禁止冲刷时经 `subject.batch` 重寻址（登记→冲刷之间到达的
   *   claimed 事件会把 batch 置 null，重寻址会使 render 抛错、触发空闲整队
   *   回滚或忙碌路径自失败项起回滚）；捕获的集合在关批后仍是普通对象，计数
   *   保持该批最终值。
   * 配额状态挂在本批对象（`deferredNotes` 惰性初始化），随两处关批点丢弃批
   * 对象自然复位——各开批点无须逐点补字段。
   * @param {SubjectRecord} subject - 主体条目（batch 已开）。
   * @param {JobRecord} entry - 超限延后的作业条目。
   * @param {string} lang - 语言。
   * @param {{deferFlush?: boolean}} options - 冲刷时机（与 #deliverIfNoWait 同参；
   *   仅在实际推入说明时冲刷——去重命中的重复触发无新内容，不冲刷）。
   */
  async #pushBoundedDeferredNote(subject, entry, lang, options = {}) {
    const notes = subject.batch.deferredNotes ??= {
      individualJobs: new Set(),
      individual: 0,
      aggJobs: new Set(),
      aggSent: 0
    };
    if (notes.individualJobs.has(entry.jobId) || notes.aggJobs.has(entry.jobId)) return;
    let pushed = false;
    if (notes.individual < MAX_DEFERRED_NOTE_ITEMS) {
      notes.individual += 1;
      notes.individualJobs.add(entry.jobId);
      subject.pendingSends.push({
        kind: 'completion',
        jobId: entry.jobId,
        lang,
        items: [],
        render: () => clampNote(t(lang, 'delivery.deferredNotice', { jobId: entry.jobId }))
      });
      pushed = true;
    } else {
      // 先入集合再推 send：聚合 render 现读捕获的集合引用，deferFlush 窗口内
      // 后到的延后作业计入同一条聚合（计数为冲刷时最终值）。
      notes.aggJobs.add(entry.jobId);
      if (notes.aggSent < MAX_DEFERRED_NOTE_SUMMARIES) {
        notes.aggSent += 1;
        const aggJobs = notes.aggJobs;
        subject.pendingSends.push({
          kind: 'completion',
          jobId: null,
          lang,
          items: [],
          render: () => clampNote(t(lang, 'delivery.deferredAggregate', { count: aggJobs.size }))
        });
        pushed = true;
      }
    }
    if (pushed && options.deferFlush !== true) await this.#flushPendingSends(entry.owner);
  }

  /**
   * 待启动投递登记的冲刷：合并同一领取窗口内的登记为一次通道投递（空闲一条 followup
   * 开轮；忙时逐条 inject——宿主整批领取，同窗口多条由宿主合并）。失败保留待重试：
   * 正文退回缓冲，下一结算或等待出口触发重新携带，不因通道故障永久丢失。
   * 成功侧在宿主接受点释放认领（`#releaseClaims`，REL-RECOVER-02）；载体消息对象先构造再注入（`createUserMessage` 构造期
    * 生成消息 `id`），份额按该 id 关联实际载体（ACCEPT-RECOVERY-MESSAGE-01
    * 设计 §2.6）。
   *
   * 回滚边界按「宿主提交点」划（rc.5 `dsh-agent-loop` 的 inbox `mutate`：
   * `session.append` 是持久提交点，此前抛错＝未接受）：空闲路径一条合并
   * `followup` 单次调用、无部分接受，失败整队回滚；忙路径逐条 `inject`，
   * **部分失败只回滚失败项及其后**——`inject` 正常返回＝已持久入箱（已接受），
   * 回滚已接受项会造成重复交付（REL-SEND-01）。提交点之后第三方监听器抛错
   * 的形态本包无法从异常对象区分，按已登记的不可观测窗口处理（JobRecord.buffer
   * 注释）。
   */
  async #flushPendingSends(owner) {
    const subject = this.subjects.get(owner);
    if (subject === undefined || subject.pendingSends.length === 0) return;
    let agent;
    try {
      agent = this.#agentFor(owner);
    } catch {
      agent = undefined;
    }
    if (agent === undefined) {
      log(`completion delivery for ${String(owner)} lost: agent registry miss`);
      // 回滚（R57②）：认领撤销、正文退回缓冲——下一等待返回或结算触发重新携带，
      // 不因通道故障（注册表缺席）永久丢失一次性 result 正文。
      const failedSends = subject.pendingSends;
      subject.pendingSends = [];
      this.undoClaim(owner, failedSends.flatMap((send) => send.items ?? []));
      return;
    }
    const queue = subject.pendingSends;
    const lang = queue[0]?.lang ?? 'en';
    subject.pendingSends = [];
    let idle = false;
    try {
      idle = agent.status === 'idle';
    } catch {
      idle = false;
    }
    try {
      if (idle) {
        const merged = queue.map((send) => send.render());
        const text = merged.join('\n\n');
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: JOB_RESULT_SOURCE, form: 'notice', summary: completionSummary(lang, queue) }
        });
        agent.followup(message);
        // 接受点释放认领（REL-RECOVER-02）：单次调用、无部分接受，未抛＝整队
        // 已被宿主接受——在途仲裁窗口关闭，partial 条目的续段自此可再取；
        // 份额按合并消息的构造期 `id` 关联载体（一条消息多份额同 id）。
        for (const send of queue) this.#releaseClaims(send, owner, message);
        return;
      }
      for (let k = 0; k < queue.length; k += 1) {
        const send = queue[k];
        // 载体消息先构造、后注入（ACCEPT-RECOVERY-MESSAGE-01 设计 §2.6）：
        // `createUserMessage` 在构造期生成消息 `id`（宿主 dsh-llm 消息工厂），
        // 注入与接受点共用同一对象——份额按 `message.id` 关联实际载体，
        // 领取/丢弃事件按 id 匹配回该份额。
        const message = createUserMessage({
          content: [{ type: 'text', text: send.render() }],
          source: { kind: JOB_RESULT_SOURCE, form: 'notice', summary: completionSummary(lang, [send]) }
        });
        try {
          agent.inject(message);
        } catch (error) {
          log(`completion delivery for ${String(owner)} failed at item ${String(k + 1)}/${String(queue.length)}: ${String(error?.message ?? error)}`);
          // 部分回滚：下标 k 之前的项 `inject` 已正常返回＝宿主已接受，认领已
          // 释放、已交付事实保持（不重现）；失败项及其后按装配前原文退回缓冲
          // （截断条目中段不丢），交下一载体重试。`items: []` 的说明型 send 无
          // 回滚凭据，undoClaim 对其空转——说明文本丢弃可接受（同批内不重投，
          // 下一批再次超限时按新批配额重新说明）。
          this.undoClaim(owner, queue.slice(k).flatMap((rest) => rest.items ?? []));
          return;
        }
        // 接受点释放认领（REL-RECOVER-02）：`inject` 正常返回＝已持久入箱。
        this.#releaseClaims(send, owner, message);
      }
    } catch (error) {
      log(`completion delivery for ${String(owner)} failed: ${String(error?.message ?? error)}`);
      // 空闲路径整队回滚（单次调用、无部分接受，失败＝整条未接受）。
      this.undoClaim(owner, queue.flatMap((send) => send.items ?? []));
    }
  }

  /**
   * 宿主接受点释放认领（REL-RECOVER-02）：`inject`／`followup` 正常返回＝该
   * 投递已被宿主接受，在途仲裁窗口关闭——`claimedBy` 清除（仅当仍为
   * `'message'`），已交付事实保持不动。完全交付的条目此后仍由事实双向阻断；
   * partial 条目由此进入「续段可再取」状态（collectBatch 的 partial 例外、
   * 让位终局复查与零等待领取在下一次事件恢复中段——完成消息截断交付后的
   * 省略中段不再滞留）。仲裁只在「构造 → 接受/回滚」的在途窗口内保持，与
   * `deliveredFact`（承担已交付阻断、自带 partial 例外）职责分离。
   * @param {{items?: Array<{jobId: string}>}} send - 已被宿主接受的待投递项。
   * @param {unknown} owner - 主体（分账条目解析）。
    * @param {object} [message] - 载体消息（`createUserMessage` 产物，构造期带
    *   稳定 `id`）；`message` 份额以 `message.id` 登记，确认与退回按该身份
    *   匹配（ACCEPT-RECOVERY-MESSAGE-01）。
   */
  #releaseClaims(send, owner, message) {
    for (const item of send.items ?? []) {
      const entry = this.entryFor(item.jobId, owner);
      if (entry !== undefined && entry.claimedBy === 'message') entry.claimedBy = null;
      // 份额登记（§2.6 载体判据表「完成消息」行）：宿主接受点
      //（`inject`／`followup` 正常返回＝已持久入箱）登记——完成消息的装配点在
      // 冲刷前、接受点才是「送达开始」，回滚路径（通道失败）不登记。读取失败
      // 注记项（`deliveredFact` 空）不登记：无正文可恢复。确认判据＝**同 id**
      // 领取事件（onClaimed → #confirmDeliveries 按 `messageId` 匹配）。
      if (entry !== undefined && entry.terminal !== null && entry.deliveredFact !== null) {
        this.#registerRecovery(entry.owner, item.jobId, {
          text: typeof item.text === 'string' ? item.text : '',
          partial: entry.deliveredFact.partial === true,
          terminal: entry.terminal,
          via: 'message',
          ...(message !== undefined && message !== null ? { messageId: message.id } : {})
        }, entry.config);
      }
    }
  }

  /** 公开注册表现读主体 Agent（投递通道）。 */
  #agentFor(owner) {
    for (const entry of this.jobs.values()) {
      if (entry.owner === owner) {
        return entry.ctx.get('agents')?.get(owner) ?? undefined;
      }
    }
    return undefined;
  }

  /**
   * 结算产出就绪事件（无目标等待的唤醒通道，设计 §3.2.5）：结算读取完成后由
   * 本账本经 cordis 事件总线广播（`JOB_RESULT_EVENT`），等待方订阅同一事件名。
   * 事件含义（REL-READ-02 扩展）：「该主体有需要模型注意的结算产出」——正文
   * 就绪或读取失败都是（读取失败时等待出口经 collectBatch 的 readFailed 分支
   * 以状态行＋重试出路携带）；载荷不变（`{ owner }`），消费端不变。
   * @param {unknown} owner - 就绪内容的主体。
   */
  #emitReady(owner) {
    for (const entry of this.jobs.values()) {
      if (entry.owner === owner && entry.ctx !== undefined) {
        try {
          entry.ctx.emit(JOB_RESULT_EVENT, { owner });
          return;
        } catch { /* 事件通道失败不阻塞交付 */ }
      }
    }
  }

  /**
   * 结算读取后的统一入口（成功与**读取失败**都到达，REL-READ-02）：就绪事件 +
   * 无活等待投递。整体加固：`#emitReady` 已有逐条 try/catch；`#deliverIfNoWait`
   * 的调用再包一层（吞错＋log——投递失败留在账本状态里，由下一载体重试），
   * 使本入口自身不抛、返回的 promise 永不拒绝。`readSettled` 外层 catch 的
   * 失败路径调用物理上在 try 之外、无再外层承接，`#beat` 对 `readSettled` 的
   * 浮动 await 同样无承接方——两层都依赖此保证（不产生进程级未处理拒绝），
   * 这正是加固为必需而非冗余的原因。
   */
  async #settleReady(entry) {
    this.#emitReady(entry.owner);
    try {
      await this.#deliverIfNoWait(entry);
    } catch (error) {
      log(`post-settle delivery for ${entry.jobId} failed: ${String(error?.message ?? error)}`);
    }
  }
}

/** 完成消息正文渲染（两语词典；正文自含作业标识与终态）。可裁剪说明行经
 * clampNote 入界（需求 9.3.2 说明总量有界）；留存路径行是定位数据，单列预算、
 * 完整出现或不出现，不经 clampNote（RA-SPILL-LOCATOR，见 entryNoteLines）。
 * 行序（REL-TERMINAL-01）：状态行→回显原文块（ECHO-WORKFLOW-01，附上才有：
 * 类别标签行＋文本，截断标注内嵌）→正文→结局标记行→诊断行（至多 2 行＋省略
 * 计数）→lossy／留存行→原文未附注记行（echoSkipped——预期附上而因批预算未附
 * 的两种形态，入可裁剪说明预算）。必要结局行（状态行、标记行、诊断首行）不入
 * 可裁剪说明的截断序列；可裁剪说明（诊断第二行、lossy 行、未附注记行）在单
 * 条目渲染内受 MAX_NOTES_TOTAL 约束。留存行单列预算（MAX_SPILL_TOTAL）、按
 * 已列游标分批列出（ACCEPT-SPILL-LOCATOR-01：超限给 delivery.spillOverflow
 * 计数行＋点名领取例句，见 entryNoteLines），不入可裁剪说明的截断序列，
 * 正文不受限。 */
function renderCompletionMessage(lang, items) {
  const parts = [];
  for (const item of items) {
    const header = clampNote(t(lang, 'delivery.completionItem', {
      jobId: item.jobId,
      status: item.terminal.status,
      chars: item.chars
    }));
    parts.push(header);
    // 回显原文块（ECHO-WORKFLOW-01 设计 §2.6 回显计量）：状态行之后、正文之前，
    // 类别标签行（`delivery.echoLabel.command`／`.script`）＋文本成块呈现，
    // 正文与结局行序不变。原文已在批预算内扣减（#takeEchoShare），不再过
    // 说明预算；截断标注由文本自带的省略量说明承担。
    if (item.echo !== undefined) {
      parts.push(t(lang, item.echoKind === 'script' ? 'delivery.echoLabel.script' : 'delivery.echoLabel.command'));
      parts.push(item.echo);
    }
    if (item.text !== '') parts.push(item.text);
    // 可裁剪说明预算（单条目渲染内；`used` 随条目重置——pendingSend 的 items
    // 恒单条目，合并 followup 的整条物理消息合计不受该常量控制）。
    let used = 0;
    // 结局标记行（与前台同判据：信号优先、其次非零退出码；成功无标记）。
    const marker = terminalMarker(item.terminal, lang);
    if (marker !== '') parts.push(marker);
    // 诊断行：首行属必要结局（预算压力下不丢、不计入 used）；第二行属可裁剪
    // 说明，与 lossy 行、未附注记行共用剩余预算；被省略行数（含第二行被预算挤掉的
    // 情形）以计数行如实报告——「失败原因始终可见」＝结局事实全量＋诊断首行
    // ＋省略计数。
    const diagLines = terminalDetailLines(item.terminal);
    let diagOmitted = diagLines.length - 1;
    if (diagLines.length > 0) parts.push(clampNote(diagLines[0]));
    if (diagLines.length > 1) {
      const second = clampNote(diagLines[1]);
      if (second.length <= MAX_NOTES_TOTAL - header.length - used) {
        parts.push(second);
        used += second.length;
        diagOmitted -= 1;
      }
    }
    if (diagOmitted > 0) {
      parts.push(t(lang, 'delivery.detailOverflow', { count: diagOmitted }));
    }
    // 注记行（lossy 行、留存行、原文未附行）：经共享构造器
    // entryNoteLines 与批次投影、统一等待出口逐字一致（RA-STATUSLINE-DRIFT）；
    // 宿主已报告的留存位置无论是否丢失都交付（RA-SPILL-PATH）。预算两档
    //（RA-SPILL-LOCATOR）：lossy／未附行与诊断第二行共用单条目
    // MAX_NOTES_TOTAL（状态行与已用部分计入 reserved）；留存行单列
    // MAX_SPILL_TOTAL、不经 clampNote。
    for (const line of entryNoteLines(item, lang, header.length + used)) {
      parts.push(line);
    }
  }
  return parts.join('\n');
}

/**
 * 留存行本批列出条数（RA-SPILL-LOCATOR，设计 §2.6「留存路径的完整领取」）：
 * 自已列游标 `from` 起在 `MAX_SPILL_TOTAL` 预算内尽量多列、**至少列入一条**——
 * 单条超预算的留存行整条列入本批（受控 2102 字符单路径形态由此一次取回，
 * 不出现永不可达）。行长按渲染实文（词典模板＋路径原文）计算，装配与渲染
 * 两处共用本函数，保证计入与列出一致。
 * @param {string[]} paths - 全量留存路径。
 * @param {number} from - 已列游标。
 * @param {string} lang - 语言。
 * @returns {number} 本批列出条数（`from` 已在末尾或无路径时为 0）。
 */
export function spillListCount(paths, from, lang) {
  if (!Array.isArray(paths) || from >= paths.length) return 0;
  let count = 0;
  let used = 0;
  for (let i = from; i < paths.length; i += 1) {
    const line = t(lang, 'delivery.spill', { path: paths[i] }).length;
    if (count > 0 && used + line > MAX_SPILL_TOTAL) break;
    count += 1;
    used += line;
  }
  return count;
}

/**
 * 单条目注记行构造器（RA-STATUSLINE-DRIFT：统一等待出口、让出批次
 * 投影（`projectBatchEntry`）与完成消息渲染三载体共用同一实现——此前等待
 * 投影与批次投影各自拼装，行序与词典键已漂移过；RA-SPILL-PATH：宿主已
 * 报告的输出留存线索（读取回执的 `spillPaths`）无论 `lossy` 真假都交付——
 * 注册表可经合法公开输出源报告留存位置而 lossy 为 false，按丢失筛选会把
 * 唯一找回线索藏掉；行内只转述宿主报告的位置，不声称真实文件在场）。
 * 行序与两态口径：读取失败优先（其条目无正文，注记即重试出路，不再附其他
 * 行）；其次 lossy 行（丢失标记，`delivery.lossy`）；再逐条留存行
 * （`delivery.spill`，超预算时以一行计数汇总回退 `delivery.spillOverflow`，
 * 与 lossy 无留存路径时 `delivery.lossyUnrecoverable` 的两态口径互补）；
 * 最后原文未附行（echoSkipped）。可裁剪说明单行经 clampNote ≤MAX_NOTE_CHARS、
 * 合计受 `MAX_NOTES_TOTAL - reserved` 约束；留存行是定位数据（RA-SPILL-LOCATOR）：
 * 不经 clampNote（完整出现或不出现，不以省略号冒充路径），自已列游标
 * （`item.spillFrom`／`item.spillCount`，未携带时现算）起合计单列
 * `MAX_SPILL_TOTAL` 预算、每次至少列入一条；仍未取尽的余量计入条目留存行
 * 续取队列，计数行（`delivery.spillOverflow`）附点名零等待领取例句，完整
 * 路径另由 `projectBatchEntry` 的 `spill_paths` 字段全量携带（两通道并存）。
 * @param {object} item - `collectBatch` 交付条目（`readFailed?`、`lossy?`、
 *   `spillPaths?`、`spillFrom?`、`spillCount?`、`echoSkipped?`、`jobId`）。
 * @param {string} lang - 语言。
 * @param {number} [reserved] - 该条目已占用的说明预算（完成消息的状态行与
 *   诊断第二行；投影载体传 0）。
 * @returns {string[]} 注记行（可为空数组）。
 */
export function entryNoteLines(item, lang, reserved = 0) {
  if (item.readFailed) {
    return [clampNote(t(lang, 'delivery.readFailed', { jobId: item.jobId }))];
  }
  const lines = [];
  let used = 0;
  const fits = (line) => used + line.length <= MAX_NOTES_TOTAL - reserved;
  // §2.3 正文去向结论行（置位判据见 readSettled／JobRecord.bodyDisposition）：
  // 首选呈现（三载体共用本构造器）；此后行按既有次序续排——该类条目正文为空，
  // lossy／留存／未附行与之天然互斥，行序合流不构成歧义。该行属必要说明
  //（HELD-RECOVER-01）：完整在场、另计内容预算、不入可裁剪说明的截断序列
  //——此前经 200 字符说明裁剪，英文出路文案被截尾。held／unknown 档（隐藏
  // 形态主体）不再指路「换未隐藏原生入口的组合读取」——独立组件实例不共享
  // 持有正文，该出路已被实例级事实否定；*_native 档（原生入口可见的主体）指路
  // 原生 job_output 属合法出口。
  if (item.bodyDisposition === 'arrived'
    || item.bodyDisposition === 'held'
    || item.bodyDisposition === 'held_native'
    || item.bodyDisposition === 'unknown'
    || item.bodyDisposition === 'unknown_native') {
    lines.push(t(lang, `delivery.body_${item.bodyDisposition}`, { jobId: item.jobId }));
  }
  if (item.lossy) {
    const lossyLine = clampNote((item.spillPaths?.length ?? 0) > 0
      ? t(lang, 'delivery.lossy')
      : t(lang, 'delivery.lossyUnrecoverable'));
    if (fits(lossyLine)) {
      lines.push(lossyLine);
      used += lossyLine.length;
    }
  }
  // 留存行按已列游标续列（RA-SPILL-LOCATOR，设计 §2.6）：条目携带装配点
  // 计算的 `spillFrom`／`spillCount`（未携带的调用方现算），本批只列该区间、
  // 至少一条（单条超预算整条列入），仍未取尽时计数行给出点名领取例句——模型
  // 可见正文始终具备完整定位方式，不依赖结构化 `spill_paths` 字段在场。
  const spillPaths = item.spillPaths ?? [];
  const spillFrom = item.spillFrom ?? 0;
  const spillListed = item.spillCount ?? spillListCount(spillPaths, spillFrom, lang);
  for (let i = spillFrom; i < spillFrom + spillListed; i += 1) {
    lines.push(t(lang, 'delivery.spill', { path: spillPaths[i] }));
  }
  if (spillFrom + spillListed < spillPaths.length) {
    lines.push(clampNote(t(lang, 'delivery.spillOverflow', {
      jobId: item.jobId,
      listed: spillListed,
      total: spillPaths.length,
      count: spillPaths.length - (spillFrom + spillListed)
    })));
  }
  if (item.echoSkipped === true) {
    const skipLine = clampNote(t(lang, 'delivery.echoSkipped'));
    if (fits(skipLine)) {
      lines.push(skipLine);
      used += skipLine.length;
    }
  }
  return lines;
}

/** 完成消息 summary（通知摘要行，两语词典键）。 */
function completionSummary(lang, queue) {
  return t(lang, 'delivery.completionSummary', { count: queue.length });
}

/**
 * 终态结局标记行（REL-TERMINAL-01）：与前台 `lib/jobs.js` 的 `exitStatusMarker`
 * 同判据、同词典键——信号在场→信号标记；否则非零退出码→退出码标记；零退出与
 * 无信号→无标记（成功由「无失败标记」表达，不添噪声）。完成消息与等待状态行
 * 共用本函数，两条路径逐字一致。
 * @param {object|null} terminal - 终态事实（`{ status, exitCode?, signal?, detail? }`）。
 * @param {string} lang - 语言。
 * @returns {string} 标记行（没有则空串）。
 */
export function terminalMarker(terminal, lang) {
  if (typeof terminal?.signal === 'string') {
    return t(lang, 'render.killedBySignal', { signal: terminal.signal });
  }
  if (typeof terminal?.exitCode === 'number' && terminal.exitCode !== 0) {
    return t(lang, 'render.exitCode', { code: terminal.exitCode });
  }
  return '';
}

/**
 * 终态诊断行集合（REL-TERMINAL-01）：`entry.terminal.detail` 按换行拆分（空行
 * 不计）。`detail` 是宿主 `jobOutcome` 的诊断文本（终止信号、非零退出码、沙箱
 * 标记、静默失败说明的逐行拼接）；非字符串（未知形态）按无诊断处理。
 * @param {object|null} terminal - 终态事实。
 * @returns {string[]} 诊断行（可为空数组）。
 */
export function terminalDetailLines(terminal) {
  if (typeof terminal?.detail !== 'string') return [];
  return terminal.detail.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * 终态事实的结构化投影（RA-YIELD-FACTS 的一致性基准）：已知才有键——非零
 * `exit_code`（零退出由无标记表达成功）、`signal`、诊断首行 `detail`（多行时
 * 尾接省略计数，「失败原因始终可见」＝结局事实全量＋诊断首行＋省略计数）。
 * 统一等待、命令/编排让出与完成消息三载体共用本投影，同一条目在任何出口的
 * 终态字段逐字一致。
 * @param {object|null} terminal - 终态事实（`{ status, exitCode?, signal?, detail? }`）。
 * @param {string} lang - 语言。
 * @returns {object} 结构化终态字段（可为空对象）。
 */
export function terminalFacts(terminal, lang) {
  if (terminal === null || terminal === undefined) return {};
  const lines = terminalDetailLines(terminal);
  const detail = lines.length === 0 ? '' : clampNote(lines[0])
    + (lines.length > 1 ? ` ${t(lang, 'delivery.detailOverflow', { count: lines.length - 1 })}` : '');
  return {
    ...(typeof terminal.exitCode === 'number' && terminal.exitCode !== 0
      ? { exit_code: terminal.exitCode }
      : {}),
    ...(typeof terminal.signal === 'string' ? { signal: terminal.signal } : {}),
    ...(detail === '' ? {} : { detail })
  };
}

/**
 * 终态批次条目的出口投影（RA-YIELD-FACTS 的一致性基准）：`status_line` ＝状态行＋
 * 结局标记行＋诊断首行（与完成消息同一行序），结构化终态字段随行，读取失败
 * /lossy 注记两态（读取失败优先——其条目无正文，注记即重试出路），正文殿后。
 * 供命令/编排让出出口的 `outputs` 条目使用；统一等待出口的更全投影（运行中
 * 增量、触发目标去重）在其本模块内组合本函数的终态字段。
 * 回显原文（ECHO-WORKFLOW-01 设计 §2.6 回显计量）：附上才有键——`echo`＝原文文本
 * （截断标注内嵌、省略量准确）、`echo_truncated` 仅截断时携带、`echo_kind`
 * ＝'command'/'script'（render 据此取标签行 `delivery.echoLabel.*`）；结构化
 * 判据读 `echo` 字段（＝原文本身），标签行由各 render 组装。未附注记
 * （`echoSkipped`）并入 `note` 行（可与 lossy 注记并存，换行拼接）。
 * RA-STATUSLINE-DRIFT：本函数是**唯一**的状态行／注记投影——统一等待出口
 * （lib/wait.js 的批次装配）改用本函数而非自带副本，两载体（加完成消息的
 * 注记段）由同一实现保证逐字一致；两处各自拼装会漂移（运行中增量
 * 分键、恢复行只在等待副本里）。因此本函数补齐两处仅等待侧需要的形态：
 * - `terminal === null`（运行中增量条目）：状态行换 `delivery.completionItemRunning`
 *   分键、不带标记行／诊断行／终态字段（「settled: running」自相矛盾形态，
 *   设计 §3.2.3）；
 * - `recovery === true`（恢复份额条目）：附 `recovery_line`（恢复头——标记行＋
 *   位置说明行，render 置于状态行后、正文前）；恢复消费限定等待载体
 *   （RECOVERY-YIELD-CARRIER，`collectBatch` 的 `consumeRecovery` 显式选择加入
 *   ——仅 `async_wait` 全部出口传入），让出载体（async_run／async_workflow 的
 *   让出批次）不消费挂起的恢复请求，该键不会出现在让出出口。
 * 注记行经共享构造器 `entryNoteLines`（RA-SPILL-PATH：留存线索不按 lossy
 * 筛选，宿主已报告即交付）。
 * @param {object} item - `collectBatch` 交付条目（`{ jobId, terminal, chars,
 *   truncated, text, lossy?, spillPaths?, readFailed?, echo?, echoTruncated?,
 *   echoKind?, echoSkipped?, recovery?, recoveryHead? }`）。
 * @param {string} lang - 语言。
 * @returns {object} 出口条目。
 */
export function projectBatchEntry(item, lang) {
  const terminal = item.terminal ?? null;
  const diagFirst = terminal === null ? '' : clampNote(terminalDetailLines(terminal)[0] ?? '');
  const markerLine = terminal === null ? '' : terminalMarker(terminal, lang);
  const noteLines = entryNoteLines(item, lang);
  return {
    job_id: item.jobId,
    status_line: [
      clampNote(terminal === null
        ? t(lang, 'delivery.completionItemRunning', { jobId: item.jobId, chars: item.chars })
        : t(lang, 'delivery.completionItem', {
          jobId: item.jobId,
          status: terminal.status,
          chars: item.chars
        })),
      ...(markerLine === '' ? [] : [markerLine]),
      ...(diagFirst === '' ? [] : [diagFirst])
    ].join('\n'),
    ...terminalFacts(terminal, lang),
    ...(item.recovery === true ? { recovery_line: item.recoveryHead } : {}),
    ...(noteLines.length > 0 ? { note: noteLines.join('\n') } : {}),
    // 留存路径全量结构化交付（RA-SPILL-LOCATOR）：完整、不裁剪、可复制——
    // 说明行单列预算装不下的路径也在此字段全量在场。
    ...(Array.isArray(item.spillPaths) && item.spillPaths.length > 0
      ? { spill_paths: [...item.spillPaths] }
      : {}),
    ...(item.echo !== undefined
      ? {
        echo: item.echo,
        echo_kind: item.echoKind,
        ...(item.echoTruncated === true ? { echo_truncated: true } : {})
      }
      : {}),
    text: item.text
  };
}

// ── 模块级单例与测试隔离 ──────────────────────────────────────────────────

/** 交付账本单例（宿主行与工具行共用；同进程多插件实例各自持有）。 */
export const ledger = new DeliveryLedger();

/** 测试隔离：整体重置（不得在产品路径调用）。判读槽（jobOutputHiddenFor，
 * HELD-RECOVER-01）由 lib/index.js 模块装载时登记，此处一并复位——测试须显式
 * 重设才能按隐藏形态主体走通道断言（BD-1／HR 系列），避免跨测试渗透。 */
export function resetDeliveryLedger() {
  ledger.disposeAll();
  ledger.jobs.clear();
  ledger.subjects.clear();
  ledger.jobOutputHiddenFor = null;
  ledger.now = () => Number(process.hrtime.bigint() / 1_000_000n);
}
