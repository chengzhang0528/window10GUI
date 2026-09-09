#!/usr/bin/env python3
"""Send one already-approved desktop reply, then monitor without resending."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from collect_messages import DeskPilotError, DeskPilotHost, parse_region, recover_initial_conversation
from conversation_state import (
    MessagingStateError,
    advance_reply_cursor,
    begin_send,
    create_conversation_state,
    mark_user_takeover,
    prepare_send,
    record_send_observation,
    update_snapshot,
)
from conversation_state_store import ConversationStateStore
from message_structure import finalize_timeline, group_page_candidates, incremental_slice, normalize_text


class MonitorError(RuntimeError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        self.code = code
        self.details = details
        super().__init__(message)


def emit(event: str, **values: Any) -> None:
    print(json.dumps({"event": event, **values}, ensure_ascii=True, separators=(",", ":")), flush=True)


def target_params(args: argparse.Namespace) -> dict[str, Any]:
    if args.process:
        return {"process": args.process}
    if args.title_contains:
        return {"title_contains": args.title_contains}
    return {"title_exact": args.title_exact}


def observe(host: DeskPilotHost, args: argparse.Namespace) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    result = host.request(
        "messages.observe",
        target_params(args)
        | {
            "expected_identity": args.expected_identity,
            "identity_match": args.identity_match,
            "identity_region": args.identity_region,
            "content_region": args.content_region,
            "action_label": "观察消息回复",
        },
    )
    screenshot = result.get("screenshot") or {}
    if not screenshot.get("trusted"):
        raise MonitorError("WINDOW_CAPTURE_UNTRUSTED", "The message observation was not a trusted target-window capture.")
    if not (result.get("context_identity") or {}).get("matched"):
        raise MonitorError("CONTEXT_IDENTITY_MISMATCH", "The observed conversation identity did not match.")
    messages = finalize_timeline(
        group_page_candidates(
            result.get("message_candidates") or [],
            args.content_region,
            1,
            voice_candidates=result.get("voice_candidates") or [],
        )
    )
    return result, messages


def initial_observe(host: DeskPilotHost, args: argparse.Namespace) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        return observe(host, args)
    except DeskPilotError as exc:
        if exc.code != "CONTEXT_IDENTITY_MISMATCH" or not args.locator_text:
            raise
        result = recover_initial_conversation(host, args)
        screenshot = result.get("screenshot") or {}
        if not screenshot.get("trusted") or not (result.get("context_identity") or {}).get("matched"):
            raise MonitorError(
                "INITIAL_CONVERSATION_RECOVERY_FAILED",
                "The recovered initial conversation did not pass trusted identity verification.",
            )
        messages = finalize_timeline(
            group_page_candidates(
                result.get("message_candidates") or [],
                args.content_region,
                1,
                voice_candidates=result.get("voice_candidates") or [],
            )
        )
        return result, messages


def sent_message_evidence(
    messages: list[dict[str, Any]],
    exact_text: str,
    prior_fingerprints: set[str],
    minimum_fragment_characters: int = 12,
) -> dict[str, Any]:
    """Prove one newly observed outgoing bubble using exact or bounded fragment OCR."""
    expected = normalize_text(exact_text)
    matches: list[dict[str, Any]] = []
    for message in messages:
        fingerprint = str(message.get("message_fingerprint") or "")
        if not fingerprint or fingerprint in prior_fingerprints or message.get("direction") != "outgoing":
            continue
        observed = normalize_text(str(message.get("content") or ""))
        if observed == expected:
            mode = "exact_outgoing_text"
        elif (
            len(observed) >= minimum_fragment_characters
            and expected
            and (observed in expected or expected in observed)
        ):
            mode = "new_outgoing_text_fragment"
        else:
            continue
        matches.append(
            {
                "message_fingerprint": fingerprint,
                "mode": mode,
                "observed_normalized_length": len(observed),
                "expected_normalized_length": len(expected),
            }
        )
    if len(matches) != 1:
        return {
            "verified": False,
            "status": "not_found" if not matches else "ambiguous",
            "message_fingerprint": None,
            "match_count": len(matches),
        }
    return {"verified": True, "status": "verified", "match_count": 1, **matches[0]}


def exact_text_fingerprint(messages: list[dict[str, Any]], exact_text: str) -> str | None:
    """Compatibility helper for callers that require full normalized equality."""
    expected = normalize_text(exact_text)
    matches = [
        str(message.get("message_fingerprint"))
        for message in messages
        if normalize_text(str(message.get("content") or "")) == expected
    ]
    return matches[-1] if matches else None


def parse_reply_anchor(value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    try:
        anchor = json.loads(value)
    except json.JSONDecodeError as exc:
        raise MonitorError("REPLY_ANCHOR_INVALID", f"Reply-anchor evidence must be valid JSON: {exc}") from exc
    if not isinstance(anchor, dict):
        raise MonitorError("REPLY_ANCHOR_INVALID", "Reply-anchor evidence must be a JSON object.")
    return anchor


def approved_state(
    args: argparse.Namespace,
    messages: list[dict[str, Any]],
    *,
    existing_state: dict[str, Any] | None = None,
    reply_anchor_evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    snapshot = {
        "conversation_key": args.conversation_key,
        "conversation_binding": {
            "target": target_params(args),
            "expected_identity": list(args.expected_identity),
            "identity_match": args.identity_match,
        },
        "collection_cursor": {
            "message_fingerprint": messages[-1].get("message_fingerprint") if messages else None
        },
        "messages": messages,
    }
    state = update_snapshot(existing_state, snapshot) if existing_state is not None else create_conversation_state(snapshot)
    sources = list(args.source_fingerprint)
    target = str(getattr(args, "reply_target_fingerprint", None) or "").strip() or (
        sources[0] if len(sources) == 1 else ""
    )
    strategy = str(getattr(args, "reply_strategy", None) or "specific_message").strip()
    if strategy not in {"specific_message", "conversation_turn"}:
        raise MonitorError("REPLY_STRATEGY_INVALID", "Reply strategy must be specific_message or conversation_turn.")
    if not target:
        raise MonitorError(
            "REPLY_TARGET_REQUIRED",
            "A reply must identify exactly one source message as its target.",
        )
    if target not in sources:
        raise MonitorError(
            "REPLY_TARGET_NOT_IN_SOURCES",
            "The reply target must be one of --source-fingerprint.",
        )
    previous = state.get("drafts", {}).get(args.draft_id)
    if previous is not None:
        immutable = {
            "conversation_key": args.conversation_key,
            "reply_to_message_fingerprints": sources,
            "reply_target_message_fingerprint": target,
            "reply_strategy": strategy,
            "exact_text": args.exact_text,
            "version": args.draft_version,
        }
        if any(previous.get(key) != value for key, value in immutable.items()):
            raise MonitorError("DRAFT_BINDING_CHANGED", "The persisted draft binding differs from the approved request.")
        previous["status"] = "approved"
        if reply_anchor_evidence is not None:
            previous["reply_anchor_evidence"] = reply_anchor_evidence
    else:
        state["drafts"][args.draft_id] = {
            "draft_id": args.draft_id,
            "conversation_key": args.conversation_key,
            "reply_to_message_fingerprints": sources,
            "reply_target_message_fingerprint": target,
            "reply_strategy": strategy,
            "reply_anchor_evidence": reply_anchor_evidence,
            "basis_summary": "caller-approved reply",
            "style_profile_version": "caller-approved-v1",
            "exact_text": args.exact_text,
            "version": args.draft_version,
            "status": "approved",
        }
    state["state_revision"] = int(state.get("state_revision") or 0) + 1
    state["last_transition"] = "approved_context_loaded"
    return state


def require_reply_anchor(
    evidence: dict[str, Any] | None,
    target_fingerprint: str,
    reply_strategy: str = "specific_message",
) -> dict[str, Any]:
    """Require adapter proof for an exact message or a private turn composer."""
    if (
        not isinstance(evidence, dict)
        or evidence.get("status") != "verified"
        or not str(evidence.get("mode") or "").strip()
    ):
        raise MonitorError(
            "SPECIFIC_REPLY_UNPROVEN",
            "The UI did not provide verified evidence for the exact reply target; sending is blocked.",
        )
    if reply_strategy == "specific_message" and str(evidence.get("message_fingerprint") or "") != target_fingerprint:
        raise MonitorError(
            "REPLY_ANCHOR_TARGET_MISMATCH",
            "Reply-anchor evidence belongs to another message.",
        )
    return evidence


def validate_point(name: str, x: int, y: int, window: dict[str, Any]) -> None:
    bounds = window.get("bounds") or {}
    width = int(bounds.get("width", 0))
    height = int(bounds.get("height", 0))
    if not 0 <= x < width or not 0 <= y < height:
        raise MonitorError("COORDINATE_OUT_OF_BOUNDS", f"{name} ({x},{y}) is outside {width}x{height}.")


def run(args: argparse.Namespace) -> int:
    host = DeskPilotHost(args.cli.resolve())
    state_path = getattr(args, "state_path", None)
    state_store = ConversationStateStore(state_path) if state_path else None
    persisted: dict[str, Any] | None = None
    interaction_id: str | None = None
    state: dict[str, Any] | None = None
    attempt: dict[str, Any] | None = None
    sent_at: float | None = None
    cancel_requested = False
    seen_record_fingerprints: set[str] = set()
    seen_reply_fingerprints: set[str] = set()
    try:
        if state_store is not None:
            persisted = state_store.load(conversation_key=args.conversation_key)
        begun = host.request(
            "interaction.begin",
            {
                "label": "AGENT 观察群聊中",
                "show_overlay": True,
                "show_action_trace": args.show_action_trace,
                "restore_original_window": True,
            },
        )
        interaction_id = str((begun.get("interaction") or {}).get("interaction_id") or "")
        host.request("windows.activate", target_params(args) | {"action_label": "进入已批准会话"})
        preflight, preflight_messages = initial_observe(host, args)
        preflight_fingerprints = {
            str(message.get("message_fingerprint") or "") for message in preflight_messages
        }
        reply_strategy = getattr(args, "reply_strategy", "specific_message")
        target_fingerprint = str(getattr(args, "reply_target_fingerprint", None) or "").strip() or (
            args.source_fingerprint[0] if len(args.source_fingerprint) == 1 else (
                args.source_fingerprint[-1] if reply_strategy == "conversation_turn" else ""
            )
        )
        if not target_fingerprint:
            raise MonitorError(
                "REPLY_TARGET_REQUIRED",
                "A reply must identify exactly one source message as its target.",
            )
        supplied_anchor = parse_reply_anchor(args.reply_anchor_evidence)
        persisted_anchor = None
        if persisted is not None:
            persisted_draft = (persisted.get("drafts") or {}).get(args.draft_id) or {}
            persisted_anchor = persisted_draft.get("reply_anchor_evidence")
        anchor = (
            require_reply_anchor(supplied_anchor, target_fingerprint, getattr(args, "reply_strategy", "specific_message"))
            if not args.resume_sent_fingerprint
            else supplied_anchor or persisted_anchor
        )
        state = approved_state(
            args,
            preflight_messages,
            existing_state=persisted,
            reply_anchor_evidence=anchor,
        )
        if state_store is not None:
            state_store.save(state, reason="monitor_preflight_context")
        window = preflight.get("window") or {}
        validate_point("composer", args.composer_x, args.composer_y, window)
        validate_point("send", args.send_x, args.send_y, window)
        sent_fingerprint: str | None = args.resume_sent_fingerprint
        if sent_fingerprint:
            observed = {str(message.get("message_fingerprint") or "") for message in preflight_messages}
            if sent_fingerprint not in observed:
                raise MonitorError(
                    "SENT_MESSAGE_NOT_REOBSERVED",
                    "The caller-proven sent message fingerprint is not visible in the resumed conversation.",
                )
            attempt = (state.get("send_ledger") or {}).get(args.idempotency_key)
            if state_store is not None and attempt is None:
                raise MonitorError(
                    "SEND_ATTEMPT_NOT_PERSISTED",
                    "Resuming requires the original persisted send attempt; no new send is allowed.",
                )
            if attempt is None:
                # Legacy in-memory resume mode remains available for callers
                # that have separately proven the send and intentionally did
                # not opt into durable checkpoints.
                attempt = {
                    "attempt_id": args.idempotency_key,
                    "idempotency_key": args.idempotency_key,
                    "conversation_key": args.conversation_key,
                    "reply_to_message_fingerprints": list(args.source_fingerprint),
                    "reply_target_message_fingerprint": target_fingerprint,
                    "draft_id": args.draft_id,
                    "draft_version": args.draft_version,
                    "exact_text": args.exact_text,
                    "status": "sent_verified",
                }
                state["send_ledger"][args.idempotency_key] = attempt
            elif attempt.get("status") != "sent_verified":
                state = record_send_observation(
                    state,
                    args.idempotency_key,
                    verified=True,
                    evidence={"mode": "caller_proven", "message_fingerprint": sent_fingerprint},
                )
                state = advance_reply_cursor(state, args.idempotency_key)
                attempt = state["send_ledger"][args.idempotency_key]
            if state_store is not None:
                state_store.save(state, reason="resume_sent_evidence")
            sent_at = time.monotonic()
            emit(
                "monitor_resumed",
                draft_id=args.draft_id,
                idempotency_key=args.idempotency_key,
                sent_message_fingerprint=sent_fingerprint,
                wait_before_observe_seconds=args.interval_seconds,
            )
        else:
            state, attempt = prepare_send(
                state,
                args.draft_id,
                observed_conversation_key=args.conversation_key,
                observed_message_fingerprints=[
                    str(message.get("message_fingerprint")) for message in preflight_messages
                ],
                reply_target_message_fingerprint=target_fingerprint,
                reply_anchor_evidence=anchor,
                reply_strategy=getattr(args, "reply_strategy", "specific_message"),
            )
            if state_store is not None:
                state_store.save(state, reason="send_preflight_verified")
            emit(
                "preflight_verified",
                draft_id=args.draft_id,
                idempotency_key=attempt["idempotency_key"],
                source_count=len(args.source_fingerprint),
                reply_target_message_fingerprint=target_fingerprint,
                reply_anchor_evidence=anchor,
                reply_strategy=getattr(args, "reply_strategy", "specific_message"),
                capture_layer=(preflight.get("screenshot") or {}).get("capture_layer"),
            )
            state = begin_send(state, attempt["idempotency_key"])
            if state_store is not None:
                # Write-ahead checkpoint: a crash after any input action must
                # resume observation instead of creating a second send attempt.
                state_store.save(state, reason="send_write_ahead")
            host.request(
                "input.click",
                {
                    "window_id": window["window_id"],
                    "screenshot_id": preflight["screenshot"]["screenshot_id"],
                    "x": args.composer_x,
                    "y": args.composer_y,
                    "action_label": "聚焦消息输入框",
                },
            )
            host.request(
                "input.type",
                {
                    "window_id": window["window_id"],
                    "text": args.exact_text,
                    "action_label": "填写已批准消息",
                },
            )
            fresh = host.request("screen.capture", {"window_id": window["window_id"]})
            host.request(
                "input.click",
                {
                    "window_id": window["window_id"],
                    "screenshot_id": fresh["screenshot"]["screenshot_id"],
                    "x": args.send_x,
                    "y": args.send_y,
                    "action_label": "发送已批准消息",
                },
            )
            if state_store is not None:
                state_store.save(state, reason="send_invoked")
            sent_at = time.monotonic()
            emit("send_invoked", draft_id=args.draft_id, wait_before_observe_seconds=args.interval_seconds)

        next_observation = sent_at + args.interval_seconds
        deadline = sent_at + args.duration_seconds
        observation_number = 0
        while True:
            now = time.monotonic()
            if now >= deadline:
                break
            time.sleep(max(0.0, min(next_observation, deadline) - now))
            if time.monotonic() >= deadline and next_observation > deadline:
                break
            observation_number += 1
            result, messages = observe(host, args)
            state = update_snapshot(
                state,
                {
                    "conversation_key": args.conversation_key,
                    "conversation_binding": {
                        "target": target_params(args),
                        "expected_identity": list(args.expected_identity),
                        "identity_match": args.identity_match,
                    },
                    "collection_cursor": {
                        "message_fingerprint": messages[-1].get("message_fingerprint") if messages else None,
                    },
                    "messages": messages,
                },
            )
            if state_store is not None:
                state_store.save(state, reason=f"monitor_observation_{observation_number}")
            if sent_fingerprint is None:
                verification = sent_message_evidence(
                    messages,
                    args.exact_text,
                    preflight_fingerprints,
                )
                sent_fingerprint = verification.get("message_fingerprint")
                state = record_send_observation(
                    state,
                    attempt["idempotency_key"],
                    verified=bool(verification.get("verified")),
                    evidence=verification,
                )
                if state_store is not None:
                    state_store.save(state, reason="send_observation")
                if sent_fingerprint is not None:
                    state = advance_reply_cursor(state, attempt["idempotency_key"])
                    if state_store is not None:
                        state_store.save(state, reason="reply_cursor_advanced")
                    emit(
                        "send_verified",
                        draft_id=args.draft_id,
                        message_fingerprint=sent_fingerprint,
                        verification_mode=verification.get("mode"),
                    )

            incremental = incremental_slice(messages, sent_fingerprint) if sent_fingerprint else {
                "status": "send_not_visible",
                "messages": [],
            }
            new_replies: list[dict[str, Any]] = []
            for message in incremental.get("messages") or []:
                fingerprint = str(message.get("message_fingerprint") or "")
                if not fingerprint or fingerprint in seen_record_fingerprints:
                    continue
                seen_record_fingerprints.add(fingerprint)
                if message.get("direction") != "incoming" or message.get("content_kind") in {"system", "timestamp"}:
                    continue
                seen_reply_fingerprints.add(fingerprint)
                new_replies.append(
                    {
                        "message_fingerprint": fingerprint,
                        "sender": message.get("sender"),
                        "direction": message.get("direction"),
                        "content_kind": message.get("content_kind"),
                        "content": message.get("content"),
                        "confidence_level": message.get("confidence_level"),
                    }
                )
            emit(
                "observation",
                number=observation_number,
                elapsed_seconds=int(time.monotonic() - sent_at),
                send_status=state["send_ledger"][attempt["idempotency_key"]]["status"],
                incremental_status=incremental.get("status"),
                new_reply_count=len(new_replies),
                new_replies=new_replies,
                capture_layer=(result.get("screenshot") or {}).get("capture_layer"),
            )
            next_observation += args.interval_seconds

        emit(
            "monitor_complete",
            elapsed_seconds=int(time.monotonic() - sent_at),
            observation_count=observation_number,
            unique_reply_count=len(seen_reply_fingerprints),
            send_status=state["send_ledger"][attempt["idempotency_key"]]["status"],
        )
        return 0
    except KeyboardInterrupt:
        cancel_requested = True
        if state_store is not None and state is not None:
            state_store.save(state, reason="monitor_cancelled")
        emit("monitor_cancelled", reason="keyboard_interrupt")
        return 130
    except (DeskPilotError, MonitorError, MessagingStateError) as exc:
        if getattr(exc, "code", None) in {"CONTEXT_IDENTITY_MISMATCH", "WINDOW_IDENTITY_MISMATCH"}:
            cancel_requested = True
            if state_store is not None and state is not None:
                state = mark_user_takeover(state)
                state_store.save(state, reason="conversation_identity_drift")
        emit(
            "monitor_failed",
            code=getattr(exc, "code", type(exc).__name__),
            message=str(exc),
            details=getattr(exc, "details", None),
            send_attempted=sent_at is not None,
        )
        return 2
    finally:
        if interaction_id:
            try:
                method = "interaction.cancel" if cancel_requested or sent_at is None else "interaction.end"
                ended = host.request(method, {"interaction_id": interaction_id})
                activity = ended.get("interaction") or {}
                emit(
                    "activity_closed",
                    method=method,
                    restored_original_window=activity.get("restored_original_window"),
                    cleanup_errors=activity.get("cleanup_errors"),
                )
            except BaseException as exc:
                emit("activity_close_failed", message=str(exc))
        host.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", type=Path, required=True)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--process")
    target.add_argument("--title-contains")
    target.add_argument("--title-exact")
    parser.add_argument("--expected-identity", action="append", required=True)
    parser.add_argument("--locator-text", action="append", default=[])
    parser.add_argument("--identity-match", choices=("all", "any"), default="all")
    parser.add_argument("--identity-region", type=parse_region, required=True)
    parser.add_argument("--content-region", type=parse_region, required=True)
    parser.add_argument("--conversation-key", required=True)
    parser.add_argument("--source-fingerprint", action="append", required=True)
    parser.add_argument(
        "--reply-strategy",
        choices=("specific_message", "conversation_turn"),
        default="specific_message",
        help="specific_message for group/quoted replies; conversation_turn batches one private-chat turn",
    )
    parser.add_argument(
        "--reply-target-fingerprint",
        help="Exact observed message fingerprint that this reply addresses (defaults only when one source is supplied)",
    )
    parser.add_argument(
        "--reply-anchor-evidence",
        required=False,
        help="JSON evidence from the generic adapter proving the UI is anchored to the exact reply target",
    )
    parser.add_argument("--draft-id", required=True)
    parser.add_argument("--draft-version", type=int, required=True)
    parser.add_argument("--exact-text", required=True)
    parser.add_argument("--resume-sent-fingerprint")
    parser.add_argument("--idempotency-key")
    parser.add_argument("--composer-x", type=int, required=True)
    parser.add_argument("--composer-y", type=int, required=True)
    parser.add_argument("--send-x", type=int, required=True)
    parser.add_argument("--send-y", type=int, required=True)
    parser.add_argument(
        "--state-path",
        type=Path,
        help="Explicit caller-owned JSON checkpoint; enables crash-safe full structured-context persistence",
    )
    parser.add_argument("--duration-seconds", type=int, default=3600)
    parser.add_argument("--interval-seconds", type=int, default=30)
    parser.add_argument("--show-action-trace", action="store_true")
    parser.set_defaults(settle_ms=350)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.cli.is_file():
        parser.error("--cli must identify an existing DeskPilot executable")
    if args.draft_version < 1:
        parser.error("--draft-version must be positive")
    if not 30 <= args.duration_seconds <= 3600:
        parser.error("--duration-seconds must be between 30 and 3600")
    if not 5 <= args.interval_seconds <= 300:
        parser.error("--interval-seconds must be between 5 and 300")
    if args.resume_sent_fingerprint and not args.idempotency_key:
        parser.error("--idempotency-key is required with --resume-sent-fingerprint")
    if not args.resume_sent_fingerprint and not args.reply_anchor_evidence:
        parser.error("--reply-anchor-evidence is required unless resuming a separately verified send")
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
