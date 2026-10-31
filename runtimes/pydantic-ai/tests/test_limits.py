"""A run is capped at MAX_MODEL_REQUESTS model requests."""

from __future__ import annotations

import pytest
from pydantic_ai import Agent
from pydantic_ai.exceptions import UsageLimitExceeded
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel

from agent_layers_pydantic_ai.agent import LimitedAgent
from agent_layers_pydantic_ai.settings import SettingsError, load_settings


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
    base = {'AGENT_FILE': 'a.md'}
    assert load_settings(base).max_model_requests == 8
    assert load_settings({**base, 'MAX_MODEL_REQUESTS': '3'}).max_model_requests == 3
    with pytest.raises(SettingsError):
        load_settings({**base, 'MAX_MODEL_REQUESTS': '0'})
