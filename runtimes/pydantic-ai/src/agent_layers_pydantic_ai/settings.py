"""Settings from the environment. Nothing here has a default that points outside this machine."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field

LOOPBACK_BIND = frozenset({'127.0.0.1', 'localhost', '::1'})
GATEWAY_SECRET_HEADER = 'x-agent-layers-gateway'


class SettingsError(ValueError):
    pass


@dataclass(frozen=True)
class Settings:
    agent_file: str
    gateway_url: str
    """Root of the agent-layers gateway: the model is `<gateway_url>/v1`, the tools `<gateway_url>/mcp`."""
    model: str | None
    """Model alias of the gateway's OpenAI-compatible API; the agent file's `model` when unset."""
    agent_name: str | None
    host: str
    port: int
    public_url: str
    """URL of the JSON-RPC endpoint written in the agent card."""
    max_concurrent_runs: int
    max_tasks: int
    """Tasks (and conversations) kept in memory; the oldest finished ones are dropped beyond it."""
    finished_task_ttl_s: float
    """How long a finished task is kept."""
    idle_context_ttl_s: float
    """How long a conversation without a task in flight is kept after its last use."""
    cross_owner_min_age_s: float
    """How old another caller's finished task or idle conversation must be to be reclaimed when the store is full."""
    shutdown_grace_s: float
    model_timeout_s: float
    log_level: str
    gateway_secret: str | None = field(default=None, repr=False)
    """When set, every request except the agent card and health check must carry it in `GATEWAY_SECRET_HEADER`."""

    @property
    def loopback(self) -> bool:
        return self.host in LOOPBACK_BIND


def _int(env: Mapping[str, str], name: str, default: int, low: int = 1) -> int:
    raw = env.get(name, '').strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        raise SettingsError(f'{name} must be an integer') from None
    if value < low:
        raise SettingsError(f'{name} must be at least {low}')
    return value


def _float(env: Mapping[str, str], name: str, default: float) -> float:
    raw = env.get(name, '').strip()
    try:
        value = float(raw) if raw else default
    except ValueError:
        raise SettingsError(f'{name} must be a number') from None
    if value <= 0:
        raise SettingsError(f'{name} must be positive')
    return value


def load_settings(env: Mapping[str, str] = os.environ) -> Settings:
    agent_file = env.get('AGENT_FILE', '').strip()
    if not agent_file:
        raise SettingsError('AGENT_FILE is required: the path of the agent Markdown file')
    gateway_url = env.get('GATEWAY_URL', 'http://127.0.0.1:8787').strip().rstrip('/')
    if not gateway_url.startswith(('http://', 'https://')):
        raise SettingsError('GATEWAY_URL must be an http or https URL')
    host = env.get('A2A_HOST', '127.0.0.1').strip()
    port = _int(env, 'A2A_PORT', 9100, low=0)
    shown = 'localhost' if host in LOOPBACK_BIND or host in ('0.0.0.0', '::') else host
    if host not in LOOPBACK_BIND and env.get('A2A_ALLOW_REMOTE', '').strip() != '1':
        raise SettingsError(
            f'A2A_HOST {host!r} is not a loopback address: this agent does not verify tokens and must be reachable '
            'only by the gateway; set A2A_ALLOW_REMOTE=1 to bind it anyway (and set A2A_GATEWAY_SECRET)'
        )
    model = env.get('GATEWAY_MODEL', '').strip() or None
    if model and model.startswith('agent:'):
        raise SettingsError('GATEWAY_MODEL must be a model alias, not agent:<name>: the gateway would run this agent again')
    return Settings(
        agent_file=agent_file,
        gateway_url=gateway_url,
        model=model,
        agent_name=env.get('AGENT_NAME', '').strip() or None,
        host=host,
        port=port,
        public_url=env.get('A2A_PUBLIC_URL', '').strip() or f'http://{shown}:{port}/',
        max_concurrent_runs=_int(env, 'MAX_CONCURRENT_RUNS', 8),
        max_tasks=_int(env, 'MAX_TASKS', 1000),
        finished_task_ttl_s=_float(env, 'FINISHED_TASK_TTL_S', 3600.0),
        idle_context_ttl_s=_float(env, 'IDLE_CONTEXT_TTL_S', 3600.0),
        cross_owner_min_age_s=_float(env, 'CROSS_OWNER_MIN_AGE_S', 600.0),
        shutdown_grace_s=_float(env, 'SHUTDOWN_GRACE_S', 10.0),
        model_timeout_s=_float(env, 'MODEL_TIMEOUT_S', 120.0),
        log_level=env.get('LOG_LEVEL', 'info').strip().lower() or 'info',
        gateway_secret=env.get('A2A_GATEWAY_SECRET', '').strip() or None,
    )
