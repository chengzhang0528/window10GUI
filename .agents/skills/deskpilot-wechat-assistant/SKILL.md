---
name: deskpilot-wechat-assistant
description: Use only for monitoring, collecting, replying, or evaluating AI-assistant behavior in the Windows Weixin/WeChat desktop client through DeskPilot; adds WeChat-specific conversation search, exact group reply, voice handling, participation, and learning rules on top of the generic desktop messaging skills. Do not use for other chat applications.
---

# DeskPilot WeChat Assistant

Use this skill only for the Windows desktop Weixin/WeChat client. Load
`deskpilot-core` and `deskpilot-messaging` first; their session, identity,
message-state, idempotency, and verification rules remain authoritative. Keep
cross-application behavior there and keep only WeChat UI semantics here.

For recurring group participation or product takeover evaluation, read
[references/group-assistant-loop.md](references/group-assistant-loop.md).

## WeChat adapter rules

- Resolve the actual `Weixin`/`WeChat` window and hold one DeskPilot host and
  one interaction lease for a complete observation/reply wave.
- Bind every wave to the caller's exact visible conversation title. If search
  is needed, type the exact title, observe immediately, and poll only after a
  transient miss. Restrict matching to the search dropdown; the same title in
  the underlying recent-conversation list is a second candidate, not proof.
  Click only one unique fresh OCR result, then reassert the title in the chat
  header before reading or sending.
- Treat WeChat groups as `specific_message`: every reply must use a visibly
  proven quote/reply anchor for one exact source message. A sender name or an
  open conversation alone does not prove the reply target. If the quote preview
  cannot be verified, stop with no send.
- Preserve a relevant multi-message context window before deciding. Ignore
  unrelated messages and do not answer every bubble. Distinguish passive
  response, natural active participation, and deliberate topic initiation;
  use at most one outbound message per wave.
- Apply any caller-provided disclosure text to every outbound message exactly
  as requested. The disclosure is part of the approved payload and must be
  present in post-send verification.
- Detect WeChat voice bubbles separately from OCR text. Prefer the app-native
  transcription action when it is uniquely visible; otherwise use an approved
  audio/ASR adapter. Persist transcript status and confidence. Do not infer or
  answer an unavailable or materially uncertain transcript.
- Immediately checkpoint the complete structured conversation context and the
  last verified cursor at the caller-owned state path. Do not persist
  screenshots, clipboard contents, process logs, or raw chat text in this skill
  or Git.
- Before input, recheck conversation identity, fresh quote anchor, idempotency
  key, disclosure, and composer state. After input, verify one new outgoing
  message in the same conversation. On uncertain outcome, observe only; never
  resend automatically.
- Always end or cancel the interaction and restore the user's prior foreground
  window best-effort. Identity drift, user takeover, ambiguous search, stale
  evidence, or failed send verification ends the wave without improvisation.

## Learning boundary

After every wave, record only de-identified operational evidence and decide
whether an enhancement is warranted. Do not edit a skill merely because a wave
had no new messages or one transient OCR miss.

- WeChat layout, search-dropdown, quote-preview, composer, voice-menu, and
  native-transcription behavior belongs in this skill.
- Collection, deduplication, context, idempotency, reply verification, or state
  rules proven application-independent belongs in `deskpilot-messaging`.
- Session, overlay, capture, input, waiting, and foreground behavior proven
  application-independent belongs in `deskpilot-core` or the Windows Agent
  product owner.
- One WeChat-only observation is not evidence for changing a generic skill.
  Keep it as a candidate until reproduced or supported by another application.
- Promote only a narrow rule supported by evidence, validate the affected
  skill, and never store conversation narrative as instruction text.
