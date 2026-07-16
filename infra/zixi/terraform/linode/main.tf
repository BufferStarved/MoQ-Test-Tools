terraform {
  required_version = ">= 1.5.0"

  required_providers {
    linode = {
      source  = "linode/linode"
      version = "~> 2.0"
    }
  }
}

provider "linode" {
  # Set LINODE_TOKEN env var before running terraform
}

data "linode_image" "ubuntu" {
  id = "linode/ubuntu22.04"
}

resource "linode_sshkey" "zixi" {
  label   = "${var.project_name}-ssh"
  ssh_key = chomp(file(pathexpand(var.ssh_public_key_path)))
}

resource "linode_instance" "zixi" {
  label           = "${var.project_name}-linode"
  region          = var.region
  type            = var.instance_type
  image           = data.linode_image.ubuntu.id
  authorized_keys = [linode_sshkey.zixi.ssh_key]

  metadata {
    user_data = base64encode(templatefile("${path.module}/../../cloud-init/base.yaml", {
      srt_listen_port = var.srt_listen_port
    }))
  }

  tags = ["zixi-broadcaster", var.project_name]
}

resource "linode_firewall" "zixi" {
  label = "${var.project_name}-fw"

  inbound_policy  = "DROP"
  outbound_policy = "ACCEPT"
  linodes         = [linode_instance.zixi.id]

  inbound {
    label    = "ssh"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "22"
    ipv4     = [var.allowed_ssh_cidr]
  }

  inbound {
    label    = "zixi-web"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = tostring(var.zixi_web_port)
    ipv4     = [var.allowed_ingest_cidr]
  }

  inbound {
    label    = "rtmp"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = tostring(var.zixi_rtmp_port)
    ipv4     = [var.allowed_ingest_cidr]
  }

  inbound {
    label    = "hls"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = tostring(var.zixi_hls_port)
    ipv4     = [var.allowed_ingest_cidr]
  }

  inbound {
    label    = "zixi-udp-in"
    action   = "ACCEPT"
    protocol = "UDP"
    ports    = tostring(var.zixi_udp_input_port)
    ipv4     = [var.allowed_ingest_cidr]
  }

  inbound {
    label    = "zixi-udp-out"
    action   = "ACCEPT"
    protocol = "UDP"
    ports    = tostring(var.zixi_udp_output_port)
    ipv4     = [var.allowed_ingest_cidr]
  }

  inbound {
    label    = "srt-udp"
    action   = "ACCEPT"
    protocol = "UDP"
    ports    = tostring(var.srt_listen_port)
    ipv4     = [var.allowed_ingest_cidr]
  }

  inbound {
    label    = "srt-tcp"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = tostring(var.srt_listen_port)
    ipv4     = [var.allowed_ingest_cidr]
  }
}
