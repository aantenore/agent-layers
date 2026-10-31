terraform {
  required_version = ">= 1.8"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "layer_env" {
  description = "Environment variables for the layers, same names as .env.example."
  type        = map(string)
  default     = {}
}

variable "layer_secrets" {
  description = "Secret names the layers expect; values come from the secret store, never from variables."
  type        = list(string)
  default     = ["OIDC_CLIENT_SECRET", "LLM_GUARD_TOKEN", "GATEWAY_KEY", "LANGFUSE_SECRET_KEY"]
}

# Placeholders: point each source at a real module for your target.

module "network" {
  source      = "./modules/network"
  environment = var.environment
}

module "data" {
  source      = "./modules/data"
  environment = var.environment
  network_id  = module.network.id
}

module "secrets" {
  source      = "./modules/secrets"
  environment = var.environment
  names       = var.layer_secrets
}

module "runtime" {
  source      = "./modules/runtime"
  environment = var.environment
  network_id  = module.network.id
  env         = var.layer_env
  secret_refs = module.secrets.refs
}

output "harness_endpoint" {
  value = module.runtime.harness_endpoint
}
