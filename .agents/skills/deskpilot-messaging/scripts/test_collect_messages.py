#!/usr/bin/env python3

import sys
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from collect_messages import (  # noqa: E402
    DeskPilotError,
    DeskPilotHost,
    observe_page_with_identity_retry,
)


class FakeHost:
    def __init__(self, responses):
        self.responses = list(responses)
        self.request_count = 0

    def request(self, method, params):
        self.request_count += 1
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


def mismatch():
    return DeskPilotError(
        {
            "error": {
                "code": "CONTEXT_IDENTITY_MISMATCH",
                "message": "identity OCR flickered",
                "retryable": True,
            }
        }
    )


def args(retries):
    return SimpleNamespace(
        process=None,
        title_contains=None,
        title_exact="ExampleChat",
        identity_region={"x": 0, "y": 0, "width": 100, "height": 50},
        content_region={"x": 0, "y": 50, "width": 100, "height": 100},
        expected_identity=["Support"],
        identity_match="all",
        identity_retries=retries,
        settle_ms=100,
    )


class IdentityRetryTests(unittest.TestCase):
    @patch("collect_messages.time.sleep")
    def test_recovers_one_transient_identity_ocr_mismatch(self, sleep):
        host = FakeHost([mismatch(), {"context_identity": {"matched": True}}])
        page, retry_count, evidence = observe_page_with_identity_retry(host, args(2))
        self.assertTrue(page["context_identity"]["matched"])
        self.assertEqual(1, retry_count)
        self.assertEqual("visible_identity", evidence)
        self.assertEqual(2, host.request_count)
        sleep.assert_called_once_with(0.1)

    @patch("collect_messages.time.sleep")
    def test_stops_after_retry_budget_is_exhausted(self, sleep):
        host = FakeHost([mismatch(), mismatch(), mismatch()])
        with self.assertRaises(DeskPilotError):
            observe_page_with_identity_retry(host, args(2))
        self.assertEqual(3, host.request_count)
        self.assertEqual(2, sleep.call_count)

    @patch("collect_messages.time.sleep")
    def test_falls_back_to_pending_sequence_continuity_after_bounded_title_loss(self, sleep):
        continuation = {
            "context_identity": {"matched": False},
            "message_candidates": [{"text": "overlap"}],
        }
        host = FakeHost([mismatch(), mismatch(), continuation])
        page, retry_count, evidence = observe_page_with_identity_retry(
            host,
            args(1),
            allow_sequence_continuity=True,
        )
        self.assertEqual(1, retry_count)
        self.assertEqual("sequence_continuity_pending", evidence)
        self.assertEqual("overlap", page["message_candidates"][0]["text"])
        self.assertEqual(3, host.request_count)
        sleep.assert_called_once_with(0.1)


class HostLifecycleTests(unittest.TestCase):
    @patch("collect_messages.subprocess.Popen")
    def test_helper_uses_a_separate_process_group_for_cooperative_cancel(self, popen):
        process = popen.return_value
        process.stdin = None
        process.stdout = None
        DeskPilotHost(Path("win-agent.exe"))
        self.assertEqual(
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
            popen.call_args.kwargs["creationflags"],
        )


if __name__ == "__main__":
    unittest.main()
