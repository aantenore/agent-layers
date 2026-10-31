# SecretPort

Layer: `infra` (L0 Infrastructure & delivery) · Version: 1.0.0 · Conformance: `checkSecrets`

## Purpose

Keep secret values out of configuration. Configuration holds references; this port turns a reference into its value at the moment it is needed.

## Operations

- `get(ref: String, opts?: {signal?: Signal}) → String?`
  Resolve a secret reference. Returns the value, or nothing when the reference is unknown.

## Data shapes

The reference is an opaque string. Its syntax is defined by the adapter (a name, a path, a URI). The value is a string.

## Semantics

- Values never reach logs, traces, events, plans or error messages.
- An unknown reference is a normal "not found" result, not an error, so callers can fall back to a default.
- `signal` cancels a lookup in progress.

## Errors

- Resolves to nothing: unknown reference.
- Rejects: the secret store is unreachable, access is denied, the signal fired.

## Escape hatch

The port returns a plain string, so there is no shape to extend; any `ext` keys the adapter writes or reads are namespaced and declared in its descriptor's `ext.produces` / `ext.reads`. `native()` returns the underlying secret-store client.

## Conformance

`checkSecrets` verifies:

- `get` of an unknown reference resolves to nothing instead of throwing.
- When a known reference/value pair is given as a fixture, `get` returns exactly that value. Otherwise this check is skipped.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): baseline only, no shape changes
- 0.1.0 — initial
