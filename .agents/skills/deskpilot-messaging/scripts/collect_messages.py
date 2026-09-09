#!/usr/bin/env python3
"""Bounded, application-agnostic DeskPilot desktop message collector."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from message_structure import (
    contains_history_marker,
    finalize_timeline,
    group_page_candidates,
    incremental_slice,
    locate_unread_boundary,
    merge_older_page,
    normalize_text,
)
from conversation_state import create_conversation_state, update_snapshot
from conversation_state_store import ConversationStateStore


class DeskPilotError(RuntimeError):
    def __init__(self, response: dict[str, Any]):
        error = response.get("error") or {}
        self.code = str(error.get("code") or "DESKPILOT_REQUEST_FAILED")
        self.retryable = bool(error.get("retryable", False))
        self.details = error.get("details")
        super().__init__(str(error.get("message") or self.code))

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": str(self),
            "retryable": self.retryable,
            "details": self.details,
        }


class CollectorError(RuntimeError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        self.code = code
        self.details = details
        super().__init__(message)

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": str(self), "retryable": False, "details": self.details}


class DeskPilotHost:
    def __init__(self, cli: Path):
        self._sequence = 0
        self._process = subprocess.Popen(
            [str(cli), "exec", "--stdin", "--format", "ndjson"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            bufsize=1,
            # Keep Ctrl+C on the orchestration process from killing the helper
            # before interaction.cancel can remove its cue and restore focus.
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )

    def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if self._process.stdin is None or self._process.stdout is None:
            raise RuntimeError("DeskPilot host pipes are unavailable.")
        self._sequence += 1
        request_id = f"msg-{self._sequence:04d}"
        payload = {"id": request_id, "method": method, "params": params}
        self._process.stdin.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        self._process.stdin.flush()
        line = self._process.stdout.readline()
        if not line:
            raise RuntimeError(f"DeskPilot host exited before responding to {request_id}.")
        response = json.loads(line)
        if response.get("request_id") != request_id:
            raise RuntimeError(f"Unexpected DeskPilot response id: {response.get('request_id')!r}.")
        if not response.get("ok"):
            raise DeskPilotError(response)
        return response.get("result") or {}

    def close(self) -> None:
        if self._process.stdin is not None and not self._process.stdin.closed:
            self._process.stdin.close()
        try:
            self._process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._process.kill()
            self._process.wait(timeout=2)


def parse_region(value: str) -> dict[str, int]:
    try:
        parts = [int(part.strip()) for part in value.split(",")]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("region values must be integers: x,y,width,height") from exc
    if len(parts) != 4 or parts[0] < 0 or parts[1] < 0 or parts[2] <= 0 or parts[3] <= 0:
        raise argparse.ArgumentTypeError("region must be x,y,width,height with positive width and height")
    return {"x": parts[0], "y": parts[1], "width": parts[2], "height": parts[3]}


def target_params(args: argparse.Namespace) -> dict[str, Any]:
    target: dict[str, Any] = {}
    if args.process:
        target["process"] = args.process
    if args.title_contains:
        target["title_contains"] = args.title_contains
    if args.title_exact:
        target["title_exact"] = args.title_exact
    return target


def conversation_key(args: argparse.Namespace) -> str:
    """Build a non-reversible key for this caller-asserted conversation."""
    payload = {
        "target": target_params(args),
        "expected_identity": list(args.expected_identity),
        "identity_match": args.identity_match,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "conversation-" + hashlib.sha256(encoded).hexdigest()[:24]


def observe_page(
    host: DeskPilotHost,
    args: argparse.Namespace,
    require_visible_identity: bool = True,
) -> dict[str, Any]:
    params = target_params(args)
    params.update(
        {
            "identity_region": args.identity_region,
            "content_region": args.content_region,
            "action_label": "读取可见消息",
        }
    )
    if require_visible_identity:
        params["expected_identity"] = args.expected_identity
        params["identity_match"] = args.identity_match
    return host.request("messages.observe", params)


def observe_page_with_identity_retry(
    host: DeskPilotHost,
    args: argparse.Namespace,
    allow_sequence_continuity: bool = False,
) -> tuple[dict[str, Any], int, str]:
    """Retry only transient visible-identity OCR mismatches on the same target."""
    retry_count = 0
    while True:
        try:
            return observe_page(host, args), retry_count, "visible_identity"
        except DeskPilotError as exc:
            if exc.code != "CONTEXT_IDENTITY_MISMATCH" or retry_count >= args.identity_retries:
                if exc.code == "CONTEXT_IDENTITY_MISMATCH" and allow_sequence_continuity:
                    page = observe_page(host, args, require_visible_identity=False)
                    return page, retry_count, "sequence_continuity_pending"
                raise
            retry_count += 1
            time.sleep(args.settle_ms / 1000)


def recover_initial_conversation(host: DeskPilotHost, args: argparse.Namespace) -> dict[str, Any]:
    if not args.locator_text:
        raise CollectorError(
            "INITIAL_CONTEXT_IDENTITY_MISMATCH",
            "Initial conversation identity did not match and no --locator-text was supplied.",
        )
    locate = host.request("messages.observe", target_params(args) | {"action_label": "定位目标会话"})
    matches: list[dict[str, Any]] = []
    locators = [normalize_text(value) for value in args.locator_text]
    for candidate in locate.get("message_candidates") or []:
        text = normalize_text(str(candidate.get("text") or ""))
        if text and any(locator in text or text in locator for locator in locators if len(locator) >= 3):
            matches.append(candidate)
    if len(matches) != 1:
        raise CollectorError(
            "CONVERSATION_LOCATOR_NOT_UNIQUE",
            f"Conversation locator matched {len(matches)} OCR candidates; exactly one is required.",
            {"match_count": len(matches), "locator_text": args.locator_text},
        )
    bounds = matches[0].get("bounds") or {}
    click_x = int(bounds.get("x", 0)) + max(1, int(bounds.get("width", 1)) // 2)
    click_y = int(bounds.get("y", 0)) + max(1, int(bounds.get("height", 1)) // 2)
    host.request(
        "input.click",
        {
            "window_id": locate["window"]["window_id"],
            "screenshot_id": locate["screenshot"]["screenshot_id"],
            "x": click_x,
            "y": click_y,
            "action_label": "切换目标会话",
        },
    )
    time.sleep(args.settle_ms / 1000)
    return observe_page(host, args)


def restore_scroll_position(
    host: DeskPilotHost,
    args: argparse.Namespace,
    window_id: str,
    scrolls_completed: int,
) -> dict[str, Any]:
    """Best-effort inverse scrolling using a fresh screenshot for each action."""
    for _ in range(scrolls_completed):
        capture = host.request("screen.capture", {"window_id": window_id})
        host.request(
            "input.scroll",
            {
                "window_id": window_id,
                "screenshot_id": str(capture["screenshot"]["screenshot_id"]),
                "x": args.scroll_x,
                "y": args.scroll_y,
                "amount": -args.scroll_amount,
                "action_label": "恢复消息位置",
            },
        )
        time.sleep(args.settle_ms / 1000)
    restored_page, _, _ = observe_page_with_identity_retry(host, args)
    return restored_page


def collect(args: argparse.Namespace) -> dict[str, Any]:
    cli = args.cli.resolve()
    if not cli.is_file():
        raise RuntimeError(f"DeskPilot CLI does not exist: {cli}")

    conversation_id = conversation_key(args)
    state_path = getattr(args, "state_path", None)
    state_store = ConversationStateStore(state_path) if state_path else None
    state = state_store.load(conversation_key=conversation_id) if state_store else None
    # A persisted cursor is the default incremental boundary. Callers can
    # still override it explicitly when they have a more recent checkpoint.
    if state and not getattr(args, "since_message_fingerprint", None):
        args.since_message_fingerprint = str(
            (state.get("snapshot_cursor") or {}).get("message_fingerprint") or ""
        ) or None
    checkpoint_info: dict[str, Any] | None = None

    def checkpoint(messages: list[dict[str, Any]], reason: str) -> None:
        nonlocal state, checkpoint_info
        if state_store is None:
            return
        snapshot = {
            "conversation_key": conversation_id,
            "conversation_binding": {
                "target": target_params(args),
                "expected_identity": list(args.expected_identity),
                "identity_match": args.identity_match,
            },
            "collection_cursor": {
                "message_fingerprint": messages[-1].get("message_fingerprint") if messages else None,
            },
            "messages": messages,
        }
        state = (
            update_snapshot(state, snapshot)
            if state is not None
            else create_conversation_state(snapshot)
        )
        checkpoint_info = state_store.save(state, reason=reason)

    host = DeskPilotHost(cli)
    interaction_id: str | None = None
    completion: dict[str, Any] | None = None
    collection_error: BaseException | None = None
    scrolls_completed = 0
    latest_window_id: str | None = None
    scroll_restore_attempted = False
    try:
        begun = host.request(
            "interaction.begin",
            {
                "label": "AGENT 采集消息中",
                "show_overlay": True,
                "show_action_trace": args.show_action_trace,
                "restore_original_window": True,
            },
        )
        interaction_id = str(begun["interaction"]["interaction_id"])

        try:
            page, page_identity_retries, page_identity_evidence = observe_page_with_identity_retry(host, args)
        except DeskPilotError as exc:
            if exc.code != "CONTEXT_IDENTITY_MISMATCH":
                raise
            page = recover_initial_conversation(host, args)
            page_identity_retries = 0
            page_identity_evidence = "visible_identity"

        timeline: list[dict[str, Any]] = []
        initial_page_messages: list[dict[str, Any]] = []
        raw_candidates: list[dict[str, Any]] = []
        page_summaries: list[dict[str, Any]] = []
        identity_visibility_mode = "visible_identity"
        consecutive_no_new = 0
        stopped_reason = "max_pages"
        latest_screenshot_id = str(page["screenshot"]["screenshot_id"])
        latest_window_id = str(page["window"]["window_id"])

        for page_number in range(1, args.max_pages + 1):
            candidates = page.get("message_candidates") or []
            for occurrence, candidate in enumerate(candidates, 1):
                raw_candidates.append(
                    {
                        "occurrence_id": f"p{page_number:03d}-candidate-{occurrence:04d}",
                        "page": page_number,
                        "text": candidate.get("text"),
                        "side": candidate.get("side"),
                        "role_hint": candidate.get("role_hint"),
                        "bounds": candidate.get("bounds"),
                    }
                )
            for occurrence, candidate in enumerate(page.get("voice_candidates") or [], 1):
                raw_candidates.append(
                    {
                        "occurrence_id": f"p{page_number:03d}-voice-{occurrence:04d}",
                        "page": page_number,
                        "text": None,
                        "content_kind": "voice",
                        "duration_ms": candidate.get("duration_ms"),
                        "side": candidate.get("side"),
                        "bounds": candidate.get("bounds"),
                    }
                )
            page_messages = group_page_candidates(
                candidates,
                args.content_region,
                page_number,
                voice_candidates=page.get("voice_candidates") or [],
            )
            if page_number == 1:
                timeline = page_messages
                initial_page_messages = list(page_messages)
                overlap_count = 0
                new_message_count = len(page_messages)
            else:
                timeline, overlap_count, new_message_count = merge_older_page(timeline, page_messages)
            if page_identity_evidence == "sequence_continuity_pending":
                if overlap_count < 2:
                    raise CollectorError(
                        "CONVERSATION_CONTINUITY_NOT_PROVEN",
                        "The conversation title is no longer visible and the page has no two-message boundary sequence anchor.",
                        {
                            "page": page_number,
                            "overlap_message_count": overlap_count,
                            "grouped_message_count": len(page_messages),
                        },
                    )
                page_identity_evidence = "sequence_continuity"
                identity_visibility_mode = "sequence_continuity"
            page_summaries.append(
                {
                    "page": page_number,
                    "candidate_count": len(candidates),
                    "grouped_message_count": len(page_messages),
                    "overlap_message_count": overlap_count,
                    "new_message_count": new_message_count,
                    "sequence_anchored": page_number == 1 or overlap_count >= 2,
                    "identity_matched": bool((page.get("context_identity") or {}).get("matched")),
                    "identity_evidence": page_identity_evidence,
                    "identity_retry_count": page_identity_retries,
                    "capture_layer": (page.get("screenshot") or {}).get("capture_layer"),
                    "trusted": bool((page.get("screenshot") or {}).get("trusted")),
                }
            )
            # Persist after every trusted observation. This is intentionally
            # before scrolling or any later action, so a crash resumes from
            # the last complete context instead of re-exploring the UI.
            checkpointed_timeline = finalize_timeline(timeline)
            checkpoint(checkpointed_timeline, f"observation_page_{page_number}")
            if getattr(args, "since_message_fingerprint", None) and any(
                message.get("message_fingerprint") == args.since_message_fingerprint
                for message in checkpointed_timeline
            ):
                stopped_reason = "since_cursor_reached"
                break
            if contains_history_marker(page_messages, args.history_start_text):
                stopped_reason = "history_start_marker"
                break
            consecutive_no_new = consecutive_no_new + 1 if new_message_count == 0 else 0
            if consecutive_no_new >= args.no_progress_pages:
                stopped_reason = "pages_without_new_messages"
                break
            if page_number >= args.max_pages:
                break

            host.request(
                "input.scroll",
                {
                    "window_id": latest_window_id,
                    "screenshot_id": latest_screenshot_id,
                    "x": args.scroll_x,
                    "y": args.scroll_y,
                    "amount": args.scroll_amount,
                    "action_label": "加载更早消息",
                },
            )
            scrolls_completed += 1
            time.sleep(args.settle_ms / 1000)
            if identity_visibility_mode == "visible_identity":
                page, page_identity_retries, page_identity_evidence = observe_page_with_identity_retry(
                    host,
                    args,
                    allow_sequence_continuity=True,
                )
            else:
                page = observe_page(host, args, require_visible_identity=False)
                page_identity_retries = 0
                page_identity_evidence = "sequence_continuity_pending"
            latest_screenshot_id = str(page["screenshot"]["screenshot_id"])
            latest_window_id = str(page["window"]["window_id"])

        scroll_restore_identity_matched = scrolls_completed == 0
        scroll_restore_sequence_overlap = len(initial_page_messages) if scrolls_completed == 0 else 0
        if args.restore_scroll and scrolls_completed > 0:
            scroll_restore_attempted = True
            restored_page = restore_scroll_position(
                host,
                args,
                latest_window_id,
                scrolls_completed,
            )
            scroll_restore_identity_matched = bool(
                (restored_page.get("context_identity") or {}).get("matched")
            )
            restored_messages = group_page_candidates(
                restored_page.get("message_candidates") or [],
                args.content_region,
                0,
                voice_candidates=restored_page.get("voice_candidates") or [],
            )
            restoration_minimum_overlap = max(1, min(2, len(initial_page_messages)))
            _, forward_overlap, _ = merge_older_page(
                initial_page_messages,
                restored_messages,
                minimum_overlap=restoration_minimum_overlap,
            )
            _, reverse_overlap, _ = merge_older_page(
                restored_messages,
                initial_page_messages,
                minimum_overlap=restoration_minimum_overlap,
            )
            scroll_restore_sequence_overlap = max(forward_overlap, reverse_overlap)
        scroll_restored = (
            scroll_restore_identity_matched
            and scroll_restore_sequence_overlap >= min(2, len(initial_page_messages))
        )

        structured_messages = finalize_timeline(timeline)
        incremental = incremental_slice(structured_messages, args.since_message_fingerprint)
        unread_boundary = locate_unread_boundary(structured_messages, args.unread_anchor_text)
        latest_message = structured_messages[-1] if structured_messages else None
        history_state = (
            "marker_reached" if stopped_reason == "history_start_marker"
            else "delta_boundary_reached" if stopped_reason == "since_cursor_reached"
            else "no_progress" if stopped_reason == "pages_without_new_messages"
            else "page_limit_reached"
        )
        history_exhaustion_confidence = (
            "high" if history_state == "marker_reached"
            else "high" if history_state == "delta_boundary_reached"
            else "medium" if history_state == "no_progress"
            else "low"
        )
        result = {
            "ok": True,
            "target": target_params(args),
            "expected_identity": args.expected_identity,
            "conversation_key": conversation_key(args),
            "persistence": {
                "enabled": state_store is not None,
                "path": str(state_store.path) if state_store is not None else None,
                "last_checkpoint": checkpoint_info,
                "observed_context_count": len((state or {}).get("observed_messages") or {}) if state else 0,
            },
            "page_count": len(page_summaries),
            "candidate_count": len(raw_candidates),
            "candidates": raw_candidates,
            "message_count": len(structured_messages),
            "text_message_count": sum(
                1 for message in structured_messages if message.get("message_type") == "text"
            ),
            "embedded_media_message_count": sum(
                1 for message in structured_messages if message.get("message_type") == "embedded_media_ocr"
            ),
            "timestamp_marker_count": sum(
                1 for message in structured_messages if message.get("message_type") == "timestamp"
            ),
            "messages": structured_messages,
            "incremental": incremental,
            # Stable, compact surfaces for an upper Agent. The full context
            # remains in `messages`; the new-message API carries only the
            # derived status and fingerprints to avoid duplicating OCR text.
            "new_message_status": (
                "initial" if incremental.get("status") == "initial_snapshot"
                else "delta" if incremental.get("status") == "cursor_found" and incremental.get("messages")
                else "no_change" if incremental.get("status") == "cursor_found"
                else "gap" if incremental.get("status") in {"cursor_not_found", "cursor_ambiguous"}
                else "unknown"
            ),
            "has_new_messages": (
                len(incremental.get("messages") or []) > 0
                if incremental.get("status") in {"initial_snapshot", "cursor_found"}
                else None
            ),
            "new_message_fingerprints": list(incremental.get("new_message_fingerprints") or []),
            "unread_boundary": unread_boundary,
            "collection_cursor": {
                "message_id": latest_message.get("message_id") if latest_message else None,
                "message_fingerprint": latest_message.get("message_fingerprint") if latest_message else None,
                "scope": "conversation_snapshot",
            },
            "pages": page_summaries,
            "stopped_reason": stopped_reason,
            "history_state": history_state,
            # Only an explicit, caller-supplied history marker proves that the
            # requested boundary was reached. A page that adds no new messages
            # is useful exhaustion evidence, but virtualization/OCR failures
            # mean it cannot truthfully prove completeness.
            "history_complete": history_state == "marker_reached",
            "history_exhaustion_confidence": history_exhaustion_confidence,
            "dedupe_basis": "ordered_page_boundary_sequence_minimum_2_anchors_at_least_half_pairs",
            "sender_identified_count": sum(1 for message in structured_messages if message.get("sender")),
            "low_confidence_message_count": sum(
                1 for message in structured_messages if message.get("confidence_level") == "low"
            ),
            "identity_retry_count": sum(summary["identity_retry_count"] for summary in page_summaries),
            "identity_evidence": {
                "visible_identity_pages": sum(
                    1 for summary in page_summaries if summary["identity_evidence"] == "visible_identity"
                ),
                "sequence_continuity_pages": sum(
                    1 for summary in page_summaries if summary["identity_evidence"] == "sequence_continuity"
                ),
            },
            "scrolls_completed": scrolls_completed,
            "scroll_restore_requested": args.restore_scroll,
            "scroll_restored_best_effort": scroll_restored,
            "scroll_restore_identity_matched": scroll_restore_identity_matched,
            "scroll_restore_sequence_overlap": scroll_restore_sequence_overlap,
            "context": {
                "kind": "complete_bounded_snapshot",
                "message_count": len(structured_messages),
                "cursor": {
                    "message_fingerprint": latest_message.get("message_fingerprint") if latest_message else None,
                },
                "coverage": {
                    "history_state": history_state,
                    "history_complete": history_state == "marker_reached",
                    "exhaustion_confidence": history_exhaustion_confidence,
                },
                "storage": {
                    "durable": state_store is not None,
                    "path": str(state_store.path) if state_store is not None else None,
                    "observed_context_count": len((state or {}).get("observed_messages") or {}) if state else 0,
                },
            },
        }
        if args.omit_raw_candidates:
            result.pop("candidates", None)
        return result
    except BaseException as exc:
        collection_error = exc
        raise
    finally:
        if (
            args.restore_scroll
            and scrolls_completed > 0
            and not scroll_restore_attempted
            and latest_window_id is not None
        ):
            scroll_restore_attempted = True
            try:
                restore_scroll_position(host, args, latest_window_id, scrolls_completed)
            except BaseException:
                # Preserve the collection failure; interaction.end still
                # restores foreground state and removes the activity cue.
                pass
        if interaction_id is not None:
            try:
                ended = host.request("interaction.end", {"interaction_id": interaction_id})
                completion = ended.get("interaction")
            except BaseException:
                if collection_error is None:
                    raise
        host.close()
        if completion is not None:
            # The return/exception above is evaluated before finally; expose
            # cleanup diagnostics through a side channel consumed in main.
            args._completion = completion


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", type=Path, required=True, help="Path to win-agent.exe")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--process", help="Target process name")
    target.add_argument("--title-contains", help="Substring of the target window title")
    target.add_argument("--title-exact", help="Exact target window title")
    parser.add_argument("--expected-identity", action="append", required=True, help="Stable conversation identity term; repeat as needed")
    parser.add_argument("--locator-text", action="append", default=[], help="Distinctive OCR text used only to recover the initial conversation")
    parser.add_argument("--identity-match", choices=("all", "any"), default="all")
    parser.add_argument("--identity-region", type=parse_region, required=True, metavar="X,Y,W,H")
    parser.add_argument("--content-region", type=parse_region, required=True, metavar="X,Y,W,H")
    parser.add_argument("--max-pages", type=int, default=6)
    parser.add_argument("--no-progress-pages", type=int, default=2, help="Stop after this many pages add no sequence-anchored messages")
    parser.add_argument("--history-start-text", action="append", default=[], help="Optional visible marker that proves the requested history boundary")
    parser.add_argument("--unread-anchor-text", action="append", default=[], help="Caller-provided visible marker that proves an unread boundary")
    parser.add_argument("--since-message-fingerprint", help="Return an incremental slice only after this exact prior cursor")
    parser.add_argument(
        "--state-path",
        type=Path,
        help="Explicit caller-owned JSON checkpoint; enables crash-safe full structured-context persistence",
    )
    parser.add_argument("--settle-ms", type=int, default=350)
    parser.add_argument("--identity-retries", type=int, default=2, help="Bounded retries for transient identity OCR mismatch on the same window")
    parser.add_argument("--scroll-amount", type=int, default=600, help="Positive DeskPilot wheel amount loads earlier content")
    parser.add_argument("--scroll-x", type=int)
    parser.add_argument("--scroll-y", type=int)
    parser.add_argument("--show-action-trace", action="store_true")
    parser.add_argument("--omit-raw-candidates", action="store_true", help="Omit raw OCR occurrences from stdout; messages keep their source candidates")
    parser.add_argument("--no-restore-scroll", dest="restore_scroll", action="store_false")
    parser.set_defaults(restore_scroll=True)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not 1 <= args.max_pages <= 20:
        parser.error("--max-pages must be between 1 and 20")
    if not 1 <= args.no_progress_pages <= 5:
        parser.error("--no-progress-pages must be between 1 and 5")
    if not 100 <= args.settle_ms <= 5000:
        parser.error("--settle-ms must be between 100 and 5000")
    if not 0 <= args.identity_retries <= 3:
        parser.error("--identity-retries must be between 0 and 3")
    if args.scroll_amount <= 0:
        parser.error("--scroll-amount must be positive")
    # The right-side gutter is less likely than the content center to belong
    # to a nested scrollable card embedded in a message.
    args.scroll_x = args.scroll_x if args.scroll_x is not None else args.content_region["x"] + args.content_region["width"] - 20
    args.scroll_y = args.scroll_y if args.scroll_y is not None else args.content_region["y"] + args.content_region["height"] // 2
    args._completion = None
    try:
        result = collect(args)
        result["activity"] = args._completion
        # Keep the public stdout protocol ASCII-only. Windows PowerShell can
        # decode native-process pipe bytes with a legacy code page before a
        # JSON consumer sees them; escaped JSON preserves OCR Unicode exactly.
        print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
        return 0
    except (DeskPilotError, CollectorError) as exc:
        print(
            json.dumps(
                {"ok": False, "error": exc.to_dict(), "activity": args._completion},
                ensure_ascii=True,
                separators=(",", ":"),
            )
        )
        return 2
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {"code": "COLLECTOR_FAILED", "message": str(exc)},
                    "activity": args._completion,
                },
                ensure_ascii=True,
                separators=(",", ":"),
            )
        )
        return 2


if __name__ == "__main__":
    sys.exit(main())
