/**
 * 宿主半边（**角色**，不是独立入口）：播报设置快照，不注册任何工具。
 *
 * ## 0.1.7 的定位（§21）
 *
 * 0.1.5 的宿主半边注册**设置命名空间**（`settings.installSection`）并接入**预设生命
 * 周期**（文件系统对账）。0.1.7 里这两件事都不存在了：
 *
 * - 设置表单来自 **entry Config 的 volatile 字段**（宿主行 `async-tools-host` 的
 *   `dsh.bundle.patch` 行配置），由插件管理页的 **`plugins.bundle.config`** keyed 槽渲染在
 *   **本包插件页的描述与组件行之间**（键 = 包名，`client.js` 注册；§21.4）——
 *   不需要任何命名空间注册代码；
 * - 预设行生命周期由 loader 拥有：补丁在，预设就在；补丁移除，预设消失。
 *
 * 于是宿主角色只剩一件事：**把本行 config 物化成生效快照、并跟随 volatile 提交刷新**
 * （`lib/settings.js` 的 `attachSnapshotSource`）。
 *
 * ## 为什么宿主半边仍必须待在宿主平面
 *
 * `dsh-client-modules` 只遍历 `ctx.loader.entries()`（`dsh-client-modules/lib/index.js:475`）
 * 来决定把哪些包的前端代码发给浏览器，而**预设子树不在那个集合里**——设置卡片要能
 * 出现，本包就必须是宿主平面的一行（这是 0.1.5 时代"拆宿主包"的原始理由，0.1.7
 * 依旧成立；单包化后由 `cordis.patch.yml` 的无 `toolName` 行承担，见 `lib/index.js`）。
 *
 * 反方向的约束同样不变：宿主平面的行**不得注册工具**（R4：那会进全局工具层，塞给
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
 * ## R28 c 防线：常驻纪律段（§30.4，裁决 R28-E）
 *
 * 宿主半边在快照播报之外**多注册一件事**：`ctx.inject(['systemPrompt'], …)` 挂一条
 * 运行时 context（`async-tools:discipline`，order 130）——开关开时向**宿主行所有新
 * 会话**（含不装载本包工具的预设）注入执行纪律段；关时 text 函数返回空串，由
 * `dsh-system-prompt` 的渲染层过滤（空串段不出现，`lib/index.js:146-150`），context
 * 本身不注销（避免注册窗口闪烁）。
 *
 * 这是**运行时 inject 而非静态表**（sandbox-policy 成例）：静态 `inject` 列保持不变，
 * system-prompt 只在开关开的会话组稿时才被真正用到；没有 systemPrompt 服务的部署里
 * 子 scope 永不激活，插件照常装载（a/b 两防线不受影响）。
 *
 * @module dsh-async-tools/lib/host
 */
import { AskBatchRegistry, AskTakeoverService, shouldTakeover } from './ask-takeover.js';
import { attachSnapshotSource, readSnapshot } from './settings.js';
import { t } from './text.js';

/**
 * 宿主半边接入：播报快照 + 接 volatile 监听 + R28 纪律段注入。
 *
 * 快照链**无服务依赖**（`'loader/volatile-update'` 是 loader 派发给**本 fiber** 的
 * 事件，`cordis-plugin-loader/lib/index.js:393-425`，监听挂在宿主行自己的 ctx 上）；
 * 纪律段则 `ctx.inject(['systemPrompt'], …)`（静态 inject 列不动，见文件头）。
 *
 * @param {object} ctx - 宿主行上下文。
 * @param {object} liveConfig - apply 的第二参（= `fiber.config`）：resolved 配置对象，
 *   volatile 字段是**活 Ref**（`Schema.resolve` 包的 `createVolatile` 产物），loader
 *   的就地提交通过 `updateVolatile` **原地**改写它们（`_commitVolatile`，
 *   `cordis-plugin-loader/lib/index.js:410-415`）。⚠️ cordis 0.1.7 **没有 `ctx.config`**
 *   这个访问面（`ctx.config` 抛 `cannot get property "config" without inject`，真 cordis
 *   实测；活配置唯一入口就是 apply 的第二参）——快照链必须持有这个对象。
 */
export function applyHostHalf(ctx, liveConfig) {
  const wiring = attachSnapshotSource(ctx, liveConfig);
  ctx.effect(() => wiring.dispose, '[async-tools] host snapshot source');

  // R28 c 防线：`systemPrompt` 子 scope 的运行时 context 注册。`name` 命名空间化照
  // `sandbox:policy` 成例；`order` 直接传字面量 130——`getContextOrder` 只解析三个
  // 内置名（110/115/120），未知名返回 undefined 而 `context()` 要求有限数，
  // 130 排在 SUBAGENT_DELEGATION 之后、与策略簇相邻。
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'async-tools:discipline',
      order: 130,
      // text 是函数，每次组稿现求：读**当前快照**的开关与语言档——
      // 开关翻转/语言切换都不需要重注册，下一次组稿即换。快照缺席也返回 ''
      // （失效安全方向 = 关）。
      text: () => {
        const snap = readSnapshot();
        return snap?.silentFailureGuard === true ? t(snap.agentLang, 'discipline.block') : '';
      }
    });
  });

  // R30 提问接管（§32.2）：宿主半边在 `user-questions/request` waterfall 上 prepend
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
    readSnapshot,
    // 迟到作答唤醒事件的发布面（§32.5）：普通 cordis 频道事件，宿主行 emit 对
    // 全部 ctx.on 监听器可达（async_wait_* 在工具行订阅，LATE_ANSWER_EVENT 同源）。
    emit: (name, payload) => ctx.emit(name, payload)
  });
  new AskTakeoverService(ctx, askRegistry);
  // R36-d：会话收尾尽力清暂停标志（agent/disposed 的 payload 是 {agent}，
  // dsh-agent runtime-types.d.ts:240-242；宿主行作用域可收到。
  // web 会话常驻下不必然触发——残留由插件生命周期兜底，§36.6）。
  const askDisposedListener = ctx.on('agent/disposed', ({ agent }) => {
    askRegistry.forgetSession(agent?.id);
  });
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
    askDisposedListener();
    askRegistry.disposeAll();
  }, '[async-tools] ask takeover wiring');
}
