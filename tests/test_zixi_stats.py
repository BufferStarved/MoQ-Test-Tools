import unittest

from zixi_hls_health import zixi_http_ts_playback_url
from zixi_stats import (
    ZixiStatsPoller,
    parse_zixi_jsonp,
    snapshot_from_zixi_payload,
)

# Captured from the GCP ingest VM (2026-07-15) while "SRT Test" was offline.
SAMPLE_INPUT_STATS_JSONP = """fill_inputs_stats({"up_time":0,"change_time":"2026-Jul-15 03:16:09","connections":1,"disconnections":1,"connected":false,"id":"SRT Test","remote_id":"","content_analysis":true,"scrambled":false,"blank_threshold_sec":0,"frozen_threshold_sec":-1475731456,"active_recording":true,"dist_overflows":0,"same_ts":6697,"time_jumps":0,"net":{"out_of_order":0,"dropped":17,"duplicates":0,"total_packets":9054,"packet_rate":0,"rtt":0,"jitter":1,"bitrate":0,"burst_loss":0,"kb_received":11574,"loss_millipercent":0,"extended":17,"overflows":0,"monotonic_dropped":0,"updates":32,"decompression_errors":0,"ipg_max":3415,"ipg_avg":327,"ipg_stdev":937,"local_dropped":0,"sum_drop_corr":0,"drop_corrcoeff_millipercent":0},"arq":{"lost":0,"resent":1,"burst_loss":0,"overflow":0,"recovered":17,"duplicate":0,"ignored":0,"missed":0,"canceled":0,"out_of_credit":0,"requests_not_sent":0,"max_latency":200,"latency":200,"congestion":0,"time_left":-1},"tr101_status":{"p1_ok":true,"p2_ok":true}});"""

SAMPLE_TR101_JSONP = """fill_ts_anaysis_data({"id":"SRT Test","net":{"rtt":42,"jitter":3,"loss_millipercent":2500,"dropped":4},"tr101":[[{"name":"Continuity_count_error","count":5,"description":"CC error","time":"now"}],[{"name":"PCR_error","count":1,"description":"PCR","time":"now"}]]});"""


class ZixiStatsTests(unittest.TestCase):
    def test_parse_zixi_jsonp_callback(self):
        data = parse_zixi_jsonp(SAMPLE_INPUT_STATS_JSONP)
        self.assertEqual(data["id"], "SRT Test")
        self.assertEqual(data["net"]["jitter"], 1)

    def test_snapshot_maps_net_fields(self):
        data = parse_zixi_jsonp(SAMPLE_INPUT_STATS_JSONP)
        snap = snapshot_from_zixi_payload(data)
        self.assertEqual(snap.jitter_ms, 1.0)
        self.assertEqual(snap.rtp_drops, 17)
        self.assertEqual(snap.cc_errors, 0)

    def test_snapshot_maps_tr101_continuity_errors(self):
        data = parse_zixi_jsonp(SAMPLE_TR101_JSONP)
        snap = snapshot_from_zixi_payload(data)
        self.assertEqual(snap.rtt_ms, 42.0)
        self.assertEqual(snap.jitter_ms, 3.0)
        self.assertEqual(snap.packet_loss_pct, 2.5)
        self.assertEqual(snap.cc_errors, 5)
        self.assertEqual(snap.rtp_drops, 4)

    def test_stream_id_from_srt_access_name(self):
        url = "srt://35.222.33.58:10080?mode=caller&streamid=#!::r=SRT%20Test,m=publish"
        self.assertEqual(ZixiStatsPoller._stream_id_from_url(url), "SRT Test")

    def test_stream_id_from_rtmp_path(self):
        url = "rtmp://35.222.33.58:1935/live/benchmark"
        self.assertEqual(ZixiStatsPoller._stream_id_from_url(url), "benchmark")

    def test_gcp_srt_preset_url_defaults_input_id(self):
        # Public preset omits streamid; poller must still resolve Zixi input "SRT Test".
        url = "srt://35.222.33.58:10080?mode=caller&latency=200000"
        poller = ZixiStatsPoller(url)
        self.assertEqual(poller._input_id, "SRT Test")

    def test_http_ts_playback_url(self):
        url = zixi_http_ts_playback_url(
            "SRT Test",
            endpoint_url="srt://35.222.33.58:10080?mode=caller",
        )
        self.assertEqual(url, "http://35.222.33.58:7777/SRT%20Test.ts")


if __name__ == "__main__":
    unittest.main()

