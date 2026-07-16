# Zixi Broadcaster VM Deployment

Provision matching VMs on **AWS**, **GCP**, and **Linode** for Zixi Broadcaster ingest endpoints used by moq-test-tools benchmarks.

## VM sizing (per Zixi docs)

| Spec | Minimum | Recommended (this setup) |
|------|---------|--------------------------|
| CPU | 1 core | 4+ cores |
| RAM | 2 GB | 16 GB |
| Disk | — | 80 GB |
| NICs | 1 (non-DPDK) | 1 for benchmark ingest |

> **Note:** Zixi also offers pre-built AWS AMIs — contact your Zixi rep to share an AMI to your account. These Terraform configs use stock Ubuntu 22.04 so you can install Zixi manually on all three clouds consistently.

## Ports opened

| Port | Protocol | Purpose |
|------|----------|---------|
| 22 | TCP | SSH (restricted to your IP) |
| 4444 | TCP | Zixi web management UI |
| 1935 | TCP | RTMP ingest |
| 7777 | TCP | HTTP TS push ingest + HLS/DASH origin output |
| 2088 | UDP | Zixi protocol input (default) |
| 2077 | UDP | Zixi protocol output (default) |
| 2088* | UDP/TCP | SRT listen port (configurable via `srt_listen_port`) |

Outbound **TCP 80/443** to `license.zixi.com` is required for licensing (allowed by default egress rules).

## Prerequisites

### 1. Install tools

```bash
chmod +x infra/zixi/scripts/*.sh
./infra/zixi/scripts/install-prerequisites.sh
```

### 2. SSH key

Ensure you have a key pair:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
# Or use existing ~/.ssh/id_rsa.pub and update tfvars
```

### 3. Cloud credentials

| Cloud | Auth |
|-------|------|
| **AWS** | `aws configure` (Access key + secret, or SSO) |
| **GCP** | `gcloud auth application-default login` and set `project_id` in tfvars |
| **Linode** | `export LINODE_TOKEN="..."` from [Linode API tokens](https://cloud.linode.com/profile/tokens) |

### 4. Your public IP (for SSH lockdown)

```bash
curl -s ifconfig.me
# Use as allowed_ssh_cidr = "x.x.x.x/32" in terraform.tfvars
```

## Deploy each VM

Each cloud is an independent Terraform root module. Deploy one, two, or all three.

### AWS

```bash
cd infra/zixi/terraform/aws
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — set allowed_ssh_cidr and optionally region

terraform init
terraform plan
terraform apply

terraform output
```

### GCP

```bash
cd infra/zixi/terraform/gcp
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — set project_id and allowed_ssh_cidr

terraform init
terraform plan
terraform apply

terraform output
```

### Linode

```bash
export LINODE_TOKEN="your-token"

cd infra/zixi/terraform/linode
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — set allowed_ssh_cidr

terraform init
terraform plan
terraform apply

terraform output
```

## Install Zixi Broadcaster on each VM

Zixi Broadcaster is proprietary software — obtain the Linux installer from your Zixi account representative.

1. SSH into the VM (`terraform output ssh_command`)
2. Run the Zixi installer (follow Zixi-provided docs)
3. Open the web UI: `http://<public-ip>:4444`
4. Add an **SRT push input**:
   - Listening port: `2088` (or your `srt_listen_port`)
   - Latency: `1000` ms (or match benchmark `latency=200000` µs = 200 ms)
5. Verify licensing can reach `license.zixi.com`

```bash
./infra/zixi/scripts/verify-zixi-host.sh <public-ip>
```

## Wire into moq-test-tools

After all three VMs are running, use presets or custom URLs in the web UI or CLI.

**SRT** (port `10080` — port `2088` is reserved by Zixi's native protocol):

```
srt://<gcp-ip>:10080?mode=caller&latency=200000
```

Preset: `moq_zixi_gcp`

**RTMP**:

```
rtmp://<gcp-ip>:1935/live/benchmark
```

Preset: `moq_zixi_gcp_rtmp`

Configure RTMP on the VM (idempotent — safe to re-run after Zixi restarts):

```bash
ZIXI_HOST=<gcp-ip> ZIXI_PASSWORD=<password> ./infra/zixi/scripts/configure-zixi-rtmp-input.sh
# or
ZIXI_PASSWORD=<password> ./infra/zixi/scripts/ensure-rtmp-ingest.sh
```

The configure script enables the RTMP server, removes the common bad input ID `live/benchmark`, ensures stream ID `benchmark`, enables live recording, and runs a 3-second ffmpeg verification push.

**HLS / DASH** (HTTP TS push ingest → Zixi origin output on port 7777):

```
http://<gcp-ip>:7777/benchmark
```

Playback (after `configure-zixi-hls-dash-output.sh`):

| Format | URL |
|--------|-----|
| HLS | `http://<gcp-ip>:7777/benchmark.m3u8` |
| DASH | `http://<gcp-ip>:7777/benchmark.mpd` |

Presets: `moq_zixi_gcp_hls` / `moq_zixi_gcp_dash`

```bash
ZIXI_HOST=<gcp-ip> ZIXI_PASSWORD=<password> ./infra/zixi/scripts/configure-zixi-hls-dash-output.sh
# or
ZIXI_PASSWORD=<password> ./infra/zixi/scripts/ensure-hls-dash-output.sh
./infra/zixi/scripts/test-hls-dash-output.sh
```

Test connectivity before benchmarking:

```bash
./infra/zixi/scripts/test-endpoint.sh 'srt://<zixi-ip>:10080?mode=caller&latency=200000'
./infra/zixi/scripts/test-endpoint.sh 'rtmp://<zixi-ip>:1935/live/benchmark'
./infra/zixi/scripts/test-endpoint.sh 'http://<zixi-ip>:7777/benchmark'
```

Run a benchmark from the web UI (`./scripts/dev.sh`) or CLI:

```bash
source venv/bin/activate
export PATH="/opt/homebrew/opt/ffmpeg-full/bin:/opt/homebrew/bin:$PATH"
export PYTHONPATH="src:web/api"

python src/runner.py \
  --media dummy.mp4 \
  --duration 30 \
  --protocol srt \
  --endpoint-url "srt://<zixi-ip>:10080?mode=caller&latency=200000"
```

Results are saved to `results/` as CSV + JSON summary. See [docs/METRICS.md](../../docs/METRICS.md) for RTT, jitter, packet loss, FEC, CC errors, and VMAF.

### Optional: receiver-side metrics from Zixi

```bash
export ZIXI_API_BASE=http://<zixi-ip>:4444
export ZIXI_API_USER=admin
export ZIXI_API_PASSWORD=<password>
```

Enable **TR101 Analysis** on the input in the Zixi UI for CC error reporting.

## Cost estimates (approximate, on-demand)

| Cloud | Instance | ~Monthly |
|-------|----------|----------|
| AWS | t3.xlarge (4 vCPU, 16 GB) | ~$120 |
| GCP | e2-standard-4 (4 vCPU, 16 GB) | ~$100 |
| Linode | g6-standard-8 (8 vCPU, 16 GB) | ~$96 |

Stop or destroy VMs when not benchmarking:

```bash
terraform destroy   # run in each cloud directory
```

## AWS AMI shortcut (optional)

If your Zixi rep shares a pre-built AMI, you can skip manual install on AWS:

1. Replace `data.aws_ami.ubuntu` in `terraform/aws/main.tf` with your AMI ID
2. Use Amazon Linux 2023-based AMI if provided by Zixi
3. For DPDK/high throughput, request network-optimized instances (`c7gn.*`) and a second NIC per Zixi docs

## Troubleshooting

| Issue | Fix |
|-------|-----|
| SSH timeout | Check `allowed_ssh_cidr` matches your current IP |
| SRT push fails | Confirm UDP/TCP `srt_listen_port` open; verify Zixi input is in listener mode |
| Zixi license error | Ensure outbound 443 to internet; check VM clock (NTP) |
| Terraform auth error | Re-run cloud-specific auth steps above |

## Directory layout

```
infra/zixi/
├── README.md
├── cloud-init/base.yaml      # Bootstrap packages on first boot
├── scripts/
│   ├── install-prerequisites.sh
│   └── verify-zixi-host.sh
└── terraform/
    ├── aws/
    ├── gcp/
    └── linode/
```
