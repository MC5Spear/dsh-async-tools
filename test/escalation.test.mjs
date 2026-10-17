/**
 * `async_run` 单次提权的单测（需求 §6.1 单次提权安全红线）。
 *
 * ## 这条需求修的是什么
 *
 * 补齐前本工具**没有提权通道**：受限会话里任何"需要启动外部程序"的命令都在
 * **进程创建层**被拒，而结果里既没有沙箱标记、也没有同轮提示，模型看不到任何可自纠的线索。
 *
 * ## 每条判据各挡什么（避免"看着都在、其实没验到"）
 *
 * | 用例 | 挡的缺陷形态 |
 * |---|---|
 * | 参数表**只在有约束执行器时**才声明两个键 | 没沙箱还声明 ⇒ 给模型一个永远失败的杠杆 |
 * | 两键必须成对、justification 非空 | schema 表达不了的约束；半截请求会变成无理由的审批弹窗 |
 * | **先问审批、再启动进程**（顺序） | 先启动就等于"先斩后奏"，审批成了装饰 |
 * | 获批的模式**只应用到这一次调用** | 提权泄漏到后续调用 = 永久加宽，比不提权更糟 |
 * | 拒绝 / 取消 / 缺审批服务 → **抛出且不启动进程** | 静默降级成"按原模式跑"会让用户以为已授权 |
 * | 沙箱拒绝时产出**标记 + 同轮提示** | 这正是原故障"模型没有任何线索"的直接修补 |
 * | 让出后的作业结局**同样带标记** | 只在完成分支给标记，"让出后才发现被拒"仍然没线索 |
 */
import assert from 'node:assert/strict';
import { hostTestFor, loadOfflineSafe } from './_host-gate.mjs';
import { resolveConfig } from '../lib/config.js';
import { checkedTool, fakeAgent, fakeCtx, fakeProc } from './_helpers.mjs';

// 宿主链动态守卫（lib/jobs.js → dsh-tools/ask-takeover）：离线形态锚缺席时
// 本文件仍可加载，全部用例自跳过并打印理由（ci.yml offline 作业的契约）。
const jobsModule = await loadOfflineSafe('../lib/jobs.js');
const { createRunTool: buildRunTool } = jobsModule ?? {};
const hostTest = await hostTestFor('../lib/jobs.js');

const createRunTool = (ctx, config) => checkedTool(buildRunTool(ctx, config));
const config = resolveConfig({ toolName: 'async_run' });
const exec = { agent: fakeAgent(), callId: 'call_ESC_1', signal: new AbortController().signal };

/**
 * 造一个"约束型执行器 + 可编排的审批服务"的上下文。
 *
 * @param {string} outcome - `approval.request` 的返回值（`allowed-once` / `rejected` / `cancelled` / `unavailable`）。
 * @param {object} [options] - `{ omitApproval: boolean }`：不给审批服务，验"缺服务"路径。
 * @returns {object} `{ f, asks, seen, policyCalls }`。
 */
function confinedCtx(outcome = 'allowed-once', options = {}) {
  const f = fakeCtx();
  const asks = [];
  const seen = [];
  const policyCalls = [];
  // 审批那一刻"已经启动了几次进程"的快照。
  //
  // `seen` 统计的是 `shell.resolve` 的调用（resolve 之后才会 start），所以
  // `resolveCallsAtApproval === 0` 就是"审批发生在**任何执行准备之前**"的实证。
  const resolveCallsAtApproval = [];
  f.installShellResolve((request) => { seen.push(request); return request; });
  f.installShellExecute(() => Promise.resolve(fakeProc({ text: 'ok' }).proc));
  // 必须在**创建工具之前**设好：参数表在构造期读一次 `sandboxMode`。
  f.ctx.shell.sandboxMode = 'workspace-write';
  f.ctx.get = (key) => {
    if (key === 'sandboxPolicy') {
      return {
        resolve: (request) => { policyCalls.push(request); return { mode: 'workspace-write' }; }
      };
    }
    if (key === 'approval' && options.omitApproval !== true) {
      return {
        request: async (req) => {
          // 在实际问审批的这一刻记录"执行准备走到哪了"。
          resolveCallsAtApproval.push(seen.length);
          asks.push(req);
          return outcome;
        }
      };
    }
    return undefined;
  };
  return { f, asks, seen, policyCalls, resolveCallsAtApproval };
}

hostTest('R11：有约束执行器时，参数表声明 sandbox_permissions 与 justification', () => {
  const { f } = confinedCtx();
  const tool = createRunTool(f.ctx, config);
  // `defineTool` 会把参数描述表**转成 JSON Schema**，键在 `parameters.properties` 下，
  // 不在 `parameters` 顶层。若写成 `'sandbox_permissions' in tool.parameters`，
  // 断言的是 JSON Schema 的三个顶层键之一，永远为 false。
  const props = tool.parameters.properties;
  assert.ok('sandbox_permissions' in props, '有沙箱时**必须**声明，否则模型无从发起提权');
  assert.ok('justification' in props, '两个键必须成对出现');
  assert.deepEqual(props.sandbox_permissions.enum, ['workspace-write', 'danger-full-access'],
    '枚举必须是 ESCALATION_TARGETS（闭集），不能自己另立一套');
});

hostTest('R11：**没有**约束执行器时，两个键都不得出现在参数表里', () => {
  // 缺陷形态：无条件声明 ⇒ 模型在无沙箱部署里看到一个永远失败的杠杆
  // （`approveEscalation` 在没有更宽模式可去时必抛）。
  const f = fakeCtx();
  f.installShellExecute(() => Promise.resolve(fakeProc({ text: 'ok' }).proc));
  const props = createRunTool(f.ctx, config).parameters.properties;
  assert.equal('sandbox_permissions' in props, false, '无沙箱不得声明 sandbox_permissions');
  assert.equal('justification' in props, false, '无沙箱不得声明 justification');
});

hostTest('R11：sandbox_permissions 缺少 justification → 报错且**不启动进程**', async () => {
  const { f, seen } = confinedCtx();
  const tool = createRunTool(f.ctx, config);
  await assert.rejects(
    tool.execute({ command: 'x', description: 'x', sandbox_permissions: 'danger-full-access' }, exec),
    /justification/,
    '半截提权请求必须被拒——它会变成一个没有理由的审批弹窗'
  );
  assert.equal(seen.length, 0, '参数非法时**一个进程都不许启动**');
});

hostTest('R11：justification 缺 sandbox_permissions → 同样报错（反向配对）', async () => {
  const { f, seen } = confinedCtx();
  const tool = createRunTool(f.ctx, config);
  await assert.rejects(
    tool.execute({ command: 'x', description: 'x', justification: '因为需要' }, exec),
    /sandbox_permissions/,
    '理由不能单独出现——它驱动不了任何东西'
  );
  assert.equal(seen.length, 0);
});

hostTest('R11：justification 是空白串 → 报错（非空句子是硬要求）', async () => {
  const { f, seen } = confinedCtx();
  const tool = createRunTool(f.ctx, config);
  await assert.rejects(
    tool.execute({
      command: 'x', description: 'x', sandbox_permissions: 'danger-full-access', justification: '   '
    }, exec),
    /non-empty/,
  );
  assert.equal(seen.length, 0);
});

hostTest('R11：**先问审批、再启动进程**——审批发生在进程创建之前', async () => {
  const { f, asks, seen, resolveCallsAtApproval } = confinedCtx('allowed-once');
  const tool = createRunTool(f.ctx, config);
  await tool.execute({
    command: 'node script.mjs', description: 'run node',
    sandbox_permissions: 'danger-full-access', justification: '这条命令要启动外部程序'
  }, exec);

  assert.equal(asks.length, 1, '必须恰好问一次审批');
  assert.equal(seen.length, 1, '获批后必须真的启动进程');
  // ## 顺序断言（这一条才是"顺序"的判据）
  //
  // 若只断言了事后计数 + reason 文本，注释却写着"用审批那一刻还没有任何 resolve
  // 记录表达顺序"——**那段断言根本不存在**。后果：把审批整体挪到 `ctx.shell.start()` 之后，
  // 那几条断言**全绿**。
  //
  // 判据在**审批那一刻**取快照：`resolveCallsAtApproval[0]` 必须是 0，
  // 也就是"还没为这次调用做任何执行准备"。审批后置的实现会让它是 1，从而变红。
  assert.deepEqual(resolveCallsAtApproval, [0],
    '审批必须在**任何执行准备之前**发生；这里应恰有一次审批、且那一刻 resolve 调用数为 0');
  assert.equal(asks[0].toolName, 'async_run', '审批请求的 toolName 必须是本工具');
  assert.equal(asks[0].callId, 'call_ESC_1', 'callId 必须透传，否则审批无法与调用对上');
  assert.match(asks[0].reason, /escalate sandbox to danger-full-access/, '理由必须写明目标模式');
  assert.match(asks[0].reason, /这条命令要启动外部程序/, '用户给的那句话必须在审批理由里');
});

hostTest('R11/R32-a：调用**没有 agent** 时在入口被拒，零审批零进程', async () => {
  // 五种失败情形：非严格加宽 / 缺审批服务 / **无 agent** / 拒绝 / 取消。
  // "无 agent"必须有专门用例——否则 `approveEscalation` 的 agent 分支被改坏也全绿。
  //
  // 无 agent 语境在 async_run **入口**就被拒（作业必须归属 owner，
  // 无主作业对任意 caller 可见且收不到完成通知）——审批路由的"无收件人"分支
  // 对 agentless 调用不再可达，本用例改验入口关卡：拒绝更早、信息更准（指出用
  // 内置 pwsh），且同样零审批请求、零进程。
  const { f, asks, seen } = confinedCtx('allowed-once');
  const tool = createRunTool(f.ctx, config);
  const agentless = { callId: 'call_ESC_NOAGENT', signal: new AbortController().signal };

  await assert.rejects(
    tool.execute({
      command: 'x', description: 'x',
      sandbox_permissions: 'danger-full-access', justification: '无 agent 的调用'
    }, agentless),
    /no agent context|没有 agent 语境/,
  );
  assert.equal(asks.length, 0, '入口即拒：不该发出审批请求');
  assert.equal(seen.length, 0, '更不能启动进程');
});

hostTest('R11：获批的模式只作用于**这一次调用**，不写回既有策略', async () => {
  const { f, seen } = confinedCtx('allowed-once');
  const tool = createRunTool(f.ctx, config);
  await tool.execute({
    command: 'a', description: 'a',
    sandbox_permissions: 'danger-full-access', justification: '一次性的提权'
  }, exec);
  assert.equal(seen[0].sandboxPolicy.mode, 'danger-full-access', '提权必须带进本次执行规格');

  // 第二次**不带**提权参数：模式必须回到会话当前策略。
  await tool.execute({ command: 'b', description: 'b' }, exec);
  assert.equal(seen[1].sandboxPolicy.mode, 'workspace-write',
    '提权泄漏到后续调用 = 永久加宽，比不提权更糟');
});

hostTest('R11：未提权时带上会话当前策略（不是无约束执行）', async () => {
  const { f, seen } = confinedCtx();
  const tool = createRunTool(f.ctx, config);
  await tool.execute({ command: 'x', description: 'x' }, exec);
  assert.equal(seen[0].sandboxPolicy.mode, 'workspace-write', '不提权 ≠ 放开约束');
});

hostTest('R11：用户拒绝 → 抛出且**不启动进程**', async () => {
  const { f, seen } = confinedCtx('rejected');
  const tool = createRunTool(f.ctx, config);
  await assert.rejects(
    tool.execute({
      command: 'x', description: 'x',
      sandbox_permissions: 'danger-full-access', justification: '想要更宽'
    }, exec),
    /rejected/,
  );
  assert.equal(seen.length, 0, '被拒绝后启动进程 = 审批形同虚设');
});

hostTest('R11：审批被取消 → 抛出且不启动进程', async () => {
  const { f, seen } = confinedCtx('cancelled');
  const tool = createRunTool(f.ctx, config);
  await assert.rejects(
    tool.execute({
      command: 'x', description: 'x',
      sandbox_permissions: 'danger-full-access', justification: '想要更宽'
    }, exec),
    /cancelled/,
  );
  assert.equal(seen.length, 0);
});

hostTest('R11：没有审批服务 → 抛出可读错误且不启动进程', async () => {
  // 这是把 `approval` 保持为**可选**服务的代价与收益：插件仍可用，只有提权这一条路被拒。
  const { f, seen } = confinedCtx('allowed-once', { omitApproval: true });
  const tool = createRunTool(f.ctx, config);
  await assert.rejects(
    tool.execute({
      command: 'x', description: 'x',
      sandbox_permissions: 'danger-full-access', justification: '想要更宽'
    }, exec),
    /no approval service is composed/,
  );
  assert.equal(seen.length, 0);
  // 不提权的调用**完全不受影响**。
  await tool.execute({ command: 'y', description: 'y' }, exec);
  assert.equal(seen.length, 1, '没有审批服务不该影响普通调用');
});

hostTest('同级与更窄目标都在启动前可读拒绝、零注册零启动（需求 §6.1）', async () => {
  // 本包口径严于宿主助手：宿主 `approveEscalation` 对**同级**免审批直接放行
  // （[0.2.0-rc.2] `dsh-sandbox/lib/index.js:101` 早退）；需求 §6.1 要求非严格
  // 加宽一律**启动前**可读拒绝——同级不是加宽请求，更窄/不在梯上同样拒绝，
  // 两类都给本包口径的双语文案，进程一个都不起。
  const { f, seen, asks } = confinedCtx('allowed-once');
  const tool = createRunTool(f.ctx, config);

  // ① 同级：可读拒绝、不弹审批、不启动。
  await assert.rejects(
    tool.execute({
      command: 'x', description: 'x',
      sandbox_permissions: 'workspace-write', justification: 'same level'
    }, exec),
    (error) => {
      assert.match(error.message, /equals this call's current sandbox mode|与本次调用的当前沙箱模式相同/,
        '同级拒绝文案必须说明「与当前模式相同、不是加宽请求」');
      return true;
    }
  );
  assert.equal(asks.length, 0, '同级不该弹审批');
  assert.equal(seen.length, 0, '同级拒绝必须零启动');

  // ② 更窄：把当前策略改成 danger-full-access，使 workspace-write 成为更窄
  // 目标——同样启动前拒绝（不依赖宿主助手对该类的报错文案）。
  const narrower = confinedCtx('allowed-once');
  narrower.f.ctx.get = (key) => {
    if (key === 'sandboxPolicy') return { resolve: () => ({ mode: 'danger-full-access' }) };
    if (key === 'approval') return { request: async (req) => { narrower.asks.push(req); return 'allowed-once'; } };
    return undefined;
  };
  const tool2 = createRunTool(narrower.f.ctx, resolveConfig({ toolName: 'async_run' }));
  await assert.rejects(
    tool2.execute({
      command: 'x', description: 'x',
      sandbox_permissions: 'workspace-write', justification: 'narrower target'
    }, exec),
    (error) => {
      assert.match(error.message, /is not strictly wider|不比本次调用的当前模式/,
        '更窄目标拒绝文案必须说明「不是严格更宽」');
      return true;
    }
  );
  assert.equal(narrower.asks.length, 0, '不该走到审批——梯判定在审批之前');
  assert.equal(narrower.seen.length, 0, '更窄拒绝必须零启动');
});

hostTest('R11：有约束但选不出更宽目标时，未声明的键仍被挡下', async () => {
  // schema 校验只查**声明过的**键，所以未声明的 `sandbox_permissions` 仍能到达 execute。
  // 这条验的正是那个"必须再挡一次"的守卫。
  const f = fakeCtx();
  const seen = [];
  f.installShellResolve((request) => { seen.push(request); return request; });
  f.installShellExecute(() => Promise.resolve(fakeProc({ text: 'ok' }).proc));
  // 执行器**不**约束：没有沙箱 ⇒ 没有可提权的目标。
  const tool = createRunTool(f.ctx, config);
  await assert.rejects(
    tool.execute({
      command: 'x', description: 'x',
      sandbox_permissions: 'danger-full-access', justification: '绕过参数表硬塞进来'
    }, exec),
    /not available in this composition/,
  );
  assert.equal(seen.length, 0);
});

hostTest('R11：沙箱拒绝时，完成分支必须产出**拒绝标记 + 同轮提权提示**', async () => {
  const { f } = confinedCtx();
  const { proc, settle } = fakeProc({ text: 'denied', exitCode: 1, status: 'running', autoResolve: false });
  // 沙箱事实是"受约束进程结算后盖章"的。
  proc.sandbox = { mode: 'workspace-write', denied: true };
  f.installShellExecute(() => Promise.resolve(proc));

  const pending = createRunTool(f.ctx, config)
    .execute({ command: 'node x.mjs', description: 'run node' }, exec);
  settle();
  const result = await pending;

  assert.match(result.note ?? '', /\[sandbox: file access denied under workspace-write mode\]/,
    '模型必须能看到拒绝标记——这是它识别"策略拒绝"而不是"命令坏了"的唯一线索');
  assert.match(result.note ?? '', /escalation available — retry this exact command once/,
    '同轮提示必须在**决定点**给出，不能指望模型记得工具描述里那段话');
});

hostTest('R11：没有沙箱执行器时**不给**提权提示（不给走不通的指引）', async () => {
  const f = fakeCtx();
  const { proc, settle } = fakeProc({ text: 'x', exitCode: 1, status: 'running', autoResolve: false });
  // 即使有人强制塞了沙箱事实，没有可提权目标时也不该提示"去提权"。
  proc.sandbox = { mode: 'workspace-write', denied: true };
  f.installShellExecute(() => Promise.resolve(proc));
  const pending = createRunTool(f.ctx, config).execute({ command: 'x', description: 'x' }, exec);
  settle();
  const result = await pending;
  assert.match(result.note ?? '', /file access denied/, '拒绝标记照给');
  assert.doesNotMatch(result.note ?? '', /escalation available/,
    '没有更宽模式可去时提示提权 = 把人引向一条走不通的路');
});

hostTest('R11：沙箱未拒绝时**不产出**任何沙箱标记（不许噪声）', async () => {
  const { f } = confinedCtx();
  const { proc, settle } = fakeProc({ text: 'fine', exitCode: 0, status: 'running', autoResolve: false });
  proc.sandbox = { mode: 'workspace-write', denied: false };
  f.installShellExecute(() => Promise.resolve(proc));
  const pending = createRunTool(f.ctx, config).execute({ command: 'x', description: 'x' }, exec);
  settle();
  const result = await pending;
  assert.doesNotMatch(result.note ?? '', /sandbox:/, '没被拒就不该出现沙箱标记');
});

hostTest('R11：让出后的作业结局**同样**带沙箱标记（"让出后才发现被拒"也是现场）', async () => {
  const { f } = confinedCtx();
  f.ctx.timer.timeout = (callback) => { const h = setTimeout(callback, 0); return () => clearTimeout(h); };
  const { proc, settle } = fakeProc({ text: 'partial', exitCode: 1, status: 'running', autoResolve: false });
  proc.sandbox = { mode: 'workspace-write', denied: true };
  f.installShellExecute(() => Promise.resolve(proc));

  const result = await createRunTool(f.ctx, config)
    .execute({ command: 'long', description: 'long', yield_ms: 1 }, exec);
  assert.equal(result.status, 'running', '应当让出并返回句柄');

  settle();
  // run(handle) 由作业注册表消费（fake 注册表在 start 里同步调用），
  // hooks.done 的 JobOutcome 自动耦合结算——从注册表视图断言沙箱标记。
  await new Promise((r) => { setTimeout(r, 0); });
  const view = f.jobsFake.views().at(-1);
  assert.equal(view.status, 'completed');
  assert.match(view.detail, /\[sandbox: file access denied under workspace-write mode\]/,
    '模型是通过 async_wait_job 读到这个 detail 的——标记不给出来，那条路就仍然没有线索');
  assert.match(view.detail, /escalation available/);
});

hostTest('R11：审批未决期间 GUI 停止 → 迟到获准仍零注册零启动（需求 §6.1 取消复查）', async () => {
  // 宿主审批契约只承诺 signal 骑在请求上（escalation.d.ts:106-107），各审批
  // 服务是否因 abort 取消请求不在本包可控范围——审批返回后必须**复查取消**：
  // 不尊重 signal 的服务在停止之后才返回 allowed-once 时，注册与启动仍为零，
  // 按取消原因拒绝（入口关卡同一口径；此刻进程未启动，抛错即诚实）。
  const f = fakeCtx();
  const seen = [];
  let grantApproval;
  f.installShellResolve((request) => { seen.push(request); return request; });
  const { proc } = fakeProc({ text: 'late', status: 'running', autoResolve: false });
  f.installShellExecute(() => Promise.resolve(proc));
  f.ctx.shell.sandboxMode = 'workspace-write';
  f.ctx.get = (key) => {
    if (key === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) };
    if (key === 'approval') {
      // 审批悬置：由测试手动放行——模拟"不尊重 signal 的审批服务"在停止之后才返回。
      return { request: () => new Promise((resolve) => { grantApproval = resolve; }) };
    }
    return undefined;
  };
  const execAbort = new AbortController();
  const execLocal = { agent: fakeAgent(), callId: 'call_B2', signal: execAbort.signal };
  const tool = createRunTool(f.ctx, config);

  const pending = tool.execute({
    command: 'x', description: 'x',
    sandbox_permissions: 'danger-full-access', justification: '审批窗口内的停止'
  }, execLocal);
  await new Promise((r) => { setTimeout(r, 5); }); // 审批挂起中
  execAbort.abort(new Error('tool call aborted')); // GUI 停止到达（审批仍未决）
  grantApproval('allowed-once'); // 审批稍后才放行

  await assert.rejects(pending, /tool call aborted/,
    '审批迟到返回不能把已取消的调用变成执行——按取消原因拒绝');
  assert.equal(seen.length, 0, '零执行：shell 解析都没走到');
  assert.equal(f.jobsFake.views().length, 0, '零注册：作业注册表没有任何视图');
});
