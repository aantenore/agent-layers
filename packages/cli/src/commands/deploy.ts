import { configuredAdapters, MissingLayerError, noopTelemetry, type DeployPort, type ServiceSpec } from '@agent-layers/core';
import type { Io } from '../io.ts';
import { openProject, type Project } from '../project.ts';

/** Services a profile needs: `layers.services`, plus what adapters declare, else one per layer in use. */
export async function servicesOf(p: Project): Promise<ServiceSpec[]> {
  const explicit = (p.config.layers.services ?? []) as unknown as ServiceSpec[];
  const declared: ServiceSpec[] = [];
  const used = new Set<string>();
  for (const a of configuredAdapters(p.config.layers)) {
    if (a.slot === 'deploy') continue;
    used.add(a.layer);
    const d = await p.registry.resolve(a.port, a.ref.adapter);
    declared.push(...(d?.services?.(a.ref.options ?? {}) ?? []));
  }
  if (explicit.length || declared.length) return [...explicit, ...declared];
  return [...used].map((layer) => ({ name: layer, layer: layer as ServiceSpec['layer'] & string }));
}

async function target(p: Project, io: Io): Promise<DeployPort> {
  const ref = p.config.layers.deploy;
  if (!ref) throw new MissingLayerError('infra', 'deploy adapter (layers.deploy)');
  return p.registry.create('DeployPort', ref.adapter, ref.options ?? {}, { name: ref.adapter, env: p.env, cwd: p.dir, telemetry: noopTelemetry });
}

export interface DeployArgs { config?: string; profile?: string; dryRun?: boolean }

/** A plan step that does something; the others are comments (`# ...`) on what the target leaves out. */
const isCommand = (step: string) => !step.trimStart().startsWith('#');

/**
 * `deploy` / `up`: plans and starts the services through the deploy slot. A dry run needs no secret: the variables
 * the profile would need and are not set are listed instead.
 */
export async function deploy(io: Io, args: DeployArgs): Promise<number> {
  const p = await openProject(io, { ...args, ...(args.dryRun ? { deferEnv: true } : {}) });
  const t = await target(p, io);
  const services = await servicesOf(p);
  const opts = { ...(p.config.profile ? { profile: p.config.profile } : {}), ...(args.dryRun ? { dryRun: true } : {}) };
  const plan = await t.plan(services, opts);
  const steps = plan.steps.filter(isCommand).length;
  const profile = p.config.profile ?? '(base)';
  const adapter = p.config.layers.deploy!.adapter;
  io.out(steps || plan.artifacts.length
    ? `deploy ${profile} with ${adapter}: ${steps} step(s) for ${services.length} service(s)`
    : `nothing to deploy for profile ${profile}: ${adapter} has nothing to start for any of the ${services.length} service(s)`);
  for (const s of plan.steps) io.out(`  ${s}`);
  for (const a of plan.artifacts) io.out(`  writes ${a.path}`);
  if (!steps && !plan.artifacts.length) io.out('Give the layers a deployment the adapter reads (see the notes above), or list services with an image in layers.services.');
  if (p.missingEnv.length) io.out(`would need: ${p.missingEnv.join(', ')} (not set)`);
  if (args.dryRun) return 0;
  if (!steps && !plan.artifacts.length) return 0;
  const endpoints = await t.up(services, opts);
  for (const e of endpoints) io.out(`  ${e.service.padEnd(14)} ${e.url}`);
  await t.close?.();
  return 0;
}

export async function down(io: Io, args: DeployArgs): Promise<number> {
  const p = await openProject(io, args);
  const t = await target(p, io);
  await t.down(await servicesOf(p), { ...(p.config.profile ? { profile: p.config.profile } : {}), ...(args.dryRun ? { dryRun: true } : {}) });
  io.out('stopped');
  await t.close?.();
  return 0;
}
