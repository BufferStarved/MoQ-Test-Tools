# WebRTC ICE on the MediaMTX origin

How `34.9.217.178` (`moq-web-gcp`, `bluenviron/mediamtx:1.15.3`, `/opt/moq-mediamtx`)
advertises ICE, why the logs look wrong when they are not, and what actually
breaks WHIP publishes from a laptop.

## The config that works

```yaml
webrtcLocalUDPAddress: :8189          # socket bind — must be an address WE own
webrtcAdditionalHosts: ["34.9.217.178"]   # what clients are told
webrtcIPsFromInterfaces: no          # do not leak lo / RFC1918 / docker0
```

These are three different jobs and only the middle one is about what goes on the
wire.

`webrtcAdditionalHosts` + `webrtcIPsFromInterfaces` are an **SDP rewrite**.
MediaMTX drops every gathered host candidate whose IP is not in the allow-list
(empty when `webrtcIPsFromInterfaces: no`) and splices in one synthetic host
candidate per additional host, reusing the UDP mux port
(`internal/protocols/webrtc/peer_connection.go`: `removeUnwantedCandidates`,
`addAdditionalCandidates`, `filterLocalDescription`). It is safe on any host.

`webrtcLocalUDPAddress` is **not** an advertisement. It goes straight to
`net.ListenPacket` (`internal/servers/webrtc/server.go`), and the error is
returned from `initialize()`, so a bad value makes MediaMTX exit *before* the
HLS, RTMP, SRT and RTSP servers ever start. The only symptom is "the whole site
is down".

## Do not bind the public IP

GCE gives the VM a 1:1 NAT. `34.9.217.178` is not on any local NIC:

```
$ ip -4 -o addr show          # on moq-web-gcp
lo    inet 127.0.0.1/8
ens4  inet 10.128.0.2/32
docker0 inet 172.17.0.1/16

$ python3 -c "import socket; socket.socket(socket.AF_INET, socket.SOCK_DGRAM).bind(('34.9.217.178', 18189))"
OSError: [Errno 99] Cannot assign requested address
```

So `webrtcLocalUDPAddress: 34.9.217.178:8189` is a guaranteed total outage on
this host. Linode differs — there the public IP *is* on `eth0` — which is why
`install-mediamtx.sh` bind-tests the value instead of assuming either way, and
falls back to `:8189` rather than shipping a config the host will reject.

## `local candidate: host/udp/127.0.0.1/8189` is cosmetic

This log line has now sent two debugging sessions down the wrong path
(2026-08-18, 2026-08-22). It is not a broken candidate pair.

MediaMTX rewrites the SDP, but the pion agent underneath still *gathers* a host
candidate for every local address — mediamtx even calls
`SetIncludeLoopbackCandidate(true)`. With the mux bound to wildcard, pion
enumerates `127.0.0.1`, `10.128.0.2` and `172.17.0.1`, and
`peer connection established, local candidate: …` prints whichever of those the
selected pair resolved to. None of them were ever offered to the client.

The line to trust is the **remote** candidate. If it is the peer's public
address, the pair is real and media is flowing:

```
peer connection established, local candidate: host/udp/127.0.0.1/8189,
                             remote candidate: prflx/udp/173.56.66.93/52801
```

To check what clients are actually told, ask the server (needs a live publisher):

```bash
curl -sS -X POST -H 'Content-Type: application/sdp' --data-binary @offer.sdp \
  http://34.9.217.178:8889/benchmark/whep | grep candidate
```

Verified 2026-08-22 — exactly one address, the public one:

```
a=candidate:3020637379 1 udp 2130706431 34.9.217.178 8189 typ host
a=candidate:3020637379 2 udp 2130706431 34.9.217.178 8189 typ host
a=end-of-candidates
```

## What actually kills laptop WHIP publishes: ENOBUFS

ICE was never the problem in job `c49d2ef4`. ffmpeg's WHIP muxer dies on a
transient socket error and reports it as a stall.

```
[WHIP muxer] Failed to write packet, size=10921, ret=-55
[aost#0:1/libopus] Error submitting a packet to the muxer: No buffer space available
[out#0/whip] Task finished with error code: -55 (No buffer space available)
Conversion failed!
```

`-55` is `ENOBUFS` from `sendto` on the macOS Wi-Fi socket. In
`libavformat/whip.c` (`whip_write_packet`) only `EINVAL` is tolerated; `EAGAIN`
gets a friendlier message and everything else falls through to
`whip->state = WHIP_STATE_FAILED`. There is no retry, so one transient
queue-full aborts the whole publish.

The visible symptom is misleading: writes stall for several seconds first, so the
UI sees `fps=0`, `speed=0`, a live process, and `encode_lag_ms` climbing 1s per
wall second, before ffmpeg finally exits.

Reproduced three times against the healthy origin (macOS 25.5, en0 = Wi-Fi,
ffmpeg 8.1.2, `testsrc2` 1280x720p30):

| bitrate | `-ts_buffer_size` | GOP | died at |
|---------|-------------------|-----|---------|
| 2500k   | default (-1)      | 60  | 42s     |
| 2500k   | 8 MB              | 60  | 19s     |
| 1000k   | 4 MB              | 120 | 40s     |

Neither lowering the bitrate nor raising the socket buffer helps. macOS defaults
`SO_SNDBUF` to 9216 bytes — smaller than a single 1280x720 keyframe (~30 KB, ~25
RTP packets) — but raising it did not change the outcome, so the back-pressure is
below the socket buffer, in the Wi-Fi driver's queue. SRT and RTMP on the same
link are unaffected: libsrt paces and retries, and RTMP is TCP.

Options, best first:

1. Publish WHIP over Ethernet, not Wi-Fi.
2. Patch `whip_write_packet` to retry on `ENOBUFS`/`EAGAIN` instead of failing,
   and send that upstream. This is the real fix.
3. Treat the laptop WHIP leg as best-effort in benchmark comparisons and surface
   the ffmpeg error instead of a silent `fps=0`.

## Firewall

UDP 8189 must be open or ICE never completes.

| Network | Rule | UDP 8189 |
|---------|------|----------|
| `moq-web-vpc` | `moq-web-mediamtx` | yes |
| `moq-web-vpc` | `moq-web-allow-mediamtx` | no (superseded by the above) |
| `moq-web-east-vpc` | `moq-web-east-allow-mediamtx` | yes |
| Linode | `linode_firewall.web` / `mediamtx-webrtc` | yes (terraform) |

Terraform for all three already declares it (`infra/web/terraform/gcp`,
`gcp-us-east1`, `linode`). No change was needed on 2026-08-22.
