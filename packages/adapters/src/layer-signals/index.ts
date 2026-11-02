import { defineAdapter, LAYERS, limitProperties, PORT_VERSIONS, type EvaluatorPort, type Layer } from '@agent-layers/core';
import { attributedScore, LIMITS, scoreLayers, type SignalItem, type SignalLimitOptions } from './signals.ts';

export {
  ATTRIBUTED_METRIC, attributedScore, attributeLayer, LIMITS, scoreLayers,
  type Attribution, type SignalItem, type SignalLimitOptions, type SignalRun,
} from './signals.ts';
export { createSignalRecorder, type SignalRecorder } from './recorder.ts';

export interface LayerSignalsOptions extends SignalLimitOptions {
  /** Report only these layers (default all that have a signal). */
  layers?: Layer[];
}

/**
 * Factory: scores the health of each layer (`<layer>_health`, 1 = healthy) from a run and its telemetry, then adds
 * `attributed`: the layer to fix (see `attributeLayer`).
 */
export function createLayerSignals(options: LayerSignalsOptions = {}, name = 'layer-signals'): EvaluatorPort {
  const only = options.layers ? new Set<Layer>(options.layers) : undefined;
  return {
    name,
    async score(_c, run) {
      const scores = scoreLayers((run.events ?? []) as SignalItem[], { runId: run.runId, status: run.status, ...(run.reason ? { reason: run.reason } : {}) }, options);
      const health = only ? scores.filter((s) => s.layer && only.has(s.layer)) : scores;
      return [...health, attributedScore(health)];
    },
  };
}

export const adapter = defineAdapter<'EvaluatorPort', LayerSignalsOptions>({
  layer: 'eval',
  port: 'EvaluatorPort',
  name: 'layer-signals',
  direction: 'outbound',
  maps: { technology: 'per-layer signals from run events and telemetry' },
  portVersion: PORT_VERSIONS.EvaluatorPort,
  tiers: ['prototype', 'production'],
  description: 'Scores each layer from the run result, its events and its telemetry, so a failing case points at the layer to fix.',
  optionsSchema: {
    type: 'object',
    properties: {
      layers: { type: 'array', minItems: 1, items: { enum: LAYERS.map((l) => l.layer) } },
      ...limitProperties(LIMITS, {
        reasonChars: 'Characters of a stop reason detail kept in the llm and harness score reasons',
        previewItems: 'Names listed in a score reason',
      }),
    },
    additionalProperties: false,
  },
  limits: LIMITS,
  create: (options, ctx) => createLayerSignals(options, ctx.name),
});

export const adapters = [adapter];
