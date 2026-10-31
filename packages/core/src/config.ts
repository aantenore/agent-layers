import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Tier } from './adapter.ts';
import { configSchema } from './config-schema.ts';
import { ConfigError } from './errors.ts';
import { ambiguousToolSources } from './pipeline/governed-tools.ts';
import { coerceLimits, limitProblem, validateLimits, type LimitValue } from './limits.ts';
import { mappingsProblems, mergeMappings, type MappingsConfig } from './mappings.ts';
import type { ModelSettings } from './ports/model.ts';
import type { Ext } from './ports/base.ts';
import type { FusionOptions } from './pipeline/knowledge.ts';
import type { GuardStage } from './ports/guard.ts';
import type { AgentSpec } from './ports/runtime.ts';
import type { PolicyRule } from './policy.ts';
import { validate, type JsonSchema } from './schema.ts';
import { SLOTS, type SlotName } from './slots.ts';
import { STACK_LIMITS } from './stack-limits.ts';
import { deepMerge, isPlainObject } from './util.ts';
import { Vocabularies, vocabularyProblems, type VocabulariesConfig } from './vocab.ts';

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

/** Limits are numbers once the config is parsed; `"unbounded"` only where docs/limits.md allows it. */
export interface PipelineConfig {
  knowledge?: { k?: number; maxChars?: number; maxK?: number; mode?: 'system' | 'user' | 'tools' | 'off'; fusion?: FusionOptions };
  cacheTtlMs?: number;
  /** Who shares a cached model reply: `caller` (default) or `shared`. */
  cacheScope?: 'caller' | 'shared';
  approvalTimeoutMs?: number;
}

/** Limits that belong to no single layer (see docs/limits.md). */
export interface LimitsConfig {
  check?: { timeoutMs?: number; deployTimeoutMs?: number; listToolsTimeoutMs?: number };
  /** Largest `ext` bag kept on a shape the core passes on (default 16384 bytes). */
  extBytes?: number;
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
  maxBodyBytes?: LimitValue;
  /** Time limit of one request, streams included (default 300000). */
  requestTimeoutMs?: LimitValue;
  /** Time a client has to send the request headers (default 30000). */
  headersTimeoutMs?: LimitValue;
  /** Time a client has to send the whole request, capped by `requestTimeoutMs` (default 120000). */
  bodyTimeoutMs?: LimitValue;
  /** How long `close` waits for requests and trigger runs in flight (default 10000). */
  closeGraceMs?: number;
  /** `Access-Control-Max-Age` of CORS preflight answers, in seconds (default 600). */
  corsMaxAgeS?: number;
  /** Longest `X-Request-Id` kept from the caller; longer or malformed ones are replaced (default 64). */
  maxRequestIdChars?: number;
  /** Longest trace context header values (parent, state) kept from the caller, each; longer or non-printable ones are dropped (default 512). */
  maxTraceChars?: number;
  /** Public origin used in absolute URLs (agent cards), when the gateway sits behind a proxy. */
  publicOrigin?: string;
  /** Cross-origin access; off when omitted. */
  cors?: { origins: string[] };
  /** Origins accepted besides the gateway's own when a request carries an `Origin` header (the `cors` origins count too). */
  allowedOrigins?: string[];
  /** Accepted `Host` names (`name` or `name:port`); default: the loopback names when bound to loopback, any otherwise. */
  allowedHosts?: string[];
}

export interface AgentConfig {
  file?: string; instructions?: string; model?: string; tools?: string[]; knowledge?: string[]; settings?: ModelSettings; ext?: Ext;
}

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
  limits?: LimitsConfig;
  vocabularies?: VocabulariesConfig;
  mappings?: MappingsConfig;
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
  limits?: LimitsConfig;
  /** Values added to extensible vocabularies (see spec/language.md). */
  vocabularies?: VocabulariesConfig;
  /** Boundary mapping rules per adapter instance (see spec/language.md). */
  mappings?: MappingsConfig;
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
  limits: LimitsConfig;
  vocabularies: VocabulariesConfig;
  mappings: MappingsConfig;
  agents: Record<string, AgentConfig>;
  /** Directory of the config file; relative paths resolve against it. */
  dir: string;
}

/** Slots required by default for production-tier profiles. */
export const PRODUCTION_REQUIRES: readonly SlotName[] = ['identity', 'authorization', 'guardrails', 'telemetry', 'state'];

export const PROFILE_ENV = 'AGENT_LAYERS_PROFILE';

const PARAMS_REMOVED = 'params was removed in 1.0: put temperature, maxOutputTokens and stop under settings, and adapter-specific keys under ext (namespaced)';

/**
 * Validates a parsed config against the stack config schema, plus the rules a schema cannot say (vocabulary
 * collisions, mapping rules). Limit values get the limit's own message.
 */
export function validateConfig(config: unknown): string[] {
  const errors = validate(configSchema, config).map((e) => {
    const params = /^\$\.agents\.([^.]+)\.params: unknown property$/.exec(e);
    if (params) return `$.agents.${params[1]}: ${PARAMS_REMOVED}`;
    const m = /^\$((?:\.\w+)+): does not match any allowed shape$/.exec(e);
    const tail = m?.[1]!.slice(1).split('.');
    if (!tail) return e;
    // Top level or inside a profile (`profiles.<name>.gateway...`).
    const path = tail[0] === 'profiles' ? tail.slice(2).join('.') : tail.join('.');
    const spec = STACK_LIMITS.find((s) => s.path === path);
    let value: unknown = config;
    for (const k of tail) value = (value as Record<string, unknown> | undefined)?.[k];
    const problem = spec && limitProblem(spec, value);
    return problem ? `$.${tail.join('.')}: ${problem}` : e;
  });
  if (!isPlainObject(config)) return errors;
  errors.push(...languageProblems(config, '$.'));
  for (const [name, p] of Object.entries(isPlainObject(config.profiles) ? config.profiles : {})) {
    if (isPlainObject(p)) errors.push(...languageProblems(p, `$.profiles.${name}.`, config.vocabularies as VocabulariesConfig | undefined));
  }
  return errors;
}

function languageProblems(block: Record<string, unknown>, prefix: string, base?: VocabulariesConfig): string[] {
  return [
    ...vocabularyProblems(block.vocabularies, `${prefix}vocabularies`, base ? new Vocabularies([base]) : undefined),
    ...mappingsProblems(block.mappings, `${prefix}mappings`),
  ];
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
  let limits: LimitsConfig = config.limits ?? {};
  let vocabularies: VocabulariesConfig = config.vocabularies ?? {};
  let mappings: MappingsConfig = mergeMappings({}, config.mappings);
  let tier: Tier = 'prototype';
  let requires: SlotName[] | undefined;
  for (const name of chain) {
    const p = config.profiles![name]!;
    layers = mergeLayers(layers, p.layers);
    if (p.policy) policy = p.policy;
    if (p.pipeline) pipeline = deepMerge(pipeline, p.pipeline);
    if (p.gateway) gateway = deepMerge(gateway, p.gateway);
    if (p.limits) limits = deepMerge(limits, p.limits);
    if (p.vocabularies) vocabularies = deepMerge(vocabularies, p.vocabularies);
    if (p.mappings) mappings = mergeMappings(mappings, p.mappings);
    if (p.tier) tier = p.tier;
    if (p.requires) requires = p.requires;
  }
  for (const key of Object.keys(layers)) {
    const v = (layers as Record<string, unknown>)[key];
    if (isPlainObject(v) && !('adapter' in v)) {
      (layers as Record<string, unknown>)[key] = Object.fromEntries(Object.entries(v).filter(([, e]) => e != null));
    }
  }
  const sourceErrors = ambiguousToolSources(toolSourceNames(layers)).map((e) => `layers.tools: ${e}${profile ? ` (profile ${profile})` : ''}`);
  if (sourceErrors.length) throw new ConfigError(sourceErrors);
  return {
    ...(config.name ? { name: config.name } : {}),
    ...(profile ? { profile } : {}),
    chain, tier, ...(requires ? { requires } : {}),
    plugins: config.plugins ?? [], layers, policy, pipeline, gateway, limits, vocabularies, mappings, agents: config.agents ?? {}, dir,
  };
}

/** Names of the tool sources the stack aggregates: the `tools` slot, and `knowledge` when knowledge sources can become tools. */
function toolSourceNames(layers: LayersConfig): string[] {
  const names = Object.keys(isPlainObject(layers.tools) ? layers.tools : {});
  if (isPlainObject(layers.knowledge) && Object.keys(layers.knowledge).length && !names.includes('knowledge')) names.push('knowledge');
  return names;
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
  // Limits may come from ${env:...}: interpolated strings become numbers, then their ranges are checked again.
  const sections = coerceLimits(STACK_LIMITS, {
    gateway: interpolate(resolved.gateway, env, envErrors, '$.gateway'),
    pipeline: interpolate(resolved.pipeline, env, envErrors, '$.pipeline'),
    limits: interpolate(resolved.limits, env, envErrors, '$.limits'),
  });
  if (!envErrors.length) envErrors.push(...validateLimits(STACK_LIMITS, sections, '$.'));
  if (envErrors.length) throw new ConfigError(envErrors.map((e) => profile ? `${e} (profile ${profile})` : e), opts.file);
  return { ...resolved, layers, agents, ...sections };
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

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '');
const scalar = (s: string): string | number | boolean => {
  const v = s.trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  return unquote(v);
};
const list = (s: string) => s.slice(1, -1).split(',').map(unquote).filter(Boolean);

/** `{ a: 1, b: [x, y], c: "z" }`: one level of a flow mapping with scalar and list values. */
function flowMap(text: string, key: string): Record<string, unknown> {
  const body = text.trim().slice(1, -1);
  const out: Record<string, unknown> = {};
  for (const m of body.matchAll(/("[^"]+"|'[^']+'|[A-Za-z_][\w.-]*)\s*:\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|[^,]+)/g)) {
    out[unquote(m[1]!)] = m[2]!.trim().startsWith('[') ? list(m[2]!.trim()) : scalar(m[2]!);
  }
  if (!Object.keys(out).length && body.trim()) throw new ConfigError([`agent file: ${key} must be a flow mapping such as { temperature: 0 }`]);
  return out;
}

/**
 * Minimal front matter between `---` fences: `key: value`, `key: [a, b]` and, for `settings` and `ext`, a one-line
 * flow mapping (`settings: { temperature: 0, maxOutputTokens: 512 }`). The body is the agent's instructions.
 * `params` was removed in 1.0 and is an error.
 */
export function parseAgentFile(text: string): AgentConfig {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { instructions: text.trim() };
  const out: Record<string, unknown> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const [, key, value = ''] = kv;
    if (key === 'params') throw new ConfigError([`agent file: ${PARAMS_REMOVED}`]);
    if ((key === 'settings' || key === 'ext') && value.trim().startsWith('{')) out[key!] = flowMap(value, key);
    else out[key!] = value.startsWith('[') && value.endsWith(']') ? list(value) : unquote(value);
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
  if ('params' in merged) throw new ConfigError([`agents.${name}: ${PARAMS_REMOVED}`]);
  const problems = validate((configSchema.$defs as Record<string, JsonSchema>).agentSettings!, merged.settings ?? {}, `agents.${name}.settings`);
  if (problems.length) throw new ConfigError(problems);
  return {
    name,
    instructions: merged.instructions ?? '',
    model: merged.model,
    tools: merged.tools ?? [],
    ...(merged.knowledge ? { knowledge: merged.knowledge } : {}),
    ...(merged.settings && Object.keys(merged.settings).length ? { settings: merged.settings } : {}),
    ...(merged.ext && Object.keys(merged.ext).length ? { ext: merged.ext } : {}),
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
