/**
 * 守哪条需求：需求 §2.3.1（async_agent 永远后台、立返、零等待原语）+ §3.1（执行纪律锚句）
 *
 * 两个变异，方向互补：
 * - M1 **前台形态回潮**：把 `startActivation` 换成宿主公开接口不存在的前台 `start`
 *   → 必须红在 test/agent.test.mjs 的"零前台哨兵"上（哨兵记录调用并抛可读错误，
 *   红因一目了然，不是泛型 TypeError）。
 * - M2 **强制规则被删**：把两语表 `discipline.preset.dsh-async` 键（en 档）里的
 *   委托规则段整段删掉——执行纪律走宿主半边运行时注入的 systemPrompt section，
 *   文案住在 `lib/text.js`，不再进 persona prefix
 *   → 必须红在 `tools/validate-preset.mjs` 的词典锚句判据（⑤b）上（校验目标是**包内文件**，
 *   不是已安装副本——已安装件按需求 §3.2 由使用者自管）。
 *
 * **本脚本会原地改写真实的 `lib/agent.js` 与 `lib/text.js`**，
 * 每个变异跑完立即写回，最后核对 sha256。
 *
 * 用法：node verify/mutate-agent.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从模块自身位置推仓根（verify/ 上一级）——变异脚本要在任意 cwd 下都能跑。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENT = join(ROOT, 'lib', 'agent.js');
const TEXT = join(ROOT, 'lib', 'text.js');
const TEST = 'test/agent.test.mjs';

const agentOriginal = readFileSync(AGENT, 'utf8');
const textOriginal = readFileSync(TEXT, 'utf8');
const agentHash = createHash('sha256').update(agentOriginal, 'utf8').digest('hex');
const textHash = createHash('sha256').update(textOriginal, 'utf8').digest('hex');

/** spawn 没跑起来时 execFileSync 错误的 code 形态。 */
const SPAWN_FAILURE_CODES = new Set(['EPERM', 'ENOENT', 'EACCES']);

/**
 * 跑测试文件并回读结果。结局三分类：green / red（含超时击杀）/ didnt-run。
 * @param {number} timeoutMs - 超时。
 * @returns {{state: 'green'|'red'|'didnt-run', summary: string, firstFail: string}} 结果。
 */
function runTests(timeoutMs) {
  let error;
  try {
    const out = execFileSync(process.execPath,
      ['--import', './tools/_host-hooks.mjs', '--test', TEST],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs });
    return { state: 'green', summary: summaryOf(out), firstFail: firstFailOf(out) };
  } catch (thrown) {
    error = thrown;
  }
  const out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  const timedOut = error.killed === true || error.code === 'ETIMEDOUT';
  const spawnFailed = !timedOut
    && (SPAWN_FAILURE_CODES.has(error.code) || (error.status == null && out === ''));
  if (spawnFailed) {
    return {
      state: 'didnt-run',
      summary: `没跑成（spawn 失败：${String(error.code ?? error.message).slice(0, 80)}）`,
      firstFail: ''
    };
  }
  return {
    state: 'red',
    summary: timedOut ? '（超时击杀）' : summaryOf(out),
    firstFail: firstFailOf(out)
  };
}

/**
 * 跑预设校验器（默认校验包内补丁 `presets/dsh-async.patch.yml`）。退出码 0=绿、1=红；spawn 失败=没跑成。
 *
 * **不要给它传位置参数**：位置参数会被当成模板目录路径，而模板目录形态已不存在——
 * 校验器对着不存在的路径退 1，基线永远是红的，等于自造坏判据。
 * @returns {{state: 'green'|'red'|'didnt-run', summary: string, firstFail: string}} 结果。
 */
function runPresetValidator() {
  let error;
  try {
    const out = execFileSync(process.execPath,
      ['tools/validate-preset.mjs'],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
    return { state: 'green', summary: '（退出码 0）', firstFail: '' };
  } catch (thrown) {
    error = thrown;
  }
  const out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  if (SPAWN_FAILURE_CODES.has(error.code) || (error.status == null && out === '')) {
    return {
      state: 'didnt-run',
      summary: `没跑成（spawn 失败：${String(error.code ?? error.message).slice(0, 80)}）`,
      firstFail: ''
    };
  }
  return {
    state: error.status === 1 ? 'red' : 'green',
    summary: `退出码 ${String(error.status)}`,
    firstFail: (out.split('\n').find((l) => l.includes('FAIL')) ?? '').trim().slice(0, 110)
  };
}

function summaryOf(out) {
  const fail = /ℹ fail (\d+)/.exec(out);
  return fail === null ? '（无 fail 摘要）' : `ℹ fail ${fail[1]}`;
}

function firstFailOf(out) {
  return (out.split('\n').find((l) => /^✖ /.test(l.trim())) ?? '').trim().slice(0, 110);
}

/** 写回原文并核对摘要。 */
function restore() {
  writeFileSync(AGENT, agentOriginal, 'utf8');
  writeFileSync(TEXT, textOriginal, 'utf8');
  const agentAfter = createHash('sha256').update(readFileSync(AGENT, 'utf8'), 'utf8').digest('hex');
  const textAfter = createHash('sha256').update(readFileSync(TEXT, 'utf8'), 'utf8').digest('hex');
  if (agentAfter !== agentHash || textAfter !== textHash) {
    throw new Error(`还原失败：请 git checkout 恢复 ${AGENT} 与 ${TEXT}。`);
  }
}

// M1 的锚点：lib/agent.js 的派生调用（设计 §3.3 startActivation 契约）。变异体走前台 start。
const M1_ANCHOR = [
  '      const activation = await ctx.subagents.startActivation({',
  '        provider: providerName,',
  '        label: args.description,',
  '        request,',
  '        signal: exec.signal,',
  "        delivery: 'parent'",
  '      });'
].join('\n');
const M1_MUTATED = [
  '      /* mutated M1: 前台形态回潮 */',
  '      const { childId } = await ctx.subagents.start(providerName, { ...request, signal: exec.signal });'
].join('\n');
/**
 * M2 变异：把两语表 `discipline.preset.dsh-async` 键（en 档）里的委托规则段
 * 整段删掉。
 *
 * **按词典键定位、行内按转义边界切割**：两语表里每个键是一整行源码，段界由
 * 字面 `\n`（源码里的两字符转义，不是换行）标记——从 `\nDELEGATION RULES`
 * 起删到 `\nASKING RULES` 前。找不到就返回 null，调用方按"变异失效＝失败"处理。
 * @param {string} source - 待变异的 `lib/text.js` 文本。
 * @returns {string|null} 变异后的文本，或 null（锚点不在）。
 */
function mutateM2(source) {
  const lines = source.split('\n');
  const keyIdx = lines.findIndex((l) => l.includes("'discipline.preset.dsh-async':"));
  if (keyIdx < 0) return null;
  const line = lines[keyIdx];
  const start = line.indexOf('\\nDELEGATION RULES (hard rules, not advice):');
  const end = line.indexOf('\\nASKING RULES (hard rules, not advice):');
  if (start < 0 || end < start) return null;
  lines[keyIdx] = `${line.slice(0, start)}\\n(mutated M2: delegation rules removed)${line.slice(end)}`;
  return lines.join('\n');
}

const baselineTests = runTests(120000);
const baselinePreset = runPresetValidator();
if (baselineTests.state !== 'green' || baselinePreset.state !== 'green') {
  console.log(`BASELINE  测试=${baselineTests.state}/${baselineTests.summary}；预设校验=${baselinePreset.state}/${baselinePreset.summary}——先修基线/换环境。`);
  process.exit(2);
}
console.log(`基线：${TEST} 全绿；预设补丁校验通过。`);
console.log('');

let ok = true;
try {
  // ── M1：前台形态回潮 ─────────────────────────────────────────────────────
  if (!agentOriginal.includes(M1_ANCHOR)) {
    console.log('SKIP  找不到 M1 锚点（startActivation 调用），本变异失效——当失败处理。');
    ok = false;
  } else {
    writeFileSync(AGENT, agentOriginal.replace(M1_ANCHOR, M1_MUTATED), 'utf8');
    const after = runTests(120000);
    if (after.state === 'didnt-run') {
      console.log(`DIDNT-RUN  M1 前台形态回潮  ${after.summary} —— 环境没跑成测试，不算 CAUGHT（fail-closed）`);
      ok = false;
    } else {
      const caught = after.state === 'red';
      console.log(`${caught ? 'CAUGHT' : 'MISSED'}  M1 startActivation→start（前台形态回潮）  ${after.summary}`);
      if (after.firstFail !== '') console.log(`        ${after.firstFail}`);
      ok = caught && ok;
    }
  }

  // ── M2：强制规则被删 ───────────────────────────────────────────────────────
  const m2Body = mutateM2(textOriginal);
  if (m2Body === null) {
    console.log('SKIP  找不到 M2 锚点（discipline.preset.dsh-async 的委托规则段），本变异失效——当失败处理。');
    ok = false;
  } else {
    writeFileSync(TEXT, m2Body, 'utf8');
    const after = runPresetValidator();
    if (after.state === 'didnt-run') {
      console.log(`DIDNT-RUN  M2 强制规则被删  ${after.summary} —— 环境没跑成校验，不算 CAUGHT（fail-closed）`);
      ok = false;
    } else {
      const caught = after.state === 'red';
      console.log(`${caught ? 'CAUGHT' : 'MISSED'}  M2 删掉词典委托规则段（纪律锚句）  ${after.summary}`);
      if (after.firstFail !== '') console.log(`        ${after.firstFail}`);
      ok = caught && ok;
    }
  }
} finally {
  restore();
}
console.log('');
console.log(ok ? '变异被抓住：后台形态与纪律锚句都有能失败的判据。' : '**变异逃逸或没跑成**——判据是恒真的，或环境不可用。');
console.log('还原完成，摘要一致。');
process.exitCode = ok ? 0 : 1;
