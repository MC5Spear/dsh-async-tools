/**
 * 目标：证明这两条判据**真的能失败**。
 *
 * 只断言**事后计数**的顺序用例名不副实：把审批挪到 `ctx.shell.start()` 之后，
 * 那几条断言**全绿**。判据必须在**审批那一刻**取快照（`resolveCallsAtApproval`）。
 * 快照断言本身也必须被证明能失败，否则只是把"名不副实"换了个地方。
 *
 * | 变异 | 改什么 | 应当抓住 |
 * |---|---|---|
 * | M1 | 把审批**挪到** `shell.resolve` 之后（顺序倒置） | `resolveCallsAtApproval[0] === 0` 变红 |
 * | M2 | 把"无 agent"那一步绕过（先判 `exec.agent` 为 undefined 时直接放行） | agent-less 用例变红 |
 *
 * 本脚本会原地改写真实的 `lib/jobs.js`，跑完在 `finally` 里写回并核对摘要。
 *
 * 用法：node verify/mutate-escalation-order.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从模块自身位置推仓根（verify/ 上一级）——变异脚本要在任意 cwd 下都能跑。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARGET = join(ROOT, 'lib', 'jobs.js');
const TEST = 'test/escalation.test.mjs';

const original = readFileSync(TARGET, 'utf8');
const hashBefore = createHash('sha256').update(original, 'utf8').digest('hex');

/**
 * 跑目标测试。
 *
 * @returns {{red: boolean, summary: string, firstFail: string}} 结果。
 */
function runTests() {
  const collect = (out) => {
    const fail = /ℹ fail (\d+)/.exec(out);
    return {
      summary: fail === null ? '（无 fail 摘要）' : `ℹ fail ${fail[1]}`,
      firstFail: (out.split('\n').find((l) => /^✖ /.test(l.trim())) ?? '').trim().slice(0, 96)
    };
  };
  try {
    const out = execFileSync(process.execPath, ['--import', './tools/_host-hooks.mjs', '--test', TEST],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 180000 });
    return { red: false, ...collect(out) };
  } catch (error) {
    return { red: true, ...collect(`${error.stdout ?? ''}${error.stderr ?? ''}`) };
  }
}

/** 写回原文并核对摘要。 */
function restore() {
  writeFileSync(TARGET, original, 'utf8');
  const after = createHash('sha256').update(readFileSync(TARGET, 'utf8'), 'utf8').digest('hex');
  if (after !== hashBefore) throw new Error(`还原失败：${TARGET} 与变异前不一致，请 git checkout 恢复。`);
}

/** M1：顺序倒置——把审批块挪到 `ctx.shell.resolve` 之后、注册准入之前。 */
const M1_BLOCK = `      validateEscalationArgs(args.sandbox_permissions, args.justification);
      const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
        ? await approveRunEscalation(args.sandbox_permissions, args.justification, exec, sandboxPolicy)
        : undefined;`;

const MUTATIONS = [
  {
    name: 'M1 顺序倒置：审批挪到 shell.resolve 之后',
    anchor: M1_BLOCK,
    /**
     * 把审批块剪掉、并在 spec 解析之后（`shell.resolve` 已跑完、注册准入之前）
     * 重新插回去。
     *
     * @param {string} text - 原文。
     * @returns {string|null} 变异体。
     */
    apply(text) {
      if (!text.includes(M1_BLOCK)) return null;
      const withoutBlock = text.replace(M1_BLOCK, '      const approvedMode = undefined;');
      // 在注册准入（startForegroundJob）之前把审批插回去 —— 那时 resolve 已经跑过了。
      const at = withoutBlock.indexOf('      const started = startForegroundJob(ctx, {');
      if (at < 0) return null;
      const late = `      const lateApproved = args.sandbox_permissions !== undefined && args.justification !== undefined
        ? await approveRunEscalation(args.sandbox_permissions, args.justification, exec, sandboxPolicy)
        : undefined;
      void lateApproved;\n`;
      return `${withoutBlock.slice(0, at)}${late}${withoutBlock.slice(at)}`;
    }
  },
  {
    name: 'M2 agent-less 绕过：无 agent 检查短路成放行',
    /** 把拒绝抛错换成静默放行（owner 落到 undefined，注册无主作业）。 */
    apply(text) {
      const block = `      if (exec.agent?.id === undefined) {
        throw new Error(t(lang, 'error.noAgentRun'));
      }`;
      if (!text.includes(block)) return null;
      return text.replace(block, '      if (exec.agent?.id === undefined) { void lang; }');
    }
  }
];

const baseline = runTests();
if (baseline.red) {
  console.log(`BASELINE-RED  未变异时 ${TEST} 就是红的（${baseline.summary}）——先修基线；若括号里是空的、且本脚本以 2 退出，更可能是默认沙箱禁止捕获子进程输出（EPERM）：本脚本要跑测试文件，需带提权运行。规范见 verify/README.md 的「优先默认权限执行；纯函数判断尽量进程内复用」要点。`);
  process.exit(2);
}
console.log(`基线：未变异时 ${TEST} 全绿（${baseline.summary}）。`);
console.log('');

let ok = true;
try {
  for (const m of MUTATIONS) {
    const mutated = m.apply(original);
    if (mutated === null) {
      console.log(`SKIP  ${m.name}——锚点不匹配，本变异失效，当失败处理。`);
      ok = false;
      continue;
    }
    writeFileSync(TARGET, mutated, 'utf8');
    const after = runTests();
    console.log(`${after.red ? 'CAUGHT' : 'MISSED'}  ${m.name}  ${after.summary}`);
    if (after.firstFail !== '') console.log(`        ${after.firstFail}`);
    ok = after.red && ok;
  }
} finally {
  restore();
}
console.log('');
console.log(ok ? '变异被抓住：顺序断言真的能拦住"审批后置"。' : '**变异逃逸**——顺序断言区分力不足。');
console.log('还原完成，摘要一致。');
process.exitCode = ok ? 0 : 1;
