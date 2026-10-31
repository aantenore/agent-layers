# Harness reference setup

Layer page: [docs/layers/harness.md](../../docs/layers/harness.md). The runtime used here is
[reinloop](https://github.com/aantenore/reinloop) (MIT), one runtime adapter among others.

| Path | Content |
|---|---|
| `agents/assistant.md` | Sample agent file. No `model` is set, so the model comes from `REINLOOP_MODEL` |
| `test/harness.test.mjs` | Live test against Ollama |

## Run the sample agent

```bash
export REINLOOP_MODEL=ollama/qwen3:4b
export OLLAMA_BASE_URL=http://localhost:11434/v1
reinloop run --agents reference/harness/agents -a assistant "Say hello"
reinloop serve --agents reference/harness/agents --port 8700
```

## Test

```bash
make test LAYER=harness
# against a local reinloop checkout
REINLOOP_SRC=/path/to/reinloop/src/index.ts make test LAYER=harness
```

The test builds the model reference from `LLM_MODEL` and `LLM_BASE_URL`, runs the agent once and expects status
`completed` with non-empty output. It skips with a message if Ollama is unreachable or the model is not pulled.
