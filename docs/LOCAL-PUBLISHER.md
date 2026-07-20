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

1. Set **Publisher → This machine (local agent)** (only visible when the flag is on).
2. Keep **Media → Color Bars** (webcam + local agent is not wired yet).
3. Start a comparison as usual.

## How it works

```text
Browser  →  local API (orchestrator, SSE, Results)
                 │
                 │  WebSocket job_start / sample / job_done
                 ▼
           publisher agent (laptop)
                 │  UploadService → ffmpeg (+ srt-live-transmit / openmoq-publisher)
                 ▼
           Internet → Zixi / MediaMTX / MoQ ingest
```

- Feature flag: `LOCAL_PUBLISHER_ENABLED=1` (set by `scripts/dev.sh`).
- Shared token: `LOCAL_PUBLISHER_TOKEN` (default `dev-local-publisher`).
- Agent connects **outbound** to `ws://127.0.0.1:8000/api/publisher-agent/ws` (no inbound ports).
- Create upload with `publisher_host: "local"`; JobManager dispatches to the agent instead of in-process ffmpeg.

## Dependencies (Mac + Linux)

| Tool | Required | Install |
|------|----------|---------|
| ffmpeg with libx264 | yes | `brew install ffmpeg-full` (macOS) |
| srt-live-transmit | recommended for SRT stats | `brew install srt` |
| openmoq-publisher | for MoQ legs | `./scripts/install-openmoq-publisher.sh` |

`./scripts/ensure-publisher-tools.sh` (called from `run-local-publisher.sh`) tries to install the optional pieces.

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

Later: point the agent at `wss://moq.sean-mccarthy.net/api/publisher-agent/ws` with a
user-issued token; the hosted UI will show the same Publisher toggle once the
flag is enabled server-side for that deployment.

## Limits (v1)

- Webcam live bridge still runs on the API host → **local publisher + webcam blocked**.
- Agent and API are expected to share the same repo checkout so `dummy.mp4` and `results/` align.
- One or more agents can connect; jobs go to the least-busy ready agent.
- MediaMTX loopback rewrite (`MEDIAMTX_LOOPBACK_PUBLISH`) stays **off** on agents so publish
  uses the public ingest IP over the internet. The hosted web VM sets it **on** for hairpin.

## Roadmap toward hosted users

1. Issue per-user agent tokens from the hosted API.
2. Enable `LOCAL_PUBLISHER_ENABLED` on the web VM (UI already gates on `/api/features`).
3. Agent default `--api https://moq.sean-mccarthy.net`.
4. Move webcam bridge onto the agent (or WHIP from the browser).
