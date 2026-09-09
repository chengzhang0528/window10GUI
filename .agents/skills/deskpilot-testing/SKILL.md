---
name: deskpilot-testing
description: Use for an explicit automated-test task that uses DeskPilot as an external Windows executor; covers process protocol, assertions from observations, failure classification, and evidence, not a built-in test runner.
---

# DeskPilot Testing

Use this skill only when the user asks for automated testing, regression, or test-framework integration. It does not create a SystemTest task by itself; follow the workspace workflow and keep Development-scoped checks within Development.

## Runner contract

Treat `win-agent.exe exec --stdin --format ndjson` as an external process. The runner owns test discovery, fixtures, business assertions, retries, parallelism, reports, and CI exit codes. DeskPilot owns desktop/page execution, waits, structured errors, references, and optional evidence paths.

- Keep one persistent process/session for a related test and group steps with `workflow.run` or `actions.batch`.
- Pair every request and response with `request_id`; parse `ok`, `result`, and `error.code` as data, never natural-language messages.
- Use `wait.*`, `ui.get`, `windows.info`, `chrome.wait`, or `chrome.query` as assertion inputs. Do not infer business success from a sent click or keystroke.
- On `STALE_OBSERVATION`, reacquire state. On `BATCH_OUTCOME_UNKNOWN`, mark the case inconclusive or require controlled recovery; never automatically replay the whole mutating batch.
- Capture screenshots only when the test explicitly requests an absolute path. Keep evidence and test reports owned by the runner.
- Always close or cancel the interaction and process, including failure paths, and record cleanup/restoration errors separately from the test assertion.

Do not add a test DSL, assertion library, runner implementation, scenario selectors, or Feishu integration to the DeskPilot CLI or this skill.
