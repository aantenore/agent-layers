# L1 Models

## Responsibility

Generate completions, including tool calls. This is the only layer that talks to a model.

## Standard

- OpenAI Chat Completions (de facto standard).
- Anthropic Messages.

## Extension point

reinloop `Provider.generate(request, { signal, onText })`. One method; any model API.

## Reference implementation

Ollama running natively on the host (MIT), model `qwen3:4b` (Apache-2.0).

```bash
ollama pull qwen3:4b
```

Containers reach it at `host.docker.internal:11434`. Ollama runs on the host rather than in a container to use the
GPU / Metal acceleration.

Model weights are licensed separately from Ollama's MIT. `qwen3:4b` is Apache-2.0. Not every popular small model is
OSI-licensed (`qwen2.5:3b`, for one, is not), so check the license of any model you swap in. See the
[license note](../../README.md#licenses).

## Adapter SDK + conformance

Where the model API is neither OpenAI- nor Anthropic-compatible, implement `Provider`. reinloop exports the
interface. A conformance check sends a fixed set of requests (plain text, tool call, streaming, usage reporting) to a
provider and verifies the response shapes. A provider that passes can be used by any agent.

## Around the layer

- **Provider conformance check**, run before a new provider is used in an agent.
- Caching, routing, fallbacks and quotas in front of the model belong to [L7](L7-cache-router.md), not here.

## How to swap it

- Any server with an OpenAI- or Anthropic-compatible URL is a drop-in: set `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`
  (vLLM, llama.cpp server, LM Studio, a hosted API).
- Anything else implements `Provider` and registers through a reinloop plugin.

## Contract

- In: OpenAI chat completions request with `tools`.
- Out: completion with `tool_calls` and `usage`.

Details in [contracts.md](../contracts.md#l1-models).

## How to test

```bash
make test LAYER=l1-llm
```

Requires Ollama with the model pulled. The test skips with a message when Ollama is unreachable or the model is
missing.
