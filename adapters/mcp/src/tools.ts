import { matchesAny, type BoundCredentials, type ToolOutcome, type ToolPort, type ToolRisk, type ToolSpec } from '@agent-layers/core';
import { bearer, McpSession, type McpToolInfo } from './client.ts';
import { interpolate } from './env.ts';
import { McpRpcError, type McpServerOptions } from './transport.ts';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface McpToolsOptions extends McpServerOptions {
  /** Force a risk level for every tool; otherwise derived from `readOnly` and the MCP tool annotations. */
  risk?: ToolRisk;
  /** Globs of tools known to be read-only when the server does not annotate them (risk `read`). */
  readOnly?: string[];
  /** Globs of tool names to expose (default: all). */
  include?: string[];
  /** Globs of tool names to hide. */
  exclude?: string[];
  /** How long the tool list is cached (default 60000). */
  toolsTtlMs?: number;
}

export interface McpDeps {
  name?: string;
  env?: Record<string, string | undefined>;
  /** Credentials for the connection requests; without them the credentials of the call that opens the connection are used. */
  credentials?: BoundCredentials;
}

const DEFAULT_TOOLS_TTL_MS = 60_000;
const SAFE_NAME = /[^A-Za-z0-9_.-]/g;

/** Risk of a tool: forced value, then the `readOnly` globs, then the MCP annotations; unknown means exec. */
export function riskOf(info: McpToolInfo, forced?: ToolRisk, readOnly?: readonly string[]): ToolRisk {
  if (forced) return forced;
  if (readOnly?.length && matchesAny(readOnly, info.name)) return 'read';
  if (info.annotations?.readOnlyHint) return 'read';
  if (info.annotations?.destructiveHint === false) return 'write';
  return 'exec';
}

interface Entry { spec: ToolSpec; mcpName: string }

/** ToolPort over one MCP server. The stack prefixes the tool names with the source name. */
export function createMcpTools(options: McpToolsOptions, deps: McpDeps = {}): ToolPort {
  const env = deps.env ?? process.env;
  const cfg = interpolate(options, env, 'mcp');
  const session = new McpSession(cfg, { env, ...(deps.credentials ? { credentials: deps.credentials } : {}) });
  const ttl = cfg.toolsTtlMs ?? DEFAULT_TOOLS_TTL_MS;
  const { auth } = cfg;
  let cache: { at: number; tools: Map<string, Entry> } | undefined;

  async function load(credentials: BoundCredentials | undefined): Promise<Map<string, Entry>> {
    if (cache && Date.now() - cache.at < ttl) return cache.tools;
    const infos = await session.run((c) => c.listTools(), credentials);
    const tools = new Map<string, Entry>();
    for (const info of infos) {
      if (cfg.include && !matchesAny(cfg.include, info.name)) continue;
      if (cfg.exclude && matchesAny(cfg.exclude, info.name)) continue;
      let name = info.name.replace(SAFE_NAME, '_');
      for (let n = 2; tools.has(name); n++) name = `${info.name.replace(SAFE_NAME, '_')}_${n}`;
      tools.set(name, {
        mcpName: info.name,
        spec: {
          name,
          description: info.description ?? info.title ?? info.name,
          inputSchema: info.inputSchema ?? { type: 'object', properties: {} },
          risk: riskOf(info, cfg.risk, cfg.readOnly),
          ...(auth ? { audience: auth.audience } : {}),
          meta: { mcp: { name: info.name, ...(info.annotations ? { annotations: info.annotations } : {}) } },
        },
      });
    }
    cache = { at: Date.now(), tools };
    return tools;
  }

  const failure = (content: string): ToolOutcome => ({ content, isError: true });

  return {
    name: deps.name ?? 'mcp',
    async listTools(ctx) {
      return [...(await load(ctx.credentials)).values()].map((e) => e.spec);
    },
    async callTool(name, args, ctx): Promise<ToolOutcome> {
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
      try {
        const res = await session.run((c) => c.callTool(entry.mcpName, args, ctx.signal, headers), ctx.credentials);
        // A server may echo request headers back; the token must not reach the model.
        const content = token ? res.content.split(token).join('[redacted]') : res.content;
        return { content, ...(res.isError ? { isError: true } : {}), ...(res.structured !== undefined ? { data: res.structured } : {}) };
      } catch (err) {
        if (err instanceof McpRpcError) return failure(err.message);
        throw err;
      }
    },
    native: () => session,
    close: () => session.close(),
  };
}
