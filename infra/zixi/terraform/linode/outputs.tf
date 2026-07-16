output "instance_id" {
  value = linode_instance.zixi.id
}

output "public_ip" {
  value = linode_instance.zixi.ip_address
}

output "ssh_command" {
  value = "ssh -i ~/.ssh/id_rsa root@${linode_instance.zixi.ip_address}"
}

output "zixi_web_ui" {
  value = "http://${linode_instance.zixi.ip_address}:${var.zixi_web_port}"
}

output "srt_push_url_template" {
  value = "srt://${linode_instance.zixi.ip_address}:${var.srt_listen_port}?mode=caller&latency=200000"
}

output "firewall_id" {
  value = linode_firewall.zixi.id
}
