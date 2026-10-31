"""Tasks and conversations kept per caller.

FastA2A keeps every task in one shared store and answers any caller that knows an id. Here the store is split by
owner: each owner has a namespace of its own for tasks and conversations, and the task manager sees the store only
through `CallerStorage`, which resolves every lookup in the namespace of the caller being served. An id that belongs to
someone else is therefore not found, exactly like an unknown id, and a `contextId` that someone else uses is just a
separate conversation. The wire ids are unchanged.

The owner key is the SHA-256 of the caller's bearer token. This agent does not verify the token (the gateway does, on
every model and tool call), so it cannot know the subject behind it. Only the digest is kept; the token itself is
never stored, returned or logged.

The worker is the only code that reads the store by task id alone (it created the task for its owner); it finds the
conversation of a run in the namespace of the run's owner.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import aclosing
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from fasta2a.schema import (
    Artifact,
    CancelTaskRequest,
    CancelTaskResponse,
    JSONRPCError,
    Message,
    SendMessageRequest,
    SendMessageResponse,
    StreamMessageRequest,
    StreamMessageResponse,
    Task,
    TaskNotFoundError,
    TaskState,
    TaskStatus,
)
from fasta2a.storage import Storage
from fasta2a.task_manager import TaskManager

from .caller import RUN_OWNER, MissingCaller, owner_key

FINAL_STATES = frozenset({'completed', 'canceled', 'failed', 'rejected'})


class TooManyTasks(Exception):
    """The new task would exceed a cap, and the caller has nothing of its own that can be dropped."""


@dataclass
class _Space:
    """What one owner has: tasks in creation order, conversations from least to most recently used."""

    tasks: dict[str, Task] = field(default_factory=dict)
    contexts: dict[str, list[Any]] = field(default_factory=dict)

    def idle_context(self) -> str | None:
        busy = {t['context_id'] for t in self.tasks.values() if t['status']['state'] not in FINAL_STATES}
        return next((c for c in self.contexts if c not in busy), None)

    def finished_task(self) -> str | None:
        return next((i for i, t in self.tasks.items() if t['status']['state'] in FINAL_STATES), None)


class TaskStore(Storage[list[Any]]):
    """The worker's storage: tasks and conversations in a namespace per owner, in memory.

    At most `max_tasks` tasks and `max_tasks` conversations are kept, and `max_tasks // 4` of each per owner. At a cap,
    only the requesting owner's own oldest finished task, or least recently used conversation without a task in flight,
    is dropped to make room; when it has none the new task is refused. Nothing of another owner is ever dropped, and
    nothing submitted or working is.
    """

    def __init__(self, max_tasks: int) -> None:
        self.max_tasks = max_tasks
        self.per_owner = max(1, max_tasks // 4)
        self._spaces: dict[str, _Space] = {}
        self._task_owner: dict[str, str] = {}

    # Worker side: by task id, and by the owner of the run.

    async def load_task(self, task_id: str, history_length: int | None = None) -> Task | None:
        owner = self._task_owner.get(task_id)
        return self.task_of(owner, task_id, history_length) if owner else None

    async def update_task(
        self,
        task_id: str,
        state: TaskState,
        new_artifacts: list[Artifact] | None = None,
        new_messages: list[Message] | None = None,
    ) -> Task:
        task = self._spaces[self._task_owner[task_id]].tasks[task_id]
        task['status'] = TaskStatus(state=state, timestamp=datetime.now().isoformat())
        if new_artifacts:
            task.setdefault('artifacts', []).extend(new_artifacts)
        if new_messages:
            history = task.setdefault('history', [])
            for message in new_messages:
                message['task_id'] = task_id
                message['context_id'] = task['context_id']
                history.append(message)
        return task

    async def load_context(self, context_id: str) -> list[Any] | None:
        space = self._spaces.get(RUN_OWNER.get() or '')
        history = space.contexts.get(context_id) if space else None
        return list(history) if history is not None else None

    async def update_context(self, context_id: str, context: list[Any]) -> None:
        space = self._spaces.get(RUN_OWNER.get() or '')
        if space is not None and context_id in space.contexts:
            space.contexts[context_id] = context

    async def submit_task(self, context_id: str, message: Message) -> Task:
        raise NotImplementedError('tasks are submitted for an owner: see `submit`')

    # Caller side: always for one owner.

    def task_of(self, owner: str | None, task_id: str, history_length: int | None = None) -> Task | None:
        space = self._spaces.get(owner or '')
        task = space.tasks.get(task_id) if space else None
        if task is not None and history_length and 'history' in task:
            task = Task(**{**task, 'history': task['history'][-history_length:]})
        return task

    def submit(self, owner: str, context_id: str, message: Message) -> Task:
        space = self._spaces.get(owner) or _Space()
        context_victim = task_victim = None
        if context_id not in space.contexts and (
            len(space.contexts) >= self.per_owner or sum(len(s.contexts) for s in self._spaces.values()) >= self.max_tasks
        ):
            context_victim = space.idle_context()
            if context_victim is None:
                raise TooManyTasks()
        if len(space.tasks) >= self.per_owner or len(self._task_owner) >= self.max_tasks:
            task_victim = space.finished_task()
            if task_victim is None:
                raise TooManyTasks()
        if context_victim is not None:
            del space.contexts[context_victim]
        if task_victim is not None:
            del space.tasks[task_victim]
            del self._task_owner[task_victim]

        task_id = str(uuid.uuid4())
        message['task_id'] = task_id
        message['context_id'] = context_id
        task = Task(
            id=task_id,
            context_id=context_id,
            status=TaskStatus(state='submitted', timestamp=datetime.now().isoformat()),
            history=[message],
        )
        # Re-inserting keeps the most recently used conversation last.
        space.contexts[context_id] = space.contexts.pop(context_id, [])
        space.tasks[task_id] = task
        self._spaces[owner] = space
        self._task_owner[task_id] = owner
        return task


class CallerStorage(Storage[list[Any]]):
    """The task manager's view of the store: every call is for the owner of the request being served."""

    def __init__(self, store: TaskStore) -> None:
        self.store = store

    @staticmethod
    def _owner() -> str:
        owner = owner_key()
        if owner is None:
            raise MissingCaller()
        return owner

    async def load_task(self, task_id: str, history_length: int | None = None) -> Task | None:
        return self.store.task_of(self._owner(), task_id, history_length)

    async def submit_task(self, context_id: str, message: Message) -> Task:
        return self.store.submit(self._owner(), context_id, message)

    async def update_task(self, task_id: str, state: TaskState, new_artifacts: Any = None, new_messages: Any = None) -> Task:
        raise NotImplementedError('only the worker updates tasks')

    async def load_context(self, context_id: str) -> list[Any] | None:
        raise NotImplementedError('only the worker reads conversations')

    async def update_context(self, context_id: str, context: list[Any]) -> None:
        raise NotImplementedError('only the worker writes conversations')


def _not_found() -> TaskNotFoundError:
    return TaskNotFoundError(code=-32001, message='Task not found')


def _too_many() -> JSONRPCError[int, str]:
    return JSONRPCError(code=-32000, message='Too many tasks')


@dataclass
class OwnedTaskManager(TaskManager):
    """FastA2A's task manager over `CallerStorage`, with the few checks its flow needs before it touches a task.

    `cancel_run` stops the run of a task before the cancel is queued; it is the worker's.
    """

    cancel_run: Callable[[str], Awaitable[None]] | None = None

    async def _may_send(self, message: Message) -> bool:
        """A message that names a task continues one of the caller's own."""
        task_id = message.get('task_id')
        return task_id is None or await self.storage.load_task(task_id) is not None

    def _refusal_event(self, request_id: Any, error: Any = None) -> bytes:
        return self._format_sse_event(StreamMessageResponse(jsonrpc='2.0', id=request_id, error=error or _not_found()))

    async def send_message(self, request: SendMessageRequest) -> SendMessageResponse:
        if not await self._may_send(request['params']['message']):
            return SendMessageResponse(jsonrpc='2.0', id=request['id'], error=_not_found())
        try:
            return await super().send_message(request)
        except TooManyTasks:
            return SendMessageResponse(jsonrpc='2.0', id=request['id'], error=_too_many())

    async def stream_message(self, request: StreamMessageRequest) -> AsyncIterator[bytes]:
        if not await self._may_send(request['params']['message']):
            yield self._refusal_event(request['id'])
            return
        try:
            # Refused while the task is submitted, before the first event.
            async with aclosing(super().stream_message(request)) as events:
                async for event in events:
                    yield event
        except TooManyTasks:
            yield self._refusal_event(request['id'], _too_many())

    async def cancel_task(self, request: CancelTaskRequest) -> CancelTaskResponse:
        # FastA2A queues the cancel before it looks the task up.
        task_id = request['params']['id']
        if await self.storage.load_task(task_id) is None:
            return CancelTaskResponse(jsonrpc='2.0', id=request['id'], error=_not_found())
        if self.cancel_run is not None:
            await self.cancel_run(task_id)
        return await super().cancel_task(request)
