# 验证脚本与执行边界

本目录提供测试、探针和判断函数。先按本次要确认的问题选择入口：只检查文件和纯函数，读第 2 节；需要连接真实实例或页面，读第 3 节；需要恢复设置或诊断环境，读第 4 节；需要证明断言能发现错误，读第 5 节。真实运行产物另存，不放在本目录。

[需求的验收要求](<../docs/requirements.md#8-验收要求>)说明必须证明什么，[验证设计](<../docs/design.md#8-验证设计>)说明怎样验证，[当前实施与验证状态](<../docs/design.md#9-当前实施与验证状态>)区分已实现和待验证内容。下面各表说明现有脚本实际检查什么、还不能证明什么；脚本应随当前目标更新。

单元替身、宿主模块、真实实例和 GUI 的结果分别记录。文件检查通过不能代替实例验证，脚本存在或旧读数也不能证明当前目标已通过。

## 运行前选择入口

| 要验证什么 | 从哪里开始 | 条件与风险 |
| --- | --- | --- |
| 文档、编码、公开路径等静态规则 | 第 2 节中对应的 `check:*` | 先确认扫描范围；有些入口递归文件或读取本机语料，限制范围时只在明确文件清单建立的隔离副本运行 |
| 无宿主的单元行为 | `test:offline` | 需要宿主的用例会跳过，必须单列未验证 |
| 真实宿主模块或组合装载 | 第 2 节的宿主相关脚本 | 需要匹配版本的宿主模块；模块或配置缺席不是行为通过 |
| 实例投递、模型、页面与真实进程 | 第 3 节 | 先读脚本，取得授权并建立自己的隔离会话；可能改共享设置、启动浏览器或运行模型 |
| 安装卸载、重启或状态恢复 | 第 4 节 | 仅在授权维护窗口操作，记录原状态并核对恢复结果 |
| 断言是否能发现实现被改坏 | 第 5 节 | 仅在内存或新隔离副本运行；写回脚本不能指向正在编辑的产品树 |

“静态”表示不运行目标业务，不代表不读取本机文件；“需要宿主模块”也不等于会连接真实实例。逐项确认脚本的条件后再执行。

## 1. 配置、权限与安全前提

脚本通过[本机配置加载器](<../tools/_local-config.mjs>)取宿主模块树、实例 URL、认证文件和证据目录；形状见[示例](<../tools/local-config.example.mjs>)。不在源码写机器坐标。

- 本机目录缺席时，依赖它的检查打印理由并跳过；目录存在但配置缺失或加载失败时，按损坏报错。环境变量不绕过这两项检查。
- 配置可用后，普通字段先取非空环境变量，再取文件值。`evidenceDir`／`workspaceDir`／`tmpDir` 还可采用派生缺省，顺序为环境变量→文件→派生值。必要字段仍缺失时，报告没有来源。
- `siblingBundles` 以文件数组为先，含空数组（只断言本包）；仅文件未提供字段时，才回退到 `DSAT_SIBLING_BUNDLES`。只需宿主源的独立入口可另用显式 `DSAT_HOST_MODULES` 或支持的 `--host-file`，不代表实例探针已可执行。
- 认证在授权的 helper 内部读取，输出不打印令牌、cookie、秘密或含 token 的 URL。证据脱敏后写配置的 evidenceDir，不进公开仓。
- 优先默认权限执行；纯函数判断尽量进程内复用。确需子进程、浏览器或受限执行环境以外权限时，经正常审批，不能自动改会话全权限或绕过子代理限制。
- EPERM、加载失败、超时终止、无输出且没有执行证据，属于未完成验证，不算产品通过或目标变异被捕获。外部命令先裸调用确认执行，不能把捕获形静默失败读成成功空输出。
- 只用自己新建、标识明确的测试会话和隔离样本，不读取他人会话正文、不停止他人任务。真实危险操作用无害替身。
- 共享设置、安装卸载、实例重启和全权限切换都有副作用。执行前读脚本，确认明确授权、起始状态及恢复方式；finally 不保证所有终止路径都会还原。
- 浏览器反复启动可能触发本机登录审计／锁定策略；GUI 探针不加入无条件批量流程。宿主安装和模块版本现查，不依赖本机部署手册旧快照。

## 2. 只读及离线入口

按需要选择入口，不要把所有命令当作一次无条件批处理：

| 类别 | 入口 | 前提与能证明的范围 |
| --- | --- | --- |
| 纯静态检查 | `check`、`check:docs`、`check:encoding`、`check:public-surface`、`check:user-docs` | 不连接真实实例；检查源码、文档或定义。部分检查会读取本机语料或递归目录，执行前确认读取范围；只需公开材料时用明确文件清单建立隔离副本 |
| 主题别名静态检查 | `check:alias-tokens` | 不连接实例，但必须读取目标版本主题源；按下方“主题别名检查的来源确认”准备并核对实际来源 |
| 宿主兼容声明检查 | `check:host-compat` | 不连接实例；需显式给出宿主安装树与宿主版本（`--host-root`、`--host-version`）。缺宿主树按环境不足退出 `2`，与判据失败分开；见下表 |
| 单元测试 | `test:offline`、`test:inproc` | 可能创建临时夹具或启动测试进程；后者加载宿主解析钩子。不能仅凭名称推断全部测试都纯静态 |
| 需要宿主模块 | `check:preset`、`check:model-text`、`check:agent-policy`，以及测试中的宿主用例 | 准备版本匹配的宿主模块树；缺锚跳过的部分单列未验证，不连接真实实例也不能证明实际投递和界面 |
| 真实或有状态操作 | 第 3、4 节的实例、浏览器、恢复和拆装脚本 | 先确认授权、隔离目标、起始状态与收尾方法；不在下列常规命令中批量追加 |

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
| `npm run check:host-compat -- --host-root <树> --host-version <版本>` | 显式宿主安装树与精确宿主版本；CI 按支持集合逐宿主跑 | 用宿主官方准入判定核对支持集合内外，并核对九个 dsh peer 与两个配套 peer 在给定宿主树上的解析来源；缺宿主树退出 `2` 属环境不足。只覆盖宿主树的解析，不代替已安装插件在真实 runtime 的路径观测。`--leaf-layout profile` 允许 dependencies 叶子为 profile 本地同版副本，真实安装按实际解析记录来源 |

宿主模块解析钩子可单独使用 `DSAT_HOST_MODULES`，不代表真实探针已满足第 1 节前提。策略检查器接受显式 `--host-file` 或 `DSAT_HOST_MODULES`，此时不加载本机配置；没有显式来源时仍按第 1 节区分缺席与损坏。显式宿主源缺失或锚错误会失败，不回退或跳过。

缺宿主锚的跳过理由统一来自[宿主守卫](<../test/_host-gate.mjs>)。`test:offline` 的合格读数须同时满足：fail 为 0；pass 与 skip 之和等于 `test:inproc` 的用例总数；每条跳过都有理由。[离线导入守卫](<../test/offline-import-guard.test.mjs>)在两种形态中都执行，用来拦截测试文件顶层静态导入宿主依赖链的情况。

无法启动子进程、捕获输出或加载依赖时，记录命令和失败阶段，交由具备条件的维护者重跑。权限问题不算产品失败，也不算完成验证。

### 脚本覆盖边界

下表既有独立脚本，也有供其他探针调用的纯函数。纯函数使用合成输入时，不需要真实页面；读取宿主源码、开发树或安装树的脚本仍需对应来源。

| 脚本 | 当前用途与边界 |
| --- | --- |
| [`check-agent-policy.mjs`](<check-agent-policy.mjs>) | 用固定锚集核对本包 `lib/agent-policy.js` 的形状副本与宿主 `dsh-tool-subagent` 现行源逐字同形（有限锚集，宿主侧 H1–H8 对本包侧 O1–O14，其中两锚按行号定位）——锚内文本任一侧变动（含宿主升版改形而本包未跟）即红，锚外漂移不红；同一锚集固定「无投影注册、无采样」的现行事实；不注册投影、不锚定采样链——派生路径现读宿主模型选择服务（`subagentModelSelection.current()`），会话投影只用于原生目标的适用性判断；同形不证明语义等价，也不代替实际指定路由验证 |
| [`d05-readme-composition.mjs`](<d05-readme-composition.mjs>) | 用户参考 delegation 组示例（cordis:group＋workflow-ptc 引擎行＋async_workflow 行）的进程内装载语义：工具进组、workflowEngine 组隔离、缺引擎行可读拒绝＋零作业；带引擎组合的纯编排成功以真机 dsh-async 预设转录为证（进程内树无 ptcRuntime 提供者，不伪造激活）；需要宿主锚 |
| [`check-junctions.mjs`](<check-junctions.mjs>) | 开发树接线目标与声明版本核对；dsh* 接受支持集合内任一 rc，但要求四条同 rc、全部 junction 指向同一棵宿主树；缺席、错树、错版、混 rc 分开，不证明内存已加载同一模块 |
| [`../tools/check-host-compat.mjs`](<../tools/check-host-compat.mjs>) | 宿主兼容声明与**给定宿主树**的解析来源：官方 `evaluatePluginCompatibility` 放行支持集合四项（`0.2.1-rc.2`／`rc.3`／`rc.4`／`rc.5`）、拒载集合外边界（并确认拒载来自九条 peer、无 `engines.dsh`、无版本豁免），再核对九个 dsh peer 与 cordis／timer 两个 peer 在宿主树顶层、九个 dsh peer 同 rc；dependencies 叶子按 `--leaf-layout` 判（host 全同树；profile 允许同版本地副本）。支持集合只读包清单 peer 原文，不另存版本表。**不覆盖**已安装插件在真实 runtime 实际取得的 peer 路径——那由运行期观测核对，不用本检查的通过代替 |
| [`probe-runtime-peers.mjs`](<probe-runtime-peers.mjs>) | 运行时依赖同源探针（原 COMPAT-01，已关闭）：打包候选 tgz（产物进 `.local/`）→ 系统临时目录独立 home → 官方 CLI 安装 → 带 resolve 钩子起随机端口隔离实例 → RPC 驱动一轮真实会话（懒装载在此触发）→ 三层取证。**前提：Node ≥22.15（module.registerHooks）。**①observed：装载期插件文件实际发起的解析（实测仅配置模块在主线程装载——直接依赖就近取 profile 副本、版本须与宿主同名包一致；工具模块在宿主 **Worker 线程**装载，外部进程的 resolve 钩子观测不到 Worker 内解析——这是观测边界，不是缺陷）；②运行装载决议复算：以宿主公开导出 `createRuntimeResolution` 同函数同输入同盘状态复算——对九项 DSH peer（profile 无本地候选、必走装载路由，installation scope 条目即 interception 路由）是装载映射的直接证据，`resolveBundleDir` 的安装锚优先序即宿主「bundle 永取同一安装、绝不取 profile 本地副本」契约；对直接依赖只测其本地副本缺席时的回退条目（实际装载走本地副本优先，dsh-app-boot `routeScoped`）；③标准链 follow：自动复现「裸解析」形态（直接依赖命中 profile 副本、peer 缺席），只作参考不判 FAIL。边界：复算的输入是磁盘状态，不证明 Worker 运行中未发生其他改写；工具真实运行成功作功能面互证。zod 回退条目在部分宿主树上首命中嵌套副本（该观察仅及本地依赖缺席的回退条件）时探针如实报 FAIL——该 FAIL 属宿主决议表回退形态的观察（正常安装形态不触发），不用改本包消除。四档宿主树已同款取证：rc.5 于 2026-11-03 首发，rc.2 同日换树复跑，rc.3／rc.4 于 2026-11-04 换树补齐（实测记录见[设计 §9.3](<../docs/design.md#93-实例验证按宿主分列>)） |
| [`diff-trees.mjs`](<diff-trees.mjs>) | 安装树包级字节差异，属于调研，不以零差异代替行为回归 |
| [`check-facts-anchors.mjs`](<check-facts-anchors.mjs>) | 维护者事实条目四字段及文件／行号可解析性，不判引用语义正确；缺来源与坏引用分开 |
| [`message-markers.mjs`](<message-markers.mjs>) | 从当前双语文案取得判断标记，不能让用例只在一种语言成立 |
| [`r24-judgements.mjs`](<r24-judgements.mjs>) | 页面取数后的纯判断，可用合成反例证明断言有效，不替代当前页面取数 |
| [`lang-judgements.mjs`](<lang-judgements.mjs>) | 两语言开关行为核对，输入真实性由取数探针承担 |
| [`agent-judgements.mjs`](<agent-judgements.mjs>) | 指定路由与回执判断，不代替子会话真实 descriptor 核验 |

### 主题别名检查的来源确认

`check:alias-tokens` 不连接实例，但不是只读本仓就能完成的检查。它每次从宿主模块树枚举主题定义，不检查主题包版本。先确认来源属于支持集合内的一个宿主版本（`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5` 之一；rc.5 已完成兼容验收），再运行：

1. 选定目标宿主模块树的 `node_modules`。核对该树下 `@deepseek-ai/dsh-client-ui-theme/package.json` 的版本就是这个宿主版本，并确认主题源是同一树下的 `@deepseek-ai/dsh-client-ui-theme/lib/client.js`。没有匹配的源时，先取得正确来源，不以另一宿主替代本线结论。
2. 在运行命令的终端显式设置 `DSAT_HOST_MODULES` 为该模块树的绝对路径，再运行 `npm run check:alias-tokens`。此脚本不加载 `_host-hooks`，也不通过本机配置把 `hostModules` 转成环境变量；只填写本机配置文件不够。
3. 检查输出“枚举自”的完整路径，必须正是预期模块树下的 `@deepseek-ai/dsh-client-ui-theme/lib/client.js`。若不一致，即使退出码为 0，也不能记为本线通过；修正来源后重试。

候选顺序为终端 `DSAT_HOST_MODULES`、`DSH_HOME/profiles/node_modules`（`DSH_HOME` 未设时取 `~/.dsh`）、`%APPDATA%/npm/node_modules/@deepseek-ai/dsh/node_modules`。检查器选择首个能枚举定义的主题源。显式目录不存在、缺主题源或枚举不到别名时仍可能回落，因此设置环境变量不等于锁定实际来源。

退出结果分开记录：`0` 表示所枚举源下没有发现违规，但仍须核对版本与“枚举自”；`2` 表示定义源不可枚举，是环境不足／本项未验证，先补来源；`1` 表示已完成枚举，发现了未定义的主题别名引用，按报告修正引用后重查。静态通过只证明名字在该定义表中，不证明浏览器实际取色或视觉效果。

## 3. 真实实例与页面探针

先读所选脚本，再确认目标实例、版本和认证来源。只创建自己的隔离测试会话；会写共享设置的脚本先保存原值与用户覆盖状态，安排恢复并读回确认。涉及拆装、重启或浏览器时，另外确认维护窗口及运行权限。结束后检查自己的作业与会话，恢复自己的设置修改，记录未清理和未验证项。

### 实例入口与模型路由前提

真机脚本有两类入口，前提不同：

- **连接已有实例**：经[本机配置加载器](<../tools/_local-config.mjs>)取得实例 URL、认证文件与宿主模块树（形状见[示例](<../tools/local-config.example.mjs>)），不自建服务；改共享设置的脚本按上段纪律保存并恢复。
- **自建临时实例**（下表标明「官方 tgz 临时实例」的探针）：`--service-root` 指向装有各宿主安装树的目录（`--host-subdir` 选树），脚本用官方 CLI 把候选 tgz 安装进独立临时 home、随机端口起隔离实例、结束自清，不动任何既有实例。

自建实例中需要真实模型的步骤还依赖**模型路由 patch**：探针缺省取 `<serviceRoot>/patches/zai-glm.yml`（本机部署环境常驻名），把自备 patch 放到该路径即可对所有探针生效；[probe-workflow-engine](<probe-workflow-engine.mjs>) 另支持 `--model-patch`／`DSAT_MODEL_PATCH` 显式传入。模板与凭据准备方法见 [`patches/model-routing.example.yml`](<patches/model-routing.example.yml>)——密钥经 `apiKeyEnv` 指向的环境变量或隔离 home 凭据文件提供，不写进 patch、仓库或证据。patch 缺失时的形态分两档：带启动前置检查的探针（probe-workflow-engine、probe-approval-variants）在启动前置检查即 FAULT 并指向模板；其余自建探针（模型路由经缺省路径取用、无显式传参入口）在实例就绪等待处 FAULT——同属环境前提未满足，不是产品缺陷，第 2 节的静态／离线入口不依赖它。

下表说明脚本实际覆盖什么、会改变什么，不表示已获执行授权或已经完成全部当前要求。新目标超出现有覆盖时，先维护探针再运行。

| 脚本 | 覆盖与副作用 |
| --- | --- |
| [`final-acceptance.mjs`](<final-acceptance.mjs>) | 当前覆盖三个基础工具（async_run / async_wait / async_agent）；路由查询与实时选择由 acceptance-017 承担，workflow 另由专门探针承担。会重置共享设置，运行前确认授权和起始值 |
| [`async-e2e.mjs`](<async-e2e.mjs>) | 命令让出、作业取回及插话；可能修改共享设置，不能直接当无副作用批处理 |
| [`probe-queue-delivery.mjs`](<probe-queue-delivery.mjs>) | 下一轮与下一步领取的区别、插话不杀作业；状态需真实工具结果证明 |
| [`probe-queue-baseline.mjs`](<probe-queue-baseline.mjs>) | 记录实际投递行为，不作为独立通过判据 |
| [`probe-agent-e2e.mjs`](<probe-agent-e2e.mjs>) | 后台创建、有界等待、消息及 persona；不涵盖所有当前实时状态或消息类别，执行前读设置写入 |
| [`probe-settings-behavior-full.mjs`](<probe-settings-behavior-full.mjs>) | 配置变化后的夹紧、裁剪和描述；改共享设置并恢复，完整工具覆盖须按当前目标核对 |
| [`probe-preset-portability.mjs`](<probe-preset-portability.mjs>) | 落盘预设目录形态下的自建挂载可移植性；源目录（`~/.dsh/.agent-presets/dsh-async`）不在时自退出、不产生证据，通过结论不得引用为 bundle patch 路径证据（该路径由 validate-preset 与 d05 承担）；不代表既有自建预设已禁同步入口；若涉及目录或组成写入须隔离 |
| [`probe-escalation-advertised.mjs`](<probe-escalation-advertised.mjs>) | 真实模型工具 schema 中提权键，不代替实际审批 |
| [`probe-sandbox-marker.mjs`](<probe-sandbox-marker.mjs>) | 沙箱拒绝的模型可见词表（由按文件族拦截的沙箱规则承载）与退出状态标记；本部署命令族受限、测试运行器被杀时如实记环境事实，不冒称命令族已验 |
| [`probe-lang-independence.mjs`](<probe-lang-independence.mjs>) | 页面文案与真实描述的双向对照，改共享语言设置；抽样描述不能冒称全部工具全文均核验 |
| [`probe-card-visual.mjs`](<_visual/probe-card-visual.mjs>) | 真实 DOM、计算样式与截图的设置卡形态回归：字段结构（`SETTING_FIELD_KEYS` 六组 20 行全量身份，含 boundPresets 绑定块专项）、值控件度量对照官方 `fields.module.css` 声明值参考表、圆角与宿主 `--dsw-radius-md` 主题令牌运行时同族实证、两主题生效实证与截图；不打开官方设置页并排取样，也不验证官方控件可否替代自绘；起浏览器、每主题分别核验（须 danger-full-access 或非受限环境，受限令牌下浏览器无法启动、立即退出） |
| [`cdp.mjs`](<_visual/cdp.mjs>)（共享装置） | 无依赖 CDP 客户端与截图设施（`launch`/`openPage`/`evaluate`/`waitFor`/`screenshot`/`setViewport`）。截图在**视口尺寸变更**时先等「稳定签名」（滚动尺寸＋元素总数＋左栏文本层计算样式）两读一致再截、同尺寸不重发 override——视口切换后立即采集会拍到中间态（停靠重排竖条帧、宿主侧栏标签层半亮度、React 重挂载清草稿）；探针要在截图前改页面状态时用 `setViewport` 预置视口，让 capture 时尺寸不变 |
| [`probe-gui-persist.mjs`](<_visual/probe-gui-persist.mjs>) | 绑定名单 GUI 持久化真机装置（VERIFY-01，需求 8.2 设置行的绑定名单面）：官方 tgz 可写临时实例，BP 系列九步——基线（设置区在插件页、19 值字段＋20 帮助按钮、绑定块默认态）→子集保存（生效行就地刷新、HMR 无整页重载）→新页回读→空名单合法→恢复默认只暂存→保存后 unset→与 agentLang 并存 unset→重启/重装/升级后三侧（GUI 显示＋RPC user/value＋落盘）一致→终态清净；每步前 patch 快照留痕（ok:null），落盘形态区分 user 键与 patch 空壳行（宿主只删等值键——留痕非覆盖）。证据与失败快照落 `.local/evidence/gui-persist/` |
| [`probe-settings-visual.mjs`](<_visual/probe-settings-visual.mjs>) | 设置页视觉证据装置（VERIFY-01，需求 8.2 设置视觉行）：官方 tgz 临时实例＋无头 CDP，SV 系列——主题实证（底色像素）、草稿清净开局（无「已覆盖」残留）、帮助展开不裁切不下压重叠、四档非法值（非整数/越上界/低于下界/链式）原因行＋aria-invalid＋describedby 首指＋保存禁用＋链式两字段文案、字段尺寸（34/12/13/12/1px）与宿主 token 同族（`--dsw-radius-md` 运行时解析）、主题别名两主题计算值分档、tall 整页（内层滚动容器定高收全「包含的组件/来源信息」）、触屏 tap 与键盘开合（Tab 步数如实记）；**每档近景前草稿扫场**（ok:null 留痕行入 JSON——可复现记录，也是草稿清净的证据）。取证口径：top/bottom 为滚顶/滚底两段（非连续覆盖，完整性由 tall 承担）；触屏开合以 tap 判据与开→合后的收起态近景共同判定（收起画面本身不能自证触屏）。证据与失败快照落 `.local/evidence/settings-visual/` |
| [`probe-ask-visual.mjs`](<_visual/probe-ask-visual.mjs>) | 待答面板视觉证据装置（VERIFY-01，需求 8.2 作答视觉行）：官方 tgz 临时实例＋无头 CDP＋接管态真实问答（BATCH_PROMPT 经真实模型会话出题），AV 系列——主题实证、自定义项上下布局与输入框 ≥3 行、aria 关联（radiogroup/checkbox/labelledby/aria-checked）、自动换行（无横向滚动）、输入即选中（Tab 聚焦不选中）、Enter 不误提交、选中底纹＋边框＋标记两主题、触屏目标 ≥24×24 度量＋tap 生效、提交回执换行原样；截图矩阵＝两席位×两主题×两宽度全景＋**顶/底成对底锚**＋悬停/选中/焦点三态近景（命名 `ask-{座位}-{主题}-{宽度}-{场景}`，悬停拍前 blur 防焦点跨配置携带）、多行草稿整页帧（**像素差分＋可见节点双闸门**：以天然占位符帧为差分基线、写入与断言绑 textarea 自身中心点可见的节点、截后回读——防「断言读写画面外真节点」的断言绿画面空形态）、徽标计数与展开往返；多选形态以接管 state RPC 为权威门禁（模型按宿主 schema 发 snake_case `multi_select`、宿主翻译 `multiSelect`——转录正则曾两版误判，产品无缺陷）。logs JSON 附 `sceneNotes` 逐帧场景说明。证据与失败快照落 `.local/evidence/ask-visual/` |
| [`probe-a11y-input.mjs`](<_visual/probe-a11y-input.mjs>) | 待答面板输入链与无障碍树装置（VERIFY-01 的三项环境边界收窄——**浏览器侧可装置面，不冒称真实硬件链**）：官方 tgz 临时实例＋接管态真实问答（同款排空旧接管项＋state RPC 最新匹配门禁——接管队列跨会话累积，旧形态项会卡死 find 首匹配）。AX 系列：CDP `Accessibility.getFullAXTree` 面板子树（radiogroup/group＋选项 radio×2/checkbox×3＋自定义控件各 1＋textbox，AX 名称覆盖全部 DOM 交互标签含「不答」）＋真实 Tab 键遍历（可聚焦交互全可达、disabled 提交钮合规跳过、首访序＝DOM 序、无陷阱；期望集与读数同款剔除 display:none）；AX-3 判据＝新题温和提醒 live region（role=status＋polite＋atomic＋视觉隐藏类，全页唯一、在面板外）在场；AX-4/5/6＝两座位×收起态新题播报＋徽标计数＋焦点保持、重复轮询/倒计时去重（区域文本不变）、uiLang 播报语言冻结（**分层**：合并多题计数由单元层 test/ask-takeover.test.mjs J50 覆盖，浏览器侧单题批次装置主链）。IME 系列：`Input.imeSetComposition` 组合输入事件链（ic/it 双标志逐事件在案、应用全程不重置值）、组合中 Enter(229) 不误提交、裸 Enter(13) 不破坏组合、`insertText` 替换式提交（compositionend 闭合、终值自洽、败判只认空值/重复拼接）；IME-1b 判据＝组合期提交钮禁用＋就近原因（ask.composing）＋data-composing；IME-3/4/5＝组合期合成点击被拒（题仍 open）、失焦结束组合不补发＋按有效性恢复＋显式再提交成行（转录含组合文）、多题隔离（组合中「不答」可用、他题提交不受影响）——**环境语义如实**：无真 IME 时裸键不提交组合（真 IME 提交键由输入法软件拦截），组合文保留性属浏览器＋输入法行为、无头合成不装置。SK 系列：textarea 无键盘动作暗示 enterkeyhint（白名单仅容空／enter）、inputmode 记录、字号量测（12px＜16px——iOS 聚焦自动放大隐患，按观察项留痕归 VIS-OBS-01）、390×400 视口收缩（键盘遮屏近似）下两题的提交钮与输入框逐控件经面板内部滚动可达（**每题独立滚动位与独立帧**——帧与读数一一对应，防「断言读写画面外真节点」的断言绿画面空形态）。证据与失败快照落 `.local/evidence/a11y-input/`；真实读屏软件／OS 输入法端到端／真实触屏软键盘仍留环境边界，见设计 §9.4 |
| [`probe-r24-bundle-config.mjs`](<_visual/probe-r24-bundle-config.mjs>) | 插件页表单位置、字段身份、秒数与保存恢复；起浏览器并写共享设置，字段期望＝`lib/config.js` 六组键全量（`SETTING_FIELD_KEYS`，含 `askExtendMs` 与 `boundPresets` 绑定块）；同上运行前提 |
| [`probe-vis-ratify.mjs`](<_visual/probe-vis-ratify.mjs>) | 待答徽标与面板视觉判据装置（VIS-BADGE-01／VIS-HOVER-01 终态核对，含计数泡对比度实算）：官方 tgz 临时实例＋接管态真实问答＋CDP 几何/样式读数。覆盖：徽标与面板矩阵（两主题×390/768）——徽标盒入列判定、图标列裁切（rect 左缘＋无 hidden/clip 祖先）、**判据 A＝svg 盒×泡盒零重叠**、**判据 B＝面板盒×侧栏列盒零重叠**、三盒（面板/徽标/泡）零重叠＋elementFromPoint 遮挡、aria-label 全名与面板标题同文、aria-expanded 翻转、面板宽度钳制与 `--sidebar` 让位/右锚；计数泡对比度实算（getComputedStyle 取色＋WCAG 相对亮度，普通文字 ≥4.5）；徽标悬停回归（Input.dispatchMouseEvent 真实指针命中，前后计算样式对比＋包围盒静止，两主题）；终态消隐（两题作答出列后徽标随待答清空消隐）。几何/遮挡为机器读数；截图另由具备视觉判断能力的独立子代理判读。证据与失败快照落 `.local/evidence/vis-ratify*/` |
| [`acceptance-017.mjs`](<acceptance-017.mjs>) | 工具、管理、行为、路由和设置等阶段；文件名只是标识，不是兼容基准，具体阶段副作用先读 |
| [`probe-r26-create-preset.mjs`](<probe-r26-create-preset.mjs>) | 两预设目录及流程；drill／both 涉及声明拆装和重新装载，仅维护窗口运行 |
| [`probe-r28-silent-failure.mjs`](<probe-r28-silent-failure.mjs>) | 三处防护和语言，改共享设置；现有全局纪律断言不能作为需求限定预设范围的通过证据 |
| [`probe-r28-restart-persistence.mjs`](<probe-r28-restart-persistence.mjs>) | 重启保持与设置恢复，人工安全检查和新认证后运行，不自动重启在用实例 |
| [`probe-r29-robustness.mjs`](<probe-r29-robustness.mjs>) | 配置拒绝与等待时长，改共享设置；总预算还须覆盖查询和准备，不能沿用等待段证明 |
| [`probe-r30-ask-takeover.mjs`](<probe-r30-ask-takeover.mjs>) | 超时、迟到、范围、位置和语言；改设置，after-restart 阶段需人工维护窗口 |
| [`probe-r32-run-interruptible.mjs`](<probe-r32-run-interruptible.mjs>) | 插话／停止、卡片、触顶、短命令与通知计数；(b)(c) 经 blank 会话＋agentPresets/select 定预设后走 composer，含浏览器的整跑需提权，不用历史读数证明当前判据 |
| [`probe-r34-async-workflow.mjs`](<probe-r34-async-workflow.mjs>) | 首次等待、任务卡、并发、两预设及运行记录；浏览器与模型运行有权限前提，不用历史读数证明当前目标 |
| [`probe-wait-economy.mjs`](<probe-wait-economy.mjs>) | 等待经济性真机探针（VERIFY-01，需求 8.2「等待必要性」的计量对照装置）：官方 tgz 临时实例两会话对照——EC-A 等待式（async_run 约 45s 作业转后台＋async_wait 足额预算挂起，判据含作业正文经挂起等待返回到达——零等待一次即回执的假等待形态不得 PASS）；EC-B 轮询式（同时长作业＋按指令反复 async_wait wait_ms=0 零等待检查，判据含调用次数 ≥2 的轮询形态锚）；EC-C 对照判定——B 的模型轮次（assistant/message 事件数，两会话自创建起对称累计）显著多于 A（判据：差值≥2 且 A≤3；失败尝试的重试轮在 attempts 中区分），session/list 两行的 usage 聚合与 contextPressure 旁证（读取路径 projections.values.tokenUsage／contextPressure；以无重试首轮为对照，轮询形态的输入输出与缓存读显著放大——供应商不报告时字段缺席不判 FAIL，按在场记录）。装置边界：轮次与用量对照依赖模型依从单步指令（挂起／反复零等待），B 的绝对轮数随模型节奏浮动、判据只锚差值下限与 A 上限＋次数锚；两作业时长刻意相同（45s）排除时长偏差；轮询形态是对照装置，不是本包推荐的用法。正文断言只认宿主侧载体；退出码 0/1/2（未捕获异常也归入 2），证据与失败快照落 `.local/`，`--keep` 保留临时 home |
| [`probe-resume-multilayer.mjs`](<probe-resume-multilayer.mjs>) | 恢复会话与多层子代理真机探针（VERIFY-01，需求 8.2「实时模型选择」行的「恢复会话和多层子代理一致」面＋插话与排队在等待挂起之外／恢复会话／多层链上的行为面）：官方 tgz 临时实例七项（真实模型会话，含一次不卸载重启）——RM-0 装载后 dsh-async 预设会话可用（装载前置失败归判据 FAIL 走收尾退出 1）；RM-1 重启前武装：async_agent 短子代理往返（agent_id 回执＋回答经宿主侧载体到达——会话活跃与派生可用基线）；RM-2 重启后恢复会话：停实例→重启（插件仍在 profile——与 IL-3 卸载重启 resume 被拒对照）→老会话继续接受指令且回执到达；RM-3 恢复会话续派子代理：resume 后同会话再派 async_agent——agent_id 回执＋最终回答到达——「恢复会话的实时模型选择一致」的行为面（派生许可与配置在恢复会话中继续生效）；RM-4 恢复会话排队消息：忙碌窗（async_run 约 20s 前台命令——工具调用在场门控）期间 queue 通道注入→回合边界领取并履行，判据含忙碌窗实锚（async_run 在场＋命令输出正文经宿主侧载体到达——宿主下一轮语义在恢复会话不漂移；RM4_DONE 唯一 token 只在注入文本出现，queue 丢失时模型无法产出；回合边界顺序锚＝RM4_DONE 首现的模型消息晚于忙碌回执首现消息——queue 漂移为回合中拼接时同消息共现、断言不成立）；RM-5 首等工具执行中的插话（等待挂起之外形态——steer 经首等打断机制处理，纯无等待形态不装置）：约 60s 命令（async_run yield_ms 600000——首等窗内）执行中 steer 通道注入——实测形态：steer 结束首次等待→返回同一作业句柄（契约「插话只结束等待、绝不终止命令」）→命令后台续跑→正文经后续等待到达（未终止）＋插话指令被履行（RM5_STEER_DONE 唯一 token 回执——主锚；agent/inbox/spliced 事件在场为旁证，该宿主对上下文注入同样产生 spliced、不单独归因）；RM-6 多层链与主代理层插话：主代理派中间子代理→中间代理再派孙代理（固定 token）→孙代理 token 双跳经中间代理到达主会话（MID_DONE＋GRAND token＋孙 agent_id 形态经注入侧载体——成功返回经宿主 render 的产物，提高无派生转写成本；转写假 PASS 方向披露：中间代理可不派孙代理直接转写 prompt token，主会话面不可核验孙会话——双跳结论以模型两跳依从为前提）＋期间主会话 steer 插话照达主代理层（唯一 token 回执＋spliced 旁证）——宿主 rc.5 不允许后台子代理直接人类交互，插话落点是主代理层、子代理层不被打扰即「多层中的插话不漂移」。装置边界：「实时模型选择一致」锚定行为面（恢复会话/多层子代理链的派生可用与回答投递、许可链畅通）；配置变更（新增/删除路由后派生被拒）的拒绝面不在本装置（由套件层许可链用例承担，不冒称实例层覆盖）；RM-2 的 resume 拒绝形态发生在 session/prompt RPC 层——探针用 rpc() 原样捕获错误体判 FAIL（错误体入证据，不混入 FAULT；老会话不在重启后名册同样按 FAIL 如实记录）；RM-5 时序不精确断言（只断「命令完成＋插话被履行」两宿主侧事实）；RM-6 依赖模型两跳依从，中间层失败按 FAIL 取证（快照含注入消息形态区分模型未依从与投递丢失）；重试同 token 边界（首试迟到结算可落重试窗——已知缺口、概率极低、attempts 快照可事后归因）；长跑命令依赖 PowerShell——非 PowerShell 宿主上 RM-4/RM-5 按输出正文缺席 FAIL（非 FAULT）取证。实例模型路由前提见本节首。退出码 0/1/2（未捕获异常也归入 2），证据与失败快照落 `.local/`，`--keep` 保留临时 home |
| [`probe-subagent-uninstall.mjs`](<probe-subagent-uninstall.mjs>) | 子代理 activation 卸载面真机探针（VERIFY-01，需求 8.2「安装卸载」行的子代理面／设计 §7.1 第三类待核验对象与 §8.2 核心矩阵「activation 生命周期」行、§3.3 后台所有权约定「不在工具出口、finally 或工具行卸载时调用 dispose」）：官方 tgz 临时实例四项（真实模型会话）——SU-0 装载后 dsh-async 预设会话可用（装载前置失败归判据 FAIL 走收尾退出 1）；SU-1 武装步：经 async_agent 派生长跑子代理（子代理执行约 90s 命令后以固定 token 回答）——async_agent 调用在场＋工具返回含 agent_id（子代理真正被宿主接受的启动锚）＋模型回执；SU-2 主判据（单尝试——子代理最终回答是单次投递事件，重试窗口基线会切走已发生事件）：子代理运行中经官方 CLI plugin remove（运行中实例）——子代理照常结算、最终回答经宿主侧载体（注入侧 user/message，source 形态不限——与 LA-4 的注入分支同一口径；子代理场景下另两种载体不可达，本判据单载体不窄于 LA-4）到达主会话＋主代理按指令回执——「activation 所有权属宿主、卸载不停止后台」的行为面实证；SU-3 卸载后老会话可续派子代理：remove 后同会话再派第二个短子代理——agent_id 回执＋其最终回答照常到达——保活链子代理面完整（内存中插件仍在，与 IL-2 作业面对应）。装置边界：宿主组件内部（dsh-subagent）的 activation 清理不可从 RPC 面观测——本装置锚定行为面（结算照常＋父通知照投＋可续派），自然结算后的资源释放由宿主负责（设计 §3.3 后台所有权约定）、内部释放证据不冒称；SU-2 存在窗口竞态边界（武装步周转＋基线＋remove 合计超过子代理剩余时长则主步必 FAIL——装置形态、证据含 remove 耗时可事后归因），子代理时长取 90s 留周转窗口；Windows 文件锁使 remove 失败按环境形态记录（IL-2 同款——此时 SU-3 的 PASS 只证续派形态在场、不证卸载后可续派，事后按 pluginRemove.status 区分）；子代理长跑命令依赖 PowerShell（Start-Sleep）——非 PowerShell 宿主上 SU-2 按 FAIL（非 FAULT）取证。实例模型路由前提见本节首。退出码 0/1/2（未捕获异常也归入 2），证据与失败快照落 `.local/`，`--keep` 保留临时 home |
| [`probe-selected-default.mjs`](<probe-selected-default.mjs>) | 默认预设 selectedDefault 风险真机探针（VERIFY-01，需求 8.2「安装卸载」行「默认预设风险可复现与指引」项／需求 565／设计 §5.4＋§7.2）：官方 tgz 临时实例九项断言（全部探针侧——设置读写与 session/create 成败即载体，**不经模型周转**）——SD-0 指引在场（静态）：client.js 两语词典键 `uninstallRisk`（各含 agent-preset/not-found 与清选／重选动作）与设置页渲染调用（t("uninstallRisk") 在场——词典保留而渲染调用被删时判 FAIL）＋中英两语首页与用户参考指引段在场（提示块渲染质量与深浅主题可读性属 GUI 面不装置——渲染调用本身已静态断言）；SD-1 风险复现：装载后首读 selectedDefault 不指向本包预设（需求 555「不抢默认预设」佐证）→经公开设置接口（GUI 同链 settings/update，ns=`agent-preset-registry`、直根字段不包 settings 子树）写为 dsh-async＋describe 复核→官方 CLI plugin remove＋重启→无指定预设的 session/create 被拒且错误形态锚定 agent-preset/not-found（不静默回落）＋describe 复核 selectedDefault 仍指向已撤预设（宿主不自动清除该选择）；SD-2 重选路径：改写为部署默认可用预设（部署默认不经设置面暴露——describe 的 value 投影只含 volatile 用户字段；standard＝rc.5 实测部署默认硬编码、换树按 FAIL 取证）→默认会话创建成功落该预设（真比对）；SD-3 清选路径：settings/mutate unset（该 ns 直根 schema 的 path 不带 settings 前缀——与 async-tools-host 嵌套 schema 不同）→默认会话落部署默认（落点与 rc.5 实测值精确比对、漂移即 FAIL）。装置边界：临时 home 探针自建自清、设置写入无需回写原状；SD-1 的 not-found 与 IL-3a 同源（显式与默认预设走同一 resolve）、其他错误码不算复现（错误码精确相等锚定）；「不抢默认预设」佐证仅全新 home 一次装载形态取证。装载前置失败归判据 FAIL 走收尾退出 1（不混入 FAULT）。实例模型路由前提见本节首。退出码 0/1/2（未捕获异常也归入 2），证据与失败快照落 `.local/`，`--keep` 保留临时 home |
| [`probe-workflow-engine.mjs`](<probe-workflow-engine.mjs>) | 编排 PTC 钩子真机探针（VERIFY-01，需求 4 章 async_workflow 行为约定 232-257 行）：官方 tgz 临时实例三步——WF-1 pipeline 逐条独立流过＋局部降 null（纯 JS 阶段三条件、中间条第二阶段抛错：该条降 null 跳过其余阶段、其余条目正常、脚本照常 return——「局部错误不终止」；判据＝单次 async_workflow＋alpha/gamma 正结果与序列化 null 到场（载体＝工具返回∪完成消息——24s 首次等待内纯脚本必完成，前台直接返回或短等待返回都合法）＋回执）；WF-2 致命误用终止整个脚本（agent() 传未知选项 effort——契约「effort/isolation/agentType 一律报错拒绝」：判据＝错误文案在场（effort＋错误语标记共现）＋**子代理 token 永不出现**（校验在派发前后两形态都闭合——终止不被 parallel 吞成局部 null）＋单次调用＋回执）；WF-3 真实子代理＋phase/log＋进度日志默认关闭（脚本声明 phase 标记、派一个真实子代理（token 回执）、log 标记：判据＝子代理 token 经结果正文到达（转后台后按指令经 async_wait 领取或完成消息到达——载体不限）＋**phase/log 标记缺席交付正文**（工作流进度日志展示开关默认 false——观察日志仅供界面与既有记录；最终结果不属可关闭日志必须到达）＋单次调用＋无 job_output＋回执）。装置边界：并发/总量/组合上限与「并发槽满排队」属宿主 PTC 引擎出厂行为（设计 §「宿主 PTC 编排引擎的核验基准」；需求 236 本包不重写引擎与配置），各步 ≤1 子代理不触发，也不由本仓套件锚定（套件两处编排引擎均为替身）——按宿主行为边界不装置不另锚定；同属编排契约但不单独装置：parallel 普通函数错误降 null（与 pipeline 局部降 null 同语义不同钩子，本装置只装置 pipeline 侧）、agent() schema 白名单外字段拒绝、meta 未知字段拒绝；GUI 回放持久节点（运行开始、子代理开始／结束、运行结束）的界面呈现不在 RPC 装置范围、也不进证据快照（提取器按 event.type 过滤不含 recorder 事件）——需要时可从会话档案另查；meta.phases 精确标题匹配与 phase 进度观感不单独装置。实例模型路由前提见本节首。退出码 0/1/2（未捕获异常也归入 2），证据与失败快照落 `.local/`，`--keep` 保留临时 home |
| [`probe-concurrent-wait.mjs`](<probe-concurrent-wait.mjs>) | 并发等待与同批交付真机探针（VERIFY-01，需求 9.3.2 场景 2／场景 7 的可脚本化子集）：官方 tgz 临时实例＋**装置前提**（探针经公开设置接口把 minYieldMs 临时调至 1000、收尾恢复——出厂默认 20000 会把 prompt 的 yield_ms 8000 夹紧为 20s，短窗作业前台直付、核心检验面被旁路；夹紧形态下的旧读数不作为检验面通过依据）三步——CW-1 指定目标＋非目标同批（作业 A≈15s／B≈50s、等待只指定 B：B 正文经等待返回＋A 正文与等待交回同批到达（载体＝等待返回或同窗完成消息——主体忙碌先注入完成消息也是设计允许的同批形态）＋单次等待挂起时长下界锚（贴 B 剩余、不被 A 完成时刻顶穿；并行正确≈46s／串行≈31s、误触发≈11s 被拦；设置前提修复版实测 40s））；CW-2 多目标任一满足（A≈60s／B≈25s 都在目标列表：B 正文在场（载体不限）＋**A 正文缺席**主锚（误等全部目标时 A 正文进入等待返回、缺席断言拦截；span 不承担「任一 vs 全部」分隔——两起跑形态 span 分布重叠；实测 12s）＋span 未挂满预算）；CW-3 无目标等待＋同拍完成（两作业各≈12s：P、Q 两正文并入同一次等待返回（载体不限、同窗近似）＋挂起时长未挂满预算——设置前提修复版实测 4s（挂起后同拍交回，就绪唤醒/复查通道真正受压）；无目标等待在全部工作结算后应因可用内容交回）。三步共通：单次 async_wait（正文来源与时长锚定同一次调用）＋同窗无 job_output（需求「不附纯读取指令」）。装置边界：等待取消与交付重叠、条目上限／批预算截断的延后与恢复、完成消息路径批级配额属套件层受控装置（test/wait-delivery.test.mjs），真机内容量小不触发上限；各步 prompt 显式要求串行单工具调用（违规并行时 span 配对可靠性下降，误差方向假 FAIL——模型稳定偏并行时不自愈，按 FAIL 如实取证）；「同批」断言以同窗近似（同一模型输入边界宿主不可辨）；正文载体断言取等待返回∪完成消息（结算时刻与等待发起的先后关系由模型周转决定，两形态都合法）；CW-2 极慢周转下正确实现也会按同批汇集携带 A 正文（假 FAIL 方向、有重试）；作业命令依赖 PowerShell（Start-Sleep）——非 PowerShell 宿主上按 FAIL（非 FAULT）取证；首跑（设置前提修复前）CW-3 曾出现 span≈121s（挂满预算才交回两正文）形态，**成因未定**：夹紧世界的复跑只能弱排除（P/Q 前台直付、就绪通道未被压到），设置修复后挂起路径才真正受压——判据保留挂满 FAIL 拦截，复现时记录触发条件与实际载体并核查原因。实例模型路由前提见本节首。退出码 0/1/2（未捕获异常也归入 2），证据与失败快照落 `.local/`，`--keep` 保留临时 home |
| [`probe-approval-flow.mjs`](<probe-approval-flow.mjs>) | 单次审批真机探针（VERIFY-01，需求 §6.1「沙箱与单次提权」）：官方 tgz＋**探针自带的测试 answerer 插件**（按 justification 标记 PROBE:ALLOW／PROBE:REJECT 真实接宿主审批 seam 作答，`{ prepend: true }` 抢在 api-remotes 转发器之前——转发器入队 gateway pending 后无作答时不调 next、占链挂起）临时实例三路径——AP-1 批准（danger-full-access：审批审计对在场（approval/asked 的 toolName='async_run'＋callId 与 tool/call 配对、approval/decided 同 id outcome='allowed-once'——log-only 事件经 API session/page records 原样可读）＋作业正文到达＋工作区外文件真实写成（获批模式生效的正面证据））；AP-2 拒绝（同目标另一文件：审计对 outcome='rejected'＋宿主拒绝文案「the user rejected escalating」＋**目标文件不存在**（零进程启动的直接证据）＋审批失败在注册之前（本窗零作业注册事件））；AP-3 同级预检（sandbox_permissions 与当前模式同级：插件预检文案（escalationSameLevel）＋**零审批审计**（预检在 seam 之前）＋本窗零作业注册＋命令正文未出现）。装置边界：seam 缺席（组合不含审批服务）与「无人作答」（unavailable）、web 默认形态（转发器占链无浏览器时挂起）三个变体需额外 overlay 禁用组合行，已由专门装置覆盖（见 probe-approval-variants.mjs 行）；AP-2「文件不存在」作为零进程直接证据依赖模型如实转写命令与目标目录可写两前提（装置边界头注同款声明）。cancelled 变体不单独装置（与 rejected 同链仅 outcome/文案不同）；「不外溢后续调用」未单独装置（AP-3 对许可外溢有隐性检出力——外溢成会话模式则同级请求成更窄、文案正则不匹配即 FAIL）。模型路由前提见本节首。探针实例不设 DSH_PERMISSION_MODE（默认 workspace-write → 审批策略 'ask'；设 danger-full-access 会变 'never' 破坏前提）。退出码 0/1/2（未捕获异常也归入 2），证据与失败快照落 `.local/`，`--keep` 保留临时 home |
| [`probe-approval-variants.mjs`](<probe-approval-variants.mjs>) | 单次审批降级变体真机探针（VERIFY-01，需求 §6.1「沙箱与单次提权」——probe-approval-flow 登记的「seam 缺席／无人作答 unavailable／web 默认挂起三变体需额外 overlay 禁用组合行」项）：官方 tgz 临时实例、**不装 answerer**（与 approval-flow 的关键差异），三变体各起独立实例，变体经 `--patch` overlay 禁用组合行构造（cordis patch 语义：id 匹配行的字段覆盖、`disabled: true` 即禁行；行 id 取自 `dsh --profile web --dump-config`）——AV-1 审批服务缺席（禁 `approval` 行）：宿主 approveEscalation 对 approver 缺席在执行前抛「requires approval, but no approval service is composed」，判据＝该文案到达＋**零审批审计对**（服务缺席连 asked 都不出现）＋提权调用零注册＋目标文件不存在（零进程）＋回执；AV-2 无人作答 unavailable（禁 `api-remotes` 行——bundle 层先注册的转发器，不禁则占链挂起轮不到 fallback）：approval waterfall 空转→宿主回退返回 `unavailable`，判据＝审计对在场（asked＋decided，outcome='unavailable'，callId 与 tool/call 配对）＋「no approval channel is available」文案＋提权调用零注册＋文件不存在＋回执（**fail-closed 方向实证：无人作答不放行**）；AV-3 web 默认形态（默认组合不动、无浏览器连接）：转发器把审批请求挂进 gateway pending，判据（观察窗 90s，窗满无 decided 才判 PASS）＝提权调用的 asked 在场（reason 含 PROBE:V3 标记）＋无 decided＋无降级文案返回＋提权调用零注册＋目标文件不存在。装置边界：**两步式装置（三变体统一）**——单步式（凭空主动带提权参数）依从性不可靠（AV-1 环境无审批策略系统声明、模型拒绝；解释挂起缘由的 prompt 反触发模型安全审查——迭代留痕于头注），定稿为先普通调用吃沙箱拒绝、按宿主 escalation hint 官方路径重试提权（AV-3 定稿为中性操作指令）；第一步是普通调用（进程启动注册在场后被 fence 拒绝），「零注册」判据因此收窄为提权调用零注册（注册数<调用数）；模型依从性存在时窗波动（同 prompt 时过时拒，拒绝形态留痕于证据快照 modelTail），重试上限 3、重试轮在原指令前加 harness 确认段（不改判据——判据只认工具与审计载体）；宿主改组时 overlay 落空（Loader warn「patch: entry not found」）→形态互换按 FAIL 取证归因；「零审计对／无 decided」为缺席断言（宿主把审批事件改走其他投影载体时假 FAIL，保守方向）；AV-1 文案锚定宿主 dsh-sandbox 现行英文串、AV-2 outcome='unavailable' 为宿主 fail-closed 回退现行词表值（宿主改形态按 FAIL 取证）；cancelled 变体不装置（与 rejected 同链）；「无主体」由插件入口拒绝并经套件层覆盖。模型路由前提见本节首。探针实例不设 DSH_PERMISSION_MODE（默认 workspace-write → 审批策略 'ask'）。退出码 0/1/2（未捕获异常也归入 2），证据与失败快照落 `.local/`，`--keep` 保留临时 home |
| [`probe-install-lifecycle.mjs`](<probe-install-lifecycle.mjs>) | 装卸生命周期真机探针（VERIFY-01，需求 8.2「安装卸载」行／设计 §7.1–7.2 装置）：官方 tgz 临时实例三组断言——IL-1 干净装载可用（dsh-async 预设新会话＋前台命令正文；装载前置失败归判据 FAIL 走收尾退出 1，不混入 FAULT）；IL-2 进程内 owner 作业生命周期——约 75s 作业转后台（作业 id 注册锚）后经官方 CLI 执行 pnpm remove，运行中实例里作业照常结算（job/settled(completed) 在案）、本包完成消息照投（保活链随内存中插件仍在）、老会话 job_list 调用在场（「只卸载工具行不取消已启动工作」；武装步未成立时主步按归因受限单独记录，不并入卸载取消结论）；IL-3 重启后声明退役——新会话显式 dsh-async 被拒（agent-preset/not-found 可读错误＋可用名单指引，不静默回落）、无指定预设落在宿主可用默认（记录落点，响应省略字段按落点未知判 FAIL——落点未被实证）、卸载前老会话仍在 session 名册；老会话重启后继续发指令的宿主形态如实记录（实测：resume 报 unknown preset——generation 引用不跨重启，属宿主行为边界，两种形态都只记录不断言）。装置边界：「卸载后宿主完成通知照发（含原生读取工具引导句）」的 §7.2 形态在本装置不可达（作业随停实例终止），该部分由套件层「抑制失败与外来作业的宿主完成通知」用例承担；「owner 处置确实取消」的正面路径（§7.1）无实例证据，由套件层 hooks.cancel 入口锚定；pnpm remove 在运行中实例的 profile 上执行，Windows 文件锁若失败按环境形态记录（FAIL 注明原因，不视为产品缺陷；remove 未生效时 IL-3a 亦连带 FAIL——预设仍在花名册，属交叉印证而非误报）。实例模型路由前提见本节首。正文断言只认宿主侧载体；退出码 0/1/2，证据与失败快照落 `.local/`，`--keep` 保留临时 home |
| [`probe-wait-semantics.mjs`](<probe-wait-semantics.mjs>) | 等待语义真机探针（VERIFY-01，需求 8.2「目标判断／共用等待／等待必要性与协作续接」装置）：官方 tgz 临时实例真实模型会话六步断言——WS-1 未知目标可读拒绝（error.unknownJob＋job_list 指引，两次调用都在场）＋零等待立即返回（<10s 断言）；WS-2 目标终态提前交回（单次调用断言，挂起时长远小于 180s 预算；作业已就绪时立即交付亦合法——需求 8.2 目标判断行「已就绪内容……及时交回」）；WS-3 非目标不唤醒（单目标指定装置，单次调用断言，挂起贴目标 B 的剩余窗口；装置边界：模型串行启动两作业，非目标 A 时序上早于等待开始，本步主证「B 正文＋时长窗口」而非 A/B 竞态）；WS-4 steer 通道插话打断等待（挂起 10s 交回＋agent/inbox/spliced 在案＋无 killed 结算）；WS-5 queue 通道排队消息不唤醒——150s 作业在正常模型周转下恒晚于预算到期，挂满 60s 预算经**到期出口**返回（到期注记只认 async_wait 自身返回的「预算到期」文案——转后台返回的「仍在运行」不参与断言；本步作业未结算、token 不在返回中）；WS-6 已完成子代理经 send_message 协作续接（两次回答均经宿主侧载体）。时间判据优先取转录 at（epoch 数字串与 ISO 双形态，负差值回退墙钟），缺席时以轮询墙钟回退（seq 缺席按数组下标，装置假设串行单工具调用）；载体断言按步切窗、结算断言按本步作业身份过滤（id 主源为本窗 job/registered 事件，与 jobKind 命名解耦；跨步残留作业不误伤）；正文断言只认宿主侧载体。实例模型路由前提见本节首。退出码 0/1/2（未捕获异常也归入 2），证据与失败快照（末态）落 `.local/`，`--keep` 保留临时 home |
| [`probe-live-acceptance.mjs`](<probe-live-acceptance.mjs>) | 当前候选实装行为复验探针（VERIFY-01）：打包当前工作区为官方 tgz（`files` 不含 verify/——探针自身未提交改动不进包）→ 系统临时目录独立 home＋官方 CLI 安装 → 随机端口隔离实例＋真实模型会话，五步单步指令逐项断言：前台命令正文、后台作业经等待领取或完成消息到达（交付载体不限定，但 async_run／async_wait 须在场）、job_kill＋job_list 名册且 job/settled(killed) 事件在案（killed 只能由 kill 产生，不被前序结算污染；job_output 不在模型调用记录——「未调用」不严格等于「不可见」，抽样边界见脚本注释）、后台子代理最终回答经宿主侧载体到达（模型转写不算——token 明文在指令里，转写可伪造）、空闲主体完成消息注入（JOB_RESULT_SOURCE）。正文类断言只认宿主侧载体（工具返回／完成消息／注入消息），模型文本只作回执。每步超时或断言不成立同会话重试一次（模型偶发不执行单步指令不等于产品缺陷，重试留痕不静默）；证据文件每次落盘（判定明细），失败快照仅未成立时存在，都在 `.local/` 下供离线区分「模型未执行」与「载体取证缺口」。退出码 0＝全过、1＝有 FAIL 判定、2＝探针自身故障。边界：五步为脚本化行为面抽样，不覆盖交付竞态（这些范围仍需独立实例证据）；单次审批由 probe-approval-flow.mjs 与 probe-approval-variants.mjs 覆盖；恢复会话与多层子代理由 probe-resume-multilayer.mjs 覆盖；编排 PTC 由 probe-workflow-engine.mjs 覆盖 |
| [`probe-batch-window.mjs`](<probe-batch-window.mjs>) | 完成消息领取窗口（REL-NOTES-01）：每波 14 个错峰后台作业经真实模型会话结算，断言窗口消息有界、作业标记零丢失（完成消息与让出出口结构化附着合并计）、next-step 领取事件在案；>10 条目的触顶窗口才判配额说明——真实宿主领取点在每个模型步进边界实发，自然流未触顶时如实登记「未触发」，配额路径由套件层 `test/wait-delivery.test.mjs` 的 T8/RN-* 在真实注册表锚定，不伪造触发。须授权的临时实例与模型运行，证据经 `DSAT_PROBE_EVIDENCE` 落盘，不含令牌 |
| [`probe-settle-idle.mjs`](<probe-settle-idle.mjs>) | 结算与领取时序真机探针（VERIFY-01，需求 9.3.3「子代理变化与消息分工」的结算通知语义＋9.3.2 完成消息领取的自然时序面）：官方 tgz 临时实例、**按系列分会话**（SG 挂起系列／SG-3 入口／IR 各一个会话——模型路由偶发停摆时不放大成全局失效；停摆防护＝180s 无新记录且非运行即按停摆失败该尝试、换会话重试每系列一次）＋zai 真实模型，十二项断言——SG 系列（结算通知与注册表状态滞后）：a1 单目标构造（单 async_agent、无等待类工具）／a2 补等合法（真实模型会再等——async_wait ≥1＋各完成等待首见墙钟 <150s；「次数恰 1」是假 FAIL 装置假设已实证废除）／a3 结算通知在场（sender 对上；异己通知缺席）／a5 双载体计数（结算通知×1 恒在＋转达消息 0–1，合计 ≥1 即合法——宿主指引与探针「无其他工具」指令竞争，转达缺席合法）＋硬性不变量（无据停止断言白名单、同报结算与运行共现、滞后 −6s/14s 容差——次序＝记录下标、毫秒差＝首见墙钟（转录记录不携带 at，轮询粒度 ≤4s））；SG-3 入口变体（等待开始前通知已到）。IR 系列（忙碌无活等待回合的完成消息领取）：45–90s 后台作业＋模型同回合写约 900 字长文——判据＝单次 async_run＋结算在场＋完成消息恰一次（token×1）＋领取 splice 组在场（**锚收集＝回走跳过规则**：splice 与消息记录间可隔步／回合机器记录 [splice][step/start][user/message]，组＝相邻串、回合边界形态可能只含尾 splice），形态判别＝组只含 next-step→inject-during-step／组含 next-turn→followup-after-idle；「注入后产出」与回执均为观测／旁证字段（回执抢跑＋跟随回合静默是合法模型行为，真机实证）；滞留检出不以回执缺席为前提（回执在场＋记录缺席按抢跑口径登记仍转 IR-5）。IR-5 滞留恢复（检出即立即执行、中性 queue 唤醒、单尝试、预读守卫）。失败快照含 windowShape（窗口末 40 条 event.type 序列，供离线归因 splice 邻接形态）。退出码 0/1/2（未捕获异常也归入 2），证据落 `.local/probe-settle-idle.json`；实例运行的实际范围与未触发条件按设计 §9.3 对应日期条目核对 |
| [`probe-echo-blind.mjs`](<_visual/probe-echo-blind.mjs>) | 回显开关盲测采集装置（ECHO-WORKFLOW-01 真机盲测材料采集）：官方 tgz 临时实例＋无头浏览器＋真实模型会话，M1-M4 四组——M1 界面原始记录（GUI 调用卡展开态子树 DOM＋截图、两态同形、全量转录含 agent/inbox/spliced）、M2 真实模型流（同回合双作业、job_list 复述、模型逐字引用）、M3 设置页两语＋窄屏折行（六帧先滚动框定）、M4 保存翻转后下一次交付对照（RPC 读值时序与截图双记）；断言为判定式等待（调用＝tool/call 含 token、结算＝source=async-tools-job-result 同条含输出 token、引用＝assistant 记录），CAP/GAP 只登记采集事实、判定权在独立盲测代理（材料原样落 `.local/evidence/echo-blind/`，装置面说明随卷）。装置边界：卡片判定依 DOM 读数（PNG 框定为装置登记项）；宿主记录的 content 为分段数组，文本抽取须逐段 join（直接字符串化会得对象串假阴性）；操作者日志行按宿主观测边界登记（web 形态 ctx.logger.info 只进 cordis 内存环形缓冲、无外部出口）。需 danger-full-access（浏览器与隔离实例） |
| [`probe-lang-blind.mjs`](<probe-lang-blind.mjs>) | 语言开关行为层盲测主装置（AGENT-LANG-01 真机盲测材料采集）：官方 tgz 临时实例＋真实模型会话——NI-1..3 空闲作业无冗余领取 e2e（D=45/60/75s 档、token 断言域恰一次、完成消息恰一条）、LP-A/B/C/D 两档词典与组稿形态、settings 改动痕迹与 splice-group 读数；材料原样落 `.local/evidence/lang-blind/`，判定权在独立盲测代理。需提权运行（隔离实例＋真实模型） |
| [`probe-lang-blind-2.mjs`](<probe-lang-blind-2.mjs>) | 语言开关补充采集装置：U-1 uiLang 独立性（agentLang=en＋uiLang=zh 下四类载体与 en 基线对照）、L-1 同会话活读切换（zh→en 后 system/message、change 型 header、note、完成消息四载体换档）；记录文本抽取按分段数组逐段 join（对象形态直接字符串化会失败）。材料原样落 `.local/evidence/lang-blind-2/`，判定权在独立盲测代理 |
| [`probe-lang-err.mjs`](<probe-lang-err.mjs>) | 语言开关错误文案两档装置：en／zh 各一会话，经真实模型调用 async_wait 指向不存在 job id，tool/result 错误文本原样落卷（词典 error.unknownJob 两档对照）；仅改写 agentLang 且收尾恢复。材料原样落 `.local/evidence/lang-err/`，判定权在独立盲测代理 |

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

下方“实现变异索引”登记实现变异与目标测试文件，并由索引检查器双向核对。检查器输入变异包括文档路径、裸文件名、公开范围、模型文本、策略、界面及语言等。

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
| `verify/mutate-list-children-shape.mjs` | `test/wait-delivery.test.mjs` | 子代理目录形状 |
| `verify/mutate-r55-entry-scan.mjs` | `test/wait-delivery.test.mjs` | 等待入口扫描 |
| `verify/mutate-atb01-final-result.mjs` | `test/wait-delivery.test.mjs` | 最终结果同次交付，另有真实注册表测试 |

检查器输入变异包括路径、编码之外的公开范围、模型文案、主题、策略和界面判据等，分别由脚本自身声明入口；[变异索引检查器](<../tools/check-mutate-index.mjs>)核对上述实现表和具名例外，不以文档表代替执行结论。
