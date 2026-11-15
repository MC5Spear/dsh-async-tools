/**
 * 探针：本机能不能制造"rmSync 递归删除也失败"？
 *
 * 用途：为「运行目录清理失败只告警留现场」类收尾实现（如
 * verify/probe-recovery-identity.mjs 的 cleanup）提供本机 `rmSync(dir,
 * {recursive:true, force:true})` 失败形态的实证参考——逐种尝试制造失败并如实
 * 登记哪种有效。探针只登记形态，不代替各收尾路径自带的删除后存在性核对。
 * 在仓库根目录执行：`node tools/probe-rollback-failure.mjs`（自身用临时目录
 * 做样本，不触碰仓库内容；结果只打印到 stdout）。
 */
import { chmodSync, mkdirSync, mkdtempSync, openSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const results = [];
const attempt = (name, prepare) => {
  const base = mkdtempSync(join(tmpdir(), 'rbprobe-'));
  const dir = join(base, 'dsh-async');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.yml'), 'name: x\n', 'utf8');
  let cleanup;
  try {
    cleanup = prepare(dir);
  } catch (error) {
    results.push([name, `准备阶段就失败：${error.code ?? error.message}`]);
    rmSync(base, { recursive: true, force: true });
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    results.push([name, 'rmSync 成功（没能制造失败）']);
  } catch (error) {
    results.push([name, `rmSync 抛错 ${error.code ?? ''}：${String(error.message).slice(0, 70)}`]);
  }
  try { cleanup?.(); } catch { /* 清理失败无所谓 */ }
  rmSync(base, { recursive: true, force: true });
};

attempt('只读目录（chmod 0o500）', (dir) => {
  chmodSync(dir, 0o500);
  return () => chmodSync(dir, 0o700);
});

attempt('目录里有被占用的文件（Windows 打开句柄）', (dir) => {
  const handle = openSync(join(dir, 'preset.yml'), 'r');
  return () => closeSync(handle);
});

attempt('目录里有只读文件', (dir) => {
  writeFileSync(join(dir, 'agent.cordis.yml'), 'rows: []\n', 'utf8');
  chmodSync(join(dir, 'agent.cordis.yml'), 0o400);
  return () => chmodSync(join(dir, 'agent.cordis.yml'), 0o600);
});

attempt('子目录只读', (dir) => {
  const sub = join(dir, 'sub');
  mkdirSync(sub);
  chmodSync(sub, 0o500);
  return () => chmodSync(sub, 0o700);
});

console.log('=== 制造"回滚也失败"的尝试 ===');
for (const [name, outcome] of results) console.log(`  ${outcome.includes('成功') || outcome.includes('准备') ? '无效  ' : '有效  '}${name} → ${outcome}`);
console.log('');
const notEstablished = results.filter(([, outcome]) => outcome.startsWith('准备阶段就失败')).length;
const rmSyncOk = results.filter(([, outcome]) => outcome.startsWith('rmSync 成功')).length;
const threw = results.filter(([, outcome]) => outcome.startsWith('rmSync 抛错')).length;
console.log(`计数：尝试未成立 ${String(notEstablished)}（准备失败）/ rmSync 成功 ${String(rmSyncOk)} / 抛错 ${String(threw)}。`);
console.log(threw > 0
  ? '结论：本机有可行手段，可以真覆盖那条分支。'
  : '结论：本机 rmSync 对这些情形都成功——那条分支只能靠**注入失败**（例如把 rmSync 换掉）来覆盖。');
