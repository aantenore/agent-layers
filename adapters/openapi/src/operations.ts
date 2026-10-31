import { matchesAny, type JsonSchema, type ToolRisk } from '@agent-layers/core';
import { baseUrlOf, deref, type OpenApiDocument } from './spec.ts';
import { checkRequestSpec, defaultRisk, type HttpMethod, type RequestSpec } from './request.ts';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head'] as const;
/** Headers OpenAPI defines as handled by the transport, not as parameters. */
const RESERVED_HEADERS = new Set(['accept', 'content-type', 'authorization']);
const MAX_DESCRIPTION_CHARS = 1000;

export interface Operation {
  /** Tool name: the operationId, or `<method>_<path>` when there is none. */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  risk: ToolRisk;
  request: RequestSpec & { method: HttpMethod };
}

export interface OperationOptions {
  baseUrl?: string;
  /** Globs of operationIds to import (default: all). */
  include?: string[];
  /** Risk by HTTP method (upper case), over the default of read for GET and HEAD and write otherwise. */
  risk?: Partial<Record<string, ToolRisk>>;
  auth?: RequestSpec['auth'];
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResultChars?: number;
}

const truncate = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}…`);
const safeName = (name: string) => name.replace(/[^A-Za-z0-9_.-]/g, '_');
const jsonContent = (content: Record<string, any> | undefined) => {
  const key = Object.keys(content ?? {}).find((k) => /^application\/(.+\+)?json(;|$)/i.test(k) || k === '*/*');
  return key ? content![key] : undefined;
};

/** Operations of an OpenAPI 3 document (already parsed). Operations with a non-JSON request body are skipped. */
export function operationsOf(spec: OpenApiDocument, specUrl: string | undefined, opts: OperationOptions = {}): Operation[] {
  if (typeof spec?.openapi !== 'string' || !spec.openapi.startsWith('3')) {
    throw new Error('not an OpenAPI 3 document (missing "openapi: 3.x"; Swagger 2 is not supported)');
  }
  const base = baseUrlOf(spec, opts.baseUrl, specUrl);
  const out: Operation[] = [];
  const used = new Set<string>();

  for (const [path, rawItem] of Object.entries<any>(spec.paths ?? {})) {
    const item = deref(spec, rawItem);
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const operationId: string = op.operationId ?? `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
      if (opts.include && !matchesAny(opts.include, operationId)) continue;

      const params = new Map<string, any>();
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) if (['path', 'query', 'header'].includes(p.in)) params.set(`${p.in}:${p.name}`, p);
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      const query: string[] = [];
      const headerArgs: string[] = [];
      for (const p of params.values()) {
        if (p.in === 'header' && RESERVED_HEADERS.has(String(p.name).toLowerCase())) continue;
        if (properties[p.name]) throw new Error(`OpenAPI operation "${operationId}": parameter "${p.name}" is declared in more than one location; exclude it with "include"`);
        properties[p.name] = { ...(p.schema ?? {}), ...(p.description ? { description: p.description } : {}) };
        if (p.in === 'path' || p.required) required.push(p.name);
        if (p.in === 'query') query.push(p.name);
        if (p.in === 'header') headerArgs.push(p.name);
      }

      let bodyArg: string | undefined;
      const hasBody = op.requestBody !== undefined;
      if (hasBody) {
        const media = jsonContent(op.requestBody.content);
        if (!media) continue;
        const schema = media.schema ?? {};
        const keys = schema.type === 'object' && schema.properties ? Object.keys(schema.properties) : [];
        if (keys.length && keys.every((k) => !properties[k])) {
          Object.assign(properties, schema.properties);
          if (op.requestBody.required) required.push(...((schema.required as string[] | undefined) ?? []));
        } else {
          bodyArg = 'body';
          properties.body = { ...schema, ...(op.requestBody.description && !schema.description ? { description: op.requestBody.description } : {}) };
          if (op.requestBody.required) required.push('body');
        }
      }

      let name = safeName(operationId);
      for (let n = 2; used.has(name); n++) name = `${safeName(operationId)}_${n}`;
      used.add(name);
      const upper = method.toUpperCase() as HttpMethod;
      const request: RequestSpec & { method: HttpMethod } = {
        method: upper,
        url: `${base}${path}`,
        query,
        headerArgs,
        ...(opts.headers ? { headers: opts.headers } : {}),
        body: hasBody ? 'json' : 'none',
        ...(bodyArg ? { bodyArg } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.maxResultChars ? { maxResultChars: opts.maxResultChars } : {}),
        ...(opts.auth ? { auth: opts.auth } : {}),
      };
      checkRequestSpec(name, request);
      out.push({
        name,
        description: truncate([op.summary, op.description].filter(Boolean).join(': ') || `${upper} ${path}`, MAX_DESCRIPTION_CHARS),
        inputSchema: { type: 'object', properties, required, additionalProperties: false },
        risk: opts.risk?.[upper] ?? defaultRisk(upper),
        request,
      });
    }
  }
  return out;
}
