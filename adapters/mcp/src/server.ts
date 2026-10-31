import { randomUUID } from 'node:crypto';
import { matchesAny, type CallContext, type ChannelHost, type ChannelPort, type InboundContext, type InboundRoute, type ToolPort, type ToolSpec } from '@agent-layers/core';
import { MCP_PROTOCOL_VERSION } from './client.ts';

/** Options of the inbound descriptor. */
export interface McpServerChannelOptions {
  /** Endpoint path (default `/mcp`). */
  path?: string;
  /** Globs of the stack's tool names to expose (default: all, knowledge sources included). */
  include?: string[];
  /** Globs of tool names to hide. */
  exclude?: string[];
  /** Name the stack reports in `serverInfo` (default `agent-layers`). */
  serverName?: string;
  /** Answer requests with a one-event SSE stream instead of JSON (default false: JSON unless the client accepts only SSE). */
  sse?: boolean;
  /** Idle time after which a session is forgotten (default 1800000). */
  sessionTtlMs?: number;
  /** Absolute lifetime of a session, however active (default 3600000). */
  maxSessionAgeMs?: number;
  /**
   * Most sessions in total (default 1000). When reached, the least recently used session of the authenticated caller
   * holding the most sessions makes room; anonymous sessions are never evicted for a new one.
   */
  maxSessions?: number;
  /**
   * Most sessions per authenticated caller, and of all anonymous callers together (default 10; at most a quarter of
   * `maxSessions`). A caller's own least recently used session makes room for its new one; a full anonymous pool answers 429.
   */
  maxSessionsPerCaller?: number;
}

const SUPPORTED_VERSIONS = [MCP_PROTOCOL_VERSION, '2025-03-26', '2024-11-05'];
const SERVER_VERSION = '0.1.0';

interface Session { owner: string; anonymous: boolean; protocol: string; created: number; seen: number; inflight: Map<string | number, AbortController> }
interface RpcRequest { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> }

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

const rpcHeaders = { 'content-type': 'application/json' };
const jsonError = (status: number, code: number, message: string, id: RpcRequest['id'] = null) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { status, headers: rpcHeaders });

/**
 * The owner a request acts for: an authenticated caller's kind and subject. Anonymous callers cannot be told apart, so an
 * anonymous session is its own owner (keyed by its id) and is never usable by an authenticated caller.
 */
const ownerOf = (ctx: InboundContext, sessionId: string) => (ctx.identity ? `id:${ctx.identity.kind}:${ctx.identity.subject}` : `anon:${sessionId}`);

/** MCP tool description of a governed tool: risk becomes the read-only and destructive hints. */
function toMcpTool(spec: ToolSpec) {
  const risk = spec.risk ?? 'exec';
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema && typeof spec.inputSchema === 'object' ? { type: 'object', ...spec.inputSchema } : { type: 'object' },
    annotations: { readOnlyHint: risk === 'read', destructiveHint: risk === 'exec' },
  };
}

/**
 * Serves the stack's governed tools (authorization, approval, guards, credentials on behalf of the caller, telemetry)
 * and its knowledge sources as an MCP server over streamable HTTP. Mounted by the gateway, which authenticates callers.
 */
export function createMcpServerChannel(options: McpServerChannelOptions = {}, name = 'mcp'): ChannelPort {
  const path = options.path ?? '/mcp';
  const ttl = options.sessionTtlMs ?? 30 * 60_000;
  const max = options.maxSessions ?? 1000;
  const perCaller = options.maxSessionsPerCaller ?? 10;
  const maxAge = options.maxSessionAgeMs ?? 60 * 60_000;
  if (perCaller > max / 4) throw new Error('maxSessionsPerCaller must be at most a quarter of maxSessions');
  const visible = (tool: string) => (!options.include || matchesAny(options.include, tool)) && !(options.exclude && matchesAny(options.exclude, tool));

  return {
    name,
    mount(host: ChannelHost) {
      const sessions = new Map<string, Session>();
      // A host without tools (for example a test host) serves an empty tool list.
      const tools: ToolPort = host.tools?.() ?? { listTools: async () => [], callTool: async () => ({ content: 'no tools', isError: true }) };

      const drop = (id: string) => {
        const s = sessions.get(id);
        if (!s) return;
        for (const c of s.inflight.values()) c.abort();
        sessions.delete(id);
      };

      const expired = (s: Session, now = Date.now()) => now - s.seen > ttl || now - s.created > maxAge;

      /**
       * Makes room for a new session: forgets expired sessions; an authenticated caller over its cap loses its own least
       * recently used session; when the server is full, the authenticated caller holding the most sessions loses its least
       * recently used one. Anonymous sessions are never evicted for a new session: a full anonymous pool, or a server full
       * of anonymous sessions, answers false (429).
       */
      const makeRoom = (anonymous: boolean, owner: string): boolean => {
        const now = Date.now();
        for (const [id, s] of sessions) if (expired(s, now)) drop(id);
        // Map order is least recently used first.
        if (anonymous) {
          if ([...sessions.values()].filter((s) => s.anonymous).length >= perCaller) return false;
        } else {
          const own = [...sessions].filter(([, s]) => s.owner === owner).map(([id]) => id);
          for (const id of own.slice(0, Math.max(0, own.length - perCaller + 1))) drop(id);
        }
        if (sessions.size < max) return true;
        if (anonymous) return false;
        const counts = new Map<string, number>();
        for (const s of sessions.values()) if (!s.anonymous) counts.set(s.owner, (counts.get(s.owner) ?? 0) + 1);
        const top = Math.max(0, ...counts.values());
        const victim = [...sessions].find(([, s]) => !s.anonymous && counts.get(s.owner) === top);
        if (!victim) return false;
        drop(victim[0]);
        return true;
      };

      const callContext = (ctx: InboundContext, signal: AbortSignal): CallContext => ({
        runId: randomUUID(), agent: name, signal, ...(ctx.identity ? { identity: ctx.identity } : {}),
      });

      async function dispatch(msg: RpcRequest, session: Session, ctx: InboundContext): Promise<unknown> {
        switch (msg.method) {
          case 'ping':
            return {};
          case 'tools/list': {
            const specs = await tools.listTools(callContext(ctx, ctx.signal));
            return { tools: specs.filter((s) => visible(s.name)).map(toMcpTool) };
          }
          case 'tools/call': {
            const tool = msg.params?.name;
            const args = msg.params?.arguments ?? {};
            if (typeof tool !== 'string' || !visible(tool)) throw new RpcError(-32602, `unknown tool: ${String(tool)}`);
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw new RpcError(-32602, 'arguments must be an object');
            const known = (await tools.listTools(callContext(ctx, ctx.signal))).some((s) => s.name === tool);
            if (!known) throw new RpcError(-32602, `unknown tool: ${tool}`);
            const controller = new AbortController();
            const key = msg.id ?? randomUUID();
            session.inflight.set(key, controller);
            try {
              const out = await tools.callTool(tool, args as Record<string, unknown>, callContext(ctx, AbortSignal.any([ctx.signal, controller.signal])));
              const structured = out.data && typeof out.data === 'object' && !Array.isArray(out.data) ? { structuredContent: out.data } : {};
              return { content: [{ type: 'text', text: out.content }], isError: !!out.isError, ...structured };
            } finally {
              session.inflight.delete(key);
            }
          }
          default:
            throw new RpcError(-32601, `method not found: ${msg.method}`);
        }
      }

      function reply(req: Request, body: unknown, headers: Record<string, string> = {}): Response {
        const accept = req.headers.get('accept') ?? '';
        const sse = options.sse || (accept.includes('text/event-stream') && !accept.includes('application/json') && !accept.includes('*/*'));
        if (!sse) return new Response(JSON.stringify(body), { headers: { ...rpcHeaders, ...headers } });
        return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers } });
      }

      async function post(req: Request, ctx: InboundContext): Promise<Response> {
        if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return jsonError(415, -32600, 'Content-Type must be application/json');
        let msg: unknown;
        try { msg = JSON.parse(await req.text()); } catch { return jsonError(400, -32700, 'parse error'); }
        if (Array.isArray(msg)) return jsonError(400, -32600, 'batches are not supported');
        if (!msg || typeof msg !== 'object' || (msg as RpcRequest).jsonrpc !== '2.0') return jsonError(400, -32600, 'invalid request');
        const m = msg as RpcRequest & { result?: unknown; error?: unknown };
        const isRequest = typeof m.method === 'string' && m.id !== undefined && m.id !== null;
        const version = req.headers.get('mcp-protocol-version');
        if (version && !SUPPORTED_VERSIONS.includes(version)) return jsonError(400, -32600, `unsupported protocol version ${version}`, m.id ?? null);

        if (m.method === 'initialize') {
          if (!isRequest) return jsonError(400, -32600, 'initialize must be a request');
          const id = randomUUID();
          if (!makeRoom(!ctx.identity, ownerOf(ctx, id))) return jsonError(429, -32000, 'too many sessions, try again later', m.id);
          const asked = typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '';
          const protocol = SUPPORTED_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSION;
          const now = Date.now();
          sessions.set(id, { owner: ownerOf(ctx, id), anonymous: !ctx.identity, protocol, created: now, seen: now, inflight: new Map() });
          return reply(req, {
            jsonrpc: '2.0', id: m.id,
            result: { protocolVersion: protocol, capabilities: { tools: { listChanged: false } }, serverInfo: { name: options.serverName ?? 'agent-layers', version: SERVER_VERSION } },
          }, { 'mcp-session-id': id });
        }

        const id = req.headers.get('mcp-session-id');
        if (!id) return jsonError(400, -32600, 'missing Mcp-Session-Id: initialize first', m.id ?? null);
        const session = sessions.get(id);
        // A session of another caller looks exactly like an unknown one.
        if (session && expired(session)) drop(id);
        if (!session || !sessions.has(id) || session.owner !== ownerOf(ctx, id)) return jsonError(404, -32001, 'session not found', m.id ?? null);
        session.seen = Date.now();
        // Re-insert: the map order is the least-recently-used order.
        sessions.delete(id);
        sessions.set(id, session);

        if (!isRequest) {
          if (m.method === 'notifications/cancelled') {
            const target = (m.params as { requestId?: string | number } | undefined)?.requestId;
            if (target !== undefined) session.inflight.get(target)?.abort();
          }
          // Notifications and responses to server requests: accepted, nothing to answer.
          return new Response(null, { status: 202 });
        }
        try {
          return reply(req, { jsonrpc: '2.0', id: m.id, result: await dispatch(m, session, ctx) });
        } catch (err) {
          // Only protocol errors carry their message; anything else could echo an upstream body.
          const e = err instanceof RpcError ? err : new RpcError(-32603, 'internal error');
          return reply(req, { jsonrpc: '2.0', id: m.id, error: { code: e.code, message: e.message } });
        }
      }

      const route: InboundRoute = {
        path,
        methods: ['POST', 'GET', 'DELETE'],
        async handle(req, ctx) {
          if (req.method === 'POST') return post(req, ctx);
          if (req.method === 'GET') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
          const id = req.headers.get('mcp-session-id');
          const session = id ? sessions.get(id) : undefined;
          if (!session || session.owner !== ownerOf(ctx, id!)) return jsonError(404, -32001, 'session not found');
          drop(id!);
          return new Response(null, { status: 204 });
        },
      };

      return {
        routes: [route],
        async close() {
          for (const s of sessions.values()) for (const c of s.inflight.values()) c.abort();
          sessions.clear();
        },
      };
    },
  };
}
