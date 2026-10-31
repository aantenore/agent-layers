# DeployPort

Layer: `infra` (L0 Infrastructure & delivery) · Version: 1.0.0 · Conformance: `checkDeploy`

## Purpose

Describe the services of a stack once and get them running on a target, or get the files and steps needed to run them. A developer can review a plan before anything starts, then bring the same services up and down.

## Operations

- `plan(services: [ServiceSpec], opts?: DeployOptions) → DeployPlan`
  Compute what deploying the services would produce, without changing the target. Returns the artifacts (files with their content) and the ordered human-readable steps.
- `up(services: [ServiceSpec], opts?: DeployOptions) → [Endpoint]`
  Start the services and return one endpoint per service that exposes one.
- `down(services: [ServiceSpec], opts?: DeployOptions) → ()`
  Stop and remove what `up` started for these services.

## Data shapes

[ServiceSpec](../schemas/service-spec.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | String, required | Service name. |
| `layer?` | Layer id | Layer the service belongs to, so a target can use its reference setup for that layer. |
| `image?` | String | Image or package to run. |
| `env?` | {String: String} | Plain environment values. |
| `secretRefs?` | [String] | References resolved by the target, never values. |
| `ports?` | [Integer] | Ports the service listens on. |
| `health?` | {`url?`: String, `command?`: [String]} | How to check the service is healthy. |

Other shapes (no schema yet):

- `DeployPlan`: `artifacts: [{path: String, content: String}]`, `steps: [String]`.
- `Endpoint`: `service: String`, `url: String`.
- `DeployOptions`: `profile?: String`, `signal?: Signal`, `dryRun?: Boolean`.

## Semantics

- `plan` has no side effects on the target. It may be called with `dryRun: true`.
- Secrets are references. A plan and its artifacts must not contain secret values; the target resolves references at deploy time (see [SecretPort](SecretPort.md)).
- `profile` selects a variant of the setup, such as a development or production profile. Its values are defined by the adapter.
- `up` and `down` honour `signal`: when it fires they stop and fail with a cancellation error.
- Deploying is slow compared with other ports; callers should allow minutes, not seconds.

## Errors

- A service spec the target cannot honour, an unreachable target or a failed start rejects the operation.
- A plan that needs nothing to be done is a normal result with empty `steps`, not an error.

## Escape hatch

The shapes of this port have no `ext`. An adapter that needs more keeps it in its own configuration, and its descriptor declares any `ext` keys it writes or reads in `ext.produces` / `ext.reads` (namespaced). `native()` returns the underlying deployment client or file model. `ServiceSpec.layer` and `profile` are hints; adapters may ignore hints they do not understand.

## Conformance

`checkDeploy` verifies:

- Fixture services validate against `service-spec.json`.
- `plan` with `dryRun: true` resolves; artifacts are `{path, content}` strings and steps are strings.
- The plan does not inline secret values (a placeholder secret in the fixture must not appear).
- When the live fixture is enabled: `up` resolves to a list of endpoints and `down` completes. Otherwise this part is skipped.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): baseline only, no shape changes
- 0.1.0 — initial

Example adapters: `compose-deploy` (maps a Compose file).
