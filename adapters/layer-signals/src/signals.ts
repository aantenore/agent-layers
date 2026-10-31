import { defineLimits, limitValue, type EvalScore, type Layer, type RunEvent, type TelemetryRecord } from '@agent-layers/core';

/**
 * What the scoring reads. Two kinds of items can be mixed in `EvalRun.events`:
 *
 * - runtime events (`RunEvent`, flat fields): `run_end { status, reason? }`, `model_response { finish_reason? }`,
 *   `tool_result { name?, isError? }`. Any other type is ignored.
 * - telemetry records (`TelemetryRecord`, as `recordingTelemetry` writes them), of type `span`, matched by name:
 *   `invoke_agent` (`run.status`), `chat` (`gen_ai.response.finish_reasons`, span status), `execute_tool`
 *   (`tool.outcome`, `agent.layer`), `authorize` (`policy.decision`), `guard.check` (`guard.action`, `guard.name`,
 *   `guard.stage`), `knowledge.search` (`knowledge.passages`, span status), `cache.lookup` (`cache.hit`).
 *
 * The run result supplies `status` and `reason` (`EvalRun` does not type `reason`; `RunResult` has it).
 */
export type SignalItem = RunEvent | TelemetryRecord;
export interface SignalRun { runId?: string; status: string; reason?: string }

/** How much of a reason or a list the score reasons keep. */
export interface SignalLimitOptions {
  /** Characters of a run reason kept in the reason of the llm and harness scores (default 160). */
  reasonChars?: number;
  /** Characters of a run reason kept in the reason of the guardrail score (default 80). */
  guardReasonChars?: number;
  /** Names listed in a score reason: guards, denied tools, failed tools (default 3). */
  previewItems?: number;
}

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  reasonChars: { path: 'options.reasonChars', default: 160, unit: 'chars', min: 1, max: 100_000, safe: { max: 1000 } },
  guardReasonChars: { path: 'options.guardReasonChars', default: 80, unit: 'chars', min: 1, max: 100_000, safe: { max: 1000 } },
  previewItems: { path: 'options.previewItems', default: 3, unit: 'count', min: 1, max: 1000, safe: { max: 20 } },
});

const SPAN_TYPES = new Set(['span', 'event', 'metric']);
/** Run failures that come from the model side: provider errors, network, truncated or unusable answers. */
const LLM_FAILURE = /\bHTTP [45]\d{2}\b|network|fetch failed|timeout|timed out|rate.?limit|ECONN|ENOTFOUND|max_tokens|refusal|content_filter|invalid structured output|empty response/i;
/** Run reasons set when a guard stops the run: `guardrail:<guard>:<stage>`. */
const GUARDRAIL_REASON = /^guardrail[:\s]/i;
/** Finish reasons that mean the answer was cut off or withheld. */
const BAD_FINISH = new Set(['length', 'max_tokens', 'content_filter', 'refusal']);
/** Score of a layer whose guards only redacted: the run went on with rewritten text. */
const REDACTED_VALUE = 0.5;

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const score = (layer: Layer, value: number, reason: string): EvalScore =>
  ({ metric: `${layer}_health`, value: Math.min(1, Math.max(0, value)), layer, reason });

type SpanRecord = Extract<TelemetryRecord, { type: 'span' }>;
const isSpan = (e: SignalItem): e is SpanRecord => e.type === 'span' && typeof (e as { name?: unknown }).name === 'string' && typeof (e as { attrs?: unknown }).attrs === 'object';
const isTelemetry = (e: SignalItem) => SPAN_TYPES.has(e.type) && typeof (e as { attrs?: unknown }).attrs === 'object';

/** Per-layer health from what the SDK exposes after a run. A layer without any signal gets no score. */
export function scoreLayers(items: readonly SignalItem[], run: SignalRun, limits: SignalLimitOptions = {}): EvalScore[] {
  const reasonChars = limitValue(LIMITS.reasonChars, limits.reasonChars);
  const guardReasonChars = limitValue(LIMITS.guardReasonChars, limits.guardReasonChars);
  const preview = limitValue(LIMITS.previewItems, limits.previewItems);
  const spans = items.filter(isSpan);
  const events = items.filter((e) => !isTelemetry(e)) as RunEvent[];
  const named = (n: string) => spans.filter((s) => s.name === n);
  const of = (type: string) => events.filter((e) => e.type === type);
  const end = [...events].reverse().find((e) => e.type === 'run_end');
  const reason = run.reason ?? str(end?.reason) ?? str(named('invoke_agent').at(-1)?.attrs['run.reason']) ?? '';
  const guardrailStop = GUARDRAIL_REASON.test(reason);
  const llmFailed = run.status !== 'completed' && !guardrailStop && LLM_FAILURE.test(reason);
  const scores = new Map<Layer, EvalScore>();

  // guardrail: guard.check spans; a run stopped by a guard counts as a block even without spans.
  const checks = named('guard.check');
  const action = (s: SpanRecord) => str(s.attrs['guard.action']);
  if (checks.length || guardrailStop) {
    const blocks = Math.max(checks.filter((s) => action(s) === 'block').length, guardrailStop ? 1 : 0);
    const redactions = checks.filter((s) => action(s) === 'redact').length;
    const where = [...new Set(checks.filter((s) => action(s) !== 'allow').map((s) => `${str(s.attrs['guard.name']) ?? 'guard'}@${str(s.attrs['guard.stage']) ?? '?'}`))].slice(0, preview).join(', ');
    const parts = [blocks && `${blocks} blocked`, redactions && `${redactions} redacted`].filter(Boolean).join(', ');
    scores.set('guardrail', score('guardrail', blocks ? 0 : redactions ? REDACTED_VALUE : 1,
      `${parts || `${checks.length} checks passed`}${where ? ` (${where})` : ''}${guardrailStop ? `; run ${truncate(reason, guardReasonChars)}` : ''}`));
  }

  // identity: authorization decisions.
  const decisions = named('authorize');
  if (decisions.length) {
    const denied = decisions.filter((s) => str(s.attrs['policy.decision']) === 'deny');
    scores.set('identity', score('identity', 1 - denied.length / decisions.length,
      denied.length ? `${denied.length}/${decisions.length} denied: ${denied.slice(0, preview).map((s) => str(s.attrs['gen_ai.tool.name']) ?? 'tool').join(', ')}` : `${decisions.length} calls allowed`));
  }

  // tool and knowledge: execute_tool spans by the layer they carry. A denied call is identity's, a blocked one the guard's.
  const execs = named('execute_tool').filter((s) => !['denied', 'blocked'].includes(str(s.attrs['tool.outcome']) ?? ''));
  const failedExec = (s: SpanRecord) => s.status === 'error' || str(s.attrs['tool.outcome']) === 'error';
  const toolExecs = execs.filter((s) => s.layer !== 'knowledge');
  const knowledgeExecs = execs.filter((s) => s.layer === 'knowledge');
  const toolResults = of('tool_result');
  if (toolExecs.length || (!named('execute_tool').length && toolResults.length)) {
    const total = toolExecs.length || toolResults.length;
    const bad = toolExecs.length
      ? toolExecs.filter(failedExec).map((s) => str(s.attrs['gen_ai.tool.name']))
      : toolResults.filter((e) => e.isError === true).map((e) => str(e.name));
    const names = bad.slice(0, preview).map((n) => n ?? 'tool').join(', ');
    scores.set('tool', score('tool', 1 - bad.length / total, bad.length ? `${bad.length}/${total} calls failed: ${names}` : `${total} calls ok`));
  }

  // knowledge: searches that failed, plus errors of knowledge-layer tools. An empty result is reported but is not a
  // failure: every model call searches with the user's text, and a question the sources do not cover (a conversion, a
  // greeting) rightly finds nothing. Whether the answer needed a passage is for answer-level evaluators to say.
  const searches = named('knowledge.search');
  if (searches.length || knowledgeExecs.length) {
    const failed = searches.filter((s) => s.status === 'error').length;
    const empty = searches.filter((s) => s.status !== 'error' && s.attrs['knowledge.passages'] === 0).length;
    const toolErrors = knowledgeExecs.filter(failedExec).length;
    const total = searches.length + knowledgeExecs.length;
    const bad = failed + toolErrors;
    const parts = [failed && `${failed} searches failed`, toolErrors && `${toolErrors} knowledge tool errors`].filter(Boolean).join(', ');
    const note = empty ? `; ${empty} returned no passages` : '';
    scores.set('knowledge', score('knowledge', 1 - bad / total, `${bad ? `${parts} (of ${total})` : `${total} searches ok`}${note}`));
  }

  // llm: errored calls, truncated or withheld answers, or a run that failed for a model-side reason.
  const chats = named('chat');
  const responses = of('model_response');
  const finishOf = (s: SpanRecord) => {
    const f = s.attrs['gen_ai.response.finish_reasons'];
    return Array.isArray(f) ? (f as unknown[]).map(String) : f === undefined ? [] : [String(f)];
  };
  if (llmFailed) scores.set('llm', score('llm', 0, `run ${run.status}: ${truncate(reason, reasonChars)}`));
  else if (chats.length) {
    const bad = chats.filter((s) => s.status === 'error' || finishOf(s).some((f) => BAD_FINISH.has(f))).length;
    scores.set('llm', score('llm', 1 - bad / chats.length, bad ? `${bad}/${chats.length} model calls failed or were cut off` : `${chats.length} model calls ok`));
  } else if (responses.length) {
    const bad = responses.filter((e) => BAD_FINISH.has(String(e.finish_reason ?? ''))).length;
    scores.set('llm', score('llm', 1 - bad / responses.length, bad ? `${bad}/${responses.length} answers cut off or withheld` : `${responses.length} responses ok`));
  }

  // cache: a lookup that fails is a problem; a miss is not. The reason reports the hit rate.
  const lookups = named('cache.lookup');
  if (lookups.length) {
    const failed = lookups.filter((s) => s.status === 'error').length;
    const hits = lookups.filter((s) => s.attrs['cache.hit'] === true).length;
    scores.set('cache', score('cache', 1 - failed / lookups.length, `${hits}/${lookups.length} lookups hit${failed ? `, ${failed} failed` : ''}`));
  }

  // harness: the run itself. Failures already blamed on a guard or the model are not blamed twice.
  if (run.status === 'completed') scores.set('harness', score('harness', 1, 'completed'));
  else if (!llmFailed && !guardrailStop) scores.set('harness', score('harness', 0, `run ${run.status}${reason ? `: ${truncate(reason, reasonChars)}` : ''}`));

  return [...scores.values()];
}
