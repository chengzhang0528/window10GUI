#!/usr/bin/env python3

from __future__ import annotations

import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))

from run_group_wave import (  # noqa: E402
    WeChatWaveError,
    find_new_outgoing,
    find_unique_text,
    initial_participation_verified,
    quote_preview_matches,
    reply_fragment_strength,
    select_source,
    visible_new_messages,
)


def candidate(text: str, x: int, y: int) -> dict:
    return {"text": text, "bounds": {"x": x, "y": y, "width": 120, "height": 20}}


def message(fingerprint: str, text: str, *, direction: str = "incoming", y: int = 100) -> dict:
    return {
        "message_fingerprint": fingerprint,
        "content": text,
        "content_kind": "text",
        "direction": direction,
        "bounds": {"x": 350, "y": y, "width": 160, "height": 20},
    }


class RunGroupWaveTests(unittest.TestCase):
    def test_search_match_is_unique_inside_dropdown(self):
        result = find_unique_text(
            [candidate("无人受苦的世界", 80, 40), candidate("无人受苦的世界", 100, 120)],
            "无人受苦的世界",
            region={"x": 60, "y": 75, "width": 260, "height": 110},
            code="TEST",
        )
        self.assertEqual(120, result["bounds"]["y"])

    def test_search_ambiguity_stops(self):
        with self.assertRaises(WeChatWaveError):
            find_unique_text(
                [candidate("无人受苦的世界", 100, 100), candidate("无人受苦的世界", 100, 130)],
                "无人受苦的世界",
                region={"x": 60, "y": 75, "width": 260, "height": 110},
                code="TEST",
            )

    def test_source_selection_avoids_clipped_context_menu(self):
        selected = select_source(
            [message("m1", "较早消息", y=300), message("m2", "底部消息", y=540)],
            source_text=None,
            source_fingerprint=None,
            maximum_anchor_y=430,
        )
        self.assertEqual("m1", selected["message_fingerprint"])

    def test_requested_source_must_be_unique(self):
        with self.assertRaises(WeChatWaveError):
            select_source(
                [message("m1", "相同内容", y=200), message("m2", "相同内容", y=300)],
                source_text="相同内容",
                source_fingerprint=None,
                maximum_anchor_y=430,
            )

    def test_source_text_tolerates_one_ocr_character_drift(self):
        selected = select_source(
            [message("m1", "咖啡尝了一囗不喝了", y=300), message("m2", "另一条消息", y=350)],
            source_text="咖啡尝了一口不喝了",
            source_fingerprint=None,
            maximum_anchor_y=430,
        )
        self.assertEqual("m1", selected["message_fingerprint"])

    def test_quote_preview_requires_source_fragment(self):
        self.assertTrue(quote_preview_matches([candidate("张三：咖啡尝了一口不喝了", 350, 500)], "咖啡尝了一口不喝了"))
        self.assertTrue(quote_preview_matches([candidate("张三：咖啡尝了一囗不了", 350, 500)], "咖啡尝了一囗不喝了"))
        self.assertFalse(quote_preview_matches([candidate("另一条消息", 350, 500)], "咖啡尝了一口不喝了"))

    def test_send_verification_requires_new_outgoing_match(self):
        reply = "我是点点点小助手，代我和大家沟通。你们有没有尝过一次就不再好奇的东西？"
        found = find_new_outgoing(
            [
                message("old", reply, direction="outgoing"),
                message("new", "我是点点点小助手，代我和大家沟通。你们有没有尝过一次就不再好奇的东西？", direction="outgoing"),
            ],
            reply,
            {"old"},
            {"x": 300, "y": 80, "width": 600, "height": 480},
        )
        self.assertEqual("new", found["message_fingerprint"])

    def test_wechat_right_edge_recovers_generic_direction_misclassification(self):
        reply = "我是点点点小助手，代我和大家沟通。大家有没有什么东西也是试过一次就彻底不惦记了？"
        observed = message("new", "大家有没有什么东西也是试过一次就彻底不惦记了？", direction="incoming", y=460)
        observed["bounds"] = {"x": 430, "y": 460, "width": 160, "height": 40}
        found = find_new_outgoing(
            [observed],
            reply,
            set(),
            {"x": 300, "y": 80, "width": 300, "height": 480},
        )
        self.assertEqual("new", found["message_fingerprint"])

    def test_reply_fragment_tolerates_bounded_ocr_drift(self):
        self.assertGreaterEqual(
            reply_fragment_strength("大冢有没有什么东西也是试过一次就彻底不惦记了", "大家有没有什么东西也是试过一次就彻底不惦记了"),
            8,
        )

    def test_initial_participation_uses_explicit_lifecycle_record(self):
        self.assertFalse(initial_participation_verified({"send_ledger": {}}))
        self.assertTrue(
            initial_participation_verified(
                {"scenario_progress": {"initial_participation": {"status": "sent_verified"}}}
            )
        )

    def test_legacy_verified_send_also_prevents_duplicate_initial_send(self):
        self.assertTrue(
            initial_participation_verified(
                {"send_ledger": {"send-1": {"status": "sent_verified"}}}
            )
        )

    def test_visible_delta_ignores_bounded_ocr_drift(self):
        current = [message("new-fingerprint", "咖啡尝了一囗不喝了")]
        existing = {"observed_messages": {"old-fingerprint": message("old-fingerprint", "咖啡尝了一口不喝了")}}
        self.assertEqual([], visible_new_messages(current, existing))

    def test_visible_delta_reports_unmatched_message(self):
        current = [message("new-fingerprint", "这是刚出现的新话题")]
        existing = {"observed_messages": {"old-fingerprint": message("old-fingerprint", "咖啡尝了一口不喝了")}}
        self.assertEqual("new-fingerprint", visible_new_messages(current, existing)[0]["message_fingerprint"])


if __name__ == "__main__":
    unittest.main()
