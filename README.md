# dsh-async-tools

[English](<README.en.md>) · [完整用户参考](<docs/user-reference.md>)

[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)

让 Agent 启动长命令或子代理后，继续处理其他工作。需要结果时，再等待一段明确的时间。等待到期会交回控制权，后台工作继续运行。

这是第三方 DSH 插件，与 DeepSeek 官方无隶属关系。它提供六个工具、两个预设和插件设置。“宿主”指加载插件的 dsh；“预设”是一组供会话使用的工具和规则。提问接管与命令静默失败提示默认关闭，可在设置中开启。

个人维护，接受 issue、不接受外部 PR，不保证响应或修复时间。安全问题同样通过 issue 提交，请先脱敏。

## 安装前确认

| 项目 | 当前适用版本 |
| --- | --- |
| 插件版本 | `0.2.6+dsh.0.2.1-rc.3` |
| 精确宿主版本 | `0.2.1-rc.3` |

- **宿主必须精确匹配。** 本线 rc3 适配不等于全部行为已经重验；目标宿主上的逐项重验尚未完成，不能套用其他版本的验证结论。
- **建议 Node.js 24。** 使用其他版本前，按[运行前提](<docs/user-reference.md#1-安装身份与前提>)确认插件与宿主依赖的要求。
- **安装来源。** 安装地址取不到源码时，先核对仓库地址与固定提交号，再检查网络或代理；仍无法获取时，联系提供安装来源的维护者，询问可用安装件。
- **平台验证有限。** 本线面向 Windows，但仍需完成目标宿主逐项重验。Linux 命令与单次提权、macOS 和远程执行未验证。若需要这些环境，先向维护者提供环境与用途，在隔离环境验证后再用于实际任务。

## 安装

本包不从 npm 分发。可从下面的固定提交安装：

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#6c428de042a10f6af04a66e28fedab644184e5ad
```

要跟踪本线后续修改，使用移动分支：

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1-rc.3
```

固定提交便于复现；移动分支每次安装可能取得不同内容。

使用 GUI 时，打开宿主的插件管理页，在安装对话框的安装地址中填写同一个 `github:MC5Spear/dsh-async-tools#…`，不是浏览器地址，也不是 npm 包名。安装通道会提供设置和两个预设，无须手工创建预设目录。

按宿主安装提示完成必要的重新装载，再重新打开页面。在插件列表中打开本包详情，应能看到描述与组件行之间的设置表单；新会话的预设选择中应出现 `dsh-async` 和 `dsh-async-create`。选择其中一个后，Agent 应可使用下表六个工具。

如果设置或预设没有出现，先按[安装与装载排查](<docs/user-reference.md#81-安装与设置不可用>)核对版本、预设选择和页面状态，再请操作者查看装载日志。

## 开始一个后台任务

新建会话时，选择 `dsh-async`（通用编码）或 `dsh-async-create`（保留插件和预设创作工具）。请 Agent 执行一个无害的长命令，并在需要时取回结果。下面是 **Agent 工具调用示意，不是 PowerShell 函数**：

```text
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=1000)
async_wait_job(job_id="<返回的job_id>", wait_ms=30000)
```

命令等待 30 秒后打印 `LONG_DONE`。首次等待设为 1000 毫秒，通常会先返回作业编号 `job_id`；Agent 可以继续独立工作。需要结果时，把原编号交给 `async_wait_job`，每次都必须填写 `wait_ms`。若仍未完成，稍后再等，不重跑原命令。完成时检查输出中的 `LONG_DONE` 和真实退出标记；`completed` 本身不代表退出码为 0。

等待到期、取消等待或用户插话，都不会停止后台工作。编号丢失时用宿主 `job_list` 找回；不再需要的作业用 `job_kill` 请求停止。

结果按增量读取，首次成功终态读取只交付一次最终结果，需要保留时及时保存。详见[等待与结果](<docs/user-reference.md#4-等待状态与消费式输出>)。

## 工具与预设

| 工具 | 用途 |
| --- | --- |
| `async_run` | 启动命令；命令在首次等待期间完成时直接返回结果，否则返回作业编号，供稍后读取 |
| `async_wait_job` | 每次填写 `wait_ms` 指定最多等待多久，完成时读取作业结果 |
| `async_agent` | 只在后台创建可续谈的子代理，立即返回 `agent_id` |
| `async_wait_agent` | 等待有权查看的子代理停止运行；最终回答另以消息到达 |
| `async_workflow` | 将宿主编排引擎的一次脚本运行作为后台作业管理 |
| `async_list_subagent_models` | 分页浏览或搜索模型，查看准确 ID、推理强度及对目标创建工具的适用性 |

两个预设都直接提供六工具，不改写原有预设。创建和等待使用本包入口；检查、消息和显式停止继续使用 dsh 工具。全部参数、17 项设置、模型查询及自建组合见[用户参考](<docs/user-reference.md>)。

## 设置与使用边界

打开插件列表 → 本包详情页，在描述与组件行之间修改设置。编辑是草稿，点击保存才生效；恢复默认也须保存。普通设置保存无需重启。完整操作见[设置](<docs/user-reference.md#2-首次使用与设置>)。

需要通过面板处理普通提问时，可开启提问接管。到期后 Agent 继续任务，用户仍可补答。作答和补答方法见[提问说明](<docs/user-reference.md#6-提问接管与静默失败>)。

- 命令沿用会话的宿主权限、审批、沙箱和目录。命令本身可能访问网络或敏感信息，分享命令和结果前先脱敏。
- 要指定子代理模型，先在 **DSH 子代理设置**中开启模型选择，保存准确 `provider` / `model` 允许路由，再按[模型选择步骤](<docs/user-reference.md#51-先查询再选择>)查询和创建。这不是本包 17 项设置。保存影响已有会话的后续创建，不改变运行中的子代理；关闭时可省略模型和推理强度参数，使用默认或继承。原生工具和工作流 `agent()` 各有自己的策略。
- 输出可能因宿主缓冲丢失，或因正文上限被裁剪。宿主提供 spill 路径时，它指向系统临时文件，可能含敏感内容，也可能被清理。及时在有权限的位置保存所需内容，不把路径当永久备份。
- 本包不自行发起网络请求、不收集遥测、不读写凭据，不修改 dsh 源码。目录访问委托宿主接口，查询不发起模型推理。子进程环境取宿主 `shellEnv.collect(exec)` 的键集，本包不增删。模型可见注册错误最多 500 字符并单行化，完整原错在操作者日志。

## 停用前与移除后恢复

**卸载前先改默认预设。** 如果默认仍指向 `dsh-async` 或 `dsh-async-create`，停用或移除后，新会话会报 `agent-preset/not-found`。先在宿主设置中改为可用预设；已经移除时，也可从宿主默认预设入口清空或重选，再新建会话确认。

作业属于发起会话。移除工具行不会自动取消这些作业，而重启可能终止活动进程。维护前用 `job_list` 核对任务，显式停止不需要的工作。详见[恢复与脱敏报障](<docs/user-reference.md#8-停用恢复与报障>)。

## AI 维护者

参与本项目维护的 AI 维护者包括：

- `gpt-6.1-sol`
- `kimi k3`
- `glm-5.3`
- `deepseek-v4.1-flash`

## 文档与许可

日常操作见[用户参考](<docs/user-reference.md>)。开发克隆和链接方法见下列源码中的参与指南。[对应提交的源码](<https://github.com/MC5Spear/dsh-async-tools/tree/6c428de042a10f6af04a66e28fedab644184e5ad>)中还有中文维护资料：

```text
CONTRIBUTING.md          准备、修改、测试、审查与发布
docs/requirements.md     产品合同
docs/design.md           机制与验证差距
verify/README.md         探针安全与实现变异索引
CHANGELOG.md             发布历史
```

本项目采用 MIT 许可，见[许可](<LICENSE>)。两份预设及部分子代理策略助手改编自 DeepSeek Harness；对应内容的来源、上游版权和 MIT 许可全文见[第三方通知](<THIRD_PARTY_NOTICES.md>)，该通知随安装包一同分发。

文档维护遵循[文档原则](<docs/documentation-principles.md>)。
