# WeChat group assistant loop

Read this reference for scheduled or repeated WeChat group participation and
for evaluating whether DeskPilot can stably take over the visible client as an
AI assistant.

## Required run inputs

- Exact visible group title.
- Caller-owned durable state path outside Git.
- Required disclosure text for every outbound message.
- Poll cadence and participation limits authorized by the caller.
- Optional per-conversation consecutive assistant-send cap. Zero disables it;
  when configured, persist it with the conversation checkpoint.
- A stable WeChat window selector and calibrated, window-relative identity,
  content, search-result, and composer regions. Machine-specific coordinates
  belong in local state, not in this skill.

## One wave

1. Open one DeskPilot host and interaction lease, activate the exact WeChat
   window, and recover the group only through one unique dropdown result. Use
   `scripts/run_group_wave.py` for this mechanical path; it observes
   immediately and polls only after a declared transient miss.
2. Reassert the exact group title, collect only the delta after the saved
   visible sequence, include the accumulated structured context needed to
   understand the current turn, detect voice bubbles, and checkpoint it
   immediately. Return the actual new-message records and OCR confidence rather
   than only a count. The accumulated context grows only from sequence-proven
   deltas; return its total count plus a bounded recent tail while retaining the
   complete context in the durable state file. On a continuity gap, report the
   gap instead of duplicating the whole viewport. Exclude records proven by the
   sent ledger and right-side geometry from `new_messages`, even if generic OCR
   direction inference labels that outgoing bubble as incoming.
3. If this is the initial takeover, or a prior baseline exists without a
   `sent_verified` initial-participation record, send exactly one low-risk
   initial participation before allowing `no_action`. Treat baseline messages
   as context rather than new delta: quote one safe visible message, then
   either continue its topic or ask a lightweight open question that starts a
   new direction. If the exact group, source message, quote preview, or send
   result cannot be proven, report the blocker instead of fabricating proof.
4. Otherwise classify the wave as `no_action`, `passive_response`,
   `active_participation`, or `topic_initiation`.
5. Send nothing when messages are unrelated, context is incomplete, the latest
   speaker may still be composing a multi-message thought, a voice transcript
   is unavailable/uncertain, or the specific reply anchor is unproven.
   Also send nothing when the persisted consecutive-send cap has been reached;
   this gate runs before opening a message menu or touching the composer.
6. When participating, choose one exact source message, establish WeChat's
   visible quote/reply preview, compose one concise contribution with the exact
   disclosure, send once under one idempotency key, and verify the new outgoing
   message in the same group. A newest message near the composer remains a valid
   source candidate; right-click the strongest body OCR line and use the quote
   menu's unique UIA `MenuItem` plus the quote preview as the final anchor gates
   instead of switching to an older message solely because of its vertical
   position. The menu is an independent `CMenuWnd`; main-window OCR may crop its
   lower items and is only a visible-label fallback.
7. End the interaction, restore focus best-effort, append a de-identified run
   record, and perform the enhancement audit below.

## Participation policy

- Prefer answering a direct question, correcting a consequential
  misunderstanding, adding useful context to an active topic, or asking one
  open question that naturally advances the current discussion.
- After the one-time initial participation is verified, do not force activity
  when the room is quiet. A later proactive topic initiation requires an
  explicit caller allowance, no unresolved active turn, and a persisted
  cooldown. Default to no more than one proactive initiation in two hours and
  no more than one outbound message in any wave.
- Never manufacture agreement, personal experience, identity, availability,
  commitments, or facts on behalf of the user. Do not handle payments,
  credentials, legal commitments, harassment, or other high-impact decisions
  autonomously.
- Group replies always bind to one specific source message even when the final
  text also invites the rest of the group to participate.
- A verified assistant send increases the current consecutive-send streak. A
  proven incoming participant message resets it. Timestamps, system records,
  low-confidence single-glyph/avatar OCR artifacts, direction guesses, and
  unverified/manual outgoing bubbles do not reset or increase this
  assistant-specific streak.

## De-identified experience record

Store operational records outside the repository. A record may contain:

- Timestamp, hashed conversation key, run duration, and UI latency buckets.
- Identity verified, delta count, voice count, transcript status/confidence
  bucket, chosen participation class, and the no-send/send reason code.
- Reply anchor verified, send attempted, send verified, idempotency outcome,
  restoration outcome, and structured DeskPilot failure codes.
- Enhancement classification: `none`, `wechat_candidate`,
  `generic_messaging_candidate`, or `core_candidate`, with a short de-identified
  rationale and evidence count.

Do not store participant names, raw messages, screenshots, contact lists,
clipboard data, or generated reply text in the experience record. The normal
caller-owned conversation checkpoint may retain the structured context only
because the caller explicitly authorized it; keep it out of Git.

## Stability scorecard

At the end of each wave assess, without turning missing evidence into success:

- Exact conversation acquisition and identity continuity.
- Delta completeness, ordering, deduplication, and immediate persistence.
- Correct silence versus passive/active participation decision.
- Specific-message reply proof and disclosure presence.
- Voice detection, transcript provenance, and confidence handling.
- Exactly-once send behavior and post-send verification.
- Search/action latency, overlay/focus stability, cleanup, and user takeover.

## Enhancement audit

Promote a rule only when a deterministic defect is reproduced or the same
de-identified candidate has at least two supporting waves. Patch the narrowest
owner and run its validator/tests. A WeChat adapter observation may immediately
improve this skill when it is deterministic and WeChat-specific; it may only
create a generic candidate until application-independent evidence exists. No-op
polls and ordinary conversation outcomes never trigger skill edits.
