# Linode mirror stack (GCP parity)

Replicate the hosted benchmark stack on Linode so users can pick **GCP us-central1** or **Linode** per stream in the UI.

## Topology (mirrors GCP)

| Role | GCP today | Linode target |
|------|-----------|---------------|
| Web UI + API + MediaMTX | `moq-web-gcp` | Linode **web** instance |
| Zixi + ingest-agent | `moq-zixi-gcp` | Linode **zixi** instance |
| OpenMOQ moqx relay | `moq-relay-gcp` | Linode **relay** instance |

The orchestrator can stay on GCP while ingest runs on Linode (cross-cloud upload tests), or you can move the web VM to Linode later.

## 1. Provision Zixi (terraform exists)

```bash
export LINODE_TOKEN=…
cd infra/zixi/terraform/linode
cp terraform.tfvars.example terraform.tfvars   # set allowed_ssh_cidr, region
terraform init && terraform apply
```

Firewall includes benchmark SRT `:10080` and ingest-agent `:8090` (aligned with GCP).

Install (SSH as **root**):

```bash
ZIXI_HOST=<linode-zixi-ip> bash infra/zixi/scripts/gcp-install-zixi.sh
ZIXI_HOST=<linode-zixi-ip> bash infra/zixi/scripts/install-ingest-agent.sh
ZIXI_HOST=<linode-zixi-ip> bash infra/zixi/scripts/configure-zixi-rtmp-input.sh
# SRT input on :10080 — mirror GCP runbook steps in infra/zixi/GCP-ZIXI-RUNBOOK.md
```

## 2. Web + MediaMTX (manual today)

Until dedicated Linode web terraform lands, use a **g6-standard-4** (or larger) in the same region:

```bash
PUBLIC_IP=<linode-web-ip> bash infra/mediamtx/scripts/install-mediamtx.sh
bash infra/web/scripts/install-web-app.sh <linode-web-ip> <domain-or-ip>
bash infra/zixi/scripts/install-ingest-agent.sh   # on the web host for MediaMTX metrics
```

Open firewall: `22,80,443,1935,8554,8888,8889,8890,8891,8090` (TCP) and `8890,8189` (UDP) as needed.

## 3. MoQ relay

Copy `infra/moqx/terraform/gcp/` to a Linode module (planned) or install manually:

```bash
bash infra/moqx/scripts/gcp-install-moqx.sh   # parameterize RELAY_DOMAIN / IP
bash infra/moqx/scripts/install-ingest-agent.sh
```

Use sslip.io: `<relay-ip-with-dashes>.sslip.io`.

## 4. Wire the app

After all three public IPs are known:

```bash
LINODE_REGION=us-east \
LINODE_ZIXI_IP=… \
LINODE_WEB_IP=… \
LINODE_RELAY_IP=… \
  ./infra/linode/scripts/update-linode-endpoints.sh
```

Merge `infra/web/scripts/linode-stack.env.example` into the **GCP web VM** `/etc/moq-web.env`:

```bash
LINODE_STACK_ENABLED=1
LINODE_REGION=us-east
LINODE_ZIXI_IP=…
LINODE_WEB_IP=…
LINODE_RELAY_IP=…
```

Restart `moq-web`. The UI will show **Zixi · Linode**, **MediaMTX · Linode**, and **OpenMOQ · Linode** when presets are active.

## Metrics

- Sample rows and CSV include **`cloud_provider`** and **`cloud_region`** (e.g. `gcp` / `us-central1`, `linode` / `us-east`).
- Linode host CPU/memory uses **ingest-agent :8090** (no GCP Cloud Monitoring equivalent yet).

## Cross-cloud notes

- Ensure the GCP web VM can reach Linode `:8090` for ingest-agent jobs (firewall + token).
- Local publisher agents should keep `MEDIAMTX_LOOPBACK_PUBLISH=0` when targeting Linode MediaMTX.
