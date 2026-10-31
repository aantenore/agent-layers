# Specification

This directory is the source of truth for the contracts between the layers of an agent stack. It is language neutral: a runtime or an adapter written in any language implements these pages and schemas. The TypeScript in `packages/core` is one binding of the spec, not the spec itself. When the two disagree, the spec wins and the binding is fixed.

| Path | Content |
| --- | --- |
| [`language.md`](language.md) | The SDK language 1.0: naming rules, shapes, vocabularies, `ext`, mappings, knowledge fusion, telemetry names, run events and stop reasons. |
| [`schemas/`](schemas/) | JSON Schemas of the data that crosses a port: requests, results, identities, decisions, records. |
| [`ports/`](ports/README.md) | One page per port: operations, data shapes, semantics, errors, conformance. |
| [`VERSIONING.md`](VERSIONING.md) | Semver per port, what counts as breaking, and the order in which a change lands. |

The data shapes are written in one language, version 1.0, described in [language.md](language.md). Start with it, then the [port index](ports/README.md). It explains the notation used on the pages and the types shared by every port.

An implementation is conformant for a port when it passes the conformance suite listed on that port's page and declares the port version it implements.
