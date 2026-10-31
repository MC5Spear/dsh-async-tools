/**
 * 输出渲染的单测（对应设计 §8 验证设计与需求 §5 设置生效）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelledNote, cancelledPreexistingNote, escapeLogValue, interruptedNote, settledNote, truncate, waitAgainNote, waitDigest, yieldDigest, yieldNote } from '../lib/output.js';
import { resolveConfig } from '../lib/config.js';

test('escapeLogValue（R29-f）：CR/LF/TAB 转成字面转义序列——操作者日志的单行防线', () => {
  assert.equal(escapeLogValue('line1\r\nline2\tend'), 'line1\\r\\nline2\\tend',
    '原始控制字符必须变成两个字符的字面序列（\\r 等），日志注入收成单行');
  assert.equal(escapeLogValue('clean'), 'clean', '干净文本原样');
  assert.equal(escapeLogValue(''), '', '空串原样');
  assert.equal(escapeLogValue(undefined), '', '非字符串不炸（容错性）');
  assert.equal(escapeLogValue(42), '42', '数字按 String 化——与 truncate 同款容错口径');
  assert.doesNotMatch(escapeLogValue('x\r\y\nz'), /[\r\n\t]/, '输出里不得残留任何原始控制字符');
});

test('truncate：未超限时原样返回', () => {
  const out = truncate('hello', 100);
  assert.equal(out.text, 'hello');
  assert.equal(out.truncated, false);
  assert.equal(out.omitted, 0);
});

test('truncate：超限时保留头尾并标注省略量', () => {
  const body = 'A'.repeat(500) + 'B'.repeat(500);
  const out = truncate(body, 100);
  assert.equal(out.truncated, true);
  assert.equal(out.omitted, 900);
  assert.match(out.text, /output truncated: 900 chars omitted/);
  assert.ok(out.text.startsWith('A'), '应保留头部');
  assert.ok(out.text.endsWith('B'), '应保留尾部');
});

test('truncate：容忍非字符串与空值', () => {
  assert.equal(truncate(undefined, 10).text, '');
  assert.equal(truncate(null, 10).text, '');
  assert.equal(truncate(42, 10).text, '42');
});

test('truncate：按**字符**计数（maxResultChars 以模型可见的字符数为口径），不是字节', () => {
  const text = '中'.repeat(60);   // 60 字符，UTF-8 下是 180 字节
  const out = truncate(text, 50);
  assert.equal(out.truncated, true);
  assert.equal(out.omitted, 10, '按字节算这里会是 130；maxResultChars 的口径是模型可见的字符数');
});

test('yieldNote（R1 硬性需求）：必须带 job_id、可复制的调用示例和生效上限', () => {
  const note = yieldNote({ jobId: 'async-command-7', yieldMs: 20000, maxWaitMs: 600000, elapsedMs: 20012 });
  assert.match(note, /async-command-7/, '必须含 job_id');
  assert.match(note, /async_wait\(targets=\[\{kind:"job", id:"async-command-7"\}\], wait_ms=30000\)/, '必须含可照抄的调用示例');
  assert.match(note, /20000 ms/, '必须写出实际生效的首次等待');
  assert.match(note, /600000 ms/, '必须写出实际生效的等待上限');
  assert.match(note, /It was NOT terminated/, '必须说明命令没有被杀死');
});

test('yieldNote：示例里的 `wait_ms` 必须取**生效配置的默认值**，不能写死', () => {
  // ## 这条判据挡什么
  //
  // `yieldNote` 若把示例硬编码成 `wait_ms=30000`，它**凑巧等于**插件的默认
  // `defaultWaitMs`（30 s），断言照样绿。但那是**巧合，不是保证**：
  // 使用者把 `defaultWaitMs` 改成 7000 之后，工具给出的"可复制粘贴示例"仍然写着 30000，
  // **示例与设置互相打架**，而模型会照抄示例（需求 §2.1.3 明确要求给可执行指令）。
  //
  // ## 为什么传一个**特征值**而不是用默认
  //
  // 上面那条用的是不传 `defaultWaitMs` 的默认路径，示例写 30000 是"对的"——
  // 于是它**无法区分**"取配置"与"写死"。这里传 `7000`：
  // 只有真的从参数取值才会出现 7000；写死的实现在这里必然红。
  const note = yieldNote({
    jobId: 'async-command-9', yieldMs: 1500, maxWaitMs: 600000, defaultWaitMs: 7000, elapsedMs: 1600
  });
  assert.match(note, /async_wait\(targets=\[\{kind:"job", id:"async-command-9"\}\], wait_ms=7000\)/,
    '示例必须用生效的 defaultWaitMs（7000），不能写死成插件的默认 30000');
  assert.doesNotMatch(note, /wait_ms=30000/,
    '不得残留写死的 30000——示例与设置打架时，模型会照抄示例');
});

test('yieldNote（R32-c-b）：插话提前让出 → 注明用户到达且命令不受影响，不再说"超出预算"', () => {
  const base = { jobId: 'async-command-7', yieldMs: 20000, maxWaitMs: 600000, defaultWaitMs: 7000, elapsedMs: 4321 };
  const note = yieldNote({ ...base, mode: 'user' });
  assert.match(note, /ended early: a user message arrived/, '开宗明义注明因用户到达提前让出');
  assert.match(note, /4321/, '带上已运行时长');
  assert.match(note, /itself is unaffected/, '必须说明命令本身不受影响');
  assert.doesNotMatch(note, /outlived the .* first wait/, '提前结束不是等待到期——开头不得再出现"超出首次等待"句');
  assert.match(note, /async_wait\(targets=\[\{kind:"job", id:"async-command-7"\}\], wait_ms=7000\)/, '恢复示例照带（取生效默认值）');
});

test('yieldNote（9.3.1 收紧）：迟到作答不再是让出原因——mode 只有 user/cancelled/budget 三档', () => {
  const base = { jobId: 'async-command-8', yieldMs: 20000, maxWaitMs: 600000, elapsedMs: 1000 };
  // 收紧后的缺省档（budget）：作答不进 note（留在收件箱按宿主节奏领取——
  // 首次等待只被作业终态/user 插话/取消/预算结束）。
  const note = yieldNote({ ...base });
  assert.match(note, /outlived the 20000 ms first wait/, '预算到期口径');
  assert.doesNotMatch(note, /late answer|A late answer/i, '迟到作答不再有让出档（wait 工具的 lateArrived 键仍归 wait 使用）');
  assert.match(note, /async_wait\(targets=\[\{kind:"job", id:"async-command-8"\}\]/, '后台句柄示例照带');
});

test('waitAgainNote：说明作业未受影响且可再次等待', () => {
  const note = waitAgainNote({ jobId: 'j-1', waitedMs: 30000, maxWaitMs: 600000 });
  assert.match(note, /j-1/);
  assert.match(note, /is still running \(unaffected\)/);
  assert.match(note, /600000 ms/);
});

test('interruptedNote（R4 硬性需求）：必须说明结束等待没有终止后台工作（行为陈述，不作运行断言）', () => {
  const note = interruptedNote({ subject: 'job j-1', waitedMs: 812, resume: 'async_wait(targets=[{kind:"job", id:"j-1"}], wait_ms=...)' });
  assert.match(note, /Wait interrupted: a user message has arrived/);
  assert.match(note, /812 ms/);
  assert.match(note, /Ending the wait did not stop job j-1/);
  assert.match(note, /async_wait\(targets=/);
});

test('cancelledNote/cancelledPreexistingNote（设计 §2.5 取消口径）：取消与消息到达分开，行为陈述不作运行断言', () => {
  const note = cancelledNote({ subject: 'job j-1', waitedMs: 300, resume: 'async_wait(targets=[{kind:"job", id:"j-1"}], wait_ms=...)' });
  assert.match(note, /The wait was cancelled after 300 ms/);
  assert.match(note, /cancellation did not stop job j-1/, '取消≠停止工作（本次原因＋后台状态，一遍即可）');
  assert.doesNotMatch(note, /still running/, '取消出口不做状态复查，不得写运行断言');
  assert.doesNotMatch(note, /user message/, '取消不是消息到达，不用 interrupted 口径');

  const pre = cancelledPreexistingNote({ subject: 'subagent child-9', resume: 'async_wait(targets=[{kind:"agent", id:"child-9"}], wait_ms=...)' });
  assert.match(pre, /cancelled before the wait began/);
  assert.match(pre, /did not stop subagent child-9/);
  assert.match(pre, /async_wait\(targets=/);
});

test('yieldNote（设计 §2.5 证据分级）：复查快照缺席 → 未证实档，不作"仍在运行"断言', () => {
  const budget = yieldNote({
    jobId: 'j-1', yieldMs: 20000, maxWaitMs: 600000, defaultWaitMs: 30000,
    elapsedMs: 20100, mode: 'budget', unverified: true
  });
  assert.match(budget, /outlived the 20000 ms first wait/);
  assert.match(budget, /could not confirm its current state/);
  assert.doesNotMatch(budget, /command is still running/, '无当次快照支撑不写运行断言（"instead of assuming it is still running" 的否定指引不算断言）');
  assert.match(budget, /async_wait\(targets=/, '句柄与复查出路保留');

  const user = yieldNote({
    jobId: 'j-1', yieldMs: 20000, maxWaitMs: 600000, defaultWaitMs: 30000,
    elapsedMs: 500, mode: 'user', unverified: true
  });
  assert.match(user, /a user message arrived/);
  assert.match(user, /ending the wait did not stop the command/, '行为陈述保留（句中小写形态）');
  assert.doesNotMatch(user, /background task keeps running/);

  const cancelled = yieldNote({
    jobId: 'j-1', yieldMs: 20000, maxWaitMs: 600000, defaultWaitMs: 30000,
    elapsedMs: 500, mode: 'cancelled', unverified: true
  });
  assert.match(cancelled, /was cancelled/);
  assert.match(cancelled, /could not confirm the command's current state/, '取消说明后补未证实行');

  // 有快照（unverified 缺省）时保留现行句柄口径（运行断言有非终态快照支撑）。
  const verified = yieldNote({
    jobId: 'j-1', yieldMs: 20000, maxWaitMs: 600000, defaultWaitMs: 30000,
    elapsedMs: 20100, mode: 'budget'
  });
  assert.match(verified, /The command is still running/);
});

test('yieldNote（设计 §2.5 称谓分档）：kind=workflow → 主体称谓为 workflow／工作流，不冒称 command／命令', () => {
  const en = yieldNote({
    jobId: 'wf-1', yieldMs: 20, maxWaitMs: 600000, defaultWaitMs: 30000,
    elapsedMs: 25, mode: 'budget', kind: 'workflow'
  });
  assert.match(en, /The workflow is still running/);
  assert.doesNotMatch(en, /\bcommand\b/, '编排不冒称 command');

  const zh = yieldNote({
    lang: 'zh', jobId: 'wf-1', yieldMs: 20, maxWaitMs: 600000, defaultWaitMs: 30000,
    elapsedMs: 25, mode: 'budget', kind: 'workflow'
  });
  assert.match(zh, /工作流仍在运行/);
  assert.doesNotMatch(zh, /命令/, 'zh 档同样不冒称命令');

  // 缺省 kind 是命令路径（async_run），称谓不漂移。
  const cmd = yieldNote({
    jobId: 'j-1', yieldMs: 20, maxWaitMs: 600000, defaultWaitMs: 30000,
    elapsedMs: 25, mode: 'budget'
  });
  assert.match(cmd, /The command is still running/);

  const zhCmd = yieldNote({
    lang: 'zh', jobId: 'j-1', yieldMs: 20, maxWaitMs: 600000, defaultWaitMs: 30000,
    elapsedMs: 25, mode: 'budget'
  });
  assert.match(zhCmd, /命令仍在运行/);

  // 未证实档同分档：workflow 的未证实变体不再提 command。
  const unverifiedWf = yieldNote({
    jobId: 'wf-1', yieldMs: 20, maxWaitMs: 600000, defaultWaitMs: 30000,
    elapsedMs: 25, mode: 'budget', unverified: true, kind: 'workflow'
  });
  assert.match(unverifiedWf, /The workflow outlived/);
  assert.doesNotMatch(unverifiedWf, /\bcommand\b/);
});

test('settledNote：必须说明最终回答不在返回值里（设计 §6.3）', () => {
  const note = settledNote({ agentId: 'child-9' });
  assert.match(note, /child-9/);
  assert.match(note, /will arrive as a separate message in the conversation; it is not part of this return value/);
});

test('yieldDigest 只谈让出；waitDigest 只谈等待（两个预算分开说明）', () => {
  const c = resolveConfig({ toolName: 'async_run', defaultYieldMs: 15000, minYieldMs: 1000, maxYieldMs: 600000, minWaitMs: 250, maxWaitMs: 120000 });

  const yieldText = yieldDigest(c);
  assert.match(yieldText, /15000 ms/, '首次等待必须来自生效配置');
  assert.match(yieldText, /yield_ms/, 'yield_ms 是 async_run 的参数，必须说');
  // 「转后台＋返回作业编号」的完整故事由 tool.run.p2 表达（见 jobs.test.mjs 对
  // 整段描述的 /job id \(job_id\)/ 断言）；digest 只带数字口径，不重复第二遍。
  // 反向：让出段里不该混进等待范围，否则两个指标又粘在一起了。
  assert.doesNotMatch(yieldText, /wait budgets/i, '首次等待段不该谈等待预算');

  const waitText = waitDigest(c);
  assert.match(waitText, /250–120000 ms/, '等待范围必须来自生效配置');
  // 这两条是拆分的核心：非 async_run 的工具不许收到 yield 相关文案。
  assert.doesNotMatch(waitText, /yield_ms/, '等待段绝不能出现 yield_ms');
  assert.doesNotMatch(waitText, /first wait|first-wait|moves to the background/, '等待段绝不能出现首次等待/转后台的措辞');
});
