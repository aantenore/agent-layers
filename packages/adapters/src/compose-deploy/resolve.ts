import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Layer } from '@agent-layers/core';

export const COMPOSE_FILE = 'compose.yml';

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

/** Reference compose file of a layer: an explicit `files` entry, then `<dir>/<layer id>/compose.yml`. */
export async function layerFile(layer: Layer, { root, files, searchDirs }: LayerFiles): Promise<string | undefined> {
  const explicit = files[layer];
  if (explicit) {
    const abs = resolve(root, explicit);
    return existsSync(abs) ? shown(root, abs) : undefined;
  }
  for (const dir of searchDirs) {
    const abs = resolve(root, dir, layer, COMPOSE_FILE);
    if (existsSync(abs)) return shown(root, abs);
  }
  return undefined;
}
