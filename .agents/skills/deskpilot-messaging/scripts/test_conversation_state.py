#!/usr/bin/env python3

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from conversation_state import (  # noqa: E402
    MessagingStateError,
    advance_reply_cursor,
    approve_draft,
    begin_send,
    create_conversation_state,
    mark_user_takeover,
    prepare_send,
    record_send_observation,
    register_draft,
    update_snapshot,
)
from conversation_state_store import ConversationStateStore  # noqa: E402


def snapshot(*fingerprints):
    return {
        "conversation_key": "conversation-test",
        "collection_cursor": {"message_fingerprint": fingerprints[-1] if fingerprints else None},
        "messages": [{"message_fingerprint": fingerprint} for fingerprint in fingerprints],
    }


class ConversationStateTests(unittest.TestCase):
    def test_draft_binds_conversation_sources_basis_and_style(self):
        state = create_conversation_state(snapshot("m1", "m2"))
        state, draft = register_draft(
            state,
            reply_to_message_fingerprints=["m2"],
            basis_summary="Answer the latest explicit question.",
            exact_text="可以，先把输入输出对齐。",
            style_profile_version="cheng-zhang-v1",
        )
        self.assertEqual("awaiting_approval", draft["status"])
        self.assertEqual(["m2"], draft["reply_to_message_fingerprints"])
        self.assertEqual("m2", draft["reply_target_message_fingerprint"])
        self.assertIn(draft["draft_id"], state["drafts"])

    def test_edit_expires_old_draft_and_requires_fresh_approval(self):
        state = create_conversation_state(snapshot("m1"))
        state, first = register_draft(
            state,
            reply_to_message_fingerprints=["m1"],
            basis_summary="Initial basis.",
            exact_text="第一版",
            style_profile_version="v1",
        )
        state, second = register_draft(
            state,
            reply_to_message_fingerprints=["m1"],
            basis_summary="Edited basis.",
            exact_text="第二版",
            style_profile_version="v1",
            replaces_draft_id=first["draft_id"],
        )
        self.assertEqual("expired", state["drafts"][first["draft_id"]]["status"])
        self.assertEqual(2, second["version"])
        with self.assertRaises(MessagingStateError) as context:
            approve_draft(state, first["draft_id"], "第一版")
        self.assertEqual("DRAFT_NOT_AWAITING_APPROVAL", context.exception.code)

    def test_verified_send_advances_cursor_and_duplicate_attempt_is_blocked(self):
        state = create_conversation_state(
            snapshot("m1"),
            pending_questions=[{"source_message_fingerprint": "m1", "summary": "Need an answer."}],
        )
        state, draft = register_draft(
            state,
            reply_to_message_fingerprints=["m1"],
            basis_summary="Answer the question.",
            exact_text="收到，我来确认。",
            style_profile_version="v1",
        )
        state = approve_draft(state, draft["draft_id"], draft["exact_text"])
        state, attempt = prepare_send(
            state,
            draft["draft_id"],
            observed_conversation_key="conversation-test",
            observed_message_fingerprints=["m1"],
            reply_target_message_fingerprint="m1",
            reply_anchor_evidence={"status": "verified", "message_fingerprint": "m1", "mode": "quote_preview"},
        )
        state = begin_send(state, attempt["idempotency_key"])
        state = record_send_observation(
            state,
            attempt["idempotency_key"],
            verified=True,
            evidence={"mode": "exact_outgoing_text"},
        )
        state = advance_reply_cursor(state, attempt["idempotency_key"])
        self.assertEqual("m1", state["reply_cursor"]["message_fingerprint"])
        self.assertEqual("replied", state["pending_questions"][0]["status"])
        with self.assertRaises(MessagingStateError) as context:
            prepare_send(
                state,
                draft["draft_id"],
                observed_conversation_key="conversation-test",
                observed_message_fingerprints=["m1"],
                reply_target_message_fingerprint="m1",
                reply_anchor_evidence={"status": "verified", "message_fingerprint": "m1", "mode": "quote_preview"},
            )
        self.assertEqual("DUPLICATE_SEND_BLOCKED", context.exception.code)

    def test_uncertain_result_can_only_be_reobserved(self):
        state = create_conversation_state(snapshot("m1"))
        state, draft = register_draft(
            state,
            reply_to_message_fingerprints=["m1"],
            basis_summary="Answer the question.",
            exact_text="测试回复",
            style_profile_version="v1",
        )
        state = approve_draft(state, draft["draft_id"], draft["exact_text"])
        state, attempt = prepare_send(
            state,
            draft["draft_id"],
            observed_conversation_key="conversation-test",
            observed_message_fingerprints=["m1"],
            reply_target_message_fingerprint="m1",
            reply_anchor_evidence={"status": "verified", "message_fingerprint": "m1", "mode": "quote_preview"},
        )
        state = begin_send(state, attempt["idempotency_key"])
        state = record_send_observation(state, attempt["idempotency_key"], verified=None)
        self.assertEqual("send_uncertain", state["send_ledger"][attempt["idempotency_key"]]["status"])
        state = record_send_observation(state, attempt["idempotency_key"], verified=False)
        self.assertEqual("send_uncertain", state["send_ledger"][attempt["idempotency_key"]]["status"])
        state = record_send_observation(state, attempt["idempotency_key"], verified=True)
        self.assertEqual("sent_verified", state["send_ledger"][attempt["idempotency_key"]]["status"])

    def test_user_takeover_expires_drafts_and_blocks_send(self):
        state = create_conversation_state(snapshot("m1"))
        state, draft = register_draft(
            state,
            reply_to_message_fingerprints=["m1"],
            basis_summary="Answer the question.",
            exact_text="测试回复",
            style_profile_version="v1",
        )
        state = approve_draft(state, draft["draft_id"], draft["exact_text"])
        state = mark_user_takeover(state)
        self.assertEqual("expired", state["drafts"][draft["draft_id"]]["status"])
        with self.assertRaises(MessagingStateError) as context:
            prepare_send(
                state,
                draft["draft_id"],
                observed_conversation_key="conversation-test",
                observed_message_fingerprints=["m1"],
                reply_target_message_fingerprint="m1",
                reply_anchor_evidence={"status": "verified", "message_fingerprint": "m1", "mode": "quote_preview"},
            )
        self.assertEqual("USER_TAKEOVER_ACTIVE", context.exception.code)

    def test_state_keeps_complete_structured_context(self):
        message = {
            "message_fingerprint": "m1",
            "content": "完整上下文",
            "source_candidates": [{"source_id": "p1:c1", "text": "完整上下文"}],
        }
        state = create_conversation_state(snapshot("m1") | {"messages": [message]})
        self.assertEqual(message, state["observed_messages"]["m1"])
        self.assertEqual(1, state["state_revision"])

    def test_empty_observation_does_not_erase_proven_cursor(self):
        state = create_conversation_state(snapshot("m1"))
        updated = update_snapshot(
            state,
            {
                "conversation_key": "conversation-test",
                "collection_cursor": {"message_fingerprint": None},
                "messages": [],
            },
        )
        self.assertEqual({"message_fingerprint": "m1"}, updated["snapshot_cursor"])

    def test_atomic_store_round_trip_and_corruption_is_explicit(self):
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "conversation.json"
            state = create_conversation_state(snapshot("m1"))
            store = ConversationStateStore(path)
            metadata = store.save(state, reason="test")
            loaded = store.load(conversation_key="conversation-test")
            self.assertEqual("test", metadata["last_checkpoint_reason"])
            self.assertEqual("conversation-test", loaded["conversation_key"])
            path.write_text("{broken", encoding="utf-8")
            with self.assertRaises(MessagingStateError) as context:
                store.load()
            self.assertEqual("STATE_CORRUPT", context.exception.code)

    def test_multiple_sources_require_explicit_reply_target(self):
        state = create_conversation_state(snapshot("m1", "m2"))
        with self.assertRaises(MessagingStateError) as context:
            register_draft(
                state,
                reply_to_message_fingerprints=["m1", "m2"],
                basis_summary="Context",
                exact_text="回复",
                style_profile_version="v1",
            )
        self.assertEqual("REPLY_TARGET_REQUIRED", context.exception.code)

    def test_private_turn_can_batch_sources_into_one_reply(self):
        state = create_conversation_state(snapshot("m1", "m2"), conversation_mode="private")
        state, draft = register_draft(
            state,
            reply_to_message_fingerprints=["m1", "m2"],
            reply_target_message_fingerprint="m2",
            reply_anchor_evidence={"status": "verified", "mode": "conversation_composer"},
            basis_summary="两条连续消息共同构成一个问题。",
            exact_text="合并回答这两个问题。",
            style_profile_version="v1",
            reply_strategy="conversation_turn",
        )
        state = approve_draft(state, draft["draft_id"], draft["exact_text"])
        state, attempt = prepare_send(
            state,
            draft["draft_id"],
            observed_conversation_key="conversation-test",
            observed_message_fingerprints=["m1", "m2"],
            reply_target_message_fingerprint="m2",
            reply_anchor_evidence={"status": "verified", "mode": "conversation_composer"},
            reply_strategy="conversation_turn",
        )
        self.assertEqual("conversation_turn", attempt["reply_strategy"])

    def test_send_without_specific_reply_anchor_is_blocked(self):
        state = create_conversation_state(snapshot("m1"))
        state, draft = register_draft(
            state,
            reply_to_message_fingerprints=["m1"],
            basis_summary="Context",
            exact_text="回复",
            style_profile_version="v1",
        )
        state = approve_draft(state, draft["draft_id"], draft["exact_text"])
        with self.assertRaises(MessagingStateError) as context:
            prepare_send(
                state,
                draft["draft_id"],
                observed_conversation_key="conversation-test",
                observed_message_fingerprints=["m1"],
                reply_target_message_fingerprint="m1",
            )
        self.assertEqual("SPECIFIC_REPLY_UNPROVEN", context.exception.code)


if __name__ == "__main__":
    unittest.main()
