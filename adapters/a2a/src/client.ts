import { randomUUID } from 'node:crypto';
import { contentText, isAbort, traceHeaders, type CallContext, type RunInput, type RunResult, type RuntimePort, type Stack } from '@agent-layers/core';
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
  timeoutMs?: number;
  /** Interval between GetTask calls while a task is still working (default 500). */
  pollMs?: number;
}

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
  for (let i = input.messages.length - 1; i >= 0; i--) if (input.messages[i]!.role === 'user') return contentText(input.messages[i]!.content);
  return '';
}

function runStatus(state: TaskState): Pick<RunResult, 'status' | 'reason'> {
  if (state === 'completed') return { status: 'completed' };
  if (state === 'canceled') return { status: 'stopped', reason: 'aborted' };
  if (state === 'rejected') return { status: 'stopped', reason: 'remote agent rejected the task' };
  if (INTERRUPTED.includes(state)) return { status: 'stopped', reason: `remote agent needs ${state === 'auth-required' ? 'authorization' : 'input'}` };
  return { status: 'failed', reason: 'remote agent task failed' };
}

/**
 * A remote agent, in any language, as the stack's runtime: each run is one A2A message to it. The caller's identity
 * travels as a token for `auth.audience` from the stack's credentials; a token is never logged or returned.
 */
export function createA2ARuntime(options: A2ARuntimeOptions, name = 'a2a'): RuntimePort {
  const version: WireVersion = options.version ?? A2A_VERSION;
  const timeoutMs = options.timeoutMs ?? 300_000;
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
        // The remote agent joins the run's trace (W3C Trace Context of the active span).
        const out: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', 'a2a-version': version, ...options.headers, ...traceHeaders(stack.telemetry, ctx.trace) };
        if (options.auth) {
          const provider = stack.ports.credentials;
          if (!provider) throw new Error('auth needs a credentials adapter');
          const token = await provider.token(options.auth.audience, {
            ...(ctx.identity ? { identity: ctx.identity } : {}), ...(options.auth.scopes ? { scopes: options.auth.scopes } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
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
          const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(ctx.signal ? [ctx.signal] : [])]);
          return stack.telemetry.span('a2a.send', { 'agent.layer': 'harness', 'gen_ai.agent.name': agent.name, 'run.id': ctx.runId, 'a2a.version': version }, async (span) => {
            const message = messageWire({ messageId: randomUUID(), role: 'user', text: inputText(input), ...(ctx.sessionId ? { contextId: ctx.sessionId } : {}) }, version);
            try {
              let read = readResult(await call(METHOD_OF[version].send, { message }, ctx, signal));
              if (read.message !== undefined) return { runId: ctx.runId, status: 'completed', output: read.message };
              while (read.task && !TERMINAL.includes(read.task.state) && !INTERRUPTED.includes(read.task.state)) {
                await new Promise((r) => setTimeout(r, options.pollMs ?? 500));
                signal.throwIfAborted();
                read = readResult(await call(METHOD_OF[version].get, { id: read.task.id }, ctx, signal));
              }
              if (!read.task) return { runId: ctx.runId, status: 'failed', output: '', reason: 'remote agent sent no task' };
              span.setAttributes({ 'a2a.task.state': read.task.state });
              const s = runStatus(read.task.state);
              return { runId: ctx.runId, ...s, output: s.status === 'completed' ? read.task.text : '', ...read.task.metadata };
            } catch (err) {
              if (ctx.signal?.aborted) return { runId: ctx.runId, status: 'stopped', output: '', reason: 'aborted' };
              // A fixed reason: error text can carry URLs or credentials.
              return { runId: ctx.runId, status: 'failed', output: '', reason: isAbort(err) ? 'remote agent timed out' : RUN_FAILED };
            }
          });
        },
      };
    },
  };
}
