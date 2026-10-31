# @agent-layers/adapter-http-guard

Maps the **agent-layers guard HTTP contract** → **GuardPort** (layer `guardrail`). Tiers: prototype, production.
Maturity: experimental.

For any guard written in another language or run as a service (NeMo Guardrails, Guardrails AI, Granite Guardian behind
a small shim, an in-house classifier). Each check is one `POST` with a `GuardCheck` JSON body; the service answers a
`GuardVerdict`.

## The contract

Request, [`guard-check.json`](../../spec/schemas/guard-check.json):

```json
{ "stage": "input", "text": "My card is 4111 1111 1111 1111", "agent": "support", "runId": "9f2c...", "tool": "crm__get", "caller": { "id": "u-1", "kind": "user", "roles": ["agent"], "scopes": [] } }
```

`stage` is `input`, `output`, `tool_args` or `tool_result`; `tool` is set for the last two; `caller` is the public
caller (`id`, `kind`, `roles`, `scopes`, `name?`, `ext?`), never its credential. For `tool_args`, `text` is the JSON-encoded arguments.

Response, [`guard-verdict.json`](../../spec/schemas/guard-verdict.json), HTTP 200 and JSON:

```json
{ "action": "redact", "text": "My card is [CARD]", "labels": ["pii"], "reason": "card number" }
```

`action` is `allow`, `block` or `redact`; `text` is required for `redact` and must be a rewrite of the request text;
`labels` (optional, at most 64 strings) are values of the guard label vocabulary (`pii`, `secret`, `injection`,
`toxicity`, `policy`, `other`, plus what the stack config adds): an unknown one becomes `other` and its value is kept
under `ext["http-guard.labels"]`; `reason` is free text for the audit trail. Other fields, `ext` included, are dropped. A `redact` at `tool_args` must still be a JSON
object, otherwise the stack blocks the call.

Fails closed: a non-2xx answer, a timeout, a body that is not JSON or larger than `maxResponseBytes`, an unknown
`action`, a `redact` without `text` or `labels` that are not such a list becomes a `block` with the reason
`guard service unavailable: <cause>`, where the cause is one of `HTTP <status>`, `redirects are not followed (HTTP
<status>)`, `timeout`, `response too large`, `invalid response`, `network error`. Redirects are never followed, so the
text and the token stay with the configured host. Error text and response bodies are not copied into reasons. URLs with credentials
are rejected at creation: use `token` or `headers`.

A minimal service in Node, as a template for other languages:

```js
import { createServer } from 'node:http';
createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const { text } = JSON.parse(raw);
    const verdict = /forbidden/i.test(text) ? { action: 'block', reason: 'forbidden word' } : { action: 'allow' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(verdict));
  });
}).listen(8099);
```

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | Endpoint that receives the `POST` |
| `token` | string | none | Sent as `Authorization: Bearer <token>` |
| `headers` | object | none | Extra request headers |
| `stages` | string[] | all | Stages the guard runs at |
| `onError` | `"block"` \| `"allow"` | `"block"` | Fail closed or open when the service fails |
| `timeoutMs` | integer | 10000 | Per-request timeout |
| `maxResponseBytes` | integer | 1048576 | Largest answer read; a larger one is a failure (`onError`) |

Limits accept `${env:NAME}`; `timeoutMs` and `maxResponseBytes` also accept `"unbounded"`, which `agent-layers check`
fails on the production tier.
Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{
  "layers": {
    "guardrails": [
      { "adapter": "http-guard", "options": { "url": "http://localhost:8099/check", "token": "${secret:GUARD_TOKEN}", "stages": ["input", "output"] } }
    ]
  }
}
```
