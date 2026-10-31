# Governance & compliance

Cross-cutting. Not a layer: it is a set of obligations that the layers already have the hooks to meet. Overview in
[stack.md](../stack.md).

This page maps requirements to the places that satisfy them. It is not legal advice; check the rules that apply to
your deployment and use case.

## Scope

- **EU AI Act.** Obligations depend on the risk class of the system you build. Typical building blocks: risk
  management, logging, transparency to users, human oversight, accuracy and robustness testing.
- **GDPR.** Personal data in prompts, retrieved passages, tool results and traces: lawful basis, minimisation,
  retention, access and erasure.

## Mapping

| Requirement | How the stack supports it | Layer |
|---|---|---|
| Know who acted, and for whom | Every run carries an `Identity`; on-behalf-of vs own identity is explicit | [identity](../layers/identity.md) |
| Human oversight | Policy rules `allow` / `ask` / `deny` per tool and risk; `ask` pauses for approval | L5, [harness](../layers/harness.md) |
| Data minimisation | Guards redact PII on input, output, tool arguments and tool results | [guardrail](../layers/guardrail.md) |
| Logging and audit trail | Guardrail actions and policy decisions are emitted as audit events; traces carry `agent.layer` | [telemetry](../layers/telemetry.md) |
| Retention | Traces, stored runs and eval datasets have a retention period set in their stores; no secrets or tokens are ever recorded | L8, L2 |
| Transparency | Interfaces tell the user they talk to an agent; the agent file documents purpose and tools | [interface](../layers/interface.md), L2 |
| Risk management | Known risks are listed in the [threat model](security.md) and owned per layer | all |
| Accuracy, robustness, red teaming | Eval datasets include adversarial cases; failures are attributed to a layer | [eval](../layers/eval.md) |

## Practices

- **Retention.** Define a retention period per store (run store, trace backend, eval datasets) and enforce it there.
  Eval datasets built from production traces should be sampled and scrubbed first.
- **Erasure.** Keep a subject identifier in run metadata so a data subject's runs can be found and deleted from the
  run store and trace backend.
- **Transparency.** Each channel states that the user is talking to an agent. Agent files are in git, so changes to
  behaviour have an author, a date and a review.
- **Red teaming.** Keep a dataset of prompt-injection, jailbreak and data-leak attempts in L9 and run it on every
  change to an agent, guard or policy.
- **Audit events.** Treat guard blocks and authorization denials as audit records: who, what, which rule, when. They
  must not contain the secret or personal data that triggered them.

## Open points

- A standard audit-event schema is not defined yet; today audit data is carried in L8 spans and metrics.
- Retention is configured per backend, not centrally.
