# dsh-async-tools

[English](<README.en.md>) · [完整用户参考](<docs/user-reference.md>)

[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)

让 DSH 的 Agent 执行长命令、委托子代理时，不必一直等着。命令超过首次等待时长后继续在后台运行，Agent 可以先做其他工作；需要结果时再等待，结果直接送回会话。等待到期或收到用户插话，都不会因此停止后台任务。

经常运行长任务、需要并行委托时，可以安装本插件；主要运行短命令时，也可以继续使用原有预设。

这是第三方插件，与 DeepSeek 官方无隶属关系。项目由个人维护，接受 issue，不接受外部 PR，响应与修复没有固定时限。安全问题也通过 issue 提交，请先删除敏感信息。

## 安装前先确认

| 项目 | 当前适用版本 |
| --- | --- |
| 插件版本 | `0.2.9+dsh.0.2.1-rc` |
| 支持的宿主版本 | `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5` |

“宿主”指加载插件的 DSH。**只有表中四个 DSH 版本可以加载本包**，正式 `0.2.1` 和未列出的 rc 也不能加载。建议使用 Node.js 24；选择其他运行时前，先看[运行时前提](<docs/user-reference.md#1-安装身份与前提>)。

Linux 的命令执行和单次提权尚未实机验证，macOS、远程执行环境也没有验证结论。rc.3／rc.4 尚未完成全部功能的实机复验；在这些环境中使用前，先在独立测试会话中确认所需功能。

依赖输入法、读屏或触屏作答时，以及需要从取消的工具调用中恢复结果时，还需注意[使用限制与结果保存](<docs/user-reference.md#使用限制与结果保存>)。

## 安装并确认已加载

本包不从 npm 分发。安装时复用 DSH 已提供的依赖，无需另装一套 DSH。0.2.9 起，无需为安装或升级本包关闭包管理器的 `autoInstallPeers` 自动补齐选项。

本包自身没有安装脚本。安装或升级遇到脚本授权提示时，先按[脚本授权排查](<docs/user-reference.md#安装脚本授权排查>)核对来源和必要性，再决定是否允许。

在 GUI 中安装：

1. 打开左侧“插件”，点击“添加插件”；旁边下拉菜单中的“安装第三方插件”也可进入。
2. 在包名／地址输入框中粘贴：

   ```text
   github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1
   ```

3. 点击“安装”。成功后点击“立即启用”；已启用时确认启用状态即可。
4. 若宿主提示 reload／restart，先处理活动任务、保存所需结果，再按提示重新装载或重启。
5. 打开本包详情页，确认设置表单可见。
6. 新建会话，确认预设选择器中有 `dsh-async` 和 `dsh-async-create`。选择其中一个，确认 Agent 可用下表中的五工具。预设决定 Agent 的可用工具和工作方式，两份均随包提供。入口缺失时按[安装排查](<docs/user-reference.md#安装排查>)处理。

也可在终端安装：

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1
```

命令中的 `web` 是目标 profile 的名称；使用其他 profile 时换成对应名称。安装后同样确认已启用，再按上面步骤核对加载结果。

这个地址跟踪会变化的维护分支。需要重复安装同一份源码时，将 `#` 后的分支名换成仓库中可取得的完整提交号，并保留该安装地址。安装后核对包版本的方法见[固定安装来源](<docs/user-reference.md#安装固定来源与版本核对>)。

## 第一次后台任务

以下演示使用出厂等待设置。在 Windows 上，新建会话并选择 `dsh-async`（通用编码），或 `dsh-async-create`（还保留插件与预设创作工具）。把下面的请求发给 Agent：

> 请演示后台执行，不修改文件、不访问网络、不创建子代理。先用 async_run 执行 `Write-Output SHORT_OK`，再执行 `Start-Sleep -Seconds 30; Write-Output LONG_DONE`，第二次显式设置 yield_ms=20000。保存返回的 job_id，先处理可独立完成的工作；需要结果时，用 async_wait 指定该作业并设置 wait_ms=30000。报告两个标记与真实退出信息，不重复执行命令来查进度。编号未收到时先用 job_list 查找。

短命令应直接返回 `SHORT_OK`。长命令运行 30 秒，在首次最多等待 20 秒后先返回作业编号 `job_id`，之后结果随等待返回或完成消息送达，包含 `LONG_DONE`。仍须检查退出信息：`completed` 只表示运行结束，不代表退出码为 0。

以下是 **Agent 的工具调用示例，不是终端命令**：

```text
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=20000)
async_wait(targets=[{kind:"job", id:"<返回的job_id>"}], wait_ms=30000)
```

出厂设置下，`yield_ms` 默认 20000 ms，单次请求按 20000–600000 ms 的边界取值。`wait_ms` 每次必填。等待到期后任务继续运行；不再需要的作业用 `job_kill` 显式停止，不要重跑原命令查进度。

结果不会一直重复发送。需要留档的内容应及时保存；正文过长、读取失败或调用被取消时，按[结果读取与恢复](<docs/user-reference.md#4-等待状态与直接交付>)继续处理原作业。

## 工具与预设

两个预设都直接提供五工具，不改动原有预设：

| 工具 | 用途 |
| --- | --- |
| `async_run` | 执行命令，返回结果或后台作业编号 |
| `async_wait` | 等待消息、作业结果或指定目标；没有可等待工作时直接返回 |
| `async_agent` | 后台创建可续谈子代理，立即返回 `agent_id`，最终回答另行送达 |
| `async_workflow` | 用 JavaScript 协调大规模多代理任务，整次编排作为后台作业管理 |
| `async_list_subagent_models` | 浏览或搜索模型，确认能否用于指定创建工具 |

检查状态、发送消息和停止任务仍使用 DSH 管理工具。通常无需指定子代理模型；需要选择时，按[查询模型、创建与等待](<docs/user-reference.md#5-模型目录授权与继承>)操作。`async_agent` 每次显式选择模型或强度时都读取当前 DSH 模型选择策略，保存设置影响后续创建，不切换运行中的子代理。

自建预设也可使用全部功能，但须手工挂入工具，并为编排配置引擎。设置中的 `boundPresets` 只控制操作要求和辅助功能作用于哪些预设，不会安装工具。详见[自建预设组合](<docs/user-reference.md#7-高级组合>)。

## 设置、安全与停用

设置位于插件列表 → 本包详情页。修改后选择保存；“恢复默认”也需要保存。普通合法设置保存无需重启。[设置参考](<docs/user-reference.md#2-首次使用与设置>)解释各字段及其默认值。

待答面板和命令静默失败提示默认关闭。需要时分别开启 `askTakeover` 和 `silentFailureGuard`；两项仅作用于 `boundPresets` 中的预设，默认名单包含本包两份预设。

命令继承会话目录、沙箱、审批和权限，仍可能访问网络或敏感信息。插件本身不收集遥测、不主动联网或读写凭据；模型目录查询从 DSH 取得数据，不调用模型推理。输出和宿主临时文件可能含秘密，分享前先脱敏。

**停用或卸载前，先更改默认预设并处理活动任务。** 若默认仍为 `dsh-async` 或 `dsh-async-create`，移除后新会话会报 `agent-preset/not-found`。在宿主设置中改为可用预设；已经移除时清空或重选默认，再建会话确认恢复。移除工具不会自动停止会话启动的作业，重启又可能终止活动进程。具体顺序见[停用、恢复与报障](<docs/user-reference.md#8-停用恢复与报障>)。

## AI 维护者

参与本项目维护的 AI 维护者包括：

- `gpt-6.1-sol`
- `kimi k3`
- `glm-5.3`
- `deepseek-v4.1-flash`

## 文档与许可

操作细节见[用户参考](<docs/user-reference.md>)。开发、需求、设计、验证和变更记录使用中文，不随安装包分发；可在[源码仓库](<https://github.com/MC5Spear/dsh-async-tools/tree/adapt/dsh-0.2.1>)中阅读。需要核对某次安装时，使用与安装地址对应的提交，不使用移动分支的最新内容代替。

本项目采用 MIT 许可，见[许可](<LICENSE>)。两份预设及部分子代理策略助手改编自 DeepSeek Harness；来源、上游版权和 MIT 许可全文见随包分发的[第三方通知](<THIRD_PARTY_NOTICES.md>)。

文档维护遵循[文档原则](<docs/documentation-principles.md>)。
