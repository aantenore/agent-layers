import { ANONYMOUS, anySignal, timeoutSignal, type AccessQuestion, type PublicCaller } from '@agent-layers/core';

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

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * The question as it may leave the stack. Only a caller of kind exactly `user` or `agent` with a non-empty id is kept
 * (roles and scopes as string lists, never a credential); anything else becomes the explicit anonymous caller, so a
 * policy cannot mistake it for the agent. Tool arguments are kept only with `includeArgs`.
 */
export function publicQuestion(q: AccessQuestion, includeArgs: boolean): AccessQuestion {
  const c = (isObject(q?.caller) ? q.caller : {}) as Partial<PublicCaller> & Record<string, unknown>;
  const known = (c.kind === 'user' || c.kind === 'agent') && typeof c.id === 'string' && c.id !== '';
  const caller: AccessQuestion['caller'] = known
    ? {
      id: c.id!, kind: c.kind!, roles: strings(c.roles), scopes: strings(c.scopes),
      ...(typeof c.name === 'string' ? { name: c.name } : {}),
      ...(isObject(c.ext) ? { ext: structuredClone(c.ext) } : {}),
    }
    : { ...ANONYMOUS, roles: [], scopes: [] };
  return {
    caller,
    action: q.action,
    target: structuredClone(q.target),
    ...(includeArgs && q.args !== undefined ? { args: structuredClone(q.args) } : {}),
    ...(isObject(q.ext) ? { ext: structuredClone(q.ext) } : {}),
  };
}

/** AuthZEN access evaluation request of a question already made public. */
export interface AuthzenRequest {
  subject: { type: string; id: string; properties: { roles: string[]; scopes: string[]; authenticated: boolean } };
  action: { name: string };
  resource: { type: string; id: string; properties: Record<string, unknown> };
  context?: { args?: Record<string, unknown> };
}

/**
 * The AuthZEN wire of a public question. `authenticated` is true only for a user or agent caller. The fixed target
 * fields (`risk`, `layer`, `agent`) are written after `attrs`, so an attribute can never override them.
 */
export function authzenRequest(q: AccessQuestion): AuthzenRequest {
  const c = q.caller;
  const t = q.target;
  return {
    subject: { type: c.kind, id: c.id, properties: { roles: [...c.roles], scopes: [...c.scopes], authenticated: c.kind === 'user' || c.kind === 'agent' } },
    action: { name: q.action },
    resource: { type: t.kind, id: t.id, properties: { ...t.attrs, risk: t.risk, layer: t.layer, agent: t.agent } },
    ...(q.args !== undefined ? { context: { args: q.args } } : {}),
  };
}

/** A reason string from a PDP value (a string, or the first string of a localised `{lang: text}` object), cut to `maxChars`. */
export function reasonText(value: unknown, maxChars: number): string | undefined {
  const text = typeof value === 'string' ? value
    : value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value).find((v): v is string => typeof v === 'string') : undefined;
  return text ? text.slice(0, maxChars) : undefined;
}
