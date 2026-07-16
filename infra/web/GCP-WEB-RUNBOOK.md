# GCP MoQ Web App Runbook

Deploy the benchmark UI + API on a dedicated GCE VM in **us-central1**, served at
**https://moq.sean-mccarthy.net** with automatic Let's Encrypt HTTPS (Caddy).

This host runs **ffmpeg + openmoq-publisher** for uploads. Keep the MoQ relay and
ingest/Zixi worker on their existing VMs.

| Role | Host |
|------|------|
| Web UI + API (this) | `moq.sean-mccarthy.net` (new GCE VM) |
| MoQ relay | `34.28.164.90` / `34-28-164-90.sslip.io:4433` |
| Ingest agent + Zixi | `35.222.33.58:8090` |

## Prerequisites

- GCP project with Compute Engine API enabled (same project as relay/Zixi is fine)
- `gcloud auth application-default login`
- `terraform` >= 1.5
- SSH key at `~/.ssh/id_ed25519` (or `id_rsa`) that can reach the ingest worker
- Ability to create a DNS **A** record for `moq.sean-mccarthy.net`

## 1. Provision the VM

```bash
chmod +x infra/web/scripts/*.sh
./infra/web/scripts/gcp-deploy-vm.sh
```

Creates:

| Resource | Value |
|----------|--------|
| Instance | `moq-web-gcp` |
| Region / zone | `us-central1` / `us-central1-a` |
| Machine | `e2-standard-4` |
| Disk | 50 GB |
| Ports | TCP 22 (SSH), 80/443 (Caddy) |

Terraform prints `public_ip` and a DNS hint.

## 2. DNS (required for HTTPS)

Create an **A** record:

```text
moq.sean-mccarthy.net  →  <web-public-ip>
```

Wait until it resolves:

```bash
dig +short moq.sean-mccarthy.net
# must equal the terraform public_ip
```

Caddy will fail to obtain a certificate until this points at the VM and ports 80/443 are reachable from the internet.

## 3. Install the app

From your laptop (repo root), after DNS is set (or immediately if you will wait for cert retry):

```bash
./infra/web/scripts/install-web-app.sh <web-public-ip>
# optional domain override:
# ./infra/web/scripts/install-web-app.sh <web-public-ip> moq.sean-mccarthy.net
```

This script:

1. rsyncs the repo to `/opt/moq-test-tools` on the VM
2. Installs Node 22, Caddy, Python venv, ffmpeg (libvmaf via `install-ingest-vmaf.sh` when needed)
3. Installs `openmoq-publisher`
4. Builds the frontend (`web/frontend/dist`)
5. Writes `/etc/moq-web.env` including `INGEST_AGENT_TOKEN` from `ubuntu@35.222.33.58`
   and `ZIXI_API_*` from your local `.env` (required so each SRT push can reset Zixi’s HLS segmenter)
6. Enables `moq-web.service` (uvicorn on `127.0.0.1:8000`) and Caddy reverse proxy for HTTPS

Before install, put Zixi admin credentials in the repo `.env` (or export them):

```bash
ZIXI_API_BASE=http://35.222.33.58:4444
ZIXI_API_USER=admin
ZIXI_API_PASSWORD=<zixi-admin-password>
```

Optional — GCP Cloud Monitoring for relay/Zixi **server** CPU (MoQ prefers this over the ingest-agent host):

```bash
GCP_METRICS_PROJECT=<your-gcp-project-id>
GCP_METRICS_ZONE=us-central1-a
GCP_INSTANCE_ZIXI=moq-zixi-gcp
GCP_INSTANCE_MOQX=moq-relay-gcp
```

Grant the web VM service account **Monitoring Metric Viewer**. See `docs/METRICS.md`.

## 4. Verify

```bash
# Local API on the VM
ssh ubuntu@<web-public-ip> 'curl -fsS http://127.0.0.1:8000/api/health'

# Public HTTPS (after DNS + cert)
curl -fsS https://moq.sean-mccarthy.net/api/health
curl -fsSI https://moq.sean-mccarthy.net/ | head

# Open the UI
open https://moq.sean-mccarthy.net
```

Expect:

- `{"status":"ok"}` (or equivalent) from `/api/health`
- HTML from `/`
- UI can start MoQ + Zixi uploads with encoder + ingest VMAF

### Smoke test from the hosted UI

1. Open https://moq.sean-mccarthy.net
2. Run **GCP MoQ Relay** with encoder + ingest VMAF (≥20s)
3. Run **GCP Zixi** with encoder + ingest VMAF
4. Confirm both legs complete with scores in the summary

## 5. Operations

### Redeploy app code

```bash
./infra/web/scripts/install-web-app.sh <web-public-ip>
```

### Restart services

```bash
ssh ubuntu@<web-public-ip> 'sudo systemctl restart moq-web caddy'
```

### Logs

```bash
ssh ubuntu@<web-public-ip> 'sudo journalctl -u moq-web -n 80 --no-pager'
ssh ubuntu@<web-public-ip> 'sudo journalctl -u caddy -n 40 --no-pager'
```

### Refresh ingest token

Re-run `install-web-app.sh` (pulls token again), or:

```bash
TOKEN=$(ssh ubuntu@35.222.33.58 'sudo grep INGEST_AGENT_TOKEN /etc/moq-ingest-agent.env | cut -d= -f2')
ssh ubuntu@<web-public-ip> "sudo sed -i \"s|^INGEST_AGENT_TOKEN=.*|INGEST_AGENT_TOKEN=${TOKEN}|\" /etc/moq-web.env && sudo systemctl restart moq-web"
```

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Caddy cert fails | `dig +short moq.sean-mccarthy.net` equals VM IP; TCP 80/443 open; `journalctl -u caddy` |
| `/api/health` OK locally but HTTPS fails | DNS/cert only — API can still be up on `:8000` via localhost |
| Ingest VMAF unavailable | `/etc/moq-web.env` has `INGEST_AGENT_TOKEN`; VM can reach `http://35.222.33.58:8090` |
| MoQ publish fails / playback “no such namespace” | Publisher never reached relay. Check `journalctl -u moq-web` for `Exec format error` or `GLIBC_* not found`. On Ubuntu 22.04 the install script wraps the Linux binary with Docker (`ubuntu:24.04`). Confirm `openmoq-publisher --help` works as `ubuntu`, and UDP egress to relay `:4433`. |
| Encoder VMAF missing | `/usr/local/bin/ffmpeg -filters \| grep libvmaf`; re-run `infra/zixi/scripts/install-ingest-vmaf.sh` on the web VM |
| SPA shows API JSON at `/` | Frontend not built — `test -f /opt/moq-test-tools/web/frontend/dist/index.html` |

## Files

```text
infra/web/terraform/gcp/     Terraform (VM, firewall, static IP)
infra/web/scripts/             gcp-deploy-vm.sh, install-web-app.sh
infra/web/GCP-WEB-RUNBOOK.md   This document
```
