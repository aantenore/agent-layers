"""Tasks and conversations belong to the caller that created them; everyone else is told they do not exist."""

import hashlib
import json
import logging

import anyio
import httpx2
import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import ModelResponse, TextPart
from pydantic_ai.models.function import FunctionModel

from agent_layers_pydantic_ai.app import create_app
from agent_layers_pydantic_ai.caller import RUN_OWNER
from agent_layers_pydantic_ai.settings import load_settings
from agent_layers_pydantic_ai.spec import AgentSpec

pytestmark = pytest.mark.anyio
ORIGIN = 'http://localhost:9100'
TOKEN_A = 'token-of-caller-a-91c2'
TOKEN_B = 'token-of-caller-b-47d8'
NOT_FOUND = -32001
TOO_MANY = -32000


@pytest.fixture
def anyio_backend():
    return 'asyncio'


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Model:
    """A model that answers after `delay` seconds, and counts the runs that got to the end."""

    def __init__(self, delay: float = 0.0) -> None:
        self.delay = delay
        self.calls = 0
        self.finished = 0

    async def __call__(self, _messages, _info):
        self.calls += 1
        await anyio.sleep(self.delay)
        self.finished += 1
        return ModelResponse(parts=[TextPart('done')])


class Server:
    def __init__(self, client: httpx2.AsyncClient, app, model: Model) -> None:
        self.client = client
        self.app = app
        self.model = model
        self.storage = app.task_manager.storage.store

    async def rpc(self, token: str, method: str, params: dict) -> dict:
        body = {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}
        res = await self.client.post('/', json=body, headers={'authorization': f'Bearer {token}'})
        assert res.status_code == 200, res.text
        return res.json()

    async def send(self, token: str, text: str = 'Hello', context_id: str | None = None, task_id: str | None = None) -> dict:
        message = {'messageId': f'm-{text}', 'role': 'ROLE_USER', 'parts': [{'text': text}]}
        if context_id:
            message['contextId'] = context_id
        if task_id:
            message['taskId'] = task_id
        return await self.rpc(token, 'SendMessage', {'message': message})

    async def created(self, token: str, **kw) -> dict:
        answer = await self.send(token, **kw)
        assert 'error' not in answer, answer
        return answer['result']['task']

    async def wait_for(self, task_id: str, state: str) -> dict:
        for _ in range(200):
            task = await self.storage.load_task(task_id)
            if task['status']['state'] == state:
                return task
            await anyio.sleep(0.01)
        raise AssertionError(f'task did not reach {state}')

    async def stream(self, token: str, method: str, params: dict) -> list[dict]:
        body = {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}
        res = await self.client.post('/', json=body, headers={'authorization': f'Bearer {token}'})
        assert res.status_code == 200, res.text
        return [json.loads(line.removeprefix('data: ')) for line in res.text.splitlines() if line.startswith('data: ')]


async def start(env: dict[str, str] | None = None, delay: float = 0.0):
    settings = load_settings({'AGENT_FILE': 'unused.md', 'GATEWAY_MODEL': 'mock', **(env or {})})
    spec = AgentSpec(name='assistant', instructions='', model='mock', tools=(), knowledge=())
    model = Model(delay)
    model_client = httpx2.AsyncClient()
    app = create_app(spec, settings, agent=Agent(FunctionModel(model)), http_client=model_client)
    return app, model, model_client


@pytest.fixture
async def server():
    app, model, model_client = await start()
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            yield Server(client, app, model)
    await model_client.aclose()


async def test_get_task_is_answered_to_its_owner_only(server):
    task = await server.created(TOKEN_A)
    await server.wait_for(task['id'], 'completed')
    refused = await server.rpc(TOKEN_B, 'GetTask', {'id': task['id']})
    unknown = await server.rpc(TOKEN_B, 'GetTask', {'id': 'no-such-task'})
    assert refused['error']['code'] == NOT_FOUND
    assert refused == unknown
    found = await server.rpc(TOKEN_A, 'GetTask', {'id': task['id']})
    assert found['result']['id'] == task['id']
    assert found['result']['status']['state'] == 'TASK_STATE_COMPLETED'


async def test_cancel_by_another_caller_is_refused_and_leaves_the_task_alone():
    app, model, model_client = await start(delay=0.3)
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            server = Server(client, app, model)
            task = await server.created(TOKEN_A)
            await server.wait_for(task['id'], 'working')
            refused = await server.rpc(TOKEN_B, 'CancelTask', {'id': task['id']})
            assert refused == await server.rpc(TOKEN_B, 'CancelTask', {'id': 'no-such-task'})
            assert refused['error']['code'] == NOT_FOUND
            await anyio.sleep(0.05)
            assert (await server.storage.load_task(task['id']))['status']['state'] == 'working'
            await server.wait_for(task['id'], 'completed')
            assert model.finished == 1
    await model_client.aclose()


async def test_cancel_by_the_owner_stops_the_run():
    app, model, model_client = await start(delay=0.3)
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            server = Server(client, app, model)
            task = await server.created(TOKEN_A)
            await server.wait_for(task['id'], 'working')
            answer = await server.rpc(TOKEN_A, 'CancelTask', {'id': task['id']})
            assert answer['result']['status']['state'] == 'TASK_STATE_CANCELED'
            await anyio.sleep(0.5)
            final = await server.storage.load_task(task['id'])
            assert final['status']['state'] == 'canceled'
            assert not final.get('artifacts')
            assert model.calls == 1 and model.finished == 0
    await model_client.aclose()


async def test_a_context_id_used_by_another_caller_is_a_separate_conversation(server):
    first = await server.created(TOKEN_A, text='first', context_id='ctx-a')
    await server.wait_for(first['id'], 'completed')
    spaces = server.storage._spaces
    history = list(spaces[digest(TOKEN_A)].contexts['ctx-a'].history)

    other = await server.created(TOKEN_B, text='mine', context_id='ctx-a')
    await server.wait_for(other['id'], 'completed')
    assert spaces[digest(TOKEN_A)].contexts['ctx-a'].history == history
    assert len(spaces[digest(TOKEN_B)].contexts['ctx-a'].history) == 2  # only B's own message and answer
    assert [t['id'] for t in spaces[digest(TOKEN_A)].tasks.values()] == [first['id']]

    second = await server.created(TOKEN_A, text='second', context_id='ctx-a')
    await server.wait_for(second['id'], 'completed')
    assert len(spaces[digest(TOKEN_A)].contexts['ctx-a'].history) > len(history)
    assert len(spaces[digest(TOKEN_B)].contexts['ctx-a'].history) == 2


async def test_a_message_naming_a_task_of_another_caller_is_refused(server):
    task = await server.created(TOKEN_A)
    assert (await server.send(TOKEN_B, task_id=task['id']))['error']['code'] == NOT_FOUND
    assert (await server.send(TOKEN_B, task_id='no-such-task'))['error']['code'] == NOT_FOUND
    assert 'error' not in await server.send(TOKEN_A, task_id=task['id'])


async def test_streaming_and_resubscribe_do_not_reach_other_callers(server):
    task = await server.created(TOKEN_A, context_id='ctx-s')
    await server.wait_for(task['id'], 'completed')

    events = await server.stream(TOKEN_B, 'SubscribeToTask', {'id': task['id']})
    assert [e['error']['code'] for e in events] == [NOT_FOUND]
    assert events == await server.stream(TOKEN_B, 'SubscribeToTask', {'id': 'no-such-task'})

    events = await server.stream(TOKEN_A, 'SubscribeToTask', {'id': task['id']})
    assert events[0]['result']['task']['id'] == task['id']

    message = {'messageId': 'm-s', 'role': 'ROLE_USER', 'parts': [{'text': 'Hi'}], 'contextId': 'ctx-s'}
    refused = await server.stream(TOKEN_B, 'SendStreamingMessage', {'message': {**message, 'taskId': task['id']}})
    assert [e['error']['code'] for e in refused] == [NOT_FOUND]
    events = await server.stream(TOKEN_A, 'SendStreamingMessage', {'message': message})
    assert 'error' not in events[0] and events[0]['result']['task']['contextId'] == 'ctx-s'


async def test_the_raw_token_is_never_kept_or_logged(server, caplog):
    caplog.set_level(logging.DEBUG)
    task = await server.created(TOKEN_A, context_id='ctx-t')
    await server.wait_for(task['id'], 'completed')
    await server.rpc(TOKEN_B, 'GetTask', {'id': task['id']})
    kept = repr(server.storage.__dict__)
    for token in (TOKEN_A, TOKEN_B):
        assert token not in kept
        assert token not in caplog.text
    assert digest(TOKEN_A) in kept
    assert TOKEN_A not in json.dumps(await server.rpc(TOKEN_A, 'GetTask', {'id': task['id']}))


async def test_a_run_reads_and_writes_the_conversation_of_its_owner_only(server):
    store = server.storage
    for token in (TOKEN_A, TOKEN_B):
        task = await server.created(token, context_id='ctx-w')
        await server.wait_for(task['id'], 'completed')
    spaces = store._spaces
    a, b = digest(TOKEN_A), digest(TOKEN_B)
    history_a, history_b = list(spaces[a].contexts['ctx-w'].history), list(spaces[b].contexts['ctx-w'].history)

    async def as_run_of(owner, action):
        reset = RUN_OWNER.set(owner)
        try:
            return await action
        finally:
            RUN_OWNER.reset(reset)

    await as_run_of(a, store.update_context('ctx-w', ['written by A']))
    assert spaces[a].contexts['ctx-w'].history == ['written by A'] and spaces[b].contexts['ctx-w'].history == history_b
    assert await as_run_of(b, store.load_context('ctx-w')) == history_b
    # No run owner, an owner without that conversation, or an unknown owner: nothing is read or written.
    await store.update_context('ctx-w', ['no owner'])
    await as_run_of(digest('nobody'), store.update_context('ctx-w', ['stranger']))
    await as_run_of(a, store.update_context('ctx-other', ['not registered']))
    assert await store.load_context('ctx-w') is None
    assert spaces[a].contexts['ctx-w'].history == ['written by A'] and spaces[b].contexts['ctx-w'].history == history_b
    assert 'ctx-other' not in spaces[a].contexts and history_a != spaces[a].contexts['ctx-w'].history


async def test_a_full_store_makes_room_with_the_oldest_finished_work_of_anyone():
    app, model, model_client = await start({'MAX_TASKS': '8'})
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            server = Server(client, app, model)
            store = server.storage
            tasks = []
            for n in range(4):  # four owners, two finished tasks and two conversations each: the store is full
                for m in range(2):
                    task = await server.created(f'token-{n}', context_id=f'ctx-{n}-{m}')
                    await server.wait_for(task['id'], 'completed')
                    tasks.append(task['id'])
            assert len(store._task_owner) == 8 and store._context_count() == 8
            newcomer = await server.created('token-new', context_id='ctx-new')
            assert set(store._task_owner) == set(tasks[1:]) | {newcomer['id']}
            assert 'ctx-0-0' not in store._spaces[digest('token-0')].contexts
            assert set(store._spaces[digest('token-new')].contexts) == {'ctx-new'}
            assert store._context_count() == 8
            assert (await server.rpc('token-0', 'GetTask', {'id': tasks[0]}))['error']['code'] == NOT_FOUND
    await model_client.aclose()


async def test_a_store_full_of_work_in_flight_refuses_and_drops_nothing():
    app, model, model_client = await start({'MAX_TASKS': '4'}, delay=0.3)
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            server = Server(client, app, model)
            tasks = [await server.created(f'token-{n}', context_id=f'ctx-{n}') for n in range(4)]
            refused = await server.send('token-new', context_id='ctx-new')
            assert refused['error'] == {'code': TOO_MANY, 'message': 'Too many tasks'}
            assert set(server.storage._task_owner) == {t['id'] for t in tasks}
            assert server.storage._context_count() == 4
            for task in tasks:
                await server.wait_for(task['id'], 'completed')
            assert 'error' not in await server.send('token-new', context_id='ctx-new')
    await model_client.aclose()


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def test_finished_tasks_and_idle_conversations_expire(server):
    clock = Clock()
    store = server.storage
    store.clock, store.finished_ttl_s, store.idle_ttl_s = clock, 100.0, 1000.0
    task = await server.created(TOKEN_A, context_id='ctx-ttl')
    await server.wait_for(task['id'], 'completed')

    clock.now += 99
    assert 'result' in await server.rpc(TOKEN_A, 'GetTask', {'id': task['id']})
    clock.now += 2  # the task is past its time, the conversation is not
    assert (await server.rpc(TOKEN_A, 'GetTask', {'id': task['id']}))['error']['code'] == NOT_FOUND
    assert list(store._spaces[digest(TOKEN_A)].contexts) == ['ctx-ttl']
    clock.now += 900  # 1001 s since the last use of the conversation
    await server.rpc(TOKEN_A, 'GetTask', {'id': 'whatever'})
    assert store._spaces == {} and store._task_owner == {}


async def test_nothing_in_flight_expires():
    app, model, model_client = await start(delay=0.3)
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            server = Server(client, app, model)
            clock = Clock()
            store = server.storage
            store.clock, store.finished_ttl_s, store.idle_ttl_s = clock, 10.0, 10.0
            task = await server.created(TOKEN_A, context_id='ctx-run')
            await server.wait_for(task['id'], 'working')
            clock.now += 5000
            found = await server.rpc(TOKEN_A, 'GetTask', {'id': task['id']})
            assert found['result']['id'] == task['id']
            assert 'ctx-run' in store._spaces[digest(TOKEN_A)].contexts
            await server.wait_for(task['id'], 'completed')
    await model_client.aclose()


async def test_an_owner_at_its_cap_loses_its_own_oldest_finished_task_first_then_is_refused():
    app, model, model_client = await start({'MAX_TASKS': '8'}, delay=0.3)
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            server = Server(client, app, model)
            other = await server.created(TOKEN_B, context_id='ctx-other')
            first = await server.created(TOKEN_A, context_id='ctx-1')
            await server.wait_for(first['id'], 'completed')
            second = await server.created(TOKEN_A, context_id='ctx-1')
            # At its cap (2): the finished task goes, the other caller's task stays.
            third = await server.created(TOKEN_A, context_id='ctx-1')
            tasks = server.storage._task_owner
            assert first['id'] not in tasks and other['id'] in tasks and second['id'] in tasks
            # Two tasks in flight and none finished: refused with a plain error that says nothing of others.
            refused = await server.send(TOKEN_A, context_id='ctx-1')
            assert refused['error'] == {'code': TOO_MANY, 'message': 'Too many tasks'}
            events = await server.stream(TOKEN_A, 'SendStreamingMessage', {'message': {
                'messageId': 'm-x', 'role': 'ROLE_USER', 'parts': [{'text': 'x'}], 'contextId': 'ctx-1'}})
            assert [e['error']['code'] for e in events] == [TOO_MANY]
            assert len(tasks) == 3
            await server.wait_for(third['id'], 'completed')
            assert 'error' not in await server.send(TOKEN_A, context_id='ctx-1')
    await model_client.aclose()


async def test_a_conversation_with_a_task_in_flight_is_not_dropped():
    app, model, model_client = await start({'MAX_TASKS': '8'}, delay=0.4)
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            server = Server(client, app, model)
            idle = await server.created(TOKEN_A, context_id='ctx-idle')
            await server.wait_for(idle['id'], 'completed')
            busy = await server.created(TOKEN_A, context_id='ctx-busy')
            await server.wait_for(busy['id'], 'working')
            # At its cap of 2 conversations: the idle one goes, never the one with a task in flight.
            third = await server.created(TOKEN_A, context_id='ctx-3')
            contexts = server.storage._spaces[digest(TOKEN_A)].contexts
            assert set(contexts) == {'ctx-busy', 'ctx-3'}
            # Both remaining conversations have a task in flight: a fourth is refused.
            assert (await server.send(TOKEN_A, context_id='ctx-4'))['error']['code'] == TOO_MANY
            assert set(contexts) == {'ctx-busy', 'ctx-3'}
            for task in (busy, third):
                await server.wait_for(task['id'], 'completed')
    await model_client.aclose()


async def test_an_owner_at_its_conversation_cap_loses_its_least_recently_used_idle_one():
    app, model, model_client = await start({'MAX_TASKS': '8'})
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            server = Server(client, app, model)
            for context in ('ctx-1', 'ctx-2', 'ctx-1', 'ctx-3'):  # ctx-2 is the least recently used
                task = await server.created(TOKEN_A, context_id=context)
                await server.wait_for(task['id'], 'completed')
            assert list(server.storage._spaces[digest(TOKEN_A)].contexts) == ['ctx-1', 'ctx-3']
    await model_client.aclose()
