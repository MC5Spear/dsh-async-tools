# dsh-async-tools

[中文](<README.md>) · [Complete user reference](<docs/user-reference.en.md>)

[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)

Let an Agent start a long command or child Agent, then continue other work. When it needs the result, it waits for an explicit amount of time. Expiry returns control while the background work continues.

This is a third-party DSH plugin, unaffiliated with DeepSeek. It provides six tools, two presets, and plugin settings. “Host” means the dsh instance loading the plugin. A “preset” supplies a session's tools and rules. Question takeover and silent-command-failure warnings are optional and off by default.

This is a personally maintained project. Issues are accepted, external PRs are not, and response or repair times are not guaranteed. Report security problems through issues after removing sensitive information.

## Before installing

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.6+dsh.0.2.1-rc.3` |
| Exact dsh host version | `0.2.1-rc.3` |

- **Match the host exactly.** An rc3 adaptation does not mean every behavior has been reverified. Mechanism-by-mechanism verification on this host is still pending; results from another version do not establish support here.
- **Use Node.js 24 where possible.** Before choosing another version, check the [runtime prerequisites](<docs/user-reference.en.md#1-installation-identity-and-prerequisites>) for both plugin and host dependencies.
- **The Git account needs read access to the private repository.** An unsigned-in or unauthorized account may see a 404. Check the account used for Git access. Without permission, ask the maintainer who supplied the source about access or available installation artifacts.
- **Platform verification is limited.** This line targets Windows, with target-host revalidation still pending. Linux command execution and one-shot escalation, macOS, and remote execution are unverified. If you need them, send the maintainer your environment and use case, and verify in isolation before using real tasks.

## Install

The package is not distributed through npm. With repository read access, install from this fixed commit:

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#6c428de042a10f6af04a66e28fedab644184e5ad
```

To follow subsequent changes on this line, use the moving branch instead:

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1-rc.3
```

The commit makes the source reproducible; the branch may resolve to different content on a later installation.

In the GUI, open the host's plugin manager and paste the same `github:MC5Spear/dsh-async-tools#…` into the installation-address field. This is a plugin source spec, not a browser URL or npm package name. Installation supplies the settings and both presets; no manual preset directory is needed.

Follow the host's instructions for any required reload, then reopen the page. In the plugin list, open this package's detail page: a settings form should appear between its description and component rows. The new-session preset selector should offer `dsh-async` and `dsh-async-create`. After choosing one, the Agent should have the six tools listed below.

If settings or presets are missing, use [installation troubleshooting](<docs/user-reference.en.md#81-installation-and-settings-unavailable>) to check the version, preset selection, and page state, then ask the operator to inspect load logs.

## Start a background task

Create a session with `dsh-async` for general coding, or `dsh-async-create` to retain plugin and preset authoring tools. Ask the Agent to run a harmless long command and retrieve its result when needed. These are **Agent tool-call examples, not PowerShell functions**:

```text
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=1000)
async_wait_job(job_id="<returned job_id>", wait_ms=30000)
```

The command waits 30 seconds, then prints `LONG_DONE`. With an initial wait of 1000 milliseconds, it will normally return a job identifier, `job_id`, first. The Agent can continue independent work. When it needs the result, it calls `async_wait_job` with that original ID and an explicit `wait_ms` on every call. If the work is still unfinished, wait again later instead of rerunning the command. On completion, check for `LONG_DONE` and the real exit marker: `completed` alone does not imply exit code zero.

Expiry, canceling a wait, or a steering message does not stop background work. Recover a missing ID with the host's `job_list`; request an explicit stop with `job_kill` when work is no longer needed. 

Reads consume incremental output, and the first successful terminal read delivers the final result only once. Save anything you need to retain. See [waits and results](<docs/user-reference.en.md#4-wait-states-and-consuming-output>).

## Tools and presets

| Tool | Purpose |
| --- | --- |
| `async_run` | Starts a command; if it finishes during the first wait, returns its result; otherwise returns a job ID for later retrieval |
| `async_wait_job` | Requires `wait_ms` on every call to set how long to wait, and reads the result when the job finishes |
| `async_agent` | Creates a resumable child only in the background and immediately returns `agent_id` |
| `async_wait_agent` | Waits for a permitted child to stop running; its final answer arrives separately |
| `async_workflow` | Manages one host orchestration-engine script run as a background job |
| `async_list_subagent_models` | Browses or searches models with pagination, exact IDs, effort choices, and applicability to a target creation tool |

Both presets expose all six tools directly without rewriting existing presets. Creation and waiting use this package; inspection, messaging, and explicit stopping remain dsh operations. The [user reference](<docs/user-reference.en.md>) covers every argument, all 17 settings, model discovery, and custom composition.

## Settings and operating limits

Open the plugin list → this package's detail page, then edit the form between the description and component rows. Edits are drafts until you save; restoring defaults also needs Save. Ordinary settings saves require no restart. See [settings](<docs/user-reference.en.md#2-first-use-and-settings>) for the complete procedure.

To handle ordinary questions in a panel, enable question takeover. After expiry the Agent continues, and you can still answer later. See [answering questions](<docs/user-reference.en.md#6-question-takeover-and-silent-failures>) for submission and late-answer instructions.

- Commands retain the session's host permissions, approvals, sandbox, and directory. Commands may access the network or sensitive information; redact commands and results before sharing them.
- To choose a child’s model, first enable model selection in **DSH subagent settings** and save the exact allowed `provider` / `model` routes. Then follow the [query and creation steps](<docs/user-reference.en.md#51-query-first-then-select>). This is separate from the package’s 17 settings. Saves affect later creation in existing sessions, not running children. With selection off, omit model and effort arguments to use defaults or inheritance. Native tools and workflow `agent()` retain their own policies.
- Host buffers can lose output, and rendered text can be truncated separately. Reported spill paths point to system-temporary files, which may contain sensitive data and can be cleaned up. Save needed contents promptly to an authorized location; a path is not a permanent backup.
- The plugin does not itself initiate network requests, collect telemetry, manage credentials, or modify dsh source. Catalog access uses host interfaces and performs no model inference. Child processes receive the key set from `shellEnv.collect(exec)` without plugin additions or removals. Model-visible registration errors are single-line and at most 500 characters; full errors remain in operator logs.

## Before disabling, and recovery after removal

**Change the default preset before removal.** If it still points to `dsh-async` or `dsh-async-create`, disabling or removing the plugin makes new sessions fail with `agent-preset/not-found`. Select an available preset in host settings first. If already removed, clear or reselect the default there, then confirm by creating a new session.

Jobs belong to their initiating session. Removing a tool row does not automatically cancel them, while a restart may terminate active processes. Before maintenance, inspect `job_list` and explicitly stop unwanted work. See [recovery and sanitized reporting](<docs/user-reference.en.md#8-disable-recover-and-report-problems>).

## AI maintainers

AI maintainers include:

- `gpt-6.1-sol`
- `kimi k3`
- `glm-5.3`
- `deepseek-v4.1-flash`

## Documentation and licensing

Use the [user reference](<docs/user-reference.en.md>) for day-to-day operations. Development cloning and linking are described in the source contribution guide listed below. The [corresponding source commit](<https://github.com/MC5Spear/dsh-async-tools/tree/6c428de042a10f6af04a66e28fedab644184e5ad>) also contains maintenance material in Chinese:

```text
CONTRIBUTING.md          Preparation, changes, tests, review, and release
docs/requirements.md     Product contract
docs/design.md           Mechanisms and verification gaps
verify/README.md         Probe safety and mutation index
CHANGELOG.md             Release history
```

The project uses the [MIT license](<LICENSE>). Both presets and some subagent-policy helpers adapt DeepSeek Harness material. The packaged [third-party notices](<THIRD_PARTY_NOTICES.md>) contain attribution, upstream copyright, and the full MIT text.

Documentation maintenance follows the [documentation principles (Chinese)](<docs/documentation-principles.md>).
