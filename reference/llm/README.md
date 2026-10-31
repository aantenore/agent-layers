# L1 LLM

Model access for the platform. Documentation: [docs/layers/L1-llm.md](../../docs/layers/L1-llm.md).

| Path | Content |
|---|---|
| `compose.yml` | Optional containerized Ollama (profile `container-ollama`); off by default |
| `test/llm.test.mjs` | Live test against the host Ollama |

## Standards and extension point

- Standards: OpenAI Chat Completions (de facto) and Anthropic Messages. Any provider behind either URL is a drop-in.
- Extension point: reinloop `Provider` (`generate(request, { signal, onText })`) for anything else.
- Reference: [Ollama](https://github.com/ollama/ollama) (MIT), running natively on the host.

## Contract

| Variable | Default |
|---|---|
| `LLM_BASE_URL` | `http://localhost:11434/v1` |
| `LLM_MODEL` | `qwen3:4b` |
| `LLM_API_KEY` | `ollama` |

Input: an OpenAI chat completions request with `tools`. Output: a completion with `tool_calls` and `usage`.

## Swap the model or provider

Point the variables at any OpenAI-compatible server (vLLM, LM Studio, a hosted API) and set `LLM_MODEL` to its model
id. Hosted providers need their own key in `LLM_API_KEY`. For Anthropic Messages use the `anthropic/<model>` preset.

Containers reach the host Ollama at `host.docker.internal:11434`.

## Optional: Ollama in a container

```bash
docker compose -f layers/l1-llm/compose.yml --profile container-ollama up -d --wait
docker compose -f layers/l1-llm/compose.yml --profile container-ollama exec ollama ollama pull qwen3:4b
docker compose -f layers/l1-llm/compose.yml --profile container-ollama down      # add -v to drop the models
```

It listens on the same port as the host Ollama: stop the host one first, or set `OLLAMA_PORT` to another port and
adjust `LLM_BASE_URL`. `make up-all` does not start it (the profile is off).

## Test

```bash
make test LAYER=l1-llm
# against a local reinloop checkout
REINLOOP_SRC=/path/to/reinloop/src/index.ts make test LAYER=l1-llm
```

The test checks the model with reinloop's `checkProvider` conformance check (text turn, forced tool call, usage, stop
reasons) and runs an agent that makes one tool call. It skips with a message if Ollama is unreachable, the model is
not pulled, or the installed reinloop has no `checkProvider`. Reasoning models spend tokens on thinking, so the test
allows 1024 output tokens per turn.
