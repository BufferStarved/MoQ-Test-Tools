# Operator E2E (camera + real Chrome)

This machine has no camera and headless Playwright cannot complete WebTransport.
Run these on the laptop that has Chrome + OBS / a webcam.

## Three commands

```bash
# 1) Camera-free gates (CI-safe; no ingest, no Zixi)
./scripts/run-regression.sh

# 2) Checklist + prod probes. Prints PASS / FAIL / NEED_HUMAN.
python3 scripts/e2e_operator_matrix.py

# 3) Optional: attach headed Chrome to a live MoQ job you already started
JOB=<id> HEADED=1 python3 scripts/e2e_operator_matrix.py --case cloud_moq
```

`OPEN=1` opens system Chrome instead of Playwright. `BASE_URL` defaults to
https://moq.sean-mccarthy.net. Do not set `START_JOB=1` while another ingest
matrix is running.

## Automated vs human

| Case | Verdict | What it covers |
|------|---------|----------------|
| `units` | automated | Track clone (WHIP not starved), publisher-ready before MoQ subscribe, WHEP 0–1 frames = fail, avfoundation 1080p60 fallback, jobError beats catalog-miss |
| `site_health` | automated | `GET /api/health` on prod |
| `browser4` | FAIL if deep-link broken; else NEED_HUMAN | Automated: `/?operator=browser4` must preselect Browser + 4 outputs. Human: camera + both MoQ tiles paint |
| `webcam` | NEED_HUMAN (+ camera/agent probe) | Script lists AVFoundation devices. This machine has none — run on the laptop with OBS / a webcam |
| `cloud_moq` | NEED_HUMAN (PASS if `JOB` + headed paint) | Real Chrome MoQ glass; ingest matrix also probes `/api/moq/probe` + openmoq recorder |
| `whip_muxer` | FAIL if no local WHIP muxer; else NEED_HUMAN | Automated: `ffmpeg -muxers` must list `whip`. Human: live webcam bitrate must not sit at ~30 kbps |

## Human clicks

**Browser 4-way** — or open the prefilled URL:

`https://moq.sean-mccarthy.net/?operator=browser4`

(`operator=` / `source=` need the current frontend. If the live site ignores them, use the clicks below.)

1. Source = **Browser**. Allow the camera.
2. Four outputs: Linode MoQ, Linode WebRTC, GCP East MoQ, GCP East WebRTC.
3. Start. Both MoQ tiles must paint. WHIP bitrate must not sit at ~30 kbps.
4. Failures must stay on the tile (not a catalog-miss).

**Webcam + local ffmpeg** — localhost only:

```bash
./scripts/dev.sh
```

Then `http://127.0.0.1:5173/?source=webcam`. Do not point the laptop
publisher at https://moq.sean-mccarthy.net.

**Cloud dummy MoQ** — Cloud playout, one MoQ output, real Chrome (not Cursor
WebView). Or attach: `JOB=<id>` as in command 3.

**Laptop WHIP muxer** — same agent as webcam, Source = Webcam, add a WebRTC
output. Bitrate must not collapse to ~30 kbps.
