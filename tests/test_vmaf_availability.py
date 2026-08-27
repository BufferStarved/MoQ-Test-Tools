"""MoQ ingest VMAF is available only when the recorder binary is present."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from ingest_agent_client import (  # noqa: E402
    IngestAgentConfig,
    vmaf_availability_for_endpoint,
    vmaf_available_for_endpoint,
)


class VmafAvailabilityTests(unittest.TestCase):
    def test_zixi_token_is_enough(self) -> None:
        config = IngestAgentConfig(
            base_url="http://zixi:8090",
            token="t",
            recording_dir="/opt/zixi",
            host="zixi",
        )
        with patch(
            "ingest_agent_client.resolve_ingest_agent",
            return_value=config,
        ), patch.object(
            __import__("ingest_agent_client", fromlist=["IngestAgentClient"]).IngestAgentClient,
            "health",
            return_value={"status": "ok", "libvmaf_available": True},
        ):
            ok, reason = vmaf_availability_for_endpoint(
                "srt://zixi:10080",
                preset_id="moq_zixi_gcp_east",
            )
        self.assertTrue(ok)
        self.assertEqual(reason, "")

    def test_zixi_dead_agent_is_named_fail(self) -> None:
        config = IngestAgentConfig(
            base_url="http://35.222.33.58:8090",
            token="t",
            recording_dir="/opt/zixi",
            host="35.222.33.58",
        )
        with patch(
            "ingest_agent_client.resolve_ingest_agent",
            return_value=config,
        ), patch.object(
            __import__("ingest_agent_client", fromlist=["IngestAgentClient"]).IngestAgentClient,
            "health",
            side_effect=RuntimeError("timed out"),
        ):
            ok, reason = vmaf_availability_for_endpoint(
                "rtmp://35.222.33.58:1935/live/benchmark",
                preset_id="moq_zixi_gcp_rtmp",
            )
        self.assertFalse(ok)
        self.assertIn("Zixi ingest agent unreachable at 35.222.33.58:8090", reason)

    def test_moq_requires_recorder_binary(self) -> None:
        config = IngestAgentConfig(
            base_url="http://web:8090",
            token="t",
            recording_dir="/var/lib/moq-relay-recordings",
            host="web",
        )
        health = {"moq_recorder_available": False, "moq_recorder_bin": "missing"}
        with patch(
            "ingest_agent_client.resolve_ingest_agent",
            return_value=config,
        ):
            with patch.object(
                __import__("ingest_agent_client", fromlist=["IngestAgentClient"]).IngestAgentClient,
                "health",
                return_value=health,
            ):
                ok, reason = vmaf_availability_for_endpoint(
                    "https://relay/moq-relay",
                    preset_id="moq_gcp_east_relay",
                )
        self.assertFalse(ok)
        self.assertIn("openmoq-fmp4-record", reason)
        self.assertIn("WebRTC", reason)

    def test_moq_available_when_health_reports_recorder(self) -> None:
        config = IngestAgentConfig(
            base_url="http://web:8090",
            token="t",
            recording_dir="/var/lib/moq-relay-recordings",
            host="web",
        )
        with patch(
            "ingest_agent_client.resolve_ingest_agent",
            return_value=config,
        ):
            with patch.object(
                __import__("ingest_agent_client", fromlist=["IngestAgentClient"]).IngestAgentClient,
                "health",
                return_value={"moq_recorder_available": True},
            ):
                self.assertTrue(
                    vmaf_available_for_endpoint(
                        "https://relay/moq-relay",
                        preset_id="moq_gcp_east_relay",
                    )
                )

    def test_compute_vmaf_polls_until_complete(self) -> None:
        from ingest_agent_client import IngestAgentClient

        client = IngestAgentClient(
            IngestAgentConfig(
                base_url="http://zixi:8090",
                token="t",
                recording_dir="/opt/zixi",
                host="zixi",
            )
        )
        replies = [
            {"status": "computing"},
            {"status": "computing"},
            {
                "status": "completed",
                "vmaf_score": 71.7,
                "psnr_db": None,
                "ssim": None,
                "distorted_path": "/tmp/cap.ts",
                "reference_path": "/tmp/ref.mp4",
                "log_path": "/tmp/vmaf.json",
            },
        ]

        def _request(method, path, **kwargs):
            self.assertIn(method, {"POST", "GET"})
            if method == "POST":
                self.assertLessEqual(kwargs.get("timeout", 99), 20)
            return replies.pop(0)

        with patch.object(client, "_request", side_effect=_request):
            with patch("ingest_agent_client.time.sleep"):
                result = client.compute_vmaf("job-1", 1.0, 10.0)
        self.assertEqual(result.vmaf_score, 71.7)
        self.assertIsNone(result.error)


if __name__ == "__main__":
    unittest.main()
