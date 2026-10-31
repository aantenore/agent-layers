# Decisions

Architecture decision records: one file per decision that shapes the contracts, the core or how adapters are
written. A record is short, says what was decided and why, and lists what it changes. Smaller choices live in code
comments and pull requests.

| # | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-sdk-language.md) | The SDK speaks its own language: fixed core shapes, configurable vocabularies and boundary mappings, standards only in adapters | Accepted | 2026-10-31 |

The migration of 0001 is tracked package by package in [0001-migration-notes.md](0001-migration-notes.md).

## Writing one

- File name `NNNN-short-title.md`, numbered in order; numbers are never reused.
- First line under the title: `Status: Proposed | Accepted | Superseded by NNNN · Date · Decided by`.
- Sections: Context, Decision, Consequences, and the plan or open questions when there are any. Prefer tables to prose.
- An accepted record is not rewritten. A later decision supersedes it and both link to each other.
- Add the record to the table above, and any diagram to the index in [diagrams.md](../diagrams.md).
