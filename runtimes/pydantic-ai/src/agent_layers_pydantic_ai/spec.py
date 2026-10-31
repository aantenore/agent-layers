"""Agent files: the Markdown format of agent-layers, read the same way as `parseAgentFile` in the core.

Front matter is `key: value` and `key: [a, b]` lines between `---` fences; the body is the instructions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

_FRONT_MATTER = re.compile(r'^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$')
_KEY_VALUE = re.compile(r'^([A-Za-z_][\w-]*)\s*:\s*(.*)$')
_QUOTES = re.compile(r'^["\']|["\']$')


@dataclass(frozen=True)
class AgentSpec:
    name: str
    instructions: str
    model: str | None = None
    description: str | None = None
    tools: tuple[str, ...] = ()
    knowledge: tuple[str, ...] | None = None
    """Knowledge sources the agent may query; all of them when the file does not say."""
    extra: dict[str, str | list[str]] = field(default_factory=dict)

    def allows_tool(self, name: str) -> bool:
        """Whether a tool of the gateway's MCP endpoint belongs to this agent.

        `tools` are globs over the stack's `<source>__<tool>` names. Knowledge sources are served as
        `knowledge__<source>`; they are the agent's when listed in `knowledge`, or when it lists none.
        """
        if name.startswith('knowledge__'):
            source = name.removeprefix('knowledge__')
            return self.knowledge is None or source in self.knowledge or matches_any(self.tools, name)
        return matches_any(self.tools, name)


def parse_front_matter(text: str) -> tuple[dict[str, str | list[str]], str]:
    m = _FRONT_MATTER.match(text)
    if not m:
        return {}, text.strip()
    out: dict[str, str | list[str]] = {}
    for line in m.group(1).splitlines():
        kv = _KEY_VALUE.match(line.strip())
        if not kv:
            continue
        key, value = kv.group(1), kv.group(2)
        if value.startswith('[') and value.endswith(']'):
            out[key] = [s for s in (_QUOTES.sub('', p.strip()) for p in value[1:-1].split(',')) if s]
        else:
            out[key] = _QUOTES.sub('', value)
    return out, m.group(2).strip()


def _as_list(value: str | list[str] | None) -> tuple[str, ...] | None:
    if value is None:
        return None
    return tuple(value) if isinstance(value, list) else tuple(v for v in [value] if v)


def load_agent_spec(path: str | Path, name: str | None = None) -> AgentSpec:
    """Reads an agent file. The name is `name`, else the `name` key, else the file name without `.md`."""
    file = Path(path)
    meta, body = parse_front_matter(file.read_text(encoding='utf-8'))
    known = {'name', 'description', 'model', 'tools', 'knowledge'}
    model = meta.get('model')
    description = meta.get('description')
    return AgentSpec(
        name=name or str(meta.get('name') or '') or file.stem,
        instructions=body,
        model=model if isinstance(model, str) and model else None,
        description=description if isinstance(description, str) and description else None,
        tools=_as_list(meta.get('tools')) or (),
        knowledge=_as_list(meta.get('knowledge')),
        extra={k: v for k, v in meta.items() if k not in known},
    )


def glob_to_regex(glob: str) -> re.Pattern[str]:
    """`*` is any run of characters, `?` one character, anchored: the globs of the core."""
    body = ''.join('.*' if c == '*' else '.' if c == '?' else re.escape(c) for c in glob)
    return re.compile(f'^{body}$', re.DOTALL)


def matches_any(globs: tuple[str, ...] | list[str], name: str) -> bool:
    return any(glob_to_regex(g).match(name) for g in globs)
