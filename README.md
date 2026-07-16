# MoQ Test Tools — Upload Benchmark

Benchmark live video upload performance across **SRT**, **RTMP**, **HTTP** (presigned PUT), and **WebRTC** (WHIP) endpoints. The tool streams a local media file with `ffmpeg`, collects encode and network telemetry every second, and writes results to CSV + JSON summary files.

A React web UI and CLI runner share the same Python core (`src/upload_service.py`).

## Features

- **Protocols:** SRT, RTMP, HTTP PUT, WHIP (MoQ planned)
- **Encode telemetry:** bitrate, FPS, FPS stability, CPU, memory
- **SRT network metrics:** RTT, jitter, packet loss, retransmits, FEC (via `srt-live-transmit` + libsrt)
- **Optional receiver metrics:** Zixi Broadcaster API (CC/TR101 errors, receiver-side jitter)
- **Optional VMAF:** post-run quality score when a recorded output file is provided
- **Destinations:** preset catalog + custom URLs; Zixi VMs on AWS/GCP/Linode ([infra/zixi](infra/zixi/README.md))

## Architecture

```
┌─────────────┐     ┌──────────────────────────────────────────┐
│ Web UI / CLI│────▶│ FastAPI (web/api)  →  UploadService      │
└─────────────┘     └──────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │ SRT pipeline                  │ Other protocols
                    ▼                               ▼
         ffmpeg → UDP localhost          ffmpeg → endpoint directly
              → srt-live-transmit → SRT
                    │
                    ▼
              MetricsCollector → results/*.csv + *.summary.json
```

For SRT, `ffmpeg` muxes MPEG-TS to a local UDP port; `srt-live-transmit` forwards to the remote endpoint and writes libsrt statistics to a CSV file that the collector polls each second. Non-SRT protocols push directly from `ffmpeg`.

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
git clone <repo-url> && cd moq-test-tools

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

Use the **Benchmark** tab to pick a preset or enter a custom endpoint URL. Live metrics stream during the run; completed CSVs appear under **Results**.

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
| `upload_YYYYMMDD-HHMMSS.summary.json` | Aggregated averages + SRT summary |

View summaries from the web UI **Results** tab, or aggregate the latest run from the CLI:

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

**3. In the web UI**, select **MoQ Zixi GCP ingest**, check **Compute VMAF after upload**, and run the benchmark. No tokens or SSH required.

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
│   ├── upload_service.py   # ffmpeg orchestration + SRT pipeline
│   ├── metrics.py          # CSV + summary JSON writer
│   ├── srt_stats.py        # libsrt CSV parser
│   ├── zixi_stats.py       # Optional Zixi API poller
│   ├── vmaf_score.py       # Optional post-run VMAF
│   ├── destinations.py     # Presets and URL validation
│   └── publisher.py        # CLI result aggregator
├── web/
│   ├── api/                # FastAPI backend
│   └── frontend/           # React UI
├── infra/zixi/             # Zixi VM Terraform + runbooks
├── scripts/dev.sh          # Start API + frontend
├── results/                # Benchmark output (gitignored)
└── docs/METRICS.md         # Metric definitions and sources
```

## Zixi deployment

See [infra/zixi/README.md](infra/zixi/README.md) and [infra/zixi/GCP-ZIXI-RUNBOOK.md](infra/zixi/GCP-ZIXI-RUNBOOK.md) for provisioning ingest VMs on AWS, GCP, and Linode.

## Roadmap

- MoQ relay integration
- Browser-based player metrics (WebRTC stats)
- Cloud runner abstraction (encode locally vs on GCP/AWS worker)
- One-click Zixi recording + VMAF in the web UI
