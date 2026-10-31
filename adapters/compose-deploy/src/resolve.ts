import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Layer } from '@agent-layers/core';

export const COMPOSE_FILE = 'compose.yml';

/** Folder names older stacks used for a layer id. */
const ALIASES: Partial<Record<Layer, string>> = { tool: 'tools', guardrail: 'guardrails', cache: 'cache-router' };

export interface LayerFiles {
  root: string;
  files: Record<string, string>;
  searchDirs: readonly string[];
}

/** Path as given to Compose: relative to `root` when inside it. */
function shown(root: string, abs: string): string {
  const rel = relative(root, abs);
  return rel.startsWith('..') || isAbsolute(rel) ? abs : rel.split('\\').join('/');
}

/**
 * Reference compose file of a layer: an explicit `files` entry, then `<dir>/<layer>/compose.yml`,
 * then any `<dir>/*` folder named after the layer once a leading `l<digits>-` is dropped.
 */
export async function layerFile(layer: Layer, { root, files, searchDirs }: LayerFiles): Promise<string | undefined> {
  const explicit = files[layer];
  if (explicit) {
    const abs = resolve(root, explicit);
    return existsSync(abs) ? shown(root, abs) : undefined;
  }
  const names = [layer, ...(ALIASES[layer] ? [ALIASES[layer]!] : [])];
  for (const dir of searchDirs) {
    for (const n of names) {
      const abs = resolve(root, dir, n, COMPOSE_FILE);
      if (existsSync(abs)) return shown(root, abs);
    }
  }
  for (const dir of searchDirs) {
    const entries = await readdir(resolve(root, dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!names.includes(e.name.replace(/^l\d+-/, ''))) continue;
      const abs = join(resolve(root, dir), e.name, COMPOSE_FILE);
      if (existsSync(abs)) return shown(root, abs);
    }
  }
  return undefined;
}
