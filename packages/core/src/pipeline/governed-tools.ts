import { errorMessage, isAbort } from '../errors.ts';
import { boundExt, withExt } from '../ext.ts';
import { ATTR, EVENT, METRIC, SPAN } from '../names.ts';
import type { BoundCredentials, CallContext } from '../ports/base.ts';
import type { GuardPort } from '../ports/guard.ts';
import type { ApprovalPort, AuthorizationPort, CredentialPort } from '../ports/identity.ts';
import type { TelemetryPort } from '../ports/telemetry.ts';
import type { ToolPort, ToolResult, ToolSpec } from '../ports/tool.ts';
import { accessQuestion, evaluatePolicy, riskOf, type PolicyRule } from '../policy.ts';
import { noopTelemetry } from '../telemetry.ts';
import { CORE_VOCABULARIES, type Vocabularies } from '../vocab.ts';
import { runGuards } from './guards.ts';

export interface GovernedToolsOptions {
  /** Local authorization rules, evaluated first. */
  policy?: readonly PolicyRule[];
  /** External authorization, evaluated after the local rules. Errors deny (fail closed). */
  authorization?: AuthorizationPort;
  /** Human approval for `ask` rules. Without it, `ask` denies. */
  approval?: ApprovalPort;
  /** How long a call waits for an approval before returning a pending result (default 0: do not wait). */
  approvalTimeoutMs?: number;
  /** Outbound tokens, bound to the caller and passed to tools as `ctx.credentials`. */
  credentials?: CredentialPort;
  /** Guards; those covering `tool_args` and `tool_result` run here. */
  guards?: readonly GuardPort[];
  telemetry?: TelemetryPort;
  /** Between source and tool name (default `__`). */
  separator?: string;
  /** Effective vocabularies (risk values added by config). */
  vocabularies?: Vocabularies;
  /** Largest `ext` bag kept on a tool spec or result (`limits.extBytes`). */
  extBytes?: number;
}

/** How a governed call ended; written to `ext["sdk.outcome"]` and to the `agent.tool.outcome` attribute. */
export type ToolOutcomeKind = 'ok' | 'error' | 'denied' | 'blocked' | 'redacted' | 'pending';

interface Entry { source: string; port: ToolPort; spec: ToolSpec }
interface Denial { reason: string; approval?: string }

/**
 * Aggregates several ToolPorts into one, naming tools `<source><separator><tool>`, and governs every call:
 * local policy → approval (for `ask`) → authorization → tool_args guards → call with bound
 * credentials → tool_result guards. Denials and blocks are error results, not exceptions. Every result carries
 * `ext["sdk.outcome"]`; a call waiting for an approval also `ext["sdk.approval"]` (the approval id).
 */
export function governedTools(ports: Readonly<Record<string, ToolPort>>, opts: GovernedToolsOptions = {}): ToolPort {
  const sep = opts.separator ?? '__';
  const vocab = opts.vocabularies ?? CORE_VOCABULARIES;
  const known = new Map<string, Entry>();
  const tel = (ctx: CallContext) => opts.telemetry ?? ctx.telemetry ?? noopTelemetry;
  const bound = <T extends { ext?: Record<string, unknown> }>(shape: T, kind: string, t: TelemetryPort): T => opts.extBytes === undefined ? shape
    : boundExt(shape, opts.extBytes, (bytes) => t.event(EVENT.extDropped, { [ATTR.layer]: 'tool', [ATTR.extBytes]: bytes, [ATTR.extShape]: kind }));

  async function listSource(source: string, ctx: CallContext): Promise<ToolSpec[]> {
    const port = ports[source]!;
    const specs = await port.listTools(ctx);
    return specs.map((raw) => {
      const spec = bound(raw, 'ToolSpec', tel(ctx));
      const name = `${source}${sep}${spec.name}`;
      known.set(name, { source, port, spec });
      return { ...spec, name };
    });
  }

  async function lookup(name: string, ctx: CallContext): Promise<Entry | undefined> {
    if (known.has(name)) return known.get(name);
    const source = Object.keys(ports).find((s) => name.startsWith(`${s}${sep}`));
    if (!source) return undefined;
    await listSource(source, ctx).catch(() => []);
    return known.get(name);
  }

  async function authorize(name: string, entry: Entry, args: Record<string, unknown>, ctx: CallContext): Promise<Denial | undefined> {
    const t = tel(ctx);
    return t.span(SPAN.accessCheck, { [ATTR.layer]: 'identity', [ATTR.toolName]: name }, async (span) => {
      const denied = await decide(name, entry, args, ctx);
      const decision = denied ? 'deny' : 'allow';
      span.setAttributes({ [ATTR.accessDecision]: decision, ...(denied ? { [ATTR.accessReason]: denied.reason } : {}) });
      t.metric(METRIC.accessDecisions, 1, { [ATTR.layer]: 'identity', [ATTR.toolName]: name, [ATTR.accessDecision]: decision });
      return denied;
    });
  }

  /** Undefined when allowed, otherwise why not. */
  async function decide(name: string, entry: Entry, args: Record<string, unknown>, ctx: CallContext): Promise<Denial | undefined> {
    const question = accessQuestion(name, entry.spec, args, ctx);
    if (opts.policy?.length) {
      const effect = evaluatePolicy(opts.policy, { tool: name, risk: riskOf(entry.spec), ...(ctx.caller ? { caller: ctx.caller } : {}) }, vocab);
      if (effect === 'deny') return { reason: 'denied by policy' };
      if (effect === 'ask') {
        if (!opts.approval) return { reason: 'approval required' };
        const pending = await opts.approval.request({ question, agent: ctx.agent, runId: ctx.runId });
        const answer = opts.approvalTimeoutMs ? await opts.approval.wait(pending.id, { timeoutMs: opts.approvalTimeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) }) : pending;
        if (answer.status === 'pending') return { reason: `approval pending: ${answer.id}`, approval: answer.id };
        if (answer.status !== 'approved') return { reason: `approval ${answer.status}${answer.reason ? `: ${answer.reason}` : ''}` };
      }
    }
    if (!opts.authorization) return undefined;
    try {
      const d = await opts.authorization.evaluate(question, ctx.signal ? { signal: ctx.signal } : {});
      return d.allowed === true ? undefined : { reason: d.reason ?? 'denied' };
    } catch (err) {
      if (isAbort(err)) throw err;
      return { reason: `authorization unavailable: ${errorMessage(err)}` };
    }
  }

  function bind(ctx: CallContext): CallContext {
    const provider = opts.credentials;
    if (!provider) return ctx;
    const credentials: BoundCredentials = {
      token: (audience, o) => provider.token(audience, { ...o, ...(ctx.caller ? { caller: ctx.caller } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) }),
    };
    return { ...ctx, credentials };
  }

  const result = (outcome: ToolOutcomeKind, r: ToolResult, extra: Record<string, unknown> = {}): ToolResult & { outcome: ToolOutcomeKind } =>
    ({ ...r, ext: withExt(r.ext, { 'sdk.outcome': outcome, ...extra }), outcome });

  async function call(name: string, entry: Entry, args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult & { outcome: ToolOutcomeKind }> {
    const t = tel(ctx);
    const denied = await authorize(name, entry, args, ctx);
    if (denied?.approval) return result('pending', { ok: false, text: `Waiting for approval ${denied.approval}` }, { 'sdk.approval': denied.approval });
    if (denied) return result('denied', { ok: false, text: `Denied: ${denied.reason}` });

    const guards = opts.guards ?? [];
    const argsCheck = await runGuards(guards, 'tool_args', JSON.stringify(args), ctx, t, name);
    if (argsCheck.action === 'block') return result('blocked', { ok: false, text: `Blocked by guardrail ${argsCheck.guard}` });
    let callArgs = args;
    if (argsCheck.action === 'redact') {
      try { callArgs = JSON.parse(argsCheck.text) as Record<string, unknown>; } catch {
        return result('blocked', { ok: false, text: 'Blocked by guardrail: redacted arguments are not valid JSON' });
      }
    }

    let out: ToolResult;
    try {
      out = bound(await entry.port.callTool(entry.spec.name, callArgs, bind(ctx)), 'ToolResult', t);
    } catch (err) {
      if (isAbort(err)) throw err;
      out = { ok: false, text: `Tool failed: ${errorMessage(err)}` };
    }

    const resultCheck = await runGuards(guards, 'tool_result', out.text, ctx, t, name);
    if (resultCheck.action === 'block') return result('blocked', { ok: false, text: `Result withheld by guardrail ${resultCheck.guard}` });
    if (resultCheck.action === 'redact') {
      const { data: _data, ...rest } = out;
      return result('redacted', { ...rest, text: resultCheck.text });
    }
    return result(out.ok ? 'ok' : 'error', out);
  }

  return {
    name: 'tools',
    async listTools(ctx) {
      const lists = await Promise.all(Object.keys(ports).map((s) => listSource(s, ctx)));
      return lists.flat();
    },
    async callTool(name, args, ctx) {
      const entry = await lookup(name, ctx);
      if (!entry) return { ok: false, text: `Unknown tool "${name}"`, ext: { 'sdk.outcome': 'error' } };
      const t = tel(ctx);
      return t.span(SPAN.toolCall, { [ATTR.layer]: entry.spec.layer ?? 'tool', [ATTR.toolName]: name, [ATTR.toolSource]: entry.source }, async (span) => {
        const { outcome, ...r } = await call(name, entry, args ?? {}, ctx);
        span.setAttributes({ [ATTR.toolOutcome]: outcome });
        t.metric(METRIC.toolCalls, 1, { [ATTR.layer]: 'tool', [ATTR.toolName]: name, [ATTR.toolOutcome]: outcome });
        return r;
      });
    },
    async close() {
      await Promise.allSettled(Object.values(ports).map((p) => p.close?.()));
    },
  };
}
