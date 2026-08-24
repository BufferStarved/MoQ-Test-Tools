# Architecture

MoQ Test Tools compares **live video ingest** across protocols — primarily **MoQ (WebTransport → moqx draft-18)** vs **Zixi (SRT / RTMP)** and **MediaMTX**, with browser playback and post-run quality scoring.

Live demo: [https://moq.sean-mccarthy.net](https://moq.sean-mccarthy.net)

Public MoQ is **draft-18 on UDP `:14433`**. A leftover `moqx:329b98b` draft-16 listener on UDP `:4433` stays running on the original GCP/Linode relays and is **hidden from the UI**. Do not point new traffic or recorders at it.

## Goals

1. Encode the same source (file or webcam) once per comparison leg.
2. Publish over different ingest protocols under the same wall-clock window.
3. Collect a **normalized metric model** across encode, transport, edge/relay, media integrity, browser playback, and VMAF.
4. Let operators compare legs side by side in the browser and export CSV/JSON.

## System overview

```
1 Source                 2 Encode                         3 Ingest                         4 Playback
─────────                ───────                          ───────                          ─────────
file                  →  ffmpeg on moq-web             →  Zixi (SRT/RTMP → HLS)        →  hls.js
webcam (last-mile)    →  helper ffmpeg / OBS / Browser →  MediaMTX (SRT/RTMP/WebRTC)   →  HLS / WHEP
                                                      →  moqx WebTransport :14433     →  Playa
                                                             │
                                                             ▼
                                                    Ingest agent :8090
                                                    (server-side VMAF / CMAF)
```

**Webcam is a first-class last-mile path.** ffmpeg (helper) is the default encoder for every protocol. OBS is an optional encoder (OpenMOQ plugin is draft-16 only — use ffmpeg for public `:14433`). Browser encodes MoQ + WebRTC in this tab.

File-source jobs still encode on the orchestrator (`moq-web`). Webcam+ffmpeg never uses a shared helper: each browser mints a `publisher-session` and the public helper binds with `LOCAL_PUBLISHER_SESSION`.

Stacks that are not installed stay visible and **greyed per software role** (Zixi / MediaMTX / MoQ), not whole-region all-or-nothing. Empty `ZIXI_IP` greys only Zixi.

| Stack | Zixi | MediaMTX | MoQ `:14433` |
|-------|------|----------|--------------|
| GCP Central (Iowa) | live | live | live |
| GCP East | live | live | live |
| Linode East (Newark) | live | live | live |
| Linode Central (Dallas) | not installed | live | live |
| Linode West (Fremont) | not installed | live | live |
| GCP West / all AWS | not deployed | not deployed | not deployed |

Typical GCP Central layout:

| Role | Purpose |
|------|---------|
| `moq-web` | UI + API + file encode + publisher-session hub |
| `moq-zixi` | Zixi Broadcaster + ingest agent |
| `moq-relay` | moqx canary on UDP `:14433` (leftover `:4433` unused) |

Extra stacks activate on the same UI when their env is set on the orchestrator: Linode (`LINODE_*_STACK_ENABLED=1` + IPs) and GCP East (`GCP_EAST_*`). See `infra/linode/LINODE-STACK-RUNBOOK.md` and `infra/gcp/GCP-MULTIREGION-RUNBOOK.md`.

## Client path

1. User picks a recipe, then a source: a VOD asset encoded on the cloud VM, or a webcam on the visitor's machine (real ISP/last-mile upload).
2. Webcam+ffmpeg: the local publisher helper opens the machine's camera (AVFoundation / V4L2) with ffmpeg. Webcam+Browser uses this tab's capture. Webcam+OBS encodes in OBS; the plugin does MoQ.
3. API starts one `UploadJob` per leg; UI subscribes to SSE samples.
4. Preview players:
   - **MoQ:** vendored [moq-playa](../web/frontend/vendor/moq-playa) over WebTransport (`draftVersion: 18` on `:14433`).
   - **SRT/RTMP:** HLS.js against Zixi or MediaMTX HTTP egress (browsers cannot play raw SRT).
   - **WebRTC:** WHEP from MediaMTX.
5. Players report TTFF, stalls, and estimated E2E latency back to the API.

## Transport paths

| Protocol | Publish pipeline | Playback |
|----------|------------------|----------|
| SRT | ffmpeg → local UDP → `srt-live-transmit` → Zixi or MediaMTX | HLS |
| RTMP | ffmpeg → Zixi or MediaMTX RTMP | HLS |
| WebRTC | ffmpeg WHIP or browser WHIP → MediaMTX | WHEP |
| MoQ | ffmpeg → fMP4 → `moq5-fmp4-publish` → moqx `:14433` | Playa (WebTransport) |

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
| Local publisher agent hub | [`web/api/publisher_hub.py`](../web/api/publisher_hub.py) |
| Per-role grey-out | [`src/cloud_placement.py`](../src/cloud_placement.py) `host_role_configured` |
| Frontend | [`web/frontend/src/App.tsx`](../web/frontend/src/App.tsx) |
| Players | [`web/frontend/src/players/`](../web/frontend/src/players/) |
| Ingest agent | [`ingest_agent/`](../ingest_agent/) |
| Infra runbooks | [`infra/web/`](../infra/web/), [`infra/moqx/`](../infra/moqx/), [`infra/zixi/`](../infra/zixi/) |

## Feedback

- File issues: [github.com/BufferStarved/MoQ-Test-Tools](https://github.com/BufferStarved/MoQ-Test-Tools)
- Email: [me@sean-mccarthy.net](mailto:me@sean-mccarthy.net)
- Slack: **Sean McCarthy** on [video-dev](https://video-dev.org/) Slack
