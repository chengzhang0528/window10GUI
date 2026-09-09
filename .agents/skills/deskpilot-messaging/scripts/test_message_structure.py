#!/usr/bin/env python3

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from message_structure import (  # noqa: E402
    contains_history_marker,
    finalize_timeline,
    group_page_candidates,
    incremental_slice,
    locate_unread_boundary,
    merge_older_page,
    messages_match,
)


REGION = {"x": 0, "y": 0, "width": 600, "height": 500}


def candidate(sequence, text, x, y, width, height, side="left"):
    return {
        "candidate_id": f"msg_{sequence:04d}",
        "sequence": sequence,
        "text": text,
        "side": side,
        "role_hint": "incoming" if side == "left" else "system_or_unknown",
        "bounds": {"x": x, "y": y, "width": width, "height": height},
    }


def message(content):
    return {"content": content, "timestamp": None, "direction": "incoming"}


class MessageStructureTests(unittest.TestCase):
    def test_groups_sender_and_multiline_body_without_guessing_next_message(self):
        grouped = group_page_candidates(
            [
                candidate(1, "Alice", 100, 100, 38, 12),
                candidate(2, "Hello", 104, 127, 70, 18),
                candidate(3, "world", 104, 150, 72, 18),
                candidate(4, "Separate message", 106, 205, 140, 18),
            ],
            REGION,
            1,
        )
        self.assertEqual(2, len(grouped))
        self.assertEqual("Alice", grouped[0]["sender"])
        self.assertEqual("Hello\nworld", grouped[0]["content"])
        self.assertIsNone(grouped[1]["sender"])

    def test_repeated_identical_messages_on_one_page_are_not_globally_collapsed(self):
        grouped = group_page_candidates(
            [
                candidate(1, "same", 100, 100, 50, 18),
                candidate(2, "same", 100, 160, 50, 18),
            ],
            REGION,
            1,
        )
        self.assertEqual(2, len(grouped))

    def test_merges_only_contiguous_boundary_sequence(self):
        timeline = [message("B"), message("C"), message("D")]
        older = [message("X"), message("B"), message("C")]
        merged, overlap, new_count = merge_older_page(timeline, older)
        self.assertEqual(["X", "B", "C", "D"], [item["content"] for item in merged])
        self.assertEqual(2, overlap)
        self.assertEqual(1, new_count)

    def test_single_duplicate_is_preserved_without_a_sequence_anchor(self):
        timeline = [message("same"), message("later")]
        older = [message("older"), message("same")]
        merged, overlap, new_count = merge_older_page(timeline, older)
        self.assertEqual(0, overlap)
        self.assertEqual(2, new_count)
        self.assertEqual(4, len(merged))

    def test_boundary_sequence_tolerates_one_unstable_ocr_item(self):
        timeline = [message("21:08"), message("这 个 旱 黥 好 看"), message("快使用 dsh-web")]
        older = [message("older"), message("21:08"), message("这 省 黑 鯨 好 看"), message("快使用 dsh-web")]
        merged, overlap, new_count = merge_older_page(timeline, older)
        self.assertEqual(3, overlap)
        self.assertEqual(1, new_count)
        self.assertEqual("older", merged[0]["content"])

    def test_tolerates_small_ocr_confusion(self):
        self.assertTrue(messages_match(message("DeskPilot validation"), message("DeskPiIot validation")))

    def test_history_marker_uses_normalized_text(self):
        self.assertTrue(contains_history_marker([message("No more messages")], ["no-more messages"]))

    def test_dense_small_text_inside_media_is_not_counted_as_plain_speech(self):
        grouped = group_page_candidates(
            [
                candidate(1, "Alice", 100, 40, 38, 12),
                candidate(2, "normal message", 100, 66, 120, 16),
                candidate(3, "tiny line one", 110, 150, 90, 6),
                candidate(4, "tiny line two", 108, 175, 92, 6),
                candidate(5, "tiny line three", 109, 200, 88, 6),
                candidate(6, "tiny line four", 111, 225, 86, 6),
            ],
            REGION,
            1,
        )
        self.assertEqual(2, len(grouped))
        self.assertEqual("text", grouped[0]["message_type"])
        self.assertEqual("embedded_media_ocr", grouped[1]["message_type"])
        self.assertIsNone(grouped[1]["sender"])
        self.assertEqual("low", grouped[1]["confidence_level"])

    def test_explicit_reference_hint_and_metadata_are_preserved(self):
        value = candidate(1, "针对上条回复", 100, 100, 120, 18)
        value.update(
            {
                "message_type_hint": "quote",
                "quoted_text": "原问题",
                "quoted_message_fingerprint": "message-source",
            }
        )
        grouped = group_page_candidates([value], REGION, 1)
        self.assertEqual("reference", grouped[0]["content_kind"])
        self.assertEqual("原问题", grouped[0]["content_metadata"]["quoted_text"])
        self.assertEqual("provided", grouped[0]["content_metadata"]["semantic_status"])

    def test_image_and_emoji_placeholders_remain_structured_and_unresolved(self):
        grouped = group_page_candidates(
            [
                candidate(1, "[图片]", 100, 100, 60, 18),
                candidate(2, "[动画表情]", 100, 160, 90, 18),
            ],
            REGION,
            1,
        )
        self.assertEqual("image", grouped[0]["content_kind"])
        self.assertEqual("emoji", grouped[1]["content_kind"])
        self.assertEqual("unresolved", grouped[0]["content_metadata"]["semantic_status"])

    def test_fingerprint_is_stable_when_newer_message_is_appended(self):
        initial = finalize_timeline([message("first"), message("second")])
        appended = finalize_timeline([message("first"), message("second"), message("third")])
        self.assertEqual(
            [item["message_fingerprint"] for item in initial],
            [item["message_fingerprint"] for item in appended[:2]],
        )

    def test_repeated_identical_messages_have_distinct_fingerprints(self):
        finalized = finalize_timeline([message("same"), message("same")])
        self.assertNotEqual(finalized[0]["message_fingerprint"], finalized[1]["message_fingerprint"])

    def test_incremental_slice_requires_an_exact_unique_cursor(self):
        finalized = finalize_timeline([message("first"), message("second"), message("third")])
        cursor = finalized[1]["message_fingerprint"]
        found = incremental_slice(finalized, cursor)
        self.assertTrue(found["cursor_found"])
        self.assertEqual(["third"], [item["content"] for item in found["messages"]])
        absent = incremental_slice(finalized, "not-present")
        self.assertFalse(absent["cursor_found"])
        self.assertEqual([], absent["messages"])

    def test_unread_boundary_is_reported_only_for_one_exact_marker(self):
        finalized = finalize_timeline([message("older"), message("以下为新消息"), message("new")])
        located = locate_unread_boundary(finalized, ["以下为新消息"])
        self.assertEqual("located", located["status"])
        self.assertEqual("message-0003", located["first_unread_message_id"])
        ambiguous = locate_unread_boundary(
            finalize_timeline([message("新消息"), message("新消息")]),
            ["新消息"],
        )
        self.assertEqual("ambiguous", ambiguous["status"])


if __name__ == "__main__":
    unittest.main()
