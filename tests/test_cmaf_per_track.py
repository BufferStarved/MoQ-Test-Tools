"""Per-track CMAF tfdt continuity (metrics audit item 8).

Regression: analyze_cmaf_file treated interleaved audio/video moofs as ONE
sequence with ONE timescale, reporting 1,091,846ms of "gaps" on a perfectly
continuous stream. Continuity must be tracked per tfhd.track_ID with each
track's own mdhd timescale.
"""

import struct
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from cmaf_integrity import analyze_cmaf_file  # noqa: E402

VIDEO_TRACK = 1
AUDIO_TRACK = 2
VIDEO_TIMESCALE = 90000
AUDIO_TIMESCALE = 48000


def box(box_type: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(payload), box_type) + payload


def full_box(box_type: bytes, version: int, flags: int, payload: bytes) -> bytes:
    return box(box_type, struct.pack(">B3s", version, flags.to_bytes(3, "big")) + payload)


def tkhd(track_id: int) -> bytes:
    # version 0: creation(4) modification(4) track_ID(4) reserved(4) duration(4)
    payload = struct.pack(">IIIII", 0, 0, track_id, 0, 0) + b"\x00" * 60
    return full_box(b"tkhd", 0, 7, payload)


def mdhd(timescale: int) -> bytes:
    # version 0: creation(4) modification(4) timescale(4) duration(4) lang(2) pre(2)
    payload = struct.pack(">IIIIHH", 0, 0, timescale, 0, 0x55C4, 0)
    return full_box(b"mdhd", 0, 0, payload)


def trak(track_id: int, timescale: int) -> bytes:
    return box(b"trak", tkhd(track_id) + box(b"mdia", mdhd(timescale)))


def moov() -> bytes:
    return box(
        b"moov",
        trak(VIDEO_TRACK, VIDEO_TIMESCALE) + trak(AUDIO_TRACK, AUDIO_TIMESCALE),
    )


def mfhd(sequence: int) -> bytes:
    return full_box(b"mfhd", 0, 0, struct.pack(">I", sequence))


def tfhd(track_id: int) -> bytes:
    return full_box(b"tfhd", 0, 0, struct.pack(">I", track_id))


def tfdt(decode_time: int) -> bytes:
    return full_box(b"tfdt", 0, 0, struct.pack(">I", decode_time))


def trun(sample_durations) -> bytes:
    # flags: 0x000100 sample-duration-present
    payload = struct.pack(">I", len(sample_durations))
    for duration in sample_durations:
        payload += struct.pack(">I", duration)
    return full_box(b"trun", 0, 0x000100, payload)


def traf(track_id: int, decode_time: int, sample_durations) -> bytes:
    return box(b"traf", tfhd(track_id) + tfdt(decode_time) + trun(sample_durations))


def moof(sequence: int, trafs: bytes) -> bytes:
    return box(b"moof", mfhd(sequence) + trafs)


def mdat() -> bytes:
    return box(b"mdat", b"\x00" * 16)


def write_capture(data: bytes) -> str:
    handle = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    handle.write(data)
    handle.close()
    return handle.name


class PerTrackContinuityTests(unittest.TestCase):
    def _interleaved_stream(self, *, audio_gap_at: int = -1) -> bytes:
        """Alternating video/audio moofs, each track perfectly continuous.

        Video: 1s fragments at 90000 ticks; audio: 1s fragments at 48000 ticks.
        """
        data = box(b"ftyp", b"isom\x00\x00\x02\x00isomiso6") + moov()
        seq = 1
        for second in range(6):
            video_dt = second * VIDEO_TIMESCALE
            data += moof(seq, traf(VIDEO_TRACK, video_dt, [3000] * 30)) + mdat()
            seq += 1
            audio_dt = second * AUDIO_TIMESCALE
            if second == audio_gap_at:
                audio_dt += AUDIO_TIMESCALE  # skip a whole second of audio
            data += moof(seq, traf(AUDIO_TRACK, audio_dt, [1024] * 47)) + mdat()
            seq += 1
        return data

    def test_perfect_interleaved_stream_has_zero_gaps(self):
        path = write_capture(self._interleaved_stream())
        report = analyze_cmaf_file(path)
        self.assertEqual(report.error, "")
        self.assertEqual(report.fragment_count, 12)
        self.assertEqual(report.seq_gap_count, 0)
        self.assertEqual(report.tfdt_gap_count, 0, [e for e in report.events if e.tfdt_gap])
        self.assertEqual(report.tfdt_overlap_count, 0)
        self.assertEqual(report.parse_errors, 0)
        self.assertAlmostEqual(report.tfdt_gap_ms_total, 0.0)

    def test_real_gap_in_one_track_is_still_detected(self):
        path = write_capture(self._interleaved_stream(audio_gap_at=3))
        report = analyze_cmaf_file(path)
        # The audio track jumped ahead one second once. The following audio
        # fragment continues from the shifted timeline, which reads as an
        # overlap (rewind) — but no phantom video gaps appear.
        self.assertGreaterEqual(report.tfdt_gap_count, 1)
        gap_events = [e for e in report.events if e.tfdt_gap]
        self.assertTrue(all(e.track_id == AUDIO_TRACK for e in gap_events))
        # ~1s of skipped audio.
        self.assertAlmostEqual(report.tfdt_gap_ms_total, 1000.0, delta=100.0)

    def test_per_track_timescales_resolved(self):
        path = write_capture(self._interleaved_stream())
        report = analyze_cmaf_file(path)
        video_events = [e for e in report.events if e.track_id == VIDEO_TRACK]
        audio_events = [e for e in report.events if e.track_id == AUDIO_TRACK]
        self.assertTrue(all(e.timescale == VIDEO_TIMESCALE for e in video_events))
        self.assertTrue(all(e.timescale == AUDIO_TIMESCALE for e in audio_events))
        # media_time_sec advances 1s per fragment on both tracks.
        self.assertAlmostEqual(video_events[5].media_time_sec, 5.0)
        self.assertAlmostEqual(audio_events[5].media_time_sec, 5.0)

    def test_tfhd_default_duration_fallback(self):
        """trun without per-sample durations must fall back to the tfhd
        default_sample_duration instead of flagging every fragment."""

        def traf_default_duration(track_id: int, decode_time: int) -> bytes:
            # tfhd flags 0x000008: default-sample-duration present (3000 ticks).
            tfhd_box = full_box(b"tfhd", 0, 0x000008, struct.pack(">II", track_id, 3000))
            # trun with sample_count only (no per-sample fields).
            trun_box = full_box(b"trun", 0, 0x000000, struct.pack(">I", 30))
            return box(b"traf", tfhd_box + tfdt(decode_time) + trun_box)

        data = box(b"ftyp", b"isom\x00\x00\x02\x00isomiso6") + moov()
        for second in range(4):
            data += moof(
                second + 1,
                traf_default_duration(VIDEO_TRACK, second * VIDEO_TIMESCALE),
            ) + mdat()
        report = analyze_cmaf_file(write_capture(data))
        self.assertEqual(report.tfdt_gap_count, 0)
        self.assertEqual(report.tfdt_overlap_count, 0)


if __name__ == "__main__":
    unittest.main()
