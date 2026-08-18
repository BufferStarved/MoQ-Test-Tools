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
  # Set LINODE_TOKEN before terraform apply
}

data "linode_image" "ubuntu" {
  id = "linode/ubuntu24.04"
}

resource "linode_sshkey" "web" {
  label   = "${var.project_name}-ssh"
  ssh_key = trimspace(file(pathexpand(var.ssh_public_key_path)))
}

resource "linode_instance" "web" {
  label           = "${var.project_name}-linode"
  region          = var.region
  type            = var.instance_type
  image           = data.linode_image.ubuntu.id
  authorized_keys = [linode_sshkey.web.ssh_key]

  metadata {
    user_data = base64encode(templatefile("${path.module}/../../cloud-init/base.yaml", {
      ssh_public_key = linode_sshkey.web.ssh_key
    }))
  }

  tags = ["moq-web", var.project_name]
}

resource "linode_firewall" "web" {
  label = "${var.project_name}-fw"

  inbound_policy  = "DROP"
  outbound_policy = "ACCEPT"
  linodes         = [linode_instance.web.id]

  inbound {
    label    = "ssh"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "22"
    ipv4     = concat([var.allowed_ssh_cidr], var.extra_ssh_ipv4_cidrs)
    ipv6     = var.allowed_ssh_ipv6_cidrs
  }

  inbound {
    label    = "http-https"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "80,443"
    ipv4     = [var.allowed_http_cidr]
  }

  inbound {
    label    = "mediamtx-tcp"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "1935,8090,8888,8889,8891"
    ipv4     = [var.allowed_ingest_cidr]
  }

  inbound {
    label    = "mediamtx-srt"
    action   = "ACCEPT"
    protocol = "UDP"
    ports    = "8890"
    ipv4     = [var.allowed_ingest_cidr]
  }

  inbound {
    label    = "mediamtx-webrtc"
    action   = "ACCEPT"
    protocol = "UDP"
    ports    = "8189"
    ipv4     = [var.allowed_ingest_cidr]
  }
}
