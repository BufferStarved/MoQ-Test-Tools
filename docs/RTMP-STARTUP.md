# RTMP playback startup (Zixi)

Default path: **RTMP publish → Zixi → HTTP-TS (`mpegts.js`)**. Fast HLS is available but adds ~4 s intentional live buffer.

## Hard floor (~1 s)

Zixi Fast HLS and HTTP-TS only cut/play on **IDR keyframes**, so the first decodable media cannot arrive before one GOP of encode time.

The GOP used to be **2 s** because `gop_frames_for_latency` keys it to `hls_segment_sec` — the Zixi chunk duration. That conflated two different constraints: a GOP only has to **divide** the chunk, not equal it. `encode_profile.delivery_gop_frames` now emits **1 s** IDRs, which still divides the 2 s Fast HLS chunk exactly (2 GOPs per chunk), so packaging is unchanged while the first-IDR wait halves. This also puts every delivery path — MediaMTX LL-HLS, Zixi, MoQ — on the same 1 s keyframe cadence, which is what makes cross-protocol TTFF comparable instead of GOP-confounded.

Do **not** shrink Zixi's `hls_chunk_time` to 1 s. That is a separate knob and 1 s chunks still stutter.

## Ordered delays (typical MPEG-TS default)

| Phase | Typical | Knob |
|-------|---------|------|
| RTMP preflight (managed Zixi) | ~50–200 ms | TCP-only — already optimized (`endpoint_probe.py`) |
| First IDR / GOP | **~1 s** | `delivery_gop_frames` (`encode_profile.py`) |
| `preview_ready` poll | 0–0.2 s | **0.2 s** before the gate opens, 0.5 s after (`upload_service.py`) |
| HTTP-TS probe | 0–1.2 s | Timeout **1.2 s** — reads 8×188 B, returns in tens of ms when healthy (`upload_service.py`) |
| mpegts.js attach | ~0.5–1 s | Sync-byte probe skipped only when `preview_ready` already validated it (`StreamPlayer.tsx`) |
| Zixi input-recreate retry (if hit) | 0.75 s | Was 2 s (`upload_service.py`) |

**Expected TTFF:** ~**2–3 s** with defaults.

## The 2026-08-22 Linode regression (~23 s)

Measured 23 s TTFF on RTMP → Linode Zixi while SRT on the same laptop joined in 8 s. Four costs stacked:

1. **2 s GOP floor** inherited from `hls_chunk_time` (now 1 s).
2. **`skipConnectProbe` keyed off the playback gate.** RTMP/SRT get gate=`live` while `preview_ready` is still `false`, so the check was disabled *exactly* when the origin was most likely empty. mpegts.js then attached to 0 bytes and burned 1.2 s reconnects (up to 8). Now keyed off `preview_ready === true`, where the probe is genuinely redundant.
3. **2.5 s HTTP-TS probe timeout** serialized with a 0.5 s poll — a ~3 s quantum per attempt on a cold origin.
4. **2 s sleep** before the Zixi RTMP input-recreate retry.

If startup is still ~15 s+, the cause is downstream of this checkout: see below.

## If startup is still ~15 s+

1. Run `ZIXI_PASSWORD=… ./infra/zixi/scripts/verify-zixi-hls-chunk-time.sh` — leftover **4 s** `hls_chunk_time` inflates HLS join and e2e.
2. Confirm playback mode is **MPEG-TS**, not Fast HLS (HLS adds ~4 s liveSync).
3. Stabilize RTMP input: `./infra/zixi/scripts/configure-zixi-rtmp-input.sh`.

## Faster-start levers (by layer)

### ffmpeg
- **GOP = 1 s** (`delivery_gop_frames`) — must stay an exact divisor of `hls_chunk_time`, or Zixi stretches segments to the next IDR and the player's 2-segment buffer doubles the damage (the 16.7 s e2e regression of 2026-07-21).
- `-preset ultrafast` — marginal TTFF win; quality/bitrate cost.
- `-re` on file sources — required for fair multi-leg races; disabling only for synthetic TTFF tests.

### Zixi
- **`http_ts_auto_out=1`** — keep on; mpegts.js bypasses Fast HLS packager.
- **`hls_chunk_time=2`** — verify with `verify-zixi-hls-chunk-time.sh`.
- Stable RTMP push input (`benchmark` stream id) — avoids ffmpeg early-exit + 2 s retry sleeps.

### hls.js (when using HLS mode)
- ~**4 s** intentional buffer at default target (`hlsLiveSyncDurationSec`).
- Do not chase sub-segment liveSync on Zixi (stalls on 2 s chunks).
- Prefer mpegts.js for join-speed monitoring.

### Browser (mpegts.js)
- `skipConnectProbe` **only** when `preview_ready === true` — never off the playback gate (see the 2026-08-22 regression above).
- `liveBufferLatencyChasing: true`, `enableStashBuffer: false`.
