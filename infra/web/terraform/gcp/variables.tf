variable "project_name" {
  type    = string
  default = "moq-web"
}

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  type    = string
  default = "us-central1-a"
}

variable "machine_type" {
  description = "GCE machine type for the web/encode host"
  type        = string
  default     = "e2-standard-4"
}

variable "disk_size_gb" {
  type    = number
  default = 50
}

variable "ssh_public_key_path" {
  type    = string
  default = "~/.ssh/id_ed25519.pub"
}

variable "allowed_ssh_cidr" {
  description = "CIDR allowed to SSH to the web VM"
  type        = string
}

variable "allowed_http_cidr" {
  description = "CIDR allowed to reach HTTP/HTTPS"
  type        = string
  default     = "0.0.0.0/0"
}

variable "web_domain" {
  description = "Public hostname for the web app (DNS A record must point here)"
  type        = string
  default     = "moq.sean-mccarthy.net"
}
