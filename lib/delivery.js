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
 *   活等待均已返回提交（并行以最后一个为准）。同一领取窗口内并行发出的多个等待类
 *   调用汇入同一次模型输入、属同一批次，各返回从同一份批次预算分配。同一批次内全部
 *   结果内容共享一份 `maxResultChars`（按 `String.length` 计量），账本按主体维护当前
 *   批剩余预算，逐个交付载体扣减；分配顺序：触发目标优先，其余按就绪时刻先进先出，
 *   同时刻并列按作业 id 字典序；剩余预算为零后到达的**非空**条目整条延后——空正文
 *   条目不受字符预算约束，仍以状态行入批（REL-BATCH-02：字符预算只约束正文，
 *   条目上限对一切条目适用）。单批至多 10 条，满批后到达的条目（含空正文与读取
 *   失败注记）整条延后。完整命令回显（`fullCommandEcho`，ECHO-WORKFLOW-01，
 *   需求 2.2.4/9.3.4）的原文在同一批预算内计量：开批时定值 `echoOn`（同批一致、
 *   关批重取），条目内正文份额优先、原文用剩余份额（6:4 首尾裁剪并标注省略量），
 *   同一作业一次性附上（`echoAttached`，回滚清位后可重投）；预期附上而因预算
 *   未附的条目注记 `delivery.echoSkipped`，正文被裁剪的条目不附也不注记、随
 *   续段在下一批分配。说明分两档：
 *   必要结局行（状态行 ≤200、退出码/信号标记 <60、诊断首行 ≤200）合计单条目
 *   ≤460、单批 ≤4600（条目上限 10 × 460），不入降级序列——退出码、失败原因、
 *   终止事实不因内容预算丢失；可降级说明（诊断第二行、lossy／留存行、延后说明）
 *   单行 ≤200、单条目渲染内合计 ≤2000，超限转一行计数汇总。完成消息路径的
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
 * 恢复副本上限三件（RESULT-RECOVERY-01 §3.4）：副本期限（惰性清扫，无定时器
 * ——恢复请求、确认与下一次装配时点现查现清）；单主体条数上限（FIFO 逐出最旧）；
 * 单主体字符上限（2×maxResultChars，FIFO 逐出，保护本次登记项）。副本过期的
 * 恢复请求按第 3 档交回（如实说明＋终态事实＋留存线索）。
 */
const RECOVERY_TTL_MS = 30 * 60 * 1000;
const RECOVERY_MAX_ITEMS = 10;

/**
 * 说明上限的两档口径（需求 9.3.2「批次还须限制条目数及预算外状态、标识和
 * 诊断说明的总量……由设计给出有限且可测的规则」）：
 * - **可降级说明**：单行至多 200 字符，超长截断（宿主提供的留存路径等外部
 *   字符串长度无界，必须在此入界）；单条目渲染内合计至多 2000——超限保留
 *   状态行、留存行合并为一行计数汇总（正文不受限——只约束说明）。粒度是
 *   **单条目渲染**：`renderCompletionMessage` 的 `used` 随条目重置、pendingSend
 *   的 items 恒单条目；合并 followup 的整条物理消息合计不受本常量控制。
 * - **必要结局行**（REL-TERMINAL-01）：状态行（≤200）＋退出码/信号标记
 *   （<60）＋诊断首行（≤200）合计单条目 ≤460，单批（条目上限 10）合计
 *   ≤4600——不入降级序列，退出码、失败原因、终止事实不因内容预算丢失。
 */
export const MAX_NOTE_CHARS = 200;
export const MAX_NOTES_TOTAL = 2000;

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
     * 当前批：`null`＝无开批；`{ remaining, items }`＝已开批——`remaining` 为该批
     * 剩余字符预算，`items` 为该批已装配条目数（等待返回与完成消息共用，受单批
     * 条目上限约束，设计 §2.6）。开批＝第一个交付载体构造；关批＝领取事件或
     * 全部活等待提交（设计 §2.6）。可选 `echoOn`＝完整命令回显在本批的定值
     * （ECHO-WORKFLOW-01：开批时点现读 `fullCommandEcho` 并**绑定批对象**——
     * 同批全部装配用同值，关批后下一批重取，进行中批次不因设置翻转重算已
     * 构造内容）。可选 `deferredNotes` 字段＝本批延后说明配额
     * 状态（#pushBoundedDeferredNote 惰性初始化；关批随批对象一起丢弃复位）。
     */
    this.batch = null;
    /** @type {Array<{kind:'completion', message: object, jobId: string}>} 待启动投递登记。 */
    this.pendingSends = [];
    /**
     * 恢复副本登记（RESULT-RECOVERY-01 §3.1）：jobId →
     * `{ text, partial, terminal, registeredAt, returned, via?, signal? }`。
     * 已装配进载体、送达未经确认内容的主体级副本——不复用 `JobRecord.buffer`
     *（buffer 是「已消费未交付」，副本是「已装配未确认」，清理时机与读取入口
     * 都不同）。确认／退回判据分载体（§3.2 表）：`via: 'wait'` 由回合收尾事件
     * 确认、`via: 'message'` 由领取事件确认；`returned` 标记的副本（改写取消/
     * 丢弃退回）只经期限或行卸载清理，任何确认信号无效（M1 豁免）。`signal`
     * 是装配调用的 `exec.signal`（回合收尾确认时的中止复检凭据，R3 收窄）。
     * 上限三件与惰性清扫见 `RECOVERY_TTL_MS` 处注释。
     * @type {Map<string, object>}
     */
    this.recoveries = new Map();
    /**
     * 挂起的恢复请求（§3.3 第 1 档的消费标记）：显式零等待点名已证「未确认＋
     * 副本在册」，下一次 `collectBatch`（同一次调用的出口批次）装配标记行＋
     * 副本正文；批满/预算尽整条延后时保持挂起，下一批恢复。单槽——恢复由
     * 单目标显式请求触发，一次一口径。
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
     * 送达确认时刻（RESULT-RECOVERY-01 §3.1）：`null`＝未确认；确认信号到达
     * 时置位（等待载体＝回合收尾事件、完成消息载体＝领取事件，见 SubjectRecord
     * .recoveries 的分载体判据）。确认后同名作业的显式零等待按第 2 档交回
     *（现行口径：状态行＋已交付说明，不重发正文）；未确认且副本在册的按
     * 第 1 档恢复（标记行＋副本正文）。
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
   * 开批（六处开批点共用，设计 §2.6）：预算初始化＋回显定值一并完成。
   * `echoOn` 在开批时点现读 `config.fullCommandEcho`（活视图）并绑定批对象
   * （ECHO-WORKFLOW-01 设计 §5「后续调用生效、进行中批次不变更」）——同批
   * 全部装配用同值；关批丢弃批对象，下一批重取。
   */
  #newBatch(config) {
    return {
      remaining: Math.max(1, Number(config?.maxResultChars ?? 4096)),
      items: 0,
      echoOn: config?.fullCommandEcho === true
    };
  }

  // ── 装配（工具行 apply 调用一次）────────────────────────────────────────

  /**
   * 挂 `agent/inbox/claimed`／`agent/inbox/discarded`／`agent/turn-stopping`
   * 监听（关批锚点＋送达确认，设计 §2.6／RESULT-RECOVERY-01 §3.2）：
   *
   * - `claimed`：主体的领取点关闭当前批（既有行为），并确认完成消息载体的
   *   恢复副本（领取＝正文已作为 user/message 进入模型上下文）。
   * - `discarded`：取消待处理输入＝完成消息载体退回——副本置 `returned`
   *   标记、保持未确认（可恢复，M1 豁免），不清批（无领取发生）。
   * - `turn-stopping`：回合收尾（本 turn 全部 tool/result 已持久提交之后发出）
   *   确认等待载体的恢复副本；监听时点复检副本的 `signal`（装配调用的
   *   `exec.signal`）——中止即按退回处理（R3 收窄：改写取消的正文从未进入
   *   模型上下文，按确认列字面处理会清掉唯一副本）。
   *
   * cordis 事件沿祖先链可达——预设行 ctx 能收到其下会话 agent 的事件
   * （宿主先例：`dsh-tool-jobs` 的 wakeup 预算、`dsh-user-questions` 的待答清理）。
   * 三个事件 rc.2／rc.5 均在（设计 §3.2 已核对）；rc.3／rc.4 由实现轮静态核对，
   * 缺席某事件时该确认信号降级为仅依赖另一信号＋期限（§7 第 3 条）。
   * 返回 dispose，由行卸载处置。
   */
  attachClaimedListener(ctx) {
    if (this.claimedDisposers.has(ctx)) return () => {};
    const closeBatch = ({ agent }) => {
      const owner = agent?.id;
      if (owner === undefined) return;
      const subject = this.subjects.get(owner);
      if (subject === undefined) return;
      // 领取点只关批（下一批恢复全额预算）。**不清 pendingSends**：待投递项的
      // 正文已从缓冲清出、凭据在项上，由下一次 flush 消费——清空即丢内容
      //（push 与 flush 之间的微任务窗口内正是 claimed 可能到达的时刻）。
      subject.batch = null;
    };
    const onClaimed = (payload) => {
      closeBatch(payload);
      this.#confirmDeliveries(payload?.agent?.id, 'message');
    };
    const onDiscarded = ({ agent }) => {
      const owner = agent?.id;
      if (owner === undefined) return;
      const subject = this.subjects.get(owner);
      if (subject === undefined) return;
      this.#sweepRecoveries(subject);
      for (const copy of subject.recoveries.values()) {
        // 退回判据（§3.2 表）：取消待处理输入＝完成消息副本退回，置 returned
        //（M1：此后任何确认信号对其无效，只经期限或行卸载清理——正文可恢复）。
        if (copy.via === 'message') copy.returned = true;
      }
    };
    const onTurnStopping = ({ agent }) => {
      const owner = agent?.id;
      if (owner === undefined) return;
      const subject = this.subjects.get(owner);
      if (subject === undefined) return;
      this.#sweepRecoveries(subject);
      for (const [jobId, copy] of [...subject.recoveries.entries()]) {
        // 等待载体判据按判据表第一行统一：等待返回与首次等待直付同列
        //（RESULT-RECOVERY-01 §3.2）——回合收尾确认，两者一体适用。
        if ((copy.via !== 'wait' && copy.via !== 'firstwait') || copy.returned === true) continue;
        // R3 收窄：监听时点复检装配调用的中止信号——命中按退回处理，不确认。
        if (copy.signal?.aborted === true) {
          copy.returned = true;
          continue;
        }
        const entry = this.jobs.get(jobId);
        if (entry !== undefined) entry.confirmedAt = this.now();
        subject.recoveries.delete(jobId);
      }
    };
    const disposeAll3 = [];
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
    disposeAll3.push(claimed);
    disposeAll3.push(attach('agent/inbox/discarded', onDiscarded));
    disposeAll3.push(attach('agent/turn-stopping', onTurnStopping));
    const dispose = () => {
      for (const { dispose: one } of disposeAll3) {
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
   * 送达确认（RESULT-RECOVERY-01 §3.2）：按载体判据把未退回副本转为已确认
   * （条目置 `confirmedAt`、清副本）。`returned` 标记的副本跳过（M1 豁免——
   * 退回的正文从未进入模型上下文，清掉即丢唯一副本）。惰性清扫期限先于一切。
   * @param {unknown} owner - 主体（事件载荷的 agent id）。
   * @param {'wait'|'message'} via - 本次确认信号覆盖的载体（等待载体的
   *   `'firstwait'` 副本不经 `#confirmDeliveries`——回合收尾监听内联处理）。
   */
  #confirmDeliveries(owner, via) {
    if (owner === undefined || owner === null) return;
    const subject = this.subjects.get(owner);
    if (subject === undefined) return;
    this.#sweepRecoveries(subject);
    for (const [jobId, copy] of [...subject.recoveries.entries()]) {
      if (copy.via !== via || copy.returned === true) continue;
      const entry = this.jobs.get(jobId);
      if (entry !== undefined) entry.confirmedAt = this.now();
      subject.recoveries.delete(jobId);
    }
  }

  /**
   * 恢复副本的惰性期限清扫（§3.4：无定时器——恢复请求、确认与下一次装配
   * 时点现查现清）。
   */
  #sweepRecoveries(subject) {
    if (subject.recoveries.size === 0) return;
    const now = this.now();
    for (const [jobId, copy] of [...subject.recoveries.entries()]) {
      if (now - copy.registeredAt > RECOVERY_TTL_MS) subject.recoveries.delete(jobId);
    }
  }

  /**
   * 恢复副本登记（§3.3 装配点／接受点共用）：单主体单作业单槽——新装配覆盖
   * 既有未标记副本（最新份额是当前未确认内容）；**R2 覆盖守卫**：`returned`
   * 标记的副本（改写取消/丢弃退回的恢复锚点）不被未标记的新装配覆盖，未标记
   * 的既有副本可被覆盖。条数与字符上限随登记实施（FIFO 逐出最旧，保护本次
   * 登记项）。
   * @param {unknown} owner - 主体。
   * @param {string} jobId - 作业标识。
   * @param {{text: string, partial?: boolean, terminal: object,
   *   via: 'wait'|'message'|'firstwait', signal?: object}} fields - 装配份额与
   *   载体信息（`signal`＝装配调用（工具 exec）的取消信号——登记时现查一次
   *   中止即按退回置位（出口时点检查），回合收尾确认时复检（监听复检），
   *   两层合成 §3.2 的退回判据）。
   * @param {object} [config] - 生效配置视图（maxResultChars；字符上限＝2×）。
   */
  #registerRecovery(owner, jobId, fields, config) {
    const subject = this.#subject(owner);
    this.#sweepRecoveries(subject);
    const existing = subject.recoveries.get(jobId);
    if (existing !== undefined && existing.returned === true) return;
    // 出口时点检查（§3.2 退回列的第一层）：登记时信号已中止＝装配发生在
    // 改写取消窗口内，副本直接带 `returned` 落册（监听复检是第二层）。
    const returnedNow = fields.signal?.aborted === true;
    subject.recoveries.set(jobId, {
      text: typeof fields.text === 'string' ? fields.text : '',
      partial: fields.partial === true,
      terminal: fields.terminal ?? null,
      registeredAt: this.now(),
      returned: returnedNow,
      via: fields.via,
      ...(fields.signal !== undefined && fields.signal !== null ? { signal: fields.signal } : {})
    });
    // 条数上限：FIFO 逐出最旧（保护本次登记项）。
    while (subject.recoveries.size > RECOVERY_MAX_ITEMS) {
      const oldest = [...subject.recoveries.entries()]
        .filter(([id]) => id !== jobId)
        .sort((a, b) => a[1].registeredAt - b[1].registeredAt)[0];
      if (oldest === undefined) break;
      subject.recoveries.delete(oldest[0]);
    }
    // 字符上限（2×maxResultChars）：同样 FIFO 逐出最旧（保护本次登记项）。
    const cap = 2 * Math.max(1, Number(config?.maxResultChars ?? 4096));
    let total = 0;
    for (const copy of subject.recoveries.values()) total += copy.text.length;
    while (total > cap && subject.recoveries.size > 1) {
      const oldest = [...subject.recoveries.entries()]
        .filter(([id]) => id !== jobId)
        .sort((a, b) => a[1].registeredAt - b[1].registeredAt)[0];
      if (oldest === undefined) break;
      total -= oldest[1].text.length;
      subject.recoveries.delete(oldest[0]);
    }
  }

  /**
   * 恢复出口的分档裁决（§3.3；仅显式作业目标的零等待调用，`lib/wait.js`
   * 入口终态分支）：
   * - `null`：未交付过（`deliveredFact` 空）或不属本主体——正常路径承担，
   *   无恢复语义；
   * - 第 1 档 `{tier: 1}`：未确认（`confirmedAt` 空）且副本在册未过期——挂起
   *   消费标记，本次出口的 `collectBatch` 装配「标记行＋副本正文」（同一分配
   *   原语、计入当批预算，不按恢复次数放大）；
   * - 第 2 档 `{tier: 2}`：已确认——现行口径（状态行＋已交付说明）；
   * - 第 3 档 `{tier: 3, terminal, spillPaths}`：未确认但副本缺席/过期——如实
   *   说明＋终态事实＋留存线索（如有），不伪造正文。
   * @returns {null|{tier: 1}|{tier: 2}|{tier: 3, terminal: object, spillPaths: string[]}}
   */
  stageRecovery(jobId, owner) {
    const subject = this.subjects.get(owner);
    const entry = this.jobs.get(jobId);
    if (subject === undefined || entry === undefined || entry.owner !== owner) return null;
    this.#sweepRecoveries(subject);
    if (entry.confirmedAt !== null) return { tier: 2 };
    if (entry.deliveredFact === null) return null;
    const copy = subject.recoveries.get(jobId);
    if (copy === undefined) {
      return { tier: 3, terminal: entry.terminal, spillPaths: [...entry.spillPaths] };
    }
    subject.stagedRecovery = { jobId };
    return { tier: 1 };
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
    if (typeof options.echoText === 'string' && options.echoText !== '') {
      entry.echoText = options.echoText;
      entry.echoKind = options.echoKind === 'script' ? 'script' : 'command';
    }
    this.jobs.set(jobId, entry);
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
    this.#beat(jobId, 0);
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
   *   partial 交付处理——中段进缓冲，续段可再交付（9.3.2 裁剪恢复）；`options.paidText`（本次直付文本）在场时按 §3.2 判据表第一行登记恢复副本（RESULT-RECOVERY-01：首等直付与等待返回同列载体——确认走回合收尾、退回走出口中止，副本经显式零等待恢复），`options.signal`＝首次等待调用方的 exec.signal 供退回判据两层检查；
   * - `outcome = 'detached'`——作业被撤销（如行卸载），整体回收。
   */
  async noteFirstWaitEnded(jobId, outcome, terminal, deliveredChars, options = {}) {
    const entry = this.jobs.get(jobId);
    if (entry === undefined) return;
    if (outcome === 'still-running') return;
    if (outcome === 'settled') {
      this.#disarmChainPreregistration(entry);
      await this.readSettled(jobId);
      return;
    }
    if (outcome === 'delivered') {
      this.#disarmChainPreregistration(entry);
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
      // 恢复副本登记（RESULT-RECOVERY-01 §3.2 判据表第一行——首等直付与等待
      // 返回同一载体行，IMPL-M1 返修）：text＝调用方传入的本次直付文本（正文
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
   * @param {unknown} owner - 主体。
   * @param {object} config - 生效配置视图（maxResultChars）。
   * @returns {number} 本次直付可用字符上限（已从批剩余中扣除）。
   */
  openFirstWaitShare(owner, config) {
    const subject = this.#subject(owner);
    const full = Math.max(1, Number(config?.maxResultChars ?? 4096));
    if (subject.batch === null) subject.batch = this.#newBatch(config);
    const share = Math.max(0, Math.min(subject.batch.remaining, full));
    subject.batch.remaining -= share;
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
    if (subject.batch === null) subject.batch = this.#newBatch(config);
    subject.batch.remaining = Math.min(full, subject.batch.remaining + refund);
  }

  /** 交付份额计费（无预留形态时的备用计费路径）：开批（若未开）并扣减直付字符数（下限 0）。 */
  chargeDelivery(owner, config, chars) {
    if (!Number.isFinite(chars) || chars <= 0) return;
    const subject = this.#subject(owner);
    if (subject.batch === null) {
      subject.batch = this.#newBatch(config);
    }
    subject.batch.remaining = Math.max(0, subject.batch.remaining - Math.ceil(chars));
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
  async #beat(jobId, ordinal) {
    const entry = this.jobs.get(jobId);
    if (entry === undefined || entry.chain === null || entry.chain.disposed) return;
    const chain = entry.chain;
    // 本窗口的预注册 timer：窗口过半时启动下一窗口（其 waiter 立即在册——相邻窗口交叠）。
    let preregistered = false;
    const half = setTimeout(() => {
      preregistered = true;
      this.#beat(jobId, ordinal + 1);
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
      // 已交付（首次等待直付）不再读——读取只会填一段无人消费的缓冲
      //（deliveredFact 阻断一切再交付，见 noteFirstWaitEnded 'delivered'）。
      if (entry.deliveredFact === null) await this.readSettled(jobId, view);
      return;
    }
    // 非终态到期（或异常形状）：本窗口结束；下一窗口已过半预注册（在册交叠），未预注册则现在补。
    clearTimeout(half);
    if (!preregistered) this.#beat(jobId, ordinal + 1);
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

  /** 作业整体回收（行卸载 / 作业终局）。撤销链并放弃账面。 */
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
      droppedJobIds.push([jobId, entry.owner]);
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
        if (subject.stagedRecovery?.jobId === jobId) subject.stagedRecovery = null;
      }
      let ownerHasJobs = false;
      for (const entry of this.jobs.values()) {
        if (entry.owner === owner) { ownerHasJobs = true; break; }
      }
      if (ownerHasJobs) continue;
      if (subject.activeWaits.size > 0) continue;
      if (subject.pendingSends.length > 0) continue;
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
  async readSettled(jobId, terminal) {
    const entry = this.jobs.get(jobId);
    if (entry === undefined) return null;
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
            entry.buffer += chunksTextOf(read, entry.config?.workflowProgressLog === true);
            if (read.lossy === true) entry.lossy = true;
            const spill = spillPathsOf(read);
            if (spill.length > 0) entry.spillPaths = [...entry.spillPaths, ...spill];
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
  async readIncremental(jobId) {
    const entry = this.jobs.get(jobId);
    if (entry === undefined) return null;
    let delta = '';
    try {
      const read = await entry.ctx.jobs.read(jobId, entry.owner);
      if (read !== undefined && read !== null) {
        // 同 readSettled：进度日志按展示开关筛选（设计 2.4）。
        delta = chunksTextOf(read, entry.config?.workflowProgressLog === true);
        if (read.lossy === true) entry.lossy = true;
        const spill = spillPathsOf(read);
        if (spill.length > 0) entry.spillPaths = [...entry.spillPaths, ...spill];
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
   * 活等待注销与让位终局复查（设计 §2.6）：该主体已无本包活等待且存在就绪未交付内容时，
   * 补开完成消息交付，不等待模型主动领取——不存在「结算时让位、随后无等待却无任何
   * 交付载体」的终局。
   */
  async releaseWait(token, owner) {
    const subject = this.subjects.get(owner);
    if (subject === undefined) return;
    subject.activeWaits.delete(token);
    if (subject.activeWaits.size > 0) return;
    // 让位终局复查投**全部**就绪未认领条目（只投 Map 迭代序第一个会
    // 让其余就绪正文失去被动交付载体——已终态、保活链已结束、无新事件，只剩
    // 模型主动领取一条路，违反 9.3.2「不要求专门再调用一次工具领取」）。空正文
    // 终态条目也投（与批次路径「无输出完成的作业以状态行可见」对称
    // ——保活链抑制了宿主通知，让位复查是它唯一的被动可见载体）。逐条构造
    // （deferFlush）后单次冲刷：同一领取窗口内多条合并一次通道投递（设计 §2.6）。
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
   * @param {{triggerJobIds?: string[], lang?: string, includeRunning?: boolean}} [options]
   * @returns {{delivered: Array<{jobId, terminal, text, truncated, lossy, spillPaths, chars}>,
   *   deferred: string[], deferredNote: string}}
   */
  collectBatch(owner, options = {}) {
    const subject = this.#subject(owner);
    const trigger = new Set(options.triggerJobIds ?? []);
    const includeRunning = options.includeRunning === true;
    // 恢复装配（RESULT-RECOVERY-01 §3.3 第 1 档）：挂起的恢复请求在候选分配
    // 之前消费——恢复条目即本次出口的触发目标，优先取份额。标记行＋副本正文
    // 走同一分配原语（首尾保留裁剪、计入条目数与字符预算，不按恢复次数放大）；
    // 批满/预算尽整条延后（保持挂起，下一批恢复）。不置认领与已交付事实
    //（恢复交付不重置 deliveredFact——原交付的既有语义保持）；副本本体不因
    // 装配裁剪或消费清出（期限/确认/行卸载才清），再次恢复仍取全量副本。
    let recoveryItem = null;
    let recoveryDeferred = false;
    if (subject.stagedRecovery !== null) {
      const stagedJobId = subject.stagedRecovery.jobId;
      const stagedEntry = this.jobs.get(stagedJobId);
      const stagedCopy = subject.recoveries.get(stagedJobId);
      if (stagedEntry === undefined || stagedCopy === undefined || stagedEntry.owner !== owner) {
        subject.stagedRecovery = null; // 行卸载/过期：请求作废
      } else {
        if (subject.batch === null) subject.batch = this.#newBatch(stagedEntry.config);
        const lang = stagedEntry.config.agentLang ?? 'en';
        const body = `${t(lang, 'delivery.recoveryMarker', { jobId: stagedJobId })}\n${stagedCopy.text}`;
        if (subject.batch.items >= MAX_BATCH_ITEMS
          || (subject.batch.remaining <= 0 && body !== '')) {
          // 整条延后：保持挂起（stagedRecovery 不清），随 deferred 清单可见。
          recoveryDeferred = true;
        } else {
          const cut = this.#takeShare(
            { ...stagedEntry, buffer: body, lossy: false, spillPaths: [], echoText: '', echoAttached: true },
            subject.batch
          );
          subject.batch.items += 1;
          recoveryItem = {
            jobId: stagedJobId,
            terminal: stagedCopy.terminal,
            text: cut.text,
            truncated: cut.truncated,
            lossy: false,
            spillPaths: [],
            chars: cut.text.length,
            recovery: true
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
      subject.batch = this.#newBatch(firstConfig);
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
      const item = this.#takeShare(entry, subject.batch);
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
        // 副本登记（RESULT-RECOVERY-01 §3.2 表「等待返回」载体行）：装配即登记
        //（载体构造无异常＝认领点）；`signal`＝本次等待调用的 exec.signal
        //（回合收尾确认的中止复检凭据）。确认判据在事件监听（见
        // attachClaimedListener 的 onTurnStopping）。partial＋续段两档都交、
        // 不合并（§3.3）：副本记**本次装配份额**，续段由后续载体另行登记。
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
      }
    }
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
   * 回显原文（ECHO-WORKFLOW-01 设计 §4.1）：正文份额之后经 `#takeEchoShare`
   * 接续分配——仅条目未截断时；截断条目的原文随省略中段在下一批重新分配。
   * @param {object} entry - 作业账面条目（读取 `buffer`／`terminal`／`lossy`／`spillPaths`）。
   * @param {{remaining: number, echoOn?: boolean}} budget - 批预算（就地扣减）。
   * @returns {{jobId, terminal, text, truncated, remainder, lossy, spillPaths, chars,
   *   echo?, echoTruncated?, echoKind?, echoAttached?, echoSkipped?}}
   */
  #takeShare(entry, budget) {
    const want = entry.buffer.length;
    const take = Math.min(want, budget.remaining);
    let cut;
    if (take >= want) {
      cut = { text: entry.buffer, truncated: false };
    } else {
      cut = truncate(entry.buffer, take, entry.config.agentLang ?? 'en');
      cut.remainder = omittedMiddle(entry.buffer, take);
    }
    budget.remaining -= take;
    // 回显原文分配（ECHO-WORKFLOW-01 设计 §4.1「正文优先、原文用剩余份额」）：
    // 正文被裁剪的条目本批不附原文（省略中段在缓冲待续，原文随续段在下一批
    // 分配，不注记）；未截断（含空正文）条目在此一次性附上或注记未附。
    const echoFields = cut.truncated ? null : this.#takeEchoShare(entry, budget);
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
      chars: cut.text.length,
      ...(echoFields ?? {})
    };
  }

  /**
   * 回显原文的批次分配（ECHO-WORKFLOW-01 设计 §4.1/§4.2）：在正文份额之后
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
   * 本批不附也不注记，随续段在下一批重新分配（设计 §4.1 推论）。
   * @param {object} entry - 作业账面条目。
   * @param {{remaining: number, echoOn?: boolean}} budget - 批预算（就地扣减）。
   * @returns {{echo: string, echoTruncated: boolean, echoKind: string,
   *   echoAttached: true} | {echoSkipped: true} | null} 装配字段（展开进条目
   *   与回滚凭据；null＝本条目无原文动作）。
   */
  #takeEchoShare(entry, budget) {
    if (budget.echoOn !== true || entry.echoText === '' || entry.echoAttached) return null;
    const full = entry.echoText;
    const remaining = budget.remaining;
    if (remaining <= 0) return { echoSkipped: true };
    if (full.length <= remaining) {
      budget.remaining -= full.length;
      entry.echoAttached = true;
      return { echo: full, echoTruncated: false, echoKind: entry.echoKind, echoAttached: true };
    }
    const head = Math.floor(remaining * 0.6);
    const tail = remaining - head;
    const omitted = full.length - remaining;
    budget.remaining -= remaining;
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
      // 恢复条目不参与回滚（RESULT-RECOVERY-01 §3.3 第 1 档）：恢复交付不置
      // 认领、不清缓冲、不重置已交付事实——回滚链对它没有任何可还原状态；
      // 若误走 `original` 回写，会把「标记行＋副本正文」当成作业正文写回
      // buffer 并清 deliveredFact，后续批次再投一次标记行（minor ①）。
      if (item.recovery === true) continue;
      const entry = this.jobs.get(item.jobId);
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
      // 回显一次性状态随凭据标记清位（ECHO-WORKFLOW-01 设计 §6.4）：装配过
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
   * 调用点：每笔等待返回提交后；无活等待即关闭当前批（下一批恢复全额预算）。
   */
  closeBatchIfIdle(owner) {
    const subject = this.subjects.get(owner);
    if (subject === undefined) return;
    if (subject.activeWaits.size === 0) subject.batch = null;
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
    if (subject.activeWaits.size > 0) return;
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
        subject.batch = this.#newBatch(entry.config);
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
      subject.batch = this.#newBatch(entry.config);
    }
    // 批预算耗尽或条目数到上限（并行领取窗口内其他载体已扣完/投满，设计 §2.6
    // 「剩余批次预算为零后到达的条目整条延后」与「单批至多 10 条」——批次对象
    // 统一计数，完成消息不绕过条目额度）：条目上限对**一切**条目独立生效
    // （REL-BATCH-02——空正文条目的条目计数此前被「正文非空」前提架空，同窗口
    // 12 个空输出作业会发出 12 条完成消息；状态行、标识与诊断同样占模型输入）；
    // 字符预算只约束非空正文（空正文零扣减，预算耗尽仍按状态行交付——不得因
    // 修正把空条目也按预算延后）。与 collectBatch 同语义——不认领、不清缓冲、
    // 不置已交付事实，投有界延后说明（#pushBoundedDeferredNote：逐条＋聚合受
    // 批级配额与同批去重约束，经 clampNote 入界——jobId 是宿主不透明字符串，
    // 领取出路照抄）；正文由下一批（关批后恢复全额预算）或 `async_wait(wait_ms=0)`
    // 完整交付。旧形态（take=0 仍投截断标注的空壳并清缓冲）会把正文永久丢失
    // （9.3.2 防丢失红线）。
    if (subject.batch.items >= MAX_BATCH_ITEMS
      || (subject.batch.remaining <= 0 && entry.buffer !== '')) {
      await this.#pushBoundedDeferredNote(subject, entry, lang, options);
      return;
    }
    entry.claimedBy = 'message';
    const items = [];
    if (entry.buffer !== '') items.push(this.#takeShare(entry, subject.batch));
    subject.batch.items += 1;
    // 空正文终态条目与有正文条目共用同一渲染管线（合成零字符条目）——状态行、
    // 结局标记行、诊断行、lossy／留存行的行序与预算两档口径完全一致；单独的
    // 单行捷径会漏掉终态细节（REL-TERMINAL-01：无输出完成的 killed 作业同样
    // 要让信号与诊断可见）。回显原文在合成条目上同样分配（ECHO-WORKFLOW-01
    // 设计 §6.3：#takeShare 只覆盖有正文条目，空正文条目的原文分配点在此补齐
    // ——与正文条目同判同形态）。
    const echoFields = items.length > 0 ? null : this.#takeEchoShare(entry, subject.batch);
    const renderItems = items.length > 0 ? items : [{
      jobId: entry.jobId,
      terminal: entry.terminal,
      text: '',
      truncated: false,
      lossy: entry.lossy,
      spillPaths: entry.spillPaths,
      chars: 0,
      ...(echoFields ?? {})
    }];
    subject.pendingSends.push({
      kind: 'completion',
      jobId: entry.jobId,
      lang,
      // 回滚凭据（flush 通道失败时经 undoClaim 退回，正文与结局不因通道故障
      // 丢失）：有正文条目为 `#takeShare` 产物的四字段——original＝装配前原文
      // （截断条目按原文回滚，中段不得丢失）、remainder＝省略中段（装配后经
      // readIncremental 追加的增量在回滚时按前缀判 tail 保留；完成消息路径
      // 此前丢弃该字段，曾使追加增量在回滚时丢失）；空正文条目
      // `{ jobId, text: '' }` 不带 original（走保缓冲分支，见 undoClaim 注释）
      // ——空输出作业的结局同样不得在通道失败后被误记已交付（REL-SEND-02）。
      // `echoAttached` 标记随凭据携带（ECHO-WORKFLOW-01 设计 §6.4）：装配过
      // 原文的条目回滚时清一次性状态、下一载体可重附；读取失败注记的凭据
      // （上方 readFailed 分支）不带标记——其条目不附原文。
      items: items.length > 0
        ? items.map((item) => ({
          jobId: item.jobId,
          text: item.text,
          original: item.original,
          remainder: item.remainder,
          ...(item.echoAttached === true ? { echoAttached: true } : {})
        }))
        : [{
          jobId: entry.jobId,
          text: '',
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
   * 对象自然复位——六处开批点无须逐点补字段。
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
   * 成功侧在宿主接受点释放认领（`#releaseClaims`，REL-RECOVER-02）。
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
        // 已被宿主接受——在途仲裁窗口关闭，partial 条目的续段自此可再取。
        for (const send of queue) this.#releaseClaims(send);
        return;
      }
      for (let k = 0; k < queue.length; k += 1) {
        const send = queue[k];
        try {
          agent.inject(createUserMessage({
            content: [{ type: 'text', text: send.render() }],
            source: { kind: JOB_RESULT_SOURCE, form: 'notice', summary: completionSummary(lang, [send]) }
          }));
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
        this.#releaseClaims(send);
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
   */
  #releaseClaims(send) {
    for (const item of send.items ?? []) {
      const entry = this.jobs.get(item.jobId);
      if (entry !== undefined && entry.claimedBy === 'message') entry.claimedBy = null;
      // 副本登记（RESULT-RECOVERY-01 §3.2 表「完成消息」载体行）：宿主接受点
      //（`inject`／`followup` 正常返回＝已持久入箱）登记——完成消息的装配点在
      // 冲刷前、接受点才是「送达开始」，回滚路径（通道失败）不登记。读取失败
      // 注记项（`deliveredFact` 空）不登记：无正文可恢复。确认判据＝领取事件
      //（onClaimed → #confirmDeliveries）。
      if (entry !== undefined && entry.terminal !== null && entry.deliveredFact !== null) {
        this.#registerRecovery(entry.owner, item.jobId, {
          text: typeof item.text === 'string' ? item.text : '',
          partial: entry.deliveredFact.partial === true,
          terminal: entry.terminal,
          via: 'message'
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

/** 完成消息正文渲染（两语词典；正文自含作业标识与终态）。说明行经 clampNote
 * 入界（需求 9.3.2 说明总量有界——留存路径等宿主字符串长度无界，在此截断）。
 * 行序（REL-TERMINAL-01）：状态行→回显原文块（ECHO-WORKFLOW-01，附上才有：
 * 类别标签行＋文本，截断标注内嵌）→正文→结局标记行→诊断行（至多 2 行＋省略
 * 计数）→lossy／留存行→原文未附注记行（echoSkipped——预期附上而因批预算未附
 * 的两种形态，入可降级说明预算）。必要结局行（状态行、标记行、诊断首行）不入
 * 降级序列；可降级说明（诊断第二行、lossy／留存行、未附注记行）在单条目渲染
 * 内受 MAX_NOTES_TOTAL 约束——超限保留状态行、留存行合并为一行计数汇总（超限
 * 汇总回退，正文不受限）。 */
function renderCompletionMessage(lang, items) {
  const parts = [];
  for (const item of items) {
    const header = clampNote(t(lang, 'delivery.completionItem', {
      jobId: item.jobId,
      status: item.terminal.status,
      chars: item.chars
    }));
    parts.push(header);
    // 回显原文块（ECHO-WORKFLOW-01 设计 §2.1/§4.3）：状态行之后、正文之前，
    // 类别标签行（`delivery.echoLabel.command`／`.script`）＋文本成块呈现，
    // 正文与结局行序不变。原文已在批预算内扣减（#takeEchoShare），不再过
    // 说明预算；截断标注由文本自带的省略量说明承担。
    if (item.echo !== undefined) {
      parts.push(t(lang, item.echoKind === 'script' ? 'delivery.echoLabel.script' : 'delivery.echoLabel.command'));
      parts.push(item.echo);
    }
    if (item.text !== '') parts.push(item.text);
    // 可降级说明预算（单条目渲染内；`used` 随条目重置——pendingSend 的 items
    // 恒单条目，合并 followup 的整条物理消息合计不受该常量控制）。
    let used = 0;
    // 结局标记行（与前台同判据：信号优先、其次非零退出码；成功无标记）。
    const marker = terminalMarker(item.terminal, lang);
    if (marker !== '') parts.push(marker);
    // 诊断行：首行属必要结局（预算压力下不丢、不计入 used）；第二行属可降级
    // 说明，与 lossy／留存行共用剩余预算；被省略行数（含第二行被预算挤掉的
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
    // lossy 找回说明（需求 9.3.2）：有落盘副本→位置；无副本→如实说明该部分
    // 无法找回。与 spill 行共用同一条说明预算（MAX_NOTES_TOTAL）。
    if (item.lossy) {
      const lossyLine = clampNote((item.spillPaths?.length ?? 0) > 0
        ? t(lang, 'delivery.lossyAtPaths', { paths: item.spillPaths.join(', ') })
        : t(lang, 'delivery.lossyUnrecoverable'));
      if (used + lossyLine.length <= MAX_NOTES_TOTAL - header.length) {
        parts.push(lossyLine);
        used += lossyLine.length;
      }
    }
    const spills = (item.spillPaths ?? [])
      .map((spill) => clampNote(t(lang, 'delivery.spill', { path: spill })));
    let listed = 0;
    for (const line of spills) {
      if (used + line.length > MAX_NOTES_TOTAL - header.length) break;
      parts.push(line);
      used += line.length;
      listed += 1;
    }
    if (listed < spills.length) {
      parts.push(t(lang, 'delivery.spillOverflow', { count: spills.length - listed }));
    }
    // 原文未附注记（ECHO-WORKFLOW-01 定案 M3）：预期附上而因批预算未附（空
    // 正文条目进入分配时剩余为零、非空正文恰好整份耗尽剩余两种形态）时如实
    // 注明，入可降级说明预算（与 lossy／留存行共用 MAX_NOTES_TOTAL）。
    if (item.echoSkipped === true) {
      const skipLine = clampNote(t(lang, 'delivery.echoSkipped'));
      if (used + skipLine.length <= MAX_NOTES_TOTAL - header.length) {
        parts.push(skipLine);
        used += skipLine.length;
      }
    }
  }
  return parts.join('\n');
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
 * 终态事实的结构化投影（RA-YIELD-FACTS 对齐基准）：已知才有键——非零
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
 * 终态批次条目的出口投影（RA-YIELD-FACTS 对齐基准）：`status_line` ＝状态行＋
 * 结局标记行＋诊断首行（与完成消息同一行序），结构化终态字段随行，读取失败
 * /lossy 注记两态（读取失败优先——其条目无正文，注记即重试出路），正文殿后。
 * 供命令/编排让出出口的 `outputs` 条目使用；统一等待出口的更全投影（运行中
 * 增量、触发目标去重）在其本模块内组合本函数的终态字段。
 * 回显原文（ECHO-WORKFLOW-01 设计 §4.3）：附上才有键——`echo`＝原文文本
 * （截断标注内嵌、省略量准确）、`echo_truncated` 仅截断时携带、`echo_kind`
 * ＝'command'/'script'（render 据此取标签行 `delivery.echoLabel.*`）；结构化
 * 判据读 `echo` 字段（＝原文本身），标签行由各 render 组装。未附注记
 * （`echoSkipped`）并入 `note` 行（可与 lossy 注记并存，换行拼接）。
 * @param {object} item - `collectBatch` 交付条目（`{ jobId, terminal, chars,
 *   truncated, text, lossy?, spillPaths?, readFailed?, echo?, echoTruncated?,
 *   echoKind?, echoSkipped? }`）。
 * @param {string} lang - 语言。
 * @returns {object} 出口条目。
 */
export function projectBatchEntry(item, lang) {
  const terminal = item.terminal ?? null;
  const diagFirst = terminal === null ? '' : clampNote(terminalDetailLines(terminal)[0] ?? '');
  const markerLine = terminal === null ? '' : terminalMarker(terminal, lang);
  // 注记行（读取失败优先——其条目无正文且不附原文，注记即重试出路）；lossy
  // 与原文未附注记可并存，各自入界后换行拼接（render 按整块呈现）。
  const noteLines = [];
  if (item.readFailed) {
    noteLines.push(clampNote(t(lang, 'delivery.readFailed', { jobId: item.jobId })));
  } else {
    if (item.lossy) {
      noteLines.push(clampNote((item.spillPaths?.length ?? 0) > 0
        ? t(lang, 'delivery.lossyAtPaths', { paths: item.spillPaths.join(', ') })
        : t(lang, 'delivery.lossyUnrecoverable')));
    }
    if (item.echoSkipped === true) {
      noteLines.push(clampNote(t(lang, 'delivery.echoSkipped')));
    }
  }
  return {
    job_id: item.jobId,
    status_line: [
      clampNote(t(lang, 'delivery.completionItem', {
        jobId: item.jobId,
        status: terminal?.status,
        chars: item.chars
      })),
      ...(markerLine === '' ? [] : [markerLine]),
      ...(diagFirst === '' ? [] : [diagFirst])
    ].join('\n'),
    ...terminalFacts(terminal, lang),
    ...(noteLines.length > 0 ? { note: noteLines.join('\n') } : {}),
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

/** 测试隔离：整体重置（不得在产品路径调用）。 */
export function resetDeliveryLedger() {
  ledger.disposeAll();
  ledger.jobs.clear();
  ledger.subjects.clear();
  ledger.now = () => Number(process.hrtime.bigint() / 1_000_000n);
}
