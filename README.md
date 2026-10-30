# dsh-async-tools

[English](<README.en.md>) · [完整用户参考](<docs/user-reference.md>)

[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)

让 DSH 的 Agent 启动长命令或子代理后，继续处理其他工作。需要结果时再等待；等待到期，后台任务继续运行。本文的“宿主”指加载插件的 DSH。

这是第三方插件，与 DeepSeek 官方无隶属关系。项目由个人维护，接受 issue，不接受外部 PR，响应与修复没有固定时限。安全问题也通过 issue 提交，请先删除敏感信息。

## 安装前先确认

| 项目 | 当前适用版本 |
| --- | --- |
| 插件版本 | `0.2.8+dsh.0.2.1-rc` |
| 支持的宿主版本 | `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4` |

- **DSH 版本必须是上表列出的三个之一。** 这三个版本共用同一条兼容线与同一份 peer 支持集合。集合外的正式 `0.2.1`、`0.2.0`、`0.2.2`，以及未列入的新 rc，都不放行。支持集合不表示本线全部行为已在每个宿主上验证：真机逐项重验尚未完成。
- **建议 Node.js 24。** 其他版本先核对[运行时前提](<docs/user-reference.md#1-安装身份与前提>)，插件声明不等于整套 DSH 的最低要求。
- **安装来源。** 安装地址取不到源码时，先核对仓库地址与固定提交号，再检查网络或代理；仍无法获取时，联系提供安装来源的维护者，询问可用安装件。
- **本线面向 Windows，但逐项重验未完成。** Linux 命令与单次提权、macOS、远程执行均未验证。需要这些环境时，先向维护者提供环境和使用需求，安排隔离验证后再决定部署。

## 安装

本包不从 npm 分发。在终端运行：

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1
```

也可以打开 DSH 的插件管理页，在安装对话框的安装地址中填入 `github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1`。

这个地址跟踪会移动的维护分支。需要固定来源时，先把源码检出到本地，在检出目录运行 `git rev-parse HEAD` 取得完整提交号，再把 `#` 后内容换为该提交号；安装后可用同一提交号核对安装件的来源。

安装结束后，打开插件列表中的本包详情页，应能看到设置表单。再到新会话的预设选择中确认 `dsh-async` 和 `dsh-async-create` 可选，选定后 Agent 应能使用下表中的六个工具。预设是决定 Agent 使用哪些工具的一组配置，无需手工创建预设目录。

若设置、预设或工具没有出现，先核对宿主版本是否在上表集合内，再按[安装排查](<docs/user-reference.md#1-安装身份与前提>)检查装载日志。参考中也有开发链接及更改安装组合后的重新装载步骤。

## 开始一个后台任务

新建会话，选择 `dsh-async`（通用编码）或 `dsh-async-create`（保留插件与预设创作工具）。可以让 Agent 执行一个无害的等待命令。下面是 **Agent 工具调用示意，不是 PowerShell 函数**：

```text
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=1000)
async_wait_job(job_id="<返回的job_id>", wait_ms=30000)
```

命令在首次等待内完成，会直接返回结果；否则返回作业编号 `job_id`。保存编号，继续独立工作，需要结果时用 `async_wait_job` 读取。`wait_ms` 每次必填，没有默认值。结果中应能找到 `LONG_DONE` 及真实退出信息；`completed` 不等于退出码为 0。

等待到期、取消等待或停止当前回合，都不停止后台任务。不需要的作业用 `job_kill` 显式停止。若没有收到编号，用 `job_list` 找回，不要重复执行原命令。

读取只返回尚未读过的文本；任务结束后的最终结果也只交付一次。需要保留的结果及时保存。截断、丢失与临时文件的处理见[结果读取](<docs/user-reference.md#4-等待状态与消费式输出>)。

## 工具与预设

两个预设都直接提供以下六工具。检查状态、发送消息和停止任务仍使用 DSH 管理工具，原有预设不变。

| 工具 | 用途 |
| --- | --- |
| `async_run` | 执行命令；直接返回结果或后台作业编号 |
| `async_wait_job` | 在本次 `wait_ms` 预算内等待并读取作业结果 |
| `async_agent` | 后台创建可续谈的子代理，立即返回 `agent_id` |
| `async_wait_agent` | 等待有权访问的子代理停止运行；最终回答另以消息到达 |
| `async_workflow` | 用脚本协调大规模多代理任务，并作为后台作业管理 |
| `async_list_subagent_models` | 分页浏览或搜索模型，查询对指定创建工具是否适用 |

`async_agent` 后续显式模型或推理强度选择，每次读取当前 DSH 开关和允许名单；保存设置后已有会话也生效，运行中的子代理不换模型。全部省略时采用配置默认或继承。原生创建工具及工作流 `agent()` 各有自己的规则，查询时应指定目标工具。[完整参考](<docs/user-reference.md>)提供全部参数、17 项设置和高级组合。

## 设置、安全与停用

设置位于：插件列表 → 本包详情页 → 描述与组件行之间。编辑后选择保存；恢复默认也须保存。普通设置保存无需重启。提问接管和命令静默失败提示默认关闭。[设置与提问说明](<docs/user-reference.md#2-首次使用与设置>)包含取值、超时补答及记录清理规则。

命令继承会话的目录、沙箱、审批和权限。插件不自行收集遥测、发起网络请求或读写凭据；模型目录由 DSH 接口提供，查询不调用模型推理。但命令仍可能访问网络或敏感信息。输出及宿主提供的临时保存文件可能含秘密，分享前脱敏，在有权限的位置保存所需内容。环境与错误日志的详细规则见[安全与报障参考](<docs/user-reference.md#8-停用恢复与报障>)。

**停用或卸载前，先更改默认预设。** 若默认仍为 `dsh-async` 或 `dsh-async-create`，移除后新会话会报 `agent-preset/not-found`。先在宿主设置改为可用预设；已经移除时，在宿主默认预设入口清空或重选，再创建会话确认恢复。用 `job_list` 检查自己的活动作业，显式停止不需要的任务。移除工具行不会自动取消发起会话拥有的作业，重启可能终止活动进程。[完整恢复与报障](<docs/user-reference.md#8-停用恢复与报障>)。

## AI 维护者

参与本项目维护的 AI 维护者包括：

- `gpt-6.1-sol`
- `kimi k3`
- `glm-5.3`
- `deepseek-v4.1-flash`

## 文档与许可

操作细节见[用户参考](<docs/user-reference.md>)。维护资料为中文，在[维护分支的源码](<https://github.com/MC5Spear/dsh-async-tools/tree/adapt/dsh-0.2.1>)中阅读；分支会移动，请使用与安装来源对应的检出：

```text
CONTRIBUTING.md          开发、审查与发布
docs/requirements.md     产品合同
docs/design.md           机制与验证差距
verify/README.md         探针安全与实现变异索引
CHANGELOG.md             发布历史
```

本项目采用 MIT 许可，见[许可](<LICENSE>)。两份预设及部分子代理策略助手改编自 DeepSeek Harness；来源、上游版权和 MIT 许可全文见随包分发的[第三方通知](<THIRD_PARTY_NOTICES.md>)。

文档维护遵循[文档原则](<docs/documentation-principles.md>)。
