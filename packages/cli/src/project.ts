import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  AdapterRegistry, ConfigError, importAdapters, packageLoader, parseConfig, readRawConfig, type AnyAdapter, type ResolvedConfig, type StackConfig,
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
}

export function configPath(io: Io, flag?: string): string {
  const file = resolve(io.cwd, flag ?? CONFIG_FILE);
  if (!existsSync(file)) throw new UsageError(`no ${flag ?? CONFIG_FILE} in ${io.cwd} (run "agent-layers init" first, or pass --config)`);
  return file;
}

/** Loads the config with one profile applied and a registry that finds adapter packages and plugins. */
export async function openProject(io: Io, opts: { config?: string; profile?: string }): Promise<Project> {
  const file = configPath(io, opts.config);
  const dir = dirname(file);
  const raw = await readRawConfig(file);
  const env = { ...dotenv(dir), ...io.env };
  const config = parseConfig(await readFile(file, 'utf8'), { file, dir, env, ...(opts.profile ? { profile: opts.profile } : {}) });
  const registry = new AdapterRegistry({ loader: packageLoader(dir) });
  for (const plugin of config.plugins) {
    try {
      registry.register((await importAdapters(plugin, dir)).filter((a) => !registry.get(a.port, a.name)));
    } catch (err) {
      throw new ConfigError([`plugins: "${plugin}" failed to load: ${err instanceof Error ? err.message : String(err)}`], file);
    }
  }
  return { file, dir, raw, config, registry, env };
}

/** Values from `<dir>/.env`; the process environment wins over them. */
export function dotenv(dir: string): Record<string, string> {
  const file = join(dir, '.env');
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) as Record<string, string> : {};
}

/** Every adapter package installed where the project can resolve it (node_modules/@agent-layers/adapter-*). */
export async function installedAdapters(dir: string): Promise<AnyAdapter[]> {
  const names = new Set<string>();
  for (let d = resolve(dir); ; d = dirname(d)) {
    const scope = join(d, 'node_modules', '@agent-layers');
    if (existsSync(scope)) for (const n of readdirSync(scope)) if (n.startsWith('adapter-') && n !== 'adapter-template') names.add(n);
    if (dirname(d) === d) break;
  }
  const found: AnyAdapter[] = [];
  for (const n of [...names].sort()) {
    try { found.push(...await importAdapters(`@agent-layers/${n}`, dir)); } catch { /* a broken package is reported by check */ }
  }
  return found;
}
