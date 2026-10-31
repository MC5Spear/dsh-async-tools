/**
 * 交付账本（设计 §2.6、§3.2.5）：作业结果的批次化直接交付。
 *
 * 三个职责面：
 * - **保活链**（设计 §2.3）——作业转入后台后 `jobs.wait` 按拍续排，结算前始终有本包
 *   waiter 在册（宿主以结算时刻在册 waiter 抑制自带完成通知，本包完成消息成为唯一
 *   含正文交付）。拍长 60 秒、交叠半拍：每拍在窗口过半时预注册下一拍，相邻两拍交叠，
 *   「到期离集与续排入集之间」无空档；首次等待自身的 waiter 即链的零拍，链首拍在零拍
 *   窗口过半时预注册（零拍到期让出或提前结束时首拍已在册——提前结束路径同步注册首拍，
 *   中间不让出事件循环）。频率界（每作业每 30 秒至多一次新注册）指保活链注册的稳态；
 *   链入口过渡（零拍→链首拍）的注册间隔为零拍半窗（首次等待预算之半），可短于 30 秒。
 * - **批次与预算**（设计 §2.6）——一个交付批次＝同一主体将共同进入下一次模型输入的本包
 *   交付内容集合；领取窗口按可观察事实识别：等待类调用的执行窗口（就绪内容并入该次
 *   调用的返回）、无活等待时作业结算由完成消息交付（完成消息本身即开启一个批次）。
 *   批在可观察的领取点关闭：主体的 `agent/inbox/claimed` 领取事件，或该主体全部本包
 *   活等待均已返回提交（并行以最后一个为准）。同拍并行发出的多个等待类调用汇入同一
 *   次模型输入、属同一批次，各返回从同一份批次预算分配。同一批次内全部结果内容共享
 *   一份 `maxResultChars`（按 `String.length` 计量），账本按主体维护当前批剩余预算，
 *   逐个交付载体扣减；分配顺序：触发目标优先，其余按就绪时刻先进先出，同拍并列按
 *   作业 id 字典序；剩余预算为零后到达的条目整条延后。单批至多 10 条；预算外说明
 *   单条不超过 200 字符、单批合计不超过 2000 字符，到达上限后逐条说明改为一行汇总。
 * - **在途仲裁与让位终局复查**（设计 §2.6）——同一作业同时被等待返回与完成消息两路
 *   认领时，以先构造交付内容的一方为认领方（构造点原子置位），后到者只输出状态行。
 *   作业结算时若该主体存在本包活等待，完成消息路径让位；等待返回提交、活等待注销时
 *   复查未交付的就绪内容——该主体已无本包活等待时补开完成消息，不等待模型主动领取。
 *
 * 完成消息经 `followup`（主体空闲）或 `inject`（主体忙）进入收件箱，与迟到作答同一
 * 投递通道（`lib/ask-takeover.js` 的先例）；完成消息与迟到作答共用「待启动投递」登记
 * ——已构造完成、尚未经宿主通道发出的本包投递项清单；同拍多作业结算且主体空闲时，
 * 各条完成消息合并为一条 `followup` 轮次投递，不逐条开启轮次。
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
import { truncate } from './output.js';
import { t } from './text.js';

/** 保活链拍长（设计 §2.3：60 秒）。 */
const BEAT_MS = 60_000;

/** 预注册点：拍窗口过半（设计 §2.3：交叠半拍）。 */
const HALF_BEAT_MS = BEAT_MS / 2;

/** 单批交付条目上限（设计 §2.6：与宿主单主体并发出厂上限一致）。 */
const MAX_BATCH_ITEMS = 10;

/**
 * 预算外说明的两档上限（需求 9.3.2「批次还须限制条目数及预算外状态、标识和
 * 诊断说明的总量……由设计给出有限且可测的规则」——设计 §2.6 落为两个固定值
 * 及其推导闭合）：单条说明（状态行、`lossy`／留存行、延后说明、截断标注）至多
 * 200 字符，超长截断（宿主提供的留存路径等外部字符串长度无界，必须在此入界）；
 * 单批逐条说明合计至多 2000 字符——由「条目上限 10 × 单条 200」结构性闭合
 * （批内每条说明恰好一行），完成消息内的留存行合计超限改一行计数汇总（正文
 * 不受限——只约束说明）。
 */
export const MAX_NOTE_CHARS = 200;
export const MAX_NOTES_TOTAL = 2000;

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
     * 当前批：`null`＝无开批；`{ remaining }`＝已开批，`remaining` 为该批剩余字符预算。
     * 开批＝第一个交付载体构造；关批＝领取事件或全部活等待提交（设计 §2.6）。
     */
    this.batch = null;
    /** @type {Array<{kind:'completion', message: object, jobId: string}>} 待启动投递登记。 */
    this.pendingSends = [];
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
    /** 已消费未交付正文缓冲（交付载体提交成功才清对应部分）。 */
    this.buffer = '';
    /** 读取截断与溢出留存线索（最近一次读取，随载体呈现）。 */
    this.lossy = false;
    this.spillPaths = [];
    /** 一次性 `result` 是否已被消费（宿主契约：首次终态一次性通道）。 */
    this.resultConsumed = false;
    /** 就绪时刻（单调时钟；FIFO 分配次序），未就绪为 `null`。 */
    this.readyAt = null;
    /** 已交付事实：`null` 或 `{ via: 'wait' | 'message' }`。 */
    this.deliveredFact = null;
    /** 在途仲裁认领方（设计 §2.6 构造点原子置位）：`null | 'wait' | 'message'`。 */
    this.claimedBy = null;
    /** 在途读取 Promise（去重并发读取）。 */
    this.readInFlight = null;
    /** 保活链状态：`null`＝未挂链。 */
    this.chain = null;
  }
}

/**
 * 交付账本。全部状态按主体与作业双索引；`disposeAll` 供行卸载整体回收。
 */
export class DeliveryLedger {
  constructor() {
    /** @type {Map<string, JobRecord>} */
    this.jobs = new Map();
    /** @type {Map<unknown, SubjectRecord>} */
    this.subjects = new Map();
    /** claimed 监听（关批锚点）：装载行 ctx → disposer。 */
    this.claimedDisposers = new Map();
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

  // ── 装配（工具行 apply 调用一次）────────────────────────────────────────

  /**
   * 挂 `agent/inbox/claimed` 监听（关批锚点，设计 §2.6）：主体的领取点关闭当前批。
   * cordis 事件沿祖先链可达——预设行 ctx 能收到其下会话 agent 的 claimed 事件
   * （宿主先例：`dsh-tool-jobs` 的 wakeup 预算、`dsh-user-questions` 的待答清理）。
   * 返回 dispose，由行卸载处置。
   */
  attachClaimedListener(ctx) {
    if (this.claimedDisposers.has(ctx)) return () => {};
    const listener = ({ agent }) => {
      const owner = agent?.id;
      if (owner === undefined) return;
      const subject = this.subjects.get(owner);
      if (subject === undefined) return;
      // 领取点只关批（下一批恢复全额预算）。**不清 pendingSends**：待投递项的
      // 正文已从缓冲清出、凭据在项上，由下一次 flush 消费——清空即丢内容
      //（push 与 flush 之间的微任务窗口内正是 claimed 可能到达的时刻）。
      subject.batch = null;
    };
    let disposeListener;
    try {
      // cordis `ctx.on` 返回撤销函数——不走 `ctx.off`（服务访问静态扫描会把
      // 它当未声明服务，而事件 API 本就不是 inject 服务）。
      disposeListener = ctx.on('agent/inbox/claimed', listener);
    } catch (error) {
      log(`claimed listener attach failed: ${String(error?.message ?? error)}`);
      return () => {};
    }
    const dispose = () => {
      try {
        if (typeof disposeListener === 'function') disposeListener();
      } catch { /* 已卸载的通道再撤不放大 */ }
      this.claimedDisposers.delete(ctx);
    };
    this.claimedDisposers.set(ctx, dispose);
    return dispose;
  }

  // ── 作业侧（命令 / 编排的首次等待接线）──────────────────────────────────

  /**
   * 作业启动登记：命令或编排作业注册成功即建账（首次等待武装零拍信息由此续接）。
   */
  noteJobStarted(ctx, config, jobId, owner) {
    if (this.jobs.has(jobId)) return;
    this.jobs.set(jobId, new JobRecord({ ctx, config, jobId, owner }));
  }

  /**
   * 零拍武装（设计 §2.3 链入口交接）：首次等待自身的 waiter 即链的零拍；链首拍在
   * 零拍窗口过半时预注册。`budgetMs` 是本次首次等待的剩余窗口。
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
   * 首拍预注册（若尚未注册）。`jobs.wait` 的 waiter 在宿主 Promise 执行器内同步入册
   * （`dsh-jobs-local` 的 `waitResolvers.add`），调用即注册、无需等待。
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
   * 首次等待提前结束（插话 / 取消）且作业仍在运行：退出处理内同步注册首拍（若首拍
   * 尚未在中点预注册），中间不让出事件循环（设计 §2.3）。
   */
  takeOverChain(jobId) {
    const entry = this.jobs.get(jobId);
    if (entry === undefined || entry.chain === null) return;
    if (!entry.chain.firstBeatArmed) this.#armFirstBeat(jobId);
  }

  /**
   * 首次等待结束的账面处理：
   * - `outcome = 'still-running'`（到期让出）——链已接管，无额外动作；
   * - `outcome = 'settled'`——撤销预注册（未让出则不挂链，设计 §2.3「零拍内结算则
   *   撤销预注册不挂链」），读取并按交付规则结算；
   * - `outcome = 'delivered'`——首次等待自身把终态结果直接交回了模型（async_run /
   *   async_workflow 的结算路径：输出经本包拉式源构造，不经账本）：只登记终态
   *   事实与已交付事实（阻断后续完成消息与批次重复交付），不读取、不缓冲；
   * - `outcome = 'detached'`——作业被撤销（如行卸载），整体回收。
   */
  async noteFirstWaitEnded(jobId, outcome, terminal, deliveredChars) {
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
      // 已交付事实阻断**一切**再交付（需求 9.3.2「同一最终结果在正常交付中只
      // 出现一次」——原始 JSON 与渲染文本算同一最终结果的两种形态）：完成消息
      // （#deliverIfNoWait）与批次（collectBatch）都按 deliveredFact 跳过。armed
      // 保活链保留（其目的＝抑制宿主原生完成通知，防双发），其 #beat 结算读取
      // 同样按本事实短路。
      if (entry.deliveredFact === null) entry.deliveredFact = { via: 'first-wait' };
      // 直付份额计入批次预算（盲审 M-6）：直付正文与同拍其他载体可进入同一次
      // 模型输入（主体忙时完成消息走 inject 落 nextStep 随本轮领取），两载体
      // 合计不得超单份 maxResultChars——直付按其交付字符数开批/扣减，同拍其后
      // 的 #deliverIfNoWait/collectBatch 沿同一份剩余分配。
      this.chargeDelivery(entry.owner, entry.config, Number(deliveredChars ?? 0));
      return;
    }
    if (outcome === 'detached') this.detachJob(jobId);
  }

  /** 交付份额计费：开批（若未开）并扣减直付字符数（下限 0）。 */
  chargeDelivery(owner, config, chars) {
    if (!Number.isFinite(chars) || chars <= 0) return;
    const subject = this.#subject(owner);
    if (subject.batch === null) {
      subject.batch = { remaining: Math.max(1, Number(config?.maxResultChars ?? 4096)) };
    }
    subject.batch.remaining = Math.max(0, subject.batch.remaining - Math.ceil(chars));
  }

  /** 撤销零拍预注册 timer 与链信号（未让出的结算路径；不撤已在册 waiter 由其自然到期）。 */
  #disarmChainPreregistration(entry) {
    if (entry.chain === null) return;
    if (entry.chain.firstBeatTimer !== null) {
      clearTimeout(entry.chain.firstBeatTimer);
      entry.chain.firstBeatTimer = null;
    }
    if (!entry.chain.firstBeatArmed) {
      // 首拍尚未注册：链未真正接管，整体撤销信号（预注册 timer 已清）。
      entry.chain.signal.abort();
      entry.chain = null;
    }
  }

  /**
   * 保活链一拍（设计 §2.3）：`jobs.wait` 60 秒；拍窗口过半预注册下一拍；结算释放
   * 或到期释放都回到本函数分档。撤销（`chain.signal`）产生的 reject 就地承接。
   * `ordinal` 仅用于诊断。
   */
  async #beat(jobId, ordinal) {
    const entry = this.jobs.get(jobId);
    if (entry === undefined || entry.chain === null || entry.chain.disposed) return;
    const chain = entry.chain;
    // 本拍的预注册 timer：窗口过半时启动下一拍（其 waiter 立即在册——交叠半拍）。
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
      // 结算：撤销信号停止后续拍（已在册的下一拍由 abort 拒绝承接）。
      this.#disposeChain(entry);
      // 已交付（首次等待直付）不再读——读取只会填一段无人消费的缓冲
      //（deliveredFact 阻断一切再交付，见 noteFirstWaitEnded 'delivered'）。
      if (entry.deliveredFact === null) await this.readSettled(jobId, view);
      return;
    }
    // 非终态到期（或异常形状）：本拍结束；下一拍已过半预注册（在册交叠），未预注册则现在补。
    clearTimeout(half);
    if (!preregistered) this.#beat(jobId, ordinal + 1);
  }

  /** 结束链：撤销信号、标记已处置（后续拍的 reject 静默承接）。 */
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

  /** 行卸载整体回收。 */
  disposeAll() {
    for (const jobId of [...this.jobs.keys()]) this.detachJob(jobId);
    for (const dispose of this.claimedDisposers.values()) dispose();
    this.claimedDisposers.clear();
    this.subjects.clear();
  }

  // ── 读取（设计 §2.4 消费纪律）──────────────────────────────────────────

  /**
   * 结算读取：作业已证实终态后消费一次增量（chunks 拼接 + 首次终态一次性 `result`）。
   * 终态证据由调用方持有（保活链拍释放、首次等待结算、`jobs.list` 快照）；
   * `terminal` 缺席时按当前快照自证一次（同步 `jobs.list`，设计 §2.4 的三分法）。
   * 在途读取共享同一 Promise（等待出口与保活链并发触发不双读）。
   * @param {string} jobId
   * @param {{status?: string, exitCode?: number|null, signal?: string|null, detail?: unknown}} [terminal]
   *   调用方已证实的终态事实（可选）。
   * @returns {Promise<{text: string, lossy: boolean, spillPaths: string[], terminal: object}|null>}
   *   非终态或读取失败返回 `null`（失败保留可重试口径，不写成空结果）。
   */
  async readSettled(jobId, terminal) {
    const entry = this.jobs.get(jobId);
    if (entry === undefined) return null;
    if (entry.readInFlight !== null) return entry.readInFlight;
    const attempt = (async () => {
      if (entry.terminal === null) {
        let facts = terminal;
        if (facts === undefined) {
          try {
            const rows = entry.ctx.jobs.list(entry.owner);
            const row = Array.isArray(rows) ? rows.find((candidate) => candidate?.id === jobId) : undefined;
            if (row !== undefined && isTerminal(row.status)) {
              facts = row;
            }
          } catch {
            return null;
          }
        }
        if (facts === undefined || !isTerminal(facts.status)) {
          entry.readInFlight = null;
          return null;
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
        entry.readInFlight = null;
        return null;
      }
      if (entry.readyAt === null) entry.readyAt = this.now();
      entry.readInFlight = null;
      await this.#settleReady(entry);
      return { text: entry.buffer, lossy: entry.lossy, spillPaths: entry.spillPaths, terminal: entry.terminal };
    })();
    entry.readInFlight = attempt;
    return attempt;
  }

  /**
   * 运行中增量读取（设计 §3.2.3：零等待对作业目标可交付当前未交付增量，即使作业
   * 尚在运行）。消费一次 `jobs.read` 的 chunks 增量并入缓冲（运行中无一次性
   * `result` 通道——宿主只在首次终态读取交付）；读取失败保留可重试口径。
   * @returns {Promise<{text: string, terminal: object}|null>} 增量投影（空增量返回
   *   空串与当前终态事实——终态事实可能为 `null`）。
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
    } catch (error) {
      log(`incremental read ${jobId} failed: ${String(error?.message ?? error)}`);
      return null;
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
    // 让位终局复查投**全部**就绪未认领条目（复审 H-1：只投 Map 迭代序第一个会
    // 让其余就绪正文失去被动交付载体——已终态、保活链已结束、无新事件，只剩
    // 模型主动领取一条路，违反 9.3.2「不要求专门再调用一次工具领取」）。空正文
    // 终态条目也投（复审 N-2：与批次路径「无输出完成的作业以状态行可见」对称
    // ——保活链抑制了宿主通知，让位复查是它唯一的被动可见载体）。逐条构造
    // （deferFlush）后单次冲刷：同拍多条合并一次通道投递（设计 §2.6）。
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
   * 分配规则（设计 §2.6）：触发目标优先，其余按就绪时刻 FIFO，同拍并列按作业 id
   * 字典序；每条取剩余批预算与条目长度的较小值（超批预算单条按首尾保留裁剪——由
   * 调用方渲染层执行，本层给出裁剪目标长度）；预算耗尽后到达的条目整条延后。
   * 关批（全部活等待提交）由调用方在交付载体提交后调 `closeBatchIfIdle`。
   *
   * 默认只装配**终态**条目；`includeRunning`（零等待出口使用，设计 §3.2.3「零等待
   * 对作业目标可交付当前未交付增量」）把有未交付缓冲的**运行中**条目也纳入——装配
   * 后只推进缓冲游标（已发增量不重发），**不置认领与已交付事实**：最终结果在终态后
   * 照常经完成消息或后续批次交付，增量交付不终结条目生命周期（真机首测暴露：零等待
   * 返回称增量已附、实际装配层把运行中条目整体滤除——需求 9.3.1/9.3.6-5 子项）。
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
    const candidates = [];
    for (const entry of this.jobs.values()) {
      if (entry.owner !== owner) continue;
      if (entry.terminal === null && !(includeRunning && entry.buffer !== '')) continue;
      // 空正文终态条目保留（设计 2.4「无输出完成的作业在批次中以状态行可见」，
      // 盲审 L-8）：不因 `buffer === ''` 整条滤除——非触发目标的无输出作业同样
      // 进批（状态行条目，`takeShare` 对空正文零扣减、不占预算）。
      if (entry.claimedBy === 'message') continue; // 完成消息已认领（本批不重复展开正文）
      if (entry.deliveredFact !== null) continue; // 已交付（首次等待直付等）——同一最终结果只出现一次（9.3.2）
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
    const fullBudget = Math.max(1, Number(firstConfig?.maxResultChars ?? 4096));
    // 空候选不开批（盲审 L-4）：首个并行等待的空候选调用若在此开批，批预算
    // 会被 fallback 4096 锁死，后续同批真实分配反而用不上 maxResultChars
    //（默认 30000）——批随首个**有候选**的调用按其条目配置开。
    if (subject.batch === null && candidates.length > 0) subject.batch = { remaining: fullBudget };
    const delivered = [];
    const deferred = [];
    for (const entry of candidates) {
      // 条目上限（设计 §2.6：单批至多 10 条）与预算耗尽（「剩余预算为零后到达的
      // 条目整条延后」）都整条延后——缓冲保留，下一批按 FIFO 优先交付。空正文
      // 条目（状态行条目）不延后：无正文可分配，延后只会把「已完成」推迟可见。
      if (delivered.length >= MAX_BATCH_ITEMS
        || (subject.batch.remaining <= 0 && entry.buffer !== '')) {
        deferred.push(entry.jobId);
        continue;
      }
      const item = this.#takeShare(entry, subject.batch);
      delivered.push(item);
      // 认领与缓冲清空：载体提交由调用方保证（提交失败回滚 undoClaim）。
      entry.buffer = '';
      if (entry.terminal !== null) {
        entry.claimedBy = 'wait';
        entry.deliveredFact = { via: 'wait' };
        entry.readyAt = null;
      } else {
        // 运行中增量（includeRunning）：只推进游标——就绪时刻刷新到本轮，不置
        // 认领/已交付事实，最终结果仍在终态后投递。
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
   * 只经本原语实施一次（读取层存原始拼接文本；「预算不被实施两次」）。完成消息
   * 载体不走本原语＝绕过共享预算（曾实证预算 100 收到 550 字符消息的缺陷形态）。
   * @param {object} entry - 作业账面条目（读取 `buffer`／`terminal`／`lossy`／`spillPaths`）。
   * @param {{remaining: number}} budget - 批预算（就地扣减）。
   * @returns {{jobId, terminal, text, truncated, lossy, spillPaths, chars}}
   */
  #takeShare(entry, budget) {
    const want = entry.buffer.length;
    const take = Math.min(want, budget.remaining);
    const cut = take >= want
      ? { text: entry.buffer, truncated: false }
      : truncate(entry.buffer, take, entry.config.agentLang ?? 'en');
    budget.remaining -= take;
    return {
      jobId: entry.jobId,
      terminal: entry.terminal,
      text: cut.text,
      truncated: cut.truncated,
      // 回滚凭据＝装配前原文（盲审 M-1）：截断条目回滚必须退回**原文**——退回
      // 裁剪文本会让原文中段永久丢失（宿主读取游标已推进不可逆，模型又从未
      // 见过任何部分）。交付/渲染层不读本字段。
      original: entry.buffer,
      lossy: entry.lossy,
      spillPaths: entry.spillPaths,
      chars: cut.text.length
    };
  }

  /**
   * 交付载体提交失败回滚（等待出口取消等）：正文退回缓冲、认领撤销，供下一载体携带。
   * 只处理本批装配/待投递产生的条目（via 'wait'/'message'）——首次等待直付的
   * 'first-wait' 事实不在此列（交付已真实发生，模型已见，不可撤销）。截断条目按
   * 装配前原文（`original`）退回，不得按裁剪文本退回（中段不得丢失）。
   */
  undoClaim(owner, items) {
    for (const item of items ?? []) {
      const entry = this.jobs.get(item.jobId);
      if (entry === undefined) continue;
      entry.buffer = (item.original ?? item.text ?? '') + entry.buffer;
      entry.claimedBy = null;
      entry.deliveredFact = null;
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
   * 同拍多结算合并一条 `followup` 轮次（待启动投递登记 + 单次 flush）。
   */
  async #deliverIfNoWait(entry, options = {}) {
    const subject = this.#subject(entry.owner);
    if (subject.activeWaits.size > 0) return;
    if (entry.terminal === null) return;
    if (entry.claimedBy === 'message') return;
    if (entry.deliveredFact !== null) return; // 已交付（含首次等待直付）——同一最终结果只出现一次（9.3.2）
    const lang = entry.config.agentLang ?? 'en';
    // 完成消息与等待批次**共用同一分配管线**（需求 9.3.2/验收 7：多作业、多条完成
    // 消息和多个工具返回共享 maxResultChars，不按载体形态倍增预算）。
    if (subject.batch === null) subject.batch = { remaining: Math.max(1, entry.config.maxResultChars) };
    // 批预算耗尽（并行领取窗口内其他载体已扣完，设计 §2.6「剩余批次预算为零后
    // 到达的条目整条延后」）：与 collectBatch 同语义——**不认领、不清缓冲、不置
    // 已交付事实**，只投一条预算外延后说明（经 clampNote 入界——jobId 是宿主
    // 不透明字符串，领取出路照抄）；正文由下一批（关批后恢复全额预算）或
    // `async_wait(wait_ms=0)` 完整交付。旧形态（take=0 仍投截断标注的空壳并清
    // 缓冲）会把正文永久丢失（9.3.2 防丢失红线）。
    if (subject.batch.remaining <= 0 && entry.buffer !== '') {
      subject.pendingSends.push({
        kind: 'completion',
        jobId: entry.jobId,
        lang,
        items: [],
        render: () => clampNote(t(lang, 'delivery.deferredNotice', { jobId: entry.jobId }))
      });
      if (options.deferFlush !== true) await this.#flushPendingSends(entry.owner);
      return;
    }
    entry.claimedBy = 'message';
    const items = [];
    if (entry.buffer !== '') items.push(this.#takeShare(entry, subject.batch));
    subject.pendingSends.push({
      kind: 'completion',
      jobId: entry.jobId,
      lang,
      // 回滚凭据（flush 双败时经 undoClaim 退回缓冲，正文不因通道故障丢失）；
      // original＝装配前原文——截断条目按原文回滚（盲审 M-1，中段不得丢失）。
      items: items.map((item) => ({ jobId: item.jobId, text: item.text, original: item.original })),
      // 空正文终态条目渲染单行状态（N-2：无输出完成的作业在完成消息中以状态行
      // 可见，不投空串消息）。
      render: () => (items.length === 0
        ? clampNote(t(lang, 'delivery.completionItem', {
          jobId: entry.jobId, status: entry.terminal.status, chars: 0
        }))
        : renderCompletionMessage(lang, items))
    });
    entry.buffer = '';
    entry.deliveredFact = { via: 'message' };
    entry.readyAt = null;
    if (options.deferFlush !== true) await this.#flushPendingSends(entry.owner);
  }

  /**
   * 待启动投递登记的冲刷：合并同拍登记为一次通道投递（空闲一条 followup 开轮；
   * 忙时逐条 inject——宿主整批领取，同窗口多条由宿主合并）。失败保留待重试（下一
   * 结算或等待出口触发）；followup 抛错按 inject 重试一次，双败转 lost（诊断日志）。
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
        return;
      }
      for (const send of queue) {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: send.render() }],
          source: { kind: JOB_RESULT_SOURCE, form: 'notice', summary: completionSummary(lang, [send]) }
        }));
      }
    } catch (error) {
      log(`completion delivery for ${String(owner)} failed: ${String(error?.message ?? error)}`);
      // 双败回滚（同 registry miss 分支）：正文退回缓冲，交下一载体。
      this.undoClaim(owner, queue.flatMap((send) => send.items ?? []));
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
   * 内容就绪事件（无目标等待的唤醒通道，设计 §3.2.5）：结算读取完成后由本账本经
   * cordis 事件总线广播（`JOB_RESULT_EVENT`），等待方订阅同一事件名。
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

  /** 结算读取完成后的统一入口：就绪事件 + 无活等待投递。 */
  async #settleReady(entry) {
    this.#emitReady(entry.owner);
    await this.#deliverIfNoWait(entry);
  }
}

/** 完成消息正文渲染（两语词典；正文自含作业标识与终态）。说明行经 clampNote
 * 入界（需求 9.3.2 说明总量有界——留存路径等宿主字符串长度无界，在此截断）；
 * 单条消息的说明合计（状态行＋全部留存行）受 MAX_NOTES_TOTAL 约束——超限保留
 * 状态行、留存行合并为一行计数汇总（超限汇总回退，正文不受限）。 */
function renderCompletionMessage(lang, items) {
  const parts = [];
  for (const item of items) {
    const header = clampNote(t(lang, 'delivery.completionItem', {
      jobId: item.jobId,
      status: item.terminal.status,
      chars: item.chars
    }));
    parts.push(header);
    if (item.text !== '') parts.push(item.text);
    // lossy 找回说明（需求 9.3.2）：有落盘副本→位置；无副本→如实说明该部分
    // 无法找回。与 spill 行共用同一条说明预算（MAX_NOTES_TOTAL）。
    let used = 0;
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
  }
  return parts.join('\n');
}

/** 完成消息 summary（通知摘要行，两语词典键）。 */
function completionSummary(lang, queue) {
  return t(lang, 'delivery.completionSummary', { count: queue.length });
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
