import {
  ANONYMOUS, ATTR, CORE_VOCABULARIES, ConfigError, errorMessage, METRIC, publicCaller,
  type AccessQuestion, type AccessTarget, type Approval, type ApprovalPort, type ApprovalStatus, type Caller, type InboundContext, type InboundRoute, type Stack,
} from '@agent-layers/core';
import { errorResponse } from './http.ts';

export const DEFAULT_APPROVALS_PATH = '/approvals';

/** An approval as the routes show it: without the request key, and never with a caller credential. */
export function approvalView(a: Approval): Approval {
  const { key: _key, ...request } = a.request;
  const caller = request.question?.caller as { credential?: unknown } | undefined;
  if (caller && typeof caller === 'object' && 'credential' in caller) {
    const { credential: _credential, ...rest } = caller;
    return { ...a, request: { ...request, question: { ...request.question, caller: rest as AccessQuestion['caller'] } } };
  }
  return { ...a, request };
}

/** Who decided, as recorded on the approval: the verified caller as `kind:id`. */
export const decidedBy = (caller: Caller | undefined): string => (caller ? `${caller.kind}:${caller.id}` : ANONYMOUS.id);

/** The target of an approval question: the approval, with the risk and agent of the call it is about. */
function targetOf(a: Approval): AccessTarget {
  const t = a.request.question?.target;
  return {
    kind: 'approval', id: a.id, layer: 'identity', risk: t?.risk ?? 'exec', agent: a.request.agent,
    attrs: { status: a.status, ...(t?.id ? { tool: t.id } : {}) },
  };
}

/** Listing and unknown ids: no approval to describe. An unknown id counts as the most dangerous risk. */
const collection: AccessTarget = { kind: 'approval', id: '*', layer: 'identity', risk: 'read', agent: '*' };
const unknownTarget = (id: string): AccessTarget => ({ kind: 'approval', id, layer: 'identity', risk: 'exec', agent: '*' });

const STATUSES = CORE_VOCABULARIES.values('approvalStatus');

/**
 * Routes over the stack's approval port: `GET <path>` (pending approvals, `?status=`, `?limit=`), `GET <path>/<id>`,
 * `POST <path>/<id>` with `{ "decision": "approve" | "deny", "reason"? }` and `DELETE <path>/<id>` (cancel). The host
 * authenticates every request; each one is then authorized through the authorization port, action `list` (reads) or
 * `decide` (decisions and cancels) on a target of kind `approval`. No authorization port, an error or no allowing rule:
 * 403. The decision records the verified caller as `decidedBy`.
 */
export function approvalRoutes(stack: Stack, opts: { path?: string } = {}): InboundRoute[] {
  const port = stack.ports.approval;
  const authorization = stack.ports.authorization;
  if (!port) throw new ConfigError(['gateway.approvals: needs an approval adapter (layers.approval)']);
  if (!authorization) throw new ConfigError(['gateway.approvals: needs an authorization adapter (layers.authorization): every request is authorized, so without one all would be refused']);
  const base = (opts.path ?? DEFAULT_APPROVALS_PATH).replace(/\/+$/, '');
  const telemetry = stack.telemetry;

  /** Undefined when allowed, else the 403 answer. Fails closed: a rejection is a denial; cancellation propagates. */
  async function authorize(action: 'list' | 'decide', target: AccessTarget, ctx: InboundContext): Promise<Response | undefined> {
    const question: AccessQuestion = { caller: publicCaller(ctx.caller) ?? { ...ANONYMOUS, roles: [], scopes: [] }, action, target };
    let allowed = false;
    try {
      allowed = (await authorization!.evaluate(question, { signal: ctx.signal })).allowed === true;
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      telemetry.event('gateway.approval.authorization_failed', { [ATTR.layer]: 'identity', [ATTR.error]: errorMessage(err) });
    }
    telemetry.metric(METRIC.accessDecisions, 1, { [ATTR.layer]: 'identity', [ATTR.accessDecision]: allowed ? 'allow' : 'deny', 'gateway.approval.action': action });
    return allowed ? undefined : errorResponse(403, 'not allowed', 'permission_error');
  }

  const idOf = (req: Request): string | undefined => {
    let rest: string;
    try {
      rest = decodeURIComponent(new URL(req.url).pathname.slice(base.length + 1));
    } catch {
      return undefined;
    }
    return rest && !rest.includes('/') ? rest : undefined;
  };

  /** The approval of a request path, authorized for `action`; or the answer to send instead. */
  async function approvalFor(req: Request, ctx: InboundContext, action: 'list' | 'decide'): Promise<Approval | Response> {
    const id = idOf(req);
    if (!id) return errorResponse(404, 'no such approval', 'not_found_error');
    const found = await port!.get(id);
    const refused = await authorize(action, found ? targetOf(found) : unknownTarget(id), ctx);
    if (refused) return refused;
    return found ?? errorResponse(404, 'no such approval', 'not_found_error');
  }

  /** Decide or cancel; a no longer pending approval is a 409 with its status. */
  async function settle(a: Approval, fn: () => Promise<Approval>): Promise<Response> {
    if (a.status !== 'pending') return errorResponse(409, `approval is ${a.status}`, 'conflict_error');
    try {
      return Response.json(approvalView(await fn()));
    } catch (err) {
      const now = await port!.get(a.id);
      if (now && now.status !== 'pending') return errorResponse(409, `approval is ${now.status}`, 'conflict_error');
      throw err;
    }
  }

  const routes: InboundRoute[] = [];
  if (port.list) {
    const list = port.list.bind(port);
    routes.push({
      path: base, methods: ['GET'],
      async handle(req, ctx) {
        const params = new URL(req.url).searchParams;
        const status = params.get('status') ?? 'pending';
        if (!STATUSES.includes(status)) return errorResponse(400, `status must be one of ${STATUSES.join(', ')}`, 'invalid_request_error');
        const limitParam = params.get('limit');
        const limit = limitParam === null ? undefined : Number(limitParam);
        if (limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0)) return errorResponse(400, 'limit must be a positive integer', 'invalid_request_error');
        const refused = await authorize('list', collection, ctx);
        if (refused) return refused;
        const approvals = await list({ status: status as ApprovalStatus, ...(limit !== undefined ? { limit } : {}) });
        return Response.json({ approvals: approvals.map(approvalView) });
      },
    });
  }
  const methods = ['GET', 'POST', ...(port.cancel ? ['DELETE'] : [])];
  routes.push({
    path: `${base}/*`, methods,
    async handle(req, ctx) {
      const method = req.method.toUpperCase();
      let body: { decision?: unknown; reason?: unknown } = {};
      if (method !== 'GET') {
        const text = await req.text();
        if (text && !/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return errorResponse(415, 'Content-Type must be application/json', 'invalid_request_error');
        try {
          body = text ? JSON.parse(text) as typeof body : {};
        } catch {
          return errorResponse(400, 'body must be JSON', 'invalid_request_error');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse(400, 'body must be a JSON object', 'invalid_request_error');
        if (body.reason !== undefined && typeof body.reason !== 'string') return errorResponse(400, 'reason must be a string', 'invalid_request_error');
        if (method === 'POST' && body.decision !== 'approve' && body.decision !== 'deny') return errorResponse(400, 'decision must be "approve" or "deny"', 'invalid_request_error');
      }
      const a = await approvalFor(req, ctx, method === 'GET' ? 'list' : 'decide');
      if (a instanceof Response) return a;
      if (method === 'GET') return Response.json(approvalView(a));
      const by = decidedBy(ctx.caller);
      const reason = typeof body.reason === 'string' ? { reason: body.reason } : {};
      const response = method === 'POST'
        ? await settle(a, () => port.decide(a.id, { approved: body.decision === 'approve', by, ...reason }))
        : await settle(a, () => port.cancel!(a.id, { by, ...reason }));
      if (response.ok) telemetry.event('gateway.approval.decided', { [ATTR.layer]: 'identity', 'gateway.approval.id': a.id, 'gateway.approval.status': method === 'POST' ? (body.decision === 'approve' ? 'approved' : 'denied') : 'cancelled' });
      return response;
    },
  });
  return routes;
}
