/**
 * `async_wait`：统一等待入口（设计 §3.2；需求 9.3.1）。
 *
 * 一份预算支持无目标等待与多目标等待；`async_run`／`async_workflow` 的首次等待
 * 以刚创建的作业为目标，复用同一竞速编排（第 2 章的总截止、消息集合、入口扫描
 * 与交付批次——首次等待在各自的工具模块里接线，本模块只承担 `async_wait`）。
 *
 * 唤醒条件（需求 9.3.1）：
 * - 省略 `targets` 或空数组：任一发给本主体、可在下一模型步骤处理的消息到达，
 *   或作业结果可交付（交付账本的内容就绪事件）时结束等待；
 * - 非空 `targets`：任一指定作业进入终态、指定子代理产生变化通知（需求 9.3.3），
 *   或用户插话到达时结束等待；非目标通知不提前结束（§2.2 的按来源过滤）；
 * - `wait_ms=0`：只检查当前可用事件及作业内容，不挂起等待；
 * - 正等待期间取消或预算到期：结束本次等待，返回实际原因，后台任务继续运行。
 *
 * 消息过滤（设计 §2.2）：有目标等待对 `notice`／`relay` 类消息按来源过滤——仅当
 * 消息的 `senderSessionId` 命中目标列表中的子代理时，该消息才构成目标变化并结束
 * 等待；用户插话不受过滤。无目标等待被任一可处理消息唤醒。
 *
 * 出口（设计 §3.2.6）：作业终态（真实终态＋按 2.4 合并的输出）、子代理变化
 * （`changed`／`settled`＋证据分级说明，不复制正文）、无目标消息唤醒（`message`）、
 * 插话 `interrupted`、取消 `cancelled`、到期（有目标 `running` 附各目标已证状态、
 * 无目标 `budget`）。等待类出口统一附 `delivered`（本批交付条目）、`deferred`
 * （延后条目标识）与 `waited_ms`；零等待的 `waited_ms` 为 0。
 *
 * 活等待登记（设计 §2.6 批次锚点）：执行窗口开启即 `claimWait`，出口交付后
 * `releaseWait`＋`closeBatchIfIdle`——同拍并行等待汇入同一次模型输入、属同一批次，
 * 该主体全部本包活等待均已返回提交才关批。让位终局复查由 `releaseWait` 承担。
 *
 * @module dsh-async-tools/wait
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LOG_PREFIX, resolveWait } from './config.js';
import { buildToolText } from './descriptions.js';
import { ledger, clampNote } from './delivery.js';
import { JOB_RESULT_EVENT } from './delivery-sources.js';
import {
  classifyWake, preexistingWakeMessage, unclaimedLateSources, unclaimedSettlement,
  watchLateAnswer, watchSubagentActivity, watchWakeSignal
} from './interrupts.js';
import { agentStatusOf, AgentTarget } from './wait-agent-target.js';
import { isTerminal, JobTarget } from './wait-job-target.js';
import { escapeLogValue, interruptedNote, cancelledNote, interruptedPreexistingNote, cancelledPreexistingNote, settledNote } from './output.js';
import { t } from './text.js';

/**
 * 单调时钟（设计 §2.1 的计时基）：t0、deadline、waited_ms 全走它。
 */
const monotonic = () => performance.now();

/** 交付批次附注（复用于全部出口支；items 显式 additionalProperties，宿主编译器要求）。 */
const DELIVERED_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      job_id: { type: 'string' },
      status: { type: 'string' },
      chars: { type: 'number' },
      truncated: { type: 'boolean' }
    }
  }
};

/** 批次正文条目（触发目标正文在 output 字段，不重复入列；status_line 是与完成
 * 消息同款的状态行——设计 2.4「无输出或无详情也必须显示状态」；note 只在 lossy
 * 条目出现——两态找回说明，9.3.2「提供现有完整输出位置或继续取得方式」）。 */
const OUTPUTS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      job_id: { type: 'string' },
      status_line: { type: 'string' },
      note: { type: 'string' },
      text: { type: 'string' }
    }
  }
};

/** 其余目标已证状态（设计 §3.2.6：全部出口附注）。 */
const TARGETS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string' },
      id: { type: 'string' },
      status: { type: 'string' }
    }
  }
};

/**
 * `wait_ms` 参数校验（设计 §3.2.1）：有限且非负才有效；负值、非数值按可读拒绝
 * 返回（不进入夹紧）。正数按需求 5.2 上下限夹紧；0 合法，不夹紧到 `minWaitMs`。
 * @returns {number} 夹紧后的等待预算（毫秒）。
 */
function resolveUnifiedWait(raw, config) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw new Error(t(config.agentLang, 'error.waitMsInvalid'));
  }
  if (raw === 0) return 0;
  return resolveWait(raw, config);
}

/**
 * `targets` 语义校验与去重（设计 §3.2.1）：`kind` 不在枚举内、`id` 为空串或全
 * 空白按可读拒绝；重复项按同一目标去重，不报错。
 * @returns {{kind: 'job'|'agent', id: string}[]} 去重后的目标列表。
 */
function normalizeTargets(raw, config) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(t(config.agentLang, 'error.targetsInvalid'));
  }
  const seen = new Set();
  const targets = [];
  for (const item of raw) {
    const kind = item?.kind;
    const id = item?.id;
    if (kind !== 'job' && kind !== 'agent') {
      throw new Error(t(config.agentLang, 'error.targetKindInvalid'));
    }
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(t(config.agentLang, 'error.targetIdInvalid'));
    }
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ kind, id });
  }
  return targets;
}

/**
 * 构造 `async_wait` 工具定义。
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - 生效配置。
 * @returns {object} ToolDefinition。
 */
export function createWaitTool(ctx, config) {
  const rebuildText = (cfg) => buildToolText('async_wait', cfg);
  const text = rebuildText(config);
  const tool = defineTool({
    name: 'async_wait',
    description: text.description,
    parameters: text.parameters,
    // 输出 schema：九类出口（设计 §3.2.6）。批次附注（delivered/outputs/deferred/
    // note_deferred）与目标已证状态（targets）按出口条件出现；items 一律显式
    // additionalProperties（宿主 schema 编译器要求）。
    output: {
      schema: {
      oneOf: [{
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, const: 'completed' },
          job_id: { type: 'string', required: true },
          output: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          waited_ms: { type: 'number', required: true },
          note: { type: 'string' },
          delivered: DELIVERED_SCHEMA,
          outputs: OUTPUTS_SCHEMA,
          deferred: { type: 'array', items: { type: 'string' } },
          note_deferred: { type: 'string' },
          targets: TARGETS_SCHEMA
        }
      }, {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, const: 'killed' },
          job_id: { type: 'string', required: true },
          output: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          waited_ms: { type: 'number', required: true },
          note: { type: 'string' },
          delivered: DELIVERED_SCHEMA,
          outputs: OUTPUTS_SCHEMA,
          deferred: { type: 'array', items: { type: 'string' } },
          note_deferred: { type: 'string' },
          targets: TARGETS_SCHEMA
        }
      }, {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, const: 'failed' },
          job_id: { type: 'string', required: true },
          output: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          waited_ms: { type: 'number', required: true },
          delivered: DELIVERED_SCHEMA,
          outputs: OUTPUTS_SCHEMA,
          deferred: { type: 'array', items: { type: 'string' } },
          note_deferred: { type: 'string' },
          targets: TARGETS_SCHEMA
        }
      }, {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, const: 'running' },
          waited_ms: { type: 'number', required: true },
          note: { type: 'string', required: true },
          delivered: DELIVERED_SCHEMA,
          outputs: OUTPUTS_SCHEMA,
          deferred: { type: 'array', items: { type: 'string' } },
          note_deferred: { type: 'string' },
          targets: TARGETS_SCHEMA
        }
      }, {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, const: 'budget' },
          waited_ms: { type: 'number', required: true },
          note: { type: 'string', required: true },
          delivered: DELIVERED_SCHEMA,
          outputs: OUTPUTS_SCHEMA,
          deferred: { type: 'array', items: { type: 'string' } },
          note_deferred: { type: 'string' }
        }
      }, {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, const: 'interrupted' },
          waited_ms: { type: 'number', required: true },
          note: { type: 'string', required: true },
          delivered: DELIVERED_SCHEMA,
          outputs: OUTPUTS_SCHEMA,
          deferred: { type: 'array', items: { type: 'string' } },
          note_deferred: { type: 'string' },
          targets: TARGETS_SCHEMA
        }
      }, {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, const: 'message' },
          waited_ms: { type: 'number', required: true },
          note: { type: 'string', required: true },
          delivered: DELIVERED_SCHEMA,
          outputs: OUTPUTS_SCHEMA,
          deferred: { type: 'array', items: { type: 'string' } },
          note_deferred: { type: 'string' },
          targets: TARGETS_SCHEMA
        }
      }, {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, const: 'changed' },
          agent_id: { type: 'string', required: true },
          waited_ms: { type: 'number', required: true },
          note: { type: 'string', required: true },
          delivered: DELIVERED_SCHEMA,
          outputs: OUTPUTS_SCHEMA,
          deferred: { type: 'array', items: { type: 'string' } },
          note_deferred: { type: 'string' },
          targets: TARGETS_SCHEMA
        }
      }, {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, const: 'settled' },
          agent_id: { type: 'string', required: true },
          waited_ms: { type: 'number', required: true },
          note: { type: 'string', required: true },
          delivered: DELIVERED_SCHEMA,
          outputs: OUTPUTS_SCHEMA,
          deferred: { type: 'array', items: { type: 'string' } },
          note_deferred: { type: 'string' },
          targets: TARGETS_SCHEMA
        }
      }, {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, const: 'cancelled' },
          waited_ms: { type: 'number', required: true },
          note: { type: 'string', required: true },
          targets: TARGETS_SCHEMA
        }
      }]
      },
      // 模型只看得见 render 的输出：note/output/outputs 全部拼进可见文本。批次
      // 条目与完成消息同款头（作业标识＋终态＋字符数——设计 2.4「无输出或无详情
      // 也必须显示状态」）：正文非空跟随其后，空正文条目保留状态行（无输出完成
      // 的作业在批次中可见）；截断标记由条目文本自带的省略量说明承担。
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.output === undefined ? undefined : value.output,
          value.note,
          Array.isArray(value.outputs) && value.outputs.length > 0
            ? value.outputs.map((item) => `── ${item.job_id} ──\n${item.status_line}${item.text === '' ? '' : `\n${item.text}`}${item.note === undefined ? '' : `\n${item.note}`}`).join('\n\n')
            : undefined,
          value.note_deferred
        ].filter((part) => part !== undefined && part !== '').join('\n\n')
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const lang = config.agentLang;
      const agent = exec.agent;
      const owner = agent?.id;
      if (owner === undefined || owner === null) {
        throw new Error(t(lang, 'error.noAgentContext'));
      }

      // 入口已中止 → 取消口径零返回（不订阅、不武装、不发查询）。
      if (exec.signal?.aborted) {
        return {
          status: 'cancelled',
          waited_ms: 0,
          note: cancelledPreexistingNote({ lang, subject: 'wait', resume: 'async_wait(wait_ms=...)' })
        };
      }

      const waitMs = resolveUnifiedWait(args.wait_ms, config);
      const targets = normalizeTargets(args.targets, config);
      const jobTargets = targets.filter((target) => target.kind === 'job')
        .map(({ id }) => new JobTarget({ ctx, config, jobId: id, owner, t, lang }));
      const agentTargetSpecs = targets.filter((target) => target.kind === 'agent');
      const t0 = monotonic();
      const deadlineAt = t0 + waitMs;
      const elapsed = () => Math.max(0, Math.round(monotonic() - t0));
      const agentIds = agentTargetSpecs.map((target) => target.id);

      // 活等待登记（设计 §2.6 批次锚点）：执行窗口开启即登记，出口统一注销。
      const waitToken = ledger.claimWait(owner);

      /** 最近一次 collectBatch 装配的条目（出口异常时逐项回滚——空数组回滚是
       * 空操作，装配记录必须真实，设计 §2.6「读取后尚未提交时防止内容丢失」）。 */
      let lastCollected = [];

      /** 本批交付条目的出口投影（全部出口共用；交付失败回滚由 finally 承担）。
       * 批次正文随本返回携带（设计 §2.6「内容随等待返回交付」）：`outputs` 是
       * 本批各条目的正文；触发目标的正文由 `trigger` 携带（终态出口的 `output`
       * 字段），不重复入列——collectBatch 装配即消费缓冲，出口不得再读缓冲。
       * `includeRunning`（零等待主出口使用，设计 §3.2.3）：运行中目标的当前增量
       * 也装配（terminal 为空 → status 'running'）；其余出口不传——只带终态批。 */
      const batchOutcome = async (triggerJobIds, excludeJobId = undefined, options = {}) => {
        const { delivered, deferred, deferredNote } = ledger.collectBatch(owner, {
          triggerJobIds, lang,
          ...(options.includeRunning === true ? { includeRunning: true } : {})
        });
        lastCollected = delivered;
        const triggerEntry = excludeJobId === undefined
          ? null
          : delivered.find((item) => item.jobId === excludeJobId) ?? null;
        const statusOf = (item) => (item.terminal === null ? 'running' : item.terminal.status);
        return {
          delivered: delivered.map((item) => ({
            job_id: item.jobId,
            status: statusOf(item),
            chars: item.chars,
            truncated: item.truncated
          })),
          // 空正文条目**保留**（设计 2.4：无输出完成的作业在批次中以状态行可见，
          // 不因正文为空而消失）；状态行与完成消息同款（delivery.completionItem），
          // 经 clampNote 入界（需求 9.3.2 说明有界：单条 ≤200，条目上限 10 使
          // 批内逐条说明合计结构性 ≤2000——两档推导闭合，见设计 2.6）。运行中
          // 增量条目分键（completionItemRunning）——「settled: running」自相矛盾
          //（真机首测偏差）。lossy 条目附找回说明（9.3.2「提供现有完整输出位置
          // 或继续取得尚未交付内容的可执行方式；没有可用副本时如实说明」）。
          outputs: delivered
            .filter((item) => item.jobId !== excludeJobId)
            .map((item) => ({
              job_id: item.jobId,
              status_line: clampNote(t(
                lang,
                item.terminal === null ? 'delivery.completionItemRunning' : 'delivery.completionItem',
                {
                  jobId: item.jobId,
                  ...(item.terminal === null ? {} : { status: item.terminal.status }),
                  chars: item.chars
                }
              )),
              ...(item.lossy
                ? {
                    note: clampNote((item.spillPaths?.length ?? 0) > 0
                      ? t(lang, 'delivery.lossyAtPaths', { paths: item.spillPaths.join(', ') })
                      : t(lang, 'delivery.lossyUnrecoverable'))
                  }
                : {}),
              text: item.text
            })),
          deferred,
          ...(deferredNote === '' ? {} : { note_deferred: deferredNote }),
          ...(triggerEntry === null ? {} : {
            trigger: { text: triggerEntry.text, truncated: triggerEntry.truncated }
          })
        };
      };

      /** 其余目标已证状态（设计 §3.2.6：全部出口附注，不因单一事件丢弃观察）。 */
      const provenTargets = (excludeId) => {
        const rows = [];
        for (const job of jobTargets) {
          if (job.jobId === excludeId) continue;
          const snapshot = job.snapshot();
          if (snapshot.state === 'found') {
            rows.push({ kind: 'job', id: job.jobId, status: snapshot.row.status });
          } else {
            rows.push({ kind: 'job', id: job.jobId, status: snapshot.state === 'missing' ? 'not_found' : 'unknown' });
          }
        }
        for (const spec of agentTargetSpecs) {
          if (spec.id === excludeId) continue;
          rows.push({ kind: 'agent', id: spec.id, status: agentStatusOf(ctx, spec.id) });
        }
        return rows;
      };

      // ── 接线段（设计 §2.1：先订阅、再扫描；初始化失败撤销前序资源）────────
      let interrupt = null;
      let lateWatch = null;
      let deadlineTimer;
      let execWired = false;
      let readyDispose = null;
      const execAbort = new AbortController();
      const raceAbort = new AbortController();
      const onExecAbort = () => execAbort.abort(exec.signal?.reason);
      /** 子代理目标的活动观察器（结算通知 + agent/status；关系证明由屏障供给）。 */
      const watchers = [];
      try {
        // 消息订阅带目标过滤（设计 §2.2）：user 插话不过滤；有目标等待（作业或
        // 子代理）时 notice/relay 仅 sender 命中子代理目标才唤醒——纯作业目标传
        // 空数组＝一切非 user 消息不唤醒（作业内容由事件通道唤醒）；无目标时传
        // undefined 不过滤。订阅因此只在 user/命中时 resolve，消费侧不存在
        // 「非目标消息胜出后继续等」的形态。
        interrupt = watchWakeSignal(ctx, agent, lang, targets.length > 0 ? agentIds : undefined);
        lateWatch = watchLateAnswer(ctx, agent);
        // 内容就绪事件（设计 §3.2.5）：交付账本结算读取完成后广播——无目标
        // 等待与含作业目标的等待都消费（有目标时不作为结束信号，仅并入批次）。
        if (agentIds.length === 0 || jobTargets.length > 0) {
          readyDispose = ctx.on(JOB_RESULT_EVENT, (payload) => {
            if (payload?.owner !== owner) return;
            readySignal({ name: 'ready' });
          });
        }
        for (const spec of agentTargetSpecs) {
          watchers.push({ spec, watcher: watchSubagentActivity(ctx, agent, spec.id) });
        }
        if (exec.signal !== undefined) {
          exec.signal.addEventListener('abort', onExecAbort, { once: true });
          execWired = true;
        }
        let onDeadline;
        const deadline = new Promise((resolve) => { onDeadline = resolve; });
        deadlineTimer = ctx.timer.timeout(() => onDeadline({ name: 'deadline' }), waitMs);
        var deadlinePromise = deadline;
      } catch (error) {
        interrupt?.dispose();
        lateWatch?.dispose();
        if (readyDispose !== null) readyDispose();
        for (const { watcher } of watchers) watcher.dispose();
        if (execWired) exec.signal.removeEventListener('abort', onExecAbort);
        if (typeof deadlineTimer === 'function') deadlineTimer();
        await ledger.releaseWait(waitToken, owner);
        throw error;
      }

      // 内容就绪信号是**世代化**的（可多次触发）：每次 resolve 后立即换新 promise
      // ——竞速循环 continue 续等时挂的是新世代，已消费的旧 resolve 不会在下轮
      // race 里再次胜出（一次性 promise 复用是无限自旋的实证缺陷形态）。
      let readyNotify = () => {};
      let readyPromise = new Promise((resolve) => { readyNotify = resolve; });
      function readySignal(value) {
        const notify = readyNotify;
        readyPromise = new Promise((resolve) => { readyNotify = resolve; });
        notify(value);
      }

      const wakeSignal = interrupt.promise.then((signal) => ({
        name: 'wake', via: signal.via, summary: signal.summary, sender: signal.sender
      }));
      const lateSignal = lateWatch.promise.then((signal) => ({
        name: 'late-answer', summary: signal.summary
      }));
      const cancelled = new Promise((_resolve, reject) => {
        execAbort.signal.addEventListener('abort', () => reject(execAbort.signal.reason ?? new Error('aborted')), { once: true });
      }).then(() => ({ name: 'cancelled' }), () => ({ name: 'cancelled' }));

      /** 作业目标的事件通道成员（每目标一路 jobs.wait，正剩余值才发起；到期未终态按剩余续排）。 */
      const jobWaitSignals = [];
      const armJobWaits = () => {
        const remaining = deadlineAt - monotonic();
        if (remaining <= 0) return;
        for (const job of jobTargets) {
          if (jobWaitSignals.some((entry) => entry.job === job && !entry.settled)) continue;
          const entry = { job, settled: false };
          entry.promise = job.wait(remaining, raceAbort.signal).then(
            (view) => {
              entry.settled = true;
              return { name: 'job-event', job, view };
            },
            () => {
              entry.settled = true;
              return { name: 'job-event-dropped', job };
            }
          );
          jobWaitSignals.push(entry);
        }
      };

      const cleanup = async () => {
        interrupt.dispose();
        lateWatch.dispose();
        if (readyDispose !== null) readyDispose();
        for (const { watcher } of watchers) watcher.dispose();
        if (execWired) exec.signal.removeEventListener('abort', onExecAbort);
        if (typeof deadlineTimer === 'function') deadlineTimer();
        raceAbort.abort(new Error('async-tools: wait concluded'));
        await ledger.releaseWait(waitToken, owner);
        ledger.closeBatchIfIdle(owner);
      };

      try {
        // ── 入口检查（设计 §2.2/§3.2.2-4，订阅之后无空窗）──────────────────
        // 子代理目标的未领取结算通知优先（完成优先于一切唤醒）。
        for (const spec of agentTargetSpecs) {
          if (unclaimedSettlement(agent, spec.id) !== null) {
            const target = new AgentTarget({ ctx, config, agentId: spec.id, owner, t });
            target.noteReported('idle');
            return {
              status: 'settled',
              agent_id: spec.id,
              waited_ms: elapsed(),
              note: `${t(lang, 'via.noticePreexisting')}${settledNote({ lang, agentId: spec.id })}`,
              ...(await batchOutcome([])),
              targets: provenTargets(spec.id)
            };
          }
        }
        // 先到消息（user 优先；有目标等待的扫描带目标过滤——非目标消息不命中）。
        const earlyWake = classifyWake(preexistingWakeMessage(agent, lang, targets.length > 0 ? agentIds : undefined), lang);
        // 作业目标入口快照：终态即读取交付。
        for (const job of jobTargets) {
          const snapshot = job.snapshot();
          if (snapshot.state === 'failed') {
            throw new Error(t(lang, 'error.queryFailed'));
          }
          if (snapshot.state === 'missing') {
            throw new Error(t(lang, 'error.unknownJob', { jobId: job.jobId }));
          }
          if (snapshot.terminal) {
            const read = await job.readSettled(snapshot.row);
            // 混合多目标（原审者新-A）：终态目标先行返回的同拍，其余**运行中**作业
            // 目标的当前增量也读取并入批（includeRunning）——与零等待主出口同一
            // 口径（9.3.1:675「有作业目标时可交付当前未交付增量」对 wait_ms=0 的
            // 两个出口一致适用）；正等待出口仍只带终态批。
            for (const other of jobTargets) {
              if (other.jobId === job.jobId) continue;
              const os = other.snapshot();
              if (os.state === 'found' && !os.terminal && waitMs === 0) {
                await ledger.readIncremental(other.jobId);
              }
            }
            const { trigger, ...batch } = await batchOutcome(
              [job.jobId],
              job.jobId,
              waitMs === 0 ? { includeRunning: true } : {}
            );
            // 已交付事实可见（盲审 M-5）：该作业的结果已在先前载体交付（等待返回
            // 或完成消息）——再次等待只回终态行，但必须**说明**已交付，不得让
            // 空 output 被误读成「完成且无输出」（设计 3.2.3「返回只含终态行与
            // 已交付事实」）。
            const deliveredFact = ledger.jobs.get(job.jobId)?.deliveredFact ?? null;
            return {
              status: snapshot.row.status,
              job_id: job.jobId,
              // 读取失败≠空输出（设计 2.4）：失败时给可读标记与重试出路，
              // 不把「暂不可读」伪装成「结果为空」。
              output: trigger?.text ?? (read === null
                ? t(lang, 'delivery.readFailed', { jobId: job.jobId })
                : ''),
              ...(trigger === undefined && read !== null && deliveredFact !== null
                ? { note: t(lang, 'wait.alreadyDelivered', { jobId: job.jobId }) }
                : {}),
              truncated: trigger?.truncated ?? false,
              waited_ms: elapsed(),
              ...batch,
              targets: provenTargets(job.jobId)
            };
          }
        }
        // 子代理目标存在屏障与入口两层基准（设计 §3.2.2/§3.2.4）。
        for (const spec of agentTargetSpecs) {
          const target = new AgentTarget({ ctx, config, agentId: spec.id, owner, t });
          const entry = await target.childEntry(raceAbort.signal);
          if (entry === undefined) {
            throw new Error(t(lang, 'error.listingUnavailable'));
          }
          if (entry === null) {
            target.clearBaseline();
            const known = await target.knownChildren(t, raceAbort.signal);
            throw new Error(t(lang, 'error.unknownAgent', { agentId: spec.id, children: known.join('\n') }));
          }
          const check = target.entryCheck();
          if (check.action === 'stop-once') {
            target.noteReported(check.observed);
            return {
              status: 'settled',
              agent_id: spec.id,
              waited_ms: elapsed(),
              note: `${t(lang, check.observed === 'idle' ? 'via.idle' : 'via.noResident')}${settledNote({ lang, agentId: spec.id })}`,
              ...(await batchOutcome([])),
              targets: provenTargets(spec.id)
            };
          }
          if (check.action === 'changed-once') {
            target.noteReported('running');
            return {
              status: 'changed',
              agent_id: spec.id,
              waited_ms: elapsed(),
              note: t(lang, 'wait.agentResumed', { agentId: spec.id }),
              ...(await batchOutcome([])),
              targets: provenTargets(spec.id)
            };
          }
          target.noteReported('running');
        }

        // 零等待（设计 §2.1：不武装、不轮询，入口检查后立即交回）。
        if (waitMs === 0) {
          // 作业目标交付当前增量（运行中也可读，设计 §3.2.3）；非目标消息不构成
          // 结束条件（零等待只是检查，无等待可结束）。
          for (const job of jobTargets) {
            const snapshot = job.snapshot();
            if (snapshot.state === 'found' && !snapshot.terminal) {
              await ledger.readIncremental(job.jobId);
            }
          }
          if (earlyWake !== null && earlyWake.via === 'user') {
            return {
              status: 'interrupted',
              waited_ms: 0,
              note: interruptedPreexistingNote({ lang, subject: 'wait', resume: 'async_wait(wait_ms=...)' }),
              ...(await batchOutcome([])),
              targets: provenTargets()
            };
          }
          // 先到的**目标**消息（sender 命中）按变化通知交回（需求 9.3.3「等待
          // 入口已有尚未处理的目标消息……立即返回」——零等待同样适用；结算通知
          // 已在上方入口检查处理）。
          if (earlyWake !== null) {
            const matched = agentTargetSpecs.find((spec) => spec.id === earlyWake.sender);
            if (matched !== undefined) {
              return {
                status: 'changed',
                agent_id: matched.id,
                waited_ms: 0,
                note: t(lang, 'wait.targetMessage', { summary: earlyWake.summary }),
                ...(await batchOutcome([])),
                targets: provenTargets(matched.id)
              };
            }
            // 无目标时先到的 notice/relay 按 message 出口交回（需求 2.1.2「入口
            // 已到达、尚未处理的消息与等待中新到消息采用同一判定」——零等待也是
            // 入口，盲审 M-2：不得把消息信息吞进 zeroWaitNoTargets）。有目标等待
            // 的非目标消息在扫描层已滤除（earlyWake 不会带它）。
            if (targets.length === 0) {
              return {
                status: 'message',
                waited_ms: 0,
                note: t(lang, 'wait.wokeByMessage', { summary: earlyWake.summary }),
                ...(await batchOutcome([]))
              };
            }
          }
          // 零等待同样扫先到迟到作答（与正等待入口同一判定，盲审 M-2）。
          let zeroLate = [];
          try {
            zeroLate = unclaimedLateSources(agent);
          } catch { /* getter 抛错按无先到 */ }
          if (zeroLate.length > 0) {
            return {
              status: 'message',
              waited_ms: 0,
              note: t(lang, 'wait.lateArrived', { summary: zeroLate[0].summary }),
              ...(await batchOutcome([])),
              ...(agentIds.length > 0 || jobTargets.length > 0 ? { targets: provenTargets() } : {})
            };
          }
          // 主出口：includeRunning（设计 §3.2.3）——运行中目标的当前增量随批装配
          //（上文 readIncremental 已并入缓冲）；其余批成员仍限终态。
          const batch = await batchOutcome(
            jobTargets.map((job) => job.jobId),
            undefined,
            { includeRunning: true }
          );
          // 已交付终态目标补说明（盲审 M-5，与入口终态分支同款）：零等待出口的
          // note 不只报「目标未满足」——已交付目标的空 output 必须有解释，不得
          // 被误读成「完成且无输出」。
          const deliveredNotes = [];
          for (const job of jobTargets) {
            const snap = job.snapshot();
            const fact = ledger.jobs.get(job.jobId)?.deliveredFact ?? null;
            if (snap.state === 'found' && snap.terminal && fact !== null
              && snap.row.status !== 'running') {
              deliveredNotes.push(t(lang, 'wait.alreadyDelivered', { jobId: job.jobId }));
            }
          }
          const baseNote = targets.length > 0
            ? t(lang, 'wait.zeroWaitTargets')
            : t(lang, 'wait.zeroWaitNoTargets');
          return {
            status: targets.length > 0 ? 'running' : 'budget',
            waited_ms: 0,
            note: deliveredNotes.length > 0
              ? `${baseNote}\n${deliveredNotes.join('\n')}`
              : baseNote,
            ...batch,
            ...(targets.length > 0 ? { targets: provenTargets() } : {})
          };
        }

        // 先到消息（等待尚未开始）：user → interrupted；sender 命中的目标消息 →
        // 变化通知；无目标时的 notice/relay → message 出口。有目标等待的先到
        // 非目标消息在扫描层已滤除（不会到这里），不再有「误判无目标提前交回」
        // 的形态。
        if (earlyWake !== null && earlyWake.via === 'user') {
          return {
            status: 'interrupted',
            waited_ms: elapsed(),
            note: interruptedPreexistingNote({ lang, subject: 'wait', resume: 'async_wait(wait_ms=...)' }),
            ...(await batchOutcome([])),
            targets: provenTargets()
          };
        }
        if (earlyWake !== null) {
          const matched = agentTargetSpecs.find((spec) => spec.id === earlyWake.sender);
          if (matched !== undefined) {
            return {
              status: 'changed',
              agent_id: matched.id,
              waited_ms: elapsed(),
              note: t(lang, 'wait.targetMessage', { summary: earlyWake.summary }),
              ...(await batchOutcome([])),
              targets: provenTargets(matched.id)
            };
          }
          return {
            status: 'message',
            waited_ms: elapsed(),
            note: t(lang, 'wait.wokeByMessage', { summary: earlyWake.summary }),
            ...(await batchOutcome([])),
            ...(targets.length > 0 ? { targets: provenTargets() } : {})
          };
        }
        let earlyLate = [];
        try {
          earlyLate = unclaimedLateSources(agent);
        } catch { /* getter 抛错按无先到 */ }
        if (earlyLate.length > 0) {
          return {
            status: 'message',
            waited_ms: elapsed(),
            note: t(lang, 'wait.lateArrived', { summary: earlyLate[0].summary }),
            ...(await batchOutcome([])),
            ...(agentIds.length > 0 || jobTargets.length > 0 ? { targets: provenTargets() } : {})
          };
        }

        // ── 竞速循环（设计 §2.1/§3.2）────────────────────────────────────
        // 大循环：每个胜者在循环体内处理，非结束性胜者（子代理转达只是唤醒重查、
        // 有目标等待的就绪内容、作业事件通道的非终态到期）continue 续等，无重复
        // 出口代码。
        armJobWaits();
        // 自旋防线（实证缺陷的末道防线）：continue 不该密集发生——每轮 continue
        // 都伴随真实事件。上限内到不了出口即按到期口径交回并落 warn，绝不无限
        // 微任务自旋（曾复现 11 s / 2 GB 堆耗尽的形态：一次性 promise 被 continue
        // 复用，deadline 定时器永远排不上宏任务队列）。
        let spins = 0;
        const MAX_SPINS = 1000;
        for (;;) {
          const candidates = [
            wakeSignal,
            lateSignal,
            readyPromise,
            cancelled,
            deadlinePromise
          ];
          for (const entry of jobWaitSignals) {
            if (!entry.settled) candidates.push(entry.promise);
          }
          for (const { spec, watcher } of watchers) {
            candidates.push(watcher.settled.then((signal) => ({ name: 'agent-settled', spec, signal })));
            candidates.push(watcher.activity.then((signal) => ({ name: 'agent-activity', spec, signal })));
          }
          const raced = await Promise.race(candidates);
          const winner = raced && typeof raced.name === 'string' ? raced : { name: 'unknown' };
          const waitedMs = elapsed();
          const hasTargets = targets.length > 0;
          spins += 1;
          if (spins > MAX_SPINS) {
            ctx.logger?.warn?.(
              `${LOG_PREFIX} async_wait spin guard tripped: spins=${String(spins)} winner=${winner.name} `
              + '-- returning as budget-exhausted; this is a defect signal, please report it'
            );
            return {
              status: hasTargets ? 'running' : 'budget',
              waited_ms: waitedMs,
              note: hasTargets ? t(lang, 'wait.budgetTargets') : t(lang, 'wait.budgetNoTargets'),
              ...(await batchOutcome(jobTargets.map((job) => job.jobId))),
              ...(hasTargets ? { targets: provenTargets() } : {})
            };
          }

          // ── 非结束性胜者 ──────────────────────────────────────────────
          // 子代理转达（activity）只是「有进展」：重查状态，静止才按变化交回，
          // 仍在运行则**重建该目标的活动观察器**后继续等其余通道——一次性
          // promise 不复用（复用即自旋）。
          if (winner.name === 'agent-activity') {
            const status = agentStatusOf(ctx, winner.spec.id);
            if (status === 'idle' || status === 'absent') {
              const target = new AgentTarget({ ctx, config, agentId: winner.spec.id, owner, t });
              target.noteReported(status);
              return {
                status: 'settled',
                agent_id: winner.spec.id,
                waited_ms: waitedMs,
                note: `${t(lang, status === 'idle' ? 'via.idle' : 'via.noResident')}${settledNote({ lang, agentId: winner.spec.id })}`,
                ...(await batchOutcome([])),
                targets: provenTargets(winner.spec.id)
              };
            }
            const watcherIndex = watchers.findIndex((entry) => entry.spec.id === winner.spec.id);
            if (watcherIndex >= 0) {
              watchers[watcherIndex].watcher.dispose();
              watchers[watcherIndex] = {
                spec: watchers[watcherIndex].spec,
                watcher: watchSubagentActivity(ctx, agent, winner.spec.id)
              };
            }
            continue;
          }
          // 作业事件通道到期未终态（或查询被撤销）：按剩余预算续排后继续等
          // （settled 已在 then 里置位，armJobWaits 只补未在册目标）。
          if ((winner.name === 'job-event' || winner.name === 'job-event-dropped')
              && !isTerminal(winner.view?.status)) {
            armJobWaits();
            continue;
          }
          // 就绪内容（ready）：无目标等待的交付出口；有目标等待不因就绪内容
          // 结束（目标条件优先）——内容留在账本缓冲，由下一出口携带。
          if (winner.name === 'ready') {
            if (!hasTargets) {
              return {
                status: 'message',
                waited_ms: waitedMs,
                note: t(lang, 'wait.readyWoke'),
                ...(await batchOutcome([]))
              };
            }
            continue;
          }

          // ── 结束性胜者（出口分支，设计 §3.2.6）────────────────────────
          if (winner.name === 'job-event' && isTerminal(winner.view?.status)) {
            const read = await winner.job.readSettled(winner.view);
            const { trigger, ...batch } = await batchOutcome([winner.job.jobId], winner.job.jobId);
            return {
              status: winner.view.status,
              job_id: winner.job.jobId,
              // 读取失败口径同入口快照分支（设计 2.4：不伪装成空输出）。
              output: trigger?.text ?? (read === null
                ? t(lang, 'delivery.readFailed', { jobId: winner.job.jobId })
                : ''),
              truncated: trigger?.truncated ?? false,
              waited_ms: waitedMs,
              ...batch,
              targets: provenTargets(winner.job.jobId)
            };
          }

          if (winner.name === 'agent-settled') {
            const target = new AgentTarget({ ctx, config, agentId: winner.spec.id, owner, t });
            const observed = agentStatusOf(ctx, winner.spec.id);
            target.noteReported(observed === 'absent' ? 'absent' : 'idle');
            return {
              status: 'settled',
              agent_id: winner.spec.id,
              waited_ms: waitedMs,
              note: settledNote({ lang, agentId: winner.spec.id }),
              ...(await batchOutcome([])),
              targets: provenTargets(winner.spec.id)
            };
          }

          if (winner.name === 'cancelled') {
            return {
              status: 'cancelled',
              waited_ms: waitedMs,
              note: cancelledNote({ lang, subject: 'wait', waitedMs, resume: 'async_wait(wait_ms=...)' }),
              ...(hasTargets ? { targets: provenTargets() } : {})
            };
          }

          if (winner.name === 'wake') {
            if (winner.via === 'user') {
              return {
                status: 'interrupted',
                waited_ms: waitedMs,
                note: interruptedNote({ lang, subject: 'wait', waitedMs, resume: 'async_wait(wait_ms=...)' }),
                ...(await batchOutcome([])),
                targets: provenTargets()
              };
            }
            // 订阅带目标过滤：wake resolve 只能是 user 或 sender 命中——matched
            // 恒非 undefined（无目标等待不过滤，直接 message 出口）。不存在
            // 「非目标消息胜出后 continue 续等」的分支（那是被实证过的自旋缺陷）。
            const matched = agentTargetSpecs.find((spec) => spec.id === winner.sender);
            if (matched !== undefined) {
              return {
                status: 'changed',
                agent_id: matched.id,
                waited_ms: waitedMs,
                note: t(lang, 'wait.targetMessage', { summary: winner.summary ?? '' }),
                ...(await batchOutcome([])),
                targets: provenTargets(matched.id)
              };
            }
            return {
              status: 'message',
              waited_ms: waitedMs,
              note: t(lang, 'wait.wokeByMessage', { summary: winner.summary ?? '' }),
              ...(await batchOutcome([]))
            };
          }

          if (winner.name === 'late-answer') {
            return {
              status: 'message',
              waited_ms: waitedMs,
              note: t(lang, 'wait.lateArrived', { summary: winner.summary ?? '' }),
              ...(await batchOutcome([])),
              ...(hasTargets ? { targets: provenTargets() } : {})
            };
          }

          // 到期（与回退）：有目标 running 附各目标已证状态；无目标 budget。
          const note = hasTargets
            ? t(lang, 'wait.budgetTargets')
            : t(lang, 'wait.budgetNoTargets');
          ctx.logger?.info?.(
            `${LOG_PREFIX} async_wait concluded: waitedMs=${waitedMs} budget=${waitMs} `
            + `reason=${winner.name === 'deadline' ? 'budget' : winner.name}`
          );
          return {
            status: hasTargets ? 'running' : 'budget',
            waited_ms: waitedMs,
            note,
            ...(await batchOutcome(jobTargets.map((job) => job.jobId))),
            ...(hasTargets ? { targets: provenTargets() } : {})
          };
        }
      } catch (error) {
        // 出口异常：交付批回滚（缓冲保留，下一载体携带）后原样上抛——回滚按
        // 最近一次装配的真实条目逐项退回（空数组回滚是空操作，缺陷形态）。
        ledger.undoClaim(owner, lastCollected);
        throw error;
      } finally {
        await cleanup();
      }
    }
  });
  tool.rebuildText = rebuildText;
  return tool;
}
