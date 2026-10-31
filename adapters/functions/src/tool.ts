import { validate, type CallContext, type Layer, type ToolOutcome, type ToolPort, type ToolRisk, type ToolSpec } from '@agent-layers/core';

/** A tool written as a plain function. */
export interface ToolDef {
  /** Letters, digits, `_`, `.` and `-`. */
  name: string;
  description: string;
  /** JSON Schema of the arguments object; arguments are validated against it before `run`. */
  inputSchema: Record<string, unknown>;
  risk?: ToolRisk;
  layer?: Layer;
  /** Audience a credential is needed for; the credential is available as `ctx.credentials`. */
  audience?: string;
  /** A string, an object with a string `content`, or any JSON value. Throw to report an error to the model. */
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
    && !!d.inputSchema && typeof d.inputSchema === 'object' && typeof d.run === 'function';
}

function outcomeOf(value: unknown): ToolOutcome {
  if (typeof value === 'string') return { content: value };
  if (value === undefined) return { content: '' };
  if (value && typeof value === 'object' && typeof (value as { content?: unknown }).content === 'string') return value as ToolOutcome;
  return { content: JSON.stringify(value), data: value };
}

const isAbort = (err: unknown) => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/** A ToolPort over function definitions. */
export function functionTools(defs: readonly ToolDef[], name = 'functions'): ToolPort {
  const byName = new Map<string, ToolDef>();
  for (const d of defs) {
    if (!isToolDef(d)) throw new TypeError('functionTools: every definition needs name, description, inputSchema and run');
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
        inputSchema: d.inputSchema,
        ...(d.risk ? { risk: d.risk } : {}),
        ...(d.layer ? { layer: d.layer } : {}),
        ...(d.audience ? { audience: d.audience } : {}),
      }));
    },
    async callTool(tool, args, ctx): Promise<ToolOutcome> {
      const def = byName.get(tool);
      if (!def) return { isError: true, content: `Unknown tool: ${tool}` };
      const errors = validate(def.inputSchema, args ?? {}, 'args');
      if (errors.length) return { isError: true, content: `Invalid arguments: ${errors.join('; ')}` };
      ctx.signal?.throwIfAborted();
      try {
        return outcomeOf(await def.run(args ?? {}, ctx));
      } catch (err) {
        if (isAbort(err) || ctx.signal?.aborted) throw err;
        return { isError: true, content: `Error: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}
