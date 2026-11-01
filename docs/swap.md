# Layer swap matrix

A layer is replaceable when changing the configuration is enough. `scripts/swap-matrix.mjs` checks that claim cell by
cell: each cell replaces one slot (or a few that go together) of the base project, [examples/minimal](../examples/minimal),
and the CLI validates and runs the result. No code changes between cells. The vertical slice does the same across
tiers and runtimes ([slice.md](slice.md#only-configuration-changes)); the matrix is the small, re-runnable version for one
slot at a time.

## What a cell does

The cells are data in [examples/swap/cells.json](../examples/swap/cells.json):

```json
{ "id": "state-sqlite", "layer": "state", "value": { "adapter": "sqlite-state", "options": { "path": ".agent-layers/swap-state.db" } },
  "description": "Session event log in a SQLite file instead of memory.", "observe": { "file": ".agent-layers/swap-state.db" } }
```

- `layer` and `value` replace one slot; `null` removes an optional slot and `[]` empties a list. `layers` overrides
  several slots together (an identity provider also replaces the credentials slot).
- `needs` lists what the cell requires: `docker:<service>`, `uv` or `model`. A cell with needs is skipped unless
  `--with` names them (`--with docker` covers every `docker:*`) or `--all` is passed.
- `observe` says how the swap shows in the run. Without it the cell is reported as not observable, because nothing
  in the run identifies that adapter.

For each selected cell the script writes a temporary config next to the base one (`agent-layers.swap.json`, ignored by
git, deleted at the end even on failure) with a profile `swap-<id>` that extends `test` and overrides only the cell's
slots. It then runs `agent-layers check` and `agent-layers eval evals/smoke.jsonl --min 1` on that profile, each with a
timeout (120 s, `SWAP_TIMEOUT_S` to change it). A cell passes when both succeed and, if the cell says how to observe it,
the replacement is seen: a span attribute in the telemetry written during the run, the absence of a span for a removed
slot, a line of CLI output when the telemetry adapter itself is replaced, or a file.

## Running it

```text
node scripts/swap-matrix.mjs                        cells without needs
node scripts/swap-matrix.mjs --only state-sqlite,guard-none
node scripts/swap-matrix.mjs --with docker,uv       also the cells that need a service or uv
node scripts/swap-matrix.mjs --all                  every cell
node scripts/swap-matrix.mjs --list                 cells and their needs
```

Results go to `examples/swap/.agent-layers/results.json` and `results.md`: per cell the slot, from → to, the `check` and
`eval` outcome, whether the adapter was observed and a note (the first error line on failure). The exit code is 1 when a
selected cell fails.

Cells that need Docker services expect the reference stacks (`reference/*/compose.yml`) to be running and their URLs to
come from the `${env:NAME:-default}` values in the cell. The Pydantic AI runtime cell also expects the agent
([runtimes/pydantic-ai](../runtimes/pydantic-ai/README.md)) and the gateway to be started; the matrix does not start them.
