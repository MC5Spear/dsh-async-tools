# User reference

[中文](<user-reference.md>) · [English home](<../README.en.md>)

## 1. Installation identity and prerequisites

This alpha preparation worktree is not adapted for dsh `0.2.2-alpha.2` and must not be installed as an alpha-compatible package. The instructions below describe the available rc4 repository source only. Alpha version, Node, toolSet, and Git Bash targets remain unimplemented.

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.7+dsh.0.2.1-rc.4` |
| Exact dsh host version | `0.2.1-rc.4` |

The source repository is currently private. The account used for Git access needs read permission for this repository. A private repository may appear as 404 when not signed in or without read access; check the Git account's permission. Without permission, contact the maintainer who supplied the installation source to ask about access or available installation artifacts.

Before installation, match the exact DSH version above and check Node. The plugin's `>=20` declaration is not a minimum for the complete host. Its commander 15 dependency requires `>=22.12.0`, which is only a known lower bound. Node.js 24 is recommended; confirm that all target-host dependencies resolve on that runtime.

The command below pins an rc4 commit. `#adapt/dsh-0.2.1-rc.4` follows a moving branch; use the full commit for reproducibility. The package is not distributed through npm. An unqualified GitHub spec does not select the right host adaptation.

This line targets Windows, but full target-host revalidation remains pending. Linux commands and one-shot escalation, macOS, and remote execution are unverified. Use this information to decide whether to try an isolated instance first. For other platforms, send the maintainer your environment and intended use to arrange platform-specific verification.

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#ca8f65b39b7694f9e5a2b28cca7a29bc43485ecc
```

Alternatively, open DSH Web plugin management and put the complete address after `add` into the installation address field. After installation and any host-requested reload, the package should appear in the plugin list, with a settings form between its description and component rows. New sessions should offer both asynchronous presets without manually creating directories.

After choosing an asynchronous preset, all six tools should be directly available. For missing tools or settings, use section 8. Composition or client-entry changes require reloading the instance and reopening the page. Arrange completion of other active sessions before restarting, and restart outside the service process tree. Ordinary settings saves do not require restart.

## 2. First use and settings

Choose `dsh-async` for general coding or `dsh-async-create` to retain plugin and preset authoring tools. Both presets expose all six tools directly. Inspection, messaging, and explicit stopping remain host management operations. Existing presets are unchanged.

These are Agent tool-call illustrations, not terminal commands. Short commands usually return results directly. The long example waits one second initially, then returns a job identifier if unfinished.

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless test marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=1000)
async_wait_job(job_id="<returned job_id>", wait_ms=30000)
```

After receiving `job_id` (the job identifier), continue independent work. When the result is needed, call `async_wait_job` with that same identifier and an explicit millisecond budget. Ending the wait does not stop the task; do not repeat the original command.

Open the plugin list, select this package, and use the form between its description and component rows. Writes require the host's local loopback settings endpoint. If the page is read-only or accessed through a non-loopback address, follow its guidance to a writable endpoint. Editing creates a draft; Save applies it. Restoring defaults also requires Save. Leaving discards unsaved drafts; a failed save retains them. Expanding field help does not submit settings.

A field's Restore default action stages removal of that field's user override. Save applies the removal; other fields' overrides stay unchanged. The field then uses its composition or host configuration value. Only when that layer also leaves the field unset does it use the factory default in the table below. Restore default does not force the table's value into the configuration.

The Overridden marker identifies a user override. With a valid configuration operating normally, after restoring and saving, check that the field is no longer marked Overridden and that its displayed value matches the composition value or factory default. In degraded mode, an ordinary restore action does not necessarily repair damaged configuration. Form readings alone do not establish what tools actually use; follow the degradation repair instructions at the end of this section.

The host-row path is `config.settings.<field>`.  User overrides take precedence over composition values, which take precedence over schema defaults. Override presence is determined by whether the field exists, not whether it equals a default. Tools prefer the host snapshot; only when that snapshot is absent do they use valid row-level fallback settings and report missing settings wiring. `toolName`, `owningPreset`, and delegation-row options are not fields in the following table.

### 2.1 All 17 settings

The ranges below constrain saved settings. Tool-call budgets are clamped to the current lower and upper settings: values below the lower bound use that bound, and values above the upper bound use the upper bound. Invalid settings saves are rejected, not automatically adjusted.

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

For damaged configuration, use the page guidance and load log to locate the fields needing repair. At startup, invalid booleans or cross-field relationships can put the plugin into degraded mode: the form retains the original values for repair, while tools use valid factory defaults and a degradation warning appears. Invalid numeric or enum values may instead prevent the configuration row from loading, leaving no settings card. If invalid configuration arrives during operation, tools retain the previous valid effective settings, not factory defaults or the invalid values in the form. New invalid submissions are rejected before persistence.

If the form is already degraded, clicking Save without changes may succeed. This exception applies only to resaving exactly the same damaged configuration present when degradation began; it does not clear degraded mode. It does not allow arbitrary invalid settings to be saved. For example, changing another valid field while leaving the original invalid relationship still causes rejection.

To repair the configuration, correct all invalid fields and relationships in the complete set, then Save. A successful save response alone is insufficient: confirm that the existing degradation warning has cleared, then check the effective values in the tools' current descriptions or result guidance—for example, whether the actual wait bounds match the corrected settings. If a warning remains or effective values differ, continue with the warning and load log. Ordinary valid settings saves do not require restart.

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

A route selects the child's provider and model. Omitted route fields follow defaults or inheritance, but support preflight and final creation are separate steps:

1. Preflight checks the effective route and model support when any of `provider`, `model`, or `reasoning_effort` is explicitly supplied, or the creation row's `agentOptions` contains a `provider`, `model`, or `reasoningEffort` default.
2. Backend `agentRouteDefaults` join the merge only when preflight is triggered. Explicit arguments override row `agentOptions`, which override backend defaults; compatible parent values fill gaps. Non-route options such as `maxTokens` alone neither trigger preflight nor merge backend route defaults.
3. During support preflight, a changed route with no requested effort omits the old configured effort. Parent effort participates only when the effective route is unchanged and the backend has no route defaults. These are preflight rules, not a guarantee about the final child.
4. Final creation sends the options actually contributed by these layers, including non-route options that do not trigger preflight. The result of `resolveCallConfig` is not copied back into that request. The host merges the actual request with parent options; inspect that merge or the real child descriptor to establish the final effort. An omitted preflight effort does not prove the child will not inherit parent effort. With neither a preflight trigger nor any carried options, routing inherits from the parent without additionally applying backend route defaults.

The live allowed set is checked only for explicit selection. Row defaults triggering support preflight do not make a request explicit. `agentOptions`, `agentPreset`, and `allowedAgentPresets` are fixed row configuration, not the 17 UI settings or unrestricted call arguments.

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

Use the returned fields as follows. “Always” means present in every successful response; the other fields depend on the query and result.

| Fields | Meaning | Next action |
| --- | --- | --- |
| `mode`, `entries` (always) | Query mode and this page's provider/model entries | Read exact IDs from entries; filtering precedes pagination and IDs sort stably in lexical order |
| `target`, `verdict`, `basis` (always) | Chosen creation target, applicability decision, and evidence | Check the target and reason before using creation parameters |
| `total`, `complete` (always); `failed_providers` (optional) | Matching count, completeness, and providers that failed | If incomplete, treat total as obtained results only; failed providers do not have zero models |
| `version` (always); `page`, `page_size`, `has_next`, `next` (optional) | Query version and pagination state | Use next unchanged for continuation; it carries page, page_size, version, and the original provider/query/target_tool when present |
| `provider`, `query` (optional) | Echoed provider/search filters | Keep the same filters for continuation; restart on page 1 after changing them |
| `beyond_end` (optional) | The page is past the end | Read the empty page and total, then choose a valid page; it does not silently return page 1 |
| `example` (optional) | Arguments suitable for the confirmed target and an allowed route | Pass only fields that target accepts, not discovery fields |
| `unlisted_provider`, `unlisted_had_routes` (optional) | Catalog-unlisted provider and whether allowed routes were found | Distinguish catalog absence from absence of permitted routes |

If the version is invalidated, restart on page 1 with the same conditions. Do not combine pages from old and new versions.

Search matches IDs and display names case-insensitively. If a provider fails, complete=false and total counts only obtained results; failure does not mean zero models. Exact IDs in the allowed set remain queryable and listable even when missing from the catalog. Catalog absence alone is not evidence of unsupported routing.

## 4. Wait states and consuming output

A wait occupies only its own budget. Expiry returns control while background work continues. A job snapshot, or a child's existence check, retries, and waiting, all count toward that call's single budget.

User steering addressed to the current Agent, claimable notifications (notice), Agent messages (relay), and package late answers can end a wait early. Entry checks also detect messages already waiting. Queued messages remain for the next turn. A message wakeup lets the Agent process new information; it does not establish target completion.

| State or observation | Next action |
| --- | --- |
| `running` or unconfirmed status | Keep the identifier and check later when needed; do not start again |
| `settled` | Read the separate settlement message; do not infer success or answer delivery |
| `completed` | Inspect the actual exit code and result; do not infer exit code zero |
| `killed` / `failed` | Read the cause and any available output |
| Query or read error | Retry the original identifier as instructed; do not infer absence or empty output |

Canceling a wait or stopping the current turn ends only the wait, not the background command or workflow. The host may replace the cancellation return with an error. If the model never received job_id, recover it from job_list or the completion notice; do not repeat a possibly side-effecting command. Use job_kill to stop a job. Use the host's interrupt_agent/management entry to stop a child, and send_message to continue its conversation.

settled means the child is not currently observed running. It does not mean success, answer delivery, or permanent termination. Read the separate settlement message. If final text has not arrived, do independent work and await delivery. Child relationship and running state are separate checks; query failure cannot establish not_found or settled.

Reads advance the incremental output cursor. The first successful terminal read delivers the final result once, merged into the same response. Later reads do not replay consumed text. A read error requires retrying, not interpreting the result as empty. Inspect exit codes, signals, and failed/killed notices even when execution completed.

If content is missing, distinguish three cases:

- Rendered-body truncation: `maxResultChars` counts JS `String.length`, preserves the head and tail, and reports the omitted amount. Status, loss notices, and spill clues are outside that body budget.
- Buffer loss (lossy): the host has discarded buffered content. Raising the rendered-body limit cannot restore it.
- Temporary files (spill): returned `spillPaths` are system-temporary absolute paths. A path does not prove the file remains complete or readable. Without a path, do not assume a complete disk copy exists.

Temporary files may be cleaned up. To retain content, inspect it where you have read permission, then save it promptly to an authorized persistent location. Output and files may contain credentials, private addresses, or other sensitive data. Check access permissions and redaction separately before saving, transferring, or reporting.

## 5. Model catalogs, authorization, and inheritance

To choose a model:

1. Enable model selection and configure the allowed set in DSH's subagent settings. After a successful save, later `async_agent` calls in existing sessions also read the current policy; reopening the session is unnecessary.
2. Query `async_list_subagent_models` with `target_tool="async_agent"` to obtain exact provider, model, and supported effort IDs. For further pages, use the returned `next` arguments.
3. Supply `provider` / `model` as a pair when creating the child, optionally with `reasoning_effort`. Permission is checked again before launch; a query result is not an authorization token.

Turning selection off rejects explicit route or effort requests. Omitting all fields still follows defaults or parent inheritance. Running children keep their model. Policy read failures, invalid allowed sets, and withdrawn permission reject the explicit request with the real cause, without automatically substituting a model.

Discovery creates no child and performs no inference. Distinguish four questions: is the model listed, does the target permit selection, are credentials valid, and is the remote service available? Discovery reports obtained catalog and target evidence; it does not validate credentials or remote connectivity.

`verdict` values `allowed` / `not-allowed` / `unconfirmed` describe selection applicability to the chosen target, not universal authorization. Native creation tools keep their own session policy. Workflow `agent()` also has its own arguments and policy; the plugin's live rules do not replace either contract.

Set target_tool to remove ambiguity. With no target, exactly one recognized candidate can be selected automatically; multiple or zero candidates remain unconfirmed. An explicitly named invisible target is not-allowed while catalog browsing can still succeed. Use exact IDs and an effort the target accepts. Do not pass search/pagination arguments to creation. On refusal, query again for the same target rather than changing tools to bypass restrictions.

## 6. Question takeover and silent failures

Enable `askTakeover` in settings and Save to use this package’s question panel. It is off by default, leaving the native host flow in use. Even when enabled, it handles only ordinary questions from root Agents in the two package presets. Plan reviews, approvals, and other presets retain the host flow.

`sidebar` shows an unanswered count at the sidebar bottom; click to expand. `overlay` shows questions directly at the lower right. From the panel, jump to the original session, select or write answers, ignore questions, or add time.

Single-choice preset options and the custom answer are mutually exclusive. Multiple-choice questions can combine them; custom text is an independent answer, not a suffix. No option starts selected; a recommendation is not a selection. Clicking the custom input or entering valid text selects it; merely moving focus does not. Deselecting may retain a draft, but unselected drafts are not submitted. Empty selection or selected whitespace-only custom text cannot be submitted. Ignore is independent. The server also validates unknown options and selection relationships.

Questions in one call share their initial deadline. Expiry preserves answers and ignore status. Unanswered questions return `selected=[]` and a timeout explanation in `custom`; the Agent continues, and the user may still answer later.

For more time, click the session group’s extension button. Only batches still active at click time receive `askExtendMs`, added to the existing deadline. New batches get their own initial deadline; expired batches do not resume the original wait. Without an acknowledged extension, refresh and read the actual deadline before retrying: every successful extension adds time again.

Answers submitted after expiry still go to the original session. The notice contains the complete question, every option and its description, the single/multiple-choice relationship, actual answer or ignore status, and timing. The full option list explains the question; it does not mean the user selected every option.

When the original Agent is idle with no package delivery pending, the host uses `followup` to start a turn. Otherwise, `inject` delivers at the next message claim point. The package emits a wakeup only after the host accepts delivery. For delivery failure or a missing record marked `undelivered`, open the original session and reply directly. Do not resubmit a `gone` question already answered in another client.

24 hours is a lazy-cleanup threshold: expired records older than 24 hours are removed only when a new batch is intercepted. With no new batch they may last longer, and late submission itself is not rejected just because 24 hours elapsed. Restart or uninstall loses in-memory expired records and returns pending requests to the native flow. Save needed answers in the original session promptly.

silentFailureGuard defaults to false and applies only within the two package presets. It conditionally adds result diagnostics, description warnings, and execution instructions. Capturing commands in a restricted environment can fail silently before process creation. If there is no output and no exit marker, confirm execution with a harmless bare invocation and inspect host logs, rather than assuming success. A warning is not proof that every capturing command failed. Wider-permission retries still require the same-turn approval process.

## 7. Advanced composition

For a custom preset, mount the tool rows you need. `config.toolName` chooses the tool a row provides; a row without it supplies host configuration rather than a tool. Discovery can be mounted alone or alongside native discovery. Custom composition does not automatically disable synchronous tools; the composition author must check the resulting tool list.

Workflows also need a script engine. The example puts the engine and `async_workflow` in the same delegation group and isolates only `workflowEngine`, preventing accidental use of another engine outside that group. It includes all six tools, but not the other features of a complete preset.

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

### Installation and settings troubleshooting

| Observation | First check | Action |
| --- | --- | --- |
| Both tools and settings missing | Exact rc4 host version and load-log rejection | Ask the maintainer to check the profile dependency registration and bundle composition declaration. For a mismatch, choose the matching source rather than bypassing checks |
| Settings present, tools missing | Preset selected by the current session | Start a session with a package preset; for custom presets check section 7's mounting requirements |
| Tools work, settings card missing | Configuration errors in load logs and whether the page was reopened | Repair the named configuration. After composition/client changes, reload as instructed and reopen the page |
| Save fails or page is read-only | Local-loopback access, field errors, and save response | Follow the page to a writable endpoint and correct invalid fields. Failed saves retain drafts; do not restart to hide the error |
| Job identifier missing or read fails | `job_list`, completion notice, and original timing | Recover the original `job_id` and retry reading; do not repeat potentially side-effecting commands |
| Answer unconfirmed or undelivered | Refreshed question state and original session | Unconfirmed does not mean unexecuted. For confirmed nondelivery, reply in the original session; do not resubmit questions already settled elsewhere |

If logs do not explain the problem, use the reporting checklist at the end of this section.

### Disable and uninstall

**Change the default preset before removal.** If it points to dsh-async/dsh-async-create, disabling or uninstalling the package causes new sessions to fail with `agent-preset/not-found`; the host does not clear the choice automatically. Select an available preset in host settings first. If already removed, clear or reselect the default preset there, then verify with a new session.

Manage dependency and bundle through the host GUI and reload as instructed. Use CLI removal instructions for the exact host rather than inventing a universal command. Deleting a development link does not unload a loaded module. Existing sessions may retain composition-version references, and removing a producer row does not automatically cancel owner jobs. Inspect job_list and explicitly stop unwanted work before maintenance. Restart can terminate active processes; arrange completion first.

Commands inherit host permissions, approvals, sandbox, and the environment key set returned by shellEnv.collect(exec). Commands and their output can contain sensitive data. Model-visible registration errors are single-line and limited to 500 characters; full errors go to operator logs. Do not paste tokens, cookies, passwords, private URLs, or secret environment values into issues.

Report through [project issues](<https://github.com/MC5Spear/dsh-async-tools/issues>). Include full plugin/host/Node versions, OS, preset, relevant sanitized settings, a minimal harmless reproduction, expected and actual states, job_id/agent_id and timing, real exit markers, and sanitized log excerpts. Keep the original task identity for diagnosis rather than repeating destructive commands. This is a personally maintained third-party project: issues are accepted, external PRs are not, and there is no fixed response or repair schedule.

Documentation maintenance follows the [documentation principles (Chinese)](<documentation-principles.md>).
