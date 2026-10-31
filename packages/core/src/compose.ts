import { AdapterRegistry, importAdapters, packageLoader, type AnyAdapter } from './adapter.ts';
import { agentSpec, configuredAdapters, type AdapterRef, type ResolvedConfig } from './config.ts';
import { AdapterError, AgentLayersError, errorMessage, GuardrailBlocked, MissingLayerError } from './errors.ts';
import { PORTS } from './ports/catalog.ts';
import type { CallContext } from './ports/base.ts';
import type { ChannelHandle } from './ports/channel.ts';
import type { GuardPort } from './ports/guard.ts';
import type { ModelPort } from './ports/model.ts';
import type { AgentSpec, RunInput, RunnableAgent, RunResult } from './ports/runtime.ts';
import type { TelemetryPort } from './ports/telemetry.ts';
import type { ToolPort } from './ports/tool.ts';
import { governedTools } from './pipeline/governed-tools.ts';
import { guardedModel } from './pipeline/guarded-model.ts';
import { knowledgeInjector } from './pipeline/knowledge.ts';
import type { Stack, StackPorts } from './stack.ts';
import { createTelemetry } from './telemetry.ts';
import { filterTools, knowledgeTools } from './tools.ts';
import { isPlainObject, newRunId } from './util.ts';

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

  const make = async (e: (typeof entries)[number]) => {
    const options = await resolveSecrets(e.ref, ports.secrets, e.layer);
    const instance = await registry.create(e.port, e.ref.adapter, options, { name: e.key, env, cwd: config.dir, telemetry, stack: lazyStack });
    created.push(instance);
    return instance;
  };

  try {
    // Telemetry and secrets first: every other adapter may use them.
    for (const e of entries.filter((x) => x.slot === 'telemetry')) ports.telemetry.push(await make(e) as never);
    telemetry = createTelemetry([...(opts.telemetry ?? []), ...ports.telemetry]);
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
  if (mode === 'tools' && Object.keys(ports.knowledge).length) toolSources.knowledge = knowledgeTools(ports.knowledge);
  const tools = governedTools(toolSources, {
    policy: config.policy, guards: ports.guardrails, telemetry,
    ...(ports.authorization ? { authorization: ports.authorization } : {}),
    ...(ports.approval ? { approval: ports.approval } : {}),
    ...(ports.credentials ? { credentials: ports.credentials } : {}),
    ...(config.pipeline.approvalTimeoutMs ? { approvalTimeoutMs: config.pipeline.approvalTimeoutMs } : {}),
  });

  const models = new Map<string, ModelPort>();
  const modelWith = (sourceNames: readonly string[]): ModelPort => {
    const key = [...sourceNames].sort().join(',');
    let m = models.get(key);
    if (m) return m;
    const base = ports.model ?? missingModel();
    const sources = Object.fromEntries(sourceNames.filter((n) => ports.knowledge[n]).map((n) => [n, ports.knowledge[n]!]));
    const injected = (mode === 'system' || mode === 'user') && Object.keys(sources).length
      ? knowledgeInjector(sources, { mode, telemetry, ...(k.k ? { k: k.k } : {}), ...(k.maxChars ? { maxChars: k.maxChars } : {}) })(base)
      : base;
    m = guardedModel(injected, {
      guards: ports.guardrails, telemetry,
      ...(ports.cache ? { cache: ports.cache } : {}), ...(ports.router ? { router: ports.router } : {}),
      ...(config.pipeline.cacheTtlMs ? { cacheTtlMs: config.pipeline.cacheTtlMs } : {}),
    });
    models.set(key, m);
    return m;
  };

  const bound = new Map<string, Promise<RunnableAgent>>();
  const context = (init: Partial<CallContext> & { agent: string }): CallContext => ({ runId: newRunId(), telemetry, ...init });

  const stack: Stack = {
    config, registry, ports, telemetry, tools,
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
        p = bindAgent(stack, name, context);
        bound.set(name, p);
        p.catch(() => bound.delete(name));
      }
      return p;
    },
    host(opts = {}) {
      const as = (ctx: Partial<CallContext> | undefined): Partial<CallContext> | undefined =>
        opts.identity && !ctx?.identity ? { ...ctx, identity: opts.identity } : ctx;
      return {
        agents: () => stack.agents(),
        run: async (agent, input, ctx) => (await stack.agent(agent)).run(input, as(ctx)),
        ...(ports.identity ? { verify: (c: string) => stack.verify(c) } : {}),
      };
    },
    async start(opts = {}) {
      const host = stack.host(opts);
      const handles: ChannelHandle[] = [];
      for (const c of ports.channels) handles.push(await c.serve(host));
      for (const t of ports.triggers) {
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

async function bindAgent(stack: Stack, name: string, context: Stack['context']): Promise<RunnableAgent> {
  const spec = await agentSpec(stack.config, name);
  const runtime = stack.ports.runtime;
  if (!runtime) throw new MissingLayerError('harness', 'runtime adapter');
  const inner = await runtime.bind(stack, spec);
  const state = stack.ports.state;
  return {
    name,
    async run(input: RunInput, init = {}) {
      const ctx = context({ ...init, agent: name });
      return stack.telemetry.span('invoke_agent', { 'agent.layer': 'harness', 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': name, 'run.id': ctx.runId }, async (span) => {
        let result: RunResult;
        try {
          result = await inner.run(input, ctx);
        } catch (err) {
          if (!(err instanceof GuardrailBlocked)) throw err;
          result = { runId: ctx.runId, status: 'stopped', output: '', reason: err.message };
        }
        span.setAttributes({ 'run.status': String(result.status), ...(result.reason ? { 'run.reason': result.reason } : {}) });
        if (state && ctx.sessionId && result.events?.length) await state.append(ctx.sessionId, result.events);
        return result;
      });
    },
    ...(inner.stream ? { stream: (input: RunInput, init = {}) => inner.stream!(input, context({ ...init, agent: name })) } : {}),
  };
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
