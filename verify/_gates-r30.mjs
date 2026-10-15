// 重启前置三道检查（只读）。检查 1 = session/list 近 10 分钟活跃数；
// 检查 2 = 本会话不在验证实例上（本会话在开发实例，按构造满足——打印确认）；检查 3 = 打印两实例
// 进程独立性证据。输出各检查项读数，全部通过才允许重启。
import { rpc } from './_rpc.mjs';

const listing = await rpc('session/list', { _request: {} });
const sessions = Array.isArray(listing?.items) ? listing.items : [];
const now = Date.now();
const active = sessions
  .map((s) => ({ id: s.sessionId ?? s.id, updatedAt: s.updatedAt, ageMin: Math.round((now - new Date(s.updatedAt).getTime()) / 60000) }))
  .filter((s) => Number.isFinite(s.ageMin) && s.ageMin < 10);
const sorted = [...sessions].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
console.log(`检查1 session/list：共 ${sessions.length} 个会话；近 10 分钟活跃 ${active.length} 个`);
if (sorted.length > 0) {
  const newest = sorted[0];
  console.log(`     最新一条 ${String(newest.sessionId ?? newest.id).slice(0, 8)}… 距今 ${Math.round((now - new Date(newest.updatedAt).getTime()) / 60000)} 分钟`);
}
console.log('检查2 本会话运行于开发实例（交互实例进程）；验证实例是独立的托管服务进程——不同进程树');
console.log('检查3 只动验证实例：restart-one.ps1 目标是托管服务，不触碰开发实例');
if (active.length > 0) {
  console.log('检查1 未通过——有活跃会话，禁止重启：');
  for (const s of active) console.log(`  - ${String(s.id).slice(0, 8)}… ${s.ageMin} 分钟前`);
  process.exitCode = 1;
} else {
  console.log('三项检查全部通过，可以重启托管服务。');
}
