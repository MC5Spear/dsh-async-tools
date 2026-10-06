# 设计（dsh-async-tools）

> 本文回答"怎么做"。需求编号引 `docs/requirements.md`（R#，全部需求编号的唯一权威）。
> 上游源码引用一律写成 `[包名@版本] 文件:行号`，版本取本包 `package.json` 的 `peerDependencies`（dsh 系九包 `0.2.0-rc.2`、`cordis ~4.0.4`、`cordis-plugin-timer ~1.1.6`、`schemastery ~3.18.4`、`zod ~4.6.5`）。
> 设计推导必须能追到某条需求或某条可直接复核的源码锚点；两者都不引的段落不得存在于本文。

---

## 1. 设计目标与核心取舍

### 1.1 一句话设计

**把"一次工具调用能占多久"与"后台工作能干多久"解耦**（R1/R2/R3 的共同内核）：让每次工具调用的占用时间有界，把无界的部分移交给 dsh 既有的 job 注册表（`jobs.start` 注册的作业由注册表持有生命周期，`wait`/`read`/`kill` 都是既有服务面）。

### 1.2 三个关键取舍

| 取舍 | 选择 | 理由 |
|---|---|---|
| 是否遮蔽内置 `pwsh` | **不遮蔽**，用新工具名 + 预设隔离 | 用户已裁定方案 B；`tools.register` 的 scope 级注册会遮蔽全局同名工具，虽然可用，但会让行为改变泄漏到其他会话 |
| 让出实现方式 | **新写工具**，不动内置 | `tools/execute` 监听器改不动已冻结的 `exec.arguments`（参数在流水线早期即被 `deepFreeze`），无法"给现有 pwsh 加 yield" |
| 等待实现方式 | `async_wait_job` 用 `jobs.wait`（超时是 resolve、abort 仅在作业存活期 reject）；`async_wait_agent` 用**结算通知 + `agent/status` 转换 + 存在性查证** | `subagents` 服务没有任何等待方法；`listChildren()` 的目录条目没有 `activity`、列表只能证明存在性，故改用状态转换事件（父 scope 可实测观察到子代理的 `running → idle`） |

### 1.3 不做什么
- 不改 dsh 源码、不打补丁（R6）。
- 不实现"所有工具异步"（R3 非目标——宿主的 `tools/execute` 是 waterfall、必须拿到物化的工具结果，外挂监听器做不成"工具返回句柄、结果稍后回灌"）。
- 不读子代理会话日志或内部状态（R8）。

---

## 2. 模块划分

```
lib/
  index.js        插件入口：export name / inject / Config / apply
  config.js       Schemastery 配置 schema 与默认值、夹紧函数
  jobs.js         async_run 工具：启动命令 + 让出竞速 + 句柄形状 + 注册后的终态复查
  wait-job.js     async_wait_job 工具：jobs.wait + 插话竞速
  wait-agent.js   async_wait_agent 工具：存在性屏障（含"屏障即终态"）+ 结算事件 + 插话竞速
  agent.js        async_agent 工具：startContinuable 派生 + 立返 agent_id（§18，R13）
  interrupts.js   共用的"用户插话/子代理活动"订阅器（多路竞速的共同部件）
  output.js       结果渲染：输出裁剪、句柄文案、预算数字注入（R5）
test/
  _helpers.mjs        假件 + 输出 schema 断言助手（assertOutputShape / checkedTool）
  config.test.mjs     interrupt.test.mjs   output.test.mjs
  jobs.test.mjs       wait-job.test.mjs    wait-agent.test.mjs   agent.test.mjs
  index.test.mjs      宿主接线 + inject 静态扫描（唯一用真 cordis 的测试）
tools/
  _host-hooks.mjs / _host-resolve.mjs  开发期模块解析钩子（裸 node 跑不了宿主包）
  check-syntax.mjs 对 lib/ test/ tools/ 逐个 node --check，失败非零退出
  probe-e2e.mjs    **只做宿主接线自检**（不启动进程）；R7 的端到端在验证实例上手工执行
  probe-*.mjs      方言/形状探针，用于排查 dsh 契约问题时的现场取证
```

**依赖声明**（`inject`）：`['tools', 'jobs', 'shell', 'shellEnv', 'subagents', 'timer']`。
- `tools` 必需（`ctx.tools.register`；漏了它 apply 直接抛 `cannot get property "tools" without inject`）；
  `jobs` 必需（R1/R2）；`shell` 必需（R1）；`shellEnv` 必需（`async_run` 要把托管 `DSH_*` 交给子进程）；
  `subagents` 必需（R3）；`timer` 必需（让出/截止定时器走 `ctx.timer`）。
- 六个都是强制依赖：任一缺席时本插件进入等待而非启动。语义出处是 cordis 自己的 `inject` 实现
  （`[@deepseek-ai/cordis@~4.0.4] src/fiber.ts:611-623` 的 `_refresh` 逐个查实现、`:597-609` 的 `_checkImpl`），
  错误文案见 `[@deepseek-ai/cordis@~4.0.4] lib/index.js:676`。**`timer` 是真机补出的**：
  假件测试的 `ctx.timer` 是替身自己造的，漏声明也全绿（绿＝测试通过）。
- `ctx.get('sandboxPolicy')` 是**可选**服务，按 cordis 惯例走 `ctx.get` 而不是 `inject`。

---

## 3. 配置（`config.js`）

```js
export const Config = z.object({
  toolName:       ToolNameSchema.default('async_run'),        // 一个包被引用三次，靠它区分
  defaultYieldMs: z.number().default(20000),   // R5 / 需求 §5
  minYieldMs:     z.number().default(1000),
  maxYieldMs:     z.number().default(600000),
  defaultWaitMs:  z.number().default(30000),   // 宿主既有等待默认同值
  minWaitMs:      z.number().default(250),     // 下界与宿主/codex 量级对齐
  maxWaitMs:      z.number().default(600000),  // 宿主 maxWaitTimeoutMs 同值
  pollIntervalMs: z.number().default(500),     // async_wait_agent 的备用轮询
  maxResultChars: z.number().default(30000),   // R8；字符口径（见下）
  jobKind:        z.string().default('async-command')   // kind 运行时不被强制约束，可用自定义串
})
```

- **`maxResultChars` 的单位是字符**（`String#length`），不是字节。它只决定"模型看到多少"，
  与 `dsh-tool-jobs` 内部 `TextRetainer(maxBytes)` 的通知文案预算**不同层**。口径定为字符，与上述字节预算分层互不混淆。
- **配置里没有"是否把预算写进描述"的开关**：R5 是强制需求，描述**总是**携带生效的预算数字，因此这样一个开关永远读不到取值。数字由 `yieldDigest(config)` / `waitDigest(config)` 供数（§8）。

**夹紧函数**（纯函数，单测覆盖）：
```js
clamp(value, def, min, max) => Math.min(Math.max(value ?? def, min), max)
```
- `async_run.yield_ms` 用 `[minYieldMs, maxYieldMs]` 夹紧（缺省取 `defaultYieldMs`）。
- `async_wait_job.wait_ms` / `async_wait_agent.wait_ms` **必填**（R2/R3）；缺省时报错而非静默取默认值——因为"忘了填"应当被模型看见。夹紧到 `[minWaitMs, maxWaitMs]`。
- 配置合法性在 `apply` 时自检：`min <= def <= max`，违例直接抛（fail-fast，避免运行期行为不可预测）。

---

## 4. `async_run` 工具（R1）

### 4.1 参数
```js
{ command: string(必填), description: string(必填),
  yield_ms?: number, workdir?: string }
```

### 4.2 执行流程（R32 改写：执行即注册 + 五信号首次等待；细节与裁定见 §33）

```
1. 入口双闸：无 agent 语境 → 拒绝（error.noAgentRun，§33.2-1：无主作业对任意
   caller 可见且收不到完成通知——恢复通道断裂，诚实拒绝并指明内置 pwsh 可用）；
   exec.signal 已中止 → 抛 'tool call aborted'（宿主在 body settle 后把结果整体改写为该标准形状；已中止
   信号再挂监听永不触发，不短路会空跑一次等待）。什么都没发生：未注册、未启动。
2. 解析 workdir（相对路径按 exec.agent.session.header.cwd 解析；拿不到 cwd 就原样透传）
3. 构造 shell 请求：{ command, workdir?, dshEnv: ctx.shellEnv.collect(exec),
   sandboxPolicy?, onExpiry:'none' }
    ★ **onExpiry:'none'**（§22.1）：缺省 'kill' 会在 deadline 杀进程，与
      "让出不杀命令"正面冲突；'none' 下 timeoutMs 不装 timer。
    ★ **必须传 dshEnv**：子进程环境由 `scrubbedParentEnv()` 剔除所有 `DSH_*` 后构建，
      不传就等于把 DSH_HOME / DSH_SESSION_ID / DSH_WEB_URL 从子进程里抹掉（成例 `dsh-tool-pwsh`）。
    ★ **不传 signal**：exec 的 abort 不得杀死命令——让出后命令活在后台
      （"the handle stays valid after the caller stops waiting"）。
4. 执行即注册（R32-a，准入先于进程）：`jobs.start` 注册作业（kind/label=command
   原文/owner=SessionId/outputLimitBytes/observed 拉式源，R33 呈现面），`run(job)`
   回调里才 `ctx.shell.execute`（内置 pwsh 后台作业同款先例：进程在 starter 的 `run()` 内启动）；作业私有
   AbortController 两步 cancel（spawn 前中止归 killed，§33.1-4）。
   准入 throw → error.startRefused（单行化 + 500 截断 + 上限 + 存活清单）。
5. 首次等待 = 五信号竞速（§33.1-5）：`jobs.wait(jobId, yieldMs, owner, raceAbort)`
   一个调用承载结算/预算/abort 三成员，插话与迟到作答并入竞速；任何信号只结束
   等待，不终止命令（`jobs.wait` 的 abort 只 reject 等待本身，作业照跑）。
6. 竞速定局：**撤销在先**（raceAbort.abort 摘 waiter）→ **复查在后**（jobs.list
   快照，终态走结算路径——完成优先，R32-d）→ 按胜出成员返回：
   结算 → 完成结果；插话/迟到/预算/abort → 句柄 + 对应口径 note（§33.3）。
```

**短命令与通知（R32-a/e 的取舍）**：执行即注册让短命令也注册——预算内结算的等待是
**活 waiter**（结算事件 awaited=true）→ 宿主**不补发**完成通知：短命令零通知的
旧收益在 R32 形态下由 awaited 语义兑现，代价是终态卡残留（裁定接受，
§33.8）。句柄路径（插话/迟到/abort/预算）撤销在先 → waiter 已摘 → 结算照发一条完成
通知作为恢复通道（abort 后模型唯一的恢复通道，§33.2-1）。

**`elapsed_ms` 的计时起点是"本次工具调用开始"**（`execute` 开头取 `t0`，t0
三不动），不是"作业注册"。

### 4.3 返回形状（`output.schema`）

```jsonc
// 完成分支（exit_code / signal / note 都是**可选**：没值就整键不写）
{ "status": "completed", "exit_code": 0, "output": "…", "truncated": false }
// 让出分支
{ "status": "running", "job_id": "async-command-7", "elapsed_ms": 20012,
  "note": "命令仍在运行（已超过 20000 ms 的让出预算）。继续做其他工作；需要它的输出时调用 async_wait_job(job_id=\"async-command-7\", wait_ms=30000)，最长 600000 ms。" }
```

**`note` 是强制需求（R1）**：必须携带 job_id 与可复制的 `async_wait_job` 调用示例，且**必须写出生效的等待上限数字**（R5——内置 `pwsh` 的描述从不告知具体数字，这个缺口本工具补上）。`note` 由 `output.js` 生成，数字从**实际生效的配置**取值，不写死。

**可选字段的写法**：该 DSL 的 `type` 只接受**单个**类型串，写不出"number 或 null"。
`exit_code` / `signal` 必须写成"**没值就不写这个键**"：
```js
...(typeof proc.exitCode === 'number' ? { exit_code: proc.exitCode } : {}),
...(typeof proc.signal === 'string' ? { signal: proc.signal } : {}),
```
无条件写 `?? null` 会让完成分支匹配 0 支，宿主抛
`tool "async_run" returned invalid output: "value" must match exactly one oneOf branch (matched 0)`
——**任何没让出的 `async_run` 调用都会失败**。单测用 `checkedTool` 把每条用例的返回值喂给宿主校验器锁死这一点。

### 4.4 错误姿态
- `command` 为空 → 参数校验错误（由 schema 层拒绝）。
- 无 agent 语境 → `error.noAgentRun`（§33.2-1；指明内置 pwsh 可用）。
- 作业数量达到 owner 上限（宿主默认每 owner 10 个存活作业）→ `jobs.start` 在 producer 运行前抛错
  （准入先于进程，R32-a）→ `error.startRefused`：**进程未启动、没有进程在运行**、
  复述生效上限、给出 `job_kill`/等待出路、附存活作业清单（终态不列）；
  宿主原文单行化 + 500 截断，完整原文留操作者日志（R29-f）。
- `shell.execute` 抛错（prep 失败）→ 原样作为工具错误返回（模型可见）；作业私有
  signal 中止在先的拒绝归 killed（分类见 §33.1-4）。

### 4.5 完成通知的计数口径（R32-e）

通知是**备用唤醒**，不是竞争路径：`dsh-jobs-local` 结算时按 waiter 集合打 `awaited`，
`tool-jobs` 只对**未被活等待覆盖**的结算补发一条完成通知。

- **预算内完成**：`jobs.wait` 的 waiter 还挂着 → 结算 awaited=true → **零通知**
  （短命令的旧收益由这条兑现；判据：`test/jobs.test.mjs` R32-a/e 与真机 (e)/(f)）。
- **句柄路径**（插话/迟到/abort/预算到期）：竞速定局即撤销（raceAbort.abort，
  §33.1-6）→ waiter 摘除 → 结算 awaited=false → **恰一条**完成通知——abort 后
  这是模型唯一的恢复通道。工具描述里也因此**不得**出现"唯一途径"。

行为判据（单元：waitersOf/wasAwaited 探针；真机：(a)/(b)/(e) 的通知计数）。

---

## 5. `async_wait_job` 工具（R2）

### 5.1 参数
```js
{ job_id: string(必填), wait_ms: number(必填) }
```

### 5.2 执行流程（实现按此重写）

```
1. clamp wait_ms（缺省即报错，见 §3）
2. 屏障：jobs.get(job_id) 已终态 → 直接返回（消除"订阅前已结束"的竞态）
3. 竞速（四个通道，每个解析为自带 name 的对象）：
     a) 用户插话（source.kind === 'user'）                  → interrupted
     b) jobs.wait(job_id, wait_ms, agent, raceAbort.signal) → 终态或到期
     c) 预算定时器到点                                       → running
     d) 工具自身被取消                                       → 抛错结束等待
4. finally：
     - 清理定时器与 inbox 订阅
     - ★ **撤销在途的 jobs.wait**（raceAbort.abort()）
```

- **(b) 的地基是 `jobs.wait` 的关键语义**："aborting the wait rejects only while the job is live"——**等待被中断不会取消作业**，这正是 R4 的"打断等待 ≠ 打断工作"。
- **★ 为什么必须在 finally 里撤销在途等待**：`jobs.wait` 若继续持有 waiter，作业结算时有等待者会让结算事件的 `awaited` 为真，从而**吞掉本该唤醒模型的完成通知**（`completionDelivery` 默认 `"wakeup"`）。这是插话分支最隐蔽的副作用，单测已锁定：竞速收敛后断言 `jobs.wait` 收到的 signal 已 abort。撤销本身不会留下假计数——`jobs.wait` 因非超时 abort 拒绝时会摘掉自己的 waiter（`[@deepseek-ai/dsh-jobs-local] lib/index.js:632/:643`）。
- **`exec.signal` 的两种接法**：一是并入 `jobs.wait` 的 signal（让等待随工具取消而结束）；二是**单独作为一个竞速通道**——否则工具被取消后本调用仍会挂到预算耗尽。
- **竞速分支的形状必须是 `{ name }`**：`watchUserInterrupt` 的原始信号是 `{ kind }` 形状，直接参与竞速会因缺 `name` 而落到回退分支。这条对 `async_wait_job` 与 `async_wait_agent` 都成立，两处都要有测试锁定。
- **完成优先于打断**：若两者同时到达，按风险表——**工作完成优先**：先做一次终态复查，若已终态则返回完成结果并附"（等待期间收到用户消息）"。理由：模型必须知道作业已完成，否则会重复等待。

### 5.2b 输出从哪里取（R8 的游标语义）

- `jobs.wait` 超时 resolve 回的是**作业视图**（状态、result），**不含输出**；输出必须再经 `jobs.read(job_id, caller)` 取（`{chunks, lossy, result?, job}`，§22.2）。
- `jobs.read` 是**消费式游标**（读取推进游标、只返回下一个流式增量）。因此：
  - **只在要返回给模型时读一次**，不要在轮询里反复读（会把输出读空）。
  - 终态读取是幂等的（返回最终输出），可以安全重复。
  - `async_run` 注册的作业其 `run()` 返回的 `readOutput()` 是**全量累加字符串**，所以即便 `read` 走 `readOutput` 路径也不会丢内容（`dsh-jobs-local` 的 `read` 优先用 `readOutput`）。

### 5.3 返回形状
```jsonc
{ "status":"completed"|"killed"|"failed", "job_id":"…", "output":"…", "truncated":false }
{ "status":"running", "job_id":"…", "waited_ms":30000, "note":"…可再次 async_wait_job…" }
{ "status":"interrupted", "job_id":"…", "waited_ms":812, "note":"用户插话已送达，它会作为你的下一条输入出现；作业仍在后台运行，可稍后再 async_wait_job。" }
```

---

## 6. `async_wait_agent` 工具（R3）

### 6.1 参数
```js
{ agent_id: string(必填), wait_ms: number(必填) }
```

### 6.2 执行流程

**子代理结束的唯一可靠信号是状态转换事件，不是列表快照**：0.1.7 的 `listChildren()` 只返回父会话目录条目（`{ id, createdAt, mode, label? }`——没有 `activity`），列表快照能回答的只有"这个 id 在不在我的目录里"。这里按 `agent/status`（`running → idle`，父 scope 实测可见）与结算通知（`source.kind === 'subagent-settled'`）判结束。

```
1. clamp wait_ms；记录 t0
2. ★ 先订阅、后屏障（顺序不可颠倒）
     订阅：用户插话 / 结算通知 / agent/status 转换 / 转达消息
     理由：这三类事件**只发生一次**。若先查状态再订阅，子代理恰好在
           两者之间结束，就再也收不到信号，白等满整个预算。
3. 屏障（判"存在性"）：
     await listChildren(parentId) → 按 `id` 相等找行（**形状自适应**：0.1.7 的
            catalog 行没有 `kind`，判别联合行有；`kind === 'diagnostic'` 一律排除）：
       查询失败（undefined）→ 抛错（不假装结束）
       找不到（null）      → 先按 pollIntervalMs **有界重试**（共 4 次尝试：容忍派发
                              瞬间的目录投影刷新窗口；not_found 是"id 不存在"的断言，
                              一次查空证明不了它），重试耗尽才返回 not_found（附当前目录）
       查到               → 行形状带 `activity` 且明确不是 `running` → 立即返回 settled
                              （0.1.7 的 catalog 行不带该字段，这条快速返回
                              因此在真机上不可达，缺口见本节末）
4. 循环竞速（六个通道，每个解析为自带 name 的对象）：
     a) 用户插话   source.kind === 'user'                                        → interrupted
     b) 结算通知   source.kind === 'subagent-settled' 且 source.senderSessionId === agent_id → settled
     c) 状态转换   agent/status 的 (agent.id === agent_id && status === 'idle')   → settled
     d) 转达消息   source.kind === 'agent-message' → **不结束**；重查状态，
                   能证明不活跃才 settled，否则把该通道移出候选集继续等
     e) 备用轮询   每 pollIntervalMs 重查 listChildren，**条目消失（null）** → settled
     f) 预算到期   wait_ms 到点                                                    → running
5. 竞速收敛后复查一次列表：**能证明不活跃就报 settled**（结束优先于打断/超时），
   报不出来才按 winner 分支返回
6. finally：清理 inbox 订阅、status 订阅、轮询定时器、exec.signal 监听
```

**§6.2 的四条强制约束（全部来自实测事实）**
1. **打断判定只用 `source.kind === 'user'`，绝不用 `role`**（结算通知与转达消息的 `role` 也是 `user`）。此条**必须有专门单测**。
2. **关联子代理用 `source.senderSessionId` 精确比较**，正文匹配只是缺该字段时的降级路径。
3. **结算通知与 `agent/status` 的 `idle` 都是结束信号**；后者的语义是"这一轮驱动结束"，在 continuable 模式下子代理之后仍可被唤醒，因此 `settled` 的文案要区分来源。
4. **`agent-message` 不是结束信号，而是唤醒信号**。

**关于 `activity` 字段**：它**只出现在 `listDescendants()` 的判别联合行**上——0.1.7 的 `listChildren()` 行没有这个字段。它的语义是"**子会话是否驻留**"，不是"子代理是否在跑"。
- `activity === 'running'` —— 活着的内存语料**一律写死**这个值，**证明不了任何事**；
- `activity` 有值且不是 `'running'`（例如冷读路径的 `'inactive'`）—— **可以证明**它不活跃；
- 条目查不到（`null`）—— 可以证明它已不在目录里；
- 查询失败（`undefined`）—— **两个方向都证明不了**，必须与"查不到"分开，否则工具会在宿主出错时对模型撒谎。

判定收敛在 `lib/wait-agent.js` 的 `inactiveVerdict()` 一处，屏障、转达消息后的重查、竞速收敛后的复查共用它。

**功能缺口（必须写进工具描述）**：三条结束通道都是**一次性事件**；在 0.1.7 上列表快照只能证明"id 在不在目录里"（catalog 行没有 `activity`），所以对"开始等待之前就已经结束"的子代理，本工具**只能等满预算返回 running**（不加私有通道：R8 禁止越界读子代理内部状态）。描述里必须写明这一点并指向 `list_agents`（或提醒模型：结算通知已经在对话里），否则模型会把它当"立即返回"用。

**`polled` 的判据只认 `null`**：`undefined`（查询失败）不算"条目消失"——与 `inactiveVerdict` 同口径，混同会凭空报 settled。

### 6.3 关于"最终回答"
`async_wait_agent` **不返回子代理的最终文本**（R3）——那是结算通知消息的内容，会作为独立消息进入对话。工具的 `note` 必须说明这一点，避免模型等一个永远不来的返回值。

### 6.4 返回形状
```jsonc
{ "status":"settled", "agent_id":"…", "waited_ms":812, "note":"…它的最终回答会作为一条独立消息出现在对话里，不在本返回值中。" }
{ "status":"running", "agent_id":"…", "waited_ms":30000, "note":"…" }
{ "status":"interrupted", "agent_id":"…", "waited_ms":900, "note":"用户插话已送达，它会作为你的下一条输入出现；子代理仍在运行。" }
{ "status":"not_found", "agent_id":"…", "known_children":["id (label, mode=continuable)", "id (diagnostic: unavailable)"] }
```
`known_children` **列出目录里的每一行**（含 `kind: 'diagnostic'` 的行，初衷是"别把诊断行当子代理"，不是"别告诉模型"）：
catalog 行写 `${id} (${label}, mode=…)`，诊断行写 `${id} (diagnostic: ${reason})`——
按 `kind === 'child'` 过滤会让清单在 0.1.7 上**恒空**（真机现象：`Known children:` 后面什么都没有，模型拿不到任何可纠错信息）。
诊断行仍然**不能**通过 `childOf()` 的存在性判定：它不是可用的子代理。

---

## 7. 共用部件：`interrupts.js`

```js
// 订阅"用户插话"（steer），返回 { promise, dispose }
export function watchUserInterrupt(ctx, agent) { … }
```
- 用 `ctx.on('agent/inbox/inserted', handler)`（`ctx.on` 返回 disposer）。
- 触发条件是**三连判定**（R12）：
  1. `payload.agent.id === agent.id`（目标 agent）；
  2. `payload.message.source?.kind === 'user'`（结算通知与转达消息的 `role` 也是 `user`，
     用 role 判定会被自己的通知反复打断）；
  3. **该消息此刻在 `agent.inbox.nextStep` 里**（按 `message.id` 回查）。
     落 `next-turn` 的**排队（queue）消息不触发**——它只在轮次边界投递，
     本轮内模型看不到它的内容，打断只会产生一个"看得见通知、看不见内容"的悬空轮次。
- **inbox 不可读时按"不是插话"处理**：宁可不少等（等待仍有界），不可错打断
  （错打断等于把一条模型看不见的消息报告成"已送达"）。
- 回查无竞态：插入事件在投影折叠**之后**同步发出，而领取（claim）只发生在步骤边界的
  `preStep`；等待工具的执行在 step 内部、单 agent 驱动串行，事件到达监听器时消息
  必然还在它被插入的那个列表里。
- **必须返回 disposer 并保证 `finally` 中调用**（R4 可逆性）。
- 竞速的**每个分支都要自己带 `name`**：`watchUserInterrupt` 的原始信号是 `{ kind }` 形状，
  直接参与 `Promise.race` 会因缺 `name` 落到回退分支。`async_wait_job` 与 `async_wait_agent` 两处都有测试锁定。

`async_wait_agent` 另需一个同形状的 `watchSubagentActivity(ctx, agent, agentId)`，把三条通道分流成两个信号：**结算通知**（权威，用 `source.senderSessionId` 关联）与 **`agent/status` 的 `idle`**（父 scope 实测可达）都解析为 `settled`；**`agent-message`** 解析为 `activity`（唤醒信号，不结束）。全部订阅与定时器由调用方在 `finally` 中处置。

---

## 8. 结果渲染与长度控制（`output.js`）

- 输出超过 `maxResultChars` 时**保留头尾、中间截断**并标注省略量（对齐宿主 spill 的"头尾保留"语义，但不写盘——写盘由 dsh 既有的 spill 机制负责，本插件不重复实现）。计数按**字符**（§3）。
- **lossy（内存丢弃）必须显式呈现，且必须给出落点**：`collector` 记住最后见到的 `stdoutSpillPath` / `stderrSpillPath`（`dsh-pwsh-local` 只在**第一次**读里带这两个字段），`async_run` 的完成 `note` 与作业 `detail` 都原样给出路径；**没有落点时必须明说"没有落点、需要就重跑并重定向到文件"**，不能让模型以为磁盘上一定还有一份。
- 句柄文案（`note`）由模板生成，注入**实际生效**的预算数字（R5）。
- 工具描述带**实际生效**的预算数字（R5——内置工具的描述从不写具体数字，这个缺口本工具补上）。两个供数函数，按工具分开：
  - `waitDigest(config)`：只给"等待区间"那句，四个工具都用（四个工具都有 `wait_ms` 之外的
    等待语义可讲）；
  - `yieldDigest(config)`：**只给 `async_run`**——`yield_ms` 是它独有的参数，另两个工具既没有这个
    参数也不"转后台"。**两个供数函数不得合并**：合并后 `async_wait_job` / `async_wait_agent` 的每次调用
    都会向模型描述一个它们没有的参数（R4 审查 #1）。
  - 描述是字符串（`defineTool` 构造时求值），改设置后由 `lib/index.js` 的
    `refreshToolDescriptions` 就地改写，触发通道见 §21.3（宿主行 fiber 上的 `'loader/volatile-update'`）。

---

## 9. 预设设计（R6；现行形态见 §20）

- 交付形态：预设随包 patch 声明（`presets/dsh-async.patch.yml`，bundle patch 数组第二项，§20.1），
  不往用户目录写任何文件；装卸随 bundle 行的出现与消失（预设声明的生命周期由 loader/fiber 拥有：更新或移除声明会让旧 revision 退役，最后一个引用释放时处置整棵退役树）。
- **基座 = shipped standard 预设**（需求 §1.1 的用户决定）：对基线
  （0.1.7 shipped standard 补丁，行级差异见 §20.2）做 §20.2 的定向修改清单（删 `tool-pwsh`、`tool-bash` 无条件禁用、新增四个
  async 行等），蓝本随包走。
- **不挂 `tool-presentation`**：标准模式本来就没有这一行，走 schema 默认的 native 呈现，四个工具**模型可直接调用**；若基座取 PTC，模型只能直接调用 `run_code`，异步的"跨步骤协作"当场失效（需求 §1.1 的功能性硬论据（决定性））。
- **`tool-jobs` 行保留**：`job_kill` / `job_list` 仍需要（R8 的收尾路径）；`job_output` 与本插件的 `async_wait_job` 功能重叠，**保留但由人设引导优先用 `async_wait_job`**，避免一步改太多导致难排查。
- **人设章节**：新增一段工具指引，说明新工作方式（先启动、继续干活、需要时 `async_wait_job` 取回、等待有界、插话会打断等待但工作继续）。人设还有一段**硬规则**（子代理一律后台、结果用 `async_wait_agent` 有界等待，§18.4，R14）。
- **包名必须进 `dsh.profile.bundles`，但宿主行不得带 `toolName`**：两件事要分开看。**进 bundles** 是宿主半边（设置卡片）能被装载的前提——`dsh-client-modules` 只遍历 Loader entry，预设子树不在其中，不进 bundles 卡片就永远不出现（浏览器半边只认**平名**包：行名带子路径时会被静默跳过，服务端一切正常、只有浏览器不渲染）。**工具不会因此进全局工具层**，因为宿主行没有 `toolName` ⇒ 入口分派到宿主角色 ⇒ **零工具注册**（反向锁死见 `test/two-planes.test.mjs` 的 T5/T12）。工具行只写在预设的组成里。
- **挂载位置的副作用**：三个行挂在预设的 standing mount scope 下，`agent/status` 才递达得到子代理的状态（已知依赖：事件按 scope 标签派发，监听器标签须是派发键自身或其祖先）；挂到 host 平面会变成"全进程监听"，挂进某个 agent 的 scope 则会静默失聪。
- **不得修改** shipped 预设目录（shipped 预设随上游包交付，没有"可改的安装目录"；预设由插件行声明，注册表不扫目录、不接受预设路径）。
- **预设切换后的可见性**列为待核验项；端到端第 7 项覆盖。

---

## 10. 错误处理、审计与可观测性

- **审计**：本插件不写会话事件（插件无此权限），但**注册作业会在结算时触发 `tool-jobs` 的完成通知**——那是 dsh 既有机制发的，不是本插件写的。它**不是**与 `async_wait_job` 竞争的第二条取输出路径：`async_wait_job` 覆盖结算时通知被自动抑制（结算时有在途等待者 → 事件的 `awaited` 为真），只有模型完全没在等时才发出，起备用唤醒作用。实测与决定见 §4.5。
- 本插件自己的日志走 `ctx.logger`，前缀统一 `[async-tools]`：每次 `async_run` 的让出决策
  （完成/让出 + 耗时）、每次 `wait_*` 的结束原因（完成/超时/插话/取消）、以及 R9 的
  对账与清理结论（含"跳过并记原因"）。
- **⚠️ 但只走 `ctx.logger` 的日志在本部署里到不了任何地方。** cordis 的 `LoggerService` 只注册了
  **一个把消息推进内存 buffer 的 exporter**（`bufferSize = 1000`，超出截尾），
  dsh-base / dsh-web-app 都没有挂 stdout / 文件出口，也没有 `--verbose` / `DSH_LOG_LEVEL`
  之类的开关。实测：服务 stdout 里只有一行带令牌的 URL，而服务的错误日志里 `[async-tools]` 出现 **0 次**。
- **所以 R9 的"记原因"必须另找一个出口：写 stderr。**
  - **不得写 stdout**：本部署的 stdout 是令牌文件 `current-url.txt`，写它会污染它。
  - **stderr 是既有插件已经在用的审计落点**（同上 `:108`），不引入新约定。
  - 出口做成**可注入**（`emitLifecycleNotice(line, sink)`）：生产走默认的 `process.stderr`，
    测试注入一个收集数组——否则每条用例都往测试输出里写噪声、淹没真正的失败。
  - 判据：stderr 审计出口（`lib/notice.js`，§20.3）的行为断言——给真 ctx 跑一遍
    apply/dispose，断言 skip 的**原因**与**接管办法**都写出去了；判据在
    `test/index.test.mjs` 与 `test/two-planes.test.mjs`。

---

## 11. 测试设计

> 测试基线的增补与假件改造见 **§26**（两节叠加构成完整清单）。

### 11.1 单元测试（默认带宿主解析钩子跑）
| 测试文件 | 覆盖 | 对应用户需求 |
|---|---|---|
| `config.test.mjs` | 夹紧边界（缺省/过小/超大/非法配置自检）、死配置已删除 | R1/R2/R3 有界 |
| `jobs.test.mjs` | 短命令走完成分支且**不注册作业**；超预算走让出分支且作业句柄形状正确；`note` 含 job_id 与数字；`dshEnv` 透传；`elapsed_ms` 覆盖让出窗口；注册后终态复查（含"get 与 read 之间无 await"）；spill 落点两态；相对 workdir；**输出 schema 校验（含 `exit_code: null`）** | R1 |
| `wait-job.test.mjs` | 完成/超时/插话三分支；插话与工具取消都**不碰作业**（真探针：`jobs.kill`/`cancel` 未调用 + 作业仍可 `get`）；在途等待被撤销；**排队消息不打断、同次等待仍可被插话打断** | R2/R4/R8/R12 |
| `wait-agent.test.mjs` | 存在性屏障、**屏障即终态**、结算命中（`senderSessionId`）、`agent/status` 的 `idle` 命中、`agent-message` 不结束但触发重查、超时、插话；**`role:'user'` 的插件通知不得被当作插话**；diagnostic 行过滤；监听器全清理；**输出 schema 逐分支校验** | R3/R4 |
| `agent.test.mjs` | **立返形状**（status/agent_id/note 含可复制调用与生效数字；**输出 schema 经 checkedTool 校验**）、`startContinuable` 恰一次且 request 逐字段（不含透传键）、**零前台**（假件 `start` 哨兵：调用即记录并抛可读错误）、**零等待原语**（timer/on 记录器零调用）、三错误态互区分且不派生、`subagentProvider` 设置改名的行为差异、描述 `currently: <名>` 随设置改名刷新（§18.5 全表） | R13/R10/R5 |
| `interrupt.test.mjs` | `source.kind` 过滤、**next-step/next-turn 落点判定（R12：排队不打断、插话打断、inbox 不可读不打断）**、**非 user 的 next-step 消息不打断（deferContext 上下文消息恰落 next-step，变异 M3 守卫）**、disposer 被调用、多路竞速的优先级 | R4/R12 |
| `output.test.mjs` | 头尾截断（字符口径）、句柄文案数字取自配置、终态竞态的提示句 | R5 |
| `index.test.mjs` | **真 cordis 最小 Context**：`inject` 恰为七个服务、按 `config.toolName` 注册、卸载后注销；`lib/` 里每个 `ctx.<服务>` 访问都在 `inject` 里（漏声明即变红，红＝测试失败） | R4/R6 |

**测试替身**：`jobs` / `shell` / `shellEnv` / `subagents` / `ctx.on` / `ctx.timer` 全部用最小假件（不启动真实进程、不依赖 dsh 宿主）。
但假件**要什么有什么**，所以两类缺口必须由别的手段兜住：
- `inject` 漏声明 → `index.test.mjs` 的静态扫描（T6）；
- 返回值不符合自己的 `output.schema` → `checkedTool` 把**每条**用例的返回值喂给 `validateJsonSchemaValue`（T7）。

### 11.2 端到端（**验证实例上由真实会话手工执行**）

**怎么驱动**（协议要点与两条踩过的坑：`session/create` 会静默回退默认预设、轮询"是否在跑"要先见过 running）：`tools/probe-e2e.mjs` **不是**端到端证据（它只做宿主接线自检、不启动进程）。
真正的端到端是：重启验证实例 → 用 `verify/` 下的真机脚本
（`async-e2e.mjs` / `final-acceptance.mjs` 等，清单见 `verify/README.md`）在真实会话里驱动 →
转录落盘。
逐项留证（命令原文 + 工具结果片段 + 时间）。清单：
1. 短命令（`Write-Output SHORT_OK` 之类）→ 完成分支，直接拿到输出（"matched 0" 的 schema 缺陷会让这一项整体失败，必测）；
2. 长命令（60 s）→ 让出分支拿到 `job_id` → `async_wait_job` 轮询直到完成，输出与命令实际输出一致；
3. 长命令运行中**插话**（steer 模式）→ `async_wait_job` 立即返回 `interrupted`，随后 `jobs` 查询显示作业仍 `running`；
4. 派一个子代理 → `async_wait_agent` 返回 `settled`；
5. `async_wait_agent` 等待中**插话**（steer 模式）→ 返回 `interrupted`，子代理仍 `running`；
6. **呈现模式（§1.1 裁定的验证项）**：在该预设下模型工具列表**直接出现** `async_run`/`async_wait_job`/`async_wait_agent`、**不出现** `run_code`，且**不出现** `pwsh`；
7. 预设隔离：切到标准 / PTC / 极简 / 创造，工具列表**不含**这四个工具，且 `pwsh` 仍在（与改动前逐项对照）。
8. **R12（queue 不打断 + 轮次边界投递）**：长等待期间发 **queue** 消息 → 等待**不**被打断
   （等满预算返回 `running`）→ 本轮结束后该消息被宿主领取进新轮次（模型可见并回应）；
   随后另一次等待期间发 **steer** 消息 → 立即返回 `interrupted` 且作业/子代理不受影响
   （`verify/probe-queue-delivery.mjs` 一条脚本取全三项证据）。
9. **R13/R14（async_agent 立返 + persona 硬规则）**：`async_agent` 调用**同一步**返回
   `started` + `agent_id`（无等待）→ 随后 `async_wait_agent` 等到 `settled`（立返与可等
   缺一不可）；预设 system prompt 转录含 `ALWAYS` 硬规则句（§18.4/§18.5）。

### 11.3 验收口径
- 单元测试全绿，且**不跳过**（不得把"跳过"当"通过"，对齐既有项目约定）；条数只增不减。
- `node tools/check-syntax.mjs` 退出码 0；`node --import ./tools/_host-hooks.mjs tools/probe-e2e.mjs` 退出码 0。
- 端到端 9 项全部在验证实例上取得可复现证据；证据（输出片段 + 日志）记入验收报告。
- 每条"不得做某事"的断言都要能回答"把保护删掉会不会变红"，并在修正记录里留下两次运行的输出。
- **不许有恒真断言**：探针必须装在被测代码真的会经过的入口上，并附一条"探针活性证明"（手工触发一次，看它确实能记到）。

---

## 12. 交付与回滚

**安装**（现行形态；0.1.5–0.1.7 时代的 junction/部署副本形态已由 §37 的冻结实体机制取代）：
1. 安装实体 = 冻结点解包的裸树 + 依赖接线（R37），装入用户的 DSH home 下 `profiles/web/node_modules/dsh-async-tools`（主路径见 README 的 `dsh plugin add`）；
2. **包名加进 `dsh.profile.bundles`**（宿主半边装载的前提；**工具不会因此进全局工具层**——宿主行不带 `toolName`，分派到宿主角色，零工具注册。判据见 §9 与 `test/two-planes.test.mjs` 的 T5/T12）；
3. 预设随包 patch 交付（`presets/dsh-async.patch.yml` 是 bundle patch 数组的第二项，§20）；
4. 开发期还需要让**包目录自己能解析宿主依赖**：开发树的七条 junction（`@deepseek-ai` 下六条：`cordis` / `dsh-jobs` / `dsh-sandbox` / `dsh-subagent` / `dsh-tools` / `schemastery`，加顶层 `zod`）锚 0.2.0 运行树（现行清单与判据见 `verify/check-junctions.mjs` 与 §39），否则裸 `node --test` 全部 `ERR_MODULE_NOT_FOUND`（`test` 脚本因此必须带 `--import ./tools/_host-hooks.mjs`）；
5. 在**服务进程树之外**重启验证实例（服务管理器的 `AppKillProcessTree=1` 语义决定：在服务进程树内 `Restart-Service` 会把命令进程自身杀掉，服务停在 STOPPED）。

**回滚**（R6）：删预设目录 →（若曾加过 bundles 则一并移除包名）→ 重启验证实例。插件不改 dsh 任何文件，删除目录即完全回滚。

**脚本入口**：`npm test`（带宿主钩子）、`npm run test:offline`（不带钩子，靠包目录自己的 `node_modules`）、`npm run check`（语法检查）、`npm run check:docs`（文档结构 + 现行文档的历史叙述词归零）。真机判据的入口见 `verify/README.md`。

---

## 13. 风险与对策（设计层）
| 风险 | 对策 |
|---|---|
| 让出阈值导致短命令白跑往返 | 两段式设计使**完成分支零额外开销**；端到端测一条 10–25 s 命令量化代价 |
| 作业上限（宿主默认每 owner 10）被长命令占满 | 达上限时给出可读文案与存活 job 列表；文档建议及时 `job_kill` |
| 打断竞态（完成与插话同时） | 完成优先 + 终态复查；附注"期间收到用户消息" |
| `activity` 语义（判别联合行里活语料恒为 `running`） | 只在**能证明不活跃**的方向上使用（屏障、重查、收敛复查共用 `inactiveVerdict`）；`=== 'running'` 一律不作证据；查询失败与查不到必须分开。0.1.7 的 `listChildren()` 目录条目没有该字段，判定退化为"id 在不在目录里" |
| **假件测试掩盖真机缺陷** | 三类缺口各有安全网：`inject` 漏声明 → `index.test.mjs` 静态扫描；输出 schema → `checkedTool` 逐用例校验；真实让出/打断/隔离 → 验证实例上手工端到端 |
| 定时器/监听器泄漏 | 全部经 `ctx.timer` / `ctx.on` 且 `finally` dispose；单测断言 disposer 被调用 |
| 让出分支的常驻完成通知（结算时无等待者必补发一条；"注册即终态"的同步复查在 dsh-jobs-local 上永不命中——`spec.run()` 同步调用而结算至少晚一个 microtask） | 注册后紧邻复查（能覆盖的窗口）+ 句柄文案写清；**残余窗口如实登记，不假装已消除** |
| 预设切换可见性未知 | 列为待核验；端到端第 7 项覆盖 |

---

### 14 （编号空置）

预设的生命周期由 loader/fiber 拥有（预设由 `@deepseek-ai/dsh-agent-preset` 的插件行声明、装卸随声明走），本包不自管目录；"装上出现 / 卸载消失"
由机制本身成立。平面分工的现行表述见 §14.1。

### 14.1 平面决定

预设行**不能**提供"把自己装出来"的功能——预设不存在时那些行根本不运行（鸡生蛋）；
而设置卡片要求宿主平面（预设子树里的工具行不进 configEditor 的枚举面，§21.1）。
因此插件分两半：**宿主平面的一行**（宿主角色：设置）+ **预设平面的
四行**（工具角色）。预设的装卸由 loader 拥有，宿主行只播报设置快照（§21.2）。

### 15 （编号空置）

编号空置；插件设置与描述刷新的现行机制见 §21（volatile 字段 + 就地提交）。

---

## 16. 测试与审查的执行者（流程约束）

**所有测试与所有审查一律由独立子代理执行。** 主会话写代码与文档，但不充当测试者与审查者；
端到端记录与各轮实现/设计审查结论都必须出自独立子代理的报告。
主会话可以读产物、可以据此修代码，但不能用自己的执行结果替代独立结论。

---

## 17. 浏览器半边的投递条件（R10 的 UI 部分）

### 17.1 投递数据链与实测断点

设置卡片要出现在页面上，需要五段全部成立。逐段可判定的现状（由
`test/two-planes.test.mjs` 的 T5/T6 静态断言 + `verify/_visual/probe-card-visual.mjs`
的真机 DOM 断言共同覆盖）：

| # | 条件 | 现状 | 判据落在哪 |
| --- | --- | --- | --- |
| 1 | 本包声明 `dsh.client.platform === 'web'`，且 `exports['./client']` 可解析到真实文件 | 成立 | T5 静态锁 |
| 2 | 本包的 `client.js` 出现在 `index.html` 的 `/plugins/??…` 注入表里 | 成立 | 诊断第 5 段（读注入表本体，不读服务端声明） |
| 3 | 宿主行已装载（describe 收得到 `async-tools-host` 行） | 成立 | 诊断第 4 段 |
| 4 | `client.js` 注册进插件管理页的 `plugins.bundle.config` keyed slot（键＝**包名** `dsh-async-tools`） | 成立 | 静态锁 T5 + 运行期注册判据 T16 |
| 5 | 卡片渲染出 DOM | 成立（真机探针） | `verify/_visual/probe-card-visual.mjs` |

第 1 条必须由**进宿主平面的那个包**满足：dsh 只把**平名**包纳入客户端模块图
（`[@deepseek-ai/dsh-client-modules] lib/index.js:132-138` 的 `exactPackageSpecifier` 只接受平名或
`@scope/name`）。名字带子路径时那一行被静默跳过——命名空间照常注册、服务端可读可写，
但 `client.js` 永不进入注入表，**且没有任何报错**。

### 17.2 为什么行名必须能进客户端模块图（已定位到行号）

`dsh-client-modules` 判定一行是否携带前端代码时，先用 `exactPackageSpecifier` 解析行名
（`[@deepseek-ai/dsh-client-modules] lib/index.js:132-138`）：**只接受不带 `/` 的平名，或 `@scope/name` 两段式**。
行名带子路径时：

```
:683  if (!pathLike && expectedPackageName === void 0) return void 0;
      → locatePkgJson 返回 undefined → resolveMeta 返回 null → resolveSource 返回 undefined
      → :779 该行被静默跳过
```

**后果是"服务端全对、浏览器什么都没有、且没有任何报错"**——设置命名空间照常注册、可读可写，
但 `client.js` 永远进不了注入表。这条约束决定了下面所有形态选择。

### 17.3 定案：单包两角色（一个包按 `toolName` 分派两张平面）

本节只写现行形态与它的不变量（结论：单包双角色的分派必须由本包自带补丁行保证）。

**机制**：一个包、一个默认入口，按行配置里 `toolName` 是否出现分派角色——

```
有 toolName    → 工具角色：lib/index.js 走原路径，按 toolName 注册四个工具之一（预设平面的四行）
无 toolName    → 宿主角色：lib/index.js 分派到 lib/host.js 的 applyHostHalf——
                 注册设置命名空间 + 接入预设生命周期，不注册任何工具
```

宿主行来自**本包自带的 `cordis.patch.yml`**（`- insert: id: async-tools-host,
name: dsh-async-tools`），包名 `dsh-async-tools` 进 `dsh.profile.bundles`。
它能进客户端模块图，因为包名本来就是平名——§17.2 的平名约束由此满足。

**不变量与它们的守卫**：

| 不变量 | 为什么 | 守卫 |
| --- | --- | --- |
| 工具不泄漏进全局工具层（R4） | 泄漏的开关是"**宿主行是否带 `toolName`**"，不是"包是否进 bundles" | T5④ 锁 patch 文件不得出现 `toolName`；T12 行为断言宿主角色注册零工具 |
| 进 bundles 的包必须有 `dsh.bundle` | 否则 `dsh-app-boot` 直接启动失败 | 本包声明 `dsh.bundle.patch`（自带 `cordis.patch.yml`，只插宿主行）；T5 检查该声明 |
| `toolName` 可选但**禁止默认值** | 缺省 = 宿主角色（宿主行合法地没有 `toolName`）；默认值会让宿主行静默变成工具行 | `test/config.test.mjs`「toolName 缺省 = 宿主角色：不得抛错，也不得回填默认值」 |
| 预算字段的 `config:` 合法、`toolName` 禁入宿主行 | `config` 是宿主行配置的正式入口（写入落 profile patch 本行 `config:`——设置承载就是"行 Config 里标 `.volatile()` 的字段"）；`toolName` 只属于预设平面的工具行 | `Config` schema（`toolName` 无默认）；patch 注释写明 |

**漏写 `toolName` 的故障姿态**：工具行漏写会落到宿主角色——不注册任何工具（一用就发现），
且若宿主行已注册过命名空间，第二次注册撞 `already registered` 会在 stderr
留痕（`lib/host.js` 的故障姿态）。"少写字段"不等于"装上某个工具"。

**刷新总线**：两条平面的角色加载的是**同一个模块文件**（`lib/refresh-bus.js`），
不存在"两条解析路径 → 两个实例"的断链模式（该总线的 BUS_ID 诊断仍保留，用于将来
引入新装载路径时的自查）。

**判据**（读数现跑现读，本文不抄数字——抄了必然与实物背离）：

| 条件 | 判据 |
| --- | --- |
| 包名是平名、`dsh.client` 存在且 `platform=web`、`exports['./client']` 解析得到真实文件、`dsh.bundle.patch` 在 | `test/two-planes.test.mjs` 的 **T5**（静态断言，能失败） |
| 入口按 `toolName` 分派、`./host` 子路径入口不得复活 | `test/two-planes.test.mjs` 的 **T2b** |
| 浏览器半边不引 ESM/JSX、卡片样式走主题变量、套了系统卡片壳、可折叠 | `test/two-planes.test.mjs` 的 **T6 / T14 / T15 / T16** |
| 卡片**真的渲染出 DOM**、输入框样式与宿主字段逐项一致、与同栏系统分组卡左右缘对齐 | `verify/_visual/probe-card-visual.mjs`（真机无头 Edge + CDP，逐条给读数） |
| 宿主角色零工具注册、工具角色恰注册一个（同一入口两条分叉） | `test/two-planes.test.mjs` 的 **T12**；真机对照见 `verify/probe-preset-portability.mjs` |
| 本包清单自洽（`files`/`exports` 均在盘上）、无外部宿主包依赖残留 | `test/two-planes.test.mjs` 的 **T11** |

### 17.4 排除掉的三条路（都实测过）

| 尝试 | 结果 |
| --- | --- |
| 行名带子路径 `dsh-async-tools/host` | 服务端正常，但**静默跳过**客户端模块图——卡片永不出现且无报错（§17.2） |
| 行名改成绝对路径（指向包内文件） | 服务**起不来**（`ERR_INVALID_URL`） |
| 再加一行指向 `dsh-async-tools/client` | 服务**起不来**（`ERR_INVALID_URL`）——浏览器半边不能当宿主行 |

### 17.5 验收判据必须落在用户可见层（纪律）

`settings/describe` 的返回里有本包条目时，并不代表设置页里有卡片可看。
**服务端能查到 ≠ 用户能看到。** 凡"UI 是否生效"类验收，判据必须是
**注入表内容或页面 DOM**，不能是后端 API 的返回；"某个包被装上了"也不等于"它的前端被投递了"。

---

## 18. `async_agent` 工具与 persona 硬规则（R13/R14）

### 18.1 关键取舍

| 取舍 | 选择 | 理由 |
|---|---|---|
| 后台形态 | 只走 `ctx.subagents.startContinuable`，**不**走宿主 `jobs.start({kind:'subagent'})` 兜底路径 | `childId` 直接就是 `async_wait_agent` 的等待对象，没有 job↔child 对照要维护；fork/spawn 后端天然支持 continuable。jobs 路径是宿主工具给非 continuable provider 的兜底，不是公共契约的正门 |
| 参数面 | `description` + `prompt` + 可选的 `provider`+`model`（成对，模型路由）；**不设** `run_in_background`，不透传 reasoning_effort/persona/toolFilter/maxDepth；**未声明键一律显式报错** | "永远后台"是结构保证不是提示词约束（R13）；模型选择进参数面、经 `request.agentOptions` 真正生效（spawn provider 声明 `capabilities.agentOptions = true`，request 带 `agentOptions` 即可覆盖子代理路由），消灭"传参不生效且无提示"（开放参数 schema 会把多余键静默吞掉的失效形态）；其余委托参数仍走宿主 `subagent` 工具（非目标清单）。显式报错是对静默吞参的对冲 |
| 后端 provider 选择 | 插件设置 `subagentProvider`（字符串，默认 `'spawn'`，名字沿用 shipped 预设 ralph 行的既有字段名）；与参数面的模型路由 `provider` 是两个概念 | 后端属于部署级选择（哪个后端可用取决于宿主组合），不是每次调用的选择；R10 语义=默认值可配。**不做闭集枚举**：后端注册表在宿主平面且可变，schema 里枚举会过期；无效名字留到执行时报可读错误 |
| 等待归属 | `async_agent` **不注册任何定时器/监听器/作业**，等待完全归 `async_wait_agent` | 没有等待就没有打断问题——R12 的打断语义不适用于本工具；一次派生、零副作用残留（R4 可逆性） |
| 中止语义 | `startContinuable` 的 `signal` 用 `exec.signal` | 与宿主 `subagent` 工具同款（宿主同样把 `exec.signal` 传给派生调用）——派生调用本身随本次工具调用取消；`childId` 返回后子代理生命周期与本次调用无关 |
| 硬规则的载体 | 机制半边=工具形状（R13）；行为半边=persona 条款（R14） | 预设平面能告诉模型"怎么用工具"的地方只有 persona（§9 既有论断）；管住裸 `subagent`/`subagent_fork` 的显式 `run_in_background: false` 只能靠提示词 |

### 18.2 工具定义（`lib/agent.js`）

**parameters**（dsh 自有 DSL 本体——与 `lib/wait-agent.js:145-148` 同款；**不是** schemastery
形态：`z.string()` 是函数，`dsh-tools` 的 `isPlainJsonRecord`（`[@deepseek-ai/dsh-tools] lib/index.js:78-86`）
拒函数，`.describe` 更是不存在的方法——照抄 schemastery 会在 `defineTool` 当场抛错，
探针实测）：

```js
{
  description: {                 // 行标签：进 startContinuable 的 label；缺键被 DSL 的 required 挡下
    type: 'string', required: true,
    description: '3-5 word label for display'
  },
  prompt: {                      // 完整任务书：子代理看不到本对话，必须自包含
    type: 'string', required: true,
    description: 'The complete, self-contained task for the subagent'
  },
  provider: {                    // 模型路由的提供方：与 model 成对传入，可选
    type: 'string',
    description: 'LLM provider route for the subagent. Supply together with model; omit both to inherit the parent route.'
  },
  model: {                       // 模型路由的模型 id：与 provider 成对传入，可选
    type: 'string',
    description: 'Exact model id under the provider. Supply together with provider; omit both to inherit the parent route.'
  }
}
```

两键不写 `required`（可选）；成对、非空、白名单三条纪律由执行流程的第 2-4 步在运行时强制
（DSL 的 `type: 'string'` 不挡空串，也不挡只传其一）。

**执行流程**（编号步骤；任一步失败都**一个子代理都不派生**——`startContinuable`
零调用）：

1. `exec.agent` 缺失 → 抛 `[async-tools] async_agent requires an initiator agent`（与 R11
   的 agent-less 同款纪律；错误里写明这是宿主驱动形态的限制）；
2. **参数纪律（未声明键）**：`Object.keys(args)` 对照声明集
   {`description`,`prompt`,`provider`,`model`}，多余键 → 抛
   `[async-tools] async_agent got unsupported argument(s): <keys> — supported:
   description, prompt, provider, model; for other delegation options use the host
   subagent tool`。这是对静默吞参的对冲：`defineTool` 把参数根对象编译为隐式开放对象
   （`additionalProperties` 缺省开放），宿主层不替本工具挡多余键；
3. **参数纪律（成对与非空）**：`provider` 与 `model` 只传其一 → 抛宿主同款
   `` child LLM `provider` and `model` must be supplied together``；任一为空串 → 抛
   宿主同款 `` child LLM `provider` must be non-empty``（`type: 'string'` 不挡空串）；
4. **模型路由校验**（仅当传入 `provider`+`model`；纯继承不进本步——宿主语义
   "Pure inheritance remains outside this policy"）：
   - 读本会话的白名单投影：`ctx.sessionProjections.stateOf(exec.agent.session,
     'subagentModelSelectionPolicy')`——返回**裸路由数组** `[{provider, model}, …]`
     （reducer 由宿主 `tool-subagent` 行注册）；`null`（投影初值、未 record）与
     `undefined`（键未注册——宿主 stateOf 对未注册键返回 undefined 而不抛）都折叠为
     "无 policy"，读取抛错（服务缺席、投影折叠异常等）同样 try/catch 兜住按
     "无 policy"处理——保守方向，宁可拒绝；
   - 无 policy → 抛 `[async-tools] child model selection is not available for this
     session (no model-selection policy)`——宿主在无 policy 的会话根本不暴露模型参数
     （`modelSelectionEnabled = policy !== void 0`），本工具参数面常开，所以用
     运行时拒绝对齐同一管控口径；
   - 有 policy → `provider/model` 必须命中返回数组里的一条路由，否则抛宿主同款
     `` child LLM route "<p>/<m>" is not allowed for this Session``；
5. `provider = 生效配置.subagentProvider`（`getConfig()` 调用时取值——活视图，R10 语义）；
   `ctx.subagents.getProvider(provider)` 返回 `undefined` → 抛
   `[async-tools] subagent provider "<name>" is not registered — check the async-tools setting 'subagentProvider'`；
6. 该 provider 无 `prepareContinuable` → 抛
   `[async-tools] subagent provider "<name>" does not support background delegation (missing prepareContinuable)`
   ——三种错误互相可区分（R13），文案镜像宿主的同款错误（宿主在 provider 缺 `prepareContinuable` 时报 ``provider "X" does not support `backgroundMode: continuable` ``）便于并读；
   6b. **能力预检（仅传入路由时；静默吞参零容忍的延伸）**：provider 的
   `capabilities.agentOptions !== true`（未声明或显式 false）→ 抛
   `[async-tools] subagent provider "<name>" does not honor agentOptions — the
   requested route would be silently ignored`——宿主 spawn/fork provider 都声明该
   能力（spawn/fork 后端都声明 `capabilities.agentOptions = true`），但注册表在宿主平面且可变，不声明能力的后端对 `agentOptions`
   的处置无从约定，宁可当场报错不给"传参不生效"留门。不指定路由时不做本预检；
7. `request = { label: args.description, prompt: [{ type: 'text', text: args.prompt }], parent: exec.agent }`
   （形状逐字段对齐宿主 `subagent` 工具的 request：`{ label, prompt: [{ type: "text", text }], parent, agentOptions? }`）；传入模型路由时追加
   `agentOptions: { provider: args.provider, model: args.model }`——恰这两键
   （`reasoning_effort` 不透传，换路由清 effort 由 driver 的
   `resolveChildAgentOptions` 按宿主语义处理）；未传时**不带**
   `agentOptions` 键（request 无该键 ⇒ driver 走父路由继承）；
   `const { childId } = await ctx.subagents.startContinuable({ provider, label: args.description, request, signal: exec.signal })`；
8. 返回 `{ status: 'started', agent_id: childId, note }`——**仅此一个出口**，无终态分支。

**已知限制（登记，不修）**：白名单命中 ≠ 适配器认得该路由——宿主 `subagent` 工具在
调用点还做 `preflightChildLlmRoute`（经 LLM runtime 解析路由，解析不了当场抛）；本工具
拿不到同款预检通道（`llm` 服务与该内部函数都不在插件可用的公共面），路由不可解析的
错误最早出现在**子代理首个请求**。缓解：note 已回执实际请求的路由（错路由一眼可见），
白名单本身已是第一道过滤。

**note 文案**（§7 纪律：可复制的下一步调用；数字现读现取，不写死；模型面文案取自
`lib/text.js` 双语表的 `en` 档——英文是默认档，`agentLang:'zh'` 切中文档，R22/R25）：

> `Subagent delegated in the background. When you need its result, wait with `
> `async_wait_agent(agent_id="<childId>", wait_ms=<生效 defaultWaitMs>); a user steer `
> `interrupts the wait while the subagent keeps running. Its final answer arrives as its `
> `own message in the conversation; list_agents shows progress at any time. `

末尾追加路由回执一句（R13："note 必须报告实际生效路由"）：

> `Child LLM route: <provider>/<model> (requested).` ——传入模型路由时；
> `Child LLM route: <provider>/<model> (inherited from this agent).` ——未传时，父路由经
> `parentAgentOptionsForDelegation(exec.agent)` 现读（`@deepseek-ai/dsh-subagent` 公共导出，
> peer 已申报（R38 起 0.2.0 线精确锁，现行 `0.2.0-rc.2`（R44））；读不出具体值时写 `inherits parent route`）。

`note` 在每次调用时生成（不是静态描述），`defaultWaitMs` 从 `getConfig()` 取——
设置改了，示例里的数字跟着变（R5 的现读现取纪律）。

**output.schema 本体**（dsh 自有 DSL：单类型串、`required: true`、三键恒在；`additionalProperties`
**必须显式** `false`——缺这个键 `defineTool` 直接抛 `must be explicitly true or false`
（探针实测），而 `false` 恰好把"仅此一个出口、三键恒在"变成校验器守得住的写法）：

```js
{
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true },   // 恒 'started'
    agent_id: { type: 'string', required: true },
    note: { type: 'string', required: true }
  }
}
```

**工具 description**（自解释 + 生效 provider 名现读现取）：说明"只后台派生、立返
agent_id、用 async_wait_agent 取结果"，并写 `delegates via the configured subagent
provider (currently: <生效名>)` 与一句模型选择说明（`Optionally supply provider and
model together to select the subagent's LLM route (checked against this session's
model-selection policy); omit both to inherit the parent route`——不含随设置变化的
片段，无新增刷新规则）。**刷新要自己接线**：refresh 总线回调对
第四工厂自动生效，但 `lib/index.js` 的 `refreshToolDescriptions` 改写规则是**逐工具硬编码**
的——实现必须给 async_agent 加**第五条 replace 规则**（锚 `currently: <名>` 片段），
否则设置改名后"行为活、描述死"（§21.3 的就地改写通道）。
规则形态敲定：锚吃到句边界 `currently: [^.)]+` + **函数替换器**——
设置值是自由文本（仅 trim），窄字符集锚会在带空格的名字下逐次累积尾缀、字符串
替换器会展开 `$&`；`agent.test.mjs` 的"自由文本名连续刷新稳定"用例守这两条。

### 18.3 配置与设置

- `lib/config.js` 的共享字段定义加 `subagentProvider: z.string().default('spawn')`
  ——`Config` 与 `SettingsConfig` 从同一份定义构造（既有纪律，两 schema 不漂移）；
  夹紧规则：`trim()` 后为空 → 回默认 `'spawn'`。**与 `jobKind` 空串抛错的策略不同**：jobKind 是标识符键（拼进注册表的 kind，坏值静默错位，故抛）；
  provider 名无效**只能在执行时**对着注册表报可读错误（注册表在宿主平面且可变），
  空串回默认让"没配"等价"用 spawn"。
- 卡片 `client.js` 的 `FIELDS` 加一行 `{ key: "subagentProvider", label: "子代理后端", numeric: false }`
  ——卡片字段是手工数组（client.js:28-38），渲染/保存逻辑按 key 走；唯一附带改动是
  视觉探针的"末字段"锚（`verify/_visual/probe-card-visual.mjs:447` 认"后台作业 kind"）
  要换成新末字段标签"子代理后端"。
- 设置行为测试口径：`subagentProvider` 改成别的名字后，**下一次 `async_agent` 调用的错误**
  （或 `getProvider` 的查询对象）跟着变——行为差异证明设置生效（R10 纪律），不停留在"读回新值"。

### 18.4 预设第四行、persona 硬规则与**模板刷新**（R14）

- 预设补丁 `presets/dsh-async.patch.yml` 加第四行：**顶层、紧随 `async-wait-agent` 行之后**
  （与三个 async 行连续成组）——**不得**写进 delegation 组的子行
  （`tool-subagent` 行在 delegation 组内，`isolate: { workflowEngine: true }`；
  写进去会改变挂载语义）。行内容：
  `- id: async-agent` / `name: dsh-async-tools` / `config: { toolName: async_agent }`
  （`tool-subagent` 的成例：一个包被引用多次，靠 `toolName` 区分）。
- persona prefix（模板 `:40-47` 段）追加硬规则段（与现有人设同语言=英文）：

  > `DELEGATION RULES (hard rules, not advice):`
  > `1) Delegations are ALWAYS background. Use async_agent (it has no foreground mode), or pass run_in_background: true to subagent / subagent_fork. A foreground delegation blocks the entire tool batch — never pass run_in_background: false.`
  > `2) When you need a subagent's result, wait with async_wait_agent (bounded wait_ms). Do not poll in a loop; do not re-delegate just to check progress; the final answer arrives as its own message.`

- `tools/validate-preset.mjs` 校验模板 persona 含两条锚句。**锚句必须选新增文本独有的短语**
  （既有 prefix `:45-46` 已含 `async_wait_agent (bounded` 与 `rather than
  polling`，拿它们当锚是恒真——删掉整段新规则仍然通过）：锚 1 = `ALWAYS` +
  `run_in_background: true`；锚 2 = `Do not poll in a loop` 与
  `never pass run_in_background: false`（新规则段独有）。**能失败**：删掉规则句必须红
  （R14 判据）。
- **模板刷新**：预设随包 patch 走，改补丁重启即刷新；不存在"装了旧模板的实例不会自动
  获得新行"的自管目录问题（§14，机制由 loader 拥有）。**不为此加"自动覆盖"逻辑**——
  用户目录只读是安全语义的底线。

### 18.5 测试设计（并入 §11）

- **单元**（新增 `test/agent.test.mjs`，假 `subagents` 只实现 `getProvider`/`startContinuable`，
  返回 `{ childId }`；探针=记录调用的数组，§11.1 纪律）：
  | 用例 | 锁住 | 对应 |
  |---|---|---|
  | 立返形状：`status==='started'`、`agent_id===childId`、note 含可复制的 `async_wait_agent(...)` 与生效 `defaultWaitMs` | R13 出口 | R13/R5 |
  | 未传模型时 request 逐字段（label/prompt[0]/parent）且**不带** `agentOptions` 键；传模型时 `request.agentOptions` 恰为 `{provider, model}` 两键；`persona`/`toolFilter`/`maxDepth`/`reasoning_effort`/`run_in_background` 永不出现 | 参数面=结构保证 | R13/非目标 |
  | **模型路由生效路径**：传入白名单命中的 `provider`+`model` → note 末尾 `Child LLM route: p/m (requested)`；未传 → `(inherited from this agent)` 且值来自父路由假件（`session.requestHeader().config`） | note 报告实际生效路由 | R13 |
  | **未声明键**：传 `run_in_background`/`reasoning_effort`/任意未声明键 → 抛 `unsupported argument(s)` 列出实际键名并枚举支持键，且 `startContinuable` 零调用 | 对静默吞参的对冲（多余传参不再静默） | R13 |
  | 只传 `provider`（或缺 `model`）→ 抛宿主同款 `must be supplied together`；`provider`/`model` 空串 → `must be non-empty`；两者均零派生 | 成对与非空 | R13 |
  | **白名单**：路由不在白名单数组 → 抛 `child LLM route "p/m" is not allowed for this Session` 且零派生；无 policy（stateOf 返回 null/抛错）传模型 → 抛 `not available for this session` 且零派生 | 管控口径对齐宿主（`request.agentOptions` 通道 + 会话白名单） | R13 |
  | **能力预检**：provider 的 `capabilities.agentOptions !== true`（未声明或显式 false）时指定路由 → 抛 `does not honor agentOptions` 且零派生；同一 provider 不指定路由不受影响 | 静默吞参零容忍的延伸（传参不生效当场报） | R13 |
  | **零前台**：假件的 `start` 是哨兵——记录调用并抛带可读信息的错误（不靠泛型 TypeError） | 后台形态取舍 | R13 |
  | **零等待原语**：假 ctx 的 `timer`/`on` 是记录器，断言一次 `execute` 全程**零调用**——"立返"由此从形状断言升级为可失败断言 | R13 实现约束"不注册任何定时器/监听器/作业" | R13 |
  | 三错误态互区分且不派生（agent-less / 未注册 / 无 prepareContinuable） | 错误姿态 | R13 |
  | `subagentProvider` 设置改名后 `getProvider` 的查询对象跟着变（行为差异） | 设置生效 | R10 |
  | `subagentProvider` 改名后**描述里的 `currently: <名>` 跟着变**（第五条改写规则） | 描述刷新 | R10/R5 |
  | provider 名为**自由文本**（带空格/`$&`）时连续 refresh 描述不累积不展开（句边界锚+函数替换器） | 描述刷新健壮性 | R10/R5 |
  | note 示例数字随 `defaultWaitMs` 设置变化（现读现取） | 描述纪律 | R5 |
  | 缺 `prompt` 被拒：`validateJsonSchemaValue(tool.parameters, …)`（dsh-tools defineTool 内部同款入口）点名违规，两键齐全通过（比 validateArgs(spec) 更贴执行层：宿主消费的就是编译后的 schema） | schema 本体 | R13 |
- **变异**（`verify/mutate-agent.mjs`，入 README 变异表）：
  把 `startContinuable` 换成 `ctx.subagents.start(provider, {...})`（前台形态）→ 上表"零前台/立返"必红；
  M2 删掉 persona 硬规则段 → `validate-preset` 必红。
- **接线**：`test/index.test.mjs` 的 inject 静态扫描自动覆盖 `lib/agent.js`（它只用已注入的
  `subagents`；agent.js 构造时**不查注册表**——描述里的 provider 名取自配置，所以
  makeContext 的假 `subagents`（只有 listChildren/interrupt）不需要 getProvider）；
  **T3 的按名注册循环必须含第四名 `'async_agent'`**——静态扫描会自动扩展，**T3 不会**。
  `two-planes` 的 T5④（宿主行无 toolName）不受影响——第四行在预设平面。
- **端到端**（验证实例，并入 §11.2 清单第 9 项；模型选择半边随 §26.3 第 9 项一并跑）：
  9. `async_agent` 立返 `agent_id`（转录里**同一步**返回，无等待）→ 随后
     `async_wait_agent(agent_id, wait_ms)` 等到 `settled` 且拿到该子代理的回答要点
     ——立返与可等**缺一不可**；另断言预设 system prompt 转录含
     `ALWAYS` 硬规则句（R14 真机判据）。

---

## 19. 0.1.7 适配总览（R15）

> §19–§26 是 **dsh 0.1.7-rc.1 基线**的设计段。现行机制只有一套：包体、代码与文案的改动落
> §20–§24，端到端判据落 §26。

### 19.1 两阶段落地（需求 §9 风险表末行的处置）

| 阶段 | 内容 | 判据出口 |
| --- | --- | --- |
| 一：代码适配（本机，可回滚点） | §20–§24 的全部包体/代码/文案改动；单测 + 接线 + 静态断言全绿 | `npm test`（沙箱外会话补跑，§26 备注）；`tools/check-*` 全绿 |
| 二：实例升级与端到端 | 验证实例升 0.1.7-rc.1 → 部署本包 → R17/R18/R21/R22 的端到端 | §26 清单；证据一律取自验证实例 |

开发实例未随 0.1.7 升级。同 profile 其他插件
（兄弟仓 approve-for-me 与两个既有插件）在验证实例升级
后逐个量它们的工具面貌与设置卡片——这些插件依赖的注册 API 在 0.1.7 已删除（路由类插件依赖的注册 API 已不在，审批类插件读的是 `ctx.settings` 旧面），
属 0.1.7 升级的验收范围、不是本包缺陷。

**升级序列含一次性清场**：现行形态不写 `%DSH_HOME%\.agent-presets\dsh-async\`
目录；验证实例升级部署时显式删除该目录，判据进 §26.3.3(a)。

**部署生效方式不依赖 hmr**：验证实例是服务实例，按 D11 既有流程
robocopy 同步 + 进程树外重启生效；开发实例的热更新通道不改变本包的部署判据
（升级后以重启 + 工具清单核对为准）。

**R23 清场的承载**：清场在端到端层收尾执行，grep 校零清单本体在
requirements-v2（§5），本设计不复制清单、只登记出口（§26.3）。

---

## 20. 预设随包交付与旧生命周期退场（R17-1、D1、D2、R20）

### 20.1 交付形态（D1 裁决的落地）

`package.json` 的 `dsh.bundle.patch` 由字符串改**数组**（0.1.7 的官方交付形态：`dsh-web-app` 的 `dsh.bundle.patch` 就是数组——第一项自己的 `cordis.patch.yml`，随后每预设一个补丁）：

```json
"dsh": {
  "bundle": { "patch": ["./cordis.patch.yml", "<第二项：dsh-async 预设补丁，见下>"] },
  "client": { "…": "不变（§17 的投递链未变）" }
}
```

第一项不变（宿主行）；第二项是**新建**的 dsh-async 预设补丁（待创建，落在 `presets/`
目录下、与第一项相对包根解析）——`presets/` 目录保留，但内容从"预设目录模板"换成
"预设补丁"。`dsh plugin add` 时数组按序进层栈
（补丁层语义：后面的层逐行胜出），预设与宿主行同时到位；卸载随行消失——预设声明的生命周期由
loader/fiber 拥有，**本包不写任何清理代码**，这正是 R17-1 的机制保证。

### 20.2 预设补丁的内容（基线 = 0.1.7 shipped standard）

行形态照抄 shipped 预设补丁的 insert 行（`id: preset-dsh-async` / `name: '@deepseek-ai/dsh-agent-preset'` /
`config: { id: dsh-async, name, description, order, plugins }`）。`name: 异步模式` 与
`description` 是设置页给人看的 UI 文案，**不在 R22 的"面向模型"口径内**，
保持中文；`order: 5`。

对基线（0.1.7 shipped standard，相对 0.1.5 有三处行级变化：`workflow-ptc` 取代 `workflow-worker-thread`、`tool-ralph` 转禁用、新增 `tool-plugin-manager` 行）的定向修改清单：

| # | 定向修改 | 依据 |
| --- | --- | --- |
| 1 | `tool-bash` 行的 `disabled` 从 `!!js process.platform === 'win32'` 改为**无条件 `true`** | R20（两平台同步命令面一致为空） |
| 2 | **不挂** `tool-pwsh` 行（基线里有，删去） | R6 既有裁决（前台到期杀整棵进程树 + exclusive 独占批次） |
| 3 | 新增四行 `dsh-async-tools`（`toolName` 四值各一），位置在 `tool-bash` 之后连续成组 | R1–R4 / R13 / §18.4；`toolName` 分派成例（§18.4） |
| 4 | `workflow-worker-thread` 行按基线换成 `workflow-ptc`（config 同基线 `{provider: spawn}`） | 基线事实：旧包 0.1.7 已移除 |
| 5 | `tool-ralph` 按基线置 `disabled: true` | 基线事实；⚠️ 设计审查须专核（见下） |
| 6 | `tool-plugin-manager` 行照基线带上（`disabled: true`） | 基线事实（补丁保真；禁用行无行为影响） |
| 7 | persona `prefix` = 基线文案 + 异步工作纪律 + DELEGATION 硬规则（英文原文承 §18.4，锚句不变） | R5 / R14 |
| 8 | 预设行**不带** disabled 护栏 | loader `refresh()` 在服务就绪前求值 `disabled`，`!ctx.get('agentPresets')` 为真时**静默跳过 init**，行永远不导入、审计报 "failed to import"（`[@deepseek-ai/cordis-plugin-loader@~1.0.5] lib/index.js:359-363`；验证实例实测：带护栏行死、摘护栏即活）；等待由 `dsh-agent-preset` 自带 `inject=['agentPresets']` 原生承接，注册失败沿 fiber 抛出时可选行只是启动警告 |
| 9 | （R35 增）`tool-workflow` 置 `disabled: true`；`async-workflow` 行插 delegation 组内 `tool-workflow` 行后；`tool-subagent` / `tool-subagent-fork` 置 `disabled: true`（config 逐字保留）；persona「唯一入口」锚句替换 R14 双入口旧句 | R35-a/-b/-c（§35.1 组内隔离，行位判据 §35.3）——本表 1–8 为 0.1.7 主线定向修改，9 为 R35 增量 |

**#5 的裁决结果（已裁）**：跟随上游意味着 `dsh-async` 用户失去 `ralph`
工具。**用户裁定：跟随上游禁用**。补丁按
`disabled: true` + 保留 config 落地——将来要重新启用，删那一行 `disabled` 即可，
其余判据不受影响。

### 20.3 已移除模块清单（原 D2 落地清单；引用清理同步完成）

| 删除 | 引用清理 |
| --- | --- |
| lib 下的 preset-lifecycle 模块 | `lib/index.js` 的 `emitLifecycleNotice` import 改指 notice 模块（同签名同语义：stderr 可注入出口，§10 的纪律不变）；`lib/host.js` 的动态 import 段整体删除 |
| lib 下的 preset-ownership 模块 | 无存留引用（仅被生命周期模块与卸载命令引用，随删） |
| tools 下的 uninstall-preset 命令 | README 的兜底命令段改写为 0.1.7 三步卸载（R17：不得依赖人工兜底命令；"无残留"由机制成立，见 §20.1） |
| test 下的 preset-lifecycle 测试 | 随机制删；stderr 审计出口的判据由 `test/index.test.mjs`、`test/two-planes.test.mjs` 承接 |
| presets 下的 dsh-async 模板目录（两文件） | 内容并入 §20.2 的补丁 `presets/dsh-async.patch.yml`；`files` 数组的 `"presets"` 保留（装新补丁） |

### 20.4 `tools/validate-preset.mjs` 重写（判据随形态换）

校验对象从"预设目录模板"换成 dsh-async 预设补丁（§20.1 的待创建件），必查项（每条都能红）：

1. 补丁恰一条 `insert`，行 `name` 是 `@deepseek-ai/dsh-agent-preset`，`config.id` 是
   `dsh-async`，行 `id` 是 `preset-dsh-async`；
2. 子清单里 `tool-bash` 行 `disabled === true` 且**不是**平台表达式（R20 的静态面）；
3. 子清单**不含** `@deepseek-ai/dsh-tool-pwsh`，也**不含** `@deepseek-ai/dsh-workflow-worker-thread`
   （后者点名写死：0.1.7 已移除的包）；
4. 恰四行 `dsh-async-tools`，`toolName` 恰为四个值之一且无重复；
5. persona `prefix` 含 §18.4 的四条锚句（锚句原文不变：`ALWAYS` + `run_in_background: true`
   + `never pass run_in_background: false` + `Do not poll in a loop`）；其中
   `never pass run_in_background: false` 一句为此而补：缺了它，"显式传 false"
   的反向禁令就没有静态守卫（反恒真要求）；
6. 预设行**不得**出现 `disabled` 护栏（护栏方案实测否决——判据反转）。

---

## 21. 设置承载与描述刷新通道（R10 / R21，0.1.7 形态）

> 依据：机制调研（`[@deepseek-ai/dsh-settings@0.2.0-rc.2]` 与 `[@deepseek-ai/cordis-plugin-loader@~1.0.5]` 的行号亲读；R38 §37.5 重锚表）。

### 21.1 事实底座（三条硬事实）

1. **表单发现**：SettingsForms 只暴露 entry Config 里 `.volatile()` 的字段
   （`dsh-settings/lib/index.js:118-131` 的 `volatileForm`、`:415-419` 的 describe）；
   2. **写路径**：设置页 → `remote.settings.mutate` → `configEditor.edit`（profile patch
   落盘）→ Loader 判定 volatile-only → **就地提交、fiber 不重启**，只向**拥有该 fiber**
   派发 `'loader/volatile-update'`（`cordis-plugin-loader/lib/index.js:393-425`、类型声明
   `lib/types/index.d.ts:24-29`）；volatile 值是**纯拉式 Ref**（`cosmokit createVolatile`，`{get}` 无订阅）；
   3. **枚举范围**：configEditor 的 `entries()` 只收 **parent tree 是根 include** 的条目
   （`dsh-config-editor/lib/index.js:30-35`）——预设子树里的四条工具行**不进设置表单**，
   只有宿主行 `async-tools-host` 出一张表单。⇒ **单一共享 `Config`（toolName 可选 + 预算
   字段与语言字段全部 `.volatile()`）即可**，不需要拆两份 schema。

### 21.2 取值链：模块级活快照（取代 `settings.get(ns)`）

`lib/config.js`：`BUDGET_FIELDS` 与 `LANG_FIELDS` 的每个字段加 `.volatile()`
（`toolName` **不加**——行级选择，改它本来就该换行）。`lib/settings.js` 重写为
**快照提供者**：

- **宿主半边**（`lib/host.js` 重写后）：apply 时把 `ctx.config` **解包成普通值**存进
  模块级活快照（volatile 字段在 fiber 里是 Ref，读法 `v?.get?.() ?? v`；解包**必须先于**
  `resolveConfig`——夹紧函数只认普通数）；并 `ctx.on('loader/volatile-update', …)`：
  重新解包 → 更新快照 → `notifySettingsChanged()`（总线，见 §21.3）。disposer 撤销监听。
  **不再调用任何 settings 服务方法**——表单由 schema 声明，写入由 host 的 configEditor
  完成，宿主半边从"注册者"退位成"订阅者"。
- **工具行**：`getConfig` 的可变间接层照旧（`makeConfigView`），但取值来源换成
  `() => mergeConfig(模块级快照, 本行 rawConfig)`：快照存在用快照，不存在（宿主行未
  装载——预设被引用而 bundle 不在的部署）退回本行配置默认值（设置不可用时工具仍可用，
  且接线状态必须说出来）。
- **行键不变量沿用**：`toolName` 永远来自本行 rawConfig，不进快照合并的覆盖面
  （防回潮理由见 `lib/settings.js` 注释）。

### 21.3 描述刷新：refresh-bus 保留，只换信号源

`defineTool` 构造期固化描述字符串的根因不变 ⇒ 就地重写 + 通知的模式不变
（`lib/index.js` 的 `refreshToolDescriptions`、`lib/refresh-bus.js` 的模块级登记表全保留）。
信号源与取值：

- **信号源**：宿主行 fiber 上的 **`'loader/volatile-update'`**（官方、owning-fiber-only，
  `cordis-plugin-loader/lib/index.js:393-425`）；
- **取值**：模块级活快照（§21.2）。

跨平面共享的前提仍是"两条装载解析到**同一个模块实例**"——BUS_ID 断链诊断保留；
0.1.7 的预设子树是内存 Loader 树，解析路径是否仍合一**没有静态保证**，因此
"改设置 → 描述数字变"必须是**端到端判据**（§26），不能只靠单测。

### 21.4 R21 的秒数读数：**路线 2（卡片内呈现，形态见 §29）**——择路依据

- **路线 1（`.role('ms')` 交给设置面渲染）已被证据否决**：0.1.7 全部客户端里唯一被消费
  的 role 是 `'secret'`（服务端脱敏，`dsh-settings/lib/index.js:24`）；`meta.role` 虽随
  form 传到客户端（`plainSchema` 只删 `meta.volatile`），但**没有任何渲染逻辑**消费它
  （各 client-ui 包 grep 到的 `role` 全是内嵌 schemastery 定义或 ARIA role）。
  "role('ms') 有渲染消费"这个未验证项就此核销：**不成立**。
- **路线 2 落地**（挂载路径按 keyed 槽写法重写 `client.js`）：
  - 注册进插件管理页的 **`plugins.bundle.config`** keyed slot：register options 必须带
    **`key`**（缺 key 抛错），本包键 = **包名 `dsh-async-tools`**（落点裁决见 R24）。
    宿主把它渲染在**插件页的描述与组件行之间**（`[@deepseek-ai/dsh-client-ui-plugin-manager] client.js:1915-1919`，
    该区是否出现由 `keysOf("plugins.bundle.config")` 账本决定 `:62`）——设置就在插件页上，
    不进任何组件行的子页。`ctx.configForms.whileServed(["async-tools-host"], …)` 守卫保留——
    宿主行不在或表单未 served 时不注册卡片；
  - 表单**由卡片自取**：bundle 槽的 owner props 只有 `{view}`（**不传** `form`），所以走
    `ctx.configForms.get("async-tools-host")`，按 **entry id**（`async-tools-host`，不是包名）对准，
    并**自己订阅**快照替换重渲染——bundle 槽没有"页面主把新 `form` 传进来"这条刷新路径。
    卡片的形态、暂存与保存链路由 **§29** 定稿（R27 起改用官方共享控件）；写入落
    profile patch 本行 `config:`（设置承载就是"行 Config 里标 `.volatile()` 的字段"）；
  - `package.json` 的 `dsh.client.inject` 换成样板三件：
    `["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings",
    "@deepseek-ai/dsh-client-ui-plugin-manager"]`（**不含** `dsh-client-runtime`）；
  - 毫秒字段的换算读数（如 `= 20 s`）由卡片现算——不写死、不经服务端往返；R21 的两条读数
    （生效 + 当前输入）与承载位置见 **§29**。
- **判据**（R21 验收的落点；两段口径以 §29.3 判据 10 为准）：保存后**生效段**随之变化且与生效值一致；
  **未保存**时在输入框里键入 → **输入段**当场变（端到端：改值 → 读说明行的两段读数 → 再从工具描述/
  行为核对生效值）。
- 字段 description 里同时写明单位（"in milliseconds"）作为 schema 面的补充。
- ⚠️ 卡片挂在插件管理页的**本包插件页**上（`plugins.bundle.config` keyed slot）；Settings 对话框的
  插件区只剩**只读** inventory。组件行的专属配置页是另一条落点
  （`plugins.row.config`），本包不用——整包预算不属任何单个组件行。
  §17.5 的"验收落在用户可见层"纪律照旧：判据必须落在**插件管理页的 DOM**。

### 21.5 故障姿态

- 宿主行 apply 的任何异常**不得**升级成启动失败（try/catch + stderr 留痕，`notice`
  模块出口，§20.3）——宿主行死了卡片整个消失，同一条铁律。
- 快照缺失/解包失败：工具行退回本行默认值并**说出口**（stderr 一行，注明"设置未接线，
  工具用出厂默认"）——防"静默早退"缺陷（`lib/settings.js` 的防回潮注释保留）。
- `'loader/volatile-update'` 监听器挂在宿主行 ctx 上、随 fiber dispose——R4 可逆性不变。
- **跨字段违例可被设置页持久化（已知行为与恢复路径）**：设置保存只做
  逐字段校验（`dsh-settings` 的 `write()`），loader 就地提交也查不出藏在
  `resolveConfig` 函数里的跨字段规则——schema 面表达不了（`Schema.transform` 包装
  根对象会让 `volatileForm` 返回 undefined、**表单整体消失**，`[@deepseek-ai/dsh-settings@0.2.0-rc.2]
  lib/index.js:122-131`；schemastery 3.18.4 无对象级 validate 回调）。
  链路与姿态：非法提交先落地（raw 持久化、卡片显示原始值、工具快照保旧值 + warn）
  → 下次重启宿主行**降级运行**：回退出厂默认快照 + stderr 说明、**行保持激活**
  （行死了 `describe` 只收 `state === 2` 的行、卡片整个消失，用户就失去应用内
  修复通道）→ 用户在卡片上改正保存即自愈（volatile-update 重物化接管）。
  单测：`test/index.test.mjs` T12-①/①'（降级 + 自愈两拍）。

---


## 22. jobs / shell 契约重映射（R15）

执行流程（§4/§5/§6）**不变**，本节只换 API 调用点（现行 `ctx.jobs` 契约：`start/list/get/read/kill/wait` 等全签名；`ctx.shell` 的启动面是 `await execute()`）。`[0.2.0]` 行号
为 0.2.0 树亲读（R38 §37.5 重锚）。

### 22.1 shell：`resolve` + `execute`，让出语义显式化（`lib/jobs.js`）

| 项 | 现行做法 | 依据 |
| --- | --- | --- |
| 解析 | `ctx.shell.resolve({command, workdir, dshEnv, sandboxPolicy?})`（jobs.js:577） | `[0.2.0] dsh-shell/lib/types/index.d.ts:61` |
| 到期策略 | request 显式带 **`onExpiry: 'none'`**——R1 的"不让 executor 杀进程"是显式策略；`'none'` 一个定时器都不装 | `[0.2.0] dsh-shell/lib/types/types.d.ts:41-48`、`index.d.ts:39-40` |
| 启动 | `await ctx.shell.execute(spec)` → `ShellExecution`（**extends** ShellProcess：`status/exitCode/signal/done/readOutput()/kill()`，句柄消费点全走这五个面） | `[0.2.0] dsh-shell/lib/types/index.d.ts:69`、`types.d.ts:159-226` |
| 后台判据 | **永不调用 `exec.result()`**——官方后台判据："前台是调用方 await 什么，不是 spawn 的属性"；不调 `result()` 就是后台，句柄不因停止等待而死 | `[0.2.0] dsh-shell/lib/types/index.d.ts:25-30` |

`done` 永不 reject（spawn 失败也 settle 成 killed、错误写在读路径，`types.d.ts:184-188`）：
§4.2 竞速段的终态判定改为"`done` 落地即终态"，错误文本从 `readOutput()` 的 delta 取。

### 22.2 jobs：注册、输出、读、等（`lib/jobs.js` / `lib/wait-job.js`）

服务面（`[0.2.0] dsh-jobs/lib/types/index.d.ts:71-137`）：`start/list/get/read/readAt/
kill/wait/remove`——`get`（存在性屏障）与 `list` 不用换名。

| 用途 | 现行做法 |
| --- | --- |
| owner / caller | **`exec.agent?.id`**（0.1.7 的工具执行上下文仍携带完整 Agent 句柄、`Agent.id` 即 SessionId；可能缺席，全程 `?.`，照 `dsh-tool-jobs` 写法） |
| 注册后台作业 | `start({kind, label, owner, outputLimitBytes, output: [拉式源], run(job) { …启动…; return { cancel(reason), done } }})`——`run` 被**同步**调用一次、必须同步返回 hooks；抛出则什么都不注册 | 
| 作业输出 | JobSpec 声明拉式源 `output: [{channel:'stdout', read(fromByte)}, {channel:'stderr', …}]`，直接包 `exec.observed.stdout/stderr`（非消费偏移读）；registry 按自己的节奏 pump、settle 前最后 drain，插件侧不轮询 |
| 增量读 | `jobs.read(id, caller)` → `{chunks, lossy, result?, job}`——`output.js` 渲染层按 channel 把 chunks 拼成 text |
| 有界等待 | `jobs.wait(id, timeoutMs, caller, abortSignal)`——**超时是 resolve**（带回当时的 JobView）；插话打断 = abort 置位 → reject `wait aborted`（仅存活期） |
| 让出分支终态复查（§4.5；dsh-jobs-local 上"注册即终态"的同步复查永不命中——`spec.run()` 同步调用而结算至少晚一个 microtask） | `jobs.get(id, caller)` 返回 JobView，状态非 running 即终态 |
| 取消（用户显式） | hooks.cancel 内 `handle.kill()`（幂等）；模型的 `job_kill` 走 registry `kill`（本插件不代理） |

### 22.3 `wait` 语义对 §5.2 的实现修正

- 超时是 resolve：`wait` resolve 回 JobView 后**看状态**——终态取
  `result`；running 返回 still-running 句柄。错误分支少一类；**另有**"resolve 回的
  view 可能仍是 running"的判定（假件必须实现这两条路径，不许宽容）。
- **到期双源合并规则**：本地 `deadline` 定时器与 `jobs.wait` 的超时
  resolve 是**同一个预算的两条到时信号**（传入 `wait` 的 timeoutMs 与本地 deadline 同值）。
  合并规则三条：① 任何一条先到都进**同一个**处理分支——先复查快照
  （R29-c 起为 `jobs.list` 基的三分快照，§31.3），
  **终态判定只认快照**，不看"谁先响"；② `waited_ms` 一律用本地 `Date.now()` 差值计量
  （两条信号近似同时到，差值不影响语义）；③ `wait` resolve 回终态 view 的窄窗口
  （作业恰在超时前一刻结算）同样走 ①，不得因"是超时路径"而误报 running。
- 插话打断改 `AbortController`：打断路径 `controller.abort()` → `wait` reject → 返回
  interrupted；"abort 释放 waiter"由实现保证（`[@deepseek-ai/dsh-jobs-local] lib/index.js:632/:643`）。
- 在途等待的撤销仍在 `finally`（R4 可逆性不变）。

---

## 23. 依赖与 peer 校验申报（R15）

照抄上游形态（`[@deepseek-ai/dsh-tools@0.2.0-rc.2] package.json`：运行时服务契约全放 peerDependencies
精确锁 **`0.2.0-rc.2`**（R38 §37.1 升锁、R44 更换锁定版本；上游同款精确锁惯例见
`[@deepseek-ai/dsh-tool-jobs@0.2.0-rc.2] package.json:32-39`），只有叶子库进 dependencies；peer 校验只看
`@deepseek-ai/dsh` 与 `dsh-*` 条目，cordis/cosmokit 不查）：

```json
"dependencies": { "@deepseek-ai/schemastery": "~3.18.4" },
"peerDependencies": {
  "@deepseek-ai/cordis": "~4.0.4",
  "@deepseek-ai/cordis-plugin-timer": "~1.1.6",
  "@deepseek-ai/dsh": "0.2.0-rc.2",
  "@deepseek-ai/dsh-jobs": "0.2.0-rc.2",
  "@deepseek-ai/dsh-llm": "0.2.0-rc.2",
  "@deepseek-ai/dsh-sandbox": "0.2.0-rc.2",
  "@deepseek-ai/dsh-shell": "0.2.0-rc.2",
  "@deepseek-ai/dsh-shell-env": "0.2.0-rc.2",
  "@deepseek-ai/dsh-subagent": "0.2.0-rc.2",
  "@deepseek-ai/dsh-typert-protocol": "0.2.0-rc.2",
  "@deepseek-ai/dsh-tools": "0.2.0-rc.2"
}
```

逐项依据（口径 = 上游 `dsh-tool-jobs/package.json:32-39`：**服务依赖也进
peer**，尽管它一行都不 import `dsh-jobs`——换取代际核查覆盖）：

| peer | 性质 | 依据 |
| --- | --- | --- |
| dsh | 平台 | peer 校验的锚（`[@deepseek-ai/dsh-app-boot@0.2.0-rc.2] lib/index.js:294` 只认 `@deepseek-ai/dsh` 与 `dsh-*` 前缀） |
| dsh-tools | **import**（`defineTool`，`lib/jobs.js:22` 等） | 直接代码依赖 |
| dsh-sandbox | **import**（提权函数，`lib/jobs.js:23-26`，R11） | 直接代码依赖 |
| dsh-jobs | **服务**（`ctx.jobs`） | 上游 `dsh-tool-jobs:37` 同款（服务消费也锁版） |
| dsh-shell | **服务**（`ctx.shell`） | 同上口径 |
| dsh-shell-env | **服务**（`ctx.shellEnv`） | 同上口径：`lib/index.js` 的 inject 声明 `shellEnv`、`lib/jobs.js` 调 `ctx.shellEnv.collect`（"零服务消费"误判） |
| dsh-subagent | **服务**（`ctx.subagents`） | 同上口径 |
| dsh-typert-protocol | **import**（`TypertRemoteService`/`Remote`，`lib/ask-takeover.js`，R30/§32.6） | 直接代码依赖，精确锁 `0.2.0-rc.2`（R38 升锁、R44 更换锁定版本） |
| dsh-llm | **import**（`createUserMessage`，`lib/ask-takeover.js`，R30/§32.5） | 直接代码依赖，精确锁 `0.2.0-rc.2`（R38 升锁、R44 更换锁定版本） |
| cordis / timer | 运行时 | `~` 上游同款（timer 1.1.4→1.1.6 的工具注册面逐字未变） |

- **为什么 dsh-* 用精确版**：让强制 peer 校验"为本包工作"——宿主代际不对时本行
  显式停用并告警，避免解析出第二份旧实现静默漂移（R15 点名的
  "两份不同代际"风险）。
- **R15 验收判据**（旧关键词恒真——启动路径根本不输出它）：
  1. `npm ls @deepseek-ai/dsh-tools`（及 dsh-sandbox）解析路径与宿主同代际、无双版本；
  2. 启动日志（字节游标新增段）无 `is incompatible with dsh`（这是
     `pluginCompatibilityWarning` 的实际文本，`[@deepseek-ai/dsh-app-boot@0.2.0-rc.2] lib/index.js:320-323`；
     `incompatible-version` 只是 plugin-manager 管理面的 ManagementFailure code）；
  3. 行为面：预设会话的工具清单里四个 async 工具在列（行未被停用的可观察证据）。
  变异验证：把任一 peer 临时改成不兼容部署，判据 2 必须变红。

---


## 24. 模型面文案的口径（R22，由 R25 改写）

### 24.1 口径：什么算"面向模型"

| 类别 | 例 | 处置 |
| --- | --- | --- |
| 工具 `description`、参数 `description` | 四个工具的描述与参数说明（`lib/descriptions.js` 的 `buildToolText`） | **来自 `lib/text.js` 的 `en` 档（默认）；`agentLang:'zh'` 时取 `zh` 档** |
| 返回体 `note` / 状态文案 / 摘要 | `lib/output.js` 的 note/digest 构建器（接受 `lang` 参数） | 同上 |
| 执行期抛给模型的错误串 | 各工具的 `error.*` 文案 | 同上 |
| 代码注释、logger 行、stderr 审计行 | `lib/settings.js` 的 reason、notice 模块出口（§20.3） | **保持中文**（操作者面，不进模型上下文；§10 的 stderr 审计纪律不变） |
| 预设的 `name`/`description`（设置页 UI） | 补丁内联值（§20.2） | **保持中文**（给人看的，不在模型面口径内） |

判别式一句话：**会被 `render()` 进工具结果或进工具 schema 的文本 = 模型面 = 来自
`lib/text.js` 双语表（默认 `en` 档）；只到 stderr / 日志 / 设置页的 = 人面 = 维持中文。**

### 24.2 描述刷新：整段重建（§27.3）

- 每个工具的描述与**每个参数说明**由 `lib/descriptions.js` 的 `buildToolText(name, config)`
  整段构建：数字取自传入的生效配置（R5，现读现取），文案取 `t(config.agentLang, …)`。
- 构造处（各 `create*Tool`）与刷新处（`lib/index.js` 的 `refreshToolDescriptions`）调
  **同一个函数**，两处不可能漂移；刷新同时写回主描述与每个参数说明。
- 锚点正则就地改子串的旧刷新机制已移除（现行机制见 §27.3）。

### 24.3 判据（能红）

1. **check-model-text 检查器**（`tools/check-model-text.mjs`，四层）：① `TEXT.en`
   每个键的串零 CJK；② `TEXT.zh` 每个键都含中文（缺译即红）；③ 两档键集相等
   （少一个键就是少一句提示）；④ 兜底层——源码扫描与硬编码文案层（`lib/*.js`
   剥注释后零 CJK，"像句子的字面量"必须来自 `lib/text.js`，操作者面按逐条给理由的
   白名单放行）与运行时层（两档各构造四个工具，取全部模型可见串比对：en 零 CJK、
   zh 与 en 同位串不同且含 CJK）。运行时取串而不是源码 grep——运行时串正是模型
   看到的串。变异证明：`verify/mutate-model-text.mjs`（10/10）。
2. **既有链不断**（R22 验收末句）：`test/agent.test.mjs` 的"自由文本 provider 连续刷新"
   与"描述数字随设置变"用例（T3/T3b/T10），以及 T22 的"改语言后整段换文案
   （含每个参数说明）"用例，全部按整段重建口径断言。
3. **端到端**（验证实例，端到端层；§27.5）：从真实 `request/header` 读回四工具 schema，
   `agentLang:'en'` 档下无 CJK；切 `zh` 后描述换中文档且预算数字仍随设置变。

---

## 25.（撤空——R16 已废除）

编号不回收；现行立场见 `docs/requirements.md` §3 非目标的 PTC 条（历史在 git）。

---

## 26. 测试设计增补（R18；并入 §11 的三层结构，0.1.7 基线）

### 26.1 单元与接线（单元与接线层，本机）

| 对象 | 改动 | 判据要点（都能红） |
| --- | --- | --- |
| `test/_helpers.mjs` 的 jobs 假件 | 按新契约重写：`wait(id, timeoutMs, caller, signal)` 实现**超时 resolve 活视图**与 **abort reject** 两条路径；`read` 返回 `{chunks,lossy,result?,job}`；`start` 收 `run(job)` 同步 hooks + `output` 拉式源 | "假件不许宽容"纪律沿用：缺一条路径，对应工具用例必红 |
| shell 假件 | `execute(spec)` 返回 ShellExecution 形状：`done` 永不 reject、`readOutput()` 消费型、`observed` 偏移读、`kill()` 幂等；`resolve` 保留 request→spec | spawn 失败 settle 成 killed 且错误在读路径（§22.1） |
| subagents 假件 | `interrupt` 补第二参（authority：`{kind:'user',parentSessionId}` 或 `{kind:'ancestor',agent}`——0.1.7 起双参）；`listChildren(parentId, signal?)` | 单参假件会让"打断等待 ≠ 打断工作"恒真 |
| `lib/settings.js` 重写（§21.2） | 快照合并两态（快照在/不在）、volatile Ref 解包（假 `{get}`）、`toolName` 永远来自本行 | 同型缺陷的反面 |
| 宿主半边（§21.2） | `'loader/volatile-update'` → 快照更新 + `notifySettingsChanged`；disposer 撤销监听 | R4 可逆性 |
| 静态断言（`index.test.mjs`） | inject 扫描不变（七服务，`sessionProjections` 随 R13 加入）；**新增**：BUDGET_FIELDS 每字段 `meta.volatile === true`、`toolName` 无 volatile | 去掉一个 `.volatile()` 必红（端到端层则表单消失） |
| `two-planes` 测试 | T5 的 bundle.patch 断言改**数组形态**（R26 后恰三项：宿主补丁 + 两份预设补丁，末项在盘）；T5④ 宿主行无 `toolName` 保留；新增 `dsh.client.inject` 恰为官方样板三件（`dsh-client-locale` / `dsh-client-ui-settings` / `dsh-client-ui-plugin-manager`） | 漏一项 = 假绿（纪律 11） |
| `validate-preset` 重写 | §20.4 的六条 | 每条单独能红 |

### 26.2 变异（"删保护会变红"的抽查）

1. 删一个字段的 `.volatile()` → 26.1 静态断言红（端到端层：设置表单消失）。
2. 预设补丁 `tool-bash` 改回平台条件 → `validate-preset` 红。
3. 描述塞回一个中文字 → check-model-text 检查器红（§24.3）。
4. `wait` 超时改回 reject → wait-job 的"resolve 回 running 视图"用例红。
5. `buildToolText` 的数字取自传入配置以外的来源（或刷新漏写某个参数说明）→
   T3/T3b（数字链）与 T22（参数说明整段换）用例红。

### 26.3 端到端（端到端层；证据一律取自验证实例，D11）

并入 §11.2，新增/改写：

1. **升级序列**：升级前记录其他插件状态（同 profile 的三家第三方插件）→ 验证实例升 0.1.7 → 部署本包 →
   冒烟（四工具出现）。
   **已验（含一处不可复现的缺口，如实记）**：升级、部署与冒烟三段都有验证实例上的证据——
   §26.3.8 `sibling-coexist` 6/6（profile 的 bundles/patch/junction 三件齐、错误日志 `is incompatible with dsh`
   命中 0、宿主命名空间在线、同 profile 的审批类插件有运行期决策日志即"在工作不是只挂载"）、
   §26.3.1 `face` 7/7（四个 `async_*` 出现在模型实际收到的工具面里）、R17 那一轮还做了
   卸载→重启→复原→重启的完整往返。**"升级前"的那份快照不可复现**：实例早已升到 0.1.7，
   当时的前值没按序列留档；它的判别目的由上面的**升级后**读数承接（"其他插件有没有被打坏"
   已由 `incompatible` 命中 0 + 审批类插件运行中回答）。要补齐完整序列，只能在
   另一次真实升级（别的实例或下一次升级）上留证——不得用现在的读数倒填"升级前"。
2. **R15**：`npm ls` 同代际核对；启动日志无 `is incompatible with dsh`；本包行未被停用（详§23）。
3. **R17 卸载无残留**（独立判据）：安装 → 使用 → 卸载 → 重启 → (a) 预设花名册无
   `dsh-async`；(b) 默认预设可解析（`session/create` 不报 `agent-preset/not-found`）；
   (c) 对照预设工具面貌与安装前逐项一致；(d) `%DSH_HOME%\.agent-presets\dsh-async`
   目录不存在（升级期一次性清场 + 卸载后均不得残留——新形态从不写它，
   旧安装的残骸在升级序列删除，§19.1）。
   **已取证（四段全中）**：装卸由 `verify/r17-uninstall.ps1`
   （`-Action Uninstall|Restore|Status`，先备份 package.json、写完用 node 校验 JSON、
   不合法即刻回滚）执行，重启走进程树外的 `Restart-Service`（服务管理器下的托管服务）。读数：安装态
   `face` 7/7、async 面 29 件、standard 面 26 件、命名空间 18；卸载 + 重启后
   (a) `session/create` 报 `agent-preset/not-found`「Unknown agent preset: dsh-async」，
   `available=["standard","ptc","minimal","cordis"]`；(b) `control` 相 2/2（standard 会话建成）；
   (c) standard 面仍 26 件、`async_*` 命中 0、含 `pwsh`，与安装态逐项相同；
   (d) `.agent-presets` 目录项数 0。复原 + 重启后 `face` 复跑 7/7（命名空间回 18、
   设置回出厂默认）。读数归档于验收时的探针脚本输出（`verify/` 下同名脚本重跑可复现）。
4. **R21 + §21.3 跨平面链**：改一个预算字段 → 卡片"= N s"读数变化 → 从
   `request/header` 读回的工具描述数字同变。**附加**：改设置的字节游标
   新增段里**无** `async-tools-host` 的重新装载行（volatile 提交不得退化成 fiber 重启，
   `cordis-plugin-loader/lib/index.js:406` 的 deepEqual 对 Ref+夹紧产物的行为只有运行时
   才能证实）；对照变异：改**非** volatile 字段（如 `toolName`）必现装载行——
   两个方向都能红才算判据成立。
   **附加（三态链，§21.5 登记的已知行为）**：(a) 保存跨字段违例（`minWaitMs`
   改到大于 `maxWaitMs`）→ 卡片显示原始新值、工具描述数字**不变**（快照保旧值）、
   stderr 有告警；(b) 重启 → 宿主行仍在（卡片可读）+ 工具按出厂默认运行 + stderr
   有降级说明；(c) 卡片上改正保存 → 快照与描述恢复跟随。
5. **R22**：`request/header` 读回四工具 schema，`agentLang:'en'`（默认档）下无 CJK；
   切 `zh` 后描述换中文档（R25 的语言维度与 R5 的数字链同判，§27.5）。
6. **R20**：Windows 侧取证（含四个 `async_*`、无 `bash`/`pwsh`）；Linux 侧按
   登记待补（判据不得当作已验证）。
7. §11.2 既有 1–9 项在 0.1.7 上重跑（让出/插话/打断/隔离/回滚）。
8. **第三方插件同 profile 共存**：其他插件升级后逐个量（同 profile 的审批类、子代理路由类、重启类三个插件）
   的工具面貌与设置卡片。
9. **R13 模型选择（新代码部署后）**：会话里 `async_agent` 传
   `provider: zai, model: glm-5.3`（该路由在验证实例会话的 model-selection-policy
   白名单内）→ 子代理 descriptor 的 `agentProvider`/`agentModel` 为
   `zai`/`glm-5.3`（子会话转录的 `subagent/descriptor` 事件，核法即比对 descriptor 的路由字段）；对照半边：不传
   路由的调用，descriptor 与父路由一致；越界路由当场报
   `not allowed for this Session`。这正是"传参被吞、路由未变"失效形态的反向真机判据。
   **读子会话转录的寻址形态**：子会话 id 是裸 UUID，且必须用
   `{kind:'subagent', parentSessionId, childSessionId, mode}` 寻址（用 `{kind:'session'}` 会被
   `session/agent-busy` 拒），游标取 `session/projections` 的 `asOfSeq`（`throughSeq:-1` 是空页）。
10. **R24 界面可用性（设置面迁移的判据；判据必须是注入表或页面 DOM，不用后端返回）**：
    ① **注入表**：首页 HTML 的 preload combo 行必须列出 `dsh-async-tools/client.js`，且该行取回的
    **下发字节**（剥掉注释后）里含 `AsyncToolsBundleCard` 与 `plugins.bundle.config`、不含
    `plugins.row.config` 与 `plugins.item`
    （驱动相位；探针读数由 `verify/mutate-r24-ui.mjs` 重跑可复现；落点换槽前后两个字符串断言方向相反，
    所以能变红）；
    ② **入口前置**：包名同时出现在 profile 的 `dependencies` 与 `bundles`，页面从 loopback 源
    （验证实例的 loopback 入口 `http://127.0.0.1:<端口>/`）打开——两条在验证实例上现读核对；
    ③ **插件页放置与往返（已取证，7/7）**：`verify/_visual/probe-r24-bundle-config.mjs` 在真实页面上
    走 插件 → 「查看 dsh-async-tools」→ **本包插件页本身**（不点任何组件行）：判据是
    ①放置（`pageKind=bundle`、设置区在插件页内、排在组件行**之前**、组件行里**没有** configure 控件）
    +②**按身份**断言"逐项等价"（每个控件的身份（现行 `name`／R27 起官方控件的 `id`）与
    `lib/config.js` 的 `BUDGET_FIELD_KEYS` + `LANG_FIELD_KEYS` + `FLAG_FIELD_KEYS`
    + `ASK_FIELD_KEYS`（10 预算 + 2 语言 + 2 开关 + 2 提问接管）一一对应，缺项/多项都点名；
    **16 项全部可写**；
    **带秒数读数的字段集合恰好等于 `MS_FIELD_KEYS`
    的 8 个毫秒字段**——只数个数抓不到"读数挂错字段"）+③改 `pollIntervalMs` → 保存 →
    `profiles\web\cordis.patch.yml` 出现 `pollIntervalMs: 4321`、
    **该字段说明行的生效读数跟着变成 `4.32 s`**（这一条同时证明卡片自己订阅了控制器）+④复原后落盘覆盖
    消失、读数回到 `0.5 s`。判据读数由 `verify/_visual/probe-r24-bundle-config.mjs` 现跑产出（截图留档可复核）；
    判据本体在 `verify/r24-judgements.mjs`（纯函数），由 `verify/mutate-r24-ui.mjs` 的 **30 条变异**
    证明可被推翻（退回行槽、挂官方槽、字段身份错位、某项被禁用、读数缺失或挂在非毫秒字段上、
    设置区不在插件页/排到组件行之后、组件行还留着 configure 控件、读数不跟新快照、
    落盘没出现该覆盖却报成功…）。**R27 起**：控件身份改锚官方输入件的 `id`、"页面显示已保存"不再是
    证据（成功与否看"字段回到生效值 + 落盘命中"，失败看页脚失败文案）、**读数断言按两段**
    （生效段 + 输入段，§29.3 判据 10）——本段的形态与保存判据以 §29 为准。

### 26.4 沙箱备注

默认沙箱下 `node --test`（子进程隔离）与 `tools/check-syntax.mjs` 跑不了（spawn EPERM，已证）；
进程内形态可以跑：`npm run test:inproc`（`--test-isolation=none`）与判据脚本里的纯函数部分。
单元与接线层的"全绿"必须在无沙箱会话补跑一次 `npm test` 才算数（README 验证步骤同步此口径）。

---

## 27. R25：中英文双开关（展示面与 Agent 面各自独立）

### 27.1 两个字段

| 字段 | 取值 | 默认 | 作用面 |
| --- | --- | --- | --- |
| `uiLang` | `"auto" \| "zh" \| "en"` | `"auto"` | `client.js` 的可见文案（字段标签、提示、按钮、状态） |
| `agentLang` | `"en" \| "zh"` | `"en"` | 四个工具的描述、参数说明、`note`/`detail`、render 文本、抛给模型的错误 |

两个字段都在宿主行 `Config` 上标 `.volatile()`（否则表单里不显示也写不进——表单发现只认 volatile 字段），
进 `lib/config.js` 的 `LANG_FIELDS`（与预算字段表分开：`BUDGET_FIELDS` 保持 10 个预算字段），
由 `resolveConfig` 归一并做值域校验（未知取值 fail-fast，不静默回默认值——静默回退会让
"我明明选了中文"变成一句无法诊断的错觉）。

### 27.2 模型面文案：一张双语表 + 取值函数（`lib/text.js`）

- 所有模型可见字符串搬进 `lib/text.js` 的 `TEXT = { en: {...}, zh: {...} }`，键为点分命名
  （`tool.run.description`、`param.run.yield_ms`、`note.yield.background`、`error.unknownJob` …）；
  取值走 `t(lang, key, vars)`（`{name}` 占位插值）。
- **两档的键集必须相等**：少一个键就是少一句提示；`check-model-text` 的第一层静态判据就是这条。
- 表里只放**文案**；数字、条件分支仍留在原来的构建逻辑里（`lib/output.js` 的 note 构建器
  接受 `lang` 参数，控制流不变）。
- 操作者面（stderr 通告、logger、注释）**不进表**：它维持中文，不属于 R25 的开关面。

### 27.3 描述刷新：整段重建

`defineTool` 构造时把 `description` 求值成字符串（§21.3），刷新不能靠就地替换子串——
改语言不是替换一处子串，而是换一整套句子。现行机制是**整段重建**：

- 每个工具在构造时登记一个**构建器**：`buildToolText(name, config) → { description, parameters }`
  （`lib/descriptions.js`），构造处与刷新处**调同一个函数**，两者不可能漂移。
- `refreshToolDescriptions(tool, config)`：`tool.description = build(...).description`，
  并把**每个参数说明**写回 `tool.parameters.properties[k].description`。
- 整段重建同时覆盖数字、provider 名与语言（`t(config.agentLang, …)` 现读）。
- 刷新链本身：volatile 提交 → 宿主行 fiber 收 `loader/volatile-update` → `refresh-bus`
  广播 → 工具行重建描述。判据 T3/T3b/T10（数字）与 T22（语言）的**行为**
  都跟着快照走。

### 27.4 展示面：本包自己选词典（不碰宿主语言）

- 词典仍注册进宿主（`ctx.locale.register(NS, DICTIONARIES)`，宿主按**全局**语言选——`"auto"` 时用宿主 `props.t`
  （现行行为），`"zh"`/`"en"` 时用本包自己的表；**不调** `locale.setLocale`。
- `uiLang` 与 `agentLang` 两个字段本身也渲染在表单里（字段数 10 → 12），所以保存后
  表单**当场**换语言（卡片订阅控制器的快照替换）。
- 词典仍注册（类型声明面要求给齐所有内置语言，运行时只拦重复注册），供 `"auto"`
  档与宿主页面复用。

### 27.5 判据

| # | 判据 | 落点 |
| --- | --- | --- |
| 1 | **互不牵连（正向）**：`agentLang` 从 `en` 改 `zh` → 真机 `request/header` 里的四个工具描述换语言；设置表单可见文案**逐字不变** | `verify/probe-lang-independence.mjs`（真机）；单测侧 T20 |
| 2 | **互不牵连（反向）**：`uiLang` 从 `auto` 改 `zh` → 表单可见文案整体换语言、字段 `name` 不变；工具描述**逐字不变** | 同上的另一段 |
| 3 | **整段重建**：改设置后描述里的数字**与**语言同时跟着快照走（R5 的链不能断） | T3/T3b/T10（数字链）+ T22（改语言后正文、尾部摘要与每个参数说明整段换） |
| 4 | **键集与翻译完整**：`TEXT.en` 零 CJK、`TEXT.zh` 每个键都有中文、两档键集相等；运行时层用两档各取一遍全部模型可见串 | `tools/check-model-text.mjs` 四层（判据明细见 §24.3） |
| 5 | **默认值**：出厂态 `uiLang:"auto"`、`agentLang:"en"`（改错默认值只静默改变所有人的界面语言与模型所见文案） | T17 的期望值表 |
| 6 | **字段面**：四组全部字段逐项在场可写（`lib/config.js` 现取，现为 16 = 10 预算 + 2 语言 + 2 开关 + 2 提问接管）、读数集合恰为 `MS_FIELD_KEYS` 的 8 个毫秒字段 | `verify/_visual/probe-r24-bundle-config.mjs`（期望集合四组现取，不写死） |

### 27.6 非目标

- 不改宿主全局语言（那会改整个应用）、不支持第三种语言、不切换 README/文档语言、
  不本地化 stderr 与日志（操作者面维持中文）。
- 非 page 视图的 `summary` 文案仍走宿主 `props.t`（宿主全局语言选），**不随 `uiLang`**——
  `uiLang` 只管 page 视图的表单文案；宿主对 bundle 槽只传 `{view:"page"}`，
  当前没有别的视图会渲染它。

## 28. R26：第二个 Agent 预设「异步创造模式」（`presets/dsh-async-create.patch.yml`）

### 28.1 定稿的设计裁决（决策 / 依据）

**裁决 A（派生入口唯一）：`async_agent` 是本预设唯一的派生入口；宿主 `tool-subagent` 与
`tool-subagent-fork` 行按基线保留但置 `disabled: true`（config 逐字保留，翻一行即回）。**

依据：
- R26 可验证段要求四行 async 工具**必须在场** ⇒ 「保留哪一个」的选择空间只剩 `async_agent`；
- R26 点名的危害是「两个语义相同、等待方式不同的派生工具而无判据」：宿主 `subagent` 自带
  前台模式（显式传 `run_in_background: false` 即阻塞整个批次），与 `async_agent` 的「永后台」
  结构性冲突。R35 起两份预设统一为结构性禁用（§35.1-3/4）；本预设自始
  就是**结构性禁用强于提示词约束**；
- 创造侧委托的实际形态是独立审查 / 研究子代理（完整 standalone prompt，九阶段流程自身的
  用法），与 spawn 语义吻合；fork 的上下文继承反而破坏审查独立性；
- 「行保留 + 禁用」可逆且有成例（`tool-ralph` / `tool-plugin-manager` 定向修改）。

代价（已接受；R35 起两预设同形）：两预设内都失去全功能委托参数面（fork、`toolFilter`、
`maxDepth`、`reasoning_effort`）——需要这些时翻活对应行（连带 persona 锚句与判据一起改，
见下）。`tool-subagent-control` / `tool-subagent-list-agents`（管理面，非派生入口）与
`workflow-ptc`（R34 的引擎服务行）保持在场；`tool-workflow` 行 R35-b 起禁用（编排
统一走 `async_workflow`，§35.1-2）。

不得再改：翻回 `subagent` 系属新一轮设计裁决，必须连 persona 锚句与
§28.4 判据⑦/⑧一起改，不许只翻行。

**裁决 B（标识与排序）：`config.id = dsh-async-create`，显示名「异步创造模式」，`order: 6`。**
依据：R26 建议 id 并授权设计定稿；shipped 四份补丁 order 为 standard=1 / ptc=2 / minimal=3 /
cordis=4（本会话现读四份补丁），本包 `dsh-async` 现值 5 ⇒ 6 是下一个空位。

**裁决 C（创作指导不写回 persona）：** 沿 0.1.7 基线——persona 只有一句身份 + 异步纪律 +
DELEGATION 硬规则；创作指导由 skill 系行承载（`skill-filesystem` 连同其 `customSkillDirs`
的 `!!js` 表达式**逐字保留**、`tool-skill` 在场）。R26 允许写回但须显式定稿——定稿为不写回
（与基线一致；cordis 补丁头部注释自述 "the skills own the preset-authoring rules"）。

### 28.2 定向修改清单（基线 = 0.1.7 shipped cordis 补丁；逐条给依据）

| # | 定向修改 | 依据 |
| --- | --- | --- |
| 1 | 行头：`id: preset-dsh-async-create`，`config.id/name/order` 按裁决 B，补 `description`（本包预设均显式带） | 裁决 B |
| 2 | `tool-bash`：`disabled: true` **布尔**（基线是 `!!js process.platform === 'win32'` 平台表达式） | R20/R26 实现约束 |
| 3 | `tool-pwsh` 行**不挂** | R6/R26「不做同步 shell」 |
| 4 | `tool-bash` 之后连续成组新增四行 `dsh-async-tools`（`toolName` 分派） | R26；`toolName` 分派成例（§18.4） |
| 5 | `tool-subagent` / `tool-subagent-fork`：`disabled: true`（config 逐字保留） | 裁决 A |
| 6 | `tool-plugin-manager`：`disabled` 从基线的 `!!js "!ctx.get('profileContext')"` 表达式换成**布尔 `true`** | R26 明文「与 dsh-async 补丁一致的定向修改」 |
| 7 | persona `prefix`：基线身份句之上追加异步纪律 + DELEGATION RULES（§28.3） | R26「按 R14 写入」+ 裁决 A |
| 8 | 预设行**不带** `disabled` 护栏 | 实测否决（dsh-async 补丁定向修改 8 同款） |
| 9 | 其余行与基线**逐字一致**，含组内整段 config 文本与行序 | R26「不得静默缺失」 |
| 10 | （R35 增）`tool-workflow` 置 `disabled: true`；`async-workflow` 行插 delegation 组内 `tool-workflow` 行后（本预设 persona 已是唯一入口句，无 persona 改动） | R35-a/-b（§35.1-1/2；行位判据 §35.3） |

定向修改后的行集合（与基线**逐项可对账**）：

- 顶层 23 行 = 基线 20 − `tool-pwsh` + 4 行 async，**按 cordis 的行序**（注意：cordis 的
  `skill-filesystem` / `tool-skill` 在尾部 `tool-cordis` 之后，不在 `tool-jobs` 之后——
  standard 才是后一种行序）；
- 嵌套行（R35 后）：planning（`plan-mode`）、compaction（`compaction-basic` /
  `command-compact` / `tool-result-pruner`）、delegation（`tool-subagent-control` /
  `tool-subagent-list-agents` / `tool-subagent` / `tool-subagent-fork` /
  `tool-subagent-codex` / `tool-subagent-claude-code` / `workflow-ptc` / `tool-workflow` /
  **`async-workflow`（R35-a，插 `tool-workflow` 行后）** / `tool-ralph`）——共 14 行；
- 交付：`package.json` 的 `dsh.bundle.patch` 数组加第三项；生命周期由 loader 拥有
  （预设声明随行进退），本包移除即预设消失；
- 同步面：`test/two-planes.test.mjs` T5 的 bundle 数组断言改**恰三项**
  （§26.1 已同步）；`README.md` 同步双预设花名册、三项数组与回滚步骤，并在测试一节注明
  `npm test` 依赖本机 0.1.7 证据树（P14 的对账用例缺树即红）。

### 28.3 persona 文本与锚句

`prefix`（`>-` 折叠标量，换行折成空格后按下述锚句匹配）。**公共段逐字同源**：开头到
「Never treat a returned job_id as a failure.」为止的异步纪律整段与 dsh-async 预设的
persona intro **逐字相同**（含 "Use `async_wait_agent` (bounded, interruptible) rather
than polling…" 一句）——两份补丁只有 DELEGATION RULES 段按各自的派生入口口径分叉；
变异 P16 守住这段不漂移。

```text
You are a coding agent powered by the {{model}} model.
This deployment runs commands ASYNCHRONOUSLY. `async_run` returns a job_id
instead of blocking when a command outlives its yield budget: when that
happens, keep working on other things and call `async_wait_job` later instead
of waiting idly or re-running the command. Use `async_wait_agent` (bounded,
interruptible) rather than polling when you need a background subagent's
outcome. Never treat a returned job_id as a failure.
DELEGATION RULES (hard rules, not advice):
1) Delegations are ALWAYS background. async_agent is the ONLY delegation
entry in this preset — it has no foreground mode. subagent / subagent_fork
are disabled here; do not call them.
2) When you need a subagent's result, wait with async_wait_agent (bounded
wait_ms). Do not poll in a loop; do not re-delegate just to check progress;
the final answer arrives as its own message.
```

锚句（判据⑤的期望，每句删掉都必须红）：`ALWAYS`、`async_agent is the ONLY delegation
entry`、`wait with async_wait_agent`、`Do not poll in a loop`。取值上没有
`run_in_background: true` / `never pass run_in_background: false` 两句——那两句管的是
**活着的**宿主 `subagent`（dsh-async 的情形），本预设里它被结构性禁用，正向句是
「ONLY delegation entry」。R26「按 R14 写入」据此落地为**语义等价、句面适配**（定稿
口径，验收按本节锚句判、不按 R14 句面逐字复查）：R26 :340-341 列的三个语义要素——
一律后台派生（`ALWAYS`）、需要结果时用 `async_wait_agent` 有界等待（`wait with
async_wait_agent`）、不许空转轮询（`Do not poll in a loop`）——全部在锚句里。

### 28.4 `tools/validate-preset.mjs` 参数化（判据随被测补丁切换）

期望集按 `config.id` 键控（`EXPECTATIONS` 映射），判据骨架共用、期望随套切换：

| 字段 | `dsh-async` | `dsh-async-create` |
| --- | --- | --- |
| `rowId` / `configId` | `preset-dsh-async` / `dsh-async` | `preset-dsh-async-create` / `dsh-async-create` |
| `baselineTop`（顶层行 id 序列，含定向修改结果） | 22 行（standard 基线 − pwsh + 4 async） | 23 行（cordis 基线 − pwsh + 4 async） |
| `baselineNested`（嵌套行 id 序列） | planning 1 + compaction 3 + delegation 10（含 `async-workflow`，R35-a） | 同左（两基线嵌套同构） |
| `disabledBoolean`（必须布尔 `true` 的行） | `tool-bash`、`tool-subagent`、`tool-subagent-fork`、`tool-workflow`、`tool-ralph`、`tool-plugin-manager`（R35 起两套同列） | 同左 |
| `workflowPtcProvider` | `'spawn'` | `'spawn'`（两基线同值；形态守卫不随参数化丢失，判据⑨） |
| `forbidden`（行 `name` 禁入） | `dsh-tool-pwsh`、`dsh-workflow-worker-thread` | 同左 |
| `personaAnchors` | 现四句（§20.4 ⑤；R35 起「唯一入口」锚句两套同值） | §28.3 四句 |
| `bothAliveRule` | **开**（R35 起对称；subagent 行已禁用，条件式守卫待翻活时接管） | **开**（R26 ④） |

判据编号（两套共用骨架；R35 起的现行清单见 `tools/validate-preset.mjs` 头注 ①–⑪）：
① 行头三元组与「恰一条 insert 一行」；② `tool-bash` 布尔禁用；
③ 顶层行集合 + 嵌套行集合与 `baselineTop` / `baselineNested` **逐项按序**比对——缺一即红、
多一行也红、**组内换序红、组内重复行红**（嵌套行数比对兜住「重复行的两个 id 都在期望集」
的缝）；③b `forbidden` 行名禁入；④ 恰五行 `dsh-async-tools`（顶层四行 + delegation
组内第五行）且 `toolName` 五值各一、第五行钉在 `tool-workflow` 行后（行位判据，§35.3）；
⑤ persona 锚句（按套）；⑥ 预设行无 `disabled` 护栏；⑦ **R26 互斥判据**
（`bothAliveRule` 开时，R35 起两套都开）：活 `tool-subagent` 行（`disabled !== true`）与 `async_agent` 行
同时在场 ⇒ persona 必须含唯一入口锚句与取回锚句，否则红；⑧ `disabledBoolean` 里列的每行
必须在场且布尔禁用（R35 起两套都含 `tool-workflow`；dsh-async 另含 `tool-subagent` /
`tool-subagent-fork`——裁决 A + R35-c 的结构性面，判据⑦之外的第二道闸）；
⑨ **形态断言**：`workflow-ptc` 行在场且 `config.provider === 'spawn'`（两套同值；现行校验器
的守卫原样并入，provider 改掉必红，变异 P15）；⑩ 禁用行 `tool-subagent` /
`tool-subagent-fork` 的 config 键值逐字锁死（§35.3 R35-g）；⑪ `lib/text.js` 两档
`tool.workflow.p2` 都含指向 `async_agent` 的门槛锚句（R34-h）。

CLI：无参 = 依次校验两份补丁（任一失败即非零退出）；带参 = 只校验那一份。未知 `config.id`
⇒ 红（期望集不存在，不允许「套不上就放行」）。

**基线行集合的诚实性**（防快照漂移）：`test/preset.test.mjs` 增一条对账用例——用校验器同款
YAML 方言读取 0.2.0 证据树里真实的 shipped standard 与
shipped cordis 预设基线补丁（`@deepseek-ai/dsh-web-app` 包内 `presets/` 目录，R38 §37.1 换锚），反推两套
`baselineTop` / `baselineNested`（真实基线 − pwsh + 4 async = 期望集），不一致即红；证据树
缺席也红（**显式红**：报错文案点名缺失的树路径，不许静默跳过）——期望集的出处就是这些
文件，对不了账的期望集不许绿。注意两个依赖是独立的：基线 preset 文件只存在于该树（这是
缺树即红的原因）；YAML 解析器可由 `validate-preset.mjs` 的任一 js-yaml 候选提供（本机
实际由全局 0.1.5 树提供）。上游改动创造模式行集合时这条用例先红，
强迫重建基线；`npm test` 因此绑定本机证据树，README 测试一节注明（§28.2 同步面）。

**config 正文的诚实性**（并入同一条 P14 用例）：行 id 对账之外，定向修改清单
（`disabledBoolean` ∪ persona ∪ 被删的 pwsh ∪ 新增的 async 行）之外的每个**叶子行**保留
config 与真实基线深度对账（递归键序规范化后逐字比，`disabled` 是定向修改单列面单独剔除），
组行只比 `id/name/group/isolate`（子行已单独比对）；并以「定向修改外叶子行单字段改写」的
反向对照证明比较器能红。防回潮理由：只有行 id 比对的判据下，plan-mode 段两处措辞漂移可以
全绿穿过——id 对账挡不住正文漂移。

### 28.5 测试设计（并入 §11 三层）

单元 / 进程内变异（`test/preset.test.mjs`，沿用「变异副本进临时目录、进程内校验」模式）：

| # | 变异 | 必红于 |
| --- | --- | --- |
| P1 | 创造补丁原样 | 基线绿（防恒真） |
| P2 | 删 `tool-cordis` 行 | ③ 缺行 |
| P3 | 多加一行（重复 `tool-web`） | ③ 多行 |
| P4 | `tool-subagent` 翻回启用 | ⑧ 结构性禁用 |
| P5 | `tool-plugin-manager` 写回 `!!js` 表达式 | ⑧ 布尔面 |
| P6 | 删 persona 锚句「ONLY delegation entry」 | ⑤ |
| P7 | 挂回 `tool-pwsh` 行 | ③b |
| P8 | `tool-bash` 改平台表达式 | ② |
| P9 | `config.id` 改成未知值 | ① 期望集不存在 |
| P10 | 预设行加 `disabled` 护栏 | ⑥ |
| P11 | 活 `tool-subagent` + 删锚句（P4+P6 复合） | ⑦ 互斥判据 |
| P12 | 删嵌套行 `plan-mode` | ③ 嵌套缺行 |
| P13 | `toolName` 笔误 | ④ |
| P14 | 两套 `baselineTop/Nested` 与 0.1.7 证据树对账 + 定向修改集外**叶子行 config 正文**深度对账（反向对照：单字段改写必红） | 诚实性用例 |
| P15 | `workflow-ptc` 的 `provider: spawn` 改掉 | ⑨（守卫不随参数化丢失） |
| P16 | 两份补丁的公共异步纪律段（intro 整段）逐字对账：改掉任一份的公共段必红 | §28.3 同源承诺 |
| P17 | 组内行重复（两个 id 都在期望集里） | ③ 嵌套行数面 |
| P18 | 组内行换序 | ③ 嵌套行序面 |
| — | `two-planes` T5：bundle 数组恰三项、第三项在盘且被 `files` 覆盖（`files` 已含 `presets` 目录） | T5 |

dsh-async 既有 13 条变异保持全绿（判据骨架不变，③ 的行集合比对是**增强**——删
`tool-web` 行从「不红」变「红」是预期的判据收紧）。

端到端（验证实例，阶段⑨执行；证据一律取自验证实例，D11）：

1. **新会话**选异步创造模式（已开始的会话换不了预设——预设注册表的 `select()` 对开过轮次的会话抛 `agent-preset/locked`）→ 转录 `request/header` 的工具
   目录逐项核对：四个 async 工具 + 创造侧**启用行**的工具在场；禁用行的工具不在目录
   （`pwsh`、`bash`、`subagent`、`subagent_fork`、`subagent_codex`、`subagent_claude_code`、
   `run_code`、ralph、插件管理）；禁用行本身由静态判据 ③/⑧ 守护，不在目录核对面上；
2. system prompt 含 §28.3 的 DELEGATION 硬规则关键句——口径**钉死为 §28.3 的四锚句**
   （`>-` 折叠后单空格匹配）；部分命中即红，不做宽松包含；
3. **等待可复现**：一次真实 `async_agent` 派生 → `async_wait_agent` 有界返回其结果；
   等待中用户插话 → 立即返回 `interrupted` 且子代理继续跑（R3/R12 口径）；
4. 隔离对照：异步模式预设的会话工具面貌不变（`subagent` / `subagent_fork` 仍在其目录）；
5. **回滚演练**：从部署树移除第三项与补丁文件 → 服务外重启 → 花名册回到没有
   本预设、异步模式仍在；再恢复部署 → 两预设齐。

以上五项已全部取证实证：`verify/probe-r26-create-preset.mjs`
三相位 **14/14**（`face` 10/10、`drill` 2/2、`both` 2/2），读数由该脚本重跑可复现。两处口径按实测校准：第 1 项的工具名清单按验证实例实有面
取值（`tool-cordis` 行在该实例只注册 `cordis_inspect_list`/`cordis_inspect_query`，
不从别实例会话推断）；第 2 项的锚句半边不从转录取证（`request/header` 无 systemPrompt，
R17-1 口径），由判据⑤静态看守；第 3 项"取回其结果"的落点 = 等待返回报结算 + 子代理回答以
`agent-message` 独立到达（0.1.7 实测契约）。回滚演练的摘除/复原各重启一次
（`git checkout -- package.json` 复原；验证实例经 junction 直读本仓，无需拷贝），服务均正常收敛。

### 28.6 风险

| 风险 | 处置 |
| --- | --- |
| 上游 0.1.8 改创造模式行集合，期望集变旧 | P14 对账用例先红；按新基线随之重建 |
| 模型在创造预设里仍试图调 `subagent`（描述里见过别的预设） | 工具不在目录即不可调；persona 第 1 条明说不许调；e2e 第 1 项核对目录 |
| 两份补丁 persona 维护漂移 | 公共段=§28.3 的 intro 整段，两份逐字相同，P16 对账断言守护；分叉只发生在 DELEGATION RULES 段（有意为之，锚句各自独立） |
| `order` 与未来 shipped 预设撞号 | 撞号只影响花名册排序，不影响功能；发现即顺延 |

---

## 29. R27：设置卡片改用官方共享控件（`client.js`）

落点不变（`plugins.bundle.config`，§21.4 继续管落点与守卫）；本节只定**表单形态**——卡片不再自绘
表单，改用宿主 0.1.7 自带的官方共享控件。依据 R27 与官方控件面调研（`dsh-client-ui-primitives` 的导出面、`dsh-client-ui-settings` 的表单模型与控制器）。

### 29.1 定稿的设计裁决（决策 / 依据）

**裁决 A（复用官方控件，不自绘等价物）：`client.js` 直接 `require("@deepseek-ai/dsh-client-ui-primitives")`，
用 `SettingsForm` + `SettingsValueField` 渲染表单，删掉本包自绘的 `.at-*` 样式与表单组件。**

依据：
- R27 逐项要求 1 点名"控件同源"；抄一份等价物必然随宿主漂移，而这份漂移正是本次要消灭的对象；
- primitives 在**冻结平台模块表**里（`dsh` 主包的客户端冻结清单含 `dsh-client-ui-primitives`）⇒ 第三方客户端半边可以直接 require，`dsh.client.external`
  一条都不用加；
- 官方四个宿主平面配置页就是这么组装的（同用 `SettingsForm` + `SettingsValueField`）⇒ 形态一致性由"同一份实现"保证，不靠像素比对维持。

**裁决 B（枚举字段：自绘的只是控件，语义仍走官方模型）：`uiLang` / `agentLang` 两个字段注册进模型
（本包写一个 `SettingsFieldSpec`：`format` 取生效值、`parse` 把空草稿判清除、命中选项判写值、其余判非法），
`EnumField` 只把控件本体换成 `<select>`，字段壳、覆盖徽标、说明行与校验文案照官方值字段逐项同形。**

依据：官方导出面没有可复用的枚举控件，但官方设置页**有自绘 select 的成例**——`dsh-client-ui-settings-models` 把原生 `<select>` 套在该页自己的 `input` 度量上、只加 `appearance:none` + 右侧 chevron + `padding-right:32px` 的 `selectInput` 修饰类。本包的 EnumField 照这个成例做：控件本体是原生 `<select>`，壳与度量照 `fields.module.css:3-145`（34px / 13px / 8px 圆角 / `bg-layer-3` / `.5px border-l4` / focus `brand-primary` / 禁用 `label-tertiary`），覆盖徽标用官方 `Tag`（tone `neutral`，`Tag.module.css:26-29`）。
**暂存、覆盖态与校验的语义不自绘**：`SettingsFormModel` 接受任意 `SettingsFieldSpec`（`form-model.d.ts:65-76`），枚举字段因此仍是模型的字段（`field(key)` 有值、`shell().dirty` 参与计算），自绘的只有控件本体。

允许偏离清单（**两项，写进 README 的界面节**）：① 枚举字段的控件本体（官方无对应导出，照
`dsh-client-ui-settings-models` 的成例自绘 select）；② 毫秒字段的说明行里带秒数读数（官方说明行没有
这种内容，但落在官方同一个文字位）。另有一处**颜色分工**（不属形态偏离）：失败文案跟随官方 `.failed`
（它引用的 `label-error` 未定义、落继承色是官方现行行为），本包自有样式只引用定义表内的名字（裁决 F）。

**裁决 C（保存语义换到官方模型）：`SettingsFormModel` 承担暂存、差集与保存；本包删掉自绘的草稿基准、
差集与写后回读逻辑（`draftBase`、`findRejectedKeys`、"已保存"状态）。**

依据：
- 模型 `plan()` **只遍历被暂存的字段**（`lib/index.js:6693-6736`）⇒ "整表发 op 会清掉别人写入"的危险
  不再存在（防护由它承担），空暂存下发写入也不可达（`save()` 在 `plan` 为空时
  直接返回，`:6656-6658`）；
- 模型 `save()` 走**一次** `mutate(ops, baseline.revision)`（`:6656-6681`），布尔为假即 `failed` 并
  **保留草稿**；控制器已把 `!response.ok` 折成布尔假、并在判假前先做一次恢复读（`dsh-client-ui-settings` 的控制器）⇒ 成败判定
  由模型 + 控制器承担，本包不再自绘"写后逐键回读"（原判据 T9/T9b 的意图随之下移到模型层）；
- 保存成功后草稿清空、字段由**活 section 值**回填 ⇒ 宿主静默丢写的可见后果就是"字段回到生效值"，
  谎报成功没有藏身处。

**裁决 D（读数进说明行，两段且输入段实时；用户裁定读数瘦身）：R21 的两条读数
都落在 `SettingsValueField` 的 `hint` 里，形状 = 字段说明**换行**接 `<label.effective>{v} · <label.input>{v}`
（行首不带点、与字段说明分行——样式照同 profile 参考插件的读数行；不拆独立段落，官方 `.field +
.field` 的分隔链会被打散，也不新增自有 CSS——官方 `.hint` 与参考包读数行度量一致：12px /
label-tertiary）；值**只写秒文本**（`600 s` / `0.5 s` / 亚 10 ms 的 `< 0.01 s` / 空草稿的 `—`）——毫秒
原值输入框里本来就有（用户裁定）。输入读数取**模型当前的暂存文本**
（`model.field(key).text`），每次键入即刷新；两段恒显示（相等也不隐藏，避免"时而有时而无"）。**

依据：官方字段结构里唯一的文字位是 label 行与说明行；读数留在输入件右侧就必须自绘输入件，
与裁决 A 冲突。**实时性是免费的**：模型每次 `edit` 都 `stage()` → `publish()`（`lib/index.js:6621-6628`、
`:6737-6742`、`:6764-6766`），卡片本就按模型状态重渲染，输入读数因此不需要额外监听或计时器。
读数内容、格式口径（整数不带小数、非整数两位）与"不写死"约束沿用 R21。换行与值形状的用户裁定
：「不需要 600000 ms = 600 s 这样，直接写 600 s 就可以了，原值在输入框里本来就有；
样式参考同 profile 参考插件，去掉开头的点，和原有介绍换行」——参考插件的读数行
即 `<p>` 里 `生效：{v} · 草稿：{v}`、`{v}` = `<秒数> s` 或 `—`（其 `client.js` 的 `secondsLine`）。

**读数文案的四条定则**（用户裁定）：

1. **亚 10 ms**：`0 < ms < 10` 显示 `< 0.01 s`（`formatSeconds` 显式分支）——不显示 `0 s`
   （正数不得读成零），也不留空（逐位键入时不给"读数消失"的错觉）；
2. **值只写秒文本**：`<v>` = `formatSeconds` 的秒数（整数不带小数、非整数两位，`04321` → `4.32 s`
   ——毫秒数不进读数，输入框里本来就有）；不可换算（含 `0`、负数、非数字）用 `—` 占位；
3. **词条归属**：两段标签（`readout.effective` / `readout.input`，值形如 `生效：{v}`）是**词典键**
   （R25：两语言键集相等、不得硬编码中文）；字段说明（`hint.<key>`）只讲这个字段管什么，
   不写"留空表示不覆盖"；
4. **输入段的三种姿态**（三分，互不重叠）：① 文本能解析成正数 → `<label.input>4.32 s`；② 文本为空
   → `<label.input>—`（清除覆盖的意图，不是非法）；③ 文本非数字或非正数（`0`、负数）→
   `<label.input>—` + `ats-sec-invalid` 非法标记（颜色面走 `state-error-primary`；数字字段的非法
   姿态同时把整行说明换成官方 invalidLabel——那是官方行为面，与本标记不冲突）。生效段在任何姿态下
   都显示。

**裁决 E（动作收成"一个保存"）：删掉「放弃修改」按钮与「已保存」文案；保存按钮按官方门控
（`!dirty || invalid || saving`）禁用，保存中显示「保存中…」，失败在页脚显示官方失败文案并保留草稿。**

依据：官方框架只有一个动作按钮，丢弃 = 卸载时清空草稿（`lib/index.js:6311-6315` 的清理 effect；卡片挂在
插件页上，离开页面即卸载，丢弃动作有等价路径）；成功不弹文案是官方姿态（`SettingsForm.module.css:16-48`）。

**裁决 F（自有样式只用**被定义**的别名变量）：`EnumField` 与卡片残留样式只允许引用**定义表**
（`dsh-client-ui-theme` 运行时注入的 90 个名字）里的 `--dsw-alias-*`；错误/非法态一律用
`--dsw-alias-state-error-primary`（定义表内、官方字段的 invalid 同款），**不得**引用
`--dsw-alias-label-error` —— 它全树零定义，只是被官方 `.failed` 引用过。**

依据：`dsh-client-ui-theme` 定义表实测——`label-error` / `label-danger` / `label-success` 三个名字都不在定义表里；本包现行
`.at-error` / `.at-saved` 引用的后两个因此失效。**失败文案本身跟随官方 `SettingsForm` 的 `.failed`**
（它引用未定义的 `label-error`，颜色落继承色是官方现行行为，本包不复制它的颜色引用、也不去改官方
样式）——「形态随官方、颜色只用被定义的名字」这条分工写进 README 的偏离清单第 3 项。

不得再改：以上六条随 R27 定稿；回退任一条都属新一轮设计裁决，必须连 §29.3 的判据与
README 的偏离清单一起改。

### 29.2 定向修改清单（`client.js` 与配套，逐条给依据）

| # | 定向修改 | 依据 |
| --- | --- | --- |
| 1 | 删掉 `INPUT_STYLE` / `READOUT_STYLE` / `CSS`（`.at-*` 全套）与自绘表单组件 `client.js:80-102`、`:151-338` | 裁决 A |
| 2 | `require("@deepseek-ai/dsh-client-ui-primitives")`，取 `SettingsForm` / `SettingsValueField` / `SettingsFormModel` / `settingsNumberField` / `settingsTextField` / `Tag` | 裁决 A；primitives 在冻结平台模块表里 |
| 3 | 建模型：`new SettingsFormModel(scope, specs)`；`scope = ctx.configForms.get(ENTRY)`（`ENTRY = "async-tools-host"`，取值按 entry id 而非包名）；`specs` = 8 个 `settingsNumberField`（7 个毫秒预算 + `maxResultChars`）+ 2 个 `settingsTextField`（`jobKind` / `subagentProvider`）+ 2 个本包的枚举 spec（`uiLang` / `agentLang`，形状同 `SettingsFieldSpec`） | 裁决 C、R27 定义段 |
| 4 | 值字段：`id = "plugin-config-" + key`、`label` / `hint` / `overriddenLabel` / `resetLabel` / `invalidLabel` / `numeric` / `disabled` 全取本包词典与模型状态；`SettingsForm` 的 `labels` = 本包词典、`state` = `model.shell()`、`onSave` / `onDiscard` = `model.actions()` 的 `save` / `discard`（**卸载丢弃草稿靠这条接线**——官方 `SettingsForm` 卸载时调 `onDiscard`） | 裁决 A/D |
| 5 | 枚举字段 `EnumField`（自绘的只有控件本体）：结构照官方字段壳（`.field` 列、label 行 + 徽标、整行控件、说明行），控件用 `<select>`（度量照 `dsh-client-ui-settings-models` 的成例：官方 input 度量 + `appearance:none` + chevron + `padding-right:32px`），选项文案取词典；状态与「恢复默认」走模型的 `field(key)` / `resetField(key)`。**两条硬条目**：① 无覆盖时下拉显示**生效值**（不是空选项——缺陷形态）；② label 的 `for` 与控件的 `id` 绑定、说明/错误经 `aria-describedby` 关联、非法态带 `aria-invalid`（与官方值字段同形） | 裁决 B、R27 item 3/11 |
| 6 | 读数进 `hint`（两段、换行、值只写秒文本；用户裁定）：毫秒字段说明行 = 字段说明 + 换行 + `生效：{v}` + ` · ` + `输入：{v}`（`{v}` = `formatSeconds` 的秒文本——`600 s`/`0.5 s`/亚 10 ms 的 `< 0.01 s`/空草稿的 `—`；毫秒原值输入框里本来就有）；`<生效值>` = user ?? 组合 ?? 默认，`<输入值>` = `Number(model.field(key).text.trim())`；`formatSeconds` 增加亚 10 ms 分支（`0 < ms < 10 → "< 0.01 s"`），并保留 `ms <= 0`／非数字的空串口径；输入段按**三种姿态**渲染（正数 → 秒文本；空文本 → `—`；非数字或非正数 → `—` + 非法标记，见裁决 D 定则 4）；生效段恒显示；非毫秒字段无读数；`formatSeconds` 继续导出（既有行为判据沿用，行为表补 `4`/`9`/`10`/`999` 四个边界） | 裁决 D、R21 |
| 7 | 重渲染：`model.bind(() => model.shell())` 只调一次（`lib/index.js:6569-6575`），用 `React.useSyncExternalStore(store.subscribe, store.getSnapshot)` 订阅；快照来源仍是控制器 | §21.4 的"自己订阅"约束 |
| 8 | 生命周期：`model.dispose()`（`:6683-6686`，解除 scope 订阅并清监听器）与控制器订阅一起进 `ctx.effect` / 组件卸载清理 | R4 可逆性 |
| 9 | 词典：新增 12 个字段说明 × 2 语言、读数两键（`readout.effective` / `readout.input`，值形如 `生效：{v}`）与 `overridden` / `reset` / `invalidNumber` / `save` / `saving` / `saveFailed` / `readOnly` / `unavailable`；**字段说明只讲字段管什么、不写"留空表示不覆盖"**；命名空间不可用与部署只读两种态都由 `SettingsForm` 渲染（`!state.available` → `labels.unavailable`；`!state.writable` → `labels.readOnly`——两个态都由官方 `SettingsForm` 渲染）；删掉 `placeholder` / `blankHint` / `saved` / `discard` 四个死键（两语言键集必须保持一致，R25） | R25、裁决 A/E |
| 10 | `package.json`：`dsh.client.external` 一条都不加；`dsh.client.inject` 三件不变 | §21.4 |
| 11 | 判据迁移：按 §29.3 的迁移表逐行处置 `test/` 与 `verify/` 里以 `data-field` / `name` / `.at-*`（`.at-label` / `.at-readout` / `.at-error` / `.at-saved` / `.at-inputWrap` / `button.at-btn`）/ "留空 = 不覆盖" / "已保存" 为锚的用例；**点名行号之外的注释与头注里的旧锚一并清理**（例：`test/two-planes.test.mjs:348`、`:420-425`、`:442`，`verify/lang-judgements.mjs:23`，`verify/_visual/probe-r24-bundle-config.mjs:13`——验收口径本就是全文 grep 零命中）；`verify/_visual/probe-card-visual.mjs` 整份重写（见 §29.3） | R27 逐项要求 12 |
| 12 | 文档同步：`docs/requirements.md` 的 R24 入口描述**与其"保存语义不变：逐键回读"条**、R25 判据②就地改写；`docs/design.md` §26.3 的 e2e 行就地改写；`README.md` 界面节写明形态与两项允许偏离；`verify/README.md` 的探针清单随锚点更新；实机验收节与其视觉判据行落在验收报告 | R27 逐项要求 12、R24 的"使用文档给可识别入口" |

### 29.3 判据（可失败口径）

形态与交互（页面 DOM，验证实例）：

1. 四组全部字段逐个在场（`lib/config.js` 现取，现为 16）；数字与文本字段的输入件 `id` = `plugin-config-<key>`（枚举字段为
   `select#plugin-config-<key>`）；
2. 每个字段有 label 行、整行控件与说明行；相邻字段之间有 0.5px 分隔线——判据读**计算样式**，不读源码文本；
3. 覆盖一个字段 → 该字段出现官方 `Tag`「已覆盖」与「恢复默认」；点「恢复默认」后徽标消失，且**保存前**
   profile patch 里该覆盖仍在（回读文件比对），保存后消失、字段回到生效值；
4. 数字字段填非数字文本 → 保存按钮禁用 + 控件边框为错误色 + 字段下出现原因文案；
5. 无改动时保存按钮禁用；保存过程中按钮显示「保存中…」再恢复；
6. 失败路径：宿主拒绝一次写入（`mutate` 返回 `false`）→ 页面出现失败文案、草稿仍在，**不得**出现成功提示；
7. token 扫描：`client.js` 里每个 `var(--dsw-alias-*)` 引用都在**定义表**内（名单 =
   `dsh-client-ui-theme` 运行时注入的别名变量全集，按 `tools/check-*.mjs` 的既有命名规范新增一条静态
   判据）；配两条变异（按 `verify/mutate-*.mjs` 规范）：把 `label-danger` 放回 → 必红；把
   `label-error` 写成引用 → 也必红（两者都不在定义表里）；
8. 写次数：无改动时不多发（按钮禁用）；有改动时 `mutate` 调用**恰一次**（计数探针）；
9. **卸载丢弃**：改一个字段但不保存 → 离开本包页面再回来，输入件回到生效值、徽标消失（官方
   `SettingsForm` 卸载时调 `onDiscard`，接线在卡片）；
10. **两段读数且输入段实时**：毫秒字段说明行**换行**接两段（`生效：{v}` 与 `输入：{v}` 两个
    span——值只写秒文本，见裁决 D 定则 1/2）；**不保存**、只在输入框里键入另一个数字 → 输入段
    **当场**变（读 DOM 文本，不读源码文本）；键入个位数（如 `4`）→ 输入段为 `< 0.01 s`
    （**不得**出现 `0 s`）；键入非数字或 `0`/负数 → 输入段 `—` 且带非法标记（说明行仍显示时；
    数字字段的非法姿态整行换 invalidLabel 是官方行为面）；清空输入 → 输入段 `—`；生效段在以上
    全部姿态下都在位；
11. **只读态**：部署只读（`state.writable === false`）时控件禁用、只读提示在场，**两段读数仍在位**。

既有判据的迁移面（逐行处置，漏一行就是假绿）。**行号只作定位线索**：本批改写 `test/` 与
`verify/`，行号会漂——按锚点描述定位。**验收口径三条**（缺一条都会出现"表说做完、实际没覆盖"）：
① 旧锚 grep 零命中；② 迁移表右列的**替代判据**在 `test/`／`verify/` 里找得到对应实现，并被对应变异证红；
③ 被删除的用例在修正清单里**显式记录**——旧锚连判据一起删掉是"覆盖静默丢失"，grep 零命中挡
不住它：

| 落点 | 现行锚 | 迁移到 |
| --- | --- | --- |
| `test/two-planes.test.mjs` | `findRejectedKeys` 的导出断言与源码文本匹配、"已保存"顺序断言、`formatSeconds` 源码匹配与行为断言、下拉 `data-field` 序列、拒绝键点名；**读数两处**——单段源码匹配（`formatSeconds(state.effective[...])` / 单 `readout` 变量拼接 / `hint = hint + " " + readout`，约 `:672-677`）与"说明行以读数**结尾**"的 `$` 锚（约 `:981-998`） | 行为判据：模型布尔为假 → `failed` 且草稿仍在；点「恢复默认」→ 不发写；`formatSeconds` 行为断言保留（补 `4`/`9`/`10`/`999`）、源码匹配删除；枚举字段改锚 `id`；**读数两处按两段重述**——单段源码匹配删除，"以读数结尾"改成"说明行**换行**后的两段 span 各自成立（结构读数：desc/换行/两段文本与类名，用户裁定）" |
| `verify/lang-judgements.mjs`、`verify/probe-lang-independence.mjs` | `[data-field]` 身份序列（`:150-152`、`:187`）与 `.at-label` 文案读取（`:22`、`:149`）、`button.at-btn`「保存」点击（`:196`） | `[id^="plugin-config-"]` 身份序列；文案读官方 label 行；保存按钮按 `labels.save` 文案定位；语言切换后身份不变 |
| `verify/mutate-r24-ui.mjs`、`verify/r24-judgements.mjs` | "页面显示已保存"作为落盘判据的一半；读数判据建立在**单段**口径上（`/= [\d.]+ s$/` 的结尾正则、`judgeReadoutFollows` 整串比对，约 `r24-judgements.mjs:180-217`；`mutate-r24-ui.mjs` 的 M6/M8/M22–M26） | 判据改为"字段回到生效值 + profile patch 命中"；"已保存"文案不再是证据；**读数判据按两段重述**——段 = `<标签>：{秒文本}`（span 文本），秒文本**三种形状**（`[\d.]+ s`、亚 10 ms 的 `< 0.01 s`、占位 `—`，见判据 10），`judgeReadoutFollows` 按段分别比对生效段与输入段；变异补"输入段接生效值"的 ⑧ 号镜像 |
| `verify/_visual/probe-r24-bundle-config.mjs` | `data-field` 选择器、`.at-readout` / `.at-inputWrap` / `.at-label` / `.at-error` / `.at-saved` 类锚、`input[name="<字段>"]`、`button.at-btn` 与"已保存"等待（`:77-78`、`:99-109`、`:129`、`:137-148`、`:151`、`:184`） | `id` / `[id^="plugin-config-"]` 选择器与官方类名；等待态改为"保存按钮从「保存中…」恢复"；**读数断言改成两段**（说明行换行后的两段 span：生效段随保存变、输入段**未保存**时随键入变——判据 10），只断言"存在秒文本"会漏掉输入段 |
| `verify/mutate-card-theme.mjs` | 变异锚 = `client.js` 的 `INPUT_STYLE` 字面量（写死颜色的缺陷原形） | 锚点随 `INPUT_STYLE` 一起消失 ⇒ 该变异退役或改锚到 `EnumField` 的样式对象；**不得留成静默 SKIP**（SKIP 按失败处理，`dsh-plugin-workflow` 纪律 11） |
| `verify/_visual/probe-card-visual.mjs` | 与系统设置字段逐项比 computed style（输入件度量）+ `.at-card` 类锚（`:477`）+ 深浅两主题截图 | **整份重写**：控件已同源，"与宿主字段同值"退化为恒真；改为与**官方设置页**并排抽检字段结构、说明行、覆盖徽标与页脚按钮几何，保留两主题截图 |
| `docs/design.md` §26.3 | e2e 清单以"页面显示已保存且无失败通告"为锚（`:1275`、`:1281`） | 就地改写为 §29.3 口径（字段回到生效值 + profile patch 命中；失败看页脚失败文案） |
| `docs/requirements.md` R24 | "保存语义不变：`mutate` 布尔应答 + 换新快照后的逐键回读" | **已执行**（R27 设计轮已就地改写为官方模型口径；此行为登记，不再是待办） |

### 29.4 测试设计（并入 §11 三层）

- **单元（浏览器外可跑）**：`formatSeconds` 行为表（沿用 + 补亚 10 ms 与边界：`4 → < 0.01 s`、
  `9 → < 0.01 s`、`10 → 0.01 s`、`999 → 1 s`，`0`/负数/非数字仍为空串）；`EnumField` 的选项渲染、
  覆盖徽标与"恢复默认只暂存"（假 scope）；模型装配断言——`specs` 的字段键集合与 `FIELDS` 逐项相等
  （漏一个字段即红）；读数拼接函数（两段形状、分隔符、规范化数值、空姿态）单测。
- **接线**：假 ctx 的 `configForms.get` 必须给出**完整 `SettingsFormScope`**（`getSnapshot` / `subscribe` /
  `mutate`）——比现行假件多一个 `subscribe`：官方模型在构造时就订阅它，缺了当场抛错（"假件不许宽容"
  的一处落点）。渲染断言：`SettingsForm` 收到的 `labels` 与 `state` 来自模型，四组全部字段各渲染一次。
- **变异（每条判据都要能红）**：R27 可失败 **①–⑧** 逐条对应——① 把官方值字段换回自绘
  `<input class="at-input">` → 判据 1/2 必红；② 把 `resetField` 换成直接 `mutate` → 判据 3 必红；③ 数字
  字段的 `parse` 恒返回 `set`（非法草稿也放行）→ 判据 4 必红；④ 空暂存也发一次 `mutate` → 判据 8 必红；
  ⑤ 把 `failed` 恒置假 → 判据 6 必红；⑥ token 变异两条（放回 `label-danger`、引用 `label-error`）→
  判据 7 必红；⑦ 把 `model.shell()` 退化成恒 `{dirty:true, saving:false}`（无改动也可点保存、保存中不
  换文案）→ 判据 5 必红；⑧ 把输入读数的取数改成生效值（不接 `model.field(key).text`）→ 判据 10 必红。
  **另三条设计侧变异**（守护 R27 逐项要求 9/4 与判据 9，需求侧锚见 R27 可失败 ⑨/⑩）：⑨ 把两段读数
  渲染加上 `state.writable === true &&` 条件（只读时不渲染读数）→ 判据 11 必红；⑩ 删掉空文本分支
  （空输入当非数字处理）→ 判据 10 的"（空）"姿态断言必红；⑪ `onDiscard` 传 noop → 判据 9 必红。
- **端到端（验证实例）**：§29.3 的 1–6、第 9 项（离开页面草稿不残留）与第 10 项（不保存时输入读数实时
  跟随键入），外加与官方设置页的形态抽检；证据
  一律取自验证实例（D11）。

### 29.5 使用文档与回滚

- `README.md` 的界面节给出可识别的入口与形态：插件列表 → 本包页面 → 描述下方即设置表单；字段 = 标签行 +
  控件 + 说明行；覆盖过的字段带「已覆盖」与「恢复默认」；只有「保存」一个动作，离开页面丢弃草稿；两项
  允许的偏离（枚举控件、说明行里的秒数读数——生效与输入两段）与一处颜色分工（失败文案跟随官方
  `.failed`，本包自有样式只用定义表内的 token）。现行两处界面描述（`README.md:37`、`:233`，含"保存/放弃
  修改"与"10 input + 2 select"）与探针清单（`verify/README.md:117` 的 `data-field` 锚）描述的是**最后一次
  提交的实现**——工作区可能已随实现改写，所以这三份文档的改写是定向修改 12 的显式条目，**实现漏掉它们
  就是新的未同步项**（未迁移前对工作区实现跑 `probe-r24-bundle-config.mjs` 必红，属已知待办，不得记成
  已同步）。
- `verify/README.md` 的探针清单随锚点更新（它是现行文档，脚本改锚必须落在这里）。
- 回滚 = `git checkout -- client.js` 回到**最后一次提交**的卡片实现；本设计不动落点、槽键与
  `dsh.client.inject`，回滚不涉及宿主面。

### 29.6 风险

| 风险 | 处置 |
| --- | --- |
| 官方控件在后续版本改形态或签名，卡片随之变 | 这正是本条的目的（形态随宿主走）；升级后重读官方控件面，§29.3 的 1–3 项会先红 |
| `EnumField` 自绘处与官方值字段再度漂移 | 度量逐项照 `fields.module.css`；抽检把它与相邻值字段并排比对；只允许列出的两项偏离 |
| 假件缺 `subscribe` 让接线测试变红 | 这是设计意图（假件不许宽容）；按 §29.4 的接线项补全假件 |
| 判据迁移漏项导致"改了却全绿" | §29.3 的迁移表逐行处置，每行都要有能失败的替换判据 |
| 从源码文本匹配退化成"看着对" | 现行以源码文本为锚的用例（单段读数的源码匹配、`.at-*` 类名断言）必须换成行为判据或删除，不得原样保留 |
| 小数草稿被控件放行、由宿主拒绝，使用者看到的是失败文案 | 这是官方模型的分工（宿主是约束的唯一权威）；判据 4 只对"非数字"提控件级要求，超出台数约束的值按失败路径判 |
| 两段读数让说明行变长、或在未覆盖时两段数字相同显得重复 | 说明行允许换行（官方 `.hint` 本就是普通段落）；"相等也不隐藏"是有意选择——隐藏会造成"时而有时而无"，被读成坏了；若实测噪声过大，按新一轮设计裁决处理（不得就地改成隐式行为） |

---

## 30. R28：静默失败陷阱三防线（统一 volatile 开关）

### 30.0 需求与事实锚

- 需求唯一权威：`docs/requirements.md` R28（444–517 行）。三防线：**a 结果侧自诊断**（`async_run`
  结算值附加诊断）、**b 描述侧警示段**（`async_run` 描述尾部）、**c 常驻纪律段**（宿主面
  system prompt 常驻段）。一个 volatile 布尔开关统一控制，**默认关**（用户裁定）；
  关 = 三防线**因行为差异而不存在**（a 无 note、b 无段落、c 无段），不是"仍然存在但不生效"。
- 事实依据（均已实测钉锚）：①陷阱 1——外部 EXE 的捕获形命令（`2>&1`、`$(...)`、变量赋值、输出重定向）在受限沙箱下于进程创建层被杀，无输出、无 `[exit code]` 标记；②EN 实测锚文本 `failed to run` + `Access is denied`；③systemPrompt 是 dsh-base 每个模式必挂的宿主行，且宿主有运行时 `ctx.inject` 成例；④陷阱 13——`[exit code: 4294967295]` 且无其他输出 = 整个 pwsh 被本机杀软「隐藏执行PowerShell」规则在进程创建层击杀；⑤ZH 锚文本 `无法运行` + `拒绝访问`（推测形态，仅作附加提示锚）；⑥官方设置面的布尔控件面——`Switch`/`Checkbox` 是导出原语、无布尔字段 spec 工厂、`SettingsFormModel` 暂存是文本制；⑦systemPrompt `context()` 的注册与组稿细节——order 必须有限数、text 函数每次组稿现求、空串 context 在渲染层被过滤。
- 形态沿用：§21 设置承载（volatile 链 + 就地刷新描述）、§24 模型面文案口径（模型面 =
  `lib/text.js` 双语表，人面 = client 词典）、§29 卡片形态（官方控件 + 有限偏离清单）。
- **非目标**（需求"不做什么"逐条）：不做陷阱 13 的结果侧签名；不动 `async_wait_job` /
  `async_wait_agent` / `async_agent` 的渲染与描述；不抑制桌面对话框；不还原退出码；不改 dsh
  源码；不写 `$DSH_HOME/AGENTS.md` 全局文件。

### 30.1 统一开关：字段与数据链（裁决 R28-A）

- **字段名 `silentFailureGuard`**，布尔，volatile，**默认 `false`**。名字直说语义（静默失败
  防线），不用黑话缩写；进 `lib/config.js` 新字段表 `FLAG_FIELDS`（与 `BUDGET_FIELDS` /
  `LANG_FIELDS` 并列的第三张表，`z.boolean().default(false).volatile()`），
  `materializeConfig` 对它解包、`Config` 展开收录、`resolveConfig` 归一为
  `c.silentFailureGuard = resolved.silentFailureGuard === true`（**严格 true 才开**——落盘的
  垃圾值一律收敛到关，失效安全方向与默认一致）。导出 `FLAG_FIELD_KEYS` 供界面判据按身份
  核对（照 `BUDGET_FIELD_KEYS` 成例）。`BUDGET_FIELD_KEYS` 十键不动（R24 判据不迁移）。
- **设置卡片第 13 个字段**（`client.js` `FIELDS`）：`{ key: "silentFailureGuard",
  flag: true }`。spec 自绘 `flagFieldSpec(key)`，形状同官方 `SettingsFieldSpec`
  （`enumFieldSpec` 同款做法）：
  - `format(value)`：`value === true ? "true" : "false"`（`undefined` → `"false"`，
    与官方布尔字段一致——无覆盖时草稿显示生效值）；
  - `parse(text)`：`"true"` → `{kind:"set", value:true}`；`"false"` → `{kind:"set",
    value:false}`（**显式 false 是用户覆盖**，会亮「已覆盖」徽标）；`""` → `{kind:"clear"}`
    （恢复默认 = 回 false）；其余文本 → `undefined`（非法草稿阻止保存——防御，正常交互
    产生不了这种文本）。
  - **暂存/差集/保存全走官方模型**（§29 裁决 C 不变）：Switch 翻转 =
    `actions.edit(key, next ? "true" : "false")`；`checked = model.field(key).text ===
    "true"`；翻回原值 = `plan()` 判干净（文本制暂存的既有语义，免费获得）。
- **控件本体 = 官方 `P.Switch`**（`@deepseek-ai/dsh-client-ui-primitives` 导出面；
  props `{checked, label, disabled, onChange, title, className}`，`onChange(next)` 收布尔）。
  官方设置面没有布尔字段导出（无 `settingsBooleanField`），但**布尔行控件本体有官方成例**
  （settings-general 的 DeveloperToolsRow、settings-subagent 的模型选择 toggle 行：可见
  标签 + `Switch` + 说明行）。因此偏离比 R27 枚举更小——**偏离清单第 ③ 项**：布尔字段的
  字段壳与 spec 自绘（照 `EnumField` 同形：label 行 + 「已覆盖」徽标 + 「恢复默认」+ 控件 +
  说明行，同一组 `.ats-enum-*` 类名复用，不新增自有 CSS），控件本体是官方原语 `Switch`。
  `Switch` 的 `label` prop 传同一标签串（无障碍名，照 subagent 成例），可见标签仍在壳上。
- **生效链 = R10/R21 既有 volatile 链，零新管线**：设置页保存 → loader 就地提交 → 宿主行
  fiber 收 `loader/volatile-update` → `seedSnapshot` 重物化 → refresh-bus 广播。三个消费点：
  a 在 `async_run` 结算路径现读 `configView.silentFailureGuard`；b 由
  `refreshToolDescriptions` → `rebuildText` 现读；c 的 text 函数每次组稿现读
  `readSnapshot()`。**三处都是"下一次生效"，不重启**。
- 开关字段自身的人面文案进 `client.js` 词典（`silentFailureGuard` 标签键 +
  `hint.silentFailureGuard` 说明键，zh/en 键集一致，R25 规则），说明写明三防线的生效面
  与默认关。

### 30.2 a 防线：结果侧自诊断（裁决 R28-B / R28-C）

新纯模块 **`lib/silent-failure.js`** 承载全部判定（不进工具装配路径，单测直测）：
`hasCaptureForm(command)` 与 `silentFailureNotes(p)`（返回 0 或 1 条文案行）。

#### 签名 1：条件式（R28-B）

四条件**全部成立**才出 note（缺一不可，判据逐一钉死）：

1. **捕获形启发式**：整条命令文本**不含管道**（`/\|/` 不命中——管道死法可见）且四
   模式任一命中：`2>&1`；子表达式捕获 `\$\(`；变量赋值捕获
   `(^|[\r\n;])\s*\$[A-Za-z_][A-Za-z0-9_]*\s*=`（语句首锚定，`if ($x -eq 1)` 这类不会
   误中）；重定向 `>`（`/>/` 一枚覆盖 `>` 与 `>>`，`2>&1` 自然被它包含，单列首模式只是
   显式）。**多语句命令命中任一即算**（需求原文口径：按命令文本整体判）。
2. **结算输出空白即空**：`collector.text().trim() === ''`。**口径裁定：纯空白算空**——
   陷阱 1 的死相是"模型眼里什么都没有"，空白与空在消费端不可分；条件式文案让这个口径的
   误发无害。测试同时钉 `''` 与 `'  \n  '`。
3. **受限执行且本次未提权**：`proc.sandbox !== undefined && proc.sandbox.denied !== true`
   （与 `sandboxMarkers` 同一盖章事实源：`proc.sandbox` 只在约束执行器结算时打上，denied
   已有 R11 标记管）且 `escalated !== true`（本次未走获批提权——提权跑的死法归提权语境，
   不归陷阱 1）。
4. **组合确有约束执行器**：`escalationModes.length > 0`（与 b 段广告同口径）。这条同时
   保证 note 里"带 sandbox_permissions 重试"这条正路**永远合法**（能出 note 的场合两个
   提权参数一定已广告），文案不必再做条件分支。

条件 1 的误发面（用户裁定）：纯 cmdlet `Get-ChildItem 2>&1` 空目录也满足四条件
→ note 出现 → **接受**，测试钉死（条件式措辞的成本就是一行提示）。

- **出口两处，与 R11 沙箱标记同位**（模型看得见的地方）：
  - 前台完成：`completedResult(...)` 增参 `{ command, escalated, guard }`，notes 数组在
    spill 标记与沙箱标记**之后**拼 `silentFailureNotes` 的结果（空数组拼入 = 无 `note`
    键，维持"never `note: ''`"的既有纪律）；
  - 后台结算：`registerLateJob` 参数面加 `command` 与 `escalated`，`done` 钩子里
    `jobOutcome(proc, collector, escalationModes, lang, { command, escalated, guard })`，
    note 行拼在 `detail` 尾部。**guard 在结算时刻现读 `config.silentFailureGuard`**
    （与 `lang` 冻结于注册时刻有意不同：开关语义是"下一次生效"，结算时刻读 = 与下一次
    调用同批；`registerLateJob` 闭包里本来就持有 configView）。
- 文案（`text.js` 新键 `note.silentCapture`）：**条件式措辞**（"若你预期的输出缺失，
  可能……"），给两条正路：裸调用重试一次验证；需要保留捕获形时带 `sandbox_permissions`
  重试同一条命令。

#### 签名 2：直陈式（R28-C）

- 扫描源 `collector.text()`。**锚对**：EN 对 = `failed to run` 与 `Access is denied`
  （实测原文，大小写敏感）；ZH 对 = `无法运行` 与 `拒绝访问`（推测形态，
  设计先行收录）。**同对两成员都出现**才算命中（单锚不触发）。
- 门只有两道：总开关 + 锚对命中。**不设**捕获形/空白/受限/执行器之门（需求原文如此；
  语义是**附加提示**不是第二套拒绝判定——不改 status、不判拒绝，只在输出后追加一行）。
  误发面 = 输出里恰好同现两锚（如 grep 别人的日志）时多一行提示，接受。
- 出口与签名 1 相同两处。两签名**互斥于构造**（签名 1 要求输出空白，签名 2 要求输出含
  锚文本），`silentFailureNotes` 一次最多返回一条，不会双发。
- 文案（`text.js` 新键 `note.silentDenied`）：直陈式（"输出与本部署受限沙箱的可见拒绝
  签名一致……"），正路同两条：裸调用重看一次；要保留原命令就带 `sandbox_permissions`
  重试。**附加提示里不做第二次"是否拒绝"的判定**（R11 已知缺口边界保持）。

### 30.3 b 防线：描述侧警示段（裁决 R28-D）

- `lib/descriptions.js`：`async_run` 描述键数组**尾部**追加 `tool.run.warnCapture`，拼接
  条件 `escalationModes.length > 0 && config.silentFailureGuard === true`（两个门都关才
  拼——组合无约束执行器时不提，开关关时不提）。
- 文案**紧凑一段**，不复述 c 全文（需求原文："描述侧警示段必须紧凑，不得复制常驻纪律段
  全文"）：点出捕获形在受限沙箱的静默死 + "下结论前先裸调用验证一次"。
- 生效链零新增：开关翻转 → refresh-bus → `refreshToolDescriptions` → `rebuildText`（内部
  现读 `escalationModes` 与 `configView.silentFailureGuard`）→ 描述**就地**增删该段
  （§21.3 的就地改写语义）。开关关 = 该段从描述里消失（行为差异，非"存在但空"）。

### 30.4 c 防线：宿主面常驻纪律段（裁决 R28-E）

- **落点 `lib/host.js` `applyHostHalf`**：在 `attachSnapshotSource` 之后
  `ctx.inject(['systemPrompt'], (scope) => scope.systemPrompt.context({ name:
  'async-tools:discipline', order: 130, text }))`。
- **运行时 inject 而非静态表**（sandbox-policy 成例）：静态 `inject` 列不动——四条
  工具行不需要 systemPrompt，加列会无谓改动五行的装载矩阵；dsh-base 每模式挂
  system-prompt，真机上回调总会执行；缺席的部署里插件照常装载（子 scope 等待，
  a/b 两防线不受影响——部署无痕姿态与 sandbox-policy 一致）。
- **`name: 'async-tools:discipline'`**（命名空间化照 `sandbox:policy` 成例）；
  **`order: 130` 字面数字**：`getContextOrder` 只解析三个内置名（110/115/120），未知名
  返回 undefined 而 `context()` 要求有限数——直接传数，取 130 排在
  SUBAGENT_DELEGATION 之后，与策略簇相邻。
- **`text` 是函数，每次组稿现求**（assembly 时 `typeof entry.text === "function" ?
  entry.text(context) : entry.text`）：读 `readSnapshot()`，`snap?.silentFailureGuard !==
  true` 时返回 `''`（快照缺席也返回 ''——失效安全方向 = 关）；开时返回
  `t(snap.agentLang, 'discipline.block')`。**语言跟 `agentLang` 现值**——语言翻转不需要
  重注册，下一次组稿即换。
- **OFF 不注销 context、只返回空串**：`renderContextSections` 对每个 context 的渲染结果
  `.filter(section.text.length > 0)`（`[@deepseek-ai/dsh-system-prompt@0.2.0-rc.2] lib/index.js:146-150`）——
  **空串段在渲染层被完全过滤，不泄漏空标题**。注销/重注册反而有注册窗口闪烁，不做。
- **覆盖面 = 宿主行（全局层）注册 → 对所有预设的新会话生效**，含不装载本包工具的预设
  ——这正是需求"新会话（含各预设）都挂纪律段"的实现机制；预设文件零改动。
- **内容 ≤25 行**（需求硬条目），键 `discipline.block`（`text.js`，双语）。覆盖：
  - 陷阱 1：捕获形（`2>&1` / `$(...)` / 变量赋值 / `>` 重定向）在受限沙箱里可能
    在进程创建层被杀；判别法 = 空输出 + 无 `[exit code]` 标记 + `$LASTEXITCODE` 空 ⇒
    **按"没跑"处理，不是"跑了没输出"**；验证法 = 裸调用重试一次（裸调用可靠）；要保留
    捕获形就带 `sandbox_permissions` 重试；
  - 陷阱 13：`[exit code: 4294967295]` 且无其他输出 = 整个 pwsh 在进程创建层被
    本机火绒「隐藏执行PowerShell」规则击杀（命令行文本里有独立的 `-W`/`-w` 开关或
    `-WindowStyle Hidden`）——**没有语句跑过，提权无用**，改写命令（`-Width`、经变量传
    值）才是正路。
  - 句式：本部署成立的事实 + 纪律动作，不引用需求编号/事实编号（模型面不留内部锚）。
  - **真机判据的逐字锚句**（e2e 用，写定即冻结）：en = `run it once as a bare call`、
    `killed at process creation`；zh = `裸调用重试一次`、`进程创建层被杀`。

### 30.5 文案与词典（裁决 R28-F）

- **模型面四键**（`lib/text.js`，en/zh 对偶，`tools/check-model-text.mjs` 四层检查自动
  覆盖）：`note.silentCapture`（签名 1，条件式）、`note.silentDenied`（签名 2，直陈式）、
  `tool.run.warnCapture`（b 段）、`discipline.block`（c 段，多行文本，行间 `\n`）。
- **人面两键**（`client.js` 词典）：`silentFailureGuard` 标签、`hint.silentFailureGuard`
  说明（写明：默认关；开 = async_run 结果与描述附加静默失败诊断 + 系统提示加常驻执行
  纪律段；语言跟 agentLang）。
- 口径照 §24：模型面文案只出自 `text.js`（双语），操作面/界面文案留 client 词典；检查器
  的 en 零 CJK、zh 含 CJK、键集相等三层对新键自动生效。**例外**：ZH 拒绝
  锚 `无法运行` / `拒绝访问` 是 `lib/silent-failure.js` 里的**判定常量**（EN 锚实测、ZH 锚为
  推测形态的附加提示锚），与语言档无关，**不放 `text.js`**（那是语义误用）——因此 `tools/check-model-text.mjs`
  源码层的 ALLOWLIST 须登记 `silent-failure.js` 并注明"判定常量，非模型面文案"（定向修改 12）。
- **文案审查项（实现与审查各过一遍）**：`discipline.block` 与其余三键
  **禁含 `{{` 字面量**（context text 会过 dsh 组稿插值器，成对 `{{…}}` 指向未注册变量、或
  残缺组但带 `}}` 都会**组稿抛错**）；`tool.run.warnCapture` 文案**自带前导空白**
  （`buildToolText` 键数组是空串 join，无前导空白会与前段粘连）。

### 30.6 定向修改清单

| # | 文件 | 定向修改 |
| --- | --- | --- |
| 1 | `lib/config.js` | 新增 `FLAG_FIELDS`（`silentFailureGuard`，volatile 布尔默认 false）+ 导出 `FLAG_FIELD_KEYS`；`materializeConfig`/`Config`/`resolveConfig` 三处收录（归一 `=== true`） |
| 2 | `lib/text.js` | 四个新键（`note.silentCapture` / `note.silentDenied` / `tool.run.warnCapture` / `discipline.block`）的 en/zh 对偶 |
| 3 | `lib/silent-failure.js` | **新建**纯模块：`hasCaptureForm(command)`（四模式 + 管道否决）、`hasDenialAnchors(text)`（EN/ZH 锚对；ZH 锚是**判定常量**，与语言档无关）、`silentFailureNotes({proc, collector, command, escalated, escalationModes, guard, lang})` → `string[]`（0/1 条） |
| 4 | `lib/jobs.js` | `completedResult` 增 `{command, escalated, guard}` 参数并在 notes 尾部拼入；`jobOutcome` 增同形参数并在 detail 尾部拼入；`registerLateJob` 参数面加 `command`/`escalated`，`done` 钩子里 guard 现读 configView；`execute` 两个调用点传 `args.command` 与 `approvedMode !== undefined` |
| 5 | `lib/descriptions.js` | `async_run` 描述键数组尾部条件拼接 `tool.run.warnCapture`（`escalationModes.length > 0 && config.silentFailureGuard`；文案自带前导空白） |
| 6 | `lib/host.js` | `applyHostHalf` 里运行时 `ctx.inject(['systemPrompt'], …)` 注册 `async-tools:discipline`（order 130，text 函数读 `readSnapshot()`）；**同步改写文件头注释**（原"无任何服务依赖、不 ctx.inject"的声明随本次定向修改失效） |
| 7 | `client.js` | `FIELDS` 第 13 项（`flag: true`）；`flagFieldSpec`；`FlagField` 组件（EnumField 同形壳 + `P.Switch` 控件，复用 `.ats-enum-*` 类）；`makeSpecs`/`makeFieldNodes` 分支；词典两键 ×2 语言 |
| 8 | `test/` | 新 `silent-failure.test.mjs`（判定矩阵）；扩展 `jobs.test.mjs`（两出口）、`descriptions`/`agent` 侧（b 段矩阵）、host/两平面侧（c 段假 systemPrompt）、client specs（13 字段 + flag spec 矩阵）、`config` 归一 |
| 9 | `verify/` | 真机探针与证据落 `verify/`（§30.7 真机项），`verify/README.md` 探针清单随锚更新 |
| 10 | `docs/` | `README.md` 界面节（13 字段）与偏离清单第 ③ 项；实机验收与审查档案登记（按文档账本落验收报告）；`tools/check-docs.mjs` 登记本批档案 |
| 11 | 预设/`cordis.patch.yml` | **零改动**（c 段靠宿主行全局注册，预设文件不碰） |
| 12 | `tools/check-model-text.mjs` | 源码层 ALLOWLIST 登记 `lib/silent-failure.js` 的两枚 ZH 锚（理由：判定常量，非模型面文案）；**同步更新该检查器的输入契约测试**（若 ALLOWLIST 变化影响其用例），登记进其测试沙箱清单 |

### 30.7 判据

单测（独立子代理执行；全部沿用 §16 流程约束）：

1. `hasCaptureForm`：四模式各自命中；含管道 → 否决（即使同时有 `2>&1`）；多语句任一命中；
   无捕获形不命中；`if ($x -eq 1)` 类不误中赋值模式。
2. `silentFailureNotes` 四条件逐一缺失 → 无 note（四个独立用例：无捕获形 / 输出非空 /
   `proc.sandbox` 缺席或 denied 或 escalated / `escalationModes` 空）。另补**裸调用对照**
   用例：同命令去捕获形、输出正常 → 无 note（真机不做此断言，见真机 2 注）。
3. 空白口径：`'  \n  '` → 按空判（签名 1 可出）；`''` 同。
4. 误发接受钉死：cmdlet `Get-ChildItem 2>&1` + 受限 + 空输出 + 有执行器 → note 在。
5. 提权路径（`escalated: true`）→ 无签名 1 note（其余条件全满足）。
6. 签名 2：EN 对命中 → note；ZH 对命中 → note；**单锚不触发**；大小写敏感
   （`Failed To Run` 不命中）。
7. 非空且无锚 → 两条签名都不出。
8. 开关关 → `silentFailureNotes` 返回空、b 段不拼、c 段 text 为 ''（三防线同断）。
9. 前台出口：note 行出现在 `completedResult` 的 render 文本尾部（与 R11 标记同位、其后）；
   无 note 时 `note` 键不出现（never `note: ''`）。
10. 后台出口：note 行出现在 `jobOutcome` 的 `detail` 尾部；guard 取结算时刻快照值。
11. b 段矩阵：`(广告, 开关)` 四组合里仅 `(有, 开)` 拼出 `tool.run.warnCapture`；开关翻转
    经 `refreshToolDescriptions` 后描述就地增删该段。
12. c 段（假 systemPrompt 服务）：context 以 `async-tools:discipline`、order 130 注册；
    text 函数在 guard 关/快照缺席时 `''`，开时按 `agentLang` 给 en/zh 文本（各一用例）；
    纪律文本含 30.4 的逐字锚句。
13. 设置面：`FIELDS` 与 spec 键集逐项相等（四组全部字段，现为 16 = 10 预算 + 2 语言
    + 2 开关 + 2 提问接管）；`flagFieldSpec` 矩阵
    （`format` true/false/undefined；`parse` "true"/"false"/""/"yes"）；`resolveConfig`
    归一（true→true，缺省→false，垃圾→false）。
14. `check-model-text` / `check-alias-tokens` / `check-docs` 全绿；既有 214 测试不回归。

可失败变异（审查轮各跑一条，判据必须红）：

- ① 启发式扩到管道（删 `/\|/` 否决）→ 判据 1 红；
- ② 签名 1 文案改直陈式（删"若/可能"措辞）→ 判据 4 的文案断言红；
- ③ c 段 text 硬连 true（不读开关）→ 判据 8/12 红；
- ④ 空白口径改严格 `=== ''`（去 trim）→ 判据 3 红；
- ⑤ 签名 2 改单锚命中 → 判据 6 红；
- ⑥ b 段漏广告门（无执行器也拼）→ 判据 11 红；
- ⑦ 字段默认改 true → 判据 13 的归一/默认断言 + 真机"默认无纪律段"红。

真机（验证实例，独立子代理，证据进 `verify/`）：

> **执行档裁定（实测 + 用户裁定「走提权」）**：验证实例宿主是服务管理器托管的服务
> （LocalSystem 令牌）——该令牌无 logon SID，而 `dsh-sandbox-windows-acl`
> 的受限令牌构造**结构性地**要求 logon SID（限制 SID 组 = logon SID + EVERYONE + 工作区/
> 临时目录 SID），于是该机受限档作业一律死于
> `CreateRestrictedToken prerequisite failed`、退出码 127（实测锚）。真机 a 管线判据因此改**双档**：
>
> - **受限档**（不带 `sandbox_permissions`）：跑一次记**环境读数**——结果含上述死法锚
>   （`CreateRestrictedToken prerequisite failed`）、退出 127；同时断言**无误发**（stderr
>   非空 → 签名 1 条件 2 不满足 → 无 note；无签名 2 锚 → 无 note）。
> - **提权档**（`sandbox_permissions` + `justification`，经批准——验证实例装了
>   自动应答插件）：命令**真跑**，是该机唯一能拿到真实输出的执行档。良性
>   捕获形空目录 → 真空输出且无 note（= 需求「提权跑 → 不产出」的真机证据，单测判据 5
>   的同形实证）；管道形 → 干净版本输出 + 无 note。
>
> **note 阳性渲染**（签名 1 良性误发面本体、签名 2 锚对命中）在验证实例受限面上不可达，
> 不做真机复现：四条件判定与渲染由单测判据 2/4/5/6/9/10 覆盖，锚对真实性有受限沙箱
> 真机复现背书（锚对两枚实测在案）。

> **行为判据的测试噪声治理（实测）**：c 段无转录通道，判据靠
> 固定格式问答的判别子。实测存在噪声：同会话主判别子（AVKILL+MEANS）全对、语言子却
> 答 none 的**矛盾读数**（`4294967295` 不可猜，答得出即证明块在场），以及 standard 会话
> 整轮漏答（两轮间不稳定）。处置：**在场断言**走 `askBatteryConsistent` 自洽重采样——
> 矛盾读数换新会话重抽 ≤3 次、逐次记录进证据 JSON（判据不稀释，抽样全留痕）；**缺席
> 断言**单发不重抽（模型幻觉出不可猜退出码结构上不可达）。

1. **默认关**：装新构建后新会话首帧 system prompt **不含**纪律锚句；良性 cmdlet 捕获形
   空输出（空目录 `Get-ChildItem 2>&1`，见真机 2 注）双档跑——受限档记受限环境读数
   且无 note，提权档真跑得空输出且无 note；`async_run` 描述无 b 段。
2. **开**（设置卡第 13 字段在场、Switch 翻转保存）：不重启——新会话首帧含纪律锚句
   （en 逐字）；**包预设与不装载本包工具的 shipped 预设**（标准模式）都含（c 段全局性）；
   描述含 b 段；良性 cmdlet 捕获形双档跑——受限档 127 非空死法**不误发** note，提权档
   真空输出仍无 note（提权豁免真机证据）。
   **注**：需求 508–509 行明文"签名 1 不做真机复现（0xC0000142 会弹
   桌面错误框，判据全走单测假件与文案层）"——真机**不跑**任何会触发陷阱 1 的 EXE 捕获形，
   裸调用对照与提权重试的否定断言也**不进真机**（单测判据 2/4/5 承担）。真机上的 a 管线
   检查只用良性 cmdlet 误发面本体（用户裁定接受的形态：`Get-ChildItem 2>&1` 是内建
   cmdlet，进程内执行，无 0xC0000142、无桌面弹窗），验证 execute → 四条件 → note 渲染的
   接线；陷阱本体的行为断言全在单测。
3. **签名 2 管道形双档**：受限档跑会产生锚文本的命令（`git --version | Select-String git`）
   → 受限死法在场、锚对不在、无 note（本机受限面上无真拒绝可复现）；同命令提权重跑 →
   干净版本输出 + 经批准 + 无 note（死法归提权语境）。锚对真实性有真机复现档案背书，
   note 阳性渲染由单测覆盖（见顶部裁定）。
4. **关回**：新会话纪律段消失、描述 b 段消失、提权档良性跑无 note（行为差异三处同验）。
5. **重启保持**：`Restart-Service`（托管服务）后开关值与三防线状态不变（volatile 持久化，
   R10 判据复验）；a 执行链重启后仍活（提权档良性真跑空输出 + 经批准；受限档环境读数
   不变）。
6. **语言**：`agentLang=zh` 时纪律段换中文锚句（无需重注册）。

### 30.8 使用文档与回滚

- `README.md`：界面节字段数 12→13、新增布尔开关行的形态（标签 + 「已覆盖」/「恢复默认」+
  Switch + 说明行）；偏离清单加第 ③ 项（布尔字段壳自绘、控件官方 `Switch`）；功能节一段
  三防线说明（默认关、生效面、语言跟随 agentLang）。
- `verify/README.md`：新探针与锚句登记（现行文档，脚本改锚必须落这里）。
- 实机验收记录落交付报告（九阶段记录 + 证据索引）。
- **回滚**：开关默认关本身就是运行时回滚（三防线全不存在）；代码回滚 = revert 相应提交
  （预设与 patch 零改动，不涉及宿主面重建）；c 段的 context 注册随宿主行 fiber 销毁自动
  拆卸（`layers.effect` 挂在 ctx 上）。

### 30.9 风险

| 风险 | 处置 |
| --- | --- |
| 火绒规则/锚文本变化 → 纪律文本或签名 2 过时 | 文本只是提示不改行为；过时即按新实测改锚文本与 `text.js`（新裁决轮，不就地热改语义） |
| 签名 2 误报（输出恰好同现两锚，如 grep 日志） | 一行附加说明的成本，需求原文接受；判据 6 钉死单锚不触发收窄误发面 |
| 签名 1 误发（cmdlet 捕获形空输出） | 用户裁定接受；条件式措辞 + 判据 4 钉死 |
| `Switch` 原语签名/形态变化 | 重读 primitives 导出面；偏离 ③ 重审（判据 13 先红） |
| 部署缺 systemPrompt → c 静默不生效 | 与 sandbox-policy 同姿态（部署无痕）；a/b 不依赖该服务；真机判据 2 覆盖在位检查 |
| 纪律段挤占上下文 | ≤25 行硬上限 + 默认关；超限即设计违例（审查项） |
| order 130 与未来官方内置撞号 | 排序为稳定排序，同号不冲突；官方若收编该名字按其 getContextOrder 重对齐 |
| 后台作业 guard 现读 vs lang 冻结的不一致观感 | 有意选择（30.2 已述）；判据 10 只断言结算时刻快照值，不断言冻结语义 |

## 31. R29：拒绝防线、入口取消、读失败可见性、预算上界与 killed 分流

### 31.0 需求与事实锚

- 需求唯一权威：`docs/requirements.md` R29（519–607 行）。七项定义：**a 拒绝防线**（只可能
  reject 的 promise 创建点挂 no-op catch；接线段入 try/finally）、**b 入口已中止**（两等待工具
  入口即回 interrupted，`waited_ms = 0`）、**c 读失败可见性**（`jobs.get` 三分、`jobs.read`
  失败标注、drain 丢失标记、正文回退匹配复查）、**d 预算上界**（ms 字段同量级上界 +
  `pollIntervalMs ≤ maxWaitMs` + `maxResultChars` 上界 + `wait_ms` 覆盖口径成文）、
  **e 前台 killed 分流**（done 胜者先判 `proc.status`）、**f 边界小项**（registerFailed
  单行截断、日志插值单行化、`routes` 先验、`?.` 对齐、`listChildren` 透传 signal、
  `tools/` 去硬编码路径）、**g 暴露面登记**（README 一节，纯登记）。
- 事实依据（均已实测钉锚）：宿主 installFailLoud 语义下 unhandledRejection = 整实例退出；
  AbortSignal 已中止后挂监听器永不触发；实测 `DSH_WEB_URL` 随请求下发且
  **不含令牌**（`DSH_*` 的全量键集来源是 `lib/jobs.js:551-554` 的
  `ctx.shellEnv.collect(exec)` 快照——g 项登记以此为准）；让出窗口内信号致死：
  `proc.status = 'killed'` 且 `done` 照常 resolve；setTimeout 延迟越过 2^31-1 →
  1ms 立即触发；`listChildren(parentSessionId, signal?)` 服务签名与"本包只传
  第一参"的现状。本设计轮新增宿主事实三条：**其一**（schemastery `.max()` 是字段级
  meta 包装，越界在 `Config()` 解析时抛 `ValidationError`，消息可读——`expected number
  <= 2147483647 but got …`；对象级无 `.validate()` 钩子，跨字段规则不可字段化）；**其二**
  （设置写路径只做 volatile 归属与 revision 栅栏，**不做值校验**；数值字段的官方表单只验
  有限性不验 min/max——越界值照常落盘，随后 loader `_commitVolatile` 里 `Config()` 抛错 →
  warn 一条可读消息 + **运行值不动** + 原值保留待下次激活）；**其三**（dsh-jobs-local 的
  `get`/`read`/`wait` 对未知 id 一律 throw（`unknown job <id>`）、他 session 作业 throw
  （`belongs to another session`）——`get` 永不返回空；`list(caller)` 只返回 caller 可见
  作业的视图，缺席即"不可见/不存在"，两形态与 `get` 相同（同一 `view()`））。
- 形态沿用：§22 到期双源合并（wait-job 的终态只认复查快照）、§6.2 先订阅后屏障、
  `childOf` 三分先例（`undefined` = 查询失败、`null` = 查无）、`interruptedNote`（R12
  引入）与
  `detail.lossy` 文案面。
- **非目标**（需求 580–583 行逐条）：不改宿主源码；不动 `verify/` 历史档案（实例令牌是
  部署侧事务，建议轮换）；不剥离 `DSH_*` 环境变量（g 只登记）；不给 `startContinuable`
  半失败加防线（触发条件未证实，存疑留档）；不给 `!!js` loader 表达式另做安全层。

### 31.1 a 拒绝防线（裁决 R29-a）

三处定向修改，同一性质：**只可能 reject 的 promise，其"零 handler 存活窗口"必须闭合**。

1. **`wait-agent` 的 `aborted`（`lib/wait-agent.js:219-225`）**：创建点同步补
   `aborted.catch(() => {})`（独立分支，不给竞速吞任何东西——`Promise.race` 稍后自挂
   handler，看到的 reject 不受影响）。它堵的是**屏障窗口**：reject 可发生在第一个
   `await childOf` 之后、竞速候选组装（`:314-321`）之前，期间长达 3×`pollIntervalMs`，宿主
   installFailLoud 语义下这就是整实例退出。注释（`:226-229`）改写为三层真实
   依据：入口检查（b 项，入口中止根本走不到这里）→ 创建点 no-op catch（屏障窗口）→
   竞速挂接后 race 自带的 reject 能力。`lib/interrupts.js:156-162` 的尾注提及两处依赖
   race 吸收，同步改口径。
2. **`settings` 的浮动 import（`lib/settings.js:142-144`）**：`.then` 链尾补
   `.catch((e) => ctx.logger?.warn?.(…))`。此路径在 `seedSnapshot` 之后，失败只影响
   描述刷新转达，不该具备杀死实例的能力。
3. **`wait-job` 接线段入 try/finally（`lib/wait-job.js:133-176`，try 现起于 `:179`）**：
   `interrupt` / `timer` / `onExecAbort` 声明提前，try 从接线第一行就开始，finally 做
   四件既有处置（清 timer、`raceAbort.abort`、`interrupt?.dispose()`、摘监听器），全部
   带空值护栏——接线中途同步抛（防御性：`watchUserInterrupt` 抛、`AbortSignal.any`
   不可用等）也不泄漏任何监听器与定时器。**不重排** `:186-192` 的既有 finally 语义，
   只把它的覆盖面从"竞速"扩到"接线 + 竞速"。

### 31.2 b 入口已中止回音（裁决 R29-b）

两个等待工具的 `execute` 第一行（任何查询、订阅、定时器之前）：

```
if (exec.signal?.aborted) return <interrupted 结局，waited_ms: 0>;
```

- 结局形状复用各自既有的 interrupted 分支（wait-agent `:372-384`、wait-job `:216-228`），
  `waited_ms` 字面 0，文案复用 `interruptedNote`（`lib/output.js:89-91`，R12 引入、
  R28 沿用——归属按 R12 修正）。
- 「已中止信号挂监听器永不触发」的两条病径就此短路：wait-agent 入口中止原会**等满预算**（`aborted` 的监听器挂
  在已中止的信号上永不触发，`:215-217` 的直调发生在 promise 创建**之前**，reject 无从
  发生）；wait-job 原会提前结束但结算仍是 **running 口径**（`abortSignal` 预中止 → `jobs.wait`
  即弃 → `wait-aborted` → 复查 → running，还多发一次查询）。短路后两者都不进屏障、
  不武装预算、不发查询。
- 判据钉死"未发查询"：wait-agent 断言 `listChildren` 未被调用（`childOf` 全部调用点
  都在检查之后），wait-job 断言 `jobs.wait` 与屏障 `jobs.get` 均未被调用。

### 31.3 c 读层三分与丢失可见性（裁决 R29-c）

#### c-1 `jobs.get` 三分（`lib/wait-job.js:26-32` → `:111-114`）

`snapshotOf` 改建在 `list()` 之上（dsh-jobs-local 的 `list` 只返回 caller 可见作业）：一次查询天然三分——

```
try { return ctx.jobs.list(caller).find((job) => job.id === jobId) ?? null; }
catch { return undefined; }
```

- `null` = 清单里没有 → "查无或不可见" → 走既有 `error.unknownJob`（他 session 作业在
  `list` 里同样缺席，裁决与今天一致，不泄漏存在性）；`undefined` = 查询本身失败 →
  **新词典键 `error.queryFailed`**：可重试口径（"读取作业列表失败，可稍后重查"），屏障
  处 `throw`，绝不并入 unknownJob（合并会诱发副作用重跑——需求原文的动机）。
- 语义面变化：`get` 换 `list`。形态相同（同一 `view()` 投影），代价是一次全表
  视图（本插件作业量级下可忽略）；换来的是不依赖 host 错误消息字符串做判别。
  **裁决**：需求字面是"`jobs.get` 三分"，但 `get`
  对未知 id 一律 throw、**无法**把查询失败与查无区分开；`list` 缺席即不可见，天然三分。
  手段替换追认——需求的意图是三分本身，不是 `get` 这个方法名。
- 边界如实登记：**竞速后复查**（`:207`）的 `undefined`（查询失败）仍落 running 分支
  ——`waitAgainNote` 本身就是"可再次 async_wait_job"的重试出路，下一次调用重查自愈；
  作业在屏障与 `jobs.wait` 之间消失时 `wait` 拒绝 → `wait-aborted` → 复查 `null` →
  running，再下一次调用屏障给 unknownJob——两步收敛，与今天同序。

#### c-2 `jobs.read` 失败标注（`lib/wait-job.js:43-45`）

`outputOf` 的 catch 不再静默返回 `''`：读失败时输出前置一行标注（**与 `render.lossyPrefix`
同一渲染位、同一文案面**），正文为空。新词典键 `render.readFailed`。终态分支的 schema
不动（标注在 `output` 字段内部，模型可见）。**按注**：需求措辞是"note
标注"，本设计落在 `output` 首行而非新增 note 键——终态分支 schema 无 note 键，渲染位
与 lossy 前缀同款先例，模型可见性等价；偏差在此显式登记。

#### c-3 drain 丢失标记（`lib/jobs.js:66-87`）

`createCollector` 增内部丢失旗标：drain 的**读异常路径**与**守卫触顶路径**（分块数上界）
置位；`isLossy()` 返回"宿主环形丢弃 || 本旗标"。出口零改动——`jobOutcome` 与
`completedResult` 的既有 lossy 拼接（`detail.lossy` / 落点）自动吃到。丢失的是"更早的
字节"，spill 线索照旧在 detail。

#### c-4 正文回退匹配复查（`lib/interrupts.js:119-129` + `lib/wait-agent.js:354-361`）

- `interrupts`：`senderSessionId` 在场且命中 → `via: 'settlement-notice'`（**权威信号，
  不加复查**——投影滞后会误报 running）；sender 缺席、正文匹配命中 → 新
  `via: 'settlement-text'`。
- `wait-agent` 结算分支改门：`winner.name === 'settled'` 且 `via === 'settlement-text'`
  时，只有竞速后复查（`:352` 的 `verdict`，现有调用，不新增查询面）读到"不再观察到
  运行"才返回 settled；否则**落 running 结局**（`agentWaitAgainNote`）——正文匹配是
  弱证据，误报 settled 比多等一轮贵。权威 via（notice / status-idle / activity-recheck）
  维持直返。新词典键 `via.textFallback`（回退命中的 settled 细节标注"经复查确认"）。

### 31.4 d 预算上界入 schema 与 wait_ms 覆盖口径（裁决 R29-d）

#### 上界数值

- **七个 ms 预算字段全部 `.max(2147483647)`**（`BUDGET_FIELDS`，`lib/config.js:84-132`）。
  需求点名 `maxWaitMs` / `defaultYieldMs` / `pollIntervalMs` 三处，其余四个补齐的机制
  如实分两档：`minYieldMs` / `maxYieldMs` / `minWaitMs` 与
  `defaultYieldMs`——前三个经 `resolveYield` 钳制、`defaultYieldMs` 作为缺省值进入
  `setTimeout`，都真实走到「setTimeout 延迟越过 2^31-1 即 1ms 触发」的洞（只封三个字段等于把边界平移给第四个）；
  `defaultWaitMs` 不进任何定时器（`resolveWait` 对缺省抛错，它只进 note 示例文案），
  封它属于**防文案面失真 + 口径统一**，不是堵洞。**裁决**：
  七字段全封追认——六个堵真洞、一个统一口径，代价为零（默认值全部远低于上界）。
- **`maxResultChars` `.max(1000000)`**：与 `outputLimitBytes = maxResultChars × 3`
  （`lib/jobs.js:330`）联动 → 环形缓冲上界 3MB/作业；默认 30000 的 33 倍余量。
- **`pollIntervalMs ≤ maxWaitMs`**：`ORDERED_PAIRS` 追加 `['pollIntervalMs', 'maxWaitMs']`
  （`lib/config.js:260-263`），`assertCrossFieldOrder`（`:282-291`）自动覆盖，消息风格
  与既有跨字段消息同款——**键名对**（`pollIntervalMs > maxWaitMs`，`lib/config.js:283-285`
  现行消息只有键名）。不升级消息为"含两值与修法"：那会改动既有两条 pair 的文案，超出
  需求；两值与修法由 README 联动说明与卡片层原因文案承担（见下）。

#### 拒绝机制（两层，如实写明，不借宿主新能力）

- **卡片层（第一道，满足需求字面"保存时被 schema 拒绝并给可读错误"；挂法按
  官方 parse 通道修正）**：宿主保存禁用的唯一因果链是 `blocked = !dirty || state.invalid ||
  saving`，而 `state.invalid` 只来自 **`spec.parse` 通道**的 plan 聚合——字段 props 的
  `invalid` 只进显示层，不回流 shell。R27 的"非法草稿禁用保存"先例正是 parse 通道
  （`enumFieldSpec` 非法返回 `undefined` → 阻止保存）。定向修改按此挂：
  1. **单字段上界**：数值字段 spec 包装或自写（现状用官方 `settingsNumberField`，
     `client.js:157`，其 parse 只验有限性）——parse 时草稿越过上界返回 `undefined`，
     走官方通道置 `state.invalid`；显示层 `invalidLabel` 用新词典键 `invalidRange`
     （插值上限值）。
  2. **跨字段配对**（parse 做不到——单字段解析时看不见别的字段）：
     `makeBundleCard` 传给 `SettingsForm` 的 state 叠加
     `{ ...shell, invalid: shell.invalid || 配对违例 }`（`pollIntervalMs` 草稿 >
     `maxWaitMs` 草稿 → true）；**不包 save**。配对违例同时在 `pollIntervalMs` 字段
     显示层给 `invalidPair.pollIntervalMs` 原因文案（点名两字段与调整方向）。
  3. 上界与配对常量抽到**新文件 `lib/budget-limits.js`**（纯常量模块，无 schemastery
     依赖）：`lib/config.js` 的 `.max()` 接线与 `client.js` 的草稿校验同源。**可达性
     按可达性登记**：`client.js:51` 注释称"客户端模块图只投递平名包"，第一个
     探针就验证该 import；不可达则 fallback = client 侧内联同一组常量 + 对账单测
     （断言两处常量相等，漂移必红），并回写本节。
- **提交层（第二道，兜直写路径——API 直调、旧版卡片、外部写文档）**：字段级越界死在
  `resolveConfig`（`lib/config.js:307-333`）里 `Config()` 的 `.max()`（消息可读：
  `expected number <= 2147483647 but got …`）；跨字段死在 `assertCrossFieldOrder`。
  保存时的表现（设置写路径链）：设置卡片照常落盘（官方表单只验有限性）→ loader
  `_commitVolatile` 里 `Config()` 抛 → 宿主 warn 一条可读消息 + **运行值不动**（工具
  与描述继续用旧值）→ 插件自己的 volatile-update 处理器（`lib/settings.js:128-137`）
  自检失败 → warn + 生命周期通告"提交未生效，保留旧值"→ 卡片回显旧生效值。**不取
  `.loose()`**：它把越界值静默收敛成默认，正是 R28 打击的静默失败类；需求明文要
  "拒绝并给可读错误"。
- 拒绝面只拦**新写入**：已落盘的合法值不受影响；越界垃圾留在文档里会让下次激活
  fail-loud（行级报错）——这是 schemastery 对一切类型非法值的既有语义（与 installFailLoud 同族），
  不是本裁决新埋的雷，处置写进 31.11。

#### wait_ms 覆盖口径成文

- 事实：`wait_ms` 只覆盖**竞速段**——deadline 在屏障之后才武装（`lib/wait-agent.js:300-303`），
  屏障最多 3 次重试睡（`BARRIER_ATTEMPTS = 4`，`:141`/`:243-247`）。结构上今天已成立，
  本项只**成文 + 钉测试**，不改时序。
- 落点两处：两个等待工具的描述模板（`buildToolText`，随 `pollIntervalMs` 现值插值）
  + README 预算节。口径句：总等待 ≤ `wait_ms` + 3×`pollIntervalMs` + 查询往返。
- 测试断言（假时钟）：从 execute 进入到结局的总耗时 ≤ `waitMs` + 3×`pollIntervalMs` +
  容差（测试常量，覆盖查询往返的公平余量）。

### 31.5 e 前台 killed 分流（裁决 R29-e）

- `jobOutcome` 的 killed 分支（`lib/jobs.js:252-253`）补齐两件事：detail = signal 细节 +
  既有 lossy 拼接（同款 `detail.lossy` / 落点）；**携带部分输出**——collector 有文时
  渲染 `output`/`truncated`（与 `completedResult` 同款守卫与截断，沿用 `maxResultChars`），
  无文时键省略。两路（已注册 done 钩子 / 前台 done 胜者）共用同一函数、同一分支。
- 让出竞速的 done 胜者（`:588-595`）：`proc.status === 'killed'` 时**先**走
  `jobOutcome(proc, collector, liveEscalationModes(), lang, { … })`；`completedResult`
  退位为非 killed 的唯一出口。竞速前既有一次 `collector.drain()`（`:586`），丢失旗标
  与部分输出在此已就位。
- **schema/render 配套（缺了真机必炸）**：`async_run` 的 output schema
  （`lib/jobs.js:472-494`）现只有 completed/running 两支，killed 结局将 matched 0
  branches。定向修改：oneOf 增第三支——`status: const 'killed'`，`detail` 可选、
  `output`/`truncated` 可选（有文才带）、`additionalProperties: false`；render
  （`:499-506`）增 killed 形态——可见文本 = `detail` + （有文时）`output` 与截断标记
  拼接，沿用 completed 支的拼装次序。
- **裁决**：前台 killed **保留部分输出**。今天 killed+done 胜者经
  `completedResult` 也带 output（丢的是 status 如实性，不是输出）；改道后不带输出才是
  行为退化。保留输出消掉退化，status 如实是本项的正面目的。
- 边界如实登记：前台 killed **不注册**作业（与今天一致），output 只含让出窗口内已
  收到的字节；已注册路径的完整输出读取走 `async_wait_job` 的 `jobs.read` 面，不受影响。

### 31.6 f 边界小项（裁决 R29-f）

| 项 | 定向修改 |
| --- | --- |
| `registerFailed` detail（`lib/jobs.js:355-367`） | `{detail}` 插值前单行化（CR/LF/TAB → 空格）+ 500 字符截断（截断时后缀 `(+N)`）；完整原文 `ctx.logger?.warn` 进操作者日志 |
| 日志插值（`lib/jobs.js:611-613` 等） | 字段名如实：`command=` 改 `label=`（值来自 `args.description`）；新增 `escapeLogValue`（CR/LF/TAB 转义为 `\r` `\n` `\t` 字面）应用于**全部**模型可控插值点（jobs `:611-613`、wait-job `:230-233` 的 job_id、wait-agent `:390-393` 的 agent_id——该行现状只插 agent 与 waitedMs，无 label，按现状钉）——需求条款是"操作者日志插值单行化"，按类修不按行修 |
| `routes` 先验（`lib/agent.js:100-110`） | `routes === undefined \|\| !Array.isArray(routes)` → `error.noPolicy` 词典错误（对象型 state 注入不再 TypeError 崩栈） |
| `sandboxMode` 读取（`lib/jobs.js:522`） | `ctx.shell.sandboxMode` → `ctx.shell?.sandboxMode`（对齐 `:426`） |
| `listChildren` 透传 signal（服务签名带可选 signal，本包现状只传第一参） | `childOf` 增 signal 形参，四个调用点（wait-agent `:244`/`:295`/`:326`/`:352`）传 `exec.signal`；`knownChildren` 同传。中止中的等待更快退出（listChildren 拒绝 → `childOf` → `undefined` → 既有查询失败口径），不新增路径 |
| `tools/` 硬编码路径 | `_host-resolve.mjs:49` 删服务家目录候选；`validate-preset.mjs:48` 删盘符字面候选、`:50` 删用户目录字面但**补 APPDATA 推导的同位候选**（保留 Windows 常规布局回退）；`check-alias-tokens.mjs:28` 删字面候选、改走 `_host-resolve` 统一解析——`_host-resolve.mjs` 因此**新增锚点目录推导导出**（现状只导出 resolve 钩子，`:67-73`；check-alias-tokens 要的是目录路径）。开发机一次性 `setx DSAT_HOST_MODULES <服务安装树的 node_modules>`（tools README 登记；`package.json` 不写机器路径）。缺 env 且需要宿主模块时**响亮失败**并给 export 指引——不引入 skip |
| 静态钉子 | 新单测：只扫**三个定向修改文件**（`_host-resolve.mjs` / `validate-preset.mjs` / `check-alias-tokens.mjs`）源文本，盘符字面（`[A-Za-z]:[\\/]` 出现在字符串字面里）零命中——重引本机路径必红。范围不扩到 `tools/` 全目录：其余文件的存量盘符是测试假件值与白名单映射表（`bench-encoding.mjs:13`、`check-bare-filenames.mjs:49`、`check-doc-paths.mjs:61-86`、probe 假件值），需求 f 未点名，扩大即越权 |

### 31.7 g 暴露面登记（裁决 R29-g）

README 新增"信息暴露范围"一节，纯登记不改行为：(1) 随请求下发给子进程的 `DSH_*` 变量
清单——来源是 `ctx.shellEnv.collect(exec)` 的实际键集（`lib/jobs.js:551-554`，
枚举登记；"`DSH_WEB_URL` 不含令牌"是实测结论，全量清单以 collect 实测为准，不得冒引）；(2) spill 落点为系统临时目录**绝对路径**；
(3) 注册失败 detail 的 500 字符截断上界（完整原文只进操作者日志）。验收 = 文档核对
（与 collect 键集 / 实测键集 / spill 落点口径 / 上表一致），非机证。

### 31.8 定向修改清单

| 文件 | 锚 | 定向修改 |
| --- | --- | --- |
| `lib/wait-agent.js` | `:141`/`:219-229`/`:243-247` | `aborted` 创建点 no-op catch；注释三层依据改写；`childOf` 透传 signal |
| `lib/wait-agent.js` | execute 头 / `:354-361` | 入口 `exec.signal?.aborted` → interrupted（`waited_ms: 0`）；settled 分支按 `via === 'settlement-text'` 加复查门 |
| `lib/wait-job.js` | `:26-32`/`:43-45`/`:111-114` | `snapshotOf` 改 `list()` 三分；`outputOf` 读失败标注；屏障 `undefined` → `error.queryFailed` |
| `lib/wait-job.js` | `:133-192`/execute 头 | 接线段入 try/finally（声明提前 + 空值护栏）；入口中止短路 |
| `lib/jobs.js` | `:66-98`/`:252-253`/`:355-367`/`:522`/`:588-595`/`:611-613` | collector 丢失旗标；killed 分支补 lossy **与部分输出**；registerFailed 单行截断；`shell?.`；done 胜者 killed 分流；`label=` + 转义 |
| `lib/jobs.js` | `:472-506` | output schema oneOf 增 killed 支；render 增 killed 形态 |
| `lib/budget-limits.js` | 新文件 | 上界与配对常量（纯常量，无 schemastery），config.js 与 client.js 同源消费 |
| `client.js` | `makeSpecs`（`:157` 数值 spec）/`makeBundleCard` state 传参/词典 | 数值 spec parse 越界返回 `undefined`（官方通道置 invalid）；壳层叠加 `invalid: shell.invalid \|\| 配对违例`（不包 save）；`invalidRange` / `invalidPair.pollIntervalMs` 词典键 |
| `lib/agent.js` | `:100-110` | `Array.isArray` 先验 → noPolicy |
| `lib/interrupts.js` | `:119-129`/`:156-162` | 正文回退 `via: 'settlement-text'`；尾注口径同步 |
| `lib/settings.js` | `:142-144` | 浮动 import `.catch` → warn |
| `lib/config.js` | `:84-132`/`:260-263` | 七字段 `.max(2147483647)`、`maxResultChars` `.max(1000000)`；`ORDERED_PAIRS` 追加；`.max()` 数值改引自 `lib/budget-limits.js` |
| `lib/text.js` | 词典 | `error.queryFailed`、`render.readFailed`、`via.textFallback`（zh/en 成对） |
| `lib/wait-job.js` 注释 / `docs/design.md` §22.3 | `:203` / `:1077` | 复查快照措辞随 `list()` 基同步 |
| `tools/_host-resolve.mjs` / `tools/validate-preset.mjs` / `tools/check-alias-tokens.mjs` | `:49` / `:48`+`:50` / `:28` | 删硬编码候选、补 APPDATA 推导、统一走 `_host-resolve`；`_host-resolve` 新增锚点目录推导导出（L5） |
| `README.md` | 预算节 + 新节 | wait_ms 覆盖口径；"信息暴露范围"一节 |
| `test/*` | 新增 | 见 31.9 |

### 31.9 判据

**单测（仓内假件，全部可失败）**：

1. 屏障窗口中止（barrierSleep 中途触发假 signal）→ 无 unhandledRejection 且竞速以
   aborted 拒绝退出；撤掉 no-op catch → 必红（`process` 级监听 unhandledRejection 的
   断言）。
2. 入口已中止（两工具）→ 立即 interrupted、`waited_ms === 0`、wait-agent 断言
   `listChildren` 未被调用、wait-job 断言 `jobs.wait`/屏障 `jobs.list` 未被调用；撤掉
   入口短路 → 必红。
3. `jobs.list` 抛错 → `error.queryFailed` 前缀且**不含** unknownJob 文案；`list` 缺席 →
   unknownJob 前缀；把查询失败并回查无 → 必红。
4. `jobs.read` 抛错 → 输出首行含读取失败标注；撤掉标注 → 必红。
5. drain 读失败 / 守卫触顶（喂超上界分块）→ 结算 detail 带 `detail.lossy`；撤旗标 → 必红。
6. 正文回退命中 + 复查仍 running → running 结局；`senderSessionId` 命中 → settled 直返
   （不加复查）；撤复查门 → 必红。
7. killed + done-resolved 假 proc 驱动让出竞速 → killed 结局（signal 细节 + lossy +
   部分输出）；撤分流 → 必红（变 completed）。**返回值过 `async_run` 的 output schema
   同形校验**（测试内用同一 schema 构造器喂宿主校验函数或等价断言；单测只
   断言字段抓不到 matched 0 branches——失效机理记载于 `lib/jobs.js:186-198`）；
   撤 schema killed 支 → 必红。
8. `maxWaitMs = 2^31`、`pollIntervalMs > maxWaitMs`、`defaultYieldMs = 2^31` 的持久化经
   `resolveConfig` 同一入口拒绝，消息可读；撤任一上界/配对 → 对应用例必红。
9. 总耗时上界（真定时器，running 结局，**两半各一条**——旧推演漏了
   "子代理在场时屏障首查即中、barrierSleep 恒零调用"这一步，单用例对屏障变异不可红）：
   (a) 等待段半边——子代理在场，全程 ≈ `waitMs` ≤ `waitMs + 3×pollIntervalMs + 容差`；
   (b) 屏障段半边——子代理行在第一个 `pollIntervalMs` 后才出现（屏障恰好睡一次），
   断言全程 ≥ 1×`pollIntervalMs` 且 ≤ 上界。变异 = **屏障加重**（假件让 `barrierSleep`
   单次睡越界量，如 +2000ms）→ (b) 必红（原"deadline 提前武装"变异在两条
   路径上都推不出红，废止）。
10. `routes` 注入对象型 state → `error.noPolicy` 前缀（不 TypeError）；撤先验 → 必红。
11. `description` 含 CRLF → `yielded` 日志行内无裸换行且字段名 `label=`；`registerFailed`
    长文本 → 单行 + 500 截断 + 操作者日志有全文；撤转义/截断 → 必红。
12. 三个定向修改文件（`_host-resolve.mjs` / `validate-preset.mjs` / `check-alias-tokens.mjs`）
    盘符字面零命中（静态扫描）；重引本机路径 → 必红。范围不扩。
13. a 项 try/finally：接线段注入同步抛（假件让 `watchUserInterrupt` 抛）→ 监听器/定时器
    全部处置（dispose 计数断言）；撤 try → 必红。
14. 卡片层预校验：断言钉在**传给 `SettingsForm` 的 `state.invalid`**
    上——(a) 数值草稿越过上界 → parse 通道置 invalid 且字段层有 `invalidRange` 文案；
    (b) `pollIntervalMs` 草稿 > `maxWaitMs` 草稿 → 壳层叠加置 invalid 且
    `pollIntervalMs` 字段层有 `invalidPair.pollIntervalMs` 文案。变异拆两条：撤数值
    spec 的上界 parse → (a) 必红；撤壳层叠加 → (b) 必红。常量来自
    `lib/budget-limits.js`（与 config.js 接线同源；若按 31.4 fallback 内联，则对账
    断言两处相等，漂移必红）。
15. settings 悬空动态 import 的 `.catch`：静态钉（剥注释源码匹配 import 链上的
    `.catch(`）；撤掉 → 必红（T8b，两平面测试文件）。

**真机（验证实例，提权档双口径见 §30.7 顶部裁定）**：

- **越界保存被拒（两层各验一层）**：卡片层——设置页输入 `maxWaitMs = 2147483648`（或
  `pollIntervalMs` > `maxWaitMs`）→ 保存按钮禁用 + 字段下原因文案（第一道）；提交层
  ——经直写路径（RPC settings/update）提交越界值 → **网关按本包 schema 拒绝**
  （`settings/rejected` + schemastery 可读消息含上界）、回读值未变、工具行为不受影响
  （真机实测口径——字段级在网关拦；跨字段违例 schema
  表达不了，仍走落盘 + loader warn 的路径）。测后回正保存。
- **等待总耗时上界**：一条正常长命令的 `async_wait_job` 读数——总耗时 − 命令观测时长
  ≤ 3×`pollIntervalMs` + 查询往返 + 容差，记录读数入档。
- e 的 killed 在 Windows 上不可稳定编排（外杀不产生 POSIX signal，实测的 killed 主要
  来自句柄 kill 与 spawn 中止）→ **真机不设必过项**，以单测为准。
- g 的验收是文档核对，非真机机证。

### 31.10 使用文档与回滚

- README：预算节补七字段上界表与 `pollIntervalMs ≤ maxWaitMs` 联动；"信息暴露范围"新节
  （g）；wait_ms 覆盖口径句（与工具描述同一份措辞）。
- 交付记录：R29 条目；开发机 `DSAT_HOST_MODULES` 的一次性设置说明；静态钉子用途。
  （新增宿主事实：schemastery 上界拒绝面与消息、设置写路径无值校验 +
  `_commitVolatile` 越界语义、jobs-local `get`/`list` 的三分基础。）
- 回滚：整轮一个提交，`git revert` 即回；上界只拦**新写入**，回滚不触碰已落盘的合法
  值；`tools/` 候选删除后开发机需 env（回滚同样恢复候选）。

### 31.11 风险

| 风险 | 处置 |
| --- | --- |
| 越界垃圾已落盘 → 下次激活行级 fail-loud | schemastery 对类型非法值的既有语义（与 installFailLoud 同族），非新雷；行活着时重存好值即回正，行死后手改 profile；`.loose()` 备选已裁掉（静默改值违背 R28 纪律） |
| 只调小 `maxWaitMs`（低于默认 `pollIntervalMs`）会被配对拒绝 | 拒绝消息是**键名对**风格（`lib/config.js:283-285` 现行口径，不升级——升级会改既有两条 pair 的文案）；两值与修法由卡片层 `invalidPair.pollIntervalMs` 原因文案 + README 联动说明承担 |
| 七字段全封被读成超需求范围 | 31.4 裁决已按机制分档写明（六个堵「setTimeout 2^31-1」真洞、`defaultWaitMs` 统一口径） |
| 前台 killed 的输出面 | **保留部分输出**（裁决见 §31.5）：让出窗口内已收到的字节进 `output` 字段，与今天信息面等齐、status 如实化；不注册作业的边界不变（完整输出本就只在已注册路径可再取） |
| 卡片层预校验与官方表单校验并存 | 官方 parse 只验有限性（设置写路径不做值校验）；本包挂法走**官方 parse 通道**（单字段）与壳层 state 叠加（配对），不包 save、不触碰官方模型内部（挂法见 §31.4）；判定常量与 config.js 同源（`lib/budget-limits.js`；不可达时内联 + 对账断言），两处漂移由判据 14 拦住 |
| killed 带输出使已注册路径 `JobOutcome` 增键（`output`/`truncated`） | 宿主对 JobOutcome 协议的处置面（预期宽容：增键不改既有键语义）；若宿主严格校验则回退为仅前台路径带输出、登记差异。**已确认**：`dsh-jobs-local/lib/index.js` 的 `settle()` 只读取 `status`/`detail`/`result` 三个已知键（`jobs.set(...)` 传整个 outcome，宿主按需取键），多余键被忽略——增键宽容成立，无需回退 |
| `list()` 三分的全表视图成本 | 本插件作业量级下可忽略；换来不依赖 host 错误消息字符串判别 |
| 正文回退复查在误报场景多等一轮 | 弱证据换诚实结局，方向与"完成优先"不冲突（复查 inactive 时仍直返 settled）；权威路径零开销（不加复查） |
| `exec.signal` 透传后中止等待更快走到 listingUnavailable | 与竞速后中止同一条既有出路（execute 抛），非新路径；入口中止已被 b 短路 |

## 32. R30：提问接管（抢先应答者、超时放行、全局待答界面、迟到作答注入）

### 32.0 需求与事实锚

- 需求唯一权威：`docs/requirements.md` R30（提问接管全节，609 行起）。四件套：**a 接管点**（宿主半边
  `user-questions/request` waterfall 抢先应答者，`prepend` 注册，四条件全满足才接管，否则
  `next()` 交还原生链；工具表与预设工具行零变化）、**b 超时放行**（默认 60000 ms 窗口；
  窗口内作答返回真实 answers；耗尽返回合成 answers（每题 `selected: []` + 超时说明 custom）；
  取消维持原生 `ASK_ABORTED`）、**c 全局待答**（sidebar 徽标与 overlay 浮框两座位都做，
  volatile 枚举切换，徽标本体自绘）、**d 迟到作答注入**（自声明 kind 的通知形消息按
  Agent 状态选通道立即投递——空闲 followup 唤醒 / 运行中 inject 折入当前轮次，正文
  自含完整题面，`async_wait_*` 插件事件 + 起始检查唤醒分支——用户裁定）。
  边界约束：总开关默认关、关闭时零行为变化；计划评审 intent、审批链、
  标准预设行为不碰；端到端证据取自验证实例，开发实例只做冒烟不重启。
- 事实依据（均已亲读/实测钉锚）：原生调用链与等待语义（`ask` 无超时、steer 不打断、断连不取消，
  停止才 `ASK_ABORTED`）；子代理即错不挂起、headless 无该工具（条件④的服务层保证）；
  waterfall 注册方式与 prepend 抢先；注入 API 与迟到信息先例；
  客户端座位契约（徽标自绘）；合成答案合法形状；会话预设判定路径
  （核验：`request.agent.id` → `ctx.sessions.get` → `sessionProjections.stateOf(session,
  "agentPreset")` 同步全等比较）；作答回传与待答状态的裁定依据（自有 typert remote 命名空间
  可行 + 无客户端→宿主的推送通道 → 轮询；settings mutate 不可行；`ctx.uiWorkspace.openSession`
  跳转座位）；`plan-review` 字面量与 `ASK_ABORTED` 的 plain-object 还原通道。
  两条「待核验」已核验销账，requirements R30 实现约束两行同步改写。
- 数字登记（requirements §5 已随本设计落账）：`ASK_TIMEOUT_MS = 60000`（默认，用户裁定），
  界 `[10000, 600000]`（本节裁决 R30-A）；`ASK_STATE_POLL_MS = 1000`（本节裁决 R30-E）。
- **非目标**（R30 非目标节逐条）：不接管计划评审；不自动选推荐项；不替换 `ask_user_question`
  工具本体；不改标准/创造预设行为；不做页面外通知渠道。

### 32.1 总开关与三个设置字段（裁决 R30-A）

新增 volatile 字段三枚，字段集合 13 → 16（R30 实现约束）：

| 字段 | schema | 默认 | 说明 |
| --- | --- | --- | --- |
| `askTakeover` | `z.boolean().default(false).loose().volatile()` | `false` | 总开关（照 `silentFailureGuard` 同款：loose 收敛、`resolveConfig` 末端 `=== true` 归一） |
| `askTimeoutMs` | `z.number().min(10000).max(600000).default(60000).volatile()` | `60000` | 等待窗口。下界 10000 = 在场用户读完题并点选的最短可用窗口（再短则"在场也来不及答"成为常态，接管只剩打扰）；上界 600000 对齐宿主 wait 预算上界量级。`FIELD_MAX.askTimeoutMs = 600000` 进 `lib/budget-limits.js`，客户端镜像同值（T23c 对账） |
| `askUiSeat` | `z.string().default('overlay').volatile()` + 值域校验 | `'overlay'` | 座位枚举 `'overlay' | 'sidebar'`。默认 overlay 的理由：本功能的存在理由是无人值守时刻，侧栏底栏徽标易被忽略，浮框即时可见；切换成本为零（R30 用户裁定两版齐备实测再定去留，默认值属设计内事务） |

- `askTimeoutMs` 的下界也进**卡片层预校验**：`boundedNumberSpec` 扩出 `FIELD_MIN` 表
  （`askTimeoutMs: 10000`），parse 低于下界走官方非法通道（与 R29-d 上界同一条因果链）。
- `MS_FIELD_KEYS` 增 `askTimeoutMs`（秒数读数长在说明行，R21 机制）；`ASK_FIELD_KEYS`
  导出供界面判据按身份核对；`materializeConfig` 的解包循环覆盖新字段组。
- 取值时点：应答者在**接管那一刻**读活快照的 `askTimeoutMs`（每批次一份，不随窗口中途
  改设置而变——窗口语义必须可预期）；注入文案在**注入那一刻**读 `agentLang`。

### 32.2 a 接管点：四条件判定与运行时注入（裁决 R30-B）

- **挂载**：`lib/host.js` 的 `applyHostHalf` 增加 `ctx.inject(['sessions',
  'sessionProjections', 'agents'], (scope) => …)`——**运行时 inject 而非静态表**（R28
  `systemPrompt` 成例：静态 `inject` 列不动，工具行装载不受牵连）。scope 上挂
  `scope.on('user-questions/request', responder, { prepend: true })`（prepend 无条件
  排在 `dsh-api-remotes` 转发器之前——宿主转发器未用 prepend 注册）。scope 回调里同时创建待答注册表与 remote 服务接线
  （§32.6）；disposer 由 scope 生命周期自动收（R4）。
- **判定序**（廉价在前，任一不满足即 `next()`；②④的读取失败也 `next()`，保守方向）：
  1. **①总开关**：`readSnapshot()?.askTakeover === true`（快照缺席 = 关）。
  2. **②agent 在场**：`request.agent !== undefined`（无 agent 的编程式请求交还原生链）。
  3. **③计划评审**：`request.questions.some(q => q.intent?.kind === 'plan-review')` →
     `next()`（一批次任一题带它即整批原生——计划评审是单题批次，保守按整批判）。
  4. **②预设**：`ctx.sessions.get(request.agent.id)` 取 Session →
     `ctx.sessionProjections.stateOf(session, 'agentPreset')` → 与 `'dsh-async'` /
     `'dsh-async-create'` 全等。任一跳 undefined/抛错 → `next()` + stderr 审计一行。
  5. **④根复验**（三态写全）：`agents.roots().includes(request.agent)` 不成立 → `next()`
     （防御性复验，服务层已对子代理调用者拒绝）；agents 服务**在场但读取抛错** → `next()`（与②同
     保守方向，审计一行）；agents 服务**缺席** → **跳过本条继续接管**——它是冗余防线，缺席
     不该挡接管，与②的保守方向有意不同，理由：②是接管的资格条件，④是冗余复核。
- **判定全过 → 接管**：`return await manageBatch(...)`（§32.3）；waterfall 其余监听者
  （含转发器）不再运行。**判定期间不 await 任何慢路径**：`stateOf` 同步，
  判定整体同步完成，抢先语义无窗口竞态。
- **可逆卸载**：scope disposer 对每个**未结批** `next()` 交还原生链（原生卡片接管继续
  等人），清空注册表、停定时器、摘 signal 监听——插件卸载后行为回到原生（R4）。已结批
  与 `expired` 批**不得再调 `next()`**：cordis waterfall 的 `next` 是对可变回调表的无护栏
  闭包，晚调用会重入原生转发器、让浏览器弹出模型早已收到合成答案的幻影问题卡；
  `expired` 批的迟到作答窗口随卸载一并消失（agent 引用失效后注入无意义，§32.3 同款取舍）。

### 32.3 b 超时放行与整批结清规则（裁决 R30-C）

`lib/ask-takeover.js` 的批次管理（全部状态在宿主行内存，重启即清——设计取舍：待答是
运行时事实，不写持久层；重启后旧批次的 agent 引用已失效，迟到作答本就没有通道）：

- **批次记录**：`{ batchId, sessionId, agent, questions: Map<qid, {def, state}>,
  receivedAt, expiresAt = receivedAt + askTimeoutMs, settled }`；`batchId = 'ask-' + 自增 +
  '-' + 随机段`。每题 `state ∈ 'open' | 'answered' | 'ignored'`（answered 携
  `{selected, custom}`）。
- **入口中止**：接管时 `request.signal?.aborted` 已真 → 直接以原生错误形状抛
  `{name:'UserQuestionError', message:'ask_user_question was aborted before the user
  answered', code:'ASK_ABORTED'}`（`ask()` 的 `restoreUserQuestionError` 还原，模型侧与原生
  逐字一致）。
- **中止监听**：接管期间 `signal.addEventListener('abort', …)` → 未结批立即按同形状拒绝、
  清理、批次出列（`ASK_ABORTED` 不得被合成答案盖过——R30-b）。已结批（超时/齐答后）abort
  到来 = 无操作（监听器在 settle 时已摘）。
- **超时竞速**：`ctx.timer.timeout(onExpire, askTimeoutMs)`（接管时读快照）。触发时：所有
  `open` 题按合成形状规则（`{id, selected: [], custom: timeoutCustom(seconds)}`），
  `answered`/`ignored` 题保留用户作答/跳过形状（`windowSkip` custom）；整批
  `{answers:[…]}` resolve waterfall；若超时时刻存在 `open` 题 → 批次转 `expired`（留在
  待答列表供迟到作答），否则整批出列。
- **齐答提前结清**：窗口内用户把全部题 `answered`/`ignored` → 撤定时器、立即按同形状规则
  resolve（用户答完还干等窗口耗尽是敌对体验；合成形状天然允许混合）。撤定时器必须在
  settle 同一同步段完成（防超时回调与齐答双结——幂等护栏：settle 后再触发的一律丢弃）。
- **不代答**：合成答案永远 `selected: []` + 说明 custom（R30 裁定；不自动选推荐项）。
- **expired 批寿命上界**：`expired` 批留列供迟到作答，但不能无限
  累积（徽标只增不减 = 内存与界面的双重无界）。上界 `EXPIRED_TTL_MS = 24 h`：新批次接管时
  清扫超龄 `expired` 批（`now - expiresAt > TTL` 即删，一次 O(n)）。24 h 后 agent 引用即便
  还在、会话多半早已翻页，注入价值趋零——上界取「 generously 晚于任何合理迟到」即可。
- **超时说明文案**（`lib/text.js` 新键 `ask.timeoutCustom`，agentLang 双语，语义按 R30-b）：
  en `The user has not answered within {seconds} s: proceed with your best judgment; the
  answer will arrive as a notice injection if the user answers later.` / zh `用户暂未应答（等待
  {seconds} 秒超时）：请按你的最佳判断继续；用户稍后作答时答案会以通知注入送达。`
- **窗口内跳过文案**（`ask.windowSkip`）：en `The user chose to skip this question
  while the pending window was open.` / zh `用户在等待窗口内选择跳过本题。`

### 32.4 c 浏览器半边：两种座位与轮询模型（裁决 R30-D/E）

- **通道**（裁定依据：自有命名空间轮询可行、无客户端→宿主推送通道）：状态 = 轮询自有命名空间 `state()`，间隔 `ASK_STATE_POLL_MS = 1000`
  （`setInterval`，模块 dispose 清除；`visibilitychange → visible` 与每次 answer/ignore
  动作后立即补一次轮询；后台标签页由浏览器节流，不另做可见性门控——晚到总比停了好）。
  作答/忽略 = `answer` / `ignore` 方法直调（送达回执 = RPC ok/error，失败在界面报错文案，
  不静默）。
- **模块接线**（`client.js` 单文件内新增，与设置卡并存）：`ctx.configForms.whileServed(
  [ENTRY], …)` 门内构造待答模型；模型订阅设置 scope（与设置卡同一 `SettingsFormScope`），
  读 `askTakeover`（关 → 停轮询、两座位组件渲染 null——**零行为**）与 `askUiSeat`（换座位
  = 换注册，注入与超时逻辑不随座位变，R30 单测判据）。
- **座位 overlay**（默认）：`ctx.slots.inject('shell.overlay', () => ctx.slots.register(
  {name:'shell.overlay', id:'async-tools-ask', order: 900}, …))`，组件在计数 > 0 时 portal
  右下角浮动圆角框（`document.body`，官方 overlay 先例），内部渲染共享待答列表；计数 0 渲染 null
  （消隐）。
- **座位 sidebar**：`ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
  {name:'sidebar.footer.action', id:'async-tools-ask', label: <词典>}, …))`，计数 > 0 时渲染
  自绘徽标按钮（座位契约只给位置，徽标注数自绘——cordis 面板先例）；点击弹 portal
  浮层渲染同一共享列表；计数 0 渲染 null（整个座位项消隐，与 overlay 同口径）。
- **共享待答列表**（`AskList` 组件）：按会话分组（组头 = 会话 id 短式 + 跳转按钮
  `ctx.uiWorkspace.openSession(sessionId)`）；组内每题：题目文本、选项 chips
  （`multiSelect: true` 时 toggle，否则单选**替换**——与原生 `choose()` 同语义；
  题面透传 `multiSelect` 字段）、自定义补充输入、提交与忽略两按钮、剩余秒数（`expiresAt`
  按宿主 `serverNow` 校准时差后本地走秒，仅显示用）；`expired` 批次标「已超时，仍可作答」
  徽段。无 options 的题只渲染自定义输入（官方问题可无选项，`ask()` 校验读
  `question.options ?? []`）。
- **失败面**：RPC 回执 `{ok:false}` → 面板顶
  `ask.callFailed` 报错行（可重试）；宿主回执 `outcome:'failed'`（迟到注入
  followup/inject 任一通道抛错、
  条目已出列、无重试通道）→ 该题记入 `lostAnswers` 名单（复合键 batchId/questionId，
  去重、上限 20）在面板顶列名报错——用户的答案没送达，必须被人看见。**座位渲染门把
  `lostAnswers` 计入**：failed 只发生在 expired 批迟到提交、该题随即出列，门若只看
  待答计数，单题批次（最常见形态）的报错名单永不显示；每条报错带「知道了」消除按钮
  （`ask.dismissLost`），未读失败不算「处理完」——消除后才回到 R30「全部处理完消隐」
  口径（R30-c 的「处理完」据此读作「已答/已忽略 + 失败已被看到」）。
- **样式**：只引用 `--dsw-alias-*` 定义表内名字（check-alias-tokens 把关）；徽标错误
  色一律 `--dsw-alias-state-error-primary`。
- **客户端词典**（`DICTIONARIES` zh/en 各增）：`ask.title` / `ask.count` / `ask.answer` /
  `ask.ignore` / `ask.customPlaceholder` / `ask.jump` / `ask.expired` / `ask.submitting` /
  `ask.callFailed` / `ask.dismissLost` / `ask.windowLeft`。座位与面板组件拿不到槽渲染
  props 的宿主 t，但客户端 `ctx.locale` 读取面可达：**auto 档 = 宿主当前语言**
  （渲染订阅用 `getSnapshot().active`，一次性读用 `getLocale()`，zh/en 外回退 en 词典；
  用户裁定；「不得裸键名」护栏维持）。
- **`dsh.client.inject` 增四项**（`shell.overlay` 的运行时声明者是
  `dsh-client-ui-layout`，非 ui-workspace）：`@deepseek-ai/dsh-api-gateway`（`ctx.remote`
  来源，voice-input 同款）、`@deepseek-ai/dsh-client-ui-layout`（`shell.overlay` 座位声明
  者）、`@deepseek-ai/dsh-client-ui-sidebar`（`sidebar.footer.action` 座位声明者）、
  `@deepseek-ai/dsh-client-ui-workspace`（`ctx.uiWorkspace` 会话跳转）。

### 32.5 d 迟到作答注入：按状态选通道（空闲 followup / 运行中 inject；裁决 R30-C 三修）

- **批次语义：立即投递，攒批交给宿主领取语义**。作答/忽略到达即投递，插件不建队列：
  Agent 空闲且无未开跑的本包 followup → `followup`（唤醒开轮次，单条也立即）；否则
  （运行中，或空闲但自家 followup 尚未开跑）→ `inject`（next-step，折进当前或即将
  开始轮次的下一个领取点）。理由：宿主领取点（轮次首与各步骤边界）next-turn **恰领
  一条**、next-step **整批领取**——逐题 followup 实测退化成逐轮次串行（验证实例
  实测记录四答四轮次），且等待期间作答正文迟迟不进上下文（同实测记录三答逐分钟滴流）；inject
  折入让
  同窗口多答一次领取、模型当轮次即可行动，任何两次领取之间必有模型输出相隔。界面仍
  按题提交、按题出列；空窗口（followup 已发、轮次未开跑）内后到作答改走 `inject`，
  由该轮次首次领取顺走——不设去抖定时。
- **消息构造**（用户裁定：**通知形**）：
  `createUserMessage({ content: [...], source: { kind: <本包自声明串>, form: 'notice',
  summary } })` → 按状态选通道投递（本节批次语义：空闲且无未开跑的本包 followup →
  `followup` 唤醒开轮次；否则 `inject` 折入下一领取点；注入 API 三方法与迟到信息先例如上）。
  kind 命名由实现修正轮定稿登记（本包专属串，**不得**用 `'user'`——R12 插话判定对它不
  命中，迟到作答不是用户插话）。正文**自含完整题面**（用户裁定）：稳定 id、
  题干全文、选项标签全集、multiSelect、作答（选中标签 + custom）或忽略、提问时间或时延
  ——压缩或长对话后模型不依赖对原工具调用的记忆即可行动；summary 为一句话作答摘要
  （会话格式收录、官方先例同形，供 context 行折叠显示；Web 唤醒触发行显示分类标题，
  正文折叠在披露区）。正文模板（`lib/text.js`，agentLang，**投递那一刻**活读）：
  每题一条、按自含清单展开（`ask.lateAnswer`/`ask.lateIgnore` 保持单题模板，插值面按
  自含清单）；整批领取时多条消息同点进入上下文。
- **kind 字面登记**：`'async-tools-late-answer'`
  ——导出常量 `LATE_ANSWER_SOURCE`（`lib/interrupts.js`，宿主判定/注入/唤醒三面同源
  导入，任一侧复写必红）；命名对齐宿主 kebab 先例（`subagent-settled`、
  `cordis-host-runner`：属主前缀 + 语义段）；`verify/probe-r30-ask-takeover.mjs` 的
  真机锚 `LATE_KIND` 同串。注入语言取值时点：`submitLate` 经 `#langAtInjection`
  **注入那一刻**活读快照 `agentLang`（§32.1 取值时点条款；活读失败回退批次档）。
- **唤醒分支**（用户裁定：**插件事件 + 起始检查，与投递解耦**）：作答或
  忽略到达即刻由 ask-takeover 宿主半边发本包 ctx 事件（事件名由 `LATE_ANSWER_SOURCE`
  派生，载荷含 agent 标识与题号）；`async_wait_*` 订阅该事件，**并在等待开始时查一次
  待读登记**（本包内部登记，含已投递未领取的作答与忽略）——命中任一 → 提前返回"仍在
  运行"句柄 + note（对齐 `agent-message` 的提前唤醒先例；R3 信号分类由三类扩为四类：
  user 打断 / subagent-settled 权威结束 / agent-message 唤醒重查 / 迟到作答事件唤醒
  交还；判定互斥专门单测）。起始检查堵"作答先到、等待后开"的空窗（真机实测记录：已排队
  作答未能唤醒后开的等待，干等至预算耗尽）；note 至少指明作答已到与题号、通知在下一
  领取点进上下文。
- **末步竞态防护**：`inject` 落在轮次最后一次领取之后（轮次收尾窗口）→ 消息滞留
  next-step；空闲观察（`agent/status` → idle）发现待读登记非空 → 补发一条极小
  followup 提醒（不含作答正文，不重复投递）开轮次顺走滞留件。
- **迟到路径**：批次已 `expired` 时 `answer`/`ignore` → 该题出列（整批题全出列后批次
  记录删除）+ 记入待读登记 + 发唤醒事件 → 按状态选通道投递。投递抛错（会话已删等）
  → stderr 审计 + 登记清除，逐题按复合键返回 `{outcome:'failed'}` 供界面报错（无法
  重试：agent 引用失效不可恢复）。
- **互斥判据**：注入消息的 kind 为自声明串，与 `lib/interrupts.js` 的插话构造
  （`kind:'user'`）互斥联测——kind 改回 `'user'` 时联测必红（R30 可失败条目）。

### 32.6 remote 命名空间与服务接口（裁决 R30-D）

- **宿主侧**（`lib/ask-takeover.js`）：`class AskTakeoverService extends TypertRemoteService`，
  构造 `super(ctx, 'asyncToolsAsk', { namespace: 'async-tools-ask' })`（服务键与命名空间都
  带包名段，撞名风险小）。方法（全部 plain JS 方法，**参数名即 wire 名**）：
  - `async state()` → `{serverNow, items}`；`items` 按题展平：
    `{batchId, sessionId, questionId, question, options, receivedAt, expiresAt, phase:
    'open'|'expired'}`（`options` 原样透传 `question.options ?? []`；不含会话标题——未核验
    字段不读，组头显示会话 id 短式，跳转键就是 id）。
  - `async answer(submission)`，`submission = {batchId, questionId, selected, custom}` →
    `{outcome: 'delivered'|'late'|'gone'|'failed'}`（`delivered` = 窗口内已进工具结果；
    `late` = 已投递（通道按状态，正文在下一领取点进上下文）；`gone` = 批次/题不存在或
    已结；`failed` = 投递抛错——任一通道（followup/inject）同步抛错经本回执返回，
    竞态补醒失败经复合键进 `lostAnswers` 通道供界面报错，两时点都不重试）。
  - `async ignore(submission)`，`submission = {batchId, questionId}` → 同上 outcome 集。
- **方法标记（无 TS 装饰器的绑定）**：`@Remote` 是 ES 方法装饰器，plain JS 不可用语法；
  用导出的 `Remote` 函数 + **伪装饰器 context** 手工挂标记（只用公开 API，不抄私有常量）：
  `Remote(function(){}, { name, private:false, static:false, addInitializer(fn){ fn.call(instance); } })`
  ——`addMarkerInitializer` 由此走官方 `mark()` 路径写 prototype 标记（幂等，多实例安全）。
  网关 SRC 回退按标记 + **方法参数名**对位（`srcDescriptor` 的 `methodParameterNames`），
  因此参数名 `submission` 与客户端 descriptor 的 `wire:'submission'` 必须逐字一致——
  对账断言进单测（J-15）。
- **客户端侧**：手写 strict descriptors（voice-input 同款形态）经 `ctx.remote.$mount`
  挂载后 `ctx.remote['async-tools-ask'].state()` / `.answer(submission)` /
  `.ignore(submission)`——**载荷裸传**（客户端按 descriptor 的 wire 名**逐位组装
  位置参数**，官方先例全部裸传载荷对象，如 voice-input 的 `ctx.remote.speech.transcribe
  (request, signal)`；写成 `{submission}` 会被双重包裹，宿主收到的字段全部 undefined）。
- **生命周期**：服务实例挂在**宿主行 fiber**（applyHostHalf 直接 new；Service 基类随 ctx
  处置）。宿主行卸载 = 服务出方法表 + 应答者交还（§32.2 可逆卸载）。
- **peer 申报**（§23 表增两行）：`@deepseek-ai/dsh-typert-protocol`（**import**：
  `TypertRemoteService`/`Remote`）、`@deepseek-ai/dsh-llm`（**import**：`createUserMessage`），
  都精确锁（R38 起钉 0.2.0 线，现行 `0.2.0-rc.2`（R44），§37.1-1）。

### 32.7 定向修改清单

| # | 文件 | 定向修改 |
| --- | --- | --- |
| 1 | `lib/ask-takeover.js`（新） | 批次注册表、四条件判定、超时竞速、signal 还原、迟到作答待读登记 + 按状态选通道投递（followup/inject）+ 末步竞态补醒、唤醒事件发布、`AskTakeoverService`（三方法 + 手工标记）、可逆卸载。纯依赖注入（services、timer、snapshot 读、followup/inject 注入代理、事件总线全部入参），单测可直接喂替身 |
| 2 | `lib/host.js` | `applyHostHalf` 增运行时 inject 与 §32.2 接线；disposer 串联 |
| 3 | `lib/config.js` | `FLAG_FIELDS` 增 `askTakeover`；新增 `ASK_FIELDS`（`askTimeoutMs`、`askUiSeat`）；`materializeConfig`/`resolveConfig`/键集导出/值域校验同步 |
| 4 | `lib/budget-limits.js` | `FIELD_MAX.askTimeoutMs = 600000` |
| 5 | `lib/text.js` | `ask.timeoutCustom`（语义按 R30-b 通知注入口径）/ `ask.windowSkip` / `ask.lateAnswer` / `ask.lateIgnore`（en/zh；后两者保持 §32.5 单题自含模板，插值面按自含清单） |
| 6 | `lib/interrupts.js` | 插话分类（R12）之外增第四类：迟到作答唤醒——订阅本包 ctx 事件 + 等待开始时待读登记检查，`LATE_ANSWER_SOURCE` 常量注入/判定/事件名三面同源 |
| 7 | `client.js` | 待答模型 + 两座位注册 + `AskList` 共享组件 + 客户端词典 + strict descriptors + `FIELD_MIN` 卡片层下界 + `FIELDS` 三行（flag/ms/enum）|
| 8 | `package.json` | peerDependencies 增 typert-protocol / dsh-llm；`dsh.client.inject` 增四项（§32.4） |
| 9 | `test/ask-takeover.test.mjs`（新） | §32.8 单测判据 |
| 10 | `test/two-planes.test.mjs` 等 | 字段数 13→16 的对账判据组（T19 键集、T23c 增 `askTimeoutMs` 上界对账、`MS_FIELD_KEYS` 联动） |
| 11 | `verify/probe-r30-ask-takeover.mjs`（新） | §32.8 真机判据 |

### 32.8 测试设计（并入 §11 三层）

**单元（`test/ask-takeover.test.mjs`，假 services/假 agent/假 timer/假 signal）**——判据与
R30「可验证」逐条对齐：

- J1 总开关关 → `next()` 被调、注册表空、零接管。
- J2–J5 四条件逐一缺一（关/无 agent/plan-review intent/非本包预设/非根）→ `next()`；
  另 agents 服务**缺席**时其余条件全过仍接管（§32.2 三态的第三态）。
- J6 窗口内作答 → answers 逐字段原样（selected/custom 逐字）。
- J7 超时 → 合成 answers 逐字段（id 一一对应、`selected: []`、custom 含超时语义句；
  en/zh 两档各验一次）。
- J8 等待中 abort → 拒绝形状 `{name:'UserQuestionError', code:'ASK_ABORTED'}`，合成答案
  不出现。
- J9 超时后 abort → 无操作（无泄漏抛错、无注入；监听器已摘的证据）。
- J10 多题齐答提前结清 → 定时器撤销（假 timer 断言）、answers 混合真实/跳过形状、无双结。
- J11 迟到作答投递（按状态选通道）：Agent 空闲 → 立即恰一次 `followup`；运行中 →
  `inject`（next-step），同窗口两条 → 同一领取点整批、零 `followup`；空闲且自家
  followup 未开跑 → 后到者改 `inject` 由该轮次首次领取顺走；kind 为
  `'async-tools-late-answer'`（≠`'user'`）、`form:'notice'`、summary 在册；正文逐字段
  自含题面（稳定 id/题干/选项标签全集/multiSelect/作答或忽略/custom/时延）；
  **方法名断言**（followup/inject 按状态各被调、steer 零调用）。
- J12 迟到忽略 → 正文匹配 `ask.lateIgnore` 模板（自含清单插值）；唤醒事件与投递通道
  同形。
- J13 窗口内忽略 → `windowSkip` custom 进 answers。
- J14 `state()` 载荷形状 + 作答递减、清零出列。
- J15 wire 对账：服务方法参数名与客户端 descriptor wire 名逐字相等（防重构漂移）；
  另断言假 RPC 通道里宿主收到的 `submission` 与提交载荷逐字段相等（**单层包裹**——防
  双重包裹漂移）。
- J16 座位枚举只换呈现层：两座位取值下宿主管道路径判据（J1–J13 的抽样子集）不变。
- J17 卸载交还：scope dispose → 未结批 `next()`、注册表清空；**已结/expired 批不再
  `next()`**（晚调用重入原生转发器的幻影卡）。
- J18 客户端模型行为：开关关 → 零轮询（间隔零武装）；开 → 轮询落地、
  `state()` 零参调用；answer/ignore 动作把载荷**裸传**给 remote（经 `createAskModel`
  产品路径——包裹漂移必红）；`outcome:'failed'` → `lostAnswers` 记名（复合键去重）+
  `dismissLost` 逐条消除（客户端面）。
- J19 座位渲染门：关/计数 0/座位不匹配三态下两座位组件渲染
  null；匹配时 overlay 出面板、sidebar 出徽标；**只剩未消除 lostAnswers 时仍渲染**
  （报错可见面），消除完回到消隐。另：选项 chips 的单选替换/多选 toggle 语义有直调
  判据，sidebar 注册 label 随活快照语言翻词典有经 apply 的判据。
- J20 expired 批 TTL：超龄（> 24 h）expired 批在新批次接管时被清扫，
  龄内批不受影响。
- J21 待答界面语言三档（R30-c 修正）：auto 档经 `ctx.locale` 读取面解析宿主语言（假
  服务替身切换 `active` → 面板与座位文案整段切换）；zh/en 走本包词典；快照 `revision`
  与 `locale/change` 驱动重渲。
- J22 唤醒事件与起始检查（假事件总线 + 假登记）：作答或忽略到达 → 插件事件恰一次；
  等待中的 `async_wait_*` 收到事件、或等待开始时待读登记非空 → 返回运行句柄 + note
  （指明作答已到、下一领取点进上下文），不报 interrupted 亦不误报 settled，且与
  user/subagent-settled/agent-message 三类互斥；末步竞态 → idle 观察补一条极小
  followup（恰一次、不含正文）。
- **变异（可失败）**：删超时竞速 → J7 红；删预设过滤 → J5 红；运行中投递改回
  `followup` → J11 通道断言与整批领取判据红（运行中两题必产生两条 next-turn 消息）；
  删等待开始的待读检查 → J22 起始用例红；删末步竞态补醒 → J22 竞态用例红；空闲投递
  改 `steer`/`inject` → J11 空闲唤醒判据红；kind 改回 `'user'` → 与
  `interrupts.js` 插话构造的互斥联测红；auto 档死写
  en → J21 红；删题面任一字段 → J11 逐字段断言红；开关改构造快照 → R10 同款行为差异
  判据红（首问后翻快照，次问不得被接管）。

**接线**：`tools/_host-hooks.mjs` 宿主解析钩子覆盖两个新 peer import（真模块图加载冒烟）。

**真机（验证实例，`verify/probe-r30-ask-takeover.mjs`，执行档口径见 §30.7 顶部裁定）**——R30 真机判据①–⑧：

- 前置：设置 `askTakeover=true`、`askTimeoutMs=10000`（gateway 逐字段校验通道）。
- ①`dsh-async` 新会话 prompt 让 Agent 提问 → 转录含合成答案与后续动作（模型继续工作）。
- ②CDP 截图 overlay 出现且计数正确；对选项 chip 的真实点击 → 会话转录出现**通知形触发行**
  （非用户消息气泡），展开可见完整题面与作答，Agent 空闲时被唤醒开新轮次（answer 通道
  端到端）。
- ③standard 预设对照会话 → 原生问题卡片出现在 DOM、无徽标无浮框（条件②行为证据）。
- ④`askUiSeat='sidebar'` 后再问 → 徽标截图；切换即换座位。
- ⑤重启验证实例 → 设置与行为不变（开关仍开、提问仍被接管）。
- ⑥等待期间作答：Agent 正在 `async_wait_*` 等待时作答 → 工具提前返回运行句柄（非
  interrupted、非终态），作答正文在数秒内进模型上下文（下一条模型消息即引用作答）。
- ⑦宿主语言与 `uiLang` 各档组合（auto×zh 宿主 / auto×en 宿主 / zh / en）下待答界面
  文案语言正确（auto 跟随宿主）。
- ⑧通道与攒批：子代理等待期间作答不排队（正文当轮次进入上下文，非等待预算耗尽后）；
  空闲时连续作答多题（两秒内乱序）→ 首条立即开轮次，其余并入该轮次下一领取点整批
  处理（转录可见多条通知同一领取点）。
- 证据：日志与截图按探针名落 `verify/` 下留档目录（真机轮产生后指针入档）。

**开发实例冒烟（不重启）**：本机全套件 + 五检查器绿（提交态）；本会话（开发实例宿主进程早于本批代码）行为零差异的说明入档——改动在开发实例下次重启时自动装载（junction 同树），
开关默认关。

### 32.9 使用文档与回滚

- `README.md`：新增「提问接管」一节——字段表（三枚）、两座位形态与切换、超时/迟到语义、
  默认关与零行为承诺、证据路径。R30 节交付记录落交付报告。
- 回滚：开关关 = 原生行为（真机判据③同款对照）；bundle 摘除 = 全部消失（注册表内存态、
  无持久化残留）；预设行未动（R30 边界）。

### 32.10 风险

| 风险 | 处置 |
| --- | --- |
| typert 方法标记的伪 context 路径依赖 `Remote` 装饰器导出的接口稳定 | 升级时重读导出面；J15 + 真机②端到端把关（标记失败 = answer 通道死，探针必红） |
| 双页面同题竞争（两个标签页同时轮询作答） | 每题状态机单写者（宿主注册表），后来者 `outcome:'gone'`；界面按回执刷新 |
| followup/通知形状随 dsh 升级漂移 | 升级时重读注入 API；J11 方法名断言 + 真机② |
| 超时与齐答双结 | settle 幂等护栏 + J10 假 timer 断言 |
| 宿主行卸载瞬间的在途批次 | dispose 交还原生链（J17）；最坏窗口 = 交还前批次保持接管至进程态变化 |
| 徽标/浮框座位名漂移 | 升级时重读座位契约；真机④截图把关 |
| 轮询给宿主的常驻小负载 | 1000 ms × 本地 JSON RPC，仅开关开时；可接受（§5 登记理由） |

## 33. R32/R33：`async_run` 执行即注册与可打断的首次等待（0.1.7 线，用户裁定）

> 需求权威：R32-a…f、R33-a…c（`docs/requirements.md`）。事实依据（均已亲读/实测钉锚）：
> 准入在 run 之前、触顶文案；label=命令原文先例、progress 结算清除、starter 内
> 启动；abort 后宿主整体改写；wait 只中断等待不取消作业；
> awaited 结算不补发通知；wait 超时是 resolve 回 view；
> caller = SessionId；已中止信号挂监听不触发；killed 的 done 照常
> resolve。本节只写 0.1.7 线；0.2.0 适配线归 R31 文档，两线不混交。

### 33.1 执行形态（R32-a 的落点）

顺序固定，每步只在前步成功后发生：

1. **入口中止**：`exec.signal?.aborted` → 直接抛错收场（宿主把结果整体改写为
   `Error: tool call aborted`）。此刻作业未注册、进程未启动——什么都没发生，
   抛错即诚实。（不短路会以 running 口径空跑一次等待——已中止信号再挂监听不触发。）
2. **提权审批**（R11，现行代码不动，仍在最前）。
3. **沙箱策略与 spec 解析**（现行代码不动；`ctx.shell.resolve` 同步）。
4. **注册准入（执行即注册）**：`ctx.jobs.start`，进程**不在这里启动**——
   `run(job)` 由注册表在准入通过后同步回调（`[@deepseek-ai/dsh-jobs-local] lib/index.js:419`
   触顶 throw 在 `:437` `spec.run(handle)` 之前），我们在 `run` 内才发起
   `ctx.shell.execute(spec)`（内置 pwsh 先例：进程在 starter 内、准入之后启动）。注册字段（与现行逐一对应）：
   - `kind`：现行值随迁（config.jobKind）；
   - `label: args.command` **原文不截断**（R33-a，先例同款）；
   - `owner: exec.agent.id`——必有（33.2-1），宿主还会核 live agent
     （`dsh-jobs-local` 的 `resolveOwner`，`:527-533`）；
   - `outputLimitBytes`：现行换算（`maxResultChars` × 最坏字符字节数）随迁——
     它决定完成通知的截断口径（R32-f 通知半边）；
   - `output`：拉式源闭包惰性取 `proc`——`proc` 未到位时读返回
     `{ text: '', nextOffset: from, lossy: false }`（注册表按自身节拍再泵，
     空读不推进游标），到位后与现行同款直读 `proc.observed`；
   - `run(job)`：先 `job.updateProgress(args.description)`（R33-b，活动期
     进度行，结算由宿主清除），再发起 execute，同步返回 hooks：
     `{ cancel, done }`（done 的 rejection 由注册表转 `failed`，与现行 done
     钩子同款）。
   **作业私有的 prep 窗口 cancel**：`{...spec, signal:
   controller.signal}`（作业私有 AbortController，**不是** `exec.signal`——
   工具 abort 不得终止命令，R32-c）；`cancel: (reason) => {
   controller.abort(reason); proc?.kill?.(); }`——execute 未 resolve 时
   abort 让 spawn 前中止（pwsh `processJob` 先例，`dsh-tool-pwsh:100-126`），
   已 resolve 则杀进程；done 链 catch 按「aborted 且 `proc` 未到位 → killed」
   分类（同先例 `:118-122`）。job_kill / owner teardown 在 prep 窗口由此
   生效，不再丢请求。
5. **首次等待（让出窗口，R32-b）**：`ctx.jobs.wait(jobId, yieldMs, owner,
   AbortSignal.any([exec.signal, raceAbort.signal]))`——**两个控制器合并作
   第四参**：`exec.signal` 并入才收得了 abort 场；`raceAbort`
   在竞速定局后撤销（33.4），插话/迟到胜出时才摘得掉 waiter。一个 wait 调用
   承载三个成员——结算（终态 view resolve）、预算到期（running view
   resolve）、abort（reject `"wait aborted"`）；插话
   （`watchUserInterrupt`）与迟到作答（`watchLateAnswer`，含起始检查）作为
   竞速成员并入（与 `async_wait_job` 同款组合，§22.3）。接线段整体
   try/finally（R29-a 防御性同款）。
6. **撤销在先、复查在后（R32-d）**：竞速定局后的**第一个动作**
   是 `raceAbort.abort()`，然后才做完成优先复查（`jobs.list` 三分读快照）。
   次序即正确性：撤销前 settle → 复查见终态走 33.3-a（awaited=true 与模型
   实收结算一致）；撤销后 settle → waiter 已摘 → awaited=false → 通知照发
   （与句柄路径一致）。两向均无「awaited 旗标与返回形状错位」的窗口。

### 33.2 设计裁定的两个问题

1. **无 agent 语境的处置：拒绝（不降级注册）。**
   理由：本工具相对内置 `pwsh` 的增量价值就是「abort/插话后的恢复通道」，
   而恢复通道 = 带结算通知的有主作业（无主作业不发完成通知——补发只发给 owner）；
   降级成无主注册等于广告一个恰在 R32 新增场景（abort）下断裂的能力，且
   无主作业对任意 caller 可见。诚实拒绝 + 指明内置 `pwsh` 可用。
   落点：`error.noAgentRun`（zh/en，`lib/text.js`）；判据：可读错误 +
   `ctx.jobs.start` 零调用 + `ctx.shell.execute` 零调用（单元钉死）。
2. **即时性判据的窗口数值：5 秒（e2e）+ 微任务级联（单元）。**
   e2e 断言「信号可观测时点 → 转录出现 tool/result」≤ 5000 ms，且当次预算
   ≥ 60 000 ms——预算路径被排除，≤5 s 只能来自打断（事件投递与竞速收敛都在
   进程内，正常时延在百毫秒级，5 s 是留给 CDP 点击与转录轮询的宽界）。
   单元断言：信号 promise resolve 后竞速在同一微任务级联收敛（假定时器
   零推进）。本条回填 `docs/requirements.md` §6 即时性行。

### 33.3 返回形状（R32-c 逐条映射；output schema 不新增分支）

- **a 预算内结算**（wait 终态 resolve / 复查终态）：与现行 done 分支**同码**——
  killed 分流照旧（R29-e——killed 的 done 照常 resolve），`completedResult`/`jobOutcome` + collector
  终 drain；`proc` 未到位的 `failed`（execute 预备失败）→ 原样重抛闭包里存的
  原始错误（与现行「准备失败直接抛」等价）。此时等待是 awaited → 宿主不补发
  完成通知（awaited 语义）。
- **b 插话**：句柄 + `yieldNote(mode:'user')` + 新键 `note.yield.earlyByUser`
  （一行注明因用户到达提前让出；`note` 是字符串，schema 不动）。
- **c abort**：按 b 口径返回句柄形状——宿主把结果整体改写为
  `Error: tool call aborted`，模型看不到句柄；**作业必须存活**（不 kill、
  不 remove——pwsh 的 `stop()` 先例是前台模型没见过 id 才停掉，我们是后台
  契约）；waiter 已 uncount → 结算时补发完成通知 = 恢复通道。
- **d 迟到作答**：句柄 + `wait.lateArrived` note（与 wait 工具同键同口径，
  R30-d 第四类信号；summary 进 note 指明哪题）。
- **e 预算到期**：句柄 + 既有 `yieldNote`（零变化）。**t0 取工具入口不动**
  （口径见 `lib/jobs.js:683-685` 注释——用注册/等待时刻计时会让
  elapsed_ms 恒近 0）；`yield_ms` 夹紧区间与配置默认值不动
  （R32-f）。

### 33.4 通知计数（R32-e 的两半）

- settle 胜出：waiter 是 awaited（`dsh-jobs` types `:196-202`）→ 不补发。
  单元断言：fake 注册表记录的 awaited 旗标为真。
- b/c/d/e 胜出：**竞速定局后第一个动作** `raceAbort.abort()` → uncount
  （`dsh-jobs-local:632/643` 保留该语义）→ 结算通知照发（模型的恢复通道）。
  单元断言：fake 注册表的 uncount 调用发生，且**先于**完成优先复查。
- e2e（§33.6）：预算内完成路径转录零完成通知；插话路径结算后恰 1 条
  （事件流 `settled/awaited` 可复核）。

### 33.5 呈现（R33）

- `label` = 命令原文（含空格、不截断；界面自行视觉截断）——完成通知与
  `async_wait_job` 的作业清单行随之显示命令文本（R33-a）。
- `progress` 行 = `args.description`（注册时一次写入，结算由宿主清除）。
- 转录工具卡不变（`presentCall` 现行 title=command、description=description）。
- 执行期可见（R33-c）：注册时点即入任务面板——命令、running 状态、已运行
  时长、实时输出（拉式源进输出环——作业注册表自带输出环）。

### 33.6 测试与真机判据

单元/接线（`test/jobs.test.mjs` 让出段重写 + 只增；基线 296 只增不减，
重写用例必须保住原判据面——结算/killed/R8 触顶文案/渲染标记）：

| 组 | 判据（都能红） |
| --- | --- |
| 形态 | 注册先于进程：fake 注册表同步回调 `run` → `execute` 只在其后发生；触顶（start throw）→ `error.startRefused` 文案（limit 行 + 存活清单）且 `execute` 零调用；无 agent → 拒绝 + 双零调用 |
| 五信号 | 结算（completed/killed 两支，killed 走 killed 分流）；插话（句柄 + note 含提前让出行）；迟到（`lateArrived` 锚）；abort（wait reject → 句柄返回 + `cancel` 零调用 + 作业记录仍在）；预算（`yieldNote` 零变化）。每路 `elapsed_ms` 假时钟断言（t0=工具入口） |
| prep 窗口 | execute 未 resolve 时 job_kill → 作业私有 controller.abort 生效（spawn 前中止，归 killed），kill 请求不丢；拉式源在 proc 到位前被泵 → 空增量、游标不动、guard 不误判 |
| R32-d | 插话胜出但复查快照已终态 → 结算结果而非句柄 |
| R32-e | fake 注册表 awaited 旗标（settle 路径为真）；uncount 调用（其余四路） |
| R33 | `spec.label === args.command` 逐字（长命令不截断）；`handle.updateProgress` 收到 `args.description` |
| 复用 | R8 既有文案用例随 `error.startRefused` 平移（进程未启动措辞）；J-render 截断与丢失标记不动 |

真机（验证实例，**升级 0.2.0 之前**完成取证——风险表 R31 行排序约束；新探针
`verify/probe-r32-run-interruptible.mjs`）：

- (a) 即时性·插话：长跑命令（60 s）+ `yield_ms=60000`，约 10 s 后经 CDP 提交
  用户消息 → 转录 tool/result ≤ 5000 ms 出现（33.2-2）+ running 句柄 + note
  含提前让出锚；作业在 `session/list` 仍 running。
- (b) 即时性·abort：同景按 GUI 停止 → tool call aborted 改写（活体）+
  ≤5000 ms 收场 + 作业存活 + 结算后完成通知恰 1 条（33.4）。
- (c) 呈现：任务卡 label=命令原文 + running + progress=description（CDP 读
  面板文本）；结算后 progress 行消失。
- (d) 触顶：占满 owner 名额（10）→ 第 11 条调用返回 `error.startRefused`
  文案（含 limit 与存活清单）。
- (e) 短命令：预算内 completed 形状与现行一致；终态卡在场（裁定
  接受，风险表）。
- (f) 通知计数：预算内 0 条、插话路径 1 条（转录事件流复核）。

### 33.7 交付与回滚

- 改动面：`lib/jobs.js`（execute 让出段重写；`registerLateJob` 改形为
  准入先行的注册函数）、`lib/text.js`（新键 `error.startRefused` /
  `error.noAgentRun` / `note.yield.earlyByUser`，zh/en；abort 行为与「停止只
  结束等待、结算通知恢复」写进 `tool.run.p2` 键——风险表对 abort 恢复通道
  一行的要求；descriptions.js 是无分支组装器，文案落点在 text.js）、
  `README.md` 机制段、测试与探针如 §33.6。
- 无设置面变化、无预设变化；回滚 = 还原包代码（junction 直读工作树，
  重启验证实例生效），无残留（作业记录随宿主注册表自身生命周期）。

### 33.8 风险

| 风险 | 处置 |
| --- | --- |
| 拉式源在 proc 未到位时被泵（注册表节拍先于 execute resolve） | 惰性闭包返回空增量（`nextOffset=from`），注册表下轮再泵；单元用「先泵后 resolve」用例钉死 |
| prep 悬置：预算到期时 execute 尚未 resolve | 仍返回句柄（作业在跑预备）；后续 execute 拒绝 → 作业 failed → 完成通知（恢复通道闭环）；不仿 pwsh 停 prep（我们已把 id 交给模型） |
| `run()` 同步抛（execute 参数级错误） | start 前置校验后仍可能：抛错离开注册表（`dsh-jobs` `types.d.ts:142-148` JobSpec.run 文档串「a throw leaves nothing registered」）→ 我们同步收拢为可读错误；execute 的异步拒绝走 done → failed → 结算路径 |
| wait 四参形状随 0.1.7 → 0.2.0 漂移 | 本节锚 0.1.7 源码行号；0.2.0 线归 R31 文档，不混交 |
| 中止改写后的恢复依赖 tool-jobs 完成通知 | awaited/补发语义既有档案 + (b) 真机复核；README 与工具描述写明（风险表 abort 行） |

## 34. R34：`async_workflow`——包装 workflowEngine 的作业化编排（0.1.7 线，用户裁定）

> 需求权威：R34-a…h（`docs/requirements.md`）。事实依据（均已亲读/实测钉锚）：
> 宿主双形态与后台注册字段、取消/结算映射的逐字段先例；引擎子代理 one-shot 无作业；
> 准入在 run 之前；label/progress 词汇、run 抛错"不留注册"；
> abort 改写；awaited 结算不补发通知；wait 只中断等待；
> wait 超时 resolve 回 view；已中止信号挂监听不触发。本节只写
> 0.1.7 线；与 R31 适配线不混交。

### 34.1 设计裁定的四个问题与裁决

1. **GUI 运行记录面（宿主 recorder / mirror 能否复用）——裁决：机制级复用，
   实例级不可。**两个工厂（`createWorkflowRecorder` /
   `createWorkflowRecordMirror`）是 `apply()` 闭包私有、未导出
   （`dsh-tool-workflow/lib/index.js:19/:83`；export 仅 `Config/apply/inject/name`
   `:444`），拿不到实例；但两者的**输入面是共享的**，可以自己挂同款：
   - 引擎生命周期事件：`WorkflowEngine.emitWorkflowEvent` 走
     `this.ctx.events.dispatch("emit", [name, ...args])`
     （`dsh-workflow/lib/index.js:68-77`）——cordis 事件注册表随 app 共享；
     tool-workflow 自己就是用**它自己的 ctx** `on("workflow/*")` 收到**另一个
     包**（workflow-ptc）发的事件（`:21-35` mirror、`:95-113` recorder），我方
     ctx.on 同一条总线同款可达。判据：单元替身事件 + 真机 (g)。
   - 会话档案：recorder 只做 `session.append("tool-workflow/run-start" |
     "agent-start" | "agent-end" | "run-end", …)`（`:98/:109/:117/:124`，载荷
     字段：run-start `{runId, name}`、agent-start `{runId, seq, label, phase?,
     childId}`、agent-end `{runId, seq, outcome}`、run-end `{runId,
     stopReason}`）；GUI 运行视图（dsh-client-ui-workflow-run）是**持久会话
     事件的确定性回放**（其 README:46），消费的正是这四种记录类型
     （`dsh-client-ui-workflow-run/lib/client.js:582-600`），且 README:88 明说记录只由 dsh-tool-workflow
     的顶层调用产生——它是**按记录类型驱动**的，不区分写入者插件；我们从
     自己的插件 append 同类型同形状记录，GUI 运行节点照样回放。
   - 残余风险（落 §34.7）：宿主改记录类型/载荷形状时我们漂移；真机不可达时按
     降级路径按原任务约定处理（不 append 这四种记录，作业卡与输出环仍在）。
2. **输出环内容最小面——裁决：镜像宿主 mirror 的全部四类。**`workflow/phase` →
   `job.updateProgress(title)` + `job.append('▸ title\n', {channel:'log'})`；
   `workflow/log` / `agent-start` / `agent-end` → `job.append(channel:'log')`
   （宿主 record.js 逐条同款）。`channel:'log'` 是**观察者叙述**——模型的
   `job_output` 不渲染（宿主注释明言），所以模型可见面只有最终返回值（骑
   结算通知与首次读取）；GUI 面经 log 通道拿全过程。这是宿主已选定的最小
   面，不发明第三种。
3. **无 agent 语境——裁决：拒绝（照 R32-a / §33.2-1 口径）。**理由同源：本工具
   的增量价值是 abort/插话后的恢复通道 = 有主作业的结算通知（无主作业不发完成通知）；
   降级无主注册等于广告一个恰在 R34-e（abort）场景断裂的能力。落点：
   `error.noAgentWorkflow`（zh/en，`lib/text.js`）；判据：可读错误 +
   `ctx.jobs.start` 零调用 + 引擎 `start` 零调用（单元钉死）。
4. **宿主伴生引导的承接改写——裁决：描述自带门槛句，指向 `async_agent`。**
   宿主的"For one or two delegations, prefer plain subagent calls"（prompt
   section，`:270-274`）随 R35-b 禁用 `tool-workflow` 消失；本工具描述的门槛
   锚句改写为"一两个委托用 `async_agent`"（两份预设内 subagent/subagent_fork
   均禁用——dsh-async 由 R35-c 新禁、create 由 §28.1 裁决 A 既有禁用——字面
   照搬宿主句会指向不可用入口）。**不注册系统提示 section**（宿主那句挂在
   tool-workflow 的 apply 里；我们描述自带，避免双份门槛文案）。

### 34.2 执行形态（R34-b/-c/-e 的落点）

顺序固定，每步只在前步成功后发生（实现与 async_run §33.2-1 同序：先无 agent、
后入口中止——两条件同真时文案取无 agent 拒绝；实现审查 I-9 裁定对齐实现）：

1. **无 agent 拒绝**（34.1-3）：`error.noAgentWorkflow`。
2. **入口中止**：`exec.signal?.aborted` → 抛错收场（结果被整体改写；不空跑一次等待）。
3. **服务在位**：`ctx.get('workflowEngine')` 现读——缺席时抛可读错误
   （文风对齐 `error.providerNotRegistered` 既有键，点名 workflowEngine）。
   **不加 `inject`**：R34-a 要求服务缺席时工具仍注册——硬 inject 会让整行进入
   等待（§0 装载注意事项）。工具注册面（`lib/index.js` 的 factory 表）只加一行
   `async_workflow: createWorkflowTool`，`inject` 数组不动。
   **isolate 墙**：`workflowEngine` 按宿主设计是 **delegation
   组内隔离服务**——两份补丁的 delegation 组 `isolate: {workflowEngine: true}`
   （dsh-async `:137-141`、create `:129-133`；宿主基线 standard 同构），引擎
   提供方 `workflow-ptc` 只在组内；宿主平面的 workflow-ptc 行自身
   `disabled: true`（dsh-web-app/cordis.patch.yml:516-517），无旁路。cordis
   机制：provide 按提供方 isolate 键写 store（cordis/lib/index.js:800-815），
   `ctx.get` 按调用方 isolate 键查（`:763-771`），组外行解析到根级默认符号 →
   恒 miss → undefined。**所以消费行必须落进 delegation 组内**（组内注册工具
   成例 = tool-workflow 行本身）——行位定向修改是 R35 的一部分（§35.1-1）。真机
   (a) 是这堵墙的兜底判据：单测的 fake ctx.get 可控、仿真不了 isolate 语义
   （单测替身盲区同款）。
4. **注册准入（执行即注册）**：`ctx.jobs.start`，引擎 run **不在这里启动**——
   `run(job)` 由注册表在准入通过后同步回调（§33 同款先例）。注册字段
   **逐字段对齐宿主 `startBackgroundRun`**（宿主双形态先例），仅 kind 与调用方不同：
   - `kind`：模块常量 `'async-workflow'`（宿主用 `'workflow'`；不用宿主值——
     完成通知前缀 `(kind: label)` 与 `async-command` 区分得开，且不冒充宿主
     作业；`async_wait_job` 清单查找不筛 kind）；
   - `label: args.meta.name`（R34-g；宿主后台既有取值）；
   - `owner: exec.agent.id`（必有，34.1-3）；
   - **不传 `output` 拉式源、不传 `outputLimitBytes`**（宿主后台同形：输出环
     由 mirror 的 `job.append` 写，结算 result 走通知截断——宿主未传即既有
     截断口径）；
   - `run(job)`：先 `job.updateProgress(args.meta.description)`（R34-g；
     结算由宿主清除），然后 `run = ctx.workflowEngine.start({ script,
     meta, args?, parent: exec.agent })`——**不传 `signal`**（R34-e：abort 不
     接 `run.cancel`）；`mirror.start(run.id, job)`；`recorder.start(session,
     run)`（34.1-1 复用裁决；`session` 取 `exec.agent.session`；
     append 失败按宿主同款处置：`logger.warn` + 该 run 永久停录（`active.delete`，dsh-tool-workflow `:87-94/:104/:113`）——不是静默）；返回 hooks：
     - `cancel: (reason) => run.cancel(reason ?? 'async workflow job killed')`
       ——真取消走 `job_kill`（R34-e；与宿主后台同款）；
     - `done: run.result → (try await run.dispose(), warn) → mirror.stop →
       recorder.finish + abandon → stopReason 映射`：`completed` →
       `{status:'completed', detail:'N agents', result: renderResult 文本}`；
       `cancelled` → `{status:'killed'}`；`error` → `{status:'failed',
       detail}`（宿主 `jobOutcomeOf` 同款）。**结算文本同时闭包暂存**（`state()` 先例）：`jobs.read` 的取文会消费一次性 `resultDelivered`（dsh-jobs-local `:601-602`）并混入 log 通道 chunks，settleNow 一律读闭包暂存、不经 `jobs.read`。
5. **引擎同步抛的区分（宿主 `start` 对不能开始的请求同步抛 `WorkflowError`：
   `META_INVALID` / `SCRIPT_PARSE`，workflow-ptc `:600-603` 文档）**：这类抛错
   发生在 `run(job)` 内——JobSpec.run 的契约是"a throw leaves nothing
   registered"（JobSpec.run 文档语义），异常会穿出 `ctx.jobs.start`。处置：`run` 内
   try/catch 存引用再原样重抛；外层 start 的 catch **命中原引用 → 原样抛**
   （诚实工具错误：什么都没跑、无作业），否则按 `admissionRefusalError`
   包装（触顶文案 R8）。防的是把脚本解析错误冒充"启动前被拒"。
6. **首次等待（五信号竞速，R34-c）**：与 §33.1-5 **同一份组合**——把
   `createRunTool` 的竞速段抽成共用辅助（`raceFirstWait(ctx, exec, jobId,
   yieldMs, owner)`，落 `lib/jobs.js` 导出或独立小模块，D17 实现时定），
   `async_run` 与 `async_workflow` 都调它：waitMember（结算/预算/abort 三
   成员）+ 插话（`watchUserInterrupt`）+ 迟到作答（`watchLateAnswer` 含起始
   检查）；竞速定局后**撤销在先、复查在后**（§33.1-6 逐字同款）。任何信号
   只结束等待、不终止 run（wait 语义只断等待；abort 不接 signal 是构造保证）。
7. **settleNow（R34-d 预算内结算）**：终态 view → `completed` 支返回
   `{status:'completed', result: 渲染文本}`——渲染文本逐字对齐宿主
   `renderResult`（`workflow "<name>" completed (<N> agents).\nReturn
   value:\n<JSON 按 maxResultChars 截断>`（宿主同款锚 `:204-209`）；截断标记
   `… [truncated: N more characters]` 同款）；`killed` 支 `{status:'killed',
   detail?}`；`failed` 支 **抛错**（`Error(detail)`，isError——与宿主前台
   `stopReasonError` 同向；此时作业已 failed、通知照发（等待若已撤销则补发），
   恢复通道一致）。等待是活 waiter → 不补发通知（R34-f）。
8. **句柄路径（插话/迟到/abort/预算）**：`{status:'running', job_id,
   elapsed_ms, note}`——note 复用 `yieldNote`（mode user/late/budget）与
   `note.yield.earlyByUser`（插话提前让出行）；t0 取工具入口（同前口径；
   本工具无审批环节，入口即注册，elapsed 与作业实跑天然一致）。abort 路径
   返回句柄形状、作业必须存活（R34-d/-e；改写后通知=恢复通道）。

### 34.3 output schema 与呈现

- schema 三支：`completed`（status/result）、`killed`（status/detail?）、
  `running`（status/job_id/elapsed_ms/note）——`render` 只显 `result` 或
  `note`（模型只见渲染文本，与 async_run 同口径）。
- `presentCall`：generic 卡 `workflow: ${meta.name}` + rawInput=script（宿主
  同款）；`presentResult`：generic（宿主同款）。
- 参数面：`script` / `meta` / `args` 三键与宿主同形（R34-a：schema 子集、
  描述文字同源——见 34.4）；**无 `run_in_background`**（R34-d：构造保证永远
  后台）。

### 34.4 描述（R34-h + 必答④）

- 文案键 `tool.workflow.p1/p2`（`lib/text.js` zh/en 双档）：
  - p1 = 脚本契约（meta 块三键两可选、`agent`/`pipeline`/`parallel`/`phase`/
    `log`/`args` 钩子语义、误用即整脚本抛错、并发与总量 cap、无 fs/网络/
    定时器约束）——en 档与宿主 `DESCRIPTION` 同源措辞（它是模型面规格，
    逐段对齐避免两套规格漂移），zh 档受控中文；
  - p2 = 门槛锚句（「仅在用户明确要求 workflow 或大规模多代理编排时使用；
    一两个委托用 `async_agent`」）+ 永远后台说明（无前台参数、五信号让出、
    `job_output`/`job_kill` 复原通道——对齐 async_run p2 的风格与 R5 措辞
    约束）。
- 判据（R35-g 并入）：两档描述门槛锚句在场（validator 查 text.js）；删句必红
  （preset.test 变异）。

### 34.5 测试与真机判据

单元/接线（`test/workflow.test.mjs` 新文件；fake 引擎（事件钩可手动触发）+
既有 fake 注册表替身）：

| 组 | 判据（都能红） |
| --- | --- |
| 形态 | 注册先于引擎启动（fake 记录调用序：`jobs.start` 的 run 回调先于 engine.start 调用点完成发起）；`run` 内引擎同步抛（替身抛 SCRIPT_PARSE 形）→ 工具结果原样抛（非 startRefused 文案）+ 引擎只被调一次；触顶 → `error.startRefused` 文案 + 引擎零调用；无 agent → `error.noAgentWorkflow` + 双零调用；服务缺席（ctx.get 回 undefined）→ providerNotRegistered 文风 + 引擎零调用 |
| 五信号 | 结算 completed（渲染文本锚 `workflow "name" completed` + Return value JSON）；结算 killed（`cancel` 恰一次——job_kill 面）；插话（句柄 + note 含提前让出行）；迟到（`lateArrived` 锚）；abort（句柄返回 + **`run.cancel` 零调用**（R34-e 判据：接了 signal 必红）+ 作业记录仍在）；预算（`yieldNote` 同款）。每路假时钟断言 elapsed |
| mirror/recorder | 四类事件各触发一次：phase → `updateProgress`+`append(channel log)`；log/agent-start/agent-end → `append`；`session.append` 四记录类型与载荷字段（runId/seq/label/childId/outcome/stopReason）；结算链上 `mirror.stop`、`recorder.finish`+`abandon` 各恰一次 |
| 通知计数 | settle 路径 fake 注册表 awaited 为真；句柄四路 uncount 调用先于复查（§33.4 同款断言搬运） |
| 呈现 | `spec.label === meta.name`；`updateProgress` 收到 `meta.description` |
| 复用抽取 | `raceFirstWait` 抽出后 async_run 既有五信号用例全数保绿（只增不减基线） |

真机（验证实例，**升级 0.2.0 之前**完成取证——风险表 R31 行排序约束；新探针
`verify/probe-r34-async-workflow.mjs`）：

- (a) 即时性·插话：编排脚本（3 个 agent 各长跑）+ 大 `yield_ms`，**同步点 =
  转录出现 async_workflow 的 `tool/call` 后**（本工具无审批环节，不存在
  `approval/decided`——同类陷阱规避）再
  steer → 转录 tool/result ≤ 5000 ms + 句柄 + 提前让出锚；run 在 `session/list`
  仍 running；结算后完成通知恰 1 条（通知前缀 `(async-workflow: <name>)`）。
- (b) 即时性·abort：同景 GUI「停止生成」→ 中止改写 + run 存活 + 通知恰 1 条。
- (c) 呈现：任务卡 label=`meta.name`、progress=`meta.description`、结算后
  progress 清除（卡内断言——注意：正文断言会被提示词回显污染）。
- (d) 触顶：与 `async_run` 同池占满（每 owner 10）——混编 11 连发（命令
  与编排混合）第 11 条 startRefused。
- (e) 预算内结算：短编排（1 agent 即回）→ 渲染文本形态（`workflow "x"
  completed (1 agent)` + Return value JSON）+ 零完成通知（活 waiter）。
- (f) 描述门槛：dsh-async 新会话 `request/header` 里 `async_workflow` 描述含
  门槛锚句；`workflow` 工具缺席（R35 面一并取证）。
- (g) GUI 运行节点：会话转录出现 `tool-workflow/run-start`…`run-end` 四类型
  （recorder 复用面活体）；GUI 运行视图显示该 run（CDP 读）；若真机此面不可
  达，按 34.1-1 降级路径如实登记。

### 34.6 交付与回滚

- 改动面：`lib/workflow.js`（新：createWorkflowTool + mirror/recorder 订阅 +
  renderResult 同形渲染）、`lib/jobs.js`（竞速段抽共用辅助，async_run 改调，
  行为零变化）、`lib/text.js`（新键 `error.noAgentWorkflow` /
  `error.workflowEngineMissing` / `tool.workflow.p1/p2`，zh/en）、
  `lib/index.js`（factory 表加一行；inject 不动）、`presets/`（R35）、
  `tools/validate-preset.mjs`、测试与探针如 §34.5、`README.md` 工具清单。
- 无设置面变化（无新配置键；kind 常量写死模块顶部，宿主同款做法）；回滚 =
  还原包代码（junction 直读工作树），无残留（作业记录随宿主注册表自身生命
  周期）。

### 34.7 风险

| 风险 | 处置 |
| --- | --- |
| cordis 事件跨插件可达性（emitWorkflowEvent → `ctx.events.dispatch`）我方 ctx 收不到 | 单元替身事件钉行为 + 真机 (g) 活体；不可达时 mirror/recorder 静默无事件——作业卡/结算/恢复通道不受影响（降级不致命），按 34.1-1 降级路径登记 |
| 宿主改记录类型/载荷（0.2.0） | 记录形状单元锁死；R31 适配线 diff 清单补入该面（风险表既有行） |
| renderResult 文本形态是宿主实现细节 | 宿主同款锚 `:204-209`；真机 (e) 复核；宿主升级时重读该面触发重锚 |
| 引擎同步抛与准入拒绝混淆 | 原引用区分（34.2-5）+ 单元两用例（SCRIPT_PARSE 原样抛 / 触顶包装） |
| 无 signal 的 run 取消面只剩 job_kill | 描述 p2 写明；真机 (b) 证实存活；与宿主后台形态一致 |
| `async_wait_job` 复合行为未活体实测 | 真机 (a) 的句柄复原经 `async_wait_job` 走通即顺带核销 |
| 行位/组 isolate 变更 → 引擎不可达，症状与服务缺席同形（行位 isolate 风险） | 消费行钉在 delegation 组内（§35.1-1）+ validator 行位判据；实现轮最小实证（组外跑一次必现 missing、移入组内即通）；真机 (a) 兜底 |

## 35. R35：两份异步预设的定向修改（创建与等待只走异步工具）

> 需求权威：R35-a…g。事实依据：toolName 分派成例、standard
> 基线、创造基线（换预设开新会话）、owner 名额共享、
> §20/§28 既有定向修改注释。定向修改只落在本插件自己的两份补丁（R4 不变量）。

### 35.1 定向修改清单（逐行）

两份补丁（`presets/dsh-async.patch.yml`、`presets/dsh-async-create.patch.yml`）：

1. **第五行工具**（R35-a）：`async_workflow` 行**插进 delegation 组内
   `tool-workflow` 行之后**（`name: dsh-async-tools`、`config.toolName:
   async_workflow`；形态同四行，toolName 分派成例）。**不落组外顶层**——
   `workflowEngine` 是组内隔离服务（isolate 墙见 §34.2-3）：组外行
   `ctx.get('workflowEngine')` 恒 miss，引擎在场也报缺席；组内注册工具的成例
   即 `tool-workflow` 行本身（同组同 inject 语义）。
2. **禁 `tool-workflow`**（R35-b）：两份补丁的 `tool-workflow` 行置
   `disabled: true`——该行现无 config，定向修改即加一行禁用键（成例：tool-ralph
   行，dsh-async `:182-184`）。

`dsh-async.patch.yml` 独有：

3. **禁 `tool-subagent`**（R35-c）：行置 `disabled: true`、config 逐字保留
   （`provider: spawn` / `toolName: subagent` / `modelSelectionSettings: true` /
   `backgroundMode: continuable`）。
4. **禁 `tool-subagent-fork`**（R35-c）：同上（`provider: fork` / `toolName:
   subagent_fork` / `backgroundMode: continuable`）。
   （`dsh-async-create.patch.yml` 已是此形态——§28.1 裁决 A 的既有形态即
   成例，本条对它零改动。）

**保留行**（R35-d）：`workflow-ptc`（R34 的引擎服务行；在场且启用、
`provider: spawn`）、`tool-subagent-control` / `tool-subagent-list-agents`
（检查/管理面：`list_agents` / `interrupt_agent` / `send_message` 均非阻塞，
返回即确认）。两份补丁头部定向修改注释同步增记（含 R35-e 功能损失一句）。

### 35.2 文档同步（R35-f）

- `docs/requirements.md` §1/§2/§6 现行表述里的「R35 起另有 `async_workflow`」
  前瞻括注 → 交付时改写为现值（五工具），不留前瞻语气（受控中文：文档承载
  现在）；§6 面貌行按判据更新。
- `docs/design.md` §28（创造预设定向修改清单）与 §20（standard 定向修改清单）正文
  按现行形态改写（历史在 git）；dsh-async 预设保留宿主单发入口的旧记录（§20
  定向修改未禁 `tool-subagent` 系）随 R35-c 一并改写为现行形态；
- 交付报告的面貌行随实现同步。

### 35.3 可失败判据（R35-g）

`tools/validate-preset.mjs` 增查（两份补丁都查，除注明外）：

| 查 | 红 conditions |
| --- | --- |
| `async_workflow` 行在场、`toolName: async_workflow`、且**位于 delegation 组内 `tool-workflow` 行之后**（行位判据） | 删行/改名/移出组（含挪回组外顶层）必红 |
| `tool-workflow` 行 `disabled: true` | 翻活（删 disabled 或置 false）必红 |
| dsh-async 的 `tool-subagent` / `tool-subagent-fork` `disabled: true` 且 config 四键逐字 | 翻活/删 config 键必红 |
| `workflow-ptc` 在场、启用、`provider: spawn` | 删行/翻活/改 provider 必红 |
| `tool-subagent-control` / `-list-agents` 在场且启用 | 删行/禁用必红 |
| `lib/text.js` 两档 `tool.workflow.p2` 含门槛锚句 | 删句必红 |

`test/preset.test.mjs` 补变异（在既有变异框架上）：翻活任一被禁行必红、删
`async_workflow` 行必红、删 `workflow-ptc` 行必红、validator 未变异基线绿自证。
隔离对照：standard/创造等其他预设文件零变化（git diff 面）+ validator 对
未定向修改面的既有判据不动；真机隔离（验证实例）：standard 会话对照 `workflow` /
`subagent` 照常在场。

真机（验证实例，随 §34.5 探针一并）：dsh-async 与 dsh-async-create 各开新会话，
`request/header`：五个 async 工具在场（含 `async_workflow` 且描述含门槛锚句）、
`workflow` / `subagent` / `subagent_fork` 缺席；standard 会话对照：三者在场。

### 35.4 风险

| 风险 | 处置 |
| --- | --- |
| dsh-async 失去宿主单发入口（前台模式与 `reasoning_effort`/`persona`/`toolFilter`/`maxDepth`） | R35-e 显式登记功能损失；出路 = `async_agent`（唯一入口）或换预设开新会话；README 写明 |
| 禁行的 config 被误删或漂移 | validator 逐字判据 + 删键必红变异 |
| R26 旧判据面漂移（可验证④触发条件不再成立） | R35-f 同步清单逐项落实；复审对照交付面貌行与 design §28 |

## 36. R36：提问接管的暂停计时（作用面与寿命 R49 修订为批级）

> 需求权威：R36-a…e（作用面与寿命经 R49 修订：暂停以批为独立单位、会话间严格
> 隔离）。事实依据：超时合成形状、state 通道、expiresAt + timer.timeout 机械、
> async-tools-ask 远端面。R30 的判定/通道/迟到作答语义零改动（R36-e）。

### 36.1 机械（R36-b，R49 批级口径）

暂停状态是**批级布尔**（`batch.paused` + 首记剩余 `batch.remainingMs`，内存态，
R36-d）——注册表**无会话级暂停集**（R49 修订：R36 原会话级集废止——暂停不跨批
存续、会话不保留任何暂停残留）。

- **pause(sessionId)**：组开关一次作用于该组**当下在窗**（`phase === 'open'`）的
  全部批次——`batch.cancelTimer()` 撤定时器（`#teardown` 不用：不摘 signal
  监听）、`batch.remainingMs = max(0, expiresAt - now())` 首记剩余（`cancelTimer`
  已撤的批不重记——二次 pause 幂等，同批剩余保持首记值）、`cancelTimer` 置
  undefined、`batch.paused = true`。组内无在窗批时无任何落点（幂等返回
  'paused'，不报错）。
- **resume(sessionId)**：作用于该组全部暂停批——`remainingMs > 0` → 重挂
  `timer.timeout(() => expire(batch), remainingMs)` 且
  `expiresAt = now() + remainingMs`（平移，同款 timer 机械）、`paused = false`；
  `remainingMs <= 0` → 立即 `expire(batch)`（防御闭合：恢复时刻已越界按 0
  到期——诚实，不静默吞）。顺带登记 forgetSession 后的极罕见衍生：批已被
  forget 清标记（`paused=false`、`remainingMs` 仍存首记值）后再 pause→resume，
  会按陈旧剩余重挂（「尽力清理」面的已知边界，不改判据语义——批照常可作答）。
  另一既有口径（R36 起）：超时合成文案的秒数按**平移后** `expiresAt −
  receivedAt` 计，暂停-恢复后放行的批该秒数含累计暂停时长（如 60 s 窗 +
  300 s 暂停 → 文案说 350 s；语义无恙——窗口机械与放行时点不受影响，
  纯模型可读文案的读数口径）。
- **新批次（`take`）一律从计时开始**（R49-3）：接管即挂 timer、全额窗口、
  `paused = false`——**不因同组存在暂停批而自动暂停**（批级独立保护；改回
  「新批自动暂停」实现必须被单元判据抓红）。
- **`expire()` 入口防御**：`if (batch.paused === true) return`——**读批级暂停
  标记**（R49）：即使误挂了 timer，暂停批的到期点也不放行；放行路径本体清
  `paused`（批出窗即失效——expired 相无计时、不保留暂停残留）。
- **批级寿命（R49-1）**：批以任何路径出窗——齐答/忽略齐结清（出列删除）、中止
  （出列删除）、超时放行（`phase='expired'` 且 `paused=false`、无计时）——
  暂停状态随之消失；连续提问下每批从计时开始，不继承同会话前批的暂停态。
- **生命周期（R36-d/R49）**：`disposeAll()` 清空全部批次——暂停状态随批记录
  消失（无独立集可清）；会话收尾 `forgetSession(sessionId)` 清该会话各批的
  暂停标记（尽力清理：agent/disposed 后面板不再显已暂停；不重挂计时，批仍可
  作答/忽略结清），挂钩 `ctx.on('agent/disposed', ({agent}) => …)` 保留（事件
  存在于 dsh-agent runtime-types.d.ts:240-242，payload `{agent}`，「after
  driver quiescence … before session detachment」；本插件宿主行作用域按
  events 语义可收到）。web 会话常驻下不必然随会话结束触发——批级口径下无
  会话级残留集，标志量级＝在窗批数、随批出窗自然消失，无兜底问题（§36.6）。

### 36.2 载荷与远端面（R36-c）

- `stateItems()`：item 增 `paused: boolean`（state 通道随行；顶层不增字段）。
  `expiresAt` 暂停期冻结为暂停时刻值——客户端遇 `paused` 不做倒计时折算。
- `AskTakeoverService`：`markRemote` 增 `'pause'` / `'resume'`；两方法参数
  名 `submission`（与 answer/ignore 同形，「参数名即 wire 名」对账口径），
  载荷 `{sessionId}`（**组键**：一次作用于该组当下在窗/暂停的批次——R49 批级
  作用面，非会话级标志置位）；返回 `{outcome: 'paused' | 'resumed'}`（幂等：
  重复 pause/resume 同形回执、不报错——组内无在窗批时 pause 无落点、resume
  无对象，均为无操作）。

### 36.3 客户端（两座位）

- 每个会话组组头一个暂停/恢复开关（zh/en aria-label）；overlay 与 sidebar
  两座位复用既有组件族（`AskOverlaySeat` / `AskSidebarSeat` 注入
  `AskList`/`AskItem`，client.js:1296/:1303 与 :1194/:1119——实名锚）。
- `item.paused === true` → 该组倒计时显示冻结并示「已暂停」态
  （`serverNow` 折算跳过 paused 项）。
- **开关显示口径（R49-5 并存态，设计轮裁定）**：组级开关的暂停态取组内条目
  标记——组内**存在暂停批**（不论是否同时有计时批并存）→ 开关显示「恢复计时」，
  点击只作用于暂停批；组内全部计时批 → 「暂停计时」，点击作用于全部在窗批。
  并存态一键只做一个动作（按当前显示态先恢复），连点两下可到任一目标态——
  不设混合态第三文案。
- 开关随 R30 统一开关（`state.enabled`）：座位不在场则无开关（构造保证，
  R36-e）。

### 36.4 边界（R36-e）

只影响 `open` 未到期批：`expired` 已放行照旧迟到作答（R30-d 不动）；暂停中
作答走正常 `delivered` 路径（`submitAnswer` 不看 paused——作答永远合法）；
接管未开启时无计时亦无暂停（ask 面整体不在场）。

### 36.5 测试与真机判据

单元（`test/ask-takeover.test.mjs` 增组；假 timer/假时钟既有替身）：

| 组 | 判据（都能红） |
| --- | --- |
| pause 机械 | 撤 timer（假 timer 收 cancel）+ `remainingMs` 首记 + 批级 `paused` 标记置位 |
| 越界不放行 | 假时钟推过原 `expiresAt` → 无合成答案（waterfall resolve 零调用、phase 仍 open、转录面零合成形状锚）；手动触发误挂 timer 的到期回调 → 仍不放行（expire 入口防御，读批级标记） |
| resume 平移 | `expiresAt = 恢复时刻 + remaining`（假时钟断言）+ 到点正常放行（合成形状锚） |
| 新批独立（R49） | 同组存在暂停批时 `take` 新批 → 挂 timer、全额窗口、`paused=false`；新批照表到期合成放行、同组暂停批仍冻结（改回「新批自动暂停」实现必红） |
| 出窗即失效（R49） | 暂停批经齐答/中止/超时放行任一路径出窗 → 后续新批照常计时（任何路径残留暂停态即红） |
| 跨会话隔离（R49） | 会话 A 存在暂停在窗批时，会话 B 在窗批照表走到期合成放行、`paused=false`；A 的 pause/resume 不触碰 B 的任何批次 |
| 到期边界（r51 补） | 时钟调度替身（armed 记 dueAt、advance 按到期序触发未撤销项）：新批 timer.ms=全额 + 到期前不结（缩短武装必红）+ 到期恰一次合成；恢复重挂 ms=剩余（重置全窗口必红）+ 到期点=恢复时刻+剩余 + 双边界兑现 |
| 作答不受暂停影响 | paused 批 `submitAnswer` → delivered |
| 标志生命周期 | 齐答清空批次后**无暂停残留**（新批照常计时——R36 原「标志跨批存活」判据随 R49 翻转为反面）；`disposeAll` 清空批次；`forgetSession` 清单会话各批标记、他会话不受影响 |
| 远端面 | pause/resume 的 wire 名与客户端手写 descriptor 逐字一致（J-15 对账同款）；两方法在 `markRemote` 名单 |

真机（验证实例，探针 `verify/probe-r49-batch-pause.mjs`；`probe-r36-ask-pause.mjs`
保留机械面回归——暂停冻结/恢复平移/幂等三断言不受 R49 影响）：

- (a) 暂停冻结：待答窗口内 pause → 面板「已暂停」+ 墙钟越过原 `expiresAt`
  无超时合成（转录零合成形状锚）。
- (b) 恢复平移：resume 后 `expiresAt` 平移（面板剩余时间重排）且到点正常
  放行。
- (c) 时序判据（R49-1）：批 1 暂停 → 齐答结清 → 模型发批 2 接管 → 首轮轮询
  `paused=false`、倒计时数字形态、**数字 ∈ [18,29] s**（全额窗口的用户可见
  量化面——继承/缩短必红）→ 墙钟越过全额窗口照表合成放行（**放行距组首见
  ∈ [20 s, 33 s]**——早合成必红；完整时序取证；R36 原「暂停期新批自动暂停」
  腿随 R49 翻转）。
- (d) 双会话隔离对照（R49-4）：会话 A 暂停在窗批、会话 B 在窗批照表走到期
  合成放行（**B 放行时刻 ∈ 下界窗**——早合成必红）；A 的恢复动作不触碰 B
  （B 按原窗口放行，不被 A 的动作冻结/平移）。
- (d-6) B 活动期恢复对照（r51 补）：B 仍在倒计时时恢复 A——B 数字**续走原表**
  （单调递减，不重置不冻结）；A 按剩余续走（数字 ≤ 28 s——恢复重置成全窗口
  必红）；A 第二次恢复数字同上界，放行时刻 ≈ 显示剩余 ± 粗容差（显数与兑现
  一致性）。
- (e) 开关随 R30：接管关闭时两座位无暂停开关。
- 探针纪律（r51 补）：开工面板必须本就干净（setup-clean 门）；收尾清理只动
  本次创建会话的组（共享实例不误伤他人）；证据 json 携带指纹（baseUrl origin、
  实体提示、探针窗口参数）与设置复原结局。

### 36.6 风险

| 风险 | 处置 |
| --- | --- |
| `agent/disposed` 不必然随会话结束触发（web 会话常驻）→ 暂停批残留面板 | 批级口径下残留＝在窗批本身（量级=在窗批数，随批出窗消失）；组开关可恢复、作答可结清——无会话级集兜底问题 |
| `expiresAt` 冻结语义与旧客户端折算冲突 | items 带 `paused` 标记后新客户端不算倒计时；旧客户端显示冻结剩余——视觉即暂停，可接受 |
| 误挂 timer（resume 竞态） | `expire` 入口防御（36.1，读批级标记）+ 单元「误挂 timer 到期点」用例 |
| 暂停无限期 → 模型无限等待 | 用户裁定接受（R36-a）；两座位常显已暂停态；原生 ask 本无超时（风险表既有行） |
| R49 废止跨批自动暂停：用户暂停批 1 期间离场、批 1 结清后新批 2 全额窗口走完合成空答放行 | 用户裁定接受（需求风险表 R49 行）；窗口可经 `askTimeoutMs` 调大（10–600 s）；迟到作答通道保留（R30-d，批放行后仍可补答）；回场可对在窗批再暂停 |

---

## 37. R38：宿主 0.2.0 适配（0.2.0 线）

> 需求：`docs/requirements.md` R38（含现行基线）。
> 引用约定：本节起现行锚一律 `[0.2.0]`（0.2.0 安装树）；0.1.7 树保留给历史事实（历史 `[0.1.7]` 锚继续有效，树不删）。

### 37.1 差异盘点结论与适配面

盘点方法：两安装树（0.1.7 / 0.2.0）全包文件级字节对比 + 本包消费面（`ctx.*` 服务、事件、peer、预设基线、客户端槽）逐项对账。结论矩阵：

| 消费面 | 0.2.0 状态 | 依据 | 适配动作 |
| --- | --- | --- | --- |
| ctx.shell / shellEnv / jobs / subagents(listChildren·startContinuable·getProvider) / events(agent·workflow·loader/volatile-update) / settings·configEditor 表单通道 | **逐字节相同** | 两树字节对比 | 无 |
| dsh-jobs-local cap 语义、workflow-ptc 引擎（档位解析/五钩子/错误码） | 相同 | 同上 | 无 |
| 预设基线（shipped standard/cordis patch）+ web-app 组合面 | 相同；宿主 cordis.patch.yml 增删行与本包行位无交集 | 两树对比 | `validate-preset` 期望集零改；行位判据照旧 |
| peer 版本锁定 | 上游全体精确锁 0.2.0-rc.2 | 上游 package.json 亲读 | **九个 dsh* peer 现锁 `0.2.0-rc.2`**（R38 升 rc.1、R44 更换锁定版本到 rc.2——§23 JSON 块随线）；cordis/timer 不动 |
| subagent `listDescendants` | 重写为 catalog 遍历（本包不消费） | 两树 diff | 无（e2e 对 list-agents 工具顺带观察） |
| sandbox 提权面 | displayReason 新增、拒绝文本加长、新导出 | 两树 diff | 无（理由前缀 `escalate sandbox to <mode>` 逐字保留；测试锚复核） |
| permission-presets auto 档 | approval never→ask | 两树 diff | 探针纪律：e2e 一律 danger-full-access 档（升径不变） |
| 主题别名表 | 90→104（超集） | 两树 diff | 无（check-alias-tokens 现场枚举，换锚自动按 104） |
| 客户端槽 `plugins.bundle.config` / SettingsForm 源 / configForms | 槽键集等同、源字节等同 | 两树对比 | 无 |
| 验证实例 | 本包已卸载（0.2.0 升级窗），三件原值在升级前备份 | 轮次实况 | 终局重装按 §37.3 |

**代码改动清单（全部落在仓库内，宿主树零改动）**：

1. `package.json`：九个 `@deepseek-ai/dsh*` peer `0.1.7-rc.1` → `0.2.0-rc.1`（R38-4；§23 表逐项依据沿用，dsh-llm/dsh-typert-protocol 同步升）。（现行 rc.2——R44 更换锁定版本，§39.3-A1）
2. 开发树 `node_modules` **六条 junction 重锚** 0.2.0 树（服务的 0.2.0 安装树 `node_modules\@deepseek-ai\<pkg>`）：`cordis`、`dsh-jobs`、`dsh-sandbox`、`dsh-subagent`、`dsh-tools`、`schemastery`——清偿四条指向全局 0.1.5 树的挂账（R37 接线完备性判据点名项），两条 0.1.7 树锚随线平移。（**实体接线清单不同**：按 §37.3-2，多 `cosmokit`、`schemastery` 走实拷贝。）核验工具 `verify/check-junctions.mjs`。（R44 起七条 junction 翻锚运行树 `dsh-0.2.0-rc.2`——§39.0/§39.3-A4）
3. `test/preset.test.mjs`：`EVIDENCE_TREE` 指向 0.2.0 树（判据「缺树即红」文案随路径更新；两树文件字节相同故期望集零改）。（R44 翻新树——§39.3-B4）
4. `tools/_host-resolve.mjs`：头注改为 0.2.0 口径（peer 锁 0.2.0-rc.1；`DSAT_HOST_MODULES` 指 0.2.0 树；`.volatile is not a function` 仍为错锚诚实信号）。代码零改（解析逻辑与锚点无关）。（现行 rc.2/运行树——R44，§39.3-B6）
5. `verify/check-facts-anchors.mjs`：新增 `[0.2.0]` 前缀 → `DEFAULT_TREE_020`；CLI 加 `--tree020`；`mutate-facts-anchors.mjs` 补一条新前缀变异（证明新路径能红）。
6. 文档：design §20/§21/§22/§23/§28 行号锚重锚（§37.5 表）；主题别名表补 0.2.0 口径注记；本节。（R44 又一轮更换锁定版本：§39.3-C 组）

**测试锚切换**：单测/接线层一律 `DSAT_HOST_MODULES` 指向服务的 0.2.0-rc.2 运行树 `node_modules`（R44 起运行树，design §39.3-B7；R15 验收判据 1 的 0.2.0 形态——`npm ls` 代际核查由锚点核查取代：junction 目标版本串必须 0.2.0-rc.2，见判据 A2）。

### 37.2 行为判据（0.2.0 侧，全部可失败）

单元/接线层（本机，0.2.0 锚）：

| # | 判据 | 变异路径（删保护必红） |
| --- | --- | --- |
| A1 | 全量单测 334+ 全绿 0 跳过（`--test-isolation=none` 同跑） | 既有变异组（mutate-*）不变 |
| A2 | 六 junction 目标的 `package.json` version 串全部符合线（dsh* = 0.2.0-rc.2；schemastery 3.18.4 / cordis 4.0.4）——`verify/check-junctions.mjs` 守（缺席/错树/错版本都红，无跳过态；R44 增五常量一致性对账段与 zod 第七条成七条） | 实弹已验：重锚前实测 6/6 WRONG-TREE 红；R44 翻锚中间态实测 7/7 WRONG-TREE 红（§39.3-A4 前身读数）。注意：`.volatile()` 诚实信号只在**指 0.1.5 全局树**时红（0.1.7/0.2.0 两树 schemastery 同 3.18.4，消费面无区分——⑤ 轮 I-1 实测），单测层无从区分两新树，看守全在本判据前半与 A3 |
| A3 | `package.json` 九 peer 全 `0.2.0-rc.2` 且 cordis/timer 不动；`peerDependencies` 键集与 §23 表一致；`version` 随窗（R44 = 0.2.2） | 改回任一 rc.1 串 → 对账用例红（T15；R44 实弹腿 A） |
| A4 | `validate-preset` ①–⑪ ×2 全绿；`preset.test.mjs` 对账用例在 0.2.0 证据树通过（缺树显式红） | 删 0.2.0 树预设文件 → 对账用例红（点名路径） |
| A5 | `check-facts-anchors`：`[0.2.0]` 前缀引用**零错误**（判定口径：报告里 `[020]` 标签行为零 MISSING/OUT-OF-RANGE；既有遗留错误单列不计（已登记，非本批引入非本批消）） | mutate-facts-anchors 新前缀变异（`[0.2.0]` 行号越界 → 红） |
| A6 | `check-alias-tokens` 在 0.2.0 锚下枚举 104 名、本包 42 处引用全落表（42 = R27 的 12 处 + R36 ask 面板新增 30 处） | 引用一个 104 外的名字 → 红（既有变异不变） |
| A7 | `check-docs` / `check-model-text` / `check-bare-filenames` / encoding / ps1 全绿 | 既有变异组不变 |

端到端（验证实例，0.2.0 实例，实体切换并重启后取证据）：

| # | 判据 | 变异路径 |
| --- | --- | --- |
| E1 | 新启动段（字节游标增量）无 `failed to import`、无 `did not activate`、无 `skipping profile bundle`（宿主行文产出链） | 装回 0.1.7 peer 的旧实体 → E1 红（R38-2 实测形态） |
| E2 | `dsh-async` 预设新建会话工具面：async_run / async_wait_job / async_wait_agent / async_agent / async_workflow 在列；tool-subagent/-fork/workflow 不在 | 预设行丢失 → E2 红 |
| E3 | async_run 冒烟：让出转后台（job_id 句柄）+ async_wait_job 取回；引擎档位按现行（danger-full-access 档下 workflow 引擎可用；auto 档遇审批弹层按 0.2.0 面解释） | 断开 jobs 服务接线 → E3 红 |
| E4 | async_wait_agent 屏障：子代理 settle 后即返（catalog 遍历口径）；ask-takeover 暂停/恢复＝R36 探针复跑（暂停冻结/恢复平移/暂停期新批三断言，不降级为抽查） | 摘 preset 行重跑探针 → 接管不生效（E4 红）。（R49 起机械面前两断言不变；「暂停期新批」腿随批级口径翻转为「新批照表计时」，取证走 `probe-r49-batch-pause.mjs`——§41.3） |
| E5 | 设置卡片：插件页可开、字段可改可存（volatile 提交后工具描述/快照刷新，槽位等同） | 槽键失配 → 卡片不渲染（E5 红） |
| E6 | 提权路径：workspace-write 档 async_run 沙箱拒绝 → 同轮提示 sandbox_permissions 出路（0.2.0 拒绝文本锚复核） | 摘 `escalationHintMarker` 提示行重跑 → 同轮提示消失（E6 红） |
| E7 | 0.1.7 冻结件不动、不重测：0.1.7 实体树与本仓 `v0.1.7` tag 的内容哈希在切换前后各取一次、逐字节一致；开发实例线零触碰 | 哈希对账不等 → E7 红（对账脚本即变异看守） |

### 37.3 实体与切换（R37 机制 × 0.2.0 profile 模型）

1. **冻结点**：master 全绿提交打附注 tag `v0.2.0`。
2. **实体** `<部署实体目录>/dsh-async-tools@v0.2.0`：`git archive v0.2.0` 裸树 + `node_modules` 接线——`@deepseek-ai/schemastery` 实拷贝（~3.18.4 与两树同版，沿 R37-C 形态）+ **八条 junction：`cordis`、`cosmokit`、`dsh-jobs`、`dsh-llm`、`dsh-sandbox`、`dsh-subagent`、`dsh-tools`、`dsh-typert-protocol`** 锚 0.2.0 树 + 实体根 `INSTALL-SOURCE.txt`（tag、commit、生成日期、接线清单、peer 版本）。⚠️ 实体清单与 §37.1-2 开发树清单不同：多 `cosmokit`（schemastery 传递依赖，R37-D' 实测缺它启动即 failed to import）、少 `schemastery`（走实拷贝）；**`dsh-llm` 与 `dsh-typert-protocol` 两条是真机实测后补**——0.2.0 宿主对插件**内层**裸导入走 Node 原生 loader 按实体**实路径**解析（junction 被 realpath，0.1.7 时代沿 junction 路径落到 profile 拦截层 0.1.5 镜像的通路在 0.2.0 不可达），实体必须自足解析 `lib/` 全部裸导入面（`ask-takeover.js` 的 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-typert-protocol`）；六条版首启实测 `failed to import`，补两条后 `IMPORT-OK`（判据 E1 首启段零失败标记）。
3. **三件对齐**（验证实例，模板 = 升级前备份原值）：**家目录 = 验证实例的 0.2.0 家目录**（实测更正：10-01 迁移把服务的 `DSH_HOME` 挪到了新家——服务管理器 `AppEnvironmentExtra` 在案；旧家目录是 0.1.7 线资产，动它服务看不见）：① `profiles/web/package.json` `dependencies["dsh-async-tools"] = "link:<部署实体目录>/dsh-async-tools@v0.2.0"`；② `dsh.profile.bundles` 追加 `"dsh-async-tools"`；③ `profiles/web/cordis.patch.yml` 恢复 `- id: async-tools-host` 整行重述 config（备份里的十一键值原文）。改前备份三件（`*.bak.preR38final-<时间戳>`）。
4. **重启**：三闸（`verify/_gates-r30.mjs`：10 分钟无活跃会话等）→ 经服务进程树外的重启脚本重启托管服务 → E1–E6。
5. **回滚路径**：恢复三件备份（或摘除三件回到「未装」基线）→ 重启 → E1 形态回到 R38-2 中间态行或未装态；0.1.7 冻结件全程不动，开发实例线零触碰即天然回滚位。

### 37.4 中间态条款（R38-2，写进两份任务包）

宿主已切 0.2.0、本包适配完成前：本包 bundle 行被 peer 检查拒载（`skippedBundles`/`failed to import` 产出链）＝预期，不当故障修（尤其不得就地改实体 peer 或加版本豁免）。实测现状：验证实例升级窗已卸载本包，中间态条款适用于「实体在场但 peer 未升」的一切中间形态；开发会话坐开发实例（R38-3 第一种选择，0.1.7 线工具完好）。

### 37.5 既有行号锚重锚表（`[0.1.7]` → `[0.2.0]`）

| 节 | 锚 | 0.2.0 位置 | 凭据 |
| --- | --- | --- | --- |
| §20.2-#8 | cordis-plugin-loader/lib/index.js:359-363 | 同号 | 包字节等同 |
| §21 头注 | `[0.1.7]` 行号亲读 | `[0.2.0]` 亲读 | dsh-settings/loader 等同 |
| §21.4 | dsh-settings/lib/index.js:122-131 | 同号 | 同上 |
| §22.1 表 | dsh-shell types 四锚 | 同号 | 包字节等同 |
| §22.2 | dsh-jobs/lib/types/index.d.ts:71-137 | 同号 | 包字节等同 |
| §23 | dsh-tools/package.json（惯例）、dsh-app-boot:294、:320-323 | 同号；peer 串 R38 升 rc.1、现行 rc.2（R44） | 上游亲读 |
| §28.2 | dsh-web-app/presets/{standard,cordis}.patch.yml | 同文件（字节等同） | 两树对比 |

### 37.6 风险

| 风险 | 处置 |
| --- | --- |
| 0.2.0-rc.2 → 正式版/rc.3 再升（R44 已兑现 rc.1→rc.2 更换锁定版本） | peer 精确锁随线升；本节判据 A2/A3 + §39.4 三腿是换代红信号；换树先读 `AppParameters` 认树（§39.0/§39.7——服务树路径不写死） |
| e2e 探针遇 auto 档审批（0.2.0 面） | 探针会话一律 danger-full-access（GUI 升档纪律） |
| 实体 junction 指向 0.2.0 树 = 与宿主同物理目录 | 正是单实例要求（双实例风险，R37 接线完备性判据）；E1 是总闸 |
| 验证实例是共享实例 | 只动 web profile 三件 + 自建探针会话；重启走三闸；他人会话/设置零触碰 |

## 38. R40：入口接管形态下的会话模型选择策略（0.2.0 线，用户裁定）

> 需求：`docs/requirements.md` R40（裁定记录：用户裁定**恢复指定路由能力**，
> 按缺陷立项）。三线均不改宿主源码。

### 38.0 需求与事实锚

R35 定向修改（§35）禁用两预设的宿主 `tool-subagent`/`-fork` 行后，会话的模型选择策略
结构性缺席——**无采样方、无持久事件**（验证实例实况下 shipped standard 行装载中
注册着投影键，但 standing 采样只作用于 standard 自己的会话；键在场与
采样无关）——
`async_agent` 带 `provider`/`model` 的调用被 `lib/agent.js` 按 §22.4 保守拒绝
（`error.noPolicy`；该行为已锚为正向判据）。R40 目标：不放弃 R35 入口
裁决的前提下，两预设（及任何挂本包行的预设）会话的策略**在位**，指定路由可用。

源码核实沉淀的事实（按现行值/依据/核销日期/更新入口四字段登记）：

- **`agent/created` 按作用域分发**：发射点以 `scopeTarget(agent, agent)` 定向
  （`dsh-tool-cordis/lib/types/api-catalog.js:203`「emits are scope-filtered
  regardless of which context invoked `register`」；提取器
  `dsh-scope/lib/invariant.js:11`）。组合作用域
  的监听只收本组合内创建的 agent——预设行 `ctx.on('agent/created')` 即天然过滤，
  无需 import `@deepseek-ai/dsh-scope`。宿主 standing 行（shipped standard 的
  `tool-subagent` 行在 delegation 组内）即此形态的活体成例。
- **`SessionSeq` 运行时为校验恒等**（brand 擦除，`SessionSeq(0) === 0`；
  `dsh-session` README「the brands disappear at runtime」）。`session.eventAt(seq)`
  按序号读单事件，与 `snapshotEvents`/`ownEvents` 同列**弃用名单**（「禁止新增生产
  调用」）——但宿主现行 `selectForSession` 的 freshSession 判定仍用它
  （`dsh-tool-subagent/lib/index.js:589`）。本包复制同款调用（`eventAt(0)` 判
  `session/end-seed`），由版本锚定看守锚住宿主源：宿主迁移读法 ⇒ 看守红 ⇒ 跟版。
- **投影注册表同键注册按 `stateVersion` 合并计数**（同版 refs+1，最后卸载
  才消失；异版拒共享抛错）——插件侧与宿主行同键共存是注册表的公开语义
  （`dsh-session-projection/lib/index.js:39-42, :81-101`）。
- **宿主采样链**（`selectForSession`，`dsh-tool-subagent/lib/index.js:588-605`）：
  投影现值 → 父会话继承（`header.origin === 'subagent'` → 父投影）→ fresh 顶层会话
  （`firstLiveSeq === 0` 且 `eventAt(0)` 非 `session/end-seed`）读 Host 单例服务
  `subagentModelSelection.current()`（enabled+allowedModels，volatile）；非
  `undefined` 即幂等追加持久事件 `subagent/model-selection-policy`（载荷过
  `assertAllowedModelRoutes`：非空串、无重复、≥1 条）。后续设置编辑不改已记录
  策略；恢复会话无已记录策略保持禁用（含显式空恢复）。
- **宿主行没有「装载但不注册工具」的受支持形态**：`apply()` 无条件注册
  投影，策略在场 ⇒ `list_subagent_models` 必注册（不依赖 provider 在场，
  `lib/index.js:388-389`）。包内 invariant 组合断言「可选招牌（`provider`+
  `model`+`reasoning_effort` 三键）或发现工具在场 ⇔ 持久策略在位且两件齐」——本包
  `async_agent` 无 `reasoning_effort`、不注册发现工具，不触发；R40 也不加两者
  （加了须同时满足 invariant 与 R4 面貌约束）。

### 38.1 路线裁定（A/B/C → **B：插件侧同键自注册投影 + 复刻采样**）

| 路线 | 裁定 | 依据 |
| --- | --- | --- |
| A 宿主行装载不注册工具 | **弃** | 无受支持形态（宿主行 apply 无条件注册投影与工具）。标准形态（`modelSelectionSettings: true`）带回宿主 `subagent`/`subagent_fork` 工具 ⇒ 重开 R35「结构性唯一入口」裁决并连锁翻 §28/§35 判据链；absent-provider 变形泄漏 `list_subagent_models` 进工具面（face 相位 27 工具计数必红，R4 隔离面）且骑「provider 永不出现」的未定义行为。「不改宿主源码」约束下 A 无受支持落地形态 |
| B 插件侧同键自注册投影 | **选** | 语义与宿主形态逐点等价（§38.2 表）；零工具注册（R4 面计数不变、R35 裁决不动）；接线仅**新增 zod 一条 junction**——投影 `stateSchema` 的注册表契约是 zod `.parse`（宿主双库并用：schemastery 给 Config、zod 给投影 schema；注册表 checkpoint/restore 路径直接调 `stateSchema.parse`，schemastery 无该方法，且同键合并**先到先得 def**——本包 def 先入则全实例该键都是本包的 schema——D1）；zod 在 0.2.0 树顶层平铺（`node_modules\zod`）；`SessionSeq` brand 运行时擦除免导入；作用域分发免 dsh-scope import。代价 = 宿主内部耦合，以版本锚定看守显式管理（§38.4） |
| C 直读全局白名单自任裁定 | **弃** | 语义漂移四条（根源都在宿主「创建时定格」采样语义）：调用时活值 ≠ 会话创建时采样；无持久记录（宿主客户端/UI 读投影看不到）；无父会话继承复刻；事后关白名单**会**收紧既有会话（宿主创建时定格、事后编辑不收紧——方向恰反）。四条都与「无 policy 会话不暴露模型参数」的宿主管控口径（§22.4）相逆。补「读后照记持久事件」即收敛为 B |

落点裁决（编号沿用本节）：

- **裁决 R40-1（接线位置）**：采样与投影注册都在 **`async_agent` 工具行装载期**——
  `lib/index.js` `applyWith` 的 `toolName === 'async_agent'` 分支调新模块
  `lib/agent-policy.js` 的 `wirePolicyRow(ctx)`。依据：①行在**组合层**
  （`presets/dsh-async.patch.yml:83`，不在 delegation 组），行 ctx 的作用域即组合
  作用域，`agent/created` 监听天然过滤（作用域分发语义）；②行生命周期 = 组合生命周期 =
  注册表 refs 计数语义，两预设各一 refs；③挂 `async_agent` 行的任意预设
  （含自建，README「工具不限于这两个预设」）自动获得策略在位——与行的可移植性
  同构。**宿主行不参与**（宿主平面监听会收全实例 agent，采样过广）。
- **裁决 R40-2（失败姿态，两服务分列——D5）**：
  - **settings（`subagentModelSelection`）缺席** ⇒ 本行**不接线采样**、stderr 通告
    一次（`lib/notice.js`，通告口径同 §13）、无 policy 拒绝保持。这是对宿主装载期
    throw（`:586-587`）的**有意偏差**：本包行是预设行，装载 throw 会拖垮整个
    组合里的其余四行工具；偏差登记进 §38.2 等价表。
  - **sessions（Session 注册表）缺席** ⇒ 只影响 ② 父继承分支（跳过继承，通告
    一次）；顶层 fresh 采样 ①③ 照常——宿主同场景顶层本来就不读 sessions
    （`:598-601`），装载期不放弃接线。
  - **settings 在场但 `current()` 抛错**（全局坏配置：enabled 且空名单）⇒ 与宿主
    standing 行同姿态——`agent/created` 串行监听抛错 ⇒ 会话创建拒绝（宿主
    README「installation failure rejects creation」同款响亮失败，配置错误不静默）。
- **裁决 R40-3（不做的）**：不给 `async_agent` 加 `reasoning_effort` 参数、不注册
  `list_subagent_models`、不动 `lib/agent.js` 的路由校验步（§22.4 的保守拒绝与
  白名单逐项判定原样——R40 只补「投影里有值」这一前提）。混合预设（自建预设同时
  挂本包行与宿主 `modelSelectionSettings: true` 行）双采样收敛：两边读同一全局
  源、同键幂等追加（同键合并计数语义 + 宿主采样链），先到先记、后到 no-op。

### 38.2 机制设计（`lib/agent-policy.js`）

```
常量（版本锚定看守互锚，§38.4）：
  POLICY_KEY = 'subagentModelSelectionPolicy'   // 与宿主同键（同键合并计数语义）
  POLICY_STATE_VERSION = 1                      // 宿主现行值；宿主升版 ⇒ 看守红
  POLICY_EVENT = 'subagent/model-selection-policy'

fold 副本（与宿主 subagentModelSelectionProjectionDefinition 同形，§38.4 整段互锚）：
  init: () => null
  apply(policy, event):
    policy !== null || event.type !== POLICY_EVENT → 原样返回 policy（先到先记）
    否则 assertRoutes(event.data.allowedModels)     // 副本校验：数组/非空串/无重复
                                                    // （同宿主 assertAllowedModelRoutes
                                                    //  三条——**不含**长度检查，D8）
    allowedModels.length === 0 → throw              // 宿主 fold 同款「at least one
                                                    //  route」——追加前已拦，防御性同形
  stateSchema: **zod 逐字副本**（宿主 :202-205——
    z.array(z.object({provider: z.string().min(1), model: z.string().min(1)})
      .strict()).min(1).nullable()）
  ⚠️ 注册表契约是 zod 的 `.parse`（checkpoint/restore 路径直调）——schemastery
  没有该方法；且同键合并**先到先得 def**（注册表公开语义），schema 错库会污染全实例该键（D1）。

wirePolicyRow(ctx)：                       // async_agent 行装载期一次
  ctx.sessionProjections.register({ key, stateVersion, stateSchema, init, apply })
  ctx.on('agent/created', ({ agent }) => sampleAndRecord(ctx, agent.session))
                                            // 同步监听（零 await），不打乱串行链

policyOf(ctx, session)：                    // 与宿主 :221-223 包装同构（D3）
  stateOf(session, POLICY_KEY)?.map(路由深拷贝)   // init null 经 ?.map 折成 undefined

sampleAndRecord(ctx, session)：
  existing = policyOf(ctx, session)               // 幂等判据 = 现读投影非 undefined
  if existing !== undefined → return（先到先记；宿主同款 no-op）
  routes = ① existing                              // （此处恒 undefined，走下面）
  if header.origin === 'subagent':                 // ② 命中即短路（else-if 同形，D4）：
      parent = ctx.get('sessions')?.get(header.parentSession)   // sessions 缺席→跳过本分支
      routes = parent === undefined ? undefined : policyOf(ctx, parent)
      // 父查无/父无策略 ⇒ 不追加（不落 ③——宿主同形）
  else if fresh 顶层（firstLiveSeq === 0 && eventAt(0)?.type !== 'session/end-seed'）:
      current = settings.current()                 // 抛错 ⇒ 创建拒绝（裁决 R40-2）
      routes = current.enabled ? current.allowedModels : undefined
  routes !== undefined
    → session.append(POLICY_EVENT, { allowedModels: routes 深拷贝 })
```

幂等判据**必须走 `stateOf` 现读**（`policyOf`）：setup 窗口内追加的策略事件走
`appendUnstoredSuffix`、**不会** re-emit `session/event`（宿主采样链语义）——事件驱动的
eager drive 收不到，第二个采样方（混合预设的宿主行）与重入的本包都靠 `stateOf`
读时惰性补折看到新值（D6）。

语义等价表（宿主 `selectForSession` ↔ 本包 `sampleAndRecord`，逐点；「等价」由
§38.5 真机判据背书）：

| 面 | 宿主 | 本包 | 等价 |
| --- | --- | --- | --- |
| 采样时机 | `agent/created` 串行、先于首请求（创建事务内） | 同一事件、同一串行链（作用域过滤） | ✓ |
| 值来源 | 投影 → 父继承 → fresh 全局 `current()` | 同序同源（同一 Host 单例服务） | ✓ |
| 持久化 | 幂等 append 同事件类型 | 同（宿主见已有策略 no-op——混合预设双采样收敛，裁决 R40-3） | ✓ |
| 白名单关 | `enabled=false` ⇒ 无事件 ⇒ 无 policy ⇒ 可读拒绝 | 同（`lib/agent.js` 校验步零改动） | ✓ |
| 子会话继承 | `origin==='subagent'` → 父投影 | 同 | ✓（边缘脚注：`origin==='subagent'` 而 `header.parentSession` 缺失的畸形头——宿主三元结构会落入 ③ fresh 全局采样，本包跳过不采，**更保守**（无 policy 拒绝方向）；单测有边缘腿） |
| 恢复会话 | 无已记录策略保持禁用（含空恢复） | 同（freshSession 含 end-seed 排除，`SessionSeq` 校验恒等语义） | ✓ |
| 事后编辑 | 已记录策略不变（事件持久） | 同 | ✓ |
| 混合预设双采样 | 串行链 + 已有策略 no-op | 同——幂等可见性靠 `stateOf` 现读（setup 窗口事件不 re-emit） | ✓ |
| 服务缺席 | settings 缺席 = **装载 throw**（`:586-587`）；sessions 缺席 = 仅继承分支**运行期 throw**（`:594-595`），顶层采样不读 sessions（`:598-601`） | settings 缺席 → 通告 + 不接线采样（**有意偏差**：本包是预设行，装载 throw 拖垮整组合）；sessions 缺席 → 跳过 ②、①③ 照常 | 偏差登记（裁决 R40-2） |
| 工具面 | — | **零注册**（R4 面计数不变；invariant 不触发） | 增量 |

### 38.3 装载与作用域

- `applyWith` 的 async_agent 分支在 `ctx.tools.register` 之后调 `wirePolicyRow(ctx)`；
  卸载走行 fiber 的既有 effect（注册表 refs 减计）。
- 静态 `inject` 不变：`sessionProjections` 已在列（R13 加入）；`subagentModelSelection`
  与 `sessions` 走 `ctx.get` 可选解析（缺席按裁决 R40-2 **分列**处置——settings
  缺席整支不接线；sessions 缺席只跳过继承分支）。
- HMR/行卸载中间态：行不在场期间新建的会话不采样（无事件、无 policy、拒绝保持）——
  与宿主行卸载行为一致，登记为已知边界（§38.7）。

### 38.4 宿主耦合的版本锚定看守

耦合面是**有意的设计选择**（B 路线的代价），用看守显式管理而不是假装没有：

- **静态看守 `verify/check-agent-policy.mjs`**（并入检查器序列）：读 0.2.0 树
  `dsh-tool-subagent/lib/index.js`，断言 ①宿主投影定义 `key` 与 `stateVersion`
  逐字等于本包常量（宿主升版而我们未跟 ⇒ 红）；②宿主采样链四锚在场
  （`subagent/model-selection-policy`、`firstLiveSeq`、`session/end-seed`、
  `parentSession`）；③**投影定义整段互锚（D2）**——宿主侧 `init: () => null`、
  `policy !== null` 短路、`assertAllowedModelRoutes(allowedModels)`、
  `length === 0` throw、`from "zod"` import 串、`.strict()).min(1).nullable()`
  schema 串，与本包 `lib/agent-policy.js` 对应行逐锚（宿主改 fold/schema 而
  key/版本未动 ⇒ 红）；④缺树即红（显式红——同 `test/preset.test.mjs` P14
  对账口径；检查器绑本机证据树，单测不绑）。
- **变异看守 `verify/mutate-agent-policy.mjs`**：改常量 / 删校验段 / 换事件类型 /
  改 fold 短路 / 删空名单 throw / stateSchema 换 schemastery → 静态看守必红；
  BASELINE-GREEN 未变异时恰绿。
- **单测不读树**：`test/agent-policy.test.mjs` 用替身（projections/sessions/
  settings service）测——fold 三态；assert 拒绝三形态（非数组/空串/重复）+
  空数组事件 → fold throw（D8）；**stateSchema 是 zod**（`parse(路由表)` 与
  `parse(null)` 过、对象有 `parse` 方法——换库该测必红，D1）；`policyOf` 包装
  （init null → undefined，D3）；采样链 else-if 同形（`origin='subagent'` 父查无
  ⇒ 不追加且不落 ③，D4）；白名单关不追加；恢复会话两形态不采样
  （`firstLiveSeq>0` 与 `end-seed`）；幂等（连调两次仅一条事件——判据写错该测
  必红，D3/D6）；settings 缺席不接线、sessions 缺席仅跳过 ②（D5）。

### 38.5 测试与真机判据（可失败口径）

单元/进程内（§38.4 清单）之外，acceptance-017 agent 相位的 **R40 后形态**（五判据
全绿 = R40 真机通过）：

1. 前置白名单设置面存在（不变）；
2. 开白名单（含 zai/glm-5.3）→ 新会话 → requested 调用 → 「note 锚 requested 标记」
   **预期绿**——判据本体正是收紧后的那套（`verify/agent-judgements.mjs` 零改动，
   收紧红利：同一判据先证伪、后在 R40 证真）；
3. 子会话 descriptor 报告 zai/glm-5.3（不变，预期绿）；
4. 新增：会话转录含 `subagent/model-selection-policy` 事件（采样落持久记录的
   直接证据）；
5. 「无 policy 可读拒绝」按**退场换形**：白名单关对照腿——临时
   `enabled=false` → 新会话 → requested 调用得 `error.noPolicy` 可读拒绝 →
   恢复白名单原值（回读比对）。目标态判据保留「白名单关 ⇒ 可读拒绝」这一
   宿主管控口径的活体证据。

回归面：face（27 工具计数不变——B 路线零注册）/control/behavior/settings 五相位
不回归；`test/preset.test.mjs` 全变异（P18 等）不回归；检查器全绿——E2 名单十件
（check:preset ①–⑪、encoding、docs、alias-tokens、model-text、junctions、
facts-anchors、bare、doc-paths、agent-policy；清单以交付账本的 E2 登记
为准）。R40 收口时 E2 漏登 model-text（名单写「八件」实列七名），补回并把
E2 与本节两处一致化；model-text 对 `lib/agent-policy.js` 的 8 处红走白名单/
宿主副本豁免类处置。

### 38.6 交付与回滚

- 版本 **0.2.1**；tag `v0.2.1`（v0.2.0 与 v0.1.7 为附注 tag，
  本枚建成时用了轻量形态——实体内容不受影响）；实体 `<部署实体目录>/dsh-async-tools@v0.2.1`
  （`git archive` 解包 + **九条 junction**——原八条之外**新增 zod**，锚 0.2.0 树
  顶层 `node_modules\zod`（D1）——+ schemastery 实拷贝；§37.3-2 机制不变；
  `INSTALL-SOURCE.txt` 随实体）。开发树同步加 zod junction（第七条，
  `verify/check-junctions.mjs` 名单更新）。
- 验证实例真家切换（§37.3-3 的三件口径）：三件中**只动**
  `profiles\web\package.json` 的 `link:` 串（→ `@v0.2.1`）；`dsh.profile.bundles`
  与 `cordis.patch.yml` 行**不动**（明说）；另做实体 junction 翻指与
  `package.json.bak.preR40-20261002` 一件备份（改动面只有 link 串这一处，
  bundles 与 `cordis.patch.yml` 未动——一件即覆盖全部改动面，与执行
  实况对齐）；开发实例零触碰。
- 装载核验走 E1 同款字节游标口径（重启前后服务的错误日志偏移分段，零
  `failed to import`/`did not activate`）；三闸与服务进程树外重启的
  纪律不变。
- 回滚：junction + link 翻回 `@v0.2.0`（新家留 `*.bak.preR40-*` 备份）→
  三闸 → 重启即回 R38 基线。

### 38.7 风险

| 风险 | 处置 |
| --- | --- |
| 宿主升版改投影定义/fold/schema/采样链 | 版本锚定看守红 = 设计预期信号（§38.4 ③ 整段互锚）；跟版流程 = 对照宿主新源更新副本与看守锚（注册表异版拒共享会在装载期先炸——看守让它在静态期先红） |
| zod junction 锚 0.2.0 树顶层包 | 与宿主同一物理实例、零版本漂移；宿主升 zod 大版 ⇒ 装载期 `stateVersion`/parse 行为面先暴露（看守 ③ 的 zod 锚同步红） |
| `eventAt` 弃用面与宿主读法迁移 | 本包调用与宿主 `selectForSession` 逐字同形，看守锚宿主源；宿主迁移 ⇒ 看守红 ⇒ 同步换读法 |
| 行卸载/HMR 窗口新建会话无采样 | 已知边界（同宿主行卸载行为），§38.3 登记；窗口后新会话恢复采样，旧会话策略不受影响（持久事件仍在） |
| 混合预设双采样竞态 | 同键幂等（注册表合并计数 + 宿主采样链语义）：两边同源同值，先到先记；单测覆盖幂等腿 |
| 全局坏配置（enabled+空名单）阻断会话创建 | 裁决 R40-2：与宿主 standing 行同姿态（响亮失败）；README R40 段说明 |

## 39. R44：宿主 0.2.0-rc.2 更换锁定版本（同窗机械切换，消费面零变化）

> 需求 `docs/requirements.md` R44（同窗五步：树→锁定版本→测试套件→0.2.2 实体→真机核销）。
> 设计裁定已全部并入本节文字（需求步骤 1 现况注记 C13、等同等同触发处置 §39.2-5/C14、路径常量红腿 A5/腿 C、
> C11 清单缺口核销）。

### 39.0 现行树锚与方向裁定（三件套）

**决定（现行形态）**：仓内一切「0.2.0 树」锚——开发树七 junction、`DSAT_HOST_MODULES`（会话显式值
+ 注册表 `setx` 一次性值）、`verify/check-facts-anchors.mjs` 的 `[0.2.0]` 常量
（`DEFAULT_TREE_020`）、`verify/check-agent-policy.mjs`/`mutate-agent-policy.mjs` 的
宿主源常量、`test/preset.test.mjs` 的 `EVIDENCE_TREE`、`verify/diff-trees.mjs` 的 B
树常量、`verify/check-junctions.mjs` 的默认树——**全部锚运行树
（服务的 `dsh-0.2.0-rc.2` 安装树）**；旧树 `dsh-0.2.0`（R38 建树，仍
rc.1）不再原地升级，封存为 0.2.0-rc.1 线历史资产（同 0.1.7 树待遇，0.1.7 线零触碰
条款不动它）。
**依据**：验证实例服务参数（服务配置更新入口触发重读）——
`AppParameters` 指新树（rc.2 安装树）的
`@deepseek-ai\dsh\lib\bin.js web --no-open`
（新树 `@deepseek-ai/dsh` version=`0.2.0-rc.2`、zod 4.6.5、cordis 4.0.4），服务 Running，适配前两插件（本包 `dsh-async-tools@0.2.1`
与使用者的同 profile 参考插件 `0.2.0`）均被 peer 检查拒载（`skipping profile bundle`
行，报文印运行时版本 `dsh 0.2.0-rc.2`——§37.4 中间态记录）；§37.6 不变量
「实体 junction 与宿主同物理目录」在服务已迁树后**只能锚新树**才成立。0.2.0 正式版/rc.3 再升时按 §37.6 换代条款另轮处理。

推论两条（R44 步骤 1 的形态变更）：① `npm install` 仅作**应急支**——仅当 §39.2
矩阵核查发现新树缺件时启用（在**新树**根补装；`--cache` 指工作区
`.npm-cache`）；② 「先树后钉」次序已满足，停窗回退的语义见 §39.7。

### 39.1 范围与非目标（R44）

- 更换锁定版本的对象 = 调研登记的换锁清单 **＋翻锚增量**（`dsh-0.2.0` → `dsh-0.2.0-rc.2` 的
  全部落点，§39.3 全表）；`lib/` 零代码改动（九 peer+伞包 rc.1→rc.2 逐包 diff
  证明消费面零行为变化）；预设补丁两件零改（树基线 + §39.4 的 check:preset 覆盖）。
- 非目标（R44 原文）重申：不搭载任何功能改动；不预判 0.2.0 正式版；开发实例、v017 实体、
  `v0.1.7` tag、0.1.7 树零触碰不重测。**新增边界两条**：① 同 profile 参考插件的
  rc.2 换锁属使用者另一包线，本仓零动作——重启后其 skip 行持续在场，本包激活判据按
  **bundle 名作用域**读数（§39.6-2）；② 旧树 `dsh-0.2.0` 不升级、不删除、不改写
  （@v0.2.1 实体 junction 锚它——R40 回滚位的物理基础，§39.7）。

### 39.2 运行树矩阵核查（版本锁定事实重跑；R44 判据 1 前半）

对新树 `dsh-0.2.0-rc.2\node_modules\@deepseek-ai` 全量枚举（非抽样）：

1. `dsh*` 包 version 串**全部** `0.2.0-rc.2`；
2. 包集合 vs 旧树（rc.1 基线集合）：期望**零增零删**（rc.1→rc.2 无新包无删包；
   任何增删 → 停窗重盘点）；
3. 平台包不动：cordis 4.0.4、cosmokit 1.8.5、schemastery 3.18.4、
   cordis-plugin-timer 1.1.6、cordis-plugin-loader 1.0.5、group/include 同版；zod
   顶层 4.6.5（check-junctions 第七条期望）；
4. 上游版本锁定惯例抽核：家族包 peerDependencies 里 dsh* 精确锁 `0.2.0-rc.2`（如
   dsh-tool-jobs，同款锚惯例）。

产出：版本锁定矩阵改写（现行值换新树 rc.2 + 包集合零增删注记）＋矩阵读数归档
（交付记录 R44 节）。任一不符 → 停窗（§39.7），先走应急支再议回退。
5. **等同等同新配对重跑**：等同比对事实的更新入口「0.2.0 树升级时重跑
   `verify/diff-trees.mjs`」触发条件已满足——B5 翻 B 常量后用正式工具跑点名
   包清单（0.1.7 × rc.2 新配对），读数归档；等同事实现行值加日期化注记
   （rc.1 配对读数时点 + rc.2 配对读数去向）。
6. **全家族 rc.1 × rc.2 文件级对照**：一次性脚本
   （`verify/_tmp/`，gitignored）对两树 `@deepseek-ai` 全部 288 包做文件级字节
   对比——预期变更面 = 九 peer + 伞包（消费面判定表）+ 全家族 package.json 重钉；
   名单之外任何文件级差异 → 停窗重盘点（「仅版本串」是判定不是保证）。
   **全量对照结论**：九 peer+伞包面**恰为消费面判定表**
   （唯一 PEER 命中是伞包 chunk 换名的白名单笔误），家族其余变更为 user-question-reply
   特性线与 UI 刷新——**消费面零变化结论经全量对照成立**；受影响
   配对声明（等同与客户端槽面）随读数注记；行为面交 §39.6 五相位回归（E5 看守
   api-gateway/plugin-manager 变更面）。

### 39.3 仓内换锁锚全表（R44 步骤 2；grep `0\.2\.0-rc\.1` 与 `dsh-0\.2\.0\\` 双扫核对）

**A. 红信号锚（改串即红/被守）**：

| # | 落点 | 换代内容 |
| --- | --- | --- |
| A1 | `package.json:78-86` | 九个 `@deepseek-ai/dsh*` peer → `0.2.0-rc.2`（T15 守） |
| A2 | `test/index.test.mjs:566-573` | T15 标题、注释、`DSH_LINE` → rc.2；注释换代条款改写为「rc.2 → 正式版/rc.3 再升时本用例先红」（§37.6 风险表第一行同款语义）；**新增 `version` 断言**（`pkg.version === '0.2.2'`——version 由此获得 tag 前红信号，不再只靠切换穿指读兜底） |
| A3 | `verify/check-junctions.mjs:34-40` | `EXPECTED` 四串（dsh-jobs/sandbox/subagent/tools）→ rc.2 + 头注 `:6` 口径 + 版本锁定矩阵引 |
| A4 | 开发树七 junction（物理） | `node_modules\@deepseek-ai\{cordis,dsh-jobs,dsh-sandbox,dsh-subagent,dsh-tools,schemastery}` + 顶层 `zod` → 逐条重建指新树；**次序**：先翻 junction 后改 A3 表——中间态跑本器必红（WRONG-TREE/VERSION），即换锁红信号实弹（§39.4-3 腿 B 的前身读数） |
| A5 | `verify/check-junctions.mjs` 增**一致性对账段** | 五处树根常量——`check-facts-anchors.mjs` 的 `DEFAULT_TREE_020`、`check-agent-policy.mjs` 的 `DEFAULT_HOST`、`mutate-agent-policy.mjs` 的 `HOST_PATH`、`preset.test.mjs` 的 `EVIDENCE_TREE`（取其上溯树根）、`diff-trees.mjs` 的 B——与本器 `TREE` 根逐条对账（读源文件抽常量，大小写不敏感），任一不同步必红：B 组翻锚后「漏改/回退任一处」从全绿盲区（两树文件几乎一致，消费面判定表）变为可检出；变异腿 C（§39.4-3）证其能红 |

**B. 路径翻锚（`dsh-0.2.0` → `dsh-0.2.0-rc.2`；代码零逻辑改动）**：

| # | 落点 | 内容 |
| --- | --- | --- |
| B1 | `verify/check-junctions.mjs:32` | `TREE` 默认值 + `--tree` 用法注 |
| B2 | `verify/check-facts-anchors.mjs:34` | `DEFAULT_TREE_020` → 新树 `@deepseek-ai`；`:12` 头注（`[0.2.0]` → 0.2.0-rc.2 安装树）；`[0.2.0]` 全体行号锚随常量在新树重验（消费面判定表预期稳定——dsh-llm/dsh-subagent 的 typert.host.js 单行串替换行号不挪、六包仅 package.json 重钉；任何越界红 = 停窗重盘点锚，check-facts-anchors 即判据） |
| B3 | `verify/check-agent-policy.mjs:26`、`verify/mutate-agent-policy.mjs:18` | 宿主源常量（dsh-tool-subagent/lib/index.js）→ 新树路径（§38.4 看守随树走；rc.2 该文件零 diff——消费面判定表）；顺带：mutate-agent-policy 头注「九处变异」→「11 处」（M1–M11 实数，§39.4 的 11/11 是对的） |
| B4 | `test/preset.test.mjs:38` | `EVIDENCE_TREE` → 新树 `dsh-web-app/presets`；「缺树即红」判据随路径（§37.1-3 同款；两树 preset 文件字节相同故期望集零改，§39.4 check:preset 覆盖） |
| B5 | `verify/diff-trees.mjs:18` | B 树常量 → 新树（工具自述「换树时改 A/B 常量」） |
| B6 | `tools/_host-resolve.mjs:8-10` | 头注：peer 锁串 rc.2 + 示例路径新树（解析逻辑零改，§37.1-4 同裁定） |
| B7 | `DSAT_HOST_MODULES` | 本会话探针/单测一律显式指新树 `node_modules`；注册表一次性 `setx` 同值（交付记录 R44 节登记，R38 同款注记） |
| B8 | `README.md:479-484` | 验证节注释：证据树/解析锚/junction 三处路径与 rc 串；顺带`:484`「六条 junction」→「七条」（R40 起 zod 第七条，实跑 7/7） |
| B9 | `tools/check-alias-tokens.mjs:13/:61` | 头注与失败指引「指向 0.1.7 宿主模块树」→ 0.2.0 线运行树口径（现 `dsh-0.2.0-rc.2`）——R38 起过期的指引会把解析失败的操作者引向 R44 判据 5 要零触碰的 0.1.7 线 |

**C. 现行文档口径随线**：

| # | 落点 | 内容 |
| --- | --- | --- |
| C1 | design.md §23（:1079 表、:1087-1095 JSON、:1111/:1112 逐项表） | 精确锁串 → rc.2（注记 R44 更换锁定版本；上游惯例锚 `dsh-tool-jobs/package.json:32-39` 同号——rc.2 仅版本串变，消费面判定表） |
| C2 | design.md :709、:2703 | 「R38 起钉 0.2.0 线精确锁」现行串 → rc.2（R44 注记） |
| C3 | design.md §37 活判据 :3385/:3402/:3411(A2)/:3412(A3) | 版本串与树路径口径 → rc.2/新树（判据是活的，每轮测试都跑） |
| C4 | design.md §37 历史行 :3395/:3396/:3397/:3398/:3400/:3451 | **不改写历史叙述**，行尾加注「（现行 rc.2/新树——R44 更换锁定版本）」；§37.6/:3458 换代条款更新为「rc.2 → 正式版/rc.3 再升」同款 |
| C5 | 上游 0.2.0 线事实行 | 安装树=新树（内含 rc.2）、AppParameters 现指新树、旧树保留注记 |
| C6 | `[0.2.0]` 前缀定义事实 | `[0.2.0]` 前缀 = 0.2.0 线**运行树**（现 `dsh-0.2.0-rc.2`） |
| C7 | 宿主树事实（本机运行树） | 现行值补「本机运行树已 rc.2（使用者迁树+切服，R44 窗实测记录）」；核销日期更新 |
| C8 | 上游版本锁定矩阵 | §39.2 矩阵改写（现行值/依据/核销日期三字段随读数更新） |
| C9 | 服务认家事实 | 现行值补 AppParameters 现指新树 + 迁树实测记录（认家程序不变：动验证实例前先读本键） |
| C10 | 消费面判定事实 | 「更新入口」的树升级前置条件已满足——注记核销（rc.2 树面由使用者完成） |
| C11 | `verify/README.md` | junction 器行（rc.2 + 新树 + 七条口径 + **A5 一致性对账段**）；diff-trees 行树口径改「0.1.7 / 0.2.0 线运行树（现 rc.2）」；check-facts-anchors 行树口径随 C6 前缀重定义更新；**新增 `check-agent-policy.mjs` / `mutate-agent-policy.mjs` 两行**（文件表 R40 起就缺这两行——「唯一脚本清单」的既有漂移，一并核销；含宿主源常量指新树与 11 变异口径） |
| C12 | 交付记录 | R44 节（交付记录：裁定、矩阵读数、测试读数、红信号实弹、切换、核销）——**写完后复跑完整测试套件，读数标注取数时刻（README 纪律三）** |
| C13 | `docs/requirements.md` R44 步骤 1 | 行尾加现况注记（形态同 :46「现行基线」）：「（现行形态：步骤 1 已由新树形态完成，旧树不升级、`npm install` 仅作应急支——见 design §39.0）」——保留原裁决史、阻断按需求原文对旧树执行 npm install（该动作会静默改写 @v0.2.1 回滚位的宿主线） |
| C14 | 等同事实 | 现行值加日期化注记：等同清单系 0.1.7×rc.1 配对读数；rc.2 配对读数（§39.2-5 重跑）去向交付记录 R44 节；更新入口注明已触发已处置 |
| C15 | `tools/check-docs.mjs` ARCHIVES | 登记审查档案（设计审查/实现审查及修正档若出）→ 档案数随册 |

**D. 历史叙述豁免（不改写）**：R31/R38 线的调研、设计审查、需求评审与交付记录等
历史档案（含 `docs/requirements.md` R31 段、requirements-v3:46（R38 执行
基线行——R38 立项时点核实记录）、requirements-v3:69（R40 调研时点注记，自日期化）、DSAT_HOST_MODULES R38 段（历史登记；现行值由 R44 节接管））——历史档
按归档原样保留，不在公开面改写范围。

**E. 版本与交付件**：`package.json` version `0.2.1` → `0.2.2`（与九 peer 同批同窗；
T15 不查本包版本，登记在交付记录）；tag `v0.2.2` **附注**（§37.3-1 机制口径；
v0.2.1 轻量形态系 R40 建tag 时偏差——不复制该偏差）。

### 39.4 测试套件与换代红信号（R44 步骤 3；判据 4）

1. **完整测试套件**：`npm run test:inproc` 全绿零跳过（读数取于全部文档写完之后——README
   纪律三）；**`package.json` `version` 读数 = 0.2.2（T15 断言——拦在 tag
   之前）**；十器全 0（名单 = §38.5 十件：check:preset ①–⑪ ×2、encoding、docs、
   alias-tokens、agent-policy、junctions、facts-anchors、model-text、bare、doc-paths）；
   变异四套全绿（model-text 11/11 含 M10、agent-policy 11/11+BASELINE、facts 4/4+
   BASELINE-GREEN、mutate-index 一致）。
2. **既有遗产不新增**：check-facts-anchors 硬错误恰 7（既有遗留×7，[020] 标签
   零错——锚随 B2 翻新树后重验）。
3. **换代红信号不弱化（实弹，验后复原回读，读数入交付记录）**：腿 A——`package.json`
   任一 peer 临时回 `0.2.0-rc.1` → T15 必红；腿 B——`check-junctions.mjs` `EXPECTED`
   任一串临时回 rc.1 → 本器必红；**腿 C——B 组任一路径常量临时回旧树
   （如 `DEFAULT_HOST`）→ 本器 A5 一致性对账段必红**。三腿证明「改回任一 rc.1 串、
   锚回任一旧树路径必红」（R44 步骤 3 原文）。
4. 任一红（非实弹腿）→ 停窗（§39.7）。

### 39.5 版本、tag、实体与切换（R44 步骤 4；R37 机制）

1. master 全绿提交（锚+文档+版本同批）→ 附注 tag `v0.2.2`。
2. 实体 `<部署实体目录>/dsh-async-tools@v0.2.2`：`git archive v0.2.2` 裸树 +
   **九条 junction 锚新树**（`@deepseek-ai\{cordis, cosmokit, dsh-jobs, dsh-llm,
   dsh-sandbox, dsh-subagent, dsh-tools, dsh-typert-protocol}` + 顶层 `zod`）+
   schemastery 实拷（~3.18.4）+ `INSTALL-SOURCE.txt`（tag/commit/生成日期/接线清单/
   peer 版本 rc.2/回滚口径含迁树注记）。清单 = §38.6 v0.2.1 形态原样翻版（接线机制
   §37.3-2：内层裸导入按实体实路径解析——八条 @域 + zod 缺一不可）。
3. 验证实例切换（真家 = 0.2.0 线家目录，先读服务参数认家程序）：**预检三项**
   （改名避免与重启三闸撞名——托管服务 Running；真家三件对位；服务的错误日志
   基线游标）→ 备份
   `profiles\web\package.json.bak.preR44-<时间戳>`（一件——改动面只有 link 串
   ）→ link 串 `@v0.2.1`→`@v0.2.2` + profile junction 翻指（穿指读
   实体 `package.json` version=0.2.2 验证）→ **无 BOM 写法**（`[IO.File]::
   WriteAllText` + UTF8Encoding($false)，写后读首三字节）。`dsh.profile.bundles` 与
   `cordis.patch.yml` 不动。开发实例零触碰。
4. **重启由使用者执行**（不代跑重启脚本）；重启侧三闸纪律（无活跃会话
   等，e2e 流程惯例）随重启动作**移交使用者**；重启后进入 §39.6 核销。

### 39.6 真机核销（R44 步骤 5；五判据）

1. **运行时版本 = 0.2.0-rc.2**：链读（AppParameters → 新树 → `@deepseek-ai/dsh/
   package.json` version，§39.2 已核）+ **可执行读数**：对新树入口跑
   `node <新树>\@deepseek-ai\dsh\lib\bin.js --version`（执行 AppParameters 所指同一
   入口文件，打印其自报版本——兜底程序，不依赖任何条件句）+ 日志活体佐证
   （同 profile 参考插件未换锁期间其 skip 行印 `dsh 0.2.0-rc.2`——邻位观察；若使用者已将
   其换锁致该行缺席，前两读数已足，缺席本身记入邻位观察注记）。
2. **本包激活**：新启动段（字节游标增量）按 bundle 名作用域——`dsh-async-tools` 无
   `skipping profile bundle`/`failed to import`/`did not activate`；参考插件的
   skip 行**不在本判据内**（§39.1-①边界），作邻位观察单独登记。
3. **五相位回归 R40 基线不回归**：face 7/7（27 工具计数不变）/control 2/2/behavior
   12/12/settings 5/5（语言档程序按交付记录「语言档注记」：zh→临时 en→复测→复原
   zh 回读全等）/agent 6/6（zh 档直跑，判据双语锚）。
4. **测试套件＋十器**：§39.4 读数（取数时刻登记）即本判据证据；切换后开发树侧不重跑
   （实体内容 = tag 树逐字节，无第二来源）。
5. **0.1.7 线零触碰**：v017 实体/`v0.1.7` tag/0.1.7 树/开发实例无写动作（动作清单
   全量枚举核对）+ 开发实例服务 PID 前后一致（交付纪律 3）。

### 39.7 停窗、回退与风险

| 风险 | 处置 |
| --- | --- |
| 新树矩阵不符（缺件/版本参差/包集合增删） | 停窗 → **告知使用者并呈报矩阵读数**（新树是使用者资产，任何写入前先告知）→ 应急支：新树根 `npm install`（`--cache` 工作区缓存）；不可修 → 上报使用者（服务树是使用者资产，本仓不代改服务参数）；干预动作与读数登记交付记录 R44 节 |
| `[0.2.0]` 行号锚在新树越界（rc.2 全家族未逐包 diff） | check-facts-anchors 红即停窗 → 逐锚重盘点（「行号稳定」是判定不是保证——本器就是判据）；改锚须带新读数依据 |
| 测试套件任一红 | 停窗；插件保持 skip 中间态（§37.4：peer 拒载是安全态——服务面无崩溃、无数据面），不就地改实体 peer、不加版本豁免；重盘点后重走 §39.4 |
| 「回退 @v0.2.1」的现实形态 | 仓面：link+junction 翻回 `@v0.2.1`（其 junction 锚旧树 rc.1，实体原样）；但运行时已 rc.2——完整回 R40 基线需使用者把 `AppParameters` 翻回旧树并重启（使用者侧动作，本仓登记边界不代执行） |
| 兄弟仓 approve-for-me 的 skip 行持续在场 | 邻位观察（§39.6-2），使用者包线自处；E1 类判据一律按 bundle 名作用域读数 |
| 正式版再升时的双树漂移 | §37.6 换代条款（R44 版）：锚「服务现行树」——动手前先读 `AppParameters` 认树（认家程序），不默认任何固定路径 |

## 40. 公开面与内容边界（R45）

本节是**常驻架构**，不是上传前的一次性清理（那是 R39 的交付动作）。它回答一个问题：
**哪些内容进版本库、哪些只在开发机上存在，以及由谁守着这条线。**

### 40.1 单仓双平面

| 平面 | 位置 | 进版本库 | 放什么 |
| --- | --- | --- | --- |
| **公开面** | 仓里的一切**除了** `.local/` | 是 | 产品代码（`lib/`、`client.js`、`presets/`、`cordis.patch.yml`）、测试与工具（`test/`、`tools/`）、真机探针（`verify/`）、对外文档（`README.md`、`docs/requirements.md`、`docs/design.md`）、社区文件 |
| **本机平面** | `.local/` | **否** | 本机配置（`.local/config.mjs`）、过程语料（轮次稿、审查稿、事实登记簿）、验证证据（`.local/evidence/`）、部署脚本、临时产物 |

**为什么是"单一例外目录"而不是一长串 ignore 条目**：后者要求每加一个新产物都重新判断一次
"要不要 ignore"，而判断标准会漂——散着长必然长出永远清不完的例外表。收缩成**一条**
`.local/` 之后，新产物落在哪一半是**结构决定**的，不需要再判断。

因此这条线本身是**判据**：`tools/check-public-surface.mjs` 的结构族核对 `.gitignore` 的
非注释条目有没有超出登记全集（当前恰为五条：`.local/`、`node_modules/`、`.vscode/`、
`Thumbs.db`、`Desktop.ini`）。

### 40.2 配置加载器（`tools/_local-config.mjs`）

**代码公开、数据本地**——脚本留在公开面，但机器事实（安装树位置、实例坐标、证据落点）
经 `tools/_local-config.mjs` 取，解析顺序：

```
环境变量  →  .local/config.mjs  →  文档化跳过
```

环境变量优先是为了两件事：CI 不必造配置文件（Actions 的 `env:` 直接给
`DSAT_HOST_MODULES`），以及本机临时换锚不必改文件。

**缺席与损坏必须分开**，这是这套机制里最容易搞错的一点：

| 形态 | 含义 | 处置 |
| --- | --- | --- |
| `.local/` 整个不在 | CI 与外部 clone 的**正常形态** | 打印一行自述 + `SKIP`，**退出 0** |
| `.local/` 在、但 `.local/config.mjs` 缺失或装载失败 | 开发机上的**配置坏了** | **红** |

不分开的话，开发机上误删一次配置文件就会让**所有**本机判据静默变绿——那是最难发现的一类假绿。

派生字段尽量从既有字段算出来，不要各自独立配置：`evidenceDir` 缺省
`<root>/.local/evidence`、`tmpDir` 缺省 `<root>/.local/tmp`；而三档事实锚里的
`evidenceTree['020']` 缺省即 `<hostModules>/@deepseek-ai`——**宿主锚与事实锚因此指向同一棵树**，
"半翻锚"（两者指向不同代际）从"要靠对账发现"变成**写不出来**。

### 40.3 边界检查器（`tools/check-public-surface.mjs`）

三族判定，各有各的失败形态：

| 族 | 抓什么 | 为什么单列 |
| --- | --- | --- |
| **结构** | `.gitignore` 合规；非豁免源码里的 `.local/` 字面量；豁免名单里有盘上不存在的条目 | 抓"边界本身被改宽" |
| **本机指纹** | 机器路径、实例端口、服务名、用户名 | 抓"内容漏了"。**连注释一起扫**——注释里的机器路径一样会泄露 |
| **内部引用** | 公开文档引用事实编号、下沉语料、过程稿、历史运行产物 | 抓"读者解不开的指针"——文件存在、但读者够不着 |

扫描范围**从 `.gitignore` 推导**（不查 `git ls-files`），有两个理由：遍历规则与忽略规则
因此不可能互不一致；而且**尚未 `git add` 的新文件也在扫描范围内**——那正是最可能带着机器
路径溜进来的一批。豁免名单很短，每条带理由，并且**登记了却不再命中的条目按红处理**，
名单因此不会只增不减。

三族都能失败，由 `verify/mutate-public-surface.mjs` 证明（10 条变异全中，外加基线与四条**假阳性守卫**：上游公开包名与 URL 不得被误判）。

### 40.4 实施这条线时踩过的坑（实测）

- **文件名里带机器事实同样算泄漏**：一个以实例端口命名的语料文件**本身就是指纹**，
  哪怕内容全干净。所以**下沉语料时不要把它登记进公开面的名单里**——登记表会把这个
  文件名一起带出去。
- **注释不是安全区**：剥 `//` 与 `/* */` 注释**只用在结构族**（判 `.local/` 字面量时）；
  指纹与引用两族**连注释一起扫**。
- **指纹规则要防两头**：盘符规则写成"单分隔符"会漏掉 JS 源码里**转义的双反斜杠**形态
  （**假阴性**，等于整类漏检）；服务名规则按**子串**匹配会误伤上游**公开包名**
  （**假阳性**，一次误报几十条）。两条都要有回归钉子。
- **在 `.local/` 这种没有版本控制兜底的地方做目录移动，先 `Test-Path`**：PowerShell 的
  `Move-Item` 遇到**已存在**的目标目录是"移进去"而不是替换，随后的清理会连它一起删掉，
  而且 `Remove-Item` 不进回收站。

---

## 41. R49：待答暂停计时的批级独立（修订 R36 的作用面与寿命）

> 需求权威：`docs/requirements.md` §2 R49（用户裁定：暂停以批为独立单位、会话
> 之间严格隔离；批 2 走全额窗口的代价已在风险表接受）。本节是**修订轮记录**：
> 机械本体归 §36（现行批级口径），此处只记翻转落点、判据映射与变异口径。

### 41.1 翻转面（实现与测试两侧）

| 面 | R36 原口径（会话级） | R49 现口径（批级） |
| --- | --- | --- |
| 状态载体 | 注册表会话级集 `paused: Set<sessionId>` | 批级布尔 `batch.paused`（+首记剩余 `remainingMs`）；**无会话级集** |
| 新批登记 | 暂停会话的新批自动暂停（不挂 timer、全额窗口记为剩余） | 一律挂 timer、全额窗口、`paused=false`——不因同组存在暂停批而自动暂停 |
| expire 防御 | 读会话集 `paused.has(sessionId)` | 读批级标记 `batch.paused === true`；放行路径清标记（expired 相无计时） |
| 标志寿命 | 齐答不清标志（连续提问持续有效）；`agent/disposed`/`disposeAll` 清会话集 | 批出窗（齐答/中止/超时放行）即消失；`disposeAll` 随批清空；`forgetSession` 清该会话各批标记（尽力清理，不重挂计时） |
| K6/K7-b 判据 | 「暂停中 take 新批自动暂停」「标志跨批次存活」 | 翻转为「同组暂停批在场新批照表计时」「齐答后无暂停残留」——删掉批级独立保护（让新批继承暂停态）必须红 |
| 客户端组开关 | 会话级置位/清除口径注释 | 组内条目标记（`some(paused)`）——并存态显示口径见 §36.3（存在暂停批→「恢复计时」） |

零变化面：R36-b 计时机械（撤 timer/剩余首记/到期点冻结、按剩余重挂/平移、幂等、
防御闭合）、R30 判定/超时合成/迟到作答语义、远端面 wire 形状（`{sessionId}`
组键，两方法与回执形状不变）、按钮随 R30 统一开关、两座位渲染。

### 41.2 判据 → 测试映射（需求 §2 R49 五判据）

| 需求判据 | 单元落点（`test/ask-takeover.test.mjs`） |
| --- | --- |
| 1 会话内顺序批（暂停→齐答→新批照表放行） | K6 翻转体：同组暂停批在场 `take` 新批 → timer 挂、全额窗口、`paused=false`；墙钟越全额窗口合成放行、暂停批仍冻结。顺序腿（齐答结清→新批照常计时、无暂停残留）另由 K7-b 钉住 |
| 2 出窗路径对照（中止/超时放行出窗后新批照常计时） | K11：暂停批经 abort 与 resume 剩余≤0 两路径出窗 → 新批照常计时、无残留 |
| 3 跨会话隔离（新增用例） | K10：会话 A 暂停在窗批，会话 B 在窗批照表到期合成放行且 `paused=false`；A 的 pause/resume 不触碰 B（`paused` 标记、timer 武装数、到期点三面） |
| 4 R36 机械不回归 | K1–K5、K8、K9 翻转后原样断言（冻结/平移/幂等/批级防御哑火/清理/远端面） |
| 计时边界（审查补档——判据 1/4 的量化面） | K13：时钟调度替身——新批 `timer.ms`=全额、到期前不结且恰一次合成（缩短武装必红）；恢复重挂 `ms`=剩余、到期点=恢复时刻+剩余（重置全窗口必红） |
| 5 R36-e 边界不动 | K7（暂停批作答 delivered）+ J1/J19（接管关＝面板与按钮整体不在场） |
| 需求条目 5（并存态两座位显示——非判据面，映射补档） | K12：真组件 `AskList` 渲染——同组暂停批+计时批并存 → 组开关显「恢复计时」（类名+aria-label 双面）、点击只发 resume；恢复后全组计时翻「暂停计时」、点击发 pause |

变异口径（可失败证明）：临时改 `take` 让新批继承同组暂停态（恢复 R36「新批
自动暂停」形状）→ **K6 红**（继承变异只在「接管时刻同组已暂停」这一面生效，
K10 的 B 批接管发生在 A 暂停之前、结构上够不到继承分支）。跨会话泄漏（K10）
与出窗残留（K11）由各自专测护栏另行覆盖；恢复实现 → 全绿。变异运行与
复原记录进轮次报告（`.local/docs`，不进公开面）。

### 41.3 真机取证（验证实例）

探针 `verify/probe-r49-batch-pause.mjs`（§36.5 真机 (c)/(d)/(d-6)；时点判据
强化版）：

- **时序判据**：批 1 暂停 → 齐答结清 → 模型发批 2 接管 → 首轮轮询
  `paused=false`（倒计时数字形态、组开关显「暂停计时」、数字 ∈ [18,29] s——
  全额窗口的用户可见量化面）→ 墙钟越过全额窗口照表合成放行（转录出现超时
  锚句、放行距组首见 ∈ [20 s, 33 s]）。
- **双会话隔离对照**：会话 A 暂停在窗批、会话 B 在窗批照表走到期合成放行
  （B 的放行时刻 ∈ 下界窗，不被 A 的暂停冻结、也不早合成）；A 的恢复动作
  不触碰 B（B 放行后 A 的组仍冻结在场、恢复后按剩余平移放行）。
- **B 活动期恢复对照（r51 补）**：B 仍在倒计时时恢复 A——B 数字续走原表
  （单调递减不重置不冻结）；A 按剩余续走（≤ 28 s，非全窗口）；A 第二次恢复
  后放行时刻 ≈ 显示剩余 ± 粗容差（显数与兑现一致性）。
- **取证纪律（r51 补）**：开工面板本就干净（门控）；收尾清理限定本次会话；
  证据 json 携带指纹（baseUrl origin / 实体提示 / 窗口参数）与设置复原结局。

取证实例排序约束同 R32 条（需求风险表 R31 行：验证实例取证，或升级已成
事实则按该行口径处置）。

