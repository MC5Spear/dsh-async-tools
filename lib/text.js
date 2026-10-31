/**
 * 模型侧文案的双语表与取值函数（需求 §5.3，设计 §5.2）。
 *
 * 表里只放**文案**；数字与条件分支留在原构建逻辑里，经 `t(lang, key, vars)`
 * 的 `{name}` 占位插值进入句子。
 *
 * 键集纪律：两档（`en` / `zh`）的键集必须**完全相等**——少一个键就是少一句提示，
 * `tools/check-model-text.mjs` 的静态层按这条判红。
 *
 * 操作者一侧（stderr 通告、logger、注释）**不进本表**：它维持中文，不属于
 * `agentLang` 的开关范围（需求 §5.3）。
 *
 * @module dsh-async-tools/text
 */

/** 支持的语言档（`agentLang` 的值域；`uiLang` 的 "auto" 不在此列）。 */
export const LANGS = ['en', 'zh'];

/**
 * 双语文案表。键用点分命名：
 * `tool.<名>.<段>` / `param.<名>.<参数>` / `note.<用例>` / `error.<用例>` /
 * `render.<标记>` / `digest.<段>` / `detail.<段>` / `verdict.<用例>` / `route.<用例>` /
 * `discipline.<段>`（静默失败 c 防线常驻纪律段，宿主侧 systemPrompt 注入用）。
 *
 * 占位符豁免：`{plural}` 仅 en 档需要（英文复数屈折，`render.workflowCompleted`/
 * `detail.workflowAgents` 两键）；zh 档无屈折、模板不含该占位符，调用方多传无害
 * （`t()` 只做模板替换）。其余键的占位符集合两档必须一致。
 */
export const TEXT = {
  en: {
    // ── 描述片段：digest（async_run 独有 yield；等待入口共用 wait） ──────────
    'digest.yield': 'The first wait defaults to {defaultYieldMs} ms (pass yield_ms, range {minYieldMs}–{maxYieldMs} ms);',
    'digest.wait': 'Per-call wait budgets must be passed explicitly, range {minWaitMs}–{maxWaitMs} ms;',

    // ── async_run 主描述 ─────────────────────────────────────────────
    'tool.run.p1': 'Run a PowerShell command with a first-wait budget. ',
    'tool.run.p2': 'If it finishes within the {defaultYieldMs} ms default first wait you get its output, like a normal command tool; if it outlives the first wait the command is NOT killed — it keeps running in the background and you immediately get a job id (job_id): continue other work; when the job settles, its result body is delivered directly — attached to an async_wait return you have in flight, or as a completion message (no extra retrieve call). During the first wait a user steering message ends only the wait, never the command — the same job id comes back right away; a stop of the turn also ends only the wait, but the host may replace the visible result with a cancellation error, so the job id may not reach you — recover it from job_list or the completion message. Difference from the built-in pwsh: the built-in foreground mode kills the process tree at the deadline; this tool only does a first wait. ',
    // b 防线警示段（需求 §6.3）：只在「有约束执行器 且 开关开」时拼到 async_run 描述尾部；
    // 前导 \n\n 自带（buildToolText 是空串 join，无前导空白会与前段粘连）。
    'tool.run.warnCapture': '\n\nCaution (this deployment): a command in capture form (2>&1, $(...), a variable assignment, or output redirection) can die silently at process creation under the restricted sandbox — nothing executes and the capture stays empty. Before concluding "no output", verify once with a bare call.',

    // ── async_agent 主描述 ────────────────────────────────────────────
    // p5 两套按当前后端 inheritsParentContext 取用（需求 §2.3.1：任务说明按后端
    // 是否继承上下文如实编写；设计 §5.2 两套文案随同一重算点切换）。
    'tool.agent.p1': 'Delegate a self-contained task to a NEW background subagent; returns immediately with its agent_id. ',
    'tool.agent.p2': 'Background-only by construction: there is no run_in_background parameter, it never waits and never polls. ',
    'tool.agent.p3': 'Delegates via the configured subagent provider (currently: {provider}). ',
    'tool.agent.p4': 'Optionally supply provider and model together to select the subagent\'s LLM route; the pair is checked against the CURRENT dsh model-selection settings at call time (route changes made between calls take effect on the next call). Omit both to use configured defaults or inherit the parent route. Call async_list_subagent_models to list or search available routes before choosing. ',
    'tool.agent.p5': 'The subagent does not see this conversation — pass a complete, self-contained prompt. ',
    'tool.agent.p5Inherit': 'This subagent backend inherits the parent conversation context (the subagent can read this dialogue); the task brief should still be self-contained and may refer to paths and conventions already established in this session. ',
    'tool.agent.p6': 'Wait for it with async_wait(targets=[{kind:"agent", id:...}], wait_ms=...): bounded; a user steer interrupts the wait while the subagent keeps running; its final answer arrives as its own message. ',

    // ── async_workflow（需求 §2.4；p1 的脚本契约与宿主 tool-workflow 的 DESCRIPTION
    //    同源——它是模型侧规格，两套措辞会漂移）───────────────────────────
    'tool.workflow.p1': 'Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification of findings — where you write the orchestration as a script instead of delegating turn by turn.\n\nThe workflow\'s identity rides the `meta` parameter as JSON: required `name` (short kebab-case) and `description` strings, optional `whenToUse` string and `phases` array (`{title, detail?, provider?, model?}`). The `script` parameter is the plain JavaScript body ONLY (NOT TypeScript, and NO `export const meta` statement — meta is a parameter, not code), running with top-level await; end with `return <value>` — the value must be JSON-serializable and is this tool\'s result.\n\nScript-body hooks:\n- `agent(prompt, opts?): Promise<any>` — run one subagent to completion. Without `opts.schema` it resolves to the child\'s final text; with `opts.schema` (an object-rooted JSON Schema using ONLY type/properties/required/additionalProperties/items/enum/const/oneOf — no pattern/format/numeric bounds) it resolves to the validated object. Resolves `null` when the child fails (filter with `.filter(Boolean)`). Other opts: `label` (display), `phase` (progress group), and independent `provider`/`model` LLM target overrides (either may be provided alone). Anything else (`effort`/`isolation`/`agentType`) is rejected loudly.\n- `pipeline(items, ...stages): Promise<any[]>` — run each item through the stages independently with NO barrier between stages (prefer this for multi-stage work). Each stage receives `(prev, item, index)`. An ordinary stage throw drops that ITEM to `null` and skips its remaining stages.\n- `parallel(thunks): Promise<any[]>` — run zero-argument functions concurrently and await ALL of them (a barrier; use only when a stage genuinely needs every prior result together). A throwing thunk resolves to `null`.\n- `phase(title)` — start a progress phase; `log(message)` — narrate progress; `args` — the tool call\'s `args` input, verbatim.\n\nMisused hooks (bad arguments, unknown options, unsupported schemas, tripped caps) throw errors that ALWAYS kill the script — they never dissolve into a per-item `null`.\n\nConstraints: concurrency and total-agent caps apply; no filesystem, network, timers, or Node.js APIs are provided — the agents do the work, the script only coordinates them. ',
    'tool.workflow.p2': 'Use this tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration; for one or two delegations prefer async_agent. The run is ALWAYS a background job — there is no run_in_background parameter. If it settles within the {defaultYieldMs} ms default first wait you get the full, truncatable result, like a foreground call; if it outlives the first wait the run is NOT cancelled — it keeps running in the background and you immediately get a job id (job_id): continue other work; when the run settles, its result body is delivered directly — attached to an async_wait return you have in flight, or as a completion message. During the first wait a user steering message ends only the wait, never the run — the same job id comes back right away; a stop of the turn also ends only the wait, but the host may replace the visible result with a cancellation error, so the job id may not reach you — recover it from job_list or the completion message. To actually cancel an orchestration, stop it with job_kill.',

    // ── 参数说明 ──────────────────────────────────────────────────────
    'param.run.command': 'The PowerShell command to execute.',
    'param.run.description': 'Clear, concise description of what this command does in active voice, 5-10 words.',
    'param.run.yield_ms': 'First wait in milliseconds ({minYieldMs}-{maxYieldMs}). Defaults to {defaultYieldMs}. On expiry the command moves to the background and a job id (job_id) is returned.',
    'param.run.workdir': 'Working directory. Defaults to the session working directory.',
    'param.run.sandbox_permissions': 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.',
    'param.run.justification': 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.',
    'param.agent.description': '3-5 word label for display.',
    // prompt 两套同 p5：继承上下文的后端如实说明可见性（需求 §2.3.1）。
    'param.agent.prompt': 'The complete, self-contained task for the subagent (it cannot see this conversation).',
    'param.agent.promptInherit': 'The task brief for the subagent. This backend inherits this conversation\'s context, so the brief may refer to paths and conventions already established here; keep it self-contained.',
    'param.agent.cwd': 'Initial working directory for the subagent. Relative paths resolve against your current effective directory; omitted, the subagent inherits it. Directory changes afterwards do not affect each other.',
    'param.agent.provider': 'LLM provider route for the subagent. Supply together with model; omit both to use backend route defaults, configured defaults, or inherit the parent route.',
    'param.agent.model': 'Exact model id under the provider. Supply together with provider; omit both to use backend route defaults, configured defaults, or inherit the parent route.',
    'param.agent.reasoning_effort': 'Reasoning effort for the effective child route. May be supplied alone; validated against the finally effective route.',
    'param.agent.agent_preset': 'Agent preset for this child. Omit to use the configured default or inherit the parent preset.',
    'param.agent.agentPresetChoices': ' Allowed presets: {choices}.',
    'param.workflow.script': 'The plain-JS workflow script body (top-level await allowed; NO `export const meta` statement; end with `return <json-value>`).',
    'param.workflow.meta': 'The workflow identity block (plain JSON — never code).',
    'param.workflow.meta.name': 'Short kebab-case workflow name.',
    'param.workflow.meta.description': 'One-line description of what the workflow does.',
    'param.workflow.meta.whenToUse': 'Optional guidance on when this workflow applies.',
    'param.workflow.meta.phases': 'Optional phase declarations matched by phase() calls.',
    'param.workflow.meta.phases.title': 'The phase title phase() calls match by exact string.',
    'param.workflow.meta.phases.detail': 'Optional one-line description of the phase.',
    'param.workflow.meta.phases.provider': 'Optional provider override this phase is expected to use.',
    'param.workflow.meta.phases.model': 'Optional model override this phase is expected to use.',
    'param.workflow.args': 'Optional JSON input exposed to the script as the `args` global (wrap a bare list as a field, e.g. {"files": [...]}).',
    'param.workflow.yield_ms': 'First wait in milliseconds ({minYieldMs}-{maxYieldMs}). Defaults to {defaultYieldMs}. On expiry the orchestration moves to the background and a job id (job_id) is returned.',

    // ── note / 句柄文案 ──────────────────────────────────────────────
    // 共享首次等待模板的主体称谓（设计 §2.5）：按路径取「命令」或「工作流／编排」，
    // 编排不得误称命令。{subject} 由 output.js 的 yieldNote 按 kind 注入。
    'subject.command': 'command',
    'subject.workflow': 'workflow',
    'note.yield.running': 'The {subject} is still running: it outlived the {yieldMs} ms first wait (about {elapsedMs} ms elapsed). It was NOT terminated.',
    'note.yield.keepWorking': 'Keep working on other things; do not idle-wait. When you need its output, call:',
    'note.yield.cap': 'Per-call wait cap is {maxWaitMs} ms; if it returns status:"running", call again — the {subject} is unaffected.',
    'note.yield.earlyByUser': 'The first wait ended early: a user message arrived (about {elapsedMs} ms in); the {subject} itself is unaffected.',
    'note.yield.budgetUnverified': 'The {subject} outlived the {yieldMs} ms first wait (about {elapsedMs} ms elapsed), but the follow-up check could not confirm its current state — the job list read failed or the job is no longer listed. It may have settled; use the handle below to re-check instead of assuming it is still running.',
    'note.yield.userUnverified': 'The first wait ended early: a user message arrived (about {elapsedMs} ms in); ending the wait did not stop the {subject}. The follow-up check could not confirm its current state — use the handle below to re-check instead of assuming it is still running.',
    'note.yield.unverified': 'The follow-up check could not confirm the {subject}\'s current state (the job list read failed or the job is no longer listed); it may have settled — use the handle below to re-check instead of assuming it is still running.',
    // 取消口径（需求 §2.1.2：取消与预算到期分别说明——被取消不等同于超出预算）。
    'note.yield.cancelled': 'The call was cancelled during the first wait (about {elapsedMs} ms of the {yieldMs} ms budget); the {subject} was not terminated by the cancellation.',
    'note.waitAgain': 'Waited {waitedMs} ms; the job is still running (unaffected). You can work on other things and call async_wait(targets=[{kind:"job", id:"{jobId}"}], wait_ms=...) later; per-call wait cap is {maxWaitMs} ms.',
    'note.agentWaitAgain': 'Waited {waitedMs} ms; the subagent has not changed yet (unaffected, still running). You can work on other things and call async_wait(targets=[{kind:"agent", id:"{agentId}"}], wait_ms=...) later; per-call wait cap is {maxWaitMs} ms.',
    // 到期/收敛后的复查读取失败（需求 §2.2.2：无法证实时不得宣称目标仍在运行）——
    // 与确认仍在运行的 waitAgain 分开；只陈述未证实并给重试出路。
    'note.recheckFailed': 'Waited {waitedMs} ms; the follow-up status check could not confirm this job\'s state (the job list read failed, or the job is no longer listed for this caller), so it is unverified — the job may have settled in the meantime. Call async_wait(targets=[{kind:"job", id:"{jobId}"}], wait_ms=...) again to re-check; per-call wait cap is {maxWaitMs} ms.',
    'note.agentRecheckFailed': 'Waited {waitedMs} ms; the follow-up status check could not observe the subagent, so its current state is unverified — it may have stopped running. Call async_wait(targets=[{kind:"agent", id:"{agentId}"}], wait_ms=...) again to re-check; per-call wait cap is {maxWaitMs} ms.',
    'note.interrupted': 'Wait interrupted: a user message has arrived and will appear in your next input (waited {waitedMs} ms). Ending the wait did not stop {subject}. Handle the user message first; to resume waiting later, call {resume} again.',
    'note.interruptedPreexisting': 'Wait not started: a user message had already arrived before this wait began and will appear in your next input. Ending the wait did not stop {subject}. Handle the user message first; to wait later, call {resume} again.',
    'note.cancelled': 'The wait was cancelled after {waitedMs} ms; the cancellation did not stop {subject}. To wait again later, call {resume}.',
    'note.cancelledPreexisting': 'The call was cancelled before the wait began; the cancellation did not stop {subject}. To wait again later, call {resume}.',
    'note.settled': 'Subagent {agentId} is no longer observed running. Its final answer will arrive as a separate message in the conversation; it is not part of this return value.',
    'note.agentStarted': 'Subagent delegated in the background. When you need its result, wait with async_wait(targets=[{kind:"agent", id:"{agentId}"}], wait_ms={defaultWaitMs}) (an example wait value; wait_ms is still required and errors when omitted); a user steer interrupts the wait while the subagent keeps running. Its final answer arrives as its own message in the conversation; list_agents shows progress at any time. ',
    // 静默失败防线（需求 §6.3）：签名 1 条件式 + 签名 2 直陈式，两键只在开关开时出。
    'note.silentCapture': 'Silent-failure guard: the command matched a capture form and settled with empty output under the restricted sandbox. If the output you expected is missing, the command may have been killed at process creation before anything ran — treat it as "did not run", not "ran with no output". Retry it once as a bare call to verify; to keep the capture form, retry the same command with sandbox_permissions.',
    'note.silentDenied': 'Silent-failure guard: the output matches the visible denial signature of this deployment\'s restricted sandbox. Retry the command once as a bare call to see the underlying error; to keep the original command as-is, retry it with sandbox_permissions.',

    // ── 路由回执（async_agent 的 note 末行；设计 §3.3 四档来源标注） ──────
    'route.requested': 'Child LLM route: {provider}/{model} (requested).',
    'route.configured': 'Child LLM route: {provider}/{model} (tool-configured default).',
    'route.backendDefault': 'Child LLM route: {provider}/{model} (backend route default).',
    'route.mixed': 'Child LLM route: provider {providerPart}; model {modelPart}.',
    'route.partMissing': 'no concrete value read',
    'route.source.configured': '(tool-configured default)',
    'route.source.backendDefault': '(backend route default)',
    'route.source.inherited': '(inherited from this agent)',
    'route.inherits': 'Child LLM route: inherits parent route.',
    'route.inherited': 'Child LLM route: {route} (inherited from this agent).',
    // 推理强度附注同款四档（显式请求 / 工具配置默认 / 后端默认 / 父继承）。
    'route.effortSuffix': ' (reasoning effort: {effort})',
    'route.effortConfigured': ' (reasoning effort: {effort}, tool-configured default)',
    'route.effortBackend': ' (reasoning effort: {effort}, backend default)',
    'route.effortInherited': ' (reasoning effort: {effort}, inherited)',

    // ── render 文本 ──────────────────────────────────────────────────
    'render.truncated': '[output truncated: {omitted} chars omitted]',
    // 编排结算渲染头（需求 §2.4/§2.2.3）：en 档与宿主 renderResult 同形；
    // 截断走 output.truncate 保首尾（标记在正文中），本键只承担头部说明。
    'render.workflowCompleted': 'workflow "{name}" completed ({count} agent{plural}).\nReturn value:\n',
    'render.exitCode': '[exit code: {code}]',
    'render.killedBySignal': '[killed by signal: {signal}]',
    'render.spillDisk': "[some output exceeded the shell's in-memory limit; the full output is on disk — {paths}]",
    'render.spillNone': "[some output exceeded the shell's in-memory limit and was dropped; no spill file was reported, so re-run the command with output redirected to a file if you need it]",
    'render.lossyPrefix': '[earlier output was partially dropped from memory]',
    'render.spillPaths': '[the host reports spill files for this job (bytes dropped from the memory buffer may be recoverable there): {paths}]',
    // 终态状态行（需求 §2.2.2：终态在模型可见文本中区分 completed/failed/killed，
    // 不依赖可选详情；状态提示不占 maxResultChars 内容预算）。
    'render.jobStatus.completed': '[job completed]',
    'render.jobStatus.failed': '[job failed]',
    'render.jobStatus.killed': '[job killed]',
    'render.readFailed': '[reading the job output failed; the output below is empty — call async_wait(targets=[{kind:"job", id:"..."}], wait_ms=...) again to retry]',
    'render.agentStarted': 'async_agent started.\nagent_id="{agentId}"\n',
    'render.notFound': 'unknown subagent "{agentId}". Known children:\n{children}',

    // ── 作业结局 detail ───────────────────────────────────────────────
    'detail.exitCode': 'exit code: {code}',
    'detail.signal': 'signal: {signal}',
    'detail.lossy': 'output partially dropped from memory',
    'detail.lossyNone': '; no spill file reported',
    'detail.lossyAt': '; full output at {paths}',
    'detail.userArrivedFinished': '(a user message arrived during the wait; the job finished in the meantime)',
    // 编排完成支的作业 detail（随完成快照进入交付读取的终态文本）。
    'detail.workflowAgents': '{count} agent{plural}',

    // ── 子代理状态判定说明 ────────────────────────────────────────────
    'verdict.goneFromList': 'This subagent is no longer in the subagent list (it is no longer observed running).',
    'verdict.notRunning': 'The subagent list no longer reads this subagent as running ({activity}); it is no longer observed running.',
    'via.idle': 'The subagent finished its current work (status turned idle).',
    'via.recheck': 'The subagent made progress and is currently no longer in a running state.',
    'via.notice': 'A settlement notice for this subagent was received.',
    'via.noticePreexisting': 'A settlement notice for this subagent had already arrived before the wait started.',
    'via.textFallback': 'A settlement notice matched this subagent by message text and a follow-up check confirmed it is no longer running.',
    'list.diagnostic': '{id} (diagnostic: {reason})',
    'note.agent.interruptedDuringSettle': ' (a user message arrived during the wait)',

    // ── 抛给模型的错误 ────────────────────────────────────────────────
    'error.escalationUnavailable': 'sandbox_permissions is not available in this composition (no sandboxing executor to escalate)',
    // 非严格加宽的启动前拒绝（需求 §6.1）：宿主助手对同级免审批放行，本包口径更严——
    // 同级／更窄／不支持的目标都在进程启动前可读拒绝、零注册零启动。
    'error.escalationSameLevel': 'sandbox_permissions "{mode}" equals this call\'s current sandbox mode, so it is not a widening request; drop the escalation fields and run the command as-is, or request a strictly wider mode.',
    'error.escalationNotWider': 'sandbox_permissions "{requested}" is not strictly wider than this call\'s current "{effective}" mode; choose a strictly wider mode or run without escalation.',
    'error.sandboxPolicyMissing': 'async-tools: the mounted shell executor confines but ctx.sandboxPolicy is missing',
    'error.startRefused': 'async-tools: the command was refused before the process launched — nothing is running{limitNote}: {detail} {aliveNote} Use job_kill to stop an unneeded job, or wait for it to finish, then retry.',
    'error.startRefusedPlain': 'async-tools: the command was refused before the process launched — nothing is running: {detail} This is not a capacity limit; stopping other jobs will not help.',
    // 显式 workdir 的 shell 准备失败诊断（设计 §3.1）：真实原错由调用处以原文
    // 独立拼接（不进占位模板；killed 触发形态的原错已在输出中，不再拼接）；
    // 核实结论四态键见下。
    'error.workdirPrep': 'async-tools: the command process could not start. Requested workdir: {requested}; resolved path: {resolved}; session working directory: {cwd}. {verdict} {action}',
    'error.workdirPrepMissing': 'The resolved directory does not exist.',
    'error.workdirPrepExists': 'The resolved directory exists, so the failure has another cause — check the command and how it launches.',
    'error.workdirPrepNotDirectory': 'The resolved path exists but is not a directory — workdir must point to a directory.',
    'error.workdirPrepUnverified': 'Could not verify whether the resolved directory exists.',
    'error.workdirPrepAction': 'Correct workdir and retry, or check the target directory first.',
    'error.noAgentRun': 'async-tools: async_run must be called from a model turn — it registers the command as an owned background job whose completion notice is the recovery channel, and there is no agent context here. For a one-off synchronous command, use a session whose preset provides a synchronous shell.',
    'error.noAgentWorkflow': 'async-tools: async_workflow must be called from a model turn — it registers the orchestration as an owned background job whose completion notice is the recovery channel, and there is no agent context here. For a one-off orchestration, use a session whose preset provides the native workflow entry.',
    'error.workflowEngineMissing': 'async-tools: the workflowEngine service is not available in this composition — load a workflow engine provider (e.g. @deepseek-ai/dsh-workflow-ptc) inside the delegation group.',
    'error.workflowEmptyName': 'async-tools: meta.name must be a non-empty string — it becomes the job label shown in job listings (short kebab-case is customary)',
    'error.currentLimit': ' (current limit: {limit})',
    'error.noLiveJobs': 'No other live jobs were found.',
    'error.liveJobs': 'Live jobs: {jobs}.',
    'error.unknownJob': 'unknown job "{jobId}"; call job_list to see live job ids',
    'error.queryFailed': 'async-tools: reading the job list failed (the job may still exist); retry async_wait later — this is not "unknown job"',
    'error.unknownAgent': 'unknown subagent "{agentId}"; it is not a child of this session. Known children:\n{children}',
    'error.waitMsInvalid': 'wait_ms must be a finite number >= 0',
    'error.targetsInvalid': 'targets must be an array of { kind, id } objects',
    'error.targetKindInvalid': 'each target kind must be "job" or "agent"',
    'error.targetIdInvalid': 'each target id must be a non-empty string',
    'error.noAgentContext': 'async_wait requires an agent context (session) to wait in',
    // 行装载配置解析的拒绝（抛错通道无语言上下文，线上形态取英文档；词典
    // 两语成对供诊断与核对，设计 §5.1 空数组与原生同形拒绝）。
    'error.config.allowedPresetsEmpty': 'allowedAgentPresets must contain at least one preset id when present; an explicit empty array is invalid',
    // wait_ms 缺省的必填参数错误（经 execute 抛给模型，需求 §2.1.1/§5.3 双语）。
    'error.waitRequired': 'wait_ms is required and bounded: pass an explicit budget between {minWaitMs} and {maxWaitMs} ms',
    'error.listingUnavailable': 'subagent listing unavailable; cannot observe subagent state',
    'error.requiresAgent': 'async_agent requires an initiator agent; this tool must run inside an agent-driven session',
    'error.unsupportedArgs': 'async_agent got unsupported argument(s): {keys} — supported: {supported}; for other delegation options, follow the host rules and use a new session whose preset provides them',
    'error.pairTogether': 'child LLM `provider` and `model` must be supplied together',
    'error.providerNonEmpty': 'child LLM `provider` must be non-empty',
    'error.modelNonEmpty': 'child LLM `model` must be non-empty',
    'error.effortNonEmpty': 'child LLM `reasoning_effort` must be non-empty',
    // 以下四类拒绝都可用更换路由或重试解决（设计 §3.3）：保留真实原因，指引查询并
    // 保留目标工具条件（target_tool="async_agent"），不指路其他创建工具。
    // 启动前重读（步 12）三分各用一档：读取失败带原错给重试出路（routeRecheckReadFailed）、
    // 开关关闭复用 selectionDisabled、名单撤销才用撤销口径（routeRecheckFailed）。
    'error.routeNotAllowed': 'child LLM route "{provider}/{model}" is not allowed by the current model-selection settings; call async_list_subagent_models (target_tool="async_agent", optionally with query="{provider}") to list or search the allowed routes',
    'error.selectionDisabled': 'explicit child model selection is currently disabled in the dsh model-selection settings; omit provider, model, and reasoning_effort to use configured defaults or inherit the parent route',
    'error.policyUnavailable': 'explicit child model selection cannot be checked here: the host composition does not provide the subagentModelSelection service',
    'error.policyReadFailed': 'the model-selection settings could not be read: {reason}',
    'error.routeRecheckReadFailed': 're-reading the model-selection settings right before the start failed: {reason}; no subagent was started — retry the call, or re-check the current routes with async_list_subagent_models (target_tool="async_agent")',
    'error.routeRecheckFailed': 'the allowed list re-read immediately before the start no longer contains the selected route; no subagent was started — re-check the current routes with async_list_subagent_models (target_tool="async_agent") and call again',
    // 预检拒绝（llm.resolveCallConfig 报模型或推理强度不受支持）：{reason} 是按
    // 需求 §6.2 口径单行化并截断的宿主原文，完整原因进操作者日志。
    'error.preflightRejected': 'the selected child LLM route was rejected before creation: {reason}; call async_list_subagent_models (target_tool="async_agent") to list or search available routes',
    'error.presetNotConfigured': 'agent_preset selection is not configured for this tool row (no allowed preset set); omit agent_preset to inherit the parent preset',
    'error.presetNotAllowed': 'agent_preset must be one of: {choices}',
    'error.presetNoBackend': 'subagent provider "{provider}" does not support independent agent preset selection',
    'error.noEffectiveRoute': 'cannot select child LLM values without an effective provider and model',
    'error.llmUnavailable': 'cannot resolve the selected child LLM route because the llm service is unavailable in this composition',
    'error.providerChanged': 'subagent provider "{provider}" changed while resolving the child LLM route; no subagent was started — call again',
    'error.providerNotRegistered': 'subagent provider "{provider}" is not registered — check the async-tools setting \'subagentProvider\' (the default is "spawn")',
    'error.noContinuable': 'subagent provider "{provider}" does not support background delegation (missing prepareContinuable)',
    'error.noAgentOptions': 'subagent provider "{provider}" does not honor agentOptions — the requested route would be silently ignored',

    // ── 路由查询工具 async_list_subagent_models（需求 §2.3.4，设计 §3.7） ──
    'tool.list.p1': 'Read-only catalog of the LLM providers/models usable for subagents, with paging and search. It creates no agent, sends no model request, and changes no route or setting. ',
    'tool.list.p2': 'Omit provider and query to page through providers; pass provider to page its models; pass query (case-insensitive, matches ids and display names) to search across providers or within one; pass provider and model together for that exact model and its reasoning efforts. ',
    'tool.list.p3': 'target_tool scopes the applicability verdict and the example arguments to one subagent-creation tool; the verdict distinguishes "allowed", "not allowed", and "unconfirmed" and always states its basis. ',
    'tool.list.p4': 'Pagination: page_size defaults to 20 (1-100); page > 1 also passes the version token returned with the previous page; a stale version means policy or catalog changed — re-query from page 1. ',
    'param.list.provider': 'Provider id. Omit to list providers (or to search across providers together with query).',
    'param.list.model': 'Exact model id for the model-detail view. Requires provider.',
    'param.list.query': 'Search term, matched case-insensitively against provider/model ids and display names; whitespace-only counts as absent.',
    'param.list.target_tool': 'Name of the subagent-creation tool the applicability verdict is scoped to (async_agent or a host tool name, including user-configured ones). Omitted: the single recognized creation tool is used; with several or none, applicability is reported unconfirmed. A named tool that is not visible reports "not allowed" with the reason, and the catalog is still returned.',
    'param.list.page': '1-based page number. Page > 1 requires the version token from the previous response.',
    'param.list.page_size': 'Entries per page, default 20, range 1-100.',
    'param.list.version': 'Version token from the previous response, required for page > 1; a mismatch rejects stitching and asks for a fresh query.',
    // 参数示例的占位串（exampleArguments 生成；efforts 为逗号连接的强度 id）。
    'param.list.exampleDescription': '<3-5 word label>',
    'param.list.examplePrompt': '<complete self-contained task>',
    'param.list.exampleEffort': '<one of: {efforts}>',
    'list.verdict.allowed': 'explicit route selection allowed',
    'list.verdict.notAllowed': 'NOT allowed',
    'list.verdict.unconfirmed': 'unconfirmed',
    'list.basis.asyncCurrent': 'current dsh model-selection settings: enabled, {count} allowed route(s)',
    'list.basis.asyncDisabled': 'model selection is disabled in the current dsh model-selection settings; explicit provider/model/reasoning_effort would be rejected (configured defaults and parent inheritance still work)',
    'list.basis.asyncReadFailed': 'the model-selection settings could not be read: {reason}',
    'list.basis.asyncNoService': 'the subagentModelSelection service is absent in this composition',
    'list.basis.noRouteParams': 'this tool does not expose route-selection parameters in this session',
    'list.basis.nativeProjection': 'session model-selection projection: {count} route(s) recorded when the session was composed',
    'list.basis.nativeNoProjection': 'no model-selection policy recorded for this session (the projection reads empty); the target most likely composes without model-selection settings',
    'list.basis.nativeProjectionFailed': 'the session model-selection projection could not be read: {reason}',
    'list.basis.nativeNoAgent': 'no calling agent to read the session projection',
    'list.basis.nativeAssembleFailed': 'the caller-scope prompt assembly could not be read to prove the target identity: {reason}',
    'list.basis.nativeSectionEmpty': 'the caller-scope prompt assembly has no non-empty "tool:<name>" section for this target, so the visible definition is not proven to be the natively registered one (not loaded, renamed by row config, or shadowed by a same-name registration)',
    'list.basis.multiCandidates': 'several creation tools are visible ({candidates}); pass target_tool to scope the verdict',
    'list.basis.noneCandidates': 'no subagent-creation tool is visible in this session',
    'list.basis.targetNotVisible': 'target_tool "{tool}" is not a subagent-creation tool visible in this session (visible: {candidates}); the catalog is returned without a confirmed target',
    'list.basis.asyncNoRegistry': 'the subagents service is unavailable in this composition, so the subagent backend cannot be confirmed',
    'list.basis.asyncForeignName': 'the visible "async_agent" definition is not registered by this package (same-name registration, shadowing, or registration in another module instance), so its identity, parameters, and configuration cannot be confirmed',
    'list.basis.asyncIdentityUnreadable': 'the visible tool definition could not be read to prove this package registered it: {reason}',
    'list.basis.asyncBackendFailed': 'the subagent provider registry could not be read: {reason}',
    'list.basis.asyncBackendMissing': 'the configured subagent provider "{provider}" is not registered, so explicit route selection would be rejected at execution',
    'list.basis.asyncBackendNoOptions': 'the configured subagent provider "{provider}" does not support child model selection (no agentOptions capability), so explicit route selection would be rejected at execution',
    'list.basis.asyncBackendNotContinuable': 'the configured subagent provider "{provider}" provides no continuable support (no prepareContinuable), so explicit route selection would be rejected at execution',
    'list.basis.asyncBackendNoPreset': 'the creation row defaults to an agent preset, but the configured subagent provider "{provider}" does not support standalone presets, so creation would be rejected before any subagent is spawned',
    'list.basis.routeNotAllowed': 'the route {provider}/{model} is not in the confirmed allowed set for this target',
    'render.list.providersHeader': 'Subagent LLM providers (page {page}, {total} total{partialNote}):',
    'render.list.modelsHeader': 'Models of {provider} (page {page}, {total} total{partialNote}):',
    'render.list.searchHeader': 'Routes matching "{query}" (page {page}, {total} total{partialNote}):',
    'render.list.detailHeader': 'Model {provider}/{model}:',
    'render.list.providerLine': '{provider} — {name}',
    'render.list.modelLine': '{provider}/{model} — {name}',
    // 供应商浏览的数量段（需求 §2.3.4：确认目标策略后标允许模型数，未确认标目录已知数）。
    'render.list.countAllowed': '{count} allowed model(s)',
    'render.list.countCatalog': '{count} model(s) in catalog',
    'render.list.countUnknown': 'model count unavailable (listing failed)',
    'render.list.unlistedProvider': '(provider "{provider}" is not in the current catalog; it has no listed models here)',
    'render.list.unlistedProviderAllowed': '(provider "{provider}" is not in the current catalog; the entries below come from the confirmed allow list)',
    'render.list.unlistedProviderNoMatch': '(provider "{provider}" is not in the current catalog; its allow-list routes are present but none match "{query}")',
    'render.list.allowedListMark': ' (allow-list route)',
    'render.list.notInAllowList': ' (not in the allow list)',
    'render.list.readFailed': '(listing failed for: {failed}; this is a read failure, not an empty catalog — retry the same query, or query one provider at a time)',
    'render.list.emptyProviders': '(no LLM providers registered)',
    'render.list.emptyModels': '(no advertised models for {provider})',
    'render.list.noMatches': '(no matches for "{query}")',
    'render.list.effortsHeader': 'Reasoning efforts:',
    'render.list.effortLine': '{id}{defaultMark} — {name}',
    'render.list.defaultEffort': ' (default)',
    'render.list.noEfforts': '(no advertised reasoning efforts)',
    'render.list.pageFooter': ' | page {page} of {lastPage}, {total} entries total{partialNote}{nextHint}',
    'render.list.nextHint': ' | next page: continue with {next}',
    'render.list.beyondEnd': 'Page {page} is beyond the last page ({lastPage}); nothing to show here. {total} entries match the current filters — start a new query to continue.',
    'render.list.applicability': '\nTarget {target}: {verdict} — {basis}.',
    'render.list.example': ' Example arguments for {target}: {example}',
    'render.list.partialNote': ' — incomplete: {failed} provider listing(s) failed',
    'error.list.llmUnavailable': 'async_list_subagent_models: the llm service is unavailable in this composition — the catalog cannot be read; nothing was queried or changed',
    'error.list.modelNeedsProvider': 'async_list_subagent_models: model requires provider',
    'error.list.providerEmpty': 'async_list_subagent_models: provider must be non-empty',
    'error.list.modelEmpty': 'async_list_subagent_models: model must be non-empty',
    'error.list.pageSize': 'async_list_subagent_models: page_size must be an integer between 1 and 100 (default 20)',
    'error.list.page': 'async_list_subagent_models: page must be a positive integer',
    'error.list.versionRequired': 'async_list_subagent_models: page {page} requires the version token returned with the previous page; re-query from page 1 with the current filters',
    'error.list.versionStale': 'async_list_subagent_models: the result version changed since the previous page (policy or catalog updated); the pages cannot be stitched — re-query from page 1 with the same filters',
    'error.list.queryDetailConflict': 'async_list_subagent_models: a non-empty query cannot be combined with an exact model detail lookup (provider+model); drop the query, or drop provider+model to search',
    'error.list.targetEmpty': 'async_list_subagent_models: target_tool must be a non-empty string',
    'error.list.providersFailed': 'async_list_subagent_models: reading the provider list failed: {reason}',
    'list.reason.systemPromptUnavailable': 'the systemPrompt service is unavailable in this composition',
    'list.reason.toolsGetUnavailable': 'the tools service exposes no get(name, scope) in this composition',
    'list.reason.schemasGetMismatch': 'visible in schemas but tools.get returned none',
    'error.list.detailUnsupported': 'async_list_subagent_models: the model directory reports model {provider}/{model} as nonexistent or unsupported',
    'error.list.detailFailed': 'async_list_subagent_models: reading the details of model {provider}/{model} failed: {reason}',

    // ── c 防线常驻纪律段（需求 §6.3，宿主侧 systemPrompt 注入） ───────────
    'discipline.block': 'Execution discipline for this deployment (pwsh under a restricted sandbox):\n1. Captured commands can die silently. A command in capture form (2>&1, $(...), a variable assignment, or output redirection >) can be killed at process creation under the restricted sandbox: nothing executes and the capture stays empty. Telltale signs: empty output, no [exit code] marker, $LASTEXITCODE unset. If output you expected is missing, treat that as "the command did not run", never as "it ran and printed nothing". When in doubt, run it once as a bare call (bare calls are reliable); to keep the capture form, retry the same command with sandbox_permissions.\n2. Some deployments run a local antivirus rule that kills hidden PowerShell launches at process creation (it matches a standalone -W/-w switch or -WindowStyle Hidden in the command line). That exact pattern — exit code 4294967295 with no other output — means the whole pwsh died before any statement ran; elevation does not help. Rewrite the command instead (-Width, or pass the value through a variable).',

    // ── 预设执行纪律段（需求 §5.3/§9.1 ASK-01，宿主半边注册的 systemPrompt
    // section 运行时注入；agentLang 管语言档、按目标会话实际预设选变体，设计
    // §3.6）。en 档为两份预设原 persona 前缀里身份句之后的纪律原文（逐字不
    // 重写）；zh 档为等义译文。两变体差异：dsh-async 档含前台委托禁句，
    // create 档为宿主创建入口已禁用、不要调用。
    'discipline.preset.dsh-async': 'This deployment runs commands ASYNCHRONOUSLY. `async_run` returns a job_id instead of blocking when a command outlives its yield budget: when that happens, keep working on other things — when the job settles, its result body is delivered directly (attached to an in-flight async_wait return, or as a completion message); do not wait idly or re-run the command. When you need a background subagent\'s outcome, use async_wait (bounded, interruptible) rather than polling. Never treat a returned job_id as a failure.\nDELEGATION RULES (hard rules, not advice):\n1) Delegations are ALWAYS background. async_agent is the ONLY delegation entry in this preset (it has no foreground mode); the host subagent / subagent_fork tools are disabled here. A foreground delegation blocks the entire tool batch — never pass run_in_background: false.\n2) When you need a subagent\'s result, wait with async_wait(targets=[{kind:"agent", id:"..."}], wait_ms=...) (bounded). Do not poll in a loop; do not re-delegate just to check progress; the final answer arrives as its own message.\nASKING RULES (hard rules, not advice):\n1) Questions and their options use no personal pronouns for the actor, authorizer, or owner; use explicit, distinguishable role names instead.\n2) An option that involves a role spells out the role plus the action.\n3) After a selection, keep role references consistent with the chosen role name.',
    'discipline.preset.dsh-async-create': 'This deployment runs commands ASYNCHRONOUSLY. `async_run` returns a job_id instead of blocking when a command outlives its yield budget: when that happens, keep working on other things — when the job settles, its result body is delivered directly (attached to an in-flight async_wait return, or as a completion message); do not wait idly or re-run the command. When you need a background subagent\'s outcome, use async_wait (bounded, interruptible) rather than polling. Never treat a returned job_id as a failure.\nDELEGATION RULES (hard rules, not advice):\n1) Delegations are ALWAYS background. async_agent is the ONLY delegation entry in this preset — it has no foreground mode. subagent / subagent_fork are disabled here; do not call them.\n2) When you need a subagent\'s result, wait with async_wait(targets=[{kind:"agent", id:"..."}], wait_ms=...) (bounded). Do not poll in a loop; do not re-delegate just to check progress; the final answer arrives as its own message.\nASKING RULES (hard rules, not advice):\n1) Questions and their options use no personal pronouns for the actor, authorizer, or owner; use explicit, distinguishable role names instead.\n2) An option that involves a role spells out the role plus the action.\n3) After a selection, keep role references consistent with the chosen role name.',

    // ── 提问接管（需求 §4.1/§4.4：超时合成与迟到注入的模型侧文案） ─────
    // 迟到注入是通知形（followup + 自声明 kind）：正文自含完整题目内容（用户决定）——压缩或长对话后模型不依赖对原工具调用的记忆即可行动。
    'ask.timeoutCustom': 'The user has not answered within {seconds} s: proceed with your best judgment. If the user answers later, the answer arrives as a notice (timed-out records are swept lazily when a later question batch takes over, and only records past their timeout by more than 24 hours; until then a late answer is still possible).',
    'ask.windowSkip': 'The user chose to skip this question while the pending window was open.',
    'ask.lateAnswer': '[Late answer] The user answered the pending question after the timeout.\nQuestion id: {qid}\nQuestion: {question}\nOptions (multiSelect={multiSelect}): {options}\nAnswer: {answer}\nDelay: {delay} s after the question was asked.',
    'ask.lateIgnore': '[Late answer] The user chose not to answer the pending question after the timeout.\nQuestion id: {qid}\nQuestion: {question}\nOptions (multiSelect={multiSelect}): {options}\nDecision: not answered\nDelay: {delay} s after the question was asked.',
    'ask.lateSummary': 'Late answer for {qid}: {answer}',
    'ask.lateIgnoreSummary': 'Late skip for {qid}',
    'ask.lateCustomAnswer': 'custom answer: {custom}',
    // 作答拒绝（需求 §4.2.4：非法作答可见拒绝）——RPC 错误回执的原因文案。
    'ask.answerRejectedError': '[async-tools] answer rejected: {reason}',
    'ask.rejectUnknownOption': 'the selected options are not offered by this question',
    'ask.rejectSingleMultiple': 'a single-select question accepts at most one option',
    'ask.rejectBlankCustom': 'the custom answer is selected but its text is blank',
    'ask.rejectSingleBoth': 'a single-select question accepts either an option or a custom answer, not both',
    'ask.rejectNothing': 'nothing selected: choose an option or provide a custom answer',
    'wait.lateArrived': 'A late answer has arrived ({summary}); the notice will enter your context at the next claim point. This wait did not stop the target.',
    'wait.wokeByMessage': 'A processable message arrived ({summary}); it will enter your context at the next claim point. This wait did not stop the target.',
    'wait.targetMessage': 'A message from target subagent ({summary}); it will enter your context at the next claim point.',
    'wait.agentResumed': 'Subagent {agentId}, previously confirmed stopped, is running again.',
    'wait.readyWoke': 'Job results became deliverable; see the delivered entries below.',
    'wait.budgetTargets': 'The wait budget expired with no target condition met; targets and any deliverable entries are attached. Call again to keep waiting.',
    'wait.budgetNoTargets': 'The wait budget expired with no processable message. Call again to keep waiting.',
    'wait.zeroWaitTargets': 'Zero-wait check only: no target condition met yet. Targets and any current increments are attached.',
    'wait.alreadyDelivered': 'Job {jobId} already finished and its result was delivered earlier (in a previous wait return, or in a completion message — possibly one arriving in this same input); the result does not repeat. Output above is empty for that reason, not because the job produced nothing.',
    'delivery.spillOverflow': '({count} more spill paths omitted; batch note budget reached)',
    'wait.zeroWaitNoTargets': 'Zero-wait check only: no processable message at this moment.',

    // ── async_wait 主描述 ────────────────────────────────────────────
    'tool.wait.p1': 'Wait with one bounded budget. With no targets, the wait ends when any processable message addressed to you arrives, or when a background job result becomes deliverable (the result body is attached to the return — no extra retrieve call). ',
    'tool.wait.p2': 'With targets, the wait ends when any target job reaches a terminal state (its output is attached), when a target subagent produces a change notice, or when a user steering message arrives; non-target notices do NOT end the wait. Waiting for a subagent means waiting for its changes — its final answer still arrives as its own message. ',
    'tool.wait.p3': 'While waiting, a **steering** user message (delivered into your very next input) returns status:"interrupted" immediately — background work is unaffected and keeps running; a **queued** message (delivered only after this turn ends) does not interrupt the wait. ',
    'tool.wait.p4': 'wait_ms=0 performs a single immediate check with no waiting. When the budget expires you get the current state of every target; call again to keep waiting. ',

    // ── async_wait 参数说明 ──────────────────────────────────────────
    'param.wait.wait_ms': 'Required per-call wait budget in milliseconds ({minWaitMs}-{maxWaitMs}); 0 means an immediate check without waiting.',
    'param.wait.targets': 'Optional wait targets; omit (or pass []) to wait for any processable message or deliverable job result.',
    'param.wait.targets.kind': '"job" or "agent".',
    'param.wait.targets.id': 'A job id (from async_run / async_workflow / job_list) or a subagent id (list_agents shows ids).',

    // ── 交付账本文案（完成消息与批次说明）─────────────────────────────
    'delivery.deferred': '{count} more result entry/entries deferred by the batch budget; call async_wait(targets=[...], wait_ms=0) to collect them.',
    'delivery.readFailed': '[read failed] The final output of job {jobId} could not be read from the registry right now; this is not an empty result. Retry async_wait(targets=[{kind:"job", id:"{jobId}"}], wait_ms=...) to fetch it.',
    'delivery.deferredNotice': 'Job {jobId} settled; its result did not fit the current delivery batch. Call async_wait(targets=[{kind:"job", id:"{jobId}"}], wait_ms=0) to fetch it now.',
    'error.foreignJob': 'Job {jobId} belongs to another session and cannot be waited on from here.',
    'delivery.completionItem': 'Background job {jobId} settled: {status} ({chars} chars).',
    // 运行中增量条目（零等待 includeRunning，设计 §3.2.3）：与终态状态行分键，
    // 不沿用 settled 前缀——「settled: running」读作自相矛盾（真机首测偏差）。
    'delivery.completionItemRunning': 'Background job {jobId} is still running; current increment ({chars} chars).',
    'delivery.completionSummary': 'async job result × {count}',
    'delivery.lossy': '[earlier output was dropped by the buffer limit]',
    // lossy 找回说明（需求 9.3.2「提供现有完整输出位置或继续取得尚未交付内容
    // 的可执行方式；没有可用副本时如实说明缺失范围」）：两态由 paths 有无选择。
    'delivery.lossyAtPaths': '[earlier output was dropped by the buffer limit; full output retained at: {paths}]',
    'delivery.lossyUnrecoverable': '[earlier output was dropped by the buffer limit and no spill copy exists; that portion is not recoverable]',
    'delivery.spill': 'Full output retained at: {path}',
    'wake.noSummaryFallback': 'a relayed child message (no summary provided)',
    // 带来源身份的回退文案：宿主契约里 relay / 结算通知的
    // source 恒带 senderSessionId（服务侧推导的归属，非权限）——有它就点名。
    'wake.noSummaryFrom': 'a relayed child message from {sender} (no summary provided)',
    // 降级警示段（需求 §5.1 模型可见侧）：前导 \n\n 自带；{detail} 是自检失败原文（数据，不翻译）。
    // 回退来源两态并列：启动失败＝出厂默认值（此时不存在上一合法快照），运行中失败＝上一合法值。
    'desc.degraded': '\n\n[async-tools] Live config self-check failed ({detail}); until the settings are corrected, the numbers above are fallback values (factory defaults when this happened at startup, otherwise the last valid values) and settings edits do not take effect. Fixing and saving on the settings page clears this warning automatically.',
    'via.noResident': 'The subagent is no longer resident in the agent registry (it is no longer observed running).',
    'ask.lateReminder': '[Reminder] A late-answer notice is pending; it will enter your context in the turn now opening.',
    'ask.lateReminderSummary': 'Late-answer claim reminder',
  },

  zh: {
    'digest.yield': '首次等待默认 {defaultYieldMs} ms（可传 yield_ms，范围 {minYieldMs}–{maxYieldMs} ms）；',
    'digest.wait': '单次等待预算必须显式传入，范围 {minWaitMs}–{maxWaitMs} ms；',

    'tool.run.p1': '以首次等待预算运行一条 PowerShell 命令。 ',
    'tool.run.p2': '若命令在 {defaultYieldMs} ms 的默认首次等待内结束，你会拿到命令输出，与普通命令工具一样；若超出首次等待，命令不会被杀死——它在后台继续运行，你立即得到一个作业编号（job_id）：Agent 可继续其他工作；作业结算时结果正文直接交付——附在你进行中的 async_wait 返回里，或作为一条完成消息到达，无需再调用取回。首次等待期间用户插话只结束等待、绝不终止命令——你会立刻拿到同一个作业编号；停止本轮也只结束等待，但宿主可能把模型可见结果改写为取消错误，作业编号不一定到达你——可从 job_list 或完成消息找回编号。与内置 pwsh 的差别：内置前台模式会在截止时杀死进程树；本工具只是首次等待。 ',
    // b 防线警示段（需求 §6.3）：只在「有约束执行器 且 开关开」时拼到 async_run 描述尾部；前导 \n\n 自带。
    'tool.run.warnCapture': '\n\n注意（本部署）：带捕获形（2>&1、$(...)、变量赋值或输出重定向）的命令在受限沙箱下可能在进程创建层被杀——什么都没执行，捕获结果为空。下结论「没有输出」之前，先裸调用验证一次。',

    // p5 两套按当前后端 inheritsParentContext 取用（同 en 档注释）。
    'tool.agent.p1': '把一个自包含任务委托给一个**新的**后台子代理；立即返回其 agent_id。 ',
    'tool.agent.p2': '构造上就是纯后台：没有 run_in_background 参数，它从不等待、从不轮询。 ',
    'tool.agent.p3': '经配置的子代理后端派生（当前：{provider}）。 ',
    'tool.agent.p4': '可选地同时提供 provider 与 model 来选择子代理的 LLM 路由；这一对值按**调用时刻的 dsh 模型选择设置**校验（调用之间改动的路由名单，下一次调用即生效）。两者都不传时按配置默认或继承父路由。选择前可调用 async_list_subagent_models 列出或搜索可用路由。 ',
    'tool.agent.p5': '子代理看不到本对话——请给一份完整、自包含的任务书。 ',
    'tool.agent.p5Inherit': '本子代理后端继承父对话上下文（子代理可以读到本对话）；任务书仍应自包含，可引用本会话已建立的路径与约定。 ',
    'tool.agent.p6': '用 async_wait(targets=[{kind:"agent", id:...}], wait_ms=...) 等待变化：有界；用户插话会打断等待而子代理继续运行；它的最终回答会作为独立消息到达。 ',

    // ── async_workflow（zh 档受控中文，与 en 档同义）───────────────
    'tool.workflow.p1': '运行一段 JavaScript workflow 脚本，大规模编排子代理。适用于需要向许多独立部分铺开的工作——对大量文件的审计、一项迁移、多角度调研、对发现的对抗性核查——这类工作你把编排写成脚本，而不是逐回合委托。\n\nworkflow 的身份信息以 JSON 形式放在 `meta` 参数：必填 `name`（短 kebab-case）与 `description` 字符串，可选 `whenToUse` 字符串与 `phases` 数组（`{title, detail?, provider?, model?}`）。`script` 参数**只是纯 JavaScript 脚本体**（不是 TypeScript，也不要 `export const meta` 语句——meta 是参数不是代码），允许顶层 await；以 `return <值>` 结尾——值必须可 JSON 序列化，它就是本工具的结果。\n\n脚本体内的钩子：\n- `agent(prompt, opts?): Promise<any>` ——把一个子代理跑到结束。不带 `opts.schema` 时按子代理的最终文本 resolve；带 `opts.schema`（只用 type/properties/required/additionalProperties/items/enum/const/oneOf 的对象根 JSON Schema——不支持 pattern/format/数值边界）时按校验后的对象 resolve。子代理失败时 resolve `null`（用 `.filter(Boolean)` 过滤）。其他 opts：`label`（展示）、`phase`（进度组）、相互独立的 `provider`/`model` LLM 目标覆盖（可只传其一）。其他选项（`effort`/`isolation`/`agentType`）一律报错拒绝。\n- `pipeline(items, ...stages): Promise<any[]>` ——每个条目独立流过各阶段，阶段之间没有屏障（多阶段工作优先用它）。每个阶段收到 `(prev, item, index)`。普通阶段抛错只把该条目降为 `null` 并跳过其余阶段。\n- `parallel(thunks): Promise<any[]>` ——并发运行零参函数并全部 await（屏障；仅当某一步真的需要全部前序结果时才用）。抛错的 thunk resolve 为 `null`。\n- `phase(title)` ——开始一个进度阶段；`log(message)` ——叙述进度；`args` ——本次调用的 `args` 输入原样。\n\n误用的钩子（坏参数、未知选项、不支持的 schema、触发上限）抛出的错误**总是终止整个脚本**——不会化成单个条目的 `null`。\n\n约束：并发与子代理总量上限适用；不提供文件系统、网络、定时器或 Node.js API——子代理干活，脚本只做协调。 ',
    'tool.workflow.p2': '仅在用户明确要求 workflow 或大规模多代理编排时使用本工具；一两个委托用 async_agent。编排**永远是后台作业**——没有 run_in_background 参数。若在 {defaultYieldMs} ms 默认首次等待内结算，你会拿到完整、可能被截断的结果，与前台调用一样；若超出首次等待，run 不会被取消——它在后台继续运行，你立即得到一个作业编号（job_id）：Agent 可继续其他工作；run 结算时结果正文直接交付——附在你进行中的 async_wait 返回里，或作为一条完成消息到达。首次等待期间用户插话只结束等待、绝不终止 run——你会立刻拿到同一个作业编号；停止本轮也只结束等待，但宿主可能把模型可见结果改写为取消错误，作业编号不一定到达你——可从 job_list 或完成消息找回编号。要真正取消一个编排，用 job_kill 停掉它。',

    'param.run.command': '要执行的 PowerShell 命令。',
    'param.run.description': '用主动语态简洁描述这条命令做什么，5-10 个词。',
    'param.run.yield_ms': '首次等待（毫秒），范围 {minYieldMs}-{maxYieldMs}。默认 {defaultYieldMs}。到期后命令转入后台并返回作业编号（job_id）。',
    'param.run.workdir': '工作目录。默认取会话工作目录。',
    'param.run.sandbox_permissions': '这条命令需要的更宽沙箱模式。只在对刚被沙箱拒绝的命令做同轮一次性重试时有效；需要说明理由并经用户批准。',
    'param.run.justification': '与 sandbox_permissions 一起必填：向用户解释为什么这条命令需要更宽权限的一句话。',
    'param.agent.description': '3-5 个词的展示标签。',
    // prompt 两套同 p5（同 en 档注释）。
    'param.agent.prompt': '交给子代理的完整、自包含任务书（它看不到本对话）。',
    'param.agent.promptInherit': '交给子代理的任务书。该后端继承本对话的上下文，任务书可引用此处已建立的路径与约定；请保持自包含。',
    'param.agent.cwd': '子代理的初始工作目录。相对路径以调用方当前有效目录解析；缺省继承该目录。此后任一侧切换目录互不影响。',
    'param.agent.provider': '子代理的 LLM provider 路由。与 model 一起提供；两者都不传时按后端路由默认、配置默认或继承父路由。',
    'param.agent.model': '该 provider 下的精确模型 id。与 provider 一起提供；两者都不传时按后端路由默认、配置默认或继承父路由。',
    'param.agent.reasoning_effort': '最终生效路由的推理强度。可单独提供；按最终生效路由校验。',
    'param.agent.agent_preset': '子代理使用的 Agent 预设。缺省用配置默认或继承父预设。',
    'param.agent.agentPresetChoices': '可选预设：{choices}。',
    'param.workflow.script': '纯 JS 的 workflow 脚本体（允许顶层 await；不要 `export const meta` 语句；以 `return <json 值>` 结尾）。',
    'param.workflow.meta': 'workflow 的身份信息块（纯 JSON——绝不是代码）。',
    'param.workflow.meta.name': '短 kebab-case 的 workflow 名。',
    'param.workflow.meta.description': '一行说明这个 workflow 做什么。',
    'param.workflow.meta.whenToUse': '可选：关于何时适用本 workflow 的提示。',
    'param.workflow.meta.phases': '可选：与 phase() 调用相匹配的阶段声明。',
    'param.workflow.meta.phases.title': 'phase() 调用按精确字符串匹配的阶段标题。',
    'param.workflow.meta.phases.detail': '可选：该阶段的一行说明。',
    'param.workflow.meta.phases.provider': '可选：该阶段预期使用的 provider 覆盖。',
    'param.workflow.meta.phases.model': '可选：该阶段预期使用的 model 覆盖。',
    'param.workflow.args': '可选：以 `args` 全局暴露给脚本的 JSON 输入（裸列表包一层字段，如 {"files": [...]}）。',
    'param.workflow.yield_ms': '首次等待（毫秒），范围 {minYieldMs}-{maxYieldMs}。默认 {defaultYieldMs}。到期后编排转入后台并返回作业编号（job_id）。',

    'subject.command': '命令',
    'subject.workflow': '工作流',
    'note.yield.running': '{subject}仍在运行：它超出了 {yieldMs} ms 的首次等待（已运行约 {elapsedMs} ms）。它没有被终止。',
    'note.yield.keepWorking': '继续做别的事；不要空等。需要输出时调用：',
    'note.yield.cap': '单次等待上限为 {maxWaitMs} ms；若返回 status:"running"，再次调用即可——{subject}不受影响。',
    'note.yield.earlyByUser': '首次等待提前结束：有用户消息到达（已运行约 {elapsedMs} ms）；{subject}本身不受影响。',
    'note.yield.budgetUnverified': '{subject}超出了 {yieldMs} ms 的首次等待（已运行约 {elapsedMs} ms），但随后的状态复查未能确认它的当前状态——读取作业列表失败，或该作业已不在可见清单里。它可能已经结算；请用下面的句柄复查，不要按"仍在运行"处理。',
    'note.yield.userUnverified': '首次等待提前结束：有用户消息到达（已运行约 {elapsedMs} ms）；结束等待没有终止{subject}。随后的状态复查未能确认它的当前状态——请用下面的句柄复查，不要按"仍在运行"处理。',
    'note.yield.unverified': '随后的状态复查未能确认{subject}的当前状态（读取作业列表失败，或该作业已不在可见清单里）——它可能已经结算；请用下面的句柄复查，不要按"仍在运行"处理。',
    // 取消口径（需求 §2.1.2：取消与预算到期分别说明——被取消不等同于超出预算）。
    'note.yield.cancelled': '调用在首次等待期间被取消（预算 {yieldMs} ms，已运行约 {elapsedMs} ms）；取消没有终止{subject}。',
    'note.waitAgain': '已等待 {waitedMs} ms；作业仍在运行（不受影响）。你可以先做别的事，稍后调用 async_wait(targets=[{kind:"job", id:"{jobId}"}], wait_ms=...)；单次等待上限为 {maxWaitMs} ms。',
    'note.agentWaitAgain': '已等待 {waitedMs} ms；子代理暂无变化（不受影响，仍在运行）。你可以先做别的事，稍后调用 async_wait(targets=[{kind:"agent", id:"{agentId}"}], wait_ms=...)；单次等待上限为 {maxWaitMs} ms。',
    // 到期/收敛后的复查读取失败（需求 §2.2.2：无法证实时不得宣称目标仍在运行）——
    // 与确认仍在运行的 waitAgain 分开；只陈述未证实并给重试出路。
    'note.recheckFailed': '已等待 {waitedMs} ms；随后的状态复查无法确认该作业的状态（读取作业列表失败，或该作业已不在本调用方可见的清单里），当前状态未证实——它可能已经结算。请再次调用 async_wait(targets=[{kind:"job", id:"{jobId}"}], wait_ms=...) 复查；单次等待上限为 {maxWaitMs} ms。',
    'note.agentRecheckFailed': '已等待 {waitedMs} ms；随后的状态复查未能观察到该子代理，其当前状态未证实——它可能已停止运行。请再次调用 async_wait(targets=[{kind:"agent", id:"{agentId}"}], wait_ms=...) 复查；单次等待上限为 {maxWaitMs} ms。',
    'note.interrupted': '等待被打断：一条用户消息已到达，将出现在你的下一条输入里（已等待 {waitedMs} ms）。结束等待没有终止{subject}的工作。先处理用户消息；之后要恢复等待，再次调用 {resume} 即可。',
    'note.interruptedPreexisting': '等待未开始：一条用户消息在本次等待开始前就已到达，将出现在你的下一条输入里。结束等待没有终止{subject}的工作。先处理用户消息；之后要恢复等待，再次调用 {resume} 即可。',
    'note.cancelled': '本次等待在 {waitedMs} ms 后被取消；取消没有终止{subject}的工作。之后要继续等待，再次调用 {resume} 即可。',
    'note.cancelledPreexisting': '本次调用在等待开始前已被取消；取消没有终止{subject}的工作。之后要继续等待，再次调用 {resume} 即可。',
    'note.settled': '子代理 {agentId} 不再被观察到在运行。它的最终回答会作为独立消息出现在对话里；不在本返回值中。',
    'note.agentStarted': '子代理已在后台派生。需要它的结果时，用 async_wait(targets=[{kind:"agent", id:"{agentId}"}], wait_ms={defaultWaitMs}) 等待（wait_ms 为等待示例值，仍必填、省略时报错）；用户插话会打断等待而子代理继续运行。它的最终回答会作为独立消息出现在对话里；list_agents 随时可查看进展。 ',
    // 静默失败防线（需求 §6.3）：签名 1 条件式 + 签名 2 直陈式，两键只在开关开时出。
    'note.silentCapture': '静默失败防线：命令带捕获形，且在受限沙箱下结算输出为空。若你预期的输出缺失，命令可能在进程创建层被杀、一条语句都没跑——按「没跑」处理，不是「跑了没输出」。可裸调用重试一次验证；要保留捕获形，请带 sandbox_permissions 重试同一条命令。',
    'note.silentDenied': '静默失败防线：输出与本部署受限沙箱的可见拒绝签名一致。请裸调用重试一次看真实报错；要保留原命令，请带 sandbox_permissions 重试。',

    'route.requested': '子代理 LLM 路由：{provider}/{model}（按请求）。',
    'route.configured': '子代理 LLM 路由：{provider}/{model}（工具配置默认）。',
    'route.backendDefault': '子代理 LLM 路由：{provider}/{model}（后端路由默认）。',
    'route.mixed': '子代理 LLM 路由：供应商 {providerPart}；模型 {modelPart}。',
    'route.partMissing': '未读到具体值',
    'route.source.configured': '（工具配置默认）',
    'route.source.backendDefault': '（后端路由默认）',
    'route.source.inherited': '（继承自本代理）',
    'route.inherits': '子代理 LLM 路由：继承父路由。',
    'route.inherited': '子代理 LLM 路由：{route}（继承自本代理）。',
    'route.effortSuffix': '（推理强度：{effort}）',
    'route.effortConfigured': '（推理强度：{effort}，工具配置默认）',
    'route.effortBackend': '（推理强度：{effort}，后端默认）',
    'route.effortInherited': '（推理强度：{effort}，继承）',

    'render.truncated': '[输出已截断：省略 {omitted} 字符]',
    // 编排结算渲染头（需求 §2.4/§2.2.3）：en 档与宿主 renderResult 同形；
    // 截断走 output.truncate 保首尾（标记在正文中），本键只承担头部说明。
    'render.workflowCompleted': 'workflow「{name}」已完成（{count} 个子代理）。\n返回值：\n',
    'render.exitCode': '[退出码: {code}]',
    'render.killedBySignal': '[被信号终止: {signal}]',
    'render.spillDisk': '[部分输出超出了 shell 的内存上限；完整输出在磁盘上——{paths}]',
    'render.spillNone': '[部分输出超出了 shell 的内存上限并被丢弃；没有报告落盘文件；如需该输出，请重跑命令并把输出重定向到文件]',
    'render.lossyPrefix': '[更早的输出已部分从内存中丢弃]',
    'render.spillPaths': '[宿主报告了本作业的输出留存文件（从内存缓冲丢弃的字节可能仍可从中找回）：{paths}]',
    // 终态状态行（需求 §2.2.2：终态在模型可见文本中区分 completed/failed/killed，
    // 不依赖可选详情；状态提示不占 maxResultChars 内容预算）。
    'render.jobStatus.completed': '[作业已完成]',
    'render.jobStatus.failed': '[作业失败]',
    'render.jobStatus.killed': '[作业已终止]',
    'render.readFailed': '[读取该作业的输出失败；下方输出为空——可再次调用 async_wait(targets=[{kind:"job", id:"..."}], wait_ms=...) 重试]',
    'render.agentStarted': 'async_agent 已启动。\nagent_id="{agentId}"\n',
    'render.notFound': '未知的子代理 "{agentId}"。已知子代理：\n{children}',

    'detail.exitCode': '退出码: {code}',
    'detail.signal': '信号: {signal}',
    'detail.lossy': '输出已部分从内存丢弃',
    'detail.lossyNone': '；没有报告落盘文件',
    'detail.lossyAt': '；完整输出在 {paths}',
    'detail.userArrivedFinished': '（等待期间到达了一条用户消息；作业在此期间结束了）',
    // 编排完成支的作业 detail（随完成快照进入交付读取的终态文本）。
    'detail.workflowAgents': '{count} 个子代理',

    'verdict.goneFromList': '该子代理已不在子代理列表里（不再被观察到在运行）。',
    'verdict.notRunning': '子代理列表不再把该子代理读作运行中（{activity}）；不再被观察到在运行。',
    'via.idle': '该子代理完成了当前工作（状态转为 idle）。',
    'via.recheck': '该子代理有进展，当前不处于运行态。',
    'via.notice': '收到了该子代理的结算通知。',
    'via.noticePreexisting': '在等待开始前就已收到该子代理的结算通知。',
    'via.textFallback': '一条结算通知按正文匹配到该子代理，且复查确认它已不再运行。',
    'list.diagnostic': '{id}（诊断：{reason}）',
    'note.agent.interruptedDuringSettle': '（等待期间收到了一条用户消息）',

    'error.escalationUnavailable': '本组合中 sandbox_permissions 不可用（没有可提权的沙箱执行器）',
    // 非严格加宽的启动前拒绝（需求 §6.1）：宿主助手对同级免审批放行，本包口径更严——
    // 同级／更窄／不支持的目标都在进程启动前可读拒绝、零注册零启动。
    'error.escalationSameLevel': 'sandbox_permissions「{mode}」与本次调用的当前沙箱模式相同，不是加宽请求；请去掉提权参数直接运行命令，或改选严格更宽的目标模式。',
    'error.escalationNotWider': 'sandbox_permissions「{requested}」不比本次调用的当前模式「{effective}」严格更宽；请改选严格更宽的目标模式，或去掉提权参数运行。',
    'error.sandboxPolicyMissing': 'async-tools: 挂载的 shell 执行器有约束，但 ctx.sandboxPolicy 缺席',
    'error.startRefused': 'async-tools: 命令在进程启动前被拒绝——没有进程在运行{limitNote}: {detail} {aliveNote} 用 job_kill 停掉不需要的作业，或等它结束后再重试。',
    'error.startRefusedPlain': 'async-tools: 命令在进程启动前被拒绝——没有进程在运行：{detail} 这不是并发上限；停掉其他作业不会有帮助。',
    // 显式 workdir 的 shell 准备失败诊断（设计 §3.1）：真实原错由调用处以原文
    // 独立拼接（不进占位模板；killed 触发形态的原错已在输出中，不再拼接）；
    // 核实结论四态键见下。
    'error.workdirPrep': 'async-tools: 命令进程未能启动。请求的 workdir：{requested}；解析后路径：{resolved}；会话当前目录：{cwd}。{verdict} {action}',
    'error.workdirPrepMissing': '解析后的目录不存在。',
    'error.workdirPrepExists': '解析后的目录存在，失败原因在别处——检查命令及其启动方式。',
    'error.workdirPrepNotDirectory': '解析后的路径已存在但不是目录——workdir 必须指向目录。',
    'error.workdirPrepUnverified': '无法核实解析后的目录是否存在。',
    'error.workdirPrepAction': '修正 workdir 后重试，或先核实目标目录。',
    'error.noAgentRun': 'async-tools: async_run 必须在模型回合内调用——它把命令注册为有主后台作业（完成通知是恢复通道），而当前没有 agent 语境。需要一次性同步命令时，请在提供同步 shell 的预设会话中使用。',
    'error.noAgentWorkflow': 'async-tools: async_workflow 必须在模型回合内调用——它把编排注册为有主后台作业（完成通知是恢复通道），而当前没有 agent 语境。需要一次性编排时，请在提供原生编排入口的预设会话中使用。',
    'error.workflowEngineMissing': 'async-tools: 当前组合里没有 workflowEngine 服务——请在 delegation 组内装载 workflow 引擎提供方（例如 @deepseek-ai/dsh-workflow-ptc）。',
    'error.workflowEmptyName': 'async-tools: meta.name 必须是非空字符串——它将成为作业列表里展示的作业标签（惯例为短 kebab-case）',
    'error.currentLimit': '（当前上限: {limit}）',
    'error.noLiveJobs': '没有找到其他存活的作业。',
    'error.liveJobs': '存活的作业：{jobs}。',
    'error.unknownJob': '未知作业 "{jobId}"；调用 job_list 查看存活的作业 id',
    'error.queryFailed': 'async-tools: 读取作业列表失败（该作业可能仍在）；请稍后重试 async_wait——这不是「未知作业」',
    'error.unknownAgent': '未知子代理 "{agentId}"；它不是本会话的子代理。已知子代理：\n{children}',
    'error.waitMsInvalid': 'wait_ms 必须是不小于 0 的有限数值',
    'error.targetsInvalid': 'targets 必须是 { kind, id } 对象的数组',
    'error.targetKindInvalid': '每个目标的 kind 必须是 "job" 或 "agent"',
    'error.targetIdInvalid': '每个目标的 id 必须是非空字符串',
    'error.noAgentContext': 'async_wait 需要会话（agent）上下文才能等待',
    'error.config.allowedPresetsEmpty': 'allowedAgentPresets 在场时必须至少含一个预设 id；显式空数组非法',
    // wait_ms 缺省的必填参数错误（经 execute 抛给模型，需求 §2.1.1/§5.3 双语）。
    'error.waitRequired': 'wait_ms 必填且有界：请显式传入 {minWaitMs}–{maxWaitMs} ms 范围内的单次等待预算',
    'error.listingUnavailable': '子代理列表不可用；无法观察子代理状态',
    'error.requiresAgent': 'async_agent 需要一个发起 agent；本工具必须在 agent 驱动的会话内运行',
    'error.unsupportedArgs': 'async_agent 收到不支持的参数：{keys} —— 支持的参数：{supported}；需要其他委托选项时，请按宿主规则在提供这些选项的预设新会话中使用',
    'error.pairTogether': '子代理 LLM 的 `provider` 与 `model` 必须一起提供',
    'error.providerNonEmpty': '子代理 LLM 的 `provider` 必须非空',
    'error.modelNonEmpty': '子代理 LLM 的 `model` 必须非空',
    'error.effortNonEmpty': '子代理 LLM 的 `reasoning_effort` 必须非空',
    // 以下四类拒绝都可用更换路由或重试解决（设计 §3.3；同 en 档注释）：保留真实
    // 原因，指引查询并保留目标工具条件（target_tool="async_agent"），不指路其他
    // 创建工具。启动前重读（步 12）三分各用一档：读取失败带原错给重试出路
    // （routeRecheckReadFailed）、开关关闭复用 selectionDisabled、名单撤销才用
    // 撤销口径（routeRecheckFailed）。
    'error.routeNotAllowed': '子代理 LLM 路由 "{provider}/{model}" 不在当前模型选择设置允许的名单内；可调用 async_list_subagent_models（target_tool="async_agent"，可带 query="{provider}"）列出或搜索允许的路由',
    'error.selectionDisabled': 'dsh 模型选择设置当前未开启显式子模型选择；省略 provider、model 与 reasoning_effort 即按配置默认或继承父路由',
    'error.policyUnavailable': '这里无法校验显式子模型选择：宿主组合未提供 subagentModelSelection 服务',
    'error.policyReadFailed': '模型选择设置读取失败：{reason}',
    'error.routeRecheckReadFailed': '启动前重读模型选择设置失败：{reason}；未启动任何子代理——请重试调用，或用 async_list_subagent_models（target_tool="async_agent"）复核当前路由',
    'error.routeRecheckFailed': '启动前重读的允许名单已不含所选路由；未启动任何子代理——请先用 async_list_subagent_models（target_tool="async_agent"）复核当前路由，再重新调用',
    // 预检拒绝（同 en 档注释：{reason} 为单行化截断的宿主原文）。
    'error.preflightRejected': '所选子代理 LLM 路由在创建前被拒：{reason}；可调用 async_list_subagent_models（target_tool="async_agent"）列出或搜索可用路由',
    'error.presetNotConfigured': '本工具行未配置可选预设集合（agent_preset 选择不可用）；省略 agent_preset 即用配置默认或继承父预设',
    'error.presetNotAllowed': 'agent_preset 必须是以下之一：{choices}',
    'error.presetNoBackend': '子代理后端 "{provider}" 不支持独立预设选择',
    'error.noEffectiveRoute': '没有可用的有效 provider 与 model，无法选择子代理 LLM 值',
    'error.llmUnavailable': '本组合没有 llm 服务，无法解析所选的子代理 LLM 路由',
    'error.providerChanged': '解析子代理 LLM 路由期间后端 "{provider}" 发生变化；未启动任何子代理——请重新调用',
    'error.providerNotRegistered': '子代理后端 "{provider}" 未注册——请检查 async-tools 的设置项 \'subagentProvider\'（默认是 "spawn"）',
    'error.noContinuable': '子代理后端 "{provider}" 不支持后台委托（缺少 prepareContinuable）',
    'error.noAgentOptions': '子代理后端 "{provider}" 不处理 agentOptions——请求的路由会被静默忽略',

    // ── 路由查询工具 async_list_subagent_models（需求 §2.3.4，设计 §3.7） ──
    'tool.list.p1': '只读列出当前会话可用于子代理的 LLM 供应商／模型，支持分页与搜索。不创建代理、不发起模型请求、不改任何路由或设置。',
    'tool.list.p2': '不传 provider 与 query 时分页浏览供应商；传 provider 时分页浏览其模型；传 query（忽略大小写，匹配 ID 与显示名称）跨供应商或在指定供应商内搜索；provider 与 model 一起传时查看该精确模型及其推理强度。',
    'tool.list.p3': 'target_tool 把适用性判断与参数示例限定到某个子代理创建工具；判断区分「允许选择」「不允许选择」「适用性未确认」并始终说明依据。',
    'tool.list.p4': '分页：page_size 默认 20（范围 1-100）；page 大于 1 需同时传上一页返回的版本令牌；版本失效说明策略或目录已变化——请从第 1 页重新查询。',
    'param.list.provider': '供应商 id。缺省列出供应商（或与 query 一起跨供应商搜索）。',
    'param.list.model': '精确模型 id，查看模型详情。需要 provider。',
    'param.list.query': '搜索词，忽略大小写匹配供应商／模型的 ID 与显示名称；纯空白等同未提供。',
    'param.list.target_tool': '适用性判断面向的子代理创建工具名（async_agent 或宿主工具名，含用户配置名）。缺省时仅有一个可识别创建工具则采用它；有多个或无法识别时报适用性未确认。具名但不可见的工具按「不允许选择」报告原因，目录照常返回。',
    'param.list.page': '从 1 起的页码。page 大于 1 需要上一页响应中的版本令牌。',
    'param.list.page_size': '每页条目数，默认 20，范围 1-100。',
    'param.list.version': '上一页响应返回的版本令牌，page 大于 1 时必填；不匹配时拒绝拼接并提示重新查询。',
    // 参数示例的占位串（exampleArguments 生成；efforts 为逗号连接的强度 id）。
    'param.list.exampleDescription': '<3-5 个词的标签>',
    'param.list.examplePrompt': '<完整的自含任务说明>',
    'param.list.exampleEffort': '<取值之一：{efforts}>',
    'list.verdict.allowed': '允许选择',
    'list.verdict.notAllowed': '不允许选择',
    'list.verdict.unconfirmed': '适用性未确认',
    'list.basis.asyncCurrent': '当前 dsh 模型选择设置：已开启，允许 {count} 条路由',
    'list.basis.asyncDisabled': '当前 dsh 模型选择设置未开启；显式 provider/model/reasoning_effort 会被拒绝（配置默认与父继承不受影响）',
    'list.basis.asyncReadFailed': '模型选择设置读取失败：{reason}',
    'list.basis.asyncNoService': '本组合未提供 subagentModelSelection 服务',
    'list.basis.noRouteParams': '该工具在当前会话不暴露路由选择参数',
    'list.basis.nativeProjection': '会话模型选择投影：会话组合时记录了 {count} 条路由',
    'list.basis.nativeNoProjection': '本会话没有已记录的模型选择策略（投影为空）；目标多半在组合时未启用模型选择设置',
    'list.basis.nativeProjectionFailed': '会话模型选择投影读取失败：{reason}',
    'list.basis.nativeNoAgent': '没有发起调用的 agent，读不到会话投影',
    'list.basis.nativeAssembleFailed': '读取调用方作用域的提示词组装失败，无法证明目标身份：{reason}',
    'list.basis.nativeSectionEmpty': '调用方作用域的提示词组装中没有该目标的非空 "tool:<名>" 段，可见定义无法证明是原生注册的那个（未装载、行配置了别名或被同名登记遮蔽）',
    'list.basis.multiCandidates': '当前可见多个创建工具（{candidates}）；请传 target_tool 限定判断对象',
    'list.basis.noneCandidates': '当前会话没有可见的子代理创建工具',
    'list.basis.targetNotVisible': 'target_tool "{tool}" 不是当前会话可见的子代理创建工具（可见：{candidates}）；目录按无已确认目标返回',
    'list.basis.asyncNoRegistry': '本组合未提供 subagents 服务，子代理后端现状无法确认',
    'list.basis.asyncForeignName': '名下可见的 async_agent 定义不是本包注册的（同名登记、被遮蔽，或登记在另一模块实例），其身份、参数与配置无法确认',
    'list.basis.asyncIdentityUnreadable': '可见工具定义读取失败，无法证实该 async_agent 由本包注册：{reason}',
    'list.basis.asyncBackendFailed': '子代理后端注册表读取失败：{reason}',
    'list.basis.asyncBackendMissing': '配置的子代理后端 "{provider}" 未注册，显式路由选择在执行期会被拒绝',
    'list.basis.asyncBackendNoOptions': '配置的子代理后端 "{provider}" 不支持子模型选择（未声明 agentOptions），显式路由选择在执行期会被拒绝',
    'list.basis.asyncBackendNotContinuable': '配置的子代理后端 "{provider}" 未提供可续支持（缺 prepareContinuable），显式路由选择在执行期会被拒绝',
    'list.basis.asyncBackendNoPreset': '创建行配置了默认子代理预设，但配置的子代理后端 "{provider}" 不支持独立预设，创建会在派生子代理前被拒绝',
    'list.basis.routeNotAllowed': '路由 {provider}/{model} 不在该目标已确认的允许集合内',
    'render.list.providersHeader': '子代理 LLM 供应商（第 {page} 页，共 {total} 个{partialNote}）：',
    'render.list.modelsHeader': '{provider} 的模型（第 {page} 页，共 {total} 个{partialNote}）：',
    'render.list.searchHeader': '匹配 "{query}" 的路由（第 {page} 页，共 {total} 个{partialNote}）：',
    'render.list.detailHeader': '模型 {provider}/{model}：',
    'render.list.providerLine': '供应商 {provider}——{name}',
    'render.list.modelLine': '模型 {provider}/{model}——{name}',
    // 供应商浏览的数量段（需求 §2.3.4：确认目标策略后标允许模型数，未确认标目录已知数）。
    'render.list.countAllowed': '{count} 个允许模型',
    'render.list.countCatalog': '目录已知 {count} 个模型',
    'render.list.countUnknown': '模型数未知（列举失败）',
    'render.list.unlistedProvider': '（供应商 "{provider}" 不在当前目录中；这里没有它的已列模型）',
    'render.list.unlistedProviderAllowed': '（供应商 "{provider}" 不在当前目录中；以下条目来自已确认的允许名单）',
    'render.list.unlistedProviderNoMatch': '（供应商 "{provider}" 不在当前目录中；它的允许名单路由均在，但没有匹配 "{query}" 的条目）',
    'render.list.allowedListMark': '（来自允许名单）',
    'render.list.notInAllowList': '（不在允许名单）',
    'render.list.readFailed': '（以下供应商的列举失败：{failed}；这是读取失败，不是空目录——请重试同一查询，或逐个供应商查询）',
    'render.list.emptyProviders': '（没有已注册的 LLM 供应商）',
    'render.list.emptyModels': '（{provider} 没有已列出的模型）',
    'render.list.noMatches': '（没有匹配 "{query}" 的结果）',
    'render.list.effortsHeader': '推理强度：',
    'render.list.effortLine': '强度 {id}{defaultMark}——{name}',
    'render.list.defaultEffort': '（默认）',
    'render.list.noEfforts': '（没有已列出的推理强度）',
    'render.list.pageFooter': ' ｜ 第 {page}／{lastPage} 页，共 {total} 条{partialNote}{nextHint}',
    'render.list.nextHint': ' ｜ 下一页：用参数 {next} 续查',
    'render.list.beyondEnd': '第 {page} 页已越过末页（{lastPage}），这里没有条目。当前筛选条件共匹配 {total} 条——请重新查询继续。',
    'render.list.applicability': '\n目标 {target}：{verdict}——{basis}。',
    'render.list.example': ' {target} 的参数示例：{example}',
    'render.list.partialNote': '——不完整：{failed} 个供应商的列举失败',
    'error.list.llmUnavailable': 'async_list_subagent_models：本组合没有 llm 服务，目录无法读取；未查询也未改动任何内容',
    'error.list.modelNeedsProvider': 'async_list_subagent_models：model 需要 provider',
    'error.list.providerEmpty': 'async_list_subagent_models：provider 必须非空',
    'error.list.modelEmpty': 'async_list_subagent_models：model 必须非空',
    'error.list.pageSize': 'async_list_subagent_models：page_size 须为 1-100 的整数（默认 20）',
    'error.list.page': 'async_list_subagent_models：page 须为正整数',
    'error.list.versionRequired': 'async_list_subagent_models：第 {page} 页需要上一页响应返回的版本令牌；请按当前筛选条件从第 1 页重新查询',
    'error.list.versionStale': 'async_list_subagent_models：上一页之后结果版本已变化（策略或目录更新）；两页不能拼接——请按相同筛选条件从第 1 页重新查询',
    'error.list.queryDetailConflict': 'async_list_subagent_models：非空搜索词不能与准确模型详情（provider+model）同时请求；去掉搜索词查详情，或去掉 provider+model 做搜索',
    'error.list.targetEmpty': 'async_list_subagent_models：target_tool 必须是非空字符串',
    'error.list.providersFailed': 'async_list_subagent_models：读取供应商列表失败：{reason}',
    'list.reason.systemPromptUnavailable': '本组合没有 systemPrompt 服务',
    'list.reason.toolsGetUnavailable': '本组合的 tools 服务未提供 get(name, scope)',
    'list.reason.schemasGetMismatch': 'schemas 枚举可见而 tools.get 查无',
    'error.list.detailUnsupported': 'async_list_subagent_models：模型目录报告 {provider}/{model} 不存在或不受支持',
    'error.list.detailFailed': 'async_list_subagent_models：读取模型 {provider}/{model} 详情失败：{reason}',

    // ── c 防线常驻纪律段（需求 §6.3，宿主侧 systemPrompt 注入） ───────────
    'discipline.block': '本部署执行纪律（受限沙箱下的 pwsh）：\n1. 捕获形命令可能静默死。带捕获形（2>&1、$(...)、变量赋值或输出重定向 >）的命令在受限沙箱下可能在进程创建层被杀：什么都没执行，捕获结果为空。判别特征：输出为空、无 [exit code] 标记、$LASTEXITCODE 为空。若预期的输出缺失，按「命令没跑」处理，绝不当「跑了没输出」。存疑就裸调用重试一次（裸调用可靠）；要保留捕获形，请带 sandbox_permissions 重试同一条命令。\n2. 部分部署的本机杀毒软件会在进程创建层击杀隐藏执行的 PowerShell（按命令行文本命中独立的 -W/-w 开关或 -WindowStyle Hidden）。命中这一确切形态——退出码 4294967295 且无其他输出——时，整个 pwsh 在任何语句运行前就死掉了；提权无用。应改写命令（-Width、或经变量传值）。',

    // ── 预设执行纪律段（需求 §5.3/§9.1 ASK-01，宿主半边注册的 systemPrompt
    // section 运行时注入；agentLang 管语言档、按目标会话实际预设选变体，设计
    // §3.6）。zh 档与 en 档语义、约束相同（等义译文）；两变体差异同 en 档。
    'discipline.preset.dsh-async': '本部署异步执行命令。`async_run` 的命令超出首次等待预算时返回 job_id 而不阻塞：此时先做别的事——作业结算时结果正文直接交付（附在进行中的 async_wait 返回里，或作为一条完成消息到达），不要空等、也不要重跑同一条命令。需要后台子代理的结果时用 async_wait（有界、用户插话会打断等待），不要轮询。绝不能把返回的 job_id 当作失败。\n委托规则（硬性规则，不是建议）：\n1) 委托一律在后台。async_agent 是本预设唯一的委托入口（它没有前台模式）；宿主的 subagent / subagent_fork 工具在本预设已禁用。前台委托会挡住整批工具调用——绝不要传 run_in_background: false。\n2) 需要子代理的结果时，用 async_wait(targets=[{kind:"agent", id:"..."}], wait_ms=...) 有界等待。不要循环轮询；不要为查看进度重新委托；最终回答会作为独立消息到达。\n提问规则（硬性规则，不是建议）：\n1) 提问及其选项不使用指代执行者、授权者或归属对象的人称代词；改用明确、可区分的角色名称。\n2) 涉及角色的选项要写清角色与动作。\n3) 选择之后，对角色的指向与所选角色名称保持一致。',
    'discipline.preset.dsh-async-create': '本部署异步执行命令。`async_run` 的命令超出首次等待预算时返回 job_id 而不阻塞：此时先做别的事——作业结算时结果正文直接交付（附在进行中的 async_wait 返回里，或作为一条完成消息到达），不要空等、也不要重跑同一条命令。需要后台子代理的结果时用 async_wait（有界、用户插话会打断等待），不要轮询。绝不能把返回的 job_id 当作失败。\n委托规则（硬性规则，不是建议）：\n1) 委托一律在后台。async_agent 是本预设唯一的委托入口——它没有前台模式。subagent / subagent_fork 在本预设已禁用，不要调用。\n2) 需要子代理的结果时，用 async_wait(targets=[{kind:"agent", id:"..."}], wait_ms=...) 有界等待。不要循环轮询；不要为查看进度重新委托；最终回答会作为独立消息到达。\n提问规则（硬性规则，不是建议）：\n1) 提问及其选项不使用指代执行者、授权者或归属对象的人称代词；改用明确、可区分的角色名称。\n2) 涉及角色的选项要写清角色与动作。\n3) 选择之后，对角色的指向与所选角色名称保持一致。',

    // ── 提问接管（需求 §4.1/§4.4：超时合成与迟到注入的模型侧文案） ─────
    // 迟到注入是通知形（followup + 自声明 kind）：正文自含完整题目内容（用户决定）——压缩或长对话后模型不依赖对原工具调用的记忆即可行动。
    'ask.timeoutCustom': '用户暂未作答（等待 {seconds} 秒超时）：请按你的最佳判断继续。用户稍后作答时，答案会以通知送达（超时记录在后续提问批次被接管时惰性清扫，只清超时已超过 24 小时的记录；在此之前仍可补答）。',
    'ask.windowSkip': '用户在等待窗口内选择跳过本题。',
    'ask.lateAnswer': '[迟到作答] 用户在超时后回答了挂起的问题。\n问题 id：{qid}\n题干：{question}\n选项（multiSelect={multiSelect}）：{options}\n作答：{answer}\n时延：提问后 {delay} 秒。',
    'ask.lateIgnore': '[迟到作答] 用户在超时后选择不答挂起的问题。\n问题 id：{qid}\n题干：{question}\n选项（multiSelect={multiSelect}）：{options}\n决定：不作答\n时延：提问后 {delay} 秒。',
    'ask.lateSummary': '问题 {qid} 的迟到作答：{answer}',
    'ask.lateIgnoreSummary': '问题 {qid} 的迟到跳过',
    'ask.lateCustomAnswer': '自定义回答：{custom}',
    // 作答拒绝（需求 §4.2.4：非法作答可见拒绝）——RPC 错误回执的原因文案。
    'ask.answerRejectedError': '[async-tools] 作答被拒：{reason}',
    'ask.rejectUnknownOption': '所选答案不在本题选项内',
    'ask.rejectSingleMultiple': '单选题只能选择一项答案',
    'ask.rejectBlankCustom': '自定义回答已选中但内容为空',
    'ask.rejectSingleBoth': '单选题在预设选项与自定义回答中只能选一项',
    'ask.rejectNothing': '未选择任何答案：请选择一项选项或填写自定义回答',
    'wait.lateArrived': '迟到作答已到（{summary}）；通知将在下一领取点进入你的上下文。本次等待没有终止目标的工作。',
    'wait.wokeByMessage': '一条可处理消息已到（{summary}）；它将在下一领取点进入你的上下文。本次等待没有终止目标的工作。',
    'wait.targetMessage': '目标子代理发来一条消息（{summary}）；它将在下一领取点进入你的上下文。',
    'wait.agentResumed': '此前已确认停止的子代理 {agentId} 又在运行了。',
    'wait.readyWoke': '后台作业结果可交付；交付条目见下方。',
    'wait.budgetTargets': '等待预算到期，目标条件未满足；附各目标当前状态与可交付条目。需要继续等待请再次调用。',
    'wait.budgetNoTargets': '等待预算到期，无可处理消息。需要继续等待请再次调用。',
    'wait.zeroWaitTargets': '零等待只做即时检查：目标条件暂未满足。附各目标当前状态与当前增量。',
    'wait.alreadyDelivered': '作业 {jobId} 已完成，其结果先前已交付（此前的某次等待返回，或完成消息——也可能正随本输入的完成消息送达）；结果不重复出现。上方输出为空是这个原因，不是作业没有产出。',
    'delivery.spillOverflow': '（另有 {count} 处留存路径未列出；已到批次说明预算）',
    'wait.zeroWaitNoTargets': '零等待只做即时检查：当前无可处理消息。',

    // ── async_wait 主描述 ────────────────────────────────────────────
    'tool.wait.p1': '以一份有界预算等待。不指定目标时，任何发给你的可处理消息到达、或后台作业结果可交付时结束等待（结果正文直接附在返回里，不需要再调用领取）。 ',
    'tool.wait.p2': '指定目标时：任一目标作业进入终态（输出附在返回里）、任一目标子代理产生变化通知、或用户插话到达时结束等待；非目标通知不会提前结束等待。等待子代理表示等待它的变化——它的最终回答仍会作为独立消息到达。 ',
    'tool.wait.p3': '等待期间，用户**插话**（进入你的下一次输入）会立即以 status:"interrupted" 返回——后台工作不受影响、继续运行；**排队**消息（本轮结束后才送达）不会打断等待。 ',
    'tool.wait.p4': 'wait_ms=0 只做一次即时检查、不等待。预算到期时返回各目标当前状态；需要继续等待请再次调用。 ',

    // ── async_wait 参数说明 ──────────────────────────────────────────
    'param.wait.wait_ms': '必填，本次等待预算（毫秒，{minWaitMs}-{maxWaitMs}）；0 表示不等待、只做即时检查。',
    'param.wait.targets': '可选等待目标；省略（或传 []）表示等待任何可处理消息或可交付的作业结果。',
    'param.wait.targets.kind': '"job" 或 "agent"。',
    'param.wait.targets.id': '作业编号（来自 async_run / async_workflow / job_list）或子代理编号（list_agents 可见）。',

    // ── 交付账本文案（完成消息与批次说明）─────────────────────────────
    'delivery.deferred': '另有 {count} 份结果因批次预算延后；可调用 async_wait(targets=[...], wait_ms=0) 领取。',
    'delivery.readFailed': '[读取失败] 作业 {jobId} 的最终输出此刻没能从注册表读出；这不是结果为空。请重试 async_wait(targets=[{kind:"job", id:"{jobId}"}], wait_ms=...) 取回。',
    'delivery.deferredNotice': '作业 {jobId} 已结算；其结果没有排进当前交付批次。请调用 async_wait(targets=[{kind:"job", id:"{jobId}"}], wait_ms=0) 立即领取。',
    'error.foreignJob': '作业 {jobId} 属于另一会话，不能从这里等待它。',
    'delivery.completionItem': '后台作业 {jobId} 已结算：{status}（{chars} 字符）。',
    // 运行中增量条目（同 en 档注释）：与终态状态行分键，避免「已结算：运行中」的自相矛盾。
    'delivery.completionItemRunning': '后台作业 {jobId} 仍在运行；当前增量（{chars} 字符）。',
    'delivery.completionSummary': '后台作业结果 × {count}',
    'delivery.lossy': '[更早的输出因缓冲上限被丢弃]',
    // lossy 找回说明（同 en 档注释）：两态由 paths 有无选择。
    'delivery.lossyAtPaths': '[更早的输出因缓冲上限被丢弃；完整输出留存于：{paths}]',
    'delivery.lossyUnrecoverable': '[更早的输出因缓冲上限被丢弃，且没有落盘副本；该部分无法找回]',
    'delivery.spill': '完整输出留存于：{path}',
    'wake.noSummaryFallback': '子代理转达消息（未附摘要）',
    // 带来源身份的回退文案（同 en 档注释）。
    'wake.noSummaryFrom': '来自子代理 {sender} 的转达消息（未附摘要）',
    // 降级警示段（需求 §5.1 模型可见侧）：前导 \n\n 自带；{detail} 是自检失败原文（数据，不翻译）。
    // 回退来源两态并列（同 en 档注释）：启动失败＝出厂默认值，运行中失败＝上一合法值。
    'desc.degraded': '\n\n[async-tools] 生效配置自检失败（{detail}）；设置改正前，上文数字均为回退值（启动时回退出厂默认值，运行中保留上一合法值），设置页改动不生效。在设置页改正并保存后，本警示自动消失。',
    'via.noResident': '该子代理已不在代理注册表驻留（不再被观察到在运行）。',
    'ask.lateReminder': '[提醒] 迟到作答通知待领取，将在本回合进入你的上下文。',
    'ask.lateReminderSummary': '迟到作答领取提醒',
  }
};

/**
 * 取一句模型侧文案。
 *
 * - 未知 **key** 抛错：静默返回空串会让缺译看不见（需求 §5.3：遗漏翻译
 *   不能静默显示键名或另一语言）。
 * - 未知 **lang** 回退 `'en'`：语言字段缺省（如测试里的裸 Proxy 视图）时
 *   按默认档取文案，而不是炸掉整条构建链。
 * - `{name}` 占位按 `vars` 插值；不在 `vars` 里的占位按字面保留。
 *
 * @param {string} lang - 语言档（`config.agentLang`；未知名回退 'en'）。
 * @param {string} key - 点分键。
 * @param {object} [vars] - 占位值（数字按 String 插入）。
 * @returns {string} 文案。
 */
export function t(lang, key, vars) {
  const table = TEXT[LANGS.includes(lang) ? lang : 'en'];
  const text = table[key];
  if (typeof text !== 'string') {
    throw new Error(`[async-tools] missing text key ${JSON.stringify(key)} (lang ${JSON.stringify(lang)})`);
  }
  if (vars === undefined || vars === null) return text;
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (literal, name) => (
    Object.hasOwn(vars, name) ? String(vars[name]) : literal
  ));
}
