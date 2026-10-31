# @agent-layers/cli

Command line for [agent-layers](https://github.com/aantenore/agent-layers): scaffold a project with all eleven layers
wired, check it, run it, evaluate it and deploy it.

```bash
npx @agent-layers/cli init my-agent      # --template minimal|rag, --runtime <adapter>, --name, --agent, --force
cd my-agent && npm install
npx agent-layers check                   # config, adapters, readiness gate, conformance
npx agent-layers dev                     # talk to the agent, one trace line per layer
npm test                                 # the smoke dataset, offline, with a scripted model
```

Run `init` through the scoped name: inside a project the CLI is a dev dependency and `npx agent-layers` uses the
local binary.

| Command | What it does |
|---|---|
| `init [dir]` | scaffold a project (`--template minimal\|rag`, `--runtime`, `--name`, `--agent`, `--force`) |
| `dev` | run the agent in the terminal with a trace line per layer |
| `check` | validate config, resolve adapters, readiness gate, conformance |
| `test` | conformance plus reference and project tests |
| `eval <dataset.jsonl>` | run and score a dataset |
| `deploy`, `up`, `down` | plan, start or stop the services of a profile |
| `diff <a> <b>` | what changes between two profiles, slot by slot |
| `layers` | the eleven layers: ports, versions, adapters in use and installed |
| `gateway` | host the stack on the network, identity on every request |

Common options: `--config <file>` (default `agent-layers.json`), `--profile <name>` (or `AGENT_LAYERS_PROFILE`).
Full guide: [docs/guide.md](https://github.com/aantenore/agent-layers/blob/main/docs/guide.md).

Requires Node >= 22.18. License: MIT.
