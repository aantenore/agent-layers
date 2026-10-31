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

import math
import time
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
class _Context:
    """One conversation: its history, when it was last used, and a global rank of that use."""

    history: list[Any]
    used_at: float
    rank: int


@dataclass
class _Space:
    """What one owner has: tasks in creation order, conversations from least to most recently used."""

    tasks: dict[str, Task] = field(default_factory=dict)
    contexts: dict[str, _Context] = field(default_factory=dict)

    def idle_contexts(self) -> list[str]:
        busy = {t['context_id'] for t in self.tasks.values() if t['status']['state'] not in FINAL_STATES}
        return [c for c in self.contexts if c not in busy]

    def finished_task(self) -> str | None:
        return next((i for i, t in self.tasks.items() if t['status']['state'] in FINAL_STATES), None)

    def empty(self) -> bool:
        return not self.tasks and not self.contexts


class TaskStore(Storage[list[Any]]):
    """The worker's storage: tasks and conversations in a namespace per owner, in memory.

    At most `max_tasks` tasks and `max_tasks` conversations are kept, and `max_tasks_per_owner` of each per owner (None
    for either: no cap). To make
    room for a new task, the owner drops its own oldest finished task or least recently used idle conversation, whatever
    its age, when it is at its own cap or when the store is full. Only when the store is full and the owner has nothing
    to drop does it reclaim from other owners, and then only the oldest finished tasks and idle conversations that are
    at least `cross_owner_min_age_s` old (since the task finished or the conversation was last used). Never dropped: a
    task submitted or working, and a conversation with such a task. When there is nothing to drop the new task is
    refused.

    Finished tasks expire after `finished_ttl_s`, and idle conversations after `idle_ttl_s` since their last use (None:
    they are kept until dropped for room).
    Expiry is applied when the store is used (`sweep`), not by a timer.
    """

    def __init__(
        self,
        max_tasks: int | None,
        max_tasks_per_owner: int | None,
        finished_ttl_s: float | None,
        idle_ttl_s: float | None,
        cross_owner_min_age_s: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_tasks = math.inf if max_tasks is None else max_tasks
        self.per_owner = math.inf if max_tasks_per_owner is None else max_tasks_per_owner
        self.finished_ttl_s = math.inf if finished_ttl_s is None else finished_ttl_s
        self.idle_ttl_s = math.inf if idle_ttl_s is None else idle_ttl_s
        self.cross_owner_min_age_s = cross_owner_min_age_s
        self.clock = clock
        self._spaces: dict[str, _Space] = {}
        self._task_owner: dict[str, str] = {}  # in creation order, across owners
        self._finished_at: dict[str, float] = {}
        self._rank = 0

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
        if state in FINAL_STATES:
            self._finished_at[task_id] = self.clock()
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
        context = space.contexts.get(context_id) if space else None
        return list(context.history) if context is not None else None

    async def update_context(self, context_id: str, context: list[Any]) -> None:
        space = self._spaces.get(RUN_OWNER.get() or '')
        if space is not None and context_id in space.contexts:
            space.contexts.pop(context_id)
            space.contexts[context_id] = self._context(context)

    async def submit_task(self, context_id: str, message: Message) -> Task:
        raise NotImplementedError('tasks are submitted for an owner: see `submit`')

    # Caller side: always for one owner.

    def task_of(self, owner: str | None, task_id: str, history_length: int | None = None) -> Task | None:
        space = self._spaces.get(owner or '')
        task = space.tasks.get(task_id) if space else None
        if task is not None and history_length and 'history' in task:
            task = Task(**{**task, 'history': task['history'][-history_length:]})
        return task

    def sweep(self) -> None:
        """Drop the finished tasks and idle conversations that have outlived their time to live."""
        now = self.clock()
        for owner, space in list(self._spaces.items()):
            for task_id in [i for i in space.tasks if now - self._finished_at.get(i, now) >= self.finished_ttl_s]:
                self._drop_task(owner, task_id)
            for context_id in space.idle_contexts():
                if now - space.contexts[context_id].used_at >= self.idle_ttl_s:
                    del space.contexts[context_id]
            self._prune(owner)

    def submit(self, owner: str, context_id: str, message: Message) -> Task:
        self.sweep()
        space = self._spaces.get(owner) or _Space()
        context_victim = None
        if context_id not in space.contexts:
            context_victim = self._room(
                len(space.contexts), self._context_count(), self._own_idle_context(owner, space), self._oldest_idle_context
            )
        task_victim = self._room(
            len(space.tasks), len(self._task_owner), self._own_finished_task(owner, space), self._oldest_finished_task
        )
        if context_victim is not None:
            self._drop_context(*context_victim)
        if task_victim is not None:
            self._drop_task(*task_victim)

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
        previous = space.contexts.pop(context_id, None)
        space.contexts[context_id] = self._context(previous.history if previous else [])
        space.tasks[task_id] = task
        self._spaces[owner] = space
        self._task_owner[task_id] = owner
        return task

    def _room(
        self,
        own: int,
        total: int,
        own_victim: tuple[str, str] | None,
        any_victim: Callable[[], tuple[str, str] | None],
    ) -> tuple[str, str] | None:
        """What to drop for one more: nothing below the caps; else the owner's own, else (store full) an old one of anyone."""
        if own < self.per_owner and total < self.max_tasks:
            return None
        victim = own_victim
        if victim is None and own < self.per_owner:
            victim = any_victim()
        if victim is None:
            raise TooManyTasks()
        return victim

    def _context(self, history: list[Any]) -> _Context:
        self._rank += 1
        return _Context(history=history, used_at=self.clock(), rank=self._rank)

    def _context_count(self) -> int:
        return sum(len(s.contexts) for s in self._spaces.values())

    @staticmethod
    def _own_idle_context(owner: str, space: _Space) -> tuple[str, str] | None:
        idle = space.idle_contexts()
        return (owner, idle[0]) if idle else None

    @staticmethod
    def _own_finished_task(owner: str, space: _Space) -> tuple[str, str] | None:
        task_id = space.finished_task()
        return (owner, task_id) if task_id else None

    def _oldest_idle_context(self) -> tuple[str, str] | None:
        best: tuple[int, str, str] | None = None
        now = self.clock()
        for owner, space in self._spaces.items():
            for context_id in space.idle_contexts():
                rank = space.contexts[context_id].rank
                if now - space.contexts[context_id].used_at < self.cross_owner_min_age_s:
                    continue
                if best is None or rank < best[0]:
                    best = (rank, owner, context_id)
        return (best[1], best[2]) if best else None

    def _oldest_finished_task(self) -> tuple[str, str] | None:
        now = self.clock()
        for task_id, owner in self._task_owner.items():
            if self._spaces[owner].tasks[task_id]['status']['state'] in FINAL_STATES and (
                now - self._finished_at.get(task_id, now) >= self.cross_owner_min_age_s
            ):
                return owner, task_id
        return None

    def _drop_context(self, owner: str, context_id: str) -> None:
        del self._spaces[owner].contexts[context_id]
        self._prune(owner)

    def _drop_task(self, owner: str, task_id: str) -> None:
        del self._spaces[owner].tasks[task_id]
        del self._task_owner[task_id]
        self._finished_at.pop(task_id, None)
        self._prune(owner)

    def _prune(self, owner: str) -> None:
        if owner in self._spaces and self._spaces[owner].empty():
            del self._spaces[owner]


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
        self.store.sweep()
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
