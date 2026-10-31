import { configuredAdapters, LAYERS, PLANES, portsOf, type AnyAdapter, type ResolvedConfig } from '@agent-layers/core';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Io } from '../io.ts';
import { CONFIG_FILE, installedAdapters, openProject } from '../project.ts';

/** Prints the eleven layers by plane: ports and versions, the adapter each slot uses, installed adapters. */
export async function layers(io: Io, args: { config?: string; profile?: string }): Promise<number> {
  const hasConfig = existsSync(resolve(io.cwd, args.config ?? CONFIG_FILE));
  const project = hasConfig ? await openProject(io, args) : undefined;
  const installed = await installedAdapters(project?.dir ?? io.cwd);
  if (project) io.out(`profile ${project.config.profile ?? '(base)'} · tier ${project.config.tier}`);
  for (const plane of PLANES) {
    io.out(`\n${plane.name}`);
    for (const l of LAYERS.filter((x) => x.plane === plane.plane)) {
      io.out(`  L${l.number} ${l.layer} — ${l.name}`);
      for (const port of portsOf(l.layer)) {
        const used = project ? usedBy(project.config, port.port) : '';
        io.out(`    ${`${port.port} ${port.version}`.padEnd(24)} ${used ? `uses ${used}` : '-'}`);
        const list = installed.filter((a) => a.port === port.port);
        const std = list.filter((a) => a.maps.standard).map(label);
        const nat = list.filter((a) => !a.maps.standard).map(label);
        if (std.length) io.out(`      standard: ${std.join(', ')}`);
        if (nat.length) io.out(`      native:   ${nat.join(', ')}`);
      }
    }
  }
  return 0;
}

const label = (a: AnyAdapter) => `${a.name}${a.tiers.includes('production') ? '' : ' (prototype)'}`;

function usedBy(config: ResolvedConfig, port: string): string {
  return configuredAdapters(config.layers).filter((a) => a.port === port)
    .map((a) => (a.key === a.ref.adapter ? a.ref.adapter : `${a.key}=${a.ref.adapter}`)).join(', ');
}
