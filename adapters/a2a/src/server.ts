import { createHash, randomUUID } from 'node:crypto';
import { defineLimits, limitValue, type ChannelHost, type ChannelPort, type InboundContext, type InboundRoute, type LimitValue, type RunResult, type TraceContext } from '@agent-layers/core';
import {
  A2A_VERSION, ERRORS, getResult, LEGACY_VERSION, METHODS, partsText, sendResult, streamEvent, TERMINAL,
  type TaskRunMetadata, type TaskState, type TaskValue, type WireVersion,
} from './wire.ts';

/** Options of the inbound descriptor. */
export interface A2AServerOptions {
  /** Path prefix of the agent endpoints: `<basePath>/<agent>` (default `/a2a`). */
  basePath?: string;
  /** Agents served: all of the stack's agents (default) or a list. */
  agents?: string[];
  /** Agent described by `/.well-known/agent-card.json` (default: the first served agent). */
  defaultAgent?: string;
  /** Description per agent in its card. */
  descriptions?: Record<string, string>;
  /** Version of the agents in their cards (default `0.1.0`). */
  version?: string;
  /** `provider` of the cards. */
  provider?: { organization: string; url: string };
  /** Tasks kept per authenticated caller, and of all anonymous callers together (default 100; at most a quarter of `maxTasks`). */
  maxTasksPerCaller?: LimitValue;
  /** Tasks kept in total (default 10000). */
  maxTasks?: LimitValue;
  /** How long a finished task stays readable with GetTask (default 3600000). */
  taskTtlMs?: number;
}

/** Configurable limits of the inbound descriptor; see docs/limits.md. */
export const SERVER_LIMITS = defineLimits({
  maxTasksPerCaller: { path: 'options.maxTasksPerCaller', default: 100, unit: 'count', min: 1, unbounded: 'fail', safe: { max: 1000 } },
  maxTasks: { path: 'options.maxTasks', default: 10_000, unit: 'count', min: 4, unbounded: 'fail', safe: { max: 100_000 } },
  taskTtlMs: { path: 'options.taskTtlMs', default: 3_600_000, unit: 'ms', min: 1000, safe: { max: 86_400_000 } },
});

interface StoredTask { value: TaskValue; owner: string; anonymous: boolean; finishedAt?: number; controller: AbortController; done: Promise<void> }
interface Rpc { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: Record<string, any> }

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

const ACCEPTED_VERSIONS = ['1.0', '1', '0.3', '0.3.0'];
/**
 * The owner of a task: an authenticated caller's kind and id. Anonymous callers cannot be told apart, so an
 * anonymous task is its own owner (keyed by its id): reachable only with its id, never by an authenticated caller.
 */
const ownerOf = (ctx: InboundContext, taskId: string) => (ctx.caller ? `id:${ctx.caller.kind}:${ctx.caller.id}` : `anon:${taskId}`);
const isJson = (req: Request) => /^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '');
const rpcResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Run status and stop code → task state; nothing else of the reason is read, and it never leaves the stack. A run that
 * was aborted is `canceled`; any other stop (a guard block, a denial, a limit) is a `rejected` task, since the stack
 * refused to carry on and the caller did not cancel. A waiting run asks for authorization (`auth-required`) or, for any
 * other code, for input (`input-required`).
 */
function stateOfRun(r: RunResult): TaskState {
  switch (r.status) {
    case 'completed': return 'completed';
    case 'stopped': return r.reason?.code === 'aborted' ? 'canceled' : 'rejected';
    case 'waiting': return r.reason?.code === 'needs_auth' ? 'auth-required' : 'input-required';
    default: return 'failed';
  }
}

/** Usage and cost of a run, in the language's names, for the task's `metadata["agent-layers"]`; absent parts are omitted. */
function runFigures(r: RunResult): TaskRunMetadata {
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  return {
    ...(r.usage && num(r.usage.inputTokens) && num(r.usage.outputTokens) ? { usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens } } : {}),
    ...(num(r.costUsd) ? { costUsd: r.costUsd } : {}),
  };
}

/** Status message per task state, fixed text apart from what the agent itself answered. */
const SAID: Partial<Record<TaskState, (r: RunResult) => string>> = {
  completed: (r) => r.output,
  rejected: () => 'The request was refused.',
  canceled: () => 'The task was canceled.',
  'input-required': (r) => r.output || 'The agent needs more input.',
  'auth-required': (r) => r.output || 'The agent needs authorization.',
};

/** Longest `traceparent` and `tracestate` copied from the request headers. */
const MAX_TRACE = { parent: 128, state: 512 };

/** The trace the request carried: the host's, else the W3C headers copied unchanged (nothing is parsed). */
function traceOf(req: Request, ctx: InboundContext): TraceContext | undefined {
  if (ctx.trace) return ctx.trace;
  const parent = req.headers.get('traceparent');
  if (!parent || parent.length > MAX_TRACE.parent) return undefined;
  const state = req.headers.get('tracestate');
  return { parent, ...(state && state.length <= MAX_TRACE.state ? { state } : {}) };
}

/**
 * Serves the stack's agents to other agents over A2A: an agent card per agent and the JSON-RPC methods of A2A 1.0
 * (SendMessage, SendStreamingMessage, GetTask, CancelTask), plus their 0.3 names. Runs go through the runtime with the
 * caller's identity. Mounted by the gateway, which authenticates callers; agent cards are public.
 */
export function createA2AServerChannel(options: A2AServerOptions = {}, name = 'a2a'): ChannelPort {
  const base = `/${(options.basePath ?? '/a2a').replace(/^\/+|\/+$/g, '')}`;
  const perCaller = limitValue(SERVER_LIMITS.maxTasksPerCaller, options.maxTasksPerCaller);
  const maxTasks = limitValue(SERVER_LIMITS.maxTasks, options.maxTasks);
  const taskTtl = limitValue(SERVER_LIMITS.taskTtlMs, options.taskTtlMs);
  if (perCaller > maxTasks / 4) throw new Error('maxTasksPerCaller must be at most a quarter of maxTasks');

  return {
    name,
    mount(host: ChannelHost) {
      const tasks = new Map<string, StoredTask>();
      const served = () => (options.agents ? host.agents().filter((a) => options.agents!.includes(a)) : host.agents());
      const endpoint = (origin: string, agent: string) => `${origin}${base}/${encodeURIComponent(agent)}`;

      function card(agent: string, origin: string) {
        const url = endpoint(origin, agent);
        return {
          name: agent,
          description: options.descriptions?.[agent] ?? `Agent ${agent}`,
          version: options.version ?? '0.1.0',
          supportedInterfaces: [
            { url, protocolBinding: 'JSONRPC', protocolVersion: A2A_VERSION },
            { url, protocolBinding: 'JSONRPC', protocolVersion: LEGACY_VERSION },
          ],
          // Read by 0.3 clients, which predate supportedInterfaces.
          url,
          preferredTransport: 'JSONRPC',
          ...(options.provider ? { provider: options.provider } : {}),
          capabilities: { streaming: true, pushNotifications: false },
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          skills: [{ id: agent, name: agent, description: options.descriptions?.[agent] ?? `Agent ${agent}`, tags: ['agent'] }],
          ...(host.verify ? { securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } } } : {}),
        };
      }

      const finished = (t: StoredTask) => t.finishedAt !== undefined;

      /**
       * Keeps the task store bounded. Finished tasks expire after `taskTtlMs`; an authenticated caller over its cap loses
       * its own oldest finished task; a full store drops the oldest finished task of the authenticated caller holding the
       * most. Tasks in progress are never dropped, nor are anonymous tasks dropped for a new one: then the task is refused.
       */
      function admit(anonymous: boolean, owner: string): void {
        const now = Date.now();
        for (const [id, t] of tasks) if (finished(t) && now - t.finishedAt! > taskTtl) tasks.delete(id);
        if (anonymous) {
          if ([...tasks.values()].filter((t) => t.anonymous).length >= perCaller) throw new RpcError(-32000, 'too many anonymous tasks, try again later');
        } else {
          const own = [...tasks].filter(([, t]) => t.owner === owner);
          const done = own.filter(([, t]) => finished(t));
          for (const [id] of done.slice(0, Math.max(0, own.length - perCaller + 1))) tasks.delete(id);
          if (own.length - done.length >= perCaller) throw new RpcError(-32000, 'too many tasks in progress for this caller');
        }
        if (tasks.size < maxTasks) return;
        const counts = new Map<string, number>();
        for (const t of tasks.values()) if (!t.anonymous) counts.set(t.owner, (counts.get(t.owner) ?? 0) + 1);
        const byCount = [...counts].sort((a, b) => b[1] - a[1]).map(([o]) => o);
        for (const o of byCount) {
          const victim = [...tasks].find(([, t]) => t.owner === o && finished(t));
          if (victim) { tasks.delete(victim[0]); return; }
        }
        throw new RpcError(-32000, 'too many tasks, try again later');
      }

      /** Starts the run of a task; resolves when it has finished. */
      function start(agent: string, text: string, contextId: string, ctx: InboundContext, trace: TraceContext | undefined): StoredTask {
        const id = randomUUID();
        const owner = ownerOf(ctx, id);
        admit(!ctx.caller, owner);
        const controller = new AbortController();
        const value: TaskValue = { id, contextId, state: 'working', timestamp: new Date().toISOString() };
        // The session log of a context belongs to one caller: the same contextId from another caller is another session.
        const sessionId = `a2a-${createHash('sha256').update(owner).digest('hex').slice(0, 16)}-${contextId}`;
        const done = host.run(agent, text, {
          runId: id, sessionId, signal: controller.signal, ...(ctx.caller ? { caller: ctx.caller } : {}), ...(trace ? { trace } : {}),
        }).then((r) => {
          value.state = value.state === 'canceled' ? 'canceled' : stateOfRun(r);
          if (value.state === 'completed') value.answer = r.output;
          // Usage and cost travel in the task's metadata, so a calling stack can account for this run.
          const metadata = runFigures(r);
          if (Object.keys(metadata).length) value.metadata = metadata;
          const said = SAID[value.state]?.(r) ?? 'The agent run failed.';
          value.status = { messageId: randomUUID(), role: 'agent', text: said, contextId, taskId: id };
        }, () => {
          value.state = value.state === 'canceled' ? 'canceled' : 'failed';
          value.status = { messageId: randomUUID(), role: 'agent', text: 'The agent run failed.', contextId, taskId: id };
        }).finally(() => { value.timestamp = new Date().toISOString(); stored.finishedAt = Date.now(); });
        const stored: StoredTask = { value, owner, anonymous: !ctx.caller, controller, done };
        tasks.set(id, stored);
        return stored;
      }

      function readMessage(params: Record<string, any> | undefined): { text: string; contextId: string } {
        const m = params?.message;
        if (!m || typeof m !== 'object') throw new RpcError(-32602, 'params.message is required');
        if (m.role !== 'ROLE_USER' && m.role !== 'user') throw new RpcError(-32602, 'message.role must be the user role');
        const text = partsText(m.parts);
        if (!text.trim()) throw new RpcError(-32602, 'message.parts has no text');
        const contextId = typeof m.contextId === 'string' && /^[\w.:-]{1,128}$/.test(m.contextId) ? m.contextId : randomUUID();
        return { text, contextId };
      }

      function owned(params: Record<string, any> | undefined, ctx: InboundContext): StoredTask {
        const t = typeof params?.id === 'string' ? tasks.get(params.id) : undefined;
        // A task of another caller is answered like an unknown one.
        if (!t || t.owner !== ownerOf(ctx, t.value.id)) throw new RpcError(ERRORS.taskNotFound, 'task not found');
        return t;
      }

      function stream(rpcId: Rpc['id'], agent: string, params: Rpc['params'], ctx: InboundContext, v: WireVersion, trace: TraceContext | undefined): Response {
        const { text, contextId } = readMessage(params);
        const task = start(agent, text, contextId, ctx, trace);
        const enc = new TextEncoder();
        const frame = (result: unknown) => enc.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpcId, result })}\n\n`);
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(frame(streamEvent('task', task.value, v)));
            await task.done;
            if (task.value.answer !== undefined) controller.enqueue(frame(streamEvent('artifact', task.value, v)));
            controller.enqueue(frame(streamEvent('status', task.value, v)));
            controller.close();
          },
          cancel() { task.controller.abort(); },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
      }

      async function rpc(req: Request, ctx: InboundContext, agent: string): Promise<Response> {
        if (!isJson(req)) return rpcResponse({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Content-Type must be application/json' } }, 415);
        let msg: Rpc;
        try { msg = JSON.parse(await req.text()) as Rpc; } catch { return rpcResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
          return rpcResponse({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
        }
        const id = msg.id ?? null;
        try {
          const version = req.headers.get('a2a-version');
          if (version && !ACCEPTED_VERSIONS.includes(version.trim())) throw new RpcError(ERRORS.versionNotSupported, `A2A version ${version} is not supported (1.0, 0.3)`);
          const method = METHODS[msg.method];
          if (!method) throw new RpcError(-32601, `method not found: ${msg.method}`);
          const v = method.version;
          switch (method.op) {
            case 'send': {
              const { text, contextId } = readMessage(msg.params);
              const task = start(agent, text, contextId, ctx, traceOf(req, ctx));
              const cfg = msg.params?.configuration ?? {};
              const immediate = v === A2A_VERSION ? cfg.returnImmediately === true : cfg.blocking === false;
              if (!immediate) await task.done;
              return rpcResponse({ jsonrpc: '2.0', id, result: sendResult(task.value, v) });
            }
            case 'stream':
              return stream(id, agent, msg.params, ctx, v, traceOf(req, ctx));
            case 'get':
              return rpcResponse({ jsonrpc: '2.0', id, result: getResult(owned(msg.params, ctx).value, v) });
            case 'cancel': {
              const t = owned(msg.params, ctx);
              if (TERMINAL.includes(t.value.state)) throw new RpcError(ERRORS.taskNotCancelable, 'task is not cancelable');
              t.value.state = 'canceled';
              t.controller.abort();
              await t.done;
              return rpcResponse({ jsonrpc: '2.0', id, result: getResult(t.value, v) });
            }
          }
        } catch (err) {
          // Only protocol errors carry their message.
          const e = err instanceof RpcError ? err : new RpcError(-32603, 'internal error');
          return rpcResponse({ jsonrpc: '2.0', id, error: { code: e.code, message: e.message } });
        }
      }

      const agentOf = (path: string): { agent: string; rest: string } | undefined => {
        const tail = path.slice(base.length + 1);
        const slash = tail.indexOf('/');
        const agent = decodeURIComponent(slash < 0 ? tail : tail.slice(0, slash));
        return served().includes(agent) ? { agent, rest: slash < 0 ? '' : tail.slice(slash) } : undefined;
      };
      const notFound = () => Response.json({ error: { message: 'unknown agent', type: 'not_found_error' } }, { status: 404 });

      const routes: InboundRoute[] = [
        {
          path: '/.well-known/agent-card.json', methods: ['GET'], public: true,
          async handle(_req, ctx) {
            const agent = options.defaultAgent && served().includes(options.defaultAgent) ? options.defaultAgent : served()[0];
            return agent ? Response.json(card(agent, ctx.origin)) : notFound();
          },
        },
        {
          path: `${base}/*`, methods: ['GET'], public: true,
          async handle(req, ctx) {
            const hit = agentOf(new URL(req.url).pathname);
            return hit && hit.rest === '/.well-known/agent-card.json' ? Response.json(card(hit.agent, ctx.origin)) : notFound();
          },
        },
        {
          path: `${base}/*`, methods: ['POST'],
          async handle(req, ctx) {
            const hit = agentOf(new URL(req.url).pathname);
            return hit && hit.rest === '' ? rpc(req, ctx, hit.agent) : notFound();
          },
        },
      ];
      return {
        routes,
        async close() {
          for (const t of tasks.values()) t.controller.abort();
          await Promise.allSettled([...tasks.values()].map((t) => t.done));
          tasks.clear();
        },
      };
    },
  };
}

