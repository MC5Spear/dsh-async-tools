# User reference

[中文](<user-reference.md>) · [English home](<../README.en.md>)

## 1. Version, installation, and loading

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.3+dsh.0.2.0-rc.2` |
| Exact dsh host version | `0.2.0-rc.2` |

It provides five tools: `async_run`, `async_wait_job`, `async_wait_agent`, `async_agent`, and `async_workflow`. For a different host, choose a release that explicitly targets that host.

The plugin declares Node.js `>=20`. The target host CLI depends on commander 15, which requires Node.js `>=22.12.0`. That is one dependency's lower bound, not a verified minimum for the complete host. Node.js 24 is recommended; also follow the target host's environment instructions. Linux commands and escalation, macOS, and remote execution lack complete validation. Ask about the required environment and known limitations through an issue before using it for important work.

If the installation address does not yield the source, check the repository address and pinned commit, then the network or proxy. If it still fails, contact the maintainer who supplied the installation source about available installation artifacts.

Install a fixed source:

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#ce9852e03340c001f520ddfd13d62410c8983196
```

Alternatively, open the intended DSH instance's Web page and enter the same `github:...#...` source in plugin management's installation dialog. Use the Web address shown when that instance starts, not the GitHub page. This is a fixed source commit, not a newly published tag. The package is not distributed through npm, and the default branch does not establish compatibility with other hosts.

After installation, check these visible results first:

1. Open the package in the plugin list. Check the complete version and a settings form between the description and component rows.
2. Find `dsh-async` and `dsh-async-create` in the new-session preset list.
3. Create a session with either preset, confirm all five tools in its tool directory, and run the harmless example in section 2.

If tools, presets, or settings are missing, check the exact DSH version, then inspect loading logs for peer mismatches or a skipped bundle. Plugin management should also show both the dependency (the package) and bundle (the plugin composition declaration) in the intended profile. Installing the package alone does not establish loading.

Composition or client-entry changes require reloading the intended instance and reopening its page. Arrange a safe maintenance window first so you do not stop other people's work. Ordinary settings saves need no restart.

## 2. First use and settings

`dsh-async` is for general coding; `dsh-async-create` retains creation tools. Both disable synchronous command and native delegation creation entries while retaining host job, child-agent inspection, messaging, and stop tools. Adding this package to your own preset does not remove that preset's synchronous entries.

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print a marker", yield_ms=1000)
async_wait_job(job_id="<returned job_id>", wait_ms=30000)
async_agent(description="Review a small module", prompt="A complete task, input locations, and completion criteria")
async_wait_agent(agent_id="<returned agent_id>", wait_ms=30000)
```

These are agent tool-call examples, not terminal functions. The `command` contents use PowerShell; on Linux, use the shell syntax supported by your host. The short command should show `SHORT_OK`. The long command normally returns a `job_id` first; a later read shows `LONG_DONE`. Keep the ID, continue independent work, and wait when you need the result. Do not launch the task again to check progress. Likewise, keep a child's `agent_id` for waiting or continuing its conversation.

### How to save settings

Open the plugin list → this package's details page. Editing creates a draft; Save writes it. Restore defaults stages removal of user overrides and still requires Save. Leaving discards unsaved drafts. The override marker means a user-layer field exists, even if its value equals the default.

A failed save retains the draft. Read the error before retrying. If read-only or non-loopback access prevents writes, use an authorized local loopback host-management entry rather than bypassing the restriction.

### Where values come from and how failures are handled

Each field starts with its schema default, then host-row configuration and user overrides take precedence in that order. Tools prefer the effective host snapshot. Only when it is absent do they use valid tool-row values and report disconnected settings.

This release places all 17 settings directly under `config` as independent volatile fields: fields updated after saving without a restart. The host saves them individually. The UI checks numbers and relationships between fields; direct configuration writes may reveal a cross-field violation only after the bad value has been persisted.

| Situation | Behavior and next step |
| --- | --- |
| Invalid configuration arrives during operation | Warn and retain the previous valid snapshot; inspect logs and effective values, repair, then save |
| Cross-field relationships are invalid at startup | Use valid defaults and retain the settings repair entry; correct the inequalities in section 3 |
| A number violates its individual schema | The configuration row may fail to assemble; correct the logged value before loading again |
| A boolean is malformed | Treat it as off; repair it to true or false |
| Language or display position is invalid | Validate it during runtime parsing; use an allowed value from section 3 |

If saved values and behavior differ, inspect logs and effective values first. Do not repeatedly run a dangerous command to test a setting.

## 3. All 17 settings

Ranges below describe legal configuration values. Millisecond fields accept fractions within their ranges. Call budgets are separately clamped to the effective request bounds.

| Field | Type | Default | Range | Unit | Takes effect |
| --- | --- | --- | --- | --- | --- |
| `defaultYieldMs` | number | `20000` | `1..2147483647` | ms | Next run/workflow first wait when yield_ms is omitted |
| `minYieldMs` | number | `1000` | `1..2147483647` | ms | Next first-wait request lower bound |
| `maxYieldMs` | number | `600000` | `1..2147483647` | ms | Next first-wait request upper bound |
| `defaultWaitMs` | number | `30000` | `1..2147483647` | ms | Suggested wait-call examples; wait_ms remains required |
| `minWaitMs` | number | `250` | `1..2147483647` | ms | Next wait_ms request lower bound |
| `maxWaitMs` | number | `600000` | `1..2147483647` | ms | Next wait_ms request upper bound |
| `pollIntervalMs` | number | `500` | `1..2147483647` | ms | New child-agent waits: fallback status checks and existence retries |
| `maxResultChars` | integer | `30000` | `1..1000000` | String.length characters | Retained result content per response |
| `jobKind` | string | `async-command` | Nonempty string | None | Kind identifier of new command jobs |
| `subagentProvider` | string | `spawn` | String; blank after trim uses spawn | None | Backend for the next child creation, not the LLM provider |
| `uiLang` | string | `auto` | auto / zh / en | None | Settings and question UI; auto follows host locale |
| `agentLang` | string | `en` | en / zh | None | Subsequent tool descriptions, notes, errors, and model instructions |
| `silentFailureGuard` | boolean | `false` | true / false | None | Conditional command-description, result, and execution hints in this package's two presets |
| `askTakeover` | boolean | `false` | true / false | None | Checked for each ordinary root-agent question request |
| `askTimeoutMs` | number | `60000` | `10000..600000` | ms | Initial deadline of new captured batches; active batches keep their deadline |
| `askExtendMs` | number | `60000` | `1..2147483647` | ms | Each extension adds this to the original deadline |
| `askUiSeat` | string | `sidebar` | sidebar / overlay | None | Sidebar footer badge / bottom-right overlay; does not enable takeover |

All of the following must hold:

- `minYieldMs <= defaultYieldMs <= maxYieldMs`.
- `minWaitMs <= defaultWaitMs <= maxWaitMs`.
- `pollIntervalMs <= maxWaitMs`.

Factory `yield_ms` request bounds are `1000..600000` ms, with `20000` ms when omitted. Factory `wait_ms` request bounds are `250..600000` ms. `defaultWaitMs` supplies examples only; it does not fill in a missing required argument. Expiry ends the wait, not the background task. An active first wait cannot be extended; question-panel extensions affect question batches only.

Circled question-mark buttons expand help without editing or saving. Millisecond fields show both effective and draft values in seconds. `uiLang` and `agentLang` are independent: one controls the page, the other model-visible text.

## 4. Tool arguments and responses

The names below are public tool identifiers. Budget arguments are numbers in milliseconds and are clamped as described in section 3. Your host may configure different effective bounds; the current tool description shows them.

### 4.1 async_run

| Argument | Type | Required | Default / constraint |
| --- | --- | --- | --- |
| `command` | string | Yes | Actual shell command |
| `description` | string | Yes | Active-voice description, 5–10 words |
| `yield_ms` | number | No | defaultYieldMs, clamped by minYieldMs / maxYieldMs |
| `workdir` | string | No | Session's effective working directory; relative paths resolve against it |
| `sandbox_permissions` | string | Conditional | Exposed only with a constrained executor; enum comes from the host; pair with justification |
| `justification` | string | Conditional | Nonempty explanation for a one-call permission increase, subject to normal approval |

An escalation retry is for the same command just denied by the sandbox. Explain why broader access is needed; approval applies to this call only. Do not replace approval with a permanent session-policy change. Do not pass conditional arguments that are absent from the advertised schema. Admission limits and approval denial occur before process launch. Read the current limit and job list in the error, then wait or stop work you no longer need.

Completion within the first wait returns `{status, output, truncated, exit_code?, signal?, note?}`. Termination may return `{status, detail?, output?, truncated?}`. An unfinished call returns `{status:"running", job_id, elapsed_ms, note}`. `completed` does not mean exit code zero: inspect the exit marker. `signal` is a process termination signal. The command text is the job name; description is active progress text.

### 4.2 async_wait_job

| Argument | Type | Required | Default / constraint |
| --- | --- | --- | --- |
| `job_id` | string | Yes | A job returned by async_run / async_workflow and visible to this session |
| `wait_ms` | number | Yes | No default; clamped by minWaitMs / maxWaitMs |

The budget covers one existence snapshot and the wait. Terminal responses are `{status, job_id, output, truncated, detail?}`, with `completed` / `killed` / `failed`. `stopping` is not terminal. Waiting responses are `{status, job_id, waited_ms, note}`, such as `running` or `interrupted`. Terminal output is delivered in the same response and consumed as described in section 5.

### 4.3 async_agent

| Argument | Type | Required | Default / constraint |
| --- | --- | --- | --- |
| `description` | string | Yes | A 3–5 word display label |
| `prompt` | string | Yes | Self-contained assignment with inputs, boundaries, and completion criteria |
| `provider` | string | No | Nonempty exact LLM provider ID, paired with model; omit both to inherit the parent route |
| `model` | string | No | Nonempty exact model ID, paired with provider |

These are the only four arguments. Creation immediately returns `{status:"started", agent_id, note}`. There is no foreground mode and no job registration. A default spawn child cannot see the parent conversation, so include necessary context in the assignment. Unknown arguments, a backend lacking continuable creation, or a disallowed route are rejected before creation. Do not wait on a fictitious handle from a failed creation.

Use async_wait_agent when you need the result. Continue conversations, inspect children, and explicitly stop them through host `send_message`, `list_agents`, and `interrupt_agent`. Ending the parent's wait does not stop the child.

### 4.4 async_wait_agent

| Argument | Type | Required | Default / constraint |
| --- | --- | --- | --- |
| `agent_id` | string | Yes | A child this caller is authorized to wait for |
| `wait_ms` | number | Yes | No default; clamped by minWaitMs / maxWaitMs |

One total budget covers the relationship check, checking whether the target exists, and waiting. If the target is not yet visible, retry at most three times at pollIntervalMs intervals within that same budget. The response is `{status, agent_id, waited_ms, note}`; a missing target can return `{status:"not_found", agent_id, known_children}`. `running` means it was still observed running within this call. `settled` means it is no longer observed running, including idle or nonresident states; it does not establish success or final-answer delivery. The host delivers the final answer as a separate message, not in this response.

For not_found, check known_children or the host directory rather than dispatching a duplicate. A failed query leaves status unconfirmed: retry the query rather than treating it as absence. A child can start again after a new message, so do not permanently cache an old settled state.

### 4.5 async_workflow

Use this for an explicit workflow request or large-scale multi-agent orchestration. Use async_agent for one or two assignments.

| Argument | Type | Required | Default / constraint |
| --- | --- | --- | --- |
| `script` | string | Yes | Plain JavaScript function body; top-level await allowed; finish with return of a JSON-serializable value |
| `meta` | object | Yes | Metadata below, not an export declaration inside the script |
| `args` | object | No | Available unchanged as global args; wrap a bare list in an object field |
| `yield_ms` | number | No | defaultYieldMs, clamped by minYieldMs / maxYieldMs |

| meta field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | Yes | Short kebab-case run name |
| `description` | string | Yes | One-line purpose |
| `whenToUse` | string | No | When to use it |
| `phases` | array<object> | No | Stage declarations; do not automatically set order or routing |
| `phases[].title` | string | Yes | Exact stage title |
| `phases[].detail` | string | No | Stage description |
| `phases[].provider` | string | No | Expected provider for the stage |
| `phases[].model` | string | No | Expected model for the stage |

The tool schema permits additional metadata properties on meta and phase entries; the host engine performs runtime validation. This does not permit arbitrary hook options.

| Script entry | Arguments, result, and restrictions |
| --- | --- |
| `agent(prompt, opts?)` | Promise of final text without schema, or a validated object with schema; ordinary child failure becomes null. opts accepts only schema / label / phase / provider / model. Unlike async_agent, provider and model can be supplied independently |
| `schema` | Object-root JSON Schema; supports type / properties / required / additionalProperties / items / enum / const / oneOf. No pattern, format, or numeric bounds |
| `pipeline(items, ...stages)` | Each item proceeds independently; stage receives (prev, item, index); no cross-item stage barrier. An ordinary stage exception makes that item null and skips its remaining stages |
| `parallel(thunks)` | Runs zero-argument functions concurrently and awaits all; ordinary exceptions become corresponding null values |
| `phase(title)` | Exact match to a title in meta.phases |
| `log(message)` | Reports progress |
| `args` | The object supplied by the caller |

Bad hook arguments, unknown opts, unsupported schemas, and total-limit violations terminate the whole script rather than becoming an item's null. Concurrency and total limits come from the host's effective configuration. Scripts have no filesystem, network, timers, or Node.js APIs: children do the work and the script coordinates it.

```javascript
const results = await pipeline(args.items,
  async (_prev, item) => agent(`Review this item: ${item}`, {label: "Review item"}),
  async (review, item) => ({item, review}));
return results;
```

Pass `meta={"name":"review-items","description":"Review independent items"}` and `args={"items":["A","B"]}` separately when calling the tool. Mount the engine as in section 8; a missing engine rejects before job creation.

Completion during the first wait returns `{status:"completed", result}`. This outer result is a rendered string, not the script's JSON object. An early return gives `{status:"running", job_id, elapsed_ms, note}`. Keep job_id and read it with async_wait_job. Cancellation may return `{status:"killed", detail?}`. On failure, inspect the actual error rather than starting the same workflow again to retrieve its result.

Top-level runs provide persistent GUI replay records. Internal child scheduling does not write those same persistent nodes, but activity logs and final results remain available.

## 5. Status, messages, and consuming reads

| Observation | Meaning | Next action |
| --- | --- | --- |
| First-wait or wait_ms expiry | This call returns without stopping the background work | Keep the handle; continue independent work and wait again when needed |
| interrupted / steering | A processable message or call cancellation ended this wait | Read note for the cause, handle the message, and do not relaunch the task |
| Queued message | Delivered next turn; does not interrupt this wait | Continue under the target's current budget |
| notice / relay / late-answer wake | There is content for the caller; not proof that the target completed | Handle the message and use target status to decide whether to wait again |
| completed / killed / failed | The job is terminal with its actual outcome | Read output and exit details, not just the completed label |
| settled | A child is not currently observed running | Await the host's final message; inspect the directory if needed; do not infer success |
| Query or read error | State or output has not been obtained | Retry the same query/read; do not rerun the task as if it produced nothing |

Wait entry also checks messages that arrived before the call and remain unclaimed. Canceling a wait, stopping the current turn, or interrupting the first window ends waiting only. The host still owns the background work. The host may replace a canceled call's visible return with a cancellation error, so the model may never receive job_id. Recover it from `job_list` or the completion notice before reading. Never blindly repeat a side-effecting command. To stop work, use `job_kill` for jobs or `interrupt_agent` for children, then verify cleanup state.

Job reads consume data: concatenate all channel deltas, then merge the final result on the first successful terminal read in that same response. Later reads do not repeat consumed content. Save important results to an appropriate user file when received. A read-error marker means retry, not empty output.

Content beyond maxResultChars retains its beginning and end with an omitted count and truncated marker. Status, lossy warnings, and outcome detail are separate. truncated means the model-facing content was shortened; lossy means the host output buffer already lost some content. These are different conditions.

A spill is output written by the host to a temporary file. This release obtains retrieval hints from command-producer detail; it has no independent spillPaths projection. Retrieve a file only from an actual returned path. Without a path, do not assume a complete disk copy exists. Temporary files may contain sensitive command output: retrieve, save, and handle them appropriately. They are not durable storage.

## 6. Models and child backends

`subagentProvider` selects the execution backend, default spawn. The provider argument selects an LLM provider. Omit both provider/model to inherit the parent route. Explicit routing requires a nonempty pair allowed by the session policy and supported by the backend.

### How to select an explicit model

Obtain exact provider/model IDs from host model settings and provider documentation. Confirm the route is allowed, then supply both to `async_agent`. To inherit instead, omit both.

This release samples model policy at session creation rather than reading later global edits live:

| Session situation | Policy used |
| --- | --- |
| The session already has a policy projection (saved policy state) | Keep that value |
| A new child session | Inherit the parent's policy |
| A new top-level session | Read global settings at creation time |
| A restored session without a policy | Do not reconstruct a creation-time sample from current globals |

Editing or disabling the global allowed set does not change existing sessions. Create a new top-level session to use the new policy. Missing or disabled policy rejects explicit routing while leaving inheritance available. If the allowed set is empty, malformed, or excludes the route, repair settings and retry according to the session-creation rules above.

This package has no model-directory query tool. Obtain exact IDs and allowed routes from host model settings and provider documentation. Directory visibility, authorization, credentials, and actual remote availability are separate checks. On creation failure, inspect routing and backend errors rather than repeatedly creating the same task as a probe.

## 7. Question takeover and silent failures

### Questions

askTakeover defaults to false. When enabled, ordinary questions from root agents using this package's two presets appear in the question panel. Plan reviews, permission approvals, and other presets retain native handling.

1. With sidebar selected, click the sidebar footer badge to open questions. With overlay, answer directly in the bottom-right panel. The badge shows the unhandled count.
2. Follow the question's single- or multi-selection rule, or enter custom text. With no options, enter text directly. A single selection replaces the previous one; multiple selections toggle individually.
3. Check selected options and custom text, then submit. You can also ignore one question or open its original session.

This release permits an empty selection, `selected=[]`. An empty custom string is omitted, but whitespace-only text is sent unchanged. Server-side answer validation is incomplete. Before submitting, make sure the answer expresses your intent; clicking Submit does not establish that its content was validated.

Questions in a batch share a deadline. Expiry preserves answered questions and explicit ignores. Unanswered questions return selected=[] with a timeout custom explanation so the agent can continue. The system does not choose a recommendation for you; you can answer later.

For more time, click “Extend waiting” for the session group. Each click adds askExtendMs to the original deadlines of that session's currently unexpired batches. New batches do not inherit extensions, and expired batches do not reopen. If the response is unknown, wait for the refreshed actual deadline before clicking again to avoid duplicate extensions.

Late answers and ignores return to the original agent as package notices containing the question, options and descriptions, multi-selection relationship, answer/ignore, and delay. Custom text is appended to the answer. If the agent is idle with no unclaimed package notice, a new turn starts (followup). Otherwise, the notice joins the next message claim point (inject).

If a notice remains after the last claim point, the system attempts a minimal reminder when the agent becomes idle so it can continue processing. The reminder does not repeat the answer body.

### How to confirm late-answer delivery

This release emits the wait-wakeup event before attempting delivery. A late-answer wake alone therefore does not prove delivery. Service outcomes include delivered / late / gone / failed. Server-side answer validation is incomplete, and gone cannot distinguish an already-handled question from a missing, undelivered record.

On gone, failed, reminder failure, or missing confirmation, keep your answer text. Find the original session in the session list and check whether the answer is present. If absent, directly state the question and intended answer there. The failure list carries question identity and text, not a reliable sessionId link.

Expired batches older than 24 hours are lazily removed only when a new batch is captured. Without a new batch, they may remain longer. Late submission itself is not rejected merely because 24 hours have elapsed. Restarting or unloading loses in-memory expired records. Unsettled requests return to an available native path or are canceled. After a restart, send any additional answer directly to the original session.

### Silent failures

silentFailureGuard defaults to false and controls three conditional hints in this package's two presets: result diagnostics, command-description warnings, and execution instructions. Under constrained, non-escalated execution with an available constrained executor, capture-form commands such as redirection, subexpressions, or assignments with blank output can trigger a hint that execution may not have happened. An ordinary pipe alone does not trigger it. Visible denial signatures can also receive diagnostic context.

When expected output is absent, first try a plain invocation without capture. Check exit markers and operator logs before deciding on an approved retry. A heuristic hint is not proof of failure and is not permission to repeat side effects automatically. Deployment-specific antivirus rules are not universal behavior.

## 8. Complete tool composition for a custom preset

Place these rows in your custom preset's `config.plugins`. The installed bundle supplies the host settings row and client entry. This composition includes all five tools and nonblocking management entries. Manually disable any synchronous shell or native creation entries you do not want; mounting these rows leaves existing entries intact. The two built-in presets are the simpler option for ordinary use.

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
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'
    - id: tool-subagent-list-agents
      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
    - id: workflow-ptc
      name: '@deepseek-ai/dsh-workflow-ptc'
      config: { provider: spawn }
    - id: async-workflow
      name: dsh-async-tools
      config: { toolName: async_workflow }
```

Each toolName selects one tool. Without toolName, a row is the settings role, not an automatic command tool. The workflow row must share the isolated delegation group with workflow-ptc so it can access workflowEngine. Do not move it outside the group. A custom composition does not automatically enter the built-in presets' takeover or guard scope.

## 9. Safety, removal, and recovery

Commands use the host session's permissions, approvals, directory, and environment returned by shellEnv.collect(exec). The package does not add or remove environment keys. Commands may access the network or sensitive information: run only authorized actions and redact tokens, cookies, passwords, sensitive paths, and command arguments before sharing logs. The plugin itself collects no telemetry, makes no package-originated network requests, reads or writes no credentials, and modifies no host source. Model-visible registration errors are single-line and limited to 500 characters; operator logs retain the full original error.

**Change the default preset before removal.** If it points to dsh-async / dsh-async-create, disabling or removing this package can make new sessions fail with `agent-preset/not-found`. The host does not automatically clear that selection.

1. In host settings, choose an available default preset and verify that a new session can be created.
2. Inspect your active jobs and children. Keep or explicitly stop them as appropriate. Unloading a producer row does not cancel owner jobs; restarting may terminate active commands.
3. Disable or remove the package through host plugin management and check both dependency and bundle declarations in the intended profile. Deleting a development link does not unload an already loaded module.
4. Existing sessions may retain a composition-version reference even after a preset leaves the new-session list. Reload only in a safe maintenance window that does not disrupt others.
5. If removal has already left the default invalid, clear or reselect it in the host's default-preset settings and create a new session. Recovery does not require this plugin's page.

For CLI removal, use the target host's management instructions rather than an unverified command. Unsettled questions return to native handling or cancel; expired records disappear on unload.

For an issue, retain the complete plugin and DSH versions, Node version, OS and shell, redacted command/arguments, job_id/agent_id, status and wake reason, effective settings, and a log excerpt. Check whether the original task is still running before retrying. Report problems and security issues through [GitHub issues](https://github.com/MC5Spear/dsh-async-tools/issues), with sensitive details removed. This is a personally maintained project; the maintainer schedules responses.

Documentation maintenance follows the [documentation principles (Chinese)](<documentation-principles.md>).
