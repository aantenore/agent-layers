# FeedbackPort

Layer: `eval` (L10 Evaluation & improvement) · Version: 1.0.0 · Conformance: `checkFeedback`

## Purpose

Collect ratings and comments from people and apps about specific runs, so real usage becomes evaluation data. Feedback is tied to a run id and can be listed later to build or refresh a dataset.

## Operations

- `submit(feedback: Feedback) → String`
  Store the feedback and return its id.
- `list(q?: {runId?: String, agent?: String, since?: String, limit?: Integer}) → [Feedback]`
  Return stored feedback matching the filters. All filters are optional and combine with AND. `since` is an ISO 8601 time.

## Data shapes

[Feedback](../schemas/feedback.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `id?` | String | Assigned by the store when absent. |
| `runId` | String, required | Run the feedback is about. |
| `agent?` | String | Agent that produced the run. |
| `rating?` | Number from -1 (bad) to 1 (good) | Score. |
| `label?` | String | Free category, for example `wrong-tool`. |
| `comment?` | String | Free text. |
| `by?` | String | Who gave it (a caller id). |
| `at?` | String (ISO 8601 time) | When. |
| `ext?` | Ext | Store- or channel-specific fields. |

## Semantics

- `submit` returns a non-empty id. Submitted feedback is returned by `list` afterwards.
- `list` with `runId` returns only feedback for that run.
- `limit` caps the number of results.
- Feedback is user data: comments may contain personal information. Store and expose it with the same care as session events.
- Feedback does not change a run; it is input for evaluation, not for the live agent.
- `by` is an identifier chosen by the caller; the port does not verify it. Use the identity port at the channel that receives the feedback.

## Errors

- Rejects: store unreachable, a rating outside -1..1 or a missing `runId`.
- Returned as a result: an empty list when nothing matches.

## Escape hatch

`label` and `comment` are free-form. `ext` carries store- or channel-specific data under namespaced keys declared in the adapter descriptor's `ext.produces` / `ext.reads`. `native()` returns the underlying store.

## Conformance

`checkFeedback` verifies:

- The fixture feedback validates against `feedback.json`.
- `submit` resolves to a non-empty id.
- `list` filtered by the run id returns the submitted feedback.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): `by` (was `subject`) and `at` (was `time`)
- 0.1.0 — initial
