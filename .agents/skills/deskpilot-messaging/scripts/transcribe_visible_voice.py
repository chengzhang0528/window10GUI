#!/usr/bin/env python3
"""Invoke one app-native visible voice transcription through DeskPilot."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

from collect_messages import (
    DeskPilotError,
    DeskPilotHost,
    conversation_key,
    parse_region,
    target_params,
)
from conversation_state import create_conversation_state, update_snapshot
from conversation_state_store import ConversationStateStore
from message_structure import finalize_timeline, group_page_candidates, normalize_text
from voice_processing import process_voice_bubble


class VoiceTranscriptionError(RuntimeError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        self.code = code
        self.details = details
        super().__init__(message)


def _candidate_center(candidate: dict[str, Any]) -> tuple[int, int]:
    bounds = candidate.get("bounds") or {}
    return (
        int(bounds.get("x", 0)) + max(1, int(bounds.get("width", 1))) // 2,
        int(bounds.get("y", 0)) + max(1, int(bounds.get("height", 1))) // 2,
    )


def find_menu_action(candidates: list[dict[str, Any]], labels: list[str]) -> dict[str, Any]:
    expected = {normalize_text(label) for label in labels if normalize_text(label)}
    matches = []
    for candidate in candidates:
        observed = normalize_text(str(candidate.get("text") or ""))
        if any(observed == label or (label in observed and len(observed) - len(label) <= 2) for label in expected):
            matches.append(candidate)
    if len(matches) != 1:
        raise VoiceTranscriptionError(
            "VOICE_TRANSCRIBE_ACTION_NOT_UNIQUE",
            "The app-native voice transcription action was absent or ambiguous.",
            {
                "match_count": len(matches),
                "labels": labels,
                "observed": [str(candidate.get("text") or "") for candidate in candidates],
            },
        )
    return matches[0]


def extract_new_transcript(
    before: list[dict[str, Any]],
    after: list[dict[str, Any]],
    *,
    voice_x: int,
    voice_y: int,
    maximum_vertical_distance: int = 180,
) -> dict[str, Any]:
    before_text = {normalize_text(str(candidate.get("text") or "")) for candidate in before}
    excluded = {
        normalize_text(value)
        for value in ("语音转文字", "收起文字", "收藏", "多选", "提醒", "引用", "删除")
    }
    matches: list[dict[str, Any]] = []
    for candidate in after:
        text = str(candidate.get("text") or "").strip()
        compact = normalize_text(text)
        bounds = candidate.get("bounds") or {}
        center_x, center_y = _candidate_center(candidate)
        if not compact or compact in before_text or compact in excluded:
            continue
        if re.fullmatch(r"\d{1,2}[:：]\d{2}", text.replace(" ", "")):
            continue
        if not voice_y <= center_y <= voice_y + maximum_vertical_distance:
            continue
        if abs(center_x - voice_x) > 260:
            continue
        if int(bounds.get("width", 0)) < 12:
            continue
        matches.append(candidate)
    if len(matches) != 1:
        raise VoiceTranscriptionError(
            "VOICE_TRANSCRIPT_NOT_UNIQUE",
            "The app-native transcript could not be isolated from the post-action observation.",
            {"match_count": len(matches)},
        )
    return matches[0]


def observe(host: DeskPilotHost, args: argparse.Namespace, content_region: dict[str, int]) -> dict[str, Any]:
    return host.request(
        "messages.observe",
        target_params(args)
        | {
            "expected_identity": args.expected_identity,
            "identity_match": args.identity_match,
            "identity_region": args.identity_region,
            "content_region": content_region,
            "include_text_blocks": True,
            "action_label": "读取语音转写",
        },
    )


def wait_for_result(
    operation,
    *,
    timeout_ms: int,
    poll_ms: int,
    retry_codes: set[str] | None = None,
):
    """Run immediately and poll only while a known transient condition remains."""
    deadline = time.monotonic() + max(0, timeout_ms) / 1000
    retry_codes = retry_codes or set()
    while True:
        try:
            return operation()
        except (DeskPilotError, VoiceTranscriptionError) as exc:
            if getattr(exc, "code", "") not in retry_codes:
                raise
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise
            time.sleep(min(max(1, poll_ms) / 1000, remaining))


def _wait_settings(args: argparse.Namespace) -> tuple[int, int]:
    timeout_ms = max(0, int(getattr(args, "wait_timeout_ms", 1500)))
    # settle_ms remains a compatibility fallback for programmatic callers;
    # the CLI's primary knob is the much shorter semantic polling interval.
    poll_ms = max(1, int(getattr(args, "poll_ms", min(getattr(args, "settle_ms", 500), 100))))
    return timeout_ms, poll_ms


def recover_conversation(host: DeskPilotHost, args: argparse.Namespace) -> dict[str, Any]:
    locate = host.request("messages.observe", target_params(args) | {"action_label": "定位目标会话"})
    locators = [normalize_text(value) for value in args.locator_text if normalize_text(value)]
    def matching(candidates: list[dict[str, Any]], region: dict[str, int] | None) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        for candidate in candidates:
            text = normalize_text(str(candidate.get("text") or ""))
            center_x, center_y = _candidate_center(candidate)
            in_region = (
                region is None
                or (
                    region["x"] <= center_x <= region["x"] + region["width"]
                    and region["y"] <= center_y <= region["y"] + region["height"]
                )
            )
            if in_region and any(locator in text or text in locator for locator in locators if len(locator) >= 3):
                found.append(candidate)
        return found

    matches = matching(locate.get("message_candidates") or [], args.locator_region)
    if len(matches) != 1 and args.search_x is not None and args.search_y is not None:
        window_id = str((locate.get("window") or {}).get("window_id") or "")
        screenshot_id = str((locate.get("screenshot") or {}).get("screenshot_id") or "")
        host.request(
            "input.click",
            {"window_id": window_id, "screenshot_id": screenshot_id, "x": args.search_x, "y": args.search_y, "action_label": "搜索目标会话"},
        )
        host.request("input.hotkey", {"window_id": window_id, "key": "CTRL+A", "action_label": "选择搜索内容"})
        host.request("input.type", {"window_id": window_id, "text": args.locator_text[0], "confirmed": True, "action_label": "输入会话名称"})
        timeout_ms, poll_ms = _wait_settings(args)

        def read_unique_search_result() -> tuple[dict[str, Any], list[dict[str, Any]]]:
            result = host.request("messages.observe", target_params(args) | {"action_label": "读取会话搜索结果"})
            found = matching(result.get("message_candidates") or [], args.search_result_region or args.locator_region)
            if len(found) != 1:
                raise VoiceTranscriptionError(
                    "CONVERSATION_LOCATOR_NOT_UNIQUE",
                    "Conversation recovery is waiting for one stable search result.",
                    {"match_count": len(found), "locator_text": args.locator_text},
                )
            return result, found

        locate, matches = wait_for_result(
            read_unique_search_result,
            timeout_ms=timeout_ms,
            poll_ms=poll_ms,
            retry_codes={"CONVERSATION_LOCATOR_NOT_UNIQUE"},
        )
    if len(matches) != 1:
        raise VoiceTranscriptionError(
            "CONVERSATION_LOCATOR_NOT_UNIQUE",
            "Conversation recovery requires one locator match inside the caller-owned locator region.",
            {"match_count": len(matches), "locator_text": args.locator_text},
        )
    click_x, click_y = _candidate_center(matches[0])
    host.request(
        "input.click",
        {
            "window_id": str((locate.get("window") or {}).get("window_id") or ""),
            "screenshot_id": str((locate.get("screenshot") or {}).get("screenshot_id") or ""),
            "x": click_x,
            "y": click_y,
            "action_label": "切换目标会话",
        },
    )
    timeout_ms, poll_ms = _wait_settings(args)
    return wait_for_result(
        lambda: observe(host, args, args.content_region),
        timeout_ms=timeout_ms,
        poll_ms=poll_ms,
        retry_codes={"CONTEXT_IDENTITY_MISMATCH"},
    )


def run(args: argparse.Namespace) -> dict[str, Any]:
    host = DeskPilotHost(args.cli.resolve())
    interaction_started = False
    try:
        host.request(
            "interaction.begin",
            {"activity_label": "AGENT 处理语音消息", "show_overlay": True, "restore_original_window": True},
        )
        interaction_started = True
        host.request("windows.activate", target_params(args) | {"action_label": "进入语音会话"})
        try:
            before = observe(host, args, args.content_region)
        except DeskPilotError as exc:
            if exc.code != "CONTEXT_IDENTITY_MISMATCH" or not args.locator_text:
                raise
            before = recover_conversation(host, args)
        screenshot_id = str((before.get("screenshot") or {}).get("screenshot_id") or "")
        if not screenshot_id:
            raise VoiceTranscriptionError("VOICE_SCREENSHOT_REQUIRED", "Voice action requires a trusted fresh screenshot.")
        host.request(
            "input.right_click",
            target_params(args)
            | {
                "x": args.voice_x,
                "y": args.voice_y,
                "screenshot_id": screenshot_id,
                "action_label": "检查语音操作",
            },
        )
        timeout_ms, poll_ms = _wait_settings(args)

        def read_menu_action() -> tuple[dict[str, Any], dict[str, Any]]:
            result = observe(host, args, args.menu_region)
            return result, find_menu_action(result.get("message_candidates") or [], args.menu_label)

        menu, action = wait_for_result(
            read_menu_action,
            timeout_ms=timeout_ms,
            poll_ms=poll_ms,
            retry_codes={"VOICE_TRANSCRIBE_ACTION_NOT_UNIQUE"},
        )
        action_x, action_y = _candidate_center(action)
        host.request(
            "input.click",
            {
                "window_id": str((menu.get("window") or {}).get("window_id") or ""),
                "x": action_x,
                "y": action_y,
                "screenshot_id": str((menu.get("screenshot") or {}).get("screenshot_id") or ""),
                "action_label": "语音转文字",
            },
        )
        def read_transcript() -> tuple[dict[str, Any], dict[str, Any]]:
            result = observe(host, args, args.content_region)
            candidate = extract_new_transcript(
                before.get("message_candidates") or [],
                result.get("message_candidates") or [],
                voice_x=args.voice_x,
                voice_y=args.voice_y,
                maximum_vertical_distance=args.maximum_transcript_distance,
            )
            return result, candidate

        after, transcript_candidate = wait_for_result(
            read_transcript,
            timeout_ms=timeout_ms,
            poll_ms=poll_ms,
            retry_codes={"VOICE_TRANSCRIPT_NOT_UNIQUE"},
        )
        voice_record = process_voice_bubble(
            {
                "candidate_id": args.voice_id,
                "content_kind": "voice",
                "duration_ms": args.duration_ms,
                "side": args.direction,
                "sender": args.sender,
                "bounds": {
                    "x": args.voice_x - args.voice_width // 2,
                    "y": args.voice_y - args.voice_height // 2,
                    "width": args.voice_width,
                    "height": args.voice_height,
                },
                "source": "app_native_transcription_action",
            }
        )
        voice_record["transcript"] = {
            "status": "available",
            "text": str(transcript_candidate.get("text") or "").strip(),
            "confidence": None,
            "engine": "app_native",
            "evidence": {
                "mode": "post_action_positioned_ocr",
                "bounds": transcript_candidate.get("bounds"),
            },
        }
        message = finalize_timeline(
            group_page_candidates([], args.content_region, 1, voice_candidates=[voice_record])
        )[0]
        state_metadata = None
        if args.state_path:
            key = args.conversation_key or conversation_key(args)
            snapshot = {
                "conversation_key": key,
                "conversation_binding": {
                    "target": target_params(args),
                    "expected_identity": list(args.expected_identity),
                    "identity_match": args.identity_match,
                },
                "collection_cursor": {"message_fingerprint": message["message_fingerprint"]},
                "messages": [message],
            }
            store = ConversationStateStore(args.state_path)
            existing = store.load(conversation_key=key) if Path(args.state_path).exists() else None
            state = update_snapshot(existing, snapshot) if existing is not None else create_conversation_state(snapshot)
            state_metadata = store.save(state, reason="app_native_voice_transcribed")
        return {
            "status": "transcribed",
            "conversation_identity_matched": True,
            "voice_message": message,
            "state_checkpoint": state_metadata,
        }
    finally:
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
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--process")
    target.add_argument("--title-contains")
    target.add_argument("--title-exact")
    parser.add_argument("--expected-identity", action="append", required=True)
    parser.add_argument("--locator-text", action="append", default=[])
    parser.add_argument("--locator-region", type=parse_region)
    parser.add_argument("--search-result-region", type=parse_region)
    parser.add_argument("--search-x", type=int)
    parser.add_argument("--search-y", type=int)
    parser.add_argument("--identity-match", choices=("all", "any"), default="all")
    parser.add_argument("--identity-region", type=parse_region, required=True)
    parser.add_argument("--content-region", type=parse_region, required=True)
    parser.add_argument("--menu-region", type=parse_region, required=True)
    parser.add_argument("--menu-label", action="append", default=["语音转文字"])
    parser.add_argument("--voice-id", required=True)
    parser.add_argument("--voice-x", type=int, required=True)
    parser.add_argument("--voice-y", type=int, required=True)
    parser.add_argument("--voice-width", type=int, default=90)
    parser.add_argument("--voice-height", type=int, default=38)
    parser.add_argument("--duration-ms", type=int)
    parser.add_argument("--direction", choices=("left", "right"), default="left")
    parser.add_argument("--sender")
    parser.add_argument("--maximum-transcript-distance", type=int, default=180)
    parser.add_argument("--wait-timeout-ms", type=int, default=1500, help="Maximum semantic wait; successful observations return immediately")
    parser.add_argument("--poll-ms", type=int, default=75, help="Delay between observations only after a transient miss")
    parser.add_argument("--settle-ms", type=int, default=500, help=argparse.SUPPRESS)
    parser.add_argument("--state-path")
    parser.add_argument("--conversation-key")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        print(json.dumps(run(args), ensure_ascii=False, indent=2))
        return 0
    except (VoiceTranscriptionError, DeskPilotError) as exc:
        print(
            json.dumps(
                {"status": "error", "error": {"code": getattr(exc, "code", "VOICE_TRANSCRIBE_FAILED"), "message": str(exc), "details": getattr(exc, "details", None)}},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
