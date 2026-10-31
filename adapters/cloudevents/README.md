# @agent-layers/adapter-cloudevents

Exposes **TriggerPort** through **CloudEvents 1.0 HTTP binding** (layer `interface`). Direction: inbound. Tier:
prototype, production. Maturity: experimental.

The gateway mounts it at `POST /v1/events` (configurable). Each accepted event starts one background run and the
response is `202` with the run id. The adapter implements `mount` only; it has no `start`.

## Events

- **Structured mode**: `Content-Type: application/cloudevents+json` (a charset is fine). The body is one JSON object
  with `specversion` (`"1.0"` only), `id`, `source`, `type`, and optionally `time`, `subject`, `datacontenttype`,
  `dataschema`, `data` or `data_base64`, and extensions.
- **Binary mode**: any other content type, with the `ce-specversion`, `ce-id`, `ce-source` and `ce-type` headers (and
  optionally `ce-time`, `ce-subject`, `ce-dataschema` and extension attributes). The body is the data: parsed JSON for `application/json` and `+json`, text for
  `text/*`, a base64 string otherwise.
- **Batch mode** (`application/cloudevents-batch+json`) is not supported and answers `415`. Send one event per request.

## The trigger

Each accepted event becomes a `Trigger`:

| Trigger field | From |
|---|---|
| `id` | A new id per delivery (the SDK's own) |
| `kind` | `type` |
| `source` | `source` |
| `at` | `time`, when it is a valid RFC 3339 time |
| `agent` | the matching route |
| `data` | the route's `input` template rendered over the event |
| `ext["cloudevents.id"]` | the upstream `id` |
| `ext["cloudevents.subject"]` | `subject` |
| `ext["cloudevents.datacontenttype"]` | `datacontenttype` (binary mode: the `Content-Type` header) |
| `ext["cloudevents.dataschema"]` | `dataschema` |
| `ext["cloudevents.extensions"]` | extension attributes as one object: names of 1 to 20 lower-case letters and digits, string, number or boolean values; others are ignored |

Absent attributes are omitted. The SDK `id` is unique per delivery on purpose: the reference host uses it as the run
id, and a redelivery of the same event is another firing. To deduplicate, use the pair `source` and
`ext["cloudevents.id"]`, which CloudEvents defines as the identity of an event and which is stable across redeliveries.
The adapter itself does not deduplicate. The upstream `id` is also returned as `eventId`.

Each event is handled inside a span `cloudevents.receive` (layer `interface`) with `agent.trigger.kind` (the event
`type`) and `agent.name`.

### Mappings

`mappingDefaults.in` on `Trigger`: rules from the stack config (`mappings.triggers.cloudevents.in`) run after the
adapter's own translation. They read the event as a flat document (`/id`, `/source`, `/type`, `/subject`,
`/datacontenttype`, `/dataschema`, extension attributes by name, `/data`) and write the trigger or
`/ext/cloudevents.<name>`. Without rules the trigger is unchanged.

## Routing and templates

Routes are tried in order and the first match wins. `type` (and the optional `source`) are globs with `*` and `?`. An
event that matches no route gets a `404` and nothing runs.

`input` is the run input template. It reads `{{type}}`, `{{source}}`, `{{id}}`, `{{subject}}`, `{{time}}`, `{{data}}`
(JSON unless the data is a string) and `{{data.<path>}}` (dot path into object data; a missing value is an empty
string, objects are JSON). Nothing else is evaluated. Without `input` the run input is the event data as a string.

## Identity

- With `credential` set, that service credential is verified through the identity layer for every event and becomes the
  run caller (`accept(trigger, { caller })`). If it cannot be verified (or there is no identity layer) the answer is
  `401`; it never falls back to the HTTP caller or to anonymous.
- Without it, the run caller is the HTTP caller, as verified by the gateway.
- With neither caller the answer is `401`, unless the gateway sets `anonymous: true` (refused on the production tier).

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
| `credential` | string | none | Service credential verified per event and used as the run caller |

```json
{ "layers": { "triggers": [{ "adapter": "cloudevents", "options": { "credential": "${secret:EVENTS_TOKEN}", "routes": [{ "type": "com.example.order.*", "agent": "assistant", "input": "New order event {{id}}: {{data}}" }] } }] } }
```

`ext` keys written: `cloudevents.id`, `cloudevents.subject`, `cloudevents.datacontenttype`, `cloudevents.dataschema`, `cloudevents.extensions`.
