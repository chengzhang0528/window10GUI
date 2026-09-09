# Message state contract

Load this reference for incremental collection, reply drafting, approval, sending, or user takeover. It defines upper-Agent orchestration state; it is not a DeskPilot CLI API.

## Collection snapshot

A `ConversationSnapshot` binds all observed records to one exact `conversation_key`. Each record keeps OCR evidence plus a deterministic `message_fingerprint`; the collection cursor is the newest fingerprint in that bounded snapshot.

- A prior cursor is valid only when exactly one current record matches it. If absent or ambiguous, return no incremental messages and require a bounded rescan; never guess an offset.
- An unread boundary is `located` only when one caller-supplied visible marker matches exactly once. Otherwise report `unknown`, `not_located`, or `ambiguous`.
- `content_kind` may be `text`, `reference`, `image`, `media`, `voice`, `emoji`, `system`, `timestamp`, or `unknown`. Preserve explicit adapter hints. A visually detected voice bubble must remain a `voice` record with duration/evidence; until an audio/ASR adapter supplies a transcript, set `transcript.status=unavailable` and do not treat it as empty text or trigger an automatic reply. Image, card, and emoji meaning remains `semantic_status=unresolved` until a trusted adapter or visual inspection supplies it.
- Cross-page deduplication still requires ordered overlap evidence. A fingerprint is a session correlation key, not a global message identifier and not proof of complete history.

## Conversation state

`ConversationState` is execution-scoped in memory and can cross turns only via
the explicit durable checkpoint. It contains:

- the exact `conversation_key` and caller-supplied window/identity binding;
- the complete observed message records keyed by fingerprint;
- observed message fingerprints and optional visible participants;
- current topic with evidence fingerprints;
- pending questions, each bound to one observed source message;
- reply cursor;
- drafts and a send ledger;
- takeover state: `managed` or `user_controlled`.

When the caller enables the explicit state path, persist the complete structured
message context (content, sender/direction inference, fingerprints, bounds and
OCR provenance) together with the binding, cursor, drafts and send ledger.
Screenshots remain transient evidence owned by the caller and are not copied
into the state file. Checkpoint after every trusted observation and every state
transition using an atomic replace; a crash must resume from the last complete
checkpoint instead of repeating UI exploration. Without an explicit state
path, transitions remain in memory and no chat content is written.

## Reply state machine

Every reply draft binds the conversation, one or more observed source fingerprints,
a `reply_strategy`, adapter-provided `reply_anchor_evidence`, an evidence
summary, exact text, style profile version, and a unique `draft_id`. The
`specific_message` strategy (required for group chats) also binds one exact
`reply_target_message_fingerprint` and a quote/reply anchor. The
`conversation_turn` strategy is for private chats: several contiguous source
messages may form one logical question, the latest source is retained as a
cursor anchor, and a verified conversation-composer anchor is sufficient. It
must never create one outgoing reply per source bubble.

```text
awaiting_approval -> approved -> preflight_verified -> sending
                                                      |-> sent_verified
                                                      |-> send_uncertain
```

- Approval applies only to the exact `draft_id` and exact text. Editing expires the previous draft and creates a new version requiring approval.
- Before sending, freshly assert the same conversation and re-observe all bound source messages. Require a verified exact-message anchor for `specific_message`, or a verified conversation-composer anchor for `conversation_turn`, then create one idempotency key from conversation, sources, strategy, target, draft, and version.
- Once a send attempt exists, never create another attempt for the same idempotency key. `send_uncertain` may only be re-observed until visible evidence proves `sent_verified`; it must never trigger blind resend.
- Visible send evidence may be either the exact newly observed outgoing text or one unique newly observed outgoing OCR fragment contained in the approved text. A fragment must meet the caller's minimum useful length; an old, incoming, short, unrelated, or ambiguous fragment is insufficient. Record the verification mode with the attempt.
- When a trusted external exactness check proves the sent bubble but the original monitor cannot recognize its full text, resume observation from that proven message fingerprint and the existing idempotency key. Resume mode performs no input and no send.
- Advance the reply cursor and mark a pending question replied only after `sent_verified`.
- User takeover or visible conversation identity drift cancels the active DeskPilot interaction, changes state to `user_controlled`, and expires all unsent drafts. A new managed session requires fresh observation and fresh approval. The orchestration helper must remain alive long enough to issue `interaction.cancel`; isolate it from the parent's Ctrl+C process group.

Use `scripts/conversation_state.py` for pure transitions and
`scripts/conversation_state_store.py` for an explicit, caller-owned atomic
checkpoint path. `collect_messages.py --state-path` resumes from the persisted
cursor by default and stops once that cursor is proven, so “new message” is a
derived delta (`initial`, `delta`, `no_change`, or `gap`) rather than a separate
app-specific event source.
