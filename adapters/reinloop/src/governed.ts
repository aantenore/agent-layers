import { assembleDeltas, GuardrailBlocked, type CallContext, type ModelPort, type RunStatus, type StopReason, type ToolPort, type ToolSpec } from '@agent-layers/core';
import { RunStop, type Provider, type Tool } from 'reinloop';
import { fromModelReply, toModelRequest } from './convert.ts';

/**
 * What ends a run from inside the governed ports. reinloop only knows a string reason, so the structured one is kept
 * here: `end` when a guard blocked or a call is waiting for a person, `error` for an error thrown by the model.
 * `halt` aborts the tool batch of a stopped run.
 */
export interface RunControl {
  halt: AbortController;
  end?: { status: RunStatus; reason: StopReason };
  error?: unknown;
}

/**
 * The stack's governed model as a reinloop Provider. Every call goes through the SDK pipeline (input guards, cache,
 * router, knowledge, output guards, the `agent.model.call` span), with the run's call context. A guard block ends the
 * run through reinloop's `RunStop`; the run then ends `stopped` with the guard's stop reason. `ext` is the agent's
 * (keys of the model adapter's namespace), sent with every request.
 */
export function governedProvider(model: ModelPort, ctx: CallContext, control: RunControl, opts: { stream?: boolean; ext?: Record<string, unknown> } = {}): Provider {
  return {
    name: model.name ?? 'agent-layers',
    async generate(req, g) {
      const request = toModelRequest(req, opts.ext);
      const call: CallContext = { ...ctx, signal: g.signal };
      try {
        if (opts.stream && g.onText && model.stream) {
          const deltas = [];
          for await (const d of model.stream(request, call)) {
            deltas.push(d);
            if (d.type === 'text' && d.text) g.onText(d.text);
          }
          return fromModelReply(assembleDeltas(deltas, request.model), request.model);
        }
        return fromModelReply(await model.chat(request, call), request.model);
      } catch (err) {
        if (err instanceof GuardrailBlocked) {
          control.end ??= { status: 'stopped', reason: err.stopReason };
          throw new RunStop('guard_block');
        }
        control.error ??= err;
        throw err;
      }
    },
  };
}

/** reinloop knows three risks; a risk added by config has no equivalent there (the stack's policy decides). */
const isCoreRisk = (r: string | undefined): r is 'read' | 'write' | 'exec' => r === 'read' || r === 'write' || r === 'exec';

/**
 * One governed SDK tool as a reinloop Tool: name, description, schema, risk and layer pass through; the call goes
 * through the stack's governed tools (policy, approval, authorization, tool guards, bound credentials, the
 * `agent.tool.call` span). Denials and guard blocks come back as error results, as in any runtime. A GuardrailBlocked
 * thrown by a tool ends the run like a model block. A result waiting for an approval (`ext["sdk.approval"]`) ends the
 * run `waiting`, with `approval` as the instance that holds it. In both cases `halt` aborts the batch and `RunStop`
 * ends the loop.
 */
export function governedTool(tools: ToolPort, spec: ToolSpec, ctx: CallContext, control: RunControl, approval?: string): Tool {
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.params,
    ...(isCoreRisk(spec.risk) ? { risk: spec.risk } : {}),
    ...(spec.layer ? { layer: spec.layer as Tool['layer'] } : {}),
    async run(args, t) {
      const input = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
      const stop = (end: NonNullable<RunControl['end']>, why: string): never => {
        control.end ??= end;
        const stopped = new RunStop(why);
        control.halt.abort(stopped);
        throw stopped;
      };
      try {
        const out = await tools.callTool(spec.name, input, { ...ctx, signal: t.signal });
        const waitingOn = out.ext?.['sdk.approval'];
        if (typeof waitingOn === 'string') {
          return stop({ status: 'waiting', reason: { code: 'needs_input', layer: 'identity', ...(approval ? { by: approval } : {}), detail: waitingOn } }, 'needs_input');
        }
        return { content: out.text, ...(out.ok ? {} : { isError: true }) };
      } catch (err) {
        if (err instanceof RunStop || !(err instanceof GuardrailBlocked)) throw err;
        return stop({ status: 'stopped', reason: err.stopReason }, 'guard_block');
      }
    },
  };
}
