import { errorMessage, isAbort } from '../errors.ts';
import type { BoundCredentials, CallContext } from '../ports/base.ts';
import type { GuardPort } from '../ports/guard.ts';
import type { ApprovalPort, AuthorizationPort, CredentialPort } from '../ports/identity.ts';
import type { TelemetryPort } from '../ports/telemetry.ts';
import type { ToolOutcome, ToolPort, ToolSpec } from '../ports/tool.ts';
import { evaluatePolicy, riskOf, toolAccessRequest, type PolicyRule } from '../policy.ts';
import { noopTelemetry } from '../telemetry.ts';
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
}

interface Entry { source: string; port: ToolPort; spec: ToolSpec }

/**
 * Aggregates several ToolPorts into one, naming tools `<source><separator><tool>`, and governs every call:
 * local policy → approval (for `ask`) → authorization → tool_args guards → call with bound
 * credentials → tool_result guards. Denials and blocks are error results, not exceptions.
 */
export function governedTools(ports: Readonly<Record<string, ToolPort>>, opts: GovernedToolsOptions = {}): ToolPort {
  const sep = opts.separator ?? '__';
  const known = new Map<string, Entry>();
  const tel = (ctx: CallContext) => opts.telemetry ?? ctx.telemetry ?? noopTelemetry;

  async function listSource(source: string, ctx: CallContext): Promise<ToolSpec[]> {
    const port = ports[source]!;
    const specs = await port.listTools(ctx);
    return specs.map((spec) => {
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

  async function authorize(name: string, entry: Entry, args: Record<string, unknown>, ctx: CallContext): Promise<string | undefined> {
    const t = tel(ctx);
    return t.span('authorize', { 'agent.layer': 'identity', 'gen_ai.tool.name': name }, async (span) => {
      const denied = await decide(name, entry, args, ctx);
      span.setAttributes({ 'policy.decision': denied ? 'deny' : 'allow', ...(denied ? { 'policy.reason': denied } : {}) });
      t.metric('agent.policy.decisions', 1, { 'agent.layer': 'identity', 'gen_ai.tool.name': name, 'policy.decision': denied ? 'deny' : 'allow' });
      return denied;
    });
  }

  /** Undefined when allowed, otherwise the reason for the denial. */
  async function decide(name: string, entry: Entry, args: Record<string, unknown>, ctx: CallContext): Promise<string | undefined> {
    const request = toolAccessRequest(name, entry.spec, args, ctx);
    if (opts.policy?.length) {
      const effect = evaluatePolicy(opts.policy, { tool: name, risk: riskOf(entry.spec), ...(ctx.identity ? { identity: ctx.identity } : {}) });
      if (effect === 'deny') return 'denied by policy';
      if (effect === 'ask') {
        if (!opts.approval) return 'approval required';
        const pending = await opts.approval.request({ access: request, agent: ctx.agent, runId: ctx.runId });
        const answer = opts.approvalTimeoutMs ? await opts.approval.wait(pending.id, { timeoutMs: opts.approvalTimeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) }) : pending;
        if (answer.status === 'pending') return `approval pending: ${answer.id}`;
        if (answer.status !== 'approved') return `approval ${answer.status}${answer.reason ? `: ${answer.reason}` : ''}`;
      }
    }
    if (!opts.authorization) return undefined;
    try {
      const d = await opts.authorization.evaluate(request, ctx.signal ? { signal: ctx.signal } : {});
      return d.decision === true ? undefined : (d.context?.reason ?? 'denied');
    } catch (err) {
      if (isAbort(err)) throw err;
      return `authorization unavailable: ${errorMessage(err)}`;
    }
  }

  function bind(ctx: CallContext): CallContext {
    const provider = opts.credentials;
    if (!provider) return ctx;
    const credentials: BoundCredentials = {
      token: (audience, o) => provider.token(audience, { ...o, ...(ctx.identity ? { identity: ctx.identity } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) }),
    };
    return { ...ctx, credentials };
  }

  async function call(name: string, entry: Entry, args: Record<string, unknown>, ctx: CallContext): Promise<ToolOutcome & { outcome: string }> {
    const t = tel(ctx);
    const denied = await authorize(name, entry, args, ctx);
    if (denied) return { content: `Denied: ${denied}`, isError: true, outcome: 'denied' };

    const guards = opts.guards ?? [];
    const argsCheck = await runGuards(guards, 'tool_args', JSON.stringify(args), ctx, t, name);
    if (argsCheck.action === 'block') return { content: `Blocked by guardrail ${argsCheck.guard}`, isError: true, outcome: 'blocked' };
    let callArgs = args;
    if (argsCheck.action === 'redact') {
      try { callArgs = JSON.parse(argsCheck.text) as Record<string, unknown>; } catch {
        return { content: `Blocked by guardrail: redacted arguments are not valid JSON`, isError: true, outcome: 'blocked' };
      }
    }

    let result: ToolOutcome;
    try {
      result = await entry.port.callTool(entry.spec.name, callArgs, bind(ctx));
    } catch (err) {
      if (isAbort(err)) throw err;
      result = { content: `Tool failed: ${errorMessage(err)}`, isError: true };
    }

    const resultCheck = await runGuards(guards, 'tool_result', result.content, ctx, t, name);
    if (resultCheck.action === 'block') return { content: `Result withheld by guardrail ${resultCheck.guard}`, isError: true, outcome: 'blocked' };
    if (resultCheck.action === 'redact') return { content: resultCheck.text, ...(result.isError ? { isError: true } : {}), outcome: 'redacted' };
    return { ...result, outcome: result.isError ? 'error' : 'ok' };
  }

  return {
    name: 'tools',
    async listTools(ctx) {
      const lists = await Promise.all(Object.keys(ports).map((s) => listSource(s, ctx)));
      return lists.flat();
    },
    async callTool(name, args, ctx) {
      const entry = await lookup(name, ctx);
      if (!entry) return { content: `Unknown tool "${name}"`, isError: true };
      const t = tel(ctx);
      return t.span('execute_tool', { 'agent.layer': entry.spec.layer ?? 'tool', 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': name, 'tool.source': entry.source }, async (span) => {
        const { outcome, ...result } = await call(name, entry, args ?? {}, ctx);
        span.setAttributes({ 'tool.outcome': outcome });
        t.metric('agent.tool.calls', 1, { 'agent.layer': 'tool', 'gen_ai.tool.name': name, 'tool.outcome': outcome });
        return result;
      });
    },
    async close() {
      await Promise.allSettled(Object.values(ports).map((p) => p.close?.()));
    },
  };
}
