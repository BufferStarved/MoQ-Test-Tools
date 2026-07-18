# MediaMTX (GCP) — LL-HLS / WHEP delivery

MediaMTX is the **standards LL delivery** origin for this bench (Apple-style LL-HLS + WHEP).  
Zixi remains the contribution / Fast-HLS path. ffmpeg still encodes and publishes.

## Role

| Direction | Protocol | URL shape |
|-----------|----------|-----------|
| Publish | SRT | `srt://<ip>:8890?streamid=publish:benchmark` |
| Publish | RTMP | `rtmp://<ip>:1935/benchmark` |
| Publish | WHIP | `http://<ip>:8889/benchmark/whip` |
| Play | LL-HLS | `http://<ip>:8888/benchmark/index.m3u8` |
| Play | LL-DASH | `http://<ip>:8891/benchmark/manifest.mpd` (ffmpeg CMAF sidecar) |
| Play | WHEP | `http://<ip>:8889/benchmark/whep` |

Browser HLS uses the existing `moq-web` HTTPS proxy (`/api/playback/fetch`) so LL-HLS works without MediaMTX TLS.

## Install (on `moq-web-gcp` today)

```bash
# From a laptop with gcloud SSH:
gcloud compute ssh moq-web-gcp --zone=us-central1-a --command='bash -s' < infra/mediamtx/scripts/install-mediamtx.sh

# Or after rsyncing the repo to /opt/moq-test-tools:
PUBLIC_IP=34.9.217.178 sudo bash /opt/moq-test-tools/infra/mediamtx/scripts/install-mediamtx.sh
```

Open ports (once) on the web VPC (`moq-web-vpc`, tag `moq-web`):

```bash
gcloud compute firewall-rules create moq-web-mediamtx \
  --project="$(gcloud config get-value project)" \
  --direction=INGRESS \
  --priority=1000 \
  --network=moq-web-vpc \
  --action=ALLOW \
  --rules=tcp:1935,tcp:8554,tcp:8888,tcp:8889,tcp:8891,udp:8890,udp:8189 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=moq-web
```

Created on 2026-07-18 after external publish tests timed out on :8888/:8891/:1935.

Live smoke (on the VM):

```bash
sudo bash /opt/moq-test-tools/scripts/test_mediamtx_live.sh
```

## UI presets

Ingest endpoint **MediaMTX gcp-us-central1**:

- SRT → `moq_mediamtx_gcp_srt`
- RTMP → `moq_mediamtx_gcp_rtmp`
- WebRTC (WHIP) → `moq_mediamtx_gcp_whip`

Playback: Auto / **LL-HLS** / **LL-DASH** / WHEP.

## Verify

```bash
# while publishing
curl -sS "http://127.0.0.1:8888/benchmark/index.m3u8" | head
curl -sS "http://127.0.0.1:8891/benchmark/manifest.mpd" | head
curl -sS "http://127.0.0.1:9997/v3/paths/list"   # API on localhost only
systemctl status moq-mediamtx-lldash --no-pager
```

## Notes

- MediaMTX `hlsVariant: lowLatency` is real LL-HLS (parts), not Zixi Fast HLS.
- **LL-DASH** is not native MediaMTX — `moq-mediamtx-lldash.service` pulls RTSP from MediaMTX and runs `ffmpeg -f dash -ldash 1`, served by nginx on **:8891**.
- Do not point Zixi SRT reset logic at these presets (`ingest_provider=gcp_mediamtx`).
- **Ingest metrics:** `MediaMtxStatsPoller` reads `http://127.0.0.1:9998/metrics` on moq-web and maps SRT/path counters into `net_*` / `pkt_*` (see `docs/METRICS.md`).
