# dsh-async-tools

[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)

> 第三方 DSH 插件，与 DeepSeek 官方无隶属关系。个人维护，接受 issue、不接受外部 PR，不保证响应或修复时间；安全问题同样通过 issue 提交，请先脱敏。

让长命令和子代理工作在后台，让 Agent 能继续其他工作，并用有界等待取得控制权。包提供五个工具、两个异步预设、插件设置，以及默认关闭的提问接管和静默失败防护。

**English summary.** Five tools provide background command execution, bounded job and subagent waits, background-only delegation, and workflow orchestration. The plugin uses official bundle declarations and never patches host source. The current documentation defines target behavior, not a guarantee that every requirement is implemented or verified. Check the implementation gaps in the design before deployment.

## 实现与验收边界

[需求](<docs/requirements.md>)定义当前目标；[设计的当前实施与验证差距](<docs/design.md#9-当前实施与验证差距>)是未完成事项的唯一工作清单，部署前以该章现行内容为准。

不要把目标行为当已经发布的保证。部署前核对所用提交、包版本、宿主版本、设置及对应验收证据；CI 或文档审查通过不证明真实消息、GUI、受限命令和卸载情形全部可用。

## 工具与预设

| 工具 | 目标用途 |
| --- | --- |
| `async_run` | 执行命令；预算内完成时直接返回结果，超出首次等待或收到可处理消息时交出作业句柄，不因等待到时杀进程 |
| `async_wait_job` | 显式 `wait_ms` 有界等待，终态时在同一次返回中交付读取结果 |
| `async_agent` | 仅后台创建可续子代理，立即返回 `agent_id`，可成对指定模型路由 |
| `async_wait_agent` | 对合法目标检查当前运行状态并有界等待；消息唤醒不等于目标完成 |
| `async_workflow` | 包装宿主编排引擎，将一次脚本运行纳入作业管理 |

`dsh-async` 是通用编码的异步模式，`dsh-async-create` 是保留创作工具的异步创造模式。两者直接提供五工具，创建和等待采用本包入口，检查、消息和停止管理仍使用宿主工具。原有预设不被改写。

工具也可挂入使用者自己的预设；这样不会自动移除其已有同步工具。每行 `config.toolName` 选择一个工具，缺省是宿主配置角色，不注册工具。`async_workflow` 行须处于能取得编排引擎的 delegation 组，其他行按预设组成挂载。

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
```

## 运行边界与安全

- 命令由宿主执行，使用该会话的权限、审批和目录；本包不绕过沙箱，也不额外替用户限制命令。
- 首次等待到时、消息唤醒或停止等待不等于取消后台工作。真正停止用宿主作业／子代理管理入口；不需要的任务应显式收尾。
- 作业属于发起会话，卸载工具生产者行不代表作业立刻消失。owner 或服务处置与插件行处置是不同生命周期。
- 目标等待规则只认发给当前主体、下一步骤可处理的消息，queue 保持下一轮语义；消息到达不能把别的任务伪装成等待目标已完成。
- 指定子代理路由受会话创建时的模型策略约束；不指定时继承父路由。策略后的全局编辑不追溯改变既有会话。
- 本包不发起网络请求、不收集遥测、不读写凭据，不修改宿主源码。子进程环境由宿主提供；命令本身可能访问网络或敏感信息，仍由操作者负责。
- 输出可能被宿主缓冲裁剪或写系统临时位置；读取交付实际 spill 线索，不承诺临时文件长期存在。
- 信息暴露边界：子进程取得宿主 `shellEnv.collect(exec)` 返回的键集，本包不增删；宿主部署向子进程贡献的环境键以运行时集合为准，不在这里维护过期变量清单。spill 为宿主报告的系统临时绝对路径；模型侧注册错误最多 500 字符且单行化，完整原错只在操作者日志。
- Windows 与 Linux 要分别验证；没有 Linux 证据不能推广 Windows 结果。macOS 和远程执行环境不在验证范围。

## 兼容性

当前插件版本与支持宿主、依赖范围唯一见[当前兼容基准](<docs/requirements.md#73-当前兼容基准与逐版本适配>)及包清单。发布版本按[版本显示规则](<docs/requirements.md#731-版本显示与发布标识>)在插件核心版本后携带 dsh 构建元数据，便于用户判断；每个完整标签固定自己的适配声明，显示信息不替代 peer 校验，也不代表全系列兼容。当前清单与下一版目标分开核对，尚未落实的发布工作见[设计工作清单](<docs/design.md#9-当前实施与验证差距>)。Node 至少 20。

宿主不匹配时可能跳过整个 bundle；工具、预设和设置不可见不是正常降级。安装后分别检查宿主装载、工具目录和实际设置页面，不只检查包管理器成功。

## 安装

### 宿主安装通道

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools
```

GUI 安装对话框可填写相同 spec；固定版本时在 GitHub spec 的 `#` 后指定已发布、已核验的完整标签，保留包版本的宿主构建元数据，不用 SemVer 范围选择适配版本。包不从 npm 分发。官方 bundle 声明提供宿主配置行与两预设，不需要手工生成用户预设目录，不改 shipped 文件。

装载组合和客户端入口变化需要重新装载实例并重新打开页面；不要启动另一个无关服务器来替代原实例。重启从服务进程树外执行，先确认不会停止他人的活动会话。

### 开发链接

```powershell
git clone https://github.com/MC5Spear/dsh-async-tools.git
cd dsh-async-tools
npm install
dsh plugin --profile web add <克隆目录的绝对路径>
```

链接目录必须能解析对应宿主依赖；不能把裸 Node 导入成功或失败当完整宿主接线证明。开发链接仅用于明确开发环境，稳定部署使用独立安装件，不把未验收编辑树直接当发布件。

## 配置与使用

设置入口：插件列表 → 本包详情页 → 描述与组件行之间的表单。包须出现在 profile 的 dependencies 和 bundles，浏览器一侧（客户端）也须真正到达页面。写入使用宿主本机回环入口，非回环或只读时明确不可写。

默认值和合法范围唯一见[配置表](<docs/requirements.md#52-默认值与范围>)，不在本文维护第二份数字表。宿主快照存在时采用该快照，工具行预算配置不覆盖它；快照缺席才使用合法本行备用值并诊断设置未接线。

| 设置组 | 用途 |
| --- | --- |
| 首次等待与等待预算 | 控制默认示例、请求夹紧及本次等待占用，不控制后台任务寿命 |
| 轮询、结果长度、作业 kind | 目标状态备用查询、模型结果裁剪和命令作业标识 |
| `subagentProvider` | 子代理后端，不等同 LLM provider 路由 |
| `uiLang` / `agentLang` | 界面与模型文案独立选择 |
| `silentFailureGuard` | 本包预设内的结果诊断、描述警示和执行纪律；默认关闭 |
| `askTakeover` / `askTimeoutMs` / `askUiSeat` | 本包根 Agent 普通提问的接管、初始窗口和面板位置；默认关闭，面板默认侧边栏底栏徽标、可选右下角浮窗 |
| `askExtendMs` | 待答面板「增加等待时间」每次延长的时长，默认 60 秒；延长只作用于未到期批次、在原截止时间上叠加，跨会话组隔离，已到期题不复活 |

编辑先暂存，保存才写；恢复默认也需要保存，离开丢弃草稿。覆盖按用户层字段是否存在判断，保存失败保留草稿。毫秒输入同时显示生效与输入秒数，输入段未保存就跟随键入。每字段旁有带圈问号帮助按钮，展开技术标识与详细说明，开合不写设置、不影响暂存与保存。保存后的后续行为及描述应使用新值，不能只看页面变化。

### 命令与结果

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print a marker", yield_ms=1000)
→ 若返回 job_id，继续其他工作；需要结果时：
async_wait_job(job_id="<返回的id>", wait_ms=30000)
```

请求等待工具必须显式给预算。终态首次读取会消费增量及一次性最终结果，工具必须在同次返回交付；再次读取不重复最终结果。读取错误给重试标记，不能据空正文重启有副作用命令。

### 提问接管

目标机制仅接管两个异步预设根 Agent 的非计划评审普通提问，不动审批或其他预设。无人作答到期给超时事实，不代选答案；页面面板支持作答、忽略、跳转、延长和迟到通知。

每次延长在当前未到期批原期限上增加配置时长，新批独立，已到期题不能复活。迟到答案作为本包通知进入原主体，正文自含题目，不冒充用户发言。到期题的保留期及已清扫题的提交行为见需求 4.4，界面不能假报未送达答案成功。当前运行实现与这些目标的差距必须在部署前核对。

## 停用、卸载与风险

**卸载风险：默认预设指向本包预设（dsh-async / dsh-async-create）时，停用或移除本包会让新建会话报 `agent-preset/not-found`，宿主不会自动清除该选择。** 卸载前先在宿主设置把默认预设切换到可用预设；已移除后按宿主设置入口清选或重选。设置页表单顶部呈现同一口径的醒目提示（两处一致，改一处必须连另一处一起改）。

- GUI 卸载按宿主管理 dependency 与 bundle；CLI 移除行为需核对该宿主版本，不仅假设删除依赖就已移除启用项。
- 对开发链接，移除本包 bundle 声明并重新装载；联接清理仅是文件管理，不等同停用已经加载的模块。
- 声明退出新会话列表与旧活动组合退役分开；存活会话可继续持有宿主允许的版本引用。
- 本包计时、监听、配置与客户端贡献随各自生命周期释放；owner 作业不随工具行卸载自动取消，重启可能终止活动进程，不能将它当无风险清理。
- 可预见问题优先预防和修复，必要时有限独立指南／工具只处理可识别本包残留；不承诺对未知用户配置或 OS 进程的万能修复。

完整行为要求见需求 7.2；提示与补救机制见设计 5.4 与 7.2。

## 检查与验证

```powershell
npm run test:inproc
npm run test:offline
npm run check
npm run check:preset
npm run check:public-surface
npm run check:encoding
npm run check:docs
npm run check:model-text
npm run check:alias-tokens
npm run check:agent-policy
```

单元宿主锚可用 `DSAT_HOST_MODULES`，配置形状见[本机配置示例](<tools/local-config.example.mjs>)。缺锚跳过不是通过；额外权限或环境经正常审批。真实命令、消息、路由与 GUI 应在隔离实例及自己的会话中验证，不把离线套件或旧截图当当前通过。

[验证目录说明](<verify/README.md>)标明脚本副作用、特定环境和当前未覆盖目标。部分脚本会改共享设置、起浏览器或原地变异，先读脚本，不能直接批量运行。更详细维护规则在[参与指南](<CONTRIBUTING.md>)。

### 实现变异索引

此表是现有脚本与测试入口的机器核对索引，不表示这些脚本已经覆盖全部当前目标。仅在隔离副本使用写回型脚本，未运行不算变异被捕获。

| 脚本 | 跑的测试文件 | 对象 |
| --- | --- | --- |
| `verify/mutate-escalation-removed.mjs` | `test/escalation.test.mjs` | 单次提权接线 |
| `verify/mutate-steering.mjs` | `test/interrupt.test.mjs` | 消息落点与来源过滤 |
| `verify/mutate-escalation-order.mjs` | `test/escalation.test.mjs` | 批准与启动顺序 |
| `verify/mutate-card-theme.mjs` | `test/two-planes.test.mjs` | 主题样式 |
| `verify/mutate-agent.mjs` | `test/agent.test.mjs` | 后台派生与 persona |
| `verify/mutate-yield-example.mjs` | `test/output.test.mjs` | 预算示例 |
| `verify/mutate-config-slot.mjs` | `test/two-planes.test.mjs` | 配置表单挂点 |
| `verify/mutate-r27-form.mjs` | `test/two-planes.test.mjs` | 表单草稿与保存 |
| `verify/mutate-lang.mjs` | `test/two-planes.test.mjs` | 双语言行为 |
| `verify/mutate-list-children-shape.mjs` | `test/wait-agent.test.mjs` | 子代理目录形状 |
| `verify/mutate-r55-entry-scan.mjs` | `test/wait-agent.test.mjs` | 等待入口扫描 |
| `verify/mutate-atb01-final-result.mjs` | `test/wait-job.test.mjs` | 最终结果同次交付，另有真实注册表测试 |

检查器输入变异包括路径、编码之外的公开范围、模型文案、主题、策略和界面判据等，分别由脚本自身声明入口；[变异索引检查器](<tools/check-mutate-index.mjs>)核对上述实现表和具名例外，不以文档表代替执行结论。

## 文档与许可

| 内容 | 文档 |
| --- | --- |
| 当前产品行为、配置与增补入口 | [需求](<docs/requirements.md>) |
| 目标机制、验证及当前实施差距 | [设计](<docs/design.md>) |
| 开发、公开范围和发布规则 | [参与指南](<CONTRIBUTING.md>) |
| 现有探针的覆盖和安全前提 | [验证说明](<verify/README.md>) |
| 各发布版本记录 | [变更记录](<CHANGELOG.md>) |

MIT，见[许可](<LICENSE>)。本包不重打包宿主源码，宿主包许可与出处由对应包提供。
