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

resource "google_compute_network" "web" {
  name                    = "${var.project_name}-vpc"
  auto_create_subnetworks = true
}

resource "google_compute_firewall" "ssh" {
  name    = "${var.project_name}-allow-ssh"
  network = google_compute_network.web.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = [var.allowed_ssh_cidr]
  target_tags   = ["moq-web"]
}

resource "google_compute_firewall" "http_https" {
  name    = "${var.project_name}-allow-http"
  network = google_compute_network.web.name

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  source_ranges = [var.allowed_http_cidr]
  target_tags   = ["moq-web"]
}

resource "google_compute_address" "web" {
  name   = "${var.project_name}-ip"
  region = var.region
}

data "google_compute_image" "ubuntu" {
  # openmoq-publisher Linux releases need GLIBC ≥ 2.38 (24.04+).
  # Existing VMs on 22.04 use a Docker wrapper via install-openmoq-publisher.sh.
  family  = "ubuntu-2404-lts"
  project = "ubuntu-os-cloud"
}

resource "google_compute_instance" "web" {
  name         = "${var.project_name}-gcp"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["moq-web"]

  boot_disk {
    initialize_params {
      image = data.google_compute_image.ubuntu.self_link
      size  = var.disk_size_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    network = google_compute_network.web.name
    access_config {
      nat_ip = google_compute_address.web.address
    }
  }

  metadata = {
    ssh-keys = "ubuntu:${chomp(file(pathexpand(var.ssh_public_key_path)))}"
  }

  labels = {
    project = replace(var.project_name, "-", "_")
    role    = "moq_web"
  }

  # Pin boot image after first create — ubuntu-2204-lts family moves.
  lifecycle {
    ignore_changes = [boot_disk[0].initialize_params[0].image]
  }
}
