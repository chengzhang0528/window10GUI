"""Pure geometry and sequence helpers for DeskPilot OCR message candidates."""

from __future__ import annotations

import difflib
import hashlib
import json
import re
from statistics import median
from typing import Any, Iterable


def normalize_text(value: str) -> str:
    return "".join(character.casefold() for character in value if character.isalnum())


CONTENT_KINDS = {"text", "reference", "image", "media", "voice", "emoji", "system", "timestamp", "unknown"}


def _normalize_content_kind(value: Any) -> str | None:
    compact = str(value or "").strip().casefold().replace("-", "_")
    aliases = {
        "quote": "reference",
        "quoted": "reference",
        "reply": "reference",
        "picture": "image",
        "photo": "image",
        "sticker": "emoji",
        "reaction": "emoji",
        "card": "media",
        "embedded_media": "media",
        "embedded_media_ocr": "media",
        "audio": "voice",
        "voice_message": "voice",
        "audio_message": "voice",
    }
    compact = aliases.get(compact, compact)
    return compact if compact in CONTENT_KINDS else None


def _content_kind(candidates: list[dict[str, Any]], fallback: str = "text") -> str:
    hints = {
        hint
        for candidate in candidates
        for hint in (
            _normalize_content_kind(candidate.get("content_kind")),
            _normalize_content_kind(candidate.get("message_type_hint")),
            _normalize_content_kind(candidate.get("semantic_role")),
        )
        if hint is not None
    }
    for preferred in ("reference", "image", "emoji", "media", "system", "unknown", "text"):
        if preferred in hints:
            return preferred
    compact = normalize_text("\n".join(str(candidate.get("text") or "") for candidate in candidates))
    if compact in {"图片", "image", "photo"}:
        return "image"
    if compact in {"表情", "动画表情", "sticker", "emoji"}:
        return "emoji"
    return fallback


def _content_metadata(candidates: list[dict[str, Any]], content_kind: str) -> dict[str, Any] | None:
    if content_kind == "voice":
        duration = next((candidate.get("duration_ms") for candidate in candidates if candidate.get("duration_ms") is not None), None)
        transcript = next((candidate.get("transcript") for candidate in candidates if candidate.get("transcript") is not None), None)
        return {
            "duration_ms": duration,
            "transcript": transcript or {"status": "unavailable", "text": None, "confidence": None},
        }
    if content_kind == "reference":
        quoted_text = next((candidate.get("quoted_text") for candidate in candidates if candidate.get("quoted_text")), None)
        quoted_fingerprint = next(
            (candidate.get("quoted_message_fingerprint") for candidate in candidates if candidate.get("quoted_message_fingerprint")),
            None,
        )
        return {
            "quoted_text": quoted_text,
            "quoted_message_fingerprint": quoted_fingerprint,
            "semantic_status": "provided" if quoted_text or quoted_fingerprint else "unresolved",
        }
    if content_kind in {"image", "media", "emoji"}:
        return {
            "semantic_status": "provided" if any(candidate.get("media_description") for candidate in candidates) else "unresolved",
            "description": next((candidate.get("media_description") for candidate in candidates if candidate.get("media_description")), None),
        }
    return None


def _bounds(candidate: dict[str, Any]) -> dict[str, int]:
    value = candidate.get("bounds") or {}
    return {
        "x": int(value.get("x", 0)),
        "y": int(value.get("y", 0)),
        "width": max(1, int(value.get("width", 1))),
        "height": max(1, int(value.get("height", 1))),
    }


def _union_bounds(candidates: Iterable[dict[str, Any]]) -> dict[str, int]:
    rectangles = [_bounds(candidate) for candidate in candidates]
    left = min(rectangle["x"] for rectangle in rectangles)
    top = min(rectangle["y"] for rectangle in rectangles)
    right = max(rectangle["x"] + rectangle["width"] for rectangle in rectangles)
    bottom = max(rectangle["y"] + rectangle["height"] for rectangle in rectangles)
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def _vertical_gap(upper: dict[str, Any], lower: dict[str, Any]) -> int:
    first = _bounds(upper)
    second = _bounds(lower)
    return second["y"] - (first["y"] + first["height"])


def _looks_like_timestamp(candidate: dict[str, Any], region: dict[str, int]) -> bool:
    text = str(candidate.get("text") or "").strip()
    compact = re.sub(r"\s+", "", text)
    if not compact or len(compact) > 24:
        return False
    time_like = bool(
        re.fullmatch(r"\d{1,2}[:：]\d{2}", compact)
        or re.fullmatch(r"(?:今天|昨天|前天)?(?:上午|下午|晚上)?\d{1,2}[:：]\d{2}", compact)
        or re.fullmatch(r"(?:今天|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天])", compact)
    )
    if not time_like:
        return False
    bounds = _bounds(candidate)
    relative_center = (bounds["x"] + bounds["width"] / 2 - region["x"]) / max(1, region["width"])
    return 0.32 <= relative_center <= 0.68 or candidate.get("side") == "center"


def _looks_like_sender(
    current: dict[str, Any],
    following: dict[str, Any],
    region: dict[str, int],
    median_height: float,
) -> bool:
    text = normalize_text(str(current.get("text") or ""))
    next_text = normalize_text(str(following.get("text") or ""))
    if not text or len(text) > 24 or not next_text or _looks_like_timestamp(current, region):
        return False
    current_bounds = _bounds(current)
    next_bounds = _bounds(following)
    gap = _vertical_gap(current, following)
    if gap < -2 or gap > max(30, int(round(median_height * 2.0))):
        return False
    if abs(current_bounds["x"] - next_bounds["x"]) > max(28, int(region["width"] * 0.07)):
        return False
    if current_bounds["height"] > max(16, int(round(median_height * 1.05))):
        return False
    if next_bounds["height"] < current_bounds["height"] and len(next_text) <= len(text):
        return False
    return True


def _is_continuation(
    previous: dict[str, Any],
    following: dict[str, Any],
    region: dict[str, int],
    median_height: float,
) -> bool:
    if _looks_like_timestamp(following, region):
        return False
    previous_bounds = _bounds(previous)
    next_bounds = _bounds(following)
    gap = _vertical_gap(previous, following)
    if gap < -3 or gap > max(14, int(round(median_height * 0.95))):
        return False
    return abs(previous_bounds["x"] - next_bounds["x"]) <= max(30, int(region["width"] * 0.08))


def _direction(sender: dict[str, Any] | None, body: list[dict[str, Any]], region: dict[str, int]) -> str:
    if sender is not None and sender.get("side") in {"left", "right"}:
        return "incoming" if sender.get("side") == "left" else "outgoing"
    sides = {str(candidate.get("side")) for candidate in body if candidate.get("side") in {"left", "right"}}
    if sides == {"left"}:
        return "incoming"
    if sides == {"right"}:
        return "outgoing"
    bounds = _union_bounds(body)
    relative_center = (bounds["x"] + bounds["width"] / 2 - region["x"]) / max(1, region["width"])
    if relative_center < 0.42:
        return "incoming"
    if relative_center > 0.58:
        return "outgoing"
    return "unknown"


def _confidence(
    sender: dict[str, Any] | None,
    body: list[dict[str, Any]],
    direction: str,
    message_type: str,
) -> tuple[float, str, list[str]]:
    if message_type == "timestamp":
        return 0.78, "medium", ["timestamp_pattern", "center_geometry"]
    score = 0.50
    reasons = ["positioned_ocr_text"]
    if sender is not None:
        score += 0.15
        reasons.append("sender_geometry")
    if len(body) > 1:
        score += 0.10
        reasons.append("aligned_multiline_body")
    if direction != "unknown":
        score += 0.10
        reasons.append("direction_geometry")
    normalized_lengths = [len(normalize_text(str(candidate.get("text") or ""))) for candidate in body]
    if normalized_lengths and min(normalized_lengths) <= 1:
        score -= 0.15
        reasons.append("very_short_ocr_fragment")
    score = round(max(0.05, min(0.95, score)), 2)
    level = "high" if score >= 0.80 else "medium" if score >= 0.60 else "low"
    return score, level, reasons


def _source_candidate(candidate: dict[str, Any], source_id: str) -> dict[str, Any]:
    result = {
        "source_id": source_id,
        "text": candidate.get("text"),
        "side": candidate.get("side"),
        "role_hint": candidate.get("role_hint"),
        "bounds": _bounds(candidate),
    }
    content_kind = _normalize_content_kind(candidate.get("content_kind") or candidate.get("message_type_hint"))
    if content_kind is not None:
        result["content_kind_hint"] = content_kind
    for name in ("quoted_text", "quoted_message_fingerprint", "media_description"):
        if candidate.get(name) is not None:
            result[name] = candidate.get(name)
    for name in ("duration_ms", "audio_path", "transcript", "source"):
        if candidate.get(name) is not None:
            result[name] = candidate.get(name)
    return result


def _embedded_media_run_length(
    lines: list[dict[str, Any]],
    start: int,
    region: dict[str, int],
    reference_height: int,
) -> int:
    """Detect dense OCR printed inside one embedded image/card."""
    small_height = max(4, min(9, int(reference_height * 0.72)))
    first = _bounds(lines[start])
    if first["height"] > small_height:
        return 0
    side = lines[start].get("side")
    run = [lines[start]]
    index = start + 1
    while index < len(lines):
        previous = _bounds(run[-1])
        current = _bounds(lines[index])
        if current["height"] > small_height or lines[index].get("side") != side:
            break
        if current["y"] - previous["y"] > max(45, reference_height * 4):
            break
        run.append(lines[index])
        index += 1
    if len(run) < 3:
        return 0
    union = _union_bounds(run)
    if union["width"] > int(region["width"] * 0.45):
        return 0
    if union["height"] < reference_height * 3:
        return 0
    return len(run)


def group_page_candidates(
    candidates: list[dict[str, Any]],
    region: dict[str, int],
    page_number: int,
    voice_candidates: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Group adjacent OCR lines without inventing absent sender or time data."""
    from voice_processing import detect_voice_bubbles

    voice_records = detect_voice_bubbles(list(candidates) + list(voice_candidates or []))
    lines = [candidate for candidate in candidates if normalize_text(str(candidate.get("text") or ""))]
    lines.sort(key=lambda candidate: (_bounds(candidate)["y"], _bounds(candidate)["x"]))
    messages: list[dict[str, Any]] = []
    if not lines and not voice_records:
        return []
    heights = sorted(_bounds(candidate)["height"] for candidate in lines) or [1]
    median_height = float(median(heights))
    reference_height = heights[min(len(heights) - 1, int(len(heights) * 0.75))]
    for voice in sorted(voice_records, key=lambda item: (_bounds(item)["y"], _bounds(item)["x"])):
        source_id = f"p{page_number:03d}:{voice.get('candidate_id')}"
        direction = "incoming" if voice.get("side") == "left" else "outgoing" if voice.get("side") == "right" else "unknown"
        messages.append(
            {
                "page_message_id": f"p{page_number:03d}-voice-{len(messages) + 1:03d}",
                "first_seen_page": page_number,
                "sender": voice.get("sender"),
                "content": str((voice.get("transcript") or {}).get("text") or ""),
                "timestamp": None,
                "direction": direction,
                "message_type": "voice",
                "content_kind": "voice",
                "content_metadata": _content_metadata([voice], "voice"),
                "confidence": 0.70 if voice.get("duration_ms") is not None else 0.55,
                "confidence_level": "medium" if voice.get("duration_ms") is not None else "low",
                "confidence_reasons": ["adapter_voice_hint", "visible_duration" if voice.get("duration_ms") is not None else "voice_duration_unavailable"],
                "bounds": _bounds(voice),
                "source_candidate_ids": [source_id],
                "source_candidates": [_source_candidate(voice, source_id)],
            }
        )
    if not lines:
        return messages
    index = 0
    while index < len(lines):
        current = lines[index]
        if _looks_like_timestamp(current, region):
            source_id = f"p{page_number:03d}:{current.get('candidate_id') or current.get('sequence') or index + 1}"
            score, level, reasons = _confidence(None, [current], "unknown", "timestamp")
            messages.append(
                {
                    "page_message_id": f"p{page_number:03d}-m{len(messages) + 1:03d}",
                    "first_seen_page": page_number,
                    "sender": None,
                    "content": str(current.get("text") or "").strip(),
                    "timestamp": str(current.get("text") or "").strip(),
                    "direction": "unknown",
                    "message_type": "timestamp",
                    "content_kind": "timestamp",
                    "content_metadata": None,
                    "confidence": score,
                    "confidence_level": level,
                    "confidence_reasons": reasons,
                    "bounds": _bounds(current),
                    "source_candidate_ids": [source_id],
                    "source_candidates": [_source_candidate(current, source_id)],
                }
            )
            index += 1
            continue

        media_run_length = _embedded_media_run_length(lines, index, region, reference_height)
        if media_run_length:
            body = lines[index:index + media_run_length]
            direction = _direction(None, body, region)
            source_ids = [
                f"p{page_number:03d}:{candidate.get('candidate_id') or candidate.get('sequence') or index + offset + 1}"
                for offset, candidate in enumerate(body)
            ]
            messages.append(
                {
                    "page_message_id": f"p{page_number:03d}-m{len(messages) + 1:03d}",
                    "first_seen_page": page_number,
                    "sender": None,
                    "content": "\n".join(str(candidate.get("text") or "").strip() for candidate in body),
                    "timestamp": None,
                    "direction": direction,
                    "message_type": "embedded_media_ocr",
                    "content_kind": "media",
                    "content_metadata": {
                        "semantic_status": "unresolved",
                        "description": None,
                    },
                    "confidence": 0.45,
                    "confidence_level": "low",
                    "confidence_reasons": [
                        "positioned_ocr_text",
                        "dense_small_text_cluster",
                        "embedded_media_not_plain_speech",
                    ],
                    "bounds": _union_bounds(body),
                    "source_candidate_ids": source_ids,
                    "source_candidates": [
                        _source_candidate(candidate, source_id)
                        for candidate, source_id in zip(body, source_ids)
                    ],
                }
            )
            index += media_run_length
            continue

        sender: dict[str, Any] | None = None
        if index + 1 < len(lines) and _looks_like_sender(current, lines[index + 1], region, median_height):
            sender = current
            index += 1

        body = [lines[index]]
        index += 1
        while index < len(lines):
            if index + 1 < len(lines) and _looks_like_sender(lines[index], lines[index + 1], region, median_height):
                break
            if not _is_continuation(body[-1], lines[index], region, median_height):
                break
            body.append(lines[index])
            index += 1

        content = "\n".join(str(candidate.get("text") or "").strip() for candidate in body)
        direction = _direction(sender, body, region)
        score, level, reasons = _confidence(sender, body, direction, "text")
        sources = ([sender] if sender is not None else []) + body
        content_kind = _content_kind(sources)
        source_ids = [
            f"p{page_number:03d}:{candidate.get('candidate_id') or candidate.get('sequence') or source_index + 1}"
            for source_index, candidate in enumerate(sources)
        ]
        messages.append(
            {
                "page_message_id": f"p{page_number:03d}-m{len(messages) + 1:03d}",
                "first_seen_page": page_number,
                "sender": str(sender.get("text") or "").strip() if sender is not None else None,
                "content": content,
                "timestamp": None,
                "direction": direction,
                "message_type": "text",
                "content_kind": content_kind,
                "content_metadata": _content_metadata(sources, content_kind),
                "confidence": score,
                "confidence_level": level,
                "confidence_reasons": reasons,
                "bounds": _union_bounds(sources),
                "source_candidate_ids": source_ids,
                "source_candidates": [
                    _source_candidate(candidate, source_id) for candidate, source_id in zip(sources, source_ids)
                ],
            }
        )
    messages.sort(key=lambda message: (_bounds(message)["y"], _bounds(message)["x"]))
    return messages


def _message_signature(message: dict[str, Any]) -> str:
    return normalize_text(str(message.get("content") or message.get("timestamp") or ""))


def _fingerprint_base(message: dict[str, Any]) -> str:
    payload = {
        "content": _message_signature(message),
        "sender": normalize_text(str(message.get("sender") or "")),
        "direction": str(message.get("direction") or "unknown"),
        "timestamp": normalize_text(str(message.get("timestamp") or "")),
        "content_kind": str(message.get("content_kind") or message.get("message_type") or "unknown"),
        "duration_ms": message.get("content_metadata", {}).get("duration_ms") if isinstance(message.get("content_metadata"), dict) else None,
    }
    return json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def _digest(*parts: str) -> str:
    return hashlib.sha256("\u001f".join(parts).encode("utf-8")).hexdigest()[:24]


def messages_match(left: dict[str, Any], right: dict[str, Any]) -> bool:
    left_signature = _message_signature(left)
    right_signature = _message_signature(right)
    if not left_signature or not right_signature:
        return False
    if left_signature == right_signature:
        return True
    shorter, longer = sorted((left_signature, right_signature), key=len)
    if len(shorter) >= 8 and shorter in longer and len(shorter) / len(longer) >= 0.68:
        return True
    return difflib.SequenceMatcher(None, left_signature, right_signature).ratio() >= 0.84


def merge_older_page(
    timeline: list[dict[str, Any]],
    older_page: list[dict[str, Any]],
    minimum_overlap: int = 2,
) -> tuple[list[dict[str, Any]], int, int]:
    """Prepend an older page using only a contiguous boundary sequence anchor."""
    if not timeline:
        return list(older_page), 0, len(older_page)
    maximum = min(len(timeline), len(older_page))
    overlap = 0
    for size in range(maximum, minimum_overlap - 1, -1):
        pair_matches = [
            messages_match(older_page[-size + offset], timeline[offset])
            for offset in range(size)
        ]
        matched_anchors = sum(pair_matches)
        if matched_anchors >= minimum_overlap and matched_anchors * 2 >= size:
            overlap = size
            break
    unique_older = older_page[:-overlap] if overlap else older_page
    return list(unique_older) + list(timeline), overlap, len(unique_older)


def contains_history_marker(messages: list[dict[str, Any]], markers: list[str]) -> bool:
    normalized_markers = [normalize_text(marker) for marker in markers if normalize_text(marker)]
    return any(
        marker in _message_signature(message)
        for marker in normalized_markers
        for message in messages
    )


def finalize_timeline(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    previous_base = ""
    previous_different_base = ""
    repeated_index = 0
    for index, message in enumerate(messages, 1):
        item = dict(message)
        item["message_id"] = f"message-{index:04d}"
        base = _fingerprint_base(item)
        if base == previous_base:
            repeated_index += 1
        else:
            previous_different_base = previous_base
            repeated_index = 0
        item["message_fingerprint"] = _digest(base, previous_different_base, str(repeated_index))
        item["fingerprint_basis"] = "content_sender_direction_time_kind_preceding_anchor_repeat_index"
        item["fingerprint_quality"] = (
            "high" if item.get("sender") or item.get("timestamp")
            else "medium" if previous_different_base
            else "low"
        )
        result.append(item)
        previous_base = base
    return result


def incremental_slice(messages: list[dict[str, Any]], since_fingerprint: str | None) -> dict[str, Any]:
    """Return only messages after a proven cursor; never guess when the cursor is absent."""
    if not since_fingerprint:
        return {
            "status": "initial_snapshot",
            "cursor_found": None,
            "since_message_fingerprint": None,
            "new_message_ids": [message["message_id"] for message in messages],
            "new_message_fingerprints": [message["message_fingerprint"] for message in messages],
            "messages": list(messages),
        }
    matching_indexes = [
        index for index, message in enumerate(messages)
        if message.get("message_fingerprint") == since_fingerprint
    ]
    if len(matching_indexes) != 1:
        return {
            "status": "cursor_not_found" if not matching_indexes else "cursor_ambiguous",
            "cursor_found": False,
            "since_message_fingerprint": since_fingerprint,
            "new_message_ids": [],
            "new_message_fingerprints": [],
            "messages": [],
        }
    new_messages = messages[matching_indexes[0] + 1:]
    return {
        "status": "cursor_found",
        "cursor_found": True,
        "since_message_fingerprint": since_fingerprint,
        "new_message_ids": [message["message_id"] for message in new_messages],
        "new_message_fingerprints": [message["message_fingerprint"] for message in new_messages],
        "messages": list(new_messages),
    }


def locate_unread_boundary(messages: list[dict[str, Any]], markers: list[str]) -> dict[str, Any]:
    normalized_markers = [normalize_text(marker) for marker in markers if normalize_text(marker)]
    if not normalized_markers:
        return {
            "status": "unknown",
            "marker": None,
            "message_id": None,
            "message_fingerprint": None,
            "first_unread_message_id": None,
            "first_unread_message_fingerprint": None,
        }
    matches = [
        (index, message, marker)
        for index, message in enumerate(messages)
        for marker in normalized_markers
        if marker in _message_signature(message)
    ]
    if len(matches) != 1:
        return {
            "status": "not_located" if not matches else "ambiguous",
            "marker": None,
            "message_id": None,
            "message_fingerprint": None,
            "first_unread_message_id": None,
            "first_unread_message_fingerprint": None,
        }
    index, message, marker = matches[0]
    first_unread = messages[index + 1] if index + 1 < len(messages) else None
    return {
        "status": "located",
        "marker": marker,
        "message_id": message.get("message_id"),
        "message_fingerprint": message.get("message_fingerprint"),
        "first_unread_message_id": first_unread.get("message_id") if first_unread else None,
        "first_unread_message_fingerprint": first_unread.get("message_fingerprint") if first_unread else None,
    }
