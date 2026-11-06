import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ADAPTERS_PACKAGE, AdapterRegistry, ConfigError, importAdapters, packageLoader, parseConfig, readRawConfig, type AnyAdapter, type ResolvedConfig, type StackConfig,
} from '@agent-layers/core';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { UsageError, type Io } from './io.ts';

export const CONFIG_FILE = 'agent-layers.json';

export interface Project {
  file: string;
  dir: string;
  raw: StackConfig;
  config: ResolvedConfig;
  registry: AdapterRegistry;
  /** Process environment over the project's .env file. */
  env: Record<string, string | undefined>;
  /** With `deferEnv`: the variables the profile needs that are not set (their references stay in `config`). */
  missingEnv: string[];
}

export function configPath(io: Io, flag?: string): string {
  const file = resolve(io.cwd, flag ?? CONFIG_FILE);
  if (!existsSync(file)) throw new UsageError(`no ${flag ?? CONFIG_FILE} in ${io.cwd} (run "agent-layers init" first, or pass --config)`);
  return file;
}

/**
 * Loads the config with one profile applied and a registry that finds the adapters of @agent-layers/adapters and plugins.
 * With `deferEnv` (commands that only describe a profile), a variable that is not set is listed in `missingEnv`
 * instead of failing.
 */
export async function openProject(io: Io, opts: { config?: string; profile?: string; deferEnv?: boolean }): Promise<Project> {
  const file = configPath(io, opts.config);
  const dir = dirname(file);
  const raw = await readRawConfig(file);
  const env = { ...dotenv(dir), ...io.env };
  const deferred = opts.deferEnv ? new Set<string>() : undefined;
  const config = parseConfig(await readFile(file, 'utf8'), { file, dir, env, ...(opts.profile ? { profile: opts.profile } : {}), ...(deferred ? { deferredEnv: deferred } : {}) });
  const registry = new AdapterRegistry({ loader: packageLoader(dir) });
  for (const plugin of config.plugins) {
    try {
      registry.register((await importAdapters(plugin, dir)).filter((a) => !registry.get(a.port, a.name)));
    } catch (err) {
      throw new ConfigError([`plugins: "${plugin}" failed to load: ${err instanceof Error ? err.message : String(err)}`], file);
    }
  }
  return { file, dir, raw, config, registry, env, missingEnv: [...(deferred ?? [])].sort() };
}

/** Values from `<dir>/.env`; the process environment wins over them. */
export function dotenv(dir: string): Record<string, string> {
  const file = join(dir, '.env');
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) as Record<string, string> : {};
}

/** Every adapter installed where the project resolves it: the subpath exports of the nearest `@agent-layers/adapters`. */
export async function installedAdapters(dir: string): Promise<AnyAdapter[]> {
  const specifiers: string[] = [];
  for (let d = resolve(dir); ; d = dirname(d)) {
    const manifest = join(d, 'node_modules', ADAPTERS_PACKAGE, 'package.json');
    if (existsSync(manifest)) {
      const { exports = {} } = JSON.parse(readFileSync(manifest, 'utf8')) as { exports?: Record<string, unknown> };
      for (const key of Object.keys(exports).sort()) if (/^\.\/[a-z0-9][a-z0-9-]*$/.test(key)) specifiers.push(`${ADAPTERS_PACKAGE}${key.slice(1)}`);
      break;
    }
    if (dirname(d) === d) break;
  }
  const found: AnyAdapter[] = [];
  for (const specifier of specifiers) {
    try { found.push(...await importAdapters(specifier, dir)); } catch { /* a broken adapter is reported by check */ }
  }
  return found;
}
