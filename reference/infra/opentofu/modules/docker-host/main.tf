# Installs Docker on a plain Linux host over SSH and runs the compose target there.
# The module never creates the machine: pair it with any provider (see ../../examples).

locals {
  layer_commands = [for l in var.layers : "make up LAYER=${l}"]

  script = [
    "set -eu",
    "command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh",
    "command -v git >/dev/null 2>&1 || (apt-get update && apt-get install -y git make) || dnf install -y git make",
    "if [ -d ${var.install_dir}/.git ]; then git -C ${var.install_dir} fetch --tags origin && git -C ${var.install_dir} checkout ${var.repo_ref}; else git clone ${var.repo_url} ${var.install_dir} && git -C ${var.install_dir} checkout ${var.repo_ref}; fi",
    "cd ${var.install_dir}",
    "[ -f .env ] || cp .env.example .env",
    "make infra-up TARGET=compose",
  ]
}

resource "terraform_data" "compose_target" {
  triggers_replace = {
    host   = var.ssh_host
    ref    = var.repo_ref
    layers = join(",", var.layers)
    env    = sha256(var.env_file)
  }

  connection {
    type        = "ssh"
    host        = var.ssh_host
    user        = var.ssh_user
    port        = var.ssh_port
    private_key = var.ssh_private_key
  }

  provisioner "remote-exec" {
    inline = ["mkdir -p ${var.install_dir} || (sudo mkdir -p ${var.install_dir} && sudo chown $(id -u):$(id -g) ${var.install_dir})"]
  }

  provisioner "file" {
    content     = var.env_file
    destination = "${var.install_dir}/.env.rendered"
  }

  provisioner "remote-exec" {
    inline = concat(
      local.script,
      ["[ ! -s .env.rendered ] || mv .env.rendered .env"],
      local.layer_commands,
    )
  }
}
