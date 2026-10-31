# OpenTofu

Provisioning for the compose and k8s targets. Nothing here is applied by the tests; `make tofu-validate` runs
`tofu fmt -check` and `tofu validate` (init with `-backend=false`) in a pinned container.

| Path | Purpose |
|---|---|
| `modules/docker-host` | Takes an SSH address, installs Docker, runs the compose target (`make infra-up`, `make up LAYER=...`). Output: `endpoint`. Does not create the machine. |
| `modules/k8s-cluster` | Interface only: `name`, `node_count`, `node_size`, `region`, `kubernetes_version` in; `endpoint`, `kubeconfig`, `ingress_address` out. Add your provider in `main.tf`. |
| `examples/hetzner-docker-host` | Example only: a Hetzner Cloud VM plus `docker-host`. Replace the `hcloud_*` resources with your provider's. |

```bash
cd examples/hetzner-docker-host
tofu init
tofu plan -var hcloud_token=... -var ssh_public_key="$(cat ~/.ssh/id_ed25519.pub)"
```

Keep `*.tfvars` out of git (already ignored). Pass the `.env` for the host as `env_file`, rendered from OpenBao with
`scripts/env-from-openbao.sh`. State: configure a remote backend in your own root module; the examples use local state.

OpenTofu is MPL-2.0. Terraform (BUSL-1.1) is not required.
