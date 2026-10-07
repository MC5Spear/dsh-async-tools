# dsh-async-tools

[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)

> **English summary.** Five DSH tools that stop a long-running command from freezing the
> agent: `async_run` yields to a background job instead of killing the process at the
> deadline, `async_wait_job` / `async_wait_agent` wait within a bounded budget and return
> early when the user speaks — without disturbing the background work, `async_agent`
> derives a subagent that is *always* background, and `async_workflow` orchestrates many
> subagents from a JS script. Two agent presets ship with the package (`dsh-async`,
> `dsh-async-create`). Requires DSH `0.2.0-rc.2`; the plugin never patches the host.
> Design notes and requirements are in [`docs/`](docs/) (Chinese). No telemetry, no
> network calls, no credentials — see [Security](#security).

让 DSH 的 Agent 不再被长命令钉死的五个工具，外加两个把它们装起来的 Agent 预设
（`dsh-async` 异步模式 与 `dsh-async-create` 异步创造模式）。

| 工具 | 一句话 |
| --- | --- |
| `async_run` | 跑命令。让出预算内结束就返回完整输出；**超出预算不杀进程**，转后台并返回 `job_id`。让出期间用户插话或停止本轮**只结束等待，命令不受影响**。 |
| `async_wait_job` | 有界等待某个后台作业。可被用户插话打断，**打断不影响作业**；等待开始前已到达的插话同样立即打断（入口检查）。 |
| `async_wait_agent` | 有界等待某个后台子代理。可被用户插话打断，**打断不影响子代理**；等待开始前已到达的插话同样立即打断（入口检查）。 |
| `async_agent` | **永远后台**的子代理派生：立返 `agent_id`，不等待不轮询（没有 `run_in_background` 参数——后台是结构保证）。 |
| `async_workflow` | 后台多代理编排（JS 脚本编排子代理）。默认让出预算内结算就带回结果；超出转后台，完成通知是恢复通道。**仅在大规模编排时用；一两个委托走 `async_agent`**。只在两预设的 delegation 组内行注册。 |

要解决的问题：dsh 内置 `pwsh` 的前台模式有一个"命令寿命上限"（默认 120 s、固定上限 600 s），
到点会**杀掉整棵进程树**——两小时的编译必然白跑。而如果干脆不设超时，Agent 又会阻塞两小时。
本插件给的是第三条路：**到点让出，不杀进程**。

## Security

这一节写在前面，因为这些工具**确实会执行真实命令**，使用前应当知道边界。

- **本插件执行命令，且不额外限制它们。** `async_run` 把命令交给宿主的 shell 执行器，
  权限就是**该会话当时的权限**。沙箱策略、审批链、工作目录都由宿主决定，本插件不绕过、
  也不放宽。
- **到点不让出会杀进程——这是本插件与内置前台工具最重要的语义差别。** 内置 `pwsh`
  前台模式在寿命上限到点会杀掉整棵进程树；`async_run` **不杀**，它返回句柄、命令在后台
  继续跑。**代价是"我以为它被取消了，其实还在跑"**：请用 GUI 的停止、`job_kill`
  或宿主的作业面板显式结束。插话（steer）同样**只结束等待**。
- **提权键只在宿主广告了它们时出现。** 当宿主提供了受限执行器，`async_run` 的参数表里会
  出现 `sandbox_permissions` 与 `justification`；提权**只作用于那一次调用**，不写回会话策略，
  且必须走宿主的审批链。没有受限执行器时这两个键不出现（不给走不通的指引）。
- **模型可控的文本会进操作者日志。** `description` / job_id / agent_id 拼进日志前一律
  **单行化**（CR/LF/TAB 转字面转义序列），带换行的参数伪造不了多行日志。注册失败的宿主原文
  单行化 + 截断后才进模型可见文本，完整原文留在操作者日志。
- **子进程环境由宿主决定，本插件不自造也不追加。** `async_run` 传给命令的环境变量就是宿主
  `ctx.shellEnv.collect(exec)` 的返回值——本插件不改键集、不注入任何东西。
- **两个改变宿主行为的开关默认关**：`silentFailureGuard`（结算诊断 + 描述警告段 + 系统提示
  纪律段）与 `askTakeover`（接管提问链、超时放行）。不打开就完全按原生行为走。
- **不做什么**：不发起网络请求、不收集遥测、不读写凭据、不改动 dsh 任何源码、不打 patch。
  本包的横切面只有"执行命令"与"派生子代理"——两者都由宿主的既有机制承担。

## 环境要求

- **dsh `0.2.0-rc.2`**（九个 `@deepseek-ai/dsh*` 包精确锁定版本；`cordis ~4.0.4`、
  `cordis-plugin-timer ~1.1.6`）。版本不符时装载会直接失败（下文用"红"指测试或检查不通过），不会静默错版。
- Node ≥ 20。
- 本包**不从 npm 分发**：主安装路径是 dsh 原生形态
  `dsh plugin --profile web add github:MC5Spear/dsh-async-tools`（见下）；
  要改本包源码的贡献者另有 clone + 链接路径。

## 装什么、装在哪

**一个包，两副角色**：

| 角色 | 平面 | 怎么触发 | 提供什么 |
| --- | --- | --- | --- |
| 工具角色 | **预设平面** | 预设组合里 `name: dsh-async-tools` 的行，`config.toolName` 指定工具 | 五个工具之一（`lib/index.js` 按 `toolName` 分派工厂；`async_workflow` 只在 delegation 组内行上有效） |
| 宿主角色 | **宿主平面** | 本包自带 `cordis.patch.yml` 插的那一行（无 `toolName`），包名进 profile 的 bundles | 插件设置面：`client.js` 注册进插件管理页的 **`plugins.bundle.config`** keyed 槽（键 = **包名**）；宿主把它渲染在**本包插件页的描述与组件行之间**（16 个字段：10 预算 + 2 语言 + 2 开关 + 2 提问接管，官方表单形态，单「保存」动作）。**不注册任何工具** |

拆成两个角色的原因，是 dsh 的两条强制约束（见下节）：工具不能进宿主平面（会进全局工具层），
设置卡片必须在宿主平面（预设子树进不了客户端模块图）。

### 工具不限于这两个预设——任何预设都能加

本包交付两个预设模板：**`dsh-async`（异步模式）** 基于宿主自带的 standard 预设——通用编码工作；
**`dsh-async-create`（异步创造模式）** 基于宿主自带的创造模式预设——插件/预设创作工作，
其派生入口唯一化为 `async_agent`（宿主 `subagent`/`subagent_fork` 行保留但禁用，
取回走 `async_wait_agent`）。两个模板都替你把行写好了，新会话选一个就能用。
但**包本身不限制任何预设**——想在自己的预设里用这些工具，加同样的行就行：

```yaml
# 放进你自己的预设的 agent.cordis.yml，按需加一行、两行、三行或四行
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

**一行一个工具**：`toolName` 是单个字符串，取值 `async_run` / `async_wait_job` /
`async_wait_agent` / `async_agent` / `async_workflow`，所以只想要 `async_run` 就只加第一行。
前四个可以放进预设的任何组；**`async_workflow` 必须落在 delegation 组内**——它依赖组内隔离的
编排引擎服务，摆在组外那一行拿不到服务。两份随包预设都替你放好了，自己写的时候照它们的位置摆。
这与 `tool-subagent` 等内建行是同一个成例。

> **`toolName` 没有默认值，缺省 = 宿主角色**。本包自带的宿主行（`cordis.patch.yml`）
> 合法地没有 `toolName`，`Config({})` 必须放行，入口按缺省分派到宿主半边——
> **一个工具都不注册**。防的是这件事（`async_run` 会起真实 shell，"少写一个字段"
> 不该等价于"装上最危险的那个工具"）。
> **不得给 `toolName` 加默认值**——默认值会让宿主行静默变成工具行，工具泄漏进全局工具层。

**⚠️ 在别的预设里加这几行，环境与 `dsh-async` 预设不同**：本预设为了让"命令不再钉死会话"
这件事成立，**刻意不挂 `@deepseek-ai/dsh-tool-pwsh`**（同步 shell，用 `async_run` 替代它）；
`tool-bash` 行保留但**无条件禁用**（两个平台的同步 shell 工具清单一致为空）。
你自己的预设如果本就提供同步 shell，那么加完这些行之后是**同步命令 + 异步工具并存**——
这通常是你要的，但**两个都能跑命令**，预算与并发要自己掂量。

> **⚠️ 一条容易读错的口径**：本文档里的"**预设平面**"是**组成平面**的术语，
> 意思是"我们把这些行写在了预设文件里"，**不是**"这些工具只在某个预设里可见"。
> 一条工具是否在某个会话里可选，取决于**该会话的预设组成里有没有那一行**。
>
> 真正必须守住的约束是**反方向**的：**工具行绝不进宿主平面**——
> 宿主平面注册的工具进全局工具层，会出现在**每一个**预设里，那就是**强行塞给所有人**了。
>
> 也就是说：**别人可以自愿加，我们不可以强行装。**

```
D:\src\dsh-async-tools\              ← 唯一的包（两副角色都在这里；克隆位置自选，例中用 D:\src）
    cordis.patch.yml                   宿主行（无 toolName → 宿主角色）
    presets/dsh-async.patch.yml        预设补丁（dsh-async「异步模式」：基线 = shipped standard）
    presets/dsh-async-create.patch.yml 预设补丁（dsh-async-create「异步创造模式」：
                                       基线 = shipped 创造模式，派生入口唯一化为 async_agent）
    client.js                          设置表单的浏览器半边（插件管理页 plugins.bundle.config 槽）
你的 DSH profile 的 node_modules\
    dsh-async-tools                → 指向上面的克隆目录（预设行与 bundles 里的包名都解析到它）
```

> **形态**：预设随本包的 patch 数组交付（`package.json` 的 `dsh.bundle.patch` 是
> `cordis.patch.yml` + `presets/dsh-async.patch.yml` + `presets/dsh-async-create.patch.yml`
> 三项），**不向用户预设根落任何文件**，也没有备用卸载命令。预设的生命周期归宿主的
> loader/fiber：包进了 bundles 就在，出了就不在。
>
> 上图是**备选路径**（clone + 链接，见下节）的形态；主路径（`dsh plugin add`）没有独立
> 克隆目录——包由 pnpm 直接装进 profile 的 `node_modules`，终点形态相同（包名解析到包本体）。

### 安装

**主路径：dsh 原生形态**（一条命令，pnpm 替你从 GitHub 拉源码、解析依赖）：

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools
```

- `dsh plugin` 把参数**原样转发**给 profile 目录里的 pnpm（profile 首次使用时会初始化）；
  `github:owner/repo` 是 pnpm 原生支持的 git 源形态，spec 后面还可以接 `#` 加 ref 或标签
  锁定到某个版本。
- **GUI 同款**：插件管理页的安装对话框里粘贴同一个 spec 即可——与 CLI 同一安装引擎，
  对话框先 inspect 再安装，包管理器的输出折叠可见。
- 装完**重启一次实例**（组合树在启动时构建一次）。
- 宿主对 git 源插件有专门的错误提示（git 源的 `prepare` 脚本要经确认才会跑）；本包纯 JS、
  无构建步，不涉及。

**备选路径：clone + 链接**（要改本包源码的贡献者用——改的是克隆目录里的文件，联接让
profile 解析到它）：

```powershell
# 1) 克隆并装本包自己的依赖（克隆位置自选，例中用 D:\src）：
git clone https://github.com/MC5Spear/dsh-async-tools.git D:\src\dsh-async-tools
cd D:\src\dsh-async-tools
npm install

# 2) 建部署副本（目录联接）。先把 $dshProfile 指向你的 DSH profile 目录：
$dshProfile = "…你的 DSH profile 目录…"
cmd /c mklink /J "$dshProfile\node_modules\dsh-async-tools" "D:\src\dsh-async-tools"

# 3) 包名进 profile 的 bundles **与 dependencies**（宿主行与设置卡片靠它）。
#    编辑 $dshProfile\package.json：
#      dsh.profile.bundles 里加 "dsh-async-tools"
#      dependencies 里也要有它——**只进 bundles 不进 dependencies 的包在插件页完全不出现**
#      （服务端一切正常，但设置卡片没有入口）
#    ⚠️ 包**必须**声明 `dsh.bundle`（本包自带 cordis.patch.yml）——进了 bundles 却没有
#       bundle 声明的话，宿主启动会**直接失败**（"declares no dsh.bundle"）。

# 4) 重启一次实例（组合树在启动时构建一次）
```

**预设不需要手工放**：预设是 bundle patch 数组里的 insert 行，随包声明、随 fiber 装载卸载，
没有安装/对账这一步。

### 哪些改动要重启、哪些不用

| 改了什么 | 要不要重启 | 为什么 |
| --- | --- | --- |
| **改预设补丁的内容**（`presets/*.patch.yml`） | **要** | 预设组成在启动时随组合树构建一次（`dsh.bundle.patch` 同理） |
| 改 `lib/` 里的实现 | **要** | 插件模块在装载时 `import` 一次；不重启就还是旧代码 |
| 改 `package.json` 的 `dsh.profile.bundles` / `dsh.bundle.patch` | **要** | 组合树在启动时构建一次 |
| 改 `package.json` 的 `dsh.client` / `exports['./client']` | **要** | 客户端模块图在启动时组合一次；不重启则设置卡片不出现（且**不报错**） |
| 新装/升级本包（主路径 `dsh plugin add` / GUI 安装；备选路径即新增部署副本） | **要**（首次） | 包名要在 profile 的 `node_modules` 里解析到，组合树要重建一次才会挂上 |

> ⚠️ **如果你的实例由服务管理器托管，重启要在服务进程树之外执行。** 常见的管理器
> （如 nssm 默认配置）会在停服务时**杀掉整棵进程树**——在树内发起的重启，命令自己也被杀，
> "启动"那一步永远执行不到，服务停在 STOPPED。从交互式会话、计划任务或另一台机器发起。
> 也**不要在别人正在干活的实例上随手重启**——那会终止它上面所有的活动会话。

### 两条平面约束（都是实测，不是偏好）

**① 工具行不能进宿主平面。** 宿主平面的插件注册的工具会进**全局工具层**：`standard` 预设的
会话里会同时出现内置 `pwsh` 与本包的工具，其他预设的工具集全被改动。

**② 宿主行的行名必须是平名。** 宿主只把**平名**包纳入客户端模块图：`dsh-client-modules` 的
`exactPackageSpecifier` 只接受不带 `/` 的平名或 `@scope/name` 两段式
（`[@deepseek-ai/dsh-client-modules@0.2.0-rc.2] lib/index.js:76-88`）。行名带子路径时那一行被
**静默跳过**——设置命名空间照常注册、服务端可读可写，但 `client.js` 永远进不了 `index.html`
的注入表，**设置卡片不渲染且没有任何报错**。这正是宿主半边放进 `dsh-async-tools` 本体
（而不是挂一个 `dsh-async-tools/host` 子路径行）的原因：本包名本身就是平名。

### `async_agent` 的指定路由与会话模型选择策略

两预设的会话由本包 `async_agent` 行在创建时落一条模型选择策略（持久事件
`subagent/model-selection-policy` → 投影 `subagentModelSelectionPolicy`，与宿主 standing 行
**同键同版同形**——`lib/agent-policy.js`，由 `verify/check-agent-policy.mjs` 与宿主源整段互锚）。
因此 `async_agent` 带 `provider`/`model` 的**指定路由**调用在这两预设内可用——只要全局白名单
开着且路由在名单内。不带 `provider`/`model` 的派生照旧继承父路由，不受白名单影响。

**全局白名单在这两预设内的口径**：

- 白名单开 + 路由在名单内 → 指定路由可用；名单外的路由被可读拒绝。
- 白名单关 → 新会话无策略，指定路由得到可读拒绝；免路由派生不受影响。
- **坏配置在创建时直接报错且原因可读**：白名单开启且名单为空或非法时，新会话创建直接被拒绝
  （与宿主 standing 行同姿态，不静默降级）。修正设置后即可恢复。
- 策略是**创建时定格**：事后关白名单不收紧既有会话；事后编辑名单也不追加到既有会话。

## 卸载与回滚

**主路径装的（`dsh plugin add` / GUI 安装）**：在插件管理页卸载——它先把组合包移出
bundles（宿主行与预设 insert 行都在本包的 patch 里，包名一出 bundles 就都不在了），
再走包管理器把依赖删掉；需要先停 profile 的场合它会明说。
要走 CLI，注意 `dsh plugin --profile web remove dsh-async-tools` **只删依赖、不动
bundles 条目**——用它的同时要自己把 profile 的 `package.json` 里那条 bundles 移掉，
否则会留下一条指向已删包的勾选，宿主启动时报解析失败。

**备选路径装的（clone + 链接）**：从 profile 的 bundles 里移除 `dsh-async-tools` 即可
（宿主行与预设 insert 行都在本包的 patch 里，包名一出 bundles 就都不在了）。

移除后**重启一次实例**（组合树在启动时构建一次）。删部署副本是可选收尾——留着也无害，
没有行引用它，包就不会被加载：

```powershell
# 备选路径的部署副本是一个目录联接。先把 $dshProfile 指向你的 DSH profile 目录：
$dshProfile = "…你的 DSH profile 目录…"
cmd /c rmdir "$dshProfile\node_modules\dsh-async-tools"
```

**只回滚一个预设**（保留另一个）：从 `package.json` 的 `dsh.bundle.patch` 数组里删掉对应的一项
（如 `./presets/dsh-async-create.patch.yml`）再重启——只有那一条预设声明消失，另一个预设与
其余行为不变（数组每一项独立声明一条 insert 行）。

## 用起来是什么样

在 `dsh-async` 预设下，模型可以直接调用这五个工具
（`async_workflow` 需 delegation 组内行——两份随包预设都已带）：

```
CALL   async_run      {"command":"Write-Output SHORT_OK"}                      → SHORT_OK
CALL   async_run      {"command":"Start-Sleep -Seconds 6; Write-Output LONG_DONE","yield_ms":1500}
       RESULT the command is still running: it exceeded the 1500 ms yield budget
              (about 1525 ms so far) and was not terminated; it continues in the
              background. … async_wait_job(job_id="async-command-1", wait_ms=30000)
CALL   async_wait_job {"job_id":"async-command-1","wait_ms":20000}             → LONG_DONE
```

用户插话（steer）时：

```
CALL   async_run      {"command":"Start-Sleep -Seconds 60; Write-Output SURVIVED","yield_ms":1500}
CALL   async_wait_job {"job_id":"async-command-7","wait_ms":120000}
       RESULT wait interrupted: the user's message has been delivered and will
              appear as your next input (waited 368 ms). Job async-command-7 is
              still running in the background, unaffected. …
CALL   job_list {}    → async-command-7 [async-command] running — Sleep 60 seconds …
CALL   async_wait_job {"job_id":"async-command-7","wait_ms":90000}             → SURVIVED
```

**368 ms 返回，60 秒的作业既没被取消也没丢输出。** 排队（queue）的消息**不会**打断等待——
它在当前轮次彻底结束后才被投递。入口检查扫一次收件箱即返 interrupted（`async_run` 的让出窗口不在此列）。

`async_run` 自己的让出窗口（首次返回前）同样可打断：

```
CALL   async_run      {"command":"Start-Sleep -Seconds 60; Write-Output BG","yield_ms":60000}
  ···（约 10 秒后用户插话）···
       RESULT the command continues in the background. The yield ended early:
              a user message arrived (about 10231 ms elapsed); the command itself
              is unaffected and still running. … async_wait_job(job_id="…", wait_ms=30000)
```

三条口径：

- **任何信号只结束等待，不终止命令**——用户插话立刻拿到句柄（note 注明提前让出）；
  GUI 的「停止」把可见结果整体改写为 aborted，但作业**存活**，结算时一条完成通知送达
  （abort 后模型的恢复通道）。
- **短命令零通知不变**：预算内完成的等待是活等待，宿主不补发完成通知；
  句柄路径（插话/停止/迟到/预算到期）撤销在先，结算后恰一条完成通知。
- **作业从执行一开始就注册**（label = 命令原文、progress 行 = description）：让出前
  任务面板就能看到它；触顶时准入先于进程启动——错误文案明说「没有进程在运行」，
  并列出存活作业与上限。

> 模型面文案默认英文档；`agentLang` 可切完整中文档。行为不变，变的是文案语言。

## 生效的数字（可以改，改完要重跑验证）

### 改哪里才有用：设置的层叠与优先级

**设置表单在界面上长什么样**：插件列表里点开本包（`dsh-async-tools`）的页面——**描述下方、
组件行上方**就是设置表单本体。不需要点任何组件行，也不需要先进子页。两条前置条件：
包名必须同时出现在 profile 的 `dependencies` 与 `bundles`（**只进 `bundles` 的话插件页里
完全不出现它**，而服务端一切正常）；页面必须从 loopback 源打开（非 loopback 源的页面
**读不到也写不进**设置）。

**表单形态与官方设置页同源**：16 个字段的控件、字段行、说明行、覆盖徽标与页脚按钮都用官方
共享控件（`@deepseek-ai/dsh-client-ui-primitives` 的 `SettingsForm` / `SettingsValueField` /
`SettingsFormModel`）；动作只有一个「保存」（无改动/非法草稿/保存中禁用，失败时页脚显示失败
文案并保留草稿；丢弃 = 离开页面清空草稿，成功不弹文案）。毫秒字段的说明行带**两段**秒数读数：
字段说明**换行**接 `生效：600 s · 输入：600 s`——行首不带点、值只写秒文本（亚 10 ms 显示
`< 0.01 s`，空输入占位 `—`）；生效段跟生效配置走，输入段**未保存就随键入刷新**。

三层，从低到高：

```
schema 默认值  <  宿主行 config（cordis.patch.yml 宿主行的 config: 段）  <  设置卡片保存的 volatile 提交
```

设置卡片直接编辑宿主行 Config 上标了 `.volatile()` 的字段，loader **就地提交**（fiber 不重启）
→ 宿主行重建快照 → 通知工具行就地改写描述。

**关键一条：预设工具行的 `config` 不参与这条层叠。** 工具行里的 `config` 只带
`toolName`（决定该行注册哪个工具）。预算字段写在工具行 `config` 里不会被读到——
那是这套层叠最容易踩的一点。

**两个语言开关互不牵连**：`uiLang` 只管设置表单自己与待答面板的可见文案（`跟随界面语言` 时
用宿主的全局语言；选 `中文`/`English` 则由本包自己选词典，不改宿主语言），`agentLang` 只管
模型收到的东西（五个工具的描述、参数说明、`note` 与状态文案）。改一个不会动另一个。

| 想改的东西 | 改哪里 | 生效条件 |
| --- | --- | --- |
| 让出/等待预算、轮询间隔、输出上限、作业 kind、子代理后端 | **插件设置表单**（宿主行的 volatile 字段） | 保存即生效（volatile 就地提交，无需重启） |
| 设置表单语言、模型面文案语言 | **同一个表单里的两个下拉**：`uiLang` 与 `agentLang` | 保存即生效：`uiLang` 当场换表单文案，`agentLang` 在下一次工具描述刷新时换模型收到的描述 |
| 静默失败防线 | **同一个表单里的开关**：`silentFailureGuard` | 保存即生效（结算诊断、描述警告段、系统提示纪律段三处同换） |
| 该插件在所有部署里的出厂值 | 本包 `cordis.patch.yml` 宿主行加 `config:`（**只准预算字段与 `subagentProvider`，禁止 `toolName`**） | 需要重启（组合树在启动时构建一次） |
| 某个预设用哪个工具（`async_run` / `async_wait_job` / `async_wait_agent` / `async_agent`；`async_workflow` 的行必须在 delegation 组内） | 预设补丁那一行的 `config.toolName` | 下次会话挂载该预设时生效 |

一句话：**预算数字改设置卡片；`toolName` 改预设行。**

### 静默失败防线（默认关）

受限沙箱下有个陷阱：带**捕获形**（`2>&1`、`$(...)`、变量赋值、重定向）的外部 EXE 命令会死在
进程创建层——**零输出、无退出码标记**，从结果侧无法与「跑完没输出」区分；管道形则留下可见
拒绝（`Program 'pwsh.exe' failed to run: Access is denied`——被拒的是哪个可执行文件，
报错里显示的就是哪个）。`silentFailureGuard` 开关同时布三道
防线：

1. **结果侧自诊断**（`lib/silent-failure.js`）：`async_run` 结算时按两条签名识别——捕获形 +
   空输出 + 非沙箱拒绝 + 非提权重跑 → note 提示「可能根本没跑，先裸调用验证」；输出含可见拒绝
   锚对（`failed to run` + `Access is denied`）→ note 提示「这是沙箱拒绝，带
   `sandbox_permissions` 重试一次」。前台/后台两个出口都盖。
2. **描述警告段**：`async_run` 的工具描述尾部追加捕获形警告（无提权语境时自动隐藏——
   只在广告了提权键的部署里出现）。
3. **系统提示纪律段**：宿主行注入一条上下文——**所有会话可见，不挑预设**，给模型两条纪律
   （空捕获 = 没跑；防杀退出码 4294967295）。

误报范围（良性空输出的捕获形也会被提示）是**有意的取舍**：宁可误报，也不漏报。

### 提问接管（默认关）

两预设的 Agent 用 `ask_user_question` 提问时，如果没人盯着页面，问题会**永远悬着**——
会话停在原地。`askTakeover` 开关把这条提问链接管过来：

1. **超时放行**：批次**未被暂停**时，有效倒计时耗尽（到 `askTimeoutMs`，默认
   60000ms）还没人答，就在工具结果里放一条**合成答案**（`The user has not
   answered within N s: proceed with your best judgment; …`）——暂停中的批次
   倒计时冻结，不参与到期判定。合成的是「超时事实」本身，**不是替用户选答案**
   ——Agent 只知道没人答。
2. **暂停/恢复（批级）**：每个会话组的组头有暂停/恢复开关。暂停冻结该组**当下
   在窗批**的倒计时（撤定时器、记剩余、冻结到期点）；恢复按剩余续走（到期点
   平移）。暂停状态**以批为单位、不跨批存续**：一批出窗（齐答/忽略/中止/超时
   放行）即消失，**新到批次总是从全额窗口的计时开始**，不因同组存在暂停批而
   自动暂停；暂停中的批次照样可以作答/忽略。会话之间严格隔离——一组的暂停/
   恢复不触碰其他组的计时。
3. **并存组的开关口径**：同组里既有暂停批又有计时批时，开关显示「恢复计时」、
   点击只作用于暂停批（一键一动作，不设混合第三态；连点两下可到任一目标态）；
   组内全部计时批时显示「暂停计时」、点击作用于全部在窗批。
4. **全局待答界面**：接管后每个悬置的问题都会出现在全局待答面板（会话分组逐题列出，支持
   选项 chip、多选、自定义作答；暂停中的条目显示「已暂停」、倒计时冻结，超时
   放行的条目留列带超时徽标供迟到作答）。座位由 `askUiSeat` 枚举切换：`overlay`（右下角浮窗，默认）
   或 `sidebar`（侧栏徽标，点开同款浮窗）——同一个组件换座位，行为不变。
5. **迟到作答注入（通知形，按状态选通道）**：超时后问题仍留在面板（带超时徽标）。事后补答，
   会以**通知形消息**（自声明来源 kind、`form: 'notice'`、一句话 summary，正文自含完整题面：
   稳定 id、题干全文、选项全集、multiSelect、作答或忽略、custom、时延）按 Agent 状态选通道
   注回该会话：**空闲**且没有未开跑的本包投递 → 立即唤醒开回合（单条也立即）；**运行中**
   （含正在 `async_wait_*` 等待）或空闲但自家投递还没开跑 → 折入下一领取点（同窗口多条由宿主
   **整批领取**，不串行开回合）。等待中的 `async_wait_*` 由**插件事件**（作答到达即刻发出）
   提前唤醒，工具返回「仍在运行」句柄 + 提示，不是打断。

这几个设置字段都在设置卡片上（与 `silentFailureGuard` 同一张表单）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `askTakeover` | `false` | 总开关。关 = 插件对提问链零干预（原生行为） |
| `askTimeoutMs` | `60000` | 超时窗口（下界 10000ms，防误设秒级误触发） |
| `askUiSeat` | `overlay` | 待答界面座位：`overlay` / `sidebar` |
| `uiLang` | `auto` | 待答界面语言：`auto`（跟随宿主语言）/ `zh` / `en` |

**边界（这几样不碰）**：计划评审卡、审批链、`standard` 等其他预设的提问——接管只认
两个随包预设根 Agent 的非计划评审提问。

### 参数默认值与上界

| 参数 | 默认值 | 上界 | 说明 |
| --- | --- | --- | --- |
| `defaultYieldMs` | 20000 | 2147483647 | `async_run` 的让出预算默认值 |
| `minYieldMs` / `maxYieldMs` | 1000 / 600000 | 各 2147483647 | `yield_ms` 的允许区间 |
| `defaultWaitMs` | 30000 | 2147483647 | 回退等待默认值 |
| `minWaitMs` / `maxWaitMs` | 250 / 600000 | 各 2147483647 | `wait_ms` 的允许区间 |
| `pollIntervalMs` | 500 | 2147483647 | `async_wait_agent` 的备用状态轮询间隔；**不得大于 `maxWaitMs`** |
| `maxResultChars` | 30000 | 1000000 | 单次返回给模型的字符上限（按**字符**算，不是字节） |
| `askTimeoutMs` | 60000 | **600000** | 提问接管的超时窗口；下界 **10000**（防误设秒级误触发）。**上界与上面七个不同**，见下 |
| `jobKind` | `async-command` | — | 后台作业的种类名 |
| `subagentProvider` | `spawn` | — | `async_agent` 的子代理后端名（非数字；无效名字在下一次调用时报可读错误；空串回默认） |

**上界的为什么**——**八个毫秒字段，两种上界**：

- **七个预算毫秒字段**封 **2147483647**（2³¹−1）：Node 的 `setTimeout` 延迟越过它会被置 1ms
  **立即触发**，等待上限会当场失效。这七个是 `defaultYieldMs` / `minYieldMs` / `maxYieldMs` /
  `defaultWaitMs` / `minWaitMs` / `maxWaitMs` / `pollIntervalMs`。
- **第八个毫秒字段 `askTimeoutMs` 封 600000（10 分钟）**——它不进"必须封 2³¹−1"那一档：
  这是个**人作答的窗口**，量级与等待字段一致即可，10 分钟已经远超"在场用户读完题并点选"；
  下界 10000 则是防"在场也来不及答"，再短接管就只剩打扰。
- `maxResultChars` 封 **1000000**，与作业环形缓冲的 `outputLimitBytes = maxResultChars × 3`
  联动（上界 3MB/作业）。

上界在两层拦：设置卡片的草稿校验（越界草稿禁保存并给出带数字的原因）与服务端
`resolveConfig`（`.max()` 可读报错）。两处常量同源（`lib/budget-limits.js` 的
`FIELD_MAX`；客户端内联同值，对账测试拦漂移）。

**`pollIntervalMs ≤ maxWaitMs` 联动**：轮询间隔比整个等待预算还长没有意义，且会放大
`async_wait_agent` 屏障的重试窗口（总时长上界 = `waitMs` + 3×`pollIntervalMs`）。
配对违例在设置卡片上当场禁保存（草稿两侧都在场才比较），服务端解析同样拒绝。

**`wait_ms` 的覆盖口径**：一次等待调用的"有界"指**总时长**有界——屏障（≤3×`pollIntervalMs`）
+ 等待段（≤`wait_ms`），不是只有等待段。

各类违例的拦截时机不同：

- **逐字段违例**（非正整数、越出单字段区间、**越过上界**）——设置卡片保存那一刻就被拒
  （草稿校验走官方 parse 通道），服务端 `Config` 同款拒绝，不会写进设置文档；
- **跨字段违例**（`min > max`、`pollIntervalMs > maxWaitMs`）——schema 面表达不了
  （包一层 transform 会让设置表单整体消失），卡片层把违例叠加进保存禁用，服务端在
  `assertCrossFieldOrder` 拒绝；若仍被绕过（直写设置文档），会**先提交**：工具快照保住旧值
  继续按旧值运行、stderr 告警说明哪次提交没生效，设置卡片显示的是原始值；下次重启时宿主行
  忽略这份持久化的非法设置、按出厂默认运行并在 stderr 说明（行保持激活，改正保存即恢复）。

### 信息暴露范围（模型可控文本的去向与子进程环境）

- **日志插值**：模型可控的字符串（`description`、job_id、agent_id）进操作者日志行前一律
  单行化。注册失败时宿主原文**单行化 + 500 字符截断**后才进模型可见的错误（完整原文含换行
  留在操作者日志，不丢线索）。
- **子进程环境**：`async_run` 传给命令的环境变量就是宿主 `ctx.shellEnv.collect(exec)` 的
  返回值（内建键 + 贡献键）。本包**不自造、不追加、不改键集**。贡献键按部署增减——
  枚举以 `collect()` 现读为准。
- **输出落盘（spill）**：后台输出超内存上限时宿主把溢出写到**系统临时目录**，读取结果里给出
  `spillPath`。那是找回被丢弃输出的**唯一线索**——`async_wait_job` 的渲染必须带它，
  与"部分输出被丢弃"的说明一起进模型可见文本。

描述里的数字随设置变化——宿主行收到 volatile 提交通知后重建快照，经同进程的模块级登记表
通知预设平面的工具就地改写描述（跨平面走 `lib/refresh-bus.js`）。

`toolName` 是**唯一**只在预设行里有意义的配置项：一个包被预设引用四次，靠它决定那一行注册
哪个工具。它不参与上面那条层叠。

## 验证

包内自检（不碰真机、不起进程）：

```powershell
npm run test:inproc   # 完整测试套件（推荐）：单元 + 接线测试 + 输出 schema 校验 + inject 静态扫描
npm run check         # 语法检查（lib/ + test/ + tools/）
npm run check:preset      # 预设 YAML 校验：行头三元组、基线行集合逐项按序、五行 async-tools、
                          #   无 tool-pwsh、persona 锚句、派生入口结构性禁用、provider 形态、无护栏
npm run check:public-surface  # 公开面边界：结构合规 + 本机指纹零命中 + 内部引用零命中
npm run check:encoding    # 编码体检：非法字节 / 双重编码 / CRLF（`.gitattributes` 钉 LF）
npm run check:docs        # 文档结构 + 现行文档的历史叙述词归零
npm run check:model-text  # 模型面文案四层判据（en 零 CJK / zh 每键含中文 / 两档键集相等 / 硬编码与运行时兜底）
npm run check:alias-tokens  # 主题别名：`client.js` 引用的 `--dsw-alias-*` 必须在主题定义表内
npm run check:agent-policy  # 版本锚定看守：本包的会话模型选择策略与宿主源整段互锚（宿主改形而本包未跟即红）
```

另有 `npm run test`（不强制进程内隔离，CI 与本地都可用）与 `npm run test:offline`
（同一套用例的离线形态：测不到宿主锚的接线类用例**自动跳过并打印理由**）。

**这套测试需要一个"宿主锚"**：本包的九个 peer 都来自宿主安装树，仓库本地没有
`node_modules/@deepseek-ai/*`。三种给法，任选其一：

```powershell
# A) 环境变量指到宿主安装树的 node_modules（最直接；把 C:\dsh 换成你的 dsh 安装目录）
$env:DSAT_HOST_MODULES = "C:\dsh\node_modules"; npm run test:inproc

# B) 本机配置文件（推荐；形状见 tools/local-config.example.mjs，复制成 .local/config.mjs）
#    加载器解析顺序：环境变量 → .local/config.mjs → 文档化跳过

# C) 干脆把宿主装成普通依赖（CI 用这条，见 .github/workflows/）
npm install --ignore-scripts @deepseek-ai/dsh@0.2.0-rc.2
```

测不到宿主锚时，接线类用例**自动跳过并打印理由**（不是静默放过）；`npm run test:offline`
是同一套用例的离线形态。**注意**：宿主锚不只是测试的事——`npm run check:preset` 还要拿本包的预设补丁与**宿主树里的基线补丁**逐行比对，缺锚会显式失败并点名。

**端到端必须在真机实例上跑**，不能拿单测的结论替代。脚本清单、各自的前提（哪个会开会话、
哪个会改设置、哪个会起浏览器）与"跑完要确认什么"见 [`verify/README.md`](verify/README.md)。
那些脚本连的是**你自己那台实例**，坐标经 `.local/config.mjs`（或环境变量）给，不在代码里。

## 两条守着的强制约束

两条都是"测试全过、真机一跑就废"的形态——**全过不代表对**，所以要专门的断言来看住。

1. **假件测试证明不了 `inject` 声明完整。** `async_wait_job` 与 `async_wait_agent` 的截止与
   轮询定时器走 `ctx.timer.timeout` / `ctx.timer.interval`；假件里的 `ctx.timer` 是测试自己造的
   替身，根本不过 cordis 的服务声明校验，所以漏声明 `'timer'` 时单测照绿、真机上这两个工具
   一调就废。
   （**`async_run` 不走 timer**——它的让出窗口走宿主的 `jobs.wait`，且请求显式
   `onExpiry: 'none'`，正是不让宿主的到期去杀进程。所以这条缺口在 `async_run` 上反而看不出来，
   而在两个等待工具上必现。）看住它的是一条**静态扫描**：
   对 `ctx` 的具名服务访问（`ctx.timer` 这类写法）必须是 `inject` 的子集，
   `ctx.get('字面量')` 这种第二种写法也必须
   被看见，例外只有 `OPTIONAL_SERVICE_READS` 里那几个——每个都必须在测试里写明
   **为什么它可以缺席**。
2. **输出 schema 要在测试里真的喂一遍。** 该 DSL 的 `type` 只接受**单个**类型串
   （写不出"可空"）：若完成分支写出 schema 声明之外的可空值，**匹配 0 支**，宿主抛
   `returned invalid output`，任何没让出的 `async_run` 调用都会失败。看住它的是 `test/_helpers.mjs` 的
   `assertOutputShape` / `checkedTool`：把"返回值符合自己声明的 `output.schema`"变成每条
   用例的固定动作。

## 改这个包时的三条纪律

**一、`lib/`、`test/`、`docs/` 下的文件只用编辑工具改**，不要用 PowerShell 的
`Get-Content -Raw` + `Set-Content` 往返重写——Windows PowerShell 5.1 默认按 ANSI 读、还会写
BOM。同理，**不要用内联 `node -e` 处理带反引号或中文引号的文本**：PowerShell 会先解释那些
字符，正则与模板串必然被打坏。要批量改就**写成 `.mjs` 脚本文件**。

**二、"改坏看看测试会不会红"只在包外副本上做**，不要回写被审文件。变异有两种形态，按判据的
形状选：**判据是测试文件里的**，变异必须跑那个文件（跑错了会报 MISSED，看起来像"断言是空的"，
实际只是没跑到它），所以那种脚本自己声明跑哪个 `TEST`；**判据是纯函数的**，变异把源码文本
改坏后直接喂纯函数——**在内存里做、不落盘、不 spawn 子进程，因此默认权限下就能跑**：

| 脚本 | 跑的测试文件 | 覆盖 |
| --- | --- | --- |
| `verify/mutate-escalation-removed.mjs` | `test/escalation.test.mjs` | 提权整段拿掉 |
| `verify/mutate-steering.mjs` | `test/interrupt.test.mjs` | 插话判定三个方向：落点判定拿掉（queue 也打断）/ 恒 false（插话也不打断）/ kind 过滤拿掉 |
| `verify/mutate-escalation-order.mjs` | `test/escalation.test.mjs` | 审批顺序倒置（挪到 `shell.resolve` 之后） |
| `verify/mutate-card-theme.mjs` | `test/two-planes.test.mjs` | 卡片样式写死颜色 |
| `verify/mutate-agent.mjs` | `test/agent.test.mjs` | 前台形态回潮（`startContinuable`→`start`，哨兵必红）；删 persona 强制规则段（另跑 `tools/validate-preset.mjs` 校预设补丁，锚句必红） |
| `verify/mutate-yield-example.mjs` | `test/output.test.mjs` | `yieldNote` 示例写死 `wait_ms` |
| `verify/mutate-config-slot.mjs` | `test/two-planes.test.mjs` | 设置卡接线七向：挂回 `plugins.item` / 退回组件行子页 / 槽键改错 / 注册整段废掉 / 去掉守卫 / 表单改读 `props.form` / 不订阅模型的快照 store |
| `verify/mutate-r27-form.mjs` | `test/two-planes.test.mjs` | 官方表单形态判据十向：值字段换回自绘 input / 恢复默认换成即时写 / 数字 parse 恒放行 / 空暂存也发 mutate / failed 恒假 / shell 退化成常量 / 输入读数接生效值 / 只读时藏读数 / 删空文本分支 / onDiscard 传 noop |
| `verify/mutate-lang.mjs` | `test/two-planes.test.mjs` | 双开关判据十二向（进程内、喂 `verify/lang-judgements.mjs` 的判据）：agentLang 没生效 / 中文档半译 / 英文档混中文 / 改一个顺带动了另一个 / 字段身份被换 / 字段数不足 / 收尾没复原 |
| `verify/mutate-list-children-shape.mjs` | `test/wait-agent.test.mjs` | 子代理行形状退化三向：屏障只认一种 kind / 纠错清单按 kind 过滤（清单恒空）/ 不排除诊断行 |
| `verify/mutate-r55-entry-scan.mjs` | `test/wait-agent.test.mjs` | R55 起始检查五向（另跑 `test/interrupt.test.mjs` 与 `test/wait-job.test.mjs`，两工具的判据各有落点）：纯事件驱动回潮（起始检查拆除，挂起护栏保红得快）/ 拆 kind 过滤 / 加扫 next-turn / wait-agent 去结算并存决定 / wait-job 停点前移 |

另有**检查器自测**，改的不是交付实现、而是检查器本身，因此不进上表
（它们由 `tools/check-mutate-index.mjs` 的豁免名单登记，名单里也要求"必须真实存在"）：

| 脚本 | 验什么 |
| --- | --- |
| `verify/mutate-mutate-index.mjs` | `tools/check-mutate-index.mjs` 的两头（表→盘、盘→表）都能失败 |
| `verify/mutate-doc-paths.mjs` | `tools/check-doc-paths.mjs` 能拦住悬空的文件路径与 npm 脚本引用 |
| `verify/mutate-bare-filenames.mjs` | `tools/check-bare-filenames.mjs` 能拦住悬空的**裸文件名**（那是路径检查器的盲区） |
| `verify/mutate-facts-anchors.mjs` | 事实依据检查器的三条判据都能失败（行号越界 / 引用不存在的文件 / 四字段不齐） |
| `verify/mutate-r24-ui.mjs` | R24/R27 的界面判据（五个纯函数）都能失败：下发字节挂错槽 / 字段身份错位 / 秒数读数缺失或挂错字段 / 设置区不在插件页 / 两段读数不跟快照 / 字段没回生效值（30 条变异，任一条没红即 UNCAUGHT） |
| `verify/mutate-model-text.mjs` | `tools/check-model-text.mjs` 的硬编码文案层能失败 |
| `verify/mutate-alias-tokens.mjs` | `tools/check-alias-tokens.mjs` 能拦住未定义的主题别名引用 |
| `verify/mutate-agent-policy.mjs` | 版本锚定看守（宿主锚与本包锚整段互锚）能失败 |
| `verify/mutate-public-surface.mjs` | `tools/check-public-surface.mjs` 的三类判据（结构 / 本机指纹 / 内部引用）都能失败，外加四条**假阳性守卫**（上游包名、URL 与兄弟仓公开地址不得被误判） |

> ⚠️ **上表必须与盘上的文件一致**，由 `tools/check-mutate-index.mjs` **自动核对两头**
> （表里列的不存在 / 盘上有却没登记），并挂进测试套件——漂移会在跑测试时立刻失败。

**还有一个更阴的坑**：双重编码的字节**完全合法**、`U+FFFD` 计数为 **0**——只查非法字节的
扫描器会对一份彻底报废的文档报"全部正常"。所以 `npm run check:encoding` 的判据是**常用字
占比**（正常中文 > 0.85，双重编码 < 0.3），不是去找具体的乱码字。别把它换成"只查 `U+FFFD`"
的版本。

**三、写完交付文档后必须复跑完整测试套件再提交**（`npm run test:inproc` + 全部检查器），
读数如实标注取数时刻——不得把写文档之前的旧读数当提交时读数。**交付文档本身会让检查器变红**
（新加的路径引用、新的裸文件名），所以测试套件必须跑在文档之后。

## 文档地图

| 文件 | 是什么 |
| --- | --- |
| `README.md` | 本文：是什么、怎么装、怎么用、怎么验 |
| `docs/requirements.md` | 强制需求（R1–R45，含 0.1.7 适配线与 0.2.0 线）、非目标、验收标准 |
| `docs/design.md` | 设计：模块、`inject`、每个工具的语义、schema 本体、测试与交付 |
| `verify/README.md` | 真机验证脚本清单：各自的前提、副作用与"跑完要确认什么" |
| `CONTRIBUTING.md` | 参与方式与内容边界规则（公开面 / 本机平面的分法） |
| `CHANGELOG.md` | 版本变更记录 |

## 非目标

- 不做"宇宙中所有工具都异步"——那要改宿主 agent loop 的批次语义，插件覆盖不到。
- 不做同名遮蔽内置 `pwsh`（新工具名并存，靠预设隔离）。
- 不改动 dsh 任何源码，不打 patch。
- 不做 cloud / 远程执行环境适配。
- **不从 npm 分发**：安装走 GitHub 源（`dsh plugin --profile web add
  github:MC5Spear/dsh-async-tools`，见「安装」）；要改源码的贡献者用 clone + 链接。

## 许可与定位

[MIT](LICENSE) © 2026 MC5Spear。

**本包是第三方插件，与 DeepSeek 官方无隶属关系。** 它只通过宿主公开的插件接口接入
（`ctx.*` 服务、bundle patch、keyed 槽），**不改动、不重打包宿主的任何代码**——
`@deepseek-ai/dsh*` 是它的 **peer 依赖**，按版本精确锁定，装错版本会在装载时先红而不是静默错版。
宿主的许可与出处见那些包自身。

**参与方式**：本仓**不接受外部 PR**；issue 可提，但**不保证维护**（不承诺响应、修复或
时间表）；安全问题同样按普通 issue 提（不设漏洞管理流程），公开披露前请自行斟酌脱敏。
运行期安全边界见开头 [Security](#security) 一节。
