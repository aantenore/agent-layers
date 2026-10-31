import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export type HeaderMap = Record<string, string>;

/** Connection settings of one MCP server: exactly one of `command` (stdio) or `url` (streamable HTTP). */
export interface McpServerOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  /** Static headers (HTTP only). */
  headers?: Record<string, string>;
  /** HTTP only: bearer token for `audience` from the caller's credentials on every tool call. */
  auth?: { audience: string; scopes?: string[] };
  /** Per-request time limit (default 60000). */
  timeoutMs?: number;
}

/** The server answered with a JSON-RPC error. */
export class McpRpcError extends Error {
  override name = 'McpRpcError';
  readonly code: number | undefined;
  constructor(error: { code?: number; message?: string } | undefined) {
    super(`MCP error ${error?.code ?? ''}: ${error?.message ?? JSON.stringify(error)}`);
    this.code = error?.code;
  }
}

/** The server answered with a non-2xx HTTP status. */
export class McpHttpError extends Error {
  override name = 'McpHttpError';
  readonly status: number;
  constructor(status: number, body: string) {
    super(`MCP HTTP ${status}${body ? `: ${body}` : ''}`);
    this.status = status;
  }
}

export interface Transport {
  /** False once the connection is gone (a stdio process that exited). */
  readonly alive: boolean;
  /** True when the server assigned a session id. */
  readonly hasSession: boolean;
  request(method: string, params: unknown, signal?: AbortSignal, headers?: HeaderMap): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

/** Static headers plus credentials; a credential header replaces a static one of any letter case. */
export function withAuth(base: HeaderMap | undefined, auth: HeaderMap | undefined): HeaderMap {
  if (!auth) return { ...base };
  const names = new Set(Object.keys(auth).map((k) => k.toLowerCase()));
  return { ...Object.fromEntries(Object.entries(base ?? {}).filter(([k]) => !names.has(k.toLowerCase()))), ...auth };
}

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new DOMException('This operation was aborted', 'AbortError');

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void }

export class StdioTransport implements Transport {
  #child: ChildProcess;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #stderr = '';
  #timeoutMs: number;
  #alive = true;

  constructor(cfg: McpServerOptions, env: Record<string, string | undefined>, timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
    this.#child = spawn(cfg.command!, cfg.args ?? [], { cwd: cfg.cwd, env: { ...env, ...cfg.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child.stderr!.on('data', (d: Buffer) => { this.#stderr = (this.#stderr + d.toString()).slice(-2000); });
    createInterface({ input: this.#child.stdout! }).on('line', (line) => this.#onLine(line));
    const fail = (why: string) => {
      this.#alive = false;
      for (const p of this.#pending.values()) p.reject(new Error(`MCP server ${why}${this.#stderr ? `: ${this.#stderr.trim()}` : ''}`));
      this.#pending.clear();
    };
    this.#child.on('exit', (code) => fail(`exited with code ${code}`));
    this.#child.on('error', (err) => fail(`failed to start (${err.message})`));
    // A dead child closes stdin; a late write is reported through the pending request, not as an unhandled event.
    this.#child.stdin!.on('error', () => {});
  }

  get alive(): boolean { return this.#alive; }
  get hasSession(): boolean { return false; }

  #onLine(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; } // not protocol output
    if (msg.id !== undefined && msg.method) {
      // Server-initiated request: answer ping, decline everything else.
      this.#write({ jsonrpc: '2.0', id: msg.id, ...(msg.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'method not supported by client' } }) });
      return;
    }
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    if (msg.error) p.reject(new McpRpcError(msg.error));
    else p.resolve(msg.result);
  }

  #write(msg: unknown): void {
    this.#child.stdin!.write(`${JSON.stringify(msg)}\n`);
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    if (!this.#alive) return Promise.reject(new Error('MCP server is not running'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error(`MCP ${method} timed out after ${this.#timeoutMs}ms`)), this.#timeoutMs);
      const onAbort = () => {
        this.#write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
        done(abortReason(signal!));
      };
      const done = (err?: unknown, value?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.#pending.delete(id);
        err ? reject(err) : resolve(value);
      };
      if (signal?.aborted) return done(abortReason(signal));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, { resolve: (v) => done(undefined, v), reject: (e) => done(e) });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.#write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  async close(): Promise<void> {
    this.#alive = false;
    this.#child.stdin?.end();
    this.#child.kill();
  }
}

interface SseEvent { data: string }

/** Minimal Server-Sent Events reader over a fetch Response body. */
async function* readSse(res: Response): AsyncGenerator<SseEvent> {
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let finished = false;
  const parse = (raw: string): SseEvent | undefined => {
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      if ((i < 0 ? line : line.slice(0, i)) === 'data') data.push(i < 0 ? '' : line.slice(i + 1).replace(/^ /, ''));
    }
    return data.length ? { data: data.join('\n') } : undefined;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { finished = true; break; }
      buffer += value;
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const ev = parse(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (ev) yield ev;
      }
    }
    const tail = parse(buffer);
    if (tail) yield tail;
  } finally {
    if (!finished) await reader.cancel().catch(() => {}); // closes the connection when we stop early
    reader.releaseLock();
  }
}

export class HttpTransport implements Transport {
  #nextId = 1;
  #session: string | undefined;
  #protocol: string | undefined;
  #cfg: McpServerOptions;
  #timeoutMs: number;
  #connectHeaders: () => Promise<HeaderMap | undefined>;

  constructor(cfg: McpServerOptions, timeoutMs: number, connectHeaders: () => Promise<HeaderMap | undefined> = async () => undefined) {
    this.#cfg = cfg;
    this.#timeoutMs = timeoutMs;
    this.#connectHeaders = connectHeaders;
  }

  get alive(): boolean { return true; }
  get hasSession(): boolean { return this.#session !== undefined; }

  setProtocol(version: string): void {
    this.#protocol = version;
  }

  async #post(body: unknown, signal?: AbortSignal, headers?: HeaderMap): Promise<Response> {
    const auth = headers ?? (await this.#connectHeaders());
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const res = await fetch(this.#cfg.url!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.#session ? { 'mcp-session-id': this.#session } : {}),
        ...(this.#protocol ? { 'mcp-protocol-version': this.#protocol } : {}),
        ...withAuth(this.#cfg.headers, auth),
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    this.#session = res.headers.get('mcp-session-id') ?? this.#session;
    if (!res.ok) throw new McpHttpError(res.status, (await res.text().catch(() => '')).slice(0, 300));
    return res;
  }

  async request(method: string, params: unknown, signal?: AbortSignal, headers?: HeaderMap): Promise<any> {
    const id = this.#nextId++;
    const res = await this.#post({ jsonrpc: '2.0', id, method, params }, signal, headers);
    const pick = (msg: any) => {
      if (msg.error) throw new McpRpcError(msg.error);
      return msg.result;
    };
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for await (const ev of readSse(res)) {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { continue; }
        if (msg.id === id) return pick(msg);
      }
      throw new Error(`MCP ${method}: stream ended without a response`);
    }
    return pick(await res.json());
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const res = await this.#post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
    await res.body?.cancel();
  }

  async close(): Promise<void> {
    if (!this.#session) return;
    const auth = await this.#connectHeaders().catch(() => undefined);
    await fetch(this.#cfg.url!, {
      method: 'DELETE',
      headers: { 'mcp-session-id': this.#session, ...withAuth(this.#cfg.headers, auth) },
      signal: AbortSignal.timeout(this.#timeoutMs),
    }).catch(() => {});
  }
}
