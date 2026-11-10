/**
 * 子代理目标适配（设计 §3.2.4）：统一等待的子代理目标关系证据、注册表状态、
 * 双通道与观察基准。本模块只做**单目标的观察与适配决定**；挂起资格由统一等待
 * （lib/wait.js）按目标形态判断——显式目标按全部请求目标的资格校验（设计
 * §3.2.2，不借列表外工作取得资格），无目标等待按账本已就绪内容与可等待工作
 * 检查（设计 §3.2.5）；静止目标不单独造成空等。
 *
 * **观察基准两层**（设计 §3.2.4，需求 9.3.3）：
 * - **跨调用登记**（本模块）：按「主体×目标」登记最近一次已向该主体报告的公开
 *   状态（运行 `running`、空闲 `idle` 或无驻留 `absent`）——向主体交回该目标的
 *   状态或变化说明时更新，状态翻转时覆盖，目标经存在屏障确认查无时清除；
 *   登记只存状态与最后触达时间，不存消息正文，不缓存 settled 结论；末行卸载
 *   清空全部登记（RA-BASELINE-LIFECYCLE：清理只按确证生命周期——末行卸载与
 *   确认查无——不按龄清扫，见 `reportedBaseline` 处注释）。
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
 * 键 `owner|agentId`，值 `{ status: 'running' | 'idle' | 'absent', touchedAt }`。
 * 不在 Agent 终态或停止态交付时清除：设计 §3.2.4 依赖已报静止登记，清除会使
 * 「维持已确认静止」退化为重复停止态报告。
 *
 * 生命周期只按**确证信号**清理（RA-BASELINE-LIFECYCLE）：末行卸载清空全部
 * （clearAgentBaselines）、存在屏障确认查无清除单目标（clearBaseline）。不按
 * 龄清扫：迟答 24 小时、恢复份额 30 分钟是**其他机制**的期限，推导不出「跨 7
 * 天不存在合法父子状态比较」——长期可续会话（恢复、跨轮目标）超过任意天数仍
 * 可能回到同一目标；按龄删除会（一）把已报静止重新当「首次确认」重复交回、
 * （二）删掉静止基准使恢复运行被吸收成新基准而漏报 `changed-once`。代价是登
 * 记无自然到期——条目极小（状态＋时间戳），由末行卸载全量释放。
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
 * 独立导出（DOC-ZERO-01）：零等待共享目录结果的诊断清单复用同一行集时，
 * 由调用方本地映射——不再为清单另发一次 `listChildren`。
 */
export function describeEntry(entry, lang, t) {
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
 * 公开 Agent 注册表观察（设计 §3.2.4 四态）：`'running'`｜`'idle'`｜
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
    const entry = reportedBaseline.get(baselineKey(this.owner, this.agentId));
    if (entry === undefined) return undefined;
    entry.touchedAt = Date.now();
    return entry.status;
  }

  /** 更新登记（向主体交回状态或变化说明时；状态翻转即覆盖）。 */
  noteReported(status) {
    reportedBaseline.set(baselineKey(this.owner, this.agentId), { status, touchedAt: Date.now() });
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
   * `action` 只描述**本目标**的适配决定，不是整个等待的挂起资格：`wait`＝本目标
   * 无立即报告事项；**是否真的挂起由统一等待按目标形态判断**——显式目标全部
   * 静止时按「维持静止」立即交回（需求 §9.3.1／§9.3.3，静止目标不单独造成空等），且显式
   * 目标不借列表外工作取得资格（设计 §3.2.2；无目标等待的资格检查另按 §3.2.5）。
   *
   * @returns {{action: 'stop-once'|'wait'|'changed-once', observed: string,
   *   reported?: string}} `stop-once`＝停止态立即返回一次（未报告翻转或首次
   *   确认）；`wait`＝本目标暂无立即报告（静态或已报告静止——见上，挂起与否由
   *   统一等待按目标形态判断）；`changed-once`＝恢复运行立即报告一次变化。`observed` 是本次
   *   注册表观察四态。
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
      // 登记同态＝已报告静止：不重复交回——本目标 `wait`（挂起与否由统一等待按
      // 目标形态判断：显式目标不借列表外工作取得资格〔设计 §3.2.2〕，静止目标
      // 不单独造成空等）。
      if (reported === observed) return { action: 'wait', observed, reported };
      return { action: 'stop-once', observed, reported };
    }
    // unknown：无可比较观察——基准为空，任何可证新变化都可交回（本目标 wait，
    // 同样不单独决定挂起）。unknown 不构成已证实的挂起资格：没有作业目标且
    // 没有任何已确认运行的子代理目标时，统一等待在挂起前按未证实立即交回
    //（RA-UNKNOWN-SUSPEND——注册表读取失败既不能证明运行、也不能证明不存在，
    // 挂满预算交回 running 是把「条件未证实」冒充「观察到仍在运行」）。
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

/** 插件末行卸载：释放全部跨调用登记。 */
export function clearAgentBaselines() {
  reportedBaseline.clear();
}

/** 测试隔离：复用正式生命周期清理。 */
export function resetAgentBaselines() {
  clearAgentBaselines();
}
