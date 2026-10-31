import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Tier } from './adapter.ts';
import { configSchema } from './config-schema.ts';
import { ConfigError } from './errors.ts';
import type { GuardStage } from './ports/guard.ts';
import type { AgentSpec } from './ports/runtime.ts';
import type { PolicyRule } from './policy.ts';
import { validate } from './schema.ts';
import { SLOTS, type SlotName } from './slots.ts';
import { deepMerge, isPlainObject } from './util.ts';

export interface AdapterRef { adapter: string; name?: string; options?: Record<string, unknown>; stages?: GuardStage[] }
export interface AppendList { $merge: 'append'; items: AdapterRef[] }

type SingleSlots = 'deploy' | 'secrets' | 'model' | 'runtime' | 'state' | 'memory' | 'identity' | 'credentials' | 'authorization' | 'approval' | 'router' | 'cache' | 'feedback';
type MapSlots = 'knowledge' | 'ingestion' | 'tools';
type ListSlots = 'guardrails' | 'telemetry' | 'eval' | 'channels' | 'triggers';

export type LayersConfig =
  & { [K in SingleSlots]?: AdapterRef | null }
  & { [K in MapSlots]?: Record<string, AdapterRef | null> | null }
  & { [K in ListSlots]?: AdapterRef[] | AppendList | null }
  & { services?: Record<string, unknown>[] };

export interface PipelineConfig {
  knowledge?: { k?: number; maxChars?: number; mode?: 'system' | 'user' | 'tools' | 'off' };
  cacheTtlMs?: number;
  approvalTimeoutMs?: number;
}

/** Network host of the stack (gateway mode). */
export interface GatewayConfig {
  port?: number;
  host?: string;
  /** Instance names of the channels and triggers to mount; every mountable one when omitted. */
  inbound?: string[];
  /** Accept requests without a credential. Default false; a production-tier profile never runs triggers anonymously. */
  anonymous?: boolean;
  /** Largest accepted request body in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  /** Time limit of one request, streams included (default 300000). */
  requestTimeoutMs?: number;
  /** Public origin used in absolute URLs (agent cards), when the gateway sits behind a proxy. */
  publicOrigin?: string;
  /** Cross-origin access; off when omitted. */
  cors?: { origins: string[] };
}

export interface AgentConfig { file?: string; instructions?: string; model?: string; tools?: string[]; knowledge?: string[]; params?: Record<string, unknown> }

/** Profile layers: like LayersConfig, but an entry may omit `adapter` to change only its options. */
export type LayersOverlay = {
  [K in keyof LayersConfig]?: LayersConfig[K] extends infer V
    ? V extends Record<string, AdapterRef | null> | null | undefined ? Record<string, Partial<AdapterRef> | null> | null
      : V extends AdapterRef | null | undefined ? Partial<AdapterRef> | null : V
    : never;
};

export interface ProfileConfig {
  description?: string;
  extends?: string;
  tier?: Tier;
  requires?: SlotName[];
  layers?: LayersOverlay;
  policy?: PolicyRule[];
  pipeline?: PipelineConfig;
  gateway?: GatewayConfig;
}

/** Contents of agent-layers.json. Schema: spec/schemas/stack-config.json. */
export interface StackConfig {
  $schema?: string;
  name?: string;
  plugins?: string[];
  profile?: string;
  layers?: LayersConfig;
  policy?: PolicyRule[];
  pipeline?: PipelineConfig;
  gateway?: GatewayConfig;
  profiles?: Record<string, ProfileConfig>;
  agents?: Record<string, AgentConfig>;
}

/** A config with one profile applied: what compose and the readiness gate work on. */
export interface ResolvedConfig {
  name?: string;
  profile?: string;
  /** Profiles applied, from the root ancestor to the selected one. */
  chain: string[];
  tier: Tier;
  requires?: SlotName[];
  plugins: string[];
  layers: LayersConfig;
  policy: PolicyRule[];
  pipeline: PipelineConfig;
  gateway: GatewayConfig;
  agents: Record<string, AgentConfig>;
  /** Directory of the config file; relative paths resolve against it. */
  dir: string;
}

/** Slots required by default for production-tier profiles. */
export const PRODUCTION_REQUIRES: readonly SlotName[] = ['identity', 'authorization', 'guardrails', 'telemetry', 'state'];

export const PROFILE_ENV = 'AGENT_LAYERS_PROFILE';

/** Validates a parsed config against the stack config schema. */
export function validateConfig(config: unknown): string[] {
  return validate(configSchema, config);
}

const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Replaces `${env:X}` and `${env:X:-default}` in every string. Missing variables without a default are errors. */
export function interpolate<T>(value: T, env: Record<string, string | undefined>, errors: string[] = [], path = '$'): T {
  if (typeof value === 'string') {
    return value.replace(ENV_REF, (_m, name: string, fallback: string | undefined) => {
      const v = env[name];
      if (v !== undefined && v !== '') return v;
      if (fallback !== undefined) return fallback;
      errors.push(`${path}: environment variable ${name} is not set`);
      return '';
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, env, errors, `${path}[${i}]`)) as T;
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, errors, `${path}.${k}`)])) as T;
  return value;
}

/** Deep merge for layer overlays; list slots replace unless the overlay is `{ "$merge": "append", items }`. */
export function mergeLayers(base: LayersConfig, overlay: LayersOverlay | LayersConfig | undefined): LayersConfig {
  if (!overlay) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay as Record<string, unknown>)) {
    const current = out[key];
    if (value === null) delete out[key];
    else if (isPlainObject(value) && value.$merge === 'append') {
      out[key] = [...(Array.isArray(current) ? current : []), ...((value.items as unknown[]) ?? [])];
    } else if (SLOTS.find((s) => s.slot === key)?.shape === 'map' && isPlainObject(current) && isPlainObject(value)) {
      // Entries merge by name; an entry that switches adapter starts from scratch (options belong to the adapter).
      const merged: Record<string, unknown> = { ...current };
      for (const [name, entry] of Object.entries(value)) {
        const prev = merged[name];
        if (entry === null) delete merged[name];
        else merged[name] = isPlainObject(prev) && isPlainObject(entry) && (!entry.adapter || entry.adapter === prev.adapter) ? deepMerge(prev, entry) : entry;
      }
      out[key] = merged;
    } else if (isPlainObject(value) && isPlainObject(current) && 'adapter' in current && (!value.adapter || value.adapter === current.adapter)) {
      out[key] = deepMerge(current, value);
    } else out[key] = value;
  }
  return out as LayersConfig;
}

/** Applies a profile (and its `extends` chain) to the base config. */
export function resolveProfile(config: StackConfig, profile?: string, dir = process.cwd()): ResolvedConfig {
  const chain: string[] = [];
  for (let p = profile; p; p = config.profiles?.[p]?.extends) {
    if (chain.includes(p)) throw new ConfigError([`profiles: extends cycle ${[...chain, p].join(' → ')}`]);
    if (!config.profiles?.[p]) throw new ConfigError([`profiles.${p}: not defined${chain.length ? ` (extended by ${chain.at(-1)})` : ''}`]);
    chain.push(p);
  }
  chain.reverse();
  let layers = mergeLayers({}, config.layers);
  let policy = config.policy ?? [];
  let pipeline: PipelineConfig = config.pipeline ?? {};
  let gateway: GatewayConfig = config.gateway ?? {};
  let tier: Tier = 'prototype';
  let requires: SlotName[] | undefined;
  for (const name of chain) {
    const p = config.profiles![name]!;
    layers = mergeLayers(layers, p.layers);
    if (p.policy) policy = p.policy;
    if (p.pipeline) pipeline = deepMerge(pipeline, p.pipeline);
    if (p.gateway) gateway = deepMerge(gateway, p.gateway);
    if (p.tier) tier = p.tier;
    if (p.requires) requires = p.requires;
  }
  for (const key of Object.keys(layers)) {
    const v = (layers as Record<string, unknown>)[key];
    if (isPlainObject(v) && !('adapter' in v)) {
      (layers as Record<string, unknown>)[key] = Object.fromEntries(Object.entries(v).filter(([, e]) => e != null));
    }
  }
  return {
    ...(config.name ? { name: config.name } : {}),
    ...(profile ? { profile } : {}),
    chain, tier, ...(requires ? { requires } : {}),
    plugins: config.plugins ?? [], layers, policy, pipeline, gateway, agents: config.agents ?? {}, dir,
  };
}

export interface LoadOptions {
  profile?: string;
  env?: Record<string, string | undefined>;
}

/** Parses, validates, applies the profile and interpolates environment variables. */
export function parseConfig(text: string, opts: LoadOptions & { file?: string; dir?: string } = {}): ResolvedConfig {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (err) {
    throw new ConfigError([`not valid JSON: ${(err as Error).message}`], opts.file);
  }
  const errors = validateConfig(raw);
  if (errors.length) throw new ConfigError(errors, opts.file);
  const config = raw as StackConfig;
  const env = opts.env ?? process.env;
  const profile = opts.profile ?? env[PROFILE_ENV] ?? config.profile;
  let resolved: ResolvedConfig;
  try {
    resolved = resolveProfile(config, profile, opts.dir ?? process.cwd());
  } catch (err) {
    if (err instanceof ConfigError) throw new ConfigError(err.errors, opts.file);
    throw err;
  }
  const envErrors: string[] = [];
  const layers = interpolate(resolved.layers, env, envErrors, '$.layers');
  const agents = interpolate(resolved.agents, env, envErrors, '$.agents');
  const gateway = interpolate(resolved.gateway, env, envErrors, '$.gateway');
  if (envErrors.length) throw new ConfigError(envErrors.map((e) => profile ? `${e} (profile ${profile})` : e), opts.file);
  return { ...resolved, layers, agents, gateway };
}

export async function loadConfig(file: string, opts: LoadOptions = {}): Promise<ResolvedConfig> {
  const path = resolve(file);
  return parseConfig(await readFile(path, 'utf8'), { ...opts, file: path, dir: dirname(path) });
}

/** Profiles of a config file, without resolving them. */
export async function readRawConfig(file: string): Promise<StackConfig> {
  const path = resolve(file);
  const text = await readFile(path, 'utf8');
  const raw = JSON.parse(text) as unknown;
  const errors = validateConfig(raw);
  if (errors.length) throw new ConfigError(errors, path);
  return raw as StackConfig;
}

/**
 * Minimal front matter: `key: value` and `key: [a, b]` lines between `---` fences.
 * Body after the front matter is the agent's instructions.
 */
export function parseAgentFile(text: string): AgentConfig {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { instructions: text.trim() };
  const out: Record<string, unknown> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const [, key, value = ''] = kv;
    out[key!] = value.startsWith('[') && value.endsWith(']')
      ? value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      : value.replace(/^["']|["']$/g, '');
  }
  return { ...(out as AgentConfig), instructions: m[2]!.trim() };
}

/** Builds the AgentSpec for a configured agent, reading its Markdown file when it has one. */
export async function agentSpec(config: ResolvedConfig, name: string): Promise<AgentSpec> {
  const entry = config.agents[name];
  if (!entry) throw new ConfigError([`agents.${name}: not defined (known: ${Object.keys(config.agents).join(', ') || 'none'})`]);
  const fromFile = entry.file ? parseAgentFile(await readFile(resolve(config.dir, entry.file), 'utf8')) : {};
  const merged = { ...fromFile, ...Object.fromEntries(Object.entries(entry).filter(([k, v]) => k !== 'file' && v !== undefined)) } as AgentConfig;
  if (!merged.model) throw new ConfigError([`agents.${name}: model is required`]);
  return {
    name,
    instructions: merged.instructions ?? '',
    model: merged.model,
    tools: merged.tools ?? [],
    ...(merged.knowledge ? { knowledge: merged.knowledge } : {}),
    ...(merged.params ? { params: merged.params } : {}),
  };
}

export interface ConfiguredAdapter {
  slot: SlotName;
  port: (typeof SLOTS)[number]['port'];
  layer: (typeof SLOTS)[number]['layer'];
  /** Instance name: map key, `name`, or the adapter name (suffixed when repeated). */
  key: string;
  ref: AdapterRef;
}

/** Every adapter a resolved config uses, slot by slot, in catalog order. */
export function configuredAdapters(layers: LayersConfig): ConfiguredAdapter[] {
  const out: ConfiguredAdapter[] = [];
  for (const s of SLOTS) {
    const value = (layers as Record<string, unknown>)[s.slot];
    if (value == null) continue;
    const base = { slot: s.slot as SlotName, port: s.port, layer: s.layer };
    if (s.shape === 'single') out.push({ ...base, key: (value as AdapterRef).adapter, ref: value as AdapterRef });
    else if (s.shape === 'map') {
      for (const [key, ref] of Object.entries(value as Record<string, AdapterRef>)) out.push({ ...base, key, ref });
    } else {
      const seen = new Map<string, number>();
      for (const ref of value as AdapterRef[]) {
        const n = ref.name ?? ref.adapter;
        const count = (seen.get(n) ?? 0) + 1;
        seen.set(n, count);
        out.push({ ...base, key: count > 1 ? `${n}-${count}` : n, ref });
      }
    }
  }
  return out;
}
