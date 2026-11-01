/**
 * `async_wait`：统一等待入口（设计 §3.2；需求 9.3.1）。
 *
 * 一份预算支持无目标等待与多目标等待；`async_run`／`async_workflow` 的首次等待
 * 以刚创建的作业为目标，复用同一竞速编排（第 2 章的总截止、消息集合、入口扫描
 * 与交付批次——首次等待在各自的工具模块里接线，本模块只承担 `async_wait`）。
 *
 * 唤醒条件（需求 9.3.1）：
 * - 省略 `targets` 或空数组：任一发给本主体、可在下一模型步骤处理的消息到达、
 *   作业结果可交付（交付账本的内容就绪事件）、或周期复查确认挂起资格所依据的
 *   可等待工作已全部结束（WAIT-OBSERVE-01，无目标挂起的第三类唤醒源）时结束
 *   等待；
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
 * （延后条目标识）与 `waited_ms`。零等待的 `waited_ms` 按出口取值：主出口
 * （先到消息、迟到作答、批次汇集）报 0；入口终态与未领取结算通知出口按入口
 * 检查实际耗时（毫秒级）；子代理目标关系屏障拍内未完成的「条件未确认」出口
 * 按实际等待时长报告，含 2.1 零等待竞速的固定响应窗（至多 2000 ms），是唯一
 * 可达秒级的零等待出口。
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

/**
 * 自旋防线上限（可测锚，W-SPIN-A）：产品形态恒为 1000。对象形态是注入点——
 * ESM 导出绑定只读，测试改 `value` 注入小上限，验证「定时拍胜者不计入计数」：
 * 排除逻辑缺失时，小上限加按 `pollIntervalMs` 续排的定时拍会在预算内提前按
 * 到期口径交回（不排除定时拍的旧计数形态必红）。计数排除定时拍胜者本身是
 * 现存缺陷的顺带修复：备用轮询拍曾无条件计入——默认参数下 agent 目标满额
 * 等待约 600000/500＝1200 拍超过上限 1000，防线在第 1001 拍误触。
 */
export const WAIT_SPIN_LIMIT = { value: 1000 };

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
      }, {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, const: 'no-work' },
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
          status: { type: 'string', required: true, const: 'unconfirmed' },
          waited_ms: { type: 'number', required: true },
          note: { type: 'string', required: true },
          delivered: DELIVERED_SCHEMA,
          outputs: OUTPUTS_SCHEMA,
          deferred: { type: 'array', items: { type: 'string' } },
          note_deferred: { type: 'string' },
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
          note: cancelledPreexistingNote({ lang, resume: 'async_wait(wait_ms=...)' })
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
          //（曾实证的自相矛盾形态）。lossy 条目附找回说明（9.3.2「提供现有完整输出位置
          // 或继续取得尚未交付内容的可执行方式；没有可用副本时如实说明」）。
          outputs: delivered
            .map((item) => (item.jobId === excludeJobId
              // 触发目标：状态行随批可见（WAIT-STATUS-01——终态信息进模型文本，
              // 不只藏在结构化 value），正文由出口 `output` 字段携带，此处置空
              // 不重复渲染。
              ? { ...item, text: '', remainder: undefined }
              : item))
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
              ...(item.readFailed
                ? { note: clampNote(t(lang, 'delivery.readFailed', { jobId: item.jobId })) }
                : item.lossy
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

      /** 无目标资格检查与周期复查共用的中断出口（WAIT-OBSERVE-01 复查四路
       * 处置的取消／插话／消息先到一路）：与入口资格检查同一实现，无重复出口
       * 代码——只可能出现在无目标等待，消息按无目标 message 口径交回。 */
      const noTargetInterruptOutcome = async (interrupt) => {
        if (interrupt === 'cancelled') {
          return {
            status: 'cancelled',
            waited_ms: elapsed(),
            note: cancelledNote({ lang, waitedMs: elapsed(), resume: 'async_wait(wait_ms=...)' })
          };
        }
        const wake = interrupt.wake;
        if (wake.via === 'user') {
          return {
            status: 'interrupted',
            waited_ms: elapsed(),
            note: interruptedNote({ lang, waitedMs: elapsed(), resume: 'async_wait(wait_ms=...)' }),
            ...(await batchOutcome([]))
          };
        }
        return {
          status: 'message',
          waited_ms: elapsed(),
          note: t(lang, 'wait.wokeByMessage', { summary: wake.summary ?? '' }),
          ...(await batchOutcome([]))
        };
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
      /** 迟到作答信号已消费（有目标等待不以它结束——从竞速成员排除，复用即自旋）。 */
      let lateResolved = false;
      const cancelled = new Promise((_resolve, reject) => {
        execAbort.signal.addEventListener('abort', () => reject(execAbort.signal.reason ?? new Error('aborted')), { once: true });
      }).then(() => ({ name: 'cancelled' }), () => ({ name: 'cancelled' }));

      /**
       * 存在屏障查询的竞速包装（设计 §2.1，WAIT-TIME-01）：屏障与工具取消、
       * 订阅消息、总截止**同时竞速**，至多三拍、每拍受剩余预算约束——屏障挂起
       * 不再无界阻塞入口（原缺陷：listChildren 不返时整个等待卡在入口校验）。
       * 零等待不进入竞速（设计 §2.1「立即交回」）：在途查询只发起一次，
       * 竞速对象仅为工具取消与固定响应上限，拍内未完成按未证实交回。
       * @param {Promise} promise - 已发起的在途查询（不重发）。
       * @returns {Promise<{kind: 'entry'|'cancelled'|'wake'|'timeout', value?: object|null}>}
       *   四分：查询结果／被取消／消息中断／拍内未完成。
       */
      const raceQuery = async (promise) => {
        const wrapped = Promise.resolve(promise).then(
          (value) => ({ kind: 'entry', value }),
          () => ({ kind: 'entry', value: undefined })
        );
        if (waitMs === 0) {
          const winner = await Promise.race([
            wrapped,
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve({ kind: 'slice' }), 2000);
              if (typeof timer.unref === 'function') timer.unref();
            }),
            cancelled.then((value) => ({ kind: 'cancelled', value }))
          ]);
          if (winner.kind === 'entry') return { kind: 'entry', value: winner.value };
          if (winner.kind === 'cancelled') return { kind: 'cancelled' };
          return { kind: 'timeout' };
        }
        for (let beat = 0; beat < 3; beat += 1) {
          const slice = Math.min(2000, deadlineAt - monotonic());
          if (slice <= 0) break;
          const winner = await Promise.race([
            wrapped,
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve({ kind: 'slice' }), slice);
              if (typeof timer.unref === 'function') timer.unref();
            }),
            cancelled.then((value) => ({ kind: 'cancelled', value })),
            wakeSignal.then((value) => ({ kind: 'wake', value }))
          ]);
          if (winner.kind === 'entry') return { kind: 'entry', value: winner.value };
          if (winner.kind === 'cancelled') return { kind: 'cancelled' };
          if (winner.kind === 'wake') return { kind: 'wake', value: winner.value };
          // 本拍到点：下一拍继续与同一在途查询竞速（不重发）。
        }
        return { kind: 'timeout' };
      };

      const barrierEntry = (target) => raceQuery(target.childEntry(raceAbort.signal));

      /**
       * 无目标挂起资格检查（设计 §3.2.5 工作前提，WAIT-EMPTY-01）：确认存在
       * 可等待工作才挂起——本包账本在册的非终态后台作业、宿主作业清单的非终态
       * 行、`agents` 注册表里运行中的合法子代理。检查只读本主体可查的公开
       * 清单，不扩大权限；任一清单查询失败记 `unknown`（不假装无工作）。
       * 子代理清单查询经 `raceQuery` 与取消、消息、总截止竞速（WAIT-TIME-01
       * 同缺陷类）：挂起不无界阻塞出口，竞速胜出时以 `interrupt` 交回。
       *
       * 周期复查（WAIT-OBSERVE-01）与入口检查同源共用本函数：复查拍经
       * `options.signal` 换用每拍独立的 AbortController（窗口耗尽即取消底层
       * 查询，不悬挂宿主），`options.onQueryLaunched` 在查询发起后立即回调
       * （复查循环据此登记在途标志——上一拍在途未结则跳过本拍发起）。
       * @param {object} [options] - `{signal?, onQueryLaunched?}`。
       * @returns {Promise<{work: boolean, unknown: boolean,
       *   interrupt?: 'cancelled'|{wake: object}}>}
       */
      const waitWorthyWork = async (options = {}) => {
        for (const entry of ledger.jobs.values()) {
          if (entry.owner === owner && entry.terminal === null) return { work: true, unknown: false };
        }
        let unknown = false;
        try {
          const rows = ctx.jobs?.list?.(owner);
          if (Array.isArray(rows) && rows.some((row) => row && !isTerminal(row?.status))) {
            return { work: true, unknown: false };
          }
          if (!Array.isArray(rows)) unknown = true;
        } catch {
          unknown = true;
        }
        const query = ctx.subagents.listChildren(owner, options.signal ?? raceAbort.signal);
        if (typeof options.onQueryLaunched === 'function') options.onQueryLaunched(query);
        const childrenOutcome = await raceQuery(query);
        if (childrenOutcome.kind === 'cancelled') return { work: false, unknown: false, interrupt: 'cancelled' };
        if (childrenOutcome.kind === 'wake') return { work: false, unknown: false, interrupt: { wake: childrenOutcome.value } };
        if (childrenOutcome.kind === 'timeout') return { work: false, unknown: true };
        const children = childrenOutcome.value;
        if (Array.isArray(children)) {
          for (const child of children) {
            if (child?.kind === 'diagnostic') continue;
            if (agentStatusOf(ctx, child.id) === 'running') return { work: true, unknown: false };
          }
        } else {
          unknown = true;
        }
        return { work: false, unknown };
      };

      /** 子代理轮询拍（设计 §3.2.4 双通道之二，WAIT-AGENT-01）：事件通道失明时
       * 的备用观察——每 pollIntervalMs 重查注册表公开状态。每拍一个新 promise
       * （一次性 promise 复用即自旋）；句柄供 cleanup 清除。 */
      let pollTimerHandle = null;
      const pollBeat = () => new Promise((resolve) => {
        pollTimerHandle = setTimeout(() => resolve({ name: 'agent-poll' }),
          Math.max(50, Number(config.pollIntervalMs ?? 500)));
        if (typeof pollTimerHandle.unref === 'function') pollTimerHandle.unref();
      });

      /** 无目标挂起的周期复查拍（WAIT-OBSERVE-01，按 2026-11-01 的决策实施）：按
       * `pollIntervalMs` 节拍复查挂起资格所依据的清单（内容与入口检查同源——
       * `waitWorthyWork`），镜像 pollBeat 形态：每拍一个新 promise、按拍重排、
       * 不叠加异步 interval；句柄供 cleanup 清除。仅无目标挂起入竞速（有目标
       * 等待的显式目标由 3.2.4 的事件与备用轮询观察，复查不重复轮询它们）。 */
      let recheckTimerHandle = null;
      const recheckBeat = () => new Promise((resolve) => {
        recheckTimerHandle = setTimeout(() => resolve({ name: 'work-recheck' }),
          Math.max(50, Number(config.pollIntervalMs ?? 500)));
        if (typeof recheckTimerHandle.unref === 'function') recheckTimerHandle.unref();
      });

      /** 复查在途查询的两重防线（WAIT-OBSERVE-01 前置条件）：每拍独立
       * AbortController（raceQuery 窗口耗尽即取消底层 listChildren，不悬挂
       * 宿主）；上一拍在途未结则跳过本拍发起（慢／挂目录下不在宿主累积查询，
       * 主循环内在途目录查询至多一路）。 */
      let recheckAbort = null;
      let recheckQueryInFlight = false;

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
        if (pollTimerHandle !== null) clearTimeout(pollTimerHandle);
        if (recheckTimerHandle !== null) clearTimeout(recheckTimerHandle);
        if (execWired) exec.signal.removeEventListener('abort', onExecAbort);
        if (typeof deadlineTimer === 'function') deadlineTimer();
        // 复查拍的底层查询用独立 signal，须单独取消（不悬挂宿主）。
        if (recheckAbort !== null) recheckAbort.abort(new Error('async-tools: wait concluded'));
        raceAbort.abort(new Error('async-tools: wait concluded'));
        await ledger.releaseWait(waitToken, owner);
        ledger.closeBatchIfIdle(owner);
      };

      try {
        // ── 未领取结算通知（设计 §3.2.2：完成优先于一切唤醒，也先于存在
        // 屏障——结算通知在册即可交回，不要求目录行仍在；停止断言经结算
        // 复查门以同步现读执行，WAIT-SETTLE-GATE-01）──────────────────────
        for (const spec of agentTargetSpecs) {
          if (unclaimedSettlement(agent, spec.id) !== null) {
            // 运行或未证实：按 9.3.3 立即返回，但不作停止断言——changed 出口
            // 说明通知已到、静止未证实；不写登记、不等待注册表翻转（门只拦
            // 停止断言、不吞通知）。
            const observed = agentStatusOf(ctx, spec.id);
            if (observed === 'running' || observed === 'unknown') {
              return {
                status: 'changed',
                agent_id: spec.id,
                waited_ms: elapsed(),
                note: t(lang, 'wait.settleNoticeArrived'),
                ...(await batchOutcome([])),
                targets: provenTargets(spec.id)
              };
            }
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

        // ── 入口校验遍（WAIT-TARGET-01：全部目标资格先于任何终态返回；屏障
        // 与取消/消息/总截止竞速，WAIT-TIME-01）──────────────────────────────
        const jobSnapshots = new Map();
        for (const job of jobTargets) {
          const snapshot = job.snapshot();
          if (snapshot.state === 'failed') {
            throw new Error(t(lang, 'error.queryFailed'));
          }
          if (snapshot.state === 'missing') {
            throw new Error(t(lang, 'error.unknownJob', { jobId: job.jobId }));
          }
          jobSnapshots.set(job.jobId, snapshot);
        }
        const agentEntryOutcomes = new Map();
        let barrierWake = undefined;
        let barrierCancelled = false;
        for (const spec of agentTargetSpecs) {
          const target = new AgentTarget({ ctx, config, agentId: spec.id, owner, t });
          const outcome = await barrierEntry(target);
          if (outcome.kind === 'cancelled') { barrierCancelled = true; break; }
          if (outcome.kind === 'wake') { barrierWake = outcome.value; break; }
          if (outcome.kind === 'timeout') {
            agentEntryOutcomes.set(spec.id, { timeout: true });
            continue;
          }
          const entry = outcome.value;
          if (entry === undefined) {
            throw new Error(t(lang, 'error.listingUnavailable'));
          }
          if (entry === null) {
            target.clearBaseline();
            // 诊断清单同样竞速（WAIT-TIME-01 同缺陷类）：挂起时按空清单
            // 放行（查无出口仍给），取消或消息则先走各自出口。
            const knownOutcome = await raceQuery(target.knownChildren(t, raceAbort.signal));
            if (knownOutcome.kind === 'cancelled') { barrierCancelled = true; break; }
            if (knownOutcome.kind === 'wake') { barrierWake = knownOutcome.value; break; }
            const known = knownOutcome.kind === 'entry' && Array.isArray(knownOutcome.value)
              ? knownOutcome.value
              : [];
            throw new Error(t(lang, 'error.unknownAgent', { agentId: spec.id, children: known.join('\n') }));
          }
          agentEntryOutcomes.set(spec.id, { entry });
        }
        if (barrierCancelled) {
          return {
            status: 'cancelled',
            waited_ms: elapsed(),
            note: cancelledNote({ lang, waitedMs: elapsed(), resume: 'async_wait(wait_ms=...)' }),
            ...(targets.length > 0 ? { targets: provenTargets() } : {})
          };
        }
        if (barrierWake !== undefined) {
          // 屏障期间用户插话/目标消息到达：消息优先于其余校验（未证实目标在
          // targets 行里如实标 unknown）。
          if (barrierWake.via === 'user') {
            return {
              status: 'interrupted',
              waited_ms: elapsed(),
              note: interruptedNote({ lang, waitedMs: elapsed(), resume: 'async_wait(wait_ms=...)' }),
              ...(await batchOutcome([])),
              targets: provenTargets()
            };
          }
          const matched = agentTargetSpecs.find((spec) => spec.id === barrierWake.sender);
          if (matched !== undefined) {
            return {
              status: 'changed',
              agent_id: matched.id,
              waited_ms: elapsed(),
              note: t(lang, 'wait.targetMessage', { summary: barrierWake.summary ?? '' }),
              ...(await batchOutcome([])),
              targets: provenTargets(matched.id)
            };
          }
          return {
            status: 'message',
            waited_ms: elapsed(),
            note: t(lang, 'wait.wokeByMessage', { summary: barrierWake.summary ?? '' }),
            ...(await batchOutcome([]))
          };
        }
        for (const [specId, outcome] of agentEntryOutcomes) {
          if (outcome.timeout) {
            // 屏障拍内未完成：本次不可证实目标资格——如实交回 unconfirmed
            //（不假装无目标，也不无界等待；重查出路在说明里）。
            ctx.logger?.warn?.(
              `${LOG_PREFIX} async_wait barrier timed out for agent target ${String(specId)}`
            );
            return {
              status: 'unconfirmed',
              waited_ms: elapsed(),
              note: t(lang, 'wait.unconfirmedTargets', { ids: specId }),
              ...(await batchOutcome([])),
              targets: provenTargets()
            };
          }
        }
        // 关系已证（childEntry 命中）：解除活动观察器的关系静默期——idle/absent
        // 事件自此可结算（WAIT-AGENT-01 的 proveRelation 接线）。
        for (const { spec, watcher } of watchers) {
          if (agentEntryOutcomes.get(spec.id)?.entry !== undefined) {
            watcher.proveRelation?.();
          }
        }

        // ── 入口返回条件（先证资格，后查条件）──────────────────────────
        // 先到消息（user 优先；有目标等待的扫描带目标过滤——非目标消息不命中）。
        const earlyWake = classifyWake(preexistingWakeMessage(agent, lang, targets.length > 0 ? agentIds : undefined), lang);
        // 作业目标入口快照：终态即读取交付。
        for (const job of jobTargets) {
          const snapshot = jobSnapshots.get(job.jobId) ?? job.snapshot();
          if (snapshot.terminal) {
            const read = await job.readSettled(snapshot.row);
            // 混合多目标：终态目标先行返回的同拍，其余**运行中**作业目标的当前
            // 增量也读取并入批（includeRunning）——与零等待主出口同一口径
            //（9.3.1「有作业目标时可交付当前未交付增量」对 wait_ms=0 的两个
            // 出口一致适用）；正等待出口仍只带终态批。
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
            // 已交付事实可见（含 partial 续段——首次已交首尾、中段仍在缓冲时，
            // trigger 携带续段正文并注明续段；完全已交付时空 output 必须说明，
            // 不得被误读成「完成且无输出」，设计 3.2.3）。
            const deliveredFact = ledger.jobs.get(job.jobId)?.deliveredFact ?? null;
            const entry = ledger.jobs.get(job.jobId);
            return {
              status: snapshot.row.status,
              job_id: job.jobId,
              // 读取失败≠空输出（设计 2.4）：失败时给可读标记与重试出路，
              // 不把「暂不可读」伪装成「结果为空」（trigger.text 为空串时同样
              // 落入读取失败文案——readFailed 条目的正文本来就是空）。
              output: (trigger?.text ?? '') !== ''
                ? trigger.text
                : (read === null
                  ? t(lang, 'delivery.readFailed', { jobId: job.jobId })
                  : ''),
              ...(trigger === undefined && read !== null && deliveredFact !== null
                ? { note: deliveredFact.partial === true
                  ? t(lang, 'wait.partialDelivered', { jobId: job.jobId, chars: entry?.buffer.length ?? 0 })
                  : t(lang, 'wait.alreadyDelivered', { jobId: job.jobId }) }
                : {}),
              truncated: trigger?.truncated ?? false,
              waited_ms: elapsed(),
              ...batch,
              targets: provenTargets(job.jobId)
            };
          }
        }
        // 子代理目标入口两层基准（设计 §3.2.2/§3.2.4；资格已在上方校验遍证实）。
        for (const spec of agentTargetSpecs) {
          const target = new AgentTarget({ ctx, config, agentId: spec.id, owner, t });
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
          // 静止对象不取得挂起资格（设计 §3.2.5 工作前提，WAIT-AGENT-02）：
          // 挂起基准只登记本次观察到**仍在运行**的目标——无条件写 running 会把
          // 已报告的静止基准改回 running，下一次入口把同一静止目标再次当作
          // 「未报告翻转」交回（重复翻转的缺陷形态）。
          if (agentStatusOf(ctx, spec.id) === 'running') target.noteReported('running');
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
              note: interruptedPreexistingNote({ lang, resume: 'async_wait(wait_ms=...)' }),
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
            // 入口，消息信息不得吞进 zeroWaitNoTargets）。有目标等待
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
          // 零等待同样扫先到迟到作答（与正等待入口同一判定）；迟到作答只可唤醒
          // 无目标等待（9.3.1）——有目标时消息留在收件箱按宿主领取节奏处理，
          // 不构成本次返回。
          let zeroLate = [];
          try {
            zeroLate = unclaimedLateSources(agent);
          } catch { /* getter 抛错按无先到 */ }
          if (zeroLate.length > 0 && targets.length === 0) {
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
          // 已交付终态目标补说明（与入口终态分支同款）：零等待出口的
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
            note: interruptedPreexistingNote({ lang, resume: 'async_wait(wait_ms=...)' }),
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
        // 迟到作答只可唤醒无目标活等待（9.3.1，WAIT-WAKE-01）：有目标等待不以
        // 迟到作答结束——消息留在收件箱，由宿主领取节奏处理。
        if (earlyLate.length > 0 && targets.length === 0) {
          return {
            status: 'message',
            waited_ms: elapsed(),
            note: t(lang, 'wait.lateArrived', { summary: earlyLate[0].summary }),
            ...(await batchOutcome([])),
            ...(agentIds.length > 0 || jobTargets.length > 0 ? { targets: provenTargets() } : {})
          };
        }

        // ── 无目标挂起资格（设计 §3.2.5 工作前提）──────────────────────
        if (targets.length === 0) {
          // 就绪内容优先交回（WAIT-READY-01）：入口已有可交付的终态条目（含
          // partial 续段与读取失败状态行）时不挂起——等待的意义是等内容，内容
          // 已在账本，立即交付。
          const readyBatch = await batchOutcome([]);
          if (readyBatch.outputs.length > 0) {
            return {
              status: 'message',
              waited_ms: elapsed(),
              note: t(lang, 'wait.readyCollect'),
              ...readyBatch
            };
          }
          // 无可等待工作不挂起（WAIT-EMPTY-01）：活等待的挂起资格由真实的
          // 运行中工作提供——没有工作时立即返回，不等待未来消息；清单查询
          // 失败（无法证实）如实报 unconfirmed，不假装无工作。
          const { work, unknown, interrupt } = await waitWorthyWork();
          if (interrupt !== undefined) return await noTargetInterruptOutcome(interrupt);
          if (!work) {
            if (unknown) {
              return {
                status: 'unconfirmed',
                waited_ms: elapsed(),
                note: t(lang, 'wait.unconfirmedWork'),
                ...(await batchOutcome([]))
              };
            }
            ctx.logger?.info?.(
              `${LOG_PREFIX} async_wait returned without suspending: no wait-worthy work`
            );
            return {
              status: 'no-work',
              waited_ms: elapsed(),
              note: t(lang, 'wait.noWork'),
              ...(await batchOutcome([]))
            };
          }
        }

        // ── 全部目标维持已确认静止（设计 §3.2.4：静止对象不取得挂起资格，
        // WAIT-AGENT-02/WAIT-EMPTY-01）────────────────────────────────────
        // 子代理目标全部为「已报告静止同态」（跨调用基准未翻转）且没有作业
        // 目标时，等待失去全部资格——与无工作同口径立即返回，不挂起等未来
        // 翻转（挂起会在轮询拍里把同一静止态当「新变化」重复交回，混合目标
        // 时更会截断本应继续的等待）。
        if (targets.length > 0 && jobTargets.length === 0 && agentTargetSpecs.length > 0
          && agentTargetSpecs.every((spec) => {
            const target = new AgentTarget({ ctx, config, agentId: spec.id, owner, t });
            const status = agentStatusOf(ctx, spec.id);
            return (status === 'idle' || status === 'absent') && target.baseline() === status;
          })) {
          ctx.logger?.info?.(
            `${LOG_PREFIX} async_wait returned without suspending: all agent targets settled as last reported`
          );
          return {
            status: 'settled',
            agent_id: agentTargetSpecs[0].id,
            waited_ms: elapsed(),
            note: t(lang, 'wait.targetsSettled', {
              ids: agentTargetSpecs.map((spec) => spec.id).join('、')
            }),
            ...(await batchOutcome([])),
            targets: provenTargets()
          };
        }

        // ── 竞速循环（设计 §2.1/§3.2）────────────────────────────────────
        // 大循环：每个胜者在循环体内处理，非结束性胜者（子代理转达只是唤醒重查、
        // 有目标等待的就绪内容、作业事件通道的非终态到期）continue 续等，无重复
        // 出口代码。
        armJobWaits();
        /** 「结算通知已见但状态未证实」的调用内标记（WAIT-SETTLE-GATE-01）：
         * spec.id → true。门化期间不写跨调用登记、不丢通知；静止证实后经翻转
         * 出口交付并清标记；出口返回时仍有标记的附 settleNoticePending 说明
         *（取消／插话／消息／到期照常交回、不受标记影响）。标记仅调用内存活。 */
        const settleNoticeSeen = new Map();
        /** 出口附注（WAIT-SETTLE-GATE-01）：返回时仍存在标记的，如实说明
         * 「结算通知已见、静止未证实」——不吞信息、不作停止断言。 */
        const settlePendingNote = () => (settleNoticeSeen.size === 0
          ? ''
          : `\n${t(lang, 'wait.settleNoticePending', { ids: [...settleNoticeSeen.keys()].join('、') })}`);
        // 自旋防线（实证缺陷的末道防线）：continue 不该密集发生——每轮 continue
        // 都伴随真实事件。上限内到不了出口即按到期口径交回并落 warn，绝不无限
        // 微任务自旋（曾复现 11 s / 2 GB 堆耗尽的形态：一次性 promise 被 continue
        // 复用，deadline 定时器永远排不上宏任务队列）。
        let spins = 0;
        // 定时拍胜者不计入计数（WAIT-OBSERVE-01 顺带修复的现存缺陷：备用轮询拍
        // 曾无条件计入——默认参数下 agent 目标满额等待 600000/500＝1200 拍超过
        // 上限 1000，防线误触、提前按到期口径交回）。防线只数非定时信号的密集
        // 重复（事件风暴、真自旋）；定时拍按节拍发生、不是自旋。取值走注入点
        // WAIT_SPIN_LIMIT（可测锚，W-SPIN-A）。
        const isTimedBeat = (winner) => winner.name === 'agent-poll' || winner.name === 'work-recheck'
          || ((winner.name === 'job-event' || winner.name === 'job-event-dropped')
            && !isTerminal(winner.view?.status));
        for (;;) {
          const candidates = [
            wakeSignal,
            ...(lateResolved ? [] : [lateSignal]),
            readyPromise,
            cancelled,
            deadlinePromise
          ];
          // 子代理目标的轮询拍（设计 §3.2.4 双通道之二，WAIT-AGENT-01）：每轮
          // 竞速重排新拍（一次性 promise 不复用）。
          if (watchers.length > 0) candidates.push(pollBeat());
          // 无目标挂起的周期复查拍（WAIT-OBSERVE-01）：仅无目标等待入竞速
          //（正时长才到达这里），有目标等待由 3.2.4 的显式目标通道观察。
          if (targets.length === 0) candidates.push(recheckBeat());
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
          if (!isTimedBeat(winner)) spins += 1;
          if (spins > WAIT_SPIN_LIMIT.value) {
            ctx.logger?.warn?.(
              `${LOG_PREFIX} async_wait spin guard tripped: spins=${String(spins)} winner=${winner.name} `
              + '-- returning as budget-exhausted; this is a defect signal, please report it'
            );
            return {
              status: hasTargets ? 'running' : 'budget',
              waited_ms: waitedMs,
              note: `${hasTargets ? t(lang, 'wait.budgetTargets') : t(lang, 'wait.budgetNoTargets')}${settlePendingNote()}`,
              ...(await batchOutcome(jobTargets.map((job) => job.jobId))),
              ...(hasTargets ? { targets: provenTargets() } : {})
            };
          }

          // ── 非结束性胜者 ──────────────────────────────────────────────
          // 无目标挂起的周期复查（WAIT-OBSERVE-01）：复查内容与入口检查同源
          //（waitWorthyWork——账本在册的非终态作业同步短路、零目录查询，其次
          // jobs.list 非终态行，最后子代理清单的注册表现读）。四路处置：仍有
          // 可等待工作→续等；确认范围内已无可等待工作→复用 no-work 出口及时
          // 交回（note 用 workConcluded，waited_ms 为全程实际时长，就绪内容按
          // 2.6 随批顺带交付——不升格为目标变化通知、不逐个点名）；查询失败或
          // 拍内未回→未证实，续等不交回，下一拍再查；取消／插话／消息先到→
          // 各自既有出口。复查是只读观察、不向主体报告具体子代理的状态，因此
          // 不写 3.2.4 的跨调用登记——写会吞掉后续首次指定该子代理时的首次
          // 确认（W-OBSERVE-G 钉住）。剩余预算不正不发起查询（§2.1，由
          // deadline 成员收场）；上一拍在途未结跳过本拍发起（防线二）。
          if (winner.name === 'work-recheck') {
            if (deadlineAt - monotonic() <= 0 || recheckQueryInFlight) continue;
            recheckAbort = new AbortController();
            const beatSignal = recheckAbort.signal;
            recheckQueryInFlight = true;
            const markQuerySettled = () => { recheckQueryInFlight = false; };
            // 跳拍标志的回收纪律：标志只在「确实发起了目录查询」时由查询的
            // then 清除；waitWorthyWork 走账本或 jobs.list 同步短路提前返回时
            // 目录查询从未发起（onQueryLaunched 不回调），此处同步回收——
            // 否则一次短路后标志永久卡住，后续全部复查拍被跳过（外来作业的
            // 静默结算覆盖随之失效，W-OBSERVE-H 钉住）。
            let recheckQueryLaunched = false;
            const outcome = await waitWorthyWork({
              signal: beatSignal,
              onQueryLaunched: (query) => {
                recheckQueryLaunched = true;
                query.then(markQuerySettled, markQuerySettled);
              }
            });
            if (!recheckQueryLaunched) markQuerySettled();
            // 窗口耗尽即取消底层查询（防线一）：宿主不理 signal 时查询悬挂，
            // inFlight 标志让后续拍跳过发起，不在宿主累积悬挂查询。
            if (beatSignal.aborted !== true && (outcome.unknown === true || outcome.interrupt !== undefined)) {
              recheckAbort.abort(new Error('async-tools: recheck-window-exhausted'));
            }
            if (outcome.interrupt !== undefined) return await noTargetInterruptOutcome(outcome.interrupt);
            if (outcome.work || outcome.unknown) continue;
            ctx.logger?.info?.(
              `${LOG_PREFIX} async_wait concluded by periodic recheck: no wait-worthy work remains`
            );
            return {
              status: 'no-work',
              waited_ms: waitedMs,
              note: t(lang, 'wait.workConcluded'),
              ...(await batchOutcome([]))
            };
          }
          // 子代理轮询拍（备用观察，不扩权——只读注册表公开状态）：静止与
          // 跨调用基准**同态**＝维持，不是新变化（9.3.6「已报告变化不重复
          // 呈现」）——不交回也不重写基准；翻转（基准 running→静止）才按
          // 变化通知交回。全部目标维持已确认静止且无作业目标时，等待失去
          // 全部资格，立即按「维持静止」交回（不耗尽预算、不截断混合等待）。
          if (winner.name === 'agent-poll') {
            let allQuiet = watchers.length > 0 && jobTargets.length === 0;
            for (const { spec } of watchers) {
              const status = agentStatusOf(ctx, spec.id);
              if (status !== 'idle' && status !== 'absent') {
                allQuiet = false;
                continue;
              }
              const target = new AgentTarget({ ctx, config, agentId: spec.id, owner, t });
              if (target.baseline() === status) continue;
              target.noteReported(status);
              allQuiet = false;
              // 门化标记的翻转交付（WAIT-SETTLE-GATE-01）：静止已证实——清标记、
              // 说明前缀注明结算通知已见。
              const noticeSeen = settleNoticeSeen.get(spec.id) === true;
              if (noticeSeen) settleNoticeSeen.delete(spec.id);
              return {
                status: 'settled',
                agent_id: spec.id,
                waited_ms: waitedMs,
                note: `${noticeSeen ? t(lang, 'via.settleNoticeSeen') : ''}${t(lang, status === 'idle' ? 'via.idle' : 'via.noResident')}${settledNote({ lang, agentId: spec.id })}${settlePendingNote()}`,
                ...(await batchOutcome([])),
                targets: provenTargets(spec.id)
              };
            }
            if (allQuiet) {
              ctx.logger?.info?.(
                `${LOG_PREFIX} async_wait returned from poll beat: all agent targets settled as last reported`
              );
              return {
                status: 'settled',
                agent_id: watchers[0].spec.id,
                waited_ms: waitedMs,
                note: `${t(lang, 'wait.targetsSettled', {
                  ids: watchers.map(({ spec }) => spec.id).join('、')
                })}${settlePendingNote()}`,
                ...(await batchOutcome([])),
                targets: provenTargets()
              };
            }
            continue;
          }
          // 子代理转达（activity）只是「有进展」：重查状态；静止且与基准
          // 同态＝维持（活动信号不构成新变化，重建观察器续等）；静止且
          // 翻转才按变化交回；仍在运行则**重建该目标的活动观察器**后继续等
          // 其余通道——一次性 promise 不复用（复用即自旋）。
          if (winner.name === 'agent-activity') {
            const status = agentStatusOf(ctx, winner.spec.id);
            if (status === 'idle' || status === 'absent') {
              const target = new AgentTarget({ ctx, config, agentId: winner.spec.id, owner, t });
              if (target.baseline() !== status) {
                target.noteReported(status);
                // 门化标记的翻转交付（WAIT-SETTLE-GATE-01）：静止已证实——清标记、
                // 说明前缀注明结算通知已见。
                const noticeSeen = settleNoticeSeen.get(winner.spec.id) === true;
                if (noticeSeen) settleNoticeSeen.delete(winner.spec.id);
                return {
                  status: 'settled',
                  agent_id: winner.spec.id,
                  waited_ms: waitedMs,
                  note: `${noticeSeen ? t(lang, 'via.settleNoticeSeen') : ''}${t(lang, status === 'idle' ? 'via.idle' : 'via.noResident')}${settledNote({ lang, agentId: winner.spec.id })}${settlePendingNote()}`,
                  ...(await batchOutcome([])),
                  targets: provenTargets(winner.spec.id)
                };
              }
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
            const jobEntry = ledger.jobs.get(winner.job.jobId);
            const jobFact = jobEntry?.deliveredFact ?? null;
            // 作业终态说明（已交付事实）与门化标记附注（WAIT-SETTLE-GATE-01：
            // 混合目标下其余子代理目标「通知已见未证实」的说明不因作业出口丢失）。
            const jobNote = trigger === undefined && read !== null && jobFact !== null
              ? (jobFact.partial === true
                ? t(lang, 'wait.partialDelivered', { jobId: winner.job.jobId, chars: jobEntry?.buffer.length ?? 0 })
                : t(lang, 'wait.alreadyDelivered', { jobId: winner.job.jobId }))
              : '';
            return {
              status: winner.view.status,
              job_id: winner.job.jobId,
              // 读取失败口径同入口快照分支（设计 2.4：不伪装成空输出）；已交付
              // 事实可见（同入口分支——空 output 必须说明，partial 注明续段）。
              output: (trigger?.text ?? '') !== ''
                ? trigger.text
                : (read === null
                  ? t(lang, 'delivery.readFailed', { jobId: winner.job.jobId })
                  : ''),
              ...(jobNote === '' && settlePendingNote() === '' ? {} : { note: `${jobNote}${settlePendingNote()}` }),
              truncated: trigger?.truncated ?? false,
              waited_ms: waitedMs,
              ...batch,
              targets: provenTargets(winner.job.jobId)
            };
          }

          if (winner.name === 'agent-settled') {
            // 结算复查门（WAIT-SETTLE-GATE-01）：停止胜出（结算通知两种 via 或
            // agent/status 转 idle 事件）交付 settled 前同步现读注册表复核
            // 「不再观察到运行」——不同时宣称结算与运行。非运行按现行交付并写
            // 登记（W-GATE-A 钉现行保持；门化后再次通知静止已证实时清标记）；
            // 运行或读取失败不报 settled、不写登记、不丢通知：记「结算通知已见
            // 但状态未证实」标记，重建该目标活动观察器（已 resolve 的一次性
            // settled promise 不复入竞速——复用即自旋）并对新实例重调
            // proveRelation（关系已在入口屏障证实），回竞速循环，由既有轮询或
            // 事件观察到静止时按翻转出口交付 settled（说明注明通知已见）。
            const observed = agentStatusOf(ctx, winner.spec.id);
            if (observed === 'running' || observed === 'unknown') {
              settleNoticeSeen.set(winner.spec.id, true);
              const watcherIndex = watchers.findIndex((entry) => entry.spec.id === winner.spec.id);
              if (watcherIndex >= 0) {
                watchers[watcherIndex].watcher.dispose();
                const rebuilt = watchSubagentActivity(ctx, agent, winner.spec.id);
                rebuilt.proveRelation?.();
                watchers[watcherIndex] = { spec: watchers[watcherIndex].spec, watcher: rebuilt };
              }
              continue;
            }
            settleNoticeSeen.delete(winner.spec.id);
            const target = new AgentTarget({ ctx, config, agentId: winner.spec.id, owner, t });
            target.noteReported(observed === 'absent' ? 'absent' : 'idle');
            return {
              status: 'settled',
              agent_id: winner.spec.id,
              waited_ms: waitedMs,
              note: `${settledNote({ lang, agentId: winner.spec.id })}${settlePendingNote()}`,
              ...(await batchOutcome([])),
              targets: provenTargets(winner.spec.id)
            };
          }

          if (winner.name === 'cancelled') {
            return {
              status: 'cancelled',
              waited_ms: waitedMs,
              note: `${cancelledNote({ lang, waitedMs, resume: 'async_wait(wait_ms=...)' })}${settlePendingNote()}`,
              ...(hasTargets ? { targets: provenTargets() } : {})
            };
          }

          if (winner.name === 'wake') {
            if (winner.via === 'user') {
              return {
                status: 'interrupted',
                waited_ms: waitedMs,
                note: `${interruptedNote({ lang, waitedMs, resume: 'async_wait(wait_ms=...)' })}${settlePendingNote()}`,
                ...(await batchOutcome([])),
                targets: provenTargets()
              };
            }
            // 订阅带目标过滤：wake resolve 只能是 user 或 sender 命中——matched
            // 恒非 undefined（无目标等待不过滤，直接 message 出口）。不存在
            // 「非目标消息胜出后 continue 续等」的分支（那是被实证过的自旋缺陷）。
            const matched = agentTargetSpecs.find((spec) => spec.id === winner.sender);
            if (matched !== undefined) {
              // sender 命中的复查（设计 2.2 补实施，WAIT-SETTLE-GATE-01 同批）：
              // 现读注册表——idle/absent 按停止态交回并呈消息说明；running/
              // unknown 按现行 changed（不据消息制造停止事实）。
              const observed = agentStatusOf(ctx, matched.id);
              if (observed === 'idle' || observed === 'absent') {
                const target = new AgentTarget({ ctx, config, agentId: matched.id, owner, t });
                target.noteReported(observed);
                // 静止已证实：此前门化留下的标记一并清除（WAIT-SETTLE-GATE-01）。
                settleNoticeSeen.delete(matched.id);
                return {
                  status: 'settled',
                  agent_id: matched.id,
                  waited_ms: waitedMs,
                  note: `${t(lang, 'wait.targetMessage', { summary: winner.summary ?? '' })}\n${t(lang, observed === 'idle' ? 'via.idle' : 'via.noResident')}${settledNote({ lang, agentId: matched.id })}${settlePendingNote()}`,
                  ...(await batchOutcome([])),
                  targets: provenTargets(matched.id)
                };
              }
              return {
                status: 'changed',
                agent_id: matched.id,
                waited_ms: waitedMs,
                note: `${t(lang, 'wait.targetMessage', { summary: winner.summary ?? '' })}${settlePendingNote()}`,
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
            // 迟到作答只可唤醒无目标活等待（9.3.1，WAIT-WAKE-01）：有目标等待
            // 不以迟到作答结束——消息留在收件箱按宿主领取节奏处理；已 resolve
            // 的一次性信号从竞速成员排除（复用即自旋）。
            if (hasTargets) {
              lateResolved = true;
              continue;
            }
            return {
              status: 'message',
              waited_ms: waitedMs,
              note: t(lang, 'wait.lateArrived', { summary: winner.summary ?? '' }),
              ...(await batchOutcome([]))
            };
          }

          // 到期（与回退）：有目标 running 附各目标已证状态；无目标 budget。
          // 门化标记的到期附注（WAIT-SETTLE-GATE-01）：注册表久不翻转的缺陷
          // 形态退化为到期口径（运行态＋通知已见说明），不误报静止。
          const note = `${hasTargets
            ? t(lang, 'wait.budgetTargets')
            : t(lang, 'wait.budgetNoTargets')}${settlePendingNote()}`;
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
