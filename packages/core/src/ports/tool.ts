import type { Attrs, CallContext, Ext, PortBase } from './base.ts';
import type { Layer } from '../layers.ts';

/** Risk class read by policy. Core values; config may add values `like` one of them. Missing means `exec`. */
export type Risk = 'read' | 'write' | 'exec' | (string & {});

/** Schema: spec/schemas/tool-spec.json. */
export interface ToolSpec {
  /** Prefixed `<source>__<tool>` by the core. */
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  params: Record<string, unknown>;
  risk?: Risk;
  /** Layer the tool belongs to when it is not a plain `tool` (for example `knowledge`). */
  layer?: Layer;
  /** Credential audience of the protected service the tool calls. */
  audience?: string;
  /** Plain attributes a policy may read; copied to `AccessQuestion.target.attrs`. */
  attrs?: Attrs;
  ext?: Ext;
}

/** Schema: spec/schemas/tool-result.json. Errors are results, not exceptions, so the model can react. */
export interface ToolResult {
  ok: boolean;
  /** What the model reads. */
  text: string;
  /** Structured result. */
  data?: unknown;
  ext?: Ext;
}

/** List and call tools. */
export interface ToolPort extends PortBase {
  listTools(ctx: CallContext): Promise<ToolSpec[]>;
  callTool(name: string, args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult>;
}
