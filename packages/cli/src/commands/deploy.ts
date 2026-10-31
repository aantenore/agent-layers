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

/** `deploy` / `up`: plans and starts the services through the deploy slot. */
export async function deploy(io: Io, args: DeployArgs): Promise<number> {
  const p = await openProject(io, args);
  const t = await target(p, io);
  const services = await servicesOf(p);
  const opts = { ...(p.config.profile ? { profile: p.config.profile } : {}), ...(args.dryRun ? { dryRun: true } : {}) };
  const plan = await t.plan(services, opts);
  io.out(`deploy ${p.config.profile ?? '(base)'} with ${p.config.layers.deploy!.adapter}: ${services.length} service(s)`);
  for (const s of plan.steps) io.out(`  ${s}`);
  for (const a of plan.artifacts) io.out(`  writes ${a.path}`);
  if (args.dryRun) return 0;
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
