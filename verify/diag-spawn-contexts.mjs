/**
 * 对照实验：同一个"起子进程 + 捕获输出"的动作，在三种宿主里结果是否不同？
 *
 * 已知：默认沙箱下 `verify/diag-child-capture.mjs` 里 spawnSync/execFileSync 全是 EPERM。
 * 但 `npm test`（node --test）里 `test/doc-paths.test.mjs` 也用 execFileSync + pipe，却 192/192 全过。
 * 两者必有一个解释，不能靠猜——本脚本把三种宿主并排跑一遍。
 *
 * 用法：node verify/diag-spawn-contexts.mjs
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, '.rprobe-spawn');

mkdirSync(PROBE, { recursive: true });
const childScript = join(PROBE, 'child.mjs');
writeFileSync(childScript, 'console.log("CHILD_OK");\n', 'utf8');

/** 跑一次并归成一行的读数。 */
function attempt(label, args, options) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', ...options });
  const err = result.error === undefined ? '' : ` error=${result.error.code ?? ''}`;
  console.log(`${label}: status=${String(result.status)} stdout=${JSON.stringify((result.stdout ?? '').trim())}${err}`);
  return result;
}

console.log('宿主：直接跑（node diag-spawn-contexts.mjs）');
attempt('  相对脚本路径 + pipe ', ['.\\verify\\.rprobe-spawn\\child.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: join(HERE, '..') });
attempt('  绝对脚本路径 + pipe ', [childScript], { stdio: ['ignore', 'pipe', 'pipe'] });
attempt('  绝对脚本路径 + inherit', [childScript], { stdio: ['ignore', 'inherit', 'inherit'] });
attempt('  绝对脚本路径 + ignore ', [childScript], { stdio: ['ignore', 'ignore', 'ignore'] });

// 把同样的三个动作包成一个测试文件，交给 node --test 跑（模拟 npm test 的宿主）。
const testFile = join(PROBE, 'context.test.mjs');
writeFileSync(testFile, `import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
const child = ${JSON.stringify(childScript)};
test('pipe 捕获', () => {
  const r = spawnSync(process.execPath, [child], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('    [in-test] status=' + String(r.status) + ' stdout=' + JSON.stringify((r.stdout ?? '').trim()) + ' error=' + String(r.error?.code ?? ''));
});
test('inherit 不捕获', () => {
  const r = spawnSync(process.execPath, [child], { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
  console.log('    [in-test] status=' + String(r.status) + ' error=' + String(r.error?.code ?? ''));
});
`, 'utf8');

console.log('\n宿主：node --test（把上面的动作放进测试文件里跑）');
const viaTest = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=spec', testFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
console.log(`  测试载体自身 status=${String(viaTest.status)} error=${String(viaTest.error?.code ?? '')}`);
for (const line of `${viaTest.stdout ?? ''}${viaTest.stderr ?? ''}`.split('\n')) {
  if (line.includes('[in-test]') || line.includes('pass ') || line.includes('fail ')) console.log(`  ${line.trim()}`);
}

rmSync(PROBE, { recursive: true, force: true });
