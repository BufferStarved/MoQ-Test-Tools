# Local publisher agent

Run **ffmpeg on your laptop** while the UI/API orchestrates jobs and talks to remote
ingest (Zixi / MediaMTX / MoQ). That is the true internet-acquisition path: your
ISP and Wi‑Fi sit between the encoder and the cloud ingest hosts.

> **Hosted site:** Local publish is enabled by default (`LOCAL_PUBLISHER_ENABLED=1` on
> the web VM). Choose **Webcam** under Source in the UI — the Run recipe shows a
> copy-paste agent command for this site. Set `LOCAL_PUBLISHER_ENABLED=0` to disable the
> Webcam option entirely (VOD-on-cloud remains available either way).
>
> **Hosted quick start** (after cloning the repo once):
>
> ```bash
> LOCAL_PUBLISHER_API=https://moq.sean-mccarthy.net \
> LOCAL_PUBLISHER_TOKEN=dev-local-publisher \
> ./scripts/run-local-publisher.sh
> ```
>
> Prefer OBS or your own ffmpeg? See [BYO-ENCODER.md](./BYO-ENCODER.md) for publish URLs and settings.

## Quick start (dev)

One terminal — API + UI + publisher agent (the agent auto-starts):

```bash
./scripts/dev.sh
```

`dev.sh` launches the publisher agent alongside the API, so last-mile webcam
works out of the box. Set `LOCAL_PUBLISHER_AUTOSTART=0` to opt out (e.g. when
running the agent from a different machine), then start it manually:

```bash
./scripts/run-local-publisher.sh
```

In the Benchmark **Run recipe**, under **Source**, choose **Webcam** — this is the only
source that runs on your machine. The agent opens the machine camera (AVFoundation on
macOS, V4L2 on Linux); once it connects, a **Camera** dropdown lists the devices it
found — pick one or leave "Auto (default camera)". Start a comparison, then **Stop** to
end the webcam run early.

**VOD asset** (Color Bars or an uploaded file) is the other Source option and always
encodes on a cloud VM — there's no independent "encode location" toggle anymore; the
source you pick fully determines where ffmpeg runs.

## Smoke test

With API + agent already running:

```bash
DURATION=10 ./scripts/smoke-local-publisher.sh
```

This uploads a synthetic clip (not a VOD preset), asserts local media gates, runs a short
MediaMTX SRT job through the agent, and checks samples land on the API.

Unit / API gate coverage lives under `tests/test_publisher_*.py`,
`tests/test_device_webcam.py`, and `tests/test_local_publisher_api_gates.py`.

## How it works

```text
Browser  →  local API (orchestrator, SSE, Results)
                 │
                 │  WebSocket job_start / sample / job_done
                 ▼
           publisher agent (laptop)
                 │  UploadService → ffmpeg (+ srt-live-transmit / openmoq-publisher)
                 │    media: device:webcam  OR  /…/uploads/<file>
                 ▼
           Internet → Zixi / MediaMTX / MoQ ingest
```

- Feature flag: `LOCAL_PUBLISHER_ENABLED=1` (default in `scripts/dev.sh` and the web VM install).
- Shared token: `LOCAL_PUBLISHER_TOKEN` (default `dev-local-publisher`).
- Agent connects **outbound** to `ws://127.0.0.1:8000/api/publisher-agent/ws` (no inbound ports).
- Create upload with `publisher_host: "local"`; JobManager dispatches to the agent instead of in-process ffmpeg.

### Media paths

| UI choice | `media_path` sent to API/agent |
|-----------|--------------------------------|
| Webcam | `device:webcam` — or `device:webcam:N` when a camera is picked in the UI |
| Color Bars (VOD, cloud) | `dummy.mp4` |
| Uploaded file (VOD, cloud) | Absolute path under `uploads/` from `POST /api/media/upload` |

The API still accepts `publisher_host: "local"` with an uploaded file path (used by
`smoke-local-publisher.sh` and the agent test suite) — it's just not exposed as a UI
choice anymore, since Webcam is the only Source option that runs on your machine.

## Dependencies (Mac + Linux)

| Tool | Required | Install |
|------|----------|---------|
| ffmpeg with libx264 | yes | `brew install ffmpeg-full` (macOS) |
| Camera / mic permission | for webcam | macOS: allow Terminal/ffmpeg in Privacy → Camera & Microphone |
| srt-live-transmit | recommended for SRT stats | `brew install srt` |
| openmoq-publisher | for MoQ legs | `./scripts/install-openmoq-publisher.sh` (default **v0.3.2**; candidate **v0.3.11** still fails CONNECT against prod `329b98b` and canary `5611457` — keep the default until `scripts/smoke-openmoq-publisher.sh` PASSes) |

`./scripts/ensure-publisher-tools.sh` (called from `run-local-publisher.sh`) tries to install the optional pieces.

Optional env overrides (defaults when no camera is picked in the UI — the UI
Camera dropdown wins for the video device):

- `LOCAL_WEBCAM_AVFOUNDATION=0:0` — macOS AVFoundation `video:audio` indices
- `LOCAL_WEBCAM_DEVICE=/dev/video0` — Linux V4L2 device
- `MEDIAMTX_LOOPBACK_PUBLISH=0` — set automatically by the agent (publish to public ingest IP)

Check only:

```bash
./scripts/run-local-publisher.sh --check-only
```

## API surface (for future hosted users)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/features` | `{ local_publisher, local_publisher_connected, agents[] }` |
| `WS /api/publisher-agent/ws?token=…&agent_id=…` | Agent control plane |
| `POST /api/uploads` + `publisher_host=local` | Dispatch encode to a connected agent |
| `POST /api/media/upload` | Stage a local file for the agent (same machine in v1) |

Later: point the agent at `wss://moq.sean-mccarthy.net/api/publisher-agent/ws` with a
user-issued token; the hosted UI will show the same Publisher toggle once the
flag is enabled server-side for that deployment.

## Limits (v1)

- Local webcam uses **agent-side** device capture (not the browser MediaRecorder bridge).
- Browser camera preview is released before start so macOS can hand the device to ffmpeg.
- Local file upload assumes the agent can read the API host’s `uploads/` directory (same laptop in dev).
- One or more agents can connect; jobs go to the least-busy ready agent.

## Related docs

- [BYO-ENCODER.md](./BYO-ENCODER.md) — publish with OBS / your ffmpeg (playback monitoring)
- [RTMP-STARTUP.md](./RTMP-STARTUP.md) — RTMP join latency
- [METRICS.md](./METRICS.md) — chart definitions

## Roadmap toward hosted users

1. Issue per-user agent tokens from the hosted API (shared `LOCAL_PUBLISHER_TOKEN` is fine for a single operator).
2. Point the agent at the hosted API: `--api https://moq.sean-mccarthy.net` (feature flag defaults on).
3. Stream chosen files to a remote agent (or upload directly to the agent) when API and laptop diverge.
