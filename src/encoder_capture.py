"""Encoder-output capture helpers for local VMAF scoring."""

from __future__ import annotations

import os
import subprocess
import threading
from typing import List

from moq_publish import MPEGTS_VIDEO_BSF


def encoder_capture_filename(protocol: str) -> str:
    if protocol == "moq":
        return "encoder_capture.mp4"
    if protocol == "rtmp":
        return "encoder_capture.flv"
    return "encoder_capture.ts"


def encoder_capture_path(temp_dir: str, protocol: str) -> str:
    return os.path.join(temp_dir, encoder_capture_filename(protocol))


def build_tee_output_args(protocol: str, network_url: str, capture_path: str) -> List[str]:
    """Build ffmpeg tee muxer args that write to network + local capture file."""
    if protocol in {"srt", "hls", "dash", "http"}:
        tee_spec = (
            f"[f=mpegts]{network_url}|[f=mpegts:onfail=ignore]{capture_path}"
        )
        return ["-map", "0", "-bsf:v", MPEGTS_VIDEO_BSF, "-f", "tee", tee_spec]

    if protocol == "rtmp":
        tee_spec = (
            f"[f=flv:flvflags=no_duration_filesize]{network_url}"
            f"|[f=flv:flvflags=no_duration_filesize:onfail=ignore]{capture_path}"
        )
        return ["-map", "0", "-f", "tee", tee_spec]

    raise ValueError(f"Encoder capture tee is not supported for protocol: {protocol}")


def fanout_stdout(source, destinations: List[object]) -> None:
    """Read ffmpeg stdout and write each chunk to every destination."""
    try:
        for chunk in iter(lambda: source.read(65536), b""):
            for dest in destinations:
                dest.write(chunk)
                dest.flush()
    except (ValueError, OSError):
        pass
    finally:
        for dest in destinations:
            try:
                dest.close()
            except OSError:
                pass


def start_moq_capture_tee(
    ffmpeg_stdout,
    capture_path: str,
) -> subprocess.Popen:
    """Tee MoQ fMP4 stdout to a local file and the publisher via the tee binary."""
    tee_proc = subprocess.Popen(
        ["tee", capture_path],
        stdin=ffmpeg_stdout,
        stdout=subprocess.PIPE,
    )
    return tee_proc
