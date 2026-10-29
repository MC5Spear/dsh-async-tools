# 用户参考

[English](<user-reference.en.md>) · [中文首页](<../README.md>)

## 1. 安装身份与前提

| 项目 | 当前适用版本 |
| --- | --- |
| 插件版本 | `0.2.7+dsh.0.2.1-rc.4` |
| 精确宿主版本 | `0.2.1-rc.4` |

安装地址取不到源码时，先核对仓库地址与固定提交号，再检查网络或代理；仍无法获取时，联系提供安装来源的维护者，询问可用安装件。

安装来源为 `github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1-rc.4`。分支会移动；需要固定来源时，将 `#` 后内容换为完整提交 `ca8f65b39b7694f9e5a2b28cca7a29bc43485ecc`。包不从 npm 分发，无分支的 GitHub spec 不能替你选择正确的宿主适配。

安装前先确认运行环境：建议 Node.js 24。插件清单的 `>=20` 只是插件声明；宿主依赖 commander 15 要求 `>=22.12.0`，也只是已知下界，不是整套宿主经验证的最低版本。确认目标宿主依赖能在所选运行时解析后，再安装。

本线面向 Windows，但目标宿主上的逐项重验尚未完成。Linux 命令与单次提权、macOS、远程执行均未验证。需要这些环境时，向维护者提供环境与使用需求，安排隔离验证后再决定部署。rc4 适配不等于所有行为已在 rc4 通过验证。

确认上述前提后，在终端安装：

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1-rc.4
```

也可以在 DSH 插件管理页打开安装对话框，将上面的 GitHub spec 填入安装地址。安装结束后，在本包详情页确认设置表单可见；再新建会话，确认可选择 `dsh-async` 和 `dsh-async-create`。选择其中一个后，Agent 应能使用本参考列出的六个工具。

若设置与工具都缺席，按以下顺序排查：

1. 核对 DSH 精确版本与本节身份表。
2. 查看宿主装载日志，确认是否因版本不匹配而跳过本包。
3. 在目标 profile 中核对本包的 dependency（安装依赖登记）与 bundle（宿主行和预设的组合声明）。两种登记不同，只有一处登记不足以确认全部入口已加载。
4. 若更改了组合或客户端入口，重新装载实例并重新打开页面。重启前先安排活动会话收尾，从服务进程树外执行。普通设置保存无需重启。

开发链接只用于明确的开发环境，稳定部署与编辑树分开。准备源码：

```powershell
git clone https://github.com/MC5Spear/dsh-async-tools.git
cd dsh-async-tools
git checkout adapt/dsh-0.2.1-rc.4
npm install
dsh plugin --profile web add <克隆目录的绝对路径>
```

链接目录须能解析匹配的宿主依赖。裸 Node 导入只能检查部分模块解析，不能证明宿主服务、工具和页面接入完整。

## 2. 首次使用与设置

选择 `dsh-async` 进行通用编码，或选择保留插件和预设创作工具的 `dsh-async-create`。两个预设直接提供六个工具；检查、消息、显式停止继续使用宿主管理工具。它们不改写原有预设。

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless test marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=1000)
async_wait_job(job_id="<返回的job_id>", wait_ms=30000)
```

上面是 Agent 工具调用示意，不是终端命令。短命令应直接显示 `SHORT_OK`；长命令在首次等待后通常返回作业编号 `job_id`。保留编号，继续独立工作；需要结果时调用 `async_wait_job`，每次显式填写 `wait_ms`。看到 `LONG_DONE` 后仍须核对退出信息，不重复执行原命令来查进度。

设置入口：插件列表 → 本包详情页 → 描述与组件行之间的表单。写入需宿主本机回环入口；非回环或只读时按页面提示切换到可写入口。编辑只产生草稿，保存才生效；恢复默认也须保存，离开丢弃未保存草稿。保存失败保留草稿。帮助按钮展开说明，不提交设置。

每个字段的“恢复默认”只在草稿中暂存清除该字段的用户覆盖，保存后才生效，不清除其他字段的覆盖。保存后重新采用宿主组合为该字段配置的值；组合也未配置时，才采用下表的出厂默认值，不是强制写入表中数值。正常合法配置下，保存后检查该字段不再显示“已覆盖”，并确认字段值符合预期。例如组合值为 `45000`、用户覆盖为 `90000`，清除覆盖并保存后恢复到 `45000`，不是 `20000`。若仍有降级警示，继续按表后的恢复说明处理；普通恢复动作不等于修好损坏配置。

高级配置写在宿主行的 `config.settings.<字段>`，不要把字段直接放在 `config` 根上。取值优先级从高到低为：用户覆盖、组合层配置、schema 默认值（配置定义中的默认值）。是否覆盖取决于用户层有没有该字段，而不是值是否等于默认值。

工具优先读取宿主发布的当前配置快照。只有快照缺席时，才使用合法的工具行备用值，并提示设置未接入。`toolName`、`owningPreset` 和委托行配置是固定的行配置，不在下面的 17 项界面设置中。

### 2.1 全部17项设置

表中“范围”表示允许保存的配置值。单次调用超出当前 min/max 时，工具把请求值调到对应边界，这叫“夹紧”。新的非法配置保存会被拒绝，不会自动改成边界值；已有损坏配置的原样重存例外见表后的恢复说明。毫秒（ms）是存储单位，1000 ms 等于 1 秒。

| 字段 | 类型 | 默认 | 范围 | 单位 | 生效 |
| --- | --- | --- | --- | --- | --- |
| `defaultYieldMs` | number | `20000` | 1..2147483647，可小数 | ms | 下次run/workflow省略yield_ms时 |
| `minYieldMs` | number | `1000` | 1..2147483647，可小数 | ms | 下次首次等待请求下限 |
| `maxYieldMs` | number | `600000` | 1..2147483647，可小数 | ms | 下次首次等待请求上限 |
| `defaultWaitMs` | number | `30000` | 1..2147483647，可小数 | ms | 等待示例基准；wait_ms仍必填 |
| `minWaitMs` | number | `250` | 1..2147483647，可小数 | ms | 下次wait请求下限 |
| `maxWaitMs` | number | `600000` | 1..2147483647，可小数 | ms | 下次wait请求上限 |
| `pollIntervalMs` | number | `500` | 1..2147483647，可小数 | ms | 新等待的状态轮询及存在检查间隔 |
| `maxResultChars` | integer | `30000` | 1..1000000 | JS String.length | 结果渲染 |
| `jobKind` | string | `async-command` | 非空 | — | 新命令作业的类型标识 |
| `subagentProvider` | string | `spawn` | 后端名；trim后空值回spawn | — | 下次子代理创建；不是LLM provider |
| `uiLang` | enum | `auto` | auto / zh / en | — | 界面；auto跟随宿主 |
| `agentLang` | enum | `en` | en / zh | — | 描述、结果和执行纪律的语言 |
| `silentFailureGuard` | boolean | `false` | true / false | — | 两预设的命令诊断与提示 |
| `askTakeover` | boolean | `false` | true / false | — | 每次普通提问请求 |
| `askTimeoutMs` | number | `60000` | 10000..600000，可小数 | ms | 新接管批次的初始期限 |
| `askExtendMs` | number | `60000` | 1..2147483647，可小数 | ms | 每次延长动作，在原期限上追加 |
| `askUiSeat` | enum | `sidebar` | sidebar / overlay | — | 待答面板位置，不重置期限 |

跨字段须满足 `minYieldMs <= defaultYieldMs <= maxYieldMs`、`minWaitMs <= defaultWaitMs <= maxWaitMs`、`pollIntervalMs <= maxWaitMs`。预算数字须有限。出厂上限是600000。`defaultWaitMs` 不补全缺失的 `wait_ms`。

**出现配置降级警示时，工具采用哪些值？** 启动时，损坏的布尔值或不满足跨字段约束的配置可进入可修复降级：表单仍显示原配置，工具改用合法出厂默认值。运行期间遇到新的非法配置，则继续使用上一份合法值；普通新非法写入在保存前被拒绝，不会替换合法配置。数值或枚举的 schema 校验失败还可能使插件行无法加载，此时先查看装载日志，修正日志指出的字段。

**保存成功不一定表示已修复。** 若把已有损坏配置原样重存，可能得到成功应答，但工具仍处于降级状态，警示和回退取值不会因此解除。这不表示可以保存其他新的非法值。

要恢复正常，先修正全部非法字段和跨字段关系，使整份配置合法，再保存。保存后检查降级警示是否解除，并核对工具描述中的实际采用值是否符合预期；不要只看保存成功或表单中的“生效”读数。若警示仍在，按警示或装载日志继续修正。正常合法设置保存无需重启。

## 3. 六工具参数与返回

参数表中的“必填”适用于每次调用。未知键不能当作任意宿主配置透传。预算取当前设置夹紧后的值。

### 3.1 async_run

| 参数 | 类型 | 必填/默认 | 规则 |
| --- | --- | --- | --- |
| `command` | string | 必填 | 执行的命令原文 |
| `description` | string | 必填 | 主动语态5—10词进度说明 |
| `yield_ms` | number | defaultYieldMs | 有限数字，夹紧至minYieldMs..maxYieldMs |
| `workdir` | string | 会话当前有效目录 | 相对路径以当前有效目录解析；启动后目录固定 |
| `sandbox_permissions` | string enum | 条件可选 | 仅有约束执行器时出现，模式取宿主工具声明 |
| `justification` | string | 与上一键一起提供 | 解释同轮刚被拒命令的一次性重试为何需要更宽权限 |

权限仍走宿主审批；不得拿更宽权限启动另一个任意任务。目录解析失败在启动前可读拒绝，不偷偷换目录。显式 workdir 准备失败的诊断保留请求值、解析路径、会话目录、失败时核实结论和修正出路；ENOENT本身不证明目录不存在。

首次等待完成返回 `{status, output, truncated, exit_code?, signal?, note?}`；`completed` 不代表退出码为0，读取退出标记。`signal` 是进程终止信号。被终止可返回 `{status:'killed', detail?, output?, truncated?}`。后台返回 `{status:'running', job_id, elapsed_ms, note}`。作业从启动时注册，不等到首次等待到期才出现。

### 3.2 async_wait_job

| 参数 | 类型 | 必填/默认 | 规则 |
| --- | --- | --- | --- |
| `job_id` | string | 必填 | 原作业的不透明编号 |
| `wait_ms` | number | 必填，无默认 | 夹紧至minWaitMs..maxWaitMs |

终态返回 `{status, job_id, output, truncated, detail?}`，终态是 completed / killed / failed；stopping仍未结。等待类返回 `{status, job_id, waited_ms, note}`。查无或不可见按错误处理；查询失败按提示重试，不重启原命令。读取消费规则见第4节。

### 3.3 async_agent

| 参数 | 类型 | 必填/默认 | 规则 |
| --- | --- | --- | --- |
| `description` | string | 必填 | 3—5词展示标签 |
| `prompt` | string | 必填 | 完整任务；spawn独立子代理看不到父对话 |
| `cwd` | string | 继承父当前有效目录 | 相对父当前目录解析；后续目录变化互不影响 |
| `provider` | string | 可选，与model成对 | 非空准确LLM供应商ID |
| `model` | string | 可选，与provider成对 | 非空准确模型ID |
| `reasoning_effort` | string | 可选 | 非空、模型支持的强度ID；可单独指定 |
| `agent_preset` | string | 条件可选 | 仅行配置allowedAgentPresets且后端支持独立预设时暴露；须在允许集合中 |

无 `run_in_background` 参数，也不等待最终答案。成功立即返回 `{status:'started', agent_id, note}`，说明实际路由来源及等待入口；拒绝不返回虚构编号。默认两预设未配置允许预设集合，因此不暴露agent_preset。继承上下文型后端的子代理可见父上下文；任务书按实际后端编写。

通常只需填写任务书。需要指定模型时，先按第 5 节查询准确 ID，再提供成对的 `provider`／`model`。`reasoning_effort` 可单独提供，但仍按最终有效模型校验。`agentOptions`、`agentPreset`、`allowedAgentPresets` 是高级组合中的固定行配置，不能当作调用参数，也不属于 17 项界面设置。

**支持预检何时运行：** 显式提供路由或推理强度，或行 `agentOptions` 中配置了 `provider`、`model`、`reasoningEffort`，都会触发创建前的支持预检。仅配置 `maxTokens` 等非路由选项不会触发。后端 `agentRouteDefaults` 只在触发预检时参与合并；显式参数覆盖行选项，行选项覆盖后端默认，缺少的路由部分由父路由补齐。允许名单检查仍只针对显式选择请求，行默认触发预检不等于显式请求。

**最终创建携带什么：** 任何一层贡献选项时，创建请求携带合并后的 `agentOptions`；没有贡献时省略它，由宿主继承父选项，不额外套用后端路由默认。支持预检临时采用的兼容父推理强度或模型默认，不会被预检结果回填到创建请求。最终子代理继承以实际请求和宿主合并为准，不能仅凭预检值推断。换路由而未指定强度时，预检不沿用旧路由不兼容的值。

### 3.4 async_wait_agent

| 参数 | 类型 | 必填/默认 | 规则 |
| --- | --- | --- | --- |
| `agent_id` | string | 必填 | 有权等待的子代理编号 |
| `wait_ms` | number | 必填，无默认 | 夹紧至minWaitMs..maxWaitMs |

返回 `{status, agent_id, waited_ms, note}`；查无返回 `{status:'not_found', agent_id, known_children}`。存在检查最多三拍pollIntervalMs重试，仍计入同一预算。settled只表示当次不再观察到运行，最终回答另以消息到达，无答案返回字段。not_found先核目录与编号；查询故障不等于查无，勿重新派发同任务。

### 3.5 async_workflow

仅在用户明确要求workflow或大规模编排时使用；一两项委托用async_agent。

| 参数 | 类型 | 必填/默认 | 规则 |
| --- | --- | --- | --- |
| `script` | string | 必填 | 纯JavaScript函数体，允许顶层await，以return返回JSON可序列化值 |
| `meta` | object | 必填 | name、description必填字符串；whenToUse可选；phases可选数组 |
| `args` | object | 可选 | 脚本内args原样可用；裸列表包在对象字段中 |
| `yield_ms` | number | defaultYieldMs | 与run同样夹紧 |

meta名称建议短kebab-case；阶段项title必填，detail/provider/model可选字符串。当前公共schema允许meta和阶段额外属性；需求中的更严格目标不等于已执行校验。script不是TypeScript或模块，不写`export const meta`。

| 脚本钩子 | 合同 |
| --- | --- |
| `agent(prompt, opts?)` | Promise；无schema返回最终文本，有schema返回校验对象；普通子代理失败为null。opts仅label/phase/provider/model/schema；provider/model可独立覆盖，不套成对规则 |
| `schema` | 对象根JSON Schema，支持type/properties/required/additionalProperties/items/enum/const/oneOf；不支持pattern/format/数值边界 |
| `pipeline(items,...stages)` | 条目独立逐阶段推进，无跨阶段全体屏障；stage(prev,item,index)普通异常将本条目置null并跳过余下阶段 |
| `parallel(thunks)` | 并发零参函数并全体await；普通异常对应null |
| `phase(title)` | 精确匹配meta阶段标题 |
| `log(message)` | 报告进度 |

坏钩子参数、未知选项（含effort/isolation/agentType）、不支持schema及触发总量/组合上限会终止整脚本，不化成局部null。并发与总量由宿主约束，无固定通用数值。脚本没有文件系统、网络、定时器或Node API；子代理执行实际工作。

```javascript
const results = await pipeline(args.items,
  async (_, item) => agent(`Review this item: ${item}`, { label: 'Review item' }));
return results.filter(value => value !== null);
```

完成返回 `{status:'completed', result}`，result是渲染后的字符串，并非直接返回JSON对象；终止返回 `{status:'killed', detail?}`，后台返回 `{status:'running', job_id, elapsed_ms, note}`。用async_wait_job读整次运行，job_kill才请求取消。缺编排引擎时可读拒绝且零作业，正确组合见第7节。

### 3.6 async_list_subagent_models

| 参数 | 类型 | 必填/默认 | 规则 |
| --- | --- | --- | --- |
| `provider` | string | 可选 | 准确供应商ID；省略可浏览供应商或跨供应商搜索 |
| `model` | string | 可选 | 必须同时有provider；准确模型详情 |
| `query` | string | 可选 | 去首尾空白后搜索；全空白视为省略，非空时与model详情冲突 |
| `target_tool` | string | 可选 | 当前会话可见的创建工具名称，含用户配置名称 |
| `page` | integer | 1 | >=1；大于1须带version |
| `page_size` | integer | 20 | 1..100 |
| `version` | string | 首页可省略 | 续页必须绑定同一筛选与目标版本 |

```text
async_list_subagent_models(query="coding", target_tool="async_agent", page_size=20)
→ 继续查询时复用返回的next对象，不自行拼接旧页。
async_list_subagent_models(provider="<准确ID>", model="<准确ID>", target_tool="async_agent")
```

结果固定包含 `mode`、`entries`、`total`、`version`、`complete`、`target`、`verdict`、`basis`。它们分别说明查询模式、本页条目、匹配数、版本、完整性、目标、适用结论和依据。其他可能字段为 `page`、`page_size`、`provider`、`query`、`has_next`、`beyond_end`、`failed_providers`、`example`、`unlisted_provider`、`unlisted_had_routes`、`next`。

需要下一页时，直接复用 `next`。它带有 `page`、`page_size`、`version`，以及本次使用的 `provider`、`query`、`target_tool`。结果先筛选后分页，同版本内按 ID 字典序稳定排列。版本失效就从第一页按相同条件重查，不拼接新旧页；超过末页会得到空页和总数，不自动回到首页。

搜索匹配 ID 与显示名，忽略大小写。部分供应商读取失败时，`complete=false`，`total` 只计算已取得的结果，不能理解成失败供应商没有模型。允许名单中的准确 ID 即使未列入目录，仍可查询和列入结果；目录缺席本身不证明模型不受支持。

## 4. 等待状态与消费式输出

先看返回状态，再决定下一步。预算到期通常返回 `running`，表示这次等待结束，后台工作没有因此停止。两个等待工具的入口查询、存在检查、重试和等待共用一份 `wait_ms`，不是每段各等一次。

等待也可能因消息提前结束。发给当前 Agent 的用户插话、可领取的通知（notice）、代理转达（relay）和本包迟到答案都会触发检查；开始前已经到达的消息同样有效。排队消息留到下一轮，不打断本次等待。收到消息只说明 Agent 有新内容可处理，不证明等待目标完成。

| 看到什么 | 怎样处理 |
| --- | --- |
| `running` 或因消息交回 | 先处理消息或独立工作，需要结果时用原编号再等待 |
| 作业 `completed` | 阅读结果并检查退出码；完成不等于退出 0 |
| 作业 `failed`／`killed` | 保留错误、信号和已有输出，再决定修正或停止 |
| 子代理 `settled` | 查看独立结算消息和最终回答，不当作成功证明 |
| 查询或读取失败 | 按错误重试原编号，不重新启动原任务 |

取消等待或停止当前回合只结束等待，不杀后台命令或编排。宿主可能把取消出口改成取消错误，模型没收到job_id时，从job_list或完成通知找回；不要直接重跑可能有副作用的命令。真正停止用job_kill；子代理通过宿主interrupt_agent/管理入口停止，通过send_message续谈。

子代理settled表示这次不再观察到运行，不代表任务成功、最终答案已到或永远不会再运行。读取独立结算消息；最终文本迟到时处理其他工作，再等待消息。目标关系与状态分别确认，查询失败不能当not_found或settled。

输出读取会推进增量游标。首次成功终态read的最终result只交付一次，并入同次文本；再次读取不重复已消费内容。读取失败按错误重试，不能当空输出。完成也需检查退出码、信号、failed/killed提示。

结果过长有两种情况。`maxResultChars` 只裁剪交给模型的正文，按 JavaScript `String.length` 计数，保留首尾并标出省略量。宿主的 `lossy` 标记则表示缓冲内容已经丢失，两者不能混为一谈。状态、丢失说明和临时文件线索不占正文预算。

宿主可能将输出写入临时文件（spill），并通过 `spillPaths` 返回系统临时目录中的绝对路径。只在有权限的环境打开这些路径，及时把必要内容保存到合适位置。输出和文件可能含敏感信息，分享前检查并脱敏。临时文件可能被清理；没有返回路径时，不要假定磁盘上有完整副本。

## 5. 模型目录、授权与继承

模型选择使用宿主现有子代理设置。后续async_agent显式路由/强度在每次创建时读取当前开关及允许名单，已有会话也生效；启动前再次确认许可。关闭开关拒绝显式选择；全部省略仍按默认/继承处理，运行中的子代理不换模型。读取失败、名单非法或许可撤回时按真实错误拒绝，不自动换模型。

查询目录不创建代理、不推理，也不验证凭据或远端可用性。verdict的allowed/not-allowed/unconfirmed是对选定目标的适用性，不是通用授权。原生创建工具仍按自己的会话策略，不能套本包实时规则；workflow的agent()也有自己的合同。

明确target_tool可避免多入口歧义。省略时仅一个可识别候选才自动采用，多或零候选为unconfirmed。具名目标不可见时为not-allowed但仍可返回目录。使用准确ID和目标接受的强度，分页/搜索参数不传给创建工具。被拒时保留目标重新查询，勿换入口绕过限制。

## 6. 提问接管与静默失败

要在待答面板回答问题，先在设置中开启 `askTakeover` 并保存；它默认关闭。开启后，仅本包两预设根 Agent 的普通提问进入面板。计划评审、审批和其他预设仍使用宿主流程。

选择 `sidebar` 时，侧边栏底栏显示未处理问题数，点击可展开；选择 `overlay` 时，问题显示在右下角。面板可以跳转原会话、作答、忽略或增加等待时间。

回答时先确认题型。单选只能选预设选项或自定义回答中的一项；多选可以组合，自定义文本也作为独立答案提交，不是附注。初始没有任何选择，“推荐”不是已选中。点击自定义输入框或输入非空白文本，会选中自定义项；仅移动键盘焦点不会选中。

取消自定义选择后，草稿可以保留，但不会提交。再次点击输入框或输入有效文本会重新选中；清空已选自定义文本不会恢复旧选择。没有选择或选中了空白自定义项时，不能提交，即使多选题还有其他已选项也一样。确实不答时使用独立的“忽略”。服务端同样校验选项和选择关系。

一次提问调用中的题目共用期限。到期保留已答和忽略状态；未答题返回 `selected=[]` 和说明超时的 `custom`，Agent 继续处理任务，不替用户选择答案。

需要更多时间时，点击该会话组的增加等待时间。它给点击时尚未到期的批次在原期限上增加 `askExtendMs`，不影响新批次，也不能使已到期批次重新等待。若未收到明确确认，先刷新并核对实际期限，再决定是否重试，避免重复累加。

到期后仍可在面板补答。迟到通知送回原会话，包含完整题干、全部选项与说明、多选关系、实际答案或忽略状态，以及时间。题目选项与实际选择分开，未选中的自定义草稿不会进入答案。

原会话空闲且没有本包待启动投递时，宿主通过 `followup` 开启回合；否则通过 `inject` 放到下一领取点。只有宿主接受投递后，本包才唤醒等待。

提交后先看确认结果。明确失败时，按显示的原因打开原会话直接回复；记录缺席且标有 `undelivered` 时也这样处理。若只是未收到确认，先等面板刷新核对，不直接断言未送达。`gone` 若表示其他客户端已经回答，不要重复提交。

24小时是惰性清扫阈值：超过到期24小时的expired记录仅在下一次新批接管时清扫，没有新批可保留更久；迟到提交自身不按24小时拒收。重启或卸载会丢内存过期记录，未结请求交回原生流程；需要保留的答案及时写入原会话。

silentFailureGuard默认false，仅本包两预设。启用后按条件提供结果诊断、描述警示和执行纪律。受限环境的捕获形命令可能在创建前静默失败；无输出、无退出标记时先用无害裸调用确认执行，查宿主日志，不把空结果当成功。不据提醒断言所有捕获都失败；更宽权限重试仍需同轮授权审批。

## 7. 高级组合

工具可独立挂入自建预设，查询可与原生查询并存；自建组合不会自动禁掉原有同步工具。每行config.toolName选工具，无toolName为宿主配置角色。workflow必须在隔离delegation组取得引擎；下例包含全部六工具，不是完整预设的其他功能清单。

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

引擎上下文还须能解析 `subagents`、`ptcRuntime`、`sandboxPolicy`、`workingDirectory` 四项宿主服务。缺少服务时，查看宿主组合和引擎装载日志，补齐合法的服务提供行。重新装载前先确认活动会话与作业已安全收尾。若引擎无法执行当前受限策略，保留真实错误；选择支持该策略的引擎与宿主条件，或停止该编排，不自动升权或绕开沙箱。

## 8. 停用、恢复与报障

**移除前先改默认预设。** 默认若指向dsh-async/dsh-async-create，停用或卸载后新会话报`agent-preset/not-found`，宿主不自动清除。先在宿主设置改为可用预设。已经移除时，在宿主默认预设入口清空或重选，再建会话验证。

停用或移除按以下顺序进行：

1. 用 `job_list` 检查自己的活动作业，完成所需读取，显式停止不需要的任务。重启可能终止活动进程，先安排收尾。
2. 按上一段更改默认预设。
3. 在宿主 GUI 管理本包的安装依赖登记（dependency）与组合声明（bundle），按页面提示重新装载。CLI 操作使用对应宿主版本的管理说明。
4. 新建会话确认可用预设正常；需要恢复时清空或重选默认预设。

删除开发链接不会卸载已经加载的模块。旧会话可能仍引用原组合版本。工具生产行（producer）与发起会话（owner）的生命周期不同，卸载工具行不会自动取消会话拥有的作业。

命令继承宿主权限、审批、沙箱及shellEnv.collect(exec)环境键集，输出和命令自身可能含敏感信息。模型可见注册错误最多500字符并单行化，完整错误在操作者日志。检查日志时避免把令牌、cookie、密码、私有URL和秘密环境值贴入issue。

报障使用[项目issue](<https://github.com/MC5Spear/dsh-async-tools/issues>)，提供：完整插件/宿主/Node版本、OS、预设、已脱敏相关设置、最小无害复现、预期与实际状态、job_id/agent_id及时间关系、真实退出标记和脱敏日志片段。保留原任务身份便于查找，不重复运行破坏性命令。个人维护接受issue、不接受外部PR，响应和修复没有固定时限。

文档维护遵循[文档原则](<documentation-principles.md>)。
