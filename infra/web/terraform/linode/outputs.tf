output "instance_id" {
  value = linode_instance.web.id
}

output "public_ip" {
  value = linode_instance.web.ip_address
}

output "ssh_command" {
  value = "ssh ubuntu@${linode_instance.web.ip_address}"
}

output "install_mediamtx" {
  value = "PUBLIC_IP=${linode_instance.web.ip_address} bash infra/mediamtx/scripts/install-mediamtx.sh"
}
