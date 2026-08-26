"""Player-side startup phases must reach the CSV blank-preserving.

The startup family exists because ``playback_ttff_ms`` said an RTMP leg took
23 seconds and named no component responsible. Its four player phases only
answer that question if a phase with no instrument stays *blank*: 0.0 means
"measured, and it completed inside the measurement resolution", and a confident
zero on an unmeasured stage both charts like a real instant phase and shrinks
``startup_player_residual_ms`` to match a stage nobody observed.

Every other playback column is a counter or a gauge whose absence really is
zero, so the merge machinery coerces the whole payload through
``_as_float(x or 0)`` and defaults to ``"0"``. These four columns are the
exception, and this file is the regression net for that exception.
"""

import csv
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from metrics import CSV_COLUMNS  # noqa: E402
from playback_metrics import (  # noqa: E402
    PLAYBACK_DEFAULTS,
    PLAYBACK_LIVE_GAUGE_KEYS,
    PLAYBACK_NULLABLE_KEYS,
    compute_playback_averages,
    merge_playback_into_csv,
)
from startup_budget import STARTUP_PLAYER_COMPONENTS  # noqa: E402


def _write_csv(path: str, count: int, base_ts: float = 1000.0) -> None:
    with open(path, mode="w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for second in range(count):
            row = {name: "0" for name in CSV_COLUMNS}
            # The encoder loop writes startup columns blank until a milestone
            # lands (startup_budget.empty_startup_row).
            for name in STARTUP_PLAYER_COMPONENTS:
                row[name] = ""
            row["timestamp"] = str(base_ts + second)
            writer.writerow(row)


class StartupPhaseContractTests(unittest.TestCase):
    def test_the_persisted_columns_are_the_contract_columns(self):
        # Drifting from startup_budget's own tuple would leave a CSV column
        # with no meaning, or a phase the player collects and nobody stores.
        self.assertEqual(set(PLAYBACK_NULLABLE_KEYS), set(STARTUP_PLAYER_COMPONENTS))
        for name in PLAYBACK_NULLABLE_KEYS:
            self.assertIn(name, CSV_COLUMNS)

    def test_the_phases_never_get_a_zero_default(self):
        """PLAYBACK_DEFAULTS is "0" for every column it covers."""
        for name in PLAYBACK_NULLABLE_KEYS:
            self.assertNotIn(name, PLAYBACK_DEFAULTS)

    def test_the_phases_are_join_facts_not_live_gauges(self):
        """A join already happened; blanking these when the player detaches
        would erase how it was spent from every later row.

        Same reasoning that keeps playback_ttff_ms out of this set — these are
        its decomposition.
        """
        for name in PLAYBACK_NULLABLE_KEYS:
            self.assertNotIn(name, PLAYBACK_LIVE_GAUGE_KEYS)


class StartupPhaseMergeTests(unittest.TestCase):
    def test_a_measured_phase_lands_and_a_null_one_stays_blank(self):
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            _write_csv(csv_path, count=6)
            playback = [
                {
                    "elapsed_sec": 2,
                    "playback_ttff_ms": 3000,
                    "startup_player_request_ms": 100.0,
                    # Cross-origin manifest with no Timing-Allow-Origin: the
                    # browser reported nothing, so neither do we.
                    "startup_manifest_ms": None,
                    "startup_first_media_ms": 2000.0,
                    "startup_first_paint_ms": 600.0,
                }
            ]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="hls"
            )

        self.assertEqual(rows[2]["startup_player_request_ms"], "100.0")
        self.assertEqual(rows[2]["startup_first_media_ms"], "2000.0")
        self.assertEqual(rows[2]["startup_first_paint_ms"], "600.0")
        # The whole point: blank, not "0" and not "0.0".
        self.assertEqual(rows[2]["startup_manifest_ms"], "")

    def test_a_measured_zero_is_not_the_same_as_an_unmeasured_phase(self):
        """A localhost connect really can complete inside the resolution."""
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            _write_csv(csv_path, count=4)
            playback = [
                {
                    "elapsed_sec": 1,
                    "startup_player_request_ms": 0.0,
                    "startup_manifest_ms": None,
                }
            ]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="hls"
            )

        self.assertEqual(rows[1]["startup_player_request_ms"], "0.0")
        self.assertEqual(rows[1]["startup_manifest_ms"], "")

    def test_an_absent_field_is_blank_rather_than_zero(self):
        """An older browser build posts no startup fields at all.

        Reading the missing key through the counter path (``sample.get(name, 0)``)
        would fabricate a fully-measured, instantaneous join for every leg
        collected before this stage shipped.
        """
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            _write_csv(csv_path, count=4)
            playback = [{"elapsed_sec": 1, "playback_ttff_ms": 1500}]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="hls"
            )

        self.assertEqual(rows[1]["playback_ttff_ms"], "1500")
        for name in PLAYBACK_NULLABLE_KEYS:
            self.assertEqual(rows[1][name], "", msg=name)

    def test_mpegts_reports_no_manifest_phase_on_any_row(self):
        """A raw MPEG-TS pull has no manifest to fetch: the first response IS
        the media. A 0 ms manifest would claim an instant fetch of something the
        engine never requests (startup_budget.PLAYER_PHASE_NOTES['mpegts'])."""
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            _write_csv(csv_path, count=5)
            playback = [
                {
                    "elapsed_sec": second,
                    "startup_player_request_ms": 40.0,
                    "startup_manifest_ms": None,
                    "startup_first_media_ms": 800.0,
                    "startup_first_paint_ms": 300.0,
                }
                for second in range(1, 4)
            ]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="mpegts"
            )

        for index in range(1, 5):
            self.assertEqual(rows[index]["startup_manifest_ms"], "", msg=f"row {index}")
            self.assertEqual(rows[index]["startup_first_media_ms"], "800.0")

    def test_the_phases_survive_the_player_detaching(self):
        """Live gauges are blanked past the staleness window; a join fact is not.

        The player reports for three seconds and goes quiet. e2e stops being a
        measurement at that point, but "the join spent 2000 ms waiting for a
        decodable segment" stays true for the rest of the leg.
        """
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            _write_csv(csv_path, count=10)
            playback = [
                {
                    "elapsed_sec": second,
                    "e2e_latency_ms": 1200,
                    "playback_ttff_ms": 2700,
                    "startup_player_request_ms": 100.0,
                    "startup_manifest_ms": 300.0,
                    "startup_first_media_ms": 2000.0,
                    "startup_first_paint_ms": 300.0,
                }
                for second in range(3)
            ]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="hls"
            )

        self.assertEqual(rows[9]["e2e_latency_ms"], "")
        self.assertEqual(rows[9]["startup_first_media_ms"], "2000.0")
        self.assertEqual(rows[9]["startup_player_request_ms"], "100.0")

    def test_the_first_reading_of_a_phase_wins(self):
        """One-shot semantics.

        A mid-run reconnect re-runs the chain against an already-warm relay and
        a packager that is already cutting segments, so its numbers describe a
        different join. Taking the max would report the slowest join seen; a
        plain overwrite would report the fastest. Both answer a question nobody
        asked — the operator wants the join that was actually watched.
        """
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            _write_csv(csv_path, count=8)
            playback = [
                {
                    "elapsed_sec": 1,
                    "startup_player_request_ms": 100.0,
                    "startup_first_media_ms": 2000.0,
                },
                # Reconnect: warm path, and the manifest phase is now readable.
                {
                    "elapsed_sec": 4,
                    "startup_player_request_ms": 3.0,
                    "startup_manifest_ms": 12.0,
                    "startup_first_media_ms": 40.0,
                },
            ]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="hls"
            )

        self.assertEqual(rows[5]["startup_player_request_ms"], "100.0")
        self.assertEqual(rows[5]["startup_first_media_ms"], "2000.0")
        # A phase that had no reading yet still gets its first one.
        self.assertEqual(rows[5]["startup_manifest_ms"], "12.0")

    def test_a_null_never_overwrites_a_measured_phase(self):
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            _write_csv(csv_path, count=6)
            playback = [
                {"elapsed_sec": 1, "startup_manifest_ms": 300.0},
                {"elapsed_sec": 3, "startup_manifest_ms": None},
            ]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="hls"
            )

        self.assertEqual(rows[3]["startup_manifest_ms"], "300.0")

    def test_the_phases_reconcile_against_the_measured_ttff(self):
        """The chain is the decomposition of playback_ttff_ms, so a leg whose
        phases are all measured must very nearly sum to it — otherwise the
        columns are four unrelated numbers sharing a prefix."""
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            _write_csv(csv_path, count=4)
            playback = [
                {
                    "elapsed_sec": 1,
                    "playback_ttff_ms": 3000,
                    "startup_player_request_ms": 100.0,
                    "startup_manifest_ms": 300.0,
                    "startup_first_media_ms": 2000.0,
                    "startup_first_paint_ms": 600.0,
                }
            ]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="hls"
            )

        from startup_budget import build_player_startup

        row = rows[1]
        half = build_player_startup(
            engine="hls",
            request_ms=float(row["startup_player_request_ms"]),
            manifest_ms=float(row["startup_manifest_ms"]),
            first_media_ms=float(row["startup_first_media_ms"]),
            first_paint_ms=float(row["startup_first_paint_ms"]),
            ttff_ms=float(row["playback_ttff_ms"]),
        )
        self.assertEqual(half.accounted_ms, 3000.0)
        self.assertEqual(half.residual_ms, 0.0)
        self.assertEqual(half.overcount_ms, 0.0)
        self.assertEqual(half.unmeasured, frozenset())

    def test_a_blank_phase_reads_back_as_unmeasured_not_as_zero(self):
        """The round trip that matters: what the CSV carries has to come back
        out of the contract as *unmeasured*, which is what makes the residual
        explicable."""
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            _write_csv(csv_path, count=4)
            playback = [
                {
                    "elapsed_sec": 1,
                    "playback_ttff_ms": 3000,
                    "startup_player_request_ms": None,
                    "startup_manifest_ms": None,
                    "startup_first_media_ms": 2000.0,
                    "startup_first_paint_ms": 600.0,
                }
            ]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="hls"
            )

        from startup_budget import build_player_startup

        row = rows[1]

        def cell(name):
            raw = row[name]
            return None if raw == "" else float(raw)

        half = build_player_startup(
            engine="hls",
            request_ms=cell("startup_player_request_ms"),
            manifest_ms=cell("startup_manifest_ms"),
            first_media_ms=cell("startup_first_media_ms"),
            first_paint_ms=cell("startup_first_paint_ms"),
            ttff_ms=float(row["playback_ttff_ms"]),
        )
        self.assertEqual(
            half.unmeasured,
            frozenset({"startup_player_request_ms", "startup_manifest_ms"}),
        )
        # 400ms of the join is unexplained, and the columns say which stages
        # could not explain it. Had the blanks been zeros the residual would be
        # identical while claiming both stages were measured and free.
        self.assertEqual(half.residual_ms, 400.0)


class StartupPhaseSummaryTests(unittest.TestCase):
    def test_the_summary_reports_the_reading_not_a_mean_of_repeats(self):
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            _write_csv(csv_path, count=6)
            playback = [
                {
                    "elapsed_sec": 1,
                    "startup_player_request_ms": 100.0,
                    "startup_manifest_ms": None,
                    "startup_first_media_ms": 2000.0,
                }
            ]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="hls"
            )
        averages = compute_playback_averages(rows)

        self.assertEqual(averages["startup_player_request_ms"], 100.0)
        self.assertEqual(averages["startup_first_media_ms"], 2000.0)
        # Omitted entirely rather than published as 0 — the same lie in the
        # summary that blank-preserving avoids in the CSV.
        self.assertNotIn("startup_manifest_ms", averages)


class StartupPlayerReconciliationTests(unittest.TestCase):
    """The merge must do the arithmetic, not just carry the phases.

    The encoder loop cannot: the phases and the ``playback_ttff_ms`` they
    reconcile against both arrive from the browser after the row was flushed.
    Live legs on 2026-08-23 (Linode, all four protocols) populated every phase
    column and left every reconciliation column blank, so each leg said where
    its join time went and then declined to say whether the parts added up.
    """

    def _merged(self, engine: str, sample: dict) -> dict:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            csv_path = f"{tmp}/run.csv"
            _write_csv(csv_path, 4)
            rows = merge_playback_into_csv(
                csv_path,
                [{"elapsed_sec": 1, **sample}],
                csv_columns=CSV_COLUMNS,
                playback_engine=engine,
            )
        return rows[-1]

    def test_phases_that_add_up_reconcile_to_zero_residual(self):
        row = self._merged(
            "hls",
            {
                "startup_player_request_ms": 30.0,
                "startup_manifest_ms": 120.0,
                "startup_first_media_ms": 800.0,
                "startup_first_paint_ms": 551.0,
                "playback_ttff_ms": 1501.0,
            },
        )
        self.assertEqual(row["startup_player_accounted_ms"], "1501.0")
        self.assertEqual(row["startup_player_measured_ms"], "1501.0")
        self.assertEqual(row["startup_player_residual_ms"], "0.0")
        self.assertEqual(row["startup_player_overcount_ms"], "0.0")

    def test_a_missing_phase_becomes_residual_and_is_named(self):
        row = self._merged(
            "hls",
            {
                "startup_player_request_ms": 30.0,
                "startup_manifest_ms": 120.0,
                "playback_ttff_ms": 1501.0,
            },
        )
        self.assertEqual(row["startup_player_accounted_ms"], "150.0")
        self.assertEqual(row["startup_player_residual_ms"], "1351.0")
        self.assertIn("first_media", row["startup_unmeasured"])
        self.assertIn("first_paint", row["startup_unmeasured"])

    def test_the_engine_decides_not_applicable_not_the_player(self):
        """Raw MPEG-TS has no manifest; a null there is n/a, not unmeasured."""
        row = self._merged(
            "mpegts",
            {"startup_player_request_ms": 20.0, "playback_ttff_ms": 900.0},
        )
        self.assertIn("manifest", row["startup_not_applicable"])
        self.assertNotIn("manifest", row["startup_unmeasured"].split(","))

    def test_publisher_stage_names_survive_the_player_merge(self):
        """The two halves share the columns; one must not erase the other."""
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            csv_path = f"{tmp}/run.csv"
            _write_csv(csv_path, 4)
            with open(csv_path, newline="") as handle:
                rows = list(csv.DictReader(handle))
            for row in rows:
                row["startup_unmeasured"] = "handshake,publish_accept"
                row["startup_not_applicable"] = "connect"
            with open(csv_path, "w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
                writer.writeheader()
                writer.writerows(rows)
            merged = merge_playback_into_csv(
                csv_path,
                [{"elapsed_sec": 1, "startup_player_request_ms": 30.0,
                  "playback_ttff_ms": 900.0}],
                csv_columns=CSV_COLUMNS,
                playback_engine="hls",
            )
        last = merged[-1]
        self.assertIn("handshake", last["startup_unmeasured"])
        self.assertIn("publish_accept", last["startup_unmeasured"])
        self.assertIn("manifest", last["startup_unmeasured"])
        self.assertEqual(last["startup_not_applicable"], "connect")


if __name__ == "__main__":
    unittest.main()
