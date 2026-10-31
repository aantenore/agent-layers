# Models

Layer id `llm` (L1), Model plane. *Who thinks?*

## Responsibility

Generate completions, including tool calls and streamed output. This is the only layer that talks to a model.

## Ports

| Port | What it does |
|---|---|
| [ModelPort](../../spec/ports/ModelPort.md) | `chat` and optional `stream` over a provider-neutral request with tools and usage |

Data shapes: [chat-request.json](../../spec/schemas/chat-request.json), [chat-response.json](../../spec/schemas/chat-response.json).

## Standards

- OpenAI Chat Completions, the de facto wire format.
- Anthropic Messages.

Any server that speaks one of them is a drop-in model; the rest is an adapter for the provider's native API.

## Boundaries

- Routing, fallback, quotas and caching in front of the model belong to [cache](cache.md), not here.
- The model never sees tokens or secrets; credentials stay in the adapter.

## How to swap

Point an `openai-compatible` adapter at another server (vLLM, llama.cpp, LM Studio, a gateway, a hosted API) by changing
`baseUrl` and `model`. For an API that is neither compatible, write an adapter that maps its native calls onto
ModelPort and passes the conformance suite.

## Reference adapters

| Adapter | Maps |
|---|---|
| `openai-compatible` | OpenAI Chat Completions: Ollama, vLLM, LiteLLM, hosted APIs |
| `mock-model` | A scripted deterministic model for offline tests |

Full list and maturity: [adapters.md](../adapters.md).

## Reference setup

[`reference/llm/`](../../reference/llm/README.md) uses Ollama (MIT) running natively on the host, with the model
`qwen3:4b` (Apache-2.0).

```bash
ollama pull qwen3:4b
```

Containers reach it at `host.docker.internal:11434`. Ollama runs on the host rather than in a container to use GPU or
Metal acceleration. Variables: `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` (defaults in
[contracts.md](../contracts.md#host-ports-and-environment)).

Model weights are licensed separately from the tools that serve them. Not every popular small model is OSI-licensed,
so check the license of any model you swap in; see the [license note](../../README.md#licenses-of-the-reference-technologies).

```bash
make test LAYER=llm
```

The test skips with a message when Ollama is unreachable or the model is missing.
