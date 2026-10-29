# 用户参考

[English](<user-reference.en.md>) · [中文首页](<../README.md>)

## 1. 安装身份与前提

本准备线尚未适配dsh `0.2.2-alpha.2`，不能按alpha安装。下面仅说明rc4源码仓来源的现行合同；alpha版本、Node、toolSet及Git Bash目标仍待实施。

| 项目 | 当前适用版本 |
| --- | --- |
| 插件版本 | `0.2.7+dsh.0.2.1-rc.4` |
| 精确宿主版本 | `0.2.1-rc.4` |

当前源码仓库为私有，用于 Git 访问的账号须有该仓库读取权限。未登录或无读取权限时，私有仓库可能显示404；先确认用于 Git 访问的账号权限。无权限时，联系提供安装来源的维护者，询问访问方式或可用安装件。

安装前确认 DSH 精确版本与上表相同，并核对 Node 条件：插件声明的 `>=20` 不是整套宿主的最低要求。宿主依赖 commander 15 要求 Node.js `>=22.12.0`，这只是已知下界。建议使用 Node.js 24，还须让目标宿主的全部依赖解析通过。

下面固定 rc4 提交。`#adapt/dsh-0.2.1-rc.4` 会跟随分支移动；需要复现时使用完整提交。包不从 npm 分发，不用无分支 GitHub spec 选择宿主适配。

本线面向 Windows，但目标宿主的逐项重验尚未完成。Linux 命令与单次提权、macOS 和远程执行尚未验证。安装前应据此决定是否先在隔离实例试用；需要其他平台时，向维护者提供环境与用途，安排对应平台验证。

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#ca8f65b39b7694f9e5a2b28cca7a29bc43485ecc
```

也可打开 DSH Web 插件管理页，在安装对话框的安装地址栏填写命令中 `add` 后的完整地址。安装并按宿主提示重新装载后，插件列表应出现本包；详情页的描述与组件行之间应出现设置表单。新建会话应能选择两个异步预设，无需手工创建目录。

选择异步预设后，六工具应可直接调用。工具和设置缺席时，按第 8 节排障。组合或客户端入口变化需重新装载实例并重新打开页面；重启前先安排其他活动会话收尾，并从服务进程树外执行。普通设置保存无需重启。

## 2. 首次使用与设置

选择 `dsh-async` 进行通用编码，或选择保留插件和预设创作工具的 `dsh-async-create`。两个预设直接提供六个工具；检查、消息、显式停止继续使用宿主管理工具。它们不改写原有预设。

下面是 Agent 工具调用示意，不是终端命令。短命令通常直接返回结果；长命令示例将首次等待设为 1 秒，未完成时返回作业编号。

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless test marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=1000)
async_wait_job(job_id="<返回的job_id>", wait_ms=30000)
```

拿到 `job_id`（作业编号）后继续独立工作。需要结果时，用原编号调用 `async_wait_job`，显式填写本次愿意等待的毫秒数。等待结束不停止任务；不要重复执行原命令。

设置入口：插件列表 → 本包详情页 → 描述与组件行之间的表单。写入需宿主本机回环入口；非回环或只读时按页面提示切换到可写入口。编辑只产生草稿，保存才生效；恢复默认也须保存，离开丢弃未保存草稿。保存失败保留草稿。帮助按钮展开说明，不提交设置。

每个字段旁的“恢复默认”只在草稿中暂存清除这个字段的用户覆盖，点击“保存”后才生效，不会清除其他字段的覆盖。保存后，这个字段重新采用组合或宿主配置中的值；那里也未配置时，才使用下表的出厂默认值。“恢复默认”不是强制把下表数值写进配置。

字段的“已覆盖”标记表示存在用户覆盖。正常合法配置下，恢复并保存后，应看到该字段不再标为“已覆盖”，并核对字段读数是否回到组合配置值或出厂默认值。若当前处于降级，普通恢复动作不保证修复损坏配置；表单读数也不能单独证明工具实际采用值，请继续按本节末尾的降级修复说明确认。

配置路径为宿主行 `config.settings.<字段>`。用户字段覆盖组合层，组合层覆盖 schema 默认；覆盖根据字段是否存在判断。工具优先使用宿主快照，缺快照时才用合法本行备用值并提示设置未接线。`toolName`、`owningPreset` 和委托行配置不属于下面的设置。

### 2.1 全部17项设置

表中的范围约束可保存的设置值。工具调用的等待时长则按当前下限和上限调整：低于下限取下限，高于上限取上限，这称为“夹紧”。保存非法设置会被拒绝，不会自动改成边界值。

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

配置损坏时，先按页面提示和装载日志找到要修复的字段。启动时，损坏的布尔值或跨字段关系可以使插件进入降级模式：设置表单保留原始值供修复，工具按合法出厂默认值运行，并给出降级警示。非法数值或枚举值也可能使配置行无法加载，设置卡片缺席。运行期间收到非法配置时，工具保留上一组合法生效值，不改用出厂默认或表单里的非法值；新提交的非法值会在写入前被拒绝。

如果表单已经显示降级，直接原样点击“保存”可能成功：只有与进入降级时那组损坏配置完全相同的原值可以这样重存，降级并不会因此解除。这不表示任意非法值都能保存；例如只改另一个合法字段，却留下原来的非法关系，仍会被拒绝。

修复时，将整组配置中的非法字段和关系改正，再保存。不要只看保存成功回执：还要确认已有的降级提示已解除，并从工具当前描述或返回说明中的生效值核对结果，例如实际等待上下限是否符合修正后的设置。仍有警示或采用值不符时，按警示与装载日志继续处理；普通合法设置保存无需重启。

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

路由决定子代理使用哪个供应商和模型。省略路由字段时使用配置默认或继承，但“支持预检”和“最终创建”是两个步骤：

1. 显式填写 `provider`、`model`、`reasoning_effort` 中任一字段，或创建行 `agentOptions` 配有 `provider`、`model`、`reasoningEffort` 中任一默认值时，先检查有效路由和模型是否支持请求。
2. 只有触发预检时，才合入后端 `agentRouteDefaults`。优先顺序为显式参数、行 `agentOptions`、后端默认，父路由的兼容值补齐缺项。只配置 `maxTokens` 等非路由选项不会触发预检，也不会合入后端路由默认。
3. 支持预检时，更换路由且未请求强度，会省略旧配置中的强度。只有有效路由未变且后端没有路由默认时，父强度才参与预检。这是预检规则，不是最终子代理的强度保证。
4. 最终创建发送各层实际贡献的选项，包括不触发预检的非路由选项。`resolveCallConfig` 的返回值不回填创建请求。宿主再将实际请求与父选项合并；最终强度要核对这一合并或真实子代理 descriptor，不能由预检省略强度推断最终不继承父强度。没有预检触发且没有选项需要携带时，路由继承父值，不再额外应用后端路由默认。

实时允许名单只校验显式选择请求。行默认触发支持预检，不等于用户显式选择模型。`agentOptions`、`agentPreset`、`allowedAgentPresets` 是行级固定配置，不是 17 项界面设置，也不能作为任意调用键传入。

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

按下面的字段查结果。“必有”表示每次成功响应都包含；其余字段按查询和结果出现。

| 返回字段 | 含义 | 下一步 |
| --- | --- | --- |
| `mode`、`entries`（必有） | 查询模式及本页供应商或模型条目 | 从条目取得准确 ID；先筛选后分页，ID 按字典序稳定排序 |
| `target`、`verdict`、`basis`（必有） | 创建目标、适用性判断及判断依据 | 先核目标与原因，再使用创建参数 |
| `total`、`complete`（必有）；`failed_providers`（可选） | 匹配数、是否完整和失败供应商 | 不完整时总数仅指已取得结果，不能把失败供应商算作零模型 |
| `version`（必有）；`page`、`page_size`、`has_next`、`next`（可选） | 查询版本和分页状态 | 续页直接使用 next；其中带 page、page_size、version 及原有 provider/query/target_tool |
| `provider`、`query`（可选） | 回显的供应商和搜索条件 | 续页保持条件；更改条件后从第一页开始 |
| `beyond_end`（可选） | 请求页超过末页 | 读取空页和总数后选择有效页，不会自动改读首页 |
| `example`（可选） | 适用于已确认目标及允许路由的创建参数 | 只传目标接受的字段，不把查询字段传给创建工具 |
| `unlisted_provider`、`unlisted_had_routes`（可选） | 供应商未列目录，以及是否取得允许路由 | 区分目录缺席与没有允许路由 |

版本失效时，按相同条件从第一页重查，不拼接新旧版本结果。

搜索匹配ID与显示名且忽略大小写。部分供应商失败时complete=false，total仅为取得数，不是失败部分模型数为0。允许集合中未列目录的准确ID仍可查询和列入结果，不能据目录缺席判定不支持。

## 4. 等待状态与消费式输出

一次等待只占用本次预算。预算到期交回控制，后台工作继续。`async_wait_job` 的状态快照，以及 `async_wait_agent` 的存在检查、重试和等待，都计入各自同一次调用的预算。

发给当前 Agent 的用户插话、可领取的通知（notice）、代理转达（relay）和本包迟到答案可以提前结束等待。等待开始前已到达的消息也会检查。排队消息留到下一轮，不打断本次等待。消息唤醒只是让 Agent 处理新内容，不表示等待目标已经完成。

| 返回状态或现象 | 下一步 |
| --- | --- |
| `running` 或状态尚未证实 | 保留编号，需要结果时稍后重查；不要重复启动 |
| `settled` | 查看独立结算消息，不能据此认定成功或答案已到 |
| `completed` | 检查真实退出码和结果内容，不能据此认定退出码为 0 |
| `killed` / `failed` | 查看终止或失败原因及已有输出 |
| 查询或读取失败 | 按错误用原编号重试，不当作对象不存在或空结果 |

取消等待或停止当前回合只结束等待，不杀后台命令或编排。宿主可能把取消出口改成取消错误，模型没收到job_id时，从job_list或完成通知找回；不要直接重跑可能有副作用的命令。真正停止用job_kill；子代理通过宿主interrupt_agent/管理入口停止，通过send_message续谈。

子代理settled表示这次不再观察到运行，不代表任务成功、最终答案已到或永远不会再运行。读取独立结算消息；最终文本迟到时处理其他工作，再等待消息。目标关系与状态分别确认，查询失败不能当not_found或settled。

输出读取会推进增量游标。首次成功终态read的最终result只交付一次，并入同次文本；再次读取不重复已消费内容。读取失败按错误重试，不能当空输出。完成也需检查退出码、信号、failed/killed提示。

结果可能缺少内容，先区分三种情况：

- 正文裁剪：`maxResultChars` 按 JS `String.length` 计量，保留首尾并显示省略量。状态、丢失提示和 spill 线索不占正文预算。
- 缓冲丢失（lossy）：宿主已丢弃部分缓冲内容。调大正文字符上限不能恢复这些内容。
- 临时文件（spill）：宿主报告 `spillPaths` 时，工具给出系统临时绝对路径。路径不证明文件仍完整或可读；没有路径也不能假定磁盘有完整副本。

临时文件可能被清理。需要保留时，在有读取权限的环境确认文件内容，再保存到获准的持久位置。命令输出和文件可能含凭据、私有地址或其他敏感信息；保存、转交和报障前分别检查访问权限与脱敏要求。

## 5. 模型目录、授权与继承

需要选择模型时，按以下顺序操作：

1. 在 DSH 的子代理设置中开启模型选择，并配置允许名单。成功保存后，已有会话的后续 `async_agent` 调用也读取当前策略，无需重开会话。
2. 用 `async_list_subagent_models` 查询，指定 `target_tool="async_agent"`，取得准确供应商、模型和可用推理强度 ID。分页时使用返回的 `next` 参数。
3. 创建时成对传入 `provider` / `model`，按需指定 `reasoning_effort`。工具在启动前再次确认许可；查询结果不是授权凭据。

关闭选择开关后，显式路由或强度请求被拒绝。全部省略时仍使用配置默认或父继承。运行中的子代理不换模型。策略读取失败、名单非法或许可撤回时，工具报告真实原因并拒绝本次显式选择，不自动换模型。

查询目录不创建代理，也不进行推理。判断时要区分四件事：目录能否列出模型、目标工具是否允许选择、凭据是否有效、远端服务是否可用。查询只说明已取得的目录和目标依据，不验证凭据或远端连通性。

`verdict` 的 `allowed` / `not-allowed` / `unconfirmed` 分别表示对选定目标允许选择、不允许选择、适用性未确认，不是通用授权。原生创建工具仍按自己的会话策略；工作流 `agent()` 也有独立参数和策略，不能套用本包实时规则。

明确target_tool可避免多入口歧义。省略时仅一个可识别候选才自动采用，多或零候选为unconfirmed。具名目标不可见时为not-allowed但仍可返回目录。使用准确ID和目标接受的强度，分页/搜索参数不传给创建工具。被拒时保留目标重新查询，勿换入口绕过限制。

## 6. 提问接管与静默失败

在设置中开启 `askTakeover` 并保存，才会使用本包待答面板。默认关闭时使用宿主提问流程。开启后也只处理本包两个预设根 Agent 的普通提问；计划评审、审批和其他预设继续走宿主流程。

`sidebar` 在侧边栏底栏显示未处理计数，点击展开；`overlay` 在右下角直接显示题目。可以从面板跳转原会话、选择或自定义答案、忽略题目和增加等待时间。

单选的预设与自定义互斥；多选可组合，自定义是独立答案而非附注。初始无选中项，推荐不等于选择。点击自定义输入或输入有效文本会选中，纯焦点移动不选中；取消选择可保留草稿，未选中草稿不提交。没有选择或选中空白自定义不能提交；忽略是独立动作。服务器也校验未知项与选择关系。

同一次提问中的各题共用初始期限。到期时保留已答内容，忽略状态如实返回；未答题返回 `selected=[]` 和说明超时的 `custom`，Agent 随后继续处理任务，用户仍可补答。

需要更多时间时，点击会话组的加时按钮。系统只给点击时仍未到期的批次追加 `askExtendMs`，从原期限算起。新批次使用自己的初始期限，已到期批次不恢复原等待。未收到加时确认时，先刷新并查看实际期限，再决定是否重试；每次成功操作都会累加。

到期后提交的答案仍投给原发问会话。通知包含完整题干、全部选项及说明、单多选关系、实际答案或忽略状态，以及时间信息。选项全集用于解释题目，不代表用户全选。

原 Agent 空闲且没有本包待投递消息时，宿主用 `followup` 开启回合；其他情况用 `inject` 放到下一消息领取点。只有宿主接受投递后，本包才发送唤醒事件。投递失败或记录缺席并标为 `undelivered` 时，打开原会话直接回复。标为 `gone` 且已在其他页面作答的题，不要重复提交。

24小时是惰性清扫阈值：超过到期24小时的expired记录仅在下一次新批接管时清扫，没有新批可保留更久；迟到提交自身不按24小时拒收。重启或卸载会丢内存过期记录，未结请求交回原生流程；需要保留的答案及时写入原会话。

silentFailureGuard默认false，仅本包两预设。启用后按条件提供结果诊断、描述警示和执行纪律。受限环境的捕获形命令可能在创建前静默失败；无输出、无退出标记时先用无害裸调用确认执行，查宿主日志，不把空结果当成功。不据提醒断言所有捕获都失败；更宽权限重试仍需同轮授权审批。

## 7. 高级组合

需要自建预设时，分别挂载所需工具行。`config.toolName` 指定该行提供的工具；省略它的行用于宿主配置，不注册工具。查询工具可以独立挂载，也可以与原生查询共存。自建组合不会自动禁用原有同步工具，需由组合作者检查实际工具清单。

工作流还需要运行脚本的引擎。下例将引擎和 `async_workflow` 放进同一个 delegation 组，并只隔离 `workflowEngine` 服务，避免从组外误取其他引擎。示例包含全部六工具，但不包含完整预设的其他功能。

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

### 安装和设置排障

| 看到的现象 | 先检查 | 处理方法 |
| --- | --- | --- |
| 工具和设置都缺席 | DSH 是否精确为本页 rc4 版本，装载日志是否拒绝插件 | 请维护者核对 profile 中依赖登记（dependency）和组合声明（bundle）；版本不匹配先选择对应安装来源，不强制跳过检查 |
| 有设置但没有工具 | 当前会话选择的预设 | 新建会话选择本包异步预设；自建预设按第 7 节核对工具挂载 |
| 工具可用但设置卡片缺席 | 装载日志中的配置错误，以及客户端是否重新打开 | 修正日志点名的配置；组合或客户端变化后按宿主要求重载并重开页面 |
| 保存失败或页面只读 | 是否通过宿主本机回环入口访问，字段错误和保存回执 | 按页面提示改用可写入口，修正非法字段后保存；失败草稿保留，不用重启掩盖错误 |
| 没拿到作业编号或读取失败 | `job_list`、完成通知和原任务时间 | 找回原 `job_id` 后重试读取；不要重新运行可能有副作用的命令 |
| 答案未确认或显示未送达 | 刷新后的题目状态和原会话 | 未确认不等于未执行；明确未送达时打开原会话直接回复，勿重复提交已在别处落定的题 |

日志仍不能说明原因时，按本节末尾的报障清单求助。

### 停用与卸载

**移除前先改默认预设。** 默认若指向dsh-async/dsh-async-create，停用或卸载后新会话报`agent-preset/not-found`，宿主不自动清除。先在宿主设置改为可用预设。已经移除时，在宿主默认预设入口清空或重选，再建会话验证。

按宿主GUI管理dependency与bundle并按提示重载；CLI移除命令须依据对应宿主管理说明，不假造通用命令。开发链接删除不是卸载已加载模块。旧会话可继续持有组合版本引用，producer行卸载不自动取消owner作业。先用job_list核任务，对不需要的任务显式停止；重启可能终止活动进程，须先安排收尾。

命令继承宿主权限、审批、沙箱及shellEnv.collect(exec)环境键集，输出和命令自身可能含敏感信息。模型可见注册错误最多500字符并单行化，完整错误在操作者日志。检查日志时避免把令牌、cookie、密码、私有URL和秘密环境值贴入issue。

报障使用[项目issue](<https://github.com/MC5Spear/dsh-async-tools/issues>)，提供：完整插件/宿主/Node版本、OS、预设、已脱敏相关设置、最小无害复现、预期与实际状态、job_id/agent_id及时间关系、真实退出标记和脱敏日志片段。保留原任务身份便于查找，不重复运行破坏性命令。个人维护接受issue、不接受外部PR，响应和修复没有固定时限。

文档维护遵循[文档原则](<documentation-principles.md>)。
