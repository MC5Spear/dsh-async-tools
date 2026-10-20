/**
 * 生效配置快照（设计 §5.1 生效数据流）。
 *
 * ## 机制：宿主行播报、工具行读快照（设计 §5.1）
 *
 * 设置表单改的是**宿主行 entry**（`async-tools-host`）的 volatile 字段；
 * 提交走 loader 的**就地提交**（fiber 不重启），并向**拥有该 fiber** 的上下文派发
 * `'loader/volatile-update'`（`cordis-plugin-loader/lib/index.js:393-425`，类型声明
 * `lib/types/index.d.ts:24-29`）。预设子树的工具行**收不到**这个事件——它只发给
 * 宿主行自己。于是取值链是：
 *
 *     宿主行 apply：第二参 liveConfig（= fiber.config，settings 子树是活 Ref）
 *       → materialize → resolveConfig → seedSnapshot() + 装配侧自检武装
 *     volatile 提交：loader `updateVolatile` 原地改 Ref → 派发事件
 *       → 重物化 → 再 seed + refresh-bus 广播 + 重新确认武装
 *     工具行 execute：readSnapshot() ?? 本行默认值
 *
 * **活配置的唯一入口是 apply 的第二参**：cordis 没有 `ctx.config` 访问途径
 * （`ctx.config` 抛 `cannot get property "config" without inject`）；`Fiber.execute`
 * 把 `fiber.config` 作为第二参传给 apply（`cordis/lib/index.js:1068-1071`）。
 *
 * ## 为什么是"模块级"快照
 *
 * 宿主行与工具行是**两次装载**（宿主侧 / 预设子树），能共享的只有**同一次进程内的
 * 模块实例**（refresh-bus 同理，见 `lib/refresh-bus.js` 的模块头）。
 * 预设子树与宿主 include 是否解析到同一模块实例**静态不可证**（装载路径取决于宿主
 * 的解析布局），因此：
 * - 快照缺席（`undefined`）是**合法状态**：工具行退回本行默认值并在 stderr 说出口
 *   （静默早退是排查黑洞，见 `lib/index.js` 的接线说明）；
 * - "改设置 → 描述刷新"这条链**必须在验证实例端到端**（设计 §8 验证设计），不能只靠单测。
 *
 * ## 快照的可逆性（需求 §7.2 生命周期释放）
 *
 * seed 与事件监听都挂在**宿主行自己的 ctx** 上：宿主行卸载时 disposer 清空快照并
 * 撤销监听——插件效应完全跟随插件生命周期（需求 §7.2「按各自生命周期释放」），
 * 没有跨装载的残留。
 *
 * @module dsh-async-tools/lib/settings
 */
import {
  LOG_PREFIX, isOwnConfigCandidate, resolveConfig, resolveSettingsValue,
  setConfigValidationArmed, setConfigValidationDegraded
} from './config.js';
import { emitLifecycleNotice } from './notice.js';

/**
 * 当前快照；`undefined` = 宿主行未播报（未装载或装载在另一个模块实例）。
 * 冻结对象：读方不得就地改，写方只整体替换。
 */
let snapshot;

/**
 * 当前降级详情；`undefined` = 生效配置自检通过、无降级。
 *
 * 需求 §5.1「运行中收到非法配置时保留上一合法值并告警」的**模型可见**侧：
 * stderr 告警（`lib/notice.js`）只到操作者，模型看不到；降级事实登记在这里，
 * `lib/descriptions.js` 构建描述时拼一段警示——模型每次调用工具都看得到
 * 「当前配置自检失败、工具按上一合法值运行」，不再零线索。恢复（下次合法
 * 提交）时清空并再触发一次描述刷新，警示段随之消失（行为差异而非"存在但空"）。
 */
let degradedDetail;

/**
 * 登记降级详情（volatile 提交自检失败 / 首播自检失败两处调用）。
 * @param {string} detail - 自检失败的原文诊断（resolveConfig 抛错信息）。
 * @returns {void}
 */
export function seedDegraded(detail) {
  degradedDetail = typeof detail === 'string' ? detail : String(detail);
}

/**
 * 清空降级详情（合法提交自愈 / 宿主行卸载时）。
 * @returns {void}
 */
export function clearDegraded() {
  degradedDetail = undefined;
}

/**
 * 读取降级详情（描述警示段消费）。
 * @returns {string|undefined} 降级原文或 `undefined`（无降级）。
 */
export function readDegraded() {
  return degradedDetail;
}

/**
 * 宿主行播报一次生效配置（整体替换快照）。
 *
 * 值必须已经 `resolveConfig` 过（普通值、夹紧、跨字段自检都做完）。
 * @param {object} config - 冻结后的生效配置。
 * @returns {void}
 */
export function seedSnapshot(config) {
  snapshot = config;
}

/**
 * 读取快照。缺席时返回 `undefined`，由调用方决定回退（工具行退本行默认值）。
 * @returns {object|undefined} 生效配置或 `undefined`。
 */
export function readSnapshot() {
  return snapshot;
}

/**
 * 清空快照（宿主行卸载时由 disposer 调用；测试间复位也用它）。
 * @returns {void}
 */
export function clearSnapshot() {
  snapshot = undefined;
}

/**
 * 把一份活配置（apply 第二参 = `fiber.config`）物化并解析成生效快照（seed 的取值侧）。
 *
 * 独立导出是为了让"物化 → 解析"这条链可以被单测直接喂假 Ref（cosmokit
 * `createVolatile` 形状：冻结的 `{get}`，`cosmokit/lib/index.js:102-110`）。
 *
 * @param {object} liveConfig - 活配置对象（volatile 字段可能是 Ref，也可能是普通值
 *   ——测试与直挂路径两种形态都合法）。
 * @returns {object} 冻结后的生效配置。
 */
export function snapshotFromConfig(liveConfig) {
  return resolveConfig(liveConfig);
}

/** stderr 审计出口统一走 `lib/notice.js`（中文文案：操作者一侧，不进模型上下文，设计 §6.3）。 */

/**
 * 接上 volatile 提交监听并播报首份快照（宿主行 apply 的全部接线）。
 *
 * 故障姿态（设计 §5.1 生效数据流）：
 * - **装配侧自检决定回调形态（三形）**：自检成功即武装
 *   （`setConfigValidationArmed(true)`——schema 层的写入拒绝与运行中重载拦截
 *   就位）；自检失败即走降级（`setConfigValidationDegraded`，携带降级基线）。
 *   启动遇非法持久值时降级态保住行装配与设置卡片（describe 只收激活行，
 *   `dsh-settings/lib/index.js:413-419`），这是「修复入口不死」的交换；降级
 *   基线只放行与降级时刻自检失败值深度相等的提交（回调只见解析值，无法
 *   区分 loader 再解析与用户原样重存——放行不改变持久状态），与基线不同的
 *   非法写入照常拒绝，首次合法保存清基线并重新武装。
 * - **首播失败 = 降级运行，不 fail-fast**：跨字段违例能走到自检抛错的入口只剩
 *   降级基线（与基线等值的再解析／重存；与基线不同的非法值在 edit 落盘前被
 *   武装判据拒绝），此时若抛错让行不激活，设置卡片
 *   整个消失——用户失去唯一的应用内修复通道。所以首播失败的姿态是：
 *   **回退出厂默认值快照 + stderr 说明 + 行保持激活**（卡片继续显示原始
 *   非法值，用户改正保存即恢复，volatile-update 监听会自动接上）。
 * - **刷新失败 = 用户输入问题，保旧快照**：能走到自检抛错的只剩跨字段违例。
 *   保住上一份合法快照、stderr 说明、工具继续按旧快照运行——绝不打掉宿主行，
 *   也绝不静默（"保存成功但行为没变且零线索"正是要防的缺陷形态，需求 §5.1）。
 * - **运行中非法重载保旧＋告警**：武装态下 loader 的就地提交在 resolve 处被
 *   transform 回调拒绝（refs 不变、`loader/volatile-update` 不派发——loader
 *   `_commitVolatile` 的 catch 分支，`cordis-plugin-loader/lib/index.js:395-427`），
 *   本函数的 volatile 监听收不到事件。「最近提交原始值自检失败」的降级明细
 *   改在 `internal/config` waterfall 上登记（loader 在 resolve 前必经该
 *   waterfall），下次合法提交自愈。
 *
 * @param {object} ctx - 宿主行上下文（只用于事件监听与日志）。
 * @param {object} liveConfig - apply 第二参（= `fiber.config`）：`settings`
 *   子树是活 Ref，loader 就地提交**原地**改写；每次重物化都从它现读。
 * @returns {{ seeded: boolean, degraded: boolean, dispose: () => void }} 接线结果与处置器（调用方挂到 `ctx.effect`）。
 */
export function attachSnapshotSource(ctx, liveConfig) {
  let degraded = false;
  /** 降级登记 + 描述刷新转达（失败方向也要刷：警示段要出现；自愈再刷一次消失）。 */
  const markDegraded = (detail) => {
    seedDegraded(detail);
    void import('./refresh-bus.js').then((bus) => {
      bus.notifySettingsChanged(ctx.logger);
    }).catch((e) => {
      ctx.logger?.warn?.(`${LOG_PREFIX} 降级警示的描述刷新失败：${e instanceof Error ? e.message : String(e)}`);
    });
  };
  try {
    seedSnapshot(snapshotFromConfig(liveConfig));
    // 装配侧自检通过：武装（schema 层写入拒绝 + 重载拦截就位，设计 §5.1）。
    setConfigValidationArmed(true);
  } catch (error) {
    degraded = true;
    const detail = error instanceof Error ? error.message : String(error);
    // 降级态（携带降级基线，设计 §5.1 回调三形）：行必须活着、卡片必须在场
    // ——基线＝当次自检失败的已解析值，与它深度相等的输入放行（loader 再解析
    // 与用户原样重存在回调上不可区分），与基线不同的非法写入照常拒绝。
    setConfigValidationDegraded(resolveSettingsValue(liveConfig));
    // 回退出厂默认而不是拒绝激活：行死了设置卡片就消失（describe 只收激活行），
    // 用户在应用内就没有修复通道了——卡片活着显示原始值，改完保存即恢复。
    seedSnapshot(resolveConfig({}));
    // 首播降级也登记：工具行此刻多半还没建描述，读点在构建时（无需此刻刷描述；
    // 若已有行，刷新转达只会重拼同一段警示，无害）。
    markDegraded(detail);
    ctx.logger?.warn?.(`${LOG_PREFIX} 宿主行配置自检失败，忽略持久化设置、按出厂默认运行：${detail}（设置页显示的是原始值，改正后保存即恢复）`);
    emitLifecycleNotice(`${LOG_PREFIX} 宿主行忽略持久化的非法设置，按出厂默认运行：${detail}`);
  }

  const off = ctx.on('loader/volatile-update', () => {
    let next;
    try {
      next = snapshotFromConfig(liveConfig);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // 首次失败写降级基线（当次已解析值）；已在降级中的刷新失败维持既有
      // 基线、不因刷新重写（设计 §5.1）。武装态下的刷新失败与回调判据同源、
      // 常规不可达（refs 能更新说明回调已放行）——此处按防御性口径处理
      // 复检与回调判据意外漂移的形态。
      if (!degraded) {
        setConfigValidationDegraded(resolveSettingsValue(liveConfig));
      }
      // 模型可见告警（需求 §5.1）：降级登记进模块存储，描述警示段随之拼出。
      markDegraded(detail);
      ctx.logger?.warn?.(`${LOG_PREFIX} volatile 提交后配置自检失败，保留旧快照：${detail}`);
      emitLifecycleNotice(`${LOG_PREFIX} volatile 提交未生效（配置自检失败，保留旧值）：${detail}`);
      return;
    }
    degraded = false;
    // 每次合法 volatile 提交都重新确认武装（设计 §5.1；换回无基线的武装回调
    // 即清基线）；自愈：降级登记清空（警示段随本次刷新消失）。
    setConfigValidationArmed(true);
    clearDegraded();
    seedSnapshot(next);
    // 描述刷新经 refresh-bus 转达（工具行与宿主行不在同一 fiber）。
    // 动态 import 避免模块环：refresh-bus 不依赖本模块，但保持单向更稳。
    // `.catch` 必须有——这条 promise 只可能 reject（import 失败/广播抛错），
    // 快照已落，失败只影响描述刷新转达，不该因此能杀死实例。
    void import('./refresh-bus.js').then((bus) => {
      bus.notifySettingsChanged(ctx.logger);
    }).catch((e) => {
      ctx.logger?.warn?.(`${LOG_PREFIX} 设置变更广播失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  // 运行中非法重载的降级登记（设计 §5.1）：loader 的就地提交在 resolve 前必经
  // `internal/config` waterfall——武装态提交会在其后被 resolve 拒绝（refs 不变、
  // volatile-update 不派发），「最近提交原始值自检失败」只能在这里看见。部分
  // 形状 raw（simplify 写回剥除了与默认值相等的键）经 resolve 补默认值后判据
  // 同样成立；本监听只登记、不改写候选（resolve 侧才是权威判据），始终放行
  // `next()`。降级态下与基线等值的提交会通过 resolve 并走到 volatile-update
  // 监听的 catch（保旧＋告警双登记，同一份降级事实）；与基线不同的非法提交
  // 仍在这里登记（edit 随后拒绝、文件不动），下次合法提交自愈。
  //
  // 候选先过归属甄别（isOwnConfigCandidate）：waterfall 是全树级的，宿主自身
  // 与其他插件的行（真实实例上已见 `subagent`／`subagent_fork`）同样流经——
  // 非本包候选直接续链，不进自检（假降级会污染模型可见的描述警示段）。
  const offInternalConfig = ctx.on('internal/config', (config, next) => {
    if (isOwnConfigCandidate(config)) {
      try {
        snapshotFromConfig(config);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        markDegraded(`recent commit failed self-check, keeping last legal values: ${detail}`);
        ctx.logger?.warn?.(`${LOG_PREFIX} 最近提交的原始值自检失败，保留上一合法值：${detail}`);
        emitLifecycleNotice(`${LOG_PREFIX} 最近提交的设置未生效（自检失败，保留上一合法值）：${detail}`);
      }
    }
    // 真实调用链是 waterfall（第二参 next 必在）；直调/裸 emit 形态没有 next，
    // 缺席时不续链（本监听只读不改写候选，缺席无副作用）。
    return typeof next === 'function' ? next() : undefined;
  });

  return {
    seeded: true,
    get degraded() { return degraded; },
    dispose: () => {
      off();
      offInternalConfig();
      clearSnapshot();
      clearDegraded();
    }
  };
}
