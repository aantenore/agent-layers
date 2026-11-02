import {
  ANONYMOUS, ATTR, ConfigError, errorMessage, METRIC, publicCaller, resumeAnswerProblem, RunRefused, runTarget,
  type AccessQuestion, type InboundContext, type InboundRoute, type ResumeAnswer, type RunResult, type Stack,
} from '@agent-layers/core';
import { errorResponse } from './http.ts';

export const DEFAULT_RUNS_PATH = '/runs';

const REFUSED: Record<RunRefused['kind'], [number, string]> = {
  not_found: [404, 'not_found_error'],
  forbidden: [403, 'permission_error'],
  conflict: [409, 'conflict_error'],
  invalid: [400, 'invalid_request_error'],
};

/**
 * A run result as the routes show it: status, output, the stop code (never its detail) and the approval a waiting run
 * waits for. Events stay in the stack.
 */
export function runView(r: RunResult): Record<string, unknown> {
  const approval = r.ext?.['sdk.approval'];
  return {
    runId: r.runId, status: r.status, output: r.output,
    ...(r.reason ? { reason: { code: r.reason.code } } : {}),
    ...(r.usage ? { usage: r.usage } : {}),
    ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
    ...(approval ? { approval } : {}),
  };
}

/**
 * Routes over runs: `POST <path>/<id>/resume` with a resume answer (`{ "approval": { "id", "approved", "reason"? } }`
 * or `{ "input": ... }`) and `POST <path>/<id>/cancel` with `{ "reason"? }`. The host authenticates every request; each
 * one is then authorized through the authorization port, action `resume` or `cancel` on a target of kind `run` (the
 * run's agent and the tool it waits for; `agent: "*"` for a run the stack does not know), before the stack applies its
 * own rules (only the caller that started the run, unless allowed; an approval decided by an allowed caller). No
 * authorization port, an error or no allowing rule: 403.
 */
export function runRoutes(stack: Stack, opts: { path?: string } = {}): InboundRoute[] {
  const authorization = stack.ports.authorization;
  if (!authorization) throw new ConfigError(['gateway.runs: needs an authorization adapter (layers.authorization): every request is authorized, so without one all would be refused']);
  const base = (opts.path ?? DEFAULT_RUNS_PATH).replace(/\/+$/, '');
  const telemetry = stack.telemetry;

  async function authorize(action: 'resume' | 'cancel', runId: string, ctx: InboundContext): Promise<Response | undefined> {
    // The target is the run itself, so a policy scoped to an agent or a tool applies. A run the stack does not know is
    // asked about as any run: an unknown id and a refused one answer alike to a caller not allowed on every run.
    const target = await stack.runTarget(runId) ?? runTarget(runId, '*');
    const question: AccessQuestion = { caller: publicCaller(ctx.caller) ?? { ...ANONYMOUS, roles: [], scopes: [] }, action, target };
    let allowed = false;
    try {
      allowed = (await authorization!.evaluate(question, { signal: ctx.signal })).allowed === true;
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      telemetry.event('gateway.run.authorization_failed', { [ATTR.layer]: 'identity', [ATTR.error]: errorMessage(err) });
    }
    telemetry.metric(METRIC.accessDecisions, 1, { [ATTR.layer]: 'identity', [ATTR.accessDecision]: allowed ? 'allow' : 'deny', 'gateway.run.action': action });
    return allowed ? undefined : errorResponse(403, 'not allowed', 'permission_error');
  }

  /** `<id>` and `resume` or `cancel` of a request path. */
  const target = (req: Request): { runId: string; op: string } | undefined => {
    let rest: string;
    try {
      rest = decodeURIComponent(new URL(req.url).pathname.slice(base.length + 1));
    } catch {
      return undefined;
    }
    const m = /^([^/]+)\/(resume|cancel)$/.exec(rest);
    return m ? { runId: m[1]!, op: m[2]! } : undefined;
  };

  return [{
    path: `${base}/*`, methods: ['POST'],
    async handle(req, ctx) {
      const hit = target(req);
      if (!hit) return errorResponse(404, 'no such route', 'not_found_error');
      const text = await req.text();
      if (text && !/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return errorResponse(415, 'Content-Type must be application/json', 'invalid_request_error');
      let body: Record<string, unknown>;
      try {
        body = text ? JSON.parse(text) as Record<string, unknown> : {};
      } catch {
        return errorResponse(400, 'body must be JSON', 'invalid_request_error');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse(400, 'body must be a JSON object', 'invalid_request_error');
      if (hit.op === 'resume') {
        const problem = resumeAnswerProblem(body);
        if (problem) return errorResponse(400, problem, 'invalid_request_error');
      } else if (body.reason !== undefined && typeof body.reason !== 'string') return errorResponse(400, 'reason must be a string', 'invalid_request_error');

      const op = hit.op as 'resume' | 'cancel';
      const refused = await authorize(op, hit.runId, ctx);
      if (refused) return refused;
      try {
        if (op === 'cancel') {
          const reason = typeof body.reason === 'string' ? { reason: body.reason } : {};
          return Response.json(await stack.cancel(hit.runId, { ...(ctx.caller ? { by: ctx.caller } : {}), ...reason, signal: ctx.signal }));
        }
        const result = await stack.resume(hit.runId, body as unknown as ResumeAnswer, {
          ...(ctx.caller ? { caller: ctx.caller } : {}), signal: ctx.signal, ...(ctx.trace ? { trace: ctx.trace } : {}), ...(ctx.delegation ? { delegation: ctx.delegation } : {}),
        });
        return Response.json(runView(result));
      } catch (err) {
        if (!(err instanceof RunRefused)) throw err;
        const [status, type] = REFUSED[err.kind];
        return errorResponse(status, err.message, type);
      }
    },
  }];
}
