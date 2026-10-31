from pathlib import Path

import pytest

from agent_layers_pydantic_ai.settings import SettingsError, load_settings
from agent_layers_pydantic_ai.spec import load_agent_spec, matches_any, parse_front_matter

EXAMPLE_AGENT = Path(__file__).resolve().parents[3] / 'examples' / 'minimal' / 'agents' / 'assistant.md'


def test_reads_the_agent_file_of_the_minimal_example():
    spec = load_agent_spec(EXAMPLE_AGENT)
    assert spec.name == 'assistant'
    assert spec.model == 'default'
    assert spec.tools == ('util__*',)
    assert spec.knowledge == ('docs',)
    assert spec.instructions.startswith('# Role')
    assert '---' not in spec.instructions


def test_front_matter_like_the_core_parser():
    meta, body = parse_front_matter('---\nname: "a"\ntools: [x__*, \'y__z\', ]\nnot a pair\n---\nBody\n')
    assert meta == {'name': 'a', 'tools': ['x__*', 'y__z']}
    assert body == 'Body'
    assert parse_front_matter('  no front matter  ') == ({}, 'no front matter')


def test_globs_match_the_core_semantics():
    assert matches_any(['util__*'], 'util__convert_temperature')
    assert matches_any(['util__conv?rt*'], 'util__convert_temperature')
    assert not matches_any(['util__*'], 'admin__delete')
    assert not matches_any(['util.x'], 'utilax')


def test_tool_selection_follows_tools_and_knowledge(tmp_path):
    file = tmp_path / 'a.md'
    file.write_text('---\nmodel: m\ntools: [util__*]\n---\nhi')
    everything = load_agent_spec(file)
    assert everything.knowledge is None
    assert everything.allows_tool('util__x') and everything.allows_tool('knowledge__any')
    assert not everything.allows_tool('ops__restart')
    file.write_text('---\nmodel: m\ntools: []\nknowledge: [docs]\n---\nhi')
    scoped = load_agent_spec(file)
    assert scoped.allows_tool('knowledge__docs')
    assert not scoped.allows_tool('knowledge__hr') and not scoped.allows_tool('util__x')


def test_settings_refuse_an_agent_model_that_would_recurse():
    with pytest.raises(SettingsError, match='agent:<name>'):
        load_settings({'AGENT_FILE': 'a.md', 'GATEWAY_MODEL': 'agent:assistant'})
    with pytest.raises(SettingsError, match='AGENT_FILE'):
        load_settings({})


def test_settings_defaults():
    s = load_settings({'AGENT_FILE': 'a.md'})
    assert (s.host, s.port, s.public_url, s.gateway_url) == ('127.0.0.1', 9100, 'http://localhost:9100/', 'http://127.0.0.1:8787')
    assert s.loopback
