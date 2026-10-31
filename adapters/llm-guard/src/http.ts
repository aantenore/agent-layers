/** Minimal JSON-over-HTTP client for the guard adapters: fetch, a timeout, no response bodies in errors. */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  fetch?: FetchLike;
}

export class HttpStatusError extends Error {
  override name = 'HttpStatusError';
  readonly status: number;
  constructor(status: number, what: string) {
    super(`${what} answered HTTP ${status}`);
    this.status = status;
  }
}

/**
 * POSTs JSON and returns the parsed body. Non-2xx answers and non-JSON bodies throw. Response bodies are left out of
 * error messages: services often echo the text they were sent.
 */
export async function postJson(url: string, body: unknown, what: string, o: HttpOptions, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(o.timeoutMs);
  const res = await (o.fetch ?? fetch)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...o.headers },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HttpStatusError(res.status, what);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`${what} did not return JSON`);
  }
}

export const trimSlash = (url: string) => url.replace(/\/+$/, '');

/** Short, safe description of a failure for a verdict reason. */
export function failure(err: unknown): string {
  if (err instanceof HttpStatusError) return `HTTP ${err.status}`;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  return err instanceof Error ? err.message.slice(0, 120) : 'error';
}
