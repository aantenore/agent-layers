import { limitValue, traceHeaders, type BoundCredentials, type TelemetryPort } from '@agent-layers/core';
import { CONNECTION_LIMITS } from './limits.ts';
import { HttpTransport, McpHttpError, StdioTransport, type HeaderMap, type McpServerOptions, type Transport, type TransportLimits } from './transport.ts';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** What a connection needs besides its config: environment, connection credentials, and telemetry for trace context. */
export interface McpConnectDeps { env?: Record<string, string | undefined>; credentials?: BoundCredentials; telemetry?: TelemetryPort }
const CLIENT_INFO = { name: 'agent-layers-mcp', version: '0.1.0' };

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [k: string]: unknown };
}

export interface McpCallResult { content: string; isError: boolean; structured?: unknown }

export const bearer = (token: string): HeaderMap => ({ authorization: `Bearer ${token}` });

/** Validates the transport choice of a server config; returns a message or undefined. */
export function serverProblem(cfg: McpServerOptions): string | undefined {
  if (!cfg.command === !cfg.url) return 'set exactly one of "command" (stdio) or "url" (streamable HTTP)';
  if (cfg.auth && !cfg.url) return '"auth" needs the streamable HTTP transport ("url")';
  return undefined;
}

/** The connection limits of a server config: the configured values, else the defaults. */
export const connectionLimits = (cfg: McpServerOptions): TransportLimits => ({
  timeoutMs: limitValue(CONNECTION_LIMITS.timeoutMs, cfg.timeoutMs),
  errorBodyChars: limitValue(CONNECTION_LIMITS.errorBodyChars, cfg.errorBodyChars),
  minSecretChars: limitValue(CONNECTION_LIMITS.minSecretChars, cfg.minSecretChars),
  stderrChars: limitValue(CONNECTION_LIMITS.stderrChars, cfg.stderrChars),
});

/** One initialized MCP session over stdio or streamable HTTP. */
export class McpClient {
  readonly serverInfo: unknown;
  #transport: Transport;

  private constructor(transport: Transport, serverInfo: unknown) {
    this.#transport = transport;
    this.serverInfo = serverInfo;
  }

  /** `credentials` authorize the connection requests (initialize, tools/list, session close) when `auth` is set. */
  static async connect(cfg: McpServerOptions, deps: McpConnectDeps = {}): Promise<McpClient> {
    const problem = serverProblem(cfg);
    if (problem) throw new Error(`MCP server: ${problem}`);
    const limits = connectionLimits(cfg);
    const connectHeaders = async () => (cfg.auth && deps.credentials ? bearer(await deps.credentials.token(cfg.auth.audience, cfg.auth.scopes ? { scopes: cfg.auth.scopes } : {})) : undefined);
    const transport = cfg.command ? new StdioTransport(cfg, deps.env ?? process.env, limits) : new HttpTransport(cfg, limits, connectHeaders, () => traceHeaders(deps.telemetry));
    try {
      const init = await transport.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
      if (transport instanceof HttpTransport) transport.setProtocol(init?.protocolVersion ?? MCP_PROTOCOL_VERSION);
      await transport.notify('notifications/initialized');
      return new McpClient(transport, init?.serverInfo);
    } catch (err) {
      await transport.close();
      throw err;
    }
  }

  get alive(): boolean { return this.#transport.alive; }
  get hasSession(): boolean { return this.#transport.hasSession; }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#transport.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(page?.tools ?? []));
      cursor = page?.nextCursor;
    } while (cursor);
    return tools;
  }

  /** `headers` (HTTP only) replace the connection credentials for this call, for example a per-run Authorization. */
  async callTool(name: string, args: unknown, signal?: AbortSignal, headers?: HeaderMap): Promise<McpCallResult> {
    const res = await this.#transport.request('tools/call', { name, arguments: args ?? {} }, signal, headers);
    const text = (res?.content ?? [])
      .map((c: any) => (c.type === 'text' ? c.text : c.type === 'resource' ? (c.resource?.text ?? `[resource ${c.resource?.uri}]`) : `[${c.type}]`))
      .join('\n');
    const structured = res?.structuredContent;
    return { content: text || (structured !== undefined ? JSON.stringify(structured) : ''), isError: Boolean(res?.isError), ...(structured !== undefined ? { structured } : {}) };
  }

  close(): Promise<void> {
    return this.#transport.close();
  }
}

/**
 * A lazily connected client shared by the calls of one port instance. Reconnects when a stdio server has exited or an
 * HTTP session has expired (404), and retries the connection after a failure.
 */
export class McpSession {
  #cfg: McpServerOptions;
  #deps: McpConnectDeps;
  #client: Promise<McpClient> | undefined;

  constructor(cfg: McpServerOptions, deps: McpConnectDeps = {}) {
    this.#cfg = cfg;
    this.#deps = deps;
  }

  /** `credentials` are used for the connection unless the session was given its own. */
  async client(credentials?: BoundCredentials): Promise<McpClient> {
    if (this.#client) {
      const current = await this.#client.catch(() => undefined);
      if (current?.alive) return current;
      this.#client = undefined;
    }
    const pending = McpClient.connect(this.#cfg, { ...this.#deps, ...(this.#deps.credentials || !credentials ? {} : { credentials }) });
    this.#client = pending;
    pending.catch(() => { if (this.#client === pending) this.#client = undefined; });
    return pending;
  }

  /** Runs `fn` on the client; one retry on a fresh connection when the HTTP session has expired. */
  async run<T>(fn: (client: McpClient) => Promise<T>, credentials?: BoundCredentials): Promise<T> {
    const client = await this.client(credentials);
    try {
      return await fn(client);
    } catch (err) {
      if (!(err instanceof McpHttpError && err.status === 404 && client.hasSession)) throw err;
      if (this.#client && (await this.#client.catch(() => undefined)) === client) this.#client = undefined;
      await client.close().catch(() => {});
      return fn(await this.client(credentials));
    }
  }

  async close(): Promise<void> {
    const pending = this.#client;
    this.#client = undefined;
    await (await pending?.catch(() => undefined))?.close();
  }
}
