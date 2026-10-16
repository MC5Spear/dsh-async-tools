// 重启前置检查（只读）。本脚本**只报告实际核验到的结果**：
// - 检查 1（session/list 近 10 分钟活跃数）是真实读数，也是唯一自动判定的检查项。
// - 进程独立性、重启脚本目标这两条是**静态陈述**，本脚本无法核验——按「待人工
//   核实」列出，不打印成已通过。重启许可 = 检查 1 通过 **且** 待核实清单逐条
//   人工确认；任何一项未核实都不能当成通过。
// 判定口径：session/list 查询失败或返回形状异常按**未通过**处理（拿不到读数
// 就是没有核验，不是零活跃）。
import { rpc } from './_rpc.mjs';

let listing;
let queryError = null;
try {
  listing = await rpc('session/list', { _request: {} });
} catch (error) {
  queryError = error instanceof Error ? error.message : String(error);
}

const sessions = Array.isArray(listing?.items) ? listing.items : null;
const now = Date.now();
if (queryError !== null) {
  console.log(`检查1 session/list：查询失败（${queryError}）——未核验，按不通过处理`);
  process.exitCode = 1;
} else if (sessions === null) {
  console.log('检查1 session/list：返回形状异常（无 items 数组）——未核验，按不通过处理');
  process.exitCode = 1;
} else {
  const active = sessions
    .map((s) => ({ id: s.sessionId ?? s.id, updatedAt: s.updatedAt, ageMin: Math.round((now - new Date(s.updatedAt).getTime()) / 60000) }))
    .filter((s) => Number.isFinite(s.ageMin) && s.ageMin < 10);
  const sorted = [...sessions].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  console.log(`检查1 session/list：共 ${sessions.length} 个会话；近 10 分钟活跃 ${active.length} 个`);
  if (sorted.length > 0) {
    const newest = sorted[0];
    console.log(`     最新一条 ${String(newest.sessionId ?? newest.id).slice(0, 8)}… 距今 ${Math.round((now - new Date(newest.updatedAt).getTime()) / 60000)} 分钟`);
  }
  if (active.length > 0) {
    console.log('检查1 未通过——有活跃会话，禁止重启：');
    for (const s of active) console.log(`  - ${String(s.id).slice(0, 8)}… ${s.ageMin} 分钟前`);
    process.exitCode = 1;
  } else {
    console.log('检查1 通过（近 10 分钟无活跃会话）。');
  }
}

// 待人工核实清单：本脚本核验不了的事项，逐条列出；这里的每一条都**不是**通过。
console.log('待人工核实（脚本无法核验，重启前逐条确认）：');
console.log('  - 本会话与目标实例分属不同进程树（目标实例是独立托管服务进程）');
console.log('  - restart-one.ps1 的目标确实只有该托管服务，不触碰其他实例');
console.log('  - 除本会话外没有其他会话/任务依赖目标实例的当次状态');
if (process.exitCode === 0 || process.exitCode === undefined) {
  console.log('结论：自动检查未拦截；重启许可以完成上面的待核实清单为前提。');
} else {
  console.log('结论：自动检查已拦截（见上）——不可重启。');
}
