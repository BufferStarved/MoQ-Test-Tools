# MoQ draft-18 branch

Working branch: `feat/moq-draft-18`. **Do not merge to `main`.** **Do not deploy this branch as the only MoQ path on https://moq.sean-mccarthy.net.** Prod `ghcr.io/openmoq/moqx:329b98b` on UDP **4433** only forwards **draft-16**. Offering `moqt-18` against that relay has already produced WebTransport-ready sessions whose SUBSCRIBE never reached the publisher (jobs `d32a5e99`, `0840ceff`, `2765cdee`).

IETF newest is [draft-ietf-moq-transport-19](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/) (July 2026). OpenMOQ + vendored `@playa/player` top out at **18**. This branch targets 18, not 19.

## Operator map (prod vs canary)

| | Prod (leave running) | Draft-18 canary |
|---|---|---|
| VM | `moq-relay-gcp` | same VM, second container |
| Container | `moqx` | `moqx-canary` |
| Image | `ghcr.io/openmoq/moqx:329b98b` | `ghcr.io/openmoq/moqx:88f9d27` (or `MOQX_CANARY_IMAGE`) |
| WebTransport | `https://34-28-164-90.sslip.io:4433/moq-relay` | `https://34-28-164-90.sslip.io:14433/moq-relay` |
| Admin `/info` | TCP 8000 (may be public) | TCP **18000**, localhost / SSH hop only |
| UI preset | `moq_gcp_relay` | `moq_gcp_relay_d18` |
| Ingest dropdown | OpenMOQ · GCP us-central1 | **OpenMOQ draft-18 canary · GCP us-central1** |
| Publisher | `openmoq-publisher` (auto) | **`moq5-fmp4-publish` only** |
| Playa `draftVersion` | 16 | **18** |
| Firewall | existing `moq-relay-allow-relay` UDP 4433/4434 | `moq-relay-allow-canary-d18` UDP 14433/14434 |

East / Linode use the same canary pattern on **their** relay VMs (`moq-relay-east-gcp`, Linode relay). Prod `:4433` on those hosts stays draft-16. Dest presets: `moq_gcp_east_relay_d18`, `moq_linode_relay_d18`.

Overnight 2026-08-20 canary status (prod `moqx` / `:4433` / `329b98b` untouched on all three):

| Site | WT canary | Image | LE cert | Public UDP 14433 |
|---|---|---|---|---|
| West `moq-relay-gcp` | `https://34-28-164-90.sslip.io:14433/moq-relay` | `88f9d27` | yes | GCP fw `moq-relay-allow-canary-d18` |
| East `moq-relay-east-gcp` | `https://34-138-137-211.sslip.io:14433/moq-relay` | `88f9d27` | yes (`/etc/letsencrypt/live/34-138-137-211.sslip.io/`) | GCP fw `moq-relay-east-allow-canary-d18` |
| Linode `45.79.177.85` | `https://45-79-177-85.sslip.io:14433/moq-relay` | `88f9d27` | yes (`/etc/letsencrypt/live/45-79-177-85.sslip.io/`) | **blocked** — Linode cloud fw is DROP and only allows UDP `4433,4434`. Container is up locally. No `LINODE_TOKEN` / linode-cli; do not terraform apply. |

Start east:

```bash
GCP_ZONE=us-east1-b \
MOQX_CANARY_INSTANCE=moq-relay-east-gcp \
MOQX_CANARY_HOST=34-138-137-211.sslip.io \
MOQX_CANARY_FIREWALL=moq-relay-east-allow-canary-d18 \
./scripts/canary-moqx.sh start
```

That start needs a Let's Encrypt cert at `/etc/letsencrypt/live/<sslip>/` on the VM (same as west). Do not issue certs by stopping prod. Port 80 must be free.

TLS: canary mounts the same Let's Encrypt cert at `/etc/letsencrypt/live/34-28-164-90.sslip.io/`. Chrome playa uses the **public trust store** on this path (no `serverCertificateHashes` — LE certs are >14 days). Prod `:4433` still hash-pins the short-lived `wt-certs` bundle.

## Start / stop canary

From a laptop with `gcloud` + IAP SSH:

```bash
# Creates firewall moq-relay-allow-canary-d18 if missing, opens ufw 14433/udp, starts moqx-canary.
./scripts/canary-moqx.sh start

./scripts/canary-moqx.sh status
./scripts/canary-moqx.sh stop          # does not touch prod moqx / :4433
```

Probe admin (SSH hop):

```bash
gcloud compute ssh ubuntu@moq-relay-gcp --zone=us-central1-a --tunnel-through-iap \
  --command='curl -fsS http://127.0.0.1:18000/info; echo'
```

`/info` only prints `service` + `version` (no draft field). Confirm draft with `/config`:

```bash
gcloud compute ssh ubuntu@moq-relay-gcp --zone=us-central1-a --tunnel-through-iap \
  --command='curl -fsS http://127.0.0.1:18000/config' \
  | python3 -c 'import json,sys; c=json.load(sys.stdin); print(c["listeners"][0]["moqt_versions"])'
```

Expect `16,14,18`. Do **not** put a known-16-only image on `:4433`.

## Publisher (moq5)

The web API on `34.9.217.178` publishes from that VM. `install-web-app.sh` rsync-excludes `tools/moq5`, so the library must be **built on the web VM**:

```bash
# On 34.9.217.178, as the moq-web user, from /opt/moq-test-tools:
./scripts/install-moq5.sh
# Binary: /opt/moq-test-tools/tools/moq5-publisher/bin/moq5-fmp4-publish
```

Do **not** set `MOQ_PUBLISHER_BACKEND=moq5` in `/etc/moq-web.env`. The canary preset forces moq5 in code (`moq_publisher_backend_for_preset`). Prod stays `auto` → openmoq.

Manual publish (once the binary exists):

```bash
ffmpeg -re -i media/bbb.mp4 -map 0:v:0 -map 0:a:0? -c:v libx264 -c:a aac \
  -movflags +frag_keyframe+empty_moov+default_base_moof+separate_moof -f mp4 pipe:1 \
| ./tools/moq5-publisher/bin/moq5-fmp4-publish \
    https://34-28-164-90.sslip.io:14433/moq-relay bench-d18 --duration 30
```

## Local UI (do not replace the public demo)

```bash
./scripts/dev.sh
```

Benchmark tab → protocol **MoQ** → ingest **OpenMOQ draft-18 canary · GCP us-central1**. Headed Chrome playa uses `draftVersion: 18` for that preset only. Public https://moq.sean-mccarthy.net stays on `main` / draft-16 / `:4433`.

Laptop publisher binary (already present): `tools/moq5-publisher/bin/moq5-fmp4-publish` (Mach-O). Web VM Linux ELF: `/opt/moq-test-tools/tools/moq5-publisher/bin/moq5-fmp4-publish`.

## Smoke so far (2026-08-20)

- Canary `/config` listener `relay-mvfst` `0.0.0.0:14433` reports `moqt_versions=16,14,18`, `insecure=false`, LE cert mounted.
- `/info` has no draft field (`{"service":"moqx","version":"v0.2.1-95-g88f9d27b",...}`). Prod `/info` is `0.1.0`. Prod `/config` also lists `16,14,18` — that string alone is **not** proof of working 18 forwarding (historical SUBSCRIBE failures on `329b98b`). The canary is a newer binary; treat playa subscribe as the real proof.
- Three `moq5-fmp4-publish` runs from `moq-web-gcp` announced namespaces (`moqx_subPublishNamespaceSuccess_total=3`, tracks `vide_1` / `soun_2`, publisher exit 0). Headed Chrome playa subscribe was **not** completed here.
- Overnight `moq_link_spike` / `ffmoq` to west `:14433`: catalog + audio objects left the publisher (`live: sent track=soun_2`). Video GOPs still hit `WOULD_BLOCK` on some fixtures. Headed playa remains the subscribe proof.
- Local patched ffmpeg (`tools/ffmpeg-moq/prefix/bin/ffmpeg`, Homebrew `/opt/homebrew/bin/ffmpeg` untouched) listed `moq` and published `ffmoq-d18-overnight-*` to west `:14433` (catalog + audio sent; video `WOULD_BLOCK`).

Next (local UI, does not touch prod):

```bash
./scripts/dev.sh
# Chrome → Benchmark → MoQ → "OpenMOQ draft-18 canary · GCP us-central1" → Start
```

Keep a realtime publish up while playa joins (from the web VM or laptop):

```bash
ffmpeg -re -f lavfi -i testsrc=size=640x360:rate=30 -f lavfi -i sine=frequency=1000:sample_rate=48000 \
  -t 60 -map 0:v:0 -map 1:a:0 -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 30 \
  -c:a aac -ar 48000 -ac 2 -movflags +frag_keyframe+empty_moov+default_base_moof+separate_moof \
  -f mp4 pipe:1 \
| ./tools/moq5-publisher/bin/moq5-fmp4-publish \
    https://34-28-164-90.sslip.io:14433/moq-relay bench-d18 --duration 60
```

## What already flipped on this branch

| Layer | File | Change |
|---|---|---|
| ffmpeg → publisher `--draft` | `src/moq_publish.py` `DEFAULT_MOQ_DRAFT` | 16 → 18 (canary URL also sets `draft=18`) |
| Canary preset | `src/destinations.py` `moq_gcp_relay_d18` | `:14433`, forces moq5 |
| Browser publisher ALPN | `web/frontend/src/browserMoq/moqtVersions.ts` | offer `[18]` (in-page publisher on canary ingest) |
| Player subscribe | `MoqPlayer` via `moqDraftForIngest` | 18 on canary, 16 on prod ingest |
| Playa vendor | `web/frontend/vendor/moq-playa` | `@playa/player`; default in package is 16, we pass 18 |

## Remaining blockers

1. **Playa subscribe** — canary `/config` lists draft 18; moq5 announced 3 namespaces. Confirm headed Chrome `@playa/player` `draftVersion: 18` actually renders. Never swap `:4433`.
2. **openmoq-publisher** — not used on the canary path (moq5 only). Prod stays pinned to **v0.3.2**.
3. **moq5 catalog** — `moq5-fmp4-publish` advertised `vide_1`/`soun_2` in the smoke; still experimental vs openmoq catalog options.
4. **Catalog / MSF** — still draft-ietf-moq-msf.
5. **Recorder** — `openmoq-fmp4-record` on the ingest worker must subscribe draft-18 or VMAF/record jobs on the canary go dark.

## Current encode path (not a native ffmpeg MoQ muxer)

There is **no** `-f moq` in stock ffmpeg. Canary path:

```
camera/file  →  ffmpeg  →  fragmented MP4 on stdout
                ↓
moq5-fmp4-publish  →  MoQ objects on WebTransport (ALPN moqt-18)
                ↓
playa (@playa/player, draftVersion: 18)
```

Native (libavformat + OpenMOQ moq5, one process) is `ffmoq` — remux only today.
In-tree `moq:` protocol: `./scripts/build-ffmpeg-libmoq.sh`. See
[`docs/FFMPEG-MOQ-NATIVE.md`](FFMPEG-MOQ-NATIVE.md). Do not change the live
canary pipe until headed playa on `:14433` is green.

Prod path on `:4433` is still ffmpeg → `openmoq-publisher` → draft-16 moqx.
