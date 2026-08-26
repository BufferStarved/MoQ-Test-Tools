"""Webcam-shaped fMP4 pipe: publisher must read stdin before ffmpeg writes.

Draft-18 delays CONNECT until moov. That must not delay moq5 Popen — webcam
first-moov is slower than file, and ffmpeg writing to a closed pipe becomes
EIO (the bare errno 5 on bench-f71e6fae).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from moq_publish import (  # noqa: E402
    classify_job_exception,
    combine_ffmpeg_closed_pipe_error,
    find_ffmpeg,
    find_moq5_publisher,
    is_bare_eio_message,
    looks_like_closed_pipe_eio,
)

HAS_FFMPEG = bool(shutil.which("ffmpeg") or Path(find_ffmpeg()).is_file())
MOQ5_BIN = find_moq5_publisher()
CANARY_RELAY = "https://34-28-164-90.sslip.io:14433/moq-relay"


class ClassifyNeverBareEioTests(unittest.TestCase):
    def test_agent_except_path_webcam_oserror(self) -> None:
        err = classify_job_exception(
            OSError(5, "Input/output error"),
            media_path="device:webcam",
            role="camera",
        )
        self.assertIn("camera I/O error", err)
        self.assertFalse(is_bare_eio_message(err))

    def test_agent_except_path_runtime_bare_eio(self) -> None:
        err = classify_job_exception(
            RuntimeError("[Errno 5] Input/output error"),
            media_path="device:webcam",
        )
        self.assertFalse(is_bare_eio_message(err))
        # After the webcam broker, bare EIO is the publisher pipe, not the camera.
        self.assertIn("ffmpeg I/O error", err)
        self.assertNotIn("camera I/O error", err)

    def test_avfoundation_token_is_camera_not_pipe(self) -> None:
        err = classify_job_exception(
            RuntimeError("Error opening input files: Input/output error avfoundation"),
            media_path="device:webcam",
        )
        self.assertIn("camera I/O error", err)
        self.assertNotIn("closed publisher pipe", err)

    def test_brokered_udp_bare_eio_is_pipe(self) -> None:
        err = classify_job_exception(
            OSError(5, "Input/output error"),
            media_path="udp://127.0.0.1:50123?timeout=15000000",
            role="ffmpeg",
        )
        self.assertIn("ffmpeg I/O error", err)
        self.assertIn("closed publisher pipe", err)

    def test_pipe_eio_prefers_publisher_stderr(self) -> None:
        shown = combine_ffmpeg_closed_pipe_error(
            "ffmpeg exited with code 141: Error writing trailer: Broken pipe",
            "waiting for ftyp+moov before sender attach\nendpoint connect failed: -2",
            backend="moq5",
            code=1,
        )
        self.assertIn("endpoint connect failed", shown)
        self.assertFalse(is_bare_eio_message(shown))
        self.assertTrue(
            looks_like_closed_pipe_eio("Error writing trailer: Input/output error pipe:1")
        )


@unittest.skipUnless(HAS_FFMPEG, "requires a local ffmpeg build")
class DelayedPublisherPipeTests(unittest.TestCase):
    def _ffmpeg_fmp4_cmd(self) -> list[str]:
        return [
            find_ffmpeg(),
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x180:rate=30",
            "-t",
            "2",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+frag_keyframe+empty_moov+default_base_moof+separate_moof",
            "-f",
            "mp4",
            "pipe:1",
        ]

    def test_reader_started_first_avoids_eio(self) -> None:
        reader = subprocess.Popen(
            ["cat"],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        ffmpeg = subprocess.Popen(
            self._ffmpeg_fmp4_cmd(),
            stdout=reader.stdin,
            stderr=subprocess.PIPE,
        )
        if reader.stdin is not None:
            reader.stdin.close()
        ffmpeg_code = ffmpeg.wait(timeout=15)
        reader.wait(timeout=5)
        stderr = (ffmpeg.stderr.read() if ffmpeg.stderr else b"").decode(
            "utf-8", errors="replace"
        )
        self.assertEqual(ffmpeg_code, 0, stderr)
        self.assertNotIn("Input/output error", stderr)

    def test_dead_reader_is_closed_pipe_not_bare_errno(self) -> None:
        reader = subprocess.Popen(
            ["sh", "-c", "exit 1"],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        ffmpeg = subprocess.Popen(
            self._ffmpeg_fmp4_cmd(),
            stdout=reader.stdin,
            stderr=subprocess.PIPE,
        )
        if reader.stdin is not None:
            reader.stdin.close()
        reader.wait(timeout=5)
        ffmpeg.wait(timeout=15)
        stderr = (ffmpeg.stderr.read() if ffmpeg.stderr else b"").decode(
            "utf-8", errors="replace"
        )
        combined = f"ffmpeg exited with code {ffmpeg.returncode}: {stderr} pipe:1"
        self.assertNotEqual(ffmpeg.returncode, 0)
        self.assertTrue(
            looks_like_closed_pipe_eio(combined)
            or "Broken pipe" in stderr
            or "Input/output error" in stderr
            or ffmpeg.returncode in (141, 1, 255),
            stderr,
        )
        classified = combine_ffmpeg_closed_pipe_error(
            combined,
            "waiting for ftyp+moov before sender attach\nstdin EOF before ftyp box",
            backend="moq5",
            code=1,
        )
        self.assertFalse(is_bare_eio_message(classified))
        self.assertIn("ftyp", classified)


@unittest.skipUnless(HAS_FFMPEG and MOQ5_BIN, "requires ffmpeg and moq5-fmp4-publish")
class WebcamBitrateDelayedAttachTests(unittest.TestCase):
    """Realtime lavfi at webcam bitrate into moq5 while CONNECT is delayed.

    empty_moov is immediate; attach then sleeps MOQ5_CONNECT_DELAY_MS. Without
    a stdin reader thread the ~64KiB OS pipe fills and ffmpeg gets EIO.
    """

    def _lavfi_webcam_cmd(self, duration_sec: float = 4.0) -> list[str]:
        return [
            find_ffmpeg(),
            "-hide_banner",
            "-loglevel",
            "error",
            "-re",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=1280x720:rate=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:sample_rate=48000",
            "-t",
            str(duration_sec),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-pix_fmt",
            "yuv420p",
            "-b:v",
            "5250k",
            "-maxrate",
            "6000k",
            "-bufsize",
            "6000k",
            "-g",
            "30",
            "-keyint_min",
            "30",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+frag_keyframe+empty_moov+default_base_moof+separate_moof",
            "-f",
            "mp4",
            "pipe:1",
        ]

    def test_delayed_attach_drains_stdin_no_eio(self) -> None:
        env = os.environ.copy()
        env["MOQ5_CONNECT_DELAY_MS"] = "2000"
        publisher = subprocess.Popen(
            [
                MOQ5_BIN,
                "https://127.0.0.1:1/moq-relay",
                "bench-pipe-drain",
                "--insecure-skip-verify",
                "--duration",
                "8",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            env=env,
        )
        ffmpeg = subprocess.Popen(
            self._lavfi_webcam_cmd(4.0),
            stdout=publisher.stdin,
            stderr=subprocess.PIPE,
        )
        if publisher.stdin is not None:
            publisher.stdin.close()

        # During the 2s attach delay ffmpeg must stay alive (pipe not closed).
        time.sleep(1.5)
        self.assertIsNone(ffmpeg.poll(), "ffmpeg died while moq5 delayed CONNECT — pipe filled")
        ffmpeg_code = ffmpeg.wait(timeout=20)
        pub_code = publisher.wait(timeout=20)
        ffmpeg_err = (ffmpeg.stderr.read() if ffmpeg.stderr else b"").decode(
            "utf-8", errors="replace"
        )
        pub_err = (publisher.stderr.read() if publisher.stderr else b"").decode(
            "utf-8", errors="replace"
        )
        self.assertNotIn("Input/output error", ffmpeg_err, ffmpeg_err + "\n" + pub_err)
        self.assertNotIn("Broken pipe", ffmpeg_err, ffmpeg_err)
        self.assertIn("waiting for ftyp+moov before sender attach", pub_err)
        self.assertIn("attaching sender after CMAF init", pub_err)
        self.assertIn("MOQ5_CONNECT_DELAY_MS=2000", pub_err)
        # libmoq CONNECT is async: a dead URL still returns a sender. Success
        # here is moov + connection_id + vide_1 with no encoder I/O error.
        self.assertIn("connection_id=", pub_err)
        self.assertIn("vide_1", pub_err)
        self.assertIn(ffmpeg_code, (0, 141, 1, 255), ffmpeg_err)
        self.assertIsNotNone(pub_code)

    def test_live_canary_delayed_attach_gets_vide_1(self) -> None:
        if os.environ.get("MOQ5_LIVE_PIPE_TEST", "").strip() not in {"1", "true", "yes"}:
            self.skipTest("set MOQ5_LIVE_PIPE_TEST=1 to hit west :14433")
        env = os.environ.copy()
        env["MOQ5_CONNECT_DELAY_MS"] = "2000"
        ns = f"bench-pipe-{os.getpid()}"
        publisher = subprocess.Popen(
            [
                MOQ5_BIN,
                CANARY_RELAY,
                ns,
                "--insecure-skip-verify",
                "--duration",
                "8",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            env=env,
        )
        ffmpeg = subprocess.Popen(
            self._lavfi_webcam_cmd(5.0),
            stdout=publisher.stdin,
            stderr=subprocess.PIPE,
        )
        if publisher.stdin is not None:
            publisher.stdin.close()
        time.sleep(1.5)
        self.assertIsNone(ffmpeg.poll(), "ffmpeg died during delayed attach")
        ffmpeg.wait(timeout=25)
        publisher.wait(timeout=25)
        ffmpeg_err = (ffmpeg.stderr.read() if ffmpeg.stderr else b"").decode(
            "utf-8", errors="replace"
        )
        pub_err = (publisher.stderr.read() if publisher.stderr else b"").decode(
            "utf-8", errors="replace"
        )
        self.assertNotIn("Input/output error", ffmpeg_err, ffmpeg_err + "\n" + pub_err)
        self.assertIn("attaching sender after CMAF init", pub_err)
        self.assertIn("connection_id=", pub_err)
        self.assertIn("vide_1", pub_err)


if __name__ == "__main__":
    unittest.main()
