import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validate, type JsonSchema } from '@agent-layers/core';

/** spec/schemas: packaged copy first, then the repository checkout. */
const DIRS = ['../schemas/', '../../../spec/schemas/'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
const raw = new Map<string, JsonSchema>();
const bundled = new Map<string, JsonSchema>();

/** The schema file as written, with its external references intact. */
export function rawSchema(name: string): JsonSchema {
  let s = raw.get(name);
  if (!s) {
    const dir = DIRS.find((d) => existsSync(`${d}${name}.json`));
    if (!dir) throw new Error(`schema ${name}.json not found (looked in ${DIRS.join(', ')})`);
    s = JSON.parse(readFileSync(`${dir}${name}.json`, 'utf8')) as JsonSchema;
    raw.set(name, s);
  }
  return s;
}

/** Names of the schema files of the specification. */
export function schemaNames(): string[] {
  const dir = DIRS.find((d) => existsSync(d));
  if (!dir) throw new Error(`schema directory not found (looked in ${DIRS.join(', ')})`);
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

/**
 * Inlines every external reference of a schema into local `$defs`, so a validator that follows only `#/...` pointers
 * can use it. A definition of another file becomes `<file>.<Name>`, a whole file `<file>`; references inside inlined
 * definitions are rewritten the same way, recursively.
 */
function bundle(root: string): JsonSchema {
  const defs: Record<string, unknown> = {};
  const stem = (name: string) => name.replace(/\.json$/, '');

  const defOf = (file: string, name: string): string => {
    const key = `${file}.${name}`;
    if (!(key in defs)) {
      defs[key] = {};
      const source = (rawSchema(file).$defs as Record<string, unknown> | undefined)?.[name];
      if (!source) throw new Error(`schema ${file}.json has no definition "${name}"`);
      defs[key] = walk(source, file);
    }
    return `#/$defs/${key}`;
  };

  const wholeOf = (file: string): string => {
    if (!(file in defs)) {
      defs[file] = {};
      const { $schema: _s, $id: _i, $defs: _d, examples: _e, ...body } = rawSchema(file);
      defs[file] = walk(body, file);
    }
    return `#/$defs/${file}`;
  };

  /** The local pointer a reference written in `file` becomes in the bundle. */
  const rewrite = (ref: string, file: string): string => {
    const [path = '', frag = ''] = ref.split('#', 2);
    const target = path === '' ? file : stem(path);
    if (target === root) return frag ? `#${frag}` : '#';
    if (frag === '' || frag === '/') return wholeOf(target);
    const m = /^\/\$defs\/([^/]+)$/.exec(frag);
    if (!m) throw new Error(`unsupported reference "${ref}" in ${file}.json`);
    return defOf(target, m[1]!);
  };

  function walk(node: unknown, file: string): unknown {
    if (Array.isArray(node)) return node.map((n) => walk(n, file));
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out[k] = rewrite(v, file);
      // Property and definition names are data, whatever they are called.
      else if ((k === 'properties' || k === '$defs') && v && typeof v === 'object') {
        out[k] = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, walk(s, file)]));
      } else out[k] = walk(v, file);
    }
    return out;
  }

  const result = walk(rawSchema(root), root) as JsonSchema;
  if (Object.keys(defs).length) result.$defs = { ...(result.$defs as Record<string, unknown> | undefined), ...defs };
  return result;
}

/** spec/schemas/<name>.json with every external reference inlined into local `$defs`. */
export function schema(name: string): JsonSchema {
  let s = bundled.get(name);
  if (!s) {
    s = bundle(name);
    bundled.set(name, s);
  }
  return s;
}

/** Validation errors of `value` against spec/schemas/<name>.json. */
export const conforms = (name: string, value: unknown, path = name) => validate(schema(name), value, path);
