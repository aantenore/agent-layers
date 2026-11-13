# Licences of the reference technologies

This repository is MIT. Reference technologies are used as separate processes or services through adapters, never vendored.

| Component | License | Layer (id) |
|---|---|---|
| reinloop | MIT | harness |
| Ollama | MIT | llm |
| Qdrant | Apache-2.0 | knowledge |
| Apache Jena Fuseki | Apache-2.0 | knowledge (next) |
| MCP Toolbox for Databases | Apache-2.0 | knowledge (next) |
| mcp-server-qdrant | Apache-2.0 | knowledge |
| Docling | MIT | knowledge (docs) |
| Graphiti | Apache-2.0 | knowledge (optional) |
| LightRAG | MIT | knowledge (optional) |
| go-httpbin | MIT | tool |
| Keycloak | Apache-2.0 | identity |
| OPA | Apache-2.0 | identity |
| Presidio | MIT | guardrail |
| LLM Guard | MIT | guardrail |
| LiteLLM | MIT core (the `enterprise/` directory is under a separate commercial license and is not used) | cache |
| Valkey | BSD-3-Clause | cache |
| OpenTelemetry Collector | Apache-2.0 | telemetry |
| Langfuse | MIT core (the `ee/` directories are under a separate commercial license and are not used) | telemetry |
| Jaeger | Apache-2.0 | telemetry |
| promptfoo | MIT | eval (reference runner; EvaluatorPort adapter planned) |
| Docker Compose | Apache-2.0 | infra |
| Traefik | MIT | infra (docs) |
| Argo CD | Apache-2.0 | infra (docs) |
| OpenTofu | MPL-2.0 | infra (docs) |
| OpenBao | MPL-2.0 | infra (docs) |
| LibreChat | MIT | interface (planned) |
| A2A | Apache-2.0 | interface, harness (`a2a` adapter: channel and runtime) |
| AG-UI | MIT | interface (planned) |

All of the above are OSI-approved licenses (for the split-licensed projects, only the open-source parts are used).
Phoenix (Elastic License 2.0) and Llama Guard (Llama Community License) are deliberately excluded because their
licenses are not OSI-approved.

Model weights are licensed separately from the tools that serve them. The default `qwen3:4b` is Apache-2.0
(`qwen2.5:3b`, for comparison, is under the Qwen Research License, which is not OSI-approved). Check the license of
the model you ship. `LLM_MODEL` can point to any model Ollama serves.
