# User reference

[中文](<user-reference.md>) · [English home](<../README.en.md>)

## 1. Installation identity and prerequisites

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.6+dsh.0.2.1-rc.3` |
| Exact dsh host version | `0.2.1-rc.3` |

If the installation address does not yield the source, check the repository address and pinned commit, then the network or proxy. If it still fails, contact the maintainer who supplied the installation source about available installation artifacts.

Choose an installation source first. The fixed commit below makes the source reproducible. The package is not distributed through npm. An unqualified GitHub spec does not select this adaptation.

The plugin's Node.js `>=20` declaration is not a minimum for the complete host. The host depends on commander 15, which requires Node.js `>=22.12.0`; that establishes a lower bound, not a verified minimum for every host dependency. Node.js 24 is recommended. Confirm that the target host's dependencies resolve on the chosen runtime.

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#6c428de042a10f6af04a66e28fedab644184e5ad
```

To follow later changes, replace the part after `#` with `adapt/dsh-0.2.1-rc.3`. That branch moves rather than pinning a release. These instructions do not assume a release tag exists.

In the GUI plugin manager, paste the same `github:MC5Spear/dsh-async-tools#…` from the command into the installation-address field, not a browser page URL.

 Follow the installation prompts for any required reload, then reopen the page. Open this package in the plugin list: the settings form should appear between its description and component rows. The new-session preset selector should list `dsh-async` and `dsh-async-create`; after selection, the Agent should have the six tools in section 3.

If tools or settings are absent, use section 8.1 rather than starting with internal registration lists. Composition or client-entry changes require reloading and reopening the page. Bring active sessions to a safe stopping point before restarting from outside the service process tree. Ordinary settings saves need no restart.

This line targets Windows, but its complete mechanism-by-mechanism verification on the target host remains pending. Linux command execution and one-shot escalation are unverified; there is no line-specific verification conclusion for macOS or remote execution. For these environments, send environment details and the requested use case to the maintainer. A Windows deployment with suitable verification conditions is the current choice; maintainers can add platform verification in an isolated instance.

## 2. First use and settings

Choose `dsh-async` for general coding or `dsh-async-create` to retain plugin and preset authoring tools. Both presets expose all six tools directly. Inspection, messaging, and explicit stopping remain host management operations. Existing presets are unchanged.

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless test marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=1000)
async_wait_job(job_id="<returned job_id>", wait_ms=30000)
```

These are Agent tool-call examples, not PowerShell functions. The short command should return `SHORT_OK` directly. The long command will normally return a job identifier, `job_id`, first; a later read shows `LONG_DONE` and the real exit marker.

Keep the original ID and continue independent work. When the result is needed, supply `wait_ms` for a bounded wait: it waits only for that call’s explicit budget. If unfinished, wait again later instead of repeating the original command.

Open the plugin list, select this package, and use the form between its description and component rows. Writes require the host's local loopback settings endpoint. If the page is read-only or accessed through a non-loopback address, follow its guidance to a writable endpoint. Editing creates a draft; Save applies it. Restoring defaults also requires Save. It clears the user override and uses the host-row value; the factory default applies only if the host row does not set that field. Leaving discards unsaved drafts; a failed save retains them. Expanding field help does not submit settings.

The host-row path is `config.settings.<field>`. User overrides take precedence over composition values, which take precedence over schema defaults. Override presence is determined by whether the field exists, not whether it equals a default. Tools prefer the host snapshot; only when that snapshot is absent do they use valid row-level fallback settings and report missing settings wiring. `toolName`, `owningPreset`, and delegation-row options are not fields in the following table.

### 2.1 All 17 settings

Distinguish saved settings from call arguments. The table constrains saved settings; ordinary invalid new inputs are rejected before writing. Resaving unchanged damaged values in degraded mode has the exception described below. Call budgets are clamped to the current min/max: a value below the minimum uses the minimum, and one above the maximum uses the maximum.

These are source-code factory defaults, not the effective settings of the current session. In particular, `20000`, `30000`, and `600000` do not override the budgets currently advertised by the tools. If a session is configured for `1800000`, use its effective settings and declarations.

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

When a configuration warning appears, check the warning and the values the tools actually use, not just a successful Save response. The form may retain damaged persisted values for repair; those are not necessarily the effective values.

| Situation | Values actually used | How to confirm and recover |
| --- | --- | --- |
| Damaged boolean or cross-field values at startup enter repairable degraded mode | Valid factory defaults | Correct all invalid fields, save, and confirm that the warning clears and effective values match the intended configuration |
| Invalid configuration arrives during operation | The previous valid values remain in use | Read the rejection or degraded-mode warning, correct the configuration, and save again; ordinary invalid new writes are still rejected before persistence |
| Exactly the same damaged baseline is saved unchanged | Save may succeed, but the degraded defaults or previous valid values remain in use | Success does not mean repair. Degraded mode clears only after the complete configuration becomes valid and is successfully applied; recheck warnings and effective values |

Invalid numeric or enum schemas can also prevent row assembly and hide the settings card. Ask the operator to inspect load logs and correct the named fields. Saving valid configuration requires no restart.

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

Two checks serve different purposes. **Route-support preflight** checks whether the LLM runtime can resolve the model and effort. **Selection-policy validation** checks permission for an explicit choice. Row defaults can trigger preflight without turning the call into an explicit selection request.

Preflight runs when the call explicitly supplies `provider`, `model`, or `reasoning_effort`, or the creation row’s `agentOptions` configures `provider`, `model`, or `reasoningEffort`. Non-route defaults such as `maxTokens` alone do not trigger it. Backend `agentRouteDefaults` are merged only when preflight is triggered.

For preflight, explicit arguments override row `agentOptions`, which override backend `agentRouteDefaults`; compatible parent values fill gaps. With no preflight trigger and no options to carry, final creation inherits parent configuration without adding backend route defaults. Preflight-resolved values and the options carried in the final child request are different data: preflight success alone does not prove that an effort value was actually inherited. Check the actual child route and receipt when that distinction matters. Switching routes without an effort does not reuse an incompatible old-route effort.

`agentOptions`, `agentPreset`, and `allowedAgentPresets` are fixed row configuration, not the 17 UI settings or unrestricted call arguments.

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
| `query` | string | Optional | Trimmed nonempty search; conflicts with model details |
| `target_tool` | string | Optional | Visible creation-tool name, including a configured name |
| `page` | integer | 1 | >=1; pages after the first require version |
| `page_size` | integer | 20 | 1..100 |
| `version` | string | Optional on first page | Continuation binds to the same filters and target version |

```text
async_list_subagent_models(query="coding", target_tool="async_agent", page_size=20)
→ Continue with the returned next object rather than assembling old pages manually.
async_list_subagent_models(provider="<exact ID>", model="<exact ID>", target_tool="async_agent")
```

Results always include mode/entries/total/version/complete/target/verdict/basis. Optional fields include page/page_size/provider/query/has_next/beyond_end/failed_providers/example/unlisted_provider/unlisted_had_routes/next. next contains page/page_size/version and the original provider/query/target_tool. Filtering precedes pagination; IDs sort lexically and stably. On an invalidated version, restart on page 1 with the same conditions rather than merging old and new results. Beyond-end requests return an empty page and total, not a silent return to page 1.

Search matches IDs and display names case-insensitively. If a provider fails, complete=false and total counts only obtained results; failure does not mean zero models. Exact IDs in the allowed set remain queryable and listable even when missing from the catalog. Catalog absence alone is not evidence of unsupported routing.

## 4. Wait states and consuming output

### 4.1 What to do when a wait ends

One call has one total budget. Job snapshots or child-existence checks, retries, and waiting all share it. Expiry returns control while background work continues.

| Result or symptom | Meaning | Next action |
| --- | --- | --- |
| running | No terminal result was obtained; the note identifies any unconfirmed state | Keep the ID, do other work, and wait again when needed |
| interrupted or a message-wakeup note | A processable message reached the caller and ended this wait early | Handle the message; arrival does not establish target completion |
| settled | A permitted child is no longer observed running during this call | Read the separate settlement message; this does not prove success, answer delivery, or permanent termination |
| completed | The job finished executing | Check real exit codes, signals, and error content; this does not imply exit code zero |
| killed / failed | The job was stopped or failed | Keep the original ID and error, then address the actual cause |
| not_found or a query error | Confirmed absence and a failed query are different | Check the directory, ID, and visibility; retry a failed query with the same ID rather than restarting work |

User steering, claimable notices (notice), agent relays (relay), and package late answers can end a wait early. Entry checks include already-arrived, unclaimed messages. Queued messages remain for the next turn and do not interrupt.

Canceling a wait or stopping the current turn does not terminate the background command or workflow. The host may replace the canceled tool result with an error, so the model may never receive job_id. Recover the ID from host job_list or a completion notice, then read it with async_wait_job. Do not repeat a possibly side-effecting command.

Use job_kill to request an actual job stop. Stop a child through host interrupt_agent or management tools; use send_message to continue its conversation. A child can stop running before its final text arrives. Do independent work and await the message instead of duplicating the delegation.

### 4.2 Read and save results

Each read advances the incremental cursor—the record of how far you have read. The first successful terminal read merges the final result into that same response, once. Later reads do not replay consumed content. Save needed results when first received. Retry a read error with the original ID; an error does not mean empty output.

maxResultChars counts the body using JS String.length. Over-budget text keeps its head and tail with an omission marker. Status, loss markers, and spill clues sit outside that body budget.

Distinguish two kinds of missing text: lossy means the host buffer lost content; body truncation means this model response exceeded its text budget. Reading again does not restore lost or already consumed text.

When the host reports spillPaths, the result includes absolute system-temporary paths. Files may contain sensitive commands or results and may be cleaned up. Save needed contents promptly to an authorized location, and redact before sharing. Without a path, do not assume a complete disk copy exists. A reported path also does not prove that its file remains complete or readable.

## 5. Model catalogs, authorization, and inheritance

### 5.1 Query first, then select

First open **DSH subagent settings**, enable model selection, add the exact permitted `provider` / `model` routes to the allowed set, and save. This is host configuration, not one of this package’s 17 settings. `subagentProvider` selects the creation backend; it is not the model allowed set.

After saving, later `async_agent` calls in existing and new sessions use the current configuration. Running children keep their models. If model selection remains off, omit `provider`, `model`, and `reasoning_effort` to use configured defaults or parent inheritance. Browsing the catalog does not enable selection permission.

Once host configuration is saved, query and create:

1. Browse or search with async_list_subagent_models, using target_tool to name the intended creation tool.
2. Copy exact provider and model IDs. For effort selection, inspect model details and confirm that the target accepts that effort.
3. Pass only creation arguments to the target. Search, pagination, and target_tool are not creation arguments.
4. If creation is refused, query again for the same target and address the actual cause. Do not change entry points to bypass restrictions.

Without target_tool, exactly one recognized candidate can be adopted automatically. Multiple or zero candidates yield unconfirmed. An explicitly named invisible target is not-allowed, although catalog browsing can still return data.

### 5.2 A catalog entry is not permission

Discovery creates no child, performs no inference, and does not validate credentials or remote availability. The verdict values allowed / not-allowed / unconfirmed describe applicability to the current target, not universal authorization. Catalog visibility, selection permission, valid credentials, and remote availability are four separate facts.

async_agent uses the host’s existing selection switch and allowed set. Each later explicit route or effort request reads current configuration, including in existing sessions, and rechecks permission before launch. Turning selection off rejects explicit choices. Fully omitted choices still use defaults or parent inheritance, and running children keep their models.

Read failures, invalid policies, or permission withdrawn before launch cause a refusal with the actual reason, not an automatic model substitution. Native creation tools retain their session policy. Workflow agent() has its own contract; the plugin’s live policy does not redefine it.

## 6. Question takeover and silent failures

### 6.1 Enable and answer questions

askTakeover is off by default. When enabled, it intercepts only ordinary questions from root Agents in the two package presets. Plan review, approvals, and other presets keep the host flow.

With askUiSeat set to sidebar, an unanswered count appears at the sidebar bottom; click to expand. With overlay, questions appear directly at the lower right. The panel supports opening the originating session, choosing answers, custom text, ignoring questions, and extensions.

Single-choice preset options and the custom answer are mutually exclusive. Multiple-choice questions can combine them. Custom text is an independent answer, not a note attached to another choice. No item starts selected, and a recommendation is not a selection.

Clicking the custom input or actively entering valid text selects it; merely moving focus does not. Deselecting can retain a draft, but an unselected draft is not submitted. Clearing selected custom text leaves it selected and does not restore an older preset choice.

You cannot submit without a selection or with selected whitespace-only custom text. In multiple-choice questions, another valid preset choice does not make blank custom text valid: correct or deselect it first. The server also validates unknown options, selection relationships, and validity. Ignore is independent, not an empty answer submission.

### 6.2 Expiry and extensions

A batch shares its initial deadline. At expiry, completed answers and ignore states are retained. Unanswered questions return selected=[] and a timeout custom explanation. The Agent continues and you can still answer later; the system does not choose for you.

Extend affects only batches still active in that session at click time, adding askExtendMs to each original deadline. New batches get their own initial deadline; expired batches do not re-enter the original tool wait.

If an extension is not clearly acknowledged, refresh the panel and read back the real deadline before deciding whether to retry. Every successful click adds time, so blind retries may add it twice. For an unacknowledged answer submission, also check panel state first; no response is not proof of failed delivery.

### 6.3 Answer after expiry and recover from delivery failure

Late-answer notifications include the complete question, all options and descriptions, multiple-choice relationships, actual answers or ignore status, and timing. Question data is separate from the actual selection; listing all options does not mean they were all chosen.

If the originating session is idle with no package delivery awaiting startup, followup starts a turn. Otherwise inject places the answer at the next claim point. The plugin emits a wakeup only after the host accepts delivery. On a displayed delivery failure, open the original session and reply directly. Do the same for a missing record marked undelivered. Do not resubmit gone when it means another client already answered.

24 hours is a lazy-cleanup threshold, not a scheduled deletion time. Only intercepting a new batch removes expired records whose deadline passed more than 24 hours ago. Without a new batch they can last longer. Late submission itself is not rejected merely because 24 hours elapsed.

Records are in memory and do not survive restart or uninstall. Pending requests return to the native flow; expired records are lost. Save answers you need in the original session promptly.

### 6.4 Silent-command-failure warnings

silentFailureGuard defaults to false and applies only in the two package presets. It conditionally adds result diagnostics, description warnings, and execution instructions.

“Capturing” includes assignments, subexpressions, and redirection that collect command output. A restricted environment may silently prevent process creation for these forms. If expected output is missing and there is no exit marker, confirm execution with a harmless bare invocation, then inspect host logs. Empty output is not success, and a conditional warning does not prove that all capturing commands fail. Wider-permission retries still require same-turn authorization and approval.

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

### 8.1 Installation and settings unavailable

| Symptom | Check first | Next action |
| --- | --- | --- |
| Tools, presets, and settings all missing | Exact host version; a mismatch may skip the entire bundle | Compare section 1 and the installation prompts; ask the operator to inspect load logs and confirm both the profile dependency and bundle registration |
| Settings present, tools missing | Whether the new session selected one of this package’s presets | Select it and retry; existing sessions may retain an older composition reference |
| Tools present, settings missing | Whether this package’s detail page is open and its client has reloaded | Reopen the page; if still missing, give the operator sanitized load logs |
| Read-only settings or failed save | Local loopback writable endpoint and field validity | Follow page guidance or correct the field; failed drafts remain, so confirm a successful save before leaving |
| Degraded configuration, or warnings after a successful Save | The three cases in section 2.1, warnings, and effective values; persisted form values may differ | Startup degradation uses valid factory defaults; invalid runtime configuration preserves previous valid values. Resaving an identical damaged baseline may succeed without clearing degradation. Apply a complete valid repair and confirm the warning clears. If the card is absent, ask the operator to inspect load logs and correct configuration |

### 8.2 Disable and uninstall

**Change the default preset before removal.** If it points to dsh-async/dsh-async-create, disabling or uninstalling the package causes new sessions to fail with `agent-preset/not-found`; the host does not clear the choice automatically. Select an available preset in host settings first. If already removed, clear or reselect the default preset there, then verify with a new session.

Manage dependency and bundle through the host GUI and reload as instructed. Use CLI removal instructions for the exact host rather than inventing a universal command. Deleting a development link does not unload a loaded module. Existing sessions may retain composition-version references, and removing a producer row does not automatically cancel owner jobs. Inspect job_list and explicitly stop unwanted work before maintenance. Restart can terminate active processes; arrange completion first.

Commands inherit host permissions, approvals, sandbox, and the environment key set returned by shellEnv.collect(exec). Commands and their output can contain sensitive data. Model-visible registration errors are single-line and limited to 500 characters; full errors go to operator logs. Do not paste tokens, cookies, passwords, private URLs, or secret environment values into issues.

Report through [project issues](<https://github.com/MC5Spear/dsh-async-tools/issues>). Include full plugin/host/Node versions, OS, preset, relevant sanitized settings, a minimal harmless reproduction, expected and actual states, job_id/agent_id and timing, real exit markers, and sanitized log excerpts. Keep the original task identity for diagnosis rather than repeating destructive commands. This is a personally maintained third-party project: issues are accepted, external PRs are not, and there is no fixed response or repair schedule.

Documentation maintenance follows the [documentation principles (Chinese)](<documentation-principles.md>).
