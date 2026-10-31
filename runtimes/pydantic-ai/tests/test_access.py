"""Who may reach the agent: loopback binding, and the optional secret the gateway sends."""

import logging

import httpx2
import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import ModelResponse, TextPart
from pydantic_ai.models.function import FunctionModel

from agent_layers_pydantic_ai.app import create_app
from agent_layers_pydantic_ai.settings import SettingsError, load_settings
from agent_layers_pydantic_ai.spec import AgentSpec

pytestmark = pytest.mark.anyio
ORIGIN = 'http://localhost:9100'
SECRET = 'gateway-secret-5e1b'
HEADER = 'X-Agent-Layers-Gateway'
BASE = {'AGENT_FILE': 'unused.md', 'GATEWAY_MODEL': 'mock'}


@pytest.fixture
def anyio_backend():
    return 'asyncio'


def test_a_non_loopback_bind_is_refused_unless_allowed():
    for host in ('0.0.0.0', '::', '10.0.0.5', 'agent.internal'):
        with pytest.raises(SettingsError, match='A2A_ALLOW_REMOTE=1'):
            load_settings({**BASE, 'A2A_HOST': host})
    assert load_settings({**BASE, 'A2A_HOST': '0.0.0.0', 'A2A_ALLOW_REMOTE': '1'}).host == '0.0.0.0'
    assert not load_settings({**BASE, 'A2A_HOST': '0.0.0.0', 'A2A_ALLOW_REMOTE': '1'}).loopback
    for host in ('127.0.0.1', 'localhost', '::1'):
        assert load_settings({**BASE, 'A2A_HOST': host}).host == host
    assert load_settings(BASE).host == '127.0.0.1'


def test_the_secret_is_optional_and_never_shown():
    assert load_settings(BASE).gateway_secret is None
    settings = load_settings({**BASE, 'A2A_GATEWAY_SECRET': f' {SECRET} '})
    assert settings.gateway_secret == SECRET
    assert SECRET not in repr(settings)


async def _answers(app, **headers):
    message = {'messageId': 'm', 'role': 'ROLE_USER', 'parts': [{'text': 'Hello'}]}
    body = {'jsonrpc': '2.0', 'id': 1, 'method': 'SendMessage', 'params': {'message': message}}
    async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=ORIGIN) as client:
        return (
            await client.post('/', json=body, headers=headers),
            await client.get('/.well-known/agent-card.json'),
            await client.get('/healthz'),
        )


async def test_with_a_secret_requests_without_it_are_refused_like_a_missing_bearer(caplog):
    caplog.set_level(logging.DEBUG)

    async def answer(_messages, _info):
        return ModelResponse(parts=[TextPart('done')])

    settings = load_settings({**BASE, 'A2A_GATEWAY_SECRET': SECRET})
    spec = AgentSpec(name='assistant', instructions='', model='mock', tools=(), knowledge=())
    client = httpx2.AsyncClient()
    app = create_app(spec, settings, agent=Agent(FunctionModel(answer)), http_client=client)
    bearer = {'authorization': 'Bearer caller-token'}
    async with app.router.lifespan_context(app):
        no_bearer, card, health = await _answers(app, **{HEADER: SECRET})
        assert no_bearer.status_code == 401 and card.status_code == 200 and health.status_code == 200
        for headers in (bearer, {**bearer, HEADER: 'wrong'}, {**bearer, HEADER: SECRET + 'x'}, {**bearer, HEADER: ''}):
            refused, card, health = await _answers(app, **headers)
            assert refused.status_code == 401
            assert refused.content == no_bearer.content and refused.headers['www-authenticate'] == no_bearer.headers['www-authenticate']
            assert card.status_code == 200 and health.status_code == 200  # public paths stay open
        accepted, *_ = await _answers(app, **bearer, **{HEADER: SECRET})
        assert accepted.status_code == 200 and 'result' in accepted.json()
    await client.aclose()
    assert SECRET not in caplog.text and SECRET not in refused.text


async def test_without_a_secret_the_header_is_not_needed():
    settings = load_settings(BASE)
    spec = AgentSpec(name='assistant', instructions='', model='mock', tools=(), knowledge=())
    client = httpx2.AsyncClient()
    app = create_app(spec, settings, agent=Agent(FunctionModel(lambda *_: ModelResponse(parts=[TextPart('done')]))), http_client=client)
    async with app.router.lifespan_context(app):
        accepted, *_ = await _answers(app, authorization='Bearer caller-token')
        assert accepted.status_code == 200
    await client.aclose()
