/**
 * 作业目标适配（设计 §3.2.3）：统一等待的作业目标三分、事件通道与终态读取。
 *
 * - **三分快照**（设计 §2.4）：`jobs.list(caller)` 基的同步快照——命中行＝存在
 *   （终态与运行都算），查无＝`null`（清单里没有此 id，含其他主体的作业），
 *   查询失败＝`undefined`。查无与查询失败分开，不互为文案。
 * - **事件通道**（设计 §3.2.3）：`jobs.wait` 到期或结算释放；到期 resolve 后由
 *   调用方决定续排。目标作业的完成不经消息通道，由本通道判定。
 * - **终态读取经交付账本**（设计 §2.6）：`jobs.read` 消费后正文由账本持有，
 *   重复等待只返回新增内容；游标推进不可逆，账本缓冲是已消费正文的唯一持有处。
 *   本包作业与外来作业同样入账，发现路径按行形三分（设计 §2.3）：账本外的
 *   **运行中**外来行走 `observeForeignJob` 入账并挂同款保活链（结算可观察，
 *   见 lib/wait.js 对账段与 lib/delivery.js 事件登记）；**首见即终态**的外来
 *   行只入账＋定论读取、不挂链（无结算可观察，挂链会误置 observedSettlement）；
 *   **本包已接管**作业（own）的保活链由首次等待机制接管，发现路径不再另挂。
 *   （真实 loader／热更组合下的装载时序不在此宣称全验——按各调用点的受控
 *   用例与实例探针分层取证。）
 *
 * @module dsh-async-tools/wait-job-target
 */
import { ledger } from './delivery.js';

/** 宿主作业终态集合（completed / killed / failed）。 */
export const TERMINAL = new Set(['completed', 'killed', 'failed']);

/** 终态判定（状态字符串）。 */
export const isTerminal = (status) => TERMINAL.has(status);

/**
 * 读取作业快照，三分返回：行对象＝存在；`null`＝查无或不可见；
 * `undefined`＝查询本身失败。caller 是宿主会话标识（SessionId）。
 *
 * 建在 `jobs.list()` 而不是 `jobs.get()` 上：`get` 对未知 id 一律 throw，查询
 * 失败与查无从错误形态上无法区分；`list(caller)` 只返回 caller 可见作业的视图，
 * 缺席与「不存在」对调用方等价（不泄漏存在性）。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {string} jobId - 作业 id。
 * @param {unknown} caller - 宿主会话标识。
 * @returns {object|null|undefined} 三分快照。
 */
export function snapshotOf(ctx, jobId, caller) {
  try {
    return ctx.jobs.list(caller).find((job) => job?.id === jobId) ?? null;
  } catch {
    return undefined;
  }
}

/**
 * 作业目标句柄：一个等待目标（本包或外来作业）的观察与读取面。
 *
 * 读取全部经交付账本（设计 §2.6）：外来作业在**存在性证实后**入账（
 * `ensureRegistered`，RA-FOREIGN-DISCOVERY 修复——构造只建句柄不落账，查无
 * 拒绝因此零残留）；本包作业仍在启动时入账（`lib/jobs.js`／`lib/workflow.js`）。
 * 账本的 `readSettled` 消费一次性 `result` 通道并持有缓冲——同一作业被多主体、
 * 多载体重复读取时正文不重复。
 */
export class JobTarget {
  /**
   * @param {object} init
   * @param {object} init.ctx - cordis 上下文。
   * @param {object} init.config - 生效配置视图。
   * @param {string} init.jobId
   * @param {unknown} init.owner - 主体（宿主会话标识）。
   */
  constructor({ ctx, config, jobId, owner, t, lang = 'en' }) {
    this.ctx = ctx;
    this.config = config;
    this.jobId = jobId;
    this.owner = owner;
    this.t = t;
    this.lang = lang;
  }

  /**
   * 存在性证实后的幂等入账（RA-FOREIGN-DISCOVERY，设计 §1.2.1）：调用方须已
   * 持有存在证据（清单行、事件通道视图、终态读取前的快照）才可调用——查无
   * 与查询失败路径因此不落账；证据可随 `facts` 传入（宿主 view：`owner` 为
   * 会话标识字符串或缺席），未传时按快照自查（失败或查无不落账、不抛错——
   * 事件通道成员的容错口径；入口校验遍在调用前已另行按三分快照拒绝）。
   *
   * 分账（PUBLIC-JOB-01，设计 §2.6）：无主公开作业（`facts.owner === undefined`）
   * 按主体分册入账——第二主体的存在性判定、状态访问与等待不被登记拒绝
   * （各自的预算/游标/份额；宿主一次性 `result` 与读取游标全局唯一，第二主体
   * 只得此后增量）；有主作业单条记录，证据显示他主（防御——宿主
   * `jobs.list(caller)` 过滤后正常不可见）时按**查无**口径拒绝（与入口校验
   * 同词，可见性拒绝统一走目标解析查无口径）。
   */
  ensureRegistered(facts = undefined) {
    let evidence = facts;
    if (evidence === undefined) {
      const row = snapshotOf(this.ctx, this.jobId, this.owner);
      if (row === null || row === undefined) return; // 查无/查询失败：不落账（零残留）
      evidence = row;
    }
    if (evidence !== null && evidence.owner !== undefined && evidence.owner !== this.owner) {
      throw new Error(this.t(this.lang, 'error.unknownJob', { jobId: this.jobId }));
    }
    ledger.ensureForeignJob(this.ctx, this.config, this.jobId, this.owner, {
      unowned: evidence?.owner === undefined
    });
  }

  /** 同步三分快照（`{ state }` 三档：'found' 附行、'missing'、'failed'）。 */
  snapshot() {
    const row = snapshotOf(this.ctx, this.jobId, this.owner);
    if (row === undefined) return { state: 'failed' };
    if (row === null) return { state: 'missing' };
    return { state: 'found', row, terminal: isTerminal(row.status) };
  }

  /**
   * 共享清单快照的三分判定（DOC-ZERO-01，设计 §2.3）：零等待入口恰一次
   * `jobs.list` 的结果本地查找，不再逐目标重查。`rows` 非数组（清单查询失败
   * 或缺席）按 'failed' 档交回——与 `snapshot()` 的查询失败同词。
   */
  snapshotFrom(rows) {
    if (!Array.isArray(rows)) return { state: 'failed' };
    const row = rows.find((job) => job?.id === this.jobId) ?? null;
    if (row === null) return { state: 'missing' };
    return { state: 'found', row, terminal: isTerminal(row.status) };
  }

  /**
   * 事件通道（设计 §3.2.3）：`jobs.wait` 至 `ms` 或结算释放；signal 只中断等待、
   * 不取消作业。调用方取得正超时值（设计 §2.1：剩余不正时不调用）。
   * @returns {Promise<object>} 结算或到期的 JobView（reject 由调用方承接归一）。
   */
  wait(ms, signal) {
    return this.ctx.jobs.wait(this.jobId, ms, this.owner, signal);
  }

  /**
   * 终态读取（经账本，设计 §2.6／§2.3）：快照或事件通道已证终态后调用；读取
   * 一次增量（含首次终态一次性 `result`）并进入主体批次的待交付缓冲。非终态
   * 或读取失败返回 `null`（失败不写成空结果，保留可重试口径）。
   *
   * `options.observed`（§2.3 观察标记，SOL-REQ-01）：终态事实来自本包在册
   * waiter 的释放（事件通道 `jobs.wait` 的结算 resolve）时为 `true`——结算在
   * 观察下发生，空读取不进正文去向判别；快照／枚举首见即终态（默认）不置
   * 观察——空读取由账本按 §2.3 判别次序定论。
   *
   * @param {object} [terminal] 调用方已证实的终态事实（快照行或事件视图）。
   * @param {{observed?: boolean}} [options] 观察标记。
   */
  async readSettled(terminal, options = {}) {
    return ledger.readSettled(this.jobId, terminal, this.owner, options.observed === true);
  }

  /** 已证终态但未读取的观察（等待出口聚合「其余目标已证状态」用）。 */
  provenTerminal() {
    const entry = ledger.entryFor(this.jobId, this.owner);
    if (entry?.terminal !== null && entry?.terminal !== undefined) return entry.terminal;
    return null;
  }
}
