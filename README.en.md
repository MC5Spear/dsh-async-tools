# dsh-async-tools

[中文](<README.md>) · [Complete user reference](<docs/user-reference.en.md>)

[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)

Let a DSH Agent start a long command or a child Agent, then continue other work. Wait when the result is needed; when a wait expires, the background task keeps running. “Host” means the DSH instance loading this plugin.

This third-party plugin is unaffiliated with DeepSeek. It is personally maintained: issues are accepted, external PRs are not, and there is no fixed response or repair schedule. Report security problems through issues after removing sensitive information.

## Before installing

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.7+dsh.0.2.1-rc.4` |
| Exact dsh host version | `0.2.1-rc.4` |

- **Use the exact DSH version above.** The rc4 adaptation does not mean every behavior has been verified on this line. Full target-host revalidation remains pending.
- **Node.js 24 is recommended.** For other versions, check the [runtime prerequisites](<docs/user-reference.en.md#1-installation-identity-and-prerequisites>). The plugin's declaration is not the minimum for the complete host.
- **Installation source.** If the installation address does not yield the source, check the repository address and pinned commit, then the network or proxy. If it still fails, ask the maintainer who supplied the source about available installation artifacts.
- **This line targets Windows, with full revalidation still pending.** Linux command execution and one-shot escalation, macOS, and remote execution are unverified. For these environments, send the maintainer your environment and intended use, then arrange isolated verification before deciding to deploy.

## Install

The package is not distributed through npm. Run in a terminal:

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1-rc.4
```

Alternatively, open DSH's plugin manager and enter `github:MC5Spear/dsh-async-tools#adapt/dsh-0.2.1-rc.4` as the installation address in its install dialog.

This address follows a moving branch. To pin the source, replace everything after `#` with full commit `ca8f65b39b7694f9e5a2b28cca7a29bc43485ecc`.

After installation, open this package's detail page in the plugin list: its settings form should be visible. In a new session's preset selector, check that `dsh-async` and `dsh-async-create` are available. After selecting one, the Agent should have the six tools listed below. A preset defines which tools an Agent uses; you do not need to create preset directories manually.

If settings, presets, or tools are missing, check the exact host version first, then follow the [installation troubleshooting steps](<docs/user-reference.en.md#1-installation-identity-and-prerequisites>) to inspect load logs. The reference also covers development links and reloading after installation-composition changes.

## Start a background task

Create a session with `dsh-async` for general coding, or `dsh-async-create` to retain plugin and preset authoring tools. Ask the Agent to run a harmless waiting command. The following illustrates **Agent tool calls, not PowerShell functions**:

```text
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=1000)
async_wait_job(job_id="<returned job_id>", wait_ms=30000)
```

If the command finishes during the first wait, its result returns directly. Otherwise, you receive a job identifier, `job_id`. Keep it, continue independent work, then read the result with `async_wait_job`. Every call requires `wait_ms`; it has no default. Look for `LONG_DONE` and the actual exit information. `completed` does not imply exit code zero.

Expiry, canceling a wait, or stopping the current turn does not stop background work. Stop unwanted jobs explicitly with `job_kill`. If the identifier did not reach the Agent, recover it with `job_list` rather than repeating the command.

Reads return only text not already read; the task's final result is also delivered once. Save results you need to keep. See [result handling](<docs/user-reference.en.md#4-wait-states-and-consuming-output>) for truncation, loss, and temporary files.

## Tools and presets

Both presets directly provide these six tools. DSH management tools still handle inspection, messages, and stopping. Existing presets are unchanged.

| Tool | Purpose |
| --- | --- |
| `async_run` | Runs a command and returns its result or a background job identifier |
| `async_wait_job` | Waits and reads a job within the supplied `wait_ms` budget |
| `async_agent` | Starts a resumable child in the background and immediately returns `agent_id` |
| `async_wait_agent` | Waits for a permitted child to stop running; the final answer arrives separately |
| `async_workflow` | Coordinates large multi-agent tasks with a script managed as a background job |
| `async_list_subagent_models` | Browses or searches model pages and checks applicability to a chosen creation tool |

Each later `async_agent` call with an explicit model or effort choice reads the current DSH switch and allowed set. Saved changes apply even in existing sessions; running children keep their model. Fully omitted choices use configured defaults or inheritance. Native creation tools and workflow `agent()` have their own rules, so specify the target when querying models. The [complete reference](<docs/user-reference.en.md>) covers every argument, all 17 settings, and advanced composition.

## Settings, safety, and removal

Open the plugin list → this package's detail page → the form between its description and component rows. Save applies edits; restoring defaults also requires Save. Ordinary settings saves need no restart. Question takeover and silent-command-failure warnings are off by default. [Settings and questions](<docs/user-reference.en.md#2-first-use-and-settings>) explains values, answers after timeout, and record cleanup.

Commands inherit the session's directory, sandbox, approvals, and permissions. The plugin does not itself collect telemetry, initiate network requests, or read/write credentials. Model catalogs come from DSH interfaces without model inference. Commands can still access the network or sensitive data. Output and host-provided temporary files may contain secrets: redact before sharing and save necessary contents where authorized. See the [safety and reporting reference](<docs/user-reference.en.md#8-disable-recover-and-report-problems>) for environment and error-log details.

**Change the default preset before disabling or uninstalling.** If it still points to `dsh-async` or `dsh-async-create`, new sessions fail with `agent-preset/not-found` after removal. Select an available preset in host settings first. If already removed, clear or reselect the default there, then create a session to confirm recovery. Inspect your active jobs with `job_list` and explicitly stop unwanted work. Removing tool rows does not automatically cancel jobs owned by their initiating session, and restarting can terminate active processes. See [recovery and reporting](<docs/user-reference.en.md#8-disable-recover-and-report-problems>).

## AI maintainers

AI maintainers include:

- `gpt-6.1-sol`
- `kimi k3`
- `glm-5.3`
- `deepseek-v4.1-flash`

## Documentation and licensing

See the [user reference](<docs/user-reference.en.md>) for operating details. Maintenance documents are in Chinese in the [rc4 source branch](<https://github.com/MC5Spear/dsh-async-tools/tree/adapt/dsh-0.2.1-rc.4>). The branch moves; use a checkout corresponding to your installed source:

```text
CONTRIBUTING.md          Development, review, and release
docs/requirements.md     Product contract
docs/design.md           Mechanisms and verification gaps
verify/README.md         Probe safety and mutation index
CHANGELOG.md             Release history
```

The project uses the [MIT license](<LICENSE>). Both presets and some subagent-policy helpers adapt DeepSeek Harness material. The packaged [third-party notices](<THIRD_PARTY_NOTICES.md>) contain sources, upstream copyright, and the full MIT text.

Documentation maintenance follows the [documentation principles (Chinese)](<docs/documentation-principles.md>).
