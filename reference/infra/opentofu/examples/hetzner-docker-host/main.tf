# EXAMPLE, NOT THE PLATFORM: one VM on Hetzner Cloud running the compose target.
# Hetzner is only here because its provider is open and simple. Swap the server resource for any other provider
# (libvirt, AWS, OVH, bare metal): the docker-host module only needs an SSH address.

terraform {
  required_version = ">= 1.8"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.48"
    }
  }
}

variable "hcloud_token" {
  type      = string
  sensitive = true
}

variable "ssh_public_key" {
  description = "Public key authorised on the VM."
  type        = string
}

variable "ssh_private_key" {
  description = "Matching private key (content). Null uses the local SSH agent."
  type        = string
  default     = null
  sensitive   = true
}

variable "server_type" {
  type    = string
  default = "cx32"
}

variable "location" {
  type    = string
  default = "fsn1"
}

variable "layers" {
  type    = list(string)
  default = ["knowledge"]
}

provider "hcloud" {
  token = var.hcloud_token
}

resource "hcloud_ssh_key" "this" {
  name       = "agent-layers"
  public_key = var.ssh_public_key
}

resource "hcloud_server" "this" {
  name        = "agent-layers"
  image       = "ubuntu-24.04"
  server_type = var.server_type
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.this.id]
}

module "docker_host" {
  source = "../../modules/docker-host"

  ssh_host        = hcloud_server.this.ipv4_address
  ssh_private_key = var.ssh_private_key
  layers          = var.layers
}

output "endpoint" {
  value = module.docker_host.endpoint
}
