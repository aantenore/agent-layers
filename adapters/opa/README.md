# @agent-layers/adapter-opa

Maps **Open Policy Agent** (Data API) → **AuthorizationPort** (layer `identity`). Tier: production. Maturity:
experimental. Zero runtime dependencies.

`evaluate(question)` calls `POST <url>/v1/data/<path>` with `{ "input": <AccessQuestion> }`: OPA has no request
schema of its own, so the input is the question in language names (`input.caller.kind`, `input.caller.roles`,
`input.target.risk`, `input.target.id`, `input.args`). The rule must evaluate to a boolean or to
`{ "allow": boolean, "reason"?: string }`, returned as `{ allowed, reason? }`. The reference policy
([reference/identity/policies/agents.rego](../../reference/identity/policies/agents.rego)) defines both:
`agents/allow` and `agents/decision` (the default path).

- Fail closed: an undefined rule (wrong path, missing policy), a non-boolean result, a non-2xx answer, a timeout, a
  redirect, an answer over `maxResponseBytes` (1 MB) or a failing mapping rejects, and the stack turns a rejection
  into a deny.
- Callers: only a caller of kind exactly `user` or `agent` with an id is sent as is (never its credential; `roles`
  and `scopes` as string lists). Anything else, including calls without a caller, is sent as
  `{ "kind": "anonymous", "id": "anonymous", "roles": [], "scopes": [] }`. Policies should allow only
  `input.caller.kind != "anonymous"`.
- Tool arguments (`input.args`) stay inside the stack unless `includeArgs` is set.
- Mappings: `out` rules on the `AccessQuestion` (`mappings.authorization.out`) rewrite the input before it is sent;
  they read the question as it may leave the stack (no credential, no arguments without `includeArgs`).
- HTTPS is required except on loopback hosts or with `allowHttp`.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | OPA base URL |
| `path` | string | `agents/decision` | Rule path under `/v1/data`, e.g. `agents/allow` |
| `headers` | {string: string} | none | Extra headers, e.g. `authorization` for OPA with `--authentication=token` |
| `includeArgs` | boolean | `false` | Send the tool-call arguments |
| `timeoutMs` | integer | `5000` | Request timeout |
| `allowHttp` | boolean | `false` | Plain HTTP outside loopback hosts |
| `maxResponseBytes` | integer | `1000000` | Largest decision document read; larger answers reject |
| `maxReasonChars` | integer | `200` | Longest reason passed on to the stack |

Limits accept `${env:NAME}`; `timeoutMs` and `maxResponseBytes` also accept `"unbounded"`, which `agent-layers check` fails on the production
tier. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{ "layers": { "authorization": { "adapter": "opa", "options": { "url": "${env:OPA_URL}" } } } }
```

The live test against Keycloak and OPA is in [adapters/oidc/test/live.test.ts](../oidc/test/live.test.ts).
