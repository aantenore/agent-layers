# L0 Infra

## Purpose

Run and provision everything else: containers locally, cloud resources and secrets for real deployments. Nothing in
the upper layers depends on a specific cloud or orchestrator.

## Standard

- OCI images and the Compose Spec for running services.
- OpenTofu (HCL) for provisioning.
- Helm for Kubernetes later; not part of this repository yet.

## Extension point

- One `compose.yml` per layer in `layers/<layer>/`. A layer is added or removed by adding or removing its file.
- OpenTofu modules under `layers/l0-infra/opentofu/`.

## Reference implementation

| Concern | Reference | License |
|---|---|---|
| Local run | Docker Compose | Apache-2.0 |
| Provisioning | OpenTofu module skeleton (docs only) | MPL-2.0 |
| Secrets | OpenBao (docs only) | MPL-2.0 |

The OpenTofu skeleton and the secrets notes are documentation. They are not exercised by tests.

## How to swap it

- Podman or nerdctl can run the same compose files.
- Terraform, Pulumi or Crossplane can replace OpenTofu; the layers only need the endpoints listed in
  [contracts.md](../contracts.md#host-ports-and-environment).
- Any secret store that can inject environment variables replaces OpenBao (Vault, cloud secret managers, SOPS).

## Conventions for layer compose files

- Read configuration from the repository `.env` (the Makefile passes `--env-file .env`).
- Publish the host ports from the contract table, bind them to `127.0.0.1`.
- Define a healthcheck for every service so `up --wait` is meaningful.
- Reach host-only services (Ollama) at `host.docker.internal:11434`.
- `make up-all` merges every `layers/*/compose.yml` with multiple `-f` flags. Compose resolves relative paths
  against the first file, so keep bind-mount paths in layer compose files unambiguous (prefer named volumes or
  paths that work from the repository root).

## Contract summary

L0 has no data contract. Its interface is the port and environment table in [contracts.md](../contracts.md#host-ports-and-environment).

## How to test

```bash
make up LAYER=<layer>      # `--wait` fails if a healthcheck never turns healthy
make down LAYER=<layer>
```

See [`layers/l0-infra`](../../layers/l0-infra) for the OpenTofu skeleton and the secrets notes.
