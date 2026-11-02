# @agent-layers/adapter-cron-trigger

Maps **in-process timers** (a fixed interval or a cron expression) → **TriggerPort** (layer `interface`). Direction:
inbound. Tier: prototype. Maturity: experimental.

Each schedule starts one run when it fires. The adapter implements `start` only: the stack arms it in
`stack.start()`, which `agent-layers dev` calls. The gateway mounts triggers with `mount` and does not start this one:
it reports the trigger at start-up (`agent.config.warning`), and its schedules do not fire there.

## Schedules

- `everyMs`: a fixed interval of at least 1000 ms; the first firing is one interval after start.
- `cron`: five fields, `minute hour day-of-month month day-of-week`, evaluated in UTC. Each field takes `*`, a value,
  a range `a-b`, a step `*/n` or `a-b/n`, and comma-separated lists. Day of week is `0`-`7` (`0` and `7` are Sunday).
  When both day of month and day of week are restricted, a day matches when either does; as in Vixie cron, a field
  that starts with `*` (`*`, `*/2`) counts as unrestricted, so `0 0 */2 * 1` fires on odd days that are Mondays. An
  expression that never fires (`0 0 30 2 *`) makes `start` reject.

Exactly one of `everyMs` and `cron` per schedule. When the stack starts the trigger, each schedule's `agent` must be
one of its agents, or `start` rejects.

## Behaviour

- A firing is skipped while the previous run of the same schedule is still going, so slow runs never pile up.
- A failed run is reported as the telemetry event `cron-trigger.run.failed` (layer `interface`, the schedule name in
  `agent.name`, the message in `agent.error`); the schedule carries on.
- Nothing is persisted: firings due while the process is down are not made up, and every replica fires on its own.
  Run one process, or use a scheduler outside the stack (a CronJob that posts a CloudEvent to the
  [cloudevents](../cloudevents/README.md) trigger) for production.
- `close` clears the timers; a run in progress finishes.

## The trigger

| Trigger field | Value |
|---|---|
| `id` | A new id per firing |
| `kind` | `schedule` |
| `source` | `<instance>/<schedule name>` |
| `at` | The scheduled time |
| `agent` | The schedule's `agent`, else the host's first agent |
| `data` | The schedule's `input` |
| `ext["cron-trigger.schedule"]` | The schedule name |

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `schedules[].name` | string | required | Name of the schedule |
| `schedules[].everyMs` | integer | none | Interval between firings, in milliseconds (at least 1000) |
| `schedules[].cron` | string | none | Cron expression, UTC |
| `schedules[].agent` | string | first agent | Agent to run; checked against the stack's agents at start |
| `schedules[].input` | string | none | Run input |

```json
{
  "triggers": [{
    "adapter": "cron-trigger",
    "options": { "schedules": [{ "name": "weekday-digest", "cron": "0 7 * * 1-5", "agent": "assistant", "input": "Summarise yesterday's tickets." }] }
  }]
}
```
