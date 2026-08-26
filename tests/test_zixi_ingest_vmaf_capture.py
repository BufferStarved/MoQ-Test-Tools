"""Zixi ingest VMAF must capture HTTP-TS during the job, not after it ends."""

from __future__ import annotations

import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "web" / "api"))
sys.path.insert(0, str(ROOT / "ingest_agent"))


class FindDistortedRecordingTests(unittest.TestCase):
    def test_prefers_job_http_ts_capture(self) -> None:
        from vmaf_service import find_distorted_recording, job_dir

        with tempfile.TemporaryDirectory() as tmp:
            with patch("vmaf_service.WORK_DIR", tmp), patch(
                "vmaf_service.RECORDING_DIR", str(Path(tmp) / "recordings")
            ):
                capture = job_dir("job-rtmp") / "http-ts-capture.ts"
                capture.parent.mkdir(parents=True)
                capture.write_bytes(b"\x47" + b"\x00" * 200)
                found = find_distorted_recording(
                    1.0,
                    10.0,
                    recording_dir=str(Path(tmp) / "zixi_broadcaster-linux64"),
                    job_id="job-rtmp",
                )
        self.assertEqual(found, str(capture))

    def test_does_not_walk_zixi_install_tree(self) -> None:
        from vmaf_service import find_distorted_recording

        with tempfile.TemporaryDirectory() as tmp:
            install = Path(tmp) / "zixi_broadcaster-linux64"
            decoy = install / "unrelated.ts"
            decoy.parent.mkdir(parents=True)
            decoy.write_bytes(b"\x47" + b"\x00" * 400)
            found = find_distorted_recording(
                1.0,
                10.0,
                recording_dir=str(install),
                job_id="job-missing",
            )
        self.assertIsNone(found)

    def test_compute_vmaf_fails_without_capture_instead_of_pulling(self) -> None:
        from vmaf_service import compute_vmaf, job_dir

        with tempfile.TemporaryDirectory() as tmp:
            with patch("vmaf_service.WORK_DIR", tmp), patch(
                "vmaf_service.RECORDING_DIR", str(Path(tmp) / "recordings")
            ), patch("vmaf_service._resolve_ffmpeg", return_value="/usr/bin/ffmpeg"):
                ref = job_dir("job-empty") / "reference.mp4"
                ref.parent.mkdir(parents=True)
                ref.write_bytes(b"ref")
                state = compute_vmaf(
                    "job-empty",
                    1.0,
                    10.0,
                    recording_dir=str(Path(tmp) / "zixi_broadcaster-linux64"),
                    http_ts_url="http://127.0.0.1:7777/benchmark.ts",
                )
        self.assertEqual(state.status, "failed")
        self.assertIn("during-job capture", state.error)
        self.assertNotIn("HTTP-TS pull", state.error)

    def test_libvmaf_uses_one_nice_thread_and_short_timeout(self) -> None:
        from vmaf_service import (
            VMAF_FFMPEG_TIMEOUT_SEC,
            VMAF_N_THREADS,
            compute_vmaf,
            job_dir,
        )

        self.assertEqual(VMAF_N_THREADS, 1)
        self.assertLessEqual(VMAF_FFMPEG_TIMEOUT_SEC, 180)
        with tempfile.TemporaryDirectory() as tmp:
            with patch("vmaf_service.WORK_DIR", tmp), patch(
                "vmaf_service.RECORDING_DIR", str(Path(tmp) / "recordings")
            ), patch("vmaf_service._resolve_ffmpeg", return_value="/usr/bin/ffmpeg"), patch(
                "vmaf_service.subprocess.run",
                side_effect=TimeoutError("should not reach"),
            ) as run:
                ref = job_dir("job-cap") / "reference.mp4"
                cap = job_dir("job-cap") / "http-ts-capture.ts"
                ref.parent.mkdir(parents=True)
                ref.write_bytes(b"ref")
                cap.write_bytes(b"\x47" + b"\x00" * 200)
                # Fail before ffmpeg if recording wait is skipped and parse fails —
                # we only need to see the command that would have been run.
                run.side_effect = None
                run.return_value = type(
                    "Completed",
                    (),
                    {"returncode": 1, "stderr": "nope", "stdout": ""},
                )()
                state = compute_vmaf("job-cap", 1.0, 10.0, recording_dir=str(Path(tmp) / "rec"))
        self.assertEqual(state.status, "failed")
        self.assertTrue(run.called)
        cmd = run.call_args.args[0]
        lavfi = next(part for part in cmd if "libvmaf" in part)
        self.assertIn("n_threads=1", lavfi)
        self.assertEqual(run.call_args.kwargs["timeout"], 180)
        self.assertTrue(callable(run.call_args.kwargs.get("preexec_fn")))

    def test_start_compute_vmaf_returns_before_ffmpeg(self) -> None:
        from vmaf_service import start_compute_vmaf

        started = threading.Event()
        release = threading.Event()

        def _block(*_args, **_kwargs):
            started.set()
            release.wait(2)
            from vmaf_service import VmafJobState

            return VmafJobState(job_id="job-async", status="completed", vmaf_score=70.0)

        with patch("vmaf_service.compute_vmaf", side_effect=_block):
            state = start_compute_vmaf("job-async", 1.0, 10.0)
            self.assertEqual(state.status, "computing")
            self.assertTrue(started.wait(1))
            release.set()
            deadline = time.time() + 2
            from vmaf_service import get_vmaf_state

            while time.time() < deadline:
                live = get_vmaf_state("job-async")
                if live and live.status == "completed":
                    self.assertEqual(live.vmaf_score, 70.0)
                    return
                time.sleep(0.05)
            self.fail("background VMAF did not finish")


class PrepareRemoteVmafTests(unittest.TestCase):
    def test_zixi_starts_http_ts_capture_after_reference(self) -> None:
        from job_manager import JobManager, JobStatus, UploadJobRecord

        job = SimpleNamespace(
            destination=SimpleNamespace(
                protocol="rtmp",
                moq_target=None,
                ingest_provider="gcp_zixi",
                url="rtmp://35.222.33.58:1935/live/benchmark",
                preset_id="moq_zixi_gcp_rtmp",
            ),
            media_path="/tmp/dummy.mp4",
            ingest_agent_url="http://35.222.33.58:8090",
            ingest_recording_dir="/opt/zixi_broadcaster-linux64",
            duration_sec=28,
            zixi_playback_stream_id="benchmark",
            zixi_stream_id="",
        )
        job.managed_zixi_stream_id = lambda: "benchmark"

        manager = JobManager.__new__(JobManager)
        manager._lock = __import__("threading").Lock()
        manager._jobs = {
            "job-zixi": UploadJobRecord(
                id="job-zixi",
                status=JobStatus.RUNNING,
                protocol="rtmp",
                endpoint_url=job.destination.url,
                media_path=job.media_path,
                duration_sec=28,
                preview_ready=True,
            )
        }
        captured = {}

        def _update(job_id, **kwargs):
            captured.setdefault("updates", []).append(kwargs)

        manager._update = _update
        with patch("job_manager.prepare_reference_via_agent", return_value=None), patch(
            "job_manager.start_http_ts_capture_via_agent",
            return_value=None,
        ) as start_capture, patch(
            "job_manager.start_moq_recording_via_agent"
        ) as start_moq:
            manager._prepare_remote_vmaf("job-zixi", job)

        start_moq.assert_not_called()
        start_capture.assert_called_once()
        kwargs = start_capture.call_args.kwargs
        self.assertEqual(kwargs["http_ts_url"], "http://127.0.0.1:7777/benchmark.ts")
        self.assertEqual(kwargs["duration_sec"], 28)

    def test_mediamtx_does_not_start_http_ts_capture(self) -> None:
        from job_manager import JobManager

        job = SimpleNamespace(
            destination=SimpleNamespace(
                protocol="srt",
                moq_target=None,
                ingest_provider="gcp_mediamtx",
                url="srt://34.9.217.178:8890",
                preset_id="moq_mediamtx_gcp_srt",
            ),
            media_path="/tmp/dummy.mp4",
            ingest_agent_url="http://34.9.217.178:8090",
            ingest_recording_dir="",
            duration_sec=28,
            zixi_playback_stream_id="",
            zixi_stream_id="",
        )
        manager = JobManager.__new__(JobManager)
        manager._lock = __import__("threading").Lock()
        manager._jobs = {}
        manager._update = MagicMock()
        with patch("job_manager.prepare_reference_via_agent", return_value=None), patch(
            "job_manager.start_http_ts_capture_via_agent"
        ) as start_capture:
            manager._prepare_remote_vmaf("job-srt", job)
        start_capture.assert_not_called()


if __name__ == "__main__":
    unittest.main()
