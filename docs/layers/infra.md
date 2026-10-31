# L0 Infra

## Purpose

Run and provision everything else: containers locally, a VM or a cluster for real deployments, ingress and secrets.
Nothing in the upper layers depends on a specific cloud or orchestrator. The deploy target is itself an adapter.

## Standard

- OCI images and the Compose Spec for running services.
- Kubernetes API and Helm for clusters.
- OpenTofu (HCL) for provisioning.
- The Vault-compatible secrets API (KV v2 over HTTP) for secrets.

## Deploy-target contract

A target takes a list of services and returns the endpoints they are reachable at.

Input, one entry per service:

| Field | Meaning |
|---|---|
| `image` | OCI image with a pinned tag (never `latest`) |
| `env` | plain environment variables, same names as `.env.example` |
| `secretRefs` | names of secrets injected as environment variables; values come from the secret store, never from the files |
| `ports` | container ports the service listens on |
| `health` | HTTP path (or TCP port) that tells the target the service is ready |

Output: the public endpoints, one per service that is meant to be reached (`<service>.<domain>` or a host port).

Each layer keeps its own `layers/<id>/compose.yml` as the source of truth for that list. Targets read or mirror it;
they do not redefine it. The Helm values carry the same image tags for the layers they include.

| Target | Reads | Gives you |
|---|---|---|
| `compose` | `layers/*/compose.yml` | laptop or single VM; Traefik routes `<name>.localhost:8088` |
| `k8s` | `helm/agent-layers/values.yaml` | any Kubernetes cluster; Argo CD syncs the chart |
| your own | whatever you like | see [Bring your own target](#bring-your-own-target) |

## Extension point

- One `compose.yml` per layer in `layers/<layer>/`. A layer is added or removed by adding or removing its file.
- A deploy target: a `make infra-up-<name>` / `infra-down-<name>` pair.
- OpenTofu modules under `layers/l0-infra/opentofu/`.

## Reference implementation

| Concern | Reference | License |
|---|---|---|
| Run (laptop, one VM) | Docker Compose | Apache-2.0 |
| Ingress | Traefik v3 | MIT |
| Secrets | OpenBao (dev mode locally) | MPL-2.0 |
| Kubernetes | Helm umbrella chart + Argo CD (GitOps) | Apache-2.0 |
| Provisioning | OpenTofu | MPL-2.0 |

The compose target, the chart, the OpenTofu modules and the scripts are checked in CI (`helm lint`/`template`,
`tofu validate`) and the compose target has a live test. Applying the OpenTofu example to a real cloud and syncing
the chart on a real cluster are not exercised by tests.

## Target `compose`

```bash
make infra-up            # Traefik + OpenBao, waits for healthchecks
make secrets-seed        # writes the platform secrets into OpenBao
make env-from-openbao    # renders .env from OpenBao (refuses to overwrite; FORCE=1 to overwrite)
make up LAYER=l3-knowledge
make infra-down          # removes the containers and the dev OpenBao data
```

Host ports, all on `127.0.0.1`:

| Port | Service | Variable |
|---|---|---|
| 8088 | Traefik HTTP entry point | `INFRA_HTTP_PORT` |
| 8089 | Traefik dashboard and API | `INFRA_DASHBOARD_PORT` |
| 8200 | OpenBao API and UI | `OPENBAO_PORT` |

Traefik is on 8088, not 80/443, so it does not clash with whatever already owns those ports. TLS is off locally;
terminate it in front of Traefik, or add an ACME resolver in `traefik/traefik.yml` on a real host.

### Ingress

`layers/l0-infra/traefik/dynamic/routes.yml` (Traefik file provider) routes by hostname to the services published by
the other layers, so their compose files are not edited:

```bash
curl http://qdrant.localhost:8088/readyz
curl http://openbao.localhost:8088/v1/sys/health
```

Names: `openbao`, `ollama`, `harness`, `qdrant`, `httpbin`, `openapi-mcp`, `keycloak`, `opa`, `presidio-analyzer`,
`presidio-anonymizer`, `llm-guard`, `gateway`, `otlp`, `langfuse`, `jaeger`. Ports are the defaults from
[contracts.md](../contracts.md#host-ports-and-environment); if you move a layer to another port, edit its route.
Routes to layers that are not running answer `502`. The dashboard is reachable on loopback only.

Routes reach the layers through `host.docker.internal`. On Docker Desktop this works with ports bound to
`127.0.0.1`. On Linux the host gateway cannot reach loopback-bound ports: publish the layer on `0.0.0.0`, or switch
Traefik to the Docker provider (commented in `traefik.yml`; it needs the Docker socket mounted, so it is opt-in).

`make up-all` leaves out `layers/l0-infra/compose.yml`: it uses relative bind mounts, which would break when merged
with other layers' files, and infra is started with `infra-up`.

### Secrets

OpenBao runs in **dev mode**: in-memory, auto-unsealed, no TLS, fixed root token (`OPENBAO_DEV_ROOT_TOKEN`, default
`dev-root-token`). Data is gone when the container stops. Development only; for anything else run OpenBao in server
mode with persistent storage, TLS and real policies, or use another Vault-compatible store.

- `scripts/seed-secrets.sh` writes `OIDC_CLIENT_SECRET`, `GATEWAY_KEY`, `LLM_GUARD_TOKEN`, `LANGFUSE_PUBLIC_KEY` and
  `LANGFUSE_SECRET_KEY` to KV v2 at `secret/agents/<env>/{identity,gateway,guardrails,telemetry}` (`AGENTS_ENV`,
  default `dev`). Values come from the environment, then `.env`, then `.env.example`.
- `scripts/env-from-openbao.sh [-o FILE] [-b BASE] [-f]` reads every secret under `secret/agents/<env>/` and renders
  an env file: `BASE` (default `.env.example`) with those keys replaced, or appended if missing. Output goes to stdout
  or a mode-600 file. Needs only `curl` and `jq`.

Both scripts talk to `BAO_ADDR` (default `http://127.0.0.1:8200`) with `BAO_TOKEN` (default
`OPENBAO_DEV_ROOT_TOKEN`), so they work unchanged against HashiCorp Vault or any compatible server.

## Target `k8s`

`layers/l0-infra/helm/agent-layers` is an umbrella chart. `values.yaml` has one block per layer with an `enabled`
flag and, for each service, the image and pinned tag, port, health path, env, secret references and ingress flag. A
single helper (`templates/_service.tpl`) renders a Deployment, Service, optional PVC and optional Ingress for every
service of every enabled layer. Secrets are read from the Kubernetes Secret named in `global.secretName`; fill it
from OpenBao with the External Secrets Operator or the CSI provider.

The chart is a skeleton: it covers the stateless and simple stateful services. Services that need a config file (the
LiteLLM gateway, the OTel collector) and multi-container stacks (Langfuse) still need their own templates or an
upstream chart.

GitOps: `layers/l0-infra/argocd/application.yaml` points Argo CD at the chart path. `make infra-up TARGET=k8s`
applies it with `kubectl`; later changes are commits.

```bash
make helm-template       # helm lint + helm template through a pinned container image
```

## OpenTofu

```
opentofu/
  modules/docker-host/        any SSH-reachable Linux host -> Docker + the compose target; outputs `endpoint`
  modules/k8s-cluster/        interface only (variables, outputs `endpoint`, `kubeconfig`); add your provider
  examples/hetzner-docker-host/   example: one Hetzner Cloud VM + docker-host. Swap it for your own provider.
```

`docker-host` does not create machines. It takes `ssh_host`, `ssh_user` and a key, installs Docker if missing, clones
the repository at `repo_ref`, writes the `.env` you pass, runs `make infra-up` and `make up LAYER=<id>` for each
entry of `layers`. Render `env_file` from OpenBao rather than writing secrets into tfvars.

```bash
make tofu-validate       # tofu fmt -check, init -backend=false, validate; pinned container image
```

## Bring your own target

A target is two Make targets. Drop a file in `layers/l0-infra/targets/` (it is included automatically):

```make
# layers/l0-infra/targets/nomad.mk
infra-up-nomad:
	nomad job run deploy/agent-layers.nomad.hcl
infra-down-nomad:
	nomad job stop agent-layers
```

Then `make infra-up TARGET=nomad`. Honour the contract: pinned OCI images from the layer compose files, the same
environment variable names, secrets injected from the store, and the health paths as readiness checks. Podman and
nerdctl can run the compose files as they are; Terraform, Pulumi or Crossplane can replace OpenTofu; any store that
injects environment variables can replace OpenBao (Vault, cloud secret managers, SOPS); Nginx, Caddy or a cloud load
balancer can replace Traefik.

## Pinned tools

All in the [Makefile](../../Makefile) (`HELM_IMAGE`, `TOFU_IMAGE`) and `layers/l0-infra/compose.yml`: Traefik
`v3.7.17`, OpenBao `2.7.2`, Helm `3.22.1` (`alpine/helm`), OpenTofu `1.13.5` (`ghcr.io/opentofu/opentofu`). Helm and
OpenTofu run in containers, nothing is installed on the host.

## Pipeline

`.github/workflows/ci.yml` runs on `workflow_dispatch` only. Jobs: `lint` (`node --check`, JSON parse, Helm, OpenTofu),
`layer-tests` (matrix over the `layers` input: `make up`, `make test`, `make down`) and `release`, which documents the
dev, staging, prod image promotion (same digest, no rebuild, approval on `prod`) but builds nothing yet.

## Conventions for layer compose files

- Read configuration from the repository `.env` (the Makefile passes `--env-file .env`).
- Publish the host ports from the contract table, bind them to `127.0.0.1`.
- Define a healthcheck for every service so `up --wait` is meaningful.
- Reach host-only services (Ollama) at `host.docker.internal:11434`.
- `make up-all` merges every layer's `compose.yml` with multiple `-f` flags. Compose resolves relative paths against
  the first file, so keep bind-mount paths unambiguous (prefer named volumes, inline `configs`, or paths that work
  from the repository root).

## Contract summary

L0 has no data contract. Its interface is the deploy-target contract above plus the port and environment table in
[contracts.md](../contracts.md#host-ports-and-environment).

## How to test

```bash
node --test layers/l0-infra/test/infra.test.mjs   # or: make test LAYER=l0-infra
```

Brings up Traefik and OpenBao under a separate compose project (`l0-infra-test`), checks the Traefik API and a
hostname route, reads a seeded secret over the OpenBao HTTP API, renders an env file, then runs `down -v`. It skips
with a clear message when Docker is missing or 8088, 8089 or 8200 is taken (override with the port variables above).
