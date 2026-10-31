"""Limits: declared in one table, read from the environment, validated, and warned about when unsafe."""

from __future__ import annotations

import logging
import math

import anyio
import httpx2
import pytest
from pydantic_ai import Agent
from pydantic_ai.exceptions import UsageLimitExceeded
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel

from agent_layers_pydantic_ai.agent import LimitedAgent
from agent_layers_pydantic_ai.app import create_app
from agent_layers_pydantic_ai.owners import TaskStore, TooManyTasks
from agent_layers_pydantic_ai.settings import LIMITS, Limit, SettingsError, load_settings, unsafe_limits, warn_unsafe_limits
from agent_layers_pydantic_ai.spec import AgentSpec

BASE = {'AGENT_FILE': 'a.md'}
FIELD = {name: name.lower() for name in LIMITS}


@pytest.fixture
def anyio_backend():
    return 'asyncio'


def looping_agent() -> Agent[None, str]:
    """A model that calls its tool again after every result, as small models sometimes do."""

    def always_call(_messages, _info) -> ModelResponse:
        return ModelResponse(parts=[ToolCallPart(tool_name='convert', args={'celsius': 100})])

    agent: Agent[None, str] = Agent(FunctionModel(always_call))

    @agent.tool_plain
    def convert(celsius: float) -> str:
        return f'{celsius} C is {celsius * 9 / 5 + 32} F'

    return agent


@pytest.mark.anyio
async def test_a_looping_model_stops_at_the_request_limit():
    limited = LimitedAgent(looping_agent(), max_model_requests=3)
    with pytest.raises(UsageLimitExceeded):
        await limited.run('Convert 100 C')
    with pytest.raises(UsageLimitExceeded):
        async with limited.iter('Convert 100 C') as run:
            async for _ in run:
                pass


def test_max_model_requests_setting():
    base = BASE
    assert load_settings(base).max_model_requests == 8
    assert load_settings({**base, 'MAX_MODEL_REQUESTS': '3'}).max_model_requests == 3
    with pytest.raises(SettingsError):
        load_settings({**base, 'MAX_MODEL_REQUESTS': '0'})


def test_defaults_come_from_the_table_and_sit_inside_their_safe_range():
    settings = load_settings(BASE)
    for name, spec in LIMITS.items():
        value = getattr(settings, FIELD[name])
        if spec.default is None:
            assert spec.fallback
            continue
        assert value == spec.default and not spec.unsafe(value)
    assert settings.max_tasks_per_owner == settings.max_tasks // 4
    assert unsafe_limits(settings) == []


def test_a_default_outside_the_safe_range_is_refused():
    with pytest.raises(ValueError):
        Limit(default=100, low=1, safe_high=10)


@pytest.mark.parametrize('name', list(LIMITS))
def test_every_limit_takes_a_value_from_the_environment(name):
    spec = LIMITS[name]
    value = (spec.low + 1) if spec.integer else spec.low + 0.5
    settings = load_settings({**BASE, name: str(value)})
    assert getattr(settings, FIELD[name]) == value


@pytest.mark.parametrize('name', list(LIMITS))
def test_a_limit_below_its_minimum_or_not_a_number_is_refused(name):
    spec = LIMITS[name]
    for bad in (str(spec.low - 1), '0', '-1', 'abc', 'nan', 'inf', '-inf'):
        with pytest.raises(SettingsError, match=name):
            load_settings({**BASE, name: bad})
    if spec.integer:
        with pytest.raises(SettingsError, match=name):
            load_settings({**BASE, name: '2.5'})


@pytest.mark.parametrize('name', list(LIMITS))
def test_unbounded_is_accepted_only_where_the_table_allows_it(name):
    env = {**BASE, name: 'unbounded'}
    if LIMITS[name].unbounded:
        assert getattr(load_settings(env), FIELD[name]) is None
    else:
        with pytest.raises(SettingsError, match=name):
            load_settings(env)


def test_the_share_per_owner_follows_max_tasks_unless_set():
    assert load_settings({**BASE, 'MAX_TASKS': '40'}).max_tasks_per_owner == 10
    assert load_settings({**BASE, 'MAX_TASKS': '4'}).max_tasks_per_owner == 1
    assert load_settings({**BASE, 'MAX_TASKS': '40', 'MAX_TASKS_PER_OWNER': '3'}).max_tasks_per_owner == 3
    assert load_settings({**BASE, 'MAX_TASKS': 'unbounded'}).max_tasks_per_owner is None
    assert load_settings({**BASE, 'MAX_TASKS': 'unbounded', 'MAX_TASKS_PER_OWNER': '5'}).max_tasks_per_owner == 5
    with pytest.raises(SettingsError, match='MAX_TASKS'):
        load_settings({**BASE, 'MAX_TASKS': '3'})


def test_unbounded_and_out_of_range_limits_are_warned_about(caplog):
    settings = load_settings(
        {**BASE, 'MODEL_TIMEOUT_S': 'unbounded', 'MAX_TASKS': '200000', 'FINISHED_TASK_TTL_S': 'unbounded'}
    )
    with caplog.at_level(logging.WARNING, logger='agent_layers_pydantic_ai'):
        warn_unsafe_limits(settings)
    messages = [r.getMessage() for r in caplog.records]
    assert len(messages) == 3 and all(r.levelno == logging.WARNING for r in caplog.records)
    assert any(m.startswith('MODEL_TIMEOUT_S is unbounded') for m in messages)
    assert any(m.startswith('FINISHED_TASK_TTL_S is unbounded') for m in messages)
    assert any(m.startswith('MAX_TASKS=200000 ') for m in messages)


def test_no_warning_for_the_defaults(caplog):
    with caplog.at_level(logging.WARNING, logger='agent_layers_pydantic_ai'):
        warn_unsafe_limits(load_settings(BASE))
    assert caplog.records == []


def message() -> dict:
    return {'role': 'user', 'parts': [], 'kind': 'message', 'message_id': 'm'}


def test_an_unbounded_store_takes_any_number_of_tasks():
    store = TaskStore(None, None, None, None, 600.0)
    assert store.max_tasks == store.per_owner == store.finished_ttl_s == store.idle_ttl_s == math.inf
    for n in range(50):
        store.submit(f'owner-{n % 3}', f'ctx-{n}', message())
    assert len(store._task_owner) == 50


def test_the_share_per_owner_caps_one_owner_only():
    store = TaskStore(None, 2, 3600.0, 3600.0, 600.0)
    store.submit('a', 'c1', message())
    store.submit('a', 'c2', message())
    with pytest.raises(TooManyTasks):
        store.submit('a', 'c3', message())
    store.submit('b', 'c1', message())


@pytest.mark.anyio
async def test_runs_are_not_capped_when_concurrency_is_unbounded():
    from pydantic_ai.messages import TextPart

    async def answer(_messages, _info):
        await anyio.sleep(0.05)
        return ModelResponse(parts=[TextPart('done')])

    settings = load_settings({**BASE, 'GATEWAY_MODEL': 'mock', 'MAX_CONCURRENT_RUNS': 'unbounded', 'SHUTDOWN_GRACE_S': 'unbounded'})
    spec = AgentSpec(name='assistant', instructions='', model='mock', tools=(), knowledge=())
    client = httpx2.AsyncClient()
    app = create_app(spec, settings, agent=Agent(FunctionModel(answer)), http_client=client)
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url='http://localhost:9100') as http:
            body = {
                'jsonrpc': '2.0', 'id': 1, 'method': 'SendMessage',
                'params': {'message': {'messageId': 'm1', 'role': 'ROLE_USER', 'parts': [{'text': 'Hi'}]}},
            }
            res = await http.post('/', json=body, headers={'authorization': 'Bearer t'})
            assert res.status_code == 200 and 'error' not in res.json()
            await anyio.sleep(0.3)
    await client.aclose()
