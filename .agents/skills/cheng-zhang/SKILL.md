---
name: cheng-zhang
description: Draft replies in the authorized cheng.zhang communication style for user-controlled desktop chats. Use when the user asks to collect chat context, prepare a reply, or send an already approved draft; require per-message approval and never persist raw chat history.
---

# cheng.zhang

Prepare concise replies in the user's authorized communication style while keeping the user in control of every send. Read [references/style-profile.md](references/style-profile.md) before drafting, classify the current conversational purpose, then read the matching section in [references/scenario-profiles.md](references/scenario-profiles.md). When operating a Windows chat application, also use `deskpilot-core` and `deskpilot-messaging`; this skill owns style and approval, not desktop mechanics.

## Workflow

1. Resolve the exact conversation and collect only the recent context needed for one reply. Require the conversation identity and apply the `deskpilot-messaging` exactness gate before relying on uncertain OCR.
2. Classify the immediate purpose as group discussion, private collaboration, private casual coordination, or ambiguous. Classify from the visible exchange and requested outcome, never from a participant's identity. Use the shared profile alone when the purpose is ambiguous.
3. Decide whether a reply is useful. It is valid to recommend no reply when the visible conversation has no clear opening, the relevant message is ambiguous, or a response would require facts the user has not supplied.
4. Produce one preferred single-message draft. Samples may contain several consecutive bubbles, but per-message approval takes precedence: do not split a draft into multiple sends or queue follow-up bubbles unless the user explicitly asks for separately approved messages. Keep optional alternatives to one only when they represent a material tone choice.
5. Stop in `awaiting_approval` and show an approval packet containing:
   - conversation identity;
   - intended recipient or quoted message summary;
   - a unique `draft_id` and the exact draft text;
   - any factual uncertainty or commitment the user must resolve;
   - the instruction `发送 <draft_id>` or a request for edits.
6. Treat only `发送 <draft_id>`, `按此发送 <draft_id>`, or an unambiguous `发送` when exactly one draft is pending in the immediately preceding turn as authorization. `继续`, general agreement, approval of a plan, or earlier authorization to use this skill is not send approval.
7. Any edited text creates a new draft version and requires fresh approval. Re-observe and require fresh approval when the conversation identity changes or a new relevant message makes the approved reply misleading.
8. After approval, use one DeskPilot lease and a fresh screenshot to assert the same conversation, focus the composer, enter the exact approved text, send once, and read the message area again. Report `sent_verified` only when the approved text is visibly present in that conversation.
9. On `BATCH_OUTCOME_UNKNOWN` or missing post-send evidence, re-observe without resending and report `send_uncertain`. Always end or cancel the lease and restore the user's foreground window best-effort.

## Style and data boundaries

- Apply only the abstract preferences in the style profile. Do not store or reproduce raw private or group-chat transcripts in this skill.
- Do not invent personal experience, relationships, opinions, identity claims, promises, availability, money decisions, or facts on the user's behalf. Ask for the missing fact or draft a question instead.
- Do not optimize for concealing automation or defeating another person's ability to understand who authored a message. The approved message remains the user's communication decision.
- Do not learn persistently from new conversations without an explicit user request to update the profile.

## Profile refinement

When the user explicitly asks to refine this skill from authorized conversations:

- use only the user's visibly outgoing messages as positive style samples; incoming messages may establish purpose and reply context but never define the user's voice;
- require exact conversation identity, trusted screenshots, and the `deskpilot-messaging` exactness gate before deriving a rule;
- classify samples by conversational purpose rather than contact, application, group name, or website;
- promote a preference only when it recurs across several samples or the user states it explicitly; keep one-off phrasing, typos, private facts, commitments, relationship details, and OCR artifacts out of the profile;
- persist only the smallest abstract rule that changes future drafting, then delete temporary screenshots and raw extraction data.

## Scope boundary

This is an upper-Agent style and approval skill. Application selectors, message parsing, send verification, cancellation, and foreground restoration remain in the DeskPilot skills and public CLI. Do not add personal style, WeChat rules, autonomous engagement loops, background monitoring, or business reply policy to the DeskPilot core.
