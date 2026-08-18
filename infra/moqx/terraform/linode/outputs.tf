output "instance_id" {
  value = linode_instance.relay.id
}

output "public_ip" {
  value = linode_instance.relay.ip_address
}

output "relay_domain" {
  value = replace(linode_instance.relay.ip_address, ".", "-")
}

output "relay_base_url" {
  value = "https://${replace(linode_instance.relay.ip_address, ".", "-")}.sslip.io:${var.moqx_port}"
}

output "ssh_command" {
  value = "ssh ubuntu@${linode_instance.relay.ip_address}"
}

output "install_command" {
  value = "infra/moqx/scripts/gcp-install-moqx.sh ${linode_instance.relay.ip_address} ${var.certbot_email}"
}
