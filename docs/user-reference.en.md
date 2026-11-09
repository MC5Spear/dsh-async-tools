# User reference

[中文](<user-reference.md>) · [English home](<../README.en.md>)

Find the task you need:

- [Installation and source identity](<#1-installation-identity-and-prerequisites>), [first task and settings](<#2-first-use-and-settings>).
- [All five tools and their arguments](<#3-tool-arguments-and-results>), [wait states, continued output, and recovery](<#4-wait-states-and-direct-delivery>).
- [Discover a model, then create a child](<#5-model-catalogs-authorization-and-inheritance>), [answer questions and diagnose missing command results](<#6-question-takeover-and-silent-failures>).
- [Mount all features in a custom preset](<#7-advanced-composition>), [remove the plugin or report a problem](<#8-disable-recover-and-report-problems>).

## 1. Installation identity and prerequisites

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.8+dsh.0.2.1-rc` |
| Supported dsh host versions | `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5` |

DSH must be one of these four versions. They share a compatibility line. The final `0.2.1`, `0.2.0`, `0.2.2`, and any new rc outside this set are rejected.

Node.js 24 is recommended. The plugin's `>=20` declaration applies only to the plugin. The host's commander 15 dependency requires `>=22.12.0`, but that is only a known lower bound, not a verified minimum for the whole host. Confirm that the target host's dependencies resolve on the chosen runtime before installing.

### Verification scope and deployment decisions

Existing verification is limited to a local Windows machine and isolated instances. The full plugin module suite and static checks passed under each supported host. Real-browser checks covered key settings-page and question-overlay behaviors and accessibility trees. Real model sessions sampled the five tools' core behaviors: background delivery, waiting and user steering, child continuation, and late answers. An installation artifact was also installed through the official CLI into an isolated instance, checking the tool roster, preset patches, and dependency tree. These checks do not establish item-by-item real-host coverage of every feature on every host.

Consider these remaining gaps before deploying:

- Real-machine Linux behavior, including commands and one-shot permission escalation, has not been verified. There are no verification conclusions for macOS or remote environments.
- Real OS input methods, screen readers, and touch input have not been verified.
- The precise real-host timing in which a constructed tool result is rewritten to a cancellation error before commit remains unverified.
- Item-by-item real-machine re-verification on rc.3/rc.4 is incomplete, although module suites and static checks cover them.
- The four-version remote CI matrix is configured but has not run remotely.

Arrange isolated verification with the maintainer when deployment depends on these environments or behaviors. Results from older rc.2/rc.5 installations do not automatically cover later mechanism changes. Per-item records are in `docs/design.md` §9.3 at the matching source commit. Design, changelog, and development verification materials are not shipped with the package; obtain a checkout matching the installed source from the [source repository](<https://github.com/MC5Spear/dsh-async-tools>). Release history is not an installed-version lookup.

### Install, pin a source, and check the version

The package is not distributed through npm. Run this in a terminal, or enter the same GitHub address in DSH's plugin-manager installation dialog:

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1
```

The address follows a moving branch. An unqualified address such as `github:MC5Spear/dsh-async-tools` does not automatically select the appropriate host adaptation. To pin a source:

1. Check out the intended revision that is actually available from the repository, then record its full commit ID with `git rev-parse HEAD`.
2. Replace the branch name after `#` in the installation address with that full commit. A local commit is not necessarily available remotely.
3. After installation, inspect `package.json` in this package's installation directory for the target profile. Check that `version` matches the selected source, and keep the actual installation address and full commit as the source record. A version number alone does not establish commit identity; the changelog cannot replace checking the installation.

Open this package's detail page and confirm that its settings form is visible. Create a session and check that `dsh-async` and `dsh-async-create` are available. Selecting either should give the Agent all five tools documented here.

### Installation troubleshooting and development links

If source retrieval fails, check the repository address and commit, then the network or proxy. If it still fails, ask the maintainer supplying the source about available artifacts. If settings or tools are missing:

1. Check the host version against the support set and inspect load logs for a version-mismatch rejection.
2. In the target profile, check the dependency registration (installed package) and bundle registration (host-row and preset composition declarations). Their purposes differ; one registration alone does not confirm that every entry loaded.
3. After composition or client-entry changes, reload the instance and reopen the page. Arrange for active sessions to finish safely before restarting, and restart outside the service process tree. Ordinary valid settings saves need no restart.

Development links are for explicit development environments. Keep stable deployments separate from the editing tree:

```powershell
git clone https://github.com/MC5Spear/dsh-async-tools.git
cd dsh-async-tools
git checkout adapt/dsh-0.2.1
npm install
dsh plugin --profile web add <absolute-clone-directory>
```

The linked directory must resolve matching host dependencies. Importing modules with Node checks only part of resolution, not complete host-service, tool, or page integration.

## 2. First use and settings

### A first task

Both shipped presets provide all five tools directly without rewriting existing presets. Inspection, messaging, and explicit stopping remain host management operations. Create a session with `dsh-async` for general coding, or `dsh-async-create` to retain plugin and preset authoring tools.

In a Windows PowerShell environment, paste this harmless request to the Agent:

> Demonstrate background execution without modifying files, accessing the network, or creating children. First use async_run to run `Write-Output SHORT_OK`. Then run `Start-Sleep -Seconds 30; Write-Output LONG_DONE` with yield_ms=20000 explicitly. Keep the returned job_id. When waiting is needed, use async_wait targeting that job with wait_ms=30000 explicitly. Report both markers and actual exit information. Do not repeat the command to check progress; if no identifier arrived, recover it with job_list first.

Expect `SHORT_OK` directly, then a `job_id` after the long command's initial wait of at most 20 seconds. The result containing `LONG_DONE` arrives in a wait return or completion message. Still inspect exit information. These are equivalent Agent tool calls, not terminal commands:

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless test marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=20000)
async_wait(targets=[{kind:"job", id:"<returned job_id>"}], wait_ms=30000)
```

The factory `yield_ms` default is 20000 ms, with request bounds of 20000–600000 ms; out-of-range requests take effect at the nearest boundary. Continue independent work while the job runs, and wait when its result is needed. Every wait requires an explicit `wait_ms`, with no default. See [wait arguments](<#32-async_wait>) for other usages.

### Edit and save settings

1. Open the plugin list → this package's detail page → the form between its description and component rows.
2. Edit the required fields and select Save. Edits are drafts until saved. Leaving discards unsaved drafts; failed saves retain them. Help buttons only expand explanations.
3. Check field values and override indicators after saving. Ordinary valid saves need no restart.

Writes require the host's local loopback settings endpoint. For a read-only page or non-loopback address, follow the page's guidance to a writable endpoint.

A field's Restore default action stages removal of just that field's user override and also requires Save. Other overrides remain unchanged. The field then takes its composition value, using the factory default only when the composition has no value. For example, a composition value of `45000` overridden with `90000` returns to `45000`, not `20000`. With a valid configuration, the field should no longer be marked Overridden. If a degraded-mode warning remains, follow [configuration recovery](<#configuration-warnings-and-recovery>); Save success alone does not establish recovery.

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
| `pollIntervalMs` | number | `500` | 1..2147483647; fractions allowed | ms | New wait's fallback state polling and existence retries; suspended periodic rechecks align to this cadence (actual interval never below the 50 ms timer floor; a query overrunning its window defers to the next period; overall bound is effective wait_ms + 300 ms) |
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

Cross-field constraints are `minYieldMs <= defaultYieldMs <= maxYieldMs`, `minWaitMs <= defaultWaitMs <= maxWaitMs`, and `pollIntervalMs <= maxWaitMs`. Budget numbers must be finite. The factory maximum for both initial and later waits is 600000 ms. `defaultWaitMs` is an example budget, never a substitute for a missing `wait_ms` argument.

### Applicable presets and the two switches

`boundPresets` scopes the package's operating instructions and auxiliary features by each session's **current effective preset**. If several presets reuse the same tool, sessions on unchecked presets remain unaffected.

| Feature | Required conditions |
| --- | --- |
| Asynchronous operating instructions added to the Agent's system prompt | Current preset is listed; no separate switch |
| Silent-command-failure diagnostics and warnings | Current preset is listed and `silentFailureGuard=true` |
| Ordinary questions handled by the pending panel | Current preset is listed and `askTakeover=true` |

The list defaults to `dsh-async` and `dsh-async-create`; both switches default to off. Uncheck all entries and save the legal empty array `[]` to unbind everything. **Binding neither adds/removes tools nor rewrites preset composition.** A custom preset still needs the five tools mounted manually and the workflow engine wired correctly; see [advanced composition](<#7-advanced-composition>).

The settings page obtains candidates from the host preset registry; Refresh reads it again. A bound ID absent from the current catalog remains visible and can be unchecked. A failed-to-load preset shows the host's diagnostic reason verbatim: an unbound one cannot be newly checked, while a bound one can still be unchecked. If registry reading fails, saved bindings remain available for removal instead of appearing as an empty list.

### Advanced file configuration and migration

Value precedence is **user override > composition configuration > schema default** (the default in the configuration definition). A user-layer field is an override even when its value equals the default.

Put file-based settings under the host row's `config.settings.<field>`, not at the `config` root. The 0.2.5 flat form, `config: { agentLang: zh, … }`, does not take effect on 0.2.8: the row can activate while composition-provided settings fall back to defaults. Before upgrading, change it to `config: { settings: { agentLang: zh, … } }`. The matching source commit's `CHANGELOG.md` includes the side-by-side migration, symptoms, and load-warning details. That file is not shipped; section 1 explains source access.

Tools first read the host's current configuration snapshot. Only when it is absent do they use valid tool-row fallback values and report that settings are not connected. `toolName`, `owningPreset`, and delegation-row options are fixed row configuration, not among the 20 UI settings.

### Configuration warnings and recovery

**Which values are used in degraded mode?** Damaged boolean values or broken cross-field constraints at startup can trigger repairable degraded mode. The form still shows the stored configuration, but tools use valid factory defaults. If a new invalid configuration arrives during operation, tools keep the previous valid values. Ordinary new invalid writes are rejected before persistence and do not replace a valid configuration. A numeric or enum schema-validation failure may instead prevent the plugin row from loading; inspect the load log and correct the fields it identifies.

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

Choose the call by purpose. These are Agent tool-call illustrations; each explicitly supplies `wait_ms`:

| Purpose | Example | Return condition |
| --- | --- | --- |
| Wait for messages or job results | `async_wait(wait_ms=30000)` | Delivers ready results first; waits for messages/results only if a running job or child of yours is confirmed |
| Wait for a job | `async_wait(targets=[{kind:"job", id:"<job_id>"}], wait_ms=30000)` | The job reaches a terminal state, user steering arrives, or the budget expires |
| Wait for a child change | `async_wait(targets=[{kind:"agent", id:"<agent_id>"}], wait_ms=30000)` | Target change/message, user steering, or budget expiry; the final answer is delivered separately |
| Check without waiting | `async_wait(wait_ms=0)` | Returns current states and undelivered content; also picks up deferred results |

Targets may mix jobs and children. Any eligible target can end the wait; non-target notices do not end a targeted wait early. See [section 4](<#4-wait-states-and-direct-delivery>) for continued output and recovery copies.

**Result fields**:

```text
Job terminal: {status:'completed'|'killed'|'failed', job_id, output, truncated, waited_ms}
Child change: {status:'changed'|'settled', agent_id, waited_ms, note}
Wait exit: {status:'running'|'budget'|'interrupted'|'message'|'cancelled'|'no-work'|'unconfirmed',
            waited_ms, note}
```

Other jobs ready in the same delivery window appear as `outputs` entries; `delivered` is batch metadata. Multiple-target returns also include structured `targets`. Visible text shows at most 8 target status lines and a count for additional targets. Section 4 explains the states and next actions.

**Timing details:** entry queries, existence checks, retries, and the actual wait share one budget. During an untargeted wait, periodic checks follow `pollIntervalMs`; confirmation that all work has ended returns early. A failed recheck keeps waiting rather than establishing no work, with unconfirmed reads noted at expiry. The actual interval is at least 50 ms; a query overrunning its window defers to the next period. The overall bound is effective `wait_ms+300 ms`.

A zero-wait call still performs checks. They share a 1000 ms window, each query is issued once, and unfinished queries mark affected targets `unconfirmed`. `waited_ms` reports actual checking time rather than always reporting zero merely because the call did not suspend.

**Entry validation failures:** all targets must be validated before returning target notifications or terminal results. An invalid target in a mixed request rejects the whole call, not just one status row, even if a settlement notice is already waiting.

- Job ID absent from the listing: a readable error directs the caller to `job_list` for registered IDs.
- Job listing failed: a different error says the job may still exist. Retry the same target later; failure is not absence.
- Child absent from the directory during a positive wait: at most three query periods are retried within the total budget. Continued absence produces an error with known-child diagnostics. If the budget expires before a query completes, return `unconfirmed`. Zero-wait calls do not repeat queries this way.

An untargeted entry returns `unconfirmed` if reads fail and no running work is confirmed; with at least one confirmed running item it can wait. If only child targets are present, some have unknown states such as failed reads, and none is confirmed running (possibly mixed with known static targets), affected targets return `unconfirmed` instead of suspending solely on uncertainty. Targets all confirmed static return immediately with their static states.

### 3.3 async_agent

| Argument | Type | Required/default | Rules |
| --- | --- | --- | --- |
| `description` | string | Required | Provide a 3–5-word display label |
| `prompt` | string | Required | Provide the complete task; an independent spawn child cannot see the parent conversation |
| `cwd` | string | Parent's current effective directory | Specify the child's initial working directory; relative paths resolve against the parent's current directory, and later directory changes are independent |
| `provider` | string | Conditionally available; paired with model | Available when the backend declares routing-option support; exact LLM provider ID |
| `model` | string | Conditionally available; paired with provider | Same condition; exact model ID, queried per section 5 |
| `reasoning_effort` | string | Conditionally available | Same condition; may be supplied alone, checked against the effective model |
| `agent_preset` | string | Conditionally available | Assign the child an independent preset; appears only when the row-level allowed set is nonempty and the backend supports it, and the value must be in that set |

There is no `run_in_background` argument and no wait for the final answer. Success immediately returns `{status:'started', agent_id, note}`, with the effective route source and wait guidance. Rejection does not invent an ID. The shipped presets do not configure an allowed preset set, so agent_preset is not exposed. A context-inheriting backend can expose the parent conversation to its child; write tasks according to the actual backend.

A label and complete task prompt are usually enough; the model uses configured defaults or inheritance. `subagentProvider` selects the execution backend (default `spawn`), not the LLM provider. The three model arguments appear only when that backend declares routing-option support. Passing them without support produces a readable rejection rather than silently ignoring them. See [section 5](<#5-model-catalogs-authorization-and-inheritance>) for discovery, creation, waiting, and advanced default merging.

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

The script must explicitly return a root value. A missing `return` producing `undefined` is a runtime error; a deliberate `return null` is valid.

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

### Understand why the wait ended

Ending a wait does not stop background work. Budget expiry is usually `running` for a targeted call or `budget` for an untargeted one. Check the actual target states before deciding to wait again.

| State or observation | Meaning and next action |
| --- | --- |
| `running` / `budget` | This budget expired. Do independent work; wait on the same target again only when the result is needed |
| `interrupted` / `message` | User steering or a processable message ended the wait early. Handle it without assuming target completion |
| `cancelled` or a host cancellation error | This wait was canceled; background work was not stopped. Recover a missing identifier from `job_list` or a completion message |
| `no-work` | Checks confirmed there is no work to wait for, either at entry or during a periodic check after waiting began. `note` distinguishes them; `waited_ms` is actual checking/waiting time |
| `unconfirmed` | Failed or timed-out queries could not establish the waiting condition. This is not confirmation of no work; recheck the original target as instructed |
| Job `completed` | Read the result and exit code; completion does not imply exit zero |
| Job `failed` / `killed` | Preserve the error, signal, and available output before deciding how to proceed |
| Child `changed` / `settled` | A change, or no longer being observed running, is not proof of success. The final answer arrives separately |
| Query or read failure | Retry the same target, not the task. A failed read consumes no increment |

User steering, claimable notices, relayed Agent messages, and package late answers trigger message checks, including messages present at entry. Queued messages remain for the next turn and do not interrupt the wait. Non-target messages do not end a targeted wait early.

Use `job_kill` to actually stop a job, the host's `interrupt_agent` or management entry to stop a child, and `send_message` to continue its conversation. Do not repeat a possibly side-effecting task to inspect progress.

`settled` does not mean a child can never run again. If its final answer has not arrived, do other work; if none remains, report progress and end the turn so host delivery can bring the message. A static target makes `async_wait` return immediately; repeated calls cannot wait the text out. Do not create sleep jobs to keep waiting. Child relationship and running state are checked separately; query failure establishes neither `not_found` nor `settled`.

Multiple-target returns describe only confirmed states. Failed reads are marked separately, absent jobs use `not_found`, and expiry notes distinguish all/some/none still executing rather than counting unknown states as running.

### Normal results arrive directly

A finished job's body arrives in the initial-wait return, an in-flight `async_wait` return (`output` / `outputs`), or a completion message. There is no separate retrieval tool to call. Reads advance the consumed position: the first successful terminal read includes the final result once, and later reads normally do not replay consumed text. Save anything that must be kept.

A read failure is annotated with a retry path, not presented as empty output. It does not advance the incremental position; after recovery the same zero-wait call can retrieve unread content.

### Shortened output or deferred entries: continue reading

```text
async_wait(wait_ms=0)
```

This picks up content not yet delivered. `maxResultChars` is **shared by all result content in one delivery batch**, with a factory default of 12000, measured by JavaScript `String.length`, not bytes. Initial-wait direct returns, wait returns, and completion messages share that batch quota. The target triggering delivery has priority; other entries receive their shares in readiness order. A batch contains at most 10 entries, including empty ones.

An oversized entry keeps its head and tail with the omitted amount marked. Its middle remains buffered for later batches or zero-wait pickup. Excess entries are deferred. Neither case is actual host-buffer loss. Status, necessary terminal explanations, loss notices, and temporary-file clues are outside the body quota.

With `fullCommandEcho=true`, background batches also attach command/script source text within the same quota. Body content has priority; source uses the remainder, keeps head/tail in a 6:4 ratio when shortened, and appears at most once per job per batch. Initial-wait direct results and listing tools do not attach source. A command job is listed under its `description`; a workflow job uses `meta.name`.

### A tool result may not have arrived: request a recovery copy

If the host rewrites a constructed tool result as a cancellation error, its body may never reach the Agent. Recover the original job ID and explicitly name it in a zero-wait call:

```text
async_wait(targets=[{kind:"job", id:"<original job_id>"}], wait_ms=0)
```

Unread middle sections or deferred entries are delivered first. Otherwise, portions whose delivery the host has not confirmed can be resent in order, marked “recovery copy / may duplicate.” Large portions continue across batches by character position, without repeatedly sending the same slice. Confirmation is handled by the host; no additional user confirmation action is needed. Confirmed content returns only status and an already-delivered note, not arbitrary historical replay.

Recovery copies are retained **for at most 30 minutes by default**, with per-session caps of 10 records and 2×`maxResultChars` characters in total. Oldest entries are evicted first, and unloading the plugin row clears them. They can therefore expire earlier; recovery is not guaranteed throughout those 30 minutes. An unavailable copy yields terminal facts and known retained-file clues, not an invented body.

### The host reports lost buffering: inspect known retained paths

`lossy` means the host buffer has actually lost content, unlike display shortening. If the host reports `spillPaths`, results include those retained-output paths whether or not `lossy` is set; their location is determined by the host. Open them only where authorized, save required content promptly, and redact before sharing.

Temporary files may be cleaned up and are not guaranteed to contain the complete result. Without a returned path, the plugin has no known recovery route. Do not assume a full disk copy exists or repeat a side-effecting command automatically.

## 5. Model catalogs, authorization, and inheritance

### Discover, create, and wait

Usually omit model choices to use configured defaults or inheritance. Follow this path only when an explicit choice is needed and the backend declares routing-option support. IDs below are placeholders to replace with exact query results.

1. Query for the intended creation tool using `target_tool` so that different entry points' rules are not confused:

   ```text
   async_list_subagent_models(query="coding", target_tool="async_agent", page_size=20)
   async_list_subagent_models(provider="<provider ID>", model="<model ID>", target_tool="async_agent")
   ```

2. Read `verdict` and `basis`. For another page, reuse the returned `next`; if its version expires, restart on page 1. `allowed` means applicable to this target, not that credentials or remote availability have been verified. Discovery neither creates a child nor runs model inference.
3. Supply exact provider/model IDs together and a self-contained task. If an effort is needed, use a `reasoning_effort` accepted by that model:

   ```text
   async_agent(description="Review one isolated item", prompt="<complete task, materials, and completion criteria>",
               provider="<provider ID>", model="<model ID>")
   async_wait(targets=[{kind:"agent", id:"<returned agent_id>"}], wait_ms=30000)
   ```

4. Creation immediately returns `agent_id`. Keep it and do independent work; wait for target changes when the result is needed. The final answer arrives as a separate message, not as the `changed` / `settled` state itself.

### Current policy and refusals

Every `async_agent` creation with an explicit model or effort reads the host's **current policy** switch and allowed set, even in existing sessions, then rechecks permission before launch. Saved policy changes affect later creation, not running children. Disabling selection rejects explicit requests; fully omitted choices still follow defaults/inheritance.

Read failures, invalid allowed sets, or withdrawn permission produce the actual cause, not automatic model substitution. A policy value that is not an object, or `allowedModels` that is missing, not an array, or contains non-object elements, produces `policyShapeRejected`. Backend route-query failures produce `providerQueryFailed`, preserving the host cause rather than misreporting a disabled switch or disallowed model.

Query verdicts `allowed` / `not-allowed` / `unconfirmed` apply only to the chosen target, not universally. Without `target_tool`, exactly one recognized candidate is selected automatically; zero or multiple candidates remain `unconfirmed`. A named but invisible target is `not-allowed`, although catalog results can still be returned. Catalog absence alone does not establish lack of support; partial provider failures count only obtained results.

Do not pass pagination/search arguments to creation. On refusal, query again for the same target instead of changing entry points to bypass limits. Native tools keep their own session policies. Workflow `agent()` has a separate contract, in particular no paired provider/model requirement from `async_agent`.

### Advanced row configuration: merging and preflight

`agentOptions` / `agentPreset` / `allowedAgentPresets` are fixed row configuration, not call arguments or members of the 20 UI settings.

- An explicit route or effort, or row `agentOptions` containing `provider`, `model`, or `reasoningEffort`, triggers a pre-creation support check (preflight). Non-route options such as `maxTokens` alone do not.
- Backend `agentRouteDefaults` join the merge only when preflight is triggered. Precedence is explicit arguments > row options > backend defaults, with missing route parts from the parent. Allowed-set checks still apply only to explicit choices; row defaults triggering preflight do not make a request explicit.
- If any layer contributes options, creation receives merged `agentOptions`. Otherwise that field is omitted for host inheritance of parent options, without additionally applying backend route defaults.
- A compatible parent effort or model default used temporarily during preflight is not copied back into creation. On a changed route without explicit effort, preflight does not reuse an incompatible effort from the old route. Actual inheritance depends on the request and host merge, not merely the preflight values.

## 6. Question takeover and silent failures

### Enable the panel and find questions

Enable `askTakeover` in settings and save; it is off by default. Ordinary questions from root Agents on the `boundPresets` list then enter the pending panel. Plan review, approvals, and presets outside the list keep the host flow.

With `sidebar`, click the unanswered count at the sidebar bottom to expand the panel. With `overlay`, questions appear at the lower right. The panel can open the original session, answer, ignore, or extend the wait. New questions gently announce the added count to assistive technology without moving focus or automatically reading the whole question. Countdown ticks and repeated refreshes do not repeat the announcement.

### Answer or ignore

Check the question type before answering. Single-choice questions accept one preset option or the custom answer. Multiple-choice questions can combine them, with custom text submitted as an independent answer rather than a suffix. Nothing starts selected, and a recommendation is not a selection. Clicking the custom input or entering non-whitespace text selects it; moving keyboard focus alone does not.

The custom answer uses a multi-line input: the first row holds the choice control and its title, and the input below spans the available width at about three lines tall, resizable vertically. Enter inserts a line break instead of submitting, and confirming an IME composition never submits by accident; submission uses the button. Line breaks and text are delivered verbatim, and the whitespace-validation and preset-selection rules are unchanged.

Deselecting the custom answer may retain its draft, but the draft is not submitted. Clicking its input or entering valid text selects it again. Clearing selected custom text does not restore an earlier selection. No selection, or a selected whitespace-only custom answer, prevents submission—even if a multiple-choice question has other selected options. Use the separate Ignore action to leave a question unanswered. The server also validates options and selection relationships.

While an IME composition is active, submission is disabled with a nearby explanation. Drafts and choices remain. After composition ends, validation runs again and an explicit submission is required; no delayed automatic submission occurs.

### Deadlines, extensions, and late answers

Questions from one call share a deadline. At expiry, answered and ignored items retain their state. Unanswered items return `selected=[]` with a timeout explanation in `custom`. The Agent continues the task without choosing an answer for the user. A timeout without a reply is not permission — when a necessary decision lacks an answer, state the blocker instead of treating expiry as consent.

For more time, use the session group's extension action. It adds `askExtendMs` to the existing deadlines of batches still active at click time. New batches are unaffected, and expired batches do not start waiting again. If acknowledgement is missing, refresh and check the actual deadline before retrying, to avoid adding the extension twice.

You can still answer in the panel after expiry. The late notification returns to the original session with the full question, every option and description, multiple-choice relationship, actual answer or ignore status, and timing. Offered options are separate from actual choices; unselected custom drafts are excluded.

If the original session is idle with no package delivery waiting to start, a late answer starts a turn (host `followup`). Otherwise it is delivered when the session next handles messages (`inject`). A wait is awakened only after the host accepts delivery.

### Missing acknowledgement or failed submission

Check the submission outcome. If late-answer delivery explicitly fails, the question returns to an open state and can be resubmitted as the panel instructs; replying directly in the original session is also an option. For a missing record marked `undelivered` — an unregistered batch or a question ID absent from its batch — reply directly in the original session; answers and ignores are treated alike. If acknowledgement is merely missing, let the panel refresh before concluding delivery failed. Do not resubmit when `gone` means another client already answered.

### Record retention and request validation

24 hours is a cleanup threshold, not a hard late-answer deadline. `expired` records more than 24 hours past expiry are removed only when a new batch is intercepted. With no new batch they may last longer. Late submission is not rejected solely because 24 hours elapsed. Restart or uninstall loses in-memory expired records and returns pending requests to the native flow; save needed answers in the original session promptly.

For callers diagnosing rejected questions: `questions` must be an array. Duplicate options within a question with identical labels and descriptions (or the same label and no description on either) reject the whole batch with a readable error before it reaches the panel. The same label with different descriptions is not a duplicate; a multi-question batch is not partially intercepted.

### A command should have produced output, but did not

`silentFailureGuard` defaults to `false`. When enabled, it conditionally adds diagnostics, tool-description warnings, and extra operating instructions only for sessions on the `boundPresets` list. Eligible sessions see the warning with their first tool descriptions, without any earlier execution. This is separate from asynchronous operating instructions controlled directly by list membership.

In some restricted environments, commands assigning output to variables, using subexpressions, or redirecting output (such as `2>&1`) may fail silently before process creation. **If expected output is missing and there is no actual exit information, check whether execution occurred.** Do not assume success from an empty result, or infer non-execution from a warning alone.

In PowerShell, a harmless invocation without output capture such as `Write-Output EXEC_CHECK` can check the execution channel; also inspect host logs. Do not rerun a possibly side-effecting original command as a test. A one-shot wider-permission retry is possible only if the deployment exposes those parameters, the command was just denied in the same turn, and host approval is obtained. A warning does not create an escalation entry where none exists.

## 7. Advanced composition

### Mount all five tools in a custom preset

Custom presets can use every asynchronous feature without switching to a shipped preset. First mount the tools, then decide which sessions receive instructions and auxiliary features.

1. Manually add the five tool rows below to the custom preset's composition. Each `config.toolName` selects one tool. A package row without it supplies host configuration; it does not mount all five tools automatically.
2. Put `async_workflow` and a workflow engine in the same group with `isolate: { workflowEngine: true }`, so the tool can obtain that group's engine. The example calls the group `delegation`.
3. Confirm that the four host services listed below resolve, reload safely, and check that all five tools appear in a session using the custom preset.
4. For asynchronous operating instructions, add the preset ID to `boundPresets` and save. For silent-failure warnings or the question panel, also enable `silentFailureGuard` or `askTakeover`, respectively.

**Binding does not mount tools; mounting tools does not add a binding.** These steps control availability and the scope of three features separately; see [the list and switches](<#applicable-presets-and-the-two-switches>). Discovery can coexist with native discovery, and custom composition does not automatically disable synchronous tools.

This example mounts all five tools; configure the custom preset's other features as needed:

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

Deleting a development link does not unload an already loaded module, and existing sessions may retain the original composition. Removing tools does not automatically stop jobs started by a session. Read required results and explicitly stop unwanted work before removal.

Commands inherit host permissions, approvals, sandbox, and the host-provided execution environment. Commands, output, and environment information can contain secrets. Model-visible registration errors are single-line and limited to 500 characters; full errors go to operator logs. Do not paste tokens, cookies, passwords, private URLs, or secret environment values into issues.

Report through [project issues](<https://github.com/MC5Spear/dsh-async-tools/issues>). Include full plugin/host/Node versions, OS, preset, relevant sanitized settings, a minimal harmless reproduction, expected and actual states, job_id/agent_id and timing, real exit markers, and sanitized log excerpts. Keep the original task identity for diagnosis rather than repeating destructive commands. This is a personally maintained third-party project: issues are accepted, external PRs are not, and there is no fixed response or repair schedule.

Documentation maintenance follows the [documentation principles (Chinese)](<documentation-principles.md>).
