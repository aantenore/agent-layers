import { AdapterRegistry, compatibleVersion, extDeclarationProblems, extWriteProblems, mappingDefaultsProblems, noopTelemetry, PORTS, type AdapterContext, type AnyAdapter, type PortName, type PortTypes } from '@agent-layers/core';
import { Checks, type CheckLimits, type ExtDeclarationCheck } from './check.ts';
import { checkIngestion, checkKnowledge, checkMemory, checkRuntime, checkState, checkTools } from './suites/agent.ts';
import { checkApproval, checkAuthorization, checkCredentials, checkGuard, checkIdentity } from './suites/control.ts';
import { checkChannel, checkDeploy, checkSecrets, checkTrigger } from './suites/edge.ts';
import { checkEvaluator, checkFeedback, checkTelemetry } from './suites/insight.ts';
import { checkCache, checkModel, checkRouter } from './suites/model.ts';

export { Checks, testContext, type CheckLimits, type ExtDeclarationCheck } from './check.ts';
export { roundTrip, type RoundTripOptions } from './round-trip.ts';
export { conforms, schema } from './schemas.ts';
export { NEEDS_CALLER, sampleQuestion } from './suites/control.ts';
export type { ModelFixtures, RouterFixtures, CacheFixtures } from './suites/model.ts';
export type { KnowledgeFixtures, RuntimeFixtures, ToolFixtures } from './suites/agent.ts';
export type { AuthorizationFixtures, CredentialFixtures, GuardFixtures, GuardSample, IdentityFixtures } from './suites/control.ts';
export { inboundFetch } from './suites/edge.ts';
export type { ChannelFixtures, DeployFixtures, TriggerFixtures } from './suites/edge.ts';
export type { EvaluatorFixtures, TelemetryFixtures } from './suites/insight.ts';

type Suite = (impl: any, fixtures: any, c: Checks) => Promise<Checks>;

const SUITES: Record<PortName, Suite> = {
  DeployPort: checkDeploy, SecretPort: checkSecrets, ModelPort: checkModel, RouterPort: checkRouter, CachePort: checkCache,
  RuntimePort: checkRuntime, StatePort: checkState, KnowledgePort: checkKnowledge, MemoryPort: checkMemory,
  IngestionPort: checkIngestion, ToolPort: checkTools, IdentityPort: checkIdentity, CredentialPort: checkCredentials,
  AuthorizationPort: checkAuthorization, ApprovalPort: checkApproval, GuardPort: checkGuard, ChannelPort: checkChannel,
  TriggerPort: checkTrigger, TelemetryPort: checkTelemetry, EvaluatorPort: checkEvaluator, FeedbackPort: checkFeedback,
};

export interface ConformanceReport {
  port: PortName;
  adapter?: string;
  ok: boolean;
  failures: string[];
  skipped: string[];
}

/**
 * Runs the conformance suite of a port against an instance. Never throws; failures are returned. Without `ext` the
 * `ext` keys the instance writes are only checked for namespacing and the reserved `sdk` namespace; with the adapter's
 * declaration they must also be its own and declared.
 */
export async function conformance<P extends PortName>(port: P, impl: PortTypes[P], fixtures?: unknown, limits?: CheckLimits, ext?: ExtDeclarationCheck): Promise<ConformanceReport> {
  const c = new Checks(limits, ext);
  const suite = SUITES[port];
  if (!suite) c.expect(false, `no conformance suite for ${String(port)}`);
  else if (!impl || typeof impl !== 'object') c.expect(false, `${port}: instance must be an object`);
  else await suite(impl, fixtures ?? {}, c).catch((err: unknown) => c.expect(false, `suite crashed: ${String(err)}`));
  return { port, ok: c.failures.length === 0, failures: c.failures, skipped: c.skipped };
}

/** The declaration conformance checks written `ext` keys against: the adapter's name and its descriptor's `ext` block. */
const declarationOf = (d: Pick<AnyAdapter, 'name' | 'ext'>): ExtDeclarationCheck => ({ adapter: d.name, namespace: d.ext?.namespace, produces: d.ext?.produces ?? [] });

/**
 * Problems of the `ext` keys inside a value an adapter produced (a reply, a passage, a caller, ...): not namespaced, in
 * the core's `sdk` namespace, in another adapter's namespace, or not listed in the descriptor's `ext.produces`.
 */
export const checkExt = (d: Pick<AnyAdapter, 'name' | 'ext'>, value: unknown): string[] => extWriteProblems(value, declarationOf(d));

/** Descriptor problems: what every published adapter must declare. */
export function checkDescriptor(d: AnyAdapter): string[] {
  const out: string[] = [];
  const info = PORTS[d.port];
  if (!info) return [`unknown port ${String(d.port)}`];
  if (d.layer !== info.layer) out.push(`layer ${d.layer} does not match ${d.port} (${info.layer})`);
  if (!d.maps?.standard && !d.maps?.technology) out.push('maps must name a standard or a technology');
  if (!compatibleVersion(d.portVersion, info.version)) out.push(`portVersion ${d.portVersion} is not compatible with ${d.port} ${info.version}`);
  if (!d.optionsSchema) out.push('optionsSchema is missing');
  out.push(...extDeclarationProblems(d.ext, d.name), ...mappingDefaultsProblems(d.mappingDefaults, d.ext?.namespace ?? d.name));
  if (!d.tiers?.length) out.push('tiers is empty');
  if (d.direction !== 'inbound' && d.direction !== 'outbound') out.push('direction must be inbound or outbound');
  // Every top-level limit is an option the schema describes, with the limit's default.
  const props = (d.optionsSchema?.properties ?? {}) as Record<string, { default?: unknown }>;
  for (const l of Object.values(d.limits ?? {})) {
    const key = /^options\.(\w+)$/.exec(l.path)?.[1];
    if (!key) continue;
    if (!props[key]) out.push(`limit ${l.path} is not in optionsSchema`);
    else if (l.default !== null && props[key].default !== l.default) out.push(`optionsSchema.${key}.default must be ${JSON.stringify(l.default)} (the limit default)`);
  }
  return out;
}

export interface CheckAdapterOptions {
  options?: unknown;
  fixtures?: unknown;
  ctx?: Partial<AdapterContext>;
  /** Probe time limits (default `limits.check` defaults). */
  limits?: CheckLimits;
}

/** Checks a descriptor, creates an instance from `options` and runs its port's suite. Closes the instance. */
export async function checkAdapter(d: AnyAdapter, opts: CheckAdapterOptions = {}): Promise<ConformanceReport> {
  const failures = checkDescriptor(d);
  let instance: PortTypes[PortName] | undefined;
  try {
    instance = await new AdapterRegistry().register(d).create(d.port, d.name, opts.options ?? {}, {
      name: d.name, env: process.env, cwd: process.cwd(), telemetry: noopTelemetry, ...opts.ctx,
    });
  } catch (err) {
    failures.push(`create: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!instance) return { port: d.port, adapter: d.name, ok: false, failures, skipped: [] };
  const report = await conformance(d.port, instance as never, opts.fixtures, opts.limits, declarationOf(d));
  await instance.close?.().catch(() => {});
  const all = [...failures, ...report.failures];
  return { ...report, adapter: d.name, ok: all.length === 0, failures: all };
}
