# dsh-async-tools

[English](<README.en.md>) · [完整用户参考](<docs/user-reference.md>)

[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)

让 DSH 的 Agent 启动长命令或子代理后，继续处理其他工作。任务在后台运行；需要结果时，Agent 再等待一段指定时间。等待到期会交回控制，不会杀掉后台任务。“宿主”指加载本插件的 DSH。

**本分支在准备适配 DSH `0.2.2-alpha.2`，alpha 目标尚未实现。** 当前代码和包清单仍对应下面的 rc4 版本。本页安装方法只适用于 rc4 宿主，不能用于 alpha 宿主。未来版本、Node 和依赖目标保留在源码需求中。

| 项目 | 当前适用版本 |
| --- | --- |
| 插件版本 | `0.2.7+dsh.0.2.1-rc.4` |
| 精确宿主版本 | `0.2.1-rc.4` |

这是第三方插件，与 DeepSeek 官方无隶属关系。项目由个人维护，接受 [issue](<https://github.com/MC5Spear/dsh-async-tools/issues>)、不接受外部 PR；响应和修复没有固定时限。安全问题也通过 issue 提交，提交前请删除敏感信息。

## 安装前确认

- **DSH 版本必须精确匹配上表。** 版本不匹配时，宿主可能不加载整个插件。
- **建议使用 Node.js 24。** 使用其他版本前，先核对[完整运行前提](<docs/user-reference.md#1-安装身份与前提>)，不要把插件声明当作整套 DSH 的最低要求。
- **Git 账号需要私有仓库读取权限。** 本包不从 npm 分发。没有权限时，联系提供安装来源的维护者；[参考中的安装前提](<docs/user-reference.md#1-安装身份与前提>)说明怎样处理访问问题。
- **本线面向 Windows，逐项宿主重验尚未完成。** Linux 命令和单次提权、macOS、远程执行尚未验证。需要这些环境时，向维护者说明环境与用途，安排隔离验证；不要将 Windows 的部分结果当作其他平台可用的证明。

## 安装

在已配置好上述 DSH 的终端运行：

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#ca8f65b39b7694f9e5a2b28cca7a29bc43485ecc
```

也可打开 DSH Web 的插件管理页，在安装对话框的安装地址栏填写：

```text
github:MC5Spear/dsh-async-tools#ca8f65b39b7694f9e5a2b28cca7a29bc43485ecc
```

这里固定的是 rc4 源码提交，不是 alpha 安装件。维护者提供的 `#adapt/dsh-0.2.1-rc.4` 来源会随分支移动；复现固定版本时使用上面的完整提交。

安装完成并按宿主提示重新装载后，插件列表应出现 `dsh-async-tools`。打开详情页，应在描述与组件行之间看到设置表单。新建会话时，应能选择 `dsh-async` 或 `dsh-async-create`，无需手工创建预设目录。工具或设置缺席时，按[安装与设置排障](<docs/user-reference.md#8-停用恢复与报障>)检查版本和装载情况。

## 开始一个后台任务

选择 `dsh-async`（通用编码）或 `dsh-async-create`（保留插件和预设创作工具的创作模式）。预设是一组 Agent 工具与执行规则；本包的两个预设不改写 DSH 原有预设。

请 Agent 执行一个无害的长任务。下面是 **Agent 工具调用示意，不是 PowerShell 函数**：

```text
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=1000)
```

这个例子先等待 1 秒。任务未结束时，工具返回作业编号 `job_id`，Agent 可继续独立工作。需要结果时，使用原编号：

```text
async_wait_job(job_id="<返回的job_id>", wait_ms=30000)
```

`wait_ms` 每次必填，没有默认值。若返回仍未结束的状态，稍后再等；不要重复启动原命令。取消等待也不会停止任务。确实不再需要任务时，用宿主 `job_kill` 显式停止；未收到编号时，可从 `job_list` 或完成通知找回。

输出按增量读取，成功读取过的内容不会重放，最终结果只交付一次。及时保存需要保留的结果，并检查真实退出码；`completed` 不等于退出码为 0。截断、缓冲丢失和临时文件的处理见[结果读取](<docs/user-reference.md#4-等待状态与消费式输出>)。

## 工具与设置

| 工具 | 用途 |
| --- | --- |
| `async_run` | 执行命令；短任务直接返回结果，长任务返回作业编号 |
| `async_wait_job` | 等待作业，并读取这次取得的结果 |
| `async_agent` | 后台创建可继续对话的子代理，立即返回 `agent_id` |
| `async_wait_agent` | 等待子代理不再运行；最终回答另以消息到达 |
| `async_workflow` | 将用户明确要求的工作流或大规模编排作为后台作业运行 |
| `async_list_subagent_models` | 浏览、搜索模型，查看对指定创建工具是否适用 |

六工具都在两个预设中直接可用。检查、发消息和停止任务仍用宿主管理工具。全部参数、17 项设置及自建预设组合见[用户参考](<docs/user-reference.md>)。

在插件详情页修改设置后，点击“保存”才生效，普通设置保存无需重启。“恢复默认”也需要保存。提问接管和命令静默失败防护默认关闭；开启前阅读[提问与防护说明](<docs/user-reference.md#6-提问接管与静默失败>)。

## 停用前更换默认预设

**停用或卸载前，先更换默认预设。** 默认仍指向 `dsh-async` / `dsh-async-create` 时，移除后新会话会报 `agent-preset/not-found`。先在宿主设置改为可用预设；已经移除时，在宿主默认预设入口清空或重选，再新建会话确认。

移除插件不会自动取消发起会话拥有的作业。先用 `job_list` 检查并显式停止不再需要的工作；重启可能终止活动进程。完整步骤见[停用、恢复与报障](<docs/user-reference.md#8-停用恢复与报障>)。

命令沿用会话的权限、审批、沙箱和目录。命令及结果可能包含敏感信息，分享前请脱敏。结果缓冲和临时文件的保存风险见[结果读取](<docs/user-reference.md#4-等待状态与消费式输出>)；模型选择见[模型目录与授权](<docs/user-reference.md#5-模型目录授权与继承>)。

## AI 维护者

参与本项目维护的 AI 维护者包括：

- `gpt-6.1-sol`
- `kimi k3`
- `glm-5.3`
- `deepseek-v4.1-flash`

## 文档与许可

[用户参考](<docs/user-reference.md>)提供完整操作说明。维护资料为中文，未全部随安装包分发。请从[固定 rc4 源码](<https://github.com/MC5Spear/dsh-async-tools/tree/ca8f65b39b7694f9e5a2b28cca7a29bc43485ecc>)取得对应检出，在源码中阅读：

```text
CONTRIBUTING.md          开发、审查与发布
docs/requirements.md     产品合同
docs/design.md           机制与验证差距
verify/README.md         探针安全与实现变异索引
CHANGELOG.md             发布历史
```

本项目采用 [MIT 许可](<LICENSE>)。两份预设及部分子代理策略助手改编自 DeepSeek Harness；[第三方通知](<THIRD_PARTY_NOTICES.md>)包含来源、上游版权和 MIT 许可全文，并随安装包分发。

文档维护遵循[文档原则](<docs/documentation-principles.md>)。
