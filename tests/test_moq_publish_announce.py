"""Publisher must CONNECT + announce — encode-only success is a lie.

bench-733f1d7c finished 240 CMAF fragments with moqx_ns=0 because
openmoq-publisher started after ffmpeg (Docker WT CONNECT raced the
encode) and --paced delayed PUBLISH_NAMESPACE. These helpers are the
contract for the publish path, not just the error string.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from moq_publish import (  # noqa: E402
    MoqPublishTarget,
    build_openmoq_publisher_cmd,
    publisher_exit_error,
    publisher_webtransport_connected,
    should_pace_moq_publisher,
    wait_for_publisher_webtransport,
)


class PublisherAnnounceContractTests(unittest.TestCase):
    def test_file_and_live_sources_do_not_stack_paced(self) -> None:
        self.assertFalse(should_pace_moq_publisher("dummy.mp4"))
        self.assertFalse(should_pace_moq_publisher("device:webcam"))
        self.assertFalse(
            should_pace_moq_publisher("udp://127.0.0.1:19001?fifo_size=1000000")
        )

    def test_publisher_cmd_omits_paced_and_keeps_catalog_forward(self) -> None:
        cmd = build_openmoq_publisher_cmd(
            "/opt/openmoq-publisher",
            MoqPublishTarget(
                endpoint="https://34-138-137-211.sslip.io:4433/moq-relay",
                namespace="bench-733f1d7c",
                insecure_tls=True,
            ),
            duration_sec=60,
            paced=should_pace_moq_publisher("dummy.mp4"),
        )
        self.assertNotIn("--paced", cmd)
        self.assertIn("--publish-catalog", cmd)
        self.assertEqual(cmd[cmd.index("--namespace") + 1], "bench-733f1d7c")
        self.assertEqual(cmd[cmd.index("--forward") + 1], "1")
        self.assertIn("--insecure", cmd)

    def test_connection_id_on_stdout_means_webtransport_is_live(self) -> None:
        # Production used to discard stdout, so this line never reached the log.
        self.assertTrue(
            publisher_webtransport_connected(
                "connection_id=wt-103173155163616\n"
                "[moqt-session] live: awaiting subscriptions, mode=forward\n"
            )
        )
        self.assertTrue(
            publisher_webtransport_connected(
                "[moqt-session] live: sent track=vide_1 group=55 obj=0 "
                "time_us=27521354 bytes=191598 sap=2\n"
            )
        )
        self.assertFalse(
            publisher_webtransport_connected(
                "[moqt-session] live: waiting for ftyp+moov from stdin...\n"
                "error: transport live publish failed: webtransport connection closed\n"
            )
        )
        self.assertFalse(publisher_webtransport_connected(""))

    def test_sigkill_after_connection_id_is_not_before_connect(self) -> None:
        # Prod bench-216482ff: waiter missed block-buffered stdout, SIGKILL'd
        # the Docker wrapper, then dumped these lines into "before CONNECT".
        log = (
            "[moqt-session] live: sent track=vide_1 group=55 obj=0 "
            "time_us=27521354 bytes=191598 sap=2\n"
            "[moqt-session] live: sent track=soun_2 group=55 obj=0 "
            "time_us=27541333 bytes=8049 sap=1\n"
            "connection_id=wt-101632518200672\n"
        )
        msg = publisher_exit_error("openmoq", -9, log)
        self.assertNotIn("before WebTransport CONNECT", msg)
        self.assertIn("SIGKILL", msg)
        self.assertIn("after WebTransport CONNECT", msg)
        self.assertIn("connection_id=wt-101632518200672", msg)

    def test_exit_without_session_may_say_before_connect(self) -> None:
        msg = publisher_exit_error(
            "openmoq",
            -9,
            "[moqt-session] live: waiting for ftyp+moov from stdin...\n",
        )
        self.assertIn("before WebTransport CONNECT", msg)

    def test_wait_returns_true_once_connection_id_appears(self) -> None:
        logs = ["waiting for ftyp+moov\n", "connection_id=wt-103173155163616\n"]
        ticks = {"t": 0.0}

        def clock() -> float:
            return ticks["t"]

        def sleep(interval: float) -> None:
            ticks["t"] += interval

        self.assertTrue(
            wait_for_publisher_webtransport(
                lambda: logs.pop(0) if logs else "connection_id=wt-103173155163616\n",
                lambda: True,
                timeout_sec=2.0,
                poll_interval=0.05,
                clock=clock,
                sleep=sleep,
            )
        )
        self.assertGreater(ticks["t"], 0.0)

    def test_wait_treats_live_sent_track_as_connected(self) -> None:
        self.assertTrue(
            wait_for_publisher_webtransport(
                lambda: "[moqt-session] live: sent track=vide_1 group=0 obj=0\n",
                lambda: True,
                timeout_sec=1.0,
                clock=lambda: 0.0,
                sleep=lambda _s: None,
            )
        )

    def test_wait_fails_if_publisher_dies_without_connection_id(self) -> None:
        self.assertFalse(
            wait_for_publisher_webtransport(
                lambda: "[moqt-session] live: waiting for ftyp+moov from stdin...\n",
                lambda: False,
                timeout_sec=5.0,
                clock=lambda: 0.0,
                sleep=lambda _s: None,
            )
        )

    def test_wait_fails_on_timeout_without_connection_id(self) -> None:
        ticks = {"t": 0.0}

        def clock() -> float:
            return ticks["t"]

        def sleep(interval: float) -> None:
            ticks["t"] += interval

        self.assertFalse(
            wait_for_publisher_webtransport(
                lambda: "",
                lambda: True,
                timeout_sec=0.2,
                poll_interval=0.05,
                clock=clock,
                sleep=sleep,
            )
        )

    def test_upload_service_starts_publisher_then_feeds_ftyp(self) -> None:
        text = (ROOT / "src" / "upload_service.py").read_text()
        start = text.index("def _run_moq_pipeline")
        body = text[start : text.index("\n    def _finalize_result", start)]
        pub = body.index("publisher_proc = subprocess.Popen")
        ffmpeg = body.index("ffmpeg_proc = subprocess.Popen")
        self.assertLess(pub, ffmpeg)
        self.assertNotIn("wait_for_publisher_webtransport", body)
        self.assertNotIn("stdout=subprocess.DEVNULL", body)
        self.assertIn("paced=should_pace_moq_publisher", body)
        self.assertIn("waiting for ftyp+moov", body)
        self.assertIn("publisher_exit_error", body)
        self.assertIn("_stop_moq_publisher", body)
        # Encode must die first; never SIGKILL a live publisher to "wait for CONNECT".
        stop = body.index("self._terminate_process(ffmpeg_proc)")
        pub_stop = body.index("self._stop_moq_publisher")
        self.assertLess(stop, pub_stop)

    def test_playback_gate_subscribes_moq_before_announce(self) -> None:
        text = (ROOT / "web" / "frontend" / "src" / "playbackGate.ts").read_text()
        self.assertIn('protocol === "webrtc" && !browser', text)
        self.assertIn("Subscribe on running + 0x10 keepalive", text)
        self.assertIn('protocol === "srt" || protocol === "rtmp"', text)
        self.assertIn('if (protocol === "moq")', text)
        self.assertNotIn('protocol !== "moq" && protocol !== "webrtc"', text)


if __name__ == "__main__":
    unittest.main()
