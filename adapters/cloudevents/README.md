# @agent-layers/adapter-cloudevents

Exposes **TriggerPort** through **CloudEvents 1.0 HTTP binding** (layer `interface`). Direction: inbound. Tier:
prototype, production. Maturity: experimental.

The gateway mounts it at `POST /v1/events` (configurable). Each accepted event starts one background run and the
response is `202` with the run id. The adapter implements `mount` only; it has no `start`.

## Events

- **Structured mode**: `Content-Type: application/cloudevents+json` (a charset is fine). The body is one JSON object
  with `specversion` (`"1.0"` only), `id`, `source`, `type`, and optionally `time`, `subject`, `datacontenttype`,
  `data` or `data_base64`, and extensions.
- **Binary mode**: any other content type, with the `ce-specversion`, `ce-id`, `ce-source` and `ce-type` headers (and
  optionally `ce-time`, `ce-subject`). The body is the data: parsed JSON for `application/json` and `+json`, text for
  `text/*`, a base64 string otherwise.
- **Batch mode** (`application/cloudevents-batch+json`) is not supported and answers `415`. Send one event per request.

The CloudEvent `id` is returned as `eventId` but is not used as the run id (an external id can collide), and the
adapter does not de-duplicate redeliveries.

## Routing and templates

Routes are tried in order and the first match wins. `type` (and the optional `source`) are globs with `*` and `?`. An
event that matches no route gets a `404` and nothing runs.

`input` is the run input template. It reads `{{type}}`, `{{source}}`, `{{id}}`, `{{subject}}`, `{{time}}`, `{{data}}`
(JSON unless the data is a string) and `{{data.<path>}}` (dot path into object data; a missing value is an empty
string, objects are JSON). Nothing else is evaluated. Without `input` the run input is the event data as a string.

## Identity

- With `credential` set, that service credential is verified through the identity layer for every event and becomes the
  run identity. If it cannot be verified (or there is no identity layer) the answer is `401`; it never falls back to the
  caller or to anonymous.
- Without it, the run identity is the HTTP caller, as verified by the gateway.
- With neither identity the answer is `401`, unless the gateway sets `anonymous: true` (refused on the production tier).

The credential is never logged or echoed.

## Responses

| Status | When |
|---|---|
| `202` | Accepted: `{ "runId", "agent", "eventId" }` |
| `400` | Invalid event (missing attribute, `specversion` other than `1.0`, bad JSON) |
| `401` | No usable identity, or the configured credential was not accepted (`WWW-Authenticate: Bearer realm="agent-layers"`) |
| `403`, `404` | The host refused the trigger, or the route or agent was not found |
| `405` | Method other than `POST` |
| `415` | Batch mode |
| `500` | Unexpected failure, without the error text |

Errors have the shape `{ "error": { "message", "type" } }`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | `/v1/events` | Path of the endpoint |
| `routes` | object[] | required | `{ type, agent, input?, source? }`, at least one |
| `credential` | string | none | Service credential verified per event and used as the run identity |

```json
{ "layers": { "triggers": [{ "adapter": "cloudevents", "options": { "credential": "${secret:EVENTS_TOKEN}", "routes": [{ "type": "com.example.order.*", "agent": "assistant", "input": "New order event {{id}}: {{data}}" }] } }] } }
```
