# dsh-async-tools

[中文](<README.md>) | English

Run long commands and child-agent tasks in the background in DSH. The agent can do other work and read the result when needed. A wait expiring or a user interrupting the wait does not stop the background task.

This is a third-party plugin, not affiliated with DeepSeek. It is personally maintained and does not accept external pull requests. Submit problems and security reports through [issues](https://github.com/MC5Spear/dsh-async-tools/issues), with sensitive details removed. The maintainer schedules responses and repairs; there is no fixed timetable.

## Before installing

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.3+dsh.0.2.0-rc.2` |
| Exact dsh host version | `0.2.0-rc.2` |

The host is the DSH installation that runs the plugin. For another DSH version, choose a plugin that explicitly targets it. The default branch does not establish compatibility.

- **Node.js:** version 24 is recommended. Before choosing another version, check the [dependency lower bounds and host environment requirements](<docs/user-reference.en.md#1-version-installation-and-loading>).
- **Repository access:** the source repository is currently private. The account used for Git needs read permission. A 404 may mean that you are not signed in or lack permission. Check the Git account, then ask the maintainer who supplied the installation source about access or available artifacts.
- **Platforms:** Linux commands and escalation, macOS, and remote execution lack complete validation. Ask about validation and known limitations through an issue before using those environments for important work.

## Install and start

Run this in the environment of your intended DSH installation:

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#ce9852e03340c001f520ddfd13d62410c8983196
```

The command fixes the source to the complete commit above, not a newly published tag. The package is not distributed through npm.

**To install through the GUI instead**, open the Web address shown when your intended DSH instance starts. In plugin management's installation dialog, enter:

```text
github:MC5Spear/dsh-async-tools#ce9852e03340c001f520ddfd13d62410c8983196
```

This is the installation source. The plugin-management page belongs to your DSH instance, not the GitHub repository. Choose either the CLI or GUI method.

After installation:

1. Open this package in the plugin list. Check the complete plugin version and confirm that its settings form is visible.
2. Choose `dsh-async` in the new-session preset list. A preset is a set of tools and execution rules; this one is for general coding. Choose `dsh-async-create` when you need creation tools.
3. Create a session and ask the agent to perform the harmless example below. Its tool responses should show output or a `job_id`, the background job identifier.

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print a marker", yield_ms=1000)
async_wait_job(job_id="<returned id>", wait_ms=30000)
```

These are **agent tool-call examples**, not PowerShell functions to paste into a terminal. Only the `command` contents are PowerShell. The short task should show `SHORT_OK`. The long task normally returns a `job_id` first; reading it later shows `LONG_DONE`. If the read still returns `running`, keep the same ID and read again when you need the result.

For missing tools, presets, or settings, follow the [loading checks](<docs/user-reference.en.md#1-version-installation-and-loading>). Ordinary settings saves need no restart. Do not reload an instance in use by others just to troubleshoot.

## Read background results

A returned `job_id` is not a failure. Continue independent work, then call `async_wait_job` when you need the result. Both wait tools require an explicit `wait_ms`: the budget for this call in milliseconds, not the task's lifetime.

Expiry, a user interruption, or call cancellation ends waiting only. Recover a missing ID from `job_list` or a completion notice rather than blindly repeating a side-effecting command. To stop work, use the host's `job_kill` or `interrupt_agent`, then verify cleanup state.

Job reads deliver new output as it is consumed. The first successful terminal read also delivers the one-time final result; later reads do not repeat it. Save important content when received. `completed` does not imply exit code zero. A child's `settled` means it is no longer observed running, not that it succeeded or that its final answer has arrived.

## Tools and presets

| Tool | Purpose |
| --- | --- |
| `async_run` | Start a command; return its result during the first wait or a background job ID |
| `async_wait_job` | Wait within an explicit budget and deliver the current read in that response |
| `async_agent` | Create a background child that can continue a conversation; immediately return agent_id |
| `async_wait_agent` | Wait for a child to stop running; final answers arrive separately |
| `async_workflow` | Manage a host multi-agent orchestration script as a background job |

Both built-in presets provide all five tools and retain host inspection, messaging, and stop tools. Existing presets are unchanged. For custom presets, see the [complete composition](<docs/user-reference.en.md#8-complete-tool-composition-for-a-custom-preset>).

## Settings and questions

Open the plugin list → this package's details page. Edits and Restore defaults are drafts until Save. Leaving discards unsaved drafts; failed saves retain them. If read-only or non-loopback access prevents writes, use an authorized local host-management entry.

The [complete user reference](<docs/user-reference.en.md>) lists all arguments, all 17 flat volatile settings (configuration fields updated after saving without a restart), defaults, ranges, and recovery steps. This release samples model policy at session creation. Global edits do not change existing sessions. `async_agent` accepts only `description`, `prompt`, `provider`, and `model`. Supply the last two together, or omit both to inherit the parent route.

### Want to answer questions in the panel?

Question takeover defaults to off. Enable it in settings when needed; it handles questions only in this package's two presets. Silent-failure hints have a separate switch, also off by default, with the same preset scope.

### What if you miss the deadline?

When questions expire, the system truthfully reports unanswered questions so the agent can continue. You can still answer in the panel while records remain. See [questions](<docs/user-reference.en.md#7-question-takeover-and-silent-failures>) for extensions and detailed answering steps.

### How do you confirm a late answer arrived?

A tool wait ending does not confirm late-answer delivery. If you see a failure or receive no confirmation, check the original session. If the answer is absent, state the question and intended answer directly there.

### How long do answer records remain?

Expired records older than 24 hours are removed only when the next new question batch is captured. Without a new batch, they may remain longer. Save answers you need to keep; the panel is not long-term storage. After restarting or unloading, send any additional answer directly to the original session.

## Safety and removal

Commands use host session permissions, approvals, directories, and environment. They can access networks and sensitive data. Run authorized actions only and redact shared logs. Results may be truncated or written to host temporary files; retrieve returned paths promptly and save the content appropriately. The plugin itself collects no telemetry, makes no package-originated network requests, reads or writes no credentials, and modifies no host source.

**Before disabling or removing the plugin, change the host default preset from dsh-async / dsh-async-create to an available preset.** Otherwise new sessions may fail with `agent-preset/not-found`; the host does not clear that selection automatically. If already removed, clear or reselect the default in host settings, then create a new session. Recovery does not require the plugin page.

Unloading a producer row does not cancel its owner jobs, while a restart may terminate active commands. Handle your active work first, then disable or remove the package through host plugin management and check both dependency and bundle declarations. See [removal and recovery](<docs/user-reference.en.md#9-safety-removal-and-recovery>) for full steps.

## Documentation and project information

- Use: [complete English reference](<docs/user-reference.en.md>).
- Maintenance documents (Chinese): in a corresponding-version checkout from the [source repository](https://github.com/MC5Spear/dsh-async-tools), read the following for development, the product contract, implementation, probe safety, and release history. These are not prerequisites for English usage.

```text
CONTRIBUTING.md
docs/requirements.md
docs/design.md
verify/README.md
CHANGELOG.md
```

- License: [MIT](<LICENSE>). Host packages provide their own licensing and attribution.
- Reports: [GitHub issues](https://github.com/MC5Spear/dsh-async-tools/issues); remove sensitive details first.

## AI maintainers

AI maintainers who contribute to this project include:

- `gpt-6.1-sol`
- `glm-5.3`

Documentation maintenance follows the [documentation principles (Chinese)](<docs/documentation-principles.md>).
