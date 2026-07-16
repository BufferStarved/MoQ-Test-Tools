# GCP OpenMOQ moqx Relay Runbook

Deploy a dedicated MoQ relay VM in **us-central1** (same region as Zixi) with **Let's Encrypt TLS** on a temporary **sslip.io** hostname. This avoids using `sean-mccarthy.net` until the main site is hosted there.

## Why sslip.io?

GCP VMs get a static public IP, not a managed hostname. Until you point a subdomain at the relay, we use:

```text
<IP-with-dashes>.sslip.io
```

Example: `35.222.33.59` → `35-222-33-59.sslip.io`

Let's Encrypt HTTP-01 validation works because sslip.io resolves to that IP.

## Prerequisites

- GCP project with Compute Engine API enabled (same project as Zixi is fine)
- `gcloud auth application-default login`
- `terraform` >= 1.5
- SSH key at `~/.ssh/id_ed25519.pub` (or `id_rsa.pub`)

## 1. Provision the VM

```bash
chmod +x infra/moqx/scripts/*.sh
./infra/moqx/scripts/gcp-deploy-vm.sh
```

This creates:

| Resource | Value |
|----------|--------|
| Instance | `moq-relay-gcp` |
| Region / zone | `us-central1` / `us-central1-a` |
| Machine | `e2-standard-4` |
| Ports | UDP 4433/4434 (QUIC), TCP 80 (certbot), TCP 8000 (admin) |

## 2. Install moqx with TLS

After terraform apply:

```bash
./infra/moqx/scripts/gcp-install-moqx.sh <relay-public-ip>
```

Verify:

```bash
curl http://<relay-ip>:8000/info
# {"service":"moqx","version":"..."}
```

Relay URLs (replace domain after deploy):

| Purpose | URL |
|---------|-----|
| Playback base (moq-js) | `https://<domain>:4433` |
| Fingerprint | `https://<domain>:4433/fingerprint` |
| Publish endpoint | `https://<domain>:4433/moq-relay` |
| Namespace | `benchmark` |

## 3. Update app presets

```bash
./infra/moqx/scripts/update-app-endpoints.sh <relay-public-ip>
```

Restart the dev stack (`./scripts/dev.sh`) so the API serves the new preset.

## 4. Web UI usage

1. Add or edit a stream on the **Benchmark** tab
2. Select protocol **MOQ (MoQT)**
3. Ingest endpoint auto-selects **GCP MoQ Relay**
4. Open the **Player** tab — moq-js connects via WebTransport

**Note:** MOQ upload pipes fragmented MP4 from ffmpeg into `openmoq-publisher`, which publishes to the relay over WebTransport. Install the publisher locally with `./scripts/install-openmoq-publisher.sh`.

Playback works via moq-js once a compatible publisher feeds namespace `benchmark`.

## 5. MoQ ingest VMAF (ingest worker, not relay)

The relay runs **moqx only**. Post-relay VMAF is handled by the shared GCP ingest worker
(`35.222.33.58`). See [GCP-ZIXI-RUNBOOK.md](../zixi/GCP-ZIXI-RUNBOOK.md) for worker setup.

The `moq_gcp_relay` preset publishes to this relay but routes ingest VMAF API calls to the
worker, which subscribes to the relay remotely per job namespace.

## 6. Domains

The **benchmark web app** is hosted at **https://moq.sean-mccarthy.net** (dedicated GCE VM).
See [GCP-WEB-RUNBOOK.md](../web/GCP-WEB-RUNBOOK.md).

When ready, point e.g. `relay.sean-mccarthy.net` at this relay IP, re-issue certs, and update
the `moq_gcp_relay` preset URL. Keep the web app on `moq.sean-mccarthy.net`.

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Certbot fails | Port 80 reachable from internet; domain resolves to VM IP |
| Player cannot connect | UDP 4433 open; browser supports WebTransport (Chrome/Edge). Relay must use an ECDSA cert ≤14 days with fingerprint pinning — run `configure-webtransport-cert.sh` on the VM. |
| `curl :8000/info` fails | `docker ps` on VM; `journalctl -u moqx` |
| No video | Relay needs an active MOQ publisher on namespace `benchmark` |

## Files

```text
infra/moqx/terraform/gcp/   Terraform (VM, firewall, static IP)
infra/moqx/cloud-init/        Bootstrap packages + ufw
infra/moqx/scripts/           deploy, install, endpoint update helpers
```
