/**
 * R28 静默失败三防线单测（需求 `docs/requirements.md` R28 / 设计 §30，判据 §30.7）。
 *
 * ## 这条需求修的是什么
 *
 * 受限沙箱里外部 EXE 被捕获形态（`2>&1` / `$(...)` / 变量赋值 / `>`）包装后死在
 * **进程创建层**——零输出、零 `[exit code]` 标记；R11 的拒绝标记只覆盖
 * "看得见的拒绝"，这一类**看不见的死亡**此前没有任何防线。三道防线（a 结果侧
 * 自诊断 / b 描述侧警示段 / c 常驻纪律段）全部由同一个 volatile 布尔
 * `silentFailureGuard` 控制，默认关——关掉后三处都以**行为差异**消失。
 *
 * ## 判据 → 各挡什么（§30.7；判据 14 = 全量无回归，由独立测试子代理跑 `npm test`）
 *
 * | 判据 | 挡的缺陷形态 |
 * |---|---|
 * | 1 捕获形四模式 + 管道一票否决 | 把管道也当捕获形 ⇒ cmdlet 管道大量误触发（可失败 ①） |
 * | 2 签名 1 四条件缺一即无 + 裸调用对照 | 半截条件 ⇒ 出路（裸调用重试）自己都触发提醒 |
 * | 3 空白算空 | `  \n  ` 被当成"有输出" ⇒ 签名 1 失明 |
 * | 4 cmdlet 误发接受 + 条件式措辞 | 文案直陈失败 ⇒ 裁定接受的误发面变成谎报（可失败 ②） |
 * | 5 提权跑不产出 | 提权重试完还提醒 ⇒ 提示变成噪声 |
 * | 6 签名 2 锚对矩阵 | 单锚/大小写漂移 ⇒ 拒签名该出不出、不该出乱出 |
 * | 7 非空且无锚双断 | 输出正常还提醒 ⇒ 纯噪声 |
 * | 8 开关关三防线同断 | 关不干净 ⇒ "默认关"裁定被架空（可失败 ③） |
 * | 9 前台出口：note 尾部 + 无值不写键 | note 拼错位置/写 `note: ''` ⇒ 模型看不见或被键污染 |
 * | 10 后台出口：detail 尾部 + 结算时刻读开关 | 注册时刻快照开关 ⇒ 后台作业吃不到翻转 |
 * | 11 b 段矩阵 + 就地增删 | 无执行器也拼/关不掉 ⇒ 走不通的指引或噪声（可失败 ⑥） |
 * | 12 c 段注册形状 + 快照缺席失效安全 | 注入常真/快照缺席抛错 ⇒ 默认关裁定被架空（可失败 ⑦） |
 * | 13 设置面：FIELDS 四组全部字段 + spec/归一矩阵 | 字段漂移/垃圾值不收敛 ⇒ 界面与配置链断档（可失败 ⑤） |
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRunTool as buildRunTool } from '../lib/jobs.js';
import { BUDGET_FIELD_KEYS, LANG_FIELD_KEYS, FLAG_FIELD_KEYS, ASK_FIELD_KEYS, resolveConfig } from '../lib/config.js';
import { DENIAL_ANCHOR_PAIRS, hasCaptureForm, hasDenialAnchors, silentFailureNotes } from '../lib/silent-failure.js';
import { t } from '../lib/text.js';
import { seedSnapshot, clearSnapshot } from '../lib/settings.js';
import { checkedTool, fakeAgent, fakeCtx, fakeProc } from './_helpers.mjs';
import { makePrimitivesDouble } from './_primitives-double.mjs';

/**
 * 离线安全加载：`lib/host.js` 与 `lib/index.js` 都（经 `lib/ask-takeover.js`）
 * 拉进 `@deepseek-ai/dsh-llm`——本地 node_modules 没有。只吞宿主包解析失败，
 * 其余错误原样抛（语法错误、模块内部抛错不得被伪装成"离线环境"）。
 * @returns {Promise<object | undefined>} 模块；宿主包不可解析时为 `undefined`。
 */
async function loadOfflineSafe(specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && message.includes('@deepseek-ai/')) return undefined;
    throw error;
  }
}

const hostHalf = await loadOfflineSafe('../lib/host.js');
const hostIndex = await loadOfflineSafe('../lib/index.js');
const { applyHostHalf } = hostHalf ?? {};
const { refreshToolDescriptions } = hostIndex ?? {};

const createRunTool = (ctx, config) => checkedTool(buildRunTool(ctx, config));
const exec = { agent: fakeAgent(), callId: 'call_R28_1', signal: new AbortController().signal };
/** 纯模块判定用的最小收集器：只承 `text()`。 */
const collector = (text) => ({ text: () => text });

/**
 * 造一个"约束执行器"上下文（照 `escalation.test.mjs` 的 confinedCtx 收窄）：
 * `sandboxMode` 必须在**创建工具之前**设好（参数表在构造期读一次）。
 */
function confinedCtx() {
  const f = fakeCtx();
  f.installShellExecute(() => Promise.resolve(fakeProc({ text: 'ok' }).proc));
  f.ctx.shell.sandboxMode = 'workspace-write';
  // lib/jobs.js 的 execute 走 ctx.get('sandboxPolicy') 取放行策略（escalation.test.mjs:52
  // 同款桩）：缺了会得到 `TypeError: ctx.get is not a function`，断言本体根本执行不到
  // （render-markers.test.mjs 头注的同类教训）。
  f.ctx.get = (key) => {
    if (key === 'sandboxPolicy') {
      return { resolve: () => ({ mode: 'workspace-write' }) };
    }
    return undefined;
  };
  return f;
}

test('R28 判据1：捕获形四模式任一命中，管道一票否决，多语句整体判', () => {
  // 四模式（§30.2 启发式，命令文本无管道时的命中面）。
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
  // 非命中面：`if ($x -eq 1)` 不是赋值；`--flag=1` 不是赋值。
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

test('R28 判据4：cmdlet 误发面被接受，且文案必须是条件式（可失败 ②）', () => {
  // 用户裁定：纯 cmdlet（空目录 Get-ChildItem 2>&1）命中条件式提醒**接受**。
  const notes = silentFailureNotes({
    proc: { sandbox: { mode: 'workspace-write' } },
    collector: collector(''),
    command: 'Get-ChildItem 2>&1',
    escalationModes: ['workspace-write'],
    guard: true,
    lang: 'en'
  });
  assert.equal(notes.length, 1, '裁定接受的误发面要有用例钉住');
  // 条件式措辞锚：不断言失败，正向替代（裸调用重试 / sandbox_permissions）必须在场。
  assert.match(notes[0], /If the output you expected is missing/, '条件式开头（"若"）——直陈式必红');
  assert.match(notes[0], /may have been killed at process creation/, '推测语气，不是断言');
  assert.match(notes[0], /treat it as "did not run"/, '解读口径：按「没跑」处理');
  assert.match(notes[0], /Retry it once as a bare call/, '正向替代 1：裸调用重试');
  assert.match(notes[0], /sandbox_permissions/, '正向替代 2：提权重试（本组合广告了提权字段）');
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
  // 签名 2 只有开关 + 锚对两道门：不设捕获形/空白/受限/执行器之门（需求"附加提示"口径）。
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

test('R28 判据8：开关关 ⇒ 三防线同断（行为差异，不是存在性；可失败 ③）', (t) => {
  if (hostHalf === undefined) { t.skip('宿主包不可解析（离线环境），本用例跳过'); return; }
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
  const tool = createRunTool(conf.ctx, resolveConfig({ toolName: 'async_run', silentFailureGuard: false }));
  assert.doesNotMatch(tool.description, /die silently at process creation/, '关 ⇒ b 段不拼');
  // c：纪律段组稿为空串（快照现读，段本体不注销）。
  const snapHost = fakeCtx();
  const injectFns = new Map();
  snapHost.ctx.inject = (list, fn) => { injectFns.set(list.join(','), fn); };
  snapHost.ctx.effect = () => {};
  applyHostHalf(snapHost.ctx, resolveConfig({ silentFailureGuard: false }));
  const captured = {};
  injectFns.get('systemPrompt')({ systemPrompt: { context: (entry) => { Object.assign(captured, entry); } } });
  assert.equal(captured.text(), '', '关 ⇒ c 段文本为空串（渲染层过滤）');
  clearSnapshot();
});

test('R28 判据9：前台出口——note 拼在标记之后且居尾；无值不写 note 键', async () => {
  const conf = confinedCtx();
  const config = resolveConfig({ toolName: 'async_run', silentFailureGuard: true });
  // 拒绝结算（真实形态）：R11 标记 + 签名 2 直陈式同场——静默行必须在标记之后。
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
    .execute({ command: 'node x.mjs 2>&1', description: 'run node' }, exec);
  quiet.settle();
  const r2 = await pending2;
  assert.match(r2.note, /may have been killed at process creation/, '签名 1 条件式提醒到达模型可见面');

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

test('R28 判据10：后台出口——detail 尾部拼静默行，开关在结算时刻现读', async () => {
  const conf = confinedCtx();
  conf.ctx.timer.timeout = (callback) => { const h = setTimeout(callback, 0); return () => clearTimeout(h); };
  // 活视图（resolveConfig 的产物是冻结对象，翻转必须走视图——真机上是 loader 原地改写的活 Ref）。
  const current = { ...resolveConfig({ toolName: 'async_run', silentFailureGuard: false }) };
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
  // 后台 detail 的退出码行是 N5 既有键 `exit code: {code}`（text.js 的 detail.exitCode，
  // 无方括号）；带方括号的 `[exit code: N]` 是**前台** render 标记（render.exitCode）。
  // 判据 10 只要求 note 行居尾 + 结算时刻现读（§30.7），不触碰后台首行既有格式。
  assert.ok(flippedOn.detail.startsWith('exit code: 1\n'), '退出码行在场（detail 首行，后台口径无方括号）');
  const onLines = flippedOn.detail.split('\n');
  assert.equal(onLines.at(-1).includes('Silent-failure guard:'), true, '静默行居 detail 尾部');
  assert.match(flippedOn.detail, /may have been killed at process creation/, '结算时刻读到的开关 = 开');

  // 反向：注册时刻开、结算前关 ⇒ 不产出（"下一次生效"对后台作业同样成立）。
  const conf2 = confinedCtx();
  conf2.ctx.timer.timeout = (callback) => { const h = setTimeout(callback, 0); return () => clearTimeout(h); };
  const current2 = { ...resolveConfig({ toolName: 'async_run', silentFailureGuard: true }) };
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

test('R28 判据11：b 段四组合矩阵 + 描述就地增删（不复制 c 的纪律文本）', (t) => {
  if (hostIndex === undefined) { t.skip('宿主包不可解析（离线环境），本用例跳过'); return; }
  const warnAnchor = /can die silently at process creation/;
  // (执行器在场 × 开关开) 才拼——四组合。
  const on = confinedCtx();
  assert.match(
    createRunTool(on.ctx, resolveConfig({ toolName: 'async_run', silentFailureGuard: true })).description,
    warnAnchor, '有执行器 + 开 ⇒ b 段在场');
  const off = confinedCtx();
  assert.doesNotMatch(
    createRunTool(off.ctx, resolveConfig({ toolName: 'async_run', silentFailureGuard: false })).description,
    warnAnchor, '有执行器 + 关 ⇒ 不拼');
  const plainOn = fakeCtx();
  plainOn.installShellExecute(() => Promise.resolve(fakeProc({ text: 'ok' }).proc));
  assert.doesNotMatch(
    createRunTool(plainOn.ctx, resolveConfig({ toolName: 'async_run', silentFailureGuard: true })).description,
    warnAnchor, '无执行器 + 开 ⇒ 不拼（不给走不通的指引）');
  const plainOff = fakeCtx();
  plainOff.installShellExecute(() => Promise.resolve(fakeProc({ text: 'ok' }).proc));
  assert.doesNotMatch(
    createRunTool(plainOff.ctx, resolveConfig({ toolName: 'async_run', silentFailureGuard: false })).description,
    warnAnchor, '无执行器 + 关 ⇒ 不拼');
  // b 段不得复制 c 的纪律文本（需求"不复制 c"条款）。
  assert.doesNotMatch(
    createRunTool(on.ctx, resolveConfig({ toolName: 'async_run', silentFailureGuard: true })).description,
    /Execution discipline for this deployment/, 'b 是紧凑警示段，不是纪律段复制');

  // 就地增删：活视图翻转 + refreshToolDescriptions 重建（R10/R21 volatile 链的行为差异面）。
  const flip = confinedCtx();
  const current = { ...resolveConfig({ toolName: 'async_run', silentFailureGuard: false }) };
  const view = new Proxy({}, { get: (_target, key) => current[key] });
  const tool = createRunTool(flip.ctx, view);
  assert.doesNotMatch(tool.description, warnAnchor, '初始关');
  current.silentFailureGuard = true;
  refreshToolDescriptions(tool, view);
  assert.match(tool.description, warnAnchor, '翻转开 + refresh ⇒ 警示段出现（不重启）');
  current.silentFailureGuard = false;
  refreshToolDescriptions(tool, view);
  assert.doesNotMatch(tool.description, warnAnchor, '翻转关 + refresh ⇒ 警示段消失');
});

test('R28 判据12：c 段经 ctx.inject 注册 systemPrompt，文本每次组稿现读快照', (tc) => {
  if (hostHalf === undefined) { tc.skip('宿主包不可解析（离线环境），本用例跳过'); return; }
  const f = fakeCtx();
  const injectFns = new Map();
  const injectLists = [];
  const effects = [];
  // fakeCtx 没有 inject/effect——宿主面接线在此补（先例：T12 对 settings.js 的补法）。
  // R30 起 applyHostHalf 注册**两个**子 scope（systemPrompt + ask 接线）——按服务单
  // 捕获，systemPrompt 仍只注册一次。
  f.ctx.inject = (list, fn) => { injectLists.push(list); injectFns.set(list.join(','), fn); };
  f.ctx.effect = (dispose) => { effects.push(dispose); };
  applyHostHalf(f.ctx, resolveConfig({ silentFailureGuard: false }));
  assert.equal(effects.length, 2, '快照源 + R30 ask 接线两个处置器挂到 ctx.effect');
  assert.deepEqual(injectLists, [['systemPrompt'], ['sessions', 'sessionProjections', 'agents']],
    'R28 c 段仍是 systemPrompt 单服务子 scope；R30 ask 接线另立三服务子 scope');

  const entry = {};
  injectFns.get('systemPrompt')({ systemPrompt: { context: (e) => { Object.assign(entry, e); } } });
  assert.equal(entry.name, 'async-tools:discipline', '段名命名空间化（sandbox:policy 成例）');
  assert.equal(entry.order, 130, '段序 130（内置三名的 110/115/120 之后）');
  assert.equal(typeof entry.text, 'function', 'text 是函数——每次组稿现求');

  // 关：首播快照就是关 ⇒ 空串（段本体不注销，渲染层过滤空串段）。
  assert.equal(entry.text(), '', '快照 guard=false ⇒ 空串');
  // 快照缺席（宿主行卸载后）⇒ 失效安全方向 = 关，不抛错。
  clearSnapshot();
  assert.equal(entry.text(), '', '快照缺席 ⇒ 空串，不抛');
  // 开 + en：E2E 逐字锚句必须与词典键一致。
  seedSnapshot(resolveConfig({ silentFailureGuard: true, agentLang: 'en' }));
  const en = entry.text();
  assert.equal(en, t('en', 'discipline.block'), 'en 段文本 = 词典键逐字（真机验收锚句同源）');
  assert.match(en, /run it once as a bare call/);
  assert.match(en, /killed at process creation/);
  assert.match(en, /4294967295/, '陷阱 13 判别特征在场');
  assert.match(en, /-Width/, '陷阱 13 纪律：改写法');
  // 开 + zh：agentLang 现行档决定语言。
  seedSnapshot(resolveConfig({ silentFailureGuard: true, agentLang: 'zh' }));
  const zh = entry.text();
  assert.equal(zh, t('zh', 'discipline.block'), 'zh 段文本 = 词典键逐字');
  assert.match(zh, /裸调用重试一次/);
  assert.match(zh, /进程创建层被杀/);
  assert.match(zh, /4294967295/);
  // 复位模块级快照（test:inproc 下共享单例，不得泄漏到其它套件）。
  clearSnapshot();
});

test('R28 判据13：设置面 16 字段逐项在场 + flag spec 矩阵 + resolveConfig 归一', async () => {
  // —— 键集身份核对：FIELDS = 预算 + 语言 + 开关 + 提问四组之和（顺序也一致；
  // R30 起开关组 2 枚、ASK 组 2 枚，13 → 16）。
  const expectedKeys = [...BUDGET_FIELD_KEYS, ...LANG_FIELD_KEYS, ...FLAG_FIELD_KEYS, ...ASK_FIELD_KEYS];
  assert.equal(expectedKeys.length, 16, '16 = 10 预算 + 2 语言 + 2 开关 + 2 提问');
  assert.equal(FLAG_FIELD_KEYS.length, 2);
  assert.equal(FLAG_FIELD_KEYS[0], 'silentFailureGuard');
  assert.equal(FLAG_FIELD_KEYS[1], 'askTakeover');
  assert.deepEqual(ASK_FIELD_KEYS, ['askTimeoutMs', 'askUiSeat']);

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
    '设置卡 16 项逐项在场（缺一项即红，不只数个数）');
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

  // —— resolveConfig 归一（§30.1：严格 true 才开；缺省/垃圾一律关）。
  assert.equal(resolveConfig({ silentFailureGuard: true }).silentFailureGuard, true);
  assert.equal(resolveConfig({ silentFailureGuard: false }).silentFailureGuard, false);
  assert.equal(resolveConfig({}).silentFailureGuard, false, '缺省 ⇒ 关（默认关裁定）');
  assert.equal(resolveConfig({ silentFailureGuard: 'yes' }).silentFailureGuard, false,
    '落盘垃圾值收敛到关（schema 层 .loose()：校验失败回 default，失效安全方向与默认一致）');
  assert.equal(resolveConfig({ silentFailureGuard: 1 }).silentFailureGuard, false,
    '数字 1 也不是 true——严格布尔');
  assert.equal(resolveConfig({ silentFailureGuard: null }).silentFailureGuard, false, 'null 回默认');
  // volatile 活 Ref 入口（真机链：loader 就地提交原地改写的就是这个形状）。
  assert.equal(resolveConfig({ silentFailureGuard: { get: () => true } }).silentFailureGuard, true,
    'Ref 形态解包后归一');
  assert.equal(resolveConfig({ silentFailureGuard: { get: () => 'yes' } }).silentFailureGuard, false,
    'Ref 里的垃圾同样收敛到关');
});
