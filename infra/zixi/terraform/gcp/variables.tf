variable "project_name" {
  type    = string
  default = "moq-zixi"
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
  description = "GCE machine type (Zixi recommends 4+ vCPU, 16+ GB RAM)"
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

variable "ingest_agent_port" {
  type    = number
  default = 8090
}
