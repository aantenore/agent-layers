"""The Pydantic AI agent: instructions from the agent file, model and tools from the agent-layers gateway.

- Model: the gateway's OpenAI-compatible API (`<gateway>/v1`) with a model alias, so input and output guards,
  cache, router, token usage and traces apply. Never `agent:<name>`, which would run an agent of the stack again.
- Tools: the gateway's MCP endpoint (`<gateway>/mcp`, streamable HTTP), so policy, approval, authorization,
  credentials for the caller, tool guards and traces apply. Each run opens its own MCP session as its caller.
"""

from __future__ import annotations

from typing import Any

import httpx2
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.tools import RunContext, ToolDefinition

from .caller import CallerBearer, caller_token, trace_headers
from .settings import Settings, SettingsError
from .spec import AgentSpec

# The OpenAI client wants a key; CallerBearer replaces the header with the caller's token on every request.
_PLACEHOLDER_KEY = 'set-per-request'


def model_alias(spec: AgentSpec, settings: Settings) -> str:
    alias = settings.model or spec.model
    if not alias:
        raise SettingsError('no model alias: set model in the agent file or GATEWAY_MODEL')
    if alias.startswith('agent:'):
        raise SettingsError('the model must be a model alias of the gateway, not agent:<name>')
    return alias


def gateway_model(settings: Settings, alias: str, http_client: httpx2.AsyncClient) -> OpenAIChatModel:
    provider = OpenAIProvider(base_url=f'{settings.gateway_url}/v1', api_key=_PLACEHOLDER_KEY, http_client=http_client)
    return OpenAIChatModel(alias, provider=provider)


def gateway_tools(settings: Settings, spec: AgentSpec) -> Any:
    """The gateway's MCP tools that the agent file lists, connected per run with the caller's token."""

    def auth(_ctx: RunContext[None]) -> str:
        return caller_token()

    def allowed(_ctx: RunContext[None], tool: ToolDefinition) -> bool:
        return spec.allows_tool(tool.name)

    def headers(_ctx: RunContext[None]) -> dict[str, str] | None:
        return trace_headers() or None

    return MCPToolset(f'{settings.gateway_url}/mcp', id='gateway', auth=auth, headers=headers).filtered(allowed)


def model_http_client(settings: Settings) -> httpx2.AsyncClient:
    """HTTP client of the model calls: each request carries the caller's token, none is sent without one."""
    return httpx2.AsyncClient(auth=CallerBearer(), timeout=settings.model_timeout_s)


def build_agent(spec: AgentSpec, settings: Settings, http_client: httpx2.AsyncClient) -> Agent[None, str]:
    uses_tools = bool(spec.tools) or spec.knowledge != ()
    return Agent(
        gateway_model(settings, model_alias(spec, settings), http_client),
        name=spec.name,
        instructions=spec.instructions or None,
        toolsets=[gateway_tools(settings, spec)] if uses_tools else [],
    )
