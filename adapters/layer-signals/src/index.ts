import { defineAdapter, LAYERS, PORT_VERSIONS, type EvaluatorPort, type Layer } from '@agent-layers/core';
import { scoreLayers, type SignalItem } from './signals.ts';

export { scoreLayers, type SignalItem, type SignalRun } from './signals.ts';
export { createSignalRecorder, type SignalRecorder } from './recorder.ts';

export interface LayerSignalsOptions {
  /** Report only these layers (default all that have a signal). */
  layers?: Layer[];
}

/** Factory: scores the health of each layer (`<layer>_health`, 1 = healthy) from a run and its telemetry. */
export function createLayerSignals(options: LayerSignalsOptions = {}, name = 'layer-signals'): EvaluatorPort {
  const only = options.layers ? new Set<Layer>(options.layers) : undefined;
  return {
    name,
    async score(_c, run) {
      const reason = (run as { reason?: unknown }).reason;
      const scores = scoreLayers((run.events ?? []) as SignalItem[], { runId: run.runId, status: run.status, ...(typeof reason === 'string' ? { reason } : {}) });
      return only ? scores.filter((s) => s.layer && only.has(s.layer)) : scores;
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
    properties: { layers: { type: 'array', minItems: 1, items: { enum: LAYERS.map((l) => l.layer) } } },
    additionalProperties: false,
  },
  create: (options, ctx) => createLayerSignals(options, ctx.name),
});

export const adapters = [adapter];
