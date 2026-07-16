variable "project_name" {
  type    = string
  default = "moq-relay"
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
  description = "GCE machine type for the MoQ relay"
  type        = string
  default     = "e2-standard-4"
}

variable "ssh_public_key_path" {
  type    = string
  default = "~/.ssh/id_rsa.pub"
}

variable "allowed_ssh_cidr" {
  type = string
}

variable "allowed_client_cidr" {
  description = "CIDR allowed to reach relay QUIC/HTTP ports"
  type        = string
  default     = "0.0.0.0/0"
}

variable "moqx_port" {
  type    = number
  default = 4433
}

variable "moqx_pico_port" {
  type    = number
  default = 4434
}

variable "moqx_admin_port" {
  type    = number
  default = 8000
}

variable "certbot_email" {
  description = "Email for Let's Encrypt registration and renewal"
  type        = string
}
