#!/usr/bin/env python3
"""Prove west draft-18 canary :14433 accepts a file-source publish + subscribe.

Does not use the laptop camera. Builds the same ffmpeg | moq5-fmp4-publish
argv UploadService uses for moq_gcp_relay_d18, then FETCHes with
moq5-fmp4-record. Prod :4433 is scraped only as a control.

  python3 scripts/probe_d18_publish.py
  python3 scripts/probe_d18_publish.py --duration 12

Exit 0 only when: WT connection_id, namespace announce, vide track in the
first live catalog, at least one video object, and a subscriber received
init + fragments. Does not change prod :4433 / moqx:329b98b.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from destinations import PRESET_BY_ID  # noqa: E402
from moq_publish import (  # noqa: E402
    MoqPublishTarget,
    build_ffmpeg_moq_cmd,
    build_moq_publisher_cmd,
    find_moq_publisher,
    parse_moq_publish_url,
    publisher_first_object_sent,
    publisher_webtransport_connected,
)
from moqx_stats import (  # noqa: E402
    admin_port_for_endpoint,
    parse_moqx_metrics,
    snapshot_as_probe_dict,
    snapshot_delta,
)

CANARY_PRESET = "moq_gcp_relay_d18"
CANARY_HOST = "34-28-164-90.sslip.io"
CANARY_IP = "34.28.164.90"
PROD_ADMIN = f"http://{CANARY_IP}:8000"
GCP_INSTANCE = os.environ.get("MOQX_CANARY_INSTANCE", "moq-relay-gcp")
GCP_ZONE = os.environ.get("GCP_ZONE", "us-central1-a")


def log(msg: str) -> None:
    print(msg, flush=True)


def run_logged(cmd: list[str], *, timeout: float = 20) -> subprocess.CompletedProcess[str]:
    log(f"$ {' '.join(cmd)}")
    return subprocess.run(
        cmd,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def dns_lookup(host: str) -> str:
    infos = socket.getaddrinfo(host, None, socket.AF_INET)
    return infos[0][4][0]


def tcp_probe(host: str, port: int, timeout: float = 5.0) -> tuple[bool, str]:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        return True, f"TCP {host}:{port} open"
    except OSError as exc:
        return False, f"TCP {host}:{port} {type(exc).__name__}: {exc}"
    finally:
        sock.close()


def fetch_url(url: str, timeout: float = 8.0) -> tuple[bool, str]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        return True, body
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return False, f"{type(exc).__name__}: {exc}"


def iap_curl(path: str, port: int) -> tuple[bool, str]:
    remote = (
        f"curl -fsS -m 3 http://127.0.0.1:{port}{path}"
    )
    proc = run_logged(
        [
            "gcloud",
            "compute",
            "ssh",
            f"ubuntu@{GCP_INSTANCE}",
            f"--zone={GCP_ZONE}",
            "--tunnel-through-iap",
            f"--command={remote}",
        ],
        timeout=45,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "iap failed").strip()
        return False, err
    return True, proc.stdout


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def catalog_has_video(log_text: str) -> bool:
    text = log_text or ""
    if "track added: vide" in text:
        return True
    if "attaching sender after CMAF init (0 tracks" in text:
        return False
    return False


def find_recorder() -> str | None:
    override = os.environ.get("MOQ5_RECORDER_BIN", "").strip()
    candidates = [
        override,
        str(ROOT / "tools" / "moq5-recorder" / "bin" / "moq5-fmp4-record"),
        str(ROOT / "tools" / "moq5-recorder" / "build" / "moq5-fmp4-record"),
    ]
    for path in candidates:
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def wait_for(predicate, timeout_sec: float, poll: float = 0.2) -> bool:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(poll)
    return predicate()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration", type=int, default=12)
    parser.add_argument(
        "--media",
        default=str(ROOT / "dummy.mp4"),
        help="File source (default: dummy.mp4). Not the camera.",
    )
    args = parser.parse_args()
    failures: list[str] = []

    log("=== 1. DNS + port control ===")
    try:
        ip = dns_lookup(CANARY_HOST)
        log(f"DNS {CANARY_HOST} -> {ip}")
        if ip != CANARY_IP:
            failures.append(f"DNS expected {CANARY_IP}, got {ip}")
    except OSError as exc:
        failures.append(f"DNS failed: {exc}")
        ip = CANARY_IP

    prod_admin_ok, prod_admin_msg = tcp_probe(ip, 8000)
    canary_admin_ok, canary_admin_msg = tcp_probe(ip, 18000)
    log(prod_admin_msg)
    log(canary_admin_msg + " (localhost-only is expected)")
    if not prod_admin_ok:
        failures.append("prod :8000 admin unreachable (control)")

    log("=== 2. Prod :4433 control (do not change) ===")
    prod_info_ok, prod_info = fetch_url(f"{PROD_ADMIN}/info")
    if not prod_info_ok:
        failures.append(f"prod /info: {prod_info}")
        log(f"FAIL prod /info: {prod_info}")
    else:
        log(f"prod /info: {prod_info.strip()}")
        if "0.1.0" not in prod_info and "329b98b" not in prod_info:
            log("NOTE: prod /info is not the 0.1.0 string; still did not touch it")

    prod_metrics_ok, prod_metrics_body = fetch_url(f"{PROD_ADMIN}/metrics")
    if prod_metrics_ok:
        prod_snap = parse_moqx_metrics(prod_metrics_body)
        log(f"prod metrics control: {json.dumps(snapshot_as_probe_dict(prod_snap))}")
    else:
        failures.append(f"prod /metrics: {prod_metrics_body}")

    log("=== 3. Canary :14433 admin via IAP ===")
    canary_info_ok, canary_info = iap_curl("/info", 18000)
    if not canary_info_ok:
        failures.append(f"canary IAP /info: {canary_info}")
        log(f"FAIL canary IAP /info: {canary_info}")
    else:
        log(f"canary /info: {canary_info.strip()}")
        if "75af044" not in canary_info and "88f9d27" not in canary_info:
            log("NOTE: canary /info is not 75af044 or leftover 88f9d27")

    before_ok, before_body = iap_curl("/metrics", 18000)
    if not before_ok:
        failures.append(f"canary IAP /metrics: {before_body}")
        before = None
    else:
        before = parse_moqx_metrics(before_body)
        log(f"canary metrics before: {json.dumps(snapshot_as_probe_dict(before))}")

    log("=== 4. ffmpeg | moq5-fmp4-publish (UploadService argv) ===")
    preset = PRESET_BY_ID[CANARY_PRESET]
    target = parse_moq_publish_url(preset.url)
    namespace = f"probe-d18-{int(time.time())}"
    target = MoqPublishTarget(
        endpoint=target.endpoint,
        namespace=namespace,
        transport=target.transport,
        draft=target.draft,
        forward=target.forward,
        insecure_tls=target.insecure_tls,
    )
    if target.draft != 18 or ":14433" not in target.endpoint:
        failures.append(f"refusing non-canary target {target}")
        log(f"FAIL dest {target.endpoint} draft={target.draft}")
        return 1

    publisher_bin, backend = find_moq_publisher(
        preset.id, url=preset.url, draft=18
    )
    if backend != "moq5" or not publisher_bin:
        failures.append(f"publisher backend={backend} bin={publisher_bin}")
        log(f"FAIL find_moq_publisher -> {backend} {publisher_bin}")
        return 1
    if "moq5-fmp4-publish" not in publisher_bin:
        failures.append(f"wrong publisher binary {publisher_bin}")
        return 1

    media = args.media
    if not os.path.isfile(media):
        failures.append(f"media missing: {media}")
        return 1

    tmp = Path(tempfile.mkdtemp(prefix="probe-d18-"))
    progress = str(tmp / "ffmpeg-progress.txt")
    pub_log = tmp / "publisher.log"
    ff_log = tmp / "ffmpeg.log"
    rec_log = tmp / "recorder.log"
    rec_out = tmp / "subscribe.mp4"

    ffmpeg_cmd = build_ffmpeg_moq_cmd(
        media,
        progress_path=progress,
        duration_sec=args.duration,
    )
    publisher_cmd = build_moq_publisher_cmd(
        publisher_bin,
        backend,
        target,
        duration_sec=args.duration,
    )
    log(f"ffmpeg: {' '.join(ffmpeg_cmd)}")
    log(f"publisher: {' '.join(publisher_cmd)}")

    def _pump(stream, dest: Path, bucket: list[str]) -> None:
        if stream is None:
            return
        with dest.open("w", encoding="utf-8") as handle:
            for raw in iter(stream.readline, b""):
                line = raw.decode("utf-8", errors="replace")
                handle.write(line)
                handle.flush()
                bucket.append(line)

    publisher = subprocess.Popen(
        publisher_cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    ffmpeg = subprocess.Popen(
        ffmpeg_cmd,
        stdout=publisher.stdin,
        stderr=subprocess.PIPE,
    )
    if publisher.stdin is not None:
        publisher.stdin.close()

    pub_lines: list[str] = []
    ff_lines: list[str] = []
    rec_lines: list[str] = []
    threading.Thread(
        target=_pump, args=(publisher.stderr, pub_log, pub_lines), daemon=True
    ).start()
    threading.Thread(
        target=_pump, args=(publisher.stdout, tmp / "publisher.stdout", pub_lines), daemon=True
    ).start()
    threading.Thread(
        target=_pump, args=(ffmpeg.stderr, ff_log, ff_lines), daemon=True
    ).start()

    recorder_bin = find_recorder()
    recorder = None
    if not recorder_bin:
        failures.append("moq5-fmp4-record not found; cannot prove subscribe/FETCH")
    else:
        # FETCH after vide is in the live catalog so we do not one-shot
        # the pre-moov empty `{tracks:[]}` object.
        if not wait_for(lambda: catalog_has_video("".join(pub_lines)), 15.0):
            log("WARN: starting subscriber without vide in publisher log yet")
        recorder_cmd = [
            recorder_bin,
            target.endpoint,
            namespace,
            str(rec_out),
            "--duration",
            str(max(args.duration, 8)),
        ]
        log(f"subscriber: {' '.join(recorder_cmd)}")
        recorder = subprocess.Popen(
            recorder_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        threading.Thread(
            target=_pump, args=(recorder.stderr, rec_log, rec_lines), daemon=True
        ).start()
        threading.Thread(
            target=_pump,
            args=(recorder.stdout, tmp / "recorder.stdout", rec_lines),
            daemon=True,
        ).start()

    deadline = time.monotonic() + args.duration + 8
    while time.monotonic() < deadline:
        if publisher.poll() is not None and ffmpeg.poll() is not None:
            if recorder is None or recorder.poll() is not None:
                break
        time.sleep(0.4)

    if ffmpeg.poll() is None:
        ffmpeg.terminate()
    if publisher.poll() is None:
        publisher.terminate()
    if recorder is not None and recorder.poll() is None:
        recorder.terminate()
    time.sleep(0.4)
    combined_pub = "".join(pub_lines)
    rec_text = "".join(rec_lines)
    ff_text = "".join(ff_lines)

    log("--- publisher log ---")
    log(combined_pub[-4000:] if combined_pub else "(empty)")
    log("--- recorder log ---")
    log(rec_text[-2000:] if rec_text else "(empty)")
    if ff_text.strip():
        log("--- ffmpeg stderr tail ---")
        log(ff_text[-800:])

    log("=== 5. Publish / subscribe verdict ===")
    if not publisher_webtransport_connected(combined_pub):
        failures.append("no WebTransport connection_id / track added")
        log("FAIL: publisher never printed connection_id=")
    else:
        log("PASS: WebTransport session (connection_id or track added)")

    if "attaching sender after CMAF init" not in combined_pub:
        failures.append("publisher did not defer sender attach until moov")
        log("FAIL: missing 'attaching sender after CMAF init'")
    else:
        log("PASS: sender attach deferred until CMAF init")

    if not catalog_has_video(combined_pub):
        failures.append("first catalog never grew a vide track")
        log("FAIL: no 'track added: vide' (empty catalog / publisher bug)")
    else:
        log("PASS: catalog advertised a vide track with init")

    if "sender ready (namespace + catalog published)" not in combined_pub and (
        "namespace" not in combined_pub.lower()
    ):
        # ready-line is best-effort; track added + live send is enough.
        log("NOTE: no explicit 'sender ready' line")
    else:
        log("PASS: namespace + catalog publish logged")

    if not publisher_first_object_sent(combined_pub):
        failures.append("no video object left the publisher")
        log("FAIL: no video object left the publisher")
    else:
        log("PASS: at least one video object/group left the publisher")

    rec_size = rec_out.stat().st_size if rec_out.exists() else 0
    if recorder_bin:
        if "wrote init segment" not in rec_text:
            failures.append("subscriber never FETCHed a vide init (catalog empty or FETCH failed)")
            log("FAIL: recorder did not write init segment")
        else:
            log("PASS: subscriber FETCHed catalog + vide init")
        if "recorded 0 fragments" in rec_text or rec_size < 64:
            failures.append("subscriber received no video fragments")
            log(f"FAIL: recorder output {rec_size} bytes")
        else:
            log(f"PASS: subscriber received fragments ({rec_size} bytes)")

    log("=== 6. Canary metrics after publish ===")
    after_ok, after_body = iap_curl("/metrics", 18000)
    if after_ok and before is not None:
        after = parse_moqx_metrics(after_body)
        delta = snapshot_delta(after, before)
        log(f"canary metrics after: {json.dumps(snapshot_as_probe_dict(after))}")
        log(f"canary window: {json.dumps(snapshot_as_probe_dict(delta))}")
        if delta.publish_namespace_success < 1:
            failures.append("canary publish_namespace_success delta < 1")
            log("FAIL: relay did not increment namespace announce")
        else:
            log(f"PASS: relay namespace announce +{delta.publish_namespace_success}")
        if delta.subscribe_success < 1 and recorder_bin:
            failures.append("canary subscribe_success delta < 1")
            log("FAIL: relay did not increment subscribe_success")
        elif recorder_bin:
            log(f"PASS: relay subscribe_success +{delta.subscribe_success}")
    elif not after_ok:
        failures.append(f"canary IAP /metrics after: {after_body}")

    log(f"logs: {tmp}")
    log(f"admin_port_for_endpoint canary={admin_port_for_endpoint(target.endpoint)} (expect 18000)")
    if admin_port_for_endpoint(target.endpoint) != 18000:
        failures.append("admin_port_for_endpoint did not map :14433 -> 18000")

    if failures:
        log("=== FAIL ===")
        for item in failures:
            log(f"- {item}")
        return 1
    log("=== PASS: west :14433 accepted publish + subscribe; catalog had vide ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
