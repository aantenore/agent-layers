import { ATTR, METRIC, SPAN, sanitizeAttributes, type Attributes, type AttrValue } from '@agent-layers/core';

/**
 * The one place where the language's `agent.*` names meet the OpenTelemetry GenAI conventions. Everything below is
 * data; `mapSpan`, `mapAttributes`, `mapMetric` and `deriveMetric` only read it. Anything not listed passes unchanged.
 *
 * The original `agent.*` attributes are kept next to the `gen_ai.*` ones: queries on the language names keep working,
 * nothing is lost where the standard has no equivalent value (`other` finish reasons), and the cost is one more
 * attribute per mapped value.
 */

/** OTLP SpanKind. */
const INTERNAL = 1;
const CLIENT = 3;

const OPERATION = 'gen_ai.operation.name';
const REQUEST_MODEL = 'gen_ai.request.model';
const AGENT_NAME = 'gen_ai.agent.name';
const ERROR_TYPE = 'error.type';

export interface SpanRule {
  /** Value of `gen_ai.operation.name`, and the first word of the span name. */
  operation: string;
  kind: number;
  /** Language attribute whose value completes the span name: `<operation> <target>`. */
  target: string;
}

export const SPAN_RULES: Readonly<Record<string, SpanRule>> = {
  [SPAN.run]: { operation: 'invoke_agent', kind: INTERNAL, target: ATTR.name },
  [SPAN.modelCall]: { operation: 'chat', kind: CLIENT, target: ATTR.modelRequested },
  [SPAN.toolCall]: { operation: 'execute_tool', kind: INTERNAL, target: ATTR.toolName },
};

/** Language finish values to `gen_ai.response.finish_reasons`; `other` and unknown values pass through. */
export const FINISH_REASONS: Readonly<Record<string, string>> = {
  end: 'stop',
  limit: 'length',
  tools: 'tool_calls',
  refused: 'content_filter',
};

export interface AttributeRule {
  /** The standard attribute name. */
  to: string;
  value?: (v: AttrValue) => AttrValue;
}

export const ATTRIBUTE_RULES: Readonly<Record<string, AttributeRule>> = {
  [ATTR.name]: { to: AGENT_NAME },
  [ATTR.modelRequested]: { to: REQUEST_MODEL },
  [ATTR.modelUsed]: { to: 'gen_ai.response.model' },
  [ATTR.tokensInput]: { to: 'gen_ai.usage.input_tokens' },
  [ATTR.tokensOutput]: { to: 'gen_ai.usage.output_tokens' },
  [ATTR.tokensKind]: { to: 'gen_ai.token.type' },
  [ATTR.toolName]: { to: 'gen_ai.tool.name' },
  [ATTR.modelFinish]: { to: 'gen_ai.response.finish_reasons', value: (v) => [FINISH_REASONS[String(v)] ?? String(v)] },
};

export interface MetricRule {
  /** The standard metric name. */
  to: string;
  /** Attributes the standard requires that the language metric does not carry. */
  attributes: Attributes;
}

export const METRIC_RULES: Readonly<Record<string, MetricRule>> = {
  [METRIC.modelTokens]: { to: 'gen_ai.client.token.usage', attributes: { [OPERATION]: 'chat' } },
};

export interface DerivedMetric {
  name: string;
  /** Measurement from the span's duration in seconds. */
  value: (seconds: number) => number;
  /** Attributes of the finished span (after mapping) that become the metric's attributes. */
  keep: readonly string[];
  /** Values used when the span failed and did not set them. */
  onError?: Attributes;
}

/** Metrics the adapter derives from finished spans, by language span name. */
export const DERIVED_METRICS: Readonly<Record<string, DerivedMetric>> = {
  [SPAN.modelCall]: { name: 'gen_ai.client.operation.duration', value: (s) => s, keep: [ATTR.layer, OPERATION, REQUEST_MODEL, ERROR_TYPE] },
  [SPAN.run]: { name: 'agent.runs', value: () => 1, keep: [ATTR.layer, AGENT_NAME, ATTR.runStatus], onError: { [ATTR.runStatus]: 'failed' } },
};

/**
 * Attributes that carry what people typed, what the model answered, tool arguments and results, or free-text reasons
 * and errors. Exported only with `captureContent`.
 */
const CONTENT_KEY = /^gen_ai\.(input\.messages|output\.messages|system_instructions|tool\.definitions|tool\.call\.(arguments|result))$|(^|\.)(query|reason|message|content|prompt|text|error)$/;
/** Matched by `CONTENT_KEY` but a fixed vocabulary: the stop code of a run. */
const NOT_CONTENT = new Set<string>([ATTR.runReason]);

/** Drops undefined values, masks secret-looking keys, and drops content unless `captureContent` is set. */
export function scrub(attrs: Attributes, captureContent: boolean): Attributes {
  const safe = sanitizeAttributes(attrs);
  return captureContent ? safe : Object.fromEntries(Object.entries(safe).filter(([k]) => NOT_CONTENT.has(k) || !CONTENT_KEY.test(k)));
}

/** The attributes with the standard names added next to the language ones. */
export function mapAttributes(attrs: Attributes): Attributes {
  const out: Attributes = { ...attrs };
  for (const [key, rule] of Object.entries(ATTRIBUTE_RULES)) {
    const v = attrs[key];
    if (v !== undefined) out[rule.to] = rule.value ? rule.value(v) : v;
  }
  return out;
}

/** Name, kind and attributes of a span as exported. With `plainNames` the name stays the language's. */
export function mapSpan(name: string, attrs: Attributes, plainNames: boolean): { name: string; kind: number; attributes: Attributes } {
  const rule = SPAN_RULES[name];
  if (!rule) return { name, kind: INTERNAL, attributes: attrs };
  const target = attrs[rule.target];
  const exported = plainNames ? name : typeof target === 'string' && target ? `${rule.operation} ${target}` : rule.operation;
  return { name: exported, kind: rule.kind, attributes: { ...mapAttributes(attrs), [OPERATION]: rule.operation } };
}

/** Name and attributes of a metric as exported. */
export function mapMetric(name: string, attrs: Attributes): { name: string; attributes: Attributes } {
  const rule = METRIC_RULES[name];
  return rule ? { name: rule.to, attributes: { ...mapAttributes(attrs), ...rule.attributes } } : { name, attributes: attrs };
}

/** The metric derived from a finished span (`exported` = its mapped attributes), if its name has one. */
export function deriveMetric(spanName: string, exported: Attributes, seconds: number, failed: boolean): { name: string; value: number; attributes: Attributes } | undefined {
  const rule = DERIVED_METRICS[spanName];
  if (!rule) return undefined;
  const source: Attributes = { ...(failed ? rule.onError : {}), ...exported };
  return { name: rule.name, value: rule.value(seconds), attributes: Object.fromEntries(rule.keep.map((k) => [k, source[k]])) };
}
