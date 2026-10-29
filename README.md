# dsh-async-tools

[English](<README.en.md>) · 中文

[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)

> 第三方 DSH 插件，与 DeepSeek 官方无隶属关系。个人维护，接受 issue、不接受外部 PR，不保证响应或修复时间；安全问题同样通过 issue 提交，请先脱敏。

运行长命令或让子代理分工时，不必让 Agent 一直等着。这个插件让任务在后台继续，Agent 可以先做其他工作，需要结果时再等待一段指定的时间。

插件安装在 DeepSeek Harness（DSH，运行 Agent 的应用）中。它提供六个工具和两个预设；预设是一组可直接选择的 Agent 工具与指引。插件还提供设置表单。提问接管和命令静默失败提示默认关闭，可按需开启。

## 版本与安装

| 项目 | 当前适用版本 |
| --- | --- |
| 插件版本 | `0.2.5+dsh.0.2.1-rc.2` |
| 精确宿主版本 | `0.2.1-rc.2` |

建议使用 Node 24；使用其他版本前，先核对[环境要求](<docs/user-reference.md#1-版本安装与首次确认>)。

Windows 已完成部分隔离环境验证。Linux 的命令执行和申请更宽权限、macOS、远程环境尚未完成验证。需要这些环境时，请先通过 issue 说明平台和所需功能，询问支持进度。

本包不从 npm 分发。安装地址取不到源码时，先核对仓库地址与固定提交号，再检查网络或代理；仍无法获取时，向提供安装来源的维护者询问可用安装件。

以下命令固定本线提交，安装内容不会随分支移动。

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#97b7b27e8e66f225003dd80f85f7229b2372a3be
```

也可在 DSH 界面的插件安装对话框中填写下面这段安装地址。它与命令中 `add` 后的内容相同，末尾固定提交，不能省略：

```text
github:MC5Spear/dsh-async-tools#97b7b27e8e66f225003dd80f85f7229b2372a3be
```

安装后，按以下位置确认是否可用：

1. 在插件列表打开 `dsh-async-tools`，确认版本为上表完整版本，并能看到设置表单。
2. 新建会话，在预设选择器中选择 `dsh-async`；需要创作工具时选择 `dsh-async-create`。
3. 查看该会话的工具列表，对照下方[工具与预设](<#工具与预设>)确认六个工具都在，再开始任务。

工具、预设或设置缺席时，按[用户参考的排障步骤](<docs/user-reference.md#8-风险停用与排障>)检查。源码目录安装和重新装载的注意事项也在参考中；正常保存设置不需要重启。

## 首次使用与设置

在新会话里告诉 Agent 要完成什么。需要试用后台命令时，可以请它运行一个等待30秒再打印标记的无害任务。下面是 **Agent 的工具调用示意，不是在 PowerShell 里输入的命令**；短任务直接返回，长任务可能先返回作业编号 `job_id`。

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless test marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print a harmless marker", yield_ms=1000)
→ 返回 job_id 后继续其他工作，需要结果时：
async_wait_job(job_id="<返回的job_id>", wait_ms=30000)
```

拿到 `job_id` 后，Agent 可以继续其他工作，需要结果时调用 `async_wait_job`。正常完成这个示例后，结果应包含 `LONG_DONE`；还要查看退出标记，`completed` 本身不代表退出码0。

调用等待工具时，必须用 `wait_ms` 填写本次最多等待的毫秒数。等待到期、收到插话或取消等待，都不会停止后台任务。

没有收到作业编号时，先用 DSH 的 `job_list` 或完成通知找回，再读取原任务。不要重复启动可能改文件、发请求等有副作用的命令。

每次成功读取会取走尚未读取的输出，最终结果只交付一次。需要保留的内容应及时安全保存；完整的[结果读取与状态说明](<docs/user-reference.md#4-状态结果读取与停止>)也解释了子代理答案怎样送达。

需要调整等待时长等选项时，在插件列表打开本包详情，设置表单位于描述与组件行之间。编辑后点击保存才生效；恢复默认也需保存，离开会丢弃草稿。保存需要本机可写的管理入口（回环地址）。全部17项设置和保存失败的处理见[完整用户参考](<docs/user-reference.md#2-设置入口保存与恢复>)。

想给子代理指定模型？先在 DSH 子代理设置中开启模型选择并保存允许名单，再让 Agent 查询准确 ID。新设置影响后续创建，不更换运行中子代理的模型；完整选择方法见[模型选择](<docs/user-reference.md#5-模型选择与查询授权>)。

想让无人作答时 Agent 继续工作？可开启默认关闭的提问接管。普通提问会出现在待答面板，到期后 Agent 继续，你仍可补答；审批和计划评审保持原生流程。答案记录只在内存中，重启或卸载后不能找回。作答、加时、迟到清理和送达失败处理见[提问说明](<docs/user-reference.md#6-提问接管与静默失败>)。

## 工具与预设

下表供开始使用后查阅。参数、返回状态和失败处理见[工具参考](<docs/user-reference.md#3-工具参数>)。

| 工具 | 用途 |
| --- | --- |
| `async_run` | 运行命令。短命令直接返回结果；长命令先返回作业编号 `job_id`，等待结束不会杀掉进程。 |
| `async_wait_job` | 按作业编号等待并读取结果。调用时必须填写本次最多等待的毫秒数 `wait_ms`。 |
| `async_agent` | 创建在后台工作的子代理，并立即返回子代理编号 `agent_id`。 |
| `async_wait_agent` | 在指定时间内等待子代理停止运行；等待结束也可能只是时间用完，最终答案另以消息送达。 |
| `async_workflow` | 用户明确要求工作流，或需要协调大量子代理时，用脚本组织后台工作。 |
| `async_list_subagent_models` | 分页浏览或搜索模型，并说明所选创建工具是否允许使用这些模型。 |

`dsh-async` 用于通用编码，`dsh-async-create` 保留创作工具。两预设都包含六个工具；查看任务、发送消息和主动停止任务，仍使用 DSH 的管理工具。插件不改变原有预设。

## 风险与停用恢复

命令沿用宿主权限、沙箱、审批和环境；结果及临时 spill 文件可能含敏感信息，分享前脱敏，所需结果及时安全保存。空输出先看执行证据和退出标记，不能当作命令没运行。真正停止任务使用宿主作业或子代理停止入口。

**默认预设为 `dsh-async` / `dsh-async-create` 时，直接停用或卸载会让新会话报 `agent-preset/not-found`。** 宿主不会自动清除这个选择。

1. 卸载前，在宿主设置中把默认预设改为仍可用的预设。
2. 收取需要的结果，显式停止不再需要的自有任务；移除插件不自动停止这些作业。
3. 按[停用与恢复步骤](<docs/user-reference.md#8-风险停用与排障>)移除插件。需要重启时先确认其他活动会话，重启可能终止进程。

已经移除插件而新会话报错时，直接到**宿主默认预设设置**清空或重选可用预设，无需重新打开已移除的插件页面。

## 资料导航

| 任务 | 入口 |
| --- | --- |
| 参数、配置、状态、模型、完整组合与恢复 | [用户参考](<docs/user-reference.md>) / [English reference](<docs/user-reference.en.md>) |
| 当前文档维护规则 | 包内[文档原则](<docs/documentation-principles.md>) |

源码检出中的维护资料（中文）位于下列路径。通过[源码仓库](<https://github.com/MC5Spear/dsh-async-tools>)取得对应版本源码后阅读；这些是源码路径，不是安装包内链接。

```text
CONTRIBUTING.md          开发、审查与发布
docs/requirements.md    产品目标与验收合同
docs/design.md          当前机制与验证差距
verify/README.md        探针运行与安全前提
CHANGELOG.md            发布历史
```

## AI 维护者

参与本项目维护的 AI 维护者包括：

- `gpt-6.1-sol`
- `kimi k3`
- `glm-5.3`
- `deepseek-v4.1-flash`

## 许可

本项目采用 MIT 许可，见[许可](<LICENSE>)。两份预设及部分子代理策略助手改编自 DeepSeek Harness；对应内容的来源、上游版权和 MIT 许可全文见[第三方通知](<THIRD_PARTY_NOTICES.md>)，该通知随安装包一同分发。

文档维护遵循[文档原则](<docs/documentation-principles.md>)。
