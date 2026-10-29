# 验证脚本与执行边界

本目录提供测试、探针和判断函数。先按本次要确认的问题选择入口：只检查文件和纯函数，读第 2 节；需要连接真实实例或页面，读第 3 节；需要恢复设置或诊断环境，读第 4 节；需要证明断言能发现错误，读第 5 节。真实运行产物另存，不放在本目录。

[需求的验收要求](<../docs/requirements.md#8-验收要求>)说明必须证明什么，[验证设计](<../docs/design.md#8-验证设计>)说明怎样验证，[当前实施与验证状态](<../docs/design.md#9-当前实施与验证状态>)区分已实现和待验证内容。下面各表说明现有脚本实际检查什么、还不能证明什么；脚本应随当前目标更新。

单元替身、宿主模块、真实实例和 GUI 的结果分别记录。文件检查通过不能代替实例验证，脚本存在或旧读数也不能证明当前目标已通过。

## 1. 配置、权限与安全前提

脚本通过[本机配置加载器](<../tools/_local-config.mjs>)取宿主模块树、实例 URL、认证文件和证据目录；形状见[示例](<../tools/local-config.example.mjs>)。不在源码写机器坐标。

先确认配置状态，再选择字段来源：

| 配置状态 | 处理与下一步 |
| --- | --- |
| `.local/` 整个缺席 | 依赖本机环境的探针打印理由并跳过，非失败退出；需要该项结果时，再准备授权环境 |
| 本机目录存在，配置缺失或加载失败 | 按配置损坏报错；对照示例修复，不用环境变量绕过检查 |
| 配置可加载，必要字段没有来源 | 打印缺少的字段；按调用方要求跳过对应判据或报错，补齐来源后再验证 |

通过配置检查后，普通字段按“非空环境变量 → 文件值”取值。`siblingBundles` 以文件数组为准，空数组 `[]` 表示只断言本包；文件未提供该字段时才回退到 `DSAT_SIBLING_BUNDLES`。

`evidenceDir`、`workspaceDir`、`tmpDir` 则按“对应环境变量 → 文件值 → 派生默认值”取值，默认分别为仓根下的 `.local/evidence`、仓根和仓根下的 `.local/tmp`。对应变量为 `DSAT_EVIDENCE_DIR`、`DSAT_WORKSPACE_DIR`、`DSAT_TMP_DIR`。完整字段规则见[参与指南](<../CONTRIBUTING.md#2-配置与探针准入>)。

运行前还要确认权限和数据范围：
- 认证在授权的 helper 内部读取，输出不打印令牌、cookie、秘密或含 token 的 URL。证据脱敏后写配置的 evidenceDir，不进公开仓。
- 优先默认权限执行；纯函数判断尽量进程内复用。确需子进程、浏览器或受限执行环境以外权限时，经正常审批，不能自动改会话全权限或绕过子代理限制。
- EPERM、加载失败、超时终止、无输出且没有执行证据，属于未完成验证，不算产品通过或目标变异被捕获。外部命令先裸调用确认执行，不能把捕获形静默失败读成成功空输出。
- 只用自己新建、标识明确的测试会话和隔离样本，不读取他人会话正文、不停止他人任务。真实危险操作用无害替身。
- 共享设置、安装卸载、实例重启和全权限切换都有副作用。执行前读脚本，确认明确授权、起始状态及恢复方式；finally 不保证所有终止路径都会还原。
- 浏览器反复启动可能触发本机登录审计／锁定策略；GUI 探针不加入无条件批量流程。宿主安装和模块版本现查，不依赖本机部署手册旧快照。

## 2. 只读及离线入口

### 不连接实例的静态检查

以下命令检查语法或文件内容，不连接真实实例。语法检查会启动子进程；部分检查会递归读取文件，文档检查还可能读取可选本机语料。主题别名检查另需本线精确目标的主题源：先按[来源准备与“枚举自”结果确认](<../CONTRIBUTING.md#主题别名检查的来源与结果确认>)操作，不能只凭退出码0认定目标版本通过。先阅读对应脚本，确认输入范围，再逐条选择：

```powershell
npm run check
npm run check:docs
npm run check:encoding
npm run check:public-surface
npm run check:alias-tokens
```

### 离线单测与需要宿主模块的检查

单测会执行代码，不能仅因不连接实例就当作纯静态检查。先确认依赖及测试范围，再选择安装形态：

| 入口 | 运行前提 | 如何理解结果 |
| --- | --- | --- |
| `npm run test:offline` | 离线安装形态，无宿主锚 | 需要宿主锚的用例跳过；跳过项单列为未验证 |
| `npm run test:inproc` | 明确的宿主模块树，可通过 `DSAT_HOST_MODULES` 指定 | 在进程内执行单测；不等于真实实例验收 |
| `npm run check:preset` | 对应版本宿主模块 | 检查预设装载，不证明实例已加载同一份模块 |
| `npm run check:model-text` | 脚本依赖可解析，含宿主模块要求 | 检查模型文案及构造结果，不代替页面和真实工具验证 |
| `npm run check:agent-policy` | 明确的宿主源码 | 只检查有限锚集，覆盖边界见下表 |

宿主模块解析钩子可单独使用 `DSAT_HOST_MODULES`，不代表真实探针已满足第 1 节前提。策略检查器接受显式 `--host-file` 或 `DSAT_HOST_MODULES`，此时不加载本机配置；没有显式来源时仍按第 1 节区分缺席与损坏。显式宿主源缺失或锚错误会失败，不回退或跳过。

缺宿主锚的跳过理由统一来自[宿主守卫](<../test/_host-gate.mjs>)。`test:offline` 的合格读数须同时满足：fail 为 0；pass 与 skip 之和等于 `test:inproc` 的用例总数；每条跳过都有理由。[离线导入守卫](<../test/offline-import-guard.test.mjs>)在两种形态中都执行，用来拦截测试文件顶层静态导入宿主依赖链的情况。

无法启动子进程、捕获输出或加载依赖时，记录命令和失败阶段，交由具备条件的维护者重跑。权限问题不算产品失败，也不算完成验证。

### 脚本覆盖边界

下表既有独立脚本，也有供其他探针调用的纯函数。纯函数使用合成输入时，不需要真实页面；读取宿主源码、开发树或安装树的脚本仍需对应来源。

| 脚本 | 当前用途与边界 |
| --- | --- |
| [`check-agent-policy.mjs`](<check-agent-policy.mjs>) | 比较[本包策略形状副本](<../lib/agent-policy.js>)与宿主 `dsh-tool-subagent` 当前源码的有限锚集：宿主 H1–H8、本包 O1–O14，其中两锚固定行号。检查不注册投影，也不检查采样链；派生时读取宿主模型选择服务 `subagentModelSelection.current()`，会话投影仅用于判断原生目标是否适用。锚外变化不会报错，同形不证明语义等价，实际指定路由仍需验证 |
| [`d05-readme-composition.mjs`](<d05-readme-composition.mjs>) | 需要宿主锚。检查用户参考 delegation 组示例的进程内装载：`cordis:group`、workflow-ptc 引擎行、async_workflow 行使工具进组，并保持 workflowEngine 组隔离；缺引擎行时应给出可读拒绝且不创建作业。进程内树没有 ptcRuntime 提供者，不伪造激活；带引擎组合的纯编排成功须由真实 dsh-async 预设转录证明 |
| [`check-junctions.mjs`](<check-junctions.mjs>) | 开发树接线目标与声明版本核对；缺席、错树、错版分开，不证明内存已加载同一模块 |
| [`diff-trees.mjs`](<diff-trees.mjs>) | 安装树包级字节差异，属于调研，不以零差异代替行为回归 |
| [`check-facts-anchors.mjs`](<check-facts-anchors.mjs>) | 维护者事实条目四字段及文件／行号可解析性，不判引用语义正确；缺来源与坏引用分开 |
| [`message-markers.mjs`](<message-markers.mjs>) | 从当前双语文案取得判断标记，不能让用例只在一种语言成立 |
| [`r24-judgements.mjs`](<r24-judgements.mjs>) | 页面取数后的纯判断，可用合成反例证明断言有效，不替代当前页面取数 |
| [`lang-judgements.mjs`](<lang-judgements.mjs>) | 两语言开关行为核对，输入真实性由取数探针承担 |
| [`agent-judgements.mjs`](<agent-judgements.mjs>) | 指定路由与回执判断，不代替子会话真实 descriptor 核验 |

## 3. 真实实例与页面探针

这些探针会连接配置中的真实实例，部分还会修改共享状态或启动浏览器。默认不运行整表；新目标若未被现有脚本覆盖，先修改探针，再重新验证。

运行单个探针前，按顺序确认：

1. 阅读脚本的入口参数、阶段和写入路径，核对目标实例、当前模块版本及授权范围。
2. 记录会改变的起始设置；只创建自己的隔离会话和样本。涉及共享设置、声明拆装、重启或卸载时，先确认维护窗口与恢复方法。
3. 需要 GUI 时确认浏览器可启动及权限满足。浏览器反复启动可能触发登录审计或锁定，不能通过循环重试解决。
4. 完成后检查自己的作业、会话、设置及目录。恢复前与当前值比较，避免覆盖他人的新修改；按第 4 节选择恢复工具。保存脱敏证据，并列明未清理或未验证项。

表中“改设置”“拆装”“重启”等提示标出会改状态的入口。其他探针也可能创建会话或作业，须以读过的脚本为准。finally 只是恢复尝试，结束后仍要核对实际状态。

| 脚本 | 覆盖与副作用 |
| --- | --- |
| [`final-acceptance.mjs`](<final-acceptance.mjs>) | 当前覆盖四个基础工具（async_run / async_wait_job / async_wait_agent / async_agent）；路由查询与实时选择由 acceptance-017 承担，workflow 另由专门探针承担。会重置共享设置，运行前确认授权和起始值 |
| [`async-e2e.mjs`](<async-e2e.mjs>) | 命令让出、作业取回及插话；可能修改共享设置，不能直接当无副作用批处理 |
| [`probe-queue-delivery.mjs`](<probe-queue-delivery.mjs>) | 下一轮与下一步领取的区别、插话不杀作业；状态需真实工具结果证明 |
| [`probe-queue-baseline.mjs`](<probe-queue-baseline.mjs>) | 记录实际投递行为，不作为独立通过判据 |
| [`probe-agent-e2e.mjs`](<probe-agent-e2e.mjs>) | 后台创建、有界等待、消息及 persona；不涵盖所有当前实时状态或消息类别，执行前读设置写入 |
| [`probe-settings-behavior-full.mjs`](<probe-settings-behavior-full.mjs>) | 配置变化后的夹紧、裁剪和描述；改共享设置并恢复，完整工具覆盖须按当前目标核对 |
| [`probe-preset-portability.mjs`](<probe-preset-portability.mjs>) | 落盘预设目录形态下的自建挂载可移植性；源目录（`~/.dsh/.agent-presets/dsh-async`）不在时自退出、不产生证据，通过结论不得引用为 bundle patch 路径证据（该路径由 validate-preset 与 d05 承担）；不代表既有自建预设已禁同步入口；若涉及目录或组成写入须隔离 |
| [`probe-escalation-advertised.mjs`](<probe-escalation-advertised.mjs>) | 真实模型工具 schema 中提权键，不代替实际审批 |
| [`probe-sandbox-marker.mjs`](<probe-sandbox-marker.mjs>) | 沙箱拒绝的模型可见词表（由按文件族拦截的沙箱规则承载）与退出状态标记；本部署命令族受限、测试运行器被杀时如实记环境事实，不冒称命令族已验 |
| [`probe-lang-independence.mjs`](<probe-lang-independence.mjs>) | 页面文案与真实描述的双向对照，改共享语言设置；抽样描述不能冒称全部工具全文均核验 |
| [`probe-card-visual.mjs`](<_visual/probe-card-visual.mjs>) | 真实 DOM、计算样式和截图对比官方控件；起浏览器、每主题分别核验（须 danger-full-access 或非受限环境，受限令牌下浏览器无法启动、立即退出） |
| [`probe-r24-bundle-config.mjs`](<_visual/probe-r24-bundle-config.mjs>) | 插件页表单位置、字段身份、秒数与保存恢复；起浏览器并写共享设置，字段期望含延长配置（`askExtendMs`）；同上运行前提 |
| [`acceptance-017.mjs`](<acceptance-017.mjs>) | 工具、管理、行为、路由和设置等阶段；文件名只是标识，不是兼容基准，具体阶段副作用先读 |
| [`probe-r26-create-preset.mjs`](<probe-r26-create-preset.mjs>) | 两预设目录及流程；drill／both 涉及声明拆装和重新装载，仅维护窗口运行 |
| [`probe-r28-silent-failure.mjs`](<probe-r28-silent-failure.mjs>) | 三处防护和语言，改共享设置；现有全局纪律断言不能作为需求限定预设范围的通过证据 |
| [`probe-r28-restart-persistence.mjs`](<probe-r28-restart-persistence.mjs>) | 重启保持与设置恢复，人工安全检查和新认证后运行，不自动重启在用实例 |
| [`probe-r29-robustness.mjs`](<probe-r29-robustness.mjs>) | 配置拒绝与等待时长，改共享设置；总预算还须覆盖查询和准备，不能沿用等待段证明 |
| [`probe-r30-ask-takeover.mjs`](<probe-r30-ask-takeover.mjs>) | 超时、迟到、范围、位置和语言；改设置，after-restart 阶段需人工维护窗口 |
| [`probe-r32-run-interruptible.mjs`](<probe-r32-run-interruptible.mjs>) | 插话／停止、卡片、触顶、短命令与通知计数；(b)(c) 经 blank 会话＋agentPresets/select 定预设后走 composer，含浏览器的整跑需提权，不用历史读数证明当前判据 |
| [`probe-r34-async-workflow.mjs`](<probe-r34-async-workflow.mjs>) | 首次等待、任务卡、并发、两预设及运行记录；浏览器与模型运行有权限前提，不用历史读数证明当前目标 |

## 4. 清理、状态与诊断工具

先用只读入口确认状态，再决定是否恢复。恢复设置、profile 或文件前，核对目标和期望值；有他人新改动时先协调，不直接覆盖。诊断脚本只解释环境，不证明业务功能通过。

| 脚本 | 用途与约束 |
| --- | --- |
| [`_rpc.mjs`](<_rpc.mjs>) | 认证换 cookie 及信封调用；不打印真实秘密，只在授权实例使用 |
| [`_r28-helpers.mjs`](<_r28-helpers.mjs>) | 含共享设置写入、会话创建和权限切换方法；调用者须逐个确认授权，不能调用自动全权限切换代替正常审批；缺省预设按实例实读，不信注释中的固定值 |
| [`probe-session-state.mjs`](<probe-session-state.mjs>) | 重启前查是否有活动会话，只读管理状态；有他人活动就不能随手重启 |
| [`restore-async-settings.mjs`](<restore-async-settings.mjs>) | 共享设置被测试改变后的独立恢复入口，恢复前核对目标和期望值，不覆盖他人新改动 |
| [`r17-uninstall.ps1`](<r17-uninstall.ps1>) | 状态、备份和还原操作，可能改 profile；不含服务重启，不当产品自动清理保证 |
| [`_gates-r30.mjs`](<_gates-r30.mjs>) | 检查活动会话、操作会话与目标实例的关系，只对获授权维护窗口使用 |
| [`diag-spawn-contexts.mjs`](<diag-spawn-contexts.mjs>) | stdio 形态对照，不等同被测业务通过；遇沙箱拒绝如实记录 |
| [`diag-headless-edge.mjs`](<diag-headless-edge.mjs>) | 无头浏览器存活与 CDP，具有进程副作用，需合适环境 |
| [`cdp.mjs`](<_visual/cdp.mjs>) | 创建独立用户目录与 CDP 连接，不复用用户真实浏览资料 |
| [`check-ps1-bom.mjs`](<check-ps1-bom.mjs>)、[`check-ps1-syntax.mjs`](<check-ps1-syntax.mjs>)、[`restore-ps1-bom.mjs`](<restore-ps1-bom.mjs>) | 只针对明确 PS1 对象；恢复工具可能写文件，先核对原值和范围 |

服务、profile 和认证属于实例基础设施，不放进插件可交付目录；公开探针只连接实例，不拥有服务。真实运行产物按本机配置写内部证据目录。

## 5. 变异证明

变异测试故意改坏一个输入或实现，再确认预期断言能发现错误。下方“实现变异索引”登记实现脚本与目标测试文件，索引检查器双向核对。改变文档路径、裸文件名、公开范围、模型文本、策略、界面或语言等检查器输入的脚本，另列具名豁免。

1. 先读脚本。内存变异直接传入纯判断函数；写回型变异只在隔离副本执行，确认 ROOT 和全部目标路径都指向副本。
2. 运行未变异基线，确认可以执行且通过。基线不可用时先处理环境或基线问题，不继续声称变异已验证。
3. 确认实际执行的测试文件与脚本声明一致，再运行变异。只有预期保护断言失败才算捕获；失败用例集合不符、未运行、加载失败或超时都不能记为 CAUGHT。
4. 核对输出是否完整。多文件输出归属和 Node 报告器格式变化可能影响解析，不能只看到一次失败就认定目标已捕获。
5. 结束后检查自己的作业、会话、设置和副本，记录没有清理或没有验证的部分；finally 存在不能证明已恢复。

权限不足时，可经正常审批执行同一无害测试，或换用合适的隔离环境；不能通过弱化断言取得通过。

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

检查器输入变异包括路径、编码之外的公开范围、模型文案、主题、策略和界面判据等，分别由脚本自身声明入口；[变异索引检查器](<../tools/check-mutate-index.mjs>)核对上述实现表和具名例外，不以文档表代替执行结论。

### 检查器输入变异的具名豁免

以下脚本改变检查器输入而非交付实现，因此不要求“跑的测试文件”映射。索引检查器仍核对这些豁免脚本真实存在。

| 脚本 | 豁免理由 |
| --- | --- |
| `verify/mutate-mutate-index.mjs` | 检验变异索引自身的双向判断 |
| `verify/mutate-doc-paths.mjs` | 检验文档路径悬空判断 |
| `verify/mutate-bare-filenames.mjs` | 检验裸文件名悬空判断 |
| `verify/mutate-facts-anchors.mjs` | 检验行号、文件存在和事实四字段 |
| `verify/mutate-r24-ui.mjs` | 检验界面取数与保存判断 |
| `verify/mutate-model-text.mjs` | 检验模型文案集中管理 |
| `verify/mutate-alias-tokens.mjs` | 检验未定义主题别名引用 |
| `verify/mutate-agent-policy.mjs` | 检验策略形状有限锚集；交付单测另在 `test/agent-policy.test.mjs` |
| `verify/mutate-public-surface.mjs` | 合成树检验公开结构、本机指纹、内部引用；语义单测另在 `test/public-surface.test.mjs` |
