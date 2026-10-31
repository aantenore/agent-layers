variable "name" {
  description = "Cluster name."
  type        = string
}

variable "kubernetes_version" {
  type    = string
  default = null
}

variable "node_count" {
  type    = number
  default = 3
}

variable "node_size" {
  description = "Provider-specific machine type."
  type        = string
  default     = null
}

variable "region" {
  description = "Provider-specific region or location."
  type        = string
  default     = null
}

variable "argocd_application" {
  description = "Path to the Argo CD Application to apply once the cluster is up (reference/infra/argocd/application.yaml)."
  type        = string
  default     = null
}
