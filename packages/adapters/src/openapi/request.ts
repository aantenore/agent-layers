import { anySignal, limitValue, timeoutSignal, validate, type CallContext, type LimitValue, type Risk, type ToolResult } from '@agent-layers/core';
import { LIMITS } from './limits.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
export const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

const PLACEHOLDER = /\{([A-Za-z0-9_.-]+)\}/g;
const TEXTUAL = /^(text\/|application\/(json|xml|yaml|javascript|x-www-form-urlencoded)|[^;]*\+(json|xml))/i;

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
  /** Time limit per request (default 30000). */
  timeoutMs?: LimitValue;
  /** Response text cap (default 16000). */
  maxResultChars?: LimitValue;
  /** Characters of an error body kept in the error result (default 500). */
  errorBodyChars?: number;
  /** Secrets shorter than this are not masked (default 4). */
  minSecretChars?: number;
  /** Send `Authorization: Bearer <token>` from the caller's credentials; without credentials nothing is sent. */
  auth?: { audience: string; scopes?: string[] };
}

export const defaultRisk = (method: string): Risk => (method === 'GET' || method === 'HEAD' ? 'read' : 'write');

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
const failure = (text: string): ToolResult => ({ ok: false, text });
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const REDACTED = '[redacted]';

/**
 * Every form a secret may take when a server echoes it: raw, JSON-escaped, URL-encoded; longest first. Secrets shorter
 * than `minChars` are not worth masking and would mangle ordinary text.
 */
function secretForms(values: Iterable<string>, minChars: number): string[] {
  const forms = new Set<string>();
  for (const v of values) {
    if (v.length < minChars) continue;
    forms.add(v);
    forms.add(JSON.stringify(v).slice(1, -1));
    forms.add(encodeURIComponent(v));
  }
  return [...forms].filter((f) => f.length >= minChars).sort((x, y) => y.length - x.length);
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
export async function sendRequest(name: string, spec: RequestSpec & { method: HttpMethod }, args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
  const headers = new Headers(spec.headers);
  const queryArgs = spec.query ?? [];
  const headerArgs = spec.headerArgs ?? [];
  const consumed = new Set([...pathArgs(spec.url), ...queryArgs, ...headerArgs]);
  const maxChars = limitValue(LIMITS.maxResultChars, spec.maxResultChars);
  const timeoutMs = limitValue(LIMITS.timeoutMs, spec.timeoutMs);
  const errorBodyChars = limitValue(LIMITS.errorBodyChars, spec.errorBodyChars);
  const minSecretChars = limitValue(LIMITS.minSecretChars, spec.minSecretChars);
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

  // Redirects are not followed: the arguments and the credentials stay with the configured host.
  const res = await fetch(target, { method: spec.method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal: anySignal(ctx.signal, timeoutSignal(timeoutMs)) });
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {});
    return failure(`${name}: redirects are not followed (HTTP ${res.status})`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (res.ok && type && !TEXTUAL.test(type)) {
    return { ok: true, text: `HTTP ${res.status}: ${(await res.arrayBuffer()).byteLength} bytes of ${type.split(';')[0]} (not shown)` };
  }
  // A server may echo request headers back; secrets must not reach the model, in the text or in `data`. Mask the raw
  // body, normalise the JSON (which decodes \u escapes), then mask the normalised form: serialize, redact, parse.
  const forms = secretForms(secrets, minSecretChars);
  let text = redact(await res.text(), forms);
  let data: unknown;
  if (/json/i.test(type) && text) {
    try {
      const normalised = redact(JSON.stringify(JSON.parse(text), null, res.ok ? 2 : undefined), forms);
      text = normalised;
      try { data = JSON.parse(normalised); } catch { data = undefined; } // masking broke the structure: keep the text only
    } catch {
      data = undefined; // not valid JSON: keep the raw text
    }
  }
  if (!res.ok) return failure(redact(`HTTP ${res.status} ${res.statusText}`, forms).trim() + (text ? `: ${truncate(text, errorBodyChars)}` : ''));
  if (!text) return { ok: true, text: `HTTP ${res.status} (no content)` };
  if (text.length > maxChars) return { ok: true, text: `${text.slice(0, maxChars)}\n[truncated: ${text.length} chars in total]` };
  return { ok: true, text, ...(data !== undefined ? { data } : {}) };
}

/** Validates arguments against the tool schema; returns an error result or undefined. */
export function checkArgs(schema: Record<string, unknown>, args: Record<string, unknown>): ToolResult | undefined {
  const errors = validate(schema, args, 'args');
  return errors.length ? failure(`Invalid arguments: ${errors.join('; ')}`) : undefined;
}
