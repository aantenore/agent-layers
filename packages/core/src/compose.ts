import { AdapterRegistry, importAdapters, packageLoader, type AnyAdapter } from './adapter.ts';
import { agentSpec, configuredAdapters, type AdapterRef, type ConfiguredAdapter, type ResolvedConfig } from './config.ts';
import { AdapterError, AgentLayersError, ConfigError, errorMessage, GuardrailBlocked, MissingLayerError } from './errors.ts';
import { boundExt, SDK_NAMESPACE, extNamespace } from './ext.ts';
import { limitValue } from './limits.ts';
import {
  createMappings, effectiveRules, extReads, extWrites, loadMappingFunctions, rulesAgainstShape, type Mappings, type MappingRule,
} from './mappings.ts';
import { ATTR, EVENT, SPAN } from './names.ts';
import { PORTS } from './ports/catalog.ts';
import type { CallContext } from './ports/base.ts';
import type { ChannelHandle } from './ports/channel.ts';
import type { GuardPort } from './ports/guard.ts';
import type { ModelPort } from './ports/model.ts';
import type { AgentSpec, RunEvent, RunInput, RunnableAgent, RunResult } from './ports/runtime.ts';
import type { TelemetryPort } from './ports/telemetry.ts';
import type { ToolPort } from './ports/tool.ts';
import { governedTools } from './pipeline/governed-tools.ts';
import { guardedModel } from './pipeline/guarded-model.ts';
import { knowledgeInjector } from './pipeline/knowledge.ts';
import type { Stack, StackPorts } from './stack.ts';
import { slotInfo } from './slots.ts';
import { LANGUAGE_LIMITS } from './stack-limits.ts';
import { createTelemetry } from './telemetry.ts';
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
  let telemetry = createTelemetry([...(opts.telemetry ?? [])]);
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
    telemetry = createTelemetry([...(opts.telemetry ?? []), ...ports.telemetry]);
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
  const tools = governedTools(toolSources, governance);

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
    });
    models.set(key, m);
    return m;
  };

  // Tools for hosted channels: the governed tools plus the knowledge sources as read-only tools.
  let hostedTools: ToolPort | undefined;
  const toolsForHost = (): ToolPort => {
    if (hostedTools) return hostedTools;
    const knowledgeAsTools = mode !== 'tools' && Object.keys(ports.knowledge).length && !ports.tools.knowledge;
    hostedTools = knowledgeAsTools
      ? governedTools({ ...ports.tools, knowledge: knowledgeTools(ports.knowledge, toolOpts) }, governance)
      : tools;
    return hostedTools;
  };

  const bound = new Map<string, Promise<RunnableAgent>>();
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
    agent(name) {
      let p = bound.get(name);
      if (!p) {
        p = bindAgent(stack, name, context, extBytes);
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
        ...(ports.identity ? { verify: (c: string) => stack.verify(c) } : {}),
        ...(ports.model ? { model: () => modelWith([]) } : {}),
        tools: toolsForHost,
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

async function bindAgent(stack: Stack, name: string, context: Stack['context'], extBytes: number): Promise<RunnableAgent> {
  const spec = await agentSpec(stack.config, name);
  const runtime = stack.ports.runtime;
  if (!runtime) throw new MissingLayerError('harness', 'runtime adapter');
  const inner = await runtime.bind(stack, spec);
  const state = stack.ports.state;
  return {
    name,
    async run(input: RunInput, init = {}) {
      const ctx = context({ ...init, agent: name });
      return stack.telemetry.span(SPAN.run, { [ATTR.layer]: 'harness', [ATTR.name]: name, [ATTR.runId]: ctx.runId }, async (span) => {
        let result: RunResult;
        try {
          result = await inner.run(input, ctx);
        } catch (err) {
          if (!(err instanceof GuardrailBlocked)) throw err;
          result = { runId: ctx.runId, status: 'stopped', output: '', reason: err.stopReason };
        }
        result = boundExt(result, extBytes, (bytes) => stack.telemetry.event(EVENT.extDropped, { [ATTR.layer]: 'harness', [ATTR.extBytes]: bytes, [ATTR.extShape]: 'RunResult' }));
        span.setAttributes({ [ATTR.runStatus]: result.status, ...(result.reason ? { [ATTR.runReason]: String(result.reason.code) } : {}) });
        if (state && ctx.sessionId && result.events?.length) await state.append(ctx.sessionId, result.events);
        return result;
      }, ctx.trace ? { parent: ctx.trace } : undefined);
    },
    ...(inner.stream ? { stream: (input: RunInput, init = {}) => inner.stream!(input, context({ ...init, agent: name })) } : {}),
  };
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
  const options = ref.options ?? {};
  if (!JSON.stringify(options).includes('${secret:')) return options;
  if (!secrets) throw new AdapterError(layer, ref.adapter, 'options reference ${secret:...} but no secrets adapter is configured');
  const walk = async (v: unknown): Promise<unknown> => {
    if (typeof v === 'string') {
      let out = v;
      for (const m of v.matchAll(SECRET_REF)) {
        const value = await secrets.get(m[1]!);
        if (value === undefined) throw new AdapterError(layer, ref.adapter, `secret "${m[1]}" not found`);
        out = out.replace(m[0], value);
      }
      return out;
    }
    if (Array.isArray(v)) return Promise.all(v.map(walk));
    if (isPlainObject(v)) return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k2, x]) => [k2, await walk(x)])));
    return v;
  };
  return walk(options);
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
