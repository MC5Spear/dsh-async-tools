/**
 * 宿主半边（**角色**，不是独立入口）：播报设置快照，不注册任何工具。
 *
 * ## 定位（设计 §5.1）
 *
 * 宿主角色不做设置命名空间注册，也不接入预设生命周期：
 *
 * - 设置表单来自 **entry Config 的 volatile 字段**（宿主行 `async-tools-host` 的
 *   `dsh.bundle.patch` 行配置），由插件管理页的 **`plugins.bundle.config`** keyed 槽渲染在
 *   **本包插件页的描述与组件行之间**（键 = 包名，`client.js` 注册；设计 §5.3）——
 *   不需要任何命名空间注册代码；
 * - 预设行生命周期由 loader 拥有：补丁在，预设就在；补丁移除，预设消失。
 *
 * 于是宿主角色只剩一件事：**把本行 config 物化成生效快照、并跟随 volatile 提交刷新**
 * （`lib/settings.js` 的 `attachSnapshotSource`）。
 *
 * ## 为什么宿主半边仍必须待在宿主侧
 *
 * `dsh-client-modules` 只遍历 `ctx.loader.entries()`（`dsh-client-modules/lib/index.js:558`
 * 与 `:854`）来决定把哪些包的前端代码发给浏览器，而**预设子树不在
 * 那个集合里**——设置卡片要能出现，本包就必须是宿主侧的一行（由 `cordis.patch.yml` 的无 `toolName`
 * 行承担，见 `lib/index.js`）。
 *
 * 反方向的约束同样不变：宿主侧的行**不得注册工具**（需求 §3.2：那会进全局工具层，塞给
 * 所有预设）。本模块零工具注册。
 *
 * ## 故障姿态
 *
 * - **首播失败 = 降级运行**（`lib/settings.js` 内 catch）：本行 config 坏（跨字段
 *   违例——逐字段校验拦不住、只有跨字段判据能拦）时**不 fail-fast**——若抛错
 *   让行不激活，`describe` 只收激活行、设置卡片整个消失，用户就失去应用内修复
 *   通道。降级 = 回退出厂默认值快照 + stderr 说明 + 降级基线（回调三形，设计
 *   §5.1：与降级时刻自检失败值深度相等的提交放行，与基线不同的非法写入照常
 *   拒绝），行保持激活，改正保存即恢复（清基线再武装）。
 * - **volatile 刷新失败 = 用户输入问题，保旧快照**（`lib/settings.js` 内已 catch）：
 *   不打掉本行、不静默。
 *
 * ## 静默失败防护 c 防线：常驻纪律段（需求 §6.3）
 *
 * 宿主半边在快照播报之外**多注册两件事**，同一 `ctx.inject(['systemPrompt'], …)`
 * 子 scope 内完成。第一件：运行时 context（`async-tools:discipline`，order 130）
 * ——开关开时向组稿目标为**本包两预设**的新会话注入执行纪律段；其余预设（含宿主
 * 行自身的其他会话）的 text 返回空串，由 `dsh-system-prompt` 的渲染层过滤（空串
 * 段不出现），context 本身不注销（避免注册窗口闪烁）。预设按组稿上下文现查
 * （`ctx.get('sessions')` + `ctx.get('sessionProjections')` 投影，与提问接管
 * 判定②同一条读取路径），两服务缺席或读取失败时 text 恒空串，纪律段不出现
 * （失效安全方向 = 关）。
 *
 * 第二件：预设执行纪律 section（`async-tools:agent-discipline`，需求 §5.3/§9.1
 * ASK-01）——落在系统提示正文（persona 之后），注入两份预设的异步等待／委托／
 * 提问角色纪律；语言档现读快照 `agentLang`，不受 `silentFailureGuard` 控制。
 * 详见 applyHostHalf 内的注册注释。
 *
 * 注册层依据（宿主真实收集链）：`SystemPrompt.assemble` 经 `layers.merge(scope)`
 * 收集 **global 层 ＋ agent scope 父链**上的 contexts——宿主行（bundle patch 层）
 * 无 scope 标签，注册落 global 层、所有会话组稿可见，与宿主成例
 * `working-directory:current`（`dsh-working-directory/lib/index.js:41`，装载于
 * dsh-base 的插件行直接 `ctx.systemPrompt.context()`）同一层。
 *
 * 这是**运行时 inject 而非静态表**（sandbox-policy 成例）：静态 `inject` 列保持不变，
 * system-prompt 只在开关开的会话组稿时才被真正用到；没有 systemPrompt 服务的部署里
 * 子 scope 永不激活，插件照常装载（a/b 两防线不受影响）。
 *
 * @module dsh-async-tools/lib/host
 */
import { AskBatchRegistry, AskTakeoverService, shouldTakeover } from './ask-takeover.js';
import { TAKEOVER_PRESETS } from './descriptions.js';
import { attachSnapshotSource, readSnapshot } from './settings.js';
import { t } from './text.js';

/**
 * 宿主半边接入：播报快照 + 接 volatile 监听 + 纪律段注入（c 防线 context 与
 * 预设执行纪律 section）。
 *
 * 快照链**无服务依赖**（`'loader/volatile-update'` 是 loader 派发给**本 fiber** 的
 * 事件，`cordis-plugin-loader/lib/index.js:393-425`，监听挂在宿主行自己的 ctx 上）；
 * 纪律段则 `ctx.inject(['systemPrompt'], …)`（静态 inject 列不动，见文件头）。
 *
 * @param {object} ctx - 宿主行上下文。
 * @param {object} liveConfig - apply 的第二参（= `fiber.config`）：resolved 配置对象，
 *   volatile 字段是**活 Ref**（`Schema.resolve` 包的 `createVolatile` 产物），loader
 *   的就地提交通过 `updateVolatile` **原地**改写它们（`_commitVolatile`，
 *   `cordis-plugin-loader/lib/index.js:410-415`）。cordis **没有 `ctx.config`**
 *   这个访问途径（`ctx.config` 抛 `cannot get property "config" without inject`，
 *   活配置唯一入口就是 apply 的第二参）——快照链必须持有这个对象。
 */
export function applyHostHalf(ctx, liveConfig) {
  const wiring = attachSnapshotSource(ctx, liveConfig);
  ctx.effect(() => wiring.dispose, '[async-tools] host snapshot source');

  // 静默失败 c 防线：`systemPrompt` 子 scope 的运行时 context 注册。`name` 命名空间化照
  // `sandbox:policy` 成例；`order` 直接传字面量 130——`getContextOrder` 只解析三个
  // 内置名（110/115/120），未知名返回 undefined 而 `context()` 要求有限数，
  // 130 排在 SUBAGENT_DELEGATION 之后、与策略簇相邻。
  //
  // 注册层与依赖范围（按宿主真实机制）：宿主组稿收集链是 `SystemPrompt.assemble(
  // {agent, scope})` → `layers.merge(scope)`（`dsh-system-prompt/lib/index.js` 的
  // assemble：global 层无条件收集 ＋ `chainLayers(scope)` 沿 agent 的 scope 父链）。
  // 全局可见 context 的宿主成例（`dsh-working-directory/lib/index.js:41` 的
  // `working-directory:current`）就是**装载于全局层的插件行**在自己的 ctx 上注册——
  // 宿主行（bundle patch 层、无 kScope）经 cordis caller 机制（服务方法内 `this.ctx`
  // 解析为访问者 ctx，`scopeOf` 沿原型链查标签）落 **global 层**，主会话组稿可见。
  // 依赖范围只锁 `systemPrompt`（组稿必需服务，等价于成例的行级注入），**不把
  // sessions/sessionProjections 拉进等待**：两者经 `ctx.get()` 在 text 内现读
  // （`ctx.get` 无 inject 要求、服务缺席返回 undefined），缺席 ⇒ 空串 ⇒ 段不出现
  // （失效安全方向 = 关；相比同时注入三条服务，少两个永不满足的失败条件）。
  //
  // 注入线（组稿产物去向）：assemble 的产物是**双线**——sections 经 `renderPrompt`
  // 进 system prompt（system/message 事件的采样位置）；contexts（含本纪律段）经
  // `renderContextSections`+`joinContextSections` 产出「Current runtime context.」
  // 快照、由 `dsh-agent-loop` 的 preStep 作为**消息**追加进 step 消息流
  // （`messages: [...claimed, context]`），不进 system prompt 文本——验证装置必须
  // 采样 runtime-context 消息线，只看 system 消息对本段天然失明。
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'async-tools:discipline',
      order: 130,
      // text 是函数，每次组稿现求：读**当前快照**的开关与语言档，并按组稿目标
      // 会话的实际预设过滤——开关翻转/语言切换/预设变化都不需要重注册，下一次
      // 组稿即换。快照缺席、开关关、sessions/sessionProjections 缺席或读取抛错、
      // 预设不在本包两预设之列、无 agent 的组稿一律 ''（失效安全方向 = 关），
      // 空串段由 `dsh-system-prompt` 的渲染层过滤。
      text: (assembly) => {
        try {
          const snap = readSnapshot();
          if (snap?.silentFailureGuard !== true) return '';
          const agent = assembly?.agent;
          if (agent === undefined || agent === null) return '';
          // 与提问接管判定②、`lib/jobs.js` 的 guardActiveFor 同一条同步读取路径
          // （`sessions.get(主体 id)` → `stateOf('agentPreset')`）。
          const session = ctx.get('sessions')?.get?.(agent.id);
          if (session === undefined || session === null) return '';
          const preset = ctx.get('sessionProjections')?.stateOf?.(session, 'agentPreset');
          return TAKEOVER_PRESETS.has(preset) ? t(snap.agentLang, 'discipline.block') : '';
        } catch {
          return '';
        }
      }
    });
    // 预设执行纪律 section（需求 §5.3/§9.1 ASK-01，设计 §3.6）：与 c 防线同一个
    // systemPrompt 子 scope 里的第二件事，但走 **section**——落系统提示正文
    // （persona 前缀段之后），不进「Current runtime context.」快照消息。两份
    // 预设的 persona prefix 与宿主基线身份句逐字一致，本包执行纪律（异步等待／
    // 委托规则／提问角色纪律）全部由本段运行时注入。语言档现读快照
    // `agentLang`（en／zh 两档语义与约束相同）；变体按组稿目标会话的实际预设
    // 选择（词典键 `discipline.preset.<预设 id>`——两变体差异句保留在各自
    // 文案里）。段名命名空间化照 `sandbox:policy` 成例；`order` 传字面量 500
    // ——宿主段序表 persona 前缀档（0）之后的紧邻档值，与 `plan:policy` 同档
    // 共存，同档由宿主 `comparePromptSections` 以段名为次级键稳定排序。
    // 本段是常驻执行纪律，**不受 `silentFailureGuard` 开关控制**（该开关只管
    // 上面的 c 防线段）；非目标预设、无 agent、快照缺席、服务缺席或读取失败
    // 一律空串（渲染层过滤，段不出现）。
    scope.systemPrompt.section({
      name: 'async-tools:agent-discipline',
      order: 500,
      // text 是函数，每次组稿现求——开关、语言、预设变化都不需要重注册。
      text: (assembly) => {
        try {
          const snap = readSnapshot();
          const agent = assembly?.agent;
          if (snap === undefined || agent === undefined || agent === null) return '';
          // 与 c 防线、提问接管判定②同一条同步读取路径。
          const session = ctx.get('sessions')?.get?.(agent.id);
          if (session === undefined || session === null) return '';
          const preset = ctx.get('sessionProjections')?.stateOf?.(session, 'agentPreset');
          return TAKEOVER_PRESETS.has(preset) ? t(snap.agentLang, `discipline.preset.${preset}`) : '';
        } catch {
          return '';
        }
      }
    });
  });

  // 提问接管（需求 §4.1/设计 §4.1）：宿主半边在 `user-questions/request` waterfall 上 prepend
  // 抢先应答者。判定与服务都活读快照；总开关默认关 → 判定①恒不满足 → 行为与原生
  // 逐字一致（零行为变化承诺）。
  //
  // 为什么是运行时 inject 而非静态表：三服务（sessions/sessionProjections/agents）
  // 只在接管判定里用到；无任一服务的部署里子 scope 永不激活，插件照常装载（与
  // c 防线同款取舍）。注册表与服务实例**在 inject 外构造一次**（子 scope 若因服务
  // 循环重激活，监听器重挂而注册表/服务不重建——服务键重复注册会炸，批次状态也
  // 不该丢）。
  const askRegistry = new AskBatchRegistry({
    timer: ctx.timer,
    // 时钟经已注入的 timer 服务可选携带（timer.now 存在则用之；生产 timer 无
    // now → 注册表落 Date.now 默认）。不读 ctx.now——那是未注入属性，cordis
    // 上下文读它会抛 cannot get property without inject。测试经 timer.now 拨表
    // 驱动「到期」（设计 §4.2 到期回调有真期限复验，不走表的假钟无法触发）。
    now: ctx.timer === undefined ? undefined : ctx.timer.now,
    readSnapshot,
    // 迟到作答唤醒事件的发布侧（需求 §4.4）：普通 cordis 频道事件，宿主行 emit 对
    // 全部 ctx.on 监听器可达（async_wait_* 在工具行订阅，LATE_ANSWER_EVENT 同源）。
    emit: (name, payload) => ctx.emit(name, payload)
  });
  new AskTakeoverService(ctx, askRegistry);
  let askDisposeListener;
  ctx.inject(['sessions', 'sessionProjections', 'agents'], (scope) => {
    if (askDisposeListener !== undefined) askDisposeListener();
    askDisposeListener = scope.on('user-questions/request', (request, next) => {
      const verdict = shouldTakeover(request, {
        sessions: scope.sessions,
        sessionProjections: scope.sessionProjections,
        agents: scope.agents
      }, readSnapshot());
      if (!verdict.takeover) return next();
      return askRegistry.take(request, verdict.agent, next);
    }, { prepend: true });
  });
  ctx.effect(() => () => {
    if (askDisposeListener !== undefined) askDisposeListener();
    askRegistry.disposeAll();
  }, '[async-tools] ask takeover wiring');
}
