# WeChat group assistant loop

Read this reference for scheduled or repeated WeChat group participation and
for evaluating whether DeskPilot can stably take over the visible client as an
AI assistant.

## Required run inputs

- Exact visible group title.
- Caller-owned durable state path outside Git.
- Required disclosure text for every outbound message.
- Poll cadence and participation limits authorized by the caller.
- A stable WeChat window selector and calibrated, window-relative identity,
  content, search-result, and composer regions. Machine-specific coordinates
  belong in local state, not in this skill.

## One wave

1. Open one DeskPilot host and interaction lease, activate the exact WeChat
   window, and recover the group only through one unique dropdown result.
2. Reassert the exact group title, collect only the delta after the saved
   cursor, include enough preceding messages to understand the current turn,
   detect voice bubbles, and checkpoint the structured context immediately.
3. Classify the wave as `no_action`, `passive_response`,
   `active_participation`, or `topic_initiation`.
4. Send nothing when messages are unrelated, context is incomplete, the latest
   speaker may still be composing a multi-message thought, a voice transcript
   is unavailable/uncertain, or the specific reply anchor is unproven.
5. When participating, choose one exact source message, establish WeChat's
   visible quote/reply preview, compose one concise contribution with the exact
   disclosure, send once under one idempotency key, and verify the new outgoing
   message in the same group.
6. End the interaction, restore focus best-effort, append a de-identified run
   record, and perform the enhancement audit below.

## Participation policy

- Prefer answering a direct question, correcting a consequential
  misunderstanding, adding useful context to an active topic, or asking one
  open question that naturally advances the current discussion.
- Do not force activity when the room is quiet. A proactive topic initiation
  requires an explicit caller allowance, no unresolved active turn, and a
  persisted cooldown. Default to no more than one proactive initiation in two
  hours and no more than one outbound message in any wave.
- Never manufacture agreement, personal experience, identity, availability,
  commitments, or facts on behalf of the user. Do not handle payments,
  credentials, legal commitments, harassment, or other high-impact decisions
  autonomously.
- Group replies always bind to one specific source message even when the final
  text also invites the rest of the group to participate.

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
