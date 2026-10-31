"""Usage and cost of a run, for the task's `metadata["agent-layers"]`, where a calling agent-layers stack reads them."""

from __future__ import annotations

from typing import Any

from pydantic_ai.usage import RunUsage

from .settings import ModelPrice

METADATA_KEY = 'agent-layers'
"""Key of the task metadata entry that carries the run figures, in the SDK language's names."""


def run_figures(usage: RunUsage, price: ModelPrice | None) -> dict[str, Any]:
    """`{"usage": {...}, "costUsd": n}` of a run; empty when a model request reported no usage.

    The cost is present only when the model alias has a price: an unpriced run reports no cost, not 0.
    """
    if usage.requests == 0 or usage.unmeasured_requests:
        return {}  # a partial count would look like the run's total
    out: dict[str, Any] = {'usage': {'inputTokens': usage.input_tokens, 'outputTokens': usage.output_tokens}}
    if price is not None:
        out['costUsd'] = (usage.input_tokens * price.input_per_mtok + usage.output_tokens * price.output_per_mtok) / 1e6
    return out
