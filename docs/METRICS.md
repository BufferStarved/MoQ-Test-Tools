# Metrics Reference

This document describes every metric collected during an upload benchmark, where it comes from, and how to interpret it.

## Collection overview

- **Sample interval:** 1 second
- **Output:** `results/upload_<timestamp>.csv` (per-second rows) + `results/upload_<timestamp>.summary.json` (aggregates)
- **Encode stats:** `ffmpeg -progress` (bitrate, FPS, speed, out_time)
- **Process stats:** `psutil` (CPU %, RSS memory for ffmpeg + srt-live-transmit)
- **SRT stats:** `srt-live-transmit -statsout` CSV (libsrt counters)
- **Receiver stats (optional):** Zixi Broadcaster REST API
- **VMAF (optional):** `ffmpeg -lavfi libvmaf` post-run

## SRT pipeline

SRT benchmarks do not push directly from ffmpeg. Instead:

```
ffmpeg -re -i <media> -c:v copy -c:a copy -f mpegts udp://127.0.0.1:<port>
    ↓
srt-live-transmit udp://:@127.0.0.1:<port> <srt-url> -statsout <csv> -statspf:csv -s:50
```

This is required because ffmpeg's SRT muxer does not expose libsrt statistics in this build, while `srt-live-transmit` writes full sender/receiver counters to CSV.

If `srt-live-transmit` is not found in `PATH`, SRT runs fall back to direct ffmpeg output **without** network metrics.

---

## CSV columns

| Column | Type | Source | Description |
|--------|------|--------|-------------|
| `timestamp` | float | system clock | Unix epoch seconds when the sample was recorded |
| `protocol` | string | job config | `srt`, `rtmp`, `http`, or `webrtc` |
| `endpoint` | string | job config | Full destination URL |
| `pid` | int | ffmpeg | Primary process ID (ffmpeg) |
| `cpu_percent` | float | psutil | Combined CPU % for ffmpeg + srt-live-transmit (SRT only) |
| `memory_mb` | float | psutil | Combined RSS memory in MB |
| `encoded_bitrate_kbps` | float | ffmpeg | Encoder output bitrate from `-progress`. Measures encode load before the network path — not delivered network throughput. |
| `encoder_send_rate_mbps` | float | ffmpeg / libsrt | Outbound rate in Mbps. Defaults to `encoded_bitrate_kbps / 1000` when no transport-level send measurement exists; `srt-live-transmit` supplies a measured value when enabled. |
| `transport_recv_rate_mbps` | float | libsrt | Measured receive bandwidth from `srt-live-transmit` when stats are enabled. |
| `fps` | float | ffmpeg | Output frame rate |
| `fps_stability` | float | computed | Coefficient of variation (stddev/mean) of FPS over a rolling 30-sample window. Lower = more stable. `0` until enough samples exist. |
| `speed` | float | ffmpeg | Encode/upload speed relative to realtime (`1.0` = realtime) |
| `out_time` | string | ffmpeg | Media timestamp reached (`HH:MM:SS.microseconds`) |
| `transport_rtt_ms` | float | libsrt / Zixi | Round-trip time in milliseconds for the active transport instrument. SRT sender: `msRTT`. Overridden by Zixi receiver RTT when API poller is enabled. |
| `transport_rtt_jitter_ms` | float | computed / Zixi | Variation in transport RTT between samples. SRT: mean absolute delta between consecutive RTT samples. Zixi: receiver jitter when API poller is enabled. |
| `pkt_rcv_drop` | int | libsrt / Zixi | Packets dropped on the **receive** side (`pktRcvDrop`). On the sender this is typically `0`; use Zixi input stats for receiver-side drops. |
| `pkt_snd_drop` | int | libsrt | Packets dropped on the **send** side (`pktSndDrop`) |
| `pkt_snd_loss` | int | libsrt | Sender packet loss (`pktSndLoss`) |
| `pkt_retrans` | int | libsrt | Retransmitted packets (`pktRetrans`) |
| `pkt_fec_extra` | int | libsrt | FEC recovery packets sent (`pktSndFilterExtra`) |
| `ts_continuity_counter_errors` | int | Zixi API | MPEG-TS continuity-counter errors from Zixi TR101 analysis. Meaningful for TS-muxed SRT/RTMP only. Requires Zixi API credentials and TR101 analysis enabled on the input. `0` when not configured. |
| `vmaf_score` | float | libvmaf | Perceptual quality score (0–100). Only populated post-run when `MOQ_VMAF_DISTORTED` is set. Empty during live collection. |

---

## Summary JSON

The `.summary.json` file written alongside each CSV contains:

```json
{
  "csv_path": "results/upload_....csv",
  "protocol": "srt",
  "endpoint": "srt://...",
  "samples": 30,
  "averages": { ... },
  "srt": {
    "avg_rtt_ms": 49.7,
    "max_rtt_ms": 63.8,
    "avg_jitter_ms": 1.0,
    "max_jitter_ms": 1.8,
    "total_pkt_rcv_drop": 0,
    "total_pkt_snd_drop": 0,
    "total_pkt_retrans": 0,
    "total_pkt_fec_extra": 0,
    "samples": 30
  },
  "extra": {
    "vmaf_available": false,
    "zixi_poller_enabled": false,
    "vmaf_note": ""
  }
}
```

**Averages** are arithmetic means for numeric columns. Counter columns (`pkt_rcv_drop`, `pkt_retrans`, etc.) use the **last sample value** (cumulative counters).

---

## Optional: Zixi receiver metrics

Set these environment variables before starting a benchmark (API or CLI):

```bash
export ZIXI_API_BASE=http://<zixi-host>:4444
export ZIXI_API_USER=admin
export ZIXI_API_PASSWORD=<password>
export ZIXI_INPUT_ID=<input-id>    # optional, targets a specific input
```

The poller calls Zixi Broadcaster's UI-backed JSON endpoints (HTTP Basic auth on port `4444`):

- `input_stream_stats.json?func=fill_inputs_stats&id=<stream_id>` — RTT, jitter, packet loss, RTP drops
- `input_stream_stats.json?func=fill_ts_anaysis_data&id=<stream_id>` — TR101 analysis (note Zixi's `anaysis` spelling)

Responses are JSONP callbacks (e.g. `fill_inputs_stats({...})`). The poller maps:

| Zixi field | CSV column |
|------------|------------|
| `net.rtt` | `transport_rtt_ms` |
| `net.jitter` | `transport_rtt_jitter_ms` |
| `net.loss_millipercent / 1000` | (internal `packet_loss_pct`) |
| `tr101[].Continuity_count_error` | `ts_continuity_counter_errors` |
| `failover.rtp_drops` or `net.dropped` | (internal `rtp_drops`) |

The older guessed paths (`/api/v1/inputs/statistics`) are **not** valid on standard Zixi Broadcaster installs.

**CC errors** require TR101 analysis on the Zixi input:

1. Zixi UI → Inputs → select input → enable **Analyze** / TR101
2. Run benchmark with API credentials set

Receiver-side **pktRcvDrop** and **jitter** from Zixi are more accurate than sender-side libsrt counters for measuring what the ingest point experienced.

---

## Optional: VMAF on ingest server

VMAF should run on the **ingest host** (where the stream is received), not on the ffmpeg sender. When enabled in the benchmark form:

1. **Browser upload:** reference media is uploaded to the hosted API (`POST /api/media/upload`)
2. **Before stream:** the API uploads the reference to the ingest HTTP agent (`POST /api/v1/jobs/{id}/reference`)
3. **During upload:** Zixi records the received stream to disk
4. **After upload:** the API asks the agent to compute VMAF (`POST /api/v1/jobs/{id}/vmaf`)
5. **Score** is written to `*.summary.json` and shown in the Results tab

### Ingest host setup

```bash
# On the GCP/Zixi VM (after syncing this repo)
sudo bash infra/zixi/scripts/install-ingest-vmaf.sh
sudo bash infra/zixi/scripts/install-ingest-agent.sh

# Zixi UI → Inputs → enable Record to disk
# Open TCP 8090 in your ingest firewall for the hosted app
```

### Hosted app configuration

```bash
export INGEST_AGENT_TOKEN=<shared-secret-from-/etc/moq-ingest-agent.env>
export INGEST_RECORDING_DIR=/opt/zixi_broadcaster-linux64
```

Web UI: upload a reference file, enable **Compute VMAF via ingest HTTP agent**, enter the agent token (or rely on server env), and optionally override the recording directory. Use **Check ingest agent** to verify connectivity before running.

### Legacy: local VMAF

If `MOQ_VMAF_DISTORTED` is set and ingest VMAF is disabled, VMAF still runs locally via `ffmpeg libvmaf` for backward compatibility.

---

## Interpreting key metrics

### Transport RTT and jitter

- **transport_rtt_ms** is the SRT control-channel round trip (or Zixi receiver RTT when the API poller is active). Spikes often correlate with congestion or route changes.
- **transport_rtt_jitter_ms** (computed as mean |ΔRTT| for SRT) measures RTT stability. Zixi receiver jitter is an alternative when the API poller is active.

### Packet loss and retransmits

- **pkt_snd_loss** / **pkt_snd_drop**: problems on the upload path from the sender's perspective.
- **pkt_rcv_drop**: drops at the receiver. On a sender-only libsrt connection this stays at 0 — check Zixi input stats for real receiver drops.
- **pkt_retrans**: SRT ARQ retransmissions. Sustained non-zero values indicate lossy links.

### FEC

- **pkt_fec_extra** (`pktSndFilterExtra`): forward error correction packets sent. Only non-zero when SRT FEC is configured on the socket.

### FPS stability

Coefficient of variation of FPS over the last 30 samples:

| Value | Interpretation |
|-------|----------------|
| < 0.05 | Very stable frame pacing |
| 0.05 – 0.15 | Normal for `-re` realtime streaming |
| > 0.20 | Irregular frame delivery; check CPU or source file frame timing |

### TS continuity counter errors

MPEG-TS continuity counter errors (`ts_continuity_counter_errors`) detected by Zixi TR101 analysis. Non-zero values indicate transport stream corruption — often from packet loss or jitter buffer underruns.

---

## Metrics by protocol

| Metric | SRT | RTMP | HTTP | WHIP |
|--------|-----|------|------|------|
| encoded_bitrate_kbps, fps, speed, cpu, memory | ✓ | ✓ | ✓ | ✓ |
| fps_stability | ✓ | ✓ | ✓ | ✓ |
| transport_rtt_ms, transport_rtt_jitter_ms, loss, retrans, FEC | ✓ | — | — | — |
| ts_continuity_counter_errors (Zixi) | ✓* | ✓* | — | — |
| vmaf (post-run) | ✓* | ✓* | ✓* | ✓* |

\* Requires optional configuration (Zixi API, recording + libvmaf).

---

## Future metrics

Planned additions:

- **Bandwidth estimate** (`mbpsBandwidth` from libsrt)
- **Buffer occupancy** (`msSndBuf`, `msRcvBuf`)
- **Time-to-first-frame** (connection setup latency)
- **WebRTC inbound stats** (browser player: packets lost, jitter, frames decoded)
