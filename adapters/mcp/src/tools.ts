import {
  createMappings, limitValue, matchesAny, withExt, type BoundCredentials, type Ext, type LimitValue, type Mappings, type MappingRule, type Risk, type TelemetryPort,
  type ToolPort, type ToolResult, type ToolSpec,
} from '@agent-layers/core';
import { bearer, McpSession } from './client.ts';
import { interpolate } from './env.ts';
import { CONNECTION_LIMITS, TOOLS_LIMITS } from './limits.ts';
import { redact, redactStructured, scrubError, secretForms, staticSecrets } from './redact.ts';
import { McpRpcError, type McpServerOptions } from './transport.ts';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface McpToolsOptions extends McpServerOptions {
  /** Force a risk level for every tool; otherwise derived from `readOnly` and the MCP tool annotations. */
  risk?: Risk;
  /** Globs of tools known to be read-only when the server does not annotate them (risk `read`). */
  readOnly?: string[];
  /** Globs of tool names to expose (default: all). */
  include?: string[];
  /** Globs of tool names to hide. */
  exclude?: string[];
  /** How long the tool list is cached (default 60000). */
  toolsTtlMs?: number;
  /** Pages of `tools/list` read before the server is refused (default 100). */
  maxToolPages?: LimitValue;
}

export interface McpDeps {
  name?: string;
  env?: Record<string, string | undefined>;
  /** Credentials for the connection requests; without them the credentials of the call that opens the connection are used. */
  credentials?: BoundCredentials;
  /** The stack's telemetry: its active span's trace context goes with each HTTP request. */
  telemetry?: TelemetryPort;
  /** `in` rules on `ToolSpec` run over each MCP tool (default: {@link TOOL_RULES}). */
  mappings?: Mappings;
}

const SAFE_NAME = /[^A-Za-z0-9_.-]/g;

/** Ext keys of the tool adapter. */
export const TOOL_EXT = { annotations: 'mcp.annotations', meta: 'mcp.meta', name: 'mcp.name', content: 'mcp.content' } as const;

/**
 * Default `in` rules from an MCP tool to its spec: the risk from the annotations. `exec` unless `destructiveHint` is
 * false (`write`) or `readOnlyHint` is true (`read`). Replaceable by the `mappings` block of the stack config.
 */
export const TOOL_RULES: readonly MappingRule[] = [
  { from: '/annotations/destructiveHint', to: '/risk', map: { true: 'exec', false: 'write' }, default: 'exec' },
  { from: '/annotations/readOnlyHint', to: '/risk', map: { true: 'read' } },
];

interface Entry { spec: ToolSpec; mcpName: string }

/** ToolPort over one MCP server. The stack prefixes the tool names with the source name. */
export function createMcpTools(options: McpToolsOptions, deps: McpDeps = {}): ToolPort {
  const env = deps.env ?? process.env;
  const mappings = deps.mappings ?? createMappings(deps.name ?? 'mcp', { in: TOOL_RULES });
  const cfg = interpolate(options, env, 'mcp');
  const session = new McpSession(cfg, { env, ...(deps.credentials ? { credentials: deps.credentials } : {}), ...(deps.telemetry ? { telemetry: deps.telemetry } : {}) });
  const ttl = limitValue(TOOLS_LIMITS.toolsTtlMs, cfg.toolsTtlMs);
  const minSecretChars = limitValue(CONNECTION_LIMITS.minSecretChars, cfg.minSecretChars);
  const { auth } = cfg;
  const staticForms = secretForms(staticSecrets(cfg.headers), minSecretChars);
  let cache: { at: number; tools: Map<string, Entry> } | undefined;

  async function load(credentials: BoundCredentials | undefined): Promise<Map<string, Entry>> {
    if (cache && Date.now() - cache.at < ttl) return cache.tools;
    let infos;
    try {
      infos = await session.run((c) => c.listTools(), credentials);
    } catch (err) {
      throw scrubError(err, staticForms);
    }
    const tools = new Map<string, Entry>();
    for (const info of infos) {
      if (cfg.include && !matchesAny(cfg.include, info.name)) continue;
      if (cfg.exclude && matchesAny(cfg.exclude, info.name)) continue;
      let name = info.name.replace(SAFE_NAME, '_');
      for (let n = 2; tools.has(name); n++) name = `${info.name.replace(SAFE_NAME, '_')}_${n}`;
      const ext = withExt(undefined, {
        [TOOL_EXT.annotations]: info.annotations,
        [TOOL_EXT.meta]: info._meta,
        [TOOL_EXT.name]: name !== info.name ? info.name : undefined,
      });
      const mapped: ToolSpec = mappings.in(info, {
        name,
        description: info.description ?? info.title ?? info.name,
        params: info.inputSchema && typeof info.inputSchema === 'object' ? info.inputSchema : { type: 'object', properties: {} },
        ...(auth ? { audience: auth.audience } : {}),
        ...(ext ? { ext } : {}),
      } satisfies ToolSpec);
      // The `readOnly` globs and a forced risk win over the annotations; the name stays the one calls are routed by.
      const risk = cfg.risk ?? (cfg.readOnly?.length && matchesAny(cfg.readOnly, info.name) ? 'read' : mapped.risk);
      tools.set(name, { mcpName: info.name, spec: { ...mapped, name, ...(risk ? { risk } : {}) } });
    }
    cache = { at: Date.now(), tools };
    return tools;
  }

  const failure = (text: string): ToolResult => ({ ok: false, text });

  return {
    name: deps.name ?? 'mcp',
    async listTools(ctx) {
      return [...(await load(ctx.credentials)).values()].map((e) => e.spec);
    },
    async callTool(name, args, ctx): Promise<ToolResult> {
      const entry = (await load(ctx.credentials)).get(name);
      if (!entry) return failure(`Unknown tool: ${name}`);
      let headers: Record<string, string> | undefined;
      let token: string | undefined;
      if (auth) {
        if (!ctx.credentials) return failure(`${name} needs credentials for audience "${auth.audience}" and this run has none; the request was not sent`);
        try {
          token = await ctx.credentials.token(auth.audience, auth.scopes ? { scopes: auth.scopes } : {});
        } catch (err) {
          return failure(`Could not get a token for audience "${auth.audience}": ${err instanceof Error ? err.message : String(err)}; the request was not sent`);
        }
        headers = bearer(token);
      }
      // A server may echo request headers back; the token and static header secrets must not reach the model.
      const forms = token ? secretForms([token, ...staticSecrets(cfg.headers)], minSecretChars) : staticForms;
      try {
        const res = await session.run((c) => c.callTool(entry.mcpName, args, ctx.signal, headers), ctx.credentials);
        let text = redact(res.text, forms);
        let data: unknown;
        let ext: Ext | undefined;
        if (res.structured !== undefined) {
          const clean = redactStructured(res.structured, forms);
          if (clean.dropped) text += '\n[structured content dropped: it contained a secret]';
          else data = clean.value;
        }
        if (res.items?.length) {
          const clean = redactStructured(res.items, forms);
          if (clean.dropped) text += '\n[non-text content dropped: it contained a secret]';
          else ext = { [TOOL_EXT.content]: clean.value };
        }
        return { ok: !res.isError, text, ...(data !== undefined ? { data } : {}), ...(ext ? { ext } : {}) };
      } catch (err) {
        // Every error leaving this call carries a masked message, whatever raised it.
        const clean = scrubError(err, forms);
        if (clean instanceof McpRpcError) return failure(clean.message);
        throw clean;
      }
    },
    native: () => session,
    close: () => session.close(),
  };
}
