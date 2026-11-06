# @agent-layers/cli

Command line for [agent-layers](https://github.com/aantenore/agent-layers): scaffold a project with all eleven layers
wired, check it, run it, evaluate it and deploy it.

```bash
npx @agent-layers/cli init my-agent      # --template minimal|rag, --runtime <adapter>, --name, --agent, --force
cd my-agent && npm install
npm run check                            # config, adapters, readiness gate, conformance
npm run dev                              # talk to the agent, one trace line per layer
npm test                                 # the smoke dataset, offline, with a scripted model
```

Run `init` through the scoped name, and the other commands through the project's npm scripts or
`npx @agent-layers/cli <command>`: the unscoped `agent-layers` name on npm is an unrelated package, so a bare
`npx agent-layers` is safe only inside the project after `npm install`.

| Command | What it does |
|---|---|
| `init [dir]` | scaffold a project (`--template minimal\|rag`, `--runtime`, `--name`, `--agent`, `--force`) |
| `dev` | run the agent in the terminal with a trace line per layer; failures of knowledge sources, tools and runs go to stderr whatever telemetry is configured (`--quiet` hides them) |
| `check` | validate config, resolve adapters, readiness gate, conformance (probes reach no configured telemetry unless `--verbose`) |
| `test` | conformance plus reference and project tests |
| `eval <dataset.jsonl>` | run and score a dataset |
| `deploy`, `up`, `down` | plan, start or stop the services of a profile (`--dry-run` lists the variables it would need instead of failing) |
| `diff <a> <b>` | what changes between two profiles, slot by slot |
| `layers` | the eleven layers: ports, versions, adapters in use and installed (lists the unset variables a profile would need) |
| `gateway` | host the stack on the network, identity on every request |
| `version` | the versions of the cli and of the `@agent-layers/core` it runs on (also `--version`, `-v`) |

Common options: `--config <file>` (default `agent-layers.json`), `--profile <name>` (or `AGENT_LAYERS_PROFILE`).
Full guide: [docs/guide.md](https://github.com/aantenore/agent-layers/blob/main/docs/guide.md).

Requires Node >= 22.18; `init` stops with a message on an older one. License: MIT.
