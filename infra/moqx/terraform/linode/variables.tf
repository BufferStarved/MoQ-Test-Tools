variable "project_name" {
  type    = string
  default = "moq-relay"
}

variable "region" {
  type    = string
  default = "us-east"
}

variable "instance_type" {
  type    = string
  default = "g6-standard-4"
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

variable "register_ssh_key" {
  description = "Register the key on the Linode account. Needs SSH Keys token scope. The instance still gets authorized_keys from the file."
  type        = bool
  default     = true
}

variable "allowed_client_cidr" {
  type    = string
  default = "0.0.0.0/0"
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
  type = string
}
