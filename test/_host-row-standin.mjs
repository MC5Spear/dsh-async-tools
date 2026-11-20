/**
 * F04 进程内调用链的替身宿主行（`test/config.test.mjs` 的进程内段消费）。
 *
 * 真实 schema（`lib/config.js` 的 `Config`）、真实接线（`lib/settings.js` 的
 * `attachSnapshotSource`）——只有插件外壳是替身：apply 不注册任何工具、不消费
 * 任何服务，供 loader／dsh-config-editor／dsh-settings 在进程内对
 * 「settings 子树形态 + 行身份字段保护 + 武装两态」做整链断言（设计 §5.1）。
 * `STATE.applies` 记录装配次数（重挂类断言核对）；`wirings` 按行留存接线
 * 句柄（多行共存时处置不串行）。
 *
 * `name` 必须与本包真实模块名一致（N-CFG-01）：loader 把模块的 `name` 导出
 * 登记为 `fiber.runtime.name`，`internal/config` waterfall 的归属甄别
 * （`isOwnRowFiber`）按它核实行归属——替身行要模拟「本包行」就得同名，
 * 否则自检永不触发、进程内段的降级登记断言必红。
 */
import { attachSnapshotSource } from '../lib/settings.js';

export { Config } from '../lib/config.js';

export const name = 'dsh-async-tools';

export const STATE = { applies: 0, wirings: [] };

export function apply(ctx, liveConfig) {
  STATE.applies += 1;
  const wiring = attachSnapshotSource(ctx, liveConfig);
  STATE.wirings.push(wiring);
  ctx.effect(() => () => wiring.dispose(), 'f04-standin: host row snapshot wiring');
}
