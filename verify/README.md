# 验证目录

这里放**活体验证**：真连一台 dsh 实例跑出来的证据。包内单测（`test/`）用替身，
这里全是真的。

## 先配好实例坐标（本目录的判据全都需要它）

本目录的脚本连的是**你自己那台实例**。坐标不写在代码里，经 `tools/_local-config.mjs` 读：

1. 环境变量（优先）：`DSAT_INSTANCE_URL`、`DSAT_TOKEN_FILE`、`DSAT_INSTANCE_HOME`、
   `DSAT_SERVICE_LOG`、`DSAT_HOST_MODULES`；
2. 否则读仓根下不被跟踪的 `.local/config.mjs`——照着 `tools/local-config.example.mjs`
   复制一份改名即可，里面逐字段写了每个坐标是什么。

**两样都没有时会怎样**：脚本打一行 `SKIP …` 并以 0 退出。这不是失败，是**文档化跳过**
——这类判据只对"有一台活体实例的开发机"有意义，CI 与外部 clone 上本来就没有可连的东西。
反过来，`.local/` 在、而配置文件缺失或装载失败，按**红**（红＝测试失败）处理：那是配置坏了，不是缺席。

**证据落点**也在配置里：`evidenceDir`（缺省 `.local/evidence/`）。转录、DOM 转储、判定
报告与截图都写在那里——它们是**运行产物**，不是源码，所以与配置、语料同属不被跟踪的本机平面。

## 一次跑完

```powershell
node verify/final-acceptance.mjs        # 硬要求总判定（四工具口径）
node verify/async-e2e.mjs               # 四个工具的主链路 + 插话打断
node verify/probe-queue-delivery.mjs    # R12：queue 不打断且轮次边界投递；steer 仍打断
node verify/probe-agent-e2e.mjs         # R13/R14：async_agent 立返→等待→独立回答 + persona
node verify/probe-settings-behavior-full.mjs   # 设置改了真生效
node verify/probe-preset-portability.mjs # 预设是模板不是限制
node verify/probe-escalation-advertised.mjs    # R11：两个提权键真的广告了
node verify/probe-sandbox-marker.mjs    # R11：模型看得见退出码与沙箱标记
node verify/probe-lang-independence.mjs  # R25：两个语言开关互不牵连（页面 DOM + request/header）
node verify/probe-r28-silent-failure.mjs # R28：三防线真机 1–4、6（真机 5 单独跑，见下）
node verify/_visual/probe-card-visual.mjs      # 设置卡片的样式与折叠（无头浏览器）
node verify/_visual/probe-r24-bundle-config.mjs # R24：插件页设置区 DOM + 保存往返（无头浏览器）
node verify/acceptance-017.mjs r24-ui          # R24：注入表把本包 client.js 列进 preload 行
node verify/acceptance-017.mjs behavior        # §26.3 让出/等待/插话测试集
node verify/acceptance-017.mjs agent           # §26.3.9 指定路由真机判据
```

`package.json` 里的别名：`npm run acceptance` = `final-acceptance.mjs`，
`acceptance:e2e` = `async-e2e.mjs`，`acceptance:settings` = `probe-settings-behavior-full.mjs`，
`check:agent-policy` = `verify/check-agent-policy.mjs`。其余脚本直接 `node verify/<脚本>` 按需跑。

包内自检（不碰真机）另有一条：`npm run check:model-text` = `tools/check-model-text.mjs`
（模型面文案四层判据）；它的硬编码文案层变异证明是 `verify/mutate-model-text.mjs`，
默认权限下直接跑，读数 11/11。

**预设生命周期判据的旧形态已整体退役**：预设改由随包 patch 的插件行声明、生命周期归
loader/fiber，"往用户预设根写目录 + 所有权判据"的 e2e 探针、判据模块与备用卸载命令
一并删除。"装上出现 / 卸载消失"改由 §26.3.9 的"移除包名重启后无残留"端到端判据承接。

### 这些脚本会改真实实例的状态，跑之前知道自己要什么

- `probe-settings-behavior-full` 会**改写真实设置**再逐条还原。它被中途打断（手动中止、
  超时被杀）时 `finally` 不保证跑完，可能把 `maxWaitMs` 之类留在实例上——那样后续真机判据
  会因为"等待上限太窄"而假红。**跑完请确认已还原**：`node verify/restore-async-settings.mjs`
  是它的独立还原出口。`final-acceptance` 与 `async-e2e` **自己也会在开跑前把设置写回出厂
  默认值并读回核对**——每个真机脚本自己保证起跑状态，不依赖别人的 `finally`。
- `probe-preset-portability` 会**临时建一个预设目录**再删掉（旧代际形态；升级后预设不再落
  目录）。它只删自己建的那个，删之前核对里面确实只有它写的文件。
- `probe-card-visual` 会**起无头浏览器**。⚠️ 每次启动都会让 Windows 产生一条**失败登录
  审计事件**；若你的机器配了登录失败锁定策略（常见的是 10 次 / 10 分钟），连跑十几次
  就可能把账户锁住。**不要把这个脚本放进任何批量流程。**
- 需要重启实例的探针（`probe-r28-restart-persistence.mjs`、`probe-r30-ask-takeover.mjs
  --after-restart`）**不进批量清单**：它们要求人工先过安全门（实例上没有正在运行的会话、
  你自己不在那个实例上、只动该动的那一台），重启后以**新令牌**重新起跑。
  **不要在别人正在干活的实例上随手重启**。
- 脚本**不写死实例坐标**（那是配置的事），也不写死自己的位置——从 `import.meta.url` 推算。

## 判据必须在默认权限下可跑

**规则**：任何"判据"（检查器、变异脚本、探针、测试）都要能在**默认沙箱、不提权**下跑出
它该有的红绿。跑起来需要特殊权限的判据，**它的红绿只反映权限，不反映被测对象**——等于没有判据。

**为什么立这条**：`verify/mutate-facts-anchors.mjs` 第一版用 `spawnSync` 捕获检查器 stdout，
而默认沙箱下**子进程管道捕获一律 EPERM**（`verify/diag-spawn-contexts.mjs` 的对照实验：
`spawnSync`/`execFileSync` + `pipe` → `EPERM`；`inherit`/`ignore` → 正常），于是它稳定报出
`UNCAUGHT × 3 + BASELINE-RED` 的**假红**。这份假红骗过了一位独立复审者。

**偏好写法**（仓库里有多处先例，头注写着同一条理由）：

- 判据的实现导出成**纯函数**，测试/变异脚本**直接 import 它吃文本或对象**，不起子进程
  （`tools/check-doc-paths.mjs` ← `test/doc-paths.test.mjs`、`tools/check-docs.mjs` ←
  `test/check-docs.test.mjs`、`verify/check-facts-anchors.mjs` 的 `analyzeFacts` ←
  `verify/mutate-facts-anchors.mjs`）；
- 确实要跑测试的变异，改成**两段式手术**（`patch` → 由人/外部命令跑测试 → `restore`），
  见 `verify/probe-late-recheck.mjs`；跑测试时**必须带** `--test-isolation=none`，
  否则 runner 会 spawn 子进程而 EPERM，那是环境不允许、不是判据生效。

**自查方法**：默认沙箱下直接跑一遍该判据，看红绿是否符合预期；凡出现 `status=null`、
`error.code === 'EPERM'`、`process.exitCode` 空转等形态，先怀疑权限而不是被测对象。

**逐个清出来的结果（19 个变异脚本）**：

| 类 | 脚本 | 默认权限下 |
| --- | --- | --- |
| 纯函数型，**不需要子进程**（只在内存里改写源码文本或喂合成读数给判据，不落盘、不 spawn） | `mutate-mutate-index.mjs`、`mutate-doc-paths.mjs`、`mutate-bare-filenames.mjs`、`mutate-facts-anchors.mjs`、`mutate-r24-ui.mjs`、`mutate-config-slot.mjs`、`mutate-lang.mjs`、`mutate-model-text.mjs`、`mutate-agent-policy.mjs`、`mutate-public-surface.mjs` | ✅ 直接跑。**十个逐个实跑过的读数**：2/2、2/2、1/1、4/4＋基线、**30/30**、7/7、12/12、11/11、11/11、8/8＋基线＋3 条假阳性守卫——全部退 0 |
| 会跑 `node --test` 测试文件 | `mutate-list-children-shape.mjs`、`mutate-card-theme.mjs`、`mutate-escalation-removed.mjs`、`mutate-escalation-order.mjs`、`mutate-yield-example.mjs`、`mutate-agent.mjs`、`mutate-steering.mjs`、`mutate-r27-form.mjs`、`mutate-alias-tokens.mjs` | ⚠️ 默认权限下**拒绝运行**：逐个实跑过，多数报 `BASELINE-RED`（`mutate-steering` 报 `BASELINE-DIDNT-RUN`，它显式认出了 spawn EPERM）、退出码 2，**没有一个谎报 CAUGHT**；要拿结论须**提权**跑 |

> ⚠️ **这些脚本不在测试套件里，会静默腐烂。** `npm run test:inproc` 够不到 `verify/`，
> 所以一条变异脚本可能在"锚点失配""文件搬走""被调函数换了签名"之后**照样躺在那里**，
> 而没人知道。**实测抓到过 4 处**：`mutate-doc-paths` 与 `mutate-facts-anchors` 在读一个
> 已经搬进本机平面的**事实登记簿**（每次跑都 ENOENT）；`mutate-mutate-index` 的锚点
> 钉在 README 表某一行的**散文**上，那句话改了措辞之后两条变异双双 SKIP；
> `mutate-facts-anchors` 还被"树参数改成可选"改哑了（四条变异全部逃逸）。
>
> **第一类（不需要子进程的十个）随时可以跑一遍**，改完东西顺手跑一次是便宜的：
>
> ```powershell
> node verify/mutate-mutate-index.mjs;   node verify/mutate-doc-paths.mjs
> node verify/mutate-bare-filenames.mjs; node verify/mutate-facts-anchors.mjs
> node verify/mutate-r24-ui.mjs;         node verify/mutate-config-slot.mjs
> node verify/mutate-lang.mjs;           node verify/mutate-model-text.mjs
> node verify/mutate-agent-policy.mjs;   node verify/mutate-public-surface.mjs
> ```
>
> 第二类那九个要提权才能拿结论（见下）。**它们不在 CI 里是有意的**：
> 默认权限下它们只会稳定报"跑不起来"，那种红不反映被测对象。

后一类的失败形态是安全的：先跑基线，捕不到子进程输出就拒绝运行（退出码 2），诊断文本已写明
"若括号里是空的、且以 2 退出，多半是 EPERM 而不是基线坏了"。**但它们的验证结论必须在提权下取得**，
引用这些结论时要写清"提权下测得"。

**为什么后一类没有一起进程内化**：不是"做不到"，而是**本轮没做**。可行做法确实存在——
Node 的 ESM 缓存按 resolved URL 键控，`import('…/被测源码.js?v=2')` 会另立一条模块记录
从而读到改动后的内容；或把被测模块加载进 `new Worker`（worker 自带独立模块注册表）。
未采用的取舍是：这两种做法都要改测试装载方式，而测试还依赖 `--import ./tools/_host-hooks.mjs`
的前置，兼容性需要先实验；在"结论已能在提权下取得"的前提下，本轮没有再动。
**若要彻底去掉这条提权依赖，就从这里入手。**

**`mutate-agent.mjs` 的判据口径**：目标是 `presets/dsh-async.patch.yml`，M2 锚点**按行首内容
定位、不依赖缩进**，校验器用默认目标；实跑 M1/M2 均 CAUGHT、还原一致（该脚本要跑测试文件，
属"需提权"一类，见上文）。

## 文件

| 文件 | 做什么 |
|---|---|
| `final-acceptance.mjs` | 把八条需求固化成一条可观察判据、一次跑完给总判定；证据落 `evidenceDir/final-acceptance.json`。**开跑前先把设置写回出厂默认值并读回核对**，写不进去就拒绝继续（假红比不跑更糟） |
| `async-e2e.mjs` | `async_run` 让出 → `async_wait_job` 取回 → 用户插话（steer）打断等待而作业不受影响 |
| `probe-queue-baseline.mjs` | 取证脚本（非判据）：记录 queue 消息在某实现下的实际行为，供"改前/改后"对照 |
| `probe-queue-delivery.mjs` | R12 真机判据：queue 消息**不**打断等待且等满预算、轮次结束后被投递（模型回应约定标记）、steer 仍打断且 **job_list 的工具结果行**显示作业 running（B3 只认 job_list 渲染行 `async-command-N [async-command] running`——旧判据可被让出句柄文案/模型自述满足） |
| `probe-agent-e2e.mjs` | R13/R14 真机判据：模型用 `async_agent` 派生（参数恰为 description+prompt）、立返 started+agent_id+可照抄的等待调用、`async_wait_agent` 有界等待以 `message-markers` 的 CHILD_SETTLED 收尾、子代理回答以**独立消息**出现、persona 四问固定格式定向断言（`FALSE_ALLOWED=no` 是 persona 独有的无条件禁止，宿主工具描述是条件允许；问答轮以 asOfSeq 水位线断言零 tool/call）、standard 预设四个 async 工具一个都没有。**开跑前把设置写回出厂默认值并读回核对** |
| `_rpc.mjs` | 活体验证实例的 RPC 通道（token→cookie→`/api/*` 信封），供上面的真机脚本复用。实例坐标经配置加载器读，本机平面缺席时打印 SKIP 后退出 |
| `probe-settings-behavior-full.mjs` | 改设置后**行为**真的变：等待上限两个方向都夹紧、输出截断、四个工具描述里的数字跟着变 |
| `probe-preset-portability.mjs` | 在**另一个预设 id** 下挂同样几行，四个工具照样出现（预设是模板，不是限制） |
| `probe-escalation-advertised.mjs` | R11：从真实 `request/header` 读回 `async_run` 的参数键，确认两个提权键**真的广告了**。**这是组合事实，替身证明不了** |
| `probe-sandbox-marker.mjs` | R11：让会话执行一条必然被沙箱拒绝的命令，**逐字读模型可见文本**，确认 `[exit code: N]` 与两行 `[sandbox: …]` 都到得了模型眼前 |
| `message-markers.mjs` | 判据用的文案标记，逐字取自 `lib/`。**单一来源**——各脚本各抄一份就会漂移 |
| `restore-async-settings.mjs` | `probe-settings-behavior-full` 被中止后的**独立还原出口** |
| `probe-session-state.mjs` | 工具（非判据）：问一次实例的 `session/list`，把每个会话的 `running` 与标题打出来。**动手重启实例前先跑它**——有 running 会话就别重启 |
| `mutate-*.mjs` | 每条能失败判据的变异证明。清单与各自跑的测试文件见 `README.md` 的表，由 `tools/check-mutate-index.mjs` 双向核对 |
| `_visual/cdp.mjs` | 无头浏览器驱动（CDP）：定位浏览器可执行文件、起独立用户目录、开页面、跑脚本、截图 |
| `_visual/probe-card-visual.mjs` | 设置表单的**视觉**判据：连真实浏览器。控件已与官方同源，判据改为**与官方设置页并排抽检**——值字段度量逐项比（高度/圆角/字号/内边距/边框/底色/文字色）、保存按钮几何比官方；结构判据：**四组全部字段**（`BUDGET` + `LANG` + `FLAG` + `ASK` 现读，现为 16 个）的 label `for` 绑定 + 说明行（aria-describedby 指向）+ 相邻字段分隔线 + 页脚单「保存」按钮；枚举 select 照官方下拉成例。每个主题出「顶部 + 底部」两张截图。允许的差异只有两项：官方没有的枚举控件、官方没有的秒数读数 |
| `_visual/probe-r24-bundle-config.mjs` | **R24/R27 的界面判据**：同一套无头浏览器走 插件 → 「查看本包」→ **本包插件页本身**。判据段：①放置（页面是插件页、设置区在插件页内、排在组件行**之前**、组件行里**没有** configure 控件）；②按**身份**断言"逐项等价"——每个控件的 `id` 去前缀必须与 `lib/config.js` 的 `BUDGET_FIELD_KEYS` + `LANG_FIELD_KEYS` + `FLAG_FIELD_KEYS` + `ASK_FIELD_KEYS` 一一对应（缺项/多项都点名）、16 项都可写、带秒数读数的字段集合恰好等于 `MS_FIELD_KEYS` 的 8 个毫秒字段；③**输入读数实时**（不保存、只键入 → 输入段当场变）；④保存往返（等待态 = 保存按钮从「保存中…」恢复，成功判据 = 字段回生效值 + 无页脚失败文案 + profile patch 出现该覆盖 + **生效段跟着变**）；⑤复原后覆盖消失、字段与两段读数回到默认 |
| `acceptance-017.mjs` | 阶段二端到端驱动的相位集合（`face` / `control` / `behavior` / `agent` / `settings` / `reload-control` / `dump` / `sibling-coexist` / `sandbox-control` / `r24-ui`） |
| `probe-r26-create-preset.mjs` | R26 第二预设（`dsh-async-create`）的真机三相位：`face`（选预设不回退、工具面在场/缺席、派生→有界等待→回答以 agent-message 独立到达、插话打断等待而子代理照跑、隔离对照 + 面差集）、`drill`（摘第三项重启后 create 被 `agent-preset/not-found` 拒、`dsh-async` 无恙）、`both`（复原后双预设都在） |
| `r17-uninstall.ps1` | **R17 卸载四段的装卸手术**（不含重启，重启在服务进程树外单独执行）：`-Action Status` 只读打印；`-Action Uninstall` 先备份 profile 的 `package.json`（写完用 node 校验 JSON，不合法即刻回滚）→ 摘掉包名（dependencies + bundles，并收干净悬空逗号）→ junction 改名让开；`-Action Restore` 从备份还原并改名回。**参数必填**，不设默认值 |
| `check-junctions.mjs` | **开发树 junction 重锚核验**：七条 junction——六条 `node_modules\@deepseek-ai`（cordis / dsh-jobs / dsh-sandbox / dsh-subagent / dsh-tools / schemastery）+ 顶层 `zod`——逐条必须在场、指向 0.2.0 线运行树、目标版本串符合线。**无跳过态**：缺席/错树/错版本都红；本机平面整个不在时整脚本打印 SKIP 退出。另有一段「树根唯一来源」对账：每个树消费者都必须引用配置加载器，不许自带树根常量 |
| `diff-trees.mjs` | **两棵安装树的包级差异对照器**：`node verify/diff-trees.mjs <pkg…>` 对每个包两树全文件递归字节对比（跳过包内 node_modules/.git），报告文件数、changed/added/removed 计数与代码文件逐文件清单。树根经配置加载器读 |
| `check-agent-policy.mjs` | **双源一致性检查器**：宿主 `dsh-tool-subagent` 与本包 `lib/agent-policy.js` 的模型面政策（默认策略串、宿主副本豁免类、stateVersion 形状）逐项对账，漂移即红。宿主锚经配置加载器从 0.2.0 线树派生，**读不到宿主源 → 硬错误（不是跳过）** |
| `mutate-agent-policy.mjs` | **`check-agent-policy` 的变异证明**（11 处变异——改常量 / 换库 / 删校验 / 改短路 / 宿主侧漂移 stateVersion、init）：进程内 import 纯函数，任何一处没红就报 UNCAUGHT 退 1；`BASELINE-GREEN` 先证未变异时恰绿 |
| `check-facts-anchors.mjs` | **事实依据可解析性**：本机平面的登记簿里每处 `包/文件:行号` 引用都要在对应安装树里找到文件且行号在范围内，并逐条核对四字段（现行值 / 依据 / 核销日期 / 更新入口）各恰好一处。**它不判语义**——行号在范围内不等于那行就是被引构造。三档树与登记簿位置都经配置加载器读；某一档树没配置时该档引用逐条记为 `TREE-ABSENT` 并在末尾汇总，**不计入硬错误**（缺配置不是"引用坏了"） |
| `probe-late-recheck.mjs` | **两段式反向验证**：证明 `test/jobs.test.mjs` 的「N2·防御路径」用例真的能红——它把 `lib/jobs.js` 里"无 await 的紧邻复查"整段挪进 `queueMicrotask`（`patch`），跑测试应当报 `AssertionError: 必须告诉模型现在就能取全部输出`，再 `restore` 复原。跑测试**必须带** `--test-isolation=none` |
| `diag-spawn-contexts.mjs` | **对照实验**（不是判据）：同一个"起子进程 + 捕获输出"的动作，在默认沙箱下的三种 stdio 形态各是什么结果——`pipe` → `EPERM`、`inherit`/`ignore` → 正常。它是「判据必须在默认权限下可跑」这条规范的证据 |
| `diag-headless-edge.mjs` | **无头浏览器存活诊断**：`frames` 子命令转储浏览器级/页面级 CDP WebSocket 原始帧，`lifetime` 子命令 spawn 两个 `--headless` 开关变体看存活时长与退出码。判定「受限沙箱档位下浏览器进程树早夭」，受影响探针须整探针一次性提权跑 |
| `r24-judgements.mjs` | **R24 界面判据的纯函数**（`stripComments` / `judgeDeliveredBytes` / `judgeSlotWiring` / `runRegistration` / `judgeConfigForm` / `judgePlacement` / `judgeReadoutFollows` / `judgeRoundTrip`）：判据本体与取数分离——判据由变异证明能红，取数在真机上取 |
| `lang-judgements.mjs` | **R25 双开关判据的纯函数**（`cjkCount` / `judgeLangIndependence` / `judgeLangRestored`）：判据由 `mutate-lang.mjs` 证明能红，取数由 `probe-lang-independence.mjs` 在真机上取 |
| `probe-lang-independence.mjs` | **R25 的真机判据**：先复位到 `auto`/`en`，再①只改 `agentLang`→`zh`（描述必须换中文、表单文案必须逐字不变）②只改 `uiLang`→`en`（走页面下拉 + 保存，表单文案必须换英文、字段身份不变、工具描述必须逐字不变）③复原并回读比对 |
| `mutate-lang.mjs` | **R25 判据的变异证明**（12 条：两档没换语言、中文档半译、英文档混中文、改 agentLang 顺带动界面文案、uiLang 没生效、字段身份被换、字段数不足、收尾没复原…），任一没红即 UNCAUGHT 退出 1 |
| `_r28-helpers.mjs` | **R28 真机判据的公共件**：锚句常量（与 `lib/text.js` 逐字一致，单一登记点）、固定格式问答测试集、会话驱动。c 段（系统提示纪律段）无转录通道，取证走**行为判据**——判别子是纪律段独有的退出码（不可猜），问题文本不得含锚句与该数（防问答泄漏）。`askBatteryConsistent` 是**在场断言**的自洽重采样；缺席断言单发不重抽 |
| `probe-r28-silent-failure.mjs` | **R28 的真机判据（真机 1–4、6）**：OFF 基线（三面缺席）→ 页面 Switch 翻转 + 保存 → ON 三面在场 → 签名 2 管道形双档 → 关回三面消失 → `agentLang=zh` 纪律段换中文。良性误发面只用内建 cmdlet（空目录 `Get-ChildItem 2>&1`）。收尾**故意留 guard=true** 给重启探针 |
| `probe-r28-restart-persistence.mjs` | **R28 真机 5（重启保持）**：不进批量清单——两条探针之间要人工过安全门并重启实例，等端口回来后本进程以**新 token** 起跑。判据：guard 仍 true（持久化非内存态）+ 三防线逐面复核，收尾复原 guard=false |
| `probe-r29-robustness.mjs` | **R29 的真机判据**（卡片/提交两层拒绝 + 等待总时长）：卡片层单字段越界 → 保存禁用 + 带上界数字的原因文案；卡片层配对（pollInterval > maxWait）；提交层 RPC 直写越界 → 落盘值照旧 + 服务错误日志增量含可读拒绝；等待总时长——长跑的进程内命令 + `async_wait_job` → running 且实际等待落在预算区间。结尾回正配置 |
| `probe-r30-ask-takeover.mjs` | **R30 的真机判据（提问接管）**，两相：主相（超时合成答案 → 迟到作答回流 → standard 对照零接管 → 座位形态 → 等待期间作答唤醒 → 语言四组合 → 通道与整批领取）；`--after-restart` 相（重启后设置持久化 + 接管行为复验 + 复原默认）。失败路径一律复原默认（安全可重跑） |
| `probe-r32-run-interruptible.mjs` | **R32/R33 的真机判据（执行即注册 + 可打断首次等待 + label=命令原文）**，五判据：审批落定后让出窗口内插话 → 秒回；GUI「停止生成」→ 秒回且作业存活；任务卡 label=命令原文、progress=描述、结算后 progress 清除（**断言落在卡片元素内**）；并发触顶 → 启动前拒绝 + 上限数字 + 出路；短命令预算内完成形状。两条硬纪律：时序锚取转录的审批落定事件（固定延时必落空）、任务卡判据走 GUI-first |
| `probe-r34-async-workflow.mjs` | **R34/R35 的真机判据（`async_workflow` 编排工具 + 预设手术）**，七判据：即时性·插话 / GUI 停止 / 任务卡 label 与 progress / 与 `async_run` 同池混编触顶 / 短编排零完成通知 / 双预设工具面 / 四类记录齐备。引擎相全部 GUI-first + GUI 升档（引擎的 PTC worker 按父会话现行档取沙箱） |
| `probe-r36-ask-pause.mjs` | **R36 的真机判据（待答面板会话级暂停/恢复）**，判据 8 项：开工清残留 → 组头暂停按钮在场（**本组内断言**）→ 点暂停后倒计时位冻结 → 停留超过窗口仍不放行 → 恢复后到期放行且距 ≈ 剩余 → 幂等二连点。窗口竞速教训：面板首绘时窗口已过大半，窗口要放宽才稳定 |
| `mutate-model-text.mjs` | **`tools/check-model-text.mjs` 硬编码文案层的变异证明**（11 条：合成源码喂 `scanProseLiterals` 纯函数——三元里的硬编码提示、未进表的模板串句子必须命中；logger/diag/stderr 行、标识符、定长标记、拼接碎片、注释不命中），任一没红即 UNCAUGHT 退出 1。进程内、默认权限可跑 |
| `mutate-r24-ui.mjs` | **R24 界面判据的变异证明**（30 条：下发字节退回行槽/挂官方槽/卡片类名缺失/取数失败、字段身份错位或不可写、秒数读数缺失或**挂在非毫秒字段上**、设置区不在插件页或排到组件行之后、**两段读数不跟快照/不跟键入/亚 10 ms 形状错**、字段没回生效值…），任一没红即 UNCAUGHT 退出 1。字段与毫秒字段清单直接 import `lib/config.js`（手抄会漂移） |
| `mutate-facts-anchors.mjs` | **依据检查器的变异证明**：行号越界 → `OUT-OF-RANGE`、引用不存在的文件 → `MISSING`、删掉某条目的依据 → `FIELDS …依据=0`、`[0.2.0]` 引用行号越界必须按 `[020]` 树标签报（前缀→树的映射可失败；另跑未变异基线须无**新增**错误，既有遗留单列不计）。**直接 import `analyzeFacts` 吃文本、不起子进程**——第一版用 `spawnSync` 捕获 stdout，在默认沙箱下会因管道被禁（EPERM）稳定报假红；一个只在提权下才成立的判据等于没有判据 |
| `check-ps1-bom.mjs`、`check-ps1-syntax.mjs`、`restore-ps1-bom.mjs` | 本目录下 `.ps1` 的 BOM 与语法体检（含还原出口）。按**前缀**跳过 `_scratch*` / `_tmp` / `_lab` / `backup` / `shots` / `logs`——前缀判据是必需的：精确相等会被改名绕过 |
| `agent-judgements.mjs` | 指定路由真机判据的纯函数部分（请求形状、拒绝文案、继承标记的判定），供 `acceptance-017.mjs` 的 `agent` 相与单测共用 |
| `_gates-r30.mjs` | R30 重启相开工前的**三道安全门**检查（该实例上没有运行中的会话、操作会话不在目标实例内、只动目标实例），通过才允许继续 |

## 归属：服务不在本目录里

本目录里的脚本**连**一台实例，但**不拥有**它：实例的令牌、服务日志、profile、部署脚本
都在那台实例自己的家目录里（坐标见本文开头那节）。判据是**归属**：

- **服务是基础设施，插件包是可交付物**。服务住在包内会让"重装插件包"连带破坏一个正在
  运行的服务。
- **开发源经目录联接直接充当已装包**，所以"包内"的范围等于整个工作目录——往本目录拷
  服务件同样违规。

写脚本前先问一句：**它属于基础设施还是交付物？**

## 本文件受检查器管辖

`verify/README.md` 与 `README.md` 同级受检：它是**现行文档**（承载"现在是什么"），
里面引用的仓内路径会被逐个核对存在性，历史叙述词按零容忍算。
