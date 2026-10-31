import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validate, type JsonSchema } from '@agent-layers/core';

/** spec/schemas: packaged copy first, then the repository checkout. */
const DIRS = ['../schemas/', '../../../spec/schemas/'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
const cache = new Map<string, JsonSchema>();

export function schema(name: string): JsonSchema {
  let s = cache.get(name);
  if (!s) {
    const dir = DIRS.find((d) => existsSync(`${d}${name}.json`));
    if (!dir) throw new Error(`schema ${name}.json not found (looked in ${DIRS.join(', ')})`);
    s = JSON.parse(readFileSync(`${dir}${name}.json`, 'utf8')) as JsonSchema;
    cache.set(name, s);
  }
  return s;
}

/** Validation errors of `value` against spec/schemas/<name>.json. */
export const conforms = (name: string, value: unknown, path = name) => validate(schema(name), value, path);
