# GCP multi-region (us-central1 + us-east1)

us-central1 stays the **orchestrator** (UI/API + current encode host). us-east1 is a
second full ingest stack so a user can start a run against either region — or
Linode — from the same UI.

| Role | us-central1 (prod) | us-east1 |
|------|--------------------|----------|
| Web + MediaMTX | `moq-web-gcp` | `moq-web-east-gcp` |
| Zixi + ingest-agent | `moq-zixi-gcp` | `moq-zixi-east-gcp` |
| moqx relay | `moq-relay-gcp` | `moq-relay-east-gcp` |

Terraform for east lives in sibling dirs (`infra/*/terraform/gcp-us-east1`) that
symlink the existing modules. **Never** pass us-east1 vars into the us-central1
state files.

The project has a **5-VPC quota**. us-east1 therefore shares `moq-web-east-vpc`
(`existing_network` in the zixi/relay tfvars) instead of creating two more VPCs.

## 1. Provision VMs

```bash
# Plan only
./infra/scripts/provision-gcp-east.sh

# Create the three VMs
TF_AUTO_APPROVE=1 ./infra/scripts/provision-gcp-east.sh
```

Writes `infra/web/scripts/gcp-east-stack.env.example` with public IPs.

## 2. Install software

```bash
ZONE=us-east1-b
WEB_IP=$(terraform -chdir=infra/web/terraform/gcp-us-east1 output -raw public_ip)
RELAY_IP=$(terraform -chdir=infra/moqx/terraform/gcp-us-east1 output -raw public_ip)
ZIXI_IP=$(terraform -chdir=infra/zixi/terraform/gcp-us-east1 output -raw public_ip)

# MediaMTX on the east web VM (install docker + ffmpeg first if missing)
gcloud compute ssh ubuntu@moq-web-east-gcp --zone=$ZONE --tunnel-through-iap

# Relay (Let's Encrypt via sslip.io)
bash infra/moqx/scripts/gcp-install-moqx.sh "$RELAY_IP" admin@sean-mccarthy.net
bash infra/moqx/scripts/install-ingest-agent.sh   # on the relay, if used

# Zixi (needs the Broadcaster installer tarball)
ZIXI_TF_DIR=infra/zixi/terraform/gcp-us-east1 \
  bash infra/zixi/scripts/gcp-install-zixi.sh ~/Downloads/ZixiBroadcaster-linux.tar.gz
ZIXI_HOST=$ZIXI_IP bash infra/zixi/scripts/install-ingest-agent.sh
ZIXI_HOST=$ZIXI_IP bash infra/zixi/scripts/configure-zixi-rtmp-input.sh
```

## 3. Wire the orchestrator

Merge `infra/web/scripts/gcp-east-stack.env.example` into **us-central1**
`/etc/moq-web.env` and restart `moq-web`. The UI then shows **Zixi / MediaMTX /
OpenMOQ · GCP us-east1**.

VOD ffmpeg still encodes on the API host (us-central1) and publishes across
regions until a remote encode worker is added. Ingest, relay, and playback
already follow the selected cloud.

## Linode

Same product shape; see `infra/linode/LINODE-STACK-RUNBOOK.md`. Needs
`LINODE_TOKEN` before `terraform apply` in:

- `infra/zixi/terraform/linode`
- `infra/web/terraform/linode`
- `infra/moqx/terraform/linode`
