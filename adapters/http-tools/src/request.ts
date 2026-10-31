import { validate, type CallContext, type ToolOutcome, type ToolRisk } from '@agent-layers/core';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
export const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

const PLACEHOLDER = /\{([A-Za-z0-9_.-]+)\}/g;
const TEXTUAL = /^(text\/|application\/(json|xml|yaml|javascript|x-www-form-urlencoded)|[^;]*\+(json|xml))/i;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULT_CHARS = 16_000;
const ERROR_BODY_CHARS = 500;

/** A request built from tool arguments. */
export interface RequestSpec {
  method: HttpMethod;
  /** Absolute URL; `{param}` placeholders are filled from the arguments, URL-encoded. */
  url: string;
  /** Arguments sent as query parameters (arrays repeat the key). */
  query?: string[];
  /** Arguments sent as request headers (same name). */
  headerArgs?: string[];
  /** Static headers. */
  headers?: Record<string, string>;
  /** `json`: arguments not used above are sent as the JSON body (or only `bodyArg`). Default `none`. */
  body?: 'json' | 'none';
  /** With `body: 'json'`: the argument that holds the whole body. */
  bodyArg?: string;
  timeoutMs?: number;
  /** Response text cap (default 16000). */
  maxResultChars?: number;
  /** Send `Authorization: Bearer <token>` from the caller's credentials; without credentials nothing is sent. */
  auth?: { audience: string; scopes?: string[] };
}

export const defaultRisk = (method: string): ToolRisk => (method === 'GET' || method === 'HEAD' ? 'read' : 'write');

export function checkRequestSpec(name: string, spec: RequestSpec): HttpMethod {
  const method = String(spec.method).toUpperCase() as HttpMethod;
  if (!METHODS.includes(method)) throw new Error(`tool "${name}": unsupported method "${spec.method}" (use ${METHODS.join(', ')})`);
  if (spec.body === 'json' && (method === 'GET' || method === 'HEAD')) throw new Error(`tool "${name}": ${method} cannot have a body`);
  if (spec.bodyArg && spec.body !== 'json') throw new Error(`tool "${name}": bodyArg needs body "json"`);
  if (!/^https?:\/\//i.test(spec.url)) throw new Error(`tool "${name}": url must be absolute http(s)`);
  try { templateGuard(spec.url); } catch (err) { throw new Error(`tool "${name}": ${err instanceof Error ? err.message : String(err)}`); }
  return method;
}

/** Path placeholders of a URL template. */
export const pathArgs = (url: string): string[] => [...url.matchAll(PLACEHOLDER)].map((m) => m[1]!);

const plain = (value: unknown): string => (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));
const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);
const failure = (content: string): ToolOutcome => ({ content, isError: true });
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Secrets shorter than this are not worth masking and would mangle ordinary text. */
const MIN_SECRET_CHARS = 4;
const REDACTED = '[redacted]';

/** Every form a secret may take when a server echoes it: raw, JSON-escaped, URL-encoded; longest first. */
function secretForms(values: Iterable<string>): string[] {
  const forms = new Set<string>();
  for (const v of values) {
    if (v.length < MIN_SECRET_CHARS) continue;
    forms.add(v);
    forms.add(JSON.stringify(v).slice(1, -1));
    forms.add(encodeURIComponent(v));
  }
  return [...forms].filter((f) => f.length >= MIN_SECRET_CHARS).sort((x, y) => y.length - x.length);
}

const redact = (text: string, forms: readonly string[]): string => forms.reduce((t, f) => t.split(f).join(REDACTED), text);

/** Values of every static header, plus the credential part of an Authorization value ("Bearer abc" also yields "abc"). */
function staticSecrets(headers: Record<string, string> | undefined): string[] {
  return Object.entries(headers ?? {}).flatMap(([k, v]) => (k.toLowerCase() === 'authorization' ? [v, v.replace(/^\s*\w+\s+/, '').trim()] : [v]));
}

/** Fixed part of a URL template: its origin and the path up to the first placeholder. */
function templateGuard(url: string): { origin: string; prefix: string } {
  const at = url.indexOf('{');
  const head = at < 0 ? url : url.slice(0, at);
  let parsed: URL;
  try { parsed = new URL(head); } catch { throw new Error('placeholders are allowed in the path and query only, not in the scheme or host'); }
  if (at >= 0 && /^https?:\/\/[^/?#]*$/i.test(head)) {
    throw new Error('placeholders are allowed in the path and query only, not in the scheme or host');
  }
  return { origin: parsed.origin, prefix: parsed.pathname };
}

/** Sends one request built from `args`. Non-2xx answers are error results; network failures reject. */
export async function sendRequest(name: string, spec: RequestSpec & { method: HttpMethod }, args: Record<string, unknown>, ctx: CallContext): Promise<ToolOutcome> {
  const headers = new Headers(spec.headers);
  const queryArgs = spec.query ?? [];
  const headerArgs = spec.headerArgs ?? [];
  const consumed = new Set([...pathArgs(spec.url), ...queryArgs, ...headerArgs]);
  const maxChars = spec.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  for (const h of headerArgs) if (args[h] !== undefined && args[h] !== null) headers.set(h, plain(args[h]));

  const missing: string[] = [];
  const dotted: string[] = [];
  const guard = templateGuard(spec.url);
  const filled = spec.url.replace(PLACEHOLDER, (_, key: string) => {
    if (args[key] === undefined || args[key] === null) missing.push(key);
    const value = plain(args[key] ?? '');
    // encodeURIComponent keeps dots, and "." / ".." would climb the path once the URL is normalized.
    if (/^\.+$/.test(value)) dotted.push(key);
    return encodeURIComponent(value);
  });
  if (missing.length) return failure(`Missing path parameter(s): ${missing.join(', ')}`);
  if (dotted.length) return failure(`Invalid path parameter(s): ${dotted.join(', ')} (a value made only of dots is not allowed); the request was not sent`);
  const target = new URL(filled);
  if (target.origin !== guard.origin || !target.pathname.startsWith(guard.prefix)) {
    return failure('The arguments change where the request goes; the request was not sent');
  }
  for (const key of queryArgs) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    for (const v of Array.isArray(value) ? value : [value]) target.searchParams.append(key, plain(v));
  }

  let body: string | undefined;
  if (spec.body === 'json') {
    const payload = spec.bodyArg ? args[spec.bodyArg] : Object.fromEntries(Object.entries(args).filter(([k, v]) => !consumed.has(k) && v !== undefined));
    if (payload !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(payload);
    }
  }
  if (!headers.has('accept')) headers.set('accept', 'application/json, text/plain;q=0.9, */*;q=0.5');

  const secrets = [...staticSecrets(spec.headers), ...headerArgs.flatMap((h) => (args[h] !== undefined && args[h] !== null ? [plain(args[h])] : []))];
  if (spec.auth) {
    if (!ctx.credentials) return failure(`${name} needs credentials for audience "${spec.auth.audience}" and this run has none; the request was not sent`);
    let token: string;
    try {
      token = await ctx.credentials.token(spec.auth.audience, spec.auth.scopes ? { scopes: spec.auth.scopes } : {});
    } catch (err) {
      return failure(`Could not get a token for audience "${spec.auth.audience}": ${message(err)}; the request was not sent`);
    }
    headers.set('authorization', `Bearer ${token}`);
    secrets.push(token);
  }

  const timeout = AbortSignal.timeout(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const res = await fetch(target, { method: spec.method, headers, ...(body !== undefined ? { body } : {}), signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout });
  const type = res.headers.get('content-type') ?? '';
  if (res.ok && type && !TEXTUAL.test(type)) {
    return { content: `HTTP ${res.status}: ${(await res.arrayBuffer()).byteLength} bytes of ${type.split(';')[0]} (not shown)` };
  }
  let text = await res.text();
  // A server may echo request headers back; secrets must not reach the model, in the text or in `data`.
  text = redact(text, secretForms(secrets));
  if (!res.ok) return failure(`HTTP ${res.status} ${res.statusText}`.trim() + (text ? `: ${truncate(text, ERROR_BODY_CHARS)}` : ''));
  let data: unknown;
  if (/json/i.test(type) && text) {
    try {
      data = JSON.parse(text);
      text = JSON.stringify(data, null, 2);
    } catch {
      data = undefined; // not valid JSON: keep the raw text
    }
  }
  if (!text) return { content: `HTTP ${res.status} (no content)` };
  if (text.length > maxChars) return { content: `${text.slice(0, maxChars)}\n[truncated: ${text.length} chars in total]` };
  return { content: text, ...(data !== undefined ? { data } : {}) };
}

/** Validates arguments against the tool schema; returns an error result or undefined. */
export function checkArgs(schema: Record<string, unknown>, args: Record<string, unknown>): ToolOutcome | undefined {
  const errors = validate(schema, args, 'args');
  return errors.length ? failure(`Invalid arguments: ${errors.join('; ')}`) : undefined;
}
