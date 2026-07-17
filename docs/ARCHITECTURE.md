# Architecture

MoQ Test Tools compares **live video ingest** across protocols — primarily **MoQ (WebTransport → OpenMOQ/moqx relay)** vs **traditional Zixi paths (SRT / RTMP)** with browser playback and post-run quality scoring.

Live demo: [https://moq.sean-mccarthy.net](https://moq.sean-mccarthy.net)

## Goals

1. Encode the same source (file or webcam) once per comparison leg.
2. Publish over different ingest protocols under the same wall-clock window.
3. Collect a **normalized metric model** across encode, transport, edge/relay, media integrity, browser playback, and VMAF.
4. Let operators compare legs side by side in the browser and export CSV/JSON.

## System overview

```
1 Source          2 Encode (moq-web)       3 Ingest                         4 Playback
─────────         ──────────────────       ───────                          ─────────
file / webcam  →  ffmpeg on moq-web VM  →  Zixi (SRT/RTMP → HLS :7777)  →  hls.js
                  srt-live-transmit        moqx (WebTransport :4433)    →  Playa
                  openmoq-publisher            │
                                               ▼
                                      Ingest agent :8090
                                      (server-side VMAF / CMAF)

Demo hosts are GCP us-central1 today; AWS/Linode Zixi presets are planned.
```

Typical GCP layout (us-central1):

| Role | Purpose |
|------|---------|
| `moq-web` | UI + API + encode/publish |
| `moq-zixi` | Zixi Broadcaster + ingest agent |
| `moq-relay` | OpenMOQ / moqx relay |

## Client path

1. User configures two or more ingest endpoints and a media source (dummy MP4 or webcam).
2. Webcam mode: `getUserMedia` → `MediaRecorder` → WebSocket → API ffmpeg bridge → per-leg UDP MPEG-TS sources.
3. API starts one `UploadJob` per leg; UI subscribes to SSE samples.
4. Preview players:
   - **MoQ:** vendored [moq-playa](../web/frontend/vendor/moq-playa) over WebTransport.
   - **SRT/RTMP:** HLS.js against Zixi HTTP egress (browsers cannot play raw SRT).
5. Players report TTFF, stalls, and estimated E2E latency back to the API.

## Transport paths

| Protocol | Publish pipeline | Playback |
|----------|------------------|----------|
| SRT | ffmpeg → local UDP → `srt-live-transmit` → Zixi | HLS from Zixi `:7777` |
| RTMP | ffmpeg → Zixi RTMP | HLS from Zixi |
| MoQ | ffmpeg → fMP4 → `openmoq-publisher` → moqx | MoQ player (WebTransport) |

Live MoQ publishes are **unpaced** so the publisher does not artificially lag a realtime webcam; the player uses catch-up toward a low target latency.

## Metrics stages

See [METRICS.md](./METRICS.md) for field-level detail. High-level stages:

1. **Encode** — bitrate, FPS, speed, encode lag  
2. **Network transport (`net_*`)** — RTT, jitter, send/recv, loss/retrans  
3. **Edge / relay** — Zixi/libsrt recovery; moqx subscribe/object counters  
4. **Media health** — MPEG-TS continuity (Zixi TR101) vs CMAF sequence/decode-time gaps (MoQ)  
5. **Playback** — TTFF, stalls, E2E latency (includes intentional HLS live buffer)  
6. **Video quality** — encoder and/or ingest VMAF / PSNR / SSIM  

## Key implementation paths

| Area | Location |
|------|----------|
| Publish orchestration | [`src/upload_service.py`](../src/upload_service.py) |
| MoQ publisher wiring | [`src/moq_publish.py`](../src/moq_publish.py) |
| Metric CSV/summary | [`src/metrics.py`](../src/metrics.py), [`docs/METRICS.md`](./METRICS.md) |
| Web API | [`web/api/main.py`](../web/api/main.py), [`web/api/job_manager.py`](../web/api/job_manager.py) |
| Live webcam bridge | [`web/api/live_webcam.py`](../web/api/live_webcam.py) |
| Frontend | [`web/frontend/src/App.tsx`](../web/frontend/src/App.tsx) |
| Players | [`web/frontend/src/players/`](../web/frontend/src/players/) |
| Ingest agent | [`ingest_agent/`](../ingest_agent/) |
| Infra runbooks | [`infra/web/`](../infra/web/), [`infra/moqx/`](../infra/moqx/), [`infra/zixi/`](../infra/zixi/) |

## Feedback

- File issues: [github.com/BufferStarved/MoQ-Test-Tools](https://github.com/BufferStarved/MoQ-Test-Tools)
- Email: [me@sean-mccarthy.net](mailto:me@sean-mccarthy.net)
- Slack: **Sean McCarthy** on [video-dev](https://video-dev.org/) Slack
