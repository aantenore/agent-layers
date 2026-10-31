import type { IncomingMessage, ServerResponse } from 'node:http';

/** The request body is larger than the configured limit. */
export class BodyTooLarge extends Error {
  override name = 'BodyTooLarge';
}

/** Reads the whole body, refusing more than `limit` bytes (by Content-Length up front, then while reading). */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return size ? Buffer.concat(chunks) : undefined;
}

/** A web-standard Request for a node request whose body was already read. */
export function toRequest(req: IncomingMessage, origin: string, body: Buffer | undefined, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const value of Array.isArray(v) ? v : [v]) headers.append(k, value);
  }
  const method = req.method ?? 'GET';
  return new Request(new URL(req.url ?? '/', origin), {
    method,
    headers,
    signal,
    ...(body && method !== 'GET' && method !== 'HEAD' ? { body: new Uint8Array(body) } : {}),
  });
}

/** Writes a web-standard Response, streaming its body; stops when the client goes away. */
export async function writeResponse(res: ServerResponse, response: Response, extra: Record<string, string>): Promise<void> {
  const headers: Record<string, string | string[]> = { ...extra };
  response.headers.forEach((value, key) => { headers[key] = value; });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body) { res.end(); return; }
  const reader = response.body.getReader();
  const stop = () => { reader.cancel().catch(() => {}); };
  res.once('close', stop);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Streams (SSE) reach the client chunk by chunk.
      if (!res.write(value)) await new Promise<void>((r) => { res.once('drain', r); res.once('close', r); });
      if (res.destroyed) break;
    }
  } catch {
    // The route's stream failed or was cancelled: end what was sent.
  } finally {
    res.off('close', stop);
    if (!res.writableEnded) res.end();
  }
}

/** JSON error body in the shape most HTTP APIs of the inbound standards use: `{ error: { message, type } }`. */
export function errorResponse(status: number, message: string, type: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { message, type } }), { status, headers: { 'content-type': 'application/json', ...headers } });
}
