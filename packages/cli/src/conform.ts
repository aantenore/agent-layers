import { conformance, NEEDS_CALLER, testContext, type ConformanceReport } from '@agent-layers/conformance';
import { agentSpec, CHECK_LIMITS, compose, configuredAdapters, errorMessage, limitValue, type ConfiguredAdapter, type Caller, type CredentialPort, type Layer, type PortBase, type Stack } from '@agent-layers/core';
import type { Project } from './project.ts';

export interface AdapterReport {
  entry: ConfiguredAdapter;
  /** `skip`: nothing reached the adapter live (a probe it needs is missing, or its service does not answer on a tier below production). */
  status: 'ok' | 'fail' | 'skip';
  detail: string[];
  /** Checks the suite skipped, each with its reason (a fixture it needs, an optional feature the adapter lacks). */
  skipped: string[];
}

const NOT_EXERCISED = new Set(['ChannelPort', 'TriggerPort']);

/**
 * Composes the stack and runs each configured adapter's conformance suite on the live instance. With `token`, the
 * caller is verified through the identity slot first and the probes that act for a caller (credentials) use it.
 * The probe stack has no telemetry unless `verbose`.
 */
export async function conformAll(p: Project, opts: { layer?: Layer; env: Record<string, string | undefined>; token?: string; verbose?: boolean }): Promise<{ reports: AdapterReport[]; error?: string; callerError?: string }> {
  let stack: Stack;
  try {
    // Probe runs are not real runs: without `verbose` they reach no configured telemetry (console lines, a collector).
    const { telemetry: _telemetry, ...quiet } = p.config.layers;
    stack = await compose(opts.verbose ? p.config : { ...p.config, layers: quiet }, { registry: p.registry, env: opts.env });
  } catch (err) {
    return { reports: [], error: errorMessage(err) };
  }
  const reports: AdapterReport[] = [];
  const seen = new Map<string, number>();
  let caller: Caller | undefined;
  let callerError: string | undefined;
  try {
    if (opts.token && stack.ports.identity) {
      // The adapter's message can name the credential: only the outcome is reported.
      caller = await stack.verify(opts.token).catch(() => { callerError = 'the caller token did not verify through the identity adapter'; return undefined; });
    }
    const limits = p.config.limits.check ?? {};
    const audience = await probeAudience(stack, caller, limitValue(CHECK_LIMITS.listToolsTimeoutMs, limits.listToolsTimeoutMs));
    for (const entry of configuredAdapters(p.config.layers)) {
      const index = seen.get(entry.slot) ?? 0;
      seen.set(entry.slot, index + 1);
      if (opts.layer && entry.layer !== opts.layer) continue;
      const desc = p.registry.get(entry.port, entry.ref.adapter);
      if (desc?.direction === 'inbound' || NOT_EXERCISED.has(entry.port)) {
        reports.push({ entry, status: 'skip', detail: ['inbound: exercised by its own tests, not by check'], skipped: [] });
        continue;
      }
      if (entry.port === 'TelemetryPort') {
        // Probe spans would land in the configured backend or terminal as if they were real runs.
        reports.push({ entry, status: 'skip', detail: ['telemetry: not probed live, so no test records reach the backend; covered by the adapter\'s own conformance tests'], skipped: [] });
        continue;
      }
      const instance = instanceOf(stack, entry, index);
      // An adapter with a remote service says whether it answers before any probe runs against it: a service that does
      // not answer fails the production tier and is a skip below it, never an ok.
      const unreachable = await readinessProbe(instance, limitValue(CHECK_LIMITS.timeoutMs, limits.timeoutMs));
      if (unreachable) {
        reports.push({ entry, status: p.config.tier === 'production' ? 'fail' : 'skip', detail: [unreachable], skipped: [] });
        continue;
      }
      if (entry.port === 'CredentialPort' && (instance as CredentialPort).requiresCaller && !caller?.credential) {
        reports.push({ entry, status: 'skip', detail: [`on behalf of a caller only: ${NEEDS_CALLER}`], skipped: [] });
        continue;
      }
      // A real provider issues tokens only for audiences it knows: probing with a made-up one fails a sound setup.
      if (entry.port === 'CredentialPort' && !audience) {
        reports.push({ entry, status: 'skip', detail: ['no tool or adapter declares an audience, so this stack exchanges no tokens yet'], skipped: [] });
        continue;
      }
      const firstAgent = stack.agents().length ? await agentSpec(p.config, stack.agents()[0]!) : undefined;
      // The model probe asks for the model the agents ask for, so a gateway that serves only named models answers it.
      const fixtures = entry.port === 'RuntimePort' && firstAgent
        ? { stack, agent: firstAgent, input: 'hello' }
        : entry.port === 'ModelPort' && firstAgent ? { model: firstAgent.model }
        : entry.port === 'CredentialPort' ? { ...(audience ? { audience } : {}), ...(caller ? { caller } : {}) }
          : entry.port === 'IdentityPort' && caller ? { valid: opts.token }
            : undefined;
      const r: ConformanceReport = await conformance(entry.port, instance as never, fixtures, limits);
      // ok only when a probe reached the adapter: a suite that ran its rejections alone (an identity adapter without a
      // caller token) exercised nothing, and says so through what it skipped.
      reports.push({ entry, status: !r.ok ? 'fail' : r.attempts ? 'ok' : 'skip', detail: r.failures, skipped: r.skipped });
    }
  } finally {
    await stack.close();
  }
  return { reports, ...(callerError ? { callerError } : {}) };
}

/**
 * Runs the readiness probe of an instance that has one, under `timeoutMs`: the failure message (the host and the cause,
 * from the adapter), or undefined when it passed or the instance has no probe.
 */
async function readinessProbe(instance: unknown, timeoutMs: number): Promise<string | undefined> {
  const probe = (instance as PortBase | null | undefined)?.probe;
  if (typeof probe !== 'function') return undefined;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException(`readiness probe timed out after ${timeoutMs} ms (raise ${CHECK_LIMITS.timeoutMs.path})`, 'TimeoutError')), timeoutMs);
  try {
    await Promise.race([
      probe.call(instance, { signal: ac.signal }),
      new Promise<never>((_, reject) => ac.signal.addEventListener('abort', () => reject(ac.signal.reason), { once: true })),
    ]);
    return undefined;
  } catch (err) {
    return errorMessage(err);
  } finally {
    clearTimeout(timer);
    if (!ac.signal.aborted) ac.abort();
  }
}

/**
 * Audience for the credentials probe: one a real provider issues tokens for. The first `audience` a tool declares,
 * else the first `auth.audience` in the options of a configured adapter (remote runtimes, MCP servers); none otherwise.
 */
async function probeAudience(stack: Stack, caller: Caller | undefined, timeoutMs: number): Promise<string | undefined> {
  const ctx = testContext(caller ? { caller } : {});
  for (const port of Object.values(stack.ports.tools)) {
    const specs = await Promise.race([port.listTools(ctx), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref())]).catch(() => []);
    const found = specs.find((t) => typeof t.audience === 'string' && t.audience);
    if (found) return found.audience;
  }
  for (const e of configuredAdapters(stack.config.layers)) {
    const auth = (e.ref.options as { auth?: { audience?: unknown } } | undefined)?.auth;
    if (typeof auth?.audience === 'string' && auth.audience) return auth.audience;
  }
  return undefined;
}

function instanceOf(stack: Stack, e: ConfiguredAdapter, index: number): unknown {
  const v = (stack.ports as unknown as Record<string, unknown>)[e.slot];
  if (Array.isArray(v)) return v[index];
  if (v && typeof v === 'object' && !('adapter' in v) && e.key in (v as object) && ['knowledge', 'ingestion', 'tools'].includes(e.slot)) return (v as Record<string, unknown>)[e.key];
  return v;
}
