const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Replaces `${env:X}` and `${env:X:-default}` in every string of `value`. A missing variable without a default throws. */
export function interpolate<T>(value: T, env: Record<string, string | undefined>, path = 'options'): T {
  if (typeof value === 'string') {
    return value.replace(ENV_REF, (_m, name: string, fallback: string | undefined) => {
      const v = env[name];
      if (v !== undefined && v !== '') return v;
      if (fallback !== undefined) return fallback;
      throw new Error(`${path}: environment variable ${name} is not set`);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, env, `${path}[${i}]`)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, `${path}.${k}`)])) as T;
  }
  return value;
}
