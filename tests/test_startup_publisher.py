"""Publisher-side collection for the startup decomposition.

``startup_budget`` is already unit-tested as a formula. These tests pin the
*collection* side — the part that decides which real signal becomes which
milestone — because that is where a decomposition stops being honest:

* a milestone is stamped once, at the first observation. Every signal feeding
  this is level rather than edge (a MediaMTX path stays ready, ``live: sent
  track=`` stays in the log tail), so a tracker that re-stamped would report
  "startup finished at t+29s" for a leg that started immediately;
* first IDR comes from ffmpeg's frame counter leaving 0 and from nothing else;
* a phase with no instrument on this protocol reports unmeasured, never 0 —
  RTMP, SRT and WHIP have no handshake instrument at all;
* a phase that cannot exist (SRT's TCP connect) is a third state, not a gap;
* out-of-order observations produce blanks, not negative durations;
* every startup column is present in the emitted row, so the CSV never has to
  guess whether a missing column meant zero.
"""

from __future__ import annotations

import socket
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Optional
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from metrics import CSV_COLUMNS, MetricsCollector  # noqa: E402
from moq_publish import (  # noqa: E402
    publisher_catalog_published,
    publisher_first_object_sent,
    publisher_webtransport_connected,
)
from startup_budget import STARTUP_COLUMNS  # noqa: E402
from startup_probe import (  # noqa: E402
    StartupPreflight,
    StartupTracker,
    probe_startup,
    publisher_startup_row,
    resolve_probe_port,
    tcp_connect_applicable,
)


class FakeClock:
    """Explicit monotonic clock, so a test asserts a phase and not a runtime."""

    def __init__(self, now: float = 100.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def _tracker(
    protocol: str,
    clock: FakeClock,
    *,
    dns_after: Optional[float] = None,
    connect_after: Optional[float] = None,
) -> StartupTracker:
    """Tracker anchored at the clock's current value, with canned preflight."""
    t0 = clock.now
    preflight = StartupPreflight(
        t0=t0,
        dns_done=None if dns_after is None else t0 + dns_after,
        connect_done=None if connect_after is None else t0 + connect_after,
    )
    return StartupTracker(protocol, preflight=preflight, clock=clock)


class OneShotTests(unittest.TestCase):
    def test_later_observation_does_not_overwrite_the_first(self):
        """The signals are level, so only the first tick that saw them counts."""
        clock = FakeClock(100.0)
        tracker = _tracker("rtmp", clock)

        clock.now = 101.0
        tracker.note_publish_accepted(True)
        tracker.note_first_byte_ingest(True)
        clock.now = 130.0
        tracker.note_publish_accepted(True)
        tracker.note_first_byte_ingest(True)

        milestones = tracker.milestones()
        self.assertEqual(milestones["publish_accepted"], 101.0)
        self.assertEqual(milestones["first_byte_ingest"], 101.0)

    def test_false_signal_stamps_nothing(self):
        clock = FakeClock(100.0)
        tracker = _tracker("rtmp", clock)
        clock.now = 101.0
        tracker.note_publish_accepted(False)
        tracker.note_first_byte_ingest(False)
        tracker.note_handshake(False)
        self.assertIsNone(tracker.milestones()["publish_accepted"])
        self.assertIsNone(tracker.milestones()["first_byte_ingest"])
        self.assertIsNone(tracker.milestones()["handshake_done"])


class FirstIdrTests(unittest.TestCase):
    def test_fires_on_the_first_frame_and_not_before(self):
        """frame>=1 is the first IDR (H.264's first emitted frame always is).

        Quantized to the 1 Hz sample loop, which is why this asserts *which*
        tick stamped it rather than a sub-second value.
        """
        clock = FakeClock(100.0)
        tracker = _tracker("rtmp", clock)

        clock.now = 101.0
        tracker.note_first_idr(0)
        self.assertIsNone(tracker.milestones()["first_idr"])

        clock.now = 102.0
        tracker.note_first_idr(1)
        self.assertEqual(tracker.milestones()["first_idr"], 102.0)

        clock.now = 103.0
        tracker.note_first_idr(90)
        self.assertEqual(tracker.milestones()["first_idr"], 102.0)

    def test_missing_or_junk_frame_counter_is_not_a_milestone(self):
        """ffmpeg reports frame=N/A before it has muxed anything."""
        clock = FakeClock(100.0)
        tracker = _tracker("moq", clock)
        tracker.note_first_idr(None)  # type: ignore[arg-type]
        tracker.note_first_idr("N/A")  # type: ignore[arg-type]
        self.assertIsNone(tracker.milestones()["first_idr"])


class UnmeasuredVersusZeroTests(unittest.TestCase):
    def test_rtmp_handshake_has_no_instrument_and_is_not_zero(self):
        """Nothing in the pipeline sees ffmpeg's RTMP handshake complete.

        The phase must land in `startup_unmeasured` with a blank column. A 0.0
        would claim the exchange was instantaneous, and would also hide the
        reason the publisher residual is large.
        """
        clock = FakeClock(100.0)
        tracker = _tracker("rtmp", clock, dns_after=0.05, connect_after=0.1)

        clock.now = 102.0
        half = tracker.observe(encode_frames=30, publish_accepted=True, first_byte_ingest=True)

        self.assertIsNone(half.phases["startup_handshake_ms"])
        self.assertIn("startup_handshake_ms", half.unmeasured)
        self.assertEqual(half.not_applicable, frozenset())
        self.assertEqual(publisher_startup_row(half)["startup_handshake_ms"], "")
        self.assertIn("handshake", publisher_startup_row(half)["startup_unmeasured"])
        # dns/connect are the phases this process really can time.
        self.assertEqual(half.phases["startup_dns_ms"], 50.0)
        self.assertEqual(half.phases["startup_connect_ms"], 50.0)

    def test_srt_connect_is_not_applicable_rather_than_unmeasured(self):
        """SRT's caller handshake *is* its connect; there is no TCP connect.

        Reporting it unmeasured would send an operator hunting for an
        instrument that cannot exist.
        """
        clock = FakeClock(100.0)
        tracker = _tracker("srt", clock, dns_after=0.05)

        clock.now = 103.0
        half = tracker.observe(encode_frames=90, publish_accepted=True, first_byte_ingest=True)

        self.assertIn("startup_connect_ms", half.not_applicable)
        self.assertNotIn("startup_connect_ms", half.unmeasured)
        row = publisher_startup_row(half)
        self.assertEqual(row["startup_connect_ms"], "")
        self.assertIn("connect", row["startup_not_applicable"])
        self.assertNotIn("connect", row["startup_unmeasured"].split(","))

    def test_same_tick_arrival_is_a_measured_zero(self):
        """0.0 ms is a real reading at 1 Hz, and must not degrade to blank."""
        clock = FakeClock(0.0)
        tracker = _tracker("moq", clock, dns_after=0.01)

        clock.now = 1.0
        tracker.observe(handshake=True)
        clock.now = 2.0
        half = tracker.observe(encode_frames=60, publish_accepted=True, first_byte_ingest=True)

        self.assertEqual(half.phases["startup_publish_accept_ms"], 1000.0)
        self.assertEqual(half.phases["startup_first_idr_ms"], 0.0)
        self.assertEqual(half.phases["startup_first_byte_ingest_ms"], 0.0)
        row = publisher_startup_row(half)
        self.assertEqual(row["startup_first_idr_ms"], "0.0")
        self.assertEqual(row["startup_first_byte_ingest_ms"], "0.0")

    def test_out_of_order_observation_is_blank_not_negative(self):
        """Ingest bytes seen before the ingest reported the session accepted.

        Both signals are polled and independent, so the ordering the chain
        assumes can invert. The contract drops the negative to None, which is
        right: a negative phase is not a fast phase, it is no measurement.
        """
        clock = FakeClock(100.0)
        tracker = _tracker("moq", clock, dns_after=0.01)
        clock.now = 101.0
        tracker.observe(handshake=True)

        clock.now = 104.0
        tracker.observe(encode_frames=120, first_byte_ingest=True)
        clock.now = 105.0
        half = tracker.observe(encode_frames=150, publish_accepted=True)

        # publish_accept is measured from the WebTransport milestone. first_idr
        # would be negative against it and is dropped, but the chain still
        # re-anchors on the first-IDR milestone that did happen, so the phase
        # after it stays measured (0.0 here — both landed on the same tick).
        self.assertEqual(half.phases["startup_publish_accept_ms"], 4000.0)
        self.assertIsNone(half.phases["startup_first_idr_ms"])
        self.assertEqual(half.phases["startup_first_byte_ingest_ms"], 0.0)
        row = publisher_startup_row(half)
        for name in STARTUP_COLUMNS:
            value = row[name]
            if value and value.replace(".", "", 1).lstrip("-").isdigit():
                self.assertGreaterEqual(float(value), 0.0, name)


class ProbeTests(unittest.TestCase):
    def test_dns_and_connect_record_real_monotonic_instants(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            preflight = probe_startup("rtmp", f"rtmp://127.0.0.1:{port}/live/benchmark")

        self.assertIsNotNone(preflight.dns_done)
        self.assertIsNotNone(preflight.connect_done)
        assert preflight.dns_done is not None and preflight.connect_done is not None
        self.assertGreaterEqual(preflight.dns_done, preflight.t0)
        self.assertGreaterEqual(preflight.connect_done, preflight.dns_done)
        self.assertEqual(preflight.host, "127.0.0.1")
        self.assertEqual(preflight.port, port)

    def test_failed_resolve_leaves_dns_none_and_does_not_raise(self):
        """A broken instrument must not fail the job, and must not report 0."""
        with mock.patch("socket.getaddrinfo", side_effect=socket.gaierror("nodename nor servname")):
            preflight = probe_startup("rtmp", "rtmp://no-such-host.invalid:1935/live/benchmark")
        self.assertIsNone(preflight.dns_done)
        self.assertIsNone(preflight.connect_done)
        self.assertIn("getaddrinfo", preflight.dns_error)

        half = StartupTracker("rtmp", preflight=preflight).publisher_half()
        self.assertIsNone(half.phases["startup_dns_ms"])
        self.assertIn("startup_dns_ms", half.unmeasured)

    def test_url_without_host_is_reported_not_guessed(self):
        preflight = probe_startup("rtmp", "")
        self.assertIsNone(preflight.dns_done)
        self.assertIn("no host", preflight.dns_error)

    def test_tcp_connect_only_where_the_ingest_is_tcp(self):
        """A TCP connect to a UDP port measures nothing about that session."""
        self.assertTrue(tcp_connect_applicable("rtmp", "rtmp://host:1935/live"))
        self.assertTrue(tcp_connect_applicable("webrtc", "http://host:8889/benchmark/whip"))
        self.assertFalse(tcp_connect_applicable("srt", "srt://host:8890?streamid=publish"))
        self.assertFalse(tcp_connect_applicable("moq", "https://host:14433/anon"))

    def test_default_ports_follow_the_protocol_then_the_scheme(self):
        self.assertEqual(resolve_probe_port("rtmp", "rtmp://host/live/benchmark"), 1935)
        # MediaMTX serves WHIP on 8889, so a portless http WHIP URL is probed
        # there rather than on 80.
        self.assertEqual(resolve_probe_port("webrtc", "http://host/benchmark/whip"), 8889)
        self.assertEqual(resolve_probe_port("hls", "http://host:7777/put/bench"), 7777)


class MoqSignalMappingTests(unittest.TestCase):
    def test_catalog_published_is_publish_accept_and_first_object_is_first_byte(self):
        """The two MoQ log facts are different milestones, in chain order.

        ``connection_id=`` alone is the WebTransport session (handshake);
        "sender ready (namespace + catalog published)" is the relay accepting
        the publish; ``live: sent track=`` is media on the wire.
        """
        clock = FakeClock(0.0)
        tracker = _tracker("moq", clock, dns_after=0.01)

        connect_log = "connection_id=moq5-wt ns=bench-6d3a4094\n"
        self.assertTrue(publisher_webtransport_connected(connect_log))
        self.assertFalse(publisher_catalog_published(connect_log))
        self.assertFalse(publisher_first_object_sent(connect_log))

        clock.now = 1.5
        tracker.observe(
            encode_frames=0,
            handshake=publisher_webtransport_connected(connect_log),
            publish_accepted=publisher_catalog_published(connect_log),
            first_byte_ingest=publisher_first_object_sent(connect_log),
        )

        catalog_log = connect_log + "sender ready (namespace + catalog published)\n"
        clock.now = 2.5
        tracker.observe(
            encode_frames=30,
            handshake=publisher_webtransport_connected(catalog_log),
            publish_accepted=publisher_catalog_published(catalog_log),
            first_byte_ingest=publisher_first_object_sent(catalog_log),
        )

        sent_log = catalog_log + "live: sent track=vide_1 bytes=191598\n"
        clock.now = 3.5
        half = tracker.observe(
            encode_frames=60,
            handshake=publisher_webtransport_connected(sent_log),
            publish_accepted=publisher_catalog_published(sent_log),
            first_byte_ingest=publisher_first_object_sent(sent_log),
        )

        milestones = tracker.milestones()
        self.assertEqual(milestones["handshake_done"], 1.5)
        self.assertEqual(milestones["publish_accepted"], 2.5)
        self.assertEqual(milestones["first_byte_ingest"], 3.5)
        self.assertEqual(half.phases["startup_publish_accept_ms"], 1000.0)
        self.assertEqual(half.phases["startup_first_idr_ms"], 0.0)
        self.assertEqual(half.phases["startup_first_byte_ingest_ms"], 1000.0)
        # Publisher total is job start → first byte at the ingest, nothing else.
        self.assertEqual(half.measured_ms, 3500.0)

    def test_quic_connect_stays_unmeasured_on_moq(self):
        """`connect` on MoQ is the QUIC handshake, which nothing here observes.

        Its absence also blanks `handshake`: build_publisher_startup refuses to
        stretch the WebTransport phase back over a missing QUIC milestone.
        """
        clock = FakeClock(0.0)
        tracker = _tracker("moq", clock, dns_after=0.01)
        clock.now = 1.0
        half = tracker.observe(handshake=True)
        self.assertIsNone(half.phases["startup_connect_ms"])
        self.assertIn("startup_connect_ms", half.unmeasured)
        self.assertIsNone(half.phases["startup_handshake_ms"])


class RowEmissionTests(unittest.TestCase):
    def test_blank_row_when_nothing_was_observed(self):
        row = publisher_startup_row(None)
        self.assertEqual(sorted(row), sorted(STARTUP_COLUMNS))
        self.assertEqual(set(row.values()), {""})

    def test_record_sample_emits_every_startup_column(self):
        clock = FakeClock(0.0)
        tracker = _tracker("rtmp", clock, dns_after=0.02, connect_after=0.05)
        clock.now = 2.0
        half = tracker.observe(encode_frames=60, publish_accepted=True, first_byte_ingest=True)

        with tempfile.TemporaryDirectory() as tmp:
            collector = MetricsCollector(
                protocol="rtmp",
                endpoint_url="rtmp://127.0.0.1:1935/live/benchmark",
                output_dir=tmp,
            )
            collector.record_sample(
                pid=0,
                encoded_bitrate_kbps=3000.0,
                fps=30.0,
                speed=1.0,
                out_time="00:00:02.000000",
                startup=half,
            )
            self.assertEqual(len(collector._rows), 1)
            row = collector._rows[-1]

        for name in STARTUP_COLUMNS:
            self.assertIn(name, row, name)
            self.assertIn(name, CSV_COLUMNS, name)
        self.assertEqual(row["startup_dns_ms"], "20.0")
        self.assertEqual(row["startup_connect_ms"], "30.0")
        self.assertEqual(row["startup_publisher_measured_ms"], "2000.0")
        # Player columns belong to the playback merge, so they stay blank here
        # instead of being written as confident zeros.
        self.assertEqual(row["startup_first_paint_ms"], "")
        self.assertEqual(row["startup_player_accounted_ms"], "")

    def test_record_sample_without_startup_is_backward_compatible(self):
        with tempfile.TemporaryDirectory() as tmp:
            collector = MetricsCollector(
                protocol="srt",
                endpoint_url="srt://127.0.0.1:8890",
                output_dir=tmp,
            )
            collector.record_sample(
                pid=0,
                encoded_bitrate_kbps=3000.0,
                fps=30.0,
                speed=1.0,
                out_time="00:00:01.000000",
            )
            self.assertEqual(len(collector._rows), 1)
            row = collector._rows[-1]
        for name in STARTUP_COLUMNS:
            self.assertEqual(row[name], "", name)


if __name__ == "__main__":
    unittest.main()
