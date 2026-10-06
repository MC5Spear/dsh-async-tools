/**
 * R30 提问接管的宿主半边（`docs/design.md` §32.2/§32.3/§32.5/§32.6）。
 *
 * 三件事，全部纯依赖注入（services、timer、快照读、followup 都由调用方传入，单测直接喂替身）：
 *
 * 1. **四条件判定序**（§32.2，条件号沿用设计的叙述序：①开关 ②预设 ③计划评审 ④根复验；
 *    代码里按「便宜的先查」排列，语义与设计逐条等价）：任一不满足 → 调 `next()` 交还原生链。
 * 2. **批次注册表与超时竞速**（§32.3）：接管即读活快照的 `askTimeoutMs` 武装定时器；齐答
 *    提前结清（撤定时器 + 幂等护栏）；超时合成（`selected: []` + 超时说明 custom，
 *    不代答）；signal 中止按 ASK_ABORTED 形状拒绝（`ASK_ABORTED` 不被合成答案盖过）。
 * 3. **迟到作答注入**（§32.5，通知形 + 按状态选通道，用户裁定）：
 *    Agent 空闲且无未领取的本包通知 → `agent.followup()`（唤醒开回合，单条也
 *    立即）；其余（运行中，或空闲但自家 followup 尚未开跑）→ `agent.inject()`
 *    （next-step 折入下一领取点，同窗口多条由宿主整批领取——插件不建
 *    队列）。作答/忽略到达即刻发 `LATE_ANSWER_EVENT`（与投递解耦）；inject 落在
 *    回合最后一次领取之后 → `whenIdle` 空闲观察发现滞留 → 补一条极小 followup
 *    提醒开回合顺走（§32.5 末步竞态防护）。正文自含完整题面
 *    （id/题干/选项全集/multiSelect/作答或忽略/custom/时延）。
 *
 * `AskTakeoverService`（§32.6）：typert remote 命名空间 `async-tools-ask` 的三方法
 * （state/answer/ignore）。`@Remote` 是 ES 方法装饰器、plain JS 不可用语法，用导出的
 * `Remote` 函数 + 伪装饰器 context 手工挂标记（`addMarkerInitializer` → 官方
 * `mark()` 路径，原型级、幂等、多实例安全；只用公开 API）。
 *
 * 生命周期：由 `lib/host.js` 的运行时 inject 子作用域持有；卸载时 `disposeAll` 对每个
 * 未结批 `next()` 交还原生链（§32.2 可逆卸载）。
 *
 * @module dsh-async-tools/lib/ask-takeover
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { LOG_PREFIX } from './config.js';
import { LATE_ANSWER_EVENT, LATE_ANSWER_SOURCE, unclaimedLateSources } from './interrupts.js';
import { t } from './text.js';

/** 允许接管的两个预设根（R30 边界：计划评审/审批链/标准预设不碰）。 */
const TAKEOVER_PRESETS = new Set(['dsh-async', 'dsh-async-create']);

/**
 * expired 批的寿命上界（§32.3）：迟到作答窗口留 24 小时；超龄批在新批次
 * 接管时清扫——注册表内存有界（徽标不无限累积），且 24 h 后 agent 引用即便还在、
 * 会话多半早已翻页，注入价值趋零。
 */
const EXPIRED_TTL_MS = 24 * 60 * 60 * 1000;

/** `ASK_ABORTED` 的 plain-object 形状（`ask()` 的 `restoreUserQuestionError` 还原）。 */
function askAbortedError() {
  return {
    name: 'UserQuestionError',
    message: 'ask_user_question was aborted before the user answered',
    code: 'ASK_ABORTED'
  };
}

/** stderr 审计一行（操作者面，中文，不进模型面文案表）。 */
function audit(message) {
  process.stderr.write(`${LOG_PREFIX} ask-takeover: ${message}\n`);
}

/**
 * 四条件判定（§32.2）。**全程同步**——`stateOf` 同步返回，判定期间不 await
 * 任何慢路径，抢先语义无窗口竞态。
 *
 * @param {object} request - waterfall 载荷 `{questions, agent?, signal?}`。
 * @param {object} services - `{sessions, sessionProjections, agents}`（均可缺席）。
 * @param {object} snapshot - 当前的生效配置快照（活读，不是构造快照——R10）。
 * @returns {{takeover: boolean, agent?: object}} takeover=true 时带 agent。
 */
export function shouldTakeover(request, services, snapshot) {
  // ①总开关：只有字面 true 才算开（与 silentFailureGuard 同款归一，失效安全方向 = 关）。
  if (snapshot?.askTakeover !== true) return { takeover: false };
  // ②agent 在场：无 agent 的编程式请求交还原生链。
  const agent = request?.agent;
  if (agent === undefined || agent === null) return { takeover: false };
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  // ③计划评审：一批次任一题带 plan-review intent 即整批原生（计划评审是单题批次，
  // 保守按整批判——R30 边界「不接管计划评审」）。
  if (questions.some((q) => q?.intent?.kind === 'plan-review')) return { takeover: false };
  // ②预设（投影路径）：sessions.get(agent.id) → stateOf(session,'agentPreset') 同步全等。
  // 任一跳 undefined/抛错 → next()（§32.2：会话不存在/投影缺席都按「不是本包预设」交还）。
  let preset;
  try {
    const session = services?.sessions?.get?.(agent.id);
    preset = session === undefined || session === null
      ? undefined
      : services?.sessionProjections?.stateOf?.(session, 'agentPreset');
  } catch (error) {
    audit(`preset check failed for agent ${String(agent.id)}: ${String(error?.message ?? error)}`);
    return { takeover: false };
  }
  if (!TAKEOVER_PRESETS.has(preset)) return { takeover: false };
  // ④根复验（三态）：不在根表 → next()；在场但读取抛错 → next()（保守）；
  // 服务缺席 → 跳过本条继续接管（冗余防线缺席不挡接管——设计已保证服务层拒过
  // 非根调用者，这里只是防御性复核）。
  const agents = services?.agents;
  if (agents !== undefined && agents !== null) {
    let isRoot;
    try {
      isRoot = typeof agents.roots === 'function' && agents.roots().includes(agent);
    } catch (error) {
      audit(`root re-check failed for agent ${String(agent.id)}: ${String(error?.message ?? error)}`);
      return { takeover: false };
    }
    if (!isRoot) return { takeover: false };
  }
  return { takeover: true, agent };
}

/**
 * 批次注册表与超时竞速（§32.3）。一个宿主行 fiber 一个实例；全部状态在内存
 * （设计取舍：待答是运行时事实，不写持久层——重启后 agent 引用本就失效）。
 */
export class AskBatchRegistry {
  /**
   * @param {object} deps - 依赖注入。
   * @param {object} deps.timer - `ctx.timer`（`timeout(fn, ms)` 返回撤销函数）。
   * @param {Function} deps.readSnapshot - 读当前生效配置快照（活读）。
   * @param {Function} [deps.emit] - 本包事件发布面（`(name, payload) => void`，宿主
   *   接线传 `(name, payload) => ctx.emit(name, payload)`；迟到作答唤醒事件
   *   `LATE_ANSWER_EVENT` 由此发出，§32.5 与投递解耦）。缺席 = 静默（单测可
   *   不注入——唤醒面退化但不影响投递）。
   * @param {Function} [deps.now] - 时钟（默认 Date.now；测试可注入假钟）。
   */
  constructor(deps) {
    this.timer = deps.timer;
    this.readSnapshot = deps.readSnapshot;
    this.emitEvent = typeof deps.emit === 'function' ? deps.emit : () => {};
    this.now = deps.now ?? Date.now;
    /** @type {Map<string, object>} batchId → 批次记录。 */
    this.batches = new Map();
    this.seq = 0;
    /** 待读登记（§32.5）：已投递未领取的作答/忽略条目；地面真值是 agent.inbox，
     * 账本只留复合键与题面（补醒失败转 lost 与界面报错用），懒剪除已领取项。 */
    this.lateLedger = [];
    /** 每 agent 至多一个在途的空闲观察（末步竞态补醒）。 */
    this.sweeps = new Map();
    /** 竞态补醒失败名单（复合键去重、上限 20，§32.6 lostAnswers 通道）。 */
    this.lost = [];
    /**
     * 会话级暂停集（R36）：sessionId → 无限期标志（批次清空不清——连续提问
     * 持续有效；`disposeAll` 清空；`agent/disposed` 尽力清，残留由插件生命
     * 周期兜底，§36.1）。
     * @type {Set<string>}
     */
    this.paused = new Set();
    this.disposed = false;
  }

  /**
   * 接管一个请求（判定已过）。返回挂进 waterfall 的 Promise：齐答/超时解决
   * `{answers:[…]}`，中止拒绝 ASK_ABORTED 形状。
   *
   * `next` 是 waterfall 的下游交还函数：**可逆卸载**时未结批用它把原生链接管回来
   * （§32.2）——机制是 `resolve(next())`：Promise 解决遇到 thenable 会收养它，
   * 原生转发器的等待成为本 Promise 的等待，用户在原生卡片上作答后结果原样回流。
   *
   * @param {object} request - waterfall 载荷。
   * @param {object} agent - 发问的根 Agent。
   * @param {Function} [next] - waterfall 下游交还（监听器调用点传入）。
   * @returns {Promise<object>} waterfall 解决值。
   */
  take(request, agent, next) {
    const snapshot = this.readSnapshot() ?? {};
    const timeoutMs = typeof snapshot.askTimeoutMs === 'number' && Number.isFinite(snapshot.askTimeoutMs)
      ? snapshot.askTimeoutMs
      : 60000;
    const lang = snapshot.agentLang === 'zh' ? 'zh' : 'en';
    const receivedAt = this.now();
    // 超龄 expired 批清扫（寿命上界见 EXPIRED_TTL_MS；新批次进表前做，一次 O(n)）。
    for (const [id, batch] of this.batches) {
      if (batch.phase === 'expired' && receivedAt - batch.expiresAt > EXPIRED_TTL_MS) {
        this.batches.delete(id);
      }
    }
    this.seq += 1;
    const batchId = `ask-${this.seq}-${Math.random().toString(36).slice(2, 8)}`;
    /** 每题 state：'open' | {state:'answered', selected, custom} | {state:'ignored'}。 */
    const questions = new Map();
    for (const question of request.questions) {
      questions.set(question.id, { state: 'open' });
    }
    const batch = {
      batchId,
      sessionId: agent.id,
      agent,
      lang,
      request,
      signalRef: request.signal ?? null,
      questions,
      receivedAt,
      expiresAt: receivedAt + timeoutMs,
      /** 'open'（等待中）| 'expired'（已超时放行，留供迟到作答）| 'settled'。 */
      phase: 'open',
      settled: false,
      next
    };
    this.batches.set(batchId, batch);
    return new Promise((resolve, reject) => {
      batch.resolve = resolve;
      batch.reject = reject;
      // 中止监听（先挂再查已中止：已中止的 signal 不会再触发监听，靠下面的显式检查）。
      batch.onAbort = () => this.finishAbort(batch);
      request.signal?.addEventListener?.('abort', batch.onAbort);
      // 入口中止（§32.3）：接管时 signal 已中止 → 直接按 ASK_ABORTED 形状拒绝。
      if (request.signal?.aborted) {
        this.finishAbort(batch);
        return;
      }
      // R36：暂停中的会话，新到批次自动暂停——不挂 timer、全额窗口记为剩余
      // （`expiresAt` 记原值：语义为暂停时刻冻结的到期点，客户端按 paused
      // 标记不算倒计时）。
      if (this.paused.has(batch.sessionId)) {
        batch.paused = true;
        batch.remainingMs = timeoutMs;
        return;
      }
      batch.paused = false;
      // 超时竞速（§32.3）：接管时刻读快照武装；齐答提前结清在同一同步段撤销（防双结）。
      batch.cancelTimer = this.timer.timeout(() => this.expire(batch), timeoutMs);
    });
  }

  /** 批次是否已结（超时/齐答/中止）。 */
  #isSettled(batch) {
    return batch.settled || batch.phase === 'expired';
  }

  /** 摘 signal 监听与定时器（幂等）。 */
  #teardown(batch) {
    if (typeof batch.cancelTimer === 'function') {
      batch.cancelTimer();
      batch.cancelTimer = undefined;
    }
    if (batch.onAbort !== undefined) {
      batch.signalRef?.removeEventListener?.('abort', batch.onAbort);
      batch.onAbort = undefined;
    }
  }

  /** 中止路径：ASK_ABORTED 形状拒绝 + 出列（`ASK_ABORTED` 不得被合成答案盖过——R30-b）。 */
  finishAbort(batch) {
    this.#teardown(batch);
    batch.settled = true;
    this.batches.delete(batch.batchId);
    batch.reject(askAbortedError());
  }

  /**
   * 超时路径：open 题超时合成（不代答），answered/ignored 保留用户形状；
   * 整批 `{answers:[…]}` resolve。存在 open 题 → 批次转 `expired` 留供迟到作答，
   * 否则出列。
   */
  expire(batch) {
    if (this.paused.has(batch.sessionId)) return; // R36：暂停会话不放行（含误挂 timer 的到期点）
    if (this.#isSettled(batch)) return;
    this.#teardown(batch);
    batch.settled = true;
    let hadOpen = false;
    for (const entry of batch.questions.values()) {
      if (entry.state === 'open') hadOpen = true;
    }
    batch.resolve({ answers: this.#answersOf(batch) });
    if (hadOpen) {
      batch.phase = 'expired';
    } else {
      this.batches.delete(batch.batchId);
    }
  }

  /** 齐答提前结清：全部题 answered/ignored → 撤定时器 + 立即按同形状规则 resolve。 */
  #settleFull(batch) {
    this.#teardown(batch);
    batch.settled = true;
    this.batches.delete(batch.batchId);
    batch.resolve({ answers: this.#answersOf(batch) });
  }

  /** 按各题当前状态生成 answers（open 题只出现在超时路径）。 */
  #answersOf(batch) {
    const seconds = Math.max(1, Math.round((batch.expiresAt - batch.receivedAt) / 1000));
    const answers = [];
    for (const [id, entry] of batch.questions) {
      if (entry.state === 'answered') {
        answers.push({ id, selected: [...entry.selected], custom: entry.custom });
      } else if (entry.state === 'ignored') {
        answers.push({ id, selected: [], custom: t(batch.lang, 'ask.windowSkip') });
      } else {
        answers.push({ id, selected: [], custom: t(batch.lang, 'ask.timeoutCustom', { seconds }) });
      }
    }
    return answers;
  }

  /**
   * 窗口内作答（§32.6 answer）：记录该题；全部题落定 → 齐答提前结清。
   * @returns {'delivered'|'gone'} delivered=已进本批记录（批次在窗口内）；gone=批次/题不存在或已落定。
   */
  submitAnswer({ batchId, questionId, selected, custom }) {
    const batch = this.batches.get(batchId);
    if (batch === undefined || batch.phase !== 'open') return 'gone';
    const entry = batch.questions.get(questionId);
    if (entry === undefined || entry.state !== 'open') return 'gone';
    entry.state = 'answered';
    entry.selected = Array.isArray(selected) ? [...selected] : [];
    entry.custom = typeof custom === 'string' ? custom : undefined;
    if (this.#allDecided(batch)) this.#settleFull(batch);
    return 'delivered';
  }

  /** 窗口内忽略（§32.6 ignore）：该题记 ignored；齐答规则同上。 */
  submitIgnore({ batchId, questionId }) {
    const batch = this.batches.get(batchId);
    if (batch === undefined || batch.phase !== 'open') return 'gone';
    const entry = batch.questions.get(questionId);
    if (entry === undefined || entry.state !== 'open') return 'gone';
    entry.state = 'ignored';
    if (this.#allDecided(batch)) this.#settleFull(batch);
    return 'delivered';
  }

  /** 全部题 answered/ignored（齐答判据）。 */
  #allDecided(batch) {
    for (const entry of batch.questions.values()) {
      if (entry.state === 'open') return false;
    }
    return true;
  }

  /**
   * 注入时刻的文案语言（§32.1 取值时点条款）：**活读** agentLang——expired 批
   * TTL 24 h 内用户改语言，迟到注入跟随新档；读取抛错/缺席回退批次档（接管时
   * 快照），不因配置面故障丢注入。
   * @param {object} batch - 批次记录（含接管时定档的 lang）。
   * @returns {'zh'|'en'} 注入文案语言。
   */
  #langAtInjection(batch) {
    try {
      const snapshot = this.readSnapshot();
      if (snapshot?.agentLang === 'zh') return 'zh';
      if (snapshot?.agentLang === 'en') return 'en';
    } catch {
      // 活读失败回退批次档（见上）。
    }
    return batch.lang;
  }

  /** 活读当前 agentLang（补醒提醒用，无批次回退档）：读取失败回退 en（同款
   * 纪律——不因配置面故障丢投递）。 */
  #liveLang() {
    try {
      const snapshot = this.readSnapshot();
      if (snapshot?.agentLang === 'zh') return 'zh';
      if (snapshot?.agentLang === 'en') return 'en';
    } catch {
      // 见上：配置面故障不阻断补醒。
    }
    return 'en';
  }

  /**
   * 迟到作答/忽略注入（§32.5，通知形 + 按状态选通道，用户裁定）：
   * 到达即投递、插件不建队列——Agent 空闲（`agent.status === 'idle'`）且收件箱无
   * 未领取的本包通知 → `agent.followup()`（唤醒开回合，单条也立即）；其余（运行
   * 中，或空闲但自家 followup 尚未开跑——收件箱里有未领取的本包通知）→
   * `agent.inject()`（next-step，折入当前或即将开始回合的下一领取点；同窗口多条
   * 由宿主整批领取）。投递前**先发** `LATE_ANSWER_EVENT`（与投递解耦，
   * `async_wait_*` 的事件唤醒源；作答与忽略同形）。消息构造不变：自声明
   * `source.kind` + `form:'notice'` + `summary`（+ `questionId`——账本配对与唤醒
   * note 题号用），正文自含完整题面，文案语言按注入时刻活读。
   *
   * 任一通道同步抛错 → 审计 + 仍出列（agent 引用失效不可恢复），返回 'failed'
   * （§32.6 经 RPC 回执进界面 lostAnswers）；inject 路径另武装 `whenIdle` 空闲
   * 观察做末步竞态补醒（`#armSweep`）。
   *
   * kind ≠ `'user'`：插话判定（R12）对它不命中——迟到作答不是用户插话；
   * `async_wait_*` 对它有专属唤醒分支（R3 信号分类第四类，§32.5）。
   * @returns {'late'|'gone'|'failed'}
   */
  submitLate({ batchId, questionId, kind, selected, custom }) {
    const batch = this.batches.get(batchId);
    if (batch === undefined || batch.phase !== 'expired') return 'gone';
    const entry = batch.questions.get(questionId);
    if (entry === undefined || entry.state !== 'open') return 'gone';
    entry.state = kind === 'ignore' ? 'ignored' : 'answered';
    const lang = this.#langAtInjection(batch);
    const separator = lang === 'zh' ? '、' : ', ';
    const question = batch.request?.questions?.find((q) => q.id === questionId);
    const options = (question?.options ?? []).map((option) => String(option?.label ?? '')).join(separator);
    const multiSelect = question?.multiSelect === true ? 'true' : 'false';
    const delaySeconds = Math.max(0, Math.round((this.now() - batch.receivedAt) / 1000));
    const face = {
      qid: questionId,
      question: String(question?.question ?? ''),
      options,
      multiSelect,
      delay: delaySeconds
    };
    let summary;
    let text;
    if (kind === 'ignore') {
      summary = t(lang, 'ask.lateIgnoreSummary', { qid: questionId });
      text = t(lang, 'ask.lateIgnore', face);
    } else {
      const labels = (Array.isArray(selected) ? selected : []).join(separator);
      const suffix = typeof custom === 'string' && custom !== ''
        ? t(lang, 'ask.lateCustomSuffix', { custom })
        : '';
      const answer = labels + suffix;
      summary = t(lang, 'ask.lateSummary', { qid: questionId, answer: labels });
      text = t(lang, 'ask.lateAnswer', { ...face, answer });
    }
    const agent = batch.agent;
    // 通道选择（§32.5）：空闲 = `agent.status === 'idle'`（宿主 getter，dsh-schedule
    // 同款公共面）；"未开跑的本包投递" = 收件箱里有未领取的本包通知
    // （form:'notice'；reminder 催领条不算——它不是答案）。两处读取都在防护里：
    // status 抛错按运行中处理（错走 inject 只是多一道补醒，错走 followup 才会在
    // 运行中开新回合）；inbox 抛错按「有未领取」→ 走 inject——死 agent 的投递错
    // 自然落 'failed' 回执（§32.6 契约不旁路），活 agent 只是多一道补醒。
    let idle = false;
    try {
      idle = agent?.status === 'idle';
    } catch {
      idle = false;
    }
    let unclaimedOwn = 1;
    if (idle) {
      try {
        unclaimedOwn = unclaimedLateSources(agent).length;
      } catch {
        unclaimedOwn = 1;
      }
    }
    const viaFollowup = idle && unclaimedOwn === 0;
    // 事件先于投递（§32.5"到达即刻"）：等待中的 async_wait_* 由事件即时唤醒，
    // 不依赖投递通道的可见时序。
    this.emitEvent(LATE_ANSWER_EVENT, {
      agentId: batch.sessionId,
      questionId,
      kind: kind === 'ignore' ? 'ignore' : 'answer',
      summary
    });
    try {
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        // 通知形：自声明 kind + form/summary 配对，与子代理结算通知
        // 同形；kind 与 lib/interrupts.js 的判定字面同源（导入而非复写）。
        // questionId 进 source：待读登记配对与唤醒 note 题号共用一个字段。
        source: { kind: LATE_ANSWER_SOURCE, form: 'notice', summary, questionId }
      });
      if (viaFollowup) {
        agent.followup(message);
      } else {
        agent.inject(message);
        this.lateLedger.push({
          agentId: batch.sessionId,
          agent,
          batchId,
          questionId,
          question: face.question,
          summary
        });
        this.#armSweep(agent);
      }
    } catch (error) {
      audit(`late ${kind} ${viaFollowup ? 'followup' : 'inject'} failed for batch ${batchId}: ${String(error?.message ?? error)}`);
      this.#dropIfEmpty(batch);
      return 'failed';
    }
    this.#dropIfEmpty(batch);
    return 'late';
  }

  /**
   * 末步竞态防护（§32.5）：inject 落在回合最后一次领取之后 → 消息滞留
   * next-step，且不再有领取点。空闲观察（`agent.whenIdle()`，dsh-schedule 同款
   * 公共面）到达 idle 时若待读登记仍非空 → 补发一条**极小** followup 提醒
   * （`form:'reminder'`，不含作答正文、不重复投递）开回合——新回合首个领取点
   * 整批领走滞留件。每 agent 至多一个在途观察；补醒失败 → 滞留条目转
   * `lost` 名单（§32.6），不重试。
   * @param {object} agent - 目标 agent。
   */
  #armSweep(agent) {
    if (this.disposed) return;
    // whenIdle 是观察的前提（dsh-agent-loop 公共面，dsh-schedule 同款）；缺席的
    // agent 形态（异常宿主/旧测试替身）不武装——宁可滞留给下一批投递重新判定，
    // 不可把"无法观察"当成"已经空闲"立即补醒。
    if (typeof agent?.whenIdle !== 'function') return;
    if (this.sweeps.has(agent.id)) return;
    const token = {};
    this.sweeps.set(agent.id, token);
    const observe = async () => {
      try {
        if (typeof agent.whenIdle === 'function') await agent.whenIdle();
      } catch (error) {
        // 观察失败（agent 引用失效等）：放弃本观察；滞留件留待下一批投递重新武装。
        audit(`late-answer idle watch failed for agent ${String(agent.id)}: ${String(error?.message ?? error)}`);
        if (this.sweeps.get(agent.id) === token) this.sweeps.delete(agent.id);
        return;
      }
      if (this.sweeps.get(agent.id) !== token) return;
      this.sweeps.delete(agent.id);
      if (this.disposed) return;
      // 账本对账要读宿主 inbox getter——projection 注销等形态下**按设计抛错**
      // （dsh-agent-loop `current()` 的 inactive projection 分支）。observe 的后半段
      // 必须整体在防护里：读取失败按观察失败同款处置（audit + 放弃本观察，账本
      // 保留待下一批投递重新武装）——裸奔会让 `void observe()` 收到 reject，
      // unhandledRejection 会把整实例打掉。
      let pending;
      try {
        pending = this.#pendingLedger(agent);
      } catch (error) {
        audit(`late-answer ledger read failed for agent ${String(agent.id)}: ${String(error?.message ?? error)}`);
        return;
      }
      if (pending.length === 0) return;
      const lang = this.#liveLang();
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: t(lang, 'ask.lateReminder') }],
          // form:'reminder'：催领条，不是答案——`unclaimedLateSources` 对它不命中，
          // 不会被误读成又一条待读作答。
          source: {
            kind: LATE_ANSWER_SOURCE,
            form: 'reminder',
            summary: t(lang, 'ask.lateReminderSummary')
          }
        }));
        audit(`late-answer sweep reminder sent for agent ${String(agent.id)} (${String(pending.length)} stranded)`);
      } catch (error) {
        audit(`late-answer sweep reminder failed for agent ${String(agent.id)}: ${String(error?.message ?? error)}`);
        // 转账本 → lost（§32.6）：滞留件无领取点且补不进来，进界面报错名单。
        for (const item of pending) {
          const index = this.lateLedger.indexOf(item);
          if (index >= 0) this.lateLedger.splice(index, 1);
          this.#recordLost(item);
        }
      }
    };
    void observe();
  }

  /**
   * 待读登记的懒剪除读取：把账本条目与 agent 收件箱对账——还在收件箱里的
   * （未领取）返回，已被领取的（claim 后移出收件箱）从账本剪掉。
   * @param {object} agent - 目标 agent。
   * @returns {object[]} 仍未领取的账本条目。
   */
  #pendingLedger(agent) {
    const unclaimed = new Set(unclaimedLateSources(agent).map((source) => source.summary));
    const pending = [];
    for (let i = this.lateLedger.length - 1; i >= 0; i -= 1) {
      const item = this.lateLedger[i];
      if (item.agent !== agent && item.agentId !== agent.id) continue;
      if (unclaimed.has(item.summary)) {
        pending.push(item);
      } else {
        this.lateLedger.splice(i, 1);
      }
    }
    return pending;
  }

  /**
   * 会话级暂停（R36-a/-b）：置位 + 对该会话全部 `open` 批撤 `cancelTimer` 并记录
   * 剩余（`expiresAt` 冻结为暂停时刻值——客户端按 paused 标记不算倒计时）。
   * 已暂停批不重记剩余（二次 pause 保持首记值）。幂等：返回 'paused'。
   * @param {string} sessionId - 会话（agent）id。
   * @returns {'paused'} 结局（幂等面不报错）。
   */
  pause(sessionId) {
    this.paused.add(sessionId);
    for (const batch of this.batches.values()) {
      if (batch.sessionId !== sessionId || batch.phase !== 'open') continue;
      if (typeof batch.cancelTimer === 'function') {
        batch.cancelTimer();
        batch.cancelTimer = undefined;
        batch.remainingMs = Math.max(0, batch.expiresAt - this.now());
      }
      batch.paused = true;
    }
    return 'paused';
  }

  /**
   * 会话级恢复（R36-b）：清位 + 对该会话全部暂停批按**剩余**重挂 timer 并平移
   * `expiresAt`（= now + remaining 口径）。恢复时刻剩余 ≤ 0 → 立即到期
   * （防御闭合：不静默吞，也不在暂停名义下放行）。幂等：返回 'resumed'。
   * @param {string} sessionId - 会话（agent）id。
   * @returns {'resumed'} 结局。
   */
  resume(sessionId) {
    this.paused.delete(sessionId);
    for (const batch of this.batches.values()) {
      if (batch.sessionId !== sessionId || batch.paused !== true) continue;
      const remainingMs = typeof batch.remainingMs === 'number' ? batch.remainingMs : 0;
      batch.paused = false;
      if (this.#isSettled(batch) || batch.phase !== 'open') continue;
      if (remainingMs <= 0) {
        this.expire(batch);
        continue;
      }
      batch.expiresAt = this.now() + remainingMs;
      batch.cancelTimer = this.timer.timeout(() => this.expire(batch), remainingMs);
    }
    return 'resumed';
  }

  /**
   * 会话收尾清理（R36-d）：`agent/disposed` 尽力清暂停标志（web 会话常驻下
   * 不必然触发——残留由插件生命周期兜底）。
   * @param {string} sessionId - 会话（agent）id。
   */
  forgetSession(sessionId) {
    this.paused.delete(sessionId);
  }

  /** 竞态补醒失败 → lost 名单（复合键去重、上限 20，§32.6）。 */
  #recordLost(item) {
    const key = `${item.batchId}/${item.questionId}`;
    if (this.lost.some((lost) => `${lost.batchId}/${lost.questionId}` === key)) return;
    this.lost = [...this.lost.slice(-19), {
      batchId: item.batchId,
      questionId: item.questionId,
      question: item.question
    }];
  }

  /** 该题出列后整批题全落定则删记录（§32.5）。 */
  #dropIfEmpty(batch) {
    if (this.#allDecided(batch)) this.batches.delete(batch.batchId);
  }

  /** state() 的展平条目（§32.6；expired 批次保留供迟到作答）。`lost` 是竞态补醒
   * 失败名单（§32.6 lostAnswers 通道）——客户端轮询时并入面板报错列表。 */
  stateItems() {
    const serverNow = this.now();
    const items = [];
    for (const batch of this.batches.values()) {
      for (const [questionId, entry] of batch.questions) {
        if (entry.state !== 'open') continue;
        const question = batch.request?.questions?.find((q) => q.id === questionId);
        items.push({
          batchId: batch.batchId,
          sessionId: batch.sessionId,
          questionId,
          question: question?.question ?? '',
          options: question?.options ?? [],
          multiSelect: question?.multiSelect === true,
          receivedAt: batch.receivedAt,
          expiresAt: batch.expiresAt,
          phase: batch.phase,
          // R36：暂停标记——客户端冻结倒计时并示「已暂停」态（state 通道随行）。
          paused: batch.paused === true
        });
      }
    }
    return { serverNow, items, lost: [...this.lost] };
  }

  /**
   * 可逆卸载（§32.2）：对每个**未结批**调 `next()` 并以 `resolve(next())` 把原生链
   * 接管回来（原生卡片接管继续等人），清空注册表、停定时器、摘监听。已结批（超时
   * 已放行/齐答已回流）与 expired 批**不再交还**——cordis waterfall 的 `next` 是对
   * 可变回调表的无护栏闭包，晚调用会重入原生转发器，让浏览器弹出模型早已收到
   * 合成答案的幻影问题卡；expired 批的迟到作答窗口随卸载一并消失。
   * `next` 缺席的未结批（异常形态）按中止形状拒绝——不悬空。
   */
  disposeAll() {
    // 先撤观察/登记（§32.5）：卸载后不再补醒、不再报 lost——内存态随 fiber 消失
    // （§32.3 取舍与批次一致；agent 引用本就失效）。
    this.disposed = true;
    this.sweeps.clear();
    this.lateLedger = [];
    this.paused.clear(); // R36-d：插件卸载清空暂停集
    for (const batch of [...this.batches.values()]) {
      this.#teardown(batch);
      this.batches.delete(batch.batchId);
      if (this.#isSettled(batch)) continue;
      batch.settled = true;
      if (typeof batch.next === 'function') {
        try {
          batch.resolve(batch.next());
        } catch (error) {
          audit(`dispose hand-back failed for batch ${batch.batchId}: ${String(error?.message ?? error)}`);
          batch.reject(askAbortedError());
        }
      } else {
        batch.reject(askAbortedError());
      }
    }
  }
}

/**
 * typert remote 服务面（§32.6）。命名空间 `async-tools-ask`；三方法参数名即 wire 名
 * （`submission`），与客户端手写 descriptor 的 `wire:'submission'` 逐字一致（J-15 对账）。
 */
export class AskTakeoverService extends TypertRemoteService {
  /**
   * @param {object} ctx - 宿主行 Context（服务随 ctx 处置）。
   * @param {AskBatchRegistry} registry - 批次注册表（宿主行内存态）。
   */
  constructor(ctx, registry) {
    super(ctx, 'asyncToolsAsk', { namespace: 'async-tools-ask' });
    this.registry = registry;
    markRemote(this, ['state', 'answer', 'ignore', 'pause', 'resume']);
  }

  /** 待答状态（客户端 1000 ms 轮询）。 */
  async state() {
    return this.registry.stateItems();
  }

  /**
   * 会话级暂停（R36-c）：载荷 `{sessionId}`（与 answer/ignore 同形，参数名即
   * wire 名，J-15 对账口径）。幂等：已暂停再暂停返回 'paused'。
   */
  async pause(submission) {
    return { outcome: this.registry.pause(submission?.sessionId) };
  }

  /** 会话级恢复（R36-c）：载荷 `{sessionId}`；按剩余重挂并平移到期点。 */
  async resume(submission) {
    return { outcome: this.registry.resume(submission?.sessionId) };
  }

  /**
   * 作答：窗口内 → 进本批记录（可能触发齐答结清）；已超时 → 迟到注入。
   * 载荷**裸传**（客户端按 wire 名组装位置参数）。
   */
  async answer(submission) {
    const { batchId, questionId, selected, custom } = submission ?? {};
    const inWindow = this.registry.submitAnswer({ batchId, questionId, selected, custom });
    if (inWindow === 'delivered') return { outcome: 'delivered' };
    return { outcome: this.registry.submitLate({ batchId, questionId, kind: 'answer', selected, custom }) };
  }

  /** 忽略：窗口内 → windowSkip 进 answers；已超时 → 迟到注入「选择不答」。 */
  async ignore(submission) {
    const { batchId, questionId } = submission ?? {};
    const inWindow = this.registry.submitIgnore({ batchId, questionId });
    if (inWindow === 'delivered') return { outcome: 'delivered' };
    return { outcome: this.registry.submitLate({ batchId, questionId, kind: 'ignore' }) };
  }
}

/**
 * 手工挂 Remote 方法标记（plain JS 无 ES 装饰器语法，伪 context 路径）。
 * `mark` 写原型级版本化 descriptor：同名同形幂等早退，多实例安全。
 * @param {object} instance - 服务实例。
 * @param {string[]} methods - 方法名列表。
 */
function markRemote(instance, methods) {
  for (const name of methods) {
    Remote(function () {}, {
      name,
      private: false,
      static: false,
      addInitializer(fn) {
        fn.call(instance);
      }
    });
  }
}
