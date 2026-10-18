/**
 * 共用部件：等待期间的可打断信号（设计 §2.2）。
 *
 * 强制约束（需求 §2.1.2 与设计 §2.2）：
 * - 唤醒判定的来源命中集：`source.kind === 'user'`（用户插话）、`source.form ===
 *   'notice'`（一次性通知，含其他子代理的结算通知）、`source.form === 'relay'`
 *   （代理转达，如 agent-message）。结算通知与转达消息的 `role` 也是 `user`，
 *   用 role 判定会被自己的通知反复打断；`form` 为 instructions、catalog、snapshot、
 *   recall 或无 form 的上下文消息不命中，进度事件、目录与配置快照不因角色为
 *   user 就命中。
 * - **只有插话（steer，落 `next-step`、步骤边界投递）与同列表的可处理消息才唤醒**。
 *   排队（queue，落 `next-turn`、轮次边界投递）的消息**不唤醒**——它在本轮内到不了
 *   模型手里，唤醒只会产生一个"看得见通知、看不见内容"的悬空回合（需求 §2.1.2）；goal
 *   轮次驱动经 followup 投递也落 `next-turn`，同样不唤醒。
 * - `subagent-settled` 是**权威结束信号**；`agent-message` 只是"有进展"的唤醒信号。
 * - 本包的迟到作答通知（自声明 kind，需求 §4.4）走**专门唤醒分支**：通用判定对它
 *   不重复命中（同一消息不产生两个竞争说明）。载体是**插件事件 + 起始检查**
 *   （与投递解耦）：事件 `LATE_ANSWER_EVENT`（`LATE_ANSWER_SOURCE`
 *   派生）+ 等待开始时扫 inbox 待读登记（`unclaimedLateSources`），不监听
 *   `agent/inbox/inserted`。
 * - 每个订阅都必须返回 disposer，并由调用方在 `finally` 中处置（需求 §2.2.2 资源释放）。
 *
 * @module dsh-async-tools/interrupts
 */

/** 用户消息的来源种类（唯一字面；全部插话判定共用）。 */
export const USER_MESSAGE_SOURCE = 'user';

/** 迟到作答通知的来源种类（本包自声明，需求 §4.4 通知形）。与 `'user'` 互斥：插话
 * 判定对它**不命中**（迟到作答不是用户插话，需求 §2.1.2）；`async_wait_*` 对它有专属
 * 唤醒分支（提前返回运行句柄）。命名与宿主 kebab 先例一致
 * （subagent-settled / cordis-host-runner：属主前缀 + 语义段）。 */
export const LATE_ANSWER_SOURCE = 'async-tools-late-answer';

/** 迟到作答到达的本包事件名（需求 §4.4 唤醒载体：与投递解耦）。
 * 由 `LATE_ANSWER_SOURCE` **机械派生**（`<source>/arrived`，斜杠风格与宿主事件
 * `agent/inbox/inserted`），ask-takeover 发布侧与 wait-* 订阅侧同源导入本常量。
 * 载荷：`{agentId, questionId, kind: 'answer'|'ignore', summary}`（作答与忽略同形）。
 * 注意本事件不在 dsh-scope 的 scoped-event 清单里——普通 cordis 频道事件，
 * `ctx.emit` 对全部 `ctx.on` 监听器可达，无需 scope carrier。 */
export const LATE_ANSWER_EVENT = `${LATE_ANSWER_SOURCE}/arrived`;

/** 子代理结算通知的来源种类。 */
const SETTLED = 'subagent-settled';

/** 子代理运行中转达消息的来源种类。 */
const RELAY = 'agent-message';

import { t } from './text.js';

/** 唤醒命中的 `source.form` 值（设计 §2.2 规则 3）：一次性通知与代理转达。 */
const WAKE_FORMS = new Set(['notice', 'relay']);

/** 不参与唤醒的上下文 `source.form` 值（设计 §2.2 规则 3 排除项）——即便 kind 是
 *  user 也不命中（目录与配置快照不因角色为 user 就唤醒）。 */
const CONTEXT_FORMS = new Set(['instructions', 'catalog', 'snapshot', 'recall']);

/**
 * 单条消息是否命中唤醒判定（设计 §2.2 规则 3 的单一事实源）：
 * - 本包迟到作答通知先排除（专门分支供应，通用判定不重复命中）；
 * - 上下文 form（instructions/catalog/snapshot/recall）不命中；
 * - `source.kind === 'user'` 命中（用户插话）；
 * - `source.form === 'notice' | 'relay'` 命中。
 * 事件判定、入口扫描与先到扫描三方共用本函数，不走各自的复写。
 * @param {object} message - inbox 消息。
 * @returns {boolean} 是否唤醒。
 */
export function wakesWait(message) {
  const source = message?.source;
  if (source?.kind === LATE_ANSWER_SOURCE) return false;
  const form = source?.form;
  if (form !== undefined && CONTEXT_FORMS.has(form)) return false;
  if (source?.kind === USER_MESSAGE_SOURCE) return true;
  return form === 'notice' || form === 'relay';
}

/**
 * 把命中唤醒的消息归类成信号载荷（`watchWakeSignal` 的 resolve 形状）。
 *
 * `summary` 的空档回退：转达（relay）／通知（notice）类消息可能不带
 * `summary`——空串会让等待文案长成 "A processable message arrived ()"
 * （括号空置）。这里按消息形态给出最小描述（en/zh 随 `lang`，需求 §2.1.3
 * 结束原因清楚可见）；**user 插话不回退**——它的 summary 不进任何渲染模板，
 * 维持空串（既有契约）。
 * @param {object} message - 命中 `wakesWait` 的 inbox 消息。
 * @param {string} [lang='en'] - 模型侧语言（回退文案取词用）。
 * @returns {{kind: string, via: string, messageId: unknown, summary: string}|null}
 *   未命中返回 null；命中时 `via` 为 `'user' | 'notice' | 'relay'`。
 */
export function classifyWake(message, lang = 'en') {
  if (!wakesWait(message)) return null;
  const source = message.source;
  const via = source.kind === USER_MESSAGE_SOURCE ? 'user' : source.form;
  const raw = typeof source.summary === 'string' ? source.summary.trim() : '';
  return {
    kind: 'wake',
    via,
    messageId: message.id,
    summary: raw.length > 0 || via === 'user' ? raw : t(lang, 'wake.noSummaryFallback')
  };
}

/** 从消息内容里取出纯文本。 */
function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .map((block) => (block?.type === 'text' ? String(block.text ?? '') : ''))
    .join(' ');
}

/**
 * 该插入是否属于指定 agent。
 * @param {object} payload - `agent/inbox/inserted` 的 payload。
 * @param {object} agent - 等待方 agent。
 * @returns {boolean} 是否相关。
 */
function forAgent(payload, agent) {
  if (agent?.id === undefined) return true;
  return payload?.agent?.id === agent.id;
}

/**
 * 判定一条已插入的用户消息是否是**插话**（此刻在 `next-step` 列表里）。
 *
 * `agent/inbox/inserted` 的 payload 不带目标列表，queue 与 steer 两种落点
 * 都会触发它；唯一可靠的区分法是按 `message.id` 回查 `agent.inbox.nextStep`
 * （`Inbox` 公共接口）。回查无竞态：插入事件在投影折叠**之后**同步发出，而领取
 * （claim）只发生在步骤边界的 `preStep`，等待工具执行又在 step 内部、单 agent
 * 驱动串行——事件到达监听器时，消息必然还在它被插入的那个列表里。
 *
 * inbox 不可读时按"不是插话"处理：**宁可多等（预算仍有界），不可错打断**
 * （错打断会把一条模型看不见的排队消息报告成"已送达"）。
 *
 * 本函数在**事件监听器内**同步执行（`ctx.emit` 同步分发且不捕获监听异常，
 * cordis `emit` 的分发循环把监听器异常直接抛回派发方）：`inbox` getter 或
 * `nextStep` 列表 getter 抛错若不就地接住，会穿透进宿主的事件投递路径
 * （需求 §2.1.2 读失败按未命中处理；§6.2 监听器异常不出插件边界）——
 * 读与判整体包在保守 try 里，抛错一律按"不是插话"（需求 §2.1.2 的读失败口径）。
 *
 * @param {object} agent - 等待方 agent（`exec.agent`，完整 Agent 句柄）。
 * @param {string} messageId - 被插入消息的 id。
 * @returns {boolean} 是否插话。
 */
function isSteering(agent, messageId) {
  try {
    const nextStep = agent?.inbox?.nextStep;
    if (!Array.isArray(nextStep)) return false;
    return nextStep.some((message) => message?.id === messageId);
  } catch {
    // inbox getter / nextStep 列表 getter 抛错按"不是插话"——宁可多等，
    // 不可错打断；异常不得穿透监听器边界（需求 §2.1.2/§6.2）。
    return false;
  }
}

/**
 * 订阅"可处理消息到达"（设计 §2.2 唤醒判定的信号侧；用户插话是其中 via='user' 的一类）。
 * resolve 携带 `{kind:'wake', via, messageId, summary}`——调用方按 `via` 分流：
 * user 走 interrupted 口径，notice/relay 走运行句柄＋唤醒原因口径（不替宿主
 * 消费通知正文）。
 *
 * 订阅在 Promise 构造器**外**建立（设计 §2.1 初始化失败＝可控错误）：`ctx.on`
 * 同步抛错时本函数同步抛出，由调用方接线段撤销前序资源后上抛；signal promise
 * 只 resolve、永不 reject——不存在"构造器内抛错变成无人承接的拒绝"的路径，
 * 提前返回后也无需再挂承接 catch。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} agent - 等待方 agent。
 * @param {string} [lang='en'] - 模型侧语言（唤醒摘要空档的回退文案取词用）。
 * @returns {{ promise: Promise<object>, dispose: () => void }} 信号与处置器。
 */
export function watchWakeSignal(ctx, agent, lang = 'en') {
  let notify = () => {};
  const promise = new Promise((resolve) => { notify = resolve; });
  let done = false;
  const dispose = ctx.on('agent/inbox/inserted', (payload) => {
    if (done) return;
    if (!forAgent(payload, agent)) return;
    const wake = classifyWake(payload?.message, lang);
    if (wake === null) return;
    if (!isSteering(agent, wake.messageId)) return;
    done = true;
    notify(wake);
  });
  return { promise, dispose: () => dispose() };
}

/**
 * 扫描等待入口的**先到可处理消息**（设计 §2.2 入口扫描；与 `watchWakeSignal` 的
 * 事件判定同源——同函数（`wakesWait`）、同列表（`nextStep`）、同保守方向）。
 *
 * 事件侧按 `message.id` 回查一条消息，本函数按列表扫任何一条——同一判定的
 * 两个读法；调用方**先订阅、后扫描**（设计 §2.2：避免订阅空窗）。user 插话优先于
 * notice/relay：同列并存时按插话口径交回（先到消息同样有效，需求 §4.4）。inbox 缺席、
 * inbox getter 或 `nextStep` 列表 getter 抛错都按"无先到消息"（宁可多等，
 * 不可错唤醒，与 `isSteering` 同向；读与扫整体在保守 `try` 里）。无订阅、
 * 无定时器、无副作用；每个等待入口在订阅之后调用一次。
 *
 * @param {object} agent - 等待方 agent（`agent.inbox.nextStep`，宿主公共接口）。
 * @returns {object|null} 第一条命中的消息（user 类优先）；无则 `null`。
 */
export function preexistingWakeMessage(agent) {
  try {
    const nextStep = agent?.inbox?.nextStep;
    if (!Array.isArray(nextStep)) return null;
    const isUser = (message) => wakesWait(message) && message?.source?.kind === USER_MESSAGE_SOURCE;
    return nextStep.find(isUser) ?? nextStep.find((message) => wakesWait(message)) ?? null;
  } catch {
    // inbox getter 与 nextStep 列表 getter 任一抛错都按"无先到消息"——
    // 宁可多等，不可错唤醒（读与扫整体在保守 try 里）。
    return null;
  }
}

/**
 * 扫描收件箱里**未领取**的权威结算通知（「完成优先于打断」的入口证据，
 * 设计 §2.2）。
 *
 * 只认强证据形态：`source.kind === 'subagent-settled'` 且
 * `source.senderSessionId` 精确等于 agentId（证据分级：senderSessionId
 * 命中是权威信号；正文回退是弱证据，只在等待收敛后的复查里用，不在入口/预检
 * 做——无该字段一律不命中）。
 * `nextStep` 与 `nextTurn` 两个列表都扫（与 `unclaimedLateSources` 同口径：
 * 宿主两个待处理列表就是"已投递未领取"的权威账本）。inbox 缺席、inbox
 * getter 或任一列表 getter 抛错都按"无结算通知"（不升格，按插话打断返回；
 * 读与扫整体在保守 `try` 里，读失败按未命中，需求 §2.1.2）。
 *
 * 调用点（`wait-agent.js`，**都排在插话判定之前**——"结束优先于打断"的顺序
 * 就是调用顺序）：① 起始检查第一拍（订阅之后、`classifyWake` 之前）；② 存在
 * 屏障每轮竞速前的同步预检 `pendingSignal`；③ 屏障切断出口 barrierExit 内
 * （含 not_found 出口前的最后复核）。无订阅、
 * 无定时器、无副作用。
 *
 * @param {object} agent - 等待方 agent。
 * @param {string} agentId - 被等待的子代理 id。
 * @returns {object|null} 第一条命中的消息；无则 `null`。
 */
export function unclaimedSettlement(agent, agentId) {
  try {
    const inbox = agent?.inbox;
    const lists = [inbox?.nextStep, inbox?.nextTurn];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const message of list) {
        const source = message?.source;
        if (source?.kind !== SETTLED) continue;
        if (source.senderSessionId !== agentId) continue;
        return message;
      }
    }
    return null;
  } catch {
    // inbox getter 与任一列表 getter（nextStep/nextTurn）抛错都按
    // "无结算通知"（不升格，按插话打断返回）。
    return null;
  }
}

/**
 * 扫描 agent 收件箱里**已投递未领取**的本包迟到作答通知（需求 §4.4「待读登记」的
 * 权威事实来源读取侧——宿主 next-step/next-turn 两个待处理列表就是"已投递未领取"
 * 的权威账本：领取（claim）会把消息从列表里移走，`agent/inbox/claimed` 之后
 * 扫描自然不再命中，无需自建清理信号）。
 *
 * 只认 `source.kind === LATE_ANSWER_SOURCE && source.form === 'notice'`（作答与
 * 忽略同形）；`form:'reminder'` 的竞态补醒提醒**不算**——它是催领条，不是答案。
 * inbox 完全缺席按空；getter 读取抛错**向上抛**（保守方向见函数内注释）。
 *
 * @param {object} agent - 等待方 agent（`agent.inbox.nextStep/nextTurn`，宿主公共接口）。
 * @returns {{questionId: string|undefined, summary: string}[]} 未领取的通知 source 投影。
 */
export function unclaimedLateSources(agent) {
  const found = [];
  // inbox 完全缺席（形态异常的宿主/旧替身）按空；getter **读取抛错向上抛**——
  // 两类调用方的保守方向不同，各自在调用点处置：投递侧
  // （ask-takeover 通道选择/账本对账）按「有未领取」→ 走 inject（死 agent 的
  // 投递错落 'failed' 回执）；等待侧（watchLateAnswer 起始检查）按空（宁可多等
  // 一轮，不可把信号 promise 变 reject）。
  const inbox = agent?.inbox;
  const lists = [inbox?.nextStep, inbox?.nextTurn];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const message of list) {
      const source = message?.source;
      if (source?.kind !== LATE_ANSWER_SOURCE) continue;
      if (source.form !== 'notice') continue;
      found.push({
        questionId: typeof source.questionId === 'string' ? source.questionId : undefined,
        summary: typeof source.summary === 'string' ? source.summary : ''
      });
    }
  }
  return found;
}

/**
 * 订阅"迟到作答到达"（需求 §4.4 唤醒分支的信号源；
 * **插件事件 + 起始检查，与投递解耦**）。
 *
 * 两个命中途径：
 * 1. **插件事件**：ask-takeover 宿主半边在作答/忽略到达即刻发 `LATE_ANSWER_EVENT`
 *    （作答与忽略同形）——本订阅过滤 `agentId` 与等待方一致的载荷。
 * 2. **起始检查**：等待开始时先查一次待读登记（`unclaimedLateSources` 扫
 *    `agent.inbox`）——命中任一即**同步**提前返回，堵住"作答先到、等待后开"
 *    的空窗（已排队的作答必须能唤醒后开的等待，否则干等至预算耗尽）。
 *
 * resolve 携带 `summary`（含题号——唤醒 note 据此指明"哪题已答"）与 `qid`。
 * 与插话订阅完全不同源（事件名不同），四类信号互斥由构造保证（专门单测钉住）。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} agent - 等待方 agent（作答通知发给谁，谁就是等待方）。
 * @returns {{ promise: Promise<{kind: string, summary: string, qid: string|undefined}>, dispose: () => void }} 信号与处置器。
 */
export function watchLateAnswer(ctx, agent) {
  let notify = () => {};
  const promise = new Promise((resolve) => { notify = resolve; });
  let done = false;
  const hit = (payload) => {
    if (done) return;
    done = true;
    notify({
      kind: 'late-answer',
      summary: typeof payload?.summary === 'string' ? payload.summary : '',
      qid: typeof payload?.questionId === 'string' ? payload.questionId : undefined
    });
  };
  // 订阅在 Promise 构造器外建立（与 `watchWakeSignal` 同款纪律，设计 §2.1）：
  // `ctx.on` 同步抛错时本函数同步抛出，signal promise 永不 reject。
  const dispose = ctx.on(LATE_ANSWER_EVENT, (payload) => {
    if (agent?.id !== undefined && payload?.agentId !== agent.id) return;
    hit(payload);
  });
  // 起始检查（需求 §4.4）：等待开始时登记已非空 → 同步命中（作答先到、等待后开）。
  // inbox getter 抛错（projection 注销等设计内错误）按空——抛错穿透会把本函数
  // 同步打断；宁可多等一轮（事件侧仍然在听），不可错唤醒。
  let unclaimed = [];
  try {
    unclaimed = unclaimedLateSources(agent);
  } catch {
    unclaimed = [];
  }
  if (unclaimed.length > 0) hit({ summary: unclaimed[0].summary, questionId: unclaimed[0].questionId });
  return { promise, dispose: () => dispose() };
}

/**
 * 订阅子代理活动。三个独立通道（按可靠性排序）：
 *
 * 1. **结算通知**（权威）：`source.kind === "subagent-settled"`，用
 *    `source.senderSessionId` 精确关联到目标子代理。
 * 2. **状态转换**（屏障/提前返回）：`agent/status` 的 `idle`——**父代理 scope 能收到
 *    其子代理的这条事件**（机制依据：design §1.3）。它比列表快照可靠
 *    得多（`listChildren()` 的目录条目
 *    没有 `activity` 字段），但语义是"这一轮驱动结束"，不是"已结算"，
 *    因此只作为提前返回信号，`detail` 里注明来源。
 * 3. **转达消息**（唤醒）：`source.kind === "agent-message"`，只用来提前重查状态，
 *    不是结束信号。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} agent - 等待方 agent（父代理）。
 * @param {string} agentId - 被等待的子代理 id。
 * @returns {{ settled: Promise<object>, activity: Promise<object>, dispose: () => void }} 两个信号与处置器。
 */
export function watchSubagentActivity(ctx, agent, agentId) {
  let settleSignal;
  let activitySignal;
  const settled = new Promise((resolve) => { settleSignal = resolve; });
  const activity = new Promise((resolve) => { activitySignal = resolve; });

  let settledDone = false;
  let activityDone = false;

  const disposeInbox = ctx.on('agent/inbox/inserted', (payload) => {
    if (!forAgent(payload, agent)) return;
    const source = payload?.message?.source;
    const kind = source?.kind;

    if (kind === SETTLED && !settledDone) {
      // 精确关联：结算通知在 source 上带 senderSessionId。
      // 缺少该字段时才回退到正文匹配（宿主旧投递形态的兼容路径）。两条路径的
      // **证据强度不同**，via 分开标——`settlement-notice`（senderSessionId 命中）
      // 是权威信号，`async_wait_agent` 直返 settled（投影滞后会误报 running，
      // 权威路径复查反而撒谎）；`settlement-text`（正文回退命中）是弱证据，
      // 胜出后必须复查到"不再观察到运行"才返回 settled。
      const sender = source.senderSessionId;
      const matches = typeof sender === 'string' && sender.length > 0
        ? sender === agentId
        : textOf(payload.message).includes(agentId);
      if (!matches) return;
      settledDone = true;
      settleSignal({
        kind: 'settled',
        via: typeof sender === 'string' && sender.length > 0 ? 'settlement-notice' : 'settlement-text',
        text: textOf(payload.message)
      });
      return;
    }

    if (kind === RELAY && !activityDone) {
      activityDone = true;
      activitySignal({ kind: 'activity', via: 'relay', text: textOf(payload.message) });
    }
  });

  let disposeStatus;
  try {
    disposeStatus = ctx.on('agent/status', (payload) => {
      if (settledDone) return;
      if (payload?.agent?.id !== agentId) return;
      if (payload.status !== 'idle') return;
      settledDone = true;
      settleSignal({ kind: 'settled', via: 'agent-status-idle' });
    });
  } catch (error) {
    // 初始化撤销（需求 §6.2）：第二路订阅建立失败时，先撤销第一路再原样上抛
    // ——调用方的回退只看返回值，管不到本函数内部的半建立状态。
    disposeInbox();
    throw error;
  }

  return {
    settled,
    activity,
    dispose: () => {
      disposeInbox();
      disposeStatus();
    }
  };
}

// 关于"落败 promise 的 reject 去哪了"：
// `Promise.race` 会给**每个**成员同时挂 resolve 与 reject 两个 handler，
// 因此落败成员随后 reject 时由 race 自己的 reject 功能接住，不会成为
// `unhandledRejection`。竞速成员统一映射为 `{ name }` 标签（取消拒绝归一，
// 设计 §2.5 取消出口返回取消口径），没有只-reject 成员。
// 本模块的三个信号 promise（wake／late／subagent 活动）**只 resolve**——订阅
// 建立在 Promise 构造器外，`ctx.on` 同步抛错直接同步上抛（调用方接线段承接，
// 设计 §2.1 初始化失败＝可控错误），promise 自身没有可拒绝路径。
