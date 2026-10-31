"""Tasks and conversations belong to the caller that created them; everyone else is told they do not exist."""

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
        self.storage = app.task_manager.storage

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


async def test_a_message_naming_another_callers_context_is_refused(server):
    first = await server.created(TOKEN_A, text='first', context_id='ctx-a')
    await server.wait_for(first['id'], 'completed')
    tasks = dict(server.storage.tasks)
    history = list(server.storage.contexts['ctx-a'])

    refused = await server.send(TOKEN_B, text='intrusion', context_id='ctx-a')
    assert refused['error']['code'] == NOT_FOUND
    assert server.storage.tasks.keys() == tasks.keys()
    assert server.storage.contexts['ctx-a'] == history
    assert server.model.calls == 1

    second = await server.created(TOKEN_A, text='second', context_id='ctx-a')
    await server.wait_for(second['id'], 'completed')
    assert len(server.storage.contexts['ctx-a']) > len(history)


async def test_a_new_context_belongs_to_its_first_caller(server):
    task = await server.created(TOKEN_B, context_id='ctx-b')
    await server.wait_for(task['id'], 'completed')
    assert (await server.send(TOKEN_A, context_id='ctx-b'))['error']['code'] == NOT_FOUND
    assert 'error' not in await server.send(TOKEN_B, context_id='ctx-b')
    generated = await server.created(TOKEN_A)
    assert (await server.send(TOKEN_B, context_id=generated['contextId']))['error']['code'] == NOT_FOUND


async def test_a_message_naming_another_callers_task_is_refused(server):
    task = await server.created(TOKEN_A)
    assert (await server.send(TOKEN_B, task_id=task['id']))['error']['code'] == NOT_FOUND
    assert (await server.send(TOKEN_B, task_id='no-such-task'))['error']['code'] == NOT_FOUND


async def test_streaming_and_resubscribe_are_refused_to_other_callers(server):
    task = await server.created(TOKEN_A, context_id='ctx-s')
    await server.wait_for(task['id'], 'completed')
    tasks = dict(server.storage.tasks)

    message = {'messageId': 'm-s', 'role': 'ROLE_USER', 'parts': [{'text': 'Hi'}], 'contextId': 'ctx-s'}
    events = await server.stream(TOKEN_B, 'SendStreamingMessage', {'message': message})
    assert [e['error']['code'] for e in events] == [NOT_FOUND]
    assert server.storage.tasks.keys() == tasks.keys()

    events = await server.stream(TOKEN_B, 'SubscribeToTask', {'id': task['id']})
    assert [e['error']['code'] for e in events] == [NOT_FOUND]
    assert events == await server.stream(TOKEN_B, 'SubscribeToTask', {'id': 'no-such-task'})

    events = await server.stream(TOKEN_A, 'SubscribeToTask', {'id': task['id']})
    assert events[0]['result']['task']['id'] == task['id']

    events = await server.stream(TOKEN_A, 'SendStreamingMessage', {'message': {**message, 'messageId': 'm-s2'}})
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
    assert TOKEN_A not in json.dumps(await server.rpc(TOKEN_A, 'GetTask', {'id': task['id']}))


async def test_owners_are_bounded_with_the_stored_tasks():
    app, model, model_client = await start({'MAX_TASKS': '4'})
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            server = Server(client, app, model)
            ids = []
            for n in range(6):
                token = f'token-{n}'
                task = await server.created(token, text=f't{n}', context_id=f'ctx-{n}')
                await server.wait_for(task['id'], 'completed')
                ids.append((token, task['id']))
            storage = server.storage
            assert len(storage.tasks) == 4 and set(storage.task_owners) == set(storage.tasks)
            assert len(storage.context_owners) == 4 and set(storage.contexts) <= set(storage.context_owners)
            assert ids[0][1] not in storage.tasks and ids[0][1] not in storage.task_owners
            assert (await server.rpc(*ids[0][:1], 'GetTask', {'id': ids[0][1]}))['error']['code'] == NOT_FOUND
            assert (await server.rpc(*ids[5][:1], 'GetTask', {'id': ids[5][1]}))['result']['id'] == ids[5][1]
            assert 'ctx-0' not in storage.contexts
    await model_client.aclose()


async def test_a_run_writes_history_only_while_its_owner_holds_the_conversation(server):
    task = await server.created(TOKEN_A, context_id='ctx-w')
    await server.wait_for(task['id'], 'completed')
    storage = server.storage
    history = list(storage.contexts['ctx-w'])
    owner_a = storage.task_owners[task['id']]

    # The conversation changes hands behind the run's back: its writes and reads are dropped.
    storage.context_owners['ctx-w'] = 'someone-else'
    reset = RUN_OWNER.set(owner_a)
    try:
        await storage.update_context('ctx-w', ['overwritten'])
        assert await storage.load_context('ctx-w') is None
    finally:
        RUN_OWNER.reset(reset)
    assert storage.contexts['ctx-w'] == history

    # Without a run owner nothing is written either.
    storage.context_owners['ctx-w'] = owner_a
    await storage.update_context('ctx-w', ['overwritten'])
    assert storage.contexts['ctx-w'] == history
    reset = RUN_OWNER.set(owner_a)
    try:
        await storage.update_context('ctx-w', ['own write'])
    finally:
        RUN_OWNER.reset(reset)
    assert storage.contexts['ctx-w'] == ['own write']


async def test_a_conversation_with_a_task_in_flight_is_not_dropped():
    app, model, model_client = await start({'MAX_TASKS': '8'}, delay=0.4)
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            server = Server(client, app, model)
            idle = await server.created(TOKEN_A, context_id='ctx-idle')
            await server.wait_for(idle['id'], 'completed')
            busy = await server.created(TOKEN_A, context_id='ctx-busy')
            await server.wait_for(busy['id'], 'working')
            # The owner is at its cap of 2 conversations: the idle one goes, never the one with a task in flight.
            third = await server.created(TOKEN_A, context_id='ctx-3')
            storage = server.storage
            assert set(storage.context_owners) == {'ctx-busy', 'ctx-3'} and 'ctx-idle' in storage.evicted_contexts
            # Both remaining conversations have a task in flight: a fourth is refused.
            refused = await server.send(TOKEN_A, context_id='ctx-4')
            assert refused['error']['code'] == TOO_MANY
            assert set(storage.context_owners) == {'ctx-busy', 'ctx-3'}
            for task in (busy, third):
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
            assert first['id'] not in server.storage.tasks and other['id'] in server.storage.tasks
            assert second['id'] in server.storage.tasks
            # Two tasks in flight and none finished: refused with a plain error that says nothing of others.
            refused = await server.send(TOKEN_A, context_id='ctx-1')
            assert refused['error'] == {'code': TOO_MANY, 'message': 'Too many tasks for this caller'}
            events = await server.stream(TOKEN_A, 'SendStreamingMessage', {'message': {
                'messageId': 'm-x', 'role': 'ROLE_USER', 'parts': [{'text': 'x'}], 'contextId': 'ctx-1'}})
            assert [e['error']['code'] for e in events] == [TOO_MANY]
            assert len(server.storage.tasks) == 3
            await server.wait_for(third['id'], 'completed')
            assert 'error' not in await server.send(TOKEN_A, context_id='ctx-1')
    await model_client.aclose()


async def test_an_owner_at_its_conversation_cap_loses_its_least_recently_used_idle_one():
    app, model, model_client = await start({'MAX_TASKS': '8'})
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            server = Server(client, app, model)
            for context in ('ctx-1', 'ctx-2'):
                task = await server.created(TOKEN_A, context_id=context)
                await server.wait_for(task['id'], 'completed')
            task = await server.created(TOKEN_A, context_id='ctx-1')  # ctx-2 is now the least recently used
            await server.wait_for(task['id'], 'completed')
            task = await server.created(TOKEN_A, context_id='ctx-3')
            await server.wait_for(task['id'], 'completed')
            storage = server.storage
            assert set(storage.context_owners) == {'ctx-1', 'ctx-3'}
            assert 'ctx-2' in storage.evicted_contexts and 'ctx-2' not in storage.contexts
    await model_client.aclose()


async def test_a_dropped_conversation_id_is_refused_to_others_and_reclaimable_by_its_owner():
    app, model, model_client = await start({'MAX_TASKS': '8'})
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            server = Server(client, app, model)
            for context in ('ctx-1', 'ctx-2', 'ctx-3'):
                task = await server.created(TOKEN_A, context_id=context)
                await server.wait_for(task['id'], 'completed')
            storage = server.storage
            assert 'ctx-1' not in storage.context_owners and 'ctx-1' in storage.evicted_contexts
            assert (await server.send(TOKEN_B, context_id='ctx-1'))['error']['code'] == NOT_FOUND
            assert 'ctx-1' not in storage.context_owners
            task = await server.created(TOKEN_A, context_id='ctx-1')
            await server.wait_for(task['id'], 'completed')
            assert storage.context_owners['ctx-1'] == storage.task_owners[task['id']]
            assert 'ctx-1' not in storage.evicted_contexts
            # Fresh history: only this run's messages.
            assert len(storage.contexts['ctx-1']) == 2
    await model_client.aclose()


async def test_the_tombstones_are_bounded():
    app, model, model_client = await start({'MAX_TASKS': '4'})
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            server = Server(client, app, model)
            for n in range(12):
                task = await server.created(TOKEN_A, context_id=f'ctx-{n}')
                await server.wait_for(task['id'], 'completed')
            assert len(server.storage.evicted_contexts) <= 4
            assert 'ctx-10' in server.storage.evicted_contexts or 'ctx-9' in server.storage.evicted_contexts
    await model_client.aclose()
