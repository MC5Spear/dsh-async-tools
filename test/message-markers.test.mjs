/**
 * 共享判据锚模块（verify/message-markers.mjs）的反漂移回归（设计 §8.3 形状契约）。
 *
 * ## 为什么要有这个测试
 *
 * 探针判据锚与词典文案脱节时判据假红（根因形态：脚本各自持锚副本，词典改了
 * 锚没跟）。共享锚模块解决「多副本漂移」，本测试解决「单副本与词典
 * 脱节」：每个词典锚用 `t()` 在**两档**渲染出处键断言命中——锚改丢半边、词典
 * 改掉锚句、出处键改名（t() 对未知键抛错）三种漂移都红。宿主渲染锚
 * （JOB_LIST_RUNNING/HOST_JOB_NOTICE/HOST_JOB_FINISHED）以真实不透明编号形态
 * ＋旧数字夹具为正例、以自述文本／异类型行／非目标状态为反例钉住接受条件。
 *
 * C 组对账模块导出键集与 A/B 组用例完全一致：新锚漏测即红，锚被误删即红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as MARKERS from '../verify/message-markers.mjs';
import { t } from '../lib/text.js';

const LANGS = ['en', 'zh'];

// ── A 组：词典锚反漂移 ────────────────────────────────────────────────────────

test('A 组·词典锚反漂移：锚命中 t() 两档渲染的出处键（任一侧漂移即红）', () => {
  // note.interrupted：subject 用 34 字符真实形态，检验 SUBJECT_UNTOUCHED 的
  // 60 字符窗口（窗口过窄即红，过宽被反例组钉在 B 组之外的探针现场）。
  const interruptedVars = {
    waitedMs: 1200,
    subject: 'job async-command-29bb2c6b2dff4ad9',
    resume: 'async_wait(targets=[{kind:"job", id:"async-command-29bb2c6b2dff4ad9"}], wait_ms=30000)'
  };
  for (const lang of LANGS) {
    const text = t(lang, 'note.interrupted', interruptedVars);
    assert.ok(MARKERS.WAIT_INTERRUPTED.test(text), `${lang} note.interrupted ↔ WAIT_INTERRUPTED`);
    assert.ok(MARKERS.SUBJECT_UNTOUCHED.test(text), `${lang} note.interrupted ↔ SUBJECT_UNTOUCHED（60 字符窗口）`);
  }

  // CHILD_SETTLED 三选一＝三个词典出口，逐条对位。
  const settledKeys = [['note.settled', { agentId: 'child-7f3e' }], ['via.idle', {}], ['via.recheck', {}]];
  settledKeys.forEach(([key, vars], i) => {
    for (const lang of LANGS) {
      assert.ok(MARKERS.CHILD_SETTLED[i].test(t(lang, key, vars)), `${lang} ${key} ↔ CHILD_SETTLED[${String(i)}]`);
    }
  });

  // JOB_SETTLED：三种终态键共用一锚。
  for (const key of ['render.jobStatus.completed', 'render.jobStatus.failed', 'render.jobStatus.killed']) {
    for (const lang of LANGS) {
      assert.ok(MARKERS.JOB_SETTLED.test(t(lang, key)), `${lang} ${key} ↔ JOB_SETTLED`);
    }
  }

  // note.waitAgain：锚短语不含占位，无 vars 渲染即可。
  for (const lang of LANGS) {
    assert.ok(MARKERS.WAIT_AGAIN.test(t(lang, 'note.waitAgain')), `${lang} note.waitAgain ↔ WAIT_AGAIN`);
  }

  // note.yield.running：subject 取 subject.command 两语真值——锚句「命令仍在
  // running／was NOT terminated／没有被终止」都在插值后文本里。
  for (const lang of LANGS) {
    const text = t(lang, 'note.yield.running', {
      subject: t(lang, 'subject.command'), yieldMs: 20000, elapsedMs: 21000
    });
    assert.ok(MARKERS.YIELD_RUNNING.test(text), `${lang} note.yield.running ↔ YIELD_RUNNING`);
    assert.ok(MARKERS.NOT_TERMINATED.test(text), `${lang} note.yield.running ↔ NOT_TERMINATED（句尾半句）`);
  }

  // YIELD_EARLY_BY_USER：两键共享首句。
  for (const key of ['note.yield.earlyByUser', 'note.yield.userUnverified']) {
    for (const lang of LANGS) {
      assert.ok(MARKERS.YIELD_EARLY_BY_USER.test(t(lang, key, { elapsedMs: 800, subject: t(lang, 'subject.command') })),
        `${lang} ${key} ↔ YIELD_EARLY_BY_USER`);
    }
  }

  // render.workflowCompleted：en 单复数两形态＋zh 档，头两半各一锚。
  const workflowTexts = [
    t('en', 'render.workflowCompleted', { name: 'fast-run', count: 1, plural: '' }),
    t('en', 'render.workflowCompleted', { name: 'slow-run', count: 6, plural: 's' }),
    t('zh', 'render.workflowCompleted', { name: '快跑', count: 1, plural: '' })
  ];
  for (const text of workflowTexts) {
    assert.ok(MARKERS.WORKFLOW_COMPLETED.test(text), `render.workflowCompleted ↔ WORKFLOW_COMPLETED：${text.slice(0, 60)}`);
    assert.ok(MARKERS.WORKFLOW_RETURN.test(text), `render.workflowCompleted ↔ WORKFLOW_RETURN（返回值行）`);
  }

  // START_REFUSED：两键共含锚短语。
  for (const key of ['error.startRefused', 'error.startRefusedPlain']) {
    for (const lang of LANGS) {
      assert.ok(MARKERS.START_REFUSED.test(t(lang, key, {})), `${lang} ${key} ↔ START_REFUSED`);
    }
  }

  for (const lang of LANGS) {
    assert.ok(MARKERS.WORKFLOW_P2_PHRASE.test(t(lang, 'tool.workflow.p2', { defaultYieldMs: 20000 })),
      `${lang} tool.workflow.p2 ↔ WORKFLOW_P2_PHRASE`);
    assert.ok(MARKERS.WAIT_WOKE_BY_MESSAGE.test(t(lang, 'wait.wokeByMessage', { summary: '子代理的最终回答' })),
      `${lang} wait.wokeByMessage ↔ WAIT_WOKE_BY_MESSAGE`);
    assert.ok(MARKERS.LATE_ANSWER_ARRIVED.test(t(lang, 'wait.lateArrived', { summary: '问题 q1 的迟到作答：选项二' })),
      `${lang} wait.lateArrived ↔ LATE_ANSWER_ARRIVED（句首子句）`);
    assert.ok(MARKERS.LATE_ANSWER_SUMMARY.test(t(lang, 'ask.lateSummary', { qid: 'q1', answer: '选项二' })),
      `${lang} ask.lateSummary ↔ LATE_ANSWER_SUMMARY`);
    assert.ok(MARKERS.KILLED_BY_SIGNAL.test(t(lang, 'render.killedBySignal', { signal: 'SIGTERM' })),
      `${lang} render.killedBySignal ↔ KILLED_BY_SIGNAL（句干）`);
  }
});

// ── B 组：宿主渲染锚正反例 ────────────────────────────────────────────────────

test('B 组·JOB_LIST_RUNNING：真实不透明编号＋旧数字夹具为正例；自述／异类型／非 running／label 巧合为反例', () => {
  const opaqueLine = 'async-command-29bb2c6b2dff4ad9 [async-command] running — Start-Sleep -Milliseconds 1600; Write-Output R10_LONG_OK';
  const legacyLine = 'async-command-3 [async-command] running — sleep 60';
  for (const line of [opaqueLine, legacyLine]) {
    assert.ok(MARKERS.JOB_LIST_RUNNING.test(line), `正例（行本体）：${line.slice(0, 60)}`);
    // 多行工具结果文本中段命中（m 标志行首锚）。
    const embedded = `list follows:\n${line}\nnext section`;
    assert.ok(MARKERS.JOB_LIST_RUNNING.test(embedded), `正例（多行中段）：${line.slice(0, 40)}`);
  }

  // 反例 1：让出句柄文案缺类型括号（模型自述同类——放宽成裸状态词即红）。
  assert.ok(!MARKERS.JOB_LIST_RUNNING.test('命令仍在运行：async-command-29bb2c6b2dff4ad9（它没有被终止）'),
    '反例：句柄文案无 [async-command] 类型标识');
  // 反例 2：非 running 状态。
  assert.ok(!MARKERS.JOB_LIST_RUNNING.test('async-command-29bb2c6b2dff4ad9 [async-command] completed — Write-Output DONE'),
    '反例：completed 态');
  // 反例 3：异类型行。
  assert.ok(!MARKERS.JOB_LIST_RUNNING.test('async-workflow-1a2b3c4d5e6f7788 [async-workflow] running — demo'),
    '反例：async-workflow 类型');
  // 反例 4（假绿反例）：completed 行的 label 巧含目标子串——行首＋列分隔符双边界
  // 下不命中；锚放宽回无边界形态即红。
  assert.ok(!MARKERS.JOB_LIST_RUNNING.test('async-command-9f8e7d6c5b4a3210 [async-command] completed — echo x [async-command] running — y'),
    '反例：label 巧含目标子串的 completed 行');
});

test('B 组·HOST_JOB_NOTICE/HOST_JOB_FINISHED：宿主完成通知（恒英文）为正例；中文自述为反例', () => {
  // 宿主通知全文形态（dsh-tool-jobs formatter；编号不透明）。
  const notice = 'background job async-command-29bb2c6b2dff4ad9 (async-command: Start-Sleep -Seconds 55) finished [status: completed]. Read its output with job_output.';
  assert.ok(MARKERS.HOST_JOB_NOTICE.test(notice), '正例：background job <id> 结构');
  assert.ok(MARKERS.HOST_JOB_FINISHED.test(notice), '正例：finished 完成语');
  // 反例：模型自述的中文「已完成」文本——宿主通知恒英文，中文形态对宿主锚
  // 不命中（若实例里出现中文「完成」，它不是宿主通知）。
  const selfReport = '后台作业已完成，我用 job_list 看过了。';
  assert.ok(!MARKERS.HOST_JOB_NOTICE.test(selfReport), '反例：中文自述无宿主通知结构');
  assert.ok(!MARKERS.HOST_JOB_FINISHED.test(selfReport), '反例：中文自述无 finished 完成语');
});

// ── C 组：模块契约（导出键集与 A/B 组用例完全一致） ──────────────────────────

test('C 组·导出键集对账：A/B 组覆盖全部导出，无漏测锚、无幽灵导出', () => {
  const covered = [
    // A 组（词典锚 16）
    'WAIT_INTERRUPTED', 'SUBJECT_UNTOUCHED', 'CHILD_SETTLED', 'JOB_SETTLED', 'WAIT_AGAIN',
    'YIELD_RUNNING', 'NOT_TERMINATED', 'YIELD_EARLY_BY_USER', 'WORKFLOW_COMPLETED', 'WORKFLOW_RETURN',
    'START_REFUSED', 'WORKFLOW_P2_PHRASE', 'WAIT_WOKE_BY_MESSAGE', 'LATE_ANSWER_ARRIVED',
    'LATE_ANSWER_SUMMARY', 'KILLED_BY_SIGNAL',
    // B 组（宿主锚 3）
    'JOB_LIST_RUNNING', 'HOST_JOB_NOTICE', 'HOST_JOB_FINISHED'
  ];
  assert.deepEqual(Object.keys(MARKERS).sort(), covered.sort(),
    '模块导出与用例覆盖集不一致：新锚漏测即红，锚被误删即红');

  // anchorTiers 形状守卫（probe-r30 按 source.split('|') 拆档消费这两枚锚）：
  // source 必须恰拆两半、其中恰一半纯 ASCII——锚将来引入嵌套管道或两档同语
  // 时，这里的断言先红，而不是 r30 真机判据静默恒假（includes(undefined)）。
  for (const name of ['LATE_ANSWER_ARRIVED', 'LATE_ANSWER_SUMMARY']) {
    const halves = MARKERS[name].source.split('|');
    assert.equal(halves.length, 2, `${name} source 恰拆两半（无嵌套管道）`);
    assert.equal(halves.filter((half) => /^[\x20-\x7F]+$/.test(half)).length, 1,
      `${name} 两半中恰一半纯 ASCII（en/zh 分档前提）`);
  }
});
