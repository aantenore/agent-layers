"""The caller's credential, from the incoming A2A request to the model and tool calls of its run.

The bearer token of a request is held in a context variable while the request is handled. When the request
schedules a task, the broker keeps the token beside the task id, in memory only; the worker takes it back when the
run starts, so every model and MCP call of that run presents the caller's own credential to the gateway, which
verifies it. The token is never stored with the task, returned, or logged.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

import anyio
import httpx2
from fasta2a.broker import InMemoryBroker
from fasta2a.pydantic_ai import AgentWorker
from fasta2a.schema import TaskIdParams, TaskSendParams
from starlette.types import ASGIApp, Receive, Scope, Send

CALLER_TOKEN: ContextVar[str | None] = ContextVar('caller_token', default=None)

LOOPBACK_HOSTS = frozenset({'localhost', '127.0.0.1', '[::1]', '::1'})


class MissingCaller(RuntimeError):
    """A model or tool call outside a request that carried a credential."""

    def __init__(self) -> None:
        super().__init__('no caller credential for this run')


def caller_token() -> str:
    token = CALLER_TOKEN.get()
    if not token:
        raise MissingCaller()
    return token


def bearer_of(header: str | None) -> str | None:
    if not header:
        return None
    scheme, _, value = header.partition(' ')
    value = value.strip()
    return value if scheme.lower() == 'bearer' and value else None


class CallerBearer(httpx2.Auth):
    """Sends the current caller's token as `Authorization: Bearer ...`; refuses to send a request without one."""

    def auth_flow(self, request: httpx2.Request):  # type: ignore[override]
        request.headers['Authorization'] = f'Bearer {caller_token()}'
        yield request


def _host_name(host: str) -> str:
    if host.startswith('['):
        return host.split(']', 1)[0] + ']'
    return host.rsplit(':', 1)[0] if host.count(':') == 1 else host


class CallerMiddleware:
    """Requires a bearer credential on every request except the public ones (agent card, health).

    The credential is not verified here: the gateway verifies it on each model and tool call. Requests that carry an
    `Origin` header are refused (the agent is called server to server), and, when bound to loopback, so are `Host`
    names that are not loopback ones (DNS rebinding).
    """

    def __init__(self, app: ASGIApp, *, public_paths: frozenset[str], loopback_only: bool) -> None:
        self.app = app
        self.public_paths = public_paths
        self.loopback_only = loopback_only

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return
        headers = {k.decode('latin-1').lower(): v.decode('latin-1') for k, v in scope['headers']}
        if self.loopback_only and _host_name(headers.get('host', '')).lower() not in LOOPBACK_HOSTS:
            await _reply(send, 403, {'error': 'host not allowed'})
            return
        if 'origin' in headers:
            await _reply(send, 403, {'error': 'cross-origin requests are not accepted'})
            return
        if scope['path'] in self.public_paths and scope['method'] in ('GET', 'HEAD', 'OPTIONS'):
            await self.app(scope, receive, send)
            return
        token = bearer_of(headers.get('authorization'))
        if token is None:
            await _reply(send, 401, {'error': 'unauthorized'}, {'www-authenticate': 'Bearer realm="agent"'})
            return
        reset = CALLER_TOKEN.set(token)
        try:
            await self.app(scope, receive, send)
        finally:
            CALLER_TOKEN.reset(reset)


async def _reply(send: Send, status: int, body: dict[str, Any], headers: dict[str, str] | None = None) -> None:
    data = json.dumps(body).encode()
    raw = [(b'content-type', b'application/json'), (b'content-length', str(len(data)).encode())]
    raw += [(k.encode(), v.encode()) for k, v in (headers or {}).items()]
    await send({'type': 'http.response.start', 'status': status, 'headers': raw})
    await send({'type': 'http.response.body', 'body': data})


@dataclass
class CallerBroker(InMemoryBroker):
    """An in-memory broker that keeps the credential of the request that scheduled each task, until it runs."""

    _tokens: dict[str, str] = field(default_factory=dict, init=False, repr=False)

    async def run_task(self, params: TaskSendParams) -> None:
        token = CALLER_TOKEN.get()
        if token:
            self._tokens[params['id']] = token
        await super().run_task(params)

    async def cancel_task(self, params: TaskIdParams) -> None:
        self._tokens.pop(params['id'], None)
        await super().cancel_task(params)

    def take_token(self, task_id: str) -> str | None:
        return self._tokens.pop(task_id, None)


@dataclass
class CallerWorker(AgentWorker[Any, Any]):
    """Runs each task with its caller's credential, several at a time, and lets runs finish on shutdown."""

    max_concurrent_runs: int = 8
    shutdown_grace_s: float = 10.0
    _active: int = field(default=0, init=False, repr=False)
    _idle: anyio.Event | None = field(default=None, init=False, repr=False)

    async def run_task(self, params: TaskSendParams) -> None:
        broker = self.broker
        token = broker.take_token(params['id']) if isinstance(broker, CallerBroker) else None
        reset = CALLER_TOKEN.set(token)
        try:
            await super().run_task(params)
        finally:
            CALLER_TOKEN.reset(reset)

    @asynccontextmanager
    async def run(self) -> AsyncIterator[None]:
        slots = anyio.Semaphore(self.max_concurrent_runs)
        async with anyio.create_task_group() as tg:

            async def handle(operation: Any) -> None:
                try:
                    await self._handle_task_operation(operation)
                finally:
                    slots.release()
                    self._active -= 1
                    if self._active == 0 and self._idle is not None:
                        self._idle.set()

            async def dispatch() -> None:
                async for operation in self.broker.receive_task_operations():
                    await slots.acquire()
                    self._active += 1
                    tg.start_soon(handle, operation)

            tg.start_soon(dispatch)
            try:
                yield
            finally:
                # Runs in flight may finish within the grace period; then they are cancelled.
                if self._active:
                    self._idle = anyio.Event()
                    with anyio.move_on_after(self.shutdown_grace_s):
                        await self._idle.wait()
                tg.cancel_scope.cancel()
