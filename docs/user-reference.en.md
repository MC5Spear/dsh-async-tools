# User reference

[中文](<user-reference.md>) · [English home](<../README.en.md>)

## 1. Installation identity and prerequisites

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.7+dsh.0.2.1-rc.4` |
| Exact dsh host version | `0.2.1-rc.4` |

If the installation address does not yield the source, check the repository address and pinned commit, then the network or proxy. If it still fails, contact the maintainer who supplied the installation source about available installation artifacts.

The source repository spec is `github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1-rc.4`. That branch moves; use the verified full commit `ca8f65b39b7694f9e5a2b28cca7a29bc43485ecc` for reproducibility. The package is not distributed through npm. An unqualified GitHub spec does not select the right host adaptation.

Check the runtime before installing. Node.js 24 is recommended. The plugin's `>=20` declaration applies only to the plugin. The host's commander 15 dependency requires `>=22.12.0`, but this is only a known lower bound, not a verified minimum for the complete host. Confirm that the target host's dependencies resolve on the chosen runtime.

This line targets Windows, with full target-host revalidation still pending. Linux command execution and one-shot escalation, macOS, and remote execution are unverified. Send the maintainer your environment and intended use, then arrange isolated verification before deciding to deploy there. The rc4 adaptation does not mean every behavior has passed verification on rc4.

After checking these prerequisites, install from a terminal:

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1-rc.4
```

Alternatively, in DSH's plugin manager, open the install dialog and paste the GitHub spec above into the installation address. When installation finishes, open this package's detail page and check that its settings form is visible. Create a session and confirm that `dsh-async` and `dsh-async-create` are available. After selecting either preset, the Agent should have the six tools documented here.

If both tools and settings are missing:

1. Compare the exact DSH version with this section's identity table.
2. Inspect host load logs to see whether a version mismatch caused the package to be skipped.
3. In the target profile, check both the dependency registration (installed package) and the bundle registration (host-row and preset composition declarations). They serve different purposes; one registration alone does not establish that every entry loaded.
4. After composition or client-entry changes, reload the instance and reopen the page. Arrange for active sessions to finish safely before restarting, and restart outside the service process tree. Ordinary settings saves need no restart.

Development links are for an explicit development environment. Keep stable deployments separate from the editing tree. Prepare the source as follows:

```powershell
git clone https://github.com/MC5Spear/dsh-async-tools.git
cd dsh-async-tools
git checkout adapt/dsh-0.2.1-rc.4
npm install
dsh plugin --profile web add <absolute-clone-directory>
```

The linked directory must resolve matching host dependencies. A bare Node import checks only part of module resolution; it does not establish complete host-service, tool, or page integration.

## 2. First use and settings

Choose `dsh-async` for general coding or `dsh-async-create` to retain plugin and preset authoring tools. Both presets expose all six tools directly. Inspection, messaging, and explicit stopping remain host management operations. Existing presets are unchanged.

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless test marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=1000)
async_wait_job(job_id="<returned job_id>", wait_ms=30000)
```

These are Agent tool calls, not terminal commands. The short command should return `SHORT_OK` directly. The long command will usually return a job identifier, `job_id`, after its first wait. Keep it and continue independent work. Read the result with `async_wait_job` when needed, explicitly supplying `wait_ms` every time. Even after seeing `LONG_DONE`, inspect exit information. Do not repeat the command to check progress.

Open the plugin list, select this package, and use the form between its description and component rows. Writes require the host's local loopback settings endpoint. If the page is read-only or accessed through a non-loopback address, follow its guidance to a writable endpoint. Editing creates a draft; Save applies it. Restoring defaults also requires Save. Leaving discards unsaved drafts; a failed save retains them. Expanding field help does not submit settings.

A field's Restore default action stages removal of only that field's user override. Save applies the removal; other fields' overrides are unchanged. The field then uses the host composition's configured value, falling back to the factory default in the table only when the composition has no value. It does not forcibly write the table's default. With a valid configuration, check after saving that the field is no longer marked Overridden and that its value is what you expect. For example, a composition value of `45000` overridden with `90000` returns to `45000`, not `20000`. If a degraded-mode warning remains, follow the recovery guidance after the table; restoring an override is not proof that a damaged configuration is repaired.

For advanced configuration, put fields under the host row's `config.settings.<field>`, not directly under `config`. Values are selected in this order: user override, composition configuration, then schema default (the default in the configuration definition). A user-layer field counts as an override even when its value equals the default.

Tools first read the current configuration snapshot published by the host. Only if it is absent do they use valid tool-row fallback values and report that settings are not connected. `toolName`, `owningPreset`, and delegation-row options are fixed row configuration, not part of the 17 UI settings below.

### 2.1 All 17 settings

The Range column describes values that can be saved. If a call's budget falls outside the current min/max, the tool moves it to the nearest boundary; this is clamping. A new invalid configuration is rejected, not clamped. Resaving an existing damaged configuration unchanged is an exception explained after the table. Values are stored in milliseconds (ms): 1000 ms is one second.

| Field | Type | Default | Range | Unit | Takes effect |
| --- | --- | --- | --- | --- | --- |
| `defaultYieldMs` | number | `20000` | 1..2147483647; fractions allowed | ms | Next run/workflow call omitting yield_ms |
| `minYieldMs` | number | `1000` | 1..2147483647; fractions allowed | ms | Lower bound for the next initial wait |
| `maxYieldMs` | number | `600000` | 1..2147483647; fractions allowed | ms | Upper bound for the next initial wait |
| `defaultWaitMs` | number | `30000` | 1..2147483647; fractions allowed | ms | Example budget only; wait_ms remains required |
| `minWaitMs` | number | `250` | 1..2147483647; fractions allowed | ms | Lower bound for the next wait request |
| `maxWaitMs` | number | `600000` | 1..2147483647; fractions allowed | ms | Upper bound for the next wait request |
| `pollIntervalMs` | number | `500` | 1..2147483647; fractions allowed | ms | New wait's fallback state polling and existence retries |
| `maxResultChars` | integer | `30000` | 1..1000000 | JS String.length | Result rendering |
| `jobKind` | string | `async-command` | Nonempty | — | Kind identifier for new command jobs |
| `subagentProvider` | string | `spawn` | Backend name; trimmed empty value uses spawn | — | Next child creation; not an LLM provider |
| `uiLang` | enum | `auto` | auto / zh / en | — | UI; auto follows the host |
| `agentLang` | enum | `en` | en / zh | — | Language for tool descriptions, results, and instructions |
| `silentFailureGuard` | boolean | `false` | true / false | — | Command diagnostics and warnings in the two package presets |
| `askTakeover` | boolean | `false` | true / false | — | Each ordinary question request |
| `askTimeoutMs` | number | `60000` | 10000..600000; fractions allowed | ms | Initial deadline for a new intercepted batch |
| `askExtendMs` | number | `60000` | 1..2147483647; fractions allowed | ms | Each extension, added to the existing deadline |
| `askUiSeat` | enum | `sidebar` | sidebar / overlay | — | Question panel position; does not reset deadlines |

Cross-field constraints are `minYieldMs <= defaultYieldMs <= maxYieldMs`, `minWaitMs <= defaultWaitMs <= maxWaitMs`, and `pollIntervalMs <= maxWaitMs`. Budget numbers must be finite. Factory maximums are 600000. `defaultWaitMs` never supplies a missing `wait_ms` argument.

**Which values do tools use while a configuration warning is shown?** Damaged boolean values or broken cross-field constraints at startup can trigger repairable degraded mode. The form still shows the stored configuration, but tools use valid factory defaults. If a new invalid configuration arrives during operation, tools keep the previous valid values. Ordinary new invalid writes are rejected before persistence and do not replace a valid configuration. A numeric or enum schema-validation failure may instead prevent the plugin row from loading; inspect the load log and correct the fields it identifies.

**A successful save does not always mean recovery.** Resaving the existing damaged configuration unchanged may receive a success response while degraded mode, its warning, and the fallback values remain in effect. This does not allow other new invalid values to be saved.

To recover, correct all invalid fields and cross-field relationships so that the complete configuration is valid, then save. Check that the degraded-mode warning clears and that tool descriptions show the values tools actually use as expected. Do not rely on Save success or the form's Effective readout alone. If the warning remains, follow its details or the load log to continue correcting the configuration. Ordinary valid settings saves need no restart.

## 3. Tool arguments and results

Required arguments must be supplied on every call. Unknown arguments are not an arbitrary host-configuration pass-through. Budgets use the effective clamped value.

### 3.1 async_run

| Argument | Type | Required/default | Rules |
| --- | --- | --- | --- |
| `command` | string | Required | Exact command text |
| `description` | string | Required | Active-voice progress description, 5–10 words |
| `yield_ms` | number | defaultYieldMs | Finite; clamped to minYieldMs..maxYieldMs |
| `workdir` | string | Session's current effective directory | Relative paths resolve there; a started process keeps its directory |
| `sandbox_permissions` | string enum | Conditionally available | Exposed only with a constrained executor; modes come from the host tool declaration |
| `justification` | string | Required with sandbox_permissions | Explains a one-shot retry of the command just denied in the same turn |

Escalation still follows host approval. It does not authorize a different arbitrary task. Directory resolution failures are displayed before launch, without silently changing directories. When an explicit workdir fails during preparation, diagnostics retain the requested value, resolved path, session directory, the directory check at failure time, and corrective steps. ENOENT alone does not prove that the directory is missing.

Completion during the first wait returns `{status, output, truncated, exit_code?, signal?, note?}`. `completed` does not imply exit code zero; inspect the exit marker. `signal` means a process termination signal. A killed process may return `{status:'killed', detail?, output?, truncated?}`. A background handle is `{status:'running', job_id, elapsed_ms, note}`. Registration starts with execution, not when the initial wait expires.

### 3.2 async_wait_job

| Argument | Type | Required/default | Rules |
| --- | --- | --- | --- |
| `job_id` | string | Required | Original opaque job identifier |
| `wait_ms` | number | Required; no default | Clamped to minWaitMs..maxWaitMs |

Terminal results contain `{status, job_id, output, truncated, detail?}`. Terminal states are completed / killed / failed; stopping is not terminal. Wait results contain `{status, job_id, waited_ms, note}`. Missing or inaccessible jobs produce an error. A query failure calls for a retry, not a new execution. See section 4 for consuming reads.

### 3.3 async_agent

| Argument | Type | Required/default | Rules |
| --- | --- | --- | --- |
| `description` | string | Required | 3–5-word display label |
| `prompt` | string | Required | Complete task; an independent spawn child cannot see the parent conversation |
| `cwd` | string | Parent's current effective directory | Relative to that directory; later directory changes are independent |
| `provider` | string | Optional; paired with model | Nonempty exact LLM provider ID |
| `model` | string | Optional; paired with provider | Nonempty exact model ID |
| `reasoning_effort` | string | Optional | Nonempty supported effort ID; may be supplied alone |
| `agent_preset` | string | Conditionally available | Requires row-level allowedAgentPresets and independent preset support; value must be allowed |

There is no `run_in_background` argument and no wait for the final answer. Success immediately returns `{status:'started', agent_id, note}`, with the effective route source and wait guidance. Rejection does not invent an ID. The shipped presets do not configure an allowed preset set, so agent_preset is not exposed. A context-inheriting backend can expose the parent conversation to its child; write tasks according to the actual backend.

Usually, a task prompt is sufficient. To choose a model, query exact IDs as described in section 5, then supply `provider` and `model` together. `reasoning_effort` may be supplied alone but is checked against the effective model. `agentOptions`, `agentPreset`, and `allowedAgentPresets` are fixed row configuration for advanced composition, not call arguments or part of the 17 UI settings.

**When support preflight runs:** an explicit route or effort choice, or row `agentOptions` containing `provider`, `model`, or `reasoningEffort`, triggers a support check before creation. Non-route options such as `maxTokens` alone do not. Backend `agentRouteDefaults` join the merge only when preflight is triggered. Explicit arguments override row options, row options override backend defaults, and missing route components come from the parent. Allowed-set checks still apply only to explicit choices; a row default triggering preflight does not make the request explicit.

**What creation receives:** if any layer contributes options, the creation request carries the merged `agentOptions`. Otherwise it omits that field and lets the host inherit parent options, without additionally applying backend route defaults. A compatible parent effort or model default used temporarily by preflight is not copied back from the preflight result into the creation request. Actual child inheritance depends on that request and the host merge, not merely on the preflight values. When the route changes without an explicit effort, preflight does not reuse an incompatible effort from the old route.

### 3.4 async_wait_agent

| Argument | Type | Required/default | Rules |
| --- | --- | --- | --- |
| `agent_id` | string | Required | Child the caller is permitted to wait for |
| `wait_ms` | number | Required; no default | Clamped to minWaitMs..maxWaitMs |

Returns `{status, agent_id, waited_ms, note}`, or `{status:'not_found', agent_id, known_children}`. The existence check can retry for at most three pollIntervalMs ticks, within the same total budget. settled means the child is no longer observed running during this call; the final answer is a separate message. There is no answer field. For not_found, check the child directory and exact ID first. A failed query is not proof of absence; do not duplicate the delegation.

### 3.5 async_workflow

Use this only for an explicitly requested workflow or large-scale orchestration. Use async_agent for one or two delegations.

| Argument | Type | Required/default | Rules |
| --- | --- | --- | --- |
| `script` | string | Required | Plain JavaScript function body; top-level await allowed; return a JSON-serializable value |
| `meta` | object | Required | Required string name and description; optional whenToUse and phases array |
| `args` | object | Optional | Available unchanged as args; wrap a bare list in an object field |
| `yield_ms` | number | defaultYieldMs | Same clamping as run |

A short kebab-case name is recommended. Phase entries require title and optionally accept detail/provider/model strings. The current public schema allows additional meta and phase properties; a stricter requirement target is not an implemented validation claim. The script is not TypeScript or a module; do not write `export const meta`.

| Script hook | Contract |
| --- | --- |
| `agent(prompt, opts?)` | Promise; final text without schema, validated object with schema; ordinary child failure becomes null. Only label/phase/provider/model/schema options; provider/model may be overridden independently |
| `schema` | Object-root JSON Schema supporting type/properties/required/additionalProperties/items/enum/const/oneOf; pattern/format/numeric bounds unsupported |
| `pipeline(items,...stages)` | Each item progresses independently, without an all-items stage barrier. stage(prev,item,index) ordinary exceptions make that item null and skip its remaining stages |
| `parallel(thunks)` | Concurrent zero-argument functions, all awaited; ordinary exceptions become corresponding null values |
| `phase(title)` | Exact match to a declared meta phase title |
| `log(message)` | Progress reporting |

Invalid hook arguments, unknown options (including effort/isolation/agentType), unsupported schemas, and total/composition limits terminate the entire script rather than becoming local null values. The host defines concurrency and total limits; there are no universal public numeric limits here. Scripts have no filesystem, network, timers, or Node API. Children do the actual work.

```javascript
const results = await pipeline(args.items,
  async (_, item) => agent(`Review this item: ${item}`, { label: 'Review item' }));
return results.filter(value => value !== null);
```

Completion returns `{status:'completed', result}`; result is a rendered string, not the original JSON object. A killed run returns `{status:'killed', detail?}`; a background run returns `{status:'running', job_id, elapsed_ms, note}`. Read the whole run with async_wait_job; job_kill requests cancellation. Missing workflow wiring yields a readable refusal and zero jobs. See section 7 for composition.

### 3.6 async_list_subagent_models

| Argument | Type | Required/default | Rules |
| --- | --- | --- | --- |
| `provider` | string | Optional | Exact provider ID; omit for provider browsing or cross-provider search |
| `model` | string | Optional | Requires provider; exact-model details |
| `query` | string | Optional | Trimmed search; whitespace-only means omitted; nonempty search conflicts with model details |
| `target_tool` | string | Optional | Visible creation-tool name, including a configured name |
| `page` | integer | 1 | >=1; pages after the first require version |
| `page_size` | integer | 20 | 1..100 |
| `version` | string | Optional on first page | Continuation binds to the same filters and target version |

```text
async_list_subagent_models(query="coding", target_tool="async_agent", page_size=20)
→ Continue with the returned next object rather than assembling old pages manually.
async_list_subagent_models(provider="<exact ID>", model="<exact ID>", target_tool="async_agent")
```

Every result includes `mode`, `entries`, `total`, `version`, `complete`, `target`, `verdict`, and `basis`: the query mode, current entries, match count, version, completeness, target, applicability verdict, and its basis. Optional fields are `page`, `page_size`, `provider`, `query`, `has_next`, `beyond_end`, `failed_providers`, `example`, `unlisted_provider`, `unlisted_had_routes`, and `next`.

For another page, reuse `next` directly. It contains `page`, `page_size`, `version`, and the original `provider`, `query`, and `target_tool` when used. Filtering precedes pagination, with stable lexical ID ordering within a version. If the version is invalidated, restart on page 1 with the same conditions instead of merging old and new pages. Beyond-end requests return an empty page and total rather than silently returning to page 1.

Search matches IDs and display names case-insensitively. If some providers cannot be read, `complete=false` and `total` counts only obtained results. This does not mean the failed providers have no models. Exact IDs in the allowed set remain queryable and listable even when absent from the catalog; absence alone does not establish unsupported routing.

## 4. Wait states and consuming output

Read the returned state before choosing the next action. Budget expiry usually returns `running`: this wait ended without stopping the background work. Entry queries, existence checks, retries, and waiting all share one `wait_ms` budget, rather than each receiving a fresh budget.

Messages can also end a wait early. User steering addressed to the current Agent, claimable notices, relayed Agent messages, and package late answers are checked, including messages already present at entry. Queued messages remain for the next turn and do not interrupt this wait. A message means there is new content to process, not that the target completed.

| Result | Next action |
| --- | --- |
| `running` or a message wakeup | Handle the message or independent work; wait again with the same identifier when needed |
| Job `completed` | Read the result and check the exit code; completion does not imply exit zero |
| Job `failed` / `killed` | Keep the error, signal, and available output before deciding how to proceed |
| Child `settled` | Read the separate settlement message and final answer; do not treat it as proof of success |
| Query or read failure | Retry the original identifier as instructed, without restarting the task |

Canceling a wait or stopping the current turn ends only the wait, not the background command or workflow. The host may replace the cancellation return with an error. If the model never received job_id, recover it from job_list or the completion notice; do not repeat a possibly side-effecting command. Use job_kill to stop a job. Use the host's interrupt_agent/management entry to stop a child, and send_message to continue its conversation.

settled means the child is not currently observed running. It does not mean success, answer delivery, or permanent termination. Read the separate settlement message. If final text has not arrived, do independent work and await delivery. Child relationship and running state are separate checks; query failure cannot establish not_found or settled.

Reads advance the incremental output cursor. The first successful terminal read delivers the final result once, merged into the same response. Later reads do not replay consumed text. A read error requires retrying, not interpreting the result as empty. Inspect exit codes, signals, and failed/killed notices even when execution completed.

Long results can lose content in two different ways. `maxResultChars` truncates only the body shown to the model, counting JavaScript `String.length`, preserving its head and tail, and marking the omitted amount. A host `lossy` marker instead means buffered content has already been lost. Status, loss explanations, and temporary-file clues are outside the body budget.

The host may write output to temporary files (spill) and return their absolute system-temporary paths in `spillPaths`. Open them only where authorized and promptly save necessary contents to an appropriate location. Output and files can contain secrets; review and redact before sharing. Temporary files can disappear. Without a returned path, do not assume a complete disk copy exists.

## 5. Model catalogs, authorization, and inheritance

Use the host's existing subagent model-selection settings. Each later async_agent call requesting a route/effort reads the current switch and allowed set, including in existing sessions, then rechecks permission before launch. Disabling selection rejects explicit choices; fully omitted choices still follow defaults/inheritance. Running children keep their model. Read failures, invalid policies, and withdrawn permission produce a refusal with the real cause, not an automatic model substitution.

Discovery creates no child, performs no inference, and does not validate credentials or remote availability. allowed/not-allowed/unconfirmed describe applicability to the selected target, not universal authorization. Native creation tools retain their own session policy; the plugin's live policy does not change them. Workflow agent() also has a separate contract.

Set target_tool to remove ambiguity. With no target, exactly one recognized candidate can be selected automatically; multiple or zero candidates remain unconfirmed. An explicitly named invisible target is not-allowed while catalog browsing can still succeed. Use exact IDs and an effort the target accepts. Do not pass search/pagination arguments to creation. On refusal, query again for the same target rather than changing tools to bypass restrictions.

## 6. Question takeover and silent failures

To answer in the pending-question panel, enable `askTakeover` in settings and save; it is off by default. Only ordinary questions from root Agents in the two package presets enter this panel. Plan review, approvals, and other presets retain the native host flow.

With `sidebar`, an unanswered count appears at the sidebar bottom; click to expand. With `overlay`, questions appear at the lower right. The panel lets you open the original session, answer, ignore, or extend the wait.

Check the question type before answering. Single-choice questions accept one preset option or the custom answer. Multiple-choice questions can combine them, with custom text submitted as an independent answer rather than a suffix. Nothing starts selected, and a recommendation is not a selection. Clicking the custom input or entering non-whitespace text selects it; moving keyboard focus alone does not.

Deselecting the custom answer may retain its draft, but the draft is not submitted. Clicking its input or entering valid text selects it again. Clearing selected custom text does not restore an earlier selection. No selection, or a selected whitespace-only custom answer, prevents submission—even if a multiple-choice question has other selected options. Use the separate Ignore action to leave a question unanswered. The server also validates options and selection relationships.

Questions from one call share a deadline. At expiry, answered and ignored items retain their state. Unanswered items return `selected=[]` with a timeout explanation in `custom`. The Agent continues the task without choosing an answer for the user.

For more time, use the session group's extension action. It adds `askExtendMs` to the existing deadlines of batches still active at click time. New batches are unaffected, and expired batches do not start waiting again. If acknowledgement is missing, refresh and check the actual deadline before retrying, to avoid adding the extension twice.

You can still answer in the panel after expiry. The late notification returns to the original session with the full question, every option and description, multiple-choice relationship, actual answer or ignore status, and timing. Offered options are separate from actual choices; unselected custom drafts are excluded.

If the session is idle with no package delivery waiting to start, the host uses `followup` to start a turn. Otherwise it uses `inject` for the next claim point. The package wakes a wait only after the host accepts delivery.

Check the submission outcome. On an explicit failure, follow the displayed reason and reply directly in the originating session. Do the same for a missing record marked `undelivered`. If acknowledgement is merely missing, let the panel refresh before concluding that delivery failed. Do not resubmit when `gone` means another client already answered.

24 hours is a lazy-cleanup threshold: expired records older than 24 hours are removed only when a new batch is intercepted. With no new batch they may last longer, and late submission itself is not rejected just because 24 hours elapsed. Restart or uninstall loses in-memory expired records and returns pending requests to the native flow. Save needed answers in the original session promptly.

silentFailureGuard defaults to false and applies only within the two package presets. It conditionally adds result diagnostics, description warnings, and execution instructions. Capturing commands in a restricted environment can fail silently before process creation. If there is no output and no exit marker, confirm execution with a harmless bare invocation and inspect host logs, rather than assuming success. A warning is not proof that every capturing command failed. Wider-permission retries still require the same-turn approval process.

## 7. Advanced composition

Tools can be mounted independently in custom presets, and discovery can coexist with native discovery. Custom composition does not automatically disable existing synchronous tools. Each config.toolName chooses one tool; a row without it is the host-configuration role. Workflow requires an engine in an isolated delegation group. This example includes all six tools, not the other features of a complete preset.

```yaml
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
- id: async-list-subagent-models
  name: dsh-async-tools
  config: { toolName: async_list_subagent_models }
- id: delegation
  name: cordis:group
  group: true
  isolate: { workflowEngine: true }
  config:
    - id: workflow-ptc
      name: '@deepseek-ai/dsh-workflow-ptc'
      config: { provider: spawn }
    - id: async-workflow
      name: dsh-async-tools
      config: { toolName: async_workflow }
```

The engine's context must also resolve four host services: `subagents`, `ptcRuntime`, `sandboxPolicy`, and `workingDirectory`. If a service is missing, inspect the host composition and engine load logs, then add the appropriate service-provider rows. Before reloading, confirm that active sessions and jobs have been safely brought to a stopping point. If the engine cannot execute the current constrained policy, preserve the actual error. Choose an engine and host configuration that support that policy, or stop the workflow; do not escalate automatically or bypass the sandbox.

## 8. Disable, recover, and report problems

**Change the default preset before removal.** If it points to dsh-async/dsh-async-create, disabling or uninstalling the package causes new sessions to fail with `agent-preset/not-found`; the host does not clear the choice automatically. Select an available preset in host settings first. If already removed, clear or reselect the default preset there, then verify with a new session.

Disable or remove the package in this order:

1. Inspect your active jobs with `job_list`, read results you need, and explicitly stop unwanted work. Restarting can terminate active processes, so arrange completion first.
2. Change the default preset as described above.
3. Manage the package's dependency registration and bundle composition declaration through the host GUI, then reload as instructed. For CLI operations, use instructions for the exact host version.
4. Create a session to confirm that an available preset works. Clear or reselect the default if recovery is needed.

Deleting a development link does not unload an already loaded module. Existing sessions may retain the original composition version. The tool-producing row (producer) and initiating session (owner) have different lifecycles: removing a tool row does not automatically cancel session-owned jobs.

Commands inherit host permissions, approvals, sandbox, and the environment key set returned by shellEnv.collect(exec). Commands and their output can contain sensitive data. Model-visible registration errors are single-line and limited to 500 characters; full errors go to operator logs. Do not paste tokens, cookies, passwords, private URLs, or secret environment values into issues.

Report through [project issues](<https://github.com/MC5Spear/dsh-async-tools/issues>). Include full plugin/host/Node versions, OS, preset, relevant sanitized settings, a minimal harmless reproduction, expected and actual states, job_id/agent_id and timing, real exit markers, and sanitized log excerpts. Keep the original task identity for diagnosis rather than repeating destructive commands. This is a personally maintained third-party project: issues are accepted, external PRs are not, and there is no fixed response or repair schedule.

Documentation maintenance follows the [documentation principles (Chinese)](<documentation-principles.md>).
