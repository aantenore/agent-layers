import type { Tier } from './adapter.ts';
import type { JsonSchema } from './schema.ts';
import { isPlainObject } from './util.ts';

/** Explicit "no limit". Accepted only where a limit declares `unbounded`, never by leaving a value out. */
export const UNBOUNDED = 'unbounded';
export type Unbounded = typeof UNBOUNDED;
/** A configured limit: a number, or `"unbounded"` where the limit allows it. */
export type LimitValue = number | Unbounded;

export type LimitUnit = 'ms' | 's' | 'bytes' | 'chars' | 'count' | 'tokens' | 'usd';
export type LimitSeverity = 'warn' | 'fail';

/**
 * A configurable limit: where it is set, its default, the values validation accepts and how the readiness gate of a
 * production-tier profile treats it. Components declare theirs in one `LIMITS` list (adapters on the descriptor), so
 * validation, the readiness gate and the docs check (docs/limits.md) read the same source.
 */
export interface LimitSpec {
  /**
   * Where the limit is set. Stack config: `gateway.maxBodyBytes`. Adapter: `options.timeoutMs`; `[]` walks an array
   * and `*` the values of a map (`options.tools[].timeoutMs`).
   */
  path: string;
  /** Value used when the setting is absent; `null` when absent means "use `fallback`". */
  default: LimitValue | null;
  unit: LimitUnit;
  /** Smallest accepted value. */
  min: number;
  /** Largest accepted value. */
  max?: number;
  /** Whole numbers only (default true). */
  integer?: boolean;
  /** `"unbounded"` is accepted, and the readiness gate of a production-tier profile reports it with this severity. */
  unbounded?: LimitSeverity;
  /** Range recommended for production: values outside it are a warning on the production tier. */
  safe?: { min?: number; max?: number };
  /** What applies when the value is absent and `default` is `null` (another setting, or "none"). */
  fallback?: string;
}

/** A limit value the readiness gate reports on a production-tier profile. */
export interface LimitFinding {
  severity: LimitSeverity;
  /** Concrete path of the value (`gateway.maxBodyBytes`, `options.tools[2].timeoutMs`). */
  path: string;
  value: LimitValue;
  message: string;
}

const ENV_PATTERN = '^\\$\\{env:[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\\}$';
const NUMERIC = /^\s*-?\d+(\.\d+)?\s*$/;

/**
 * Declares a component's limits under short keys, so code reads `LIMITS.timeoutMs`. For a top-level adapter option
 * the key is the option name (`limitProperties` relies on it).
 */
export function defineLimits<const K extends string>(specs: Record<K, LimitSpec>): Readonly<Record<K, LimitSpec>> {
  for (const s of Object.values(specs) as LimitSpec[]) {
    if (s.default === UNBOUNDED && !s.unbounded) throw new TypeError(`limit ${s.path}: default is unbounded but unbounded is not allowed`);
    if (typeof s.default === 'number' && (s.default < s.min || (s.max !== undefined && s.default > s.max))) throw new TypeError(`limit ${s.path}: default ${s.default} is outside ${s.min}..${s.max ?? ''}`);
  }
  return Object.freeze(specs);
}

/** The limits of a `defineLimits` record, as a list. */
export const limitList = (limits: Readonly<Record<string, LimitSpec>>): LimitSpec[] => Object.values(limits);

/**
 * JSON Schema of one limit. With `env`, a whole-string `${env:NAME}` reference is accepted too (the stack config is
 * validated before interpolation; the value is checked again after it).
 */
export function limitSchema(spec: LimitSpec, opts: { env?: boolean; description?: string } = {}): JsonSchema {
  const num: JsonSchema = {
    type: spec.integer === false ? 'number' : 'integer',
    minimum: spec.min,
    ...(spec.max !== undefined ? { maximum: spec.max } : {}),
  };
  const shapes: JsonSchema[] = [num];
  if (spec.unbounded) shapes.push({ const: UNBOUNDED });
  if (opts.env) shapes.push({ type: 'string', pattern: ENV_PATTERN });
  const unit = `${spec.unit === 'count' ? '' : ` (${spec.unit})`}`;
  const def = spec.default === null ? (spec.fallback ? `; default: ${spec.fallback}` : '') : `; default ${spec.default}`;
  return {
    ...(shapes.length === 1 ? num : { anyOf: shapes }),
    ...(spec.default !== null ? { default: spec.default } : {}),
    description: `${opts.description ? `${opts.description}${unit}` : `Limit${unit}`}${def}${spec.unbounded ? '; "unbounded" disables it' : ''}.`,
  };
}

/** Schemas of the top-level `options.<key>` limits, to spread into an adapter's `optionsSchema.properties`. */
export function limitProperties(limits: Readonly<Record<string, LimitSpec>>, descriptions: Record<string, string> = {}): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {};
  for (const [key, spec] of Object.entries(limits)) {
    if (spec.path === `options.${key}`) out[key] = limitSchema(spec, descriptions[key] ? { description: descriptions[key] } : {});
  }
  return out;
}

/**
 * The value to enforce: the configured one, else the default. `"unbounded"` becomes `Infinity`, so size and count
 * checks need no special case. Never pass the result to `setTimeout` or `AbortSignal.timeout` unchecked: use
 * {@link timeoutSignal}.
 */
export function limitValue(spec: LimitSpec, configured: unknown): number {
  const v = configured === undefined || configured === null ? spec.default : configured;
  if (v === UNBOUNDED) return Infinity;
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && NUMERIC.test(v)) return Number(v);
  if (v === null) return NaN;
  throw new TypeError(`limit ${spec.path}: not a number: ${JSON.stringify(v)}`);
}

/** `AbortSignal.timeout(ms)`, or undefined when the limit is unbounded. */
export const timeoutSignal = (ms: number): AbortSignal | undefined => (Number.isFinite(ms) ? AbortSignal.timeout(ms) : undefined);

/** One signal that aborts when any of the given ones does; undefined when none is given. */
export function anySignal(...signals: (AbortSignal | undefined | null)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => !!s);
  return present.length > 1 ? AbortSignal.any(present) : present[0];
}

interface Found { path: string; value: unknown; set(v: unknown): void }

/** Every value at `path` under `root` (missing ones skipped). `[]` walks arrays, `*` map values. */
function locate(root: unknown, path: string): Found[] {
  const parts = path.replace(/\[\]/g, '.[]').split('.').filter(Boolean);
  let level: Found[] = [{ path: '', value: root, set: () => {} }];
  for (const part of parts) {
    const next: Found[] = [];
    for (const f of level) {
      const v = f.value;
      if (part === '[]') {
        if (Array.isArray(v)) v.forEach((item, i) => next.push({ path: `${f.path}[${i}]`, value: item, set: (x) => { v[i] = x; } }));
      } else if (part === '*') {
        if (isPlainObject(v)) for (const [k, item] of Object.entries(v)) next.push({ path: `${f.path}.${k}`, value: item, set: (x) => { v[k] = x; } });
      } else if (isPlainObject(v) && v[part] !== undefined) {
        next.push({ path: f.path ? `${f.path}.${part}` : part, value: v[part], set: (x) => { v[part] = x; } });
      }
    }
    level = next;
  }
  return level;
}

/** Copy of `root` with numeric strings at limit paths turned into numbers (values that came from `${env:...}`). */
export function coerceLimits<T>(specs: readonly LimitSpec[], root: T): T {
  if (!specs.length || !isPlainObject(root)) return root;
  const copy = structuredClone(root) as T;
  for (const s of specs) for (const f of locate(copy, s.path)) if (typeof f.value === 'string' && NUMERIC.test(f.value)) f.set(Number(f.value));
  return copy;
}

/** What is wrong with one limit value, or undefined when it is accepted. */
export function limitProblem(spec: LimitSpec, value: unknown): string | undefined {
  const what = `${spec.integer === false ? 'a number' : 'an integer'}${spec.unbounded ? ' or "unbounded"' : ''}`;
  if (value === UNBOUNDED) return spec.unbounded ? undefined : `must be ${what} ("unbounded" is not allowed here)`;
  if (typeof value !== 'number' || !Number.isFinite(value)) return `must be ${what}`;
  if (spec.integer !== false && !Number.isInteger(value)) return `must be ${what}`;
  if (value < spec.min) return `must be >= ${spec.min}`;
  if (spec.max !== undefined && value > spec.max) return `must be <= ${spec.max}`;
  return undefined;
}

/** Validation errors of the limit values under `root` (after interpolation and coercion), as `<path>: <problem>`. */
export function validateLimits(specs: readonly LimitSpec[], root: unknown, prefix = ''): string[] {
  const errors: string[] = [];
  for (const s of specs) {
    for (const f of locate(root, s.path)) {
      const problem = limitProblem(s, f.value);
      if (problem) errors.push(`${prefix}${f.path}: ${problem}`);
    }
  }
  return errors;
}

const fmt = (n: number | undefined) => (n === undefined ? '∞' : String(n));

/** Safe range as printed in docs/limits.md: `min–max`, `∞` for no upper bound. */
export function formatSafeRange(spec: LimitSpec): string {
  return `${fmt(spec.safe?.min ?? spec.min)}–${fmt(spec.safe?.max ?? spec.max)}`;
}

/**
 * Findings of the readiness gate for limits: on the production tier, `"unbounded"` where the limit says so, and values
 * outside the safe range (warnings). Absent values are judged by their default. Other tiers have no findings.
 */
export function limitFindings(specs: readonly LimitSpec[], root: unknown, tier: Tier, prefix = ''): LimitFinding[] {
  if (tier !== 'production') return [];
  const out: LimitFinding[] = [];
  for (const s of specs) {
    const found = locate(root, s.path);
    const values = found.length ? found : s.path.includes('[]') || s.path.includes('*') || s.default === null ? [] : [{ path: s.path, value: s.default }];
    for (const f of values) {
      const value = typeof f.value === 'string' && NUMERIC.test(f.value) ? Number(f.value) : f.value;
      const where = `${prefix}${f.path}`;
      if (value === UNBOUNDED) {
        out.push({ severity: s.unbounded ?? 'fail', path: where, value, message: `${where} is unbounded` });
      } else if (typeof value === 'number' && s.safe) {
        if (s.safe.min !== undefined && value < s.safe.min) out.push({ severity: 'warn', path: where, value, message: `${where} = ${value} is below the safe range ${formatSafeRange(s)} ${s.unit}` });
        if (s.safe.max !== undefined && value > s.safe.max) out.push({ severity: 'warn', path: where, value, message: `${where} = ${value} is above the safe range ${formatSafeRange(s)} ${s.unit}` });
      }
    }
  }
  return out;
}
