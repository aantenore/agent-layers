"""`agent-layers-pydantic-ai` (or `python -m agent_layers_pydantic_ai`): serve the agent over A2A with uvicorn."""

from __future__ import annotations

import logging
import sys

import uvicorn

from .agent import model_alias
from .app import create_app
from .settings import SettingsError, load_settings, warn_unsafe_limits
from .spec import load_agent_spec

log = logging.getLogger('agent_layers_pydantic_ai')


def main() -> int:
    try:
        settings = load_settings()
        spec = load_agent_spec(settings.agent_file, settings.agent_name)
        alias = model_alias(spec, settings)
    except (SettingsError, OSError) as err:
        print(f'agent-layers-pydantic-ai: {err}', file=sys.stderr)
        return 2
    logging.basicConfig(level=settings.log_level.upper(), format='%(levelname)s %(name)s: %(message)s')
    log.info(
        'agent %s on %s · model %s at %s/v1 · tools at %s/mcp',
        spec.name, settings.public_url, alias, settings.gateway_url, settings.gateway_url,
    )
    warn_unsafe_limits(settings)
    uvicorn.run(
        create_app(spec, settings),
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level,
        timeout_graceful_shutdown=None if settings.shutdown_grace_s is None else int(settings.shutdown_grace_s),
        server_header=False,
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
