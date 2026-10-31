# L0 Infra

Containers and provisioning for the platform. Documentation: [docs/layers/L0-infra.md](../../docs/layers/L0-infra.md).

| Path | Content |
|---|---|
| `opentofu/` | Provider-agnostic module skeleton (docs only, not tested) |
| `secrets/` | OpenBao notes (docs only, not tested) |

Locally, each layer brings its own `compose.yml` under `layers/<layer>/`. Use `make up LAYER=<layer>` or
`make up-all` from the repository root.

Standards: OCI images, Compose Spec, OpenTofu (HCL). Helm charts are planned for Kubernetes.
