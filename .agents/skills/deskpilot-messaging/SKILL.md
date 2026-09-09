---
name: deskpilot-messaging
description: Use with deskpilot-core when an agent collects or replies to messages in Windows desktop chat or support applications through DeskPilot; covers conversation identity, OCR regions, bounded scrolling, candidate deduplication, reply verification, and cleanup, not application-specific workflows or persistent archiving.
---

# DeskPilot Messaging

Use this skill for generic desktop message collection and reply. Load `deskpilot-core` for the public CLI lifecycle; this skill only adds the message-specific orchestration that prevents conversation drift and unnecessary focus churn.

For incremental collection, draft approval, reply idempotency, send verification, or user takeover, read [references/message-state-contract.md](references/message-state-contract.md) before acting. These are upper-Agent orchestration rules and do not extend the DeskPilot CLI with application or business semantics.

## Operating pattern

1. Resolve the actual conversation window once. A process may own a main window plus one or more detached chat/tool windows, so enumerate candidates and choose the exact window whose identity region visibly contains the requested conversation; do not assume the process's main window is the message surface. Prefer `--title-exact` once resolved. Calibrate window-relative `identity_region` around the stable conversation title and `content_region` around visible history; exclude the conversation list, composer, toolbar, and unrelated panes from the content region.
2. Keep one `win-agent.exe exec --stdin --format ndjson` process and one explicit `interaction.begin` lease for the whole collection or reply. Do not launch one CLI process per page or repeatedly release and reacquire the desktop.
3. The first page must call `messages.observe` with `expected_identity` and visibly prove the requested conversation. Treat `message_candidates` as positioned OCR candidates, not already grouped business messages or confirmed senders. A visible title can suffer transient OCR loss, so retry the same read a small bounded number of times without clicking before declaring drift.
4. If the first identity assertion fails, stop collection. Observe the full window without an expected identity, find one distinctive caller-supplied locator text, click its fresh OCR bounds, and assert the full identity again. Never interpret `CONTEXT_IDENTITY_MISMATCH` as an empty conversation.
5. For history, scroll a stable blank gutter inside the content region with the preceding screenshot ID, avoiding embedded cards and nested scroll areas; wait only a short UI-settle interval, and observe again. Some applications scroll the conversation header out with the history. In that case, accept a later page only when the same session window remains bound, the screenshot is trusted, and at least two contiguous fuzzy messages anchor it to the preceding page; report `identity_evidence=sequence_continuity` instead of pretending the title matched. Once this layout is proven, skip repeated title OCR and keep checking sequence continuity. Stop on an unanchored page, after two pages add no new sequence-anchored messages, when an explicit caller-supplied history marker is visible, or at the caller's page limit. Restore the approximate original scroll position on success and failure when minimizing user disruption matters; report restoration success only when the visible identity and an ordered sequence from the initial page are both recovered. No-progress is bounded exhaustion evidence, not proof that all history was collected.
6. Group nearby, aligned OCR lines into auditable message records before cross-page deduplication. Infer a sender only when a short header is geometrically supported by a following body; otherwise return `sender: null`. Never invent a timestamp absent from OCR. Dense clusters of materially smaller text inside one image/card must remain one low-confidence `embedded_media_ocr` record and must not be counted as plain speech. A voice bubble is not an empty OCR line: preserve it as `content_kind=voice` with visible duration/bounds and `transcript.status=unavailable` until a separate audio/ASR adapter proves a transcript. Merge page overlap only when an ordered boundary sequence has at least two fuzzy-matching anchors and at least half of its positions match; this tolerates bounded OCR drift while legitimate repeated single messages remain distinct.
7. Choose a reply strategy before drafting. In group chats use `specific_message`: bind the draft to one exact source message and require caller-owned `reply_anchor_evidence` proving that message's reply mode. In private chats use `conversation_turn`: bind all contiguous messages that form one question or thought, wait for a bounded turn-close/debounce signal, and send one combined answer through a verified conversation composer; do not emit one reply per OCR bubble. If the relevant anchor cannot be proven, stop with `SPECIFIC_REPLY_UNPROVEN`; never silently append to another conversation or infer a recipient from a sender. After the anchor gate, use a fresh screenshot in one batch: focus the composer, enter the caller-authorized text, invoke the send control, then call `messages.observe` with the same identity assertion and a content region that excludes the composer. A sent input event is not success; require the reply text or a caller-owned predicate in the post-send candidates.
8. Bind every draft to the exact conversation and observed source fingerprints. Use one idempotency key per approved draft version. If the outcome is uncertain, only re-observe; never resend. User takeover cancels the active interaction and expires unsent approvals.

## Exactness gate

The structured collector is a first-pass observation, not an exact transcript oracle. Before producing user statistics, an exact transcript, or an automated reply decision, visually verify every record whose sender is null, whose confidence is below high, or whose type is `embedded_media_ocr`, using the trusted screenshot while the same persistent CLI session still owns it. Because the bounded collector closes its helper before stdout is consumed, use the raw persistent NDJSON lifecycle for this exactness gate, or use an explicit caller-approved screenshot path and delete it after verification. An application-provided copy/read path is also acceptable when it can be tied to the same conversation identity. Preserve the raw OCR and correction evidence separately; never silently rewrite OCR text. If the Agent has neither visual inspection nor an application copy path, report bounded partial collection instead of claiming exact users, content, or complete history.

## Bounded collector

Use [scripts/collect_messages.py](scripts/collect_messages.py) for multi-page collection when the regions are known. It keeps one helper and lease, can recover the initial conversation with `--locator-text`, stops on bounded no-progress, restores scroll best-effort, and writes JSON only to stdout. Pass an explicit caller-owned `--state-path` to checkpoint the complete structured context after each observation; a saved cursor becomes the default incremental boundary and avoids repeating older-page exploration.

```powershell
python .agents\skills\deskpilot-messaging\scripts\collect_messages.py `
  --cli src\WindowsAgent.Cli\bin\Debug\net10.0-windows10.0.19041.0\win-x64\win-agent.exe `
  --title-exact ExampleChat `
  --expected-identity "Support queue" `
  --locator-text "Support" `
  --identity-region 300,0,900,100 `
  --content-region 300,80,900,500 `
  --state-path state/support-queue.json `
  --max-pages 6
```

The collector returns both raw OCR occurrences and structured `messages`. Each message retains its source candidates, bounds, direction hint, confidence, and confidence reasons. Page evidence distinguishes `visible_identity` from `sequence_continuity`; inability to prove either stops with `CONVERSATION_CONTINUITY_NOT_PROVEN`. `history_complete` is true only when one of the caller's `--history-start-text` markers is reached; `history_exhaustion_confidence` separately grades weaker no-progress or page-limit evidence. Use `--omit-raw-candidates` only to reduce stdout because each structured message still retains its own source candidates.

Use `--since-message-fingerprint` only with a cursor returned from a prior bounded snapshot of the same conversation. The collector returns no incremental records when that cursor cannot be proven. Use `--unread-anchor-text` only for an application-visible unread marker; lack of such a marker is `unknown`, not zero unread. `content_kind` retains reference/image/media/emoji hints when observable, while unresolved media semantics remain explicit. Use [scripts/conversation_state.py](scripts/conversation_state.py) for pure draft, approval, takeover, idempotency, target-binding and send-result transitions, and [scripts/conversation_state_store.py](scripts/conversation_state_store.py) when the caller explicitly requests durable context.

For a caller-approved single reply followed by foreground monitoring, use [scripts/run_approved_reply_monitor.py](scripts/run_approved_reply_monitor.py). It keeps one helper and interaction lease, can recover only the initial conversation through a unique caller locator, validates the bound source fingerprints and verified reply anchor immediately before input, sends exactly once, waits for the configured interval before the first observation, and then observes without resending. Send verification accepts either one exact new outgoing OCR record or one unique, sufficiently long new outgoing fragment contained in the approved text; old, incoming, short, or ambiguous fragments cannot verify a send. `--resume-sent-fingerprint` performs no input and exists only to continue from separately proven sent evidence with the original idempotency key; with `--state-path`, the original attempt must be present in the checkpoint. Coordinate arguments and anchor evidence remain application adapter inputs; do not place application-specific coordinates in this skill. Long foreground monitoring intentionally keeps the activity cue and target window visible until completion or cancellation; identity drift is treated as user takeover and cancels rather than reacquiring, then restores the original foreground window.

The monitor defaults to `--reply-strategy specific_message`, requiring
`--reply-target-fingerprint` (or one and only one source fingerprint) plus
adapter-produced JSON such as
`{"status":"verified","message_fingerprint":"...","mode":"quote_preview"}`.
For a private logical turn, pass `--reply-strategy conversation_turn` with all
source fingerprints and evidence such as
`{"status":"verified","mode":"conversation_composer"}`; the latest source
is retained as the cursor anchor, but the answer is one batch. This evidence is
a gate, not a guessed recipient; the adapter remains responsible for proving
the application's conversation identity and composer state.

Durable persistence is opt-in through an explicit caller-owned path. When enabled, checkpoint complete structured context immediately after trusted observations and state transitions; do not persist screenshots, secrets or process logs. User statistics, business filtering, retention, identity resolution beyond visible UI evidence, and reply policy remain with the upper Agent or scenario adapter; they do not belong in DeskPilot or this generic skill.

Voice handling is adapter-driven. Pass explicit positioned `voice_candidates` to
`group_page_candidates` (or use [scripts/voice_processing.py](scripts/voice_processing.py))
to create a `content_kind=voice` record with duration and bounds. OCR text such
as `3"` is never enough to infer voice. An optional caller-owned ASR command may
return JSON `{text, confidence, engine}`; missing audio or ASR remains an
explicit `transcript.status=unavailable` and must not trigger a reply.

When an application exposes a visible native transcription action, use
[scripts/transcribe_visible_voice.py](scripts/transcribe_visible_voice.py). The
caller supplies the verified voice point, identity/content/menu regions and
localized menu label. The helper asserts the conversation, optionally recovers
it through a caller-owned list/search region, opens the voice menu once, invokes
one uniquely observed transcription action, and binds exactly one newly visible
nearby transcript to the voice record. OCR confidence remains `null` unless the
adapter supplies a numeric score; `engine=app_native` and positioned evidence
remain durable. Ambiguous menu actions or transcript candidates stop without a
second click. Search results, the native menu and the transcript use semantic
waits: observe immediately, return on the first unique match, and sleep only
after a declared transient miss within the bounded timeout. Do not add an
unconditional settle delay after an input action that is already verified by
the following observation.

To control token and UI cost, keep one host/lease, use the saved cursor as the delta boundary, deduplicate before passing messages to the model, send only confirmed deltas, rescan older pages only on a missing cursor/gap or identity uncertainty, and use bounded intervals/retries. “No new message” is a cheap derived result, not a reason to re-read full history.

## Failure decisions

- `CONTEXT_IDENTITY_MISMATCH`: reacquire the conversation only on the initial page; otherwise stop and report drift.
- `WINDOW_CAPTURE_UNTRUSTED`, `WINDOW_CAPTURE_EMPTY`, `WINDOW_IDENTITY_MISMATCH`: discard that page, re-resolve the window, and do not use its text as evidence.
- `OCR_UNAVAILABLE`, `OCR_LANGUAGE_UNAVAILABLE`, `OCR_FAILED`: stop; do not fall back to guessing from pixels.
- `STALE_OBSERVATION`: acquire a fresh observation or screenshot before the next coordinate action.
- `BATCH_OUTCOME_UNKNOWN` on reply: re-observe before deciding whether to send again; never blindly resend.

Always end or cancel the interaction so DeskPilot hides its activity cue and restores the original foreground window best-effort.
