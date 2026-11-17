# dsh-async-tools

[中文](<README.md>) · [Complete user reference](<docs/user-reference.en.md>)

[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)

Let a DSH Agent run long commands and delegate tasks without waiting for each one to finish. Commands that outlast the initial wait keep running in the background, leaving the Agent free to do independent work. When a result is needed, the Agent waits for it; results arrive directly in the conversation. Expiry or user steering ends the wait without stopping the background task.

Install this plugin for frequent long tasks or parallel delegation. If short commands cover your needs, keeping the existing preset is reasonable.

This third-party plugin is unaffiliated with DeepSeek. It is personally maintained: issues are accepted, external PRs are not, and there is no fixed response or repair schedule. Report security problems through issues after removing sensitive information.

## Before installing

This is an alpha trial version for the `adapt/dsh-0.2.2-alpha` channel used below. **It has not passed stable acceptance.** Try it only in an isolated instance, and read the matching [known issues and verification gaps (Chinese)](<docs/issues.md>) before use.

The table is the package’s declared host admission set, not proof that every behavior has been verified. Check that the remote branch is accessible before installing. For repeatable installation, use a full commit ID or matching artifact and retain the actual source. This compatibility line currently has only the alpha channel above, with no stable branch. Stable promotion also requires real user experience and explicit confirmation.

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.10-alpha.2+dsh.0.2.2` |
| Supported dsh host versions | `0.2.2-rc.1` |

“Host” means the DSH instance loading the plugin. **Only the DSH version listed above can load this package**, not the final `0.2.2`, older `0.2.2` pre-releases (alphas), the `0.2.1` line, or an unlisted rc. Node.js 24.9 or newer is required; see the [runtime prerequisites](<docs/user-reference.en.md#1-installation-identity-and-prerequisites>) before choosing another runtime.

Linux command execution and one-shot permission escalation have not been verified on a real machine. There are no verification conclusions for macOS or remote execution environments. Before relying on these environments, check the features needed in a separate test session.

For IME, screen-reader, or touch-based answers, and recovery after a canceled tool call, read [usage limits and saving results](<docs/user-reference.en.md#usage-limits-and-saving-results>). `async_agent` now reads the host’s delegation-depth setting before creation; real nested-creation and restored-session verification remains incomplete. See [depth limits and refusal handling](<docs/user-reference.en.md#33-async_agent>).

If another plugin's job settled before this package began observing it, `async_wait` first checks the body's location. Where the native reader is hidden, it attempts to retrieve the original notification component's retained copy. A retrieved body follows normal delivery. If no copy is obtained, keep the job ID and explanation and follow the [result-reading limits](<docs/user-reference.en.md#usage-limits-and-saving-results>) for assistance; do not repeat a side-effecting task to recreate its result.

**Trial verification boundary:** this round’s alpha.2 test artifact was installed in an isolated DSH `0.2.2-rc.1` instance. Authenticated API checks covered version, loading, the settings namespace, both presets, and blank sessions. The final artifact has only subsequent user-document changes and identical runtime code, but has not been installed again. Installation used `--ignore-scripts` with `autoInstallPeers=false`. Fresh installation with automatic peer installation enabled, upgrades from an exact old source, full disable/uninstall behavior, and reinstall/cold recovery after a required restart remain unverified. API checks do not establish GUI usability, end-to-end operation of the five tools, or allowance totals in real model inputs. Follow required reload/restart instructions before continuing, and test only in an isolated instance.

## Install and confirm loading

The package is not distributed through npm. Installation reuses dependencies supplied by DSH; no separate DSH installation is needed. Since 0.2.9, installing or upgrading this package does not require disabling the package manager's `autoInstallPeers` option.

The package has no installation scripts of its own. If installation or an upgrade requests script approval, follow [script-approval troubleshooting](<docs/user-reference.en.md#installation-script-approval-troubleshooting>) to check the source and need before deciding whether to allow execution.

Install through the GUI:

1. Open **Plugins** in the left sidebar and select **Add plugin**. **Install a third-party plugin** in the adjacent dropdown opens the same flow.
2. Paste this into the package name/address field:

   ```text
   github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.2-alpha
   ```

3. Select **Install**, then **Enable now** on the success page. If already enabled, confirm its enabled status instead.
4. If the host requests a reload/restart, deal with active tasks and save needed results before following that prompt.
5. Open the package's detail page and confirm that the settings form is visible.
6. Create a session and find `dsh-async` and `dsh-async-create` in the preset selector. Choose either and confirm that the Agent has the five tools below. A preset configures the Agent's tools and working instructions; both are supplied with the package. Follow [installation troubleshooting](<docs/user-reference.en.md#installation-troubleshooting>) if entries are missing.

Alternatively, install from a terminal:

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.2-alpha
```

`web` is the target profile's name; substitute the appropriate name for another profile. After installation, likewise confirm it is enabled and check loading as above.

This address follows a moving maintenance branch. For repeatable installation, replace the branch after `#` with a full commit ID available from the repository, and keep that installation address. See [pinning and checking the installation](<docs/user-reference.en.md#install-pin-a-source-and-check-the-version>) for version checks.

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

Results are not replayed indefinitely; save anything that must be kept. Deferred bodies stay buffered and are collected by later `async_wait` returns while allowance permits; a new completion message need not include older content. The plugin updates shared accounting at each host step event. Completion messages not yet claimed keep using allowance, so the next step need not collect everything; totals in real model inputs remain unverified. Once allowance is available, continue with `async_wait(wait_ms=0)` rather than rerunning the task. If content remains deferred, stop retrying in place, keep the job ID and explanation, and follow [continued reading](<docs/user-reference.en.md#shortened-output-or-deferred-entries-continue-reading>) or [recovery](<docs/user-reference.en.md#a-tool-result-may-not-have-arrived-request-a-recovery-copy>).

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

The pending-question panel and silent-command-failure warnings are off by default. Both act only on presets in `boundPresets`, which defaults to the two shipped presets. Enable `askTakeover` for the panel or `silentFailureGuard` for command diagnostics. After a missing-output warning, [check exit information and actual effects](<docs/user-reference.en.md#a-command-should-have-produced-output-but-did-not>) before deciding what to do; do not immediately rerun the original command.

Commands inherit the session's directory, sandbox, approvals, and permissions, and can still access the network or sensitive information. The plugin itself collects no telemetry, initiates no network requests, and does not read or write credentials. Model discovery obtains data from DSH without model inference. Output and host temporary files may contain secrets; redact before sharing.

**Before disabling or uninstalling, change the default preset and deal with active tasks.** If the default still points to `dsh-async` or `dsh-async-create`, new sessions fail with `agent-preset/not-found` after removal. Select an available preset in host settings; if already removed, clear or reselect the default and confirm with a new session. Removing tools does not automatically stop session jobs, while restarting may terminate active processes. See the [removal and recovery steps](<docs/user-reference.en.md#8-disable-recover-and-report-problems>).

## AI maintainers

AI maintainers include:

- `gpt-6.1-sol`
- `kimi k3`
- `glm-5.3`
- `deepseek-v4.1-flash`

## Documentation and licensing

See the [user reference](<docs/user-reference.en.md>) for operating details. Development, requirements, design, verification, and changelog documents are in Chinese and are not shipped with the package. They are available in the [source repository](<https://github.com/MC5Spear/dsh-async-tools/tree/adapt/dsh-0.2.2-alpha>); use source matching the installed commit or artifact. To check an installation, use the commit from its installation address rather than the latest contents of the moving branch.

The project uses the [MIT license](<LICENSE>). Both presets and some subagent-policy helpers adapt DeepSeek Harness material. The packaged [third-party notices](<THIRD_PARTY_NOTICES.md>) contain sources, upstream copyright, and the full MIT text.

Documentation maintenance follows the [documentation principles (Chinese)](<docs/documentation-principles.md>).
