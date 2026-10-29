# 验证脚本与执行边界

本目录保存可移植的测试、探针和判断函数，不保存真实运行产物。单元替身、真实宿主模块、真实实例、GUI 各证明自己的范围；脚本存在和旧读数不等于当前目标通过。

[需求的验收要求](<../docs/requirements.md#8-验收要求>)定义必须证明的结果，[验证设计](<../docs/design.md#8-验证设计>)定义装置，[当前实施差距](<../docs/design.md#9-当前实施与验证差距>)是目标差距的唯一工作清单——本目录脚本按其登记项跟进更新，不另立差距单。

## 1. 配置、权限与安全前提

依赖本机配置的探针通过[本机配置加载器](<../tools/_local-config.mjs>)取宿主模块树、实例 URL、认证文件和证据目录；形状见[示例](<../tools/local-config.example.mjs>)。不在源码写机器坐标。不依赖本机配置的静态入口，以及可单独使用 `DSAT_HOST_MODULES` 的宿主模块解析钩子，不受下面的本机配置检查条件限制。

- 对依赖本机配置的探针，本机目录缺席时明确跳过；目录存在而配置缺失或加载失败时报错，环境变量不能绕过这些检查。配置可加载后，普通字符串字段优先取非空环境变量，再取文件值；缺必要字段时说明没有来源。`siblingBundles` 等字段另有规则，见[参与指南的配置例外与派生值](<../CONTRIBUTING.md#配置本机验证所需的信息>)；其中 `siblingBundles` 优先采用文件数组，不能用环境变量覆盖该数组。
- 认证在授权的 helper 内部读取，输出不打印令牌、cookie、秘密或含 token 的 URL。证据脱敏后写配置的 evidenceDir，不进公开仓。
- 优先默认权限执行；纯函数判断尽量进程内复用。确需子进程、浏览器或受限执行环境以外权限时，经正常审批，不能自动改会话全权限或绕过子代理限制。
- EPERM、加载失败、超时终止、无输出且没有执行证据，属于未完成验证，不算产品通过或目标变异被捕获。外部命令先裸调用确认执行，不能把捕获形静默失败读成成功空输出。
- 只用自己新建、标识明确的测试会话和隔离样本，不读取他人会话正文、不停止他人任务。真实危险操作用无害替身。
- 共享设置、安装卸载、实例重启和全权限切换都有副作用。执行前读脚本，确认明确授权、起始状态及恢复方式；finally 不保证所有终止路径都会还原。
- 浏览器反复启动可能触发本机登录审计／锁定策略；GUI 探针不加入无条件批量流程。宿主安装和模块版本现查，不依赖本机部署手册旧快照。

## 2. 只读及离线入口

先按所需环境选择入口，不要把下面所有命令当成无条件批处理。

| 类别 | 入口 | 能证明什么 |
| --- | --- | --- |
| 静态检查 | `npm run check`、`npm run check:user-docs` | 分别检查语法和用户资料事实，不连接真实实例 |
| 需要宿主主题源的静态检查 | `npm run check:alias-tokens` | 不连接实例，但须读取对应版本的 `dsh-client-ui-theme` 源；先显式指定并核对目标树，方法见下文 |
| 文档及文件扫描 | `npm run check:docs`、`npm run check:encoding`、`npm run check:public-surface` | 检查职责、引用、编码和公开范围；运行前须确认读哪些目录 |
| 无宿主锚测试 | `npm run test:offline` | 运行离线形态；依赖宿主模块的用例明确跳过 |
| 需要宿主模块 | `npm run test:inproc`、`npm run check:preset`、`npm run check:model-text`、`npm run check:agent-policy` | 核对对应宿主接口、预设、文案或策略；不等于连接实例或真实模型验证 |

**准备目标源**。主题别名检查须使用本线 DSH `0.2.0-rc.2` 对应的主题源。先核对目标 node_modules 目录下的 `@deepseek-ai/dsh-client-ui-theme/package.json` 版本及 `@deepseek-ai/dsh-client-ui-theme/lib/client.js` 源文件，再把当前终端的 `DSAT_HOST_MODULES` 显式设为该目录（含 `@deepseek-ai`）。上述包路径都相对于指定的 `DSAT_HOST_MODULES`，不是本插件仓内文件。此命令不导入 `_host-hooks`，不会从 `.local/config.mjs` 的 hostModules 取值。

**确认没有取错候选**。命令依次尝试 `DSAT_HOST_MODULES`、`DSH_HOME/profiles/node_modules`、APPDATA 全局 DSH 的嵌套模块树。显式路径无效时仍可能读到其他候选，因此运行结果的“枚举自”须与预期源路径一致。完整候选路径、`DSH_HOME` 默认值和确认步骤见[参与指南的主题源说明](<../CONTRIBUTING.md#主题别名检查的宿主源>)。

**区分缺源与违规**。缺少可枚举的主题源时退出 2，表示本项未验证，不是产品违规；修正路径和版本后再重试。完成枚举后发现未定义别名时退出 1，才是此检查检出的违规结果。

“宿主锚”是用来核对接口的对应版本模块树，可通过 `DSAT_HOST_MODULES` 指定。它和真实运行实例是两个对象。没有锚时，相关测试由[统一守卫](<../test/_host-gate.mjs>)跳过并打印理由，所涉及功能仍须列为未验证。

离线测试读数须满足：fail 为 0，pass 与 skip 之和等于 `test:inproc` 的用例总数，每条 skip 都有理由。[离线导入守卫](<../test/offline-import-guard.test.mjs>)在两种形态中都运行，用来发现测试顶层静态导入宿主依赖的问题。

纯静态不等于可以忽略扫描范围。`check:docs` 会读取可选本机语料；公开范围和编码检查会递归扫描。仅验证公开交付时，先按明确文件清单建立新副本，不递归复制本机或旧运行材料，再在副本中检查。不要假定 scope 参数就能阻止遍历。

子进程捕获和浏览器启动还受部署权限限制。无法启动、EPERM 或捕获形静默失败表示验证未完成，不能当作被测产品失败，也不能算通过。

| 脚本 | 当前用途与边界 |
| --- | --- |
| [`check-agent-policy.mjs`](<check-agent-policy.mjs>) | 宿主与本包模型策略定义、schema 和采样的静态核对，不证明真实指定路由已经生效 |
| [`check-junctions.mjs`](<check-junctions.mjs>) | 开发树接线目标与声明版本核对；缺席、错树、错版分开，不证明内存已加载同一模块 |
| [`diff-trees.mjs`](<diff-trees.mjs>) | 安装树包级字节差异，属于调研，不以零差异代替行为回归 |
| [`check-facts-anchors.mjs`](<check-facts-anchors.mjs>) | 维护者事实条目四字段及文件／行号可解析性，不判引用语义正确；缺来源与坏引用分开 |
| [`message-markers.mjs`](<message-markers.mjs>) | 从当前双语文案取得判断标记，不能让用例只在一种语言成立 |
| [`r24-judgements.mjs`](<r24-judgements.mjs>) | 页面取数后的纯判断，可用合成反例证明断言有效，不替代当前页面取数 |
| [`lang-judgements.mjs`](<lang-judgements.mjs>) | 两语言开关行为核对，输入真实性由取数探针承担 |
| [`agent-judgements.mjs`](<agent-judgements.mjs>) | 指定路由与回执判断，不代替子会话真实 descriptor 核验 |

## 3. 真实实例与页面探针

这些探针会连接真实实例，有些还会运行模型、启动浏览器或改共享状态。执行前按下面顺序准备：

1. 读取所选脚本，确认目标 URL、宿主版本、认证来源及将写入的设置或声明。
2. 取得该目标和操作的授权，记录共享状态起始值，只创建自己的隔离测试会话和浏览器资料目录。
3. 对重启、安装卸载或权限变更，先确认维护窗口及恢复方法。不能把探针当作操作授权。
4. 运行后核对自己的作业、会话、设置和声明是否恢复；未能清理或确认的部分明确报告。finally 代码存在不代表已经恢复。

下表说明脚本的覆盖和副作用，不表示全部当前要求已经通过。新目标未被覆盖时，先修改探针，再重新验证。

| 脚本 | 覆盖与副作用 |
| --- | --- |
| [`final-acceptance.mjs`](<final-acceptance.mjs>) | 当前覆盖基础工具集合；workflow 另由专门探针承担。会重置共享设置，运行前确认授权和起始值 |
| [`async-e2e.mjs`](<async-e2e.mjs>) | 命令让出、作业取回及插话；可能修改共享设置，不能直接当无副作用批处理 |
| [`probe-queue-delivery.mjs`](<probe-queue-delivery.mjs>) | 下一轮与下一步领取的区别、插话不杀作业；状态需真实工具结果证明 |
| [`probe-queue-baseline.mjs`](<probe-queue-baseline.mjs>) | 记录实际投递行为，不作为独立通过判据 |
| [`probe-agent-e2e.mjs`](<probe-agent-e2e.mjs>) | 后台创建、有界等待、消息及 persona；不涵盖所有当前实时状态或消息类别，执行前读设置写入 |
| [`probe-settings-behavior-full.mjs`](<probe-settings-behavior-full.mjs>) | 配置变化后的夹紧、裁剪和描述；改共享设置并恢复，完整五工具覆盖须按当前目标核对 |
| [`probe-preset-portability.mjs`](<probe-preset-portability.mjs>) | 自建测试组合挂本包工具，不代表既有自建预设已禁同步入口；若涉及目录或组成写入须隔离 |
| [`probe-escalation-advertised.mjs`](<probe-escalation-advertised.mjs>) | 真实模型工具 schema 中提权键，不代替实际审批 |
| [`probe-sandbox-marker.mjs`](<probe-sandbox-marker.mjs>) | 沙箱拒绝的模型可见词表（由按文件族拦截的沙箱规则承载）与退出状态标记；本部署命令族受限、测试运行器被杀时如实记环境事实，不冒称命令族已验 |
| [`probe-lang-independence.mjs`](<probe-lang-independence.mjs>) | 页面文案与真实描述的双向对照，改共享语言设置；抽样描述不能冒称五工具全文均核验 |
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

[实现变异索引](<#实现变异索引>)登记实现变异与目标测试文件，并由索引检查器双向核对。检查器输入变异包括文档路径、裸文件名、公开范围、模型文本、策略、界面及语言等。

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
