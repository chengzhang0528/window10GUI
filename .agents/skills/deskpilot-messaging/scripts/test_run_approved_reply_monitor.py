#!/usr/bin/env python3

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from message_structure import finalize_timeline  # noqa: E402
from collect_messages import DeskPilotError  # noqa: E402
from run_approved_reply_monitor import (  # noqa: E402
    exact_text_fingerprint,
    initial_observe,
    require_reply_anchor,
    sent_message_evidence,
)


class FakeHost:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def request(self, method, params):
        self.requests.append((method, params))
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


def monitor_args():
    return SimpleNamespace(
        process=None,
        title_contains=None,
        title_exact="ExampleChat",
        expected_identity=["Target room"],
        locator_text=["Target room"],
        identity_match="all",
        identity_region={"x": 100, "y": 0, "width": 400, "height": 80},
        content_region={"x": 100, "y": 80, "width": 400, "height": 400},
        settle_ms=100,
    )


class ApprovedReplyMonitorTests(unittest.TestCase):
    @patch("collect_messages.time.sleep")
    def test_initial_identity_mismatch_recovers_one_unique_caller_locator(self, sleep):
        mismatch = DeskPilotError(
            {"error": {"code": "CONTEXT_IDENTITY_MISMATCH", "message": "wrong room"}}
        )
        locate = {
            "window": {"window_id": "win-1"},
            "screenshot": {"screenshot_id": "shot-1"},
            "message_candidates": [
                {"text": "Target room", "bounds": {"x": 10, "y": 20, "width": 80, "height": 20}}
            ],
        }
        recovered = {
            "window": {"window_id": "win-1"},
            "screenshot": {"trusted": True},
            "context_identity": {"matched": True},
            "message_candidates": [],
        }
        host = FakeHost([mismatch, locate, {"clicked": True}, recovered])
        result, messages = initial_observe(host, monitor_args())
        self.assertTrue(result["context_identity"]["matched"])
        self.assertEqual([], messages)
        self.assertEqual(
            ["messages.observe", "messages.observe", "input.click", "messages.observe"],
            [method for method, _ in host.requests],
        )
        sleep.assert_called_once_with(0.1)

    def test_exact_text_fingerprint_uses_normalized_exact_message(self):
        messages = finalize_timeline(
            [
                {"content": "older", "direction": "incoming", "content_kind": "text"},
                {"content": "助理 有话说：测试", "direction": "outgoing", "content_kind": "text"},
            ]
        )
        self.assertEqual(
            messages[1]["message_fingerprint"],
            exact_text_fingerprint(messages, "助理有话说：测试"),
        )

    def test_exact_text_fingerprint_rejects_partial_match(self):
        messages = finalize_timeline(
            [{"content": "助理有话说：测试更多", "direction": "outgoing", "content_kind": "text"}]
        )
        self.assertIsNone(exact_text_fingerprint(messages, "助理有话说：测试"))

    def test_new_outgoing_long_fragment_can_verify_wrapped_bubble(self):
        messages = finalize_timeline(
            [
                {"content": "older", "direction": "incoming", "content_kind": "text"},
                {
                    "content": "离婚等情绪过了再谈，孩子也得考虑。",
                    "direction": "outgoing",
                    "content_kind": "text",
                },
            ]
        )
        evidence = sent_message_evidence(
            messages,
            "助理有话说：我觉得这种时候还是先把工作和生活稳住吧，离婚等情绪过了再谈，孩子也得考虑。",
            {messages[0]["message_fingerprint"]},
        )
        self.assertTrue(evidence["verified"])
        self.assertEqual("new_outgoing_text_fragment", evidence["mode"])
        self.assertEqual(messages[1]["message_fingerprint"], evidence["message_fingerprint"])

    def test_fragment_must_be_new_outgoing_and_long_enough(self):
        incoming = finalize_timeline(
            [{"content": "离婚等情绪过了再谈，孩子也得考虑。", "direction": "incoming", "content_kind": "text"}]
        )
        self.assertFalse(sent_message_evidence(incoming, "前文离婚等情绪过了再谈，孩子也得考虑。", set())["verified"])
        short = finalize_timeline(
            [{"content": "孩子也得考虑", "direction": "outgoing", "content_kind": "text"}]
        )
        self.assertFalse(sent_message_evidence(short, "前文孩子也得考虑", set())["verified"])
        old = finalize_timeline(
            [{"content": "离婚等情绪过了再谈，孩子也得考虑。", "direction": "outgoing", "content_kind": "text"}]
        )
        self.assertFalse(
            sent_message_evidence(
                old,
                "前文离婚等情绪过了再谈，孩子也得考虑。",
                {old[0]["message_fingerprint"]},
            )["verified"]
        )

    def test_multiple_new_matching_fragments_are_ambiguous(self):
        messages = finalize_timeline(
            [
                {"content": "离婚等情绪过了再谈，孩子也得考虑。", "direction": "outgoing", "content_kind": "text"},
                {"content": "离婚等情绪过了再谈，孩子也得考虑。", "direction": "outgoing", "content_kind": "text"},
            ]
        )
        evidence = sent_message_evidence(
            messages,
            "前文离婚等情绪过了再谈，孩子也得考虑。",
            set(),
        )
        self.assertFalse(evidence["verified"])
        self.assertEqual("ambiguous", evidence["status"])

    def test_reply_anchor_must_match_exact_target(self):
        self.assertEqual(
            "m2",
            require_reply_anchor(
                {"status": "verified", "message_fingerprint": "m2", "mode": "quote_preview"},
                "m2",
            )["message_fingerprint"],
        )
        with self.assertRaises(Exception) as context:
            require_reply_anchor({"status": "verified", "message_fingerprint": "m1", "mode": "quote_preview"}, "m2")
        self.assertEqual("REPLY_ANCHOR_TARGET_MISMATCH", context.exception.code)

    def test_private_turn_accepts_conversation_composer_anchor(self):
        evidence = require_reply_anchor(
            {"status": "verified", "mode": "conversation_composer"},
            "m2",
            "conversation_turn",
        )
        self.assertEqual("conversation_composer", evidence["mode"])

    def test_reply_anchor_without_verified_evidence_is_blocked(self):
        with self.assertRaisesRegex(Exception, "did not provide verified evidence"):
            require_reply_anchor(None, "m1")


if __name__ == "__main__":
    unittest.main()
