# 0003. A waiting run is continued as the same run

Status: Accepted · Date: 2026-11-02 · Decided by: project owner · Supersedes: none · Extends: [0001](0001-sdk-language.md)

## Context

A run that waits for a person (an approval, input) ends `waiting`. Until now "resuming" meant running the agent again in
the same session, with the same caller, and hoping the model makes the same call with the same arguments, so the
session's approval decision applies. With a real model that is not deterministic: the model may answer differently,
call another tool, or change an argument and ask for a new approval. There was also no way to cancel a run: a waiting
run stayed open until its approval expired, and a run in flight could only be stopped by the client that started it.

## Decision

| Topic | Decision |
|---|---|
| API | `Stack.resume(runId, answer, ctx?)` with `answer` `{approval: {id, approved, reason?}}` or `{input: RunInput}`; `Stack.cancel(runId, {by, reason})`. `ChannelHost` offers both (ChannelPort 1.2.0). Refusals are `RunRefused` with `kind` `not_found`, `forbidden`, `conflict`, `invalid`. |
| What the host keeps | When a run ends `waiting`: its input, caller without the credential, session, the call that waits (tool, arguments, approval id), the stop reason and the runtime's checkpoint. In the stack's StorePort when configured (`sdk.run.<hash>` keys, the checkpoint in parts, expiring after `limits.run.resumeTtlMs`), else in memory, bounded by `limits.run.maxWaitingInMemory` (prototype). |
| Runtime contract | RuntimePort 1.3.0: optional `RunnableAgent.resume(checkpoint, answer, ctx)` and `RunResult.checkpoint` (also on `run.end`), plain JSON, opaque to the core and removed by the host before a result leaves the stack. `basic-runtime` checkpoints its conversation and the calls left of the last answer; `reinloop` its own event log; the `a2a` runtime the remote task, which a follow-up message continues. |
| Determinism | The resumed run keeps its id, session and caller, so the stack's tools find the decision for the call that waited. The runtime runs exactly that call (and the calls after it in the same answer), adds an input answer after the results, and goes on. A runtime without `resume`, or a run kept without a checkpoint (one too large for the store), is run again from its input: documented as not deterministic. |
| Who may resume or cancel | The caller that started the run (same `kind` and `id`). Anyone else needs the AuthorizationPort to allow `decide` on the approval the run waits for, or on the run (target kind `run`) when it waits for none. An approval answer is a decision: it always needs `decide` on the approval, like the gateway's approval routes, and records the resumer as `decidedBy`. |
| Caller of the resumed run | The identity that started it: with the owner's fresh credential when the owner resumes, without a credential otherwise (outbound calls that need one fail closed). |
| Concurrency | A resume claims the record with compare-and-set (`resuming`); a second resume gets `conflict`. A failure puts the record back to `waiting`. |
| Cancel | Aborts a run in flight in this process (its signal fires; the run ends `stopped`, `aborted`), or marks a waiting run `cancelled` and withdraws its pending approval (`ApprovalPort.cancel`). A cancelled run cannot be resumed. |
| Channels | Gateway: `POST /runs/<id>/resume` and `POST /runs/<id>/cancel`, off by default, authenticated and authorized with actions `resume` and `cancel` on target kind `run` (AuthorizationPort 1.3.0). A2A: a message naming an `input-required` task continues that run with the message as input; CancelTask cancels the run in the stack. An approval of a run reached over A2A is decided on the gateway's approval routes, then the client sends the follow-up. `openai-compatible`: no change. |

## Consequences

- Additive: optional members, minor bumps of RuntimePort (1.3.0), AuthorizationPort (1.3.0) and ChannelPort (1.2.0).
  Runtimes built for 1.2.0 keep working through the re-run fallback; conformance checks `resume` only for runtimes
  that declare 1.3.0 and implement it.
- Every run that ends `waiting` costs one store write (more for a large checkpoint); a resumed run that ends deletes
  its record. A store adapter with a smaller value limit than the parts used falls back to keeping no checkpoint.
- Without a store, waiting runs are lost on restart and not shared by replicas: readiness warns on the production tier
  when an approval adapter is configured without a store.
- A resumed run gets new bounds from `limits.run` (and from a calling agent's delegation, when it sends one): a long
  wait does not consume its deadline.
- A runtime that keeps its transcript in the checkpoint keeps user data in the store: keep the store as private as the
  runs that write it.
