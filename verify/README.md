# 验证脚本与执行边界

先按验证对象选择入口：只检查文本和纯函数，用离线检查；要比较宿主接口，准备精确版本的宿主模块；要验证实际投递、进程或页面，才连接隔离实例。真实运行产物写到配置的内部证据目录，不保存在本目录。脚本在场和旧读数都不代表当前目标已通过。

[需求的验收要求](<../docs/requirements.md#8-验收要求>)定义必须证明的结果，[验证设计](<../docs/design.md#8-验证设计>)定义装置，[当前实施与验证状态](<../docs/design.md#9-当前实施与验证状态>)区分已实现及待验证内容。本目录脚本按当前目标跟进更新，不另立清单；各脚本的实际覆盖以下方两表的用途与边界为准，脚本存在不证明对应真机验收已执行。

## 1. 配置、权限与安全前提

脚本通过[本机配置加载器](<../tools/_local-config.mjs>)取宿主模块树、实例 URL、认证文件和证据目录；形状见[示例](<../tools/local-config.example.mjs>)。不在源码写机器坐标。

- 具名例外：[策略检查](<check-agent-policy.mjs>)只需宿主源码时，可显式使用 `DSAT_HOST_MODULES` 或 `--host-file`，不装载本机配置；本机配置缺席/损坏规则此时不适用。宿主模块解析钩子也可单独使用 `DSAT_HOST_MODULES` 跑单测。两者都不满足真实实例探针的配置、实例、认证和授权前提。
- 本机目录缺席时，依赖本机配置的探针明确跳过。目录存在而配置缺失或加载失败时，报配置损坏；不能用环境变量绕过目录和文件检查。
- 配置加载成功后，普通字段先取非空环境变量，再取文件值。必要字段仍缺失时说明没有来源。`siblingBundles` 以文件数组为准，空数组表示只断言本包；文件没有该字段时才用环境变量。`evidenceDir`、`workspaceDir`、`tmpDir` 按环境变量、文件、派生缺省的顺序取值。
- 认证在授权的 helper 内部读取，输出不打印令牌、cookie、秘密或含 token 的 URL。证据脱敏后写配置的 evidenceDir，不进公开仓。
- 优先默认权限执行；纯函数判断尽量进程内复用。确需子进程、浏览器或受限执行环境以外权限时，经正常审批，不能自动改会话全权限或绕过子代理限制。
- EPERM、加载失败、超时终止、无输出且没有执行证据，属于未完成验证，不算产品通过或目标变异被捕获。外部命令先裸调用确认执行，不能把捕获形静默失败读成成功空输出。
- 只用自己新建、标识明确的测试会话和隔离样本，不读取他人会话正文、不停止他人任务。真实危险操作用无害替身。
- 共享设置、安装卸载、实例重启和全权限切换都有副作用。执行前读脚本，确认明确授权、起始状态及恢复方式；finally 不保证所有终止路径都会还原。
- 浏览器反复启动可能触发本机登录审计／锁定策略；GUI 探针不加入无条件批量流程。宿主安装和模块版本现查，不依赖本机部署手册旧快照。

## 2. 只读及离线入口

先确认扫描范围，再选需要的命令。下面的检查不连接真实实例，但并非都能在没有宿主模块时完成。不要把“离线”理解成全部用例都已验证。

| 类别 | 命令 | 前提与结果 |
| --- | --- | --- |
| 纯静态文档事实 | `npm run check:user-docs` | 核对分发、版本、参数和设置表；不证明实际页面可用 |
| 静态主题，需宿主源 | `npm run check:alias-tokens` | 需要匹配当前rc4的主题定义；先按[来源与结果确认步骤](<#21-主题别名检查的来源与结果>)准备，不证明实际样式或视觉效果 |
| 文档与公开文件扫描 | `npm run check:docs`、`npm run check:encoding`、`npm run check:public-surface` | 先确认读取目录；正式检查宜使用按明确公开文件清单构建的新隔离副本，避免读取旧本机资料或历史目录 |
| 离线测试 | `npm run test:offline` | 不配置宿主锚时，宿主用例带理由跳过 |
| 宿主模块测试 | `npm run test:inproc` | 需要正确版本的宿主模块；缺锚的跳过另列未验证 |
| 宿主基线与文案 | `npm run check:preset`、`npm run check:model-text`、`npm run check:agent-policy` | 需要对应宿主条件；只证明各检查器声明的范围 |
| 语法解析检查 | `npm run check` | 仅解析 lib/test/tools 中源码及 client.js，不执行模块或检查导入解析，不加载本机配置；不代替文档、编码和公开范围检查 |


这些入口不替代当前功能的真实验收。宿主锚可使用 `DSAT_HOST_MODULES`；`test:offline`（离线安装形态，无宿主锚）下需要宿主锚的用例自跳过并打印统一理由（守卫唯一来源 [`test/_host-gate.mjs`](<../test/_host-gate.mjs>)）——合格读数为 fail 为 0、pass 与 skip 之和等于 `test:inproc` 的用例总数、每条跳过都带理由；静态看守 [`test/offline-import-guard.test.mjs`](<../test/offline-import-guard.test.mjs>) 两种形态都在场，拦截测试文件顶层静态依赖宿主链模块的漏网。无锚导致用例跳过时，单列未验证。是否能捕获子进程或启动浏览器由部署决定，不把权限噪声当被测对象失败。

| 脚本 | 当前用途与边界 |
| --- | --- |
| [`check-agent-policy.mjs`](<check-agent-policy.mjs>) | 钉版看守本包 `lib/agent-policy.js` 的形状副本与宿主 `dsh-tool-subagent` 现行源同形（有限锚集，宿主侧 H1–H8 对本包侧 O1–O14，其中两锚钉行号）；不注册投影、不锚定采样链——派生路径现读宿主模型选择服务（`subagentModelSelection.current()`），会话投影只用于原生目标的适用性判断；锚外漂移不红，也不证明语义等价或代替实际指定路由验证 |
| [`d05-readme-composition.mjs`](<d05-readme-composition.mjs>) | 用户参考 delegation 组示例（cordis:group＋workflow-ptc 引擎行＋async_workflow 行）的进程内装载语义：工具进组、workflowEngine 组隔离、缺引擎行可读拒绝＋零作业；带引擎组合的纯编排成功以真机 dsh-async 预设转录为证（进程内树无 ptcRuntime 提供者，不伪造激活）；需要宿主锚 |
| [`check-junctions.mjs`](<check-junctions.mjs>) | 开发树接线目标与声明版本核对；缺席、错树、错版分开，不证明内存已加载同一模块 |
| [`diff-trees.mjs`](<diff-trees.mjs>) | 安装树包级字节差异，属于调研，不以零差异代替行为回归 |
| [`check-facts-anchors.mjs`](<check-facts-anchors.mjs>) | 维护者事实条目四字段及文件／行号可解析性，不判引用语义正确；缺来源与坏引用分开 |
| [`message-markers.mjs`](<message-markers.mjs>) | 从当前双语文案取得判断标记，不能让用例只在一种语言成立 |
| [`r24-judgements.mjs`](<r24-judgements.mjs>) | 页面取数后的纯判断，可用合成反例证明断言有效，不替代当前页面取数 |
| [`lang-judgements.mjs`](<lang-judgements.mjs>) | 两语言开关行为核对，输入真实性由取数探针承担 |
| [`agent-judgements.mjs`](<agent-judgements.mjs>) | 指定路由与回执判断，不代替子会话真实 descriptor 核验 |

### 2.1 主题别名检查的来源与结果

此检查不连接实例，但必须读取与当前实现匹配的主题源。本树当前仍是DSH `0.2.1-rc.4` 基线，不是未来alpha宿主。先取得已确认属于该rc4宿主的模块树，不要仅凭退出码判断来源正确。

1. 在预期模块树中核对 `@deepseek-ai/dsh-client-ui-theme/package.json` 的版本及其所属宿主来源，确认是当前rc4配套，而非本机另一条线。确认同一模块树的 `@deepseek-ai/dsh-client-ui-theme/lib/client.js` 是要枚举的主题定义源。缺少可枚举主题源时，请提供匹配源后再检查，不用其他版本替代本线结论。
2. 在运行检查的同一终端，显式设置下面的环境变量，再从本仓根运行。将占位符换为已核对模块树的node_modules绝对目录，该目录下应有 `@deepseek-ai`：

   ```powershell
   $env:DSAT_HOST_MODULES = '<已核对的rc4模块树node_modules绝对目录>'
   npm run check:alias-tokens
   ```

   此命令直接解析候选，不加载 `_host-hooks`，也不把 `.local` 配置中的hostModules转成环境变量；只配置本机文件不够。候选依次为：DSAT_HOST_MODULES、DSH_HOME下的profiles/node_modules（未设DSH_HOME时用 `~/.dsh`）、APPDATA下的npm/node_modules/@deepseek-ai/dsh/node_modules。检查器选首个能够枚举主题定义的源；显式目录不存在、缺主题文件或枚举不到名称时，仍会尝试后备候选，不是强制锁定。
3. 运行后核对输出的“枚举自”：它必须指向步骤1确认的模块树下 `@deepseek-ai/dsh-client-ui-theme/lib/client.js`。不一致时，本次不能记作rc4通过；修正来源后重跑。检查器不读主题包版本，退出0也不能单独证明来源属于本线。
4. 记录来源与结果。没有可枚举定义源时退出2，属于环境不足、本项未验证，先补匹配源；完成枚举但发现未定义引用时退出1，按BAD行修正引用后重查；退出0且来源已核对一致时，只证明引用名称都在这份定义表中，不证明计算样式、颜色反馈或页面兼容。

## 3. 真实实例与页面探针

运行真实探针前，先完成下面的准备：

1. 读取所选脚本，确认连接的实例、所需认证和会修改的设置。
2. 获得本次操作授权，记录原设置与用户覆盖，创建自己的隔离测试会话。需要安装卸载或重启的阶段，只在维护窗口运行。
3. 用无害样本执行，核对真实工具结果、进程状态或当前页面，不用模型复述代替证据。
4. 停止自己的剩余任务，恢复设置及覆盖，再读回核对。恢复失败或未验证的部分单独报告，不覆盖他人的后续修改。

下表按脚本列出覆盖和副作用。它不是执行授权，也不是完成清单；未覆盖的新目标需要补充装置并重新验证。

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

变异测试故意删除或改坏某项保护，再确认相应断言失败。下方“实现变异索引”把实现变异对应到目标测试文件，索引检查器双向核对两者。检查器输入变异则改变文档路径、裸文件名、公开范围、模型文本、策略、界面或语言等输入；它与改坏产品实现是两类验证。

- 内存变异直接喂纯判断函数；写回型变异只在隔离副本，先读脚本，确认 ROOT 与目标指向副本。
- 未变异基线须可运行且通过，变异必须让预期保护的断言失败。失败用例集合不符预期、未运行、加载失败和超时不能冒称 CAUGHT。
- 执行文件必须与脚本声明一致，多文件输出归属和 Node 报告器形状变化均可能影响结果解析，需要明确识别不完整输出。
- 权限不足可经正常审批执行同一无害测试，或用合适隔离环境；不能通过弱化断言取得通过。
- 探针结束确认自己的作业、会话和设置状态，记录没有清理或没有验证的部分，不能仅以 finally 存在宣称恢复成功。

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
