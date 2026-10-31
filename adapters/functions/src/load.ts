import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isToolDef, type ToolDef } from './tool.ts';

/** Tool definitions in a value: a definition, an array of them, or (one level down) an object holding them. */
function collect(value: unknown, depth = 0): ToolDef[] {
  if (Array.isArray(value)) return value.flatMap((v) => collect(v, depth + 1));
  if (isToolDef(value)) return [value];
  if (depth === 0 && value && typeof value === 'object') return Object.values(value).flatMap((v) => collect(v, 1));
  return [];
}

/** Import URL: a path (relative to `cwd`, also without `./` when the file exists) or a package specifier resolved from `cwd`. */
function urlOf(specifier: string, cwd: string): string {
  if (specifier.startsWith('.') || isAbsolute(specifier) || existsSync(resolve(cwd, specifier))) return pathToFileURL(resolve(cwd, specifier)).href;
  try {
    return pathToFileURL(createRequire(join(cwd, 'package.json')).resolve(specifier)).href;
  } catch {
    return specifier;
  }
}

/**
 * Tool definitions exported by a module: the `tools` export, the `default` export, and any other
 * exported value shaped like a definition. A tool listed more than once counts once.
 */
export async function loadTools(specifier: string, cwd: string): Promise<ToolDef[]> {
  const mod = await import(urlOf(specifier, cwd)) as Record<string, unknown>;
  const found = new Set<ToolDef>();
  for (const key of ['tools', 'default', ...Object.keys(mod)]) for (const d of collect(mod[key])) found.add(d);
  if (!found.size) throw new Error(`module "${specifier}" exports no tools`);
  return [...found];
}
