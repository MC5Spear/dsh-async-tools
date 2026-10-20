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
    'digest.yield': 'The first wait defaults to {defaultYieldMs} ms (pass yield_ms, range {minYieldMs}–{maxYieldMs} ms); a command that outlives the first wait is not killed — it moves to the background and returns a job id (job_id).',
    'digest.wait': 'Per-call wait budgets must be passed explicitly, range {minWaitMs}–{maxWaitMs} ms;',

    // ── async_run 主描述 ─────────────────────────────────────────────
    'tool.run.p1': 'Run a PowerShell command with a first-wait budget. ',
    'tool.run.p2': 'If it finishes within the {defaultYieldMs} ms default first wait you get the full output, like a normal command tool; if it outlives the first wait the command is NOT killed — you immediately get a job id (job_id) and the background task keeps running. The Agent can continue other work and retrieve the output with async_wait_job later. During the first wait a user message (or a stop of the turn) ends only the wait, never the command: you get the job id right away, the background task keeps running, and a completion notice arrives when it settles. Difference from the built-in pwsh: the built-in foreground mode kills the process tree at the deadline; this tool only does a first wait. ',
    'tool.run.p3': 'First wait bounded to {minYieldMs}–{maxYieldMs} ms; ',
    // b 防线警示段（需求 §6.3）：只在「有约束执行器 且 开关开」时拼到 async_run 描述尾部；
    // 前导 \n\n 自带（buildToolText 是空串 join，无前导空白会与前段粘连）。
    'tool.run.warnCapture': '\n\nCaution (this deployment): a command in capture form (2>&1, $(...), a variable assignment, or output redirection) can die silently at process creation under the restricted sandbox — nothing executes and the capture stays empty. Before concluding "no output", verify once with a bare call.',

    // ── async_wait_job 主描述 ────────────────────────────────────────
    'tool.wait_job.p1': 'Wait (bounded) for a background job started by `async_run` to finish, then return its output. ',
    'tool.wait_job.p2': 'wait_ms is required, range {minWaitMs}–{maxWaitMs} ms.',
    'tool.wait_job.p3': 'While waiting, a **steering** user message (delivered into your very next input) returns status:"interrupted" immediately — **the job is unaffected and keeps running in the background**; a **queued** message (delivered only after this turn ends) does not interrupt the wait. A steering message that arrived **before** the wait started is caught by an entry check and returns status:"interrupted" immediately as well. ',
    'tool.wait_job.p4': 'When the budget expires you get status:"running"; call this tool again. ',
    'tool.wait_job.p5': 'The established way to retrieve background output is this tool. ',
    'tool.wait_job.coverage': ' The wait_ms budget bounds the total call time: one existence snapshot plus the wait segment.',

    // ── async_wait_agent 主描述 ───────────────────────────────────────
    'tool.wait_agent.p1': 'Wait (bounded) for a background subagent to finish. ',
    'tool.wait_agent.p2': 'wait_ms is required, range {minWaitMs}–{maxWaitMs} ms. ',
    'tool.wait_agent.p3': 'While waiting, a **steering** user message (delivered into your very next input) returns status:"interrupted" immediately — **the subagent is unaffected and keeps running**; a **queued** message (delivered only after this turn ends) does not interrupt the wait. A steering message that arrived **before** the wait started is caught by an entry check and returns status:"interrupted" immediately as well. ',
    'tool.wait_agent.p4': 'status:"settled" means "during this wait it was no longer observed running" (the authoritative signals are the settlement notice and the status turning idle); it does NOT guarantee that its final answer has arrived yet. The final answer arrives as its own message in the conversation, not in this return value; if you truly need its conclusion, keep working on other things and the message will reach you. ',
    'tool.wait_agent.p5': 'When the budget expires you get status:"running"; call again. ',
    'tool.wait_agent.p6': 'If the subagent already finished before this call, the entry check observes it — the registry status has turned idle or the subagent is no longer resident, or an unclaimed settlement notice is pending — and returns status:"settled" immediately instead of waiting out the budget. Its settlement notice and final answer arrive as their own messages in the conversation. The subagent catalog shows which children exist; check that notice or list_agents before calling this tool again. ',
    'tool.wait_agent.coverage': ' The wait_ms budget bounds the total call time: the existence barrier (up to 3 x {pollIntervalMs} ms of retries) plus the wait segment.',

    // ── async_agent 主描述 ────────────────────────────────────────────
    'tool.agent.p1': 'Delegate a self-contained task to a NEW background subagent; returns immediately with its agent_id. ',
    'tool.agent.p2': 'Background-only by construction: there is no run_in_background parameter, it never waits and never polls. ',
    'tool.agent.p3': 'Delegates via the configured subagent provider (currently: {provider}). ',
    'tool.agent.p4': 'Optionally supply provider and model together to select the subagent\'s LLM route (checked against this session\'s model-selection policy); omit both to inherit the parent route. ',
    'tool.agent.p5': 'The subagent does not see this conversation — pass a complete, self-contained prompt. ',
    'tool.agent.p6': 'Retrieve the result with async_wait_agent(agent_id=..., wait_ms=...): bounded; a user steer interrupts the wait while the subagent keeps running; its final answer arrives as its own message. ',

    // ── async_workflow（需求 §2.4；p1 的脚本契约与宿主 tool-workflow 的 DESCRIPTION
    //    同源——它是模型侧规格，两套措辞会漂移）───────────────────────────
    'tool.workflow.p1': 'Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification of findings — where you write the orchestration as a script instead of delegating turn by turn.\n\nThe workflow\'s identity rides the `meta` parameter as JSON: required `name` (short kebab-case) and `description` strings, optional `whenToUse` string and `phases` array (`{title, detail?, provider?, model?}`). The `script` parameter is the plain JavaScript body ONLY (NOT TypeScript, and NO `export const meta` statement — meta is a parameter, not code), running with top-level await; end with `return <value>` — the value must be JSON-serializable and is this tool\'s result.\n\nScript-body hooks:\n- `agent(prompt, opts?): Promise<any>` — run one subagent to completion. Without `opts.schema` it resolves to the child\'s final text; with `opts.schema` (an object-rooted JSON Schema using ONLY type/properties/required/additionalProperties/items/enum/const/oneOf — no pattern/format/numeric bounds) it resolves to the validated object. Resolves `null` when the child fails (filter with `.filter(Boolean)`). Other opts: `label` (display), `phase` (progress group), and independent `provider`/`model` LLM target overrides (either may be provided alone). Anything else (`effort`/`isolation`/`agentType`) is rejected loudly.\n- `pipeline(items, ...stages): Promise<any[]>` — run each item through the stages independently with NO barrier between stages (prefer this for multi-stage work). Each stage receives `(prev, item, index)`. An ordinary stage throw drops that ITEM to `null` and skips its remaining stages.\n- `parallel(thunks): Promise<any[]>` — run zero-argument functions concurrently and await ALL of them (a barrier; use only when a stage genuinely needs every prior result together). A throwing thunk resolves to `null`.\n- `phase(title)` — start a progress phase; `log(message)` — narrate progress; `args` — the tool call\'s `args` input, verbatim.\n\nMisused hooks (bad arguments, unknown options, unsupported schemas, tripped caps) throw errors that ALWAYS kill the script — they never dissolve into a per-item `null`.\n\nConstraints: concurrency and total-agent caps apply; no filesystem, network, timers, or Node.js APIs are provided — the agents do the work, the script only coordinates them. ',
    'tool.workflow.p2': 'Use this tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration; for one or two delegations prefer async_agent. The run is ALWAYS a background job — there is no run_in_background parameter. If it settles within the {defaultYieldMs} ms default first wait you get the full result, like a foreground call; if it outlives the first wait the run is NOT cancelled — you immediately get a job id (job_id) and the background task keeps running. The Agent can continue other work and retrieve the result with async_wait_job later. During the first wait a user message (or a stop of the turn) ends only the wait, never the run: you get the job id right away, the background task keeps running, and a completion notice arrives when it settles. To actually cancel an orchestration, stop it with job_kill.',

    // ── 参数说明 ──────────────────────────────────────────────────────
    'param.run.command': 'The PowerShell command to execute.',
    'param.run.description': 'Clear, concise description of what this command does in active voice, 5-10 words.',
    'param.run.yield_ms': 'First wait in milliseconds ({minYieldMs}-{maxYieldMs}). Defaults to {defaultYieldMs}. On expiry the command keeps running in the background and a job id (job_id) is returned.',
    'param.run.workdir': 'Working directory. Defaults to the session working directory.',
    'param.run.sandbox_permissions': 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.',
    'param.run.justification': 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.',
    'param.wait_job.job_id': 'The job id returned by `async_run` (for example "async-command-3").',
    'param.wait_job.wait_ms': 'Required per-call wait budget in milliseconds ({minWaitMs}-{maxWaitMs}).',
    'param.wait_agent.agent_id': 'The subagent id returned when it was started (list_agents shows ids).',
    'param.wait_agent.wait_ms': 'Required per-call wait budget in milliseconds ({minWaitMs}-{maxWaitMs}).',
    'param.agent.description': '3-5 word label for display.',
    'param.agent.prompt': 'The complete, self-contained task for the subagent (it cannot see this conversation).',
    'param.agent.provider': 'LLM provider route for the subagent. Supply together with model; omit both to inherit the parent route.',
    'param.agent.model': 'Exact model id under the provider. Supply together with provider; omit both to inherit the parent route.',
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
    'param.workflow.yield_ms': 'First wait in milliseconds ({minYieldMs}-{maxYieldMs}). Defaults to {defaultYieldMs}. On expiry the orchestration keeps running in the background and a job id (job_id) is returned.',

    // ── note / 句柄文案 ──────────────────────────────────────────────
    // 共享首次等待模板的主体称谓（设计 §2.5）：按路径取「命令」或「工作流／编排」，
    // 编排不得误称命令。{subject} 由 output.js 的 yieldNote 按 kind 注入。
    'subject.command': 'command',
    'subject.workflow': 'workflow',
    'note.yield.running': 'The {subject} is still running: it outlived the {yieldMs} ms first wait (about {elapsedMs} ms elapsed). It was NOT terminated; the background task keeps running.',
    'note.yield.keepWorking': 'Keep working on other things; do not idle-wait. When you need its output, call:',
    'note.yield.cap': 'Per-call wait cap is {maxWaitMs} ms; if it returns status:"running", call again — the {subject} is unaffected.',
    'note.yield.earlyByUser': 'The first wait ended early: a user message arrived (about {elapsedMs} ms in); the {subject} itself is unaffected and the background task keeps running.',
    'note.yield.budgetUnverified': 'The {subject} outlived the {yieldMs} ms first wait (about {elapsedMs} ms elapsed), but the follow-up check could not confirm its current state — the job list read failed or the job is no longer listed. It may have settled; use the handle below to re-check instead of assuming it is still running.',
    'note.yield.userUnverified': 'The first wait ended early: a user message arrived (about {elapsedMs} ms in); ending the wait did not stop the {subject}. The follow-up check could not confirm its current state — use the handle below to re-check instead of assuming it is still running.',
    'note.yield.unverified': 'The follow-up check could not confirm the {subject}\'s current state (the job list read failed or the job is no longer listed); it may have settled — use the handle below to re-check instead of assuming it is still running.',
    // 取消口径（需求 §2.1.2：取消与预算到期分别说明——被取消不等同于超出预算）。
    'note.yield.cancelled': 'The call was cancelled during the first wait (about {elapsedMs} ms of the {yieldMs} ms budget); the {subject} was not terminated by the cancellation.',
    'note.waitAgain': 'Waited {waitedMs} ms; the job is still running (unaffected). You can work on other things and call async_wait_job(job_id="{jobId}", wait_ms=...) later; per-call wait cap is {maxWaitMs} ms.',
    'note.agentWaitAgain': 'Waited {waitedMs} ms; the subagent has not finished yet (unaffected, still running). You can work on other things and call async_wait_agent(agent_id="{agentId}", wait_ms=...) later; per-call wait cap is {maxWaitMs} ms.',
    // 到期/收敛后的复查读取失败（需求 §2.2.2：无法证实时不得宣称目标仍在运行）——
    // 与确认仍在运行的 waitAgain 分开；只陈述未证实并给重试出路。
    'note.recheckFailed': 'Waited {waitedMs} ms; the follow-up status check could not confirm this job\'s state (the job list read failed, or the job is no longer listed for this caller), so it is unverified — the job may have settled in the meantime. Call async_wait_job(job_id="{jobId}", wait_ms=...) again to re-check; per-call wait cap is {maxWaitMs} ms.',
    'note.agentRecheckFailed': 'Waited {waitedMs} ms; the follow-up status check could not observe the subagent, so its current state is unverified — it may have stopped running. Call async_wait_agent(agent_id="{agentId}", wait_ms=...) again to re-check; per-call wait cap is {maxWaitMs} ms.',
    'note.interrupted': 'Wait interrupted: a user message has arrived and will appear in your next input (waited {waitedMs} ms). Ending the wait did not stop {subject}. Handle the user message first; to resume waiting later, call {resume} again.',
    'note.interruptedPreexisting': 'Wait not started: a user message had already arrived before this wait began and will appear in your next input. Ending the wait did not stop {subject}. Handle the user message first; to wait later, call {resume} again.',
    'note.cancelled': 'The wait was cancelled after {waitedMs} ms; the cancellation did not stop {subject} — ending a wait never stops the background work. To wait again later, call {resume}.',
    'note.cancelledPreexisting': 'The call was cancelled before the wait began; the cancellation did not stop {subject} — ending a wait never stops the background work. To wait again later, call {resume}.',
    'note.settled': 'Subagent {agentId} is no longer observed running. Its final answer will arrive as a separate message in the conversation; it is not part of this return value.',
    'note.agentStarted': 'Subagent delegated in the background. When you need its result, wait with async_wait_agent(agent_id="{agentId}", wait_ms={defaultWaitMs}) (an example wait value; wait_ms is still required and errors when omitted); a user steer interrupts the wait while the subagent keeps running. Its final answer arrives as its own message in the conversation; list_agents shows progress at any time. ',
    // 静默失败防线（需求 §6.3）：签名 1 条件式 + 签名 2 直陈式，两键只在开关开时出。
    'note.silentCapture': 'Silent-failure guard: the command matched a capture form and settled with empty output under the restricted sandbox. If the output you expected is missing, the command may have been killed at process creation before anything ran — treat it as "did not run", not "ran with no output". Retry it once as a bare call to verify; to keep the capture form, retry the same command with sandbox_permissions.',
    'note.silentDenied': 'Silent-failure guard: the output matches the visible denial signature of this deployment\'s restricted sandbox. Retry the command once as a bare call to see the underlying error; to keep the original command as-is, retry it with sandbox_permissions.',

    // ── 路由回执（async_agent 的 note 末行） ───────────────────────────
    'route.requested': 'Child LLM route: {provider}/{model} (requested).',
    'route.inherits': 'Child LLM route: inherits parent route.',
    'route.inherited': 'Child LLM route: {route} (inherited from this agent).',

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
    // 终态状态行（需求 §2.2.2：终态在模型可见文本中区分 completed/failed/killed，
    // 不依赖可选详情；状态提示不占 maxResultChars 内容预算）。
    'render.jobStatus.completed': '[job completed]',
    'render.jobStatus.failed': '[job failed]',
    'render.jobStatus.killed': '[job killed]',
    'render.readFailed': '[reading the job output failed; the output below is empty — call async_wait_job again to retry]',
    'render.agentStarted': 'async_agent started.\nagent_id="{agentId}"\n',
    'render.notFound': 'unknown subagent "{agentId}". Known children:\n{children}',

    // ── 作业结局 detail ───────────────────────────────────────────────
    'detail.exitCode': 'exit code: {code}',
    'detail.signal': 'signal: {signal}',
    'detail.lossy': 'output partially dropped from memory',
    'detail.lossyNone': '; no spill file reported',
    'detail.lossyAt': '; full output at {paths}',
    'detail.userArrivedFinished': '(a user message arrived during the wait; the job finished in the meantime)',
    // 编排完成支的作业 detail（随完成快照进入 async_wait_job 的终态读取文本）。
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
    'error.noAgentRun': 'async-tools: async_run must be called from a model turn — it registers the command as an owned background job whose completion notice is the recovery channel, and there is no agent context here. For a one-off synchronous command, use a session whose preset provides a synchronous shell.',
    'error.noAgentWorkflow': 'async-tools: async_workflow must be called from a model turn — it registers the orchestration as an owned background job whose completion notice is the recovery channel, and there is no agent context here. For a one-off orchestration, use a session whose preset provides the native workflow entry.',
    'error.workflowEngineMissing': 'async-tools: the workflowEngine service is not available in this composition — load a workflow engine provider (e.g. @deepseek-ai/dsh-workflow-ptc) inside the delegation group.',
    'error.workflowEmptyName': 'async-tools: meta.name must be a non-empty string — it becomes the job label shown in job listings (short kebab-case is customary)',
    'error.currentLimit': ' (current limit: {limit})',
    'error.noLiveJobs': 'No other live jobs were found.',
    'error.liveJobs': 'Live jobs: {jobs}.',
    'error.unknownJob': 'unknown job "{jobId}"; call job_list to see live job ids',
    'error.queryFailed': 'async-tools: reading the job list failed (the job may still exist); retry async_wait_job later — this is not "unknown job"',
    // wait_ms 缺省的必填参数错误（经 execute 抛给模型，需求 §2.1.1/§5.3 双语）。
    'error.waitRequired': 'wait_ms is required and bounded: pass an explicit budget between {minWaitMs} and {maxWaitMs} ms',
    'error.listingUnavailable': 'subagent listing unavailable; cannot observe subagent state',
    'error.requiresAgent': 'async_agent requires an initiator agent; this tool must run inside an agent-driven session',
    'error.unsupportedArgs': 'async_agent got unsupported argument(s): {keys} — supported: {supported}; for other delegation options, follow the host rules and use a new session whose preset provides them',
    'error.pairTogether': 'child LLM `provider` and `model` must be supplied together',
    'error.providerNonEmpty': 'child LLM `provider` must be non-empty',
    'error.modelNonEmpty': 'child LLM `model` must be non-empty',
    'error.noPolicy': 'child model selection is not available for this session (no model-selection policy)',
    'error.routeNotAllowed': 'child LLM route "{provider}/{model}" is not allowed for this session',
    'error.providerNotRegistered': 'subagent provider "{provider}" is not registered — check the async-tools setting \'subagentProvider\' (the default is "spawn")',
    'error.noContinuable': 'subagent provider "{provider}" does not support background delegation (missing prepareContinuable)',
    'error.noAgentOptions': 'subagent provider "{provider}" does not honor agentOptions — the requested route would be silently ignored',

    // ── c 防线常驻纪律段（需求 §6.3，宿主侧 systemPrompt 注入） ───────────
    'discipline.block': 'Execution discipline for this deployment (pwsh under a restricted sandbox):\n1. Captured commands can die silently. A command in capture form (2>&1, $(...), a variable assignment, or output redirection >) can be killed at process creation under the restricted sandbox: nothing executes and the capture stays empty. Telltale signs: empty output, no [exit code] marker, $LASTEXITCODE unset. Treat that as "the command did not run", never as "it ran and printed nothing". When in doubt, run it once as a bare call (bare calls are reliable); to keep the capture form, retry the same command with sandbox_permissions.\n2. Some deployments run a local antivirus rule that kills hidden PowerShell launches at process creation (it matches a standalone -W/-w switch or -WindowStyle Hidden in the command line). That exact pattern — exit code 4294967295 with no other output — means the whole pwsh died before any statement ran; elevation does not help. Rewrite the command instead (-Width, or pass the value through a variable).',

    // ── 提问接管（需求 §4.1/§4.4：超时合成与迟到注入的模型侧文案） ─────
    // 迟到注入是通知形（followup + 自声明 kind）：正文自含完整题目内容（用户决定）——压缩或长对话后模型不依赖对原工具调用的记忆即可行动。
    'ask.timeoutCustom': 'The user has not answered within {seconds} s: proceed with your best judgment. If the user answers later, the answer arrives as a notice while its record is kept (up to 24 h after expiry; a swept record, an agent that can no longer receive it, or a failed delivery means it will not arrive).',
    'ask.windowSkip': 'The user chose to skip this question while the pending window was open.',
    'ask.lateAnswer': '[Late answer] The user answered the pending question after the timeout.\nQuestion id: {qid}\nQuestion: {question}\nOptions (multiSelect={multiSelect}): {options}\nAnswer: {answer}\nDelay: {delay} s after the question was asked.',
    'ask.lateIgnore': '[Late answer] The user chose not to answer the pending question after the timeout.\nQuestion id: {qid}\nQuestion: {question}\nOptions (multiSelect={multiSelect}): {options}\nDecision: not answered\nDelay: {delay} s after the question was asked.',
    'ask.lateSummary': 'Late answer for {qid}: {answer}',
    'ask.lateIgnoreSummary': 'Late skip for {qid}',
    'ask.lateCustomSuffix': ' (custom note: {custom})',
    'wait.lateArrived': 'A late answer has arrived ({summary}); the notice will enter your context at the next claim point. This wait did not stop the target.',
    'wait.wokeByMessage': 'A processable message arrived ({summary}); it will enter your context at the next claim point. This wait did not stop the target.',
    'wake.noSummaryFallback': 'a relayed child message (no summary provided)',
    // 带来源身份的回退文案：宿主契约里 relay / 结算通知的
    // source 恒带 senderSessionId（服务侧推导的归属，非权限）——有它就点名。
    'wake.noSummaryFrom': 'a relayed child message from {sender} (no summary provided)',
    // 降级警示段（需求 §5.1 模型可见侧）：前导 \n\n 自带；{detail} 是自检失败原文（数据，不翻译）。
    'desc.degraded': '\n\n[async-tools] Live config self-check failed ({detail}); until the settings are corrected, the numbers above are the last valid values and settings edits do not take effect. Fixing and saving on the settings page clears this warning automatically.',
    'via.noResident': 'The subagent is no longer resident in the agent registry (it is no longer observed running).',
    'ask.lateReminder': '[Reminder] A late-answer notice is pending; it will enter your context in the turn now opening.',
    'ask.lateReminderSummary': 'Late-answer claim reminder',
  },

  zh: {
    'digest.yield': '首次等待默认 {defaultYieldMs} ms（可传 yield_ms，范围 {minYieldMs}–{maxYieldMs} ms）；超过首次等待的命令不会被杀死——它转入后台并返回作业编号（job_id）。',
    'digest.wait': '单次等待预算必须显式传入，范围 {minWaitMs}–{maxWaitMs} ms；',

    'tool.run.p1': '以首次等待预算运行一条 PowerShell 命令。 ',
    'tool.run.p2': '若命令在 {defaultYieldMs} ms 的默认首次等待内结束，你会拿到完整输出，与普通命令工具一样；若超出首次等待，命令不会被杀死——你立即得到一个作业编号（job_id），后台任务继续运行。Agent 可以继续其他工作，之后用 async_wait_job 读取输出。首次等待期间用户发来新消息（或停止本轮）只结束等待、绝不终止命令：你会立刻拿到作业编号，后台任务继续运行，结算时一条完成通知会送达。与内置 pwsh 的差别：内置前台模式会在截止时杀死进程树；本工具只是首次等待。 ',
    'tool.run.p3': '首次等待限定在 {minYieldMs}–{maxYieldMs} ms；',
    // b 防线警示段（需求 §6.3）：只在「有约束执行器 且 开关开」时拼到 async_run 描述尾部；前导 \n\n 自带。
    'tool.run.warnCapture': '\n\n注意（本部署）：带捕获形（2>&1、$(...)、变量赋值或输出重定向）的命令在受限沙箱下可能在进程创建层被杀——什么都没执行，捕获结果为空。下结论「没有输出」之前，先裸调用验证一次。',

    'tool.wait_job.p1': '有界等待一个由 `async_run` 启动的后台作业结束，然后返回其输出。 ',
    'tool.wait_job.p2': 'wait_ms 必填，范围 {minWaitMs}–{maxWaitMs} ms。',
    'tool.wait_job.p3': '等待期间，一条**插话（steering）**用户消息（会进入你的下一条输入）立即返回 status:"interrupted"——**作业不受影响，继续在后台运行**；**排队（queued）**消息（只在本轮结束后送达）不会打断等待。等待开始**前**已到达的插话经入口检查同样立即返回 status:"interrupted"。 ',
    'tool.wait_job.p4': '预算到期时你会得到 status:"running"；再次调用本工具即可。 ',
    'tool.wait_job.p5': '读取后台输出的既定途径就是本工具。 ',
    'tool.wait_job.coverage': ' wait_ms 预算约束的是本次调用的总时长：一次存在性快照加上等待段本身。',

    'tool.wait_agent.p1': '有界等待一个后台子代理结束。 ',
    'tool.wait_agent.p2': 'wait_ms 必填，范围 {minWaitMs}–{maxWaitMs} ms。 ',
    'tool.wait_agent.p3': '等待期间，一条**插话（steering）**用户消息（会进入你的下一条输入）立即返回 status:"interrupted"——**子代理不受影响，继续运行**；**排队（queued）**消息（只在本轮结束后送达）不会打断等待。等待开始**前**已到达的插话经入口检查同样立即返回 status:"interrupted"。 ',
    'tool.wait_agent.p4': 'status:"settled" 的含义是「本次等待期间不再观察到它在运行」（权威信号是结算通知与状态转为 idle）；它不保证最终回答已经到达。最终回答会作为独立消息出现在对话里，不在本返回值中；若你确实需要它的结论，继续做别的事，消息会到达你。 ',
    'tool.wait_agent.p5': '预算到期时你会得到 status:"running"；再次调用即可。 ',
    'tool.wait_agent.p6': '若子代理在本调用之前就已结束，入口检查会观察到它——注册表状态已转为 idle、不再驻留，或有一条未领取的结算通知——并立即返回 status:"settled"，而不是等满预算。它的结算通知与最终回答会作为独立消息出现在对话里。子代理目录只显示哪些子代理存在；再次调用本工具前先查看那条通知或 list_agents。 ',
    'tool.wait_agent.coverage': ' wait_ms 预算约束的是本次调用的总时长：存在性屏障（至多 3 × {pollIntervalMs} ms 重试）加上等待段本身。',

    'tool.agent.p1': '把一个自包含任务委托给一个**新的**后台子代理；立即返回其 agent_id。 ',
    'tool.agent.p2': '构造上就是纯后台：没有 run_in_background 参数，它从不等待、从不轮询。 ',
    'tool.agent.p3': '经配置的子代理后端派生（当前：{provider}）。 ',
    'tool.agent.p4': '可选地同时提供 provider 与 model 来选择子代理的 LLM 路由（会对照本会话的模型选择策略校验）；两者都不传则继承父路由。 ',
    'tool.agent.p5': '子代理看不到本对话——请给一份完整、自包含的任务书。 ',
    'tool.agent.p6': '用 async_wait_agent(agent_id=..., wait_ms=...) 读取结果：有界；用户插话会打断等待而子代理继续运行；它的最终回答会作为独立消息到达。 ',

    // ── async_workflow（zh 档受控中文，与 en 档同义）───────────────
    'tool.workflow.p1': '运行一段 JavaScript workflow 脚本，大规模编排子代理。适用于需要向许多独立部分铺开的工作——对大量文件的审计、一项迁移、多角度调研、对发现的对抗性核查——这类工作你把编排写成脚本，而不是逐回合委托。\n\nworkflow 的身份信息以 JSON 形式放在 `meta` 参数：必填 `name`（短 kebab-case）与 `description` 字符串，可选 `whenToUse` 字符串与 `phases` 数组（`{title, detail?, provider?, model?}`）。`script` 参数**只是纯 JavaScript 脚本体**（不是 TypeScript，也不要 `export const meta` 语句——meta 是参数不是代码），允许顶层 await；以 `return <值>` 结尾——值必须可 JSON 序列化，它就是本工具的结果。\n\n脚本体内的钩子：\n- `agent(prompt, opts?): Promise<any>` ——把一个子代理跑到结束。不带 `opts.schema` 时按子代理的最终文本 resolve；带 `opts.schema`（只用 type/properties/required/additionalProperties/items/enum/const/oneOf 的对象根 JSON Schema——不支持 pattern/format/数值边界）时按校验后的对象 resolve。子代理失败时 resolve `null`（用 `.filter(Boolean)` 过滤）。其他 opts：`label`（展示）、`phase`（进度组）、相互独立的 `provider`/`model` LLM 目标覆盖（可只传其一）。其他选项（`effort`/`isolation`/`agentType`）一律报错拒绝。\n- `pipeline(items, ...stages): Promise<any[]>` ——每个条目独立流过各阶段，阶段之间没有屏障（多阶段工作优先用它）。每个阶段收到 `(prev, item, index)`。普通阶段抛错只把该条目降为 `null` 并跳过其余阶段。\n- `parallel(thunks): Promise<any[]>` ——并发运行零参函数并全部 await（屏障；仅当某一步真的需要全部前序结果时才用）。抛错的 thunk resolve 为 `null`。\n- `phase(title)` ——开始一个进度阶段；`log(message)` ——叙述进度；`args` ——本次调用的 `args` 输入原样。\n\n误用的钩子（坏参数、未知选项、不支持的 schema、触发上限）抛出的错误**总是终止整个脚本**——不会化成单个条目的 `null`。\n\n约束：并发与子代理总量上限适用；不提供文件系统、网络、定时器或 Node.js API——子代理干活，脚本只做协调。 ',
    'tool.workflow.p2': '仅在用户明确要求 workflow 或大规模多代理编排时使用本工具；一两个委托用 async_agent。编排**永远是后台作业**——没有 run_in_background 参数。若在 {defaultYieldMs} ms 默认首次等待内结算，你会拿到完整结果，与前台调用一样；若超出首次等待，run 不会被取消——你立即得到一个作业编号（job_id），后台任务继续运行。Agent 可以继续其他工作，之后用 async_wait_job 读取结果。首次等待期间用户发来新消息（或停止本轮）只结束等待、绝不终止 run：你会立刻拿到作业编号，后台任务继续运行，结算时一条完成通知会送达。要真正取消一个编排，用 job_kill 停掉它。',

    'param.run.command': '要执行的 PowerShell 命令。',
    'param.run.description': '用主动语态简洁描述这条命令做什么，5-10 个词。',
    'param.run.yield_ms': '首次等待（毫秒），范围 {minYieldMs}-{maxYieldMs}。默认 {defaultYieldMs}。到期后命令继续在后台运行，并返回作业编号（job_id）。',
    'param.run.workdir': '工作目录。默认取会话工作目录。',
    'param.run.sandbox_permissions': '这条命令需要的更宽沙箱模式。只在对刚被沙箱拒绝的命令做同轮一次性重试时有效；需要说明理由并经用户批准。',
    'param.run.justification': '与 sandbox_permissions 一起必填：向用户解释为什么这条命令需要更宽权限的一句话。',
    'param.wait_job.job_id': '`async_run` 返回的作业 id（例如 "async-command-3"）。',
    'param.wait_job.wait_ms': '必填的单次等待预算（毫秒），范围 {minWaitMs}-{maxWaitMs}。',
    'param.wait_agent.agent_id': '派生时返回的子代理 id（list_agents 可查看 id）。',
    'param.wait_agent.wait_ms': '必填的单次等待预算（毫秒），范围 {minWaitMs}-{maxWaitMs}。',
    'param.agent.description': '3-5 个词的展示标签。',
    'param.agent.prompt': '交给子代理的完整、自包含任务书（它看不到本对话）。',
    'param.agent.provider': '子代理的 LLM provider 路由。与 model 一起提供；两者都不传则继承父路由。',
    'param.agent.model': '该 provider 下的精确模型 id。与 provider 一起提供；两者都不传则继承父路由。',
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
    'param.workflow.yield_ms': '首次等待（毫秒），范围 {minYieldMs}-{maxYieldMs}。默认 {defaultYieldMs}。到期后编排继续在后台运行，并返回作业编号（job_id）。',

    'subject.command': '命令',
    'subject.workflow': '工作流',
    'note.yield.running': '{subject}仍在运行：它超出了 {yieldMs} ms 的首次等待（已运行约 {elapsedMs} ms）。它没有被终止；后台任务继续运行。',
    'note.yield.keepWorking': '继续做别的事；不要空等。需要输出时调用：',
    'note.yield.cap': '单次等待上限为 {maxWaitMs} ms；若返回 status:"running"，再次调用即可——{subject}不受影响。',
    'note.yield.earlyByUser': '首次等待提前结束：有用户消息到达（已运行约 {elapsedMs} ms）；{subject}本身不受影响，后台任务继续运行。',
    'note.yield.budgetUnverified': '{subject}超出了 {yieldMs} ms 的首次等待（已运行约 {elapsedMs} ms），但随后的状态复查未能确认它的当前状态——读取作业列表失败，或该作业已不在可见清单里。它可能已经结算；请用下面的句柄复查，不要按"仍在运行"处理。',
    'note.yield.userUnverified': '首次等待提前结束：有用户消息到达（已运行约 {elapsedMs} ms）；结束等待没有终止{subject}。随后的状态复查未能确认它的当前状态——请用下面的句柄复查，不要按"仍在运行"处理。',
    'note.yield.unverified': '随后的状态复查未能确认{subject}的当前状态（读取作业列表失败，或该作业已不在可见清单里）——它可能已经结算；请用下面的句柄复查，不要按"仍在运行"处理。',
    // 取消口径（需求 §2.1.2：取消与预算到期分别说明——被取消不等同于超出预算）。
    'note.yield.cancelled': '调用在首次等待期间被取消（预算 {yieldMs} ms，已运行约 {elapsedMs} ms）；取消没有终止{subject}。',
    'note.waitAgain': '已等待 {waitedMs} ms；作业仍在运行（不受影响）。你可以先做别的事，稍后调用 async_wait_job(job_id="{jobId}", wait_ms=...)；单次等待上限为 {maxWaitMs} ms。',
    'note.agentWaitAgain': '已等待 {waitedMs} ms；子代理尚未结束（不受影响，仍在运行）。你可以先做别的事，稍后调用 async_wait_agent(agent_id="{agentId}", wait_ms=...)；单次等待上限为 {maxWaitMs} ms。',
    // 到期/收敛后的复查读取失败（需求 §2.2.2：无法证实时不得宣称目标仍在运行）——
    // 与确认仍在运行的 waitAgain 分开；只陈述未证实并给重试出路。
    'note.recheckFailed': '已等待 {waitedMs} ms；随后的状态复查无法确认该作业的状态（读取作业列表失败，或该作业已不在本调用方可见的清单里），当前状态未证实——它可能已经结算。请再次调用 async_wait_job(job_id="{jobId}", wait_ms=...) 复查；单次等待上限为 {maxWaitMs} ms。',
    'note.agentRecheckFailed': '已等待 {waitedMs} ms；随后的状态复查未能观察到该子代理，其当前状态未证实——它可能已停止运行。请再次调用 async_wait_agent(agent_id="{agentId}", wait_ms=...) 复查；单次等待上限为 {maxWaitMs} ms。',
    'note.interrupted': '等待被打断：一条用户消息已到达，将出现在你的下一条输入里（已等待 {waitedMs} ms）。结束等待没有终止 {subject} 的工作。先处理用户消息；之后要恢复等待，再次调用 {resume} 即可。',
    'note.interruptedPreexisting': '等待未开始：一条用户消息在本次等待开始前就已到达，将出现在你的下一条输入里。结束等待没有终止 {subject} 的工作。先处理用户消息；之后要恢复等待，再次调用 {resume} 即可。',
    'note.cancelled': '本次等待在 {waitedMs} ms 后被取消；取消没有终止 {subject} 的工作——结束等待从不停止后台工作。之后要继续等待，再次调用 {resume} 即可。',
    'note.cancelledPreexisting': '本次调用在等待开始前已被取消；取消没有终止 {subject} 的工作——结束等待从不停止后台工作。之后要继续等待，再次调用 {resume} 即可。',
    'note.settled': '子代理 {agentId} 不再被观察到在运行。它的最终回答会作为独立消息出现在对话里；不在本返回值中。',
    'note.agentStarted': '子代理已在后台派生。需要结果时，用 async_wait_agent(agent_id="{agentId}", wait_ms={defaultWaitMs}) 等待（wait_ms 为等待示例值，仍必填、省略时报错）；用户插话会打断等待而子代理继续运行。它的最终回答会作为独立消息出现在对话里；list_agents 随时可查看进展。 ',
    // 静默失败防线（需求 §6.3）：签名 1 条件式 + 签名 2 直陈式，两键只在开关开时出。
    'note.silentCapture': '静默失败防线：命令带捕获形，且在受限沙箱下结算输出为空。若你预期的输出缺失，命令可能在进程创建层被杀、一条语句都没跑——按「没跑」处理，不是「跑了没输出」。可裸调用重试一次验证；要保留捕获形，请带 sandbox_permissions 重试同一条命令。',
    'note.silentDenied': '静默失败防线：输出与本部署受限沙箱的可见拒绝签名一致。请裸调用重试一次看真实报错；要保留原命令，请带 sandbox_permissions 重试。',

    'route.requested': '子代理 LLM 路由：{provider}/{model}（按请求）。',
    'route.inherits': '子代理 LLM 路由：继承父路由。',
    'route.inherited': '子代理 LLM 路由：{route}（继承自本代理）。',

    'render.truncated': '[输出已截断：省略 {omitted} 字符]',
    // 编排结算渲染头（需求 §2.4/§2.2.3）：en 档与宿主 renderResult 同形；
    // 截断走 output.truncate 保首尾（标记在正文中），本键只承担头部说明。
    'render.workflowCompleted': 'workflow「{name}」已完成（{count} 个子代理）。\n返回值：\n',
    'render.exitCode': '[退出码: {code}]',
    'render.killedBySignal': '[被信号杀死: {signal}]',
    'render.spillDisk': '[部分输出超出了 shell 的内存上限；完整输出在磁盘上——{paths}]',
    'render.spillNone': '[部分输出超出了 shell 的内存上限并被丢弃；没有报告落盘文件；如需该输出，请重跑命令并把输出重定向到文件]',
    'render.lossyPrefix': '[更早的输出已部分从内存中丢弃]',
    // 终态状态行（需求 §2.2.2：终态在模型可见文本中区分 completed/failed/killed，
    // 不依赖可选详情；状态提示不占 maxResultChars 内容预算）。
    'render.jobStatus.completed': '[作业已完成]',
    'render.jobStatus.failed': '[作业失败]',
    'render.jobStatus.killed': '[作业已终止]',
    'render.readFailed': '[读取该作业的输出失败；下方输出为空——可再次调用 async_wait_job 重试]',
    'render.agentStarted': 'async_agent 已启动。\nagent_id="{agentId}"\n',
    'render.notFound': '未知的子代理 "{agentId}"。已知子代理：\n{children}',

    'detail.exitCode': '退出码: {code}',
    'detail.signal': '信号: {signal}',
    'detail.lossy': '输出已部分从内存丢弃',
    'detail.lossyNone': '；没有报告落盘文件',
    'detail.lossyAt': '；完整输出在 {paths}',
    'detail.userArrivedFinished': '（等待期间到达了一条用户消息；作业在此期间结束了）',
    // 编排完成支的作业 detail（随完成快照进入 async_wait_job 的终态读取文本）。
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
    'error.noAgentRun': 'async-tools: async_run 必须在模型回合内调用——它把命令注册为有主后台作业（完成通知是恢复通道），而当前没有 agent 语境。需要一次性同步命令时，请在提供同步 shell 的预设会话中使用。',
    'error.noAgentWorkflow': 'async-tools: async_workflow 必须在模型回合内调用——它把编排注册为有主后台作业（完成通知是恢复通道），而当前没有 agent 语境。需要一次性编排时，请在提供原生编排入口的预设会话中使用。',
    'error.workflowEngineMissing': 'async-tools: 当前组合里没有 workflowEngine 服务——请在 delegation 组内装载 workflow 引擎提供方（例如 @deepseek-ai/dsh-workflow-ptc）。',
    'error.workflowEmptyName': 'async-tools: meta.name 必须是非空字符串——它将成为作业列表里展示的作业标签（惯例为短 kebab-case）',
    'error.currentLimit': '（当前上限: {limit}）',
    'error.noLiveJobs': '没有找到其他存活的作业。',
    'error.liveJobs': '存活的作业：{jobs}。',
    'error.unknownJob': '未知作业 "{jobId}"；调用 job_list 查看存活的作业 id',
    'error.queryFailed': 'async-tools: 读取作业列表失败（该作业可能仍在）；请稍后重试 async_wait_job——这不是「未知作业」',
    // wait_ms 缺省的必填参数错误（经 execute 抛给模型，需求 §2.1.1/§5.3 双语）。
    'error.waitRequired': 'wait_ms 必填且有界：请显式传入 {minWaitMs}–{maxWaitMs} ms 范围内的单次等待预算',
    'error.listingUnavailable': '子代理列表不可用；无法观察子代理状态',
    'error.requiresAgent': 'async_agent 需要一个发起 agent；本工具必须在 agent 驱动的会话内运行',
    'error.unsupportedArgs': 'async_agent 收到不支持的参数：{keys} —— 支持的参数：{supported}；需要其他委托选项时，请按宿主规则在提供这些选项的预设新会话中使用',
    'error.pairTogether': '子代理 LLM 的 `provider` 与 `model` 必须一起提供',
    'error.providerNonEmpty': '子代理 LLM 的 `provider` 必须非空',
    'error.modelNonEmpty': '子代理 LLM 的 `model` 必须非空',
    'error.noPolicy': '本会话的子代理模型选择不可用（没有模型选择策略）',
    'error.routeNotAllowed': '子代理 LLM 路由 "{provider}/{model}" 不被本会话允许',
    'error.providerNotRegistered': '子代理后端 "{provider}" 未注册——请检查 async-tools 的设置项 \'subagentProvider\'（默认是 "spawn"）',
    'error.noContinuable': '子代理后端 "{provider}" 不支持后台委托（缺少 prepareContinuable）',
    'error.noAgentOptions': '子代理后端 "{provider}" 不处理 agentOptions——请求的路由会被静默忽略',

    // ── c 防线常驻纪律段（需求 §6.3，宿主侧 systemPrompt 注入） ───────────
    'discipline.block': '本部署执行纪律（受限沙箱下的 pwsh）：\n1. 捕获形命令会静默死。带捕获形（2>&1、$(...)、变量赋值或输出重定向 >）的命令在受限沙箱下可能在进程创建层被杀：什么都没执行，捕获结果为空。判别特征：输出为空、无 [exit code] 标记、$LASTEXITCODE 为空。按「命令没跑」处理，绝不当「跑了没输出」。存疑就裸调用重试一次（裸调用可靠）；要保留捕获形，请带 sandbox_permissions 重试同一条命令。\n2. 部分部署的本机杀毒软件会在进程创建层击杀隐藏执行的 PowerShell（按命令行文本命中独立的 -W/-w 开关或 -WindowStyle Hidden）。命中这一确切形态——退出码 4294967295 且无其他输出——时，整个 pwsh 在任何语句运行前就死掉了；提权无用。应改写命令（-Width、或经变量传值）。',

    // ── 提问接管（需求 §4.1/§4.4：超时合成与迟到注入的模型侧文案） ─────
    // 迟到注入是通知形（followup + 自声明 kind）：正文自含完整题目内容（用户决定）——压缩或长对话后模型不依赖对原工具调用的记忆即可行动。
    'ask.timeoutCustom': '用户暂未应答（等待 {seconds} 秒超时）：请按你的最佳判断继续。用户稍后作答时，答案会在记录保留期内以通知送达（自到期起保留 24 小时，超龄记录会被清扫；记录已清扫、主体无法接收或投递失败时不会送达）。',
    'ask.windowSkip': '用户在等待窗口内选择跳过本题。',
    'ask.lateAnswer': '[迟到应答] 用户在超时后回答了挂起的问题。\n问题 id：{qid}\n题干：{question}\n选项（multiSelect={multiSelect}）：{options}\n作答：{answer}\n时延：提问后 {delay} 秒。',
    'ask.lateIgnore': '[迟到应答] 用户在超时后选择不答挂起的问题。\n问题 id：{qid}\n题干：{question}\n选项（multiSelect={multiSelect}）：{options}\n决定：不作答\n时延：提问后 {delay} 秒。',
    'ask.lateSummary': '问题 {qid} 的迟到作答：{answer}',
    'ask.lateIgnoreSummary': '问题 {qid} 的迟到跳过',
    'ask.lateCustomSuffix': '（补充说明：{custom}）',
    'wait.lateArrived': '迟到作答已到（{summary}）；通知将在下一领取点进入你的上下文。本次等待没有终止目标的工作。',
    'wait.wokeByMessage': '一条可处理消息已到（{summary}）；它将在下一领取点进入你的上下文。本次等待没有终止目标的工作。',
    'wake.noSummaryFallback': '子代理转达消息（未附摘要）',
    // 带来源身份的回退文案（同 en 档注释）。
    'wake.noSummaryFrom': '来自子代理 {sender} 的转达消息（未附摘要）',
    // 降级警示段（需求 §5.1 模型可见侧）：前导 \n\n 自带；{detail} 是自检失败原文（数据，不翻译）。
    'desc.degraded': '\n\n[async-tools] 生效配置自检失败（{detail}）；设置改正前，上文数字均为上一合法值、设置页改动不生效。在设置页改正并保存后，本警示自动消失。',
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
