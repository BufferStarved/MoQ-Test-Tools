# ffmpeg WHIP muxer dies on transient ENOBUFS

Why WHIP publishes from the laptop abort mid-stream while SRT and RTMP on the
same Wi-Fi link stay up, what the fix is, and how it was verified.

Companion to `docs/WEBRTC-ICE.md`, which rules out MediaMTX / ICE / firewall as
the cause. **This is not a server problem.** The origin
(`34.9.217.178`, `bluenviron/mediamtx:1.15.3`) advertises one ICE candidate and
establishes sessions in ~200ms.

> Status: **fixed and verified.** Under a forced queue-overflow, stock ffmpeg
> aborts after 2s and the patched build runs the full 120s three times over,
> with 133–236 successful retries logged per run. See "Results". An earlier
> round of runs is retracted — read "Retracted" before citing anything from
> before 21:45 on 2026-08-22.

## Symptom

```
[WHIP muxer] Failed to write packet=575B, ret=-55
[WHIP muxer] Failed to write packet, size=10791, ret=-55
[aost#0:1/libopus] Error submitting a packet to the muxer: No buffer space available
[out#0/whip] Task finished with error code: -55 (No buffer space available)
```

`-55` is `ENOBUFS` on Darwin (`python3 -c "import errno; print(errno.ENOBUFS)"`
→ 55). The publish does not merely stutter, it **terminates**.

The user-visible signature is misleading: writes degrade for several seconds
first, so the UI reports `fps=0`, `speed=0`, a live ffmpeg process and
`encode_lag_ms` climbing 1s per wall second, before ffmpeg finally exits. The
`Resumed reading ... after a lag of 5.690s` lines are the muxer thread back-
pressuring the input, not the network recovering.

## Root cause

Four facts compose into the bug. All line numbers are ffmpeg master
`45bc2518be`.

1. **`whip_write_packet` treats almost every error as fatal.** Only `EINVAL` is
   tolerated. `EAGAIN` gets a friendlier log line and then falls through to the
   same fatal path as everything else:

   ```c
   ret = ff_write_chained(rtp_ctx, 0, pkt, s, 0);
   if (ret < 0) {
       if (ret == AVERROR(EINVAL)) {
           av_log(whip, AV_LOG_WARNING, "Ignore failed to write packet=%dB, ret=%d\n", ...);
           ret = 0;
       } else if (ret == AVERROR(EAGAIN)) {
           av_log(whip, AV_LOG_ERROR, "UDP send blocked, please increase the buffer via -ts_buffer_size\n");
       } else
           av_log(whip, AV_LOG_ERROR, "Failed to write packet, size=%d, ret=%d\n", ...);
       goto end;
   }
   end:
       if (ret < 0)
           whip->state = WHIP_STATE_FAILED;   /* one transient errno kills the session */
   ```

2. **The real send site is `on_rtp_write_packet` (whip.c:1538)**, the avio write
   callback for each RTP stream. It calls `ffurl_write(whip->udp, ...)` and
   returns the raw error upward.

3. **WHIP opts out of ffmpeg's own retry.** `udp_connect` marks the socket
   non-blocking:

   ```c
   ff_socket_nonblock(ffurl_get_file_handle(whip->udp), 1);
   whip->udp->flags |= AVIO_FLAG_READ | AVIO_FLAG_NONBLOCK;
   ```

   It needs that for the read side, so `ffurl_read` returns `EAGAIN` instead of
   hanging. But `AVIO_FLAG_NONBLOCK` also short-circuits the generic retry loop
   in `retry_transfer_wrapper` (avio.c), which for blocking sockets *already*
   sleeps and retries on `EAGAIN`:

   ```c
   if (h->flags & AVIO_FLAG_NONBLOCK)
       return ret;              /* whip takes this branch */
   if (ret == AVERROR(EAGAIN)) {
       ...
       av_usleep(1000);         /* the retry whip never gets */
   }
   ```

   And `udp_write` skips its `ff_network_wait_fd(s->udp_fd, 1)` POLLOUT wait for
   the same reason. So a raw `send()` errno reaches whip.c unfiltered.

4. **`ENOBUFS` is handled nowhere in ffmpeg's networking code.** Not in the
   generic retry above, not anywhere else:

   ```
   $ grep -rn ENOBUFS libavformat/ libavutil/
   (no matches)
   ```

Net effect: a full interface transmit queue — routine on Wi-Fi, where the
driver queue is far smaller than a 720p keyframe burst of ~25 RTP packets —
returns `ENOBUFS` from one `send()`, and that single transient event
permanently fails the publish.

SRT and RTMP are immune for structural reasons: libsrt paces and retries in its
own sender, and RTMP is TCP so the kernel owns retransmission.

### Why `-ts_buffer_size` does not help

`ts_buffer_size` is passed to udp's `buffer_size`, which sets `SO_SNDBUF`. macOS
defaults that to 9216 bytes — smaller than a single 1280x720 keyframe (~30 KB).
Raising it to 8 MB changed nothing across repeated runs, which locates the
back-pressure *below* the socket buffer, in the driver's transmit queue. Worth
setting anyway as defence in depth, but it is not the fix.

## Upstream status

**Not fixed upstream as of master `45bc2518be`.** The fatal path quoted above is
verbatim from current master, and `ENOBUFS` appears nowhere in `libavformat` or
`libavutil`. Reviewed the full `whip.c` history since the muxer landed
(`git log --since=2025-01-01 -- libavformat/whip.c`, ~60 commits); the ones that
touch this area address adjacent concerns but not this bug:

| commit | what it did | why it does not fix this |
|---|---|---|
| `ec0a04de0d` | "remind user increase -buffer_size" | Adds the advisory log message only; still fails the session. |
| `b3793d9941` | pass `buffer_size` through to udp | Plumbs `SO_SNDBUF`, which is the wrong layer (see above). |
| `cc8f392136` | add `ts_buffer_size`, deprecate `buffer_size` | Rename of the same insufficient knob. |
| `25e710c61e` | force NONBLOCK for rtp | **Contributed to the bug** — this is what bypasses avio's retry. |
| `3c7315c345` | simplify the udp read in whip_write_packet | Read path only. |

So "upgrade ffmpeg" is not a remedy here; a patch is required.

## The fix

`tools/ffmpeg-whip/patches/` — see that directory's README for the patch series
and how to apply it. Two patches:

1. `avformat/whip: retry transient UDP send failures` — the actual fix. Adds a
   `whip_udp_write()` helper that retries on `EAGAIN`/`ENOBUFS` with a bounded
   sleep budget, mirroring the retry convention whip.c already uses on the read
   side (`ICE_DTLS_READ_MAX_RETRY` / `ICE_DTLS_READ_SLEEP_DURATION`) and what
   `retry_transfer_wrapper` does for blocking sockets. When the budget is
   exhausted the RTP packet is **dropped** rather than failing the session,
   which is correct for real-time media: RTP is lossy by design, the muxer's own
   RTX/NACK machinery can recover it, and if the link is genuinely dead the
   existing ICE consent-freshness timer (RFC 7675) terminates the session
   cleanly with `ETIMEDOUT`.
2. `avformat/network: map WSAENOBUFS to ENOBUFS` — one-line portability fix so
   the above also works on Windows, where `ff_neterrno()` currently returns the
   raw negated `WSAENOBUFS` instead of `AVERROR(ENOBUFS)`.

Deliberately *not* done: no new AVOption, no pacing scheduler, no change to the
default `ts_buffer_size`. Keeping it narrow makes it reviewable upstream.

## Reproducing and verifying

`scripts/whip-soak-test.sh` publishes a synthetic 1280x720p30 source at the
benchmark ladder's 2500k for a configurable duration and prints fps/speed at
20s/40s/60s/90s/120s checkpoints, plus a verdict line that distinguishes an
ENOBUFS abort from any other failure.

```bash
# baseline: stock Homebrew ffmpeg, dies in ~2s
LABEL=stock DURATION=120 SATURATE=pulse FFMPEG=/opt/homebrew/bin/ffmpeg \
  ./scripts/whip-soak-test.sh

# patched
LABEL=patched DURATION=120 SATURATE=pulse FFMPEG=tools/ffmpeg-whip/prefix/bin/ffmpeg \
  ./scripts/whip-soak-test.sh
```

`SATURATE=pulse` is what makes this a test rather than a coin flip — see
"Making the bug reproducible on demand" below. Without it the run depends on
the Wi-Fi queue happening to overflow, which on a good link it will not do.

Test over **Wi-Fi** (`en0`). The bug does not reproduce over Ethernet, so an
Ethernet-only pass proves nothing. The default target is now the dedicated path
`benchmark-whipsoak` rather than the shared `benchmark`, so soak runs cannot
collide with other workstreams.

## Verification

### Test conditions

| | |
|---|---|
| Date | 2026-08-22, 21:45–21:57 local (valid runs; see "Retracted" for 21:06–21:26) |
| Host | macOS (Apple silicon), `192.168.1.164` |
| Interface | **`en0` = Wi-Fi**, confirmed two ways (below) |
| Link | 802.11ax, 5 GHz ch 136 / 80 MHz, **−44 dBm**, MCS 11, 1200 Mbps PHY |
| Target | `http://34.9.217.178:8889/benchmark-whipsoak/whip` (GCP west, `bluenviron/mediamtx:1.15.3`) |
| Source | `testsrc2` 1280x720p30 + `sine` 48 kHz stereo |
| Encode | libx264 veryfast/zerolatency/baseline @ 2500k, GOP 60; libopus @ 64k |
| Cross-traffic | `SATURATE=pulse` — 1200B UDP at `192.168.1.1:39999`, 150ms burst / 1350ms gap |
| Power | `caffeinate -dims` for the whole run; every run gated on the host-freeze check |
| Stock | `/opt/homebrew/bin/ffmpeg` 8.1.2 |
| Patched | `tools/ffmpeg-whip/prefix/bin/ffmpeg` git-2026-08-22-1537c247fd (`279b504`) |

Interface was confirmed rather than assumed, because an Ethernet-only pass would
prove nothing:

```
$ route -n get 34.9.217.178 | grep interface
  interface: en0
$ networksetup -listallhardwareports | grep -A1 Wi-Fi
  Hardware Port: Wi-Fi
  Device: en0
```

`scripts/whip-soak-test.sh` now prints this `iface` line on every run, so each
log carries its own proof.

Binary provenance — the four patch log strings are present in the patched
binary and absent from stock:

```
$ strings tools/ffmpeg-whip/prefix/bin/ffmpeg | grep 'UDP send queue'
UDP send queue drained after %dms, size=%d
UDP send queue still full after %dms, size=%d
Skipped Consent Freshness check, UDP send queue full
$ strings /opt/homebrew/bin/ffmpeg | grep -c 'UDP send queue drained'
0
```

> **Note on the link quality.** −44 dBm at 1200 Mbps is an unusually *good*
> Wi-Fi link, which drains the transmit queue fast and makes the bug hard to
> provoke by waiting. Rather than treat a quiet run as a pass, the queue
> overflow is now *forced* (`SATURATE=pulse`, below) and retry-event counts are
> reported separately from mere survival.

## Retracted: the 21:06–21:26 runs were invalid

Three runs (one stock baseline, two patched) were recorded on 2026-08-22
between 21:06 and 21:26 against `…/benchmark/whip`. All three ended
`Consent Freshness expired … terminate session` → exit `-60`. **All three are
withdrawn. They measured the laptop's power management, not ffmpeg.**

An earlier revision of this document read *"Died at 37s of 120s requested. Exit
code −60"* and explained the exit as a transmit-queue backup wedging the send
path, which also starved the RFC 7675 consent-freshness requests. That
explanation was wrong, and the framing implied the bug had reproduced when the
script's own verdict said the opposite (`FAILED (rc=196), not the ENOBUFS
signature`, `retry path never engaged`).

What actually happened: **the Mac is lid-closed on AC and takes recurring
"Maintenance Sleep" naps.** A nap freezes every process and drops Wi-Fi, but on
Darwin `CLOCK_MONOTONIC` — what `av_gettime_relative()` reads — *keeps counting
across sleep*. So on wake, `whip_write_packet` compares `now` against a
`whip_last_consent_rx_time` from before the nap, finds it stale by the entire
nap, and terminates the session. Exit `-60` is `ETIMEDOUT` (errno 60 on Darwin),
not `ENOBUFS` (55).

Each stall matches a `pmset -g log` sleep event exactly:

| run | started | ffmpeg `Resumed reading … after a lag of` | `pmset -g log` |
|---|---|---|---|
| baseline (stock) | 21:06:22 | 26.890s | `21:06:31 Sleep 'Maintenance Sleep' … 27 secs` |
| patched 1 | 21:08:47 | 29.456s | `21:08:50 Sleep 'Clamshell Sleep' … 30 secs` |
| patched 2 | 21:10:46 | 900.113s | `21:10:58 Sleep 'Maintenance Sleep' … **901 secs**` |

The 900-second case settles it. No network fault suspends a process for fifteen
minutes and then lets it resume and shut down cleanly; a system sleep does
exactly that. Corroborating detail from the same logs: stderr contains **zero**
send errors of any kind — no `ret=-55`, no `ret=-35`, no `Failed to write
packet` — and the last `-progress` sample before the freeze was healthy
(`fps=27.52`, `speed=0.917x`). The muxer was not struggling. It was stopped.

Three things follow.

1. The `ETIMEDOUT` is a **host artifact**, not a MediaMTX, ICE, NAT or
   path-contention problem. The origin was never at fault, and no MediaMTX
   restart was needed or performed.
2. The two patched runs are **not evidence of the fix**. They never reached the
   retry path.
3. The claim that a wedged transmit queue starves consent checks is *plausible*
   — the patch does carry a `Skipped Consent Freshness check, UDP send queue
   full` log line for that interaction — but it is **not what these logs show**,
   and it should not be cited as though it were observed.

Mitigations, all now in `scripts/whip-soak-test.sh`:

- Runs execute under `caffeinate -dims`. Verified: 130s held with zero sleep
  events, on a machine that had been napping every 30–180s.
- Every run is gated by a **host-freeze check**. ffmpeg's own
  `Resumed reading … after a lag of Ns` line is an in-band freeze detector
  (~1.4s at startup is normal pipeline fill; seconds is a nap). Any run with
  >3s of lag is reported `RUN INVALID` and no other verdict is printed, so a
  nap can never again be mistaken for a network result. `pmset -g log` sleep
  events inside the run window are printed alongside as out-of-band
  confirmation.
- The default target moved to path **`benchmark-whipsoak`** so soak runs cannot
  collide with other workstreams using `benchmark`. MediaMTX accepts it (paths
  are created on demand; verified by a live publish).
- `-nostdin` with stdin from `/dev/null`, so a backgrounded run can never take
  `SIGTTIN`.

## Making the bug reproducible on demand

Waiting for `ENOBUFS` to happen by itself is not a test, it is a coin flip. At
−44 dBm / 1200 Mbps the transmit queue drains far too fast to overflow on a
2.5 Mbps publish. Two candidate levers were measured before picking one.

**Shrinking `SO_SNDBUF` does not work** — and measuring that is worth the space,
because it independently confirms the "Why `-ts_buffer_size` does not help"
section above. A nonblocking UDP socket to the WHIP host, `SO_SNDBUF` set the
way `udp.c:873` sets it from `-ts_buffer_size`, 400 × 1200-byte datagrams:

| `SO_SNDBUF` | sent | EAGAIN | ENOBUFS | EMSGSIZE |
|---|---|---|---|---|
| 512 | 0 | 0 | 0 | 400 |
| 1024 | 0 | 0 | 0 | 400 |
| 2048 | 400 | 0 | 0 | 0 |
| 4096 → 262144 | 400 | 0 | 0 | 0 |

Below the datagram size you get `EMSGSIZE` — a genuinely fatal, genuinely
different error that the patch deliberately does not retry. Above it,
*everything succeeds*. The socket send buffer never fills because a UDP
`sosend()` hands the datagram straight to `ip_output()` rather than queueing it.
That is precisely why `-ts_buffer_size` is the wrong knob.

**Saturating the interface transmit queue does work.** `ENOBUFS` is raised by
`ifnet_enqueue()` when the *driver* queue is full, so it can be provoked by
enqueuing faster than the radio drains. One second of full-rate 1200-byte
datagrams on `en0`:

| destination | sent | ENOBUFS | throughput |
|---|---|---|---|
| gateway `192.168.1.1` | 84,828 | **412,170** | 814 Mbps |
| WAN `34.9.217.178` | 101,234 | **388,266** | 972 Mbps |
| local dark IP | 0 | 0 | (`EHOSTDOWN`, unusable) |

79% of sends fail with `ENOBUFS` under saturation. So the script gained a
`SATURATE=pulse` mode: short UDP bursts at the **local gateway** — LAN-only, so
nothing is inflicted on the WAN or on the WHIP origin — with quiet gaps between
them. Pulsing rather than blasting continuously matters for two reasons: it
models the real failure (a keyframe burst meeting a briefly-full queue) instead
of a permanently dead link, and the gaps leave room for a retry to actually
succeed, which is what produces the `UDP send queue drained` evidence.

## Results

All runs 2026-08-22, `SATURATE=pulse` (150ms burst / 1350ms gap at the LAN
gateway), target `http://34.9.217.178:8889/benchmark-whipsoak/whip`, source
1280x720p30 @ 2500k, `-loglevel verbose`, under `caffeinate -dims`. Every run
below passed the host-freeze gate.

### Pilot pair — same conditions, opposite outcomes

| | stock 8.1.2 | patched `git-2026-08-22-1537c247fd` |
|---|---|---|
| survived | **2s** of 45s | **44s** of 45s |
| exit | `201` = `-55 ENOBUFS` | `0` |
| retry drained | 0 | **33** |
| verdict | ABORTED on ENOBUFS | PASS |

Stock, three seconds in:

```
[WHIP muxer] Failed to write packet=1194B, ret=-55
[WHIP muxer] Failed to write packet, size=29060, ret=-55
[vost#0:0/libx264] Error submitting a packet to the muxer: No buffer space available
[out#0/whip] Task finished with error code: -55 (No buffer space available)
```

`size=29060` is a keyframe — exactly the burst described under "Root cause".

Patched, same second, same queue-full condition, different outcome:

```
[WHIP muxer] UDP send queue drained after 2ms, size=42
[WHIP muxer] UDP send queue drained after 6ms, size=332
[WHIP muxer] UDP send queue drained after 1ms, size=1194
```

The retries succeed in 1–6ms, well inside the patch's 20ms budget, across the
full range of packet sizes (42B RTCP through 1194B RTP). The session does not
notice.

### Full battery

| run | binary | requested | survived | exit | drained | exhausted | dropped | verdict |
|---|---|---|---|---|---|---|---|---|
| stock 1 | 8.1.2 | 45s | **2s** | `-55` ENOBUFS | 0 | 0 | 0 | ABORTED |
| stock 2 | 8.1.2 | 45s | **2s** | `-55` ENOBUFS | 0 | 0 | 0 | ABORTED |
| patched pilot | patched | 45s | 44s | 0 | 33 | 0 | 0 | PASS |
| patched 1 | patched | 120s | **119s** | 0 | 236 | 4 | 4 | PASS |
| patched 2 | patched | 120s | **119s** | 0 | 199 | 0 | 0 | PASS |
| patched 3 | patched | 120s | **119s** | 0 | 133 | 4 | 4 | PASS |

Checkpoints for the three 120s patched runs, `out_time / fps / speed`:

| checkpoint | patched 1 | patched 2 | patched 3 |
|---|---|---|---|
| 20s | 20.5s / 29.78 / 0.993x | 20.6s / 29.89 / 0.996x | 20.9s / 29.67 / 0.989x |
| 40s | 40.8s / 30.38 / 1.01x | 40.8s / 30.37 / 1.01x | 40.8s / 30.38 / 1.01x |
| 60s | 61.0s / 30.26 / 1.01x | 60.9s / 30.25 / 1.01x | 60.9s / 30.25 / 1.01x |
| 90s | 90.6s / 30.17 / 1.01x | 90.6s / 30.17 / 1.01x | 90.6s / 30.17 / 1.01x |
| 120s | 120.0s / 30.09 / 1x | 120.0s / 30.09 / 1x | 120.0s / 30.09 / 1x |

`out_time` tracks the wall clock 1:1 and fps never leaves 30 — none of the fps
or speed decay from the "Symptom" section appears. Each 120s run absorbed 80
saturation bursts; the saturator's *own* sends were rejected 1.7–2.1M times per
run, so the queue was demonstrably full, repeatedly, throughout.

The second stock control died on a **212B** packet with `size=190` — audio, not
video. So the abort is not about keyframe size. Any packet that happens to meet
a full queue is enough, which is why the bug felt so arbitrary in the field.

### Verdict

Keeping the two claims separate, because only the second one is evidence:

- **Survived**: 3/3 patched runs completed the full 120s at 30fps / 1.01x.
- **Survived *and* demonstrably exercised the retry path**: also 3/3 —
  133–236 successful retries per run, logged by the patch itself.
- **Stock under identical conditions**: 2/2 aborted after 2s.

That is the bar the task set, and it is met. The abort is fixed.

Two of the three patched runs also exercised the *other* half of the patch: 4
packets each exceeded the 20ms budget and were dropped rather than fatal. The
checkpoint table shows no visible effect from those drops, which is the design
intent — RTP is lossy by contract and the muxer's RTX/NACK path can recover it.
Dropping a packet is a normal event; failing the session is not.

### What this does *not* establish

- The `Skipped Consent Freshness check, UDP send queue full` path never fired
  (0 across every run). That branch remains untested.
- macOS / arm64 / Wi-Fi, one host, one origin. Patch 2 (the `WSAENOBUFS` →
  `ENOBUFS` mapping) is **Windows-only and was never executed** — it is
  compile-checked reasoning, not a tested result.
- Longest run is 120s. Nothing here speaks to multi-hour stability.
- Congestion is synthetic. A pulsed UDP blaster at the gateway fills the same
  transmit queue as organic congestion, but it is not the same as a busy
  network, and the failure was induced rather than waited for.

## Using the patched binary

`find_ffmpeg()` in `src/moq_publish.py` already honours an `FFMPEG` environment
override ahead of every other candidate, so **no code change is required**:

```bash
export FFMPEG=/Users/sean/Developer/moq-test-tools/tools/ffmpeg-whip/prefix/bin/ffmpeg
```

**Do not set that globally yet.** This build was configured for the WHIP repro
and reports `http rtmp rtmps tcp udp` — **no `srt`**. The override short-circuits
`find_ffmpeg()` *before* its `_ffmpeg_has_srt_output()` check, so exporting it
process-wide would silently route SRT destinations to a binary that cannot speak
SRT. Either rebuild with `--enable-libsrt` before adopting it as the default, or
scope the override to WHIP publishes only. `tools/ffmpeg-whip/ffmpeg-src/` and
`tools/ffmpeg-whip/prefix/` are gitignored by design; rebuild from
`tools/ffmpeg-whip/patches/`.
