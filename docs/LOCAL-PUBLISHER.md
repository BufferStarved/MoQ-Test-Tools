# Local publisher agent

Run **ffmpeg on your laptop** while the UI/API orchestrates jobs and talks to remote
ingest (Zixi / MediaMTX / MoQ). That is the true internet-acquisition path: your
ISP and Wi‑Fi sit between the encoder and the cloud ingest hosts.

> **Hosted site:** `https://moq.sean-mccarthy.net` keeps encoding on the GCP web VM
> (`LOCAL_PUBLISHER_ENABLED` is unset). This feature is for local development now
> and is structured so hosted users can opt in later with the same agent.

## Quick start (dev)

Terminal 1 — API + UI (enables the feature flag):

```bash
./scripts/dev.sh
```

Terminal 2 — publisher agent (this machine’s ffmpeg):

```bash
./scripts/run-local-publisher.sh
```

In the Benchmark **Run recipe**:

1. Set **Publisher → This machine (local agent)**.
2. Choose **Media**:
   - **Webcam** — agent opens the machine camera (AVFoundation on macOS, V4L2 on Linux)
   - **Local file…** — pick a video on this computer (uploaded to `uploads/`, read by the agent)
3. Start a comparison. Use **Stop** to end a webcam run early.

Repo VOD assets (Color Bars / BBB) stay available only for **Cloud VM** encode — they are not shown for This machine.

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

- Feature flag: `LOCAL_PUBLISHER_ENABLED=1` (set by `scripts/dev.sh`).
- Shared token: `LOCAL_PUBLISHER_TOKEN` (default `dev-local-publisher`).
- Agent connects **outbound** to `ws://127.0.0.1:8000/api/publisher-agent/ws` (no inbound ports).
- Create upload with `publisher_host: "local"`; JobManager dispatches to the agent instead of in-process ffmpeg.

### Media paths

| UI choice | `media_path` sent to API/agent |
|-----------|--------------------------------|
| Webcam (local) | `device:webcam` |
| Local file | Absolute path under `uploads/` from `POST /api/media/upload` |
| Color Bars (cloud only) | `dummy.mp4` |
| Webcam (cloud) | `udp://127.0.0.1:…` via API live bridge |

## Dependencies (Mac + Linux)

| Tool | Required | Install |
|------|----------|---------|
| ffmpeg with libx264 | yes | `brew install ffmpeg-full` (macOS) |
| Camera / mic permission | for webcam | macOS: allow Terminal/ffmpeg in Privacy → Camera & Microphone |
| srt-live-transmit | recommended for SRT stats | `brew install srt` |
| openmoq-publisher | for MoQ legs | `./scripts/install-openmoq-publisher.sh` |

`./scripts/ensure-publisher-tools.sh` (called from `run-local-publisher.sh`) tries to install the optional pieces.

Optional env overrides:

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

## Roadmap toward hosted users

1. Issue per-user agent tokens from the hosted API.
2. Enable `LOCAL_PUBLISHER_ENABLED` on the web VM (UI already gates on `/api/features`).
3. Agent default `--api https://moq.sean-mccarthy.net`.
4. Stream chosen files to a remote agent (or upload directly to the agent) when API and laptop diverge.
