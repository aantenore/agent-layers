variable "ssh_host" {
  description = "Address of the machine that will run the compose target. Any Linux host reachable over SSH works, whoever created it."
  type        = string
}

variable "ssh_user" {
  description = "SSH user: root, or a user with passwordless sudo."
  type        = string
  default     = "root"
}

variable "ssh_port" {
  type    = number
  default = 22
}

variable "ssh_private_key" {
  description = "Private key (content, not a path). Null uses the local SSH agent."
  type        = string
  default     = null
  sensitive   = true
}

variable "repo_url" {
  description = "Repository that holds the layers and the Makefile."
  type        = string
  default     = "https://github.com/aantenore/agent-layers"
}

variable "repo_ref" {
  description = "Branch or tag to deploy. Use a tag for anything beyond a test."
  type        = string
  default     = "main"
}

variable "install_dir" {
  type    = string
  default = "/opt/agent-layers"
}

variable "env_file" {
  description = "Content of the .env on the host. Render it from the secret store (scripts/env-from-openbao.sh), do not write secrets in tfvars."
  type        = string
  default     = ""
  sensitive   = true
}

variable "layers" {
  description = "Layer ids to start after the infra (make up LAYER=<id>)."
  type        = list(string)
  default     = []
}

variable "http_port" {
  description = "Host port where Traefik listens; becomes part of the endpoint."
  type        = number
  default     = 8088
}
