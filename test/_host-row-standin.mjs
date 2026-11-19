/**
 * F04 进程内调用链的替身宿主行（`test/config.test.mjs` 的进程内段消费）。
 *
 * 真实 schema（`lib/config.js` 的 `Config`）、真实接线（`lib/settings.js` 的
 * `attachSnapshotSource`）——只有插件外壳是替身：apply 不注册任何工具、不消费
 * 任何服务，供 loader／dsh-config-editor／dsh-settings 在进程内对
 * 「settings 子树形态 + 行身份字段保护 + 武装两态」做整链断言（设计 §5.1）。
 * `STATE.applies` 记录装配次数（重挂类断言核对）；`wirings` 按行留存接线
 * 句柄（多行共存时处置不串行）。
 */
import { attachSnapshotSource } from '../lib/settings.js';

export { Config } from '../lib/config.js';

// 模块名与产品包一致（N-CFG-01 行归属甄别：fiber.runtime.name＝模块 `name`
// 导出——替身行要在 internal/config waterfall 里被认作本包行，须用本包名；
// 原替身后缀名在甄别修复后会被当外来行跳过自检，进程内链断言全部失明）。
export const name = 'dsh-async-tools';

export const STATE = { applies: 0, wirings: [] };

export function apply(ctx, liveConfig) {
  STATE.applies += 1;
  const wiring = attachSnapshotSource(ctx, liveConfig);
  STATE.wirings.push(wiring);
  ctx.effect(() => () => wiring.dispose(), 'f04-standin: host row snapshot wiring');
}
