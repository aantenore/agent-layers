"""Run figures: the pricing setting and the usage and cost written in a task's metadata."""

import json

import pytest
from pydantic_ai.usage import RunUsage

from agent_layers_pydantic_ai.figures import run_figures
from agent_layers_pydantic_ai.settings import ModelPrice, SettingsError, load_settings

BASE = {'AGENT_FILE': 'a.md'}


def test_pricing_is_read_per_model_alias():
    assert load_settings(BASE).pricing == {}
    table = {'fast': {'inputPerMTok': 0.5, 'outputPerMTok': 1.5}}
    assert load_settings({**BASE, 'MODEL_PRICING': json.dumps(table)}).pricing == {'fast': ModelPrice(0.5, 1.5)}


@pytest.mark.parametrize('raw', [
    'not json',
    '[]',
    '{"fast": 1}',
    '{"fast": {"inputPerMTok": 1}}',
    '{"fast": {"inputPerMTok": 1, "outputPerMTok": -1}}',
    '{"fast": {"inputPerMTok": 1, "outputPerMTok": true}}',
    '{"fast": {"inputPerMTok": 1, "outputPerMTok": 2, "extra": 0}}',
])
def test_malformed_pricing_is_refused(raw):
    with pytest.raises(SettingsError, match='MODEL_PRICING'):
        load_settings({**BASE, 'MODEL_PRICING': raw})


def test_figures_price_the_tokens_when_the_alias_has_a_price():
    usage = RunUsage(requests=2, input_tokens=1000, output_tokens=500)
    assert run_figures(usage, None) == {'usage': {'inputTokens': 1000, 'outputTokens': 500}}
    priced = run_figures(usage, ModelPrice(2, 10))
    assert priced['costUsd'] == pytest.approx((1000 * 2 + 500 * 10) / 1e6)


def test_no_figures_when_usage_is_missing_or_partial():
    assert run_figures(RunUsage(), ModelPrice(1, 1)) == {}
    assert run_figures(RunUsage(requests=2, input_tokens=10, unmeasured_requests=1), ModelPrice(1, 1)) == {}
