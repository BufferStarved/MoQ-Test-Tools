"""Round-trip serialization for local publisher agent ↔ API."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from destinations import DestinationProfile  # noqa: E402
from moq_publish import MoqPublishTarget, build_moq5_publisher_cmd  # noqa: E402
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
            target_latency_ms=2500,
            publisher_host="local",
            encoder="obs",
            dest_count=6,
        )
        payload = upload_job_to_dict(job)
        self.assertEqual(payload["protocol_version"], PROTOCOL_VERSION)
        self.assertEqual(payload["media_path"], "device:webcam")
        self.assertEqual(payload["publisher_host"], "local")
        self.assertEqual(payload["encoder"], "obs")
        self.assertEqual(payload["dest_count"], 6)

        restored = upload_job_from_dict(payload)
        self.assertEqual(restored.media_path, "device:webcam")
        self.assertEqual(restored.job_id, "job-abc")
        self.assertEqual(restored.publisher_host, "local")
        self.assertEqual(restored.encoder, "obs")
        self.assertEqual(restored.dest_count, 6)
        self.assertEqual(restored.encode_ladder, "1080p")
        self.assertEqual(restored.target_latency_ms, 2500)
        self.assertEqual(restored.destination.preset_id, "moq_mediamtx_gcp_srt")
        self.assertEqual(
            restored.destination.url,
            "srt://34.9.217.178:8890?mode=caller&streamid=publish:benchmark",
        )
        self.assertIn("publish:benchmark", restored.destination.url)
        self.assertNotIn("SRT Test", restored.destination.url)
        self.assertNotIn("SRT%20Test", restored.destination.url)

    def test_helper_zixi_srt_roundtrip_attaches_streamid(self) -> None:
        dest = DestinationProfile(
            protocol="srt",
            url="srt://35.222.33.58:10080?mode=caller&latency=200000",
            label="Zixi Central",
            preset_id="moq_zixi_gcp",
        )
        payload = destination_to_dict(dest)
        self.assertIn("streamid=", payload["url"])
        self.assertIn("SRT%20Test", payload["url"])
        self.assertIn("m=publish", payload["url"])
        restored = destination_from_dict(payload)
        self.assertIn("streamid=", restored.url)
        self.assertIn("SRT%20Test", restored.url)
        from_dict = destination_from_dict(
            {
                "protocol": "srt",
                "url": "srt://35.222.33.58:10080?mode=caller&latency=200000",
                "preset_id": "moq_zixi_gcp",
            }
        )
        self.assertIn("streamid=", from_dict.url)
        self.assertIn("SRT%20Test", from_dict.url)

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

    def test_helper_sslip_draft18_recovers_insecure_and_draft(self) -> None:
        """Laptop agent must not default draft=16 or drop --insecure-skip-verify."""
        restored = destination_from_dict(
            {
                "protocol": "moq",
                "url": "https://34-28-164-90.sslip.io:14433/moq-relay?namespace=benchmark&draft=18",
                "preset_id": "moq_gcp_relay_d18",
                "moq_target": {
                    "endpoint": "https://34-28-164-90.sslip.io:14433/moq-relay",
                    "namespace": "bench-helper",
                    "transport": "webtransport",
                    "forward": 1,
                },
            }
        )
        self.assertIsNotNone(restored.moq_target)
        assert restored.moq_target is not None
        self.assertEqual(restored.moq_target.draft, 18)
        self.assertTrue(restored.moq_target.insecure_tls)

    def test_helper_explicit_insecure_false_still_skips_sslip_verify(self) -> None:
        restored = destination_from_dict(
            {
                "protocol": "moq",
                "url": "https://66-228-49-113.sslip.io:14433/moq-relay?draft=18",
                "moq_target": {
                    "endpoint": "https://66-228-49-113.sslip.io:14433/moq-relay",
                    "namespace": "benchmark",
                    "draft": 18,
                    "insecure_tls": False,
                },
            }
        )
        assert restored.moq_target is not None
        self.assertTrue(restored.moq_target.insecure_tls)

    def test_helper_east_sslip_cmd_includes_insecure_skip_verify(self) -> None:
        """GCP East :14433 helper reconstruction must keep skip-verify on argv."""
        restored = destination_from_dict(
            {
                "protocol": "moq",
                "url": "https://34-138-137-211.sslip.io:14433/moq-relay?namespace=benchmark&draft=18",
                "preset_id": "moq_gcp_east_relay_d18",
                "moq_target": {
                    "endpoint": "https://34-138-137-211.sslip.io:14433/moq-relay",
                    "namespace": "bench-helper",
                    "transport": "webtransport",
                    "draft": 18,
                    "insecure_tls": False,
                },
            }
        )
        self.assertIsNotNone(restored.moq_target)
        assert restored.moq_target is not None
        self.assertEqual(restored.moq_target.draft, 18)
        self.assertTrue(restored.moq_target.insecure_tls)
        cmd = build_moq5_publisher_cmd(
            "/Users/sean/Developer/moq-test-tools/tools/moq5-publisher/bin/moq5-fmp4-publish",
            restored.moq_target,
            duration_sec=60,
        )
        self.assertIn("--insecure-skip-verify", cmd)
        self.assertEqual(cmd[1], "https://34-138-137-211.sslip.io:14433/moq-relay")

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
