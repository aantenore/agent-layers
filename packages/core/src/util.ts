import { createHash, randomUUID } from 'node:crypto';

/** Glob with `*` (any run of characters) and `?` (one character), anchored. */
export function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

export function matchesAny(globs: readonly string[], name: string): boolean {
  return globs.some((g) => globToRegExp(g).test(name));
}

/** JSON with sorted object keys, so equal values give equal strings. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const newRunId = () => randomUUID();

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Deep merge for config overlays: objects merge, everything else (arrays included) is replaced. `null` deletes. */
export function deepMerge<T>(base: T, overlay: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return (overlay === undefined ? base : overlay) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === null) delete out[k];
    else out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}
