# 用户参考

[English](<user-reference.en.md>) · [中文首页](<../README.md>)

## 1. 版本、安装与确认装载

| 项目 | 当前适用版本 |
| --- | --- |
| 插件版本 | `0.2.3+dsh.0.2.0-rc.2` |
| 精确宿主版本 | `0.2.0-rc.2` |

本版提供五工具：`async_run`、`async_wait_job`、`async_wait_agent`、`async_agent`、`async_workflow`。使用其他宿主时，应选择明确适配该宿主的插件发布件。

插件声明 Node.js `>=20`。目标宿主 CLI 依赖的 commander 15 要求 Node.js `>=22.12.0`；这只是一个依赖的下界，不是整套宿主已验证的最低版本。建议使用 Node.js 24，并按目标宿主说明准备运行环境。Linux 命令与提权、macOS 和远程环境尚缺完整验证。需要这些环境时，可通过 issue 询问对应状态和已知限制，避免直接用于重要任务。

安装地址取不到源码时，先核对仓库地址与固定提交号，再检查网络或代理；仍无法获取时，联系提供安装来源的维护者，询问可用安装件。

固定来源安装：

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#ce9852e03340c001f520ddfd13d62410c8983196
```

也可打开目标 DSH 实例的 Web 页面，在插件管理的安装框填写相同 `github:...#...` 来源。Web 地址使用该实例启动时显示的地址，不是 GitHub 页面。这是固定源码提交，不是新发布标签。本包不从 npm 分发，默认分支也不代表任意宿主适配。

安装后先看这些结果：

1. 在插件列表打开本包详情，核对完整包版本，确认描述与组件行之间有设置表单。
2. 在新建会话的预设列表找到 `dsh-async` 和 `dsh-async-create`。
3. 选择其中一个预设创建新会话，确认工具目录有上述五工具，再运行第 2 节的无害示例。

若工具、预设或设置缺席，先核对精确 DSH 版本，再看宿主装载日志中的 peer 不匹配或 bundle 跳过记录。插件管理还应显示目标 profile 同时登记了 dependency（包依赖）和 bundle（插件组合声明）；只安装包不代表组合已经加载。

组合或客户端入口改变后，需要重新装载目标实例并重新打开页面。先确认维护窗口，避免中止他人的任务。普通设置保存无需重启。

## 2. 首次使用和设置

`dsh-async` 用于通用编码；`dsh-async-create` 保留创作工具。两者禁用同步命令与原生委托创建入口，保留宿主作业、子代理检查、消息和停止工具。自行挂载本包工具不会自动移除自建预设已有的同步入口。

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print a marker", yield_ms=1000)
async_wait_job(job_id="<返回的 job_id>", wait_ms=30000)
async_agent(description="Review a small module", prompt="完整任务、输入位置和完成标准")
async_wait_agent(agent_id="<返回的 agent_id>", wait_ms=30000)
```

这是 Agent 工具调用示意，不是终端函数。`command` 内使用 PowerShell；Linux 应换用该宿主的 shell 语法。短命令应显示 `SHORT_OK`，长命令通常先返回 `job_id`，稍后读取显示 `LONG_DONE`。取得编号后可以继续独立工作；需要结果时再等待，不重复启动同一任务。子代理同样保留返回的 `agent_id`，用它等待或继续对话。

### 怎样保存设置

打开插件列表 → 本包详情页。编辑先进入草稿，选择保存才写入。恢复默认会在草稿中清除用户覆盖，仍须保存。离开页面会丢弃未保存内容。覆盖标记表示用户层存在这个字段，即使值恰好等于默认值也会显示。

保存失败时草稿还在，先读错误再重试。只读或非本机回环入口不能写入时，使用获授权的宿主本机回环管理入口，不绕过限制。

### 设置从哪里来，出错怎么办

每个字段先取 schema 默认值，再由宿主配置行、用户覆盖依次覆盖。工具执行优先读取宿主的生效快照；只有快照缺席时才用合法的工具行值，并提示设置未接线。

此版的 17 项设置直接放在 `config` 根下，都是独立的 volatile 字段，即保存后可直接更新的字段。宿主逐字段保存，界面会校验数值和字段间关系；直接编辑配置时，字段间关系可能在错误值已写入后才被发现。

| 看到的情况 | 实际处理与下一步 |
| --- | --- |
| 运行中收到非法配置 | 告警并保留上一合法快照；查看日志和生效值，修正后再保存 |
| 启动时字段间关系非法 | 使用合法默认值并保留设置修复入口；修正第 3 节的不等式关系 |
| 数值本身不符合 schema | 可能使配置行无法装配；按日志修正数值再装载 |
| 布尔值损坏 | 按关闭处理；修正为 true 或 false |
| 语言或显示位置非法 | 运行解析时校验；按第 3 节允许值修正 |

保存值和实际行为不一致时，先核对日志与生效值，不用连续重复危险命令来试设置。

## 3. 全部 17 项设置

范围是配置合法区间；毫秒数允许区间内小数。调用参数另按当前请求上下限夹紧。

| 字段 | 类型 | 默认 | 范围 | 单位 | 生效 |
| --- | --- | --- | --- | --- | --- |
| `defaultYieldMs` | number | `20000` | `1..2147483647` | ms | 下次 run/workflow 省略 yield_ms 时的首次等待 |
| `minYieldMs` | number | `1000` | `1..2147483647` | ms | 下次首次等待请求下限 |
| `maxYieldMs` | number | `600000` | `1..2147483647` | ms | 下次首次等待请求上限 |
| `defaultWaitMs` | number | `30000` | `1..2147483647` | ms | 后续等待调用的提示示例；wait_ms 仍必填 |
| `minWaitMs` | number | `250` | `1..2147483647` | ms | 下次 wait_ms 请求下限 |
| `maxWaitMs` | number | `600000` | `1..2147483647` | ms | 下次 wait_ms 请求上限 |
| `pollIntervalMs` | number | `500` | `1..2147483647` | ms | 新子代理等待的备用状态检查和存在性重试 |
| `maxResultChars` | integer | `30000` | `1..1000000` | String.length 字符 | 单次结果内容保留上限 |
| `jobKind` | string | `async-command` | 非空字符串 | 无 | 新命令作业的类型标识 |
| `subagentProvider` | string | `spawn` | 字符串；trim 后空串回 spawn | 无 | 下次创建使用的子代理后端，不是 LLM provider |
| `uiLang` | string | `auto` | auto / zh / en | 无 | 设置与待答界面；auto 跟随宿主语言 |
| `agentLang` | string | `en` | en / zh | 无 | 后续工具描述、提示、错误及模型纪律 |
| `silentFailureGuard` | boolean | `false` | true / false | 无 | 本包两预设的条件式命令描述、结果和执行提示 |
| `askTakeover` | boolean | `false` | true / false | 无 | 每次根 Agent 普通提问时判断接管 |
| `askTimeoutMs` | number | `60000` | `10000..600000` | ms | 新接管批次初始期限，不重置活动批次 |
| `askExtendMs` | number | `60000` | `1..2147483647` | ms | 每次增加等待时间时，追加到原期限 |
| `askUiSeat` | string | `sidebar` | sidebar / overlay | 无 | 侧边栏底栏徽标 / 右下角浮窗；不自动开启接管 |

必须同时满足：

- `minYieldMs <= defaultYieldMs <= maxYieldMs`。
- `minWaitMs <= defaultWaitMs <= maxWaitMs`。
- `pollIntervalMs <= maxWaitMs`。

出厂 `yield_ms` 请求夹紧区间为 `1000..600000` ms，省略使用 `20000` ms；`wait_ms` 请求夹紧区间为 `250..600000` ms。`defaultWaitMs` 只提供示例值，不能代替必填参数。两种等待到时都只交回控制，不限制后台任务寿命。已经开始的首次等待不能加时；待答面板的加时只影响提问批次。

字段旁带圈问号展开详细帮助，不改值、不保存。毫秒字段同时显示生效值与输入草稿的秒数。`uiLang` 与 `agentLang` 独立：前者管理页面，后者管理模型可见文案。

## 4. 工具参数和返回

以下参数名是工具标识符。预算参数为 number、单位 ms，按第 3 节夹紧。宿主会话可改变有效上下限，读取工具当前描述可确认生效值。

### 4.1 async_run

| 参数 | 类型 | 必填 | 默认 / 约束 |
| --- | --- | --- | --- |
| `command` | string | 是 | 实际 shell 命令 |
| `description` | string | 是 | 主动语态的 5–10 词简述 |
| `yield_ms` | number | 否 | defaultYieldMs；按 minYieldMs / maxYieldMs 夹紧 |
| `workdir` | string | 否 | 会话有效工作目录；相对路径相对该目录解析 |
| `sandbox_permissions` | string | 条件可选 | 仅约束执行器可用时声明，枚举取宿主提供模式；与 justification 一起传 |
| `justification` | string | 条件可选 | 单次加宽权限的非空理由；请求正常审批 |

单次权限重试用于刚被沙箱拒绝的同一命令；说明需要加宽的原因，经正常审批后仅对本次调用生效。不以改会话永久权限代替审批。未声明的条件参数不可强传。准入触顶或审批拒绝时不启动进程；读错误中的当前上限、作业清单，再等待或停止不需要的作业。

首次等待内完成返回 `{status, output, truncated, exit_code?, signal?, note?}`；被终止可返回 `{status, detail?, output?, truncated?}`；未结返回 `{status:"running", job_id, elapsed_ms, note}`。`completed` 不是退出码必为零，检查退出标记。`signal` 是进程终止信号。命令名称为命令原文，description 用于活动进度。

### 4.2 async_wait_job

| 参数 | 类型 | 必填 | 默认 / 约束 |
| --- | --- | --- | --- |
| `job_id` | string | 是 | async_run / async_workflow 返回的、对当前会话可见的作业编号 |
| `wait_ms` | number | 是 | 无默认；按 minWaitMs / maxWaitMs 夹紧 |

预算覆盖一次存在性快照和等待。终态返回 `{status, job_id, output, truncated, detail?}`，状态为 `completed` / `killed` / `failed`；尚在收尾的 `stopping` 不是终态。等待返回 `{status, job_id, waited_ms, note}`，例如 `running` 或 `interrupted`。终态结果在同次返回交付，按第 5 节消费。

### 4.3 async_agent

| 参数 | 类型 | 必填 | 默认 / 约束 |
| --- | --- | --- | --- |
| `description` | string | 是 | 3–5 词展示标签 |
| `prompt` | string | 是 | 完整自包含任务书，包括输入、边界和完成标准 |
| `provider` | string | 否 | 与 model 成对提供的非空 LLM 供应商 ID；均省略则继承父路由 |
| `model` | string | 否 | 与 provider 成对提供的非空准确模型 ID |

本工具只有这四个参数。创建后立即返回 `{status:"started", agent_id, note}`，没有前台模式，也不注册作业。默认 spawn 子代理看不到父对话，任务书须包含所需上下文。未知参数、后端不支持可续创建、路由不被允许时在派生前拒绝；不要等待一个失败调用产生的假句柄。

需要结果时调用 `async_wait_agent`；续聊、目录和显式停止使用宿主 `send_message`、`list_agents`、`interrupt_agent`。停止父等待不会停止子代理。

### 4.4 async_wait_agent

| 参数 | 类型 | 必填 | 默认 / 约束 |
| --- | --- | --- | --- |
| `agent_id` | string | 是 | 本主体有权等待的子代理编号 |
| `wait_ms` | number | 是 | 无默认；按 minWaitMs / maxWaitMs 夹紧 |

总预算包括关系检查、目标是否存在的检查和等待。目标暂不可见时，最多按 pollIntervalMs 间隔重试三次，重试也计入同一预算。返回 `{status, agent_id, waited_ms, note}`；查无时可返回 `{status:"not_found", agent_id, known_children}`。`running` 表示本次预算内仍观察到运行；`settled` 仅表示本次不再观察到运行，包含 idle 或不驻留，不代表任务成功或最终答案已经送达。最终答案由宿主独立消息送达，不在此返回中。

查无时核对 known_children 或宿主目录，不复制派发任务。查询失败是状态未证实，按错误重试，不当作不存在。子代理可能再次被消息启动，不把旧 settled 永久缓存为结束。

### 4.5 async_workflow

用于用户明确要求 workflow 或大规模多代理编排；一两项委托使用 async_agent。

| 参数 | 类型 | 必填 | 默认 / 约束 |
| --- | --- | --- | --- |
| `script` | string | 是 | 纯 JavaScript 函数体；允许顶层 await；结束 return 可 JSON 序列化值 |
| `meta` | object | 是 | 下表元数据；不是脚本内的 export 声明 |
| `args` | object | 否 | 脚本全局 args 原样可用；裸列表包成对象字段 |
| `yield_ms` | number | 否 | defaultYieldMs；按 minYieldMs / maxYieldMs 夹紧 |

| meta 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 简短 kebab-case 运行名 |
| `description` | string | 是 | 一行用途 |
| `whenToUse` | string | 否 | 使用条件 |
| `phases` | array<object> | 否 | 阶段声明；不自动控制顺序或路由 |
| `phases[].title` | string | 是 | 阶段精确标题 |
| `phases[].detail` | string | 否 | 阶段说明 |
| `phases[].provider` | string | 否 | 阶段预期供应商 |
| `phases[].model` | string | 否 | 阶段预期模型 |

工具 schema 允许 meta 和阶段项的额外属性；具体运行校验来自宿主引擎。不要把允许附加元数据等同于任意新钩子选项。

| 脚本入口 | 参数 / 结果和约束 |
| --- | --- |
| `agent(prompt, opts?)` | Promise；无 schema 取最终文本，有 schema 取校验对象，普通子代理失败为 null。opts 仅 schema / label / phase / provider / model；provider 与 model 可独立提供，与 async_agent 不同 |
| `schema` | 对象根 JSON Schema；支持 type / properties / required / additionalProperties / items / enum / const / oneOf。pattern、format、数值边界不可用 |
| `pipeline(items, ...stages)` | 每项独立推进，阶段收 (prev, item, index)，无跨项阶段屏障；普通阶段异常使本项为 null 并跳过后续阶段 |
| `parallel(thunks)` | 零参函数并发并等待全部；普通异常对应 null |
| `phase(title)` | 标题精确匹配 meta.phases 的 title |
| `log(message)` | 报告进度 |
| `args` | 调用传入的对象 |

坏钩子参数、未知 opts、不支持的 schema、触发总量上限等误用终止整个脚本，不降为某项 null。并发和总量限制由宿主生效配置决定。脚本没有文件系统、网络、定时器或 Node.js API；工作交给子代理，脚本只协调。

```javascript
const results = await pipeline(args.items,
  async (_prev, item) => agent(`Review this item: ${item}`, {label: "Review item"}),
  async (review, item) => ({item, review}));
return results;
```

调用时另传 `meta={"name":"review-items","description":"Review independent items"}` 和 `args={"items":["A","B"]}`。引擎须按第 8 节挂载；缺引擎时会在创建作业前拒绝。

首次等待内完成时，返回 `{status:"completed", result}`。这里的 result 是渲染后的字符串，不是脚本返回的 JSON 对象。提前交回时返回 `{status:"running", job_id, elapsed_ms, note}`，保留 job_id 并用 async_wait_job 读取。终止可返回 `{status:"killed", detail?}`；失败时查看实际错误，不重新启动同一编排来取结果。

顶层运行记录供 GUI 回放。内部子调度不写同一持久记录，但活动日志和最终结果仍可读取。

## 5. 状态、消息与消费读取

| 现象 | 含义 | 下一步 |
| --- | --- | --- |
| 首次等待或 wait_ms 到期 | 本次调用交回，未终止后台工作 | 保存句柄，继续独立工作，需要结果再有界等待 |
| interrupted / 用户插话 | 当前主体可处理消息或调用取消使等待结束 | 读 note 区分原因；处理消息，勿重启原任务 |
| queued 消息 | 下一轮领取，不打断本次等待 | 按当前目标预算继续 |
| notice / relay / 迟到答案唤醒 | 有内容待当前主体处理，不等于等待目标完成 | 处理消息并依据目标状态决定是否再等 |
| completed / killed / failed | 作业已终态，各自保留真实结局 | 读结果和退出信息，不只看 completed 标签 |
| settled | 子代理当前未观察到运行 | 等待宿主最终消息，必要时看目录；不声称成功 |
| 查询或读取失败 | 状态或结果尚未取得 | 按错误重试同一读取；不当空结果重跑任务 |

等待入口也检查已经到达而未领取的可处理消息。等待取消、停止本轮、首次窗口被打断都只结束等待；后台工作仍归宿主管理。宿主有时将被取消调用的返回换成取消错误，模型可能没收到 job_id。先用 `job_list` 或完成通知找回，再读取；有副作用的命令不要盲目重跑。真正停止作业用 `job_kill`；子代理用 `interrupt_agent`，两者均应再核收尾状态。

作业读取是消费式：本次拼接各通道增量，再把首次成功终态读取的最终 result 同次合并。后续读取不重发已消费内容。需要保留结果时及时保存到适合的用户文件。读取抛错有重试标记，不是空输出。

结果太长时，按 maxResultChars 保留首尾，标明省略量和 truncated。状态、lossy 和结局详情另计。truncated 表示给模型的内容被裁剪；lossy 表示宿主输出缓冲已经丢失部分内容，两者不能互相替代。

spill 是宿主把输出写入临时文件。此版通过命令生产者的 detail 提供找回线索，没有独立的 spillPaths 投影。只有收到实际路径时才能据此取回文件；没有路径不能推定磁盘有完整副本。临时文件可能含命令输出中的敏感信息，应及时取回、妥善保存和处理，不作为长期存储。

## 6. 模型与子代理后端

`subagentProvider` 是执行后端，默认 spawn；参数 provider 是 LLM 路由供应商，两者不同。provider/model 都省略时继承父路由；明确指定须成对、非空并满足会话策略及后端支持。

### 怎样使用显式模型选择

先从宿主模型设置和供应商资料取得准确的 provider/model ID，确认路由在允许集合内，再成对传给 `async_agent`。不指定模型时，两项都省略，继承父路由。

本版在会话创建时采样模型策略，之后不实时读取全局修改：

| 会话情况 | 采用的策略 |
| --- | --- |
| 会话已有策略投影（保存的策略状态） | 保留已有值 |
| 新子会话 | 继承父会话策略 |
| 新顶层会话 | 读取创建时的全局配置 |
| 恢复会话但没有策略 | 不用当前全局值补造创建时的采样 |

编辑或关闭全局允许集合，不会改变既有会话。要采用新全局策略，应创建新顶层会话。策略缺席或开关关闭时，显式路由被拒绝，纯继承仍可使用。允许集合为空、非法或不包含所选路由时，先修正设置，再按上述会话创建规则重试。

本包没有模型目录查询工具。准确 ID 和允许路由应从宿主模型配置及对应供应商资料取得。目录可见与执行授权、凭据有效、远端实际可调用分别判断；创建失败看路由及后端错误，不反复创建相同任务来试探。

## 7. 提问接管与静默失败

### 提问

askTakeover 默认关闭。开启后，本包两预设中根 Agent 的普通提问会出现在待答面板。计划评审、权限审批和其他预设仍走宿主原生流程。

1. 选择 sidebar 时，点击侧边栏底栏徽标展开问题；选择 overlay 时，直接在右下角浮窗作答。徽标显示未处理问题数。
2. 按题目要求单选或多选，也可输入自定义答案；没有选项时直接输入。单选会替换旧选择，多选可逐项切换。
3. 检查所选内容和自定义文本后提交。也可以忽略单题，或跳转原会话。

本版允许空选择 `selected=[]`。自定义输入为空串时不附文本，只有空格时则按原样发送；服务端没有完整答案有效性校验。因此，提交前确认答案确实表达了你的意思，不把点击提交当作内容已经检查。

同批多题共享期限。到期保留已答内容，忽略题附忽略说明，未答题返回 selected=[] 与超时 custom 说明，让 Agent 继续。系统不会替用户选择推荐项，之后仍可补答。

需要更多时间时，点击该会话组的“增加等待时间”。它把 askExtendMs 加到当时尚未到期批次的原期限，每点一次再加一次。新批不继承加时，已到期批次也不会重新进入等待。加时响应未知时，先等面板读回真实期限，避免重复累加。

迟到作答或忽略作为本包 notice 送回原主体，含题干、选项及说明、多选关系、答案/忽略和时延，自定义内容作为答案附加文本。主体空闲且无未领取本包通知时，开始新轮次（followup）；否则在下一次领取消息时并入（inject）。

通知若滞留在最后领取点之后，系统会在主体空闲时尝试发出最小提醒，让主体继续处理；提醒不重复答案正文。

### 怎样确认迟到答案送达

此版先发等待唤醒事件，再尝试投递答案。因此，“迟到答案到达”的唤醒不能单独证明送达。服务回执有 delivered / late / gone / failed；本版的服务端答案有效性校验不完整，gone 也无法区分“已经处理”与“记录缺失、没有投递”。

出现 gone、failed、补醒失败或没有收到确认时，先保留答案文本。从会话列表找到原会话，核对其中是否有答案；没有时，直接发出题目和所选内容。失败名单只有题目身份和题干，没有可靠的 sessionId 跳转。

到期超过 24 小时的 expired 批次，仅在下一次新批接管时惰性清扫。没有新批可能保留更久；迟到提交本身不按 24 小时拒收。重启或卸载会丢失内存中的到期记录；未结请求交还可用原生流程或取消。跨重启补答应直接发往原会话。

### 静默失败

silentFailureGuard 默认关闭，仅本包两预设内控制结果诊断、命令描述警示和执行纪律三处提醒。在受限、未提权、存在约束执行器的运行中，捕获形命令（重定向、子表达式、变量赋值等）出现空白结果时，可提示命令可能未执行；普通管道不因此命中。可见拒绝签名也可附诊断。

若预期输出缺失，先用不捕获的裸调用验证。核对退出标记和操作者日志，再决定正常权限重试，不能把启发式提示当作失败证明或自动重复有副作用动作。不同部署的杀毒软件规则不能互相套用。

## 8. 自建预设的完整工具组合

下列是放入自建预设 `config.plugins` 的工具组合；宿主配置行和客户端由安装 bundle 提供。它包含全部五工具及非阻塞管理入口。自建预设原有的同步 shell / 原生创建入口应按预期手动停用，否则它们仍存在。已有工作用两份内置预设更直接。

```yaml
- id: async-run
  name: dsh-async-tools
  config: { toolName: async_run }
- id: async-wait-job
  name: dsh-async-tools
  config: { toolName: async_wait_job }
- id: async-wait-agent
  name: dsh-async-tools
  config: { toolName: async_wait_agent }
- id: async-agent
  name: dsh-async-tools
  config: { toolName: async_agent }
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'
    - id: tool-subagent-list-agents
      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
    - id: workflow-ptc
      name: '@deepseek-ai/dsh-workflow-ptc'
      config: { provider: spawn }
    - id: async-workflow
      name: dsh-async-tools
      config: { toolName: async_workflow }
```

每行 toolName 选择一个工具；无 toolName 是配置角色，不自动注册命令工具。workflow 行必须与 workflow-ptc 同处隔离 delegation 组，能取得 workflowEngine。不要把编排行单独搬到组外。自建组合不自动加入本包两预设的提问接管及防护范围。

## 9. 安全、停用和故障恢复

命令使用宿主会话权限、审批、目录及 shellEnv.collect(exec) 提供的环境集合。本包不增加或移除环境键；命令可能访问网络或敏感信息。只执行获授权动作，分享日志前删去令牌、cookie、密码、敏感路径及命令参数。插件自身不收集遥测、不发起网络请求、不读写凭据、不修改宿主源码。模型侧注册错误单行化且最多 500 字符，完整原错在操作者日志。

**卸载前先改默认预设。** 默认指向 dsh-async / dsh-async-create 时停用或移除本包，会让新会话报 `agent-preset/not-found`，宿主不会自动清除该选择。

1. 在宿主设置把默认预设切换到仍可用预设，确认可以创建新会话。
2. 在宿主作业和子代理列表处理自己仍需保留或停止的工作。生产者行卸载不会自动取消 owner 作业；重启可能终止活动命令。
3. 使用宿主插件管理页停用或移除本包，并检查目标 profile 的 dependency 与 bundle 声明。开发链接的文件删除不等于已加载模块退出。
4. 组合退出新会话列表后，旧活动会话仍可能保留版本引用。需要重新装载时先确认维护窗口，不影响他人会话。
5. 已卸载且默认选择失效时，直接在宿主默认预设设置清空或重选可用项，再创建新会话；此恢复不依赖本包页面。

CLI 移除方式应使用目标宿主提供的管理说明，不猜测未核命令。提问未结批会交还原生或取消；到期记录随卸载清空。

报障前保留：完整插件版本、DSH 版本、Node 版本、系统与 shell、脱敏命令或工具参数、job_id/agent_id、状态和唤醒原因、当前设置、日志摘录。先核对原任务是否仍在运行，避免重复执行。问题与安全报告通过 [GitHub issue](https://github.com/MC5Spear/dsh-async-tools/issues) 提交，先脱敏；维护者个人维护并自行安排响应。

文档维护遵循[文档原则](<documentation-principles.md>)。
