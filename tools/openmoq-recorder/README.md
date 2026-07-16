# openmoq-recorder (Docker)

Post-relay MoQ subscriber for ingest VMAF. Subscribes to an OpenMOQ/moqx relay (draft 16) and writes CMAF fMP4 to disk.

**Do not install Node/npm on the ingest worker.** Build the image once on the worker (Linux amd64) and invoke it via the wrapper script.

## One-time install (GCP ingest worker)

```bash
cd ~/moq-test-tools
sudo bash infra/zixi/scripts/install-openmoq-recorder.sh
sudo systemctl restart moq-ingest-agent.service
curl -s http://127.0.0.1:8090/api/v1/health | python3 -m json.tool
# expect moq_recorder_available: true, moq_recorder_runtime_ok: true
```

Build takes ~5–15 minutes (downloads quiche prebuild inside Ubuntu 24.04 image; no host compile).

## Manual build (dev)

```bash
cd /path/to/moq-test-tools
cp tools/openmoq-recorder/.dockerignore .dockerignore
docker build -f tools/openmoq-recorder/Dockerfile -t openmoq-recorder:latest .
rm -f .dockerignore
tools/openmoq-recorder/bin/openmoq-fmp4-record-docker --probe
```

## Record manually

```bash
export MOQ_RELAY_CERT_SHA256=7115b12274dcf092c3e77d763111f0a2088a0f2029efc8e1f223a9584b1f5b54
tools/openmoq-recorder/bin/openmoq-fmp4-record \
  https://34-28-164-90.sslip.io:4433/moq-relay \
  bench-abcdef12 \
  /var/lib/moq-relay-recordings/test.mp4 \
  --duration 30
```

Recordings for benchmark jobs: `/var/lib/moq-relay-recordings/<job_id>.mp4`
