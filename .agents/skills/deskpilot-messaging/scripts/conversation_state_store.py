"""Crash-safe persistence for the generic desktop-chat conversation state.

The store is opt-in through an explicit caller-owned path.  It writes the
complete structured context already present in ``ConversationState`` (message
content and OCR provenance) without copying screenshots or process logs.
"""

from __future__ import annotations

import copy
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from conversation_state import MessagingStateError, STATE_SCHEMA_VERSION


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class ConversationStateStore:
    """Load and atomically checkpoint one conversation state file."""

    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser()
        if self.path.exists() and self.path.is_dir():
            raise MessagingStateError("STATE_PATH_IS_DIRECTORY", "The state path must identify a file.")

    def load(self, *, conversation_key: str | None = None) -> dict[str, Any] | None:
        if not self.path.exists():
            return None
        try:
            with self.path.open("r", encoding="utf-8") as stream:
                state = json.load(stream)
        except (OSError, json.JSONDecodeError) as exc:
            raise MessagingStateError("STATE_CORRUPT", f"Unable to load conversation state: {exc}") from exc
        if not isinstance(state, dict):
            raise MessagingStateError("STATE_CORRUPT", "Conversation state must be a JSON object.")
        version = str(state.get("schema_version") or "")
        if version == "1":
            # Version 1 never stored message bodies.  Keep its resumable
            # metadata, but do not pretend it contains a complete context.
            state["schema_version"] = STATE_SCHEMA_VERSION
            state.setdefault("observed_messages", {})
            state.setdefault("state_revision", 0)
            state.setdefault("last_transition", "migrated_from_v1")
        elif version != STATE_SCHEMA_VERSION:
            raise MessagingStateError("STATE_SCHEMA_UNSUPPORTED", f"Unsupported conversation state schema: {version!r}.")
        stored_key = str(state.get("conversation_key") or "").strip()
        if not stored_key:
            raise MessagingStateError("STATE_CORRUPT", "Conversation state has no conversation_key.")
        if conversation_key is not None and stored_key != conversation_key:
            raise MessagingStateError(
                "CONVERSATION_IDENTITY_CHANGED",
                "The state file belongs to another conversation.",
            )
        return state

    def save(self, state: dict[str, Any], *, reason: str) -> dict[str, Any]:
        if not isinstance(state, dict) or not str(state.get("conversation_key") or "").strip():
            raise MessagingStateError("STATE_INVALID", "Only a conversation state with a key can be persisted.")
        payload = copy.deepcopy(state)
        payload["schema_version"] = STATE_SCHEMA_VERSION
        payload["persistence"] = {
            "last_checkpoint_at": _utc_now(),
            "last_checkpoint_reason": str(reason or "state_transition"),
            "atomic": True,
        }
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                dir=str(parent),
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                    json.dump(payload, stream, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary_name, self.path)
            finally:
                if os.path.exists(temporary_name):
                    os.unlink(temporary_name)
        except OSError as exc:
            raise MessagingStateError("STATE_CHECKPOINT_FAILED", f"Unable to checkpoint conversation state: {exc}") from exc
        return copy.deepcopy(payload["persistence"])

