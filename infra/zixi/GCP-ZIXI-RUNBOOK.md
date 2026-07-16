# GCP Zixi Deployment Runbook

End-to-end: provision a GCP VM, install Zixi Broadcaster, configure SRT ingest, run a benchmark with full metrics.

## Prerequisites

- GCP project with billing enabled
- ADC configured: `gcloud auth application-default login`
- gcloud CLI login: `gcloud auth login`
- Project set: `gcloud config set project YOUR_PROJECT_ID`
- Zixi Linux installer downloaded from [portal.zixi.com](https://portal.zixi.com)
- Local tools: `ffmpeg-full`, `srt` (`brew install ffmpeg-full srt`)

## Step 1 — Provision the VM

```bash
chmod +x infra/zixi/scripts/*.sh
./infra/zixi/scripts/gcp-deploy-vm.sh
```

This creates:
- Ubuntu 22.04 VM (`e2-standard-4`: 4 vCPU, 16 GB RAM)
- Static public IP
- Firewall rules for SSH, Zixi UI (4444), RTMP, SRT/UDP ingest

Note the `public_ip` from terraform output.

## Step 2 — Download Zixi installer (local machine)

1. Go to [https://portal.zixi.com](https://portal.zixi.com)
2. **Software** → **Zixi Broadcaster** → select version → **Linux** download
3. Save the `.tar.gz` locally (e.g. `~/Downloads/ZixiBroadcaster-linux.tar.gz`)

## Step 3 — Install Zixi on the VM

```bash
./infra/zixi/scripts/gcp-install-zixi.sh ~/Downloads/ZixiBroadcaster-linux.tar.gz
```

This uploads the installer, runs it on the VM, and opens local firewall ports.

If the installer layout differs from expected, SSH in manually:

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@$(cd infra/zixi/terraform/gcp && terraform output -raw public_ip)
# then follow Zixi's extracted install.sh instructions
```

## Step 4 — Activate license and configure ingest inputs

1. Open **http://\<public-ip\>:4444**
2. Log in / activate license (VM needs outbound HTTPS to `license.zixi.com`)

### SRT push input

3. Add an **SRT push input**:
   - Type: SRT (listener / push)
   - Stream ID: `SRT Test` (or any unique name)
   - Listening port: `10080` (recommended — port `2088` is reserved by Zixi's native protocol)
   - Latency: `200` ms (matches `latency=200000` µs in the benchmark URL)
   - Optional: password and stream ID verification
4. Confirm the input shows **ONLINE** (not "failed to bind")
5. Open GCP firewall for the chosen SRT port (UDP + TCP) if not already allowed
6. Enable **Record to disk** on the SRT input for VMAF

### RTMP push input

Configure via script (on the VM or from your laptop):

```bash
chmod +x infra/zixi/scripts/configure-zixi-rtmp-input.sh
ZIXI_HOST=<public-ip> ZIXI_PASSWORD=<admin-password> \
  ./infra/zixi/scripts/configure-zixi-rtmp-input.sh
```

Or manually in the Zixi UI:

1. **Settings → Live Protocols** → enable **RTMP Server** on port `1935`
2. **Inputs → New Input → RTMP → Push**
3. Stream ID: `benchmark` (ffmpeg URL uses app `live`: `rtmp://<host>:1935/live/benchmark`)
4. Enable **Record to disk** for VMAF
5. Confirm the input shows **Connected** when pushing

Benchmark URL:

```
rtmp://<public-ip>:1935/live/benchmark
```

Preset: `moq_zixi_gcp_rtmp`

### HLS / DASH origin output (HTTP TS push ingest)

Zixi does **not** accept raw HLS/DASH manifest uploads on port 7777. That port is an **origin server** that serves HLS/DASH **output** from ingested streams. Ingest uses **MPEG-TS over HTTP push**:

```
http://<public-ip>:7777/benchmark
```

After ingest, Zixi serves **live** HLS at:

| Format | Playback URL |
|--------|----------------|
| HLS | `http://<public-ip>:7777/playback.m3u8?stream=benchmark` |
| DASH | `http://<public-ip>:7777/benchmark.mpd` (may require adaptive group) |

**Not** `/<stream-id>.m3u8` — that path is for adaptive groups, not per-input streams.

Configure via script (applies settings, **restarts Zixi**, verifies HLS):

```bash
chmod +x infra/zixi/scripts/configure-zixi-hls-dash-output.sh
ZIXI_HOST=<public-ip> ZIXI_PASSWORD=<admin-password> \
  ./infra/zixi/scripts/configure-zixi-hls-dash-output.sh
```

Or manually in the Zixi UI (**Settings → Live Protocols**):

1. Enable **HTTP Server** on port `7777`
2. Enable **HLS** and **CMAF (DASH + fMP4 HLS)**
3. Set **Segment duration** to `6` seconds
4. Enable **Allow Automatic HTTP Push input**
5. Add **HTTP TS Push** input with Stream ID `benchmark` (or rely on automatic)
6. Enable **Record to disk** for VMAF

Verify end-to-end:

```bash
./infra/zixi/scripts/test-hls-dash-output.sh
./infra/zixi/scripts/test-endpoint.sh 'http://<public-ip>:7777/benchmark'
```

Presets: `moq_zixi_gcp_hls` / `moq_zixi_gcp_dash` (both push to the same ingest URL; Zixi output format differs)

## Step 5 — Verify and benchmark

```bash
./infra/zixi/scripts/verify-zixi-host.sh <public-ip>
./infra/zixi/scripts/test-endpoint.sh 'srt://<public-ip>:10080?mode=caller&latency=200000'
./infra/zixi/scripts/test-endpoint.sh 'rtmp://<public-ip>:1935/live/benchmark'
./infra/zixi/scripts/test-endpoint.sh 'http://<public-ip>:7777/benchmark'
./infra/zixi/scripts/test-hls-dash-output.sh
```

### Web UI

```bash
./scripts/dev.sh
# Open http://127.0.0.1:5173 → Benchmark tab → Custom SRT URL
```

### CLI

```bash
source venv/bin/activate
export PATH="/opt/homebrew/opt/ffmpeg-full/bin:/opt/homebrew/bin:$PATH"
export PYTHONPATH="src:web/api"

python src/runner.py \
  --media dummy.mp4 \
  --duration 30 \
  --protocol srt \
  --endpoint-url "srt://<public-ip>:10080?mode=caller&latency=200000&streamid=SRT%20Test"
```

Results land in `results/` as CSV + JSON summary. Metric definitions: [docs/METRICS.md](../../docs/METRICS.md).

### Optional: VMAF on ingest server

```bash
# On the GCP VM once
sudo bash infra/zixi/scripts/install-ingest-vmaf.sh
sudo bash infra/zixi/scripts/install-ingest-agent.sh
```

Enable **Record to disk** on the Zixi input. Open TCP **8090** in the ingest firewall (`ingest_agent_port` in Terraform).

Hosted app env:

```bash
export INGEST_AGENT_TOKEN=$(sudo grep INGEST_AGENT_TOKEN /etc/moq-ingest-agent.env | cut -d= -f2)
export INGEST_RECORDING_DIR=/opt/zixi_broadcaster-linux64
```

In the web UI: upload a reference file, check **Compute VMAF via ingest HTTP agent**, and use **Check ingest agent** before running.

### MoQ relay ingest VMAF (worker subscribes remotely)

For **GCP MoQ Relay** uploads, the same worker runs Docker-backed `openmoq-fmp4-record`, which
subscribes to the public moqx URL and records post-relay fMP4:

```bash
cd ~/moq-test-tools   # or /opt/moq-test-tools
sudo bash infra/zixi/scripts/install-openmoq-recorder.sh
sudo systemctl restart moq-ingest-agent.service
curl -s http://127.0.0.1:8090/api/v1/health | python3 -m json.tool
# expect moq_recorder_available: true, moq_recorder_runtime_ok: true
```

MoQ relay recordings land in `/var/lib/moq-relay-recordings/<job_id>.mp4` on this worker.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `gcloud auth` errors | Re-run `gcloud auth login` and `gcloud auth application-default login` |
| SSH timeout | Your IP may have changed — update `allowed_ssh_cidr` in `terraform/gcp/terraform.tfvars` and `terraform apply` |
| License activation fails | Check VM outbound internet; confirm ports 80/443 open egress |
| SRT push rejected | Input must be **ONLINE**; use port `10080` not `2088`; open UDP/TCP in GCP firewall + VM `ufw` |
| RTMP push I/O error | Enable RTMP server; add push input with Stream ID `benchmark`; run `configure-zixi-rtmp-input.sh` |
| HLS/DASH 404 on :7777 | Run `configure-zixi-hls-dash-output.sh` (restarts Zixi). Use `playback.m3u8?stream=benchmark`, not `benchmark.m3u8` |
| HTTP TS push broken pipe | Enable automatic HTTP push or add HTTP_PUSH input with Stream ID `benchmark` |
| ffmpeg "Protocol not found" | Install `ffmpeg-full`: `brew install ffmpeg-full` |
| No RTT/jitter in results | Install `srt`: `brew install srt` (provides `srt-live-transmit`) |
| Installer script not found | SSH in and run Zixi's install script manually from extracted tarball |

## Tear down

```bash
cd infra/zixi/terraform/gcp
terraform destroy
```
