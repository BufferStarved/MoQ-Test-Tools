variable "project_name" {
  type    = string
  default = "moq-zixi"
}

variable "region" {
  type    = string
  default = "us-east"
}

variable "instance_type" {
  description = "Linode type (g6-standard-8 = 8 vCPU, 16 GB RAM)"
  type        = string
  default     = "g6-standard-8"
}

variable "ssh_public_key_path" {
  type    = string
  default = "~/.ssh/id_rsa.pub"
}

variable "allowed_ssh_cidr" {
  type = string
}

variable "allowed_ingest_cidr" {
  type    = string
  default = "0.0.0.0/0"
}

variable "srt_listen_port" {
  type    = number
  default = 2088
}

variable "zixi_web_port" {
  type    = number
  default = 4444
}

variable "zixi_rtmp_port" {
  type    = number
  default = 1935
}

variable "zixi_hls_port" {
  type    = number
  default = 7777
}

variable "zixi_udp_input_port" {
  type    = number
  default = 2088
}

variable "zixi_udp_output_port" {
  type    = number
  default = 2077
}
