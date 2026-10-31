"""The A2A server in process, with the gateway's model API replaced by a recording transport."""

import json
import logging
import time

import anyio
import httpx2
import pytest

from agent_layers_pydantic_ai.agent import build_agent
from agent_layers_pydantic_ai.app import create_app
from agent_layers_pydantic_ai.caller import CallerBearer
from agent_layers_pydantic_ai.settings import load_settings
from agent_layers_pydantic_ai.spec import AgentSpec

pytestmark = pytest.mark.anyio
TOKEN = 'caller-token-7f3a'
ORIGIN = 'http://localhost:9100'


@pytest.fixture
def anyio_backend():
    return 'asyncio'


class FakeGateway:
    """Answers `/v1/chat/completions` like the gateway's OpenAI-compatible API and records what it received."""

    def __init__(self) -> None:
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        body = json.loads(request.content)
        assert body['model'] == 'mock'
        text = 'answer from the gateway'
        if body.get('stream'):
            chunk = {'id': 'c1', 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': 'mock',
                     'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': text}, 'finish_reason': None}]}
            end = {**chunk, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]}
            sse = f'data: {json.dumps(chunk)}\n\ndata: {json.dumps(end)}\n\ndata: [DONE]\n\n'
            return httpx2.Response(200, content=sse.encode(), headers={'content-type': 'text/event-stream'})
        return httpx2.Response(200, json={
            'id': 'c1', 'object': 'chat.completion', 'created': int(time.time()), 'model': 'mock',
            'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': text}, 'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 3, 'completion_tokens': 4, 'total_tokens': 7},
        })


@pytest.fixture
async def server():
    settings = load_settings({'AGENT_FILE': 'unused.md', 'GATEWAY_URL': 'http://gateway.test', 'GATEWAY_MODEL': 'mock'})
    spec = AgentSpec(name='assistant', instructions='Be brief.', model='default', tools=(), knowledge=())
    gateway = FakeGateway()
    model_client = httpx2.AsyncClient(auth=CallerBearer(), transport=httpx2.MockTransport(gateway))
    app = create_app(spec, settings, agent=build_agent(spec, settings, model_client), http_client=model_client)
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            yield client, gateway
    await model_client.aclose()


def rpc(method: str, params: dict) -> dict:
    return {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}


async def run_to_end(client, send_method, get_method, message, headers):
    res = await client.post('/', json=rpc(send_method, {'message': message}), headers=headers)
    assert res.status_code == 200, res.text
    result = res.json()['result']
    task = result.get('task', result)
    for _ in range(100):
        state = task['status']['state']
        if state.lower().removeprefix('task_state_') in ('completed', 'failed', 'canceled', 'rejected'):
            return task
        await anyio.sleep(0.02)
        task = (await client.post('/', json=rpc(get_method, {'id': task['id']}), headers=headers)).json()['result']
    raise AssertionError('task did not end')


async def test_a2a_1_0_run_carries_the_caller_token_to_the_model(server, caplog):
    client, gateway = server
    caplog.set_level(logging.DEBUG)
    message = {'messageId': 'm1', 'role': 'ROLE_USER', 'parts': [{'text': 'Hello'}]}
    task = await run_to_end(client, 'SendMessage', 'GetTask', message, {'authorization': f'Bearer {TOKEN}', 'a2a-version': '1.0'})
    assert task['status']['state'] == 'TASK_STATE_COMPLETED'
    assert task['artifacts'][0]['parts'][0]['text'] == 'answer from the gateway'
    assert gateway.requests and all(r.headers['authorization'] == f'Bearer {TOKEN}' for r in gateway.requests)
    assert str(gateway.requests[0].url) == 'http://gateway.test/v1/chat/completions'
    assert TOKEN not in caplog.text
    assert TOKEN not in json.dumps(task)


TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'


async def test_the_callers_trace_context_reaches_the_model_calls(server):
    client, gateway = server
    message = {'messageId': 'm-trace', 'role': 'ROLE_USER', 'parts': [{'text': 'Hello'}]}
    headers = {'authorization': f'Bearer {TOKEN}', 'a2a-version': '1.0', 'traceparent': TRACEPARENT, 'tracestate': 'vendor=a'}
    await run_to_end(client, 'SendMessage', 'GetTask', message, headers)
    assert gateway.requests[-1].headers['traceparent'] == TRACEPARENT
    assert gateway.requests[-1].headers['tracestate'] == 'vendor=a'
    # A malformed context is not forwarded.
    count = len(gateway.requests)
    bad = {**headers, 'traceparent': '00-zz-00f067aa0ba902b7-01'}
    await run_to_end(client, 'SendMessage', 'GetTask', {**message, 'messageId': 'm-bad'}, bad)
    assert len(gateway.requests) > count and 'traceparent' not in gateway.requests[-1].headers


async def test_a2a_0_3_shapes_are_accepted(server):
    client, _ = server
    message = {'kind': 'message', 'messageId': 'm2', 'role': 'user', 'parts': [{'kind': 'text', 'text': 'Hello'}]}
    task = await run_to_end(client, 'message/send', 'tasks/get', message, {'authorization': f'Bearer {TOKEN}'})
    assert task['status']['state'] == 'completed'


async def test_requests_without_a_bearer_are_refused(server):
    client, gateway = server
    res = await client.post('/', json=rpc('SendMessage', {'message': {'messageId': 'm', 'role': 'ROLE_USER', 'parts': [{'text': 'x'}]}}))
    assert res.status_code == 401
    assert res.headers['www-authenticate'].startswith('Bearer')
    assert (await client.post('/', json={}, headers={'authorization': 'Basic abc'})).status_code == 401
    assert not gateway.requests


async def test_card_and_health_are_public(server):
    client, _ = server
    card = (await client.get('/.well-known/agent-card.json')).json()
    assert card['supportedInterfaces'] == [{'protocolBinding': 'JSONRPC', 'url': f'{ORIGIN}/', 'protocolVersion': '1.0'}]
    assert card['securitySchemes'] == {'bearer': {'httpAuthSecurityScheme': {'scheme': 'Bearer'}}}
    assert (await client.get('/healthz')).json() == {'status': 'ok'}


async def test_cross_origin_and_foreign_hosts_are_refused(server):
    client, _ = server
    headers = {'authorization': f'Bearer {TOKEN}'}
    assert (await client.post('/', json={}, headers={**headers, 'origin': 'https://evil.example'})).status_code == 403
    assert (await client.get('/healthz', headers={'host': 'evil.example'})).status_code == 403


async def test_model_calls_are_never_sent_without_a_caller():
    seen: list[httpx2.Request] = []
    client = httpx2.AsyncClient(auth=CallerBearer(), transport=httpx2.MockTransport(lambda r: seen.append(r) or httpx2.Response(200)))
    with pytest.raises(RuntimeError, match='no caller credential'):
        await client.get('http://gateway.test/v1/models')
    assert not seen
    await client.aclose()


async def test_shutdown_lets_a_run_in_flight_finish():
    from pydantic_ai import Agent
    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.models.function import FunctionModel

    async def slow(_messages, _info):
        await anyio.sleep(0.3)
        return ModelResponse(parts=[TextPart('done')])

    settings = load_settings({'AGENT_FILE': 'unused.md', 'GATEWAY_MODEL': 'mock', 'SHUTDOWN_GRACE_S': '5'})
    spec = AgentSpec(name='assistant', instructions='', model='mock', tools=(), knowledge=())
    model_client = httpx2.AsyncClient()
    app = create_app(spec, settings, agent=Agent(FunctionModel(slow)), http_client=model_client)
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
            message = {'messageId': 'm3', 'role': 'ROLE_USER', 'parts': [{'text': 'Hello'}]}
            res = await client.post('/', json=rpc('SendMessage', {'message': message}), headers={'authorization': f'Bearer {TOKEN}'})
            task_id = res.json()['result']['task']['id'] if 'task' in res.json()['result'] else res.json()['result']['id']
            await anyio.sleep(0.05)
    task = await app.task_manager.storage.store.load_task(task_id)
    assert task['status']['state'] == 'completed'
    await model_client.aclose()
