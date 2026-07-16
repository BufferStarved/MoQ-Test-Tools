output "instance_name" {
  value = google_compute_instance.relay.name
}

output "public_ip" {
  value = google_compute_address.relay.address
}

output "relay_domain" {
  description = "sslip.io hostname that resolves to the relay public IP"
  value       = local.sslip_domain
}

output "relay_base_url" {
  description = "Base HTTPS URL for moq-js playback"
  value       = "https://${local.sslip_domain}:${var.moqx_port}"
}

output "relay_fingerprint_url" {
  value = "https://${local.sslip_domain}:${var.moqx_port}/fingerprint"
}

output "relay_publish_url" {
  description = "MOQT relay endpoint path for publishers (OpenMOQ ffmpeg output)"
  value       = "https://${local.sslip_domain}:${var.moqx_port}/moq-relay"
}

output "ssh_command" {
  value = "ssh ubuntu@${google_compute_address.relay.address}"
}

output "install_command" {
  value = "infra/moqx/scripts/gcp-install-moqx.sh ${google_compute_address.relay.address}"
}
