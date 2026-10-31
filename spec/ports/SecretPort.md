# SecretPort

Layer: `infra` (L0 Infrastructure & delivery) · Version: 0.1.0 · Conformance: `checkSecrets`

## Purpose

Keep secret values out of configuration. Configuration holds references; this port turns a reference into its value at the moment it is needed.

## Operations

- `get(ref: String, opts?: {signal?: Signal}) → String?`
  Resolve a secret reference. Returns the value, or nothing when the reference is unknown.

## Data shapes

The reference is an opaque string. Its syntax is defined by the adapter (a name, a path, a URI). The value is a string.

## Semantics

- Values never reach logs, traces, events, plans or error messages.- An unknown reference is a normal "not found" result, not an error, so callers can fall back to a default.
- `signal` cancels a lookup in progress.

## Errors

- Resolves to nothing: unknown reference.
- Rejects: the secret store is unreachable, access is denied, the signal fired.

## Escape hatch

`native()` returns the underlying secret-store client.

## Conformance

`checkSecrets` verifies:

- `get` of an unknown reference resolves to nothing instead of throwing.
- When a known reference/value pair is given as a fixture, `get` returns exactly that value. Otherwise this check is skipped.

## Version history

- 0.1.0 — initial
