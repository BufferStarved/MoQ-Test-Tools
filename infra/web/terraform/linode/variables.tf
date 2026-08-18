variable "project_name" {
  type    = string
  default = "moq-web"
}

variable "region" {
  type    = string
  default = "us-east"
}

variable "instance_type" {
  description = "Linode type (g6-standard-4 = 4 vCPU, 8 GB — matches GCP e2-standard-4)"
  type        = string
  default     = "g6-standard-4"
}

variable "ssh_public_key_path" {
  type    = string
  default = "~/.ssh/id_ed25519.pub"
}

variable "allowed_ssh_cidr" {
  type = string
}

variable "extra_ssh_ipv4_cidrs" {
  type    = list(string)
  default = []
}

variable "allowed_ssh_ipv6_cidrs" {
  type    = list(string)
  default = []
}

variable "allowed_ingest_cidr" {
  type    = string
  default = "0.0.0.0/0"
}

variable "allowed_http_cidr" {
  type    = string
  default = "0.0.0.0/0"
}
