# @agent-layers/adapter-authzen

Maps **OpenID AuthZEN** → **AuthorizationPort** (layer `identity`). Tier: production. Maturity: experimental.
Zero runtime dependencies.

`evaluate(question)` translates the `AccessQuestion` to an AuthZEN access evaluation request, posts it to the
Authorization API 1.0 endpoint (`POST <url>/access/v1/evaluation`) and returns `{ allowed, reason?, ext? }`. Any
AuthZEN PDP works: Topaz, Cerbos, Aserto, OpenFGA or Axiomatics through their AuthZEN interface, or your own.

| Language | AuthZEN |
|---|---|
| `caller.kind`, `caller.id` | `subject.type`, `subject.id` |
| `caller.roles`, `caller.scopes` | `subject.properties.roles`, `subject.properties.scopes`; `authenticated` is true for a user or agent |
| `action` | `action.name` |
| `target.kind`, `target.id` | `resource.type`, `resource.id` |
| `target.attrs`, `risk`, `layer`, `agent` | `resource.properties`; `risk`, `layer` and `agent` are written last, so an attribute cannot override them |
| `args` | `context.args`, only with `includeArgs` |
| `decision` | `allowed` |
| `context.reason`, `context.reason_user` | `reason` (a string or a `{lang: text}` object), cut to `maxReasonChars` |
| other `context` keys | `ext["authzen.context"]`; `reason_admin` is never passed on |

- Fail closed: a missing or non-boolean `decision`, a non-2xx answer, a timeout, a redirect, an answer over
  `maxResponseBytes` (1 MB) or a failing mapping rejects, and the stack turns a rejection into a deny.
- Callers: only a caller of kind exactly `user` or `agent` with an id is sent as is (never its credential). Anything
  else, including calls without a caller, is sent as `{ type: "anonymous", id: "anonymous" }` with
  `authenticated: false`, so a policy cannot mistake an unauthenticated call for the agent. Policies should allow
  only `authenticated == true` subjects.
- Mappings: `out` rules on the `AccessQuestion` (`mappings.authorization.out`) are applied to the request after the
  built-in translation, for example `{ "from": "/caller/name", "to": "/subject/properties/name" }`. They read the
  question as it may leave the stack: no credential, and no arguments without `includeArgs`.
- HTTPS is required except on loopback hosts or with `allowHttp`.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | PDP base URL |
| `path` | string | `/access/v1/evaluation` | Evaluation path |
| `headers` | {string: string} | none | Extra headers, e.g. an API key from `${env:...}` |
| `includeArgs` | boolean | `false` | Send the tool-call arguments |
| `timeoutMs` | integer | `5000` | Request timeout |
| `allowHttp` | boolean | `false` | Plain HTTP outside loopback hosts |
| `maxResponseBytes` | integer | `1000000` | Largest decision document read; larger answers reject |
| `maxReasonChars` | integer | `200` | Longest reason passed on to the stack |

Limits accept `${env:NAME}`; `timeoutMs` and `maxResponseBytes` also accept `"unbounded"`, which `agent-layers check` fails on the production
tier. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{ "layers": { "authorization": { "adapter": "authzen", "options": { "url": "${env:AUTHZEN_URL}", "headers": { "authorization": "Bearer ${env:PDP_KEY}" } } } } }
```
