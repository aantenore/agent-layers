# @agent-layers/adapter-http-guard

Maps the **agent-layers guard HTTP contract** → **GuardPort** (layer `guardrail`). Tiers: prototype, production.
Maturity: experimental.

For any guard written in another language or run as a service (NeMo Guardrails, Guardrails AI, Granite Guardian behind
a small shim, an in-house classifier). Each check is one `POST` with a `GuardInput` JSON body; the service answers a
`GuardVerdict`.

## The contract

Request, [`guard-request.json`](../../spec/schemas/guard-request.json):

```json
{ "stage": "input", "text": "My card is 4111 1111 1111 1111", "agent": "support", "runId": "9f2c...", "tool": "crm__get", "subject": { "subject": "u-1", "kind": "user", "roles": ["agent"] } }
```

`stage` is `input`, `output`, `tool_args` or `tool_result`; `tool` is set for the last two; `subject` is the caller
without any token. For `tool_args`, `text` is the JSON-encoded arguments.

Response, [`guard-verdict.json`](../../spec/schemas/guard-verdict.json), HTTP 200 and JSON:

```json
{ "action": "redact", "text": "My card is [CARD]", "reason": "card number" }
```

`action` is `allow`, `block` or `redact`; `text` is required for `redact` and must be a rewrite of the request text;
`reason` is free text for the audit trail. Other fields are dropped. A `redact` at `tool_args` must still be a JSON
object, otherwise the stack blocks the call.

Fails closed: a non-2xx answer, a timeout, a body that is not JSON, an unknown `action` or a `redact` without `text`
becomes a `block` with the reason `guard service unavailable: <cause>`, where the cause is one of `HTTP <status>`,
`timeout`, `invalid response`, `network error`. Error text and response bodies are not copied into reasons. URLs with
credentials are rejected at creation: use `token` or `headers`.

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

Limits accept `${env:NAME}`; `timeoutMs` also accepts `"unbounded"`, which `agent-layers check` fails on the production tier.
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
