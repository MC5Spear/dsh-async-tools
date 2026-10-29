# dsh-async-tools

[中文](<README.md>) · [Complete user reference](<docs/user-reference.en.md>)

[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)

Let a DSH Agent start a long command or child Agent, then continue other work. The task runs in the background. When the result is needed, the Agent waits for a specified time. An expired wait returns control without killing the task. “Host” means the DSH instance loading this plugin.

**This branch is preparing support for DSH `0.2.2-alpha.2`; the alpha targets are not implemented.** The current code and manifest still correspond to rc4 below. These installation instructions are for the rc4 host, not the alpha host. Future version, Node, and dependency targets remain in the source requirements.

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.7+dsh.0.2.1-rc.4` |
| Exact dsh host version | `0.2.1-rc.4` |

This third-party plugin is unaffiliated with DeepSeek. It is personally maintained: [issues](<https://github.com/MC5Spear/dsh-async-tools/issues>) are accepted, external PRs are not, and there is no fixed response or repair schedule. Report security problems through issues too, after removing sensitive information.

## Before installing

- **Match the exact DSH version above.** A mismatch may prevent the entire plugin from loading.
- **Node.js 24 is recommended.** Before using another version, check the [complete runtime prerequisites](<docs/user-reference.en.md#1-installation-identity-and-prerequisites>). Do not treat the plugin declaration as a minimum for the complete DSH host.
- **Your Git account needs read access to the private repository.** This package is not distributed through npm. Without permission, contact the maintainer who supplied the source. The [installation prerequisites](<docs/user-reference.en.md#1-installation-identity-and-prerequisites>) explain access troubleshooting.
- **This line targets Windows; full host revalidation remains pending.** Linux commands and one-shot escalation, macOS, and remote execution are unverified. Send the maintainer your environment and intended use to arrange isolated verification. Partial Windows results do not establish support for other platforms.

## Install

In a terminal configured for the matching DSH, run:

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#ca8f65b39b7694f9e5a2b28cca7a29bc43485ecc
```

Alternatively, open plugin management in DSH Web and paste this into the installation address field of the install dialog:

```text
github:MC5Spear/dsh-async-tools#ca8f65b39b7694f9e5a2b28cca7a29bc43485ecc
```

This pins an rc4 source commit, not an alpha artifact. The maintainer's `#adapt/dsh-0.2.1-rc.4` source follows a moving branch; use the full commit above to reproduce a fixed source.

After installation and any host-requested reload, `dsh-async-tools` should appear in the plugin list. Open its detail page: the settings form should appear between the description and component rows. New sessions should offer `dsh-async` and `dsh-async-create`, without manually creating preset directories. If tools or settings are missing, follow [installation and settings recovery](<docs/user-reference.en.md#8-disable-recover-and-report-problems>) to check the version and loading state.

## Start a background task

Choose `dsh-async` for general coding or `dsh-async-create` for authoring with plugin and preset creation tools retained. A preset is a set of Agent tools and execution rules. These two presets leave DSH's existing presets unchanged.

Ask the Agent to run a harmless long task. This is an **Agent tool-call illustration, not a PowerShell function**:

```text
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print completion marker", yield_ms=1000)
```

The example initially waits one second. If the task has not finished, the tool returns a job identifier, `job_id`, and the Agent can continue independent work. When the result is needed, use that same identifier:

```text
async_wait_job(job_id="<returned job_id>", wait_ms=30000)
```

`wait_ms` is required on every call and has no default. If the task is not yet finished, wait again later; do not start the command again. Canceling a wait also leaves the task running. To stop unwanted work, explicitly use the host's `job_kill`. Recover a missing identifier from `job_list` or the completion notice.

Output is consumed incrementally: successful reads do not replay consumed text, and the final result is delivered once. Save necessary results promptly and inspect the actual exit code; `completed` does not mean exit code zero. See [result handling](<docs/user-reference.en.md#4-wait-states-and-consuming-output>) for truncation, buffer loss, and temporary files.

## Tools and settings

| Tool | Purpose |
| --- | --- |
| `async_run` | Runs commands; short tasks return results, long tasks return job identifiers |
| `async_wait_job` | Waits for a job and reads the result obtained by this call |
| `async_agent` | Starts a resumable child in the background and immediately returns `agent_id` |
| `async_wait_agent` | Waits until a child is no longer running; its final answer arrives separately |
| `async_workflow` | Runs an explicitly requested workflow or large-scale orchestration as a background job |
| `async_list_subagent_models` | Browses and searches models and checks applicability to a chosen creation tool |

Both presets expose all six tools directly. Inspection, messaging, and stopping remain host management operations. See the [user reference](<docs/user-reference.en.md>) for all arguments, 17 settings, and custom preset composition.

Edit settings on the plugin detail page, then click Save to apply them; ordinary settings saves do not require restart. Restoring defaults also requires Save. Question takeover and silent-command-failure protection are off by default; read [questions and protection](<docs/user-reference.en.md#6-question-takeover-and-silent-failures>) before enabling them.

## Change the default preset before removal

**Change the default preset before disabling or uninstalling.** If it still points to `dsh-async` / `dsh-async-create`, new sessions fail with `agent-preset/not-found` after removal. Select an available preset in host settings first. If already removed, clear or reselect the default there, then verify with a new session.

Removal does not automatically cancel jobs owned by their initiating session. Inspect `job_list` and explicitly stop unwanted work first; restarting may terminate active processes. See [disable, recover, and report](<docs/user-reference.en.md#8-disable-recover-and-report-problems>) for complete steps.

Commands retain session permissions, approvals, sandbox, and directory. Commands and results may contain sensitive data; redact them before sharing. See [result handling](<docs/user-reference.en.md#4-wait-states-and-consuming-output>) for buffer and temporary-file risks, and [model catalogs and authorization](<docs/user-reference.en.md#5-model-catalogs-authorization-and-inheritance>) for model selection.

## AI maintainers

AI maintainers involved in this project include:

- `gpt-6.1-sol`
- `kimi k3`
- `glm-5.3`
- `deepseek-v4.1-flash`

## Documentation and licensing

The [user reference](<docs/user-reference.en.md>) contains complete operating instructions. Maintenance material is in Chinese and is not all packaged. Obtain the corresponding checkout from the [fixed rc4 source](<https://github.com/MC5Spear/dsh-async-tools/tree/ca8f65b39b7694f9e5a2b28cca7a29bc43485ecc>) and read:

```text
CONTRIBUTING.md          Development, review, and release
docs/requirements.md     Product contract
docs/design.md           Mechanisms and verification gaps
verify/README.md         Probe safety and mutation index
CHANGELOG.md             Release history
```

The project uses the [MIT license](<LICENSE>). Both presets and some subagent-policy helpers adapt DeepSeek Harness material. The packaged [third-party notices](<THIRD_PARTY_NOTICES.md>) contain the source attribution, upstream copyright, and full MIT text.

Documentation maintenance follows the [documentation principles (Chinese)](<docs/documentation-principles.md>).
