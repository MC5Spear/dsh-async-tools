/**
 * 提问接管的宿主半边（`docs/design.md` §4.1/§4.2/§4.3，需求 §4.4）。
 *
 * 三件事，全部纯依赖注入（services、timer、快照读、followup 都由调用方传入，单测直接喂替身）：
 *
 * 1. **四条件判定序**（设计 §4.1，条件号沿用设计的叙述序：①开关 ②预设 ③计划评审 ④根复验；
 *    代码里按「便宜的先查」排列，语义与设计逐条等价）：任一不满足 → 调 `next()` 交还原生链。
 * 2. **批次注册表与到期竞速**（设计 §4.1/§4.2）：接管即读活快照的 `askTimeoutMs` 武装
 *    到期回调；齐答提前结清（撤定时器 + 幂等护栏）；到期合成（`selected: []` + 超时
 *    说明 custom，不代答）；signal 中止按 ASK_ABORTED 形状拒绝（`ASK_ABORTED` 不被
 *    合成答案盖过）。到期回调走**统一入口**：先比 `now` 与 `expiresAt`，未到真实
 *    期限（延长后的旧回调排队、或单段上限截断）按剩余重挂下一段——单段时长封
 *    2^31-1（`setTimeout` 越界会被置 1ms 立即触发），延长累计不设上限。
 * 3. **迟到作答注入**（需求 §4.4，通知形 + 按状态选通道）：
 *    Agent 空闲且无未领取的本包通知 → `agent.followup()`（唤醒开回合，单条也
 *    立即）；其余（运行中，或空闲但自家 followup 尚未开跑）→ `agent.inject()`
 *    （next-step 折入下一领取点，同窗口多条由宿主整批领取——插件不建
 *    队列）。投递被宿主接受后才发 `LATE_ANSWER_EVENT`、登记待领账本并武装空闲
 *    观察（投递次序先于唤醒判定，设计 §4.4）；inject 落在回合最后一次领取
 *    之后 → `whenIdle` 空闲观察发现滞留 → 补一条极小 followup 提醒开回合顺走
 *    （需求 §4.4 末步竞态防护）。正文自含完整题目内容
 *    （id/题干/选项全集/multiSelect/作答或忽略/custom/时延）。
 *
 * `AskTakeoverService`（设计 §4.3）：typert remote 命名空间 `async-tools-ask` 的四方法
 * （state/answer/ignore/extend）。`@Remote` 是 ES 方法装饰器、plain JS 不可用语法，用导出的
 * `Remote` 函数 + 伪装饰器 context 手工挂标记（`addMarkerInitializer` → 官方
 * `mark()` 路径，原型级、幂等、多实例安全；只用公开 API）。
 *
 * 生命周期：由 `lib/host.js` 的运行时 inject 子作用域持有；卸载时 `disposeAll` 对每个
 * 未结批 `next()` 交还原生链（设计 §4.1 可逆卸载）。
 *
 * @module dsh-async-tools/lib/ask-takeover
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { LOG_PREFIX } from './config.js';
import { LATE_ANSWER_EVENT, LATE_ANSWER_SOURCE, unclaimedLateSources } from './interrupts.js';
import { TAKEOVER_PRESETS } from './descriptions.js';
import { escapeLogValue } from './output.js';
import { t } from './text.js';

/**
 * 调用主体是否属于本包两预设（需求 §6.3 防护作用域的运行时判定）。读取路径
 * 与 {@link shouldTakeover} 的预设判定同一条：`sessions.get(subjectId)` →
 * `stateOf(session, 'agentPreset')`。任一跳 undefined 或抛错一律 false
 * （失效安全方向＝不在范围）。
 * @param {object} services - `{sessions, sessionProjections}`（均可缺席）。
 * @param {unknown} subjectId - 主体 id（等待/接管的调用方传 agent id；作业的
 *   后台结算路径传 owner——SessionId 与 agent id 同一 id 空间）。
 * @returns {boolean} 主体是否在本包预设下。
 */
export function inOwnPreset(services, subjectId) {
  try {
    const session = services?.sessions?.get?.(subjectId);
    if (session === undefined || session === null) return false;
    return TAKEOVER_PRESETS.has(services?.sessionProjections?.stateOf?.(session, 'agentPreset'));
  } catch {
    return false;
  }
}

/**
 * expired 批的清扫阈值（需求 §4.4：保留期 24 小时）。清扫只随**新批次接管**
 * （take 入口）发生：expired 超过 24 小时的批在下一批进表前删除，防止超龄批
 * 在后续接管路径上无限累积。无新批接管时不清扫——批次可存活更久，
 * 迟到作答（submitLate）也不按本值拒收。
 */
const EXPIRED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 到期回调的单段时长上限（设计 §4.2）：2^31-1——宿主 timer 底层的 `setTimeout` 延迟
 * 越过它会被置 1ms 立即触发。延长可把 `expiresAt` 推出该值，武装按剩余分段：
 * 到期回调先比真实期限，未到就重挂下一段（`#armExpiry`）。
 */
const MAX_TIMER_SEGMENT = 2147483647;

/** `ASK_ABORTED` 的 plain-object 形状（`ask()` 的 `restoreUserQuestionError` 还原）。 */
function askAbortedError() {
  return {
    name: 'UserQuestionError',
    message: 'ask_user_question was aborted before the user answered',
    code: 'ASK_ABORTED'
  };
}

/** stderr 审计一行（操作者一侧，中文，不进面向模型的文案表）。整个 message
 * 经 escapeLogValue 单行化（设计 §6.3）：投递通道抛出的宿主错误对象可能携带
 * 多行文本，无论可控性归属，审计行本身保持单行。 */
function audit(message) {
  process.stderr.write(`${LOG_PREFIX} ask-takeover: ${escapeLogValue(message)}\n`);
}

/**
 * 接管判定（设计 §4.1 的条件体系，见下方 ①–⑤ 分步）。**全程同步**——`stateOf` 同步返回，判定期间不 await
 * 任何慢路径，抢先语义无窗口竞态。
 *
 * @param {object} request - waterfall 载荷 `{questions, agent?, signal?}`。
 * @param {object} services - `{sessions, sessionProjections, agents}`（均可缺席）。
 * @param {object} snapshot - 当前的生效配置快照（活读，不是构造快照——需求 §5.1）。
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
  // 保守按整批判——需求 §4.1 边界「不接管计划评审」）。
  if (questions.some((q) => q?.intent?.kind === 'plan-review')) return { takeover: false };
  // ④预设（投影路径）：sessions.get(agent.id) → stateOf(session,'agentPreset') 同步全等。
  // 任一跳 undefined/抛错 → next()（设计 §4.1：会话不存在/投影缺席都按「不是本包预设」交还）。
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
  // ⑤根复验（三态）：不在根表 → next()；在场但读取抛错 → next()（保守）；
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
 * 批次注册表与超时竞速（设计 §4.1）。一个宿主行 fiber 一个实例；全部状态在内存
 * （设计取舍：待答是运行时事实，不写持久层——重启后 agent 引用本就失效）。
 */
export class AskBatchRegistry {
  /**
   * @param {object} deps - 依赖注入。
   * @param {object} deps.timer - `ctx.timer`（`timeout(fn, ms)` 返回撤销函数）。
   * @param {Function} deps.readSnapshot - 读当前生效配置快照（活读）。
   * @param {Function} [deps.emit] - 本包事件发布侧（`(name, payload) => void`，宿主
   *   接线传 `(name, payload) => ctx.emit(name, payload)`；迟到作答唤醒事件
   *   `LATE_ANSWER_EVENT` 由此发出，仅在投递被宿主接受之后——需求 §4.4 投递
   *   次序先于唤醒判定）。缺席 = 静默（单测可不注入——唤醒侧退化但不影响投递）。
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
    /** 待读登记（需求 §4.4）：已投递未领取的作答/忽略条目；权威事实来源是 agent.inbox，
     * 账本只留复合键与题目内容（补醒失败转 lost 与界面报错用），懒剪除已领取项。 */
    this.lateLedger = [];
    /** 每 agent 至多一个在途的空闲观察（末步竞态补醒）。 */
    this.sweeps = new Map();
    /** 竞态补醒失败名单（复合键去重、上限 20，设计 §4.3 lostAnswers 通道）。 */
    this.lost = [];
    this.disposed = false;
  }

  /**
   * 接管一个请求（判定已过）。返回挂进 waterfall 的 Promise：齐答/超时解决
   * `{answers:[…]}`，中止拒绝 ASK_ABORTED 形状。
   *
   * `next` 是 waterfall 的下游交还函数：**可逆卸载**时未结批用它把原生链接管回来
   * （设计 §4.1）——机制是 `resolve(next())`：Promise 解决遇到 thenable 会收养它，
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
    // 超龄 expired 批清扫：仅在新批接管时执行（触发条件与阈值见 EXPIRED_TTL_MS），进表前一次 O(n)。
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
      /** 'open'（等待中）| 'expired'（已超时放行，留供迟到作答）。没有 'settled'
       *  值：批次终结要么整批出列删除，要么（有迟到作答价值的）转 'expired'
       *  留驻；是否已终结看独立布尔 `settled`（`#isSettled` 的判据）。 */
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
      // 入口中止（设计 §4.1）：接管时 signal 已中止 → 直接按 ASK_ABORTED 形状拒绝。
      if (request.signal?.aborted) {
        this.finishAbort(batch);
        return;
      }
      // 到期竞速（设计 §4.1/§4.2）：接管时刻武装；齐答提前结清在同一同步段撤销（防双结）。
      // 初始计时与延长共用同一武装函数（#armExpiry）——单段封 MAX_TIMER_SEGMENT，
      // 到期回调统一按 expiresAt 判真实期限。
      this.#armExpiry(batch);
    });
  }

  /** 批次是否已到不可再投递的终局：超时、齐答、中止都置 settled；超时且
   * 仍有未答题的批同置 phase='expired' 留供迟到作答（两标记同置，非两条
   * 独立入口）。迟到提交按此分路。 */
  #isSettled(batch) {
    return batch.settled || batch.phase === 'expired';
  }

  /** 撤当前到期定时器：延长重挂与结清共用。幂等——句柄撤后即清，重复调用
   * 无事发生；abort 监听不在此处管理（随批次生命周期整体存在）。 */
  #cancelTimer(batch) {
    if (typeof batch.cancelTimer === 'function') {
      batch.cancelTimer();
      batch.cancelTimer = undefined;
    }
  }

  /**
   * 武装到期回调（统一入口，设计 §4.2）：按 `expiresAt - now` 挂一段，单段封
   * `MAX_TIMER_SEGMENT`——剩余更长时由 `#onExpiry` 的真实期限复验续挂。
   * 撤旧挂新（延长后旧回调的排队时长已作废，不靠它承接）。
   */
  #armExpiry(batch) {
    this.#cancelTimer(batch);
    const segment = Math.max(0, batch.expiresAt - this.now());
    batch.cancelTimer = this.timer.timeout(
      () => this.#onExpiry(batch),
      Math.min(segment, MAX_TIMER_SEGMENT)
    );
  }

  /**
   * 到期回调（统一入口，设计 §4.2）：先比 `now` 与 `expiresAt`——未到真实期限
   * （延长后已撤回调的排队残余、或分段截断）就按剩余重挂下一段，**不提前放行**；
   * 到真实期限才走 expire。已结批直接返回（撤掉的回调不复活批次）。
   */
  #onExpiry(batch) {
    if (this.#isSettled(batch) || batch.phase !== 'open') return;
    if (this.now() < batch.expiresAt) {
      this.#armExpiry(batch);
      return;
    }
    this.expire(batch);
  }

  /** 摘 signal 监听与定时器（幂等）。 */
  #teardown(batch) {
    this.#cancelTimer(batch);
    if (batch.onAbort !== undefined) {
      batch.signalRef?.removeEventListener?.('abort', batch.onAbort);
      batch.onAbort = undefined;
    }
  }

  /** 中止路径：ASK_ABORTED 形状拒绝 + 出列（`ASK_ABORTED` 不得被合成答案盖过——需求 §4.1）。 */
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

  /** 按各题当前状态生成 answers（open 题只出现在超时路径）。
   * 秒数读 expiresAt−receivedAt：延长后放行的批含累计延长的窗口总量
   * （纯文案读数，窗口机械不受影响，设计 §4.2）。 */
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
   * 窗口内作答（设计 §4.3 answer）：记录该题；全部题落定 → 齐答提前结清。
   * @returns {'delivered'|'gone'} delivered=已进本批记录（批次在窗口内）；gone=批次/题不存在或已落定。
   */
  submitAnswer({ batchId, questionId, selected, custom }) {
    const batch = this.batches.get(batchId);
    if (batch === undefined || batch.phase !== 'open') return 'gone';
    const entry = batch.questions.get(questionId);
    if (entry === undefined || entry.state !== 'open') return 'gone';
    // 到期复查（需求 §4.3）：回调可能晚于服务端到期到达——按服务端钟已过期的
    // 批不得再记窗内作答。强制结清（幂等；open 题按超时口径入 answers，原调用
    // 只结算一次，与定时到期同形状），批次转 expired 留供迟到作答，本提交走
    // 迟到路径（返回 gone 由 RPC 包装层落 submitLate）。
    if (this.now() >= batch.expiresAt) {
      this.expire(batch);
      return 'gone';
    }
    entry.state = 'answered';
    entry.selected = Array.isArray(selected) ? [...selected] : [];
    entry.custom = typeof custom === 'string' ? custom : undefined;
    if (this.#allDecided(batch)) this.#settleFull(batch);
    return 'delivered';
  }

  /** 窗口内忽略（设计 §4.3 ignore）：该题记 ignored；齐答规则同上。 */
  submitIgnore({ batchId, questionId }) {
    const batch = this.batches.get(batchId);
    if (batch === undefined || batch.phase !== 'open') return 'gone';
    const entry = batch.questions.get(questionId);
    if (entry === undefined || entry.state !== 'open') return 'gone';
    // 到期复查：口径与 submitAnswer 相同（迟到到达的忽略同样不得记窗内）。
    if (this.now() >= batch.expiresAt) {
      this.expire(batch);
      return 'gone';
    }
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
   * 作答有效性校验（需求 §4.2.4，设计 §4.3）：按**原题**校验选择关系与有效性，
   * 在记录已答或分发到窗口内／迟到路径之前调用。不通过时服务层可见拒绝——
   * 不记已答、不投递。题已落定（他处已答/已忽略）不是可作答对象，交回主流
   * （gone 口径）；批次或题记录缺席（清扫/结清出列/交还）也交回主流，但服务层
   * 以 undelivered 字段区分（需求 §4.4：记录不在的提交必须显示未送达）。
   * @returns {'ok'|'gone'|'missing'|{reasonKey:string}} reasonKey 指向 text.js 的拒绝原因键。
   */
  validateAnswer({ batchId, questionId, selected, custom }) {
    const batch = this.batches.get(batchId);
    if (batch === undefined) return 'missing';
    // 已落定的题不是可作答对象：交回主流（gone 口径），不按内容拒绝。
    const entry = batch.questions.get(questionId);
    if (entry === undefined) return 'missing';
    if (entry.state !== 'open') return 'gone';
    const question = batch.request?.questions?.find((q) => q.id === questionId);
    if (question === undefined) return 'missing';
    const offered = new Set((Array.isArray(question.options) ? question.options : [])
      .map((option) => String(option?.label ?? '')));
    const picks = Array.isArray(selected) ? selected : [];
    if (picks.length > 0 && !picks.every((label) => typeof label === 'string' && offered.has(label))) {
      return { reasonKey: 'ask.rejectUnknownOption' };
    }
    const multi = question.multiSelect === true;
    if (!multi && picks.length > 1) {
      return { reasonKey: 'ask.rejectSingleMultiple' };
    }
    const hasCustom = custom !== undefined && custom !== null;
    if (hasCustom && (typeof custom !== 'string' || custom.trim() === '')) {
      return { reasonKey: 'ask.rejectBlankCustom' };
    }
    if (!multi && hasCustom && picks.length > 0) {
      return { reasonKey: 'ask.rejectSingleBoth' };
    }
    if (picks.length === 0 && !hasCustom) {
      return { reasonKey: 'ask.rejectNothing' };
    }
    return 'ok';
  }

  /**
   * 批次是否仍在册——作答/忽略提交的未送达判据（需求 §4.4）。已落定而批未
   * 出列的题不算缺席（那是普通 gone：他处已答，交回主流）。
   * @returns {boolean}
   */
  hasBatch(batchId) {
    return this.batches.has(batchId);
  }

  /**
   * 作答拒绝文案语言（需求 §4.2.4）：活读 agentLang，读取失败回退 en——与
   * 迟到投递同款纪律，配置侧故障不丢拒绝回执。
   * @returns {'zh'|'en'}
   */
  langForAnswerRejection() {
    try {
      const snapshot = this.readSnapshot();
      if (snapshot?.agentLang === 'zh') return 'zh';
      if (snapshot?.agentLang === 'en') return 'en';
    } catch {
      // 读取失败回退 en（见上）。
    }
    return 'en';
  }

  /**
   * 注入时刻的文案语言（需求 §5.3 取值时点）：**活读** agentLang——expired 批
   * 存续期间用户改语言，迟到注入跟随新档；读取抛错/缺席回退批次档（接管时
   * 快照），不因配置侧故障丢注入。
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
   * 纪律——不因配置侧故障丢投递）。 */
  #liveLang() {
    try {
      const snapshot = this.readSnapshot();
      if (snapshot?.agentLang === 'zh') return 'zh';
      if (snapshot?.agentLang === 'en') return 'en';
    } catch {
      // 见上：配置侧故障不阻断补醒。
    }
    return 'en';
  }

  /**
   * 迟到作答/忽略注入（需求 §4.4，通知形 + 按状态选通道）：
   * 到达即投递、插件不建队列——Agent 空闲（`agent.status === 'idle'`）且收件箱无
   * 未领取的本包通知 → `agent.followup()`（唤醒开回合，单条也立即）；其余（运行
   * 中，或空闲但自家 followup 尚未开跑——收件箱里有未领取的本包通知）→
   * `agent.inject()`（next-step，折入当前或即将开始回合的下一领取点；同窗口多条
   * 由宿主整批领取）。投递被宿主接受（调用正常返回）后才发 `LATE_ANSWER_EVENT`
   * （`async_wait_*` 的事件唤醒源；作答与忽略同形）——投递次序先于唤醒判定
   * （设计 §4.4）：宿主没收下的通知没有可领取消息，先发事件会把等待方唤醒成
   * 收件箱为空的「答案已到」。消息构造不变：自声明 `source.kind` +
   * `form:'notice'` + `summary`（+ `questionId`——账本配对与唤醒 note 题号用），
   * 正文自含完整题目内容，文案语言按注入时刻活读。
   *
   * 任一通道同步抛错 → 不制造到达事实（不发唤醒事件、不写待领账本、不武装
   * 观察），审计 + 仍出列（agent 引用失效不可恢复），返回 'failed'（设计 §4.3
   * 经 RPC 回执进界面 lostAnswers；等待中的 `async_wait_*` 不被迟到分支打断，
   * 按原预算继续）；inject 路径投递接受后登记待领账本并武装 `whenIdle` 空闲
   * 观察做末步竞态补醒（`#armSweep`）。
   *
   * kind ≠ `'user'`：插话判定对它不命中——迟到作答不是用户插话（需求 §2.1.2）；
   * `async_wait_*` 对它有专属唤醒分支（需求 §4.4）。
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
    // A10：选项行**含有效 description**——通知自含完整题目，不依赖旧工具调用记忆；
    // 标签相同或相似时，操作/风险说明是唯一区别，只拼 label 会丢掉真实差异。
    // description 随选项逐条内联（作答行仍引用 label——两行对照可还原映射）。
    const descSep = lang === 'zh' ? '：' : ': ';
    const options = (question?.options ?? []).map((option) => {
      const label = String(option?.label ?? '');
      const description = typeof option?.description === 'string' && option.description !== ''
        ? descSep + option.description
        : '';
      return label + description;
    }).join(separator);
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
      // 答案行（需求 §4.4）：已选预设项与自定义回答**并列**——自定义是独立答案
      // 条目，不是预设答案的附加说明；summary 与正文表达同一组实际答案。
      const parts = [];
      const labels = (Array.isArray(selected) ? selected : []).join(separator);
      if (labels !== '') parts.push(labels);
      if (typeof custom === 'string' && custom.trim() !== '') {
        parts.push(t(lang, 'ask.lateCustomAnswer', { custom }));
      }
      const answer = parts.join(lang === 'zh' ? '；' : '; ');
      summary = t(lang, 'ask.lateSummary', { qid: questionId, answer });
      text = t(lang, 'ask.lateAnswer', { ...face, answer });
    }
    const agent = batch.agent;
    // 通道选择（需求 §4.4）：空闲 = `agent.status === 'idle'`（宿主 getter，dsh-schedule
    // 同款公共接口）；"未开跑的本包投递" = 收件箱里有未领取的本包通知
    // （form:'notice'；reminder 催领条不算——它不是答案）。两处读取都在防护里：
    // status 抛错按运行中处理（错走 inject 只是多一道补醒，错走 followup 才会在
    // 运行中开新回合）；inbox 抛错按「有未领取」→ 走 inject——死 agent 的投递错
    // 自然落 'failed' 回执（设计 §4.3 契约不旁路），活 agent 只是多一道补醒。
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
    try {
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        // 通知形：自声明 kind + form/summary 配对，与子代理结算通知
        // 同形；kind 与 lib/interrupts.js 的判定字面同源（导入而非复写）。
        // questionId 进 source：待读登记配对与唤醒 note 题号共用一个字段。
        source: { kind: LATE_ANSWER_SOURCE, form: 'notice', summary, questionId }
      });
      // 投递次序先于唤醒判定（设计 §4.4）：通知先交给宿主通道（followup 或
      // inject，按上面的状态规则选），调用正常返回＝宿主已接受；抛错＝宿主
      // 没收下——此刻不存在可领取消息，任何到达事实都不得制造。
      if (viaFollowup) {
        agent.followup(message);
      } else {
        agent.inject(message);
      }
    } catch (error) {
      // 一致性说明：不发唤醒事件、不写账本、不武装观察——先发事件会把等待中
      // 的 async_wait_* 唤醒成「答案已到」，而宿主收件箱里没有可领取的消息。
      // 审计 + 仍出列 + failed 回执走既有路径（agent 引用失效不可恢复，界面
      // lostAnswers 可见；等待方按原预算继续，到期照常交回）。
      audit(`late ${kind} ${viaFollowup ? 'followup' : 'inject'} failed for batch ${batchId}: ${String(error?.message ?? error)}`);
      this.#dropIfEmpty(batch);
      return 'failed';
    }
    // 投递已被宿主接受，到达事实自此成立：先登记（待领账本 + 空闲观察，仅
    // inject 件需要——followup 自开回合即领取，无滞留可观察），后发唤醒事件
    // ——事件的等待方读宿主收件箱，登记先于广播保持事实与信号同序。
    if (!viaFollowup) {
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
    this.emitEvent(LATE_ANSWER_EVENT, {
      agentId: batch.sessionId,
      questionId,
      kind: kind === 'ignore' ? 'ignore' : 'answer',
      summary
    });
    this.#dropIfEmpty(batch);
    return 'late';
  }

  /**
   * 末步竞态防护（需求 §4.4）：inject 落在回合最后一次领取之后 → 消息滞留
   * next-step，且不再有领取点。空闲观察（`agent.whenIdle()`，dsh-schedule 同款
   * 公共接口）到达 idle 时若待读登记仍非空 → 补发一条**极小** followup 提醒
   * （`form:'reminder'`，不含作答正文、不重复投递）开回合——新回合首个领取点
   * 整批领走滞留件。每 agent 至多一个在途观察；补醒失败 → 滞留条目转
   * `lost` 名单（设计 §4.3），不重试。
   * @param {object} agent - 目标 agent。
   */
  #armSweep(agent) {
    if (this.disposed) return;
    // whenIdle 是观察的前提（dsh-agent-loop 公共接口，dsh-schedule 同款）；缺席的
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
        // 转账本 → lost（设计 §4.3）：滞留件无领取点且补不进来，进界面报错名单。
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
   * 组级延长（需求 §4.3）：作用于该会话**当下在窗且未到期**的全部批次——原截止时间
   * 上加本次时长（**点击时刻**活读快照的 `askExtendMs`），重挂到期回调（旧回调
   * 的排队时长作废）。已到期批不复活（`phase !== 'open'` 或 `now ≥ expiresAt`
   * 的都不动——延长只作用于未到期批次）；跨组隔离（组键 = sessionId）。
   * **累加语义**：每次点击都会再延长一段（不是幂等——连点 N 次就加 N 段）；
   * 客户端的失败重试提示因此要求先看刷新后的剩余时间再决定是否再点。
   * 无在窗批 → 0，也是成功。
   * @param {string} sessionId - 会话（agent）id——组键。
   * @returns {number} 本次实际延长的批次数。
   */
  extend(sessionId) {
    const snapshot = this.readSnapshot() ?? {};
    const extendMs = typeof snapshot.askExtendMs === 'number' && Number.isFinite(snapshot.askExtendMs)
      && snapshot.askExtendMs > 0 ? snapshot.askExtendMs : 60000;
    const now = this.now();
    let extended = 0;
    for (const batch of this.batches.values()) {
      if (batch.sessionId !== sessionId || batch.phase !== 'open') continue;
      if (this.#isSettled(batch) || now >= batch.expiresAt) continue;
      batch.expiresAt += extendMs;
      this.#armExpiry(batch);
      extended += 1;
    }
    return extended;
  }

  /** 竞态补醒失败 → lost 名单（复合键去重、上限 20，设计 §4.3）。`sessionId`
   * 供界面给出「打开所属会话直接回复」的恢复入口（需求 §4.4 失败提示的可行
   * 下一步）。 */
  #recordLost(item) {
    const key = `${item.batchId}/${item.questionId}`;
    if (this.lost.some((lost) => `${lost.batchId}/${lost.questionId}` === key)) return;
    this.lost = [...this.lost.slice(-19), {
      batchId: item.batchId,
      questionId: item.questionId,
      question: item.question,
      sessionId: item.agentId
    }];
  }

  /** 该题出列后整批题全落定则删记录（需求 §4.4）。 */
  #dropIfEmpty(batch) {
    if (this.#allDecided(batch)) this.batches.delete(batch.batchId);
  }

  /** state() 的展平条目（设计 §4.3；expired 批次保留供迟到作答）。`lost` 是竞态补醒
   * 失败名单（设计 §4.3 lostAnswers 通道）——客户端轮询时并入面板报错列表。 */
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
          phase: batch.phase
        });
      }
    }
    return { serverNow, items, lost: [...this.lost] };
  }

  /**
   * 可逆卸载（设计 §4.1）：对每个**未结批**调 `next()` 并以 `resolve(next())` 把原生链
   * 接管回来（原生卡片接管继续等人），清空注册表、停定时器、摘监听。已结批（超时
   * 已放行/齐答已回流）与 expired 批**不再交还**——cordis waterfall 的 `next` 是对
   * 可变回调表的无护栏闭包，晚调用会重入原生转发器，让浏览器弹出模型早已收到
   * 合成答案的幻影问题卡；expired 批的迟到作答窗口随卸载一并消失。
   * `next` 缺席的未结批（异常形态）按中止形状拒绝——不悬空。
   */
  disposeAll() {
    // 先撤观察/登记（需求 §4.4）：卸载后不再补醒、不再报 lost——内存态随 fiber 消失
    // （设计 §4.1 取舍与批次一致；agent 引用本就失效）。
    this.disposed = true;
    this.sweeps.clear();
    this.lateLedger = [];
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
 * typert remote 服务侧（设计 §4.3）。命名空间 `async-tools-ask`；四方法参数名即 wire 名
 * （`submission`），与客户端手写 descriptor 的 `wire:'submission'` 逐字一致（对账锚点）。
 */
export class AskTakeoverService extends TypertRemoteService {
  /**
   * @param {object} ctx - 宿主行 Context（服务随 ctx 处置）。
   * @param {AskBatchRegistry} registry - 批次注册表（宿主行内存态）。
   */
  constructor(ctx, registry) {
    super(ctx, 'asyncToolsAsk', { namespace: 'async-tools-ask' });
    this.registry = registry;
    markRemote(this, ['state', 'answer', 'ignore', 'extend']);
  }

  /** 待答状态（客户端 1000 ms 轮询）。 */
  async state() {
    return this.registry.stateItems();
  }

  /** 组级延长（需求 §4.3）：载荷 `{sessionId}`（与 answer/ignore 同形，参数名即 wire 名，
    * 对账口径；sessionId 是组键——一次作用于该组当下在窗的批次）。
    * 无在窗批返回 `{extended: 0}`，也是成功。 */
  async extend(submission) {
    return { extended: this.registry.extend(submission?.sessionId) };
  }

  /**
   * 作答：窗口内 → 进本批记录（可能触发齐答结清）；已超时 → 迟到注入。
   * 载荷**裸传**（客户端按 wire 名组装位置参数）。
   * 先按原题校验选择关系与有效性（需求 §4.2.4）：非法作答**可见拒绝**——抛错
   * 走 RPC 错误回执（客户端 'answerRejected' 横幅，明确拒绝≠未收到确认），
   * 不记已答、不投递。
   * gone 两口径（需求 §4.4）：题已在他处落定 → 普通回执 `{outcome:'gone'}`，
   * 客户端交轮询收敛；批次/题记录缺席 → 回执附 `undelivered:true`，客户端
   * 显示未送达——outcome 枚举不变（四值契约），只加可选区分字段。
   */
  async answer(submission) {
    const { batchId, questionId, selected, custom } = submission ?? {};
    const check = this.registry.validateAnswer({ batchId, questionId, selected, custom });
    if (check !== 'ok' && check !== 'gone' && check !== 'missing') {
      const lang = this.registry.langForAnswerRejection();
      throw new Error(t(lang, 'ask.answerRejectedError', { reason: t(lang, check.reasonKey) }));
    }
    if (check === 'missing') {
      // 记录缺席：两路分发对缺席批次同样返回 gone，直接判未送达（不投递、不记名）。
      return { outcome: 'gone', undelivered: true };
    }
    const inWindow = this.registry.submitAnswer({ batchId, questionId, selected, custom });
    if (inWindow === 'delivered') return { outcome: 'delivered' };
    return { outcome: this.registry.submitLate({ batchId, questionId, kind: 'answer', selected, custom }) };
  }

  /**
   * 忽略：窗口内 → windowSkip 进 answers；已超时 → 迟到注入「选择不答」。
   * 记录缺席与作答同口径（需求 §4.4）：忽略提交也返回 undelivered 区分字段。
   */
  async ignore(submission) {
    const { batchId, questionId } = submission ?? {};
    if (!this.registry.hasBatch(batchId)) {
      return { outcome: 'gone', undelivered: true };
    }
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
