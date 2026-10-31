import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MappingError, errorMessage } from './errors.ts';
import { extNamespace } from './ext.ts';
import { fieldAt, isShapeName, parsePointer, shapeProblems, vocabOf, type ShapeName } from './shapes.ts';
import { isPlainObject } from './util.ts';
import { CORE_VOCABULARIES, type Vocabularies } from './vocab.ts';

/**
 * One boundary mapping rule. Rules run in order. For `in` the source is the native document (read-only) and the
 * target the language shape the adapter built; for `out` the source is the language shape and the target the wire
 * document. See docs/decisions/0001-sdk-language.md#boundary-mappings.
 */
export interface MappingRule {
  /** JSON Pointer into the source, or a list of pointers (for `join`). Omit for a constant (`default`). */
  from?: string | string[];
  /** JSON Pointer into the target. Writing copies; copying then dropping the old path renames. */
  to?: string;
  /** Value written as is when `from` is missing or null: final, never passed through `split` or `map`. */
  default?: unknown;
  /** Value table: source scalar (as a string) → target value; `"*"` is the fallback. Unlisted values are not written. */
  map?: Record<string, unknown>;
  /** `"union"`: lists concatenated without duplicates; any other string joins strings with it. */
  join?: string;
  /** Separator that turns a string into a list. */
  split?: string;
  /** JSON Pointer removed from the target (after the write, when there is one). */
  drop?: string;
  /** `"<module path>#<export>"`: `(source, target, ctx) => target`, synchronous and pure. */
  fn?: string;
}

/** `{ "$merge": "append", items }`: rules appended to the adapter's defaults instead of replacing them. */
export interface AppendRules { $merge: 'append'; items: MappingRule[] }
export type RuleList = MappingRule[] | AppendRules;

/** Rules of one adapter instance. `null` removes what a base config or profile set. */
export interface InstanceMappings { in?: RuleList | null; out?: RuleList | null }

/** The `mappings` block: instance key (`identity`, `tools.crm`, `guardrails.pii`) → rules. */
export type MappingsConfig = Record<string, InstanceMappings | null>;

/** One side of an adapter's mapping edge: the language shape it builds (`in`) or reads (`out`), and its default rules. */
export interface MappingSide { shape: ShapeName; rules?: readonly MappingRule[] }
/** What an adapter declares on its descriptor: which directions take rules, on which shape, with which defaults. */
export interface MappingDefaults { in?: MappingSide; out?: MappingSide }

export type MappingDirection = 'in' | 'out';
export interface MappingContext { key: string; direction: MappingDirection }
export type MappingFn = (source: unknown, target: unknown, ctx: MappingContext) => unknown;

/** What compose hands an adapter: its effective rules, applied where the adapter translates. */
export interface Mappings {
  /** Instance key the rules belong to. */
  readonly key: string;
  readonly rules: { readonly in: readonly MappingRule[]; readonly out: readonly MappingRule[] };
  /** Applies the `in` rules: `native` is read, a copy of `shape` is written and returned. Throws MappingError. */
  in<T>(native: unknown, shape: T): T;
  /** Applies the `out` rules: `shape` is read, a copy of `wire` is written and returned. Throws MappingError. */
  out<W>(shape: unknown, wire: W): W;
}

const RULE_KEYS = new Set(['from', 'to', 'default', 'map', 'join', 'split', 'drop', 'fn']);
const FN_REF = /^[^#]+#[A-Za-z_$][\w$]*$/;

// ---- pointers -----------------------------------------------------------------------------------------------

/** The value at a JSON Pointer, or undefined. */
export function getPointer(doc: unknown, pointer: string): unknown {
  const segs = parsePointer(pointer);
  if (!segs) return undefined;
  let v: unknown = doc;
  for (const seg of segs) {
    if (Array.isArray(v)) v = /^\d+$/.test(seg) ? v[Number(seg)] : undefined;
    else if (isPlainObject(v)) v = Object.hasOwn(v, seg) ? v[seg] : undefined;
    else return undefined;
  }
  return v;
}

/** Writes `value` at a JSON Pointer, creating objects on the way (`-` appends to a list). */
export function setPointer(doc: unknown, pointer: string, value: unknown): unknown {
  const segs = parsePointer(pointer);
  if (!segs) throw new TypeError(`"${pointer}" is not a JSON Pointer`);
  if (!segs.length) return value;
  const root: unknown = isPlainObject(doc) || Array.isArray(doc) ? doc : {};
  let node = root as Record<string, unknown> | unknown[];
  for (const [i, seg] of segs.entries()) {
    const last = i === segs.length - 1;
    if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') throw new TypeError(`"${pointer}": forbidden segment`);
    if (Array.isArray(node)) {
      const idx = seg === '-' ? node.length : /^\d+$/.test(seg) ? Number(seg) : NaN;
      if (Number.isNaN(idx)) throw new TypeError(`"${pointer}": "${seg}" is not a list index`);
      if (last) node[idx] = value;
      else node = (isPlainObject(node[idx]) || Array.isArray(node[idx]) ? node[idx] : (node[idx] = {})) as Record<string, unknown>;
    } else {
      if (last) node[seg] = value;
      else node = (isPlainObject(node[seg]) || Array.isArray(node[seg]) ? node[seg] : (node[seg] = {})) as Record<string, unknown>;
    }
  }
  return root;
}

/** Removes the value at a JSON Pointer, if any. */
export function dropPointer(doc: unknown, pointer: string): void {
  const segs = parsePointer(pointer);
  if (!segs?.length) return;
  let parent: unknown = doc;
  for (const seg of segs.slice(0, -1)) {
    parent = Array.isArray(parent) ? parent[Number(seg)] : isPlainObject(parent) ? parent[seg] : undefined;
    if (parent === undefined) return;
  }
  const last = segs.at(-1)!;
  if (Array.isArray(parent) && /^\d+$/.test(last)) parent.splice(Number(last), 1);
  else if (isPlainObject(parent)) delete parent[last];
}

// ---- engine -------------------------------------------------------------------------------------------------

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

function valueOf(rule: MappingRule, source: unknown): unknown {
  let v: unknown;
  if (Array.isArray(rule.from)) {
    const values = rule.from.map((p) => getPointer(source, p)).filter((x) => x !== undefined && x !== null);
    if (rule.join === 'union') {
      const seen = new Set<string>();
      const out: unknown[] = [];
      for (const x of values.flatMap((y) => (Array.isArray(y) ? y : [y]))) {
        const k = JSON.stringify(x);
        if (!seen.has(k)) { seen.add(k); out.push(x); }
      }
      v = values.length ? out : undefined;
    } else if (typeof rule.join === 'string') {
      const strings = values.flatMap((y) => (Array.isArray(y) ? y : [y])).filter((x) => x !== undefined && x !== null).map(String);
      v = strings.length ? strings.join(rule.join) : undefined;
    } else v = values[0];
  } else if (rule.from !== undefined) v = getPointer(source, rule.from);
  // The default is a target value: it is written as is, never split or looked up in the `map` table.
  if (v === undefined || v === null) return clone(rule.default);
  if (typeof rule.split === 'string' && typeof v === 'string') v = v.split(rule.split).map((x) => x.trim()).filter(Boolean);
  if (rule.map) {
    const table = rule.map;
    // A value the table does not list, without a "*" fallback, is not written (dropped from a list).
    const lookup = (x: unknown) => {
      const k = typeof x === 'string' ? x : JSON.stringify(x);
      return Object.hasOwn(table, k) ? table[k] : Object.hasOwn(table, '*') ? table['*'] : undefined;
    };
    v = Array.isArray(v) ? v.map(lookup).filter((x) => x !== undefined) : lookup(v);
    if (v === undefined) return undefined;
  }
  return clone(v);
}

/** Runs rules over a copy of `target` and returns it. Pure apart from what an `fn` rule does. */
export function applyRules(rules: readonly MappingRule[], source: unknown, target: unknown, ctx: MappingContext, fns: ReadonlyMap<string, MappingFn> = new Map()): unknown {
  let out = clone(target);
  for (const [i, rule] of rules.entries()) {
    try {
      if (rule.fn) {
        const fn = fns.get(rule.fn);
        if (!fn) throw new Error(`function ${rule.fn} is not loaded`);
        out = fn(source, out, ctx);
        continue;
      }
      if (rule.to !== undefined) {
        const v = valueOf(rule, source);
        if (v !== undefined) out = setPointer(out, rule.to, v);
      }
      if (rule.drop !== undefined) dropPointer(out, rule.drop);
    } catch (err) {
      throw new MappingError(ctx.key, `${ctx.direction}[${i}]: ${errorMessage(err)}`, { cause: err });
    }
  }
  return out;
}

/** The rules an instance runs: config replaces the defaults, `$merge: append` adds to them, `null` clears them. */
export function effectiveRules(defaults: readonly MappingRule[] | undefined, configured: RuleList | null | undefined): MappingRule[] {
  if (configured === null) return [];
  if (configured === undefined) return [...(defaults ?? [])];
  if (Array.isArray(configured)) return [...configured];
  return [...(defaults ?? []), ...(configured.items ?? [])];
}

export interface CreateMappingsOptions {
  fns?: ReadonlyMap<string, MappingFn>;
  /** Validate mapped shapes against the field tables (development and test profiles). */
  check?: { in?: ShapeName; vocab?: Vocabularies };
}

/** Mappings of one instance, from its effective rules. */
export function createMappings(key: string, rules: { in?: readonly MappingRule[]; out?: readonly MappingRule[] }, opts: CreateMappingsOptions = {}): Mappings {
  const inRules = Object.freeze([...(rules.in ?? [])]);
  const outRules = Object.freeze([...(rules.out ?? [])]);
  const fns = opts.fns ?? new Map();
  return {
    key,
    rules: Object.freeze({ in: inRules, out: outRules }),
    in<T>(native: unknown, shape: T): T {
      if (!inRules.length) return shape;
      const out = applyRules(inRules, native, shape, { key, direction: 'in' }, fns) as T;
      if (opts.check?.in) {
        const problems = shapeProblems(opts.check.in, out, opts.check.vocab);
        if (problems.length) throw new MappingError(key, `in: mapped ${opts.check.in} is invalid: ${problems.slice(0, 5).join('; ')}`);
      }
      return out;
    },
    out<W>(shape: unknown, wire: W): W {
      if (!outRules.length) return wire;
      return applyRules(outRules, shape, wire, { key, direction: 'out' }, fns) as W;
    },
  };
}

/** Mappings that change nothing. */
export const noMappings = (key = ''): Mappings => createMappings(key, {});

// ---- validation ---------------------------------------------------------------------------------------------

/** Structural problems of one rule list (pointer syntax, field types, fn references). Path for messages. */
export function ruleListProblems(list: unknown, path: string): string[] {
  if (list === null || list === undefined) return [];
  let rules: unknown = list;
  if (isPlainObject(list)) {
    if (list.$merge !== 'append' || !Array.isArray(list.items) || Object.keys(list).some((k) => k !== '$merge' && k !== 'items')) {
      return [`${path}: must be a list of rules or { "$merge": "append", "items": [...] }`];
    }
    rules = list.items;
    path = `${path}.items`;
  }
  if (!Array.isArray(rules)) return [`${path}: must be a list of rules`];
  const out: string[] = [];
  rules.forEach((r, i) => {
    const at = `${path}[${i}]`;
    if (!isPlainObject(r)) { out.push(`${at}: must be an object`); return; }
    for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) out.push(`${at}.${k}: unknown rule field`);
    const pointer = (v: unknown, field: string) => { if (parsePointer(v) === undefined) out.push(`${at}.${field}: "${String(v)}" is not a JSON Pointer`); };
    if (r.fn !== undefined) {
      if (typeof r.fn !== 'string' || !FN_REF.test(r.fn)) out.push(`${at}.fn: must be "<module path>#<export>"`);
      if (Object.keys(r).some((k) => k !== 'fn')) out.push(`${at}: an fn rule takes no other field`);
      return;
    }
    if (r.to === undefined && r.drop === undefined) out.push(`${at}: needs "to", "drop" or "fn"`);
    if (r.to !== undefined) pointer(r.to, 'to');
    if (r.drop !== undefined) pointer(r.drop, 'drop');
    if (r.from !== undefined) {
      if (Array.isArray(r.from)) { if (!r.from.length) out.push(`${at}.from: empty list`); r.from.forEach((p, j) => pointer(p, `from[${j}]`)); }
      else pointer(r.from, 'from');
    }
    if (r.to !== undefined && r.from === undefined && r.default === undefined) out.push(`${at}: a rule without "from" needs a "default" (a constant)`);
    if (r.join !== undefined && (typeof r.join !== 'string' || !Array.isArray(r.from))) out.push(`${at}.join: needs a list "from" and a string`);
    if (r.split !== undefined && typeof r.split !== 'string') out.push(`${at}.split: must be a string`);
    if (r.map !== undefined && !isPlainObject(r.map)) out.push(`${at}.map: must be an object`);
  });
  return out;
}

/** Structural problems of a `mappings` block. */
export function mappingsProblems(block: unknown, path = 'mappings'): string[] {
  if (block === undefined || block === null) return [];
  if (!isPlainObject(block)) return [`${path}: must be an object`];
  const out: string[] = [];
  for (const [key, entry] of Object.entries(block)) {
    const at = `${path}.${key}`;
    if (!/^[a-z]+(\.[A-Za-z0-9_-]+)?$/.test(key)) out.push(`${at}: key must be <slot> or <slot>.<instance>`);
    if (entry === null) continue;
    if (!isPlainObject(entry)) { out.push(`${at}: must be { in?, out? }`); continue; }
    for (const k of Object.keys(entry)) if (k !== 'in' && k !== 'out') out.push(`${at}.${k}: unknown direction (in, out)`);
    out.push(...ruleListProblems(entry.in, `${at}.in`), ...ruleListProblems(entry.out, `${at}.out`));
  }
  return out;
}

/**
 * Problems of rules against the adapter's edge: `in` rules write the shape (`to`/`drop` must address one of its fields
 * or `/ext/<key>` in the adapter's namespace, `map` targets must be vocabulary values); `out` rules read it (`from` must
 * address one of its fields or an `/ext/` key).
 */
export function rulesAgainstShape(rules: readonly MappingRule[], direction: MappingDirection, shape: ShapeName, opts: { namespace?: string; vocab?: Vocabularies; path?: string } = {}): string[] {
  const vocab = opts.vocab ?? CORE_VOCABULARIES;
  const out: string[] = [];
  rules.forEach((r, i) => {
    const at = `${opts.path ?? direction}[${i}]`;
    if (r.fn) return;
    if (direction === 'in') {
      for (const [field, p] of [['to', r.to], ['drop', r.drop]] as const) {
        if (p === undefined) continue;
        const f = fieldAt(shape, p, opts.namespace);
        if (f.problem) { out.push(`${at}.${field}: ${f.problem}`); continue; }
        const v = field === 'to' ? vocabOf(f.field) : undefined;
        if (v && r.map) {
          for (const [k, target] of Object.entries(r.map)) {
            if (!vocab.has(v, target)) out.push(`${at}.map["${k}"]: "${String(target)}" is not a ${v} value`);
          }
        }
        if (v && r.default !== undefined && !vocab.has(v, r.default)) {
          out.push(`${at}.default: "${String(r.default)}" is not a ${v} value`);
        }
      }
    } else {
      for (const p of Array.isArray(r.from) ? r.from : r.from !== undefined ? [r.from] : []) {
        const f = fieldAt(shape, p);
        if (f.problem) out.push(`${at}.from: ${f.problem}`);
      }
    }
  });
  return out;
}

/** The `/ext/<key>` keys a list of rules reads (in `from`), anywhere in the pointer. */
export function extReads(rules: readonly MappingRule[]): string[] {
  const keys = new Set<string>();
  for (const r of rules) {
    for (const p of Array.isArray(r.from) ? r.from : r.from !== undefined ? [r.from] : []) {
      const segs = parsePointer(p) ?? [];
      segs.forEach((s, i) => { if (s === 'ext' && segs[i + 1] && extNamespace(segs[i + 1]!)) keys.add(segs[i + 1]!); });
    }
  }
  return [...keys];
}

/** The `/ext/<key>` keys a list of rules writes (in `to`). */
export function extWrites(rules: readonly MappingRule[]): string[] {
  const keys = new Set<string>();
  for (const r of rules) {
    const segs = r.to !== undefined ? parsePointer(r.to) ?? [] : [];
    segs.forEach((s, i) => { if (s === 'ext' && segs[i + 1] && extNamespace(segs[i + 1]!)) keys.add(segs[i + 1]!); });
  }
  return [...keys];
}

/** Problems of a descriptor's `mappingDefaults`. */
export function mappingDefaultsProblems(d: MappingDefaults | undefined, namespace: string): string[] {
  if (!d) return [];
  const out: string[] = [];
  for (const dir of ['in', 'out'] as const) {
    const side = d[dir];
    if (!side) continue;
    if (!isShapeName(side.shape)) { out.push(`mappingDefaults.${dir}.shape: unknown shape "${String(side.shape)}"`); continue; }
    out.push(...ruleListProblems(side.rules ?? [], `mappingDefaults.${dir}.rules`));
    out.push(...rulesAgainstShape(side.rules ?? [], dir, side.shape, { namespace, path: `mappingDefaults.${dir}.rules` }));
  }
  return out;
}

/** Loads the `fn` rules of a set of rule lists, relative to `dir` (like plugins). */
export async function loadMappingFunctions(lists: readonly (readonly MappingRule[])[], dir: string): Promise<Map<string, MappingFn>> {
  const fns = new Map<string, MappingFn>();
  for (const ref of new Set(lists.flat().flatMap((r) => (r.fn ? [r.fn] : [])))) {
    const [spec, name] = [ref.slice(0, ref.lastIndexOf('#')), ref.slice(ref.lastIndexOf('#') + 1)];
    let url: string;
    if (spec.startsWith('.') || spec.startsWith('/')) url = pathToFileURL(resolve(dir, spec)).href;
    else {
      try { url = pathToFileURL(createRequire(join(dir, 'package.json')).resolve(spec)).href; } catch { url = spec; }
    }
    let mod: Record<string, unknown>;
    try { mod = await import(url) as Record<string, unknown>; } catch (err) { throw new Error(`mapping function ${ref} failed to load: ${errorMessage(err)}`); }
    const fn = mod[name];
    if (typeof fn !== 'function') throw new Error(`mapping function ${ref}: export "${name}" is not a function`);
    fns.set(ref, fn as MappingFn);
  }
  return fns;
}

/** Profile overlay of a `mappings` block: per key and direction, a list replaces, append adds, `null` removes. */
export function mergeMappings(base: MappingsConfig, overlay: MappingsConfig | undefined): MappingsConfig {
  if (!overlay) return base;
  const out: MappingsConfig = { ...base };
  for (const [key, entry] of Object.entries(overlay)) {
    if (entry === null) { delete out[key]; continue; }
    const prev = out[key] ?? {};
    const next: InstanceMappings = { ...prev };
    for (const dir of ['in', 'out'] as const) {
      const v = entry[dir];
      if (v === undefined) continue;
      if (v === null) delete next[dir];
      else if (!Array.isArray(v) && Array.isArray(prev[dir])) next[dir] = [...(prev[dir] as MappingRule[]), ...v.items];
      else next[dir] = v;
    }
    out[key] = next;
  }
  return out;
}
