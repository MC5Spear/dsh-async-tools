# dsh-async-tools

[中文](<README.md>) · English

[![CI](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-async-tools/actions/workflows/ci.yml)

> A third-party DSH plugin, unaffiliated with DeepSeek. Personally maintained: issues are welcome, external PRs are not accepted, and no response or repair timeline is promised. Report security issues through issues too, after redacting sensitive details.

Let long commands and subagents keep working while the Agent handles something else. When it needs a result, it can wait for a specified amount of time instead of holding up the entire task.

This plugin runs inside DeepSeek Harness (DSH), the application that runs your Agents. It provides six tools and two presets—ready-to-select sets of tools and instructions. A settings form is included. Question takeover and command silent-failure hints are optional and default off.

## Version and installation

| Component | Current applicable version |
| --- | --- |
| Plugin version | `0.2.5+dsh.0.2.1-rc.2` |
| Exact dsh host version | `0.2.1-rc.2` |

Node 24 is recommended. Before using another version, check the [environment requirements](<docs/user-reference.en.md#1-version-installation-and-first-checks>).

Some Windows checks have been completed in isolated environments. Linux command execution and requests for broader permissions, macOS, and remote environments have not completed verification. If you need them, describe your platform and required features in an issue and ask about support progress.

The package is not distributed through npm. Its source repository is private, so first check that the account used by Git has read access. If it does not, ask the maintainer who supplied the source about access or an available installation artifact.

The command below pins this line's commit, so its installation source does not move with a branch.

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-async-tools#97b7b27e8e66f225003dd80f85f7229b2372a3be
```

Alternatively, paste this installation address into DSH's plugin installation dialog. It is the part after `add` in the command above; keep the commit suffix:

```text
github:MC5Spear/dsh-async-tools#97b7b27e8e66f225003dd80f85f7229b2372a3be
```

After installation, check these locations:

1. Open `dsh-async-tools` in the plugin list. Check the full version against the table and confirm that its settings form appears.
2. Start a new session and select `dsh-async` in the preset selector, or `dsh-async-create` if you need creation tools.
3. Check the session's tool list against [Tools and presets](<#tools-and-presets>) below and confirm that all six tools are present before starting work.

If tools, presets, or settings are missing, follow the [recovery steps](<docs/user-reference.en.md#8-risks-disabling-and-recovery>). The reference also covers source-directory installation and safe reloading. Ordinary settings saves do not require a restart.

## First use and settings

Tell the Agent what you want to accomplish in the new session. To try a background command, ask it to run a harmless task that waits 30 seconds and then prints a marker. The following illustrates **Agent tool calls, not commands to enter in PowerShell**. A short task returns its result directly; a longer one may first return a job identifier, `job_id`.

```text
async_run(command="Write-Output SHORT_OK", description="Print a harmless test marker")
async_run(command="Start-Sleep -Seconds 30; Write-Output LONG_DONE",
          description="Wait then print a harmless marker", yield_ms=1000)
→ After receiving job_id, continue other work; when needed:
async_wait_job(job_id="<returned-job_id>", wait_ms=30000)
```

After receiving `job_id`, the Agent can do other work and call `async_wait_job` when it needs the result. If the example finishes normally, its result should contain `LONG_DONE`. Check the exit markers too: `completed` alone does not mean exit code 0.

Every wait call requires `wait_ms`, the maximum time to wait in milliseconds. Expiry, a steering message, or cancelling the wait does not stop background work.

If the job identifier did not arrive, recover it from DSH's `job_list` or completion notices, then read the original job. Do not restart commands that may change files, send requests, or have other side effects.

Each successful read consumes previously unread output, and the final result is delivered only once. Save needed content securely. The complete [result and status guide](<docs/user-reference.en.md#4-status-consuming-results-and-stopping>) also explains how subagent answers arrive.

To change wait lengths or other options, open this package in the plugin list. Its settings form appears between the description and component rows. Edits take effect only after Save; Reset also needs Save, and leaving discards drafts. Saving requires a writable local management endpoint on a loopback address. The [complete reference](<docs/user-reference.en.md#2-settings-saving-and-reset>) covers all 17 settings and failed saves.

To choose a subagent's model, enable model selection and save allowed routes in DSH subagent settings, then ask the Agent to look up exact IDs. Saved changes affect subsequent creation, not running children. See [model selection](<docs/user-reference.en.md#5-model-selection-and-query-authorization>) for the complete procedure.

To let the Agent continue when nobody answers, enable optional question takeover, which defaults off. Ordinary questions appear in the panel; the Agent continues at expiry and you can still answer later. Approval and plan review retain native handling. Answer records are held only in memory and cannot be recovered after restart or uninstall. See [questions](<docs/user-reference.en.md#6-question-takeover-and-silent-failures>) for selection, extensions, late-record cleanup, and delivery failures.

## Tools and presets

Use this table once you are ready to work. The [tool reference](<docs/user-reference.en.md#3-tool-parameters>) covers parameters, return states, and failures.

| Tool | Purpose |
| --- | --- |
| `async_run` | Runs a command. Short commands return results directly; longer commands first return a job identifier, `job_id`. Ending the wait does not kill the process. |
| `async_wait_job` | Waits for a job and reads its results using its identifier. You must provide `wait_ms`, the maximum time to wait in milliseconds. |
| `async_agent` | Creates a subagent that works in the background and immediately returns its identifier, `agent_id`. |
| `async_wait_agent` | Waits for a subagent to stop running within a specified time. A wait may also end because time ran out; the final answer arrives separately as a message. |
| `async_workflow` | Uses a script to organize background work when the user explicitly requests a workflow or many subagents need coordination. |
| `async_list_subagent_models` | Browses or searches models in pages and explains whether the selected creation tool permits using them. |

Use `dsh-async` for general coding or `dsh-async-create` to retain creation tools. Both contain all six tools. Inspect tasks, send messages, and explicitly stop work using DSH's management tools. The plugin leaves existing presets unchanged.

## Risks and disabling

Commands retain host permissions, sandbox, approval, and environment. Results and temporary spill files may contain sensitive data: redact before sharing and promptly save needed results safely. For empty output inspect execution evidence and exit markers rather than assuming no execution. Use host job/subagent stop tools to stop work explicitly.

**Disabling or uninstalling while `dsh-async` / `dsh-async-create` is the default can cause `agent-preset/not-found` in new sessions.** The host does not clear that choice automatically.

1. Before uninstalling, change the default to an available preset in host settings.
2. Collect needed results and explicitly stop unneeded work you own; removing the plugin does not automatically stop those jobs.
3. Follow the [disabling and recovery procedure](<docs/user-reference.en.md#8-risks-disabling-and-recovery>) to remove the plugin. If a restart is needed, check other active sessions first: restarting can terminate processes.

If the plugin is already removed and new sessions fail, go directly to **host default-preset settings** and clear or reselect an available preset. You do not need the removed plugin page.

## Documentation

| Task | Entry |
| --- | --- |
| Parameters, configuration, statuses, models, composition, recovery | [English reference](<docs/user-reference.en.md>) / [中文参考](<docs/user-reference.md>) |
| Current documentation maintenance rules | Packaged [documentation principles (Chinese)](<docs/documentation-principles.md>) |

Maintenance documents in the source checkout (Chinese) use the paths below. Obtain the matching-version checkout from the [source repository](<https://github.com/MC5Spear/dsh-async-tools>); these are source paths, not links inside the installed package. Repository read access is required.

```text
CONTRIBUTING.md          Development, review, and release
docs/requirements.md    Product targets and acceptance contract
docs/design.md          Current mechanisms and verification gaps
verify/README.md        Probe execution and safety
CHANGELOG.md            Release history
```

## AI maintainers

AI maintainers participating in this project include:

- `gpt-6.1-sol`
- `kimi k3`
- `glm-5.3`
- `deepseek-v4.1-flash`

## License

MIT licensed; see [LICENSE](<LICENSE>). Both presets and parts of the subagent policy helpers are adapted from DeepSeek Harness. Their source, upstream copyright, and full MIT license appear in [third-party notices](<THIRD_PARTY_NOTICES.md>), distributed with the package.

Documentation maintenance follows the [documentation principles (Chinese)](<docs/documentation-principles.md>).
