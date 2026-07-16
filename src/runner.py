import subprocess
import logging
import argparse
import sys
import os

if __name__ == "__main__" and "--list-presets" in sys.argv:
    from destinations import list_presets_text
    print(list_presets_text())
    sys.exit(0)

from destinations import (
    DestinationConfigError,
    prompt_destination,
    resolve_cli_destination,
)
from upload_service import UploadJob, UploadService

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("MoQ-SRT-Bench")


def resolve_media_path(args) -> str:
    if args.media:
        return args.media
    if sys.stdin.isatty():
        media = input("Path to media file [dummy.mp4]: ").strip()
        return media or "dummy.mp4"
    raise DestinationConfigError("--media is required in non-interactive mode")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Benchmark video encode and upload to SRT, RTMP, HTTP, or WebRTC endpoints",
    )
    parser.add_argument("--media", help="Path to local media file (default: dummy.mp4)")
    parser.add_argument("--duration", type=int, default=30, help="Upload duration in seconds")
    parser.add_argument(
        "--list-presets",
        action="store_true",
        help="Print available preset endpoints and URL syntax, then exit",
    )
    parser.add_argument("--preset", help="Preset endpoint ID (see --list-presets)")
    parser.add_argument(
        "--protocol",
        choices=["srt", "rtmp", "hls", "dash", "http", "webrtc"],
        help="Protocol for --endpoint-url",
    )
    parser.add_argument("--endpoint-url", help="Custom endpoint URL")
    return parser


if __name__ == "__main__":
    parser = build_arg_parser()
    args = parser.parse_args()

    try:
        media_path = resolve_media_path(args)
        if args.preset or args.endpoint_url:
            destination = resolve_cli_destination(args)
        else:
            destination = prompt_destination()
    except DestinationConfigError as exc:
        logger.error("%s", exc)
        sys.exit(1)

    if not os.path.exists(media_path):
        logger.error("Media file not found: %s", media_path)
        sys.exit(1)

    print("")
    print(f"Protocol : {destination.protocol.upper()}")
    print(f"Endpoint : {destination.url}")
    if destination.preset_id:
        print(f"Preset   : {destination.preset_id}")
    print(f"Media    : {media_path}")
    print(f"Duration : {args.duration}s")
    print("")
    print("Status   : starting upload...")
    print("")

    job = UploadJob(media_path=media_path, destination=destination, duration_sec=args.duration)
    service = UploadService()

    def on_sample(sample):
        from network_metrics import UploadStatus
        status = UploadStatus(
            bitrate_kbps=sample.encoded_bitrate_kbps,
            fps=sample.fps,
            speed=sample.speed,
            out_time=sample.out_time,
            progress=sample.progress,
        )
        print(
            status.display_line_extended(
                sample.elapsed_sec,
                sample.cpu_percent,
                sample.memory_mb,
                rtt_ms=sample.transport_rtt_ms,
                rtt_jitter_ms=sample.transport_rtt_jitter_ms,
                pkt_retrans=sample.pkt_retrans,
                fps_stability=sample.fps_stability,
            ),
            end="\r",
            flush=True,
        )

    result = service.run(job, on_sample=on_sample)
    print("")

    if result.success and result.csv_path:
        print(f"Upload complete. Metrics saved to: {result.csv_path}")
    else:
        logger.error(result.error or "Upload failed")
        sys.exit(1)
