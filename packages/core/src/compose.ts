import { AdapterRegistry, importAdapters, packageLoader, type AnyAdapter } from './adapter.ts';
import { agentSpec, configuredAdapters, type AdapterRef, type ConfiguredAdapter, type ResolvedConfig } from './config.ts';
import { BOUNDS_STOP, deadlineSignal, runLimits, startRun, type RunLedger, type RunLimits } from './bounds.ts';
import { AdapterError, AgentLayersError, ApprovalPending, BoundsExceeded, ConfigError, errorMessage, GuardrailBlocked, MissingLayerError, runEndOf } from './errors.ts';
import { boundExt, SDK_NAMESPACE, extNamespace, withExt } from './ext.ts';
import { anySignal, limitValue } from './limits.ts';
import {
  createMappings, effectiveRules, extReads, extWrites, loadMappingFunctions, rulesAgainstShape, type Mappings, type MappingRule,
} from './mappings.ts';
import { ownerDigest } from './inbound.ts';
import { ATTR, EVENT, METRIC, SPAN } from './names.ts';
import { PORTS, versionAtLeast } from './ports/catalog.ts';
import type { CallContext } from './ports/base.ts';
import { publicCaller } from './ports/identity.ts';
import type { ChannelHandle } from './ports/channel.ts';
import type { GuardPort } from './ports/guard.ts';
import type { ModelPort } from './ports/model.ts';
import type { AgentSpec, ResumeAnswer, RunEvent, RunInput, RunnableAgent, RunResult, StopReason } from './ports/runtime.ts';
import type { JsonValue } from './ports/store.ts';
import type { TelemetryPort } from './ports/telemetry.ts';
import type { ToolPort } from './ports/tool.ts';
import { governedTools } from './pipeline/governed-tools.ts';
import { guardedModel } from './pipeline/guarded-model.ts';
import { knowledgeInjector } from './pipeline/knowledge.ts';
import type { Stack, StackPorts } from './stack.ts';
import { memoryRunBook, runControl, storeRunBook, type InFlight, type RunControl } from './runs.ts';
import { slotInfo } from './slots.ts';
import { LANGUAGE_LIMITS, RUN_LIMITS } from './stack-limits.ts';
import { adapterOf, createTelemetry } from './telemetry.ts';
import { filterTools, knowledgeTools } from './tools.ts';
import { isPlainObject, newRunId } from './util.ts';
import { Vocabularies } from './vocab.ts';

export interface ComposeOptions {
  /** Registry to resolve adapters from; defaults to one that loads `@agent-layers/adapter-<name>` packages. */
  registry?: AdapterRegistry;
  /** Extra adapter descriptors, registered before resolution (useful in code and tests). */
  adapters?: readonly AnyAdapter[];
  env?: Record<string, string | undefined>;
  /** Extra telemetry adapters (for example a test recorder). */
  telemetry?: readonly TelemetryPort[];
}

const SECRET_REF = /\$\{secret:([^}]+)\}/g;

/** Resolves every adapter of a resolved config and wires the pipelines into a Stack. */
export async function compose(config: ResolvedConfig, opts: ComposeOptions = {}): Promise<Stack> {
  const env = opts.env ?? process.env;
  const registry = opts.registry ?? new AdapterRegistry({ loader: packageLoader(config.dir) });
  if (opts.adapters?.length) registry.register(opts.adapters.filter((a) => !registry.get(a.port, a.name)));
  for (const plugin of config.plugins) {
    const found = await importAdapters(plugin, config.dir).catch((err: unknown) => { throw new AdapterError('infra', plugin, `plugin failed to load: ${errorMessage(err)}`); });
    registry.register(found.filter((a) => !registry.get(a.port, a.name)));
  }

  const ports: StackPorts = { knowledge: {}, ingestion: {}, tools: {}, guardrails: [], telemetry: [], eval: [], channels: [], triggers: [] };
  const created: { close?(): Promise<void> }[] = [];
  const entries = configuredAdapters(config.layers);
  const tagAdapters = { adapterOf: adapterOf(entries) };
  let telemetry = createTelemetry([...(opts.telemetry ?? [])], tagAdapters);
  let composed: Stack | undefined;
  const lazyStack = (): Stack => {
    if (!composed) throw new AgentLayersError('the stack is not composed yet: use ctx.stack() when the adapter is called, not while it is created');
    return composed;
  };

  const language = await prepareLanguage(config, entries, registry);
  const extBytes = limitValue(LANGUAGE_LIMITS.extBytes, config.limits.extBytes);

  const make = async (e: (typeof entries)[number]) => {
    const options = await resolveSecrets(e.ref, ports.secrets, e.layer);
    const mappings = language.mappings.get(instanceKey(e));
    const instance = await registry.create(e.port, e.ref.adapter, options, { name: e.key, env, cwd: config.dir, telemetry, stack: lazyStack, ...(mappings ? { mappings } : {}) });
    created.push(instance);
    return instance;
  };

  try {
    // Telemetry and secrets first: every other adapter may use them.
    for (const e of entries.filter((x) => x.slot === 'telemetry')) ports.telemetry.push(await make(e) as never);
    telemetry = createTelemetry([...(opts.telemetry ?? []), ...ports.telemetry], tagAdapters);
    for (const w of language.warnings) telemetry.event(EVENT.configWarning, { [ATTR.layer]: 'infra', [ATTR.error]: w });
    for (const e of entries.filter((x) => x.slot === 'secrets')) ports.secrets = await make(e) as never;
    for (const e of entries) {
      if (e.slot === 'telemetry' || e.slot === 'secrets') continue;
      const instance = await make(e);
      const p = ports as unknown as Record<string, unknown>;
      if (e.slot === 'guardrails') ports.guardrails.push(namedGuard(instance as GuardPort, e.key, e.ref));
      else if (e.slot === 'knowledge' || e.slot === 'ingestion' || e.slot === 'tools') (p[e.slot] as Record<string, unknown>)[e.key] = instance;
      else if (Array.isArray(p[e.slot])) (p[e.slot] as unknown[]).push(instance);
      else p[e.slot] = instance;
    }
  } catch (err) {
    await Promise.allSettled(created.map((c) => c.close?.()));
    throw err;
  }

  // Key of the owner digest in client session ids (see inboundSessionId).
  let sessionSecret: string | undefined;
  try {
    const ref = config.sessions?.secret;
    if (ref?.includes('${secret:') && !ports.secrets) throw new ConfigError(['sessions.secret references ${secret:...} but no secrets adapter is configured']);
    sessionSecret = ref ? String(await resolveSecretRefs(ref, ports.secrets, 'infra', 'sessions')) : undefined;
  } catch (err) {
    await Promise.allSettled(created.map((c) => c.close?.()));
    throw err;
  }
  const digest = ownerDigest(sessionSecret);

  const k = config.pipeline.knowledge ?? {};
  const mode = k.mode ?? 'system';
  const toolSources: Record<string, ToolPort> = { ...ports.tools };
  const toolOpts = { ...(k.k ? { k: k.k } : {}), ...(k.maxK ? { maxK: k.maxK } : {}) };
  if (mode === 'tools' && Object.keys(ports.knowledge).length) toolSources.knowledge = knowledgeTools(ports.knowledge, toolOpts);
  const governance = {
    policy: config.policy, guards: ports.guardrails, telemetry, vocabularies: language.vocab, extBytes,
    ...(ports.authorization ? { authorization: ports.authorization } : {}),
    ...(ports.approval ? { approval: ports.approval } : {}),
    ...(ports.credentials ? { credentials: ports.credentials } : {}),
    ...(config.pipeline.approvalTimeoutMs ? { approvalTimeoutMs: config.pipeline.approvalTimeoutMs } : {}),
  };
  // Runs in progress → the approval a call of the run is waiting for: a runtime that catches ApprovalPending and
  // ends the run with its stop reason still gets `ext["sdk.approval"]` and the `waiting` status.
  const waiting: Waiting = new Map();
  // A runtime built for RuntimePort 1.0 may turn a thrown tool error into tool text and complete the run: it gets the
  // pending result it knows instead, and `onPending` still marks a run it ends with needs_input as waiting.
  const runtimeRef = entries.find((e) => e.slot === 'runtime');
  const runtimeVersion = runtimeRef && registry.get(runtimeRef.port, runtimeRef.ref.adapter)?.portVersion;
  const tools = governedTools(toolSources, {
    ...governance, pendingAs: runtimeVersion && !versionAtLeast(runtimeVersion, '1.1.0') ? 'result' : 'error',
    onPending: (pending, ctx) => { if (waiting.has(ctx.runId)) waiting.set(ctx.runId, pending); },
  });

  const models = new Map<string, ModelPort>();
  const modelWith = (sourceNames: readonly string[]): ModelPort => {
    const key = [...sourceNames].sort().join(',');
    let m = models.get(key);
    if (m) return m;
    const base = ports.model ?? missingModel();
    const sources = Object.fromEntries(sourceNames.filter((n) => ports.knowledge[n]).map((n) => [n, ports.knowledge[n]!]));
    const injected = (mode === 'system' || mode === 'user') && Object.keys(sources).length
      ? knowledgeInjector(sources, {
        mode, telemetry, extBytes, ...(k.k ? { k: k.k } : {}), ...(k.maxChars ? { maxChars: k.maxChars } : {}), ...(k.fusion ? { fusion: k.fusion } : {}),
      })(base)
      : base;
    m = guardedModel(injected, {
      guards: ports.guardrails, telemetry, extBytes,
      ...(ports.cache ? { cache: ports.cache } : {}), ...(ports.router ? { router: ports.router } : {}),
      ...(config.pipeline.cacheTtlMs ? { cacheTtlMs: config.pipeline.cacheTtlMs } : {}),
      cacheScope: config.pipeline.cacheScope ?? 'caller',
      ...(config.pipeline.pricing ? { pricing: config.pipeline.pricing } : {}),
    });
    models.set(key, m);
    return m;
  };

  // Tools for hosted channels: the governed tools plus the knowledge sources as read-only tools. A call waiting for an
  // approval is a pending result here (`ext["sdk.approval"]`), which the channel passes on in its protocol.
  let hostedTools: ToolPort | undefined;
  const toolsForHost = (): ToolPort => {
    if (hostedTools) return hostedTools;
    const knowledgeAsTools = mode !== 'tools' && Object.keys(ports.knowledge).length && !ports.tools.knowledge;
    hostedTools = governedTools(knowledgeAsTools ? { ...ports.tools, knowledge: knowledgeTools(ports.knowledge, toolOpts) } : toolSources, governance);
    return hostedTools;
  };

  const bound = new Map<string, Promise<RunnableAgent>>();
  const limits = runLimits(config.limits);
  // Runs that end waiting are kept to be resumed: in the store when there is one, else in this process (prototype).
  const resumeTtlMs = limitValue(RUN_LIMITS.resumeTtlMs, config.limits.run?.resumeTtlMs);
  const book = ports.store
    ? storeRunBook(ports.store, resumeTtlMs)
    : memoryRunBook(resumeTtlMs, limitValue(RUN_LIMITS.maxWaitingInMemory, config.limits.run?.maxWaitingInMemory));
  const inflight = new Map<string, InFlight>();
  const control = runControl({
    book, inflight, resuming: new Map(), telemetry,
    ...(ports.approval ? { approval: ports.approval } : {}), ...(ports.authorization ? { authorization: ports.authorization } : {}),
    agent: (name) => stack.agent(name),
  });
  const context = (init: Partial<CallContext> & { agent: string }): CallContext => ({ runId: newRunId(), telemetry, ...init });

  const stack: Stack = {
    config, registry, ports, telemetry, tools, vocabularies: language.vocab, warnings: language.warnings,
    get model() { return modelWith(Object.keys(ports.knowledge)); },
    modelFor: (agent: AgentSpec) => modelWith(agent.knowledge ?? Object.keys(ports.knowledge)),
    toolsFor: (agent: AgentSpec) => filterTools(tools, agent.tools),
    context,
    async verify(credential) {
      if (!ports.identity) throw new MissingLayerError('identity', 'identity adapter');
      return ports.identity.verify(credential);
    },
    agents: () => Object.keys(config.agents),
    resume: (runId, answer, init) => control.resume(runId, answer, init),
    cancel: (runId, o) => control.cancel(runId, o),
    agent(name) {
      let p = bound.get(name);
      if (!p) {
        p = bindAgent(stack, name, { context, extBytes, waiting, limits, control, inflight });
        bound.set(name, p);
        p.catch(() => bound.delete(name));
      }
      return p;
    },
    host(opts = {}) {
      const as = (ctx: Partial<CallContext> | undefined): Partial<CallContext> | undefined =>
        opts.caller && !ctx?.caller ? { ...ctx, caller: opts.caller } : ctx;
      return {
        agents: () => stack.agents(),
        run: async (agent, input, ctx) => (await stack.agent(agent)).run(input, as(ctx)),
        stream: (agent, input, ctx) => streamRun(stack, agent, input, as(ctx)),
        resume: (runId, answer, ctx) => stack.resume(runId, answer, as(ctx)),
        cancel: (runId, o = {}) => stack.cancel(runId, opts.caller && !o.by ? { ...o, by: opts.caller } : o),
        ...(ports.identity ? { verify: (c: string) => stack.verify(c) } : {}),
        ...(ports.model ? { model: () => modelWith([]) } : {}),
        tools: toolsForHost,
        ownerDigest: digest,
      };
    },
    async start(opts = {}) {
      const host = stack.host(opts);
      const handles: ChannelHandle[] = [];
      // Channels and triggers that only mount on a host server are started by that server (the gateway).
      for (const c of ports.channels) if (c.serve) handles.push(await c.serve(host));
      for (const t of ports.triggers) {
        if (!t.start) continue;
        handles.push(await t.start(async (trigger) => {
          const agent = trigger.agent ?? stack.agents()[0];
          if (!agent) throw new MissingLayerError('harness', 'agent for trigger');
          await host.run(agent, typeof trigger.data === 'string' ? trigger.data : JSON.stringify(trigger.data ?? {}), { runId: trigger.id });
        }));
      }
      const ending = handles.flatMap((h) => (h.done ? [h.done] : []));
      return {
        // Ends when the first channel that can end by itself (such as a terminal) does.
        ...(ending.length ? { done: Promise.race(ending) } : {}),
        async close() { await Promise.allSettled(handles.map((h) => h.close())); },
      };
    },
    async close() {
      await Promise.allSettled(created.filter((c) => !ports.telemetry.includes(c as TelemetryPort)).map((c) => c.close?.()));
      await telemetry.flush?.();
      await telemetry.close?.();
    },
  };
  composed = stack;
  return stack;
}

type Waiting = Map<string, ApprovalPending | undefined>;

/** The result of a run ended by a pending approval, a guard block or a run bound thrown out of the runtime. */
function endedBy(err: unknown, runId: string): RunResult | undefined {
  if (!(err instanceof ApprovalPending) && !(err instanceof GuardrailBlocked) && !(err instanceof BoundsExceeded)) return undefined;
  const { status, reason } = runEndOf(err);
  return { runId, status, output: '', reason, ...(err instanceof ApprovalPending ? { ext: err.approvalExt } : {}) };
}

/**
 * A run that stopped for an approval a call of it is waiting for: status `waiting` and `ext["sdk.approval"]`, whether
 * the runtime let `ApprovalPending` propagate or ended the run with its stop reason.
 */
function withApproval(result: RunResult, pending: ApprovalPending | undefined): RunResult {
  if (!pending || (result.status !== 'waiting' && result.reason?.code !== 'needs_input')) return result;
  return { ...result, status: 'waiting', reason: result.reason ?? pending.stopReason, ext: withExt(result.ext, pending.approvalExt)! };
}

/** A run's context with its bounds, and the ledger behind them (see `startRun`). */
interface Begun { ctx: CallContext; ledger: RunLedger; refused?: StopReason; own?: AbortSignal }

/**
 * Starts the bounds of a run: computes them from the stack's limits and what the caller sent (`delegation`, removed
 * from the run's context), arms an abort at the deadline, merged with the caller's signal.
 */
function begin(context: Stack['context'], init: Partial<CallContext>, name: string, limits: RunLimits): Begun {
  const { delegation: _sent, bounds: _parent, ...base } = context({ ...init, agent: name });
  const start = startRun({ runId: base.runId, ...(base.caller ? { caller: base.caller } : {}), ...(init.delegation ? { delegation: init.delegation } : {}) }, limits);
  const { ledger } = start;
  const signal = anySignal(base.signal, deadlineSignal(ledger));
  const lineage = ledger.lineage ?? base.lineage;
  const ctx: CallContext = { ...base, bounds: ledger.view, ...(lineage ? { lineage } : {}), ...(signal ? { signal } : {}) };
  return { ctx, ledger, ...(start.refused ? { refused: start.refused } : {}), ...(base.signal ? { own: base.signal } : {}) };
}

/**
 * The result as the bounds left it: a run that did not complete because of a bound (a model call refused, the deadline
 * reached while the caller was still waiting) ends `stopped` with the bound's reason. Usage and cost the runtime does
 * not report come from the ledger.
 */
function settle(result: RunResult, b: Begun): RunResult {
  let r = result;
  const { ledger } = b;
  if (r.status === 'failed' || r.status === 'stopped') {
    const code = String(r.reason?.code ?? 'error');
    if (!ledger.stop && !b.own?.aborted && ledger.remainingMs() <= 0 && ['timeout', 'aborted', 'error'].includes(code)) ledger.stop = BOUNDS_STOP.deadline;
    if (ledger.stop) r = { ...r, status: 'stopped', reason: { ...ledger.stop } };
  }
  if (!r.usage && (ledger.usage.inputTokens || ledger.usage.outputTokens)) r = { ...r, usage: { ...ledger.usage } };
  if (r.costUsd === undefined && ledger.costKnown && ledger.spentCost > 0) r = { ...r, costUsd: ledger.spentCost };
  return r;
}

/** Span attributes of a run's bounds and caller chain. */
function boundsAttrs(b: Begun): Record<string, string | number | string[]> {
  const { ledger, ctx } = b;
  return {
    [ATTR.runHops]: ledger.hops, [ATTR.runMaxHops]: ledger.maxHops,
    ...(Number.isFinite(ledger.startMs) ? { [ATTR.runDeadlineMs]: ledger.startMs } : {}),
    ...(ledger.lineage ? { [ATTR.runRoot]: ledger.lineage.rootRunId, [ATTR.runParent]: ledger.lineage.parentRunId } : {}),
    ...(ctx.caller?.actors?.length ? { [ATTR.callerActors]: ctx.caller.actors.map((a) => a.id) } : {}),
  };
}

/** The result of a run its bounds refuse before it starts: no model call, no tool call. */
const refusedRun = (runId: string, reason: StopReason): RunResult => ({ runId, status: 'stopped', output: '', reason: { ...reason } });

interface Binding {
  context: Stack['context'];
  extBytes: number;
  waiting: Waiting;
  limits: RunLimits;
  control: RunControl;
  inflight: Map<string, InFlight>;
}

async function bindAgent(stack: Stack, name: string, k: Binding): Promise<RunnableAgent> {
  const { context, extBytes, waiting, limits, control, inflight } = k;
  const spec = await agentSpec(stack.config, name);
  const runtime = stack.ports.runtime;
  if (!runtime) throw new MissingLayerError('harness', 'runtime adapter');
  const inner = await runtime.bind(stack, spec);
  const state = stack.ports.state;
  const stopped = (r: RunResult) => {
    const code = r.reason?.code;
    if (r.status === 'stopped' && (code === 'timeout' || code === 'limit' || code === 'hop_limit') && r.reason?.by?.startsWith('sdk.')) {
      stack.telemetry.metric(METRIC.boundsStops, 1, { [ATTR.layer]: 'harness', [ATTR.name]: name, [ATTR.runReason]: code });
    }
  };

  /**
   * Starts a run this process can cancel: its own abort, merged with the caller's signal, registered by run id until
   * it ends, and a slot for the approval a call of it may wait for.
   */
  const open = (init: Partial<CallContext>) => {
    const own = new AbortController();
    const signal = anySignal(init.signal, own.signal);
    const b = begin(context, { ...init, ...(signal ? { signal } : {}) }, name, limits);
    const caller = publicCaller(b.ctx.caller);
    inflight.set(b.ctx.runId, { controller: own, agent: name, ...(caller ? { caller } : {}) });
    waiting.set(b.ctx.runId, undefined);
    const close = () => { inflight.delete(b.ctx.runId); waiting.delete(b.ctx.runId); };
    return { b, close };
  };

  /** One run, fresh or resumed: bounds, span, the waiting record, the session log. The checkpoint never leaves. */
  const execute = (init: Partial<CallContext>, input: RunInput, call: (ctx: CallContext) => Promise<RunResult>): Promise<RunResult> => {
    const { b, close } = open(init);
    const { ctx } = b;
    return stack.telemetry.span(SPAN.run, { [ATTR.layer]: 'harness', [ATTR.name]: name, [ATTR.runId]: ctx.runId, ...boundsAttrs(b) }, async (span) => {
      let result: RunResult;
      let pending: ApprovalPending | undefined;
      try {
        result = b.refused ? refusedRun(ctx.runId, b.refused) : withApproval(await call(ctx), waiting.get(ctx.runId));
      } catch (err) {
        const ended = endedBy(err, ctx.runId);
        if (!ended) throw err;
        result = ended;
      } finally {
        pending = waiting.get(ctx.runId);
        close();
      }
      result = settle(result, b);
      stopped(result);
      await control.settle(ctx, input, result, pending);
      const { checkpoint: _checkpoint, ...rest } = result;
      result = boundExt(rest, extBytes, (bytes) => stack.telemetry.event(EVENT.extDropped, { [ATTR.layer]: 'harness', [ATTR.extBytes]: bytes, [ATTR.extShape]: 'RunResult' }));
      span.setAttributes({ [ATTR.runStatus]: result.status, ...(result.reason ? { [ATTR.runReason]: String(result.reason.code) } : {}) });
      if (state && ctx.sessionId && result.events?.length) await state.append(ctx.sessionId, result.events);
      return result;
    }, ctx.trace ? { parent: ctx.trace } : undefined);
  };

  return {
    name,
    run: (input: RunInput, init = {}) => execute(init, input, (ctx) => inner.run(input, ctx)),
    ...(inner.stream ? {
      stream: (input: RunInput, init = {}) => {
        const { b, close } = open(init);
        if (b.refused) { close(); return refusedStream(b.refused); }
        return settleStream(streamEnded(inner.stream!(input, b.ctx)), b, stopped, async (r) => {
          const pending = waiting.get(b.ctx.runId);
          close();
          await control.settle(b.ctx, input, r, pending);
        }, close);
      },
    } : {}),
    ...(inner.resume ? {
      resume: (checkpoint: JsonValue, answer: ResumeAnswer, init = {}) =>
        execute(init, 'input' in answer ? answer.input : '', (ctx) => inner.resume!(checkpoint, answer, ctx)),
    } : {}),
  };
}

/** The stream of a run its bounds refuse: one `run.end`. */
async function* refusedStream(reason: StopReason): AsyncGenerator<RunEvent> {
  yield { type: 'run.end', status: 'stopped', reason: { ...reason } };
}

/**
 * A run's stream whose final `run.end` is settled like a run's result (see `settle`): `ended` records how it ended
 * (the waiting record) before the event is passed on, without its checkpoint; `close` runs however the stream stops.
 */
async function* settleStream(
  events: AsyncIterable<RunEvent>, b: Begun, stopped: (r: RunResult) => void, ended: (r: RunResult) => Promise<void>, close: () => void,
): AsyncGenerator<RunEvent> {
  try {
    for await (const e of events) {
      if (e.type !== 'run.end') { yield e; continue; }
      const { checkpoint, ...end } = e as Extract<RunEvent, { type: 'run.end' }>;
      const r = settle({
        runId: b.ctx.runId, status: end.status, output: '', ...(end.reason ? { reason: end.reason } : {}), ...(end.usage ? { usage: end.usage } : {}),
        ...(end.costUsd !== undefined ? { costUsd: end.costUsd } : {}), ...(checkpoint !== undefined ? { checkpoint } : {}),
      }, b);
      stopped(r);
      await ended(r);
      yield { ...end, status: r.status, ...(r.reason ? { reason: r.reason } : {}), ...(r.usage ? { usage: r.usage } : {}), ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) };
    }
  } finally {
    close();
  }
}

/** A runtime's stream whose pending approval or guard block, thrown instead of ended, becomes its `run.end` event. */
async function* streamEnded(events: AsyncIterable<RunEvent>): AsyncGenerator<RunEvent> {
  try {
    yield* events;
  } catch (err) {
    const end = endedBy(err, '');
    if (!end) throw err;
    yield { type: 'run.end', status: end.status, ...(end.reason ? { reason: end.reason } : {}) };
  }
}

/** Streams a run; for a runtime without streaming, the result becomes a `text` event and a `run.end` event. */
async function* streamRun(stack: Stack, name: string, input: RunInput, ctx: Partial<CallContext> | undefined): AsyncGenerator<RunEvent> {
  const agent = await stack.agent(name);
  if (agent.stream) {
    yield* agent.stream(input, ctx);
    return;
  }
  const r = await agent.run(input, ctx);
  if (r.output) yield { type: 'text', text: r.output };
  yield { type: 'run.end', status: r.status, ...(r.reason ? { reason: r.reason } : {}), ...(r.usage ? { usage: r.usage } : {}), ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) };
}

function missingModel(): ModelPort {
  const fail = () => { throw new MissingLayerError('llm', 'model adapter'); };
  return { name: 'missing', chat: async () => fail() };
}

function namedGuard(g: GuardPort, name: string, ref: AdapterRef): GuardPort {
  const stages = ref.stages ?? g.stages;
  return {
    name: g.name ?? name,
    ...(stages ? { stages } : {}),
    check: (input, o) => g.check(input, o),
    native: () => g.native?.() ?? g,
    ...(g.close ? { close: () => g.close!() } : {}),
  };
}

/** Replaces `${secret:NAME}` in adapter options through the secrets slot. */
async function resolveSecrets(ref: AdapterRef, secrets: StackPorts['secrets'], layer: (typeof PORTS)[keyof typeof PORTS]['layer']): Promise<unknown> {
  return resolveSecretRefs(ref.options ?? {}, secrets, layer, ref.adapter);
}

/** Replaces `${secret:NAME}` in every string of `value` through the secrets slot; errors name `owner`. */
async function resolveSecretRefs(value: unknown, secrets: StackPorts['secrets'], layer: (typeof PORTS)[keyof typeof PORTS]['layer'], owner: string): Promise<unknown> {
  if (!JSON.stringify(value).includes('${secret:')) return value;
  if (!secrets) throw new AdapterError(layer, owner, 'options reference ${secret:...} but no secrets adapter is configured');
  const walk = async (v: unknown): Promise<unknown> => {
    if (typeof v === 'string') {
      let out = v;
      for (const m of v.matchAll(SECRET_REF)) {
        const found = await secrets.get(m[1]!);
        if (found === undefined) throw new AdapterError(layer, owner, `secret "${m[1]}" not found`);
        out = out.replace(m[0], found);
      }
      return out;
    }
    if (Array.isArray(v)) return Promise.all(v.map(walk));
    if (isPlainObject(v)) return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k2, x]) => [k2, await walk(x)])));
    return v;
  };
  return walk(value);
}

/** Mapping key of an adapter instance: the slot for single slots, `<slot>.<instance>` otherwise. */
export function instanceKey(e: Pick<ConfiguredAdapter, 'slot' | 'key'>): string {
  return slotInfo(e.slot)?.shape === 'single' ? e.slot : `${e.slot}.${e.key}`;
}

interface Language { vocab: Vocabularies; mappings: Map<string, Mappings>; warnings: string[] }

/** The language problems of a resolved config (what compose would refuse, and its warnings), for readiness gates. */
export async function languageCheck(config: ResolvedConfig, registry: AdapterRegistry): Promise<{ errors: string[]; warnings: string[] }> {
  try {
    const { warnings } = await prepareLanguage(config, configuredAdapters(config.layers), registry);
    return { errors: [], warnings };
  } catch (err) {
    return { errors: err instanceof ConfigError ? err.errors : [errorMessage(err)], warnings: [] };
  }
}

/**
 * The language checks of a resolved config against the adapters it uses: effective vocabularies, each instance's
 * mapping rules (validated against its descriptor's shapes, `fn` modules loaded), `ext` keys that mappings read but
 * nothing produces (errors) and declared `reads` nothing produces (warnings), policy risk values. Throws ConfigError.
 */
async function prepareLanguage(config: ResolvedConfig, entries: readonly ConfiguredAdapter[], registry: AdapterRegistry): Promise<Language> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const found: { e: ConfiguredAdapter; d: AnyAdapter | undefined }[] = [];
  for (const e of entries) found.push({ e, d: await registry.resolve(e.port, e.ref.adapter).catch(() => undefined) });
  const vocab = new Vocabularies([...found.map((f) => f.d?.vocabularies), config.vocabularies]);

  const keys = new Set(found.map((f) => instanceKey(f.e)));
  for (const key of Object.keys(config.mappings)) {
    if (!keys.has(key)) errors.push(`mappings.${key}: no adapter instance with this key in the profile (known: ${[...keys].join(', ') || 'none'})`);
  }
  const rules = new Map<string, { in: MappingRule[]; out: MappingRule[]; check?: AnyAdapter['mappingDefaults'] }>();
  const produced = new Set<string>();
  for (const { e, d } of found) {
    if (!d) continue;
    const key = instanceKey(e);
    const ns = d.ext?.namespace ?? d.name;
    for (const k of d.ext?.produces ?? []) produced.add(k);
    const configured = config.mappings[key] ?? undefined;
    const effective = { in: [] as MappingRule[], out: [] as MappingRule[] };
    for (const dir of ['in', 'out'] as const) {
      const side = d.mappingDefaults?.[dir];
      const own = configured?.[dir];
      if (own !== undefined && own !== null && !side) { errors.push(`mappings.${key}.${dir}: adapter "${d.name}" takes no ${dir} mappings`); continue; }
      if (!side) continue;
      effective[dir] = effectiveRules(side.rules, own);
      errors.push(...rulesAgainstShape(effective[dir], dir, side.shape, { namespace: ns, vocab, path: `mappings.${key}.${dir}` }));
    }
    for (const k of extWrites(effective.in)) produced.add(k);
    rules.set(key, { ...effective, check: d.mappingDefaults });
  }
  for (const [key, r] of rules) {
    for (const k of extReads(r.out)) {
      if (extNamespace(k) !== SDK_NAMESPACE && !produced.has(k)) errors.push(`mappings.${key}.out: reads ext key "${k}" that no adapter in the profile produces`);
    }
  }
  for (const { e, d } of found) {
    for (const k of d?.ext?.reads ?? []) {
      if (extNamespace(k) !== SDK_NAMESPACE && !produced.has(k)) warnings.push(`${instanceKey(e)}: adapter "${d!.name}" reads ext key "${k}" that no adapter in the profile produces`);
    }
  }
  config.policy.forEach((r, i) => {
    for (const risk of r.risk ?? []) if (!vocab.has('risk', risk)) errors.push(`policy[${i}].risk: "${risk}" is not a risk value (add it under vocabularies.risk)`);
  });
  if (errors.length) throw new ConfigError(errors);

  let fns;
  try {
    fns = await loadMappingFunctions([...rules.values()].flatMap((r) => [r.in, r.out]), config.dir);
  } catch (err) {
    throw new ConfigError([`mappings: ${errorMessage(err)}`]);
  }
  const mappings = new Map<string, Mappings>();
  const check = config.tier !== 'production';
  for (const [key, r] of rules) {
    const shape = r.check?.in?.shape;
    mappings.set(key, createMappings(key, r, { fns, ...(check && shape ? { check: { in: shape, vocab } } : {}) }));
  }
  return { vocab, mappings, warnings };
}
