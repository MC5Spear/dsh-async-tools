# 用户参考

[English](<user-reference.en.md>) · [中文首页](<../README.md>)

## 1. 版本、安装与首次确认

| 项目 | 当前适用版本 |
| --- | --- |
| 插件版本 | `0.2.5+dsh.0.2.1-rc.2` |
| 精确宿主版本 | `0.2.1-rc.2` |

本文适用于上表版本。DSH 是加载插件、运行 Agent 的宿主应用。插件的工具和预设由 bundle（随插件加载的一组配置）一起装入；宿主版本不匹配时，可能整组都不加载。安装前先核对版本，缺少工具或设置时再按[第8节](<#8-风险停用与排障>)排查。

插件声明 Node `>=20`。宿主 CLI 依赖 commander `^15.0.0`，该依赖要求 Node `>=22.12.0`；这只证明部分依赖下界，不能据此认定整套宿主的完整最低版本。建议使用已有 CI 与实际运行依据的 Node 24 工具链。Windows 有部分隔离验证；Linux 命令与提权、macOS 和远程环境未完成验证。需要这些环境时，通过 issue 说明平台与所需功能，由维护者确认支持进度。

包不从 npm 分发。以下命令从源码仓库安装，固定提交 `97b7b27e8e66f225003dd80f85f7229b2372a3be`；对应分支 `adapt/dsh-0.2.1` 会移动，不能用分支名代替固定提交来确认安装内容。

安装地址取不到源码时，先核对仓库地址与固定提交号，再检查网络或代理；仍无法获取时，联系提供安装来源的维护者，询问可用安装件。

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#97b7b27e8e66f225003dd80f85f7229b2372a3be
```

在 DSH 界面的插件安装对话框中，也可粘贴命令中 `add` 后的完整安装地址：

```text
github:MC5Spear/dsh-async-tools#97b7b27e8e66f225003dd80f85f7229b2372a3be
```

安装完成后，按以下位置确认：

1. 在插件列表打开本包，确认完整版本与上表相同，且详情页有设置表单。
2. 新建会话，确认预设选择器中有 `dsh-async` 和 `dsh-async-create`。
3. 选择其中一个预设，确认会话工具列表包含第3节的六个工具。

`dsh-async` 用于通用编码，`dsh-async-create` 保留创作工具；插件不改变原有预设。

**开发时从已有源码目录安装**：已有对应提交的源码目录也可通过宿主安装：

```powershell
dsh plugin --profile web add <源码目录的绝对路径>
```

目录须能解析上述宿主依赖。稳定部署使用独立安装目录，不把编辑中的工作树作为安装件。安装组合或客户端入口变化需要重新装载实例并重新打开页面；重启前确认其他会话无活动，从服务进程树外操作。普通设置保存无需重启。

首次试用时，可请 Agent 运行第3节 `async_run` 中的无害示例。收到 `job_id`（作业编号）表示要保留这个编号，稍后读取，不是命令失败。正常完成长任务示例后应看到 `LONG_DONE`；退出是否成功还要看退出标记。

## 2. 设置入口、保存与恢复

打开插件列表 → dsh-async-tools 详情。表单位于描述与组件行之间，无需切换预设。写入使用宿主本机回环入口；非回环、只读或入口不可用时，先切回可写的本机管理入口，保留草稿再处理连接问题。

按以下步骤修改设置：

1. 编辑需要改变的字段。此时只改变草稿，工具仍使用原值。
2. 检查字段提示和秒数读数，再点击保存。保存成功后，后续调用使用新值；保存失败时草稿保留。
3. 需要撤销字段的用户设置时，点击恢复默认，再保存。离开页面会丢弃未保存草稿。

“覆盖”表示用户层明确保存过这个字段，即使数值恰好等于默认值也算覆盖。恢复默认移除这一层的值，之后使用宿主配置行的值；宿主也没有设置时才用出厂默认。毫秒字段同时显示当前生效值和草稿折算的秒数。点击问号可展开帮助，不会改变设置。

配置按 `schema 默认值 → 宿主行配置 → 用户覆盖` 依次覆盖。schema 是字段类型、范围和默认值的定义。手写宿主配置时，设置路径为 `config.settings.<字段>`。工具读取宿主当前生效的配置快照；快照缺席时才使用合法的本行备用值，并提示设置未接线。以下五个键用于组合配置，不属于17项可编辑设置：`toolName`、`owningPreset`、`agentOptions`、`agentPreset`、`allowedAgentPresets`。

### 设置表

| 字段 | 类型 | 默认 | 范围 | 单位 | 生效 |
| --- | --- | --- | --- | --- | --- |
| `defaultYieldMs` | number | `20000` | `[1,2147483647]`，可小数 | ms | 下次 run/workflow 省略 `yield_ms` 时 |
| `minYieldMs` | number | `1000` | `[1,2147483647]`，可小数 | ms | 下次首次等待请求下限 |
| `maxYieldMs` | number | `600000` | `[1,2147483647]`，可小数 | ms | 下次首次等待请求上限 |
| `defaultWaitMs` | number | `30000` | `[1,2147483647]`，可小数 | ms | 等待提示及示例；实际 `wait_ms` 仍必填 |
| `minWaitMs` | number | `250` | `[1,2147483647]`，可小数 | ms | 下次等待请求下限 |
| `maxWaitMs` | number | `600000` | `[1,2147483647]`，可小数 | ms | 下次等待请求上限 |
| `pollIntervalMs` | number | `500` | `[1,2147483647]`，可小数 | ms | 新等待的子代理备用状态检查及存在重试 |
| `maxResultChars` | integer | `30000` | `[1,1000000]` | JS `String.length` | 结果正文裁剪 |
| `jobKind` | string | `async-command` | 非空字符串 | — | 新命令作业的类型标识 |
| `subagentProvider` | string | `spawn` | 修剪后空串回 `spawn`；后端须已注册 | — | 下次创建；这是执行后端，不是 LLM provider |
| `uiLang` | string | `auto` | `auto` / `zh` / `en` | — | 设置和待答界面；auto 跟随宿主 |
| `agentLang` | string | `en` | `en` / `zh` | — | 选择工具描述、结果及本包执行指引的语言 |
| `silentFailureGuard` | boolean | `false` | `true` / `false` | — | 本包两预设的静默失败提示 |
| `askTakeover` | boolean | `false` | `true` / `false` | — | 每次普通提问请求 |
| `askTimeoutMs` | number | `60000` | `[10000,600000]`，可小数 | ms | 新接管批次的初始期限 |
| `askExtendMs` | number | `60000` | `[1,2147483647]`，可小数 | ms | 每次增加等待时间，追加到原期限 |
| `askUiSeat` | string | `sidebar` | `sidebar` / `overlay` | — | 侧边栏底栏徽标 / 右下角浮窗 |

所有数值必须有限，不能是 `Infinity` 或 `NaN`。除各字段范围外，还须同时满足：

- `minYieldMs <= defaultYieldMs <= maxYieldMs`
- `minWaitMs <= defaultWaitMs <= maxWaitMs`
- `pollIntervalMs <= maxWaitMs`

表中的“范围”是设置本身允许保存的范围。单次调用的等待预算另受当前 min/max 设置限制：超出时取最近边界值，这称为“夹紧”。出厂两个 max 都是 `600000`。`defaultWaitMs` 只用于提示与示例，不能让等待工具省略 `wait_ms`。

非法新设置会被拒绝。已有持久配置损坏时，按发生时机处理：

| 现象 | 实际采用的值 | 修复方法 |
| --- | --- | --- |
| 启动时布尔值或跨字段关系损坏，进入降级 | 合法出厂默认；保留设置入口 | 修改提示中的非法字段后保存；只重存同一损坏值可能收到成功应答，但不会结束降级 |
| 运行中收到非法新值 | 保持上一合法值并告警 | 修正字段后重新保存 |
| 数值类型、范围或枚举不合法，整行装配失败 | 该行无法加载，设置入口可能缺席 | 在宿主组合配置中修正类型、范围或枚举，再安全重新装载 |

## 3. 工具参数

以下调用为工具调用示意，不是 PowerShell 函数。预算单位均为毫秒。参数表列出的默认是本包出厂值；有自定义设置时按当前生效值执行。

### `async_run`

| 参数 | 类型 | 必填条件 | 默认 | 范围与含义 |
| --- | --- | --- | --- | --- |
| `command` | string | 必填 | 无 | 命令原文，作为任务名称 |
| `description` | string | 必填 | 无 | 主动语态5–10词，活动进度说明 |
| `yield_ms` | number | 可选 | `20000` | 按 `minYieldMs` / `maxYieldMs` 夹紧，出厂 `[1000,600000]` |
| `workdir` | string | 可选 | 会话当前有效目录 | 相对路径基于当前目录；绝对路径保留 |
| `sandbox_permissions` | string | 仅有约束执行器时声明；使用时与理由成对 | 无 | 取宿主声明的枚举；仅刚被拒的同命令同轮一次加宽重试 |
| `justification` | string | 与 `sandbox_permissions` 一起提供 | 无 | 非空理由，须经正常审批；许可不改变会话后续权限 |

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless test marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print a harmless marker", yield_ms=1000)
```

命令从启动起就是宿主作业，可以在任务面板查看。首次等待预算内完成时直接给结果；否则返回 `job_id`，Agent 可继续独立工作，需要结果时再等待，不重新启动命令。

工作目录解析失败、审批拒绝或并发准入失败时，不会启动进程。显式指定目录却准备失败时，错误会列出请求目录、解析后的路径、会话当前目录，以及失败时核实的结论和修正方法。先核实目录；`ENOENT` 也可能来自可执行文件缺失，不能只凭这个错误就认定目录不存在。

### `async_wait_job`

| 参数 | 类型 | 必填条件 | 默认 | 范围与含义 |
| --- | --- | --- | --- | --- |
| `job_id` | string | 必填 | 无 | 返回的作业标识符，不透明字符串 |
| `wait_ms` | number | 必填 | 无 | 当前等待上下限夹紧，出厂 `[250,600000]` |

```text
async_wait_job(job_id="<返回的job_id>", wait_ms=30000)
```

预算包括一次存在快照及等待。终态在同次返回中读取结果。`running` 后仍需要结果时可再次有界等待；查无或不可见先用宿主 `job_list` 核对 owner 与标识符。查询失败应重查，不重新执行命令。

### `async_agent`

| 参数 | 类型 | 必填条件 | 默认 | 范围与含义 |
| --- | --- | --- | --- | --- |
| `description` | string | 必填 | 无 | 3–5词任务标签 |
| `prompt` | string | 必填 | 无 | 完整任务书；独立 spawn 看不到父对话，继承型后端可见 |
| `cwd` | string | 可选 | 父代理当前有效目录 | 相对路径基于父目录；创建后两侧目录变化互不影响 |
| `provider` | string | 与 `model` 成对提供 | 配置默认或继承 | 非空准确 LLM provider ID |
| `model` | string | 与 `provider` 成对提供 | 配置默认或继承 | 非空准确 model ID |
| `reasoning_effort` | string | 可选，可单独指定 | 兼容继承或模型默认 | 非空且为有效路由支持的强度 ID |
| `agent_preset` | string | 仅行有 `allowedAgentPresets` 且后端支持独立预设、非继承父上下文时声明 | 行 `agentPreset` 或继承 | 必须属于允许集合；本包默认两预设不暴露此参数 |

```text
async_agent(description="Inspect one isolated module", prompt="Inspect the named module for the stated bug; report findings without changing files.")
```

创建只有后台方式，不接受 `run_in_background` 或等待时长参数。宿主接受启动后，工具立即返回 `started` 和 `agent_id`，Agent 可以继续其他工作。

需要结果时，用 `async_wait_agent` 等待；最终答案仍由独立消息送达。要追问或显式停止，分别用宿主 `send_message`、`interrupt_agent`。

后端未注册、不支持可续运行、不支持请求参数，或策略读取失败时，按错误提示修正配置；路由被拒时保留目标工具重新查询模型。未知参数会被拒绝，不会传给后端尝试执行。

### `async_wait_agent`

| 参数 | 类型 | 必填条件 | 默认 | 范围与含义 |
| --- | --- | --- | --- | --- |
| `agent_id` | string | 必填 | 无 | 有权等待的子代理标识符 |
| `wait_ms` | number | 必填 | 无 | 当前等待上下限夹紧，出厂 `[250,600000]` |

```text
async_wait_agent(agent_id="<返回的agent_id>", wait_ms=30000)
```

同一份预算包含存在检查和等待；存在检查最多按 `pollIntervalMs` 重试三次，不在预算外额外等候。工具先确认目标在当前 Agent 有权等待的子代理范围内，再判断是否运行。

- `running`：本次等待结束，需要结果时可再次有界等待。
- `settled`：本次不再观察到目标运行，不证明任务成功，也不证明最终答案已到。最终回答经独立消息送达。
- `not_found`：附带 `known_children`，先核对已知子代理目录和准确编号，不要为查进度重复委托。
- 查询失败：状态未证实，不等于目标不存在；按提示重查。

### `async_workflow`

仅在用户明确要求 workflow 或大规模编排时使用；一两个委托用 `async_agent`。

| 参数 | 类型 | 必填条件 | 默认 | 范围与含义 |
| --- | --- | --- | --- | --- |
| `script` | string | 必填 | 无 | 纯 JavaScript 函数体，可顶层 await，以 return 返回 JSON 可序列化值 |
| `meta` | object | 必填 | 无 | 元数据对象，见下表 |
| `args` | object | 可选 | 无 | 脚本全局 args；裸列表包成对象字段 |
| `yield_ms` | number | 可选 | `20000` | 首次等待夹紧，出厂 `[1000,600000]` |

| 参数 | 类型 | 必填条件 | 默认 | 范围与含义 |
| --- | --- | --- | --- | --- |
| `meta.name` | string | 必填 | 无 | 短 kebab-case 展示名；名称说明不是正则校验承诺 |
| `meta.description` | string | 必填 | 无 | 一行用途 |
| `meta.whenToUse` | string | 可选 | 无 | 使用条件 |
| `meta.phases` | array<object> | 可选 | 无 | 阶段声明 |
| `meta.phases[].title` | string | 有阶段项时必填 | 无 | phase 精确匹配的标题 |
| `meta.phases[].detail` | string | 可选 | 无 | 阶段说明 |
| `meta.phases[].provider` | string | 可选 | 无 | 阶段 LLM 路由覆盖 |
| `meta.phases[].model` | string | 可选 | 无 | 阶段模型覆盖 |

当前工具 schema 允许 meta 和阶段项的额外属性；引擎仍按自己的契约校验运行。不在 script 中写 TypeScript、`export const meta` 或重新声明元数据参数。

```text
async_workflow(meta={name:"review-modules", description:"Review independently selected modules"},
  args={items:["module-a","module-b"]},
  script="return await pipeline(args.items, (_, item) => agent('Review ' + item));")
```

脚本钩子：

| 钩子 | 参数及结果 |
| --- | --- |
| `agent(prompt, opts?)` | Promise；无 schema 取最终文本，有 schema 取校验对象，普通子代理失败为 null。opts 仅 `label`、`phase`、`provider`、`model`、`schema`；两个路由覆盖可分别传 |
| `opts.schema` | 对象根 JSON Schema；支持 `type`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`const`、`oneOf`；不支持 pattern、format、数值边界。宿主允许的无约束注解不增加校验条件 |
| `pipeline(items, ...stages)` | 条目独立流过阶段，无跨条目阶段屏障；阶段 `(prev,item,index)`；普通异常使该条目 null 并跳过余下阶段 |
| `parallel(thunks)` | 并发零参函数，等待全部；普通异常对应 null |
| `phase(title)` | 按 meta 阶段标题精确匹配，声明本身不自动排序或更改路由 |
| `log(message)` | 报告进度 |

先区分普通任务失败和脚本误用。表中的普通失败只让对应结果变为 `null`，其他条目可继续；以下误用则终止整个脚本，`pipeline`、`parallel` 也不能把它变成局部 `null`：

- 钩子参数不合法，或使用未知选项，例如 `effort`、`isolation`、`agentType`。
- 使用不支持的 schema。
- 超过宿主配置的总量上限。

并发与总量限制由宿主管理，没有适用于所有部署的固定数值。脚本只能协调，不能直接使用文件系统、网络、计时器或 Node API；具体工作交给子代理。缺少编排引擎时，调用会被拒绝，不创建作业；可用组合见第7节。

### `async_list_subagent_models`

| 参数 | 类型 | 必填条件 | 默认 | 范围与含义 |
| --- | --- | --- | --- | --- |
| `provider` | string | 可选；有 model 时必填 | 无 | 非空准确供应商 ID |
| `model` | string | 可选；须有 provider | 无 | 非空准确模型 ID；与非空 query 冲突 |
| `query` | string | 可选 | 无 | 修剪空白、忽略大小写，按 ID 或显示名包含匹配；纯空白视为未提供 |
| `target_tool` | string | 可选 | 唯一可识别创建工具，若有 | 非空可见工具名称；多目标或无目标时适用性未确认 |
| `page` | integer | 可选 | `1` | `>=1`；大于1须有 version |
| `page_size` | integer | 可选 | `20` | `[1,100]`，非法拒绝 |
| `version` | string | page>1 时必填 | 无 | 非空上一页不透明版本令牌 |

```text
async_list_subagent_models(target_tool="async_agent")
async_list_subagent_models(query="<名称片段>", target_tool="async_agent", page_size=20)
async_list_subagent_models(provider="<准确ID>", model="<准确ID>", target_tool="async_agent")
```

按需要选择查询方式：

- 不填 `provider` 和 `query`：浏览供应商。
- 填 `provider`：浏览该供应商的模型。
- 填 `query`：搜索名称或 ID；可同时填 `provider` 限定供应商。供应商的 ID 或名称命中时，其模型整组参与结果。
- 成对填 `provider`、`model`：查看准确模型详情和推理强度选项。

结果先筛选，再按 ID 字典序分页。需要下一页时，直接复用返回的 `next` 参数，其中包含原筛选、目标、`page_size`、`version` 和下一页码。版本失效时，保持筛选条件从第1页重查，不拼接新旧版本。越过末页会返回空页、总数和重查指引。

## 4. 状态、结果读取与停止

| 返回形态 | 含义与下一步 |
| --- | --- |
| run `completed` | `output`、`truncated`，可含 `exit_code`、`signal`、`note`。completed 不等于退出码0，读退出标记；signal 是进程终止信号 |
| run `killed` | 可含 `detail`、`output`、`truncated`；按终止原因处置 |
| run/workflow `running` | `job_id`、`elapsed_ms`、`note`；首次等待结束，按句柄读取 |
| wait_job `completed` / `killed` / `failed` | `job_id`、`output`、`truncated`，可含 detail；同次交付读取内容 |
| wait_job 非终态 | `status`、`job_id`、`waited_ms`、`note`；stopping 也未终态 |
| wait_agent | `status`、`agent_id`、`waited_ms`、`note`；not_found 为 `status`、`agent_id`、`known_children`；没有最终答案字段 |
| agent `started` | `agent_id`、`note`；只证明启动接受 |
| workflow `completed` | `result` 是渲染后的字符串，不是直接 JSON 对象；killed 可含 detail |
| list | 必有 `mode`、`entries`、`total`、`version`、`complete`、`target`、`verdict`、`basis`；按模式可含 `page`、`page_size`、`provider`、`query`、`has_next`、`beyond_end`、`failed_providers`、`example`、`unlisted_provider`、`unlisted_had_routes`、`next` |

等待到期时会返回 `running`，但任务不会因此停止。插话、通知（`notice`）、代理转达（`relay`）或迟到答案到达当前 Agent 时，也可能提前结束等待；开始等待前已经到达、尚未领取的消息同样会被检查。排队到下一轮的消息不打断等待。收到消息只说明 Agent 有新内容要处理，不能据此判断等待目标已经完成。

取消等待或停止本轮也只结束等待。宿主可能把本次工具返回替换为取消错误，导致 `job_id` 没有送达。此时先用 `job_list` 或完成通知找回编号，再读取原作业，不要重新启动有副作用的命令。

**成功读过的内容不能重新领取。** 作业按增量读取：每次成功读取只交付尚未读过的输出，并推进读取位置。最终 `result` 只在首次成功读取终态时交付一次，接在本次增量之后。需要保存的内容请及时复制；读取失败时按提示重试原编号，不把读失败当空输出。

以下三种结果提示要分别处理：

| 提示 | 含义 | 下一步 |
| --- | --- | --- |
| `truncated` | 本次正文超过 `maxResultChars`，仅保留首尾 | 查看裁剪说明，确认所需内容是否被省略；状态和诊断文字不占正文预算 |
| `lossy` | 较早的输出已经丢失，不只是本次显示被裁剪 | 不把当前文本当作完整记录；检查是否另有 spill 路径 |
| `spillPaths` | 宿主报告了保存溢出输出的临时文件绝对路径 | 文件可能含秘密。尽快复制到安全位置，核实文件仍存在且内容完整，分享前脱敏 |

没有报告路径时，不要假定磁盘上还有完整副本。

显式终止命令或编排用宿主 `job_kill`，停止子代理用宿主管理入口。先核 owner、准确标识符与是否仍需要结果。作业属于发起会话，卸载工具行不自动取消 owner 作业；重启可能终止活动进程。

## 5. 模型选择与查询授权

需要指定模型时，按以下顺序操作：

1. 在 dsh 子代理设置中开启模型选择，并保存允许使用的路由。路由是 `provider` 与 `model` 这一对准确 ID。
2. 用 `async_list_subagent_models(target_tool="async_agent")` 浏览或搜索，查看该目标是否允许选择所需路由。
3. 创建时把准确 `provider`、`model` 成对传给 `async_agent`。需要推理强度时，再填该模型支持的 `reasoning_effort`。

每次显式请求模型或推理强度时，`async_agent` 都实时读取当前策略。保存后，已有会话的下次创建也使用新策略；运行中的子代理不换模型。关闭开关会拒绝显式选择。全部省略时使用配置默认或父代理继承，不因允许名单变化而拒绝这条默认路径。

省略参数时，默认值按以下条件参与：

- 显式请求路由或推理强度，或者工具行配置了路由类默认时，会先预检（创建前确认路由和模型支持情况）。只有这些情况才合入后端路由默认。
- 合入时，工具行 `agentOptions` 覆盖后端默认，显式参数再覆盖工具行值。没有触发预检、也没有携带值时，继承父路由。
- 更换路由时不沿用不兼容的推理强度。预检使用的强度值与最终创建请求是两个阶段；不能把预检补出的值直接当作子代理最终继承的值。最终创建仍由宿主按请求和父值解析。

查询结果中的 `allowed`、`not-allowed`、`unconfirmed` 分别表示对所选目标允许、不允许或尚未确认。**目录能列出模型，不等于有权使用，也不证明凭据有效或远端服务可用。** 具名但不可见的目标会是 `not-allowed`，仍可能返回目录信息。查询不创建子代理，也不发送推理请求。

原生创建工具按自己的会话策略判断，可能与当前全局名单不同。`async_workflow` 的 `agent()` 钩子也不自动采用 `async_agent` 的参数和实时策略。创建时只填目标接受的准确 ID 等参数，不把 `query`、分页或 `target_tool` 传给创建工具。被拒绝后，保留目标重新查询，不自动换模型或工具绕过限制。

允许名单中的准确 ID 即使未被目录列出，也可加入浏览和搜索，并标明来源，不编造显示名称。部分供应商读取失败时，`complete=false`，`total` 只表示已取得的数量，不能理解成全量或失败供应商有零模型。修复供应商配置后重新查询。

## 6. 提问接管与静默失败

`askTakeover` 默认关。开启后仅本包两预设根 Agent 的普通提问进入待答面板；计划评审、审批和其他预设仍走原生。sidebar 显示底栏未处理数，点击展开；overlay 直接显示右下角问题。可作答、忽略、跳转所属会话和增加等待时间。

**选择并提交答案**：问题初始没有选中项，推荐标记也不是已选答案。按题型操作：

- 单选：预设选项与自定义回答只能选一个。
- 多选：可同时选预设选项和自定义回答，编辑自定义文本不会取消其他已选项。
- 点击自定义输入框或输入有效文本，会选中自定义回答。仅用键盘移动焦点不会选择它。
- 取消自定义选择后，文本可作为草稿保留，但不会提交。清空仍被选中的自定义文本会阻止提交，即使多选题还有其他答案；请填写文本或取消该项。
- 不想回答时，单独选择忽略，无需先填有效答案。服务端也会拒绝未知选项、违反单多选关系、空答案或空白自定义内容。

**需要更多时间**：同一次提问调用中的多题是一批，共用初始期限。点击“增加等待时间”，会给该会话当时未到期的批次，在原期限上追加 `askExtendMs`。每次点击都会累加；没有收到确认时，先等待面板读回真实期限，不要立即重试。新批次使用自己的初始窗口，已到期批次不会重新进入原调用等待。

**到期后补答**：已答内容保留；未答题向 Agent 返回 `selected=[]` 和超时 `custom` 说明，Agent 继续任务，不代选答案。你仍可在面板补答。迟到通知包含完整题干、选项及说明、多选关系、实际答案或忽略状态和时延，Agent 无需靠记忆猜答案。

迟到答案先投递，再唤醒。Agent 空闲且没有本包待领通知时，用 `followup` 开始一轮；其他情况用 `inject` 放到下一消息领取点。只有宿主接受投递后才发出唤醒。

**记录何时消失**：已到期超过24小时的记录，只在下一次新批接管时才清理，这称为惰性清扫。没有新批时可能保留更久，迟到提交本身不会因超过24小时直接被拒。记录只在内存中，不跨重启或卸载保留；卸载时未结请求交还原生流程。

**确认答案是否送达**：看到 `failed`、带 `undelivered` 的 `gone`，或丢失通知名单时，打开所属会话直接回复答案。已在别处回答的题只显示 `gone`。没有收到 RPC（界面向宿主发出的请求）确认时，结果尚未确定；先等状态刷新，不把连接中断直接当作未送达。

`silentFailureGuard` 默认关，仅两预设内提供结果提示、描述警示和纪律。在受限执行器、未提权、捕获形命令出现空白输出时，若预期内容缺失，先裸调用无害等价命令确认是否执行；普通管道不属于捕获形。拒绝签名提示只是诊断，不能代替宿主审批。不能用重复执行危险命令来判断空输出；先查任务状态、退出标记和日志。

## 7. 高级组合

工具可独立挂载，查询可与原生查询共存。每行 `config.toolName` 选一个工具，无该键为不注册工具的宿主配置角色。自建组合不会自动禁用已有同步工具。以下是六工具完整挂载；编排必须在隔离 delegation 组内，同时有引擎提供行：

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
- id: async-list-subagent-models
  name: dsh-async-tools
  config: { toolName: async_list_subagent_models }
- id: delegation
  name: cordis:group
  group: true
  isolate: { workflowEngine: true }
  config:
    - id: workflow-ptc
      name: '@deepseek-ai/dsh-workflow-ptc'
      config: { provider: spawn }
    - id: async-workflow
      name: dsh-async-tools
      config: { toolName: async_workflow }
```

引擎还须能解析 subagents、ptcRuntime、sandboxPolicy、workingDirectory。引擎无法执行当前受限策略时按真实错误拒绝，不自动升权或换无沙箱引擎。组合及客户端入口变动需要安全地重新装载；普通设置保存不需要。

## 8. 风险、停用与排障

运行命令前，确认命令在当前权限和沙箱内可以做什么。命令使用宿主提供的环境键集，可能访问网络或秘密；本包不会自行收集遥测或读写凭据，模型目录访问交给宿主接口及适配器。

分享结果或报障前，先脱敏环境、命令、spill 路径和日志。提供插件、宿主、Node版本，所选预设、工具参数、`job_id` 或 `agent_id`，以及真实状态、退出标记和必要日志片段。不要提交令牌、cookie、密码或带 token 的 URL。模型看到的宿主错误会合成单行，最多500字符；需要完整原因时，由操作者查看 stderr 日志后提供脱敏片段。

**默认预设为 `dsh-async` / `dsh-async-create` 时，停用或卸载会使新会话出现 `agent-preset/not-found`，宿主不会自动清除此选择。**

1. 卸载前在宿主设置把默认预设切到可用预设。
2. 收取需要的作业结果，显式停止不再需要的自有任务。
3. 通过宿主 GUI 管理 dependency 与 bundle；按该宿主提示完成重新装载。开发链接还需移除 bundle 声明，删除联接不等于卸载内存模块。
4. 已卸载而新会话报错时，直接在宿主默认预设入口清空或重选可用预设，不依赖本插件设置页。
5. 旧活动组合可能继续持有版本引用，owner作业也可能继续。需要重启时先核所有活动会话，从进程树外操作，不把重启当无风险清理。

按看到的现象排查，不要先重复运行任务或重启实例：

| 现象 | 先检查 | 接着处理 |
| --- | --- | --- |
| 工具、预设和设置全都缺席 | 对照第1节核插件完整版本和精确宿主版本 | 在宿主插件管理中检查 dependencies（已安装依赖）与 bundles（加载的配置包），再查装载日志；不要放宽 peer 版本要求强行加载 |
| 只有工具缺席 | 当前会话是否选择了异步预设，bundle 是否已加载 | 选择正确预设后新建会话；自建组合对照第7节逐行检查 |
| 只有设置表单缺席 | 本包宿主配置行是否加载、客户端入口是否成功装载 | 查看客户端装载日志；组合或客户端入口有变化时，按安全维护步骤重新装载并重新打开页面 |
| 设置保存失败 | 是否使用可写的本机回环入口；字段范围和跨字段关系是否有效 | 保留草稿，修复连接或字段后重试；配置降级按第2节处理 |
| 长任务没有结果，或原编号查不到 | 用 `job_list` 核对发起会话（owner）、编号和状态 | 按原编号读取，查询失败就重查；不要重新执行有副作用命令 |
| 答案未确认送达 | 面板刷新后的状态及所属会话 | 按第6节处理；明确未送达时到原会话直接回复 |

不认识的配置项或残留 OS 进程，应在宿主设置和系统进程管理中逐项确认。不要批量清除无关配置或停止他人任务。

文档维护遵循[文档原则](<documentation-principles.md>)。
