# @agent-layers/gateway

Network host for a composed stack. It mounts the stack's inbound adapters (channels and triggers that implement
`mount`) on one `node:http` server, so a runtime or an app in any language reaches the layers through standards,
while identity, authorization, guardrails and telemetry stay outside the agent process.

```ts
import { compose, loadConfig } from '@agent-layers/core';
import { serveStack } from '@agent-layers/gateway';

const stack = await compose(await loadConfig('agent-layers.json', { profile: 'production' }));
const gateway = await serveStack(stack, { port: 8787, host: '0.0.0.0' });
// ... later
await gateway.close();
await stack.close();
```

From the command line: `agent-layers gateway --profile <name> [--port <n>] [--host <h>]`.

## What every request goes through

1. A request id (`x-request-id` when the client sends a valid one, otherwise a new one), echoed in the response.
2. Route lookup: exact paths before prefixes, longer before shorter; 404 or 405 with `Allow`.
3. Authentication, unless the route is `public` (discovery documents): `Authorization: Bearer <credential>` verified
   through the identity port, and the identity passed to the route. No credential: 401 with
   `WWW-Authenticate: Bearer realm="agent-layers"`, unless the config sets `anonymous: true`. A credential that does not
   verify: always 401 with `error="invalid_token"`; the adapter's error text is never returned.
4. Body limit (413) and time limit (504); an error inside a route is a 500 without its message.
5. One span `gateway.request` on the `interface` layer, with method, path (never the query string), route, inbound
   instance, status, duration and whether the caller was authenticated, plus a `gateway.requests` metric.

`GET /healthz` answers 200 while the process runs. `GET /readyz` answers 200 when the profile passes the readiness
gate and the gateway is not draining, 503 otherwise.

Triggers mounted on the gateway hand their events to a sink that starts the run in the background and answers with
its run id. A trigger run needs an identity unless the config sets `anonymous: true`.

On the production tier the gateway refuses to start without an identity adapter or with `anonymous: true`. On other
tiers, without an identity adapter it starts only with `anonymous: true`.

`close()` stops accepting connections, waits for requests and trigger runs in flight (up to `closeGraceMs`), then
releases the mounts. It does not close the stack.

## Options

The `gateway` block of the stack config, overridable per profile; `serveStack` takes the same fields.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `port` | integer | `8787` | `0` picks a free port |
| `host` | string | `127.0.0.1` | Interface to listen on |
| `inbound` | string[] | every mountable one | Instance names of the channels and triggers to mount |
| `anonymous` | boolean | `false` | Accept requests without a credential; refused on the production tier |
| `maxBodyBytes` | integer | `1048576` | Largest request body |
| `requestTimeoutMs` | integer | `300000` | Time limit of one request, streams included |
| `publicOrigin` | string | the listen address | Origin used in absolute URLs, behind a proxy |
| `cors` | `{ origins }` | off | Origins allowed to call from a browser (`*` for any) |
| `closeGraceMs` | integer | `10000` | Code only: how long `close` waits for work in flight |

```json
{ "gateway": { "port": 8787, "host": "0.0.0.0", "inbound": ["openai-compatible", "mcp", "a2a", "cloudevents"] } }
```
