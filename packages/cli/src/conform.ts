import { conformance, NEEDS_CALLER, testContext, type ConformanceReport } from '@agent-layers/conformance';
import { agentSpec, CHECK_LIMITS, compose, configuredAdapters, errorMessage, limitValue, type ConfiguredAdapter, type Caller, type CredentialPort, type Layer, type Stack } from '@agent-layers/core';
import type { Project } from './project.ts';

export interface AdapterReport { entry: ConfiguredAdapter; status: 'ok' | 'fail' | 'skip'; detail: string[] }

const NOT_EXERCISED = new Set(['ChannelPort', 'TriggerPort']);

/**
 * Composes the stack and runs each configured adapter's conformance suite on the live instance. With `token`, the
 * caller is verified through the identity slot first and the probes that act for a caller (credentials) use it.
 */
export async function conformAll(p: Project, opts: { layer?: Layer; env: Record<string, string | undefined>; token?: string }): Promise<{ reports: AdapterReport[]; error?: string; callerError?: string }> {
  let stack: Stack;
  try {
    stack = await compose(p.config, { registry: p.registry, env: opts.env });
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
        reports.push({ entry, status: 'skip', detail: ['inbound: exercised by its own tests, not by check'] });
        continue;
      }
      if (entry.port === 'TelemetryPort') {
        // Probe spans would land in the configured backend or terminal as if they were real runs.
        reports.push({ entry, status: 'skip', detail: ['telemetry: not probed live, so no test records reach the backend; covered by the adapter\'s own conformance tests'] });
        continue;
      }
      const instance = instanceOf(stack, entry, index);
      if (entry.port === 'CredentialPort' && (instance as CredentialPort).requiresCaller && !caller?.credential) {
        reports.push({ entry, status: 'skip', detail: [`on behalf of a caller only: ${NEEDS_CALLER}`] });
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
      reports.push({ entry, status: r.ok ? 'ok' : 'fail', detail: r.failures });
    }
  } finally {
    await stack.close();
  }
  return { reports, ...(callerError ? { callerError } : {}) };
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
