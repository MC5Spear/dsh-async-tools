# 用户参考

[English](<user-reference.en.md>) · [中文首页](<../README.md>)

## 1. 安装身份与前提

| 项目 | 当前适用版本 |
| --- | --- |
| 插件版本 | `0.2.6+dsh.0.2.1-rc.3` |
| 精确宿主版本 | `0.2.1-rc.3` |

当前源码仓库为私有，用于 Git 访问的账号须有该仓库读取权限。未登录或无读取权限时，私有仓库可能显示404；先确认用于 Git 访问的账号权限。无权限时，联系提供安装来源的维护者，询问访问方式或可用安装件。

先选择安装来源。下面的固定提交便于复现；本包不从 npm 分发。无分支的 GitHub spec 不能选择本线适配。

插件清单的 Node.js `>=20` 是插件声明，不是宿主最低要求。宿主依赖 commander 15 要求 Node.js `>=22.12.0`，这只是已知下界，不能证明整套宿主最低版本。建议使用 Node.js 24，并让目标宿主依赖解析通过。

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#6c428de042a10f6af04a66e28fedab644184e5ad
```

要跟踪后续修改，可将命令中的 `#` 后部分改为 `adapt/dsh-0.2.1-rc.3`。该分支会移动，不等于固定版本；此处不假定存在发布标签。

GUI 的插件管理页提供安装对话框。在安装地址中填写命令里的同一个 `github:MC5Spear/dsh-async-tools#…`，不要填写浏览器页面地址。

按安装提示完成必要的重新装载，再打开页面。在插件列表中打开本包详情，应看到描述与组件行之间的设置表单。新会话的预设选择应列出 `dsh-async` 和 `dsh-async-create`；选中后，Agent 应有第 3 节六工具。

工具或设置缺席时，按 8.1 排查，不必先读内部配置清单。组合或客户端入口变更需重新装载并重新打开页面；重启前先安排活动会话收尾，从服务进程树外操作。普通设置保存无需重启。

本线面向 Windows；目标宿主上的逐项重验尚未完成。Linux 命令与单次提权未验证；macOS、远程执行没有本线验证结论。需要这些环境时，向维护者提供环境信息与使用需求；当前可选择具备验证条件的Windows部署。维护者在隔离实例补充平台验证。

## 2. 首次使用与设置

选择 `dsh-async` 进行通用编码，或选择保留插件和预设创作工具的 `dsh-async-create`。两个预设直接提供六个工具；检查、消息、显式停止继续使用宿主管理工具。它们不改写原有预设。

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless test marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=1000)
async_wait_job(job_id="<返回的job_id>", wait_ms=30000)
```

以上是 Agent 工具调用示意，不是 PowerShell 函数。短命令应直接显示 `SHORT_OK`；长命令通常先返回作业编号 `job_id`，稍后读取时显示 `LONG_DONE` 和真实退出标记。

保存原编号，继续独立工作。需要结果时再填写 `wait_ms` 有界等待，即只等待本次明确的预算；尚未完成就稍后再等，不重复执行原命令。

设置入口：插件列表 → 本包详情页 → 描述与组件行之间的表单。写入需宿主本机回环入口；非回环或只读时按页面提示切换到可写入口。编辑只产生草稿，保存才生效；恢复默认也须保存。它清除用户覆盖，改用宿主配置行的值；宿主行没有设置该字段时才使用出厂默认。离开丢弃未保存草稿。保存失败保留草稿。帮助按钮展开说明，不提交设置。

配置路径为宿主行 `config.settings.<字段>`。用户字段覆盖组合层，组合层覆盖 schema 默认；覆盖根据字段是否存在判断。工具优先使用宿主快照，缺快照时才用合法本行备用值并提示设置未接线。`toolName`、`owningPreset` 和委托行配置不属于下面的设置。

### 2.1 全部17项设置

先区分设置值与调用值。下表范围限制可保存的设置；普通非法新输入会在写入前被拒绝。已经处于损坏降级状态时，原样重存有下文所述例外。工具调用的预算则按当前 min/max 夹紧，即低于下限取下限、高于上限取上限。

下表是源码出厂默认值，不代表当前会话的生效设置。例如 `20000`、`30000` 和 `600000` 不能替代工具当前显示的预算；当前会话若配置为 `1800000`，应按实际设置和声明调用。

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

出现配置警示时，先核对警示与工具实际采用的值，不要只看“保存成功”。界面可能保留损坏的持久值，供用户修复；它不一定是工具正在采用的值。

| 情况 | 工具实际采用什么 | 用户怎样确认与处理 |
| --- | --- | --- |
| 启动时布尔值或跨字段关系损坏，进入可修复降级 | 合法的出厂默认值 | 按警示修正全部非法字段，保存后核对警示已解除、实际采用值符合预期 |
| 运行中收到非法配置 | 保持上一份合法值，不采用非法新值 | 查看拒绝原因或降级警示，修正后重新保存；普通非法新写入仍在写入前拒绝 |
| 将与损坏基线完全相同的原值原样重存 | 可能保存成功，但继续使用降级时的默认或上一合法值 | 成功不表示已修复。只有完整配置恢复合法并成功应用后才解除降级，须再次核对提示和实际采用值 |

数值或枚举 schema 损坏还可能使行装配失败，导致设置卡片不可见。请操作者查看装载日志，修正具体字段；正常合法配置保存不需要重启。

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

先区分两项检查。**路由支持预检**确认 LLM 能否解析模型与推理强度；**选择许可检查**确认当前策略是否允许显式选择。行默认触发前者，不会自动把调用变成显式选择请求。

路由支持预检在以下任一条件满足时执行：调用显式给出 `provider`、`model` 或 `reasoning_effort`；或创建行 `agentOptions` 配置了 `provider`、`model`、`reasoningEffort`。仅有 `maxTokens` 等非路由默认时不执行该预检。后端 `agentRouteDefaults` 也只在预检触发时合入。

预检按显式参数 → 行 `agentOptions` → 后端 `agentRouteDefaults` 的优先级合并，兼容父值补缺项。没有预检触发、也没有选项需要携带时，最终创建继承父配置，不额外应用后端路由默认。预检解析出的值与最终子请求携带的值不是同一份数据，不能仅凭预检成功就断言某项推理强度最终已继承；需要时核对实际子代理路由与回执。换路由并省略强度时，不沿用旧路由的不兼容值。

`agentOptions`、`agentPreset`、`allowedAgentPresets` 属于行级固定配置，不是 17 项界面设置，也不能作为任意调用键传入。

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
| `query` | string | 可选 | trim后非空搜索；与model详情冲突 |
| `target_tool` | string | 可选 | 当前会话可见的创建工具名称，含用户配置名称 |
| `page` | integer | 1 | >=1；大于1须带version |
| `page_size` | integer | 20 | 1..100 |
| `version` | string | 首页可省略 | 续页必须绑定同一筛选与目标版本 |

```text
async_list_subagent_models(query="coding", target_tool="async_agent", page_size=20)
→ 继续查询时复用返回的next对象，不自行拼接旧页。
async_list_subagent_models(provider="<准确ID>", model="<准确ID>", target_tool="async_agent")
```

返回必有mode/entries/total/version/complete/target/verdict/basis；可有page/page_size/provider/query/has_next/beyond_end/failed_providers/example/unlisted_provider/unlisted_had_routes/next。next带page/page_size/version及原provider/query/target_tool。先筛选后分页，ID字典序稳定。版本失效从第一页按相同条件重查，不能拼接新旧结果；越末页返回空页和总数，不偷偷回首页。

搜索匹配ID与显示名且忽略大小写。部分供应商失败时complete=false，total仅为取得数，不是失败部分模型数为0。允许集合中未列目录的准确ID仍可查询和列入结果，不能据目录缺席判定不支持。

## 4. 等待状态与消费式输出

### 4.1 等待结束后做什么

等待预算覆盖一次调用的全部阶段：作业快照或子代理存在检查、重试和实际等待共用同一份时间。预算到期交回控制，后台工作继续。

| 返回或现象 | 表示什么 | 下一步 |
| --- | --- | --- |
| running | 尚未取得终态；状态无法证实时，提示会明确说明 | 保留原编号，做其他工作，需要时再有界等待 |
| interrupted 或消息唤醒说明 | 主体收到可处理消息，本次等待提前结束 | 处理新消息；不要把消息到达当作等待目标完成 |
| settled | 当次不再观察到合法子代理运行 | 查看另行到达的结算消息；这不是任务成功、答案已到或永久结束的证明 |
| completed | 作业已完成执行 | 仍检查真实退出码、信号和错误内容；不等于退出码为 0 |
| killed / failed | 作业被终止或失败 | 保留原编号与错误，按具体原因处理 |
| not_found 或查询错误 | 查无与查询失败是两种情况 | 先核目录、编号和可见性；查询失败重试原编号，不重新启动同一任务 |

用户插话、可领取的通知（notice）、代理转达（relay）及本包迟到答案，都可提前结束等待。入口也检查已经到达、尚未领取的消息；排队消息留到下一轮，不打断等待。

取消等待或停止当前回合，不会终止后台命令或编排。宿主可能把取消后的工具结果改成取消错误，导致模型没有收到 job_id。此时从宿主 job_list 或完成通知找回编号，再用 async_wait_job 读取；不要重跑可能有副作用的命令。

真正停止作业时，用 job_kill 请求取消。停止子代理时，用宿主 interrupt_agent 或管理入口；需要继续原子代理对话时用 send_message。子代理停止运行与最终文本到达可能不同步，文本未到时先做独立工作，等待消息，不重复派发任务。

### 4.2 读取和保存结果

每次读取都会推进增量游标，也就是记录“已经读到哪里”。首次成功终态读取会把最终 result 合并进同次文本，只交付一次。再次读取不会重放已消费内容，所以需要保留的结果应在首次拿到时保存。读取报错时重试原编号；报错不等于输出为空。

maxResultChars 按 JS String.length 计量正文，超限时保留首尾并说明省略量。状态、丢失标记和 spill 线索不占正文预算。

先区分两类缺失：lossy 表示宿主缓冲已丢失内容；正文裁剪只是本次给模型的文本超限。再次读取不能恢复已丢失或已消费的文本。

宿主报告 spillPaths 时，结果会给出系统临时绝对路径。这些文件可能含敏感命令或结果，也可能被系统清理。需要保留时，及时在有权限的位置保存，并在分享前脱敏。没有路径时，不能假定磁盘中仍有完整副本；有路径也不证明文件始终完整或可读。

## 5. 模型目录、授权与继承

### 5.1 先查询，再选择

先进入 **DSH 的子代理设置**，开启模型选择，将允许使用的准确 `provider` / `model` 路由加入允许名单并保存。这是宿主配置，不属于本包的 17 项设置；`subagentProvider` 只选择创建后端，不能代替模型允许名单。

保存后，已有会话和新会话的后续 `async_agent` 创建都会使用当前配置，运行中的子代理不换模型。若保持模型选择关闭，调用时省略 `provider`、`model` 和 `reasoning_effort`，即可按配置默认或父继承创建；查询目录本身不会开启选择权限。

完成宿主配置后，再查询和创建：

1. 用 async_list_subagent_models 浏览或搜索，填写 target_tool 指明准备调用的创建工具。
2. 从结果中复制准确 provider、model ID。需要推理强度时，先查询模型详情，并确认目标工具接受该强度。
3. 只把创建工具接受的参数交给它。搜索词、分页和 target_tool 不属于创建参数。
4. 创建被拒时，保留目标工具条件重新查询，按真实原因处理，不改用其他入口绕过限制。

省略 target_tool 时，只有一个可识别候选才会自动采用；多候选或零候选为 unconfirmed。具名目标不可见时为 not-allowed，但仍可返回目录。

### 5.2 目录不等于使用许可

查询不创建代理、不发起模型推理，也不验证凭据或远端可用性。verdict 的 allowed / not-allowed / unconfirmed 只说明对当前目标的适用性，不是所有入口通用的授权。目录中有模型、策略允许选择、凭据有效、远端服务可用，是四件不同的事。

async_agent 使用宿主现有模型选择开关和允许名单。后续显式路由或推理强度请求在每次创建时实时读取配置，已有会话也生效，并在启动前再次确认许可。开关关闭会拒绝显式选择；全部省略仍按配置默认或父继承处理，已运行子代理不换模型。

读取失败、名单非法或启动前许可撤回时，工具按真实原因拒绝，不自动换模型。原生创建工具仍使用自己的会话策略；workflow 的 agent() 也有独立合同，不能套用本包实时规则。

## 6. 提问接管与静默失败

### 6.1 开启与作答

askTakeover 默认关闭。开启后，只接管本包两个预设根 Agent 的普通提问。计划评审、审批和其他预设继续使用宿主流程。

askUiSeat 为 sidebar 时，侧边栏底栏显示未处理数，点击展开题目；overlay 在右下角直接显示题目。面板可跳转原会话、选择答案、填写自定义回答、忽略问题或延长等待。

单选题的预设选项与自定义回答互斥；多选题可以组合。自定义内容本身是一项答案，不是其他选项的附注。初始没有任何选中项，“推荐”也不代表已经选中。

点击自定义输入框或主动输入有效文本，会选中自定义项；仅移动焦点不会选中。取消选择后可保留草稿，但未选中的草稿不会提交。清空已选自定义文本时，该项仍选中，也不会恢复旧预设选项。

没有选择，或选中了仅含空白的自定义项时，不能提交；多选题即使另选了有效预设项，也须先修正或取消空白自定义项。服务器同样校验未知选项、单多选关系及有效性。忽略是独立动作，不等于提交空答案。

### 6.2 到期与增加时间

同批题目共用初始期限。到期保留已答内容和忽略状态；未答题返回 selected=[] 及超时 custom 说明，Agent 继续处理任务，用户仍可补答。系统不会替用户选答案。

“增加等待时间”只作用于该会话点击时尚未到期的批次，在原期限上增加 askExtendMs。新批次另取初始期限，已经到期的批次不会重新进入原工具等待。

加时未收到明确确认时，先刷新面板，读回真实期限，再决定是否重试。每次成功都会累加，盲目重试可能重复加时。答案提交未收到确认时也先查看面板状态，不把无响应当作确定未送达。

### 6.3 超时后补答与送达失败

迟到答案通知自带完整题干、全部选项及说明、多选关系、实际答案或忽略状态，以及时间信息。题目信息与实际选择分开，不把全部选项冒充答案。

原会话空闲且没有本包待启动投递时，followup 开启新回合；否则 inject 把答案放到下一领取点。只有宿主接受投递之后，插件才发出唤醒信号。投递失败会显示原因，此时打开原会话直接回复。记录缺席且标为 undelivered 时也这样处理；gone 如果表示已经在别处作答，则不重投。

24 小时是惰性清扫阈值，不是自动删除时间。只有接管新批次时，才清理到期已超过 24 小时的 expired 记录。没有新批次，记录可保存更久；迟到提交本身不会仅因超过 24 小时而被拒收。

这些记录保存在内存中，不跨重启或卸载保留。未结请求会交回原生流程；已超时记录会丢失。需要保留的答案，及时写入原会话。

### 6.4 命令静默失败提示

silentFailureGuard 默认 false，仅作用于本包两个预设。开启后按条件增加结果诊断、描述警示和执行纪律。

“捕获形”指变量赋值、子表达式或重定向等把输出收起来的命令写法。受限环境可能在进程创建前让这类命令静默失败。若本应出现的输出缺失，又没有退出标记，先用无害裸调用确认是否执行，再查宿主日志。空结果不能当作成功，条件提醒也不能证明所有捕获形命令都会失败。更宽权限的重试仍须走同轮授权审批。

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

### 8.1 安装与设置不可用

| 看到什么 | 先检查什么 | 下一步 |
| --- | --- | --- |
| 工具、预设和设置都没有出现 | 宿主精确版本；不匹配时可能跳过整个 bundle | 核对第 1 节版本和安装提示；请操作者查看装载日志，并确认 profile 同时登记了本包 dependency 与 bundle |
| 有设置、没有工具 | 新会话是否选择本包两个预设之一 | 选中预设后重试；旧会话可能仍持有旧组合引用 |
| 有工具、没有设置 | 本包详情页是否打开；客户端是否已重新装载 | 重新打开页面；仍缺席时向操作者提供脱敏装载日志 |
| 设置只读或保存失败 | 是否通过宿主本机回环可写入口访问；字段是否合法 | 按页面提示切换入口或修正字段；失败草稿会保留，确认保存成功后再离开 |
| 配置降级或保存成功后仍有警示 | 第 2.1 节三态、警示和实际采用值；不要把持久显示值当作生效值 | 启动降级使用合法出厂默认，运行中非法配置保留上一合法值。同一损坏基线原样重存仍可能成功但继续降级；完整合法修复后核对警示解除。卡片缺席时由操作者查看装载日志并修正配置 |

### 8.2 停用与卸载

**移除前先改默认预设。** 默认若指向dsh-async/dsh-async-create，停用或卸载后新会话报`agent-preset/not-found`，宿主不自动清除。先在宿主设置改为可用预设。已经移除时，在宿主默认预设入口清空或重选，再建会话验证。

按宿主GUI管理dependency与bundle并按提示重载；CLI移除命令须依据对应宿主管理说明，不假造通用命令。开发链接删除不是卸载已加载模块。旧会话可继续持有组合版本引用，producer行卸载不自动取消owner作业。先用job_list核任务，对不需要的任务显式停止；重启可能终止活动进程，须先安排收尾。

命令继承宿主权限、审批、沙箱及shellEnv.collect(exec)环境键集，输出和命令自身可能含敏感信息。模型可见注册错误最多500字符并单行化，完整错误在操作者日志。检查日志时避免把令牌、cookie、密码、私有URL和秘密环境值贴入issue。

报障使用[项目issue](<https://github.com/MC5Spear/dsh-async-tools/issues>)，提供：完整插件/宿主/Node版本、OS、预设、已脱敏相关设置、最小无害复现、预期与实际状态、job_id/agent_id及时间关系、真实退出标记和脱敏日志片段。保留原任务身份便于查找，不重复运行破坏性命令。个人维护接受issue、不接受外部PR，响应和修复没有固定时限。

文档维护遵循[文档原则](<documentation-principles.md>)。
