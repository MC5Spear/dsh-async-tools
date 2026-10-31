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
 *   本包作业与外来作业同样入账（外来作业不挂保活链，设计 §2.3）。
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
 * 读取全部经交付账本（设计 §2.6）：目标首次使用时入账（本包作业已在启动时
 * 入账；外来作业此时入账且不挂保活链）。账本的 `readSettled` 消费一次性
 * `result` 通道并持有缓冲——同一作业被多主体、多载体重复读取时正文不重复。
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
    // 外来作业（非本包工具注册）此时入账：无保活链，读取与批次交付仍走账本。
    // **跨主体不复用**（审查问题 15）：账本按 jobId 全局入账，第二主体等待同 id
    // 时若静默复用第一主体的条目，读取与批次会按第一主体的 owner/config/ctx
    // 结算（串账）。宿主 `jobs.list(caller)` 本身按主体过滤，正常到达不了这里
    // ——本检查是防御（owner 语义弱化的部署形态）。
    const existing = ledger.jobs.get(jobId);
    if (existing === undefined) {
      ledger.noteJobStarted(ctx, config, jobId, owner);
    } else if (existing.owner !== owner) {
      throw new Error(t(lang, 'error.foreignJob', { jobId }));
    }
  }

  /** 同步三分快照（`{ state }` 三档：'found' 附行、'missing'、'failed'）。 */
  snapshot() {
    const row = snapshotOf(this.ctx, this.jobId, this.owner);
    if (row === undefined) return { state: 'failed' };
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
   * 终态读取（经账本，设计 §2.6）：快照或事件通道已证终态后调用；读取一次增量
   * （含首次终态一次性 `result`）并进入主体批次的待交付缓冲。非终态或读取失败
   * 返回 `null`（失败不写成空结果，保留可重试口径）。
   * @param {object} [terminal] 调用方已证实的终态事实（快照行或事件视图）。
   */
  async readSettled(terminal) {
    return ledger.readSettled(this.jobId, terminal);
  }

  /** 已证终态但未读取的观察（等待出口聚合「其余目标已证状态」用）。 */
  provenTerminal() {
    const entry = ledger.jobs.get(this.jobId);
    if (entry?.terminal !== null && entry?.terminal !== undefined) return entry.terminal;
    return null;
  }
}
