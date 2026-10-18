# dsh-async-tools 设计

> 产品行为、默认值、合法范围和验收结果以[需求文档](<requirements.md>)为准。本文定义目标机制与验证方法，不以当前实现降低需求。
> 两份文档允许互引；除此之外必要内容自包含。源码和测试定位用于核验，不承载缺失说明。本文不保存迁移窗口、修复过程、候选方案或完成记录。
> 本文同步 dsh `0.2.1-rc.2` 的适配准备目标，不代表已经实现、通过设计审查或完成验收。后续开发仍需完成正式设计及独立审查。第 9 章只概述当前实施与验证状态；过程性问题清单另行维护，短期设计增补使用第 10 章。

## 1. 总体架构与组合范围

### 1.1 单包两角色

一个入口按行配置中 `toolName` 是否存在分派：

- 无 `toolName`：宿主配置角色，提供生效配置快照、浏览器入口和提问接管服务，不注册工具。
- 有 `toolName`：工具角色，每行注册指定工具；命令、两个等待和派生工具在预设顶层，编排行在 delegation 组内取得隔离的 `workflowEngine`。

`toolName` 可选且无默认值，不标 volatile。缺字段不能等于自动装上命令执行器。宿主行由本包的 [bundle 声明](<../cordis.patch.yml>)提供；[包清单](<../package.json>)声明宿主行和两份预设补丁，以及浏览器入口。

bundle patch 是官方组合树 overlay，不修改宿主源码或随宿主发布的文件。预设由宿主注册表声明，不由插件自管用户目录。

### 1.2 模块职责

| 职责 | 模块 |
| --- | --- |
| 分派、注册与描述刷新 | [入口](<../lib/index.js>) |
| 字段解析、范围与活取值 | [配置](<../lib/config.js>)、[预算常量](<../lib/budget-limits.js>)、[配置视图](<../lib/config-view.js>) |
| 宿主配置、提交与广播 | [宿主角色](<../lib/host.js>)、[快照](<../lib/settings.js>)、[刷新总线](<../lib/refresh-bus.js>) |
| 命令作业与首次等待 | [命令](<../lib/jobs.js>) |
| 作业／子代理等待 | [作业等待](<../lib/wait-job.js>)、[子代理等待](<../lib/wait-agent.js>) |
| 派生与模型策略 | [派生](<../lib/agent.js>)、[策略](<../lib/agent-policy.js>) |
| 编排包装、进度和记录 | [编排](<../lib/workflow.js>) |
| 消息、入口检查与订阅 | [消息部件](<../lib/interrupts.js>) |
| 渲染、双语及错误说明 | [输出](<../lib/output.js>)、[模型文案](<../lib/text.js>)、[描述构建](<../lib/descriptions.js>) |
| 生命周期诊断与可选防护 | [诊断出口](<../lib/notice.js>)、[静默失败](<../lib/silent-failure.js>) |
| 提问批次和 RPC | [提问接管](<../lib/ask-takeover.js>) |
| 设置表单、待答界面及客户端协议 | [客户端](<../client.js>) |

### 1.3 服务声明与作用域

目标入口静态声明 `tools`、`jobs`、`shell`、`shellEnv`、`subagents`、`timer`、`sessionProjections`、`agents`、`workingDirectory` 九项服务。声明同时作用于宿主行和工具行；任一固定依赖缺席时插件等待服务，不启动，也不绕过注入直接读取上下文。`sessionProjections` 用于模型策略，`agents` 用于子代理运行状态查询，`workingDirectory` 用于命令启动前取得有效目录。新增依赖的宿主行和预设行可见范围须由真实 cordis 接线验证，不能由替身字段在场推断。

`agents` 是公开 Agent 注册表（服务键 `agents`，dsh-agent 的 `AgentRegistry`）：`get(id)` 返回当前驻留的 Agent 或 `undefined`；Agent 的公开 `status` getter 只取 `running` 或 `idle`，`idle` 含维护阶段；状态转换发布 `agent/status` 事件，载荷 `{agent, status}`。目录条目只证明会话存在过，注册表驻留才证明当前有驱动；两者分开消费。`startActivation` 接受的 parent 必须是注册表中同一活 Agent 对象。工具只在先确认合法子代理关系后查询目标注册表，不读子代理私有日志；查询失败不伪造非运行状态。

可选审批、模型设置、会话查询、系统提示及引擎按调用或运行时注入取得；不能把可选服务缺席升级成全部工具永久不可用。`workflowEngine` 仍只在 delegation 隔离组内取得，其依赖和失败处理见 3.5。固定依赖与可选读取要分别测试。

工具行上下文覆盖组合内多个 Agent，不等于某个父子会话关系。消息监听必须按 `payload.agent.id === exec.agent.id` 过滤接收主体；状态信号按等待目标 id 匹配，作业事件按确切 owner 和目标 job id 匹配。

待核验对象：目标版本 `0.2.1-rc.2` 的 `@deepseek-ai/dsh-scope`（作用域过滤）、`@deepseek-ai/dsh-agent-preset-registry`（组合版本绑定）、`@deepseek-ai/dsh-agent`（`AgentRegistry.get`）、`@deepseek-ai/dsh-agent-loop`（`status` 与 `agent/status`），以及本包入口和消息部件。这里按包和符号定位，不沿用未经重核的源码行号。版本权威由需求 7.3 定义。

## 2. 共用预算、唤醒与结果机制

### 2.1 单一总截止

两个等待工具在 execute 入口建立单调时钟起点和夹紧后的总截止。入口取消可以零查询返回；有效等待参数缺失仍按需求报错。

```text
入口取消检查 → 参数及总截止 → 订阅消息与目标事件
             → 扫描已到未领消息、确认合法目标及当前状态
             → 在剩余预算内查询／重试／等待／轮询
             → 已有终态证据优先，否则按唤醒、取消或到期交回
             → 撤监听、计时和落败等待
```

- 总截止的定时器在参数解析后立即武装一次（arm，挂载启动），起点即单调时钟 t0；消息与目标事件订阅在武装之前挂好（先订阅、再扫描，避免唤醒空窗，与 §2.2 同一口径）；存在性屏障（即需求 2.1.1 的存在性检查，含其重试——同一机制，本文简称屏障）、先到扫描、终态判定和等待段全部发生在武装之后，计入总预算。屏障或入口检查之后不得以全额预算重新武装，中途任何阶段都不重置 t0。
- 等待初始化逐项登记已建立的订阅、定时器与等待登记；任一步失败时先撤销前序已建立资源，按本次调用的可控错误返回，不留遗留监听，也不成为进程级未处理拒绝。已创建的信号 Promise 在提前返回（入口即回、终态即回、屏障切断）之后仍可能拒绝，创建点或出口承接其拒绝，不遗留无人承接的派生 Promise。
- 查询、重试睡眠和等待只取得 `deadline - now` 的剩余值；不能重新夹紧到 `minWaitMs` 把总预算扩大。屏障重试的每次睡眠取 `min(pollIntervalMs, deadline - now)`，剩余不正时按到期返回，不把屏障段排除在预算外。
- 剩余值不正时直接到期，不把零传给使用零表示“不装定时器”的宿主帮助函数，也不调用要求正超时的 `jobs.wait`。
- 在途查询逐次串行：轮询链内上一拍结束后按剩余预算再排下一拍，不用异步 interval 叠加查询；目录列举与注册表状态读取同此纪律。收敛后复查发起前先撤销轮询续排（在途拍结束后不再续），复查不与轮询在途拍叠加成两路并发；主循环内（复查、状态读取）任意时刻在途目录查询至多一路。任何目录查询发起前检查剩余预算，剩余不正不再发起；调用退出后不再续排、不再新发。`subagents.listChildren(parentId, signal)` 支持取消，等待时将调用取消和截止信号传入，并与消息、取消和到期同时竞速——不只与到期竞速；宿主查询忽略取消信号时，消息与取消仍能立即交回控制。
- 到期后不无界 await 复查或错误清单查询。查询异常与超时保持未证实状态，不变成查无或目标完成。
- 落败 Promise（竞速中未胜出一方）的后续拒绝必须接住，取消尽力转发。若直接取得 session observation，迟到成功也释放租约；不得丢掉资源。取消底层 I/O 不保证物理操作瞬间停止，但不能阻止本工具交回控制。
- JS 同步段和宿主前置审批不受此定时器抢占，不宣传硬实时。必要渲染采用受控长度，不引入无界后置工作。
- 命令与编排的首次等待同口径：`yield_ms` 从等待段开始即武装，撤销后的完成优先复查在剩余时间外不再取得新预算；交回控制的原因按消息、取消、预算到期与终态分别说明，取消不并入预算到期；工具描述宣称的总时长与该口径一致。
- 时间判据：以最小合法 `wait_ms` 调用时，两等待工具的全程上界均为 `wait_ms + 300 ms`，包括需要屏障重试的情形。屏障重试至多三拍；每拍查询和睡眠只取总截止前的剩余预算，剩余不正即返回，不要求用完三拍。假时钟检查总截止不变；改变轮询间隔或实际重试次数不得延长总预算。300 ms 是现有等待计时单元装置的固定调度容差，不是可分配给查询、重试或等待的新预算。目录查询挂起专项采用更严格的 `wait_ms + 200 ms` 上界，对应现有装置的 250 ms 预算、450 ms 上界。上述数值是测试判据，不表示目标宿主已通过验证；真机按 8.1 分层单独标定固定调度容差，不按轮询间隔或重试次数追加时长。

待核验对象：目标版本 `0.2.1-rc.2` 的 `@deepseek-ai/dsh-subagent` 中 `listChildren(parentId, signal)` 与 `@deepseek-ai/dsh-jobs-local` 中 `wait` 的取消实现，以及本包两个等待模块。这里不指定未经重核的行号；目标宿主行为尚需回归。

### 2.2 消息集合和入口扫描

消息部件提供单次调用拥有的 `{promise, dispose}`，先订阅、再扫描主体待领取列表，避免订阅空窗。判断规则为：

1. 收件人是本次调用主体。
2. 消息此刻在该主体的 `nextStep` 中。
3. 来源命中其一：`source.kind === 'user'`（用户插话）；`source.form === 'notice'`（一次性通知，含其他子代理的结算通知）；`source.form === 'relay'`（代理转达，如 `agent-message`）。`form` 为 `instructions`、`catalog`、`snapshot`、`recall` 或无 `form` 的上下文消息不命中；进度事件、目录与配置快照不因角色为 user 就命中。

本包迟到作答通知（`source.kind === 'async-tools-late-answer'`）走专门唤醒分支，返回携带题目摘要；通用判定对它不重复命中，同一消息不产生两个竞争说明。

`agent/inbox/inserted` 不带落点，按 message id 回查 `nextStep`。事件提交后发生，正常等待期间不会自行领取；入口扫描按同一判定扫 `nextStep` 全列表，处理先到消息。列表读取失败保守为未证实，不使信号 Promise 无处理拒绝。

`nextTurn` 的 `queue` 不进入唤醒判断，不擅自移到 `nextStep`；goal 轮次驱动经 `followup` 投递，落 `nextTurn`，同样不唤醒。普通工具结果直接进入会话结果，不自动灌回自己的收件箱；额外上下文可能进入 `nextStep`，因此不能盲扫所有 user-role 项。

这套判定统一供应四个等待入口：`async_wait_job`、`async_wait_agent`、`async_run` 首次等待与 `async_workflow` 首次等待。四个入口共用同一消息部件与同一先到扫描；首次等待路径在等待开始前已到达的可处理消息同样立即交回。

通知只作为交回控制理由。目标结算单独按 sender／job id 或公开状态证据判断，不以其他子代理、其他命令的消息改变目标状态。消息唤醒胜出后复查目标当前状态（作业查快照、子代理查注册表现读），已停止运行按目标结果返回，不因消息先到诱导重复等待——该复查对 user 插话、notice、relay 与目标自身的结算通知一律适用；停止结果与并存消息说明并呈（3.4）。返回包含目标句柄和唤醒原因，不替宿主消费通知正文。唤醒原因中的摘要取消息自带的 `summary`：`relay`／`notice` 类消息可能不带，空档时给回退文案并优先点名来源（宿主契约：这两类 `source` 恒带 `senderSessionId`）；老形状缺席时退到无名占位，不留空置的摘要括号（需求 2.1.3）。`user` 插话不作回退，其摘要不进渲染模板。

待核验对象：目标版本 `0.2.1-rc.2` 的 `@deepseek-ai/dsh-agent-loop` 中 inbox 插入与领取、`@deepseek-ai/dsh-llm` 的 `ContextForm`、`@deepseek-ai/dsh-subagent` 的 `createSettlementMessage` 与代理转达消息构造，以及 `@deepseek-ai/dsh-goal-round-driver` 的轮次投递。上述消息规则是目标约定；逐项静态核对与真实投递验证尚未完成，不沿用其他版本的行号作为证据。

### 2.3 取消、终态优先与通知

- 等待 signal 与后台工作的私有取消信号分开。取消本工具只撤销 waiter、监听和计时，不调用命令或编排 cancel。
- 竞速收敛及时撤销落败的 `jobs.wait`，防止遗留活 waiter 错误抑制作业通知。已有目标终态证据优先交付结果；到期后不等待无界补查来争取终态。消息唤醒胜出后复查发现作业已终态时，按终态结果返回并附并存的消息说明；退出信息、溢出文件找回线索等结局细节完整保留，并存说明附加表达，不替换终态详情。
- 宿主结算事件的 `awaited` 表示释放过活 waiter，不是模型已经领取工具结果的确认。本包不得把它宣传为用户已收到答案。
- 宿主完成补发还受 owner 存在、显式模型 kill、teardown 等条件影响。不另建重复通知系统，也不把宿主一般投递故障扩成产品补偿任务。
- 普通 `relay`、结算 `notice`、状态 `idle` 和最终文本分开。可续子代理自动结算 `notice` 本身可含收尾文本；显式 `send_message` 是另一条 `relay`，不能保证每次都有两条或固定先后。

待核验对象：目标版本 `0.2.1-rc.2` 的 `@deepseek-ai/dsh-tool-jobs` 作业通知与 `@deepseek-ai/dsh-subagent` 的 `notifySettlement`。须分别验证正常投递、父主体离开、显式停止与服务清理条件；不以接口在场或静态阅读代替投递验证。

### 2.4 读取、合并和裁剪

作业快照用同步 `jobs.list(caller)`，将 throw、查无、已终态分开；不用 `get` 的未知 id 抛错混淆故障和缺席。`stopping` 等尚未收尾的中间状态不当作终态，按未结处理。状态观察不推进输出游标。

一次返回只调用一次 `jobs.read(jobId, caller)`。取全部 channel 的 chunks 文本拼接，再接首次终态 `result`；`result !== undefined` 是存在条件，空字符串也按该条件处理。

```text
delta = chunks 中有效 text 按顺序拼接
body = 无 result ? delta : delta + 必要换行 + result
output = 终态状态提示 + lossy 前缀 + truncate(body, maxResultChars)
```

必要换行仅在 delta 非空且不以换行结尾时增加。终态状态提示按真实终态（completed／failed／killed）取值，两语完整，无输出或无详情的形态同样可见。合并后保首尾、标省略量和 truncated；终态状态提示与 lossy 前缀不占 `maxResultChars` 预算，与省略量、truncated 标注一样按需求另计。内容预算对同一份结果只实施一次：省略量按原始内容计算，编排结算文本已含的状态提示与截断说明不再纳入后续裁剪；首次等待返回与后台读取交付一致的结果。读抛错返回单独读失败标记；此时未成功消费一次性结果，后续读取仍可重试。两个终态发现分支共享此路径。

`async_run` 和 `async_workflow` 首次等待内结果用启动闭包中的结算值，不为了直接返回而抢先消费注册表结果。后台句柄后由作业读取交付。

记录 shell 溢出文件路径，路径丢失且未报告时，明确说明没有找回落点。非零退出、信号终止和沙箱标记在 render 文本中可见，不能只存在于结构化 value。

### 2.5 返回提示的证据分级

两个等待工具与两条首次等待路径的返回提示由真实可用证据选择整段内容；同一段提示里不允许既肯定目标运行、又称状态未证实。

- 两类陈述分开：“本次等待没有终止工作”是关于本工具自身行为的陈述，任何出口都可使用；“目标此刻仍在运行”是状态断言，只有当次观察（作业快照非终态、注册表 `running` 现读）证实才写进提示。
- 共享消息模板（`wait.wokeByMessage`、`wait.lateArrived`，两个等待工具与首次等待路径共用）只陈述消息到达与正文将在领取点进入上下文，不内置运行断言；运行状态由随后的证据分档提示承担——证实仍在运行用 wait-again 提示，未证实换未证实提示（3.2／3.4 的两档）。中英文两档同受本节约束（需求 5.3）。
- 取消出口使用取消口径：说明调用被取消、后台工作未因此终止，不使用消息到达文案。收件箱没有命中消息时，不得声称用户消息已到达或将进入下一输入；消息到达说明只由真实命中的消息出口使用。四类交回原因（消息、取消、预算到期、终态）的文案互不冒用（需求 2.1.2）。
- 首次等待路径的提前结束同受分级约束：插话、消息、迟到作答与取消提前结束时，完成优先复查的非终态快照支撑运行句柄文案；复查读不到快照时按未证实口径给出句柄与复查出路，不宣称命令仍在运行。

## 3. 五工具与预设实现

### 3.1 命令作业

[命令模块](<../lib/jobs.js>)按以下顺序工作：入口主体／取消检查，解析参数和预算，解析沙箱并正常审批，审批返回后复查取消，取得有效目录并再次检查取消，作业准入，在 starter 中启动 shell，首次等待，返回结果或句柄。

有效目录以目标宿主原生命令工具的 `workingDirectory.ensure(exec.agent, exec.signal)` 为基准：

- 入口要求调用主体。取得服务后，先 await `ensure`，再用返回的绝对目录解析本次 `workdir`：未指定时使用该目录，相对路径以该目录为基准，绝对路径保留。即使传入绝对路径，也先执行 `ensure`，与目标宿主原生工具的调用方式一致；具体目录访问和沙箱限制仍由宿主执行。
- `header.cwd` 是会话初始目录，不是可直接使用的当前目录。`working-directory/change` 通过投影记录后续切换，`ensure` 还包含目录存在性检查、当前目录失效后的恢复和同会话操作串行化；直读投影或 `workingDirectory.get` 都不等价。
- 服务缺席按 1.3 的固定依赖等待处理；服务方法不可用、目录检查／恢复失败或调用取消时，在作业准入及进程启动前返回可读错误或取消说明。不回退到初始目录、服务进程目录或投影直读，不因显式 `workdir` 绕过失败。目录恢复及对应通知由宿主服务负责，本包不另建恢复逻辑。
- 启动使用本次 `ensure` 和路径解析所得的目录快照。之后切换会话目录不改变已经启动的命令；调用等待结束也不再次解析目录或重启工作。

静态依据为目标版本 `0.2.1-rc.2` 的 `@deepseek-ai/dsh-working-directory` 中 `ensure`／`set`／`serialize`，以及 `@deepseek-ai/dsh-tool-pwsh` 的 `resolveWorkdir` 和 execute。已核读接口与实现，不代表本包接线或运行行为已验证。

- shell 请求显式 `onExpiry:'none'`，不让宿主默认寿命定时器杀长命令；环境直接使用 `shellEnv.collect(exec)`。
- 作业有确切 owner，`label=command` 原文，description 进活动 progress，输出缓冲预算为 `maxResultChars × 3` 字节；`maxResultChars` 按正整数校验（5.4），三倍换算恒为宿主 `outputLimitBytes` 要求的正安全整数。注册拒绝按实际原因区分：并发触顶给上限、存活清单及出路，其余注册错误（含预算换算与宿主校验拒绝）原样可读上抛，不套用触顶文案。
- starter 内建立后台私有 AbortController，显式作业 cancel 才中止启动或停止进程。调用等待的 exec signal 不直连进程。
- 运行计时从批准后的启动阶段取得，不将审批计成命令已运行时长。首次等待的消息、取消和截止均不能丢失，消息已在待领取列表也有效。
- 准入拒绝发生在进程启动前，包含上限、存活清单及出路；shell 准备错误与并发拒绝区分。
- 结算按真实 proc 状态分 completed／killed／failed；done resolve 不自动等于 completed。输出 source 读取异常和 drain 守卫耗尽说明丢失。

返回结构保持可校验：结算有状态、输出、truncated 和存在的退出／信号／detail；未结句柄含 `job_id`、耗时和原因说明。可选字段无值不写键，不填 DSL 不支持的 null。渲染必须覆盖每个返回分支。

### 3.2 作业等待

[作业等待](<../lib/wait-job.js>)按第 2 章使用总截止、入口快照及消息规则。同步查到终态就读取一次输出；可处理消息唤醒但目标未结时不读空后台输出来伪造结果。

入口 signal 已中止时及时退出，状态查询失败给可重试错误；竞速结束撤销 waiter、订阅与定时器。已结状态的消费读取和等待中发现终态共享结果构建函数。唤醒交回的运行句柄文案分两档：复查快照非终态用 wait-again 提示，查询失败或清单查无按未证实提示，不宣称作业仍在运行（2.5）。

### 3.3 可续子代理

[派生模块](<../lib/agent.js>)显式校验允许参数集合和成对路由，经 `ctx.subagents.startActivation(spec)` 创建。目标调用形状如下：

```text
spec = { provider: 后端名, label: description,
         request: { prompt: text 内容块列表, parent: 调用主体,
                    [agentOptions: { provider, model }] },
         signal: exec.signal, delivery: 'parent' }
activation = { childId, [messageId], result, dispose }
```

`SubagentActivationSpec.request` 的目标类型为 `Omit<SubagentStartRequest, 'label' | 'signal'>`。`label`、创建 signal 和 `delivery` 均在 spec 顶层；未指定路由不带 `agentOptions`。宿主 request 允许 `outputSchema`、`cwd` 等可选字段，但本工具的公开参数集合不因此扩展；本次适配不透传这些参数，也不以类型断言掩盖字段或后端要求。

后端缺席、不支持 `startActivation`、后端没有 `prepareContinuable`、指定路由却不支持 `agentOptions`、策略拒绝，都在派生前可读失败。保留可续后端要求，不能因宿主也能创建外部单次 activation 而扩大产品支持范围。创建阶段拒绝只报告实际错误，不返回虚构 child id；发布前的局部资源回收由宿主启动事务负责。

成功回执立即含 child id、所选或继承路由及有界等待指引。调用只 await 启动被宿主接受，不 await `activation.result`，也不注册等待计时、轮询或作业。后台所有权约定为：

- 宿主 activation 管理器拥有已接受运行、后代所有权、自然结算、资源释放和父会话通知。`delivery:'parent'` 使最终结果经宿主通知交付；本包不转为 `caller` 后自行补发答案，也不重复发送结算通知。
- `spec.signal` 只控制发布前的创建。发布后，工具调用返回、该调用 signal 随后取消，以及任何有界等待的消息／取消／到期，都不取得停止 activation 的权限。本包不将等待信号接到后台运行，也不在工具出口、finally 或工具行卸载时调用 `dispose`。
- 返回对象取得后立即为 `result` 注册成功与拒绝处理，不延长启动回执。`result` 在宿主结算清理及通知处理后落定，但 resolve 不证明父主体已收到消息，也不证明清理没有失败；宿主可以保留已捕获结果并另行报告清理错误。`result` 只是观察通道：正常结算不在工具结果里重复交付答案；非正常 `stopReason` 不冒称成功；捕获等基础设施故障导致的拒绝经生命周期诊断出口报告，附准确 child id，不伪装成创建失败、成功结算或已通知父会话。处理回调本身及其派生 Promise 的拒绝也必须承接；诊断不依赖工具行仍在场，不建立无限期结果缓存。
- `dispose()` 是停止并释放这一次 activation 及所拥有后代的异步操作，不是“放下回执”。自然结算由宿主自动释放，本包不需要为了避免泄漏而立即调用它。显式停止仍走宿主管理入口；若后续正式设计确需直接调用 `dispose`，必须限定确切 activation、明确停止授权并 await 或承接释放失败，不能按 child id 缓存旧句柄去停止同 id 的后续恢复。

静态依据为目标版本 `0.2.1-rc.2` 的 `@deepseek-ai/dsh-subagent` 中 `SubagentActivationSpec`、`SubagentActivation`、`startActivation`，以及管理器的 `startLocal`／`watchLocalSettlement`／`finishDisposal`／`receipt`。这些接口和自然释放路径已核读；立返时序、发布边界取消、拒绝诊断与实际父会话投递仍待验证。

[模型策略](<../lib/agent-policy.js>)在派生工具行作用域注册与宿主同键、同 stateVersion 和同 schema 的投影。创建监听采样顺序：已有策略，子会话父策略，新建顶层会话的全局设置；满足条件才追加 `subagent/model-selection-policy`。恢复会话没有已有策略时不追补新全局值。

- state schema 使用 zod 的 `.parse` 契约，非空路由和重复校验与宿主一致；不把配置 schema 库当可替代投影 schema。
- 同键合并先到定义有影响，必须核对完整 fold、schema 和采样行为，而不只核对键名。
- 设置服务缺席不采样并通告，父会话服务缺席只影响继承；全局坏配置按真实错误拒绝创建，不能静默换模型。
- 混合预设双采样以现读投影判幂等；后续设置变化不改会话已记录策略。

耦合核验入口为[策略一致性检查](<../verify/check-agent-policy.mjs>)，不以静态文本锚通过代替实际指定路由验证。

### 3.4 子代理状态等待

[子代理等待](<../lib/wait-agent.js>)先用公开目录确认调用主体与目标的合法关系，再查公开 Agent 注册表取当前运行状态；合法关系判定与运行状态判定分别由 `subagents.listChildren` 与 `agents.get(id)` 承担，无驻留 Agent 与目录不存在分开。

入口检查在目录命中后查 `agents.get(agentId)`：

- 命中且 `status !== 'running'`：目标当前无驱动，立即返回停止态结果，说明停在“状态转为 idle”，不空等、不冒称成功。
- 命中且 `running`：进入等待。
- `undefined`：注册表无驻留，读作“不再观察到它在运行”，与目录行消失同档提前返回；不据此宣称子代理已终结。
- 查询抛错：状态未证实，不制造 not-found 也不制造停止态。

先到消息出口同受停止状态优先约束。入口扫描命中先到消息（user 插话、notice/relay、本包迟到作答）时，同样现读注册表一次：`idle` 按停止态结果返回；`absent` 先现查父会话子代理目录定档——查无该 id 视为从未存在，返回 `not_found` 并附已知子代理清单；目录有行视为存在过，按无驻留停止态返回；目录查询失败或截止竞速先到则存在性未定，不冒称查无也不冒称停止，此档 user 插话按 interrupted 口径交回、notice/relay 与迟到作答返回运行句柄加未证实口径，存在性留给下一次调用的屏障确认；`running` 才返回运行句柄加唤醒原因；`unknown` 不宣称仍在运行，按未证实口径交回（2.5）。停止态结果并存的消息以附加说明表达、正文留给宿主领取。注册表复查是同步现读，`absent` 档的目录查询与总截止竞速、计入总预算；不用消息到达制造“目标仍运行”的事实。

- `running` 表示驱动在运行，`idle` 表示当前无驱动；不据此推断成功。目录中的 catalog 存在不证明仍运行，descendant 的驻留 activity 也不能替代这一状态。
- 等待中双通道并行：事件通道（`agent/status` 转 idle、目标结算通知）与轮询通道（按轮询间隔查 `agents.get(agentId)` 的 `status`）。轮询不只查目录行消失；注册表无驻留与查询失败在轮询里同样分开，失败不触发结束。
- 事件通道保存到达的权威事件与目标身份（`agent/status` 载荷按目标 id 匹配），不把它压缩成无名标签。`agent/status` 转 idle 是权威停止证据：不要求结算通知同时到达，仅它在场即足以按“观察到停止”结束等待（settled），结算通知缺席或迟到不把权威 idle 降级为未证实；settled 说明不冒称最终回答已送达，回答按宿主消息另行到达。保存的是当次调用内到达的事件，与不长期缓存 `settled` 标记不冲突。
- 可靠停止证据（结算通知、注册表 `idle`／`absent` 现读、状态转 idle 事件）在手的返回立即交付，不被机会性目录复查拖延：目录复查只是弱证据的机会性升级，不作为返回前置。收敛后的复查与取消、消息和到期同时竞速（2.1），宿主查询忽略取消信号时取消仍立即交回（即时性判据 8.1）；迟到到达的复查成功与拒绝都有承接，不悬挂资源。
- 已经停止的目标入口直接交回，当前运行的目标订阅状态和结算，并在总截止内按轮询间隔重查。
- 只在当次观察上使用状态，不长期缓存一个 `settled` 标记；子代理重新启动后，旧结算不能永久代表当前运行。
- 目录查询失败不进入 not-found，状态未知不制造成功。备用轮询只检查合法目标，不读取日志取得最后答案。
- 无关消息命中主体可领取集合时交回但不改目标状态；`notice` 中 sender 精确匹配才是目标结算，正文模糊匹配不作为强证据。
- 工具描述如实说明入口即查当前状态、已停止目标立即返回；不把“已结算仍驻留的目标读作运行”写成已知限制。

### 3.5 编排作业

[编排模块](<../lib/workflow.js>)读取组合内 `workflowEngine`，沿用需求 2.4.1 的脚本和钩子契约。注册成功后才 `engine.start`；解析／meta 错误原样作为创建错误，不被包装成并发拒绝。

作业 `kind='async-workflow'`、label 为 meta.name、description 进进度；cancel 调 run.cancel，等待 exec signal 不接运行取消。引擎 stopReason（completed／cancelled／error）分别映射为作业终态 completed／killed／failed，并在清理和日志摘除后保持可用结果。

活动 mirror 订阅 phase、log、agent-start、agent-end 写 log 通道，phase 更新 progress。顶层 recorder 写 `tool-workflow/run-start`、`agent-start`、`agent-end`、`run-end`；append 失败停止该 run 的记录并告警。`exec.parent` 在场不写持久 recorder，mirror 和结果仍有效。

最终文本在闭包暂存，后台最终 result 由 2.4 合并消费。脚本引擎限制仍来自宿主部署，不能在描述中伪称固定并发数。

目标版本的 `PtcWorkflowEngine` 固定依赖 `subagents`、`ptcRuntime`、`sandboxPolicy`、`workingDirectory`。delegation 组继续仅隔离 `workflowEngine`；新增依赖必须在该组的引擎上下文中可解析，不能因为宿主根上有服务就宣称组合已满足。真实 cordis 接线须覆盖两份预设、宿主行和自定义挂载，不通过扩大隔离范围或绕过注入临时掩盖缺项。

引擎缺席时，`async_workflow` 在注册作业前明确拒绝；引擎运行阶段无法取得有效目录或执行当前沙箱策略时，保留实际失败并按真实结果结算。目标引擎在运行时不支持沙箱、会话策略又不是 `danger-full-access` 时拒绝执行。本包不为让编排启动而清掉策略、自动升权或改用无沙箱引擎；首次等待结束也不停止引擎。隔离范围、缺服务和受限策略的反例均须验证。

宿主 PTC 编排引擎的核验基准：`maxConcurrentAgents=0` 时自动取 `min(16,max(1,availableParallelism()-2))`，`maxTotalAgents=1000`、`maxItemsPerCall=4096`、`syncTimeoutMs=5000` ms。这些是宿主引擎出厂配置，不是本包新增参数，部署可改。目标版本 `0.2.1-rc.2` 的 `@deepseek-ai/dsh-workflow-ptc` 中 `PtcWorkflowEngine` 注入、Config 和 start 已静态核读；钩子契约、隔离组内装载及运行行为仍待核验。`@deepseek-ai/dsh-jobs-local@0.2.1-rc.2` 的 `DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER` 已静态核读，出厂值为 10；触顶提示仍须反映宿主实际生效值。

### 3.6 两个预设的声明与隔离

[异步模式补丁](<../presets/dsh-async.patch.yml>)和[异步创造补丁](<../presets/dsh-async-create.patch.yml>)各提供一条预设声明。目标 `config.plugins` 分别基于 `@deepseek-ai/dsh-web-app@0.2.1-rc.2` 随包的 standard 与 cordis 预设重建，不以当前插件补丁的行集合代替宿主基线。

两者相对基线的共同差异保持产品入口规则：禁同步 shell，顶层四行异步工具，delegation 组内第五行 `async_workflow`，禁原生单发／fork／workflow 创建入口，保留编排引擎及非阻塞管理入口。创作 skill 及基线其余工具保持，不将已禁用基线行误当活工具。

基线同步还包括以下目标约束：

- 保留 `time-context`、`tool-schedule`、`tool-plugin-market` 等目标基线行的顺序、配置及禁用条件。standard 的插件市场行保持禁用；cordis 保持按 `profileContext` 决定的条件，不为提供异步入口改变市场或调度工具的权限。
- `tool-plugin-manager` 在两份补丁中同为布尔 `disabled: true`：standard 基线即布尔禁用、逐字保留；cordis 基线为按 `profileContext` 决定的条件禁用，创造补丁改为布尔 `true`，不随 `profileContext` 启用。
- persona 只补充本产品的后台入口和有界等待纪律，不设置含 `{{cwd}}` 的 suffix。当前目录由宿主必需上下文 `working-directory:current` 提供，不另写静态目录提示。
- 计划模式说明按目标基线整段同步，再核对本产品入口纪律不存在冲突。目标基线不存在的行和配置键不补造回来；原生派生行的禁用仅作为入口控制，不用不存在的配置键表达后台行为。
- delegation 组保留 `workflowEngine` 隔离，`workflow-ptc` 继续使用 `provider: spawn`；按 3.5 核对新依赖可见范围。目标 standard／cordis 基线未声明 `working_directory` 工具行，本次基线同步不另增该直接工具入口，也不以工具行是否在场代替目录服务验证。

[预设校验器](<../tools/validate-preset.mjs>)按两个预设参数化比较顶层与嵌套行集合、顺序、禁止行、五工具各一、组内位置、禁用状态及 persona 关键句。基线版本来自需求 7.3，不硬编码本机路径。校验器和替身都须按目标基线重核；两份基线已静态核读，不代表补丁已重建或真机装载已通过。其他随宿主发布的预设以对照证明工具及提示不变。

## 4. 提问接管、延长与迟到作答

### 4.1 接管和批状态机

宿主角色在 `user-questions/request` 的前置 waterfall 应答者中执行同步保守判定。开关、根主体、实际预设、非计划评审全满足才接管，否则 `next()` 原生处理；预设读取失败不接管。

批记录核心字段含 `batchId`、`sessionId`、`agent`、`lang`、`request`、`questions`、`receivedAt`、`expiresAt`、`phase`、`settled`、`signalRef` 与 `onAbort`（期间取消的载体）、`cancelTimer`（到期定时器的载体）、`next`（原生流程的可逆交还），以及落定用的 `resolve`／`reject`——枚举非穷举。phase 只有 `open`／`expired` 两值；齐答或中止以独立 `settled` 布尔护栏防重复结算，批次随即出列。questions 保留每题 `open`／`answered`／`ignored`。

- take 取得当次初始窗口、建立一个 Promise 和计时器；入口与期间取消按 `ASK_ABORTED` 拒绝并清理。
- 齐答／忽略整批 resolve 原形 answers；计时到期保留已答，对 `open` 题给 `{id, selected:[], custom:<超时事实>}`，不是代答。
- 同步结算检查防止齐答、取消、到期重复 resolve。expired 原调用已经结束，只留未答题供迟到提交。作答与忽略提交入口按服务端时钟同步比较 `now` 与 `expiresAt`：真实期限已过时，无论到期回调是否已运行，都不按窗口内结算，改走迟到路径并返回 `late`，原调用不因此复活。
- 迟到题在新批接管时清扫超龄记录，`EXPIRED_TTL_MS` 按需求 4.4 的保留期定义；这不改变在窗提问期限。
- 卸载时先停自己的观察、计时和登记，对未结批调用可用原生 next 并接管其返回的 Promise；原生不可用时明确取消。expired 不重复交还。

### 4.2 延长动作

配置字段 `askExtendMs` 落在提问接管参数组，默认值和范围引用需求 5.2；进正数断言、毫秒与秒两种读数、宿主／客户端两侧的字段界表，不参与跨字段链。

远端方法 `extend(submission)`，载荷为 `{sessionId}`，只作用点击当时该组 `phase === 'open'` 且 `now < expiresAt` 的批；追加时长取点击时生效快照的 `askExtendMs`。

- 新期限为原 `expiresAt + askExtendMs`；不重置题状态或原 Promise，不创建会话级继承标记，也不改 `receivedAt`。
- 每批撤旧定时器，写新期限，再按剩余时间重挂。所有到期回调走同一个入口：先按服务端时钟比较 `now` 与 `expiresAt`，未到真实期限就重挂下一段，已到期才放行——排队中的旧回调不能提前结束，已到期批不因回调稍晚而复活。
- 若剩余延时超过 Node 单次定时器可表达值（`2^31-1` ms），按该上限分段武装并在回调重查实际期限，不因计时器溢出变成 1 ms，也不据此限制用户已追加的期限。接管时的初始计时与延长后的重挂共用这一武装函数。
- 新批从自己的初始窗口开始，不继承之前的延长。
- 返回 `{extended: n}`，n 为本次作用的在窗批数；无在窗批返回 `{extended: 0}`，同样是成功动作，不产生未来批次的状态。异常显示失败，不能假加时。

### 4.3 RPC、界面与语言

服务键 `asyncToolsAsk`，namespace `async-tools-ask`，使用公开 `TypertRemoteService` 与 `Remote` 标记。方法为 state、answer、ignore、extend，逐一登记进服务侧标记与客户端 strict descriptor 表；参数名 `submission` 与 descriptor 的 wire 名一致，裸载荷不另包一层。

state 返回 serverNow、按题展平 items 和待显示失败项。item 含 batchId、sessionId、questionId、题干、选项、multiSelect、receivedAt、expiresAt、phase；同批重复期限供展示，不存一份客户端独立计时事实。answer／ignore 返回 delivered、late、gone 或 failed；extend 返回 `{extended: n}`。gone 表示已清扫／已处理对象不在，failed 表示本次没有送达。客户端对这两类给可见说明，不以成功提示清掉未送达事实。RPC 动作在客户端的表述分三类：明确成功（服务端回执）、明确拒绝（服务端可达的失败回执）、未收到确认（请求已发出但无响应——超时、连接中断或响应丢失）。未收到确认不得断言动作未执行：提交不说“答案未送达”，延长不说“未生效”；不确定结果以既有 state 轮询与丢失名单收敛，不为此建通用网络恢复系统。

浏览器轮询 state 的设计间隔为 1000 ms，页面恢复可见及每次提交后立即刷新；后台页节流不当作服务端停止计时。overlay 挂 `shell.overlay` 全帧浮层槽（条目自定位右下），sidebar 挂 `sidebar.footer.action` 槽，复用 AskList 与 AskItem。徽标计数为未处理问题数，全部处理后消隐；徽标与组头入口跳转所属会话。每个会话组的组头提供“增加等待时间”按钮，与既有组头动作并列；点击只发本组 sessionId，成功后立即补一次 state 轮询，新期限经 serverNow 校准显示，题 key 保持 batchId/questionId，期限刷新不丢本地答案草稿。extend 未收到确认时提示只说明结果未知、以面板状态为准：延长每次成功都会累加（4.2），重试前先等 state 读回真实期限，期限已延长不再补点，未延长才重试，不把重复累加改成伪幂等。明确拒绝走面板顶报错通道，可重试，不假报加时成功。按钮文案 `ask.extend` 两语对应。

座位（`askUiSeat`，即字段表中的“待答问题显示方式”）的默认值与选项：默认值为 `sidebar`（需求 5.2）。默认值只在宿主配置行与用户层都未显式设置该字段时生效；已有合法显式选择（`overlay` 或 `sidebar`）保持原值、不被清洗，保存路径只提交改动字段（需求 5.1）。未显式设置该字段的用户在接管开启时看到侧边栏底栏徽标，显式选择任一座位的用户界面不变。显示方式不决定是否接管，`askTakeover` 默认关（需求 4.1）。客户端 `readConfig` 带防御回退：快照值层整体缺席时，回退值与默认值同为 `sidebar`。选项渲染顺序 `[sidebar, overlay]`，与需求 5.5 的选项命名顺序一致；选项文案的默认标记挂在“侧边栏底栏徽标”，与需求 5.2 一致，标记不指示用户当前选择（词典键位见设计 5.6）。

倒计时用 serverNow 校准展示，服务端期限为权威。单选替换、多选切换，无选项只自定义输入；超时显示可补答。失败项即使待答数为零仍可见，明确送达失败，阅读确认后才消隐。

展示词典由 uiLang 选择；auto 订阅宿主当前 locale，不写全局语言。所有按钮和错误有两语对应。

### 4.4 迟到通知与轮次边缘

迟到作答构造 `source.kind='async-tools-late-answer'`、form notice、summary，正文自含完整题目与答案：稳定题号、题干全文、选项全集（含各选项自身的 description）、多选属性、答案或忽略、自定义内容与时间信息；选项标签相同或相近时以 description 区分真实差别，不依赖模型记忆旧工具调用。不写成 source user。

空闲且无本包待启动投递时 followup，其他情况 inject 到 `nextStep`；本包待领登记与宿主 inbox 对账，不自建会吞消息的串行队列。最后领取点后的已接受消息由空闲观察补最小提醒，不重复答案正文。催领提醒使用本包自有 `form` 标记 `'reminder'`：宿主 `ContextForm` 枚举外值按不透明内容处理，不在 2.2 唤醒判定集合内；这是有意的本包命名空间选择，不用 `notice`／`relay` 等枚举值制造无效唤醒。

异步等待通过共用消息集合交回，先到答案也可入口命中；不要求把答案改成用户插话。发送或补醒失败可见，不能用正常回执掩盖本包失败。

## 5. 配置快照、语言与设置表单

### 5.1 生效数据流

schema 默认值和范围唯一引用需求 5.2。[配置模块](<../lib/config.js>)持有单一 Config；用户可编辑字段 volatile，行身份字段 `toolName` 与 `owningPreset`（预设归属声明，仅两份预设补丁设置，用途见 6.2）非 volatile 且无默认。

loader 给 apply 第二参中的 volatile Ref 在输入与 schema resolve 输出两侧解包成普通值，然后执行逐字段与跨字段校验。宿主角色把合法值存模块级快照，订阅自己 fiber 的 `loader/volatile-update` 重建并经 refresh-bus 通知工具。

工具持有实时取值视图，执行时读当前快照；宿主快照缺席用合法本行备用值并通告。首次加载时跨字段校验异常降级到合法默认，表单入口仍在；更新异常保留旧快照。两个失败方向都登记降级明细（模块级存储）。降级的告警分两层（需求 5.1“保留上一合法值并告警”）：stderr 操作员通告之外，降级期间五个工具的描述尾部拼接警示段——生效配置自检失败、违例明细与修复指引，en／zh 随 `agentLang` 现取；合法提交自愈即撤段，宿主行卸载清空登记；登记与撤销都经 refresh-bus 通知描述刷新，失败方向同样通知。只有宿主角色与工具行共用这个配置模块实例时总线才能连通。实际设置改动到描述与行为的关系，必须经接线和真实运行验证。

### 5.2 描述与双语

[描述构建](<../lib/descriptions.js>)为五工具整段构造描述及参数说明，文案来自[双语表](<../lib/text.js>)，数值取生效配置。工具定义会固化描述和参数 schema，刷新就地更新借用对象，不注销再注册，不增删构造时的条件参数键。

模型文本 en 无混入中文、zh 逐键译全、键集相同；标识符和用户数据保持原样。界面词典独立选择，宿主插件元数据依宿主语言。错误、状态、返回 note 同属模型文案，不能只翻描述。模型侧与设置页共用概念的用词以设计 5.6 的统一术语表为准（首次等待、作业编号、后台任务继续运行、等待示例值等）。

### 5.3 浏览器入口与官方表单

宿主行使用可解析的平名包，客户端模块图来自宿主 loader entry，不来自预设子树。package 的 web client 声明与 exports 同时在场。

配置区挂 `plugins.bundle.config`，key 为包名 `dsh-async-tools`，处于插件页描述与组件行之间。bundle props 不提供 form，客户端按 entry id `async-tools-host` 从 configForms 自取控制器，订阅替换快照并以 whileServed 守卫登记。

客户端依赖为 locale、ui-settings、ui-plugin-manager、api-gateway、ui-layout、ui-sidebar、ui-workspace 七项；真实到达浏览器由注入表和 DOM 验证，不能只看后端服务。

表单框架与模型用官方件：`SettingsForm`（只读／不可用通告、页脚保存与卸载丢弃）、`SettingsFormModel`（暂存、差集与保存）、`settingsNumberField`／`settingsTextField` spec；布尔控件本体用官方 `P.Switch`，徽标用官方 `P.Tag`（`P.`＝宿主 primitives 命名空间，即 `@deepseek-ai/dsh-client-ui-primitives` 的导入句柄，全文 `P.` 前缀同指）。字段壳统一自绘，取舍依据与度量口径见设计 5.5；主题仅用定义存在的别名 token。

`@deepseek-ai/dsh-client-ui-primitives` 包实体未随目标宿主 `0.2.1-rc.2` 安装树单独分发：`node_modules\@deepseek-ai\` 下无该目录，client-ui 拆分为按域包。web 外壳建资产（`dsh-web-frontend/dist/assets/index-*.js`）的冻结平台模块表仍含键 `"@deepseek-ai/dsh-client-ui-primitives"`（指向内联打包块），client.js 消费的七个成员 `SettingsForm`、`SettingsFormModel`、`settingsNumberField`、`settingsTextField`、`IconQuestionOutlineRegular`、`Switch`、`Tag` 在该建资产中全部在场——公开导出可用已按 `0.2.1-rc.2` 建资产冻结平台模块表静态实证（直接检索建资产文本），`require("@deepseek-ai/dsh-client-ui-primitives")` 在目标宿主运行时有效。待核验对象：本节与 5.5 中该包的其余细节断言——`SettingsValueField` 内建帮助形状、`fields.module.css` 逐项度量、`bg-layer-4` 在主题定义表中未定义——当前依据为 `0.2.0` 世代源树与目标版压缩产物的标识符命中，须在取得该包目标版源码或真机 DOM 后重核；重核前不把这些细节当作已证实的目标宿主事实。重核动作见 8.2“按目标 primitives 重核表单替身”。

### 5.4 草稿、提交与恢复

输入先进入草稿模型。清空输入表示取消该字段的覆盖，恢复默认也只暂存 unset；保存只提交改过的 set／unset，并携 revision 一次 mutate。保存应答为假时按失败处理，草稿保留。

单字段校验进 parse：全部数值字段带下界与上界（预算毫秒字段、延长时长字段与 `maxResultChars` 下界 1，`askTimeoutMs` 下界 10000，上界按字段界表），非有限、非正或越界的草稿 parse 为非法。`maxResultChars` 是正整数（字符数的整数语义与三倍换算依据见 3.1，范围见需求 5.2），非整数草稿同样 parse 为非法。官方 `SettingsFormModel` 对 parse 非法只置布尔 invalid 并禁用保存，原因文本由字段壳层分档显示：越上界、低于下界、非整数、链式违例、非数字各档给键（非整数档用于 `maxResultChars`），链式键按不等式左值字段扩展。配置服务同样核验整数与区间，不能仅页面挡住坏值。毫秒与时长字段在有限区间内的小数按需求允许，不自加整数限制。

跨字段按五条不等式校验：`minYieldMs ≤ defaultYieldMs`、`defaultYieldMs ≤ maxYieldMs`、`minWaitMs ≤ defaultWaitMs`、`defaultWaitMs ≤ maxWaitMs`、`pollIntervalMs ≤ maxWaitMs`。每条不等式的比较值取“草稿优先、无草稿用生效值”，覆盖草稿与生效值的组合；违例叠加进表单 invalid，原因显示在不等式左值字段，文案指明参照字段。空或非法草稿不参与比较，只按单字段档处理。

只读提示、label-for、aria-describedby、aria-invalid 与官方控件同形（统一字段壳，设计 5.5）。毫秒说明两段读数分别取生效快照与当前草稿，在说明行下换行呈现、带“生效”与“输入”两个标识：正数换算为秒文本，整数秒无小数、非整数最多两位小数；亚 10 ms 正值显示 `< 0.01 s`；空和非法值显示 `—` 占位，不出现误导数字。数值只用秒文本，存储单位仍是毫秒。输入件身份按 `plugin-config-<key>`，验收不依赖自绘 name 或任意类名。

设置页在表单顶部、全部字段之前呈现卸载风险提示块：默认预设指向本包预设时，停用或移除本包会让新建会话报 `agent-preset/not-found`，宿主不自动清除该选择；卸载前先在宿主设置切换到可用预设，已移除后按宿主设置入口清选或重选。提示为静态非交互文本，词典键 `uninstallRisk` 两语对应，深浅主题均可读。使用说明（README）保留同一指引的完整版与操作步骤，两处内容一致、详略分工：设置页给结论与动作，README 给步骤。提示内容自包含，不依赖卸载后即不在场的本包组件。

### 5.5 设置字段帮助：常驻说明与带圈问号

需求 5.5／5.6 要求每个设置字段提供常驻短说明与标签旁可点击的带圈问号帮助按钮，点击在字段下方展开详细解释、再点收起。机制如下。

**统一字段壳**。17 个可编辑字段共用一个自绘 `FieldShell` 组件（`EnumField`／`FlagField` 的合并扩展，值字段同用）。每字段渲染：

```text
div.ats-enum-field（字段列；上下 12 px，相邻字段 0.5 px border-l2 分隔）
  div.ats-enum-head
    div.ats-enum-labelGroup
      label.ats-enum-label（htmlFor = "plugin-config-<key>"；文本 = 需求 5.5 字段名称）
      button.ats-help-button（type="button"；带圈问号）
    span.ats-enum-badges（覆盖时：官方 Tag“已覆盖”＋“恢复默认”按钮）
  控件本体：值字段 input（numeric 字段加 inputMode="numeric"）、枚举 select、布尔官方 P.Switch
  p#<id>-message（常驻短说明＋毫秒读数——读数在说明下换行、带“生效／输入”标识，构成见设计 5.4；非法时换非法原因，口径见设计 5.4）
  div#<id>-help（role="region"；仅展开时渲染）
```

值字段不走官方 `SettingsValueField` 的决定依据：官方控件的内建帮助按钮（`help` prop）交互机制相同，但图标固定为带圈 i（`IconInfoOutlineRegular`，primitives 的 `SettingsValueField` 实现），标签行没有注入自定义按钮的开口；需求 5.6 指定带圈问号，需求 5.4 对宿主未提供的形态允许复用字段外壳。官方件继续在场的是：`SettingsForm`、`SettingsFormModel`、`settingsNumberField`／`settingsTextField`、`P.Switch`、`P.Tag`、`P.IconQuestionOutlineRegular`（带圈问号图标为 primitives 公开导出）。壳与输入件度量逐项照官方 `fields.module.css`：字段列上下 12 px、相邻 0.5 px 分隔，标签 13 px 字号／500 字重，输入件 34 px 高、13 px 字号、12 px 圆角、0.5 px 边框，说明行 12 px 字号，帮助区 12 px 字号、1.6 行高；控件焦点描边用 `--dsw-alias-state-business-primary`（官方输入件同款）。

**帮助按钮样式**（常态可发现是硬性要求，需求 5.6）：

- 按钮 24×24、圆角 8 px，图标 `P.IconQuestionOutlineRegular`（size 14）。
- 常态：0.5 px `--dsw-alias-border-l4` 轮廓＋`--dsw-alias-label-secondary` 图标色。字段说明行是 label-tertiary，问号高一档且有轮廓，不依赖悬停即可见、可与普通说明文字区分。官方 helpButton 的常态无边框、label-tertiary，达不到这条，不采用。
- hover 与 `aria-expanded='true'`：背景 `--dsw-alias-interactive-bg-hover`（深浅两主题各有计算值，反馈稳定）。不用 `bg-layer-*` 族：`bg-layer-1`／`2`／`3` 浅色主题与底色同值、不产生反馈；官方 helpButton 所引 `bg-layer-4` 在主题定义表中未定义，两主题均取不到反馈色（官方现行未定义引用，不照抄）。图标 `--dsw-alias-label-primary`；`:focus-visible` 外廓 2 px `--dsw-alias-state-business-primary`（与输入件焦点同源）、偏移 1 px。引用名一律在别名定义表内，`tools/check-alias-tokens.mjs` 把关。
- 不附可见“说明”文字：带轮廓的问号已足够醒目，若 17 个标签都附文字，只会增加噪声；需求 5.6 允许由设计定夺。可访问名称承载字段名（见下）。
- 不用错误或危险色制造醒目（需求 5.6）。

**开合状态与渲染层级**。`helpOpen` 是 `FieldShell` 内的 `useState(false)`，点击翻转——与官方控件的内建帮助同一机制。展开区是字段列最后一个子节点，普通文档流渲染：无浮层、无 z-index、无高度上限，长解释与示例把后续字段下推，内容完整可见、不被裁切或遮住；收起时该节点不渲染。

**无障碍**：

- 可访问名称来自词典模板 `help.a11yName`（zh“{field} 的说明”／en `Help for "{field}"`，`{field}` 替换为字段名称）——包含字段名称（需求 5.6）。
- `aria-expanded` 随开合；`aria-controls` 指向 `<id>-help`；展开区带 `role="region"` 与同名 `aria-label`。
- 控件 `aria-describedby` = 说明行 id（在场时）加展开时的帮助区 id，空格连接——官方控件同形。布尔开关沿用 `P.Switch` 的 `label` 属性作无障碍名的既有口径（可见标签长在壳上）。
- 键盘：原生 button，Tab 可达、Enter／Space 触发，焦点外廓可见；触屏目标 24×24；焦点与展开状态由外廓、背景与区域出现共同表达，不只靠颜色。

**“帮助开合无副作用”的状态隔离**（需求 5.6）。帮助开合状态只存于 `FieldShell` 的组件局部 state。草稿与覆盖在 `SettingsFormModel`（`staged`／`plan`），非法与保存判定在 `shell()`，配置值在控制器快照——帮助状态不写入其中任何一处：按钮 onClick 只调 `setHelpOpen`，不触碰 `actions.edit`／`resetField`／`save`，不调 `mutate`，也不触发提问或任务操作，按钮 `type="button"` 不提交表单。反向同理：草稿键入、保存、语言切换引起卡片重渲时，`FieldShell` 以相同组件类型与元素 key 复用，局部 state 保留——只读、非法草稿、保存中三态下帮助保持可读，字段错误、读数与风险提示不因开合消失；离开页面卸载时帮助状态随组件丢弃，不进任何持久层。

**缺键回退**。当前语言的 `help.<key>` 缺席、或取值等于键名本身（裸键名）时，该字段不渲染帮助按钮——宁可少一个按钮，不开出空区域。`hint.<key>` 同口径：缺席或裸键名时说明行（含毫秒读数）退场，不渲染空段。正常路径由键集判据守：两档键集相等之外，两侧文案对账测试（two-planes，test/two-planes.test.mjs，覆盖设置界面词典与模型文本两侧）增设键集在场断言——17 个字段的字段名键、`hint.<key>` 与 `help.<key>` 两档全必须在场，删任一键即红；回退路径用删键反例测试。

**只读与保存中**。控件随 `!state.shell.writable` 禁用，帮助按钮从不设 `disabled`；说明行、读数与展开区照常渲染（需求 5.6 三态可读）。

### 5.6 设置文案：分层、键位与统一术语

需求 5.5 规定中文字段名称与各字段必须说明的内容，需求 5.6 规定常驻／展开分工。本节定分层判据、词典键位、字段文案落位与三处同概念术语表（设置页、工具描述／参数说明、返回提示）。

**分层判据**。常驻短说明回答“这个字段管什么，以及会影响操作的限界”；展开区回答“机制如何运作、与其他字段什么关系、举例”。判定标准：用户不展开时缺这条信息会不会做错操作——会，则常驻。常驻的信息类型：适用范围（哪些工具／预设）、等待到时不停止后台任务、等待参数必填、超时不代答、开关仅本包两预设生效、示例值不等于生效值（由 `defaultWaitMs` 常驻承担）、显示方式不决定接管。放入展开区的信息类型：夹紧与跨字段配对、消息／取消提前结束、事件＋轮询双通道、截断计量与提示另计、三处防线的分布、迟到作答与清扫、时长示例。

**词典键位**（client.js `DICTIONARIES`，两档键集相等由两侧文案对账测试的键集判据守，`help.*` 同受约束）：

- 字段名称 `<key>`；常驻短说明 `hint.<key>`；枚举选项 `opt.<key>.<值>`。
- 展开区正文 `help.<key>`：段间 `\n\n`，渲染按段拆 `<p>`；首段固定为技术标识行（“配置键：askUiSeat（枚举：sidebar / overlay）”式）——需求 5.5 的“技术标识补充展示”由这里承担，字段名称本身不带键名后缀。
- 帮助按钮可访问名称模板 `help.a11yName`（`{field}` 占位）。
- 校验文案五档（`invalidNumber`／`invalidRange`／`invalidBelow`／`invalidInteger`／`invalidPair.<键>`；`invalidInteger` 用于 `maxResultChars` 的非整数草稿）；`invalidPair` 的 `{ref}` 替换为参照字段的**中文名称**（链式命中返回键，显示层经词典换名），句式用首次等待／单次等待术语。
- 操作按钮与状态：`save`／`saving`／`saveFailed`／`reset` 等操作按钮键，`readOnly`／`unavailable`／`overridden` 等状态键，沿用现行键组并按需求 5.5 的自然中文口径改写；两档同受两侧文案对账测试的键集约束。
- 枚举选项默认标记与需求 5.2 一致：`opt.agentLang.en`“English（默认）”、`opt.askUiSeat.sidebar`“侧边栏底栏徽标（默认）”；标记不是用户当前选择的指示。

**常驻短说明落位**（要点锚＋必备子串清单）。常驻短说明的权威文本是 client.js 词典与 two-planes 夹具对账，本表不维护逐字全文，只登记各字段 `hint.<key>` 的必备内容要点与不可省短语；字段名锚按需求 5.5 表逐字比对（中文名＝表值，毫秒字段附“（毫秒）”；en 为镜像）。子串比对按纯文本进行：词典值不含 markdown 反引号，工具名与参数名在界面文案中以普通文本形态出现，夹具断言不比较反引号。子串是 `hint.<key>` 全文对账之外的第二层，防全文改写时要点缩水；两档各查，en 档为对译短语随夹具定义。

| 键 | 常驻短说明必备要点 | 不可省子串（zh） |
| --- | --- | --- |
| `defaultYieldMs` | `async_run`／`async_workflow` 未指定 `yield_ms` 时使用；指定时按本次请求与上下限取值；到时结束本次等待、返回作业编号，后台任务继续运行 | “作业编号”“继续运行”“上下限” |
| `minYieldMs` | 限制本次 `yield_ms` 的有效值，请求低于时按下限取值；不是后台任务的最长运行时间 | “下限”“最长运行时间” |
| `maxYieldMs` | 限制本次 `yield_ms` 的有效值，请求高于时按上限取值；不是后台任务的最长运行时间 | “上限”“最长运行时间” |
| `defaultWaitMs` | 返回提示里等待调用示例使用的时长，只作演示、不等于实际生效等待；`wait_ms` 仍必填、省略时报错；不是省略参数后的备用值 | “示例”“报错”“备用值” |
| `minWaitMs` | 适用于两个等待工具的 `wait_ms`，请求低于时按下限取值；到时结束本次等待，不停止后台任务 | “下限”“不停止” |
| `maxWaitMs` | 适用于两个等待工具的 `wait_ms`，请求高于时按上限取值；到时结束本次等待，不停止后台任务 | “上限”“不停止” |
| `pollIntervalMs` | `async_wait_agent` 备用检查子代理是否仍在运行的间隔；不是待答面板刷新间隔，也不是子代理运行时限 | “备用”“刷新间隔” |
| `maxResultChars` | 单次返回保留的结果内容字符上限（正整数），超出时保留首尾并说明截断；状态与提示另计 | “截断”“另计” |
| `jobKind` | 注册命令作业用的类型名称，便于在作业列表与日志中识别；不决定命令执行方式 | “注册”“不决定” |
| `subagentProvider` | `async_agent` 创建子代理使用的后端服务；不是选择大语言模型或模型服务商 | “后端”“大语言模型” |
| `uiLang` | 控制设置表单、字段帮助与待答界面文案；跟随宿主语言或显式中英文，不改宿主全局语言 | “设置表单”“宿主全局语言” |
| `agentLang` | 控制工具描述、参数说明、提示、错误与执行规则文案；不翻译命令、问题或用户输入，不改变行为 | “工具描述”“不翻译” |
| `silentFailureGuard` | “静默失败”指命令可能未执行、却没有明显报错；开关只给条件式提醒，不保证检出或自动修复；仅本包两预设生效，默认关 | “静默失败”“条件式”“两预设” |
| `askTakeover` | 开启后由待答面板处理本包两预设根 Agent 的普通提问，关闭时保持宿主原生提问流程；到期如实告知未答、不替用户选答案；不接管权限审批或计划评审 | “到期”“权限审批” |
| `askTimeoutMs` | 从接收一批提问起计时的初始窗口，同批多题共享期限；到期如实说明未答、不代答，已答保留、之后可补答；新值不重置进行中批次 | “共享”“不替用户选答案”“补答” |
| `askExtendMs` | “增加等待时间”每点击一次给该会话未到期批次增加的时长；已到期批次不重新等待 | “未到期”“不重新等待” |
| `askUiSeat` | 侧边栏底栏徽标显示未处理数、点击展开；右下角浮窗直接显示问题；切换显示方式不改变接管开关 | “徽标”“浮窗”“接管” |

**展开区必备内容**（技术标识行之外；zh 全文按此要点撰写，en 同义镜像）：

- `defaultYieldMs`／`minYieldMs`／`maxYieldMs`：首次等待机制（等待限制占用、不终止任务；返回作业编号后 Agent 可以继续其他工作；消息与取消可提前结束等待）；**时长示例**（需求 5.5 末段）——示例标注“演示值，非当前生效值”，区分“直接取得结果”（短命令在等待内完成，直接返回输出）与“先取得作业编号、稍后读取结果”（长命令到时返回 job_id，之后用 `async_wait_job` 读取），示例明确等待时长不限制任务寿命；夹紧关系（默认值须落在上下限内，需求 5.2 跨字段）。
- `defaultWaitMs`：`wait_ms` 必填的原因（需求 2.1.1）；示例值在返回提示中的形态（`wait_ms={defaultWaitMs}` 仅为示例）；与上下限的配对。
- `minWaitMs`／`maxWaitMs`：一份预算覆盖入口检查、查询、重试与等待；到时交回控制、句柄仍有效、再次调用即可；消息提前结束同需求 2.1。
- `pollIntervalMs`：事件为主、轮询为备用的双通道；受 `pollIntervalMs ≤ maxWaitMs` 配对约束。
- `maxResultChars`：正整数（`String.length` 计量、保首尾按整数索引、三倍换算宿主的正安全整数预算）；保首尾、省略量与截断标注、提示另计（需求 2.2.3）；与输出缓冲三倍换算的关系。
- `jobKind`：注册表 kind 的辨识作用；空值非法（需求 5.2）。
- `subagentProvider`：默认 `spawn`；修剪后空值回默认；未知后端在调用时可读拒绝；不是选择大语言模型或模型服务商，模型路由按 `provider`／`model` 参数另行指定（需求 2.3.1）。
- `uiLang`／`agentLang`：两个开关独立，修改其中一个不影响另一个；auto 档只读跟随宿主语言。
- `silentFailureGuard`：三处防线（结果诊断、命令描述警示、执行纪律提示）与开关的关系；条件式提醒语义；默认关（需求 6.3）。
- `askTakeover`：接管范围（本包两预设、根 Agent、普通提问，需求 4.1）；迟到作答按通知送达。
- `askTimeoutMs`：批次共享期限；到期合成超时事实、不代答；可补答路径。
- `askExtendMs`：组级动作语义（需求 4.3）；新批次不继承延长。
- `askUiSeat`：两种方式的展开动作（需求 4.2）；徽标计数全部处理后消隐；默认值标记与需求 5.2 一致、不指示用户当前选择。

**展开区正锚**（夹具入库、两档各断言，en 为同义对译短语随夹具定义）：每字段从上列必备内容选 1–2 个不可省短语——`defaultYieldMs`＝“等待时长不限制任务寿命”“作业编号”；`minYieldMs`／`maxYieldMs`＝“提前结束”“上下限”；`defaultWaitMs`＝“仅为示例”“必填”；`minWaitMs`／`maxWaitMs`＝“一份预算”；`pollIntervalMs`＝“轮询”“配对”；`maxResultChars`＝“截断”“另计”；`jobKind`＝“空值非法”；`subagentProvider`＝“不是选择大语言模型”“可读拒绝”；`uiLang`／`agentLang`＝“跟随宿主语言”“独立”；`silentFailureGuard`＝“三处”“条件式”；`askTakeover`＝“普通提问”“迟到”；`askTimeoutMs`＝“共享”“可补答”；`askExtendMs`＝“新批次不继承”；`askUiSeat`＝“消隐”。

**三处同概念术语表**（设置页、工具描述／参数说明、返回提示共用，需求 5.5 末段）：

| 概念 | 中文 | 英文 | 用法要点 |
| --- | --- | --- | --- |
| 首次等待 | 首次等待（时长／预算）；参数名 `yield_ms` 原样 | first wait (`yield_ms`) | 三处统一用本行术语指称该机制；参数名与代码标识不译 |
| 作业编号 | 作业编号（`job_id`） | job id (`job_id`) | 首次等待到期的返回物；返回提示以“作业编号（job_id）”指称，后续经 `async_wait_job` 取回 |
| 后台任务继续运行 | 后台任务继续运行 | keeps running in the background | 三处同句式；命令与编排同用 |
| 等待不限制任务寿命 | 等待时长不限制任务寿命 | the wait duration does not limit the task's lifetime | 首次等待与单次等待同句式 |
| 等待示例值 | 等待示例值；`wait_ms` 仍必填、省略时报错 | example wait value; `wait_ms` is still required | `defaultWaitMs` 的唯一角色；返回提示中的 `wait_ms={defaultWaitMs}` 是示例 |
| 单次等待 | 单次等待 | one wait call | `minWaitMs`／`maxWaitMs` 与两个等待工具的描述 |

**模型侧术语落位**（`lib/text.js` 两档，键名与插值变量不变；`tools/check-model-text.mjs` 三层判据把关）：

- zh 档：`digest.yield`、`tool.run.*`、`tool.workflow.p2`、`param.*.yield_ms`、`note.yield.*` 等首次等待与等待相关句子使用术语表的“首次等待”“作业编号”“后台任务继续运行”表述；等待相关键的预算表述为“单次等待预算”。
- en 档：同概念镜像（first wait／job id／keeps running in the background／example wait value）。
- 数字仍从生效配置插值（需求 5.1：描述与参数说明随生效值刷新），示例值标注不冒充生效值。

## 6. 审批、静默失败与诊断

### 6.1 单次审批接线

命令解析当前 sandboxPolicy，仅在约束执行器可用时暴露提权字段。调用开始校验字段对，再经公开 approveEscalation 取得一次许可；许可返回后、注册与启动前复查取消信号，已取消时不注册、不启动并说明取消原因。随后 shell.resolve／starter 执行。

校验失败、非严格加宽、服务缺失、拒绝、取消均在进程启动前；无 executor 不给不可实现的指引。返回后的会话策略不变。沙箱标记与退出／signal marker 同时覆盖直接和后台输出路径。

### 6.2 防护签名与作用域

开关控制结果、描述与纪律三处，全部局限本包两个预设，三处判定时机不同。结果诊断在执行期按调用主体的实际预设判定，读取路径与纪律组稿同一条；非本包两预设时不产生防护内容。

描述警示是装载期静态文本：宿主工具投影按 agent 链分层解析可见工具，描述只取行上注册的静态串（经公开投影接口 `get(name, scope)` 与 `schemas(scope)` 读取），不存在按会话求值描述的机制。描述警示因此按工具行的装载组合判定：本包两份预设补丁的工具行在行配置中携带预设归属声明 `owningPreset`（值为本包预设名；行身份字段，性质同 `toolName`——非 volatile、无默认值，仅两份预设补丁文件设置，不是设置字段、不进设置表单），描述警示只出现在携带该声明的工具行；自建预设的工具行不含声明，描述警示不出现，开关不影响其描述。声明是公开挂载入口的一部分，不禁用自定义挂载；自建行显式复制声明视为显式选用防护文本。

纪律 context 注册留在宿主行，组稿时按实际预设过滤：宿主 `systemPrompt.assemble` 把组稿上下文 `{agent, scope, signal}` 传给每个 context 的 text 函数，text 现读快照开关与目标 agent 的实际预设——经 `sessions.get(agent.id)` 与 `sessionProjections.stateOf(session, 'agentPreset')` 读取，与提问接管判定的预设路径同一条。预设不等于本包两预设之一时返回空串。

组稿上下文无 agent、服务缺席、读取抛错或快照缺席一律返回空串；空段由宿主渲染层过滤，其他预设的组稿逐字不含本包内容。反向对照进入验证：开关开启时，其他预设新会话的完整组稿（sections、contexts 与工具表）与开关关闭时逐字一致。开关开启时，本包两预设的新会话包含纪律段，且随语言开关与快照现值更新。

[诊断模块](<../lib/silent-failure.js>)签名：

- 捕获形：合并重定向、子表达式、变量赋值、输出重定向之一；不含普通管道。输出 trim 为空，实际受限、未提权、存在约束执行器且开关开，产生条件式提示。
- 可见拒绝：英文 `failed to run` 与 `Access is denied` 同在，或中文 `无法运行` 与 `拒绝访问` 同在，产生附加说明，不改变权限判定或 status。中文签名没有对应实机语言环境时注明未验证。
- 两种签名因空白／文本条件互斥。它们仍有启发式误报范围，不把日志中命中锚对当成独立授权决定。

描述警告还要求提权字段已暴露。纪律段紧凑，模型语言现读；部署特有杀软纪律仅在部署事实成立时使用，不加入通用结果签名。文本不能含未注册模板占位，以免组稿抛错。

### 6.3 异常与信息出口

只 reject 的 Promise 在创建点已有处理，所有可能同步抛的接线进入 finally 清理；query promise 迟到拒绝、动态 import 失败和 timer 回调错误不能逃逸到进程级异常。

模型可控日志值做 CR／LF／TAB 转义；模型侧宿主原错单行化并裁到 500 字符，完整线索保操作者日志。生命周期诊断通过 notice 出 stderr，不能写启动 stdout。环境集合仅取宿主 collect，溢出文件路径只报告实际值。

## 7. 包生命周期与兼容

### 7.1 装载和退役

本包进入 profile 的 dependencies 与 bundles 后，官方 loader 应用宿主行和两预设声明，浏览器模块按 web client 投递。只进 bundles 不进 dependencies 的页面可见性须单独核验。

预设声明移除即退出新会话花名册，已绑定 Agent 持有 generation 引用；retired 且 users 为零才 dispose 组合树。不能把声明退役写成所有活动会话立即销毁。

jobs 注册越过生产者／控制器 fiber，owner ctx 处置或作业服务 teardown 才取消并等待结算。只卸载工具行不取消已启动工作；非合规 producer cancel 不结算会影响清理，不能宣称 OS 级无孤儿保证。

待核验对象：目标版本 `0.2.1-rc.2` 的 `@deepseek-ai/dsh-agent-preset-registry` 中 generation 退役与释放、`@deepseek-ai/dsh-jobs-local` 中 owner 释放与服务 teardown，以及 `@deepseek-ai/dsh-subagent` 中 activation 所有权清理。三类生命周期分别验证，不沿用其他版本行号或验收结论。

### 7.2 默认选择与有限补救

注册表 selectedDefault 可能继续指向已撤预设，resolve 没有自动回退。卸载前提示用户选择可用预设；如选择仍失效，给明确清选／重选指引，而不是静默改用户默认。该风险在设置页提示块与使用说明两处醒目呈现（形态见 5.4），两处内容一致。

本包若提供独立检查或清理，必须不依赖已卸载运行模块，只处理识别为本包的声明和已知残留，保存用户原内容并拒绝不确定修改。具体可预见问题先以隔离 profile 与真注册表验证；不要在真实在用实例试卸载。

安装件与开发树分离、发布来源可核对；开发链接（如 npm link）是明确的开发路径。重启仅从目标服务进程树外、确认无他人活动后进行，文档修改不要求重启。

### 7.3 版本和宿主依据

本分支的适配目标为插件 `0.2.4+dsh.0.2.1-rc.2` 与宿主 dsh `0.2.1-rc.2`；这是待实施目标，不是当前包清单、可用安装件或验收结果的声明。兼容基准与版本格式以需求 7.3 为权威；全部 `@deepseek-ai/dsh*` peer 精确声明 `0.2.1-rc.2`。配套基准为 `@deepseek-ai/cordis` `4.0.5`、`@deepseek-ai/cordis-plugin-timer` `1.1.7`、`@deepseek-ai/schemastery` `3.18.5`、zod `4.6.7`，具体依赖范围按需求维护，并检查实际解析没有混入另一代实现。旧宿主的同包支持不在本次保证范围内。

发布标识从同一包版本取得插件核心与宿主构建元数据，生成完整 Git 标签及宿主在前的 Release 标题。版本目标不构成发布授权；本次准备不创建标签、Release 或推送。

package peer 是机器可读兼容声明，版本构建元数据是显示信息，不替代依赖校验。升级时插件核心版本按发布规则递增，元数据中的宿主字段须与全部 dsh peer 的精确声明核对；不能用常规 SemVer 相等或范围匹配证明元数据一致，必须检查完整原始字符串及解析出的宿主字段。

dsh peers 覆盖 import 和服务契约（清单见需求 7.3）；叶子 schema 库放 dependencies。代码依赖集合必须包含声明，解析到宿主同一代实现。升级核对公共 API、策略 schema/fold、客户端槽位、编排和状态投递，再用行为回归；升级验收同时核对同 profile 其他插件的状态，不把本包通过推广为整个 profile 通过；不要只更改版本串使检查变绿。

版本验证使用隔离安装件：包管理器从完整标签取得包，宿主读取及装载含构建元数据的清单，管理页读回完整原始版本。发布验证把包清单版本、完整 Git 标签、Release 标题与管理页显示核对为同一发布的四方一致（格式与目标引用需求 7.3.1，不复制版本目标表）：标签与 Release 标题从同一包版本取得，标题中的宿主版本与插件核心版本须与包版本及全部 dsh peer 声明一致。将缺少元数据、宿主字段错位、标签不对应包版本、标题与包版本不一致及界面省略元数据作为反例；对不支持的宿主另测 peer 拒载。Release 发布状态单独核对，不因元数据中的宿主预览后缀自动推断插件为预发布。

## 8. 验证设计

### 8.1 分层与真实性

需求第 8 章是结果合同。离线替身、真实 cordis 接线、真实宿主模块和真实实例分层验证，分别记录版本、对象及证据能证明的范围。磁盘实体 hash 相等不证明进程内已经加载同一模块；页面截图、接口返回也都不能替代完整行为。

验证在独立会话和隔离样本中执行；不得改他人未提交内容或停止他人任务。变异在内存或包外副本运行，先确认脚本是否原地写产品文件。必要权限经正常审批，不能直接把测试会话升成全权限跳过授权。

消息／取消即时性按可观测信号至工具返回或取消收场不超过 5000 ms 的真实运行窗口核验，当次预算至少 60000 ms，以排除预算自然到期路径。受控单元测试确认信号处理后竞速及时收敛；准备阶段同样设置反例。总预算另以时钟和 2.1 的数值口径（单元装置 300 ms 调度容差、挂起查询专项 200 ms）验证，不能用这个消息响应窗口替代严格总预算测试。

### 8.2 核心矩阵

| 主题 | 装置与反例 |
| --- | --- |
| 总预算 | 假时钟及延迟／挂起查询，重试与后置查询均计预算；入口武装与屏障重试段计入；屏障至多三拍且逐拍受剩余预算约束，不为用满三拍延时；最小合法 wait_ms 的全程上界按 2.1，仅加固定调度容差；假时钟确认改变 pollIntervalMs 或实际重试次数不延长总截止；首次等待路径同口径；剩余不正不再调 wait、不再新发目录查询，退出后不再续排，主循环内在途目录查询至多一路（收敛后复查先撤轮询续排、不与在途拍叠加）；取消和消息在屏障中到达，也能切断忽略 signal 的在途查询（8.1 即时性窗口）；可靠停止证据不被机会性复查拖延；迟到成功／迟到拒绝均处置 |
| 消息 | 四入口（两等待工具与两首次等待路径）同规则；先到及等待中 user／notice／relay，本主体和他主体、目标和非目标、`queue` 与内部 `context` 对照；迟到作答专门分支不与通用唤醒重复命中；领取前不消费正文；取消与消息出口的文案按 2.5 证据分级两档核对——取消不写成消息到达，未证实状态不夹带运行断言 |
| 目标 | 合法目录、查无、不可读、注册表当前 idle、已不驻留、重新启动；入口即查状态、已停止立即返回；先到消息分支同查注册表现状、可靠停止优先于消息出口；事件与轮询双通道，轮询查注册表状态而非仅目录行消失；权威 idle 事件单独在场即结束等待（通知缺席、迟到及非目标事件对照）、不被机会性复查拖延；结算消息缺席仍能按状态退出；失败不冒称成功 |
| 命令 | 真准入在 starter 前、短结果、长句柄、显式 kill 与 wait 取消分开；执行启动即入任务清单可查；输出 schema 逐分支喂校验器；注入声明在真 cordis 核验，不假定作业编号为递增整数 |
| 工作目录 | 对照目标宿主原生工具；初始目录 A 切到 B 后，未传 `workdir` 使用 B、相对路径以 B 解析、绝对路径保留但仍先 ensure；header 仍为 A 的反例不能退回 A；同会话并发 ensure／set、B 被删除后的宿主恢复、初始目录也不可用、服务缺席／方法异常及取消分别验证；失败或取消时零作业准入、零进程启动；已启动进程不随后续目录切换改变；直读投影替换 ensure 的反例必须失败 |
| 作业结果 | 使用真实注册表，一次性 result 两终态分支、再次不重复、精确换行、空值／超长／lossy／读取失败重试、溢出文件路径交付与缺失时说明无找回落点，未做拼接的反例必须失败 |
| 子代理和路由 | `startActivation` 的 provider／label／request／signal／delivery 形状核对，`delivery:'parent'`；启动接受后立返、零前台、键集合、成对路由、白名单、继承、恢复、坏配置与服务缺席；不支持可续或路由的后端在创建前拒绝；真实 descriptor 与回执核对；不因宿主 request 支持 `outputSchema` 等字段而扩大本工具公开参数 |
| activation 生命周期 | 受控 `result` 长期未结时仍立即取得 child id；发布前取消回滚、发布后原调用 signal 取消与四类等待出口都不停止后台；返回及工具行卸载不调用 dispose；自然结算由宿主释放且父会话收到一份结果，本包不重复投递；result resolve、非正常 stopReason、迟到 reject 及诊断回调抛错均有承接、无进程级未处理拒绝；显式停止仅作用当次 activation，不误停同 id 的后续恢复，释放失败可见；以上取消与父会话投递须含目标宿主实际运行验证 |
| 编排 | 真引擎或受控替身，误用致命不被吞；停止等待不取消编排、显式 cancel 才终止（exec signal 与 run.cancel 分离）；活动四类 log；顶层四持久记录及子调度零记录；最终结果与通知；两份预设的 delegation 组内实际取得 subagents／ptcRuntime／sandboxPolicy／workingDirectory，组外不误用隔离引擎；缺服务、目录失败与无法执行受限策略分别可见失败，不自动升权或绕过沙箱 |
| 预设隔离 | 两预设真机装载（probe-preset-portability）：按目标 standard／cordis 的行集合、顺序、配置及禁用条件核对；time-context、tool-schedule、tool-plugin-market 与完整计划模式说明保留，persona 不含失效目录插值；基线功能可用、五工具按身份在场、后台创建入口唯一且非阻塞管理入口保留（probe-r26-create-preset）；其他预设工具表与提示逐项不变——validate-preset 静态比对加真机反向对照；禁用行复活与基线缺失为反例；Windows 真机运行全部装置，Linux 无环境按 8.1 记未验证、不降低要求 |
| 提问 | 开关默认关闭不接管，非本包预设、非根主体、计划评审交还原生（probe-r30-ask-takeover 的范围核对与单元对照）；假时钟精确期限，齐答／超时／取消唯一结算；延长原期限、分段计时、旧回调、新批及跨会话隔离，延长时长覆盖默认值与改后配置；组头加时按钮在场、点击后期限按 serverNow 校准刷新、已到期不复活；两位置提交、失败显示及迟到多答领取；座位默认 `sidebar`（无覆盖且接管开→徽标在场）与显式 `overlay`（同条件→浮窗在场）两步对照，显式选择保持原值、不被清洗；提交与延长按三类客户端结果表述（4.3）——未收到确认不断言未送达／未生效，延长重试前按 state 真实期限核对、不重复累加 |
| 配置页面 | 全部字段含延长字段按身份，覆盖来源逐字段可辨；下界、上界、`maxResultChars` 非整数与五条链式不等式的草稿原因显示与保存禁用，跨字段覆盖草稿与生效值组合；毫秒字段小数仍合法；卸载风险提示块在场且两语；保存原子、恢复只暂存、失败不清草稿且可见不静默；快照缺席与启动降级通告可见；只读时明确说明、控件禁用而读数仍在；生效／输入读数逐键且格式齐备（说明下换行、两标识、整数秒无小数、非整数最多两位、`< 0.01 s` 与 `—` 占位、数值只用秒文本）；保存后后续调用生效、描述就地刷新；主题与无障碍；`askUiSeat` 无覆盖时下拉显示 `sidebar`、显式 `overlay` 保留，选项序 `[sidebar, overlay]` 且默认标记在“侧边栏底栏徽标” |
| 字段帮助 | 替身渲染（two-planes）：17 字段各有问号按钮（`type="button"`、aria-label 含字段名称、`aria-expanded`／`aria-controls` 齐备）；点击展开 `region#<id>-help`、再点收起；展开内容夹具断言——`help.defaultYieldMs` 区分“直接取得结果”与“先取得作业编号、稍后读取结果”并标注“演示值，非当前生效值”（需求 5.5 末段）；开合前后模型零调用（spy `edit`／`resetField`／`save`／`mutate`）、草稿文本、读数、`dirty`／`invalid`／`saving` 不变；只读、非法草稿与保存中三态下按钮可用、说明与错误仍在（保存中＝`saving` 为 true 进程内断言渲染与开合，与只读／非法同款——真机保存窗口短、抓拍不可靠）；控件 `aria-describedby` 展开时并入帮助区 id；删 `help.<key>`／`hint.<key>` 反例＝按钮／说明行退场、键集与在场判据变红。真机视觉（独立视觉子代理，deepseek-flash）：深、浅两主题分别核验——问号常态可发现、与说明文字可区分；展开内容不裁切、不遮挡；鼠标、触屏、键盘及辅助技术可操作；只读、非法、保存中三态帮助可读；开合无副作用、不触发保存 |
| 设置文案 | two-planes 进程内夹具对账，匹配方式分三层——字段名锚＝需求 5.5 表逐字；`hint.<key>` 锚＝词典全文与夹具一致＋必备子串逐字段在场（清单见设计 5.6，纯文本比对）；`help.<key>` 展开区正锚按设计 5.6 每字段 1–2 个短语两档断言（17 字段全有锚，展开区偷懒即红）。opt 组＝`opt.askUiSeat.sidebar`／`opt.askUiSeat.overlay` 两档与需求 5.5 选项命名逐字一致（含“（默认）”标记位在 sidebar）、`opt.agentLang.en`“（默认）”标记位、`opt.uiLang.*` 三选项两档对账。负向锚两档各查——`defaultWaitMs` 相关键不得以肯定句式自述为备用值（zh“备用值”、en“fallback”只允许出现在否定表述中），`askTimeoutMs` 常驻说明含“不替用户选答案”；模型文案术语锚见语言与防护行 |
| 语言与防护 | 五工具模型文本，全部翻译键与 runtime 文本；UI 和 Agent 独立；防护三处开关及非本包预设反向对照（组稿逐字不变；自建预设挂载工具行时结果诊断不出现，工具行未显式携带归属声明时描述警示不出现）；良性捕获误报仍条件式；设置与模型文案统一术语锚——zh 档“作业编号”“首次等待”在场、“让出预算”“job_id 句柄”零残留（词典与 `lib/text.js` 锚断言） |
| 安全与诊断 | 单次正常审批一次放行、拒绝与取消零启动（probe-escalation-advertised 真机加单元反例）；返回后会话策略不变；沙箱与退出标记覆盖直接和后台输出（probe-sandbox-marker 真机）；防护三处开关与预设范围见语言与防护行；宿主原错单行化并截断、环境集合与宿主 collect 一致、诊断走 stderr 不写启动 stdout（单元装置）；等待初始化逐步注入失败——已建资源撤销、可控错误返回、无进程级未处理拒绝，提前返回后的派生 Promise 拒绝同样有承接 |
| 生命周期 | 真 loader/registry 隔离装载、声明退役与租约释放、producer／owner／service 分别 dispose、失效默认选择与指引；不据内存清空推 OS 退出结论；有限补救经隔离 profile 与真注册表核验、不依赖已卸载组件（未执行时按 8.1 记未验证） |
| 版本与客户端 | 精确 peer 与目标宿主一致，配套依赖实际解析一致，安装成功不代替行为通过；模型策略 schema／fold／采样与目标宿主核对；按目标 primitives 重核表单替身后再测真实页面、注入、设置刷新与提问 RPC 授权；仅符号在场或静态同形不标为兼容通过；未执行或跳过的目标宿主检查逐项保留未验证状态 |

### 8.3 现有检查入口的边界

[包清单](<../package.json>)定义单元、语法、预设、编码、文档、模型文本和公开范围等入口。[验证说明](<../verify/README.md>)列安全前提和每个现有脚本的覆盖；它是运行说明，不补足需求或设计正文。

真机探针按现行宿主形状维护：登录与 RPC 统一走 [RPC 通道](<../verify/_rpc.mjs>)（token 换 cookie 即用、`redirect:'manual'`、不追 Location）；设置读取与写入使用宿主行的 `settings/describe` 与 `settings/update`，命名空间 `async-tools-host`，不做多端点试写；会话驱动需要升档时用既有升档助手。宿主模块树的树根核验保持单一来源：树消费者经配置加载器或宿主解析钩子的环境变量契约取根，解析钩子自身是契约定义处、不列入消费者名单。

现有测试中的旧编号和静态字符串锚不成为当前产品权威。改模型描述、入口状态和加时字段时同步修测试；不能因为旧断言要求旧文案就降低新需求。测试数量不固定，要求有效覆盖，不把超时终止、加载失败或未运行误记为变异捕获。

## 9. 当前实施与验证状态

本分支处于 dsh `0.2.1-rc.2` 适配的开发前准备阶段。已安装目标宿主只提供静态核对对象，不代表插件已在该宿主装载、运行或完成验收。本文的目标同步也不代替后续正式设计及独立审查。

尚待实施的范围包括子代理启动与生命周期接线、有效工作目录读取与注入、两份预设基线、依赖声明，以及受影响测试、校验器和客户端替身。第 8 章矩阵还需在目标版本逐项验证；旧宿主的结果、静态研究、安装成功或符号在场都不能直接转作通过结论。

过程性问题另行维护，不在本文保存逐项修正记录，也不要求公开使用者读取维护者内部材料。本次未实施插件、未启动实例，也未授权创建标签、Release 或推送。

## 10. 增补设计

承接需求第 9 章已批准的增补，写明需求标识、机制、边界、失败处理与验证。修改已有机制时同时改原主题，不在这里保存相反的备用方案。

维护者人工定期归并第 1 至第 8 章；第 9 章仅概述实施与验证状态，过程性问题另行维护，历史由 Git 保存。

当前无未归并增补设计。
