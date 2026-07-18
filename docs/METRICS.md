# Metrics Reference

This document describes the normalized metrics model used for cross-protocol comparison, where each field comes from, and how to interpret it.

## Collection overview

- **Sample interval:** 1 second
- **Output:** `results/upload_<timestamp>.csv` + `results/upload_<timestamp>.summary.json`
- **Encode stats:** `ffmpeg -progress` (bitrate, FPS, speed, out_time, encode lag)
- **Process / client host:** `psutil`
- **Normalized transport (`net_*`):** filled from SRT (libsrt), RTMP (Zixi receiver RTT when available, else TCP path probe to the RTMP host:port), MoQ (picoquic qlog or TCP path probe + moqx QUIC counters), or bitrate proxies
- **Server host:** ingest-agent psutil and/or **GCP Cloud Monitoring**
- **Edge (Zixi):** Zixi Broadcaster REST (TR 101 290, RTT, …)
- **Edge (MoQ relay):** moqx Prometheus counters (charts show **job-window deltas**)
- **Browser playback:** player stats + estimated end-to-end latency
- **Video Quality:** VMAF / PSNR / SSIM (optional, post-run)

## Pipeline stages (chart groups)

| Stage | Chart group | What it measures |
|-------|-------------|------------------|
| Metadata | (summary only) | Protocol, endpoint, sample count |
| Client | `client` | Publisher host (ffmpeg / openmoq-publisher) |
| Encode | `encode` | Encoder output before the network path: bitrate, frame rate, send rate, client memory/jitter, encode lag, **encoder-side** VMAF / PSNR / SSIM |
| Ingest | `ingest` | Normalized path health (`net_rtt_ms`, `net_jitter_ms`, merged `net_retrans_pct`, `net_loss_pct`) + ingest-host CPU/memory/disk, protocol-native recovery (moqx relay Δ, Zixi/libsrt, **receive loss** `quic_packets_lost`, **send loss** `pkt_snd_loss`), and **ingest-side** VMAF / PSNR / SSIM |
| Media Health | `media_health` | Container/timeline integrity (not transport) |
| Browser playback | `playback` | TTFF, stalls, **rebuffer time**, buffer size, **E2E latency estimate** |

Encode and Ingest each chart **stage-specific** VMAF/PSNR/SSIM (`vmaf_score_encoder`/`psnr_db_encoder`/`ssim_encoder`
vs. `vmaf_score_ingest`/`psnr_db_ingest`/`ssim_ingest`) rather than one combined score, so a quality
drop introduced by the network/ingest path is visible separately from encode-time loss. The combined
`vmaf_score`/`psnr_db`/`ssim` fields still exist in the CSV/summary (picking whichever stage ran) for
backward compatibility.

`net_retrans_pct` is a **merged, cross-protocol** retransmit metric — it carries SRT's ARQ retransmit
rate and MoQ's `moqx_quicPacketRetransmissions_total` job-window rate on one series, so the Ingest tab
needs only one retransmit chart instead of a protocol-specific one. The raw `pkt_retrans` (SRT-only)
counter still exists in the CSV but is no longer charted on its own.

When a metric cannot be produced for the active protocol, the UI shows:

> **Not available with protocol X**

(for example Zixi TR101 on a MoQ leg).

---

## Answers to common design questions

### 1. Can we compute TR 101 290 via open source for non-Zixi MSF / segmented MPEG?

**Yes for MPEG-TS**, with tools such as [TSDuck](https://tsduck.io/) (`tsanalyze` / continuity-counter checks) on a TS ingest or recording. That path fits SRT/RTMP/HLS-TS style muxes.

**MoQ fMP4/CMAF** uses a separate **Media Health** metric family (not TR101 field names):
`cmaf_seq_gap_count`, `cmaf_tfdt_gap_count`, `cmaf_tfdt_gap_ms`, `cmaf_parse_errors`.
These live in the same UI group as Zixi’s `ts_continuity_counter_errors` so protocols compare under one “Media Health” label.

Today MPEG-TS Media Health still comes from **Zixi TR101**. An OSS TSDuck leg remains a natural follow-up for non-Zixi TS ingest.

### 2. Do these metrics account for RTMP, HTTP, and WebRTC?

| Stage | RTMP / HLS / DASH / HTTP | WebRTC (WHIP) | Notes |
|-------|--------------------------|---------------|-------|
| Client + encode | Yes | Yes (when publish path runs) | ffmpeg progress + psutil |
| `net_*` transport | Sparse | Sparse | Usually send-rate proxy only; no libsrt RTT |
| Server | Yes when agent/GCP configured | Same | |
| Edge Zixi | RTMP via Zixi only | No | TR101 when Zixi Analyze is on |
| Edge MoQ | No | No | MoQ only |
| Playback | HLS player path | WHEP / future | Depends on browser player wiring |
| Video Quality | Yes when VMAF enabled | Yes when enabled | |

Unsupported cells show **Not available with protocol X** rather than fake zeros.

### 3. Encode quality vs. ingest quality

VMAF / PSNR / SSIM are no longer a standalone “Video Quality” tab — they're split across the two
pipeline stages that can each introduce quality loss: **Encode** charts the encoder-side score
(`vmaf_score_encoder`/etc., against the encoder's own capture) and **Ingest** charts the ingest-side
score (`vmaf_score_ingest`/etc., against the post-network recording). Comparing the two isolates
network/transport quality loss from encode-time loss.

### 4. End-to-end latency across protocols

**TTFF is not glass-to-glass.** Time-to-first-frame measures join delay after the player starts, not how far the picture lags the live encode.

We added **`e2e_latency_ms`** (estimated):

```
e2e_latency_ms ≈ (wall_clock_now − encode_started_at) − playback_video_time_sec × 1000
```

Assumptions: encode starts near wall clock T0; player `currentTime` tracks media timeline from that encode; browser and publisher clocks are roughly NTP-aligned. Values outside 0–120s are dropped as invalid.

**How to compare protocols:** run legs in parallel (or back-to-back with the same media), keep playback open during the encode, and compare the **`e2e_latency_ms`** series (and summary average) under **Browser playback**. Pair with TTFF, stall count, and **`playback_buffer_sec`** (seconds buffered ahead of the playhead) for a fuller viewer story.

A future upgrade is SEI / wall-clock timestamps in the bitstream for true glass-to-glass without clock skew.

---

## Normalized transport (`net_*`)

| Column | Typical source |
|--------|----------------|
| `net_rtt_ms` | **SRT:** libsrt, then Zixi or MediaMTX `srt_conns_ms_rtt`. **RTMP:** Zixi/MediaMTX when available, else TCP connect probe. **MoQ:** picoquic qlog / TCP path probe |
| `net_jitter_ms` | libsrt jitter, Zixi jitter, or EMA of successive MediaMTX RTT deltas |
| `net_send_mbps` | libsrt send rate or `encoded_bitrate_kbps / 1000` (MediaMTX: falls back to path ingest rate) |
| `net_recv_mbps` | libsrt receive rate, or MediaMTX `srt_conns_mbps_receive_rate` / path byte deltas |
| `net_loss_pct` / `net_retrans_pct` | **SRT:** libsrt or MediaMTX SRT loss/retrans. **MoQ:** moqx QUIC counters |

Legacy columns (`transport_rtt_ms`, `encoder_send_rate_mbps`, …) remain for compatibility.

### Encode lag

`encode_lag_ms` = wall elapsed since run start − ffmpeg `out_time`. Large values mean the encoder is falling behind realtime (`-re` / live webcam).

---

## Server host metrics (ingest agent + GCP)

1. **Ingest agent** (`/host_metrics`) — preferred for Zixi / shared worker.
2. **GCP Cloud Monitoring** — preferred for **MoQ relay** (`gcp_moq_relay`), and fallback elsewhere.

Environment on the collector / web VM:

```bash
export GCP_METRICS_ENABLED=1
export GCP_METRICS_PROJECT=<gcp-project-id>
export GCP_METRICS_ZONE=us-central1-a
export GCP_INSTANCE_ZIXI=moq-zixi-gcp
export GCP_INSTANCE_MOQX=moq-relay-gcp
```

The web VM service account needs **Monitoring Metric Viewer**. CPU uses `compute.googleapis.com/instance/cpu/utilization`; memory/disk use Ops Agent metrics when installed.

---

## SRT pipeline

```
ffmpeg -re -i <media> … -f mpegts udp://127.0.0.1:<port>
    ↓
srt-live-transmit udp://:@127.0.0.1:<port> <srt-url> -statsout <csv>
```

If `srt-live-transmit` is missing, SRT falls back to direct ffmpeg **without** libsrt network metrics.

---

## Optional: Zixi receiver metrics

```bash
export ZIXI_API_BASE=http://<zixi-host>:4444
export ZIXI_API_USER=admin
export ZIXI_API_PASSWORD=<password>
export ZIXI_INPUT_ID=<input-id>    # optional
```

| Zixi field | CSV column |
|------------|------------|
| `net.rtt` | `transport_rtt_ms` / `net_rtt_ms` |
| `net.jitter` | `transport_rtt_jitter_ms` / `net_jitter_ms` |
| `tr101[].Continuity_count_error` | `ts_continuity_counter_errors` |

Enable **Analyze / TR101** on the Zixi input for continuity errors.

---

## Optional: MediaMTX receiver metrics

Used when `ingest_provider=gcp_mediamtx` (encode co-located on `moq-web`).

```bash
# Defaults (loopback on the MediaMTX host):
export MEDIAMTX_METRICS_URL=http://127.0.0.1:9998/metrics
export MEDIAMTX_API_URL=http://127.0.0.1:9997
export MEDIAMTX_PATH=benchmark
```

| MediaMTX metric | CSV column |
|-----------------|------------|
| `srt_conns_ms_rtt` | `net_rtt_ms` / `transport_rtt_ms` |
| successive RTT deltas (EMA) | `net_jitter_ms` |
| `srt_conns_mbps_*` or `paths_*` / `srt_conns_bytes_*` Δ | `net_recv_mbps` (ingest) |
| `srt_conns_packets_received_loss` / `*_loss_rate` | `net_loss_pct` |
| `srt_conns_packets_retrans` (+ received_retrans) | `pkt_retrans` / `net_retrans_pct` |
| `srt_conns_packets_received_drop` / `send_drop` | `pkt_rcv_drop` / `pkt_snd_drop` |
| `srt_conns_packets_send_loss` | `pkt_snd_loss` |
| `paths_inbound_frames_in_error` | `ts_continuity_counter_errors` (best-effort; not TR101) |
| RTMP/WHIP: path or session byte Δ | `net_recv_mbps` (no SRT RTT) |

Publisher-side libsrt (when using `srt-live-transmit`) still wins when both are present; MediaMTX fills gaps and supplies true **receiver** ingest rate.

---

## Media Health (not transport)

Shared UI group for **container/timeline integrity**. Protocols use different underlying counters:

| Protocol | Metric keys | Source |
|----------|-------------|--------|
| SRT / RTMP (Zixi) | `ts_continuity_counter_errors` | Zixi TR 101 290 continuity |
| MoQ (CMAF/fMP4) | `cmaf_seq_gap_count`, `cmaf_tfdt_gap_count`, `cmaf_tfdt_gap_ms`, `cmaf_tfdt_overlap_count`, `cmaf_parse_errors` | Post-encode / post-relay fMP4 analysis |

MoQ analysis runs on the local encoder capture every MoQ publish, and is **replaced by post-relay ingest recording** analysis when ingest VMAF/recording is enabled (`POST /api/v1/jobs/{id}/media-health` on the ingest agent).

These are intentionally **not** `net_*` / QUIC / SRT packet metrics.

## Relay health (MoQ)

Prometheus counters from moqx are absolute since relay restart. The UI charts **deltas from the first sample of the job** so comparisons stay meaningful.

**Receive loss (`quic_packets_lost`)** is MoQ's ingest-side counterpart to SRT's Send loss
(`pkt_snd_loss`) — a cumulative count of lost QUIC packets. It cannot be a *sender*-side counter
because the default `openmoq-publisher` backend exposes no transport telemetry at all (no qlog,
no stats output on the CLI); its `stats()` API only reports bytes/objects/groups published, not
loss. Instead it's sourced from the **moqx relay's own QUIC stack** (`moqx_quicPacketLoss_total`,
job-window delta) — i.e. loss as observed on the receive side of the connection — falling back to
the publisher's own picoquic `packet_lost` qlog events when running the experimental `moq5`
backend. It is intentionally **not** available for SRT/RTMP, and `pkt_snd_loss` is intentionally
not available for MoQ; they are complementary, protocol-native views rather than the same metric.

---

## Browser playback

| Column | Meaning |
|--------|---------|
| `e2e_latency_ms` | Estimated glass-to-glass (see above) |
| `playback_ttff_ms` | Time to first frame after player start |
| `playback_stall_count` | Stalls (MoQ playa / HLS buffer stalled) |
| `playback_rebuffer_sec` | Cumulative seconds spent rebuffering, from each `<video>` `waiting`→`playing` bracket (MoQ: `@playa/player` stall `durationMs`) |
| `playback_buffer_sec` | Seconds of media buffered ahead of the playhead (renamed from "Buffer duration" to "Buffer size" in the UI) |
| `playback_video_time_sec` | Max `<video>.currentTime` |
| `playback_error_count` | Normalized player errors |

---

## Video Quality (VMAF)

Optional post-run libvmaf on encoder capture and/or ingest recording. Charted separately per stage
(see “Encode quality vs. ingest quality” above) rather than in one combined tab. See the ingest-agent
sections in this repo’s Zixi / web runbooks.

---

## Metrics by protocol (summary)

| Metric family | SRT | RTMP | HTTP/HLS/DASH | WebRTC | MoQ |
|---------------|-----|------|---------------|--------|-----|
| Client + encode | ✓ | ✓ | ✓ | ✓* | ✓ |
| `net_rtt` / loss | ✓ | ✓ (path/Zixi RTT; no loss %) | — | — | ✓ (QUIC / path) |
| Zixi TR101 | ✓* | ✓* | — | — | — |
| Relay health | — | — | — | — | ✓ |
| Server host | ✓* | ✓* | ✓* | ✓* | ✓* (GCP) |
| Playback + E2E | ✓* | ✓* | ✓* | ✓* | ✓* |
| Video Quality | ✓* | ✓* | ✓* | ✓* | ✓* |

\* Requires optional wiring (Zixi API, GCP metrics, browser player open during encode, VMAF).
