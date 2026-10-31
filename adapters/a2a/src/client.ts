import { randomUUID } from 'node:crypto';
import {
  activeTrace, anySignal, ATTR, defineLimits, isAbort, limitValue, messageText, noMappings, timeoutSignal,
  type CallContext, type LimitValue, type Mappings, type RunInput, type RunResult, type RuntimePort, type Stack, type StopReason,
} from '@agent-layers/core';
import { A2A_VERSION, INTERRUPTED, LEGACY_VERSION, messageWire, METHOD_OF, readResult, TERMINAL, type TaskState, type WireVersion } from './wire.ts';

/** Options of the outbound descriptor: a remote A2A agent as the stack's runtime. */
export interface A2ARuntimeOptions {
  /** Agent card URL (`.../agent-card.json`) or the agent's JSON-RPC endpoint. */
  url: string;
  /** The JSON-RPC endpoint, when the card is not to be trusted for it; the card is then not read. */
  endpoint?: string;
  /** Endpoints (URLs or origins) a card may point to besides its own origin. */
  allowedEndpoints?: string[];
  /** Allow plain http to hosts that are not loopback (default false). */
  allowHttp?: boolean;
  /** Protocol version spoken to the remote agent (default `1.0`). */
  version?: WireVersion;
  /** Bearer token for `audience` from the stack's credentials, on behalf of the caller of the run. */
  auth?: { audience: string; scopes?: string[] };
  /** Static headers (for example an API key header of the remote platform). */
  headers?: Record<string, string>;
  /** Time limit of a whole run, polling included (default 300000). */
  timeoutMs?: LimitValue;
  /** Interval between GetTask calls while a task is still working (default 500). */
  pollMs?: number;
}

/** Configurable limits of the outbound descriptor; see docs/limits.md. */
export const RUNTIME_LIMITS = defineLimits({
  timeoutMs: { path: 'options.timeoutMs', default: 300_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 3_600_000 } },
  pollMs: { path: 'options.pollMs', default: 500, unit: 'ms', min: 10, safe: { min: 100, max: 10_000 } },
});

const RUN_FAILED = 'remote agent call failed';

/** Loopback, private, link-local and unspecified addresses, and `localhost` names, written literally in a URL. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h.replace(/^::ffff:/, ''));
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

const isLoopback = (hostname: string) => {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
};

/** Last user text of a run input: the message the remote agent receives. */
function inputText(input: RunInput): string {
  if (typeof input === 'string') return input;
  for (let i = input.messages.length - 1; i >= 0; i--) if (input.messages[i]!.role === 'user') return messageText(input.messages[i]);
  return '';
}

/** Remote task state → run status and stop code (the reason is completed with `layer` and `by` by the caller). */
function runStatus(state: TaskState): { status: RunResult['status']; code?: string } {
  switch (state) {
    case 'completed': return { status: 'completed' };
    case 'canceled': return { status: 'stopped', code: 'aborted' };
    case 'rejected': return { status: 'stopped', code: 'rejected' };
    case 'input-required': return { status: 'waiting', code: 'needs_input' };
    case 'auth-required': return { status: 'waiting', code: 'needs_auth' };
    default: return { status: 'failed', code: 'error' };
  }
}

/**
 * A remote agent, in any language, as the stack's runtime: each run is one A2A message to it. The caller's identity
 * travels as a token for `auth.audience` from the stack's credentials; a token is never logged or returned.
 */
export function createA2ARuntime(options: A2ARuntimeOptions, name = 'a2a', mappings: Mappings = noMappings(name)): RuntimePort {
  const version: WireVersion = options.version ?? A2A_VERSION;
  const timeoutMs = limitValue(RUNTIME_LIMITS.timeoutMs, options.timeoutMs);
  const pollMs = limitValue(RUNTIME_LIMITS.pollMs, options.pollMs);
  let endpoint: Promise<string> | undefined;
  // Origins the operator configured: only these may be private or loopback targets.
  const configured = new Set([options.url, options.endpoint, ...(options.allowedEndpoints ?? [])].filter((u): u is string => !!u).map((u) => new URL(u).origin));

  /** A target the runtime may send to: https (or loopback, or `allowHttp`), and private only when configured. */
  function checkTarget(raw: string, what: string): URL {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error(`${what} is not a URL`); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (options.allowHttp || isLoopback(url.hostname)))) throw new Error(`${what} must use https`);
    if (url.username || url.password) throw new Error(`${what} must not carry credentials`);
    if (isPrivateHost(url.hostname) && !configured.has(url.origin)) throw new Error(`${what} is a private address that is not configured`);
    return url;
  }

  /**
   * The JSON-RPC endpoint: `endpoint`, the URL itself, or the interface of the agent card for this version. A card may
   * point only to its own origin or to `allowedEndpoints`: a card cannot send the caller's credentials elsewhere.
   */
  async function resolveEndpoint(signal: AbortSignal): Promise<string> {
    if (options.endpoint) return checkTarget(options.endpoint, 'endpoint').href;
    const cardUrl = checkTarget(options.url, 'url');
    if (!/agent-card\.json$|agent\.json$/.test(cardUrl.pathname)) return cardUrl.href;
    const res = await fetch(cardUrl, { headers: { accept: 'application/json', ...options.headers }, signal, redirect: 'error' });
    if (!res.ok) throw new Error(`agent card HTTP ${res.status}`);
    const card = await res.json() as { url?: string; supportedInterfaces?: { url?: string; protocolBinding?: string; protocolVersion?: string }[] };
    const match = (card.supportedInterfaces ?? []).find((i) => i.protocolBinding === 'JSONRPC' && (i.protocolVersion ?? '').startsWith(version));
    const found = match?.url ?? (version === LEGACY_VERSION ? card.url : undefined);
    if (typeof found !== 'string') throw new Error(`the agent card offers no JSON-RPC interface for A2A ${version}`);
    const target = checkTarget(found, 'the endpoint of the agent card');
    const allowed = target.origin === cardUrl.origin
      || (options.allowedEndpoints ?? []).some((e) => e === target.href || e === target.origin || new URL(e).origin === target.origin && target.href.startsWith(e));
    if (!allowed) throw new Error('the agent card points to an endpoint outside its origin and allowedEndpoints');
    return target.href;
  }

  return {
    name,
    bind(stack: Stack, agent) {
      async function headers(ctx: CallContext): Promise<Record<string, string>> {
        // The remote agent joins the run's trace: the active span's context, else the one the run started with.
        const trace = activeTrace(stack.telemetry, ctx.trace);
        const out: Record<string, string> = {
          'content-type': 'application/json', accept: 'application/json', 'a2a-version': version, ...options.headers,
          ...(trace ? { traceparent: trace.parent, ...(trace.state ? { tracestate: trace.state } : {}) } : {}),
        };
        if (options.auth) {
          const provider = stack.ports.credentials;
          if (!provider) throw new Error('auth needs a credentials adapter');
          const token = await provider.token(options.auth.audience, {
            ...(ctx.caller ? { caller: ctx.caller } : {}), ...(options.auth.scopes ? { scopes: options.auth.scopes } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          out.authorization = `Bearer ${token}`;
        }
        return out;
      }

      async function call(method: string, params: unknown, ctx: CallContext, signal: AbortSignal): Promise<unknown> {
        endpoint ??= resolveEndpoint(signal).catch((err: unknown) => { endpoint = undefined; throw err; });
        // The target is validated before any credential is minted for it; redirects are not followed.
        const target = await endpoint;
        const res = await fetch(target, { method: 'POST', headers: await headers(ctx), body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }), signal, redirect: 'error' });
        // The body is not read on errors: it could echo the token.
        if (!res.ok) throw new Error(`A2A HTTP ${res.status}`);
        const body = await res.json() as { result?: unknown; error?: { code?: number } };
        if (body.error) throw new Error(`A2A error ${body.error.code ?? ''}`.trim());
        return body.result;
      }

      return {
        name: agent.name,
        async run(input, init = {}) {
          const ctx = stack.context({ ...init, agent: agent.name });
          const signal = anySignal(timeoutSignal(timeoutMs), ctx.signal) ?? new AbortController().signal;
          const by = agent.name;
          const ended = (reason: Omit<StopReason, 'layer' | 'by'>, status: RunResult['status'] = 'failed'): RunResult =>
            ({ runId: ctx.runId, status, output: '', reason: { ...reason, layer: 'harness', by } });
          return stack.telemetry.span('a2a.send', { [ATTR.layer]: 'harness', [ATTR.name]: agent.name, [ATTR.runId]: ctx.runId, 'a2a.version': version }, async (span) => {
            const message = messageWire({ messageId: randomUUID(), role: 'user', text: inputText(input), ...(ctx.sessionId ? { contextId: ctx.sessionId } : {}) }, version);
            try {
              let read = readResult(await call(METHOD_OF[version].send, { message }, ctx, signal));
              if (read.message !== undefined) return mappings.in(read.raw, { runId: ctx.runId, status: 'completed', output: read.message } satisfies RunResult);
              while (read.task && !TERMINAL.includes(read.task.state) && !INTERRUPTED.includes(read.task.state)) {
                await new Promise((r) => setTimeout(r, pollMs));
                signal.throwIfAborted();
                read = readResult(await call(METHOD_OF[version].get, { id: read.task.id }, ctx, signal));
              }
              if (!read.task) return ended({ code: 'error', detail: 'remote agent sent no task' });
              const task = read.task;
              span.setAttributes({ 'a2a.task.state': task.native ?? task.state });
              const s = runStatus(task.state);
              const result: RunResult = {
                runId: ctx.runId,
                status: s.status,
                // A failed or stopped task's text is the remote side's own wording: it stays out of the output.
                output: s.status === 'completed' || s.status === 'waiting' ? task.text : '',
                ...(s.code ? { reason: { code: s.code, layer: 'harness', by } } : {}),
                ...(task.metadata?.usage ? { usage: task.metadata.usage } : {}),
                ...(task.metadata?.costUsd !== undefined ? { costUsd: task.metadata.costUsd } : {}),
                // A state this adapter does not know is a failure; the native value is kept for the operator.
                ...(task.native !== undefined ? { ext: { 'a2a.state': task.native } } : {}),
              };
              return mappings.in(read.raw, result);
            } catch (err) {
              if (ctx.signal?.aborted) return ended({ code: 'aborted' }, 'stopped');
              // A fixed detail: error text can carry URLs or credentials.
              return isAbort(err) ? ended({ code: 'timeout', detail: 'remote agent timed out' }) : ended({ code: 'error', detail: RUN_FAILED });
            }
          });
        },
      };
    },
  };
}
