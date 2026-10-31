"""Who owns which task and conversation.

FastA2A keeps every task in one shared store and answers any caller that knows an id. Here each task and each
`contextId` has an owner, recorded when it is created, and every other caller is told the task does not exist: the
answer for an unknown id, so ids cannot be probed.

The owner key is the SHA-256 of the caller's bearer token. This agent does not verify the token (the gateway does, on
every model and tool call), so it cannot know the subject behind it. Only the digest is kept; the token itself is
never stored, returned or logged.
"""

from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any

from fasta2a.schema import (
    CancelTaskRequest,
    CancelTaskResponse,
    GetTaskRequest,
    GetTaskResponse,
    Message,
    ResubscribeTaskRequest,
    SendMessageRequest,
    SendMessageResponse,
    StreamMessageRequest,
    StreamMessageResponse,
    Task,
    TaskNotFoundError,
)
from fasta2a.storage import InMemoryStorage
from fasta2a.task_manager import TaskManager

from .caller import CALLER_TOKEN

FINAL_STATES = frozenset({'completed', 'canceled', 'failed', 'rejected'})


def owner_key() -> str | None:
    """The owner of the request being handled: the digest of its bearer token, None outside a request."""
    token = CALLER_TOKEN.get()
    return hashlib.sha256(token.encode()).hexdigest() if token else None


class ContextNotOwned(Exception):
    """A message named a conversation that belongs to another caller."""


class OwnedStorage(InMemoryStorage[list[Any]]):
    """In-memory storage that records the owner of each task and conversation, and keeps a bounded number of them.

    Beyond `max_tasks` the oldest finished tasks are dropped with their owner; beyond `max_tasks` conversations the
    least recently used is dropped with its history. A task or conversation without an owner is never served.
    """

    def __init__(self, max_tasks: int) -> None:
        super().__init__()
        self.max_tasks = max_tasks
        self.task_owners: dict[str, str] = {}
        self.context_owners: dict[str, str] = {}

    async def submit_task(self, context_id: str, message: Message) -> Task:
        owner = owner_key()
        if owner is None:
            raise ContextNotOwned()
        # A new conversation is its first caller's; re-inserting keeps the most recently used last.
        current = self.context_owners.pop(context_id, owner)
        self.context_owners[context_id] = current
        if current != owner:
            raise ContextNotOwned()
        task = await super().submit_task(context_id, message)
        self.task_owners[task['id']] = owner
        self._trim()
        return task

    async def update_context(self, context_id: str, context: list[Any]) -> None:
        # A conversation dropped while its run was in flight is not brought back without an owner.
        if context_id in self.context_owners:
            await super().update_context(context_id, context)

    def owns_task(self, task_id: str) -> bool:
        owner = owner_key()
        return owner is not None and self.task_owners.get(task_id) == owner

    def _trim(self) -> None:
        while len(self.context_owners) > self.max_tasks:
            oldest = next(iter(self.context_owners))
            del self.context_owners[oldest]
            self.contexts.pop(oldest, None)
        while len(self.task_owners) > self.max_tasks:
            oldest = next((id for id in self.task_owners if self.tasks[id]['status']['state'] in FINAL_STATES), None)
            if oldest is None:
                break
            del self.task_owners[oldest]
            del self.tasks[oldest]


def _not_found() -> TaskNotFoundError:
    return TaskNotFoundError(code=-32001, message='Task not found')


@dataclass
class OwnedTaskManager(TaskManager):
    """FastA2A's task manager, answering only the caller that owns the task or conversation.

    `cancel_run` stops the run of a task before the cancel is queued; it is the worker's.
    """

    cancel_run: Callable[[str], Awaitable[None]] | None = None

    @property
    def owned_storage(self) -> OwnedStorage:
        assert isinstance(self.storage, OwnedStorage)
        return self.storage

    def _may_send(self, message: Message) -> bool:
        task_id = message.get('task_id')
        return task_id is None or self.owned_storage.owns_task(task_id)

    def _refusal_event(self, request_id: Any) -> bytes:
        return self._format_sse_event(StreamMessageResponse(jsonrpc='2.0', id=request_id, error=_not_found()))

    async def send_message(self, request: SendMessageRequest) -> SendMessageResponse:
        refused = SendMessageResponse(jsonrpc='2.0', id=request['id'], error=_not_found())
        if not self._may_send(request['params']['message']):
            return refused
        try:
            return await super().send_message(request)
        except ContextNotOwned:
            return refused

    async def stream_message(self, request: StreamMessageRequest) -> AsyncIterator[bytes]:
        if not self._may_send(request['params']['message']):
            yield self._refusal_event(request['id'])
            return
        try:
            # Refused while the task is submitted, before the first event.
            async with aclosing(super().stream_message(request)) as events:
                async for event in events:
                    yield event
        except ContextNotOwned:
            yield self._refusal_event(request['id'])

    async def get_task(self, request: GetTaskRequest) -> GetTaskResponse:
        if not self.owned_storage.owns_task(request['params']['id']):
            return GetTaskResponse(jsonrpc='2.0', id=request['id'], error=_not_found())
        return await super().get_task(request)

    async def cancel_task(self, request: CancelTaskRequest) -> CancelTaskResponse:
        task_id = request['params']['id']
        if not self.owned_storage.owns_task(task_id):
            return CancelTaskResponse(jsonrpc='2.0', id=request['id'], error=_not_found())
        if self.cancel_run is not None:
            await self.cancel_run(task_id)
        return await super().cancel_task(request)

    async def resubscribe_task(self, request: ResubscribeTaskRequest) -> AsyncIterator[bytes]:
        if not self.owned_storage.owns_task(request['params']['id']):
            yield self._refusal_event(request['id'])
            return
        async with aclosing(super().resubscribe_task(request)) as events:
            async for event in events:
                yield event
