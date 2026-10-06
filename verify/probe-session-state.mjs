/**
 * 快速查看验证实例上的会话状态（是否有 running 会话）。
 * 用法：node verify/probe-session-state.mjs
 */
import { rpc } from './_rpc.mjs';

const listing = await rpc('session/list', { _request: {} });
const rows = listing.items.map((item) => ({
  id: item.sessionId.slice(0, 22),
  running: item.running,
  title: (item.title ?? '').slice(0, 30)
}));
const running = rows.filter((r) => r.running);
console.log(JSON.stringify(rows, null, 1));
console.log(running.length === 0 ? '无 running 会话。' : `有 ${running.length} 个 running 会话（上面 running=true 的行）。`);
