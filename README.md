# dsh-async-tools

中文 | [English](<README.en.md>)

[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)

让 DSH 中的长命令和子代理在后台工作。Agent 不必一直等着，可以先做其他事，需要结果时再读取。等待到期或用户插话只结束这次等待，后台任务继续运行。

这是第三方 DSH 插件，与 DeepSeek 官方无隶属关系。项目由个人维护，不接受外部 PR。问题和安全报告可通过 [issue](https://github.com/MC5Spear/dsh-async-tools/issues) 提交，请先脱敏；维护者自行安排响应和修复，没有固定时间表。

## 安装前先确认

| 项目 | 当前适用版本 |
| --- | --- |
| 插件版本 | `0.2.3+dsh.0.2.0-rc.2` |
| 精确宿主版本 | `0.2.0-rc.2` |

宿主指运行插件的 DSH。其他 DSH 版本应选择明确适配的插件，不能用默认分支推断兼容性。

- **Node.js**：建议使用 24。准备其他版本前，先核对[依赖下界和宿主环境要求](<docs/user-reference.md#1-版本安装与确认装载>)。
- **安装来源**：安装地址取不到源码时，先核对仓库地址与固定提交号，再检查网络或代理；仍无法获取时，向提供安装来源的维护者询问可用安装件。
- **平台**：Linux 命令与提权、macOS 和远程执行尚缺完整验证。需要这些环境时，先通过 issue 询问验证状态和已知限制，避免直接用于重要任务。

## 安装并开始使用

在目标 DSH 环境执行：

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#ce9852e03340c001f520ddfd13d62410c8983196
```

上述命令固定到完整源码提交，不是新发布标签。本包不从 npm 分发。

**也可以通过 GUI 安装**：打开目标 DSH 实例启动时显示的 Web 地址，在插件管理的安装框中填写：

```text
github:MC5Spear/dsh-async-tools#ce9852e03340c001f520ddfd13d62410c8983196
```

这里填写的是安装来源；插件管理页面位于目标 DSH 实例中，不是 GitHub 仓库页面。CLI 和 GUI 两种方式任选一种即可。

安装后按下面顺序确认：

1. 在插件列表打开本包详情，核对完整插件版本，并确认能看到设置表单。
2. 在新建会话的预设列表中选择 `dsh-async`。预设是一组工具和执行规则；这个预设用于通用编码。需要创作工具时选 `dsh-async-create`。
3. 新建会话，请 Agent 执行下面的无害任务。会话中的工具调用应显示结果或 `job_id`（后台作业编号）。

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print a marker", yield_ms=1000)
async_wait_job(job_id="<返回的 id>", wait_ms=30000)
```

这是 **Agent 工具调用示意**，不是可以直接粘贴进终端的 PowerShell 函数。`command` 中才是 PowerShell 命令。短任务应显示 `SHORT_OK`；长任务通常先返回 `job_id`，稍后读取会显示 `LONG_DONE`。若仍返回 `running`，保留同一编号，等需要结果时再读。

工具、预设或设置缺席时，按[安装排查](<docs/user-reference.md#1-版本安装与确认装载>)检查装载日志和版本。普通设置保存无需重启；不要为排查随手重新装载正在供他人使用的实例。

## 后台结果怎样读取

取得 `job_id` 不是失败。先继续独立工作，需要结果再调用 `async_wait_job`。两个等待工具都必须显式传 `wait_ms`，它是本次等待的毫秒预算，不是任务运行时限。

预算到期、用户插话或调用取消都不停止后台工作。编号丢失时，先从 `job_list` 或完成通知找回，不要盲目重跑有副作用的命令。要真正停止工作，使用宿主的 `job_kill` 或 `interrupt_agent`，随后确认收尾状态。

作业结果按读取进度交付。首次成功的终态读取会同时交付新输出和一次性最终结果，后续读取不会重发。重要内容收到后及时保存。`completed` 不代表退出码为零；子代理的 `settled` 只表示当前未观察到运行，不代表成功或最终答案已到。

## 工具与预设

| 工具 | 用途 |
| --- | --- |
| `async_run` | 启动命令，首次等待内给结果，否则返回后台作业编号 |
| `async_wait_job` | 在指定预算内等待作业，并在同次返回中交付读取结果 |
| `async_agent` | 创建可继续对话的后台子代理，立即返回 agent_id |
| `async_wait_agent` | 等待子代理停止运行；最终答案由独立消息送达 |
| `async_workflow` | 将宿主的多代理编排脚本作为后台作业管理 |

两个内置预设提供全部五工具，并保留宿主的状态查看、消息和停止入口，不改原有预设。自建预设见[完整组合](<docs/user-reference.md#8-自建预设的完整工具组合>)。

## 设置与提问

设置入口：插件列表 → 本包详情页。编辑和恢复默认都先进入草稿，选择保存才生效；离开会丢弃未保存内容。保存失败会保留草稿。只读或非回环入口不能写入时，使用获授权的宿主本机管理入口。

[完整用户参考](<docs/user-reference.md>)列出全部参数、17 项平铺 volatile 设置（可保存后直接更新的配置字段）、默认值、范围及恢复步骤。本版模型策略在会话创建时采样，全局编辑不会改变既有会话。`async_agent` 只有 `description`、`prompt`、`provider`、`model` 四参数；最后两项成对指定，或全部省略以继承父路由。

### 要在面板里回答提问吗

提问接管默认关闭。需要时在设置中开启，它只处理本包两预设的提问。静默失败提示是另一个独立开关，也默认关闭，作用范围相同。

### 没来得及回答怎么办

问题到期后，系统如实告知未答情况，让 Agent 继续。记录还在时，你仍可在面板补答。需要加时或了解具体作答方法，见[提问参考](<docs/user-reference.md#7-提问接管与静默失败>)。

### 怎样确认补答送达

工具等待结束不代表补答已经送达。出现失败提示或没有收到确认时，打开原会话核对；如果没有答案，直接在原会话补充题目和所选内容。

### 补答记录会保留多久

到期超过 24 小时的记录，只在下一新批提问被接管时清理；没有新批可能保留更久。需要保留答案时及时保存，不把待答面板当作长期记录。重启或卸载后的补答，直接发往原会话。

## 安全与卸载恢复

命令使用宿主会话的权限、审批、目录和环境，可能访问网络或敏感信息。只执行获授权动作，分享日志前先脱敏。结果可能被裁剪或写入宿主临时文件，收到实际路径后及时取回并妥善保存。本包自身不收集遥测、不发起网络请求、不读写凭据、不修改宿主源码。

**停用或卸载前，先把宿主默认预设从 dsh-async / dsh-async-create 改为可用预设。** 否则新会话可能报 `agent-preset/not-found`，宿主不会自动清除选择。已经移除时，直接在宿主默认预设设置中清空或重选，再建新会话；恢复不依赖本包页面。

卸载生产者行不会自动取消其 owner 作业，重启却可能终止活动命令。先处理自己的活动工作，再通过宿主插件管理停用或移除，并核对 dependency 和 bundle 两处声明。完整步骤见[停用和恢复](<docs/user-reference.md#9-安全停用和故障恢复>)。

## AI 维护者

参与本项目维护的 AI 维护者包括：

- `gpt-6.1-sol`
- `glm-5.3`

## 文档与许可

- 使用：[完整中文用户参考](<docs/user-reference.md>)、[English reference](<docs/user-reference.en.md>)。
- 源码维护资料：在[源码仓库](https://github.com/MC5Spear/dsh-async-tools)的对应版本检出中阅读下列中文资料，分别了解开发流程、产品合同、实现、探针安全和发布历史：

```text
CONTRIBUTING.md
docs/requirements.md
docs/design.md
verify/README.md
CHANGELOG.md
```

- 许可：MIT，见[许可](<LICENSE>)；宿主包许可与出处由对应包提供。
- 问题及安全报告：[issue](https://github.com/MC5Spear/dsh-async-tools/issues)，请先脱敏。

文档维护遵循[文档原则](<docs/documentation-principles.md>)。
