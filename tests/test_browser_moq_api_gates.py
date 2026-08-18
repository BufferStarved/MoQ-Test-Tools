"""API gates for publisher_host=browser (in-page WASM MoQ publisher)."""

from __future__ import annotations

import csv
import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

ROOT = __import__("pathlib").Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "web" / "api"))

os.environ.setdefault("LOCAL_PUBLISHER_ENABLED", "0")

import main as api_main  # noqa: E402
from moq_publish import DEVICE_BROWSER_MEDIA, is_device_browser_source, is_live_media_source  # noqa: E402


class BrowserMoqSourceHelpersTests(unittest.TestCase):
    def test_detects_browser_source(self) -> None:
        self.assertTrue(is_device_browser_source(DEVICE_BROWSER_MEDIA))
        self.assertTrue(is_device_browser_source("device:browser"))
        self.assertFalse(is_device_browser_source("device:webcam"))
        self.assertFalse(is_device_browser_source("dummy.mp4"))

    def test_live_includes_browser(self) -> None:
        self.assertTrue(is_live_media_source("device:browser"))


class BrowserMoqApiGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(api_main.app)

    def test_browser_moq_accepted(self) -> None:
        with patch.object(
            api_main.job_manager,
            "create_job",
            return_value=MagicMock(job_id="browser-1"),
        ) as create_job:
            with patch.object(
                api_main,
                "job_to_dict",
                return_value={"id": "browser-1", "status": "pending"},
            ):
                resp = self.client.post(
                    "/api/uploads",
                    json={
                        "media_path": "device:browser",
                        "preset_id": "moq_gcp_relay",
                        "duration_sec": 8,
                        "publisher_host": "browser",
                        "compute_vmaf_on_ingest": False,
                        "compute_vmaf_encoder": True,
                    },
                )
        self.assertEqual(resp.status_code, 200, resp.text)
        job = create_job.call_args.args[0]
        self.assertEqual(job.media_path, "device:browser")
        self.assertEqual(job.publisher_host, "browser")
        self.assertFalse(job.compute_vmaf_encoder)
        self.assertFalse(job.compute_vmaf_on_ingest)

    def test_browser_allows_ingest_vmaf_not_encoder(self) -> None:
        with patch.object(api_main, "vmaf_available_for_endpoint", return_value=True):
            with patch.object(
                api_main.job_manager,
                "create_job",
                return_value=MagicMock(job_id="browser-vmaf"),
            ) as create_job:
                with patch.object(
                    api_main,
                    "job_to_dict",
                    return_value={"id": "browser-vmaf", "status": "pending"},
                ):
                    resp = self.client.post(
                        "/api/uploads",
                        json={
                            "media_path": "device:browser",
                            "preset_id": "moq_gcp_relay",
                            "duration_sec": 8,
                            "publisher_host": "browser",
                            "compute_vmaf_on_ingest": True,
                            "compute_vmaf_encoder": True,
                        },
                    )
        self.assertEqual(resp.status_code, 200, resp.text)
        job = create_job.call_args.args[0]
        self.assertTrue(job.compute_vmaf_on_ingest)
        self.assertFalse(job.compute_vmaf_encoder)

    def test_browser_rejects_rtmp(self) -> None:
        resp = self.client.post(
            "/api/uploads",
            json={
                "media_path": "device:browser",
                "preset_id": "moq_zixi_gcp_rtmp",
                "duration_sec": 8,
                "publisher_host": "browser",
            },
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("WebRTC", resp.json()["detail"])

    def test_browser_accepts_webrtc_whip(self) -> None:
        with patch.object(
            api_main.job_manager,
            "create_job",
            return_value=MagicMock(job_id="browser-whip"),
        ) as create_job:
            with patch.object(
                api_main,
                "job_to_dict",
                return_value={"id": "browser-whip", "status": "pending"},
            ):
                resp = self.client.post(
                    "/api/uploads",
                    json={
                        "media_path": "device:browser",
                        "protocol": "webrtc",
                        "endpoint_url": "http://127.0.0.1:8889/benchmark/whip",
                        "duration_sec": 8,
                        "publisher_host": "browser",
                    },
                )
        self.assertEqual(resp.status_code, 200, resp.text)
        job = create_job.call_args.args[0]
        self.assertEqual(job.destination.protocol, "webrtc")
        self.assertEqual(job.publisher_host, "browser")

    def test_file_whip_strips_encoder_vmaf(self) -> None:
        with patch.object(
            api_main.job_manager,
            "create_job",
            return_value=MagicMock(job_id="whip-vmaf"),
        ) as create_job:
            with patch.object(
                api_main,
                "job_to_dict",
                return_value={"id": "whip-vmaf", "status": "pending"},
            ):
                resp = self.client.post(
                    "/api/uploads",
                    json={
                        "media_path": "dummy.mp4",
                        "preset_id": "moq_mediamtx_gcp_whip",
                        "duration_sec": 8,
                        "compute_vmaf_encoder": True,
                    },
                )
        self.assertEqual(resp.status_code, 200, resp.text)
        job = create_job.call_args.args[0]
        self.assertEqual(job.destination.protocol, "webrtc")
        self.assertFalse(job.compute_vmaf_encoder)

    def test_webrtc_sdp_rejects_non_signaling_url(self) -> None:
        resp = self.client.post(
            "/api/webrtc/sdp",
            params={"url": "http://example.com/not-signaling"},
            content=b"v=0",
        )
        self.assertEqual(resp.status_code, 400)

    def test_browser_rejects_wrong_media_path(self) -> None:
        resp = self.client.post(
            "/api/uploads",
            json={
                "media_path": "dummy.mp4",
                "preset_id": "moq_gcp_relay",
                "duration_sec": 8,
                "publisher_host": "browser",
            },
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("device:browser", resp.json()["detail"])

    def test_device_browser_requires_browser_host(self) -> None:
        resp = self.client.post(
            "/api/uploads",
            json={
                "media_path": "device:browser",
                "preset_id": "moq_gcp_relay",
                "duration_sec": 8,
                "publisher_host": "cloud",
            },
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("publisher_host=browser", resp.json()["detail"])

    def test_encode_sample_gated_to_browser_jobs(self) -> None:
        cloud = MagicMock()
        cloud.status = api_main.JobStatus.RUNNING
        cloud.publisher_host = "cloud"
        missing = self.client.post(
            "/api/uploads/missing-job/encode-sample",
            json={"elapsed_sec": 1, "encoded_bitrate_kbps": 2500, "fps": 30},
        )
        self.assertEqual(missing.status_code, 404)

        with patch.object(api_main.job_manager, "get_job", return_value=cloud):
            rejected = self.client.post(
                "/api/uploads/cloud-job/encode-sample",
                json={"elapsed_sec": 1, "encoded_bitrate_kbps": 2500, "fps": 30},
            )
        self.assertEqual(rejected.status_code, 400)
        self.assertIn("browser", rejected.json()["detail"])

        browser = MagicMock()
        browser.status = api_main.JobStatus.RUNNING
        browser.publisher_host = "browser"
        with patch.object(api_main.job_manager, "get_job", return_value=browser):
            with patch.object(
                api_main.job_manager,
                "record_browser_encode_sample",
                return_value=True,
            ) as record:
                accepted = self.client.post(
                    "/api/uploads/browser-job/encode-sample",
                    json={
                        "elapsed_sec": 2,
                        "encoded_bitrate_kbps": 2400,
                        "fps": 29.9,
                        "encoder_send_rate_mbps": 2.4,
                        "encode_lag_ms": 12,
                    },
                )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        record.assert_called_once()

    def test_encode_sample_accepts_float_elapsed_sec(self) -> None:
        """WHIP posts performance.now()/1000; Pydantic used to 422 those."""
        browser = MagicMock()
        browser.status = api_main.JobStatus.RUNNING
        browser.publisher_host = "browser"
        with patch.object(api_main.job_manager, "get_job", return_value=browser):
            with patch.object(
                api_main.job_manager,
                "record_browser_encode_sample",
                return_value=True,
            ) as record:
                accepted = self.client.post(
                    "/api/uploads/browser-job/encode-sample",
                    json={
                        "elapsed_sec": 1.37,
                        "encoded_bitrate_kbps": 1800.2,
                        "fps": 29.9,
                    },
                )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        payload = record.call_args[0][1]
        self.assertEqual(payload["elapsed_sec"], 1)

    def test_encode_sample_accepts_transport_rtt_ms(self) -> None:
        browser = MagicMock()
        browser.status = api_main.JobStatus.RUNNING
        browser.publisher_host = "browser"
        with patch.object(api_main.job_manager, "get_job", return_value=browser):
            with patch.object(
                api_main.job_manager,
                "record_browser_encode_sample",
                return_value=True,
            ) as record:
                accepted = self.client.post(
                    "/api/uploads/browser-job/encode-sample",
                    json={
                        "elapsed_sec": 3,
                        "encoded_bitrate_kbps": 2100,
                        "fps": 30,
                        "transport_rtt_ms": 42.5,
                    },
                )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        payload = record.call_args[0][1]
        self.assertEqual(payload["transport_rtt_ms"], 42.5)

    def test_publisher_ready_gated_to_browser_jobs(self) -> None:
        cloud = MagicMock()
        cloud.status = api_main.JobStatus.RUNNING
        cloud.publisher_host = "local"
        with patch.object(api_main.job_manager, "get_job", return_value=cloud):
            rejected = self.client.post("/api/uploads/local-job/publisher-ready")
        self.assertEqual(rejected.status_code, 400)

        browser = MagicMock()
        browser.status = api_main.JobStatus.RUNNING
        browser.publisher_host = "browser"
        with patch.object(api_main.job_manager, "get_job", return_value=browser):
            with patch.object(
                api_main.job_manager,
                "mark_browser_publisher_ready",
                return_value=True,
            ):
                accepted = self.client.post("/api/uploads/browser-job/publisher-ready")
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertTrue(accepted.json()["ok"])


class BrowserEncodeSamplePersistenceTests(unittest.TestCase):
    def test_stamps_media_zero_and_writes_rtt(self) -> None:
        from job_manager import JobManager, JobStatus, UploadJobRecord

        manager = JobManager()
        record = UploadJobRecord(
            id="browser-job",
            status=JobStatus.RUNNING,
            protocol="webrtc",
            endpoint_url="http://example/whip",
            media_path="device:browser",
            duration_sec=30,
            publisher_host="browser",
        )
        manager._jobs[record.id] = record
        ok = manager.record_browser_encode_sample(
            record.id,
            {
                "elapsed_sec": 2,
                "encoded_bitrate_kbps": 2200,
                "fps": 30,
                "transport_rtt_ms": 18,
                "encoder_send_rate_mbps": 2.2,
            },
        )
        self.assertTrue(ok)
        self.assertIsNotNone(record.media_zero_epoch)
        self.assertEqual(record.media_zero_epoch, record.pipeline_start_epoch)
        self.assertEqual(record.samples[0]["transport_rtt_ms"], 18)
        self.assertEqual(record.samples[0]["net_rtt_ms"], 18)
        self.assertEqual(record.samples[0]["net_send_mbps"], 2.2)

        job = MagicMock()
        job.destination.protocol = "webrtc"
        job.destination.url = "http://example/whip"
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = os.path.join(tmp, "browser.csv")
            manager._write_browser_metrics_csv(csv_path, job, record.samples)
            with open(csv_path, encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
        self.assertEqual(len(rows), 1)
        self.assertEqual(float(rows[0]["transport_rtt_ms"]), 18)
        self.assertEqual(float(rows[0]["net_rtt_ms"]), 18)


if __name__ == "__main__":
    unittest.main()
