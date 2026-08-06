# Bring your own encoder (BYO)

Use **your** ffmpeg, OBS, hardware encoder, or broadcast chain to publish into the same
ingest endpoints the benchmark UI races. This is the right path when you already have a
production encoder profile, or when you cannot run the repo’s publisher agent.

## What you get vs orchestrated runs

| Mode | Upload metrics (RTT, retrans, bitrate) | Playback metrics | Same recipe orchestration |
|------|----------------------------------------|------------------|---------------------------|
| **Cloud VM** (UI default for player tests) | Yes (ffmpeg on API host) | Yes | Yes |
| **This machine + agent** | Yes (ffmpeg on laptop) | Yes | Yes |
| **BYO encoder (this doc)** | No* | Yes (if playback URL is reachable) | Manual — you publish, then open the site |

\* Unless you also run the local publisher agent or add ingest-side telemetry later.

For fair **protocol comparison under one wall clock**, prefer **Publisher → This machine**
with `./scripts/run-local-publisher.sh` — see [LOCAL-PUBLISHER.md](./LOCAL-PUBLISHER.md).

BYO is best for: OBS trials, hardware encoders, validating a customer network path, or
checking that a publish URL works before wiring the agent.

---

## Shared encode settings

Match the benchmark **Encode ladder** and **Target latency** sliders so results are comparable.

Fetch live values from the API:

```bash
curl -s https://moq.sean-mccarthy.net/api/encode-profiles | jq .
```

Typical **720p · 4000 ms** budget (default):

| Setting | Value |
|---------|--------|
| Resolution | 1280×720 (scale `-2:720`) |
| Video | H.264 Main @ L4.0, yuv420p |
| Bitrate | ~3000 kbps (`-b:v 3000k`, maxrate 3500, minrate 2500) |
| GOP | ~120 frames @ 30 fps (scales with latency slider) |
| B-frames | 0 (`-bf 0 -sc_threshold 0`) |
| Audio | AAC 128 kbps, 48 kHz stereo |
| SRT caller latency | ≥ **2000 ms** (`srt_min_target_latency_ms`); use µs in URLs (`latency=2000000`) |

Every orchestrated encode also burns a UTC **`ENC …Z`** stamp via ffmpeg `drawtext` on
PTS — BYO streams will not have this unless you add equivalent burn-in.

---

## Publish URLs (hosted demo)

Replace `benchmark` / stream names if your ingest expects a different path.

### MediaMTX (SRT → LL-HLS / WHEP) — `34.9.217.178`

Co-located with the web VM. Good for SRT LL-HLS player tests.

| Protocol | Publish URL |
|----------|-------------|
| SRT | `srt://34.9.217.178:8890?mode=caller&latency=2000000&streamid=publish:benchmark` |
| RTMP | `rtmp://34.9.217.178:1935/benchmark` |
| WHIP | `http://34.9.217.178:8889/benchmark/whip` (Opus audio required) |

Playback (browser-safe):

- LL-HLS: `http://34.9.217.178:8888/benchmark/index.m3u8`
- WHEP: `http://34.9.217.178:8889/benchmark/whep`

**ffmpeg example (SRT, test pattern):**

```bash
ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=1000:sample_rate=48000 \
  -vf "scale=-2:720" -c:v libx264 -preset veryfast -g 120 -keyint_min 120 \
  -bf 0 -b:v 3000k -maxrate 3500k -minrate 2500k -bufsize 6000k \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -f mpegts "srt://34.9.217.178:8890?mode=caller&latency=2000000&streamid=publish:benchmark"
```

### Zixi Broadcaster (SRT / RTMP) — `35.222.33.58`

Traditional SRT/RTMP → Fast HLS / MPEG-TS egress.

Machine-readable ffmpeg + `srt-live-transmit` templates (no credentials):

```bash
curl -s 'https://moq.sean-mccarthy.net/api/debug/zixi-srt?encode_ladder=720p&target_latency_ms=4000&stream_id=SRT%20Test' | jq .
```

Typical SRT publish (caller → Zixi listener on `:10080`):

```text
srt://35.222.33.58:10080?mode=caller&latency=4000000&streamid=#!::r=SRT Test,m=publish
```

RTMP (managed input name varies — use a preset from the UI or Zixi API):

```text
rtmp://35.222.33.58:1935/live/<stream-key>
```

Preview: Zixi HLS `http://35.222.33.58:7777/playback.m3u8?stream=…` or HTTP-TS.

See also [RTMP-STARTUP.md](./RTMP-STARTUP.md) for join-time tuning.

### MoQ / WebTransport — moqx relay

Requires `openmoq-publisher` (not plain ffmpeg to a URL):

```bash
./scripts/install-openmoq-publisher.sh
# Publish URL comes from the MoQ preset in the UI (WebTransport to moqx relay).
```

Use **Publisher → This machine** with the agent for orchestrated MoQ legs unless you
run `openmoq-publisher` yourself with the same ladder settings.

---

## OBS / hardware encoders

1. Set **output** to Custom… or ffmpeg URL matching the table above.
2. Match **keyframe interval** to the GOP from `/api/encode-profiles` (e.g. 4 s → 120 frames @ 30 fps).
3. For SRT: set **latency / buffer** ≥ 2000 ms (MediaMTX) or your target latency (Zixi).
4. Open the benchmark site, configure playback for the same ingest, and watch **TTFF / stalls / E2E** —
   upload charts will stay empty unless the agent is running.

---

## Related docs

- [LOCAL-PUBLISHER.md](./LOCAL-PUBLISHER.md) — orchestrated laptop ffmpeg (recommended)
- [RTMP-STARTUP.md](./RTMP-STARTUP.md) — RTMP join latency
- [METRICS.md](./METRICS.md) — what each chart measures
