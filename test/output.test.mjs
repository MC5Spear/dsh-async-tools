/**
 * 输出渲染的单测（对应 `docs/design.md` §8，需求 R1/R5/R8）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeLogValue, interruptedNote, settledNote, truncate, waitAgainNote, waitDigest, yieldDigest, yieldNote } from '../lib/output.js';
import { resolveConfig } from '../lib/config.js';

test('escapeLogValue（R29-f）：CR/LF/TAB 转成字面转义序列——操作者日志的单行防线', () => {
  assert.equal(escapeLogValue('line1\r\nline2\tend'), 'line1\\r\\nline2\\tend',
    '原始控制字符必须变成两个字符的字面序列（\\r 等），日志注入面收成单行');
  assert.equal(escapeLogValue('clean'), 'clean', '干净文本原样');
  assert.equal(escapeLogValue(''), '', '空串原样');
  assert.equal(escapeLogValue(undefined), '', '非字符串不炸（容错面）');
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

test('truncate：按**字符**计数（修正清单 §3 的裁决），不是字节', () => {
  const text = '中'.repeat(60);   // 60 字符，UTF-8 下是 180 字节
  const out = truncate(text, 50);
  assert.equal(out.truncated, true);
  assert.equal(out.omitted, 10, '按字节算这里会是 130；maxResultChars 的口径是模型可见的字符数');
});

test('yieldNote（R1 硬需求）：必须带 job_id、可复制的调用示例和生效上限', () => {
  const note = yieldNote({ jobId: 'async-command-7', yieldMs: 20000, maxWaitMs: 600000, elapsedMs: 20012 });
  assert.match(note, /async-command-7/, '必须含 job_id');
  assert.match(note, /async_wait_job\(job_id="async-command-7", wait_ms=30000\)/, '必须含可照抄的调用示例');
  assert.match(note, /20000 ms/, '必须写出实际生效的让出预算');
  assert.match(note, /600000 ms/, '必须写出实际生效的等待上限（补此前的缺口）');
  assert.match(note, /It was NOT terminated; it keeps running in the background/, '必须说明命令没有被杀死');
});

test('yieldNote：示例里的 `wait_ms` 必须取**生效配置的默认值**，不能写死', () => {
  // ## 这条判据挡什么
  //
  // `yieldNote` 原来把示例硬编码成 `wait_ms=30000`——它**凑巧等于**插件的默认
  // `defaultWaitMs`（30 s），所以上面那条断言一直绿。但那是**巧合，不是保证**：
  // 使用者把 `defaultWaitMs` 改成 7000 之后，工具给出的"可复制粘贴示例"仍然写着 30000，
  // **示例与设置互相打架**，而模型会照抄示例（R1 明确要求给可执行指令）。
  //
  // ## 为什么传一个**特征值**而不是用默认
  //
  // 上面那条用的是不传 `defaultWaitMs` 的默认路径，示例写 30000 是"对的"——
  // 于是它**无法区分**"取配置"与"写死"。这里传 `7000`：
  // 只有真的从参数取值才会出现 7000；写死的实现在这里必然红。
  const note = yieldNote({
    jobId: 'async-command-9', yieldMs: 1500, maxWaitMs: 600000, defaultWaitMs: 7000, elapsedMs: 1600
  });
  assert.match(note, /async_wait_job\(job_id="async-command-9", wait_ms=7000\)/,
    '示例必须用生效的 defaultWaitMs（7000），不能写死成插件的默认 30000');
  assert.doesNotMatch(note, /wait_ms=30000/,
    '不得残留写死的 30000——示例与设置打架时，模型会照抄示例');
});

test('yieldNote（R32-c-b）：插话提前让出 → 注明用户到达且命令不受影响，不再说"超出预算"', () => {
  const base = { jobId: 'async-command-7', yieldMs: 20000, maxWaitMs: 600000, defaultWaitMs: 7000, elapsedMs: 4321 };
  const note = yieldNote({ ...base, mode: 'user' });
  assert.match(note, /ended early: a user message arrived/, '开宗明义注明因用户到达提前让出');
  assert.match(note, /4321/, '带上已运行时长');
  assert.match(note, /unaffected and keeps running in the background/, '必须说明命令本身不受影响');
  assert.doesNotMatch(note, /outlived the .* yield budget/, '提前让出不是预算到期——开头不得再出现"超出预算"句');
  assert.match(note, /async_wait_job\(job_id="async-command-7", wait_ms=7000\)/, '恢复示例照带（取生效默认值）');
});

test('yieldNote（R32-c-d）：迟到作答 → 与 wait 工具同键的 lateArrived 开头 + 句柄示例', () => {
  const base = { jobId: 'async-command-8', yieldMs: 20000, maxWaitMs: 600000, elapsedMs: 1000 };
  const note = yieldNote({ ...base, mode: 'late', summary: 'Pick a fruit' });
  assert.match(note, /A late answer has arrived \(Pick a fruit\)/, 'lateArrived 键与 wait 工具同口径');
  assert.match(note, /async_wait_job\(job_id="async-command-8"/, '后台句柄示例照带');
});

test('waitAgainNote：说明作业未受影响且可再次等待', () => {
  const note = waitAgainNote({ jobId: 'j-1', waitedMs: 30000, maxWaitMs: 600000 });
  assert.match(note, /j-1/);
  assert.match(note, /is still running \(unaffected\)/);
  assert.match(note, /600000 ms/);
});

test('interruptedNote（R4 硬需求）：必须说明后台工作没有受影响', () => {
  const note = interruptedNote({ subject: 'job j-1', waitedMs: 812, resume: 'async_wait_job(job_id="j-1", wait_ms=...)' });
  assert.match(note, /Wait interrupted: a user message has arrived/);
  assert.match(note, /812 ms/);
  assert.match(note, /is still running in the background and is completely unaffected/);
  assert.match(note, /async_wait_job/);
});

test('settledNote：必须说明最终回答不在返回值里（设计 §6.3）', () => {
  const note = settledNote({ agentId: 'child-9' });
  assert.match(note, /child-9/);
  assert.match(note, /will arrive as a separate message in the conversation; it is not part of this return value/);
});

test('yieldDigest 只谈让出；waitDigest 只谈等待（R4 审查 #1 的拆分）', () => {
  const c = resolveConfig({ toolName: 'async_run', defaultYieldMs: 15000, minYieldMs: 1000, maxYieldMs: 600000, minWaitMs: 250, maxWaitMs: 120000 });

  const yieldText = yieldDigest(c);
  assert.match(yieldText, /15000 ms/, '让出预算必须来自生效配置');
  assert.match(yieldText, /yield_ms/, 'yield_ms 是 async_run 的参数，必须说');
  assert.match(yieldText, /it moves to the background and returns a job_id/, '"转后台"只属于 async_run');
  // 反向：让出段里不该混进等待范围，否则两个指标又粘在一起了。
  assert.doesNotMatch(yieldText, /Wait budgets/, '让出段不该谈等待预算');

  const waitText = waitDigest(c);
  assert.match(waitText, /250–120000 ms/, '等待范围必须来自生效配置');
  // 这两条是拆分的核心：非 async_run 的工具不许收到 yield 相关文案。
  assert.doesNotMatch(waitText, /yield_ms/, '等待段绝不能出现 yield_ms');
  assert.doesNotMatch(waitText, /yield budget|moves to the background/, '等待段绝不能出现让出/转后台的措辞');
});
