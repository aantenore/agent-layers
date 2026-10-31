# L0 Infra

Deploy targets, ingress, secrets and provisioning for the platform. Documentation, including the deploy-target
contract: [docs/layers/L0-infra.md](../../docs/layers/L0-infra.md).

| Path | Content |
|---|---|
| `compose.yml` | target `compose`: Traefik (8088, dashboard 8089) and OpenBao in dev mode (8200) |
| `traefik/` | static config and file-provider routes (`<name>.localhost`) for the other layers |
| `scripts/` | `seed-secrets.sh`, `env-from-openbao.sh` (curl + jq) |
| `helm/agent-layers/` | target `k8s`: umbrella chart, one helper template for every service |
| `argocd/application.yaml` | GitOps Application that syncs the chart |
| `opentofu/` | `modules/docker-host`, `modules/k8s-cluster` (interface), `examples/` (swap for your provider) |
| `targets/` | optional `*.mk` files that add your own `infra-up-<name>` / `infra-down-<name>` |
| `test/` | live test of Traefik and OpenBao |

```bash
make infra-up && make secrets-seed
make helm-template
make tofu-validate
```
