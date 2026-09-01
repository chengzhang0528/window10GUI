#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))

from run_group_wave import (  # noqa: E402
    WeChatWaveError,
    accumulated_context,
    bind_selected_source,
    checkpoint_observation,
    find_new_outgoing,
    find_unique_text,
    initial_participation_verified,
    invoke_quote_action_uia,
    is_conversation_message,
    is_verified_outgoing,
    message_payload,
    quote_preview_matches,
    reply_anchor_point,
    reply_fragment_strength,
    select_requested_source,
    select_source,
    visible_new_messages,
    visible_sequence_delta,
)


def candidate(text: str, x: int, y: int) -> dict:
    return {"text": text, "bounds": {"x": x, "y": y, "width": 120, "height": 20}}


def message(
    fingerprint: str,
    text: str,
    *,
    direction: str = "incoming",
    y: int = 100,
    content_kind: str = "text",
) -> dict:
    return {
        "message_fingerprint": fingerprint,
        "content": text,
        "content_kind": content_kind,
        "direction": direction,
        "confidence": 0.7,
        "confidence_level": "medium",
        "confidence_reasons": ["positioned_ocr_text"],
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

    def test_source_selection_keeps_latest_bottom_message(self):
        selected = select_source(
            [message("m1", "较早消息", y=300), message("m2", "底部消息", y=540)],
            source_text=None,
            source_fingerprint=None,
            maximum_anchor_y=430,
        )
        self.assertEqual("m2", selected["message_fingerprint"])

    def test_explicit_bottom_source_is_not_rejected_by_preference_boundary(self):
        selected = select_source(
            [message("m1", "底部消息", y=540)],
            source_text="底部消息",
            source_fingerprint="m1",
            maximum_anchor_y=430,
        )
        self.assertEqual("m1", selected["message_fingerprint"])

    def test_reply_anchor_prefers_strong_body_candidate(self):
        source = message("m1", "0\n@点点点你是谁", y=510)
        source["source_candidates"] = [
            candidate("0", 347, 510),
            candidate("@点点点你是谁", 391, 530),
        ]
        self.assertEqual((451, 540), reply_anchor_point(source))

    def test_quote_action_uses_unique_accessible_menu_item(self):
        calls = []

        class Host:
            def request(self, method, params):
                calls.append((method, params))
                if method == "windows.find":
                    return {"windows": [{"window_id": "menu-1"}], "count": 1}
                if method == "ui.find":
                    return {"elements": [{"element_id": "quote-1"}], "count": 1}
                if method == "ui.invoke":
                    return {"invoked": True}
                raise AssertionError(method)

        evidence = invoke_quote_action_uia(
            Host(),
            argparse.Namespace(process="Weixin", menu_class_name="CMenuWnd", quote_label="引用"),
        )
        self.assertEqual("uia_menu_item", evidence["mode"])
        self.assertEqual("quote-1", calls[-1][1]["element_id"])

    def test_quote_action_rejects_ambiguous_menu_windows(self):
        class Host:
            def request(self, method, params):
                self.assert_method = method
                return {"windows": [{"window_id": "one"}, {"window_id": "two"}], "count": 2}

        with self.assertRaises(WeChatWaveError):
            invoke_quote_action_uia(
                Host(),
                argparse.Namespace(process="Weixin", menu_class_name="CMenuWnd", quote_label="引用"),
            )

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

    def test_requested_source_rebinds_shifted_fingerprint_by_unique_text(self):
        selected, rebound = select_requested_source(
            [message("shifted", "那我得多试试", y=317)],
            source_text="那我得多试试",
            source_fingerprint="persisted",
            maximum_anchor_y=320,
        )
        self.assertTrue(rebound)
        self.assertEqual("persisted", selected["message_fingerprint"])
        rebound_messages = bind_selected_source([message("shifted", "那我得多试试", y=317)], selected)
        self.assertEqual("persisted", rebound_messages[0]["message_fingerprint"])

    def test_explicit_unique_short_source_is_allowed(self):
        selected = select_source(
            [message("m1", "可以", y=300), message("m2", "另一条消息", y=350)],
            source_text="可以",
            source_fingerprint=None,
            maximum_anchor_y=430,
        )
        self.assertEqual("m1", selected["message_fingerprint"])

    def test_automatic_source_selection_still_rejects_short_ocr_fragments(self):
        selected = select_source(
            [message("m1", "0", y=300), message("m2", "足够长的消息", y=350)],
            source_text=None,
            source_fingerprint=None,
            maximum_anchor_y=430,
        )
        self.assertEqual("m2", selected["message_fingerprint"])

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

    def test_verified_outgoing_is_not_reported_as_new_incoming(self):
        reply = "我是点点点小助手，代我和大家沟通。别为了满足好奇心把钱包和胃都搭进去。"
        observed = message("sent-fingerprint", "别为了满足好奇心把钱包和胃都搭进去", direction="incoming")
        observed["bounds"] = {"x": 445, "y": 480, "width": 364, "height": 50}
        state = {
            "send_ledger": {
                "send-1": {
                    "status": "sent_verified",
                    "exact_text": reply,
                    "verification_evidence": {"message_fingerprint": "sent-fingerprint"},
                }
            }
        }
        self.assertTrue(
            is_verified_outgoing(
                observed,
                state,
                {"x": 308, "y": 75, "width": 590, "height": 480},
            )
        )

    def test_unrelated_left_incoming_is_not_hidden_by_send_ledger(self):
        observed = message("incoming", "这是另一条新消息", direction="incoming")
        observed["bounds"] = {"x": 390, "y": 300, "width": 120, "height": 20}
        state = {
            "send_ledger": {
                "send-1": {
                    "status": "sent_verified",
                    "exact_text": "我是点点点小助手，代我和大家沟通。完全不同的回复",
                }
            }
        }
        self.assertFalse(
            is_verified_outgoing(
                observed,
                state,
                {"x": 308, "y": 75, "width": 590, "height": 480},
            )
        )

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

    def test_sequence_delta_appends_only_records_after_proven_overlap(self):
        previous = [message("a", "甲"), message("b", "乙"), message("c", "丙")]
        current = [message("b2", "乙"), message("c2", "丙"), message("d", "丁")]
        delta, status = visible_sequence_delta(current, previous)
        self.assertEqual("overlap", status)
        self.assertEqual(["d"], [item["message_fingerprint"] for item in delta])

    def test_sequence_gap_does_not_readd_whole_viewport(self):
        delta, status = visible_sequence_delta([message("x", "新窗口")], [message("a", "旧窗口")])
        self.assertEqual("gap", status)
        self.assertEqual([], delta)

    def test_actionable_new_message_excludes_timestamp_and_unknown_direction(self):
        self.assertTrue(is_conversation_message(message("m1", "你好"), incoming_only=True))
        self.assertFalse(
            is_conversation_message(
                message("t1", "18:05", direction="unknown", content_kind="timestamp"),
                incoming_only=True,
            )
        )
        self.assertFalse(is_conversation_message(message("s1", "系统记录", direction="unknown"), incoming_only=True))

    def test_accumulated_context_keeps_persisted_order(self):
        first = message("m1", "第一条")
        second = message("m2", "第二条")
        state = {
            "observed_message_fingerprints": ["m1", "m2"],
            "observed_messages": {"m2": second, "m1": first},
        }
        self.assertEqual(["m1", "m2"], [item["message_fingerprint"] for item in accumulated_context(state)])

    def test_checkpoint_context_grows_only_by_sequence_delta(self):
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(
                state_path=str(Path(directory) / "conversation-state.json"),
                process="Weixin",
                group_title="测试群",
                identity_region={"x": 300, "y": 0, "width": 600, "height": 90},
                content_region={"x": 300, "y": 75, "width": 600, "height": 480},
                conversation_key=None,
            )
            _, baseline, initial_delta, initial_status = checkpoint_observation(
                args,
                [message("m1", "第一条"), message("m2", "第二条")],
            )
            self.assertEqual("initial_baseline", initial_status)
            self.assertEqual([], initial_delta)
            self.assertEqual(2, len(accumulated_context(baseline)))

            _, updated, delta, delta_status = checkpoint_observation(
                args,
                [message("m2-shifted", "第二条"), message("m3", "第三条")],
            )
            self.assertEqual("overlap", delta_status)
            self.assertEqual(["m3"], [item["message_fingerprint"] for item in delta])
            self.assertEqual(
                ["m1", "m2", "m3"],
                [item["message_fingerprint"] for item in accumulated_context(updated)],
            )

    def test_post_send_checkpoint_appends_verified_outgoing_context(self):
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(
                state_path=str(Path(directory) / "conversation-state.json"),
                process="Weixin",
                group_title="测试群",
                identity_region={"x": 300, "y": 0, "width": 600, "height": 90},
                content_region={"x": 300, "y": 75, "width": 600, "height": 480},
                conversation_key=None,
            )
            checkpoint_observation(args, [message("incoming", "问题")])
            _, updated, delta, status = checkpoint_observation(
                args,
                [message("incoming-shifted", "问题"), message("outgoing", "回复", direction="outgoing")],
            )
            self.assertEqual("overlap", status)
            self.assertEqual(["outgoing"], [item["message_fingerprint"] for item in delta])
            self.assertEqual(2, len(accumulated_context(updated)))

    def test_new_message_payload_preserves_ocr_evidence(self):
        item = message("m1", "识别文字")
        item["source_candidates"] = [candidate("识别文字", 390, 300)]
        payload = message_payload(item, include_source_evidence=True)
        self.assertEqual("medium", payload["confidence_level"])
        self.assertEqual("识别文字", payload["source_candidates"][0]["text"])


if __name__ == "__main__":
    unittest.main()
