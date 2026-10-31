import type { CallContext, PortBase } from './base.ts';
import type { Layer } from '../layers.ts';

export type ToolRisk = 'read' | 'write' | 'exec';

/** Schema: spec/schemas/tool-spec.json. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  inputSchema: Record<string, unknown>;
  /** Layer the tool belongs to when it is not a plain `tool` (for example `knowledge`). */
  layer?: Layer;
  risk?: ToolRisk;
  /** Audience a credential is needed for, when the tool calls a protected service. */
  audience?: string;
  /** Technology-specific metadata. */
  meta?: Record<string, unknown>;
}

/** Schema: spec/schemas/tool-outcome.json. Errors are results, not exceptions, so the model can react. */
export interface ToolOutcome {
  content: string;
  data?: unknown;
  isError?: boolean;
}

/** List and call tools. */
export interface ToolPort extends PortBase {
  listTools(ctx: CallContext): Promise<ToolSpec[]>;
  callTool(name: string, args: Record<string, unknown>, ctx: CallContext): Promise<ToolOutcome>;
}
