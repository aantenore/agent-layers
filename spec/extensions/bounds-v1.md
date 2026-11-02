# Bounds extension (A2A)

Version 1. URI: `https://github.com/aantenore/agent-layers/blob/main/spec/extensions/bounds-v1.md`

Alias: `https://github.com/aantenore/agent-plexus/blob/main/spec/extensions/bounds-v1.md`, the URI under which the same
data was first published. A receiver that implements this extension accepts both URIs with the same meaning; a sender
uses one.

An [A2A extension](https://a2a-protocol.org/latest/topics/extensions/) that carries what is left of a run's limits to
the next agent: time, hop count and, when the run has them, a token and a cost budget. A chain of agents then works
within one set of limits instead of each agent applying its own from scratch. A2A defines no deadline, budget or hop
limit; this extension adds the three without changing any core structure. The reasoning is in
[ADR 0002](../../docs/decisions/0002-delegation-bounds.md).

## Data

One object, carried in `message.metadata` of a message the sender passes on, under the extension URI as key.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `remainingMs` | integer ≥ 0 | yes | Time the receiver has left, in milliseconds. Never a clock time. |
| `hops` | integer ≥ 0 | yes | Agent-to-agent calls in the chain including this one. A sender sets at least 1. |
| `maxHops` | integer ≥ 0 | yes | Largest `hops` the chain accepts. |
| `tokens` | number ≥ 0 | | Tokens (input plus output) the receiver may still spend, delegated runs included. Absent: no token budget. |
| `costUsd` | number ≥ 0 | | Spend in US dollars the receiver may still incur, delegated runs included. Absent: no cost budget. |
| `rootRunId` | string, 1 to 128 printable characters | yes | Id of the run that started the chain. |
| `parentRunId` | string, 1 to 128 printable characters | yes | Id of the sender's run. |

A receiver ignores fields it does not know. It accepts data without `rootRunId` and `parentRunId` (it then has no
lineage), so older senders still bound the run.

```json
{
  "message": {
    "extensions": ["https://github.com/aantenore/agent-layers/blob/main/spec/extensions/bounds-v1.md"],
    "metadata": {
      "https://github.com/aantenore/agent-layers/blob/main/spec/extensions/bounds-v1.md": {
        "remainingMs": 45000, "hops": 2, "maxHops": 4, "costUsd": 0.5, "rootRunId": "run-a1", "parentRunId": "run-b7"
      }
    }
  }
}
```

## Report

On the task it returns, a receiver that activated the extension writes one object under the same URI in
`task.metadata`:

| Field | Type | Meaning |
| --- | --- | --- |
| `usage` | `{inputTokens, outputTokens}`, integers ≥ 0 | Tokens the run spent, delegated runs included, when known. |
| `costUsd` | number ≥ 0 | What the run cost, delegated runs included, when known. |
| `stop` | `timeout`, `limit` or `hop_limit` | Present only when the run bounds stopped the run: its deadline, its budget, or the hop limit, at the receiver or further down the chain (a delegate's `stop` is reported upstream in turn). |

`stop` is the stop code alone; who stopped the run and why stays inside the receiver. The sender settles what it
reserved for the call with `usage` and `costUsd`; a figure that is not reported keeps its whole share spent.

```json
{
  "task": {
    "status": { "state": "TASK_STATE_REJECTED" },
    "metadata": { "https://github.com/aantenore/agent-layers/blob/main/spec/extensions/bounds-v1.md": { "stop": "hop_limit" } }
  }
}
```

## Rules

1. **Activation.** The sender lists the URI in the `A2A-Extensions` header of the request and in `message.extensions`.
   A receiver reads the data only when the extension was activated (either list names one of its URIs), and answers
   with the activated URI in its own `A2A-Extensions` response header. The agent card declares the extension in
   `capabilities.extensions` with `required: false`: an agent that does not know it ignores the data and works as
   before.
2. **Validation.** Data that does not match the table above is refused with the JSON-RPC invalid-params error
   (`-32602`): a run never starts on bounds the receiver cannot read.
3. **Remaining time, not clock time.** `remainingMs` is what is left when the message is sent, after a margin the sender
   keeps for the answer to travel back. Network latency only shortens it, and clock differences between hosts cannot
   extend it. The receiver starts its own timer on receipt.
4. **Receivers only tighten.** The receiver's limits are the smaller of its own and the received ones: the time, the
   hop limit, and each budget present. It never raises a received value. Its hop count is the larger of the received
   `hops` and what its verified identity says (the actor chain of the caller's credential).
5. **Hops grow by one per call.** A sender that passes the data on sets `hops` to the `hops` of its own run plus one, and
   keeps `maxHops` (or a smaller value).
6. **Refusal.** A receiver refuses a call with `hops` above `maxHops`, or with too little time left to start. A refusal
   ends the task in the rejected state, with `stop` in the report. A sender refuses locally, without a network call,
   when the next call would go over `maxHops` or start with too little time.
7. **Budget.** What a sender passes is a reservation of what its run has left: parallel calls share it and never add up
   to more. A remote run that reports its usage and cost releases the rest of its share.
8. **Retries share the budget.** A retry carries what is left after the first attempt, never a fresh allowance.
9. **Cancellation.** A sender whose deadline passes, or that is aborted, cancels the task (`CancelTask`).
10. **Trust.** The values are asserted by the sender. They stop bugs (a loop, a delegate that forgets the deadline) and
    bound an adversary only as far as the receiver also verifies who is calling. Asserted data never becomes the
    caller's identity or actor chain.

## Implementations

- The [`a2a`](../../adapters/a2a/README.md) adapter of agent-layers: the runtime sends the data on every message from
  `outboundBounds(ctx)` and settles with the report; the channel declares the extension, reads the data into the run's
  bounds and writes the report. Both accept the alias URI.
- agent-plexus `a2a-member` sends the data under the alias URI.

## Version history

- 1: initial. Same data as the agent-plexus publication, plus the task report (`usage`, `costUsd`, `stop`).
