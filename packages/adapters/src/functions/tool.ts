import { validate, type Attrs, type CallContext, type Layer, type Risk, type ToolPort, type ToolResult, type ToolSpec } from '@agent-layers/core';

/** A tool written as a plain function. */
export interface ToolDef {
  /** Letters, digits, `_`, `.` and `-`. */
  name: string;
  description: string;
  /** JSON Schema of the arguments object; arguments are validated against it before `run`. */
  params: Record<string, unknown>;
  risk?: Risk;
  layer?: Layer;
  /** Audience a credential is needed for; the credential is available as `ctx.credentials`. */
  audience?: string;
  /** Plain attributes a policy may read (owner, tags). */
  attrs?: Attrs;
  /** A string, a `{ ok, text, data? }` result, or any JSON value. Throw to report an error to the model. */
  run(args: Record<string, unknown>, ctx: CallContext): unknown | Promise<unknown>;
}

/** Typed identity helper: checks a definition at the place it is written. */
export function defineTool(def: ToolDef): ToolDef {
  return def;
}

const NAME = /^[A-Za-z0-9_.-]+$/;

/** Shape check for values found in a module's exports. */
export function isToolDef(v: unknown): v is ToolDef {
  const d = v as Partial<ToolDef> | null;
  return !!d && typeof d === 'object' && typeof d.name === 'string' && typeof d.description === 'string'
    && !!d.params && typeof d.params === 'object' && typeof d.run === 'function';
}

function resultOf(value: unknown): ToolResult {
  if (typeof value === 'string') return { ok: true, text: value };
  if (value === undefined) return { ok: true, text: '' };
  const r = value as Partial<ToolResult> | null;
  if (r && typeof r === 'object' && typeof r.ok === 'boolean' && typeof r.text === 'string') {
    return { ok: r.ok, text: r.text, ...(r.data !== undefined ? { data: r.data } : {}) };
  }
  return { ok: true, text: JSON.stringify(value), data: value };
}

const isAbort = (err: unknown) => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/** A ToolPort over function definitions. */
export function functionTools(defs: readonly ToolDef[], name = 'functions'): ToolPort {
  const byName = new Map<string, ToolDef>();
  for (const d of defs) {
    if (!isToolDef(d)) throw new TypeError('functionTools: every definition needs name, description, params and run');
    if (!NAME.test(d.name)) throw new TypeError(`functionTools: invalid tool name "${d.name}"`);
    if (byName.has(d.name)) throw new TypeError(`functionTools: duplicate tool "${d.name}"`);
    byName.set(d.name, d);
  }
  return {
    name,
    async listTools(): Promise<ToolSpec[]> {
      return [...byName.values()].map((d) => ({
        name: d.name,
        description: d.description,
        params: d.params,
        ...(d.risk ? { risk: d.risk } : {}),
        ...(d.layer ? { layer: d.layer } : {}),
        ...(d.audience ? { audience: d.audience } : {}),
        ...(d.attrs ? { attrs: d.attrs } : {}),
      }));
    },
    async callTool(tool, args, ctx): Promise<ToolResult> {
      const def = byName.get(tool);
      if (!def) return { ok: false, text: `Unknown tool: ${tool}` };
      const errors = validate(def.params, args ?? {}, 'args');
      if (errors.length) return { ok: false, text: `Invalid arguments: ${errors.join('; ')}` };
      ctx.signal?.throwIfAborted();
      try {
        return resultOf(await def.run(args ?? {}, ctx));
      } catch (err) {
        if (isAbort(err) || ctx.signal?.aborted) throw err;
        return { ok: false, text: `Error: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}
