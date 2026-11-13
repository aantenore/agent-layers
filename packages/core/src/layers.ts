/** Stable layer ids. Numbers and order are presentation only (see LAYERS). */
export type Layer =
  | 'infra' | 'llm' | 'cache' | 'harness' | 'knowledge' | 'tool'
  | 'identity' | 'guardrail' | 'interface' | 'telemetry' | 'eval';

export type Plane = 'foundation' | 'model' | 'agent' | 'control' | 'experience' | 'insight';

export interface LayerInfo {
  layer: Layer;
  /** Display number, for human-facing tables only. Never use it in identifiers. */
  number: number;
  name: string;
  plane: Plane;
  /** The one question the layer answers. */
  question: string;
  /**
   * The slots of the layer: the keys users write under `layers` in the stack config. Each slot fills one port
   * (packages/core/src/slots.ts); a test keeps this list and the slot table in step.
   */
  slots: readonly string[];
}

export const PLANES: readonly { plane: Plane; name: string }[] = Object.freeze([
  { plane: 'foundation', name: 'Foundation' },
  { plane: 'model', name: 'Model plane' },
  { plane: 'agent', name: 'Agent plane' },
  { plane: 'control', name: 'Control plane' },
  { plane: 'experience', name: 'Experience plane' },
  { plane: 'insight', name: 'Insight plane' },
]);

/**
 * The eleven layers in display order, each made of one or more slots (22 in total). This list is the source of truth
 * for the vocabulary: layer id → title → slots; a slot's port is in SLOTS. docs/stack.md prints the same table and
 * `npm run docs:check` compares the two.
 */
export const LAYERS: readonly LayerInfo[] = Object.freeze([
  { layer: 'infra', number: 0, plane: 'foundation', name: 'Infrastructure & delivery', question: 'Where does it run and how does it get there?', slots: ['deploy', 'secrets'] },
  { layer: 'llm', number: 1, plane: 'model', name: 'Models', question: 'Who thinks?', slots: ['model'] },
  { layer: 'cache', number: 2, plane: 'model', name: 'Model routing & cache (fallback, quotas)', question: 'Which model, at what cost and latency?', slots: ['router', 'cache'] },
  { layer: 'harness', number: 3, plane: 'agent', name: 'Agent runtime', question: 'How does the agent loop run and keep state?', slots: ['runtime', 'state', 'store'] },
  { layer: 'knowledge', number: 4, plane: 'agent', name: 'Knowledge & memory', question: 'What does it know?', slots: ['knowledge', 'memory', 'ingestion'] },
  { layer: 'tool', number: 5, plane: 'agent', name: 'Tools', question: 'What can it do?', slots: ['tools'] },
  { layer: 'identity', number: 6, plane: 'control', name: 'Identity & access', question: 'Who is it, on whose behalf, and what is allowed?', slots: ['identity', 'credentials', 'authorization', 'approval'] },
  { layer: 'guardrail', number: 7, plane: 'control', name: 'Guardrails', question: 'Is this content acceptable?', slots: ['guardrails'] },
  { layer: 'interface', number: 8, plane: 'experience', name: 'Interfaces, channels & triggers', question: 'Who talks to it and what starts it?', slots: ['channels', 'triggers'] },
  { layer: 'telemetry', number: 9, plane: 'insight', name: 'Telemetry & observability', question: 'What happened?', slots: ['telemetry'] },
  { layer: 'eval', number: 10, plane: 'insight', name: 'Evaluation & improvement', question: 'Was it good, and if not, which layer failed?', slots: ['eval', 'feedback'] },
]);

const BY_LAYER = new Map(LAYERS.map((l) => [l.layer, l]));

export function isLayer(value: unknown): value is Layer {
  return typeof value === 'string' && BY_LAYER.has(value as Layer);
}

export function layerInfo(layer: Layer): LayerInfo {
  const info = BY_LAYER.get(layer);
  if (!info) throw new TypeError(`unknown layer "${layer}"`);
  return info;
}

/** Display label such as `L4 knowledge`. */
export const layerLabel = (layer: Layer) => `L${layerInfo(layer).number} ${layer}`;
