import { defineAdapter, PORT_VERSIONS, type CallContext, type JsonSchema, type ToolOutcome, type ToolPort, type ToolRisk } from '@agent-layers/core';
import { interpolate } from './env.ts';
import { operationsOf, type Operation } from './operations.ts';
import { checkArgs, sendRequest } from './request.ts';
import { readSpec, type OpenApiDocument } from './spec.ts';

export { operationsOf, readSpec, type Operation, type OpenApiDocument };

/** Options, validated against `optionsSchema` before `create` runs. */
export interface OpenApiOptions {
  /** OpenAPI 3 document as JSON: a file path (relative to the config directory), an http(s) URL, or the document itself. */
  spec: string | OpenApiDocument;
  /** Server the operations are called on (default: the first of the spec's `servers`). */
  baseUrl?: string;
  /** Globs of operationIds to import (default: all). */
  include?: string[];
  /** Risk by HTTP method (upper case); default `read` for GET and HEAD, `write` otherwise. */
  risk?: Partial<Record<'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', ToolRisk>>;
  /** Bearer token from the caller's credentials for every operation. */
  auth?: { audience: string; scopes?: string[] };
  /** Static headers sent with every call. `${env:NAME}` is resolved when the tools are built. */
  headers?: Record<string, string>;
  /** Time limit per request (default 30000). */
  timeoutMs?: number;
  /** Response text cap (default 16000). */
  maxResultChars?: number;
}

export interface OpenApiDeps {
  name?: string;
  /** Directory relative spec paths resolve against. */
  cwd?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/** Factory: usable directly from code, without the registry. Reads the spec, so it is asynchronous. */
export async function createOpenApiTools(options: OpenApiOptions, { name = 'openapi', cwd = process.cwd(), env = process.env, signal }: OpenApiDeps = {}): Promise<ToolPort> {
  const loaded = typeof options.spec === 'string' ? await readSpec(interpolate(options.spec, env, 'spec'), cwd, signal) : { spec: options.spec, url: undefined };
  const { spec: _spec, baseUrl, headers, ...rest } = options;
  const operations = operationsOf(loaded.spec, loaded.url, {
    ...rest,
    ...(baseUrl ? { baseUrl: interpolate(baseUrl, env, 'baseUrl') } : {}),
    ...(headers ? { headers: interpolate(headers, env, 'headers') } : {}),
  });
  const byName = new Map(operations.map((o) => [o.name, o]));
  return {
    name,
    async listTools() {
      return operations.map((o) => ({
        name: o.name, description: o.description, inputSchema: o.inputSchema, risk: o.risk, layer: 'tool' as const,
        ...(o.request.auth ? { audience: o.request.auth.audience } : {}),
      }));
    },
    async callTool(tool: string, args: Record<string, unknown>, ctx: CallContext): Promise<ToolOutcome> {
      const op = byName.get(tool);
      if (!op) return { content: `Unknown tool: ${tool}`, isError: true };
      const input = args ?? {};
      const invalid = checkArgs(op.inputSchema, input);
      if (invalid) return invalid;
      ctx.signal?.throwIfAborted();
      return sendRequest(tool, op.request, input, ctx);
    },
  };
}

const strings: JsonSchema = { type: 'array', items: { type: 'string', minLength: 1 } };
const risk: JsonSchema = { enum: ['read', 'write', 'exec'] };

/** Descriptor: what the registry and the CLI see. */
export const adapter = defineAdapter<'ToolPort', OpenApiOptions>({
  layer: 'tool',
  port: 'ToolPort',
  name: 'openapi',
  direction: 'outbound',
  maps: { standard: 'OpenAPI 3' },
  portVersion: PORT_VERSIONS.ToolPort,
  tiers: ['prototype', 'production'],
  description: 'Turns the operations of an OpenAPI 3 document (JSON) into tools; risk follows the HTTP method.',
  optionsSchema: {
    type: 'object',
    properties: {
      spec: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'object' }] },
      baseUrl: { type: 'string', minLength: 1 },
      include: strings,
      risk: {
        type: 'object',
        properties: { GET: risk, HEAD: risk, POST: risk, PUT: risk, PATCH: risk, DELETE: risk },
        additionalProperties: false,
      },
      auth: {
        type: 'object',
        properties: { audience: { type: 'string', minLength: 1 }, scopes: strings },
        required: ['audience'],
        additionalProperties: false,
      },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      timeoutMs: { type: 'integer', minimum: 1 },
      maxResultChars: { type: 'integer', minimum: 1 },
    },
    required: ['spec'],
    additionalProperties: false,
  },
  create: (options, ctx) => createOpenApiTools(options, { name: ctx.name, cwd: ctx.cwd, env: ctx.env }),
});

export const adapters = [adapter];
