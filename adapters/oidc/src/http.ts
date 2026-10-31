/** Failure of the OIDC adapter. Messages never contain tokens or client secrets. */
export class OidcError extends Error {
  override name = 'OidcError';
  readonly code: string;
  constructor(code: 'config' | 'unreachable' | 'response' | 'invalid_token' | 'credentials', message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Largest document read from the provider (discovery, JWKS, token response). */
export const MAX_RESPONSE_BYTES = 1_000_000;

const isLoopback = (host: string) =>
  host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);

/** Parses a URL and refuses plain HTTP outside loopback hosts (unless `allowHttp`) and embedded credentials. */
export function secureUrl(url: string, what: string, allowHttp = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OidcError('config', `${what}: invalid URL`);
  }
  if (parsed.username || parsed.password) throw new OidcError('config', `${what}: credentials in the URL are not accepted`);
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'http:' && (allowHttp || isLoopback(parsed.hostname))) return parsed;
  throw new OidcError('config', `${what}: "${parsed.origin}" must use https (plain http only on loopback hosts or with allowHttp)`);
}

/** Reads a body up to `max` bytes; larger bodies are cancelled, never buffered whole. */
export async function readBounded(res: Response, max: number, what: string): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new OidcError('response', `${what}: response too large`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new OidcError('response', `${what}: response too large`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Removes anything that looks like a JWT or a long opaque token from provider-supplied text. */
export const scrub = (text: string) =>
  text.replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]*)?/g, '[redacted]').replace(/[A-Za-z0-9+/_=-]{32,}/g, '[redacted]');

/** Settles with `promise`, or rejects as soon as `signal` aborts, without cancelling the shared work behind it. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export interface RequestOptions {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  what: string;
  signal?: AbortSignal;
}

/**
 * Sends a request (redirects refused) and parses a bounded JSON object body. A non-2xx answer rejects with the status
 * and, for OAuth error bodies, the scrubbed `error` / `error_description`.
 */
export async function requestJson(fetchImpl: FetchLike, url: string, o: RequestOptions): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(o.timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(url, { method: o.method, headers: { accept: 'application/json', ...o.headers }, ...(o.body !== undefined ? { body: o.body } : {}), redirect: 'error', signal });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new OidcError('response', `${o.what}: redirects are not followed (HTTP ${res.status})`);
    }
    text = await readBounded(res, MAX_RESPONSE_BYTES, o.what);
  } catch (err) {
    if (o.signal?.aborted) throw o.signal.reason;
    if (err instanceof OidcError) throw err;
    throw new OidcError('unreachable', `${o.what}: request failed (${timeout.aborted ? `timed out after ${o.timeoutMs}ms` : 'network error'})`);
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const obj = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  if (!res.ok) {
    const code = typeof obj?.error === 'string' && /^[\w.-]{1,64}$/.test(obj.error) ? obj.error : undefined;
    const desc = typeof obj?.error_description === 'string' ? scrub(obj.error_description).slice(0, 200) : undefined;
    throw new OidcError('response', `${o.what}: HTTP ${res.status}${code ? ` (${code}${desc ? `: ${desc}` : ''})` : ''}`);
  }
  if (!obj) throw new OidcError('response', `${o.what}: response is not a JSON object`);
  return obj;
}

/** Fetches an OpenID Provider configuration (OpenID Connect Discovery 1.0) and checks that it names `issuer`. */
export async function discover(fetchImpl: FetchLike, issuer: string, timeoutMs: number, allowHttp?: boolean): Promise<Record<string, unknown>> {
  secureUrl(issuer, 'issuer', allowHttp);
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const doc = await requestJson(fetchImpl, url, { method: 'GET', timeoutMs, what: 'OIDC discovery' });
  // Mix-up defence: the document must be the one of the expected issuer.
  if (doc.issuer !== issuer) throw new OidcError('config', 'OIDC discovery: the document names a different issuer');
  return doc;
}
