---
name: deskpilot-flow-evolution
description: Complete DeskPilot Web UI goals through observation and short continuous action batches, adapting to the current page and retaining reusable JSON only when useful. Use when the user names a website and a feature to operate, test or configure, and for scenario reuse, recovery and reducing model round trips; does not change the target application or deploy it.
---

# DeskPilot Flow Evolution

Use [deskpilot-core](../deskpilot-core/SKILL.md) and [deskpilot-browser](../deskpilot-browser/SKILL.md) for actual operations. The [product contract](../../../文档/项目/项目_windows-agent-cli/PRODUCT_CONTRACT.md) owns the goal; [host usage](../../../src/DeskPilot.Flow/README.md) owns invocation and supported fields. This skill owns the method, not website selectors or test expectations.

## Default from a website and a feature

Treat a short request such as “这个网站，验证选项集功能” as an outcome-level instruction. Observe the current page, execute the next known group of actions, verify its outcome, and adapt until the requested result is reached. A complete JSON scenario is not a prerequisite for the first action or for recovery. Do not require the user to supply click sequences, selectors, assertions, a scenario file, or a model name. This applies to Web UI operation and scenario work, not read-only discussion.

- Resolve the site, tenant, feature and desired final state from the request and established context, then observable UI. State consequential assumptions briefly while progressing. Ask only for an outcome or authorization decision that cannot be discovered; missing technical steps are the agent's job.
- Reuse an existing flow only when its outcome, parameters, side effects and prerequisites match the request and current page. A related website or feature name alone is not a match. Otherwise start with a small orientation check and operate directly; do not adapt the user's goal to a stored regression case.
- For testing, use isolated synthetic records within the authorized scope and clean up only owned data. For a requested lasting configuration, verify persistence and retain the desired configuration instead of deleting it as test cleanup. A new URL does not carry XRain's demo-login permission or authorize unrelated records, messaging, purchases, publishing or target application deployment.
- Default actual website discovery, replay and recovery to a Luna subagent using DeskPilot, preserving this user's established execution preference unless overridden. Give one agent exclusive desktop ownership. If the requested model or executor is unavailable, report that concrete limitation; do not silently claim equivalent verification.
- Finish with the verified business outcome and final data state. Include a replay entry only if a reusable flow was actually retained; include negative-case coverage when it belongs to the requested testing goal. A completed one-off operation does not require an artifact. This skill is an Agent execution policy, not a background scheduler or an autonomous model inside the CLI.

## Choose and execute

1. Delegate the browser run to a Luna subagent under the default above. Give it the business goal, allowed changes and expected final state; pass a scenario path only when one actually matches. Give exactly one agent the desktop at a time.
2. Connect through DeskPilot and observe enough of the current page to identify the next action group. Reuse the session and known page identity. Read relevant controls/results, not the full page and history on every turn.
3. Send related, already-determined actions and their checks in one `workflow.run`/`actions.batch`, or one host-code tool call over a persistent NDJSON connection. Put waits and result reads inside that call. Merely holding `interaction.begin` across separate model turns does not reduce model round trips. Use only DeskPilot's public operations; transient host orchestration need not become a persisted scene script.
4. End a group when new observation could change the next action: opening an unknown form, receiving search results, completing a save, or encountering an unexpected state. Do not prewrite actions for unseen controls. Within a known form, fill related fields and verify their values together; verify identity and important inputs before saving, then the business result afterwards. Use bounded semantic waits instead of fixed sleeps or extra model polling.
5. Inspect the compact result, choose the next group and continue within the authorized goal. Routine discovery and recoverable UI changes are Agent work, not a reason to ask the user to approve each step. Ask only for missing outcome/authorization decisions or required human authentication.
6. When a stored flow truly matches, run its normal case in one host call. It returns completed, handoff, or cancelled; intermediate events need no model interpretation. An ok CLI response or a click acknowledgement is not business success.

## Build a business loop

For a feature with writable objects in the authorized test scope, discover a real object lifecycle by default: create isolated test data, configure or fill it, save, leave and reopen to read it, modify and re-read, then clean up and verify the final state. Choose steps that advance the operation; step count alone is not evidence of complexity or completion.

- Confirm both the write surface and cleanup path before creating test data. Use a dedicated marker, prove initial absence, and recheck the same object identity before updating or deleting. Never treat existing matching data as disposable without establishing ownership.
- Verify each persisted result after a fresh page load or reopen. An optimistic in-page update or toast is insufficient. When retaining JSON, express these results in predicates and release conditions invalidated by an intentional transition.
- If an interrupted loop leaves owned data behind, retain only the identity and minimal recovery state. Inspect the actual result and execute only the remaining safe actions with fresh prerequisites; neither a new recovery JSON nor restarting a create sequence is the default requirement.

## On handoff

- Read fault.code, detected_at, phase, producer_step_id, current/previous step effects, affected, and quiescent. A producer identifies an invalidated result, not a proven root cause.
- If quiescent=false, resolve the old executor before any further GUI write. Unknown effects require a fresh read before replay; do not treat retryable as permission to repeat a write.
- Use DeskPilot to inspect the smallest relevant state. Separate application defects, changed selectors, delayed readiness, authentication and check implementation errors. Check exceptions mean unknown, never pass.
- An explicitly authorized demo login shortcut may be handled through DeskPilot before replay; it is not a password/verification bypass. Without that authorization, or for an actual password/OTP/challenge, retain the user-attention boundary.
- A search check must read the result region it actually controls, not an unrelated nonempty sidebar. Check unique actionable input, page identity and result state; return booleans/counts rather than complete record content. Record empty-data coverage honestly instead of claiming all filtering behavior.
- Correct only the evidence-backed cause. A changed selector or missing wait can justify a revised action group; update a retained flow only when the correction has reusable value. A failing business result remains a failure unless requirements changed. Never remove an assertion merely to obtain green output.
- The current Flow host supports a fresh run after an Agent decision, not arbitrary jump-to-step or persistent checkpoint resume. After confirmed executor exit, the Agent may continue through direct DeskPilot batches based on fresh observations. This is recovery from actual state, not resuming an old step counter. Re-run a stored case only when every replayed action is known safe.
- For deliberate failure probes, label the injected condition explicitly. Prefer local in-memory wrong expectations or unsubmitted UI changes; never inject faults into shared application code, server state, or other users' records.

## Retain and verify

Retain a flow when the user requests reuse or when a verified repeated operation benefits from it. Save parameters, stable targets and business predicates, not the entire exploration trace. Avoid hardcoded run-specific names inside selectors and unrelated page baselines. If the current data vocabulary cannot parameterize a required target, disclose that limitation and keep direct execution available; do not claim the flow is parameter-only reusable.

Persisted Flow documents remain pure JSON: no scene .mjs, handler, expression or script hook. Checks must be visible in the data. Each retained step needs expect; consumes rechecks a necessary earlier fact and releases removes facts invalidated by intended transitions. Keep checks proportional to the business dependency rather than preserving every exploratory keystroke. Validate data before desktop actions; malformed fields must produce FLOW_INVALID with zero actions. Verify the corrected case and relevant negative case, plus a second normal run when claiming reuse.

Assess the whole user task: time to first useful action, actual model/tool round trips, business outcome, recovery effort and user interruptions. Report measured counts when available; intermediate_model_calls=0 only describes the deterministic host, not discovery/debugging cost. Do not invent time or Token savings. Successful regression replay alone does not demonstrate the first-use experience.

Generic execution bugs belong to the current DeskPilot project. Website-specific selectors stay in the scenario; target product defects are reported to the user, not repaired or redeployed without separate authorization. Update the actual design owner when the supported behavior changes; don't copy a transcript into this skill.
