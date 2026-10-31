import type { Ext } from './ports/base.ts';
import { isPlainObject } from './util.ts';

/** Namespace reserved for keys the core writes (`sdk.raw_score`, `sdk.rank`, `sdk.approval`, `sdk.outcome`). */
export const SDK_NAMESPACE = 'sdk';

/** Namespaces adapters may not use for ext keys or event types: the core's own. */
export const RESERVED_NAMESPACES: readonly string[] = ['sdk', 'agent', 'run', 'model', 'tool'];

/** `<namespace>.<name>`: lowercase kebab-case namespace, then a dot and the name. */
export const EXT_KEY = /^([a-z][a-z0-9-]*)\.([A-Za-z0-9_.-]+)$/;

/** Namespace of an ext key, or undefined when the key is not namespaced. */
export function extNamespace(key: string): string | undefined {
  return EXT_KEY.exec(key)?.[1];
}

/**
 * What an adapter declares about `ext`: the keys it writes (`produces`), the keys of other namespaces it reads
 * (`reads`) and the ones telemetry may export (`safe`). `namespace` defaults to the adapter name.
 */
export interface ExtDeclaration {
  namespace?: string;
  produces?: readonly string[];
  reads?: readonly string[];
  safe?: readonly string[];
}

/** Problems of a declaration: keys must be namespaced and produced keys must be in the adapter's namespace. */
export function extDeclarationProblems(decl: ExtDeclaration | undefined, adapter: string): string[] {
  if (!decl) return [];
  const ns = decl.namespace ?? adapter;
  const out: string[] = [];
  if (!/^[a-z][a-z0-9-]*$/.test(ns)) out.push(`ext.namespace "${ns}" must be lowercase kebab-case`);
  if (RESERVED_NAMESPACES.includes(ns)) out.push(`ext.namespace "${ns}" is reserved for the core`);
  for (const k of decl.produces ?? []) {
    if (extNamespace(k) !== ns) out.push(`ext.produces "${k}" must be in the namespace "${ns}"`);
  }
  for (const k of [...(decl.reads ?? []), ...(decl.safe ?? [])]) if (!extNamespace(k)) out.push(`ext key "${k}" is not namespaced`);
  for (const k of decl.safe ?? []) if (!(decl.produces ?? []).includes(k)) out.push(`ext.safe "${k}" is not in produces`);
  return out;
}

/**
 * Problems of the ext keys written by an adapter, found anywhere inside `value` (every `ext` bag of every shape it
 * returned): not namespaced, in the reserved `sdk` namespace, in another adapter's namespace, or not declared.
 * Without a declaration only the namespace rules apply.
 */
export function extWriteProblems(value: unknown, decl?: ExtDeclaration & { adapter?: string }): string[] {
  const out = new Set<string>();
  const ns = decl ? decl.namespace ?? decl.adapter : undefined;
  for (const key of extKeys(value)) {
    const keyNs = extNamespace(key);
    if (!keyNs) out.add(`ext key "${key}" is not namespaced (<namespace>.<name>)`);
    else if (keyNs === SDK_NAMESPACE) out.add(`ext key "${key}" is in the core's namespace "sdk"`);
    else if (ns && keyNs !== ns) out.add(`ext key "${key}" is in another namespace than "${ns}"`);
    else if (decl?.produces && !decl.produces.includes(key)) out.add(`ext key "${key}" is not declared in ext.produces`);
  }
  return [...out];
}

/** Every key of every `ext` bag inside a value. */
export function extKeys(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 32 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const v of value) extKeys(v, out, depth + 1); return out; }
  for (const [k, v] of Object.entries(value)) {
    if (k === 'ext' && isPlainObject(v)) for (const key of Object.keys(v)) out.add(key);
    else extKeys(v, out, depth + 1);
  }
  return out;
}

/** Size of an ext bag in bytes (UTF-8 of its JSON). */
export function extBytes(ext: Ext | undefined): number {
  if (!ext) return 0;
  try { return Buffer.byteLength(JSON.stringify(ext), 'utf8'); } catch { return Infinity; }
}

/**
 * The shape with its `ext` bag removed when the bag is larger than `maxBytes` (or not JSON). `onDrop` is told the size,
 * for an event. Other fields are untouched; the shape is copied only when something is dropped.
 */
export function boundExt<T extends { ext?: Ext }>(shape: T, maxBytes: number, onDrop?: (bytes: number) => void): T {
  if (!shape?.ext || !Number.isFinite(maxBytes)) return shape;
  const bytes = extBytes(shape.ext);
  if (bytes <= maxBytes) return shape;
  onDrop?.(bytes);
  const { ext: _ext, ...rest } = shape;
  return rest as T;
}

/** A copy of `ext` with `values` merged in; undefined values remove keys. Undefined when the result is empty. */
export function withExt(ext: Ext | undefined, values: Ext): Ext | undefined {
  const out: Ext = { ...ext };
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
