output "endpoint" {
  description = "Base URL of the ingress. Services answer on <name>.<host> through Traefik once DNS points at the host."
  value       = "http://${var.ssh_host}:${var.http_port}"
  depends_on  = [terraform_data.compose_target]
}
