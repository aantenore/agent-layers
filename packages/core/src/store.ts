import type { JsonValue, StoreSetOptions } from './ports/store.ts';

/** A store key: `<namespace>.<name>`, the namespace in lower case, the name printable ASCII without spaces. */
export const STORE_KEY = /^[a-z][a-z0-9-]{0,63}\.[\x21-\x7e]+$/;

/** Why `key` is not a valid store key of at most `maxChars` characters, or undefined. */
export function storeKeyProblem(key: unknown, maxChars: number): string | undefined {
  if (typeof key !== 'string' || !STORE_KEY.test(key)) return 'key must be <namespace>.<name> (printable ASCII, no spaces)';
  if (key.length > maxChars) return `key longer than ${maxChars} characters`;
  return undefined;
}

/** Why `value` is not plain JSON (null, booleans, finite numbers, strings, arrays, plain objects), or undefined. */
export function jsonProblem(value: unknown, path = 'value', seen = new Set<object>()): string | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : `${path} is not a finite number`;
  if (typeof value !== 'object') return `${path} is not JSON (${typeof value})`;
  if (seen.has(value)) return `${path} is circular`;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return `${path} is not a plain object`;
  seen.add(value);
  try {
    for (const [k, v] of Object.entries(value)) {
      const problem = jsonProblem(v, Array.isArray(value) ? `${path}[${k}]` : `${path}.${k}`, seen);
      if (problem) return problem;
    }
  } finally {
    seen.delete(value);
  }
  return undefined;
}

/** The JSON text of a store value, or the reason it cannot be stored (not JSON, or larger than `maxBytes` in UTF-8). */
export function encodeStoreValue(value: unknown, maxBytes: number): { json: string } | { problem: string } {
  const problem = jsonProblem(value);
  if (problem) return { problem };
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, 'utf8');
  return bytes > maxBytes ? { problem: `value is ${bytes} bytes, larger than ${maxBytes}` } : { json };
}

/** Why the options of a store write are invalid, or undefined. */
export function storeOptionsProblem(opts: StoreSetOptions | undefined): string | undefined {
  if (opts?.ifVersion !== undefined && !(Number.isSafeInteger(opts.ifVersion) && opts.ifVersion >= 0)) return 'ifVersion must be an integer >= 0';
  if (opts?.ttlMs !== undefined && !(Number.isSafeInteger(opts.ttlMs) && opts.ttlMs > 0)) return 'ttlMs must be an integer > 0';
  return undefined;
}

/** A deep copy of a stored value: callers never share an object with the store. */
export const cloneJson = <T extends JsonValue>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
