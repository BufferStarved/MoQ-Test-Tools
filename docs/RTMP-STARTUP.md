# RTMP playback startup (Zixi GCP)

Default path: **RTMP publish → Zixi → HTTP-TS (`mpegts.js`)**. Fast HLS is available but adds ~4 s intentional live buffer.

## Hard floor (~2 s)

Zixi Fast HLS and HTTP-TS only cut/play on **IDR keyframes**. With the repo’s 2 s GOP floor (`encode_profile.hls_segment_sec`), the first decodable media cannot arrive before ~**2 s** of encode time. Nothing at ffmpeg, Zixi, or hls.js can beat that without changing chunk/GOP policy (1 s chunks stutter on Zixi today).

## Ordered delays (typical MPEG-TS default)

| Phase | Typical | Knob |
|-------|---------|------|
| RTMP preflight (managed Zixi) | ~50–200 ms | TCP-only — already optimized (`endpoint_probe.py`) |
| First IDR / GOP | **~2 s** | `-g` tied to `hls_segment_sec` (`encode_profile.py`) |
| `preview_ready` poll | 0–0.5 s | Poll interval **0.5 s** (`upload_service.py`) |
| HTTP-TS probe | 0–2.5 s | Timeout **2.5 s** (`zixi_hls_health.py`) |
| mpegts.js attach | ~0.5–1 s | Duplicate probe **skipped** when gate=live (`MpegTsPlayer.tsx`) |

**Expected TTFF:** ~**3–5 s** with defaults after these changes.

## If startup is still ~15 s+

1. Run `ZIXI_PASSWORD=… ./infra/zixi/scripts/verify-zixi-hls-chunk-time.sh` — leftover **4 s** `hls_chunk_time` inflates HLS join and e2e.
2. Confirm playback mode is **MPEG-TS**, not Fast HLS (HLS adds ~4 s liveSync).
3. Stabilize RTMP input: `./infra/zixi/scripts/configure-zixi-rtmp-input.sh`.

## Faster-start levers (by layer)

### ffmpeg
- **GOP = 2 s** — do not shrink below Zixi segment floor without reconfiguring Zixi.
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
- `skipConnectProbe` when `preview_ready` already validated TS sync bytes.
- `liveBufferLatencyChasing: true`, `enableStashBuffer: false`.
