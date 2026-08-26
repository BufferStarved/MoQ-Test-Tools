"""picoquic qlog parser: QUIC smoothed RTT / jitter, never a TCP stand-in."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from picoquic_qlog import PicoquicQlogSnapshot, PicoquicQlogTailer, parse_qlog_metrics  # noqa: E402

# picoquic live array format (qlog_fns.c / qlog.c comments).
PICOQUIC_ARRAY_QLOG = """\
{ "qlog_version": "draft-00", "title": "picoquic", "traces": [
{ "vantage_point": { "name": "backend-67", "type": "client" },
"event_fields": ["relative_time", "category", "event", "data"],
"configuration": {"time_units": "us"},
"events": [
[904,"recovery","metrics_updated","default",{"bytes_in_flight":822}],
[45228,"recovery","metrics_updated","default",{"bytes_in_flight":668,"cwnd":12154,"smoothed_rtt":46151,"min_rtt":46151,"latest_rtt":46151}],
[81200,"recovery","metrics_updated","default",{"latest_rtt":50200,"cwnd":16384}],
[90010,"recovery","packet_lost","default",{"packet_number":12}]
]}]}
"""

PICOQUIC_PATH_ID_QLOG = """\
[1200,0,"recovery","metrics_updated",{"smoothed_rtt":38000,"latest_rtt":37500,"cwnd":8000}]
[2400,0,"recovery","metrics_updated",{"latest_rtt":41000}]
"""

PICOQUIC_OBJECT_QLOG = """\
{"name":"recovery:metrics_updated","data":{"smoothed_rtt":55000,"latest_rtt":54000,"cwnd":20000}}
{"name":"recovery:metrics_updated","data":{"latest_rtt":60000}}
{"name":"recovery:packet_lost","data":{"packet_number":3}}
"""


class ParseQlogMetricsTests(unittest.TestCase):
    def test_picoquic_array_smoothed_rtt_us_to_ms(self):
        snap = parse_qlog_metrics(PICOQUIC_ARRAY_QLOG)
        self.assertAlmostEqual(snap.rtt_ms, 46.151, places=3)
        self.assertEqual(snap.cwnd_bytes, 16384)
        self.assertEqual(snap.packets_lost, 1)
        # latest_rtt went 46.151 → 50.200; carry-forward smoothed stays 46.151
        self.assertGreater(snap.jitter_ms, 0.0)

    def test_carries_smoothed_rtt_when_later_event_omits_it(self):
        snap = parse_qlog_metrics(PICOQUIC_ARRAY_QLOG)
        self.assertAlmostEqual(snap.rtt_ms, 46.151, places=3)

    def test_latest_rtt_when_smoothed_absent(self):
        snap = parse_qlog_metrics(
            '[1,"recovery","metrics_updated",{"latest_rtt":33000,"cwnd":4096}]'
        )
        self.assertAlmostEqual(snap.rtt_ms, 33.0, places=3)
        self.assertEqual(snap.cwnd_bytes, 4096)

    def test_path_id_tuple_and_jitter_from_latest_rtt_deltas(self):
        snap = parse_qlog_metrics(PICOQUIC_PATH_ID_QLOG)
        self.assertAlmostEqual(snap.rtt_ms, 38.0, places=3)
        self.assertAlmostEqual(snap.jitter_ms, 3.5, places=3)

    def test_json_object_events(self):
        snap = parse_qlog_metrics(PICOQUIC_OBJECT_QLOG)
        self.assertAlmostEqual(snap.rtt_ms, 55.0, places=3)
        self.assertEqual(snap.cwnd_bytes, 20000)
        self.assertEqual(snap.packets_lost, 1)
        self.assertAlmostEqual(snap.jitter_ms, 6.0, places=3)

    def test_empty_or_header_only_is_unmeasured(self):
        snap = parse_qlog_metrics('{ "qlog_version": "draft-00", "events": [')
        self.assertEqual(snap, PicoquicQlogSnapshot())

    def test_bytes_in_flight_only_is_unmeasured_rtt(self):
        snap = parse_qlog_metrics(
            '[904,"recovery","metrics_updated","default",{"bytes_in_flight":822}]'
        )
        self.assertEqual(snap.rtt_ms, 0.0)
        self.assertEqual(snap.jitter_ms, 0.0)


class PicoquicQlogTailerTests(unittest.TestCase):
    def test_disabled_without_dir(self):
        tailer = PicoquicQlogTailer("")
        self.assertFalse(tailer.enabled)
        self.assertEqual(tailer.poll().rtt_ms, 0.0)

    def test_polls_newest_client_qlog(self):
        with tempfile.TemporaryDirectory() as tmp:
            older = Path(tmp) / "aaaa.client.qlog"
            newer = Path(tmp) / "bbbb.client.qlog"
            older.write_text(
                '[1,"recovery","metrics_updated",{"smoothed_rtt":10000,"cwnd":1}]',
                encoding="utf-8",
            )
            newer.write_text(PICOQUIC_ARRAY_QLOG, encoding="utf-8")
            Path(tmp, "ignore.txt").write_text("nope", encoding="utf-8")
            tailer = PicoquicQlogTailer(tmp)
            snap = tailer.poll()
            self.assertTrue(tailer.enabled)
            self.assertAlmostEqual(snap.rtt_ms, 46.151, places=3)
            self.assertEqual(snap.cwnd_bytes, 16384)

    def test_missing_dir_stays_unmeasured(self):
        tailer = PicoquicQlogTailer("/tmp/moq-qlog-does-not-exist")
        self.assertEqual(tailer.poll().rtt_ms, 0.0)


if __name__ == "__main__":
    unittest.main()
