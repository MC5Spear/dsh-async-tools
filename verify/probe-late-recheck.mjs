/**
 * 两段式反向验证：`test/jobs.test.mjs` 的「N2·防御路径」用例**真的能红**吗？
 *
 * 这条用例守的是"注册后的紧邻复查必须与 `get` 同处一个同步块"（`lib/jobs.js` 的
 * `registerLateJob()`）。它的判据曾是 `sequence.indexOf('get') < sequence.indexOf('microtask-after-get')`
 * ——**恒真**：两个标记的先后由替身自己的调度决定，与被测代码是否 await 无关。独立复审
 * （glm-5.3，2026-09-25）点名了它，现已改成"替身在 `get()` 里把终态排进微任务翻转 + 断言分支结果"。
 *
 * 本探针把那次复查整段挪进 `queueMicrotask`（等价于"有人破坏了同一同步块"），用来证明新判据能红。
 * 它**不能一次跑完**：跑测试要么起子进程（默认沙箱下 spawn EPERM），要么用
 * `--test-isolation=none` 由外部命令跑——所以这里只做两段式手术，跑测试的命令由人执行。
 *
 * ## 用法（两段式；脚本自身不带跑测试的能力，这是沙箱约束下的取舍）
 *
 * ```powershell
 * node verify/probe-late-recheck.mjs patch
 * node --import ./tools/_host-hooks.mjs --test --test-isolation=none --test-reporter=dot test/jobs.test.mjs
 * node verify/probe-late-recheck.mjs restore
 * node --import ./tools/_host-hooks.mjs --test --test-isolation=none --test-reporter=dot test/jobs.test.mjs
 * ```
 *
 * ## 实测读数（2026-09-25）
 *
 * - `patch` 后：`✖ async_run（N2·防御路径）…` → `AssertionError: 必须告诉模型现在就能取全部输出`，
 *   actual 退化成普通句柄文案（"The command is still running…"），退出码 1。
 * - `restore` 后：该文件全部用例通过、退出码 0（**不写死条数**——用例会随文件增长，写死必然失真：独立复审（glm-5.3，2026-09-25）就是按"头注说 13/13、实际约 29 条"点出这处不一致的）。
 *
 * ⚠️ 跑测试**必须带** `--test-isolation=none`：不带时 runner 会为每个测试文件 spawn 子进程，
 * 默认沙箱下必然 `spawn EPERM` —— 那与判据无关，会把"环境不允许"误读成"判据生效"（本探针
 * 第一次尝试就是这么误报的）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从模块自身位置推仓根（verify/ 上一级）——探针要在任意 cwd 下都能跑。
const FILE = join(fileURLToPath(new URL('..', import.meta.url)), 'lib', 'jobs.js');
const ORIGINAL_SNIPPET = `  let settledAtRegistration = false;
  try {
    const snapshot = ctx.jobs.get(jobId, owner);
    if (isTerminalStatus(snapshot.status)) settledAtRegistration = true;
  } catch {
    // 复查失败不影响接管本身：作业已经注册，最坏结果只是文案少说一句"立刻取"。
  }`;
const MUTATED_SNIPPET = `  let settledAtRegistration = false;
  queueMicrotask(() => {
    try {
      const snapshot = ctx.jobs.get(jobId, owner);
      if (isTerminalStatus(snapshot.status)) settledAtRegistration = true;
    } catch {
      // 探针变异体：复查被挪出同步块。
    }
  });`;

const mode = process.argv[2];
const text = readFileSync(FILE, 'utf8');

if (mode === 'patch') {
  if (!text.includes(ORIGINAL_SNIPPET)) {
    console.log('未命中原始片段——文件已被改过？未做任何修改。');
    process.exitCode = 1;
  } else {
    writeFileSync(FILE, text.replace(ORIGINAL_SNIPPET, MUTATED_SNIPPET), 'utf8');
    console.log('已注入变异：复查被挪出同步块。现在跑测试应当变红（记得 --test-isolation=none）。');
  }
} else if (mode === 'restore') {
  if (text.includes(MUTATED_SNIPPET)) {
    writeFileSync(FILE, text.replace(MUTATED_SNIPPET, ORIGINAL_SNIPPET), 'utf8');
    console.log('已还原。');
  } else {
    console.log('未找到变异片段——内容未变。');
  }
} else {
  console.log('用法：node verify/probe-late-recheck.mjs patch | restore');
  process.exitCode = 2;
}
