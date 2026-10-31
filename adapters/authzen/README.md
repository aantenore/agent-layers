# @agent-layers/adapter-authzen

Maps **OpenID AuthZEN** → **AuthorizationPort** (layer `identity`). Tier: production. Maturity: experimental.
Zero runtime dependencies.

`evaluate(request)` posts the AccessRequest to the AuthZEN Authorization API 1.0 access evaluation endpoint
(`POST <url>/access/v1/evaluation`) and returns its `decision`. Any AuthZEN PDP works: Topaz, Cerbos, Aserto,
OpenFGA or Axiomatics through their AuthZEN interface, or your own.

- Fail closed: a missing or non-boolean `decision`, a non-2xx answer, a timeout, a redirect or an answer over 1 MB
  rejects, and the stack turns a rejection into a deny.
- The deny reason is `context.reason` or `context.reason_user` (a string or a `{lang: text}` object), cut to 200
  characters. `reason_admin` is never passed on: the model sees the reason.
- Subjects: only an authenticated subject of type exactly `user` or `agent` is sent as is (with `authenticated: true`).
  Anything else, including calls without identity, is sent as `{ type: "anonymous", id: "anonymous" }` with
  `authenticated: false`, so a policy cannot mistake an unauthenticated call for the agent. Policies should allow
  only `authenticated == true` subjects.
- Tool arguments (`context.args`) stay inside the stack unless `includeArgs` is set.
- HTTPS is required except on loopback hosts or with `allowHttp`.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | PDP base URL |
| `path` | string | `/access/v1/evaluation` | Evaluation path |
| `headers` | {string: string} | none | Extra headers, e.g. an API key from `${env:...}` |
| `includeArgs` | boolean | `false` | Send the tool-call arguments |
| `timeoutMs` | integer | `5000` | Request timeout |
| `allowHttp` | boolean | `false` | Plain HTTP outside loopback hosts |

```json
{ "layers": { "authorization": { "adapter": "authzen", "options": { "url": "${env:AUTHZEN_URL}", "headers": { "authorization": "Bearer ${env:PDP_KEY}" } } } } }
```
