variable "project_name" {
  description = "Prefix for resource names"
  type        = string
  default     = "moq-zixi"
}

variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type (Zixi recommends 4+ vCPU, 16+ GB RAM)"
  type        = string
  default     = "t3.xlarge"
}

variable "ssh_public_key_path" {
  description = "Path to your SSH public key"
  type        = string
  default     = "~/.ssh/id_rsa.pub"
}

variable "allowed_ssh_cidr" {
  description = "CIDR allowed to SSH (use your IP, e.g. 203.0.113.10/32)"
  type        = string
}

variable "allowed_ingest_cidr" {
  description = "CIDR allowed to push SRT/RTMP streams (0.0.0.0/0 for open testing)"
  type        = string
  default     = "0.0.0.0/0"
}

variable "srt_listen_port" {
  description = "UDP/TCP port Zixi will listen on for SRT push ingest"
  type        = number
  default     = 2088
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
