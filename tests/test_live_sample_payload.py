"""Live /api/uploads samples must keep net_* and encode_lag_ms."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "web" / "api"))

from destinations import DestinationProfile  # noqa: E402
from job_manager import live_sample_payload  # noqa: E402
from upload_service import UploadJob, UploadSample, UploadService  # noqa: E402


class LiveSamplePayloadTests(unittest.TestCase):
    def test_aliases_transport_fields_onto_net_keys(self) -> None:
        sample = UploadSample(
            elapsed_sec=3,
            encoded_bitrate_kbps=2500,
            fps=30,
            fps_stability=1.0,
            speed=1.0,
            out_time="00:00:03.000000",
            cpu_percent=10,
            memory_mb=100,
            progress="continue",
            encoder_send_rate_mbps=2.4,
            transport_recv_rate_mbps=2.1,
            transport_rtt_ms=18.5,
            encode_lag_ms=12.0,
        )
        payload = live_sample_payload(sample)
        self.assertEqual(payload["net_send_mbps"], 2.4)
        self.assertEqual(payload["net_recv_mbps"], 2.1)
        self.assertEqual(payload["net_rtt_ms"], 18.5)
        self.assertEqual(payload["encode_lag_ms"], 12.0)

    def test_keeps_explicit_net_fields(self) -> None:
        sample = UploadSample(
            elapsed_sec=1,
            encoded_bitrate_kbps=1000,
            fps=30,
            fps_stability=1.0,
            speed=1.0,
            out_time="00:00:01.000000",
            cpu_percent=1,
            memory_mb=10,
            progress="continue",
            net_send_mbps=3.0,
            encoder_send_rate_mbps=9.0,
            encode_lag_ms=0.0,
        )
        payload = live_sample_payload(sample)
        self.assertEqual(payload["net_send_mbps"], 3.0)
        self.assertIn("encode_lag_ms", payload)


class PathRttProbePortTests(unittest.TestCase):
    def test_zixi_srt_probes_ingest_agent(self) -> None:
        job = UploadJob(
            media_path="/tmp/x.mp4",
            destination=DestinationProfile(
                protocol="srt",
                url="srt://35.196.215.179:10080?mode=caller&latency=200000",
                ingest_provider="gcp_east_zixi",
            ),
            duration_sec=5,
            ingest_agent_url="http://35.196.215.179:8090",
        )
        probe = UploadService()._path_rtt_probe_for_job(job)
        self.assertIsNotNone(probe)
        self.assertEqual(probe._port, 8090)
        self.assertEqual(probe._host, "35.196.215.179")

    def test_remote_whip_probes_signaling_port(self) -> None:
        job = UploadJob(
            media_path="/tmp/x.mp4",
            destination=DestinationProfile(
                protocol="webrtc",
                url="http://35.196.97.22:8889/benchmark/whip",
                ingest_provider="gcp_east_mediamtx",
            ),
            duration_sec=5,
        )
        probe = UploadService()._path_rtt_probe_for_job(job)
        self.assertIsNotNone(probe)
        self.assertEqual(probe._port, 8889)


if __name__ == "__main__":
    unittest.main()
