"""The A2A server: FastA2A around the Pydantic AI agent, with the caller's credential carried into each run."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx2
from fasta2a import FastA2A
from fasta2a.schema import SecurityRequirement, SecurityScheme, Skill
from pydantic_ai import Agent
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .agent import build_agent, model_http_client
from .caller import CallerBroker, CallerMiddleware, CallerWorker
from .owners import CallerStorage, OwnedTaskManager, TaskStore
from .settings import Settings
from .spec import AgentSpec

AGENT_CARD_PATH = '/.well-known/agent-card.json'
HEALTH_PATH = '/healthz'
VERSION = '0.1.0'


async def _health(_request: Request) -> JSONResponse:
    return JSONResponse({'status': 'ok'})


def create_app(
    spec: AgentSpec,
    settings: Settings,
    *,
    agent: Agent[None, str] | None = None,
    http_client: httpx2.AsyncClient | None = None,
) -> FastA2A:
    """The ASGI app. `agent` and `http_client` replace the gateway-backed ones (tests)."""
    client = http_client or model_http_client(settings)
    the_agent = agent or build_agent(spec, settings, client)
    store = TaskStore(settings.max_tasks)
    storage = CallerStorage(store)
    broker = CallerBroker()
    worker = CallerWorker(
        agent=the_agent,
        broker=broker,
        storage=store,
        max_concurrent_runs=settings.max_concurrent_runs,
        shutdown_grace_s=settings.shutdown_grace_s,
    )

    @asynccontextmanager
    async def lifespan(app: FastA2A) -> AsyncIterator[None]:
        try:
            async with app.task_manager, the_agent, worker.run():
                yield
        finally:
            if http_client is None:
                await client.aclose()

    description = spec.description or f'Agent {spec.name}'
    app = FastA2A(
        storage=storage,
        broker=broker,
        name=spec.name,
        url=settings.public_url,
        version=VERSION,
        description=description,
        skills=[Skill(id=spec.name, name=spec.name, description=description, tags=['agent-layers'])],
        security_schemes={'bearer': SecurityScheme(http_auth_security_scheme={'scheme': 'Bearer'})},
        security_requirements=[SecurityRequirement(schemes={'bearer': []})],
        docs_url=None,
        default_input_modes=['text/plain'],
        default_output_modes=['text/plain'],
        routes=[Route(HEALTH_PATH, _health, methods=['GET'])],
        middleware=[
            Middleware(
                CallerMiddleware,
                public_paths=frozenset({AGENT_CARD_PATH, HEALTH_PATH}),
                loopback_only=settings.loopback,
                gateway_secret=settings.gateway_secret,
            )
        ],
        lifespan=lifespan,
    )
    # FastA2A builds its own task manager; this one answers only the owner of a task or conversation.
    app.task_manager = OwnedTaskManager(broker=broker, storage=storage, cancel_run=worker.cancel_run)
    return app
