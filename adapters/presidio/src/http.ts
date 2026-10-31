/** Minimal JSON-over-HTTP client for the guard adapters: fetch, a timeout, a bounded body, no response bodies in errors. */
import { anySignal, timeoutSignal } from '@agent-layers/core';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds; `Infinity` for none. */
  timeoutMs: number;
  /** Largest response body read, in bytes; `Infinity` for none. A larger body is cancelled, never buffered whole. */
  maxResponseBytes: number;
  fetch?: FetchLike;
}

/** The service answered, but not with what the contract says (not JSON, wrong shape). */
export class InvalidResponseError extends Error {
  override name = 'InvalidResponseError';
  constructor(what: string) { super(`${what} returned an invalid response`); }
}

/** The service answered with a body larger than `maxResponseBytes`. */
export class ResponseTooLargeError extends Error {
  override name = 'ResponseTooLargeError';
  constructor(what: string) { super(`${what} response is too large`); }
}

/** Reads a body up to `max` bytes: a declared or streamed size above it cancels the body and throws. */
export async function readBounded(res: Response, max: number, what: string): Promise<string> {
  if (Number(res.headers.get('content-length') ?? NaN) > max) {
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(what);
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
      throw new ResponseTooLargeError(what);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
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
 * POSTs JSON and returns the parsed body. Non-2xx answers, bodies over `maxResponseBytes` and non-JSON bodies throw.
 * Response bodies are left out of error messages: services often echo the text they were sent.
 */
export async function postJson(url: string, body: unknown, what: string, o: HttpOptions, signal?: AbortSignal): Promise<unknown> {
  const res = await (o.fetch ?? fetch)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...o.headers },
    body: JSON.stringify(body),
    signal: anySignal(signal, timeoutSignal(o.timeoutMs)),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HttpStatusError(res.status, what);
  }
  const text = await readBounded(res, o.maxResponseBytes, what);
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidResponseError(what);
  }
}

export const trimSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * Why a call failed, from a fixed set: `HTTP <status>`, `timeout`, `response too large`, `invalid response`,
 * `network error`. Error text is never used: it can echo URLs with credentials, headers or the text that was sent.
 */
export function failure(err: unknown): string {
  if (err instanceof HttpStatusError) return `HTTP ${err.status}`;
  if (err instanceof ResponseTooLargeError) return 'response too large';
  if (err instanceof InvalidResponseError) return 'invalid response';
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  return 'network error';
}

/** Throws unless `url` is an absolute URL without credentials: those belong in `headers` or `token`. */
export function assertPlainUrl(url: string, what: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`${what}: not a valid http(s) URL`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${what}: not a valid http(s) URL`);
  if (parsed.username || parsed.password) throw new Error(`${what}: the URL must not carry credentials; use headers or token`);
}
