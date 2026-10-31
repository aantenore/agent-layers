# @agent-layers/adapter-opa

Maps **Open Policy Agent** (Data API) → **AuthorizationPort** (layer `identity`). Tier: production. Maturity:
experimental. Zero runtime dependencies.

`evaluate(request)` calls `POST <url>/v1/data/<path>` with `{ "input": <AccessRequest> }`. The rule must evaluate to
a boolean or to `{ "allow": boolean, "reason"?: string }`. The reference policy
([reference/identity/policies/agents.rego](../../reference/identity/policies/agents.rego)) defines both:
`agents/allow` and `agents/decision` (the default path).

- Fail closed: an undefined rule (wrong path, missing policy), a non-boolean result, a non-2xx answer, a timeout, a
  redirect or an answer over 1 MB rejects, and the stack turns a rejection into a deny.
- Subjects: only an authenticated subject of type exactly `user` or `agent` is sent as is (with `authenticated: true`).
  Anything else, including calls without identity, is sent as `{ "type": "anonymous", "id": "anonymous" }` with
  `authenticated: false`. Policies should allow only subjects with `authenticated == true`.
- Tool arguments (`input.context.args`) stay inside the stack unless `includeArgs` is set.
- HTTPS is required except on loopback hosts or with `allowHttp`.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | OPA base URL |
| `path` | string | `agents/decision` | Rule path under `/v1/data`, e.g. `agents/allow` |
| `headers` | {string: string} | none | Extra headers, e.g. `authorization` for OPA with `--authentication=token` |
| `includeArgs` | boolean | `false` | Send the tool-call arguments |
| `timeoutMs` | integer | `5000` | Request timeout |
| `allowHttp` | boolean | `false` | Plain HTTP outside loopback hosts |

```json
{ "layers": { "authorization": { "adapter": "opa", "options": { "url": "${env:OPA_URL}" } } } }
```

The live test against Keycloak and OPA is in [adapters/oidc/test/live.test.ts](../oidc/test/live.test.ts).
