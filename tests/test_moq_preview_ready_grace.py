"""Regression: MoQ's "give up and say preview_ready anyway" fallback timer
must give a *live* webcam source (browser record -> WS -> ffmpeg bridge ->
UDP tee -> per-destination ffmpeg -> openmoq-publisher) real time to get a
relay-confirmed namespace publish before lying "ready" to the frontend.

The old fixed 8s fallback fired well before that multi-hop startup chain
produced a confirmed publish for a webcam source (verified live via QA
harness: MoqPlayer's subscribe attempts hit "no such namespace or track"
repeatedly, burning its whole retry budget, because the backend had already
told it to go ahead). A VOD/file source's ffmpeg starts reading immediately,
so it keeps the short grace period.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from moq_preview import (  # noqa: E402
    moq_job_should_fail_without_namespace,
    moq_publish_missing_error,
)
from upload_service import moq_preview_ready_grace_sec  # noqa: E402


class MoqPreviewReadyGraceTests(unittest.TestCase):
    def test_vod_file_gets_short_fixed_grace(self):
        self.assertEqual(moq_preview_ready_grace_sec("dummy.mp4", 300), 8.0)
        self.assertEqual(moq_preview_ready_grace_sec("/tmp/clip.mov", 30), 8.0)

    def test_live_webcam_udp_source_gets_extended_grace(self):
        # device:webcam (local publisher agent) and udp:// (browser webcam
        # bridge tee) are both "live" — long job durations should extend the
        # grace period well past the old fixed 8s, up to the cap.
        self.assertEqual(moq_preview_ready_grace_sec("device:webcam", 300), 30.0)
        self.assertEqual(
            moq_preview_ready_grace_sec("udp://127.0.0.1:19001?fifo_size=1000000", 300),
            30.0,
        )

    def test_live_source_grace_never_exceeds_job_duration_headroom(self):
        # A short-duration live job shouldn't get a grace period that eats
        # the whole run — floor at the minimum, capped by duration - 5s.
        self.assertEqual(moq_preview_ready_grace_sec("device:webcam", 10), 8.0)
        self.assertEqual(moq_preview_ready_grace_sec("device:webcam", 20), 15.0)

    def test_live_source_grace_capped_even_for_very_long_jobs(self):
        self.assertEqual(moq_preview_ready_grace_sec("device:webcam", 3600), 30.0)


class MoqNamespacePublishFailureTests(unittest.TestCase):
    def test_observing_poller_fails_encode_only_success(self):
        # bench-733f1d7c: 240 CMAF fragments, moqx_ns=0, job completed.
        self.assertTrue(
            moq_job_should_fail_without_namespace(
                publish_confirmed=False,
                poller_observing=True,
            )
        )
        error = moq_publish_missing_error(namespace="bench-733f1d7c", observing=True)
        self.assertIn("bench-733f1d7c", error)
        self.assertIn("not a player", error.lower())
        self.assertNotIn("0x10 subscribe miss is not OK", error)

    def test_confirmed_publish_is_success(self):
        self.assertFalse(
            moq_job_should_fail_without_namespace(
                publish_confirmed=True,
                poller_observing=True,
            )
        )

    def test_unreachable_metrics_without_catalog_fail_the_job(self):
        # bench-aef84d9a: Linode :18000 timed out, job completed, 0x10, 0 paint.
        self.assertTrue(
            moq_job_should_fail_without_namespace(
                publish_confirmed=False,
                poller_observing=False,
                catalog_published=False,
            )
        )

    def test_unreachable_metrics_with_local_catalog_do_not_fail(self):
        self.assertFalse(
            moq_job_should_fail_without_namespace(
                publish_confirmed=False,
                poller_observing=False,
                catalog_published=True,
            )
        )


if __name__ == "__main__":
    unittest.main()
