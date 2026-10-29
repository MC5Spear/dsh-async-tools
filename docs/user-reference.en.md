# User reference

[中文](<user-reference.md>) · [English home](<../README.en.md>)

## 1. Version, installation, and first checks

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.5+dsh.0.2.1-rc.2` |
| Exact dsh host version | `0.2.1-rc.2` |

This reference applies to the versions above. DSH is the host application that loads the plugin and runs Agents. A bundle is the set of configuration loaded with the plugin; a host mismatch can prevent that whole set from loading. Check versions before installation. If tools or settings are missing, follow [section 8](<#8-risks-disabling-and-recovery>).

The plugin declares Node `>=20`. The host CLI depends on commander `^15.0.0`, which requires Node `>=22.12.0`. This establishes only part of the dependency lower bound, not the complete minimum for the host. Use the Node 24 toolchain supported by existing CI and actual use. Some isolated Windows verification exists; Linux commands and escalation, macOS, and remote environments have not completed verification. For these environments, describe the platform and required features in an issue so the maintainer can clarify support progress.

The package is not distributed through npm. The command below installs from the source repository at commit `97b7b27e8e66f225003dd80f85f7229b2372a3be`. The corresponding branch, `adapt/dsh-0.2.1`, can move; a branch name is not a fixed installation identity.

If the installation address does not yield the source, check the repository address and pinned commit, then the network or proxy. If it still fails, contact the maintainer who supplied the installation source about available installation artifacts.

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#97b7b27e8e66f225003dd80f85f7229b2372a3be
```

Alternatively, paste the complete address after `add` into DSH's plugin installation dialog:

```text
github:MC5Spear/dsh-async-tools#97b7b27e8e66f225003dd80f85f7229b2372a3be
```

After installation, check these locations:

1. Open the package in the plugin list. Check the full version against the table and confirm that its details page has a settings form.
2. Start a new session and find `dsh-async` and `dsh-async-create` in the preset selector.
3. Select either preset and check that the session's tool list contains the six tools in section 3.

`dsh-async` supports general coding; `dsh-async-create` retains creation tools. Existing presets remain unchanged.

**Development installation from source:** if you already have the matching commit in a directory that resolves the matching host dependencies:

```powershell
dsh plugin --profile web add <absolute-source-directory>
```

Use a separate installation directory for stable deployment, not a working tree being edited. Composition or client entry changes require reloading the instance and reopening the page. Before restarting, check for other active sessions and act outside the service process tree. Ordinary settings saves need no restart.

For a first trial, ask the Agent to run the harmless `async_run` examples in section 3. Receiving `job_id` means retain that job identifier for a later read, not that the command failed. Normal completion of the long example should show `LONG_DONE`; inspect exit markers to establish success.

## 2. Settings, saving, and reset

Open the plugin list → dsh-async-tools details. The form sits between the description and component rows; no preset switch is needed. Writes use the host's local loopback settings endpoint. For a non-loopback, read-only, or unavailable endpoint, retain the draft and switch to a writable local management endpoint or repair the connection.

To change settings:

1. Edit the fields you need. This changes only a draft; tools still use the previous values.
2. Check validation messages and the seconds readouts, then select Save. Successful saves affect subsequent calls. Failed saves retain the draft.
3. To remove a field's user override, select Reset and then Save. Leaving the page discards unsaved drafts.

An override means the user layer explicitly contains the field, even when its value equals the default. Reset removes that layer, revealing the host-row value, or the factory default if neither layer sets it. Millisecond fields show effective and draft values converted to seconds. Question-mark help expands without changing settings.

Values override one another in this order: `schema defaults → host-row configuration → user overrides`. The schema defines types, ranges, and defaults. In handwritten host configuration, settings live at `config.settings.<field>`. Tools read the effective host configuration snapshot; only when it is absent do they use valid row fallback values and report that settings are not connected. These five composition keys are not among the 17 editable settings: `toolName`, `owningPreset`, `agentOptions`, `agentPreset`, `allowedAgentPresets`.

### Settings table

| Field | Type | Default | Range | Unit | Effective use |
| --- | --- | --- | --- | --- | --- |
| `defaultYieldMs` | number | `20000` | `[1,2147483647]`, fractions allowed | ms | Next run/workflow omitting `yield_ms` |
| `minYieldMs` | number | `1000` | `[1,2147483647]`, fractions allowed | ms | Next first-wait request lower bound |
| `maxYieldMs` | number | `600000` | `[1,2147483647]`, fractions allowed | ms | Next first-wait request upper bound |
| `defaultWaitMs` | number | `30000` | `[1,2147483647]`, fractions allowed | ms | Wait hints and examples; `wait_ms` remains required |
| `minWaitMs` | number | `250` | `[1,2147483647]`, fractions allowed | ms | Next wait request lower bound |
| `maxWaitMs` | number | `600000` | `[1,2147483647]`, fractions allowed | ms | Next wait request upper bound |
| `pollIntervalMs` | number | `500` | `[1,2147483647]`, fractions allowed | ms | New subagent waits: fallback status checks and existence retries |
| `maxResultChars` | integer | `30000` | `[1,1000000]` | JS `String.length` | Result body clipping |
| `jobKind` | string | `async-command` | Nonempty string | — | New command job kind |
| `subagentProvider` | string | `spawn` | Trimmed empty string falls back to `spawn`; backend must be registered | — | Next creation; execution backend, not LLM provider |
| `uiLang` | string | `auto` | `auto` / `zh` / `en` | — | Settings and questions UI; auto follows host |
| `agentLang` | string | `en` | `en` / `zh` | — | Selects the language of tool descriptions, results, and plugin instructions |
| `silentFailureGuard` | boolean | `false` | `true` / `false` | — | Silent-failure hints in the two plugin presets |
| `askTakeover` | boolean | `false` | `true` / `false` | — | Each ordinary question request |
| `askTimeoutMs` | number | `60000` | `[10000,600000]`, fractions allowed | ms | Initial deadline for a new taken-over batch |
| `askExtendMs` | number | `60000` | `[1,2147483647]`, fractions allowed | ms | Each extension, added to the original deadline |
| `askUiSeat` | string | `sidebar` | `sidebar` / `overlay` | — | Sidebar footer badge / bottom-right overlay |

All numbers must be finite, not `Infinity` or `NaN`. The field ranges also have these cross-field requirements:

- `minYieldMs <= defaultYieldMs <= maxYieldMs`
- `minWaitMs <= defaultWaitMs <= maxWaitMs`
- `pollIntervalMs <= maxWaitMs`

The table's ranges govern which settings can be saved. An individual call's budget is separately limited by the current min/max settings: an out-of-range request takes the nearest boundary, or is “clamped.” Both factory maximums are `600000`. `defaultWaitMs` supplies hints and examples; it never makes `wait_ms` optional.

Invalid new settings are rejected. Existing corrupt configuration is handled according to when it is encountered:

| Situation | Values used | Recovery |
| --- | --- | --- |
| Corrupt startup booleans or cross-field relationships enter degraded operation | Valid factory defaults, with a settings repair entry | Repair the displayed invalid fields and Save; resaving the identical corrupt baseline may receive a successful response without ending degraded operation |
| Invalid values arrive during operation | Last valid values, with warnings | Correct the fields and save again |
| Invalid numeric types, ranges, or enums prevent the row from assembling | The row cannot load; its settings entry may be missing | Correct host composition configuration, then reload safely |

## 3. Tool parameters

Calls below are tool-call illustrations, not PowerShell functions. Budgets use milliseconds. Defaults are factory defaults; customized installations use their effective settings.

### `async_run`

| Parameter | Type | Required condition | Default | Range and meaning |
| --- | --- | --- | --- | --- |
| `command` | string | Required | None | Command text, also the task name |
| `description` | string | Required | None | Active-voice 5–10-word progress description |
| `yield_ms` | number | Optional | `20000` | Clamped by `minYieldMs` / `maxYieldMs`; factory `[1000,600000]` |
| `workdir` | string | Optional | Session's current effective directory | Relative to current directory; absolute paths stay absolute |
| `sandbox_permissions` | string | Declared only with a constrained executor; pair with justification when used | None | Host-declared enum; one same-command broader retry in the same turn after rejection |
| `justification` | string | Together with `sandbox_permissions` | None | Nonempty reason subject to normal approval; permission does not change later session policy |

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless test marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print a harmless marker", yield_ms=1000)
```

A command is a host job from startup and can be inspected in the task panel. Completion within the first-wait budget returns its result directly. Otherwise, retain `job_id`, continue independent work, and wait when needed rather than restarting the command.

Directory-resolution failure, rejected approval, or failed concurrency admission starts no process. If preparation fails for an explicit directory, the error includes the requested directory, resolved path, session current directory, failure-time check, and corrective action. Check the directory first: `ENOENT` can also mean a missing executable, so it alone does not prove the directory is absent.

### `async_wait_job`

| Parameter | Type | Required condition | Default | Range and meaning |
| --- | --- | --- | --- | --- |
| `job_id` | string | Required | None | Returned opaque job identifier |
| `wait_ms` | number | Required | None | Clamped to current wait bounds; factory `[250,600000]` |

```text
async_wait_job(job_id="<returned-job_id>", wait_ms=30000)
```

The budget includes one existence snapshot and waiting. A terminal result is read in the same return. After `running`, wait again if the result is needed. For missing or invisible jobs, check the owner and identifier using host `job_list`. Retry failed queries, not the command.

### `async_agent`

| Parameter | Type | Required condition | Default | Range and meaning |
| --- | --- | --- | --- | --- |
| `description` | string | Required | None | 3–5-word task label |
| `prompt` | string | Required | None | Complete task brief; independent spawn cannot see the parent conversation, inheriting backends can |
| `cwd` | string | Optional | Parent's current effective directory | Relative to parent directory; later directory changes are independent |
| `provider` | string | Pair with `model` | Configuration default or inheritance | Nonempty exact LLM provider ID |
| `model` | string | Pair with `provider` | Configuration default or inheritance | Nonempty exact model ID |
| `reasoning_effort` | string | Optional; may be supplied alone | Compatible inheritance or model default | Nonempty effort ID supported by the effective route |
| `agent_preset` | string | Declared only when row `allowedAgentPresets` exists and backend supports independent presets without inheriting parent context | Row `agentPreset` or inheritance | Must belong to the allowed set; the two supplied presets do not expose it |

```text
async_agent(description="Inspect one isolated module", prompt="Inspect the named module for the stated bug; report findings without changing files.")
```

Creation is background-only. It accepts neither `run_in_background` nor a wait duration. Once the host accepts startup, the tool returns `started` and `agent_id` immediately so the Agent can continue other work.

Use `async_wait_agent` when a result is needed; the final answer still arrives separately as a message. Use host `send_message` to follow up and `interrupt_agent` to request an explicit stop.

For an unregistered backend, unsupported continuation or parameters, or a failed policy read, follow the error to repair configuration. For a rejected route, query models again while retaining the target tool. Unknown arguments are rejected rather than forwarded to the backend.

### `async_wait_agent`

| Parameter | Type | Required condition | Default | Range and meaning |
| --- | --- | --- | --- | --- |
| `agent_id` | string | Required | None | Identifier of a subagent the caller may wait on |
| `wait_ms` | number | Required | None | Clamped to current wait bounds; factory `[250,600000]` |

```text
async_wait_agent(agent_id="<returned-agent_id>", wait_ms=30000)
```

One budget covers both existence checks and waiting. Existence checks allow up to three `pollIntervalMs` retries, without additional time outside that budget. The tool first establishes that the caller may wait on this child, then evaluates running status.

- `running`: this wait ended; wait again with a bounded budget if the result is still needed.
- `settled`: the target is no longer observed running during this call. This proves neither success nor final-answer delivery. The answer arrives separately as a message.
- `not_found`: inspect the included `known_children` and the exact identifier. Do not delegate again merely to check progress.
- Query failure: status is unconfirmed, not proof of absence; retry as directed.

### `async_workflow`

Use only for explicitly requested workflows or large-scale orchestration. For one or two delegations, use `async_agent`.

| Parameter | Type | Required condition | Default | Range and meaning |
| --- | --- | --- | --- | --- |
| `script` | string | Required | None | Plain JavaScript function body, top-level await allowed; return a JSON-serializable value |
| `meta` | object | Required | None | Metadata object below |
| `args` | object | Optional | None | Global args in script; wrap a bare list in an object field |
| `yield_ms` | number | Optional | `20000` | First-wait clamp; factory `[1000,600000]` |

| Parameter | Type | Required condition | Default | Range and meaning |
| --- | --- | --- | --- | --- |
| `meta.name` | string | Required | None | Short kebab-case display name; this naming guidance is not a promised regex check |
| `meta.description` | string | Required | None | One-line purpose |
| `meta.whenToUse` | string | Optional | None | Usage conditions |
| `meta.phases` | array<object> | Optional | None | Phase declarations |
| `meta.phases[].title` | string | Required for each phase | None | Exact phase title |
| `meta.phases[].detail` | string | Optional | None | Phase explanation |
| `meta.phases[].provider` | string | Optional | None | Phase LLM route override |
| `meta.phases[].model` | string | Optional | None | Phase model override |

The current tool schema allows additional meta and phase properties; the engine still validates its own run contract. Do not put TypeScript, `export const meta`, or a redeclaration of the metadata parameter in script.

```text
async_workflow(meta={name:"review-modules", description:"Review independently selected modules"},
  args={items:["module-a","module-b"]},
  script="return await pipeline(args.items, (_, item) => agent('Review ' + item));")
```

| Hook | Arguments and result |
| --- | --- |
| `agent(prompt, opts?)` | Promise: final text without schema, validated object with schema, null on ordinary subagent failure. opts accepts only `label`, `phase`, `provider`, `model`, `schema`; route overrides may be supplied independently |
| `opts.schema` | Object-root JSON Schema: `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `oneOf`; no pattern, format, or numeric bounds. Host-accepted nonconstraining annotations add no validation constraints |
| `pipeline(items, ...stages)` | Each item independently traverses stages without a cross-item stage barrier. Stage receives `(prev,item,index)`; ordinary failure makes that item null and skips its remaining stages |
| `parallel(thunks)` | Concurrent zero-argument functions, awaiting all; ordinary failure becomes the corresponding null |
| `phase(title)` | Exact metadata title match; declarations do not automatically order work or change routes |
| `log(message)` | Progress reporting |

Distinguish ordinary task failures from script misuse. The ordinary failures in the table produce a local `null` while other items may continue. These misuses instead terminate the whole script; `pipeline` and `parallel` cannot turn them into local `null` results:

- Invalid hook arguments or unknown options such as `effort`, `isolation`, and `agentType`.
- Unsupported schemas.
- Exceeding the host's configured total limit.

The host controls concurrency and total limits; there is no fixed number for every deployment. Scripts coordinate work but have no direct filesystem, network, timer, or Node APIs. Let subagents perform the work. A missing engine rejects the call before any job is created; see section 7 for a complete composition.

### `async_list_subagent_models`

| Parameter | Type | Required condition | Default | Range and meaning |
| --- | --- | --- | --- | --- |
| `provider` | string | Optional; required with model | None | Nonempty exact provider ID |
| `model` | string | Optional; requires provider | None | Nonempty exact model ID; conflicts with nonempty query |
| `query` | string | Optional | None | Trimmed, case-insensitive substring of IDs or display names; whitespace-only means omitted |
| `target_tool` | string | Optional | Sole identifiable creation tool, if any | Nonempty visible tool name; multiple or no candidates leave applicability unconfirmed |
| `page` | integer | Optional | `1` | `>=1`; above 1 requires version |
| `page_size` | integer | Optional | `20` | `[1,100]`; invalid values rejected |
| `version` | string | Required when page>1 | None | Nonempty opaque version token from the preceding page |

```text
async_list_subagent_models(target_tool="async_agent")
async_list_subagent_models(query="<name-fragment>", target_tool="async_agent", page_size=20)
async_list_subagent_models(provider="<exact-ID>", model="<exact-ID>", target_tool="async_agent")
```

Choose the query for your task:

- Omit `provider` and `query` to browse providers.
- Supply `provider` to browse its models.
- Supply `query` to search names or IDs, optionally within `provider`. A matching provider ID or name includes that provider's whole model group.
- Supply both `provider` and `model` for exact model details and effort options.

Results are filtered before pagination and ordered consistently by ID. For the next page, reuse the returned `next` parameters, which include the filters, target, `page_size`, `version`, and next page number. If the version is stale, restart at page 1 with the same filters rather than joining old and new results. Beyond-end pages return empty entries, totals, and restart guidance.

## 4. Status, consuming results, and stopping

| Return shape | Meaning and next step |
| --- | --- |
| run `completed` | `output`, `truncated`, optional `exit_code`, `signal`, `note`. Completed does not imply exit code 0; inspect markers. signal is a process termination signal |
| run `killed` | Optional `detail`, `output`, `truncated`; inspect the termination cause |
| run/workflow `running` | `job_id`, `elapsed_ms`, `note`; first wait ended, retain the handle |
| wait_job `completed` / `killed` / `failed` | `job_id`, `output`, `truncated`, optional detail; contents read in that same return |
| wait_job nonterminal | `status`, `job_id`, `waited_ms`, `note`; stopping is also nonterminal |
| wait_agent | `status`, `agent_id`, `waited_ms`, `note`; not_found contains `status`, `agent_id`, `known_children`. No final-answer field |
| agent `started` | `agent_id`, `note`; startup acceptance only |
| workflow `completed` | `result` is a rendered string, not a direct JSON object; killed may include detail |
| list | Always `mode`, `entries`, `total`, `version`, `complete`, `target`, `verdict`, `basis`; depending on mode: `page`, `page_size`, `provider`, `query`, `has_next`, `beyond_end`, `failed_providers`, `example`, `unlisted_provider`, `unlisted_had_routes`, `next` |

Budget expiry returns `running` without stopping the task. Steering messages, notifications (`notice`), forwarded Agent messages (`relay`), and late answers addressed to the current Agent can also end the wait early. Entry checks include messages that have already arrived but remain unclaimed. Messages queued for the next turn do not interrupt. A message gives the Agent something to handle; it does not establish that the wait target has finished.

Cancelling the wait or stopping the turn ends only the wait. The host may replace the visible tool return with a cancellation error, hiding `job_id`. Recover the identifier from `job_list` or completion notices and read that original job. Do not restart a command with side effects.

**Successfully read content cannot be retrieved again.** Each successful job read delivers previously unread output and advances the reading position. The final `result` is delivered only once, in the first successful terminal read, after that read's increments. Save needed content promptly. On a read failure, retry the original identifier as directed; do not interpret the failure as empty output.

Treat these three result indicators separately:

| Indicator | Meaning | Next step |
| --- | --- | --- |
| `truncated` | This return exceeds `maxResultChars`, so only its beginning and end are kept | Read the clipping explanation and determine whether needed content was omitted; status and diagnostic text are outside the body budget |
| `lossy` | Earlier output has already been lost, beyond clipping this return | Do not treat the current text as a complete record; check for spill paths |
| `spillPaths` | The host reports temporary absolute file paths for spilled output | Files may contain secrets. Promptly copy needed content to a secure location, check that the files exist and are complete, and redact before sharing |

Without a reported path, do not assume that a complete disk copy exists.

Explicitly stop commands/workflows with host `job_kill`, and subagents through host management. Check owner, exact identifier, and whether results are still needed first. Jobs belong to the initiating session; unloading producer rows does not automatically cancel owner jobs. Restarting can terminate active processes.

## 5. Model selection and query authorization

To select a model:

1. Enable model selection in dsh subagent settings and save the allowed routes. A route is an exact `provider` and `model` ID pair.
2. Browse or search with `async_list_subagent_models(target_tool="async_agent")` and check whether that target allows the route.
3. Pass the exact `provider` and `model` together to `async_agent`. If needed, add a `reasoning_effort` supported by that model.

Each explicit model or effort request reads the current policy. After Save, the next creation in an existing session also uses the new policy; running children keep their model. Turning selection off rejects explicit choices. Omitting all selection fields uses configured defaults or parent inheritance, without rejecting that default path because the allowlist changed.

Defaults participate under these conditions:

- Explicit route or effort fields, or route-related tool-row defaults, trigger preflight: a check of route and model support before creation. Only these cases merge backend route defaults.
- Tool-row `agentOptions` override backend defaults, and explicit fields override the row values. Without preflight or any carried values, the parent route is inherited.
- A route change does not retain incompatible effort settings. Preflight effort values and the final creation request are separate stages: a value supplied for preflight is not proof of what the child finally inherits. The host resolves the child from its request and parent values.

Query verdicts `allowed`, `not-allowed`, and `unconfirmed` describe applicability to the chosen target. **A catalog listing is not permission, valid credentials, or proof that a remote service is available.** A named but invisible target is `not-allowed`, even if directory information is returned. Discovery creates no child and sends no inference request.

Native creation tools use their own session policy, which may differ from the global list. Workflow `agent()` hooks do not automatically acquire `async_agent` parameters or live policy. Create using exact IDs and only fields accepted by the target; do not forward `query`, pagination, or `target_tool`. After rejection, query again for the same target rather than changing models or tools to bypass restrictions.

Exact allowed IDs missing from the catalog may be included in browsing and search with a source marker, without invented display names. Partial provider failures set `complete=false`; `total` is only the number obtained, not a complete total or evidence of zero models at a failed provider. Fix provider configuration and query again.

## 6. Question takeover and silent failures

`askTakeover` defaults off. When enabled, only ordinary questions from root Agents in the two plugin presets use the panel. Plan review, approval, and other presets retain native handling. sidebar shows an unhandled-count footer badge that opens the questions; overlay displays them at bottom right. Answer, ignore, jump to the owning session, or extend the wait.

**Select and submit an answer:** nothing is initially selected, including recommended options. Follow the question type:

- Single-select: choose either one preset option or a custom answer.
- Multi-select: combine preset options and custom text. Editing custom text does not cancel other selected options.
- Clicking the custom input or typing valid text selects the custom answer. Moving keyboard focus alone does not.
- Deselecting custom content may retain its draft, but does not submit it. Clearing text while the custom answer is selected blocks submission, even with other multi-select answers. Fill it in or deselect it.
- Ignore is a separate action and needs no valid answer. The server also rejects unknown options, invalid selection relationships, empty answers, and blank custom text.

**Ask for more time:** all questions from one call form a batch and share an initial deadline. Extend adds `askExtendMs` to the original deadlines of batches still open in that session when clicked. Each click adds time again. If confirmation is missing, wait for the panel to read back the actual deadline before retrying. New batches use their own initial window; expired batches do not rejoin the original wait.

**Answer after expiry:** answered items remain. Unanswered items return `selected=[]` and a timeout `custom` explanation, allowing the Agent to continue without choosing for you. You can still answer through the panel. Late notices include full questions, all options and descriptions, selection relationships, actual answers or ignore state, and delay, so the Agent need not reconstruct an answer from memory.

Delivery happens before wake-up. An idle Agent with no pending plugin notice receives a `followup` turn; otherwise `inject` places the notice at the next message claim point. A wake is published only after the host accepts delivery.

**When records disappear:** records expired for more than 24 hours are removed only when a new batch is taken over—a lazy sweep. Without a new batch they may remain longer. Late submission itself has no 24-hour rejection rule. Records are held only in memory and do not survive restart or uninstall. On uninstall, unsettled requests return to native handling.

**Check delivery:** for `failed`, `gone` with `undelivered`, or a lost-notice entry, open the owning session and reply directly. Already answered elsewhere returns plain `gone`. Missing confirmation from an RPC—the UI's request to the host—means an unknown outcome. Wait for refreshed state instead of treating a broken connection as proof of nondelivery.

`silentFailureGuard` defaults off and adds result hints, description warnings, and instructions only in the two presets. With a constrained executor, no escalation, and a capture-shaped command producing blank output, missing expected content calls for a harmless bare equivalent to establish execution. Ordinary pipelines are not capture-shaped. Rejection signatures are diagnostic, not approval. Do not repeat dangerous commands to diagnose empty output; inspect state, exit markers, and logs first.

## 7. Advanced composition

Tools can be mounted separately, and discovery can coexist with native discovery. Each `config.toolName` selects one tool; an absent key is the non-tool host settings role. Custom compositions do not automatically disable synchronous tools. This complete six-tool composition places workflow inside an isolated delegation group with an engine provider:

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

The engine must also resolve subagents, ptcRuntime, sandboxPolicy, and workingDirectory. If it cannot execute the current constrained policy, preserve the actual rejection; do not escalate automatically or substitute an unsandboxed engine. Composition/client changes require a safe reload; ordinary settings saves do not.

## 8. Risks, disabling, and recovery

Before running a command, check what it can do under the host's current permissions, approval rules, and sandbox. It uses the host-provided environment keys and may access networks or secrets. The plugin does not collect telemetry or read/write credentials itself; host interfaces and adapters handle model-directory access.

Before sharing results or reporting a problem, redact environments, commands, spill paths, and logs. Include plugin, host, and Node versions, the preset, tool arguments, `job_id` or `agent_id`, actual status, exit markers, and relevant log excerpts. Never submit tokens, cookies, passwords, or token-bearing URLs. Model-visible host errors are single-line and at most 500 characters. If the full cause is needed, the operator can inspect stderr logs and supply a redacted excerpt.

**If the default preset is `dsh-async` / `dsh-async-create`, disabling or uninstalling can cause `agent-preset/not-found` for new sessions. The host does not automatically clear that choice.**

1. Before uninstalling, choose an available default preset in host settings.
2. Collect needed results and explicitly stop unneeded jobs you own.
3. Manage dependency and bundle through the host GUI and follow that host's reload instructions. For development links, also remove the bundle declaration; deleting a link does not unload an in-memory module.
4. If already removed and new sessions fail, clear or reselect the default preset in host settings, without relying on the removed plugin page.
5. Existing compositions can retain version references and owner jobs can continue. Before restarting check all active sessions and act outside the process tree; restart is not risk-free cleanup.

Start with the symptom rather than rerunning work or restarting the instance:

| Symptom | First check | Next action |
| --- | --- | --- |
| Tools, presets, and settings are all missing | Full plugin version and exact host version from section 1 | Inspect dependencies (installed packages), bundles (loaded configuration sets), and loading logs in host plugin management; do not widen peer requirements to force loading |
| Only tools are missing | Whether the session uses an async preset and its bundle is loaded | Select the right preset and start a new session; check custom compositions against section 7 |
| Only the settings form is missing | Whether the plugin's host configuration row and client entry loaded | Inspect client loading logs; after composition or client-entry changes, reload safely and reopen the page |
| Settings cannot be saved | Writable local loopback access, field ranges, and cross-field relationships | Retain the draft, repair the connection or fields, and retry; use section 2 for degraded configuration |
| A long task has no result, or its identifier is missing | Initiating session (owner), identifier, and status in `job_list` | Read the original job; retry failed queries, not commands with side effects |
| Answer delivery is unconfirmed | Refreshed panel state and the owning session | Follow section 6; if nondelivery is confirmed, reply in that session directly |

Inspect unknown configuration and residual OS processes individually through host settings and system process management. Do not delete unrelated configuration or stop other people's work.

Documentation maintenance follows the [documentation principles (Chinese)](<documentation-principles.md>).
