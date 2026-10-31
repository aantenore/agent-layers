import {
  defineAdapter, defineLimits, limitSchema, limitValue, noopTelemetry, PORT_VERSIONS, publicCaller, stopReasonOf, type AgentSpec, type CallContext,
  type LimitValue, type RunEvent, type RunInput, type RunResult, type RuntimePort, type Stack, type StopReason,
} from '@agent-layers/core';
import {
  memoryStore, pricingFor, stream, summarizeCompaction, windowCompaction, type Agent, type Budget, type CompactionSettings, type Message,
  type ModelParams, type PolicyConfig, type Pricing, type RunResult as LoopResult, type ToolSettings,
} from 'reinloop';
import { fromMessages, fromUsage } from './convert.ts';
import { budgetName, mapEvent, recordEnd, recordEvent } from './events.ts';
import { governedProvider, governedTool, type RunControl } from './governed.ts';

export { fromMessages, fromModelReply, toMessages, toModelRequest } from './convert.ts';
export { governedProvider, governedTool, type RunControl } from './governed.ts';
export { mapEvent } from './events.ts';

/** Configurable limits; see docs/limits.md. Paths are nested objects of `options`, so the keys are short names. */
export const LIMITS = defineLimits({
  maxTurns: { path: 'options.budget.maxTurns', default: null, fallback: '50 when `budget` is absent (reinloop default), none otherwise', unit: 'count', min: 1, unbounded: 'fail', safe: { max: 100 } },
  maxToolCalls: { path: 'options.budget.maxToolCalls', default: null, fallback: 'no limit', unit: 'count', min: 1, unbounded: 'warn' },
  maxInputTokens: { path: 'options.budget.maxInputTokens', default: null, fallback: 'no limit', unit: 'tokens', min: 1, unbounded: 'warn' },
  maxOutputTokens: { path: 'options.budget.maxOutputTokens', default: null, fallback: 'no limit', unit: 'tokens', min: 1, unbounded: 'warn' },
  maxTotalTokens: { path: 'options.budget.maxTotalTokens', default: null, fallback: 'no limit', unit: 'tokens', min: 1, unbounded: 'warn' },
  maxCostUsd: { path: 'options.budget.maxCostUsd', default: null, fallback: 'no limit', unit: 'usd', min: 0, integer: false, unbounded: 'warn' },
  maxDurationMs: { path: 'options.budget.maxDurationMs', default: null, fallback: 'no limit', unit: 'ms', min: 1, unbounded: 'warn' },
  compactionThresholdTokens: { path: 'options.compaction.thresholdTokens', default: null, unit: 'tokens', min: 1, fallback: 'required when compaction is set' },
  compactionKeepFirst: { path: 'options.compaction.keepFirst', default: 1, unit: 'count', min: 0 },
  compactionKeepLast: { path: 'options.compaction.keepLast', default: null, unit: 'count', min: 1, fallback: 'reinloop: 20 for window, 10 for summarize' },
  compactionSummaryTokens: { path: 'options.compaction.maxTokens', default: 2048, unit: 'tokens', min: 1, safe: { max: 16_384 } },
  toolConcurrency: { path: 'options.tools.concurrency', default: 8, unit: 'count', min: 1, safe: { max: 64 } },
  toolTimeoutMs: { path: 'options.tools.timeoutMs', default: 'unbounded', unit: 'ms', min: 1, unbounded: 'warn', safe: { max: 300_000 } },
  toolMaxResultChars: { path: 'options.tools.maxResultChars', default: 32_000, unit: 'chars', min: 1, unbounded: 'fail', safe: { max: 200_000 } },
});

/** reinloop budgets; each accepts `"unbounded"`. */
export interface BudgetOptions {
  maxTurns?: LimitValue;
  maxToolCalls?: LimitValue;
  maxInputTokens?: LimitValue;
  maxOutputTokens?: LimitValue;
  maxTotalTokens?: LimitValue;
  maxCostUsd?: LimitValue;
  maxDurationMs?: LimitValue;
}

export interface CompactionOptions {
  /** `window` drops the middle of the conversation; `summarize` replaces it with a summary written by the model. */
  strategy?: 'window' | 'summarize';
  /** Context size, in estimated tokens, from which compaction runs. */
  thresholdTokens: number;
  /** `window`: messages kept at the start (default 1). */
  keepFirst?: number;
  /** Messages kept at the end (default 20 for `window`, 10 for `summarize`). */
  keepLast?: number;
  /** `summarize`: token limit of the summary (default 2048). */
  maxTokens?: number;
  /** `summarize`: instructions of the summary call. */
  prompt?: string;
}

/** Tool batch settings. */
export interface ToolOptions {
  /** Parallel calls in a batch (default 8). */
  concurrency?: number;
  /** Time limit per call (default unbounded). */
  timeoutMs?: LimitValue;
  /** Result size before truncation (default 32000). */
  maxResultChars?: LimitValue;
}

export interface ReinloopOptions {
  /** reinloop budgets; the run ends `stopped` with reason `{ code: 'limit', layer: 'harness', by: 'reinloop', detail: '<limit>' }`. Default `{ maxTurns: 50 }`, the others unbounded. */
  budget?: BudgetOptions;
  compaction?: CompactionOptions;
  /** Prices per model id (USD per million tokens), over reinloop's built-in table; used for `costUsd` and `maxCostUsd`. */
  pricing?: Record<string, Partial<Pricing>>;
  /** Tool batch settings: parallel calls, time limit per call, result size before truncation. */
  tools?: ToolOptions;
}

/**
 * Budgets to enforce, or undefined to keep reinloop's default (`{ maxTurns: 50 }`). Only the configured ones are passed;
 * an unbounded one is left out, as reinloop reads absence as no limit.
 */
function budgetOf(o?: BudgetOptions): Budget | undefined {
  if (!o) return undefined;
  const out: Budget = {};
  for (const key of ['maxTurns', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens', 'maxCostUsd', 'maxDurationMs'] as const) {
    if (o[key] === undefined) continue;
    const v = limitValue(LIMITS[key], o[key]);
    if (Number.isFinite(v)) out[key] = v;
  }
  return out;
}

/** Tool settings to enforce; the time limit is left out when unbounded (reinloop would pass Infinity to a timer). */
function toolSettingsOf(o: ToolOptions = {}): ToolSettings {
  const timeoutMs = limitValue(LIMITS.toolTimeoutMs, o.timeoutMs);
  return {
    concurrency: limitValue(LIMITS.toolConcurrency, o.concurrency),
    maxResultChars: limitValue(LIMITS.toolMaxResultChars, o.maxResultChars),
    ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  };
}

/**
 * reinloop's own policy is set to allow every call: authorization, approval and guards are applied by the stack's
 * governed tools, and a second policy would ask for approvals the SDK already decided.
 */
const ALLOW_ALL: PolicyConfig = { default: 'allow', risk: { read: 'allow', write: 'allow', exec: 'allow' } };

/** Factory: binds agent specs to reinloop agents whose model and tools are the stack's governed ports. */
export function createReinloopRuntime(options: ReinloopOptions = {}, name = 'reinloop'): RuntimePort {
  return {
    name,
    bind(stack, spec) {
      const collect = async (input: RunInput, init: Partial<CallContext>): Promise<RunResult> => {
        const events: RunEvent[] = [];
        const it = execute(stack, spec, input, stack.context({ ...init, agent: spec.name }), options, false);
        for (;;) {
          const step = await it.next();
          if (step.done) {
            const r = step.value;
            events.push(endEvent(r));
            return { runId: r.runId, status: r.status, output: r.output, usage: r.usage, costUsd: r.costUsd, ...(r.reason ? { reason: r.reason } : {}), events };
          }
          events.push(step.value);
        }
      };
      return {
        name: spec.name,
        run: (input, init = {}) => collect(input, init),
        async *stream(input, init = {}) {
          const it = execute(stack, spec, input, stack.context({ ...init, agent: spec.name }), options, true);
          for (;;) {
            const step = await it.next();
            if (step.done) {
              yield endEvent(step.value);
              return;
            }
            yield step.value;
          }
        },
      };
    },
  };
}

interface Outcome extends Required<Pick<RunResult, 'runId' | 'status' | 'output' | 'usage'>> { reason?: StopReason; costUsd: number; budget?: string }

const endEvent = (r: Outcome): RunEvent => ({
  type: 'run.end', status: r.status, ...(r.reason ? { reason: r.reason } : {}), usage: r.usage, costUsd: r.costUsd,
});

/** One run: builds the reinloop agent on the governed ports, drives it, maps its events and its result. */
async function* execute(stack: Stack, spec: AgentSpec, input: RunInput, ctx: CallContext, options: ReinloopOptions, streaming: boolean): AsyncGenerator<RunEvent, Outcome> {
  const telemetry = ctx.telemetry ?? stack.telemetry ?? noopTelemetry;
  const control: RunControl = { halt: new AbortController() };
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, control.halt.signal]) : control.halt.signal;
  const run: CallContext = { ...ctx, signal };
  const empty = { runId: ctx.runId, output: '', usage: fromUsage(undefined), costUsd: 0 };
  let agent: Agent;
  let messages: Message[] | string;
  try {
    const tools = stack.toolsFor(spec);
    const specs = spec.tools.length ? await tools.listTools(run) : [];
    const parsed = typeof input === 'string' ? { system: [], messages: input } : fromMessages(input.messages);
    messages = parsed.messages;
    const approval = stack.ports.approval?.name;
    agent = {
      name: spec.name,
      model: {
        provider: governedProvider(stack.modelFor(spec), run, control, { stream: streaming, ...(modelExt(spec) ? { ext: modelExt(spec)! } : {}) }),
        model: spec.model, params: modelParams(spec), ...pricingOf(spec.model, options),
      },
      instructions: [spec.instructions, ...parsed.system].filter(Boolean).join('\n\n') || undefined,
      tools: specs.map((s) => governedTool(tools, s, run, control, approval)),
      policy: ALLOW_ALL,
      ...(options.budget ? { budget: budgetOf(options.budget)! } : {}),
      ...(options.compaction ? { compaction: compaction(options.compaction) } : {}),
      toolSettings: toolSettingsOf(options.tools),
    };
  } catch (err) {
    return { ...empty, status: 'failed', reason: stopReasonOf(err) };
  }

  const caller = publicCaller(ctx.caller);
  const identity = caller ? { subject: caller.id, kind: caller.kind, roles: caller.roles, scopes: caller.scopes } : undefined;
  const handle = stream(agent, messages, { runId: ctx.runId, store: memoryStore(), signal, ...(identity ? { identity } : {}) });
  for await (const ev of handle) {
    recordEvent(telemetry, ev, spec.name);
    for (const mapped of mapEvent(ev, { stream: streaming })) yield mapped;
  }
  const out = outcome(await handle.result, control, signal);
  recordEnd(telemetry, { agent: spec.name, model: spec.model, costUsd: out.costUsd, ...(out.budget ? { budget: out.budget } : {}) });
  return out;
}

const LIMIT_MAX_TOKENS: StopReason = { code: 'limit', layer: 'harness', by: 'reinloop', detail: 'max_tokens' };

/**
 * reinloop result → SDK result. A stop recorded by the governed ports (guard block, call waiting for a person) wins and
 * has no output, as with any runtime. Otherwise reinloop's native reason is translated: `budget:<limit>` and
 * `max_tokens` are limits of reinloop, an interruption is an abort or a timeout (from the signal's reason), an error
 * is the error the model raised, if any. An answer cut at the token limit completes with that limit as its reason. Reasons never carry error text.
 */
function outcome(r: LoopResult, control: RunControl, signal: AbortSignal): Outcome {
  const base = { runId: r.runId, usage: fromUsage(r.usage), costUsd: r.costUsd };
  if (control.end) return { ...base, status: control.end.status, output: '', reason: control.end.reason };
  // An answer cut at the token limit still completes; the reason says it was cut.
  if (r.status === 'completed') return { ...base, status: 'completed', output: r.output, ...(r.reason === 'max_tokens' ? { reason: LIMIT_MAX_TOKENS } : {}) };
  if (r.status === 'interrupted') {
    const reason = stopReasonOf(signal.reason);
    return { ...base, status: 'stopped', output: '', reason: reason.code === 'error' ? { code: 'aborted' } : reason };
  }
  const budget = budgetName(r.reason);
  if (budget || r.reason === 'max_tokens') {
    return { ...base, status: 'stopped', output: r.output, reason: budget ? { ...LIMIT_MAX_TOKENS, detail: budget } : LIMIT_MAX_TOKENS, ...(budget ? { budget } : {}) };
  }
  const reason: StopReason = control.error !== undefined ? stopReasonOf(control.error) : { code: 'error', layer: 'harness', by: 'reinloop' };
  return { ...base, status: r.status === 'stopped' || reason.code !== 'error' ? 'stopped' : 'failed', output: r.output, reason };
}

/**
 * Agent settings: `temperature`, `maxOutputTokens` and `stop` go to the model; `ext["reinloop.retryMaxTokens"]` makes
 * reinloop repeat an answer cut at the token limit once with that limit.
 */
function modelParams(spec: AgentSpec): ModelParams {
  const s = spec.settings ?? {};
  const retry = spec.ext?.['reinloop.retryMaxTokens'];
  return {
    ...(s.temperature !== undefined ? { temperature: s.temperature } : {}),
    ...(s.maxOutputTokens !== undefined ? { maxTokens: s.maxOutputTokens } : {}),
    ...(s.stop ? { stop: s.stop } : {}),
    ...(typeof retry === 'number' ? { retryMaxTokens: retry } : {}),
  };
}

/** The agent's `ext` keys outside the adapter's namespace: they belong to the model adapter and travel with each request. */
function modelExt(spec: AgentSpec): Record<string, unknown> | undefined {
  const entries = Object.entries(spec.ext ?? {}).filter(([k]) => !k.startsWith('reinloop.'));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function pricingOf(model: string, options: ReinloopOptions): { pricing?: Pricing } {
  const pricing = pricingFor(model, options.pricing);
  return pricing ? { pricing } : {};
}

function compaction(o: CompactionOptions): CompactionSettings {
  const strategy = o.strategy === 'summarize'
    ? summarizeCompaction({ ...(o.keepLast !== undefined ? { keepLast: o.keepLast } : {}), maxTokens: limitValue(LIMITS.compactionSummaryTokens, o.maxTokens), ...(o.prompt ? { prompt: o.prompt } : {}) })
    : windowCompaction({ keepFirst: limitValue(LIMITS.compactionKeepFirst, o.keepFirst), ...(o.keepLast !== undefined ? { keepLast: o.keepLast } : {}) });
  return { strategy, thresholdTokens: o.thresholdTokens };
}

const amount = { type: 'number', minimum: 0 };

export const adapter = defineAdapter<'RuntimePort', ReinloopOptions>({
  layer: 'harness',
  port: 'RuntimePort',
  name: 'reinloop',
  direction: 'outbound',
  maps: { technology: 'reinloop' },
  portVersion: PORT_VERSIONS.RuntimePort,
  tiers: ['prototype', 'production'],
  description: 'reinloop agent loop with budgets and compaction; model and tool calls go through the stack\'s governed ports.',
  optionsSchema: {
    type: 'object',
    properties: {
      budget: {
        type: 'object',
        properties: {
          maxTurns: limitSchema(LIMITS.maxTurns, { description: 'Turns before the run stops' }),
          maxToolCalls: limitSchema(LIMITS.maxToolCalls, { description: 'Tool calls before the run stops' }),
          maxInputTokens: limitSchema(LIMITS.maxInputTokens, { description: 'Input tokens before the run stops' }),
          maxOutputTokens: limitSchema(LIMITS.maxOutputTokens, { description: 'Output tokens before the run stops' }),
          maxTotalTokens: limitSchema(LIMITS.maxTotalTokens, { description: 'Input and output tokens before the run stops' }),
          maxCostUsd: limitSchema(LIMITS.maxCostUsd, { description: 'Cost before the run stops' }),
          maxDurationMs: limitSchema(LIMITS.maxDurationMs, { description: 'Run time before the run stops' }),
        },
        additionalProperties: false,
      },
      compaction: {
        type: 'object',
        properties: {
          strategy: { enum: ['window', 'summarize'] },
          thresholdTokens: limitSchema(LIMITS.compactionThresholdTokens, { description: 'Context size from which compaction runs' }),
          keepFirst: limitSchema(LIMITS.compactionKeepFirst, { description: 'Messages kept at the start (window)' }),
          keepLast: limitSchema(LIMITS.compactionKeepLast, { description: 'Messages kept at the end' }),
          maxTokens: limitSchema(LIMITS.compactionSummaryTokens, { description: 'Token limit of the summary (summarize)' }),
          prompt: { type: 'string', minLength: 1 },
        },
        required: ['thresholdTokens'],
        additionalProperties: false,
      },
      pricing: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: { inputPerMTok: amount, outputPerMTok: amount, cacheReadPerMTok: amount },
          additionalProperties: false,
        },
      },
      tools: {
        type: 'object',
        properties: {
          concurrency: limitSchema(LIMITS.toolConcurrency, { description: 'Parallel tool calls in a batch' }),
          timeoutMs: limitSchema(LIMITS.toolTimeoutMs, { description: 'Time limit per tool call' }),
          maxResultChars: limitSchema(LIMITS.toolMaxResultChars, { description: 'Result size before truncation' }),
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  limits: LIMITS,
  ext: { reads: ['sdk.approval'] },
  create: (options, ctx) => createReinloopRuntime(options, ctx.name),
});

export const adapters = [adapter];
