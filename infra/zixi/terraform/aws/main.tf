terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "zixi" {
  key_name   = "${var.project_name}-aws"
  public_key = file(pathexpand(var.ssh_public_key_path))
}

resource "aws_security_group" "zixi" {
  name        = "${var.project_name}-sg"
  description = "Zixi Broadcaster ingest and management ports"

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }

  ingress {
    description = "Zixi web UI"
    from_port   = var.zixi_web_port
    to_port     = var.zixi_web_port
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ingest_cidr]
  }

  ingress {
    description = "RTMP ingest"
    from_port   = var.zixi_rtmp_port
    to_port     = var.zixi_rtmp_port
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ingest_cidr]
  }

  ingress {
    description = "HLS/DASH pull"
    from_port   = var.zixi_hls_port
    to_port     = var.zixi_hls_port
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ingest_cidr]
  }

  ingress {
    description = "Zixi UDP input"
    from_port   = var.zixi_udp_input_port
    to_port     = var.zixi_udp_input_port
    protocol    = "udp"
    cidr_blocks = [var.allowed_ingest_cidr]
  }

  ingress {
    description = "Zixi UDP output"
    from_port   = var.zixi_udp_output_port
    to_port     = var.zixi_udp_output_port
    protocol    = "udp"
    cidr_blocks = [var.allowed_ingest_cidr]
  }

  ingress {
    description = "SRT listen (UDP)"
    from_port   = var.srt_listen_port
    to_port     = var.srt_listen_port
    protocol    = "udp"
    cidr_blocks = [var.allowed_ingest_cidr]
  }

  ingress {
    description = "SRT listen (TCP fallback)"
    from_port   = var.srt_listen_port
    to_port     = var.srt_listen_port
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ingest_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.project_name}-sg"
    Project = var.project_name
  }
}

resource "aws_instance" "zixi" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = aws_key_pair.zixi.key_name
  vpc_security_group_ids = [aws_security_group.zixi.id]
  associate_public_ip_address = true

  user_data = templatefile("${path.module}/../../cloud-init/base.yaml", {
    srt_listen_port = var.srt_listen_port
  })

  root_block_device {
    volume_size = 80
    volume_type = "gp3"
  }

  tags = {
    Name    = "${var.project_name}-aws"
    Project = var.project_name
    Role    = "zixi-broadcaster"
  }
}
