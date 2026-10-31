/**
 * 静默失败防护三防线单测（需求 §6.3 可选静默失败防护）。
 *
 * ## 这条需求修的是什么
 *
 * 受限沙箱里外部 EXE 被捕获形态（`2>&1` / `$(...)` / 变量赋值 / `>`）包装后死在
 * **进程创建层**——零输出、零 `[exit code]` 标记；单次提权的拒绝标记只覆盖
 * "看得见的拒绝"，这一类**看不见的死亡**没有其他防线。三道防线（a 结果侧
 * 自诊断 / b 描述侧警示段 / c 常驻纪律段）全部由同一个 volatile 布尔
 * `silentFailureGuard` 控制，默认关——关掉后三处都以**行为差异**消失。
 *
 * ## 判据 → 各挡什么（判据 14 = 全量无回归：`npm test` 全量跑）
 *
 * | 判据 | 挡的缺陷形态 |
 * |---|---|
 * | 1 捕获形四模式 + 管道一票否决 | 把管道也当捕获形 ⇒ cmdlet 管道大量误触发（可失败 ①） |
 * | 2 签名 1 四条件缺一即无 + 裸调用对照 | 半截条件 ⇒ 出路（裸调用重试）自己都触发提醒 |
 * | 3 空白算空 | `  \n  ` 被当成"有输出" ⇒ 签名 1 失明 |
 * | 4 cmdlet 误发接受 + 条件式措辞 | 文案直陈失败 ⇒ 裁定接受的误发情形变成谎报（可失败 ②） |
 * | 5 提权跑不产出 | 提权重试完还提醒 ⇒ 提示变成噪声 |
 * | 6 签名 2 锚对矩阵 | 单锚/大小写漂移 ⇒ 拒签名该出不出、不该出乱出 |
 * | 7 非空且无锚双断 | 输出正常还提醒 ⇒ 纯噪声 |
 * | 8 开关关三防线同断 | 关不干净 ⇒ "默认关"裁定被架空（可失败 ③） |
 * | 9 前台出口：note 尾部 + 无值不写键 | note 拼错位置/写 `note: ''` ⇒ 模型看不见或被键污染 |
 * | 10 后台出口：detail 尾部 + 结算时刻读开关 | 注册时刻快照开关 ⇒ 后台作业吃不到翻转 |
 * | 11 b 段矩阵 + 就地增删 | 无执行器也拼/关不掉 ⇒ 走不通的指引或噪声（可失败 ⑥） |
 * | 12 c 段注册形状 + 快照缺席失效安全 | 注入常真/快照缺席抛错 ⇒ 默认关裁定被架空（可失败 ⑦） |
 * | 13 设置范围：FIELDS 四组全部字段 + spec/归一矩阵 | 字段漂移/垃圾值不收敛 ⇒ 界面与配置链断档（可失败 ⑤） |
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostTestFor, loadOfflineSafe } from './_host-gate.mjs';
import { BUDGET_FIELD_KEYS, LANG_FIELD_KEYS, FLAG_FIELD_KEYS, DISPLAY_FIELD_KEYS, ASK_FIELD_KEYS, resolveConfig } from '../lib/config.js';
import { DENIAL_ANCHOR_PAIRS, hasCaptureForm, hasDenialAnchors, silentFailureNotes } from '../lib/silent-failure.js';
import { resetGuardOwnershipEvidence } from '../lib/descriptions.js';
import { t } from '../lib/text.js';
import { seedSnapshot, clearSnapshot } from '../lib/settings.js';
import { checkedTool, fakeAgent, fakeCtx, fakeProc } from './_helpers.mjs';
import { makePrimitivesDouble } from './_primitives-double.mjs';

// 宿主链动态守卫（用例级）：判据 8–12 与 F3 需要 lib/jobs.js（→ dsh-tools/
// ask-takeover）、lib/host.js、lib/index.js——离线形态缺席时这些用例自跳过并
// 打印理由；判据 1–7 与 13 只用纯文本判据与 client.js 装载，离线照常跑。
const jobsModule = await loadOfflineSafe('../lib/jobs.js');
const hostHalf = await loadOfflineSafe('../lib/host.js');
const hostIndex = await loadOfflineSafe('../lib/index.js');
const { createRunTool: buildRunTool } = jobsModule ?? {};
const { applyHostHalf } = hostHalf ?? {};
const { refreshToolDescriptions } = hostIndex ?? {};
const hostTest = await hostTestFor('../lib/jobs.js', '../lib/host.js', '../lib/index.js');

const createRunTool = (ctx, config) => checkedTool(buildRunTool(ctx, config));
const exec = { agent: fakeAgent(), callId: 'call_R28_1', signal: new AbortController().signal };
/** 纯模块判定用的最小收集器：只承 `text()`。 */
const collector = (text) => ({ text: () => text });

/**
 * 造一个"约束执行器"上下文（照 `escalation.test.mjs` 的 confinedCtx 收窄）：
 * `sandboxMode` 必须在**创建工具之前**设好（参数表在构造期读一次）。
 */
function confinedCtx(presetOf = 'dsh-async') {
  const f = fakeCtx();
  f.installShellExecute(() => Promise.resolve(fakeProc({ text: 'ok' }).proc));
  f.ctx.shell.sandboxMode = 'workspace-write';
  // lib/jobs.js 的 execute 走 ctx.get('sandboxPolicy') 取放行策略（escalation.test.mjs:52
  // 同款桩）：缺了会得到 `TypeError: ctx.get is not a function`，断言本体根本执行不到。
  // F3 范围判定（设计 §6.2（机制）／需求 §6.3（范围））：结果诊断只对归属本包预设的调用主体生效——
  // 桩按 inOwnPreset 的读取路径（sessions.get → sessionProjections.stateOf('agentPreset')）
  // 把调用主体映射到指定预设（默认 dsh-async；范围负面对照传别的）。
  f.ctx.get = (key) => {
    if (key === 'sandboxPolicy') {
      return { resolve: () => ({ mode: 'workspace-write' }) };
    }
    if (key === 'sessions') {
      return { get: (id) => ({ id }) };
    }
    return undefined;
  };
  f.ctx.sessionProjections = { stateOf: () => presetOf };
  return f;
}

test('R28 判据1：捕获形四模式任一命中，管道一票否决，多语句整体判', () => {
  // 四模式（启发式，命令文本无管道时的命中范围）。
  assert.equal(hasCaptureForm('node x.mjs 2>&1'), true, '2>&1');
  assert.equal(hasCaptureForm('echo $(git rev-parse HEAD)'), true, '$(...) 子表达式捕获');
  assert.equal(hasCaptureForm('$out = npm ls --depth=0'), true, '语句首变量赋值捕获');
  assert.equal(hasCaptureForm('$x=1'), true, '无空格赋值也是赋值');
  assert.equal(hasCaptureForm('node x.mjs > out.txt'), true, '> 重定向');
  assert.equal(hasCaptureForm('node x.mjs >> log.txt'), true, '>> 重定向（一枚 > 覆盖）');
  // 管道一票否决——管道死法可见，且 cmdlet 管道会大量误触发（可失败 ① 的正面）。
  assert.equal(hasCaptureForm('dir | Select-String foo'), false, '纯管道不命中');
  assert.equal(hasCaptureForm('node x.mjs 2>&1 | Out-String'), false, '有 2>&1 但含管道 ⇒ 否决');
  assert.equal(hasCaptureForm('dir 2>&1 | Measure-Object'), false, 'cmdlet 管道 + 2>&1 ⇒ 否决');
  // 多语句整体判：任一语句命中即算（需求口径）。
  assert.equal(hasCaptureForm('echo hi; node x.mjs > out'), true, '多语句任一命中');
  // 非命中情形：`if ($x -eq 1)` 不是赋值；`--flag=1` 不是赋值。
  assert.equal(hasCaptureForm('Get-ChildItem'), false);
  assert.equal(hasCaptureForm('if ($x -eq 1) { echo hi }'), false, '比较符不误中赋值锚');
  assert.equal(hasCaptureForm('npm run x -- --flag=1'), false, '参数内等号不误中');
});

test('R28 判据2：签名 1 四条件逐一缺失即无产出；裸调用对照不产出', () => {
  const hit = {
    proc: { sandbox: { mode: 'workspace-write' } },
    collector: collector(''),
    command: 'node x.mjs 2>&1',
    escalated: false,
    escalationModes: ['workspace-write', 'danger-full-access'],
    guard: true,
    lang: 'en'
  };
  assert.equal(silentFailureNotes(hit).length, 1, '四条件齐 ⇒ 命中');
  // 逐一缺一（其余保持命中姿态）。
  assert.deepEqual(silentFailureNotes({ ...hit, command: 'node x.mjs' }), [],
    '缺捕获形 ⇒ 不产出');
  assert.deepEqual(silentFailureNotes({ ...hit, collector: collector('real output') }), [],
    '输出非空 ⇒ 不产出');
  assert.deepEqual(silentFailureNotes({ ...hit, proc: {} }), [],
    '未以受限模式跑过（无 sandbox 盖章）⇒ 不产出');
  assert.deepEqual(silentFailureNotes({ ...hit, proc: { sandbox: { mode: 'workspace-write', denied: true } } }), [],
    'denied 结算归 R11 语境 ⇒ 不产出');
  assert.deepEqual(silentFailureNotes({ ...hit, escalated: true }), [],
    '提权跑的死法归提权语境（判据 5 同断）⇒ 不产出');
  assert.deepEqual(silentFailureNotes({ ...hit, escalationModes: [] }), [],
    '无约束执行器的部署 ⇒ 不产出');
  // 裸调用对照：出路本身（裸调用重试）不得触发提醒。
  assert.deepEqual(silentFailureNotes({ ...hit, command: 'node x.mjs', collector: collector('ok') }), [],
    '裸调用重试拿到输出 ⇒ 不产出');
});

test('R28 判据3：纯空白结算算"空"（设计钉死口径）', () => {
  const base = {
    proc: { sandbox: { mode: 'workspace-write' } },
    command: 'node x.mjs > out.txt',
    escalationModes: ['workspace-write', 'danger-full-access'],
    guard: true,
    lang: 'en'
  };
  assert.equal(silentFailureNotes({ ...base, collector: collector('') }).length, 1, '空串算空');
  assert.equal(silentFailureNotes({ ...base, collector: collector('  \n  ') }).length, 1,
    '纯空白（空格+换行）也算空——只有真实输出正文才算非空');
});

test('R28 判据4：cmdlet 误报范围被接受，且文案必须是条件式（可失败 ②）', () => {
  // 用户裁定：纯 cmdlet（空目录 Get-ChildItem 2>&1）命中条件式提醒**接受**。
  const notes = silentFailureNotes({
    proc: { sandbox: { mode: 'workspace-write' } },
    collector: collector(''),
    command: 'Get-ChildItem 2>&1',
    escalationModes: ['workspace-write'],
    guard: true,
    lang: 'en'
  });
  assert.equal(notes.length, 1, '裁定接受的误发范围要有用例钉住');
  // 条件式措辞锚：不断言失败，正向替代（裸调用重试 / sandbox_permissions）必须在场。
  assert.match(notes[0], /If the output you expected is missing/, '条件式开头（"若"）——直陈式必红');
  assert.match(notes[0], /may have been killed at process creation/, '推测语气，不是断言');
  assert.match(notes[0], /treat it as "did not run"/, '解读口径：按「没跑」处理');
  assert.match(notes[0], /Retry it once as a bare call/, '正向替代 1：裸调用重试');
  assert.match(notes[0], /sandbox_permissions/, '正向替代 2：提权重试（本组合声明了提权字段）');
  const zh = silentFailureNotes({
    proc: { sandbox: { mode: 'workspace-write' } }, collector: collector(''),
    command: 'Get-ChildItem 2>&1', escalationModes: ['workspace-write'], guard: true, lang: 'zh'
  });
  assert.match(zh[0], /若你预期的输出缺失/, 'zh 条件式开头');
  assert.match(zh[0], /可能在进程创建层被杀/, 'zh 推测语气');
  assert.match(zh[0], /裸调用重试一次/, 'zh 正向替代 1');
  assert.match(zh[0], /sandbox_permissions/, 'zh 正向替代 2');
});

test('R28 判据5：获批提权跑完的死法归提权语境，签名 1 不产出', () => {
  // 其余三条件全保持命中姿态，只把 escalated 翻 true。
  const notes = silentFailureNotes({
    proc: { sandbox: { mode: 'workspace-write' } },
    collector: collector(''),
    command: 'node x.mjs 2>&1',
    escalated: true,
    escalationModes: ['workspace-write', 'danger-full-access'],
    guard: true,
    lang: 'en'
  });
  assert.deepEqual(notes, [], '提权是本签名给出的出路——提权跑完再提醒等于噪声');
});

test('R28 判据6：签名 2 锚对矩阵——同对两枚都在场才命中，大小写敏感', () => {
  // 锚对常量本身（实测原文 + 一条待核验实测记录的 ZH 镜像）：漂移即红。
  assert.deepEqual(DENIAL_ANCHOR_PAIRS, [['failed to run', 'Access is denied'], ['无法运行', '拒绝访问']],
    '锚对是判定常量，改动必须有意识地过这里');
  assert.equal(hasDenialAnchors('node: failed to run: Access is denied'), true, 'EN 对两枚齐 ⇒ 命中');
  assert.equal(hasDenialAnchors('程序"node.x.exe"无法运行: 拒绝访问'), true, 'ZH 对两枚齐 ⇒ 命中');
  assert.equal(hasDenialAnchors('failed to run'), false, '单锚不触发（EN）');
  assert.equal(hasDenialAnchors('Access is denied'), false, '单锚不触发（EN 第二枚）');
  assert.equal(hasDenialAnchors('无法运行'), false, '单锚不触发（ZH）');
  assert.equal(hasDenialAnchors('Failed To Run — Access is denied'), false, '大小写敏感：改大小写不算命中');
  assert.equal(hasDenialAnchors(''), false, '空输出无锚');
  // 签名 2 只有开关 + 锚对两道关卡：不设捕获形/空白/受限/执行器的关卡（需求"附加提示"口径）。
  const notes = silentFailureNotes({
    proc: {}, collector: collector('failed to run: Access is denied'),
    command: 'anything', escalationModes: [], guard: true, lang: 'en'
  });
  assert.equal(notes.length, 1, '无沙箱盖章、无执行器、输出非空——锚对在仍出直陈式');
  assert.match(notes[0], /visible denial signature/, '直陈式：说明这是可见拒绝签名');
  assert.match(notes[0], /once as a bare call/, '出路 1');
  assert.match(notes[0], /sandbox_permissions/, '出路 2');
});

test('R28 判据7：输出非空且无锚 ⇒ 两条签名都不产出', () => {
  const notes = silentFailureNotes({
    proc: { sandbox: { mode: 'workspace-write' } },
    collector: collector('real output, healthy run'),
    command: 'node x.mjs 2>&1',
    escalated: false,
    escalationModes: ['workspace-write', 'danger-full-access'],
    guard: true,
    lang: 'en'
  });
  assert.deepEqual(notes, [], '健康结算是纯噪声禁区');
});

hostTest('R28 判据8：开关关 ⇒ 三防线同断（行为差异，不是存在性；可失败 ③）', () => {
  // a：纯模块——两条签名的输入全部保持命中姿态，只关开关。
  const armed = {
    proc: { sandbox: { mode: 'workspace-write' } },
    collector: collector('failed to run: Access is denied'),
    command: 'node x.mjs 2>&1',
    escalationModes: ['workspace-write'],
    lang: 'en'
  };
  assert.deepEqual(silentFailureNotes({ ...armed, guard: false }), [], 'guard=false ⇒ 签名 2 不产出');
  assert.deepEqual(silentFailureNotes({ ...armed, guard: undefined, collector: collector('') }), [],
    'guard 缺席 ⇒ 签名 1 不产出（失效安全方向 = 关）');
  // b：描述侧警示段消失。
  const conf = confinedCtx();
  const tool = createRunTool(conf.ctx, resolveConfig({ toolName: 'async_run', silentFailureGuard: false, owningPreset: 'dsh-async' }));
  assert.doesNotMatch(tool.description, /die silently at process creation/, '关 ⇒ b 段不拼');
  // c：纪律段组稿为空串（快照现读，段本体不注销）。c 段只等 systemPrompt，
  // 预设过滤两服务经 ctx.get 现读（sessions 缺席同样是关，判据 12 已锁）。
  const snapHost = fakeCtx();
  const injectFns = new Map();
  snapHost.ctx.inject = (list, fn) => { injectFns.set(list.join(','), fn); };
  snapHost.ctx.effect = () => {};
  snapHost.ctx.get = (key) => (key === 'sessions' ? { get: () => ({ id: 'session-1' }) }
    : key === 'sessionProjections' ? { stateOf: () => 'dsh-async' } : undefined);
  applyHostHalf(snapHost.ctx, resolveConfig({ silentFailureGuard: false }));
  const captured = {};
  // 执行纪律 section 与 c 段同一回调注册（此处只验 c 段开为空；section 不受
  // 开关控制，其行为矩阵见专条用例）——探测桩必须同时提供 section。
  injectFns.get('systemPrompt')({
    systemPrompt: {
      context: (entry) => { Object.assign(captured, entry); },
      section: () => {}
    }
  });
  assert.equal(captured.text({ agent: { id: 'session-1' } }), '', '关 ⇒ c 段文本为空串（渲染层过滤）');
  clearSnapshot();
});

hostTest('R28 判据9：前台出口——note 拼在标记之后且居尾；无值不写 note 键', async () => {
  const conf = confinedCtx();
  // 工具行的归属声明值与 confinedCtx 的会话预设（dsh-async）全等——结果诊断
  // 的运行时归属判定（设计 §6.2）通过。
  const config = resolveConfig({ toolName: 'async_run', silentFailureGuard: true, owningPreset: 'dsh-async' });
  // 拒绝结算（真实形态）：提权拒绝标记 + 签名 2 直陈式同场——静默行必须在标记之后。
  const denied = fakeProc({ text: 'node: failed to run: Access is denied', exitCode: 1, status: 'running', autoResolve: false });
  denied.proc.sandbox = { mode: 'workspace-write', denied: true };
  conf.installShellExecute(() => Promise.resolve(denied.proc));
  const pending = createRunTool(conf.ctx, config)
    .execute({ command: 'node x.mjs 2>&1', description: 'run node' }, exec);
  denied.settle();
  const result = await pending;
  const lines = result.note.split('\n');
  assert.match(result.note, /\[sandbox: file access denied under workspace-write mode\]/, 'R11 标记在场（同位）');
  const markerIdx = lines.findIndex((l) => l.includes('[sandbox:'));
  const silentIdx = lines.findIndex((l) => l.includes('Silent-failure guard:'));
  assert.ok(silentIdx > markerIdx, '静默行与 R11 标记同位（notes 数组）且拼在其后');
  assert.equal(silentIdx, lines.length - 1, '静默行居 note 尾部');
  assert.match(lines[silentIdx], /visible denial signature/, '签名 2 直陈式');

  // 签名 1：受限未拒 + 空输出 + 捕获形 → 条件式提醒是唯一 note 行。
  const quiet = fakeProc({ text: '', exitCode: 1, status: 'running', autoResolve: false });
  quiet.proc.sandbox = { mode: 'workspace-write' };
  const conf2 = confinedCtx();
  conf2.installShellExecute(() => Promise.resolve(quiet.proc));
  const pending2 = createRunTool(conf2.ctx, config)
    .execute({ command: 'node x.mjs 2>&1', description: 'run node' }, exec);  quiet.settle();
  const r2 = await pending2;
  assert.match(r2.note, /may have been killed at process creation/, '签名 1 条件式提醒到达模型可见文本');

  // 开关关：无任何 note ⇒ note 键不得出现（"没有内容时不能写 note: ''"的口径）。
  const conf3 = confinedCtx();
  const quiet2 = fakeProc({ text: '', exitCode: 1, status: 'running', autoResolve: false });
  quiet2.proc.sandbox = { mode: 'workspace-write' };
  conf3.installShellExecute(() => Promise.resolve(quiet2.proc));
  const off = resolveConfig({ toolName: 'async_run', silentFailureGuard: false });
  const pending3 = createRunTool(conf3.ctx, off)
    .execute({ command: 'node x.mjs 2>&1', description: 'run node' }, exec);
  quiet2.settle();
  const r3 = await pending3;
  assert.equal('note' in r3, false, '空 note 数组 ⇒ 键不出现，不是 note: ""');
});

hostTest('R28 判据10：后台出口——detail 尾部拼静默行，开关在结算时刻现读', async () => {
  const conf = confinedCtx();
  conf.ctx.timer.timeout = (callback) => { const h = setTimeout(callback, 0); return () => clearTimeout(h); };
  // 活视图（resolveConfig 的产物是冻结对象，翻转必须走视图——真机上是 loader 原地改写的活 Ref）。
  // owningPreset 与 confinedCtx 会话预设全等（后台结算路径同样过行声明值比对）。
  const current = { ...resolveConfig({ toolName: 'async_run', silentFailureGuard: false, owningPreset: 'dsh-async' }) };
  const view = new Proxy({}, { get: (_target, key) => current[key] });
  const tool = createRunTool(conf.ctx, view);

  const quiet = fakeProc({ text: '', exitCode: 1, status: 'running', autoResolve: false });
  quiet.proc.sandbox = { mode: 'workspace-write' };
  conf.installShellExecute(() => Promise.resolve(quiet.proc));
  const result = await tool.execute({ command: 'node x.mjs 2>&1', description: 'long', yield_ms: 1 }, exec);
  assert.equal(result.status, 'running', '应当让出并返回句柄');

  // 注册时刻关、结算前开：done 钩子在结算时刻现读活视图 ⇒ 必须产出。
  current.silentFailureGuard = true;
  quiet.settle();
  await new Promise((r) => { setTimeout(r, 0); });
  const flippedOn = conf.jobsFake.views().at(-1);
  assert.equal(flippedOn.status, 'completed');
  // 后台 detail 的退出码行是既有键 `exit code: {code}`（text.js 的 detail.exitCode，
  // 无方括号）；带方括号的 `[exit code: N]` 是**前台** render 标记（render.exitCode）。
  // 判据 10 只要求 note 行居尾 + 结算时刻现读，不触碰后台首行既有格式。
  assert.ok(flippedOn.detail.startsWith('exit code: 1\n'), '退出码行在场（detail 首行，后台口径无方括号）');
  const onLines = flippedOn.detail.split('\n');
  assert.equal(onLines.at(-1).includes('Silent-failure guard:'), true, '静默行居 detail 尾部');
  assert.match(flippedOn.detail, /may have been killed at process creation/, '结算时刻读到的开关 = 开');

  // 反向：注册时刻开、结算前关 ⇒ 不产出（"下一次生效"对后台作业同样成立）。
  const conf2 = confinedCtx();
  conf2.ctx.timer.timeout = (callback) => { const h = setTimeout(callback, 0); return () => clearTimeout(h); };
  const current2 = { ...resolveConfig({ toolName: 'async_run', silentFailureGuard: true, owningPreset: 'dsh-async' }) };
  const view2 = new Proxy({}, { get: (_target, key) => current2[key] });
  const tool2 = createRunTool(conf2.ctx, view2);
  const quiet2 = fakeProc({ text: '', exitCode: 1, status: 'running', autoResolve: false });
  quiet2.proc.sandbox = { mode: 'workspace-write' };
  conf2.installShellExecute(() => Promise.resolve(quiet2.proc));
  await tool2.execute({ command: 'node x.mjs 2>&1', description: 'long', yield_ms: 1 }, exec);
  current2.silentFailureGuard = false;
  quiet2.settle();
  await new Promise((r) => { setTimeout(r, 0); });
  const flippedOff = conf2.jobsFake.views().at(-1);
  assert.equal(flippedOff.status, 'completed');
  assert.equal(flippedOff.detail.includes('Silent-failure guard:'), false, '结算时刻开关已关 ⇒ 无静默行');
});

hostTest('F3（范围判定·前台）：调用主体不在本包预设 ⇒ 结果诊断不产生（开关开也一样）', async () => {
  // confinedCtx('standard')：sessions.get 命中但 agentPreset 不是本包两预设——
  // guardActiveFor 的实际预设判定不通过，前台 note 不拼静默行（无行声明值时
  // 判定同样关——下一条用例补行声明值比对的三形态）。
  const conf = confinedCtx('standard');
  const quiet = fakeProc({ text: '', exitCode: 1, status: 'running', autoResolve: false });
  quiet.proc.sandbox = { mode: 'workspace-write' };
  conf.installShellExecute(() => Promise.resolve(quiet.proc));
  const pending = createRunTool(conf.ctx, resolveConfig({ toolName: 'async_run', silentFailureGuard: true }))
    .execute({ command: 'node x.mjs 2>&1', description: 'run node' }, exec);
  quiet.settle();
  const result = await pending;
  assert.equal('note' in result, false, '非归属主体的前台返回不得拼静默行（键都不出现）');
});

hostTest('F3（范围判定·后台）：结算时刻主体不在本包预设 ⇒ detail 无静默行；服务缺席同样关闭', async () => {
  const conf = confinedCtx('standard');
  conf.ctx.timer.timeout = (callback) => { const h = setTimeout(callback, 0); return () => clearTimeout(h); };
  const quiet = fakeProc({ text: '', exitCode: 1, status: 'running', autoResolve: false });
  quiet.proc.sandbox = { mode: 'workspace-write' };
  conf.installShellExecute(() => Promise.resolve(quiet.proc));
  const result = await createRunTool(conf.ctx, resolveConfig({ toolName: 'async_run', silentFailureGuard: true }))
    .execute({ command: 'node x.mjs 2>&1', description: 'long', yield_ms: 1 }, exec);
  assert.equal(result.status, 'running');
  quiet.settle();
  await new Promise((r) => { setTimeout(r, 0); });
  const view = conf.jobsFake.views().at(-1);
  assert.equal(view.status, 'completed');
  assert.equal(view.detail.includes('Silent-failure guard:'), false, '非归属主体的后台 detail 无静默行');

  // 失效安全方向＝关：sessions 服务整个缺席（无预设可读）——同样不产生诊断。
  const bare = confinedCtx();
  bare.ctx.get = (key) => (key === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write' }) } : undefined);
  bare.ctx.sessionProjections = undefined;
  bare.ctx.timer.timeout = (callback) => { const h = setTimeout(callback, 0); return () => clearTimeout(h); };
  const quiet3 = fakeProc({ text: '', exitCode: 1, status: 'running', autoResolve: false });
  quiet3.proc.sandbox = { mode: 'workspace-write' };
  bare.installShellExecute(() => Promise.resolve(quiet3.proc));
  await createRunTool(bare.ctx, resolveConfig({ toolName: 'async_run', silentFailureGuard: true }))
    .execute({ command: 'node x.mjs 2>&1', description: 'long', yield_ms: 1 }, exec);
  quiet3.settle();
  await new Promise((r) => { setTimeout(r, 0); });
  const bareView = bare.jobsFake.views().at(-1);
  assert.equal(bareView.status, 'completed');
  assert.equal(bareView.detail.includes('Silent-failure guard:'), false, '服务缺席 ⇒ 范围不可判定 ⇒ 不产生诊断（失效安全＝关）');
});

hostTest('R28 判据11：b 段五门组合矩阵 + 描述就地增删（不复制 c 的纪律文本）', async () => {
  const warnAnchor = /can die silently at process creation/;
  // 归属前提（设计 §6.2）：警示段是**四门**——执行器在场 × 开关开 × 行归属声明
  // 属本包两预设 × 已核得「会话实际预设与声明值一致」的运行时证据。证据是
  // 模块级单例，先清空隔离（本用例自带执行入口核得证据的正反路径）。
  resetGuardOwnershipEvidence();
  const owned = { toolName: 'async_run', silentFailureGuard: true, owningPreset: 'dsh-async' };
  const on = confinedCtx();
  assert.doesNotMatch(
    createRunTool(on.ctx, resolveConfig({ ...owned })).description,
    warnAnchor, '有执行器 + 开 + 归属声明，但证据尚未核得（装载后未执行）⇒ 不拼');

  // 执行入口核得一致（confinedCtx 会话预设 dsh-async = 声明值）→ 证据按**本行
  // 令牌**登记，就地重建描述 → 警示在场。注意用原始工具对象断言：就地重建写的
  // 是 createRunTool 闭包内的那个对象，checkedTool 的浅拷贝看不到后续改写。
  const quiet = fakeProc({ text: 'ok', exitCode: 0, status: 'running', autoResolve: false });
  on.installShellExecute(() => Promise.resolve(quiet.proc));
  const live = { ...resolveConfig({ ...owned }) };
  const view = new Proxy({}, { get: (_target, key) => live[key] });
  const tool = buildRunTool(on.ctx, view);
  const pending = tool.execute({ command: 'echo hi', description: 'guard evidence' }, exec);
  quiet.settle();
  const settled = await pending;
  assert.equal(settled.status, 'completed');
  assert.match(tool.description, warnAnchor, '执行核得一致 ⇒ 证据登记 + 描述就地重建（警示在场）');
  // 证据按行隔离：同声明值的**新行**是新的行令牌，未执行核得 ⇒ 不拼——
  // 他行（含复制同一声明值的自建行）核得的证据对本行不可见（A-F13 反例的
  // 机制方面：按声明值全局共享会让全行刷新把警示泄漏到未核得的行）。
  assert.doesNotMatch(
    createRunTool(on.ctx, resolveConfig({ ...owned })).description,
    warnAnchor, '证据按行隔离 ⇒ 同声明值的新行（未执行核得）不拼');

  // 开关关 / 无执行器 / 无归属声明 ⇒ 不拼（本行证据缺席或开关关都拦；
  // 「已核得的行翻关 ⇒ 消失」由下文 flip 小节锁）。
  const off = confinedCtx();
  assert.doesNotMatch(
    createRunTool(off.ctx, resolveConfig({ ...owned, silentFailureGuard: false })).description,
    warnAnchor, '有执行器 + 关 ⇒ 不拼');
  const plainOn = fakeCtx();
  plainOn.installShellExecute(() => Promise.resolve(fakeProc({ text: 'ok' }).proc));
  assert.doesNotMatch(
    createRunTool(plainOn.ctx, resolveConfig({ ...owned })).description,
    warnAnchor, '无执行器 + 开 + 归属 ⇒ 不拼（不给走不通的指引）');
  const custom = confinedCtx();
  assert.doesNotMatch(
    createRunTool(custom.ctx, resolveConfig({ toolName: 'async_run', silentFailureGuard: true })).description,
    warnAnchor, '无归属声明（自定义行）⇒ 不拼（设计 §6.2）');
  // b 段不得复制 c 的纪律文本（需求"不复制 c"条款）。
  assert.doesNotMatch(
    tool.description,
    /Execution discipline for this deployment/, 'b 是紧凑警示段，不是纪律段复制');

  // 就地增删：活视图翻转 + refreshToolDescriptions 重建（volatile 链的行为差异）。
  // 翻转基线行先经执行核得本行证据（新行未执行不会拼，无法演示翻转）。
  const flip = confinedCtx();
  const quietFlip = fakeProc({ text: 'ok', exitCode: 0, status: 'running', autoResolve: false });
  flip.installShellExecute(() => Promise.resolve(quietFlip.proc));
  const current = { ...resolveConfig({ ...owned }) };
  const flipView = new Proxy({}, { get: (_target, key) => current[key] });
  const flipTool = buildRunTool(flip.ctx, flipView);
  const flipRun = flipTool.execute({ command: 'echo flip', description: 'flip' }, exec);
  quietFlip.settle();
  await flipRun;
  assert.match(flipTool.description, warnAnchor, '执行核得 ⇒ 初始在场（翻转基线）');
  current.silentFailureGuard = false;
  refreshToolDescriptions(flipTool, flipView);
  assert.doesNotMatch(flipTool.description, warnAnchor, '翻转关 + refresh ⇒ 警示段消失');
  current.silentFailureGuard = true;
  refreshToolDescriptions(flipTool, flipView);
  assert.match(flipTool.description, warnAnchor, '翻转开 + refresh ⇒ 警示段出现（不重启）');
  // 归属翻转：owningPreset 非本包预设时同样消失（行身份是装载期常量，这里只
  // 锁视图传播——视图层现读，不缓存归属判定）。
  current.owningPreset = undefined;
  refreshToolDescriptions(flipTool, flipView);
  assert.doesNotMatch(flipTool.description, warnAnchor, '归属不在本包两预设 ⇒ 警示段消失');
  // 复位证据：不得泄漏到其它用例（test:inproc 下共享单例）。
  resetGuardOwnershipEvidence();
});

hostTest('F3b（§6.2 归属比对）：会话预设≠行声明值 ⇒ 警示与诊断都不产生；全等 ⇒ 产生；读取失败 ⇒ 不产生', async () => {
  const warnAnchor = /can die silently at process creation/;
  const quiet = fakeProc({ text: '', exitCode: 1, status: 'running', autoResolve: false });
  quiet.proc.sandbox = { mode: 'workspace-write' };
  const owned = { toolName: 'async_run', silentFailureGuard: true, owningPreset: 'dsh-async' };
  resetGuardOwnershipEvidence();

  // ① 自建行复制归属声明（dsh-async）+ 开关开，但会话实际预设是
  //    dsh-async-create（≠声明值）——描述警示与结果诊断都不出现。
  //    断言用**执行行自身**的描述对象（就地重建写的是闭包内对象）。
  const mismatch = confinedCtx('dsh-async-create');
  mismatch.installShellExecute(() => Promise.resolve(quiet.proc));
  const mismatchTool = buildRunTool(mismatch.ctx, resolveConfig({ ...owned }));
  const pending1 = mismatchTool
    .execute({ command: 'node x.mjs 2>&1', description: 'run node' }, exec);
  quiet.settle();
  const r1 = await pending1;
  assert.equal('note' in r1, false, '会话预设≠声明值 ⇒ 前台诊断不拼（键都不出现）');
  assert.doesNotMatch(mismatchTool.description,
    warnAnchor, '会话预设≠声明值 ⇒ 无运行时证据 ⇒ 描述警示不拼');

  // ② 会话实际预设 = 行声明值（dsh-async）⇒ 诊断产生、执行核得证据后警示在场。
  const match = confinedCtx('dsh-async');
  const quiet2 = fakeProc({ text: '', exitCode: 1, status: 'running', autoResolve: false });
  quiet2.proc.sandbox = { mode: 'workspace-write' };
  match.installShellExecute(() => Promise.resolve(quiet2.proc));
  const matchTool = buildRunTool(match.ctx, resolveConfig({ ...owned }));
  const pending2 = matchTool
    .execute({ command: 'node x.mjs 2>&1', description: 'run node' }, exec);
  quiet2.settle();
  const r2 = await pending2;
  assert.match(r2.note, /Silent-failure guard:/, '会话预设=声明值 ⇒ 前台诊断在场');
  assert.match(matchTool.description, warnAnchor, '本行核得证据 ⇒ 本行描述警示在场');

  // ③ 读取失败（stateOf 抛错）⇒ 失效安全＝关：诊断不产生、该次执行不登记
  //    新证据（先清空 ② 留下的证据，验证读取失败不产生新登记）。
  resetGuardOwnershipEvidence();
  const broken = confinedCtx('dsh-async');
  broken.ctx.sessionProjections = { stateOf() { throw new Error('projection read failed'); } };
  const quiet3 = fakeProc({ text: '', exitCode: 1, status: 'running', autoResolve: false });
  quiet3.proc.sandbox = { mode: 'workspace-write' };
  broken.installShellExecute(() => Promise.resolve(quiet3.proc));
  const brokenTool = buildRunTool(broken.ctx, resolveConfig({ ...owned }));
  const pending3 = brokenTool
    .execute({ command: 'node x.mjs 2>&1', description: 'run node' }, exec);
  quiet3.settle();
  const r3 = await pending3;
  assert.equal('note' in r3, false, '读取失败 ⇒ 不产生诊断（失效安全＝关）');
  assert.doesNotMatch(brokenTool.description,
    warnAnchor, '读取失败 ⇒ 该次执行不登记证据 ⇒ 执行行自身的描述警示也不拼');
  resetGuardOwnershipEvidence();
});

hostTest('R28 判据12：c 段经 ctx.inject 注册 systemPrompt（预设过滤经 ctx.get 现读），文本每次组稿现读快照', () => {
  const f = fakeCtx();
  const injectFns = new Map();
  const injectLists = [];
  const effects = [];
  // fakeCtx 没有 inject/effect——宿主侧接线在此补（先例：T12 对 settings.js 的补法）。
  // applyHostHalf 注册**两个**子 scope：c 段纪律与执行纪律 section 共用第一个
  // systemPrompt 子 scope（c 段 context 与执行纪律 section 都只等 systemPrompt，
  // 预设过滤两服务经 ctx.get 现读——依赖范围收窄，sessions 缺席不再拦住注册；
  // section 行为矩阵见下一条用例）；ask 接线另立。
  f.ctx.inject = (list, fn) => { injectLists.push(list); injectFns.set(list.join(','), fn); };
  f.ctx.effect = (dispose) => { effects.push(dispose); };
  // text 内现读（`ctx.get('sessions')` / `ctx.get('sessionProjections')`）的桩：
  // 按用例改写两服务的返回（get 键 = 组稿目标 agent id，真实 dsh-session 语义）。
  let sessionsService = { get: () => ({ id: 'session-1' }) };
  let projectionService = { stateOf: () => 'dsh-async' };
  f.ctx.get = (key) => {
    if (key === 'sessions') return sessionsService;
    if (key === 'sessionProjections') return projectionService;
    return undefined;
  };
  applyHostHalf(f.ctx, resolveConfig({ silentFailureGuard: false }));
  assert.equal(effects.length, 2, '快照源 + R30 ask 接线两个处置器挂到 ctx.effect');
  assert.deepEqual(injectLists, [['systemPrompt'], ['sessions', 'sessionProjections', 'agents']],
    '纪律段（context＋section）只等 systemPrompt（预设过滤经 ctx.get 现读，不进等待名单）；R30 ask 接线另立三服务子 scope');

  const entry = {};
  const sectionEntry = {};
  const assembly = { agent: { id: 'session-1' } };
  injectFns.get('systemPrompt')({
    systemPrompt: {
      context: (e) => { Object.assign(entry, e); },
      section: (e) => { Object.assign(sectionEntry, e); }
    }
  });
  assert.equal(entry.name, 'async-tools:discipline', '段名命名空间化（sandbox:policy 成例）');
  assert.equal(entry.order, 130, '段序 130（内置三名的 110/115/120 之后）');
  assert.equal(typeof entry.text, 'function', 'text 是函数——每次组稿现求');
  // 同一回调注册的执行纪律 section（形状级；行为矩阵在下一条用例）。
  assert.equal(sectionEntry.name, 'async-tools:agent-discipline', 'section 名命名空间化（persona 前缀档之后的紧邻档）');
  assert.equal(sectionEntry.order, 500, 'section 段序 500（宿主段序表 persona 档 0 之后的首个档值）');
  assert.equal(typeof sectionEntry.text, 'function', 'section text 是函数——每次组稿现求');

  // 关：首播快照就是关 ⇒ 空串（段本体不注销，渲染层过滤空串段）。
  assert.equal(entry.text(assembly), '', '快照 guard=false ⇒ 空串');
  // 快照缺席（宿主行卸载后）⇒ 失效安全方向 = 关，不抛错。
  clearSnapshot();
  assert.equal(entry.text(assembly), '', '快照缺席 ⇒ 空串，不抛');
  // 预设过滤（需求 §6.3）：目标会话不在本包两预设之列 ⇒ 空串（标准/评审链不吃纪律段）。
  seedSnapshot(resolveConfig({ silentFailureGuard: true, agentLang: 'en' }));
  projectionService = { stateOf: () => 'standard' };
  assert.equal(entry.text(assembly), '', '预设 standard ⇒ 空串（c 段只对本包两预设生效）');
  // sessions/sessionProjections 缺席 ⇒ 空串（服务缺席不再拦注册，段仍失效安全=关）。
  projectionService = { stateOf: () => 'dsh-async' };
  sessionsService = undefined;
  assert.equal(entry.text(assembly), '', 'sessions 服务缺席 ⇒ 空串（现读路径，失效安全=关）');
  sessionsService = { get: () => ({ id: 'session-1' }) };
  projectionService = undefined;
  assert.equal(entry.text(assembly), '', 'sessionProjections 服务缺席 ⇒ 空串（现读路径，失效安全=关）');
  projectionService = { stateOf: () => 'dsh-async' };
  // 开 + en：E2E 逐字锚句必须与词典键一致。
  seedSnapshot(resolveConfig({ silentFailureGuard: true, agentLang: 'en' }));
  const en = entry.text(assembly);
  assert.equal(en, t('en', 'discipline.block'), 'en 段文本 = 词典键逐字（真机验收锚句同源）');
  assert.match(en, /run it once as a bare call/);
  assert.match(en, /If output you expected is missing/, '处置锚在「预期的输出缺失」上（无输出设计的捕获形命令不误判）');
  assert.match(en, /killed at process creation/);
  assert.match(en, /4294967295/, '杀软击杀隐藏 PowerShell 的判别特征在场（退出码 4294967295）');
  assert.match(en, /-Width/, '杀软纪律：改写法在场（-Width／经变量传值）');
  // 开 + zh：agentLang 现行档决定语言。
  seedSnapshot(resolveConfig({ silentFailureGuard: true, agentLang: 'zh' }));
  const zh = entry.text(assembly);
  assert.equal(zh, t('zh', 'discipline.block'), 'zh 段文本 = 词典键逐字');
  assert.match(zh, /裸调用重试一次/);
  assert.match(zh, /若预期的输出缺失/, '处置条件句在场（与 note.silentCapture 同口径，防回潮无条件断言）');
  assert.match(zh, /进程创建层被杀/);
  assert.match(zh, /4294967295/);
  // 复位模块级快照（test:inproc 下共享单例，不得泄漏到其它套件）。
  clearSnapshot();
});

hostTest('执行纪律 section：语言档现读 agentLang、变体按目标预设、不受开关控制、失效安全空串（设计 §3.6）', () => {
  const f = fakeCtx();
  const injectFns = new Map();
  f.ctx.inject = (list, fn) => { injectFns.set(list.join(','), fn); };
  f.ctx.effect = () => {};
  let sessionsService = { get: () => ({ id: 'session-1' }) };
  let projectionService = { stateOf: () => 'dsh-async' };
  f.ctx.get = (key) => {
    if (key === 'sessions') return sessionsService;
    if (key === 'sessionProjections') return projectionService;
    return undefined;
  };
  applyHostHalf(f.ctx, resolveConfig({ silentFailureGuard: false }));
  const entry = {};
  injectFns.get('systemPrompt')({
    systemPrompt: { context: () => {}, section: (e) => { Object.assign(entry, e); } }
  });
  const assembly = { agent: { id: 'session-1' } };

  // 快照缺席（宿主行卸载后）⇒ 空串，不抛错（失效安全方向 = 段不出现）。
  // applyHostHalf 装载时已播首份快照——先清掉再验缺席形态。
  clearSnapshot();
  assert.equal(entry.text(assembly), '', '快照缺席 ⇒ 空串');
  // 常驻纪律：不受 silentFailureGuard 控制（该开关只管 c 防线）——开关关仍然注入。
  seedSnapshot(resolveConfig({ silentFailureGuard: false, agentLang: 'en' }));
  const en = entry.text(assembly);
  assert.equal(en, t('en', 'discipline.preset.dsh-async'), 'en 档文本 = 词典键逐字（与验收锚句同源）');
  assert.match(en, /async_agent is the ONLY delegation entry/);
  assert.match(en, /never pass run_in_background: false/, 'dsh-async 变体的前台委托禁句在场');
  // 变体按目标会话的实际预设：create 档换差异句。
  projectionService = { stateOf: () => 'dsh-async-create' };
  const createEn = entry.text(assembly);
  assert.equal(createEn, t('en', 'discipline.preset.dsh-async-create'), 'create 变体 = 对应词典键逐字');
  assert.match(createEn, /do not call them/, 'create 变体的「已禁用、不要调用」句在场');
  assert.doesNotMatch(createEn, /run_in_background: false/, 'create 变体不含 dsh-async 档的前台禁句');
  // zh 档：agentLang 现行档决定语言（需求 §5.3：中文档同样完整）。
  seedSnapshot(resolveConfig({ silentFailureGuard: true, agentLang: 'zh' }));
  const zh = entry.text(assembly);
  assert.equal(zh, t('zh', 'discipline.preset.dsh-async-create'), 'zh 档文本 = 词典键逐字');
  assert.match(zh, /唯一的委托入口/);
  assert.match(zh, /不要调用/);
  // 非目标预设 / 无 agent / 两服务缺席 ⇒ 空串。
  projectionService = { stateOf: () => 'standard' };
  assert.equal(entry.text(assembly), '', '其他预设会话 ⇒ 空串（段只对本包两预设生效）');
  projectionService = { stateOf: () => 'dsh-async' };
  assert.equal(entry.text({}), '', '无 agent 的组稿 ⇒ 空串');
  sessionsService = undefined;
  assert.equal(entry.text(assembly), '', 'sessions 服务缺席 ⇒ 空串');
  sessionsService = { get: () => ({ id: 'session-1' }) };
  projectionService = undefined;
  assert.equal(entry.text(assembly), '', 'sessionProjections 服务缺席 ⇒ 空串');
  // 复位模块级快照。
  clearSnapshot();
});

hostTest('A-F13 回归：证据按行隔离——P 行执行核得后全行刷新，Q 行（复制同一声明值）警示缺席', async () => {
  const warnAnchor = /can die silently at process creation/;
  resetGuardOwnershipEvidence();
  // 组合 P（真 dsh-async 行）：声明 = 会话预设，执行入口核得一致 ⇒ 本行证据登记。
  const p = confinedCtx('dsh-async');
  const quietP = fakeProc({ text: 'ok', exitCode: 0, status: 'running', autoResolve: false });
  p.installShellExecute(() => Promise.resolve(quietP.proc));
  const pLive = { ...resolveConfig({ toolName: 'async_run', silentFailureGuard: true, owningPreset: 'dsh-async' }) };
  const pView = new Proxy({}, { get: (_t, k) => pLive[k] });
  const pTool = buildRunTool(p.ctx, pView);
  const pRun = pTool.execute({ command: 'echo p', description: 'p' }, exec);
  quietP.settle();
  await pRun;
  assert.match(pTool.description, warnAnchor, 'P 行执行核得 ⇒ 本行警示在场');
  // 组合 Q（自建行复制 owningPreset:'dsh-async'）：会话预设 av0408-custom ≠ 声明值。
  const q = confinedCtx('av0408-custom');
  const qLive = { ...resolveConfig({ toolName: 'async_run', silentFailureGuard: true, owningPreset: 'dsh-async' }) };
  const qView = new Proxy({}, { get: (_t, k) => qLive[k] });
  const qTool = buildRunTool(q.ctx, qView);
  // volatile 提交触发 refresh-bus 全行刷新：两行各自就地重建（同一模块实例的证据表）。
  // 按声明值全局共享证据时，Q 行在这里吃到 P 行核得的 'dsh-async' ⇒ 警示泄漏（原反例）。
  refreshToolDescriptions(pTool, pView);
  refreshToolDescriptions(qTool, qView);
  assert.doesNotMatch(qTool.description, warnAnchor, '全行刷新后 Q 行警示仍缺席（证据按行令牌隔离）');
  assert.match(pTool.description, warnAnchor, 'P 行不受影响');
  // Q 自身执行（归属不一致）⇒ 不登记 ⇒ 再刷新仍缺席。
  const quietQ = fakeProc({ text: 'ok', exitCode: 0, status: 'running', autoResolve: false });
  q.installShellExecute(() => Promise.resolve(quietQ.proc));
  const qRun = qTool.execute({ command: 'echo q', description: 'q' }, exec);
  quietQ.settle();
  await qRun;
  refreshToolDescriptions(qTool, qView);
  assert.doesNotMatch(qTool.description, warnAnchor, 'Q 自身执行（归属不一致）不登记 ⇒ 仍缺席');
  resetGuardOwnershipEvidence();
});

// 真实宿主收集层形态：不用 fakeCtx 假件，直接装载真实 cordis Context 与真实
// SystemPrompt 服务（宿主锚缺席的离线形态整条自跳过，与 hostTest 同一契约）。
const realLayerTest = await hostTestFor('@deepseek-ai/cordis', '@deepseek-ai/dsh-system-prompt');
realLayerTest('A-F12 回归：c 段注册落在宿主组稿会收集的 global 层，assemble 端到端可见', async () => {
  const { Context, Service } = await import('@deepseek-ai/cordis');
  const { SystemPrompt, renderContextSections, joinContextSections, renderPrompt } = await import('@deepseek-ai/dsh-system-prompt');
  const ctx = new Context();
  const fibers = [ctx.plugin(SystemPrompt)];
  await new Promise((r) => { setTimeout(r, 20); });
  // sessions/sessionProjections 完全缺席：c 段注册不被缺席拦住——依赖范围只锁
  // systemPrompt（组稿必需服务），预设过滤两服务经 ctx.get 在 text 内现读。
  applyHostHalf(ctx, resolveConfig({ silentFailureGuard: true, agentLang: 'en' }));
  await new Promise((r) => { setTimeout(r, 20); });
  const layers = ctx.systemPrompt.layers;
  assert.ok(layers.global.contexts.has('async-tools:discipline'),
    '注册发生在 global 层——宿主收集链（assemble 的 layers.merge(scope) 无条件含 global 层）会收到它');
  // 端到端：装载最小真形服务（真实 cordis Service 子类；get 键 = agent id，
  // 真实 dsh-session 的 SessionsService.get(id) 同语义）后 assemble 收集与求值。
  const presetById = new Map([['session-1', 'dsh-async'], ['session-2', 'standard']]);
  class SessionsProbe extends Service {
    constructor(c) { super(c, 'sessions'); }
    get(id) { return presetById.has(id) ? { id } : undefined; }
  }
  class ProjectionProbe extends Service {
    constructor(c) { super(c, 'sessionProjections'); }
    stateOf(session, key) { return key === 'agentPreset' ? presetById.get(session.id) : undefined; }
  }
  fibers.push(ctx.plugin(SessionsProbe), ctx.plugin(ProjectionProbe));
  await new Promise((r) => { setTimeout(r, 20); });
  const ownAgent = { id: 'session-1', session: 'session-1' };
  const otherAgent = { id: 'session-2', session: 'session-2' };
  const own = await ctx.systemPrompt.assemble({ agent: ownAgent, scope: ownAgent });
  const disciplineOwn = own.contexts.find((c) => c.name === 'async-tools:discipline');
  assert.notEqual(disciplineOwn, undefined, 'assemble({agent, scope}) 收集到纪律段 context');
  assert.match(String(disciplineOwn.text), /run it once as a bare call/,
    '本包预设会话：text 现求得纪律文本（en 锚在场）');
  const other = await ctx.systemPrompt.assemble({ agent: otherAgent, scope: otherAgent });
  const disciplineOther = other.contexts.find((c) => c.name === 'async-tools:discipline');
  assert.notEqual(disciplineOther, undefined, 'context 收集恒在场（注册不随目标会话变化）');
  assert.equal(String(disciplineOther.text), '', '其他预设会话：text 空串（渲染层过滤空段）');
  // 开关关 ⇒ 空串（失效安全方向 = 关）。
  seedSnapshot(resolveConfig({ silentFailureGuard: false, agentLang: 'en' }));
  const off = await ctx.systemPrompt.assemble({ agent: ownAgent, scope: ownAgent });
  assert.equal(String(off.contexts.find((c) => c.name === 'async-tools:discipline').text), '', '开关关 ⇒ 空串');
  // ── 渲染层双线 ──────────────────────────────────────────────────
  // 0.2.x 组稿是双线：sections 经 `renderPrompt` 进 system prompt（system/message
  // 事件的采样位置）；contexts 经 `renderContextSections`+`joinContextSections` 产出
  // 「Current runtime context.」快照、由 `dsh-agent-loop` 的 preStep 作为**消息**
  // 追加进 step 消息流（`lib/index.js` 的 preStep：`[...claimed, context]`）——
  // **不进 system prompt 文本**。纪律段是 context：模型可见位置在快照线；只采样
  // system 消息的验证装置对它天然失明。这里用真实渲染函数把两条线各锁一遍。
  seedSnapshot(resolveConfig({ silentFailureGuard: true, agentLang: 'en' }));
  const onAgain = await ctx.systemPrompt.assemble({ agent: ownAgent, scope: ownAgent });
  const snapshotText = joinContextSections(renderContextSections(onAgain));
  assert.ok(snapshotText.startsWith('Current runtime context.'),
    'contexts 线的快照头（宿主 joinContextSections 的固定标题）');
  assert.match(snapshotText, /Execution discipline for this deployment/,
    '模型可见位置：快照线含纪律段（开 + 本包预设）');
  assert.match(snapshotText, /run it once as a bare call/, '快照线含 en 锚');
  const promptText = renderPrompt(onAgain);
  assert.doesNotMatch(promptText, /Execution discipline for this deployment/,
    'sections 线（system prompt 采样位置）**不含**纪律段——它是 context，双线各归其位');
  // services 后就位的读取路径（真实 provide→notify 唤醒不参与——ctx.get 现读）。
  clearSnapshot();
  for (const fiber of [...fibers].reverse()) await fiber.dispose();
});

realLayerTest('执行纪律 section：注册落在宿主组稿会收集的 global 层，assemble 端到端可见且双线各归其位（设计 §3.6）', async () => {
  const { Context, Service } = await import('@deepseek-ai/cordis');
  const { SystemPrompt, renderPrompt, renderContextSections, joinContextSections } = await import('@deepseek-ai/dsh-system-prompt');
  const ctx = new Context();
  const fibers = [ctx.plugin(SystemPrompt)];
  await new Promise((r) => { setTimeout(r, 20); });
  // 开关关着装——执行纪律是常驻纪律，不受 silentFailureGuard 控制（对照 c 防线）。
  applyHostHalf(ctx, resolveConfig({ silentFailureGuard: false, agentLang: 'en' }));
  await new Promise((r) => { setTimeout(r, 20); });
  assert.ok(ctx.systemPrompt.layers.global.sections.has('async-tools:agent-discipline'),
    'section 注册发生在 global 层——宿主收集链（assemble 的 layers.merge(scope) 无条件含 global 层）会收到它');
  const presetById = new Map([['session-1', 'dsh-async'], ['session-2', 'standard']]);
  class SessionsProbe extends Service {
    constructor(c) { super(c, 'sessions'); }
    get(id) { return presetById.has(id) ? { id } : undefined; }
  }
  class ProjectionProbe extends Service {
    constructor(c) { super(c, 'sessionProjections'); }
    stateOf(session, key) { return key === 'agentPreset' ? presetById.get(session.id) : undefined; }
  }
  fibers.push(ctx.plugin(SessionsProbe), ctx.plugin(ProjectionProbe));
  await new Promise((r) => { setTimeout(r, 20); });
  const ownAgent = { id: 'session-1', session: 'session-1' };
  const otherAgent = { id: 'session-2', session: 'session-2' };
  const own = await ctx.systemPrompt.assemble({ agent: ownAgent, scope: ownAgent });
  const sectionOwn = own.sections.find((s) => s.name === 'async-tools:agent-discipline');
  assert.notEqual(sectionOwn, undefined, 'assemble({agent, scope}) 收集到执行纪律 section');
  assert.equal(String(sectionOwn.text), t('en', 'discipline.preset.dsh-async'),
    '本包预设会话：text 现求得 en 档词典键逐字（开关关仍在——常驻纪律）');
  const other = await ctx.systemPrompt.assemble({ agent: otherAgent, scope: otherAgent });
  const sectionOther = other.sections.find((s) => s.name === 'async-tools:agent-discipline');
  assert.notEqual(sectionOther, undefined, 'section 收集恒在场（注册不随目标会话变化）');
  assert.equal(String(sectionOther.text), '', '其他预设会话：text 空串（渲染层过滤空段）');
  // ── 渲染层双线（与 c 防线对照：section 进 system prompt 正文，不进快照消息）──
  const promptText = renderPrompt(own);
  assert.match(promptText, /This deployment runs commands ASYNCHRONOUSLY/,
    '模型可见位置：system prompt 正文含执行纪律段（开关关 + 本包预设）');
  assert.match(promptText, /never pass run_in_background: false/, '正文含 dsh-async 档前台委托禁句');
  const promptOther = renderPrompt(other);
  assert.doesNotMatch(promptOther, /This deployment runs commands ASYNCHRONOUSLY/,
    '其他预设会话：正文不含执行纪律段（空串段被渲染层过滤）');
  const snapshotText = joinContextSections(renderContextSections(own));
  assert.doesNotMatch(snapshotText, /This deployment runs commands ASYNCHRONOUSLY/,
    'contexts 快照线不含执行纪律段——section 只进 system prompt 正文（双线各归其位）');
  // zh 档现读：换快照语言，同一段换中文（语言档由 agentLang 管理，需求 §5.3）。
  seedSnapshot(resolveConfig({ silentFailureGuard: false, agentLang: 'zh' }));
  const zhOwn = await ctx.systemPrompt.assemble({ agent: ownAgent, scope: ownAgent });
  assert.match(renderPrompt(zhOwn), /唯一的委托入口/, 'zh 档现读：正文含中文锚');
  clearSnapshot();
  for (const fiber of [...fibers].reverse()) await fiber.dispose();
});

test('R28 判据13：设置界面 19 字段逐项在场 + flag spec 矩阵 + resolveConfig 归一', async () => {
  // —— 键集身份核对：FIELDS = 预算 + 语言 + 开关 + 展示 + 提问五组之和（顺序也一致；
  // 开关组 2 枚、展示组 2 枚、ASK 组 3 枚，合计 19）。
  const expectedKeys = [...BUDGET_FIELD_KEYS, ...LANG_FIELD_KEYS, ...FLAG_FIELD_KEYS, ...DISPLAY_FIELD_KEYS, ...ASK_FIELD_KEYS];
  assert.equal(expectedKeys.length, 19, '19 = 10 预算 + 2 语言 + 2 开关 + 2 展示 + 3 提问');
  assert.equal(FLAG_FIELD_KEYS.length, 2);
  assert.equal(FLAG_FIELD_KEYS[0], 'silentFailureGuard');
  assert.equal(FLAG_FIELD_KEYS[1], 'askTakeover');
  assert.deepEqual(DISPLAY_FIELD_KEYS, ['workflowProgressLog', 'fullCommandEcho']);
  assert.deepEqual(ASK_FIELD_KEYS, ['askTimeoutMs', 'askExtendMs', 'askUiSeat']);

  // —— 加载 client.js（CJS 包裹，浏览器侧无转译器——two-planes 的装载成例）。
  const ROOT = resolve(import.meta.dirname, '..');
  const source = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
  let loaded;
  new Function('window', source)({ __ModuleLoader__: { load: (spec) => { loaded = spec; } } });
  const reactStub = {
    createElement: () => null,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null })
  };
  const double = makePrimitivesDouble(reactStub);
  const product = loaded.factory((name) => (name === 'react' ? reactStub : double));
  assert.deepEqual(product.FIELDS.map((field) => field.key), expectedKeys,
    '设置卡 19 项逐项在场（缺一项即红，不只数个数）');
  assert.deepEqual(product.makeSpecs().map((spec) => spec.field), expectedKeys,
    'spec 列表与 FIELDS 逐项相等（顺序 = FIELDS 顺序）');

  // —— flagFieldSpec 矩阵（偏离 ③：官方 SettingsFieldSpec 形状，两态文本制）。
  const spec = product.flagFieldSpec('silentFailureGuard');
  assert.equal(spec.field, 'silentFailureGuard');
  assert.equal(spec.format(true), 'true');
  assert.equal(spec.format(false), 'false');
  assert.equal(spec.format(undefined), 'false', '无覆盖（undefined）显示生效值 false');
  assert.deepEqual(spec.parse('true'), { kind: 'set', value: true });
  assert.deepEqual(spec.parse(' true '), { kind: 'set', value: true }, '草稿 trim 后判');
  assert.deepEqual(spec.parse('false'), { kind: 'set', value: false }, '显式 false 也是用户覆盖');
  assert.deepEqual(spec.parse(''), { kind: 'clear' }, '空草稿 = 恢复默认（回 false）');
  assert.equal(spec.parse('yes'), undefined, '非法草稿阻止保存');

  // —— resolveConfig 归一（布尔类型检查在 transform 回调与 resolveConfig 自检
  // 同源：非法类型 fail-fast 抛错，schema 字段本身 any 透传不静默收敛）。
  assert.equal(resolveConfig({ silentFailureGuard: true }).silentFailureGuard, true);
  assert.equal(resolveConfig({ silentFailureGuard: false }).silentFailureGuard, false);
  assert.equal(resolveConfig({}).silentFailureGuard, false, '缺省 ⇒ 关（默认关裁定）');
  // 非布尔候选在持久化之前被类型检查拒绝（type violation 文案，判据与 transform
  // 回调逐字同源）——不是"成功但值被收敛"。
  assert.throws(() => resolveConfig({ silentFailureGuard: 'yes' }),
    /type violation: silentFailureGuard must be a boolean, got string "yes"/);
  assert.throws(() => resolveConfig({ silentFailureGuard: 1 }),
    /type violation: silentFailureGuard must be a boolean, got number 1/);
  // null 是"未设置"语义（schemastery 对 null 取 default），仍回默认关。
  assert.equal(resolveConfig({ silentFailureGuard: null }).silentFailureGuard, false, 'null 回默认');
  // volatile 活 Ref 入口（真机链：loader 就地提交原地改写的就是这个形状）——
  // 合法布尔经 Ref 解包后照常通过。
  assert.equal(resolveConfig({ silentFailureGuard: { get: () => true } }).silentFailureGuard, true,
    'Ref 形态解包后归一');
  assert.throws(() => resolveConfig({ silentFailureGuard: { get: () => 'yes' } }),
    /type violation: silentFailureGuard must be a boolean, got string "yes"/,
    'Ref 里的非布尔候选同样被类型检查拒绝');
});
