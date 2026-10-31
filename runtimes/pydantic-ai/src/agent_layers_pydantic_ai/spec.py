"""Agent files: the Markdown format of agent-layers, read the same way as `parseAgentFile` in the core.

Front matter is `key: value` and `key: [a, b]` lines between `---` fences, and for `settings` and `ext` a one-line
flow mapping (`settings: { temperature: 0, maxOutputTokens: 512 }`); the body is the instructions. `params` was
removed in 1.0 and is an error.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

_FRONT_MATTER = re.compile(r'^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$')
_KEY_VALUE = re.compile(r'^([A-Za-z_][\w-]*)\s*:\s*(.*)$')
_QUOTES = re.compile(r'^["\']|["\']$')
_FLOW_ENTRY = re.compile(r'("[^"]+"|\'[^\']+\'|[A-Za-z_][\w.-]*)\s*:\s*(\[[^\]]*\]|"[^"]*"|\'[^\']*\'|[^,]+)')
_NUMBER = re.compile(r'^-?\d+(\.\d+)?$')
_FLOW_KEYS = frozenset({'settings', 'ext'})
PARAMS_REMOVED = (
    'params was removed in 1.0: put temperature, maxOutputTokens and stop under settings, '
    'and adapter-specific keys under ext (namespaced)'
)
SETTINGS_KEYS = frozenset({'temperature', 'maxOutputTokens', 'stop'})

Scalar = str | int | float | bool
FrontMatterValue = str | list[str] | dict[str, Scalar | list[str]]


class AgentFileError(ValueError):
    """An agent file the core loader would refuse."""


@dataclass(frozen=True)
class AgentSpec:
    name: str
    instructions: str
    model: str | None = None
    description: str | None = None
    tools: tuple[str, ...] = ()
    knowledge: tuple[str, ...] | None = None
    """Knowledge sources the agent may query; all of them when the file does not say."""
    settings: dict[str, Scalar | list[str]] = field(default_factory=dict)
    """Model settings in the language's names: `temperature`, `maxOutputTokens`, `stop`."""
    extra: dict[str, FrontMatterValue] = field(default_factory=dict)

    def allows_tool(self, name: str) -> bool:
        """Whether a tool of the gateway's MCP endpoint belongs to this agent.

        `tools` are globs over the stack's `<source>__<tool>` names. Knowledge sources are served as
        `knowledge__<source>`; they are the agent's when listed in `knowledge`, or when it lists none.
        """
        if name.startswith('knowledge__'):
            source = name.removeprefix('knowledge__')
            return self.knowledge is None or source in self.knowledge or matches_any(self.tools, name)
        return matches_any(self.tools, name)


def _list(value: str) -> list[str]:
    return [s for s in (_QUOTES.sub('', p.strip()) for p in value[1:-1].split(',')) if s]


def _scalar(value: str) -> Scalar:
    v = value.strip()
    if _NUMBER.match(v):
        return float(v) if '.' in v else int(v)
    if v in ('true', 'false'):
        return v == 'true'
    return _QUOTES.sub('', v)


def _flow_map(value: str, key: str) -> dict[str, Scalar | list[str]]:
    """`{ a: 1, b: [x, y], c: "z" }`: one level of a flow mapping with scalar and list values."""
    body = value.strip()[1:-1]
    out: dict[str, Scalar | list[str]] = {}
    for m in _FLOW_ENTRY.finditer(body):
        raw = m.group(2).strip()
        out[_QUOTES.sub('', m.group(1))] = _list(raw) if raw.startswith('[') else _scalar(raw)
    if not out and body.strip():
        raise AgentFileError(f'agent file: {key} must be a flow mapping such as {{ temperature: 0 }}')
    return out


def parse_front_matter(text: str) -> tuple[dict[str, FrontMatterValue], str]:
    m = _FRONT_MATTER.match(text)
    if not m:
        return {}, text.strip()
    out: dict[str, FrontMatterValue] = {}
    for line in m.group(1).splitlines():
        kv = _KEY_VALUE.match(line.strip())
        if not kv:
            continue
        key, value = kv.group(1), kv.group(2)
        if key == 'params':
            raise AgentFileError(f'agent file: {PARAMS_REMOVED}')
        if key in _FLOW_KEYS and value.strip().startswith('{'):
            out[key] = _flow_map(value, key)
        elif value.startswith('[') and value.endswith(']'):
            out[key] = _list(value)
        else:
            out[key] = _QUOTES.sub('', value)
    return out, m.group(2).strip()


def _settings(value: FrontMatterValue | None) -> dict[str, Scalar | list[str]]:
    """The `settings` mapping, checked like the core's agent settings schema."""
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise AgentFileError('agent file: settings must be a flow mapping such as { temperature: 0 }')
    unknown = sorted(set(value) - SETTINGS_KEYS)
    if unknown:
        raise AgentFileError(f'agent file: settings: unknown keys {", ".join(unknown)}')
    temperature = value.get('temperature')
    if temperature is not None and (isinstance(temperature, bool) or not isinstance(temperature, int | float) or temperature < 0):
        raise AgentFileError('agent file: settings.temperature must be a number >= 0')
    max_output = value.get('maxOutputTokens')
    if max_output is not None and (isinstance(max_output, bool) or not isinstance(max_output, int) or max_output < 1):
        raise AgentFileError('agent file: settings.maxOutputTokens must be an integer >= 1')
    stop = value.get('stop')
    if stop is not None and not isinstance(stop, list):
        raise AgentFileError('agent file: settings.stop must be a list of strings')
    return dict(value)


def _as_list(value: FrontMatterValue | None) -> tuple[str, ...] | None:
    if value is None or isinstance(value, dict):
        return None
    return tuple(value) if isinstance(value, list) else tuple(v for v in [value] if v)


def load_agent_spec(path: str | Path, name: str | None = None) -> AgentSpec:
    """Reads an agent file. The name is `name`, else the `name` key, else the file name without `.md`."""
    file = Path(path)
    meta, body = parse_front_matter(file.read_text(encoding='utf-8'))
    known = {'name', 'description', 'model', 'tools', 'knowledge', 'settings'}
    model = meta.get('model')
    description = meta.get('description')
    return AgentSpec(
        name=name or str(meta.get('name') or '') or file.stem,
        instructions=body,
        model=model if isinstance(model, str) and model else None,
        description=description if isinstance(description, str) and description else None,
        tools=_as_list(meta.get('tools')) or (),
        knowledge=_as_list(meta.get('knowledge')),
        settings=_settings(meta.get('settings')),
        extra={k: v for k, v in meta.items() if k not in known},
    )


def glob_to_regex(glob: str) -> re.Pattern[str]:
    """`*` is any run of characters, `?` one character, anchored: the globs of the core."""
    body = ''.join('.*' if c == '*' else '.' if c == '?' else re.escape(c) for c in glob)
    return re.compile(f'^{body}$', re.DOTALL)


def matches_any(globs: tuple[str, ...] | list[str], name: str) -> bool:
    return any(glob_to_regex(g).match(name) for g in globs)
