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
 * `dsh-client-modules` 只遍历 `ctx.loader.entries()`（`dsh-client-modules/lib/index.js:540`
 * 与 `:835`，`loaderEntries`）来决定把哪些包的前端代码发给浏览器，而**预设子树不在
 * 那个集合里**——设置卡片要能出现，本包就必须是宿主侧的一行（由 `cordis.patch.yml` 的无 `toolName`
 * 行承担，见 `lib/index.js`）。
 *
 * 反方向的约束同样不变：宿主侧的行**不得注册工具**（需求 §3.2：那会进全局工具层，塞给
 * 所有预设）。本模块零工具注册。
 *
 * ## 故障姿态
 *
 * - **首播失败 = 降级运行**（`lib/settings.js` 内 catch）：本行 config 坏（跨字段
 *   违例）时**不再 fail-fast**——这类违例能被设置页保存路径持久化（逐字段校验
 *   拦不住跨字段规则），若抛错让行不激活，`describe` 只收激活行、设置卡片整个
 *   消失，用户就失去应用内修复通道。降级 = 回退出厂默认值快照 + stderr 说明，
 *   行保持激活，改正保存即恢复。
 * - **volatile 刷新失败 = 用户输入问题，保旧快照**（`lib/settings.js` 内已 catch）：
 *   不打掉本行、不静默。
 *
 * ## 静默失败防护 c 防线：常驻纪律段（需求 §6.3）
 *
 * 宿主半边在快照播报之外**多注册一件事**：`ctx.inject(['systemPrompt', …], …)` 挂一条
 * 运行时 context（`async-tools:discipline`，order 130）——开关开时向组稿目标为
 * **本包两预设**的新会话注入执行纪律段；其余预设（含宿主行自身的其他会话）的
 * text 返回空串，由 `dsh-system-prompt` 的渲染层过滤（空串段不出现，
 * `lib/index.js:146-150`），context 本身不注销（避免注册窗口闪烁）。预设按组稿
 * 上下文现查（sessions + sessionProjections 投影），服务缺席的部署里子 scope
 * 不激活，纪律段整体不存在（失效安全方向 = 关）。
 *
 * 这是**运行时 inject 而非静态表**（sandbox-policy 成例）：静态 `inject` 列保持不变，
 * system-prompt 只在开关开的会话组稿时才被真正用到；没有 systemPrompt 服务的部署里
 * 子 scope 永不激活，插件照常装载（a/b 两防线不受影响）。
 *
 * @module dsh-async-tools/lib/host
 */
import { AskBatchRegistry, AskTakeoverService, shouldTakeover, TAKEOVER_PRESETS } from './ask-takeover.js';
import { attachSnapshotSource, readSnapshot } from './settings.js';
import { t } from './text.js';

/**
 * 宿主半边接入：播报快照 + 接 volatile 监听 + 静默失败纪律段注入。
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
  // 预设过滤（需求 §6.3 作用域）：text 收宿主组稿上下文（`systemPrompt.assemble` 传
  // `{agent, scope, signal}`），经 `sessions.get` + `sessionProjections.stateOf(
  // 'agentPreset')` 读目标会话的实际预设——与提问接管判定②同一条路径（同步、
  // 失败全关）。因此 inject 除 systemPrompt 外再挂 sessions/sessionProjections：
  // 任一缺席时子 scope 不激活、context 不注册，纪律段整体不存在（失效安全
  // 方向 = 关）；无 agent 的组稿同样返回空串，空段由 `dsh-system-prompt` 的
  // 渲染层过滤（`lib/index.js:146-150`）。
  ctx.inject(['systemPrompt', 'sessions', 'sessionProjections'], (scope) => {
    scope.systemPrompt.context({
      name: 'async-tools:discipline',
      order: 130,
      // text 是函数，每次组稿现求：读**当前快照**的开关与语言档，并按组稿目标
      // 会话的实际预设过滤——开关翻转/语言切换/预设变化都不需要重注册，下一次
      // 组稿即换。快照缺席、开关关、预设不在本包两预设之列、读取抛错一律 ''
      // （失效安全方向 = 关）。
      text: (assembly) => {
        try {
          const snap = readSnapshot();
          if (snap?.silentFailureGuard !== true) return '';
          const agent = assembly?.agent;
          if (agent === undefined || agent === null) return '';
          const session = scope.sessions?.get?.(agent.id);
          if (session === undefined || session === null) return '';
          const preset = scope.sessionProjections?.stateOf?.(session, 'agentPreset');
          return TAKEOVER_PRESETS.has(preset) ? t(snap.agentLang, 'discipline.block') : '';
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
