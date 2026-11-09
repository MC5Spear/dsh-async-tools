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
 * （先到消息、迟到作答、批次汇集）报统一检查窗内的实际检查耗时（自调用起
 * 计，BA-05——固定 0 会把窗口内的真实成本藏掉；仍不挂起，耗时受
 * `ZERO_WAIT_CHECK_MS` 上限约束）；入口取消的零返回（订阅前打断）未执行任何
 * 检查，报 0；零等待的统一检查上限 `ZERO_WAIT_CHECK_MS`（DOC-ZERO-01，
 * 设计 §2.1——覆盖子代理目标关系屏障与无目标资格检查的共享查询窗口）是唯一可达
 * 秒级的零等待出口，窗口内未完成的判定按「条件未确认」交回，不猜状态。
 *
 * 活等待登记（设计 §2.6 批次锚点）：执行窗口开启即 `claimWait`，出口交付后
 * `releaseWait`＋`closeBatchIfIdle`——同一领取窗口并行等待汇入同一次模型输入、属同一批次，
 * 该主体全部本包活等待均已返回提交才关批。让位终局复查由 `releaseWait` 承担。
 *
 * @module dsh-async-tools/wait
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LOG_PREFIX, resolveWait } from './config.js';
import { buildToolText } from './descriptions.js';
import { ledger, terminalFacts, projectBatchEntry } from './delivery.js';
import { JOB_RESULT_EVENT } from './delivery-sources.js';
import {
  classifyWake, preexistingWakeMessage, unclaimedLateSources, unclaimedSettlement,
  watchLateAnswer, watchSubagentActivity, watchWakeSignal
} from './interrupts.js';
import { agentStatusOf, AgentTarget, describeEntry } from './wait-agent-target.js';
import { isTerminal, JobTarget } from './wait-job-target.js';
import { escapeLogValue, interruptedNote, cancelledNote, interruptedPreexistingNote, cancelledPreexistingNote, settledNote } from './output.js';
import { t } from './text.js';

/**
 * 单调时钟（设计 §2.1 的计时基）：t0、deadline、waited_ms 全走它。
 */
const monotonic = () => performance.now();

/**
 * 自旋防线（可测锚，W-SPIN-A）：产品形态恒为 1000。自旋指不产生新观察的连续
 * 重新进入——同一次预算内反复查到同一状态。防线只约束挂起后的胜者来源：事件、
 * 消息与用户插话是外部推进，计入没有意义；定时状态查询按 `pollIntervalMs`
 * 续排（默认 500 ms），是本包自排的检查动作、不是自旋——一次正等待最多
 * 约 maxWaitMs/pollIntervalMs 次（600000/500＝1200），把定时查询计入自旋会使
 * 防线在满额等待的中途误触（1000 < 1200），因此定时查询胜者不计入。对象形态
 * 是注入点：ESM 导出绑定只读，测试改 `value` 注入小上限，验证「定时查询胜者
 * 不计入计数」——不排除定时查询的旧计数形态必红。
 */
export const WAIT_SPIN_LIMIT = { value: 1000 };

/**
 * 零等待统一检查上限（DOC-ZERO-01，设计 §2.1）：`wait_ms=0` 的全部底层共享
 * 查询（入口 `jobs.list` 快照消费方、子代理关系屏障的共享 `listChildren`、
 * 无目标资格检查）共用一个真时钟窗口；窗口内未完成的判定按「条件未确认」
 * 交回。产品形态恒为 1000 ms（容差 200 ms 的断言基准在 T-ZW-1 实测装置）；
 * 对象形态是注入点（与 WAIT_SPIN_LIMIT 同款纪律），测试可注入小窗口验证
 * 「窗口耗尽按未确认交回、不无界阻塞」。
 */
export const ZERO_WAIT_CHECK = { ms: 1000 };

/** 交付批次附注（复用于全部出口支；items 显式 additionalProperties，宿主编译器
 * 要求）。终态结构化字段（REL-TERMINAL-01）可选：exit_code 仅非零、signal 已知
 * 才有、detail 为诊断首行＋省略计数——运行中条目三者皆无。 */
const DELIVERED_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      job_id: { type: 'string' },
      status: { type: 'string' },
      chars: { type: 'number' },
      truncated: { type: 'boolean' },
      exit_code: { type: 'number' },
      signal: { type: 'string' },
      detail: { type: 'string' }
    }
  }
};

/** 批次正文条目（触发目标正文在 output 字段，不重复入列；status_line 是与完成
 * 消息同款的状态行——设计 2.4「无输出或无详情也必须显示状态」，终态条目在其后
 * 换行追加标记行与诊断首行（REL-TERMINAL-01，多行字符串）；note 为读取失败
 * ／lossy／原文未附三态说明——readFailed 优先（其条目无正文且不附原文，注记即
 * 重试出路），lossy 与 echoSkipped 可并存换行拼接；echo/echo_truncated/
 * echo_kind＝完整命令回显附上的原文（ECHO-WORKFLOW-01，附上才有键；echo_kind
 * 供 render 取标签行 delivery.echoLabel.*，与让出／完成消息两载体同款投影）。 */
const OUTPUTS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      job_id: { type: 'string' },
      status_line: { type: 'string' },
      // 恢复头（RESULT-RECOVERY-01 §2.6）：标记行＋位置说明行——必要说明层，
      // 置于状态行后、正文前，不裁剪、不占内容预算（附上才有键）。
      recovery_line: { type: 'string' },
      note: { type: 'string' },
      // 完整命令回显原文（ECHO-WORKFLOW-01，附上才有键）。
      echo: { type: 'string' },
      echo_kind: { type: 'string' },
      echo_truncated: { type: 'boolean' },
      text: { type: 'string' },
      exit_code: { type: 'number' },
      signal: { type: 'string' },
      detail: { type: 'string' }
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

/** render 镜像渲染的逐目标状态行上限（WAIT-TARGET-STATE-CERTAINTY）：超限目标
 * 只保留计数汇总行（wait.targetsMore），可见文本有界、不为长清单失控；结构化
 * `targets` 字段完整不受限。 */
const WAIT_TARGET_LINES_MAX = 8;

/**
 * 目标状态行归类（设计 §3.2.6 到期提示的三档与计数串）：「仍在执行」＝目标行
 * 的非终态已证状态——作业行 `running`／`stopping` 等尚未收尾状态（宿主作业清单
 * 实有 `stopping`，需求 9.3.1 点名其按非终态处理），子代理行 `running`（仅此
 * 一种非终态已证状态）。词表外状态保守计入仍在执行——行内原词照显，不因无法
 * 归类给出「不再运行」的放弃指引。`completed`/`failed`/`killed`＝已结束；
 * `idle`/`absent`＝不再运行；`not_found`＝查无；`unknown`＝未证实。
 * @param {string} status - provenTargets 行状态词（原词透传）。
 * @returns {'executing'|'finished'|'stopped'|'notFound'|'unconfirmed'} 归类段名。
 */
function targetClassOf(status) {
  if (status === 'completed' || status === 'failed' || status === 'killed') return 'finished';
  if (status === 'idle' || status === 'absent') return 'stopped';
  if (status === 'not_found') return 'notFound';
  if (status === 'unknown') return 'unconfirmed';
  return 'executing';
}

/**
 * 计数串文本（占位 `{tally}`）：按固定段序组合非零段，两语各自连接符（zh 顿号、
 * en 逗号），至多 5 段。
 * @param {object[]} rows - provenTargets 行集。
 * @param {string} lang - 语言档。
 * @returns {string} 计数串；空行集返回空串。
 */
function tallyText(rows, lang) {
  const counts = { executing: 0, finished: 0, stopped: 0, notFound: 0, unconfirmed: 0 };
  for (const row of Array.isArray(rows) ? rows : []) counts[targetClassOf(row?.status)] += 1;
  return ['executing', 'finished', 'stopped', 'notFound', 'unconfirmed']
    .filter((key) => counts[key] > 0)
    .map((key) => t(lang, `wait.tally.${key}`, { count: counts[key] }))
    .join(lang === 'zh' ? '、' : ', ');
}

/**
 * 到期提示三档取键（WAIT-TARGET-STATE-CERTAINTY）：全部行已证仍在执行→
 * `wait.budgetTargets`（重写）；无一行已证仍在执行→`wait.budgetTargetsNone`；
 * 其余（部分仍在执行，余未证实或不再运行）→`wait.budgetTargetsMixed`。不无条件
 * 断言「各目标仍在运行」。导出供测试直测档位归属（stopping 等非终态词表）。
 * @param {object[]} rows - provenTargets 行集。
 * @returns {string} 词典键名。
 */
export function budgetTierKey(rows) {
  let executing = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (targetClassOf(row?.status) === 'executing') executing += 1;
  }
  if (Array.isArray(rows) && rows.length > 0 && executing === rows.length) return 'wait.budgetTargets';
  if (executing === 0) return 'wait.budgetTargetsNone';
  return 'wait.budgetTargetsMixed';
}

/**
 * render 镜像：`targets` 结构化行 → 模型可见的逐目标状态行（WAIT-TARGET-STATE-
 * CERTAINTY）。状态词沿用 provenTargets 词汇原词、两语同词；`unknown` 行用专属
 * 键附行内「（读取失败）」限定——逐目标行的未知原因在行内可见，不依赖档位总述。
 * 超上限只保留汇总行（溢出行的计数串）。
 * @param {object[]} rows - `value.targets`。
 * @param {string} lang - 语言档。
 * @returns {string|undefined} 状态行块；无行集时 undefined。
 */
function renderTargetLines(rows, lang) {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const lines = rows.slice(0, WAIT_TARGET_LINES_MAX).map((row) => t(lang,
    row?.status === 'unknown' ? `wait.targetLine.${row?.kind === 'agent' ? 'agent' : 'job'}Unknown`
      : `wait.targetLine.${row?.kind === 'agent' ? 'agent' : 'job'}`,
    { id: row?.id ?? '', status: row?.status ?? '' }));
  if (rows.length > WAIT_TARGET_LINES_MAX) {
    lines.push(t(lang, 'wait.targetsMore', {
      count: rows.length - WAIT_TARGET_LINES_MAX,
      tally: tallyText(rows.slice(WAIT_TARGET_LINES_MAX), lang)
    }));
  }
  return lines.join('\n');
}

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
    // 输出 schema：下列状态分支覆盖全部出口（设计 §3.2.6）。批次附注（delivered/outputs/deferred/
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
      // 的作业在批次中可见）；截断标记由条目文本自带的省略量说明承担。回显原文
      // 块（ECHO-WORKFLOW-01 设计 §6.5）：状态行之后、正文之前，类别标签行
      //（delivery.echoLabel.command/script，按 echo_kind 取词）＋文本成块呈现
      // ——与让出返回／完成消息的 render 同款行序。
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.output === undefined ? undefined : value.output,
          value.note,
          // 逐目标状态行镜像（WAIT-TARGET-STATE-CERTAINTY）：凡携带 targets 的
          // 出口统一生效（到期、自旋防线、零等待、插话、取消、changed／settled）
          //——note 之后再列状态行，outputs 随后。
          renderTargetLines(value.targets, config.agentLang),
          Array.isArray(value.outputs) && value.outputs.length > 0
            ? value.outputs.map((item) => `── ${item.job_id} ──\n${item.status_line}${item.recovery_line === undefined ? '' : `\n${item.recovery_line}`}${item.echo === undefined ? '' : `\n${t(config.agentLang, item.echo_kind === 'script' ? 'delivery.echoLabel.script' : 'delivery.echoLabel.command')}\n${item.echo}`}${item.text === '' ? '' : `\n${item.text}`}${item.note === undefined ? '' : `\n${item.note}`}`).join('\n\n')
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
      const checkDeadline = t0 + Math.max(0, ZERO_WAIT_CHECK.ms);
      const elapsed = () => Math.max(0, Math.round(monotonic() - t0));
      const agentIds = agentTargetSpecs.map((target) => target.id);

      // DOC-ZERO-01（设计 §2.3「查询各只发起一次」）：零等待入口恰一次
      // `jobs.list(owner)` 共享快照——全部作业目标的存在性／终态判定、运行中
      // 增量读取、对账发现与无目标资格检查读同一结果（本地查找，不再逐目标
      // 全量重查）；查询失败按 failed 档如实交回。正等待不取共享快照（各处
      // 现查，维持既有口径与 §2.4 的出口约束）。
      let sharedRows;
      if (waitMs === 0) {
        try {
          const rows = ctx.jobs?.list?.(owner);
          if (Array.isArray(rows)) sharedRows = rows;
        } catch { /* 查询失败：作业目标按 failed 档、无目标按未确认口径交回；出口对账按空集哨兵关闭补查（恰一次，minor ②） */ }
      }
      /** 作业目标快照统一入口：零等待读共享快照，正等待逐目标现查。 */
      const snapOf = (job) => (waitMs === 0 ? job.snapshotFrom(sharedRows) : job.snapshot());

      // 活等待登记（设计 §2.6 批次锚点）：执行窗口开启即登记，出口统一注销。
      const waitToken = ledger.claimWait(owner);

      /** 最近一次 collectBatch 装配的条目（出口异常时逐项回滚——空数组回滚是
       * 空操作，装配记录必须真实，设计 §2.6「读取后尚未提交时防止内容丢失」）。 */
      let lastCollected = [];

      /**
       * 账本×清单的双向对账（RA-FOREIGN-DISCOVERY，需求 9.3.2；设计 §1.2.3）：
       *
       * - **账本外终态行**：主体有权访问的其他生产者作业已终态、公开作业服务
       *   可读、从未被本包等待过——按原有权限入账（`ensureRegistered`，行在手
       *   即存在证据）并读取，正文随后经正常批次交付。
       * - **账本内 terminal 空的终态行**：先前观察入账时在运行、此后静默转终态
       *   （无事件、无通知）——补一次定论读取；成功就绪后广播内容就绪事件唤醒
       *   挂起等待，失败按 readFailed 口径入账（可重试）。在途读取跳过（幂等）。
       * - **其余形态**：账本内已证终态（交付去重由 deliveredFact 承担）、跨主体
       *   条目（防御）与非终态行都不动。
       *
       * 已入账的已交付、已延后、读取失败可重试不重复发现，账本的 deliveredFact
       * 天然去重（「区分已送达正文与只有状态的通知」：宿主通知只报状态，正文
       * 交付仍由本包承担）。清单查询失败不发现、不假冒（无目标路径的 unknown
       * 口径另行如实报告）；入账的跨主体防御与读取失败定论都在 JobTarget /
       * readSettled 内部处理。对账是增益不是前置：任何一步失败只跳过该作业，
       * 不让等待出口抛错。
       *
       * @param {object[]|undefined} rows 共享行集（零等待传入口快照、复查周期传
       *   当期行集）；`undefined` 时现查一次（正等待出口的既有口径）。
       */
      const discoverForeignResults = async (rows) => {
        let list = rows;
        if (list === undefined) {
          try {
            list = ctx.jobs?.list?.(owner);
          } catch {
            return;
          }
        }
        if (!Array.isArray(list)) return;
        for (const row of list) {
          if (row === null || row === undefined || !isTerminal(row?.status)) continue;
          const existing = ledger.jobs.get(row.id);
          if (existing !== undefined) {
            // 跨主体条目不对账（串账防御与 JobTarget 同源）。
            if (existing.owner !== owner) continue;
            if (existing.terminal !== null || existing.readInFlight !== null) continue;
            try {
              await ledger.readSettled(row.id, row);
            } catch { /* 读取定论已按 readFailed 口径入账——继续 */ }
            continue;
          }
          try {
            const target = new JobTarget({ ctx, config, jobId: row.id, owner, t, lang });
            target.ensureRegistered();
            await target.readSettled(row);
          } catch { /* 防御拒绝或读取定论已按 readFailed 口径入账——继续 */ }
        }
      };

      /** 本批交付条目的出口投影（全部出口共用；交付失败回滚由 finally 承担）。
       * 批次正文随本返回携带（设计 §2.6「内容随等待返回交付」）：`outputs` 是
       * 本批各条目的正文；触发目标的正文由 `trigger` 携带（终态出口的 `output`
       * 字段），不重复入列——collectBatch 装配即消费缓冲，出口不得再读缓冲。
       * `includeRunning`（零等待主出口使用，设计 §3.2.3）：运行中目标的当前增量
       * 也装配（terminal 为空 → status 'running'）；其余出口不传——只带终态批。 */
      const batchOutcome = async (triggerJobIds, excludeJobId = undefined, options = {}) => {
        // 先对账后装配（RA-FOREIGN-DISCOVERY）：账本外已终态的可用结果先入账
        // 读取、账本内 terminal 空的终态行先补定论读取，再进批次——零等待、
        // 无目标挂起与显式其他目标的全部出口共用本函数，对账随之覆盖全部出口；
        // 本包活等待在场，就绪内容并入本次返回而不是另发完成消息。行集来源
        //（设计 §2.4）：显式传入（复查周期复用当期行集）＞零等待共享入口快照
        //（**入口已取而失败时传空集哨兵**——失败形态同样恰一次，不再现查，
        // minor ②）＞正等待现查一次。
        await discoverForeignResults(
          options.discoveryRows !== undefined
            ? options.discoveryRows
            : (waitMs === 0 ? (sharedRows ?? []) : undefined)
        );
        const { delivered, deferred, deferredNote } = ledger.collectBatch(owner, {
          triggerJobIds, lang,
          // 恢复消费限定等待载体（RECOVERY-YIELD-CARRIER）：async_wait 的全部
          // 出口经本函数装配——只有这里显式消费挂起的恢复请求；async_run／
          // async_workflow 的让出批次不传该选项（delivery.js 默认不消费）。
          consumeRecovery: true,
          ...(options.includeRunning === true ? { includeRunning: true } : {}),
          // 载体信号（RESULT-RECOVERY-01 §3.2）：等待载体的副本记录装配调用的
          // exec.signal，回合收尾确认时复检中止（R3 收窄）。
          ...(exec.signal !== undefined && exec.signal !== null ? { carrierSignal: exec.signal } : {})
        });
        lastCollected = delivered;
        const triggerEntry = excludeJobId === undefined
          ? null
          : delivered.find((item) => item.jobId === excludeJobId) ?? null;
        const statusOf = (item) => (item.terminal === null ? 'running' : item.terminal.status);
        // 终态结构化字段（REL-TERMINAL-01）：三载体共用的 `terminalFacts`（等待、
        // 命令/编排让出与完成消息的终态字段逐字一致——RA-YIELD-FACTS 的一致性
        // 基准就放在 delivery.js）。运行中条目不带。
        return {
          delivered: delivered.map((item) => ({
            job_id: item.jobId,
            status: statusOf(item),
            chars: item.chars,
            truncated: item.truncated,
            ...terminalFacts(item.terminal, lang)
          })),
          // 空正文条目**保留**（设计 2.4：无输出完成的作业在批次中以状态行可见，
          // 不因正文为空而消失）；状态行与完成消息同款（delivery.completionItem），
          // 经 clampNote 入界（需求 9.3.2 说明有界）。说明分两档：状态行（≤200）
          // ＋标记行（<60）＋诊断首行（≤200）属必要结局行——单条目 ≤460、单批
          //（条目上限 10）合计 ≤4600，不入降级序列（REL-TERMINAL-01：退出码、
          // 失败原因、终止事实不因内容预算丢失）；可降级说明（lossy／留存行）
          // 单行 ≤200、合计 ≤2000（两档推导见 delivery.js 模块头）。运行中增量
          // 条目分键（completionItemRunning）——「settled: running」自相矛盾
          //（曾实证的自相矛盾形态），且不带终态字段与追加行。
          // RA-STATUSLINE-DRIFT：条目投影统一走 delivery.projectBatchEntry
          //（与让出出口、完成消息注记段同一实现；运行中分键与 recovery_line
          // 由该函数直接支持——此前本模块自带副本已与批次投影漂移）。
          // RA-SPILL-PATH：留存线索经共享注记构造器逐条交付，不按 lossy 筛选。
          outputs: delivered
            .map((item) => (item.jobId === excludeJobId
              // 触发目标：状态行随批可见（WAIT-STATUS-01——终态信息进模型文本，
              // 不只藏在结构化 value），正文由出口 `output` 字段携带，此处置空
              // 不重复渲染。
              ? { ...item, text: '', remainder: undefined }
              : item))
            .map((item) => projectBatchEntry(item, lang)),
          deferred,
          ...(deferredNote === '' ? {} : { note_deferred: deferredNote }),
          ...(triggerEntry === null ? {} : {
            // chars＝本批装配份额（#takeShare 产物的 cut.text.length；空正文为 0）
            // ——出口注记按「实际附带了多少」陈述时取它（REL-RECOVER-02 的
            // partialDelivered），不读账本缓冲（装配后缓冲已被清空或重置）。
            trigger: {
              text: triggerEntry.text,
              truncated: triggerEntry.truncated,
              chars: triggerEntry.chars,
              // 恢复份额识别（§2.6）：触发目标条目是恢复条目时携带——出口把
              // 恢复头（标记行＋位置说明行）置于正文前，且不走续段注记。
              ...(triggerEntry.recovery === true
                ? { recovery: true, recoveryHead: triggerEntry.recoveryHead }
                : {})
            }
          })
        };
      };

      /** 其余目标已证状态（设计 §3.2.6：全部出口附注，不因单一事件丢弃观察）。
       * 作业行零等待读共享入口快照（DOC-ZERO-01），正等待现查。 */
      const provenTargets = (excludeId, unconfirmedIds) => {
        const rows = [];
        for (const job of jobTargets) {
          if (job.jobId === excludeId) continue;
          const snapshot = snapOf(job);
          if (snapshot.state === 'found') {
            rows.push({ kind: 'job', id: job.jobId, status: snapshot.row.status });
          } else {
            rows.push({ kind: 'job', id: job.jobId, status: snapshot.state === 'missing' ? 'not_found' : 'unknown' });
          }
        }
        for (const spec of agentTargetSpecs) {
          if (spec.id === excludeId) continue;
          // 屏障未证实资格的目标按「未确认」标注（DOC-ZERO-01 设计 §2.3：不猜
          // 不存在、不猜终态——agentStatusOf 的 absent/idle 都是本次没能证实的
          // 断言）。
          rows.push({
            kind: 'agent',
            id: spec.id,
            status: unconfirmedIds?.has(spec.id) === true ? 'unknown' : agentStatusOf(ctx, spec.id)
          });
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
        // RA-EXIT-CLEANUP 同款：接线失败的注销自身抛错不覆盖原始接线错误。
        try {
          await ledger.releaseWait(waitToken, owner);
        } catch (releaseError) {
          ctx.logger?.warn?.(
            `${LOG_PREFIX} wait release after wiring failure also failed: ${String(releaseError?.message ?? releaseError)}`
          );
        }
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
      /** 一次性唤醒信号已消费（RA-BARRIER-WAKE）：它 resolve 后任何新竞速都会被
       * 同一值立即「胜出」，后续查询与挂起竞速自此排除该信号——已见消息由校验
       * 完成后的返回条件消费，不再作为竞速成员。 */
      let wakeSpent = false;
      const cancelled = new Promise((_resolve, reject) => {
        execAbort.signal.addEventListener('abort', () => reject(execAbort.signal.reason ?? new Error('aborted')), { once: true });
      }).then(() => ({ name: 'cancelled' }), () => ({ name: 'cancelled' }));

      /**
       * 存在屏障查询的竞速包装（设计 §2.1，WAIT-TIME-01）：屏障与工具取消、
       * 订阅消息、总截止**同时竞速**，至多三个周期、每个周期受剩余预算约束——屏障挂起
       * 不再无界阻塞入口（原缺陷：listChildren 不返时整个等待卡在入口校验）。
       * 零等待不进入竞速（设计 §2.1「立即交回」）：在途查询只发起一次，
       * 竞速对象仅为工具取消与固定响应上限，周期内未完成按未证实交回。
       * 入参是 **Promise 工厂**（RA-SYNC-LISTING-GUARD）：宿主 `listChildren`
       * 同步 throw 时在工厂链内归一为查询失败（entry＝undefined），与异步
       * reject 同径——不冒出调用方、不变成整次调用错误；同一工厂传入同一
       * 在途查询即「不重发、只重等」。
       * @param {Function} provider - 返回在途查询 Promise 的工厂。
       * @returns {Promise<{kind: 'entry'|'cancelled'|'wake'|'timeout', value?: object|null}>}
       *   四分：查询结果／被取消／消息中断／周期内未完成。
       */
      const raceQuery = async (provider) => {
        const wrapped = Promise.resolve()
          .then(provider)
          .then(
            (value) => ({ kind: 'entry', value }),
            () => ({ kind: 'entry', value: undefined })
          );
        if (waitMs === 0) {
          // DOC-ZERO-01（设计 §2.3 机制 1）：零等待的统一检查窗口——不再用固定
          // 2000 ms 切片，而是 `checkDeadline - now`（入口 t0 起 ZERO_WAIT_CHECK.ms）；
          // 窗口耗尽按「未确认」交回（调用方按 timeout 分支处理），剩余不正同样
          // 落入耗尽口径。取消先到立即返回，不等窗口也不等在途查询。
          const slice = checkDeadline - monotonic();
          const winner = slice <= 0
            ? { kind: 'timeout' }
            : await Promise.race([
              wrapped,
              new Promise((resolve) => {
                const timer = setTimeout(() => resolve({ kind: 'slice' }), slice);
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
            ...(wakeSpent ? [] : [wakeSignal.then((value) => ({ kind: 'wake', value }))])
          ]);
          if (winner.kind === 'entry') return { kind: 'entry', value: winner.value };
          if (winner.kind === 'cancelled') return { kind: 'cancelled' };
          if (winner.kind === 'wake') return { kind: 'wake', value: winner.value };
          // 本周期到点：下一周期继续与同一在途查询竞速（不重发）。
        }
        return { kind: 'timeout' };
      };

      /**
       * 竞速结果的唤醒重等（RA-AGENT-RECHECK 抽取）：目标消息／结算通知不切断
       * 校验（§3.2.2）——非用户唤醒标记 `wakeSpent` 后与同一在途查询重等（「不重
       * 发」只对传入的既有在途查询成立——raceQuery 内部多周期竞速同一 Promise；
       * 纠错清单入口是新一次查询、经各自工厂重发一次属设计行为），用户插话原样
       * 上抛由调用方切断。此前这段逻辑内联在屏障循环里，屏障重查引入后两处共用。
       * @param {Function} provider - 在途查询 Promise 工厂（重等时传同一工厂）。
       * @returns {Promise<object>} raceQuery 四分（wake 只剩用户档）。
       */
      const raceWithWakeReawait = async (provider) => {
        let outcome = await raceQuery(provider);
        while (outcome.kind === 'wake' && outcome.value?.via !== 'user') {
          wakeSpent = true;
          outcome = await raceQuery(provider);
        }
        return outcome;
      };

      /**
       * 存在屏障查询＋短暂不可见重查（RA-AGENT-RECHECK，设计 §2.1「屏障重试至
       * 多三个查询周期」与 §3.2.2）：正等待下查无不立即拒绝——刚创建的子代理在
       * 目录中短暂不可见是已登记的窗口形态（需求 §2.3.3「短暂尚不可见的重查受
       * 总预算约束」）。首个周期查无后，睡眠 `min(pollIntervalMs, deadline -
       * now)` 再**重发**新查询，连同首查至多三个查询周期；睡眠与查询都与工具
       * 取消、用户插话、总截止竞速（§2.1 竞速规则——睡眠不吃满预算、不以轮询
       * 间隔放大总时长）。剩余预算不正按 timeout 交回（未证实，不冒称查无）；
       * 三个周期仍查无才交回查无出口。零等待不重查（DOC-ZERO-01：恰一次共享
       * 查询）。
       * @param {AgentTarget} target - 目标句柄。
       * @returns {Promise<object>} raceQuery 四分；`entry` 值为行／null（查无）／
       *   undefined（查询失败）。
       */
      const resolveChildEntry = async (target) => {
        // 每周期恰一次宿主查询：查询对象先创建、竞速与唤醒重等都闭包同一在途
        // Promise（RA-BARRIER-WAKE：唤醒后重等**不重发**，重发会把「至多三周期」
        // 放大成实际更多次宿主查询）；重查周期之间才发新查询。
        let pendingEntry = target.childEntry(raceAbort.signal);
        let outcome = await raceWithWakeReawait(() => pendingEntry);
        if (waitMs === 0 || outcome.kind !== 'entry' || outcome.value !== null) return outcome;
        // pollIntervalMs 本身经设置校验有下限（FIELD_MIN=1）；不另设 50ms 下限——
        // 屏障重查的睡眠预算受总截止封顶（min 第二参），小周期配置是合法形态。
        const pollInterval = Math.max(1, Number(config.pollIntervalMs ?? 500));
        for (let cycle = 1; cycle <= 2; cycle += 1) {
          const sleepMs = Math.min(pollInterval, deadlineAt - monotonic());
          if (sleepMs <= 0) return { kind: 'timeout' };
          const slept = await Promise.race([
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve({ kind: 'slept' }), sleepMs);
              if (typeof timer.unref === 'function') timer.unref();
            }),
            cancelled.then((value) => ({ kind: 'cancelled', value })),
            ...(wakeSpent ? [] : [wakeSignal.then((value) => ({ kind: 'wake', value }))])
          ]);
          if (slept.kind === 'cancelled') return { kind: 'cancelled' };
          if (slept.kind === 'wake' && slept.value?.via === 'user') return { kind: 'wake', value: slept.value };
          // 非用户消息不切断校验：继续本周期重查（不标记 wakeSpent——睡眠竞速
          // 命中未消费信号，若在此标记会让下一查询失去与消息竞速的机会；下一
          // 查询经 raceWithWakeReawait 消费它）。
          // 睡眠到点后、发起新查询前复检总截止（RA-AGENT-RECHECK-DEADLINE）：
          // sleepMs 封顶只保证「不早于截止醒来」，调度停顿会让实际醒来晚于截止
          // ——过期后不再发起新的目录查询（发起了也只是被总截止竞速掐掉的过期
          // 请求），按 timeout 交回；诊断由重查耗尽口径如实说明，不把过期发查询
          // 的读数写成宿主未应答。
          if (deadlineAt - monotonic() <= 0) return { kind: 'timeout' };
          pendingEntry = target.childEntry(raceAbort.signal);
          outcome = await raceWithWakeReawait(() => pendingEntry);
          if (outcome.kind !== 'entry' || outcome.value !== null) return outcome;
        }
        return outcome;
      };

      /**
       * 无目标挂起资格检查（设计 §3.2.5 工作前提，WAIT-EMPTY-01）：确认存在
       * 可等待工作才挂起——宿主作业清单的非终态行、`agents` 注册表里运行中的
       * 合法子代理。资格**只**来自公开清单（RA-FOREIGN-DISCOVERY 修复：不再用
       * 账本在册状态判资格——残条不制造空等，账本内工作的交付由对账与就绪
       * 事件驱动）。检查只读本主体可查的公开清单，不扩大权限；任一清单查询
       * 失败记 `unknown`（不假装无工作）。
       * 子代理清单查询经 `raceQuery` 与取消、消息、总截止竞速（WAIT-TIME-01
       * 同缺陷类）：挂起不无界阻塞出口，竞速胜出时以 `interrupt` 交回。
       *
       * 周期复查（WAIT-OBSERVE-01）与入口检查同源共用本函数：复查周期经
       * `options.signal` 换用每周期独立的 AbortController（窗口耗尽即取消底层
       * 查询，不悬挂宿主），`options.onQueryLaunched` 在查询发起后立即回调
       * （复查循环据此登记在途标志——上一周期在途未结则跳过本周期发起）。
       * 目录查询走 Promise 工厂（RA-SYNC-LISTING-GUARD）：宿主 `listChildren`
       * 同步 throw 在工厂内归一为查询失败，与异步 reject 同径交 `unknown`；
       * 复查跳过发起的判定（`onQueryLaunched` 未回调）不受影响。
       * @param {object} [options] - `{signal?, onQueryLaunched?}`。
       * @returns {Promise<{work: boolean, unknown: boolean, unknownCount: number,
       *   rows?: object[], interrupt?: 'cancelled'|{wake: object}}>} `rows` 是本次
       * 清单结果（可用时），供复查周期的对账复用（§2.4「不重复查询」）。
       * `unknownCount` 是本次检查的未证实读数计数（WAIT-NO-TARGET-UNKNOWN：
       * jobs.list 失败/清单非数组、listChildren 超时/非数组、单行 agents.get
       * 读取失败各计其数）——有其他已证运行工作照常挂起，全部行无已证运行时
       * 按未证实交回；无目标到期注记（wait.budgetNoTargetsUnknown）取最近一次
       * 完成检查的该计数。
       */
      const waitWorthyWork = async (options = {}) => {
        let unknownCount = 0;
        let rows;
        try {
          rows = ctx.jobs?.list?.(owner);
        } catch {
          rows = undefined;
        }
        if (Array.isArray(rows)) {
          if (rows.some((row) => row && !isTerminal(row?.status))) {
            return { work: true, unknown: false, unknownCount: 0, rows };
          }
        } else {
          unknownCount += 1;
        }
        const childrenOutcome = await raceQuery(() => {
          const query = ctx.subagents.listChildren(owner, options.signal ?? raceAbort.signal);
          if (typeof options.onQueryLaunched === 'function') options.onQueryLaunched(query);
          return query;
        });
        if (childrenOutcome.kind === 'cancelled') return { work: false, unknown: unknownCount > 0, unknownCount, rows, interrupt: 'cancelled' };
        if (childrenOutcome.kind === 'wake') return { work: false, unknown: unknownCount > 0, unknownCount, rows, interrupt: { wake: childrenOutcome.value } };
        if (childrenOutcome.kind === 'timeout') return { work: false, unknown: true, unknownCount: unknownCount + 1, rows };
        const children = childrenOutcome.value;
        if (Array.isArray(children)) {
          for (const child of children) {
            if (child?.kind === 'diagnostic') continue;
            const status = agentStatusOf(ctx, child.id);
            // WAIT-NO-TARGET-UNKNOWN：work:true 提前返回携带**累计**计数（C4：
            // 写死 0 会丢「有工作但最近一次检查带未证实读数」的事实——挂起照常，
            // 无目标到期注记按最近一次完成检查如实反映）。
            if (status === 'running') return { work: true, unknown: unknownCount > 0, unknownCount, rows };
            // 单行读取失败（agentStatusOf 归一为 unknown）保留未证实标记并继续
            // 遍历——不折叠成「没有可等待工作」，也不把未知当运行；有其他已证
            // 运行行时照常在上行返回。
            if (status === 'unknown') unknownCount += 1;
          }
        } else {
          unknownCount += 1;
        }
        return { work: false, unknown: unknownCount > 0, unknownCount, rows };
      };

      /** 子代理轮询周期（设计 §3.2.4 双通道之二，WAIT-AGENT-01）：事件通道失明时
       * 的备用观察——每 max(50, pollIntervalMs) 重查注册表公开状态（定时下限
       * 50 ms：极小间隔配置在事件失明时不退化为密集查询；设置校验的合法下限
       * 仍为 1，见设计 §3.2.5 间隔说明）。每周期一个新 promise
       * （一次性 promise 复用即自旋）；句柄供 cleanup 清除。 */
      let pollTimerHandle = null;
      const pollBeat = () => new Promise((resolve) => {
        pollTimerHandle = setTimeout(() => resolve({ name: 'agent-poll' }),
          Math.max(50, Number(config.pollIntervalMs ?? 500)));
        if (typeof pollTimerHandle.unref === 'function') pollTimerHandle.unref();
      });

      /** 无目标挂起的周期复查（WAIT-OBSERVE-01，按 2026-11-01 的决策实施）：按
       * `pollIntervalMs` 查询周期复查挂起资格所依据的清单（内容与入口检查同源——
       * `waitWorthyWork`），镜像 pollBeat 形态：每周期一个新 promise、按周期重排、
       * 不叠加异步 interval；句柄供 cleanup 清除。仅无目标挂起入竞速（有目标
       * 等待的显式目标由 3.2.4 的事件与备用轮询观察，复查不重复轮询它们）。
       * 实取间隔 max(50, pollIntervalMs)——与 pollBeat 同款定时下限（设计 §3.2.5
       * 间隔说明），不抬设置校验的合法下限。 */
      let recheckTimerHandle = null;
      const recheckBeat = () => new Promise((resolve) => {
        recheckTimerHandle = setTimeout(() => resolve({ name: 'work-recheck' }),
          Math.max(50, Number(config.pollIntervalMs ?? 500)));
        if (typeof recheckTimerHandle.unref === 'function') recheckTimerHandle.unref();
      });

      /** 复查在途查询的两重防线（WAIT-OBSERVE-01 前置条件）：每周期独立
       * AbortController（raceQuery 窗口耗尽即取消底层 listChildren，不悬挂
       * 宿主）；上一周期在途未结则跳过本周期发起（慢／挂目录下不在宿主累积查询，
       * 主循环内在途目录查询至多一路）。 */
      let recheckAbort = null;
      let recheckQueryInFlight = false;
      // 最近一次**完成**的资格检查的未证实读数计数（WAIT-NO-TARGET-UNKNOWN：
      // 入口检查与周期复查都更新；被打断的检查不覆盖旧值）。无目标到期时若仍
      // 大于 0，在到期说明后附 wait.budgetNoTargetsUnknown 注记——不把未知折叠
      // 为运行或结束。
      let lastWorthyUnknown = 0;

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
              // 事件通道 resolve 即存在证明（RA-FOREIGN-DISCOVERY）：结算或到期
              // 释放的 JobView 都证实作业存在，观察目标此刻幂等入账。
              try {
                job.ensureRegistered();
              } catch { /* 跨主体防御拒绝：事件成员照常交回，出口另行处理 */ }
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

      // RA-EXIT-CLEANUP：清理逐项执行、逐项隔离。finally 里抛错会**覆盖**
      // 正常返回值或 catch 原样上抛的原始错误（此前任一步骤抛错＝后续步骤
      // 被跳过：releaseWait 不执行会把活等待登记永久留在账本，压住同主体
      // 后续完成消息）。每步失败记 warn（可观测、不静默），全部步骤照常
      // 尝试，清理失败不改变出口结果。
      const cleanup = async () => {
        const steps = [
          () => interrupt.dispose(),
          () => lateWatch.dispose(),
          () => { if (readyDispose !== null) readyDispose(); },
          () => { for (const { watcher } of watchers) watcher.dispose(); },
          () => { if (pollTimerHandle !== null) clearTimeout(pollTimerHandle); },
          () => { if (recheckTimerHandle !== null) clearTimeout(recheckTimerHandle); },
          () => { if (execWired) exec.signal.removeEventListener('abort', onExecAbort); },
          () => { if (typeof deadlineTimer === 'function') deadlineTimer(); },
          // 复查周期的底层查询用独立 signal，须单独取消（不悬挂宿主）。
          () => { if (recheckAbort !== null) recheckAbort.abort(new Error('async-tools: wait concluded')); },
          () => raceAbort.abort(new Error('async-tools: wait concluded')),
          () => ledger.releaseWait(waitToken, owner),
          () => ledger.closeBatchIfIdle(owner)
        ];
        for (const step of steps) {
          try {
            await step();
          } catch (error) {
            ctx.logger?.warn?.(
              `${LOG_PREFIX} wait cleanup step failed: ${String(error?.message ?? error)}`
            );
          }
        }
      };

      try {
        // ── 入口校验遍（WAIT-TARGET-01：全部目标必要校验先于任何终态／变化
        // 返回——含先到结算通知出口，§3.2.2/§3.2.4；屏障与取消/用户插话/总
        // 截止竞速，WAIT-TIME-01。校验期间目标消息与结算通知不切断校验：登记
        // 在收件箱不消费，校验完成后的返回条件按 §3.2.4 次序消费）────────────
        const jobSnapshots = new Map();
        for (const job of jobTargets) {
          // 零等待读共享入口快照（DOC-ZERO-01 恰一次 jobs.list），正等待逐目标
          // 现查；快照命中即存在证明——观察目标此刻幂等入账（RA-FOREIGN-
          // DISCOVERY：构造不预注册，查无拒绝零残留）。
          const snapshot = snapOf(job);
          if (snapshot.state === 'failed') {
            throw new Error(t(lang, 'error.queryFailed'));
          }
          if (snapshot.state === 'missing') {
            throw new Error(t(lang, 'error.unknownJob', { jobId: job.jobId }));
          }
          job.ensureRegistered();
          jobSnapshots.set(job.jobId, snapshot);
        }
        const agentEntryOutcomes = new Map();
        let barrierWake = undefined;
        let barrierCancelled = false;
        // 结算通知命中的目标以通知替代目录关系证明（§3.2.4）：校验遍跳过其
        // 屏障、不为它另发查询；其余子代理目标照常校验——任一查无/查询失败/
        // 跨主体拒绝仍整次可读拒绝，通知不被拒绝消费、留收件箱。
        const noticeHit = new Set();
        for (const spec of agentTargetSpecs) {
          if (unclaimedSettlement(agent, spec.id) !== null) noticeHit.add(spec.id);
        }
        const barrierSpecs = agentTargetSpecs.filter((spec) => !noticeHit.has(spec.id));
        // DOC-ZERO-01（设计 §2.3 机制 2）：零等待的全部子代理目标共享一次
        // `listChildren`——返回后本地按 id 过滤；窗口耗尽或查询失败（raceQuery
        // 归一后同径）按「未确认」交回，不猜不存在、不猜终态；迟到完成的查询
        // 结果丢弃（只读观察，落败 resolve 无副作用）。全部目标都命中结算通知
        // 时不再发起共享查询（通知即关系证明）。
        let sharedChildren;
        let sharedChildrenTaken = false;
        if (waitMs === 0 && barrierSpecs.length > 0) {
          // 共享查询走 Promise 工厂（RA-SYNC-LISTING-GUARD）：同步 throw 与
          // 异步 reject 同径归一为未确认。
          const sharedOutcome = await raceQuery(() => ctx.subagents.listChildren(owner, raceAbort.signal));
          if (sharedOutcome.kind === 'cancelled') { barrierCancelled = true; }
          else if (sharedOutcome.kind === 'entry' && Array.isArray(sharedOutcome.value)) {
            sharedChildren = sharedOutcome.value;
            sharedChildrenTaken = true;
          } else {
            sharedChildrenTaken = true; // 挂起或失败：全部子代理目标按未确认交回
          }
        }
        if (!barrierCancelled && barrierWake === undefined) {
          for (const spec of barrierSpecs) {
            const target = new AgentTarget({ ctx, config, agentId: spec.id, owner, t });
            let outcome;
            if (sharedChildrenTaken) {
              outcome = { kind: 'entry', value: Array.isArray(sharedChildren)
                ? sharedChildren.find((row) => row?.id === spec.id && row?.kind !== 'diagnostic') ?? null
                : undefined };
            } else {
              // 屏障查询经 resolveChildEntry（RA-AGENT-RECHECK）：正等待下含
              // 短暂不可见的三周期重查与非用户唤醒的重等（不重发在途查询）。
              outcome = await resolveChildEntry(target);
            }
            if (outcome.kind === 'cancelled') { barrierCancelled = true; break; }
            // wake 只剩用户档（目标消息已在 resolveChildEntry 内重等消费，§3.2.2
            // 目标消息不切断校验）。
            if (outcome.kind === 'wake') { barrierWake = outcome.value; break; }
            if (outcome.kind === 'timeout') {
              agentEntryOutcomes.set(spec.id, { timeout: true });
              continue;
            }
            const entry = outcome.value;
            if (entry === undefined) {
              if (waitMs === 0) {
                // 零等待的失败查询与挂起同径（设计 §5 ZW-A）：按未确认交回，
                // 不放大成调用错误（正等待维持 listingUnavailable 可读拒绝）。
                agentEntryOutcomes.set(spec.id, { timeout: true });
                continue;
              }
              throw new Error(t(lang, 'error.listingUnavailable'));
            }
            if (entry === null) {
              // 诊断清单同样竞速（WAIT-TIME-01 同缺陷类）：挂起时按空清单放行
              // （查无出口仍给），取消或用户插话则先走各自出口。零等待复用共享
              // 目录结果（恰一次 listChildren），不再另查；正等待查原始行（供
              // 命中检查），渲染串在拒绝文案处统一生成。
              let knownRows;
              if (sharedChildrenTaken && Array.isArray(sharedChildren)) {
                knownRows = sharedChildren;
              } else {
                const knownOutcome = await raceWithWakeReawait(
                  () => ctx.subagents.listChildren(owner, raceAbort.signal)
                );
                if (knownOutcome.kind === 'cancelled') { barrierCancelled = true; break; }
                if (knownOutcome.kind === 'wake') { barrierWake = knownOutcome.value; break; }
                knownRows = knownOutcome.kind === 'entry' && Array.isArray(knownOutcome.value)
                  ? knownOutcome.value
                  : [];
              }
              if (barrierCancelled || barrierWake !== undefined) break;
              // 清单命中即关系证据（RA-AGENT-RECHECK）：重查周期都查无后，诊断
              // 清单里目标却在场＝窗口内变为可见——按屏障命中继续校验，不以
              // 「它不是本会话的子代理」拒绝一个清单在场的目标（错误与自证清单
              // 自相矛盾的形态）；查无的登记清除只发生在最终确认查无时。
              const lateRow = knownRows.find((row) => row?.id === spec.id && row?.kind !== 'diagnostic');
              if (lateRow !== undefined) {
                agentEntryOutcomes.set(spec.id, { entry: lateRow });
                continue;
              }
              target.clearBaseline();
              throw new Error(t(lang, 'error.unknownAgent', {
                agentId: spec.id,
                children: knownRows.map((row) => describeEntry(row, lang, t)).join('\n')
              }));
            }
            agentEntryOutcomes.set(spec.id, { entry });
          }
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
          // 屏障期间到达且切断校验的只有用户插话（§3.2.2；目标消息在上方
          // 按未证实交回、不在此消费——未证实目标在 targets 行如实标注）。
          // 下面的 sender 命中分支为防御保留（订阅过滤下目标消息不会走到
          // 这里切断校验）。
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
        const timedOutIds = [];
        for (const [specId, outcome] of agentEntryOutcomes) {
          if (outcome.timeout) timedOutIds.push(specId);
        }
        if (timedOutIds.length > 0) {
          // 屏障窗口内未完成（含零等待共享查询挂起/失败的整批目标）：本次不可
          // 证实目标资格——如实交回 unconfirmed（不假装无目标，也不无界等待；
          // 重查出路在说明里）。
          for (const specId of timedOutIds) {
            ctx.logger?.warn?.(
              `${LOG_PREFIX} async_wait barrier timed out for agent target ${String(specId)}`
            );
          }
          return {
            status: 'unconfirmed',
            waited_ms: elapsed(),
            note: t(lang, 'wait.unconfirmedTargets', { ids: timedOutIds.join(', ') }),
            ...(await batchOutcome([])),
            targets: provenTargets(undefined, new Set(timedOutIds))
          };
        }
        // 关系已证（childEntry 命中，或结算通知在场——通知即关系证据）：解除
        // 活动观察器的关系静默期——idle/absent 事件自此可结算（WAIT-AGENT-01
        // 的 proveRelation 接线）。
        for (const { spec, watcher } of watchers) {
          if (agentEntryOutcomes.get(spec.id)?.entry !== undefined || noticeHit.has(spec.id)) {
            watcher.proveRelation?.();
          }
        }

        // ── 未领取结算通知（设计 §3.2.2：完成优先于其余返回条件；出口位于
        // 全部目标必要校验之后——先到合法通知与未知作业/无权子代理/清单失败
        // 混合时整次可读拒绝、不返回 settled/changed、通知不被消费，§8.2 反例
        // 口径。结算通知在册即可交回，不要求目录行仍在；通知命中目标的目录
        // 关系由通知替代证明（上方校验遍已跳过其屏障）；停止断言经结算交付前
        // 的注册表复核以同步现读执行，WAIT-SETTLE-GATE-01）──────────────────
        for (const spec of agentTargetSpecs) {
          if (unclaimedSettlement(agent, spec.id) !== null) {
            // 运行或未证实：按 9.3.3 立即返回，但不作停止断言——changed 出口
            // 说明通知已到、静止未证实；不写登记、不等待注册表翻转（复核只
            // 推迟停止断言、不吞通知）。
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

        // ── 入口返回条件（先证资格，后查条件）──────────────────────────
        // 先到消息（user 优先；有目标等待的扫描带目标过滤——非目标消息不命中）。
        const earlyWake = classifyWake(preexistingWakeMessage(agent, lang, targets.length > 0 ? agentIds : undefined), lang);
        // 作业目标入口快照：终态即读取交付。
        for (const job of jobTargets) {
          const snapshot = jobSnapshots.get(job.jobId) ?? snapOf(job);
          if (snapshot.terminal) {
            const read = await job.readSettled(snapshot.row);
            // 混合多目标：终态目标先行返回的同一领取窗口，其余**运行中**作业目标的当前
            // 增量也读取并入批（includeRunning）——与零等待主出口同一口径
            //（9.3.1「有作业目标时可交付当前未交付增量」对 wait_ms=0 的两个
            // 出口一致适用）；正等待出口仍只带终态批。
            for (const other of jobTargets) {
              if (other.jobId === job.jobId) continue;
              const os = snapOf(other);
              if (os.state === 'found' && !os.terminal && waitMs === 0) {
                await ledger.readIncremental(other.jobId);
              }
            }
            // 恢复出口分档（RESULT-RECOVERY-01 §3.3；§7 第 4 条——恢复只由显式
            // 作业目标的零等待触发，本分支恰是该形态）：第 1 档挂起消费标记，
            // 下方 batchOutcome 的 collectBatch 装配「标记行＋副本正文」（同一
            // 分配原语、计入当批预算）；第 2 档＝现行口径；第 3 档改写注记
            //（副本过期/不可用——如实说明，不伪造正文）。
            const recoveryTier = waitMs === 0
              ? ledger.stageRecovery(job.jobId, owner)
              : null;
            // 装配前事实（REL-RECOVER-02 注记选键依据）：「本次是否附带续段」按
            // 实际装配结果判断——factBefore.partial 且本次 trigger 在场＝续段
            // 真的随本返回附带（partialDelivered）；partial 但本次未附带
            // （延后/在途认领）＝partialPending，不得声称已附带。
            const factBefore = ledger.jobs.get(job.jobId)?.deliveredFact ?? null;
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
              // 落入读取失败文案——readFailed 条目的正文本来就是空）。恢复触发
              //（§2.6）：标记行＋位置说明行入必要说明层，置于正文前——不裁剪、
              // 不占内容预算（切片已全额计入），不与续段注记混排。
              output: trigger?.recovery === true && (trigger.text ?? '') !== ''
                ? `${trigger.recoveryHead}\n${trigger.text}`
                : ((trigger?.text ?? '') !== ''
                  ? trigger.text
                  : (read === null
                    ? t(lang, 'delivery.readFailed', { jobId: job.jobId })
                    : '')),
              // 续段实际附带（factBefore 为 partial、trigger 附带非空正文）：陈述
              // 附带份额（装配条目 chars）；附带后仍被裁剪（事实仍 partial 且缓冲
              // 非空）时双事实并陈——先已附带、后待领取，不得只报其一。读取失败
              // 形态的 trigger（正文 ''、chars 0）不算「已附带」——那条批条目
              // 只是状态行＋重试出路，拼 partialDelivered 会声称「约 0 字符已
              // 附带」并与 partialPending 并陈自相矛盾（该形态只报待领取份额）。
              // 恢复触发条目不适用续段注记——恢复头（标记行＋位置说明行）已经
              // 说明本次附带的是重发份额。
              ...(trigger !== undefined && trigger.recovery !== true && (trigger.text ?? '') !== ''
                && factBefore?.partial === true
                ? {
                  note: [
                    t(lang, 'wait.partialDelivered', { jobId: job.jobId, chars: trigger.chars ?? 0 }),
                    ...(deliveredFact?.partial === true && (entry?.buffer.length ?? 0) > 0
                      ? [t(lang, 'wait.partialPending', { jobId: job.jobId, chars: entry?.buffer.length ?? 0 })]
                      : [])
                  ].join(' ')
                }
                : {}),
              // 本次未附带（无 trigger，或 trigger 为读取失败形态——正文为空、
              // 只带状态行与重试出路）：**准入条件是装配前已有交付事实**
              // （factBefore≠null——先前载体交付过；本次装配自置的事实不算，
              // 否则空输出作业首等会被误报 alreadyDelivered）。partial＝仍未
              // 交付（给零等待领取方式，不声称已附带）；完全已交付＝解释空
              // 输出（防误读为「完成且无输出」）。空输出首达不产生注记——
              // 状态行「completed (0 chars)」本身就是正确解释。恢复分流
              //（§2.6）：流取尽待定案（tier 1 drained）报「已重发、待确认」；
              // 第 3 档（未确认但份额过期/不可用）改写完全交付注记：份额
              // 不可用的事实先于「已交付」解释——后者会误导模型放弃找回；
              // 缺失份额序号与留存线索（如有）逐条追加。
              ...((trigger === undefined || (trigger.text ?? '') === '') && read !== null
                && deliveredFact !== null && factBefore !== null
                ? { note: deliveredFact.partial === true
                  ? t(lang, 'wait.partialPending', { jobId: job.jobId, chars: entry?.buffer.length ?? 0 })
                  : (recoveryTier?.tier === 1 && recoveryTier.drained === true
                    ? t(lang, 'wait.recoveryAwaitingConfirm', { jobId: job.jobId })
                    : (recoveryTier?.tier === 3
                      ? [
                        t(lang, 'wait.recoveryExpired', { jobId: job.jobId }),
                        ...(recoveryTier.lost !== undefined && recoveryTier.lost.length > 0
                          ? [t(lang, 'wait.recoveryPortionsLost', { ords: recoveryTier.lost.join(', ') })]
                          : []),
                        ...(recoveryTier.spillPaths ?? []).map((path) => t(lang, 'delivery.spill', { path }))
                      ].join('\n')
                      : t(lang, 'wait.alreadyDelivered', { jobId: job.jobId }))) }
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
          // 作业目标交付当前增量（运行中也可读，设计 §3.2.3）；读取失败不静默——
          // 账本 readFailed 定论由下方 batchOutcome 的批次装配注记与重试出路
          // （WAIT-INCREMENT-01）；非目标消息不构成结束条件（零等待只是检查，
          // 无等待可结束）。
          for (const job of jobTargets) {
            const snapshot = snapOf(job);
            if (snapshot.state === 'found' && !snapshot.terminal) {
              await ledger.readIncremental(job.jobId);
            }
          }
          if (earlyWake !== null && earlyWake.via === 'user') {
            return {
              status: 'interrupted',
              // BA-05：报实际检查耗时（自调用起点的单调时钟），不因零等待
              // 固定冒报 0——入口扫描与清单校验占用的毫秒如实入账。
              waited_ms: elapsed(),
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
                waited_ms: elapsed(), // BA-05：实际检查耗时
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
                waited_ms: elapsed(), // BA-05：实际检查耗时
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
              waited_ms: elapsed(), // BA-05：实际检查耗时
              note: t(lang, 'wait.lateArrived', { summary: zeroLate[0].summary }),
              ...(await batchOutcome([])),
              ...(agentIds.length > 0 || jobTargets.length > 0 ? { targets: provenTargets() } : {})
            };
          }
          // 主出口：includeRunning（设计 §3.2.3）——运行中目标的当前增量随批装配
          //（上文 readIncremental 已并入缓冲）；其余批成员仍限终态。
          // 恢复分档（§2.6 恢复出口）在装配前决定：显式作业目标的零等待同样经
          // stageRecovery 辨形态——目标有未交付增量时返回 null、走正常续段
          //（§2.6 续取优先），份额在册且有可服务内容时挂起第 1 档交回，份额在册
          // 但流取尽待定案时返回「已重发、待确认」的状态说明（不带正文）。
          const recoveryTiers = new Map();
          for (const job of jobTargets) {
            recoveryTiers.set(job.jobId, ledger.stageRecovery(job.jobId, owner));
          }
          // 装配前事实先存（注记两分依据：续段是否由**本次**批次附带）。
          const factsBefore = new Map(jobTargets.map((job) => [
            job.jobId,
            ledger.jobs.get(job.jobId)?.deliveredFact ?? null
          ]));
          const batch = await batchOutcome(
            jobTargets.map((job) => job.jobId),
            undefined,
            { includeRunning: true }
          );
          // 已交付终态目标补说明（与入口终态分支同款）：零等待出口的
          // note 不只报「目标未满足」——**装配前已有交付事实**的目标（factBefore
          // ≠null：先前载体交付过；本次装配自置的事实不算，空输出首达不注记——
          // 状态行 0 chars 本身就是正确解释）空 output 必须有解释，不得被误读成
          // 「完成且无输出」。注记两分（REL-RECOVER-02）：装配前为 partial 且
          // 本次批次附带**非空正文** → partialDelivered（附带后仍截断时并陈待领取
          // 份额）；读取失败形态的条目只带状态行（chars 0），不算「已附带」，
          // 仍为 partial 未附带 → partialPending；否则 alreadyDelivered。
          const deliveredNotes = [];
          for (const job of jobTargets) {
            const tier = recoveryTiers.get(job.jobId);
            if (tier?.tier === 1 && tier.drained === true) {
              // 流取尽、待回合收尾定案（§2.6）：状态说明，不带正文——
              // 续段/已交付注记都不适用（本次批次没有该作业条目）。
              deliveredNotes.push(t(lang, 'wait.recoveryAwaitingConfirm', { jobId: job.jobId }));
              continue;
            }
            const snap = snapOf(job);
            const factBefore = factsBefore.get(job.jobId) ?? null;
            const fact = ledger.jobs.get(job.jobId)?.deliveredFact ?? null;
            if (snap.state === 'found' && snap.terminal && fact !== null && factBefore !== null
              && snap.row.status !== 'running') {
              // 恢复份额随批附带（§2.6）：恢复头（标记行＋位置说明行）已说明
              // 本次附带的是重发份额——续段/已交付注记不适用。
              if (batch.outputs.some((item) => item.job_id === job.jobId
                && item.recovery_line !== undefined)) {
                continue;
              }
              const attached = batch.delivered.find((item) => item.job_id === job.jobId);
              const attachedBody = attached !== undefined && (attached.text ?? '') !== '';
              const entry = ledger.jobs.get(job.jobId);
              if (factBefore?.partial === true && attachedBody) {
                const parts = [t(lang, 'wait.partialDelivered', { jobId: job.jobId, chars: attached.chars ?? 0 })];
                if (fact?.partial === true && (entry?.buffer.length ?? 0) > 0) {
                  parts.push(t(lang, 'wait.partialPending', { jobId: job.jobId, chars: entry?.buffer.length ?? 0 }));
                }
                deliveredNotes.push(parts.join(' '));
              } else if (fact.partial === true) {
                deliveredNotes.push(t(lang, 'wait.partialPending', { jobId: job.jobId, chars: entry?.buffer.length ?? 0 }));
              } else {
                deliveredNotes.push(t(lang, 'wait.alreadyDelivered', { jobId: job.jobId }));
              }
            }
          }
          const baseNote = targets.length > 0
            ? t(lang, 'wait.zeroWaitTargets')
            : t(lang, 'wait.zeroWaitNoTargets');
          return {
            status: targets.length > 0 ? 'running' : 'budget',
            // BA-05：零等待主出口报实际检查耗时（统一检查窗内完成的扫描、清单
            // 校验与批次装配毫秒数如实入账；实测约 190ms——固定 0 会把窗口内
            // 的真实成本藏掉）。仍不挂起：耗时受 ZERO_WAIT_CHECK（1000ms）约束。
            waited_ms: elapsed(),
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
          const { work, unknown, interrupt, unknownCount } = await waitWorthyWork();
          lastWorthyUnknown = unknownCount;
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
        // 翻转（挂起会在轮询周期里把同一静止态当「新变化」重复交回，混合目标
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
        // RA-UNKNOWN-SUSPEND：没有作业目标且**没有任何已确认运行的子代理目标**
        //（全部非运行——纯 unknown，或 unknown 与已报告静止混排；纯静止已在上方
        // 翻转出口处理）时不挂起：挂起资格要求已证实的可等待工作（§3.2.5），注册表
        // 读取失败的目标既不能证明运行、也不能证明不存在——挂满预算再交回
        // running 是把「条件未证实」冒充「观察到仍在运行」。与无目标等待的
        // 未证实出口证据标准保持一致，立即交回 unconfirmed＋`wait.unconfirmedWork` 说明；
        // 混入真实运行目标时不走本出口（有已证实资格，正常挂起观察）。
        if (targets.length > 0 && jobTargets.length === 0 && agentTargetSpecs.length > 0
          && agentTargetSpecs.every((spec) => agentStatusOf(ctx, spec.id) !== 'running')) {
          ctx.logger?.warn?.(
            `${LOG_PREFIX} async_wait returned without suspending: no confirmed running target (agent registry read failed for every target)`
          );
          return {
            status: 'unconfirmed',
            waited_ms: elapsed(),
            note: t(lang, 'wait.unconfirmedWork'),
            ...(await batchOutcome([])),
            targets: provenTargets()
          };
        }
        armJobWaits();
        /** 「结算通知已见但状态未证实」的调用内待确认标记（WAIT-SETTLE-GATE-01
         * 结算交付前的注册表复核）：spec.id → true。标记在场期间不写跨调用登记、
         * 不丢通知；静止证实后经翻转出口交付并清标记；出口返回时仍有标记的附
         * settleNoticePending 说明（取消／插话／消息／到期照常交回、不受标记
         * 影响）。标记仅调用内存活。 */
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
        // 定时周期胜者不计入计数（WAIT-OBSERVE-01 顺带修复的现存缺陷：备用轮询
        // 周期曾无条件计入——默认参数下 agent 目标满额等待 600000/500＝1200 个
        // 周期超过上限 1000，防线误触、提前按到期口径交回）。防线只数非定时信号的密集
        // 重复（事件风暴、真自旋）；定时周期按固定查询周期发生、不是自旋。取值走注入点
        // WAIT_SPIN_LIMIT（可测锚，W-SPIN-A）。
        const isTimedBeat = (winner) => winner.name === 'agent-poll' || winner.name === 'work-recheck'
          || ((winner.name === 'job-event' || winner.name === 'job-event-dropped')
            && !isTerminal(winner.view?.status));
        for (;;) {
          const candidates = [
            // 唤醒信号已消费（RA-BARRIER-WAKE）：屏障期见过的消息由返回条件消费，
            // 已被宿主领取的消息再以旧值「胜出」会交回过期事实——排除。
            ...(wakeSpent ? [] : [wakeSignal]),
            ...(lateResolved ? [] : [lateSignal]),
            readyPromise,
            cancelled,
            deadlinePromise
          ];
          // 子代理目标的轮询周期（设计 §3.2.4 双通道之二，WAIT-AGENT-01）：每轮
          // 竞速重排新周期（一次性 promise 不复用）。
          if (watchers.length > 0) candidates.push(pollBeat());
          // 无目标挂起的周期复查（WAIT-OBSERVE-01）：仅无目标等待入竞速
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
            // 与预算到期同档取键（WAIT-TARGET-STATE-CERTAINTY）：自旋防线出口
            // 不无条件断言「各目标仍在运行」。
            const provenRows = hasTargets ? provenTargets() : [];
            return {
              status: hasTargets ? 'running' : 'budget',
              waited_ms: waitedMs,
              note: `${hasTargets
                ? t(lang, budgetTierKey(provenRows), { waitedMs, tally: tallyText(provenRows, lang) })
                : t(lang, 'wait.budgetNoTargets', { waitedMs })}${settlePendingNote()}`,
              ...(await batchOutcome(jobTargets.map((job) => job.jobId))),
              ...(hasTargets ? { targets: provenRows } : {})
            };
          }

          // ── 非结束性胜者 ──────────────────────────────────────────────
          // 无目标挂起的周期复查（WAIT-OBSERVE-01）：复查内容与入口检查同源
          //（waitWorthyWork——jobs.list 非终态行同步短路、零目录查询，其次
          // 子代理清单的注册表现读）。四路处置：仍有可等待工作→续等；确认
          // 范围内已无可等待工作→先对账（账本内 terminal 空的终态行补定论读取，
          // RA-FOREIGN-DISCOVERY §1.2.3）再复用 no-work 出口及时交回（note 用
          // workConcluded，waited_ms 为全程实际时长，就绪内容按 2.6 随批顺带
          // 交付——不升格为目标变化通知、不逐个点名）；查询失败或周期内未回→
          // 未证实，续等不交回，下一周期再查；取消／插话／消息先到→各自既有
          // 出口。复查是只读观察、不向主体报告具体子代理的状态，因此不写
          // 3.2.4 的跨调用登记——写会吞掉后续首次指定该子代理时的首次确认
          //（W-OBSERVE-G 钉住）。剩余预算不正不发起查询（§2.1，由 deadline
          // 成员收场）；上一周期在途未结跳过本周期发起（防线二）。
          if (winner.name === 'work-recheck') {
            if (deadlineAt - monotonic() <= 0 || recheckQueryInFlight) continue;
            recheckAbort = new AbortController();
            const beatSignal = recheckAbort.signal;
            recheckQueryInFlight = true;
            const markQuerySettled = () => { recheckQueryInFlight = false; };
            // 周期跳过标志的回收纪律：标志只在「确实发起了目录查询」时由查询的
            // then 清除；waitWorthyWork 走 jobs.list 同步短路提前返回时目录查询
            // 从未发起（onQueryLaunched 不回调），此处同步回收——否则一次短路后
            // 标志永久卡住，后续全部复查周期被跳过（外来作业的静默结算覆盖随之
            // 失效，W-OBSERVE-H 钉住）。
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
            // inFlight 标志让后续周期跳过发起，不在宿主累积悬挂查询。
            if (beatSignal.aborted !== true && (outcome.unknown === true || outcome.interrupt !== undefined)) {
              recheckAbort.abort(new Error('async-tools: recheck-window-exhausted'));
            }
            if (outcome.interrupt !== undefined) return await noTargetInterruptOutcome(outcome.interrupt);
            // 完成的复查刷新「最近一次完成检查」的未证实计数（WAIT-NO-TARGET-
            // UNKNOWN）：work:true 携带累计计数，unknown:true 照实；被打断的
            // 检查经上行 interrupt 出口交回，不覆盖旧值。
            lastWorthyUnknown = outcome.unknownCount;
            if (outcome.work || outcome.unknown) continue;
            // 对账复查（§2.4「不重复查询」）：本周期行集内账本 terminal 空的
            // 终态行先补定论读取——静默结算的外来/在册作业正文随 no-work 批次
            // 交付，行集复用（不再查一次 jobs.list）。
            await discoverForeignResults(outcome.rows);
            ctx.logger?.info?.(
              `${LOG_PREFIX} async_wait concluded by periodic recheck: no wait-worthy work remains`
            );
            return {
              status: 'no-work',
              waited_ms: waitedMs,
              note: t(lang, 'wait.workConcluded'),
              ...(await batchOutcome([], undefined,
                outcome.rows !== undefined ? { discoveryRows: outcome.rows } : {}))
            };
          }
          // 子代理轮询周期（备用观察，不扩权——只读注册表公开状态）：静止与
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
              // 待确认标记的翻转交付（WAIT-SETTLE-GATE-01）：静止已证实——清标记、
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
                // 待确认标记的翻转交付（WAIT-SETTLE-GATE-01）：静止已证实——清标记、
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
            // 装配前事实（注记选键依据，与入口终态分支同一口径）。
            const factBefore = ledger.jobs.get(winner.job.jobId)?.deliveredFact ?? null;
            const { trigger, ...batch } = await batchOutcome([winner.job.jobId], winner.job.jobId);
            const jobEntry = ledger.jobs.get(winner.job.jobId);
            const jobFact = jobEntry?.deliveredFact ?? null;
            // 作业终态说明（已交付事实）与结算复核附注（WAIT-SETTLE-GATE-01：
            // 混合目标下其余子代理目标「通知已见未证实」的说明不因作业出口丢失）。
            // 注记两分（REL-RECOVER-02）：续段实际随本返回附带（factBefore 为
            // partial 且 trigger 附带非空正文）→ partialDelivered（装配份额），
            // 附带后仍被裁剪时并陈待领取份额；未附带（含读取失败形态的空正文
            // trigger——不算「已附带」）→ partialPending / alreadyDelivered。
            // 第二分支准入＝装配前已有交付事实（factBefore≠null，见入口分支
            // 注释：空输出首达不得误报 alreadyDelivered）。
            const jobNoteParts = [];
            if (trigger !== undefined && (trigger.text ?? '') !== '' && factBefore?.partial === true) {
              jobNoteParts.push(t(lang, 'wait.partialDelivered', { jobId: winner.job.jobId, chars: trigger.chars ?? 0 }));
              if (jobFact?.partial === true && (jobEntry?.buffer.length ?? 0) > 0) {
                jobNoteParts.push(t(lang, 'wait.partialPending', { jobId: winner.job.jobId, chars: jobEntry?.buffer.length ?? 0 }));
              }
            } else if ((trigger === undefined || (trigger.text ?? '') === '') && read !== null
              && jobFact !== null && factBefore !== null) {
              jobNoteParts.push(jobFact.partial === true
                ? t(lang, 'wait.partialPending', { jobId: winner.job.jobId, chars: jobEntry?.buffer.length ?? 0 })
                : t(lang, 'wait.alreadyDelivered', { jobId: winner.job.jobId }));
            }
            const jobNote = jobNoteParts.join(' ');
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
            // 结算交付前的注册表复核（WAIT-SETTLE-GATE-01）：停止胜出（结算通知
            // 两种 via 或 agent/status 转 idle 事件）交付 settled 前同步现读注册
            // 表复核「不再观察到运行」——不同时宣称结算与运行。非运行按现行交付
            // 并写登记（W-GATE-A 锚定现行保持；待确认标记在场期间再次通知静止已
            // 证实时清标记）；
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
              // sender 命中的复查（设计 2.2，WAIT-SETTLE-GATE-01 同批）：
              // 现读注册表——idle/absent 按停止态交回并呈消息说明；running/
              // unknown 按现行 changed（不据消息制造停止事实）。
              const observed = agentStatusOf(ctx, matched.id);
              if (observed === 'idle' || observed === 'absent') {
                const target = new AgentTarget({ ctx, config, agentId: matched.id, owner, t });
                target.noteReported(observed);
                // 静止已证实：此前复核留下的待确认标记一并清除（WAIT-SETTLE-GATE-01）。
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

          // 到期（与回退）：有目标 running 附各目标已证状态——到期提示按已证
          // 执行状态三档取键（WAIT-TARGET-STATE-CERTAINTY：全部仍在执行／部分／
          // 无一行仍在执行，计数串随档），不无条件断言「各目标仍在运行」；无目标
          // budget，最近一次完成的资格检查仍带未证实读数时附未证实注记（WAIT-
          // NO-TARGET-UNKNOWN）。待确认标记的到期附注（WAIT-SETTLE-GATE-01）：
          // 注册表久不翻转的缺陷形态退化为到期口径（运行态＋通知已见说明），
          // 不误报静止。
          const provenRows = hasTargets ? provenTargets() : [];
          const note = `${hasTargets
            ? t(lang, budgetTierKey(provenRows), { waitedMs, tally: tallyText(provenRows, lang) })
            : t(lang, 'wait.budgetNoTargets', { waitedMs })}${settlePendingNote()}${!hasTargets && lastWorthyUnknown > 0 ? `\n${t(lang, 'wait.budgetNoTargetsUnknown', { count: lastWorthyUnknown })}` : ''}`;
          ctx.logger?.info?.(
            `${LOG_PREFIX} async_wait concluded: waitedMs=${waitedMs} budget=${waitMs} `
            + `reason=${winner.name === 'deadline' ? 'budget' : winner.name}`
          );
          return {
            status: hasTargets ? 'running' : 'budget',
            waited_ms: waitedMs,
            note,
            ...(await batchOutcome(jobTargets.map((job) => job.jobId))),
            ...(hasTargets ? { targets: provenRows } : {})
          };
        }
      } catch (error) {
        // 出口异常：交付批回滚（缓冲保留，下一载体携带）后原样上抛——回滚按
        // 最近一次装配的真实条目逐项退回（空数组回滚是空操作，缺陷形态）。
        // RA-EXIT-CLEANUP：回滚自身抛错不覆盖原始错误（记 warn 后原样上抛）。
        try {
          ledger.undoClaim(owner, lastCollected);
        } catch (rollbackError) {
          ctx.logger?.warn?.(
            `${LOG_PREFIX} wait rollback after error also failed: ${String(rollbackError?.message ?? rollbackError)}`
          );
        }
        throw error;
      } finally {
        await cleanup();
      }
    }
  });
  tool.rebuildText = rebuildText;
  return tool;
}
