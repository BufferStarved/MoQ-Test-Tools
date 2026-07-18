"""Unit tests for MediaMTX Prometheus → bench metric mapping."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from mediamtx_stats import MediaMtxStatsPoller, MediaMtxStatsSnapshot  # noqa: E402
from upload_service import UploadService  # noqa: E402
from zixi_hls_health import mediamtx_hls_playback_url  # noqa: E402

SAMPLE_SRT = """
# HELP paths MediaMTX paths
paths{name="benchmark",state="ready"} 1
paths_bytes_received{name="benchmark",state="ready"} 5000000
paths_bytes_sent{name="benchmark",state="ready"} 2000000
paths_readers{name="benchmark",state="ready"} 2
paths_inbound_frames_in_error{name="benchmark",state="ready"} 4
srt_conns{id="1",path="benchmark",remoteAddr="1.2.3.4:5",state="publish"} 1
srt_conns_ms_rtt{id="1",path="benchmark",remoteAddr="1.2.3.4:5",state="publish"} 28.5
srt_conns_mbps_receive_rate{id="1",path="benchmark",remoteAddr="1.2.3.4:5",state="publish"} 4.0
srt_conns_mbps_send_rate{id="1",path="benchmark",remoteAddr="1.2.3.4:5",state="publish"} 0.2
srt_conns_packets_received{id="1",path="benchmark",remoteAddr="1.2.3.4:5",state="publish"} 2000
srt_conns_packets_received_loss{id="1",path="benchmark",remoteAddr="1.2.3.4:5",state="publish"} 10
srt_conns_packets_received_loss_rate{id="1",path="benchmark",remoteAddr="1.2.3.4:5",state="publish"} 0.5
srt_conns_packets_retrans{id="1",path="benchmark",remoteAddr="1.2.3.4:5",state="publish"} 20
srt_conns_packets_received_retrans{id="1",path="benchmark",remoteAddr="1.2.3.4:5",state="publish"} 4
srt_conns_packets_received_drop{id="1",path="benchmark",remoteAddr="1.2.3.4:5",state="publish"} 2
srt_conns_packets_send_drop{id="1",path="benchmark",remoteAddr="1.2.3.4:5",state="publish"} 1
srt_conns_packets_send_loss{id="1",path="benchmark",remoteAddr="1.2.3.4:5",state="publish"} 3
"""

SAMPLE_RTMP_NO_SRT = """
paths{name="benchmark",state="ready"} 1
paths_bytes_received{name="benchmark",state="ready"} 1000000
paths_bytes_sent{name="benchmark",state="ready"} 0
paths_readers{name="benchmark",state="ready"} 1
rtmp_conns{id="9",path="benchmark",remoteAddr="9.9.9.9:1",state="publish"} 1
rtmp_conns_bytes_received{id="9",path="benchmark",remoteAddr="9.9.9.9:1",state="publish"} 1000000
"""

SAMPLE_OTHER_PATH = """
paths{name="other",state="ready"} 1
paths_bytes_received{name="other",state="ready"} 999
srt_conns_ms_rtt{id="1",path="other",remoteAddr="1.2.3.4:5",state="publish"} 99
srt_conns_mbps_receive_rate{id="1",path="other",remoteAddr="1.2.3.4:5",state="publish"} 9
"""


class MediaMtxPathFromUrlTests(unittest.TestCase):
    def test_srt_publish_streamid(self):
        url = "srt://34.9.217.178:8890?mode=caller&streamid=publish:benchmark"
        self.assertEqual(MediaMtxStatsPoller._path_from_url(url), "benchmark")

    def test_rtmp_path(self):
        self.assertEqual(
            MediaMtxStatsPoller._path_from_url("rtmp://34.9.217.178:1935/benchmark"),
            "benchmark",
        )

    def test_whip_path(self):
        self.assertEqual(
            MediaMtxStatsPoller._path_from_url("http://34.9.217.178:8889/benchmark/whip"),
            "benchmark",
        )


class MediaMtxParserTests(unittest.TestCase):
    def setUp(self):
        self.poller = MediaMtxStatsPoller(
            endpoint_url="srt://127.0.0.1:8890?streamid=publish:benchmark"
        )

    def test_maps_srt_transport_fields(self):
        snap = self.poller._snapshot_from_prometheus(SAMPLE_SRT)
        self.assertTrue(snap.ready)
        self.assertEqual(snap.readers, 2)
        self.assertAlmostEqual(snap.net_rtt_ms, 28.5)
        self.assertAlmostEqual(snap.net_recv_mbps, 4.0)
        self.assertAlmostEqual(snap.net_loss_pct, 0.5)  # 10/2000
        self.assertAlmostEqual(snap.net_retrans_pct, 1.2)  # 24/2000
        self.assertEqual(snap.pkt_retrans, 24)
        self.assertEqual(snap.pkt_rcv_drop, 2)
        self.assertEqual(snap.pkt_snd_drop, 1)
        self.assertEqual(snap.pkt_snd_loss, 3)
        self.assertEqual(snap.ts_continuity_counter_errors, 4)

    def test_ignores_other_path(self):
        snap = self.poller._snapshot_from_prometheus(SAMPLE_OTHER_PATH)
        self.assertFalse(snap.ready)
        self.assertEqual(snap.net_rtt_ms, 0.0)
        self.assertEqual(snap.net_recv_mbps, 0.0)

    def test_byte_delta_recv_when_no_mbps_gauge(self):
        p = MediaMtxStatsPoller(endpoint_url="rtmp://127.0.0.1:1935/benchmark")
        body1 = SAMPLE_RTMP_NO_SRT
        body2 = SAMPLE_RTMP_NO_SRT.replace("1000000", "2250000")
        p._snapshot_from_prometheus(body1)
        snap = p._snapshot_from_prometheus(body2)
        self.assertTrue(snap.ready)
        self.assertGreater(snap.net_recv_mbps, 0.0)

    def test_jitter_ema_from_rtt_deltas(self):
        p = MediaMtxStatsPoller(endpoint_url="srt://127.0.0.1:8890?streamid=publish:benchmark")
        a = SAMPLE_SRT
        b = SAMPLE_SRT.replace("28.5", "38.5")
        p._snapshot_from_prometheus(a)
        snap = p._snapshot_from_prometheus(b)
        self.assertGreater(snap.net_jitter_ms, 0.0)


class MediaMtxMergeTests(unittest.TestCase):
    def test_publisher_rtt_wins_mtx_fills_recv(self):
        mtx = MediaMtxStatsSnapshot(
            net_rtt_ms=40.0,
            net_jitter_ms=2.0,
            net_recv_mbps=3.5,
            net_loss_pct=1.0,
            pkt_retrans=7,
            pkt_rcv_drop=2,
        )
        merged = UploadService._merge_mediamtx_transport(
            mtx=mtx,
            net_rtt_ms=12.0,
            net_jitter_ms=0.5,
            net_send_mbps=2.0,
            net_recv_mbps=0.0,
            net_loss_pct=0.0,
            pkt_retrans=0,
        )
        self.assertEqual(merged["net_rtt_ms"], 12.0)
        self.assertEqual(merged["net_jitter_ms"], 0.5)
        self.assertEqual(merged["net_recv_mbps"], 3.5)
        self.assertEqual(merged["net_loss_pct"], 1.0)
        self.assertEqual(merged["pkt_retrans"], 7)
        self.assertEqual(merged["net_send_mbps"], 2.0)

    def test_send_fallback_uses_ingest_recv_not_egress(self):
        mtx = MediaMtxStatsSnapshot(net_recv_mbps=3.0, net_send_mbps=9.0)
        merged = UploadService._merge_mediamtx_transport(
            mtx=mtx,
            net_rtt_ms=0.0,
            net_jitter_ms=0.0,
            net_send_mbps=0.0,
            net_recv_mbps=0.0,
        )
        self.assertEqual(merged["net_send_mbps"], 3.0)
        self.assertEqual(merged["net_recv_mbps"], 3.0)


class MediaMtxPlaybackUrlTests(unittest.TestCase):
    def test_hls_url(self):
        url = mediamtx_hls_playback_url(
            "benchmark",
            endpoint_url="srt://34.9.217.178:8890?streamid=publish:benchmark",
        )
        self.assertEqual(url, "http://34.9.217.178:8888/benchmark/index.m3u8")


if __name__ == "__main__":
    unittest.main()
