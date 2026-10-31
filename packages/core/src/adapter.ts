import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AdapterError, errorMessage } from './errors.ts';
import { extDeclarationProblems, type ExtDeclaration } from './ext.ts';
import type { Layer } from './layers.ts';
import { coerceLimits, validateLimits, type LimitSpec } from './limits.ts';
import { createMappings, mappingDefaultsProblems, type MappingDefaults, type Mappings } from './mappings.ts';
import { compatibleVersion, isPortName, PORTS, type PortName, type PortTypes } from './ports/catalog.ts';
import type { ServiceSpec } from './ports/deploy.ts';
import type { TelemetryPort } from './ports/telemetry.ts';
import type { Stack } from './stack.ts';
import { validate, type JsonSchema } from './schema.ts';
import { vocabularyProblems, type VocabulariesConfig } from './vocab.ts';

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
  /**
   * The composed stack, so an adapter can use its governed ports (for example `stack().modelFor(...)` for a model call
   * with guards, cache, router and telemetry). Present only when the adapter is created by `compose`. Call it when the
   * adapter is used, not inside `create`: it throws until composition has finished.
   */
  stack?: () => Stack;
  /**
   * The instance's boundary mappings: its descriptor's `mappingDefaults` rules, replaced or extended by the stack
   * config's `mappings` block. Call `mappings.in(native, shape)` / `mappings.out(shape, wire)` where the adapter
   * translates. Rules that change nothing are free.
   */
  mappings: Mappings;
}

/** What `AdapterRegistry.create` takes: a context whose mappings default to the descriptor's own. */
export type AdapterContextInit = Omit<AdapterContext, 'mappings'> & { mappings?: Mappings };

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
  /**
   * Configurable limits of the adapter (timeouts, sizes, counts), each an `options.*` path with its default, accepted
   * range and production check. Values are coerced from `${env:...}` strings and validated before `create`, and the
   * readiness gate reports unsafe ones on the production tier. Listed in docs/limits.md.
   */
  limits?: Readonly<Record<string, LimitSpec>>;
  /**
   * The `ext` keys the adapter writes (`produces`, in its namespace, which defaults to the adapter name), the keys of
   * other namespaces it reads (`reads`) and the ones telemetry may export (`safe`). Checked by conformance (`checkExt`).
   */
  ext?: ExtDeclaration;
  /** Values the adapter adds to extensible vocabularies (same rules as the config block; config wins). */
  vocabularies?: VocabulariesConfig;
  /**
   * The adapter's mapping edges: the language shape its `in` rules build and its `out` rules read, with its built-in
   * translation published as default rules. A direction absent here takes no rules from config.
   */
  mappingDefaults?: MappingDefaults;
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
  for (const l of Object.values(d.limits ?? {})) if (!l.path.startsWith('options.')) fail(`limit ${l.path} must be an options.* path`);
  const language = [
    ...extDeclarationProblems(d.ext, d.name),
    ...vocabularyProblems(d.vocabularies, 'vocabularies'),
    ...mappingDefaultsProblems(d.mappingDefaults, d.ext?.namespace ?? d.name),
  ];
  if (language.length) fail(language.join('; '));
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
  async create<P extends PortName>(port: P, name: string, options: unknown, init: AdapterContextInit): Promise<PortTypes[P]> {
    const layer = PORTS[port].layer;
    const adapter = await this.resolve(port, name);
    if (!adapter) throw new AdapterError(layer, name, `not installed: no ${port} adapter named "${name}"`);
    const limits = Object.values(adapter.limits ?? {});
    const opts = (coerceLimits(limits, { options: options ?? {} }) as { options: Record<string, unknown> }).options;
    // Limit messages first: they say what a limit accepts, where the schema only says the value matches no shape.
    const errors = validateLimits(limits, { options: opts });
    const seen = new Set(errors.map((e) => e.split(':')[0]));
    if (adapter.optionsSchema) errors.push(...validate(adapter.optionsSchema, opts, 'options').filter((e) => !seen.has(e.split(':')[0])));
    if (errors.length) throw new AdapterError(layer, name, `invalid options: ${errors.join('; ')}`);
    const ctx: AdapterContext = {
      ...init,
      mappings: init.mappings ?? createMappings(init.name, { in: adapter.mappingDefaults?.in?.rules ?? [], out: adapter.mappingDefaults?.out?.rules ?? [] }),
    };
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
