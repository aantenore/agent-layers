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
  /** Most sessions kept; the least recently used is dropped first (default 1000). */
  maxSessions?: number;
}

const SUPPORTED_VERSIONS = [MCP_PROTOCOL_VERSION, '2025-03-26', '2024-11-05'];
const SERVER_VERSION = '0.1.0';
const ANONYMOUS = '\u0000anonymous';

interface Session { owner: string; protocol: string; seen: number; inflight: Map<string | number, AbortController> }
interface RpcRequest { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> }

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

const rpcHeaders = { 'content-type': 'application/json' };
const jsonError = (status: number, code: number, message: string, id: RpcRequest['id'] = null) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { status, headers: rpcHeaders });

/** The caller a session belongs to: a session opened by one caller is not usable by another. */
const ownerOf = (ctx: InboundContext) => (ctx.identity ? `${ctx.identity.kind}:${ctx.identity.subject}` : ANONYMOUS);

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
  const visible = (tool: string) => (!options.include || matchesAny(options.include, tool)) && !(options.exclude && matchesAny(options.exclude, tool));

  return {
    name,
    mount(host: ChannelHost) {
      const sessions = new Map<string, Session>();
      // A host without tools (for example a test host) serves an empty tool list.
      const tools: ToolPort = host.tools?.() ?? { listTools: async () => [], callTool: async () => ({ content: 'no tools', isError: true }) };

      const sweep = () => {
        const now = Date.now();
        for (const [id, s] of sessions) if (now - s.seen > ttl) { for (const c of s.inflight.values()) c.abort(); sessions.delete(id); }
        while (sessions.size >= max) {
          const [oldest] = sessions.keys();
          sessions.delete(oldest!);
        }
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
          sweep();
          const asked = typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '';
          const protocol = SUPPORTED_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSION;
          const id = randomUUID();
          sessions.set(id, { owner: ownerOf(ctx), protocol, seen: Date.now(), inflight: new Map() });
          return reply(req, {
            jsonrpc: '2.0', id: m.id,
            result: { protocolVersion: protocol, capabilities: { tools: { listChanged: false } }, serverInfo: { name: options.serverName ?? 'agent-layers', version: SERVER_VERSION } },
          }, { 'mcp-session-id': id });
        }

        const id = req.headers.get('mcp-session-id');
        if (!id) return jsonError(400, -32600, 'missing Mcp-Session-Id: initialize first', m.id ?? null);
        const session = sessions.get(id);
        // A session of another caller looks exactly like an unknown one.
        if (session && Date.now() - session.seen > ttl) sessions.delete(id);
        if (!session || !sessions.has(id) || session.owner !== ownerOf(ctx)) return jsonError(404, -32001, 'session not found', m.id ?? null);
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
          if (!session || session.owner !== ownerOf(ctx)) return jsonError(404, -32001, 'session not found');
          for (const c of session.inflight.values()) c.abort();
          sessions.delete(id!);
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
