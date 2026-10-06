/**
 * 共用部件：等待期间的可打断信号（设计 §7）。
 *
 * 硬约束（需求 R12）：
 * - "用户插话"的判定**只能**用 `source.kind === 'user'`。结算通知与子代理转达消息的
 *   `role` 也是 `user`，用 role 判定会被自己的通知反复打断。
 * - **只有插话（steer，落 `next-step`、步骤边界投递）才打断**。排队（queue，落
 *   `next-turn`、轮次边界投递）的消息**不打断**——它在本轮内到不了模型手里，
 *   打断只会产生一个"看得见通知、看不见内容"的悬空回合（R12）。
 * - `subagent-settled` 是**权威结束信号**；`agent-message` 只是"有进展"的唤醒信号。
 * - 本包的迟到作答通知（自声明 kind，§32.5）是第四类：**唤醒交还**信号——不打断、
 *   不算结束，`async_wait_*` 认到它提前返回运行句柄（R3 信号分类四类，R30-d）。
 *   载体是**插件事件 + 起始检查**（用户裁定，与投递解耦）：事件
 *   `LATE_ANSWER_EVENT`（`LATE_ANSWER_SOURCE` 派生）+ 等待开始时扫 inbox 待读
 *   登记（`unclaimedLateSources`），不再监听 `agent/inbox/inserted`。
 * - 每个订阅都必须返回 disposer，并由调用方在 `finally` 中处置（R4 可逆性）。
 *
 * @module dsh-async-tools/interrupts
 */

/** 用户消息的来源种类（唯一字面；全部插话判定共用）。 */
export const USER_MESSAGE_SOURCE = 'user';

/** 迟到作答通知的来源种类（本包自声明，§32.5 通知形）。与 `'user'` 互斥：插话
 * 判定对它**不命中**（迟到作答不是用户插话，R12）；`async_wait_*` 对它有专属
 * 唤醒分支（提前返回运行句柄，R3 信号分类第四类）。命名对齐宿主 kebab 先例
 * （subagent-settled / cordis-host-runner：属主前缀 + 语义段）。 */
export const LATE_ANSWER_SOURCE = 'async-tools-late-answer';

/** 迟到作答到达的本包事件名（§32.5 唤醒载体，用户裁定：与投递解耦）。
 * 由 `LATE_ANSWER_SOURCE` **机械派生**（`<source>/arrived`，斜杠风格对齐宿主事件
 * `agent/inbox/inserted`），ask-takeover 发布面与 wait-* 订阅面同源导入本常量。
 * 载荷：`{agentId, questionId, kind: 'answer'|'ignore', summary}`（作答与忽略同形）。
 * 注意本事件不在 dsh-scope 的 scoped-event 清单里——普通 cordis 频道事件，
 * `ctx.emit` 对全部 `ctx.on` 监听器可达，无需 scope carrier。 */
export const LATE_ANSWER_EVENT = `${LATE_ANSWER_SOURCE}/arrived`;

/** 子代理结算通知的来源种类。 */
const SETTLED = 'subagent-settled';

/** 子代理运行中转达消息的来源种类。 */
const RELAY = 'agent-message';

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
 * inbox 不可读时按"不是插话"处理：**宁可不少等（预算仍有界），不可错打断**
 * （错打断会把一条模型看不见的排队消息报告成"已送达"）。
 *
 * @param {object} agent - 等待方 agent（`exec.agent`，完整 Agent 句柄）。
 * @param {string} messageId - 被插入消息的 id。
 * @returns {boolean} 是否插话。
 */
function isSteering(agent, messageId) {
  const nextStep = agent?.inbox?.nextStep;
  if (!Array.isArray(nextStep)) return false;
  return nextStep.some((message) => message?.id === messageId);
}

/**
 * 订阅"用户插话"（steer；排队消息不打断，R12）。
 * @param {object} ctx - cordis 上下文。
 * @param {object} agent - 等待方 agent。
 * @returns {{ promise: Promise<{kind: string}>, dispose: () => void }} 信号与处置器。
 */
export function watchUserInterrupt(ctx, agent) {
  let dispose = () => {};
  const promise = new Promise((resolve) => {
    let done = false;
    dispose = ctx.on('agent/inbox/inserted', (payload) => {
      if (done) return;
      if (!forAgent(payload, agent)) return;
      if (payload?.message?.source?.kind !== USER_MESSAGE_SOURCE) return;
      if (!isSteering(agent, payload.message.id)) return;
      done = true;
      resolve({ kind: 'interrupted', messageId: payload.message.id });
    });
  });
  return { promise, dispose: () => dispose() };
}

/**
 * 扫描 agent 收件箱里**已投递未领取**的本包迟到作答通知（§32.5「待读登记」的
 * 地面真值读取面——宿主 next-step/next-turn 两个待处理列表就是"已投递未领取"
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
 * 订阅"迟到作答到达"（§32.5 唤醒分支的信号源，R3 信号分类第四类；
 * 用户裁定：**插件事件 + 起始检查，与投递解耦**）。
 *
 * 两道命中面：
 * 1. **插件事件**：ask-takeover 宿主半边在作答/忽略到达即刻发 `LATE_ANSWER_EVENT`
 *    （作答与忽略同形）——本订阅过滤 `agentId` 与等待方一致的载荷。
 * 2. **起始检查**：等待开始时先查一次待读登记（`unclaimedLateSources` 扫
 *    `agent.inbox`）——命中任一即**同步**提前返回，堵住"作答先到、等待后开"
 *    的空窗（真机实录：已排队的作答没能唤醒后开的等待，干等至预算耗尽）。
 *
 * resolve 携带 `summary`（含题号——唤醒 note 据此指明"哪题已答"）与 `qid`。
 * 与插话订阅完全不同源（事件名不同），四类信号互斥由构造保证（专门单测钉住）。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} agent - 等待方 agent（作答通知发给谁，谁就是等待方）。
 * @returns {{ promise: Promise<{kind: string, summary: string, qid: string|undefined}>, dispose: () => void }} 信号与处置器。
 */
export function watchLateAnswer(ctx, agent) {
  let dispose = () => {};
  const promise = new Promise((resolve) => {
    let done = false;
    const hit = (payload) => {
      if (done) return;
      done = true;
      resolve({
        kind: 'late-answer',
        summary: typeof payload?.summary === 'string' ? payload.summary : '',
        qid: typeof payload?.questionId === 'string' ? payload.questionId : undefined
      });
    };
    dispose = ctx.on(LATE_ANSWER_EVENT, (payload) => {
      if (agent?.id !== undefined && payload?.agentId !== agent.id) return;
      hit(payload);
    });
    // 起始检查（§32.5）：等待开始时登记已非空 → 同步命中（作答先到、等待后开）。
    // inbox getter 抛错（projection 注销等设计内错误）按空——本调用在 Promise
    // executor 里同步执行，抛错穿透会把信号 promise 变 reject、无人接——
    // 打掉整实例；宁可多等一轮（事件面仍然在听），不可错唤醒。
    let unclaimed = [];
    try {
      unclaimed = unclaimedLateSources(agent);
    } catch {
      unclaimed = [];
    }
    if (unclaimed.length > 0) hit({ summary: unclaimed[0].summary, questionId: unclaimed[0].questionId });
  });
  return { promise, dispose: () => dispose() };
}

/**
 * 订阅子代理活动。三个独立通道（按可靠性排序）：
 *
 * 1. **结算通知**（权威）：`source.kind === "subagent-settled"`，用
 *    `source.senderSessionId` 精确关联到目标子代理。
 * 2. **状态转换**（屏障/提前返回）：`agent/status` 的 `idle`——**父代理 scope 能收到
 *    其子代理的这条事件**（实测）。它比列表快照可靠得多（`listChildren()` 的目录条目
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
      // 缺少该字段时才回退到正文匹配（老版本兼容路径）。R29-c：两条路径的
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

  const disposeStatus = ctx.on('agent/status', (payload) => {
    if (settledDone) return;
    if (payload?.agent?.id !== agentId) return;
    if (payload.status !== 'idle') return;
    settledDone = true;
    settleSignal({ kind: 'settled', via: 'agent-status-idle' });
  });

  return {
    settled,
    activity,
    dispose: () => {
      disposeInbox();
      disposeStatus();
    }
  };
}

// 这里原有过一个 `raceSignals({ signals, deadline })` 辅助函数，全仓无人调用
// （R2 审查 N8 点名的死代码），已删除。关于"落败 promise 的 reject 去哪了"：
// `Promise.race` 会给**每个**成员同时挂 resolve 与 reject 两个 handler，
// 因此落败成员随后 reject 时由 race 自己的 reject 能力接住，不会成为
// `unhandledRejection`；但这不等于"race 消费了它"——把 race 换成手写 `await`
// 循环会立刻丢掉这条性质。`wait-job.js` 的 `cancelled` 依赖它（接线到竞速之间
// 全同步，不存在无 handler 窗口）；`wait-agent.js` 的 `aborted` 另有屏障窗口，
// 创建点挂了 no-op catch 兜底（R29-a）——两处注释里各自重述了依据。
