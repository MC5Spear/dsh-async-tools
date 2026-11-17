# User reference

[中文](<user-reference.md>) · [English home](<../README.en.md>)

Find the task you need:

- [Installation and version checks](<#1-installation-identity-and-prerequisites>), [first task and settings](<#2-first-use-and-settings>).
- [Five-tool argument reference](<#3-tool-arguments-and-results>), [wait states, continued output, and recovery](<#4-wait-states-and-direct-delivery>).
- [Discover a model, then create a child](<#5-model-catalogs-authorization-and-inheritance>), [answer questions and diagnose missing command results](<#6-question-takeover-and-silent-failures>).
- [Custom presets and file configuration](<#7-advanced-composition>), [remove the plugin or report a problem](<#8-disable-recover-and-report-problems>).

## 1. Installation identity and prerequisites

This is an alpha trial version for the `adapt/dsh-0.2.2-alpha` channel used below. **It has not passed stable acceptance.** Try it only in an isolated instance, and read the matching [known issues and verification gaps (Chinese)](<issues.md>) before use.

The table is the package’s declared host admission set, not proof that every behavior has been verified. Check that the remote branch is accessible before installing. For repeatable installation, use a full commit ID or matching artifact and retain the actual source. This compatibility line currently has only the alpha channel above, with no stable branch. Stable promotion also requires real user experience and explicit confirmation.

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.10-alpha.2+dsh.0.2.2` |
| Supported dsh host versions | `0.2.2-rc.1` |

“Host” means the DSH instance loading the plugin. Only the version listed above can load the package, not the final `0.2.2`, older `0.2.2` pre-releases (alphas), the `0.2.1`/`0.2.0` lines, or an unlisted rc.

Node.js `24.9.0` or newer is required, matching this package and the target DSH runtime requirements.

### Prerequisites for reusing host dependencies

At runtime, this package uses dependencies supplied by DSH; no separate host installation is needed. These shared dependencies are declared as peer dependencies in the package manifest. Since 0.2.9, they retain their compatible-version requirements but are marked optional to prevent automatic installation by the package manager. The package also directly depends on `@deepseek-ai/schemastery` and `zod`. It has no `preinstall`, `install`, `postinstall`, or `prepare` installation scripts of its own.

A profile is a DSH runtime configuration. On the supported `0.2.2-rc.1`, new profiles disable `autoInstallPeers` (automatic peer installation) by default; no configuration change is needed before installation. Since 0.2.9, installing or upgrading this package does not require disabling that option in an existing profile either.

Existing profiles can retain old dependency copies, lockfiles, or installation scripts from other plugins. Before changing those items, ask the instance administrator to check their purpose and source; upgrading this package does not clean the entire profile. Follow [installation script-approval troubleshooting](<#installation-script-approval-troubleshooting>) if a script prompt appears.

### Usage limits and saving results

**Trial verification boundary:** this round’s alpha.2 test artifact was installed in an isolated DSH `0.2.2-rc.1` instance. Authenticated API checks covered version, loading, the settings namespace, both presets, and blank sessions. The final artifact has only subsequent user-document changes and identical runtime code, but has not been installed again. Installation used `--ignore-scripts` with `autoInstallPeers=false`. Fresh installation with automatic peer installation enabled, upgrades from an exact old source, full disable/uninstall behavior, and reinstall/cold recovery after a required restart remain unverified. API checks do not establish GUI usability, end-to-end operation of the five tools, or allowance totals in real model inputs. Follow required reload/restart instructions before continuing, and test only in an isolated instance.

Linux command execution and one-shot permission escalation have not been verified on a real machine. There are no verification conclusions for macOS or remote execution environments. Before using these environments, check the features needed in a separate test session, particularly command permissions, waiting, and result delivery.

The pending-question panel has not been verified with a real OS input method, screen reader, or touchscreen. When relying on these input methods, first confirm that choices and submissions work. If the panel is unusable, open the original session and reply there.

Pending-question behavior after page reconnection or hot updates has not been fully verified. If the panel repeatedly reports errors or stops updating, check the original session before submitting again. Reply directly in that session if needed, and retain the symptoms and triggering actions for the maintainer.

When a tool call is canceled, DSH can replace its return with a cancellation error, leaving the Agent without the result body already generated. The plugin offers [limited recovery copies](<#a-tool-result-may-not-have-arrived-request-a-recovery-copy>), but cancellation and recovery at that instant have not been verified on a real host. Save important output promptly. If recovery fails, inspect the original UI records and any retained-output paths attached to the result; do not automatically repeat a task with side effects.

**Reading results from other plugins' jobs:** after discovering a running job, this package observes its settlement and delivers the result, including through completion messages when no wait is active. For a job already settled when first discovered, `async_wait` checks the body's location. A body already included in a host message is not duplicated. Where this package has hidden the native `job_output` tool, it attempts to retrieve the original notification component's retained copy, then delivers any retrieved body within normal budgets. The Agent need not call a hidden tool. This channel is implemented, but verification of real loading, presets, and reload conditions remains incomplete; recovery is not guaranteed in every composition.

If no copy is obtained, the return gives terminal facts and a location explanation, not proof that the job produced no result. After that explanation is delivered, later explicit waits normally report delivery facts; they do not guarantee another attempt against the original component. Keep the job ID and notice, and ask the instance maintainer to check that component or the producer for an available copy. Another composition need not share the retained body, a new session remains subject to job-access restrictions, and reloading the component can lose its in-memory copy. Without an available copy, recovery cannot be guaranteed; do not repeat a side-effecting task to recreate its result.

### Install, pin a source, and check the version

The package is not distributed through npm. Use the GUI steps below; dependency conditions are covered under [prerequisites for reusing host dependencies](<#prerequisites-for-reusing-host-dependencies>) above.

1. Open **Plugins** in DSH's left sidebar and select **Add plugin**. **Install a third-party plugin** in the adjacent dropdown opens the same flow.
2. Paste the following into the package name/address field, then select **Install**:

   ```text
   github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.2-alpha
   ```

3. Select **Enable now** after installation succeeds. If already enabled, confirm its enabled status instead. If installation requests permission to run scripts, follow [script-approval troubleshooting](<#installation-script-approval-troubleshooting>) first.
4. If the host requests a reload/restart, deal with active tasks and save needed results before following that prompt. A restart can terminate active processes.
5. Open the package's detail page in the plugin list and confirm that the settings form is visible.
6. Create a session and find `dsh-async` and `dsh-async-create` in the preset selector. Choose either and confirm that the Agent has all five tools: `async_run`, `async_wait`, `async_agent`, `async_workflow`, and `async_list_subagent_models`. Both presets are supplied with the package; no separate preset directory is needed.

Alternatively, install from a terminal:

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.2-alpha
```

`web` is the target profile's name; substitute the appropriate name for another profile. After installation, likewise confirm it is enabled and complete the loading checks above.

The address follows a moving maintenance branch. For repeatable installation:

1. Select a commit available from the repository. In an existing checkout of the intended source, run `git rev-parse HEAD` to obtain its full commit ID. A local commit not yet uploaded cannot serve as a remote installation source.
2. Replace the branch after `#` with that full commit ID and install. Keep the complete installation address for reinstalls and problem reports.
3. Open the package's detail page after installation. Check the version beside its title or the **Current version** row under **Source** at the bottom. The same area shows the installation source. The version should match the selected source, but several commits may share a version number, so retain the pinned installation address too.

### Installation troubleshooting

If source retrieval fails, check the repository address and branch or commit, then the network and proxy. If it still fails, ask the maintainer supplying the installation source about available artifacts. Omitting `#adapt/dsh-0.2.2-alpha` from the address does not automatically select the correct host adaptation.

#### Installation script-approval troubleshooting

Through 0.2.8, profiles with `autoInstallPeers` enabled could install duplicate host dependencies for this package and fail with `ERR_PNPM_IGNORED_BUILDS` when their scripts were blocked. When moving to DSH `0.2.2-rc.1`, use an available source for this line’s `0.2.10-alpha.2+dsh.0.2.2` candidate, not the 0.2.9 package for DSH 0.2.1. If no matching source is available, defer installation and contact the maintainer. There is no need to approve redundant dependency scripts merely to get past the older failure.

After installation succeeds, check the actual package version, settings, and both presets. Undecided approval entries from the failed attempt may disappear after successful installation. If an approval prompt remains, follow the steps below to check its cause.

If installation or an upgrade shows **The plugin could not be installed / Install scripts need permission**, first consider the effects of approval. Scripts run with the permissions of the local account running DSH. Permission is saved in the current profile and remains applicable to later installations, even if this installation fails. Retrying may run already-allowed scripts again. **Installation-script approval is separate from sandbox approval for Agent commands.**

Then check the details and decide:

1. Select **Show install details** and read the full package names, versions, and error. If the list is incomplete, consult those details rather than approving truncated names. `ERR_PNPM_IGNORED_BUILDS` means installation scripts were blocked.
2. Check which version of this package is actually being installed, then identify the dependency introducing each script and whether execution is needed. This package has no installation scripts of its own; since 0.2.9, including this candidate, it no longer auto-installs host dependencies. Other plugins or existing dependencies can still need scripts. A package belonging to the host is not, by itself, a reason to approve it.
3. If the source or need is unclear, cancel or defer installation and contact the plugin maintainer or instance administrator with full package names, versions, and sanitized installation details. When the scripts are understood and trusted and continuing is the intended choice, select **Allow these scripts and retry**. Investigate unknown packages or incomplete names first.

The table lists packages seen in older installation prompts and what their scripts do, for reference when checking those exact versions. Later versions may differ; use the actual installation details rather than allowing every listed script.

| Package and version | Script purpose |
| --- | --- |
| `@deepseek-ai/dsh-subprocess-local@0.2.2-rc.1` | `postinstall` only sets mode `0755` on node-pty's Unix `spawn-helper`; that file is usually absent on Windows. |
| `@google/genai@2.21.0` | `preinstall` only echoes a no-op message; it does not build anything. |
| `koffi@3.1.1` | Tries loading a precompiled binary first; only falls back to a CMake build if loading fails. |
| `node-pty@1.2.0-beta.15` | Checks for precompiled files and uses node-gyp if they are missing or a source build is explicitly requested. `postinstall` copies Windows ConPTY files and cleans the build directory. |
| `protobufjs@7.6.6` | `postinstall` only reads package manifests, checks version symbols, and issues warnings; it does not build anything. |

#### Missing settings, presets, or tools

Check in this order:

1. Confirm that DSH is a supported version. Inspect load logs and resolve version-mismatch or missing-dependency errors.
2. In the target profile's plugin manager, confirm that the package is installed and its bundle declaration is loaded. The dependency provides the package; the bundle enables its settings row and two presets. Installing the package without loading its composition may leave these entries absent.
3. If composition or client entries were just changed, reload the instance as instructed by DSH and reopen the page. A restart can terminate active processes, so save required results and arrange for tasks to finish first. Ordinary settings saves need no restart.

For normal use, install as above. Source editing and custom presets are covered under [advanced composition](<#7-advanced-composition>).

## 2. First use and settings

### A first task

Create a session with `dsh-async` for general coding, or `dsh-async-create` to retain plugin and preset authoring tools. Both directly provide all five tools without modifying existing presets. Inspection, messaging, and stopping remain DSH management operations.

This demonstration uses factory wait settings. In a Windows PowerShell environment, send the Agent this request:

> Demonstrate background execution without modifying files, accessing the network, or creating children. First use async_run to run `Write-Output SHORT_OK`, then run `Start-Sleep -Seconds 30; Write-Output LONG_DONE` with yield_ms=20000 on the second call. Keep the returned job_id. When the result is needed, use async_wait targeting that job with wait_ms=30000. Report both markers and actual exit information. Do not rerun the command to check progress; if no identifier arrived, check job_list first.

The short command should display `SHORT_OK` directly. The long command returns a `job_id` after an initial wait of at most 20 seconds. Its result, including `LONG_DONE`, then arrives in a wait return or completion message. Still inspect exit information: execution ending does not imply exit code zero.

These are Agent tool-call examples, not terminal commands:

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless test marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=20000)
async_wait(targets=[{kind:"job", id:"<returned job_id>"}], wait_ms=30000)
```

Do independent work while the task runs, and wait when its result is needed. Every call requires `wait_ms`. Factory bounds for positive waits are 20000–600000 ms; `wait_ms=0` checks without waiting. See [async_wait](<#32-async_wait>) for arguments.

### Edit and save settings

1. Open the plugin list → this package's detail page. The settings form is between the description and component list.
2. Edit fields and select Save. Leaving discards unsaved drafts; failed saves retain them for correction and retry. Help buttons only expand explanations.
3. Check the values and Overridden indicators. Valid saved settings apply to subsequent calls without a restart.

Writes are allowed only through the host's local loopback address. If the page is read-only or uses another address, follow its guidance to a writable entry.

Settings can come from three places, in descending priority: **user overrides** saved through the form, preset values in DSH composition files, and plugin factory defaults. A field present in the user layer is an override even if it equals the default.

Restore default stages removal of that field's user override and still needs Save; other fields remain unchanged. The field then takes the composition value, using the factory default only when no composition value exists. For example, a composition value of `45000` overridden with `90000` returns to `45000`, not the factory `20000`.

When restoring a wait minimum or maximum, also check the related default duration against the field relationships below. Related fields can be edited and saved together. If saving fails, correct the retained draft as prompted.

To remove an override, prefer the field's Restore default action rather than manually emptying its input. This stages removal of the override, not an explicit write of the same number:

1. Select Restore default beside the field. If the input was already emptied manually, the button can disappear with the Overridden indicator. First re-enter the field's previous effective override value without saving, then select the button when it reappears.
2. Check the restored value and related field relationships. Submit when the form permits saving, then check the effective value after success. The server validates the complete candidate, and failed saves retain the draft.
3. If a submission is still rejected by the server or the previous value is uncertain, defer removal and give the instance maintainer the field name, composition default, effective value, and validation message. To use a valid value in the meantime, enter and save it explicitly; that retains a user override rather than restoring the default.

### 2.1 All 20 settings

Wait durations use milliseconds (ms); 1000 ms is one second. The ranges below describe **settings that can be saved**. A tool call's duration is bounded by the current min/max: a value below the minimum becomes the minimum, and one above the maximum becomes the maximum. This is clamping. New invalid settings are rejected, not clamped.

#### Waiting and result length

| Field | Type | Default | Saved range | Unit | Purpose and effective time |
| --- | --- | --- | --- | --- | --- |
| `defaultYieldMs` | number | `20000` | 1..2147483647; fractions allowed | ms | Initial wait for the next run/workflow call omitting yield_ms |
| `minYieldMs` | number | `20000` | 1..2147483647; fractions allowed | ms | Lower request bound for the next run/workflow initial wait |
| `maxYieldMs` | number | `600000` | 1..2147483647; fractions allowed | ms | Upper request bound for the next run/workflow initial wait |
| `defaultWaitMs` | number | `30000` | 1..2147483647; fractions allowed | ms | Wait example in tool guidance; never fills in a missing wait_ms |
| `minWaitMs` | number | `20000` | 1..2147483647; fractions allowed | ms | Lower request bound for the next positive async_wait; zero-wait checks are exempt |
| `maxWaitMs` | number | `600000` | 1..2147483647; fractions allowed | ms | Upper request bound for the next positive async_wait |
| `pollIntervalMs` | number | `500` | 1..2147483647; fractions allowed | ms | Interval for fallback child-state checks, work rechecks in untargeted waits, and retries when a child is temporarily absent from the directory; all share the call's total budget |
| `maxResultChars` | integer | `12000` | 1..1000000 | JS String.length | Shared result-content accounting follows host step events; real-input limits and allowance recovery have limitations. See section 4 |

All numbers must be finite and satisfy:

- `minYieldMs <= defaultYieldMs <= maxYieldMs`
- `minWaitMs <= defaultWaitMs <= maxWaitMs`
- `pollIntervalMs <= maxWaitMs`

A minimum is not a mandatory delay. Completion or an eligible message still returns early. Configuration changes do not restart an in-flight wait.

`pollIntervalMs` accepts values as low as 1 ms. During a suspended wait, fallback child-state checks and untargeted work rechecks use a timer interval of at least 50 ms. Retries for a child temporarily absent from the directory use the configured interval between at most three query periods, without that 50 ms floor. Queries and intervals still share the call's total budget.

#### Execution, languages, and result presentation

| Field | Type | Default | Saved range | Unit | Purpose and effective time |
| --- | --- | --- | --- | --- | --- |
| `jobKind` | string | `async-command` | Nonempty string | — | Kind identifier for new command jobs, useful in job listings |
| `subagentProvider` | string | `spawn` | Backend name; trimmed empty value uses spawn | — | Execution backend for later child creation, not the model provider; first confirm that DSH has registered it and that it supports resumable children |
| `uiLang` | enum | `auto` | auto / zh / en | — | Package settings and question-panel language; auto follows the host |
| `agentLang` | enum | `en` | en / zh | — | Package tool descriptions, results, and operating instructions, independently of uiLang |
| `silentFailureGuard` | boolean | `false` | true / false | — | Silent-command-failure diagnostics and warnings for listed presets; see section 6 |
| `workflowProgressLog` | boolean | `false` | true / false | — | Whether background job results shown to the Agent include stage progress lines; completion within the initial wait returns only the final result, without these logs. Original UI records are unaffected |
| `fullCommandEcho` | boolean | `false` | true / false | — | Whether new delivery batches attach command or script source to Agent results, sharing the body allowance; see section 4 |

#### Questions and applicable presets

| Field | Type | Default | Saved range | Unit | Purpose and effective time |
| --- | --- | --- | --- | --- | --- |
| `askTakeover` | boolean | `false` | true / false | — | Sends later ordinary questions to the panel, only for root Agents (main-session Agents) on listed presets |
| `askTimeoutMs` | number | `60000` | 10000..600000; fractions allowed | ms | Initial wait for a new question batch; does not reset existing deadlines |
| `askExtendMs` | number | `60000` | 1..2147483647; fractions allowed | ms | Duration added to still-active batches' existing deadlines on each extension |
| `askUiSeat` | enum | `sidebar` | sidebar / overlay | — | Sidebar or lower-right overlay; changing position does not reset deadlines |
| `boundPresets` | string[] | `dsh-async, dsh-async-create` | Unique nonempty preset IDs; empty array allowed | — | Presets receiving operating instructions and auxiliary features, matched against each session's current preset |

### Applicable presets and the two switches

`boundPresets` controls three features:

| Feature | Required conditions |
| --- | --- |
| Asynchronous instructions in the Agent's system prompt | Current preset is listed; no separate switch |
| Silent-command-failure diagnostics and warnings | Current preset is listed and silentFailureGuard is enabled |
| Ordinary questions handled by the pending panel | Current preset is listed and askTakeover is enabled |

The default list contains the two shipped presets; both switches default to off. Uncheck all entries and save the empty array `[]` to unbind all three features. **The list neither installs nor removes tools.** Custom presets still need [tools mounted first](<#7-advanced-composition>). An unlisted preset does not receive these auxiliary features even if it uses the same tool.

Candidates come from the DSH preset registry; Refresh reads them again. Bound IDs that are currently absent remain available for removal. Failed-to-load entries show the host's reason and cannot be newly selected, but existing bindings can be removed. A failed registry read preserves saved bindings instead of displaying the failure as an empty list. While the directory is loading or has failed to load, entries checked in this editing session but not yet saved are listed alongside saved bindings, annotated with the current read state; a temporarily unreadable directory does not hide selections being drafted.

Select Refresh to update the candidate list without saving settings or discarding selection drafts. Refreshing during a read schedules an update after that read finishes. Retry as prompted if an error appears; existing bindings remain removable. If loading persists or retries fail, keep the error details and ask the instance maintainer to check the preset directory service. Record unsaved drafts before reopening or reloading the page, because reloading discards them.

### Configuration warnings and recovery

A degraded-configuration warning means the form's stored values may differ from those tools are using. Damaged booleans, preset lists, or cross-field relationships at startup can cause tools to use factory defaults while keeping the form available for repair. Invalid configuration received during operation keeps the previous valid values. Out-of-range numbers or enums may instead prevent a plugin row from loading; use the load log to identify the field.

Correct every invalid field and relationship, then save. Resaving damaged values unchanged may receive a success response without clearing the warning. After saving, confirm that the warning clears and tool descriptions show the expected effective values. If it remains, use its details or the load log to continue correcting the configuration.

Editing files is needed only for composition defaults or old file-configuration migration; see [file configuration](<#file-configuration-and-migration>).

## 3. Tool arguments and results

These arguments are for Agent tool calls, not terminal commands or DSH settings. Required arguments must be supplied every time. Do not pass unlisted host configuration keys as call arguments.

### 3.1 async_run

Runs a command. A short command returns its result in the same call. If it outlasts the initial wait, the call returns `job_id` and the command continues in the background.

| Argument | Type | Required/default | Rules |
| --- | --- | --- | --- |
| `command` | string | Required | Exact command text, using the PowerShell or shell supplied by the host |
| `description` | string | Required | Active-voice progress description, 5–10 words |
| `yield_ms` | number | defaultYieldMs | Finite number, clamped to minYieldMs..maxYieldMs |
| `workdir` | string | Session's current directory | Relative paths resolve there; a started process keeps its directory |
| `sandbox_permissions` | string enum | Conditionally available | Exposed with a constrained executor; available modes come from the current tool declaration |
| `justification` | string | Required with sandbox_permissions | Explains why the original command just denied in this turn needs wider permissions for a retry |

Commands inherit session permissions and sandbox restrictions. Wider permissions are only for a one-shot retry of the original command just denied by the sandbox in the same turn, with host approval—not a different task. If these arguments are absent from the current tool, passing them does not create an escalation entry.

A failed workdir resolution or preparation returns an error instead of silently running elsewhere. Correct the path or environment using the requested path, resolved path, and directory-check result in the error. `ENOENT` can also arise from the execution environment; that code alone does not establish that the working directory is absent.

Continue according to the return:

- `status=running`: keep `job_id`. `elapsed_ms` is elapsed time and `note` explains why the initial wait ended. Wait on that job when its result is needed; do not rerun the command. Jobs are registered from startup and can be found with `job_list`.
- `status=completed`: read `output` and inspect `exit_code`, `signal`, and the explanation. Completion does not imply exit zero; `signal` identifies process termination by signal.
- `status=killed`: retain `detail` and any `output`, then decide how to handle unfinished work.

`truncated` marks shortened display content; see section 4 for continued reading.

### 3.2 async_wait

Use this when a background result or message is needed. Ending the call ends this wait, not the task.

| Argument | Type | Required/default | Rules |
| --- | --- | --- | --- |
| `wait_ms` | number | Required; no default | Finite nonnegative number; fractions allowed. Negative or non-finite values are rejected. Positive values clamp to minWaitMs..maxWaitMs; 0 checks without waiting |
| `targets` | array | Optional; defaults to no targets | Each item has kind and a nonempty id; kind is job or agent; repeated targets are deduplicated |

These are Agent tool calls:

| Needed outcome | Call |
| --- | --- |
| Any processable message or job result | `async_wait(wait_ms=30000)` |
| A job finishing | `async_wait(targets=[{kind:"job", id:"<job_id>"}], wait_ms=30000)` |
| A child changing | `async_wait(targets=[{kind:"agent", id:"<agent_id>"}], wait_ms=30000)` |
| Current states or continued undelivered content | `async_wait(wait_ms=0)` |

Without targets, the call delivers ready results first. With none ready, it waits for later messages only after confirming a running job or child belonging to the caller. Confirmed absence of work returns `no-work` immediately; it does not simply wait for future messages. Failed queries that prevent a decision return `unconfirmed`; recheck as instructed.

Targets can mix jobs and children. Any eligible target event, user steering, or budget expiry returns control; non-target notices do not end the wait early. Job targets wait for a terminal state. Child targets wait for state changes or target messages; **the child's final answer arrives separately**.

All targets are validated together before delivery. An invalid ID rejects the call, so correct it before waiting. For an absent job, check `job_list`; for a failed listing, recheck the same target rather than starting new work. A newly created child temporarily absent from the directory can be retried during a positive wait, for at most three query periods within the total budget. Zero-wait calls do not retry.

Section 4 explains `status`. `waited_ms` is actual checking and waiting time. `targets` gives per-target states; visible text shows at most 8 target lines and counts the rest.

The body location depends on the return branch. A `completed`, `failed`, or `killed` return triggered by a terminal job places that job's body in `output`; other jobs in the batch use `outputs[*].text`. Untargeted returns and zero-wait increments from running jobs provide bodies only through `outputs[*].text`, without necessarily having a top-level `output`. `delivered` contains batch metadata, not a replacement for the body.

Queries, retries, and waiting share one budget rather than restarting it at each step. Even a zero-wait call must check states and can take time: all checks share a 1000 ms window, with unfinished queries marked `unconfirmed`. Positive waits allow 300 ms of scheduling tolerance; do not use them as precision timers.

### 3.3 async_agent

Creates a resumable child in the background and immediately returns `agent_id`, without waiting for the final answer. There is no `run_in_background` argument.

Before starting each child, the tool reads DSH’s `subagent.maxDepth` setting and passes it to the execution backend. This is neither a tool argument nor a plugin setting. A limit of 0 rejects creation. The host’s factory limit of 1 permits a root Agent to create a first-level child and rejects further delegation below that level. Saved changes apply to subsequent calls without restarting.

Reaching the limit, failing to read the setting, or using a backend unable to enforce the configured limit produces an error without a successful `agent_id`. Check the depth, setting, or backend support indicated by the error; do not switch entry points to bypass the limit. Real model-driven nested creation and restored sessions still have verification gaps. Check depth-dependent tasks in an isolated instance first; see [known issues and verification gaps (Chinese)](<issues.md>).

| Argument | Type | Required/default | Rules |
| --- | --- | --- | --- |
| `description` | string | Required | A 3–5-word display label |
| `prompt` | string | Required | Complete task, materials, conditions, and completion criteria; the default spawn child cannot see the parent conversation |
| `cwd` | string | Parent's current directory | Initial child directory; relative paths resolve against the parent's current directory, and later changes are independent |
| `provider` | string | Conditionally available; paired with model | Exact LLM provider ID |
| `model` | string | Conditionally available; paired with provider | Exact model ID; query before use |
| `reasoning_effort` | string | Conditionally available | May be supplied alone; nonempty effort ID supported by the effective model |
| `agent_preset` | string | Conditionally available | Selects a child preset from the allowed list; see section 7 for configuration |

The execution backend must support resumable children. A registered backend supporting only one-off external execution cannot be used by `async_agent`. Model arguments appear only if that backend also supports them; passing unsupported arguments is an error. The `subagentProvider` setting selects the execution backend, default `spawn`; the call's `provider` selects the model provider. These are different. With a context-inheriting backend, the child's access to the parent conversation follows that backend.

A label and complete task are usually sufficient, with a default or inherited model. Success returns `status=started`, `agent_id`, and an explanation including the model's source. A rejected creation does not return a successful ID. Keep the ID and do independent work, then use `async_wait` for target changes when needed. Continue the conversation with `send_message`, or stop the child with `interrupt_agent`.

The shipped presets configure no selectable child presets, so they do not expose `agent_preset`. Section 5 explains explicit model choices, querying permission, and inheritance.

### 3.4 async_workflow

Use this only for an explicitly requested workflow or large-scale multi-agent orchestration. One or two delegations should use `async_agent` without a script.

| Argument | Type | Required/default | Rules |
| --- | --- | --- | --- |
| `script` | string | Required | JavaScript script body with top-level await; use return for a JSON-serializable value |
| `meta` | object | Required | Run name, description, and optional phase declarations, as described below |
| `args` | object | Optional | Input available as args in the script; wrap a list in an object field |
| `yield_ms` | number | defaultYieldMs | Same initial-wait bounds as async_run |

`meta` is a JSON object in the tool arguments, not part of the script:

- `name` and `description` are required strings. A short kebab-case name is recommended.
- `whenToUse` is an optional string; `phases` is an optional array.
- Each phase requires `title` and optionally accepts string `detail`, `provider`, and `model`. Declaring phases supplies progress labels; it does not execute stages or switch models automatically.

Do not add other meta or phase fields: the current engine rejects them before startup with `META_INVALID`. The script is neither TypeScript nor a module; do not write `export const meta`.

Scripts coordinate work; children perform actual file and network operations. The script environment has no filesystem, network, timers, or Node.js API. Available functions are:

| Function | Usage and failure behavior |
| --- | --- |
| `agent(prompt, opts?)` | Returns a Promise for one child's completion. Normally yields final text; ordinary child failure yields null. opts accepts only label, phase, provider, model, and schema. provider and model can be overridden independently |
| `pipeline(items, ...stages)` | Each item progresses independently, without waiting for every item to finish the preceding stage. Stages receive (prev, item, index), giving access to the previous result and current item. An ordinary stage exception makes that item null and skips its remaining stages |
| `parallel(thunks)` | Runs zero-argument functions concurrently and waits for all of them. Ordinary exceptions make the corresponding result null. Use when the next step genuinely needs all results |
| `phase(title)` | Marks current progress; declared phases in meta.phases are matched by exact title |
| `log(message)` | Records progress; workflowProgressLog controls inclusion when background job results are read. Completion within the initial wait does not attach these logs |

For a structured child result, provide an object-root JSON Schema as `opts.schema` to `agent`. Supported keywords are `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, and `oneOf`; `pattern`, `format`, and numeric bounds are unsupported. The annotations `description`, `title`, `default`, and `examples` are also allowed but do not affect validation. The first two must be strings; the other two must be fully representable as JSON. With a schema, `agent` returns a validated object.

For example, give `args` an `items` list and use this script to review each item:

```javascript
const results = await pipeline(args.items,
  async (_, item) => agent(`Review this item: ${item}`, { label: 'Review item' }));
return results.filter(value => value !== null);
```

This example keeps only successful results. If failures must be reported, retain a separate association between items and failures. The script must explicitly return a root value. A missing `return` producing `undefined` is a runtime error; an intentional `return null` is valid.

Invalid arguments, unknown options such as `effort`, `isolation`, or `agentType`, unsupported schemas, and total/composition limits terminate the whole script rather than becoming local null values. The host defines concurrency and total limits; full concurrency slots queue work.

Completion in the same call returns `status=completed` and `result` as a rendered string, not the original JSON object. A background run returns `status=running` and `job_id`, with results arriving through wait returns or completion messages. `status=killed` means the run was terminated and may include `detail`. Ending a wait does not cancel orchestration; `job_kill` requests cancellation. A missing engine fails before startup without creating a job. Section 7 explains engine configuration for custom presets.

### 3.5 async_list_subagent_models

Reads model catalogs and selection permission from DSH without creating children or running model inference. Do not substitute display names for IDs.

| Argument | Type | Required/default | Rules |
| --- | --- | --- | --- |
| `provider` | string | Optional | Exact provider ID; omit for provider browsing or cross-provider search |
| `model` | string | Optional | Together with provider, gets exact model details including efforts |
| `query` | string | Optional | Searches IDs and display names, ignoring case and surrounding whitespace; a nonempty query conflicts with model details |
| `target_tool` | string | Optional | Intended creation-tool name, including configured names; a tool invisible to the session or disallowed by this step's condition gives `not-allowed`; an unverifiable step permission gives `unconfirmed`. See `basis` for the reason |
| `page` | integer | 1 | At least 1; later pages require version |
| `page_size` | integer | 20 | 1..100 |
| `version` | string | Optional on first page | Continuation uses the preceding result's version and the same filters and target |

Omit provider and query to list providers, supply provider to list its models, or supply query to search. Whitespace-only query means omitted. Supplying only model asks for provider too.

```text
async_list_subagent_models(query="coding", target_tool="async_agent", page_size=20)
async_list_subagent_models(provider="<exact ID>", model="<exact ID>", target_tool="async_agent")
```

Read these parts of the result:

- `entries` contains this page's items, `mode` identifies the query type, and `total` is the match count.
- When browsing models or searching, first inspect `target`, `verdict`, and `basis` to check whether the target supports explicit selection in this step. Then inspect each model entry's `selectable`: only `true` confirms that route is selectable for the target; `false` means it is outside the allowed list, and an absent field does not confirm permission.
- For exact-model details, `verdict` applies to the specific route queried. When selection is allowed, `example` is a template matching the target tool's argument structure. Browse and search examples use only selectable entries on the current page. Before reuse, supply the task and replace any `reasoning_effort` placeholder with one exact effort ID, or remove that field if no explicit effort is needed.
- `complete=false` means some providers could not be read; `failed_providers` identifies them. total then counts only obtained results, not evidence that other providers have no models.
- For another page, reuse the returned `next` object in the next query. It already contains the page, size, version, and filters. If the version expires, restart on page 1 instead of merging old and new pages.

Results are stably ordered by ID within a version. Beyond-end requests return an empty page and the total, not page 1. Exact IDs in the allowed list can still be queried when not listed in the catalog; catalog absence alone does not mean unsupported.

## 4. Wait states and direct delivery

### Understand why the wait ended

A wait ending does not mean a task ended. Check `status` before deciding whether to handle messages, continue other work, or wait again.

| State or observation | Meaning and next action |
| --- | --- |
| `running` in a command or workflow's initial return | The initial wait ended because of expiry, user steering, or cancellation; read `note` for the reason. Keep `job_id`. Ending the wait did not stop the task; use the returned query findings for its current state |
| `running` from `async_wait` with explicit targets | Usually means the wait budget expired; an internal spin guard can also return early. Inspect each target's state and `note` rather than assuming every target is still running. Wait again only when the original result is still needed |
| `budget` for an untargeted positive wait | The wait budget expired without an eligible message. Reassess whether waiting is still needed from known work states and the returned content |
| `budget` with wait_ms=0 | The immediate check finished; this is not a wait timeout. Decide what to do from the returned content and target states |
| `interrupted` / `message` | User steering or a processable message ended the wait early. Handle the new content; the target may still be unfinished |
| `cancelled` or a host cancellation error | This call was canceled, not the task. Find a missing identifier with job_list or a completion message |
| `no-work` | Checks confirmed there is no work to wait for, either at entry or after all work ended during the wait |
| `unconfirmed` | Failed or timed-out queries prevented confirmation. Recheck the original target as instructed, rather than creating new work |
| Job `completed` | Read the body and check the exit code |
| Job `failed` / `killed` | Preserve the error, signal, and existing output before deciding how to handle unfinished work |
| Child `changed` / `settled` | The target changed, or is not currently observed running. The final answer arrives separately; this state alone is not success |
| Query or read failure | Retry reading the original target, not running the task; a failed read does not mark unread content as read |

User steering ends a wait; queued messages stay for the next turn. Untargeted waits can also wake for Agent messages, notices, and package late answers. With explicit targets, non-target messages remain for normal host processing.

Use `job_kill` to actually stop a job, `interrupt_agent` to stop a child, and `send_message` to continue its conversation. If a child is `settled` but its answer has not arrived, do other work. If none remains, report progress and end the turn so the separate message can arrive. Repeated waits on a static target return immediately rather than producing its final text; no sleep job is needed to keep waiting.

Multiple-target results report each known state separately. `not_found` means confirmed absence, while a failed read means unknown. Do not count unknown targets as running or finished.

### Normal results arrive directly

Job results arrive in the initial call's return, an in-flight `async_wait` return, or a completion message. No separate retrieval tool is needed. Normal reads send only content not already delivered; consumed history cannot be arbitrarily replayed. Save anything that must be kept.

A failed read gives an explanation and retry instructions rather than saying the result is empty. Retry the original target as instructed to continue reading unread content.

Other plugins may provide jobs accessible to multiple sessions. Each authorized session can check status, but each does not receive its own copy of the body. The host supplies only unread content: once session A reads a portion, session B cannot retrieve that portion and can read only later content that no other session has consumed. Save needed content in the session that receives it before using it elsewhere.

Zero-wait calls can also read unread increments from public running jobs with no owning session. The plugin manages received content and reading allowances separately for each session; this does not copy body content already consumed from the host by another session.

### Shortened output or deferred entries: continue reading

For a result marked `truncated`, omitted middle sections, or deferred entries, use zero-wait once allowance is available. Deferred content stays buffered; an allowance reset alone does not resend it, and a new job’s completion message need not include older content.

```text
async_wait(wait_ms=0)
```

`maxResultChars` defaults to 12000, measured by JavaScript `String.length`, not bytes. The plugin uses the host’s step events to account for shared content. The triggering target has priority, followed by readiness order; empty entries count. The design limits a common input to 10 entries, but the current candidate does not carry entry and notice usage across batches split around prompt assembly: a controlled sequence can deliver 20 empty-job statuses in one claim. This is not duplicate output and does not establish excess nonempty body content. Do not estimate total status-text overhead from the character setting alone.

At each host `agent/pre-step` event, this line recalculates the input allowance and rebuilds the batch balance. Completion messages already injected but not yet claimed continue to count against it; changing steps does not grant those shares again. A turn ending or an internal batch closing does not itself add allowance.

Within one window, an earlier creation call or other result can spend the allowance before a later wait, leaving that wait with only status and deferral information. Pending completion messages can keep using allowance across steps, so the next step need not collect everything. Resetting allowance does not automatically resend older bodies. After processing the current return, use zero-wait in a later model step when unread content is still needed.

If allowance remains unavailable, stop retrying in place, retain the job ID and deferral messages, do independent work or end the current phase, and ask the instance maintainer to investigate. This does not prove output loss; do not rerun a side-effecting task to recreate its result.

Totals within real model requests remain unverified, so the setting alone cannot predict request length. Status, necessary explanations, retained paths, conversation history, and other sources are separate from the content allowance. Inspect actual requests when checking consumption.

An oversized entry keeps its head and tail while its middle remains for later reading. Excess entries are deferred in full. Status, necessary error explanations, and retained-output paths are outside the body allowance. **Shortened display does not mean the content was lost.**

Very long job IDs cause notices to use shorter instructions. A read-failure notice can still shorten the ID in its status line, and the untargeted zero-wait suggested by the shortest notice may not return the promised status. First obtain the full ID from `job_list`, then retry the original job explicitly. For IDs containing quotes or backslashes, do not copy an unescaped call from the notice; encode the complete ID correctly as a string tool argument. These notice problems do not prove the body was lost. Do not rerun the original job.

With `fullCommandEcho=true`, background results attach command or script source. Result bodies use the allowance first. Source uses the remainder only when that delivery's body fits in full. Oversized source retains its head and tail in a 6:4 ratio with an omission count; no remaining allowance produces a note that source was not attached.

In normal delivery, each job's source is attached at most once, not again in later batches. **Omitted source cannot be continued through later reads**; inspect the original UI call record for the full command or script. Results completed directly in the initial call and job listings do not attach source. Original UI records are unaffected by this switch. Command listings use `description`, while workflows use `meta.name`.

### A tool result may not have arrived: request a recovery copy

If a call was canceled and the Agent did not receive the expected body, find its ID with `job_list` and name it in a zero-wait call. Recovery uses the same available content allowance as normal continuation. If it remains deferred, follow the steps above rather than assuming recovery is guaranteed in the next input.

```text
async_wait(targets=[{kind:"job", id:"<original job_id>"}], wait_ms=0)
```

When allowance is available, unread middle sections and deferred content arrive first. If none remains, the plugin can resend an unconfirmed copy marked “recovery copy / may duplicate”; its body also consumes the allowance. Large content continues across batches, subject to the exhaustion handling above. Already-confirmed content returns only status and an explanation, not the body. The host handles delivery confirmation without an extra user action.

Copies are retained for at most 30 minutes by default, subject to per-session caps of 10 records and 2×maxResultChars characters in total. Oldest entries are removed first, and unloading a plugin row clears its records, so copies can expire earlier. If a copy is unavailable, inspect original UI records and known retained-output paths. Without a body source, recovery cannot be guaranteed.

Different output copies from the same job are handled separately. Confirmation of one portion does not make known expired content count as fully delivered. For a terminal job with some content confirmed and other copies unavailable, recovery reports partial confirmation and the missing portions.

Once no unread body remains and the request enters copy recovery, it reports known expired or removed copies even while the job is running; a running state is not treated as proof that earlier content arrived. Recovery continues from its current position. The “may duplicate” marker means the original carrier may already have been received, so resent text is not new output. If content is incomplete, keep the job ID, inspect original records and known retained paths, and contact the instance maintainer if needed. Do not repeat a side-effecting task to recover its result.

### The host reports lost buffering: inspect known retained paths

`lossy` means the host actually lost some buffered content, unlike display shortening. The host reports retained-output file locations through `spillPaths`; this package keeps them with or without lossy. Open complete paths where authorized, save required content promptly, and redact before sharing.

Paths are listed in full, without shortening individual paths. Each return allocates about 2000 characters per job to path listings. If a single path exceeds that amount, at least one complete path is still listed. When more paths remain, the note gives the remaining count and continuation instructions.

Name the original job in a zero-wait call to continue listing its paths:

```text
async_wait(targets=[{kind:"job", id:"<original job_id>"}], wait_ms=0)
```

Check the remaining count after each return. If paths remain, repeat the same call until the listing is complete. This retrieves retained-output locations; it does not rerun the task or replay body content already confirmed delivered. Structured tool returns also carry the complete `spill_paths` array, but model-facing text and plain-text completion messages do not display that field directly. Normal continuation does not require finding it.

If the job or plugin delivery record has been cleared and continuation is unavailable, keep the job ID and existing note. Inspect accessible original records, or ask the instance maintainer to check host or producer retention information. Without usable records, omitted locations may not be recoverable.

Temporary files may be cleaned up and may not contain the full result. Without a usable path or copy, the plugin has no known recovery route. Do not assume a full disk copy exists or automatically repeat a command with side effects.

## 5. Model catalogs, authorization, and inheritance

### Discover, create, and wait

A model route is an exact provider ID and model ID pair. Usually omit model arguments to use a default or inherited model. When an explicit choice is needed and the current execution backend supports it, follow these steps. IDs below are placeholders.

1. Identify the intended creation tool before querying:

   ```text
   async_list_subagent_models(query="coding", target_tool="async_agent", page_size=20)
   async_list_subagent_models(provider="<provider ID>", model="<model ID>", target_tool="async_agent")
   ```

2. Read `verdict` and `basis`: `allowed` means the target permits explicit selection in this step, `not-allowed` means it does not, and `unconfirmed` means information is insufficient. In browse or search results, `allowed` does not authorize every listed model: choose an entry with `selectable=true`. An exact-detail verdict applies to the route queried. Use `next` for further pages, restarting on page 1 if its version expires. Permission checks do not validate credentials or remote availability.
3. After selecting a confirmed selectable route, pass its exact IDs together and provide the complete task. Alternatively, reuse the returned `example` template: supply the task, replace any `reasoning_effort` placeholder with one exact effort ID, or remove that field if no explicit effort is needed. A minimal call looks like:

   ```text
   async_agent(description="Review one isolated item", prompt="<complete task, materials, and completion criteria>",
               provider="<provider ID>", model="<model ID>")
   ```

   Add reasoning_effort when needed, using an effort supported by that model. It can also be supplied alone for a default or inherited model.
4. Keep the returned agent_id and do independent work first. For progress, call:

   ```text
   async_wait(targets=[{kind:"agent", id:"<returned agent_id>"}], wait_ms=30000)
   ```

   This waits for a target change; the final answer arrives separately. For a follow-up, use send_message to continue the same child's conversation instead of creating a replacement.

### Current policy and refusals

Permission comes from DSH's subagent model-selection switch and allowed list, not a duplicate list in this plugin's settings. For explicit model or effort choices, **each creation** through `async_agent` reads current policy and rechecks permission before launch, including in existing sessions. Saved changes affect subsequent creation, not running children.

Disabling model selection rejects explicit provider, model, or reasoning_effort. Omitting all three still uses defaults or inheritance. An invalid list, failed read, or withdrawn route reports its cause rather than automatically substituting a model. Damaged policy data needs repair by the instance maintainer; execution-backend lookup failures need investigation of the host error. Neither is solved by choosing an arbitrary replacement model.

Permission always applies to a particular creation tool. Without target_tool, exactly one recognizable entry can be selected automatically; multiple or no entries give unconfirmed. A named entry invisible to the session gives not-allowed, though catalog data can still be returned.

DSH 0.2.2 also checks whether the target is callable in the current model step. Registration and session visibility alone do not establish this. If the step condition is false, the verdict is `not-allowed` and `basis` explains that the condition is not met. If the call has no resolved step tool set, the permission interface is unavailable, or the check fails, the verdict is `unconfirmed` and `basis` explains the cause in text. Catalog data can still be returned, but these outcomes supply no confirmed selectable routes or creation example.

When the current step condition is not met, wait for a legitimate step in which the target is permitted or ask the preset maintainer to check its conditions. For an outside-step query, have the Agent query again during a normal tool step. An unavailable interface or failed check needs investigation by the instance maintainer before retrying the same target. Do not create a task merely to change the verdict or switch tools to bypass the condition. A successful query does not replace the creation tool’s own validation and approvals.

Native creation tools use their own session policy, and workflow agent() has separate rules. Do not apply async_agent permission or argument requirements to other entries. Pagination and search arguments cannot be passed to creation either. After refusal, query again for the same target rather than changing entry points to bypass limits.

If a native creation tool permits model selection but the session has no recorded allowed list, explicit selection is limited to the exact provider and model currently used by the parent Agent. Discovery follows that rule; with a recorded list, it checks that list instead. The target's identity must still be confirmed: its name alone is not enough to apply the parent-model rule.

With several native creation aliases in one group, a later alias may receive only `unconfirmed` because it lacks an independent identity section, even though the native tool is legitimately present. Keep the target name and `basis` for the maintainer to investigate. Do not treat an unconfirmed result as permission or switch entry points to obtain an allowed verdict.

For custom presets that supply child-model defaults, see [child defaults and selectable presets](<#child-defaults-and-selectable-presets>).

## 6. Question takeover and silent failures

### Enable the panel and find questions

Enable `askTakeover` and save. Ordinary questions from root Agents on presets in boundPresets then enter the pending panel. Approvals, plan reviews, child questions, and unlisted presets remain with DSH.

With askUiSeat set to sidebar, click the unanswered count at the sidebar bottom to expand the panel. With overlay, questions appear at the lower right. The panel can open the original session, answer, ignore, or extend time. New questions announce the added count to assistive technology without taking keyboard focus or automatically reading the whole question. The countdown does not repeat the announcement.

If the pending-state read fails, the sidebar entry remains available. Open the panel, or inspect the overlay, to read the error; automatic retries continue in the background. The sidebar shows “?” when no cached count is available, or keeps the cached count until a successful read supplies the actual number. **While reading has failed, the panel title reflects the read state: with no cached items it shows “count unknown (state fetch failed)”; with items from the last successful read it shows “last read: N pending” and still renders those cached items — neither form presents a cached count as currently confirmed. A successful read restores the actual count.** If questions seem missing or errors persist, check the original session and its deadline, reply there if needed, and give the instance maintainer redacted symptoms and triggering steps.

### Answer or ignore

Single-choice questions accept one preset option or the custom answer. Multiple-choice questions can combine choices; custom text is an independent answer, not a note appended to an option. Nothing starts selected, including recommendations.

The custom answer uses a multiline input below its title and choice control, about three lines high and vertically resizable. Clicking it or typing non-whitespace text selects the custom option. Moving keyboard focus into it alone does not change selection. Enter inserts a line break; use the button to submit. Submission is temporarily disabled during IME composition. After composition ends, submit explicitly again; nothing is sent automatically.

Deselecting the custom option can retain its draft without sending it. Clearing a selected custom answer keeps it selected, so enter valid text or deselect it. No selection, or a selected whitespace-only custom answer, prevents submission even when a multiple-choice question has other choices. Select the separate **Skip** button to leave a question unanswered.

Answer text and line breaks are delivered unchanged. Unselected options and drafts are not included.

### Deadlines, extensions, and late answers

Questions from one call share a deadline, default 60 seconds. At expiry, answered and ignored states remain. Unanswered questions return `selected=[]` to the Agent with a timeout explanation in custom, without choosing an answer. **Timeout is not permission**: if a necessary decision is missing, the Agent must still explain why work cannot continue.

For more time, use the session group's extension action. It adds askExtendMs, default 60 seconds, to each batch still active at click time. New questions are unaffected, and expired calls are not reopened. If confirmation is missing, refresh and check the actual deadline before clicking again.

After expiry, questions can still be answered or ignored in the panel. A notification returns to the original session with the full question, options and descriptions, actual answer or ignore state, and time. If the session is idle with no package delivery waiting to start, the late answer starts a turn; otherwise it arrives at a later message-processing point. Untargeted async_wait calls wake only after the host accepts the notification; waits targeting jobs or children are not interrupted by unrelated answers.

### Missing acknowledgement or failed submission

Check the panel's submission response. Explicit delivery failure reopens the question for retry as instructed; replying directly in the original session is also possible. When a submission returns no acknowledgement at all (no gateway response), the panel shows a submission-channel error at the top and reopens the question for another attempt — this is a missing confirmation, neither delivered nor failed. Wait for the panel to refresh and confirm the actual state before retrying, and do not resubmit when the panel says another client has already answered. If the panel reports that the batch or question no longer exists and the answer was not delivered, reply in the original session.

Panel records are held only in memory. Unhandled records more than 24 hours past expiry are cleared when a new question batch is intercepted. With no new batch, they can last longer, so 24 hours is not a fixed late-answer deadline.

When the plugin's takeover service unloads normally, unfinished questions return to an available host flow; if hand-back is unavailable, they are canceled. Restarting the instance loses in-memory records and does not guarantee that the original question cards return. Expired calls are not handed back. Before restarting or uninstalling, finish pending answers or write important answers into the original session.

If a question call is rejected as a whole, check that questions is an array and that no question has duplicate options with identical labels and descriptions. The same label with different descriptions is allowed. A multi-question batch is not partially handled.

### A command should have produced output, but did not

`silentFailureGuard` is off by default. Enabling it adds command diagnostics, tool-description warnings, and operating instructions for presets in boundPresets. It reminds the Agent to check execution rather than replacing host execution logs.

Some restricted environments block commands before process startup when they capture output, for example through variable assignments, subexpressions, `2>&1`, or output redirection. An executed command can also leave no visible output because it was captured. Empty output alone proves neither success nor non-execution; a multi-statement command may have executed only its earlier statements.

The current diagnostic reports “execution unconfirmed” when a capture form, empty output, a nonzero or unknown exit code, and the other diagnostic conditions coincide. Exit code 0 does not trigger this warning. The check uses command text and exit information; it cannot establish the actual side effects.

Check in this order:

1. Inspect the tool's exit information and expected side effects, plus `$LASTEXITCODE` on PowerShell (pwsh) deployments; platforms whose executor is not PowerShell have no such variable — check the exit-code marker instead. For output redirection, check the target file first; no console output may be the intended result.
2. If the execution channel is still in doubt, run a separate harmless probe without capture, such as `Write-Output EXEC_CHECK`, and inspect host logs as needed.
3. Decide what to do from the findings, whether the operation is safe to repeat, and the current authorization. Rerunning the original command is not the channel check. Wider permissions still require the current tool's escalation conditions and host approval; a warning does not add permission.

## 7. Advanced composition

This section is for authors editing DSH composition and custom presets. For ordinary installation, choose a shipped preset. Prefer the settings page for waiting, language, and question settings.

### File configuration and migration

DSH composition consists of plugin rows: name chooses the plugin and config configures that row. This package uses two kinds:

- **Host configuration row**: async-tools-host, without toolName. It provides shared settings, the settings page, and question handling, and loads automatically with installation.
- **Tool rows**: placed in a preset's plugin list. config.toolName selects the tool registered by that row.

To supply defaults for settings in section 2, edit the target profile's overlay rather than installed package files. First establish the DSH_HOME actually used by the target instance. The default is `.dsh` under the OS user's home, but service launchers can set another directory; the current terminal's default does not establish the instance's directory.

1. Locate `<actual DSH_HOME>/profiles/<profile>/cordis.patch.yml`. To inspect the composition, use the same DSH installation and DSH_HOME to run `dsh --profile web --dump-config`, replacing web for another profile. This is read-only output, not a query to a running instance. It may contain private configuration; do not publish it as-is.
2. Find the overlay item with ID async-tools-host, or add the example below if it has no overlay yet. With an existing item, merge values into its config.settings and **retain other settings already present**. The host replaces the entire config rather than deep-merging it. Do not append a second overlay for the same ID that would discard existing defaults.

   ```yaml
   - id: async-tools-host
     config:
       settings:
         agentLang: zh
         defaultYieldMs: 30000
   ```

3. Save the file, arrange for active tasks to finish safely, then reload as required by the host. Check effective values in the settings page and a new session. User overrides saved through the form still take priority over file defaults.

The 0.2.5 flat form, such as `config: { agentLang: zh }`, does not take effect on 0.2.9 or this 0.2.10 candidate. Before upgrading, change it to `config: { settings: { agentLang: zh } }` and move other settings likewise. Otherwise the row can load while language, wait durations, and switches fall back to defaults. Removing user overrides cannot fix misplaced values. Load logs may list ignored flat keys; still read values back after migration.

Tools normally use the host row's shared settings. Only when that row is not connected do tools use valid tool-row settings as fallback and report a warning. If the form saved but tools report disconnected settings, repair the host row rather than duplicating settings across tool rows.

### Create a custom preset from the complete preset

If no custom preset exists yet, copy a complete shipped preset. This retains the basic services needed by commands, children, and workflows instead of building an empty shell from a few tool rows.

1. Open the packaged [complete asynchronous preset](<../presets/dsh-async.patch.yml>). Copy its entire `- insert:` declaration, including the complete config.plugins list inside it.
2. Locate the target profile overlay described above. Keep its existing contents and append the copied declaration as a new top-level list item; do not replace the file.
3. Change only the outer preset declaration's identity: replace its row id, preset-dsh-async, with a unique value such as preset-my-async. Change its config.id from dsh-async to my-async and config.name to a new display name; description can also be changed. Keep all contents of config.plugins. Do not globally replace dsh-async or insert another preset using the original IDs.
4. Save, arrange for active tasks to finish, and reload as required by the host. Create a session, select the new display name or ID, and confirm all five tools are visible.
5. Select my-async under boundPresets in the plugin settings and save to give the preset asynchronous operating instructions. Refresh the list if the new candidate has not appeared. Silent-failure warnings and the question panel still need their respective switches.

Make subsequent tool and default changes only in the copied preset. It retains the original's basic services and asynchronous tools without changing the shipped preset.

### Mount all five tools in an existing custom preset

To retain an existing custom preset's composition, merge the following rows into its config.plugins list. This is a fragment, not a standalone preset or a replacement for the complete-copy path above. It does not automatically disable existing synchronous tools.

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

The first four rows each mount a tool; the final group puts the workflow tool beside its engine. workflowEngine isolation makes the group's tools use that engine; placing async_workflow outside may leave it without an engine. If a delegation group already exists, merge into it rather than duplicating groups or tools.

The engine also needs DSH's subagents, ptcRuntime, sandboxPolicy, and workingDirectory services. Use composition and engine load logs to locate missing provider rows rather than removing dependency checks to force startup. If the engine cannot execute the current sandbox policy, choose an engine and host configuration supporting that policy or stop the workflow, without automatic escalation.

After a safe reload, create a session with the custom preset and confirm all five tools are visible. Add its ID to boundPresets and save if asynchronous instructions are wanted. Also enable silentFailureGuard or askTakeover for command warnings or the question panel. **Mounting is not binding, and binding does not mount tools.** Model discovery can coexist with native discovery.

### Child defaults and selectable presets

These fields belong in the **async_agent tool row's config**, alongside toolName—not inside settings or in Agent call arguments. Reload as required for composition changes.

| Field | Type and purpose |
| --- | --- |
| `agentOptions` | Object with optional provider, model, reasoningEffort strings and positive integer maxTokens, at most Number.MAX_SAFE_INTEGER |
| `agentPreset` | Nonempty default child preset ID; inherits the parent preset when absent |
| `allowedAgentPresets` | Selectable nonempty preset IDs; if provided, requires at least one entry with no duplicates. A simultaneously configured agentPreset must belong to it |

For example, replace the existing async-agent row with this configuration to allow reviewer or writer when the backend supports independent presets. Both IDs must already be registered in the target DSH:

```yaml
- id: async-agent
  name: dsh-async-tools
  config:
    toolName: async_agent
    agentPreset: writer
    allowedAgentPresets: [reviewer, writer]
    agentOptions:
      maxTokens: 4096
```

The tool exposes agent_preset only with a configured allowed list and a backend supporting independent preset selection. This differs from boundPresets: the former lets the parent choose a child preset; the latter determines which sessions receive package auxiliary features. An absent allowedAgentPresets hides the choice; an empty array is invalid.

Before supplying model defaults, query exact IDs and put them in agentOptions.provider/model. The configuration key reasoningEffort is camelCase; the call argument reasoning_effort uses an underscore. Model defaults resolve as follows:

1. Explicit call arguments take priority over tool-row defaults.
2. An explicit model/effort request, or provider, model, or reasoningEffort in the tool row, triggers an effective-model support check. The execution backend's agentRouteDefaults then contributes lower-priority defaults, with missing parts filled from the parent model.
3. With only non-model options such as maxTokens, or no defaults at all, backend model defaults are not additionally applied; the host inherits the parent model. When no options contribute, the creation request omits agentOptions as well.

Only explicit model choices undergo DSH's current allowed-list check. Tool-row defaults triggering a support check do not make the call explicit. On a changed model without a requested effort, the check does not copy an incompatible effort from the old model. Compatible values used temporarily for checking are not written back into the creation request. To require a particular effort, explicitly choose a supported reasoning_effort. Use the creation receipt for the final model and inheritance source.

### Development links

Use a development link only when editing plugin source; do not link a stable deployment to a tree being edited:

```powershell
git clone https://github.com/MC5Spear/dsh-async-tools.git
cd dsh-async-tools
git checkout adapt/dsh-0.2.2-alpha
npm install
dsh plugin --profile web add <absolute-clone-directory>
```

The linked directory must resolve matching host dependencies. After installation, still confirm settings, presets, and tools as in section 1. Importing modules with Node alone does not confirm these entries.

## 8. Disable, recover, and report problems

Disable or uninstall in this order:

1. Use job_list to inspect active jobs, read and save needed results, and use job_kill to explicitly stop unwanted jobs. Stop children separately with interrupt_agent. Removing tools does not automatically stop session work.
2. Change the default preset in DSH settings. If it still points to dsh-async or dsh-async-create, new sessions fail with `agent-preset/not-found` after removal; the host does not clear the selection automatically.
3. In the target profile's plugin manager, disable or remove the package's bundle declaration and installed dependency, then reload as instructed. Restarting can terminate active processes, so confirm that tasks are ready first. For CLI operations, use the management instructions for the exact DSH version.
4. Create a session and confirm that an available preset works. If removal has already caused not-found, clear or reselect the default in host settings, then create another session.

Deleting a development-link directory does not unload modules already in memory. Existing sessions can also retain their original composition, so a deleted directory is not proof that tools are disabled.

Report through [project issues](<https://github.com/MC5Spear/dsh-async-tools/issues>). Include full plugin, DSH, and Node versions, OS, preset, relevant settings, and a minimal harmless reproduction. For background problems, keep job_id/agent_id, event order, actual exit information, and relevant logs. Do not repeat destructive commands just to gather a report.

Commands, output, and environment information can contain secrets. Remove tokens, cookies, passwords, private URLs, and secret environment values before publishing. Some model-visible errors are a single line limited to 500 characters; if the full cause is needed, the instance operator should inspect host logs and provide a sanitized excerpt.

The project is personally maintained: issues are accepted, external PRs are not, and there is no fixed response or repair schedule.

Documentation maintenance follows the [documentation principles (Chinese)](<documentation-principles.md>).
