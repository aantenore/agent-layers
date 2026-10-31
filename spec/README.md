# Specification

This directory is the source of truth for the contracts between the layers of an agent stack. It is language neutral: a runtime or an adapter written in any language implements these pages and schemas. The TypeScript in `packages/core` is one binding of the spec, not the spec itself. When the two disagree, the spec wins and the binding is fixed.

| Path | Content |
| --- | --- |
| [`schemas/`](schemas/) | JSON Schemas of the data that crosses a port: requests, results, identities, decisions, records. |
| [`ports/`](ports/README.md) | One page per port: operations, data shapes, semantics, errors, conformance. |
| [`VERSIONING.md`](VERSIONING.md) | Semver per port, what counts as breaking, and the order in which a change lands. |

Start with the [port index](ports/README.md). It explains the notation used on the pages and the types shared by every port.

An implementation is conformant for a port when it passes the conformance suite listed on that port's page and declares the port version it implements.
