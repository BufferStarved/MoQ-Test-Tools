# Go-live checklist (MOQ / SRT / RTMP)

Target: from the UI, upload **MoQ**, **SRT**, and **RTMP**, with browser playback and metrics including **post-ingest VMAF**.

## Presets (use these only)

| UI name | Preset ID | Protocol | Playback |
|---------|-----------|----------|----------|
| GCP MoQ Relay | `moq_gcp_relay` | MoQ | WebTransport player (Chrome/Edge) |
| GCP Zixi | `moq_zixi_gcp` | SRT | HLS `http://35.222.33.58:7777/playback.m3u8?stream=SRT%20Test` |
| GCP Zixi (RTMP) | `moq_zixi_gcp_rtmp` | RTMP | HLS `http://35.222.33.58:7777/playback.m3u8?stream=benchmark` |

Do **not** use AWS/Linode presets (coming soon).

## Morning boot (5 minutes)

```bash
# 1) Sync ingest token
cd ~/Developer/moq-test-tools
./scripts/sync-ingest-agent-env.sh

# 2) Confirm worker agent + recorder
ssh ubuntu@35.222.33.58 'curl -s http://127.0.0.1:8090/api/v1/health | python3 -m json.tool'
# Expect: status=ok, libvmaf_available=true, moq_recorder_available=true

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
ssh ubuntu@35.222.33.58 'ls -la /var/lib/moq-relay-recordings/ | tail'
# Need non-zero <job_id>.mp4
grep 'network host' ~/moq-test-tools/tools/openmoq-recorder/bin/openmoq-fmp4-record
sudo journalctl -u moq-ingest-agent.service -n 50 --no-pager
```

### SRT/RTMP ingest VMAF
- Zixi “Record to disk” must be on for the stream.
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

Last known good (2026-07-15 night): MoQ ingest VMAF **52.068** with **5.3 MB** post-relay recording; Zixi SRT ingest VMAF **~56–64**.
