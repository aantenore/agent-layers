import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type OpenApiDocument = { openapi?: string; [key: string]: any };

const MAX_DEPTH = 24;
const FETCH_TIMEOUT_MS = 30_000;

function pointer(spec: OpenApiDocument, ref: string): unknown {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref "${ref}" (only local "#/..." references are resolved)`);
  let node: any = spec;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error(`unresolved $ref "${ref}"`);
  }
  return node;
}

/** Inlines local `$ref`s; a reference that points back into itself is cut to an unconstrained schema. */
export function deref(spec: OpenApiDocument, node: unknown, stack: string[] = []): any {
  if (Array.isArray(node)) return node.map((n) => deref(spec, n, stack));
  if (typeof node !== 'object' || node === null) return node;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === 'string') {
    if (stack.includes(obj.$ref) || stack.length > MAX_DEPTH) return {};
    return deref(spec, pointer(spec, obj.$ref), [...stack, obj.$ref]);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = deref(spec, v, stack);
  // OpenAPI 3.0 `nullable` becomes a JSON Schema type union.
  if (out.nullable === true && typeof out.type === 'string') out.type = [out.type, 'null'];
  delete out.nullable;
  return out;
}

/** First `servers` entry with its variables replaced by their defaults. */
export function serverUrl(spec: OpenApiDocument): string | undefined {
  const server = spec.servers?.[0];
  if (!server?.url) return undefined;
  return String(server.url).replace(/\{([^}]+)\}/g, (_, v: string) => String(server.variables?.[v]?.default ?? ''));
}

export interface LoadedSpec { spec: OpenApiDocument; url?: string }

/** Reads an OpenAPI 3 document from a file path (relative to `baseDir`) or an http(s) URL. JSON only. */
export async function readSpec(source: string, baseDir: string = process.cwd(), signal?: AbortSignal): Promise<LoadedSpec> {
  const isUrl = /^https?:\/\//i.test(source);
  let text: string;
  if (isUrl) {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const res = await fetch(source, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) throw new Error(`cannot fetch OpenAPI spec ${source}: HTTP ${res.status}`);
    text = await res.text();
  } else {
    text = await readFile(resolve(baseDir, source), 'utf8');
  }
  try {
    return { spec: JSON.parse(text), ...(isUrl ? { url: source } : {}) };
  } catch {
    throw new Error(`OpenAPI spec ${source} is not valid JSON (YAML is not supported: convert it to JSON first)`);
  }
}

/** Absolute base URL for the operations: the option, an absolute `servers` entry, or a relative one resolved against the spec URL. */
export function baseUrlOf(spec: OpenApiDocument, option: string | undefined, specUrl: string | undefined): string {
  const url = option ?? serverUrl(spec);
  const absolute = url && /^https?:\/\//i.test(url) ? url : url !== undefined && specUrl ? new URL(url, specUrl).href : undefined;
  let host = '';
  try { host = absolute ? new URL(absolute).hostname : ''; } catch { /* reported below */ }
  if (!absolute || !host) throw new Error('OpenAPI: set an absolute "baseUrl" (the spec has no usable absolute "servers" entry)');
  return absolute.replace(/\/+$/, '');
}
