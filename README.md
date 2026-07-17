# MoQ Test Tools — Upload Benchmark

Benchmark live video ingest across **MoQ (WebTransport)**, **SRT**, **RTMP**, and related paths. The tool encodes a shared media source (file or webcam) with `ffmpeg`, publishes in parallel, collects encode / transport / playback / quality telemetry every second, and writes CSV + JSON summaries.

A React web UI and CLI runner share the same Python core (`src/upload_service.py`).

Live demo: [https://moq.sean-mccarthy.net](https://moq.sean-mccarthy.net) · Source: [github.com/BufferStarved/MoQ-Test-Tools](https://github.com/BufferStarved/MoQ-Test-Tools)

## Features

- **Protocols:** MoQ (openmoq → moqx relay), SRT, RTMP, HTTP PUT, WHIP
- **Side-by-side comparisons** with live charts and a post-run Session details scorecard
- **Encode telemetry:** bitrate, FPS, FPS stability, encode lag, CPU, memory
- **Normalized transport metrics:** RTT, jitter, send rate, loss/retrans
- **Browser playback:** MoQ player (moq-playa) and HLS.js against Zixi egress
- **Media health:** Zixi TR101 continuity and MoQ CMAF sequence/decode-time checks
- **Optional VMAF / PSNR / SSIM** via the ingest agent (encoder and/or ingest legs)
- **Destinations:** managed GCP presets + custom URLs ([infra/](infra/))

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for client / transport / server diagrams and design notes.

```
Browser (React) → moq-web API (FastAPI + UploadService)
                      ├─ SRT: ffmpeg → srt-live-transmit → Zixi → HLS preview
                      └─ MoQ: ffmpeg → openmoq-publisher → moqx → MoQ player
Ingest agent (:8090) — host metrics, recordings, CMAF health, VMAF
```

See [docs/METRICS.md](docs/METRICS.md) for the full metric reference.

## Prerequisites

| Tool | Purpose |
|------|---------|
| Python 3.9+ | Runner, API, metrics collection |
| `ffmpeg-full` | SRT output + libvmaf (Homebrew: `brew install ffmpeg-full`) |
| `srt-live-transmit` | SRT sender statistics (included with `brew install srt`) |
| Node.js 18+ | Web frontend dev server |

Regular Homebrew `ffmpeg` does **not** include SRT support. `scripts/dev.sh` prepends `ffmpeg-full` to `PATH` when installed.

## Setup

```bash
git clone https://github.com/BufferStarved/MoQ-Test-Tools.git && cd moq-test-tools

python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Test media (browser-safe yuv420p — benchmarks also transcode uploads automatically)
# ffmpeg -f lavfi -i testsrc=duration=60:size=1280x720:rate=30 \
#   -f lavfi -i sine=frequency=1000:duration=60 \
#   -c:v libx264 -pix_fmt yuv420p -profile:v main -level:v 4.0 -c:a aac dummy.mp4
```

Install frontend dependencies once:

```bash
npm install --prefix web/frontend
```

## Running

### Web UI (recommended)

```bash
./scripts/dev.sh
```

- API: http://127.0.0.1:8000
- Frontend: http://127.0.0.1:5173

Use the **Benchmark** tab to configure streams and start a comparison. Live charts update during the run; when it finishes, open **Session Details** for the scorecard and CSV/JSON downloads. **About** covers architecture and contact info.

### CLI

```bash
source venv/bin/activate
export PATH="/opt/homebrew/opt/ffmpeg-full/bin:/opt/homebrew/bin:$PATH"
export PYTHONPATH="src:web/api"

# List presets and URL syntax
python src/runner.py --list-presets

# SRT benchmark (30 seconds)
python src/runner.py \
  --media dummy.mp4 \
  --duration 30 \
  --protocol srt \
  --endpoint-url "srt://<host>:10080?mode=caller&latency=200000"
```

### Test connectivity first

Before benchmarking a Zixi host:

```bash
./infra/zixi/scripts/test-endpoint.sh 'srt://<host>:10080?mode=caller&latency=200000'
```

## Results

Each run writes two files to `results/`:

| File | Contents |
|------|----------|
| `upload_YYYYMMDD-HHMMSS.csv` | Per-second samples (all metrics) |
| `upload_YYYYMMDD-HHMMSS.summary.json` | Aggregated averages + throughput + quality |

Download from the web UI after a run, or aggregate the latest run from the CLI:

```bash
python src/publisher.py
```

## Optional configuration

### Zixi receiver-side stats (CC errors, receiver jitter)

```bash
export ZIXI_API_BASE=http://<zixi-host>:4444
export ZIXI_API_USER=admin
export ZIXI_API_PASSWORD=<password>
export ZIXI_INPUT_ID=<input-id>   # optional
```

Enable **TR101 Analysis** on the Zixi input for continuity-counter error reporting.

### VMAF on ingest server (recommended)

VMAF runs on the **upload destination** (GCP/Zixi VM), not on the machine pushing the stream. The hosted web app talks to an **ingest HTTP agent** on the VM — no SSH required.

**1. On the ingest VM**, install ffmpeg with libvmaf, the ingest agent, and enable Zixi input recording:

```bash
sudo bash infra/zixi/scripts/install-ingest-vmaf.sh
sudo bash infra/zixi/scripts/install-ingest-agent.sh
# Zixi UI → Inputs → enable Record to disk
```

**2. Configure the hosted app once** (not per user):

```bash
./scripts/sync-ingest-agent-env.sh
# or manually set INGEST_AGENT_TOKEN in .env
```

**3. In the web UI**, select a managed Zixi or MoQ ingest endpoint, check **Compute VMAF**, and run the benchmark. No tokens or SSH required.

### VMAF locally (legacy)

For local comparison when you already have a received recording file:

```bash
export MOQ_COMPUTE_VMAF=1
export MOQ_VMAF_DISTORTED=/path/to/recording.ts
```

## Project layout

```
moq-test-tools/
├── src/
│   ├── runner.py           # CLI entry point
│   ├── upload_service.py   # ffmpeg orchestration + SRT/MoQ pipelines
│   ├── metrics.py          # CSV + summary JSON writer
│   ├── srt_stats.py        # libsrt CSV parser
│   ├── zixi_stats.py       # Optional Zixi API poller
│   ├── vmaf_score.py       # Optional post-run VMAF
│   ├── destinations.py     # Presets and URL validation
│   └── publisher.py        # CLI result aggregator
├── web/
│   ├── api/                # FastAPI backend
│   └── frontend/           # React UI
├── infra/
│   ├── web/                # Hosted UI VM runbooks
│   ├── moqx/               # MoQ relay Terraform + runbooks
│   └── zixi/               # Zixi ingest Terraform + runbooks
├── ingest_agent/           # Recording, media health, VMAF sidecar
├── scripts/dev.sh          # Start API + frontend
├── results/                # Benchmark output (gitignored)
└── docs/
    ├── ARCHITECTURE.md     # System design
    └── METRICS.md          # Metric definitions and sources
```

## Deployment

- Web UI: [infra/web/](infra/web/)
- MoQ relay: [infra/moqx/GCP-MOQX-RUNBOOK.md](infra/moqx/GCP-MOQX-RUNBOOK.md)
- Zixi ingest: [infra/zixi/README.md](infra/zixi/README.md)

## Feedback

Open issues on GitHub, email [me@sean-mccarthy.net](mailto:me@sean-mccarthy.net), or ping **Sean McCarthy** on [video-dev](https://video-dev.org/) Slack.
