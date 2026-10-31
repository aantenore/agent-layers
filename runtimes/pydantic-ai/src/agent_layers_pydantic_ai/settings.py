"""Settings from the environment. Nothing here has a default that points outside this machine."""

from __future__ import annotations

import logging
import math
import os
from collections.abc import Mapping
from dataclasses import dataclass, field

log = logging.getLogger('agent_layers_pydantic_ai')

LOOPBACK_BIND = frozenset({'127.0.0.1', 'localhost', '::1'})
GATEWAY_SECRET_HEADER = 'x-agent-layers-gateway'
UNBOUNDED = 'unbounded'


class SettingsError(ValueError):
    pass


@dataclass(frozen=True)
class Limit:
    """One configurable limit: its default, what is accepted and what is safe on a production deployment.

    `unbounded` lets the env value `unbounded` mean no limit. `fallback` says, in words, what applies when the default
    is None. The table `LIMITS` is read by the docs check: keep one entry per line with literal values.
    """

    default: int | float | None
    low: int | float
    high: int | float | None = None
    unit: str = 'count'
    integer: bool = True
    unbounded: bool = False
    safe_low: int | float | None = None
    safe_high: int | float | None = None
    fallback: str | None = None

    def __post_init__(self) -> None:
        if self.default is None:
            return
        floor = self.low if self.safe_low is None else self.safe_low
        ceiling = self.high if self.safe_high is None else self.safe_high
        if self.default < floor or (ceiling is not None and self.default > ceiling):
            raise ValueError(f'default {self.default} is outside the accepted or safe range')

    def unsafe(self, value: int | float) -> bool:
        if self.safe_low is not None and value < self.safe_low:
            return True
        return self.safe_high is not None and value > self.safe_high


LIMITS: dict[str, Limit] = {
    'MAX_CONCURRENT_RUNS': Limit(default=8, low=1, unit='count', unbounded=True, safe_high=64),
    'MAX_TASKS': Limit(default=1000, low=4, unit='count', unbounded=True, safe_high=100000),
    'MAX_TASKS_PER_OWNER': Limit(default=None, low=1, unit='count', fallback='MAX_TASKS // 4'),
    'FINISHED_TASK_TTL_S': Limit(default=3600.0, low=1.0, unit='s', integer=False, unbounded=True, safe_high=86400.0),
    'IDLE_CONTEXT_TTL_S': Limit(default=3600.0, low=1.0, unit='s', integer=False, unbounded=True, safe_high=86400.0),
    'CROSS_OWNER_MIN_AGE_S': Limit(default=600.0, low=1.0, unit='s', integer=False, safe_high=86400.0),
    'SHUTDOWN_GRACE_S': Limit(default=10.0, low=1.0, unit='s', integer=False, unbounded=True, safe_high=300.0),
    'MODEL_TIMEOUT_S': Limit(default=120.0, low=1.0, unit='s', integer=False, unbounded=True, safe_high=600.0),
    'MAX_MODEL_REQUESTS': Limit(default=8, low=1, unit='count', unbounded=True, safe_high=50),
}


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
    max_concurrent_runs: int | None
    """Runs in parallel. For every limit with `unbounded` in `LIMITS`, None means no limit."""
    max_tasks: int | None
    """Tasks (and conversations) kept in memory; the oldest finished ones are dropped beyond it."""
    max_tasks_per_owner: int | None
    """Tasks (and conversations) of one owner; a quarter of `max_tasks` unless set, none when `max_tasks` is unbounded."""
    finished_task_ttl_s: float | None
    """How long a finished task is kept."""
    idle_context_ttl_s: float | None
    """How long a conversation without a task in flight is kept after its last use."""
    cross_owner_min_age_s: float
    """How old another caller's finished task or idle conversation must be to be reclaimed when the store is full."""
    shutdown_grace_s: float | None
    model_timeout_s: float | None
    max_model_requests: int | None
    """Model requests per run; a run that needs more fails instead of looping until the A2A time limit."""
    log_level: str
    gateway_secret: str | None = field(default=None, repr=False)
    """When set, every request except the agent card and health check must carry it in `GATEWAY_SECRET_HEADER`."""

    @property
    def loopback(self) -> bool:
        return self.host in LOOPBACK_BIND


def _int(env: Mapping[str, str], name: str, default: int, low: int = 1) -> int:
    """A setting that is not a limit (a port)."""
    raw = env.get(name, '').strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        raise SettingsError(f'{name} must be an integer') from None
    if value < low:
        raise SettingsError(f'{name} must be at least {low}')
    return value


def _limit(env: Mapping[str, str], name: str) -> int | float | None:
    """The value of a limit of `LIMITS`: its default when unset, None for `unbounded` where allowed."""
    spec = LIMITS[name]
    raw = env.get(name, '').strip()
    if not raw:
        return spec.default
    if raw.lower() == UNBOUNDED:
        if not spec.unbounded:
            raise SettingsError(f'{name} cannot be unbounded')
        return None
    try:
        value = int(raw) if spec.integer else float(raw)
    except ValueError:
        raise SettingsError(f'{name} must be {"an integer" if spec.integer else "a number"}') from None
    if not math.isfinite(value):
        raise SettingsError(f'{name} must be a finite number')
    if value < spec.low:
        raise SettingsError(f'{name} must be at least {spec.low}')
    if spec.high is not None and value > spec.high:
        raise SettingsError(f'{name} must be at most {spec.high}')
    return value


def unsafe_limits(settings: Settings) -> list[str]:
    """One message per limit that is unbounded or outside its safe range."""
    out = []
    for name, spec in LIMITS.items():
        value = getattr(settings, name.lower())
        if value is None:
            if spec.unbounded:
                out.append(f'{name} is unbounded: no limit applies')
        elif spec.unsafe(value):
            out.append(f'{name}={value} is outside its safe range')
    return out


def warn_unsafe_limits(settings: Settings) -> None:
    for message in unsafe_limits(settings):
        log.warning(message)


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
    max_tasks = _limit(env, 'MAX_TASKS')
    max_tasks_per_owner = _limit(env, 'MAX_TASKS_PER_OWNER')
    if max_tasks_per_owner is None and max_tasks is not None:
        max_tasks_per_owner = max_tasks // 4  # LIMITS['MAX_TASKS_PER_OWNER'].fallback
    return Settings(
        agent_file=agent_file,
        gateway_url=gateway_url,
        model=model,
        agent_name=env.get('AGENT_NAME', '').strip() or None,
        host=host,
        port=port,
        public_url=env.get('A2A_PUBLIC_URL', '').strip() or f'http://{shown}:{port}/',
        max_concurrent_runs=_limit(env, 'MAX_CONCURRENT_RUNS'),
        max_tasks=max_tasks,
        max_tasks_per_owner=max_tasks_per_owner,
        finished_task_ttl_s=_limit(env, 'FINISHED_TASK_TTL_S'),
        idle_context_ttl_s=_limit(env, 'IDLE_CONTEXT_TTL_S'),
        cross_owner_min_age_s=_limit(env, 'CROSS_OWNER_MIN_AGE_S'),
        shutdown_grace_s=_limit(env, 'SHUTDOWN_GRACE_S'),
        model_timeout_s=_limit(env, 'MODEL_TIMEOUT_S'),
        max_model_requests=_limit(env, 'MAX_MODEL_REQUESTS'),
        log_level=env.get('LOG_LEVEL', 'info').strip().lower() or 'info',
        gateway_secret=env.get('A2A_GATEWAY_SECRET', '').strip() or None,
    )
