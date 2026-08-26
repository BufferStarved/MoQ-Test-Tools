# ffmpeg WHIP ENOBUFS patch series

Two patches against ffmpeg master that stop the WHIP muxer from killing a
publish when the OS transmit queue is momentarily full.

The root-cause analysis lives in [`docs/WEBRTC-WHIP-ENOBUFS.md`](../../../docs/WEBRTC-WHIP-ENOBUFS.md).
Read that first; this file only covers the patches themselves and how to
apply them.

## The patches

### `0001-avformat-whip-retry-transient-UDP-send-failures.patch`

The fix. `whip_write_packet` tolerates only `EINVAL`; every other error sets
`WHIP_STATE_FAILED` and terminates the session. Nothing below the muxer
absorbs a transient send failure either, because `whip_open` sets
`AVIO_FLAG_NONBLOCK` on the udp context — needed so the read side does not
stall the muxer thread, but it also makes `retry_transfer_wrapper` hand back
the raw errno instead of running its sleep-and-retry loop, and makes
`udp_write` skip its `POLLOUT` wait.

This adds `whip_udp_write()`, which retries `EAGAIN` and `ENOBUFS` on a
bounded sleep budget (`UDP_WRITE_MAX_RETRY` × `UDP_WRITE_SLEEP_DURATION` =
20 × 1ms), mirroring the convention the read side already uses with
`ICE_DTLS_READ_MAX_RETRY` / `ICE_DTLS_READ_SLEEP_DURATION`. The budget is
capped below one frame interval at 30fps so that waiting for the queue to
drain cannot itself become a source of back pressure.

All five `ffurl_write(whip->udp, ...)` call sites route through the helper.
Behaviour when the budget is exhausted differs by caller:

| call site | on exhausted budget |
|---|---|
| `on_rtp_write_packet` | drop the packet, return 0 — the session survives |
| consent freshness in `whip_write_packet` | skip the check, leave `whip_last_consent_tx_time` alone so the next packet retries |
| `handle_rtx_packet` | existing "skip this one" warning, unchanged |
| STUN binding request / response | propagate, as before — these are handshake-time |

Dropping the RTP packet is the right trade for real-time media: RTP is lossy
by design, video packets are stored in the RTX history *before* the send so a
receiver can still recover them with a NACK, and a link that is genuinely
gone is still terminated cleanly by the ICE consent-freshness timer
(RFC 7675).

### `0002-avformat-network-map-WSAENOBUFS-to-ENOBUFS.patch`

Portability. `ff_neterrno()` maps the winsock codes it knows to errno values
and negates the rest, and `WSAENOBUFS` is not in that list — so on Windows a
full transmit queue arrives as `-WSAENOBUFS`, and the `AVERROR(ENOBUFS)` test
in patch 1 would silently never match. Adds the `case` to the switch in
`network.c` and, following what is already done for `ETIMEDOUT` and friends,
an `#ifndef ENOBUFS` fallback in `network.h` for toolchains that do not
declare it.

This patch is Windows-only in effect. Patch 1 is complete without it on
Unix, where `ff_neterrno()` is `AVERROR(errno)`.

## Scope

Deliberately narrow, to stay reviewable upstream: no new AVOption, no pacing
scheduler, no change to the default `ts_buffer_size`. Raising
`ts_buffer_size` is not an alternative fix — it sets `SO_SNDBUF`, and the
back pressure is *below* the socket buffer, in the driver transmit queue.

## Applying

Generated with `git format-patch`, so `git am` is the intended path:

```bash
cd tools/ffmpeg-whip/ffmpeg-src
git am ../patches/*.patch
```

Or without a git checkout:

```bash
patch -p1 < ../patches/0001-avformat-whip-retry-transient-UDP-send-failures.patch
patch -p1 < ../patches/0002-avformat-network-map-WSAENOBUFS-to-ENOBUFS.patch
```

### Baseline

Generated against ffmpeg master `b79d4c4c0a`. The analysis in the spec was
done against `45bc2518be`, which is two commits earlier; neither `whip.c`,
`network.c` nor `network.h` changed in between, so the two are equivalent for
this series.

## Verifying that the retry actually fired

The retry is observable by design — a fix that silently does nothing looks
identical to a fix that works.

- Retry engaged and the queue drained: `UDP send queue drained after Nms,
  size=...` at `AV_LOG_VERBOSE`. Run ffmpeg with `-loglevel verbose` to see
  it. This is the line that proves the patch is doing something; it is
  verbose rather than a warning because a recovered send is not a problem.
- Budget exhausted and a packet was dropped: `UDP send queue still full after
  20ms, size=...` plus `Dropped packet=NB, UDP send queue full`, both at
  `AV_LOG_WARNING`, so they show at the default log level.

A soak run that survives with neither line present has not exercised the bug,
and proves nothing. Test over Wi-Fi (`en0`); the failure does not reproduce
reliably over Ethernet.

## Upstream

Not yet submitted. Both patches are written to upstream conventions
(`avformat/<file>:` subject prefix, rationale in the body) so they can be
sent to ffmpeg-devel as-is.
