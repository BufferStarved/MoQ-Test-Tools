"""Round-trip serialization for local publisher agent ↔ API."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from destinations import DestinationProfile  # noqa: E402
from moq_publish import MoqPublishTarget  # noqa: E402
from publisher_protocol import (  # noqa: E402
    PROTOCOL_VERSION,
    destination_from_dict,
    destination_to_dict,
    result_from_dict,
    result_to_dict,
    sample_to_dict,
    upload_job_from_dict,
    upload_job_to_dict,
)
from upload_service import UploadJob, UploadResult, UploadSample  # noqa: E402


class PublisherProtocolTests(unittest.TestCase):
    def test_job_roundtrip_preserves_local_fields(self) -> None:
        job = UploadJob(
            media_path="device:webcam",
            destination=DestinationProfile(
                protocol="srt",
                url="srt://34.9.217.178:8890?mode=caller&streamid=publish:benchmark",
                label="MediaMTX SRT",
                preset_id="moq_mediamtx_gcp_srt",
                ingest_provider="gcp_mediamtx",
            ),
            duration_sec=12,
            job_id="job-abc",
            comparison_id="cmp-1",
            stream_index=1,
            stream_label="A",
            encode_ladder="1080p",
            target_latency_ms=1000,
            publisher_host="local",
        )
        payload = upload_job_to_dict(job)
        self.assertEqual(payload["protocol_version"], PROTOCOL_VERSION)
        self.assertEqual(payload["media_path"], "device:webcam")
        self.assertEqual(payload["publisher_host"], "local")

        restored = upload_job_from_dict(payload)
        self.assertEqual(restored.media_path, "device:webcam")
        self.assertEqual(restored.job_id, "job-abc")
        self.assertEqual(restored.publisher_host, "local")
        self.assertEqual(restored.encode_ladder, "1080p")
        self.assertEqual(restored.target_latency_ms, 1000)
        self.assertEqual(restored.destination.preset_id, "moq_mediamtx_gcp_srt")
        self.assertEqual(
            restored.destination.url,
            "srt://34.9.217.178:8890?mode=caller&streamid=publish:benchmark",
        )

    def test_destination_moq_target_roundtrip(self) -> None:
        dest = DestinationProfile(
            protocol="moq",
            url="https://example.sslip.io/moq",
            preset_id="moq_openmoq",
            moq_target=MoqPublishTarget(
                endpoint="https://example.sslip.io/moq",
                namespace="benchmark",
                transport="webtransport",
                draft=16,
                forward=1,
                insecure_tls=True,
            ),
        )
        restored = destination_from_dict(destination_to_dict(dest))
        self.assertIsNotNone(restored.moq_target)
        assert restored.moq_target is not None
        self.assertEqual(restored.moq_target.endpoint, "https://example.sslip.io/moq")
        self.assertTrue(restored.moq_target.insecure_tls)

    def test_sample_and_result_roundtrip(self) -> None:
        sample = UploadSample(
            elapsed_sec=3,
            encoded_bitrate_kbps=2500.0,
            fps=30.0,
            fps_stability=1.0,
            speed=1.0,
            out_time="00:00:03.000",
            cpu_percent=12.0,
            memory_mb=200.0,
            progress="continue",
            transport_rtt_ms=18.5,
        )
        sample_payload = sample_to_dict(sample)
        self.assertEqual(sample_payload["elapsed_sec"], 3)
        self.assertEqual(sample_payload["transport_rtt_ms"], 18.5)

        result = UploadResult(
            success=True,
            csv_path="/tmp/a.csv",
            summary_path="/tmp/a.json",
            encoder_vmaf_status="ok",
            encoder_vmaf_score=92.1,
        )
        restored = result_from_dict(result_to_dict(result))
        self.assertTrue(restored.success)
        self.assertEqual(restored.csv_path, "/tmp/a.csv")
        self.assertEqual(restored.encoder_vmaf_score, 92.1)

    def test_result_from_partial_payload(self) -> None:
        restored = result_from_dict({"success": False, "error": "boom"})
        self.assertFalse(restored.success)
        self.assertEqual(restored.error, "boom")
        self.assertEqual(restored.encoder_vmaf_status, "disabled")


if __name__ == "__main__":
    unittest.main()
