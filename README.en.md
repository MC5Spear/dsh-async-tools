# dsh-async-tools

[中文](<README.md>) · [Complete user reference](<docs/user-reference.en.md>)

[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)

Let a DSH Agent run long commands and delegate tasks without waiting for each one to finish. Commands that outlast the initial wait keep running in the background, leaving the Agent free to do independent work. When a result is needed, the Agent waits for it; results arrive directly in the conversation. Expiry or user steering ends the wait without stopping the background task.

Install this plugin for frequent long tasks or parallel delegation. If short commands cover your needs, keeping the existing preset is reasonable.

This third-party plugin is unaffiliated with DeepSeek. It is personally maintained: issues are accepted, external PRs are not, and there is no fixed response or repair schedule. Report security problems through issues after removing sensitive information.

## Before installing

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.8+dsh.0.2.1-rc` |
| Supported dsh host versions | `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5` |

“Host” means the DSH instance loading the plugin. **Only these four DSH versions can load this package**, not the final `0.2.1` or an unlisted rc. Node.js 24 is recommended; see the [runtime prerequisites](<docs/user-reference.en.md#1-installation-identity-and-prerequisites>) before choosing another runtime.

Linux command execution and one-shot permission escalation have not been verified on a real machine. There are no verification conclusions for macOS or remote execution environments. Full real-host rechecking on rc.3/rc.4 is also incomplete. Before relying on these environments, check the features needed in a separate test session.

For IME, screen-reader, or touch-based answers, and for result recovery after a canceled tool call, also read [usage limits and saving results](<docs/user-reference.en.md#usage-limits-and-saving-results>).

## Install and confirm loading

The package is not distributed through npm. Run this in a terminal:

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1
```

Alternatively, enter `github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1` in DSH's plugin-manager installation dialog. `web` is the target DSH configuration profile in the command; substitute the appropriate name for another profile.

This address follows a moving maintenance branch. For repeatable installation, replace the branch after `#` with a full commit ID available from the repository, and keep that installation address. See [pinning and checking the installation](<docs/user-reference.en.md#install-pin-a-source-and-check-the-version>) for version checks.

After installation:

1. Open this package's detail page in the plugin list and confirm that the settings form is visible.
2. Create a session and find `dsh-async` and `dsh-async-create` in the preset selector. A preset configures the Agent's tools and working instructions; the package supplies both automatically.
3. Choose either preset and confirm that the Agent has the five tools below. Follow [installation troubleshooting](<docs/user-reference.en.md#installation-troubleshooting>) if entries are missing.

## Try a first background task

This demonstration uses factory wait settings. On Windows, create a session with `dsh-async` for general coding, or `dsh-async-create` to retain plugin and preset authoring tools. Send the Agent this request:

> Demonstrate background execution without modifying files, accessing the network, or creating children. First use async_run to run `Write-Output SHORT_OK`, then run `Start-Sleep -Seconds 30; Write-Output LONG_DONE` with yield_ms=20000 on the second call. Keep the returned job_id and do independent work first. When the result is needed, use async_wait targeting that job with wait_ms=30000. Report both markers and actual exit information. Do not rerun the command to check progress; if no identifier arrived, check job_list first.

The short command should return `SHORT_OK` directly. The 30-second command should return a `job_id` after its initial wait of at most 20 seconds. Its result, containing `LONG_DONE`, then arrives in a wait return or completion message. Still inspect exit information: `completed` means execution ended, not that the exit code was zero.

These are **Agent tool-call examples, not terminal commands**:

```text
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=20000)
async_wait(targets=[{kind:"job", id:"<returned job_id>"}], wait_ms=30000)
```

Factory settings give `yield_ms` a default of 20000 ms and bound each request to 20000–600000 ms. `wait_ms` is required every time. Expiry leaves the task running; use `job_kill` explicitly for unwanted jobs, rather than rerunning commands to check progress.

Results are not replayed indefinitely. Save anything that must be kept. For long output, failed reads, or canceled calls, continue with the original job using [result handling and recovery](<docs/user-reference.en.md#4-wait-states-and-direct-delivery>).

## Tools and presets

Both presets directly provide five tools without modifying existing presets:

| Tool | Purpose |
| --- | --- |
| `async_run` | Runs a command and returns its result or a background job identifier |
| `async_wait` | Waits for messages, job results, or explicit targets; returns immediately when there is no work to wait for |
| `async_agent` | Starts a resumable child in the background and immediately returns `agent_id`; the final answer arrives separately |
| `async_workflow` | Coordinates large multi-agent tasks with JavaScript; manages the whole run as a background job |
| `async_list_subagent_models` | Browses or searches models and checks whether a chosen creation tool can use them |

Inspection, messaging, and stopping remain DSH management operations. Children usually need no explicit model choice. When one is needed, follow [discovery, creation, and waiting](<docs/user-reference.en.md#5-model-catalogs-authorization-and-inheritance>). Each explicit model or effort choice through `async_agent` reads the current DSH model-selection policy. Saved changes affect later creation, not running children.

Custom presets can use all features too, but tools must be mounted manually and workflows need an engine. The `boundPresets` setting scopes operating instructions and auxiliary features; it does not install tools. See [custom composition](<docs/user-reference.en.md#7-advanced-composition>).

## Settings, safety, and removal

Open the plugin list → this package's detail page. Save applies edits, including Restore default actions. Ordinary valid saves need no restart. The [settings reference](<docs/user-reference.en.md#2-first-use-and-settings>) explains each field and its default.

The pending-question panel and silent-command-failure warnings are off by default. Enable `askTakeover` and `silentFailureGuard`, respectively, when needed. Both act only on presets in `boundPresets`, which defaults to the two shipped presets.

Commands inherit the session's directory, sandbox, approvals, and permissions, and can still access the network or sensitive information. The plugin itself collects no telemetry, initiates no network requests, and does not read or write credentials. Model discovery obtains data from DSH without model inference. Output and host temporary files may contain secrets; redact before sharing.

**Before disabling or uninstalling, change the default preset and deal with active tasks.** If the default still points to `dsh-async` or `dsh-async-create`, new sessions fail with `agent-preset/not-found` after removal. Select an available preset in host settings; if already removed, clear or reselect the default and confirm with a new session. Removing tools does not automatically stop session jobs, while restarting may terminate active processes. See the [removal and recovery steps](<docs/user-reference.en.md#8-disable-recover-and-report-problems>).

## AI maintainers

AI maintainers include:

- `gpt-6.1-sol`
- `kimi k3`
- `glm-5.3`
- `deepseek-v4.1-flash`

## Documentation and licensing

See the [user reference](<docs/user-reference.en.md>) for operating details. Development, requirements, design, verification, and changelog documents are in Chinese and are not shipped with the package. They are available in the [source repository](<https://github.com/MC5Spear/dsh-async-tools/tree/adapt/dsh-0.2.1>). To check an installation, use the commit from its installation address rather than the latest contents of the moving branch.

The project uses the [MIT license](<LICENSE>). Both presets and some subagent-policy helpers adapt DeepSeek Harness material. The packaged [third-party notices](<THIRD_PARTY_NOTICES.md>) contain sources, upstream copyright, and the full MIT text.

Documentation maintenance follows the [documentation principles (Chinese)](<docs/documentation-principles.md>).
