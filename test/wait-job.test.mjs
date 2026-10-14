/**
 * `async_wait_job` 工具的单测（对应需求 §2.2.2、§6.2 与设计 §2.4）。
 *
 * 三条最关键的断言：
 * - 等待**有界**（缺 `wait_ms` 直接报错）；
 * - 插话让等待提前返回，但**绝不取消作业**，且**撤销在途等待**（awaited 语义：
 *   被结算释放的活 waiter 才算 awaited——把 waiter 留着会白吞一条本可免掉的通知）；
 * - 输出要经 `jobs.read` 的 **chunks** 拼接取得（JobRead 形状，`jobs.wait` 只给快照）；
 *   首次终态读取附带的**一次性 `result`** 必须并入同一次返回（需求 §2.2.3、设计 §2.4）。
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createWaitJobTool as buildWaitJobTool } from '../lib/wait-job.js';
import { resolveConfig } from '../lib/config.js';
import { checkedTool, fakeAgent, fakeCtx, freezeTimers, inboxPayload } from './_helpers.mjs';
import { LATE_ANSWER_EVENT } from '../lib/interrupts.js';

/**
 * 被测工具一律经 `checkedTool` 包一层：**每条**用例的返回值都会被喂给宿主输出校验器
 * （`output.schema` 是运行时才校验的，只断言字段会漏掉真机上的 INVALID_TOOL_OUTPUT）。
 */
const createWaitJobTool = (ctx, config) => checkedTool(buildWaitJobTool(ctx, config));

const config = resolveConfig({ toolName: 'async_run' });
const agent = fakeAgent();
const exec = { agent, signal: new AbortController().signal };

// 共享 fixture 的末位清理——起始检查开始读收件箱后，
// 失败用例经 inboxPayload / 起始检查用例推入的消息残留会级联污染后续用例的起始读
// （假红失真）。afterEach 清空两个待处理列表，让失败用例的红收敛到自身断言；
// 各用例尾部的显式清理行保留（幂等，保可读性）。
afterEach(() => {
  agent.inbox.nextStep.length = 0;
  agent.inbox.nextTurn.length = 0;
});

/**
 * 安装假 jobs 服务，并维护一个**有状态的**作业。
 *
 * 为什么要有状态：恒真断言的风险——探针若装在被测代码根本不碰的方法上（如
 * `jobs.kill`），断言就永远绿。现在 `kill` 会真的推 `stopping`、`cancel` 会真的记账，
 * 断言写的是"作业还查得到、kill/cancel 一次都没被调用"，删掉保护就会变红。
 *
 * `read` 返回 `{chunks, lossy, result?, job}`（chunks 的 text 拼接即全量
 * 文本；`readResult` 选项模拟一次性 `result` 通道——只在**首次终态读取**交付，
 * 与真实注册表的 `resultDelivered` 同值）。
 * `wait` 实现双路径：`waitDelayMs > 0` 时在该延迟后 **resolve 回当时的 view**（到期不报错
 * ）；signal abort 时 reject（竞速收敛后的 raceAbort 走这条）。
 *
 * @param {object} f - fakeCtx 探针。
 * @param {object} options - `{ status, readChunks, readLossy, readResult, waitDelayMs, view }`。
 * @returns {{ waitCalls: object[], getCalls: unknown[][], readCalls: unknown[][], job: object, probes: object }} 探针。
 */
function installJobs(f, {
  status = 'running', readChunks = [{ text: 'job output', channel: 'stdout' }], readLossy = false, readResult, waitDelayMs = 0, view
} = {}) {
  const waitCalls = [];
  const getCalls = [];
  const readCalls = [];
  const listCalls = [];
  const job = { id: 'j-1', status, detail: view?.detail };
  const probes = { killCalls: 0 };
  // 一次性 result 通道的替身状态（真实注册表 resultDelivered 的投影）。
  const TERMINAL_SET = new Set(['completed', 'killed', 'failed']);
  let resultDelivered = false;
  const jobs = {
    get(id, caller) {
      getCalls.push([id, caller]);
      return { id: id ?? job.id, status: job.status, ...(job.detail === undefined ? {} : { detail: job.detail }) };
    },
    // 快照层建在 list 上（三分：缺席 = 查无、抛错 = 查询失败）。
    list(caller) {
      listCalls.push([caller]);
      return [{ id: job.id, status: job.status, ...(job.detail === undefined ? {} : { detail: job.detail }) }];
    },
    read(id, caller) {
      readCalls.push([id, caller]);
      // 替身语义：**无消费游标**——chunks 每次读取都重复交付；真实游标
      // （第二次读取无新增量）由 test/wait-job-result.test.mjs 在真实注册表上钉住。
      // result 通道按一次性交付模拟（真实注册表 resultDelivered 的投影）。
      const terminal = TERMINAL_SET.has(job.status);
      const result = readResult !== undefined && terminal && !resultDelivered ? readResult : undefined;
      if (terminal) resultDelivered = true;
      return {
        chunks: readChunks,
        lossy: readLossy,
        ...(result === undefined ? {} : { result }),
        job: { id: job.id, status: job.status }
      };
    },
    kill() {
      probes.killCalls += 1;
      if (job.status === 'running') {
        job.status = 'stopping';
        return 'requested';
      }
      return 'already-finished';
    },
    wait(jobId, timeoutMs, caller, signal) {
      waitCalls.push({ jobId, timeoutMs, caller, signal });
      return new Promise((resolve, reject) => {
        let handle;
        if (signal !== undefined) {
          if (signal.aborted) { reject(new Error('wait aborted')); return; }
          signal.addEventListener('abort', () => {
            if (handle !== undefined) clearTimeout(handle);
            reject(new Error('wait aborted'));
          }, { once: true });
        }
        if (waitDelayMs > 0) {
          handle = setTimeout(() => resolve({ id: job.id, status: job.status }), waitDelayMs);
        }
        // 否则永不自行 resolve：由测试注入插话驱动结局。
      });
    }
  };
  f.ctx.jobs = jobs;
  return { waitCalls, getCalls, readCalls, listCalls, job, probes };
}

test('async_wait_job：wait_ms 必填（等待必须有界）', async () => {
  const f = fakeCtx();
  installJobs(f);
  const tool = createWaitJobTool(f.ctx, config);
  // 第一层防线是 schema：defineTool 的参数校验直接拒绝缺失或类型错误的必填项。
  await assert.rejects(() => tool.execute({ job_id: 'j-1' }, exec), /missing required property "wait_ms"/);
  await assert.rejects(() => tool.execute({ job_id: 'j-1', wait_ms: null }, exec), /"wait_ms" must be a number/);
});

test('async_wait_job：未知作业 id 必须报错并指向 job_list', async () => {
  const f = fakeCtx();
  // 查无 = list 里缺席（get 对未知 id 也是 throw，但那与查询失败无法区分）。
  f.ctx.jobs.list = () => [];
  const tool = createWaitJobTool(f.ctx, config);
  await assert.rejects(
    () => tool.execute({ job_id: 'nope', wait_ms: 1000 }, exec),
    /unknown job "nope".*job_list/
  );
});

test('async_wait_job（0.2.0-rc.2）：jobs 调用全部带 caller=SessionId（归属栅栏）', async () => {
  const f = fakeCtx();
  const { waitCalls, listCalls, readCalls } = installJobs(f, { status: 'completed' });
  const tool = createWaitJobTool(f.ctx, config);

  await tool.execute({ job_id: 'j-1', wait_ms: 30000 }, exec);

  assert.deepEqual(listCalls[0], [agent.id], '屏障 list 必须带 SessionId caller');
  assert.deepEqual(readCalls[0], ['j-1', agent.id], '终态 read 必须带 SessionId caller');
  assert.equal(waitCalls.length, 0, '已终态时不得再等待');
});

test('async_wait_job：作业已终态 → 屏障直接返回输出，不发起等待', async () => {
  const f = fakeCtx();
  const { waitCalls } = installJobs(f, { status: 'completed', readChunks: [{ text: 'done!', channel: 'stdout' }] });
  const tool = createWaitJobTool(f.ctx, config);

  const result = await tool.execute({ job_id: 'j-1', wait_ms: 30000 }, exec);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'done!', '输出 = chunks[].text 拼接（0.2.0-rc.2 JobRead）');
  assert.equal(result.truncated, false);
  assert.equal(waitCalls.length, 0, '已终态时不得再等待');
});

test('async_wait_job（0.2.0-rc.2）：多 chunk 拼接 + lossy 前缀标记', async () => {
  const f = fakeCtx();
  installJobs(f, {
    status: 'completed',
    readChunks: [{ text: 'AAA', channel: 'stdout' }, { text: 'BBB', channel: 'stdout' }, { text: 'E', channel: 'stderr' }],
    readLossy: true
  });
  const tool = createWaitJobTool(f.ctx, config);

  const result = await tool.execute({ job_id: 'j-1', wait_ms: 30000 }, exec);
  assert.match(result.output, /^\[earlier output was partially dropped from memory\]/, 'lossy 必须有一行前缀标记');
  assert.match(result.output, /AAABBBE$/, 'chunks 按顺序拼接（含全部 channel）');
});

test('async_wait_job（0.2.0-rc.2）：stopping 是中间态 → 仍按 running 返回', async () => {
  // kill 已请求、进程未收尾：此时返回 running 句柄是对的，模型再等一次即可。
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const { waitCalls } = installJobs(f, { status: 'stopping', waitDelayMs: 5 });
  const tool = createWaitJobTool(f.ctx, config);

  const result = await tool.execute({ job_id: 'j-1', wait_ms: 5000 }, exec);
  assert.equal(result.status, 'running', 'stopping 不在终态集合里');
  assert.equal(waitCalls.length, 1);
});

test('async_wait_job（0.2.0-rc.2）：jobs.wait 超时是 resolve 回 running 视图 → 不报错，走 running 分支', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  // 让 jobs.wait 自行到期（确定性驱动），不依赖被替换的定时器。
  const { probes, readCalls } = installJobs(f, { waitDelayMs: 5 });
  const tool = createWaitJobTool(f.ctx, config);

  const result = await tool.execute({ job_id: 'j-1', wait_ms: 5000 }, exec);
  assert.equal(result.status, 'running');
  assert.equal(result.job_id, 'j-1');
  assert.match(result.note, /is still running \(unaffected\)/);
  assert.match(result.note, /j-1/);
  assert.match(result.note, /per-call wait cap is 600000 ms/, 'note 里的上限必须来自生效配置');

  // ── 信息暴露红线：**非终态分支一次都不能 `read`** ────────────────────────
  //
  // `jobs.read` 是**消费式游标**（模型游标随读推进）。预算到期轮询是
  // **可重复**的（模型会反复 `async_wait_job`），所以非终态分支若读一次，
  // 每等一轮就吃掉一段输出——最后模型拿到的是被啃过的残段。
  assert.equal(readCalls.length, 0,
    'running 分支不得调用 jobs.read：它是消费式游标，每轮等待读一次会把输出啃掉');
  assert.equal(probes.killCalls, 0);
});

test('async_wait_job（0.2.0-rc.2）：到期双源合并——本地 deadline 与 jobs.wait 的到时信号谁先到，返回体都逐字段相等', async () => {
  // 合并规则的"两路同时触发"形态：真实调度里本地 timer 与
  // jobs.wait 的到时信号几乎同拍，**谁先到都不允许改变返回体**（终态只认复查快照
  // （list 基）、waited_ms 只用本地时钟）。两腿对照，作业全程 running：
  //  腿 A（本地 deadline 先到）：不冻定时器、jobs.wait 永不自行 resolve；
  //  腿 B（jobs.wait 的到时信号先到）：冻住本地 deadline、jobs.wait 5ms 后 resolve
  //        回 running 视图（到期不报错）。
  // 判据：两腿都走 running 分支、都做终态复查、都不碰消费式 read 游标；
  // 返回体在归一化 waited_ms（连同 note 里嵌入的毫秒数）后逐字段相等。
  const fA = fakeCtx();
  const a = installJobs(fA, { waitDelayMs: 0 });
  const toolA = createWaitJobTool(fA.ctx, config);
  const resultA = await toolA.execute({ job_id: 'j-1', wait_ms: 40 }, exec);
  assert.equal(resultA.status, 'running', '腿 A：deadline 收敛，作业仍在跑 → running 分支');

  const fB = fakeCtx();
  freezeTimers(fB.ctx);
  const b = installJobs(fB, { waitDelayMs: 5 });
  const toolB = createWaitJobTool(fB.ctx, config);
  const resultB = await toolB.execute({ job_id: 'j-1', wait_ms: 40000 }, exec);
  assert.equal(resultB.status, 'running', '腿 B：jobs.wait 到期回 running 视图 → running 分支');

  assert.ok(a.listCalls.length >= 1 && b.listCalls.length >= 1,
    '两腿都必须做 jobs.list 终态复查（终态只认快照，不信任何一路信号）');
  assert.equal(a.readCalls.length, 0, '腿 A 非终态不得消费 read 游标');
  assert.equal(b.readCalls.length, 0, '腿 B 非终态不得消费 read 游标');

  const normalize = (r) => ({ ...r, waited_ms: 0, note: r.note.replace(/\d+ ms/g, 'N ms') });
  assert.deepEqual(normalize(resultA), normalize(resultB),
    '两条到时信号谁先到，返回体都必须逐字段相等（到期双源合并规则）');
});

test('async_wait_job（0.2.0-rc.2）：jobs.wait 被 abort → 竞速收敛不报错（raceAbort 的撤销路径）', async () => {
  const f = fakeCtx();
  // 注意**不冻定时器**：本用例要的就是本地 deadline 真实到期（冻住会四路全挂死）。
  // jobs.wait 装成永不自行 resolve（waitDelayMs=0）——竞速只能由本地 deadline 收敛，
  // finally 里的 raceAbort 随即 abort 在途 jobs.wait（reject 被 then(()=>…) 吞成 wait-aborted）。
  installJobs(f, { waitDelayMs: 0 });
  const tool = createWaitJobTool(f.ctx, config);
  const execShort = { agent, signal: new AbortController().signal };
  const result = await tool.execute({ job_id: 'j-1', wait_ms: 5 }, execShort);
  assert.equal(result.status, 'running', 'deadline 收敛 + jobs.wait 被 abort → running 分支，不得抛错');
});

test('async_wait_job（T2）：用户插话 → interrupted，作业一次都没被碰过', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const { waitCalls, job, probes } = installJobs(f, { waitDelayMs: 60000 });
  const tool = createWaitJobTool(f.ctx, config);

  const pending = tool.execute({ job_id: 'j-1', wait_ms: 600000 }, exec);
  // 等竞速装好再注入用户插话（steer 落点，需求 §2.1.2）。
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: 'hold on', target: 'next-step' }));

  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.match(result.note, /Wait interrupted: a user message has arrived/);
  assert.match(result.note, /job j-1 is still running in the background and is completely unaffected/);
  assert.match(result.note, /async_wait_job\(job_id="j-1", wait_ms=\.\.\.\) again/, '可复制的恢复调用');

  // ★ 核心不变量：打断**等待**不得打断**工作**。
  assert.equal(probes.killCalls, 0, 'job_kill 一次都不能被调用');
  assert.equal(job.status, 'running', '作业必须还在跑');
  assert.equal(f.ctx.jobs.get('j-1', agent.id).status, 'running', '等待返回后作业仍必须可被 get 到');

  assert.equal(waitCalls.length, 1);
  assert.equal(waitCalls[0].signal.aborted, true, '竞速结束后必须撤销在途等待（awaited 语义：留着 waiter 会吞通知）');
  assert.equal(waitCalls[0].caller, agent.id, 'jobs.wait 的 caller 必须是 SessionId');

  // 探针活性证明：这套探针**确实**能记到取消。不证明这一点，
  // 上面的 0 与"探针坏了"无法区分（这是恒真断言的风险）。
  assert.equal(f.ctx.jobs.kill('j-1'), 'requested');
  assert.equal(probes.killCalls, 1);
  assert.equal(job.status, 'stopping');
  agent.inbox.nextStep.length = 0; // 还原共享 fixture（等待入口会读它——设计 §2.2 入口扫描）
});

test('async_wait_job（R30-d 唤醒分支）：等待中迟到作答通知 → 运行句柄 + note，非 interrupted 非 settled', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const { waitCalls, job, probes } = installJobs(f, { waitDelayMs: 60000 });
  const tool = createWaitJobTool(f.ctx, config);

  const pending = tool.execute({ job_id: 'j-1', wait_ms: 600000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // 迟到作答到达（插件事件——ask-takeover 宿主半边发布，载荷含
  // agent 标识与题号；作答与忽略同形）。
  f.emit(LATE_ANSWER_EVENT, {
    agentId: agent.id, questionId: 'color', kind: 'answer', summary: 'Late answer for color: red'
  });

  const result = await pending;
  assert.equal(result.status, 'running', '唤醒交还：运行句柄——不报 interrupted、不误报 settled');
  assert.notEqual(result.status, 'interrupted');
  assert.match(result.note, /A late answer has arrived/, 'note 指明作答已到（wait.lateArrived 模板）');
  assert.match(result.note, /color/, 'note 带 summary（题号在册）');
  assert.match(result.note, /async_wait_job/, '保留 wait-again 提示（模型可继续等或先消费通知）');
  // 唤醒交还不碰作业，也照常撤销在途等待（awaited 语义同 T2）。
  assert.equal(probes.killCalls, 0, '唤醒交还不得碰作业');
  assert.equal(job.status, 'running', '作业必须还在跑');
  assert.equal(waitCalls.length, 1);
  assert.equal(waitCalls[0].signal.aborted, true, '竞速结束后仍撤销在途等待');
});

test('async_wait_job（R30 通道轮 起始检查）：作答先到、等待后开 → 立即运行句柄 + note（不空转预算）', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const { probes } = installJobs(f, { waitDelayMs: 60000 });
  const tool = createWaitJobTool(f.ctx, config);
  // 待读登记非空：作答已投递未领取（起始检查命中，无需任何事件）。
  agent.inbox.nextTurn.push({
    source: { kind: 'async-tools-late-answer', form: 'notice', summary: 'Late answer for color: red', questionId: 'color' }
  });

  const result = await tool.execute({ job_id: 'j-1', wait_ms: 600000 }, exec);
  assert.equal(result.status, 'running', '起始即命中：运行句柄，不空转等待预算');
  assert.match(result.note, /A late answer has arrived/, 'note 指明作答已到');
  assert.match(result.note, /async_wait_job/, '保留 wait-again 提示');
  assert.equal(probes.killCalls, 0, '起始检查不碰作业');
  agent.inbox.nextTurn.length = 0; // 还原共享 fixture
});

test('async_wait_job：插件通知不得被当作插话（role 陷阱）', async () => {
  const f = fakeCtx();
  installJobs(f, { waitDelayMs: 10 });
  const tool = createWaitJobTool(f.ctx, config);

  const pending = tool.execute({ job_id: 'j-1', wait_ms: 5000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 2));
  // role 是 user，但 kind 不是 —— 必须被忽略。
  f.emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'plugin', text: 'job settled' }));
  const result = await pending;

  assert.notEqual(result.status, 'interrupted', '插件通知不得打断等待');
});

test('async_wait_job：完成优先于打断——插话瞬间作业恰好终态，返回完成结果并注明', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  // 先把 jobs.wait 挂成"永不自行 resolve"，让插话先赢竞速；
  // 再让复查 get 读到 completed——这正是"完成优先于打断"要处理的真实竞态。
  const probes = installJobs(f, { waitDelayMs: 60000 });
  const tool = createWaitJobTool(f.ctx, config);

  const pending = tool.execute({ job_id: 'j-1', wait_ms: 600000 }, exec);
  await new Promise((resolve) => setTimeout(resolve, 5));
  probes.job.status = 'completed';
  probes.job.detail = 'exit code: 0';
  f.emit('agent/inbox/inserted', inboxPayload({ agent, sourceKind: 'user', text: 'done?', target: 'next-step' }));

  const result = await pending;
  assert.equal(result.status, 'completed', '终态复查胜过 interrupted——模型不该重复等待一个已完成的作业');
  assert.equal(result.output, 'job output');
  assert.match(result.detail, /a user message arrived during the wait; the job finished in the meantime/);
  agent.inbox.nextStep.length = 0; // 还原共享 fixture（等待入口会读它——设计 §2.2 入口扫描）
});

test('async_wait_job：等待路径上 wait 被结算释放 → 终态结果', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  // jobs.wait 在 10ms 后 resolve 一个 completed 视图（结算释放路径）。
  const probes = installJobs(f, { waitDelayMs: 10 });
  probes.job.status = 'completed';
  probes.job.detail = 'exit code: 0';
  const tool = createWaitJobTool(f.ctx, config);

  const result = await tool.execute({ job_id: 'j-1', wait_ms: 5000 }, exec);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'job output');
  assert.match(result.detail, /exit code: 0/);
});

test('async_wait_job：等待中途的快照查询抛错不得泄漏为工具报错', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  // 快照层是 list 基。屏障 list 正常返回 running；等待到期后的复查 list
  // 抛错（模拟瞬态）——复查失败按"没有终态证据"处理 → running 分支自愈，
  // 不把瞬态错误抛给模型（waitAgainNote 本身就是"可再次 async_wait_job"出路）。
  let listCalls = 0;
  const chunks = [{ text: 'job output', channel: 'stdout' }];
  f.ctx.jobs = {
    list() {
      listCalls += 1;
      if (listCalls === 1) return [{ id: 'j-1', status: 'running' }];
      throw new Error('transient');
    },
    read: () => ({ chunks, lossy: false, job: { status: 'running' } }),
    wait: (_id, timeoutMs, _caller, signal) => new Promise((resolve, reject) => {
      const handle = setTimeout(() => resolve({ id: 'j-1', status: 'running' }), 5);
      if (signal !== undefined) signal.addEventListener('abort', () => { clearTimeout(handle); reject(new Error('wait aborted')); }, { once: true });
    })
  };
  const tool = createWaitJobTool(f.ctx, config);

  const result = await tool.execute({ job_id: 'j-1', wait_ms: 5000 }, exec);
  assert.equal(listCalls, 2, '屏障一次 + 复查一次');
  assert.equal(result.status, 'running');
});

test('async_wait_job：描述必须带锚①与 waitDigest，且不许再出现"唯一途径"', async () => {
  const tool = buildWaitJobTool(fakeCtx().ctx, config);
  // 规则①的锚（wait 两兄弟独有；refreshToolDescriptions 靠它就地改数字）。
  assert.match(tool.description, /wait_ms is required, range 250–600000 ms\./);
  assert.match(tool.description, /Per-call wait budgets must be passed explicitly, range 250–600000 ms;/);
  // 覆盖口径句——wait_ms 约束的是总时长（快照 + 等待段）。
  assert.match(tool.description, /budget bounds the total call time: one existence snapshot plus the wait segment/,
    '覆盖口径句必须在描述里（口径：总时长 = 快照 + 等待段）');
  // 已作废的措辞不许回来。宿主的 tool-jobs 会在结算无人等待时补发完成通知
  // （`dsh-tool-jobs/lib/index.js:263-269`），"唯一途径"在新机制下是假的。
  assert.doesNotMatch(tool.description, /唯一途径|only way/, '"唯一途径"已作废，不许回到描述里');
  assert.match(tool.description, /established way/, '正确口径：既定途径');
  // wait 工具不该出现 yield_ms。
  assert.doesNotMatch(tool.description, /yield_ms/);
});

test('W-render（R11 P1）：模型可见文本必须带上 detail —— 那是找回被丢弃输出的唯一线索', () => {
  // 缺陷形态：`render` 在终态分支
  // 若只输出 `value.output`，"output partially dropped from memory; full output at <路径>"
  // 这句 `detail` **永远到不了模型眼前**。
  //
  // 为什么这种缺陷不易被发现：**模型只看得见 `render` 的输出**，结构化 `value` 不进模型上下文。
  // 只检查返回值字段的断言会把"值里有"当成"模型看得见"。
  const tool = buildWaitJobTool(fakeCtx().ctx, config);
  const paths = 'C:\\Temp\\spill\\job-1-stdout.log';

  // ① 终态分支：detail 必须出现在**渲染出来的文本**里。
  const doneText = tool.output.render({ job_id: 'j1' }, {
    status: 'completed',
    job_id: 'j1',
    waited_ms: 120,
    output: 'AAA',
    truncated: true,
    detail: `exit code: 0 (output partially dropped from memory; full output at ${paths})`
  }).map((part) => part.text).join('\n');
  assert.match(doneText, /partially dropped from memory/, 'lossy 说明必须在模型可见文本里');
  assert.match(doneText, /job-1-stdout\.log/, '落点路径必须在模型可见文本里');
  assert.match(doneText, /^AAA/, '输出本体仍要在最前面');

  // ② 没有 detail 时不得凭空多出内容（否则每次等待都会多一段废话）。
  const plainText = tool.output.render({ job_id: 'j1' }, {
    status: 'completed',
    job_id: 'j1',
    waited_ms: 120,
    output: 'AAA',
    truncated: false
  }).map((part) => part.text).join('\n');
  assert.equal(plainText, 'AAA');

  // ③ 仍无输出时退回 note（既有行为不变；样例串用英文——模型侧口径）。
  const runningText = tool.output.render({ job_id: 'j1' }, {
    status: 'running',
    job_id: 'j1',
    waited_ms: 120,
    note: 'still running'
  }).map((part) => part.text).join('\n');
  assert.equal(runningText, 'still running');
});

// ---------------------------------------------------------------------------
// 安全/健壮性/异常处理的缺陷防御判据。
// ---------------------------------------------------------------------------

test('R29-b（判据 2·入口中止）：调用进来时 signal 已 aborted → 直接 interrupted，零查询零等待', async () => {
  const f = fakeCtx();
  const { waitCalls, listCalls } = installJobs(f);
  const controller = new AbortController();
  controller.abort(new Error('pre-cancelled'));
  const tool = createWaitJobTool(f.ctx, config);

  // 对已中止的 signal 挂监听器永不触发——不短路的话这次调用会白发一次
  // 屏障查询，再等满/提前结束预算。
  const result = await tool.execute({ job_id: 'j-1', wait_ms: 30000 }, { agent, signal: controller.signal });

  assert.equal(result.status, 'interrupted');
  assert.equal(result.waited_ms, 0, '一次都没等');
  assert.match(result.note, /async_wait_job\(job_id="j-1", wait_ms=\.\.\.\)/, '可复制的恢复调用');
  assert.equal(listCalls.length, 0, '屏障 list 一次都不能发');
  assert.equal(waitCalls.length, 0, 'jobs.wait 一次都不能发');
});

test('R29-c（判据 3·屏障查询失败）：jobs.list 抛错 → 可重试的 queryFailed，不得误报 unknown job', async () => {
  const f = fakeCtx();
  // 三分的关键区分：`undefined`（查询失败）≠ `null`（查无）。并入 unknownJob 会在
  // 宿主抖动时把"稍后重试就能好"的错误升级成"作业不存在"，诱发副作用重跑。
  f.ctx.jobs.list = () => { throw new Error('listing unavailable'); };
  const tool = createWaitJobTool(f.ctx, config);

  await assert.rejects(
    () => tool.execute({ job_id: 'j-1', wait_ms: 1000 }, exec),
    // 反断言用带引号的 "unknown job " 形态（unknownJob 的报错引用作业 id）；
    // queryFailed 文案末尾的澄清句 `this is not "unknown job"` 不算误报。
    (error) => /reading the job list failed/.test(error.message)
      && !/unknown job "/.test(error.message)
  );
});

test('R29-c（判据 4·读失败）：终态确认但 jobs.read 抛错 → 首行 readFailed 标记，工具不报错', async () => {
  const f = fakeCtx();
  installJobs(f, { status: 'completed' });
  f.ctx.jobs.read = () => { throw new Error('read unavailable'); };
  const tool = createWaitJobTool(f.ctx, config);

  // 读失败不是作业失败：作业确实完成了（completed），只是输出此刻读不出来。
  // 报错会让模型以为工具坏了；给出可读标记 + 空输出，模型再等一次即可重试。
  const result = await tool.execute({ job_id: 'j-1', wait_ms: 30000 }, exec);
  assert.equal(result.status, 'completed', '读失败不得改写作业终态');
  assert.match(result.output, /^\[reading the job output failed/, '输出首行必须是 readFailed 标记');
  assert.equal(result.truncated, false);
});

test('R29-a（判据 13·接线段防御）：jobs.wait 同步抛错 → 监听器与定时器必须全部被处置', async () => {
  const f = fakeCtx();
  installJobs(f, { status: 'running', waitDelayMs: 0 });
  const baseline = f.count('agent/inbox/inserted');
  // 定时器处置计数：每个武装的 timeout 必须恰有一个撤销。
  let armed = 0;
  let disarmed = 0;
  const realTimeout = f.ctx.timer.timeout;
  f.ctx.timer.timeout = (callback, ms) => {
    armed += 1;
    const clear = realTimeout(callback, ms);
    return () => { disarmed += 1; clear(); };
  };
  // 模拟接线中途炸：watchUserInterrupt 成功、deadline 定时器创建后，jobs.wait 抛出。
  const realWait = f.ctx.jobs.wait;
  f.ctx.jobs.wait = () => { throw new Error('wait wiring exploded'); };
  const tool = createWaitJobTool(f.ctx, config);

  await assert.rejects(() => tool.execute({ job_id: 'j-1', wait_ms: 5000 }, exec), /wait wiring exploded/);
  assert.equal(f.count('agent/inbox/inserted'), baseline,
    'interrupt.dispose() 必须在 finally 里跑——接线中途抛错后监听器残留 = 事件泄漏（每条用户消息都会触发已死的等待）');
  assert.equal(armed, 1, '接线段武装过一个 deadline 定时器');
  assert.equal(disarmed, armed, 'finally 必须撤销每一个已武装的定时器（漏一个 = 空转句柄泄漏）');

  // 探针活性：wait 修好后同一路径能正常走完（证明上面的 reject 是注入的错，不是环境错）。
  f.ctx.jobs.wait = realWait;
  const result = await tool.execute({ job_id: 'j-1', wait_ms: 5 }, exec);
  assert.equal(result.status, 'running');
});

// ── 起始检查（设计 §2.2 消息集合和入口扫描的工具级落点） ──

/** 挂起护栏：起始检查被拆掉（纯事件驱动回潮）时用例必须红得快，不是挂死套件。 */
const HANG_MARKER = { status: '__test-hang__' };
function withHangGuard(pending) {
  return Promise.race([
    pending,
    new Promise((resolve) => { setTimeout(() => resolve(HANG_MARKER), 250); })
  ]);
}

test('R55（判据 1）：等待开始时 next-step 已有 user 插话 → 立即 interrupted，不接线不创建 waiter', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const probes = installJobs(f, { status: 'running', waitDelayMs: 0 });
  agent.inbox.nextStep.push({ id: 'steer-1', source: { kind: 'user' } });
  const tool = createWaitJobTool(f.ctx, config);

  const result = await withHangGuard(tool.execute({ job_id: 'j-1', wait_ms: 600000 }, exec));
  assert.notEqual(result.status, '__test-hang__', '起始检查必须立即返回——纯事件驱动回潮（挂到预算耗尽）本身就是红');
  assert.equal(result.status, 'interrupted');
  // 总截止在参数解析处武装（含本次），waited_ms 是墙钟噪声而非预算消耗；
  // 满载机器上同步段也可能花 1ms——不变量是"立即返回"（毫秒级），不是严格 0。
  assert.ok(result.waited_ms < 25, `起始命中必须立即返回（实得 ${String(result.waited_ms)} ms）`);
  assert.match(result.note, /Wait not started: a user message had already arrived/, 'note 按起始命中措辞（到达时点在等待开始前）');
  assert.match(result.note, /still running in the background and is completely unaffected/);
  assert.match(result.note, /async_wait_job/);

  // 停点断言：排在接线之前——不创建 jobs.wait waiter（不吞完成通知）。
  assert.equal(probes.waitCalls.length, 0, '起始命中路径不得创建 waiter——留着会吞掉本可免掉的完成通知');
  agent.inbox.nextStep.length = 0; // 还原共享 fixture
});

test('R55（判据 2·负面对照一）：next-step 滞留的是转达/结算/迟到作答 → 不打断，迟到作答照旧唤醒', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  installJobs(f, { status: 'running', waitDelayMs: 0 });
  agent.inbox.nextStep.push(
    { id: 'relay-1', source: { kind: 'agent-message', form: 'relay' } },
    { id: 'settle-1', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-9' } },
    { id: 'late-1', source: { kind: 'async-tools-late-answer', form: 'notice', summary: 'Late answer for color: red', questionId: 'color' } }
  );
  const tool = createWaitJobTool(f.ctx, config);

  const result = await tool.execute({ job_id: 'j-1', wait_ms: 600000 }, exec);
  assert.equal(result.status, 'running', '三类非 user 消息都不命中起始检查——迟到作答起始检查立即唤醒交还');
  assert.match(result.note, /A late answer has arrived/, '迟到作答照旧走其唤醒分支（R30-d 不回归）');
  agent.inbox.nextStep.length = 0; // 还原共享 fixture
});

test('R55（判据 3·负面对照二）：next-turn 排队 user 消息、next-step 干净 → 不打断（R12 不回归）', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const probes = installJobs(f, { status: 'running', waitDelayMs: 10 });
  agent.inbox.nextTurn.push({ id: 'queued-1', source: { kind: 'user' } });
  const tool = createWaitJobTool(f.ctx, config);

  const pending = tool.execute({ job_id: 'j-1', wait_ms: 600000 }, exec);
  // 接线段在首个 await 前同步完成（jobs.wait 已挂 10 ms 定时器）——此刻同步
  // 翻终态，早于任何定时器触发（Windows 定时器粗粒度下 sleep-再翻不可靠）。
  assert.equal(probes.waitCalls.length, 1, '等待照常武装');
  probes.job.status = 'completed';
  probes.job.detail = 'exit code: 0';
  const result = await pending;
  assert.equal(result.status, 'completed', '排队消息不打断；等待由结算释放正常收场');
  agent.inbox.nextTurn.length = 0; // 还原共享 fixture
});

test('R55（判据 5）：作业已终态 + 先到插话并存 → 完成结果（结束优先于打断，入口侧）', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const probes = installJobs(f, { status: 'completed', waitDelayMs: 0 });
  probes.job.detail = 'exit code: 0';
  agent.inbox.nextStep.push({ id: 'steer-1', source: { kind: 'user' } });
  const tool = createWaitJobTool(f.ctx, config);

  const result = await tool.execute({ job_id: 'j-1', wait_ms: 600000 }, exec);
  assert.equal(result.status, 'completed', '屏障终态判定先于起始检查——先到插话不得压过已完成的作业');
  assert.equal(result.output, 'job output');
  assert.equal(probes.waitCalls.length, 0, '终态走屏障既有线，不接线');
  agent.inbox.nextStep.length = 0; // 还原共享 fixture
});

// ---------------------------------------------------------------------------
// 一次性交付（需求 §2.2.3、设计 §2.4）：首次终态读取附带的最终 result 必须并入同一次
// 返回；分隔规则与宿主 readBody 一致；全部断言用**精确文本比较**（宽松 contains
// 盖不住分隔错误）。真实注册表层的判据在 test/wait-job-result.test.mjs。
// ---------------------------------------------------------------------------

test('R57（屏障已终态·分隔三分）：result 并入同一次返回——增量与 result 之间的分隔精确断言', async () => {
  // 分支 a：增量非空且不以换行结尾 → 中间恰一个换行。
  const fA = fakeCtx();
  installJobs(fA, { status: 'completed', readChunks: [{ text: 'partial line', channel: 'stdout' }], readResult: 'FINAL' });
  const toolA = createWaitJobTool(fA.ctx, config);
  const a = await toolA.execute({ job_id: 'j-1', wait_ms: 30000 }, exec);
  assert.equal(a.status, 'completed');
  assert.equal(a.output, 'partial line\nFINAL', '非换行结尾的增量与 result 之间恰一个换行');
  assert.equal(a.truncated, false);

  // 分支 b：增量以换行结尾 → 不追加第二个换行。
  const fB = fakeCtx();
  installJobs(fB, { status: 'completed', readChunks: [{ text: 'done\n', channel: 'stdout' }], readResult: 'FINAL' });
  const toolB = createWaitJobTool(fB.ctx, config);
  const b = await toolB.execute({ job_id: 'j-1', wait_ms: 30000 }, exec);
  assert.equal(b.output, 'done\nFINAL', '增量已以换行结尾——不补分隔');

  // 分支 c：无增量 → result 直接是输出（无分隔）。
  const fC = fakeCtx();
  installJobs(fC, { status: 'completed', readChunks: [], readResult: 'FINAL' });
  const toolC = createWaitJobTool(fC.ctx, config);
  const c = await toolC.execute({ job_id: 'j-1', wait_ms: 30000 }, exec);
  assert.equal(c.output, 'FINAL', '仅 result 在场——无分隔直接输出');
});

test('R57（等待覆盖结算）：竞速由结算释放 → result 并入同一次返回（第二分支）', async () => {
  const f = fakeCtx();
  freezeTimers(f.ctx);
  const probes = installJobs(f, {
    status: 'running',
    waitDelayMs: 10,
    readChunks: [{ text: 'log line\n', channel: 'log' }],
    readResult: 'FINAL'
  });
  const tool = createWaitJobTool(f.ctx, config);
  const pending = tool.execute({ job_id: 'j-1', wait_ms: 5000 }, exec);
  assert.equal(probes.waitCalls.length, 1, '等待已武装');
  probes.job.status = 'completed';
  probes.job.detail = '0 agents';
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'log line\nFINAL', '等待路径的终态读取同样并入一次性 result');
});

test('R29-c（判据 3·复查失败）：到期后的复查查询抛错 → 状态未证实文案，不宣称"仍在运行"', async () => {
  const f = fakeCtx();
  // 入口快照证实 running；等待期间无事件；到期瞬间的复查（jobs.list 第二次
  // 调用）抛错——状态未证实，note 不得再写 "is still running"（需求 §2.2.2：
  // 无法证实时不得把状态写成确定事实）。
  const probes = installJobs(f, { status: 'running', waitDelayMs: 0 });
  const realList = f.ctx.jobs.list.bind(f.ctx.jobs);
  let listCalls = 0;
  f.ctx.jobs.list = (...a) => {
    listCalls += 1;
    if (listCalls >= 2) throw new Error('list blew up at recheck');
    return realList(...a);
  };
  const tool = createWaitJobTool(f.ctx, resolveConfig({ toolName: 'async_run', minWaitMs: 250 }));

  const result = await tool.execute({ job_id: 'j-1', wait_ms: 300 }, exec);

  assert.equal(result.status, 'running');
  assert.equal(listCalls >= 2, true, '复查确实发起过（前提成立）');
  assert.match(result.note, /unverified/i, '复查失败必须明说状态未证实');
  assert.doesNotMatch(result.note, /is still running \(unaffected\)/, '不得宣称"仍在运行"');
  assert.match(result.note, /async_wait_job\(job_id="j-1"/, '重试出路必须指向本工具');
});

test('R29-c（判据 3·复查空表）：到期复查作业已不在清单 → 未证实文案，不宣称"仍在运行"', async () => {
  const f = fakeCtx();
  // 入口快照证实 running；到期复查（jobs.list 第二次调用）返回空表——作业已
  // 从可见清单消失（如属主处置中途移除）：与查询失败同档，note 不得写
  // "is still running"（需求 §2.2.2——清单里没有它，"仍在运行"就没有证据）。
  installJobs(f, { status: 'running', waitDelayMs: 0 });
  const realList = f.ctx.jobs.list.bind(f.ctx.jobs);
  let listCalls = 0;
  f.ctx.jobs.list = (...a) => {
    listCalls += 1;
    if (listCalls >= 2) return [];
    return realList(...a);
  };
  const tool = createWaitJobTool(f.ctx, resolveConfig({ toolName: 'async_run', minWaitMs: 250 }));

  const result = await tool.execute({ job_id: 'j-1', wait_ms: 300 }, exec);

  assert.equal(result.status, 'running');
  assert.equal(listCalls >= 2, true, '复查确实发起过（前提成立）');
  assert.match(result.note, /unverified/i, '复查查无此作业必须明说状态未证实');
  assert.doesNotMatch(result.note, /is still running \(unaffected\)/, '不得宣称"仍在运行"');
  assert.match(result.note, /no longer listed/, 'note 点出作业已不在可见清单');
});

test('R57（一次性·不重复）：交付后的再次读取不得重复 result；无 result 的读取输出不变', async () => {
  const f = fakeCtx();
  installJobs(f, { status: 'completed', readChunks: [{ text: 'out', channel: 'stdout' }], readResult: 'FINAL' });
  const tool = createWaitJobTool(f.ctx, config);
  const first = await tool.execute({ job_id: 'j-1', wait_ms: 30000 }, exec);
  assert.equal(first.output, 'out\nFINAL', '首次终态读取交付 result');
  const second = await tool.execute({ job_id: 'j-1', wait_ms: 30000 }, exec);
  assert.equal(second.status, 'completed');
  assert.equal(second.output, 'out', 'result 只随首次终态读取交付——第二次不再拼接');
});

test('R57（空 result）：result 为空串且无增量 → 输出恰为空串', async () => {
  const f = fakeCtx();
  installJobs(f, { status: 'completed', readChunks: [], readResult: '' });
  const tool = createWaitJobTool(f.ctx, config);
  const result = await tool.execute({ job_id: 'j-1', wait_ms: 30000 }, exec);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, '', '空 result 与空增量的合并是空串');
  assert.equal(result.truncated, false);
});

test('R57（空 result × 非空增量）：空串 result 视为在场——分隔照补，判定口径是 undefined 同一性', async () => {
  const f = fakeCtx();
  installJobs(f, { status: 'completed', readChunks: [{ text: 'out', channel: 'stdout' }], readResult: '' });
  const tool = createWaitJobTool(f.ctx, config);
  const result = await tool.execute({ job_id: 'j-1', wait_ms: 30000 }, exec);
  assert.equal(result.output, 'out\n', '空串 result 在场：增量非换行结尾仍补恰一个换行（falsy 判定会漏掉这个分隔）');
});

test('R57（超长）：合并后的完整文本走 maxResultChars 裁剪——保头尾、标省略量、truncated 置真', async () => {
  const f = fakeCtx();
  installJobs(f, {
    status: 'completed',
    readChunks: [{ text: 'X'.repeat(40), channel: 'stdout' }],
    readResult: 'Y'.repeat(80)
  });
  // 合并文本 = 40 X + 1 换行 + 80 Y = 121 字符，上限 60：头 36 + 标注 + 尾 24（省略 61）。
  const cfg = resolveConfig({ toolName: 'async_run', maxResultChars: 60 });
  const tool = createWaitJobTool(f.ctx, cfg);
  const result = await tool.execute({ job_id: 'j-1', wait_ms: 30000 }, exec);
  assert.equal(result.truncated, true, '合并后超限必须置 truncated');
  assert.equal(
    result.output,
    `${'X'.repeat(36)}\n\n[output truncated: 61 chars omitted]\n\n${'Y'.repeat(24)}`,
    '裁剪对象是「增量＋result」的合并后完整文本（保头尾，超长 result 同样被裁）'
  );
});

test('R57（lossy）：lossy 前缀仍排最前，其后是增量与 result 的合并', async () => {
  const f = fakeCtx();
  installJobs(f, {
    status: 'completed',
    readChunks: [{ text: 'tail out', channel: 'stdout' }],
    readLossy: true,
    readResult: 'FINAL'
  });
  const tool = createWaitJobTool(f.ctx, config);
  const result = await tool.execute({ job_id: 'j-1', wait_ms: 30000 }, exec);
  assert.equal(
    result.output,
    '[earlier output was partially dropped from memory]\ntail out\nFINAL',
    'lossy 前缀第一行；增量与 result 的合并紧随其后'
  );
});

test('R57（读失败）：read 抛错 → 首行标记、一次性通道未被消费，下一次成功读取仍可交付', async () => {
  const f = fakeCtx();
  let failFirst = true;
  const chunks = [{ text: 'out', channel: 'stdout' }];
  f.ctx.jobs = {
    list: () => [{ id: 'j-1', status: 'completed', detail: '0 agents' }],
    read() {
      if (failFirst) {
        failFirst = false;
        throw new Error('read unavailable');
      }
      return { chunks, lossy: false, result: 'FINAL', job: { id: 'j-1', status: 'completed' } };
    },
    wait: () => new Promise(() => {})
  };
  const tool = createWaitJobTool(f.ctx, config);

  const first = await tool.execute({ job_id: 'j-1', wait_ms: 30000 }, exec);
  assert.equal(first.status, 'completed', '读失败不得改写作业终态');
  assert.equal(
    first.output,
    '[reading the job output failed; the output below is empty — call async_wait_job again to retry]',
    '读失败时本返回只有读失败标记（精确文本）'
  );

  const second = await tool.execute({ job_id: 'j-1', wait_ms: 30000 }, exec);
  assert.equal(second.output, 'out\nFINAL', '读失败不消费一次性通道——result 留待下一次成功的终态读取');
});
