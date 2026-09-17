---
name: deskpilot-browser
description: Use with deskpilot-core when an agent operates Chrome pages through DeskPilot; covers CDP-first navigation, semantic waits, GUI fallback, diagnostics, and result verification, not website business flows.
---

# DeskPilot Browser

Use this skill only when the target is a Chrome page. Apply [deskpilot-core](../deskpilot-core/SKILL.md) for the session and lease lifecycle. The product contract and current implementation are authoritative in [PRODUCT_CONTRACT.md](../../../文档/项目/项目_windows-agent-cli/PRODUCT_CONTRACT.md) and [CURRENT_DESIGN.md](../../../文档/项目/项目_windows-agent-cli/CURRENT_DESIGN.md).

## Browser loop

For startup, session ownership, login decisions, or connection failures, first read [references/connection-and-recovery.md](references/connection-and-recovery.md). It contains the executable decision sequence and request shapes; use those before constructing an ad-hoc Chrome launch command.

1. Call `chrome.ensure`. Default `auto` attaches to an existing endpoint or starts a managed profile; it never closes current Chrome windows. Use `managed` to select the dedicated profile, or an explicit `endpoint` with `auto_start=false` to reconnect to an observed endpoint. `current` cannot restart an already running Chrome. Treat `target_id`, `window`, and `window_binding` as the selected browser context, and require `window_binding.verified=true` before GUI fallback.
2. When an existing endpoint has multiple page targets, call `chrome.targets`, choose by URL/title evidence, then call `chrome.attach` with the exact `target_id`. Never infer the page by taking the first result from `windows.find --process chrome`: translation prompts and browser bubbles are also Chrome top-level windows.
3. Navigate with a bounded `timeout_ms`. Treat `domcontentloaded`/`load` as technical readiness, not proof that the page is usable. The default may continue when the page exposes actionable content while `readyState` is still `loading`; use `ready_selector`/`ready_expression` for the actual scenario predicate.
4. Wait for the page's semantic condition with `chrome.wait` using a selector and, when needed, an expression for visibility, enabled state, text, or data. Selector presence alone can match a hidden placeholder.
5. Use `chrome.fill`, `chrome.select`, `chrome.click`, or `chrome.evaluate`, then read back the value or wait for a result condition. Send related known actions, waits and checks in one batch or host-code call. Inspect the result before deciding actions on a new or changed page; do not turn each known field into a separate model turn. Keep the interaction open across the group to avoid focus and overlay churn. Reusing an interaction alone does not batch model calls.
6. If CDP cannot find or verify a DOM control, use the `window.window_id` returned by the latest bound Chrome action to observe and perform UIA/keyboard/coordinate fallback with fresh references. Do not rediscover the window by process order.
7. For browser-history recovery, run `chrome.evaluate` with `history.back()` or `history.forward()`, then issue a separate `chrome.wait` for the expected URL and usable control/result with a non-zero `stable_ms`. The script acknowledgement is not evidence that navigation or delayed login overlays have settled.

## Failure handling

- `CHROME_PAGE_LOAD_TIMEOUT` means the requested technical readiness state was not reached; inspect its stage and page details.
- `CHROME_WAIT_TIMEOUT` means the semantic condition was not satisfied; distinguish an incomplete page from a complete page with no matching data.
- `CHROME_USER_ATTENTION_REQUIRED` means a bounded wait detected a login or verification surface and stopped early; it is not an ordinary selector timeout.
- `CHROME_PAGE_BLOCKED` with `page_state=access_blocked` means the page explicitly reports rate limiting, access denial, or temporary unavailability. Inspect `navigation_trace` and page diagnostics; do not reinterpret a header login link as the blocker or retry a mutating workflow blindly.
- `CHROME_TARGET_NOT_FOUND`, `AMBIGUOUS_CHROME_TARGET`, and `CHROME_WINDOW_NOT_FOUND` are context-binding failures. Re-read targets or windows; do not continue on another tab or browser bubble.
- `CHROME_VALUE_NOT_VERIFIED` and `CHROME_SELECTION_NOT_VERIFIED` require a fresh read or fallback, not an assumption that the event succeeded.
- A `page_state=login_required` or `risk_challenge` result is a user-attention pause: stop later workflow steps, activate the matching Chrome window, and leave it in the foreground for the user. Do not expect the normal original-window restoration until the user has handled the pause and a later request completes.
- Do not parse natural-language messages or blindly retry a mutating batch. Re-observe after a timeout or CDP disconnect.

Website-specific selectors, login rules, payment stops, and business assertions belong to a scenario skill outside DeskPilot.
