/**
 * 子代理目标适配（设计 §3.2.4）：统一等待的子代理目标关系证据、注册表状态、
 * 双通道与观察基准。
 *
 * **观察基准两层**（设计 §3.2.4，需求 9.3.3）：
 * - **跨调用登记**（本模块）：按「主体×目标」登记最近一次已向该主体报告的公开
 *   状态（运行 `running`、空闲 `idle` 或无驻留 `absent`）——向主体交回该目标的
 *   状态或变化说明时更新，状态翻转时覆盖，目标经存在屏障确认查无时清除；
 *   登记只存状态，不存消息正文，不缓存 settled 结论。
 * - **本次调用比较**：入口可观察状态与登记比较——查到静止且登记为运行是未报告
 *   翻转、查到静止且无登记是首次确认（两者立即返回停止态一次）；查到静止且登记
 *   同态是已报告静止（不重复交回，等待新变化）；查到 running 且登记为静止是恢复
 *   运行（立即报告一次变化）；无可比较观察时基准为空。
 *
 * 等待子代理＝等待需要本主体处理的变化，不是收集结果（需求 9.3.3）。
 *
 * @module dsh-async-tools/wait-agent-target
 */

/**
 * 跨调用已报告状态登记（模块级单例，与交付账本同驻留前提）。
 * 键 `owner|agentId`，值 `'running' | 'idle' | 'absent'`。
 */
const reportedBaseline = new Map();

/** 登记键。 */
const baselineKey = (owner, agentId) => `${String(owner)}|${String(agentId)}`;

/**
 * 查一次子代理列表，返回匹配条目（找不到 `null`，查询失败 `undefined`）。
 * 诊断行（`kind: 'diagnostic'`）排除——它不是可用的子代理。
 */
async function childOf(ctx, parentId, agentId, signal) {
  try {
    const entries = await ctx.subagents.listChildren(parentId, signal);
    if (!Array.isArray(entries)) return undefined;
    return entries.find((entry) => entry?.id === agentId && entry?.kind !== 'diagnostic') ?? null;
  } catch {
    return undefined;
  }
}

/**
 * 把一行子代理写成纠错清单里的一项（两种行形状：catalog 行与判别联合行）。
 */
function describeEntry(entry, lang, t) {
  if (entry?.kind === 'diagnostic') {
    return t(lang, 'list.diagnostic', {
      id: String(entry.id),
      reason: typeof entry.reason === 'string' ? entry.reason : '?'
    });
  }
  const label = typeof entry?.label === 'string' ? entry.label : '?';
  const state = typeof entry?.activity === 'string'
    ? entry.activity
    : (typeof entry?.mode === 'string' ? `mode=${entry.mode}` : '?');
  return `${entry?.id} (${label}, ${state})`;
}

/**
 * 公开 Agent 注册表观察（设计 §3.4 四态）：`'running'`｜`'idle'`｜
 * `'absent'`（注册表无驻留，与目录行消失同档——不再观察到运行，不据此宣称
 * 终结）｜`'unknown'`（查询抛错或服务缺席——状态未证实）。
 */
export function agentStatusOf(ctx, agentId) {
  if (ctx?.agents === undefined || ctx?.agents === null) return 'unknown';
  try {
    const found = ctx.agents.get(agentId);
    if (found === undefined || found === null) return 'absent';
    return found.status === 'running' ? 'running' : 'idle';
  } catch {
    return 'unknown';
  }
}

/**
 * 子代理目标句柄：一个等待目标的关系证据、状态观察与登记面。
 */
export class AgentTarget {
  /**
   * @param {object} init
   * @param {object} init.ctx - cordis 上下文。
   * @param {object} init.config - 生效配置视图。
   * @param {string} init.agentId
   * @param {unknown} init.owner - 主体（宿主会话标识）。
   * @param {Function} init.t - 两语词典取词函数（`lib/text.js` 的 `t`）。
   */
  constructor({ ctx, config, agentId, owner, t }) {
    this.ctx = ctx;
    this.config = config;
    this.agentId = agentId;
    this.owner = owner;
    this.t = t;
  }

  /** 读登记（无可比较观察时 `undefined`）。 */
  baseline() {
    return reportedBaseline.get(baselineKey(this.owner, this.agentId));
  }

  /** 更新登记（向主体交回状态或变化说明时；状态翻转即覆盖）。 */
  noteReported(status) {
    reportedBaseline.set(baselineKey(this.owner, this.agentId), status);
  }

  /** 清除登记（存在屏障确认查无时）。 */
  clearBaseline() {
    reportedBaseline.delete(baselineKey(this.owner, this.agentId));
  }

  /**
   * 关系查询（设计 §3.2.4 存在屏障的单元查询）：`listChildren` 命中＝关系证明。
   * @returns {Promise<object|null|undefined>} 行／查无／查询失败三分。
   */
  childEntry(signal) {
    return childOf(this.ctx, this.owner, this.agentId, signal);
  }

  /**
   * 入口检查（两层观察基准的比较，设计 §3.2.4）。前提：关系已证（目录行命中）。
   *
   * @returns {{action: 'stop-once'|'wait'|'changed-once', observed: string,
   *   reported?: string}} `stop-once`＝停止态立即返回一次（未报告翻转或首次
   *   确认）；`wait`＝进入等待（静态或已报告静止）；`changed-once`＝恢复
   *   运行立即报告一次变化。`observed` 是本次注册表观察四态。
   */
  entryCheck() {
    const observed = agentStatusOf(this.ctx, this.agentId);
    const reported = this.baseline();
    if (observed === 'running') {
      return reported === 'idle' || reported === 'absent'
        ? { action: 'changed-once', observed, reported }
        : { action: 'wait', observed, reported };
    }
    if (observed === 'idle' || observed === 'absent') {
      // 查到静止：登记为运行＝未报告翻转；无登记＝首次确认——都停止态返回一次。
      // 登记同态＝已报告静止：不重复交回，等待新变化。
      if (reported === observed) return { action: 'wait', observed, reported };
      return { action: 'stop-once', observed, reported };
    }
    // unknown：无可比较观察——基准为空，任何可证新变化都可交回（进入等待）。
    return { action: 'wait', observed, reported };
  }

  /**
   * 纠错清单（查无出口附已知子代理；诊断行带 reason，两种行形状都写）。
   * @param {Function} t - 词典取词。
   * @param {AbortSignal} [signal]
   * @returns {Promise<string[]>} 清单行（查询失败按空清单放行）。
   */
  async knownChildren(t, signal) {
    try {
      const entries = await this.ctx.subagents.listChildren(this.owner, signal);
      if (!Array.isArray(entries)) return [];
      return entries.map((entry) => describeEntry(entry, this.config.agentLang, t));
    } catch {
      return [];
    }
  }
}

/** 测试隔离：清空跨调用登记。 */
export function resetAgentBaselines() {
  reportedBaseline.clear();
}
