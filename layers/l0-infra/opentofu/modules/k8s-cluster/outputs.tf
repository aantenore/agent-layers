output "endpoint" {
  description = "Kubernetes API server URL. Null until an implementation is added."
  value       = null
}

output "kubeconfig" {
  description = "Kubeconfig for the cluster. Null until an implementation is added."
  value       = null
  sensitive   = true
}

output "ingress_address" {
  description = "Address (IP or DNS name) where the cluster ingress is reachable."
  value       = null
}
