import { anySignal, timeoutSignal, type AccessRequest } from '@agent-layers/core';

/** Failure to reach or understand the policy decision point. The stack turns it into a deny. */
export class PdpError extends Error {
  override name = 'PdpError';
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const isLoopback = (host: string) =>
  host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);

/** Refuses plain HTTP outside loopback hosts (unless `allowHttp`) and credentials embedded in the URL. */
export function secureUrl(url: string, what: string, allowHttp = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PdpError(`${what}: invalid URL`);
  }
  if (parsed.username || parsed.password) throw new PdpError(`${what}: credentials in the URL are not accepted`);
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'http:' && (allowHttp || isLoopback(parsed.hostname))) return parsed;
  throw new PdpError(`${what}: "${parsed.origin}" must use https (plain http only on loopback hosts or with allowHttp)`);
}

async function readBounded(res: Response, max: number, what: string): Promise<string> {
  if (Number(res.headers.get('content-length') ?? NaN) > max) {
    await res.body?.cancel().catch(() => {});
    throw new PdpError(`${what}: response too large`);
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
      throw new PdpError(`${what}: response too large`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** POSTs JSON (redirects refused, bounded body, timeout) and returns the parsed JSON object answer. */
export async function postJson(fetchImpl: FetchLike, url: string, payload: unknown, o: { headers?: Record<string, string>; timeoutMs: number; maxResponseBytes: number; what: string; signal?: AbortSignal }): Promise<Record<string, unknown>> {
  const timeout = timeoutSignal(o.timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { ...o.headers, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: anySignal(o.signal, timeout),
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new PdpError(`${o.what}: redirects are not followed (HTTP ${res.status})`);
    }
    text = await readBounded(res, o.maxResponseBytes, o.what);
  } catch (err) {
    if (o.signal?.aborted) throw o.signal.reason;
    if (err instanceof PdpError) throw err;
    throw new PdpError(`${o.what}: request failed (${timeout?.aborted ? `timed out after ${o.timeoutMs}ms` : 'network error'})`);
  }
  if (!res.ok) throw new PdpError(`${o.what}: HTTP ${res.status}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new PdpError(`${o.what}: response is not JSON`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PdpError(`${o.what}: response is not a JSON object`);
  return body as Record<string, unknown>;
}

const ANONYMOUS: AccessRequest['subject'] = { type: 'anonymous', id: 'anonymous', properties: { roles: [], scopes: [], authenticated: false } };

/**
 * The request as sent to the PDP. Only an authenticated subject of type exactly `user` or `agent` is passed on (with
 * `authenticated: true`); anything else becomes the anonymous subject, so a policy cannot mistake it for the agent.
 * Tool arguments are sent only with `includeArgs`.
 */
export function pdpRequest(req: AccessRequest, includeArgs: boolean): AccessRequest {
  const s = req.subject;
  const props = s?.properties ?? {};
  const authenticated = (s?.type === 'user' || s?.type === 'agent') && typeof s.id === 'string' && s.id !== '' && props.authenticated !== false;
  const subject = authenticated ? { type: s.type, id: s.id, properties: { ...props, authenticated: true } } : structuredClone(ANONYMOUS);
  const { args: _args, ...context } = req.context ?? {};
  const ctx = includeArgs && req.context && 'args' in req.context ? { ...context, args: req.context.args } : context;
  return { subject, action: req.action, resource: req.resource, ...(Object.keys(ctx).length ? { context: ctx } : {}) };
}

/** A reason string from a PDP value (a string, or the first string of a localised `{lang: text}` object), cut to `maxChars`. */
export function reasonText(value: unknown, maxChars: number): string | undefined {
  const text = typeof value === 'string' ? value
    : value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value).find((v): v is string => typeof v === 'string') : undefined;
  return text ? text.slice(0, maxChars) : undefined;
}
