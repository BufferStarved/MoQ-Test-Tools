output "instance_name" {
  value = google_compute_instance.zixi.name
}

output "public_ip" {
  value = google_compute_address.zixi.address
}

output "ssh_command" {
  value = "ssh -i ~/.ssh/id_rsa ubuntu@${google_compute_address.zixi.address}"
}

output "zixi_web_ui" {
  value = "http://${google_compute_address.zixi.address}:${var.zixi_web_port}"
}

output "srt_push_url_template" {
  value = "srt://${google_compute_address.zixi.address}:${var.srt_listen_port}?mode=caller&latency=200000"
}
