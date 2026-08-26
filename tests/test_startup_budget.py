"""Startup phase decomposition, normalized across protocols.

``playback_ttff_ms`` is one opaque number; these tests pin the properties that
let it be attributed to a component instead:

* the publisher and player chains stay *separate*, because the dwell time
  between "ingest has the first byte" and "an operator opened the tile"
  belongs to neither pipeline and would dominate a joined total;
* a phase with no instrument is named, not reported as a confident zero;
* a phase that structurally does not exist on a protocol (SRT has no TCP
  connect) is a third state, so nobody hunts for an impossible instrument;
* a missing middle milestone does not get papered over by stretching its
  neighbour across the gap;
* disagreement against the measured total is signed — over- and
  under-attribution are different facts with different columns.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from metrics import CSV_COLUMNS  # noqa: E402
from startup_budget import (  # noqa: E402
    PLAYER_PHASE_NOTES,
    PROTOCOL_PHASE_NOTES,
    STAGE_NAMES,
    STARTUP_COLUMNS,
    STARTUP_COMPONENTS,
    STARTUP_PLAYER_COMPONENTS,
    STARTUP_PUBLISHER_COMPONENTS,
    _clean_phase_ms,
    build_player_startup,
    build_publisher_startup,
    build_startup_budget,
    empty_startup_row,
    not_applicable_columns,
)


class PublisherChainTests(unittest.TestCase):
    def test_phases_are_durations_between_adjacent_milestones(self):
        """A phase is the gap it owns, not its offset from job start."""
        half = build_publisher_startup(
            protocol="rtmp",
            t0=100.0,
            dns_done=100.010,
            connect_done=100.035,
            handshake_done=100.090,
            publish_accepted=100.400,
            first_idr=100.900,
            first_byte_ingest=101.000,
        )
        self.assertEqual(half.phases["startup_dns_ms"], 10.0)
        self.assertEqual(half.phases["startup_connect_ms"], 25.0)
        self.assertEqual(half.phases["startup_handshake_ms"], 55.0)
        self.assertEqual(half.phases["startup_publish_accept_ms"], 310.0)
        self.assertEqual(half.phases["startup_first_idr_ms"], 500.0)
        self.assertEqual(half.phases["startup_first_byte_ingest_ms"], 100.0)

    def test_fully_measured_chain_reconciles_exactly(self):
        half = build_publisher_startup(
            protocol="rtmp",
            t0=100.0,
            dns_done=100.010,
            connect_done=100.035,
            handshake_done=100.090,
            publish_accepted=100.400,
            first_idr=100.900,
            first_byte_ingest=101.000,
        )
        self.assertEqual(half.measured_ms, 1000.0)
        self.assertEqual(half.accounted_ms, 1000.0)
        self.assertEqual(half.residual_ms, 0.0)
        self.assertEqual(half.overcount_ms, 0.0)
        self.assertEqual(half.unmeasured, frozenset())

    def test_missing_middle_milestone_unmeasures_both_neighbours(self):
        """The gap is not silently donated to whichever phase has an instrument.

        With no handshake milestone, ``handshake`` has no end and
        ``publish_accept`` has no start. Reporting publish_accept as
        "connect_done → publish_accepted" would move the entire handshake into
        it and read as a slow ingest accept, which is exactly the
        misattribution this family exists to prevent.
        """
        half = build_publisher_startup(
            protocol="rtmp",
            t0=100.0,
            dns_done=100.010,
            connect_done=100.035,
            handshake_done=None,
            publish_accepted=100.400,
            first_idr=100.900,
            first_byte_ingest=101.000,
        )
        self.assertIsNone(half.phases["startup_handshake_ms"])
        self.assertIsNone(half.phases["startup_publish_accept_ms"])
        # The unattributed time surfaces as residual, not as a fat neighbour.
        self.assertEqual(half.accounted_ms, 10.0 + 25.0 + 500.0 + 100.0)
        self.assertEqual(half.residual_ms, 365.0)
        self.assertEqual(half.overcount_ms, 0.0)

    def test_unmeasured_phase_is_blank_not_zero(self):
        half = build_publisher_startup(protocol="rtmp", t0=100.0, dns_done=100.010)
        self.assertEqual(half.phases["startup_dns_ms"], 10.0)
        self.assertIsNone(half.phases["startup_connect_ms"])
        self.assertIn("startup_connect_ms", half.unmeasured)

    def test_zero_is_preserved_as_a_measurement(self):
        """0.0 must mean 'measured, and it was zero' — a warm DNS cache is real."""
        half = build_publisher_startup(
            protocol="rtmp", t0=100.0, dns_done=100.0, connect_done=100.020
        )
        self.assertEqual(half.phases["startup_dns_ms"], 0.0)
        self.assertNotIn("startup_dns_ms", half.unmeasured)

    def test_srt_connect_is_not_applicable_and_handshake_spans_it(self):
        """SRT's caller handshake *is* its connect; the time is not lost.

        Marking connect unmeasured would send an operator looking for a TCP
        connect that never happens over UDP. Marking it not-applicable and
        anchoring the handshake at dns_done attributes the whole exchange to
        the phase that genuinely contains it.
        """
        half = build_publisher_startup(
            protocol="srt",
            t0=100.0,
            dns_done=100.010,
            handshake_done=100.210,
            publish_accepted=100.400,
            first_idr=100.900,
            first_byte_ingest=101.000,
        )
        self.assertIn("startup_connect_ms", half.not_applicable)
        self.assertNotIn("startup_connect_ms", half.unmeasured)
        self.assertEqual(half.phases["startup_handshake_ms"], 200.0)
        self.assertEqual(half.accounted_ms, 1000.0)
        self.assertEqual(half.residual_ms, 0.0)

    def test_overcount_and_residual_are_never_both_set(self):
        over = build_publisher_startup(
            protocol="rtmp",
            t0=100.0,
            dns_done=100.010,
            connect_done=100.035,
            handshake_done=100.090,
            publish_accepted=100.400,
            first_idr=100.900,
            first_byte_ingest=100.500,  # earlier than first_idr: spans overlap
        )
        self.assertTrue(over.overcount_ms > 0 or over.residual_ms > 0)
        self.assertEqual(min(over.overcount_ms, over.residual_ms), 0.0)

    def test_implausible_phase_is_dropped_not_clamped(self):
        """A clock artifact must not chart like a real two-minute phase."""
        self.assertIsNone(_clean_phase_ms(600_000.0))
        self.assertIsNone(_clean_phase_ms(-5.0))
        self.assertIsNone(_clean_phase_ms(float("nan")))
        self.assertIsNone(_clean_phase_ms(None))
        self.assertEqual(_clean_phase_ms(0.0), 0.0)

    def test_a_23s_startup_survives_the_ceiling(self):
        """The regression this family exists to explain must be representable."""
        half = build_publisher_startup(
            protocol="rtmp", t0=0.0, dns_done=0.010, connect_done=0.030,
            handshake_done=0.060, publish_accepted=23.000, first_idr=23.100,
            first_byte_ingest=23.200,
        )
        self.assertEqual(half.phases["startup_publish_accept_ms"], 22940.0)
        self.assertEqual(half.measured_ms, 23200.0)


class PlayerChainTests(unittest.TestCase):
    def test_player_chain_reconciles_against_measured_ttff(self):
        half = build_player_startup(
            engine="hls",
            request_ms=30.0,
            manifest_ms=120.0,
            first_media_ms=800.0,
            first_paint_ms=551.0,
            ttff_ms=1501.0,
        )
        self.assertEqual(half.accounted_ms, 1501.0)
        self.assertEqual(half.measured_ms, 1501.0)
        self.assertEqual(half.residual_ms, 0.0)
        self.assertEqual(half.overcount_ms, 0.0)

    def test_residual_is_the_unexplained_remainder(self):
        half = build_player_startup(
            engine="hls", request_ms=30.0, manifest_ms=120.0, ttff_ms=1501.0
        )
        self.assertEqual(half.accounted_ms, 150.0)
        self.assertEqual(half.residual_ms, 1351.0)
        self.assertEqual(
            half.stage_names(half.unmeasured), ("first_media", "first_paint")
        )

    def test_mpegts_has_no_manifest_phase_at_all(self):
        """A raw TS pull has no manifest; 0 ms would imply an instant fetch."""
        half = build_player_startup(engine="mpegts", request_ms=20.0, ttff_ms=900.0)
        self.assertIn("startup_manifest_ms", half.not_applicable)
        self.assertNotIn("startup_manifest_ms", half.unmeasured)

    def test_hls_manifest_phase_exists(self):
        half = build_player_startup(engine="hls", manifest_ms=120.0, ttff_ms=900.0)
        self.assertEqual(half.not_applicable, frozenset())


class BudgetRowTests(unittest.TestCase):
    def test_row_blanks_unmeasured_phases(self):
        budget = build_startup_budget(protocol="moq", engine="moq", t0=100.0, dns_done=100.005)
        row = budget.as_row()
        self.assertEqual(row["startup_dns_ms"], "5.0")
        self.assertEqual(row["startup_connect_ms"], "")
        self.assertEqual(row["startup_player_accounted_ms"], "0.0")
        self.assertEqual(row["startup_publisher_measured_ms"], "")

    def test_row_names_both_unmeasured_and_not_applicable(self):
        budget = build_startup_budget(
            protocol="srt",
            engine="mpegts",
            t0=100.0,
            dns_done=100.010,
            handshake_done=100.210,
        )
        row = budget.as_row()
        self.assertEqual(row["startup_not_applicable"], "connect,manifest")
        self.assertIn("publish_accept", row["startup_unmeasured"])
        self.assertNotIn("connect", row["startup_unmeasured"].split(","))

    def test_row_covers_every_declared_column(self):
        budget = build_startup_budget(protocol="rtmp", engine="hls")
        self.assertEqual(set(budget.as_row()), set(STARTUP_COLUMNS))

    def test_empty_row_is_blank_not_zero(self):
        row = empty_startup_row()
        self.assertEqual(set(row), set(STARTUP_COLUMNS))
        self.assertEqual(set(row.values()), {""})


class SchemaTests(unittest.TestCase):
    def test_every_startup_column_is_persisted(self):
        """A column nothing writes to the CSV is a metric that does not exist."""
        missing = [name for name in STARTUP_COLUMNS if name not in CSV_COLUMNS]
        self.assertEqual(missing, [])

    def test_stage_names_align_with_components(self):
        self.assertEqual(len(STAGE_NAMES), len(STARTUP_COMPONENTS))
        self.assertEqual(
            len(STARTUP_COMPONENTS),
            len(STARTUP_PUBLISHER_COMPONENTS) + len(STARTUP_PLAYER_COMPONENTS),
        )

    def test_every_protocol_documents_every_publisher_phase(self):
        """An undocumented phase is an invitation to compare incomparable things."""
        for protocol in ("rtmp", "srt", "webrtc", "moq"):
            notes = PROTOCOL_PHASE_NOTES[protocol]
            for stage in ("dns", "connect", "handshake", "publish_accept",
                          "first_idr", "first_byte_ingest"):
                self.assertIn(stage, notes, f"{protocol}/{stage}")

    def test_blank_note_matches_not_applicable(self):
        """The docs table and the n/a table must not disagree."""
        for protocol in ("rtmp", "srt", "webrtc", "moq"):
            absent = not_applicable_columns(protocol)
            for column, stage in zip(
                STARTUP_PUBLISHER_COMPONENTS,
                ("dns", "connect", "handshake", "publish_accept",
                 "first_idr", "first_byte_ingest"),
            ):
                blank = PROTOCOL_PHASE_NOTES[protocol][stage] == ""
                self.assertEqual(blank, column in absent, f"{protocol}/{stage}")

    def test_every_engine_documents_every_player_phase(self):
        for engine in ("hls", "ll-hls", "mpegts", "whep", "moq", "dash"):
            notes = PLAYER_PHASE_NOTES[engine]
            for stage in ("player_request", "manifest", "first_media", "first_paint"):
                self.assertIn(stage, notes, f"{engine}/{stage}")


if __name__ == "__main__":
    unittest.main()
