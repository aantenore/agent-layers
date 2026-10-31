import { defineAdapter, PORT_VERSIONS, type JsonSchema, type ToolOutcome, type ToolPort, type ToolRisk, type ToolSpec } from '@agent-layers/core';
import { interpolate } from './env.ts';
import { checkArgs, checkRequestSpec, defaultRisk, pathArgs, sendRequest, type HttpMethod, type RequestSpec } from './request.ts';

export { sendRequest, type HttpMethod, type RequestSpec };

/** One declarative HTTP tool. `${env:NAME}` in `url` and `headers` is resolved when the tool is built. */
export interface HttpToolDef extends Omit<RequestSpec, 'method'> {
  description: string;
  method: HttpMethod | Lowercase<HttpMethod>;
  /** JSON Schema of the arguments (default: derived from the path, query and header arguments). */
  schema?: Record<string, unknown>;
  /** Default: `read` for GET and HEAD, `write` otherwise. */
  risk?: ToolRisk;
}

/** Options, validated against `optionsSchema` before `create` runs. */
export interface HttpToolsOptions {
  /** Tools by name. */
  tools: Record<string, HttpToolDef>;
  /** Default time limit per request (default 30000). */
  timeoutMs?: number;
  /** Default response text cap (default 16000). */
  maxResultChars?: number;
}

const NAME = /^[A-Za-z0-9_.-]+$/;

function defaultSchema(def: HttpToolDef): Record<string, unknown> {
  const path = pathArgs(def.url);
  const properties = Object.fromEntries([...path, ...(def.query ?? []), ...(def.headerArgs ?? []), ...(def.bodyArg ? [def.bodyArg] : [])].map((k) => [k, {}]));
  return { type: 'object', properties, required: path, ...(def.body === 'json' && !def.bodyArg ? {} : { additionalProperties: false }) };
}

/** Factory: usable directly from code, without the registry. */
export function createHttpTools(options: HttpToolsOptions, { name = 'http-tools', env = process.env }: { name?: string; env?: Record<string, string | undefined> } = {}): ToolPort {
  const tools = new Map<string, { spec: ToolSpec; request: RequestSpec & { method: HttpMethod }; schema: Record<string, unknown> }>();
  for (const [toolName, def] of Object.entries(options.tools ?? {})) {
    if (!NAME.test(toolName)) throw new TypeError(`http-tools: invalid tool name "${toolName}" (letters, digits, _ . -)`);
    const resolved = interpolate({ url: def.url, headers: def.headers }, env, `tools.${toolName}`);
    const method = checkRequestSpec(toolName, { ...def, ...resolved } as RequestSpec);
    const request: RequestSpec & { method: HttpMethod } = {
      method, url: resolved.url,
      ...(def.query ? { query: def.query } : {}),
      ...(def.headerArgs ? { headerArgs: def.headerArgs } : {}),
      ...(resolved.headers ? { headers: resolved.headers } : {}),
      ...(def.body ? { body: def.body } : {}),
      ...(def.bodyArg ? { bodyArg: def.bodyArg } : {}),
      ...(def.auth ? { auth: def.auth } : {}),
      timeoutMs: def.timeoutMs ?? options.timeoutMs ?? 30_000,
      maxResultChars: def.maxResultChars ?? options.maxResultChars ?? 16_000,
    };
    const schema = def.schema ?? defaultSchema(def);
    tools.set(toolName, {
      request, schema,
      spec: {
        name: toolName, description: def.description, inputSchema: schema, risk: def.risk ?? defaultRisk(method),
        layer: 'tool', ...(def.auth ? { audience: def.auth.audience } : {}),
      },
    });
  }
  return {
    name,
    async listTools() {
      return [...tools.values()].map((t) => t.spec);
    },
    async callTool(toolName, args, ctx): Promise<ToolOutcome> {
      const tool = tools.get(toolName);
      if (!tool) return { content: `Unknown tool: ${toolName}`, isError: true };
      const input = args ?? {};
      const invalid = checkArgs(tool.schema, input);
      if (invalid) return invalid;
      ctx.signal?.throwIfAborted();
      return sendRequest(toolName, tool.request, input, ctx);
    },
  };
}

const strings: JsonSchema = { type: 'array', items: { type: 'string', minLength: 1 } };

/** Descriptor: what the registry and the CLI see. */
export const adapter = defineAdapter<'ToolPort', HttpToolsOptions>({
  layer: 'tool',
  port: 'ToolPort',
  name: 'http-tools',
  direction: 'outbound',
  maps: { standard: 'HTTP/JSON' },
  portVersion: PORT_VERSIONS.ToolPort,
  tiers: ['prototype', 'production'],
  description: 'Declarative HTTP/JSON tools: path, query and header arguments, JSON bodies and bearer tokens from the caller credentials.',
  optionsSchema: {
    type: 'object',
    properties: {
      tools: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: {
            description: { type: 'string', minLength: 1 },
            method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'get', 'post', 'put', 'patch', 'delete', 'head'] },
            url: { type: 'string', minLength: 1 },
            query: strings,
            headerArgs: strings,
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            body: { enum: ['json', 'none'] },
            bodyArg: { type: 'string', minLength: 1 },
            schema: { type: 'object' },
            risk: { enum: ['read', 'write', 'exec'] },
            timeoutMs: { type: 'integer', minimum: 1 },
            maxResultChars: { type: 'integer', minimum: 1 },
            auth: {
              type: 'object',
              properties: { audience: { type: 'string', minLength: 1 }, scopes: strings },
              required: ['audience'],
              additionalProperties: false,
            },
          },
          required: ['description', 'method', 'url'],
          additionalProperties: false,
        },
      },
      timeoutMs: { type: 'integer', minimum: 1 },
      maxResultChars: { type: 'integer', minimum: 1 },
    },
    required: ['tools'],
    additionalProperties: false,
  },
  create: (options, ctx) => createHttpTools(options, { name: ctx.name, env: ctx.env }),
});

export const adapters = [adapter];
