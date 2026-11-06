import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  activeTrace, anySignal, ATTR, BOUNDS_STOP, BoundsExceeded, defineLimits, errorCode, isAbort, limitValue, messageText, noMappings, outboundBounds, RunRefused, timeoutSignal,
  type CallContext, type JsonValue, type LimitValue, type Mappings, type OutboundCall, type RunInput, type RunResult, type RuntimePort, type Stack, type StopReason, type Usage,
} from '@agent-layers/core';
import {
  A2A_VERSION, BOUNDS_URI, INTERRUPTED, LEGACY_VERSION, messageWire, METHOD_OF, METHODS, readResult, TERMINAL, type TaskState, type WireVersion,
} from './wire.ts';

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
  /** Time limit of the CancelTask call sent when a run is aborted or times out (default 5000). */
  cancelTimeoutMs?: number;
  /**
   * A2A extensions requested from the remote agent. Default: the bounds extension (`BOUNDS_URI`), whose data carries
   * what is left of the run's time, hops and budget; the agent-plexus URI sends the same data under that URI; `[]`
   * sends none.
   */
  extensions?: string[];
}

/** Configurable limits of the outbound descriptor; see docs/limits.md. */
export const RUNTIME_LIMITS = defineLimits({
  timeoutMs: { path: 'options.timeoutMs', default: 300_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 3_600_000 } },
  pollMs: { path: 'options.pollMs', default: 500, unit: 'ms', min: 10, safe: { min: 100, max: 10_000 } },
  cancelTimeoutMs: { path: 'options.cancelTimeoutMs', default: 5_000, unit: 'ms', min: 1, max: 60_000 },
});

const RUN_FAILED = 'remote agent call failed';

/** `ext` key of a failed run: the class of the failure (`ECONNREFUSED`, `http_401`, `rpc_-32601`), never its text. */
export const ERROR_KEY = 'a2a.error';

/** An error this adapter raised itself: its message names the problem (and the host), its class is known. */
interface ClassifiedError extends Error { a2aClass: string }
const classified = (message: string, a2aClass: string): ClassifiedError => Object.assign(new Error(message), { a2aClass });
const isClassified = (err: unknown): err is ClassifiedError => err instanceof Error && typeof (err as ClassifiedError).a2aClass === 'string';

/**
 * The class of a failed call, safe to record where its text is not: this adapter's own classes (`http_<status>`,
 * `rpc_<code>`, `card`), the system error code behind a network failure (`ECONNREFUSED`, `ENOTFOUND`), `aborted`,
 * else `error`.
 */
export function errorClass(err: unknown): string {
  if (isClassified(err)) return err.a2aClass;
  if (isAbort(err)) return 'aborted';
  return errorCode(err) ?? 'error';
}

const isCardUrl = (url: URL) => /agent-card\.json$|agent\.json$/.test(url.pathname);

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
  const cancelTimeoutMs = limitValue(RUNTIME_LIMITS.cancelTimeoutMs, options.cancelTimeoutMs);
  const boundsUri = (options.extensions ?? [BOUNDS_URI])[0];
  const cancelMethod = Object.keys(METHODS).find((m) => METHODS[m]!.op === 'cancel' && METHODS[m]!.version === version)!;
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

  /** Fetches the agent card (no credential) and returns the JSON-RPC endpoint it offers for this version. */
  async function readCard(cardUrl: URL, signal: AbortSignal): Promise<string> {
    const res = await fetch(cardUrl, { headers: { accept: 'application/json', ...options.headers }, signal, redirect: 'error' });
    if (!res.ok) throw classified(`agent card HTTP ${res.status} (${cardUrl.host})`, `http_${res.status}`);
    const card = await res.json() as { url?: string; supportedInterfaces?: { url?: string; protocolBinding?: string; protocolVersion?: string }[] };
    const match = (card.supportedInterfaces ?? []).find((i) => i.protocolBinding === 'JSONRPC' && (i.protocolVersion ?? '').startsWith(version));
    const found = match?.url ?? (version === LEGACY_VERSION ? card.url : undefined);
    if (typeof found !== 'string') throw classified(`the agent card of ${cardUrl.host} offers no JSON-RPC interface for A2A ${version}`, 'card');
    return found;
  }

  /**
   * The JSON-RPC endpoint: `endpoint`, the URL itself, or the interface of the agent card for this version. A card may
   * point only to its own origin or to `allowedEndpoints`: a card cannot send the caller's credentials elsewhere.
   */
  async function resolveEndpoint(signal: AbortSignal): Promise<string> {
    if (options.endpoint) return checkTarget(options.endpoint, 'endpoint').href;
    const cardUrl = checkTarget(options.url, 'url');
    if (!isCardUrl(cardUrl)) return cardUrl.href;
    const target = checkTarget(await readCard(cardUrl, signal), 'the endpoint of the agent card');
    const allowed = target.origin === cardUrl.origin
      || (options.allowedEndpoints ?? []).some((e) => e === target.href || e === target.origin || new URL(e).origin === target.origin && target.href.startsWith(e));
    if (!allowed) throw new Error('the agent card points to an endpoint outside its origin and allowedEndpoints');
    return target.href;
  }

  return {
    name,
    /**
     * Readiness: the agent card answers (the one at `url`, with an interface for this version), or, with an explicit
     * endpoint, the host answers a request for the card under it (any status: its card may live elsewhere). Fetched
     * without a credential. Rejects with the host and the cause class.
     */
    async probe(popts = {}) {
      const signal = popts.signal ?? new AbortController().signal;
      const url = options.endpoint ? checkTarget(options.endpoint, 'endpoint') : checkTarget(options.url, 'url');
      try {
        if (!options.endpoint && isCardUrl(url)) await readCard(url, signal);
        else {
          const card = new URL(`${url.pathname.replace(/\/$/, '')}/.well-known/agent-card.json`, url.origin);
          const res = await fetch(card, { headers: { accept: 'application/json', ...options.headers }, signal, redirect: 'manual' });
          await res.body?.cancel().catch(() => {});
        }
      } catch (err) {
        if (isAbort(err) || isClassified(err)) throw err;
        throw new Error(`remote agent unreachable (${url.host}): ${errorClass(err)}`, { cause: err });
      }
    },
    bind(stack: Stack, agent) {
      async function headers(ctx: CallContext, extensions = false): Promise<Record<string, string>> {
        // The remote agent joins the run's trace: the active span's context, else the one the run started with.
        const trace = activeTrace(stack.telemetry, ctx.trace);
        const out: Record<string, string> = {
          'content-type': 'application/json', accept: 'application/json', 'a2a-version': version, ...options.headers,
          ...(trace ? { traceparent: trace.parent, ...(trace.state ? { tracestate: trace.state } : {}) } : {}),
          ...(extensions && boundsUri ? { 'a2a-extensions': boundsUri } : {}),
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

      async function call(method: string, params: unknown, ctx: CallContext, signal: AbortSignal, extensions = false): Promise<unknown> {
        endpoint ??= resolveEndpoint(signal).catch((err: unknown) => { endpoint = undefined; throw err; });
        // The target is validated before any credential is minted for it; redirects are not followed.
        const target = await endpoint;
        const res = await fetch(target, { method: 'POST', headers: await headers(ctx, extensions), body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }), signal, redirect: 'error' });
        // The body is not read on errors: it could echo the token.
        if (!res.ok) throw classified(`A2A HTTP ${res.status}`, `http_${res.status}`);
        const body = await res.json() as { result?: unknown; error?: { code?: number } };
        if (body.error) throw classified(`A2A error ${body.error.code ?? ''}`.trim(), `rpc_${body.error.code ?? 'unknown'}`);
        return body.result;
      }

      /**
       * Best effort: asks the remote agent to stop a task the run gave up on, so it does not keep working. Bounded by
       * `cancelTimeoutMs`, with its own signal (the run's is already aborted); a failure leaves the run's result as is.
       */
      async function cancel(id: string, ctx: CallContext): Promise<void> {
        const signal = timeoutSignal(cancelTimeoutMs) ?? new AbortController().signal;
        try { await call(cancelMethod, { id }, { ...ctx, signal }, signal); } catch { /* the run already has its result */ }
      }

      /**
       * One message to the remote agent; with `followUp`, it continues that remote task (an A2A follow-up on an
       * `input-required` task). A waiting result carries the remote task as its checkpoint.
       */
      async function send(input: RunInput, init: Partial<CallContext>, followUp?: RemoteTask): Promise<RunResult> {
        const ctx = stack.context({ ...init, agent: agent.name });
        const by = agent.name;
        const ended = (reason: Omit<StopReason, 'layer' | 'by'>, status: RunResult['status'] = 'failed', ext?: Record<string, string>): RunResult =>
          ({ runId: ctx.runId, status, output: '', reason: { ...reason, layer: 'harness', by }, ...(ext ? { ext } : {}) });
        // What is left of the run's bounds goes to the remote agent; a call that would break them is refused here,
        // without a network call. The run's signal already aborts at its deadline; this adapter's own limit caps it.
        let outbound: OutboundCall | undefined;
        try {
          outbound = boundsUri ? outboundBounds(ctx, { timeoutMs }) : undefined;
        } catch (err) {
          if (err instanceof BoundsExceeded) return { runId: ctx.runId, status: 'stopped', output: '', reason: { ...err.stopReason } };
          throw err;
        }
        const signal = anySignal(timeoutSignal(timeoutMs), ctx.signal) ?? new AbortController().signal;
        let reported: { usage?: Usage; costUsd?: number } | undefined;
        return stack.telemetry.span('a2a.send', { [ATTR.layer]: 'harness', [ATTR.name]: agent.name, [ATTR.runId]: ctx.runId, 'a2a.version': version }, async (span) => {
          let taskId: string | undefined;
          const contextId = followUp?.contextId || ctx.sessionId;
          const message = messageWire({
            messageId: randomUUID(), role: 'user', text: inputText(input), ...(contextId ? { contextId } : {}), ...(followUp ? { taskId: followUp.taskId } : {}),
            ...(outbound && boundsUri ? { extensions: [boundsUri], metadata: { [boundsUri]: outbound.bounds } } : {}),
          }, version);
          try {
            let read = readResult(await call(METHOD_OF[version].send, { message }, ctx, signal, !!outbound));
            if (read.message !== undefined) return mappings.in(read.raw, { runId: ctx.runId, status: 'completed', output: read.message } satisfies RunResult);
            while (read.task && !TERMINAL.includes(read.task.state) && !INTERRUPTED.includes(read.task.state)) {
              taskId = read.task.id;
              // The wait ends with the run's signal, not after it: an aborted run does not wait a poll interval out.
              await sleep(pollMs, undefined, { signal });
              read = readResult(await call(METHOD_OF[version].get, { id: read.task.id }, ctx, signal));
            }
            taskId = undefined;
            if (!read.task) return ended({ code: 'error', detail: 'remote agent sent no task' });
            const task = read.task;
            const m = task.metadata;
            reported = { ...(m?.usage ? { usage: m.usage } : {}), ...(m?.costUsd !== undefined ? { costUsd: m.costUsd } : {}) };
            span.setAttributes({ 'a2a.task.state': task.native ?? task.state });
            const s = runStatus(task.state);
            // A remote run its own bounds stopped says which one, so a chain can tell "too deep" from "out of budget". The
            // bounds are the chain's: the stop keeps the core's reason (`by: sdk.*`), so this stack reports it upstream in turn.
            const boundsStop = s.status === 'stopped' && m?.stop ? Object.values(BOUNDS_STOP).find((r) => r.code === m.stop) : undefined;
            const code = s.code;
            const result: RunResult = {
              runId: ctx.runId,
              status: s.status,
              // A failed or stopped task's text is the remote side's own wording: it stays out of the output.
              output: s.status === 'completed' || s.status === 'waiting' ? task.text : '',
              ...(boundsStop ? { reason: { ...boundsStop } } : code ? { reason: { code, layer: 'harness', by } } : {}),
              ...(reported.usage ? { usage: reported.usage } : {}),
              ...(reported.costUsd !== undefined ? { costUsd: reported.costUsd } : {}),
              // A state this adapter does not know is a failure; the native value is kept for the operator.
              ...(task.native !== undefined ? { ext: { 'a2a.state': task.native } } : {}),
              // The remote task a follow-up continues.
              ...(s.status === 'waiting' ? { checkpoint: { taskId: task.id, contextId: task.contextId } satisfies RemoteTask as unknown as JsonValue } : {}),
            };
            return mappings.in(read.raw, result);
          } catch (err) {
            // A task still working on the remote side is canceled there too; a failed cancel does not change the result.
            if (taskId && signal.aborted) await cancel(taskId, ctx);
            if (ctx.signal?.aborted) return ended({ code: 'aborted' }, 'stopped');
            // A fixed detail: error text can carry URLs or credentials. The class of the failure (a system error code,
            // an HTTP status, a JSON-RPC code) is kept for the operator, on the span and on the result.
            const cls = errorClass(err);
            span.setAttributes({ [ERROR_KEY]: cls });
            return isAbort(err) ? ended({ code: 'timeout', detail: 'remote agent timed out' }) : ended({ code: 'error', detail: RUN_FAILED }, 'failed', { [ERROR_KEY]: cls });
          } finally {
            // Settled with what the remote run reported; an unreported spend keeps its whole reservation.
            outbound?.reservation.settle(reported);
          }
        });
      }

      return {
        name: agent.name,
        run: (input, init = {}) => send(input, init),
        /**
         * Sends the input as a follow-up message on the remote task that asked for it. An approval the remote agent waits
         * for is decided on its side (its approval routes); the follow-up then continues the task.
         */
        async resume(checkpoint, answer, init = {}) {
          const task = checkpoint as Partial<RemoteTask> | null;
          if (!task || typeof task.taskId !== 'string') throw new RunRefused('invalid', 'not a checkpoint of this runtime');
          if (!('input' in answer)) throw new RunRefused('invalid', 'the remote agent decides its own approvals: send the follow-up input once decided');
          return send(answer.input, init, { taskId: task.taskId, contextId: typeof task.contextId === 'string' ? task.contextId : '' });
        },
      };
    },
  };
}

/** The remote task of a waiting run, which a follow-up continues. */
interface RemoteTask { taskId: string; contextId: string }
