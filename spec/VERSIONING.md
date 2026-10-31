# Versioning

Every port has its own semantic version, `MAJOR.MINOR.PATCH`. The versions are listed in the [port index](ports/README.md) and on each port page, and are exposed by the core as `PORT_VERSIONS`. Schemas are versioned with the port that uses them.

## Language version

The data that crosses ports is one language, described in [language.md](language.md) and versioned as a whole. It is at 1.0: every port moved to `1.0.0` together. From there each port keeps its own semver, as below.

## What changes the version

| Change | Bump |
| --- | --- |
| Remove or rename an operation, a field or an enum value | major |
| Make an optional field or parameter required, or narrow an accepted value | major |
| Change what an operation means: ordering, error versus result, security rules | major |
| Add an optional operation, an optional field or a new accepted value that old callers never send | minor |
| Clarify wording, fix an example, document behaviour that was already required | patch |

If a change could make a previously conformant adapter fail its suite, it is breaking.

## The 0.x rule

No port is on 0.x any more; the rule stays here for history and for adapters that still declare a 0.x port version.

While the major version is 0, a minor bump may be breaking. Compatibility is therefore stricter:

- An adapter declares the port version it implements as `portVersion`.
- An adapter is compatible with a port when the major versions are equal and, for major 0, the minor versions are equal as well. For major 1 and above, any minor or patch of the same major is compatible.
- Examples: `0.1.3` serves `0.1.0`; `0.2.0` does not serve `0.1.0`; `1.4.0` serves `1.0.0`; `2.0.0` does not serve `1.9.0`.

This is the rule implemented by `compatibleVersion` in `packages/core/src/ports/catalog.ts`. A runtime must refuse to wire an adapter whose declared version is not compatible with the port version it runs.

## How a change lands

1. Spec first. Edit the port page in `spec/ports/`, update or add the schema in `spec/schemas/`, and bump the port version on the page and in the index.
2. Core second. Update the TypeScript binding in `packages/core`, including the port catalog entry (`PORTS`), so the version matches the spec.
3. Conformance third. Update the suite in `packages/conformance` so it checks the new behaviour, and the checks list on the port page.
4. Adapters last. Each adapter updates its code and its declared `portVersion`, then passes the suite for the new version.

A core change with no matching spec change is not accepted. The version history section at the end of each port page records every bump with a one-line reason.
