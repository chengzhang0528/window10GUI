"""Pure state transitions for approved desktop message replies.

Persistence is deliberately kept in ``conversation_state_store.py`` so these
transitions remain deterministic and easy to exercise in isolation.
"""

from __future__ import annotations

import copy
import hashlib
import json
from typing import Any, Iterable


STATE_SCHEMA_VERSION = "2"


class MessagingStateError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def _digest(prefix: str, payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"{prefix}-{hashlib.sha256(encoded).hexdigest()[:24]}"


def _unique_strings(values: Iterable[Any]) -> list[str]:
    result: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if text and text not in result:
            result.append(text)
    return result


def _touch(state: dict[str, Any], transition: str) -> dict[str, Any]:
    """Advance the durable revision without changing the transition result."""
    updated = state
    updated["state_revision"] = int(updated.get("state_revision") or 0) + 1
    updated["last_transition"] = transition
    return updated


def _message_map(messages: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for message in messages:
        if not isinstance(message, dict):
            continue
        fingerprint = str(message.get("message_fingerprint") or "").strip()
        if fingerprint:
            result[fingerprint] = copy.deepcopy(message)
    return result


def create_conversation_state(
    snapshot: dict[str, Any],
    *,
    participants: Iterable[str] = (),
    current_topic: dict[str, Any] | None = None,
    pending_questions: Iterable[dict[str, Any]] = (),
    conversation_mode: str = "unknown",
) -> dict[str, Any]:
    conversation_key = str(snapshot.get("conversation_key") or "").strip()
    if not conversation_key:
        raise MessagingStateError("CONVERSATION_KEY_REQUIRED", "The snapshot must contain conversation_key.")
    messages = list(snapshot.get("messages") or [])
    fingerprints = _unique_strings(message.get("message_fingerprint") for message in messages)
    fingerprint_set = set(fingerprints)
    questions: list[dict[str, Any]] = []
    for index, question in enumerate(pending_questions, 1):
        source = str(question.get("source_message_fingerprint") or "").strip()
        summary = str(question.get("summary") or "").strip()
        if not source or source not in fingerprint_set:
            raise MessagingStateError(
                "QUESTION_SOURCE_NOT_OBSERVED",
                "Every pending question must bind an observed source message fingerprint.",
            )
        if not summary:
            raise MessagingStateError("QUESTION_SUMMARY_REQUIRED", "Every pending question requires a summary.")
        questions.append(
            {
                "question_id": _digest("question", {"conversation_key": conversation_key, "source": source, "summary": summary}),
                "source_message_fingerprint": source,
                "summary": summary,
                "status": str(question.get("status") or "pending"),
                "ordinal": index,
            }
        )
    topic = copy.deepcopy(current_topic) if current_topic is not None else None
    if topic is not None:
        evidence = _unique_strings(topic.get("evidence_message_fingerprints") or [])
        if any(fingerprint not in fingerprint_set for fingerprint in evidence):
            raise MessagingStateError("TOPIC_EVIDENCE_NOT_OBSERVED", "Topic evidence must bind observed messages.")
        topic["evidence_message_fingerprints"] = evidence
    return {
        "schema_version": STATE_SCHEMA_VERSION,
        "conversation_key": conversation_key,
        "conversation_mode": str(conversation_mode or "unknown"),
        "conversation_binding": copy.deepcopy(snapshot.get("conversation_binding") or {}),
        "snapshot_cursor": copy.deepcopy(snapshot.get("collection_cursor") or {}),
        "observed_message_fingerprints": fingerprints,
        # Keep the complete structured context (including OCR provenance) in
        # the caller-selected durable checkpoint. Screenshots are not part of
        # a message record and therefore are never copied into this state.
        "observed_messages": _message_map(messages),
        "participants": _unique_strings(participants),
        "current_topic": topic,
        "pending_questions": questions,
        "reply_cursor": None,
        "takeover_state": "managed",
        "drafts": {},
        "send_ledger": {},
        "state_revision": 1,
        "last_transition": "snapshot_created",
    }


def update_snapshot(state: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    if snapshot.get("conversation_key") != state.get("conversation_key"):
        raise MessagingStateError("CONVERSATION_IDENTITY_CHANGED", "The new snapshot belongs to another conversation.")
    updated = copy.deepcopy(state)
    if snapshot.get("conversation_binding"):
        updated["conversation_binding"] = copy.deepcopy(snapshot["conversation_binding"])
    incoming_cursor = copy.deepcopy(snapshot.get("collection_cursor") or {})
    # An empty/temporarily virtualized OCR frame is not evidence that the
    # previously proven cursor disappeared. Preserve it and let the caller
    # classify the observation as uncertain instead of re-exploring history.
    if any(value not in (None, "") for value in incoming_cursor.values()):
        updated["snapshot_cursor"] = incoming_cursor
    new_messages = [message for message in snapshot.get("messages") or [] if isinstance(message, dict)]
    new_fingerprints = _unique_strings(message.get("message_fingerprint") for message in new_messages)
    existing_fingerprints = _unique_strings(updated.get("observed_message_fingerprints") or [])
    existing_fingerprints += [
        fingerprint
        for fingerprint in (updated.get("observed_messages") or {}).keys()
        if fingerprint not in existing_fingerprints
    ]
    updated["observed_message_fingerprints"] = existing_fingerprints + [
        fingerprint for fingerprint in new_fingerprints if fingerprint not in existing_fingerprints
    ]
    observed_messages = dict(updated.get("observed_messages") or {})
    observed_messages.update(_message_map(new_messages))
    updated["observed_messages"] = observed_messages
    return _touch(updated, "snapshot_updated")


def register_draft(
    state: dict[str, Any],
    *,
    reply_to_message_fingerprints: Iterable[str],
    reply_target_message_fingerprint: str | None = None,
    reply_anchor_evidence: dict[str, Any] | None = None,
    basis_summary: str,
    exact_text: str,
    style_profile_version: str,
    replaces_draft_id: str | None = None,
    reply_strategy: str = "specific_message",
) -> tuple[dict[str, Any], dict[str, Any]]:
    sources = _unique_strings(reply_to_message_fingerprints)
    observed = set(state.get("observed_message_fingerprints") or [])
    if not sources or any(source not in observed for source in sources):
        raise MessagingStateError("DRAFT_SOURCE_NOT_OBSERVED", "A draft must bind one or more observed source messages.")
    target = str(reply_target_message_fingerprint or "").strip()
    if not target:
        if len(sources) == 1:
            target = sources[0]
        else:
            raise MessagingStateError(
                "REPLY_TARGET_REQUIRED",
                "A draft must identify exactly which observed message it replies to.",
            )
    if target not in sources:
        raise MessagingStateError(
            "REPLY_TARGET_NOT_IN_SOURCES",
            "The reply target must be one of the draft's observed source messages.",
        )
    text = str(exact_text or "")
    basis = str(basis_summary or "").strip()
    style_version = str(style_profile_version or "").strip()
    strategy = str(reply_strategy or "specific_message").strip()
    if strategy not in {"specific_message", "conversation_turn"}:
        raise MessagingStateError("REPLY_STRATEGY_INVALID", "Reply strategy must be specific_message or conversation_turn.")
    if not text.strip():
        raise MessagingStateError("DRAFT_TEXT_REQUIRED", "A draft requires exact non-empty text.")
    if not basis:
        raise MessagingStateError("DRAFT_BASIS_REQUIRED", "A draft requires a concise evidence summary.")
    if not style_version:
        raise MessagingStateError("STYLE_PROFILE_VERSION_REQUIRED", "A draft must identify its style profile version.")
    version = 1
    updated = copy.deepcopy(state)
    if replaces_draft_id:
        previous = updated["drafts"].get(replaces_draft_id)
        if previous is None:
            raise MessagingStateError("DRAFT_NOT_FOUND", "The replaced draft does not exist.")
        previous["status"] = "expired"
        version = int(previous.get("version", 1)) + 1
    identity = {
        "conversation_key": state["conversation_key"],
        "reply_to_message_fingerprints": sources,
        "reply_target_message_fingerprint": target,
        "reply_anchor_evidence": copy.deepcopy(reply_anchor_evidence) if reply_anchor_evidence else None,
        "reply_strategy": strategy,
        "basis_summary": basis,
        "exact_text": text,
        "style_profile_version": style_version,
        "version": version,
        "replaces_draft_id": replaces_draft_id,
    }
    draft_id = _digest("draft", identity)
    draft = identity | {"draft_id": draft_id, "status": "awaiting_approval"}
    updated["drafts"][draft_id] = draft
    return _touch(updated, "draft_registered"), copy.deepcopy(draft)


def approve_draft(state: dict[str, Any], draft_id: str, exact_text: str) -> dict[str, Any]:
    updated = copy.deepcopy(state)
    draft = updated.get("drafts", {}).get(draft_id)
    if draft is None:
        raise MessagingStateError("DRAFT_NOT_FOUND", "The draft does not exist.")
    if draft.get("status") != "awaiting_approval":
        raise MessagingStateError("DRAFT_NOT_AWAITING_APPROVAL", "Only a pending draft can be approved.")
    if exact_text != draft.get("exact_text"):
        raise MessagingStateError("DRAFT_TEXT_CHANGED", "Approval text must match the exact registered draft.")
    draft["status"] = "approved"
    return _touch(updated, "draft_approved")


def mark_user_takeover(state: dict[str, Any]) -> dict[str, Any]:
    updated = copy.deepcopy(state)
    updated["takeover_state"] = "user_controlled"
    for draft in updated.get("drafts", {}).values():
        if draft.get("status") in {"awaiting_approval", "approved"}:
            draft["status"] = "expired"
    return _touch(updated, "user_takeover")


def prepare_send(
    state: dict[str, Any],
    draft_id: str,
    *,
    observed_conversation_key: str,
    observed_message_fingerprints: Iterable[str],
    reply_target_message_fingerprint: str | None = None,
    reply_anchor_evidence: dict[str, Any] | None = None,
    reply_strategy: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if state.get("takeover_state") != "managed":
        raise MessagingStateError("USER_TAKEOVER_ACTIVE", "Sending is disabled after user takeover.")
    if observed_conversation_key != state.get("conversation_key"):
        raise MessagingStateError("CONVERSATION_IDENTITY_CHANGED", "Preflight observed another conversation.")
    draft = copy.deepcopy(state.get("drafts", {}).get(draft_id))
    if draft is None:
        raise MessagingStateError("DRAFT_NOT_FOUND", "The draft does not exist.")
    if draft.get("status") != "approved":
        raise MessagingStateError("DRAFT_NOT_APPROVED", "The exact draft requires fresh approval before sending.")
    observed = set(_unique_strings(observed_message_fingerprints))
    sources = list(draft.get("reply_to_message_fingerprints") or [])
    if any(source not in observed for source in sources):
        raise MessagingStateError("SOURCE_MESSAGE_NOT_REOBSERVED", "A bound source message was not proven during preflight.")
    target = str(
        reply_target_message_fingerprint
        or draft.get("reply_target_message_fingerprint")
        or (sources[0] if len(sources) == 1 else "")
    ).strip()
    strategy = str(reply_strategy or draft.get("reply_strategy") or "specific_message").strip()
    if strategy not in {"specific_message", "conversation_turn"}:
        raise MessagingStateError("REPLY_STRATEGY_INVALID", "Reply strategy must be specific_message or conversation_turn.")
    if not target:
        raise MessagingStateError(
            "REPLY_TARGET_REQUIRED",
            "Sending requires one exact message fingerprint as the reply target.",
        )
    if target not in sources or target not in observed:
        raise MessagingStateError(
            "REPLY_TARGET_NOT_REOBSERVED",
            "The exact reply target was not proven during preflight.",
        )
    anchor = copy.deepcopy(reply_anchor_evidence or draft.get("reply_anchor_evidence"))
    if (
        not isinstance(anchor, dict)
        or anchor.get("status") != "verified"
        or not str(anchor.get("mode") or "").strip()
    ):
        raise MessagingStateError(
            "SPECIFIC_REPLY_UNPROVEN",
            "Sending requires fresh evidence that the UI is anchored to the exact reply target.",
        )
    if strategy == "specific_message" and str(anchor.get("message_fingerprint") or "") != target:
        raise MessagingStateError(
            "REPLY_ANCHOR_TARGET_MISMATCH",
            "Reply-anchor evidence belongs to another message.",
        )
    idempotency_key = _digest(
        "send",
        {
            "conversation_key": state["conversation_key"],
            "reply_to_message_fingerprints": sources,
            "reply_strategy": strategy,
            "reply_target_message_fingerprint": target,
            "draft_id": draft_id,
            "version": draft["version"],
        },
    )
    if idempotency_key in state.get("send_ledger", {}):
        raise MessagingStateError("DUPLICATE_SEND_BLOCKED", "This reply already has a send attempt; re-observe it instead.")
    attempt = {
        "attempt_id": idempotency_key,
        "idempotency_key": idempotency_key,
        "conversation_key": state["conversation_key"],
        "reply_to_message_fingerprints": sources,
        "reply_target_message_fingerprint": target,
        "reply_anchor_evidence": anchor,
        "reply_strategy": strategy,
        "draft_id": draft_id,
        "draft_version": draft["version"],
        "exact_text": draft["exact_text"],
        "status": "preflight_verified",
    }
    updated = copy.deepcopy(state)
    updated["send_ledger"][idempotency_key] = attempt
    return _touch(updated, "send_preflight_verified"), copy.deepcopy(attempt)


def begin_send(state: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
    updated = copy.deepcopy(state)
    attempt = updated.get("send_ledger", {}).get(idempotency_key)
    if attempt is None:
        raise MessagingStateError("SEND_ATTEMPT_NOT_FOUND", "The send attempt does not exist.")
    if attempt.get("status") != "preflight_verified":
        raise MessagingStateError("SEND_ATTEMPT_NOT_READY", "Only a verified preflight can start sending.")
    attempt["status"] = "sending"
    return _touch(updated, "send_started")


def record_send_observation(
    state: dict[str, Any],
    idempotency_key: str,
    *,
    verified: bool | None,
    evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    updated = copy.deepcopy(state)
    attempt = updated.get("send_ledger", {}).get(idempotency_key)
    if attempt is None:
        raise MessagingStateError("SEND_ATTEMPT_NOT_FOUND", "The send attempt does not exist.")
    if attempt.get("status") not in {"sending", "send_uncertain"}:
        raise MessagingStateError("SEND_OBSERVATION_NOT_ALLOWED", "This attempt cannot consume a send observation.")
    attempt["status"] = "sent_verified" if verified is True else "send_uncertain"
    attempt["verification_evidence"] = copy.deepcopy(evidence) if evidence is not None else None
    return _touch(updated, "send_observed_verified" if verified is True else "send_observed_uncertain")


def advance_reply_cursor(state: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
    updated = copy.deepcopy(state)
    attempt = updated.get("send_ledger", {}).get(idempotency_key)
    if attempt is None or attempt.get("status") != "sent_verified":
        raise MessagingStateError("REPLY_NOT_VERIFIED", "The reply cursor moves only after sent_verified.")
    sources = list(attempt.get("reply_to_message_fingerprints") or [])
    target = str(attempt.get("reply_target_message_fingerprint") or (sources[-1] if sources else "")) or None
    updated["reply_cursor"] = {
        "message_fingerprint": target,
        "idempotency_key": idempotency_key,
        "reason": "sent_verified",
    }
    for question in updated.get("pending_questions", []):
        if question.get("source_message_fingerprint") == target:
            question["status"] = "replied"
    return _touch(updated, "reply_cursor_advanced")


def mark_message_handled(state: dict[str, Any], message_fingerprint: str) -> dict[str, Any]:
    if message_fingerprint not in set(state.get("observed_message_fingerprints") or []):
        raise MessagingStateError("MESSAGE_NOT_OBSERVED", "Only an observed message can be marked handled.")
    updated = copy.deepcopy(state)
    updated["reply_cursor"] = {
        "message_fingerprint": message_fingerprint,
        "idempotency_key": None,
        "reason": "explicit_user_handled",
    }
    return _touch(updated, "message_marked_handled")
