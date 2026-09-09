"""Generic voice-message detection and optional ASR adapter contracts.

The desktop CLI does not assume an application's audio format or control tree.
Adapters may provide positioned ``voice`` hints and an audio path; this module
normalizes those hints and keeps unavailable transcription explicit.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol


class VoiceProcessingError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


class AsrAdapter(Protocol):
    def transcribe(self, audio_path: Path) -> dict[str, Any]: ...


@dataclass(frozen=True)
class UnavailableAsrAdapter:
    reason: str = "no_audio_or_asr_adapter"

    def transcribe(self, audio_path: Path) -> dict[str, Any]:
        return {"status": "unavailable", "text": None, "confidence": None, "reason": self.reason}


@dataclass(frozen=True)
class CommandAsrAdapter:
    """Run a caller-owned ASR command returning one JSON object on stdout."""

    executable: str
    timeout_seconds: float = 30.0

    def transcribe(self, audio_path: Path) -> dict[str, Any]:
        try:
            completed = subprocess.run(
                [self.executable, str(audio_path)],
                check=False,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {"status": "error", "text": None, "confidence": None, "reason": type(exc).__name__}
        if completed.returncode != 0:
            return {"status": "error", "text": None, "confidence": None, "reason": "asr_command_failed"}
        try:
            value = json.loads(completed.stdout)
        except json.JSONDecodeError:
            return {"status": "error", "text": None, "confidence": None, "reason": "asr_invalid_json"}
        if not isinstance(value, dict):
            return {"status": "error", "text": None, "confidence": None, "reason": "asr_result_not_object"}
        text = str(value.get("text") or "").strip() or None
        confidence = value.get("confidence")
        if confidence is not None:
            try:
                confidence = max(0.0, min(1.0, float(confidence)))
            except (TypeError, ValueError):
                confidence = None
        return {
            "status": "available" if text else "empty",
            "text": text,
            "confidence": confidence,
            "engine": value.get("engine"),
        }


def _bounds(value: Any) -> dict[str, int]:
    value = value if isinstance(value, dict) else {}
    return {
        "x": int(value.get("x", 0)),
        "y": int(value.get("y", 0)),
        "width": max(1, int(value.get("width", 1))),
        "height": max(1, int(value.get("height", 1))),
    }


def detect_voice_bubbles(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Select explicit adapter hints; OCR text alone never implies voice."""
    result: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, candidate in enumerate(candidates, 1):
        if not isinstance(candidate, dict):
            continue
        hint = str(
            candidate.get("content_kind")
            or candidate.get("message_type_hint")
            or candidate.get("semantic_role")
            or ""
        ).strip().casefold().replace("-", "_")
        if hint not in {"voice", "audio", "voice_message", "audio_message"}:
            continue
        duration = candidate.get("duration_ms")
        if duration is not None:
            try:
                duration = max(0, int(duration))
            except (TypeError, ValueError):
                duration = None
        candidate_id = str(candidate.get("candidate_id") or f"voice-{index}")
        if candidate_id in seen_ids:
            continue
        seen_ids.add(candidate_id)
        result.append(
            {
                "candidate_id": candidate_id,
                "content_kind": "voice",
                "bounds": _bounds(candidate.get("bounds")),
                "side": candidate.get("side"),
                "sender": candidate.get("sender"),
                "duration_ms": duration,
                "audio_path": candidate.get("audio_path"),
                "transcript": candidate.get("transcript"),
                "source": candidate.get("source") or "adapter_hint",
            }
        )
    return result


def process_voice_bubble(candidate: dict[str, Any], asr: AsrAdapter | None = None) -> dict[str, Any]:
    """Return a durable voice record without fabricating a transcript."""
    detected = detect_voice_bubbles([candidate])
    if not detected:
        raise VoiceProcessingError("VOICE_HINT_REQUIRED", "A voice record needs an explicit adapter hint.")
    record = detected[0]
    audio_path = str(record.get("audio_path") or "").strip()
    transcript: dict[str, Any]
    if audio_path and asr is not None:
        transcript = asr.transcribe(Path(audio_path))
    else:
        transcript = UnavailableAsrAdapter().transcribe(Path(audio_path or ""))
    record["transcript"] = transcript
    return record
