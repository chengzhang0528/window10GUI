#!/usr/bin/env python3

import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from message_structure import finalize_timeline, group_page_candidates  # noqa: E402
from voice_processing import UnavailableAsrAdapter, detect_voice_bubbles, process_voice_bubble  # noqa: E402
from transcribe_visible_voice import VoiceTranscriptionError, extract_new_transcript, find_menu_action, wait_for_result  # noqa: E402
from conversation_state import create_conversation_state  # noqa: E402
from conversation_state_store import ConversationStateStore  # noqa: E402


class VoiceProcessingTests(unittest.TestCase):
    def test_semantic_wait_has_no_fixed_delay_when_result_is_ready(self):
        started = time.monotonic()
        calls = []
        result = wait_for_result(
            lambda: calls.append("observed") or {"ready": True},
            timeout_ms=1500,
            poll_ms=75,
        )
        self.assertEqual({"ready": True}, result)
        self.assertEqual(["observed"], calls)
        self.assertLess(time.monotonic() - started, 0.25)

    def test_semantic_wait_retries_only_declared_transient_miss(self):
        calls = []

        def operation():
            calls.append("observed")
            if len(calls) == 1:
                raise VoiceTranscriptionError("NOT_READY", "not ready")
            return "ready"

        self.assertEqual(
            "ready",
            wait_for_result(operation, timeout_ms=100, poll_ms=1, retry_codes={"NOT_READY"}),
        )
        self.assertEqual(2, len(calls))

    def test_explicit_voice_hint_becomes_message_without_fabricated_text(self):
        voice = {"candidate_id": "v1", "content_kind": "voice", "duration_ms": 3000, "side": "left", "bounds": {"x": 20, "y": 40, "width": 90, "height": 32}}
        messages = group_page_candidates([], {"x": 0, "y": 0, "width": 400, "height": 300}, 1, voice_candidates=[voice])
        result = finalize_timeline(messages)
        self.assertEqual(1, len(result))
        self.assertEqual("voice", result[0]["content_kind"])
        self.assertEqual("unavailable", result[0]["content_metadata"]["transcript"]["status"])
        self.assertEqual(3000, result[0]["content_metadata"]["duration_ms"])

    def test_ocr_text_alone_does_not_become_voice(self):
        self.assertEqual([], detect_voice_bubbles([{"text": "3\"", "bounds": {"x": 1, "y": 1, "width": 20, "height": 10}}]))

    def test_unavailable_asr_is_explicit_and_safe(self):
        result = process_voice_bubble({"content_kind": "voice", "duration_ms": 2000}, UnavailableAsrAdapter())
        self.assertEqual("unavailable", result["transcript"]["status"])
        self.assertIsNone(result["transcript"]["text"])

    def test_app_native_menu_and_new_transcript_are_bound_geometrically(self):
        action = find_menu_action(
            [{"text": "语音转文字", "bounds": {"x": 460, "y": 290, "width": 60, "height": 15}}],
            ["语音转文字"],
        )
        self.assertEqual("语音转文字", action["text"])
        transcript = extract_new_transcript(
            [{"text": "白小白", "bounds": {"x": 380, "y": 238, "width": 35, "height": 12}}],
            [
                {"text": "白小白", "bounds": {"x": 380, "y": 238, "width": 35, "height": 12}},
                {"text": "现成的周周五可以进场。", "bounds": {"x": 390, "y": 307, "width": 145, "height": 13}},
            ],
            voice_x=424,
            voice_y=273,
        )
        self.assertEqual("现成的周周五可以进场。", transcript["text"])

    def test_transcript_and_confidence_survive_durable_checkpoint(self):
        message = {
            "message_fingerprint": "voice-1",
            "content_kind": "voice",
            "content_metadata": {
                "duration_ms": 2000,
                "transcript": {"status": "available", "text": "好的，美女。", "confidence": 0.81},
            },
        }
        state = create_conversation_state(
            {"conversation_key": "voice-test", "messages": [message], "collection_cursor": {"message_fingerprint": "voice-1"}}
        )
        with tempfile.TemporaryDirectory() as directory:
            store = ConversationStateStore(Path(directory) / "state.json")
            store.save(state, reason="voice-test")
            loaded = store.load(conversation_key="voice-test")
        transcript = loaded["observed_messages"]["voice-1"]["content_metadata"]["transcript"]
        self.assertEqual("好的，美女。", transcript["text"])
        self.assertEqual(0.81, transcript["confidence"])


if __name__ == "__main__":
    unittest.main()
