terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

data "google_compute_network" "existing" {
  count = var.existing_network != "" ? 1 : 0
  name  = var.existing_network
}

resource "google_compute_network" "relay" {
  count                   = var.existing_network == "" ? 1 : 0
  name                    = "${var.project_name}-vpc"
  auto_create_subnetworks = true
}

locals {
  network_name = var.existing_network != "" ? data.google_compute_network.existing[0].name : google_compute_network.relay[0].name
}

moved {
  from = google_compute_network.relay
  to   = google_compute_network.relay[0]
}

resource "google_compute_firewall" "ssh" {
  name    = "${var.project_name}-allow-ssh"
  network = local.network_name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = [var.allowed_ssh_cidr]
  target_tags   = ["moq-relay"]
}

# Allows SSH via GCP Identity-Aware Proxy (IAP) tunneling.
# 35.235.240.0/20 is GCP's fixed range for IAP-forwarded traffic.
# Must target moq-relay-vpc (not default) — each stack has its own VPC.
resource "google_compute_firewall" "allow_iap_ssh" {
  name    = "${var.project_name}-allow-iap-ssh"
  network = local.network_name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["moq-relay"]
}

resource "google_compute_firewall" "relay_service" {
  name    = "${var.project_name}-allow-relay"
  network = local.network_name

  allow {
    protocol = "tcp"
    ports = [
      "80",
      tostring(var.moqx_admin_port),
      # moq-ingest-agent psutil sidecar (host_metrics for the benchmark
      # report's server_cpu/memory/disk fields on MoQ runs) — see
      # infra/zixi/scripts/install-ingest-agent.sh for the same pattern
      # already deployed on the Zixi VM.
      "8090",
    ]
  }

  allow {
    protocol = "udp"
    ports = [
      tostring(var.moqx_port),
      tostring(var.moqx_pico_port),
    ]
  }

  source_ranges = [var.allowed_client_cidr]
  target_tags   = ["moq-relay"]
}

resource "google_compute_address" "relay" {
  name   = "${var.project_name}-ip"
  region = var.region
}

data "google_compute_image" "ubuntu" {
  family  = "ubuntu-2204-lts"
  project = "ubuntu-os-cloud"
}

locals {
  relay_domain = replace(google_compute_address.relay.address, ".", "-")
  sslip_domain = "${local.relay_domain}.sslip.io"
}

resource "google_compute_instance" "relay" {
  name         = "${var.project_name}-gcp"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["moq-relay"]

  boot_disk {
    initialize_params {
      image = data.google_compute_image.ubuntu.self_link
      size  = 50
      type  = "pd-balanced"
    }
  }

  network_interface {
    network = local.network_name
    access_config {
      nat_ip = google_compute_address.relay.address
    }
  }

  metadata = {
    ssh-keys = "ubuntu:${chomp(file(pathexpand(var.ssh_public_key_path)))}"
  }

  metadata_startup_script = templatefile("${path.module}/../../cloud-init/base.yaml", {
    moqx_port       = var.moqx_port
    moqx_pico_port  = var.moqx_pico_port
    moqx_admin_port = var.moqx_admin_port
    relay_domain    = local.sslip_domain
    certbot_email   = var.certbot_email
  })

  labels = {
    project = replace(var.project_name, "-", "_")
    role    = "moq_relay"
  }

  # The ubuntu-2204-lts image family resolves to whatever the latest point
  # release is at plan time. boot_disk.image is ForceNew, so without this a
  # routine `terraform plan` months after deploy silently queues up a full
  # VM replacement the moment a new Ubuntu point release ships — even for an
  # unrelated change like a firewall port. Pin it to whatever image the VM
  # actually booted with.
  lifecycle {
    ignore_changes = [boot_disk[0].initialize_params[0].image]
  }
}
