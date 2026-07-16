"""CMAF / fragmented MP4 media-health analysis (MoQ analogue of TR 101 290).

Walks ISOBMFF boxes and checks:
  - mfhd.sequence_number continuity (+1)
  - tfdt baseMediaDecodeTime continuity vs prior fragment duration
  - basic moof/mdat parseability

These are container/timeline integrity metrics — not transport (QUIC/SRT) metrics.
"""
from __future__ import annotations

import logging
import struct
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger("MoQ-SRT-Bench")

# Decode-time jump larger than (fragment_duration + slack) counts as a gap.
_TFDT_GAP_SLACK_MS = 50.0


@dataclass
class CmafFragmentEvent:
    index: int
    sequence_number: Optional[int]
    base_media_decode_time: Optional[int]
    timescale: int
    duration_ticks: int
    media_time_sec: float
    seq_gap: bool = False
    tfdt_gap: bool = False
    tfdt_gap_ms: float = 0.0
    tfdt_overlap: bool = False


@dataclass
class CmafIntegrityReport:
    path: str = ""
    fragment_count: int = 0
    seq_gap_count: int = 0
    tfdt_gap_count: int = 0
    tfdt_gap_ms_total: float = 0.0
    tfdt_overlap_count: int = 0
    parse_errors: int = 0
    timescale: int = 0
    events: List[CmafFragmentEvent] = field(default_factory=list)
    error: str = ""

    def as_summary_dict(self) -> Dict[str, float | int | str]:
        return {
            "cmaf_fragment_count": self.fragment_count,
            "cmaf_seq_gap_count": self.seq_gap_count,
            "cmaf_tfdt_gap_count": self.tfdt_gap_count,
            "cmaf_tfdt_gap_ms": round(self.tfdt_gap_ms_total, 3),
            "cmaf_tfdt_overlap_count": self.tfdt_overlap_count,
            "cmaf_parse_errors": self.parse_errors,
            "cmaf_timescale": self.timescale,
            "source_path": self.path,
            "error": self.error,
        }

    def cumulative_by_elapsed_sec(self) -> Dict[int, Dict[str, float | int]]:
        """Map media timeline → cumulative counters for CSV merge (1 Hz)."""
        by_sec: Dict[int, Dict[str, float | int]] = {}
        seq_gaps = 0
        tfdt_gaps = 0
        tfdt_gap_ms = 0.0
        overlaps = 0
        for event in self.events:
            if event.seq_gap:
                seq_gaps += 1
            if event.tfdt_gap:
                tfdt_gaps += 1
                tfdt_gap_ms += event.tfdt_gap_ms
            if event.tfdt_overlap:
                overlaps += 1
            elapsed = max(0, int(event.media_time_sec))
            by_sec[elapsed] = {
                "cmaf_seq_gap_count": seq_gaps,
                "cmaf_tfdt_gap_count": tfdt_gaps,
                "cmaf_tfdt_gap_ms": round(tfdt_gap_ms, 3),
                "cmaf_tfdt_overlap_count": overlaps,
                "cmaf_fragment_count": event.index + 1,
                "cmaf_parse_errors": self.parse_errors,
            }
        return by_sec


def _read_box_header(data: bytes, offset: int) -> Optional[Tuple[int, bytes, int, int]]:
    """Return (payload_start, type, payload_end, next_offset) or None."""
    if offset + 8 > len(data):
        return None
    size, type_bytes = struct.unpack_from(">I4s", data, offset)
    header_size = 8
    if size == 1:
        if offset + 16 > len(data):
            return None
        size = struct.unpack_from(">Q", data, offset + 8)[0]
        header_size = 16
    elif size == 0:
        size = len(data) - offset
    if size < header_size or offset + size > len(data):
        return None
    payload_start = offset + header_size
    payload_end = offset + size
    return payload_start, type_bytes, payload_end, payload_end


def _iter_boxes(data: bytes, start: int, end: int):
    offset = start
    while offset + 8 <= end:
        header = _read_box_header(data, offset)
        if header is None:
            break
        payload_start, type_bytes, payload_end, next_offset = header
        yield type_bytes, payload_start, payload_end
        if next_offset <= offset:
            break
        offset = next_offset


def _find_timescale(data: bytes) -> int:
    """Best-effort mdhd timescale from moov (defaults to 90000)."""
    for type_bytes, start, end in _iter_boxes(data, 0, len(data)):
        if type_bytes != b"moov":
            continue
        for t2, s2, e2 in _iter_boxes(data, start, end):
            if t2 != b"trak":
                continue
            for t3, s3, e3 in _iter_boxes(data, s2, e2):
                if t3 != b"mdia":
                    continue
                for t4, s4, e4 in _iter_boxes(data, s3, e3):
                    if t4 != b"mdhd" or e4 - s4 < 20:
                        continue
                    version = data[s4]
                    if version == 1 and e4 - s4 >= 32:
                        return int(struct.unpack_from(">I", data, s4 + 20)[0]) or 90000
                    if version == 0 and e4 - s4 >= 20:
                        return int(struct.unpack_from(">I", data, s4 + 12)[0]) or 90000
    return 90000


def _parse_mfhd_sequence(data: bytes, start: int, end: int) -> Optional[int]:
    if end - start < 8:
        return None
    # version(1) + flags(3) + sequence_number(4)
    return int(struct.unpack_from(">I", data, start + 4)[0])


def _parse_tfdt(data: bytes, start: int, end: int) -> Optional[int]:
    if end - start < 8:
        return None
    version = data[start]
    if version == 1 and end - start >= 12:
        return int(struct.unpack_from(">Q", data, start + 4)[0])
    if version == 0 and end - start >= 8:
        return int(struct.unpack_from(">I", data, start + 4)[0])
    return None


def _parse_trun_duration(data: bytes, start: int, end: int) -> int:
    """Sum sample durations from trun when present; else 0."""
    if end - start < 8:
        return 0
    version_flags = struct.unpack_from(">I", data, start)[0]
    flags = version_flags & 0xFFFFFF
    sample_count = struct.unpack_from(">I", data, start + 4)[0]
    cursor = start + 8
    if flags & 0x000001:  # data_offset
        cursor += 4
    if flags & 0x000004:  # first_sample_flags
        cursor += 4
    sample_duration_present = bool(flags & 0x000100)
    sample_size_present = bool(flags & 0x000200)
    sample_flags_present = bool(flags & 0x000400)
    sample_cto_present = bool(flags & 0x000800)
    per_sample = 0
    if sample_duration_present:
        per_sample += 4
    if sample_size_present:
        per_sample += 4
    if sample_flags_present:
        per_sample += 4
    if sample_cto_present:
        per_sample += 4
    if per_sample == 0 or not sample_duration_present:
        return 0
    total = 0
    for _ in range(sample_count):
        if cursor + per_sample > end:
            break
        if sample_duration_present:
            total += struct.unpack_from(">I", data, cursor)[0]
            cursor += 4
            if sample_size_present:
                cursor += 4
            if sample_flags_present:
                cursor += 4
            if sample_cto_present:
                cursor += 4
        else:
            cursor += per_sample
    return total


def _parse_moof(
    data: bytes, start: int, end: int
) -> Tuple[Optional[int], Optional[int], int]:
    sequence: Optional[int] = None
    decode_time: Optional[int] = None
    duration_ticks = 0
    for type_bytes, b_start, b_end in _iter_boxes(data, start, end):
        if type_bytes == b"mfhd":
            sequence = _parse_mfhd_sequence(data, b_start, b_end)
        elif type_bytes == b"traf":
            for t2, s2, e2 in _iter_boxes(data, b_start, b_end):
                if t2 == b"tfdt" and decode_time is None:
                    decode_time = _parse_tfdt(data, s2, e2)
                elif t2 == b"trun":
                    duration_ticks += _parse_trun_duration(data, s2, e2)
    return sequence, decode_time, duration_ticks


def analyze_cmaf_file(path: str) -> CmafIntegrityReport:
    report = CmafIntegrityReport(path=path)
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except OSError as exc:
        report.error = str(exc)
        report.parse_errors = 1
        return report

    if len(data) < 16:
        report.error = "file too small to be fragmented MP4"
        report.parse_errors = 1
        return report

    timescale = _find_timescale(data)
    report.timescale = timescale

    prev_seq: Optional[int] = None
    prev_decode: Optional[int] = None
    prev_duration = 0
    index = 0
    offset = 0
    while offset + 8 <= len(data):
        header = _read_box_header(data, offset)
        if header is None:
            report.parse_errors += 1
            break
        payload_start, type_bytes, payload_end, next_offset = header
        if type_bytes == b"moof":
            sequence, decode_time, duration_ticks = _parse_moof(data, payload_start, payload_end)
            if sequence is None and decode_time is None:
                report.parse_errors += 1
            media_time_sec = (decode_time / timescale) if decode_time is not None else float(index)
            event = CmafFragmentEvent(
                index=index,
                sequence_number=sequence,
                base_media_decode_time=decode_time,
                timescale=timescale,
                duration_ticks=duration_ticks,
                media_time_sec=media_time_sec,
            )
            if prev_seq is not None and sequence is not None:
                if sequence != prev_seq + 1:
                    event.seq_gap = True
                    report.seq_gap_count += 1
            if prev_decode is not None and decode_time is not None:
                expected = prev_decode + prev_duration
                delta_ticks = decode_time - expected
                delta_ms = (delta_ticks / timescale) * 1000.0
                if delta_ticks < 0:
                    event.tfdt_overlap = True
                    report.tfdt_overlap_count += 1
                elif delta_ms > _TFDT_GAP_SLACK_MS:
                    event.tfdt_gap = True
                    event.tfdt_gap_ms = delta_ms
                    report.tfdt_gap_count += 1
                    report.tfdt_gap_ms_total += delta_ms
            report.events.append(event)
            report.fragment_count += 1
            if sequence is not None:
                prev_seq = sequence
            if decode_time is not None:
                prev_decode = decode_time
            # Prefer measured duration; fall back to next-delta later via slack only.
            prev_duration = duration_ticks if duration_ticks > 0 else prev_duration
            index += 1
        offset = next_offset

    if report.fragment_count == 0 and not report.error:
        report.error = "no moof fragments found"
        report.parse_errors += 1
    return report