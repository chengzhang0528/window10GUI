---
name: deskpilot-core
description: Use when an agent needs to operate a Windows 10 interactive desktop through DeskPilot's public CLI; covers session, lease, observation, actions, verification, errors, and cleanup, not business workflows or test frameworks.
---

# DeskPilot Core

Use this skill for any DeskPilot desktop operation. Product boundaries and the current command catalog remain authoritative in [PRODUCT_CONTRACT.md](../../../文档/项目/项目_windows-agent-cli/PRODUCT_CONTRACT.md) and [CURRENT_DESIGN.md](../../../文档/项目/项目_windows-agent-cli/CURRENT_DESIGN.md); do not copy or redefine them here.

## Operating method

1. Start the public process with `win-agent.exe exec --stdin --format ndjson` and send one JSON request per line. Run `doctor` first when the environment is unknown.
2. Send multiple related, known actions and their result checks in one `workflow.run`/`actions.batch` or one host-code call over persistent NDJSON. Keep waits inside that call and return to the model when new observation is needed to choose the next action. A full persisted scenario is not required. Hold `interaction.begin` until `interaction.end`/`interaction.cancel` when a group spans requests; this reuses the overlay and foreground lifecycle but does not by itself reduce model round trips. If the user wants to watch the run, pass `show_action_trace=true`; DeskPilot draws a synthetic pointer/target highlight without moving the real cursor. Coordinate fallback may briefly use the OS cursor to deliver input, then restores its prior position best-effort.
3. Resolve a target with `windows.find` or `observe`, then use the returned session-scoped IDs. Never pass HWND, COM, or UIA objects to the host.
4. Prefer UIA patterns, then UIA-backed input, Win32, and finally coordinate input with a fresh observation/screenshot reference. After every mutating action, read or wait for the expected state; an input event is not proof of business success.
5. Keep the workflow within its total timeout. On `STALE_OBSERVATION`, reacquire the window and observe again. On `BATCH_OUTCOME_UNKNOWN`, stop and re-observe; never blindly retry the whole batch.
6. End or cancel the interaction so the overlay is hidden. `interaction.cancel` may be sent concurrently on the same `exec --stdin` stream; it returns `cancellation_requested`, then the active action stops at its next action/wait boundary and the batch returns `status=cancelled`. Already-sent input is not undone. Normally the original foreground window is restored best-effort; if a Chrome result reports `page_state=login_required` or `risk_challenge`, keep the matched Chrome user-attention window in the foreground instead and report `foreground_preserved`, `preserved_window`, or `preservation_error`.

## Scope boundary

This skill teaches the generic execution loop. Load `deskpilot-browser` for Chrome-specific behavior and a separate scenario skill for business selectors and assertions. Do not add Feishu, website, payment, or test-runner rules to this skill.
