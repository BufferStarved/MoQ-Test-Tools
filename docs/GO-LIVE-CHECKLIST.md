# Go-live checklist (MOQ / SRT / RTMP)

Target: from the UI, upload **MoQ**, **SRT**, and **RTMP**, with browser playback and metrics including **post-ingest VMAF**.

## Presets (use these only)

Public MoQ is draft-18 `:14433`. Do not point jobs or recorders at leftover `:4433`.

| UI name | Preset ID | Protocol | Playback |
|---------|-----------|----------|----------|
| GCP Central MoQ d18 | `moq_gcp_relay_d18` | MoQ | Playa WebTransport (Chrome/Edge) |
| Dallas MoQ d18 | `moq_linode_central_relay_d18` | MoQ | Playa WebTransport |
| GCP Central MediaMTX SRT | `moq_mediamtx_gcp_srt` | SRT | MediaMTX LL-HLS |
| GCP Central Zixi RTMP | `moq_zixi_gcp_rtmp` | RTMP | Zixi Fast HLS (`:7777`) |

Dallas / Fremont Zixi cells stay grey (not installed). Undeployed GCP West / AWS stay grey.

## Morning boot (5 minutes)

### Hosted UI (preferred for demos)

Public site: **https://moq.sean-mccarthy.net**  
Deploy/ops: [infra/web/GCP-WEB-RUNBOOK.md](../infra/web/GCP-WEB-RUNBOOK.md)

```bash
# 1) Confirm hosted API
curl -fsS https://moq.sean-mccarthy.net/api/health

# 2) Confirm worker agent + recorder image (wrapper-only is a false green)
ssh ubuntu@35.222.33.58 'curl -s http://127.0.0.1:8090/api/v1/health | python3 -m json.tool; docker images | grep openmoq-recorder'
# Expect: status=ok, libvmaf_available=true, moq_recorder_available=true,
# moq_recorder_runtime_ok=true, moq_relay_url ends in :14433/moq-relay,
# and docker images lists openmoq-recorder. Do not docker pull that tag.

# 3) Open the UI
open https://moq.sean-mccarthy.net
```

### Local stack (development)

```bash
# 1) Sync ingest token
cd ~/Developer/moq-test-tools
./scripts/sync-ingest-agent-env.sh

# 2) Confirm worker agent + recorder image (wrapper-only is a false green)
ssh ubuntu@35.222.33.58 'curl -s http://127.0.0.1:8090/api/v1/health | python3 -m json.tool; docker images | grep openmoq-recorder'

# 3) Start stack (API + UI)
./scripts/dev.sh
# API http://127.0.0.1:8000  UI http://127.0.0.1:5173
# If vite missing: npm install --prefix web/frontend

# 4) Optional automated gate
python3 scripts/go-live-overnight.py
```

## UI run (each protocol)

For **each** of MoQ / SRT / RTMP:

1. Select the GCP preset above.
2. Enable **encoder VMAF** and **ingest VMAF**.
3. Duration ≥ 20s (30s safer for HLS spin-up).
4. Start upload.
5. Confirm live preview:
   - **MoQ:** Chrome/Edge only; wait for catalog/frames (not Safari/Cursor WebView).
   - **SRT/RTMP:** HLS preview against Zixi `:7777` (browsers cannot play raw SRT/RTMP).
6. After complete, confirm summary shows:
   - Encoder VMAF score
   - Ingest VMAF score
   - Encode metrics (bitrate/fps) with samples > 0
   - MoQ `latency_encode_ms` is a real number (file-source must not wipe it to 0)
   - HLS legs report `latency_segmentation_ms` (LL-HLS 200 ms / Fast HLS 2 s)
   - Zixi RTMP `encoded_bitrate_kbps` / `net_send_mbps` are ~encode rate, not 0
   - Zixi Fast HLS playhead is not frozen near 35 rendered frames (1-deep live sync)

## Success criteria

| Check | MoQ | SRT | RTMP |
|-------|-----|-----|------|
| Upload completes | required | required | required |
| Encoder VMAF | required | required | required |
| Ingest / post-relay VMAF | required (Docker recorder) | required (Zixi disk) | required (Zixi disk) |
| Browser playback during run | WebTransport frames | HLS playlist/segments | HLS playlist/segments |
| Metric samples | ≥ ~duration seconds | same | same |

## If something fails

### MoQ ingest VMAF
```bash
# Need a local image, not a registry pull. Handshake fail on :14433 is usually
# leftover :4433 cert pin — cert.mjs must skip port 14433.
ssh ubuntu@35.222.33.58 'docker images | grep openmoq-recorder; ls -la /var/lib/moq-relay-recordings/ | tail'
grep 'network host' /opt/moq-test-tools/tools/openmoq-recorder/bin/openmoq-fmp4-record
sudo journalctl -u moq-ingest-agent.service -n 50 --no-pager
```
Build (never `docker pull`): `sudo bash infra/zixi/scripts/install-openmoq-recorder.sh`.
Git checkouts lack playa `dist/`; the install script fetches `@moqt/*` npm tarballs.
See [tools/openmoq-recorder/README.md](../tools/openmoq-recorder/README.md).

### SRT/RTMP ingest VMAF
- MediaMTX SRT ingest VMAF is **not supported** — skip is honest, not a silent null.
- Zixi RTMP: the job manager starts HTTP-TS capture **during** the job
  (`ingest_agent/ts_capture.py`). After-the-fact `/<stream>.ts` is empty 200.
- Colocated agent must pull `http://127.0.0.1:7777/<stream>.ts` (avoid hairpin).
- Agent recording dir for these presets: `/opt/zixi_broadcaster-linux64`
- Health: `curl -s http://35.222.33.58:8090/api/v1/health` (from Mac may need SSH)

### Playback
- MoQ: cert fingerprint rotation → restart API after cert change.
- SRT stream id must be `SRT Test`; RTMP stream id must be `benchmark`.
- HLS 404 → Zixi HLS output not configured / wrong stream name.

### UI won’t start
```bash
npm install --prefix web/frontend
./scripts/dev.sh
# Or API only:
source .venv/bin/activate
export PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PWD/tools/openmoq-publisher/bin:$PATH"
export PYTHONPATH="$PWD/src:$PWD/web/api"
set -a; source .env; set +a
uvicorn main:app --host 127.0.0.1 --port 8000 --app-dir web/api
```

## Overnight automation

```bash
python3 scripts/go-live-overnight.py
# Writes results/go-live-YYYYMMDD-HHMMSS.json
```

Last headed file-source gate (2026-08-26): MoQ GCP/Dallas encode + playa paint PASS;
encoder VMAF scored. Ingest VMAF / Zixi bitrate / Fast HLS playhead needed the
fixes in this tree — re-run after deploy:

```bash
BASE_URL=https://moq.sean-mccarthy.net python3 scripts/qa_metric_audit.py --assert <job-ids>
```
