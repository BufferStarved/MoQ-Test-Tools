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
  id = "linode/ubuntu22.04"
}

resource "linode_sshkey" "relay" {
  label   = "${var.project_name}-ssh"
  ssh_key = trimspace(file(pathexpand(var.ssh_public_key_path)))
}

resource "linode_instance" "relay" {
  label           = "${var.project_name}-linode"
  region          = var.region
  type            = var.instance_type
  image           = data.linode_image.ubuntu.id
  authorized_keys = [linode_sshkey.relay.ssh_key]

  metadata {
    user_data = base64encode(templatefile("${path.module}/../../cloud-init/linode.yaml", {
      ssh_public_key  = linode_sshkey.relay.ssh_key
      moqx_port       = var.moqx_port
      moqx_pico_port  = var.moqx_pico_port
      moqx_admin_port = var.moqx_admin_port
      certbot_email   = var.certbot_email
    }))
  }

  tags = ["moq-relay", var.project_name]
}

resource "linode_firewall" "relay" {
  label = "${var.project_name}-fw"

  inbound_policy  = "DROP"
  outbound_policy = "ACCEPT"
  linodes         = [linode_instance.relay.id]

  inbound {
    label    = "ssh"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "22"
    ipv4     = concat([var.allowed_ssh_cidr], var.extra_ssh_ipv4_cidrs)
    ipv6     = var.allowed_ssh_ipv6_cidrs
  }

  inbound {
    label    = "http-admin"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "80,${var.moqx_admin_port},8090"
    ipv4     = [var.allowed_client_cidr]
  }

  inbound {
    label    = "moqx-quic"
    action   = "ACCEPT"
    protocol = "UDP"
    ports    = "${var.moqx_port},${var.moqx_pico_port}"
    ipv4     = [var.allowed_client_cidr]
  }
}
