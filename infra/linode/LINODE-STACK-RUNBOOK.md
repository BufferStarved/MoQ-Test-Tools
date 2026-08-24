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

## 2. Web + MediaMTX

```bash
export LINODE_TOKEN=…
cd infra/web/terraform/linode
cp terraform.tfvars.example terraform.tfvars   # set allowed_ssh_cidr
terraform init && terraform apply
PUBLIC_IP=<linode-web-ip> bash infra/mediamtx/scripts/install-mediamtx.sh
# ingest-agent on the web host for MediaMTX metrics
bash infra/zixi/scripts/install-ingest-agent.sh
```

SSH as **ubuntu** (cloud-init creates the user). Do not install the public UI here —
the orchestrator stays on GCP us-central1.

## 3. MoQ relay

```bash
cd infra/moqx/terraform/linode
cp terraform.tfvars.example terraform.tfvars   # set allowed_ssh_cidr + certbot_email
terraform init && terraform apply
bash infra/moqx/scripts/gcp-install-moqx.sh <linode-relay-ip> you@example.com
bash infra/moqx/scripts/install-ingest-agent.sh
```

Use sslip.io: `<relay-ip-with-dashes>.sslip.io`.

## Extra regions (Dallas / Fremont)

Sibling terraform dirs (`infra/*/terraform/linode-us-central`,
`linode-us-west`) symlink the live `linode/` modules. Do **not** apply into the
us-east state.

```bash
export LINODE_TOKEN=…
./infra/scripts/provision-linode-central.sh   # plan; TF_AUTO_APPROVE=1 to apply
./infra/scripts/provision-linode-west.sh
```

Needs a token with firewall + instance scopes. After IPs exist:

```bash
./infra/linode/scripts/update-linode-central-endpoints.sh
./infra/linode/scripts/update-linode-west-endpoints.sh
```

Merge `linode-central-stack.env.example` / `linode-west-stack.env.example` into
`/etc/moq-web.env`. Restart `moq-web` only after the merge. Do not leave an
unlicensed Zixi Broadcaster running. Do not replace the us-east instances.

Live us-east canary UDP **14433** is the `moqx-d18` inbound rule on
`moq-relay-fw`. If Cloud Manager still DROPs it, apply that rule only
(`-refresh=false` if SSH-key refresh 401s). Prod `:4433` stays `329b98b`.

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

Dallas (`linode-central-stack.env.example`) and Fremont (`linode-west-stack.env.example`)
enable MediaMTX + draft-18 `:14433` the same way. Leave `*_ZIXI_IP` empty until
Broadcaster is installed so Zixi stays grey in the picker.

## Metrics

- Sample rows and CSV include **`cloud_provider`** and **`cloud_region`** (e.g. `gcp` / `us-central1`, `linode` / `us-east`).
- Linode host CPU/memory uses **ingest-agent :8090** (no GCP Cloud Monitoring equivalent yet).

## Cross-cloud notes

- Ensure the GCP web VM can reach Linode `:8090` for ingest-agent jobs (firewall + token).
- Local publisher agents should keep `MEDIAMTX_LOOPBACK_PUBLISH=0` when targeting Linode MediaMTX.
