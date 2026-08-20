# MoQ draft-18 branch

Working branch: `feat/moq-draft-18`. **Do not merge to `main` or deploy to prod** until a draft-18 relay is live. Prod `ghcr.io/openmoq/moqx:329b98b` only forwards **draft-16**. Offering `moqt-18` against that relay has already produced WebTransport-ready sessions whose SUBSCRIBE never reached the publisher (jobs `d32a5e99`, `0840ceff`, `2765cdee`).

IETF newest is [draft-ietf-moq-transport-19](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/) (July 2026). OpenMOQ + vendored `@moqt/playa` top out at **18**. This branch targets 18, not 19.

## What already flipped

| Layer | File | Change |
|---|---|---|
| ffmpeg → publisher `--draft` | `src/moq_publish.py` `DEFAULT_MOQ_DRAFT` | 16 → 18 |
| Browser publisher ALPN | `web/frontend/src/browserMoq/moqtVersions.ts` | offer `[18]` |
| Browser LOC session | `web/frontend/src/browserMoq/moq5Service.ts` `RELAY_DRAFT` | 18 |
| Player subscribe | `MoqPlayer.tsx` / `StreamPlayer.tsx` / `App.tsx` | default 18 |
| Preset copy | `src/destinations.py` | “draft 18” |

Playa already has draft-18 wire code (`adapter-d18-loopback.test.ts`, `track-properties-18`). The gap is **relay + publisher handshake**, not the TypeScript decoder.

## Remaining blockers (in order)

1. **Relay** — canary or replace `329b98b` with a moqx that advertises `moqt-18` and forwards SUBSCRIBE. Until then every publish on this branch will fail the same way as the old 18 experiments.
2. **openmoq-publisher** — prod is pinned to **v0.3.2** because v0.3.4+ broke WebTransport CONNECT against current moqx. Draft-18 likely needs a newer moqxr **and** a matching moqx; bump only after `scripts/smoke-openmoq-publisher.sh` PASSes.
3. **moq5 / libmoq** — experimental `moq5-fmp4-publish` is not the known-good catalog path (`vide_1`/`soun_2`). Confirm it negotiates 18 before using it as the default backend.
4. **Catalog / MSF** — still draft-ietf-moq-msf. Draft-18 transport does not by itself change CMAF vs LOC packaging.
5. **Recorder** — `openmoq-fmp4-record` on the ingest worker must subscribe draft-18 or VMAF/record jobs go dark.

## Current encode path (not a native ffmpeg MoQ muxer)

There is **no** `-f moq` in stock ffmpeg. Two pipes are easy to confuse:

```
camera  →  ffmpeg  →  MPEG-TS over UDP  (webcam_broker fan-out only)
                ↓
per MoQ job:  ffmpeg reads TS  →  H.264/AAC  →  fragmented MP4 on stdout
                ↓
openmoq-publisher parses ftyp+moov+moof/mdat  →  MoQ CMAF objects on WebTransport
```

The TS hop is **sibling-job fan-out**, not the MoQ object format. MoQ objects are **CMAF fragments** (`frag_keyframe+empty_moov+…` in `build_ffmpeg_moq_cmd`). Browser MoQ skips ffmpeg entirely and publishes **LOC** via `@moqt/webtransport`.

Costs of the TS + fMP4 pipe:

- Second encode (UDP TS is already x264; MoQ encodes again).
- GOP = MoQ group (`frag_keyframe`); join latency is fragment duration.
- Publisher must see `ftyp+moov` before CONNECT is useful; Docker buffering already bit us (`e993ffb`).
- No capture timestamp on CMAF (LOC has it) — glass delay is estimated.

## What “native ffmpeg” would actually mean

Stock libavformat has no MoQ muxer and no WebTransport protocol. Realistic options:

| Approach | What you still pipe | Speaks IETF draft-18? | Effort |
|---|---|---|---|
| **A. Keep ffmpeg, upgrade publisher+relay** (this branch) | fMP4 → stdin | Only if moqxr/moqx do | Small, blocked on relay |
| **B. ffmpeg annex-B / raw → libmoq / moq5** | elementary stream, not TS | If libmoq is on 18 | Medium; drops CMAF catalog compatibility with playa’s `vide_1` path |
| **C. [moq-cli](https://github.com/moq-dev/moq) / hang** | ffmpeg still used as encoder; CLI muxes to MoQ | **moq-lite**, not full IETF 18 | Medium; different catalog; playa may not subscribe |
| **D. ffmpeg `-f moq` muxer** | none | You would own draft churn in C | Large; QUIC + WT + SETUP/SUBSCRIBE in libavformat; do not start here |

There is no path where unmodified Homebrew/BtbN ffmpeg opens WebTransport and emits MoQ objects.

A useful intermediate (not D): **one encode, fMP4 stdout, no TS tee** when the run has a single MoQ output (skip `webcam_broker` MPEG-TS). That is still not native MoQ; it removes a remux hop.

## Suggested next slices on this branch

1. Stand up a **draft-18 moqx canary** (unused ports, same pattern as `scripts/canary-moqx.sh`) — do not replace `:4433`.
2. Smoke openmoq-publisher `--draft 18` against that canary (`scripts/smoke-openmoq-publisher.sh`).
3. Point this branch’s default relay URL at the canary only.
4. Headed Chrome: browser LOC + cloud CMAF both `draft=18`.
5. Only then consider dropping the MPEG-TS fan-out for MoQ-only runs.
