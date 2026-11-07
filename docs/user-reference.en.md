# User reference

[中文](<user-reference.md>) · [English home](<../README.en.md>)

## 1. Installation identity and prerequisites

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.8+dsh.0.2.1-rc` |
| Supported dsh host versions | `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5` |

If the installation address does not yield the source, check the repository address and commit, then the network or proxy. If it still fails, contact the maintainer who supplied the installation source about available installation artifacts.

The source repository spec is `github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1`. The branch moves; for a reproducible source, check the source out locally, take the full commit from `git rev-parse HEAD`, replace everything after `#` with that commit, and verify the installed source against the same commit. The package is not distributed through npm. A spec without a branch or commit qualifier (for example a bare `github:MC5Spear/dsh-async-tools`) does not select the right host adaptation — the plugin cannot pick one for you.

Check the runtime before installing. Node.js 24 is recommended. The plugin's `>=20` declaration applies only to the plugin. The host's commander 15 dependency requires `>=22.12.0`, but this is only a known lower bound, not a verified minimum for the complete host. Confirm that the target host's dependencies resolve on the chosen runtime.

The four host versions above share one compatibility line and one peer support set. The final `0.2.1`, `0.2.0`, `0.2.2`, and any new rc not in the set are rejected — that is the install condition. Keep the compatibility declaration apart from what has actually been verified.

- **Verified so far**: `0.2.1-rc.2` and `0.2.1-rc.5` passed item-by-item real-host verification on isolated instances; `0.2.1-rc.4` and `0.2.1-rc.3` share the same implementation and are covered by static contract checks plus the local full test suite (this local Windows machine only). The CI workflow is configured with a four-version matrix, but remote execution has not happened — that is not verified coverage. Real-host verification targeted the artifact installed at the time — the revalidation boundary for later mechanism changes is documented in design §9.3 and `CHANGELOG.md` (repository root).
- **Not yet verified**: per-host real-host revalidation of rc.3/rc.4 and remote CI execution are still pending; this line targets Windows — Linux, macOS, and remote execution are unverified, so arrange isolated verification with the maintainer before deploying there.
- **Materials**: development verification materials (verify/ and the like) are not distributed with the installation package; see the corresponding materials for the same commit in the source repository https://github.com/MC5Spear/dsh-async-tools (the installed version is listed in CHANGELOG.md).

After checking these prerequisites, install from a terminal:

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1
```

Alternatively, in DSH's plugin manager, open the install dialog and paste the GitHub spec above into the installation address. When installation finishes, open this package's detail page and check that its settings form is visible. Create a session and confirm that `dsh-async` and `dsh-async-create` are available. After selecting either preset, the Agent should have the five tools documented here.

If both tools and settings are missing:

1. Check whether the DSH version is in this section's support set.
2. Inspect host load logs to see whether a version mismatch caused the package to be skipped.
3. In the target profile, check both the dependency registration (installed package) and the bundle registration (host-row and preset composition declarations). They serve different purposes; one registration alone does not establish that every entry loaded.
4. After composition or client-entry changes, reload the instance and reopen the page. Arrange for active sessions to finish safely before restarting, and restart outside the service process tree. Ordinary settings saves need no restart.

Development links are for an explicit development environment. Keep stable deployments separate from the editing tree. Prepare the source as follows:

```powershell
git clone https://github.com/MC5Spear/dsh-async-tools.git
cd dsh-async-tools
git checkout adapt/dsh-0.2.1
npm install
dsh plugin --profile web add <absolute-clone-directory>
```

The linked directory must resolve matching host dependencies. A bare Node import checks only part of module resolution; it does not establish complete host-service, tool, or page integration.

## 2. First use and settings

Choose `dsh-async` for general coding or `dsh-async-create` to retain plugin and preset authoring tools. Both presets expose all five tools directly. Inspection, messaging, and explicit stopping remain host management operations. Existing presets are unchanged.

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless test marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=20000)
async_wait(targets=[{kind:"job", id:"<returned job_id>"}], wait_ms=30000)
```

These are Agent tool calls, not terminal commands. The short command should return `SHORT_OK` directly. The factory clamping range for `yield_ms` is 20000–600000 milliseconds (values below the floor take effect as the floor); the 30-second command exceeds the 20-second first wait, so it returns a job identifier, `job_id`. Keep it and continue independent work. When the job settles, its result body is delivered directly — attached to an in-flight async_wait return or as a completion message; no separate retrieve call is required. Use `async_wait` when you need to block on a result, explicitly supplying `wait_ms` every time. Even after seeing `LONG_DONE`, inspect exit information. Do not repeat the command to check progress.

Open the plugin list, select this package, and use the form between its description and component rows. Writes require the host's local loopback settings endpoint. If the page is read-only or accessed through a non-loopback address, follow its guidance to a writable endpoint. Editing creates a draft; Save applies it. Restoring defaults also requires Save. Leaving discards unsaved drafts; a failed save retains them. Expanding field help does not submit settings.

A field's Restore default action stages removal of only that field's user override. Save applies the removal; other fields' overrides are unchanged. The field then uses the host composition's configured value, falling back to the factory default in the table only when the composition has no value. It does not forcibly write the table's default. With a valid configuration, check after saving that the field is no longer marked Overridden and that its value is what you expect. For example, a composition value of `45000` overridden with `90000` returns to `45000`, not `20000`. If a degraded-mode warning remains, follow the recovery guidance after the table; restoring an override is not proof that a damaged configuration is repaired.

For advanced configuration, put fields under the host row's `config.settings.<field>`, not directly under `config`. The 0.2.5 flat style (`config: { agentLang: zh, … }`) does not take effect on 0.2.8: the row activates but the preset values silently fall back to defaults. The correct form is `config: { settings: { agentLang: zh, … } }` (see the migration section of the repository's `CHANGELOG.md` for a side-by-side example and the load-time warning; that file is not shipped inside the install package — read it from a pinned commit or tag of the source repository). Values are selected in this order: user override, composition configuration, then schema default (the default in the configuration definition). A user-layer field counts as an override even when its value equals the default.

Tools first read the current configuration snapshot published by the host. Only if it is absent do they use valid tool-row fallback values and report that settings are not connected. `toolName`, `owningPreset`, and delegation-row options are fixed row configuration, not part of the 20 UI settings below.

### 2.1 All 20 settings

The Range column describes values that can be saved. If a call's budget falls outside the current min/max, the tool moves it to the nearest boundary; this is clamping. A new invalid configuration is rejected, not clamped. Resaving an existing damaged configuration unchanged is an exception explained after the table. Values are stored in milliseconds (ms): 1000 ms is one second.

| Field | Type | Default | Range | Unit | Takes effect |
| --- | --- | --- | --- | --- | --- |
| `defaultYieldMs` | number | `20000` | 1..2147483647; fractions allowed | ms | Next run/workflow call omitting yield_ms |
| `minYieldMs` | number | `20000` | 1..2147483647; fractions allowed | ms | Lower bound for the next initial wait |
| `maxYieldMs` | number | `600000` | 1..2147483647; fractions allowed | ms | Upper bound for the next initial wait |
| `defaultWaitMs` | number | `30000` | 1..2147483647; fractions allowed | ms | Example budget only; wait_ms remains required |
| `minWaitMs` | number | `20000` | 1..2147483647; fractions allowed | ms | Lower bound for the next wait request |
| `maxWaitMs` | number | `600000` | 1..2147483647; fractions allowed | ms | Upper bound for the next wait request |
| `pollIntervalMs` | number | `500` | 1..2147483647; fractions allowed | ms | New wait's fallback state polling and existence retries |
| `maxResultChars` | integer | `12000` | 1..1000000 | JS String.length | Result rendering |
| `jobKind` | string | `async-command` | Nonempty | — | Kind identifier for new command jobs |
| `subagentProvider` | string | `spawn` | Backend name; trimmed empty value uses spawn | — | Next child creation; not an LLM provider |
| `uiLang` | enum | `auto` | auto / zh / en | — | UI; auto follows the host |
| `agentLang` | enum | `en` | en / zh | — | Language for tool descriptions, results, and instructions |
| `silentFailureGuard` | boolean | `false` | true / false | — | Command diagnostics and warnings for sessions under the bound-presets list |
| `workflowProgressLog` | boolean | `false` | true / false | — | Whether orchestration results keep per-phase progress lines |
| `fullCommandEcho` | boolean | `false` | true / false | — | Attach the full command or workflow script text when background results are delivered |
| `askTakeover` | boolean | `false` | true / false | — | Each ordinary question request |
| `askTimeoutMs` | number | `60000` | 10000..600000; fractions allowed | ms | Initial deadline for a new intercepted batch |
| `askExtendMs` | number | `60000` | 1..2147483647; fractions allowed | ms | Each extension, added to the existing deadline |
| `askUiSeat` | enum | `sidebar` | sidebar / overlay | — | Question panel position; does not reset deadlines |
| `boundPresets` | string[] | `dsh-async, dsh-async-create` | Array of preset ids; entries non-empty and unique; empty array allowed | — | Matched against each session's current effective preset |

`boundPresets` is the feature-binding list (new in 0.2.8+dsh.0.2.1-rc): for checked presets, sessions under them get this package's execution-discipline section in their composed prompts — operating requirements added for Agents on the chosen preset — and the silent-failure hint and pending-panel question handling apply to sessions on the list. The switch rules differ across the three: the execution-discipline section has no switch of its own — whether it is injected is decided solely by list membership; the silent-failure hint and pending-panel question handling each remain controlled by their own switches, `silentFailureGuard` and `askTakeover`, for listed sessions — the list decides the scope only, it does not replace those two switches. Matching follows each session's current effective preset: when the same tool implementation is reused by several presets, sessions on unchecked presets are unaffected. The factory default binds this package's two presets (upgrades do not change behavior); unchecking every entry and saving unbinds everything; ids bound but absent from the current preset list stay listed and can be unchecked. A preset that failed to load shows the host's diagnostic reason verbatim; it cannot be newly checked while unbound, and a bound one can still be unchecked. On the settings page the list comes from the host preset registry and reloads via "Refresh"; on a read failure the saved bindings are shown and can still be unchecked.

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

### 3.2 async_wait

The unified wait entry: wait for messages and job results without targets, or wait on job and subagent targets.

| Argument | Type | Required/default | Rules |
| --- | --- | --- | --- |
| `wait_ms` | number | Required; no default | Positive values clamped to minWaitMs..maxWaitMs; 0 is legal and means an immediate check |
| `targets` | array | Optional; defaults to no targets | Elements are `{kind, id}`; kind enumerates job/agent, id nonempty; duplicates deduplicate to one target |

Without targets, the wait may return on processable messages and this package's job results. With targets, it waits for target terminal states (jobs) or changes (subagents); non-target messages do not end the wait. `wait_ms=0` returns current states and any undelivered content immediately, without a wait segment. All checks of a zero-wait call share one short check window (1000 ms): queries that do not finish within it return the affected targets as `unconfirmed` instead of blocking the call, and each query is issued exactly once. Naming an already-delivered job explicitly in a zero-wait call is also the recovery exit: an output whose delivery was never confirmed is re-delivered (first line carries a "recovery copy" marker, distinguishable from the first delivery); a confirmed one returns only its status line with an already-delivered note; when the copy has expired or is unavailable, the note states that honestly with the terminal facts and any retained-file clues — no body is fabricated. A recovery copy is not an archive: by default it is retained for at most 30 minutes, and it is also subject to per-session caps of 10 entries and 2×`maxResultChars` characters in total (the oldest is evicted first) and to cleanup when the plugin row is unloaded, so it can lapse before the deadline; save results you need to keep when they arrive.

A job terminal result is `{status:'completed'|'killed'|'failed', job_id, output, truncated, waited_ms}`. A subagent change is `{status:'changed'|'settled', agent_id, waited_ms, note}`. Wait-shaped results are `{status:'running'|'budget'|'interrupted'|'message'|'cancelled'|'no-work'|'unconfirmed', waited_ms, note}` — `no-work` has two sources: the entry check itself confirms there is no wait-worthy work and the call never suspends (`waited_ms` is the actual time the checks took inside the unified check window, not a suspension), or a periodic recheck while suspended confirms all wait-worthy work has ended and returns early (`waited_ms` is the actual time spent waiting); the `note` text distinguishes the two processes, and `waited_ms` tells which occurred. `unconfirmed` means the waiting condition could not be established (a listing failed or timed out) — its difference from `no-work` is **confirmation, not the presence of work**. Without targets, the entry first collects ready job results into the return and suspends only when wait-worthy work is confirmed (a running background job or a running subagent of yours). Multi-target results carry the other targets' proven states in `targets`; a job target that has disappeared by the time of an exit is annotated `not_found` there. Entry validation of a named job target is a **whole-call rejection**, not a status annotation (this also applies when a preexisting settlement notice is present): an id absent from the live listing fails the call with a readable error (suggesting job_list for live ids), while a failed listing produces a different readable error (the job may still exist; retry async_wait later — this is not "unknown job"). Other jobs settling in the same batch are carried in `outputs` entries; `delivered` is batch metadata. See section 4 for consuming reads and delivery.

### 3.3 async_agent

| Argument | Type | Required/default | Rules |
| --- | --- | --- | --- |
| `description` | string | Required | Provide a 3–5-word display label |
| `prompt` | string | Required | Provide the complete task; an independent spawn child cannot see the parent conversation |
| `cwd` | string | Parent's current effective directory | Specify the child's initial working directory; relative paths resolve against the parent's current directory, and later directory changes are independent |
| `provider` | string | Optional; paired with model | Specify the exact LLM provider ID for this child; when provided it must be paired with model |
| `model` | string | Optional; paired with provider | Specify the exact model ID for this child; when provided it must be paired with provider — query IDs per section 5 first |
| `reasoning_effort` | string | Optional | Specify a reasoning-effort ID; may be supplied alone, checked against the effective model |
| `agent_preset` | string | Conditionally available | Assign the child an independent preset; appears only when the row-level allowed set is nonempty and the backend supports it, and the value must be in that set |

There is no `run_in_background` argument and no wait for the final answer. Success immediately returns `{status:'started', agent_id, note}`, with the effective route source and wait guidance. Rejection does not invent an ID. The shipped presets do not configure an allowed preset set, so agent_preset is not exposed. A context-inheriting backend can expose the parent conversation to its child; write tasks according to the actual backend.

Usually, a task prompt is sufficient. To choose a model, query exact IDs as described in section 5, then supply `provider` and `model` together; `reasoning_effort` may be supplied alone but is checked against the effective model.

**Advanced merging and preflight:** row configuration `agentOptions`/`agentPreset`/`allowedAgentPresets` is fixed configuration for advanced composition, not call arguments and not part of the 20 UI settings. An explicit route or effort choice, or row `agentOptions` containing `provider`, `model`, or `reasoningEffort`, triggers a support check before creation; non-route options such as `maxTokens` alone do not. Backend `agentRouteDefaults` join the merge only when preflight is triggered. Explicit arguments override row options, row options override backend defaults, and missing route components come from the parent. Allowed-set checks still apply only to explicit choices; a row default triggering preflight does not make the request explicit.

**What creation receives:** if any layer contributes options, the creation request carries the merged `agentOptions`. Otherwise it omits that field and lets the host inherit parent options, without additionally applying backend route defaults. A compatible parent effort or model default used temporarily by preflight is not copied back from the preflight result into the creation request. Actual child inheritance depends on that request and the host merge, not merely on the preflight values. When the route changes without an explicit effort, preflight does not reuse an incompatible effort from the old route.

### 3.4 async_workflow

Use this only for an explicitly requested workflow or large-scale orchestration. Use async_agent for one or two delegations.

| Argument | Type | Required/default | Rules |
| --- | --- | --- | --- |
| `script` | string | Required | Plain JavaScript function body; top-level await allowed; return a JSON-serializable value |
| `meta` | object | Required | Required string name and description; optional whenToUse and phases array |
| `args` | object | Optional | Available unchanged as args; wrap a bare list in an object field |
| `yield_ms` | number | defaultYieldMs | Same clamping as run |

A short kebab-case name is recommended. Phase entries require title and optionally accept detail/provider/model strings. The tool-entry schema lets additional meta and phase keys pass shape validation, but the current workflow engine rejects unknown meta/phase fields before launch with `META_INVALID`; only the keys listed above are actually consumed. The script is not TypeScript or a module; do not write `export const meta`.

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

Completion returns `{status:'completed', result}`; result is a rendered string, not the original JSON object. A killed run returns `{status:'killed', detail?}`; a background run returns `{status:'running', job_id, elapsed_ms, note}`. A background run's result is delivered through async_wait or a completion message; job_kill requests cancellation. Missing workflow wiring returns a readable error before startup and creates no jobs. See section 7 for composition.

### 3.5 async_list_subagent_models

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

## 4. Wait states and direct delivery

Read the returned state before choosing the next action. Budget expiry usually returns `running` (with targets) or `budget` (without): this wait ended without stopping the background work. Entry queries, existence checks, retries, and the wait segment all share one `wait_ms` budget, rather than each receiving a fresh budget.

Job results are delivered directly: when a job settles, its result body is attached to an in-flight wait return (`output` and `outputs` entries) or arrives as a completion message; no separate retrieve call is required. Deferred entries are claimed with `async_wait(wait_ms=0)`.

Messages can also end a wait early. User steering addressed to the current Agent, claimable notices, relayed Agent messages, and package late answers are checked, including messages already present at entry. Queued messages remain for the next turn and do not interrupt this wait. A targeted wait ends only on target changes, target messages, or user steering; a message means there is new content to process, not that the target completed.

| Result | Next action |
| --- | --- |
| `running`/`budget` or a message wakeup | Handle the message or independent work; wait again on the same targets when blocking is needed |
| Job `completed` | Read the result and check the exit code; completion does not imply exit zero |
| Job `failed` / `killed` | Keep the error, signal, and available output before deciding how to proceed |
| Child `changed` / `settled` | Read the separate settlement message and final answer; do not treat it as proof of success |
| Query or read failure | Retry the original target as instructed, without restarting the task |

Canceling a wait or stopping the current turn ends only the wait, not the background command or workflow. The host may replace the cancellation return with an error. If the model never received job_id, recover it from job_list or the completion message; do not repeat a possibly side-effecting command. Use job_kill to stop a job. Use the host's interrupt_agent/management entry to stop a child, and send_message to continue its conversation.

settled means the child is not currently observed running. It does not mean success, answer delivery, or permanent termination. Read the separate settlement message. If final text has not arrived, do independent work and let the message arrive on its own via host delivery; when you truly need to block, use a bounded `async_wait` instead. Child relationship and running state are separate checks; query failure cannot establish not_found or settled.

Reads advance the incremental output cursor. The first successful terminal read delivers the final result once, merged into the same response. Later reads do not replay consumed text. A read error requires retrying, not interpreting the result as empty; a failed read during a `wait_ms=0` increment pickup is explicitly annotated with a retry path — the failure consumes no increment, and after recovery the same zero-wait call retrieves all unconsumed content. Inspect exit codes, signals, and failed/killed notices even when execution completed.

Long results can lose content in two different ways. `maxResultChars` is a quota **shared by all result content in one delivery batch**: the multiple results reaching the model input in one batch — first-wait direct returns, wait-return batch entries, and completion messages — draw on this single cap, first come first served; a single oversized entry keeps its head and tail with the omitted amount marked, and the omitted middle stays in the ledger buffer, recoverable via later batches or `async_wait(wait_ms=0)` — never lost to truncation. Counting is JavaScript `String.length`. A host `lossy` marker instead means buffered content has already been lost. Status, loss explanations, and temporary-file clues are outside the body budget.

The host may write output to temporary files (spill) and return their absolute system-temporary paths in `spillPaths`. Open them only where authorized and promptly save necessary contents to an appropriate location. Output and files can contain secrets; review and redact before sharing. Temporary files can disappear. Without a returned path, do not assume a complete disk copy exists.

## 5. Model catalogs, authorization, and inheritance

Use the host's existing subagent model-selection settings. Each later async_agent call requesting a route/effort reads the current switch and allowed set, including in existing sessions, then rechecks permission before launch. Disabling selection rejects explicit choices; fully omitted choices still follow defaults/inheritance. Running children keep their model. Read failures, invalid policies, and withdrawn permission produce a refusal with the real cause, not an automatic model substitution. A contract-external policy shape (the policy value is not an object, or `allowedModels` is missing, not an array, or has non-object elements) and a failing backend provider lookup each have their own error (`policyShapeRejected` / `providerQueryFailed`) carrying the host's original cause, not reworded into switch or allow-list wording.

Discovery creates no child, performs no inference, and does not validate credentials or remote availability. allowed/not-allowed/unconfirmed describe applicability to the selected target, not universal authorization. Native creation tools retain their own session policy; the plugin's live policy does not change them. Workflow agent() also has a separate contract.

Set target_tool to remove ambiguity. With no target, exactly one recognized candidate can be selected automatically; multiple or zero candidates remain unconfirmed. An explicitly named invisible target is not-allowed while catalog browsing can still succeed. Use exact IDs and an effort the target accepts. Do not pass search/pagination arguments to creation. On refusal, query again for the same target rather than changing tools to bypass restrictions.

## 6. Question takeover and silent failures

To answer in the pending-question panel, enable `askTakeover` in settings and save; it is off by default. When enabled, ordinary questions from root Agents on the `boundPresets` list enter the panel — the switch decides whether takeover happens, and the list decides the scope. Plan review, approvals, and presets outside the list retain the native host flow. The takeover entry validates the question set: if `questions` is not an array, or a single question carries duplicate options whose labels and descriptions are both identical (or both absent), the whole batch is rejected with a readable error and never reaches the panel — same label with a different description is not a duplicate, and a multi-question batch is never partially taken over because of one bad question.

With `sidebar`, an unanswered count appears at the sidebar bottom; click to expand. With `overlay`, questions appear at the lower right. The panel lets you open the original session, answer, ignore, or extend the wait.

Check the question type before answering. Single-choice questions accept one preset option or the custom answer. Multiple-choice questions can combine them, with custom text submitted as an independent answer rather than a suffix. Nothing starts selected, and a recommendation is not a selection. Clicking the custom input or entering non-whitespace text selects it; moving keyboard focus alone does not.

The custom answer uses a multi-line input: the first row holds the choice control and its title, and the input below spans the available width at about three lines tall, resizable vertically. Enter inserts a line break instead of submitting, and confirming an IME composition never submits by accident; submission uses the button. Line breaks and text are delivered verbatim, and the whitespace-validation and preset-selection rules are unchanged.

Deselecting the custom answer may retain its draft, but the draft is not submitted. Clicking its input or entering valid text selects it again. Clearing selected custom text does not restore an earlier selection. No selection, or a selected whitespace-only custom answer, prevents submission—even if a multiple-choice question has other selected options. Use the separate Ignore action to leave a question unanswered. The server also validates options and selection relationships.

Questions from one call share a deadline. At expiry, answered and ignored items retain their state. Unanswered items return `selected=[]` with a timeout explanation in `custom`. The Agent continues the task without choosing an answer for the user. A timeout without a reply is not permission — when a necessary decision lacks an answer, state the blocker instead of treating expiry as consent.

For more time, use the session group's extension action. It adds `askExtendMs` to the existing deadlines of batches still active at click time. New batches are unaffected, and expired batches do not start waiting again. If acknowledgement is missing, refresh and check the actual deadline before retrying, to avoid adding the extension twice.

You can still answer in the panel after expiry. The late notification returns to the original session with the full question, every option and description, multiple-choice relationship, actual answer or ignore status, and timing. Offered options are separate from actual choices; unselected custom drafts are excluded.

If the session is idle with no package delivery waiting to start, the host uses `followup` to start a turn. Otherwise it uses `inject` for the next claim point. The package wakes a wait only after the host accepts delivery.

Check the submission outcome. On an explicit failure, follow the displayed reason and reply directly in the originating session. Do the same for a missing record marked `undelivered` — the batch is no longer registered or the question id is not in the batch, with answers and ignores judged alike. If acknowledgement is merely missing, let the panel refresh before concluding that delivery failed. Do not resubmit when `gone` means another client already answered.

24 hours is a lazy-cleanup threshold: expired records older than 24 hours are removed only when a new batch is intercepted. With no new batch they may last longer, and late submission itself is not rejected just because 24 hours elapsed. Restart or uninstall loses in-memory expired records and returns pending requests to the native flow. Save needed answers in the original session promptly.

silentFailureGuard defaults to false and applies to sessions on the `boundPresets` list (by default, this package's two presets). It conditionally adds result diagnostics, description warnings, and execution instructions; the description warning is present from a bound session's very first tool-description projection — no prior execution needed. Capturing commands in a restricted environment can fail silently before process creation. If there is no output and no exit marker, confirm execution with a harmless bare invocation and inspect host logs, rather than assuming success. A warning is not proof that every capturing command failed. Wider-permission retries still require the same-turn approval process.

## 7. Advanced composition

Tools can be mounted independently in custom presets, and discovery can coexist with native discovery. Custom composition does not automatically disable existing synchronous tools. Each config.toolName chooses one tool; a row without it is the host-configuration role. Workflow requires an engine in an isolated delegation group. This example includes all five tools, not the other features of a complete preset.

```yaml
- id: async-run
  name: dsh-async-tools
  config: { toolName: async_run }
- id: async-wait
  name: dsh-async-tools
  config: { toolName: async_wait }
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
