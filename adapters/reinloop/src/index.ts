import {
  defineAdapter, errorMessage, noopTelemetry, PORT_VERSIONS, publicIdentity, type AgentSpec, type CallContext, type RunEvent, type RunInput,
  type RunResult, type RuntimePort, type Stack,
} from '@agent-layers/core';
import {
  memoryStore, pricingFor, stream, summarizeCompaction, windowCompaction, type Agent, type Budget, type CompactionSettings, type Message,
  type ModelParams, type PolicyConfig, type Pricing, type RunResult as LoopResult, type ToolSettings,
} from 'reinloop';
import { fromChatMessages, toChatUsage } from './convert.ts';
import { mapEvent, recordEnd, recordEvent } from './events.ts';
import { governedProvider, governedTool } from './governed.ts';

export { fromChatMessages, fromChatResponse, toChatMessages, toChatRequest } from './convert.ts';
export { governedProvider, governedTool } from './governed.ts';
export { mapEvent } from './events.ts';

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

export interface ReinloopOptions {
  /** reinloop budgets; the run ends `stopped` with reason `budget:<limit>`. Default `{ maxTurns: 50 }`. */
  budget?: Budget;
  compaction?: CompactionOptions;
  /** Prices per model id (USD per million tokens), over reinloop's built-in table; used for `costUsd` and `maxCostUsd`. */
  pricing?: Record<string, Partial<Pricing>>;
  /** Tool batch settings: parallel calls, time limit per call, result size before truncation. */
  tools?: Pick<ToolSettings, 'concurrency' | 'timeoutMs' | 'maxResultChars'>;
}

/**
 * reinloop's own policy is set to allow every call: authorization, approval and guards are applied by the stack's
 * governed tools, and a second policy would ask for approvals the SDK already decided.
 */
const ALLOW_ALL: PolicyConfig = { default: 'allow', risk: { read: 'allow', write: 'allow', exec: 'allow' } };

const PARAM_KEYS = ['temperature', 'max_tokens', 'stop'] as const;

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
            events.push(endEvent(r, false));
            return { runId: r.runId, status: r.status, output: r.output, usage: r.usage, ...(r.reason ? { reason: r.reason } : {}), events };
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
              yield endEvent(step.value, true);
              return;
            }
            yield step.value;
          }
        },
      };
    },
  };
}

interface Outcome extends Required<Pick<RunResult, 'runId' | 'status' | 'output' | 'usage'>> { reason?: string; turns: number; costUsd: number }

function endEvent(r: Outcome, withOutput: boolean): RunEvent {
  return {
    type: 'run_end', runId: r.runId, status: r.status, ...(r.reason ? { reason: r.reason } : {}), ...(withOutput ? { output: r.output } : {}),
    usage: r.usage, turns: r.turns, costUsd: r.costUsd,
  };
}

/** One run: builds the reinloop agent on the governed ports, drives it, maps its events and its result. */
async function* execute(stack: Stack, spec: AgentSpec, input: RunInput, ctx: CallContext, options: ReinloopOptions, streaming: boolean): AsyncGenerator<RunEvent, Outcome> {
  const telemetry = ctx.telemetry ?? stack.telemetry ?? noopTelemetry;
  const halt = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, halt.signal]) : halt.signal;
  const run: CallContext = { ...ctx, signal };
  const empty = { runId: ctx.runId, output: '', usage: toChatUsage({ inputTokens: 0, outputTokens: 0 }), turns: 0, costUsd: 0 };
  let agent: Agent;
  let messages: Message[] | string;
  try {
    const tools = stack.toolsFor(spec);
    const specs = spec.tools.length ? await tools.listTools(run) : [];
    const parsed = typeof input === 'string' ? { system: [], messages: input } : fromChatMessages(input.messages);
    messages = parsed.messages;
    agent = {
      name: spec.name,
      model: { provider: governedProvider(stack.modelFor(spec), run, { stream: streaming }), model: spec.model, params: modelParams(spec), ...pricingOf(spec.model, options) },
      instructions: [spec.instructions, ...parsed.system].filter(Boolean).join('\n\n') || undefined,
      tools: specs.map((s) => governedTool(tools, s, run, halt)),
      policy: ALLOW_ALL,
      ...(options.budget ? { budget: options.budget } : {}),
      ...(options.compaction ? { compaction: compaction(options.compaction) } : {}),
      ...(options.tools ? { toolSettings: options.tools } : {}),
    };
  } catch (err) {
    return { ...empty, status: 'failed', reason: errorMessage(err) };
  }

  const identity = publicIdentity(ctx.identity);
  const handle = stream(agent, messages, { runId: ctx.runId, store: memoryStore(), signal, ...(identity ? { identity } : {}) });
  for await (const ev of handle) {
    recordEvent(telemetry, ev, spec.name);
    const mapped = mapEvent(ev, { stream: streaming });
    if (mapped) yield mapped;
  }
  const out = outcome(await handle.result);
  recordEnd(telemetry, { agent: spec.name, model: spec.model, costUsd: out.costUsd, ...(out.reason ? { reason: out.reason } : {}) });
  return out;
}

/**
 * reinloop result → SDK result. `interrupted` (the caller aborted) becomes `stopped` with reason `aborted`; a guardrail
 * stop keeps its `guardrail:<guard>:<stage>` reason and has no output, as with any runtime.
 */
function outcome(r: LoopResult): Outcome {
  const base = { runId: r.runId, usage: toChatUsage(r.usage), turns: r.turns, costUsd: r.costUsd };
  if (r.status === 'interrupted') return { ...base, status: 'stopped', output: '', reason: 'aborted' };
  if (r.reason?.startsWith('guardrail:')) return { ...base, status: 'stopped', output: '', reason: r.reason };
  const status = r.status === 'completed' || r.status === 'stopped' ? r.status : 'failed';
  return { ...base, status, output: r.output, ...(r.reason ? { reason: r.reason } : {}) };
}

/** Agent `params`: `temperature`, `max_tokens` and `stop` go to the model; any other key is passed as `extra`. */
function modelParams(spec: AgentSpec): ModelParams {
  const p = spec.params ?? {};
  const extra = Object.fromEntries(Object.entries(p).filter(([k]) => !(PARAM_KEYS as readonly string[]).includes(k)));
  return {
    ...(typeof p.temperature === 'number' ? { temperature: p.temperature } : {}),
    ...(typeof p.max_tokens === 'number' ? { maxTokens: p.max_tokens } : {}),
    ...(Array.isArray(p.stop) ? { stop: p.stop as string[] } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

function pricingOf(model: string, options: ReinloopOptions): { pricing?: Pricing } {
  const pricing = pricingFor(model, options.pricing);
  return pricing ? { pricing } : {};
}

function compaction(o: CompactionOptions): CompactionSettings {
  const strategy = o.strategy === 'summarize'
    ? summarizeCompaction({ ...(o.keepLast !== undefined ? { keepLast: o.keepLast } : {}), ...(o.maxTokens !== undefined ? { maxTokens: o.maxTokens } : {}), ...(o.prompt ? { prompt: o.prompt } : {}) })
    : windowCompaction({ ...(o.keepFirst !== undefined ? { keepFirst: o.keepFirst } : {}), ...(o.keepLast !== undefined ? { keepLast: o.keepLast } : {}) });
  return { strategy, thresholdTokens: o.thresholdTokens };
}

const count = { type: 'integer', minimum: 1 };
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
          maxTurns: count, maxToolCalls: count, maxInputTokens: count, maxOutputTokens: count, maxTotalTokens: count,
          maxCostUsd: amount, maxDurationMs: count,
        },
        additionalProperties: false,
      },
      compaction: {
        type: 'object',
        properties: {
          strategy: { enum: ['window', 'summarize'] }, thresholdTokens: count, keepFirst: { type: 'integer', minimum: 0 }, keepLast: count,
          maxTokens: count, prompt: { type: 'string', minLength: 1 },
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
        properties: { concurrency: count, timeoutMs: count, maxResultChars: count },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  create: (options, ctx) => createReinloopRuntime(options, ctx.name),
});

export const adapters = [adapter];
