# openmoq-recorder (Docker)

Post-relay MoQ subscriber for ingest VMAF. Subscribes to public **draft-18** moqx on
UDP **`:14433`** and writes CMAF fMP4 to disk.

Do **not** point this at leftover `moqx:329b98b` on UDP **`:4433`**. Do **not**
`docker pull openmoq-recorder` — that name is a local tag, not a registry image
(pull is denied). Build it on the ingest worker.

**Do not install Node/npm on the ingest worker for the recorder.** The image
builds on Linux amd64; the host wrapper is `bin/openmoq-fmp4-record`.

## One-time install (ingest worker)

Git checkouts omit vendored playa `dist/` (gitignored). The install script fills
`@moqt/{msf,transport,webtransport}` from the published npm tarballs before
`docker build`. A missing `…/webtransport/dist` fails BuildKit with
`failed to compute cache key`.

```bash
cd /opt/moq-test-tools
# Pin the public draft-18 relay for this region. Examples:
#   GCP Central:  https://34-28-164-90.sslip.io:14433/moq-relay
#   Dallas:       https://66-228-49-113.sslip.io:14433/moq-relay
sudo MOQ_RELAY_URL=https://34-28-164-90.sslip.io:14433/moq-relay \
  bash infra/zixi/scripts/install-openmoq-recorder.sh
curl -s http://127.0.0.1:8090/api/v1/health | python3 -m json.tool
docker images | grep openmoq-recorder
```

Health is honest only when **both** are true:

- `moq_recorder_available` / `moq_recorder_runtime_ok` — wrapper **and**
  `docker image inspect openmoq-recorder:latest`
- `docker images` shows `openmoq-recorder`

A wrapper on disk with no image used to advertise `available: true` and then fail
the job (`docker pull` denied).

`cert.mjs` does **not** apply the leftover `:4433` self-signed pin to port
**14433** (public Let's Encrypt). Pinning that hash onto `:14433` breaks the
WebTransport handshake (`Opening handshake failed`). MoQ ingest VMAF
subscribes from the central GCP web recorder (`34.9.217.178:8090`) — the
Dallas/Linode local image fails the same public URL.

## Linode Weblish (no SSH)

If `install-openmoq-recorder.sh` on the box predates
`scripts/ensure-openmoq-recorder-playa-dist.sh`, fill `dist/` first, one line
at a time:

```bash
rm -rf /tmp/moqt-webtransport && mkdir -p /tmp/moqt-webtransport /opt/moq-test-tools/web/frontend/vendor/moq-playa/packages/webtransport/dist && curl -fsSL https://registry.npmjs.org/@moqt/webtransport/-/webtransport-0.5.7.tgz | tar -xz -C /tmp/moqt-webtransport && cp -a /tmp/moqt-webtransport/package/dist/. /opt/moq-test-tools/web/frontend/vendor/moq-playa/packages/webtransport/dist/ && ls /opt/moq-test-tools/web/frontend/vendor/moq-playa/packages/webtransport/dist/index.js
```

Repeat for `msf` and `transport` if those `dist/index.js` paths are missing, then
re-run the install. Do not `docker pull`. Do not touch `:4433`.

## Manual build (dev)

```bash
cd /path/to/moq-test-tools
bash scripts/ensure-openmoq-recorder-playa-dist.sh
bash scripts/install-openmoq-recorder.sh
```

## Record manually

```bash
tools/openmoq-recorder/bin/openmoq-fmp4-record \
  https://34-28-164-90.sslip.io:14433/moq-relay \
  bench-abcdef12 \
  /var/lib/moq-relay-recordings/test.mp4 \
  --duration 30
```

Recordings for benchmark jobs: `/var/lib/moq-relay-recordings/<job_id>.mp4`
