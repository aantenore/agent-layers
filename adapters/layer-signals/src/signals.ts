import {
  ATTR, defineLimits, EVENT, LAYERS, limitValue, SPAN,
  type EvalScore, type Layer, type RunEvent, type RunStatus, type StopReason, type TelemetryRecord,
} from '@agent-layers/core';

/**
 * What the scoring reads. Two kinds of items can be mixed in `EvalRun.events`:
 *
 * - run events (`RunEvent`): `run.end { status, reason? }`, `model.reply { finish }`, `tool.result { tool, ok }`.
 *   Any other type is ignored.
 * - telemetry records (`TelemetryRecord`, as `recordingTelemetry` writes them), matched by core name: spans
 *   `agent.run` (`agent.run.reason`, the stop code), `agent.model.call` (`agent.model.finish`, span status),
 *   `agent.tool.call` (`agent.tool.outcome`, `agent.tool.name`, `agent.layer`), `agent.access.check`
 *   (`agent.access.decision`), `agent.guard.check` (`agent.guard.*`), `agent.knowledge.search`
 *   (`agent.knowledge.passages`, span status), `agent.cache.lookup` (`agent.cache.hit`), and the event
 *   `agent.knowledge.error`.
 *
 * The run result supplies `status` and the structured `reason`; nothing is read from reason text.
 */
export type SignalItem = RunEvent | TelemetryRecord;
export interface SignalRun { runId?: string; status: RunStatus; reason?: StopReason }

/** How much of a reason detail or a list the score reasons keep. */
export interface SignalLimitOptions {
  /** Characters of a stop reason `detail` kept in the reason of the llm and harness scores (default 160). */
  reasonChars?: number;
  /** Names listed in a score reason: guards, denied tools, failed tools (default 3). */
  previewItems?: number;
}

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  reasonChars: { path: 'options.reasonChars', default: 160, unit: 'chars', min: 1, max: 100_000, safe: { max: 1000 } },
  previewItems: { path: 'options.previewItems', default: 3, unit: 'count', min: 1, max: 1000, safe: { max: 20 } },
});

const SPAN_TYPES = new Set(['span', 'event', 'metric']);
/** Finish values that mean the answer was cut off or withheld. */
const BAD_FINISH = new Set<string>(['limit', 'refused']);
/** Score of a layer whose guards only redacted: the run went on with rewritten text. */
const REDACTED_VALUE = 0.5;
/** Tool outcomes that belong to another layer than the tool: a denied call is identity's, a blocked one the guard's. */
const OTHER_LAYER_OUTCOMES = new Set(['denied', 'blocked', 'pending']);

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const score = (layer: Layer, value: number, reason: string): EvalScore =>
  ({ metric: `${layer}_health`, value: Math.min(1, Math.max(0, value)), layer, reason });

type SpanRecord = Extract<TelemetryRecord, { type: 'span' }>;
type EventRecord = Extract<TelemetryRecord, { type: 'event' }>;
const hasAttrs = (e: SignalItem) => SPAN_TYPES.has(e.type) && typeof (e as { attrs?: unknown }).attrs === 'object';
const isSpan = (e: SignalItem): e is SpanRecord => e.type === 'span' && typeof (e as { name?: unknown }).name === 'string' && hasAttrs(e);
const isEvent = (e: SignalItem): e is EventRecord => e.type === 'event' && typeof (e as { name?: unknown }).name === 'string' && hasAttrs(e);

/** A stop reason as text for a score reason: the code, who stopped it and the (bounded) internal detail. */
const describe = (r: StopReason, max: number) =>
  `${r.code}${r.by ? ` by ${r.by}` : ''}${r.detail ? ` (${truncate(r.detail, max)})` : ''}`;

/** Per-layer health from what the SDK exposes after a run. A layer without any signal gets no score. */
export function scoreLayers(items: readonly SignalItem[], run: SignalRun, limits: SignalLimitOptions = {}): EvalScore[] {
  const reasonChars = limitValue(LIMITS.reasonChars, limits.reasonChars);
  const preview = limitValue(LIMITS.previewItems, limits.previewItems);
  const spans = items.filter(isSpan);
  const records = items.filter(isEvent);
  const events = items.filter((e) => !hasAttrs(e)) as RunEvent[];
  const named = (n: string) => spans.filter((s) => s.name === n);
  const of = <T extends RunEvent>(type: string) => events.filter((e) => e.type === type) as unknown as T[];

  const runSpanCode = str(named(SPAN.run).at(-1)?.attrs[ATTR.runReason]);
  const stop: StopReason | undefined = run.reason ?? of<Extract<RunEvent, { type: 'run.end' }>>('run.end').at(-1)?.reason ?? (runSpanCode ? { code: runSpanCode } : undefined);
  const halted = run.status === 'failed' || run.status === 'stopped';
  const guardrailStop = halted && stop?.code === 'guard_block';

  const chats = named(SPAN.modelCall);
  const replies = of<Extract<RunEvent, { type: 'model.reply' }>>('model.reply');
  const finishOf = (s: SpanRecord) => {
    const f = s.attrs[ATTR.modelFinish];
    return Array.isArray(f) ? (f as unknown[]).map(String) : f === undefined ? [] : [String(f)];
  };
  // The run ended because of the model: the stop reason names the llm layer, the last call errored or its answer was
  // cut off or withheld.
  const lastFinish = replies.at(-1)?.finish ?? (chats.length ? finishOf(chats.at(-1)!).at(-1) : undefined);
  const llmFailed = halted && !guardrailStop && (stop?.layer === 'llm' || chats.at(-1)?.status === 'error' || BAD_FINISH.has(String(lastFinish ?? '')));
  const scores = new Map<Layer, EvalScore>();

  // guardrail: guard checks; a run stopped by a guard counts as a block even without spans.
  const checks = named(SPAN.guardCheck);
  const action = (s: SpanRecord) => str(s.attrs[ATTR.guardAction]);
  if (checks.length || guardrailStop) {
    const blocks = Math.max(checks.filter((s) => action(s) === 'block').length, guardrailStop ? 1 : 0);
    const redactions = checks.filter((s) => action(s) === 'redact').length;
    const where = [...new Set(checks.filter((s) => action(s) !== 'allow').map((s) => `${str(s.attrs[ATTR.guardName]) ?? 'guard'}@${str(s.attrs[ATTR.guardStage]) ?? '?'}`))].slice(0, preview).join(', ');
    const parts = [blocks && `${blocks} blocked`, redactions && `${redactions} redacted`].filter(Boolean).join(', ');
    scores.set('guardrail', score('guardrail', blocks ? 0 : redactions ? REDACTED_VALUE : 1,
      `${parts || `${checks.length} checks passed`}${where ? ` (${where})` : ''}${guardrailStop ? `; run stopped by ${stop?.by ?? 'guard'}@${stop?.stage ?? '?'}` : ''}`));
  }

  // tool calls: spans by the layer they carry, else tool.result events.
  const calls = named(SPAN.toolCall);
  const outcome = (s: SpanRecord) => str(s.attrs[ATTR.toolOutcome]) ?? '';
  const pending = calls.filter((s) => outcome(s) === 'pending').length;

  // identity: authorization decisions. A call that waits for an approval is a denial that is being resolved, not a failure.
  const decisions = named(SPAN.accessCheck);
  if (decisions.length) {
    const denials = decisions.filter((s) => str(s.attrs[ATTR.accessDecision]) === 'deny');
    const denied = denials.slice(0, Math.max(0, denials.length - pending));
    const waiting = denials.length - denied.length;
    scores.set('identity', score('identity', 1 - denied.length / decisions.length,
      `${denied.length ? `${denied.length}/${decisions.length} denied: ${denied.slice(0, preview).map((s) => str(s.attrs[ATTR.toolName]) ?? 'tool').join(', ')}` : `${decisions.length} calls allowed`}${waiting ? `; ${waiting} awaiting approval` : ''}`));
  }

  // tool and knowledge: a denied call is identity's, a blocked one the guard's.
  const execs = calls.filter((s) => !OTHER_LAYER_OUTCOMES.has(outcome(s)));
  const failedExec = (s: SpanRecord) => s.status === 'error' || outcome(s) === 'error';
  const toolExecs = execs.filter((s) => s.layer !== 'knowledge');
  const knowledgeExecs = execs.filter((s) => s.layer === 'knowledge');
  const toolResults = of<Extract<RunEvent, { type: 'tool.result' }>>('tool.result');
  if (toolExecs.length || (!calls.length && toolResults.length)) {
    const total = toolExecs.length || toolResults.length;
    const bad = toolExecs.length
      ? toolExecs.filter(failedExec).map((s) => str(s.attrs[ATTR.toolName]))
      : toolResults.filter((e) => e.ok === false).map((e) => str(e.tool));
    const names = bad.slice(0, preview).map((n) => n ?? 'tool').join(', ');
    scores.set('tool', score('tool', 1 - bad.length / total, bad.length ? `${bad.length}/${total} calls failed: ${names}` : `${total} calls ok`));
  }

  // knowledge: searches that failed (a failed span, or the error event the injector writes), plus errors of
  // knowledge-layer tools. An empty result is reported but is not a failure: every model call searches with the
  // user's text, and a question the sources do not cover (a conversion, a greeting) rightly finds nothing. Whether the
  // answer needed a passage is for answer-level evaluators to say.
  const searches = named(SPAN.knowledgeSearch);
  const searchErrors = records.filter((e) => e.name === EVENT.knowledgeError).length;
  if (searches.length || knowledgeExecs.length || searchErrors) {
    const failed = Math.max(searches.filter((s) => s.status === 'error').length, searchErrors);
    const empty = searches.filter((s) => s.status !== 'error' && s.attrs[ATTR.knowledgePassages] === 0).length;
    const toolErrors = knowledgeExecs.filter(failedExec).length;
    const total = Math.max(searches.length, failed) + knowledgeExecs.length;
    const bad = failed + toolErrors;
    const parts = [failed && `${failed} searches failed`, toolErrors && `${toolErrors} knowledge tool errors`].filter(Boolean).join(', ');
    const note = empty ? `; ${empty} returned no passages` : '';
    scores.set('knowledge', score('knowledge', 1 - bad / total, `${bad ? `${parts} (of ${total})` : `${total} searches ok`}${note}`));
  }

  // llm: errored calls, truncated or withheld answers, or a run that ended because of the model.
  if (llmFailed) scores.set('llm', score('llm', 0, `run ${run.status}${stop ? `: ${describe(stop, reasonChars)}` : ''}`));
  else if (chats.length) {
    const bad = chats.filter((s) => s.status === 'error' || finishOf(s).some((f) => BAD_FINISH.has(f))).length;
    scores.set('llm', score('llm', 1 - bad / chats.length, bad ? `${bad}/${chats.length} model calls failed or were cut off` : `${chats.length} model calls ok`));
  } else if (replies.length) {
    const bad = replies.filter((e) => BAD_FINISH.has(String(e.finish))).length;
    scores.set('llm', score('llm', 1 - bad / replies.length, bad ? `${bad}/${replies.length} answers cut off or withheld` : `${replies.length} replies ok`));
  }

  // cache: a lookup that fails is a problem; a miss is not. The reason reports the hit rate.
  const lookups = named(SPAN.cacheLookup);
  if (lookups.length) {
    const failed = lookups.filter((s) => s.status === 'error').length;
    const hits = lookups.filter((s) => s.attrs[ATTR.cacheHit] === true).length;
    scores.set('cache', score('cache', 1 - failed / lookups.length, `${hits}/${lookups.length} lookups hit${failed ? `, ${failed} failed` : ''}`));
  }

  // harness: the run itself. A run waiting for a person is the runtime working as designed. Failures already blamed
  // on a guard or the model are not blamed twice.
  if (run.status === 'completed') scores.set('harness', score('harness', 1, 'completed'));
  else if (run.status === 'waiting') scores.set('harness', score('harness', 1, `waiting${stop ? `: ${stop.code}` : ''}`));
  else if (!llmFailed && !guardrailStop) scores.set('harness', score('harness', 0, `run ${run.status}${stop ? `: ${describe(stop, reasonChars)}` : ''}`));

  return [...scores.values()];
}

/** The layer a set of layer scores points at, with its value and reason. */
export interface Attribution { layer: Layer; value: number; reason: string }

const LAYER_ORDER = new Map<Layer, number>(LAYERS.map((l, i) => [l.layer, i]));

/**
 * The layer to fix: the worst-scored layer other than the harness among the scores below 1; the harness only when
 * nothing else is below 1; undefined when every layer is healthy. Scores without a layer are ignored. Ties go to the
 * layer that comes first in `LAYERS`.
 */
export function attributeLayer(scores: readonly EvalScore[]): Attribution | undefined {
  const bad = scores
    .filter((s): s is EvalScore & { layer: Layer } => s.layer !== undefined && s.value < 1)
    .sort((a, b) => a.value - b.value || (LAYER_ORDER.get(a.layer) ?? Infinity) - (LAYER_ORDER.get(b.layer) ?? Infinity));
  const blamed = bad.find((s) => s.layer !== 'harness') ?? bad[0];
  return blamed && { layer: blamed.layer, value: blamed.value, reason: blamed.reason ?? '' };
}

/** Metric name of the attribution score. */
export const ATTRIBUTED_METRIC = 'attributed';

/** The attribution as a score: the blamed layer with its value and `<layer>: <reason>`, or 1 and `none` without a layer. */
export function attributedScore(scores: readonly EvalScore[]): EvalScore {
  const blamed = attributeLayer(scores);
  return blamed
    ? { metric: ATTRIBUTED_METRIC, value: blamed.value, layer: blamed.layer, reason: blamed.reason ? `${blamed.layer}: ${blamed.reason}` : blamed.layer }
    : { metric: ATTRIBUTED_METRIC, value: 1, reason: 'none' };
}
