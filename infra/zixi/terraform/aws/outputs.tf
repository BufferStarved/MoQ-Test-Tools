output "instance_id" {
  value = aws_instance.zixi.id
}

output "public_ip" {
  value = aws_instance.zixi.public_ip
}

output "ssh_command" {
  value = "ssh -i ~/.ssh/id_rsa ubuntu@${aws_instance.zixi.public_ip}"
}

output "zixi_web_ui" {
  value = "http://${aws_instance.zixi.public_ip}:${var.zixi_web_port}"
}

output "srt_push_url_template" {
  value = "srt://${aws_instance.zixi.public_ip}:${var.srt_listen_port}?mode=caller&latency=200000"
}

output "security_group_id" {
  value = aws_security_group.zixi.id
}
