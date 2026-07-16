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

resource "google_compute_network" "zixi" {
  name                    = "${var.project_name}-vpc"
  auto_create_subnetworks = true
}

resource "google_compute_firewall" "ssh" {
  name    = "${var.project_name}-allow-ssh"
  network = google_compute_network.zixi.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = [var.allowed_ssh_cidr]
  target_tags   = ["zixi-broadcaster"]
}

resource "google_compute_firewall" "zixi_ingest" {
  name    = "${var.project_name}-allow-ingest"
  network = google_compute_network.zixi.name

  allow {
    protocol = "tcp"
    ports = [
      tostring(var.zixi_web_port),
      tostring(var.zixi_rtmp_port),
      tostring(var.zixi_hls_port),
      tostring(var.srt_listen_port),
      tostring(var.ingest_agent_port),
      # Benchmark SRT input listens on 10080 (not srt_listen_port/2088, which is
      # reserved by Zixi's native protocol) — see infra/zixi/GCP-ZIXI-RUNBOOK.md.
      # Hardcoded (not a var) so it never touches google_compute_instance.zixi's
      # metadata_startup_script, which is ForceNew and would recreate the VM.
      "10080",
    ]
  }

  allow {
    protocol = "udp"
    ports = [
      tostring(var.zixi_udp_input_port),
      tostring(var.zixi_udp_output_port),
      tostring(var.srt_listen_port),
      "10080",
    ]
  }

  source_ranges = [var.allowed_ingest_cidr]
  target_tags   = ["zixi-broadcaster"]
}

resource "google_compute_address" "zixi" {
  name   = "${var.project_name}-ip"
  region = var.region
}

data "google_compute_image" "ubuntu" {
  family  = "ubuntu-2204-lts"
  project = "ubuntu-os-cloud"
}

resource "google_compute_instance" "zixi" {
  name         = "${var.project_name}-gcp"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["zixi-broadcaster"]

  boot_disk {
    initialize_params {
      image = data.google_compute_image.ubuntu.self_link
      size  = 80
      type  = "pd-balanced"
    }
  }

  network_interface {
    network = google_compute_network.zixi.name
    access_config {
      nat_ip = google_compute_address.zixi.address
    }
  }

  metadata = {
    ssh-keys = "ubuntu:${chomp(file(pathexpand(var.ssh_public_key_path)))}"
  }

  metadata_startup_script = templatefile("${path.module}/../../cloud-init/base.yaml", {
    srt_listen_port = var.srt_listen_port
  })

  labels = {
    project = replace(var.project_name, "-", "_")
    role    = "zixi_broadcaster"
  }

  # See infra/moqx/terraform/gcp/main.tf for why: the ubuntu-2204-lts image
  # family resolves to the latest point release at plan time, and
  # boot_disk.image is ForceNew, so an untouched apply months from now would
  # otherwise queue a full VM replacement (wiping the ingest_agent sidecar
  # installed via SSH, which lives outside Terraform/cloud-init).
  lifecycle {
    ignore_changes = [boot_disk[0].initialize_params[0].image]
  }
}
