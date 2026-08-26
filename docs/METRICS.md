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
| Browser playback | `playback` | Glass delay, **playback FPS / dropped frames**, stalls, rebuffer, buffer. TTFF is a single join event, not a latency series. |
| Startup breakdown | `startup_breakdown` | Where the join time went: two separate phase chains (publisher → ingest, player → glass), each reconciled against its own measured total. Stacked bars, not a series — startup happens once. |

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
e2e_latency_ms ≈ capture-anchored per player:
  - Zixi HTTP-TS / Fast HLS: (wall_now − encode_start) − media_playhead (+ webcam bridge)
  - MediaMTX LL-HLS: hls.js PDT latency + encode_lag + bridge
  - MoQ: CaptureTimestamp when present; else live buffer lead + encode/bridge
    (MSE currentTime is join-relative — wall−vt is join delay, not G2G)
```

Assumptions: Zixi timelines are encode-anchored; LL-HLS needs PROGRAM-DATE-TIME; MoQ without
CaptureTimestamps uses buffer lead. Browser and publisher clocks should be roughly NTP-aligned.
Values outside 0–120s are dropped as invalid.

**How to compare protocols:** run legs in parallel (or back-to-back with the same media), keep playback open during the encode, and compare the **`e2e_latency_ms`** series (and summary average) under **Browser playback**. Pair with TTFF, stall count, and **`playback_buffer_sec`** (seconds buffered ahead of the playhead) for a fuller viewer story.

A future upgrade is SEI / wall-clock timestamps in the bitstream for true glass-to-glass without clock skew.

---

## Latency breakdown (per-component)

`e2e_latency_ms` alone tells you a leg is slow, never *where* the time went — and because each protocol estimates it differently (LOC CaptureTimestamp vs HLS PDT vs wall−playhead vs encode+RTT/2), comparing totals across legs can mislead. Every leg now also reports one ordered chain of components in the same units:

```
capture ──encode──> muxed ──cmaf_group──> publish ──network──> ingest ──packager──> player_buffer──> glass
```

| Column | Stage | Source |
|--------|-------|--------|
| `latency_encode_ms` | capture → AU | Encoder pipeline offset + sustained lag. GOP-close wait is **not** here |
| `latency_segmentation_ms` | AU → closed group | Known object/group duration. **0.5s/1s on MoQ CMAF is group duration (NextGroupStart), not ingest RTT.** LL-HLS parts are 200ms. WebRTC is n/a |
| `latency_publish_ms` | closed group → ingest | **No instrument on any protocol today.** Always listed in `latency_unmeasured` |
| `latency_network_ms` | one-way path | `net_rtt_ms ÷ 2`. SRT / RTMP / WebRTC only. MoQ unmeasured unless qlog RTT exists |
| `latency_packager_ms` | ingest → delivery | Measured for MediaMTX LL-HLS via PROGRAM-DATE-TIME. 0 + unmeasured ≠ free remux |
| `latency_player_buffer_ms` | delivery → glass | `playback_buffer_sec × 1000` — seconds queued **ahead** |
| `latency_accounted_ms` | — | Sum of the components **this leg's e2e actually spans** |
| `latency_residual_ms` | — | Measured glass delay the accounted components do not explain |
| `latency_overcount_ms` | — | Accounted components **in excess of** measured e2e |
| `latency_unmeasured` | — | Stages with no instrument (`segmentation` when GOP/part is unknown) |
| `latency_not_applicable` | — | Stages that do not exist (WebRTC has no CMAF group) |
| `latency_e2e_scope` | — | `capture_to_glass`, `ingest_to_glass`, or `capture_to_ingest` |

### The three honesty properties

The model makes three separate statements and refuses to blur them together:

1. **A stage with no instrument reads 0 *and* names itself in `latency_unmeasured`.** A bare 0 would mean "this stage is free"; the annotation makes it mean "we did not measure this". `latency_publish_ms` is unmeasured everywhere; `latency_packager_ms` is unmeasured on Zixi Fast HLS and MoQ; `latency_network_ms` is unmeasured on MoQ (no RTT source is wired for the openmoq publisher — `quic_rtt_ms` is 0 too).
2. **Under- and over-attribution are different facts and get different columns.** `latency_residual_ms` was previously clamped at zero, so a leg whose components summed to *more* than its measured e2e looked identical to one that reconciled exactly — Linode WebRTC over-counted by up to 1721 ms against a 35 ms e2e while reporting a residual of 0.0. Exactly one of `latency_residual_ms` and `latency_overcount_ms` can be non-zero.
3. **Only components inside the measured span are summed.** WHEP's `e2e_latency_ms` is a *receiver-side* jitter-buffer estimate that begins at ingest, while `latency_encode_ms` is a *sender-side* offset. Summing them was the modelling error behind that 1721 ms. WebRTC legs therefore carry `latency_e2e_scope=ingest_to_glass`: the encode component is still reported in its own column, but it is excluded from `latency_accounted_ms`.

**The residual is a feature, not an error term.** A large residual means the e2e estimate and the individual stages disagree, which is the signal to distrust a single-number comparison. Check `latency_unmeasured` first. Expect a non-trivial residual on:

- **Zixi Fast HLS** — chunk packaging time has no instrument (no PDT in the playlist), so `packager` is listed as unmeasured and its cost lands here. Only HTTP-TS is a measured ~0.
- **MoQ CMAF** — `latency_segmentation_ms` now holds the known group duration (NextGroupStart). Residual should no longer be a silent GOP. Publish and network remain unmeasured without a real instrument / qlog RTT.
- **Browser MoQ LOC** — reports 0 for the player-buffer component on purpose. Its "seconds behind live" figure points the *opposite direction* from a buffer and travels in its own `playback_behind_live_sec` column so it can never be summed into this chain.

Formulas live in `src/latency_budget.py` and its browser mirror `web/frontend/src/latencyBudget.ts`; they are kept numerically identical and tested against each other.

**`upload_latency_ms` is not a stage.** It is a one-shot *startup* measurement (encoder-ready → first confirmed publish) and it is deliberately excluded from the chain above. Adding a startup constant to every steady-state sample inflated `latency_accounted_ms` for whole runs. Read it in its own column.

Run `scripts/qa_metric_audit.py --latest N --assert` to check these properties against finished legs; it exits non-zero if any of them is violated.

The audit reports on two channels and **only failures gate `--assert`**. A failure means a column is lying. An observation means a column is telling the truth about something that still deserves an owner — an encoder that genuinely oscillates (`fps_stability` ≥ 0.05, where the rate mean and the counter-derived fps are both honest views of the same wobble), or a CMAF/MSE buffer that is genuinely deep. Keeping them in one list made a passing verdict uninterpretable, because two rules concluded "this value is large and legitimate" and then failed the leg anyway.

**Encoder stalls are detected and named.** A mid-run freeze — the frame counter stops advancing while the leg keeps going — had no reporter at all. `encode_frames_dropped` stays 0 because nothing was dropped, it was never produced, and `fps_stability` is structurally blind to it: a full stop enters the rate column as a 0 that is filtered out before the coefficient of variation is taken, so a hard freeze reads as *steadier* than a mild wobble. On `upload_20260823-022938_72699c63` the encoder froze 2.9 s at 159 frames with `fps` at 0.00 while `fps_stability` read 0.0305, and the audit called the resulting gap an fps formula defect. A stall now explains the gap before `fps_stability` gets a vote (753 frames over the 24.1 s excluding the freeze is 31.24 fps, matching the 31.486 rate mean), and the freeze is reported in its own right.

**Absence is gated.** Every invariant used to be "there is data and it is wrong", so a column that never got collected read as compliance — a clean verdict was also exactly what a totally broken collector produced. `REQUIRED_NONZERO` now fails a leg whose instrumented columns go quiet (blanking `net_rtt_ms` on an RTMP leg fails it instead of passing), and the `PLAUSIBLE` windows assert instead of only printing `<- N implausible` (a bitrate off by 1000× for a whole run fails). The encoder ramp is the one carve-out: a first non-zero sample covers a partial interval and reads low by construction, so it is an observation. MoQ is exempt from the RTT requirement because no RTT source is wired for the openmoq publisher.

The MoQ buffer rule reads the evidence rather than inferring it. A deep `latency_player_buffer_ms` is a behind-live **leak** only when `playback_behind_live_sec` is what filled it; on a CMAF leg (`cmaf_fragment_count` > 0) with behind-live at 0 it is a real buffered range, and on a LOC leg with neither it is unexplained and fails. The earlier version read "MoQ" as "LOC canvas" and failed a CMAF leg for a leak its own CSV disproved.

---

## Startup breakdown (per-phase)

`playback_ttff_ms` says a leg took 23 seconds to join. It never says *which* component spent them.
That gap is not academic: the RTMP startup win already banked — **23s → 1501 ms** — came from
*reasoning* about phases. The GOP was pinned to the HLS chunk duration, so the first decodable frame
could not arrive until a whole chunk had been packaged, and nothing in the tool measured it. This
family turns that reasoning into a measurement.

Startup is modelled as **two ordered chains, deliberately kept apart**:

```
publisher   job start ──dns──> ──connect──> ──handshake──>
            ──publish_accept──> ──first_idr──> ──first_byte_ingest──> ingest

player      player attach ──player_request──> ──manifest──>
            ──first_media──> ──first_paint──> glass
```

**They are two spans, not one.** Between "ingest has the first byte" and "an operator opened the
tile" sits however long the operator took — dwell time that belongs to nobody's pipeline. Summing
across the join would produce a "total startup" dominated by human reaction time, so there is no
such column. Each half reconciles against **its own** measured total: the publisher chain against
job-start → first-byte-at-ingest (`startup_publisher_measured_ms`), the player chain against
`playback_ttff_ms` (`startup_player_measured_ms`).

Every phase is a **duration**, not an offset from t0, and a phase is measured only when *both* its
bounding milestones are. A missing middle milestone does not get papered over by stretching its
neighbour across the gap — that would silently move real time into whichever phase happened to have
an instrument, which is the exact misattribution the family exists to prevent.

### Publisher chain: protocol × phase

| Phase | Column | RTMP | SRT | WebRTC (WHIP) | MoQ |
|-------|--------|------|-----|---------------|-----|
| dns | `startup_dns_ms` | `getaddrinfo()` on the ingest host (preflight probe) | same | same, on the WHIP host | same, on the relay host |
| connect | `startup_connect_ms` | TCP connect to 1935 (preflight probe) | **n/a** — the caller handshake *is* the connect | TCP/TLS connect to the WHIP endpoint (8889) | QUIC handshake (transport + crypto in one exchange) |
| handshake | `startup_handshake_ms` | C0/C1/S0/S1/S2 plus connect/createStream/publish | SRT caller handshake including key material | ICE establishment and DTLS setup | WebTransport session over the completed QUIC connection |
| publish_accept | `startup_publish_accept_ms` | ingest reports the input live (Zixi input ready / MediaMTX path ready) | same | WHIP POST offer → 201 Created with the answer SDP (that response *is* the accept) | SETUP/ANNOUNCE accepted and catalog published (`sender ready (namespace + catalog published)`) |
| first_idr | `startup_first_idr_ms` | encoder emits its first frame (H.264 → IDR) | same | same | same |
| first_byte_ingest | `startup_first_byte_ingest_ms` | ingest reports bytes received on the path | libsrt non-zero send rate / ingest bytes received | MediaMTX reports bytes received (first RTP landed) | first object on the wire (`obj vide wall_dt_ms=`) |

Mapping QUIC onto `connect` and WebTransport onto `handshake` keeps all six MoQ phases meaningful
without inventing a TCP connect that never happens. Folding SRT's connect into `handshake` keeps
that column comparable with RTMP's — both are "after the socket, before publish is accepted".

### Player chain: engine × phase

The player half is keyed on the **playback engine**, because the player is what measures it. A
protocol watched over a remux is measured by the remux's engine (see *Playback engine vs published
protocol* below).

| Phase | HLS / LL-HLS | DASH | MPEG-TS | WHEP | MoQ (playa) |
|-------|--------------|------|---------|------|-------------|
| `startup_player_request_ms` | Resource Timing on the manifest: `fetchStart → requestStart` (DNS + connect + TLS) | same, on the MPD | same, on the TS request | same, on the WHEP POST | `load()` → WebTransport session connected |
| `startup_manifest_ms` | Resource Timing on the manifest: `requestStart → responseEnd` | same, on the MPD | **n/a** — a TS pull has no manifest; the first response *is* the media | SDP exchange: POST offer → 201 answer (`responseEnd`) | SETUP complete → catalog received (SUBSCRIBE, plus joining FETCH) |
| `startup_first_media_ms` | first media segment response completes (LL-HLS: first partial) | first media segment completes | first bytes of the TS response (`responseStart`) | `getStats()`: candidate-pair succeeded + DTLS connected, then first `inbound-rtp` bytes | first group/object received, then decoder configured |
| `startup_first_paint_ms` | first frame painted (`currentTime` advances past the session origin) | same | same | first frame painted | first frame rendered to the canvas |

### The three states — blank, zero, and not-applicable

1. **Blank ≠ 0.** `0.0` means "measured, and it was zero" — a warm resolver cache really does
   resolve inside the measurement resolution. A **blank** cell means no instrument, and the phase is
   named in `startup_unmeasured`. That list is *why* a residual is large.
2. **A phase that cannot exist is a third state.** SRT has no TCP connect; raw MPEG-TS playback has
   no manifest. Reporting those as "unmeasured" would send an operator hunting for an instrument
   that cannot exist, and reporting them as `0.0` would claim an exchange completed instantly. They
   go in `startup_not_applicable`. Their time is **not lost**: the chain anchors the next phase to
   the last milestone that *did* happen, so an n/a phase's duration is attributed to the phase that
   genuinely contains it — SRT's handshake is timed from DNS completion and spans the whole caller
   exchange.
3. **A phase past the sanity ceiling is dropped, not clamped.** The ceiling is a generous 120 s per
   phase (180 s for a measured total) precisely because the 23 s baseline this family exists to
   explain *was* a single phase. Above it the number is a clock artifact, and a clamped artifact
   charts exactly like a real 120 s phase.

### Reconciliation

| Column | Meaning |
|--------|---------|
| `startup_publisher_accounted_ms` / `startup_player_accounted_ms` | Sum of that half's phases that have a reading |
| `startup_publisher_measured_ms` | Job start → first media confirmed at the ingest |
| `startup_player_measured_ms` | `playback_ttff_ms` — player attach → first painted frame |
| `startup_publisher_residual_ms` / `startup_player_residual_ms` | Measured startup the phases cannot explain. Never negative |
| `startup_publisher_overcount_ms` / `startup_player_overcount_ms` | Phases **in excess of** the measured total. Never negative |
| `startup_unmeasured` | Comma-separated stage names with no instrument on this leg |
| `startup_not_applicable` | Comma-separated stage names that structurally do not exist here |

**Disagreement is signed, per half.** Exactly one of residual and overcount can be non-zero in each
chain, for the same reason `latency_overcount_ms` exists: with the residual alone clamped at 0, an
over-attributing model is indistinguishable from one that reconciles. A non-zero overcount means two
phases share a span somewhere — a modelling bug, but one an operator can only find if the column
admits it.

**A large residual is a signal, not a failure.** It is the honest report that the measured total is
real and the phases explaining it are not all instrumented yet. Read `startup_unmeasured` first: on
a leg where the player half reconciles to 10% and 90% is unattributed, the phases that *are* measured
have ruled themselves out, which is exactly how the RTMP chunk-duration problem was found by hand.

### What is unmeasured today, and why

Support is declared per protocol in `METRIC_PROTOCOL_SUPPORT` and per leg in `startup_unmeasured`.
The structural gaps as this family lands:

- **Publisher `dns` / `connect`** need the preflight probe to run before the encoder spawns. A leg
  published without it reports both blank rather than folding the time into `handshake`.
- **Publisher `publish_accept`** depends on the ingest admitting it is live: Zixi input ready or a
  MediaMTX path ready for RTMP/SRT, the WHIP 201, the MoQ `sender ready` line. An ingest with no
  status endpoint (or a provider whose API is not reachable from the collector) leaves it blank —
  and because it is the phase most likely to hold a packaging delay, that blank is usually the
  reason a publisher residual is large.
- **Player `player_request` / `manifest` / `first_media`** on HLS / LL-HLS / DASH / MPEG-TS / WHEP
  come from `PerformanceResourceTiming` and `getStats()`. Resource Timing was not used anywhere in
  the frontend before this family, so any player not yet reading those marks reports the phases
  blank and its whole TTFF lands in `startup_player_residual_ms`.
- **Player phases on MoQ** are nearly free: `@playa/player` already computes a `TTFFBreakdown`
  (`transportConnectedMs`, `setupCompleteMs`, `catalogReceivedMs`, `firstObjectReceivedMs`,
  `decoderConfiguredMs`, `firstFrameRenderedMs`) that the tile used to discard in favour of
  `timeToFirstFrameMs` alone.
- **`startup_manifest_ms` is never restricted by protocol** even though a raw MPEG-TS pull has no
  manifest. The same SRT or RTMP leg can be watched over MPEG-TS or over LL-HLS in one run, so the
  absence belongs to the engine and travels in the per-row `startup_not_applicable` annotation
  instead of being encoded as a protocol gap.

Formulas live in `src/startup_budget.py` and its browser mirror `web/frontend/src/startupBudget.ts`;
`web/frontend/scripts/unit-startup-budget.mjs` cross-checks the column set across the contract, the
mirror, the metric definitions, the protocol matrix, the chart group and `CSV_COLUMNS`, which is what
stops the mirror drifting. The UI renders both chains as stacked horizontal bars under the **Startup
breakdown** tab — one bar per chain, never concatenated, with unmeasured phases hatched,
not-applicable phases outlined, and the residual as an explicit trailing segment.

---

## Frame accounting

Drops are counted at both ends of the chain with the **same denominator convention**, which is what makes the two percentages comparable:

| Column | Formula | Source |
|--------|---------|--------|
| `encode_frames_total` | ffmpeg `-progress frame` | Exact |
| `encode_frames_dropped` | ffmpeg `-progress drop_frames` | Exact, not inferred |
| `encode_frames_duped` | ffmpeg `-progress dup_frames` | CFR normalization of a VFR source |
| `encode_frame_drop_pct` | `dropped / (encoded + dropped)` | Frames *offered* to the encoder |
| `playback_frame_drop_pct` | `dropped / (rendered + dropped)` | Frames *delivered* to the player |
| `frame_delivery_pct` | painted ÷ encoded, **both counted since the player attached** | Spans the whole chain |

Deliberately **not** `fps × elapsed`: a genuine 24fps source is not dropping 20% of a 30fps expectation. `frame_delivery_pct` is the only frame metric that catches loss in the middle (relay drop, packager gap, decoder flush) that neither endpoint counter sees on its own.

**The window matters more than the ratio.** Both counters are cumulative but they do not start together: the encoder counts the whole run while the browser attaches seconds late and often detaches early. Dividing the raw totals compared two different time spans and produced a number that decayed as the run went on with nothing actually being lost — on the Linode Zixi RTMP leg it fell monotonically from 48.0% to 10.1% while `playback_frames_rendered` sat frozen at 84 and `encode_frames_total` climbed to 835. Both counters are therefore rebased to their values at player attach, so the ratio compares the same interval on both ends. Samples with no common window are left **blank**, not zero, and blanks are excluded from the run average.

There is no 100% cap. A cap would hide the cases worth seeing: a player legitimately reading ahead of the encoder counter under clock skew, or an attach point captured a moment too late. Values above 100% mean the window is misaligned, and the column says so rather than flattening it to a confident 100.0.

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

`encode_lag_ms` = growth of (wall elapsed − ffmpeg `out_time`) past the first positive-media sample. A flat **0** means the encoder stayed at its startup baseline (keeping up), or the path never reported lag — the UI hides an all-zero series instead of inventing numbers.

### Encode overlay clock

ffmpeg burns **`encode time HH:MM:SS.mmm`** for file / webcam (media timeline from encode start) or **`capture time …Z`** when the input already uses wall-clock PTS (`-use_wallclock_as_timestamps`). It is **not** Unix-epoch + PTS mashed together. The laptop webcam preview overlay is labeled **`wall clock`** and is not mirrored.

### Client memory

`memory_mb` is ffmpeg / publisher RSS from psutil. If the agent did not collect RSS, charts hide the series rather than plot a flat zero. `client_memory_percent` is host memory when available.

### WebRTC / WHIP bitrate

ffmpeg’s WHIP muxer often ramps bitrate for the first ~20–30s (muxer warmup). That ramp is expected; it is not a stall.

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
| `playback_stall_count` | Stalls after first frame (HTML waiting / frozen-playhead; all players) |
| `playback_rebuffer_sec` | Cumulative seconds rebuffering — HTML `<video>` waiting→playing (+ frozen-playhead); same for MoQ/HLS/MPEG-TS/DASH/WHEP |
| `playback_buffer_sec` | Seconds of media buffered **ahead** of the playhead (renamed from "Buffer duration" to "Buffer size" in the UI). Strictly "ahead" on every engine |
| `playback_behind_live_sec` | Seconds the glass is **behind** live. MoQ LOC only — its canvas has no HTML media buffer. Opposite direction from the row above, which is why it is a separate column |
| `playback_video_time_sec` | Max `<video>.currentTime` |
| `playback_error_count` | Normalized player errors |
| `playback_sample_age_sec` | Seconds since the browser last reported. Non-zero means the live gauges on this row are carried over, not fresh |

### Stale is not stable

The pipeline samples once a second for the whole encode, but the browser only reports while a player is attached. Rows written after the player detaches used to repeat its last reading verbatim — Linode WebRTC held an identical 35 ms for 22 of 30 samples and Zixi RTMP held 5522 ms for 24 of 30 — which pulled the run average toward the frozen value and made a leg that had stopped being measured look rock-steady.

Live gauges (`e2e_latency_ms`, `playback_buffer_sec`, `playback_bitrate_bps`, and the other point-in-time playback readings) are now **blanked** once `playback_sample_age_sec` passes 3 s, and blanks are excluded from the run average rather than counted as zero. Cumulative run totals — frames rendered, stall count, rebuffer seconds — are exempt: the last value of a counter remains a true statement about the run after the player leaves.

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

---

## Known gaps (why a column is empty when you expected a number)

Empty / zero is often honest, not a CSV bug. After `100826e`, MoQ `e2e_latency_ms` is omitted unless a first frame rendered — path-delay fallbacks must not invent ~10s on a black player.

| Metric | SRT | RTMP | WebRTC (WHIP/WHEP) | MoQ | Why it is missing when expected |
|--------|-----|------|--------------------|-----|--------------------------------|
| `e2e_latency_ms` / `playback_ttff_ms` / `playback_frames_*` | Site player | Site player | Site player | Site player | Glass metrics are posted by the browser player. API/harness-only runs stay 0. MoQ also needs a painted first frame; CMAF has no CaptureTimestamp so e2e is TTFF/path-delay after frames, never before. |
| `quic_*` (rtt, cwnd, lost) | n/a | n/a | n/a | Empty on prod sidecar | `openmoq-publisher` has no qlog. Relay Prometheus fills `moqx_*` / receive-loss stand-ins, not publisher picoquic qlog. |
| `net_rtt_ms` | libsrt / MTX / Zixi | Zixi or TCP probe | `getStats` RTT | Path probe / qlog | Remote WHIP used to be 0 when MTX metrics were loopback-only. East/Linode now scrape the agent. RTMP without Zixi REST is TCP connect RTT, not media RTT. |
| `net_loss_pct` / `net_retrans_pct` | libsrt / MTX | Usually empty | RTP loss / NACK | moqx QUIC Δ | RTMP has no ARQ loss series. MoQ send-loss is relay-observed (`quic_packets_lost`), not publisher `pkt_snd_loss`. |
| `encode_lag_ms` | ffmpeg `out_time` | same | same | same | 0 if `-progress` never parsed `out_time_us`/`out_time_ms` (fixed). Browser WebCodecs jobs have no ffmpeg out_time. |
| `vmaf_score_encoder` | tee capture | tee capture | **QP 0–100 stand-in only** | stdout tee → mp4 | ffmpeg cannot tee the WHIP muxer. Webcam live has no file reference. |
| `vmaf_score_ingest` | Zixi TS record | Zixi TS record | **none** | `openmoq-fmp4-record` | Central web (`34.9.217.178`) has no ingest-agent process; East/Linode do. Central Zixi recorder (`35.222.33.58:8090`) is on the dead host. WHIP has no post-ingest file. |
| `ts_continuity_counter_errors` | Zixi TR101 | Zixi TR101 | n/a | n/a | Needs Zixi Analyze. MediaMTX SRT uses a weaker `paths_inbound_frames_in_error` stand-in. |
| `cmaf_*` media health | n/a | n/a | n/a | encoder/ingest fMP4 | LOC (webcam) is not CMAF; those columns stay empty on LOC legs. |
| `moqx_subscribe_*` | n/a | n/a | n/a | job-window Δ | Lifetime counters used to look like the current job failed. Charts now use the job window; historical `track_not_exist` is not a live playback failure. |

**Stand-ins (same CSV name, different physics — do not treat as identical):**

- WebRTC `vmaf_score` ≈ H.264 QP mapped to 0–100, not libvmaf.
- MoQ CMAF `e2e_latency_ms` ≈ TTFF + playhead drift or `encode_lag + RTT/2 + buffer`, not CaptureTimestamp glass-to-glass.
- WebRTC `e2e_latency_ms` ≈ encode lag + RTT/2 + jitter buffer (no capture clock on RTP).
- RTMP `net_rtt_ms` without Zixi REST ≈ TCP connect probe.
- `encoder_send_rate_mbps` on direct-ffmpeg RTMP/SRT/MoQ ≈ a copy of `encoded_bitrate_kbps / 1000`, **not** an independent network measurement. Only `srt-live-transmit` supplies a measured libsrt send rate.
- MoQ LOC has no HTML media buffer at all. Its "seconds behind live" figure used to be written into `playback_buffer_sec`, where the latency chain multiplied it by 1000 and charted a **10.9 s player buffer** on the Linode MoQ leg — on the protocol that should be lowest-latency. It now travels in `playback_behind_live_sec`, and LOC's `playback_buffer_sec` is a true 0, so LOC contributes 0 to `latency_player_buffer_ms` as documented.

**Playback engine vs published protocol.** The playback columns describe whatever the player actually consumed. When those disagree, the summary carries `extra.playback_engine_caveat`:

> Job `c49d2ef4` (2026-08-22) is tagged `protocol=webrtc`, but the tile played the **LL-HLS remux** of the WHIP ingest — no WHEP reader session ever opened. Its TTFF (7.6s), 8 stalls, 28.2s rebuffer and ~37s glass delay are HLS numbers, and ranking them against native-path legs is invalid. Check `extra.playback_engine` before comparing.

**Counter fields are run totals, not averages.** In `summary.averages`, every `pkt_*`, `cmaf_*_count`, `cmaf_tfdt_gap_ms`, `moqx_*`, `encode_frames_*`, and `playback_*` counter (plus `playback_rebuffer_sec`) is the value from the final sample. `averages_note` in the summary says so explicitly. Only rate/gauge columns are true means.

**Headline `fps` comes from the frame counter, not from the mean of the rate column.** The per-sample `fps` is ffmpeg's instantaneous rate and it is honest, but the sample interval is not perfectly constant, so an unweighted mean over-weights the short fast ticks. Every MoQ leg reported 32.2–32.7 fps for a 30 fps source; the counter says 29.78. The summary now divides frames produced by wall time elapsed, which is exact and interval-independent.

The oscillation behind that is real and worth reading: the MoQ publisher pipe applies backpressure, so ffmpeg genuinely alternates roughly 24.9 and 37.4 fps while media time advances at a steady 30. **`fps_stability`** — the coefficient of variation over a rolling window — is the column that reports it, and it separates the protocols cleanly (0.198 on MoQ against 0.019 on SRT). A high `fps_stability` with a counter-derived `fps` at source rate means throughput is bursty, not that frames are being lost.

**`e2e_latency_max_ms` is the observed worst case.** It is taken before the 3×-median outlier trim that produces the average, so a leg that froze once still reports the freeze. The plausibility ceiling is 180s on both the backend and the browser — a 30s backend ceiling previously discarded every sample from the worst legs in a run, which read as "not measured".
