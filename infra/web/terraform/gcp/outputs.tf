output "instance_name" {
  value = google_compute_instance.web.name
}

output "public_ip" {
  value = google_compute_address.web.address
}

output "web_domain" {
  description = "Configured public hostname (DNS A record must point here)"
  value       = var.web_domain
}

output "web_url" {
  value = "https://${var.web_domain}"
}

output "ssh_command" {
  value = "ssh ubuntu@${google_compute_address.web.address}"
}

output "dns_hint" {
  value = "Create an A record: ${var.web_domain} -> ${google_compute_address.web.address}"
}

output "install_command" {
  value = "infra/web/scripts/install-web-app.sh ${google_compute_address.web.address}"
}
