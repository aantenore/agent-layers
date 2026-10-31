import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AdapterError, errorMessage } from './errors.ts';
import type { Layer } from './layers.ts';
import { compatibleVersion, isPortName, PORTS, type PortName, type PortTypes } from './ports/catalog.ts';
import type { ServiceSpec } from './ports/deploy.ts';
import type { TelemetryPort } from './ports/telemetry.ts';
import { validate, type JsonSchema } from './schema.ts';

/** Inbound: exposes a stack port through a standard (an HTTP API, a server). outbound: consumes a standard or technology as a port. */
export type Direction = 'inbound' | 'outbound';
/** Prototype: for laptops and demos. production: backed by a real system. */
export type Tier = 'prototype' | 'production';
export const TIERS: readonly Tier[] = ['prototype', 'production'];

/** What an adapter maps onto its port: an open standard, or a technology's native API. */
export interface AdapterMaps { standard?: string; technology?: string }

export interface AdapterContext {
  /** Instance name: the config key for keyed slots (knowledge, tools), otherwise the adapter name. */
  name: string;
  env: Record<string, string | undefined>;
  /** Directory the stack config lives in; relative paths in options resolve against it. */
  cwd: string;
  telemetry: TelemetryPort;
}

export interface AdapterDescriptor<P extends PortName = PortName, O = any> {
  layer: Layer;
  port: P;
  name: string;
  direction: Direction;
  maps: AdapterMaps;
  /** Port version the adapter implements. */
  portVersion: string;
  tiers: readonly Tier[];
  description?: string;
  optionsSchema?: JsonSchema;
  /** Reference services this adapter needs running (started through the DeployPort by `up` / `dev`). */
  services?(options: O): ServiceSpec[];
  create(options: O, ctx: AdapterContext): PortTypes[P] | Promise<PortTypes[P]>;
}

export type AnyAdapter = AdapterDescriptor<PortName, any>;

/** Declares an adapter. Checks that the descriptor is consistent with the port catalog. */
export function defineAdapter<P extends PortName, O = Record<string, unknown>>(d: AdapterDescriptor<P, O>): AdapterDescriptor<P, O> {
  const id = d?.name ?? '?';
  if (!isPortName(d?.port)) throw new TypeError(`adapter "${id}": unknown port "${String(d?.port)}"`);
  const info = PORTS[d.port];
  const fail = (msg: string): never => { throw new AdapterError(info.layer, id, msg); };
  if (!d.name || !/^[a-z0-9][a-z0-9-]*$/.test(d.name)) fail('name must be lowercase kebab-case');
  if (d.layer !== info.layer) fail(`${d.port} belongs to layer ${info.layer}, not ${d.layer}`);
  if (d.direction !== 'inbound' && d.direction !== 'outbound') fail('direction must be inbound or outbound');
  if (!d.maps || (!d.maps.standard && !d.maps.technology)) fail('maps must name a standard or a technology');
  if (!compatibleVersion(d.portVersion, info.version)) fail(`implements ${d.port} ${d.portVersion}, core has ${info.version}`);
  if (!Array.isArray(d.tiers) || d.tiers.length === 0 || d.tiers.some((t) => !TIERS.includes(t))) fail(`tiers must be a non-empty subset of ${TIERS.join(', ')}`);
  if (typeof d.create !== 'function') fail('create must be a function');
  return Object.freeze({ ...d, tiers: Object.freeze([...d.tiers]) });
}

export function isAdapterDescriptor(value: unknown): value is AnyAdapter {
  const d = value as AnyAdapter | undefined;
  return !!d && typeof d === 'object' && isPortName(d.port) && typeof d.name === 'string' && typeof d.create === 'function';
}

/** Loads adapter descriptors that are not registered yet, by adapter name. */
export type AdapterLoader = (port: PortName, name: string) => Promise<AnyAdapter[] | undefined>;

export interface RegistryOptions { loader?: AdapterLoader }

/** Adapters available to a stack, keyed by port and name. */
export class AdapterRegistry {
  #adapters = new Map<string, AnyAdapter>();
  #loader: AdapterLoader | undefined;

  constructor(opts: RegistryOptions = {}) {
    this.#loader = opts.loader;
  }

  register(adapters: AnyAdapter | readonly AnyAdapter[], opts: { replace?: boolean } = {}): this {
    for (const a of Array.isArray(adapters) ? adapters : [adapters as AnyAdapter]) {
      const key = `${a.port}/${a.name}`;
      if (this.#adapters.has(key) && !opts.replace) throw new AdapterError(a.layer, a.name, `already registered for ${a.port}`);
      this.#adapters.set(key, a);
    }
    return this;
  }

  get<P extends PortName>(port: P, name: string): AdapterDescriptor<P> | undefined {
    return this.#adapters.get(`${port}/${name}`) as AdapterDescriptor<P> | undefined;
  }

  /** Like `get`, but asks the loader for adapters that are not registered. */
  async resolve<P extends PortName>(port: P, name: string): Promise<AdapterDescriptor<P> | undefined> {
    const found = this.get(port, name);
    if (found || !this.#loader) return found;
    let loaded: AnyAdapter[] | undefined;
    try {
      loaded = await this.#loader(port, name);
    } catch (err) {
      throw new AdapterError(PORTS[port].layer, name, `failed to load: ${errorMessage(err)}`, { cause: err });
    }
    for (const a of loaded ?? []) if (!this.get(a.port, a.name)) this.register(a);
    return this.get(port, name);
  }

  list(filter: { port?: PortName; layer?: Layer; direction?: Direction } = {}): AnyAdapter[] {
    return [...this.#adapters.values()].filter((a) =>
      (!filter.port || a.port === filter.port) && (!filter.layer || a.layer === filter.layer) && (!filter.direction || a.direction === filter.direction));
  }

  /** Validates options against the adapter's schema and creates the port instance. */
  async create<P extends PortName>(port: P, name: string, options: unknown, ctx: AdapterContext): Promise<PortTypes[P]> {
    const layer = PORTS[port].layer;
    const adapter = await this.resolve(port, name);
    if (!adapter) throw new AdapterError(layer, name, `not installed: no ${port} adapter named "${name}"`);
    const opts = options ?? {};
    const errors = adapter.optionsSchema ? validate(adapter.optionsSchema, opts, 'options') : [];
    if (errors.length) throw new AdapterError(layer, name, `invalid options: ${errors.join('; ')}`);
    try {
      return await adapter.create(opts, ctx);
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      throw new AdapterError(layer, name, errorMessage(err), { cause: err });
    }
  }
}

/** Every adapter descriptor a module exports (`adapters`, `default`, or named exports). */
export function descriptorsOf(mod: Record<string, unknown>): AnyAdapter[] {
  const out = new Set<AnyAdapter>();
  for (const value of Object.values(mod)) {
    for (const v of Array.isArray(value) ? value : [value]) if (isAdapterDescriptor(v)) out.add(v);
  }
  return [...out];
}

/** Imports a module by specifier, resolved from `cwd` first, and returns its adapter descriptors. */
export async function importAdapters(specifier: string, cwd: string): Promise<AnyAdapter[]> {
  let url = specifier;
  try {
    url = pathToFileURL(createRequire(join(cwd, 'package.json')).resolve(specifier)).href;
  } catch { /* fall back to resolution from the core package */ }
  return descriptorsOf(await import(url) as Record<string, unknown>);
}

/** Default loader: adapter `<name>` lives in the package `@agent-layers/adapter-<name>`. */
export function packageLoader(cwd: string, prefix = '@agent-layers/adapter-'): AdapterLoader {
  return async (_port, name) => {
    try {
      return await importAdapters(`${prefix}${name}`, cwd);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') && errorMessage(err).includes(`${prefix}${name}`)) return undefined;
      throw err;
    }
  };
}
