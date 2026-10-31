# OpenTofu skeleton

Reference module layout for provisioning the platform on any cloud. It contains placeholders only: no provider is
configured, and nothing here is applied by the tests.

Licenses: OpenTofu is MPL-2.0. Terraform-compatible tooling (Terraform itself is BUSL-1.1, not OSI-approved) is
not required.

## Layout

`main.tf` declares one module call per platform concern. Replace each `source` with a module for your target
(Kubernetes, a cloud VM, a managed service), and add the provider block in your own root configuration.

| Module | Provisions |
|---|---|
| `network` | private network, ingress for L2 (8700) and the identity provider |
| `data` | volumes or managed services for Qdrant (L3), Valkey (L7), Langfuse storage (L8) |
| `runtime` | compute for the L2 harness and the gateway |
| `secrets` | secret store and access policies, see [../secrets](../secrets/README.md) |

## Usage

```bash
tofu init
tofu plan -var-file=env.tfvars     # env.tfvars is git-ignored
```

Pass the same names as `.env.example` as module inputs so the layers see identical configuration everywhere.
