#!/usr/bin/env python3
"""Run one bounded WeChat group observation or verified specific-message reply."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


MESSAGING_SCRIPTS = Path(__file__).resolve().parents[2] / "deskpilot-messaging" / "scripts"
sys.path.insert(0, str(MESSAGING_SCRIPTS))

from collect_messages import DeskPilotError, DeskPilotHost, conversation_key, parse_region  # noqa: E402
from conversation_state import (  # noqa: E402
    MessagingStateError,
    advance_reply_cursor,
    approve_draft,
    begin_send,
    create_conversation_state,
    prepare_send,
    record_send_observation,
    register_draft,
    update_snapshot,
)
from conversation_state_store import ConversationStateStore  # noqa: E402
from message_structure import finalize_timeline, group_page_candidates, normalize_text  # noqa: E402


class WeChatWaveError(RuntimeError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        self.code = code
        self.details = details
        super().__init__(message)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def target_params(args: argparse.Namespace) -> dict[str, Any]:
    return {"process": args.process}


def center(candidate: dict[str, Any]) -> tuple[int, int]:
    bounds = candidate.get("bounds") or {}
    return (
        int(bounds.get("x", 0)) + max(1, int(bounds.get("width", 1))) // 2,
        int(bounds.get("y", 0)) + max(1, int(bounds.get("height", 1))) // 2,
    )


def inside(candidate: dict[str, Any], region: dict[str, int]) -> bool:
    x, y = center(candidate)
    return (
        region["x"] <= x <= region["x"] + region["width"]
        and region["y"] <= y <= region["y"] + region["height"]
    )


def find_unique_text(
    candidates: list[dict[str, Any]],
    expected: str,
    *,
    region: dict[str, int] | None = None,
    code: str,
) -> dict[str, Any]:
    wanted = normalize_text(expected)
    matches = []
    for candidate in candidates:
        observed = normalize_text(str(candidate.get("text") or ""))
        if region is not None and not inside(candidate, region):
            continue
        if observed == wanted or (wanted and observed and (wanted in observed or observed in wanted) and abs(len(wanted) - len(observed)) <= 2):
            matches.append(candidate)
    if len(matches) != 1:
        raise WeChatWaveError(
            code,
            f"Expected one visible {expected!r} candidate, found {len(matches)}.",
            {"match_count": len(matches)},
        )
    return matches[0]


def wait_semantic(
    operation: Callable[[], Any],
    *,
    timeout_ms: int,
    poll_ms: int,
    retry_codes: set[str],
) -> Any:
    deadline = time.monotonic() + max(0, timeout_ms) / 1000
    while True:
        try:
            return operation()
        except (DeskPilotError, WeChatWaveError) as exc:
            if getattr(exc, "code", "") not in retry_codes or time.monotonic() >= deadline:
                raise
            time.sleep(min(max(1, poll_ms) / 1000, max(0, deadline - time.monotonic())))


def observe_group(host: DeskPilotHost, args: argparse.Namespace, region: dict[str, int] | None = None) -> dict[str, Any]:
    result = host.request(
        "messages.observe",
        target_params(args)
        | {
            "expected_identity": [args.group_title],
            "identity_match": "all",
            "identity_region": args.identity_region,
            "content_region": region or args.content_region,
            "action_label": "读取微信群消息",
        },
    )
    if not (result.get("screenshot") or {}).get("trusted"):
        raise WeChatWaveError("WINDOW_CAPTURE_UNTRUSTED", "WeChat capture was not trusted.")
    if not (result.get("context_identity") or {}).get("matched"):
        raise WeChatWaveError("CONTEXT_IDENTITY_MISMATCH", "The exact WeChat group was not proven.")
    return result


def recover_group(host: DeskPilotHost, args: argparse.Namespace) -> dict[str, Any]:
    host.request("windows.activate", target_params(args) | {"action_label": "进入微信"})
    host.request("input.hotkey", target_params(args) | {"key": "CTRL+F", "action_label": "打开微信搜索"})
    host.request("input.hotkey", target_params(args) | {"key": "CTRL+A", "action_label": "选择搜索内容"})
    host.request(
        "input.type",
        target_params(args) | {"text": args.group_title, "confirmed": True, "action_label": "输入精确群名"},
    )

    def read_result() -> tuple[dict[str, Any], dict[str, Any]]:
        page = host.request(
            "messages.observe",
            target_params(args)
            | {"content_region": args.search_result_region, "action_label": "确认唯一群聊结果"},
        )
        match = find_unique_text(
            page.get("message_candidates") or [],
            args.group_title,
            region=args.search_result_region,
            code="WECHAT_SEARCH_RESULT_NOT_UNIQUE",
        )
        return page, match

    page, match = wait_semantic(
        read_result,
        timeout_ms=args.wait_timeout_ms,
        poll_ms=args.poll_ms,
        retry_codes={"WECHAT_SEARCH_RESULT_NOT_UNIQUE"},
    )
    x, y = center(match)
    host.request(
        "input.click",
        target_params(args)
        | {
            "screenshot_id": str((page.get("screenshot") or {}).get("screenshot_id") or ""),
            "x": x,
            "y": y,
            "action_label": "进入目标微信群",
        },
    )
    return wait_semantic(
        lambda: observe_group(host, args),
        timeout_ms=args.wait_timeout_ms,
        poll_ms=args.poll_ms,
        retry_codes={"CONTEXT_IDENTITY_MISMATCH"},
    )


def acquire_group(host: DeskPilotHost, args: argparse.Namespace) -> tuple[dict[str, Any], bool]:
    host.request("windows.activate", target_params(args) | {"action_label": "进入微信"})
    try:
        return observe_group(host, args), False
    except DeskPilotError as exc:
        if exc.code != "CONTEXT_IDENTITY_MISMATCH":
            raise
    return recover_group(host, args), True


def structured_messages(page: dict[str, Any], region: dict[str, int]) -> list[dict[str, Any]]:
    return finalize_timeline(
        group_page_candidates(
            page.get("message_candidates") or [],
            region,
            1,
            voice_candidates=page.get("voice_candidates") or [],
        )
    )


def snapshot_for(args: argparse.Namespace, messages: list[dict[str, Any]]) -> dict[str, Any]:
    key = args.conversation_key or conversation_key(
        argparse.Namespace(
            process=args.process,
            title_contains=None,
            title_exact=None,
            expected_identity=[args.group_title],
            identity_match="all",
        )
    )
    return {
        "conversation_key": key,
        "conversation_binding": {
            "target": target_params(args),
            "expected_identity": [args.group_title],
            "identity_match": "all",
            "identity_region": args.identity_region,
            "content_region": args.content_region,
        },
        "collection_cursor": {"message_fingerprint": messages[-1]["message_fingerprint"]} if messages else {},
        "messages": messages,
    }


def checkpoint_observation(
    args: argparse.Namespace,
    messages: list[dict[str, Any]],
) -> tuple[ConversationStateStore, dict[str, Any], list[dict[str, Any]]]:
    store = ConversationStateStore(args.state_path)
    existing = store.load()
    new_messages = visible_new_messages(messages, existing)
    snapshot = snapshot_for(args, messages)
    if existing is not None:
        binding = existing.get("conversation_binding") or {}
        stored_target = binding.get("target") or {}
        stored_identities = [normalize_text(str(value)) for value in binding.get("expected_identity") or []]
        if (
            normalize_text(str(stored_target.get("process") or "")) != normalize_text(args.process)
            or normalize_text(args.group_title) not in stored_identities
        ):
            raise WeChatWaveError(
                "CONVERSATION_IDENTITY_CHANGED",
                "The state file belongs to another process or WeChat group.",
            )
        # Conversation-key derivation has evolved. The proven binding is the
        # compatibility gate; keep the established key so older checkpoints
        # remain resumable and their send ledger keeps protecting idempotency.
        snapshot["conversation_key"] = existing["conversation_key"]
    state = update_snapshot(existing, snapshot) if existing is not None else create_conversation_state(snapshot)
    store.save(state, reason="wechat_group_wave_observed")
    return store, state, new_messages


def initial_participation_verified(state: dict[str, Any]) -> bool:
    progress = (state.get("scenario_progress") or {}).get("initial_participation") or {}
    if progress.get("status") == "sent_verified":
        return True
    return any(attempt.get("status") == "sent_verified" for attempt in (state.get("send_ledger") or {}).values())


def visible_new_messages(messages: list[dict[str, Any]], existing: dict[str, Any] | None) -> list[dict[str, Any]]:
    if existing is None:
        return []
    unmatched = list((existing.get("observed_messages") or {}).values())
    result = []
    for message in messages:
        observed = normalize_text(str(message.get("content") or ""))
        best_index = None
        best_ratio = 0.0
        for index, prior in enumerate(unmatched):
            if prior.get("content_kind") != message.get("content_kind"):
                continue
            old = normalize_text(str(prior.get("content") or ""))
            ratio = difflib.SequenceMatcher(None, observed, old).ratio() if observed and old else 0.0
            if observed == old or (min(len(observed), len(old)) >= 6 and (observed in old or old in observed)):
                ratio = 1.0
            if ratio > best_ratio:
                best_ratio = ratio
                best_index = index
        if best_index is not None and best_ratio >= 0.82:
            unmatched.pop(best_index)
        else:
            result.append(message)
    return result


def select_source(
    messages: list[dict[str, Any]],
    *,
    source_text: str | None,
    source_fingerprint: str | None,
    maximum_anchor_y: int,
) -> dict[str, Any]:
    matches = []
    wanted = normalize_text(source_text or "")
    explicit_source = bool(wanted or source_fingerprint)
    for message in messages:
        if message.get("direction") != "incoming" or message.get("content_kind") != "text":
            continue
        if int((message.get("bounds") or {}).get("y", 0)) > maximum_anchor_y:
            continue
        if source_fingerprint and message.get("message_fingerprint") != source_fingerprint:
            continue
        observed = normalize_text(str(message.get("content") or ""))
        fuzzy_ratio = difflib.SequenceMatcher(None, wanted, observed).ratio() if wanted and observed else 0.0
        if wanted and not (wanted == observed or wanted in observed or observed in wanted or fuzzy_ratio >= 0.82):
            continue
        # Short chat replies such as "可以" are valid only when the caller
        # explicitly identifies them and the current observation proves one
        # unique match. Automatic source selection keeps the stronger length
        # floor so generic OCR fragments such as "0" are never chosen.
        if len(observed) >= (1 if explicit_source else 3):
            matches.append(message)
    if not matches:
        raise WeChatWaveError("WECHAT_REPLY_SOURCE_NOT_VISIBLE", "No safe visible incoming source message matched the reply request.")
    if source_text or source_fingerprint:
        if len(matches) != 1:
            raise WeChatWaveError("WECHAT_REPLY_SOURCE_NOT_UNIQUE", "The requested source message was ambiguous.")
        return matches[0]
    return matches[-1]


def quote_preview_matches(candidates: list[dict[str, Any]], source_text: str) -> bool:
    wanted = normalize_text(source_text)
    fragment_length = min(6, len(wanted))
    fragments = {
        wanted[index : index + fragment_length]
        for index in range(max(1, len(wanted) - fragment_length + 1))
        if fragment_length >= 4
    }
    for candidate in candidates:
        observed = normalize_text(str(candidate.get("text") or ""))
        if len(observed) >= 4 and (
            observed in wanted
            or wanted in observed
            or any(fragment in observed for fragment in fragments)
        ):
            return True
    return False


def reply_fragment_strength(observed_text: str, reply_text: str) -> int:
    observed = normalize_text(observed_text)
    wanted = normalize_text(reply_text)
    if not observed or not wanted:
        return 0
    if observed in wanted or wanted in observed:
        return min(len(observed), len(wanted))
    return max((block.size for block in difflib.SequenceMatcher(None, observed, wanted).get_matching_blocks()), default=0)


def find_new_outgoing(
    messages: list[dict[str, Any]],
    reply_text: str,
    old_fingerprints: set[str],
    content_region: dict[str, int],
) -> dict[str, Any] | None:
    wanted = normalize_text(reply_text)
    matches: list[tuple[int, dict[str, Any]]] = []
    right_edge_gate = content_region["x"] + int(content_region["width"] * 0.76)
    for message in messages:
        if message.get("message_fingerprint") in old_fingerprints:
            continue
        observed = normalize_text(str(message.get("content") or ""))
        bounds = message.get("bounds") or {}
        right_edge = int(bounds.get("x", 0)) + int(bounds.get("width", 0))
        geometry_proves_outgoing = right_edge >= right_edge_gate
        strength = reply_fragment_strength(observed, wanted)
        if len(observed) >= 8 and strength >= 8 and (message.get("direction") == "outgoing" or geometry_proves_outgoing):
            matches.append((strength, message))
    if not matches:
        return None
    matches.sort(key=lambda item: (item[0], int((item[1].get("bounds") or {}).get("y", 0))), reverse=True)
    return matches[0][1]


def append_experience(args: argparse.Namespace, *, started: float, recovered: bool, status: str, sent: bool) -> None:
    if not args.experience_path:
        return
    path = Path(args.experience_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": utc_now(),
        "conversation_hash": hashlib.sha256(args.group_title.encode("utf-8")).hexdigest()[:16],
        "duration_ms": int((time.monotonic() - started) * 1000),
        "conversation_recovered": recovered,
        "status": status,
        "sent": sent,
        "enhancement_classification": "none",
    }
    with path.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")


def run(args: argparse.Namespace) -> dict[str, Any]:
    started = time.monotonic()
    host = DeskPilotHost(args.cli.resolve())
    interaction_started = False
    recovered = False
    status = "error"
    sent = False
    try:
        host.request(
            "interaction.begin",
            {
                "activity_label": "AGENT 微信群助手执行中",
                "show_overlay": True,
                "show_action_trace": args.show_action_trace,
                "restore_original_window": True,
            },
        )
        interaction_started = True
        page, recovered = acquire_group(host, args)
        messages = structured_messages(page, args.content_region)
        store, state, new_messages = checkpoint_observation(args, messages)

        if args.operation == "observe":
            status = "observed"
            return {
                "status": status,
                "group_identity_verified": True,
                "conversation_recovered": recovered,
                "message_count": len(messages),
                "new_message_count": len(new_messages),
                "initial_participation_verified": initial_participation_verified(state),
                "messages": [
                    {
                        "message_fingerprint": item.get("message_fingerprint"),
                        "direction": item.get("direction"),
                        "content_kind": item.get("content_kind"),
                        "content": item.get("content"),
                        "bounds": item.get("bounds"),
                    }
                    for item in messages
                ],
                "state_path": str(Path(args.state_path).resolve()),
                "duration_ms": int((time.monotonic() - started) * 1000),
            }

        if args.operation == "reconcile":
            uncertain = [
                attempt
                for attempt in (state.get("send_ledger") or {}).values()
                if attempt.get("status") == "send_uncertain"
            ]
            if len(uncertain) != 1:
                raise WeChatWaveError(
                    "WECHAT_UNCERTAIN_SEND_NOT_UNIQUE",
                    f"Expected one uncertain send attempt, found {len(uncertain)}.",
                )
            attempt = uncertain[0]
            outgoing = find_new_outgoing(messages, str(attempt.get("exact_text") or ""), set(), args.content_region)
            if outgoing is None:
                raise WeChatWaveError(
                    "WECHAT_SEND_STILL_UNCERTAIN",
                    "No unique sufficiently long right-aligned fragment proves the uncertain send.",
                )
            state = record_send_observation(
                state,
                attempt["idempotency_key"],
                verified=True,
                evidence={
                    "mode": "atomic_exact_input_plus_post_send_fragment",
                    "message_fingerprint": outgoing["message_fingerprint"],
                    "fragment_strength": reply_fragment_strength(str(outgoing.get("content") or ""), str(attempt.get("exact_text") or "")),
                },
            )
            state = advance_reply_cursor(state, attempt["idempotency_key"])
            progress = dict(state.get("scenario_progress") or {})
            progress[args.participation_kind] = {
                "status": "sent_verified",
                "idempotency_key": attempt["idempotency_key"],
                "verified_at": utc_now(),
            }
            state["scenario_progress"] = progress
            store.save(state, reason=f"wechat_{args.participation_kind}_reconciled_sent_verified")
            status = "sent_verified"
            sent = True
            return {
                "status": status,
                "operation": "reconcile",
                "group_identity_verified": True,
                "input_repeated": False,
                "send_verified": True,
                "idempotency_key": attempt["idempotency_key"],
                "outgoing_message_fingerprint": outgoing["message_fingerprint"],
                "state_path": str(Path(args.state_path).resolve()),
                "duration_ms": int((time.monotonic() - started) * 1000),
            }

        if not args.authorized:
            raise WeChatWaveError("SEND_AUTHORIZATION_REQUIRED", "A reply requires --authorized with the exact reply text.")
        if not args.reply_text.startswith(args.disclosure):
            raise WeChatWaveError("DISCLOSURE_REQUIRED", "The exact reply must start with the configured disclosure.")
        if args.participation_kind == "initial_participation" and initial_participation_verified(state):
            raise WeChatWaveError("INITIAL_PARTICIPATION_ALREADY_VERIFIED", "The initial participation was already sent and verified.")

        source = select_source(
            messages,
            source_text=args.reply_source_text,
            source_fingerprint=args.reply_source_fingerprint,
            maximum_anchor_y=args.maximum_anchor_y,
        )
        source_x, source_y = center(source)
        host.request(
            "input.right_click",
            target_params(args)
            | {
                "screenshot_id": str((page.get("screenshot") or {}).get("screenshot_id") or ""),
                "x": source_x,
                "y": source_y,
                "action_label": "打开具体消息菜单",
            },
        )

        def read_quote_action() -> tuple[dict[str, Any], dict[str, Any]]:
            menu = observe_group(host, args, args.menu_region)
            action = find_unique_text(
                menu.get("message_candidates") or [],
                args.quote_label,
                region=args.menu_region,
                code="WECHAT_QUOTE_ACTION_NOT_UNIQUE",
            )
            return menu, action

        menu, quote_action = wait_semantic(
            read_quote_action,
            timeout_ms=args.wait_timeout_ms,
            poll_ms=args.poll_ms,
            retry_codes={"WECHAT_QUOTE_ACTION_NOT_UNIQUE"},
        )
        quote_x, quote_y = center(quote_action)
        host.request(
            "input.click",
            target_params(args)
            | {
                "screenshot_id": str((menu.get("screenshot") or {}).get("screenshot_id") or ""),
                "x": quote_x,
                "y": quote_y,
                "action_label": "引用具体消息",
            },
        )

        def read_quote_preview() -> dict[str, Any]:
            preview = observe_group(host, args, args.composer_region)
            if not quote_preview_matches(preview.get("message_candidates") or [], str(source.get("content") or "")):
                raise WeChatWaveError(
                    "WECHAT_QUOTE_PREVIEW_UNPROVEN",
                    "The composer quote preview did not prove the source message.",
                    {
                        "observed": [
                            str(candidate.get("text") or "")
                            for candidate in preview.get("message_candidates") or []
                        ]
                    },
                )
            return preview

        preview = wait_semantic(
            read_quote_preview,
            timeout_ms=args.wait_timeout_ms,
            poll_ms=args.poll_ms,
            retry_codes={"WECHAT_QUOTE_PREVIEW_UNPROVEN"},
        )
        anchor = {
            "status": "verified",
            "mode": "wechat_quote_preview",
            "message_fingerprint": source["message_fingerprint"],
        }
        state, draft = register_draft(
            state,
            reply_to_message_fingerprints=[source["message_fingerprint"]],
            reply_target_message_fingerprint=source["message_fingerprint"],
            reply_anchor_evidence=anchor,
            basis_summary=args.basis_summary,
            exact_text=args.reply_text,
            style_profile_version=args.style_profile_version,
            reply_strategy="specific_message",
        )
        state = approve_draft(state, draft["draft_id"], args.reply_text)
        state, attempt = prepare_send(
            state,
            draft["draft_id"],
            observed_conversation_key=state["conversation_key"],
            observed_message_fingerprints=[item["message_fingerprint"] for item in messages],
            reply_target_message_fingerprint=source["message_fingerprint"],
            reply_anchor_evidence=anchor,
            reply_strategy="specific_message",
        )
        store.save(state, reason="wechat_reply_preflight_verified")
        state = begin_send(state, attempt["idempotency_key"])
        store.save(state, reason="wechat_reply_send_started")

        host.request(
            "input.click",
            target_params(args)
            | {
                "screenshot_id": str((preview.get("screenshot") or {}).get("screenshot_id") or ""),
                "x": args.composer_x,
                "y": args.composer_y,
                "action_label": "聚焦群聊输入框",
            },
        )
        typed = host.request(
            "input.type",
            target_params(args) | {"text": args.reply_text, "confirmed": True, "action_label": "输入已授权回复"},
        )
        if int((typed.get("data") or {}).get("text_length", -1)) != len(args.reply_text):
            raise WeChatWaveError("WECHAT_INPUT_LENGTH_MISMATCH", "DeskPilot did not confirm the exact authorized input length.")
        host.request(
            "input.key",
            target_params(args) | {"key": "ENTER", "confirmed": True, "action_label": "发送一次回复"},
        )
        old_fingerprints = {item["message_fingerprint"] for item in messages}

        def read_sent() -> tuple[dict[str, Any], dict[str, Any]]:
            after = observe_group(host, args)
            after_messages = structured_messages(after, args.content_region)
            outgoing = find_new_outgoing(after_messages, args.reply_text, old_fingerprints, args.content_region)
            if outgoing is None:
                raise WeChatWaveError("WECHAT_SEND_NOT_YET_VERIFIED", "The new outgoing reply is not yet visible.")
            return after, outgoing

        try:
            after, outgoing = wait_semantic(
                read_sent,
                timeout_ms=args.send_verify_timeout_ms,
                poll_ms=args.poll_ms,
                retry_codes={"WECHAT_SEND_NOT_YET_VERIFIED"},
            )
        except WeChatWaveError:
            state = record_send_observation(
                state,
                attempt["idempotency_key"],
                verified=None,
                evidence={"mode": "post_send_observation", "status": "uncertain"},
            )
            store.save(state, reason="wechat_reply_send_uncertain")
            raise

        state = record_send_observation(
            state,
            attempt["idempotency_key"],
            verified=True,
            evidence={"mode": "post_send_outgoing_ocr", "message_fingerprint": outgoing["message_fingerprint"]},
        )
        state = advance_reply_cursor(state, attempt["idempotency_key"])
        progress = dict(state.get("scenario_progress") or {})
        progress[args.participation_kind] = {
            "status": "sent_verified",
            "idempotency_key": attempt["idempotency_key"],
            "verified_at": utc_now(),
        }
        state["scenario_progress"] = progress
        store.save(state, reason=f"wechat_{args.participation_kind}_sent_verified")
        status = "sent_verified"
        sent = True
        return {
            "status": status,
            "group_identity_verified": True,
            "conversation_recovered": recovered,
            "participation_kind": args.participation_kind,
            "reply_anchor_verified": True,
            "send_verified": True,
            "idempotency_key": attempt["idempotency_key"],
            "outgoing_message_fingerprint": outgoing["message_fingerprint"],
            "state_path": str(Path(args.state_path).resolve()),
            "duration_ms": int((time.monotonic() - started) * 1000),
        }
    finally:
        append_experience(args, started=started, recovered=recovered, status=status, sent=sent)
        if interaction_started:
            try:
                host.request("interaction.end", {})
            except Exception:
                try:
                    host.request("interaction.cancel", {})
                except Exception:
                    pass
        host.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", type=Path, required=True)
    parser.add_argument("--process", default="Weixin")
    parser.add_argument("--group-title", required=True)
    parser.add_argument("--operation", choices=("observe", "reply", "reconcile"), default="observe")
    parser.add_argument("--identity-region", type=parse_region, default=parse_region("300,0,605,90"))
    parser.add_argument("--content-region", type=parse_region, default=parse_region("308,75,590,480"))
    parser.add_argument("--search-result-region", type=parse_region, default=parse_region("60,75,260,110"))
    parser.add_argument("--menu-region", type=parse_region, default=parse_region("300,180,500,500"))
    parser.add_argument("--composer-region", type=parse_region, default=parse_region("308,475,590,232"))
    parser.add_argument("--composer-x", type=int, default=600)
    parser.add_argument("--composer-y", type=int, default=610)
    parser.add_argument("--maximum-anchor-y", type=int, default=430)
    parser.add_argument("--quote-label", default="引用")
    parser.add_argument("--reply-source-text")
    parser.add_argument("--reply-source-fingerprint")
    parser.add_argument("--reply-text", default="")
    parser.add_argument("--disclosure", default="我是点点点小助手，代我和大家沟通。")
    parser.add_argument("--basis-summary", default="Caller-authorized low-risk WeChat group participation")
    parser.add_argument("--style-profile-version", default="wechat-group-v1")
    parser.add_argument("--participation-kind", choices=("initial_participation", "passive_response", "active_participation", "topic_initiation"), default="active_participation")
    parser.add_argument("--authorized", action="store_true")
    parser.add_argument("--wait-timeout-ms", type=int, default=1500)
    parser.add_argument("--send-verify-timeout-ms", type=int, default=2500)
    parser.add_argument("--poll-ms", type=int, default=75)
    parser.add_argument("--show-action-trace", action="store_true")
    parser.add_argument("--state-path", required=True)
    parser.add_argument("--experience-path")
    parser.add_argument("--conversation-key")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        print(json.dumps(run(args), ensure_ascii=True, separators=(",", ":")), flush=True)
        return 0
    except (DeskPilotError, MessagingStateError, WeChatWaveError) as exc:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error": {
                        "code": getattr(exc, "code", "WECHAT_GROUP_WAVE_FAILED"),
                        "message": str(exc),
                        "details": getattr(exc, "details", None),
                    },
                },
                ensure_ascii=True,
                separators=(",", ":"),
            ),
            file=sys.stderr,
            flush=True,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
