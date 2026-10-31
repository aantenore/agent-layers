"""Who owns which task and conversation.

FastA2A keeps every task in one shared store and answers any caller that knows an id. Here each task and each
`contextId` has an owner, recorded when it is created, and every other caller is told the task does not exist: the
answer for an unknown id, so ids cannot be probed.

The owner key is the SHA-256 of the caller's bearer token. This agent does not verify the token (the gateway does, on
every model and tool call), so it cannot know the subject behind it. Only the digest is kept; the token itself is
never stored, returned or logged.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any

from fasta2a.schema import (
    CancelTaskRequest,
    CancelTaskResponse,
    GetTaskRequest,
    GetTaskResponse,
    JSONRPCError,
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

from .caller import RUN_OWNER, owner_key

FINAL_STATES = frozenset({'completed', 'canceled', 'failed', 'rejected'})


class ContextNotOwned(Exception):
    """A message named a conversation that belongs to another caller."""


class TooManyTasks(Exception):
    """The caller is at its cap of tasks or conversations and none of them can be dropped."""


class OwnedStorage(InMemoryStorage[list[Any]]):
    """In-memory storage that records the owner of each task and conversation, and keeps a bounded number of them.

    At most `max_tasks` tasks and `max_tasks` conversations are kept, and `max_tasks // 4` of each per owner. Beyond a
    cap the oldest finished task, or the least recently used conversation without a task in flight, is dropped (the
    owner's own first); when nothing can be dropped the owner's new task is refused. A dropped conversation leaves a
    tombstone with its owner, so its id cannot be claimed by anyone else; its owner may use it again, from scratch.
    The tombstones are bounded too (`max_tasks`, oldest first). A task or conversation without an owner is never served.
    """

    def __init__(self, max_tasks: int) -> None:
        super().__init__()
        self.max_tasks = max_tasks
        self.per_owner = max(1, max_tasks // 4)
        self.task_owners: dict[str, str] = {}
        self.context_owners: dict[str, str] = {}
        self.evicted_contexts: dict[str, str] = {}

    async def submit_task(self, context_id: str, message: Message) -> Task:
        owner = owner_key()
        if owner is None:
            raise ContextNotOwned()
        current = self.context_owners.get(context_id)
        if current not in (None, owner) or (current is None and self.evicted_contexts.get(context_id, owner) != owner):
            raise ContextNotOwned()
        # Room is made, or the task refused, before anything changes.
        context_victim = task_victim = None
        if current is None and self._count(self.context_owners, owner) >= self.per_owner:
            context_victim = self._idle_context(owner)
            if context_victim is None:
                raise TooManyTasks()
        if self._count(self.task_owners, owner) >= self.per_owner:
            task_victim = self._finished_task(owner)
            if task_victim is None:
                raise TooManyTasks()
        if context_victim is not None:
            self._drop_context(context_victim)
        if task_victim is not None:
            self._drop_task(task_victim)
        # Re-inserting keeps the most recently used conversation last.
        self.context_owners.pop(context_id, None)
        self.context_owners[context_id] = owner
        self.evicted_contexts.pop(context_id, None)
        task = await super().submit_task(context_id, message)
        self.task_owners[task['id']] = owner
        self._trim()
        return task

    async def load_context(self, context_id: str) -> list[Any] | None:
        return await super().load_context(context_id) if self._runs_for(context_id) else None

    async def update_context(self, context_id: str, context: list[Any]) -> None:
        # Only the owner of the running task writes, and only while the conversation is still its own.
        if self._runs_for(context_id):
            await super().update_context(context_id, context)

    def owns_task(self, task_id: str) -> bool:
        owner = owner_key()
        return owner is not None and self.task_owners.get(task_id) == owner

    def _runs_for(self, context_id: str) -> bool:
        owner = RUN_OWNER.get()
        return owner is not None and self.context_owners.get(context_id) == owner

    @staticmethod
    def _count(owners: dict[str, str], owner: str) -> int:
        return sum(1 for o in owners.values() if o == owner)

    def _idle_context(self, owner: str | None = None) -> str | None:
        busy = {t['context_id'] for t in self.tasks.values() if t['status']['state'] not in FINAL_STATES}
        return next((c for c, o in self.context_owners.items() if c not in busy and owner in (None, o)), None)

    def _finished_task(self, owner: str | None = None) -> str | None:
        return next(
            (t for t, o in self.task_owners.items() if owner in (None, o) and self.tasks[t]['status']['state'] in FINAL_STATES),
            None,
        )

    def _drop_context(self, context_id: str) -> None:
        self.evicted_contexts[context_id] = self.context_owners.pop(context_id)
        self.contexts.pop(context_id, None)
        while len(self.evicted_contexts) > self.max_tasks:
            del self.evicted_contexts[next(iter(self.evicted_contexts))]

    def _drop_task(self, task_id: str) -> None:
        del self.task_owners[task_id]
        del self.tasks[task_id]

    def _trim(self) -> None:
        while len(self.context_owners) > self.max_tasks and (victim := self._idle_context()) is not None:
            self._drop_context(victim)
        while len(self.task_owners) > self.max_tasks and (victim := self._finished_task()) is not None:
            self._drop_task(victim)


def _not_found() -> TaskNotFoundError:
    return TaskNotFoundError(code=-32001, message='Task not found')


def _too_many() -> JSONRPCError[int, str]:
    return JSONRPCError(code=-32000, message='Too many tasks for this caller')


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

    def _refusal_event(self, request_id: Any, error: Any = None) -> bytes:
        return self._format_sse_event(StreamMessageResponse(jsonrpc='2.0', id=request_id, error=error or _not_found()))

    async def send_message(self, request: SendMessageRequest) -> SendMessageResponse:
        refused = SendMessageResponse(jsonrpc='2.0', id=request['id'], error=_not_found())
        if not self._may_send(request['params']['message']):
            return refused
        try:
            return await super().send_message(request)
        except ContextNotOwned:
            return refused
        except TooManyTasks:
            return SendMessageResponse(jsonrpc='2.0', id=request['id'], error=_too_many())

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
        except TooManyTasks:
            yield self._refusal_event(request['id'], _too_many())

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
