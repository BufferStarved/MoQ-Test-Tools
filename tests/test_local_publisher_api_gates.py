"""API gates for publisher_host=local media selection."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "web" / "api"))

os.environ.setdefault("LOCAL_PUBLISHER_ENABLED", "0")

from fastapi.testclient import TestClient  # noqa: E402

import main as api_main  # noqa: E402


class LocalPublisherApiGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(api_main.app)

    def test_features_flag_off_by_default(self) -> None:
        with patch.dict(os.environ, {"LOCAL_PUBLISHER_ENABLED": "0"}, clear=False):
            # Re-read via hub helper (status reads env live).
            resp = self.client.get("/api/features")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertFalse(body["local_publisher"])
        self.assertFalse(body["local_publisher_connected"])

    def test_local_upload_rejected_when_flag_off(self) -> None:
        with patch.dict(os.environ, {"LOCAL_PUBLISHER_ENABLED": "0"}, clear=False):
            resp = self.client.post(
                "/api/uploads",
                json={
                    "media_path": "device:webcam",
                    "preset_id": "moq_mediamtx_gcp_srt",
                    "duration_sec": 5,
                    "publisher_host": "local",
                },
            )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("not enabled", resp.json()["detail"].lower())

    def test_local_upload_rejected_without_agent(self) -> None:
        with patch.dict(os.environ, {"LOCAL_PUBLISHER_ENABLED": "1"}, clear=False):
            with patch.object(
                api_main.publisher_hub,
                "status",
                return_value={"enabled": True, "connected": False, "agents": []},
            ):
                resp = self.client.post(
                    "/api/uploads",
                    json={
                        "media_path": "device:webcam",
                        "preset_id": "moq_mediamtx_gcp_srt",
                        "duration_sec": 5,
                        "publisher_host": "local",
                    },
                )
        self.assertEqual(resp.status_code, 503)
        self.assertIn("agent", resp.json()["detail"].lower())

    def test_local_rejects_vod_and_udp(self) -> None:
        with patch.dict(os.environ, {"LOCAL_PUBLISHER_ENABLED": "1"}, clear=False):
            with patch.object(
                api_main.publisher_hub,
                "status",
                return_value={"enabled": True, "connected": True, "agents": [{"agent_id": "a"}]},
            ):
                vod = self.client.post(
                    "/api/uploads",
                    json={
                        "media_path": "dummy.mp4",
                        "preset_id": "moq_mediamtx_gcp_srt",
                        "duration_sec": 5,
                        "publisher_host": "local",
                    },
                )
                udp = self.client.post(
                    "/api/uploads",
                    json={
                        "media_path": "udp://127.0.0.1:5000",
                        "preset_id": "moq_mediamtx_gcp_srt",
                        "duration_sec": 5,
                        "publisher_host": "local",
                    },
                )
        self.assertEqual(vod.status_code, 400)
        self.assertIn("VOD", vod.json()["detail"])
        self.assertEqual(udp.status_code, 400)
        self.assertIn("UDP", udp.json()["detail"])

    def test_local_webcam_accepted_when_agent_connected(self) -> None:
        fake_record = MagicMock()
        # job_to_dict needs a real-ish record; patch create_job + job_to_dict.
        with patch.dict(os.environ, {"LOCAL_PUBLISHER_ENABLED": "1"}, clear=False):
            with patch.object(
                api_main.publisher_hub,
                "status",
                return_value={"enabled": True, "connected": True, "agents": [{"agent_id": "a"}]},
            ):
                with patch.object(
                    api_main.job_manager,
                    "create_job",
                    return_value=MagicMock(job_id="created-1"),
                ) as create_job:
                    with patch.object(
                        api_main,
                        "job_to_dict",
                        return_value={"job_id": "created-1", "status": "queued"},
                    ):
                        resp = self.client.post(
                            "/api/uploads",
                            json={
                                "media_path": "device:webcam",
                                "preset_id": "moq_mediamtx_gcp_srt",
                                "duration_sec": 8,
                                "publisher_host": "local",
                            },
                        )
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["job_id"], "created-1")
        create_job.assert_called_once()
        upload_job = create_job.call_args.args[0]
        self.assertEqual(upload_job.media_path, "device:webcam")
        self.assertEqual(upload_job.publisher_host, "local")

    def test_local_file_must_exist(self) -> None:
        with patch.dict(os.environ, {"LOCAL_PUBLISHER_ENABLED": "1"}, clear=False):
            with patch.object(
                api_main.publisher_hub,
                "status",
                return_value={"enabled": True, "connected": True, "agents": [{"agent_id": "a"}]},
            ):
                resp = self.client.post(
                    "/api/uploads",
                    json={
                        "media_path": "/tmp/does-not-exist-moq-local-qa.mp4",
                        "preset_id": "moq_mediamtx_gcp_srt",
                        "duration_sec": 5,
                        "publisher_host": "local",
                    },
                )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("not found", resp.json()["detail"].lower())

    def test_local_existing_file_accepted(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as handle:
            handle.write(b"fake")
            path = handle.name
        try:
            with patch.dict(os.environ, {"LOCAL_PUBLISHER_ENABLED": "1"}, clear=False):
                with patch.object(
                    api_main.publisher_hub,
                    "status",
                    return_value={
                        "enabled": True,
                        "connected": True,
                        "agents": [{"agent_id": "a"}],
                    },
                ):
                    with patch.object(
                        api_main.job_manager,
                        "create_job",
                        return_value=MagicMock(job_id="file-1"),
                    ) as create_job:
                        with patch.object(
                            api_main,
                            "job_to_dict",
                            return_value={"job_id": "file-1", "status": "queued"},
                        ):
                            with patch.object(
                                api_main,
                                "probe_media_duration_sec",
                                return_value=10,
                            ):
                                resp = self.client.post(
                                    "/api/uploads",
                                    json={
                                        "media_path": path,
                                        "preset_id": "moq_mediamtx_gcp_srt",
                                        "duration_sec": 5,
                                        "publisher_host": "local",
                                    },
                                )
            self.assertEqual(resp.status_code, 200, resp.text)
            upload_job = create_job.call_args.args[0]
            self.assertEqual(Path(upload_job.media_path).resolve(), Path(path).resolve())
            self.assertEqual(upload_job.publisher_host, "local")
        finally:
            Path(path).unlink(missing_ok=True)

    def test_media_upload_endpoint(self) -> None:
        files = {"file": ("clip.mp4", b"not-really-mp4", "video/mp4")}
        resp = self.client.post("/api/media/upload", files=files)
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertTrue(body["media_path"])
        self.assertTrue(Path(body["media_path"]).is_file())
        Path(body["media_path"]).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
