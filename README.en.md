# dsh-async-tools

[中文](<README.md>) · [Complete user reference](<docs/user-reference.en.md>)

[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)

A slow command or a task delegated to a child Agent need not keep the DSH Agent waiting. This plugin starts that work in the background so the Agent can continue independent tasks. Wait when a result is needed; results arrive directly in the conversation. Each wait has a time limit, and expiry leaves the background work running.

Install it when long tasks or parallel delegation are common. If short commands cover your needs and you do not delegate background work, keeping your existing preset is reasonable. “Host” means the DSH instance loading the plugin.

This third-party plugin is unaffiliated with DeepSeek. It is personally maintained: issues are accepted, external PRs are not, and there is no fixed response or repair schedule. Report security problems through issues after removing sensitive information.

## Before installing

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.8+dsh.0.2.1-rc` |
| Supported dsh host versions | `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5` |

**DSH must be one of the four versions above.** The final `0.2.1`, `0.2.0`, `0.2.2`, and any new rc not listed are rejected. Node.js 24 is recommended. The plugin's Node declaration is not a minimum for the whole DSH installation; check the [runtime prerequisites](<docs/user-reference.en.md#1-installation-identity-and-prerequisites>) before choosing another runtime.

### What has been checked

Verification for this line is limited to a local Windows machine and isolated instances. The checks cover different things:

- The full plugin module test suite and static checks passed under each supported host.
- A real browser was used to check key settings-page and question-overlay behaviors and their accessibility trees.
- Real model sessions sampled the five tools' core behaviors, including background delivery, waiting and user steering, child continuation, and late answers. This is not an item-by-item real-host check of every feature.
- An installation artifact was installed into an isolated instance through the official CLI, checking its tool roster, preset patches, and dependency tree.

Before deploying, note the remaining gaps:

- Real-machine Linux commands and one-shot permission escalation have not been verified. There are no verification conclusions for macOS or remote environments.
- Real OS input methods, screen readers, and touch input have not been verified; accessibility-tree checks do not replace those checks.
- The precise real-host timing in which a constructed tool result is rewritten to a cancellation error before commit remains unverified.
- Item-by-item real-machine re-verification on rc.3/rc.4 is incomplete. Their module suites and static checks do not establish full real-host coverage.
- The four-version remote CI matrix is configured, but remote execution has not happened.

Arrange isolated verification with the maintainer before deploying in a way that depends on these gaps. Results from older rc.2/rc.5 installations do not automatically cover subsequent mechanism changes. Per-item scope is described in `docs/design.md` §9.3 at the matching source commit; see [Documentation and licensing](<#documentation-and-licensing>) for access.

## Install and confirm loading

The package is not distributed through npm. Choose either the terminal or GUI route:

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1
```

For the GUI, open DSH's plugin manager and enter `github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1` as the installation address.

This address follows a moving maintenance branch, so its contents can change between installations. To pin a source:

1. Check out the intended source revision that is actually available from the repository. Run `git rev-parse HEAD` in that checkout and record the full commit ID.
2. Replace the branch name after `#` in the installation address with that full commit. A commit existing only locally is not necessarily available remotely.
3. After installation, inspect the `version` in `package.json` in the directory where the host installed this package for the target profile. It should match the selected source. Keep the actual installation address and full commit as the source record as well: a version number is not a commit identity, and a changelog does not identify what is installed on this machine.

Then confirm loading:

1. Open this package's detail page in the plugin list. Its settings form should be visible.
2. Create a session and check that `dsh-async` and `dsh-async-create` are available in the preset selector.
3. Choose one and confirm that the Agent has the five tools below. A preset is a configuration defining which tools an Agent uses; no manual preset-directory creation is needed.

If source retrieval fails, check the repository address and pinned commit, then the network or proxy. If it still fails, ask the maintainer supplying the source about available artifacts. If installed entries are missing, check the host version first, then follow [installation troubleshooting](<docs/user-reference.en.md#1-installation-identity-and-prerequisites>) to inspect load logs.

## Try a first background task

This example uses PowerShell and factory wait settings in the Windows environment described above.

1. Create a session with `dsh-async` for general coding, or `dsh-async-create` to retain plugin and preset authoring tools.
2. Paste this request to the Agent:

   > Demonstrate harmless background execution without modifying files, accessing the network, or creating children. First use async_run to run `Write-Output SHORT_OK` and confirm the short-command result. Then use async_run to run `Start-Sleep -Seconds 30; Write-Output LONG_DONE`, explicitly setting yield_ms=20000. Keep the returned job_id and do not repeat the command. When waiting is needed, use async_wait targeting that job with wait_ms=30000 explicitly. Report both markers and the actual exit information. If no identifier arrived, check job_list first.

3. The short command should display `SHORT_OK` directly. The 30-second command should first return a `job_id` after its initial wait of at most 20 seconds. Its result, including `LONG_DONE`, then arrives in a wait return or completion message. Check the actual exit information: `completed` alone does not mean exit code zero.

Equivalent **Agent tool-call illustration, not functions to execute in a terminal**:

```text
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=20000)
async_wait(targets=[{kind:"job", id:"<returned job_id>"}], wait_ms=30000)
```

Omitting `yield_ms` uses a factory default of 20000 ms. Its factory request bounds are 20000–600000 ms; out-of-range requests take effect at the nearest boundary. `wait_ms` is required on every call and has no default. Expiry, canceling a wait, or ending a turn does not stop background work. Use `job_kill` explicitly for unwanted jobs.

Results normally contain only text not already read, so save anything that must be retained. Continuing shortened output, recovering an unconfirmed delivery after cancellation, and actual host-buffer loss are different cases; see [result handling and recovery](<docs/user-reference.en.md#4-wait-states-and-direct-delivery>). Do not repeat the original task to check progress.

## Tools and presets

Both shipped presets directly provide all five tools without rewriting existing presets. Inspection, messaging, and stopping remain DSH management operations.

| Tool | Purpose |
| --- | --- |
| `async_run` | Runs a command and returns its result or a background job identifier |
| `async_wait` | Waits for messages, job results, or explicit targets; delivers ready results first and returns immediately if there is no work to wait for |
| `async_agent` | Starts a resumable child in the background and immediately returns `agent_id`; the final answer arrives separately |
| `async_workflow` | Coordinates large multi-agent tasks with a script managed as a background job |
| `async_list_subagent_models` | Browses or searches model pages and checks applicability to a chosen creation tool |

**Custom presets can use all asynchronous features too.** Manually mount the five tools first. `async_workflow` must share a group isolated with `workflowEngine` with a workflow engine, with the required host services available. Then add the custom preset to `boundPresets` if needed. Binding scopes operating instructions and auxiliary features; **it does not install or remove tools**. See the full [custom composition example](<docs/user-reference.en.md#7-advanced-composition>).

Children can usually use the default or inherited model. For explicit selection, follow [model discovery through creation](<docs/user-reference.en.md#5-model-catalogs-authorization-and-inheritance>). Each `async_agent` creation reads the current DSH policy; saved settings affect later creations, not running children. Native creation tools and workflow `agent()` have their own rules.

## Settings, safety, and removal

Open the plugin list → this package's detail page → the form between its description and component rows. Save applies edits, including Restore default actions. Ordinary valid settings saves need no restart.

The applicable-presets list, `boundPresets`, defaults to the two shipped presets; an empty array unbinds all. Listed sessions receive asynchronous operating instructions. Silent-failure warnings additionally require `silentFailureGuard`, and the pending-question panel requires `askTakeover`; both switches are off by default. Binding replaces neither switch and does not change tool mounting. See [all 20 settings and question behavior](<docs/user-reference.en.md#2-first-use-and-settings>).

Commands inherit the session's directory, sandbox, approvals, and permissions. The plugin does not itself collect telemetry, initiate network requests, or read/write credentials. Model catalogs come from DSH interfaces without model inference. Commands can still access the network or sensitive data. Output and host temporary files may contain secrets: redact before sharing and save necessary contents where authorized.

**Change the default preset before disabling or uninstalling.** If it still points to `dsh-async` or `dsh-async-create`, new sessions fail with `agent-preset/not-found` after removal. Select an available preset in host settings; if already removed, clear or reselect the default and confirm with a new session. Inspect active jobs with `job_list` and explicitly stop unwanted work. Removing tools does not automatically cancel jobs started by a session, and restarting can terminate active processes. See [removal, recovery, and reporting](<docs/user-reference.en.md#8-disable-recover-and-report-problems>).

## AI maintainers

AI maintainers include:

- `gpt-6.1-sol`
- `kimi k3`
- `glm-5.3`
- `deepseek-v4.1-flash`

## Documentation and licensing

See the [user reference](<docs/user-reference.en.md>) for operating details. Maintenance documents are in Chinese and are not shipped in the installation package. Read them in the [maintenance branch source](<https://github.com/MC5Spear/dsh-async-tools/tree/adapt/dsh-0.2.1>), using a pinned checkout matching the actual installed source because the branch moves:

```text
CONTRIBUTING.md          Development, review, and release
docs/requirements.md     Product contract
docs/design.md           Mechanisms and verification gaps
verify/README.md         Probe safety and mutation index
CHANGELOG.md             Release history
```

The project uses the [MIT license](<LICENSE>). Both presets and some subagent-policy helpers adapt DeepSeek Harness material. The packaged [third-party notices](<THIRD_PARTY_NOTICES.md>) contain sources, upstream copyright, and the full MIT text.

Documentation maintenance follows the [documentation principles (Chinese)](<docs/documentation-principles.md>).
